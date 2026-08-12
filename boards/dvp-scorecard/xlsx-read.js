/* Minimal .xlsx READER — no dependencies (zlib is built in).

   The writer next door emits STORED entries; a real Excel file from Tableau or
   anyone else is DEFLATED, so this has to inflate. It reads the ZIP central
   directory (robust — local headers can carry data descriptors that make naive
   scanning wrong), inflates the parts it needs, and parses the sheet.

   Only three columns matter to this tool: the reference number, the metric
   score (20–100%), and the delivery date. Everything else is ignored, and the
   columns are found by header text with a value-pattern fallback, because the
   exact export layout varies per centre.                                     */

"use strict";

const zlib = require("zlib");

/* ── unzip via the central directory ── */
function readEntries(buf){
  // End Of Central Directory: scan backwards for signature 0x06054b50.
  let eocd = -1;
  for(let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--){
    if(buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error("not a zip/xlsx (no end-of-central-directory)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);          // central directory offset
  const out = {};

  for(let n = 0; n < count; n++){
    if(buf.readUInt32LE(p) !== 0x02014b50) break;
    const method  = buf.readUInt16LE(p + 10);
    const compSz  = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLn = buf.readUInt16LE(p + 30);
    const cmtLen  = buf.readUInt16LE(p + 32);
    const lho     = buf.readUInt32LE(p + 42);   // local header offset
    const name    = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // The local header repeats name/extra lengths; data starts after them.
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLn = buf.readUInt16LE(lho + 28);
    const dataAt   = lho + 30 + lNameLen + lExtraLn;
    const raw      = buf.subarray(dataAt, dataAt + compSz);

    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLn + cmtLen;
  }
  return out;
}

/* ── tiny XML helpers ── */
const unescape = s => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function sharedStrings(xml){
  if(!xml) return [];
  return [...xml.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(si =>
    [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => unescape(t[1])).join(""));
}

const colNum = ref => ref.replace(/\d+/g, "").split("")
  .reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);

/* Excel serial date → ISO yyyy-mm-dd (1900 epoch, with the classic leap bug). */
function serialToDate(n){
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if(isNaN(d)) return String(n);
  return d.toISOString().slice(0, 10);
}

function parseSheet(xml, strings){
  const rows = [];
  for(const r of xml.toString("utf8").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)){
    const cells = {};
    let maxc = 0;
    // Match self-closing empty cells (<c r=".."/>) AND content cells
    // (<c r="..">…</c>) — conflating the two makes an empty cell swallow the
    // next one and misattribute its value, which quietly corrupts columns.
    for(const c of r[1].matchAll(/<c\s+r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const col = colNum(c[1]);
      const attrs = c[2], inner = c[3] || "";
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let v = "";
      if(t === "inlineStr"){
        v = unescape((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [,""])[1]);
      }else{
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        const raw = vm ? vm[1] : "";
        if(t === "s") v = strings[+raw] ?? "";
        else v = unescape(raw);
      }
      cells[col] = v;
      if(col > maxc) maxc = col;
    }
    const arr = [];
    for(let i = 1; i <= maxc; i++) arr.push(cells[i] ?? "");
    rows.push(arr);
  }
  return rows;
}

/* ── column detection ── */
const RN_RE    = /^RN\d{6,}$/i;
const SCORE_RE = /^(?:100|80|60|40|20|0)%$/;         // the 20–100% buckets

function detectColumns(header, sample){
  const h = header.map(x => String(x).toLowerCase().trim());
  const find = re => h.findIndex(x => re.test(x));

  let rn    = find(/reference\s*number|^ref(erence)?$|^rn$/);
  let score = find(/metric.*comparison|comparison.*chart|metric\b|score|clean/);
  let date  = find(/deliver\w*\s*date|delivery\s*date|^delivered/);

  // Value-pattern fallback: scan the sample rows column by column.
  const colVals = i => sample.map(r => String(r[i] ?? "").trim()).filter(Boolean);
  const frac = (vals, re) => vals.length ? vals.filter(v => re.test(v)).length / vals.length : 0;

  if(rn < 0)    for(let i = 0; i < header.length; i++) if(frac(colVals(i), RN_RE) > 0.5){ rn = i; break; }
  if(score < 0) for(let i = 0; i < header.length; i++) if(frac(colVals(i), SCORE_RE) > 0.5){ score = i; break; }

  return { rn, score, date };
}

/* Score text/number → integer percent (100,80,60,40,20) or null. */
function parseScore(v){
  if(v == null || v === "") return null;
  const s = String(v).trim();
  let n;
  if(/%$/.test(s)) n = parseFloat(s);
  else { const f = parseFloat(s); n = f <= 1 ? f * 100 : f; }   // 0.8 → 80
  if(!isFinite(n)) return null;
  return Math.round(n / 20) * 20;                                // snap to bucket
}

/* Public: read an xlsx buffer → { rows:[{rn,score,date}], meta }. */
function readScorecard(buf){
  const files = readEntries(buf);
  const strings = sharedStrings(files["xl/sharedStrings.xml"]);
  const sheetName = Object.keys(files).find(f => /^xl\/worksheets\/sheet1\.xml$/.test(f))
                 || Object.keys(files).find(f => /^xl\/worksheets\/.*\.xml$/.test(f));
  if(!sheetName) throw new Error("no worksheet found in the file");
  const grid = parseSheet(files[sheetName], strings);
  if(!grid.length) throw new Error("the sheet is empty");

  const header = grid[0];
  const body = grid.slice(1);
  const cols = detectColumns(header, body.slice(0, 60));

  if(cols.rn < 0)    throw new Error("could not find a Reference Number column");
  if(cols.score < 0) throw new Error("could not find a score column (values like 100%, 80%…)");

  const rows = [];
  let dropped = 0;
  for(const r of body){
    const rn = String(r[cols.rn] ?? "").trim().toUpperCase();
    if(!RN_RE.test(rn)){ dropped++; continue; }
    const score = parseScore(r[cols.score]);
    let date = cols.date >= 0 ? String(r[cols.date] ?? "").trim() : "";
    if(date && /^\d+(\.\d+)?$/.test(date)) date = serialToDate(+date);   // serial → ISO
    rows.push({ rn, score, date });
  }

  return {
    rows,
    meta: {
      sheet: sheetName,
      headers: header,
      mapped: { rn: header[cols.rn], score: header[cols.score],
                date: cols.date >= 0 ? header[cols.date] : null },
      total: body.length, kept: rows.length, dropped,
      withScore: rows.filter(r => r.score != null).length
    }
  };
}

module.exports = { readScorecard };

/* Minimal .xlsx writer — no dependencies.

   An xlsx is a ZIP of XML parts. Only what Excel actually needs is emitted:
   content types, two relationship files, a workbook, one styles part, and a
   sheet. Entries are STORED rather than deflated — these sheets are a few
   hundred rows, so the size saving is not worth a compression bug.

   Why not just CSV: numbers arrive as numbers rather than text, so a column
   sums without anyone retyping it, and the header can be frozen and filtered. */

"use strict";

const CRC = (() => {
  const t = new Int32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf){
  let c = -1;
  for(let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* MS-DOS date/time, which is what the ZIP local header wants. */
function dosStamp(d){
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  };
}

function zip(files, when){
  const stamp = dosStamp(when || new Date(2026, 0, 1, 12, 0, 0));
  const chunks = [];
  const central = [];
  let offset = 0;

  for(const f of files){
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data, "utf8");
    const sum  = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);            // version made by
    cen.writeUInt16LE(20, 6);            // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(stamp.time, 12);
    cen.writeUInt16LE(stamp.date, 14);
    cen.writeUInt32LE(sum, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + data.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, dir, end]);
}

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  // Excel rejects most control characters outright.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

const colName = i => {
  let s = "";
  for(let n = i + 1; n > 0; ){
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/* columns: [{ key, header, width, type: "text"|"number", digits }]  */
function build({ sheetName = "Sheet1", columns, rows, title }){
  const cells = (vals, rowIdx, styleHeader) => vals.map((v, c) => {
    const ref = `${colName(c)}${rowIdx}`;
    if(v.num != null && Number.isFinite(v.num)){
      return `<c r="${ref}" s="${v.style || 0}"><v>${v.num}</v></c>`;
    }
    if(v.text === "" || v.text == null) return `<c r="${ref}" s="${v.style || 0}"/>`;
    return `<c r="${ref}" s="${v.style || 0}" t="inlineStr"><is><t xml:space="preserve">${esc(v.text)}</t></is></c>`;
  }).join("");

  const out = [];
  let r = 1;

  out.push(`<row r="${r}">${cells(columns.map(col => ({ text: col.header, style: 1 })), r, true)}</row>`);
  r++;

  for(const row of rows){
    const vals = columns.map(col => {
      const raw = row[col.key];
      if(col.type === "number"){
        const n = Number(raw);
        return Number.isFinite(n)
          ? { num: col.digits === 0 ? Math.round(n) : Number(n.toFixed(col.digits ?? 2)),
              style: col.digits === 0 ? 3 : 2 }
          : { text: "" };
      }
      return { text: raw == null ? "" : String(raw) };
    });
    out.push(`<row r="${r}">${cells(vals, r)}</row>`);
    r++;
  }

  const lastCol = colName(columns.length - 1);
  const dim = `A1:${lastCol}${Math.max(1, rows.length + 1)}`;

  const sheet =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dim}"/>
<sheetViews><sheetView workbookViewId="0" tabSelected="1">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((c, i) =>
  `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join("")}</cols>
<sheetData>${out.join("")}</sheetData>
<autoFilter ref="${dim}"/>
</worksheet>`;

  // s=0 default, s=1 bold header, s=2 two-decimal number, s=3 integer
  const styles =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const files = [
    { name: "[Content_Types].xml", data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: "_rels/.rels", data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: "xl/workbook.xml", data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet }
  ];

  return zip(files);
}

module.exports = { build };

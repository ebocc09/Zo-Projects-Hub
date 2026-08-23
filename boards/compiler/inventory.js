/* Tesla OS says who is waiting for a car. This says what there is to give
   them: inventory.tesla.com, the INTERNAL inventory search, and the second
   half of the Pending Inventory button.

   ── the one source on this board with nothing to sign in to ──

   os.js holds a token that dies every eighty minutes. sca.js holds a JWT that
   dies every nine hours. Both need a browser, a debug port and a capture loop
   to stay alive. This file needs none of it:

     GET https://inventory.tesla.com/inventorysearchinternal/api/v4/
         inventory-results?query=<json>

   answers plain Node with no cookie, no bearer and no browser at all. Verified
   from a cold shell — no credential of any kind was attached. So there is
   deliberately no Admin › Sources row for it, no connect flow and no liveness
   probe: a row that can only ever read "connected" is a row that teaches the
   reader nothing.

   It is still the *internal* view and not the public one. Against the same
   query, www.tesla.com's public API returns 8 matches and 106 fields; this one
   returns 54 and 121, the extra ones being Trt, VrlName, City, MetroName,
   SalesMetro, FleetSalesRegions, VehicleReadiness and MonroneyPrice. The
   public host also 404s this path outright — the two are different apps, not
   two doors onto one.

   The route map came from `window.tesla.routes` in the page, the same way SCA's
   came out of its bundle. Guessing 404'd a dozen times on the Intrepid attempt;
   reading the app's own config has hit first try every time since.

   ── read-only ──

   One GET, and it is a search. The app has order and referral routes; they are
   deliberately not mapped here.                                              */

"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const HOST   = "inventory.tesla.com";
const API    = "/inventorysearchinternal/api/v4";
const PAGE   = "/inventory/new/my";      // any model — we only want the config
const CACHE  = path.join(__dirname, ".inv-filters.json");

/* ── the page size is 24 and asking for more is a silent lie ──

   Ask for 50, 100 or 200 and the answer is HTTP 200 carrying exactly 24 rows,
   with `total_matches_found` still reporting the real total. No error, no
   truncation notice, nothing in the body to say the count was ignored. This is
   the same failure shape as the OS bucket API's recordsPerPage — see os.js's
   PAGE_SIZE — and it is more dangerous here, because 24 rows of 811 look
   exactly like a complete small result.

   So it is pinned, and assertPage() below counts the rows back rather than
   trusting that the request was honoured. */
const PAGE_SIZE = 24;

/* ── the orderings, and why they are a list here rather than a free string ──

   `arrangeby` is NOT validated by the API. Sending "Nonsense" returns HTTP 200
   in the Relevance order with no complaint — the same silent-fallback family
   as the page size above: a plausible answer to a question nobody asked.

   All four below were checked against the live search: Year runs 2021→2026,
   Odometer 2,373→91,664 miles, Price ascending, and Relevance happens to match
   Price on the sets sampled. Nothing else is offered, and the route refuses
   anything not on this list rather than letting the API reinterpret it. */
const SORTS = ["Relevance", "Price", "Year", "Odometer"];

/* How far a single scan will page. 40 × 24 = 960 cars, which covers any real
   centre and most regions with room to spare. Whatever it drops is reported —
   never silently truncated into something that reads as the whole answer. */
const MAX_PAGES = 40;

/* ── keep-alive off, copied from os.js and for its reason ──

   Node has kept sockets alive by default since v19 and Tesla's edge closes an
   idle connection first, so the second call in a burst can fail with
   `socket hang up` before a byte is sent. os.js hit exactly that against the
   OS BFF. This host has not been caught doing it, but the cost of ruling it
   out is one handshake per call and the cost of being wrong is a scan that
   fails only on the second run — the hardest kind to reproduce. */
const agent = new https.Agent({ keepAlive: false });

const DIAL_FAIL = /socket hang up|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|could not reach/i;

function request(pathAndQuery, { json = true } = {}){
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, port: 443, path: pathAndQuery, method: "GET", agent,
      headers: {
        "Accept"     : json ? "application/json" : "text/html",
        /* The edge serves a bot page to an unrecognised agent. This is the
           one header that matters; nothing here is authenticated. */
        "User-Agent" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if(res.statusCode >= 400){
          return reject(new Error(
            `Tesla inventory ${res.statusCode} on ${pathAndQuery.slice(0, 80)}`));
        }
        if(!json) return resolve(raw);
        let d = null;
        try { d = raw ? JSON.parse(raw) : null; } catch { /* reported below */ }
        if(d === null){
          /* An HTML body on a JSON route means the edge served the search page
             or a block page instead of answering — a 200 that is not a reply. */
          return reject(new Error(
            "Tesla inventory answered with a page instead of JSON — the API path may have moved."));
        }
        if(d && typeof d === "object" && d.error){
          return reject(new Error(`Tesla inventory refused the search: ${d.error}`));
        }
        resolve(d);
      });
    });
    req.on("error", err =>
      reject(new Error(err.message || "could not reach Tesla inventory")));
    req.end();
  });
}

/* One retry, and only on a dial that never carried a reply. Same bargain as
   os.js: every call here is a search, so re-sending one cannot double
   anything up, and an HTTP status is an answer rather than a failure. */
async function tryTwice(p, opts){
  try{ return await request(p, opts); }
  catch(err){
    if(!DIAL_FAIL.test(err.message || "")) throw err;
    return request(p, opts);
  }
}

/* ─────────────────────────── the filter vocabulary ──────────────────────

   The site publishes its own filter schema — every filter, with its choice
   list — as a JSON string on `window.tesla.filters` in the page HTML. That is
   536 locations and 74 trims, and both move.

   So it is read from the site rather than copied into this file. The
   ticket-concern filter already made this call for the same reason: a copy of
   a list somebody else maintains is a copy that goes quietly wrong. Cached to
   disk so a scan does not pay for a 220 KB page, refreshed daily, and a failed
   refresh falls back to the cached copy rather than to nothing.             */

const CACHE_MS = 24 * 60 * 60 * 1000;

/* window.tesla is a JS object literal, not a <script type="application/json">
   block, so it is brace-matched out rather than parsed. Quote- and
   escape-aware, because the blob contains both in quantity. */
function extractConfig(html){
  const at = html.indexOf("window.tesla = ");
  if(at < 0) throw new Error("inventory.tesla.com no longer ships window.tesla");

  let i = html.indexOf("{", at), depth = 0, inStr = false, esc = false;
  for(let p = i; p < html.length; p++){
    const c = html[p];
    if(esc){ esc = false; continue; }
    if(c === "\\"){ esc = true; continue; }
    if(c === '"'){ inStr = !inStr; continue; }
    if(inStr) continue;
    if(c === "{") depth++;
    else if(c === "}" && --depth === 0) return JSON.parse(html.slice(i, p + 1));
  }
  throw new Error("could not find the end of window.tesla");
}

function readCache(){
  try{
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    return c && c.filters ? c : null;
  }catch{ return null; }
}

async function filterSchema({ force = false } = {}){
  const cached = readCache();
  if(!force && cached && Date.now() - (cached.at || 0) < CACHE_MS) return cached;

  try{
    const html = await tryTwice(PAGE, { json: false });
    const cfg  = extractConfig(html);
    const raw  = typeof cfg.filters === "string" ? JSON.parse(cfg.filters) : cfg.filters;
    const out  = {
      at      : Date.now(),
      models  : cfg.available_models     || [],
      conds   : cfg.available_conditions || [],
      market  : cfg.market   || "US",
      language: cfg.language || "en",
      filters : (raw && raw.results) || {}
    };
    try { fs.writeFileSync(CACHE, JSON.stringify(out)); } catch { /* cache is optional */ }
    return out;
  }catch(err){
    /* A stale vocabulary still narrows correctly — every option in it was real
       when it was written, and the API validates its own values. Serving it
       beats failing the scan. Serving nothing at all does not. */
    if(cached) return { ...cached, stale: true, staleReason: err.message };
    throw err;
  }
}

/* ─────────────────────────────── searching ───────────────────────────── */

/* The envelope the app itself sends. `options` is where every filter goes,
   keyed by the schema's own codes (Vrl, Model, TRIM, PAINT, …). */
function envelope({ model, condition, options, sort, order, market, language, offset }){
  return {
    query: {
      model, condition,
      options      : options || {},
      arrangeby    : sort  || "Relevance",
      order        : order || "asc",
      market       : market   || "US",
      language     : language || "en",
      super_region : "north america",
      range        : 0
    },
    offset,
    count           : PAGE_SIZE,
    outsideOffset   : 0,
    outsideSearch   : false
  };
}

/* A full page that is not PAGE_SIZE long means the count was not honoured, and
   the loop below would stop early believing it had reached the end. Caught
   here rather than discovered as a short list. */
function assertPage(rows, total, offset){
  if(rows.length > PAGE_SIZE){
    throw new Error(
      `Tesla inventory returned ${rows.length} rows for a page of ${PAGE_SIZE} — ` +
      `the page size is not being honoured, so the count cannot be trusted.`);
  }
  if(rows.length < PAGE_SIZE && offset + rows.length < total){
    /* Short page before the end. Not fatal — the API does this at the tail of
       some filtered sets — but the caller is told rather than left to assume
       it saw everything. */
    return `Tesla inventory returned ${rows.length} of ${PAGE_SIZE} at offset ${offset} ` +
           `while reporting ${total} matches.`;
  }
  return null;
}

/* ── the pages are fetched together, and the result is deduplicated ──

   Read one page at a time, 868 used Model Ys took 76 seconds over 36 calls —
   and came back with 865 distinct VINs out of 868 rows. Nothing was wrong with
   the paging: the inventory genuinely moves while you read it, so over a
   76-second window a car sold out of page 3 shifts everything after it back by
   one and something on a page boundary is served twice. The same slide loses
   cars as well as repeating them, which is the half that does not announce
   itself.

   Both problems have the same answer — read the pages at once instead of in
   sequence. The first page also reports `total_matches_found`, so after one
   call the remaining offsets are known and can go out together. That takes the
   window the inventory can move inside from 76 seconds to about 4, and the
   VIN dedupe below cleans up whatever still slips.

   VIN is the key even for new cars: the masked `7SAY…`+hash form is still one
   value per car, and it was distinct across every sample taken. */
const FETCH_CONCURRENCY = 8;

function pageQuery(base, offset){
  const q = envelope({ ...base, offset });
  return `${API}/inventory-results?query=${encodeURIComponent(JSON.stringify(q))}`;
}

async function search({ model = "my", condition = "new", options = {},
                        sort = "Relevance", order = "asc",
                        market = "US", language = "en", onProgress } = {}){
  const base  = { model, condition, options, sort, order, market, language };
  const notes = [];

  const first = await tryTwice(pageQuery(base, 0));
  const head  = Array.isArray(first.results) ? first.results : [];
  const total = Number(first.total_matches_found || 0) || head.length;

  const warn0 = assertPage(head, total, 0);
  if(warn0) notes.push(warn0);

  const rows = [...head];
  if(onProgress) onProgress({ phase: "inventory", done: rows.length, total });

  /* Everything still to come, as offsets, capped by the page ceiling. */
  const offsets = [];
  for(let o = PAGE_SIZE; o < total && offsets.length < MAX_PAGES - 1; o += PAGE_SIZE) offsets.push(o);
  const truncated = PAGE_SIZE + offsets.length * PAGE_SIZE < total;

  for(let i = 0; i < offsets.length; i += FETCH_CONCURRENCY){
    const batch = offsets.slice(i, i + FETCH_CONCURRENCY);
    const pages = await Promise.all(batch.map(async o => {
      const d   = await tryTwice(pageQuery(base, o));
      const got = Array.isArray(d.results) ? d.results : [];
      const w   = assertPage(got, total, o);
      if(w && !notes.includes(w)) notes.push(w);
      return got;
    }));
    for(const p of pages) rows.push(...p);
    if(onProgress) onProgress({ phase: "inventory", done: rows.length, total });
  }

  /* Dedupe last, so `dropped` counts what the slide actually cost rather than
     hiding it. Reported only when it happens. */
  const seen = new Set();
  const uniq = [];
  for(const r of rows){
    const k = r && r.VIN;
    if(!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  const dropped = rows.length - uniq.length;
  const short   = !truncated && total > uniq.length ? total - uniq.length : 0;

  /* A duplicate and a missing car are the SAME event seen from two sides: one
     car sells mid-read, everything after it shifts back a place, and a car on
     a page boundary is served twice while another is stepped over. So the two
     are reported as one sentence — saying only "2 duplicates dropped" while
     the list quietly sits 2 short of the stated total invites the reader to
     wonder whether the count is broken. */
  if(dropped || short){
    notes.push(
      `Showing ${uniq.length} of ${total} — inventory changed while this was being read` +
      (dropped ? `, so ${dropped} repeated ${dropped === 1 ? "car was" : "cars were"} dropped` : "") +
      (short   ? ` and ${short} ${short === 1 ? "car" : "cars"} shifted out of the pages read` : "") +
      `. Run it again for a clean count.`);
  }

  /* No silent caps: if the ceiling stopped the scan, the list says so rather
     than presenting 960 of 4,000 as the answer. */
  if(truncated){
    notes.push(
      `Stopped at ${uniq.length} of ${total} — this scan pages up to ${MAX_PAGES * PAGE_SIZE} ` +
      `cars. Narrow the filters to see the rest.`);
  }

  return { total, rows: uniq, notes, truncated };
}

module.exports = {
  HOST, API, PAGE_SIZE, MAX_PAGES, CACHE, SORTS,
  filterSchema, search, extractConfig
};

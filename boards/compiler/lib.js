/* The Compiler — shared core.

   A board of tools over the two systems that between them describe a vehicle:
   Garage's index says what a car IS, Intrepid says what is WRONG with it.
   Everything that talks to either lives here, so no tool on the board can
   drift into its own idea of what a service visit is.

   Both connections are required rather than optional. There is no degraded
   mode: a scan missing half its sources would answer the question wrongly
   instead of refusing, which is the worse failure. */

"use strict";

const fs     = require("fs");
const path   = require("path");
const https  = require("https");
const crypto = require("crypto");

const credstore = require("./credstore");

const HERE = __dirname;

const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

const resolvePath = p => (path.isAbsolute(p) ? p : path.join(HERE, p));
const readJson    = f => JSON.parse(fs.readFileSync(f, "utf8"));

/* ──────────────────────────── connections ────────────────────────────
   What a fresh machine has to be told, in one gitignored file the admin panel
   writes. config.json holds only non-secret machine settings, so it stays
   committable; .connections.json holds the credential and never is.        */

const CONN_FILE = path.join(HERE, ".connections.json");

/* Two settings, because two things genuinely need storing:

     intrepidCookie  the cogs-authorization session, grabbed or pasted.
     garageCookie    the Garage session, same story. Both are cookies now:
                     Garage's index is reachable over its own web session, so
                     there is no OAuth client, no token store and nothing this
                     board shares with any other.
     trtId           the centre the board is pointed at. Chosen once and kept
                     until changed; Admin › Maintenance › Reset clears it.
     offsiteTrtId    the overflow lot, if there is one. Same picker, same file.
                     Null on a board that only has the one site.            */
const CONN_DEFAULTS = { intrepidCookie: "", garageCookie: "", trtId: null,
                        offsiteTrtId: null };

/* Stored as a number or null, never a string, so callers can compare without
   worrying which layer they got it from. */
const asTrt = v => /^\d+$/.test(String(v || "")) ? Number(v) : null;

function savedTrtId(){ return asTrt(loadConnections().trtId); }
function savedOffsiteTrtId(){ return asTrt(loadConnections().offsiteTrtId); }


function loadConnections(){
  let saved = {};
  if(fs.existsSync(CONN_FILE)){
    try { saved = readJson(CONN_FILE); } catch { saved = {}; }
  }

  return { ...CONN_DEFAULTS, ...saved };
}

function saveConnections(patch){
  const prev = loadConnections();
  const next = { ...prev, ...patch };
  // Drop anything a previous version wrote that is no longer a setting.
  delete next.garage;
  fs.writeFileSync(CONN_FILE, JSON.stringify(next, null, 2));

  return next;
}

/* The admin password is shared across these dashboards and is a gate against
   fat fingers, not an attacker. Kept out of git all the same; a machine with
   no file falls back to the house default so a fresh clone still opens. */
function adminPassword(){
  const f = path.join(HERE, ".admin.json");
  if(fs.existsSync(f)){
    try { return String(readJson(f).password || "").trim() || CONFIG.defaultAdminPassword; }
    catch { /* fall through */ }
  }
  return CONFIG.defaultAdminPassword;
}

/* ─────────────────────────────── plumbing ─────────────────────────────── */

function request(url, { method = "GET", headers = {}, body = null } = {}){
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      // The port comes from the URL. It was pinned to 443, which is right for
      // every Tesla host here and wrong the moment a URL carries its own port
      // — the request went to 443 and failed with a refused connection that
      // looked like the host being down.
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    /* Node's connection errors are sometimes an AggregateError whose message
       is the empty string, which surfaces in the UI as a blank failure. The
       code is always there, so it stands in. */
    req.on("error", err => {
      if(!err.message) err.message = err.code ? `${err.code} — ${u.hostname}:${u.port || 443}`
                                              : "connection failed";
      reject(err);
    });
    if(body) req.write(body);
    req.end();
  });
}

/* Counting semaphore. A wide date range must not open hundreds of sockets. */
function pool(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  return Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while(i < items.length){
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch(err){ out[idx] = { error: err.message, _item: items[idx] }; }
    }
  })).then(() => out);
}

/* ──────────────────────────────── Intrepid ────────────────────────────────
   One HttpOnly cookie, `cogs-authorization`, is the whole credential. It is
   invisible to document.cookie on the SPA page because it is scoped to the
   API host; see README. Every bad-credential case answers with an identical
   401 "No token provided", so a health check keys on the status alone.     */

const INTREPID = CONFIG.intrepidApi.replace(/\/+$/, "");
/* Intrepid splits its API into sibling services under /api — the delivery
   endpoints live under /api/cogs, the site directory under /api/location. */
const INTREPID_LOCATION = INTREPID.replace(/\/cogs$/, "") + "/location";

function intrepidCookie(){
  // Hub first, own file second — see credstore.js for why that way round.
  const raw = credstore.intrepidCookie(
    (loadConnections().intrepidCookie || "").trim()).value.trim();
  if(!raw){
    const err = new Error("Not connected to Intrepid — sign in on the Zo Projects Hub");
    err.needsCookie = true;
    throw err;
  }
  // Tolerate a whole document.cookie paste: only cogs-authorization matters,
  // and pulling it out beats making someone edit the string by hand.
  const m = raw.match(/cogs-authorization=[^;]+/);
  return m ? m[0] : raw;
}

async function intrepidGet(pathAndQuery, base = INTREPID){
  const res = await request(base + pathAndQuery, {
    headers: { Cookie: intrepidCookie(), Accept: "application/json" }
  });
  if(res.status === 401){
    const err = new Error("Intrepid cookie expired or rejected — paste a fresh one");
    err.needsCookie = true;
    throw err;
  }
  if(res.status !== 200){
    throw new Error(`Intrepid HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  try { return JSON.parse(res.body); }
  catch { throw new Error("Intrepid did not return JSON — the cookie may be a sign-in redirect"); }
}

/* Same again for the handful of Intrepid endpoints that take a body. Kept
   next to intrepidGet rather than folded into it: the two differ only in the
   method, but a single function taking an optional body reads worse at every
   call site than two that each say what they do. */
async function intrepidPost(pathAndQuery, payload, base = INTREPID){
  const body = JSON.stringify(payload == null ? {} : payload);
  const res = await request(base + pathAndQuery, {
    method : "POST",
    headers: { Cookie: intrepidCookie(), Accept: "application/json",
               "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) },
    body
  });
  if(res.status === 401){
    const err = new Error("Intrepid cookie expired or rejected — paste a fresh one");
    err.needsCookie = true;
    throw err;
  }
  if(res.status !== 200){
    throw new Error(`Intrepid HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  try { return JSON.parse(res.body); }
  catch { throw new Error("Intrepid did not return JSON — the cookie may be a sign-in redirect"); }
}

/* Every appointment at one TRT on one date. `date` is a plain query
   parameter: one cookie serves any number of dates with no re-auth. */
async function appointmentsOn(date, trtId){
  const trt = trtId;
  if(!trt){
    const err = new Error("No TRT set — choose Enter TRT in the top corner");
    err.needsTrt = true;
    throw err;
  }
  const rows = await intrepidGet(
    `/getTssAppointmentsByDate?trtId=${encodeURIComponent(trt)}&date=${encodeURIComponent(date)}&searchQuery=`);
  return Array.isArray(rows) ? rows : [];
}

/* ── TRT directory ──
   getLocations is the only endpoint that maps a TRT to a site, and it answers
   with every location Tesla has — about 1,850 records and 7.5 MB. Far too
   heavy to hit per lookup, so it is reduced to a trtId → name map and cached
   on disk. The raw payload is never kept.

   getTrtByTrtId exists in the bundle but 404s against this deployment, hence
   the whole-list approach rather than a targeted call.                     */

const TRT_CACHE = path.join(HERE, ".trt-cache.json");
const TRT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let trtMap = null;

/* "Tesla Service Houston-Cypress" is how the record reads; the prefix is
   noise once you are already inside a Tesla tool. */
const tidyName = s => String(s || "")
  .replace(/^Tesla\s+(Service|Center|Store|Delivery)\s+/i, "")
  .replace(/^Tesla\s+/i, "")
  .trim();

async function trtDirectory({ refresh = false } = {}){
  if(trtMap && !refresh) return trtMap;

  if(!refresh && fs.existsSync(TRT_CACHE)){
    try{
      const c = readJson(TRT_CACHE);
      if(c.fetchedAt && Date.now() - c.fetchedAt < TRT_TTL_MS && c.map){
        trtMap = c.map;
        return trtMap;
      }
    }catch{ /* fall through and refetch */ }
  }

  const rows = await intrepidGet("/getLocations", INTREPID_LOCATION);
  const map = {};
  for(const r of Array.isArray(rows) ? rows : []){
    if(r.trtid == null) continue;
    const addr = (r.additionalAttributes && r.additionalAttributes.trtAddress) || {};
    map[String(r.trtid)] = {
      name    : tidyName(r.description) || r.locationTerritoryName || String(r.trtid),
      full    : r.description || "",
      city    : addr.city || "",
      province: addr.province || "",
      tz      : r.ianaTimeZone || ""
    };
  }
  trtMap = map;
  try{ fs.writeFileSync(TRT_CACHE, JSON.stringify({ fetchedAt: Date.now(), map })); }catch{}
  return trtMap;
}

/* Type-ahead over the site directory. Nobody remembers TRT numbers, but
   everybody knows "Houston", so name is the primary key here and the number
   is what the lookup returns rather than what it demands.

   Ranked so the obvious answer is first: a name that starts with the query
   beats one that merely contains it, which beats a city match. */
async function searchSites(q, limit = 20){
  const query = String(q || "").trim().toLowerCase();
  if(!query) return [];

  const map = await trtDirectory();
  const out = [];

  for(const [id, s] of Object.entries(map)){
    const name = (s.name || "").toLowerCase();
    const city = (s.city || "").toLowerCase();
    const full = (s.full || "").toLowerCase();

    let rank;
    if(id === query)                 rank = 0;   // exact TRT number
    else if(name.startsWith(query))  rank = 1;
    else if(city.startsWith(query))  rank = 2;
    else if(name.includes(query))    rank = 3;
    else if(city.includes(query))    rank = 4;
    else if(full.includes(query))    rank = 5;
    else if(id.startsWith(query))    rank = 6;   // partial TRT number
    else continue;

    out.push({ rank, trtId: Number(id), name: s.name, city: s.city,
               province: s.province, full: s.full });
  }

  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return out.slice(0, limit).map(({ rank, ...rest }) => rest);
}

/* Never throws: an unresolvable TRT is a cosmetic miss, not a failure. The
   caller still has the number to fall back on. */
async function trtInfo(trtId){
  if(!trtId) return null;
  try{
    const map = await trtDirectory();
    const hit = map[String(trtId)];
    return hit ? { trtId: Number(trtId), ...hit } : null;
  }catch{
    return null;
  }
}

/* ───────────────────────────────── Garage ─────────────────────────────────

   One session cookie, no OAuth, no MCP.

   Garage's own web app reads the index through `/api/1/tesladex/search`, and
   that endpoint answers a plain authenticated GET with exactly the data the
   MCP `tesladex_search` tool returns — verified against the same query: same
   total, same rows, same fields. The MCP route needed a registered OAuth
   client, a token store, a refresh dance and a session handshake to reach the
   same index, so it is gone.

   What that buys, beyond less code: this board now depends on nothing but its
   own folder and two cookies. It shared an OAuth client registration with
   another dashboard for exactly one afternoon, and that is the coupling the
   rewrite exists to remove — refreshing rotates the refresh token, so
   whichever board refreshed first stranded the other.

   The cookie name carries an environment prefix (`31_s_garage_session` on
   production), so nothing here assumes a fixed name: whatever the sign-in
   window produced is sent back verbatim.                                   */

const GARAGE = CONFIG.garageUrl.replace(/\/+$/, "");

function garageCookie(){
  const raw = credstore.garageCookie("prod",
    (loadConnections().garageCookie || "").trim()).value.trim();
  if(!raw){
    const err = new Error("Not signed in to Garage — sign in on the Zo Projects Hub");
    err.needsAuth = true;
    throw err;
  }
  // Tolerate a whole document.cookie paste: only the session cookie matters.
  const m = raw.match(/[A-Za-z0-9_]*_?s_garage_session=[^;]+/);
  return m ? m[0] : raw;
}

async function garageGet(pathAndQuery){
  const res = await request(GARAGE + pathAndQuery, {
    headers: {
      Cookie: garageCookie(),
      Accept: "application/json",
      // Garage answers a bare fetch with the SPA shell; without a browsery
      // agent some paths return HTML and the JSON parse fails misleadingly.
      "User-Agent": "Mozilla/5.0 (the-compiler)"
    }
  });

  /* A dead session does not 401 — it answers 302 to SSO, or 200 with the
     sign-in HTML. Both have to be read as "sign in again" rather than as a
     parse failure, or the panel sends people to fix the wrong thing. */
  if(res.status === 401 || res.status === 403 ||
     (res.status >= 300 && res.status < 400)){
    const err = new Error("Garage session expired or rejected — sign in again");
    err.needsAuth = true;
    throw err;
  }
  if(res.status !== 200){
    throw new Error(`Garage HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  try { return JSON.parse(res.body); }
  catch {
    const err = new Error("Garage returned a sign-in page rather than data — sign in again");
    err.needsAuth = true;
    throw err;
  }
}

/* The index, one page at a time.

   Returned in the MCP tool's shape — `{results, total, has_more}` — rather
   than Garage's `{response, total, from}`, so the callers above read the same
   either way and swapping transports again would touch only this function. */
/* The cheapest query that proves the index is readable. Deliberately NOT
    — the REST endpoint rejects a bare wildcard as a full-text search
   where the MCP tool used to allow it, so a health check written that way
   fails against a perfectly good session. */
const PROBE = "delivered:true";

async function tesladexSearch({ query, fields = ["vin"], size = 100, from = 0,
                                sort = "vin:asc", type = "vehicle" } = {}){
  const qs = [
    "type=" + encodeURIComponent(type),
    "query=" + encodeURIComponent(query),
    "size=" + Number(size),
    "from=" + Number(from),
    "sort=" + encodeURIComponent(sort),
    // Rails wants repeated `fields[]` params, not one comma-joined value.
    ...fields.map(f => "fields[]=" + encodeURIComponent(f))
  ].join("&");

  const d = await garageGet("/api/1/tesladex/search?" + qs);
  const rows = Array.isArray(d && d.response) ? d.response : [];
  const total = typeof (d && d.total) === "number" ? d.total : rows.length;

  return { results: rows, total, has_more: from + rows.length < total };
}

/* Kept so the tool code reads unchanged. There is only ever one tool now, and
   anything else is a mistake worth failing loudly on rather than quietly
   returning nothing for. */
async function callTool(name, args){
  if(name !== "tesladex_search"){
    throw new Error(`Unsupported Garage call: ${name}`);
  }
  return tesladexSearch(args);
}

/* Nothing to establish — a cookie is either present or it is not. Kept as a
   no-op so callers do not have to know which transport they are on. */
async function ensureSession(){
  garageCookie();
  return true;
}

function signOutGarage(){
  saveConnections({ garageCookie: "" });
  return { removed: 1 };
}

/* ─────────────────────────── tesladex enumeration ───────────────────────────
   Which cars this centre handed over on a given day. Until August 2026 this
   was impossible — tesladex 403'd on delivered vehicles and Intrepid was the
   only enumerator. That restriction is gone, and with it the cookie.

   Two fields do the whole job:

   `delivery_date_epoch` — but note delivery_date is UTC. A 7pm Houston pickup
   is 00:xx UTC the NEXT day, so a `delivery_date:2026-08-01*` prefix quietly
   drops the back half of an evening. The query is an epoch range spanning the
   LOCAL day, built from this machine's clock; the dashboard runs at the
   centre, and todayLocal() already assumes exactly that.

   `vehicle_routing_location` — the VRL, and the reason this is now one query
   instead of a national scan. It survives delivery, where the whole
   delivery_details block does not, and it is indexed, so the centre filter
   runs server-side.

   This replaced reading trt_id back out of each car's telemetry history.
   Measured against that method across all 2,960 cars delivered nationally on
   2026-08-01: they agree on 2,693, and for TRT 17589 specifically the two
   sets are identical — nothing added, nothing missed. Of the 68 that differ,
   VRL is the better value: the telemetry side is holding logistics codes the
   car had not shed by handoff (15047, 415904) where VRL names an actual
   centre. VRL was also populated on every single one of the 2,960, while
   telemetry had no trt_id at all for 37 of them.

   The old method survives only as the fallback below, for a car with no VRL. */

/* Local midnight to local midnight, as UTC seconds. */
function dayRangeEpoch(dateStr){
  const [y, m, d] = dateStr.split("-").map(Number);
  return [
    Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000),
    Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000)
  ];
}

const TESLADEX_PAGE = 100;      // the endpoint's maximum

/* Pages a query to exhaustion. Sorted, or deep paging repeats and skips. */
async function tesladexPage(query, fields, onPage){
  const out = [];
  for(let offset = 0; ; offset += TESLADEX_PAGE){
    const page = await callTool("tesladex_search", {
      query, fields, size: TESLADEX_PAGE, from: offset,
      sort: "delivery_date_epoch:asc"
    });
    const rows = (page && page.results) || [];
    out.push(...rows);
    if(onPage) onPage({ got: out.length, total: page ? page.total : out.length });
    if(!rows.length || !page || !page.has_more) break;
    // Elasticsearch will not page past 10k however politely you ask.
    if(offset + TESLADEX_PAGE >= 10000) break;
  }
  return out;
}

/* ──────────────────────────────── dates ──────────────────────────────── */

function todayLocal(){
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function expandDates(spec){
  if(!spec || spec === "today") return [todayLocal()];
  if(!spec.includes("..")) return [spec];
  const [from, to] = spec.split("..");
  const out = [];
  for(let t = Date.parse(from + "T00:00:00Z"), end = Date.parse(to + "T00:00:00Z");
      t <= end && out.length < 400; t += 86400000){
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);

/* Seventeen characters, and never I, O or Q — the standard leaves them out so
   they cannot be misread as 1 and 0. Checked before anything is dispatched so
   a mistyped VIN comes back as a typo rather than as "no vehicle found",
   which reads like the car is missing rather than the query wrong. */
const isVin = v => /^[A-HJ-NPR-Z0-9]{17}$/.test(String(v || "").toUpperCase());


/* ──────────────────────────── the fleet, sliced ────────────────────────────

   Every value below was read off the index rather than invented: a sample of
   600 cars at one centre, tallied per field. Anything not in these lists does
   not appear in the data, and a filter offering values the index has never
   heard of is worse than no filter — it returns nothing and looks broken.

   `label` is what the panel shows; `q` is what Lucene is given. Values with
   spaces or hyphens are quoted at query time, not here.                    */

const FACETS = {
  delivery: {
    label: "Delivery state",
    field: null,                       // special-cased: maps to `delivered`
    options: [
      { v: "undelivered", label: "Undelivered" },
      { v: "delivered",   label: "Delivered" }
    ]
  },
  vehicle_type: {
    label: "Vehicle tag",
    field: "vehicle_type",
    options: [
      { v: "customer-vehicle",    label: "Customer" },
      { v: "inventory-vehicle",   label: "Inventory" },
      { v: "service-loaner",      label: "Service loaner" },
      { v: "internal-vehicle",    label: "Internal" },
      { v: "marketing-vehicle",   label: "Marketing" },
      { v: "engineering-vehicle", label: "Engineering" },
      { v: "mobileservice",       label: "Mobile service" },
      { v: "energy",              label: "Energy" }
    ]
  },
  ownership: {
    label: "Ownership",
    field: "ownership",
    options: [
      { v: "Customer",     label: "Customer" },
      { v: "Tesla Motors", label: "Tesla Motors" }
    ]
  },
  vehicle_category: {
    label: "Category",
    field: "vehicle_category",
    options: [
      { v: "StandardServiceLoaner", label: "Standard service loaner" },
      { v: "CoreOperations",        label: "Core operations" },
      { v: "MobileEV",              label: "Mobile EV" },
      { v: "MobileTire",            label: "Mobile tire" },
      { v: "MobileTireLite",        label: "Mobile tire lite" },
      { v: "Event",                 label: "Event" }
    ]
  },
  fleet_status: {
    label: "Fleet status",
    field: "fleet_status",
    options: [
      { v: "Active",           label: "Active" },
      { v: "Inactive",         label: "Inactive" },
      { v: "PendingCycleIn",   label: "Pending cycle in" },
      { v: "PendingCycleOut",  label: "Pending cycle out" }
    ]
  },
  delivery_stage: {
    label: "Delivery stage",
    field: "delivery_stage",
    options: [
      { v: "General Assembly",     label: "General assembly" },
      { v: "Arrived at VRL",       label: "Arrived at VRL" },
      { v: "Arrived not at VRL",   label: "Arrived not at VRL" },
      { v: "Rectification",        label: "Rectification" },
      { v: "At service center",    label: "At service center" },
      { v: "In-garage delivered",  label: "In-garage delivered" },
      { v: "Post Delivery Owned",  label: "Post delivery owned" },
      { v: "Frozen",               label: "Frozen" }
    ]
  },
  /* New / Used is the one facet Garage cannot answer. The index has no title
     field at all; the answer lives in Intrepid's Falcon record as
     `TitleStatus`, one call per VIN, which means it cannot go into the Lucene
     query and has to be applied after the population is already in hand.

     `fetched: true` marks that difference for the panel and for scanVehicles:
     selecting a value here costs an extra call per vehicle and narrows the
     result after the scan rather than before it. Leave it empty and no title
     is looked up at all.

     Values come back in mixed case — NEW, USED and Used all appear in the
     same centre — so both sides compare lowercased, exactly as Intrepid's own
     page does before it matches against this enum. */
  title: {
    label: "Title status",
    field: null,
    fetched: true,
    note: "Not in the Garage index — one extra Intrepid call per vehicle",
    options: [
      { v: "new",      label: "New" },
      { v: "used",     label: "Used" },
      { v: "salvaged", label: "Salvaged" },
      { v: "tbd",      label: "TBD" }
    ]
  },
  model: {
    label: "Model",
    field: "model",
    options: [
      { v: "3",          label: "Model 3" },
      { v: "y",          label: "Model Y" },
      { v: "s",          label: "Model S" },
      { v: "x",          label: "Model X" },
      { v: "cybertruck", label: "Cybertruck" }
    ]
  }
};

/* Which blockers to look for. Each costs a call per vehicle (containment is
   batched five at a time), so leaving one off is a real saving on a big
   selection rather than a cosmetic filter. */
const HOLD_KINDS = [
  { v: "sv",          label: "Service visits",  hint: "An open SCA service visit" },
  { v: "containment", label: "Containment",     hint: "Active containment campaign" },
  { v: "logistics",   label: "Logistics holds", hint: "Held in logistics, with a reason" }
];

/* Lucene wants quotes around anything with a space or a hyphen; a bare
   `vehicle_type:customer-vehicle` parses the hyphen as an operator and
   quietly matches the wrong set. */
const term = (field, value) => `${field}:"${String(value).replace(/"/g, '\\"')}"`;

const orGroup = (field, values) =>
  values.length === 1 ? term(field, values[0])
                      : "(" + values.map(v => term(field, v)).join(" OR ") + ")";

/* The selection, as one Lucene string. An empty facet means "no opinion" and
   contributes nothing, so the query only ever narrows. */
/* ── onsite, offsite, and why they use different fields ──
   The centre is `vehicle_routing_location`. The offsite lot is `trt_id`. That
   asymmetry is not an oversight; it is what the data is.

   Measured at Cypress, 2026-08-11, over its 576 undelivered cars:

     161  trt_id 487417   the offsite lot
     160  trt_id 17589    the centre itself
     111  no trt_id at all
     144  logistics codes (15047, 8162, 16402, …) the car has not shed

   So `trt_id` cannot enumerate a centre — it misses the 111 with none and the
   144 still carrying a transit code. VRL can, and does, which is what the
   board has always used. But `trt_id` is exactly right for saying WHICH LOT a
   car sits on, and it is the only field that knows: Intrepid has never heard
   of 487417 — not in getLocations, not in getCogInventoryCars, and asked
   directly it places those cars at 17589.

   Hence: enumerate by VRL, split by trt_id. Both are indexed, so all three
   scopes are one query and cost the same as the single-site scan did.

   The three are disjoint by construction — onsite explicitly excludes the
   offsite lot — so Onsite + Offsite = Onsite & Offsite, and no car is counted
   twice. Offsite is not confined to the VRL: 15 of those 176 cars sit outside
   it entirely, and they are still on the lot. */
function buildQuery({ trtId, offsiteTrtId, sites = "onsite", filters = {} }){
  const parts = [];
  const main = Number(trtId) > 0 ? Number(trtId) : null;
  const off  = Number(offsiteTrtId) > 0 ? Number(offsiteTrtId) : null;

  const VRL = id => `vehicle_routing_location:${id}`;
  const LOT = id => `trt_id:${id}`;

  if(main && off && sites === "offsite"){
    parts.push(LOT(off));
  }else if(main && off && sites === "both"){
    parts.push(`(${VRL(main)} OR ${LOT(off)})`);
  }else if(main && off){
    // onsite — the centre, minus whatever is standing at the offsite lot.
    parts.push(`${VRL(main)} AND NOT ${LOT(off)}`);
  }else if(main){
    /* No offsite configured: byte-identical to what every scan built before
       any of this existed. */
    parts.push(VRL(main));
  }

  const dl = filters.delivery || [];
  // Both, or neither, is the same statement — say nothing rather than
  // `(delivered:true OR delivered:false)`, which is noise in the audit line.
  if(dl.length === 1) parts.push(`delivered:${dl[0] === "delivered"}`);

  for(const [key, facet] of Object.entries(FACETS)){
    // `delivery` is special-cased above; a fetched facet has no index field
    // to filter on and is applied to the rows afterwards instead.
    if(key === "delivery" || facet.fetched || !facet.field) continue;
    const vals = filters[key] || [];
    if(vals.length) parts.push(orGroup(facet.field, vals));
  }
  return parts.join(" AND ") || "*:*";
}

/* New / Used / Salvaged / TBD for one car, from Intrepid's Falcon record.

   Returned lowercased because the source is not consistent: NEW, USED and
   Used all come back from the same centre on the same day. Intrepid's own
   page lowercases before matching too — anything comparing these raw will
   drop a third of the used cars and look like a data problem. */
async function titleStatusFor(vin){
  const d = await intrepidGet(`/falconVehicleSearch?vin=${encodeURIComponent(vin)}`)
    .catch(() => null);
  const r = d && Array.isArray(d.results) ? d.results[0] : null;
  if(!r || !r.TitleStatus) return null;
  return {
    title : String(r.TitleStatus).toLowerCase(),
    refurb: r.RefurbishmentStatus || "",
    // 0001-01-01 is Falcon's way of saying "never", not a date in the year 1.
    inUse : r.MarketingInUseDate && !/^0001-/.test(r.MarketingInUseDate)
      ? r.MarketingInUseDate : null
  };
}

/* ─────────────────────────── service visits scan ───────────────────────────

   Two systems, in order. Garage's index says which cars exist and what they
   are; Intrepid says what is wrong with them. Neither can answer alone — the
   index has no notion of a service visit, and Intrepid's own list is a
   per-date appointment view that omits cars booked and then stuck.

   Cost is the reason for the cap and for the per-kind toggles: a service
   visit and a logistics hold are one call each per vehicle, so a thousand
   cars is two thousand round trips. Containment batches five to a call. */

const SCAN_CAP = 1200;

async function scanVehicles({ trtId, offsiteTrtId, sites = "onsite",
                              filters = {}, kinds, onProgress } = {}){
  const want = new Set((kinds && kinds.length ? kinds : HOLD_KINDS.map(k => k.v)));
  const notes = [];

  await ensureSession();

  const query = buildQuery({ trtId, offsiteTrtId, sites, filters });
  const fields = ["vin", "model", "vehicle_type", "ownership", "vehicle_category",
                  "fleet_status", "delivery_stage", "delivered", "delivery_date_epoch"];

  /* ── who is in scope ── */
  const cars = [];
  let total = null;
  for(let from = 0; from < SCAN_CAP; from += TESLADEX_PAGE){
    const page = await callTool("tesladex_search", {
      query, fields, size: TESLADEX_PAGE, from, sort: "vin:asc"
    });
    if(page && page.error) throw new Error("Tesladex: " + page.error);
    if(total == null && page && typeof page.total === "number") total = page.total;
    const rows = (page && page.results) || [];
    cars.push(...rows.filter(r => r.vin));
    if(onProgress) onProgress({ phase: "enumerate", got: cars.length, total });
    if(!rows.length || !page || !page.has_more) break;
  }

  if(total != null && total > cars.length){
    notes.push(`The filter matches ${total.toLocaleString()} vehicles; this scan covers the ` +
               `first ${cars.length.toLocaleString()}. Narrow the selection to see the rest — ` +
               `nothing beyond that point was checked.`);
  }

  if(!cars.length) return { query, total: 0, scanned: 0, rows: [], notes, kinds: [...want] };

  /* ── title status, when it was asked for ──
     Before the holds, and on its own pass, because it can shrink the
     population: filtering to Used first means the expensive per-vehicle hold
     lookups only run on cars that survived. Ordering it the other way round
     would pay for holds on every car and then throw most of them away. */
  const wantTitle = (filters.title || []).map(v => String(v).toLowerCase());
  let titles = null;
  if(wantTitle.length){
    titles = new Map();
    let tdone = 0;
    await pool(cars, CONFIG.concurrency, async c => {
      titles.set(c.vin, await titleStatusFor(c.vin));
      tdone++;
      if(onProgress) onProgress({ phase: "title", done: tdone, total: cars.length });
    });

    const before = cars.length;
    // A car Falcon has no record of is dropped rather than guessed at: it is
    // not evidence of "New", it is an absence of evidence.
    const keep = cars.filter(c => {
      const t = titles.get(c.vin);
      return t && wantTitle.includes(t.title);
    });
    const unknown = cars.filter(c => !titles.get(c.vin)).length;
    cars.length = 0;
    cars.push(...keep);

    notes.push(`Title status narrowed ${before.toLocaleString()} vehicles to ${
      keep.length.toLocaleString()}.` + (unknown
        ? ` ${unknown} had no Falcon record and were left out rather than assumed.` : ""));

    if(!cars.length){
      return { query, total: total ?? 0, scanned: 0, rows: [], notes, kinds: [...want] };
    }
  }


  /* ── containment, five VINs to a call ── */
  const containment = {};
  if(want.has("containment")){
    const batches = [];
    for(let i = 0; i < cars.length; i += 5) batches.push(cars.slice(i, i + 5).map(c => c.vin));
    let done = 0;
    await pool(batches, CONFIG.concurrency, async b => {
      const got = await intrepidGet(
        `/bulkGetCampaignContainmentHolds?vins=${b.join(",")}`).catch(() => null);
      if(got && typeof got === "object") Object.assign(containment, got);
      done++;
      if(onProgress) onProgress({ phase: "containment", done, total: batches.length });
    });
  }

  /* ── service visit and logistics, per vehicle ── */
  let done = 0;
  const rows = await pool(cars, CONFIG.concurrency, async c => {
    const [sv, lg] = await Promise.all([
      want.has("sv")
        ? intrepidGet(`/getScaServiceVisitByVin?vin=${encodeURIComponent(c.vin)}`).catch(() => null)
        : null,
      want.has("logistics")
        ? intrepidGet(`/getLogisticsHoldByVin?vin=${encodeURIComponent(c.vin)}`).catch(() => null)
        : null
    ]);
    done++;
    if(onProgress) onProgress({ phase: "holds", done, total: cars.length });

    const visits = Array.isArray(sv) ? sv : [];
    const logi   = Array.isArray(lg) ? lg : [];
    const camps  = containment[c.vin] || [];

    return {
      vin        : c.vin,
      model      : c.model || "",
      type       : c.vehicle_type || "",
      ownership  : c.ownership || "",
      category   : c.vehicle_category || "",
      fleetStatus: c.fleet_status || "",
      stage      : c.delivery_stage || "",
      delivered  : c.delivered === true,
      deliveredAt: c.delivery_date_epoch ? new Date(c.delivery_date_epoch * 1000).toISOString() : null,
      // Only the fields the board renders. The raw records carry customer
      // contact details that have no business leaving the server.
      visits: visits.map(v => ({
        id    : v.serviceVisitNumber || String(v.serviceVisitID || ""),
        svId  : v.serviceVisitID || null,
        opened: v.createDate || null,
        due   : v.estimatedCompletionDateTime || null,
        trt   : v.trtid || null,
        source: v.serviceVisitSourceID || ""
      })),
      campaigns: camps.map(c2 => ({
        title   : c2.title || "",
        type    : c2.campaignType || "",
        status  : c2.campaignStatus || "",
        action  : c2.actionType || "",
        severity: c2.severity || ""
      })),
      logistics: logi.map(h => ({ reasonId: h.holdReasonId ?? null, note: h.holdNote || "" })),

      // Null unless the title facet was used — see FACETS.title. Absent means
      // "not looked up", which is different from "not known".
      title      : titles ? ((titles.get(c.vin) || {}).title || null) : null,
      refurb     : titles ? ((titles.get(c.vin) || {}).refurb || "") : "",
      inUseSince : titles ? ((titles.get(c.vin) || {}).inUse || null) : null
    };
  });

  return { query, total: total ?? cars.length, scanned: cars.length,
           rows, notes, kinds: [...want] };
}

/* holdReasonId → words. One call, cached for the process: the map is a dozen
   rows that change about never, and every logistics hold on the board needs
   it to render as anything but a number. */
let holdReasons = null;
async function logisticsHoldReasons(){
  if(holdReasons) return holdReasons;
  const rows = await intrepidGet("/getLogisticsHoldReasons").catch(() => null);
  holdReasons = {};
  if(Array.isArray(rows)) for(const r of rows) holdReasons[r.holdReasonId] = r.description;
  return holdReasons;
}

/* ─────────────────────────── Cars on ground ───────────────────────────

   The board's second tool, and the only one that answers from Intrepid
   alone. Its question — what is standing at this centre, and where is each
   car in the receiving ladder — has no Garage equivalent: the COG status is
   Intrepid's own workflow state, written by the people walking the lot.

   Three calls for a whole centre, none of them per vehicle:

     getCogInventoryCars     every car on ground at the TRT. No date in the
                             query, so it cannot miss a car the way the
                             appointment list does — see the note on
                             enumeration in the README.
     getAllVehicleShipments  POST {vins}, the COG record per VIN in bulk.
                             `vehicleCogStatusId` lives here and nowhere in
                             the inventory row.
     getVehicleStatusOptions id → name for that status.

   Because nothing is per-vehicle this tool has no scan cap and no
   concurrency knob; a 700-car centre is about three seconds.              */

/* Intrepid's own page asks for 1,000. Asking for more is free and the reply
   is the same size when there is less, so the cap is raised and the caller
   is told when it is reached rather than quietly handed a short list. */
const COG_PAGE = 5000;

/* getAllVehicleShipments takes the VIN list in the body, so the only reason
   to split is to keep one request from being enormous. 700 in one call is
   fine in practice; this is a guard, not a tuning knob. */
const COG_VIN_CHUNK = 500;

/* id → name, from Intrepid rather than from a copy kept here.

   Deliberately no hardcoded fallback. The ids are stable, but a status
   renamed upstream and still rendered under its old name here would be a
   quiet lie on a screen someone makes decisions from — better to fail and
   say the source is unreachable. */
/* ── house names ──
   Intrepid writes "Receiving Inspection Pending"; nobody at a centre says
   that. They are VRIs — Vehicle Receiving Inspection — so that is what the
   board calls them.

   The rename is display-only and lives in one place. Intrepid's own string is
   kept beside it as `apiName`, because the moment the two are conflated
   someone greps the board for what Intrepid actually returned and finds the
   nickname instead. Nothing keys on either string: the status is matched by
   id everywhere it matters. */
const COG_LABELS = {
  "Receiving Inspection Pending": "VRI Pending"
};

let cogStatusCache = null;
async function cogStatuses({ refresh = false } = {}){
  if(cogStatusCache && !refresh) return cogStatusCache;
  const rows = await intrepidGet("/getVehicleStatusOptions");
  if(!Array.isArray(rows)) throw new Error("Intrepid returned no vehicle statuses");
  cogStatusCache = rows
    .filter(r => r && r.id != null)
    .map(r => ({
      id     : Number(r.id),
      apiName: String(r.name || ("status " + r.id)),
      name   : COG_LABELS[String(r.name)] || String(r.name || ("status " + r.id)),
      // displayOrder is the ladder's order, and it is not the id order:
      // "Too Dirty to Inspect" is id 11 but comes first.
      order  : Number(r.displayOrder || 999),
      enabled: r.enabled !== 0
    }))
    .sort((a, b) => a.order - b.order || a.id - b.id);
  return cogStatusCache;
}

/* Intrepid writes these without an offset — "2024-11-11T19:25:53" — and its
   own page reads them as local time. Matching that beats being cleverer than
   the source: the answers are in days, and an hours-wide timezone argument
   changes nothing anyone reads off this screen. */
function dwellSeconds(stamp){
  if(!stamp) return null;
  const t = new Date(String(stamp).replace(/Z$/, ""));
  if(isNaN(t)) return null;
  const s = Math.round((Date.now() - t.getTime()) / 1000);
  return s < 0 ? 0 : s;   // a clock skew should read as "just arrived", not negative
}

/* Hours below two days, days above. These cars dwell for months, so a label
   reading "4,081h" is technically true and useless. */
function dwellLabel(sec){
  if(sec == null) return "";
  const h = Math.floor(sec / 3600);
  if(h < 1)  return Math.max(1, Math.round(sec / 60)) + "m";
  if(h < 48) return h + "h";
  const d = Math.floor(h / 24);
  const r = h % 24;
  return d < 14 && r ? `${d}d ${r}h` : `${d}d`;
}

/* Everything standing at one centre, joined to its COG status.

   `statusIds` narrows what comes back; an empty list means every status,
   which is how the tool renders its own breakdown. The tally is always over
   the whole centre regardless, because "5 pending" only means something
   next to what the other 697 cars are doing.                              */
async function carsOnGround({ trtId, statusIds = [], onProgress = () => {} } = {}){
  if(!trtId){
    const err = new Error("No TRT set — choose a centre in the top corner");
    err.needsTrt = true;
    throw err;
  }

  onProgress({ phase: "statuses" });
  const statuses = await cogStatuses();
  const nameOf = Object.fromEntries(statuses.map(s => [s.id, s.name]));

  /* The rung a car with no COG record lands on — see the join below.
     Found by name rather than by a hardcoded 1: the id is stable today, but
     a hardcoded one that silently stopped meaning this would put those cars
     on the wrong rung and nobody would see it happen. */
  const pending = statuses.find(s => /receiving inspection pending/i.test(s.apiName));

  onProgress({ phase: "inventory" });
  const inv = await intrepidGet(
    `/getCogInventoryCars?trtId=${encodeURIComponent(trtId)}` +
    `&matchStatus=&vehicleTypes=&pageSize=${COG_PAGE}`);
  const rawRows = Array.isArray(inv) ? inv : [];

  /* The inventory list repeats a VIN when a car has more than one shipment
     leg behind it. One car is one row here — a duplicate would be counted
     twice in the tally and read as two cars on the lot. */
  const cars = new Map();
  for(const r of rawRows){
    if(r && r.vin && !cars.has(r.vin)) cars.set(r.vin, r);
  }
  const vins = [...cars.keys()];
  const notes = [];

  if(rawRows.length >= COG_PAGE){
    notes.push(`Intrepid returned its maximum of ${COG_PAGE.toLocaleString()} inventory rows — ` +
               `there may be cars on ground this scan did not see.`);
  }
  if(!vins.length){
    return { trtId: Number(trtId), statuses, total: 0, matched: 0, tally: [],
             noRecord: 0, rows: [], notes: ["No cars on ground at this centre."] };
  }

  onProgress({ phase: "cog", total: vins.length, done: 0 });
  const cog = new Map();
  for(let i = 0; i < vins.length; i += COG_VIN_CHUNK){
    const chunk = vins.slice(i, i + COG_VIN_CHUNK);
    const got = await intrepidPost(
      `/getAllVehicleShipments?trtId=${encodeURIComponent(trtId)}`, { vins: chunk });
    for(const rec of Array.isArray(got) ? got : []){
      if(!rec || !rec.vin) continue;
      /* A VIN with two COG records is a car that came, went and came back.
         The live one is the most recently touched. */
      const prev = cog.get(rec.vin);
      if(!prev || new Date(rec.updatedDate || 0) >= new Date(prev.updatedDate || 0)){
        cog.set(rec.vin, rec);
      }
    }
    onProgress({ phase: "cog", total: vins.length, done: Math.min(i + COG_VIN_CHUNK, vins.length) });
  }

  const want = new Set((statusIds || []).map(Number).filter(n => !isNaN(n)));
  const counts = new Map();
  let noRecord = 0;
  const rows = [];

  for(const vin of vins){
    const car = cars.get(vin);
    const rec = cog.get(vin);

    /* A car Intrepid has no COG record for counts as Receiving Inspection
       Pending, because that is what Intrepid's own page shows for it —
       getCogVehicleData defaults the status before it looks at anything.

       This board briefly reported those separately on the reasoning that a
       centre with no COG records at all would have its whole lot called
       "awaiting inspection". True, but beside the point: the screen the work
       is run off says pending, so a board saying 0 where that screen says 6
       is simply wrong, whatever the reasoning behind the 0. The distinction
       is kept per row and in a note instead of in the count. */
    const inferred = !rec || rec.vehicleCogStatusId == null;
    if(inferred && !pending) { noRecord++; continue; }   // no such rung: nothing honest to say
    if(inferred) noRecord++;

    const id = inferred ? pending.id : Number(rec.vehicleCogStatusId);
    counts.set(id, (counts.get(id) || 0) + 1);
    if(want.size && !want.has(id)) continue;

    const sec = dwellSeconds(car.arrivalTimeStamp);
    const cogRec = rec || {};
    rows.push({
      vin,
      model    : car.model || "",
      type     : car.vehicleType || "",
      color    : car.color || "",
      statusId : id,
      status   : nameOf[id] || ("status " + id),
      // True when the status was inferred from the absence of a record
      // rather than read off one. Shown on the row; never changes the count.
      inferred,
      bay      : cogRec.bayLocation || "",
      arrived  : car.arrivalTimeStamp || null,
      dwellSec : sec,
      dwell    : dwellLabel(sec),
      soc      : car.stateOfCharge == null ? null : Number(car.stateOfCharge),
      logistics: car.logisticsStatus || "",
      hold     : car.hold || "",
      rn       : car.referenceNumber || "",
      itinerary: car.itineraryNumber || "",
      scheduled: car.scheduledDeliveryDate || null,
      vriPassed: cogRec.vriPassedDate || null,
      touchedAt: cogRec.updatedDate || null,
      touchedBy: cogRec.updatedBy || ""
    });
  }

  /* Longest-standing first: on a pending-inspection list that is the running
     order, not a preference. Cars with no arrival stamp sort last rather
     than to the top, where a null would otherwise put them. */
  rows.sort((a, b) => (b.dwellSec == null ? -1 : b.dwellSec) -
                      (a.dwellSec == null ? -1 : a.dwellSec));

  const tally = statuses
    .map(s => ({ id: s.id, name: s.name, count: counts.get(s.id) || 0 }))
    .filter(s => s.count > 0);

  if(noRecord && pending){
    notes.push(`${noRecord} of these have no COG record at all — Intrepid shows a car ` +
               `without one as ${pending.name}, and that is where they are counted. ` +
               `Each is marked on its row.`);
  }else if(noRecord){
    notes.push(`${noRecord} of ${vins.length} cars on ground have no COG record and ` +
               `Intrepid published no receiving-inspection status to put them on, ` +
               `so they are not counted anywhere above.`);
  }

  return {
    trtId  : Number(trtId),
    statuses,
    total  : vins.length,
    matched: rows.length,
    tally, noRecord, rows, notes
  };
}

/* ── counts the board puts in its strip ── */
function summarise(rows){
  const sv = rows.filter(r => r.visits.length);
  const ct = rows.filter(r => r.campaigns.length);
  const lg = rows.filter(r => r.logistics.length);
  const any = rows.filter(r => r.visits.length || r.campaigns.length || r.logistics.length);
  return {
    scanned    : rows.length,
    flagged    : any.length,
    serviceVisits: sv.length,
    containment: ct.length,
    logistics  : lg.length,
    both       : rows.filter(r => r.visits.length && r.campaigns.length).length,
    clear      : rows.length - any.length,
    rate       : rows.length ? Math.round(any.length / rows.length * 100) : 0
  };
}

/* ──────────────────────────── connection tests ────────────────────────────
   Each returns {ok, detail} rather than throwing, so the panel can show every
   row's state at once instead of dying on the first failure. */

async function testIntrepid(trtId){
  /* Everything inside the try, including reading the cookie. intrepidCookie()
     THROWS when nothing is saved rather than returning empty, so a guard
     testing it for falsiness never fired and the throw escaped the whole
     checks route — which then failed as one error instead of showing which
     of the three sources was missing. That is the one screen someone opens
     when nothing works, so it has to survive its own bad news. */
  const trt = trtId || savedTrtId();
  try{
    intrepidCookie();
    // Any authenticated read proves the cookie; the reasons map is the
    // cheapest one and needs no TRT, so it works before a centre is chosen.
    const rows = await intrepidGet("/getLogisticsHoldReasons");
    if(!Array.isArray(rows)) return { ok: false, detail: "Unexpected reply from Intrepid" };
    return { ok: true, detail: `${rows.length} hold reasons${trt ? " · TRT " + trt : ""}` };
  }catch(err){
    // The thrown message already distinguishes "not connected" from
    // "rejected", so it is passed through rather than second-guessed.
    return { ok: false, detail: err.message };
  }
}

/* Reaches for real data rather than checking that a cookie exists. A stale
   Garage session is indistinguishable from a live one until something is
   asked of it — it answers the sign-in page with a 200. */
async function testGarage(){
  try{
    const p = await tesladexSearch({ query: PROBE, fields: ["vin"], size: 1 });
    return { ok: true, detail: typeof p.total === "number"
      ? `session live, ${p.total.toLocaleString()} vehicles in the index`
      : "session live" };
  }catch(err){
    return { ok: false, detail: err.needsAuth ? "Not signed in — connect Garage" : err.message };
  }
}

async function testTesladex(){
  try{
    const p = await callTool("tesladex_search", { query: PROBE, fields: ["vin"], size: 1 });
    if(p && p.error) return { ok: false, detail: String(p.error) };
    return { ok: true, detail: typeof p.total === "number"
      ? `index reachable, ${p.total.toLocaleString()} vehicles` : "index reachable" };
  }catch(err){
    return { ok: false, detail: err.needsAuth ? "Not signed in" : err.message };
  }
}

/* ── maintenance ── */

function resetBoard(){
  const cleared = [];
  for(const f of [CONN_FILE, path.join(HERE, ".trt-cache.json")]){
    try { if(fs.existsSync(f)) { fs.unlinkSync(f); cleared.push(path.basename(f)); } } catch {}
  }
  trtMap = null;
  holdReasons = null;
  cogStatusCache = null;
  return { cleared };
}

/* Never returns a credential — only whether one is present and how it looks,
   which is all the panel needs to render state. */
function connectionsSummary(){
  const c  = loadConnections();
  const gc = credstore.garageCookie("prod", (c.garageCookie || "").trim());
  const ic = credstore.intrepidCookie((c.intrepidCookie || "").trim());
  const garage = gc.value.trim();
  const cookie = ic.value.trim();

  /* Both sources report the same shape now, because both are the same kind of
     thing: a session cookie that is either present or not. There is no token
     expiry to render — a cookie stops working when it stops working, and the
     honest way to know is the check button rather than arithmetic on a clock. */
  return {
    trtId: savedTrtId(),
    intrepid: {
      set    : Boolean(cookie),
      hint   : cookie ? "…" + cookie.slice(-8) : "",
      looksOk: /cogs-authorization=/.test(cookie),
      detail : cookie ? (ic.source === "hub" ? "from the Hub" : "saved locally") : "not connected",
      source : ic.source,
      required: true
    },
    garage: {
      set    : Boolean(garage),
      hint   : garage ? "…" + garage.slice(-8) : "",
      looksOk: /s_garage_session=/.test(garage),
      detail : garage ? (gc.source === "hub" ? "from the Hub" : "saved locally") : "not connected",
      source : gc.source,
      signedIn: Boolean(garage),
      required: true
    }
  };
}

module.exports = {
  CONFIG, loadConnections, saveConnections, adminPassword, savedTrtId, savedOffsiteTrtId,
  intrepidCookie, intrepidGet, intrepidPost, appointmentsOn,
  cogStatuses, carsOnGround, dwellLabel,
  trtInfo, trtDirectory, searchSites,
  ensureSession, callTool, tesladexSearch, tesladexPage, dayRangeEpoch,
  garageCookie, signOutGarage,
  FACETS, HOLD_KINDS, buildQuery, scanVehicles, logisticsHoldReasons, summarise,
  SCAN_CAP,
  testIntrepid, testGarage, testTesladex,
  resetBoard, connectionsSummary,
  todayLocal, isDate, isVin
};

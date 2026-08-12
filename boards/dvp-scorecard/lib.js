/* DVP Scorecard — shared core.

   Attributes a delivery survey score to the person who put the car into
   "Finished Goods" — the prep/detail step — rather than to the advisor or the
   delivery host. The survey asks the customer about cleanliness; the person who
   finished the car is the one accountable for it. Rank them.

   The score comes from an uploaded xlsx (RN + score). Everything else is
   Intrepid: RN → VIN → the status log → who set Finished Goods. No Garage, no
   Tableau — v1 is Intrepid-only, exactly as scoped.                          */

"use strict";

const fs   = require("fs");
const path = require("path");
const https = require("https");

const credstore = require("./credstore");

const HERE = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

/* ──────────────────────────── connections ──────────────────────────── */

const CONN_FILE = path.join(HERE, ".connections.json");
const CONN_DEFAULTS = { intrepidCookie: "", trtId: null };

function loadConnections(){
  let saved = {};
  if(fs.existsSync(CONN_FILE)){
    try { saved = JSON.parse(fs.readFileSync(CONN_FILE, "utf8")); } catch { saved = {}; }
  }
  return { ...CONN_DEFAULTS, ...saved };
}
function saveConnections(patch){
  const next = { ...loadConnections(), ...patch };
  fs.writeFileSync(CONN_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
function savedTrtId(){
  const v = loadConnections().trtId;
  return /^\d+$/.test(String(v || "")) ? Number(v) : null;
}

function adminPassword(){
  const f = path.join(HERE, ".admin.json");
  if(fs.existsSync(f)){
    try { return String(JSON.parse(fs.readFileSync(f, "utf8")).password || "").trim()
                 || CONFIG.defaultAdminPassword; } catch {}
  }
  return CONFIG.defaultAdminPassword;
}

/* ─────────────────────────────── plumbing ─────────────────────────────── */

function request(url, { method = "GET", headers = {}, body = null } = {}){
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method, headers }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on("error", reject);
    if(body) req.write(body);
    req.end();
  });
}

/* Counting semaphore so a big centre-day does not open hundreds of sockets. */
function pool(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  return Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while(i < items.length){
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch(err){ out[idx] = { error: err.message }; }
    }
  })).then(() => out);
}

/* ──────────────────────────────── Intrepid ──────────────────────────────── */

const INTREPID = CONFIG.intrepidApi.replace(/\/+$/, "");

function intrepidCookie(){
  // Hub first, own file second — see credstore.js.
  const raw = credstore.intrepidCookie((loadConnections().intrepidCookie || "").trim()).value.trim();
  if(!raw){
    const err = new Error("Not connected to Intrepid — sign in on the Zo Projects Hub");
    err.needsCookie = true;
    throw err;
  }
  const m = raw.match(/cogs-authorization=[^;]+/);
  return m ? m[0] : raw;
}

async function intrepidGet(pathAndQuery){
  const res = await request(INTREPID + pathAndQuery, {
    headers: { Cookie: intrepidCookie(), Accept: "application/json" }
  });
  if(res.status === 401){
    const err = new Error("Intrepid session expired — reconnect under Admin");
    err.needsCookie = true;
    throw err;
  }
  if(res.status !== 200) throw new Error(`Intrepid HTTP ${res.status}: ${res.body.slice(0, 140)}`);
  try { return JSON.parse(res.body); }
  catch { throw new Error("Intrepid did not return JSON — the cookie may be a sign-in redirect"); }
}

const asArray = d => Array.isArray(d) ? d : (d && d.Data) || [];

/* ── the store name ──
   The real scorecard labels every row with its home store, so the TRT number
   is resolved to a name. getLocations is the only endpoint that maps one, and
   it answers with every Tesla location — ~1,850 records, 7.5 MB — so it is
   reduced to a trtId → name map and cached for a week. Ported from the FSD
   Tracker, where the same trap applies: getTrtByTrtId exists but 404s here. */

const INTREPID_LOCATION = INTREPID.replace(/\/cogs$/, "") + "/location";
const TRT_CACHE = path.join(HERE, ".trt-cache.json");
const TRT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let trtMap = null;

const tidyName = s => String(s || "")
  .replace(/^Tesla\s+(Service|Center|Store|Delivery)\s+/i, "")
  .replace(/^Tesla\s+/i, "").trim();

/* Bumped whenever the cached record shape changes, so an old cache is refetched
   rather than silently serving entries missing the new fields for a week. */
const TRT_CACHE_V = 2;

async function trtDirectory(){
  if(trtMap) return trtMap;
  if(fs.existsSync(TRT_CACHE)){
    try{
      const c = JSON.parse(fs.readFileSync(TRT_CACHE, "utf8"));
      if(c.v === TRT_CACHE_V && c.fetchedAt && Date.now() - c.fetchedAt < TRT_TTL_MS && c.map){
        trtMap = c.map; return trtMap;
      }
    }catch{}
  }
  const res = await request(INTREPID_LOCATION + "/getLocations", {
    headers: { Cookie: intrepidCookie(), Accept: "application/json" }
  });
  if(res.status !== 200) throw new Error(`location HTTP ${res.status}`);
  const rows = asArray(JSON.parse(res.body));
  const map = {};
  for(const r of rows){
    if(r.trtid == null) continue;
    const addr = (r.additionalAttributes && r.additionalAttributes.trtAddress) || {};
    map[String(r.trtid)] = { name: tidyName(r.description) || String(r.trtid),
                             full: r.description || "",
                             city: addr.city || "", province: addr.province || "" };
  }
  trtMap = map;
  try { fs.writeFileSync(TRT_CACHE, JSON.stringify({ v: TRT_CACHE_V, fetchedAt: Date.now(), map })); } catch {}
  return trtMap;
}

/* Type-ahead over the location directory, ported from the FSD Tracker so the
   two dashboards pick a centre the same way. Nobody remembers TRT numbers.

   Ranked rather than filtered: an exact number beats a name prefix beats a
   city prefix beats a substring, so typing "hou" puts Houston sites above a
   site that merely mentions Houston in its full address. */
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
    if(id === query)                rank = 0;   // exact TRT number
    else if(name.startsWith(query)) rank = 1;
    else if(city.startsWith(query)) rank = 2;
    else if(name.includes(query))   rank = 3;
    else if(city.includes(query))   rank = 4;
    else if(full.includes(query))   rank = 5;
    else if(id.startsWith(query))   rank = 6;   // partial TRT number
    else continue;

    out.push({ rank, trtId: Number(id), name: s.name, city: s.city,
               province: s.province, full: s.full });
  }
  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return out.slice(0, limit).map(({ rank, ...rest }) => rest);
}

/* One centre by number. Never throws — an unresolved TRT is still a usable
   TRT, it just shows as a bare number. */
async function trtInfo(trtId){
  if(!trtId) return null;
  try{
    const hit = (await trtDirectory())[String(trtId)];
    return hit ? { trtId: Number(trtId), ...hit } : null;
  }catch{ return null; }
}

/* Never throws — an unresolved store is cosmetic, the TRT still identifies it. */
async function storeLabel(trtId){
  try{
    const m = await trtDirectory();
    const hit = m[String(trtId)];
    if(!hit) return `TRT ${trtId}`;
    // Mirrors the real scorecard's "NA-US-TX-Houston-Cypress" shape.
    const parts = ["NA-US", hit.province, hit.name].filter(Boolean);
    return parts.join("-");
  }catch{ return `TRT ${trtId}`; }
}

/* Every appointment at one TRT on one date, reduced to what the join needs. */
async function appointmentsOn(date, trtId){
  if(!trtId){ const e = new Error("No delivery centre set"); e.needsTrt = true; throw e; }
  const rows = asArray(await intrepidGet(
    `/getTssAppointmentsByDate?trtId=${encodeURIComponent(trtId)}&date=${encodeURIComponent(date)}&searchQuery=`));
  return rows.map(r => ({
    rn        : String(r.referenceNumber || "").toUpperCase(),
    vin       : r.vin || "",
    shipmentId: r.cogInfo && r.cogInfo.id,
    model     : r.model || "",
    status    : r.status || "",
    /* Intrepid's own "this car cleared receiving" stamp. Carried as a CHECK on
       the failed-VRI detection, never as the detection itself — see the note
       above statusSetters(). Free: it is already on the appointment. */
    vriPassedAt: (r.cogInfo && r.cogInfo.vriPassedDate) || null,
    // The centre-day this car was found under, carried through the compile so
    // the board can be narrowed to a range without re-querying Intrepid.
    date
  })).filter(r => r.rn && r.vin);
}

/* The per-vehicle status log — who set each COG stage, and when. One call
   yields every stage, so both the people we care about come from the same
   request:

     Finished Goods                  the prep person, who owns the cleanliness score
     In Wash                         whoever moved the car through the wash
     Receiving Inspection Completed  who signed off the VRI when the car landed

   They are usually different people (crieder finished a car waynharris both
   received and washed), so none can stand in for another. All three are
   `createdBy` on their own log entry — NOT cogInfo.updatedBy, which is only the
   last toucher of the record. Verified 2026-08-02.

   The VRI stage is the one the floor calls "VRI" / "receiving inspection
   pending"; the log only ever writes the COMPLETED entry, and that entry
   carries the person who cleared it, which is the thing worth counting.
   Confirmed against a live sample 2026-08-03 — the exact status names present
   are Receiving Inspection Completed, PDI Pending, PDI Completed, Ready for
   Prep, In Wash, In Charge, In Service, Finished Goods. */
/* Intrepid records the same person two different ways: `lcolman@tesla.com` on
   most entries and a bare `lcolman` on others — 6 of the 27 people at this
   centre appear in both forms, and taking createdBy at face value splits each
   of them into two rows that each hold half their work.

   So the identity is the lowercased local part, with the tesla.com domain
   dropped. Any OTHER domain is kept, because that is a genuinely different
   account rather than the same person written two ways. */
const who = entry => {
  const raw = entry && entry.createdBy ? String(entry.createdBy).trim().toLowerCase() : "";
  if(!raw) return null;
  return raw.endsWith("@tesla.com") ? raw.slice(0, -"@tesla.com".length) : raw;
};

/* ── a failed VRI ──
   Intrepid has no "inspection failed" status. What it has is a side effect: a
   car that does not pass its receiving inspection is put straight into service,
   and the two happen as ONE action, so the log gets two rows bearing the same
   `createdDate` to the second and the same `createdBy`:

     id=16247950  statusId=9  svcVisit=-         2026-08-10T18:58:05Z  Receiving Inspection Completed
     id=16247951  statusId=5  svcVisit=47682012  2026-08-10T18:58:05Z  In Service

   The same-second pairing is the whole signal, and it has to be — "In Service"
   on its own is a common and entirely unrelated event. Measured over 199 cars
   on ground at Cypress on 2026-08-10: 3 cars carried the pair, while 20 further
   "In Service" entries sat elsewhere in a log as ordinary later service visits.
   Testing for the status alone would therefore over-report failures ~7x.

   Three things that look like better signals and are not:

     - `vriPassedDate`, on the shipment record and on the appointment's
       `cogInfo`. The obvious candidate — an explicit "this car cleared
       receiving" stamp — and on cars standing at the centre it looks strong:
       across all 696 on ground at Cypress it was null for 10 of the 12
       failures and populated for all 684 passes.

       It is useless HERE, and the reason matters. The field is not written by
       the inspection. It is stamped about two minutes later, when the car
       reaches Ready for Prep — it equalled the VRI log timestamp on 1 of 684
       passes — so it means "this car got through receiving", not "this car's
       inspection passed". A failed car that is then repaired and moved on gets
       the stamp anyway, and the failure disappears from the field entirely:

         7SAYGDED6TF672218   failed 2026-07-20T14:38:43, svc=46988719
                             vriPassedDate 2026-08-05T14:07:45  ← after the fail

       This board looks at DELIVERED cars, every one of which cleared receiving
       by definition. Over a 21-day window at Cypress the log test found 8
       failures among 726 delivered cars; all 8 had a populated vriPassedDate,
       so that field would have found ZERO. It is also sticky in the other
       direction — never cleared when a later inspection fails, so a car that
       passes, is sent back, and fails re-inspection still reads as passed.

       Kept as `vriPassedAt` and cross-checked rather than discarded: a
       disagreement surfaces as a notice instead of being silently resolved in
       favour of either one.

     - `serviceVisitId` on the In Service row. A failure does open a service
       visit, but so does a normal one: 19 of those 20 unrelated entries carry
       one too. It is recorded below as corroboration, never as the test.

     - Requiring the ids to be adjacent. True in every sample seen, but it is an
       artefact of insert order rather than a documented guarantee, and a
       failure that happened to interleave with another write would be missed.

   Scored against each other: over the 696 cars on ground, this test 12/12 and
   vriPassedDate 10/12, no false positive from either. Over the 726 delivered
   cars this board actually reports on, this test 8/8 and vriPassedDate 0/8.

   Anchored to the SAME entry that `vriBy` is taken from, so a catch can never
   outnumber the inspections it is counted against. Note what that entry is:
   Intrepid returns the log NEWEST FIRST, so the `find` below lands on the car's
   MOST RECENT receiving inspection, not its first. That is the right one — the
   question is whether this car's latest inspection failed — but it does mean a
   car re-inspected after repair is judged on the re-inspection alone, and one
   catch is counted however many times it went round. */
const sameInstant = (a, b) => {
  if(!a || !b) return false;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  return !isNaN(x) && x === y;
};

const statusCache = new Map();      // vin+shipmentId → { finishedBy, washedBy, vriBy }

async function statusSetters(vin, shipmentId){
  const key = vin + "|" + shipmentId;
  if(statusCache.has(key)) return statusCache.get(key);

  let result = { finishedBy: null, washedBy: null, vriBy: null, finishedAt: null,
                 vriAt: null, vriFailed: false, vriFailedBy: null, serviceVisitId: null,
                 postVri: [] };
  try{
    const data = await intrepidGet(
      `/getVehicleStatusLogByVinWithPdiTask?vin=${encodeURIComponent(vin)}&vehicleShipmentId=${encodeURIComponent(shipmentId)}`);
    const logs = (data && data.vehicleStatusLogs) || [];
    const find = re => logs.find(e => re.test(e.vehicleCogStatusName || "")) || null;
    const fg = find(/finished goods/i), iw = find(/in wash/i);
    // Anchored on "completed" so a future "Receiving Inspection Pending" entry,
    // which records who queued the car rather than who inspected it, is not
    // silently counted as an inspection someone did.
    const vri = find(/receiving inspection completed/i);

    /* Anchored likewise: "In Service" and nothing else, so a future status that
       merely contains the words cannot be read as a car going into service. */
    const svc = vri ? logs.find(e => e !== vri
      && /^\s*in service\s*$/i.test(String(e.vehicleCogStatusName || ""))
      && sameInstant(e.createdDate, vri.createdDate)) : null;

    /* ── service visits opened AFTER a passing inspection ──
       The other half of the inspection picture: a fault the VRI did not catch,
       found later while the centre still had the car.

       Every In Service entry STRICTLY after the VRI. Strictly, because a
       failure's own In Service entry shares the VRI's timestamp — so it drops
       out here rather than needing to be special-cased, and a caught fault can
       never also be counted as a missed one.

       Collected raw and left for compile() to judge: whether one of these
       counts depends on the car's DELIVERY date, which lives on the appointment
       rather than in the status log. */
    const postVri = vri ? logs
      .filter(e => /^\s*in service\s*$/i.test(String(e.vehicleCogStatusName || ""))
                && new Date(e.createdDate).getTime() > new Date(vri.createdDate).getTime())
      .map(e => ({ at: e.createdDate || null, sv: e.serviceVisitId ?? null }))
      .sort((a, b) => new Date(a.at) - new Date(b.at)) : [];

    result = {
      finishedBy: who(fg), washedBy: who(iw), vriBy: who(vri),
      finishedAt: fg ? fg.createdDate || null : null,
      vriAt     : vri ? vri.createdDate || null : null,
      vriFailed : Boolean(svc),
      postVri,
      /* Credited to the inspector who signed the VRI, not to `svc.createdBy`.
         They are the same person in every sample seen, but the catch belongs to
         whoever did the inspecting even if another account writes the row. */
      vriFailedBy: svc ? who(vri) : null,
      // Corroboration only — the visit the failure opened, so a row on the
      // board can be checked against Intrepid rather than taken on trust.
      serviceVisitId: svc ? (svc.serviceVisitId ?? null) : null
    };
  }catch(err){
    if(err.needsCookie) throw err;      // auth failure must surface, not cache
  }
  statusCache.set(key, result);
  return result;
}

/* Email → a display handle. "crieder@tesla.com" → "crieder". Kept simple and
   Intrepid-only; a nicer full name would need Garage lookup_user (not in v1). */
const handle = email => String(email || "").split("@")[0] || "(unknown)";

/* ──────────────────────────── the compile ────────────────────────────
   xlsx rows ({rn,score,date}) + a TRT → a per-person cleanliness scorecard.  */

const isoDate = s => {
  const t = String(s || "").trim();
  if(!t) return null;
  if(/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);      // M/D/YYYY
  if(m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  return null;
};

/* ── a ticket opened after a passing inspection ──
   Ed's rule, 2026-08-10: the visit counts only if it was opened before the car
   was DELIVERED. After handover it is the customer's visit and says nothing
   about the inspection.

   Delivery is taken as the end of the appointment day. That is the only
   delivery timing a compiled row carries, and a finer one would be false
   precision — the appointment is a slot, not a moment of handover.

   Two deliberate exclusions:
     - Cars that FAILED the VRI. The fault was caught, not missed, and it is
       already counted as a catch. Measured over 726 delivered cars at Cypress
       no car fell in both groups anyway, so this costs nothing today and stops
       the two metrics contradicting each other if that ever changes.
     - Cars with no completed VRI. Nothing was inspected, so nothing was missed.

   The LAG is carried through with the verdict. Ed's cutoff admits a car that
   sat in inventory for months — the longest in that same window was 258 days
   between inspection and ticket — and a rate that silently mixes those with
   same-day finds would overstate what the inspector could have caught. The
   board shows the lag per car so the difference is visible. */
function postVriTicket(st, deliveryDate){
  const none = { ticketPostVri: false, ticketAt: null, ticketSv: null, ticketLagDays: null };
  if(!st || !st.vriBy || st.vriFailed || !st.vriAt) return none;
  const visits = Array.isArray(st.postVri) ? st.postVri : [];
  if(!visits.length) return none;

  const cutoff = deliveryDate ? new Date(deliveryDate + "T23:59:59").getTime() : Infinity;
  const hit = visits.find(v => v.at && new Date(v.at).getTime() <= cutoff);
  if(!hit) return none;

  const lag = (new Date(hit.at).getTime() - new Date(st.vriAt).getTime()) / 86400000;
  return { ticketPostVri: true, ticketAt: hit.at, ticketSv: hit.sv,
           ticketLagDays: Number(lag.toFixed(1)) };
}

async function compile({ rows, trtId, onProgress } = {}){
  const trt = String(trtId);
  const scored = rows.filter(r => r.score != null);

  // Which centre-days to pull. Union of every date named in the file — a
  // Tableau crosstab blanks repeated dates, but each distinct date appears at
  // least once, so the union still covers every RN.
  const dates = [...new Set(rows.map(r => isoDate(r.date)).filter(Boolean))].sort();

  const notices = [];
  if(!dates.length){
    notices.push("No usable delivery dates in the file, so appointments cannot be looked up. " +
                 "Make sure the export includes a Delivered Date column.");
    return { trtId: trt, rows: [], people: [], notices,
             stats: { uploaded: rows.length, scored: scored.length, matched: 0 } };
  }

  // 1. appointments → global RN → {vin, shipmentId}
  const rnMap = new Map();
  let dDone = 0;
  for(const date of dates){
    const appts = await appointmentsOn(date, trt);
    for(const a of appts) if(!rnMap.has(a.rn)) rnMap.set(a.rn, a);
    dDone++;
    if(onProgress) onProgress({ phase: "appointments", done: dDone, total: dates.length,
                                date, found: rnMap.size });
  }

  // 2. the survey score for each RN we have one for
  const scoreByRn = new Map(scored.map(r => [r.rn, r.score]));
  const unmatched = scored.filter(r => !rnMap.has(r.rn)).map(r => r.rn);

  /* 3. status log for EVERY car delivered on those dates, not only the
        surveyed ones. Cleanliness needs a survey, but the wash and VRI counts
        are records of work done and exist whether or not the customer
        replied — counting only surveyed cars would undercount them by roughly
        four fifths. One request yields every stage. */
  const cars = [...rnMap.values()];
  let sDone = 0;
  const carRows = await pool(cars, CONFIG.concurrency || 8, async c => {
    const st = c.shipmentId ? await statusSetters(c.vin, c.shipmentId)
                            : { finishedBy: null, washedBy: null, vriBy: null, finishedAt: null,
                                vriAt: null, vriFailed: false, vriFailedBy: null, serviceVisitId: null,
                                postVri: [] };
    sDone++;
    if(onProgress) onProgress({ phase: "status", done: sDone, total: cars.length });
    return { ...c, score: scoreByRn.has(c.rn) ? scoreByRn.get(c.rn) : null, ...st,
             ...postVriTicket(st, c.date) };
  });

  const attributed = carRows.filter(r => r.score != null);
  const noPerson = attributed.filter(r => !r.finishedBy).length;
  if(unmatched.length) notices.push(`${unmatched.length} scored row(s) had no matching Intrepid appointment on those dates.`);
  if(noPerson)         notices.push(`${noPerson} scored car(s) had no "Finished Goods" step recorded, so no one could be credited.`);

  /* ── the failed-VRI cross-check ──
     Intrepid's own vriPassedDate against the detection — see statusSetters().
     Reported rather than reconciled: the two are known to diverge on cars that
     passed once and failed a re-inspection, and quietly picking a winner would
     hide the only cases where the difference matters. A count that stops
     matching what is described there is the signal that something upstream
     changed. */
  const reinspected = carRows.filter(r => r.vriFailed && r.vriPassedAt
                                       && r.vriAt && new Date(r.vriPassedAt) < new Date(r.vriAt)).length;
  const unexplained = carRows.filter(r => !r.vriFailed && r.vriBy && !r.vriPassedAt).length;
  if(reinspected){
    notices.push(`${reinspected} car(s) failed a re-inspection after passing an earlier one. ` +
                 `Intrepid's own "VRI passed" date still shows the earlier pass for these, ` +
                 `so they are counted as failures here and would not be by that field alone.`);
  }
  if(unexplained){
    notices.push(`${unexplained} car(s) have a completed VRI that Intrepid does not show as passed, ` +
                 `but no matching service entry either — not counted as failures. Worth a look if this number grows.`);
  }

  return {
    trtId: trt, dates,
    store: await storeLabel(trt),
    rows: carRows,                          // every car on those dates
    notices,
    ...summarise(carRows, { uploaded: rows.length, scored: scored.length,
                            dates: dates.length, unmatched: unmatched.length })
  };
}

/* people + rank + stats for a set of car rows.

   Factored out because the date-range filter re-derives all three from a
   SUBSET of the same rows, and two code paths computing "the board" from the
   same data is exactly how a filtered view starts quietly disagreeing with the
   unfiltered one. Narrowing the range re-runs this and nothing else — no
   Intrepid traffic, since every car already carries its date. */
function summarise(carRows, extra = {}){
  const attributed = carRows.filter(r => r.score != null);
  return {
    people: byPerson(carRows),
    // Every row, not just the scored ones: teamMean filters nulls itself, and
    // the survey multiplier is meaningless without the unsurveyed denominator.
    rank: rankMeta(carRows),
    stats: {
      dates: new Set(carRows.map(r => r.date).filter(Boolean)).size,
      cars: carRows.length,                 // all deliveries in the window
      matched: attributed.length,
      attributed: attributed.filter(r => r.finishedBy).length,
      washed: carRows.filter(r => r.washedBy).length,
      vri: carRows.filter(r => r.vriBy).length,
      // Cars that did not pass their receiving inspection — see statusSetters().
      // Same basis as `vri`: every delivery in the window, not only the scored.
      vriFailed: carRows.filter(r => r.vriFailed).length,
      // Passed the VRI, then went to service before delivery — postVriTicket().
      postVri: carRows.filter(r => r.ticketPostVri).length,
      scored: attributed.length,
      unmatched: 0,
      ...extra
    }
  };
}

/* ─────────────────────────── the leaderboard ───────────────────────────
   One row per prep person, ranked by a CONFIDENCE-ADJUSTED score rather than a
   raw mean.

   Why: a raw mean rewards doing less. Eighteen cars at a flat 100% outranks
   forty-seven at 99.1%, and two cars at 100% lands mid-board on no real
   evidence — which is neither fair nor useful when the point is to see actual
   contribution.

   The fix is the standard small-sample shrink: pull every average toward the
   team average, hard when the sample is thin and barely at all when it is
   thick.

       adjusted = (cars × mean + K × teamMean) / (cars + K)

   K is the "prior weight" — the number of imaginary team-average cars every
   person is credited with before their own start counting. At K = 10, someone
   with 2 cars is dominated by the team average, someone with 47 is essentially
   their own number. Nobody is excluded and nothing is invented: the raw mean is
   still reported beside it so the adjustment is always visible. */

const MIN_CARS = CONFIG.minCars || 3;
const PRIOR_K  = CONFIG.priorWeight || 10;
const CLEAN_FLOOR = 100;         // a "clean" car scored full marks

/* Sort keys the board can be ranked by. Kept here, not in the page, so the
   CLI, the dashboard and the export can never disagree about what "first"
   means. Each returns a comparator (descending = better at the top). */
const SORTS = {
  weighted    : (a, b) => (b.adjusted ?? -1) - (a.adjusted ?? -1) || b.cars - a.cars,
  // Ties break on quality, not volume: level on clean cars delivered, the
  // person who marked fewer cars along the way did the better job.
  contribution: (a, b) => (b.contribution ?? -1) - (a.contribution ?? -1)
                       || (b.adjusted ?? -1) - (a.adjusted ?? -1),
  mean        : (a, b) => (b.mean ?? -1) - (a.mean ?? -1) || b.cars - a.cars,
  cars        : (a, b) => b.cars - a.cars || (b.adjusted ?? -1) - (a.adjusted ?? -1),
  washed      : (a, b) => (b.washed ?? -1) - (a.washed ?? -1) || b.cars - a.cars,
  vri         : (a, b) => (b.vri ?? -1) - (a.vri ?? -1) || b.cars - a.cars,
  // Ties break on inspections done, so the person who found as many faults
  // over more cars is not outranked by a short lucky run.
  caught      : (a, b) => (b.caught ?? -1) - (a.caught ?? -1) || (b.vri ?? -1) - (a.vri ?? -1),
  /* The one sort where the top of the board is the WORST number, because the
     question it answers — who is letting the most through — is only useful
     that way round. Ranked on the rate, not the count: the busiest inspector
     would otherwise always head it. People with no inspections sort last
     rather than sharing a spotless 0% with someone who earned it. */
  missed      : (a, b) => (b.vri ? b.missedPer100 : -1) - (a.vri ? a.missedPer100 : -1)
                       || (b.missed ?? -1) - (a.missed ?? -1),
  productivity: (a, b) => (b.productivity ?? -1) - (a.productivity ?? -1)
                       || (b.contribution ?? -1) - (a.contribution ?? -1),
  worst       : (a, b) => (b.worst ?? -1) - (a.worst ?? -1) || b.cars - a.cars
};

/* ── the survey multiplier ──
   Only about a fifth of delivered cars come back with a customer survey, so a
   survey is a SAMPLE of a person's prep work, not the whole of it. One spotless
   score therefore stands for roughly 4.5 delivered cars, and one marked score
   for 4.5 that likely went out the same way.

   Deriving it from the window rather than hardcoding 4.5 keeps it honest if the
   response rate moves. Measured across this centre it barely does — 4.47 over a
   month, and 4.0–5.5 for any single week or day inside it — so the number is
   stable enough to rank on.

   Clamped because the arithmetic degenerates at the edges: a window holding one
   survey and fifty cars would otherwise multiply that single opinion by fifty.  */
const SURVEY_MULT_MIN = 1, SURVEY_MULT_MAX = 8;
function surveyMultiplier(rows){
  const finished = rows.filter(r => r.finishedBy).length;
  const surveyed = rows.filter(r => r.score != null).length;
  if(!surveyed || !finished) return 1;
  return Math.min(SURVEY_MULT_MAX, Math.max(SURVEY_MULT_MIN,
    Number((finished / surveyed).toFixed(2))));
}

function byPerson(rows, { sort = "weighted", minCars = 0 } = {}){
  /* Three different jobs, usually three different people, so the roster is the
     union of all of them. Someone who only ever washes or only ever receives
     still belongs on the board — they just have no cleanliness score, because
     cleanliness follows the person who finished the car. */
  const groups = new Map();          // finisher  → their SCORED cars
  const washed = new Map();          // washer    → how many cars they moved
  const vri    = new Map();          // inspector → how many VRIs they cleared
  const caught = new Map();          // inspector → how many of those failed
  const missed = new Map();          // inspector → passed, then ticketed before delivery
  const fin    = new Map();          // finisher  → every car they finished
  for(const r of rows){
    if(r.finishedBy && r.score != null){
      if(!groups.has(r.finishedBy)) groups.set(r.finishedBy, []);
      groups.get(r.finishedBy).push(r);
    }
    if(r.finishedBy) fin.set(r.finishedBy, (fin.get(r.finishedBy) || 0) + 1);
    if(r.washedBy) washed.set(r.washedBy, (washed.get(r.washedBy) || 0) + 1);
    if(r.vriBy)    vri.set(r.vriBy,       (vri.get(r.vriBy)       || 0) + 1);
    if(r.vriFailedBy) caught.set(r.vriFailedBy, (caught.get(r.vriFailedBy) || 0) + 1);
    // Credited to whoever signed the inspection that let it through.
    if(r.ticketPostVri && r.vriBy) missed.set(r.vriBy, (missed.get(r.vriBy) || 0) + 1);
  }
  for(const who of fin.keys())    if(!groups.has(who)) groups.set(who, []);
  for(const who of washed.keys()) if(!groups.has(who)) groups.set(who, []);
  for(const who of vri.keys())    if(!groups.has(who)) groups.set(who, []);

  const mult = surveyMultiplier(rows);

  /* The prior: the centre's own average across every scored car, so the
     shrink pulls toward this team's real standard rather than an arbitrary
     100%. */
  const allScores = rows.map(r => r.score).filter(v => v != null);
  const teamMean = allScores.length
    ? allScores.reduce((a, v) => a + v, 0) / allScores.length
    : 100;

  const out = [];
  for(const [email, rs] of groups){
    const scores = rs.map(r => r.score).filter(v => v != null);
    const n = scores.length;
    const sum = scores.reduce((a, v) => a + v, 0);
    const mean = n ? sum / n : null;
    const clean = scores.filter(v => v >= CLEAN_FLOOR).length;
    const dirty = scores.filter(v => v < CLEAN_FLOOR).length;

    // Shrink toward the team mean in proportion to how thin the sample is.
    const adjusted = n ? (sum + PRIOR_K * teamMean) / (n + PRIOR_K) : null;

    out.push({
      email, handle: handle(email),
      cars   : rs.length,
      scored : n,
      mean   : mean == null ? null : Number(mean.toFixed(1)),
      adjusted: adjusted == null ? null : Number(adjusted.toFixed(2)),
      // How far the shrink moved them — the honest measure of "how much of
      // this rank is evidence vs. assumption".
      shrink : (mean == null || adjusted == null) ? null
                                                  : Number((adjusted - mean).toFixed(2)),
      clean, dirty,
      /* ── contribution ──
         Spotless cars delivered, less one for each that came back marked.

         Deliberately QUALITY ONLY. Wash and VRI counts are throughput, a
         different question from whether the car came back clean, and folding
         them in drowns the cleanliness signal: the movement stages carry four
         times the volume, so the board stops being about cleanliness at all.
         They are measured instead by `productivity` below, which is reported
         separately and does not feed this.

         Rate alone rewards doing less; volume alone rewards doing it badly at
         scale. Neither answers "who actually put the most clean cars on the
         road". This does, and it is a plain count rather than an index — 45
         spotless minus 2 misses is 43, and anyone can check it.

         Quality has to enter as a COUNT, not a multiplier, to carry any
         weight: 47 cars x 99.0% = 46.6 still loses to 48 x 97.3% = 46.7, so a
         multiplier lets one extra car outweigh nearly two points of quality.
         Counting clean cars fixes that — 45 beats 44. */
      // No scored cars means no contribution to state — 0 would read as a
      // genuine zero rather than "not measured here".
      contribution: n ? clean - dirty : null,

      /* ── productivity ──
         The other half of the picture: total work done, across all three
         stages a car passes through.

             productivity = VRIs + washes + cars finished + mult x (spotless − marked)

         One point per job is not an invented weighting — it falls out of the
         data. Every car passes each stage exactly once, so the three pools are
         inherently the same size (983 VRIs, 931 washes, 984 finishes in a
         representative month). Weighting them equally is the neutral position;
         any other ratio would be an opinion about which job is harder, which
         the log cannot settle.

         Quality is multiplied because a survey is a SAMPLE — one covers about
         4.5 delivered cars, so a spotless score stands for that many cars'
         worth of good prep. At 1:1 it is inert against volumes in the hundreds.

         Reported on its own, never mixed into contribution: someone who washes
         279 cars and someone who finishes 47 spotless ones are both doing real
         work, but they are not doing the SAME work, and one number cannot rank
         both without burying whichever has the smaller counts. */
      productivity: Math.round(
        (vri.get(email) || 0) + (washed.get(email) || 0) + (fin.get(email) || 0)
        + mult * (clean - dirty)),
      // The parts, so the working can be shown rather than asserted.
      finished: fin.get(email) || 0,
      quality : Math.round(mult * (clean - dirty)),
      /* Cars this person moved into In Wash, across EVERY delivery in the
         window rather than only the surveyed ones. */
      washed: washed.get(email) || 0,
      /* Receiving inspections completed — the VRI, cleared when the car lands,
         days before prep. Same basis as the wash count. */
      vri: vri.get(email) || 0,
      /* ── catches ──
         Inspections this person failed: damage found on arrival, before the car
         reached prep. Counted as a CREDIT, not a demerit — a failed VRI is the
         inspection working, and the alternative is the fault travelling to the
         customer.

         Deliberately NOT folded into `productivity`. The failure is already
         counted there as the VRI it was; adding it again would pay twice for
         one inspection and quietly make the busiest receiver look better than
         the record supports.

         Read it against `vri`, never alone: three catches out of six is a
         different claim from three out of ninety, and only the rate survives
         the comparison. Both are reported. */
      caught: caught.get(email) || 0,
      // Catches per 100 inspections — volume-neutral, so a receiver who does
      // ten cars and one who does two hundred can actually be compared.
      caughtPer100: vri.get(email)
        ? Number(((caught.get(email) || 0) / vri.get(email) * 100).toFixed(1))
        : 0,
      /* ── tickets after a passing inspection ──
         The mirror of a catch: this person passed the car, and a fault was
         found before it was delivered anyway. Lower is better — the only
         metric on this board where that is true.

         Like the catch count it stays out of `productivity`, and for a further
         reason: productivity is a count of work done, and a miss is not
         negative work. It also stays out of `contribution`, which is
         cleanliness measured by the customer and nothing else.

         Treat the rate as soft. It cannot distinguish a fault the inspection
         should have found from one that appeared over months of standing on a
         lot, and the lag between the two is wide — see postVriTicket(). */
      missed: missed.get(email) || 0,
      missedPer100: vri.get(email)
        ? Number(((missed.get(email) || 0) / vri.get(email) * 100).toFixed(1))
        : 0,
      cleanRate: n ? Math.round(clean / n * 100) : 0,
      // Misses per 100 cars — volume-neutral, and the number a team lead can
      // act on directly.
      dirtyPer100: n ? Number((dirty / n * 100).toFixed(1)) : 0,
      worst  : n ? Math.min(...scores) : null,
      qualified: rs.length >= MIN_CARS
    });
  }

  out.sort(SORTS[sort] || SORTS.weighted);
  return out;
}

/* Context the page needs to explain the ranking honestly. */
function rankMeta(rows){
  const all = rows.map(r => r.score).filter(v => v != null);
  return {
    teamMean: all.length ? Number((all.reduce((a, v) => a + v, 0) / all.length).toFixed(1)) : null,
    priorK  : PRIOR_K,
    minCars : MIN_CARS,
    sorts   : Object.keys(SORTS),
    // What one survey stands for in this window — the page states it rather
    // than quietly applying it.
    surveyMult: surveyMultiplier(rows)
  };
}

/* ──────────────────────────── connect / test ──────────────────────────── */

async function testIntrepid(trtId){
  const trt = trtId || savedTrtId();
  if(!trt) return { ok: false, detail: "No delivery centre set — choose one first" };
  try{
    const rows = await appointmentsOn(new Date().toISOString().slice(0, 10), trt);
    return { ok: true, detail: `${rows.length} appointment(s) today at TRT ${trt}` };
  }catch(err){ return { ok: false, detail: err.message }; }
}

/* Reports the cookie that calls actually use — Hub first, local second — not
   the local file alone. Nothing writes the local copy any more, so reading it
   here would show "not connected" on a board that is working perfectly. */
function connectionsSummary(){
  const got = credstore.intrepidCookie((loadConnections().intrepidCookie || "").trim());
  const cookie = got.value.trim();
  return {
    trtId: savedTrtId(),
    intrepid: { set: Boolean(cookie), hint: cookie ? "…" + cookie.slice(-8) : "",
                source: got.source,
                looksOk: /cogs-authorization=/.test(cookie) }
  };
}

module.exports = {
  CONFIG, loadConnections, saveConnections, savedTrtId, adminPassword,
  connectionsSummary,
  appointmentsOn, statusSetters, postVriTicket, compile, summarise, byPerson, rankMeta,
  storeLabel, searchSites, trtInfo, trtDirectory,
  testIntrepid, intrepidCookie,
  MIN_CARS, PRIOR_K
};

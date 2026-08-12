#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   Charging Tracker — local Garage proxy
   ───────────────────────────────────────────────────────────────────────────
   Serves the dashboard and bridges it to Garage.

   Why a proxy is required: Garage answers a CORS preflight with no
   Access-Control-Allow-Origin header, so a browser page can never call it
   directly. This process makes the call server-side instead.

   Auth is one session cookie per environment, and nothing else. It used to be
   the full MCP OAuth flow — dynamic registration, authorization code with
   PKCE, a localhost callback, token refresh, a JSON-RPC handshake — until it
   turned out that both questions this dashboard asks Garage have a plain REST
   answer behind the same web session the live USOE read already used. All of
   that is gone; see callTool.

   Production and Engineering are separate Garage instances with separate
   sessions, and the dashboard can be pointed at either from the admin panel.

   Cookies come from the Zo Projects Hub, which signs in once for every board,
   falling back to this project's own .garage.json. No secrets are baked in
   and nothing is shared between users — each person signs in as themselves
   and reads with their own Garage permissions.

   Zero dependencies. Node 18+.
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

const http    = require("node:http");
const https   = require("node:https");
const crypto  = require("node:crypto");
const fs      = require("node:fs");
const path    = require("node:path");
const { URL, URLSearchParams } = require("node:url");
const { exec, execFile } = require("node:child_process");

// Isolated sign-in window + CDP cookie read, so nobody has to copy a Cookie:
// header out of DevTools. See the header of that file for why it works the
// way it does.
const credstore = require("./credstore");

/* ───────────────────────────── Configuration ───────────────────────────── */

const CONFIG = {
  port: Number(process.env.PORT || 3118),

  /* The two Garage instances this can talk to. Both are defined up front;
     exactly one is current at a time, chosen in the admin panel and
     remembered in .garage.json.

     Override either host for eu / cn with GARAGE_URL / GARAGE_ENG_URL, and
     pin the starting environment with GARAGE_ENV=prod|eng — see README. */
  environments: {
    prod: {
      key       : "prod",
      label     : "Production",
      garageUrl : process.env.GARAGE_URL || "https://garage.vn.teslamotors.com"
    },
    eng: {
      key       : "eng",
      label     : "Engineering",
      garageUrl : process.env.GARAGE_ENG_URL || "https://garage.dev.teslamotors.com"
    }
  },

  // How far back to look for a USOE snapshot. Datatank serves cached
  // snapshots, so the vehicle does not need to be online right now.
  lookbackHours: Number(process.env.LOOKBACK_HOURS || 6),

  // Don't re-query Garage for the same VIN more often than this.
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 10_000),

  // Hard ceiling on concurrent Garage calls. The dashboard throttles itself,
  // but this backstops it — several open tabs, or a script hitting /api/usoe
  // directly, still cannot fan out past this.
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 4),

  teamsFile : path.join(__dirname, ".teams.json"),
  garageFile: path.join(__dirname, ".garage.json"),

  // Live vitals. Opt-in — see the "Live vitals" section below for why.
  // TTL matches cacheTtlMs so a short refresh interval is never served a
  // stale "live" reading. Concurrency matches the index path, since with live
  // read on every monitored vehicle goes through here.
  liveTtlMs        : Number(process.env.LIVE_TTL_MS || 10_000),
  liveMaxConcurrent: Number(process.env.LIVE_MAX_CONCURRENT || 4),

  // How often to confirm the saved session cookie is still good. Deliberately
  // infrequent: the probe is one redirect with no body, but there is nothing
  // to gain from checking often — a Garage session lasts hours to days, and
  // the only cost of noticing late is a few minutes of cached-only readings.
  cookieCheckMs: Number(process.env.COOKIE_CHECK_MS || 15 * 60 * 1000),

  // How a charge-complete alert reaches Teams:
  //   "webhook" — POST the Adaptive Card straight to a Power Automate flow URL.
  //   "outlook" — hand a message to the local Outlook client over COM, for a
  //               flow whose trigger is "When a new email arrives (V3)".
  //   "auto"    — webhook when one is configured, otherwise outlook.
  // See "Microsoft Teams alerts" in the README for why outlook exists.
  transport: process.env.ALERT_TRANSPORT || "auto",

  // Seed for the recipient list the Outlook transport sends to. This is only
  // the STARTING value — the list is edited in Admin and held in the teams
  // file from then on, so it survives a restart without the env var. Blank =
  // your own address, read from the Outlook profile at send time.
  alertEmailTo: process.env.ALERT_EMAIL_TO || "",

  // Seed for the email on/off switch, for an install that wants email off
  // from the very first boot. Afterwards the switch in Admin owns it.
  alertEmailEnabled: process.env.ALERT_EMAIL_ENABLED !== "0",

  // Marker the flow's subject filter matches on. Changing it means changing
  // the filter in Power Automate to match.
  alertSubjectTag: process.env.ALERT_SUBJECT_TAG || "[CHARGING-TRACKER]",

  // Suppress a repeat Teams alert for the same VIN inside this window, so a
  // page refresh or a re-added vehicle doesn't post the message twice.
  teamsDedupeMs: Number(process.env.TEAMS_DEDUPE_MS || 2 * 60 * 60 * 1000),
};

const REDIRECT_URI = `http://localhost:${CONFIG.port}/callback`;

const log = (...a) => console.log("[charging-tracker]", ...a);
const warn = (...a) => console.warn("[charging-tracker]", ...a);

/* ───────────────────────────── Tiny HTTPS helper ───────────────────────────── */

function request(urlStr, { method = "GET", headers = {}, body = null } = {}){
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status : res.statusCode,
        headers: res.headers,
        body   : Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.setTimeout(45_000, () => req.destroy(new Error("Request to " + url.hostname + " timed out")));
    if(body) req.write(body);
    req.end();
  });
}

function postForm(url, fields){
  const body = new URLSearchParams(fields).toString();
  return request(url, {
    method : "POST",
    headers: {
      "Content-Type"  : "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "Accept"        : "application/json"
    },
    body
  });
}

function postJson(url, obj, extraHeaders = {}){
  const body = JSON.stringify(obj);
  return request(url, {
    method : "POST",
    headers: Object.assign({
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Accept"        : "application/json, text/event-stream"
    }, extraHeaders),
    body
  });
}

/* ───────────────────────────── Token / client store ───────────────────────────── */

function readJson(file){
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeJson(file, obj){
  // The mode is honoured on POSIX and silently ignored on Windows, where NTFS
  // ACLs govern instead — these files are still per-user secrets either way.
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/* ───────────────────────────── Environments ─────────────────────────────
   Production and Engineering are two entirely separate Garage instances:
   different hosts, different Bouncer registrations, different fleets. Every
   piece of state that could leak across that boundary is held per
   environment rather than globally — the session cookie and all four caches.

   The consequence worth relying on: switching is instant and lossless.
   Signing in to Engineering does not sign you out of Production, and a VIN
   read in one environment is never answered out of the other's cache.     */

function makeEnv(def){
  const base = def.garageUrl.replace(/\/+$/, "");
  return {
    def,
    key      : def.key,
    label    : def.label,
    garageUrl: base,



    cache        : new Map(),           // vin -> { cachedAt, value }
    inFlightByVin: new Map(),           // vin -> Promise
    geoCache     : new Map(),           // vin -> { at, value }
    idCache      : new Map(),           // vin -> numeric Mothership id
    liveCache    : new Map(),           // vin -> { at, value }

    live: { cookie: "", enabled: false, lastError: null },


    // Runtime health, deliberately NOT persisted — it describes this process's
    // observations, not configuration, and writing it would rewrite
    // .garage.json every quarter of an hour for nothing.
    health: { lastCheck: null, lastOk: null, lastRead: null, checking: false }
  };
}

const ENVS = Object.fromEntries(
  Object.values(CONFIG.environments).map(def => [def.key, makeEnv(def)])
);

/* GARAGE_ENV pins the environment for this process; without it the last
   choice made in the admin panel is restored from .garage.json. */
const ENV_FORCED = process.env.GARAGE_ENV === "eng" || process.env.GARAGE_ENV === "prod";
let currentEnvKey = ENV_FORCED ? process.env.GARAGE_ENV : "prod";

const env      = () => ENVS[currentEnvKey];
const envByKey = k  => ENVS[k] || null;

/* .garage.json carries the live-read cookie for each environment plus the
   last selected environment. Builds before this change wrote a single flat
   { cookie, enabled, lastError }; that shape is migrated into Production,
   which is the only environment those builds could talk to. */
(function loadGarageFile(){
  const raw = readJson(CONFIG.garageFile);
  if(!raw) return;

  if(!raw.envs && typeof raw.cookie === "string"){
    ENVS.prod.live = {
      cookie   : raw.cookie || "",
      enabled  : Boolean(raw.enabled),
      lastError: raw.lastError || null
    };
    log("migrated .garage.json to the per-environment format");
    return;
  }

  for(const [key, saved] of Object.entries(raw.envs || {})){
    if(!ENVS[key] || !saved) continue;
    ENVS[key].live = {
      cookie   : saved.cookie || "",
      enabled  : Boolean(saved.enabled),
      lastError: saved.lastError || null
    };
  }
  if(!ENV_FORCED && raw.current && ENVS[raw.current]) currentEnvKey = raw.current;
})();

function saveGarageFile(){
  writeJson(CONFIG.garageFile, {
    current: currentEnvKey,
    envs   : Object.fromEntries(Object.entries(ENVS).map(([k, e]) => [k, e.live]))
  });
}

/* "Authenticated" used to mean an OAuth access token. There is no such thing
   here any more: one session cookie is the whole credential, for the index
   and for the live read alike. The name is kept because the admin panel and
   two status lines read it, and one true meaning of "can this environment
   talk to Garage" is better than two. */
const isAuthed = e => Boolean(liveCookie(e));

/* ── whose cookie ──
   The Hub's shared store first, this dashboard's own .garage.json second.
   Signing in on the Hub fixes every board at once, which a stale local copy
   would quietly defeat — so shared wins rather than local.

   Read on every call rather than cached at boot: the Hub can be signed in
   while this is running, and a dashboard that needed restarting to notice
   would make the whole arrangement feel broken. */
function liveCookie(e){
  return credstore.garageCookie(e.key, (e.live.cookie || "").trim()).value.trim();
}

/* Where the cookie in play came from, for the admin panel. */
function liveCookieSource(e){
  return credstore.garageCookie(e.key, (e.live.cookie || "").trim()).source;
}


/* ── the same two questions, over the session cookie ──

   Both tools this dashboard used have a plain REST equivalent behind Garage's
   own web session, and the session cookie was already saved here for the live
   USOE read. So the OAuth client, the token store, the refresh dance and the
   MCP handshake were all machinery for reaching data one cookie already
   reaches. They are gone.

   The signature is unchanged and so are the return shapes, so all seven call
   sites above are untouched: `{results}` for a search, `{rows}` for a vitals
   pull. Swapping transports should not be visible to callers, and if it ever
   has to be swapped back this is the only function to edit.

   `garageGet` throws `sessionDead` rather than a generic error because a
   stale Garage session does not 401 — it redirects to SSO or answers 200 with
   the sign-in page — and the callers already know how to tell someone to
   sign in again.                                                           */
async function garageGet(e, pathAndQuery){
  const cookie = liveCookie(e);
  if(!cookie) throw new Error(`No ${e.label} session cookie saved`);

  const res = await request(e.garageUrl + pathAndQuery, {
    headers: { Cookie: cookie, Accept: "application/json",
               "User-Agent": "Mozilla/5.0 (charging-tracker)" }
  });

  if(res.status === 401 || res.status === 403 ||
     (res.status >= 300 && res.status < 400)){
    const err = new Error(`${e.label} session cookie expired or was rejected — sign in on the Hub.`);
    err.sessionDead = true;
    throw err;
  }
  if(res.status >= 400) throw new Error(`Garage HTTP ${res.status}`);

  try { return JSON.parse(res.body); }
  catch{
    const err = new Error(`${e.label} returned a sign-in page rather than data — sign in on the Hub.`);
    err.sessionDead = true;
    throw err;
  }
}

async function callTool(e, name, args){
  if(name === "tesladex_search"){
    const qs = [
      "type=vehicle",
      "query=" + encodeURIComponent(args.query),
      "size=" + Number(args.size || 100),
      "from=" + Number(args.from || 0),
      "sort=" + encodeURIComponent(args.sort || "vin:asc"),
      ...(args.fields || ["vin"]).map(f => "fields[]=" + encodeURIComponent(f))
    ].join("&");
    const d = await garageGet(e, "/api/1/tesladex/search?" + qs);
    const rows = Array.isArray(d && d.response) ? d.response : [];
    return { results: rows, total: (d && d.total) ?? rows.length };
  }

  if(name === "device_historical_vitals"){
    // The REST endpoint is addressed by numeric id; the tool used to accept a
    // VIN and resolve it server-side. deviceIdFor already caches that lookup.
    const id = /^\d+$/.test(String(args.device_id))
      ? String(args.device_id)
      : await deviceIdFor(e, args.device_id);
    const qs = [
      "hours=" + Number(args.hours || 24),
      "asc=" + (args.asc ? "true" : "false"),
      ...(args.fields || []).map(f => "fields[]=" + encodeURIComponent(f))
    ].join("&");
    const d = await garageGet(e,
      `/api/1/vehicles/${encodeURIComponent(id)}/vitals_snapshots/datatank_historical_vitals?${qs}`);
    return { rows: Array.isArray(d && d.response) ? d.response : [] };
  }

  throw new Error(`Unsupported Garage call: ${name}`);
}

/* ───────────────────────────── USOE lookup ─────────────────────────────
   Reads the USOE vitals column specifically. USOE (usable state of energy)
   and SOC are two separate columns in Garage — USOE is the customer-facing
   number and the one this dashboard tracks.                              */

/* Counting semaphore. Callers queue rather than being rejected, so a burst
   is slowed down instead of dropped. Deliberately global rather than
   per-environment: it exists to protect this process's own socket budget,
   and only one environment is ever being polled at a time.               */
let inFlight = 0;
const waiting = [];

async function withSlot(fn){
  if(inFlight >= CONFIG.maxConcurrent){
    await new Promise(resolve => waiting.push(resolve));
  }
  inFlight++;
  try{
    return await fn();
  }finally{
    inFlight--;
    const next = waiting.shift();
    if(next) next();
  }
}

/* Shape returned by device_historical_vitals:
     { count, hours, asc,
       rows:   [ { USOE: 68.792, source: "was_charging", txid, time } , … ],
       fields: [ { name: "USOE", value_type: "numeric", min, max } ] }

   Two things worth knowing, both verified against live Garage responses:
     · rows arrive OLDEST-first even when asc:false is requested, so the
       newest reading has to be selected by timestamp, not by position;
     · `fields` is an array of column descriptors, not an object keyed
       by column name.                                                    */
function extractUsoe(payload){
  if(!payload) return null;

  const rows = payload.rows || payload.data || payload.results;
  if(Array.isArray(rows) && rows.length){
    let best = null;
    const pts = [];
    for(const row of rows){
      const raw = row.USOE ?? row.usoe ?? row.value;
      const val = typeof raw === "string" ? Number(raw) : raw;
      if(typeof val !== "number" || Number.isNaN(val)) continue;

      const stamp = row.time || row.timestamp || row.ts || null;
      const t = stamp ? (Date.parse(stamp) || 0) : 0;
      pts.push({ t, val, at: stamp });
      if(!best || t >= best.t) best = { t, val, at: stamp };
    }
    if(best){
      // The newest point STRICTLY older than the latest reading — the far end
      // of the vehicle's own last snapshot interval. This is what lets a first
      // poll tell a charging car from an idle one: without it the page needs
      // two of its own cycles before any rise exists to measure.
      //
      // Unstamped rows (t === 0) can never qualify, so a payload with no
      // usable timestamps yields no trend rather than a bogus one.
      let prev = null;
      for(const p of pts){
        if(p.t >= best.t) continue;
        if(!prev || p.t > prev.t) prev = p;
      }
      return {
        usoe  : best.val,
        at    : best.at,
        prev  : prev ? prev.val : null,
        prevAt: prev ? prev.at  : null,
        spanMs: prev ? best.t - prev.t : null
      };
    }
  }

  // Fallback: pull a value out of the column summary.
  const fields = payload.fields;
  const desc = Array.isArray(fields)
    ? fields.find(f => String(f.name).toUpperCase() === "USOE")
    : (fields && (fields.USOE || fields.usoe));
  if(desc){
    for(const k of ["last", "latest", "value", "max"]){
      // The column summary carries no history, so there is no trend to read.
      if(typeof desc[k] === "number"){
        return { usoe: desc[k], at: null, prev: null, prevAt: null, spanMs: null };
      }
    }
  }
  return null;
}

/* Which kind of charger a vehicle is on, derived from the CACHED snapshots.

   CP_pilot is live-only, and the vehicles this matters most for are exactly
   the ones the live path cannot reach: AC charging draws little power, so a
   car on a destination charger goes to sleep and GET /vehicles/<vin>/vitals
   answers 408 "vehicle unavailable". Verified on 7SAYGDED5TA736455, plugged
   in on LINE_CHARGE and unreachable on three consecutive live reads.

   The cached set carries two LIFETIME kWh counters — bms_ac_charger_kwh_total
   and bms_dc_charger_kwh_total — and only the one matching the connector in
   use advances. Measured over 12h:

     7SAYGDED5TA736455 (AC)   ac 22.774 -> 23.663      dc 81.413 flat
     7SAYGDEE7TA747319 (DC)   ac 0.0    flat           dc 46.918 -> 55.586

   Compares the MOST RECENT consecutive pair in which either counter moved,
   NOT first-vs-last across the window. Over a 6h lookback a car that
   supercharged this morning and is on AC now has BOTH counters higher than
   at the start, and first-vs-last would report whichever moved more —
   picking the charger the car has already left.

   Returns a CP_pilot-shaped string so callers can treat it identically to a
   live reading, or null when nothing moved (parked, or charging so slowly
   that no snapshot straddles a change).                                    */
function derivePilot(payload){
  if(!payload) return null;

  const rows = payload.rows || payload.data || payload.results;
  if(!Array.isArray(rows) || rows.length < 2) return null;

  const num = r => {
    const ac = Number(r.bms_ac_charger_kwh_total);
    const dc = Number(r.bms_dc_charger_kwh_total);
    if(!Number.isFinite(ac) || !Number.isFinite(dc)) return null;
    const stamp = r.time || r.timestamp || r.ts || null;
    return { ac, dc, t: stamp ? (Date.parse(stamp) || 0) : 0 };
  };

  // Newest first, matching the asc:false the caller requests. Sorted rather
  // than assumed: the endpoint's ordering is not part of its contract.
  const pts = rows.map(num).filter(Boolean).sort((a, b) => b.t - a.t);
  if(pts.length < 2) return null;

  // Counters are kWh to 3dp. A threshold well under the smallest real
  // increment (0.001) still rejects float noise without missing a slow AC
  // trickle — the AC car above moved 0.889 kWh across the window.
  const EPS = 0.0005;

  for(let i = 0; i < pts.length - 1; i++){
    const newer = pts[i], older = pts[i + 1];
    const dAc = newer.ac - older.ac;
    const dDc = newer.dc - older.dc;
    if(dAc <= EPS && dDc <= EPS) continue;      // nothing moved in this pair
    // Both moving in one interval is possible if a snapshot straddles a
    // swap between connectors. The larger delta is the one that dominated.
    return dAc > dDc ? "LINE_CHARGE" : "FAST_CHARGE";
  }
  return null;
}

async function getUsoe(e, vin){
  const hit = e.cache.get(vin);
  if(hit && Date.now() - hit.cachedAt < CONFIG.cacheTtlMs) return hit.value;

  // Already fetching this VIN? Join that request rather than issuing a second.
  const pendingCall = e.inFlightByVin.get(vin);
  if(pendingCall) return pendingCall;

  const call = withSlot(async () => {
    const payload = await callTool(e, "device_historical_vitals", {
      device_id: vin,
      // The two counters ride along on a call that already runs. They are
      // what derivePilot() reads; fetching them separately would have
      // doubled the request count for this path.
      fields   : ["USOE", "bms_ac_charger_kwh_total", "bms_dc_charger_kwh_total"],
      hours    : CONFIG.lookbackHours,
      asc      : false
    });

    const found = extractUsoe(payload);
    if(!found){
      throw new Error(`No USOE snapshot for ${vin} in the last ${CONFIG.lookbackHours}h`);
    }

    const value = {
      usoe      : Math.max(0, Math.min(100, found.usoe)),
      readingAt : found.at,
      // The vehicle's own previous snapshot and the gap to it. Clamped the
      // same way as usoe so the two are always comparable.
      prevUsoe  : found.prev != null ? Math.max(0, Math.min(100, found.prev)) : null,
      prevAt    : found.prevAt ?? null,
      histSpanMs: found.spanMs ?? null,
      samples   : payload.count ?? (payload.rows || []).length,
      pilot     : derivePilot(payload)
    };
    e.cache.set(vin, { cachedAt: Date.now(), value });
    return value;
  }).finally(() => e.inFlightByVin.delete(vin));

  e.inFlightByVin.set(vin, call);
  return call;
}

/* ──────────────────── Geofence (TRT) + model, per VIN ────────────────────
   Which Tesla facility geofence a vehicle currently sits in. Read from
   Tesladex rather than vitals: GUI_trtId exists as a vitals column but is
   empty on customer cars, whereas Tesladex carries a populated
   `tesla_facility` block plus a top-level `trt_id`.

   `model` rides along on the SAME query. It is a static property of the
   vehicle, so it could have been its own permanently-cached lookup — but
   Tesladex is already being asked about exactly these VINs, and adding a
   field to an existing projection costs nothing. A separate call would have
   doubled the request count to fetch a string that never changes.

   Model is returned RAW ("3", "y", "cybertruck") — the vocabulary mixes
   single letters with whole words. Normalising to a display name is the
   page's job, not this function's.

   Looked up in BATCHES. Tesladex accepts vin:(A OR B OR C), so a 100-VIN
   list costs two queries instead of a hundred — which matters given how
   carefully the rest of the polling is throttled.                          */

const GEO_TTL  = Number(process.env.GEO_TTL_MS || 5 * 60 * 1000);
const GEO_CHUNK = 50;

async function getGeofences(e, vins){
  const out = {}, need = [];

  for(const vin of vins){
    const hit = e.geoCache.get(vin);
    if(hit && Date.now() - hit.at < GEO_TTL) out[vin] = hit.value;
    else need.push(vin);
  }

  for(let i = 0; i < need.length; i += GEO_CHUNK){
    const chunk = need.slice(i, i + GEO_CHUNK);

    const payload = await withSlot(() => callTool(e, "tesladex_search", {
      query : "vin:(" + chunk.join(" OR ") + ")",
      fields: ["vin", "trt_id", "tesla_facility", "model"],
      size  : chunk.length
    }));

    const rows = (payload && (payload.results || payload.rows)) || [];
    const seen = new Set();

    for(const r of rows){
      if(!r || !r.vin) continue;
      const fac = r.tesla_facility || null;
      const value = {
        trtId: r.trt_id == null ? null : Number(r.trt_id),
        name : fac && fac.name     ? fac.name     : null,
        site : fac && fac.sub_name ? fac.sub_name : null,
        type : fac && fac.type     ? fac.type     : null,
        model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : null
      };
      e.geoCache.set(r.vin, { at: Date.now(), value });
      out[r.vin] = value;
      seen.add(r.vin);
    }

    // A VIN Tesladex didn't return has no facility — record that definitively
    // rather than leaving it unknown and re-querying every sweep.
    for(const vin of chunk){
      if(seen.has(vin)) continue;
      const value = { trtId: null, name: null, site: null, type: null, model: null };
      e.geoCache.set(vin, { at: Date.now(), value });
      out[vin] = value;
    }
  }

  return out;
}

/* ─────────────────────── Scheduled deliveries by date ───────────────────────
   Every VIN scheduled to deliver from a given location (TRT) on a given day.

   Same Tesladex index the geofence lookup uses, but keyed on the nested
   `delivery_details` block validated against COGS:

     scheduled_delivery_location_trt_id — the location the delivery is BOOKED
       at, which is what a delivery board scopes by. Deliberately NOT the
       top-level trt_id, which is the car's live geofence — where it happens
       to be parked right now, often a staging lot or in transit.
     scheduled_delivery_date — the appointment day, local. NOT delivery_date
       (an inconsistent stamp) and NOT scheduled_delivery_date_utc (which
       rolls evening-local slots into the next UTC day and silently drops
       them).

   Known limit, surfaced to the caller rather than hidden: for a PAST or
   current date this returns the still-pending appointments faithfully, but
   already-delivered cars fall out — Tesladex clears their scheduled fields on
   delivery and its `delivered` flag lags ~24h. For a FUTURE date nothing has
   delivered yet, so the list is complete. The dashboard notes this.

   Paginated: a busy day runs past Tesladex's 100-row page, so this walks
   pages until the index says there are no more, capped so a bad query can
   never spin forever.                                                        */
async function getDeliveries(e, trt, date){
  const PAGE = 100, MAX = 1000;
  const seen = new Set();
  const vehicles = [];

  /* Tesladex scopes results to the CALLER's permissions, and does it by
     redacting fields rather than by erroring: an account without delivery
     visibility gets a truthful `total` alongside rows with no `vin` in them.
     Dropping those rows silently made that indistinguishable from a day with
     nothing booked, and the page then said "No deliveries scheduled" to
     someone who was simply not allowed to see them. Count both so the caller
     can tell the two apart. */
  let matched = null, redacted = 0;

  for(let from = 0; from < MAX; from += PAGE){
    const payload = await withSlot(() => callTool(e, "tesladex_search", {
      query : `delivery_details.scheduled_delivery_location_trt_id:${trt} AND delivery_details.scheduled_delivery_date:${date}`,
      fields: ["vin", "model", "delivered", "delivery_stage"],
      size  : PAGE,
      from
    }));

    if(matched === null && payload && Number.isFinite(Number(payload.total))){
      matched = Number(payload.total);
    }

    const rows = (payload && (payload.results || payload.rows)) || [];
    for(const r of rows){
      if(!r || !r.vin){ redacted++; continue; }
      if(seen.has(r.vin)) continue;
      seen.add(r.vin);
      vehicles.push({
        vin      : r.vin,
        model    : r.model || null,
        delivered: Boolean(r.delivered),
        stage    : r.delivery_stage || null
      });
    }

    // Stop when the index reports no more, or a short page proves we drained it.
    if(!payload || payload.has_more === false || rows.length < PAGE) break;
  }

  return { vehicles, matched, redacted };
}

/* ── Why did a delivery lookup come back empty? ───────────────────────────
   Tesladex enforces permissions two different ways, and both land on an empty
   vehicle list that is otherwise identical to a quiet day:

     · field redaction  — a truthful `total` with the `vin` stripped out of
       every row. getDeliveries already catches this one by counting.
     · document filtering — the rows are simply not in the result set, so
       `total` is 0 and there is nothing to count.

   The second is invisible from the primary query alone, so this asks two
   cheap follow-ups (size 1, total only) and reads the answer off the pair:

     deliveries at this TRT on ANY date > 0  → the account can see delivery
                                               data; the date really is empty
     none, but vehicles at this TRT     > 0  → Tesladex and the TRT are both
                                               fine, delivery data is not
                                               visible → permissions
     neither                                 → nothing at this TRT is visible:
                                               wrong site, or access is
                                               restricted much more broadly

   Only runs when the lookup found nothing, so the normal path pays nothing
   for it. A probe that throws returns "unknown" rather than taking the
   request down with it — this is diagnostics, not the feature.          */
async function diagnoseEmptyDeliveries(e, trt){
  const totalFor = async query => {
    const payload = await withSlot(() => callTool(e, "tesladex_search", {
      query, fields: ["vin"], size: 1, from: 0
    }));
    const n = Number(payload && payload.total);
    return Number.isFinite(n) ? n : 0;
  };

  try{
    const anyDate = await totalFor(
      `delivery_details.scheduled_delivery_location_trt_id:${trt}`);
    if(anyDate > 0) return { reason: "emptyDay", anyDate, anyVehicle: null };

    const anyVehicle = await totalFor(`trt_id:${trt}`);
    return anyVehicle > 0
      ? { reason: "noDeliveryVisibility", anyDate, anyVehicle }
      : { reason: "trtInvisible",         anyDate, anyVehicle };
  }catch(err){
    warn(`delivery diagnosis failed (${e.key}):`, err.message);
    return { reason: "unknown", anyDate: null, anyVehicle: null };
  }
}

/* The vehicle_type tag vocabulary, whitelisted so a caller can never inject
   arbitrary Lucene into the query through the `types` field. Observed values
   at Houston-Cypress; any type not in this set is rejected at the route.   */
const VEHICLE_TYPES = [
  "customer-vehicle", "inventory-vehicle", "service-loaner",
  "marketing-vehicle", "mobileservice", "internal-vehicle", "autonomous"
];

/* ─────────────────────────── Low-SoC lookup ───────────────────────────
   Undelivered vehicles parked at one or more TRTs whose usable charge is at
   or below a threshold — the "low battery" cars chased down by daily email.

   All three filters run server-side in Tesladex (verified 2026-07-31):
     · USOE:[* TO n]        — battery is an indexed double, range-queryable
     · delivered:false      — ALWAYS applied; this is the hard guard that
                              keeps the tool off real customer cars, and it is
                              not caller-controllable
     · vehicle_type:(a OR b)— restricted to the whitelist above

   trt_id is the GEOFENCE (where the car sits now), which is what "parked and
   draining at location X" means, and matches how the Offsite tag is derived.

   Paginated like getDeliveries; a low-battery list is normally small but the
   loop costs nothing and removes the 100-row ceiling as a failure mode.    */
async function getLowSoc(e, trts, types, maxUsoe){
  const PAGE = 100, MAX = 1000;
  const seen = new Set();
  const vehicles = [];

  const trtClause  = `trt_id:(${trts.join(" OR ")})`;
  const typeClause = `vehicle_type:(${types.join(" OR ")})`;
  const query = `${trtClause} AND USOE:[* TO ${maxUsoe}] AND delivered:false AND ${typeClause}`;

  for(let from = 0; from < MAX; from += PAGE){
    const payload = await withSlot(() => callTool(e, "tesladex_search", {
      query,
      fields: ["vin", "model", "USOE", "SOC", "vehicle_type"],
      sort  : "USOE:asc",
      size  : PAGE,
      from
    }));

    const rows = (payload && (payload.results || payload.rows)) || [];
    for(const r of rows){
      if(!r || !r.vin || seen.has(r.vin)) continue;
      seen.add(r.vin);
      vehicles.push({
        vin        : r.vin,
        model      : r.model || null,
        usoe       : Number.isFinite(Number(r.USOE)) ? Number(r.USOE) : null,
        soc        : Number.isFinite(Number(r.SOC)) ? Number(r.SOC) : null,
        vehicleType: r.vehicle_type || null
      });
    }

    if(!payload || payload.has_more === false || rows.length < PAGE) break;
  }

  return vehicles;
}

/* ─────────────────────── TRT geofence scan (Active Mode) ───────────────────
   Every VIN currently geofenced at a TRT — the live population of a facility.
   trt_id is the physical geofence, so this is exactly "what is parked here
   right now", which is what Active Mode mirrors into the monitor.

   Two shapes, chosen by the caller:

     · UNFILTERED (`trt_id:N` alone) — the whole lot, which is what engineering
       wants: the population there is small and every car is potentially of
       interest.
     · FILTERED — `delivered:false` plus a vehicle_type allowlist. Production
       needs this. Houston-Cypress holds 256 cars, 177 of them undelivered, and
       58 of those are loaners / marketing / internal / mobile-service that live
       at the site permanently and will never be charged for a customer.
       Filtering to customer + inventory takes the tracked pool to 118.

   An ALLOWLIST rather than a denylist, deliberately: the index carries types
   beyond the documented set (one Model 3 at Houston is tagged `energy`), so
   naming what we want is the only way a new tag cannot silently leak in.

   USOE rides along on the SAME query — the same reasoning as `model` in
   getGeofences, but with much more at stake. Tesladex's USOE is the identical
   number the per-VIN cached path returns (verified against Datatank on three
   cars, 2026-08-09), so one page of this query replaces 100 per-VIN reads.
   That is what lets Active Mode triage a 118-car lot in two requests and
   spend the expensive live read only on cars whose charge is actually moving.

   Paginated with a generous cap; a busy facility ran to ~350 in testing, so
   the cap only guards against a runaway query.                              */
async function getTrtVins(e, trt, opts = {}){
  const PAGE = 100, MAX = 3000;
  const vins = [];
  const rows = [];
  const seen = new Set();
  let total = null, rawRows = 0, offsite = 0;

  /* Caller-supplied types are intersected with the whitelist by the route
     before they reach here, so this only has to decide whether to filter. */
  const types = Array.isArray(opts.types) ? opts.types.filter(Boolean) : [];
  const filtered = types.length > 0;

  const clauses = [`trt_id:${trt}`];
  if(filtered){
    // delivered:false is implied by filtering at all — a delivered car has left
    // the funnel, and tracking one would put the tool on a real customer's car.
    clauses.push("delivered:false");
    clauses.push(`vehicle_type:(${types.join(" OR ")})`);
  }
  const query = clauses.join(" AND ");

  for(let from = 0; from < MAX; from += PAGE){
    const payload = await withSlot(() => callTool(e, "tesladex_search", {
      query,
      fields: ["vin", "trt_id", "USOE", "SOC", "model", "vehicle_type",
               "hermes_last_seen", "delivery_details.scheduled_delivery_date"],
      size  : PAGE,
      from
    }));

    // Tesladex reports the full hit count on every page; capture it once so the
    // caller can tell our unique count apart from what the index actually holds
    // (and from what Garage's live geofence shows).
    if(total === null && payload && typeof payload.total === "number") total = payload.total;

    const page = (payload && (payload.results || payload.rows)) || [];
    rawRows += page.length;
    for(const r of page){
      if(!r || !r.vin || seen.has(r.vin)) continue;

      /* The query already scopes to this geofence, so a row that comes back
         sitting somewhere else means the index disagreed with itself. Drop it
         rather than hand the caller a car it would then have to badge Offsite:
         Active Mode's whole premise is "what is parked HERE", and a vehicle we
         cannot place at this TRT has no business being auto-added. Counted so
         a silent shortfall is still visible in the response. */
      if(r.trt_id != null && Number(r.trt_id) !== trt){ offsite++; continue; }

      seen.add(r.vin);
      vins.push(r.vin);

      const dd = r.delivery_details || null;
      rows.push({
        vin        : r.vin,
        trtId      : r.trt_id == null ? null : Number(r.trt_id),
        // null rather than 0 when absent: "no reading" and "empty battery" are
        // different answers, and the client gates polling on the difference.
        usoe       : Number.isFinite(Number(r.USOE)) ? Number(r.USOE) : null,
        soc        : Number.isFinite(Number(r.SOC))  ? Number(r.SOC)  : null,
        model      : r.model || null,
        vehicleType: r.vehicle_type || null,

        /* UNIX seconds of the vehicle's last Hermes contact — the same value
           device_info reports as `last_seen`, confirmed identical on two cars
           (2026-08-10). A vehicle only contacts Hermes when it has something
           to say, so this is an event stamp, not a heartbeat: `state: online`
           can sit on top of a last_seen several minutes old. What it is good
           for is the inverse — a car that has not been heard from in a long
           while is asleep, and a charging car never is. */
        lastSeen   : Number.isFinite(Number(r.hermes_last_seen))
                       ? Number(r.hermes_last_seen) : null,
        deliveryDate: (dd && dd.scheduled_delivery_date) || null
      });
    }
    if(!payload || payload.has_more === false || page.length < PAGE) break;
  }

  // total: Tesladex's own hit count. rawRows: rows we actually walked. vins:
  // unique VINs. All three equal in the normal case; a gap points at dedup
  // (rawRows > vins) or a paging shortfall (total > rawRows).
  // `filtered` travels with the result because the caller cannot otherwise tell
  // a small lot apart from a heavily filtered one. The query itself is fully
  // determined by it plus `types`, so it is not worth returning as well.
  return { vins, rows, filtered, offsite,
           total: total == null ? vins.length : total, rawRows };
}

/* ───────────────────────────── Live vitals ─────────────────────────────
   The Garage web UI reads current vitals from GET /vehicles/<id>/vitals.
   That endpoint is session-authenticated: a Bouncer token gets exactly the
   same 401 as sending no credential at all, so it needs a cookie copied out
   of a signed-in browser. That is why this is opt-in and off by default.

   The cookie is held PER ENVIRONMENT. A production Garage session is not
   valid against garage.dev and vice versa, so each has its own — turning
   live read on in one says nothing about the other.

   Two measured properties shape how it is used:

     · The response is ~140 KB per vehicle — the entire vitals dump, ~4,475
       fields, to obtain two numbers. A cached snapshot is a few hundred
       bytes, so a 100-vehicle sweep moves roughly 14 MB. With live read on,
       every monitored vehicle goes through here anyway: a deliberate call,
       since the lists this runs against are normally small and freshening
       only some vehicles made the dashboard harder to reason about.

     · It is genuinely current. Cached snapshots trail by 8-12 minutes while
       a vehicle is charging, and far longer once it is parked, because the
       car only reports on its own state changes.

   Every failure falls back to the cached path rather than surfacing an
   error — live reading is an accelerator, never a dependency.            */

const liveReady = e => Boolean(e.live.enabled && liveCookie(e));

/* VIN -> numeric Mothership id. The live endpoint is addressed by id, not
   VIN. Ids never change, so this is cached for the life of the process. */
async function deviceIdFor(e, vin){
  if(e.idCache.has(vin)) return e.idCache.get(vin);

  const payload = await withSlot(() => callTool(e, "tesladex_search", {
    query : "vin:" + vin,
    fields: ["vin", "id"],
    size  : 1
  }));

  const row = ((payload && (payload.results || payload.rows)) || [])[0];
  if(!row || row.id == null) throw new Error(`Tesladex has no numeric id for ${vin}`);

  e.idCache.set(vin, String(row.id));
  return String(row.id);
}

/* A tighter throttle than the index path — these responses are two orders of
   magnitude larger. */
let liveInFlight = 0;
const liveWaiting = [];

async function withLiveSlot(fn){
  if(liveInFlight >= CONFIG.liveMaxConcurrent){
    await new Promise(resolve => liveWaiting.push(resolve));
  }
  liveInFlight++;
  try{ return await fn(); }
  finally{
    liveInFlight--;
    const next = liveWaiting.shift();
    if(next) next();
  }
}

async function getLiveUsoe(e, vin){
  const cookie = liveCookie(e);
  if(!cookie) throw new Error(`No ${e.label} session cookie saved`);

  const hit = e.liveCache.get(vin);
  if(hit && Date.now() - hit.at < CONFIG.liveTtlMs) return hit.value;

  const id  = await deviceIdFor(e, vin);
  const res = await withLiveSlot(() => request(
    `${e.garageUrl}/vehicles/${id}/vitals`,
    { headers: { Accept: "application/json", Cookie: cookie,
                 "User-Agent": "Mozilla/5.0 (charging-tracker)" } }
  ));

  if(res.status === 401 || res.status === 403){
    // Garage sessions expire on their own schedule. Switch live off rather
    // than hammering with a dead cookie; the admin panel reports this and
    // asks for a fresh one.
    e.live.enabled   = false;
    e.live.lastError = `${e.label} session cookie expired or was rejected — paste a fresh one.`;
    e.liveCache.clear();
    saveGarageFile();
    const err = new Error(e.live.lastError); err.liveExpired = true; throw err;
  }
  if(res.status >= 400) throw new Error(`Live vitals returned HTTP ${res.status}`);

  let body;
  try{ body = JSON.parse(res.body); }
  catch{ throw new Error("Live vitals did not return JSON — the cookie may be a sign-in redirect"); }

  const usoe = Number(body.USOE);
  if(!Number.isFinite(usoe)) throw new Error("Live vitals response carried no USOE");

  const value = {
    usoe     : Math.max(0, Math.min(100, usoe)),
    soc      : Number.isFinite(Number(body.SOC)) ? Number(body.SOC) : null,
    readingAt: body.timestamp || null,
    // Charge-port proximity — the "Proximity: DISCONNECTED / LATCHED" line in
    // Garage's vitals tab. This is a LIVE-ONLY field: the cached historical
    // vitals set carries no CP_* columns at all (only the unrelated `cp_type`
    // config value), so with live read off it is simply unknowable and the
    // dashboard has to treat it as such.
    //
    // Deliberately NOT CP_latchState — that reads ENGAGED on a car with
    // nothing plugged in at all, because it describes the latch mechanism
    // rather than whether a connector is present. Verified against a parked
    // vehicle reporting CP_proximity DISCONNECTED and CP_latchState ENGAGED
    // simultaneously. Using it would have flagged every idle car.
    proximity: typeof body.CP_proximity === "string"
                 ? body.CP_proximity.trim().toUpperCase() : null,

    // Which KIND of charger the car is connected to.
    //   FAST_CHARGE — DC, i.e. a Supercharger
    //   LINE_CHARGE — AC, i.e. a Wall Connector / destination charger
    //   NONE        — nothing plugged in
    //
    // Live-only, like CP_proximity: the cached historical set has no CP_*
    // columns. getUsoe() derives an equivalent from the AC/DC kWh counters
    // for the (common) case of a sleeping car.
    //
    // Deliberately NOT CP_pilotCurrent — that reads "0" on a vehicle pulling
    // 140 A on DC, because it reports the AC pilot signal amperage and is
    // meaningless on a Supercharger. Verified on 7SAYGDEE7TA747319 mid-charge.
    pilot: typeof body.CP_pilot === "string"
             ? body.CP_pilot.trim().toUpperCase() : null,

    // Pack current in amps. Negative is discharge, positive is energy going
    // in. Reported as a STRING ("-0.500") in BMS_packCurrent and as a number
    // in bms_current — prefer the former, fall back to the latter, and let
    // anything unparseable become null rather than 0, which would read as a
    // measurement of "not charging".
    packAmps : (() => {
      const raw = body.BMS_packCurrent ?? body.bms_current;
      const n   = Number(raw);
      return Number.isFinite(n) ? n : null;
    })(),

    live     : true
  };

  if(e.live.lastError){ e.live.lastError = null; saveGarageFile(); }
  // A successful read is the strongest possible proof the cookie is alive,
  // and it is what makes the admin indicator read "active" rather than merely
  // "configured".
  e.health.lastOk = e.health.lastRead = Date.now();
  e.liveCache.set(vin, { at: Date.now(), value });
  return value;
}

/* ── Cookie health ─────────────────────────────────────────────────────
   A dead cookie used to be discovered only when a live read happened to hit
   an AWAKE vehicle: a sleeping car answers 408 whether the session is good or
   not, so a fleet that is all asleep would 408 forever and never reveal that
   the cookie had expired hours ago.

   This probes it directly. GET / on Garage answers 302 either way, but the
   destination gives it away — /vehicles when the session is live,
   /users/sign_in when it is not. Verified against a valid cookie, a corrupted
   one and no cookie at all. It is a redirect with no body and touches no
   vehicle, so it cannot wake anything or be confused with a 408.            */
const SIGN_IN_RE = /\/users\/sign_in/;

/* Is this particular header a signed-in session? true / false / null for
   "the question could not be asked" — see the catch below.

   Split out from checkCookie because the sign-in window needs to ask it of a
   CANDIDATE header before that header is committed anywhere. Garage is Rails,
   so _garage_session exists for anonymous visitors too: the cookie showing up
   in the profile proves nothing, and this probe is the only thing that
   separates a real session from a browser sitting on the login page.        */
async function probeCookie(e, cookie){
  try{
    const res = await request(e.garageUrl + "/", {
      headers: { Accept: "text/html,application/json",
                 Cookie: cookie,
                 "User-Agent": "Mozilla/5.0 (charging-tracker)" }
    });
    return !(res.status === 401 || res.status === 403 ||
             SIGN_IN_RE.test(String(res.headers.location || "")));
  }catch{
    return null;
  }
}

async function checkCookie(e){
  if(!liveCookie(e) || e.health.checking) return null;
  e.health.checking = true;

  try{
    const alive = await probeCookie(e, liveCookie(e));

    e.health.lastCheck = Date.now();

    // A network failure says nothing about the cookie — off VPN, Garage down.
    // Record the attempt and change no state; guessing here would switch live
    // read off every time the laptop briefly lost its connection.
    if(alive === null) return null;

    if(!alive){
      const wasEnabled = e.live.enabled;
      e.live.enabled   = false;
      e.live.lastError = `${e.label} session cookie has expired — time for a refresh.`;
      e.liveCache.clear();
      saveGarageFile();
      if(wasEnabled) warn(`${e.key} session cookie expired — live read switched off`);
      return false;
    }

    e.health.lastOk = Date.now();
    if(e.live.lastError){ e.live.lastError = null; saveGarageFile(); }
    return true;

  }finally{
    e.health.checking = false;
  }
}

function startCookieWatch(){
  const sweep = async () => {
    for(const e of Object.values(ENVS)){
      if(liveCookie(e)) await checkCookie(e).catch(() => {});
    }
  };
  // Shortly after boot as well as on the interval, so a cookie that died
  // overnight is reported before the first sweep rather than after it.
  setTimeout(sweep, 8_000).unref?.();
  setInterval(sweep, CONFIG.cookieCheckMs).unref?.();
}

/* Shape the admin panel reads for one environment. */
function liveStatusOf(e){
  return {
    env       : e.key,
    label     : e.label,
    configured: Boolean(liveCookie(e)),
    cookieSource: liveCookieSource(e),
    enabled   : Boolean(e.live.enabled),
    ready     : liveReady(e),
    lastError : e.live.lastError || null,
    // Health, for the activity indicator in the admin panel.
    lastCheck : e.health.lastCheck,
    lastOk    : e.health.lastOk,
    lastRead  : e.health.lastRead,
    checkEvery: CONFIG.cookieCheckMs
  };
}

function envSummary(){
  return {
    current: currentEnvKey,
    forced : ENV_FORCED,
    environments: Object.values(ENVS).map(e => ({
      key          : e.key,
      label        : e.label,
      garageUrl    : e.garageUrl,
      authenticated: isAuthed(e),
      live         : liveStatusOf(e)
    }))
  };
}

/* ───────────────────────────── Microsoft Teams ─────────────────────────────
   Posts to a Power Automate flow using the "When a Teams webhook request is
   received" trigger. That is the supported route now that Microsoft has
   retired the old Office 365 incoming-webhook connectors.

   The call is made here rather than from the browser for two reasons: the
   flow URL contains a signature and shouldn't sit in client-side JavaScript,
   and Power Automate doesn't return CORS headers, so fetch() from the page
   would be blocked anyway.                                                  */

let teams = readJson(CONFIG.teamsFile) || { url: process.env.TEAMS_WEBHOOK_URL || "", alerted: {} };
if(process.env.TEAMS_WEBHOOK_URL) teams.url = process.env.TEAMS_WEBHOOK_URL;

/* Master switch, independent of whether a webhook is configured. Clearing the
   URL also stops alerts, but it throws the configuration away — this is the
   mute button: keep the flow wired up, just stop posting to it. Defaults to
   on so an existing install behaves exactly as before. */
if(typeof teams.muted !== "boolean") teams.muted = false;

/* Email is a channel that can be switched off on its own, separately from the
   global mute. Mute stops everything for a while; this says "never deliver by
   email", which is the difference between a quiet afternoon and a decision.

   Held here rather than in localStorage because the send happens server-side:
   a switch in one browser must stop the mail, not just stop that tab asking
   for it. Seeded from the env vars on first run only. */
if(typeof teams.emailEnabled !== "boolean") teams.emailEnabled = CONFIG.alertEmailEnabled;
if(typeof teams.emailTo !== "string")       teams.emailTo      = CONFIG.alertEmailTo;

const teamsConfigured = () => Boolean(teams.url);

/* Accepts what a person actually pastes — commas, semicolons, newlines, and
   "Name <addr@x.com>" straight out of Outlook — and returns clean addresses.
   Deliberately a loose shape check, not RFC 5322: the goal is to catch a typo
   and a truncated paste, and Exchange is the real authority on the rest. */
function parseRecipients(raw){
  const parts = String(raw || "").split(/[,;\r\n]+/).map(s => s.trim()).filter(Boolean);
  const good = [], bad = [];
  for(const p of parts){
    // Unwrap a display-name form so pasting from Outlook's To: field works.
    const addr = (p.match(/<([^>]+)>/) || [null, p])[1].trim();
    (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? good : bad).push(addr);
  }
  // De-duplicated case-insensitively — the same person twice sends twice.
  const seen = new Set();
  return { good: good.filter(a => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase())), bad };
}

/* Blank is legitimate and means "my own mailbox", resolved from the Outlook
   profile at send time — so an empty list is not an unconfigured one. */
const emailReady = () => teams.emailEnabled;

function saveTeams(){
  // Drop stale dedupe entries so the file doesn't grow without bound.
  const cutoff = Date.now() - CONFIG.teamsDedupeMs;
  for(const [vin, at] of Object.entries(teams.alerted || {})){
    if(at < cutoff) delete teams.alerted[vin];
  }
  writeJson(CONFIG.teamsFile, teams);
}

/* Adaptive Card in the envelope the Workflows trigger forwards verbatim. */
function chargeCompleteCard({ vin, usoe, limit, readingAt, envLabel }){
  // Labelled SOC because that is what people say, but the value is USOE —
  // see the USOE lookup section for why the two are not interchangeable.
  // `readingAt` is still carried in the flat fields below for the flow.
  const facts = [
    { title: "SOC",    value: `${Number(usoe).toFixed(1)}%` },
    { title: "Target", value: `${Number(limit).toFixed(1)}%` }
  ];
  // Only ever stated when it isn't production, so the ordinary card is
  // unchanged and an engineering card can't be mistaken for a real one.
  if(envLabel && envLabel !== "Production") facts.push({ title: "Environment", value: envLabel });

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: [
          { type: "ColumnSet", columns: [
            { type: "Column", width: "auto", items: [
              { type: "TextBlock", text: "⚡", size: "ExtraLarge", spacing: "None" }]},
            { type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "Charging complete", weight: "Bolder",
                size: "Medium", color: "Good", spacing: "None" },
              { type: "TextBlock", text: "Charging Tracker | Powered by Zo' Projects",
                isSubtle: true, size: "Small", spacing: "None", wrap: true }]}
          ]},
          { type: "TextBlock", text: vin, size: "Large", weight: "Bolder",
            wrap: true, fontType: "Monospace", spacing: "Medium" },
          { type: "FactSet", facts }
        ]
      }
    }],
    // Flat copies so a hand-built flow can read the values directly.
    event: "charge_complete", vin, usoe, limit, readingAt, environment: envLabel || null
  };
}

/* Charge finished but the connector is still latched — the car is occupying a
   stall it no longer needs. Same envelope as the completion card so an
   existing flow renders it with no changes, but coloured Attention (red) and
   headed differently, because this one is asking someone to go and do
   something rather than reporting good news.

   `reminderIndex` counts up across repeats, and is what stops the dedupe in
   /api/notify from swallowing the second and subsequent reminders. */
function stillLatchedCard({ vin, usoe, limit, readingAt, envLabel, reminderIndex, minutes }){
  const facts = [
    { title: "SOC",    value: `${Number(usoe).toFixed(1)}%` },
    { title: "Target", value: `${Number(limit).toFixed(1)}%` },
    { title: "Status", value: "Charge complete · still latched" }
  ];
  if(Number.isFinite(minutes) && minutes > 0){
    facts.push({ title: "Latched for", value: minutes < 60
      ? `${Math.round(minutes)} min`
      : `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` });
  }
  if(envLabel && envLabel !== "Production") facts.push({ title: "Environment", value: envLabel });

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: [
          { type: "ColumnSet", columns: [
            { type: "Column", width: "auto", items: [
              { type: "TextBlock", text: "🔌", size: "ExtraLarge", spacing: "None" }]},
            { type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "Still plugged in", weight: "Bolder",
                size: "Medium", color: "Attention", spacing: "None" },
              { type: "TextBlock", text: "Charging Tracker | Powered by Zo' Projects",
                isSubtle: true, size: "Small", spacing: "None", wrap: true }]}
          ]},
          { type: "TextBlock", text: vin, size: "Large", weight: "Bolder",
            wrap: true, fontType: "Monospace", spacing: "Medium" },
          { type: "TextBlock", color: "Attention", wrap: true, spacing: "Small",
            text: "This vehicle finished charging and is still latched to the Supercharger. "
                + "Reminders repeat until it is unplugged." },
          { type: "FactSet", facts }
        ]
      }
    }],
    event: "still_latched", vin, usoe, limit, readingAt,
    reminderIndex: reminderIndex || 1, environment: envLabel || null
  };
}

/* A free-text message, for the admin test button. Carries the text both as an
   Adaptive Card and as a flat `text` field, so a flow can bind to whichever
   shape it already reads. */
function plainMessage(text){
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "Charging Tracker | Powered by Zo' Projects",
            isSubtle: true, size: "Small", spacing: "None", wrap: true },
          { type: "TextBlock", text, wrap: true, spacing: "Small" }
        ]
      }
    }],
    event: "test_message", text
  };
}

async function postToTeams(payload){
  if(!teamsConfigured()) throw new Error("No Teams webhook configured");

  const url = teams.url.trim();
  if(!/^https:\/\//i.test(url)) throw new Error("Teams webhook URL must be https");

  const body = JSON.stringify(payload);
  const res = await request(url, {
    method : "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    body
  });

  // Power Automate answers 200 or 202 on success.
  if(res.status >= 400){
    throw new Error(`Teams webhook returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return res.status;
}

/* ───────────────────────────── Outlook transport ─────────────────────────────
   Sends the alert as an ordinary email from the local Outlook client, for a
   Power Automate flow triggered by "When a new email arrives (V3)" with a
   subject filter. The flow then posts to Teams over its own connection.

   Why this exists: the tenant disables SAS auth on flow HTTP triggers, so the
   webhook route answers 401 DirectApiInvalidAuthorizationScheme, and an Entra
   app registration needs an admin. This needs neither.

   Why COM rather than SMTP: mail.teslamotors.com blackholes 25 / 587 / 465, so
   Node cannot send directly. Outlook already holds an authenticated Exchange
   session — handing the message to the client reuses it, so there is no second
   credential anywhere in this path.

   Values reach PowerShell as environment variables, never interpolated into
   the script text, so a VIN can never be read as code.                       */

const PS_SEND = `
$ErrorActionPreference = 'Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')

$to = $env:CT_TO
if (-not $to) {
  try { $to = $ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress } catch {}
}
if (-not $to) {
  try { $to = $ns.Accounts.Item(1).SmtpAddress } catch {}
}
if (-not $to) { throw 'No destination address could be read from the Outlook profile' }

$mail = $ol.CreateItem(0)
$mail.To      = $to
$mail.Subject = $env:CT_SUBJECT
$mail.Body    = $env:CT_BODY
$mail.Send()
Write-Output $to
`;

/* Readable for a human reading the mailbox, with a delimited JSON block so the
   flow can parse exact values instead of scraping the subject line. */
function alertEmailBody(f){
  if(f.text){
    return [f.text, "", "Sent by Charging Tracker.", "", "--CT-JSON--",
            JSON.stringify({ event: "test_message", text: f.text }),
            "--CT-END--"].join("\r\n");
  }

  const lines = f.stillLatched
    ? ["STILL PLUGGED IN.",
       "",
       "This vehicle finished charging and is still latched to the Supercharger.",
       ""]
    : ["Charging complete.", ""];

  lines.push(
    `VIN       ${f.vin}`,
    `USOE      ${Number(f.usoe).toFixed(1)}%`,
    `Target    ${Number(f.limit).toFixed(1)}%`
  );
  if(f.stillLatched) lines.push(`Reminder  #${f.reminderIndex || 1}`);
  if(f.envLabel && f.envLabel !== "Production") lines.push(`Env       ${f.envLabel}`);
  if(f.readingAt) lines.push(`Reported  ${String(f.readingAt).replace("T", " ")} UTC`);

  lines.push("", "Sent by Charging Tracker.", "", "--CT-JSON--",
    JSON.stringify({ event: f.stillLatched ? "still_latched" : "charge_complete",
                     vin: f.vin, usoe: f.usoe, limit: f.limit,
                     readingAt: f.readingAt || null,
                     reminderIndex: f.stillLatched ? (f.reminderIndex || 1) : undefined,
                     environment: f.envLabel || null }),
    "--CT-END--");
  return lines.join("\r\n");
}

function sendViaOutlook(f){
  if(process.platform !== "win32"){
    return Promise.reject(new Error("The Outlook transport requires Windows"));
  }

  const subject = f.text
    ? `${CONFIG.alertSubjectTag} test message`
    : f.stillLatched
      ? `${CONFIG.alertSubjectTag} ${f.vin} STILL LATCHED (reminder ${f.reminderIndex || 1})`
      : `${CONFIG.alertSubjectTag} ${f.vin} complete ` +
        `${Number(f.usoe).toFixed(1)}/${Number(f.limit).toFixed(1)}`;

  return new Promise((resolve, reject) => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
       "-EncodedCommand", Buffer.from(PS_SEND, "utf16le").toString("base64")],
      {
        timeout: 60_000,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          // Semicolons: what Outlook's To field expects. Blank leaves the
          // PowerShell fallback to read your own address from the profile.
          CT_TO     : parseRecipients(teams.emailTo).good.join("; "),
          CT_SUBJECT: subject,
          CT_BODY   : alertEmailBody(f)
        })
      },
      (err, stdout, stderr) => {
        if(err){
          const detail = String(stderr || err.message).trim().split(/\r?\n/)[0];
          // The classic failure here is Outlook's programmatic-access guard,
          // which blocks .Send() rather than the COM object itself.
          return reject(new Error(
            /denied|programmatic|guard/i.test(detail)
              ? `Outlook blocked the send (programmatic access): ${detail}`
              : `Outlook send failed: ${detail}`));
        }
        resolve(String(stdout).trim() || "sent");
      });
  });
}

/* ───────────────────────────── Alert dispatch ───────────────────────────── */

function activeTransport(){
  if(CONFIG.transport === "webhook" || CONFIG.transport === "outlook") return CONFIG.transport;
  return teamsConfigured() ? "webhook" : "outlook";
}

/* Whether an alert has anywhere to go AND is allowed to go there. Two separate
   gates sit in front of every send: the email switch, which disables one
   transport permanently, and the mute switch, which disables all of them for
   a while. The Outlook transport needs no setup beyond a working Outlook
   profile, so once enabled it is always considered ready. */
const alertsEnabled = () =>
  !teams.muted && (activeTransport() === "outlook" ? emailReady() : teamsConfigured());

async function deliverAlert(f){
  if(activeTransport() === "outlook") return sendViaOutlook(f);
  if(f.text)      return postToTeams(plainMessage(f.text));
  if(f.stillLatched) return postToTeams(stillLatchedCard(f));
  return postToTeams(chargeCompleteCard(f));
}

/* ───────────────────────────── HTTP server ───────────────────────────── */

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
               ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".ico":"image/x-icon",
               ".json":"application/json; charset=utf-8", ".png":"image/png" };

function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    // Same-origin in normal use; permissive so you can open index.html
    // straight from the filesystem and still reach this proxy.
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function readBodyOf(req){
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
  });
}

function sendHtml(res, status, html){
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/* Credential files, whichever environment they belong to, are never served.
   Matched by prefix rather than by an exact list so a future .tokens.<env>
   cannot be exposed by being forgotten here. */
const SECRET_FILE = /(^|[\\/])\.(tokens|client|teams|garage)(\.[a-z0-9]+)?\.json$/i;

function serveStatic(req, res, pathname){
  const rel  = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(__dirname, rel);

  // Never serve outside the project directory, or the credential files.
  if(!file.startsWith(__dirname) || SECRET_FILE.test(file)){
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if(err){ res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const p = url.pathname;

  if(req.method === "OPTIONS"){
    res.writeHead(204, {
      "Access-Control-Allow-Origin" : "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type"
    });
    return res.end();
  }

  /* ── environment: read / switch ── */
  if(p === "/api/env"){
    if(req.method === "GET") return sendJson(res, 200, envSummary());

    if(req.method === "POST"){
      if(ENV_FORCED){
        return sendJson(res, 409, {
          error: `Environment is pinned to ${env().label} by GARAGE_ENV — unset it to switch from the dashboard.`,
          ...envSummary()
        });
      }
      const want = String((await readBodyOf(req)).env || "").trim();
      if(!envByKey(want)) return sendJson(res, 400, { error: `Unknown environment "${want}"` });

      if(want !== currentEnvKey){
        currentEnvKey = want;
        saveGarageFile();
        log("environment switched to", env().label, `(${env().garageUrl})`);
      }
      return sendJson(res, 200, envSummary());
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── USOE for one VIN ── */
  if(p === "/api/usoe"){
    const vin = (url.searchParams.get("vin") || "").trim().toUpperCase();
    if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)){
      return sendJson(res, 400, { error: "A valid 17-character VIN is required" });
    }
    // Pinned for the duration of the call so a switch mid-sweep can never
    // attribute one environment's reading to the other.
    const e = env();

    // The page asks for a live read only where it is worth 140 KB — normally
    // a vehicle close to its limit. Any live failure falls through to the
    // cached path, so this can never make the dashboard worse than before.
    const wantLive = url.searchParams.get("live") === "1";

    try{
      let r = null, liveError = null;

      if(wantLive && liveReady(e)){
        try{ r = await getLiveUsoe(e, vin); }
        catch(err){ liveError = err.message; }
      }
      if(!r) r = await getUsoe(e, vin);

      return sendJson(res, 200, {
        vin,
        env      : e.key,
        usoe     : r.usoe,
        soc      : r.soc ?? null,
        // Both null on the cached path — the live dump is the only place
        // charge-port and pack-current readings exist.
        proximity: r.proximity ?? null,
        packAmps : r.packAmps ?? null,

        // FAST_CHARGE / LINE_CHARGE / NONE. On the live path this is the
        // vehicle's own CP_pilot; on the cached path it is inferred from
        // which kWh counter moved. pilotSource says which, so the page can
        // tell a measurement from an inference.
        //
        // A successful live read is authoritative and is NOT second-guessed
        // against the counters: the car is awake and reporting, so "NONE"
        // genuinely means nothing is plugged in.
        pilot      : r.pilot ?? null,
        pilotSource: r.pilot ? (r.live ? "live" : "counters") : null,
        readingAt: r.readingAt,      // when the vehicle actually reported it

        // The vehicle's own last snapshot interval, cached path only. The page
        // uses it to settle charging/idle on a FIRST reading, where it has no
        // baseline of its own yet. Null on the live path, which does not need
        // it — a live read carries the charge port and answers the question
        // outright.
        prevUsoe  : r.prevUsoe ?? null,
        prevAt    : r.prevAt ?? null,
        histSpanMs: r.histSpanMs ?? null,

        samples  : r.samples ?? null,
        live     : Boolean(r.live),
        liveError,
        source   : r.live ? "garage:live" : "garage:USOE",
        ts       : Date.now()
      });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }

  /* ── geofence lookup, batched ── */
  if(p === "/api/geofence" && req.method === "POST"){
    const body = await readBodyOf(req);
    const vins = (Array.isArray(body.vins) ? body.vins : [])
      .map(v => String(v).trim().toUpperCase())
      .filter(v => /^[A-HJ-NPR-Z0-9]{17}$/.test(v));

    if(!vins.length) return sendJson(res, 400, { error: "Provide a vins array" });

    const e = env();
    try{
      return sendJson(res, 200, { env: e.key, results: await getGeofences(e, vins) });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }

  /* ── scheduled deliveries for a date ── */
  if(p === "/api/deliveries" && req.method === "POST"){
    const body = await readBodyOf(req);
    const date = String(body.date || "").trim();
    const trt  = parseInt(body.trt, 10);

    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){
      return sendJson(res, 400, { error: "Provide date as YYYY-MM-DD" });
    }
    if(!Number.isFinite(trt)){
      return sendJson(res, 400, { error: "Provide a numeric trt" });
    }

    const e = env();
    try{
      const { vehicles, matched, redacted } = await getDeliveries(e, trt, date);

      /* Empty is ambiguous on its own, so never report it without saying why.
         Redaction is already provable from the primary query; anything else
         needs the probes. */
      let reason = null, probe = null;
      if(vehicles.length === 0){
        if(redacted > 0 || matched > 0){
          reason = "redacted";
        }else{
          probe  = await diagnoseEmptyDeliveries(e, trt);
          reason = probe.reason;
        }
      }

      const noAccess = reason === "redacted" ||
                       reason === "noDeliveryVisibility" ||
                       reason === "trtInvisible";

      if(noAccess){
        warn(`deliveries (${e.key}): TRT ${trt} on ${date} returned nothing readable —`,
             reason === "redacted"
               ? `matched ${matched}, all rows redacted (no delivery visibility)`
               : reason === "noDeliveryVisibility"
                 ? `${probe.anyVehicle} vehicles visible at this TRT but no delivery records`
                 : `nothing visible at this TRT at all — wrong site, or broad access limit`);
      }

      return sendJson(res, 200, {
        env  : e.key,
        date, trt,
        count: vehicles.length,
        matched, redacted, noAccess, reason,
        probe,
        vehicles
      });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }

  /* ── low-SoC lookup ── */
  if(p === "/api/lowsoc" && req.method === "POST"){
    const body = await readBodyOf(req);

    const trts = (Array.isArray(body.trts) ? body.trts : [])
      .map(t => parseInt(t, 10))
      .filter(Number.isFinite);
    // Whitelist, not passthrough: types go straight into a Lucene query, so an
    // unknown value is rejected rather than interpolated.
    const types = (Array.isArray(body.types) ? body.types : [])
      .map(t => String(t).trim())
      .filter(t => VEHICLE_TYPES.includes(t));
    let maxUsoe = Number(body.maxUsoe);
    if(!Number.isFinite(maxUsoe)) maxUsoe = 25;
    maxUsoe = Math.max(0, Math.min(100, maxUsoe));

    if(!trts.length)  return sendJson(res, 400, { error: "Provide at least one numeric trt" });
    if(!types.length) return sendJson(res, 400, { error: "Provide at least one known vehicle type" });

    const e = env();
    try{
      const vehicles = await getLowSoc(e, trts, types, maxUsoe);
      return sendJson(res, 200, { env: e.key, trts, types, maxUsoe, count: vehicles.length, vehicles });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }

  /* ── TRT geofence scan (Active Mode) ── */
  if(p === "/api/trtscan" && req.method === "POST"){
    const body = await readBodyOf(req);
    const trt  = parseInt(body.trt, 10);
    if(!Number.isFinite(trt)) return sendJson(res, 400, { error: "Provide a numeric trt" });

    /* Omitting `types` scans the whole lot (engineering's behaviour, unchanged).
       Supplying them filters to undelivered cars of those types — production.
       Validated against the same whitelist getLowSoc uses, so nothing a caller
       sends can reach the Lucene query as-is. */
    let types = [];
    if(body.types != null){
      if(!Array.isArray(body.types)){
        return sendJson(res, 400, { error: "types must be an array" });
      }
      types = body.types.map(t => String(t).trim()).filter(Boolean);
      const bad = types.filter(t => !VEHICLE_TYPES.includes(t));
      if(bad.length){
        return sendJson(res, 400, {
          error: `Unknown vehicle_type: ${bad.join(", ")}`, allowed: VEHICLE_TYPES });
      }
      if(!types.length) return sendJson(res, 400, { error: "types was empty" });
    }

    const e = env();
    try{
      const { vins, rows, total, rawRows, filtered, offsite } = await getTrtVins(e, trt, { types });
      return sendJson(res, 200, { env: e.key, trt, count: vins.length, total, rawRows,
                                  filtered, offsite, types, vins, rows });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }


  /* ── Live vitals: status / configure / test ──
     Always operates on the CURRENT environment, so the admin panel edits the
     cookie for whichever Garage is selected and can never cross-write. */
  if(p === "/api/live" || p === "/api/live/test" || p === "/api/live/check"){
    const e = env();

    if(p === "/api/live" && req.method === "GET"){
      return sendJson(res, 200, liveStatusOf(e));
    }

    /* Only the toggle now. The cookie itself comes from the Hub, so there is
       nothing here to set — and the guard below asks liveCookie() rather than
       the local field, or live read could never be switched on at all. */
    if(p === "/api/live" && req.method === "POST"){
      const b = await readBodyOf(req);

      if(typeof b.enabled === "boolean") e.live.enabled = b.enabled;

      if(e.live.enabled && !liveCookie(e)){
        e.live.enabled = false;
        saveGarageFile();
        return sendJson(res, 400, {
          error: `No ${e.label} Garage session — sign in on the Zo Projects Hub before turning live read on` });
      }

      saveGarageFile();
      return sendJson(res, 200, liveStatusOf(e));
    }

    /* An immediate cookie probe, so opening the panel shows current truth
       rather than whatever the last scheduled check found. */
    if(p === "/api/live/check" && req.method === "POST"){
      const ok = await checkCookie(e);
      return sendJson(res, 200, Object.assign({ ok }, liveStatusOf(e)));
    }

    if(p === "/api/live/test" && req.method === "POST"){
      const b   = await readBodyOf(req);
      const vin = String(b.vin || "").trim().toUpperCase();

      if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)){
        return sendJson(res, 400, { error: "Provide a VIN to test against" });
      }
      // Deliberately independent of the enabled flag, so a cookie can be
      // verified before switching live read on.
      try{
        const out = await getLiveUsoe(e, vin);
        return sendJson(res, 200, {
          ok: true, vin, env: e.key, usoe: out.usoe, soc: out.soc, readingAt: out.readingAt
        });
      }catch(err){
        return sendJson(res, 502, { error: err.message, env: e.key });
      }
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── Teams: status / configure / test / notify ── */
  if(p.startsWith("/api/teams") || p === "/api/notify"){
    const readBody = () => readBodyOf(req);

    if(p === "/api/teams" && req.method === "GET"){
      const u = teams.url || "";
      return sendJson(res, 200, {
        configured: alertsEnabled(),
        // Distinct from `configured`: a webhook can be set up perfectly and
        // still be muted, and the panel needs to say which of the two it is.
        hasTarget : activeTransport() === "outlook" ? emailReady() : teamsConfigured(),
        muted     : Boolean(teams.muted),
        transport : activeTransport(),
        // Never echo the signature back to the page.
        preview: u ? u.replace(/^(https:\/\/[^/]+\/).*$/, "$1…") : "",
        fromEnv: Boolean(process.env.TEAMS_WEBHOOK_URL),

        // Recipients are not a secret the way the webhook signature is, so
        // unlike `preview` these come back in full — the point of the field
        // is to see and correct who is on the list.
        emailEnabled  : Boolean(teams.emailEnabled),
        emailTo       : teams.emailTo || "",
        emailRecipients: parseRecipients(teams.emailTo).good,
        emailFromEnv  : Boolean(process.env.ALERT_EMAIL_TO)
      });
    }

    if(p === "/api/teams" && req.method === "POST"){
      const bodyJson = await readBody();

      // The mute switch and the URL are set independently, so a body carrying
      // only { muted } must not blank the webhook.
      if(typeof bodyJson.muted === "boolean"){
        teams.muted = bodyJson.muted;
        saveTeams();
        log("alerts", teams.muted ? "muted" : "unmuted");
      }

      if(typeof bodyJson.url === "string"){
        const url = bodyJson.url.trim();
        if(url && !/^https:\/\//i.test(url)){
          return sendJson(res, 400, { error: "URL must start with https://" });
        }
        teams.url = url;
        saveTeams();
      }

      // Same independence as the mute switch: a body carrying only the
      // recipients must not silently flip the channel on, and vice versa.
      if(typeof bodyJson.emailEnabled === "boolean"){
        teams.emailEnabled = bodyJson.emailEnabled;
        saveTeams();
        log("email alerts", teams.emailEnabled ? "enabled" : "disabled");
      }

      if(typeof bodyJson.emailTo === "string"){
        const { good, bad } = parseRecipients(bodyJson.emailTo);
        // Rejected outright rather than dropped quietly: a mistyped address
        // saved as "4 of 5 recipients" is a person who never gets told.
        if(bad.length){
          return sendJson(res, 400, {
            error: `Not a valid email address: ${bad.slice(0, 3).join(", ")}` +
                   (bad.length > 3 ? ` (+${bad.length - 3} more)` : "")
          });
        }
        teams.emailTo = good.join("; ");
        saveTeams();
        log("email recipients:", good.length ? good.join(", ") : "(own mailbox)");
      }

      return sendJson(res, 200, {
        configured  : alertsEnabled(),
        hasTarget   : activeTransport() === "outlook" ? emailReady() : teamsConfigured(),
        muted       : Boolean(teams.muted),
        emailEnabled: Boolean(teams.emailEnabled),
        emailTo     : teams.emailTo || ""
      });
    }

    if(p === "/api/teams/test" && req.method === "POST"){
      // Mute is overridden below, but the email switch is not. Mute means
      // "not right now"; email off means "not by email" — and a test button
      // that mailed anyway would be the exact behaviour the switch exists to
      // stop. Refuse with a reason instead of sending.
      if(activeTransport() === "outlook" && !emailReady()){
        return sendJson(res, 409, {
          error: "Email alerts are switched off, and email is the active transport — " +
                 "turn the switch back on, or configure a Teams webhook, to send a test."
        });
      }

      try{
        // Free text if the admin field had any, otherwise a sample card.
        const text = String((await readBody()).text || "").trim().slice(0, 2000);
        const status = await deliverAlert(text ? { text } : {
          vin: "TEST0000000000000", usoe: 80.4, limit: 80.0,
          readingAt: new Date().toISOString().slice(0, 19),
          envLabel: env().label
        });
        // Deliberately ignores the mute switch: pressing Send test is an
        // explicit request, and a test button that silently did nothing while
        // muted would be indistinguishable from a broken webhook.
        return sendJson(res, 200, { ok: true, status, transport: activeTransport(),
                                    mutedOverride: Boolean(teams.muted) });
      }catch(err){
        return sendJson(res, 502, { error: err.message });
      }
    }

    if(p === "/api/notify" && req.method === "POST"){
      const ev = await readBody();
      if(teams.muted) return sendJson(res, 200, { sent: false, reason: "muted" });
      if(!alertsEnabled()) return sendJson(res, 200, { sent: false, reason: "not configured" });

      const stillLatched = ev.event === "still_latched";
      if(ev.event !== "charge_complete" && !stillLatched){
        return sendJson(res, 200, { sent: false, reason: "ignored event" });
      }

      const vin = String(ev.vin || "").toUpperCase();
      if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return sendJson(res, 400, { error: "Invalid VIN" });

      // Dedupe per environment: the same VIN can legitimately exist in both,
      // and a production completion must not silence an engineering one.
      //
      // Latch reminders additionally key on the reminder number. That is what
      // lets reminder #2 through while still swallowing a duplicate #2 caused
      // by a page refresh — a plain per-VIN key would suppress every repeat
      // after the first and the reminders would stop.
      const e = env();
      const base = e.key === "prod" ? vin : `${e.key}:${vin}`;
      const key  = stillLatched
        ? `latched:${base}:${Number(ev.reminderIndex) || 1}`
        : base;

      const last = (teams.alerted || {})[key];
      if(last && Date.now() - last < CONFIG.teamsDedupeMs){
        return sendJson(res, 200, { sent: false, reason: "duplicate suppressed" });
      }

      try{
        await deliverAlert({
          vin, usoe: ev.usoe, limit: ev.limit, readingAt: ev.readingAt,
          envLabel: e.label,
          stillLatched,
          reminderIndex: Number(ev.reminderIndex) || 1,
          minutes: Number(ev.minutes) || null
        });
        teams.alerted = teams.alerted || {};
        teams.alerted[key] = Date.now();
        saveTeams();
        log(`Teams ${stillLatched ? "latch reminder" : "alert"} sent via ` +
            `${activeTransport()} (${e.key}):`, vin);
        return sendJson(res, 200, { sent: true });
      }catch(err){
        warn("Teams alert failed:", err.message);
        return sendJson(res, 502, { error: err.message });
      }
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── auth status ──
     Reports the current environment for the banner, and every environment so
     the admin panel can show both sign-in states at once. */
  if(p === "/api/auth/status"){
    const e = env();
    return sendJson(res, 200, {
      authenticated: isAuthed(e),
      env          : e.key,
      envLabel     : e.label,
      garage       : e.garageUrl,
      environments : envSummary().environments
    });
  }

  /* ── start sign-in ── */
  if(req.method !== "GET"){ res.writeHead(405); return res.end("Method not allowed"); }
  return serveStatic(req, res, p);
});

/* Minimal styled page for the OAuth round-trip. The accent follows the
   environment, matching the dashboard: red for production, yellow for
   engineering — so a sign-in tab is never ambiguous about which Garage it
   just authorised. */
function page(title, msg, ok, e){
  const accent = ok ? "#12BB6A" : (e && e.key === "eng" ? "#FFC61E" : "#E82127");
  const tag = e && e.key !== "prod"
    ? `<div class="tag">${e.label}</div>` : "";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  font:14px/1.6 Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:#171A20;color:#fff;text-align:center}
 .c{max-width:420px;padding:32px}
 .d{width:44px;height:44px;border-radius:50%;margin:0 auto 20px;background:${accent}}
 .tag{display:inline-block;margin:0 0 12px;padding:3px 10px;border-radius:11px;
   background:#FFC61E;color:#171A20;font-size:10px;font-weight:700;
   letter-spacing:.12em;text-transform:uppercase}
 h1{font-size:20px;font-weight:600;margin:0 0 8px;letter-spacing:-.01em}
 p{color:rgba(255,255,255,.66);margin:0 0 22px}
 a{display:inline-block;padding:11px 26px;border-radius:4px;background:#fff;color:#171A20;
   text-decoration:none;font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
</style>
<div class="c"><div class="d"></div>${tag}<h1>${title}</h1><p>${msg}</p>
<a href="http://localhost:${CONFIG.port}/">Open dashboard</a></div>`;
}

/* ───────────────────────────── Boot ───────────────────────────── */

function openBrowser(target){
  const cmd = process.platform === "win32" ? `start "" "${target}"`
            : process.platform === "darwin" ? `open "${target}"`
            : `xdg-open "${target}"`;
  exec(cmd, () => {});
}

server.listen(CONFIG.port, "127.0.0.1", async () => {
  const home = `http://localhost:${CONFIG.port}/`;
  const e = env();

  console.log("");
  log("Charging Tracker");
  log("dashboard :", home);
  log("environment:", `${e.label} — ${e.garageUrl}` + (ENV_FORCED ? "  (pinned by GARAGE_ENV)" : ""));

  for(const other of Object.values(ENVS)){
    // liveCookie, not other.live.cookie: the local field is no longer written
    // by anything, so reading it would report "no cookie" on an environment
    // the Hub has signed in perfectly well.
    log(`  ${other.key === currentEnvKey ? "▸" : " "} ${other.label.padEnd(11)}`,
        `${isAuthed(other) ? "signed in " : "signed out"}  ·  live read ` +
        (liveReady(other) ? "on" : liveCookie(other) ? "off (cookie saved)" : "off (no cookie)"));
  }

  log("reading   : USOE (usable state of energy)");
  log("alerts    :", teams.muted ? "MUTED (target still configured)"
    : activeTransport() === "outlook"
      ? (teams.emailEnabled
          ? `outlook → ${parseRecipients(teams.emailTo).good.join(", ") || "your own mailbox"} ` +
            `(subject ${CONFIG.alertSubjectTag})`
          : "OFF — email alerts switched off, and email is the only transport")
      : teamsConfigured() ? "teams webhook" : "off");
  log("cookie chk:", `every ${Math.round(CONFIG.cookieCheckMs / 60000)} min`);
  console.log("");

  startCookieWatch();

  if(isAuthed(e)){
    log(`${e.label} session cookie found — starting live`);
  }else{
    log(`no ${e.label} session — sign in on the Zo Projects Hub (http://localhost:3100)`);
    log("(you must be on the Tesla network / VPN)");
  }
  // Either way the dashboard opens: signed out it is still fully usable on
  // cached snapshots, and it says so on the page rather than in a terminal
  // nobody is reading.
  openBrowser(home);
});

process.on("unhandledRejection", err => warn("unhandled:", err && err.message ? err.message : err));

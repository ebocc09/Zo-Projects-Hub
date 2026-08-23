/* ─────────────────────────────── Tracker ───────────────────────────────

   Where an undelivered car is, and where it has been.

   ── the source, and why it is not the live read ──

   Garage's vehicle index carries `last_known_location`: latitude, longitude,
   a timestamp of its own, `gps_precision` and `transmission_mode`. It is
   projectable, so it comes back 100 VINs to a query and wakes nothing. The
   399 undelivered customer and inventory cars at Cypress are four queries.

   The obvious alternative is the live read — GET /vehicles/<id>/vitals, which
   Garage's own vitals tab uses. It was measured against the index, back to
   back, on 2026-08-23:

     7SAYGDED0TA762672   live 29.912598669,-95.615649458   index …598,…650   0.1 m
     7SAYGAEE7TF701488   live 32.780892,-96.663925         index …884,…929   1.0 m
     7SAYGDED0TA760467   live 29.881241,-95.585751         index …233,…747   1.0 m

   The index is the same fix, rounded to six decimals, trailing the live read
   by 0-117 seconds. A metre is nothing beside the ~17 m the fix wanders on a
   car that has not moved. The live read costs 141-156 KB and 1-2 seconds PER
   CAR: sweeping a centre that way is ten minutes and 55 MB to land within a
   metre of what four queries return in about one second.

   And it is not even a fallback. 7G2CEHED3SA059485, whose index fix was 3.8
   days old, answered the live read with HTTP 200, 4,012 fields, and no `lat`,
   no `lon` and no `show_gps_reason` at all. The cars stale in the index are
   cars not reporting GPS, full stop. There is nothing to ping.

   So the sweep is the index. The live read survives as the single-VIN
   "read it now" in lib.js, where its value is not accuracy but
   `show_gps_reason` — the only field anywhere that says WHY a car has no fix.

   ── there is no history, so this cannot backfill ──

   `last_known_location` is one object, overwritten in place. No history array,
   no previous-location field, nothing like it in the 4,616-field index.
   Datatank keeps a GPS history — gps_hdg, gps_accuracy, gps_elevation,
   valid_gps, last_gps, 50 snapshots a day — and carries NO latitude and NO
   longitude. That is the redaction, and it is why a path starts the moment
   tracking is switched on and can never be filled in backwards.

   What Datatank can still say is WHEN a car moved: `source: "drive_ended"`
   rows, and heading and elevation that change across them. `driveEvents()`
   below reads that, on demand, for one car — so a path with a hole in it can
   at least say a drive happened there.

   ── the two rules that keep a trail honest ──

   Measured over 94 cars polled every 20 s for 200 s:

     advanced at least once   10 of 94       (of 17 online: 8)
     gap between fixes        min -1697s  p25 12s  median 65s  p75 634s  max 4789s
     move between fixes       median 0.1 m  p90 92.6 m  max 96.3 m

   1. THE FIELD GOES BACKWARDS. That `-1697s` is real: a fix arrived 28 minutes
      older than the one it replaced, with `transmission_mode` flipping
      Transport -> Vitals mid-swap. Two channels write this field and they land
      out of order. Anything not STRICTLY newer than the last recorded point is
      rejected and counted, or trails walk backwards.

   2. A PARKED CAR DRIFTS. Median movement between consecutive fixes is 0.1 m,
      but one car wandered 17 m in 17 minutes standing still. `minMoveMetres`
      is compared against the last RECORDED point rather than the last fix
      seen, so slow drift accumulates against a fixed anchor instead of
      creeping unnoticed a metre at a time.

   Only ~10% of cars produce a new fix in any 200 s window, so sweeping faster
   than about a minute re-reads byte-identical rows. The default is 2 minutes.

   ── gps_precision 9999 is not garbage ──

   It appears on roughly one car in five, including one with a 27-second-old
   fix sitting exactly on the offsite lot. It means precision unreported, not
   position wrong. It rides on the point as an annotation and is NEVER a
   filter — filtering on it would silently drop a fifth of the fleet.

   ── what this module is ──

   A sibling to sca.js and os.js: self-contained, owns its store and its loop,
   and deleting it costs the board this tool and nothing else. It reaches
   Garage through functions handed to `init()` rather than requiring lib.js,
   because lib.js already requires this file and the other way round would be
   a cycle.                                                                  */

"use strict";

const fs   = require("fs");
const path = require("path");

const HERE  = __dirname;
const DIR   = path.join(HERE, ".tracker");
const STATE = path.join(DIR, "state.json");

/* ── injected Garage access ──
   lib.js owns every credential and every HTTP call. This module composes them
   and never opens a socket of its own. */
let G = null;

function init(deps){ G = deps; }

/* ─────────────────────────────── settings ─────────────────────────────── */

const DEFAULTS = {
  enabled       : false,
  everyMinutes  : 2,      // ~10% of cars advance in 200s; faster re-reads noise
  minMoveMetres : 50,     // clear of the 17 m drift measured on a parked car
  stopMinutes   : 20,
  retainDays    : 30
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function settings(){
  const t = (G.loadConnections().tracker) || {};
  return {
    enabled      : Boolean(t.enabled),
    everyMinutes : Math.max(1,  num(t.everyMinutes,  DEFAULTS.everyMinutes)),
    minMoveMetres: Math.max(5,  num(t.minMoveMetres, DEFAULTS.minMoveMetres)),
    stopMinutes  : Math.max(1,  num(t.stopMinutes,   DEFAULTS.stopMinutes)),
    retainDays   : Math.max(1,  num(t.retainDays,    DEFAULTS.retainDays))
  };
}

/* Only the keys this module owns, so a hand-edited file cannot smuggle
   anything else into .connections.json through the admin route. */
function saveSettings(patch){
  const cur  = settings();
  const next = {
    enabled      : "enabled"       in patch ? Boolean(patch.enabled)          : cur.enabled,
    everyMinutes : "everyMinutes"  in patch ? num(patch.everyMinutes,  cur.everyMinutes)  : cur.everyMinutes,
    minMoveMetres: "minMoveMetres" in patch ? num(patch.minMoveMetres, cur.minMoveMetres) : cur.minMoveMetres,
    stopMinutes  : "stopMinutes"   in patch ? num(patch.stopMinutes,   cur.stopMinutes)   : cur.stopMinutes,
    retainDays   : "retainDays"    in patch ? num(patch.retainDays,    cur.retainDays)    : cur.retainDays
  };
  G.saveConnections({ tracker: next });
  return settings();
}

/* ──────────────────────────────── the store ────────────────────────────────

   One file per VIN, rewritten only when that VIN's record actually changed.
   Points are appended only on real movement, so a lot standing still costs
   nothing: a parked car is one point for a week. A single combined file would
   mean rewriting the whole store on every sweep to record four moved cars.  */

function ensureDir(){ fs.mkdirSync(DIR, { recursive: true }); }

/* Temp-then-rename, like credstore's writeStore. A torn write here would not
   strand a session, but it would silently truncate a car's history, and a
   half-written path is worse than none because it still looks like a path. */
function writeJson(file, data){
  ensureDir();
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson(file){
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

const vinFile = vin => path.join(DIR, String(vin).toUpperCase() + ".json");

function readState(){
  return readJson(STATE) || {
    lastSweepAt: null, lastSweepMs: null, tracked: 0, points: 0,
    appended: 0, stale: 0, backwards: 0, noFix: 0, moved: 0, lastError: null
  };
}

const writeState = s => writeJson(STATE, s);

function readPath(vin){
  const r = readJson(vinFile(vin));
  if(!r || !Array.isArray(r.points)) return null;
  return r;
}

const writePath = rec => writeJson(vinFile(rec.vin), rec);

/* Every VIN the store holds. Anything that is not a 17-character .json is not
   ours — state.json included, which is why the name is tested rather than the
   extension stripped. */
function storedVins(){
  try{
    return fs.readdirSync(DIR)
      .filter(f => /^[A-HJ-NPR-Z0-9]{17}\.json$/.test(f))
      .map(f => f.slice(0, 17));
  }catch{ return []; }
}

function forgetAll(){
  let n = 0;
  for(const vin of storedVins()){
    try { fs.unlinkSync(vinFile(vin)); n++; } catch { /* already gone */ }
  }
  try { fs.unlinkSync(STATE); } catch { /* never swept */ }
  return { forgotten: n };
}

function forget(vin){
  try { fs.unlinkSync(vinFile(vin)); return { forgotten: 1 }; }
  catch { return { forgotten: 0 }; }
}

/* ─────────────────────────────── geometry ─────────────────────────────── */

const R_EARTH = 6371000;
const rad = d => d * Math.PI / 180;

function metresBetween(lat1, lon1, lat2, lon2){
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

const isFix = L => Boolean(L) &&
  Number.isFinite(Number(L.latitude)) && Number.isFinite(Number(L.longitude)) &&
  Number.isFinite(Number(L.timestamp));

/* ──────────────────────────── reading a path ────────────────────────────

   Stops are DERIVED here and never stored. A recorded point is a movement
   event — the car was reported here, having been somewhere else — so the
   dwell at point i is simply the gap to point i+1: how long it stayed before
   it next moved. Deriving rather than storing means retuning `stopMinutes`
   re-reads the whole history instead of needing it re-recorded, which is the
   same argument visibleRows() makes on the other tools.

   The last point has no successor, so its dwell runs to now and it is marked
   `open` — a car that is still standing where it last reported.            */

function legsOf(points){
  const out = [];
  for(let i = 1; i < points.length; i++){
    const a = points[i - 1], b = points[i];
    const m = metresBetween(a.lat, a.lon, b.lat, b.lon);
    const s = Math.max(1, b.t - a.t);
    const kph = (m / 1000) / (s / 3600);
    out.push({
      from: i - 1, to: i, metres: Math.round(m), seconds: s,
      kph: Math.round(kph),
      /* A car that reappears far away after a long silence was moved while
         asleep. The straight line between those two points is not a route it
         drove, so the map draws it dashed rather than asserting a journey. */
      gap: kph > 130 || s > 3600
    });
  }
  return out;
}

function stopsOf(points, stopMinutes, nowSec){
  const need = stopMinutes * 60;
  const out  = [];
  for(let i = 0; i < points.length; i++){
    const p    = points[i];
    const next = points[i + 1] || null;
    const departed = next ? next.t : null;
    const dwell    = (next ? next.t : nowSec) - p.t;
    if(dwell < need) continue;                 // a waypoint, not a stop
    out.push({
      index: i, lat: p.lat, lon: p.lon,
      /* "first reported here" rather than "arrived": sampling is sparse, so
         the car was almost certainly standing here before we heard about it,
         and claiming an arrival time we did not observe would be a lie the
         reader has no way to check. */
      firstReported: p.t,
      departed, dwell, open: !next,
      acc: p.acc == null ? null : p.acc, mode: p.mode || null
    });
  }
  return out;
}

function pathFor(vin, { nowSec = Math.floor(Date.now() / 1000) } = {}){
  const rec = readPath(vin);
  if(!rec) return null;

  const s     = settings();
  const pts   = rec.points || [];
  const legs  = legsOf(pts);
  const stops = stopsOf(pts, s.stopMinutes, nowSec);

  let travelled = 0, gapped = 0;
  for(const l of legs){ if(l.gap) gapped += l.metres; else travelled += l.metres; }

  return {
    ...rec,
    legs, stops,
    metresTravelled: travelled,
    metresGapped   : gapped,
    stopMinutes    : s.stopMinutes,
    minMoveMetres  : s.minMoveMetres
  };
}

/* ─────────────────────────────── the sweep ───────────────────────────────

   Scope is the configured centre, onsite and offsite, which is the same scope
   every other tool on this board uses. buildQuery() is reused rather than
   rebuilt: it already forces `delivered:false` where it cannot be unticked,
   and it already quotes hyphenated facet values, which is the trap that makes
   a bare vehicle_type:customer-vehicle match the wrong set.                */

const PAGE = 100;   // the endpoint's maximum

const FIELDS = ["vin", "id", "vpn_state", "delivered", "last_known_location",
                "model", "vehicle_type", "trt_id",
                "delivery_details.scheduled_delivery_date"];

function population(){
  return G.buildQuery({
    trtId       : G.savedTrtId(),
    offsiteTrtId: G.savedOffsiteTrtId(),
    sites       : "both",
    filters     : { vehicle_type: ["customer-vehicle", "inventory-vehicle"] }
  });
}

/* Paged here rather than through lib.js's tesladexPage, which sorts on
   delivery_date_epoch. Undelivered cars have no delivery date, so that sort
   is not stable across pages and deep paging would repeat and skip. `vin:asc`
   is total and stable. */
async function enumerate(query){
  const rows = [];
  for(let from = 0; ; from += PAGE){
    const page = await G.tesladexSearch({
      query, fields: FIELDS, size: PAGE, from, sort: "vin:asc"
    });
    const got = (page && page.results) || [];
    rows.push(...got);
    if(!got.length || !page || !page.has_more) break;
    if(from + PAGE >= 10000) break;      // Elasticsearch will not page past 10k
  }
  return rows;
}

let sweeping = false;

async function sweep({ log = () => {} } = {}){
  if(sweeping) return { skipped: "a sweep is already running" };

  const trt = G.savedTrtId();
  if(!trt){
    const err = new Error("No TRT set — choose a centre before enabling tracking");
    err.needsTrt = true;
    throw err;
  }

  sweeping = true;
  const t0    = Date.now();
  const now   = Math.floor(t0 / 1000);
  const s     = settings();
  const stat  = { tracked: 0, appended: 0, stale: 0, backwards: 0, noFix: 0,
                  moved: 0, fresh: 0, delivered: 0, offScope: 0 };

  try{
    const query = population();
    log(`tracker: sweeping ${query}`);
    const rows = await enumerate(query);
    stat.tracked = rows.length;

    const seen = new Set();

    for(const row of rows){
      const vin = String(row.vin || "").toUpperCase();
      if(!vin) continue;
      seen.add(vin);

      const rec = readPath(vin) || {
        vin, firstSeen: now, lastSeen: now, delivered: false, deliveredAt: null,
        offScope: false, lastFix: null, seenT: null, points: []
      };
      let dirty = false;

      /* `lastSeen` moves on every sweep but is NOT on its own a reason to
         rewrite the file. It would be 396 writes every two minutes — a
         quarter of a million a day — to record that a parked lot is still
         parked. Persisted when something else changed anyway, or hourly, so
         the field stays roughly true without the disk churn. */
      const wasSeen = rec.lastSeen || 0;
      rec.lastSeen = now;
      if(now - wasSeen > 3600) dirty = true;
      if(rec.offScope){ rec.offScope = false; dirty = true; }
      if(!rec.model      && row.model)        { rec.model = row.model;             dirty = true; }
      if(!rec.vehicleType && row.vehicle_type){ rec.vehicleType = row.vehicle_type; dirty = true; }
      rec.trtId    = row.trt_id == null ? null : row.trt_id;
      rec.vpnState = row.vpn_state || "";
      rec.deviceId = row.id == null ? rec.deviceId || null : String(row.id);
      const sched  = row.delivery_details && row.delivery_details.scheduled_delivery_date;
      if(sched && rec.scheduled !== sched){ rec.scheduled = sched; dirty = true; }

      const L = row.last_known_location;

      if(!isFix(L)){
        stat.noFix++;
        if(dirty) writePath(rec);
        continue;
      }

      const fix = {
        t   : Math.floor(Number(L.timestamp)),
        lat : Number(L.latitude),
        lon : Number(L.longitude),
        acc : L.gps_precision == null ? null : Number(L.gps_precision),
        mode: L.transmission_mode || null
      };

      const last = rec.points.length ? rec.points[rec.points.length - 1] : null;

      /* Rule 1. Anything not strictly newer than the last point recorded is
         dropped — but the ways that happens are counted apart, because they
         mean opposite things.

         `stale` is the ordinary case and by far the commonest: the field has
         not changed since the last sweep. Measured on a real sweep, 344 of
         396. This is also, for free, the asleep filter — a sleeping car lands
         here and costs one comparison.

         `backwards` is the pathology: the field CHANGED and the new value is
         older than a point already recorded. Measured at 1,697 seconds
         backwards, with transmission_mode flipping Transport -> Vitals
         mid-swap; two channels write this field and they land out of order.

         The comparison is against `seenT` — what the field held at the last
         sweep — and not against the last recorded point, and that distinction
         was a bug before it was a comment. Comparing to the point meant one
         backwards write was re-counted on every sweep for as long as the
         stale value sat there: the panel read "20 backwards" for twenty
         minutes and it was the same twenty cars, not twenty new faults. A
         counter that measures a state while claiming to measure an event is
         worse than no counter, because it looks like it is still happening. */
      const changed = rec.seenT == null || fix.t !== rec.seenT;
      if(rec.seenT !== fix.t){ rec.seenT = fix.t; dirty = true; }

      if(!changed){
        stat.stale++;
        if(dirty) writePath(rec);
        continue;
      }

      if(last && fix.t <= last.t){
        if(fix.t < last.t) stat.backwards++; else stat.stale++;
        if(dirty) writePath(rec);
        continue;
      }

      /* The freshest thing we know, recorded whether or not it becomes a
         point. The current position is the latest fix; the path ends at the
         last point that cleared the movement threshold, and conflating the
         two would put a car back where it was an hour ago. */
      if(!rec.lastFix || fix.t > rec.lastFix.t){ rec.lastFix = fix; dirty = true; stat.fresh++; }

      /* Rule 2. Distance is measured from the last RECORDED point, not from
         the last fix seen, so a car creeping a metre at a time still trips the
         threshold once it has genuinely gone somewhere. */
      if(last && metresBetween(last.lat, last.lon, fix.lat, fix.lon) < s.minMoveMetres){
        if(dirty) writePath(rec);
        continue;
      }

      rec.points.push(fix);
      stat.appended++;
      if(last) stat.moved++;
      writePath(rec);
    }

    /* ── cars that fell out of the population ──
       The query forces delivered:false, so a delivered car simply stops
       appearing. That is the signal, but it is not proof on its own: a car
       also disappears when it is retagged or routed elsewhere. So the ones
       that vanished are asked directly, and only `delivered:true` freezes a
       path. Anything else is marked off-scope and left alone rather than
       deleted — a car that comes back should come back to its history. */
    const missing = storedVins().filter(v => !seen.has(v) && !(readPath(v) || {}).delivered);
    for(let i = 0; i < missing.length; i += PAGE){
      const chunk = missing.slice(i, i + PAGE);
      const page  = await G.tesladexSearch({
        query : "vin:(" + chunk.join(" OR ") + ")",
        fields: ["vin", "delivered"],
        size  : chunk.length,
        sort  : "vin:asc"
      });
      const state = new Map();
      for(const r of (page.results || [])){
        if(r.vin) state.set(String(r.vin).toUpperCase(), Boolean(r.delivered));
      }
      for(const vin of chunk){
        const rec = readPath(vin);
        if(!rec) continue;
        if(state.get(vin) === true){
          rec.delivered   = true;
          rec.deliveredAt = now;
          stat.delivered++;
          writePath(rec);
        }else if(!rec.offScope){
          rec.offScope = true;
          stat.offScope++;
          writePath(rec);
        }
      }
    }

    prune(s.retainDays, now);

    const next = {
      lastSweepAt: now,
      lastSweepMs: Date.now() - t0,
      tracked    : stat.tracked,
      points     : totalPoints(),
      appended   : stat.appended,
      stale      : stat.stale,
      backwards  : stat.backwards,
      noFix      : stat.noFix,
      moved      : stat.moved,
      lastError  : null
    };
    writeState(next);

    log(`tracker: ${stat.tracked} cars · ${stat.fresh} fresh · ` +
        `${stat.appended} points (${stat.moved} moves) · ${stat.stale} nothing new · ` +
        `${stat.backwards} backwards · ${stat.noFix} no fix · ` +
        `${stat.delivered} delivered · ${next.lastSweepMs}ms`);

    return { ...stat, ms: next.lastSweepMs, query };
  }catch(err){
    const st = readState();
    st.lastError = err.message;
    writeState(st);
    log("tracker: " + err.message);
    throw err;
  }finally{
    sweeping = false;
  }
}

function totalPoints(){
  let n = 0;
  for(const vin of storedVins()){
    const r = readPath(vin);
    if(r) n += r.points.length;
  }
  return n;
}

/* A delivered car's path is kept for a while and then dropped. Garage stops
   publishing its coordinates at handover, so nothing here can grow after that
   point — this is housekeeping, not a policy about what may be looked at. */
function prune(retainDays, nowSec){
  const cutoff = nowSec - retainDays * 86400;
  let n = 0;
  for(const vin of storedVins()){
    const r = readPath(vin);
    if(r && r.delivered && r.deliveredAt && r.deliveredAt < cutoff){
      try { fs.unlinkSync(vinFile(vin)); n++; } catch { /* already gone */ }
    }
  }
  return n;
}

/* ──────────────────────────────── the loop ────────────────────────────────
   Modelled on startTeamsLoop: a short tick that asks whether a sweep is due,
   rather than an interval set to the sweep period. Changing the period then
   takes effect at the next tick instead of at the end of the current wait,
   and a sweep that overruns cannot stack up behind itself.                 */

const TICK_MS = 20000;
let timer = null;

async function tick(log){
  const s = settings();
  if(!s.enabled || sweeping) return;
  const st  = readState();
  const due = !st.lastSweepAt ||
              (Date.now() / 1000 - st.lastSweepAt) >= s.everyMinutes * 60;
  if(!due) return;
  try { await sweep({ log }); }
  catch { /* sweep already logged it and recorded lastError */ }
}

function start(log = () => {}){
  stop();
  if(!settings().enabled) return false;
  timer = setInterval(() => tick(log), TICK_MS);
  // unref so a tracking board still exits cleanly on Ctrl-C.
  if(timer.unref) timer.unref();
  return true;
}

function stop(){
  if(timer) clearInterval(timer);
  timer = null;
}

/* ─────────────────────────── what the panel asks ─────────────────────────── */

function status(){
  const s  = settings();
  const st = readState();
  const vins = storedVins();

  let points = 0, delivered = 0, withPath = 0;
  for(const vin of vins){
    const r = readPath(vin);
    if(!r) continue;
    points += r.points.length;
    if(r.delivered) delivered++;
    if(r.points.length) withPath++;
  }

  return {
    ...s,
    running   : Boolean(timer),
    sweeping,
    lastSweepAt: st.lastSweepAt, lastSweepMs: st.lastSweepMs,
    lastError  : st.lastError,
    nextSweepIn: st.lastSweepAt
      ? Math.max(0, Math.round(s.everyMinutes * 60 - (Date.now() / 1000 - st.lastSweepAt)))
      : 0,
    cars: vins.length, withPath, delivered, points,
    lastAppended : st.appended, lastStale: st.stale,
    lastBackwards: st.backwards, lastNoFix: st.noFix
  };
}

module.exports = {
  init, settings, saveSettings,
  sweep, start, stop, status,
  pathFor, readPath, storedVins, forget, forgetAll,
  metresBetween, DEFAULTS
};

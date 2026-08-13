#!/usr/bin/env node
/* DVP Scorecard — dashboard server.

   Thin. The measurement lives in lib.js. Mutating routes take the admin
   password; the xlsx upload does not (it is the primary interaction, and it
   writes nothing server-side beyond a transient in-memory job).             */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const L    = require("./lib");
const xlsx = require("./xlsx");
const { readScorecard } = require("./xlsx-read");

const PORT  = Number(process.env.PORT || L.CONFIG.port || 3130);
const INDEX = path.join(__dirname, "index.html");
const log   = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8",
                        "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}
function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => { b += c; if(b.length > 4e6) reject(new Error("body too large")); });
    req.on("end", () => { if(!b.trim()) return resolve({}); try { resolve(JSON.parse(b)); } catch { reject(new Error("bad JSON")); } });
    req.on("error", reject);
  });
}
function readRawBody(req, cap = 60e6){
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if(n > cap) return reject(new Error("file too large")); chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const authed = body => String(body.password || "") === L.adminPassword();
function sendErr(res, err){
  const code = err.needsTrt ? 400 : (err.needsCookie ? 401 : 502);
  sendJson(res, code, { error: err.message, needsCookie: !!err.needsCookie, needsTrt: !!err.needsTrt });
}

/* Single-slot job, like FSD Tracker: one operator, localhost, so a job table
   would be machinery for a situation that cannot arise. */
let JOB = null;
const jobStart = () => { JOB = { phase: "starting", startedAt: Date.now() }; };
const jobEnd   = () => { JOB = null; };
const jobUpd   = p => { if(JOB) Object.assign(JOB, p); };

/* The last compile, kept so the date-range filter can re-derive the board
   without going back to Intrepid. The expensive part is the ~1,000 status-log
   calls; narrowing a range is a filter over rows already in hand, so it should
   be instant rather than a second five-minute wait. Same single-slot reasoning
   as JOB — one operator, localhost. Lost on restart, which is correct: a stale
   board surviving a code change would be worse than re-uploading. */
let LAST = null;

/* Rows are shipped to the page without the survey columns the board derives
   server-side — just what the person panel and the range control need. */
const wireRows = rows => rows.map(r => ({
  rn: r.rn, vin: r.vin, score: r.score, model: r.model, date: r.date,
  finishedBy: r.finishedBy,
  handle: r.finishedBy ? r.finishedBy.split("@")[0] : null,
  /* The inspection outcome travels with the car so a catch can be traced to
     the VIN it was found on, and to the service visit it opened, rather than
     being a number on a leaderboard nobody can check. */
  vriBy: r.vriBy, vriFailed: r.vriFailed || false, serviceVisitId: r.serviceVisitId || null,
  vriAt: r.vriAt || null,
  /* The post-VRI ticket travels with its lag: a fault found the same day and
     one found eight months later are not the same claim about the inspection,
     and the rate alone cannot tell them apart. */
  ticketPostVri: r.ticketPostVri || false, ticketAt: r.ticketAt || null,
  ticketSv: r.ticketSv || null, ticketLagDays: r.ticketLagDays ?? null
}));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try{
    if(p === "/" || p === "/index.html"){
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(INDEX));
    }

    /* Client error beacon — a JS error on someone else's machine is invisible
       otherwise; this puts it in the server log. */
    if(p === "/api/clientlog" && req.method === "POST"){
      const body = await readJsonBody(req);
      log(`client [${String(body.level||"info").slice(0,8)}]`, String(body.msg||"").slice(0,400));
      res.writeHead(204).end();
      return;
    }

    if(p === "/api/state" && req.method === "GET"){
      const c = L.connectionsSummary();
      return sendJson(res, 200, {
        connections: c, trtId: c.trtId,
        today: new Date().toISOString().slice(0, 10),
        minCars: L.MIN_CARS
      });
    }

    if(p === "/api/progress" && req.method === "GET"){
      if(!JOB) return sendJson(res, 200, { running: false });
      return sendJson(res, 200, { running: true, elapsed: Math.round((Date.now() - JOB.startedAt) / 1000), ...JOB });
    }

    /* Site type-ahead for the centre picker. Reads the cached location
       directory, so it costs nothing after the first call. */
    if(p === "/api/sites" && req.method === "GET"){
      const q = (url.searchParams.get("q") || "").trim();
      if(q.length < 2) return sendJson(res, 200, { q, sites: [] });
      return sendJson(res, 200, { q, sites: await L.searchSites(q, 20) });
    }

    /* Resolve one TRT to its site, so a number typed straight in still shows a
       name rather than staying anonymous. */
    if(p === "/api/trt" && req.method === "GET"){
      const id = (url.searchParams.get("id") || "").trim();
      if(!/^\d+$/.test(id)) return sendJson(res, 400, { error: "TRT must be numeric" });
      return sendJson(res, 200, { trtId: Number(id), info: await L.trtInfo(id) });
    }

    /* Remember the delivery centre (persisted, like FSD Tracker's TRT). */
    if(p === "/api/trt" && req.method === "POST"){
      const body = await readJsonBody(req);
      const raw = body.trtId == null ? "" : String(body.trtId).trim();
      if(raw === ""){ L.saveConnections({ trtId: null }); return sendJson(res, 200, { ok: true, trtId: null }); }
      if(!/^\d+$/.test(raw)) return sendJson(res, 400, { error: "TRT must be numeric" });
      L.saveConnections({ trtId: Number(raw) });
      log(`trt -> ${raw}`);
      return sendJson(res, 200, { ok: true, trtId: Number(raw) });
    }

    /* Upload an xlsx (raw bytes) + ?trt= → compile the scorecard. */
    if(p === "/api/compile" && req.method === "POST"){
      const trtId = (url.searchParams.get("trt") || "").trim() || L.savedTrtId();
      if(!trtId) return sendJson(res, 400, { error: "Choose a delivery centre first", needsTrt: true });

      const buf = await readRawBody(req);
      let parsed;
      try { parsed = readScorecard(buf); }
      catch(err){ return sendJson(res, 400, { error: "Could not read that file — " + err.message }); }
      if(!parsed.rows.length) return sendJson(res, 400, { error: "No reference numbers found in the file" });

      jobStart();
      let out;
      try { out = await L.compile({ rows: parsed.rows, trtId, onProgress: jobUpd }); }
      catch(err){ jobEnd(); return sendErr(res, err); }
      finally { jobEnd(); }

      log(`compiled: ${out.stats.attributed}/${out.stats.scored} attributed across ${out.stats.dates} dates`);
      LAST = out;
      return sendJson(res, 200, {
        trtId: out.trtId, dates: out.dates, meta: parsed.meta,
        stats: out.stats, notices: out.notices, people: out.people, rank: out.rank, store: out.store,
        // per-car detail for drill-down; no customer PII, just RN/VIN/score/who
        rows: wireRows(out.rows)
      });
    }

    /* Narrow the compiled board to a date range. Pure re-derivation from rows
       already held — no Intrepid traffic, so it answers instantly. */
    if(p === "/api/range" && req.method === "GET"){
      if(!LAST) return sendJson(res, 409, { error: "Nothing compiled yet — upload a file first", needsUpload: true });
      const from = (url.searchParams.get("from") || "").trim();
      const to   = (url.searchParams.get("to")   || "").trim();
      const ok = s => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
      if(!ok(from) || !ok(to)) return sendJson(res, 400, { error: "Dates must be YYYY-MM-DD" });
      if(from && to && from > to) return sendJson(res, 400, { error: "The start date is after the end date" });

      // ISO dates compare correctly as strings, so no parsing is needed and no
      // timezone can shift a car onto the wrong side of a boundary.
      const rows = LAST.rows.filter(r =>
        r.date && (!from || r.date >= from) && (!to || r.date <= to));

      const out = L.summarise(rows, { uploaded: LAST.stats.uploaded });
      log(`range ${from || "start"}..${to || "end"} → ${rows.length} cars, ${out.people.length} people`);
      return sendJson(res, 200, {
        from: from || null, to: to || null,
        dates: LAST.dates.filter(d => (!from || d >= from) && (!to || d <= to)),
        allDates: LAST.dates, store: LAST.store, trtId: LAST.trtId,
        ...out, rows: wireRows(rows), notices: []
      });
    }

    /* Export the leaderboard as xlsx. */
    if(p === "/api/export" && req.method === "POST"){
      const body = await readJsonBody(req);
      const people = Array.isArray(body.people) ? body.people : [];
      if(!people.length) return sendJson(res, 400, { error: "Nothing to export" });
      const label = String(body.label || "dvp").replace(/[^0-9A-Za-z_.-]+/g, "-");
      const buf = xlsx.build({
        sheetName: "DVP Scorecard",
        columns: [
          { key: "rank",     header: "Rank", width: 6, type: "number", digits: 0 },
          { key: "handle",   header: "Prep person", width: 22 },
          { key: "email",    header: "Username", width: 24 },
          // Cleanliness ranking first, then the productivity block. Kept in
          // that order and apart, the way the dashboard reports them.
          { key: "contribution", header: "Contribution score", width: 17, type: "number", digits: 0 },
          { key: "cars",     header: "Cars surveyed", width: 14, type: "number", digits: 0 },
          { key: "productivity", header: "Productivity", width: 14, type: "number", digits: 0 },
          { key: "finished", header: "Cars finished", width: 14, type: "number", digits: 0 },
          { key: "washed",   header: "Cars washed", width: 14, type: "number", digits: 0 },
          { key: "vri",      header: "VRIs completed", width: 15, type: "number", digits: 0 },
          { key: "caught",   header: "Faults caught at VRI", width: 20, type: "number", digits: 0 },
          { key: "caughtPer100", header: "Caught per 100 VRIs", width: 19, type: "number", digits: 1 },
          { key: "missed",   header: "Tickets post-VRI", width: 17, type: "number", digits: 0 },
          { key: "missedPer100", header: "Post-VRI ticket %", width: 18, type: "number", digits: 1 },
          { key: "quality",  header: "Survey quality pts", width: 18, type: "number", digits: 0 },
          { key: "clean",    header: "Spotless cars", width: 14, type: "number", digits: 0 },
          { key: "adjusted", header: "Adjusted score", width: 16, type: "number", digits: 2 },
          { key: "mean",     header: "Raw mean %", width: 14, type: "number", digits: 1 },
          { key: "shrink",   header: "Adjustment", width: 12, type: "number", digits: 2 },
          { key: "dirty",    header: "Below 100%", width: 12, type: "number", digits: 0 },
          { key: "dirtyPer100", header: "Per 100 cars", width: 14, type: "number", digits: 1 },
          { key: "worst",    header: "Worst score %", width: 14, type: "number", digits: 0 }
        ],
        // "Prep person" is the full name where Garage knew it; the username
        // keeps its own column, so the sheet stays joinable on it either way.
        rows: people.map((p, i) => ({ rank: i + 1, handle: p.name || p.handle, email: p.email,
          cars: p.cars, contribution: p.contribution, productivity: p.productivity,
          finished: p.finished, quality: p.quality, washed: p.washed, vri: p.vri,
          caught: p.caught, caughtPer100: p.caughtPer100,
          missed: p.missed, missedPer100: p.missedPer100, clean: p.clean,
          adjusted: p.adjusted, mean: p.mean, shrink: p.shrink,
          dirty: p.dirty, dirtyPer100: p.dirtyPer100, worst: p.worst }))
      });
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="dvp-${label}.xlsx"`,
        "Content-Length": buf.length, "Cache-Control": "no-store"
      });
      return res.end(buf);
    }

    /* ── admin ── */
    if(p === "/api/admin/unlock" && req.method === "POST"){
      const body = await readJsonBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      return sendJson(res, 200, { ok: true, connections: L.connectionsSummary() });
    }

    if(p === "/api/admin/test" && req.method === "POST"){
      const body = await readJsonBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      return sendJson(res, 200, { intrepid: await L.testIntrepid(body.trtId ? String(body.trtId).trim() : null) });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }catch(err){ sendErr(res, err); }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`DVP Scorecard on http://localhost:${PORT}`);
  const c = L.connectionsSummary();
  log(`  intrepid ${c.intrepid.set ? "connected" : "NOT connected"} · TRT ${c.trtId || "unset"}`);
});

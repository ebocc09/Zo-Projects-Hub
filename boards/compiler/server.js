#!/usr/bin/env node
/* The Compiler — board server.

   Deliberately thin. Everything that knows what a service visit is lives in
   lib.js, so a second tool added to the board later cannot invent its own
   definition of the same thing.

   Mutating routes require the admin password. It is a shared house password
   and a guard against fat fingers rather than an attacker — but it is checked
   server-side all the same, because a client-only gate is no gate at all.  */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const L    = require("./lib");
const xlsx = require("./xlsx");

const PORT  = Number(process.env.PORT || L.CONFIG.port || 3130);
const INDEX = path.join(__dirname, "index.html");

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8",
                        "Content-Length": Buffer.byteLength(body),
                        "Cache-Control": "no-store" });
  res.end(body);
}

function sendXlsx(res, buf, label){
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${label}.xlsx"`,
    "Content-Length": buf.length,
    "Cache-Control": "no-store"
  });
  res.end(buf);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if(buf.length > 2e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if(!buf.trim()) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error("body was not JSON")); }
    });
    req.on("error", reject);
  });
}

const authed = body => String(body.password || "") === L.adminPassword();

/* The callback page echoes provider-supplied text, so it gets escaped. */
const escapeHtml = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ── progress ──
   A scan is one Garage query and then two Intrepid calls per vehicle, so a
   wide selection is minutes of work. A spinner with nothing behind it for
   that long reads as a hang, so the scan publishes where it is and the page
   polls for it.

   One slot, deliberately. This is a single-operator board bound to localhost;
   a job table would be machinery for a situation that cannot arise. A second
   scan simply takes the slot over. */
let JOB = null;

const jobStart = () => { JOB = { phase: "starting", startedAt: Date.now() }; };
const jobEnd   = () => { JOB = null; };

function jobUpdate(p){
  if(!JOB) return;
  // Phase names come straight from scanVehicles so the two cannot drift.
  JOB.phase = p.phase;
  if(p.total != null) JOB.total = p.total;
  if(p.done  != null) JOB.done  = p.done;
  if(p.got   != null) JOB.got   = p.got;
}

/* Errors carry a hint so the UI can point at the right fix rather than just
   printing a stack: a dead cookie and a dead Garage token need different
   actions from the person reading the screen. */
function sendErr(res, err){
  const code = err.needsTrt ? 400 : (err.needsCookie || err.needsAuth ? 401 : 502);
  sendJson(res, code, {
    error      : err.message,
    needsCookie: Boolean(err.needsCookie),
    needsAuth  : Boolean(err.needsAuth),
    needsTrt   : Boolean(err.needsTrt)
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p   = url.pathname;

  try{
    /* ── page ── */
    if(p === "/" || p === "/index.html"){
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
                           "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(INDEX));
    }

    /* ── client-side reporting ──
       A JavaScript error in someone else's browser is otherwise invisible:
       the page just stops doing things and the console is on their machine,
       not ours. This puts it in the server log where it can be read. */
    if(p === "/api/clientlog" && req.method === "POST"){
      const body = await readBody(req);
      log(`client [${String(body.level || "info").slice(0, 8)}]`,
          String(body.msg || "").slice(0, 500));
      res.writeHead(204).end();
      return;
    }

    /* ── current state, for first paint ── */
    if(p === "/api/state" && req.method === "GET"){
      const c = L.connectionsSummary();
      return sendJson(res, 200, {
        connections: c,
        trtId : c.trtId,
        trt   : c.trtId ? await L.trtInfo(c.trtId) : null,
        offsiteTrtId: L.savedOffsiteTrtId(),
        offsiteTrt  : L.savedOffsiteTrtId() ? await L.trtInfo(L.savedOffsiteTrtId()) : null,
        today : L.todayLocal(),
        // The filter menu is built from these rather than from a copy in the
        // page, so a value the index stops using is removed in one place.
        facets: L.FACETS,
        kinds : L.HOLD_KINDS,
        cap   : L.SCAN_CAP,
        // Every VIN links to its vitals in Garage. The host is configuration —
        // a board pointed at another region should link there.
        garageUrl: L.CONFIG.garageUrl.replace(/\/+$/, "")
      });
    }

    /* ── where the running scan has got to ── */
    if(p === "/api/progress" && req.method === "GET"){
      if(!JOB) return sendJson(res, 200, { running: false });
      return sendJson(res, 200, {
        running: true,
        elapsed: Math.round((Date.now() - JOB.startedAt) / 1000),
        ...JOB
      });
    }

    /* ── type-ahead over the site directory ── */
    if(p === "/api/sites" && req.method === "GET"){
      const q = (url.searchParams.get("q") || "").trim();
      if(q.length < 2) return sendJson(res, 200, { q, sites: [] });
      return sendJson(res, 200, { q, sites: await L.searchSites(q, 20) });
    }

    /* ── remember the chosen centre ──
       The one mutating route that does not take the admin password, and
       deliberately so. Picking your centre is the board's primary
       interaction, not an administrative act; gating it behind the admin code
       would mean unlocking Admin to use the tool at all. */
    if(p === "/api/trt" && req.method === "POST"){
      const body = await readBody(req);

      /* Both sites come from the one picker and are saved together. Each is
         optional and each may be cleared — a board with no overflow lot simply
         leaves the second one empty. */
      const patch = {};
      for(const [field, key] of [["trtId", "trtId"], ["offsiteTrtId", "offsiteTrtId"]]){
        if(!(field in body)) continue;
        const raw = body[field] == null ? "" : String(body[field]).trim();
        if(raw === ""){ patch[key] = null; continue; }
        if(!/^\d+$/.test(raw)) return sendJson(res, 400, { error: "TRT must be numeric" });
        patch[key] = Number(raw);
      }
      if(!Object.keys(patch).length) return sendJson(res, 400, { error: "Nothing to set" });

      L.saveConnections(patch);
      log(`trt -> main ${L.savedTrtId() ?? "—"}, offsite ${L.savedOffsiteTrtId() ?? "—"}`);
      return sendJson(res, 200, {
        ok: true,
        trtId: L.savedTrtId(),
        trt  : L.savedTrtId() ? await L.trtInfo(L.savedTrtId()) : null,
        offsiteTrtId: L.savedOffsiteTrtId(),
        offsiteTrt  : L.savedOffsiteTrtId() ? await L.trtInfo(L.savedOffsiteTrtId()) : null
      });
    }

    /* ── resolve a TRT to its site name ── */
    if(p === "/api/trt" && req.method === "GET"){
      const id = (url.searchParams.get("id") || "").trim();
      if(!/^\d+$/.test(id)) return sendJson(res, 400, { error: "TRT must be numeric" });
      const info = await L.trtInfo(id);
      // A miss is not an error: the number may be valid but absent from the
      // directory, and the caller can still use it.
      return sendJson(res, 200, { trtId: Number(id), found: Boolean(info), info });
    }

    /* ── the scan ── */
    if(p === "/api/scan" && req.method === "POST"){
      const body  = await readBody(req);
      const trtId = body.trtId ? String(body.trtId).trim() : null;

      if(trtId && !/^\d+$/.test(trtId)){
        return sendJson(res, 400, { error: "TRT must be numeric" });
      }
      if(!trtId){
        return sendJson(res, 400, {
          error: "No TRT set — choose a centre in the top corner", needsTrt: true });
      }

      /* Which sites the scan covers. Onsite is the centre in the nav; offsite
         is the second TRT set beside it. Anything unrecognised falls back to
         onsite rather than widening — a filter nobody chose should never make
         a scan bigger than it was asked to be. */
      const offsiteId = L.savedOffsiteTrtId();
      const sites = ["onsite", "offsite", "both"].includes(body.sites) ? body.sites : "onsite";
      if(sites !== "onsite" && !offsiteId){
        return sendJson(res, 400, {
          error: "No offsite TRT set — add one in the TRT picker, top corner.", needsTrt: true });
      }

      /* Only facets the server knows about, and only values it published.
         A page sending anything else is either stale or poking, and either
         way the answer is to drop it rather than pass it into a query. */
      const filters = {};
      for(const [key, facet] of Object.entries(L.FACETS)){
        const sent = Array.isArray(body.filters && body.filters[key]) ? body.filters[key] : [];
        const ok = facet.options.map(o => o.v);
        const keep = sent.map(String).filter(v => ok.includes(v));
        if(keep.length) filters[key] = keep;
      }
      const kinds = Array.isArray(body.kinds)
        ? body.kinds.map(String).filter(k => L.HOLD_KINDS.some(h => h.v === k))
        : [];
      if(!kinds.length){
        return sendJson(res, 400, { error: "Pick at least one thing to look for" });
      }

      const started = Date.now();
      jobStart();
      let out;
      try{
        out = await L.scanVehicles({ trtId, offsiteTrtId: offsiteId, sites,
                                     filters, kinds, onProgress: jobUpdate });
      }finally{
        jobEnd();
      }

      const reasons = kinds.includes("logistics") ? await L.logisticsHoldReasons() : {};
      log(`scan: ${sites} (main ${trtId}${offsiteId ? ", offsite " + offsiteId : ""}) · ${
            out.scanned} vehicles · ${L.summarise(out.rows).flagged} flagged in ${
            ((Date.now() - started) / 1000).toFixed(1)}s`);

      return sendJson(res, 200, {
        trtId  : Number(trtId),
        trt    : await L.trtInfo(trtId),
        sites,
        query  : out.query,
        total  : out.total,
        scanned: out.scanned,
        kinds  : out.kinds,
        filters,
        reasons,
        notes  : out.notes,
        summary: L.summarise(out.rows),
        rows   : out.rows
      });
    }

    /* ── the COG status ladder ──
       Fetched when the tool's menu opens rather than at first paint: a board
       whose page will not load because Intrepid is down is worse than one
       whose second tool says so when you reach for it. */
    if(p === "/api/cog/statuses" && req.method === "GET"){
      return sendJson(res, 200, { statuses: await L.cogStatuses() });
    }

    /* ── cars on ground ──
       Three calls for a whole centre and none of them per vehicle, so unlike
       the Service Visits scan this one needs no cap and finishes in seconds.
       It still publishes progress: the reply is a few hundred kilobytes and
       a silent second still reads as a hang. */
    if(p === "/api/cog/scan" && req.method === "POST"){
      const body  = await readBody(req);
      const trtId = body.trtId ? String(body.trtId).trim() : null;

      if(trtId && !/^\d+$/.test(trtId)){
        return sendJson(res, 400, { error: "TRT must be numeric" });
      }
      if(!trtId){
        return sendJson(res, 400, {
          error: "No TRT set — choose a centre in the top corner", needsTrt: true });
      }

      /* Only ids Intrepid published. An unknown one would silently match
         nothing and look like an empty centre rather than a bad request. */
      const known = new Set((await L.cogStatuses()).map(s => s.id));
      const statusIds = Array.isArray(body.statuses)
        ? [...new Set(body.statuses.map(Number).filter(n => known.has(n)))]
        : [];

      const started = Date.now();
      jobStart();
      let out;
      try{
        out = await L.carsOnGround({ trtId, statusIds, onProgress: jobUpdate });
      }finally{
        jobEnd();
      }

      log(`cog: TRT ${trtId} · ${out.total} on ground · ${out.matched} matched · ${
            out.noRecord} no record in ${((Date.now() - started) / 1000).toFixed(1)}s`);

      return sendJson(res, 200, {
        trt: await L.trtInfo(trtId), statusIds, ...out
      });
    }

    /* ── export what is on screen ──
       Takes the rows from the page rather than re-scanning. The file then
       matches what was being looked at exactly, costs nothing, and cannot
       come back different — a re-scan minutes later legitimately can, because
       service visits open and close while you read.

       One row per vehicle, not one per hold. A car with two campaigns is
       still one car, and a sheet that repeats it twice double-counts the
       moment anyone sums a column. Multiples are joined into the cell and
       counted in their own column, so both readings stay available. */
    if(p === "/api/export" && req.method === "POST"){
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if(!rows.length) return sendJson(res, 400, { error: "Nothing on screen to export" });

      const label = String(body.label || "export").replace(/[^0-9A-Za-z_.-]+/g, "-").slice(0, 80);

      /* Cars on ground writes a different sheet from the same route: one row
         per car either way, but the columns are the car's position in the
         receiving ladder rather than what is holding it up.

         Dwell goes out twice on purpose — a readable "142d" to look at, and
         the same span in hours as a number, so a column can be sorted,
         filtered above a threshold or averaged without anyone parsing a
         string back into a duration. */
      if(String(body.kind || "") === "cog"){
        const cogSheet = rows.map(r => ({
          vin      : r.vin,
          model    : r.modelLabel || r.model || "",
          type     : r.type || "",
          color    : r.color || "",
          status   : r.status || "",
          // Same column question as the screen: is this status read off a
          // record, or inferred from there not being one?
          source   : r.inferred ? "No COG record" : "COG record",
          dwell    : r.dwell || "",
          dwellHrs : r.dwellSec == null ? "" : r.dwellSec / 3600,
          dwellDays: r.dwellSec == null ? "" : r.dwellSec / 86400,
          arrived  : r.arrived ? String(r.arrived).slice(0, 16).replace("T", " ") : "",
          bay      : r.bay || "",
          soc      : r.soc == null ? "" : r.soc,
          logistics: r.logistics || "",
          hold     : r.hold || "",
          rn       : r.rn || "",
          itinerary: r.itinerary || "",
          vriPassed: r.vriPassed ? String(r.vriPassed).slice(0, 10) : "",
          touchedAt: r.touchedAt ? String(r.touchedAt).slice(0, 10) : "",
          touchedBy: r.touchedBy || ""
        }));

        const cogBuf = xlsx.build({
          sheetName: "Cars on ground",
          columns: [
            { key: "vin",       header: "VIN",             width: 20 },
            { key: "model",     header: "Model",           width: 12 },
            { key: "type",      header: "Vehicle type",    width: 18 },
            { key: "color",     header: "Colour",          width: 22 },
            { key: "status",    header: "COG status",      width: 26 },
            { key: "source",    header: "Status source",   width: 15 },
            { key: "dwell",     header: "Dwell",           width: 10 },
            { key: "dwellHrs",  header: "Dwell hours",     width: 13, type: "number", digits: 1 },
            { key: "dwellDays", header: "Dwell days",      width: 12, type: "number", digits: 1 },
            { key: "arrived",   header: "Arrived",         width: 18 },
            { key: "bay",       header: "Bay",             width: 9 },
            { key: "soc",       header: "SOC %",           width: 8,  type: "number", digits: 0 },
            { key: "logistics", header: "Logistics status", width: 20 },
            { key: "hold",      header: "Hold",            width: 18 },
            { key: "rn",        header: "RN",              width: 15 },
            { key: "itinerary", header: "Itinerary",       width: 20 },
            { key: "vriPassed", header: "VRI passed",      width: 13 },
            { key: "touchedAt", header: "Status updated",  width: 15 },
            { key: "touchedBy", header: "Updated by",      width: 26 }
          ],
          rows: cogSheet
        });

        log(`export: ${cogSheet.length} cars on ground -> ${label}.xlsx`);
        return sendXlsx(res, cogBuf, label);
      }

      /* Resolved here rather than trusted from the page: the page holds the
         same map, but the file should not be able to disagree with the
         server about what hold reason 7 means. */
      const reasons = await L.logisticsHoldReasons();

      const join = (list, fn) => list.map(fn).filter(Boolean).join(" · ");
      const first = (list, fn) => (list.length ? fn(list[0]) : "");
      const day = s => {
        if(!s) return "";
        const d = new Date(s);
        return isNaN(d) ? String(s).slice(0, 10) : d.toISOString().slice(0, 10);
      };

      const sheet = rows.map(r => {
        const visits = Array.isArray(r.visits) ? r.visits : [];
        const camps  = Array.isArray(r.campaigns) ? r.campaigns : [];
        const logi   = Array.isArray(r.logistics) ? r.logistics : [];
        const blockers = [
          visits.length ? "Service visit" : "",
          camps.length  ? "Containment"   : "",
          logi.length   ? "Logistics"     : ""
        ].filter(Boolean);

        return {
          vin      : r.vin,
          model    : r.modelLabel || r.model || "",
          type     : r.typeLabel || r.type || "",
          ownership: r.ownership || "",
          category : r.categoryLabel || r.category || "",
          fleet    : r.fleetStatus || "",
          stage    : r.stage || "",
          delivered: r.delivered ? "Delivered" : "Undelivered",
          deliveredOn: day(r.deliveredAt),
          title    : r.titleLabel || "",
          refurb   : r.refurb || "",
          inUse    : day(r.inUseSince),
          flagged  : blockers.length ? "Yes" : "No",
          blockers : blockers.join(" + "),

          svCount  : visits.length,
          svNumbers: join(visits, v => v.id),
          svOpened : first(visits, v => day(v.opened)),
          svDue    : first(visits, v => day(v.due)),

          ctCount  : camps.length,
          ctTitles : join(camps, c => c.title),
          ctAction : join(camps, c => c.action),

          lgCount  : logi.length,
          lgReasons: join(logi, h => reasons[h.reasonId] || ("reason " + h.reasonId)),
          lgNotes  : join(logi, h => h.note)
        };
      });

      const buf = xlsx.build({
        sheetName: "Service visits",
        columns: [
          { key: "vin",         header: "VIN",              width: 20 },
          { key: "model",       header: "Model",            width: 12 },
          { key: "type",        header: "Vehicle tag",      width: 16 },
          { key: "ownership",   header: "Ownership",        width: 14 },
          { key: "category",    header: "Category",         width: 22 },
          { key: "fleet",       header: "Fleet status",     width: 15 },
          { key: "stage",       header: "Delivery stage",   width: 20 },
          { key: "delivered",   header: "Delivery state",   width: 14 },
          { key: "deliveredOn", header: "Delivered on",     width: 14 },
          // Blank on a scan that did not ask for title status — see FACETS.title.
          { key: "title",       header: "Title status",     width: 13 },
          { key: "refurb",      header: "Refurb status",    width: 24 },
          { key: "inUse",       header: "In use since",     width: 14 },
          { key: "flagged",     header: "Flagged",          width: 9 },
          { key: "blockers",    header: "Blockers",         width: 26 },
          // Counts are numbers, not text, so a column sums without anyone
          // retyping it — the whole reason this is xlsx and not CSV.
          { key: "svCount",     header: "SV count",         width: 10, type: "number", digits: 0 },
          { key: "svNumbers",   header: "SV numbers",       width: 24 },
          { key: "svOpened",    header: "SV opened",        width: 13 },
          { key: "svDue",       header: "SV due",           width: 13 },
          { key: "ctCount",     header: "Containment count", width: 17, type: "number", digits: 0 },
          { key: "ctTitles",    header: "Containment campaigns", width: 46 },
          { key: "ctAction",    header: "Containment action",    width: 24 },
          { key: "lgCount",     header: "Logistics count",  width: 15, type: "number", digits: 0 },
          { key: "lgReasons",   header: "Logistics reason", width: 24 },
          { key: "lgNotes",     header: "Logistics note",   width: 34 }
        ],
        rows: sheet
      });

      log(`export: ${sheet.length} rows -> ${label}.xlsx`);
      return sendXlsx(res, buf, label);
    }

    /* ── admin ── */
    if(p === "/api/admin/unlock" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      return sendJson(res, 200, {
        ok: true,
        connections: L.connectionsSummary()
      });
    }


    if(p === "/api/admin/reset" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.resetBoard();
      log("board reset");
      return sendJson(res, 200, { ok: true, ...out, connections: L.connectionsSummary() });
    }

    if(p === "/api/admin/refresh-trt" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const map = await L.trtDirectory({ refresh: true });
      return sendJson(res, 200, { ok: true, sites: Object.keys(map).length });
    }

    if(p === "/api/admin/test" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      // Tesladex is tested separately from Garage: a live MCP session is not
      // the same permission as reading the vehicle index.
      const [intrepid, garage, tesladex] = await Promise.all([
        L.testIntrepid(body.trtId ? String(body.trtId).trim() : null),
        L.testGarage(),
        L.testTesladex()
      ]);
      return sendJson(res, 200, { intrepid, garage, tesladex });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }catch(err){
    sendErr(res, err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`The Compiler on http://localhost:${PORT}`);
  const c = L.connectionsSummary();
  log(`  garage ${c.garage.detail}`);
  log(`  intrepid ${c.intrepid.set ? "cookie saved" : "NO COOKIE — scans will fail"}`);
  if(c.trtId) log(`  trt ${c.trtId}`);
});

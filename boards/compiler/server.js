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
const credstore = require("./credstore");

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
  const code = err.needsTrt ? 400
             : (err.needsCookie || err.needsAuth || err.needsSca || err.needsOs ? 401 : 502);
  sendJson(res, code, {
    error      : err.message,
    needsCookie: Boolean(err.needsCookie),
    needsAuth  : Boolean(err.needsAuth),
    needsSca   : Boolean(err.needsSca),
    /* A dead Tesla OS session must land on "connect it again", never on an
       empty pipeline — that is the whole reason this flag is carried up from
       os.js rather than being turned into a 502 like any other upstream. */
    needsOs    : Boolean(err.needsOs),
    needsTrt   : Boolean(err.needsTrt),
    /* Half of a two-step write landed. Not the same as "it failed" — the page
       has to say so differently, because something in the world has changed
       and the next action is not simply "try again". */
    partial    : Boolean(err.partial)
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

    /* ── the vendored map library ──
       Leaflet is in the folder rather than on a CDN, because this board's
       promise is that it runs from its own directory: a tool that goes blank
       when a CDN is blocked would break that. Two files, still no build step.
       The path is hard-matched rather than joined from the URL — a static
       handler that concatenates user input is how a board starts serving
       .connections.json. */
    if(p === "/vendor/leaflet.js" || p === "/vendor/leaflet.css"){
      const file = path.join(__dirname, "vendor", path.basename(p));
      if(!fs.existsSync(file)){
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Leaflet is not vendored — the map will not draw");
      }
      res.writeHead(200, {
        "Content-Type" : p.endsWith(".css") ? "text/css; charset=utf-8"
                                            : "application/javascript; charset=utf-8",
        // Pinned at 1.9.4 and never regenerated, so it can be cached hard.
        "Cache-Control": "public, max-age=86400"
      });
      return res.end(fs.readFileSync(file));
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

    /* ── the language, set on the Hub ──
       Read off the shared file on every call rather than cached at startup,
       so flipping it on the Hub reaches this board while it is open. The Hub
       does not need to be running for this to answer: the file outlives it. */
    if(p === "/api/lang" && req.method === "GET"){
      return sendJson(res, 200, { lang: credstore.language() });
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
        garageUrl: L.CONFIG.garageUrl.replace(/\/+$/, ""),
        // For Admin › My location, and so the contact panel can say when the
        // Tesla switch will not be able to set an address.
        billingAddress: L.loadConnections().billingAddress || null,
        /* The host only. The path of a webhook URL is the whole credential, so
           it goes to the page exactly once — when it is typed — and never
           comes back. */
        teams: (() => {
          const t = L.teamsSettings();
          return (t.hasWebhook || t.hasPush || t.autoMinutes) ? t : null;
        })(),
        /* Whether an SV Call webhook is saved, and its host — never its path.
           The page needs the boolean to know whether the two buttons can do
           anything, and says so on the button rather than failing on press. */
        svcall: L.svCallSettings()
      });
    }

    /* ── the Teams loop, for the panel countdown ──
       Unauthenticated like /api/state and for the same reason: it carries no
       credential, only whether a timer is running and when it next fires. */
    if(p === "/api/teams/status" && req.method === "GET"){
      return sendJson(res, 200, L.teamsStatus());
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

    /* ── the Service App sign-in ──
       Not behind the admin password, and for the same reason /api/trt is not:
       connecting a source you need in order to use the tool is a primary
       interaction rather than an administrative act, and the prompt that
       offers it appears before anybody has unlocked Admin. It grants no
       power either — it captures the operator's own SSO session and can
       reach nothing they could not already open in a browser. */
    if(p === "/api/sca" && req.method === "GET"){
      return sendJson(res, 200, {
        connection: L.connectionsSummary().sca,
        signin    : L.scaSignInStatus(),
        browser   : await L.scaBrowserStatus()
      });
    }

    if(p === "/api/sca/connect" && req.method === "POST"){
      // Returns the moment the attempt starts; the page polls /api/sca for
      // the outcome. See sca.js for why the waiting happens server-side.
      const st = L.scaSignIn();
      log(`sca sign-in -> ${st.phase}`);
      return sendJson(res, 200, { ok: true, signin: st,
                                  connection: L.connectionsSummary().sca });
    }

    if(p === "/api/sca/cancel" && req.method === "POST"){
      return sendJson(res, 200, { ok: true, signin: L.scaCancelSignIn(),
                                  connection: L.connectionsSummary().sca });
    }

    /* ── Tesla OS ──
       The same four routes as SCA, doing the same four things, because it is
       the same kind of credential wearing a different hat. The one difference
       is `live`: SCA's token says when it dies, this one has to be asked, so
       the status route probes (cached in lib.js) rather than computing. */
    if(p === "/api/os" && req.method === "GET"){
      return sendJson(res, 200, {
        connection: L.connectionsSummary().os,
        live      : await L.osStatus(),
        signin    : L.osSignInStatus(),
        browser   : await L.osBrowserStatus()
      });
    }

    if(p === "/api/os/connect" && req.method === "POST"){
      const st = L.osSignIn();
      log(`os sign-in -> ${st.phase}`);
      return sendJson(res, 200, { ok: true, signin: st,
                                  connection: L.connectionsSummary().os });
    }

    if(p === "/api/os/cancel" && req.method === "POST"){
      return sendJson(res, 200, { ok: true, signin: L.osCancelSignIn(),
                                  connection: L.connectionsSummary().os });
    }

    if(p === "/api/os/disconnect" && req.method === "POST"){
      L.osDisconnect();
      log("os disconnected");
      return sendJson(res, 200, { ok: true, connection: L.connectionsSummary().os });
    }

    /* ── Pending Inventory: matched but not scheduled ──
       One POST, no toggles. Unlike the other two scans there is nothing to
       choose before running: the bucket is the bucket and the centre comes
       from the picker, so everything narrowing happens on the rows afterwards. */
    if(p === "/api/exp/scan" && req.method === "POST"){
      const body  = await readBody(req);
      const trtId = body.trtId ? String(body.trtId).trim() : null;

      if(trtId && !/^\d+$/.test(trtId)){
        return sendJson(res, 400, { error: "TRT must be numeric" });
      }
      if(!trtId){
        return sendJson(res, 400, {
          error: "No TRT set — choose a centre in the top corner", needsTrt: true });
      }

      jobStart();
      let out;
      try { out = await L.expScan({ trtId, onProgress: jobUpdate }); }
      finally { jobEnd(); }

      log(`expenable ${out.location.name}: ${out.rows.length} matched, not scheduled`);
      return sendJson(res, 200, out);
    }

    /* ── Pending Inventory's other half: what there is to give somebody ──

       No TRT guard, and that is the difference from the route above. Every
       other scan on this board is one centre at a time and refuses without
       one; availability is a question that legitimately reaches past the
       centre, so Location is a filter the page sends like any other. */
    if(p === "/api/inv/filters" && req.method === "GET"){
      const force = url.searchParams.get("refresh") === "1";
      const s = await L.invFilters({ force });
      return sendJson(res, 200, {
        models: s.models, conds: s.conds, filters: s.filters,
        at: s.at, stale: Boolean(s.stale)
      });
    }

    if(p === "/api/inv/scan" && req.method === "POST"){
      const body      = await readBody(req);
      const model     = String(body.model     || "").toLowerCase().trim();
      const condition = String(body.condition || "").toLowerCase().trim();

      /* Checked against the site's own lists rather than a copy kept here —
         the same reason the filter keys are checked inside invScan. */
      const schema = await L.invFilters();
      if(!schema.models.includes(model)){
        return sendJson(res, 400, {
          error: `Tesla inventory has no model "${model}". It has: ${schema.models.join(", ")}.` });
      }
      if(!schema.conds.includes(condition)){
        return sendJson(res, 400, {
          error: `Condition must be one of: ${schema.conds.join(", ")}.` });
      }

      jobStart();
      let out;
      try{
        out = await L.invScan({ model, condition,
                                options: body.options || {},
                                sort   : body.sort || "Relevance",
                                onProgress: jobUpdate });
      }finally{ jobEnd(); }

      const where = (out.options.Vrl || []).length ? `vrl ${out.options.Vrl.join("/")}`
                  : (out.options.FleetSalesRegions || []).join("/") || "everywhere";
      log(`inventory ${condition} ${model} · ${where}: ${out.rows.length} of ${out.total}`);
      return sendJson(res, 200, out);
    }

    /* ── one photo off a concern ──
       A GET an <img src> can point at, so the page never handles the bearer
       token and the browser does its own caching. Streamed straight through:
       these run to several megabytes and there is no reason to hold one in
       memory on the way past.

       Only ever reached by clicking into a ticket, so it costs nothing on a
       scan. The id is validated as digits before it is put in a URL. */
    if(p.startsWith("/api/sca/photo/") && req.method === "GET"){
      const id = p.slice("/api/sca/photo/".length);
      if(!/^\d+$/.test(id)) return sendJson(res, 400, { error: "Bad attachment id" });
      let token;
      try { token = L.scaToken(); }
      catch(err){ return sendErr(res, err); }

      const up = await L.scaPhotoStream(token, id);
      if(up.statusCode !== 200){
        up.resume();   // drain, or the socket is held open for nothing
        return sendJson(res, up.statusCode === 401 ? 401 : 502, {
          error: up.statusCode === 401
            ? "Service App token expired — connect SCA again"
            : `Service App returned ${up.statusCode} for that image`,
          needsSca: up.statusCode === 401
        });
      }
      res.writeHead(200, {
        "Content-Type": up.headers["content-type"] || "application/octet-stream",
        ...(up.headers["content-length"] ? { "Content-Length": up.headers["content-length"] } : {}),
        // Immutable by nature: an attachment id names one uploaded file for
        // good, so reopening a viewer should not refetch megabytes.
        "Cache-Control": "private, max-age=3600"
      });
      return up.pipe(res);
    }

    /* ── type-ahead over SCA's site directory ──
       Same shape as /api/sites, which drives the nav TRT picker, so the page
       can reuse that debounce and dropdown wholesale. */
    if(p === "/api/sca/sites" && req.method === "GET"){
      const q = (url.searchParams.get("q") || "").trim();
      if(q.length < 2) return sendJson(res, 200, { q, sites: [] });
      return sendJson(res, 200, { q, sites: await L.scaSites(q) });
    }

    /* ── SCA's symptom catalogue ──
       Read-only, and the concern editor's type-ahead is the only caller. The
       model scopes it: the same words are not offered against every car, so
       an unscoped list would suggest symptoms this one cannot be saved with. */
    if(p === "/api/sca/symptoms" && req.method === "GET"){
      const q = (url.searchParams.get("q") || "").trim();
      const modelId = (url.searchParams.get("modelId") || "").trim();
      if(q.length < 2) return sendJson(res, 200, { q, symptoms: [] });
      return sendJson(res, 200, { q, symptoms: await L.scaSymptoms({ term: q, modelId }) });
    }

    /* ── take a line off a visit ──
       Returns the activity to outstanding work. It is NOT a cancel: the
       ticket stays open and the concern survives, which is the distinction
       this board has been told twice to keep. sca.js re-reads the visit and
       this layer reports what the read said, not what the write claimed. */
    if(p === "/api/sca/activity/remove" && req.method === "POST"){
      const body = await readBody(req);
      const num  = k => (/^\d+$/.test(String(body[k] ?? "").trim()) ? Number(body[k]) : null);
      const svid = num("serviceVisitId"), act = num("activityId");
      if(svid === null) return sendJson(res, 400, { error: "serviceVisitId must be numeric" });
      if(act === null)  return sendJson(res, 400, { error: "activityId must be numeric" });

      const out = await L.scaRemoveActivity({ serviceVisitId: svid, activityId: act });
      log(`sca remove: activity ${act} off visit ${svid} -> ` +
          (out.ok ? `gone, ${out.remaining} left` : `NOT removed (${out.said || "no reason given"})`));
      if(!out.ok && out.verified === null){
        return sendJson(res, 502, {
          error: "The Service App accepted it but the board could not read the visit back, " +
                 "so it cannot say whether the line came off. Re-run the scan.", partial: true });
      }
      if(!out.ok){
        return sendJson(res, 502, {
          error: out.said || "The Service App did not take that line off the visit." });
      }
      return sendJson(res, 200, out);
    }

    /* ── change what a concern says ──
       Five fields on one activity; everything else is echoed from the record.
       See sca.setSymptom() for why the body is read rather than built. */
    if(p === "/api/sca/activity/symptom" && req.method === "POST"){
      const body = await readBody(req);
      const num  = k => (/^\d+$/.test(String(body[k] ?? "").trim()) ? Number(body[k]) : null);
      const svid = num("serviceVisitId"), act = num("activityId");
      const code = String(body.symptomCode || "").trim();
      if(svid === null) return sendJson(res, 400, { error: "serviceVisitId must be numeric" });
      if(act === null)  return sendJson(res, 400, { error: "activityId must be numeric" });
      // The code comes from SCA's own catalogue, so anything else is a caller
      // bug rather than something to pass upstream and see what happens.
      if(!/^[A-Za-z0-9-]{1,32}$/.test(code))
        return sendJson(res, 400, { error: "symptomCode must come from the Service App's list" });

      const out = await L.scaSetSymptom({ serviceVisitId: svid, activityId: act, symptomCode: code });
      log(`sca symptom: activity ${act} -> ${out.symptom}` +
          (out.verified === true ? " (verified)" : out.verified === null ? " (UNVERIFIED)" : " !! READ BACK DIFFERENT"));
      return sendJson(res, 200, out);
    }

    /* ── move a visit to another service centre ──
       The board's only write to a service record. Every guard is in
       L.scaMoveVisit(); this layer just validates shapes and relays SCA's own
       words when it refuses, because they say more than a generic failure. */
    if(p === "/api/sca/move" && req.method === "POST"){
      const body = await readBody(req);
      const vin  = String(body.vin || "").trim().toUpperCase();
      const num  = k => (/^\d+$/.test(String(body[k] ?? "").trim()) ? Number(body[k]) : null);
      const svid = num("serviceVisitId"), loc = num("scaLocationId"), trt = num("trtId");

      if(!L.isVin(vin))     return sendJson(res, 400, { error: "A valid VIN is required" });
      if(svid === null)     return sendJson(res, 400, { error: "serviceVisitId must be numeric" });
      if(loc === null)      return sendJson(res, 400, { error: "scaLocationId must be numeric" });
      // Both ids come from the picker together; one without the other is a bug
      // in the caller rather than something to guess at.
      if(trt === null)      return sendJson(res, 400, { error: "trtId must be numeric" });

      /* The destination arrives whole from the picker. It has to: the move
         needs functionID and inventoryLocationID as well as the two ids, and
         none of the four can be derived from the others. Re-deriving them
         server-side would mean a second directory search per move on data the
         page already holds. */
      const dest = {
        scaLocationId      : loc,
        trtId              : trt,
        name               : String(body.name || "").slice(0, 120),
        typeId             : Number(body.typeId),
        functionId         : Number(body.functionId),
        inventoryLocationId: Number(body.inventoryLocationId)
      };
      for(const k of ["typeId", "functionId", "inventoryLocationId"])
        if(!Number.isFinite(dest[k])) return sendJson(res, 400, { error: `${k} must be numeric` });

      const out = await L.scaMoveVisit({ vin, serviceVisitId: svid, dest });
      log(`sca move: ${vin} visit ${svid} · ${out.from} -> ${out.to}` +
          (out.cancelled ? " (appointment cancelled)" : "") +
          (out.ticketsIntact ? "" : "  !! TICKET STATUS CHANGED") +
          (out.sideEffects.length ? "  !! also changed: " + out.sideEffects.join(", ") : ""));
      return sendJson(res, 200, out);
    }

    /* ── cancel the appointment, leaving the car where it is ──
       The cancel half of the move on its own. Same guards, because it is the
       same write. */
    if(p === "/api/sca/cancel-appointment" && req.method === "POST"){
      const body = await readBody(req);
      const vin  = String(body.vin || "").trim().toUpperCase();
      const svid = /^\d+$/.test(String(body.serviceVisitId ?? "").trim())
        ? Number(body.serviceVisitId) : null;
      if(!L.isVin(vin))  return sendJson(res, 400, { error: "A valid VIN is required" });
      if(svid === null)  return sendJson(res, 400, { error: "serviceVisitId must be numeric" });

      const out = await L.scaCancelAppointment({ vin, serviceVisitId: svid });
      log(`sca cancel appt: ${vin} visit ${svid} · was ${out.was || "—"}` +
          (out.ticketsIntact ? "" : "  !! TICKET STATUS CHANGED") +
          (out.sideEffects.length ? "  !! also changed: " + out.sideEffects.join(", ") : ""));
      return sendJson(res, 200, out);
    }

    /* ── who is on the visit ── */
    if(p === "/api/sca/contacts" && req.method === "GET"){
      const vin  = (url.searchParams.get("vin") || "").trim().toUpperCase();
      const svid = (url.searchParams.get("svid") || "").trim();
      if(!L.isVin(vin))       return sendJson(res, 400, { error: "A valid VIN is required" });
      if(!/^\d+$/.test(svid)) return sendJson(res, 400, { error: "svid must be numeric" });
      return sendJson(res, 200, await L.scaContacts(vin, svid));
    }

    /* ── set a contact by hand ── */
    if(p === "/api/sca/set-contact" && req.method === "POST"){
      const body = await readBody(req);
      const vin  = String(body.vin || "").trim().toUpperCase();
      const svid = /^\d+$/.test(String(body.serviceVisitId ?? "").trim())
        ? Number(body.serviceVisitId) : null;
      if(!L.isVin(vin)) return sendJson(res, 400, { error: "A valid VIN is required" });
      if(svid === null) return sendJson(res, 400, { error: "serviceVisitId must be numeric" });

      const out = await L.scaSetContact({
        vin, serviceVisitId: svid, contactType: body.contactType,
        contact: {
          firstName: String(body.firstName || "").slice(0, 80),
          lastName : String(body.lastName  || "").slice(0, 80),
          email    : String(body.email     || "").slice(0, 160),
          phone    : String(body.phone     || "").slice(0, 40)
        }
      });
      // The name is logged; the email and phone are not.
      log(`sca contact set: ${vin} visit ${svid} type ${body.contactType === 2 ? 2 : 1} -> ${out.now}` +
          (out.ticketsIntact ? "" : "  !! TICKET STATUS CHANGED"));
      return sendJson(res, 200, out);
    }

    /* ── set the billing address on one visit ── */
    if(p === "/api/sca/set-address" && req.method === "POST"){
      const body = await readBody(req);
      const vin  = String(body.vin || "").trim().toUpperCase();
      const svid = /^\d+$/.test(String(body.serviceVisitId ?? "").trim())
        ? Number(body.serviceVisitId) : null;
      if(!L.isVin(vin)) return sendJson(res, 400, { error: "A valid VIN is required" });
      if(svid === null) return sendJson(res, 400, { error: "serviceVisitId must be numeric" });

      const out = await L.scaSetAddress({
        vin, serviceVisitId: svid,
        address: {
          addressLine1: String(body.addressLine1 || "").slice(0, 120),
          addressLine2: String(body.addressLine2 || "").slice(0, 120),
          city        : String(body.city || "").slice(0, 80),
          stateCode   : String(body.stateCode || "").slice(0, 3),
          zip         : String(body.zip || "").slice(0, 12),
          countryCode : String(body.countryCode || "US").slice(0, 2)
        }
      });
      log(`sca address: ${vin} visit ${svid} -> ${out.now}`);
      return sendJson(res, 200, out);
    }

    /* ── swap the main contact to Tesla ──
       Pre-delivery only; the gate is in L.scaSwitchContactToTesla. */
    if(p === "/api/sca/contact-to-tesla" && req.method === "POST"){
      const body = await readBody(req);
      const vin  = String(body.vin || "").trim().toUpperCase();
      const svid = /^\d+$/.test(String(body.serviceVisitId ?? "").trim())
        ? Number(body.serviceVisitId) : null;
      if(!L.isVin(vin)) return sendJson(res, 400, { error: "A valid VIN is required" });
      if(svid === null) return sendJson(res, 400, { error: "serviceVisitId must be numeric" });

      const out = await L.scaSwitchContactToTesla({ vin, serviceVisitId: svid });
      log(`sca contact: ${vin} visit ${svid} · ${out.was || "—"} -> ${out.now}` +
          (out.ticketsIntact ? "" : "  !! TICKET STATUS CHANGED"));
      return sendJson(res, 200, out);
    }

    /* ── is this visit movable yet? ──
       Polled by an open row after somebody cancels an appointment in SCA, so
       the panel can unlock without a rescan. */
    if(p === "/api/sca/visit-state" && req.method === "GET"){
      const vin  = (url.searchParams.get("vin") || "").trim().toUpperCase();
      const svid = (url.searchParams.get("svid") || "").trim();
      if(!L.isVin(vin))          return sendJson(res, 400, { error: "A valid VIN is required" });
      if(!/^\d+$/.test(svid))    return sendJson(res, 400, { error: "svid must be numeric" });
      return sendJson(res, 200, await L.scaVisitState(vin, svid));
    }

    if(p === "/api/sca/disconnect" && req.method === "POST"){
      L.scaDisconnect();
      log("sca disconnected");
      return sendJson(res, 200, { ok: true,
                                  connection: L.connectionsSummary().sca });
    }

    /* ── the scan ── */
    if(p === "/api/scan" && req.method === "POST"){
      const body  = await readBody(req);
      const trtId = body.trtId ? String(body.trtId).trim() : null;

      /* ── one VIN ──
         Answered before any of the checks below, because none of them apply.
         A single car needs no site, no facets and no kinds argument about
         cost; it does still need a TRT, but only so the receiving-inspection
         lookup knows which centre's log to read. */
      const oneVin = String(body.vin || "").trim().toUpperCase();
      if(oneVin){
        if(!L.isVin(oneVin))
          return sendJson(res, 400, { error: `${oneVin} is not a 17-character VIN` });
        jobStart();
        let out;
        try { out = await L.scanVehicles({ trtId, vin: oneVin, onProgress: jobUpdate }); }
        finally { jobEnd(); }
        log(`vin lookup: ${oneVin} · ${out.rows.length ? "found" : "not in the index"}`);
        /* The same envelope a centre scan returns, so render() needs no idea
           that this one came from a VIN box — one renderer, one row shape,
           and every filter, export and write on the page behaves identically
           on the result. */
        return sendJson(res, 200, {
          vin    : oneVin,
          trtId  : trtId ? Number(trtId) : null,
          trt    : trtId ? await L.trtInfo(trtId) : null,
          sites  : "onsite",
          query  : out.query,
          total  : out.total,
          scanned: out.scanned,
          kinds  : out.kinds,
          filters: {},
          reasons: out.rows.some(r => r.logistics.length) ? await L.logisticsHoldReasons() : {},
          notes  : out.notes,
          sca    : out.sca,
          summary: L.summarise(out.rows),
          rows   : out.rows
        });
      }

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
        // Whether the ticket columns on these rows mean anything. A scan run
        // before SCA was connected keeps its rows; this is how the page knows
        // not to read their blank tickets as "nothing wrong with the car".
        sca    : out.sca,
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

      /* A window the page did not offer is a bug on the page, not a request
         worth honouring quietly — a typo'd 0.5 would hide the whole lot and
         look like an empty centre. */
      const maxDwellHours = L.DWELL_WINDOWS.includes(Number(body.maxDwellHours))
        ? Number(body.maxDwellHours)
        : null;

      const started = Date.now();
      jobStart();
      let out;
      try{
        out = await L.carsOnGround({ trtId, statusIds, maxDwellHours, onProgress: jobUpdate });
      }finally{
        jobEnd();
      }

      log(`cog: TRT ${trtId} · ${out.total} on ground · ${out.matched} matched · ${
            out.noRecord} no record${maxDwellHours ? ` · under ${maxDwellHours}h (${
            out.dwellOlder} older, ${out.dwellUnknown} undated hidden)` : ""} in ${
            ((Date.now() - started) / 1000).toFixed(1)}s`);

      return sendJson(res, 200, {
        trt: await L.trtInfo(trtId), statusIds, ...out
      });
    }

    /* ── pop the trunks ──
       Takes the VINs from the page rather than re-scanning, for the same
       reason the export does: what pops must be what was on screen. A rescan
       between the click and the commands would open trunks on cars the person
       pressing the button never saw.

       This is the only route on the board that changes anything in the world
       rather than reading it, so it is also the only one that refuses a job
       it cannot fully describe — an empty list, or one carrying something
       that is not a VIN. */
    if(p === "/api/cog/trunks" && req.method === "POST"){
      const body = await readBody(req);
      const vins = Array.isArray(body.vins)
        ? [...new Set(body.vins.map(v => String(v || "").trim().toUpperCase()))]
        : [];

      if(!vins.length){
        return sendJson(res, 400, { error: "Nothing on screen to open" });
      }
      const bad = vins.filter(v => !L.isVin(v));
      if(bad.length){
        return sendJson(res, 400, {
          error: `${bad.length} of these are not VINs — the list on screen is not what it should be` });
      }

      const started = Date.now();
      jobStart();
      let out;
      try{
        out = await L.popTrunks({ vins, onProgress: jobUpdate });
      }finally{
        jobEnd();
      }

      log(`trunks: ${out.opened.length}/${out.requested} opened · ${out.failed.length} refused · ${
            out.unknown.length} not in the index · ${out.rounds} round(s) in ${
            ((Date.now() - started) / 1000).toFixed(1)}s`);

      return sendJson(res, 200, out);
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

      /* Which columns, not which rows — the row set is still exactly what was
         on screen. Both tools answer the delivery preset, and both spell "the
         delivery date" with the same key, so one filter serves both.

         Narrow presets filter the full column list rather than declaring their
         own, so a column renamed in one place cannot go stale in the other.
         VIN leads every sheet, so filtering preserves the order the preset is
         named after.

         The ticket preset is Service Visits only — Cars on Ground has no
         ticket columns to keep, so asking it for them would hand back a sheet
         of nothing but VINs. It falls back to every column there rather than
         to an empty one. */
      const PRESETS = {
        "vin-delivery": ["vin", "scheduled"],
        "vin-ticket"  : ["vin", "svNumbers", "svSymptom", "svType", "svCategory",
                         "svHours", "svWhere", "vriDone"],
        /* Pending Inventory's two-column sheet. The pair of ids the delivery world is
           keyed on, for pasting somewhere that is not a spreadsheet — the same
           job "VIN + delivery date" does on the other two, which this bucket
           cannot offer because not being given a date is what put a car in it. */
        "vin-rn"      : ["vin", "rn"],
        /* Open Inventory's narrow sheet. Deliberately not VIN-led: new
           inventory has no published VIN, so a VIN-first preset there would
           produce a column of blanks. */
        "spec-price"  : ["year", "model", "trim", "price", "odometer", "location"]
      };
      const preset = PRESETS[body.preset] ? body.preset : "all";
      const pick = cols => {
        const keep = PRESETS[preset];
        if(!keep) return cols;
        const out = cols.filter(c => keep.includes(c.key));
        return out.length > 1 ? out : cols;
      };

      /* Cars on ground writes a different sheet from the same route: one row
         per car either way, but the columns are the car's position in the
         receiving ladder rather than what is holding it up.

         Dwell goes out twice on purpose — a readable "142d" to look at, and
         the same span in hours as a number, so a column can be sorted,
         filtered above a threshold or averaged without anyone parsing a
         string back into a duration. */
      /* ── Pending Inventory ──
         The order and what the car is, one row per matched car. Days-since-
         matched is written as a NUMBER beside the timestamp for the reason
         dwell is on the Cars on Ground sheet: "3 days" cannot be sorted or
         averaged, and the person exporting this is usually about to do one of
         those. Computed here from the timestamp rather than taken from OS's
         own `time_since_matched`, so the sheet and the screen agree. */
      /* ── Open Inventory ──
         One row per available car. Price and mileage go out as NUMBERS for the
         reason matchedDays and dwell do on the sheets either side of this one:
         "$52,990" cannot be summed and "62,354 mi" cannot be averaged, and the
         person exporting availability is usually about to do one of those.

         The VIN column is blank on new inventory rather than carrying the
         masked `7SAY…`+hash form. That string looks enough like a VIN to be
         pasted into Garage, and it will never match anything — a sheet is read
         away from the card that explained itself. `vinKnown` says which case
         a blank is, so the gap is an answer rather than a hole. */
      if(String(body.kind || "") === "inv"){
        const invSheet = rows.map(r => ({
          vin      : r.vin || "",
          vinKnown : r.masked ? "Not published until matched" : "",
          year     : r.year || "",
          model    : r.modelName || r.model || "",
          trim     : r.trim || "",
          condition: r.condition || "",
          price    : r.price == null ? "" : r.price,
          monroney : r.monroney == null ? "" : r.monroney,
          odometer : r.odometer == null ? "" : r.odometer,
          ...Object.fromEntries((r.spec || []).map(s => [s.k.toLowerCase(), s.v])),
          location : r.vrl || r.city || "",
          state    : r.state || "",
          trt      : r.trt || "",
          status   : [r.inTransit ? "In transit" : "At location",
                      r.demo ? "Demo" : "", r.damage ? "Repair disclosed" : ""]
                     .filter(Boolean).join(" · "),
          options  : r.options || "",
          listing  : r.listing || ""
        }));

        const invBuf = xlsx.build({
          sheetName: "Open inventory",
          columns: pick([
            { key: "vin",       header: "VIN",            width: 20 },
            { key: "vinKnown",  header: "VIN note",       width: 26 },
            { key: "year",      header: "Year",           width: 7,  type: "number", digits: 0 },
            { key: "model",     header: "Model",          width: 13 },
            { key: "trim",      header: "Trim",           width: 26 },
            { key: "condition", header: "New / used",     width: 11 },
            { key: "price",     header: "Price",          width: 12, type: "number", digits: 0 },
            { key: "monroney",  header: "Monroney",       width: 12, type: "number", digits: 0 },
            { key: "odometer",  header: "Mileage",        width: 10, type: "number", digits: 0 },
            { key: "paint",     header: "Paint",          width: 18 },
            { key: "wheels",    header: "Wheels",         width: 20 },
            { key: "interior",  header: "Interior",       width: 18 },
            { key: "drive",     header: "Drive",          width: 16 },
            { key: "autopilot", header: "Autopilot",      width: 26 },
            { key: "location",  header: "Location",       width: 20 },
            { key: "state",     header: "State",          width: 7 },
            { key: "trt",       header: "TRT",            width: 9 },
            { key: "status",    header: "Status",         width: 26 },
            { key: "listing",   header: "Listing",        width: 46 },
            { key: "options",   header: "Option codes",   width: 40 }
          ]),
          rows: invSheet
        });
        return sendXlsx(res, invBuf, label);
      }

      if(String(body.kind || "") === "exp"){
        const days = at => at ? (Date.now() - new Date(at).getTime()) / 86400000 : "";

        const expSheet = rows.map(r => ({
          rn        : r.rn || "",
          vin       : r.vin || "",
          year      : r.year || "",
          model     : r.modelName || r.model || "",
          trim      : (r.spec && r.spec.trim) || "",
          trimCode  : (r.spec && r.spec.trimCode) || "",
          motor     : (r.spec && r.spec.motor) || "",
          paint     : (r.spec && r.spec.paint) || "",
          wheels    : (r.spec && r.spec.wheels) || "",
          interior  : (r.spec && r.spec.interior) || "",
          seats     : (r.spec && r.spec.seats) || "",
          roof      : (r.spec && r.spec.roof) || "",
          tow       : (r.spec && r.spec.tow) || "",
          matchedAt : r.matchedAt ? String(r.matchedAt).slice(0, 16).replace("T", " ") : "",
          matchedDays: r.matchedAt ? days(r.matchedAt) : "",
          etaAt     : r.etaAt ? String(r.etaAt).slice(0, 10) : "",
          /* Blank when the inventory call failed, rather than "In transit".
             A sheet is read away from the screen that made it and away from
             the notice that explained itself, so a guess written into a cell
             outlives every warning the board could give about it. */
          here      : r.here == null ? "" : (r.here ? "Arrived" : "In transit"),
          arrivedAt : r.arrivedAt ? String(r.arrivedAt).slice(0, 10) : "",
          options   : r.options || "",
          // Same question the panel answers on screen: are the spec columns
          // blank because the car is plain, or because it has not been built
          // yet and there is nothing to describe?
          spec      : r.inGarage ? "Built" : "Not built yet"
        }));

        const expBuf = xlsx.build({
          // Named after the tool, like the other two sheets. Which bucket the
          // rows came from is on the screen that produced them.
          sheetName: "Pending inventory",
          columns: pick([
            { key: "vin",         header: "VIN",              width: 20 },
            { key: "rn",          header: "RN",               width: 15 },
            { key: "year",        header: "Year",             width: 7,  type: "number", digits: 0 },
            { key: "model",       header: "Model",            width: 13 },
            { key: "trim",        header: "Trim",             width: 17 },
            { key: "trimCode",    header: "Trim code",        width: 11 },
            { key: "motor",       header: "Motor",            width: 8 },
            { key: "paint",       header: "Paint",            width: 16 },
            { key: "wheels",      header: "Wheels",           width: 20 },
            { key: "interior",    header: "Interior",         width: 17 },
            { key: "seats",       header: "Seats",            width: 14 },
            { key: "roof",        header: "Roof",             width: 13 },
            { key: "tow",         header: "Tow hitch",        width: 13 },
            { key: "matchedAt",   header: "Matched",          width: 18 },
            { key: "matchedDays", header: "Days since matched", width: 18, type: "number", digits: 1 },
            { key: "here",        header: "Arrival",          width: 12 },
            { key: "arrivedAt",   header: "Arrived",          width: 13 },
            { key: "etaAt",       header: "ETA to centre",    width: 14 },
            { key: "spec",        header: "Build",            width: 14 },
            { key: "options",     header: "Option codes",     width: 40 }
          ]),
          rows: expSheet
        });
        log(`export: ${expSheet.length} matched not scheduled (${preset}) -> ${label}.xlsx`);
        return sendXlsx(res, expBuf, label);
      }

      if(String(body.kind || "") === "cog"){
        /* Advisor is fetched here rather than carried in with the rows: it is
           the one column that is not already on screen, and paying for it at
           export time means a scan does not spend a request per car on a name
           nobody asked to see. Blank for a car with no appointment. */
        const advisors = await L.advisorsByRn(rows.map(r => r.rn));

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
          scheduled: r.scheduled ? String(r.scheduled).slice(0, 10) : "",
          dwellHrs : r.dwellSec == null ? "" : r.dwellSec / 3600,
          dwellDays: r.dwellSec == null ? "" : r.dwellSec / 86400,
          arrived  : r.arrived ? String(r.arrived).slice(0, 16).replace("T", " ") : "",
          bay      : r.bay || "",
          soc      : r.soc == null ? "" : r.soc,
          logistics: r.logistics || "",
          hold     : r.hold || "",
          rn       : r.rn || "",
          advisor  : advisors.get(String(r.rn || "")) || "",
          itinerary: r.itinerary || "",
          vriPassed: r.vriPassed ? String(r.vriPassed).slice(0, 10) : "",
          touchedAt: r.touchedAt ? String(r.touchedAt).slice(0, 10) : "",
          touchedBy: r.touchedBy || ""
        }));

        const cogBuf = xlsx.build({
          sheetName: "Cars on ground",
          columns: pick([
            { key: "vin",       header: "VIN",             width: 20 },
            { key: "scheduled", header: "Scheduled delivery", width: 18 },
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
            // Next to the RN it was looked up by. Blank where a car has no
            // appointment booked — that is an answer, not a gap.
            { key: "advisor",   header: "Delivery advisor", width: 22 },
            { key: "itinerary", header: "Itinerary",       width: 20 },
            { key: "vriPassed", header: "VRI passed",      width: 13 },
            { key: "touchedAt", header: "Status updated",  width: 15 },
            { key: "touchedBy", header: "Updated by",      width: 26 }
          ]),
          rows: cogSheet
        });

        log(`export: ${cogSheet.length} cars on ground (${preset}) -> ${label}.xlsx`);
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
          /* Already a plain "2026-08-13" from the index, so it is sliced
             rather than parsed — running it through `day()` would put it
             through a Date and hand back yesterday for anyone east of UTC. */
          scheduled: r.scheduledFor ? String(r.scheduledFor).slice(0, 10) : "",
          // Where Garage says the car is, which can differ from the centre the
          // scan covers — a car at Collision still routes to its home centre.
          site     : r.site || "",
          siteTrt  : r.trtId ?? "",
          title    : r.titleLabel || "",
          refurb   : r.refurb || "",
          inUse    : day(r.inUseSince),
          flagged  : blockers.length ? "Yes" : "No",
          blockers : blockers.join(" + "),

          svCount  : visits.length,
          svNumbers: join(visits, v => v.id),
          svOpened : first(visits, v => day(v.opened)),
          svDue    : first(visits, v => day(v.due)),

          /* What the ticket says, when SCA was connected for the scan. A car
             with several concerns gets them in one cell separated the same way
             every other multi-value column here does, rather than spilling
             into extra rows — the sheet is one row per vehicle and stays that
             way. Blank throughout on a scan that ran without SCA. */
          svSymptom : join(visits, v => (v.ticket && v.ticket.activities || [])
                        .map(a => a.symptom || a.narrative).filter(Boolean).join(" · ")),
          svCategory: join(visits, v => (v.ticket && v.ticket.activities || [])
                        .map(a => a.category).filter(Boolean).join(" · ")),
          svType    : join(visits, v => (v.ticket && v.ticket.activities || [])
                        .map(a => a.hyper).filter(Boolean).join(" · ")),
          // A number so a centre's total booked hours sums in the sheet.
          svHours   : visits.reduce((n, v) => n +
                        (v.ticket && v.ticket.activities || [])
                          .reduce((m, a) => m + (a.frtHours || 0), 0), 0),
          svKeyTag  : first(visits, v => (v.ticket && v.ticket.keyTag) || ""),
          svWhere   : first(visits, v => (v.ticket && v.ticket.location) || ""),
          svPhotos  : visits.reduce((n, v) => n +
                        (v.ticket && v.ticket.activities || [])
                          .reduce((m, a) => m + ((a.photos || []).length), 0), 0),

          /* When the car cleared receiving, from the status log rather than
             from `vriPassedDate` — see vriCompletions() in lib.js for the
             measurements behind that choice. Blank means no inspection on
             record at this centre, which is not the same as not inspected. */
          vriDone   : r.vri && r.vri.at ? day(r.vri.at) : "",
          vriBy     : (r.vri && r.vri.by) || "",

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
        columns: pick([
          { key: "vin",         header: "VIN",              width: 20 },
          { key: "scheduled",   header: "Scheduled delivery", width: 18 },
          { key: "model",       header: "Model",            width: 12 },
          { key: "type",        header: "Vehicle tag",      width: 16 },
          { key: "ownership",   header: "Ownership",        width: 14 },
          { key: "category",    header: "Category",         width: 22 },
          { key: "fleet",       header: "Fleet status",     width: 15 },
          { key: "stage",       header: "Delivery stage",   width: 20 },
          { key: "delivered",   header: "Delivery state",   width: 14 },
          { key: "deliveredOn", header: "Delivered on",     width: 14 },
          { key: "site",        header: "Site",             width: 22 },
          { key: "siteTrt",     header: "Site TRT",         width: 10, type: "number", digits: 0 },
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
          // From the Service App. Blank on a scan that ran without it.
          { key: "svSymptom",   header: "Symptom",          width: 40 },
          { key: "svType",      header: "Concern type",     width: 16 },
          { key: "svCategory",  header: "Concern category", width: 22 },
          { key: "svHours",     header: "Est. hours",       width: 11, type: "number", digits: 1 },
          { key: "svPhotos",    header: "Photos",           width: 8, type: "number", digits: 0 },
          { key: "svKeyTag",    header: "Key tag",          width: 11 },
          { key: "svWhere",     header: "Service centre",   width: 26 },
          // From the status log, not vriPassedDate. Blank = none on record.
          { key: "vriDone",     header: "VRI completed",    width: 14 },
          { key: "vriBy",       header: "VRI by",           width: 18 },
          { key: "ctCount",     header: "Containment count", width: 17, type: "number", digits: 0 },
          { key: "ctTitles",    header: "Containment campaigns", width: 46 },
          { key: "ctAction",    header: "Containment action",    width: 24 },
          { key: "lgCount",     header: "Logistics count",  width: 15, type: "number", digits: 0 },
          { key: "lgReasons",   header: "Logistics reason", width: 24 },
          { key: "lgNotes",     header: "Logistics note",   width: 34 }
        ]),
        rows: sheet
      });

      log(`export: ${sheet.length} rows (${preset}) -> ${label}.xlsx`);
      return sendXlsx(res, buf, label);
    }

    /* ── Tracker ──
       Reads only. The sweep writes to this board's own store and to nothing
       else; not one call in this tool changes anything in Garage. */
    if(p === "/api/trk/scan" && req.method === "POST"){
      const body = await readBody(req);
      const out  = await L.trackerScan({ vin: body.vin || null, date: body.date || null });
      log(`tracker scan: ${out.scope.kind === "vin" ? out.scope.vin : out.scope.date}` +
          ` · ${out.rows.length} cars`);
      return sendJson(res, 200, out);
    }

    /* The recorded path for one car, with stops and legs derived on read. */
    if(p === "/api/trk/path" && req.method === "GET"){
      const vin = String(url.searchParams.get("vin") || "").trim().toUpperCase();
      const out = L.trackerPath(vin);
      if(!out) return sendJson(res, 200, { vin, tracked: false });
      return sendJson(res, 200, { ...out, tracked: true });
    }

    /* One live read of one car. Not part of any sweep — see liveFix(). */
    if(p === "/api/trk/live" && req.method === "POST"){
      const body = await readBody(req);
      const out  = await L.liveFix(body.vin);
      log(`tracker live: ${out.vin} ${out.ok ? "fix" : "no fix — " + out.reason}`);
      return sendJson(res, 200, out);
    }

    /* When a car drove, for the stretches where nobody recorded where. */
    if(p === "/api/trk/drives" && req.method === "GET"){
      const vin = String(url.searchParams.get("vin") || "").trim().toUpperCase();
      const hrs = Number(url.searchParams.get("hours")) || 72;
      return sendJson(res, 200, await L.driveEvents(vin, hrs));
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


    /* ── this centre's billing address ──
       Admin-gated because it is a board setting rather than a per-car action,
       and because getting it wrong would put the wrong address on every car
       switched to Tesla afterwards. */
    if(p === "/api/admin/billing-address" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.saveBillingAddress(body);
      log(out.cleared ? "billing address cleared"
                      : `billing address -> ${out.billingAddress.addressLine1}, ${out.billingAddress.city}`);
      return sendJson(res, 200, { ok: true, ...out });
    }

    /* ── Teams ──
       Admin-gated: the webhook is where a vehicle list gets sent, and the
       posting buttons put a message in a shared chat. */
    if(p === "/api/admin/teams-webhook" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.saveTeamsWebhook(body.webhook);
      // The host, never the URL: the path carries the secret.
      log(out.cleared ? "teams webhook cleared" : `teams webhook -> ${out.host}`);
      return sendJson(res, 200, { ok: true, ...out });
    }

    /* ── the SV Call webhook ──
       Its own key in the file rather than a field on the VRI settings, so
       clearing that one cannot take this with it. Admin-gated for the same
       reason as the other: a webhook URL decides where VINs get posted. */
    if(p === "/api/admin/svcall-webhook" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.saveSvCallWebhook(body.webhook);
      log(out.cleared ? "sv call webhook cleared" : `sv call webhook -> ${out.host}`);
      return sendJson(res, 200, { ok: true, ...out, svcall: L.svCallSettings() });
    }

    /* ── the two messages ──
       Not admin-gated: pressing these is using the board, the way opening a
       trunk is, and gating them would mean unlocking Admin to ask for a car
       to be moved. Each one checks its own claim before it posts — see
       sendSvCall() and sendBodyCall(). */
    if(p === "/api/svcall" && req.method === "POST"){
      const body = await readBody(req);
      const kind = String(body.kind || "onsite");
      const vin  = String(body.vin || "").trim().toUpperCase();
      if(!L.isVin(vin)) return sendJson(res, 400, { error: "A valid VIN is required" });

      if(kind === "body"){
        const out = await L.sendBodyCall({ vin });
        log(`sv call: ${vin} -> body shop (${out.concerns.length} concern${out.concerns.length === 1 ? "" : "s"})`);
        return sendJson(res, 200, out);
      }
      const out = await L.sendSvCall({
        vin,
        svNumbers : String(body.svNumbers || "").slice(0, 120),
        centreName: String(body.centreName || "").slice(0, 120)
      });
      log(`sv call: ${vin} -> onsite from ${out.siteName}`);
      return sendJson(res, 200, out);
    }

    /* The poll URL and the refresh interval. Saved together with the webhook
       and applied at once — the loop restarts itself on every save, so a
       changed interval takes effect without restarting the board. */
    if(p === "/api/admin/teams-settings" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.saveTeamsSettings({
        ...( "pushUrl"    in body ? { pushUrl:    body.pushUrl    } : {} ),
        ...( "hoursOn"    in body ? { hoursOn:    body.hoursOn    } : {} ),
        ...( "openStart"  in body ? { openStart:  body.openStart  } : {} ),
        ...( "openEnd"    in body ? { openEnd:    body.openEnd    } : {} ),
        ...( "openDays"   in body ? { openDays:   body.openDays   } : {} ),
        ...( "autoMinutes" in body ? { autoMinutes: body.autoMinutes } : {} )
      });
      L.startTeamsLoop(log);
      log(`teams: poll ${out.hasPoll ? "on" : "off"} · refresh ` +
          `${out.autoMinutes ? out.autoMinutes + "m" : "off"}`);
      return sendJson(res, 200, out);
    }

    /* Push the rendered card into the row the button flow reads. */
    if(p === "/api/admin/teams-push" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = await L.pushVri();
      log(`teams: pushed ${out.count} cars (${out.site})`);
      return sendJson(res, 200, out);
    }

    if(p === "/api/admin/teams-card" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = await L.postVriControlCard();
      log(`teams: VRI card posted (${out.site})`);
      return sendJson(res, 200, out);
    }

    if(p === "/api/admin/teams-test" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = await L.postVriList();
      log(`teams: VRI list posted · ${out.count} cars (${out.site})`);
      return sendJson(res, 200, out);
    }

    /* ── Tracker settings ──
       Admin-gated because switching tracking on starts a background loop that
       keeps reading the fleet whether or not anybody has the board open. */
    if(p === "/api/admin/tracker" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const s = L.saveTrackerSettings(body.settings || {});
      /* Stop then start on every save, so a changed interval or a flipped
         switch takes effect now rather than at the end of the current wait. */
      L.stopTrackerLoop();
      if(s.enabled) L.startTrackerLoop(log);
      log(`tracker: ${s.enabled ? "on" : "off"} · every ${s.everyMinutes}m · ` +
          `move ${s.minMoveMetres}m · stop ${s.stopMinutes}m · keep ${s.retainDays}d`);
      return sendJson(res, 200, { ok: true, status: L.trackerStatus() });
    }

    if(p === "/api/admin/tracker-status" && req.method === "GET"){
      return sendJson(res, 200, L.trackerStatus());
    }

    /* Sweep on demand. Useful on the first run, when waiting two minutes to
       find out whether the thing works at all is its own small misery. */
    if(p === "/api/admin/tracker-sweep" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = await L.trackerSweep({ log });
      return sendJson(res, 200, { ok: true, ...out, status: L.trackerStatus() });
    }

    if(p === "/api/admin/tracker-forget" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.trackerForgetAll();
      log(`tracker: forgot ${out.forgotten} paths`);
      return sendJson(res, 200, { ok: true, ...out, status: L.trackerStatus() });
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
  // Not a warning: without it the board loses one column, not the tool.
  log(`  sca ${c.sca.detail}`);
  if(c.trtId) log(`  trt ${c.trtId}`);

  /* The Teams loop, if it is configured. Started here rather than on first
     request: the whole point of it is that it runs while nobody is looking at
     the board, so that inspectors on the lot get a card that keeps up. */
  const t = L.teamsSettings();
  if(t.hasWebhook && (t.hasPoll || t.autoMinutes)){
    L.startTeamsLoop(log);
    log(`  teams: poll ${t.hasPoll ? "on" : "off"} · refresh ` +
        `${t.autoMinutes ? t.autoMinutes + "m" : "off"}`);
  }

  /* The Tracker sweep, for the same reason as the Teams loop: a path is only
     worth having if it was being recorded while nobody was watching. Off
     unless somebody pulled the lever — this reads the fleet on a timer, so it
     does not start itself. */
  const k = L.trackerSettings();
  if(k.enabled){
    L.startTrackerLoop(log);
    log(`  tracker: on · every ${k.everyMinutes}m · move ${k.minMoveMetres}m · ` +
        `${L.trackerStatus().cars} cars on record`);
  }else{
    log("  tracker: off");
  }
});

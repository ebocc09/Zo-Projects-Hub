/* The Service App — what a ticket actually says.

   Garage says what a car is and Intrepid says what is wrong with it, but
   neither can tell you what the technician wrote. Intrepid's
   getScaServiceVisitByVin returns a visit header whose `activities`,
   `noteList` and `severityDescription` are always null and whose
   `activityCount` is always 0 — probed across 21 real visits before anyone
   concluded the detail was unreachable. It is not unreachable. It is simply
   not in Intrepid. It is in SCA, and SCA answers Node directly.

   ── the one board-local sign-in, and why ──

   Every other credential in this estate is minted on the Hub and read from the
   shared store: sign in once, every board has it. SCA is the exception, and
   the exception is deliberate rather than an oversight. Nothing else speaks to
   serviceapp.tesla.com, so a Hub row for it would be a sign-in that exactly
   one board could ever use, sitting next to two that all of them use. It lives
   here, next to the only tool that wants it.

   That also keeps credstore.js untouched. That file is copied into every board
   and the Hub is its only writer; adding a key to it means editing five copies
   to serve one consumer.

   ── it is a bearer token, not a cookie ──

   This is why cookie-grabber comes back empty on this host and why the earlier
   look at SCA concluded, wrongly, that the host was dead. There is no session
   cookie. The app mints a JWT at /integration/api/authentication/code/gettoken
   and parks it in `localStorage.SecureToken`. Storage.getCookies — which is
   the whole of connect.js on the Hub — cannot see localStorage, so the grab
   here attaches to the PAGE target and evaluates instead of asking the browser
   target for its jar.

   Everything else about the sign-in is connect.js's arrangement, for
   connect.js's reasons: app-bound encryption and the debug-port lockout make
   reading your everyday Chrome impossible, so an isolated profile with the
   debug port open signs itself in and decrypts its own storage for us. That
   file has the full write-up; it is not repeated here. Same profile
   directory, on purpose — a machine already signed in for Garage or Intrepid
   usually connects SCA with no window appearing at all.

   ── why a decoded token is proof, where a cookie needed a probe ──

   The Hub probes every cookie it captures before adopting it, because Garage
   hands anonymous visitors a _garage_session too: a cookie that exists is not
   a session that works. A bearer JWT has no such failure mode. It cannot be
   minted without a completed SSO round trip, and it states its own expiry,
   its own audience and the roles it carries. Decoding it answers every
   question a probe would have asked, without a network call and without
   hammering SCA every two seconds while somebody types a password.

   ── read-only, and the role is why ──

   The token here carries SCA_All_Default_Create and SCA_PartPick. The write
   paths exist and were mapped out of the app bundle — update an activity,
   change visit motion status, add an activity — but several would 403 on this
   role, and every one of them touches a real customer record. Nothing in this
   file writes. If that changes, it changes with its own decision behind it. */

"use strict";

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { spawn } = require("child_process");

const HOST       = "https://serviceapp.tesla.com";
const SIGNIN_URL = HOST + "/service/service-home";
const DEBUG_PORT = 9222;

/* Treat a token with less than this left as already gone. A scan that starts
   with four minutes on the clock and dies halfway through is worse than one
   that refuses at the door and says why. */
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

/* ────────────────────────────── the token ──────────────────────────────
   Base64url, and Buffer.from tolerates the missing padding. No signature
   check: this is our own token read back out of our own browser, and the only
   questions being asked of it are when it dies and who it belongs to. */

function decode(token){
  try{
    const body = String(token).split(".")[1];
    if(!body) return null;
    const p = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return {
      user : p.UserName || p.unique_name || "",
      id   : p.UserId || null,
      roles: [].concat(p.role || []),
      exp  : p.exp ? new Date(p.exp * 1000).toISOString() : null
    };
  }catch{
    return null;
  }
}

const msLeft = exp => (exp ? new Date(exp).getTime() - Date.now() : 0);
const isLive = sca => Boolean(sca && sca.token && msLeft(sca.exp) > EXPIRY_GRACE_MS);

/* ──────────────────────────── finding a browser ────────────────────────
   Same candidates and same profile path as the Hub's connect.js. The path is
   a convention shared with cookie-grabber, not a dependency on it: if that
   tool has already set this machine up, the profile is signed in and the
   window never opens. Nothing here reads or writes another tool's files. */

const CANDIDATES = [
  { name: "chrome", label: "Chrome", paths: [
    "%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe",
    "%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" ] },
  { name: "edge", label: "Edge", paths: [
    "%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe",
    "%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe" ] }
];

const expand = p => p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || "");

function findBrowser(){
  for(const c of CANDIDATES){
    for(const p of c.paths){
      const full = expand(p);
      if(full && fs.existsSync(full)) return { ...c, exe: full };
    }
  }
  return null;
}

const profileDir = name =>
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "cookie-grabber-profiles", name);

/* ─────────────────────────────── CDP ───────────────────────────────────
   The Hub only ever needed the browser target, because Storage.getCookies
   lives there. localStorage does not: it is per-origin, so this has to find
   the SCA page, attach to it, and evaluate inside it. */

function httpGetJSON(urlPath){
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: DEBUG_PORT, path: urlPath, timeout: 2000 }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e){ reject(new Error("bad JSON from browser: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function portIsLive(){
  try { await httpGetJSON("/json/version"); return true; }
  catch { return false; }
}

/* One request/response over the browser's debugger socket. Node 20+ ships a
   global WebSocket, which is the only reason CDP is reachable here without a
   client library — the same bet connect.js already makes. */
function cdpSession(){
  return httpGetJSON("/json/version").then(v => {
    const wsUrl = v.webSocketDebuggerUrl;
    if(!wsUrl) throw new Error("browser did not advertise a debugger endpoint");

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const pending = new Map();
      let id = 0, settled = false;

      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error("timed out talking to the browser"));
      }, 15000);

      ws.addEventListener("open", () => {
        settled = true;
        clearTimeout(timer);
        resolve({
          send(method, params = {}, sessionId){
            const n = ++id;
            return new Promise((res, rej) => {
              pending.set(n, { res, rej });
              ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
            });
          },
          close(){ try { ws.close(); } catch {} }
        });
      });

      ws.addEventListener("message", ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if(!msg.id || !pending.has(msg.id)) return;
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message || "CDP error")) : res(msg.result);
      });

      ws.addEventListener("error", () => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("could not open a debugger connection to the browser"));
      });
    });
  });
}

/* Reads SecureToken out of whichever SCA tab is open. Returns the same
   {ok, reason, detail} shape connect.js uses, because the panel turns each
   reason into a different next step for the user. */
async function grabToken(){
  if(!(await portIsLive())){
    return { ok: false, reason: "no-window",
             detail: "No Service App sign-in window is open." };
  }

  let targets;
  try { targets = await httpGetJSON("/json/list"); }
  catch(err){ return { ok: false, reason: "cdp", detail: err.message }; }

  const page = (targets || []).find(t =>
    t.type === "page" && String(t.url || "").includes("serviceapp.tesla.com"));
  if(!page){
    return { ok: false, reason: "not-signed-in",
             detail: "The window is open but no Service App tab is loaded yet." };
  }

  let sess;
  try{
    sess = await cdpSession();
    const { sessionId } = await sess.send("Target.attachToTarget",
      { targetId: page.id, flatten: true });
    const r = await sess.send("Runtime.evaluate",
      { expression: 'localStorage.getItem("SecureToken")', returnByValue: true }, sessionId);

    /* The app stores it JSON-encoded, so the raw value arrives wrapped in
       quotes. Parse when it looks like JSON and fall back to the literal, so
       a future version that stores it bare still works. */
    const raw = r && r.result && r.result.value;
    if(!raw){
      return { ok: false, reason: "not-signed-in",
               detail: "The Service App tab is open but nobody has signed in yet." };
    }
    let token = String(raw);
    if(token.startsWith('"')){ try { token = JSON.parse(token); } catch { /* keep literal */ } }

    /* ── the second credential ──
       TSS — the scheduling app behind the appointment screen — does not accept
       the SecureToken bearer. It wants the `access_token` cookie, sent raw with
       no scheme, and it lives on a different host. Grabbed here so one Connect
       covers both; see cancelAppointment() for what it is for. */
    let accessToken = "";
    try{
      const jar = await sess.send("Storage.getCookies");
      const hit = (jar.cookies || []).find(c =>
        c.name === "access_token" && /serviceapp\.tesla\.com/.test(String(c.domain)));
      if(hit) accessToken = hit.value;
    }catch{ /* TSS calls will say so when they fail */ }

    const info = decode(token);
    if(!info){
      return { ok: false, reason: "bad-token",
               detail: "Found a SecureToken that does not decode as a JWT." };
    }
    if(msLeft(info.exp) <= 0){
      // A tab left open overnight still holds yesterday's token. Adopting it
      // would report success and then fail on the first scan.
      return { ok: false, reason: "expired",
               detail: "The token in that tab has already expired — reload the Service App tab." };
    }
    return { ok: true, token, accessToken, ...info };
  }catch(err){
    return { ok: false, reason: "cdp", detail: err.message };
  }finally{
    if(sess) sess.close();
  }
}

/* Opens the isolated window at SCA's home. Detached, so closing the board does
   not kill a browser somebody is mid-sign-in on. A second launch against the
   same --user-data-dir becomes a tab in the existing window rather than a
   second browser, which is what makes one profile cover every source. */
function openSignInWindow(){
  const browser = findBrowser();
  if(!browser){
    const err = new Error("No Chrome or Edge found to open a sign-in window with");
    err.noBrowser = true;
    throw err;
  }

  const dir = profileDir(browser.name);
  fs.mkdirSync(dir, { recursive: true });

  const child = spawn(browser.exe, [
    "--user-data-dir=" + dir,
    "--remote-debugging-port=" + DEBUG_PORT,
    // Chrome refuses WebSocket upgrades from unexpected origins without this.
    "--remote-allow-origins=*",
    SIGNIN_URL
  ], { detached: true, stdio: "ignore" });
  child.unref();

  return { browser: browser.label, profileDir: dir, url: SIGNIN_URL };
}

async function browserStatus(){
  const browser = findBrowser();
  return {
    browser  : browser ? browser.label : null,
    windowUp : await portIsLive(),
    supported: Boolean(browser)
  };
}

/* ─────────────────────── the sign-in state machine ─────────────────────
   Server-side and pollable, for the reason the Hub's signin.js gives: a
   sign-in takes as long as it takes, and a page that gets closed mid-flow must
   not abandon a capture that is seconds from succeeding. The panel polls and
   can be closed and reopened without affecting it.

     idle → verifying → waiting → connected
                            ↘ failed / cancelled

   `verifying` first, before anything opens: the shared profile is often signed
   in already, in which case the whole thing is over before the click finishes
   and no window appears.

   Storage is NOT done here. lib.js owns .connections.json and stays its only
   writer; this takes a commit callback and hands the token over. */

const POLL_MS     = 2_000;
const DEADLINE_MS = 3 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const IDLE = { phase: "idle", detail: null, error: null, since: null, browser: null };
let attempt = { ...IDLE };
let cancelled = false;

const busy = () => ["verifying", "opening", "waiting"].includes(attempt.phase);

function setPhase(phase, detail, extra = {}){
  attempt = { ...attempt, phase, detail: detail || null, ...extra };
  return attempt;
}

function signInStatus(){
  return { phase: attempt.phase, detail: attempt.detail,
           error: attempt.error, since: attempt.since, browser: attempt.browser };
}

function cancelSignIn(){
  if(busy()){ cancelled = true; setPhase("cancelled", "Cancelled."); }
  return signInStatus();
}

/* Kicks off and returns immediately — the caller answers the HTTP request
   while this runs on. Never rejects: a failure is a phase, not an exception,
   because nobody is awaiting it. */
function beginSignIn(commit){
  if(busy()) return signInStatus();

  cancelled = false;
  setPhase("verifying", "Checking whether this machine is already signed in…",
           { error: null, since: new Date().toISOString(), browser: null });

  (async () => {
    try{
      // Already signed in? Then there is nothing to open.
      const first = await grabToken();
      if(first.ok){
        commit(first);
        return setPhase("connected", `Signed in as ${first.user}.`);
      }

      const b = findBrowser();
      if(!b){
        return setPhase("failed", null,
          { error: "No Chrome or Edge found to open a sign-in window with." });
      }

      const alreadyUp = await portIsLive();
      openSignInWindow();
      setPhase("waiting",
        alreadyUp ? "A Service App tab just opened — sign in there."
                  : `${b.label} is opening — sign in to the Service App there.`,
        { browser: b.label });

      const deadline = Date.now() + DEADLINE_MS;
      while(Date.now() < deadline){
        if(cancelled) return;
        await sleep(POLL_MS);
        if(cancelled) return;

        const got = await grabToken();
        if(got.ok){
          commit(got);
          return setPhase("connected", `Signed in as ${got.user}.`);
        }
        // "expired" is the one reason worth surfacing while waiting: the user
        // is staring at a tab that looks signed in and nothing is happening.
        if(got.reason === "expired") setPhase("waiting", got.detail, { browser: b.label });
      }

      setPhase("failed", null,
        { error: "Gave up waiting after three minutes. Press Connect to try again." });
    }catch(err){
      setPhase("failed", null, { error: err.message || "Sign-in failed." });
    }
  })();

  return signInStatus();
}

/* ────────────────────────────── reading SCA ────────────────────────────
   Its own small GET rather than lib.js's request(), so this file stays
   self-contained and lib.js does not have to export its plumbing. The same
   trade credstore.js and xlsx.js already make across the estate. */

function getJson(token, pathAndQuery){
  return new Promise((resolve, reject) => {
    const u = new URL(HOST + pathAndQuery);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode === 401 || res.statusCode === 403){
          const err = new Error(res.statusCode === 401
            ? "Service App token expired or rejected — connect SCA again"
            : "Service App refused this request for your role");
          err.needsSca = res.statusCode === 401;
          return reject(err);
        }
        if(res.statusCode !== 200){
          return reject(new Error(`Service App HTTP ${res.statusCode}: ${buf.slice(0, 160)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error("Service App did not return JSON")); }
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.end();
  });
}

/* SCA wraps everything in an envelope: {success, message, responseObject}. */
const unwrap = j => (j && Object.prototype.hasOwnProperty.call(j, "responseObject")
  ? j.responseObject : j);

const visitsByVin = (token, vin) =>
  getJson(token, `/case/api/visit/VIN/${encodeURIComponent(vin)}` +
                 `?includeActivities=true&includeContact=true&includeTags=true`)
    .then(j => unwrap(j) || []);

const activitiesOf = (token, svid) =>
  getJson(token, `/case/api/visit/${encodeURIComponent(svid)}/activities`)
    .then(j => unwrap(j) || []);

/* ── what the row actually shows ──

   Two calls per VIN, not one. The scan already holds Intrepid's
   serviceVisitID and could go straight to /activities with it, but that rests
   on Intrepid's id being byte-identical to SCA's — inferred from matching
   ranges, never proven. Going in by VIN needs no such assumption and keeps
   working if the two namespaces ever drift. Only vehicles that already have a
   visit get here, so a 600-car centre with 40 visits costs ~80 calls.

   Only the fields the board renders come back. The visit header also carries
   the customer's contact block, which has no business leaving the server —
   the same line the existing scan already draws. */

/* ── open only ──

   `serviceVisitStatusID` / `activityStatusID` of 1 is open, 2 is closed. SCA's
   own product-details page lists only the open ones; `/case/api/visit/VIN/`
   returns everything ever, which is how a closed Body Shop Referral from a
   week earlier can look like a second live visit.

   The board never showed closed work — Intrepid only returns active visits and
   the match below drops the rest — but that was luck rather than intent, and
   it would stop being true the moment enumeration moved to SCA. Ed's rule is
   flat: only ever work on open tickets. So it is enforced here, at the point
   the data enters, rather than left to a coincidence upstream. */
const OPEN = 1;
const isOpenVisit = v => Number(v.serviceVisitStatusID) === OPEN;
const isOpenAct   = a => Number(a.activityStatusID) === OPEN;

/* Returns `{ open, closed }`, not just the open ones.

   The closed list matters because the board does not enumerate visits from
   here — Intrepid does — and the two disagree. Measured on 7SAYGDED5TA746273,
   visit SV02D766C2: Intrepid reports serviceVisitStatusID 1 and SCA reports 2
   for the same visit, so a finished car stays on the work list. Absent from
   `open` is not enough on its own to act on, because it also covers a visit
   SCA has never heard of; `closed` says SCA knows it and calls it done. */
async function ticketFor(token, vin){
  const empty = { open: [], closed: [] };
  const all = await visitsByVin(token, vin);
  if(!Array.isArray(all) || !all.length) return empty;

  const closed = all.filter(v => !isOpenVisit(v)).map(v => ({
    svId    : v.serviceVisitID || null,
    number  : v.serviceVisitNumber || "",
    statusId: v.serviceVisitStatusID ?? null
  }));

  const visits = all.filter(isOpenVisit);
  if(!visits.length) return { open: [], closed };

  const open = await Promise.all(visits.map(async v => {
    const acts = await activitiesOf(token, v.serviceVisitID).catch(() => []);
    return {
      svId    : v.serviceVisitID || null,
      number  : v.serviceVisitNumber || "",
      /* Carried so a caller can refuse to write to anything that is not open,
         without having to re-read the record to find out. */
      statusId: v.serviceVisitStatusID ?? null,
      /* Null once the appointment is cancelled, which is the state — and the
         only state — in which the location can be changed. */
      appointmentId: v.appointmentID ?? null,
      /* The account segment of SCA's own URL. Every earlier attempt to build
         that link failed for want of this one value, which is not in Garage
         and not in Intrepid — it was in the visit header the whole time. */
      userId  : v.userId || null,
      keyTag  : v.keyTag || "",
      location: v.locationDescription || "",
      booked  : v.serviceVisitDateTime || null,
      checkIn : v.checkInDateTime || null,
      source  : v.serviceVisitSourceID || "",
      /* The centre that OWNS the visit, which can differ from where the car is
         standing — worth carrying even though nothing renders it yet. */
      trt     : v.trtid || null,
      activities: (Array.isArray(acts) ? acts : []).filter(isOpenAct).map(a => ({
        id       : a.activityID || null,
        number   : a.activityNumber || "",
        statusId : a.activityStatusID ?? null,
        narrative: a.narrative || "",
        symptom  : a.symptomDescription || "",
        hyper    : a.hyperSymptom || "",
        category : a.description || "",
        /* The three the concern editor needs and nothing else does: which
           symptom this is, and which model's catalogue to search. SCA scopes
           its own picker by `modelID` off the activity, so the board does
           too — the same words are not on offer against every car. */
        symptomId  : a.symptomID ?? null,
        symptomCode: a.symptomCode || "",
        modelId    : a.modelID ?? null,
        cosmetic : a.cosmeticIssue === "Yes",
        frtHours : typeof a.estimatedFRTHours === "number" ? a.estimatedFRTHours : null,
        /* Ids and names only. A single one of these came back 3.4 MB, so a
           scan that fetched them would move a hundred megabytes to render a
           list nobody has clicked on yet. The bytes are fetched one at a time
           when someone opens the viewer — see photoStream(). */
        photos   : (Array.isArray(a.attachments) ? a.attachments : [])
                     .filter(t => t && t.attachmentID)
                     .map(t => ({ id: t.attachmentID, name: t.fileName || "image" })),
        createdBy: a.createByUserName || "",
        changedBy: a.modifyByUserName || "",
        changedAt: a.modifyDate || null
      }))
    };
  }));
  return { open, closed };
}

/* ── the photos on a concern ──

   Streamed through the board rather than linked directly, for two reasons
   that both matter. The bearer token would otherwise have to reach the page
   to authorise an <img>, and a credential that never leaves the server cannot
   be leaked by one. And SCA answers these on `document/api`, a different base
   from every other call here, which is worth having in exactly one place.

   Piped rather than buffered: these run to several megabytes each and there is
   no reason for the whole of one to sit in the board's memory on the way past.
   The caller gets the upstream response to pipe at its own writable.

   `interceptionexcluded=true` is copied from the app's own call, not guessed.
   There is a downloadthumbnailfilebyid twin, but it 404s wherever
   `thumbnailPath` is null, which was every attachment sampled — so the full
   image is the only size that reliably exists. */

const DOC_API = "https://serviceapp.tesla.com/document/api/";

function photoStream(token, attachmentId){
  return new Promise((resolve, reject) => {
    const u = new URL(`${DOC_API}Attachment/downloadfilebyid/` +
                      `${encodeURIComponent(attachmentId)}?interceptionexcluded=true`);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "image/*,application/octet-stream" }
    }, res => resolve(res));
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.end();
  });
}

/* ── the site list behind the picker ──

   `trt/trtbyterm` is on integration/api — a third base after case/api and
   document/api. It returns both ids the move needs: `scaLocationID` and
   `trtid`. Neither can be derived from the other, so both are kept.

   Filtered to Service, SemiServiceCenter and BodyRepair. SCA's own picker
   omits BodyRepair, which would rule out the Collision moves this exists for.
   Mobile, Energy, Warehouse and the Robotics types are dropped, as are the
   retired rows — the search returns a dozen or so named "DO NOT USE …
   -CLOSED", and "Collision" alone comes back with 97 rows. */

const SITE_TYPES = new Set([
  1,    // Service
  41,   // SemiServiceCenter
  30    // BodyRepair — Tesla Collision. Not in SCA's own filter; see above.
]);
const RETIRED = /do not use|closed/i;

function postJson(token, base, pathAndQuery, body){
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body == null ? {} : body);
    const u = new URL(base + pathAndQuery);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
                 "Content-Type": "application/json",
                 "Content-Length": Buffer.byteLength(payload) }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        if(res.statusCode !== 200)
          return reject(new Error(`Service App HTTP ${res.statusCode}: ${buf.slice(0, 160)}`));
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error("Service App did not return JSON")); }
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

async function sites(token, term){
  const q = String(term || "").trim();
  // The app's own picker waits for two characters. One would return most of
  // the estate and be useless to scroll.
  if(q.length < 2) return [];
  const j = await postJson(token, "https://serviceapp.tesla.com/integration/api/",
                           "trt/trtbyterm", { term: q });
  const rows = (j && j.responseObject) || [];
  return rows
    .filter(r => r && r.scaLocationID && SITE_TYPES.has(Number(r.scaLocationTypeID)))
    .filter(r => !RETIRED.test(r.description || ""))
    .map(r => ({
      scaLocationId: r.scaLocationID,
      trtId        : r.trtid ?? null,
      name         : r.description || "",
      typeId       : r.scaLocationTypeID ?? null,
      /* The move needs these two as well and neither can be derived from the
         scaLocationID — they only ever arrive together, from here. */
      functionId         : r.functionID ?? null,
      inventoryLocationId: r.inventoryLocationID ?? null
    }))
    // Both ids are required by the move; a row missing one cannot be offered.
    .filter(r => r.trtId != null);
}

/* ── SCA's own symptom catalogue ──

   The list the app's concern picker searches as you type, and it is long:
   "fend" returns 373 rows at Cypress, "glass" over a thousand. There is no
   sense in the board keeping a copy of that, and a copy would be wrong the
   first time Tesla added a symptom.

   ```
   POST /integration/api/persona/symptom/search?modelId=<n>&locale=
        { term: "fend" }  →  responseObject[] of { symptomID, symptomCode, symptomName }
   ```

   **Scoped by model, and the model comes off the activity.** SCA passes
   `caseActivityDTO.activityDTO.modelID` — a number, 36 for a Model 3 — and
   the catalogue differs between them: a Cybertruck has no frunk latch symptom
   in the same words a 3 does. Searching unscoped would offer symptoms that
   cannot be saved against this car.

   Found in the bundle rather than guessed, like everything else on this host:
   `getSymptomByTerm()` in the integration service. Read-only. */
async function symptoms(token, { term, modelId }){
  const q = String(term || "").trim();
  // Two characters, the same floor the app's own picker uses. One would
  // return most of the catalogue and be useless to scroll.
  if(q.length < 2) return [];

  const j = await postJson(token, "https://serviceapp.tesla.com/integration/api/",
    // en-US, the locale SCA's own picker sends. The catalogue carries
    // translations and an empty locale is not the same request.
    `persona/symptom/search?modelId=${encodeURIComponent(modelId || "")}&locale=en-US`,
    { term: q });

  const rows = (j && j.responseObject) || [];
  const out = [];
  const seen = new Set();
  for(const r of rows){
    if(!r || !r.symptomCode) continue;
    /* De-duplicated on the code, which is what SCA's own picker does — the
       catalogue returns the same symptom more than once when it is mapped to
       several part groups. */
    if(seen.has(r.symptomCode)) continue;
    seen.add(r.symptomCode);
    out.push({
      symptomId  : r.symptomID ?? null,
      symptomCode: r.symptomCode,
      name       : r.symptomName || r.symptomDescription || "",
      hyper      : r.hyperSymptom || ""
    });
  }
  return out;
}

/* One symptom in full, which the search deliberately does not give you.

   `GET /integration/api/persona/symptom/<symptomCode>/<modelId>` — note the
   order: code first, model second. The other way round answers "Record not
   found", which is how that was established.

   It matters because two fields on a concern move WITH the symptom and are
   not in the search results: `additionalAttributes.cosmeticIssue` and
   `reportingAttribute.hyperSymptom`. SCA's own dialog reads exactly these two
   when you pick a symptom — the assignment is right there in the bundle — and
   the capture proved it: picking "FIXED GLASS ROOF to BACKLITE GLASS [ Gap ]"
   sent `cosmeticIssue: "Yes"`, and this endpoint is the only place that "Yes"
   exists. Without it the board would carry the old classification onto the
   new symptom and quietly misfile the car, since hyperSymptom is what the
   concern filter groups by. */
async function symptomDetail(token, { symptomCode, modelId }){
  const j = await getJson(token,
    `/integration/api/persona/symptom/${encodeURIComponent(symptomCode)}` +
    `/${encodeURIComponent(modelId)}?locale=en-US`);
  const o = (j && j.responseObject) || null;
  const one = Array.isArray(o) ? o[0] : o;
  if(!one) return null;
  return {
    symptomId  : one.symptomID ?? null,
    symptomCode: one.symptomCode || symptomCode,
    name       : one.symptomName || "",
    /* Both defaulted the way SCA defaults them: its own code falls back to a
       constant when the attribute is missing rather than leaving the field
       null, and a null here would be written onto the record. */
    cosmetic   : (one.additionalAttributes && one.additionalAttributes.cosmeticIssue) || "No",
    hyper      : (one.reportingAttribute && one.reportingAttribute.hyperSymptom) || ""
  };
}

/* ── the activity record, in the shape the update wants it back ──

   `POST /activity/api/activity/visit/<svid>/activities` returns one wrapper
   per activity — `{vin, userID, modelCode, assetType, activityDTO,
   correctionPartDTO, …}` — and the update PUT sends the first six of those
   keys straight back.

   **`includeParts=true` is not optional.** The PUT carries
   `correctionPartDTO`, which on the captured ticket was a correction line
   holding an $850 backlite glass and two more parts. Read it without the
   parts and the body echoes an empty one, and a whole-object PUT writes
   whatever is wrong in it. That is the same trap that made the visit move
   read the record instead of a form. */
async function activityWrappers(token, serviceVisitId){
  const j = await postJson(token, "https://serviceapp.tesla.com/activity/api/",
    `activity/visit/${encodeURIComponent(serviceVisitId)}/activities` +
    `?locale=en_US&includeParts=true&includeNotes=true&includeActivityApproval=true`,
    { data: [], pageNumber: 1, pageSize: 50, filterDTOs: [] });
  const rows = (j && j.responseObject && j.responseObject.data) || [];
  return rows.filter(w => w && w.activityDTO);
}

/* ── taking a line off a visit ──

   ```
   POST /case/api/visit/<svid>/removeactivities   body [<activityID>]
   ```

   **This is not `cancelActivity` and the difference is the whole point.**
   Cancelling closes the ticket and disturbs billing — the thing this board
   has been told twice never to do. This returns the activity to *outstanding
   work*: SCA's own label for the button is
   `activity_remove_and_return_to_outstanding_work`. The concern survives, it
   is simply no longer on this visit, and it can be added back.

   Captured off SCA's own UI rather than inferred, and proved by re-reading:
   the visit went from two activities to one and the remaining ticket was
   untouched. */
async function removeActivity(token, { serviceVisitId, activityId }){
  /* Read first, and refuse if the line is not on the visit.

     Without this the check afterwards is worth nothing: "it is not on the
     visit now" is also true of an activity that was never on it, so removing
     something already gone would report a confident success. A stale tab is
     exactly the caller that would do that. */
  const before = await activityWrappers(token, serviceVisitId);
  if(!before.some(w => Number(w.activityDTO.activityID) === Number(activityId))){
    const e = new Error("That line is not on this visit any more — re-run the scan.");
    e.gone = true;
    throw e;
  }

  const j = await postJson(token, "https://serviceapp.tesla.com/case/api/",
    `visit/${encodeURIComponent(serviceVisitId)}/removeactivities`, [Number(activityId)]);

  /* Never trust a 200 from SCA. It answers success:true while doing something
     else — that is exactly how cancelServiceVisits closed a ticket — so the
     record is read back and the answer is what the read says, not what the
     write claimed. */
  const ok = Boolean(j && j.success);
  const after = await activityWrappers(token, serviceVisitId).catch(() => null);
  const gone = after ? !after.some(w => Number(w.activityDTO.activityID) === Number(activityId)) : null;

  return {
    ok: ok && gone === true,
    said: (j && (j.localizedMessage || j.message)) || "",
    /* Three states, not two. `null` is "the write said yes and the re-read
       failed", which is neither a success to report nor a failure to retry —
       and saying so is better than picking one. */
    verified: gone,
    remaining: after ? after.length : null
  };
}

/* ── changing what a concern says ──

   ```
   PUT /case/api/case/activities/update/<activityID>?preventOverride=false
   ```

   The whole activity, echoed back with five fields changed. SCA's own dialog
   builds that body from its form state; this one builds it from the record it
   just read and touches only what the new symptom decides:

     symptomID · symptomCode · symptomDescription   the symptom itself
     cosmeticIssue · hyperSymptom                   its classification

   Everything else — the narrative, the corrections, the parts, the estimate,
   every id — goes back exactly as it came. Echoing the record is strictly
   safer than reproducing a form, and on this host it is the difference
   between an edit and a rewrite.

   SCA follows its own PUT with an `activityextension/add` and a second PUT at
   `preventOverride=true`. Neither is sent here: the capture shows the first
   PUT already returns the new symptom on the record, and the extension call
   carried nothing but nulls. Fewer writes, and none of them guessed. */
async function setSymptom(token, { serviceVisitId, activityId, symptomCode }){
  const wraps = await activityWrappers(token, serviceVisitId);
  const wrap = wraps.find(w => Number(w.activityDTO.activityID) === Number(activityId));
  if(!wrap){
    const e = new Error("That concern is no longer on this visit — re-run the scan.");
    e.gone = true;
    throw e;
  }

  const dto = wrap.activityDTO;
  const detail = await symptomDetail(token, { symptomCode, modelId: dto.modelID });
  if(!detail){
    throw new Error(`The Service App does not know symptom ${symptomCode} for this model.`);
  }

  const body = {
    vin      : wrap.vin,
    userID   : wrap.userID,
    modelCode: wrap.modelCode ?? null,
    assetType: wrap.assetType,
    activityDTO: {
      ...dto,
      symptomID         : detail.symptomId,
      symptomCode       : detail.symptomCode,
      symptomDescription: detail.name,
      cosmeticIssue     : detail.cosmetic,
      // Only when the catalogue has an opinion. Blanking a classification the
      // new symptom simply does not carry would lose a fact rather than
      // correct one.
      hyperSymptom      : detail.hyper || dto.hyperSymptom
    },
    correctionPartDTO: wrap.correctionPartDTO ?? null
  };

  const j = await putJsonAbs(token,
    `/case/api/case/activities/update/${encodeURIComponent(activityId)}?preventOverride=false`,
    body);

  const said = (j.body && (j.body.localizedMessage || j.body.message)) || "";
  if(!(j.status === 200 && j.body && j.body.success)){
    throw new Error(said || `The Service App refused the change (HTTP ${j.status}).`);
  }

  // Read back, because a 200 on this host is a claim rather than a fact.
  const after = await activityWrappers(token, serviceVisitId).catch(() => null);
  const now = after && after.find(w => Number(w.activityDTO.activityID) === Number(activityId));
  return {
    ok      : true,
    said,
    verified: now ? String(now.activityDTO.symptomCode) === String(detail.symptomCode) : null,
    symptom : now ? now.activityDTO.symptomDescription : detail.name,
    hyper   : now ? now.activityDTO.hyperSymptom : detail.hyper,
    cosmetic: now ? now.activityDTO.cosmeticIssue : detail.cosmetic
  };
}

/* A PUT to an absolute path on this host, returning the status alongside the
   body — the two writes above both have to judge on `success`, not on 200. */
function putJsonAbs(token, path, body){
  return new Promise((resolve, reject) => {
    const pl = JSON.stringify(body);
    const req = https.request({
      hostname: "serviceapp.tesla.com", port: 443, path, method: "PUT",
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
                 "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        let b = null;
        try { b = JSON.parse(buf); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: b, raw: buf.slice(0, 300) });
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.write(pl);
    req.end();
  });
}

/* ── moving a visit to another centre ──

   The one write this board makes to a service record.

   Two hard-won facts, both of which cost a session to learn and neither of
   which is guessable:

   1. It is VISIT-level, not activity-level. The obvious-looking
      `location/trt/updateactivityscaLocation/{activityId}/{scaLocationId}` is
      the wrong call: SCA answers **200 with `success:false`** — "Activity
      already in a Service Visit. Please move to outstanding to complete
      action." Its own UI renders that picker on the visit page regardless, so
      the control being there proves nothing.

   2. The visit must be UNSCHEDULED — `appointmentID: null`. Cancelling the
      appointment in SCA is what produces that state, and it is the same thing
      the error above means by "move to outstanding". Cancelling the
      APPOINTMENT is not cancelling the TICKET: closing a ticket disturbs
      billing, and nothing in this file will ever do it.

   A 200 is not success. The envelope carries its own `success`, and even that
   is not trusted — the caller re-reads the visit. */

/* ── contacts on a visit ──

   `contactType` 1 is the main contact, 2 is billing. A pre-delivery car
   usually arrives with the customer on 1 and Tesla Motors Inventory already on
   2, and the job is to put Tesla on 1 as well.

   The Tesla contact is NOT a fixed record and must never be hardcoded. Across
   two cars it appeared as "Tesla Motors / Inventory" with
   teslamotorsnorthamerica@tesla.com / +16506817000, and as "Tesla / Motors
   Inventory" with …@noemailonfile.tesla.com / +1650-681-9999. Different
   contactIDs, different addresses. It is read per car from the customer's own
   contact list, which already contains it. */

const contactsForCar = (token, userId, vin) =>
  getJson(token, `/case/api/servicevisitcontacts/getcontactsbycustomer` +
                 `?userId=${encodeURIComponent(userId)}&vin=${encodeURIComponent(vin)}&productType=1`)
    .then(j => unwrap(j) || []);

const contactOnVisit = (token, serviceVisitId, contactType) =>
  getJson(token, `/case/api/servicevisitcontacts/getcontacts` +
                 `?serviceVisitID=${encodeURIComponent(serviceVisitId)}` +
                 `&contactType=${encodeURIComponent(contactType)}&interceptionexcluded=true`)
    .then(j => unwrap(j) || null)
    .catch(() => null);   // "Record not found" for a type the car does not use

/* Which of a car's contacts is the Tesla one. Matched on the tesla.com email
   domain rather than the name: the name is spelled two different ways across
   the cars sampled, the domain is not. Name is the fallback. */
/* One definition of "this is the Tesla contact", used by the picker match, the
   already-Tesla guard, the read-back check and the panel — so they cannot
   disagree.

   Keyed on the email DOMAIN, not the contactID. Saving a contact onto a visit
   does not reference the source record: SCA copies it and mints a new id. On
   one car the picker listed Tesla as 64031153 while the visit carried 64598205
   for the same contact, so an id comparison is always wrong after a save.

   Anchored to the end of the address so a customer at `teslafan@gmail.com`
   cannot be mistaken for Tesla. The name is a fallback because the spelling
   varies — "Tesla Motors / Inventory" on one car, "Tesla / Motors Inventory"
   on another. */
const isTeslaContact = c => Boolean(c &&
  (/@(?:[a-z0-9.-]*\.)?tesla\.com$/i.test(String(c.email || "")) ||
   /tesla motors inventory/i.test(`${c.firstName || ""} ${c.lastName || ""}`)));

function teslaContactIn(list){
  return (Array.isArray(list) ? list : []).find(isTeslaContact) || null;
}

/* Save one contact onto a visit. The body shape is SCA's own, captured off
   its UI — the empty strings are what it sends, not placeholders to tidy. */
function saveContact(token, serviceVisitId, contactType, c){
  const body = {
    serviceVisitId: Number(serviceVisitId), asset: null, assetId: null,
    contacts: [{
      contactType: Number(contactType),
      preferredContactMethodID: 1,
      contacts: {
        contactID  : c.contactID,
        firstName  : c.firstName || "",
        lastName   : c.lastName || "",
        email      : c.email || "",
        phoneNumber: c.phoneNumber || "",
        erpCustomerID: "", vatNumber: "", idNumber: "", fiscalCode: "",
        companyCode: "", preferredLanguage: c.preferredLanguage || "en_US",
        companyName: c.companyName || "", payerType: c.payerType ?? 0
      },
      preferredLanguage: c.preferredLanguage || "en_US",
      billingContactDetailDto: null,
      isB2BCustomer: null
    }]
  };
  return new Promise((resolve, reject) => {
    const pl = JSON.stringify(body);
    const req = https.request({
      hostname: "serviceapp.tesla.com", port: 443,
      path: "/case/api/servicevisitcontacts/savecontacts/", method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
                 "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) }
    }, res => {
      let buf = "";
      res.on("data", x => buf += x);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        let b = null;
        try { b = JSON.parse(buf); } catch { /* leave null */ }
        resolve({ status: res.statusCode,
                  ok: res.statusCode === 200 && Boolean(b && b.success),
                  message: (b && (b.localizedMessage || b.message)) || buf.slice(0, 200) });
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.write(pl);
    req.end();
  });
}

/* The customer profile, for the two fields the address write needs and
   nothing else carries: `assetId` and the model string SCA calls `asset`. */
const carAsset = (token, userId, vin, serviceVisitId) =>
  getJson(token, `/case/api/customerinformation/profile?userId=${encodeURIComponent(userId)}` +
                 `&vin=${encodeURIComponent(vin)}&productType=1&refreshCache=false` +
                 `&serviceVisitId=${encodeURIComponent(serviceVisitId)}`)
    .then(j => {
      const o = unwrap(j) || {};
      return {
        assetId: o.assetId ?? o.vehicleMapId ?? null,
        asset  : (o.vehicleDetails && o.vehicleDetails.model) || null
      };
    })
    .catch(() => ({ assetId: null, asset: null }));

/* Set the billing address on a visit. Body shape captured off SCA's own UI —
   the empty `county` and the zeroed ids are what it sends. */
function saveAddress(token, serviceVisitId, contactType, address, assetInfo){
  const body = {
    serviceVisitId: Number(serviceVisitId),
    addresses: [{
      contactType: Number(contactType),
      accountId: null,
      asset  : (assetInfo && assetInfo.asset) || null,
      assetId: (assetInfo && assetInfo.assetId != null) ? String(assetInfo.assetId) : null,
      address
    }]
  };
  return new Promise((resolve, reject) => {
    const pl = JSON.stringify(body);
    const req = https.request({
      hostname: "serviceapp.tesla.com", port: 443,
      path: "/case/api/servicevisitcontacts/saveaddress", method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
                 "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) }
    }, res => {
      let buf = "";
      res.on("data", x => buf += x);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        let b = null;
        try { b = JSON.parse(buf); } catch { /* leave null */ }
        resolve({ status: res.statusCode,
                  ok: res.statusCode === 200 && Boolean(b && b.success),
                  message: (b && (b.localizedMessage || b.message)) || buf.slice(0, 200) });
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.write(pl);
    req.end();
  });
}

const addressOnVisit = (token, serviceVisitId, contactType) =>
  getJson(token, `/case/api/servicevisitcontacts/getaddress` +
                 `?serviceVisitID=${encodeURIComponent(serviceVisitId)}` +
                 `&contactType=${encodeURIComponent(contactType)}`)
    .then(j => unwrap(j) || null)
    .catch(() => null);

/* ── the whole visit, as SCA reads it back ──
   The body source for a move. Same 132-field shape the app PUTs, which is the
   entire reason a read-modify-write here is safe. */
const visitById = (token, serviceVisitId) =>
  getJson(token, `/case/api/visit/${encodeURIComponent(serviceVisitId)}`).then(unwrap);

/* ── cancelling the APPOINTMENT ──

   Not the visit, and emphatically not the ticket. This is the call SCA's own
   UI makes, captured off the wire — `servicevisit/cancelServiceVisits`, which
   reads like the obvious candidate, cancels the visit AND its open tickets and
   must never be used.

   It lives on TSS: a different host, and a different credential. Not the
   SecureToken bearer — the raw `access_token` cookie with no scheme, plus a
   Calling-Application header. Getting any of that wrong returns 401
   "Unauthorized user!", which is how this was eventually pinned down.

   The feedback block is the reason SCA files against the cancellation; the
   values are the ones its own dialog sends. */
function cancelAppointment(accessToken, appointmentId, serviceVisitId){
  return new Promise((resolve, reject) => {
    const pl = JSON.stringify({
      appointmentId,
      feedback: { id: 29, type: "CANCEL_SERVICEVISIT",
                  description: "Duplicate or aging Service Visit", comment: "" },
      isIncludeEmailNotification: false,
      serviceVisitId
    });
    const req = https.request({
      hostname: "tss.tesla.com", port: 443,
      path: "/react/api/proxy/api/Service/CancelAppointment", method: "POST",
      headers: { Authorization: accessToken, Accept: "application/json, text/plain, */*",
                 "Calling-Application": "TSS-Components (SCA)", UserId: "150",
                 Referer: "https://serviceapp.tesla.com/",
                 "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(buf); } catch { /* leave null */ }
        resolve({
          status : res.statusCode,
          ok     : res.statusCode === 200 && Boolean(body && body.success),
          message: (body && (body.message || body.response)) || buf.slice(0, 200)
        });
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.write(pl);
    req.end();
  });
}

/* ── move a visit, clearing any booking ──

   PUT the visit back with the location swapped and the date nulled — SCA's own
   changeLocationInSV, with one deliberate difference: the body is spread from
   what SCA just returned rather than from a form. Measured on a real visit,
   the app's own version set carWash and charge from false to TRUE out of its
   defaults; echoing the record leaves them where they were.

   Nulling the date here is what clears the booking. Proven on a booked visit:
   one call moved it and cleared 30 Sep in the same write, with both tickets
   untouched. */
function moveVisitFull(token, visit, dest){
  /* `dest` null means leave the centre alone and only clear the dates — the
     cancel-an-appointment-without-moving case. Nulling the dates is the same
     write either way, which is why it is one function: TSS releases the slot,
     this is what makes SCA agree. */
  const body = {
    ...visit,
    ...(dest ? {
      locationDescription : dest.name,
      trtid               : dest.trtId,
      scaLocationID       : dest.scaLocationId,
      inventoryLocationID : dest.inventoryLocationId,
      scaLocationTypeID   : dest.typeId,
      functionID          : dest.functionId
    } : {}),
    serviceVisitDateTime: null,
    serviceVisitEndDateTime: null
  };
  return new Promise((resolve, reject) => {
    const pl = JSON.stringify(body);
    const req = https.request({
      hostname: "serviceapp.tesla.com", port: 443,
      path: `/case/api/visit/${encodeURIComponent(visit.serviceVisitID)}/dateTime`,
      method: "PUT",
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
                 "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        let b = null;
        try { b = JSON.parse(buf); } catch { /* leave null */ }
        resolve({
          status : res.statusCode,
          ok     : res.statusCode === 200 && Boolean(b && b.success),
          message: (b && (b.localizedMessage || b.message)) || buf.slice(0, 200)
        });
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.write(pl);
    req.end();
  });
}

function moveVisit(token, serviceVisitId, scaLocationId, trtId){
  const path = `/case/api/unscheduledvisit/${encodeURIComponent(serviceVisitId)}` +
               `/${encodeURIComponent(scaLocationId)}/${encodeURIComponent(trtId)}/location`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "serviceapp.tesla.com", port: 443, path, method: "PUT",
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
                 "Content-Type": "application/json", "Content-Length": 0 }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        let body = null;
        try { body = JSON.parse(buf); } catch { /* leave null */ }
        resolve({
          status : res.statusCode,
          ok     : res.statusCode === 200 && Boolean(body && body.success),
          // SCA's own words when it refuses. Far more useful to show than
          // anything this board could invent.
          message: (body && (body.localizedMessage || body.message)) || buf.slice(0, 200)
        });
      });
    });
    req.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    req.end();
  });
}

module.exports = {
  HOST, SIGNIN_URL,
  decode, isLive, msLeft,
  grabToken, openSignInWindow, browserStatus,
  beginSignIn, signInStatus, cancelSignIn,
  visitsByVin, activitiesOf, ticketFor, photoStream,
  sites, symptoms, symptomDetail, activityWrappers, removeActivity, setSymptom,
  moveVisit, moveVisitFull, cancelAppointment, visitById, isOpenVisit,
  contactsForCar, contactOnVisit, teslaContactIn, isTeslaContact, saveContact,
  carAsset, saveAddress, addressOnVisit
};

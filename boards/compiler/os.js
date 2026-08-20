/* Tesla OS — the delivery pipeline, and what is matched but not scheduled.

   Garage says what a car is, Intrepid says what is wrong with it, SCA says
   what the ticket says. None of them knows that an order exists. OS does: it
   is where a VIN gets married to an RN, and its "Matched But Not Scheduled"
   bucket is the list of cars that have a customer waiting and no appointment
   booked. That is the population Pending Inventory reads.

   ── the second board-local sign-in, and the same reason as the first ──

   sca.js explains at length why one credential lives on the board instead of
   the Hub: nothing else in the estate speaks to that host, so a Hub row for it
   would serve exactly one board. Every word of that applies here. This file is
   its sibling, and most of the machinery below is copied from it rather than
   shared — the same trade credstore.js and xlsx.js already make.

   ── it is a cookie AND a header, which is the trap ──

   Entra SSO leaves `osAccessToken` on os.tesla.com. Sending it as a cookie is
   not enough: a same-origin fetch from inside the signed-in page, with
   credentials:'include', still gets 401. The app's own axios factory resends
   the cookie VALUE as `X-Os-Access-Token`, and that is what the BFF reads.
   Taken from the bundle's useAxios(), after the cookie-only attempt 401'd.

   The good consequence is that no browser is needed at runtime. Once the token
   is in hand, plain Node over https is enough — unlike a session cookie that
   has to be kept warm, and unlike anything that needs a live page.

   ── read-only ──

   Three POSTs and a GET, all searches. This file writes nothing to OS. The
   pipeline has write paths — reassign, reschedule, bulk actions — and they are
   deliberately not mapped here.                                              */

"use strict";

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { spawn } = require("child_process");

const HOST       = "os.tesla.com";
const API        = "/vehicle-order/deliveries/delivery-pipeline-bff/api";
const SIGNIN_URL = `https://${HOST}/vehicle-order/deliveries/delivery-pipeline/`;
const DEBUG_PORT = 9222;

/* The bucket the whole tool exists for. Found by NAME rather than pinned to an
   id, because buckets are configured per site: Cypress's CUSTOM list holds a
   Lease Return bucket that another centre will not have, and the STANDARD ids
   are not promised either. The name is matched loosely — OS calls it "Matched
   But Not Scheduled" and everyone says "matched not scheduled". */
const BUCKET_RE = /matched\b.*\bnot\s*sched/i;

/* Rows per page. NOT a tuning knob — 100 comes back as an empty page with
   HTTP 200 and no error of any kind, which is the single most dangerous
   behaviour on this API. 25 is what the pipeline itself asks for and what was
   proven to return data. Raising it does not fail loudly; it just quietly
   reports that the centre has nothing matched. */
const PAGE_SIZE = 25;

/* The bucket's own sub-tab. `order-range`, the other one the bundle names,
   answers {"error":"Missing required parameter: endPoint"} — dead route, not a
   permissions problem. For this bucket bucket-totals reports orderRange and
   pendingActions as the same number, so nothing is lost by using this one. */
const SUB_TAB = "pending-actions";

/* ────────────────────────── finding a browser ──────────────────────────
   Same candidates and same profile directory as sca.js and the Hub's
   connect.js. Sharing the directory is the point: a machine already signed in
   for Garage, Intrepid or SCA usually connects OS with no window appearing. */

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

/* ─────────────────────────────── CDP ─────────────────────────────────── */

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

/* ──────────────────────────── grabbing it ────────────────────────────
   The browser target, not a page: Storage.getCookies lives there, and unlike
   SCA's localStorage the jar does not need a tab to be open on the right
   origin. So this succeeds against a profile that signed into OS yesterday and
   has since been closed and reopened elsewhere.

   ── why this probes and sca.js does not ──

   A JWT states its own expiry, so decoding it answers "is this live". This
   token does not decode — it is opaque — and a cookie that exists is not a
   session that works. So the capture is proved the way the Hub proves Garage's
   cookie: by asking the cheapest authenticated endpoint there is. Adopting an
   unproven one would report Connected and then produce an empty pipeline,
   which reads as a quiet centre rather than a dead session. */

async function grabToken(){
  if(!(await portIsLive())){
    return { ok: false, reason: "no-window",
             detail: "No Tesla OS sign-in window is open." };
  }

  let sess;
  try{
    sess = await cdpSession();
    const jar = await sess.send("Storage.getCookies");
    const hit = (jar.cookies || []).find(c =>
      c.name === "osAccessToken" && String(c.domain || "").includes(HOST));

    if(!hit || !hit.value){
      return { ok: false, reason: "not-signed-in",
               detail: "The window is open but nobody has signed in to Tesla OS yet." };
    }

    const who = await authCheck(hit.value).catch(() => null);
    if(!who || !who.username){
      return { ok: false, reason: "expired",
               detail: "Found a Tesla OS token that the pipeline will not accept — reload that tab." };
    }
    return { ok: true, token: hit.value, user: who.username,
             name: who.name || "", title: who.title || "" };
  }catch(err){
    return { ok: false, reason: "cdp", detail: err.message };
  }finally{
    if(sess) sess.close();
  }
}

/* ── a running browser takes the tab over CDP, NOT over a second spawn ──

   Launching chrome.exe again against a profile that is already open does not
   open the URL. The singleton forwards the command line to the running
   instance, prints "Opening in existing browser session." to the console, and
   drops the navigation on the floor — the tab list is unchanged afterwards.

   That is invisible from here: the spawn succeeds, the debug port is live, and
   the poll below then waits the full three minutes for a tab that was never
   going to appear. It fails exactly when the machine is set up correctly,
   which is why it read as "the sign-in is broken" rather than as a missing
   browser. Measured 2026-08-20 against Chrome 151.

   Target.createTarget has no such problem, and the debug port is by definition
   available whenever this case applies. */
async function openTabViaCdp(){
  const sess = await cdpSession();
  try{
    const { targetId } = await sess.send("Target.createTarget", { url: SIGNIN_URL });
    /* Bring it forward: if Entra does want a click, a tab behind the board is
       a tab nobody knows to look at. Best-effort — a browser that will not
       raise the window still signs in fine. */
    await sess.send("Target.activateTarget", { targetId }).catch(() => {});
    return targetId;
  }finally{ sess.close(); }
}

function spawnSignInWindow(){
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
    "--remote-allow-origins=*",
    SIGNIN_URL
  ], { detached: true, stdio: "ignore" });
  child.unref();

  return { browser: browser.label, profileDir: dir, url: SIGNIN_URL, reused: false };
}

async function openSignInWindow(){
  if(await portIsLive()){
    try{
      await openTabViaCdp();
      const b = findBrowser();
      return { browser: b ? b.label : "the debug browser",
               profileDir: null, url: SIGNIN_URL, reused: true };
    }catch{
      /* The port answered /json/version and then would not open a tab. Falling
         through to the spawn is not expected to help, but it is the honest
         next thing to try rather than reporting success. */
    }
  }
  return spawnSignInWindow();
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
   Identical in shape to sca.js's, and for its reasons: server-side and
   pollable, so closing the panel mid-flow cannot abandon a capture that is
   seconds from succeeding. Storage stays lib.js's job; this takes a commit
   callback. */

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

function beginSignIn(commit){
  if(busy()) return signInStatus();

  cancelled = false;
  setPhase("verifying", "Checking whether this machine is already signed in…",
           { error: null, since: new Date().toISOString(), browser: null });

  (async () => {
    try{
      const first = await grabToken();
      if(first.ok){
        commit(first);
        return setPhase("connected", `Signed in as ${first.user}.`);
      }

      /* A live debug port is enough on its own — the tab is opened over CDP
         and no executable is needed. Only the cold-start path has to find one,
         so this no longer refuses when the browser is already running. */
      const alreadyUp = await portIsLive();
      const b = findBrowser();
      if(!b && !alreadyUp){
        return setPhase("failed", null,
          { error: "No Chrome or Edge found to open a sign-in window with." });
      }

      let opened;
      try{ opened = await openSignInWindow(); }
      catch(err){
        return setPhase("failed", null,
          { error: err.message || "Could not open a sign-in window." });
      }

      setPhase("waiting",
        opened.reused ? "A Tesla OS tab just opened — sign in there if it asks."
                      : `${opened.browser} is opening — sign in to Tesla OS there.`,
        { browser: opened.browser });

      const deadline = Date.now() + DEADLINE_MS;
      let last = null;
      while(Date.now() < deadline){
        if(cancelled) return;
        await sleep(POLL_MS);
        if(cancelled) return;

        const got = await grabToken();
        if(got.ok){
          commit(got);
          return setPhase("connected", `Signed in as ${got.user}.`);
        }
        last = got.reason;
        /* `opened.browser`, not `b.label` — b is null whenever the tab was
           taken over CDP without an executable being found. */
        if(got.reason === "expired") setPhase("waiting", got.detail, { browser: opened.browser });
      }

      /* Say which of the two silences this was. "Press Connect to try again"
         on its own sent Ed round a loop that could not terminate, because the
         thing that needed doing was never in the message. */
      setPhase("failed", null, { error: last === "not-signed-in"
        ? "A Tesla OS tab was opened but no sign-in completed in three minutes. "
          + "Check that tab — Entra may be asking for something."
        : last === "expired"
        ? "Tesla OS kept refusing the token in that tab. Reload it and press Connect again."
        : "Gave up waiting after three minutes. Press Connect to try again." });
    }catch(err){
      setPhase("failed", null, { error: err.message || "Sign-in failed." });
    }
  })();

  return signInStatus();
}

/* ──────────────────────────── talking to the BFF ────────────────────────
   Its own small client rather than lib.js's request(), so this file stays
   self-contained — the same arrangement sca.js has.

   All four headers matter. Without X-Os-Access-Token every call is 401 even
   with the cookie attached; the other three are what the app sends and there
   is no reason to differ from it. */

/* ── the connection is NOT kept alive, and that is a fix rather than a taste ──

   Node's global https agent has kept sockets alive by default since v19. The
   BFF closes its end of an idle connection sooner than Node forgets about it,
   so the next call picks up a socket that is already gone and fails with
   `socket hang up` before a single byte is sent.

   It reproduced exactly: a scan, a second scan straight after it — dead — and
   a third fifteen seconds later fine, because by then Node had dropped the
   socket and dialled a new one. The cost of turning reuse off is one TLS
   handshake on each of the three or four calls a scan makes, which is nothing
   next to a scan that fails every other time it is run. */
const agent = new https.Agent({ keepAlive: false });

function bffRequest(token, method, pathAndQuery, body){
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = https.request({
      hostname: HOST, port: 443, path: API + pathAndQuery, method, agent,
      headers: {
        "Accept"                : "application/json",
        "Content-Type"          : "application/json",
        "X-Requested-With"      : "XMLHttpRequest",
        "Accept-Language"       : "en",
        "X-Os-Access-Token"     : token,
        "X-Calling-Application" : "vfx-delivery-pipeline-burstapp",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if(res.statusCode === 401 || res.statusCode === 403){
          const err = new Error("The Tesla OS session is no longer accepted — connect it again.");
          err.needsOs = true;
          return reject(err);
        }
        let d = null;
        try { d = raw ? JSON.parse(raw) : null; } catch { /* reported below */ }
        if(res.statusCode >= 400 || d === null){
          return reject(new Error(`Tesla OS ${res.statusCode} on ${pathAndQuery}` +
            (raw ? ": " + raw.slice(0, 180) : "")));
        }
        /* A 200 carrying an `error` key. The pipeline does this — a dead route
           answers {"error":"Missing required parameter: endPoint"} with a 200 —
           so the status line alone is not enough to call a call successful. */
        if(d && typeof d === "object" && !Array.isArray(d) && d.error){
          return reject(new Error(`Tesla OS refused ${pathAndQuery}: ${d.error}`));
        }
        resolve(d);
      });
    });
    req.on("error", err => reject(new Error(err.message || "could not reach Tesla OS")));
    req.end(data || undefined);
  });
}

/* One retry, and only ever on a connection that never carried a reply.

   Everything this file sends is a search, so re-sending one cannot double
   anything up — there is nothing here to double. The retry is deliberately
   blind to HTTP status: a 401, a 500 or a refusal in the body are answers and
   are passed straight up. Only a dialling failure is worth a second attempt,
   and only one, so a host that is actually down still fails in seconds. */
const DIAL_FAIL = /socket hang up|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|could not reach/i;

async function tryTwice(token, method, p, body){
  try{
    return await bffRequest(token, method, p, body);
  }catch(err){
    if(err.needsOs || !DIAL_FAIL.test(err.message || "")) throw err;
    return bffRequest(token, method, p, body);
  }
}

const post = (token, p, body) => tryTwice(token, "POST", p, body);
const get  = (token, p)       => tryTwice(token, "GET",  p, null);

/* Who the token belongs to, and the liveness probe. Cheapest authenticated
   call the pipeline has. */
const authCheck = token => get(token, "/v1/auth/check");

/* The centre's own name, so the board can say "Houston - Cypress" rather than
   "TRT 17589" — and, more usefully, so a TRT the pipeline has never heard of
   is caught before a scan reports it as empty. */
async function locationFor(token, trtId){
  const rows = await post(token, "/v1/pipeline/tesla-locations/fetch",
    { trtIds: [Number(trtId)] });
  const hit = Array.isArray(rows) ? rows[0] : null;
  return hit ? { trtId: hit.trtId, name: hit.name, systemName: hit.systemName,
                 timeZone: hit.timeZone && hit.timeZone.id } : null;
}

/* STANDARD and CUSTOM, each `{buckets:[…]}` — flattened, because which list a
   bucket came from is the pipeline's own bookkeeping and not something the
   board has an opinion about. */
async function buckets(token, jobRole = "DeliveryOps"){
  const d = await post(token, "/v1/pipeline/advisor/available-buckets",
    { jobRole, prismFilters: null });
  const out = [];
  for(const k of Object.keys(d || {})){
    for(const b of (d[k] && d[k].buckets) || []) out.push({ ...b, group: k });
  }
  return out;
}

/* The TRT, shaped the way the pipeline's own saved filter is shaped.

   The id is a STRING on purpose. Sent as a number the call returns HTTP 200
   with zero rows and no complaint — one of four ways this API says "nothing
   here" when it means "you asked wrongly". */
const prismFor = trtId => ({ del_center_pickup_location: [String(trtId)] });

/* ── how a wrong question is told from a quiet centre ──

   Every mistake on this endpoint looks the same from outside: 200, totalCount
   0, no error. The one signal that separates them is `dependentOnFilters` — a
   response that accepted the filter echoes the bucket's filter names back, and
   one that ignored it echoes an empty array. So a zero-row page with an empty
   echo is treated as a failure and thrown, not rendered as an empty list. */
function assertFiltered(page, where){
  const echoed = Array.isArray(page && page.dependentOnFilters) ? page.dependentOnFilters : [];
  if(!echoed.length && !(page && page.totalCount)){
    const err = new Error(
      `Tesla OS ignored the centre filter on ${where}, so it cannot be told apart ` +
      `from a centre with nothing matched. Nothing is shown rather than showing zero.`);
    err.filterIgnored = true;
    throw err;
  }
}

async function bucketTotals(token, bucketId, trtId){
  return post(token, "/v1/pipeline/advisor/bucket-totals",
    { bucketId, advancedFilters: {}, prismFilters: prismFor(trtId) });
}

/* One page. `currentPage` is 1-based; 0 is another silent empty. */
function bucketPage(token, bucketId, trtId, page){
  return post(token, `/v1/pipeline/advisor/bucket/${bucketId}/${SUB_TAB}`,
    { currentPage: page, recordsPerPage: PAGE_SIZE,
      prismFilters: prismFor(trtId), advancedFilters: {} });
}

/* ─────────────────── matched, and nobody has booked it ──────────────────

   The whole enumeration: find the bucket, page it out, hand back raw rows.
   Deliberately does not reshape them — lib.js owns what a row means to the
   board, and this file owns what OS said. */

async function matchedNotScheduled(token, trtId, onProgress){
  const all = await buckets(token);
  const bucket = all.find(b => BUCKET_RE.test(String(b.name || "")));
  if(!bucket){
    /* Thrown rather than returned empty, for the reason activeScope() throws
       on an empty site group: a bucket that is not published to this role and
       a bucket with no cars in it render identically and mean opposite
       things. */
    const err = new Error(
      "Tesla OS has no “Matched But Not Scheduled” bucket for this account. " +
      `It offers: ${all.map(b => b.name).join(", ") || "nothing at all"}.`);
    err.noBucket = true;
    throw err;
  }

  const rows = [];
  let total = null;

  for(let page = 1; ; page++){
    const d = await bucketPage(token, bucket.id, trtId, page);
    if(page === 1) assertFiltered(d, `bucket ${bucket.id}`);

    total = d.totalCount ?? total ?? 0;
    const got = Array.isArray(d.results) ? d.results : [];
    rows.push(...got);
    if(onProgress) onProgress({ phase: "pipeline", done: rows.length, total });

    // Stop on a short page as well as on the count: trusting totalCount alone
    // would spin forever if it ever disagreed with what is actually returned.
    if(!got.length || rows.length >= total || got.length < PAGE_SIZE) break;
    if(page > 200) break;   // backstop; 200 pages is 5,000 orders
  }

  return { bucket: { id: bucket.id, name: bucket.name, description: bucket.description },
           total: total || rows.length, rows };
}

module.exports = {
  HOST, SIGNIN_URL, PAGE_SIZE, BUCKET_RE,
  findBrowser, browserStatus, portIsLive,
  grabToken, openSignInWindow,
  beginSignIn, signInStatus, cancelSignIn,
  authCheck, locationFor, buckets, bucketTotals, matchedNotScheduled
};

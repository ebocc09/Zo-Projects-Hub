/* Tesla OS — the order behind the car, and whether the customer wants FSD.

   This board already knows how far a customer drove on FSD. What it could not
   say is whether that customer ever intended to keep it. That answer is on the
   ORDER, and the order lives here: `order.fsdLabel` on the OS overview.

   ── it is not in Intrepid, and that was checked properly ──

   Before this file existed the obvious place to look was Intrepid, since the
   board already holds its cookie. It is not there. Both Intrepid front-ends —
   the root SPA and the /cogs/ app, all twenty-nine lazy chunks — were pulled
   and grepped on 2026-08-25: zero occurrences of `fsd`, `autopilot` or
   `intended`. getDeliveryAppointmentDetails returns staff and nothing else.
   The data is not hiding behind a path nobody found; Intrepid does not have
   it. Do not spend an afternoon re-deriving that.

   ── the third board-local sign-in, and the same reason as the first two ──

   ZO-004's os.js and sca.js each explain why a credential lives on the board
   rather than the Hub. Most of the machinery below is copied from the first of
   those rather than shared — the same trade credstore.js and xlsx.js make.

   There is a second reason here, specific to this token. The Hub's health.js
   re-probes on a five-minute sweep and auto-reconnects whatever it finds dead.
   This token dies every eighty minutes, so a Hub row would be opening a
   sign-in window all day, for every board on the estate. Cookies that last a
   working day do not behave like that. This one is a different animal and is
   kept where only its own board pays for it.

   ── it is a cookie AND a header, which is the trap ──

   Entra SSO leaves `osAccessToken` on os.tesla.com. Sending it as a cookie is
   not enough: a same-origin fetch from inside the signed-in page, with
   credentials:'include', still gets 401. The app's own axios factory resends
   the cookie VALUE as `X-Os-Access-Token`, and that is what the BFF reads.

   The good consequence is that no browser is needed at runtime. Once the token
   is in hand, plain Node over https is enough.

   ── read-only ──

   One GET, per reference number. This file writes nothing to OS. The order has
   write paths and they are deliberately not mapped here.                     */

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

/* ────────────────────────── finding a browser ──────────────────────────
   Same candidates and same profile directory as the Hub's connect.js. Sharing
   the directory is the point: a machine already signed in for Garage or
   Intrepid usually connects OS with no window appearing. */

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
   The browser target, not a page: Storage.getCookies lives there, so this
   succeeds against a profile that signed into OS earlier and has since been
   pointed somewhere else.

   ── a missing cookie and a dead session are the SAME case ──

   Chrome deletes `osAccessToken` at its expiry rather than leaving a stale one
   behind, so an expired session presents as "no cookie at all" and not as a
   cookie that 401s. Anything probing for it has to treat absent and expired
   identically — which is what `not-signed-in` below does. Measured 2026-08-25:
   a token captured at 17:35 was simply gone by 19:05, and the call that failed
   reported a missing header rather than a rejected one.

   The capture is proved before it is adopted. The token is opaque, so "there
   is a token" and "there is a session" are different questions and only the
   second matters. */

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
               detail: "The window is open but there is no live Tesla OS session in it." };
    }

    const who = await authCheck(hit.value).catch(() => null);
    if(!who || !who.username){
      return { ok: false, reason: "expired",
               detail: "Found a Tesla OS token that the order service will not accept — reload that tab." };
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
   instance, prints "Opening in existing browser session." and drops the
   navigation — the tab list is unchanged afterwards.

   That is invisible from here: the spawn succeeds, the debug port is live, and
   a poll then waits its full deadline for a tab that was never going to
   appear. It fails exactly when the machine is set up correctly. Measured
   against Chrome 151; cost ZO-004 a three-minute timeout. */
async function openTabViaCdp(){
  const sess = await cdpSession();
  try{
    const { targetId } = await sess.send("Target.createTarget", { url: SIGNIN_URL });
    await sess.send("Target.activateTarget", { targetId }).catch(() => {});
    return targetId;
  }finally{ sess.close(); }
}

async function closeTab(targetId){
  if(!targetId) return;
  const sess = await cdpSession();
  try { await sess.send("Target.closeTarget", { targetId }); }
  finally { sess.close(); }
}

/* Every Tesla OS tab currently open, so a spawn can be tidied up after. Only
   used when we did not open the tab over CDP and therefore have no id for it. */
async function osTabIds(){
  try{
    const list = await httpGetJSON("/json/list");
    return (Array.isArray(list) ? list : [])
      .filter(t => t.type === "page" && String(t.url || "").includes(HOST))
      .map(t => t.id);
  }catch{ return []; }
}

/* ───────────────────── getting a live token, unattended ──────────────────

   The token lasts about eighty minutes and Chrome DELETES it at expiry, so
   between one run and the next it simply is not there. The board must not
   answer that by giving up: the whole point of the morning brief is that it
   fires before anyone is at a desk, and "connect Tesla OS again" at 07:00 is
   a message nobody will read in time.

   So this heals instead of failing. Entra re-issues silently in the
   cookie-grabber profile — measured at about three seconds, with no window to
   click — so opening a tab, waiting for the cookie and closing the tab again
   is enough to carry on. The tab is closed on every path, including failure,
   because a board that repairs itself hourly must not leave a trail of tabs
   behind it.

   Returns the same shape as grabToken. */
async function refreshToken({ waitMs = 45_000 } = {}){
  /* Cheapest case first: the jar may already hold a good one that this process
     has simply never read — a browser that was signed in for something else. */
  const first = await grabToken();
  if(first.ok) return first;

  let targetId = null;
  let spawned  = false;

  if(await portIsLive()){
    try { targetId = await openTabViaCdp(); }
    catch { /* port answered and then would not open a tab — fall through */ }
  }

  if(!targetId){
    try { spawnSignInWindow(); spawned = true; }
    catch(err){
      return { ok: false, reason: err.noBrowser ? "no-browser" : "cdp",
               detail: err.message };
    }
    // Wait for the debug port rather than assuming the launch was instant.
    const upBy = Date.now() + 30_000;
    while(Date.now() < upBy && !(await portIsLive())) await sleep(500);
  }

  try{
    const deadline = Date.now() + waitMs;
    let last = null;
    while(Date.now() < deadline){
      await sleep(1_500);
      const got = await grabToken();
      if(got.ok) return got;
      last = got;
    }
    return last || { ok: false, reason: "timeout",
                     detail: "Tesla OS did not issue a token in time." };
  }finally{
    /* Tidy up whatever we opened. Best-effort throughout: failing to close a
       tab must never turn a successful refresh into a failed one. */
    try{
      if(targetId)     await closeTab(targetId);
      else if(spawned) for(const id of await osTabIds()) await closeTab(id).catch(() => {});
    }catch{ /* leave it open rather than fail the caller */ }
  }
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
   Server-side and pollable, so closing the panel mid-flow cannot abandon a
   capture that is seconds from succeeding. Storage stays lib.js's job; this
   takes a commit callback. */

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

      /* A live debug port is enough on its own — the tab is opened over CDP and
         no executable is needed. Only the cold-start path has to find one. */
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
        if(got.reason === "expired") setPhase("waiting", got.detail, { browser: opened.browser });
      }

      /* Say which of the two silences this was. "Press Connect to try again" on
         its own sends a person round a loop that cannot terminate, because the
         thing that needs doing is never in the message. */
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
   All four headers matter. Without X-Os-Access-Token every call is 401 even
   with the cookie attached; the other three are what the app sends and there
   is no reason to differ from it.

   ── the connection is NOT kept alive, and that is a fix rather than a taste ──

   Node's global https agent has kept sockets alive by default since v19. The
   BFF closes its end of an idle connection sooner than Node forgets about it,
   so the next call picks up a socket that is already gone and fails with
   `socket hang up` before a single byte is sent. It reproduced exactly on
   ZO-004: a scan, a second straight after it — dead — and a third fifteen
   seconds later fine.

   That matters more here than it did there. This board asks one question per
   car, forty-odd times a run, so a shared idle socket would be picked up and
   dropped repeatedly rather than once. */
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
        /* An order this account cannot resolve is an ANSWER, not a fault, and
           comes back as null so one unreadable order cannot fail a whole run.

           451 is in that list because it is what an unknown reference number
           actually returns — `{"code":451,"message":"Market is not enabled"}`,
           measured against a made-up RN on 2026-08-25. It reads like a
           geo-restriction and is not one. Whatever it means internally, the
           board's answer is the same as for a 404: we do not know about this
           order, which is NOT the same as knowing the customer wants nothing. */
        if(res.statusCode === 404 || res.statusCode === 451) return resolve(null);

        let d = null;
        try { d = raw ? JSON.parse(raw) : null; } catch { /* reported below */ }
        if(res.statusCode >= 400 || d === null){
          return reject(new Error(`Tesla OS ${res.statusCode} on ${pathAndQuery}` +
            (raw ? ": " + raw.slice(0, 180) : "")));
        }
        /* A 200 carrying an `error` key. This API does that — a dead route
           answers {"error":"…"} with a 200 — so the status line alone is not
           enough to call a call successful. */
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

   Everything this file sends is a read, so re-sending one cannot double
   anything up. The retry is deliberately blind to HTTP status: a 401, a 500 or
   a refusal in the body are answers and are passed straight up. Only a
   dialling failure is worth a second attempt, and only one, so a host that is
   actually down still fails in seconds. */
const DIAL_FAIL = /socket hang up|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|could not reach/i;

async function tryTwice(token, method, p, body){
  try{
    return await bffRequest(token, method, p, body);
  }catch(err){
    if(err.needsOs || !DIAL_FAIL.test(err.message || "")) throw err;
    return bffRequest(token, method, p, body);
  }
}

const get = (token, p) => tryTwice(token, "GET", p, null);

/* Who the token belongs to, and the liveness probe. Cheapest authenticated
   call the order service has. */
const authCheck = token => get(token, "/v1/auth/check");

/* The order behind a reference number. Endpoint taken from the bundle's own
   endpoint table, `vfxBffEndpoints.OVERVIEW_GET_DETAILS`. Returns null for an
   order this account cannot see. */
const overviewFor = (token, rn) =>
  get(token, `/v1/overview/${encodeURIComponent(rn)}/overview`);

/* ─────────────────────── what the order says about FSD ───────────────────

   `order.fsdLabel` is a message KEY, not a sentence, and resolving it is this
   file's job because the dictionary is Tesla OS's own — lifted from the
   bundle's `fsd` i18n map so the board and the order page cannot disagree
   about what a customer was told.

   ── two shapes, both real ──

   Sometimes a bare string, `"fsd.subscriptionIntended"`. Sometimes an object,
   `{message:"fsd.trialSubscriptionIntended", messageParams:{date:"…"}}`. Both
   turned up in a single day's deliveries. OS's own mapOverviewMessage branches
   on typeof and so does this; miss it and half the rows render
   "[object Object]".

   ── isFsdSubscribed is NOT the signal, and this is the expensive one ──

   The order also carries a boolean called `isFsdSubscribed`, and on a
   seven-order sample it agreed perfectly with "Subscription Intended". It does
   not hold. RN128978811 and RN129032768, both delivered 2026-08-24 at TRT
   17589, carry `fsd.trial` — no intent stated at all — with
   `isFsdSubscribed:true`. Reading the boolean marks customers as covered who
   said nothing, which on this board means an advisor is told to relax about
   exactly the person they should be chasing. Classify from the key. */

const FSD_STRINGS = {
  luxPackage              : "Included, Luxe Package",
  transferIntended        : "Transfer Intended",
  transferredTo           : "Transferred to {{vin}}",
  transferredFrom         : "Transferred from {{vin}}",
  subscriptionIntended    : "Subscription Intended",
  subscribed              : "Subscribed",
  trial                   : "Trial expiring {{date}}",
  trialSubscriptionIntended: "Trial expiring {{date}}, Subscription Intended",
  included                : "Included",
  notIncluded             : "Not Included",
  includedOffer           : "Included, Complimentary",
  includedReferral        : "Included, Referral"
};

/* The customer has said they want FSD, one way or another. */
const INTENT_KEYS = new Set([
  "subscriptionIntended", "trialSubscriptionIntended", "transferIntended"
]);

/* The customer already HAS FSD — bought, subscribed, or carried across from
   another car. Nothing to chase; they are not short of it. */
const HAS_KEYS = new Set([
  "subscribed", "included", "includedOffer", "includedReferral",
  "luxPackage", "transferredTo", "transferredFrom"
]);

const fill = (tpl, params) =>
  String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    (params && params[k] != null) ? String(params[k]) : "");

/* Returns { state, text, key }.

   state is one of:
     "intent" — said they want it
     "has"    — already has it
     "none"   — a bare trial, or nothing on the order at all
     null     — NOT ASKED, or asked and could not be answered

   The difference between "none" and null is the whole point of this function.
   "none" is a customer to chase; null is a question we failed to ask, and a
   caller that conflates them will name every customer in the centre as
   uninterested the first time Tesla OS is unreachable. */
function fsdIntentOf(fsdLabel){
  if(fsdLabel == null || fsdLabel === "") return { state: "none", text: "", key: null };

  const raw    = typeof fsdLabel === "string" ? fsdLabel : fsdLabel.message;
  const params = (typeof fsdLabel === "object" && fsdLabel.messageParams) || {};
  if(typeof raw !== "string" || !raw) return { state: "none", text: "", key: null };

  // "fsd.trialSubscriptionIntended" → "trialSubscriptionIntended"
  const key = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
  const tpl = FSD_STRINGS[key];

  /* An unknown key means OS has added a state this board has not been taught.
     Treated as null rather than "none": a customer whose status we cannot read
     must not be chased on the strength of a word we do not know. */
  if(!tpl) return { state: null, text: "", key };

  const state = INTENT_KEYS.has(key) ? "intent" : HAS_KEYS.has(key) ? "has" : "none";
  return { state, text: fill(tpl, params), key };
}

module.exports = {
  HOST, SIGNIN_URL, FSD_STRINGS,
  findBrowser, browserStatus, portIsLive,
  grabToken, refreshToken, openSignInWindow,
  beginSignIn, signInStatus, cancelSignIn,
  authCheck, overviewFor, fsdIntentOf
};

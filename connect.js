/* Fetching a sign-in cookie without anyone hunting through DevTools.

   The obvious version of this — read the cookie out of the browser the user
   is already signed into — is not possible on a modern managed Chrome, and it
   is worth writing down why so nobody spends a day rediscovering it:

     App-bound encryption (Chrome 127+)  cookie values are sealed with a key
       that only unwraps inside the originating profile. Copying `Cookies` and
       `Local State` to a temp dir and reading them headless yields zero rows:
       every value fails to decrypt.

     Debug-port lockout (Chrome 136+)  `--remote-debugging-port` is ignored on
       the default profile. A non-default `--user-data-dir` still honours it.

   Those two are mutually exclusive. Reading your everyday session needs an ABE
   bypass — injecting into Chrome or abusing its elevation COM service — which
   is fragile, antivirus-flagged, and the wrong shape for a tool colleagues
   run. So this takes the clean path instead: a separate, isolated sign-in
   window with the debug port open, where the browser decrypts its OWN live
   cookies for us over CDP.

   Zero dependencies. Node 20+ ships a global WebSocket, which is the only
   reason CDP is reachable without a client library.

   Deliberately NOT a require() of ~/cookie-grabber, which does the same job as
   a general CLI. This file reads and writes nothing outside the Hub's own
   folder: it hands what it grabs back to the caller, and the caller decides
   where it goes. Nothing here reads another project's files, and nothing here
   breaks if another project is deleted.

   What IS shared is the profile *directory* — a path convention, not a
   dependency. If cookie-grabber or another board has already signed this
   machine's isolated profile in, the sign-in is simply already done; if the
   directory is empty, the window opens and asks. Neither case reads or writes
   anything belonging to another tool.                                       */

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DEBUG_PORT = 9222;

/* Two sources, one browser profile. Signing into both in the same window
   means Storage.getCookies returns both credentials, so the second connection
   is usually a single press with no sign-in at all.

   Intrepid's sign-in is the SPA host rather than the API host: the API host
   has no UI, and the SSO round trip sets the cookie for both.

   Garage's session cookie carries an environment prefix — 31_s_garage_session
   on production — so it is matched by suffix rather than by exact name, or a
   different region silently finds nothing.

   Garage is two hosts, not one. Production and engineering are separate
   deployments holding separate sessions, and their cookie names match the same
   suffix, so a single host here hands back the production cookie whichever
   environment was asked for — which is exactly what it used to do. Nothing
   depended on it while every board still had its own sign-in; once this is the
   only way in, an engineering session has to actually come from engineering. */
const TARGETS = {
  intrepid: {
    label : "Intrepid",
    host  : "intrepidapi.tesla.com",
    cookie: /^cogs-authorization$/,
    url   : "https://intrepid.tesla.com/cogs"
  },
  garage: {
    prod: {
      label : "Garage · prod",
      host  : "garage.vn.teslamotors.com",
      cookie: /(^|_)s_garage_session$/,
      url   : "https://garage.vn.teslamotors.com/"
    },
    eng: {
      label : "Garage · eng",
      host  : "garage.dev.teslamotors.com",
      cookie: /(^|_)s_garage_session$/,
      url   : "https://garage.dev.teslamotors.com/"
    }
  }
};

/* Intrepid is one target; Garage is keyed by environment. A target that
   carries its own `host` is a leaf, anything else is an environment map. */
function targetFor(name, env){
  const t = TARGETS[name];
  if(!t) return TARGETS.intrepid;
  return t.host ? t : (t[env === "eng" ? "eng" : "prod"]);
}

/* Same location cookie-grabber uses, on purpose: if that tool has already been
   set up on this machine, the profile is signed in and this just works. */
const profileDir = name =>
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "cookie-grabber-profiles", name);

/* ── finding a browser ── */

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

/* ── the DevTools endpoint ── */

function httpGetJSON(port, urlPath){
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 2000 }, res => {
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

async function portIsLive(port = DEBUG_PORT){
  try { await httpGetJSON(port, "/json/version"); return true; }
  catch { return false; }
}

/* Storage.getCookies on the browser target returns every cookie the profile
   holds, already decrypted — the browser is doing the unsealing for us. */
function cdpCookies(port = DEBUG_PORT){
  return httpGetJSON(port, "/json/version").then(v => {
    const wsUrl = v.webSocketDebuggerUrl;
    if(!wsUrl) throw new Error("browser did not advertise a debugger endpoint");

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const done = (err, val) => {
        if(settled) return;
        settled = true;
        try { ws.close(); } catch {}
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => done(new Error("timed out talking to the browser")), 15000);

      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })));
      ws.addEventListener("message", ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if(msg.id !== 1) return;
        clearTimeout(timer);
        if(msg.error) return done(new Error(msg.error.message));
        done(null, (msg.result && msg.result.cookies) || []);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        done(new Error("could not open a debugger connection to the browser"));
      });
    });
  });
}

/* Opens a tab in the browser that is already on the debug port, and brings it
   forward. Same one-shot-socket shape as cdpCookies above; two messages
   because activating needs the targetId the first one hands back. Activation
   is best-effort — a browser that will not raise its window still signs in. */
function cdpOpenTab(url, port = DEBUG_PORT){
  return httpGetJSON(port, "/json/version").then(v => {
    const wsUrl = v.webSocketDebuggerUrl;
    if(!wsUrl) throw new Error("browser did not advertise a debugger endpoint");

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const done = (err, val) => {
        if(settled) return;
        settled = true;
        try { ws.close(); } catch {}
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => done(new Error("timed out talking to the browser")), 15000);

      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } })));
      ws.addEventListener("message", ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if(msg.id === 1){
          if(msg.error){ clearTimeout(timer); return done(new Error(msg.error.message)); }
          const targetId = msg.result && msg.result.targetId;
          ws.send(JSON.stringify({ id: 2, method: "Target.activateTarget", params: { targetId } }));
          /* Do not wait on the activate to call this a success — the tab is
             open either way, and that is the part the sign-in needs. */
          clearTimeout(timer);
          return done(null, targetId);
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        done(new Error("could not open a debugger connection to the browser"));
      });
    });
  });
}

/* A cookie set for ".tesla.com" is valid for intrepidapi.tesla.com too, so
   match by suffix rather than equality. */
function appliesTo(domain, host){
  const d = String(domain || "").replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return d === h || h.endsWith("." + d);
}

/* ── the two things the dashboard calls ── */

/* Opens the isolated sign-in window at one source's sign-in page. Detached,
   so closing the dashboard does not kill the browser someone is mid-sign-in
   on.

   ── the spawn does NOT open a tab in a browser that is already running ──

   This used to say that "a second launch against the same --user-data-dir
   becomes a tab in the existing browser either way", and that `alreadyUp`
   therefore "changes nothing about the spawn and only decides what the panel
   says". Both sentences are wrong, and they are why the failure went
   unsuspected in all three copies of this file.

   Chrome's singleton forwards the command line to the running instance, prints
   "Opening in existing browser session.", and then drops the navigation. The
   tab list is unchanged afterwards. The launcher still exits 0 and the debug
   port stays live, so nothing downstream can tell the difference between "a
   tab is open and nobody has signed in" and "no tab was ever opened" — the
   capture loop just waits out its deadline and blames the user.

   So `alreadyUp` now selects the mechanism rather than the wording: a live
   debug port takes the tab over CDP, and the spawn is the cold-start path.
   Measured on Chrome 151, 2026-08-20; the two copies in boards/compiler carry
   the same note. */
async function openUrl(url, alreadyUp = false){
  if(alreadyUp || await portIsLive()){
    try{
      await cdpOpenTab(url);
      const b = findBrowser();
      return { browser: b ? b.label : "the debug browser",
               profileDir: null, url, reused: true };
    }catch{
      /* Fall through and spawn. Not expected to help against a live port, but
         it is honest — better than returning a window that does not exist. */
    }
  }

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
    url
  ], { detached: true, stdio: "ignore" });
  child.unref();

  return { browser: browser.label, profileDir: dir, url, reused: false };
}

async function openSignInWindow(target, env){
  const t = targetFor(target, env);
  return { ...(await openUrl(t.url)), target: t.label };
}

/* Reads one source's cookie out of that window. Returns {ok, cookie} or a
   reason the caller can turn into the right next step for the user. */
async function grabCookie(target, env){
  const t = targetFor(target, env);

  if(!(await portIsLive())){
    return { ok: false, reason: "no-window",
             detail: `No ${t.label} sign-in window is open.` };
  }

  let cookies;
  try { cookies = await cdpCookies(); }
  catch(err){ return { ok: false, reason: "cdp", detail: err.message }; }

  /* Exact host first, parent domain only as a fallback. Both Garage
     environments sit under teslamotors.com and match the same cookie name, so
     a plain suffix match could hand back the other environment's session — the
     failure this whole per-environment split exists to prevent. */
  const matches = cookies.filter(c => t.cookie.test(c.name) && appliesTo(c.domain, t.host));
  const exact   = d => String(d || "").replace(/^\./, "").toLowerCase() === t.host.toLowerCase();
  const hit     = matches.find(c => exact(c.domain)) || matches[0];
  if(!hit){
    // The window is open but nobody has signed into THIS source yet — much
    // the most likely case, and a different fix from a broken connection.
    return { ok: false, reason: "not-signed-in",
             detail: `The window is open but carries no ${t.label} session cookie yet.` };
  }

  // Name and value both, because the server sends it back as a Cookie header
  // and Garage's name carries an environment prefix.
  return { ok: true, cookie: `${hit.name}=${hit.value}`,
           expires: hit.expires && hit.expires > 0
             ? new Date(hit.expires * 1000).toISOString() : null };
}

/* Whether a window is already up, for painting the panel before any click. */
async function status(){
  const browser = findBrowser();
  return {
    browser  : browser ? browser.label : null,
    windowUp : await portIsLive(),
    supported: Boolean(browser)
  };
}

module.exports = { openSignInWindow, openUrl, grabCookie, status, portIsLive,
                   DEBUG_PORT, TARGETS };

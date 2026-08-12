#!/usr/bin/env node
/* The Zo Projects Hub — server.

   Three jobs and no more:

     1. Say what boards exist, what their serials are, and which are running.
     2. Start and stop them.
     3. Own every sign-in, write them where each board can read them, and keep
        them alive — see health.js, which re-probes the cookies on a timer and
        reopens the sign-in for one that has expired.

   It deliberately knows nothing about what any board *does*. A board is a
   folder with a server.js and a port; the Hub launches it and gets out of the
   way. That is what keeps this from becoming the thing every board has to be
   rewritten against.                                                       */

"use strict";

const http = require("http");
const net  = require("net");
const fs   = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const registry  = require("./registry");
const credstore = require("./credstore");
const connector = require("./connect");
const mcpAuth   = require("./garage-oauth");
const signin    = require("./signin");
const health    = require("./health");
const updater   = require("./updater");
const publisher = require("./publish");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PORT   = Number(process.env.PORT || CONFIG.port || 3100);
const INDEX  = path.join(__dirname, "index.html");

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8",
                        "Content-Length": Buffer.byteLength(body),
                        "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if(buf.length > 1e6) reject(new Error("body too large")); });
    req.on("end", () => {
      if(!buf.trim()) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error("body was not JSON")); }
    });
    req.on("error", reject);
  });
}

/* The admin code is the house one, shared with every board. Checked here as
   well as there, because a client-only gate is no gate at all. */
function adminPassword(){
  const f = path.join(__dirname, ".admin.json");
  if(fs.existsSync(f)){
    try { return String(JSON.parse(fs.readFileSync(f, "utf8")).password || "").trim()
                 || CONFIG.defaultAdminPassword; } catch { /* fall through */ }
  }
  return CONFIG.defaultAdminPassword;
}
const authed = body => String(body.password || "") === adminPassword();

/* ── is it up? ──
   A TCP connect rather than an HTTP request: it answers in milliseconds, it
   does not care what the board serves, and it is true for a board someone
   started by hand outside the Hub. Anything richer would be the Hub deciding
   what counts as healthy for a board it knows nothing about. */
function portLive(port, timeout = 350){
  return new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = up => { sock.destroy(); resolve(up); };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error",   () => done(false));
  });
}

async function boardStates(){
  const list = registry.boards();
  /* An external board has no local port to probe. It is reported as running
     because it is — somebody else's server is keeping it up, and a TCP check
     against a machine we do not own would only ever measure our own network. */
  const up = await Promise.all(list.map(b =>
    (b.self || b.external) ? Promise.resolve(true) : portLive(b.port)));
  return list.map((b, i) => ({
    ...b, running: up[i],
    url: b.external ? b.url : `http://localhost:${b.port}`
  }));
}

/* ── starting one ──
   Detached and fully unhooked, so a board outlives the Hub. Closing the Hub
   should not take down four dashboards someone is reading, and a board that
   dies should not take the Hub with it.

   Output goes to a log file per board rather than to the Hub's own stdout,
   which would interleave five servers into one unreadable stream. */
const LOGS = path.join(__dirname, "logs");

async function launch(board){
  if(board.external) return { ok: true, already: true, external: true };
  if(!board.present) return { ok: false, error: "Folder not found: " + board.dir };
  if(!board.entry)   return { ok: false, error: "No server.js in " + board.dir };
  if(await portLive(board.port)) return { ok: true, already: true };

  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, board.serial + ".log"), "a");

  /* PORT is stripped from the child's environment on purpose. spawn inherits
     it, so a hub started with `PORT=3101` would hand 3101 to every board it
     launched — each one then tries to bind the hub's own port and dies with
     EADDRINUSE. Every board already knows its port from its own config.json;
     inheriting ours can only ever be wrong. */
  const env = { ...process.env };
  delete env.PORT;

  const child = spawn(process.execPath, [board.entry], {
    cwd: board.dir, detached: true, stdio: ["ignore", out, out], env
  });
  child.unref();

  // Wait for the port rather than reporting success on spawn: a board that
  // crashes on boot would otherwise look launched until someone clicked it.
  for(let i = 0; i < 40; i++){
    if(await portLive(board.port)) return { ok: true, pid: child.pid };
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok: false, error: "Started but never opened its port — see logs/" + board.serial + ".log" };
}

/* Stopping is by port, not by remembered pid: the board may have been started
   by hand, or by an earlier run of the Hub. Whoever holds the port is the one
   to stop. */
function stop(board){
  return new Promise(resolve => {
    const ns = spawn("cmd", ["/c", `netstat -ano | findstr :${board.port} | findstr LISTENING`],
                     { windowsHide: true });
    let out = "";
    ns.stdout.on("data", d => out += d);
    ns.on("close", () => {
      const pids = [...new Set(out.trim().split(/\r?\n/)
        .map(l => l.trim().split(/\s+/).pop())
        .filter(p => /^\d+$/.test(p) && p !== "0"))];
      if(!pids.length) return resolve({ ok: true, already: true });
      const kill = spawn("cmd", ["/c", `taskkill /F ${pids.map(p => "/PID " + p).join(" ")}`],
                         { windowsHide: true });
      kill.on("close", code => resolve({ ok: code === 0, pids }));
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p   = url.pathname;

  try{
    if(p === "/" || p === "/index.html"){
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
                           "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(INDEX));
    }

    /* Health and sign-in phases ride along on the ungated route on purpose.

       The credential chips on the front page count what is connected, and a
       count that says "3 of 4" over an expired cookie is the exact lie this
       whole thing exists to stop — so the panel must be able to tell without
       anyone typing the admin code first.

       The sign-in phases are safe to hand over because `statusOf` never
       carries a credential (see signin.js). They are here because a sign-in
       the SERVER started — the auto-reconnect — has no click behind it to
       kick off the fast poll, so the fifteen-second refresh is the only thing
       that will notice a window opening on its own. */
    if(p === "/api/state" && req.method === "GET"){
      return sendJson(res, 200, {
        boards: await boardStates(),
        creds : credstore.summary(),
        health: health.summary(),
        signin: signin.allStatuses()
      });
    }

    if(p === "/api/launch" && req.method === "POST"){
      const body = await readBody(req);
      const b = registry.bySerial(body.serial);
      if(!b) return sendJson(res, 404, { error: "No board with that serial" });
      const out = await launch(b);
      log(`launch ${b.serial} ${b.name}: ${out.ok ? (out.already ? "already up" : "started") : out.error}`);
      return sendJson(res, 200, { ...out, serial: b.serial,
                                  url: b.external ? b.url : `http://localhost:${b.port}` });
    }

    if(p === "/api/stop" && req.method === "POST"){
      const body = await readBody(req);
      const b = registry.bySerial(body.serial);
      if(!b) return sendJson(res, 404, { error: "No board with that serial" });
      if(b.self) return sendJson(res, 400, { error: "The Hub cannot stop itself" });
      if(b.external) return sendJson(res, 400, { error: "That board is hosted elsewhere" });
      const out = await stop(b);
      log(`stop ${b.serial} ${b.name}: ${out.already ? "was not running" : "killed " + (out.pids || []).join(",")}`);
      return sendJson(res, 200, { ...out, serial: b.serial });
    }

    /* ── admin ── */
    if(p === "/api/admin/unlock" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      return sendJson(res, 200, {
        ok: true,
        creds: credstore.summary(),
        health: health.summary(),
        window: await connector.status(),
        signin: signin.allStatuses(),
        boards: await boardStates()
      });
    }

    /* One sign-in, written where every board reads it. This is the whole
       reason the Hub exists: the alternative is four sign-ins that expire on
       four different afternoons.

       Connect opens the window AND waits for the sign-in to finish — one
       press, not two. The waiting lives in signin.js; this only starts it and
       hands back the current phase. */
    if(p === "/api/admin/source/connect" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const which = body.source === "garage" ? "garage" : "intrepid";
      const env   = body.env === "eng" ? "eng" : "prod";
      const label = which === "garage" ? `Garage · ${env}` : "Intrepid";

      const state = await signin.startCookieSignIn(which, env, label, log);
      return sendJson(res, 200, { ok: state.phase !== "failed", source: which, env,
                                  signin: state, creds: credstore.summary(),
                                  health: health.summary() });
    }

    if(p === "/api/admin/source/cancel" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const which = body.source === "garage" ? "garage" : "intrepid";
      const env   = body.env === "eng" ? "eng" : "prod";
      return sendJson(res, 200, { ok: true, signin: signin.cancel(which, env),
                                  creds: credstore.summary() });
    }

    /* Polled while an attempt is in flight. Deliberately cheap and
       password-free of side effects: it reads state, it never starts one. */
    if(p === "/api/admin/signin" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      return sendJson(res, 200, { ok: true, signin: signin.allStatuses(),
                                  creds: credstore.summary(),
                                  health: health.summary(),
                                  window: await connector.status() });
    }

    /* Check now. The sweep runs on its own five-minute timer, which is the
       right cadence to notice an expiry and the wrong one to stand in front
       of when you have just fixed something and want to see it go green. */
    if(p === "/api/admin/source/recheck" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const summary = await health.checkNow();
      return sendJson(res, 200, { ok: true, health: summary,
                                  creds: credstore.summary(),
                                  signin: signin.allStatuses() });
    }

    if(p === "/api/admin/source/forget" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const which = body.source === "garage" ? "garage" : "intrepid";
      const env   = body.env === "eng" ? "eng" : "prod";
      credstore.writeStore(which === "garage" ? { garage: { [env]: "" } } : { intrepid: "" });
      // Clear the row's attempt too, or a leftover "connected" would outlive
      // the credential it was describing. The health verdict goes the same
      // way, and for the same reason — plus a stale "dead" would keep the
      // auto-reconnect latch set against a credential nobody has re-added.
      signin.reset(which, env);
      health.reset(which, env);
      log(`${which} forgotten`);
      return sendJson(res, 200, { ok: true, signin: signin.allStatuses(),
                                  creds: credstore.summary(),
                                  health: health.summary() });
    }

    /* ── the GitHub token ──
       Handed over in full, and ungated, unlike everything else here. Two
       reasons that is the right call rather than a lapse:

       The Hub binds 127.0.0.1, so reaching this route at all means being on
       this machine — and anyone on this machine can read the credentials file
       directly. A gate here would stop nobody it was not already too late for.

       And the button exists to be pressed the moment the page opens, before a
       sync. Putting the six-digit code in front of it would make the fast path
       slower than opening the file by hand, which is how a convenience gets
       abandoned. The admin gate still guards SETTING it. */
    if(p === "/api/token/github" && req.method === "GET"){
      const token = credstore.githubToken();
      if(!token) return sendJson(res, 404, {
        error: "No GitHub token saved — add one in Admin › Sign-ins" });
      return sendJson(res, 200, { ok: true, token });
    }

    /* ── estate updates ──
       Checking is open: a teammate pulling a fix should not need the admin
       passcode, and the passcode is the same on every copy anyway, so gating it
       would be theatre. Publishing is gated, because that one writes to GitHub. */
    if(p === "/api/update/check" && req.method === "GET"){
      try{
        const states = await boardStates();
        return sendJson(res, 200, { ok: true, ...(await updater.check(states)) });
      }catch(err){
        return sendJson(res, 502, { error: updater.friendly(err) });
      }
    }

    if(p === "/api/update/apply" && req.method === "POST"){
      try{
        const states = await boardStates();
        const out = await updater.apply({
          boards: states,
          isRunning : b => !!states.find(s => s.serial === b.serial && s.running),
          stopBoard : async b => { log(`update: stopping ${b.serial}`); await stop(b); },
          startBoard: async b => { const r = await launch(b);
                                   log(`update: restarting ${b.serial}: ${r.ok ? "up" : r.error}`); },
        });
        log(`update applied: ${out.installed || 0} file(s), ${out.deleted || 0} removed`);
        return sendJson(res, 200, { ok: true, ...out });
      }catch(err){
        log("update failed: " + (err && err.message));
        return sendJson(res, 502, { error: updater.friendly(err) });
      }
    }

    if(p === "/api/publish/preview" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      try { return sendJson(res, 200, { ok: true, ...publisher.preview() }); }
      catch(err){ return sendJson(res, 400, { error: err.message }); }
    }

    if(p === "/api/publish" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      try{
        const out = publisher.publish({
          token: credstore.githubToken(),
          message: body.message,
        });
        log(out.nothing ? "publish: nothing to send" : `publish: ${out.commit.slice(0, 8)}`);
        return sendJson(res, 200, { ok: true, ...out });
      }catch(err){
        log("publish failed: " + (err && err.message));
        return sendJson(res, 400, { error: err.message });
      }
    }

    if(p === "/api/admin/github/save" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const v = String(body.token || "").trim();
      if(!v) return sendJson(res, 400, { error: "Paste a token" });
      credstore.setGithubToken(v);
      log("github token stored");
      return sendJson(res, 200, { ok: true, creds: credstore.summary() });
    }

    if(p === "/api/admin/github/forget" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      credstore.setGithubToken("");
      log("github token forgotten");
      return sendJson(res, 200, { ok: true, creds: credstore.summary() });
    }

    /* ── the one credential that is not a cookie ──
       Garage's MCP endpoint wants OAuth, and ZO-002 needs it for the name
       lookup that has no cookie equivalent. Minted here so there is still
       exactly one place anyone signs in. See garage-oauth.js. */
    if(p === "/api/admin/mcp/signin" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const state = await signin.startMcpSignIn(log);
      return sendJson(res, 200, { ok: state.phase !== "failed", signin: state,
                                  creds: credstore.summary() });
    }

    if(p === "/api/admin/mcp/signout" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      mcpAuth.signOut();
      signin.reset("mcp");
      log("garage MCP signed out — registration and tokens dropped");
      return sendJson(res, 200, { ok: true, signin: signin.allStatuses(),
                                  creds: credstore.summary() });
    }

    /* The redirect the OAuth client is registered against. Unauthenticated by
       necessity — the authorization server sends the browser here — which is
       why it is worth nothing on its own: without the PKCE verifier held in
       memory from the matching authorizeUrl call, a code posted here cannot be
       exchanged. */
    if(p === "/callback" && req.method === "GET"){
      const code  = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const fail  = url.searchParams.get("error");

      let message, ok = false;
      if(fail){
        message = `Garage refused the sign-in: ${fail}`;
      }else if(!code || !state){
        message = "That callback carried no authorization code.";
      }else{
        try { await mcpAuth.exchangeCode(code, state); ok = true;
              message = "Signed in to Garage MCP. You can close this tab.";
              log("garage MCP token stored for every board"); }
        catch(err){ message = err.message; log("garage MCP exchange failed:", err.message); }
      }

      // Tell the waiting row how it ended, so the panel settles on its own
      // rather than sitting on "waiting" until someone reloads it.
      signin.mcpFinished(ok, ok ? "Connected to Garage MCP." : message);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
                           "Cache-Control": "no-store" });
      return res.end(`<!doctype html><meta charset="utf-8">
<title>Zo Projects Hub</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#fff;
       font:400 14px/1.6 Inter,system-ui,sans-serif;color:#171A20}
  .c{text-align:center;max-width:380px;padding:24px}
  .d{width:10px;height:10px;border-radius:50%;margin:0 auto 14px;
     background:${ok ? "#12BB6A" : "#E82127"}}
  h1{font-size:13px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;margin:0 0 8px}
  p{margin:0;color:#5C5E62}
</style>
<div class="c"><div class="d"></div><h1>Zo Projects Hub</h1>
<p>${message.replace(/[<&]/g, c => c === "<" ? "&lt;" : "&amp;")}</p></div>
${ok ? "<script>setTimeout(()=>window.close(),1600)</script>" : ""}`);
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }catch(err){
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  log(`Zo Projects Hub on http://localhost:${PORT}`);
  const c = credstore.summary();
  log(`  credentials ${c.file}`);
  log(`  garage ${Object.entries(c.garage).filter(([, v]) => v.set).map(([k]) => k).join(", ") || "none"}` +
      ` · intrepid ${c.intrepid.set ? "set" : "none"}`);

  /* The first sweep runs here rather than on the timer, so the panel is
     telling the truth about every cookie within seconds of boot instead of
     five minutes into it. Started after the listen callback's own logging so
     the verdicts read underneath the credentials they are about. */
  const h = await health.start(CONFIG, log);
  const mins = Math.round(h.intervalMs / 60000);
  log(`  sessions ${Object.entries(h.keys).map(([k, v]) => `${k}=${v.state}`).join(" ")}`);
  log(`  rechecking every ${mins} min` +
      (h.autoReconnect ? " · a dead session opens its own sign-in window"
                       : " · auto-reconnect off"));

  for(const b of await boardStates()){
    if(b.self) continue;
    // An external board has no port and is not ours to call running or
    // stopped — say where it is instead of printing ":null".
    const where = b.external
      ? String(b.url).replace(/^https?:\/\//, "").replace(/\/$/, "")
      : `:${b.port} ${b.present ? (b.running ? "running" : "stopped") : "MISSING"}`;
    log(`  ${b.serial} ${b.name.padEnd(18)} ${where}`);
  }
});

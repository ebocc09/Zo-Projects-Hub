#!/usr/bin/env node
/* FSD Tracker — dashboard server.

   Deliberately thin. Every measurement lives in lib.js, shared with the CLI,
   so the dashboard and the CSV can never disagree about what a number means.

   Mutating routes require the admin password. It is a shared house password
   and a guard against fat fingers rather than an attacker — but it is checked
   server-side all the same, because a client-only gate is no gate at all.  */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const L    = require("./lib");
const xlsx = require("./xlsx");
const A    = require("./alerts");
const credstore = require("./credstore");

const PORT = Number(process.env.PORT || L.CONFIG.port || 3120);
const INDEX = path.join(__dirname, "index.html");

const log  = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
/* Same line shape, different stream. A background job that fails has nobody
   watching it, so its failures should not be indistinguishable from its
   ordinary chatter when someone finally reads the console. */
const warn = (...a) => console.error(new Date().toLocaleTimeString(), ...a);

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
    req.on("data", c => {
      buf += c;
      if(buf.length > 1e6) reject(new Error("body too large"));
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
   A basic run scans every car delivered nationally that day to find this
   centre's, which is minutes of work. A spinner with nothing behind it for
   that long reads as a hang, so the run publishes where it is and the page
   polls for it.

   One slot, deliberately. This is a single-operator dashboard bound to
   localhost; a job table would be machinery for a situation that cannot
   arise. A second run simply takes the slot over — but see withReportLock
   below for why only ONE run may be in flight at a time now that the board
   runs reports of its own. */
let JOB = null;

// `kind` is "user", "alert" or "alert-manual", so the page can say whose run
// it is watching rather than showing a phantom car count from someone else's.
const jobStart = (kind = "user") => { JOB = { kind, phase: "starting", startedAt: Date.now() }; };
const jobEnd   = () => { JOB = null; };

function jobUpdate(p){
  if(!JOB) return;
  // Phase names come straight from collectReport so the two cannot drift.
  JOB.phase = p.phase;
  if(p.date)  JOB.date  = p.date;
  if(p.total != null) JOB.total = p.total;
  if(p.done  != null) JOB.done  = p.done;
  if(p.phase === "enumerate"){ JOB.got = p.got; JOB.total = p.total; }
  if(p.phase === "scoped"){ JOB.national = p.national; JOB.delivered = p.delivered; }
}

/* ── one report at a time ──
   Reports used to be serialised by convention: one operator, one tab, and
   "a second run simply takes the slot over" was true enough. The hourly
   alert makes a second run routine rather than hypothetical, and two
   concurrent collectReport calls share far more than the progress slot —
   the MCP session, the settled-measurement cache and its dirty flag, the
   staff and VIN→TRT caches, and the module-level notices array, which
   takeNotices() drains with a splice. That last one is the real bug: a
   concurrent run does not just race the warnings, it STEALS them, so a
   user's "advanced degraded to basic" notice vanishes into a background
   run's discarded output.

   Serialising is far cheaper than making any of that reentrant, and on one
   person's machine waiting for a run that is already going is the honest
   behaviour rather than a compromise.

   Acquisition is asymmetric on purpose:
     · a user run QUEUES — they asked for it, they get it, just later;
     · the scheduler SKIPS — a digest four minutes late is worse than one
       missed hour, and because the tick does not record the hour when it
       skips, the next tick thirty seconds later retries. The hour heals
       itself; only a report spanning a whole hour actually loses a slot. */
let queued   = 0;
let lockTail = Promise.resolve();

function withReportLock(kind, fn){
  /* Incremented SYNCHRONOUSLY, and that is the whole point. A flag set
     inside the .then would leave a real window: /api/fsd awaits readBody,
     yields, a tick lands in the gap, and both see a free slot. Nothing can
     interleave between this line and the caller's next await. */
  queued++;
  const run = lockTail.then(async () => {
    jobStart(kind);
    try   { return await fn(); }
    finally { jobEnd(); }
  });
  /* The tail must never carry a rejection forward, or one failed report
     poisons every run that queues behind it for the life of the process. */
  lockTail = run.then(() => {}, () => {});
  return run.finally(() => { queued--; });
}

const reportBusy = () => queued > 0;

/* ─────────────────────── the hourly Teams digest ───────────────────────
   Runs today's report on the hour, during the configured hours of
   operation, and posts one card listing every delivered car that has not
   reached the FSD bar. Cars at or above it are complete and are never
   posted. Nothing missing means nothing is sent.

   The DECISION about whether this is a posting moment lives in alerts.js as
   a pure function; what lives here is the clock that asks it, the lock it
   respects, and the error handling that keeps a background job from taking
   the process down with it. */

/* Surfaced in /api/state so a broken background job is visible somewhere
   other than a console nobody is reading. */
let lastAlertAt = null, lastAlertResult = null, lastAlertError = null;
// Which card the last fire was, so the panel can say "morning brief" rather
// than reporting every post as a digest.
let lastAlertKind = null;

// The hour a digest was last DECIDED for — "2026-08-13T14". A name, not a
// timestamp. In memory on purpose: persisting it would race the admin panel
// on .connections.json every hour, and a crash loop that persisted it would
// SUPPRESS alerts. A restart mid-hour can cost one duplicate card; a
// duplicate gets noticed and ignored, a silence does not.
let lastAlertHour = null;

let alertInFlight = false, alertStartedAt = 0, alertSkipLogged = false;

/* The whole check. `post:false` builds everything and sends nothing, which
   is what makes this verifiable without putting test cards in a channel. */
async function runAlertCheck({ post = true } = {}){
  const conn = L.loadConnections();
  const trt  = L.savedTrtId();
  const date = L.todayLocal();

  // Cannot run, and will not become runnable inside this hour.
  if(!trt) return { skipped: "no-trt", reason: "No centre is set on this board.", posted: false };

  /* `mode` is omitted rather than passed as null: effectiveMode(undefined)
     inherits the saved setting and degrades advanced→basic on its own with
     a notice, so a dead Intrepid cookie costs the advisor line and nothing
     else. onProgress is wired up so the page can see whose run is going. */
  const out = await L.collectReport({ dates: [date], trtId: String(trt),
                                      onProgress: jobUpdate });

  const bar  = L.droveThreshold();
  const cars = A.missingCars(out.rows, bar);
  const site = (await L.trtInfo(trt).catch(() => null) || {}).name || null;
  /* The same summary the dashboard's stat strip is built from, so the card's
     percentage and the board's own counts come from one calculation. */
  const sum  = L.summarise(out.rows);

  /* Nothing missing: post NOTHING, by design — a channel that only ever
     shows work to do is one people keep reading. But LOG it. "No card
     arrived" has to be distinguishable from "the scheduler is dead", and
     this line is the only thing that distinguishes them. */
  if(!cars.length){
    /* An empty day and a finished day are both "nothing to post", but they
       are not the same news, and a log line that called an empty morning
       "all at or above the bar" would read as a completed day. */
    log(out.rows.length
      ? `alerts: ${out.rows.length} car(s) today, all at or above ${bar} mi — nothing to post`
      : `alerts: no deliveries yet today — nothing to post`);
    return { total: out.rows.length, missing: 0, cars: [], posted: false,
             reason: "all-complete", mode: out.mode, trtId: trt, site, date,
             done: sum.adoption, drove: sum.drove, resolved: sum.resolved };
  }

  const card = A.digestCard({ site, trtId: trt, date, bar, mode: out.mode,
                              total: out.rows.length, cars, now: new Date(),
                              summary: sum });

  const base = { total: out.rows.length, missing: cars.length, cars, card,
                 mode: out.mode, trtId: trt, site, date,
                 done: sum.adoption, drove: sum.drove, resolved: sum.resolved };
  if(!post) return { ...base, posted: false, reason: "preview" };

  const status = await A.postWithOneRetry(conn.alertWebhook, card);
  log(`alerts: posted ${cars.length} of ${out.rows.length} car(s) under ${bar} mi (HTTP ${status})`);
  return { ...base, posted: true, status };
}

/* ── the Tesla OS session, before the brief rather than during it ──

   The report renews a lapsed session by itself when it reaches the first order
   lookup (osEnsureToken, lib.js), so this is not what makes the brief work
   unattended — that already worked. What it changes is WHEN and WHETHER:

     · the renewal happens before the first Garage call rather than forty cars
       into the run, so the whole brief is measured against one live session
       instead of hitting the lapse mid-flight and going round again;
     · the ten-minute failure cooldown is cleared first. It exists so a machine
       that cannot reach Tesla OS does not spend forty-five seconds proving it
       on every hourly digest. The brief runs once a day and is the card that
       NAMES customers, so it is worth the forty-five seconds every time.

   A cold board is left alone deliberately: osEnsureToken refuses to open a
   window on a board that has never been connected, and that guard stays. The
   first sign-in is the one that may genuinely need a person, and popping a
   browser window on an unattended machine for an optional column is not a
   trade this board makes. The brief still goes out — Sub-Intent blank, with
   the "could not be checked" count saying so on the card itself.

   Never throws. Everything here is optional; a brief that failed to post
   because it could not get a token it does not strictly need would be a much
   worse bug than a brief with one column missing. */
async function briefOsPreflight(){
  if(L.effectiveMode(undefined).mode !== "advanced") return;   // basic never asks

  L.osClearHealCooldown();
  try{
    await L.osEnsureToken();
    log("brief: Tesla OS session is live");
  }catch(err){
    log(err.neverConnected
      ? "brief: never connected to Tesla OS — going out without Sub-Intent. " +
        "Press Connect on the Tesla OS card once and it renews itself from then on."
      : `brief: could not renew the Tesla OS session (${err.message}) — going out without Sub-Intent`);
  }
}

/* ── the morning brief ──

   Two reports, not one, and that is the whole shape of it: yesterday supplies
   the percentage, today supplies the people. Ed's framing — "here's where we
   ended yesterday, and here's who to talk to today".

   Yesterday's run is nearly free. Its windows have all closed, so every
   measurement is served from .measure-cache.json rather than re-read from
   Garage; the only live work is the enumeration.

   Always those two dates regardless of what is on screen, because this card
   means one thing and a version of it built from whatever the dashboard
   happened to be showing would not. */
async function runMorningBrief({ post = true } = {}){
  const conn = L.loadConnections();
  const trt  = L.savedTrtId();
  if(!trt) return { skipped: "no-trt", reason: "No centre is set on this board.", posted: false };

  await briefOsPreflight();

  const today = L.todayLocal();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const p = n => String(n).padStart(2, "0");
  const yesterday = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;

  /* Yesterday first. If it fails the brief still goes out — "we could not
     read yesterday" is a smaller loss than not telling anyone who to chase. */
  let ySum = null;
  try{
    const yOut = await L.collectReport({ dates: [yesterday], trtId: String(trt) });
    ySum = L.summarise(yOut.rows);
  }catch(err){
    log(`brief: yesterday (${yesterday}) could not be read — ${err.message}`);
  }

  /* TODAY'S APPOINTMENTS, not today's deliveries. The whole point of the card
     is to name people before they arrive, so the population is the diary —
     see briefAppointments in lib.js for why collectReport cannot answer this
     and why nothing is filtered out of it. */
  const out  = await L.briefAppointments(today, String(trt));
  const cars = A.noIntentCustomers(out.rows);
  const site = (await L.trtInfo(trt).catch(() => null) || {}).name || null;

  /* `total` matters as much as `unknown` here: the card has to be able to tell
     "none to chase" from "none checked", and that is unknown vs total, not a
     count on its own. */
  const card = A.briefCard({ site, trtId: trt, date: today, mode: out.mode,
                             yesterday: ySum, cars, unknown: out.unknown,
                             total: out.total, now: new Date() });

  const base = { total: out.total, noIntent: cars.length,
                 unknown: out.unknown, cars, card,
                 mode: out.mode, trtId: trt, site, date: today,
                 yesterdayDate: yesterday,
                 yesterdayDone: ySum ? ySum.adoption : null,
                 notices: out.notices };
  if(!post) return { ...base, posted: false, reason: "preview" };

  const status = await A.postWithOneRetry(conn.alertWebhook, card);
  log(`brief: posted — yesterday ${ySum ? ySum.adoption + "%" : "unread"}, ` +
      `${cars.length} of ${out.total} appointments today without Sub-Intent (HTTP ${status})`);
  return { ...base, posted: true, status };
}

/* Fires every 30s and asks one question of the current wall clock. NOT a
   setTimeout chained to the next hour boundary: that is stateful about the
   future, so a laptop sleeping through a fire loses the following hour too
   with nothing to notice. This has no chain to break. */
async function alertTick(){
  if(alertInFlight){
    /* Belt and braces on top of the 30s socket timeout in postToTeams: if
       an in-flight flag ever wedged, every subsequent hour would be skipped
       in silence, which is the one failure mode nobody would spot. */
    if(Date.now() - alertStartedAt > 20 * 60_000){
      warn("alerts: a run has been in flight 20 minutes — clearing the flag");
      alertInFlight = false;
    }
    return;
  }

  /* One decision, two possible cards. `kind` is "brief" only for the first
     post of an alert day — see shouldFire. */
  const due = A.shouldFire(L.loadConnections(), new Date(),
                           { lastHour: lastAlertHour, briefDate: L.briefSentDate() });
  if(!due) return;
  const { key, kind } = due;

  /* Skip, do not queue — and deliberately do not record the hour, so the
     next tick retries. Logged once per stretch rather than every 30s. */
  if(reportBusy()){
    if(!alertSkipLogged){
      log("alerts: a report is already running — will retry shortly");
      alertSkipLogged = true;
    }
    return;
  }
  alertSkipLogged = false;

  alertInFlight  = true;
  alertStartedAt = Date.now();
  try{
    const brief = kind === "brief";
    const out = brief
      ? await withReportLock("brief", () => runMorningBrief({ post: true }))
      : await withReportLock("alert", () => runAlertCheck({ post: true }));

    /* Recorded only when a card actually went out. A brief that failed, or
       that could not run because no centre is set, has not opened the day —
       so the next hour tries the brief again rather than quietly demoting the
       day to digests. It cannot post twice: the date is written here, and it
       is written to disk. */
    if(brief && out.posted) L.markBriefSent(due.date);

    lastAlertAt = new Date().toISOString();
    lastAlertKind = kind;
    lastAlertResult = out.skipped ? out.reason
      : brief ? `morning brief — ${out.noIntent} of ${out.total} without Sub-Intent`
      : out.posted ? `posted ${out.missing} car(s)`
      : "nothing to post — every car has driven";
    lastAlertError = null;
    if(out.skipped) log(`alerts: ${out.reason}`);
  }catch(err){
    lastAlertAt = new Date().toISOString();
    lastAlertKind = kind;
    lastAlertResult = null;
    lastAlertError  = err.message;
    warn(kind === "brief" ? "brief:" : "alerts:", err.message);
  }finally{
    /* Recorded even on failure. A failing hour that retried every 30s would
       hammer Garage 120 times an hour and bury the console; one attempt and
       one warning per hour is enough to notice and go fix it. The only
       condition that retries within the hour is a busy report, because that
       one genuinely resolves on its own. */
    lastAlertHour = key;
    alertInFlight = false;
  }
}

// Booting mid-hour must not fire immediately: starting the board at 09:47 and
// getting a card labelled as the nine o'clock check is a lie, and every
// restart during the day would post one. 09:02 still fires — the boundary is
// genuinely still in reach.
const CATCHUP_MIN = 10;

function startAlertClock(){
  if(new Date().getMinutes() >= CATCHUP_MIN) lastAlertHour = A.hourKey(new Date());

  /* The single most important line in the feature. An unhandled rejection
     inside a timer callback terminates the process on Node 15 and up, and
     this board has no global handler. */
  const tick = () => { alertTick().catch(err => warn("alert tick:", err && err.message)); };

  // unref so this timer can never be the reason the process refuses to exit.
  // The HTTP server holds the loop open anyway, so nothing else changes.
  const t = setInterval(tick, 30_000);
  if(t.unref) t.unref();
  tick();
}

/* Errors carry a hint so the UI can point at the right fix rather than just
   printing a stack: a dead cookie and a dead Garage token need different
   actions from the person reading the screen. */
function sendErr(res, err){
  const code = err.needsTrt ? 400
             : (err.needsCookie || err.needsAuth || err.needsOs ? 401 : 502);
  sendJson(res, code, {
    error      : err.message,
    needsCookie: Boolean(err.needsCookie),
    needsAuth  : Boolean(err.needsAuth),
    needsTrt   : Boolean(err.needsTrt),
    // Tesla OS renews itself on demand, so this only ever reaches the page
    // when the repair itself failed — which is a different fix from the
    // others and gets its own message.
    needsOs    : Boolean(err.needsOs)
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p   = url.pathname;

  try{
    /* ── page ── */
    if(p === "/" || p === "/index.html"){
      const html = fs.readFileSync(INDEX);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
                           "Cache-Control": "no-store" });
      return res.end(html);
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
        mode       : c.mode,
        // Restored on first paint so the page opens on the centre it was left
        // on, rather than asking again every visit.
        trtId      : c.trtId,
        trt        : c.trtId ? await L.trtInfo(c.trtId) : null,
        today      : L.todayLocal(),
        /* How the background job is getting on. Without this, "the alerts
           stopped working" is only discoverable by scrolling a console. */
        alertStatus: { at: lastAlertAt, kind: lastAlertKind,
                       result: lastAlertResult, error: lastAlertError },
        // The page explains the vitals ceiling in its own words; it should not
        // hardcode the number that produces it.
        vitalsDays : L.VITALS_CEILING_DAYS,
        // Same again for the measurement window: the page says "12 hours" in
        // several places and every one of them comes from here.
        windowHours: L.windowHours(),
        // Each VIN links to its vitals in Garage. The host is configuration —
        // a run against another region's Garage should link there and not at
        // a base the page had baked in.
        garageUrl  : L.garageUrl()
      });
    }

    /* ── where the running report has got to ── */
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

    /* ── the Tesla OS session ──

       Ungated, like /api/state and for the same reason: none of these returns
       a credential, and connecting is a thing you do because a badge is
       missing, not a privileged act. `live` costs one authenticated round trip
       and is cached for a minute inside lib.

       Worth knowing while reading these: /connect is pressed once per machine
       and then effectively never again — a session that has worked before is
       renewed automatically by the run that needs it. A cold board is the one
       case that waits to be asked. See osEnsureToken in lib.

       /reconnect is now the same thing as /connect on a warm board — both
       clear the cooldown and force a fresh token — and the UI no longer calls
       it. Kept as a curl-able one-shot; delete it if that stops being useful. */
    if(p === "/api/os" && req.method === "GET"){
      const st = await L.osStatus();
      return sendJson(res, 200, {
        connection: L.connectionsSummary().os,
        live      : st.connected,
        who       : { user: st.user, name: st.name, title: st.title },
        signin    : L.osSignInStatus()
      });
    }

    if(p === "/api/os/connect" && req.method === "POST"){
      return sendJson(res, 200, { ok: true, signin: L.osSignIn() });
    }

    if(p === "/api/os/cancel" && req.method === "POST"){
      return sendJson(res, 200, { ok: true, signin: L.osCancelSignIn() });
    }

    /* Force a fresh session now, skipping the ten-minute cooldown a failed
       attempt leaves behind. For the case where someone has just fixed
       whatever was wrong and does not want to wait it out. */
    if(p === "/api/os/reconnect" && req.method === "POST"){
      const out = await L.osReconnect();
      log("tesla os session renewed by hand");
      return sendJson(res, 200, { ok: true, ...out });
    }

    if(p === "/api/os/disconnect" && req.method === "POST"){
      const out = L.osDisconnect();
      log("tesla os session forgotten");
      return sendJson(res, 200, { ok: true, ...out, connection: L.connectionsSummary().os });
    }

    /* ── AD username → display name, for the other boards ──

       This board is the only one allowed to speak MCP. The rule is written out
       in credstore.js: the Hub mints tokens and never refreshes, exactly one
       board consumes and rotates, and a second MCP consumer would reintroduce
       a bug this estate has already had — two clients sharing a refresh token,
       whoever refreshes first invalidating the other.

       So when ZO-003 wanted full names instead of usernames, the answer was not
       to copy the OAuth client into it. `lookup_user` is the one Garage call
       with no cookie equivalent, and it already lives here behind a disk cache;
       offering it over HTTP costs one route and keeps the single-writer
       property intact.

       No admin password: a display name is not privileged, the caller already
       has the username, and the reply carries nothing else the lookup returns. */
    if(p === "/api/staff" && req.method === "GET"){
      const users = [...new Set((url.searchParams.get("users") || "")
        .split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];

      if(!users.length) return sendJson(res, 200, { names: {} });
      // A centre's roster is tens of people. A request far past that is a
      // caller with a bug, and answering it would mean that many MCP calls.
      if(users.length > 200){
        return sendJson(res, 400, { error: "Too many usernames in one request (max 200)" });
      }

      const cache = await L.resolveStaff(users);
      const names = {};
      for(const u of users){
        const n = L.staffName(cache, u);
        // staffName falls back to the username itself. Send that back as
        // absent rather than as an answer — the caller has its own fallback
        // and cannot tell an echo from a real name that happens to match.
        if(n && n.toLowerCase() !== u) names[u] = n;
      }
      return sendJson(res, 200, { names });
    }

    /* ── remember the chosen centre ──
       The one mutating route that does not take the admin password, and
       deliberately so. Picking your centre is the dashboard's primary
       interaction, not an administrative act; it was already freely settable
       per session, and persisting it changes how long the choice lasts, not
       who is allowed to make it. Gating it behind the admin code would mean
       unlocking Admin to use the tool at all. */
    if(p === "/api/trt" && req.method === "POST"){
      const body = await readBody(req);
      const raw  = body.trtId == null ? "" : String(body.trtId).trim();

      if(raw === ""){
        L.saveConnections({ trtId: null });
        return sendJson(res, 200, { ok: true, trtId: null });
      }
      if(!/^\d+$/.test(raw)){
        return sendJson(res, 400, { error: "TRT must be numeric" });
      }

      L.saveConnections({ trtId: Number(raw) });
      log(`trt -> ${raw}`);
      return sendJson(res, 200, { ok: true, trtId: Number(raw),
                                  trt: await L.trtInfo(raw) });
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

    /* ── the report ── */
    if(p === "/api/fsd" && req.method === "POST"){
      const body  = await readBody(req);
      /* A single-car search carries its own date and centre, so the date and
         TRT rules below are about the other kind of request and are skipped.
         An RN is one of these too — it becomes a VIN inside collectReport,
         which is where the centre it is looked up in is decided. */
      const vin   = body.vin ? String(body.vin).trim().toUpperCase() : null;
      const rn    = body.rn ? L.normaliseRn(body.rn) : null;
      const one   = Boolean(vin || rn);
      const dates = one ? [] : L.expandDates(String(body.date || "today").trim());
      const trtId = body.trtId ? String(body.trtId).trim() : null;

      if(vin && !L.isVin(vin)){
        return sendJson(res, 400, {
          error: "A VIN is 17 characters, letters and digits, with no I, O or Q" });
      }
      if(rn && !L.isRn(rn)){
        return sendJson(res, 400, {
          error: "A reference number is RN followed by the order's digits, as on the order page" });
      }
      if(trtId && !/^\d+$/.test(trtId)){
        return sendJson(res, 400, { error: "TRT must be numeric" });
      }
      /* An RN is resolved in the centre on screen, so unlike a VIN it cannot
         be searched without one. Caught here rather than after the round trip
         so the page can open the TRT picker straight away. */
      if(rn && !vin && !trtId){
        return sendJson(res, 400, {
          error: `A reference number is looked up in one centre's appointments, so set a ` +
                 `centre first — choose Enter TRT in the top corner. A VIN needs none.`,
          needsTrt: true });
      }
      if(!one){
        if(!dates.length || !dates.every(L.isDate)){
          return sendJson(res, 400, { error: "Use YYYY-MM-DD, YYYY-MM-DD..YYYY-MM-DD, or today" });
        }
        if(!trtId){
          return sendJson(res, 400, {
            error: "No TRT set — choose Enter TRT in the top corner", needsTrt: true });
        }
        if(dates.length > 31){
          return sendJson(res, 400, { error: `That range is ${dates.length} days — keep it to 31 or fewer` });
        }
      }

      const started = Date.now();
      // Queues behind anything already running — including the board's own
      // hourly check. The page shows whose run it is waiting on.
      // An explicit mode from the page wins, so the admin toggle can refresh
      // the view without a round trip through saved settings.
      const out = await withReportLock("user", () =>
        L.collectReport({ dates, trtId, vin, rn, mode: body.mode,
                          onProgress: jobUpdate }));
      // The RN is logged with whatever it resolved to, so a search that found
      // nothing can be told apart from one that found the wrong car.
      const what = rn ? `${rn}${out.vin ? " → " + out.vin : " (unresolved)"}`
                      : vin ? "VIN " + vin
                            : dates.length + "d";
      log(`report: ${what} TRT ${out.trtId} ${out.mode} → ${out.rows.length} vehicles in ${
            ((Date.now() - started) / 1000).toFixed(1)}s`);

      /* The dates a single-car search covers are not known until the car has
         been found, so they come back off the result rather than the request. */
      const covered = one ? (out.perDate || []).map(d => d.date) : dates;

      // Only what the dashboard renders. No customer PII leaves the server.
      return sendJson(res, 200, {
        trtId  : out.trtId,
        trt    : out.trtId ? await L.trtInfo(out.trtId) : null,
        mode   : out.mode,
        vin    : out.vin || null,
        // Echoed so the page can show which reference number the car came
        // from, rather than a VIN the person never typed.
        rn     : out.rn || null,
        single : Boolean(out.single),
        dates  : covered,
        perDate: out.perDate,
        notices: out.notices,
        summary: L.summarise(out.rows),
        // Computed server-side so the page cannot invent its own definition
        // of "share of deliveries" or "FSD rate".
        hosts  : out.mode === "advanced" ? L.byHost(out.rows) : [],
        // Volume only, deliberately — see byAdvisor.
        advisors: out.mode === "advanced" ? L.byAdvisor(out.rows) : [],
        minQualify: L.MIN_QUALIFY,
        // The bar this run was scored against. The page colours rows itself,
        // so it has to colour them by the same number the summary counted.
        droveThreshold: L.droveThreshold(),
        windowHours: L.windowHours(),
        rows   : out.rows.map(r => ({
          rn: r.rn || "", customer: r.customer || "",
          vin: r.vin, date: r.date, model: r.model,
          deliveredAt: r.deliveredAt || null,
          host: r.host || "", hostUser: r.hostUser || "",
          advisor: r.advisor || "", miles: r.miles ?? null,
          // Miles since handoff with no cutoff, as of the car's latest
          // reading. Shown under the headline figure and never counted into
          // it — every total on the page is the windowed number.
          milesToDate: r.milesToDate ?? null, toDateAt: r.toDateAt || null,
          gapMin: r.baselineGapMin ?? null, error: r.error || null,
          // Whether the 12-hour window has closed on this car. The page marks
          // an open row and the export notes it, so nobody treats a figure
          // that is still moving as a final one.
          final: r.final ?? null,
          windowEndsAt: r.windowEndsAt || null,
          // True when this car's usual FSD counter was dead and the figure was
          // read off the backup one. Round-trips through re-score and export so
          // the caveat survives everywhere the number goes.
          altCounter: r.altCounter === true,
          /* Whether the customer wants FSD, from the Tesla OS order.
             "intent" | "has" | "none" | null, and null is NOT "none" — it is
             the question we could not ask. The page must render those two
             differently, and the morning brief must only ever chase "none". */
          fsdIntent: r.fsdIntent ?? null,
          // The order's own wording, e.g. "Trial expiring September 25, 2026,
          // Subscription Intended". Shown on hover so the expiry date is
          // reachable without another column.
          fsdStatus: r.fsdStatus || ""
        }))
      });
    }

    /* ── re-score what is on screen against the current threshold ──
       Moving the bar changes no measurement, only the verdict on each one, so
       re-running the report would spend a Garage round trip to arrive at the
       same mileage — and, because FSD miles climb through the day, arrive at
       a *different* one. The rows come back from the page like the export's
       do, and the counts are recomputed by the same lib functions a run uses,
       so the leaderboard cannot drift into its own definition of the rule.

       No password: this recomputes data the caller already holds and writes
       nothing. Changing the bar is the gated act, and that is the route above. */
    if(p === "/api/rescore" && req.method === "POST"){
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if(!rows.length) return sendJson(res, 400, { error: "Nothing loaded to re-score" });

      // The page is sent a trimmed row: the gap is `gapMin` there and
      // `baselineGapMin` here, and summarise reads the latter.
      const scored = rows.map(r => ({ ...r, baselineGapMin: r.gapMin ?? null }));
      const advanced = L.normaliseMode(body.mode) === "advanced";

      return sendJson(res, 200, {
        ok: true,
        droveThreshold: L.droveThreshold(),
        summary : L.summarise(scored),
        hosts   : advanced ? L.byHost(scored) : [],
        advisors: advanced ? L.byAdvisor(scored) : []
      });
    }

    /* ── export what is currently on screen ──
       Takes the rows from the client rather than re-running the report, so the
       file matches the page exactly and costs nothing. Re-running would also
       return different numbers: FSD miles keep climbing through the day. */
    if(p === "/api/export" && req.method === "POST"){
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if(!rows.length) return sendJson(res, 400, { error: "Nothing loaded to export" });

      const label = String(body.label || "export").replace(/[^0-9A-Za-z_.-]+/g, "-");

      /* Basic mode has no reference number and no advisor, so it does not get
         two columns of blanks — an empty column reads as missing data rather
         than as a source that was never consulted. */
      const advanced = L.normaliseMode(body.mode) === "advanced";

      /* Caveats stack: a row can both be unfinished and have a leaky baseline,
         and dropping either one would be the interesting half. */
      const win = L.windowHours();
      const noteFor = r => [
        r.error ? String(r.error) : "",
        r.final === false
          ? `Still inside the ${win} h window — this figure will keep climbing`
          : "",
        r.gapMin != null && r.gapMin > 60
          ? "Baseline older than an hour — staff driving may be counted"
          : "",
        r.altCounter
          ? "This car's usual FSD counter never moved — figure read off the backup counter"
          : ""
      ].filter(Boolean).join("; ");

      const buf = xlsx.build({
        sheetName: "FSD",
        columns: [
          ...(advanced ? [{ key: "rn", header: "Reference number", width: 18 }] : []),
          { key: "vin",     header: "VIN",              width: 20 },
          { key: "date",    header: "Delivery date",    width: 14 },
          // Two separate columns, never merged. The host is who ran the
          // handover and owns the FSD figure; the advisor owns the
          // appointment. They differ on about a third of cars.
          ...(advanced ? [{ key: "host",    header: "Delivery host",    width: 22 },
                          { key: "advisor", header: "Delivery advisor", width: 22 },
                          // The order's own wording, not a yes/no. "Not asked"
                          // and "said nothing" are different answers and the
                          // spreadsheet has room to say which.
                          { key: "fsd",     header: "FSD Sub-Intent",   width: 42 }] : []),
          { key: "miles",   header: `FSD miles, first ${win} h`, width: 24,
            type: "number", digits: 2 },
          { key: "model",   header: "Model",            width: 12 },
          { key: "gapMin",  header: "Baseline gap (min)", width: 19,
            type: "number", digits: 0 },
          { key: "note",    header: "Note",             width: 30 }
        ],
        rows: rows.map(r => ({
          rn: r.rn, vin: r.vin, date: r.date,
          host: r.host || r.hostUser || "",
          advisor: r.advisor || "",
          miles: r.miles,
          model: r.modelLabel || r.model || "",
          gapMin: r.gapMin,
          fsd: r.fsdIntent == null ? "Not known"
             : r.fsdIntent === "none" ? "No Sub-Intent"
             : (r.fsdStatus || (r.fsdIntent === "intent" ? "Sub-Intent" : "Has FSD")),
          note: noteFor(r)
        }))
      });

      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="fsd-${label}.xlsx"`,
        "Content-Length": buf.length,
        "Cache-Control": "no-store"
      });
      return res.end(buf);
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


    /* ── which sources a run uses ──
       Saved rather than held per session, so the CLI and the dashboard agree
       about what a report means. Switching to advanced without a cookie is
       allowed and reported: the toggle should reflect the intent, and the
       report degrades to basic rather than failing. */
    if(p === "/api/admin/mode" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });

      const mode = String(body.mode || "");
      if(!L.MODES.includes(mode)){
        return sendJson(res, 400, { error: `Mode must be one of: ${L.MODES.join(", ")}` });
      }
      L.saveConnections({ mode });
      log(`mode -> ${mode}`);

      const connections = L.connectionsSummary();
      return sendJson(res, 200, {
        ok: true, mode, connections,
        // Lets the panel warn before a run rather than after it.
        needsCookie: mode === "advanced" && !connections.intrepid.set
      });
    }

    /* ── what counts as having driven on FSD ──
       Saved like mode is, for the same reason: the CLI and the dashboard have
       to agree about what a report means. Sending null clears the local
       choice and hands the decision back to config.json. */
    if(p === "/api/admin/threshold" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });

      let value = null;
      if(body.droveThreshold != null && body.droveThreshold !== ""){
        const n = Number(body.droveThreshold);
        if(!Number.isFinite(n) || n < 0){
          return sendJson(res, 400, { error: "Give a distance of 0 or more" });
        }
        // A day's post-delivery driving is single-digit miles. A bar above
        // this is a typo — 100 instead of 1.0 — and would silently score
        // every car as a failure.
        if(n > 50) return sendJson(res, 400, { error: "That is higher than any car will drive — keep it under 50" });
        // Two decimals is finer than the mileage is trustworthy.
        value = Math.round(n * 100) / 100;
      }

      L.saveConnections({ droveThreshold: value });
      log(`drove threshold -> ${value == null ? "default" : value} mi`);
      return sendJson(res, 200, {
        ok: true,
        droveThreshold: L.droveThreshold(),
        connections: L.connectionsSummary()
      });
    }


    /* ── hours of operation, and where the digest goes ──
       One route for all five settings rather than five routes: they share a
       file, a merge, a validator and a summary, and splitting them would be
       four more copies of the auth-and-log boilerplate. */
    if(p === "/api/admin/alerts" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });

      /* Every field is guarded on `undefined`, not on falsiness: `on:false`
         and `webhook:""` are both real instructions, and a body carrying
         only { on } must not blank the webhook someone pasted an hour ago. */
      const patch = {};
      if(body.on      !== undefined) patch.alertsOn     = body.on;
      if(body.webhook !== undefined) patch.alertWebhook = String(body.webhook).trim();
      if(body.start   !== undefined) patch.alertStart   = String(body.start).trim();
      if(body.end     !== undefined) patch.alertEnd     = String(body.end).trim();
      if(body.days    !== undefined) patch.alertDays    = body.days;

      /* Validated against the MERGED settings, not the patch alone. Saving a
         start time has to be checked against whatever end time is already
         stored, or a two-field form becomes a way to persist 18:00–09:00. */
      const bad = A.validateSettings({ ...L.loadConnections(), ...patch }, patch);
      if(bad) return sendJson(res, 400, { error: bad });

      L.saveConnections(A.cleanSettings(patch));

      const connections = L.connectionsSummary();
      const al = connections.alerts;
      log(`alerts -> ${al.armed ? `on ${al.start}–${al.end} ${al.dayLabel}`
                                : `off (${al.why})`}`);
      return sendJson(res, 200, { ok: true, connections });
    }

    /* ── prove the webhook works ──
       Sends a sample digest without running a report. Fires even when alerts
       are switched off, and says so: a test button that silently did nothing
       while switched off is indistinguishable from a broken webhook. */
    if(p === "/api/admin/alerts/test" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });

      const conn = L.loadConnections();
      if(!String(conn.alertWebhook || "").trim()){
        return sendJson(res, 400, { error: "No webhook set — save one first, then test it." });
      }
      try{
        const status = await A.postToTeams(conn.alertWebhook,
                                           A.sampleDigestCard(L.connectionsSummary()));
        log(`alerts: test card sent (HTTP ${status})`);
        return sendJson(res, 200, { ok: true, status, alertsOff: conn.alertsOn !== true });
      }catch(err){
        warn("alerts: test failed —", err.message);
        return sendJson(res, 502, { error: err.message });
      }
    }

    /* ── the manual override ──
       Loads the board's data and sends the real card, right now, regardless
       of the hours, the day or the master switch. The only thing it needs is
       a webhook.

       Queues on the report lock like any user run, because it IS one —
       somebody pressed a button. Deliberately does NOT touch lastAlertHour:
       sending manually at 10:05 must not cancel the 11:00 post.

       `post` defaults to FALSE. A route called "run" that posted by default
       would put a card in a channel on a mis-click, and the preview is also
       what makes the whole feature testable without spamming anyone. */
    if(p === "/api/admin/alerts/run" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });

      const post = body.post === true;
      if(post && !String(L.loadConnections().alertWebhook || "").trim()){
        return sendJson(res, 400, { error: "No webhook set — save one first." });
      }

      const out = await withReportLock("alert-manual", () => runAlertCheck({ post }));
      if(post && out.posted){
        lastAlertAt = new Date().toISOString();
        lastAlertResult = `sent by hand — ${out.missing} car(s)`;
        lastAlertError = null;
      }
      // The card travels back whole, so the panel can preview exactly what
      // would be sent and an assertion script can read it apart.
      return sendJson(res, 200, { ok: true, ...out });
    }


    /* ── send the morning brief by hand ──
       Always yesterday's percentage and today's list, whatever the dashboard
       is currently showing. `post:false` previews the card without touching
       the channel, which is how you check the wording. */
    if(p === "/api/admin/brief/run" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });

      const post = body.post === true;
      if(post && !String(L.loadConnections().alertWebhook || "").trim()){
        return sendJson(res, 400, { error: "No webhook set — save one first." });
      }

      const out = await withReportLock("brief-manual", () => runMorningBrief({ post }));

      /* Sending by hand DOES count as the day's brief, unlike Send now on the
         hourly card. The difference is what a duplicate costs: a second digest
         is noise, a second brief names the same customers in the channel
         again. Someone who sends it at 08:00 has opened the day, so the first
         scheduled post is a digest. */
      if(out.posted){
        L.markBriefSent(A.dayKey(new Date()));
        log("brief: sent by hand — that is today's brief, the schedule will not repeat it");
      }
      return sendJson(res, 200, { ok: true, ...out });
    }

    if(p === "/api/admin/clear-vin-cache" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.clearVinTrtCache();
      log(`vin->trt cache cleared (${out.cleared} entries)`);
      return sendJson(res, 200, { ok: true, ...out });
    }

    /* ── forget settled measurements ──
       Normally pointless: a closed window cannot produce a different answer,
       which is the whole reason it is stored. It exists for the case where the
       stored answer is suspect — a run made against the wrong window length,
       or telemetry that has since been corrected. Clearing costs one Garage
       call per car on the next run of those dates. */
    if(p === "/api/admin/clear-measure-cache" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.clearMeasureCache();
      log(`measurement cache cleared (${out.cleared} entries)`);
      return sendJson(res, 200, { ok: true, ...out });
    }

    if(p === "/api/admin/reset" && req.method === "POST"){
      const body = await readBody(req);
      if(!authed(body)) return sendJson(res, 401, { error: "Wrong password" });
      const out = L.resetDashboard();
      log("dashboard reset (credentials kept)");
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
      // the same permission as reading delivered vehicles, and the whole
      // cookie-free path rests on the latter.
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
  log(`FSD Tracker on http://localhost:${PORT}`);
  const c = L.connectionsSummary();
  log(`  mode ${c.mode} · garage ${c.garage.detail}`);
  if(c.mode === "advanced"){
    log(`  intrepid ${c.intrepid.set ? "cookie saved" : "NO COOKIE — runs will fall back to basic"}`);
  }
  /* Said once at boot rather than logged every tick — 2,880 "nothing to do"
     lines a day would bury everything else. This one line is how you tell a
     board that is armed from one that quietly is not. */
  log(`  alerts ${c.alerts.armed
        ? `on the hour ${c.alerts.start}–${c.alerts.end} ${c.alerts.dayLabel} → ${c.alerts.webhook.hint}`
        : `off — ${c.alerts.why}`}`);
  /* Which card the next fire will be. The brief is the day's first post, so
     after a restart this is the one line that says whether today has already
     been opened — otherwise the only way to know is to wait and see. */
  if(c.alerts.armed){
    log(`  brief ${c.alerts.brief.sentToday
          ? "already sent today — the next post is a digest"
          : `not sent today — the first post of the day is the brief (from ${c.alerts.start})`}`);
  }
  // Started only after the port is bound. Nothing should be scheduled before
  // the thing it reports on can be reached.
  startAlertClock();
});

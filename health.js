/* Watching the cookies go stale.

   The MCP token has always known when it expires — it carries an `expires_at`
   and the panel counts it down. The three cookies never did. They were probed
   once, at capture, and then trusted forever: a row read `saved …a1b2c3d4`
   whether the session had died an hour ago or was fine, and the front page
   counted it as connected either way. The first thing to notice an expiry was
   a board, mid-task, taking a 401.

   So this sweeps them on a timer, and when one is confirmed dead it opens the
   sign-in window rather than waiting to be asked.

   ── in memory, never on disk ──

   Same reasoning as ATTEMPTS in signin.js: a verdict is a claim about what
   this process has actually checked. Persisting "dead" across a restart would
   have the Hub asserting on boot something it has not looked at yet. Boot
   starts at `unknown` and the first sweep — seconds later — fills it in.

   ── two strikes, and why null is not a strike ──

   A probe answers live / rejected / no-answer (see probes.js). Only a
   rejection counts against a cookie, and one rejection is not enough: Garage
   returns the occasional blip, and a single bad answer should not throw a
   browser window at somebody. Two consecutive rejections is a death. At a
   five-minute sweep that is ten minutes to certainty, which is nothing
   against a cookie that lasts hours, and it makes a false alarm cost a wait
   rather than an interruption.

   A no-answer — dropped VPN, DNS hiccup, laptop lid — is not evidence of
   anything and clears no strikes either. The state reads `unknown`, the panel
   keeps showing the credential as fine, and the next sweep tries again.

   ── the store is never written here ──

   A dead cookie stays exactly where it is. Clearing it would mean a
   false-positive could destroy a working credential, which is a worse bug
   than the stale row this file exists to fix, and a dead value sitting in the
   file costs nothing. This module reads the store and never writes it; the
   only thing it can cause to be written is a fresh cookie, by way of a
   sign-in that succeeded.                                                  */

"use strict";

const credstore = require("./credstore");
const signin    = require("./signin");
const probes    = require("./probes");

/* The cookies, and only the cookies. MCP is left out on purpose: it already
   reports its own expiry, ZO-002 refreshes it on the next call, and an expired
   access token there is not a fault to be alarmed about. GitHub is a pasted
   token with nothing to probe. */
const WATCHED = [
  { key: "garage:prod", source: "garage",   env: "prod", label: "Garage · prod" },
  { key: "garage:eng",  source: "garage",   env: "eng",  label: "Garage · eng"  },
  { key: "intrepid",    source: "intrepid", env: null,   label: "Intrepid"      }
];

const DEFAULTS = { healthCheckMs: 5 * 60 * 1000, healthStrikes: 2, autoReconnect: true };

let cfg  = { ...DEFAULTS };
let log  = () => {};
let timer = null;

/* `state` is what the panel renders:
     live     probed and accepted
     dead     rejected `healthStrikes` times running
     unknown  never probed yet, or the last probe got no answer
     unset    nothing stored for this key, so nothing to check

   `probed` is the cookie the verdict actually belongs to. A verdict is about
   a value, not about a row: the moment a fresh cookie is captured — by the
   auto sign-in below, by the Connect button, by another board — every earlier
   answer describes a string that is no longer in the store. Without this, a
   successful sign-in would leave the row reading "expired" until the next
   sweep got round to it, which is the exact stale-row problem this file was
   written to end. */
const STATE = new Map(WATCHED.map(w => [w.key, {
  state: "unknown", checkedAt: null, lastLive: null,
  strikes: 0, autoOpened: false, probed: null
}]));

const st = key => STATE.get(key);

const cookieFor = w => w.source === "garage"
  ? credstore.garageCookie(w.env).value
  : credstore.intrepidCookie().value;

const busyPhase = p => p === "opening" || p === "waiting" || p === "verifying";

/* ── the auto-reconnect queue ──

   One window at a time. Three cookies expiring together is the common case
   rather than the exception — one laptop, one SSO, one afternoon — and firing
   three sign-ins at once would race them all onto the same CDP debug port and
   throw three tabs up in the same second. Serialising costs nothing: the
   second sign-in is usually instant anyway, because the window the first one
   opened is already signed into the shared profile.

   Each entry waits for the one before it to settle, or to hit the deadline
   signin.js already enforces. */
const QUEUE = [];
let draining = false;

function enqueueReconnect(w){
  if(QUEUE.some(q => q.key === w.key)) return;
  QUEUE.push(w);
  drain();
}

async function drain(){
  if(draining) return;
  draining = true;
  try{
    while(QUEUE.length){
      const w = QUEUE.shift();

      // Conditions change while an entry waits its turn. The credential may
      // have been forgotten, or somebody may have signed in by hand while the
      // window ahead of this one was open — in which case the death this entry
      // was queued for is already fixed.
      if(st(w.key).state !== "dead") continue;
      if(busyPhase(signin.statusOf(w.source, w.env).phase)) continue;

      log(`${w.label} session expired — opening a sign-in window`);
      try{
        await signin.startCookieSignIn(w.source, w.env, w.label, log);
      }catch(err){
        log(`${w.label} auto sign-in could not start: ${err.message}`);
        continue;
      }

      // startCookieSignIn returns as soon as the window is up; the capture
      // runs on after it. Wait that out before opening the next one, so two
      // windows are never competing for the same debug port.
      while(busyPhase(signin.statusOf(w.source, w.env).phase)){
        await new Promise(r => setTimeout(r, 1_000));
      }

      // Settle the verdict now rather than at the next sweep. If the sign-in
      // worked the row should go green immediately, and if it timed out the
      // row should say so rather than sitting on a five-minute-old answer.
      await checkOne(w).catch(() => {});
    }
  }finally{
    draining = false;
  }
}

/* ── one key ── */

async function checkOne(w){
  const s = st(w.key);
  const cookie = cookieFor(w);

  if(!cookie){
    Object.assign(s, { state: "unset", strikes: 0, autoOpened: false,
                       checkedAt: Date.now(), probed: null });
    return s;
  }

  /* A different value than the one that earned the current verdict means a
     fresh capture landed. Strikes belong to the old string, not to this one,
     and so does the latch — a new cookie has earned its own window if it dies. */
  if(s.probed && s.probed !== cookie){
    Object.assign(s, { strikes: 0, autoOpened: false });
  }

  /* A sign-in in flight is already probing this exact cookie every two
     seconds. Probing alongside it would double the load on Garage and could
     have the row contradicting itself mid-capture. */
  if(busyPhase(signin.statusOf(w.source, w.env).phase)) return s;

  const alive = await probes.probeFor(w.source, w.env)(cookie);
  s.checkedAt = Date.now();
  s.probed    = cookie;

  if(alive === true){
    const recovered = s.state === "dead";
    // Re-arm the latch: this cookie has earned another automatic window if it
    // dies again later.
    Object.assign(s, { state: "live", strikes: 0, autoOpened: false,
                       lastLive: s.checkedAt });
    if(recovered) log(`${w.label} session is live again`);
    return s;
  }

  if(alive === null){
    // No verdict. Not a strike, and not a recovery either.
    s.state = "unknown";
    return s;
  }

  s.strikes++;
  if(s.strikes < cfg.healthStrikes){
    // Rejected once. Say nothing yet — a blip that clears on the next sweep
    // should never have been mentioned.
    s.state = "unknown";
    return s;
  }

  const wasDead = s.state === "dead";
  s.state = "dead";
  if(!wasDead) log(`${w.label} session rejected ${s.strikes}× — marking it expired`);

  /* Fire once per death, not once per sweep. Without the latch a session that
     stays dead — nobody at the desk, or a sign-in that timed out — would open
     a fresh window every five minutes until somebody came back to a screen
     full of them. */
  if(cfg.autoReconnect && !s.autoOpened){
    s.autoOpened = true;
    enqueueReconnect(w);
  }
  return s;
}

/* ── the sweep ──
   Sequential rather than parallel: three cheap requests five minutes apart do
   not need concurrency, and going one at a time keeps the boot log readable
   and the load on Garage obviously trivial. */
let sweeping = null;

function checkNow(){
  // Collapse overlapping callers onto the one sweep in flight. The panel's
  // Check now button and the timer can land together.
  if(sweeping) return sweeping;
  sweeping = (async () => {
    try{
      for(const w of WATCHED) await checkOne(w);
      return summary();
    }finally{
      sweeping = null;
    }
  })();
  return sweeping;
}

/* Resolved against the store on every call rather than read straight out of
   STATE. A sweep is up to five minutes away, and a cookie captured thirty
   seconds ago must not be reported under the verdict that belonged to the one
   it replaced — the panel would show "expired" over a sign-in that had just
   succeeded. An unverified cookie reads `unknown`, which the panel treats as
   fine-until-shown-otherwise. */
function stateOf(w){
  const s = st(w.key);
  const cookie = cookieFor(w);
  if(!cookie) return "unset";
  if(s.probed !== cookie) return "unknown";
  return s.state === "unset" ? "unknown" : s.state;
}

function summary(){
  return {
    intervalMs   : cfg.healthCheckMs,
    strikes      : cfg.healthStrikes,
    autoReconnect: cfg.autoReconnect,
    keys: Object.fromEntries(WATCHED.map(w => {
      const s = st(w.key);
      return [w.key, {
        state    : stateOf(w),
        checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null,
        lastLive : s.lastLive  ? new Date(s.lastLive).toISOString()  : null
      }];
    }))
  };
}

/* Forgetting a credential has to clear its verdict too, or a stale "dead"
   would outlive the cookie it described — and worse, keep the latch set so a
   freshly captured cookie that expired later got no window. */
function reset(source, env){
  const s = STATE.get(signin.keyOf(source, env));
  if(s) Object.assign(s, { state: "unset", strikes: 0, autoOpened: false,
                           checkedAt: null, lastLive: null, probed: null });
}

function start(config = {}, logger){
  cfg = { ...DEFAULTS, ...config };
  if(logger) log = logger;
  if(timer) clearInterval(timer);

  // unref so a sweep pending on a five-minute timer never holds the process
  // open on its own — the HTTP server is what keeps the Hub alive.
  timer = setInterval(() => { checkNow().catch(() => {}); }, cfg.healthCheckMs);
  if(timer.unref) timer.unref();

  return checkNow();
}

const stop = () => { if(timer) clearInterval(timer); timer = null; };

module.exports = { start, stop, checkNow, summary, reset, WATCHED };

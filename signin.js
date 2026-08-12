/* Waiting for a sign-in to finish.

   Pressing Connect opens a window and then waits — it does not ask anyone to
   come back and press Connect a second time once they are signed in. The
   waiting happens HERE, server-side, rather than in the page, for the reason
   it always did: a sign-in takes as long as it takes, and a browser tab that
   gets closed mid-flow should not abandon a capture that is seconds from
   succeeding. The panel polls for the outcome and can be closed and reopened
   without affecting it.

   Every credential runs the same little state machine:

     idle → verifying → waiting → connected
                              ↘ failed / cancelled

   `verifying` first, before anything opens: the shared profile may already be
   signed in from an earlier capture or another board, in which case the whole
   thing is over before the click finishes and no window appears at all.

   ── proving it, not just finding it ──

   A cookie that exists is not a session that works, and the gap is not
   theoretical: Garage hands anonymous visitors a `_garage_session` too. So a
   captured header is probed before it is adopted, and an unchanged header is
   never re-probed — otherwise this would hammer Garage every two seconds
   while somebody types a password.

   The probes themselves moved to `probes.js` once `health.js` started asking
   the same question on a timer. Same three-way answer, and the `null` case
   still matters here: a network failure mid-capture must not be read as a
   rejection, or a dropped VPN would end a sign-in somebody is in the middle
   of.                                                                      */

"use strict";

const connector = require("./connect");
const credstore = require("./credstore");
const mcpAuth   = require("./garage-oauth");
const probes    = require("./probes");

const POLL_MS     = 2_000;
const DEADLINE_MS = 3 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* One attempt per credential. Not persisted: an attempt belongs to the minute
   somebody is looking at the panel, and a "waiting" left over from a previous
   run would be a lie on boot. */
const ATTEMPTS = new Map();

const keyOf = (source, env) =>
  source === "garage" ? `garage:${env === "eng" ? "eng" : "prod"}` : source;

const IDLE = { phase: "idle", detail: null, error: null, since: null,
               deadline: null, cancel: false, lastProbed: null, browser: null };

function attempt(key){
  if(!ATTEMPTS.has(key)) ATTEMPTS.set(key, { ...IDLE });
  return ATTEMPTS.get(key);
}

const busy = a => a.phase === "opening" || a.phase === "waiting" || a.phase === "verifying";

function setPhase(key, phase, detail, extra = {}){
  const a = attempt(key);
  Object.assign(a, { phase, detail: detail || null }, extra);
  return a;
}

/* What the panel reads. Never carries a credential. */
function statusOf(source, env){
  const a = attempt(keyOf(source, env));
  return { phase: a.phase, detail: a.detail, error: a.error,
           since: a.since, browser: a.browser };
}

const allStatuses = () => ({
  "garage:prod": statusOf("garage", "prod"),
  "garage:eng" : statusOf("garage", "eng"),
  intrepid     : statusOf("intrepid"),
  mcp          : statusOf("mcp")
});

/* ── one capture attempt ── */

/* Read whatever the window holds for this source and, if it looks like a
   session, prove it. Returns true once the cookie is committed. */
async function tryCapture(source, env, key, label){
  const got = await connector.grabCookie(source, env);
  if(!got.ok) return false;

  // Cheap pre-filter, not evidence: see the header note about anonymous
  // Garage sessions. Re-probing an unchanged header would achieve nothing but
  // load.
  const a = attempt(key);
  if(got.cookie === a.lastProbed) return false;
  a.lastProbed = got.cookie;

  setPhase(key, "verifying", `Checking the ${label} session…`);
  const alive = await probes.probeFor(source, env)(got.cookie);

  if(alive === true){
    credstore.writeStore(source === "garage"
      ? { garage: { [env === "eng" ? "eng" : "prod"]: got.cookie } }
      : { intrepid: got.cookie });
    return true;
  }

  // null is a network failure, not a rejection — keep waiting, and let the
  // same header be tried again next time round.
  if(alive === null) a.lastProbed = null;
  return false;
}

/* ── the cookie sign-ins ── */

async function startCookieSignIn(source, env, label, log){
  const key = keyOf(source, env);
  const a   = attempt(key);
  if(busy(a)) return statusOf(source, env);      // join the attempt in flight

  const support = await connector.status();
  if(!support.supported){
    const why = "No Chrome or Edge found to open a sign-in window with";
    setPhase(key, "failed", why, { error: why, since: Date.now(), deadline: null });
    return statusOf(source, env);
  }

  Object.assign(a, { since: Date.now(), error: null, cancel: false,
                     lastProbed: null, browser: support.browser,
                     deadline: Date.now() + DEADLINE_MS });

  // Already signed in, from an earlier capture or another credential sharing
  // the profile? Then this is over before the click finishes.
  setPhase(key, "verifying", "Looking for an existing session…");
  if(support.windowUp && await tryCapture(source, env, key, label)){
    log(`${label} captured from a window that was already signed in`);
    setPhase(key, "connected", `Connected to ${label}.`, { deadline: null });
    return statusOf(source, env);
  }

  let opened;
  try{
    opened = connector.openUrl(targetUrl(source, env), support.windowUp);
  }catch(err){
    setPhase(key, "failed", err.message, { error: err.message, deadline: null });
    return statusOf(source, env);
  }

  setPhase(key, "waiting",
    opened.reused ? `Sign in to ${label} in the tab that just opened.`
                  : `${opened.browser} is opening — sign in to ${label} there.`,
    { browser: opened.browser || a.browser });

  // Detached on purpose: the POST that started this returns immediately and
  // the panel polls for the outcome.
  (async () => {
    /* Cancel is checked in the condition as well as the body: cancelling
       clears the deadline, and without this the loop would fall out of the
       bottom and overwrite "cancelled" with a timeout. */
    while(!a.cancel && Date.now() < a.deadline){
      await sleep(POLL_MS);
      if(a.cancel) return;
      try{
        if(await tryCapture(source, env, key, label)){
          log(`${label} signed in — cookie stored for every board`);
          setPhase(key, "connected", `Connected to ${label}.`, { deadline: null });
          return;
        }
      }catch{
        // Keep waiting. The window can be closed and reopened mid-attempt, and
        // a CDP hiccup should not end a sign-in someone is in the middle of —
        // the deadline is what ends it.
      }
      /* Settle the wording after the first tick. "Chrome is opening" is true
         for about a second and then quietly wrong for three minutes. */
      if(!a.cancel && attempt(key).phase !== "connected"){
        setPhase(key, "waiting", `Waiting for the ${label} sign-in to finish…`);
      }
    }
    if(a.cancel) return;
    setPhase(key, "failed",
      "Timed out waiting for the sign-in. Try again once you are signed in.",
      { error: "timeout", deadline: null });
  })();

  return statusOf(source, env);
}

const targetUrl = (source, env) => source === "garage"
  ? connector.TARGETS.garage[env === "eng" ? "eng" : "prod"].url
  : connector.TARGETS.intrepid.url;

/* ── MCP, which finishes somewhere else ──
   The OAuth callback lands on /callback rather than in a cookie jar, so there
   is nothing to poll a browser for. The phase still exists so the row behaves
   like the others: waiting until the callback says otherwise. */

async function startMcpSignIn(log){
  const key = "mcp";
  const a   = attempt(key);
  if(busy(a)) return statusOf("mcp");

  Object.assign(a, { since: Date.now(), error: null, cancel: false,
                     deadline: Date.now() + DEADLINE_MS });
  setPhase(key, "verifying", "Asking Garage where to sign in…");

  try{
    const url  = await mcpAuth.authorizeUrl();
    const out  = connector.openUrl(url, await connector.portIsLive());
    setPhase(key, "waiting", `${out.browser} is opening — sign in to Garage there.`,
             { browser: out.browser });
  }catch(err){
    setPhase(key, "failed", err.message, { error: err.message, deadline: null });
    return statusOf("mcp");
  }

  // No capture loop — /callback completes it. This only enforces the deadline,
  // so a sign-in that is abandoned stops claiming to be in progress.
  (async () => {
    while(!a.cancel && Date.now() < a.deadline){
      await sleep(POLL_MS);
      if(a.cancel || attempt(key).phase === "connected") return;
    }
    if(a.cancel || attempt(key).phase === "connected") return;
    setPhase(key, "failed", "Timed out waiting for the sign-in.",
             { error: "timeout", deadline: null });
  })();

  return statusOf("mcp");
}

/* Called by /callback once the exchange succeeds or fails. */
const mcpFinished = (ok, detail) => ok
  ? setPhase("mcp", "connected", detail || "Connected to Garage MCP.", { deadline: null })
  : setPhase("mcp", "failed", detail, { error: detail, deadline: null });

function cancel(source, env){
  const key = keyOf(source, env);
  const a   = attempt(key);
  if(busy(a)){
    a.cancel = true;
    setPhase(key, "cancelled", "Sign-in cancelled.", { deadline: null });
  }
  return statusOf(source, env);
}

/* Forgetting a credential has to clear any attempt still sitting on the row,
   or a stale "connected" would outlive the thing it described. */
function reset(source, env){
  ATTEMPTS.set(keyOf(source, env), { ...IDLE });
}

module.exports = { startCookieSignIn, startMcpSignIn, mcpFinished,
                   cancel, reset, statusOf, allStatuses, keyOf };

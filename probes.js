/* Is this session actually alive?

   The Hub asks that question in two places now, so the answer lives here
   rather than inside either caller. `signin.js` asks it during a capture — a
   cookie that exists is not a session that works, and Garage hands anonymous
   visitors a `_garage_session` too, so a captured header is proved before it
   is adopted. `health.js` asks it on a timer, long after the capture, because
   a session that worked this morning is not a session that works now.

   ── the three-way answer, which is the whole point ──

   Every probe returns one of three things, and collapsing them to a boolean
   would break both callers in the same way:

     true   the session is live
     false  the server looked at the credential and rejected it
     null   the request never got an answer — no verdict

   `null` is a network failure, a dropped VPN, a DNS hiccup. Reading it as
   "expired" would have the Hub throwing a sign-in window at somebody whose
   only problem is a train tunnel. Callers must treat it as "ask again later",
   never as a rejection.

   ── why these particular requests ──

   They are the cheapest thing that distinguishes signed-in from signed-out,
   and they are the only knowledge of any API in the Hub. That is a fair price
   for "connected" meaning connected — but it is a price, so it stays small:
   no vehicle is touched, no board's data is read, and nothing here grows a
   second endpoint without a reason.                                        */

"use strict";

const https = require("https");

const connector = require("./connect");

/* Resolved per call rather than held: a probe that outlived a config change
   would be checking a host nobody uses any more. */
const garageHost = env => connector.TARGETS.garage[env === "eng" ? "eng" : "prod"].host;

function get(url, cookie){
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { Cookie: cookie, Accept: "application/json",
                 "User-Agent": "Mozilla/5.0 (zo-hub)" },
      timeout: 15_000
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode,
                                    location: res.headers.location || "",
                                    body }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/* Garage's root is the cheapest signed-in test there is: it redirects either
   way, and the destination gives it away — /vehicles when the session is
   live, /users/sign_in when it is not. No body, no vehicle touched. */
const SIGN_IN_RE = /\/users\/sign_in/;

async function probeGarage(host, cookie){
  const res = await get(`https://${host}/`, cookie);
  if(!res) return null;                       // network, not a verdict
  if(res.status === 401 || res.status === 403) return false;
  return !SIGN_IN_RE.test(res.location);
}

/* Intrepid answers every bad-credential case with an identical 401
   "No token provided", so the status alone is the whole test. */
async function probeIntrepid(cookie){
  const res = await get("https://intrepidapi.tesla.com/cogs/api/cogs/getLogisticsHoldReasons", cookie);
  if(!res) return null;
  if(res.status === 401 || res.status === 403) return false;
  return res.status === 200;
}

/* The probe for one source, curried so callers hold a function rather than a
   switch. Garage needs its environment resolved to a host; Intrepid has one. */
const probeFor = (source, env) => source === "garage"
  ? cookie => probeGarage(garageHost(env), cookie)
  : probeIntrepid;

module.exports = { get, probeGarage, probeIntrepid, probeFor, SIGN_IN_RE };

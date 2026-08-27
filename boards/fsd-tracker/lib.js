/* FSD Tracker — shared core.

   Everything that talks to Intrepid or Garage lives here so the CLI and the
   dashboard cannot drift apart. Neither of them owns the measurement.

   Two modes, one measurement:

     basic     Garage alone. Tesladex enumerates the delivered population and
               vitals supply both the delivery centre and the mileage curve.
               No cookie, nothing to expire, works for any TRT.

     advanced  Everything basic does, plus Intrepid for the reference number
               and the delivery advisor — the two fields that exist nowhere in
               Garage. It ADDS COLUMNS AND NOTHING ELSE. The mileage is
               identical in both modes, so toggling can never move a number. */

"use strict";

const fs     = require("fs");
const path   = require("path");
const https  = require("https");
const crypto = require("crypto");

const credstore = require("./credstore");
/* Pure helpers only — validation, normalising and card building. Requiring it
   here starts nothing: alerts.js has no import-time side effects and holds no
   state, and the timer that actually posts lives in server.js. That split is
   what keeps a CLI run incapable of writing to a Teams channel. */
const A = require("./alerts");
/* Tesla OS — the order behind each car, and whether the customer wants FSD.
   Same rule as alerts.js: no import-time side effects, no timers, and it
   stores nothing. This file owns where the session is kept. */
const osx = require("./os");

const HERE = __dirname;

const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

const resolvePath = p => (path.isAbsolute(p) ? p : path.join(HERE, p));
const readJson    = f => JSON.parse(fs.readFileSync(f, "utf8"));

/* ──────────────────────────── connections ────────────────────────────
   What a fresh machine has to be told, in one gitignored file the admin panel
   writes. config.json holds only non-secret machine settings, so it stays
   committable; .connections.json holds the credential and never is.        */

const CONN_FILE = path.join(HERE, ".connections.json");

/* Three settings, because three things genuinely need storing:

   intrepidCookie  has to be pasted by hand and must survive a restart.
   mode            which source set a run uses. Stored rather than kept per
                   session so the CLI and the dashboard agree, and so a
                   machine set up for advanced work stays that way.
   trtId           the delivery centre. Chosen once and kept until changed.

   TRT used to live for the session only, on the theory that a dashboard left
   open on one centre should not quietly become the default for whoever opened
   it next. In practice this is one person's machine reading one centre, so
   that protected against nothing and cost a re-entry every single visit. It
   now persists; Admin › Maintenance › Reset clears it.

   Garage is deliberately absent — it is not a cookie and there is nothing to
   paste. Its OAuth tokens are written by the sign-in flow to .tokens.json and
   .client.json, both gitignored, both in this folder. */
/* null for droveThreshold means "no local choice" — the shipped default in
   config.json applies. Storing 0 here has to stay distinguishable from that,
   because 0 is a legitimate setting: it counts any movement at all. */
/* The hourly Teams digest settings are FLAT keys rather than a nested
   `alerts: {}` object, because saveConnections is a shallow merge: a nested
   object would be replaced wholesale by any patch that touched it, so saving
   the webhook would silently blank the day list. `alertDays` is an array and
   that is fine — it is a leaf value, always replaced deliberately.

   `alertsOn` defaults to FALSE. A setting that defaults on is one that starts
   posting into a shared channel the moment somebody pastes a URL to see
   whether the field works. See alerts.js for what each of these means. */
/* `os` is the Tesla OS session — an object, `{token, user, name, title,
   capturedAt}`, or null. It is board-local rather than a Hub credential for
   the reason written at the top of os.js: it expires every eighty minutes, and
   the Hub's health sweep would spend all day reconnecting it. */
const CONN_DEFAULTS = { intrepidCookie: "", garageCookie: "", mode: "basic", trtId: null,
                        droveThreshold: null,
                        alertsOn: false, alertWebhook: "",
                        alertStart: "09:00", alertEnd: "17:00",
                        alertDays: [1, 2, 3, 4, 5],
                        os: null };

/* Stored as a number or null, never a string, so callers can compare without
   worrying which layer they got it from. */
function savedTrtId(){
  const v = loadConnections().trtId;
  return /^\d+$/.test(String(v || "")) ? Number(v) : null;
}

const MODES = ["basic", "advanced"];
const normaliseMode = m => (MODES.includes(String(m)) ? String(m) : "basic");

/* Advanced needs a cookie to mean anything. Asking for one it has not got
   would fail mid-run, so the effective mode degrades here instead — the
   caller is told, and a basic report still lands. */
function effectiveMode(requested){
  const c = loadConnections();
  const want = normaliseMode(requested == null ? c.mode : requested);
  if(want !== "advanced") return { mode: "basic", degraded: false };
  // Hub first, same as the call itself: checking only the local field here
  // would degrade every advanced run to basic on a perfectly signed-in board.
  if(!credstore.intrepidCookie((c.intrepidCookie || "").trim()).value.trim()){
    return { mode: "basic", degraded: true,
             why: "Advanced mode needs an Intrepid session — sign in on the Zo Projects Hub. This ran basic." };
  }
  return { mode: "advanced", degraded: false };
}

function loadConnections(){
  let saved = {};
  if(fs.existsSync(CONN_FILE)){
    try { saved = readJson(CONN_FILE); } catch { saved = {}; }
  }

  return { ...CONN_DEFAULTS, ...saved };
}

function saveConnections(patch){
  const prev = loadConnections();
  const next = { ...prev, ...patch };
  // Drop anything a previous version wrote that is no longer a setting.
  delete next.garage;
  fs.writeFileSync(CONN_FILE, JSON.stringify(next, null, 2));

  // Only a credential change invalidates the MCP session. Picking a TRT or
  // flipping mode writes here too, and tearing down a live Garage session for
  // either would mean re-initialising on every nav click.
  if(next.intrepidCookie !== prev.intrepidCookie) SESSION = null;
  return next;
}

/* The admin password is shared across these dashboards and is a gate against
   fat fingers, not an attacker. Kept out of git all the same; a machine with
   no file falls back to the house default so a fresh clone still opens. */
function adminPassword(){
  const f = path.join(HERE, ".admin.json");
  if(fs.existsSync(f)){
    try { return String(readJson(f).password || "").trim() || CONFIG.defaultAdminPassword; }
    catch { /* fall through */ }
  }
  return CONFIG.defaultAdminPassword;
}

/* ─────────────────────────────── plumbing ─────────────────────────────── */

function request(url, { method = "GET", headers = {}, body = null } = {}){
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on("error", reject);
    if(body) req.write(body);
    req.end();
  });
}

/* Counting semaphore. A wide date range must not open hundreds of sockets. */
function pool(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  return Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while(i < items.length){
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch(err){ out[idx] = { error: err.message, _item: items[idx] }; }
    }
  })).then(() => out);
}

/* ──────────────────────────────── Intrepid ────────────────────────────────
   One HttpOnly cookie, `cogs-authorization`, is the whole credential. It is
   invisible to document.cookie on the SPA page because it is scoped to the
   API host; see README. Every bad-credential case answers with an identical
   401 "No token provided", so a health check keys on the status alone.     */

const INTREPID = CONFIG.intrepidApi.replace(/\/+$/, "");
/* Intrepid splits its API into sibling services under /api — the delivery
   endpoints live under /api/cogs, the site directory under /api/location. */
const INTREPID_LOCATION = INTREPID.replace(/\/cogs$/, "") + "/location";

function intrepidCookie(){
  // Hub first, own file second — see credstore.js.
  const raw = credstore.intrepidCookie((loadConnections().intrepidCookie || "").trim()).value.trim();
  if(!raw){
    const err = new Error("Not connected to Intrepid — sign in on the Zo Projects Hub");
    err.needsCookie = true;
    throw err;
  }
  // Tolerate a whole document.cookie paste: only cogs-authorization matters,
  // and pulling it out beats making someone edit the string by hand.
  const m = raw.match(/cogs-authorization=[^;]+/);
  return m ? m[0] : raw;
}

async function intrepidGet(pathAndQuery, base = INTREPID){
  const res = await request(base + pathAndQuery, {
    headers: { Cookie: intrepidCookie(), Accept: "application/json" }
  });
  if(res.status === 401){
    const err = new Error("Intrepid cookie expired or rejected — paste a fresh one");
    err.needsCookie = true;
    throw err;
  }
  if(res.status !== 200){
    throw new Error(`Intrepid HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  try { return JSON.parse(res.body); }
  catch { throw new Error("Intrepid did not return JSON — the cookie may be a sign-in redirect"); }
}

/* ─────────────────────────── the Tesla OS session ───────────────────────
   Board-local, in .connections.json, for the reasons at the top of os.js. The
   shape is `{token, user, name, title, capturedAt}` or null.

   Unlike the Intrepid cookie there is no Hub fallback to try: nothing else on
   the estate holds one of these. */

function osSaved(){
  const s = loadConnections().os;
  return s && s.token ? s : null;
}

function osToken(){
  const s = osSaved();
  if(!s){
    const err = new Error("Not connected to Tesla OS — connect it once under " +
                          "Admin › Alerts › Tesla OS session");
    err.needsOs = true;
    throw err;
  }
  return s.token;
}

const osConnected = () => Boolean(osSaved());

/* A token that exists is not a session that works — this one is opaque and
   dies after about eighty minutes, so the only way to know is to ask. Cached
   for a minute so painting the Admin panel does not fire a round trip per
   repaint. */
let osProbe = { at: 0, live: false };
const OS_PROBE_MS = 60_000;

async function osStatus(){
  const s = osSaved();
  if(!s) return { connected: false, user: null, name: null, title: null };
  if(Date.now() - osProbe.at < OS_PROBE_MS){
    return { connected: osProbe.live, user: s.user || null,
             name: s.name || null, title: s.title || null };
  }
  const who = await osx.authCheck(s.token).catch(() => null);
  osProbe = { at: Date.now(), live: Boolean(who && who.username) };
  return { connected: osProbe.live,
           user : (who && who.username) || s.user || null,
           name : (who && who.name)     || s.name || null,
           title: (who && who.title)    || s.title || null };
}

function osCommit(got){
  osProbe = { at: Date.now(), live: true };    // just proved by grabToken
  return saveConnections({
    os: { token: got.token, user: got.user, name: got.name || "",
          title: got.title || "", capturedAt: new Date().toISOString() }
  });
}

/* Clears the failure cooldown as well as starting the flow: someone pressing
   this has just fixed whatever was wrong and should not then be told to wait
   ten minutes by a guard meant for unattended runs. */
const osSignIn = () => { osHealFailedAt = 0; return osx.beginSignIn(osCommit); };

function osDisconnect(){
  osProbe = { at: 0, live: false };
  fsdIntentCache.clear();
  saveConnections({ os: null });
  return { ok: true };
}

/* ── a live token: connected by hand ONCE, renewed automatically forever ──

   This is the difference between the Tesla OS session and every other
   credential on the estate. The others last a working day and a person is
   there when they lapse. This one dies every eighty minutes and Chrome
   DELETES it, so the state a scheduled run finds it in is usually "gone
   entirely" — and the morning brief fires before anybody is at a desk.

   So renewal is automatic: a run whose stored session has lapsed opens a Tesla
   OS tab, lets Entra re-issue silently, takes the token and closes the tab
   again. Nobody has to be there.

   **The FIRST connect is deliberately not automatic.** A board that has never
   been connected has no business opening a browser window on its own — that is
   a surprise, on a machine that may not be set up for it, in service of an
   optional column. Worse, the first sign-in is the one that may genuinely need
   a person: Entra re-issues silently only once a profile has been through it.
   So cold start throws and asks, and only a session that once worked is
   repaired without asking. `force` is what the Connect button passes.

   Two guards keep the automatic half from being expensive:

   `osHealing` serialises it. Forty cars resolving at concurrency six would
   otherwise all notice the dead session at the same instant and open six tabs.

   `osHealFailedAt` stops a machine that simply cannot reach Tesla OS — no
   browser, no access, signed out of Entra — from spending forty-five seconds
   discovering that on every single run. After a failure it says so straight
   away for ten minutes. A person who has just fixed the cause can press
   Reconnect to clear it rather than waiting. */
let osHealing = null;
let osHealFailedAt = 0;
const OS_HEAL_COOLDOWN_MS = 10 * 60 * 1000;

async function osEnsureToken({ force = false } = {}){
  const s = osSaved();
  if(s && !force){
    const who = await osx.authCheck(s.token).catch(() => null);
    if(who && who.username){
      osProbe = { at: Date.now(), live: true };
      return s.token;
    }
  }

  /* Never connected, and not an explicit request to connect. Ask rather than
     opening a window nobody expects — see the note above. */
  if(!s && !force){
    const err = new Error("Not connected to Tesla OS — connect it once under " +
                          "Admin › Alerts › Tesla OS session. After that it renews itself.");
    err.needsOs = true;
    err.neverConnected = true;
    throw err;
  }

  if(osHealing) return osHealing;              // one repair at a time

  if(Date.now() - osHealFailedAt < OS_HEAL_COOLDOWN_MS){
    const err = new Error("Tesla OS could not be reached a few minutes ago, so this run " +
                          "did not wait for it again. Use Reconnect under Admin › Alerts to retry now.");
    err.needsOs = true;
    throw err;
  }

  osHealing = (async () => {
    const got = await osx.refreshToken();
    if(!got.ok){
      osProbe = { at: Date.now(), live: false };
      osHealFailedAt = Date.now();
      const err = new Error(
        got.reason === "no-browser"
          ? "No Chrome or Edge found, so a Tesla OS session could not be obtained."
          : "Could not obtain a Tesla OS session by itself. (" + (got.detail || got.reason) + ")");
      err.needsOs = true;
      throw err;
    }
    osHealFailedAt = 0;
    osCommit(got);
    return got.token;
  })();

  try { return await osHealing; }
  finally { osHealing = null; }
}

/* The cooldown is a guard against a machine that CANNOT reach Tesla OS
   spending forty-five seconds proving it on every run. The morning brief is
   the one run where that trade goes the other way: it happens once a day, it
   is the card that names customers, and a brief that skipped the renewal
   because something failed ten minutes ago would name people who were never
   asked. So the brief clears it and takes the forty-five seconds. */
const osClearHealCooldown = () => { osHealFailedAt = 0; };

/* Clears the cooldown and forces a fresh acquisition. The one thing a person
   can usefully do by hand here: they have just signed in somewhere, or fixed
   whatever was broken, and do not want to wait out the ten minutes. */
async function osReconnect(){
  osHealFailedAt = 0;
  const token = await osEnsureToken({ force: true });
  return { ok: true, token: Boolean(token), connection: connectionsSummary().os };
}

/* Every appointment at one TRT on one date. `date` is a plain query
   parameter: one cookie serves any number of dates with no re-auth. */
async function appointmentsOn(date, trtId){
  const trt = trtId;
  if(!trt){
    const err = new Error("No TRT set — choose Enter TRT in the top corner");
    err.needsTrt = true;
    throw err;
  }
  const rows = await intrepidGet(
    `/getTssAppointmentsByDate?trtId=${encodeURIComponent(trt)}&date=${encodeURIComponent(date)}&searchQuery=`);
  return Array.isArray(rows) ? rows : [];
}

/* ── TRT directory ──
   getLocations is the only endpoint that maps a TRT to a site, and it answers
   with every location Tesla has — about 1,850 records and 7.5 MB. Far too
   heavy to hit per lookup, so it is reduced to a trtId → name map and cached
   on disk. The raw payload is never kept.

   getTrtByTrtId exists in the bundle but 404s against this deployment, hence
   the whole-list approach rather than a targeted call.                     */

const TRT_CACHE = path.join(HERE, ".trt-cache.json");
const TRT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let trtMap = null;

/* "Tesla Service Houston-Cypress" is how the record reads; the prefix is
   noise once you are already inside a Tesla tool. */
const tidyName = s => String(s || "")
  .replace(/^Tesla\s+(Service|Center|Store|Delivery)\s+/i, "")
  .replace(/^Tesla\s+/i, "")
  .trim();

async function trtDirectory({ refresh = false } = {}){
  if(trtMap && !refresh) return trtMap;

  if(!refresh && fs.existsSync(TRT_CACHE)){
    try{
      const c = readJson(TRT_CACHE);
      if(c.fetchedAt && Date.now() - c.fetchedAt < TRT_TTL_MS && c.map){
        trtMap = c.map;
        return trtMap;
      }
    }catch{ /* fall through and refetch */ }
  }

  const rows = await intrepidGet("/getLocations", INTREPID_LOCATION);
  const map = {};
  for(const r of Array.isArray(rows) ? rows : []){
    if(r.trtid == null) continue;
    const addr = (r.additionalAttributes && r.additionalAttributes.trtAddress) || {};
    map[String(r.trtid)] = {
      name    : tidyName(r.description) || r.locationTerritoryName || String(r.trtid),
      full    : r.description || "",
      city    : addr.city || "",
      province: addr.province || "",
      tz      : r.ianaTimeZone || ""
    };
  }
  trtMap = map;
  try{ fs.writeFileSync(TRT_CACHE, JSON.stringify({ fetchedAt: Date.now(), map })); }catch{}
  return trtMap;
}

/* Type-ahead over the site directory. Nobody remembers TRT numbers, but
   everybody knows "Houston", so name is the primary key here and the number
   is what the lookup returns rather than what it demands.

   Ranked so the obvious answer is first: a name that starts with the query
   beats one that merely contains it, which beats a city match. */
async function searchSites(q, limit = 20){
  const query = String(q || "").trim().toLowerCase();
  if(!query) return [];

  const map = await trtDirectory();
  const out = [];

  for(const [id, s] of Object.entries(map)){
    const name = (s.name || "").toLowerCase();
    const city = (s.city || "").toLowerCase();
    const full = (s.full || "").toLowerCase();

    let rank;
    if(id === query)                 rank = 0;   // exact TRT number
    else if(name.startsWith(query))  rank = 1;
    else if(city.startsWith(query))  rank = 2;
    else if(name.includes(query))    rank = 3;
    else if(city.includes(query))    rank = 4;
    else if(full.includes(query))    rank = 5;
    else if(id.startsWith(query))    rank = 6;   // partial TRT number
    else continue;

    out.push({ rank, trtId: Number(id), name: s.name, city: s.city,
               province: s.province, full: s.full });
  }

  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return out.slice(0, limit).map(({ rank, ...rest }) => rest);
}

/* Never throws: an unresolvable TRT is a cosmetic miss, not a failure. The
   caller still has the number to fall back on. */
async function trtInfo(trtId){
  if(!trtId) return null;
  try{
    const map = await trtDirectory();
    const hit = map[String(trtId)];
    return hit ? { trtId: Number(trtId), ...hit } : null;
  }catch{
    return null;
  }
}

/* ── who ran the delivery ──
   `DriverADUserName` is the **delivery host** — the person who actually
   conducted the handover. It is not the same as the delivery advisor, who
   owns the appointment: across 70 delivered appointments the two differed on
   24 of them, so they cannot be used interchangeably.

   The catch is that the host arrives as a bare AD username with no display
   name beside it. The advisor fields, however, come in matched
   username/display pairs — so every payload fetched here also teaches us a
   little of the staff directory, free of charge. See resolveStaff below.

   Only staff fields are lifted. The same payload carries a Drivers block with
   customer name, email and phone; that is PII and is deliberately never
   returned from here. */
async function appointmentStaff(rn){
  if(!rn) return null;
  try{
    const d = await intrepidGet(`/getDeliveryAppointmentDetails?rn=${encodeURIComponent(rn)}`);
    const rec = (d.Data && d.Data[0]) || null;
    if(!rec) return null;
    return {
      hostUser: (rec.DriverADUserName || "").trim(),
      // Kept for the directory harvest, and because an advisor is still
      // worth knowing even though the host is what the report reports.
      advisorUser: (rec.DeliveryAdvisorUserName || "").trim(),
      advisorName: (rec.DeliveryAdvisorDisplayName || "").trim(),
      salesUser  : (rec.SalesAdvisorUserName || "").trim(),
      salesName  : (rec.SalesAdvisorDisplayName || "").trim()
    };
  }catch(err){
    if(err.needsCookie) throw err;
    return null;
  }
}

/* ── AD username → display name ──
   Two tiers, cheapest first:

   1. Pairs harvested from the advisor fields of appointments already being
      fetched. Across one day at one centre this yielded 59 names for no extra
      requests, and covered 10 of 13 hosts.
   2. Garage `lookup_user` on <username>@tesla.com for whoever is left —
      typically people who host deliveries but never appear as an advisor.

   Guessing from the username is not a third tier and must not become one:
   `johanberry` is Joshua **Hanberry**, which any split would render as
   "Joh Anberry".

   Only given_name and family_name are taken from the lookup. It returns far
   more — vault UUID, device counts, an email hash — and none of that belongs
   in a mileage report. */

const STAFF_CACHE = path.join(HERE, ".staff-cache.json");
let staffMap = null;
let staffDirty = false;

function staffCache(){
  if(staffMap) return staffMap;
  staffMap = {};
  if(fs.existsSync(STAFF_CACHE)){
    try { staffMap = readJson(STAFF_CACHE) || {}; } catch { staffMap = {}; }
  }
  return staffMap;
}

function staffFlush(){
  if(!staffDirty) return;
  try { fs.writeFileSync(STAFF_CACHE, JSON.stringify(staffMap, null, 1)); staffDirty = false; }
  catch { /* a cache that will not write costs lookups, not correctness */ }
}

function learnStaff(user, display){
  if(!user || !display) return;
  const k = user.toLowerCase();
  const c = staffCache();
  if(c[k] === display) return;
  c[k] = display;
  staffDirty = true;
}

/* Resolves what it can from cache, then asks Garage once per unknown. Never
   throws: an unresolved host falls back to its username, which is still a
   usable grouping key. */
async function resolveStaff(users){
  const cache = staffCache();
  const unknown = [...new Set(users.filter(Boolean).map(u => u.toLowerCase()))]
    .filter(u => !cache[u]);

  if(unknown.length){
    await ensureSession();
    await pool(unknown, Math.min(4, unknown.length), async user => {
      try{
        const r = await callTool("lookup_user", {
          id: `${user}@tesla.com`, search_type: "email"
        });
        const u = r && r.user;
        const name = u ? [u.given_name, u.family_name].filter(Boolean).join(" ").trim() : "";
        if(name) learnStaff(user, name);
        else { cache[user] = ""; staffDirty = true; }   // remembered as a miss
      }catch{
        // Leave it unresolved rather than caching a failure that may be
        // transient; the username still names the person well enough to group by.
      }
    });
    staffFlush();
  }

  return cache;
}

const staffName = (cache, user) =>
  (user && cache[user.toLowerCase()]) || user || "";

/* ── who the car went to ──
   The appointment row carries `userId`, which is the customer's
   my_tesla_unique_id — the same key Garage's lookup_user accepts. That is the
   bridge: Intrepid names the account, Garage names the person.

   Worth recording where this is NOT: the appointment detail's `Drivers` block
   looks like it should hold the customer and does not. Across every record
   sampled it held internal staff — IsExternal false, no email, AdUsername
   matching the delivery host — and `DriverName` was null throughout. An
   earlier note in this project claimed otherwise; it was wrong.

   Only given_name and family_name are taken. lookup_user also returns the
   customer's email, a vault UUID, device counts and an email hash, none of
   which belongs in a mileage report.

   Cached in memory for the life of the process and deliberately NOT to disk,
   unlike the staff directory: staff names are a small fixed roster this tool
   legitimately keeps, customer names are a different thing to leave lying in
   a file. A run needs one lookup per car regardless, so a disk cache would
   buy almost nothing anyway. */
const customerCache = new Map();

async function resolveCustomers(userIds){
  const want = [...new Set(userIds.filter(Boolean).map(String))]
    .filter(id => !customerCache.has(id));

  if(want.length){
    await ensureSession();
    await pool(want, Math.min(6, want.length), async id => {
      try{
        const r = await callTool("lookup_user", { id, search_type: "my_tesla_unique_id" });
        const u = r && r.user;
        customerCache.set(id,
          u ? [u.given_name, u.family_name].filter(Boolean).join(" ").trim() : "");
      }catch{
        customerCache.set(id, "");     // a name we cannot get is not an error
      }
    });
  }

  return customerCache;
}

/* ────────────────────── does this customer want FSD? ────────────────────
   Keyed by reference number, because that is what the order service knows —
   which is also why this is advanced-only: an RN comes from Intrepid, and a
   basic run has none.

   Returns a Map of rn → { state, text }, where state is "intent" | "has" |
   "none" | null. See fsdIntentOf in os.js for what those mean; the important
   one is that **null is not "none"**. A question we could not ask must never
   render as a customer who wants nothing.

   Cached in memory for the life of the process, like the customer names above
   and for the same reason — this is order data about a named person, not a
   fixed roster, and it does not belong in a file on disk. The cache is
   cleared whenever the session changes.

   A run that cannot reach Tesla OS at all throws `needsOs` from the first
   call; the caller catches that once, notes it, and leaves every row unknown
   rather than making forty more calls that will fail the same way. */
const fsdIntentCache = new Map();

async function resolveFsdIntent(rns){
  const want = [...new Set(rns.filter(Boolean).map(String))];
  if(!want.filter(rn => !fsdIntentCache.has(rn)).length) return fsdIntentCache;

  /* Two passes at most. The token can lapse in the middle of a run — forty
     cars at eighty minutes a token is not a rare alignment — and the second
     pass exists to renew it and finish the job rather than leave half the
     centre unreadable.

     A dead session must NOT be recorded per car. Marking each failure unknown
     as it happened would be the same bug in slow motion: the run would finish,
     every remaining row would read as "no intent stated", and the brief would
     name customers who were never asked. So the pass sets a flag, discards
     nothing, and goes round again. */
  for(let attempt = 0; attempt < 2; attempt++){
    const todo = want.filter(rn => !fsdIntentCache.has(rn));
    if(!todo.length) break;

    const token = await osEnsureToken({ force: attempt > 0 });
    let sessionDied = false;

    await pool(todo, Math.min(6, todo.length), async rn => {
      if(sessionDied) return;                 // stop spending calls on a dead token
      try{
        const d = await osx.overviewFor(token, rn);
        // null is a 404/451 — an order this account cannot resolve. Unknown,
        // NOT "no intent".
        if(d === null) return fsdIntentCache.set(rn, { state: null, text: "" });
        const order = (d && d.order) || {};
        fsdIntentCache.set(rn, osx.fsdIntentOf(order.fsdLabel));
      }catch(err){
        /* pool() turns a throw into a result rather than propagating it, so a
           dead session cannot be signalled by throwing from in here. Flag it. */
        if(err.needsOs){ sessionDied = true; return; }
        fsdIntentCache.set(rn, { state: null, text: "" });
      }
    });

    if(!sessionDied) break;
    if(attempt === 1){
      const err = new Error("The Tesla OS session kept being refused, so FSD intent is missing from this run.");
      err.needsOs = true;
      throw err;
    }
  }

  return fsdIntentCache;
}

/* ───────────────────────────────── Garage ─────────────────────────────────
   JSON-RPC over the MCP streamable-HTTP transport, same dialect as the
   Charging Tracker's server.js.                                            */

const PROTO = CONFIG.mcpProtocolVersion;

const garageUrl = () => CONFIG.garageUrl.replace(/\/+$/, "");
const mcpUrl    = () => garageUrl() + "/mcp";

let SESSION = null;
let TOKEN   = null;
const notices = [];

const takeNotices = () => notices.splice(0, notices.length);

/* ── Garage sign-in, owned by the Hub ──
   This project used to hold its own OAuth client and tokens in this folder,
   after an earlier arrangement where it borrowed the Charging Tracker's and
   the two stranded each other on every refresh.

   Neither applies now. The Hub mints the MCP token and writes it to the shared
   store; this board reads it and is the only thing that ever refreshes it, so
   there is still exactly one writer of rotations. garage-oauth.js carries the
   full argument and the rule that keeps it safe.

   What is left here is the consumer's half: ask for an access token, and let
   the module deal with whether that means reading one or refreshing one. */

const mcpAuth = require("./garage-oauth");
const accessToken = () => mcpAuth.accessToken();

const readJsonSafe = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

/* One-time tidy-up. The old client was registered against this board's own
   redirect URI, which nothing serves any more, so those files cannot work —
   and left in place they would look like a signed-in state to anyone reading
   the folder. */
(function dropLegacyTokens(){
  const stale = [".tokens.json", ".client.json"]
    .map(resolvePath)
    .filter(f => { try { return fs.existsSync(f); } catch { return false; } });
  if(!stale.length) return;
  for(const f of stale){ try { fs.unlinkSync(f); } catch {} }
  console.log("Removed this board's old Garage OAuth files — the Hub owns that sign-in now.");
})();

function parseMcpBody(res){
  if(String(res.headers["content-type"] || "").includes("text/event-stream")){
    let last = null;
    for(const line of res.body.split(/\r?\n/)){
      if(!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if(p && p !== "[DONE]") last = p;
    }
    if(!last) throw new Error("SSE stream contained no data frame");
    return JSON.parse(last);
  }
  return JSON.parse(res.body);
}

/* `handshake` is set only by the two calls that establish the session, which
   would otherwise recurse into mcpSession() forever trying to establish it. */
async function rpc(method, params, notification = false, handshake = false){
  if(!handshake) await mcpSession();
  const headers = {
    "Content-Type"        : "application/json",
    Accept                : "application/json, text/event-stream",
    Authorization         : "Bearer " + TOKEN,
    "MCP-Protocol-Version": PROTO
  };
  if(SESSION) headers["Mcp-Session-Id"] = SESSION;

  const payload = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: Math.random().toString(36).slice(2), method, params };

  const res = await request(mcpUrl(), { method: "POST", headers, body: JSON.stringify(payload) });

  if(res.status === 401){
    const err = new Error("Garage rejected the access token — sign in to Garage · MCP on the Zo Projects Hub");
    err.needsAuth = true;
    throw err;
  }
  if(res.status >= 400) throw new Error(`Garage MCP HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  if(res.headers["mcp-session-id"]) SESSION = res.headers["mcp-session-id"];
  if(notification || res.status === 202 || !res.body.trim()) return null;

  const parsed = parseMcpBody(res);
  if(parsed.error) throw new Error(`Garage MCP ${parsed.error.code}: ${parsed.error.message}`);
  return parsed.result;
}

/* Idempotent: the dashboard calls this on every request and pays for it once. */
/* Establishing the MCP session is now only needed for `lookup_user`, so it
   happens lazily inside rpc() rather than being demanded up front.

   This matters more than it looks. A report needs Tesladex and vitals, both
   of which are cookie calls; making the whole run wait on an OAuth token
   would mean a signed-out Garage client blocked work that never needed it.
   Names are the only thing at stake, and a missing name already degrades to
   the username. */
async function mcpSession(){
  const fresh = await accessToken();
  /* A different token is a different identity, and an MCP session is bound to
     the one that opened it. The refresh happens inside the shared module now,
     so noticing the swap here is what replaces the SESSION reset that used to
     live in storeTokens. */
  if(fresh !== TOKEN) SESSION = null;
  TOKEN = fresh;
  if(SESSION) return;
  await rpc("initialize", {
    protocolVersion: PROTO,
    capabilities   : {},
    clientInfo     : { name: "fsd-tracker", version: "1.0.0" }
  }, false, true);
  await rpc("notifications/initialized", {}, true, true);
}

/* Kept as the name every caller already uses, but it now asserts the cookie —
   the credential the run actually depends on — rather than an access token. */
async function ensureSession(){
  garageCookie();
  return true;
}

/* ── Garage over its own session cookie ──

   Two of the three tools this tracker uses have a plain REST equivalent
   behind Garage's web session, verified against MCP on identical queries —
   same totals, same rows, same fields. Those two now go by cookie: no token
   to refresh, no handshake, and nothing shared with any other board.

   `lookup_user` has no such equivalent. Garage's UI exposes no find-a-person
   route, and six candidate shapes under /api/1/users all 404. So MCP stays,
   used for exactly that one call. It resolves an AD username or a customer id
   into a display name, both of which already degrade to something readable,
   which is why the rest of the tracker no longer waits on OAuth to work. */

const GARAGE_COOKIE_RE = /[A-Za-z0-9_]*_?s_garage_session=[^;]+/;

function garageCookie(){
  const raw = credstore.garageCookie("prod",
    (loadConnections().garageCookie || "").trim()).value.trim();
  if(!raw){
    const err = new Error("Not signed in to Garage — sign in on the Zo Projects Hub");
    err.needsAuth = true;
    throw err;
  }
  const m = raw.match(GARAGE_COOKIE_RE);
  return m ? m[0] : raw;
}

async function garageGet(pathAndQuery){
  const res = await request(garageUrl() + pathAndQuery, {
    headers: { Cookie: garageCookie(), Accept: "application/json",
               "User-Agent": "Mozilla/5.0 (fsd-tracker)" }
  });

  /* A stale Garage session does not 401 — it redirects to SSO, or answers 200
     with the sign-in page. Both have to read as "sign in again" rather than
     as a parse failure, or the panel points at the wrong fix. */
  if(res.status === 401 || res.status === 403 ||
     (res.status >= 300 && res.status < 400)){
    const err = new Error("Garage session expired or rejected — sign in on the Hub");
    err.needsAuth = true;
    throw err;
  }
  if(res.status !== 200) throw new Error(`Garage HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  try { return JSON.parse(res.body); }
  catch{
    const err = new Error("Garage returned a sign-in page rather than data — sign in on the Hub");
    err.needsAuth = true;
    throw err;
  }
}

/* VIN → numeric device id, which is how the REST vitals route is addressed.
   The MCP tool used to accept either and resolve it server-side; this keeps
   that convenience at the cost of one cached lookup per car. */
const idCache = new Map();
async function deviceIdFor(vin){
  if(idCache.has(vin)) return idCache.get(vin);
  const d = await garageGet("/api/1/tesladex/search?type=vehicle&size=1" +
    "&query=" + encodeURIComponent("vin:" + vin) + "&fields[]=vin&fields[]=id");
  const row = ((d && d.response) || [])[0];
  if(!row || row.id == null) throw new Error(`No numeric id in Tesladex for ${vin}`);
  idCache.set(vin, String(row.id));
  return String(row.id);
}

/* One door for all three, so the nine call sites above never had to change
   and none of them has to know which transport it is on. */
async function callTool(name, args){
  if(name === "tesladex_search"){
    const qs = [
      "type=" + encodeURIComponent(args.type || "vehicle"),
      "query=" + encodeURIComponent(args.query),
      "size=" + Number(args.size || 100),
      "from=" + Number(args.from || 0),
      "sort=" + encodeURIComponent(args.sort || "vin:asc"),
      ...(args.fields || ["vin"]).map(f => "fields[]=" + encodeURIComponent(f))
    ].join("&");
    const d = await garageGet("/api/1/tesladex/search?" + qs);
    const rows = Array.isArray(d && d.response) ? d.response : [];
    const total = typeof (d && d.total) === "number" ? d.total : rows.length;
    return { results: rows, total, has_more: Number(args.from || 0) + rows.length < total };
  }

  if(name === "device_historical_vitals"){
    const id = /^\d+$/.test(String(args.device_id))
      ? String(args.device_id) : await deviceIdFor(args.device_id);
    const qs = [
      "hours=" + Number(args.hours || 24),
      "asc=" + (args.asc ? "true" : "false"),
      ...(args.fields || []).map(f => "fields[]=" + encodeURIComponent(f))
    ].join("&");
    const d = await garageGet(
      `/api/1/vehicles/${encodeURIComponent(id)}/vitals_snapshots/datatank_historical_vitals?${qs}`);
    return { rows: Array.isArray(d && d.response) ? d.response : [] };
  }

  // Everything else — in practice only lookup_user — still goes over MCP.
  const r = await rpc("tools/call", { name, arguments: args });
  if(r && r.isError){
    throw new Error((r.content || []).map(c => c.text).filter(Boolean).join(" ") || "tool error");
  }
  if(r && r.structuredContent) return r.structuredContent;
  const text = (r?.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  if(!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/* ─────────────────────────── tesladex enumeration ───────────────────────────
   Which cars this centre handed over on a given day. Until August 2026 this
   was impossible — tesladex 403'd on delivered vehicles and Intrepid was the
   only enumerator. That restriction is gone, and with it the cookie.

   Two fields do the whole job:

   `delivery_date_epoch` — but note delivery_date is UTC. A 7pm Houston pickup
   is 00:xx UTC the NEXT day, so a `delivery_date:2026-08-01*` prefix quietly
   drops the back half of an evening. The query is an epoch range spanning the
   LOCAL day, built from this machine's clock; the dashboard runs at the
   centre, and todayLocal() already assumes exactly that.

   `vehicle_routing_location` — the VRL, and the reason this is now one query
   instead of a national scan. It survives delivery, where the whole
   delivery_details block does not, and it is indexed, so the centre filter
   runs server-side.

   This replaced reading trt_id back out of each car's telemetry history.
   Measured against that method across all 2,960 cars delivered nationally on
   2026-08-01: they agree on 2,693, and for TRT 17589 specifically the two
   sets are identical — nothing added, nothing missed. Of the 68 that differ,
   VRL is the better value: the telemetry side is holding logistics codes the
   car had not shed by handoff (15047, 415904) where VRL names an actual
   centre. VRL was also populated on every single one of the 2,960, while
   telemetry had no trt_id at all for 37 of them.

   The old method survives only as the fallback below, for a car with no VRL. */

/* Local midnight to local midnight, as UTC seconds. */
function dayRangeEpoch(dateStr){
  const [y, m, d] = dateStr.split("-").map(Number);
  return [
    Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000),
    Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000)
  ];
}

const TESLADEX_PAGE = 100;      // the endpoint's maximum

/* ── a delivery date is not proof of a delivery ──

   VRL enumeration keys on `delivery_date_epoch`, and that field gets stamped
   on cars that have not been handed to anybody: a Monday appointment moved,
   a car pulled into repair, an order edited. The tell is `delivery_details`.
   It is WIPED at handover — that is the property VRL enumeration was chosen
   for in the first place — so a car still carrying one, with a scheduled date
   in the future, has demonstrably not gone out yet.

   Checked against a week at TRT 17589: all 337 delivered cars had it null,
   and the one exception was scheduled six days out and sitting in repair.

   Read off Garage alone, deliberately. "It has no Intrepid appointment" would
   have been the easier test and is wrong twice over — it is unavailable in
   basic mode, where it would empty the entire report, and in advanced mode it
   would also throw away genuine deliveries that Intrepid simply has no record
   of, which the join below goes out of its way to keep. */
const scheduledFor = r => {
  const d = r && r.delivery_details;
  if(!d) return null;
  const when = String(d.scheduled_delivery_date || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : null;
};

const toDelivery = (r, date) => ({
  vin        : r.vin,
  model      : r.model || "",
  deliveredAt: new Date(r.delivery_date_epoch * 1000).toISOString(),
  date,
  scheduledFor: scheduledFor(r)
});

/* Pages a query to exhaustion. Sorted, or deep paging repeats and skips. */
async function tesladexPage(query, fields, onPage){
  const out = [];
  for(let offset = 0; ; offset += TESLADEX_PAGE){
    const page = await callTool("tesladex_search", {
      query, fields, size: TESLADEX_PAGE, from: offset,
      sort: "delivery_date_epoch:asc"
    });
    const rows = (page && page.results) || [];
    out.push(...rows);
    if(onPage) onPage({ got: out.length, total: page ? page.total : out.length });
    if(!rows.length || !page || !page.has_more) break;
    // Elasticsearch will not page past 10k however politely you ask.
    if(offset + TESLADEX_PAGE >= 10000) break;
  }
  return out;
}

const FIELDS = ["vin", "delivery_date_epoch", "model", "delivery_details"];

/* The centre's deliveries, straight from the index. */
async function tesladexDeliveries(date, trtId, onPage){
  const [from, to] = dayRangeEpoch(date);
  const rows = await tesladexPage(
    `delivery_date_epoch:[${from} TO ${to}] AND vehicle_routing_location:${Number(trtId)}`,
    FIELDS,
    p => onPage && onPage({ date, ...p }));
  return rows.filter(r => r.vin && r.delivery_date_epoch != null)
             .map(r => toDelivery(r, date));
}

/* ── one car, by VIN ──
   The date and the centre come off the record rather than from the caller: a
   VIN search is asked about a specific car, and requiring the operator to
   already know which day it went out and from where would defeat the point.
   That also lets it answer for a car from any centre, not just the one the
   dashboard is currently pointed at.

   `delivery_date_epoch` is the handoff instant, and the day it belongs to is
   the LOCAL one — the index stores UTC, so deriving the date any other way
   puts an evening pickup on tomorrow's report. */
const localDate = ms => {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ── reference number → VIN ──
   There is no lookup that answers this directly. Tesladex does not index the
   reference number at all, and Intrepid's getDeliveryAppointmentDetails —
   which takes an RN — answers with the staff on the appointment and never the
   car. What does carry both numbers side by side is the appointment list, so
   the RN is found by reading a centre's own appointments and matching on it.

   Scanning sounds expensive and is not. It only has to cover the vitals
   ceiling, because a car delivered before that cannot be measured whether we
   find it or not, and those calls run concurrently: fifteen days came back in
   about a second against a real centre.

   The cost is scope. A VIN is looked up nationally; an RN is looked up at one
   centre, because the appointment only exists at the centre that booked it
   and there is no national list to ask. That is a property of the data rather
   than a shortcut here, and the miss below says so plainly instead of letting
   it read as "no such order". */
async function vinForRn(rn, trtId){
  if(!trtId){
    const err = new Error(
      `${rn} can only be looked up in one centre's appointments, so a centre has to ` +
      `be set first — choose Enter TRT in the top corner. A VIN needs no centre.`);
    err.needsTrt = true;
    throw err;
  }

  const days = [];
  for(let i = 0; i <= VITALS_CEILING_DAYS; i++){
    days.push(localDate(Date.now() - i * 86400000));
  }

  /* Failures are carried rather than thrown so one unreadable day cannot turn
     a findable RN into a miss — and so a clean miss can be told apart from a
     scan that never actually saw every day. */
  const results = await pool(days, Math.min(8, days.length), async date => {
    try{
      const rows = await appointmentsOn(date, trtId);
      const hit = rows.find(r =>
        String(r.referenceNumber || "").trim().toUpperCase() === rn);
      return hit ? { hit, date } : null;
    }catch(err){
      return { failed: err };
    }
  });

  // days runs newest-first, so the first hit is the most recent appointment —
  // which is the right one when an RN was rescheduled and appears twice.
  const found = results.find(r => r && r.hit);
  if(found){
    const vin = String(found.hit.vin || "").trim().toUpperCase();
    if(!isVin(vin)){
      throw new Error(
        `${rn} has an appointment at TRT ${trtId} on ${found.date}, but no VIN is ` +
        `attached to it yet — no car has been matched to the order, so there is ` +
        `nothing to measure.`);
    }
    return { vin, date: found.date, status: found.hit.status || "" };
  }

  const fails = results.filter(r => r && r.failed);
  if(fails.length){
    // A dead cookie fails every day at once; let it surface as the sign-in
    // prompt it is rather than as a report that the RN does not exist.
    const err = fails[0].failed;
    if(err.needsCookie || err.needsAuth || err.needsTrt) throw err;
    throw new Error(
      `${rn} was not found, but ${fails.length} of the ${days.length} days searched ` +
      `could not be read (${err.message}), so this is not a conclusive miss.`);
  }

  throw new Error(
    `No appointment at TRT ${trtId} in the last ${VITALS_CEILING_DAYS} days carries ` +
    `${rn}. Reference numbers are searched one centre at a time — if the car was ` +
    `handed over somewhere else, search its VIN instead, which is not tied to a centre.`);
}

async function deliveryForVin(vin){
  const page = await callTool("tesladex_search", {
    query : `vin:${vin}`,
    fields: [...FIELDS, "vehicle_routing_location"],
    size  : 1
  });
  const r = (page && page.results && page.results[0]) || null;
  if(!r) return { error: `No vehicle in Tesladex with VIN ${vin}.` };
  if(r.delivery_date_epoch == null){
    return { error: `${vin} has no delivery date — it has not been handed over, ` +
                    `so there is no post-delivery mileage to measure.` };
  }

  const ms = r.delivery_date_epoch * 1000;
  return { car: { ...toDelivery(r, localDate(ms)),
                  trt: r.vehicle_routing_location ?? null } };
}

/* How many were delivered nationally that day. One cheap call purely for
   context in the report header — it is no longer something we page through. */
async function nationalCount(date){
  const [from, to] = dayRangeEpoch(date);
  try{
    const p = await callTool("tesladex_search", {
      query: `delivery_date_epoch:[${from} TO ${to}]`, fields: ["vin"], size: 1
    });
    return (p && typeof p.total === "number") ? p.total : 0;
  }catch{ return 0; }
}

/* ── fallback: cars the index cannot place ──
   VRL was present on all 2,960 deliveries checked, so this is expected to
   find nothing and cost one query. It exists because the failure it guards
   against is silent: a car with no VRL would simply never appear, and an
   undercount looks exactly like a quiet day.

   Only these get the old per-car telemetry probe, so the expensive path is
   bounded by however many cars the index could not place — normally zero. */
async function unroutedDeliveries(date, trtId, onProgress){
  const [from, to] = dayRangeEpoch(date);
  const rows = await tesladexPage(
    `delivery_date_epoch:[${from} TO ${to}] AND NOT vehicle_routing_location:*`,
    FIELDS);
  if(!rows.length) return [];

  const cands = rows.filter(r => r.vin && r.delivery_date_epoch != null)
                    .map(r => toDelivery(r, date));
  let done = 0;
  const marks = await pool(cands, CONFIG.scopeConcurrency || CONFIG.concurrency, async d => {
    const hit = await trtAtDelivery(d.vin, d.deliveredAt);
    done++;
    if(onProgress) onProgress({ phase: "scope", date, done, total: cands.length });
    return hit;
  });
  vinTrtFlush();

  return cands.filter((d, i) => String(marks[i]) === String(trtId));
}

/* ────────────────────── which centre handed the car over ──────────────────────
   `trt_id` is a live vitals field, not a delivery record. On a delivered car
   tesladex reports it as null, which is what made this look impossible — but
   the vitals HISTORY still holds the value the car carried before handoff.

   Three behaviours the data forced, each of which breaks the obvious version:

   · trt_id changes as a car moves through logistics — one sample walked
     15047 → 487417 → 17589 inside two weeks. Only the value AT HANDOFF names
     the delivering centre.
   · it also drifts AFTER delivery, so "most recent value" is wrong too: one
     car sat at 15952 through its handoff and moved to 9059 five hours later.
   · it stops being reported shortly BEFORE the delivered flag flips, so the
     samples either side of the handoff instant are routinely empty. Reading
     backwards from the delivery moment is required, not defensive coding.

   Hence: the last non-null trt_id at or before the delivery timestamp.

   Do not be tempted by the vitals `delivered` flag. It lags the real handoff
   by five to seven hours, and on used inventory it reads "yes" for the whole
   window because the car was delivered once already.                        */

const VIN_TRT_CACHE = path.join(HERE, ".vin-trt-cache.json");

/* A car's delivering centre is a fact about a past event, so it can be cached
   forever. Worth doing: this is one Garage call per vehicle per day, and a
   national day is thousands of them. Re-running a date should be cheap. */
let vinTrt = null;

function vinTrtCache(){
  if(vinTrt) return vinTrt;
  vinTrt = {};
  if(fs.existsSync(VIN_TRT_CACHE)){
    try { vinTrt = readJson(VIN_TRT_CACHE) || {}; } catch { vinTrt = {}; }
  }
  return vinTrt;
}

let vinTrtDirty = false;
function vinTrtFlush(){
  if(!vinTrtDirty) return;
  try { fs.writeFileSync(VIN_TRT_CACHE, JSON.stringify(vinTrt)); vinTrtDirty = false; }
  catch { /* a cache that will not write is a slow run, not a broken one */ }
}

/* Vitals look back from the most recent sample, so the window has to be wide
   enough to still contain the handoff. Padded for cars that went quiet after
   delivery, and clamped to the endpoint's 336-hour ceiling. */
function lookbackToCover(iso, padHours = 12){
  const h = Math.ceil((Date.now() - Date.parse(iso)) / 3600000) + padHours;
  return Math.max(2, Math.min(336, h));
}

async function trtAtDelivery(vin, deliveredAtIso){
  const key = vin + "@" + deliveredAtIso.slice(0, 10);
  const cache = vinTrtCache();
  if(Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  const hours = lookbackToCover(deliveredAtIso);
  let trt = null;

  try{
    const data = await callTool("device_historical_vitals", {
      device_id: vin,
      fields   : ["trt_id"],
      hours,
      asc      : true
    });

    const cutoff = Date.parse(deliveredAtIso);
    let bestT = -Infinity;

    for(const r of (data && data.rows) || []){
      if(r.trt_id == null) continue;
      const t = Date.parse(r.time + "Z");        // vitals timestamps are UTC
      if(!Number.isFinite(t) || t > cutoff) continue;
      if(t >= bestT){ bestT = t; trt = Number(r.trt_id); }
    }
  }catch(err){
    // A single unreadable car must not sink a run of thousands. Left
    // uncached so a later run can still resolve it.
    if(err.needsAuth) throw err;
    return null;
  }

  cache[key] = trt;
  vinTrtDirty = true;
  return trt;
}

/* Beyond the vitals ceiling the mileage reading at handoff has aged out, so
   the delta cannot be computed — what would come back is the car's whole
   visible curve, silently mislabelled as post-delivery driving. Better to
   refuse than to answer wrongly.

   Note this is a limit on the MEASUREMENT, not on finding the cars. Routing
   location would happily enumerate a date from last year. */
const VITALS_CEILING_DAYS = 14;

function beyondVitalsWindow(date){
  const [, end] = dayRangeEpoch(date);
  return (Date.now() / 1000 - end) / 86400 > VITALS_CEILING_DAYS;
}

/* ──────────────────────────── the actual measure ────────────────────────── */

/* ── the measurement window ──
   Miles are counted for a fixed stretch after handoff and then the row is
   done. Without a cutoff the figure is "miles since delivery, as of whenever
   you happened to press the button", which makes two runs of the same day
   disagree and makes yesterday's cars incomparable with last Tuesday's — the
   older ones have simply had longer to accumulate.

   Twelve hours is the span of the drive home and the first evening out, which
   is the part of the trip attributable to how the handover went. What the
   customer does with the car on day three is a different question.

   Once the window has closed the answer can never change, so it is written to
   disk and that car is never asked about again — a re-run of a settled date
   costs no Garage call at all. See measureCache. */
const WINDOW_HOURS = 12;

function windowHours(){
  const n = Number(CONFIG.windowHours);
  return Number.isFinite(n) && n > 0 ? n : WINDOW_HOURS;
}

/* Keyed on VIN and the handoff instant, so re-delivered inventory measured
   twice does not collide. The window length is stored alongside: change
   `windowHours` in config and every entry measured under the old one is
   ignored rather than silently reported against the new figure. */
const MEASURE_CACHE = path.join(HERE, ".measure-cache.json");
let measures = null;
let measuresDirty = false;

function measureCache(){
  if(measures) return measures;
  measures = {};
  if(fs.existsSync(MEASURE_CACHE)){
    try { measures = readJson(MEASURE_CACHE) || {}; } catch { measures = {}; }
  }
  return measures;
}

function measureFlush(){
  if(!measuresDirty) return;
  try { fs.writeFileSync(MEASURE_CACHE, JSON.stringify(measures)); measuresDirty = false; }
  catch { /* a cache that will not write is a slow run, not a wrong one */ }
}

function clearMeasureCache(){
  const n = Object.keys(measureCache()).length;
  measures = {};
  measuresDirty = false;
  try{ if(fs.existsSync(MEASURE_CACHE)) fs.unlinkSync(MEASURE_CACHE); }catch{}
  return { cleared: n };
}

/* ── two counters, one number ──
   `GUI_fsdUserTotalMiles` is the field this whole board is built on, and on
   almost every car it is the only one read. On a small minority it is simply
   dead: the identical value in every sample for the full fourteen days while
   the car plainly drove. A dead counter subtracts to zero, and a zero here is
   worse than any error — the row looks measured, the host looks like they sent
   someone home without a demo, and nothing on the page says otherwise.

   `GUI_apFsdTotalMiles` is the same quantity read somewhere else. Over a whole
   delivery day (2026-08-08, TRT 17589, 60 cars) it agreed with the user
   counter to the thousandth of a mile on all 58 where both were alive, and
   carried the two where the primary was flat. So this is not two opinions to
   reconcile: the backup is consulted only when the primary has no pulse at
   all, and it never changes a figure the primary could produce. A car that
   genuinely sat still has both counters flat and still reports zero. */
const MILES_FIELD    = "GUI_fsdUserTotalMiles";
const MILES_FALLBACK = "GUI_apFsdTotalMiles";

const seriesFor = (rows, field) => rows
  .filter(r => r[field] != null)
  .map(r => ({ t: Date.parse(r.time + "Z"), v: r[field] }))
  .sort((a, b) => a.t - b.t);

/* Alive, not merely present. One sample cannot be distinguished from a stuck
   one, and a counter that never changes across the whole pull is exactly the
   failure being caught — so both count as no pulse. */
const hasPulse = s => s.length > 1 && s[s.length - 1].v !== s[0].v;

/* FSD miles the customer drove — the first `windowHours` after handoff and
   nothing else, neither before it nor after.

   Raw lifetime mileage is useless: every car lands with a few FSD miles from
   lot moves and PDI. The baseline is the last telemetry sample at or before
   the pickup slot, which is close to but not exactly the handoff instant, so
   the gap is reported per vehicle rather than silently trusted. Observed
   gaps run a few minutes; over an hour deserves a look.

   The closing reading is the last sample inside the window, not the latest
   the car has ever sent. A car measured at +30h used to have those extra
   eighteen hours of commuting folded into "post-delivery FSD"; now they fall
   outside the window and are not counted.

   Those excluded miles are still reported, as `milesToDate` — the same
   baseline against the newest reading the car has sent, with no cutoff. It is
   shown under the headline figure and never counted into it: the window is
   what makes two days comparable, and to-date is context for a single car. */
async function fsdMilesFor(vin, pickupIso){
  const win      = windowHours();
  const pickupMs = Date.parse(pickupIso);
  const endsMs   = pickupMs + win * 3600000;
  const endsIso  = new Date(endsMs).toISOString();
  const closed   = Date.now() >= endsMs;

  /* A closed window is a fact about a past twelve hours, so a stored answer is
     as good as a fresh one and costs nothing.

     To-date is the opposite kind of number — it is only ever true as of now —
     so it cannot come from the cache and is fetched alongside. That is one
     small call per settled car where there used to be none; it reads the
     latest sample only, not the whole curve back to handoff.

     Entries stored before to-date existed have no `baseValue` and cannot be
     turned into one, so they are treated as misses. Re-measuring a closed
     window returns the identical figure, so nothing moves — the row simply
     costs its full pull once more and is then cached with the baseline. */
  const key   = vin + "@" + pickupIso;
  const cache = measureCache();
  const hit   = cache[key];

  /* A stored zero from before the backup counter existed cannot be told apart
     from a dead primary, so those are re-measured once and then settle again.
     Every stored non-zero was read off a counter with a pulse and stands. */
  const preFallbackZero = hit && hit.result.field == null && hit.result.miles === 0;

  if(hit && !preFallbackZero && hit.windowHours === win && hit.result.baseValue != null){
    const toDate = await milesToDateFor(vin, hit.result.baseValue, hit.result.miles,
                                        hit.result.field);
    return { ...hit.result, ...toDate, windowHours: win, windowEndsAt: endsIso,
             final: true, cached: true };
  }

  /* Every exit below carries the window state, including the failures —
     whether a car is still being counted is a fact about the clock, not about
     whether its telemetry came back, and a caller filtering on `final` should
     not have to special-case the rows that went wrong. */
  const win_ = { windowHours: win, windowEndsAt: endsIso, final: closed };

  // Wide enough to still contain the handoff — a fixed 168h would silently
  // lose the baseline on anything older than a week and report the car's
  // whole visible curve as customer driving.
  const hours = Math.max(CONFIG.lookbackHours || 24, lookbackToCover(pickupIso));

  // Both counters come back from the one call — the backup is another column
  // on the same pull, so having it costs nothing even on the cars that will
  // never need it.
  const data = await callTool("device_historical_vitals", {
    device_id: vin,
    fields   : [MILES_FIELD, MILES_FALLBACK],
    hours,
    asc      : true
  });

  if(!data || !Array.isArray(data.rows) || !data.rows.length){
    return { error: (data && data.error) ? String(data.error) : "no vitals rows", ...win_ };
  }

  const primary = seriesFor(data.rows, MILES_FIELD);
  const backup  = seriesFor(data.rows, MILES_FALLBACK);
  const altCounter = !hasPulse(primary) && hasPulse(backup);
  const field = altCounter ? MILES_FALLBACK : MILES_FIELD;
  const rows  = altCounter ? backup : primary;
  if(!rows.length) return { error: "no FSD samples", ...win_ };

  const before = rows.filter(r => r.t <= pickupMs);
  const base   = before.length ? before[before.length - 1] : rows[0];

  /* Everything up to the window edge. The baseline is in here too unless the
     car sent nothing at all until after the window had already closed, which
     leaves no reading to measure against — better said plainly than reported
     as a confident zero. */
  const within = rows.filter(r => r.t <= endsMs);
  if(!within.length) return { error: `no telemetry within ${win}h of handoff`, ...win_ };
  const last = within[within.length - 1];

  /* The newest reading the car has sent, window or no window. On an open row
     it is the same sample as `last` and the two figures agree, which is
     correct rather than redundant — nothing has been cut off yet. */
  const newest = rows[rows.length - 1];

  const result = {
    miles            : Number((last.v - base.v).toFixed(3)),
    milesToDate      : Number((newest.v - base.v).toFixed(3)),
    toDateAt         : new Date(newest.t).toISOString(),
    baselineGapMin   : Math.round((pickupMs - base.t) / 60000),
    baselinePrePickup: before.length > 0,
    lastSample       : new Date(last.t).toISOString(),
    // Which counter answered, and whether it was the backup. Carried through
    // to the row so a figure the primary could not produce says so on screen
    // rather than passing as an ordinary reading.
    field,
    altCounter
  };

  /* Only settled measurements are kept. An error might be a momentary Garage
     hiccup, and caching one would make a transient failure permanent.

     The baseline value is stored, not just the delta it produced: it is what
     lets a later run price the to-date figure from one recent sample instead
     of pulling the curve back to handoff again. The to-date fields are not
     stored — they would be wrong by the time they were read. */
  if(closed){
    cache[key] = { windowHours: win,
                   result: { ...result, milesToDate: undefined, toDateAt: undefined,
                             baseValue: base.v } };
    // `field` rides along inside result, so a cached row's to-date figure is
    // read off the same counter its windowed figure was.
    measuresDirty = true;
  }

  return { ...result, ...win_ };
}

/* The to-date figure for a car whose window is already settled and cached.

   `hours` is a span ending at the car's most recent snapshot rather than at
   the current moment, so a short pull returns the newest reading even from a
   car that has been parked for days — the whole point of not re-reading the
   curve back to handoff.

   Returns nothing at all rather than a guess when the pull comes back empty:
   an absent line reads as "not known", where falling back to the windowed
   figure would read as "the customer stopped driving", which is a claim the
   data does not support. A reading below the windowed one is treated the same
   way — the counter has been reset or reprovisioned, and the delta from the
   old baseline is meaningless. */
async function milesToDateFor(vin, baseValue, windowMiles, field){
  // Whichever counter produced the windowed figure produces this one. Reading
  // the other would difference two different scales against one baseline.
  const use = field || MILES_FIELD;

  const data = await callTool("device_historical_vitals", {
    device_id: vin,
    fields   : [use],
    hours    : 24,
    asc      : true
  });
  if(!data || !Array.isArray(data.rows)) return {};

  const rows = seriesFor(data.rows, use);
  if(!rows.length) return {};

  const newest = rows[rows.length - 1];
  const miles  = Number((newest.v - baseValue).toFixed(3));
  if(windowMiles != null && miles < windowMiles) return {};

  return { milesToDate: miles, toDateAt: new Date(newest.t).toISOString() };
}

/* ──────────────────────────────── report ──────────────────────────────── */

/* Two passes now:

     enumerate  tesladex, filtered to this centre by VRL — a query per date
     measure    one vitals pull per vehicle

   There used to be a scoping pass between them that probed the telemetry of
   every car delivered nationally that day, thousands of calls to keep a few
   dozen, and it dominated the runtime. Filtering on VRL server-side removed
   it: a day went from about twelve minutes to seconds. What is left of it is
   the bounded fallback for cars the index cannot place, which normally finds
   nothing and costs one query. */
async function collectReport({ dates, trtId, vin, rn, mode, onProgress } = {}){
  const chosen = effectiveMode(mode);
  const perDate = [];
  const notes = [];
  if(chosen.degraded && chosen.why) notes.push(chosen.why);

  await ensureSession();

  /* ── one car, or a centre's day ──
     A single-car search substitutes a single index lookup for the enumerate
     pass and takes the date and the centre from the car itself. Everything
     downstream — enrichment, measurement, naming — runs exactly as it does for
     a day, so the one row cannot be scored by different rules than the many.

     An RN is turned into its VIN first and then joins that same path, rather
     than getting a path of its own. Which number was typed changes how the car
     was found and nothing about what is reported for it. */
  /* Not pushed into notes on the way past: on a search that works, the page
     already puts the RN and the VIN side by side above the row, and repeating
     it in the notice bar would dress a normal result as a warning. It is
     carried instead, and added to whatever goes wrong after this point — where
     "no vehicle with VIN X" is unreadable without knowing X came from the RN
     that was typed. */
  let rnNote = null;

  if(rn && !vin){
    if(chosen.mode !== "advanced"){
      return { trtId: trtId ? String(trtId) : null, rn, single: true,
               mode: chosen.mode, perDate: [], rows: [],
               notices: [`Garage does not index reference numbers, so ${rn} can only be ` +
                         `resolved from a centre's Intrepid appointments — and this run is ` +
                         `in basic mode. Sign in to Intrepid on the Zo Projects Hub, or ` +
                         `search the car's VIN, which needs neither.`,
                         ...takeNotices()] };
    }
    try{
      vin = (await vinForRn(rn, trtId)).vin;
    }catch(err){
      if(err.needsCookie || err.needsAuth) throw err;
      return { trtId: trtId ? String(trtId) : null, rn, single: true,
               mode: chosen.mode, perDate: [], rows: [],
               notices: [err.message, ...takeNotices()] };
    }
    rnNote = `${rn} is ${vin}, found in TRT ${trtId}'s appointments.`;
  }

  let single = null;
  if(vin){
    const found = await deliveryForVin(vin);
    if(found.error){
      // rnNote first, so a car the index has never heard of still says which
      // reference number led to the VIN it is complaining about.
      return { trtId: trtId ? String(trtId) : null, vin, rn: rn || null, single: true,
               mode: chosen.mode, perDate: [], rows: [],
               notices: [rnNote, found.error, ...takeNotices()].filter(Boolean) };
    }
    single = found.car;
  }

  /* The car's own routing location wins over whatever the dashboard is
     pointed at — searching a VIN from another centre should answer about that
     centre, not silently look for its appointment in the wrong one. */
  const trt = single
    ? String(single.trt ?? trtId ?? "")
    : String(trtId);
  const days = single ? [single.date] : dates;

  if(single && !single.trt){
    notes.push(`${single.vin} has no routing location in the index` +
               (trt ? `, so ${trt} was used to look up its appointment.`
                    : `, so no reference number or delivery host could be found for it.`));
  }

  /* Explained rather than dropped, unlike the day report. Somebody who typed
     this VIN wants to know about this car, and answering "no such delivery"
     to a car that is plainly on the schedule is worse than answering with a
     zero and the reason for it. */
  if(single && single.scheduledFor && single.scheduledFor > single.date){
    notes.push(`${single.vin} carries a delivery date of ${single.date} but is still ` +
               `scheduled for ${single.scheduledFor}, so it has not been handed over — ` +
               `any mileage below is pre-delivery and not what this board measures.`);
  }

  /* ── enumerate ── */
  const scoped = [];

  if(single){
    if(beyondVitalsWindow(single.date)){
      return { trtId: trt || null, vin, rn: rn || null, single: true, mode: chosen.mode,
               perDate: [{ date: single.date, national: 0, delivered: 1, skipped: true }],
               rows: [],
               notices: [rnNote,
                         `${single.vin} was delivered on ${single.date}, more than ` +
                         `${VITALS_CEILING_DAYS} days ago — the mileage reading at handoff ` +
                         `has aged out of telemetry, so the post-delivery figure cannot be ` +
                         `measured.`, ...takeNotices()].filter(Boolean) };
    }
    perDate.push({ date: single.date, national: 0, delivered: 1 });
    scoped.push(single);
  }

  for(const date of single ? [] : dates){
    if(beyondVitalsWindow(date)){
      notes.push(`${date} is more than ${VITALS_CEILING_DAYS} days ago — telemetry no ` +
                 `longer reaches back to those handoffs, so post-delivery miles cannot ` +
                 `be measured and that date is skipped.`);
      perDate.push({ date, national: 0, delivered: 0, skipped: true });
      continue;
    }

    const mine = await tesladexDeliveries(date, trt, p =>
      onProgress && onProgress({ phase: "enumerate", ...p }));

    /* Cars the index could not place. Normally none; see unroutedDeliveries. */
    const strays = await unroutedDeliveries(date, trt, onProgress);
    if(strays.length){
      notes.push(`${strays.length} car(s) on ${date} had no routing location and were ` +
                 `matched from telemetry instead.`);
      mine.push(...strays);
    }

    /* Dropped before anything is measured, not flagged afterwards. A car that
       was never handed over has no post-delivery mileage to be right or wrong
       about, and leaving it in cost twice: a guaranteed 0.0 dragging the
       engagement percentage down, and an unanswerable Sub-Intent inflating the
       "could not be checked" count on the morning brief — which is the alarm
       for a broken Tesla OS session and should not be ringing for this.

       Counted in the notice rather than dropped in silence: the day's total
       moving with no explanation is how you lose trust in the number. */
    const notOut = mine.filter(d => d.scheduledFor && d.scheduledFor > date);
    const real   = notOut.length
      ? mine.filter(d => !(d.scheduledFor && d.scheduledFor > date))
      : mine;

    if(notOut.length){
      const when = [...new Set(notOut.map(d => d.scheduledFor))].sort();
      notes.push(
        `${notOut.length} car(s) dated ${date} in Garage ${notOut.length === 1 ? "is" : "are"} ` +
        `still scheduled for ${when.join(", ")} and ${notOut.length === 1 ? "has" : "have"} not ` +
        `been handed over — left out of the day entirely.`);
    }

    const national = await nationalCount(date);
    perDate.push({ date, national, delivered: real.length,
                   ...(notOut.length ? { notOut: notOut.length } : {}) });
    if(onProgress) onProgress({ phase: "scoped", date,
                                national, delivered: real.length });
    scoped.push(...real);
  }

  if(!scoped.length){
    return { trtId: trt, vin: vin || null, rn: rn || null, single: Boolean(single),
             mode: chosen.mode, perDate, rows: [],
             notices: [...notes, ...takeNotices()] };
  }

  /* ── advanced enrichment ──
     Intrepid is asked for the fields Garage does not have, and nothing else.
     Its appointment list is joined on VIN rather than trusted for the
     population, so a car Intrepid has not heard of still appears with its
     mileage intact instead of vanishing from the report. */
  const extra = new Map();
  if(chosen.mode === "advanced" && trt){
    for(const date of days){
      try{
        for(const a of await appointmentsOn(date, trt)){
          // userId is the customer's my_tesla_unique_id — the join to a name.
          if(a.vin) extra.set(a.vin, { rn: a.referenceNumber || "",
                                       userId: a.userId || null });
        }
      }catch(err){
        if(err.needsCookie){
          notes.push("Intrepid rejected the cookie, so reference numbers and delivery " +
                     "hosts are missing from this run — paste a fresh one under Admin.");
          extra.clear();
          break;
        }
        throw err;
      }
    }
  }

  /* ── measure ── */
  let done = 0;
  const rows = await pool(scoped, CONFIG.concurrency, async d => {
    const hit = extra.get(d.vin);
    const [fsd, staff] = await Promise.all([
      fsdMilesFor(d.vin, d.deliveredAt),
      hit && hit.rn ? appointmentStaff(hit.rn).catch(() => null) : Promise.resolve(null)
    ]);
    done++;
    if(onProgress) onProgress({ phase: "vehicles", done, total: scoped.length });
    return { ...d, ...fsd, rn: hit ? hit.rn : "",
             userId: hit ? hit.userId : null,
             hostUser: staff ? staff.hostUser : "", _staff: staff };
  });
  measureFlush();

  /* Said out loud, because it is the difference between a number that is done
     and one that is not. A run of today's deliveries is mostly this. */
  const open = rows.filter(r => r && r.final === false).length;
  if(open){
    notes.push(`${open} car(s) are still inside the ${windowHours()}-hour window — ` +
               `those figures keep climbing until it closes, and settle after that.`);
  }

  /* ── name the hosts ──
     After measuring, not during: every advisor pair from every row feeds the
     directory first, so the Garage fallback is only asked about people who
     genuinely never appear as an advisor. Doing it per row would fire
     lookups for names a later row was about to teach us for free. */
  if(chosen.mode === "advanced"){
    for(const r of rows){
      if(!r || !r._staff) continue;
      learnStaff(r._staff.advisorUser, r._staff.advisorName);
      learnStaff(r._staff.salesUser,   r._staff.salesName);
    }
    staffFlush();

    const custs = await resolveCustomers(rows.map(r => r && r.userId));
    const cache = await resolveStaff(rows.map(r => r && r.hostUser));

    /* ── does the customer want FSD? ──
       Tesla OS, keyed by reference number. Optional in a way the other two are
       not: a run without it is still a complete mileage report, so a failure
       here annotates and carries on rather than taking the day down with it.

       Every row is left `null` on failure, never "none" — see resolveFsdIntent.
       A brief that names the whole centre as uninterested because a token
       lapsed would be worse than one that says nothing. */
    /* A never-connected board is told so plainly rather than being made to
       wait while something tries to sign it in. Once connected, a lapsed
       session repairs itself inside resolveFsdIntent and nothing is said —
       that is the normal case and not worth a notice. */
    let intents = null;
    if(osConnected()){
      try{
        intents = await resolveFsdIntent(rows.map(r => r && r.rn));
      }catch(err){
        intents = null;
        notes.push(`FSD Sub-Intent is missing from this run: ${err.message}`);
      }
    }else{
      notes.push("FSD Sub-Intent is not shown — Tesla OS has not been connected on this " +
                 "machine yet. Connect it once under Admin › Alerts and it will keep " +
                 "itself signed in after that.");
    }

    for(const r of rows){
      if(!r) continue;
      r.customer = r.userId ? (custs.get(String(r.userId)) || "") : "";
      r.host = staffName(cache, r.hostUser);

      /* No RN means Intrepid never saw this car, so the question was never
         asked — unknown, not "no intent". */
      const seen = intents && r.rn ? intents.get(String(r.rn)) : null;
      r.fsdIntent = seen ? seen.state : null;
      r.fsdStatus = seen ? seen.text  : "";
      // The advisor is still carried, unexported — it is the join that taught
      // us most of the directory and is worth having when debugging a name.
      r.advisor = r._staff ? r._staff.advisorName : "";
      delete r._staff;
    }
    const unnamed = rows.filter(r => r && r.hostUser && r.host === r.hostUser).length;
    if(unnamed){
      notes.push(`${unnamed} row(s) show a delivery host as a username — no display name ` +
                 `was found for them in Intrepid or Garage.`);
    }
  }

  // Longest drive first — that is the interesting end of the list.
  rows.sort((a, b) => (b.miles ?? -1) - (a.miles ?? -1));

  return { trtId: trt, vin: vin || null, rn: rn || null, single: Boolean(single),
           mode: chosen.mode, perDate, rows,
           notices: [...notes, ...takeNotices()] };
}

/* ─────────────── the morning brief's population: APPOINTMENTS ───────────
   Used by the brief and by nothing else. The hourly digest is unchanged and
   stays on collectReport.

   collectReport is the wrong question for this card. It enumerates cars
   Tesladex says were DELIVERED, and at the opening hour that is almost
   nobody — the brief would open the day with an empty list at exactly the
   moment the entire list is still ahead of it. "Nobody to chase" is then a
   lie told to every advisor before they have handed over a single car.

   So the brief asks Intrepid for the day's appointments: everyone booked in
   today, picked up or not. That is the population the card is about — who is
   coming in, who among them has never said they want FSD, and when they are
   due — and it is knowable at 08:00 because it is a diary, not a measurement.

   NOTHING is filtered out. Across 481 rows sampled over eleven days the only
   appointment types were CustomerPickup and TeslaDirect, both real customers
   collecting real cars, and the only statuses were DELIVERED, BOOKED and
   ORDER_PLACED — stages of the same day rather than reasons to drop someone.
   Dropping a row here means one customer nobody is told about, so a filter
   needs a reason and there is not one yet. Already-delivered rows stay in
   deliberately: the brief says what today looks like, and an advisor reading
   it at 13:00 should still see the 09:00 handover that got away.

   Advanced only. Appointments come from Intrepid and Sub-Intent from Tesla
   OS; a basic board cannot answer this question and says so, rather than
   returning an empty list that reads as good news. */
async function briefAppointments(date, trtId){
  const notes = [];
  const chosen = effectiveMode(undefined);
  if(chosen.mode !== "advanced"){
    return { rows: [], total: 0, unknown: 0, mode: "basic", basic: true,
             notices: [chosen.why || "The morning brief needs advanced mode: the day's " +
                       "appointments come from Intrepid, which basic mode never calls."] };
  }

  const raw = await appointmentsOn(date, trtId);

  /* One row per reference number, earliest slot kept. A rescheduled order can
     appear twice on the same day, and naming that customer twice would read
     as two people to chase. */
  const byRn = new Map();
  for(const a of raw){
    const rn = String(a.referenceNumber || "").trim();
    if(!rn) continue;
    const prev = byRn.get(rn);
    if(!prev || Date.parse(a.startDateTime || 0) < Date.parse(prev.startDateTime || 0)){
      byRn.set(rn, a);
    }
  }
  const appts = [...byRn.values()];
  if(!appts.length) return { rows: [], total: 0, unknown: 0, mode: "advanced", notices: notes };

  /* Who owns each one. Same call the report uses, one per appointment, pooled
     the same way — this is the expensive half of the brief and it is why the
     card takes a little longer than an hourly check. */
  const staffByRn = new Map();
  await pool(appts, Math.min(6, appts.length), async a => {
    const s = await appointmentStaff(a.referenceNumber).catch(() => null);
    if(s) staffByRn.set(String(a.referenceNumber), s);
  });
  for(const s of staffByRn.values()){
    learnStaff(s.advisorUser, s.advisorName);
    learnStaff(s.salesUser,   s.salesName);
  }
  staffFlush();

  const custs = await resolveCustomers(appts.map(a => a.userId));
  const cache = await resolveStaff([...staffByRn.values()].map(s => s.hostUser));

  /* Sub-Intent. Optional in the same way it is for a report: every row is
     left null on failure and never "none", because a lapsed token must not
     turn the whole centre into customers who said they were not interested. */
  let intents = null;
  if(osConnected()){
    try{ intents = await resolveFsdIntent(appts.map(a => a.referenceNumber)); }
    catch(err){
      notes.push(`FSD Sub-Intent could not be read for this brief: ${err.message}`);
    }
  }else{
    notes.push("FSD Sub-Intent is not shown — Tesla OS has not been connected on this " +
               "machine yet. Connect it once under Admin › Sources.");
  }

  const rows = appts.map(a => {
    const rn    = String(a.referenceNumber);
    const staff = staffByRn.get(rn) || null;
    const seen  = intents ? intents.get(rn) : null;
    return {
      rn,
      vin      : a.vin || "",
      model    : a.model || "",
      customer : a.userId ? (custs.get(String(a.userId)) || "") : "",
      /* The delivery advisor by name, then whoever is driving the handover,
         then the raw username — the same ladder the report walks down, so a
         person is named the same way on both cards. */
      advisor  : (staff && staff.advisorName)
                 || (staff ? staffName(cache, staff.hostUser) : "")
                 || "",
      // The booked slot, not a delivery timestamp: this is a diary entry and
      // most of these cars have not moved yet.
      at       : a.startDateTime || null,
      fsdIntent: seen ? seen.state : null,
      fsdStatus: seen ? seen.text  : ""
    };
  });

  return {
    rows,
    total  : rows.length,
    unknown: rows.filter(r => r.fsdIntent == null).length,
    mode   : "advanced",
    notices: [...notes, ...takeNotices()]
  };
}

/* ── what counts as having driven on FSD ──
   A distance, because anything short of one is a lot shuffle or a bay
   reposition rather than a customer choosing to use the feature.

   The bar is **at least** this far, not further than it: the standard is
   "the car has to hit a mile", so a car that reaches exactly the figure has
   met it. That is why this is `>=` and the default is a whole mile — it was
   0.5 and exclusive, which quietly passed cars that had barely rolled.

   Settable, because the number is a judgement about what counts rather than
   a fact about the data, and it is the kind of thing a centre will want to
   move. Every caller reads it through here so the CLI, the dashboard, the
   leaderboard and the export can never score a day differently. */
const DROVE_THRESHOLD = 1;

/* Note the null/"" guard before Number(): `Number(null)` is 0, so without it
   an unset override reads as a zero-mile bar and every car that moved counts
   as having driven on FSD. */
const asThreshold = v => {
  if(v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function droveThreshold(){
  const local = asThreshold(loadConnections().droveThreshold);
  if(local != null) return local;
  const shipped = asThreshold(CONFIG.droveThreshold);
  return shipped != null ? shipped : DROVE_THRESHOLD;
}

function summarise(rows){
  const bar   = droveThreshold();
  const ok    = rows.filter(r => r.error == null && r.miles != null);
  const drove = ok.filter(r => r.miles >= bar);
  const gaps  = ok.map(r => r.baselineGapMin).sort((a, b) => a - b);
  return {
    vehicles : rows.length,
    resolved : ok.length,
    failed   : rows.length - ok.length,
    // Travels with the counts so anything reporting them can say what bar
    // they were scored against, rather than assuming the default.
    threshold: bar,
    // Same reasoning for the window: a caller showing these totals should be
    // able to say how many of them are finished.
    windowHours: windowHours(),
    open     : rows.filter(r => r.final === false).length,
    drove    : drove.length,
    adoption : ok.length ? Math.round(drove.length / ok.length * 100) : 0,
    totalMi  : Number(ok.reduce((a, r) => a + r.miles, 0).toFixed(1)),
    medianMi : drove.length
      ? Number(drove.map(r => r.miles).sort((a, b) => a - b)[Math.floor(drove.length / 2)].toFixed(1))
      : 0,
    gapMedian: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    gapMax   : gaps.length ? gaps[gaps.length - 1] : null,
    gapLeaky : ok.filter(r => r.baselineGapMin > 60).length,
    // Rows whose primary counter was dead. Normally a couple per day; a run
    // where it climbs is worth knowing about before the numbers are quoted.
    altCounter: ok.filter(r => r.altCounter).length,

    /* FSD intent, counted over ALL rows rather than the measurable ones: a car
       whose mileage could not be read still has a customer with a view about
       FSD, and that is the question here.

       `noIntent` is the chase list's size and deliberately counts only rows
       that were actually answered. `intentUnknown` is everything we could not
       ask about — no reference number, no Tesla OS session, or an order the
       account cannot see. Two numbers rather than one, because a day where
       nobody stated intent and a day where nothing could be read look
       identical from a single count and mean opposite things. */
    intent       : rows.filter(r => r.fsdIntent === "intent").length,
    hasFsd       : rows.filter(r => r.fsdIntent === "has").length,
    noIntent     : rows.filter(r => r.fsdIntent === "none").length,
    intentUnknown: rows.filter(r => r.fsdIntent == null).length
  };
}

/* Below this a rate is noise. One car at 100% is not a result, and putting it
   top of a leaderboard would be actively misleading — so those hosts are
   ranked and shown, but not eligible to be called the day's best. Stated in
   the UI rather than applied quietly. */
const MIN_QUALIFY = 3;

/* ── per-host breakdown ──
   Two different percentages, and conflating them would be easy:

     share    this host's cars as a fraction of the day's deliveries — how
              much of the work they did
     fsdRate  how many of THEIR OWN cars drove FSD — how well it went

   A host with three cars and a 100% rate is not outperforming one with
   twenty at 85%, so `cars` travels alongside both and the UI shows it.

   Computed here rather than in the page so the CLI, the dashboard and any
   export can never disagree about what a percentage means. */
function byHost(rows){
  const total = rows.length;
  const groups = new Map();

  for(const r of rows){
    // Basic mode has no host at all; those rows group under "" and the
    // caller simply gets a single unnamed bucket it can ignore.
    const key = r.host || r.hostUser || "";
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const bar = droveThreshold();
  const out = [];
  for(const [host, rs] of groups){
    const ok    = rs.filter(r => r.error == null && r.miles != null);
    const drove = ok.filter(r => r.miles >= bar);
    const miles = ok.reduce((a, r) => a + r.miles, 0);
    out.push({
      host,
      user   : (rs.find(r => r.hostUser) || {}).hostUser || "",
      cars   : rs.length,
      share  : total ? Math.round(rs.length / total * 100) : 0,
      resolved: ok.length,
      drove  : drove.length,
      fsdRate: ok.length ? Math.round(drove.length / ok.length * 100) : 0,
      totalMi: Number(miles.toFixed(1)),
      avgMi  : rs.length ? Number((miles / rs.length).toFixed(1)) : 0,
      qualified: rs.length >= MIN_QUALIFY
    });
  }

  // Most deliveries first; miles breaks a tie. Ranking by rate alone would
  // put a one-car host at the top of every list.
  out.sort((a, b) => b.cars - a.cars || b.totalMi - a.totalMi);
  return out;
}

/* ── per-advisor breakdown ──
   Volume only, and that is structural rather than a matter of discipline:
   there is nowhere here to put an FSD number, so no caller can accidentally
   attribute driving to the advisor. The host conducted the handover and is
   the only person the mileage can be laid against; the advisor owns the
   appointment, which is worth seeing and is a different fact.

   They differ on roughly a third of cars, so this is not a second view of the
   same list. */
function byAdvisor(rows){
  const total = rows.length;
  const counts = new Map();

  for(const r of rows){
    const key = r.advisor || "";
    if(!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const out = [...counts].map(([advisor, cars]) => ({
    advisor, cars, share: total ? Math.round(cars / total * 100) : 0
  }));
  out.sort((a, b) => b.cars - a.cars || a.advisor.localeCompare(b.advisor));
  return out;
}

/* ──────────────────────────────── dates ──────────────────────────────── */

function todayLocal(){
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function expandDates(spec){
  if(!spec || spec === "today") return [todayLocal()];
  if(!spec.includes("..")) return [spec];
  const [from, to] = spec.split("..");
  const out = [];
  for(let t = Date.parse(from + "T00:00:00Z"), end = Date.parse(to + "T00:00:00Z");
      t <= end && out.length < 400; t += 86400000){
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);

/* Seventeen characters, and never I, O or Q — the standard leaves them out so
   they cannot be misread as 1 and 0. Checked before anything is dispatched so
   a mistyped VIN comes back as a typo rather than as "no vehicle found",
   which reads like the car is missing rather than the query wrong. */
const isVin = v => /^[A-HJ-NPR-Z0-9]{17}$/.test(String(v || "").toUpperCase());

/* ── reference numbers ──
   RN followed by the order's digits. The prefix is added when it is missing,
   because the same number is read off an order page with it and dictated over
   a radio without it, and refusing the bare digits would be pedantry about a
   number there is only one of. */
const normaliseRn = v => {
  const s = String(v || "").trim().toUpperCase().replace(/\s+/g, "");
  return /^\d{6,12}$/.test(s) ? `RN${s}` : s;
};
const isRn = v => /^RN\d{6,12}$/.test(normaliseRn(v));

/* ──────────────────────────── connection tests ────────────────────────────
   Each returns {ok, detail} rather than throwing, so the Connections tab can
   show every row's state at once instead of dying on the first failure. */

async function testIntrepid(trtId){
  const trt = trtId;
  // Without a TRT the cookie itself is still testable — any real TRT would do,
  // but guessing one is worse than saying plainly what is missing.
  if(!trt) return { ok: false, detail: "No TRT set — enter one to test" };
  try{
    const rows = await appointmentsOn(todayLocal(), trt);
    return { ok: true, detail: `${rows.length} appointment(s) today at TRT ${trt}` };
  }catch(err){
    return { ok: false, detail: err.message };
  }
}

async function testGarage(){
  try{
    await ensureSession();
    // ensureSession asserts the cookie, which is what almost every Garage call
    // here actually uses. The MCP token is reported alongside rather than
    // tested: it is needed for names only, and a missing one is not a failure.
    const m = mcpAuth.status();
    const mins = m.expiresAt ? Math.round((new Date(m.expiresAt) - Date.now()) / 60000) : null;
    const names = !m.set ? "names unavailable — sign in to Garage · MCP on the Hub"
      : (mins != null && mins > 0 ? `names via MCP, token valid ${mins} more min`
                                  : "names via MCP, token refreshes on next use");
    return { ok: true, detail: `Garage session live — ${names}` };
  }catch(err){
    return { ok: false, detail: err.message };
  }
}

/* Basic mode's real health check. A live Garage session is not the same thing
   as tesladex answering for delivered vehicles — that access was refused
   outright until recently, and it is the single permission the whole
   cookie-free path rests on. Worth testing on its own. */
async function testTesladex(){
  try{
    await ensureSession();
    const [from, to] = dayRangeEpoch(todayLocal());
    const page = await callTool("tesladex_search", {
      query : `delivery_date_epoch:[${from} TO ${to}]`,
      fields: ["vin"],
      size  : 1
    });
    const n = page && typeof page.total === "number" ? page.total : 0;
    return { ok: true, detail: `${n.toLocaleString()} delivery(s) indexed nationally today` };
  }catch(err){
    return { ok: false, detail: err.message };
  }
}

/* Reset is deliberately narrow: preferences and caches, never credentials.
   Re-pasting an Intrepid cookie is a genuine chore, so wiping it should be an
   explicit act in Connections rather than a side effect of "reset". */
function resetDashboard(){
  let cacheCleared = false;
  try{
    if(fs.existsSync(TRT_CACHE)){ fs.unlinkSync(TRT_CACHE); cacheCleared = true; }
  }catch{ /* a stale cache is harmless */ }
  trtMap = null;
  // The chosen centre is a preference, not a credential, so reset clears it —
  // this is the escape hatch for a TRT that now otherwise persists forever.
  saveConnections({ trtId: null });
  // The VIN→TRT cache is deliberately spared. It records what happened at a
  // past handoff, so it can never go stale — and rebuilding it means a Garage
  // call for every car delivered nationally on every date being looked at.
  // The settled-measurement cache is spared for exactly the same reasons.
  return { cacheCleared };
}

/* Separate from reset for exactly that reason: emptying it is a real cost, so
   it should be a deliberate act rather than a side effect of tidying up. */
function clearVinTrtCache(){
  const n = Object.keys(vinTrtCache()).length;
  vinTrt = {};
  vinTrtDirty = false;
  try{ if(fs.existsSync(VIN_TRT_CACHE)) fs.unlinkSync(VIN_TRT_CACHE); }catch{}
  return { cleared: n };
}

/* Never returns a credential — only whether one is present and how it looks,
   which is all the panel needs to render state. */
function connectionsSummary(){
  const c = loadConnections();
  /* The cookie calls actually use — Hub first, local second. Reading the local
     field alone would report "not set" on a board the Hub has signed in, since
     nothing writes local any more. */
  const cookie = credstore.intrepidCookie((c.intrepidCookie || "").trim()).value.trim();

  /* Garage is two credentials wearing one name. The cookie does the work and
     the MCP token only resolves names, so the panel reports the cookie's state
     as Garage's — and says separately when names are unavailable. Reporting
     the token as "Garage" would show a red dot on a board that is reading
     Garage perfectly well. */
  const gc = credstore.garageCookie("prod", (c.garageCookie || "").trim());
  const m  = mcpAuth.status();
  const signedIn = Boolean(gc.value);
  let detail = signedIn ? `signed in via ${gc.source === "hub" ? "the Hub" : "a local cookie"}`
                        : "not signed in";
  if(signedIn && !m.set) detail += " · names unavailable";

  const mode = normaliseMode(c.mode);

  return {
    mode,
    trtId: savedTrtId(),
    // The effective bar, and whether it is this machine's choice or the
    // shipped default — the panel says which, so nobody wonders whether their
    // edit took.
    droveThreshold: droveThreshold(),
    droveThresholdSet: asThreshold(c.droveThreshold) != null,
    // What advanced actually buys, kept here so the panel and the README
    // cannot describe it differently.
    advancedAdds: ["Reference number", "Delivery host", "Filter and stats by host",
                   "FSD Sub-Intent"],
    intrepid: {
      set    : Boolean(cookie),
      // A masked tail is enough to tell two pastes apart without exposing one.
      hint   : cookie ? "…" + cookie.slice(-8) : "",
      looksOk: /cogs-authorization=/.test(cookie),
      // Advanced without a cookie is the one broken combination.
      required: mode === "advanced"
    },
    garage: { detail, signedIn },
    /* Tesla OS is NEVER `required`. Without it every mileage figure on the
       board is still correct and every column but one still fills — the day's
       report does not depend on it, so a red dot here would overstate what is
       wrong. `live` is deliberately absent: proving it costs a round trip, so
       the panel asks for that separately through /api/os. */
    os: (() => {
      const s = c.os && c.os.token ? c.os : null;
      return {
        set  : Boolean(s),
        user : s ? (s.user || null) : null,
        name : s ? (s.name || "")   : "",
        title: s ? (s.title || "")  : "",
        since: s ? (s.capturedAt || null) : null,
        required: false
      };
    })(),
    alerts: alertsSummary(c)
  };
}

/* ── hourly Teams digest, as the panel needs to see it ──
   The webhook URL is a credential: whoever holds it can post into the
   channel. It is NEVER returned here, and the input box is never pre-filled
   from it. */
/* ── which day's brief has already gone out ──

   ON DISK, not in memory, and that is the whole point of it. lastAlertHour is
   allowed to be a variable because losing it costs one skipped digest; losing
   this one costs a SECOND morning brief posted into the channel after a
   restart, naming the same customers again. A flat key, like every other
   alert setting, because saveConnections is a shallow merge. */
const briefSentDate = () => String(loadConnections().alertBriefDate || "") || null;
const markBriefSent = date => saveConnections({ alertBriefDate: String(date) });

function alertsSummary(c){
  const url  = String(c.alertWebhook || "").trim();
  const days = A.normaliseDays(c.alertDays);
  const on   = c.alertsOn === true;
  const briefDate = String(c.alertBriefDate || "") || null;

  return {
    on,
    /* The brief is not a separate schedule with its own switch — it IS the
       day's first post, so the panel describes it from the same settings
       rather than offering another set to keep in step. */
    brief: { date: briefDate, sentToday: briefDate === A.dayKey(new Date()) },
    start: A.normaliseTime(c.alertStart, A.DEFAULTS.start),
    end  : A.normaliseTime(c.alertEnd,   A.DEFAULTS.end),
    days,
    dayLabel: A.dayLabel(days),
    webhook: {
      set: Boolean(url),
      /* The HOST, not a masked tail. The Intrepid hint can show its last
         eight characters because a cookie fragment is useless on its own —
         the last eight characters of a Power Automate URL are the end of the
         sig HMAC, which is the credential itself. This says "yes, that is
         the one you pasted" and hands back none of it. */
      hint: url ? url.replace(/^(https:\/\/[^/]+)\/.*$/, "$1/…") : "",
      // The truncated-paste test. See looksLikeFlowUrl in alerts.js for why
      // this is the most valuable field on the object.
      looksOk: A.looksLikeFlowUrl(url)
    },
    // All the conditions at once, so the panel renders one honest verdict
    // instead of re-implementing the scheduler's rule in the page.
    armed: on && Boolean(url) && days.length > 0,
    why  : on ? (!url ? "no webhook is set" : !days.length ? "no days are selected" : "")
              : "alerts are switched off"
  };
}

module.exports = {
  CONFIG, resolvePath, readJson,
  loadConnections, saveConnections, connectionsSummary, adminPassword, savedTrtId,
  MODES, normaliseMode, effectiveMode,
  appointmentsOn, appointmentStaff, intrepidCookie,
  resolveStaff, staffName, resolveCustomers, resolveFsdIntent,
  osConnected, osStatus, osSignIn, osDisconnect, osEnsureToken, osReconnect,
  osClearHealCooldown, briefSentDate, markBriefSent,
  osSignInStatus: osx.signInStatus, osCancelSignIn: osx.cancelSignIn,
  byHost, byAdvisor, DROVE_THRESHOLD, droveThreshold, MIN_QUALIFY,
  WINDOW_HOURS, windowHours, clearMeasureCache,
  trtInfo, trtDirectory, searchSites,
  ensureSession, callTool, fsdMilesFor, collectReport, briefAppointments,
  summarise, garageUrl,
  tesladexDeliveries, unroutedDeliveries, nationalCount,
  trtAtDelivery, dayRangeEpoch,
  beyondVitalsWindow, VITALS_CEILING_DAYS,
  testIntrepid, testGarage, testTesladex,
  resetDashboard, clearVinTrtCache,
  todayLocal, expandDates, isDate, isVin, deliveryForVin, takeNotices,
  isRn, normaliseRn, vinForRn
};

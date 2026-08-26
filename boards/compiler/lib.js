/* The Compiler — shared core.

   A board of tools over the two systems that between them describe a vehicle:
   Garage's index says what a car IS, Intrepid says what is WRONG with it.
   Everything that talks to either lives here, so no tool on the board can
   drift into its own idea of what a service visit is.

   Both connections are required rather than optional. There is no degraded
   mode: a scan missing half its sources would answer the question wrongly
   instead of refusing, which is the worse failure. */

"use strict";

const fs     = require("fs");
const path   = require("path");
const https  = require("https");
const crypto = require("crypto");

const credstore = require("./credstore");
const sca       = require("./sca");
/* `osx`, not `os`, purely to keep the name free: `os` is node's own module and
   this file would be one `require("os")` away from a silent shadow. */
const osx       = require("./os");
/* `invx` for the same reason as `osx` — and because `inv` reads like a local
   in half the functions below. Nothing to sign in to, so unlike sca/osx it is
   only ever called, never connected. */
const invx      = require("./inventory");
/* Tracker owns its own store and its own loop and opens no sockets: it reaches
   Garage through the functions handed to `trk.init()` at the foot of this
   file. Required here rather than requiring lib.js from there, because that
   direction is a cycle. */
const trk       = require("./tracker");
/* The Parts tool's Service App calls, one function per captured endpoint and
   no policy in any of them — the gates and the ordering are down at the foot
   of this file. Split for the same reason sca.js is split from here. */
const parts     = require("./parts");

const HERE = __dirname;

const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

const resolvePath = p => (path.isAbsolute(p) ? p : path.join(HERE, p));
const readJson    = f => JSON.parse(fs.readFileSync(f, "utf8"));

/* ──────────────────────────── connections ────────────────────────────
   What a fresh machine has to be told, in one gitignored file the admin panel
   writes. config.json holds only non-secret machine settings, so it stays
   committable; .connections.json holds the credential and never is.        */

const CONN_FILE = path.join(HERE, ".connections.json");

/* Two settings, because two things genuinely need storing:

     intrepidCookie  the cogs-authorization session, grabbed or pasted.
     garageCookie    the Garage session, same story. Both are cookies now:
                     Garage's index is reachable over its own web session, so
                     there is no OAuth client, no token store and nothing this
                     board shares with any other.
     trtId           the centre the board is pointed at. Chosen once and kept
                     until changed; Admin › Maintenance › Reset clears it.
     offsiteTrtId    the overflow lot, if there is one. Same picker, same file.
                     Null on a board that only has the one site.
     sca             the Service App bearer token, its expiry and who it
                     belongs to. The one credential this board signs in for
                     itself rather than reading from the Hub — sca.js has the
                     reasoning. Null until somebody presses Connect.        */
/* `billingAddress` is this centre's own street address, used when a car's
   billing address is switched over to Tesla. It has to be a setting rather
   than something derived: every centre has a different one, neither Garage nor
   Intrepid carries it in a form SCA will accept, and a board pointed at
   another centre must not inherit Cypress's. Empty until somebody fills it in
   under Admin › My location. */
/* `teams` is the incoming webhook a Power Automate flow listens on, plus the
   token that guards the trigger URL. Empty until somebody pastes a webhook
   under Admin › Teams. */
const CONN_DEFAULTS = { intrepidCookie: "", garageCookie: "", trtId: null,
                        offsiteTrtId: null, sca: null, os: null,
                        billingAddress: null, teams: null };

/* Stored as a number or null, never a string, so callers can compare without
   worrying which layer they got it from. */
const asTrt = v => /^\d+$/.test(String(v || "")) ? Number(v) : null;

function savedTrtId(){ return asTrt(loadConnections().trtId); }
function savedOffsiteTrtId(){ return asTrt(loadConnections().offsiteTrtId); }


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

  return next;
}

/* ── the Service App token ──
   lib.js is the only writer of .connections.json, so the sign-in machinery in
   sca.js hands its result here rather than reaching for the file itself.
   Everything about WHY this credential lives on the board instead of the Hub
   is written up at the top of sca.js. */

function scaSaved(){
  const s = loadConnections().sca;
  return s && s.token ? s : null;
}

/* Throws rather than returning empty, the same shape intrepidCookie() and
   ensureSession() already use, so the server's error mapper turns it into a
   401 the panel knows how to answer. */
function scaToken(){
  const s = scaSaved();
  if(!sca.isLive(s)){
    const err = new Error(s
      ? "Service App session expired — connect SCA again in Admin › Sources"
      : "Not connected to the Service App — connect SCA in Admin › Sources");
    err.needsSca = true;
    throw err;
  }
  return s.token;
}

const scaConnected = () => sca.isLive(scaSaved());

function scaCommit(got){
  return saveConnections({
    // accessToken is the SEPARATE credential TSS wants — see cancelAppointment
    // in sca.js. Captured by the same Connect so one press covers both.
    sca: { token: got.token, exp: got.exp, user: got.user, roles: got.roles,
           accessToken: got.accessToken || "" }
  });
}

const scaSignIn      = () => sca.beginSignIn(scaCommit);
const scaDisconnect  = () => { saveConnections({ sca: null }); return { ok: true }; };

/* Type-ahead over SCA's site directory, for the move picker. */
const scaSites = term => sca.sites(scaToken(), term);

/* SCA's symptom catalogue, for the concern editor's type-ahead. Scoped by the
   model of the car being edited — see sca.symptoms(). */
const scaSymptoms = opts => sca.symptoms(scaToken(), opts);

/* The two writes on a concern. Both were captured off SCA's own UI rather
   than inferred, both check `success` and then re-read the record, and
   neither is `cancelActivity` — see the long notes in sca.js.

   Remove returns the line to outstanding work; the ticket is not closed. */
const scaRemoveActivity = opts => sca.removeActivity(scaToken(), opts);
const scaSetSymptom     = opts => sca.setSymptom(scaToken(), opts);

/* ── the Tesla OS token ──
   Second board-local credential, same arrangement as SCA and for the same
   reason; os.js has the write-up. lib.js stays the only writer of the file.

   ── why this one cannot be checked without a network call ──

   SCA's credential is a JWT: it states its own expiry, so scaConnected() is a
   pure function of the stored value. This one is opaque, so "have a token"
   and "have a session" are different questions and only the second one
   matters. osConnected() answers the cheap one for the dot; osStatus() asks
   the pipeline, briefly cached so polling the panel does not hammer it.

   The load-bearing guard is neither of those: os.js turns a 401 into
   `needsOs`, so a session that dies mid-scan surfaces as "connect again"
   rather than as a centre with nothing matched. */

function osSaved(){
  const s = loadConnections().os;
  return s && s.token ? s : null;
}

function osToken(){
  const s = osSaved();
  if(!s){
    const err = new Error("Not connected to Tesla OS — connect it in Admin › Sources");
    err.needsOs = true;
    throw err;
  }
  return s.token;
}

const osConnected = () => Boolean(osSaved());

/* Cached because the panel polls. Short enough that a session dying is
   noticed within a minute, long enough that the poll is free. */
let osProbe = { at: 0, live: false, who: null };
const OS_PROBE_MS = 60_000;

async function osStatus(){
  const s = osSaved();
  if(!s) return { connected: false, user: null, name: null, title: null };
  if(Date.now() - osProbe.at < OS_PROBE_MS){
    return { connected: osProbe.live, ...(osProbe.who || {}),
             user: s.user, name: s.name || null, title: s.title || null };
  }
  const who = await osx.authCheck(s.token).catch(() => null);
  osProbe = { at: Date.now(), live: Boolean(who && who.username), who: null };
  return { connected: osProbe.live,
           user : (who && who.username) || s.user || null,
           name : (who && who.name)     || s.name || null,
           title: (who && who.title)    || s.title || null };
}

function osCommit(got){
  osProbe = { at: 0, live: false, who: null };   // force a fresh probe
  return saveConnections({
    os: { token: got.token, user: got.user, name: got.name || "",
          title: got.title || "", capturedAt: new Date().toISOString() }
  });
}

const osSignIn     = () => osx.beginSignIn(osCommit);
const osDisconnect = () => {
  osProbe = { at: 0, live: false, who: null };
  saveConnections({ os: null });
  return { ok: true };
};

/* ── this centre's billing address ──

   Stored, not derived. Read back in the shape SCA's saveaddress wants, so the
   caller does not have to know that shape in two places.

   `stateName` doubles the code because that is what SCA's own call sends, and
   the lat/long are optional — the captured body carried them, but they are the
   map pin rather than the address, and an address typed by hand has none. */
function billingAddress(){
  const a = loadConnections().billingAddress;
  if(!a || !a.addressLine1) return null;
  return {
    addressID: 0,
    addressLine1: a.addressLine1 || "", addressLine2: a.addressLine2 || "",
    city: a.city || "", county: "",
    stateProvinceID: 0, stateCode: a.stateCode || "", stateName: a.stateCode || "",
    countryID: 0, countryCode: a.countryCode || "US", countryName: "United States",
    zip: a.zip || "",
    ...(a.latitude != null && a.longitude != null
      ? { latitude: Number(a.latitude), longitude: Number(a.longitude) } : {}),
    entityType: "PERSON"
  };
}

function saveBillingAddress(patch){
  const clean = {
    addressLine1: String(patch.addressLine1 || "").trim().slice(0, 120),
    addressLine2: String(patch.addressLine2 || "").trim().slice(0, 120),
    city        : String(patch.city || "").trim().slice(0, 80),
    stateCode   : String(patch.stateCode || "").trim().toUpperCase().slice(0, 3),
    zip         : String(patch.zip || "").trim().slice(0, 12),
    countryCode : String(patch.countryCode || "US").trim().toUpperCase().slice(0, 2)
  };
  // Clearing it is a legitimate act; a half-filled one is not.
  if(!clean.addressLine1 && !clean.city && !clean.zip){
    saveConnections({ billingAddress: null });
    return { saved: false, cleared: true };
  }
  for(const [k, label] of [["addressLine1", "street"], ["city", "city"],
                           ["stateCode", "state"], ["zip", "ZIP"]])
    if(!clean[k]) throw new Error(`The ${label} is required`);
  saveConnections({ billingAddress: clean });
  return { saved: true, cleared: false, billingAddress: clean };
}

/* ══════════════════════════ Teams ══════════════════════════

   A card in a Teams chat with an Update button on it, which reposts the VRI
   list when pressed.

   ── why the button is a link and not a Submit ──

   This board listens on 127.0.0.1. Teams runs in Microsoft's cloud and cannot
   reach it, so `Action.Submit` / `Action.Execute` — which post back to the
   flow, and would then need the flow to call in here — has nowhere to land
   without a public tunnel. `Action.OpenUrl` inverts it: the click happens in
   the operator's own browser, on the machine the board is running on, and the
   board does the outbound post itself. No inbound path from the internet
   exists at any point.

   The cost is honest and worth stating: a browser tab opens on the clicker's
   machine, and the button only does anything for somebody running the board.
   Everyone else in the chat can read the list and will get a tab that says so.

   ── the token ──

   The trigger is a GET, because that is what a link is, and any page the
   operator visits could fire a GET at localhost with an <img> tag. What that
   would achieve is a VRI list appearing in a team chat, which is noise rather
   than damage — but noise nobody can explain is its own problem, so the URL
   carries a token. Minted once, kept with the webhook, and rotated by saving
   the webhook again. */
const TEAMS_MAX_ROWS = 25;

/* ── operating hours ──

   The same idea as ZO-002's alert window, and the same vocabulary: a day list
   indexed by Date#getDay so the index IS the day number, and "HH:MM" strings
   because that is what <input type="time"> emits.

   One deliberate difference. ZO-002 fires ON THE HOUR, so its end hour is
   inclusive — 09:00–17:00 posts at 17:00. This runs on a minute interval, so
   17:00 has to mean *closed at* 17:00 or the centre stays open for an extra
   hour. End is exclusive here, and that is why the two files compare
   differently.

   Overnight windows are refused rather than half-supported: they would double
   the branch count in the one function that has to be provably right, and a
   delivery centre does not receive cars 20:00 → 02:00. Same call ZO-002 made. */
const HOURS_DEFAULTS = { start: "07:00", end: "19:00", days: [1, 2, 3, 4, 5] };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const normaliseTime = (v, fb) => (TIME_RE.test(String(v || "")) ? String(v) : fb);
const minutesOf = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));

function normaliseDays(v){
  if(!Array.isArray(v)) return HOURS_DEFAULTS.days.slice();
  const seen = new Set();
  for(const d of v){
    const n = Number(d);
    if(Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

function teamsHours(t){
  const c = t || loadConnections().teams || {};
  return {
    start: normaliseTime(c.openStart, HOURS_DEFAULTS.start),
    end  : normaliseTime(c.openEnd,   HOURS_DEFAULTS.end),
    days : normaliseDays(c.openDays),
    /* Off by default so nothing about this changes for a board that never
       opens the setting — the window only bites once somebody turns it on. */
    on   : c.hoursOn === true
  };
}

function isOpenNow(t, now = new Date()){
  const h = teamsHours(t);
  if(!h.on) return true;                       // no window set means always open
  if(!h.days.includes(now.getDay())) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= minutesOf(h.start) && m < minutesOf(h.end);
}

/* When the centre opens next, so a closed card can say so rather than leaving
   somebody to work it out. Walks forward a day at a time — seven iterations at
   worst, and no arithmetic that a month boundary or a clock change can break. */
function nextOpenAt(t, now = new Date()){
  const h = teamsHours(t);
  if(!h.on || !h.days.length) return null;
  const startMin = minutesOf(h.start);
  for(let i = 0; i < 8; i++){
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i,
                       Math.floor(startMin / 60), startMin % 60, 0, 0);
    if(!h.days.includes(d.getDay())) continue;
    if(d > now) return d;
  }
  return null;
}

function teamsConfig(){
  const t = loadConnections().teams;
  return t && t.webhook ? { webhook: t.webhook, token: t.token || "" } : null;
}

/* Both URLs are checked the same way, because both are places a vehicle list
   or a request for one travels to. */
function checkMicrosoftUrl(raw, what){
  let u;
  try { u = new URL(raw); } catch { throw new Error(`The ${what} is not a URL`); }
  if(u.protocol !== "https:") throw new Error(`The ${what} has to be https`);
  if(!/(^|\.)(logic\.azure\.com|azure\.com|office\.com|microsoft\.com|webhook\.office\.com|powerplatform\.com)$/i
       .test(u.hostname))
    throw new Error(`That host is not Microsoft's (${u.hostname}). ` +
                    `A Power Automate URL is issued on logic.azure.com or webhook.office.com.`);
  return u;
}

function saveTeamsSettings(patch){
  const cur = loadConnections().teams || {};
  const next = { ...cur };

  if("hoursOn" in patch) next.hoursOn = patch.hoursOn === true || patch.hoursOn === "true";
  if("openDays" in patch) next.openDays = normaliseDays(patch.openDays);
  for(const [k, label] of [["openStart", "opening time"], ["openEnd", "closing time"]]){
    if(!(k in patch)) continue;
    const v = String(patch[k] || "").trim();
    if(!TIME_RE.test(v)) throw new Error(`The ${label} must be HH:MM`);
    next[k] = v;
  }
  /* Validated against the MERGED settings, not the patch: a closing time saved
     on its own has to be checked against whatever opening time is already
     stored, or a two-field form becomes a way to persist an impossible
     window. Straight from ZO-002, which learned it the same way. */
  {
    const h = teamsHours(next);
    if(minutesOf(h.start) >= minutesOf(h.end))
      throw new Error(`Opening (${h.start}) has to be before closing (${h.end}). ` +
                      `An overnight window is not supported.`);
    if(next.hoursOn && !h.days.length)
      throw new Error("Pick at least one day, or turn operating hours off");
  }

  if("pushUrl" in patch){
    const raw = String(patch.pushUrl || "").trim();
    if(!raw) next.pushUrl = "";
    else { checkMicrosoftUrl(raw, "push URL"); next.pushUrl = raw; }
  }
  if("autoMinutes" in patch){
    const n = Number(patch.autoMinutes);
    if(!Number.isFinite(n) || n < 0 || n > 240)
      throw new Error("The refresh interval has to be between 0 and 240 minutes");
    next.autoMinutes = Math.round(n);
  }
  saveConnections({ teams: (next.webhook || next.pushUrl || next.autoMinutes) ? next : null });
  startTeamsLoop();
  return { ok: true, ...teamsSettings() };
}

function teamsSettings(){
  const t = loadConnections().teams || {};
  let host = "";
  try { host = t.webhook ? new URL(t.webhook).hostname : ""; } catch { host = "saved"; }
  /* The host of each, never the path. A webhook URL's path IS the credential,
     so it goes to the page once — when it is typed — and never comes back. The
     host is enough to see at a glance that the right thing is saved, which is
     the question somebody actually has when looking at this panel. */
  let pushHost = "";
  try { pushHost = t.pushUrl ? new URL(t.pushUrl).hostname : ""; }
  catch { pushHost = "saved"; }

  const h = teamsHours(t);
  return {
    host,
    pushHost,
    hasWebhook: Boolean(t.webhook),
    hasPush   : Boolean(t.pushUrl),
    autoMinutes: Number(t.autoMinutes) || 0,
    hoursOn  : h.on,
    openStart: h.start,
    openEnd  : h.end,
    openDays : h.days,
    openNow  : isOpenNow(t),
    dayNames : DAY_NAMES
  };
}

function saveTeamsWebhook(url){
  const raw = String(url || "").trim();
  if(!raw){
    saveConnections({ teams: null });
    stopTeamsLoop();
    return { saved: false, cleared: true };
  }
  /* Power Automate and the older Teams connector both hand out https URLs on
     Microsoft hosts. Refusing anything else keeps a mistyped address from
     quietly shipping a vehicle list to somebody's server. */
  const u = checkMicrosoftUrl(raw, "webhook");

  // Kept across a webhook change: the poll URL and the interval are separate
  // settings and re-typing them because the webhook moved would be a chore.
  const cur = loadConnections().teams || {};
  const token = crypto.randomBytes(16).toString("hex");
  saveConnections({ teams: { ...cur, webhook: raw, token } });
  startTeamsLoop();
  return { saved: true, cleared: false, host: u.hostname, token };
}

/* One outbound POST. Power Automate answers 202 with an empty body on the
   "When a Teams webhook request is received" trigger, and the older connector
   answers 200 with the string "1", so anything 2xx counts and the body is not
   read for meaning. */
function postToTeams(payload){
  const cfg = teamsConfig();
  if(!cfg) throw new Error("No Teams webhook saved — paste one under Admin › Teams");
  return postToUrl(cfg.webhook, payload);
}

function postToUrl(url, payload){
  const body = JSON.stringify(payload);
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json",
                 "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, status: res.statusCode });
        reject(new Error(`Teams answered HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
      });
    });
    req.on("error", err => reject(new Error("Could not reach Teams: " + (err.message || err.code))));
    req.write(body);
    req.end();
  });
}

/* Power Automate's "Post an interactive card" wants the card itself; the older
   connector wants it wrapped in an attachment. Sending the wrapped shape suits
   both — the flow reads `attachments[0].content` and the connector reads the
   envelope it already knows. */
const teamsEnvelope = card => ({
  type: "message",
  attachments: [{
    contentType: "application/vnd.microsoft.card.adaptive",
    contentUrl: null,
    content: card
  }]
});

/* ══════════════════════ SV Call — bring it onsite ══════════════════════

   A car with an open service visit sitting at the overflow lot is a car
   nobody at the centre can work on, and the person who notices is looking at
   this board rather than standing next to it. One press posts the VIN into a
   Teams chat with what needs doing.

   ── its own webhook, and its own key in the file ──

   Stored beside `teams` rather than inside it. The VRI-list webhook is
   cleared by saving an empty URL — `saveTeamsWebhook("")` sets `teams: null`
   and takes the poll URL and the interval with it — and this must not be
   collateral in that. They also go to different chats: a list of cars awaiting
   inspection is for whoever runs the lot, and this is for whoever drives it. */

function svCallConfig(){
  const url = loadConnections().svCallWebhook;
  return url ? { webhook: url } : null;
}

function svCallSettings(){
  const url = loadConnections().svCallWebhook || "";
  let host = "";
  // The host, never the path. A webhook URL's path IS the credential, which
  // is the same reason the VRI one only ever shows its host.
  try { host = url ? new URL(url).hostname : ""; } catch { host = "saved"; }
  return { has: Boolean(url), host };
}

function saveSvCallWebhook(url){
  const raw = String(url || "").trim();
  if(!raw){
    saveConnections({ svCallWebhook: "" });
    return { saved: false, cleared: true };
  }
  const u = checkMicrosoftUrl(raw, "SV Call webhook");
  saveConnections({ svCallWebhook: raw });
  return { saved: true, cleared: false, host: u.hostname };
}

/* ── the Follow Up webhook ──
   A third URL and a third key, apart from the other two for the reason they
   are apart from each other: clearing one must never take another with it.
   This one is posted to by the Follow Up button, which is what Check In turns
   into once somebody has walked the car. */
function followUpSettings(){
  const url = loadConnections().followUpWebhook || "";
  let host = "";
  try { host = url ? new URL(url).hostname : ""; } catch { host = "saved"; }
  return { has: Boolean(url), host };
}

function saveFollowUpWebhook(url){
  const raw = String(url || "").trim();
  if(!raw){
    saveConnections({ followUpWebhook: "" });
    return { saved: false, cleared: true };
  }
  const u = checkMicrosoftUrl(raw, "Follow Up webhook");
  saveConnections({ followUpWebhook: raw });
  return { saved: true, cleared: false, host: u.hostname };
}

/* Sent about a car somebody has already checked in, so the card says that and
   not much else — whoever reads it knows the car has been looked at and is
   being chased. The VIN is the headline for the same reason as the SV Call
   card: it is read on a phone, in a lot. */
async function sendFollowUp({ vin }){
  const url = loadConnections().followUpWebhook;
  if(!url)
    throw new Error("No Follow Up webhook saved — add one in Admin › Follow Up");
  if(!isVin(vin)) throw new Error(`${vin} is not a valid VIN`);

  /* Named from the board's own configured centre rather than from the row the
     press came from: a page left open since yesterday should not be able to
     put a stale centre on a card posted today. */
  const trt  = await trtInfo(loadConnections().trtId).catch(() => null);
  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard", version: "1.4",
    body: [
      { type: "TextBlock", text: "Follow up", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: vin, size: "Large", weight: "Bolder", wrap: true },
      { type: "TextBlock", wrap: true,
        text: `Checked in at ${(trt && (trt.full || trt.name)) || "this centre"} — ` +
              `following up on what it needs next.` }
    ]
  };
  await postToUrl(url, teamsEnvelope(card));
  return { ok: true, vin };
}

/* The message. Three facts and nothing else: which car, where it is, and what
   to do about it. A card that has to be read twice to find the VIN would be
   worse than a text message, and this one is read on a phone in a lot. */
function svCallCard({ vin, siteName, svNumbers, centreName }){
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard", version: "1.4",
    body: [
      { type: "TextBlock", text: "Bring this car onsite", weight: "Bolder",
        size: "Large", wrap: true },
      // The VIN large and on its own line: it is the one thing that gets
      // typed into something else afterwards.
      { type: "TextBlock", text: vin, size: "ExtraLarge", weight: "Bolder",
        spacing: "Small", wrap: true, fontType: "Monospace" },
      { type: "TextBlock", wrap: true, spacing: "Small",
        // "at the offsite lot (TRT 487417)" reads as a sentence; "at TRT
        // 487417" reads as a field somebody forgot to fill in.
        text: `It has an open service visit and it is at **${siteName}**.` },
      { type: "TextBlock", wrap: true, spacing: "None",
        text: "Please bring it onsite and check it in with service." },
      ...(svNumbers ? [{ type: "TextBlock", wrap: true, isSubtle: true, size: "Small",
        spacing: "Small", text: `${svNumbers}${centreName ? " · " + centreName : ""}` }] : [])
    ]
  };
}

/* Where Garage says the car is standing, read fresh.

   The page knows this already — it is on the row it drew the button on — but
   the page is a tab that may have been open since this morning, and a car
   that has since been driven onsite would send somebody out to fetch a car
   that is already here. Costs one indexed query, and it is also what names
   the lot in the message.

   Fails closed: anything it cannot confirm is a refusal, not a send. */
async function offsiteCheck(vin){
  const offsite = savedOffsiteTrtId();
  if(!offsite) return { ok: false, why: "no offsite lot is set in the TRT picker" };
  try{
    const page = await tesladexSearch({
      query : `vin:${vin}`,
      fields: ["vin", "trt_id", "vehicle_routing_location"],
      size  : 2
    });
    const rows = (page && page.results) || [];
    if(rows.length !== 1)
      return { ok: false, why: rows.length ? "matches more than one record in Garage"
                                           : "is not in the Garage index" };
    const trt = rows[0].trt_id;
    if(Number(trt) !== Number(offsite))
      return { ok: false, trtId: trt ?? null,
               why: trt == null ? "has no site on its Garage record"
                                : `is at TRT ${trt}, not the offsite lot` };
    return { ok: true, trtId: Number(trt) };
  }catch(err){
    return { ok: false, why: "could not be checked against Garage (" + err.message + ")" };
  }
}

/* The body-shop message. Same webhook, same chat, different ask — and this
   one leads with the work rather than the place, because the person reading
   it needs to know what the car is going over for. */
function bodyCallCard({ vin, concerns, svNumbers, centreName }){
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard", version: "1.4",
    body: [
      { type: "TextBlock", text: "Take this car to the body shop", weight: "Bolder",
        size: "Large", wrap: true },
      { type: "TextBlock", text: vin, size: "ExtraLarge", weight: "Bolder",
        spacing: "Small", wrap: true, fontType: "Monospace" },
      { type: "TextBlock", text: concerns.length === 1 ? "Concern" : "Concerns",
        weight: "Bolder", size: "Small", spacing: "Medium", wrap: true },
      // One line each. A comma-joined list of three symptoms is unreadable on
      // a phone, and this is read on a phone.
      ...concerns.map(c => ({ type: "TextBlock", wrap: true, spacing: "None",
                              text: "• " + c })),
      { type: "TextBlock", wrap: true, spacing: "Medium",
        text: "Please take the car to the body shop and check it in." },
      ...(svNumbers ? [{ type: "TextBlock", wrap: true, isSubtle: true, size: "Small",
        spacing: "Small", text: `${svNumbers}${centreName ? " · " + centreName : ""}` }] : [])
    ]
  };
}

/* ── what the car is actually in for ──

   Read from SCA at the moment the button is pressed, not taken from the row.
   The board can now edit a symptom and remove a line, so a tab open since the
   morning may be describing concerns that have since changed — and this
   message is somebody's instruction for a job.

   The courtesy line is left out by name, as asked: it is a standing
   inspection item on nearly every visit and it is not why a car goes to the
   body shop. */
const COURTESY_RE = /courtesy service provided/i;

async function concernsForBody(vin){
  if(!scaConnected())
    return { ok: false, why: "the Service App is not connected, so the board cannot name the concerns" };
  let got;
  try { got = await sca.ticketFor(scaToken(), vin); }
  catch(err){ return { ok: false, why: "the Service App did not answer (" + err.message + ")" }; }

  const visits = (got && got.open) || [];
  if(!visits.length) return { ok: false, why: "has no open service visit in the Service App" };

  const names = [], svNumbers = [];
  for(const v of visits){
    svNumbers.push(v.number);
    for(const a of v.activities || []){
      const text = a.symptom || a.narrative || "";
      if(!text || COURTESY_RE.test(text)) continue;
      if(!names.includes(text)) names.push(text);
    }
  }
  if(!names.length)
    return { ok: false, why: "has nothing on its visit but the courtesy line, so there is no concern to send" };

  return { ok: true, concerns: names, svNumbers: svNumbers.join(", "),
           centreName: (visits[0] && visits[0].location) || "" };
}

async function sendBodyCall({ vin }){
  const v = String(vin || "").trim().toUpperCase();
  if(!isVin(v)) throw new Error("A valid VIN is required");

  const cfg = svCallConfig();
  if(!cfg){
    const e = new Error("No SV Call webhook saved — paste one under Admin › Teams.");
    e.needsWebhook = true;
    throw e;
  }

  const c = await concernsForBody(v);
  if(!c.ok)
    throw new Error(`Not sending: ${v} ${c.why}. The message names the work, so the ` +
                    `board will not send one it cannot name.`);

  await postToUrl(cfg.webhook, teamsEnvelope(bodyCallCard({
    vin: v, concerns: c.concerns, svNumbers: c.svNumbers, centreName: c.centreName })));

  return { ok: true, vin: v, concerns: c.concerns };
}

/* One press: check, then post. */
async function sendSvCall({ vin, svNumbers, centreName }){
  const v = String(vin || "").trim().toUpperCase();
  if(!isVin(v)) throw new Error("A valid VIN is required");

  const cfg = svCallConfig();
  if(!cfg){
    const e = new Error("No SV Call webhook saved — paste one under Admin › Teams.");
    e.needsWebhook = true;
    throw e;
  }

  const at = await offsiteCheck(v);
  if(!at.ok)
    throw new Error(`Not sending: ${v} ${at.why}. The message says a car is at the ` +
                    `offsite lot, so the board checks that it still is.`);

  /* ── naming the lot ──

     The directory cannot name it, and that is not a gap to paper over: the
     offsite lot exists only in Garage. Intrepid has never heard of 487417 —
     not in `getLocations`, not in `getCogInventoryCars` — which is the same
     fact that stops the TRT picker finding it by name.

     So the message says "the offsite lot" and carries the number, rather than
     the bare "TRT 487417" a lookup miss would leave. The reader knows which
     lot; the number is there for whoever needs to type it somewhere. */
  const site = await trtInfo(at.trtId).catch(() => null);
  const siteName = (site && site.name)
    ? `${site.name} (TRT ${at.trtId})`
    : `the offsite lot (TRT ${at.trtId})`;

  await postToUrl(cfg.webhook, teamsEnvelope(
    svCallCard({ vin: v, siteName, svNumbers: svNumbers || "", centreName: centreName || "" })));

  return { ok: true, vin: v, siteName };
}

/* ── the Update button ──

   Always an Action.Submit, because the flow on the other end is always a
   "Post adaptive card and wait for a response". That action posts the card and
   PAUSES the run until somebody submits it, so a link button would leave it
   waiting forever.

   Measured off Ed's own tenant, this is the free path: the Teams connector is
   tier Standard and the trigger in front of it is `kind: TeamsWebhook`,
   neither of them premium. The press also happens inside Teams, so no browser
   opens on anybody's phone.

   Its one quirk suits this board rather than fighting it: a waiting run is
   consumed by the press, so a posted card is good for ONE press — and every
   refresh posts a NEW card with its own fresh wait, so the newest card in the
   chat is always the live one and older ones are visibly spent.

   An earlier version could also emit an Action.OpenUrl pointing either at a
   press-recording flow or at this board's own /vri/post. Both are gone: the
   first belonged to a polling design that needed a premium HTTP trigger, and
   the second could only ever be pressed by somebody sitting at this machine,
   which is the one person who does not need a card in a chat. */
const teamsAction = () => ({
  type: "Action.Submit", title: "Update",
  // Echoed back so a flow can tell this button from any other card it waits on.
  data: { action: "vri-update", board: "ZO-004" }
});

/* The standing card: a title and the button, no data. Posted once and left in
   the chat to be pressed. */
function teamsControlCard(siteName){
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard", version: "1.4",
    body: [
      { type: "TextBlock", text: "VRI List", weight: "Bolder", size: "Large", wrap: true },
      { type: "TextBlock", wrap: true, isSubtle: true, spacing: "None",
        text: `${siteName} · cars awaiting receiving inspection, on ground under 24 hours.` },
      { type: "TextBlock", wrap: true, isSubtle: true, size: "Small",
        text: "Update posts the current list below. It runs on the machine the " +
              "Compiler is on, so a tab will open there." }
    ],
    actions: [
      teamsAction()
    ]
  };
}

/* The list itself, posted as its own message so the standing card stays put.
   A FactSet per car rather than a table: Teams has no table element before
   Adaptive Cards 1.5, and a monospaced text block wraps badly on a phone. */
function teamsListCard(siteName, rows, stampedAt){
  const shown = rows.slice(0, TEAMS_MAX_ROWS);
  const body = [
    { type: "TextBlock", text: "VRI List", weight: "Bolder", size: "Large", wrap: true },
    { type: "TextBlock", wrap: true, isSubtle: true, spacing: "None",
      text: `${siteName} · ${rows.length} ${rows.length === 1 ? "car" : "cars"} ` +
            `awaiting VRI, on ground under 24h · ${stampedAt}` }
  ];

  if(!rows.length){
    body.push({ type: "TextBlock", wrap: true, spacing: "Medium",
                text: "**Nothing waiting.** No car has arrived in the last 24 hours " +
                      "that is still pending inspection." });
  }else{
    for(const r of shown){
      body.push({
        type: "Container", separator: true, spacing: "Small",
        items: [
          { type: "TextBlock", wrap: true, weight: "Bolder", spacing: "None",
            text: `${r.vin}${r.model ? ` · ${r.model}` : ""}` },
          { type: "TextBlock", wrap: true, isSubtle: true, size: "Small", spacing: "None",
            text: [r.bay ? `Bay ${r.bay}` : null,
                   r.dwell ? `on ground ${r.dwell}` : null,
                   r.soc != null ? `${r.soc}%` : null,
                   r.rn || null].filter(Boolean).join("  ·  ") || "—" }
        ]
      });
    }
    if(rows.length > shown.length){
      body.push({ type: "TextBlock", wrap: true, isSubtle: true, spacing: "Medium",
                  text: `…and ${rows.length - shown.length} more. The card shows the ` +
                        `first ${TEAMS_MAX_ROWS}; open the board for the rest.` });
    }
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard", version: "1.4",
    body,
    actions: [teamsAction()]
  };
}

/* Gather and post. Same call Cars on Ground makes — the VRI Pending rung and
   the 24-hour window are the tool's own facets, not a second definition of
   either. */
const stampNow = () => new Date().toLocaleString("en-US",
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function gatherVri(){
  const trtId = savedTrtId();
  if(!trtId){
    const err = new Error("No centre set — choose one in the board first");
    err.needsTrt = true;
    throw err;
  }
  const statuses = await cogStatuses();
  const pending = statuses.find(s => /receiving inspection pending/i.test(s.apiName));
  if(!pending) throw new Error("Intrepid has no Receiving Inspection Pending status on its ladder");

  const out = await carsOnGround({ trtId, statusIds: [pending.id], maxDwellHours: 24 });
  return { rows: out.rows, site: (await trtInfo(trtId) || {}).name || ("TRT " + trtId) };
}

async function postVriList(){
  const out = await gatherVri();
  await postToTeams(teamsEnvelope(teamsListCard(out.site, out.rows, stampNow())));
  // Keep the loop in step: a hand-posted list is the list the chat now shows,
  // so the interval must not immediately repost the same one.
  lastVinKey = vinKeyOf(out.rows);
  lastPostAt = Date.now();
  return { ok: true, site: out.site, count: out.rows.length,
           posted: Math.min(out.rows.length, TEAMS_MAX_ROWS) };
}

/* ══════════════ push ══════════════

   Ed's inversion, and it is the better shape: instead of the board answering a
   question from the cloud, it leaves the answer somewhere the cloud can already
   read. The board pushes the finished card into a SharePoint row every few
   minutes; the Update button's flow reads that row and posts it. Nothing has to
   reach inwards, and — the part that matters — **nothing in the chain is a
   premium connector**, which the polling design could not avoid.

   What it trades is freshness: the chat shows the last push rather than a scan
   taken at the moment of the press. At a three-minute interval that is three
   minutes of staleness on a queue where cars arrive far slower than that.

   The card is pushed **already rendered, as a string**. The flow then has one
   job — drop that text into a column — and the layout stays here, where it can
   be changed without anybody opening Power Automate. Sending the rows instead
   would move the card design into the flow and split it across two systems.

   The card carries an Action.Submit whatever the button mode says: the flow on
   the other end is a wait-for-response, and a link button would leave it
   waiting forever. */
function pushEnvelope(site, rows, stamp){
  const card = teamsListCard(site, rows, stamp);
  // Submit regardless of the configured mode — see above.
  card.actions = [{ type: "Action.Submit", title: "Update",
                    data: { action: "vri-update", board: "ZO-004" } }];
  return {
    card : JSON.stringify(card),
    count: rows.length,
    site,
    stamp,
    // The VINs on their own, for a flow that would rather build its own view
    // than take the rendered card.
    vins : rows.map(r => r.vin).join(", ")
  };
}

/* What sits in the row while the centre is shut.

   Pressing Update out of hours has to answer something. Leaving the last
   in-hours list there would be worse than saying nothing: it would look
   current, and somebody would walk out to a bay for a car that was inspected
   last night. So the row is overwritten once at closing with a card that says
   plainly it is not being kept up, and names when it will be again.

   It keeps the Update button. Pressing it re-posts this same card, which is
   the honest answer to "is there anything new" — no. */
function teamsClosedCard(site, reopen, last){
  const body = [
    { type: "TextBlock", text: "VRI List", weight: "Bolder", size: "Large", wrap: true },
    { type: "TextBlock", wrap: true, isSubtle: true, spacing: "None",
      text: `${site} · closed` },
    { type: "TextBlock", wrap: true, spacing: "Medium",
      text: "**Sorry, can't update — we're closed.** The list is not being " +
            "refreshed outside operating hours." }
  ];
  if(reopen){
    body.push({ type: "TextBlock", wrap: true, isSubtle: true, spacing: "Small",
      text: `Back ${reopen}.` });
  }
  if(last && last.count != null){
    body.push({ type: "TextBlock", wrap: true, isSubtle: true, size: "Small",
      spacing: "Small",
      text: `Last list before closing: ${last.count} ` +
            `${last.count === 1 ? "car" : "cars"} awaiting VRI.` });
  }
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard", version: "1.4",
    body,
    actions: [teamsAction()]
  };
}

async function pushClosedCard(){
  const t = loadConnections().teams || {};
  const trtId = savedTrtId();
  const site = trtId ? ((await trtInfo(trtId) || {}).name || ("TRT " + trtId)) : "This centre";
  const at = nextOpenAt(t);
  const reopen = at
    ? at.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })
    : null;
  const card = teamsClosedCard(site, reopen, lastPushInfo);
  await postToUrl(t.pushUrl, {
    card : JSON.stringify(card),
    count: 0, site, stamp: stampNow(), vins: "", closed: true
  });
  return { site, reopen };
}

async function pushVri(){
  const t = loadConnections().teams || {};
  if(!t.pushUrl) throw new Error("No push URL saved — paste one under Admin › Teams");
  const out = await gatherVri();
  const body = pushEnvelope(out.site, out.rows, stampNow());
  try{
    await postToUrl(t.pushUrl, body);
  }catch(err){
    /* Recorded before rethrowing. A failure that leaves no trace on the panel
       is worse than one that does: the countdown would keep ticking as though
       the row were being kept current. */
    lastPushInfo = { at: Date.now(), ok: false, error: err.message,
                     count: out.rows.length, site: out.site };
    lastPushAt = Date.now();   // don't retry every 15s against a dead endpoint
    throw err;
  }
  lastPushAt = Date.now();
  lastPushInfo = { at: lastPushAt, ok: true, count: out.rows.length,
                   site: out.site, bytes: body.card.length };
  return { ok: true, site: out.site, count: out.rows.length, bytes: body.card.length };
}

/* What the admin panel's countdown reads. Cheap on purpose — it is polled
   while somebody has the panel open, so it touches nothing but memory. */
function teamsStatus(){
  const t = loadConnections().teams || {};
  const every = Number(t.autoMinutes) || 0;
  const pushing = Boolean(teamsTimer && t.pushUrl && every);
  const posting = Boolean(teamsTimer && !t.pushUrl && t.webhook && every);

  /* Seconds remaining rather than a timestamp. The page and the board share a
     clock today — it is the same machine — but a countdown that would go wrong
     if that ever stopped being true is a countdown built on an assumption it
     does not need to make. */
  let nextInSec = null;
  if(pushing || posting){
    const since = pushing ? lastPushAt : lastPostAt;
    nextInSec = Math.max(0, Math.round((since + every * 60000 - Date.now()) / 1000));
  }

  /* Closed is reported separately from "not running": one is the centre being
     shut, the other is nothing being configured, and a panel that showed the
     same thing for both would send somebody hunting for a fault that is a
     Sunday. */
  const openNow = isOpenNow(t);
  const at = openNow ? null : nextOpenAt(t);

  return {
    running: Boolean(teamsTimer),
    pushing, posting, everyMin: every,
    nextInSec: openNow ? nextInSec : null,
    openNow,
    hoursOn: teamsHours(t).on,
    reopensAt: at ? at.toISOString() : null,
    reopens: at ? at.toLocaleString("en-US",
      { weekday: "short", hour: "numeric", minute: "2-digit" }) : null,
    busy: teamsBusy,
    last: lastPushInfo
  };
}

async function postVriControlCard(){
  const trtId = savedTrtId();
  const site = trtId ? ((await trtInfo(trtId) || {}).name || ("TRT " + trtId)) : "No centre set";
  await postToTeams(teamsEnvelope(teamsControlCard(site)));
  return { ok: true, site };
}

/* ══════════════ the live loop ══════════════

   Inspectors are on the lot with phones. They are not on the machine this
   board runs on, and they may not be on its network at all, so nothing they
   press can reach it. Every connection here is therefore made BY the board,
   outwards:

     press   phone → Flow A (cloud) → records that somebody asked
     poll    board → Flow B (cloud) → "has anybody asked?", and clears
     post    board → Flow A's webhook → the list appears in the chat

   No inbound path exists at any point, so no tunnel, no exposed port and no
   change to the 127.0.0.1 binding.

   ── the poll contract ──

   Flow B is Ed's to build; this only needs it to answer JSON. A refresh is
   taken to have been asked for when the body has a truthy `requested`, or a
   `pending` above zero. An `id` is honoured if one is sent: the same id twice
   running counts once, so a flow that fails to clear its own flag repeats a
   card instead of looping on it. Anything unparseable is treated as "nothing
   asked" and logged, because a broken poller must not post cards.

   ── why the auto-refresh only posts on a change ──

   Ed asked for both a button and a refresh. A card every few minutes whether
   or not anything moved would bury the chat, and a buried card is one nobody
   reads. So the interval gathers, and posts only when the set of VINs differs
   from the last one posted. A quiet lot produces no messages at all. A press
   always posts, because somebody asking is itself the reason. */

const TEAMS_POLL_MS = 15000;

let teamsTimer   = null;
let teamsBusy    = false;
let lastPushAt   = 0;
let lastPushInfo = null;   // outcome of the most recent push, for the panel
let closedPushed = false;  // the closed card is a transition, not a loop
let lastVinKey   = null;    // what the chat is currently showing
let lastPostAt   = 0;

/* The identity of a posted list: which cars, not how many. A card is worth
   reposting when the cars changed, and a count alone would miss one car
   arriving as another cleared. */
const vinKeyOf = rows => rows.map(r => r.vin).sort().join(",");

async function teamsTick(log = () => {}){
  const t = loadConnections().teams;
  if(!t || teamsBusy) return;
  if(!t.webhook && !t.pushUrl) return;
  teamsBusy = true;
  try{
    /* ── the push ──
       Independent of everything below it: this is not a message, it is a row
       being kept current, so it goes on every interval rather than only when
       the cars changed. A flow reading a row wants the row to be right, not to
       have to reason about when it was last worth writing. */
    const every = Number(t.autoMinutes) || 0;
    if(t.pushUrl && every > 0){
      const open = isOpenNow(t);

      /* Closed: the row is overwritten ONCE, then nothing runs until opening.
         Once, not every fifteen seconds — the flag is what makes this a
         transition rather than a loop, and it is cleared the moment the centre
         is open again so the next tick pushes a real list. */
      if(!open){
        if(!closedPushed){
          try{
            const c = await pushClosedCard();
            closedPushed = true;
            log(`teams: closed card pushed (${c.site})` +
                (c.reopen ? ` · back ${c.reopen}` : ""));
          }catch(err){
            log("teams: closed card failed — " + err.message);
            // Not latched on failure: try again next tick rather than leaving
            // an in-hours list sitting there all night.
          }
        }
      }else{
        closedPushed = false;
        if((Date.now() - lastPushAt) >= every * 60000){
          try{
            const p = await pushVri();
            log(`teams: pushed ${p.count} cars (${p.site}) · ${p.bytes} bytes of card`);
          }catch(err){
            log("teams: push failed — " + err.message);
          }
        }
      }
    }

    /* ── the timed repost, for a board with no push set up ──

       Straight to the chat rather than into a row. Only when there is no push
       URL: with one, the flow reading the row is what posts, and doing both
       would put two cards in the chat for every refresh.

       Unlike the push, this only fires when the cars have changed. A row is
       something to keep right; a message is something not to send twice. */
    if(!t.webhook || t.pushUrl) return;

    const due = every > 0 && (Date.now() - lastPostAt) >= every * 60000;
    if(!due) return;

    const out = await gatherVri();
    const key = vinKeyOf(out.rows);
    if(key === lastVinKey){ lastPostAt = Date.now(); return; }

    await postToTeams(teamsEnvelope(teamsListCard(out.site, out.rows, stampNow())));
    lastVinKey = key;
    lastPostAt = Date.now();
    log(`teams: VRI list posted · ${out.rows.length} cars (${out.site}) · changed`);
  }catch(err){
    log("teams: " + err.message);
  }finally{
    teamsBusy = false;
  }
}

function startTeamsLoop(log){
  stopTeamsLoop();
  const t = loadConnections().teams;
  /* Something to do means a row to keep pushed, or a timed repost to the chat.
     Either way it needs an interval — a webhook on its own is a board that
     posts only when somebody presses a button in the admin panel. */
  const t2 = t || {};
  if(!Number(t2.autoMinutes) || !(t2.pushUrl || t2.webhook)) return;
  // unref so a configured board still exits cleanly on Ctrl-C.
  teamsTimer = setInterval(() => teamsTick(log), TEAMS_POLL_MS);
  if(teamsTimer.unref) teamsTimer.unref();
}

function stopTeamsLoop(){
  if(teamsTimer) clearInterval(teamsTimer);
  teamsTimer = null;
}

/* Who is on a visit right now. Two reads, only ever on a row somebody has
   opened.

   This DOES return the email and phone. An earlier version withheld them on
   privacy grounds, which was the wrong call for the job: you cannot judge
   whether a contact needs changing, or type a replacement, without seeing what
   is there. It is the same data the operator is looking at in SCA on the next
   monitor. It stays out of exports and off the scan payload — only a row
   somebody deliberately opened fetches it. */
async function scaContacts(vin, serviceVisitId){
  const token = scaToken();
  const svid  = Number(serviceVisitId);
  // sca.isTeslaContact, not a second copy of the rule — the panel and the
  // guard that refuses a redundant switch must agree about what "Tesla" means.
  const shape = c => {
    const x = (c && c.contacts) || null;
    return {
      has      : Boolean(x),
      firstName: (x && x.firstName) || "",
      lastName : (x && x.lastName)  || "",
      email    : (x && x.email)     || "",
      phone    : (x && x.phoneNumber) || "",
      tesla    : Boolean(x && sca.isTeslaContact(x))
    };
  };

  const [main, billing, addr] = await Promise.all([
    sca.contactOnVisit(token, svid, 1),
    sca.contactOnVisit(token, svid, 2),
    sca.addressOnVisit(token, svid, 2)
  ]);
  /* The address comes back either bare or wrapped in `address` depending on
     the call; both shapes have been seen, so both are accepted. */
  const a = (addr && (addr.address || addr)) || null;
  return {
    main: shape(main), billing: shape(billing),
    address: a && a.addressLine1 ? {
      has: true,
      addressLine1: a.addressLine1 || "", addressLine2: a.addressLine2 || "",
      city: a.city || "", stateCode: a.stateCode || a.stateName || "",
      zip: a.zip || "", countryCode: a.countryCode || "US"
    } : { has: false }
  };
}

/* ── set the billing address on one visit ──

   Admin › My location is the default for the Tesla switch; this is the same
   write with an address typed on the row, for the cars that need a different
   one. Same gate: pre-delivery only. */
async function scaSetAddress({ vin, serviceVisitId, address }){
  const token = scaToken();
  const svid  = Number(serviceVisitId);

  const line1 = String(address.addressLine1 || "").trim();
  const city  = String(address.city || "").trim();
  const state = String(address.stateCode || "").trim().toUpperCase();
  const zip   = String(address.zip || "").trim();
  for(const [v, label] of [[line1, "street"], [city, "city"], [state, "state"], [zip, "ZIP"]])
    if(!v) throw new Error(`The ${label} is required`);

  const onVin = (await sca.visitsByVin(token, vin)).some(v => v.serviceVisitID === svid);
  if(!onVin) throw new Error("That visit is not on this VIN — nothing was changed");

  const visit = await sca.visitById(token, svid);
  if(!visit || !sca.isOpenVisit(visit))
    throw new Error("That visit is closed. The board only works on open tickets — nothing was changed");

  const und = await isUndelivered(vin);
  if(!und.ok)
    throw new Error(`Refusing to change the billing address: ${vin} ${und.why}. ` +
      `This is a pre-delivery action only. Nothing was changed.`);

  const uid = visit.userId ?? visit.userID;
  const asset = uid ? await sca.carAsset(token, uid, vin, svid) : { asset: null, assetId: null };

  const res = await sca.saveAddress(token, svid, 2, {
    addressID: 0, addressLine1: line1,
    addressLine2: String(address.addressLine2 || "").trim(),
    city, county: "", stateProvinceID: 0, stateCode: state, stateName: state,
    countryID: 0, countryCode: String(address.countryCode || "US").trim().toUpperCase(),
    countryName: "United States", zip, entityType: "PERSON"
  }, asset);

  const back = await sca.addressOnVisit(token, svid, 2);
  const got  = (back && (back.address || back)) || {};
  if(String(got.addressLine1 || "").trim().toLowerCase() !== line1.toLowerCase())
    throw new Error(res.message && res.message !== "Success"
      ? res.message : "The Service App did not change the billing address");

  return { ok: true, now: [line1, city, state, zip].filter(Boolean).join(", ") };
}

/* ── set a contact by hand ──

   The escape hatch beside the Tesla button: sometimes the right contact is
   neither the customer on file nor Tesla, and somebody has to type it.

   `contactID: 0` means "a new contact" — inferred from the sibling
   `saveaddress` call, whose captured body uses `addressID: 0` for a new
   address. That is the one part of this not lifted from a recording, so the
   read-back below is what proves it rather than the 200.

   Same gate as the Tesla switch. Editing the contact on a delivered car's
   visit is not this board's business. */
async function scaSetContact({ vin, serviceVisitId, contactType, contact }){
  const token = scaToken();
  const svid  = Number(serviceVisitId);
  const type  = Number(contactType) === 2 ? 2 : 1;

  const first = String(contact.firstName || "").trim();
  const last  = String(contact.lastName  || "").trim();
  const email = String(contact.email     || "").trim();
  const phone = String(contact.phone     || "").trim();
  if(!first && !last) throw new Error("A name is required");
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("That email does not look like an address");

  const onVin = (await sca.visitsByVin(token, vin)).some(v => v.serviceVisitID === svid);
  if(!onVin) throw new Error("That visit is not on this VIN — nothing was changed");

  const visit = await sca.visitById(token, svid);
  if(!visit || !sca.isOpenVisit(visit))
    throw new Error("That visit is closed. The board only works on open tickets — nothing was changed");

  const und = await isUndelivered(vin);
  if(!und.ok)
    throw new Error(`Refusing to change the contact: ${vin} ${und.why}. ` +
      `This is a pre-delivery action only. Nothing was changed.`);

  const openBefore = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);

  const res = await sca.saveContact(token, svid, type, {
    contactID: 0, firstName: first, lastName: last,
    email, phoneNumber: phone, preferredLanguage: "en_US"
  });

  const after = await sca.contactOnVisit(token, svid, type);
  const got = (after && after.contacts) || null;
  const same = got &&
    String(got.firstName || "").trim() === first &&
    String(got.lastName  || "").trim() === last;
  if(!same)
    throw new Error(res.message && res.message !== "Success"
      ? res.message : "The Service App did not change the contact");

  const openAfter = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);
  return {
    ok: true,
    now: `${got.firstName || ""} ${got.lastName || ""}`.trim(),
    ticketsIntact: openBefore.length === openAfter.length &&
      openBefore.every(([id, st]) => (openAfter.find(([i]) => i === id) || [])[1] === st)
  };
}

/* ── switch the main contact to Tesla ──

   A pre-delivery car normally arrives with the customer as the main contact
   (contactType 1) and Tesla Motors Inventory already on billing (2). Putting
   Tesla on the main one is a job done by hand on every inventory car, so it
   gets a button.

   **Pre-delivery only, and that is the point of the whole feature.** Ed's
   words: it is not available for delivered cars, "aka cars we're not supposed
   to mess with". Swapping a delivered customer's contact off their own service
   visit would be wrong in an obvious and embarrassing way. Same fresh-Garage,
   fails-closed check the appointment cancel uses.

   ── the contact is read off the car, and that is what makes this portable ──

   Never hardcoded, and deliberately not configurable either. Every car is
   already carrying its own region's inventory contact, so a board at any
   centre in the world writes the right record without being told what it is —
   North America's here, somebody else's there.

   A configured setting was built for this and thrown away, which is worth
   recording so it is not built again. It could not be filled in: SCA's
   customer directory holds CUSTOMERS, and the inventory record is not one, so
   searching "Tesla Motors North America" returns nothing. The only place the
   record exists is the car's own contact list — where this already reads it.

   It varies between cars even within one lot: "Tesla Motors / Inventory" with
   teslamotorsnorthamerica@tesla.com / +16506817000 on one, "Tesla / Motors
   Inventory" with …@noemailonfile.tesla.com / +1650-681-9999 on another.
   Reading per car gets each one right; one saved record would have imposed
   whichever variant happened to be picked. See teslaContactIn(). */
async function scaSwitchContactToTesla({ vin, serviceVisitId }){
  const token = scaToken();
  const svid  = Number(serviceVisitId);

  const onVin = (await sca.visitsByVin(token, vin)).some(v => v.serviceVisitID === svid);
  if(!onVin) throw new Error("That visit is not on this VIN — nothing was changed");

  const visit = await sca.visitById(token, svid);
  if(!visit || visit.serviceVisitID !== svid)
    throw new Error("Could not read that visit — nothing was changed");
  if(!sca.isOpenVisit(visit))
    throw new Error("That visit is closed. The board only works on open tickets — nothing was changed");

  const und = await isUndelivered(vin);
  if(!und.ok)
    throw new Error(`Refusing to switch the contact: ${vin} ${und.why}. ` +
      `This is a pre-delivery action only — a delivered car's contact is the ` +
      `customer's own. Nothing was changed.`);

  const uid = visit.userId ?? visit.userID;
  if(!uid) throw new Error("That visit carries no account id, so its contacts cannot be listed");

  const list  = await sca.contactsForCar(token, uid, vin);
  const tesla = sca.teslaContactIn(list);
  if(!tesla)
    throw new Error("No Tesla contact on this car's contact list — nothing to switch to. " +
                    "Add it in the Service App first.");

  /* ── identity is the email domain, NOT the contactID ──

     Saving a contact onto a visit does not reference the picker's record: SCA
     copies it and mints a new contactID. Measured on this very car — the
     picker lists Tesla as 64031153 while the visit carries 64598205 for the
     same contact. Comparing ids therefore never matches after a save, and an
     earlier version of this fell straight through the "already Tesla" guard
     and re-saved a contact that was already correct. */
  const [before, beforeBilling] = await Promise.all([
    sca.contactOnVisit(token, svid, 1),
    sca.contactOnVisit(token, svid, 2)
  ]);
  const wasName = before && before.contacts
    ? `${before.contacts.firstName || ""} ${before.contacts.lastName || ""}`.trim() : "";

  /* ── both types, and refuse only when both are already right ──

     Main (1) and billing (2) get the same record. Putting Tesla on the main
     contact and leaving the customer as the payer was never the intent.

     The old guard looked at the main contact alone and refused if it was
     already Tesla — which locked out exactly the car this exists to fix, the
     one that arrives with Tesla on main and the customer still on billing. */
  const mainDone    = Boolean(before && before.contacts && sca.isTeslaContact(before.contacts));
  const billingDone = Boolean(beforeBilling && beforeBilling.contacts &&
                              sca.isTeslaContact(beforeBilling.contacts));
  if(mainDone && billingDone)
    throw new Error(`The main and billing contacts are both already ` +
                    `${wasName || "Tesla"} — nothing to do`);

  const openBefore = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);

  /* One call per type, and only for the types that need it. Serial rather than
     parallel: they are two writes to the same visit, and SCA has not been
     shown to be safe with both at once. */
  let res = null;
  const wrote = [];
  for(const [type, done] of [[1, mainDone], [2, billingDone]]){
    if(done) continue;
    res = await sca.saveContact(token, svid, type, tesla);
    wrote.push(type);
  }

  /* Never the response — read it back. Same rule as every other SCA write on
     this board, and the one that caught a 200/success:false earlier.

     Verified on the email domain for the reason above: the id it comes back
     with is a fresh one, so an id comparison here would fail on a write that
     actually worked. */
  const [after, afterBilling] = await Promise.all([
    sca.contactOnVisit(token, svid, 1),
    sca.contactOnVisit(token, svid, 2)
  ]);
  const stuck = t => {
    const c = (t === 1 ? after : afterBilling);
    return Boolean(c && c.contacts && sca.isTeslaContact(c.contacts));
  };
  const failed = wrote.filter(t => !stuck(t));
  if(failed.length)
    throw new Error(res && res.message && res.message !== "Success" ? res.message
      : `The Service App did not change the ${failed.includes(1) ? "main" : "billing"} contact`);

  /* ── and the billing address ──

     Switching the contact to Tesla means the bill goes to the centre, so the
     centre's address goes with it. It is a configured setting rather than
     something derived: every centre has a different one, and a board pointed
     somewhere else must not inherit Cypress's. Admin › My location.

     Skipped, not failed, when unset — the contact switch is the point and it
     has already succeeded by here. The caller is told which happened. */
  let addressSet = false, addressNote = "";
  const addr = billingAddress();
  if(!addr){
    addressNote = "No billing address configured — set one in Admin › My location.";
  }else{
    try{
      const asset = await sca.carAsset(token, uid, vin, svid);
      const ar = await sca.saveAddress(token, svid, 2, addr, asset);
      const back = await sca.addressOnVisit(token, svid, 2);
      const line = back && (back.address ? back.address.addressLine1 : back.addressLine1);
      addressSet = Boolean(ar.ok && line &&
        String(line).trim().toLowerCase() === addr.addressLine1.trim().toLowerCase());
      if(!addressSet) addressNote = ar.message && ar.message !== "Success"
        ? `Billing address not set — ${ar.message}` : "Billing address did not take.";
    }catch(err){
      addressNote = "Billing address not set — " + err.message;
    }
  }

  const openAfter = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);
  const ticketsIntact =
    openBefore.length === openAfter.length &&
    openBefore.every(([id, st]) => (openAfter.find(([i]) => i === id) || [])[1] === st);

  return {
    ok: true,
    was: wasName,
    now: `${tesla.firstName || ""} ${tesla.lastName || ""}`.trim(),
    // Which types were actually written, so the row can say "main and billing"
    // or "billing only" rather than leaving it to be guessed.
    wrote,
    addressSet, addressNote,
    ticketsIntact
  };
}

/* ── cancel the appointment, and nothing else ──

   Same two calls as a move, minus the location swap: TSS releases the slot,
   then the visit is written back with its dates nulled. The second half is not
   optional — `CancelAppointment` on its own answers `success:true` and leaves
   the booking showing in SCA, which was measured before this was built.

   Every rule the move obeys applies here, because this IS the cancel half of
   it: undelivered cars only, open visits only, the ticket never touched. */
async function scaCancelAppointment({ vin, serviceVisitId }){
  const token = scaToken();
  const svid  = Number(serviceVisitId);
  const saved = scaSaved() || {};

  const onVin = (await sca.visitsByVin(token, vin)).some(v => v.serviceVisitID === svid);
  if(!onVin) throw new Error("That visit is not on this VIN — nothing was changed");

  const before = await sca.visitById(token, svid);
  if(!before || before.serviceVisitID !== svid)
    throw new Error("Could not read that visit — nothing was changed");
  if(!sca.isOpenVisit(before))
    throw new Error("That visit is closed. The board only works on open tickets — nothing was changed");
  if(before.appointmentID == null && !before.serviceVisitDateTime)
    throw new Error("There is no appointment on this visit — nothing to cancel");

  const und = await isUndelivered(vin);
  if(!und.ok)
    throw new Error(`Refusing to cancel the appointment: ${vin} ${und.why}. ` +
      `Appointments are only cancellable on undelivered cars, so a customer's booking ` +
      `cannot be cancelled from this board. Nothing was changed.`);

  const openBefore = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);

  if(before.appointmentID != null){
    if(!saved.accessToken)
      throw new Error("Connect SCA again — the credential the scheduler needs was not captured. " +
                      "Admin › Sources › Connect.");
    const c = await sca.cancelAppointment(saved.accessToken, before.appointmentID, svid);
    if(!c.ok)
      throw new Error(`Could not cancel the appointment${c.message ? ` — ${c.message}` : ""}. ` +
                      `Nothing else was attempted.`);
  }

  // dest null: clear the dates, leave the centre exactly where it is.
  const res = await sca.moveVisitFull(token, before, null);

  const after = await sca.visitById(token, svid);
  const cleared = Boolean(after && after.serviceVisitDateTime == null && after.appointmentID == null);

  const openAfter = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);
  const ticketsIntact =
    openBefore.length === openAfter.length &&
    openBefore.every(([id, st]) => (openAfter.find(([i]) => i === id) || [])[1] === st);

  const sideEffects = [];
  if(after && before.carWash !== after.carWash) sideEffects.push("car wash");
  if(after && before.charge  !== after.charge)  sideEffects.push("charge");
  /* The centre must NOT have moved. This call has no business changing it, so
     a change here means the PUT did something unasked and is worth shouting
     about rather than discovering later. */
  if(after && Number(before.scaLocationID) !== Number(after.scaLocationID))
    sideEffects.push("service centre");

  if(!cleared) throw new Error(res.message || "The Service App did not clear the appointment");

  return { ok: true, was: before.serviceVisitDateTime || null,
           at: (after && after.locationDescription) || "", ticketsIntact, sideEffects };
}

/* ── is this visit movable right now? ──

   Read fresh, for the panel to poll after somebody cancels an appointment in
   SCA. The board does not cancel appointments itself — see the note on
   scaMoveVisit — so this is how it notices that the obstacle has gone without
   making the user re-run a whole scan.

   Cheap: one call, and only ever on a row somebody has opened. */
async function scaVisitState(vin, serviceVisitId){
  const svid = Number(serviceVisitId);
  const v = (await sca.visitsByVin(scaToken(), vin)).find(x => x.serviceVisitID === svid);
  if(!v) return { found: false };
  return {
    found        : true,
    open         : sca.isOpenVisit(v),
    appointmentId: v.appointmentID ?? null,
    bookedFor    : v.serviceVisitDateTime || null,
    location     : v.locationDescription || "",
    scaLocationId: v.scaLocationID ?? null,
    // Movable is the question the panel is really asking, answered once here
    // rather than reassembled from three fields in the page.
    movable      : sca.isOpenVisit(v) && v.appointmentID == null
  };
}

/* ── is this car still undelivered? ──

   The safeguard on cancelling an appointment, and the reason it is a fresh
   read rather than a field off the row: the page could be an hour old, or a
   tab someone left open yesterday, and the whole point of the rule is that a
   real customer's booking is never cancelled. A stale `delivered:false` is
   exactly the input that would do it.

   Asked of Garage, which owns the answer, at the moment of the write.

   **Fails closed.** A lookup that errors, finds nothing, or finds more than
   one car for a VIN returns false — not-known reads as not-allowed. The one
   thing this must never do is let a delivered car through because a query
   timed out. */
async function isUndelivered(vin){
  try{
    const page = await tesladexSearch({
      query : `vin:${vin}`,
      fields: ["vin", "delivered", "delivery_date_epoch"],
      size  : 2
    });
    const rows = (page && page.results) || [];
    if(rows.length !== 1) return { ok: false, why: rows.length ? "matches more than one record" : "is not in the Garage index" };
    const r = rows[0];
    // Explicitly false, not merely falsy: a missing field is not a promise.
    if(r.delivered === false) return { ok: true };
    return { ok: false, why: r.delivered === true ? "is already delivered" : "has no delivery state in Garage" };
  }catch(err){
    return { ok: false, why: "could not be checked against Garage (" + err.message + ")" };
  }
}

/* ── move a visit to another service centre ──

   Everything about which endpoint and why is in sca.js. What lives HERE is
   the refusal to do it on the wrong record, because the checks need a read
   the caller should not have to remember to make:

     - the visit must exist on that VIN, so a mistyped id cannot move a
       stranger's car
     - it must be OPEN. Ed's standing rule is that the board only ever works
       on open tickets
     - it must be UNSCHEDULED. A booked visit is refused by SCA anyway, but
       refusing here means the board can say why instead of relaying an error
     - it must actually be somewhere else, so a no-op does not read as a move

   And afterwards the visit is re-read: `success:true` is SCA's claim, and the
   only evidence worth reporting is the record itself. */
async function scaMoveVisit({ vin, serviceVisitId, dest }){
  const token = scaToken();
  const svid  = Number(serviceVisitId);
  const saved = scaSaved() || {};

  /* The whole visit, in the shape the PUT expects — this read is the body's
     only source. Cross-checked against the VIN so a mistyped id cannot move
     somebody else's car. */
  const onVin = (await sca.visitsByVin(token, vin)).some(v => v.serviceVisitID === svid);
  if(!onVin) throw new Error("That visit is not on this VIN — nothing was changed");

  const before = await sca.visitById(token, svid);
  if(!before || before.serviceVisitID !== svid)
    throw new Error("Could not read that visit — nothing was changed");
  if(!sca.isOpenVisit(before))
    throw new Error("That visit is closed. The board only works on open tickets — nothing was changed");
  if(Number(before.scaLocationID) === Number(dest.scaLocationId))
    throw new Error(`Already at ${before.locationDescription || "that centre"} — nothing to do`);

  const openBefore = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);
  if(!openBefore.length)
    throw new Error("That visit has no open ticket — nothing was changed");

  /* ── the appointment, if there is one ──
     TSS first, then the PUT clears the date. A failure here stops everything:
     better a visit that did not move than a booking cancelled for nothing. */
  let cancelled = false;
  if(before.appointmentID != null){
    /* ── the safeguard, and it gates the CANCEL specifically ──

       Ed's rule: only undelivered cars. An undelivered car's appointment
       belongs to Tesla; a delivered one's belongs to a customer who arranged
       their day around it. Moving a car with no booking is harmless either
       way, so this sits inside the appointment branch rather than at the door.

       A fresh read from Garage, never a field off the request — a stale tab's
       `delivered:false` is exactly the input that would cancel a real booking
       — and it fails closed on anything it cannot confirm.

       This was briefly lost when the earlier cancel-and-move was deleted. It
       is not optional and it does not move again. */
    const und = await isUndelivered(vin);
    if(!und.ok)
      throw new Error(`Refusing to cancel the appointment: ${vin} ${und.why}. ` +
        `Appointments are only cancellable on undelivered cars, so a customer's booking ` +
        `cannot be cancelled from this board. Nothing was changed.`);

    if(!saved.accessToken)
      throw new Error("Connect SCA again — the credential the scheduler needs was not captured. " +
                      "Admin › Sources › Connect.");
    const c = await sca.cancelAppointment(saved.accessToken, before.appointmentID, svid);
    if(!c.ok)
      throw new Error(`Could not cancel the appointment${c.message ? ` — ${c.message}` : ""}. ` +
                      `Nothing else was attempted.`);
    cancelled = true;
  }

  const res = await sca.moveVisitFull(token, before, dest);

  const after = await sca.visitById(token, svid);
  const moved = Boolean(after && Number(after.scaLocationID) === Number(dest.scaLocationId));

  /* The ticket must come through untouched. It follows the visit to the new
     location, which is expected and fine; its STATUS changing would not be,
     and that is the thing that would disturb billing. */
  const openAfter = (await sca.activitiesOf(token, svid))
    .map(a => [a.activityID, a.activityStatusID]);
  const ticketsIntact =
    openBefore.length === openAfter.length &&
    openBefore.every(([id, st]) => (openAfter.find(([i]) => i === id) || [])[1] === st);

  /* Two things the PUT could disturb that nothing here asked it to. SCA's own
     dialog gets these wrong — it flips them true out of its form defaults —
     so they are watched rather than assumed. */
  const sideEffects = [];
  if(after && before.carWash !== after.carWash) sideEffects.push("car wash");
  if(after && before.charge  !== after.charge)  sideEffects.push("charge");

  if(!moved){
    const e = new Error((res.message || "The Service App did not move the visit") +
      (cancelled ? " — but the appointment was already cancelled, so this visit is now unbooked "
                 + "and still at its old centre." : ""));
    e.partial = cancelled;
    throw e;
  }
  return {
    ok: true, cancelled,
    from: before.locationDescription || "",
    to  : (after && after.locationDescription) || "",
    scaLocationId: after && after.scaLocationID,
    trtId        : after && after.trtid,
    ticketsIntact,
    sideEffects
  };
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
      // The port comes from the URL. It was pinned to 443, which is right for
      // every Tesla host here and wrong the moment a URL carries its own port
      // — the request went to 443 and failed with a refused connection that
      // looked like the host being down.
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    /* Node's connection errors are sometimes an AggregateError whose message
       is the empty string, which surfaces in the UI as a blank failure. The
       code is always there, so it stands in. */
    req.on("error", err => {
      if(!err.message) err.message = err.code ? `${err.code} — ${u.hostname}:${u.port || 443}`
                                              : "connection failed";
      reject(err);
    });
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
  // Hub first, own file second — see credstore.js for why that way round.
  const raw = credstore.intrepidCookie(
    (loadConnections().intrepidCookie || "").trim()).value.trim();
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
  /* An empty 200 is Intrepid saying "none", not a failure.

     `getScaServiceVisitByVin` answers zero bytes for a car with no open visit
     — about one car in ten at Cypress — and parsing that as an error made
     every one of them look like a call that had gone wrong. It reached the
     right answer only because the caller swallowed the throw and read the
     absence as "no visits", which meant a real failure, a cookie dying
     mid-scan, was indistinguishable from a clean car. Now the two are. */
  if(!res.body.trim()) return null;
  try { return JSON.parse(res.body); }
  catch { throw new Error("Intrepid did not return JSON — the cookie may be a sign-in redirect"); }
}

/* Same again for the handful of Intrepid endpoints that take a body. Kept
   next to intrepidGet rather than folded into it: the two differ only in the
   method, but a single function taking an optional body reads worse at every
   call site than two that each say what they do. */
async function intrepidPost(pathAndQuery, payload, base = INTREPID){
  const body = JSON.stringify(payload == null ? {} : payload);
  const res = await request(base + pathAndQuery, {
    method : "POST",
    headers: { Cookie: intrepidCookie(), Accept: "application/json",
               "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) },
    body
  });
  if(res.status === 401){
    const err = new Error("Intrepid cookie expired or rejected — paste a fresh one");
    err.needsCookie = true;
    throw err;
  }
  if(res.status !== 200){
    throw new Error(`Intrepid HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  /* An empty 200 is Intrepid saying "none", not a failure.

     `getScaServiceVisitByVin` answers zero bytes for a car with no open visit
     — about one car in ten at Cypress — and parsing that as an error made
     every one of them look like a call that had gone wrong. It reached the
     right answer only because the caller swallowed the throw and read the
     absence as "no visits", which meant a real failure, a cookie dying
     mid-scan, was indistinguishable from a clean car. Now the two are. */
  if(!res.body.trim()) return null;
  try { return JSON.parse(res.body); }
  catch { throw new Error("Intrepid did not return JSON — the cookie may be a sign-in redirect"); }
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

/* ── delivery advisor for a reference number ──
   The advisor owns the appointment. It is NOT the delivery host
   (`DriverADUserName`, the person who ran the handover) — [[fsd-tracker]]
   measured the two differing on 24 of 70 appointments, so they must not be
   used interchangeably. This returns the advisor and nothing else, because
   the advisor is the only person this board is being asked about.

   The display name comes back paired with the username, so no directory
   lookup is needed — unlike the host, which arrives as a bare AD username.

   The same payload carries a Drivers block with customer name, email and
   phone. That is PII and is deliberately never read here.

   A car with no appointment has no advisor, and that is an ordinary answer
   rather than a failure: "" all the way out, so the column reads blank.  */
async function appointmentAdvisor(rn){
  if(!rn) return "";
  const d = await intrepidGet(`/getDeliveryAppointmentDetails?rn=${encodeURIComponent(rn)}`);
  const rec = (d && d.Data && d.Data[0]) || null;
  if(!rec) return "";
  return (rec.DeliveryAdvisorDisplayName || "").trim()
      || (rec.DeliveryAdvisorUserName || "").trim();
}

/* One call per distinct RN, pooled — a full lot is hundreds of cars, and
   opening a socket per row is how a centre-wide export turns into a stall.
   Deduped first: the same RN on two rows is one appointment.

   A lookup that fails is left blank rather than aborting the export. The
   whole file should not be lost because one appointment 500s — except on a
   dead cookie, which fails every row and is worth saying out loud. */
async function advisorsByRn(rns, concurrency = 8){
  const list = [...new Set((rns || []).filter(Boolean).map(String))];
  const out = new Map();
  if(!list.length) return out;

  let authErr = null;
  const got = await pool(list, concurrency, async rn => {
    try { return await appointmentAdvisor(rn); }
    catch(err){
      if(err.needsCookie) authErr = err;
      return "";
    }
  });
  if(authErr) throw authErr;

  list.forEach((rn, i) => {
    const v = got[i];
    // pool() reports a thrown item as {error}, which is not a name.
    out.set(rn, typeof v === "string" ? v : "");
  });
  return out;
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

/* Names for a set of TRTs, in one pass over the cached directory.

   ── why the name does not come from Garage ──

   Garage says which TRT a car is at, and that is the part only Garage knows.
   It also carries `delivery_details.destination_trt_city`, which looks like
   the name and is not: it is where the car is *going*. One Cypress car reads
   `trt_id: 7198` — Collision Houston — with `destination_trt_city: "Houston -
   Cypress"`. Naming from that field would confidently print the wrong place.

   So the name comes from the site directory this board already caches for the
   TRT picker. No new source, nothing extra fetched, and it still works with
   SCA disconnected.

   The one gap is known: **487417, the offsite lot, is not in Intrepid's
   directory at all** — it exists only in Garage, which is why the picker's
   name search cannot find it either. It is the board's own configured
   offsite, so the caller passes that in and it gets labelled rather than
   printed as a bare number. */
async function siteNames(trtIds, { offsiteTrtId = null } = {}){
  const out = new Map();
  const ids = [...new Set((trtIds || []).filter(Boolean).map(Number))];
  if(!ids.length) return out;

  let map = {};
  try { map = await trtDirectory(); } catch { map = {}; }

  for(const id of ids){
    const hit = map[String(id)];
    if(hit) out.set(id, hit.name || hit.full || ("TRT " + id));
    else if(offsiteTrtId && id === Number(offsiteTrtId)) out.set(id, "Offsite lot");
    // Anything else keeps its number. A bare id is honest about not knowing;
    // inventing a name from the delivery record would not be.
    else out.set(id, "TRT " + id);
  }
  return out;
}

/* ───────────────────────────────── Garage ─────────────────────────────────

   One session cookie, no OAuth, no MCP.

   Garage's own web app reads the index through `/api/1/tesladex/search`, and
   that endpoint answers a plain authenticated GET with exactly the data the
   MCP `tesladex_search` tool returns — verified against the same query: same
   total, same rows, same fields. The MCP route needed a registered OAuth
   client, a token store, a refresh dance and a session handshake to reach the
   same index, so it is gone.

   What that buys, beyond less code: this board now depends on nothing but its
   own folder and two cookies. It shared an OAuth client registration with
   another dashboard for exactly one afternoon, and that is the coupling the
   rewrite exists to remove — refreshing rotates the refresh token, so
   whichever board refreshed first stranded the other.

   The cookie name carries an environment prefix (`31_s_garage_session` on
   production), so nothing here assumes a fixed name: whatever the sign-in
   window produced is sent back verbatim.                                   */

const GARAGE = CONFIG.garageUrl.replace(/\/+$/, "");

function garageCookie(){
  const raw = credstore.garageCookie("prod",
    (loadConnections().garageCookie || "").trim()).value.trim();
  if(!raw){
    const err = new Error("Not signed in to Garage — sign in on the Zo Projects Hub");
    err.needsAuth = true;
    throw err;
  }
  // Tolerate a whole document.cookie paste: only the session cookie matters.
  const m = raw.match(/[A-Za-z0-9_]*_?s_garage_session=[^;]+/);
  return m ? m[0] : raw;
}

async function garageGet(pathAndQuery){
  const res = await request(GARAGE + pathAndQuery, {
    headers: {
      Cookie: garageCookie(),
      Accept: "application/json",
      // Garage answers a bare fetch with the SPA shell; without a browsery
      // agent some paths return HTML and the JSON parse fails misleadingly.
      "User-Agent": "Mozilla/5.0 (the-compiler)"
    }
  });

  /* A dead session does not 401 — it answers 302 to SSO, or 200 with the
     sign-in HTML. Both have to be read as "sign in again" rather than as a
     parse failure, or the panel sends people to fix the wrong thing. */
  if(res.status === 401 || res.status === 403 ||
     (res.status >= 300 && res.status < 400)){
    const err = new Error("Garage session expired or rejected — sign in again");
    err.needsAuth = true;
    throw err;
  }
  if(res.status !== 200){
    throw new Error(`Garage HTTP ${res.status}: ${res.body.slice(0, 160)}`);
  }
  try { return JSON.parse(res.body); }
  catch {
    const err = new Error("Garage returned a sign-in page rather than data — sign in again");
    err.needsAuth = true;
    throw err;
  }
}

/* The index, one page at a time.

   Returned in the MCP tool's shape — `{results, total, has_more}` — rather
   than Garage's `{response, total, from}`, so the callers above read the same
   either way and swapping transports again would touch only this function. */
/* The cheapest query that proves the index is readable. Deliberately NOT
    — the REST endpoint rejects a bare wildcard as a full-text search
   where the MCP tool used to allow it, so a health check written that way
   fails against a perfectly good session. */
const PROBE = "delivered:true";

async function tesladexSearch({ query, fields = ["vin"], size = 100, from = 0,
                                sort = "vin:asc", type = "vehicle" } = {}){
  const qs = [
    "type=" + encodeURIComponent(type),
    "query=" + encodeURIComponent(query),
    "size=" + Number(size),
    "from=" + Number(from),
    "sort=" + encodeURIComponent(sort),
    // Rails wants repeated `fields[]` params, not one comma-joined value.
    ...fields.map(f => "fields[]=" + encodeURIComponent(f))
  ].join("&");

  const d = await garageGet("/api/1/tesladex/search?" + qs);
  const rows = Array.isArray(d && d.response) ? d.response : [];
  const total = typeof (d && d.total) === "number" ? d.total : rows.length;

  return { results: rows, total, has_more: from + rows.length < total };
}

/* Kept so the tool code reads unchanged. There is only ever one tool now, and
   anything else is a mistake worth failing loudly on rather than quietly
   returning nothing for. */
async function callTool(name, args){
  if(name !== "tesladex_search"){
    throw new Error(`Unsupported Garage call: ${name}`);
  }
  return tesladexSearch(args);
}

/* Nothing to establish — a cookie is either present or it is not. Kept as a
   no-op so callers do not have to know which transport they are on. */
async function ensureSession(){
  garageCookie();
  return true;
}

function signOutGarage(){
  saveConnections({ garageCookie: "" });
  return { removed: 1 };
}

/* ─────────────────────────── Garage commands ───────────────────────────

   Reads need only the session cookie. Writes do not: Garage is Rails, and
   every POST is checked against the per-session CSRF token its pages carry in
   a `<meta name="csrf-token">` tag. That token is not in the cookie, so it is
   scraped from a page fetched with the same session — one extra GET per run,
   not per car.

   The wire format is copied out of Garage's own service class rather than
   guessed. Two things there are easy to get wrong and both are load-bearing:
   `device_type` rides in the query string on EVERY call, and it is also
   injected into the body whenever there is one. */

const GARAGE_UA = "Mozilla/5.0 (the-compiler)";

let csrfToken = null;

async function garageCsrf({ refresh = false } = {}){
  if(csrfToken && !refresh) return csrfToken;

  const res = await request(GARAGE + "/vehicles", {
    headers: { Cookie: garageCookie(), Accept: "text/html", "User-Agent": GARAGE_UA }
  });
  if(res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)){
    const err = new Error("Garage session expired or rejected — sign in again");
    err.needsAuth = true;
    throw err;
  }
  const m = res.body.match(/name="csrf-token"\s+content="([^"]+)"/) ||
            res.body.match(/content="([^"]+)"\s+name="csrf-token"/);
  if(!m){
    /* A signed-out session answers 200 with the sign-in page, which has no
       token on it. Same cause as the parse failure in garageGet, so it has to
       read the same way rather than as a Garage-changed-its-HTML mystery. */
    const err = new Error("Garage returned a sign-in page rather than data — sign in again");
    err.needsAuth = true;
    throw err;
  }
  csrfToken = m[1];
  return csrfToken;
}

/* One command. `retry` is spent on a stale token: the page a run started from
   can age out mid-run, and Rails answers that with a 422 that is indis-
   tinguishable from a real refusal unless a fresh token is tried once. */
async function garagePost(pathAndQuery, body = null, { retry = true } = {}){
  const token = await garageCsrf();
  const payload = body ? JSON.stringify({ ...body, device_type: "vehicle" }) : null;

  const res = await request(GARAGE + pathAndQuery, {
    method : "POST",
    headers: {
      Cookie: garageCookie(),
      Accept: "application/json",
      "Content-Type"    : "application/json",
      "Content-Length"  : payload ? Buffer.byteLength(payload) : 0,
      "X-CSRF-Token"    : token,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent"      : GARAGE_UA
    },
    body: payload
  });

  if(res.status === 422 && retry){
    await garageCsrf({ refresh: true });
    return garagePost(pathAndQuery, body, { retry: false });
  }
  if(res.status === 401 || (res.status >= 300 && res.status < 400)){
    const err = new Error("Garage session expired or rejected — sign in again");
    err.needsAuth = true;
    throw err;
  }

  let data = null;
  try { data = JSON.parse(res.body); } catch { /* some commands answer empty */ }

  if(res.status !== 200){
    /* Garage's own errors are the useful ones — "vehicle is offline" reads
       very differently from "you may not access this feature". The txid is
       what makes a refusal traceable in Garage's logs, so it is kept. */
    const err = new Error((data && data.error) || `Garage HTTP ${res.status}`);
    if(data && data.txid) err.txid = data.txid;
    err.status = res.status;
    throw err;
  }
  return data || {};
}

/* Every command is addressed by Garage's 16-digit device id, and Cars on
   Ground only ever has VINs — it is an Intrepid tool and never touches the
   index. So the ids are looked up, in pages, off the same tesladex the rest
   of the board reads. `vpn_state` comes back free in the same query and is
   worth having: it says which cars are already awake. */
const ID_CHUNK = 150;

async function garageIdsForVins(vins, onProgress = () => {}){
  const found = new Map();
  const list  = [...new Set(vins.filter(Boolean))];

  for(let i = 0; i < list.length; i += ID_CHUNK){
    const chunk = list.slice(i, i + ID_CHUNK);
    const page  = await tesladexSearch({
      query : "vin:(" + chunk.join(" OR ") + ")",
      fields: ["vin", "id", "vpn_state"],
      size  : chunk.length,
      sort  : "vin:asc"
    });
    for(const r of page.results || []){
      if(r.vin && r.id != null) found.set(r.vin, { id: r.id, vpnState: r.vpn_state || "" });
    }
    onProgress({ phase: "identify", total: list.length, done: Math.min(i + ID_CHUNK, list.length) });
  }
  return found;
}

/* ── pop the trunks ──

   Ed's problem is finding a specific car in a lot of several hundred, and an
   open liftgate is visible down a whole row. So: wake everything, then open
   every trunk.

   Both steps are per-vehicle. Garage has a `batch_wake_up` that takes the
   whole list in one call, and it is not usable here — it answers 403 "you may
   not access this feature" for a service-centre role, because it belongs to
   the advanced-search batch tooling rather than to the vehicle page. Don't
   swap it back in without checking that first; it fails loudly but only once
   a run is already underway.

   A poked car needs somewhere between a few seconds and a minute to answer,
   and some never do. Rather than sleep for the worst case and open everything
   at the end, each round opens what it can and only the cars that refused go
   round again — the online ones pop within a second of the click, which is
   the difference between a tool you stand and wait for and one you walk
   behind. Outstanding cars are re-poked before each retry, because a single
   SMS poke is one chance and the second one is nearly free. */

const TRUNK_ROUNDS = [0, 20000, 45000, 90000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function popTrunks({ vins, onProgress = () => {} } = {}){
  const wanted = [...new Set((vins || []).filter(isVin))];
  if(!wanted.length) throw new Error("No vehicles to open");

  onProgress({ phase: "identify", total: wanted.length, done: 0 });
  const ids = await garageIdsForVins(wanted, onProgress);

  /* A VIN the index cannot place is reported, not silently dropped. Two of
     them in a list of two hundred is noise; two hundred of them means the
     session is reading a different environment and the run is meaningless. */
  const unknown = wanted.filter(v => !ids.has(v));

  const outstanding = wanted.filter(v => ids.has(v))
    .map(v => ({ vin: v, ...ids.get(v) }));
  const opened = [];
  const failed = new Map();

  if(!outstanding.length){
    return { requested: wanted.length, opened: [], failed: [], unknown, rounds: 0 };
  }

  const total = outstanding.length;
  let queue = outstanding;
  let rounds = 0;

  for(const wait of TRUNK_ROUNDS){
    if(!queue.length) break;
    if(wait){
      onProgress({ phase: "settle", total, done: opened.length });
      await sleep(wait);
    }
    rounds++;

    /* Cars already reported online by the index skip the poke on the first
       round only — after that the index reading is stale enough not to trust
       against a car that has just refused a command. */
    const toPoke = rounds === 1
      ? queue.filter(c => c.vpnState !== "online")
      : queue;

    /* pool() catches for us — it turns a throw into a result object — so a
       dead session cannot escape by being thrown. It has to be carried back
       as a flag and rethrown outside the pool, or a whole run of "session
       expired" reports as several hundred cars that quietly did nothing. */
    let deadSession = null;

    if(toPoke.length){
      let poked = 0;
      onProgress({ phase: "wake", total: toPoke.length, done: 0 });
      await pool(toPoke, CONFIG.concurrency, async c => {
        try { await garagePost(`/api/1/vehicles/${c.id}/wake_up?device_type=vehicle`); }
        catch(err){ if(err.needsAuth) deadSession = err; }
        onProgress({ phase: "wake", total: toPoke.length, done: ++poked });
      });
      if(deadSession) throw deadSession;
    }

    let done = 0;
    onProgress({ phase: "trunks", total: queue.length, done: 0 });
    const results = await pool(queue, CONFIG.concurrency, async c => {
      try{
        await garagePost(`/api/1/vehicles/${c.id}/open_trunk?device_type=vehicle`);
        return { car: c, ok: true };
      }catch(err){
        if(err.needsAuth) deadSession = err;
        return { car: c, ok: false, reason: err.message };
      }finally{
        onProgress({ phase: "trunks", total: queue.length, done: ++done });
      }
    });
    if(deadSession) throw deadSession;

    const again = [];
    for(const r of results){
      /* A result with no `car` is pool() reporting a throw the command code
         did not expect. It is still that car's outcome, so it is recorded
         against the VIN rather than dropped into silence. */
      const car = r && r.car ? r.car : (r && r._item);
      if(!car) continue;
      if(r.ok){ opened.push(car.vin); failed.delete(car.vin); }
      else { failed.set(car.vin, r.reason || r.error || "no reply"); again.push(car); }
    }
    queue = again;
  }

  return {
    requested: wanted.length,
    opened,
    failed   : [...failed].map(([vin, reason]) => ({ vin, reason })),
    unknown,
    rounds
  };
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


/* ──────────────────────────── the fleet, sliced ────────────────────────────

   Every value below was read off the index rather than invented: a sample of
   600 cars at one centre, tallied per field. Anything not in these lists does
   not appear in the data, and a filter offering values the index has never
   heard of is worse than no filter — it returns nothing and looks broken.

   `label` is what the panel shows; `q` is what Lucene is given. Values with
   spaces or hyphens are quoted at query time, not here.                    */

/* ── there is no delivery facet, and that is deliberate ──

   Every scan is undelivered-only. It used to be a two-option facet defaulting
   to Undelivered, which meant the board's whole write surface — switch the
   contact, move the visit, cancel the booking — was one click away from a
   list of customer-owned cars. Ed's call, 2026-08-19: "all we're doing is for
   undelivered cars, so as an extra safeguard remove the option to do any
   delivered cars."

   The rule now lives in buildQuery() where it cannot be unticked. The
   per-write gates in scaSwitchContactToTesla and friends stay exactly as they
   were — this is a second lock on the same door, not a replacement for the
   first one, and the one-VIN lookup still answers about any car because
   looking at a car is not doing anything to it. */
const FACETS = {
  vehicle_type: {
    label: "Vehicle tag",
    field: "vehicle_type",
    options: [
      { v: "customer-vehicle",    label: "Customer" },
      { v: "inventory-vehicle",   label: "Inventory" },
      { v: "service-loaner",      label: "Service loaner" },
      { v: "internal-vehicle",    label: "Internal" },
      { v: "marketing-vehicle",   label: "Marketing" },
      { v: "engineering-vehicle", label: "Engineering" },
      { v: "mobileservice",       label: "Mobile service" },
      { v: "energy",              label: "Energy" }
    ]
  },
  ownership: {
    label: "Ownership",
    field: "ownership",
    options: [
      { v: "Customer",     label: "Customer" },
      { v: "Tesla Motors", label: "Tesla Motors" }
    ]
  },
  vehicle_category: {
    label: "Category",
    field: "vehicle_category",
    options: [
      { v: "StandardServiceLoaner", label: "Standard service loaner" },
      { v: "CoreOperations",        label: "Core operations" },
      { v: "MobileEV",              label: "Mobile EV" },
      { v: "MobileTire",            label: "Mobile tire" },
      { v: "MobileTireLite",        label: "Mobile tire lite" },
      { v: "Event",                 label: "Event" }
    ]
  },
  fleet_status: {
    label: "Fleet status",
    field: "fleet_status",
    options: [
      { v: "Active",           label: "Active" },
      { v: "Inactive",         label: "Inactive" },
      { v: "PendingCycleIn",   label: "Pending cycle in" },
      { v: "PendingCycleOut",  label: "Pending cycle out" }
    ]
  },
  delivery_stage: {
    label: "Delivery stage",
    field: "delivery_stage",
    options: [
      { v: "General Assembly",     label: "General assembly" },
      { v: "Arrived at VRL",       label: "Arrived at VRL" },
      { v: "Arrived not at VRL",   label: "Arrived not at VRL" },
      { v: "Rectification",        label: "Rectification" },
      { v: "At service center",    label: "At service center" },
      { v: "In-garage delivered",  label: "In-garage delivered" },
      { v: "Post Delivery Owned",  label: "Post delivery owned" },
      { v: "Frozen",               label: "Frozen" }
    ]
  },
  /* Has a delivery booked, whenever it is. The other facets ask what a car
     *is*; this one asks whether anybody is waiting for it — which is what
     turns a service visit from a queue entry into a deadline.

     `exists: true` marks the odd one out: the option is not a value to match
     but the presence of a date, so buildQuery writes a range over the whole
     field rather than an OR group. The date itself is nested under
     `delivery_details`, which is the only reason this took finding — the flat
     `scheduled_delivery_date` the field list appears to offer is 422
     `Unknown fields` against the index. */
  scheduled_delivery: {
    label: "Scheduled for delivery",
    field: "delivery_details.scheduled_delivery_date",
    exists: true,
    note: "Cars with a delivery appointment booked, on any date",
    options: [
      { v: "yes", label: "Yes" }
    ]
  },
  /* New / Used is the one facet Garage cannot answer. The index has no title
     field at all; the answer lives in Intrepid's Falcon record as
     `TitleStatus`, one call per VIN, which means it cannot go into the Lucene
     query and has to be applied after the population is already in hand.

     `fetched: true` marks that difference for the panel and for scanVehicles:
     selecting a value here costs an extra call per vehicle and narrows the
     result after the scan rather than before it. Leave it empty and no title
     is looked up at all.

     Values come back in mixed case — NEW, USED and Used all appear in the
     same centre — so both sides compare lowercased, exactly as Intrepid's own
     page does before it matches against this enum. */
  title: {
    label: "Title status",
    field: null,
    fetched: true,
    note: "Not in the Garage index — one extra Intrepid call per vehicle",
    options: [
      { v: "new",      label: "New" },
      { v: "used",     label: "Used" },
      { v: "salvaged", label: "Salvaged" },
      { v: "tbd",      label: "TBD" }
    ]
  },
  model: {
    label: "Model",
    field: "model",
    options: [
      { v: "3",          label: "Model 3" },
      { v: "y",          label: "Model Y" },
      { v: "s",          label: "Model S" },
      { v: "x",          label: "Model X" },
      { v: "cybertruck", label: "Cybertruck" }
    ]
  }
};

/* Which blockers to look for. Each costs a call per vehicle (containment is
   batched five at a time), so leaving one off is a real saving on a big
   selection rather than a cosmetic filter. */
const HOLD_KINDS = [
  { v: "sv",          label: "Service visits",  hint: "An open SCA service visit" },
  { v: "containment", label: "Containment",     hint: "Active containment campaign" },
  { v: "logistics",   label: "Logistics holds", hint: "Held in logistics, with a reason" }
];

/* Lucene wants quotes around anything with a space or a hyphen; a bare
   `vehicle_type:customer-vehicle` parses the hyphen as an operator and
   quietly matches the wrong set. */
const term = (field, value) => `${field}:"${String(value).replace(/"/g, '\\"')}"`;

const orGroup = (field, values) =>
  values.length === 1 ? term(field, values[0])
                      : "(" + values.map(v => term(field, v)).join(" OR ") + ")";

/* The selection, as one Lucene string. An empty facet means "no opinion" and
   contributes nothing, so the query only ever narrows. */
/* ── onsite, offsite, and why they use different fields ──
   The centre is `vehicle_routing_location`. The offsite lot is `trt_id`. That
   asymmetry is not an oversight; it is what the data is.

   Measured at Cypress, 2026-08-11, over its 576 undelivered cars:

     161  trt_id 487417   the offsite lot
     160  trt_id 17589    the centre itself
     111  no trt_id at all
     144  logistics codes (15047, 8162, 16402, …) the car has not shed

   So `trt_id` cannot enumerate a centre — it misses the 111 with none and the
   144 still carrying a transit code. VRL can, and does, which is what the
   board has always used. But `trt_id` is exactly right for saying WHICH LOT a
   car sits on, and it is the only field that knows: Intrepid has never heard
   of 487417 — not in getLocations, not in getCogInventoryCars, and asked
   directly it places those cars at 17589.

   Hence: enumerate by VRL, split by trt_id. Both are indexed, so all three
   scopes are one query and cost the same as the single-site scan did.

   The three are disjoint by construction — onsite explicitly excludes the
   offsite lot — so Onsite + Offsite = Onsite & Offsite, and no car is counted
   twice. Offsite is not confined to the VRL: 15 of those 176 cars sit outside
   it entirely, and they are still on the lot. */
function buildQuery({ trtId, offsiteTrtId, sites = "onsite", filters = {} }){
  const parts = [];
  const main = Number(trtId) > 0 ? Number(trtId) : null;
  const off  = Number(offsiteTrtId) > 0 ? Number(offsiteTrtId) : null;

  const VRL = id => `vehicle_routing_location:${id}`;
  const LOT = id => `trt_id:${id}`;

  if(main && off && sites === "offsite"){
    parts.push(LOT(off));
  }else if(main && off && sites === "both"){
    parts.push(`(${VRL(main)} OR ${LOT(off)})`);
  }else if(main && off){
    // onsite — the centre, minus whatever is standing at the offsite lot.
    parts.push(`${VRL(main)} AND NOT ${LOT(off)}`);
  }else if(main){
    /* No offsite configured: byte-identical to what every scan built before
       any of this existed. */
    parts.push(VRL(main));
  }

  /* Always, and not from `filters` — see the note above FACETS. A page that
     still remembers a saved `delivery` selection cannot reintroduce delivered
     cars, because nothing here reads that key any more and the server drops
     facet keys it does not publish. */
  parts.push("delivered:false");

  for(const [key, facet] of Object.entries(FACETS)){
    // A fetched facet has no index field to filter on and is applied to the
    // rows afterwards instead.
    if(facet.fetched || !facet.field) continue;
    const vals = filters[key] || [];
    if(!vals.length) continue;

    /* An existence facet asks whether the field is set at all, so its chosen
       value never reaches the query — only the fact that something was
       chosen. `[* TO *]` rather than `:*`, because the field is a date and a
       wildcard over a date is not a term query. */
    if(facet.exists){ parts.push(`${facet.field}:[* TO *]`); continue; }

    parts.push(orGroup(facet.field, vals));
  }
  return parts.join(" AND ") || "*:*";
}

/* New / Used / Salvaged / TBD for one car, from Intrepid's Falcon record.

   Returned lowercased because the source is not consistent: NEW, USED and
   Used all come back from the same centre on the same day. Intrepid's own
   page lowercases before matching too — anything comparing these raw will
   drop a third of the used cars and look like a data problem. */
async function titleStatusFor(vin){
  const d = await intrepidGet(`/falconVehicleSearch?vin=${encodeURIComponent(vin)}`)
    .catch(() => null);
  const r = d && Array.isArray(d.results) ? d.results[0] : null;
  if(!r || !r.TitleStatus) return null;
  return {
    title : String(r.TitleStatus).toLowerCase(),
    refurb: r.RefurbishmentStatus || "",
    // 0001-01-01 is Falcon's way of saying "never", not a date in the year 1.
    inUse : r.MarketingInUseDate && !/^0001-/.test(r.MarketingInUseDate)
      ? r.MarketingInUseDate : null
  };
}

/* ══════════════════════ Pending Inventory — matched, not scheduled ══════════════════

   Tesla OS enumerates and Garage describes. OS is the only system that knows
   an order exists, so it says WHICH cars have a customer waiting and no
   appointment booked; Garage is the only one that says what those cars ARE in
   words a person can read. Neither can answer alone.

   Unlike the service-visits scan this costs no per-vehicle calls: OS returns
   the whole bucket 25 rows at a time, and Garage answers every VIN in one
   batched index query. A 61-car centre is about ten seconds, nearly all of it
   OS paging.                                                                */

/* ── option codes are the only trim there is ──

   Ed asked for trim as Standard / Premium. Neither system says that:
   Garage's `cfg_trim` is the battery/variant code (`74`, `62D`, `P74D`) and
   OS renders `ord_trim_code` raw — its own bundle has no label map, so the
   pipeline screen shows a code too.

   What every OS row does carry is exactly one `MT…` marketing code, and
   cross-tabulating those against Garage over a real centre gave a clean 1:1
   split with no ambiguity:

     MT367  Model 3   62    RWD        MTY77  Model Y   62D   AWD
     MT369  Model 3   74    RWD        MTY60  Model Y   74    RWD
     MT370  Model 3   74D   AWD        MTY48  Model Y   74D   AWD
                                       MTY70  Model Y   P74D  AWD
     MTC04 / MTC07 / MTC08  Cybertruck  AWD

   The grouping is measured. The NAMES are read off Tesla's current lineup —
   62 is the Standard pack, 74 the Premium one, a leading P is Performance —
   and that last step is the only inference here. So the card shows the code
   beside the name: a wrong label is then obvious to anyone who sells these,
   rather than being a quiet fiction. Unknown codes degrade to the bare code
   rather than guessing from the number. */
const TRIM_BY_MT = {
  MT367: "Standard RWD",     MT369: "Premium RWD",      MT370: "Premium AWD",
  MTY77: "Standard AWD",     MTY60: "Premium RWD",      MTY48: "Premium AWD",
  MTY70: "Performance AWD",
  MTC04: "Cybertruck AWD",   MTC07: "Cybertruck AWD",   MTC08: "Cybertruck AWD"
};

/* `$PN00,$W38A,…` → `["PN00","W38A",…]`. The $ is decoration in OS's own
   payload; the compositor accepts the string either way (proven byte-identical
   both ways), but everything else here wants it gone. */
const mktCodes = s => String(s || "").split(",")
  .map(x => x.trim().replace(/^\$/, "")).filter(Boolean);

/* SNAKE_CASE → words. Garage writes `PEARL_WHITE`, `HELIX_V2_20_DARK`,
   `BLACK_CONSOLE_2`. Read as-is these are shouty and unreadable; read as
   Title Case they are the names people use.

   `NONE` becomes empty rather than the word "None", because the caller
   decides how an absent feature reads — "No tow hitch" is a sentence, "None"
   beside a label is a shrug. */
function pretty(v){
  const s = String(v == null ? "" : v).trim();
  if(!s || /^(none|null|default|unknown)$/i.test(s)) return "";
  return s.replace(/_/g, " ")
          .toLowerCase()
          .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
          // Keep the shapes that are names rather than words.
          .replace(/\bV(\d)\b/gi, "V$1")
          .replace(/\bRwd\b/g, "RWD").replace(/\bAwd\b/g, "AWD")
          .replace(/\bLh\b/g, "LH").replace(/\bRh\b/g, "RH");
}

/* The spec, as one flat object of already-readable strings.

   Every field is a string, "" meaning Garage did not answer. Deliberately not
   null: the card renders an unanswered field as "not on record" rather than
   dropping the row, because a missing line reads as a car without the feature
   and that is the one wrong impression worth engineering against. */
/* The seat grade, without the actuator hardware.

   Garage answers this in two different fields depending on the car — 3 and Y
   carry `cfg_frontseattype`, Cybertruck carries `cfg_seattrimtype`, and each
   is empty on the other — so both are read and the first answer wins.

   The 3/Y value is `PREMIUM_L_TESLA_MINITILT_R_TESLA_MINITILT`: a grade
   followed by which recliner is fitted on each side. Only the grade is a
   spec anybody reads, so everything from the per-side description onward is
   cut. Cut rather than mapped, so a grade this has never seen still comes
   through instead of falling to blank. */
const seatGrade = v => pretty(String(v || "").replace(/_[LR]_[A-Z0-9_]+$/, ""));

function specOf(g, mt, model){
  const wheels = pretty(g && g.cfg_wheeltype);
  const tow    = pretty(g && g.cfg_towpackage);

  /* Cybertruck has no `cfg_exteriorcolor` at all — not blank, absent, on every
     one of them. That is the product rather than a gap in the record: the body
     is bare stainless unless it is wrapped. Said in words, because a card with
     an empty Paint line reads as missing data. */
  const paint = pretty(g && g.cfg_exteriorcolor) ||
                (model === "ct" && g ? "Stainless steel" : "");

  return {
    paint,
    wheels   : wheels + (g && g.staggered_wheels ? " (staggered)" : ""),
    interior : pretty(g && g.cfg_interiortrimtype),
    seats    : seatGrade(g && (g.cfg_frontseattype || g.cfg_seattrimtype)),
    roof     : pretty(g && g.cfg_rooftype),
    motor    : String((g && g.cfg_drivetraintype) || "").toUpperCase(),
    // "" from pretty() means the code said NONE, which here is a real answer.
    tow      : tow,
    towed    : Boolean(g && g.cfg_towpackage && !/^none$/i.test(g.cfg_towpackage)),
    trim     : TRIM_BY_MT[mt] || "",
    trimCode : mt || ""
  };
}

/* Model year from the VIN, which is the one place it is always present.
   Position 10 is the model-year character and Tesla is on the ordinary
   ISO 3779 cycle; the letters that can appear on a car in a delivery pipeline
   today are the only ones worth listing. */
const VIN_YEAR = { R: 2024, S: 2025, T: 2026, V: 2027, W: 2028 };
const yearOf = vin => {
  const c = String(vin || "")[9];
  return (c && VIN_YEAR[c.toUpperCase()]) || null;
};

const MODEL_NAME = { m3: "Model 3", my: "Model Y", ms: "Model S",
                     mx: "Model X", ct: "Cybertruck", ts: "Semi" };

/* The Garage fields the card and the filters need, and nothing else. Asking
   the index for the whole document would move megabytes to render ten lines. */
const SPEC_FIELDS = ["vin", "model", "option_codes", "staggered_wheels",
  "cfg_exteriorcolor", "cfg_wheeltype", "cfg_interiortrimtype", "cfg_seattrimtype",
  "cfg_frontseattype", "cfg_rooftype", "cfg_drivetraintype", "cfg_towpackage",
  "cfg_trim",
  /* Not for the card — for the ticket panel. It gates whether a visit's
     appointment may be cancelled as part of a move, because a booking on a
     delivered car belongs to a customer rather than to Tesla. The server
     re-reads it from Garage before writing either way; this only decides what
     the panel offers. */
  "delivered"];

/* Garage, by VIN and in batches.

   By VIN rather than by `vehicle_routing_location`, which is how every other
   scan on this board enumerates. A matched car has a customer but need not
   have arrived — several in a real Cypress bucket are still at the factory —
   so the centre's VRL would silently drop them. The VIN is the join key OS
   already gave us and it does not care where the car is standing. */
async function specsByVin(vins, onProgress){
  const out = new Map();
  const BATCH = 50;
  for(let i = 0; i < vins.length; i += BATCH){
    const slice = vins.slice(i, i + BATCH);
    /* Not caught. A batch that fails would otherwise leave fifty cars looking
       like cars Garage has never indexed, which is a different and much more
       alarming thing than a call that did not go through — and the card says
       so in those words. Garage is a required source here as everywhere else
       on the board, so a scan that cannot reach it fails rather than
       describing the fleet wrongly. */
    const page = await tesladexSearch({
      query : "vin:(" + slice.join(" OR ") + ")",
      fields: SPEC_FIELDS,
      size  : BATCH
    });
    for(const r of (page && page.results) || []) if(r.vin) out.set(r.vin, r);
    if(onProgress) onProgress({ phase: "spec", done: Math.min(i + BATCH, vins.length),
                                total: vins.length });
  }
  return out;
}

/* ── which of them have actually turned up ──

   A matched car is not necessarily a car you can walk out to. Some are still
   at the factory, some are on a truck, and the ones standing on the lot are
   the only ones anybody can prepare.

   **Intrepid's on-ground inventory is the answer, and it is one call.**
   `getCogInventoryCars` lists every car physically at the centre with its
   arrival stamp — no date in the query and nothing per vehicle, which is why
   Cars on Ground can read a 700-car lot in three seconds. This asks the same
   question of the same endpoint, so the two tools cannot disagree about which
   cars are here.

   Three sources were considered and two rejected:

   - **OS's `eta_to_service_center_dt`** is a plan, not an observation. Real
     rows carry ETAs months in the past on cars that are standing here and
     ETAs in the future on cars that already arrived. A date that has passed
     is not an arrival.
   - **Garage's routing location** says where a car belongs, not where it is.
   - The inventory list says a car is on the ground because it is on the
     ground.

   Returns a Map of VIN → arrival timestamp, or **null** if the call failed —
   null means "not known", which the caller must keep distinct from "not
   here". A dead Intrepid cookie must not quietly report a centre with nothing
   on the lot. */
async function onGroundAt(trtId, notes){
  try{
    const inv = await intrepidGet(
      `/getCogInventoryCars?trtId=${encodeURIComponent(trtId)}` +
      `&matchStatus=&vehicleTypes=&pageSize=${COG_PAGE}`);

    const out = new Map();
    /* The inventory repeats a VIN when a car has more than one shipment leg
       behind it, and the first row wins — the same dedupe Cars on Ground
       makes on the same list, so a car's arrival date reads the same on both
       screens. */
    for(const r of Array.isArray(inv) ? inv : []){
      if(r && r.vin && !out.has(r.vin)) out.set(r.vin, r.arrivalTimeStamp || null);
    }
    return out;
  }catch(err){
    /* Not thrown. Arrival is one column of one filter; the pipeline, the
       specs and the pictures are all still good, and failing the whole scan
       over it would be the tail wagging the dog. But it is SAID, because the
       Arrival filter simply vanishing would look like a centre where every
       car is in the same state. */
    notes.push(`Intrepid did not answer, so this scan cannot say which cars have ` +
               `arrived — the Arrival filter is not offered. ${err.message}`);
    return null;
  }
}

async function expScan({ trtId, onProgress } = {}){
  const trt = asTrt(trtId) || savedTrtId();
  if(!trt){
    const err = new Error("Set a TRT first — the pipeline is read one centre at a time.");
    err.needsTrt = true;
    throw err;
  }

  const token = osToken();
  const notes = [];

  /* Named before anything is counted. A TRT the pipeline has never heard of
     otherwise returns an empty bucket that reads exactly like a quiet centre,
     which is the failure this whole file keeps guarding against.

     Errors are NOT caught here, and that is the point: a dead session throws
     from this same call, and swallowing it would report a live centre as an
     unknown TRT and send the reader to the picker to fix a sign-in. Only an
     answer of "no such site" means what the message below says. Caught once
     during testing, from exactly that expiry. */
  const location = await osx.locationFor(token, trt);
  if(!location){
    const err = new Error(
      `Tesla OS does not know TRT ${trt}. Check the TRT in the picker — the ` +
      `pipeline uses the same numbers the rest of the board does.`);
    err.needsTrt = true;
    throw err;
  }

  const { bucket, total, rows: osRows } = await osx.matchedNotScheduled(token, trt, onProgress);

  const vins = [...new Set(osRows.map(r => r.vin).filter(Boolean))];
  const specs = vins.length ? await specsByVin(vins, onProgress) : new Map();
  if(onProgress && vins.length) onProgress({ phase: "arrival" });
  const here = vins.length ? await onGroundAt(trt, notes) : null;

  /* ── does this car have a service visit ──

     One Intrepid call per VIN, which is the only per-vehicle cost in this
     scan and the same call the Service Visits tool makes. It buys the SV
     bubble on the card, and the bubble opens the Service Visits editor over
     this row — so the row has to carry visits in that tool's shape, not a
     shape of its own.

     Caught per car rather than as a batch: one VIN that fails is one card
     without a bubble, and failing the whole scan over it would trade a
     complete answer for a missing one. */
  const visitsBy = new Map();
  if(vins.length){
    let done = 0;
    if(onProgress) onProgress({ phase: "holds", done, total: vins.length });
    await pool(vins, READ_CONCURRENCY, async vin => {
      const sv = await intrepidGet(
        `/getScaServiceVisitByVin?vin=${encodeURIComponent(vin)}`).catch(() => null);
      if(Array.isArray(sv) && sv.length) visitsBy.set(vin, sv);
      done++;
      if(onProgress) onProgress({ phase: "holds", done, total: vins.length });
    });
  }

  const missing = [];
  const rows = osRows.map(r => {
    const g  = (r.vin && specs.get(r.vin)) || null;
    const mt = mktCodes(r.cfg_mkt_option_codes).find(c => /^MT/.test(c)) || "";
    if(r.vin && !g) missing.push(r.vin);

    /* OS's `model` is already the compositor's own code ("m3", not "3"), so it
       is carried as-is and Garage's differently-spelled one is not used. One
       fewer mapping to keep correct. */
    const model = String(r.model || "").toLowerCase();

    return {
      rn    : r.rn || "",
      vin   : r.vin || "",
      model,
      modelName: MODEL_NAME[model] || (model ? model.toUpperCase() : ""),
      year  : yearOf(r.vin),
      /* The timestamp, not OS's `time_since_matched`. That field is minutes as
         a string and is computed when the row is fetched, so a tab left open
         would keep reporting the age it had on load. Derived on the page
         instead — see the estate rule about latency in dashboards. */
      matchedAt: r.match_dt || null,
      etaAt    : r.eta_to_service_center_dt || null,
      /* Straight to the compositor. The MARKETING codes, not Garage's
         manufacturing `option_codes` — feeding it the latter renders the car
         correctly but leaves black voids where the wheels should be. */
      options  : mktCodes(r.cfg_mkt_option_codes).join(","),
      spec     : specOf(g, mt, model),
      inGarage : Boolean(g),
      /* Three states, and the third one matters: true is standing on this
         lot, false is somewhere else, and **null is "nobody asked"** — the
         inventory call failed and the board does not know. A null rendered as
         false would put every car in transit and read as a centre with an
         empty lot, which is the failure this whole file keeps guarding
         against. */
      here     : here ? here.has(r.vin) : null,
      arrivedAt: (here && here.get(r.vin)) || null,
      /* The Service Visits row shape, exactly — this is what the SV bubble
         hands to that tool's editor, and the editor is not copied. Mapped
         with the same fields in the same order as scanVehicles builds them,
         because the panel reads them by name. */
      visits: (visitsBy.get(r.vin) || []).map(v => ({
        id    : v.serviceVisitNumber || String(v.serviceVisitID || ""),
        svId  : v.serviceVisitID || null,
        opened: v.createDate || null,
        due   : v.estimatedCompletionDateTime || null,
        trt   : v.trtid || null,
        source: v.serviceVisitSourceID || "",
        ticket: null,
        vriAt : null
      })),
      /* Two fields the panel reads off the vehicle rather than the visit.
         `delivered` decides whether it will offer to cancel an appointment;
         `site` is the third line of its heading and this tool has no site
         pill, so it is left empty rather than invented. */
      delivered: Boolean(g && g.delivered),
      site     : ""
    };
  });

  /* The tickets and the receiving inspections, through the very same function
     the Service Visits scan uses — see enrichVisits(). Its notes are its own
     and are carried up with ours, because "the Service App failed for 2 cars"
     means the same thing on either screen. */
  const svRows = rows.filter(r => r.visits.length);
  if(svRows.length){
    notes.push(...await enrichVisits({ rows: svRows, trtId: trt, onProgress, notes: [] }));
  }

  /* A VIN the index has never heard of is a car that has not been built yet —
     the order exists and the VIN is assigned, but nothing has come down the
     line to be indexed. Said that way round because "not in Garage's index"
     describes a database and "not built" describes the car, and only one of
     those is what the reader wants to know. */
  if(missing.length){
    notes.push(`${missing.length} of ${rows.length} ${missing.length === 1 ? "car has" : "cars have"} ` +
               `not been built yet — ${missing.length === 1 ? "its" : "their"} card shows the ` +
               `order and the picture, but no configuration.`);
  }

  return { trtId: trt, location, bucket, total, rows, notes };
}

/* ────────────────────────── open inventory scan ─────────────────────────

   Pending Inventory's other half, and the mirror of the question above:
   expScan asks who is waiting for a car, this asks what there is to give
   them. Tesla's internal inventory search, described in inventory.js.

   Two things make it unlike every other scan on this board.

   **It needs no credential.** No token, no cookie, no session to be dead. So
   there is no needsOs-shaped error here and nothing to send the reader to the
   Admin panel about; a failure is a failure of the host, not of a sign-in.

   **It is not locked to the centre.** Everything else here resolves scope
   server-side and refuses to be told otherwise, because a Service Visits scan
   that quietly widened would report another centre's problems as this one's.
   Availability is the opposite question — "is there one of these anywhere I
   can get it from" is a normal thing to ask — so Location is an ordinary
   filter. The page seeds it with the picker's TRT; it is not injected here,
   because a filter the server adds is a filter the panel cannot show and the
   reader cannot see.                                                        */

/* Which groups in `OptionCodeData` are worth a line in the spec panel, in the
   order they are read. The row also carries the raw code arrays (PAINT:
   ["WHITE"]), but those are codes; this is where the site keeps the words. */
const INV_SPEC_GROUPS = [
  ["PAINT",           "Paint"],
  ["WHEELS",          "Wheels"],
  ["INTERIOR",        "Interior"],
  ["REAR_SEATS",      "Seats"],
  ["DRIVE_MODE",      "Drive"],
  ["AUTOPILOT",       "Autopilot"],
  ["PREMIUM_PACKAGE", "Package"],
  ["AI_HARDWARE",     "Hardware"]
];

function invSpec(row){
  const by = new Map();
  for(const o of row.OptionCodeData || []){
    const name = o.long_name || o.name || "";
    if(!name || by.has(o.group)) continue;      // first wins; the list repeats groups
    by.set(o.group, name);
  }
  const out = [];
  for(const [group, label] of INV_SPEC_GROUPS){
    if(by.has(group)) out.push({ k: label, v: by.get(group) });
  }
  return out;
}

/* ── a new car has no VIN you can use, and the card must say so ──

   New inventory returns the VIN masked — "7SAY" followed by a hash — and no
   UrlToken. Used inventory returns the real 17-character VIN on every row
   sampled (24 of 24) plus a token, and `tesla.com/<model>/order/<VIN>`
   resolves straight to the listing.

   So a used car can be linked to and joined to Garage, and a new one can be
   neither. The row carries `masked` rather than a prettied-up VIN, because a
   masked VIN rendered as if it were real is the sort of thing that gets typed
   into Garage and comes back "no such car". */
const REAL_VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

function invRow(r){
  const model  = String(r.Model || "").toLowerCase();
  const vin    = String(r.VIN || "");
  const masked = !REAL_VIN.test(vin);
  const used   = String(r.TitleStatus || "").toUpperCase() === "USED";

  return {
    vin        : masked ? "" : vin,
    /* Kept separately so the card can show something stable per car without
       implying it is a VIN. */
    ref        : vin,
    masked,
    model,
    modelName  : MODEL_NAME[model] || (model ? model.toUpperCase() : ""),
    year       : r.Year || null,
    trim       : r.TrimName || "",
    trimCode   : r.TrimCode || "",
    condition  : used ? "used" : "new",
    price      : Number(r.Price || r.InventoryPrice || 0) || null,
    monroney   : Number(r.MonroneyPrice || 0) || null,
    discount   : Number(r.Discount || 0) || null,
    odometer   : Number.isFinite(r.Odometer) ? r.Odometer : null,
    odoUnit    : r.OdometerTypeShort || "mi",
    demo       : Boolean(r.IsDemo),
    damage     : Boolean(r.DamageDisclosure),
    inTransit  : Boolean(r.InTransit || r.IsInTransit),
    factoryGated: Boolean(r.IsFactoryGated),
    /* Straight to the compositor, and already the right list: OptionCodeList
       is the `$`-prefixed MARKETING codes. Garage's manufacturing option_codes
       render the car with black voids where the wheels should be — see the
       same note in expScan. */
    options    : String(r.OptionCodeList || ""),
    spec       : invSpec(r),
    trt        : r.Trt || null,
    vrl        : (r.VrlName || "").trim(),
    city       : r.City || r.VehicleCity || "",
    state      : r.StateProvince || "",
    metro      : r.MetroName || r.SalesMetro || "",
    /* Only used cars have a listing to open. A new car's masked VIN redirects
       back to the search page, so there is nothing to point at and the card
       says that rather than offering a link that goes nowhere. */
    listing    : used && !masked ? `https://www.tesla.com/${model}/order/${vin}` : ""
  };
}

async function invScan({ model = "my", condition = "new", options = {},
                         sort = "Relevance", onProgress } = {}){
  const schema = await invx.filterSchema();

  /* Unknown filter keys are refused rather than forwarded. The inventory API
     ignores what it does not recognise and answers 200 with a WIDER list, so a
     typo would return more cars than asked for and read as a real answer —
     the same reason DWELL_WINDOWS is validated instead of trusted. */
  const known = new Set(Object.keys(schema.filters || {}));
  const bad   = Object.keys(options || {}).filter(k => !known.has(k));
  if(bad.length){
    throw new Error(`Tesla inventory has no filter called ${bad.join(", ")}.`);
  }

  /* Refused rather than passed through, because the API does not check it: an
     unknown `arrangeby` comes back 200 in the Relevance order, so a typo would
     silently answer in an order nobody chose. See SORTS in inventory.js. */
  if(!invx.SORTS.includes(sort)){
    throw new Error(`Tesla inventory cannot order by "${sort}". ` +
                    `It offers: ${invx.SORTS.join(", ")}.`);
  }

  /* Empty groups are dropped on the way out: `{PAINT: []}` is not "no paint",
     and sending it has been seen to narrow to nothing on APIs of this shape. */
  const opts = {};
  for(const [k, v] of Object.entries(options || {})){
    const list = (Array.isArray(v) ? v : [v]).filter(x => x !== "" && x != null).map(String);
    if(list.length) opts[k] = list;
  }

  const { total, rows, notes, truncated } =
    await invx.search({ model, condition, options: opts, sort,
                        market: schema.market, language: schema.language, onProgress });

  if(schema.stale){
    notes.push("The filter list could not be refreshed, so it may be out of date. " +
               "The cars themselves are live.");
  }

  return {
    model, condition, sort,
    options : opts,
    total, truncated,
    rows    : rows.map(invRow),
    notes
  };
}

/* ─────────────────────────── service visits scan ───────────────────────────

   Two systems, in order. Garage's index says which cars exist and what they
   are; Intrepid says what is wrong with them. Neither can answer alone — the
   index has no notion of a service visit, and Intrepid's own list is a
   per-date appointment view that omits cars booked and then stuck.

   Cost is the reason for the cap and for the per-kind toggles: a service
   visit and a logistics hold are one call each per vehicle, so a thousand
   cars is two thousand round trips. Containment batches five to a call. */

/* ── how hard the reads are allowed to push ──

   `CONFIG.concurrency` is 6 and stays 6 for the things that WRITE: waking a
   car and popping its trunk are pokes at a fleet, and the batch endpoint that
   would have done them in one call is 403 for this role, so that pool is
   deliberately gentle.

   Reads are a different question and 6 was leaving most of the scan waiting.
   Measured against Cypress on the same sixty cars: 6 took 11.2s, 12 took
   4.7s, 20 took 3.6s, 30 took 3.1s — and the failure count did not move at
   any of them, because the "failures" were empty bodies rather than Intrepid
   pushing back. Sixteen is where the curve flattens; past it the gain is
   tenths of a second against a fleet endpoint somebody else also uses. */
const READ_CONCURRENCY = 16;

const SCAN_CAP = 1200;

async function scanVehicles({ trtId, offsiteTrtId, sites = "onsite",
                              filters = {}, kinds, vin, onProgress } = {}){
  const want = new Set((kinds && kinds.length ? kinds : HOLD_KINDS.map(k => k.v)));
  const notes = [];

  await ensureSession();

  /* ── one car, and every filter ignored ──

     A VIN is not a narrower version of a centre scan, it is a different
     question: "what is going on with this car", asked about a car that may be
     at another site, delivered, or in a state no facet on the menu selects.
     Applying the site or the facets to it would answer "no cars found" for a
     car the reader is looking at, which is the worst possible reply.

     Everything downstream is unchanged — the same holds, the same tickets,
     the same row shape — so one VIN renders exactly as it would inside a
     centre scan, and the panel and its writes work on it identically. */
  const one = String(vin || "").trim().toUpperCase();
  if(one && !isVin(one)) throw new Error(`${one} is not a 17-character VIN`);

  const query = one ? `vin:${one}`
                    : buildQuery({ trtId, offsiteTrtId, sites, filters });
  /* The scheduled date is fetched whether or not the facet is set: it costs
     nothing extra on a query that is already running, and the export offers
     it as a column. Nested projection works — asking for
     `delivery_details.scheduled_delivery_date` returns only that subfield
     rather than the whole object, which also keeps the destination city and
     the rest of the delivery record off this server. */
  const fields = ["vin", "model", "vehicle_type", "ownership", "vehicle_category",
                  "fleet_status", "delivery_stage", "delivered", "delivery_date_epoch",
                  "delivery_details.scheduled_delivery_date",
                  /* Where the car actually is. `trt_id` is the only field that
                     distinguishes a car standing at Collision from one at the
                     centre it routes to — but it is not complete, so the
                     routing location comes along as the fallback. Both are
                     free on a query that is already running. See siteNames()
                     and the site pass below. */
                  "trt_id", "vehicle_routing_location"];

  /* ── who is in scope ── */
  const cars = [];
  let total = null;
  for(let from = 0; from < SCAN_CAP; from += TESLADEX_PAGE){
    const page = await callTool("tesladex_search", {
      query, fields, size: TESLADEX_PAGE, from, sort: "vin:asc"
    });
    if(page && page.error) throw new Error("Tesladex: " + page.error);
    if(total == null && page && typeof page.total === "number") total = page.total;
    const rows = (page && page.results) || [];
    cars.push(...rows.filter(r => r.vin));
    if(onProgress) onProgress({ phase: "enumerate", got: cars.length, total });
    if(!rows.length || !page || !page.has_more) break;
  }

  if(total != null && total > cars.length){
    notes.push(`The filter matches ${total.toLocaleString()} vehicles; this scan covers the ` +
               `first ${cars.length.toLocaleString()}. Narrow the selection to see the rest — ` +
               `nothing beyond that point was checked.`);
  }

  if(!cars.length) return { query, total: 0, scanned: 0, rows: [], notes, kinds: [...want] };

  /* ── title status, when it was asked for ──
     Before the holds, and on its own pass, because it can shrink the
     population: filtering to Used first means the expensive per-vehicle hold
     lookups only run on cars that survived. Ordering it the other way round
     would pay for holds on every car and then throw most of them away. */
  const wantTitle = (filters.title || []).map(v => String(v).toLowerCase());
  let titles = null;
  if(wantTitle.length){
    titles = new Map();
    let tdone = 0;
    await pool(cars, READ_CONCURRENCY, async c => {
      titles.set(c.vin, await titleStatusFor(c.vin));
      tdone++;
      if(onProgress) onProgress({ phase: "title", done: tdone, total: cars.length });
    });

    const before = cars.length;
    // A car Falcon has no record of is dropped rather than guessed at: it is
    // not evidence of "New", it is an absence of evidence.
    const keep = cars.filter(c => {
      const t = titles.get(c.vin);
      return t && wantTitle.includes(t.title);
    });
    const unknown = cars.filter(c => !titles.get(c.vin)).length;
    cars.length = 0;
    cars.push(...keep);

    notes.push(`Title status narrowed ${before.toLocaleString()} vehicles to ${
      keep.length.toLocaleString()}.` + (unknown
        ? ` ${unknown} had no Falcon record and were left out rather than assumed.` : ""));

    if(!cars.length){
      return { query, total: total ?? 0, scanned: 0, rows: [], notes, kinds: [...want] };
    }
  }


  /* ── containment, a hundred VINs to a call ──

     It was five, and five was costing eleven seconds a scan for nothing:
     measured against a real centre, a hundred VINs come back in the same
     second five did — the call spends its time on the round trip, not on the
     cars. 483 cars went from 97 calls to 5.

     **A hundred is the ceiling and it truncates in silence.** Asked for 200
     VINs it answers 200 OK with exactly 100 keys and no complaint, which is
     the same shape of trap as the delivery pipeline's page size. So the batch
     is pinned here, and the guard below counts what came back rather than
     trusting it. */
  const CONTAINMENT_BATCH = 100;
  const containment = {};
  if(want.has("containment")){
    const batches = [];
    for(let i = 0; i < cars.length; i += CONTAINMENT_BATCH)
      batches.push(cars.slice(i, i + CONTAINMENT_BATCH).map(c => c.vin));
    let done = 0, short = 0;
    await pool(batches, READ_CONCURRENCY, async b => {
      const got = await intrepidGet(
        `/bulkGetCampaignContainmentHolds?vins=${b.join(",")}`).catch(() => null);
      if(got && typeof got === "object"){
        Object.assign(containment, got);
        // Every VIN asked about should come back, holds or not. Fewer keys
        // than VINs means cars were dropped, and a dropped car reads as a car
        // with no containment — which is the wrong answer, quietly.
        if(Object.keys(got).length < b.length) short += b.length - Object.keys(got).length;
      }
      done++;
      if(onProgress) onProgress({ phase: "containment", done, total: batches.length });
    });
    if(short){
      notes.push(`Intrepid returned containment for ${short} fewer ${
        short === 1 ? "car" : "cars"} than were asked about — those cars show no ` +
        `containment hold, which may not be true. Re-run the scan.`);
    }
  }

  /* ── service visit and logistics, per vehicle ── */
  let done = 0;
  const rows = await pool(cars, READ_CONCURRENCY, async c => {
    const [sv, lg] = await Promise.all([
      want.has("sv")
        ? intrepidGet(`/getScaServiceVisitByVin?vin=${encodeURIComponent(c.vin)}`).catch(() => null)
        : null,
      want.has("logistics")
        ? intrepidGet(`/getLogisticsHoldByVin?vin=${encodeURIComponent(c.vin)}`).catch(() => null)
        : null
    ]);
    done++;
    if(onProgress) onProgress({ phase: "holds", done, total: cars.length });

    const visits = Array.isArray(sv) ? sv : [];
    const logi   = Array.isArray(lg) ? lg : [];
    const camps  = containment[c.vin] || [];

    return {
      vin        : c.vin,
      model      : c.model || "",
      type       : c.vehicle_type || "",
      ownership  : c.ownership || "",
      category   : c.vehicle_category || "",
      fleetStatus: c.fleet_status || "",
      stage      : c.delivery_stage || "",
      delivered  : c.delivered === true,
      deliveredAt: c.delivery_date_epoch ? new Date(c.delivery_date_epoch * 1000).toISOString() : null,
      /* When the customer is booked to collect it — a plain "2026-08-13", not
         a timestamp, so it is passed through as the index wrote it rather
         than parsed into a Date and back out an hour off. Null means no
         appointment, which is what the Scheduled for delivery facet tests. */
      scheduledFor: (c.delivery_details && c.delivery_details.scheduled_delivery_date) || null,
      // Only the fields the board renders. The raw records carry customer
      // contact details that have no business leaving the server.
      visits: visits.map(v => ({
        id    : v.serviceVisitNumber || String(v.serviceVisitID || ""),
        svId  : v.serviceVisitID || null,
        opened: v.createDate || null,
        due   : v.estimatedCompletionDateTime || null,
        trt   : v.trtid || null,
        source: v.serviceVisitSourceID || "",
        /* Both filled in below — the ticket from SCA when it is connected, the
           VRI date from Intrepid's status log. Always present so a row has one
           shape whether or not either lookup found anything. */
        ticket: null,
        vriAt : null
      })),
      campaigns: camps.map(c2 => ({
        title   : c2.title || "",
        type    : c2.campaignType || "",
        status  : c2.campaignStatus || "",
        action  : c2.actionType || "",
        severity: c2.severity || ""
      })),
      logistics: logi.map(h => ({ reasonId: h.holdReasonId ?? null, note: h.holdNote || "" })),

      // Null unless the title facet was used — see FACETS.title. Absent means
      // "not looked up", which is different from "not known".
      title      : titles ? ((titles.get(c.vin) || {}).title || null) : null,
      refurb     : titles ? ((titles.get(c.vin) || {}).refurb || "") : "",
      inUseSince : titles ? ((titles.get(c.vin) || {}).inUse || null) : null,
      // { at, by, passedDate } once the VRI pass below has run; null when the
      // car has no receiving inspection on record here.
      vri        : null,
      /* Where Garage says the car is. The ids are what Garage knows; the name
         and which of the two it came from are worked out below. */
      trtId      : c.trt_id ?? null,
      vrl        : c.vehicle_routing_location ?? null,
      site       : "",
      siteExact  : false
    };
  });

  /* ── naming the site ──

     `trt_id` is the field that knows a car is standing at Collision rather
     than at the centre it routes to, and it is the reason this is worth
     showing at all. But it is NOT complete, and the shape of the gap is
     already documented on this board: of a Cypress scan, a large minority
     carry logistics codes not yet shed (8162, 16402 …) and a hundred or so
     carry nothing. Measured on 436 cars: 199 named, 84 on unnamed logistics
     codes, 107 empty.

     So a pill fed by `trt_id` alone would print "TRT 8162" — a number that
     tells nobody anything — on a fifth of the list, and nothing at all on
     another quarter.

     Hence two passes: use `trt_id` when the directory can name it, and fall
     back to the routing location, which is complete, when it cannot.
     `siteExact` records which happened, so the page can mark a car that is
     genuinely elsewhere without also marking every car whose trt_id simply
     has not caught up. */
  {
    const names = await siteNames(
      rows.flatMap(r => [r.trtId, r.vrl]), { offsiteTrtId });
    const named = id => {
      if(!id) return "";
      const n = names.get(Number(id)) || "";
      // A bare "TRT 8162" is the directory saying it does not know. Treat that
      // as no answer rather than as a name.
      return /^TRT \d+$/.test(n) ? "" : n;
    };
    for(const r of rows){
      const exact = named(r.trtId);
      r.site = exact || named(r.vrl);
      r.siteExact = Boolean(exact);
    }
  }

  /* ── what the ticket says, from the Service App ──

     Intrepid can say a car HAS a visit and nothing about what the visit is
     for; that detail lives in SCA and nowhere else. Only rows that already
     carry a visit get here, so this is bounded by how many cars are actually
     in for work rather than by the size of the centre: 40 visits in a 600-car
     scan is 40 trips through here, not 600.

     Skipped in silence when SCA is not connected. The board's other five
     columns have never needed it and a missing optional source must not turn
     a working scan into a failed one — the panel is where "connect SCA" gets
     said, not here. */
  if(want.has("sv")) await enrichVisits({ rows, trtId, onProgress, notes });

  return { query, total: total ?? cars.length, scanned: cars.length,
           rows, notes, kinds: [...want], sca: scaConnected() };
}

/* ─────────────── what each visit is for, and when it cleared ───────────────

   Two passes over the cars that have a service visit: SCA's ticket, then the
   receiving inspection. Lifted out of scanVehicles whole so that **Pending
   Inventory can open the same panel over the same data**. That tool shows an
   SV bubble on a card and hands the row straight to the Service Visits
   editor; if the two had separate copies of this, the two panels would drift
   and the second one would be a lie about the first.

   Takes rows that already carry `.vin` and `.visits[]` in the scan's shape,
   and fills `ticket` and `vriAt` on each visit in place.                    */
async function enrichVisits({ rows, trtId, onProgress, notes = [] }){
  if(scaConnected()){
    const withVisits = rows.filter(r => r.visits.length);
    /* Read defensively even though scaConnected() just said yes. This is the
       only optional source on the board, and the whole point of it being
       optional is that nothing it can do should be able to fail a scan that
       Garage and Intrepid already answered. */
    const tok = (() => { try { return scaToken(); } catch { return null; } })();
    if(withVisits.length && tok){
      let seen = 0, failed = 0, dropped = 0;
      await pool(withVisits, READ_CONCURRENCY, async r => {
        const got = await sca.ticketFor(tok, r.vin).catch(() => null);
        seen++;
        if(onProgress) onProgress({ phase: "tickets", done: seen, total: withVisits.length });
        if(!got){ failed++; return; }

        /* Matched on the visit number rather than the id, because the id is
           the one thing about these two systems that has never been proven
           identical. The number is a printed string on both sides.

           A visit SCA does not return keeps ticket:null, which the row renders
           as "no detail" — deliberately distinct from a visit whose ticket has
           no activities on it yet. One dead lookup must not read as one clean
           car. */
        const match = (list, v) => list.find(g => g.number === v.id)
                                || list.find(g => String(g.svId) === String(v.svId));
        for(const v of r.visits) v.ticket = match(got.open, v) || null;

        /* ── a visit SCA has finished with ──

           Enumeration comes from Intrepid, and Intrepid's copy of the status
           goes stale: 7SAYGDED5TA746273 / SV02D766C2 reads serviceVisitStatusID
           1 in Intrepid and 2 in SCA for the same visit, so a delivered car sat
           on the work list with its one concern closed.

           Dropped rather than shown greyed, because this is a list of work to
           do and Ed's rule on this board has always been open tickets only. A
           row whose only visit goes this way stops being flagged, which is the
           point — everything downstream counts r.visits.length.

           Only ever on SCA's explicit say-so. `closed` means SCA knows the
           visit and calls it done; merely being absent from `open` would also
           catch a visit SCA has never heard of, and that is a different fact
           worth keeping on screen rather than quietly deleting. */
        const before = r.visits.length;
        r.visits = r.visits.filter(v => v.ticket || !match(got.closed, v));
        dropped += before - r.visits.length;
      });
      if(failed){
        notes.push(`Service App detail failed for ${failed} of ${withVisits.length} ` +
                   `${failed === 1 ? "car" : "cars"} — those rows show the visit without its ticket.`);
      }
      if(dropped){
        notes.push(`${dropped} ${dropped === 1 ? "visit" : "visits"} closed in the Service App ` +
                   `${dropped === 1 ? "was" : "were"} left off — Intrepid still lists ` +
                   `${dropped === 1 ? "it" : "them"} as open.`);
      }
    }
  }

  /* ── when each of those cars cleared receiving ──

     Same population as the tickets: only cars with a visit, because that is
     the only row the date is shown on. See vriCompletions() for why this does
     not just read `vriPassedDate` off the COG record it already has.

     Intrepid is a required source, so unlike the SCA block this is not
     guarded on a connection — but it is still caught, because a car with no
     VRI date is a car with no VRI date and not a failed scan. */
  {
    const withVisits = rows.filter(r => r.visits.length);
    if(withVisits.length){
      const vri = await vriCompletions(trtId, withVisits.map(r => r.vin), onProgress)
        .catch(() => new Map());
      for(const r of withVisits){
        const hit = vri.get(r.vin) || null;
        r.vri = hit;
        // Repeated onto each visit so the row renderer can put it beside the
        // SV number without reaching back up to the vehicle.
        for(const v of r.visits) v.vriAt = hit ? hit.at : null;
      }
      const missing = withVisits.filter(r => !r.vri).length;
      if(missing){
        notes.push(`${missing} of ${withVisits.length} cars with a visit have no receiving ` +
                   `inspection on record at this centre — those show no VRI date.`);
      }
    }
  }

  return notes;
}

/* ─────────────────── when the car cleared receiving ───────────────────

   "VRI completed on" for a set of VINs, read from the vehicle status log.

   ── the field that looks right and is not ──

   The COG record carries `vriPassedDate`, it is free, it is already on the
   Cars on Ground sheet, and it reads exactly like the answer. It is not the
   answer: it is stamped at **Ready for Prep**, downstream of the inspection,
   and a car that goes round again gets it re-stamped. Measured on the 33
   Cypress service-visit cars that have both: exact on 17, and **up to 96 days
   late** on the rest — one car reads 2026-07-27 against a real inspection on
   2026-04-23. ZO-003 hit this first and found it matched on 1 of 684; the
   sample here is kinder and the conclusion is the same. Do not swap this
   function for the cheap field.

   The honest source is a `Receiving Inspection Completed` entry in
   `getVehicleStatusLogByVinWithPdiTask`, which needs the per-vehicle cog
   record id — NOT `shipment.ShipmentId` from the inventory list, which is the
   transport shipment and is shared by every car on the same truck.

   Two calls, neither of them per vehicle for the first: `getAllVehicleShipments`
   is batched 500 VINs to a call and is already how Cars on Ground works, then
   one status-log call per VIN. Only cars that have a service visit are asked
   about, so this tracks the visit count rather than the size of the centre.

   `trtId` genuinely filters the batched call — the same VINs return 0 records
   under another centre — so a car whose cog record lives elsewhere resolves to
   nothing and shows no date. That is the right failure: a blank means "not
   found", and inventing a date from the cheap field would mean the opposite. */

async function vriCompletions(trtId, vins, onProgress){
  const out = new Map();
  if(!trtId || !vins || !vins.length) return out;

  const recs = new Map();
  for(let i = 0; i < vins.length; i += COG_VIN_CHUNK){
    const chunk = vins.slice(i, i + COG_VIN_CHUNK);
    const got = await intrepidPost(
      `/getAllVehicleShipments?trtId=${encodeURIComponent(trtId)}`, { vins: chunk }).catch(() => null);
    for(const rec of Array.isArray(got) ? got : []){
      if(!rec || !rec.vin || !rec.id) continue;
      /* Two records for one VIN is a car that came, went and came back. The
         live one is the most recently touched — the same rule carsOnGround
         uses, and for the same reason. */
      const prev = recs.get(rec.vin);
      if(!prev || new Date(rec.updatedDate || 0) >= new Date(prev.updatedDate || 0)) recs.set(rec.vin, rec);
    }
  }

  let done = 0;
  await pool([...recs.values()], READ_CONCURRENCY, async rec => {
    const d = await intrepidGet(`/getVehicleStatusLogByVinWithPdiTask` +
      `?vin=${encodeURIComponent(rec.vin)}` +
      `&vehicleShipmentId=${encodeURIComponent(rec.id)}`).catch(() => null);
    done++;
    if(onProgress) onProgress({ phase: "vri", done, total: recs.size });

    const logs = (d && d.vehicleStatusLogs) || [];
    /* Intrepid returns the log NEWEST FIRST, so find() lands on the most
       recent inspection rather than the first. That is the one wanted: the
       question is when this car last cleared receiving, and a car re-inspected
       after repair cleared on the re-inspection.

       Anchored on "completed" — a "Receiving Inspection Pending" entry records
       who queued the car, not an inspection anybody did. */
    const vri = logs.find(e => /receiving inspection completed/i.test(e.vehicleCogStatusName || ""));
    if(!vri) return;
    out.set(rec.vin, {
      at: vri.createdDate || null,
      by: vri.createdBy || "",
      /* Carried for a caller that wants to show how far off the cheap field
         is, and as the evidence for why this function exists at all. */
      passedDate: rec.vriPassedDate || null
    });
  });

  return out;
}

/* holdReasonId → words. One call, cached for the process: the map is a dozen
   rows that change about never, and every logistics hold on the board needs
   it to render as anything but a number. */
let holdReasons = null;
async function logisticsHoldReasons(){
  if(holdReasons) return holdReasons;
  const rows = await intrepidGet("/getLogisticsHoldReasons").catch(() => null);
  holdReasons = {};
  if(Array.isArray(rows)) for(const r of rows) holdReasons[r.holdReasonId] = r.description;
  return holdReasons;
}

/* ─────────────────────────── Cars on ground ───────────────────────────

   The board's second tool, and the only one that answers from Intrepid
   alone. Its question — what is standing at this centre, and where is each
   car in the receiving ladder — has no Garage equivalent: the COG status is
   Intrepid's own workflow state, written by the people walking the lot.

   Three calls for a whole centre, none of them per vehicle:

     getCogInventoryCars     every car on ground at the TRT. No date in the
                             query, so it cannot miss a car the way the
                             appointment list does — see the note on
                             enumeration in the README.
     getAllVehicleShipments  POST {vins}, the COG record per VIN in bulk.
                             `vehicleCogStatusId` lives here and nowhere in
                             the inventory row.
     getVehicleStatusOptions id → name for that status.

   Because nothing is per-vehicle this tool has no scan cap and no
   concurrency knob; a 700-car centre is about three seconds.              */

/* Intrepid's own page asks for 1,000. Asking for more is free and the reply
   is the same size when there is less, so the cap is raised and the caller
   is told when it is reached rather than quietly handed a short list. */
const COG_PAGE = 5000;

/* getAllVehicleShipments takes the VIN list in the body, so the only reason
   to split is to keep one request from being enormous. 700 in one call is
   fine in practice; this is a guard, not a tuning knob. */
const COG_VIN_CHUNK = 500;

/* id → name, from Intrepid rather than from a copy kept here.

   Deliberately no hardcoded fallback. The ids are stable, but a status
   renamed upstream and still rendered under its old name here would be a
   quiet lie on a screen someone makes decisions from — better to fail and
   say the source is unreachable. */
/* ── house names ──
   Intrepid writes "Receiving Inspection Pending"; nobody at a centre says
   that. They are VRIs — Vehicle Receiving Inspection — so that is what the
   board calls them.

   The rename is display-only and lives in one place. Intrepid's own string is
   kept beside it as `apiName`, because the moment the two are conflated
   someone greps the board for what Intrepid actually returned and finds the
   nickname instead. Nothing keys on either string: the status is matched by
   id everywhere it matters. */
/* The time windows the tool offers, in hours. Declared here rather than on
   the page because the route validates against them: a window the menu never
   offered would hide most of a lot and read as an empty centre. */
const DWELL_WINDOWS = [24, 72, 168, 720];

const COG_LABELS = {
  "Receiving Inspection Pending": "VRI Pending"
};

let cogStatusCache = null;
async function cogStatuses({ refresh = false } = {}){
  if(cogStatusCache && !refresh) return cogStatusCache;
  const rows = await intrepidGet("/getVehicleStatusOptions");
  if(!Array.isArray(rows)) throw new Error("Intrepid returned no vehicle statuses");
  cogStatusCache = rows
    .filter(r => r && r.id != null)
    .map(r => ({
      id     : Number(r.id),
      apiName: String(r.name || ("status " + r.id)),
      name   : COG_LABELS[String(r.name)] || String(r.name || ("status " + r.id)),
      // displayOrder is the ladder's order, and it is not the id order:
      // "Too Dirty to Inspect" is id 11 but comes first.
      order  : Number(r.displayOrder || 999),
      enabled: r.enabled !== 0
    }))
    .sort((a, b) => a.order - b.order || a.id - b.id);
  return cogStatusCache;
}

/* Intrepid writes these without an offset — "2024-11-11T19:25:53" — and its
   own page reads them as local time. Matching that beats being cleverer than
   the source: the answers are in days, and an hours-wide timezone argument
   changes nothing anyone reads off this screen. */
function dwellSeconds(stamp){
  if(!stamp) return null;
  const t = new Date(String(stamp).replace(/Z$/, ""));
  if(isNaN(t)) return null;
  const s = Math.round((Date.now() - t.getTime()) / 1000);
  return s < 0 ? 0 : s;   // a clock skew should read as "just arrived", not negative
}

/* Hours below two days, days above. These cars dwell for months, so a label
   reading "4,081h" is technically true and useless. */
function dwellLabel(sec){
  if(sec == null) return "";
  const h = Math.floor(sec / 3600);
  if(h < 1)  return Math.max(1, Math.round(sec / 60)) + "m";
  if(h < 48) return h + "h";
  const d = Math.floor(h / 24);
  const r = h % 24;
  return d < 14 && r ? `${d}d ${r}h` : `${d}d`;
}

/* Everything standing at one centre, joined to its COG status.

   `statusIds` narrows what comes back; an empty list means every status,
   which is how the tool renders its own breakdown. The tally is always over
   the whole centre regardless, because "5 pending" only means something
   next to what the other 697 cars are doing.

   `maxDwellHours` narrows the same list by how long the car has been
   standing. A VRI-pending list at a real centre is mostly cars that have been
   there for months, and they bury the ones that arrived this morning — which
   are the ones anybody can still do something about. Null means no window,
   and the tally ignores the window for the same reason it ignores the status
   filter.                                                                  */
async function carsOnGround({ trtId, statusIds = [], maxDwellHours = null,
                              onProgress = () => {} } = {}){
  if(!trtId){
    const err = new Error("No TRT set — choose a centre in the top corner");
    err.needsTrt = true;
    throw err;
  }

  onProgress({ phase: "statuses" });
  const statuses = await cogStatuses();
  const nameOf = Object.fromEntries(statuses.map(s => [s.id, s.name]));

  /* The rung a car with no COG record lands on — see the join below.
     Found by name rather than by a hardcoded 1: the id is stable today, but
     a hardcoded one that silently stopped meaning this would put those cars
     on the wrong rung and nobody would see it happen. */
  const pending = statuses.find(s => /receiving inspection pending/i.test(s.apiName));

  onProgress({ phase: "inventory" });
  const inv = await intrepidGet(
    `/getCogInventoryCars?trtId=${encodeURIComponent(trtId)}` +
    `&matchStatus=&vehicleTypes=&pageSize=${COG_PAGE}`);
  const rawRows = Array.isArray(inv) ? inv : [];

  /* The inventory list repeats a VIN when a car has more than one shipment
     leg behind it. One car is one row here — a duplicate would be counted
     twice in the tally and read as two cars on the lot. */
  const cars = new Map();
  for(const r of rawRows){
    if(r && r.vin && !cars.has(r.vin)) cars.set(r.vin, r);
  }
  const vins = [...cars.keys()];
  const notes = [];

  if(rawRows.length >= COG_PAGE){
    notes.push(`Intrepid returned its maximum of ${COG_PAGE.toLocaleString()} inventory rows — ` +
               `there may be cars on ground this scan did not see.`);
  }
  if(!vins.length){
    return { trtId: Number(trtId), statuses, total: 0, matched: 0, tally: [],
             noRecord: 0, rows: [], notes: ["No cars on ground at this centre."] };
  }

  onProgress({ phase: "cog", total: vins.length, done: 0 });
  const cog = new Map();
  for(let i = 0; i < vins.length; i += COG_VIN_CHUNK){
    const chunk = vins.slice(i, i + COG_VIN_CHUNK);
    const got = await intrepidPost(
      `/getAllVehicleShipments?trtId=${encodeURIComponent(trtId)}`, { vins: chunk });
    for(const rec of Array.isArray(got) ? got : []){
      if(!rec || !rec.vin) continue;
      /* A VIN with two COG records is a car that came, went and came back.
         The live one is the most recently touched. */
      const prev = cog.get(rec.vin);
      if(!prev || new Date(rec.updatedDate || 0) >= new Date(prev.updatedDate || 0)){
        cog.set(rec.vin, rec);
      }
    }
    onProgress({ phase: "cog", total: vins.length, done: Math.min(i + COG_VIN_CHUNK, vins.length) });
  }

  const want = new Set((statusIds || []).map(Number).filter(n => !isNaN(n)));
  const maxSec = maxDwellHours ? Number(maxDwellHours) * 3600 : null;
  const counts = new Map();
  let noRecord = 0;
  /* Split, because the two hidden groups mean opposite things: `dwellOlder`
     is the filter doing its job, `dwellUnknown` is a car the filter had no
     grounds to judge. Lumping them would let a centre with no arrival stamps
     read as a quiet morning. */
  let dwellOlder = 0, dwellUnknown = 0;
  const rows = [];

  for(const vin of vins){
    const car = cars.get(vin);
    const rec = cog.get(vin);

    /* A car Intrepid has no COG record for counts as Receiving Inspection
       Pending, because that is what Intrepid's own page shows for it —
       getCogVehicleData defaults the status before it looks at anything.

       This board briefly reported those separately on the reasoning that a
       centre with no COG records at all would have its whole lot called
       "awaiting inspection". True, but beside the point: the screen the work
       is run off says pending, so a board saying 0 where that screen says 6
       is simply wrong, whatever the reasoning behind the 0. The distinction
       is kept per row and in a note instead of in the count. */
    const inferred = !rec || rec.vehicleCogStatusId == null;
    if(inferred && !pending) { noRecord++; continue; }   // no such rung: nothing honest to say
    if(inferred) noRecord++;

    const id = inferred ? pending.id : Number(rec.vehicleCogStatusId);
    counts.set(id, (counts.get(id) || 0) + 1);
    if(want.size && !want.has(id)) continue;

    const sec = dwellSeconds(car.arrivalTimeStamp);

    /* A car with no arrival stamp is dropped by a window rather than kept.
       "Under 24h" is a claim about the car, and an unknown dwell does not
       support it — keeping it would put a car that has stood for two years
       at the top of a list of this morning's arrivals. The count is carried
       out so the notice can say it happened. */
    if(maxSec != null){
      if(sec == null){ dwellUnknown++; continue; }
      if(sec > maxSec){ dwellOlder++; continue; }
    }

    const cogRec = rec || {};
    rows.push({
      vin,
      model    : car.model || "",
      type     : car.vehicleType || "",
      color    : car.color || "",
      statusId : id,
      status   : nameOf[id] || ("status " + id),
      // True when the status was inferred from the absence of a record
      // rather than read off one. Shown on the row; never changes the count.
      inferred,
      bay      : cogRec.bayLocation || "",
      arrived  : car.arrivalTimeStamp || null,
      dwellSec : sec,
      dwell    : dwellLabel(sec),
      soc      : car.stateOfCharge == null ? null : Number(car.stateOfCharge),
      logistics: car.logisticsStatus || "",
      hold     : car.hold || "",
      rn       : car.referenceNumber || "",
      itinerary: car.itineraryNumber || "",
      scheduled: car.scheduledDeliveryDate || null,
      vriPassed: cogRec.vriPassedDate || null,
      touchedAt: cogRec.updatedDate || null,
      touchedBy: cogRec.updatedBy || ""
    });
  }

  /* Longest-standing first: on a pending-inspection list that is the running
     order, not a preference. Cars with no arrival stamp sort last rather
     than to the top, where a null would otherwise put them. */
  rows.sort((a, b) => (b.dwellSec == null ? -1 : b.dwellSec) -
                      (a.dwellSec == null ? -1 : a.dwellSec));

  const tally = statuses
    .map(s => ({ id: s.id, name: s.name, count: counts.get(s.id) || 0 }))
    .filter(s => s.count > 0);

  /* Only the unknowns get a notice. The cars the window deliberately hid are
     the point of the window and are counted on the strip; saying "hid 400
     older cars" in a warning box would read as a problem rather than as the
     thing that was asked for. */
  if(dwellUnknown){
    notes.push(`${dwellUnknown} car${dwellUnknown === 1 ? " has" : "s have"} no arrival ` +
               `timestamp in Intrepid, so ${dwellUnknown === 1 ? "it is" : "they are"} not ` +
               `shown under a time window. Clear the window to see ${
               dwellUnknown === 1 ? "it" : "them"}.`);
  }

  if(noRecord && pending){
    notes.push(`${noRecord} of these have no COG record at all — Intrepid shows a car ` +
               `without one as ${pending.name}, and that is where they are counted. ` +
               `Each is marked on its row.`);
  }else if(noRecord){
    notes.push(`${noRecord} of ${vins.length} cars on ground have no COG record and ` +
               `Intrepid published no receiving-inspection status to put them on, ` +
               `so they are not counted anywhere above.`);
  }

  return {
    trtId  : Number(trtId),
    statuses,
    total  : vins.length,
    matched: rows.length,
    maxDwellHours: maxDwellHours ? Number(maxDwellHours) : null,
    dwellOlder, dwellUnknown,
    tally, noRecord, rows, notes
  };
}

/* ── counts the board puts in its strip ── */
function summarise(rows){
  const sv = rows.filter(r => r.visits.length);
  const ct = rows.filter(r => r.campaigns.length);
  const lg = rows.filter(r => r.logistics.length);
  const any = rows.filter(r => r.visits.length || r.campaigns.length || r.logistics.length);
  return {
    scanned    : rows.length,
    flagged    : any.length,
    serviceVisits: sv.length,
    containment: ct.length,
    logistics  : lg.length,
    both       : rows.filter(r => r.visits.length && r.campaigns.length).length,
    clear      : rows.length - any.length,
    rate       : rows.length ? Math.round(any.length / rows.length * 100) : 0
  };
}

/* ────────────────────────────── Tracker ──────────────────────────────────

   tracker.js holds the store, the sweep and the geometry, and opens no
   sockets. What lives here is everything that touches Garage: the two reads
   below, and the scan that turns a VIN or a delivery date into rows.       */

/* ── the live read, and the only thing it is better at ──

   The sweep does not use this: the index carries the same fix to within a
   metre (measured 0.1 m, 1.0 m and 1.0 m on three cars, back to back) for
   ~1/400th of the bytes. What the live read has that the index has not is
   `show_gps_reason` — the only field anywhere that says WHY a car has no
   position. On an undelivered Tesla-owned car it reads

     "vehicle is not delivered and under Tesla possession"

   and on a car that is not reporting GPS at all there is no lat, no lon and
   no reason either, which is itself the answer. So this is the per-VIN
   "read it now" and nothing more.

   A sleeping car answers 408 here. That is not an error worth throwing over —
   it is the honest reply "the car is asleep and there is nothing newer" — so
   it comes back as a result rather than as an exception. */
async function liveFix(vin){
  const v = String(vin || "").toUpperCase();
  if(!isVin(v)) throw new Error(`${vin} is not a VIN`);

  const page = await tesladexSearch({
    query: `vin:${v}`, fields: ["vin", "id", "delivered", "vpn_state"], size: 1
  });
  const row = (page.results || [])[0];
  if(!row || row.id == null){
    return { vin: v, ok: false, reason: "not in the Garage index" };
  }

  const res = await request(`${GARAGE}/vehicles/${row.id}/vitals`, {
    headers: { Cookie: garageCookie(), Accept: "application/json",
               "User-Agent": GARAGE_UA }
  });

  if(res.status === 401 || res.status === 403 ||
     (res.status >= 300 && res.status < 400)){
    const err = new Error("Garage session expired or rejected — sign in again");
    err.needsAuth = true;
    throw err;
  }
  /* Garage answers 408 for a car that is asleep. Reported, not thrown: the
     caller asked where a car is and "it is asleep" is an answer. */
  if(res.status === 408){
    return { vin: v, ok: false, asleep: true, delivered: Boolean(row.delivered),
             reason: "the car is asleep — nothing newer than the last fix" };
  }
  if(res.status !== 200) throw new Error(`Live vitals returned HTTP ${res.status}`);

  let body;
  try { body = JSON.parse(res.body); }
  catch { throw new Error("Live vitals did not return JSON — the session may be a sign-in redirect"); }

  const lat = Number(body.lat), lon = Number(body.lon);
  const has = Number.isFinite(lat) && Number.isFinite(lon);

  return {
    vin: v, ok: has,
    delivered: Boolean(row.delivered),
    vpnState : row.vpn_state || "",
    lat: has ? lat : null,
    lon: has ? lon : null,
    at : body.timestamp || null,
    /* Verbatim. It is Garage's own sentence about its own redaction rule, and
       paraphrasing it would put this board's words on Garage's decision. */
    gpsReason: typeof body.show_gps_reason === "string" ? body.show_gps_reason : null,
    /* A delivered car has to be named as delivered. Garage withholds the
       coordinates at handover, so "it is not reporting GPS" is true of the
       reply and false about the car — it reads as a fault to go and chase on
       a car that is doing exactly what it should. The delivered flag is
       already on the row above; not using it here was the whole bug. */
    reason   : has ? null
      : row.delivered
        ? "This car is delivered, so Garage no longer publishes its position — " +
          "that is the handover rule, not a fault on the car"
        : "Garage returned no coordinates for this car — it is not reporting GPS"
  };
}

/* ── when a car moved, for the times we do not know where ──

   Datatank keeps a GPS history and it carries no latitude and no longitude —
   that is the redaction, and it is why a path cannot be backfilled. What it
   does carry is a `source` on every snapshot, and `drive_ended` among the
   values, plus a heading and an elevation that move when the car does.

   So a path with a hole in it can at least say a drive happened there. This is
   one call for one car, never part of a sweep. */
const DRIVE_FIELDS = ["last_gps", "gps_hdg", "gps_elevation", "gps_accuracy", "valid_gps"];

async function driveEvents(vin, hours = 72){
  const v = String(vin || "").toUpperCase();
  if(!isVin(v)) throw new Error(`${vin} is not a VIN`);

  const page = await tesladexSearch({ query: `vin:${v}`, fields: ["vin", "id"], size: 1 });
  const row  = (page.results || [])[0];
  if(!row || row.id == null) return { vin: v, drives: [], rows: 0 };

  /* Repeated `fields[]` params and not one comma-joined value — the same Rails
     convention tesladexSearch obeys, and it fails the same silent way: a
     comma-joined `fields=` is accepted and answers with zero rows, which reads
     as "this car never drove" rather than as a malformed request. */
  const qs = [
    "hours=" + Number(hours),
    "asc=true",
    ...DRIVE_FIELDS.map(f => "fields[]=" + encodeURIComponent(f))
  ].join("&");

  const d = await garageGet(
    `/api/1/vehicles/${row.id}/vitals_snapshots/datatank_historical_vitals?${qs}`)
    .catch(() => null);

  // `response`, like every other Garage REST payload on this board.
  const rows = (d && d.response) || [];
  const drives = rows
    .filter(r => String(r.source || "") === "drive_ended")
    .map(r => ({ at: r.time || null, heading: r.gps_hdg == null ? null : Number(r.gps_hdg),
                 elevation: r.gps_elevation == null ? null : Number(r.gps_elevation),
                 accuracy : r.gps_accuracy == null ? null : Number(r.gps_accuracy) }));

  return { vin: v, hours, rows: rows.length, drives };
}

/* ── a VIN, or a day's deliveries ──

   Two ways in and they resolve to the same row shape.

   A VIN is answered about ANY car, delivered or not, for the same reason
   Service Visits answers a one-VIN lookup outside its own filters: looking at
   a car is not doing anything to it, and "no cars found" in reply to a VIN
   somebody is holding is the worst possible answer.

   A date goes through Intrepid's appointment list, which is what the centre's
   own delivery board reads. Its known gap — a car booked and then stuck may
   be absent from every date — does not bite here: this asks who is booked for
   Thursday, which is exactly the question that list answers. */
async function trackerScan({ vin = null, date = null } = {}){
  const notes = [];
  let vins = [];
  let scope;

  if(vin){
    const v = String(vin).trim().toUpperCase();
    if(!isVin(v)) throw new Error(`${vin} is not a VIN — 17 characters, no I, O or Q`);
    vins  = [v];
    scope = { kind: "vin", vin: v };
  }else{
    const d = String(date || "").trim() || todayLocal();
    if(!isDate(d)) throw new Error(`${date} is not a date — use YYYY-MM-DD`);
    const appts = await appointmentsOn(d, savedTrtId());
    vins = [...new Set(appts
      .map(a => String(a.Vin || a.VIN || a.vin || "").trim().toUpperCase())
      .filter(isVin))];
    scope = { kind: "date", date: d, appointments: appts.length };
    if(!vins.length){
      notes.push(`Intrepid has no delivery appointments at this centre on ${d}.`);
    }else if(appts.length !== vins.length){
      notes.push(`${appts.length} appointments on ${d} carried ${vins.length} distinct VINs.`);
    }
  }

  /* Garage is asked about every VIN regardless of how we got here, because
     the store cannot say whether a car has been delivered since the last
     sweep and the tracker must never keep recording one that has. */
  const meta = new Map();
  for(let i = 0; i < vins.length; i += 100){
    const chunk = vins.slice(i, i + 100);
    const page  = await tesladexSearch({
      query : "vin:(" + chunk.join(" OR ") + ")",
      fields: ["vin", "id", "delivered", "vpn_state", "model", "vehicle_type",
               "trt_id", "last_known_location",
               "delivery_details.scheduled_delivery_date"],
      size  : chunk.length,
      sort  : "vin:asc"
    });
    for(const r of (page.results || [])){
      if(r.vin) meta.set(String(r.vin).toUpperCase(), r);
    }
  }

  const t = trk.settings();
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = vins.map(v => {
    const g    = meta.get(v) || null;
    const path = trk.pathFor(v, { nowSec });
    const L    = g && g.last_known_location;
    const live = L && Number.isFinite(Number(L.latitude)) ? {
      lat : Number(L.latitude), lon: Number(L.longitude),
      t   : Math.floor(Number(L.timestamp)),
      acc : L.gps_precision == null ? null : Number(L.gps_precision),
      mode: L.transmission_mode || null
    } : null;

    return {
      vin       : v,
      inGarage  : Boolean(g),
      deviceId  : g && g.id != null ? String(g.id) : null,
      delivered : g ? Boolean(g.delivered) : null,
      vpnState  : g ? (g.vpn_state || "") : "",
      model     : g ? (g.model || "") : "",
      vehicleType: g ? (g.vehicle_type || "") : "",
      trtId     : g && g.trt_id != null ? g.trt_id : null,
      scheduled : (g && g.delivery_details &&
                   g.delivery_details.scheduled_delivery_date) || null,
      /* The freshest position Garage holds, and how old it is. The age is not
         optional and never rounded away: about one car in five is hours or
         days stale while sitting there `online`, so a position with no age
         beside it would read as "here, now" when it means "here, Thursday". */
      fix       : live,
      fixAgeSec : live ? nowSec - live.t : null,
      tracked   : Boolean(path),
      points    : path ? path.points.length : 0,
      stops     : path ? path.stops.length  : 0,
      metres    : path ? path.metresTravelled : 0,
      firstSeen : path ? path.firstSeen : null,
      pathDelivered: path ? Boolean(path.delivered) : false,
      deliveredAt  : path ? path.deliveredAt : null
    };
  });

  const missing = rows.filter(r => !r.inGarage).length;
  if(missing) notes.push(`${missing} of ${rows.length} are not in the Garage index.`);
  const del = rows.filter(r => r.delivered).length;
  if(del) notes.push(`${del} already delivered — tracking stops at handover, ` +
                     `because Garage stops publishing the coordinates.`);
  const untracked = rows.filter(r => !r.tracked && r.delivered === false).length;
  if(untracked){
    notes.push(`${untracked} have no recorded path yet. A path starts at the ` +
               `first sweep after tracking is switched on and cannot be filled ` +
               `in backwards — Garage keeps no location history.`);
  }
  if(!t.enabled){
    notes.push("Tracking is off, so nothing is being recorded. " +
               "Admin › Tracker to switch it on.");
  }

  return { scope, rows, notes, settings: t, status: trk.status() };
}

/* Everything tracker.js needs from Garage, handed over once. It never opens a
   socket itself, so this is the whole of its access. */
trk.init({
  tesladexSearch, buildQuery, savedTrtId, savedOffsiteTrtId,
  loadConnections, saveConnections
});

/* ──────────────────────────── connection tests ────────────────────────────
   Each returns {ok, detail} rather than throwing, so the panel can show every
   row's state at once instead of dying on the first failure. */

async function testIntrepid(trtId){
  /* Everything inside the try, including reading the cookie. intrepidCookie()
     THROWS when nothing is saved rather than returning empty, so a guard
     testing it for falsiness never fired and the throw escaped the whole
     checks route — which then failed as one error instead of showing which
     of the three sources was missing. That is the one screen someone opens
     when nothing works, so it has to survive its own bad news. */
  const trt = trtId || savedTrtId();
  try{
    intrepidCookie();
    // Any authenticated read proves the cookie; the reasons map is the
    // cheapest one and needs no TRT, so it works before a centre is chosen.
    const rows = await intrepidGet("/getLogisticsHoldReasons");
    if(!Array.isArray(rows)) return { ok: false, detail: "Unexpected reply from Intrepid" };
    return { ok: true, detail: `${rows.length} hold reasons${trt ? " · TRT " + trt : ""}` };
  }catch(err){
    // The thrown message already distinguishes "not connected" from
    // "rejected", so it is passed through rather than second-guessed.
    return { ok: false, detail: err.message };
  }
}

/* Reaches for real data rather than checking that a cookie exists. A stale
   Garage session is indistinguishable from a live one until something is
   asked of it — it answers the sign-in page with a 200. */
async function testGarage(){
  try{
    const p = await tesladexSearch({ query: PROBE, fields: ["vin"], size: 1 });
    return { ok: true, detail: typeof p.total === "number"
      ? `session live, ${p.total.toLocaleString()} vehicles in the index`
      : "session live" };
  }catch(err){
    return { ok: false, detail: err.needsAuth ? "Not signed in — connect Garage" : err.message };
  }
}

async function testTesladex(){
  try{
    const p = await callTool("tesladex_search", { query: PROBE, fields: ["vin"], size: 1 });
    if(p && p.error) return { ok: false, detail: String(p.error) };
    return { ok: true, detail: typeof p.total === "number"
      ? `index reachable, ${p.total.toLocaleString()} vehicles` : "index reachable" };
  }catch(err){
    return { ok: false, detail: err.needsAuth ? "Not signed in" : err.message };
  }
}

/* ── maintenance ── */

function resetBoard(){
  const cleared = [];
  for(const f of [CONN_FILE, path.join(HERE, ".trt-cache.json")]){
    try { if(fs.existsSync(f)) { fs.unlinkSync(f); cleared.push(path.basename(f)); } } catch {}
  }
  trtMap = null;
  holdReasons = null;
  cogStatusCache = null;
  return { cleared };
}

/* Never returns a credential — only whether one is present and how it looks,
   which is all the panel needs to render state. */
function connectionsSummary(){
  const c  = loadConnections();
  const gc = credstore.garageCookie("prod", (c.garageCookie || "").trim());
  const ic = credstore.intrepidCookie((c.intrepidCookie || "").trim());
  const garage = gc.value.trim();
  const cookie = ic.value.trim();

  /* Both sources report the same shape now, because both are the same kind of
     thing: a session cookie that is either present or not. There is no token
     expiry to render — a cookie stops working when it stops working, and the
     honest way to know is the check button rather than arithmetic on a clock. */
  return {
    trtId: savedTrtId(),
    intrepid: {
      set    : Boolean(cookie),
      hint   : cookie ? "…" + cookie.slice(-8) : "",
      looksOk: /cogs-authorization=/.test(cookie),
      detail : cookie ? (ic.source === "hub" ? "from the Hub" : "saved locally") : "not connected",
      source : ic.source,
      required: true
    },
    garage: {
      set    : Boolean(garage),
      hint   : garage ? "…" + garage.slice(-8) : "",
      looksOk: /s_garage_session=/.test(garage),
      detail : garage ? (gc.source === "hub" ? "from the Hub" : "saved locally") : "not connected",
      source : gc.source,
      signedIn: Boolean(garage),
      required: true
    },
    /* SCA is the odd one out in three ways, all of them deliberate: it signs
       in here rather than on the Hub, it is a bearer token rather than a
       cookie, and it is NOT required — without it the board loses the ticket
       text on a Service Visits row and nothing else. So it reports an expiry,
       which the cookies cannot, and required:false, which the cookies are
       not. */
    sca: (() => {
      const s = scaSaved();
      const live = sca.isLive(s);
      const mins = s ? Math.round(sca.msLeft(s.exp) / 60000) : 0;
      return {
        set    : live,
        stale  : Boolean(s) && !live,
        user   : s ? (s.user || "") : "",
        expires: s ? s.exp : null,
        detail : !s      ? "not connected"
               : !live   ? `expired — ${s.user || "signed in"}`
               : `${s.user} · ${mins > 90 ? Math.round(mins / 60) + "h" : mins + "m"} left`,
        required: false
      };
    })(),

    /* Tesla OS. Board-local like SCA, and not required for the same kind of
       reason — without it the board loses one whole tool rather than one
       column, but Service Visits and Cars on Ground are untouched.

       No expiry line, unlike SCA. That token is a JWT and states its own; this
       one is opaque, so the honest answer is who it belongs to and when it was
       captured. Whether it still WORKS is a question only the pipeline can
       answer, and osStatus() asks it — this summary stays synchronous because
       every other row here is. */
    os: (() => {
      const s = osSaved();
      return {
        set     : Boolean(s),
        user    : s ? (s.user || "") : "",
        name    : s ? (s.name || "") : "",
        title   : s ? (s.title || "") : "",
        since   : s ? (s.capturedAt || null) : null,
        detail  : s ? [s.user, s.title].filter(Boolean).join(" · ") || "connected"
                    : "not connected",
        required: false
      };
    })()
  };
}

/* ══════════════════════════════ Parts ══════════════════════════════════

   Bills a part onto an undelivered car and closes the ticket behind it —
   about twenty writes across five Service App services for one missing key
   card, which is the reason the tool exists.

   The endpoints are in parts.js and every one of them was captured off Ed's
   own clicks; what lives HERE is everything parts.js deliberately refuses to
   know: which cars may be written to, what order the writes go in, and what
   counts as proof that one landed.

   ── this tool closes tickets for real ──

   The Service Visits tool cancels a TSS *booking* and never touches a ticket,
   because a cancelled ticket disturbs billing. This one genuinely closes the
   activity and walks the visit to Delivered. That is the ask, and it is why
   every gate below fails closed and why the run is split in two at the point
   the user's own gesture splits it.

   ── the ordering is not stylistic ──

   Three steps in the captured run returned HTTP 200 while refusing, and each
   one is a precondition encoded below rather than a defensive guess:

     · the estimated completion time cannot be set before motion 29 Prepared
     · a technician cannot be saved against a correction that was removed
     · an activity cannot be updated after it has been removed

   Any of them would look like success to code that trusted the status line. */

/* ── the marker ──

   Every activity this tool creates carries `ZO004` in its narrative, and that
   is not decoration: it is how a ticket is recognised as ours on the way back
   in. Reload the page, close the tab, come back tomorrow — looking the VIN up
   finds the open visit, reads its lines, and resumes the one marked with this
   instead of opening a second ticket beside it. Ed's, and it is what makes
   the tool survive a refresh.

   Enforced rather than merely defaulted. The narrative is editable in Admin,
   and a run whose marker had been typed away would be invisible to the resume
   — so `markNarrative()` puts it back on if it is missing. */
const ZO_MARK = "ZO004";
const PARTS_NARRATIVE = `${ZO_MARK} - Missing Part`;

const markNarrative = t => {
  const s = String(t || "").trim() || "Missing Part";
  return s.toUpperCase().includes(ZO_MARK) ? s : `${ZO_MARK} - ${s}`;
};
/* The missing-key-card job this tool was built around, and the starting point
   for every run rather than a rule. Ed's words: it should default, and it
   should be editable exactly the way the Service Visits editor edits one. */
const PARTS_CORRECTION = { code: "17450306",
                           name: "Replacement Keys - Program (No Keys Present)" };
/* Ed's ask: some tickets refuse to close without customer repair notes and
   some do not care. This is what goes in when one is wanted. */
/* Written on EVERY run, not only when SCA asks for it. Some cars require a
   customer repair note and some do not, and the check that tells them apart
   is the one thing here whose answer flickered in the capture — so the tool
   stopped asking. Always writing one note is simpler than branching on an
   unreliable question, and an extra note is harmless where a missing one
   blocks the close. Ed's call and Ed's words, 2026-08-25. */
const PARTS_NOTE      = "parts added and billed out";

/* ── settings ──
   Admin › Part Picker. The site is the only one with no sensible default: SCA's
   trtbyterm search is name-only — it returns nothing for "17589" — so the
   board's saved TRT cannot be turned into an scaLocationID without somebody
   naming the centre once. Everything else defaults to the captured run and
   is editable. */
function partsSettings(){
  const c = loadConnections().parts || {};
  /* No `site` — it is not a setting. partsSite() derives it from the centre
     the board is pointed at; the Admin row that shows it is a readout the
     route resolves. A stale `c.site` left in the file by an older build is
     ignored rather than migrated: nothing reads it. */
  return {
    tech        : c.tech || { ...parts.DEFAULT_TECH },
    symptom     : c.symptom || { ...parts.DEFAULT_SYMPTOM },
    correction  : c.correction || { ...PARTS_CORRECTION },
    narrative   : c.narrative || PARTS_NARRATIVE,
    customerNote: c.customerNote || PARTS_NOTE
  };
}

function savePartsSettings(patch){
  const now = partsSettings();
  const next = { ...now };
  /* No `site` branch. It is derived from the nav's TRT now, and storing it was
     a live bug as well as a duplicate: this wrote `site: null` whenever Admin
     saved with the picker box empty, so editing the note text disarmed the
     whole tool without saying anything. */
  if(patch.tech !== undefined){
    next.tech = patch.tech && patch.tech.userId
      ? { userId: Number(patch.tech.userId), name: String(patch.tech.name || "").slice(0, 80) }
      : { ...parts.DEFAULT_TECH };
  }
  if(patch.symptom !== undefined && patch.symptom && patch.symptom.symptomCode){
    next.symptom = {
      symptomId  : patch.symptom.symptomId ?? null,
      symptomCode: String(patch.symptom.symptomCode),
      description: String(patch.symptom.description || "").slice(0, 200),
      hyper      : String(patch.symptom.hyper || ""),
      cosmetic   : String(patch.symptom.cosmetic || "")
    };
  }
  if(patch.correction !== undefined && patch.correction && patch.correction.code){
    next.correction = { code: String(patch.correction.code),
                        name: String(patch.correction.name || "").slice(0, 200) };
  }
  if(patch.narrative    !== undefined)
    next.narrative = String(patch.narrative || "").trim().slice(0, 200) || PARTS_NARRATIVE;
  if(patch.customerNote !== undefined)
    next.customerNote = String(patch.customerNote || "").trim().slice(0, 500) || PARTS_NOTE;

  saveConnections({ parts: next });
  return partsSettings();
}

/* Throws rather than defaulting. A Parts run against the wrong centre would
   open a ticket at somebody else's site, and "we guessed" is not a thing this
   should ever be able to say. */
/* ── the site follows the centre the board is set to ──

   Ed's: Part Picker works on whatever centre the Compiler is pointed at, so
   there is nothing to configure and nothing that can disagree with the nav.

   This used to be picked by hand in Admin, on the reasoning that SCA's site
   search is by NAME and so a TRT number could not be turned into an
   scaLocationID. Half right — `trtbyterm` really does return nothing for
   "17589" — but the board holds the NAME as well as the number, out of
   Intrepid's directory, and a name search returns rows carrying `trtid` to
   match on. Measured: "Tesla Service Houston-Cypress" → exactly one row,
   trtid 17589, and it carries scaLocationID, inventoryLocationID,
   scaLocationTypeID and functionID together.

   Matched on the trtid, never on the name: the name is only the search term.
   "Cypress" alone returns two centres, and picking the first would be a coin
   toss between them.

   Storing it was also a live bug — `savePartsSettings` wrote `site: null`
   whenever Admin saved with the picker empty, so editing the note text
   silently disarmed the whole tool.

   Cached per TRT for the run: partsSite() is called five or six times in one
   open-fill-close and the answer cannot change underneath it. Keyed by trtId,
   so moving the nav to another centre simply misses the cache. */
const PARTS_SITE_CACHE = new Map();

async function partsSite(){
  const trtId = Number(loadConnections().trtId || 0);
  if(!trtId){
    const e = new Error("No service centre chosen — pick one in the nav before running Part Picker");
    e.needsTrt = true; throw e;
  }
  if(PARTS_SITE_CACHE.has(trtId)) return PARTS_SITE_CACHE.get(trtId);

  const info = await trtInfo(trtId);
  const term = (info && (info.full || info.name)) || "";
  if(!term)
    throw new Error(`TRT ${trtId} is not in the site directory, so the Service App ` +
                    `cannot be asked for it by name. Intrepid may be disconnected.`);

  const rows = await scaSites(term);
  const hit  = (rows || []).find(r => Number(r.trtId) === trtId);
  if(!hit)
    throw new Error(`The Service App has no site for TRT ${trtId} (${term}). ` +
                    `Part Picker cannot run at this centre.`);

  const site = {
    scaLocationId      : Number(hit.scaLocationId),
    trtId              : trtId,
    locationId         : Number(hit.inventoryLocationId),
    inventoryLocationId: Number(hit.inventoryLocationId),
    scaLocationTypeId  : Number(hit.typeId ?? 1),
    functionId         : hit.functionId ?? null,
    name               : hit.name || term
  };
  PARTS_SITE_CACHE.set(trtId, site);
  return site;
}

/* ── the gate ──

   Fresh Garage read every time, exactly like the contact switch and the
   appointment cancel, and for the same reason: a stale tab's `delivered:false`
   is precisely the input that would do the damage. Fails closed on an index
   miss, a multi-match or an error. */
async function partsGate(vin){
  const und = await isUndelivered(vin);
  if(!und.ok)
    throw new Error(`Refusing to open a ticket: ${vin} ${und.why}. ` +
      `Parts is a pre-delivery tool only — nothing was changed.`);
  return true;
}

/* ── resolve a VIN into everything the tree needs ──

   Two Service App reads and one Garage read, no writes. Answers the VIN card
   and seeds the node defaults.

   The model id trap lives here: customerinformation/search reports
   `modelId: 17` for this car — the generic "Model Y" — while every downstream
   call means **36**, the "2025+ Model Y" generation, which is what
   correctiondetails lists as a separate model entirely. Symptom search,
   correction search, part search and both create bodies all want 36. It comes
   off the PROFILE read, never off the search. */
async function partsResolve(vin){
  const token = scaToken();
  const site  = await partsSite();

  await partsGate(vin);

  const found = await parts.findByVin(token, vin, site.scaLocationId);
  if(!found)
    throw new Error(`The Service App does not know ${vin} at ${site.name || "this centre"}. ` +
                    `A car it has never heard of has not been built yet.`);

  const prof = await parts.profileOf(token, found.userID, vin);
  const modelCode = prof && (prof.modelCode ?? (prof.vehicleDetails || {}).modelCode);
  if(!modelCode)
    throw new Error("The Service App gave no model code for this car, so nothing " +
                    "downstream can be searched for it");

  /* ── is one of ours already open on this car? ──

     Not a warning. An open visit is the ordinary case here — this tool clicks
     Create service visit, not Check in for immediate service — and the read
     was dropped for exactly that reason. It is back for the opposite purpose:
     to find a ticket THIS BOARD opened and hand it back so the run can carry
     on, instead of opening a second one beside it. Reload the page mid-run and
     the VIN box picks up where it left off.

     Recognised by the `ZO004` marker in the activity narrative, which
     `markNarrative` guarantees is there. A visit with open lines that are all
     somebody else's is not a resume and is not mentioned — it is simply not
     this tool's business. */
  let resume = null;
  try{
    const open = (await sca.visitsByVin(token, vin)).filter(v => sca.isOpenVisit(v));
    for(const v of open){
      const svid = v.serviceVisitID;
      const rows = await parts.visitActivities(token, svid, site).catch(() => []);
      const mine = (rows || []).find(w => {
        const a = w && w.activityDTO;
        return a && Number(a.activityStatusID) === 1 &&
               String(a.narrative || "").toUpperCase().includes(ZO_MARK);
      });
      if(!mine) continue;

      const a = mine.activityDTO;
      /* The correction id only exists once a part has been billed. Carried
         when it is there so a resumed run can still close; absent is simply a
         ticket that got as far as the tree and no further. */
      const corr = [].concat(mine.correctionPartDTO || [])[0];
      resume = {
        serviceVisitId: svid,
        serviceVisitNumber: v.serviceVisitNumber || "",
        activityId: a.activityID,
        activityNumber: a.activityNumber || "",
        activityCorrectionId: corr ? corr.activityCorrectionID : null,
        billed: Boolean(corr && [].concat(corr.partIns || []).length),
        narrative: a.narrative || ""
      };
      break;
    }
  }catch{ /* a lookup that cannot check is a lookup, not a failure */ }

  const set = partsSettings();
  return {
    vin,
    userId   : found.userID,
    modelCode: String(modelCode),
    modelId  : Number(prof.modelId ?? modelCode),
    owner    : `${found.firstName || ""} ${found.lastName || ""}`.trim(),
    model    : found.model || "",
    colour   : found.color || "",
    rn       : found.refereneceNumber || "",   // SCA's spelling
    site, resume,
    defaults : { symptom: set.symptom, correction: set.correction, tech: set.tech,
                 narrative: set.narrative, customerNote: set.customerNote }
  };
}

/* ── the searches behind the node cards ── */

const partsCorrectionSearch = (term, modelCode, vin) =>
  parts.correctionSearch(scaToken(), { term, modelCode, vin });

/* Search results carry their own stock figure. Ed's ask, and the reason it is
   affordable is that both count endpoints take a batch: one extra call each
   for the whole page rather than one per row. Price is left off here — it is
   a third round trip and the row is a choice, not a quote. */
async function partsPartSearch(term, modelId){
  const token = scaToken(), site = await partsSite();
  const found = await parts.partSearch(token, { term, modelId, site });
  return withStock(token, site, found);
}

/* Attaches free/on-hand/allocated to a list of {partNumber,…} rows.
   Stock must never take a search down: a row with an unknown count is
   honest, a search that failed because a count did is not. */
async function withStock(token, site, rows){
  const list = (rows || []).filter(r => r && r.partNumber);
  if(!list.length) return rows || [];
  const nums = [...new Set(list.map(r => r.partNumber))];
  const [details, alloc, reqs] = await Promise.all([
    parts.partDetails(token, site, nums).catch(() => []),
    parts.partAllocation(token, site, nums).catch(() => []),
    parts.partRequests(token, site, nums).catch(() => [])
  ]);
  const by = rows2 => {
    const m = new Map();
    for(const x of (Array.isArray(rows2) ? rows2 : []))
      m.set(String(x.partNumber || "").toUpperCase(), x);
    return m;
  };
  const D = by(details), A = by(alloc), R = by(reqs);
  return list.map(r => {
    const k = String(r.partNumber).toUpperCase();
    const d = D.get(k) || {}, a = A.get(k) || {}, q = R.get(k) || {};
    const onHand = d.quantity ?? null;
    const allocated = a.quantity ?? 0;
    return { ...r, onHand, allocated, requests: q.quantity ?? 0,
             free: onHand == null ? null : Math.max(0, onHand - allocated),
             binLocation: d.binLocation || null };
  });
}

const partsTechSearch = term => parts.userSearch(scaToken(), term);

/* sca.js's, unwrapped for the Parts node editor. The Service Visits editor
   reaches the same function through scaSetSymptom; both tools have to agree
   about what a symptom is, so neither gets its own copy. */
const scaSymptomDetail = args => sca.symptomDetail(scaToken(), args);

/* Keyed on the CORRECTION CODE, which is what makes the part propose itself
   rather than being typed. Flattened out of SCA's {role, variance, parts[]}
   grouping — the role rides along on each row because "Required" and
   "Vinspecific" are worth showing next to a part somebody did not choose.

   It is a suggestion and stays one: the key card is right often enough to
   offer and wrong often enough that the card carries a Remove and Replace
   beside it. */
async function partsRecommend(vin, modelId, correctionCode){
  const token = scaToken(), site = await partsSite();
  const groups = await parts.partsRecommended(token, { vin, modelId, correctionCode, site });
  const flat = [];
  for(const g of (Array.isArray(groups) ? groups : []))
    for(const p of (g.parts || []))
      flat.push({ partNumber: p.partNumber, name: p.name || "",
                  status: p.partStatus || "", isSerialized: Boolean(p.isSerialized),
                  procurement: p.partProcurementType || "Allowed",
                  role: g.role || "", variance: g.variance || "" });
  return withStock(token, site, flat);
}

/* ── how many can I actually have ──

   Ed's correction, and it matters more than it looks. Swift's on-hand figure
   for a key card at Cypress is 2 and the answer on his screen is **nought**,
   because both are allocated to other jobs. On hand is not availability.

       free = onHand − allocated

   Measured live on three parts: key card 2 − 2 = 0 (matches his screen),
   mobile connector 17 − 0 = 17, superseded key card 0 − 0 = 0.

   Requests are a third number and are NOT subtracted — 13 outstanding
   requests against 2 cards is a backlog, not a claim on the shelf. Shown
   beside the count because it answers "and is more coming", never folded
   into it.

   The write is the exception: SCA's own createparts sends the ON-HAND figure
   as availableQuantity (18 when Swift said 18), so partsBuild echoes that and
   only the display uses `free`. Two numbers, two jobs. */
async function partsStock(partNumber){
  const token = scaToken(), site = await partsSite();
  const [details, prices, alloc, reqs] = await Promise.all([
    parts.partDetails(token, site, [partNumber]).catch(() => []),
    parts.partPrice(token, site, [partNumber]).catch(() => []),
    parts.partAllocation(token, site, [partNumber]).catch(() => []),
    parts.partRequests(token, site, [partNumber]).catch(() => [])
  ]);
  const pick = (rows, pn) => (Array.isArray(rows) ? rows : []).find(x =>
    String(x.partNumber || "").toUpperCase() === String(pn).toUpperCase()) || {};
  const d = pick(details, partNumber);
  const p = pick(prices,  partNumber);
  const a = pick(alloc,   partNumber);
  const q = pick(reqs,    partNumber);
  const onHand    = d.quantity ?? d.availableQuantity ?? null;
  const allocated = a.quantity ?? 0;
  return {
    onHand, allocated, requests: q.quantity ?? 0,
    free: onHand == null ? null : Math.max(0, onHand - allocated),
    partNumber,
    binLocation  : d.binLocation || null,
    description  : p.partDescription || d.partDescription || "",
    commodityCode: p.commodityCode || null,
    price        : p.unitPrice ?? p.adjustedUnitPrice ?? null,
    currency     : p.currencyCode || "USD"
  };
}

/* ── the pay-type rule ──

   Ed's rule, and the one place the tool is opinionated: always Transportation
   Damage; when it is not available, Rectification, and say so.

   It has to be asked of the ACTIVITY, not of the code and not of the
   vocabulary. `lookup/paytypes` is 25 entries and always contains both, so a
   check against it could never fail and the fallback could never fire.
   `correctiondetails` is better but still code-level — it listed 14 for this
   code. The per-activity call narrowed the same code to four. That is the
   only list that can decide this. */
async function partsChoosePayType(token, { activityId, correctionCode }){
  const allowed = await parts.payTypesFor(token, { activityId, correctionCode });
  const has = id => allowed.some(p => Number(p.id) === id);
  const nameOf = id => (allowed.find(p => Number(p.id) === id) || {}).name || "";

  if(has(parts.PAYTYPE_PREFERRED))
    return { id: parts.PAYTYPE_PREFERRED, name: nameOf(parts.PAYTYPE_PREFERRED), note: "" };

  if(has(parts.PAYTYPE_FALLBACK))
    return { id: parts.PAYTYPE_FALLBACK, name: nameOf(parts.PAYTYPE_FALLBACK),
             note: "Transport Damage not an option on this VIN, defaulting to Rectification" };

  throw new Error("Neither Transportation Damage nor Rectification is available on this " +
    "activity — the Service App offers only: " +
    (allowed.map(p => p.name).join(", ") || "nothing") + ". Nothing was billed.");
}

/* Finds one activity's wrapper in a visit-activities read. The read returns
   `{data:[{vin,userID,activityDTO,correctionPartDTO,…}]}` and the wrapper is
   what both update PUTs send back, whole. */
const wrapperFor = (rows, activityId) =>
  (rows || []).find(w => w && w.activityDTO &&
    Number(w.activityDTO.activityID) === Number(activityId)) || null;

/* ══ Step 1 — open the ticket ══  (the swipe, in the VIN dialog)

   Visit, contacts, activity. Split from the rest at Ed's line: the popup holds
   the VIN and one slide, and everything after happens on the page against a
   ticket that already exists.

   The split is not only a layout choice — it makes the pay type honest. Which
   pay types are legal is a question about an ACTIVITY, so while the activity
   was still hypothetical the tree could only promise Transportation Damage and
   find out afterwards. With the activity open before the tree is drawn, the
   Pay Type card reads the real answer and the Rectification fallback shows up
   before anything is billed rather than in the receipt. */
async function partsOpen({ vin, narrative }){
  const token = scaToken();
  const site  = await partsSite();
  const done  = [];
  const step  = (name, detail) => { done.push({ name, detail: detail || "" }); };

  /* Re-gated here and not trusted from the resolve: the dialog may have been
     on screen a while, and this is the last moment before a real write. */
  await partsGate(vin);

  const info = await parts.findByVin(token, vin, site.scaLocationId);
  if(!info) throw new Error(`The Service App no longer finds ${vin} — nothing was changed`);
  const prof = await parts.profileOf(token, info.userID, vin);
  const modelCode = String(prof.modelCode ?? (prof.vehicleDetails || {}).modelCode);
  const modelId   = Number(prof.modelId ?? modelCode);

  const fail = (whereAt, msg) => {
    const e = new Error(msg); e.partial = done.slice(); e.failedAt = whereAt; throw e;
  };

  /* 1 — the visit */
  const { serviceVisitId, caseId } =
    await parts.createVisit(token, { userId: info.userID, vin, modelCode, site });
  step("Ticket opened", `visit ${serviceVisitId}`);

  /* 2 — contacts to Tesla Motors Inventory.
     The board's own switch, not the captured savecontacts call: it does main
     AND billing AND the billing address, reads each one back, and reads the
     Tesla record off the car so a board at any centre writes the right one.
     The captured call hardcoded North America's. */
  try{
    const c = await scaSwitchContactToTesla({ vin, serviceVisitId });
    step("Contacts switched", c.now + (c.addressSet ? " · billing address set" : ""));
  }catch(err){
    fail("contacts", `The ticket opened as visit ${serviceVisitId}, but the contacts ` +
                     `could not be switched to Tesla: ${err.message}`);
  }

  /* 3 — the activity */
  let activityId = null, activityNumber = "";
  try{
    const a = await parts.createActivity(token, {
      userId: info.userID, vin, modelCode, site,
      // Marked here, at the one place an activity is created, so no caller can
      // produce a ticket this board will not recognise later.
      narrative: markNarrative(narrative || partsSettings().narrative) });
    activityId = a.activityId; activityNumber = a.activityNumber;
    await parts.attachActivity(token, serviceVisitId, activityId);
    step("Activity added", activityNumber || String(activityId));
  }catch(err){ fail("activity", err.message); }

  return { ok: true, vin, serviceVisitId, caseId, activityId, activityNumber,
           userId: info.userID, modelCode, modelId, site, steps: done };
}

/* Which pay types this activity will actually take, and which one the rule
   picks. Called from the page the moment a correction code is chosen, so the
   card can say "defaulting to Rectification" before the drag rather than
   after the bill. */
async function partsPayTypeFor(activityId, correctionCode){
  return partsChoosePayType(scaToken(), { activityId, correctionCode });
}

/* ══ Step 2 — fill it in and bill the part ══  (the drag, on the page)

   Symptom, correction, part, pick. Runs against a ticket that already exists,
   so `serviceVisitId` and `activityId` come in rather than being made here.
   Stops at the first step that cannot be proved and reports what already
   landed: these writes cannot be atomic, and a half-filled ticket must be
   reported as itself rather than as a failure that did nothing. */
async function partsFill({ vin, serviceVisitId, activityId, symptom, correctionCode, part }){
  const token = scaToken();
  const site  = await partsSite();
  const done  = [];
  const step  = (name, detail) => { done.push({ name, detail: detail || "" }); };

  await partsGate(vin);

  /* The ticket must still be the one the page thinks it is, on the car it
     thinks it is. A tab left open through a shift is exactly the input this
     is here for. */
  const visit = await sca.visitById(token, serviceVisitId);
  if(!visit || String(visit.vin || "").toUpperCase() !== String(vin).toUpperCase())
    throw new Error(`Visit ${serviceVisitId} is not on ${vin} — nothing was changed`);

  const prof = await parts.profileOf(token, visit.userId ?? visit.userID, vin)
    .catch(() => null);
  const modelCode = String((prof && (prof.modelCode ?? (prof.vehicleDetails || {}).modelCode))
                            ?? visit.modelCode);
  const modelId   = Number((prof && prof.modelId) ?? modelCode);

  const fail = (whereAt, msg) => {
    const e = new Error(msg); e.partial = done.slice(); e.failedAt = whereAt; throw e;
  };

  /* 1 — the symptom, onto the wrapper the visit read gives back.
     cosmeticIssue and hyperSymptom travel with the symptom and are not in the
     search results, so they come from the caller's resolved symptom (which the
     UI fills from the single-symptom GET) rather than being left behind. */
  try{
    const rows = await parts.visitActivities(token, serviceVisitId, site);
    const w = wrapperFor(rows, activityId);
    if(!w) fail("symptom", "The activity was added but the Service App did not list it back");
    w.activityDTO.symptomID          = symptom.symptomId ?? w.activityDTO.symptomID;
    w.activityDTO.symptomCode        = String(symptom.symptomCode);
    w.activityDTO.symptomDescription = symptom.description || "";
    w.activityDTO.hyperSymptom       = symptom.hyper || "";
    w.activityDTO.cosmeticIssue      = symptom.cosmetic || "";
    const up = await parts.updateActivity(token, w, { preventOverride: false });
    if(!up.ok) fail("symptom", `The symptom would not save — ${up.why}`);
    step("Symptom set", symptom.description || String(symptom.symptomCode));
  }catch(err){ if(err.partial) throw err; fail("symptom", err.message); }

  /* 2 — the correction code, with the pay type decided against THIS activity */
  let activityCorrectionId = null, payType = null;
  try{
    const det = await parts.correctionDetails(token, { correctionCode, modelCode, site });
    const val = await parts.validateCorrection(token, { correctionCode, site, modelId });
    if(!val.ok) fail("correction", `The Service App rejected that correction code — ${val.why}`);

    payType = await partsChoosePayType(token, { activityId, correctionCode });

    const rows = await parts.visitActivities(token, serviceVisitId, site);
    const w = wrapperFor(rows, activityId);
    if(!w) fail("correction", "Could not read the activity back to add the correction to it");
    w.correctionPartDTO = [parts.correctionLine(det, payType.id)];
    const res = await parts.updateCorrection(token, w);
    if(!res.ok) fail("correction", `The correction would not save — ${res.why}`);

    /* The id the rest of the run hangs off — the part is billed to it and the
       technician is saved against it. Read from the record, never assumed. */
    const back = await parts.visitActivities(token, serviceVisitId, site);
    const bw = wrapperFor(back, activityId);
    const line = ((bw && bw.correctionPartDTO) || [])
      .find(c => String(c.correctionCode) === String(correctionCode));
    activityCorrectionId = line && line.activityCorrectionID;
    if(!activityCorrectionId)
      fail("correction", "The correction saved but the Service App did not give it an id, " +
                         "so nothing can be billed to it");
    step("Correction set", `${det.name} · ${payType.name}` +
                           (payType.note ? ` — ${payType.note}` : ""));
  }catch(err){ if(err.partial) throw err; fail("correction", err.message); }

  /* 6 — the part */
  let partLine = null;
  try{
    const stock = await partsStock(part.partNumber);

    /* ── nothing free, nothing billed ──

       Ed's rule, and it is enforced here as well as on the page for the usual
       reason: the page checked when the part was chosen, and the shelf can
       move between choosing and dragging. Free is on-hand minus allocated —
       Cypress's two key cards are both spoken for, so the answer is nought and
       this refuses.

       It refuses BEFORE createparts, so a blocked part leaves a ticket with a
       correction and no line rather than a bad line to unpick. */
    if(stock.free != null && stock.free <= 0)
      fail("part", `${part.partNumber} is not in stock at ` +
        `${site.name || "this centre"} — ${stock.onHand ?? 0} on hand, ` +
        `${stock.allocated ?? 0} already allocated. Nothing was billed.`);

    const made = await parts.createParts(token, {
      activityCorrectionPartID: 0,
      partNumber: part.partNumber, allocatedPartNumber: part.partNumber,
      name: part.name || "", quantity: Number(part.quantity || 1),
      /* ON HAND here, not `free`. SCA's own createparts sends the shelf
         figure, and the display's availability calculation is a different
         question from what the line records. */
      availableQuantity: stock.onHand ?? 0, allocatedQuantity: 0,
      enabled: true, price: stock.price ?? 0,
      commodityCode: stock.commodityCode || "",
      isSerialized: Boolean(part.isSerialized), serialNumbers: [],
      isPhantom: false, quantityPicked: 0,
      partProcurementType: part.procurement || "Allowed",
      isDraftPart: false, isAutoAllocatePart: true, isApprovalRequired: false,
      partDiscount: 0, partDiscountType: 0, partSourceType: 1,
      servicevisitId: serviceVisitId, serviceVisitID: serviceVisitId,
      correctionCode: String(correctionCode), vin,
      activityId: String(activityId), locationId: site.locationId,
      carWontDrive: false, timeOffset: new Date().getTimezoneOffset(),
      activityCorrectionID: activityCorrectionId,
      isBatteryPack: false, modelCode,
      payTypeID: payType.id, userConfirmedDuplicateHVBOrder: false
    });
    partLine = made;
    step("Part billed", `${part.partNumber} · ${part.name || ""}`.trim());

    /* ── picking it, judged from the record ──

       The line is `isDraftPart: true` the moment createparts makes it, and a
       pick fired straight afterwards does not always take. SCA's own run left
       ~110 calls between the two. So: pick, read the line back, and if it is
       still unpicked wait and pick once more.

       The read-back is the point. A pick that answered ok and did not take is
       what put 48193134 three steps up the ladder before the close refused
       with "Please pick parts before closing the activity" — a message a long
       way from the thing that went wrong. */
    let pid = made && made.activityCorrectionPartID;
    const lineNow = async () => {
      const lines = await parts.partLinesOn(token, activityId, site).catch(() => []);
      return lines.find(p => pid
        ? Number(p.activityCorrectionPartID) === Number(pid)
        : String(p.partNumber) === String(part.partNumber)) || null;
    };

    // createparts normally returns the id; the record has it either way.
    if(!pid){
      const found = await lineNow();
      pid = found && found.activityCorrectionPartID;
    }

    if(!pid){
      step("Part NOT picked", "the Service App did not give the line an id to pick");
    }else{
      const attempt = async () => {
        await parts.prnDetail(token, serviceVisitId, [pid]).catch(() => null);
        return parts.pick(token, {
          serviceVisitId, activityId, activityCorrectionId,
          activityCorrectionPartId: pid,
          binLocation: stock.binLocation, isSerialized: Boolean(part.isSerialized)
        });
      };
      const isPicked = l => Boolean(l && Number(l.quantityPicked) >= Number(l.quantity || 1));

      let said = await attempt();
      let line = await lineNow();
      if(!isPicked(line)){
        await new Promise(r => setTimeout(r, 2500));
        said = await attempt();
        line = await lineNow();
      }

      /* Not fatal. The part is on the ticket either way, and an unpicked line
         is something to finish by hand — but it IS said plainly, because the
         close will refuse on it. */
      step(isPicked(line) ? "Part picked" : "Part NOT picked",
           isPicked(line)
             ? (stock.binLocation || "")
             : (said.why || "the line reads back unpicked") +
               " — the close will refuse until it is picked");
    }
  }catch(err){ if(err.partial) throw err; fail("part", err.message); }

  /* The customer repair note, written every time and never asked about.

     Some tickets refuse to close without one and some do not care, and the
     endpoint that tells them apart is the one call in the whole capture whose
     envelope `success` came back true on one request and false on the next
     identical one. Ed's call: stop asking. An extra note on a ticket that did
     not need one is harmless; a missing one blocks the close.

     Not fatal, and the same argument as the unpicked part above: the part is
     billed either way, and a note that failed to write is something to add by
     hand, not a reason to report a built ticket as a failure. It reads back
     off the record rather than trusting the 200 — this is SCA. */
  const noteText = partsSettings().customerNote;
  try{
    /* `/case/api/note/<activityId>` CREATES; it does not upsert. On an
       activity that already carries one it answers **HTTP 200 with
       success:false, "External notes exists for activity."** — proven live on
       125807826, which already had Ed's. That refusal is not a failure: what
       the close needs is A note, and there is one. So the answer comes from
       reading the activity back, never from the response to the write. */
    const wrote = await parts.addCustomerNote(token, activityId, noteText);

    /* The second half of SCA's own save, and only after a create that landed:
       firing it behind a refused write would record a generated/edited pair
       that does not match the note actually on the ticket. */
    if(wrote.ok)
      await parts.saveGeneratedNotes(token, activityId, noteText).catch(() => null);

    const back  = await parts.customerNoteOn(token, activityId).catch(() => null);
    const notes = Array.isArray(back) ? back : [];
    const mine  = notes.some(n => String(n.description || "").trim() === noteText.trim());

    if(mine)
      step("Customer note written", noteText);
    else if(notes.length)
      /* Somebody else's note, and it counts. Its text is printed rather than
         ours, because ours is not what is on the car. */
      step("Customer note already on the ticket",
           String(notes[0].description || "").slice(0, 120));
    else
      /* Worded with a NOT on purpose: `looksSkipped` on the page greys
         anything containing one, and a note SCA claimed to take but will not
         read back must not carry the same tick as one that is provably
         on the activity. */
      step("Customer note NOT confirmed",
           (wrote.why || "SCA accepted it") + " — but no note reads back; add one before closing");
  }catch(err){
    step("Customer note NOT written", `${err.message} — add it by hand before closing`);
  }

  return {
    ok: true, vin, serviceVisitId, activityId,
    activityCorrectionId, payType, part: partLine, steps: done,
    noteText
  };
}

/* ══ Cancel it ══  (the lever, top right)

   The undo for a ticket that should never have been opened. **This is the one
   tool on the board allowed to cancel a service visit**, and it is allowed
   because of what a Part Picker ticket is: something this board created
   minutes ago on an undelivered inventory car, with the contacts already
   switched off the customer. Nowhere else may do this — Service Visits
   cancels the TSS *booking* and leaves the visit alone, which is a different
   act with a different blast radius.

   It is still NOT `cancelServiceVisits`. That call answers 200 while flipping
   tickets to status 3 behind your back and is deleted from this board. SCA's
   own cancel is the ordinary motion PUT to 10 plus a reason record, and that
   is what this sends. See parts.js.

   Reason is fixed at **Parts delays** (feedbackCategoryID 30), Ed's call: a
   parts ticket cancelled from here is cancelled because the part did not
   happen. */
async function partsCancel({ vin, serviceVisitId }){
  const token = scaToken();
  const site  = await partsSite();
  const done  = [];
  const step  = (name, detail, skip) =>
    done.push({ name, detail: detail || "", ...(skip ? { skip: true } : {}) });

  /* Same gate as every other write here, and for the same reason: a stale tab
     is exactly the input that would cancel something real. */
  await partsGate(vin);

  const visit = await sca.visitById(token, serviceVisitId);
  if(!visit || String(visit.vin || "").toUpperCase() !== String(vin).toUpperCase())
    throw new Error(`Visit ${serviceVisitId} is not on ${vin} — nothing was changed`);

  if(Number(visit.serviceVisitMotionStatusID) === parts.MOTION_CANCELLED){
    step("Already cancelled", `visit ${serviceVisitId} was cancelled before this`, true);
    return { ok: true, vin, serviceVisitId, cancelled: true, steps: done };
  }

  const fail = (whereAt, msg) => {
    const e = new Error(msg); e.partial = done.slice(); e.failedAt = whereAt; throw e;
  };

  /* Straight to 10 first. SCA's own run went back to Preparation and then
     cancelled, but that visit was partway up the ladder; a ticket opened by
     mistake is still at 25 and the extra write is noise. The fallback is the
     captured order, used only when the direct move is refused. */
  let r = await parts.setMotion(token,
    { serviceVisitId, motion: parts.MOTION_CANCELLED, serviceVisitDateTime: null });
  if(!r.ok){
    const back = await parts.setMotion(token,
      { serviceVisitId, motion: 25, serviceVisitDateTime: null });
    if(back.ok) step("Returned to Preparation", "the direct cancel was refused");
    r = await parts.setMotion(token,
      { serviceVisitId, motion: parts.MOTION_CANCELLED, serviceVisitDateTime: null });
  }
  if(!r.ok) fail("motion:10", `The Service App would not cancel the visit — ${r.why}`);
  step("Visit cancelled", `visit ${serviceVisitId}`);

  /* The reason, and not fatal: a cancelled visit with no reason recorded is
     untidy, a visit left open because the reason failed is worse. */
  const fb = await parts.addFeedback(token, {
    serviceVisitId, category: parts.FEEDBACK.PARTS_DELAY,
    serviceVisitDateTime: visit.serviceVisitDateTime || null
  }).catch(err => ({ ok: false, why: err.message }));
  step(fb.ok ? "Reason recorded" : "Reason NOT recorded",
       fb.ok ? parts.FEEDBACK.PARTS_DELAY.text : fb.why);

  /* What actually happened, off the record. Cancelling a visit does NOT
     always cancel what is on it — measured on 48192893, where the courtesy
     line went to status 3 and the parts activity stayed at status 1 — so the
     lines are named individually rather than assumed away. */
  const after = await sca.visitById(token, serviceVisitId).catch(() => null);
  const cancelled = after
    ? Number(after.serviceVisitMotionStatusID) === parts.MOTION_CANCELLED
    : false;

  let openLines = [];
  try{
    const rows = await parts.visitActivities(token, serviceVisitId, site);
    openLines = (rows || []).map(w => w.activityDTO)
      .filter(a => a && Number(a.activityStatusID) === 1);
  }catch{ /* the visit is cancelled either way */ }

  if(openLines.length)
    step("Lines left open", openLines.map(a => a.narrative || a.activityNumber).join(", ") +
         " — back in outstanding work, not cancelled");
  else
    step("No lines left open", "nothing of this visit is still outstanding", true);

  return {
    ok: true, vin, serviceVisitId, cancelled,
    motion: after ? after.serviceVisitMotionStatusID : null,
    status: after ? after.serviceVisitStatusID : null,
    openLines: openLines.map(a => ({ activityId: a.activityID,
                                     number: a.activityNumber || "",
                                     narrative: a.narrative || "" })),
    steps: done
  };
}

/* ══ Step 3 — close it out ══
   The slider. Walks the ladder, drops the courtesy line, sets the technician,
   closes the activity and takes the visit to Delivered.

   The order below is the captured order and the three refusals in it are the
   reason it is not the obvious one: Prepared has to precede the estimated
   completion time, and the technician has to follow the removal rather than
   precede it. */
async function partsClose({ vin, serviceVisitId, activityId, activityCorrectionId,
                            technicianId }){
  const token = scaToken();
  const site  = await partsSite();
  const done  = [];
  /* The third argument marks a step the run deliberately did not take, so
     the page can grey it without having to read the wording. */
  const step  = (name, detail, skip) =>
    done.push({ name, detail: detail || "", ...(skip ? { skip: true } : {}) });

  await partsGate(vin);

  /* The visit must still be the one we built, on the car we think it is. */
  const visit = await sca.visitById(token, serviceVisitId);
  if(!visit || String(visit.vin || "").toUpperCase() !== String(vin).toUpperCase())
    throw new Error(`Visit ${serviceVisitId} is not on ${vin} — nothing was changed`);

  const fail = (whereAt, msg) => {
    const e = new Error(msg); e.partial = done.slice(); e.failedAt = whereAt; throw e;
  };

  /* ── the date the ladder has to carry ──

     There is nothing to echo. A Parts ticket is never booked, so the visit's
     `serviceVisitDateTime` is null and STAYS null: proven on 48193134, which
     sat at Prepared with a completion time already set and still refused
     Arrived for "The service visit date has to be provided". The first cut
     read the date off the record and carried it forward, which works for a
     booked visit and can only ever carry null here.

     SCA's own UI sends a value it makes up, and in the capture Ed typed it.
     **Ed's rule for every run from here: the last day of the current month.**
     That also corrects a number this file had guessed at — the captured
     completion time was 8/31 on a run made on 8/25, which read as "six days
     out" and would have been wrong on any other date of the month.

     One instant, TWO renderings, both copied rather than normalised: Arrived
     took `2026/8/25 19:45:00` and every step after it took
     `8/25/2026 7:45:00 PM`. Which of the two each step will accept is not
     knowable without spending another live ticket to find out. */
  const pad  = n => String(n).padStart(2, "0");
  const slashDate = d =>
    `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const usDate = d => {
    const h = d.getHours() % 12 || 12;
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ` +
           `${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
           `${d.getHours() < 12 ? "AM" : "PM"}`;
  };

  const now = new Date();
  // Day 0 of next month is the last day of this one, and it handles February.
  const stamp = new Date(now.getFullYear(), now.getMonth() + 1, 0,
                         now.getHours(), now.getMinutes(), 0, 0);

  /* A visit that DOES carry a date still wins — echoing a real booking beats
     overwriting it with the end of the month. */
  const booked    = visit.serviceVisitDateTime || null;
  const whenSlash = booked || slashDate(stamp);
  const whenUs    = booked || usDate(stamp);

  /* ── the ladder is resumable ──

     It used to start at Prepared every time, so a run that stopped halfway
     could not be finished: re-closing 48193134 from Service answered "Current
     motion status is Service, cannot change to Prepared" and the ticket was
     stranded where no button could reach it. A rung the visit is already past
     is skipped and said so, rather than re-sent and refused.

     A motion that is not on this ladder at all — a fresh visit sits at 25 —
     is not "past" anything, so the climb starts from the bottom. */
  const RUNGS = [29, 2, 8, 39, 7, 9];
  let atMotion = Number(visit.serviceVisitMotionStatusID);

  const climb = async (motion, name, withActivities, when) => {
    const here = RUNGS.indexOf(atMotion), target = RUNGS.indexOf(motion);
    if(here >= 0 && target >= 0 && target <= here){
      step(name, "already past this rung", true);
      return;
    }
    let r = await parts.setMotion(token,
      { serviceVisitId, motion, serviceVisitDateTime: when, withActivities });

    /* Delivered refuses until SCA has generated the final invoice, and the
       invoice is a side effect of the rungs below it rather than anything the
       board can ask for — there is no invoice WRITE anywhere in the capture,
       only reads. Measured on 48193134: refused at 02:56:0x, invoice
       3000S0018131692 existed at 02:56:19. So the answer is to wait for it,
       once, rather than to invent a call that generates it. */
    if(!r.ok && /invoice/i.test(r.why || "")){
      await new Promise(z => setTimeout(z, 6000));
      r = await parts.setMotion(token,
        { serviceVisitId, motion, serviceVisitDateTime: when, withActivities });
    }

    if(!r.ok) fail("motion:" + motion, `Could not set the ticket to ${name} — ${r.why}`);
    atMotion = motion;
    step(name, "");
  };

  /* 1 — Prepared, and only then the completion time. Prepared is the one step
     the capture sent with a null date, and the completion time is refused
     before it: "cannot be set before the Prepared Motion Status". */
  await climb(29, "Prepared", false, null);

  const etcText = usDate(stamp);
  const e1 = await parts.setEtc(token, serviceVisitId, etcText);
  step(e1.ok ? "Completion time set" : "Completion time NOT set", e1.ok ? etcText : e1.why);

  await climb(2, "Arrived", false, whenSlash);
  await climb(8, "Service", false, whenUs);

  /* 2 — every OTHER line on the ticket, whatever it is.

     Ed's rule, and the reason is what this tool is for: a Parts ticket exists
     to bill one part, so the only activity left on it should be the one the
     board put there. SCA's automation adds more than the courtesy inspection
     — 7SAYGDEE2TA680399 came up with a demo inspection as well — so "the
     courtesy line" was never the right name for this step even back when it
     did already remove them all.

     Safe to do unconditionally because `removeactivities` is not a cancel: it
     returns the line to OUTSTANDING WORK (SCA's own label for it,
     `activity_remove_and_return_to_outstanding_work`). The activity survives,
     detached from this visit, and can be picked up on another one.

     Removal comes BEFORE the technician: a correction on a removed activity
     refuses the owner save, and an update to a removed activity does not
     exist. */
  try{
    const others = async () => {
      const rows = await parts.visitActivities(token, serviceVisitId, site);
      return (rows || [])
        .map(w => w.activityDTO)
        .filter(a => a && Number(a.activityID) !== Number(activityId));
    };
    const name = a => a.narrative || a.activityNumber || String(a.activityID);

    const extra = await others();
    if(!extra.length){
      step("No other lines", "the ticket carries only the part line", true);
    }else{
      const named = extra.map(name).join(", ");
      await parts.removeActivities(token, serviceVisitId, extra.map(a => a.activityID))
        .catch(() => null);

      /* One stubborn line takes a whole batch with it, so whatever survived
         the batch is asked for on its own. Judged by re-reading the visit
         either way — this is SCA, and a 200 is not an answer. */
      let left = await others();
      if(left.length){
        for(const a of left)
          await parts.removeActivities(token, serviceVisitId, [a.activityID])
            .catch(() => null);
        left = await others();
      }

      step(left.length ? "Other lines NOT all removed" : "Other lines removed",
           left.length
             ? left.map(name).join(", ") + " — still on the ticket"
             : named);
    }
  }catch(err){ step("Other lines NOT removed", err.message); }

  /* 3 — the technician, against the correction that is still there */
  if(technicianId){
    const r = await parts.setOwner(token, activityCorrectionId, technicianId);
    if(r.ok){
      const owners = await parts.ownersOf(token, activityCorrectionId).catch(() => []);
      const got = owners.find(o => Number(o.ownerID) === Number(technicianId));
      step(got ? "Technician set" : "Technician NOT confirmed",
           got ? (got.ownerName || "") : "the Service App did not list them back");
    }else{
      step("Technician NOT set", r.why);
    }
  }

  /* 4 — close the activity, then the visit */
  const ca = await parts.closeActivity(token, activityId);
  if(ca.ok){
    step("Activity closed", "");
  }else{
    /* "Activity already closed" is a repeat, not a failure — the same
       resumability point as the ladder above, one level down. Judged from the
       record rather than the message: activityStatusID 2 is closed. */
    const w  = await parts.activityDetail(token, activityId, site).catch(() => null);
    const st = w && w.activityDTO ? Number(w.activityDTO.activityStatusID) : null;
    if(st === parts.ACTIVITY_CLOSED) step("Activity closed", "already closed", true);
    else fail("close-activity", `The activity would not close — ${ca.why}`);
  }

  await climb(39, "Service Complete", true, whenUs);
  await climb(7,  "Ready for Pick Up", false, whenUs);

  const ack = await parts.ackUnpaidBalance(token, serviceVisitId);
  if(ack.ok) step("Balance acknowledged", "");

  await climb(9, "Delivered", false, whenUs);

  /* The record, not the responses. Every write above judged on `success`; this
     is the only thing that proves the ticket is actually where it says. */
  const final = await sca.visitById(token, serviceVisitId).catch(() => null);
  return {
    ok: true, vin, serviceVisitId, steps: done,
    motion: final ? final.serviceVisitMotionStatusID : null,
    status: final ? final.serviceVisitStatusID : null,
    closed: Boolean(final && Number(final.serviceVisitMotionStatusID) === 9)
  };
}

module.exports = {
  CONFIG, loadConnections, saveConnections, adminPassword, savedTrtId, savedOffsiteTrtId,
  intrepidCookie, intrepidGet, intrepidPost, appointmentsOn,
  scaToken, scaConnected, scaSignIn, scaDisconnect, vriCompletions,
  /* Pending Inventory — Tesla OS. `osStatus` is async and probes; `osConnected` is the
     synchronous "is there a token at all" the scan guard uses. */
  osToken, osConnected, osStatus, osSignIn, osDisconnect, expScan,
  osSignInStatus: osx.signInStatus, osCancelSignIn: osx.cancelSignIn,
  osBrowserStatus: osx.browserStatus,
  /* Open Inventory — Pending Inventory's other half. No credential, so no
     connect/status/disconnect trio to go with it. */
  invScan, invFilters: opts => invx.filterSchema(opts),
  scaSites, scaSymptoms, scaRemoveActivity, scaSetSymptom,
  scaMoveVisit, scaCancelAppointment, scaSwitchContactToTesla, scaContacts,
  scaSetContact, scaSetAddress,
  billingAddress, saveBillingAddress,
  teamsConfig, saveTeamsWebhook, saveTeamsSettings, teamsSettings,
  /* SV Call — its own webhook beside the VRI one, and the two messages that
     go through it. Both check before they post. */
  svCallSettings, saveSvCallWebhook, sendSvCall, sendBodyCall,
  followUpSettings, saveFollowUpWebhook, sendFollowUp,
  postVriList, postVriControlCard, pushVri, teamsStatus, startTeamsLoop, stopTeamsLoop,
  scaVisitState, isUndelivered,
  /* Parts — the fifth tool. partsBuild is the drag, partsClose is the slider;
     everything else feeds the node cards. */
  partsSettings, savePartsSettings, partsSite, partsResolve,
  partsCorrectionSearch, partsPartSearch, partsTechSearch, partsRecommend, partsStock,
  scaSymptomDetail,
  partsOpen, partsFill, partsClose, partsCancel, partsPayTypeFor,
  scaPhotoStream: sca.photoStream,
  scaSignInStatus: sca.signInStatus, scaCancelSignIn: sca.cancelSignIn,
  scaBrowserStatus: sca.browserStatus,
  appointmentAdvisor, advisorsByRn,
  /* Tracker. The scan and the two Garage reads are here; the store, the sweep
     and the geometry are tracker.js, which this file initialised above. */
  trackerScan, liveFix, driveEvents,
  trackerSettings   : trk.settings,
  saveTrackerSettings: trk.saveSettings,
  trackerStatus     : trk.status,
  trackerSweep      : trk.sweep,
  trackerPath       : trk.pathFor,
  trackerForgetAll  : trk.forgetAll,
  startTrackerLoop  : trk.start,
  stopTrackerLoop   : trk.stop,
  cogStatuses, carsOnGround, dwellLabel, DWELL_WINDOWS,
  trtInfo, trtDirectory, searchSites,
  ensureSession, callTool, tesladexSearch, tesladexPage, dayRangeEpoch,
  garageCookie, signOutGarage,
  garagePost, garageIdsForVins, popTrunks,
  FACETS, HOLD_KINDS, buildQuery, scanVehicles, logisticsHoldReasons, summarise,
  SCAN_CAP,
  testIntrepid, testGarage, testTesladex,
  resetBoard, connectionsSummary,
  todayLocal, isDate, isVin
};

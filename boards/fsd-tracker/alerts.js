/* The Compiler's sibling problem, on this board: nobody notices a car that
   never drove on FSD until somebody remembers to open the dashboard.

   This module is the hourly Teams digest — the settings that describe when to
   post, the rule that decides whether this particular moment is a posting
   moment, the filter that picks the cars worth chasing, and the card they go
   out on.

   Everything here is PURE and STATELESS. No timers, no module-level mutable
   state, no clock of its own — `shouldFire` takes `now` as an argument. That
   is not stylistic: the scheduler's correctness is entirely contained in this
   file, and a decision that reads the clock itself can only be tested by
   waiting for it. Passing `now` in makes DST, sleep/resume and the
   exactly-once rule assertable in milliseconds.

   Deliberately NOT part of lib.js. lib.js requires this for the normalisers
   its settings summary needs — which is safe, because nothing here runs at
   import time — but the timer and the decision to actually POST live in
   server.js alone. The CLI loads lib.js, so that split is the only thing
   standing between a CSV run and a card in a Teams channel. Keep it: no
   timers, no state, no I/O except the explicit postToTeams call. */

"use strict";

const https = require("https");

/* ────────────────────────────── settings ────────────────────────────────
   Stored FLAT in .connections.json, never as a nested `alerts: {}` object —
   saveConnections is a shallow merge, so a nested object would be replaced
   wholesale by any patch that touched it and saving the webhook would
   silently blank the day list. */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DEFAULTS = { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };

// Sunday-first, matching Date#getDay, so the index IS the day number and
// nothing has to convert between two orderings.
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const normaliseTime = (v, fallback) => (TIME_RE.test(String(v || "")) ? String(v) : fallback);

/* Deduped and sorted, so two settings that mean the same thing compare equal
   and the panel always paints the week left to right. */
function normaliseDays(v){
  if(!Array.isArray(v)) return DEFAULTS.days.slice();
  const seen = new Set();
  for(const d of v){
    const n = Number(d);
    if(Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/* Alerts fire ON THE HOUR. The minutes are kept because <input type="time">
   emits them and because a later ":30" option should not need a settings
   migration — but nothing reads them, and the UI says so rather than leaving
   it to be discovered. */
const hourOf = t => Number(String(t).slice(0, 2));

function normaliseSettings(c){
  const conn = c || {};
  const start = normaliseTime(conn.alertStart, DEFAULTS.start);
  const end   = normaliseTime(conn.alertEnd,   DEFAULTS.end);
  return {
    on       : conn.alertsOn === true,
    webhook  : String(conn.alertWebhook || "").trim(),
    start, end,
    startHour: hourOf(start),
    endHour  : hourOf(end),
    days     : normaliseDays(conn.alertDays)
  };
}

/* A Power Automate URL copied through a shell is cut at the first `&`. It
   keeps the host and the path, loses the signature, and every post then
   fails 401 — which reads like a tenant policy problem rather than a
   truncated paste. The Charging Tracker learned this the expensive way; the
   `sig` test is the highest-value line in this file. */
const looksLikeFlowUrl = url => /^https:\/\//i.test(url) && /[?&]sig=/.test(url);

/* Returns a message string, or null when the settings are fine — the same
   shape the threshold route's inline checks use, so the page's api() helper
   surfaces it without any translation.

   Validated against the MERGED settings, not the patch: saving a start time
   of 18:00 has to be checked against whatever end time is already stored, or
   a two-field form becomes a way to persist an impossible window. */
function validateSettings(merged, patch){
  const p = patch || {};

  if(p.alertsOn !== undefined && typeof p.alertsOn !== "boolean"){
    // Not a truthiness test. A "false" string from a stale page is truthy,
    // and switching alerts ON by accident is the failure that posts to a
    // channel full of people.
    return "The alerts switch has to be on or off.";
  }
  if(p.alertWebhook !== undefined){
    const url = String(p.alertWebhook || "").trim();
    if(url){
      if(/\s/.test(url))            return "That webhook URL has a space in it — it was probably cut short when pasted.";
      if(url.length > 2000)         return "That webhook URL is too long to be real.";
      if(!/^https:\/\//i.test(url)) return "The webhook URL must start with https://";
      if(!/[?&]sig=/.test(url)){
        return "That URL has no sig parameter — it was almost certainly truncated at the first &. " +
               "Copy the whole thing from Power Automate.";
      }
    }
  }
  for(const [key, label] of [["alertStart", "start"], ["alertEnd", "end"]]){
    if(p[key] !== undefined && !TIME_RE.test(String(p[key] || ""))){
      return `Give the ${label} time as HH:MM on a 24-hour clock.`;
    }
  }
  if(p.alertDays !== undefined){
    if(!Array.isArray(p.alertDays)) return "Days must be a list.";
    for(const d of p.alertDays){
      const n = Number(d);
      if(!Number.isInteger(n) || n < 0 || n > 6) return "A day has to be 0 (Sunday) through 6 (Saturday).";
    }
  }

  const s = normaliseSettings(merged);
  /* An overnight window would double the branch count in the one function
     that has to be provably correct, and a delivery centre does not operate
     20:00 → 02:00. Refused rather than half-supported. */
  if(s.endHour < s.startHour){
    return "The end time has to be later than the start time — an overnight window is not supported.";
  }
  return null;
}

/* Only the keys that were actually sent, normalised. Feeding this to
   saveConnections rather than the raw patch means a day list always lands
   sorted and a time always lands well-formed. */
function cleanSettings(patch){
  const out = {};
  if(patch.alertsOn     !== undefined) out.alertsOn     = patch.alertsOn === true;
  if(patch.alertWebhook !== undefined) out.alertWebhook = String(patch.alertWebhook || "").trim();
  if(patch.alertStart   !== undefined) out.alertStart   = normaliseTime(patch.alertStart, DEFAULTS.start);
  if(patch.alertEnd     !== undefined) out.alertEnd     = normaliseTime(patch.alertEnd,   DEFAULTS.end);
  if(patch.alertDays    !== undefined) out.alertDays    = normaliseDays(patch.alertDays);
  return out;
}

// "Mon–Fri" when the selection is a run, "Mon, Wed, Sat" when it is not, so
// the boot log and the panel read the way a person would say it.
function dayLabel(days){
  const d = normaliseDays(days);
  if(!d.length)    return "no days";
  if(d.length === 7) return "every day";
  const run = d.every((n, i) => i === 0 || n === d[i - 1] + 1);
  return run && d.length > 2 ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}`
                             : d.map(n => DAY_NAMES[n]).join(", ");
}

/* ───────────────────────────── the schedule ─────────────────────────────
   A name for an hour, in local time — "2026-08-13T14". Not a timestamp.
   Everything this scheduler does correctly under sleep, clock drift and DST
   follows from that one choice, so it is worth being explicit about it.

   Built the same way todayLocal() builds a date (lib.js), so the hour an
   alert fires in and the date its report covers can never come from two
   different notions of "local". */
function hourKey(d){
  const t = d || new Date();
  const p = n => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}`;
}

/* The whole scheduling decision, as one pure function. Returns the hour key
   to post for, or null to do nothing.

   Because it compares a NAME rather than counting from a previous fire:

     · a laptop that sleeps at 08:30 and wakes at 11:20 posts ONCE, for hour
       11 — not three catch-up cards for the hours it slept through;
     · the hour that does not exist on a spring-forward morning never
       produces a key, so nothing is attempted for it, with no special case;
     · the hour that happens TWICE on a fall-back morning produces the same
       key twice, so the second is suppressed. One post per named hour. That
       is deliberate and is written down, because two would read as a bug.

   `!==` rather than `<`, so a clock set backwards costs at most one extra
   card instead of silencing the board until it catches up. */
function shouldFire(conn, now, lastHour){
  const s = normaliseSettings(conn);
  if(!s.on)      return null;
  if(!s.webhook) return null;
  if(!s.days.includes(now.getDay())) return null;

  const h = now.getHours();
  // End hour INCLUSIVE: 09:00–17:00 posts at 09,10,…,17. The end-of-day
  // check is the most useful one, and "nine to five" colloquially includes it.
  if(h < s.startHour || h > s.endHour) return null;

  const key = hourKey(now);
  return key === lastHour ? null : key;
}

/* ──────────────────────────── who is missing ────────────────────────────
   The exact inverse of summarise() in lib.js: that counts the cars which
   made the bar, this lists the ones that did not. Both read the same
   droveThreshold(), so they can never disagree about who passed. */

const MODEL_NAME = {
  "3": "Model 3", y: "Model Y", s: "Model S", x: "Model X",
  ct: "Cybertruck", cybertruck: "Cybertruck", cybercab: "Cybercab",
  semi: "Semi", roadster: "Roadster", my: "Model Y", m3: "Model 3"
};
// Same mapping the dashboard uses, so a VIN reads identically in the channel
// and on screen.
function modelLabel(raw){
  if(!raw) return "";
  const k = String(raw).trim().toLowerCase();
  if(!k) return "";
  return MODEL_NAME[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}

const hhmm = iso => {
  if(!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// 1 reads better than 1.0 for a whole-mile bar, which is the usual setting.
const trimNum = n => (Number.isInteger(Number(n)) ? String(Number(n)) : String(n));

function missingCars(rows, bar){
  const out = [];
  for(const r of rows || []){
    if(!r) continue;

    /* pool() in lib.js turns a THROWN error into { error, _item } — a row
       with no `vin` at all. The VIN is recovered from _item because "a car
       we could not read" is worth chasing and "a row we could not name" is
       not; a row with neither is counted by the caller and dropped here. */
    const vin = r.vin || (r._item && r._item.vin) || null;
    if(!vin) continue;

    const model = modelLabel(r.model || (r._item && r._item.model) || "");

    // Unmeasurable is not the same as under the bar, and it is not the same
    // as fine either — it is listed, marked, and left for a person to judge.
    if(r.error != null || r.miles == null){
      out.push({ vin, model, miles: null, unreadable: true,
                 advisor: r.advisor || "", deliveredAt: r.deliveredAt || null });
      continue;
    }
    // `>=` excludes, matching summarise() exactly: a car sitting on the bar
    // has driven, and must never appear on a chase list.
    if(r.miles >= bar) continue;

    out.push({ vin, model, miles: r.miles, unreadable: false,
               advisor: r.advisor || "", deliveredAt: r.deliveredAt || null });
  }

  /* Fewest miles first — the inverse of the dashboard's sort. The dashboard
     leads with the best story; an alert leads with the car that needs
     chasing hardest. VIN breaks ties so the same set renders in the same
     order every hour: a card that reshuffles between 10:00 and 11:00 reads
     as though the data moved when it did not. */
  out.sort((a, b) => (a.miles == null ? -1 : a.miles) - (b.miles == null ? -1 : b.miles)
                  || a.vin.localeCompare(b.vin));
  return out;
}

/* ────────────────────────────── the card ────────────────────────────────
   Teams caps an incoming payload around 28 KB and collapses a tall card
   behind "Show more", so rows past roughly the twelfth are unread by
   construction — rendering them spends the size budget on nothing. 12 sits
   above a normal day for one centre, so the cap normally never engages, and
   when it does that is itself worth knowing.

   A const rather than a setting: every knob is a thing that can be set
   wrong. */
const DIGEST_MAX = 12;

/* ── the naming rule, and where it does and does not apply ──

   The HOURLY DIGEST carries VINs and never a customer name or a reference
   number. It fires up to nine times a day into a channel, about cars that are
   simply mid-window, and a person's name repeated that often in that context
   is exposure with no purpose behind it. The team works from VINs anyway.

   The MORNING BRIEF is the deliberate exception, added 2026-08-25. It fires
   once, addresses a named advisor about their own customer, and the whole
   point of it is "go and talk to this person" — which does not survive being
   reduced to a VIN. Ed asked for the name and the name is the actionable part.

   That split is now ENFORCED rather than described. The previous version of
   this comment claimed "there is an assertion for this" and there was not one
   anywhere in the estate, which is how a rule quietly becomes a suggestion.
   assertNoPii below is that assertion, and digestCard calls it. */

const PII_KEYS = ["customer", "rn", "referenceNumber", "email"];

function assertNoPii(cars, where){
  for(const c of cars || []){
    for(const k of PII_KEYS){
      if(c && c[k]) throw new Error(
        `${where} was given ${k}="${c[k]}" — the hourly digest is VIN-only. ` +
        `If a card is meant to name customers it must be built by briefCard, not this one.`);
    }
  }
}

function carLine(c){
  const right = c.unreadable ? "no reading" : `${c.miles.toFixed(1)} mi`;

  /* Advisor goes on a subtle second line rather than a third column: at
     forty characters a name pushes the VIN to wrap on a phone, and the VIN
     is the field people copy. Absent entirely in basic mode — an empty slot
     reads as missing data rather than as a source that was never consulted,
     the same call the export makes. */
  const sub = [c.model, c.advisor || null,
               c.deliveredAt ? "handed over " + hhmm(c.deliveredAt) : null]
              .filter(Boolean).join(" · ");

  return {
    type: "ColumnSet", separator: true, spacing: "Small",
    columns: [
      { type: "Column", width: "stretch", items: [
        { type: "TextBlock", text: c.vin, fontType: "Monospace", wrap: true, spacing: "None" },
        ...(sub ? [{ type: "TextBlock", text: sub, isSubtle: true, size: "Small",
                     wrap: true, spacing: "None" }] : [])
      ]},
      { type: "Column", width: "auto", verticalContentAlignment: "Center", items: [
        { type: "TextBlock", text: right, weight: "Bolder", spacing: "None",
          color: c.unreadable ? "Warning" : "Attention" }
      ]}
    ]
  };
}

function digestCard({ site, trtId, date, bar, mode, total, cars, now, summary }){
  const list   = cars || [];
  assertNoPii(list, "digestCard");
  const shown  = list.slice(0, DIGEST_MAX);
  const hidden = list.length - shown.length;
  const unread = list.filter(c => c.unreadable).length;
  const under  = list.length - unread;

  /* The day in one number. Taken from summarise() rather than worked out
     here: that is the board's single definition of FSD adoption, and a card
     quoting a percentage the dashboard disagreed with would be worse than a
     card quoting none.

     Note the denominator is `resolved`, not `total` — a car whose mileage
     could not be read has not failed to drive, it has not been measured, and
     counting it as a failure would understate a day for a reason that has
     nothing to do with the day. Those cars are named on their own line
     instead. */
  const s        = summary || {};
  const resolved = Number(s.resolved) || 0;
  const drove    = Number(s.drove) || 0;
  const pct      = Number(s.adoption) || 0;

  const body = [
    { type: "ColumnSet", columns: [
      { type: "Column", width: "auto", items: [
        { type: "TextBlock", text: "🚗", size: "ExtraLarge", spacing: "None" }]},
      { type: "Column", width: "stretch", items: [
        /* Not "failed". At 09:00 this lists cars handed over forty minutes
           ago, and a heading that calls those a failure is how a channel
           learns to stop reading the card. */
        { type: "TextBlock", text: "Not yet driven on FSD", weight: "Bolder",
          size: "Medium", color: "Attention", spacing: "None" },
        { type: "TextBlock", text: "FSD Tracker | Powered by Zo' Projects",
          isSubtle: true, size: "Small", spacing: "None", wrap: true }]}
    ]},

    { type: "TextBlock", wrap: true, spacing: "Medium",
      text: `**${site || "TRT " + (trtId == null ? "—" : trtId)}** · ${date}`
          + (now ? ` · checked ${hhmm(now.toISOString())}` : "") },

    /* The headline metric, and the reason anyone opens the card twice: how
       much of the day is done. Given as a percentage AND as the fraction it
       came from, because a bare 85% hides whether the day was 39 cars or
       four — and at four cars a percentage is barely a number at all. */
    { type: "TextBlock", wrap: true, spacing: "Medium", size: "Medium",
      weight: "Bolder", color: pct >= 100 ? "Good" : "Default",
      text: resolved
        ? `${pct}% done · ${drove} of ${resolved} driven`
        : `Nothing measurable yet today` },

    { type: "TextBlock", wrap: true, spacing: "Small",
      text: `**${under}** ${under === 1 ? "car has" : "cars have"} not reached `
          + `**${trimNum(bar)} mi** on FSD`
          + (unread ? `, and ${unread} of ${total} could not be read.` : ".") },

    ...shown.map(carLine),

    ...(hidden ? [{ type: "TextBlock", isSubtle: true, wrap: true, spacing: "Small",
                    text: `…and ${hidden} more. Open the dashboard for the full list.` }] : []),

    { type: "TextBlock", isSubtle: true, size: "Small", wrap: true, spacing: "Medium",
      text: "Figures keep climbing until each car's window closes."
          + (mode === "advanced" ? ""
             : " Advisor names are unavailable — this check ran in basic mode.") }
  ];

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: { type: "AdaptiveCard",
                 $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                 version: "1.4", body }
    }],
    /* Flat copies alongside the card, so a hand-built flow can branch on the
       numbers without parsing an Adaptive Card. VINs only — no customer
       name, no reference number. */
    event: "fsd_missing",
    trtId: trtId == null ? null : trtId,
    site : site || null,
    date, threshold: bar, mode,
    // The same three numbers the headline is built from, so a flow can chart
    // the day without parsing a sentence back apart.
    total, resolved, drove, done: pct,
    missing: list.length,
    vins : list.slice(0, 50).map(c => c.vin)
  };
}

/* ═══════════════════════ the morning brief ═══════════════════════════════

   A different card with a different job. The hourly digest asks "who has not
   driven yet today"; this asks "who should you talk to before they leave".

   It goes out once, an hour before the doors open, and it says two things:
   where yesterday finished, and which of today's customers have never said
   they want FSD. An advisor reading it knows who to spend the day on and,
   just as usefully, who they can leave alone.

   Only the PERCENTAGE of yesterday travels, not the card — Ed was explicit
   about that. Yesterday's list is yesterday's problem and reprinting it every
   morning would bury the part that is actionable. */

/* Customers worth a conversation: intent stated nowhere on the order.

   `state === "none"` and nothing else. A row whose intent is null was never
   successfully asked — no reference number, no Tesla OS session, or an order
   the account cannot see — and naming that customer as uninterested would be
   a lie told to their advisor. Those rows are counted separately and reported
   as a caveat, never as people. */
function noIntentCustomers(rows){
  const out = [];
  for(const r of rows || []){
    if(!r || r.fsdIntent !== "none") continue;
    out.push({
      vin     : r.vin || "",
      model   : modelLabel(r.model || ""),
      customer: r.customer || "",
      advisor : r.advisor || r.host || r.hostUser || "",
      at      : r.deliveredAt || null
    });
  }
  /* In the order the day happens, so the brief reads like a schedule. A car
     with no handover time yet sorts last rather than first: it is the least
     urgent thing on the list, not the most. */
  out.sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity)
                  || a.vin.localeCompare(b.vin));
  return out;
}

const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* One line per customer, addressed to the advisor who owns them. The VIN
   rides along in the subtle line because it is still what the team looks a
   car up by, and the handover time because "before 10:00" changes the plan. */
function customerLine(c){
  const who = c.advisor || "Unassigned";
  const sub = [c.model, c.vin, c.at ? "handover " + hhmm(c.at) : null]
              .filter(Boolean).join(" · ");

  /* A name is not always resolvable — the order may not have reached Garage
     yet, or the lookup may have come back empty. The line is REWORDED rather
     than padded with a placeholder: "your customer this customer" is what
     a fallback string produces and it reads like a broken mail merge. The
     handover time identifies the person perfectly well to the one advisor
     this line is addressed to. */
  const subject = c.customer
    ? `your customer **${c.customer}**`
    : (c.at ? `your **${hhmm(c.at)}** handover` : "one of your handovers");

  return {
    type: "ColumnSet", separator: true, spacing: "Small",
    columns: [{ type: "Column", width: "stretch", items: [
      { type: "TextBlock", wrap: true, spacing: "None",
        text: `**${who}** — ${subject} does NOT have FSD Sub-Intent` },
      ...(sub ? [{ type: "TextBlock", text: sub, isSubtle: true, size: "Small",
                   wrap: true, spacing: "None" }] : [])
    ]}]
  };
}

/* Deliberately higher than the digest's twelve. This list is the reason the
   card exists rather than a supporting detail, and a centre with twenty
   deliveries wants all twenty names. Teams still collapses a tall card behind
   "Show more", which is an acceptable trade for not truncating the point. */
const BRIEF_MAX = 25;

function briefCard({ site, trtId, date, yesterday, cars, unknown, total, now, mode }){
  const list   = cars || [];
  const shown  = list.slice(0, BRIEF_MAX);
  const hidden = list.length - shown.length;
  const day    = DAY_FULL[(now || new Date()).getDay()];

  const y   = yesterday || {};
  const pct = Number(y.adoption) || 0;

  /* An empty list has three meanings and they are not interchangeable: nobody
     to chase, nobody delivering, or nobody checked. Reading them as the first
     is the failure this whole feature is built to avoid — a board that cannot
     reach Tesla OS would otherwise open the morning with "nothing to chase",
     which is the exact opposite of what is true. Ninety seconds after Tesla OS
     changes an endpoint, that sentence is a lie every advisor believes.

     `unchecked` is the honest form of it, and when it holds the footnote below
     is suppressed because this line has already said it, louder. */
  const cars_       = Number(total) || 0;
  const unknown_    = Number(unknown) || 0;
  const unchecked   = cars_ > 0 && unknown_ >= cars_;
  const checked     = Math.max(cars_ - unknown_, 0);

  const headline =
    list.length
      ? `**${list.length}** of today's ${list.length === 1 ? "customers has" : "customers have"} `
        + "not stated FSD Sub-Intent. These are the ones worth your time:"
    : unchecked
      ? `Sub-Intent could not be read for **any** of today's ${cars_} `
        + `${cars_ === 1 ? "car" : "cars"}, so this morning has no list — `
        + "assume nothing until the dashboard can reach Tesla OS again."
    : cars_ === 0
      ? "No deliveries on the board today."
    : unknown_
      ? `Nothing to chase among the ${checked} we could check.`
      : "Every one of today's customers already has FSD or has said they intend to subscribe. "
        + "Nothing to chase.";

  const body = [
    { type: "ColumnSet", columns: [
      { type: "Column", width: "auto", items: [
        { type: "TextBlock", text: "☀️", size: "ExtraLarge", spacing: "None" }]},
      { type: "Column", width: "stretch", items: [
        { type: "TextBlock", text: `Happy ${day}, team!`, weight: "Bolder",
          size: "Medium", spacing: "None" },
        { type: "TextBlock", text: "FSD Tracker | Powered by Zo' Projects",
          isSubtle: true, size: "Small", spacing: "None", wrap: true }]}
    ]},

    { type: "TextBlock", wrap: true, spacing: "Medium",
      text: `**${site || "TRT " + (trtId == null ? "—" : trtId)}** · ${date}` },

    /* Yesterday in one number and nothing else. `resolved` is carried with it
       for the same reason the digest carries it: a bare percentage hides
       whether the day was forty cars or three. */
    { type: "TextBlock", wrap: true, spacing: "Medium", size: "Medium",
      weight: "Bolder", color: pct >= 100 ? "Good" : "Default",
      text: y.resolved
        ? `We ended yesterday with ${pct}% FSD engagement`
        : "No measurable deliveries yesterday" },

    { type: "TextBlock", wrap: true, spacing: "Small",
      /* Not subtle, and coloured when it is a warning: the one line an advisor
         reads on a phone must carry the caveat, not sit above it. */
      ...(unchecked ? { color: "Warning", weight: "Bolder" } : {}),
      text: headline },

    ...shown.map(customerLine),

    ...(hidden ? [{ type: "TextBlock", isSubtle: true, wrap: true, spacing: "Small",
                    text: `…and ${hidden} more. Open the dashboard for the full list.` }] : []),

    /* Said out loud rather than folded into the count. A morning where the
       order service could not be reached must not read as a morning where
       everybody was already interested. */
    ...(unknown_ && !unchecked
        ? [{ type: "TextBlock", isSubtle: true, size: "Small", wrap: true,
             spacing: "Small",
             text: `${unknown_} of today's cars could not be checked for Sub-Intent, `
                 + "so they are not listed either way." }] : []),

    { type: "TextBlock", isSubtle: true, size: "Small", wrap: true, spacing: "Medium",
      text: mode === "advanced" ? "Have a great day."
          : "Advisor and customer names are unavailable — this ran in basic mode." }
  ];

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: { type: "AdaptiveCard",
                 $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                 version: "1.4", body }
    }],
    /* Flat copies alongside the card, as the digest does. VINs only out here —
       the names are in the card because that is what a person reads, but a
       flow branching on this data has no need of them. */
    event: "fsd_morning_brief",
    trtId: trtId == null ? null : trtId,
    site : site || null,
    date, mode,
    yesterdayDone: pct,
    yesterdayDrove: Number(y.drove) || 0,
    yesterdayResolved: Number(y.resolved) || 0,
    noIntent: list.length,
    unknown : unknown_,
    total   : cars_,
    /* Carried out here too, so a Power Automate flow branching on noIntent: 0
       can tell "clean morning" from "blind morning" without re-deriving it. */
    unchecked,
    vins: list.slice(0, 50).map(c => c.vin)
  };
}

function sampleBriefCard(summary){
  const now = new Date();
  return briefCard({
    site : "Sample — this is a test",
    trtId: summary && summary.trtId,
    date : now.toISOString().slice(0, 10),
    mode : "advanced",
    now,
    yesterday: { adoption: 90, drove: 27, resolved: 30 },
    unknown  : 1,
    total    : 3,
    cars: [
      { vin: "7SAYGDEE0PA000001", model: "Model Y", customer: "Sample Customer",
        advisor: "Sample Advisor", at: now.toISOString() },
      { vin: "5YJ3E1EA7KF000002", model: "Model 3", customer: "Another Customer",
        advisor: "Sample Advisor", at: now.toISOString() }
    ]
  });
}

/* The test button sends a real digest of invented cars rather than a "hello".
   The point of a test is to see the card the channel will actually get, at
   the width it will get it — a one-line message proves the URL works and
   nothing about whether the thing is readable. */
function sampleDigestCard(summary){
  const a = summary && summary.alerts;
  return digestCard({
    site : "Sample — this is a test",
    trtId: summary && summary.trtId,
    date : new Date().toISOString().slice(0, 10),
    bar  : (summary && summary.droveThreshold) || 1,
    mode : (summary && summary.mode) || "basic",
    total: 6,
    now  : new Date(),
    // Shaped like a real summarise() result: 6 cars, 5 readable, 3 of those
    // driven — so the sample shows the percentage working rather than a zero.
    summary: { resolved: 5, drove: 3, adoption: 60 },
    cars : [
      { vin: "7SAYGDEE0PA000001", model: "Model Y", miles: 0,    unreadable: false,
        advisor: a && a.on ? "Sample Advisor" : "", deliveredAt: new Date().toISOString() },
      { vin: "5YJ3E1EA7KF000002", model: "Model 3", miles: 0.4,  unreadable: false,
        advisor: "", deliveredAt: new Date().toISOString() },
      { vin: "7SAXCBE60PF000003", model: "Model X", miles: null, unreadable: true,
        advisor: "", deliveredAt: null }
    ]
  });
}

/* ───────────────────────────── the transport ─────────────────────────────
   Its own HTTPS POST rather than lib.request(), deliberately: that one pins
   port 443 and has NO socket timeout, and a webhook POST that hangs forever
   would wedge the scheduler's in-flight flag and silently kill every
   subsequent hour. This is the one call in the board that goes to a host
   nobody at Tesla controls, so it is the one that most needs a deadline. */
function postToTeams(rawUrl, payload){
  const url = String(rawUrl || "").trim();
  if(!url) return Promise.reject(new Error("No Teams webhook configured"));
  if(!/^https:\/\//i.test(url)) return Promise.reject(new Error("Teams webhook URL must be https"));

  let u;
  try { u = new URL(url); }
  catch { return Promise.reject(new Error("That webhook URL is not a valid URL")); }

  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method : "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        // Power Automate answers 200 or 202. Anything from 400 up is a
        // failure; the body is truncated because a flow error page is HTML.
        if(res.statusCode >= 400){
          return reject(Object.assign(
            new Error(`Teams webhook returned HTTP ${res.statusCode}: ${buf.slice(0, 200)}`),
            // A 5xx is worth one retry; a 401 from a truncated sig will be a
            // 401 again in twenty seconds.
            { status: res.statusCode, retryable: res.statusCode >= 500 }));
        }
        resolve(res.statusCode);
      });
    });
    req.on("error", e => reject(Object.assign(e, { retryable: true })));
    req.setTimeout(30_000, () => req.destroy(
      Object.assign(new Error("Teams webhook timed out after 30s"), { retryable: true })));
    req.write(body);
    req.end();
  });
}

/* One retry, and only for the failures that a retry can fix. A dead
   signature is not one of them. */
async function postWithOneRetry(url, payload, waitMs = 20_000){
  try {
    return await postToTeams(url, payload);
  } catch(err){
    if(!err.retryable) throw err;
    await new Promise(r => setTimeout(r, waitMs));
    return postToTeams(url, payload);
  }
}

module.exports = {
  DEFAULTS, DAY_NAMES, DIGEST_MAX,
  normaliseTime, normaliseDays, normaliseSettings, hourOf, looksLikeFlowUrl,
  validateSettings, cleanSettings, dayLabel,
  hourKey, shouldFire,
  modelLabel, missingCars, digestCard, sampleDigestCard,
  BRIEF_MAX, assertNoPii, noIntentCustomers, briefCard, sampleBriefCard,
  postToTeams, postWithOneRetry
};

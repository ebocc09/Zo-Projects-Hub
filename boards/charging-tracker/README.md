# Charging Tracker

A Supercharging dashboard that tracks **USOE** (usable state of energy) for one or more VINs
and watches each vehicle up to a target charge level.

Styled after Tesla.com, with flat 2D vector graphics instead of photography — a front silhouette
that changes state as the vehicle charges, with a Supercharger post behind it.

Works against **either Garage environment**: production (`garage.vn`) or engineering
(`garage.dev`), switched from the admin panel. Engineering turns the whole dashboard yellow and
draws a Cybercab instead of a Model 3, so a screenshot is never ambiguous about which fleet it
came from.

---

## What it does

Enter one or more VINs, press **Monitor**, and each vehicle joins the list:

| State | Car | Supercharger | Meaning |
|---|---|---|---|
| **Awaiting data** | Grey | Hidden | Just added, no baseline reading yet |
| **Charging** | Pulsing amber | Shown, cable plugged in | Latched and drawing power — or, without live read, USOE rose ≥0.3 |
| **Charge idle** | Grey | Shown but greyed out | Plugged in and not drawing — or, without live read, no gain this cycle |
| **Charge complete** | Green | Shown, cable unplugged | USOE reached the target level |
| **Charge complete + Latched** | Green, red **Latched** pill | Shown, cable still connected | Finished, but still on the charger — see below |

### How charging is detected

Two paths, chosen per reading.

**Live read on — measured.** Charging is read off the vehicle rather than deduced:

```
charging  =  CP_proximity is LATCHED          (a connector is in)
             AND ( BMS_packCurrent > 1.0 A    (power is flowing)
                   OR the charge level rose ) (corroboration)
```

Latch is the **gate, not the answer**. "Latched" only means a connector is present — equally true
of a car that has just finished, and of one plugged in and faulted. Treating latched as charging
would flip every completed-but-latched vehicle straight back to *Charging* and undo the reminders
below.

This is strictly better than inferring:

- Charging is known on the **first** reading. No baseline sample to establish first.
- The float-wobble problem disappears. A parked car reading 79.951 → 79.745 → 80.01 is
  `DISCONNECTED` at -0.5 A, so no rise can make it look like it started charging.
- **Plugged in but not drawing** becomes a real state instead of a timeout, and it does *not*
  decay to *Awaiting data* — being plugged in is something we can see, and a flat charge level is
  not an absence of information here.

The `OR the charge level rose` clause is a safety net: if `MIN_CHARGE_AMPS` is wrong for some
vehicle, a genuinely charging car is still caught by its own level going up, so a bad threshold
degrades to the old behaviour rather than breaking detection.

Only a reading from **this** cycle counts. `CP_proximity` is held over across a failed read — a
connector does not unplug itself — but "drawing power right now" is a question about this instant,
so a held-over latch never answers it. Without that rule a car that fell asleep mid-session
reported *Charging* forever.

**Live read off, or the vehicle asleep — inferred.** Unchanged: charging is claimed only on a
**rise** of at least 0.3 points. A falling reading means the car is being driven or the pack is
settling, so it stays idle. The floor clears sensor noise — live reads report full float precision
and wobble by hundredths, while real Supercharging produces +5 to +9 points between readings.
After **3** consecutive flat cycles the vehicle drops back to *Awaiting data*.

> **Why current alone can't work on the cached path.** `bms_current` *is* one of MCP's 1,292
> columns, but it is never sampled at a useful moment. Snapshots fire on state transitions, not
> during a session: one vehicle went **20.8% → 79.8%** — a full supercharge — with **zero** rows
> in between, the next row being `source: was_charging` carrying the final value at −1.6 A, already
> stopped. Worse, the strongest positive current in 48 hours was **+46.8 A** recorded while the
> charge level was *falling* during a drive — regenerative braking. A current rule on cached data
> would miss every real charge and fire on braking. The latch gate is what makes regen irrelevant
> on the live path: a car in a drive is not latched.

A completed vehicle stops being polled, and removes itself from the list automatically
after **2 refresh intervals** — long enough to notice, short enough to keep the board clean.

The bell in the top-right is an audit log. It records state changes only — vehicles added,
charging started, charging finished, vehicles removed, and fetch failures. Incremental
charge-level updates are deliberately *not* logged, because that would just be noise.

---

## Why USOE and not SOC

Garage exposes `SOC` and `USOE` as two separate vitals columns. `USOE` is the usable state of
energy — the customer-facing number shown on the vehicle display. This dashboard reads `USOE`
exclusively; `SOC` is never queried.

---

## Requirements

- **Node.js 18+** (portable install is fine — no admin rights needed, see below). The one-click
  Garage sign-in for live vitals wants **20+**, for the global `WebSocket`; everything else runs
  on 18.
- **Tesla network or VPN access**, and a Garage account with Standard Read Access

> **Sending this to someone? They need none of the above.** `node package-portable.js` builds a
> zip with a Node runtime inside it — unzip, double-click, done. See
> [Sharing this with someone](#sharing-this-with-someone).

Zero npm dependencies. Nothing to `npm install`.

### Node without admin rights

If you can't run installers, use the portable build:

```bash
curl -sSL -o node.zip https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip
powershell -Command "Expand-Archive node.zip -DestinationPath \"$HOME\nodejs\" -Force"
```

Then add `%USERPROFILE%\nodejs\node-v24.18.0-win-x64` to your **user** PATH
(Settings → *Edit environment variables for your account*). No elevation required.

macOS / Linux: `brew install node` or your distro's package manager.

---

## Running it

**Windows — just double-click `start-dashboard.bat`.** It finds Node (on PATH, or the portable
install under `%USERPROFILE%\nodejs`), starts the server and opens your browser.

Or from a terminal:

```bash
git clone <your-repo-url> charging-tracker
cd charging-tracker
node server.js
```

> **The dashboard only runs while that window is open.** It's a local server, not a background
> service — close the window or press Ctrl+C and it stops. Anyone using it needs it running on
> *their own* machine; you can't leave it running for other people.

Your browser opens automatically. The first run sends you to Bouncer to sign in; after that the
token is cached and refreshed silently. Then just go to:

```
http://localhost:3118
```

**Everyone who clones this runs their own copy and signs in as themselves.** There are no shared
credentials, and no one needs to leave a machine running for anyone else. You see exactly the
vehicles your own Garage permissions allow.

---

## Admin menu

Behind the **Admin** button, gated by a 6-digit code entered in a 2FA-style bubble input
(auto-advance, backspace, paste, auto-submit). Default code is `226565` — change it by editing
`ADMIN_PASSWORD` near the top of the `<script>` block in `index.html`.

> The replacement **must be exactly 6 digits**, or the bubble input can't produce it.

Locked, the dialog is a narrow code prompt. Unlocked, it widens into nine sections down a rail:

| Section | Contains |
|---|---|
| **Environment** | Production / Engineering switch, plus sign-in and live-read state for both |
| **Charging** | Target charge level, refresh interval, what happens to finished vehicles |
| **Data source** | Live Garage or simulation, endpoint, request throttle, main geofence TRT |
| **Live vitals** | One-click Garage sign-in for both environments, the live-read switch, and a paste box as a fallback |
| **Active Mode** | Mirror the main-TRT geofence into the list instead of typing VINs, and pick which vehicle categories it tracks — see [Active Mode](#active-mode) |
| **Deliveries** | Load a day's scheduled deliveries for the main TRT onto the list |
| **Low SoC** | Find undelivered cars parked at the TRT below a charge threshold |
| **Alerts** | Teams webhook and a test sender |
| **Maintenance** | Clear notifications, remove all vehicles, lock admin |

| Setting | Default | Notes |
|---|---|---|
| Environment | Production | Engineering reads `garage.dev`, needs its own sign-in |
| Target charge level | `80.0%` | Any value 1–100, to one decimal. Presets for 70/80/90/100. |
| Refresh interval | `5 minutes` | Minimum 5 seconds. Presets for 20s / 1m / 5m / 15m. |
| Request throttle | `4` / `150 ms` | Simultaneous requests, and the minimum gap between request starts |
| Auto-clear completed | On | Off keeps finished vehicles in a collapsible group instead |
| Main geofence TRT | `17589` | Vehicles elsewhere are tagged **Offsite** |
| Data source | Live | Live Garage, or Simulation for demos |
| Live vitals | Off | Real-time reads via a Garage session cookie. **Sign in** captures one for you; it switches itself on once that succeeds — see below |
| Teams alert webhook | — | Power Automate flow URL for charge-complete cards |
| Clear notifications | — | Empties the audit log |
| Remove all vehicles | — | Clears the current environment's monitoring list |

A red dot on a rail item means that section needs attention — the active environment is signed
out, or a live-read cookie has just expired.

Admin stays unlocked for the browser session; **Lock admin** ends it immediately.

### Confirmations

Anything that reaches outside the page asks first: **Refresh now**, **Remove all vehicles**, and
switching environment.

The refresh confirmation states the cost rather than warning in the abstract, because the same
button press is worth about 700 bytes with cached snapshots and about 140 KB *per vehicle* with
live read on — a setting two sections away. It shows the environment, the number of vehicles due,
which reading path is active, and the approximate download. In simulation mode it says plainly
that no Garage request is made.

There is deliberately **no way to switch these off**. A confirmation that can be dismissed
permanently stops being a confirmation the first time someone clicks through it — which is
precisely the moment it would have been worth reading.

While any overlay is open the page behind it is frozen, so a scroll gesture aimed at a settings
pane can't run away with the dashboard underneath.

> The password is a client-side convenience gate to stop casual fiddling with the settings.
> It is not a security boundary — the real access control is your Garage OAuth token, which is
> enforced server-side and scoped to your own permissions.

---

## Environments

Production and engineering are two entirely separate Garage instances — different hosts,
different authorization servers, different fleets:

| | Production | Engineering |
|---|---|---|
| Garage | `garage.vn.teslamotors.com` | `garage.dev.teslamotors.com` |
| Bouncer | `bouncer.vn.teslamotors.com` | `bouncer.dev.teslamotors.com` |
| OAuth client | `.client.json` | `.client.eng.json` |
| Token | `.tokens.json` | `.tokens.eng.json` |
| Live cookie | `.garage.json` → `envs.prod` | `.garage.json` → `envs.eng` |
| Vehicle list | `localStorage` `ct.vehicles` | `localStorage` `ct.vehicles.eng` |

Because those are separate authorization servers, **engineering needs its own sign-in** — being
signed into production says nothing about it. The Environment section shows both states side by
side with a **Sign in** link for whichever is missing.

Switching is instant and lossless. Each environment keeps its own vehicle list, so switching to
engineering doesn't discard what you were watching in production; switch back and it's still
there. Nothing is shared but the settings themselves — a refresh interval and a target charge
level mean the same thing in either world.

Every per-environment cache is separate too, so a VIN read in one is never answered out of the
other's cache. That matters more than it sounds: the same VIN can legitimately exist in both.

### Telling them apart

Engineering Garage is yellow-accented, so the dashboard follows it. Every red attribute becomes
yellow, an **Engineering** chip appears in the nav with an accent stripe along the top edge, the
browser tab is retitled, and the vehicle graphic changes from a Model 3 Highland to a Cybercab.

Teams cards from engineering carry an extra **Environment** fact. Production cards are unchanged,
so an engineering completion can't be mistaken for a real one.

### Pinning it

`GARAGE_ENV=prod` or `GARAGE_ENV=eng` locks the environment for that process — the switch is
disabled in the UI and the panel says why. Without it, the last choice is remembered in
`.garage.json`.

### Adding the engineering MCP server to Claude Code

Separate from the dashboard, and worth not confusing with it:

```bash
claude mcp add --scope user --transport http garage_engineering_na https://garage.dev.teslamotors.com/mcp
```

That gives **Claude Code** access to engineering Garage. The dashboard doesn't use it — `server.js`
holds its own OAuth registration and signs in independently. The two are unrelated paths to the
same instance.

---

## How the Garage connection works

Garage's MCP endpoint answers a CORS preflight without an `Access-Control-Allow-Origin` header,
so a browser page can never call it directly. `server.js` makes the call server-side instead.

Auth is the standard MCP OAuth flow, performed entirely by your local process:

```
1. GET  garage/.well-known/oauth-protected-resource   → discover Bouncer
2. GET  bouncer/.well-known/oauth-authorization-server → discover endpoints
3. POST bouncer/oauth/register                         → dynamic client registration
4. GET  bouncer/oauth/authorize                        → auth code + PKCE (S256)
5. GET  localhost:3118/callback                        → receive the code
6. POST bouncer/oauth/token                            → access + refresh token
7. POST garage/mcp                                     → JSON-RPC tools/call
```

Scope is `garage:mcp offline_access`; both Bouncers advertise it. This whole flow runs **once per
environment** — production tokens land in `.tokens.json` and its client in `.client.json`,
engineering in `.tokens.eng.json` and `.client.eng.json`. All four are gitignored and refused by
the static file handler. No secret is ever committed.

> The file mode is set to `0600`, which POSIX honours and Windows ignores — on NTFS these are
> protected by the ACL of your user profile instead. Either way they are per-user secrets.

The environment key rides in the OAuth `state` parameter, so `/callback` routes each code back to
the environment that started it and two sign-ins can be in flight in two tabs without colliding.

The actual data call is the `device_historical_vitals` MCP tool:

```json
{ "device_id": "<VIN>", "fields": ["USOE"], "hours": 6, "asc": false }
```

It reads cached Datatank snapshots, so **the vehicle does not need to be online** — you get the
most recent reading within the lookback window.

Two quirks of the real response, both handled in `extractUsoe()`:

- Rows come back **oldest-first even when `asc: false` is requested**, so the newest reading is
  selected by timestamp rather than by position.
- Timestamps are **naive UTC** (`"2026-07-29T03:20:30"`, no offset). The dashboard appends `Z`
  before parsing, otherwise they'd be read as local time and land in the future.

Snapshots are event-driven (`was_charging`, `drive_ended`, `wakeup`, `going_to_sleep`) rather than
on a fixed cadence, so each row shows **when the vehicle reported**, not when you polled. During an
active Supercharging session `was_charging` snapshots arrive frequently enough to drive the display.

### Configuration

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3118` | Dashboard + OAuth callback port |
| `GARAGE_URL` | `https://garage.vn.teslamotors.com` | Production Garage instance |
| `GARAGE_ENG_URL` | `https://garage.dev.teslamotors.com` | Engineering Garage instance |
| `GARAGE_ENV` | *(unset)* | Pin to `prod` or `eng` and disable the switch |
| `LOOKBACK_HOURS` | `6` | How far back to search for a USOE snapshot |
| `CACHE_TTL_MS` | `10000` | Minimum gap between Garage calls for the same VIN |
| `MAX_CONCURRENT` | `4` | Hard ceiling on concurrent Garage calls |
| `TEAMS_WEBHOOK_URL` | *(unset)* | Power Automate flow URL for Teams alerts |
| `TEAMS_DEDUPE_MS` | `7200000` | Window in which a repeat alert for a VIN is suppressed |

Other regions:

```bash
GARAGE_URL=https://garage-europe.vn.teslamotors.com node server.js   # Europe
GARAGE_URL=https://garage.vn.tesla.cn              node server.js   # China
```

Changing `PORT` re-registers the OAuth client, since the redirect URI changes.
Delete `.client.json` if you want to force a clean re-registration.

---

## Geofence tags

> **Offsite means "known to be elsewhere", never "unknown".** `getGeofences` returns `trtId: null`
> for a vehicle with no facility geofence — including any VIN Tesladex declined to return, which it
> records deliberately rather than re-querying every sweep. `isOffsite` therefore has to null-check
> before comparing: without it `Number(null)` is `0`, `0 !== mainTrt`, and every such car was badged
> Offsite. Active Mode also seeds `trtId` straight from the scan row, since the scan selected the car
> *by* its geofence, so an auto-added car knows where it is before the first geofence refresh lands.


Each vehicle is checked against the **Main geofence TRT** set in the admin menu (default `17589`,
Houston&nbsp;-&nbsp;Cypress). Anything at a different TRT — or in no facility geofence at all —
gets a light-purple **Offsite** pill next to its status badge. Hover it for the facility name and
TRT. Vehicles at the main site get no tag.

Read from Tesladex `trt_id` / `tesla_facility`, not from vitals: `GUI_trtId` exists as a vitals
column but is empty on customer cars, whereas Tesladex carries a populated facility block.

Lookups are **batched** — Tesladex accepts `vin:(A OR B OR C)`, so a 100-VIN list costs two
queries per sweep rather than a hundred, and results are cached for 5 minutes (`GEO_TTL_MS`).
A geofence failure is swallowed rather than allowed to disrupt charge monitoring.

## Completed vehicles

Controlled by **Auto-clear when finished** in the admin menu:

- **On** (default) — a finished vehicle drops off the list after 2 refresh intervals, exactly as
  before. Its footer counts down.
- **Off** — finished vehicles collect in a collapsible **Fully charged** group pinned to the
  bottom, showing a count and a **Clear all** action. Their footer reads *Ready to move* and they
  stay until you clear them.

Either way, a completed vehicle stops being polled the moment it reaches the target.

## Running 100+ VINs

A large list must not fire one request per VIN simultaneously. Two independent limits prevent that.

**In the browser** — a sweep runs at most `concurrency` requests in flight, and a global rate gate
starts no more than one request per `spacingMs`. At the defaults (4 / 150 ms) that's a ~6–7 req/s
ceiling, so 100 VINs are dispatched over ~15 seconds instead of all at once. The admin menu shows
a live estimate for your current list size, and warns in red if a sweep can't finish inside the
refresh interval.

**In the proxy** — `MAX_CONCURRENT` (default 4) is a hard ceiling regardless of what the browser
asks for, so several open tabs still can't fan out. Concurrent requests for the same VIN collapse
into a single Garage call.

If a sweep overruns the interval, the next tick is skipped rather than piling up, and the audit log
records it once. At 100 VINs, **keep the interval at 5 minutes** — that's ~20 req/min. Dropping to
60s would be ~100 req/min for data that, per the note above, mostly won't have changed.

> **Live vital pulls are deliberately not used.** In the snapshot data, every `vital_pull` row is
> preceded by a `wakeup` 10 seconds earlier — a live read *wakes the vehicle*. Across 100+ cars on
> a polling loop that would keep an entire fleet from sleeping. `device_historical_vitals` is a
> pure read of cached data with zero vehicle impact, which is why it's the only source used here.

## Active Mode

Hands-off monitoring. Instead of typing VINs, the dashboard mirrors the **main-TRT geofence**:
every refresh it scans the TRT, adds cars that have arrived, and drops the ones it added once they
leave. The offsite TRT is never scanned. It is session-only — a reload starts with it off.

### The board is empty either side of it

Turning Active Mode **on** clears the list, and turning it **off** clears it again. Both directions,
everything, including VINs you added by hand.

The alternative was carrying rows across the boundary, and it failed in both directions. Going in,
whatever you happened to be watching was absorbed into a geofence view and became indistinguishable
from it. Coming out, a few hundred scanned cars were left standing on a board that was no longer
mirroring anything — the mode was off, the pile-up stayed. Keeping hand-added rows through the
transition would fix neither: it just means reading a mixed list and having to remember which cars
came from where at the exact moment you are trying to answer a question about the lot.

So it is one rule with nothing to reason about. Both transitions confirm before clearing, and the
disable prompt is a red one showing the count, because a few hundred rows should not go on a
mis-click.

Three consequences worth knowing:

- **A reload drops the geofence cars too.** The mode is runtime state but the list is persisted, so
  a reload would otherwise strand its cars on a board with the mode off — the same pile-up by a
  different route. Anything flagged `viaActive` belongs to a mode that is not running, so it goes at
  boot, and a notice says how many. Hand-added rows are not flagged and survive a reload as before.
- **Switching environment drops them on the way out.** The switch already forces the mode off, so
  the outgoing list is cleaned before it is written, and the incoming one is cleaned after it is
  read. Otherwise coming back to an environment brought its old pile back with it.
- **The scan's own safety refusal clears too.** When it refuses because the server ignored the
  production filter, it is refusing precisely because it was about to take the whole lot; leaving
  the board populated would be the wrong end state. That path cannot stop to ask, so it does not.

Available in both environments, with **different scopes**, because the two lots are nothing alike:

| | Engineering | Production |
|---|---|---|
| Scanned | the whole geofence | undelivered cars of the **selected types** |
| Typical size | tens of cars | 342 at the TRT, 230 undelivered, **192** at the default selection |

### Choosing what gets tracked

**Admin → Active Mode → Vehicle types to track.** Every `vehicle_type` tag observed at the site is
a tick box, so a car that is on a post but not on the board can be explained — and picked up —
rather than guessed at. Three presets sit under the list: *Default*, *Deliveries only*
(customer + inventory), and *Everything undelivered*.

Measured at Houston-Cypress on 2026-08-14. These eight tags account for **all 230** undelivered
cars there — nothing at the site falls outside the vocabulary:

| `vehicle_type` | Count | Default | Why |
|---|---|---|---|
| `customer-vehicle` | 140 | **yes** | Undelivered cars with a customer attached |
| `inventory-vehicle` | 23 | **yes** | Undelivered stock, treated the same |
| `autonomous` | 29 | **yes** | Tesla-owned autonomy fleet — charged in the same rotation |
| `marketing-vehicle` | 17 | no | Demo / test-drive, lives here permanently |
| `service-loaner` | 15 | no | Loaner pool, lives here permanently |
| `internal-vehicle` | 3 | no | Staff and internal use |
| `mobileservice` | 2 | no | Mobile-service vans |
| `energy` | 1 | no | A mistag on one Cybertruck |

The four permanent-fixture categories are off by default because a car that never leaves is never
charged for a customer, and tracking it is spent capacity. They are one tick away.

> **`autonomous` was the blind spot.** The original allowlist was customer + inventory, and those
> 29 Tesla-owned Model Ys were invisible to the board while being charged like anything else — the
> "car on a post the tracker cannot see" this picker exists to end. It is on by default for that
> reason; untick it if the autonomy fleet is somebody else's problem.

The selection is persisted in `settings.activeTypes` and is **production only** — engineering scans
unfiltered, so the field is greyed out there with a note saying why. Changing it while Active Mode
is running rescans immediately: cars of a category you switch off leave the board on that scan,
rather than lingering until the next interval.

The list is an **allowlist, not a denylist** (`VEHICLE_TYPE_INFO` / `ACTIVE_TYPES_DEFAULT` in
`index.html`). Making it editable doesn't weaken that — the picker only offers ids from a fixed
vocabulary, and `server.js` rejects anything outside its own `VEHICLE_TYPES` whitelist with a `400`
before the value can reach a Lucene query. An empty selection is refused at both ends, because zero
types is not a narrower filter but the *absence* of one.

### Undelivered is not negotiable

`delivered:false` is a **floor, not a filter setting**. There is no combination of tick boxes that
reaches a delivered car, and the page cannot ask for one: the guard is applied server-side to every
production scan in `getTrtVins`, whatever the request body says.

> It did not used to be. `delivered:false` was pushed inside the `if(filtered)` branch, which made
> it a side effect of sending a type list rather than a rule — a body of `{trt}` alone took the
> unfiltered path and would have returned all **342** cars at the TRT, the 112 delivered ones
> included. Nothing this dashboard does concerns a delivered car, so the guard now sits outside that
> branch and the two scan shapes differ only in whether a type allowlist is added on top.

There is deliberately **no delivery-date cutoff**. A car booked three weeks out still charges before
it goes anywhere, and if it is on a post today you want to see it today. `vehicle_type` already
removes the cars that are never going out at all, which is the filter that was actually needed.

> **Do not filter on `ownership`.** It looks equivalent to `vehicle_type` and is not: 140 cars are
> `vehicle_type:customer-vehicle` but far fewer are `ownership:Customer`. The gap is Tesla-owned
> cars with real booked delivery dates this week, so filtering on ownership silently drops live
> deliveries. This was checked, not assumed.

### Polling

Every car on the list gets its own read each sweep, in both environments.

A tiered scheme was tried here and removed. Tesladex returns `USOE` in the same query that returns
the VIN — genuinely the same number the per-VIN cached path gives (verified against Datatank:
34.047483… vs 34.047, 15.612382… vs 15.612, 19.589552… vs 19.59) — so the whole lot can be read in
two requests, and the idea was to spend per-VIN reads only on cars whose bulk USOE had risen.

It cost more than it saved. The index moves **one value per sweep**, so a rise cannot be seen until
it shows up across *two* of them, and with the charging-only filter on the car sits `pending` and
**hidden** for that entire wait. Cars visibly on a charger did not appear. A per-VIN cached read
settles it in one go, because it carries the vehicle's own previous snapshot and the span to it, so
`histTrendUsable` can call the car charging immediately.

Request volume was never the binding constraint anyway: 192 cars at the default 4 / 150 ms is about
**29 seconds** of a five-minute interval, and even *Everything undelivered* — all 230 — is about
35 seconds. What the scan is still worth doing for is the geofence and the seed values — see below.

> **Watch live read at this scale.** Cached polling of a couple of hundred cars is cheap and touches
> no vehicles. Turning live read on is a different matter: each read is ~140 KB *and* wakes the car,
> so a full production lot would be woken every sweep — and widening the type selection widens that
> too. See the warning under [Running 100+ VINs](#running-100-vins).

### Skipping sleeping cars — production only

A charging vehicle is awake and talking to Hermes the whole time; the measured snapshot cadence
while charging is 8–12 minutes. A car parked and asleep can go hours without saying anything. So
**a car that is demonstrably asleep cannot have started charging**, and reading it is wasted — it
cannot have begun without waking up first.

The scan already carries `hermes_last_seen`, the vehicle's last Hermes contact. It is the same value
`device_info` reports as `last_seen` — confirmed identical on two cars — and its freshness tracks
`state: online`:

| Contact age | `device_info.state` |
|---|---|
| 3.3 min | **online** |
| 80 min | offline |
| 1042 min | offline |

Measured over the whole Houston lot at 1am: **118 tracked, 2 awake, 116 skipped.** The separation is
wide rather than marginal — the two awake cars had been seen 6.7 and 7.8 minutes ago, while the
median car had not been heard from in **4.5 hours**.

This matters most with **live read on**, where a read does not merely cost ~140 KB but actively
*wakes the vehicle*. Skipping sleepers is the difference between waking a handful of cars a sweep
and waking the entire facility.

**It is a stamp, not a heartbeat.** A vehicle contacts Hermes when it has something to say, so
`state: online` can sit on top of a `last_seen` that is several minutes old — the value did not
advance between two queries minutes apart on a car that was online both times. The threshold is
therefore not "is it online" but "has it checked in recently enough that we would have heard it
charging". `ASLEEP_AFTER_MS` reuses `HIST_MAX_AGE_MS` (45 min) rather than inventing a number: that
constant already means "how stale a vehicle's own snapshot may be before it stops counting as
evidence about right now", which is the identical question, and at ~4× the charging cadence it
leaves a charging car several check-ins of margin.

**It fails toward reading, never toward skipping.** A car is read anyway if it is already charging,
still latched, hand-added, or has no contact stamp at all. Missing a charging car is the bug this
dashboard exists to prevent; a needless read costs one request. Engineering is excluded entirely.

Unlike the removed USOE-delta gate, this has **no latency**: waking is instantaneous and visible on
the very next scan, so a car that plugs in is read on the next sweep. The skipped count is shown in
the progress line rather than left silent.

### What else the bulk scan is for

The scan runs once per sweep regardless, and two more things ride along on it for free:

- **Seed values** — a newly-added car shows a real USOE and model immediately instead of
  "awaiting data" until its first poll lands.
- **Geofence** — the scan selected the car *by* its `trt_id`, so location is known the moment the
  car appears, with no window where it could be mistaken for Offsite.

## Live vitals

**Off by default.** Everything reads Garage's cached snapshots, which is how the dashboard has
always worked and needs nothing beyond your Bouncer sign-in.

### Why you might want it on

Vehicles report vitals on their own state changes — `wakeup`, `going_to_sleep`, `drive_ended`,
`was_charging` — not on a schedule. Measured cadence:

| Vehicle state | Gap between readings |
|---|---|
| Actively charging | **8–12 minutes** |
| Parked | 10 minutes to over an hour |

So a completion card on cached data typically lands 10–15 minutes after the car actually crossed
its limit. Polling faster doesn't help: the number isn't there yet.

Live read fixes that. Garage's web UI reads current vitals from
`GET /vehicles/<numeric id>/vitals`, and with a session cookie this dashboard can call the same
endpoint. Readings come back stamped to the millisecond of the request.

### Turning it on

Admin → **Live vitals** → **Sign in** next to Production or Engineering. A separate Tesla sign-in
window opens; sign in there and the row goes green on its own, with live read switched on. That's
the whole thing — no DevTools, and nothing to paste.

Both environments share that one window, so once you've done Production, Engineering is usually
instant. If you close the admin panel — or the whole tab — mid-sign-in, the capture still
completes: the waiting happens in `server.js`, not in the page.

### The sign-in window

It is a **separate, isolated browser profile**, not your everyday one, and it has to be. Two
protections on modern managed Chrome make reading your normal session impossible:

- **App-bound encryption** (Chrome 127+) — cookie values are sealed with a key that only unwraps
  inside the profile that wrote them. Copying the cookie database out and reading it elsewhere
  returns nothing that decrypts.
- **Debug-port lockout** (Chrome 136+) — `--remote-debugging-port` is ignored on the default
  profile, and honoured on any other.

Those two are mutually exclusive, so the clean path is a profile of our own where the browser
decrypts its *own* live cookies for us. It lives in
`%LOCALAPPDATA%\cookie-grabber-profiles\<browser>` — the same place the DVP Scorecard, the FSD
Tracker and `cookie-grabber` use, so a machine set up for any of them needs no second sign-in.
A path convention only; none of those tools is required, and nothing outside this folder is read.

Needs **Chrome or Edge**, and **Node 20+** for the global `WebSocket` that DevTools protocol
needs. Without either, the buttons say so and the paste box below them still works.

### What to know before you do

- **One session per environment.** A production session is not valid against `garage.dev`, so
  each is captured and stored separately. Signing in to one says nothing about the other.
- **Being signed in is checked, not assumed.** Garage is Rails, so it hands out a
  `_garage_session` cookie to anonymous visitors too — its mere presence proves nothing. Every
  candidate is probed against Garage first, and only a session that actually resolves is kept.
  A window sitting on the login page waits rather than capturing a signed-out cookie.
- **It's your full Garage identity.** Anyone holding that cookie can act as you in Garage until it
  expires. Stored in `.garage.json` on your machine, never sent back to the page, never committed.
  It is a strictly broader grant than the OAuth token — among other things it returns GPS
  coordinates that the MCP path redacts.
- **It expires** on Garage's own schedule — hours to days. When it does, live read switches itself
  off, says why, and everything falls back to cached. **Sign in** again to resume; if the window
  is still signed in, that is one click and no typing.
- **Each person uses their own.** Never share a `.garage.json`.
- **~140 KB per vehicle per read.** The endpoint returns the entire vitals dump — around 4,475
  fields — to obtain two numbers. A 100-vehicle sweep moves roughly 14 MB. Fine for the short
  lists this is normally pointed at; worth knowing before loading it up.
- **Every failure falls back to cached.** Live read is an accelerator, never a dependency. Turn it
  off and the dashboard behaves exactly as it did before.

---

## Still-latched detection

A vehicle that has finished charging but is still connected is occupying a stall it no longer
needs. The dashboard chases that until the connector comes out.

Read from **`CP_proximity`** — the *Proximity: DISCONNECTED / LATCHED* line in Garage's vitals
tab.

> **This requires live read.** `CP_proximity` exists only in the live vitals dump. The cached
> historical set carries no `CP_*` columns at all — just an unrelated `cp_type` config value — so
> with live read off the proximity is not stale, it is *unknowable*, and none of this fires. The
> dashboard says so once in the activity log rather than looking broken.

> Deliberately **not** `CP_latchState`. That field reads `ENGAGED` on a car with nothing plugged
> in at all, because it describes the latch mechanism rather than whether a connector is present —
> verified against a parked vehicle reporting `CP_proximity DISCONNECTED` and
> `CP_latchState ENGAGED` at the same time. Using it would have flagged every idle car.

### What happens

1. A vehicle reaches its target while latched. It gets a solid red **Latched** pill, is exempted
   from auto-clear, and **keeps being polled** — the only way to learn it has been unplugged.

> The pill appears **only once charging has finished**. A car mid-charge is latched too, by
> definition, so showing it then would put the badge on every vehicle on a charger and make it
> mean nothing. The tag is a call to action — *this one is done, go unplug it*. The underlying
> latch state is still read throughout; it just isn't displayed until it matters.
2. After **2** latched cycles a red *Still plugged in* card goes to Teams, then again every **2**
   cycles after that — both configurable, see [Reminder cadence](#reminder-cadence) below.
3. When proximity reads `DISCONNECTED`, monitoring stops and the vehicle leaves the list.

Finished-but-still-plugged-in vehicles sort to the **top** of the list — they are the only rows
that need someone to physically go and do something. They stay `complete`, so the **Complete**
filter still finds them. Cars that are merely latched because they are charging sort normally.

**A VIN added that is already at or above the target and latched** starts the same reminders. It
still gets no *finished charging* card, matching the existing rule that a card marks a vehicle
*crossing* the limit rather than being found above it.

### The three-way reading

`DISCONNECTED` and `LATCHED` are facts. **`null` is not.** It happens whenever live read is off,
or the vehicle is asleep — the live endpoint answers `408 vehicle unavailable` for a sleeping car.

Null is never collapsed into either fact:

- Treating it as disconnected would silently stop monitoring a car that is still plugged in.
- Treating it as latched would nag forever about a car that was unplugged while asleep.

So an unknown reading **holds** the last known state, and after **3** consecutive unknowns the
reminders **pause** — the pill stays, dimmed, and the row reads *proximity unreadable*. A single
confirmed `LATCHED` resumes them. This is why the reminders are bounded even though they are
documented as repeating until disconnect.

### Reminder cadence

Set in **Admin → Alerts → Still-latched reminders**, as two numbers:

| Field | Default | Meaning |
|---|---|---|
| First reminder after | `2` | Latched cycles after finishing before the first card |
| Repeat every | `2` | Cycles between repeats. **`0` sends one card and stops** |

Presets: *Every cycle*, *2 then every 2*, *2 then every 6*, *Once only*.

Counted in **refresh cycles**, not minutes, because that is the only clock the monitor has —
change the refresh interval and the reminders move with it. The panel shows what the current
settings work out to in real time (*"first reminder about 10 min after a vehicle finishes, then
every 10 min"*) so you are not doing that arithmetic in your head.

Two things stay hard-coded near the top of the `<script>` block, because they are safety valves
rather than preferences:

| Constant | Default | Meaning |
|---|---|---|
| `LATCH_STALE_CYCLES` | `3` | Unreadable cycles before reminders pause |
| `MIN_CHARGE_AMPS` | `1.0` | Pack current above which a latched vehicle counts as charging |
| `MIN_RISE` | `0.3` | Charge-level rise that counts as charging on the inference path |

### Testing it without a car

Simulation mode fakes the whole lifecycle: a simulated vehicle stays latched for
`SIM_LATCH_CYCLES` (6) cycles after reaching the target, then reports `DISCONNECTED`. Set the
refresh interval to 20s and the tag, reminders and removal all play out in a couple of minutes.

---

## Microsoft Teams alerts

When a vehicle reaches its target level, the proxy can post a card to a Teams channel:

```
⚡ Charging complete
   Charging Tracker | Powered by Zo' Projects

   5YJ3E1EA9TF146618

   SOC     80.4%
   Target  80.0%
```

This works over a Power Automate SAS URL. Set it in **Admin → Alerts**, which writes it to
`.teams.json`, or override with the `TEAMS_WEBHOOK_URL` environment variable.

An engineering completion carries an extra `Environment  Engineering` fact so it can't be
mistaken for a production one. Production cards are unchanged.

> ### ⚠ If you get `401 DirectApiInvalidAuthorizationScheme`
>
> **Check that the URL still has its `sig` parameter before assuming anything about tenant
> policy.** A flow URL looks like this, and every part after the `?` matters:
>
> ```
> …/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=<signature>
> ```
>
> `sig` is the entire credential. A URL truncated at the first `&` keeps the path and
> `api-version` and loses the signature, so the request arrives with no credential — and Power
> Automate reports that as an *invalid authorization scheme*, which reads like the scheme is
> blocked rather than absent. This cost a long detour once; the error message is genuinely
> misleading.
>
> Truncation at `&` is what shells do to an unquoted URL. Always quote it.
>
> Verify with:
>
> ```
> node -e "console.log(/[?&]sig=/.test(require('./.teams.json').url))"
> ```

**Other delivery paths**, for reference if the flow URL is ever unavailable:

| Path | Result |
|---|---|
| Power Automate SAS URL | **Works.** The normal path. |
| Outlook COM → email-triggered flow | **Works.** Implemented as `ALERT_TRANSPORT=outlook`; see below. |
| O365 incoming webhook | Retired by Microsoft |
| SMTP relay | `smtp`/`mail.teslamotors.com` blackhole every port (25 / 587 / 465) |
| Teams channel email address | Disabled by tenant policy — no **Get email address** in the channel menu |
| OneDrive file-drop | Not viable: the machine has only a personal OneDrive, no work account |
| Entra ID bearer token | Untested. Would need an app registration, and is unnecessary while SAS works. |

### Outlook fallback transport

`ALERT_TRANSPORT=outlook` sends the alert as an email from the local Outlook client over COM,
for a flow triggered by **When a new email arrives (V3)** with a subject filter on
`[CHARGING-TRACKER]`. The body carries a JSON block between `--CT-JSON--` and `--CT-END--` so
the flow can parse exact values rather than scraping the subject.

This exists because it needs no credential of its own — Outlook already holds an authenticated
Exchange session, which also routes around the SMTP blackhole. It is a fallback, not the
default. Note that Outlook's programmatic-access guard can block `.Send()` depending on Group
Policy and antivirus state; the error is reported explicitly if so.

#### Switching it off, and who it mails

**Admin → Alerts → Email alerts** owns both. The switch turns the email channel off on its own,
and the field below it holds the recipient list — commas, semicolons or newlines, and a pasted
`Name <addr@tesla.com>` is unwrapped. An empty list means your own mailbox, read from the Outlook
profile at send time. A malformed address is refused outright rather than dropped from the list,
because a saved-but-silently-shortened list is a person who never gets told.

Both live in `.teams.json`, server-side, so switching email off stops the mail for every browser
rather than just the tab that did it. `ALERT_EMAIL_TO` and `ALERT_EMAIL_ENABLED=0` only *seed*
these on first run; the panel owns them from then on.

Two things worth being clear about:

- **The email switch is not the mute switch.** Mute stops every transport for a while and keeps
  the target configured. This turns one channel off for good and leaves the webhook untouched.
- **When Outlook is the active transport, it is the only transport** — the flow watching your
  mailbox is what puts cards into Teams. Switching email off therefore stops the Teams cards too,
  unless a webhook is set. The panel and the rail both say so rather than reading "not
  configured". **Send test** refuses with a reason in this state instead of mailing anyway, which
  is the one place it does *not* override the mute-style gates.

### How it behaves

- The URL is stored in `.teams.json` (gitignored, `0600`, refused by the static handler) and is
  never echoed back to the page — the admin menu shows only the host.
- The POST is made **server-side**. The URL carries a signature that shouldn't sit in client-side
  JavaScript, and Power Automate returns no CORS headers, so a browser `fetch()` would be blocked.
- Alerts are **fire-and-forget**. A Teams outage can't stall or break a monitoring sweep; the
  failure is recorded in the audit log instead.
- Repeat alerts for the same VIN are suppressed for 2 hours (`TEAMS_DEDUPE_MS`), so a page refresh
  or a re-added vehicle won't post twice. Latch reminders additionally key on the reminder number,
  which is what lets reminder #2 through while still swallowing a duplicate #2 from a refresh — a
  plain per-VIN key would have suppressed every repeat after the first and the reminders would
  have silently stopped.
- The payload includes both an Adaptive Card and flat `event` / `vin` / `usoe` / `limit` fields, so
  a hand-built flow can read the values directly instead of parsing the card.
- **A completion card marks a vehicle *crossing* the limit, never merely being found above it.**
  A car that was already at or above its target when we first saw it is marked complete, badged
  and counted, but sends no card. This matters most in Active Mode, where entering a geofence can
  add dozens of cars at once and most of them are finished — without the rule, every one of them
  posts on the sweep after entry.

  The test is *not* "is this the first poll". Active Mode seeds `usoe` from the geofence scan, and
  that seed is read rather than thrown away: it says which side of the limit the car was on when
  the scan saw it. Seeded below and now above is a real crossing and still alerts, even on the
  first poll. Seeded at or above is the case the rule swallows.

  > This guard existed before Active Mode and was silently defeated by it — the seed landed in
  > `prevUsoe` on the first sweep, so the `prevUsoe == null` test it relied on never fired for a
  > bulk-added car. Hand-added cars arrive with `usoe: null` and were never affected, which is why
  > it only ever showed up as an Active Mode flood.

- **Still-latched reminders are deliberately not subject to that rule.** A car sitting finished and
  latched is occupying a stall whether or not we watched it get there, so latch reminders fire for
  any latched vehicle. A bulk add of already-finished cars will therefore still produce a red card
  each once `latchAfter` cycles have passed — that is the intended signal, but set **Still-latched
  reminders** to *Once only* if a large geofence makes it noisy.

> **Caveat for multi-user setups.** Dedupe is per machine. If five people each run their own copy
> monitoring the same VIN, the channel gets five messages. For a shared alerting channel, run
> **one** instance as the alerter — and have everyone else leave the webhook field blank.

## Simulation mode

Switch **Data source** to *Simulation* in the admin menu to run without Garage. USOE values
follow a tapering Supercharger curve — quick to 50%, slowing hard past 80% — so state
transitions and the auto-removal behaviour can be demonstrated on any machine, on or off VPN.

Opening `index.html` directly from disk (`file://`) also defaults to simulation, since there's
no proxy on the other end.

---

## HTTP API

`server.js` exposes a small surface, useful if you want to script against it:

| Endpoint | Returns |
|---|---|
| `GET /api/usoe?vin=<VIN>` | `{"vin":"…","env":"prod","usoe":85.06,"readingAt":"2026-07-29T03:20:30","samples":9,"source":"garage:USOE","ts":…}` |
| `GET /api/env` | `{"current":"prod","forced":false,"environments":[{"key":"prod","label":"Production","authenticated":true,"live":{…}},…]}` |
| `POST /api/env` | Switch environment — `{"env":"eng"}`. `409` when pinned by `GARAGE_ENV`. |
| `GET /api/auth/status` | `{"authenticated":true,"env":"prod","envLabel":"Production","garage":"…","environments":[…]}` |
| `POST /api/trtscan` | Active Mode's geofence scan — `{"trt":17589}` for every car at the TRT, or `{"trt":17589,"types":["customer-vehicle","inventory-vehicle"]}` to narrow to those types. **In production `delivered:false` is applied either way** and is not caller-controllable. Returns `{count,total,rawRows,filtered,vins,rows}`, where each row is `{vin,usoe,soc,model,vehicleType,deliveryDate}`. Unknown types are rejected with `400` and the allowed list; an empty `types` array is rejected rather than treated as "no filter" |
| `GET /api/live` | Live-read state for the **current** environment |
| `POST /api/live` | `{"cookie":"…"}` and/or `{"enabled":true}` for the current environment |
| `POST /api/live/test` | `{"vin":"…"}` — one live read, independent of the enabled flag |
| `POST /api/live/login` | `{"env":"prod"}` — open the sign-in window and start waiting. Returns immediately; joins an attempt already running |
| `GET /api/live/login?env=<key>` | That environment's live state plus `connect: {phase,detail,…}` and `support: {browser,supported,…}` |
| `POST /api/live/login/cancel` | `{"env":"prod"}` — stop waiting |
| `GET /api/teams` | `{"configured":true,"preview":"https://host/…","fromEnv":false,"emailEnabled":true,"emailTo":"a@x.com; b@x.com","emailRecipients":["a@x.com","b@x.com"]}` |
| `POST /api/teams` | Set any of `{"url":"https://…"}` (`""` clears), `{"muted":true}`, `{"emailEnabled":false}`, `{"emailTo":"a@x.com, b@x.com"}`. Keys are independent — a body carrying one must not disturb the others. Returns `400` if any address is malformed, without saving the list. |
| `POST /api/teams/test` | Sends a test card. Overrides **mute**, but returns `409` rather than mailing when email is off and Outlook is the active transport. |
| `POST /api/notify` | `{"event":"charge_complete","vin":"…","usoe":80.4,"limit":80.0}` or `{"event":"still_latched","vin":"…","reminderIndex":2,…}` |

`/api/usoe` returns `401` with `{"needsAuth":true}` when the token is missing or expired, and
`502` with an `error` string when Garage rejects the query.

The three `/api/live/login` routes are the only live endpoints that take an `env` — the point of
the two buttons is to set both Garages up without switching between them, and an attempt writes
nothing but the environment it names. Everything else under `/api/live` follows the current one.

---

## Files

```
index.html           Entire dashboard — markup, styles, SVG graphics, logic. No build step.
server.js            Local Garage proxy: OAuth, MCP client, static file serving. No dependencies.
garage-connect.js    The sign-in window: launches an isolated browser profile and reads the
                     Garage session cookie back out of it over the DevTools protocol.
package-portable.js  Builds the send-to-a-colleague zip, Node runtime included.
start-dashboard.bat  Windows launcher — double-click to run. Prefers the bundled runtime,
                     falls back to Node on PATH, so it works from the zip and from a clone.
package.json         Metadata and `npm start`.
.gitignore           Keeps the credential files out of the repo.

Generated at runtime, never shared:
.tokens.json         Production OAuth token
.tokens.eng.json     Engineering OAuth token
.client.json         Production dynamic client registration
.client.eng.json     Engineering dynamic client registration
.garage.json         Live-read cookies for both environments, plus the selected environment
.teams.json          Teams webhook URL and the alert dedupe log
```

### Sharing this with someone

```bash
node package-portable.js            # writes ~/Desktop/charging-tracker-portable-<date>.zip
node package-portable.js D:\out     # or somewhere else
```

That is the whole procedure. The zip contains the tracked source **and a Node runtime**, so the
recipient unzips it, double-clicks `start-dashboard.bat`, and the dashboard opens — nothing
installed, nothing prompted for, no admin rights. Which is the point: Node cannot be installed on
a corp device, and telling someone to run a PowerShell one-liner first loses most of them.

It also lifts them over the Node 20 floor the one-click Garage sign-in needs, so live vitals works
out of the box too.

A `READ ME FIRST.txt` goes in beside it covering the first run, the admin code, and live vitals.
Windows x64 only — the runtime is whichever `node.exe` built the zip.

> ⚠️ **Do not zip the folder by hand.** It also contains `.tokens.json`, `.tokens.eng.json`,
> `.client.json`, `.client.eng.json`, `.teams.json` and `.garage.json` — your Garage OAuth tokens
> for **both** environments, your Teams webhook, and live Garage **session cookies** that are your
> full identity. `.gitignore` excludes them from *git*, but not from a right-click → *Send to* →
> *Compressed folder*.

`package-portable.js` is built to make that mistake impossible. Source comes from
`git archive HEAD` — exactly what is tracked, so no overlooked glob can sweep a credential in —
and the staged tree is then re-checked against the same pattern `server.js` refuses to serve. If
anything matches, the build aborts rather than producing a zip. Uncommitted edits are not
included, and it says so before building.

Sending the seven tracked files by hand (`index.html`, `server.js`, `garage-connect.js`,
`package-portable.js`, `start-dashboard.bat`, `package.json`, `README.md`) still works if the
recipient already has Node.

Either way the recipient needs no key or file from you. On first run their copy registers its own
OAuth client and they sign into Bouncer as themselves, with their own Garage permissions.

State (monitored VINs, settings, audit log) lives in browser `localStorage`, so it survives a
refresh and stays local to each user. Vehicle lists are per environment — `ct.vehicles` for
production, `ct.vehicles.eng` for engineering — while settings and the audit log are shared.

---

## Troubleshooting

**"No USOE snapshot in the last 6h"** — Datatank has no recent snapshot for that VIN. Raise the
window with `LOOKBACK_HOURS=24`.

**"Garage MCP returned HTTP 403"** — your account lacks Standard Read Access for that vehicle.

**Sign-in page won't load** — you're off the Tesla network. Connect to VPN and retry.

**Stuck auth after a failed login** — delete `.tokens.json` and `.client.json`, then restart.
For engineering, delete `.tokens.eng.json` and `.client.eng.json`.

**Signed in but engineering still says signed out** — they're separate authorization servers.
Use the **Sign in** link on the Engineering row in Admin → Environment.

**Engineering VINs read "No USOE snapshot"** — check the environment chip in the nav. A dev VIN
queried against production Garage doesn't exist there, and the error is the same one you'd get
for a genuinely stale vehicle.

**Environment switch does nothing / the buttons are greyed out** — `GARAGE_ENV` is set. Unset it
in `start-dashboard.bat` to switch from the UI.

**Port already in use** — `PORT=3200 node server.js`.

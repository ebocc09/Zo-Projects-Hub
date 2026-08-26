# FSD Tracker

How far customers actually drive on FSD **after** taking delivery.

Trial activation is close to universal — on 2026-08-01, 60 of 61 delivered
vehicles had `autopilot_trial_enabled` flip to true. Activation is therefore a
useless metric. Whether the customer *used* it is the interesting one, and that
is what this tool measures.

Separate from the Charging Tracker on purpose. It reuses that project's Garage
sign-in (see [Garage — nothing to configure](#garage--nothing-to-configure)) but
shares no code and touches none of its files apart from the token store.

---

## Quick start

```sh
node fsd-tracker.js --trt=17589                          # today
node fsd-tracker.js --trt=17589 2026-08-01               # one date
node fsd-tracker.js --trt=17589 2026-07-26..2026-08-01   # inclusive range
node fsd-tracker.js --trt=17589 today "C:/some/out.csv"  # explicit output path
node fsd-tracker.js --trt=17589 --advanced 2026-08-01    # add RN and advisor
```

Or double-click `run-fsd.bat`.

Output lands in `~/Desktop/fsd-<date>.csv`:

```csv
vin,delivery_date,fsd_miles_post_delivery
7SAYGDED3TA748894,2026-08-01,56.89
```

## Two modes

|  | basic *(default)* | advanced |
|---|---|---|
| sources | Garage alone | Garage + Intrepid + Tesla OS |
| credential | none | `cogs-authorization` cookie; Tesla OS signs itself in |
| gives | VIN, delivery date and time, model, FSD miles | the same, plus reference number, **delivery host**, **FSD Sub-Intent**, and per-host filtering and stats |
| a day's run | under a minute | the same, plus a lookup per car |

**Advanced adds columns and nothing else.** The mileage is measured identically
in both, so switching modes can never move a number. The mode is saved in
`.connections.json` and shared by the CLI and the dashboard; `--basic` and
`--advanced` override it for one run.

Advanced without a saved cookie does not fail — it degrades to basic and says so.

---

## What it measures

`fsd_miles_first_12h` is a **delta over a fixed window**, not an odometer:

```
GUI_fsdUserTotalMiles (handoff + 12 h)  −  GUI_fsdUserTotalMiles (at handoff)
```

Raw lifetime mileage is worthless here — every car arrives with a few FSD miles
already on it from lot moves and PDI. One real example had 4.9 miles banked
before the customer ever saw it.

### When the counter is stuck

On a small minority of cars `GUI_fsdUserTotalMiles` is dead — the identical
value in every one of 770 samples across the full fourteen days, on a car that
plainly drove. Subtracting a stuck counter yields **zero**, and a zero is worse
than an error here: the row looks measured, and the host looks like they sent
someone home without a demo.

Those cars fall back to **`GUI_apFsdTotalMiles`**, the same quantity read
somewhere else. On 2026-08-08 / TRT 17589 the two agreed to the thousandth of a
mile on all 58 cars where both were alive, and the backup carried the 2 where
the primary was flat. It is consulted **only** when the primary never moves at
all over the whole pull, so it can never change a figure the primary could have
produced; a car that genuinely sat still has both counters flat and still reads
zero. Affected rows are badged **Backup counter** on the dashboard, noted in the
export, and counted in `summary.altCounter`.

Both fields come back from the one vitals call, so the safety net is free.
Worked example — `7SAYGDEEXTA695958`, delivered 2026-08-08 20:57 UTC: primary
pinned at 247.577 for the fortnight (reported 0), backup 2440.960 → 2468.466
across the window (**27.5 mi**).

### The 12-hour window

Miles are counted for the first **12 hours** after handoff and then that car is
done. Without a cutoff the figure is "miles since delivery, as of whenever you
happened to press the button", which has two problems: two runs of the same day
disagree, and a delivery from last Tuesday always out-scores one from yesterday
purely for having had five more days to accumulate. Twelve hours is the drive
home and the first evening out — the part of the trip that says something about
how the handover went.

**A closed window is never re-read.** The answer cannot change, so it is written
to `.measure-cache.json` and served from there; a settled date returns exactly
what it returned the first time, without re-measuring. Rows
still inside their window are marked *Counting* in the dashboard, noted in the
export, and warned about by the CLI. Admin › Maintenance › **Clear settled
measurements** throws the stored answers away if one is ever suspect.

The window length is `windowHours` in `config.json`. Cached entries record the
window they were measured under, so changing it invalidates them rather than
mixing two definitions in one report.

**The baseline is the last telemetry sample at or before the delivery
timestamp.** That is not exactly the handoff instant, so staff driving between
the final sample and the actual hand-over would be miscounted as customer use.
Measured across a full delivery day the gap ran a median of 6 minutes, p90 of
31, max of 49 — small enough to ignore. The script still checks, and warns if
any row exceeds 60 minutes.

The timestamp is tesladex's `delivery_date`, accurate to the second
(`2026-08-01 17:49:53`). The old Intrepid path only had the appointment *slot*,
so this is a slightly better baseline than the one the original numbers used.

Numbers move through the evening. A car delivered at 18:00 has barely driven by
19:00, and its window does not close until 06:00 the next morning. Run
yesterday's date for a page of settled figures.

### Verifying the window actually measures what it claims

`audit-window.js` and `audit-edge.js` re-derive the figure from raw telemetry
without calling `fsdMilesFor`, so agreement means two independent
implementations agree rather than one agreeing with itself. Run against
2026-08-04 / TRT 17589 (30 deliveries):

```sh
node audit-window.js 2026-08-04 17589 14
node audit-edge.js   2026-08-04 17589 30
```

| check | result |
|---|---|
| independent recompute vs the tracker | **14/14 identical** |
| anchor vs the car's own `GUI_deliveryTime` | **29/30 within 60 s**, median **+2 s**, max +151 s |
| FSD miles in the 24 h *before* the anchor | 13/14 exactly zero; one car 3.4 mi, correctly excluded |
| cars with no in-window telemetry | **0/30** |
| miles driven but unobserved at the window edge | **29/30 exactly zero** |

**The anchor is the handoff, confirmed by the car.** `delivery_date_epoch` and
`GUI_deliveryTime` — the vehicle's own record of when it was delivered — agree
to within a second or two on nearly every car. Counting starts a second or so
*before* the car's own stamp, which is the safe direction.

**Do not use the `delivered` vital as the anchor.** It is a config flag that
lands on a later push or boot, not a timestamp: measured against the handoff it
flipped a median of **2 h 21 m late**, worst case **34 h 49 m**, and never once
early. Ten of fourteen cars had already banked FSD miles before it turned
`yes` — one of them 86 miles. Anchoring on it would discard most of the drive
home.

**The long blind tail is sleep, not blindness.** The last sample inside the
window sits a median of 4.9 h before the edge, which looks alarming until you
check what the car did next: on 29 of 30 the first reading *after* the window
is identical to the last one inside it. The car parked for the night and stopped
reporting; nothing was driven and missed. The one exception had 1.75 mi between
those two readings, and the cut excluded them — the boundary under-counts rather
than over-counts, which is the right way to be wrong.

The one residual exposure is the pre-existing baseline gap: the baseline sample
is up to 47 minutes before the handoff in this set, and staff driving inside that
gap would count as customer miles. Since pre-handoff FSD movement measured
essentially zero, the risk is small — but it is why rows over 60 minutes are
flagged.

### Miles to date

Under each car's headline figure, in grey: the same delta with **no cutoff** —
FSD miles since handoff as of the car's latest reading. It answers the obvious
question the window provokes, which is how much driving the cutoff is holding
back. The example above measured 16.0 mi in its twelve hours and 62.8 mi by two
days later.

It is shown and never counted. Every total, rate, leaderboard position and
export column on the page is the windowed number; to-date is context for one
car, and folding it into a day's totals would reintroduce exactly the
incomparability the window exists to remove.

The line is omitted rather than repeated when there is nothing to add: a car
still inside its window, or one that has not moved since the window closed, has
the same figure twice and only the headline is drawn.

**To-date cannot be cached** — it is only ever true as of now. So a settled car
costs one small Garage call where it used to cost none: the cache stores the
baseline reading alongside the delta, which lets that call ask for the car's
latest sample rather than the whole curve back to handoff. Entries written
before this existed have no stored baseline and are re-measured once, which
returns the identical windowed figure and then caches it with one.

---

## Where the data comes from

### Garage — the whole report, in basic mode

Three reads, all over MCP.

**1. Which cars — `tesladex_search`, one query.**

```
delivery_date_epoch:[<local midnight> TO <local midnight + 1d>]
  AND vehicle_routing_location:<trt>
```

Until August 2026 this returned `403 "Access is restricted to undelivered
vehicles"` and Intrepid was the only possible enumerator. That restriction is
gone, which is what makes the cookie-free path exist at all.

**`delivery_date` is UTC**, and that is a silent trap. A 19:00 Houston pickup is
`00:xx` UTC the *next* day, so a `delivery_date:2026-08-01*` prefix quietly
drops the back half of an evening. The query is an **epoch range spanning the
local day** for that reason. On 2026-08-01 the two differ by 374 cars.

**`vehicle_routing_location` is the centre filter.** It survives delivery, where
`delivery_details` — the block carrying `destination_trt_id` — does not; that is
populated only while a car is undelivered and is wiped at handoff, leaving
**1 of 3,334** on 2026-08-01. VRL is indexed, so the filter runs server-side and
the day comes back in a single query.

**2. How far they drove — `device_historical_vitals`, fields
`GUI_fsdUserTotalMiles` and `GUI_apFsdTotalMiles`.** Described under
[What it measures](#what-it-measures); the second is the fallback for a stuck
counter and comes back on the same call.

#### One car — Search VIN or RN

The dashboard's **Search VIN or RN** replaces that first query with a
single-record lookup and takes the date *and* the centre off the car itself: a
VIN search needs no date and no TRT, and answers for a car from any centre, not
just the one on screen. Everything downstream is unchanged — the same
enrichment, the same measurement, the same bar — so a car looked up on its own
cannot be scored differently from the same car inside its day.

One box takes either number. A VIN is 17 characters and an RN is `RN` plus the
order's digits, so they cannot be mistaken for one another and the field simply
works out which it was given; the prefix is optional, because the number gets
dictated without it as often as it is copied off an order page with it.

**An RN is resolved to its VIN and then it *is* a VIN search** — the resolution
is the only thing that differs, and it happens inside `collectReport` rather
than in the route so the two paths cannot drift apart. Verified: the same car
searched both ways returns byte-identical rows.

##### Why an RN costs a scan, and why that is cheap

There is no direct lookup. Tesladex does not index the reference number at all,
and Intrepid's `getDeliveryAppointmentDetails` — which *takes* an RN — answers
with the staff on the appointment and never the car. The one place both numbers
sit side by side is `getTssAppointmentsByDate`, which is keyed by centre and
date, so `vinForRn` reads the centre's own appointments and matches on the RN.

That only has to cover the vitals ceiling, because a car delivered before it
cannot be measured whether it is found or not — fifteen days, run concurrently,
came back in **about a second** against a real centre. The scan is not the cost;
the scope is:

| | VIN | RN |
|---|---|---|
| centre | any — national index lookup | the one on screen only |
| needs a TRT set | no | yes |
| needs Intrepid | no — basic mode is fine | yes, advanced only |

An appointment exists only at the centre that booked it and there is no national
list to ask, so an RN handed over elsewhere genuinely cannot be found from here.
Both limits are stated in the search box *before* the search rather than as a
failure after it, and the miss says "search its VIN instead" rather than letting
itself read as "no such order". A scan where some days could not be read reports
an inconclusive result, never a clean miss.

The leaderboard and host filter are hidden for a single car; one row is not a
population to rank. The 14-day ceiling still applies, and says so by VIN rather
than by date.

#### Every VIN links to its vitals

Each VIN on the page opens `<garageUrl>/vehicles/<vin>/vitals` in a new tab —
the reading being reported, at its source, for when a figure looks wrong. That
is Garage's own route: its VIN debug page builds the same href, so the `:id`
segment takes a VIN and no numeric device lookup is needed. The base comes from
`garageUrl` in `config.json` by way of `/api/state`, so a Garage in another
region is linked to correctly rather than at a host baked into the page.

#### Why not `trt_id` from telemetry

The first working version had no VRL in it. It pulled the whole national day —
~3,000 cars — and probed each one's telemetry history for the `trt_id` it held
at the delivery timestamp, because tesladex reports `trt_id` as null on a
delivered car while the history still has it. That worked, and cost **about
twelve minutes a day** at ~4 calls/sec.

Measured head to head across all 2,960 cars delivered nationally on 2026-08-01:

| | |
|---|--:|
| the two methods agree | 2,693 |
| disagree | 68 |
| telemetry had no `trt_id` at all; VRL still answers | 37 |
| **for TRT 17589 — VRL wrongly adds** | **0** |
| **for TRT 17589 — VRL misses** | **0** |

Where they disagree VRL is the better value: the telemetry side is holding
logistics codes the car had not shed by handoff (`15047`, `415904`) where VRL
names a real centre (`16433`, `36201`). VRL was populated on **every one** of
the 2,960.

The old path survives only as a fallback for a car with **no** VRL, which costs
one extra query and has so far never matched anything. It is kept because the
failure it guards is silent — a car with no VRL would simply never appear, and
an undercount looks exactly like a quiet day. Those few get the telemetry probe,
cached permanently in `.vin-trt-cache.json`.

If that fallback ever does fire, the original rule still applies and every
clause of it is load-bearing: **the last non-null `trt_id` at or before the
delivery timestamp** — not the latest value (one car sat at `15952` through
handoff and moved to `9059` five hours later), and not the value near the
`delivered` flag, which lags the real handoff by five to seven hours and reads
`yes` all window on used inventory.

#### A delivery date is not proof of a delivery

`delivery_date_epoch` gets stamped on cars nobody has been handed: an
appointment moved, a car pulled into repair, an order edited. They arrive
through VRL enumeration looking exactly like real deliveries.

The tell is `delivery_details`. It is **wiped at handover** — the same property
that made VRL enumeration possible in the first place — so a car still carrying
one, with `scheduled_delivery_date` in the future, demonstrably has not gone
out. Those are dropped from the day before anything is measured, and counted in
a notice so the total never moves without saying why.

Read off **Garage alone**, deliberately. "It has no Intrepid appointment" is
the easier test and is wrong twice: it is unavailable in basic mode, where it
would empty the whole report, and in advanced mode it would also discard
genuine deliveries Intrepid has no record of — which the join goes out of its
way to keep.

Leaving them in cost twice over: a guaranteed 0.0 dragging the engagement
percentage down, and an unanswerable Sub-Intent inflating the "could not be
checked" count on the morning brief — which is the alarm for a broken Tesla OS
session and must not ring for a car that was never delivered.

Verified 2026-08-25: a week at TRT 17589, all 337 delivered cars had
`delivery_details: null`; the single exception was scheduled six days out and
in repair. Today's report went 44 → 43 with the unknown count to zero;
2026-08-24 stayed at 48 with nothing dropped.

A **VIN search** is the exception — it explains instead of dropping. Someone
who typed that VIN wants to hear about that car, and "no such delivery" for a
car plainly on the schedule is the worse answer.

#### The 14-day ceiling

Mileage comes from telemetry, which reaches back **336 hours**. Past that a
car's baseline at handoff has aged out and the delta cannot be computed, so
older dates are **refused with a notice** rather than returning wrong numbers.

#### Cost

A day is now **under a minute**, nearly all of it reading mileage curves —
one vitals call per delivered car at `concurrency: 8`. Enumeration is two
queries regardless of how many cars the country delivered.

Other FSD fields that exist, for reference: `autopilot_trial_enabled`,
`autopilot_trial_expires`, `GUI_apFsdTotalMiles` (tracks `GUI_fsdUserTotalMiles`
identically wherever both are alive, which is why it is the fallback — see
[When the counter is stuck](#when-the-counter-is-stuck)), `GUI_fsdPctTripsIsFsd`,
`GUI_fsdInterventionFeedbackCount`, `APP_fsdSuspendState`. The percentage fields
came back empty on freshly delivered cars — presumably they need more history.

### Intrepid — the fields Garage has no record of

Only in advanced mode, and only for **`reference_number`** and the **delivery
host**. Neither exists anywhere in tesladex's 4,475 fields, which is the entire
reason this source survives.

It is **joined on VIN and never used to decide which cars appear**. A car
Intrepid has not heard of still shows up with its mileage intact rather than
vanishing from the report.

#### Delivery host ≠ delivery advisor

The host — who actually conducted the handover — is **`DriverADUserName`** on
`getDeliveryAppointmentDetails`. The advisor who owns the appointment is
`DeliveryAdvisorDisplayName`. **They are different people on about a third of
cars** (24 of 70 across 2026-08-01 and 08-02 at TRT 17589), so do not treat one
as a synonym for the other. They coincide often enough — one person doing both
— that a small sample can look like they are the same field.

`DriverADUserName` was populated on **70 of 70** delivered appointments.

#### Naming a host from a username

The host arrives as a bare AD username with no display name. Two tiers resolve
it, cheapest first:

1. **Harvest.** Every appointment detail carries `DeliveryAdvisorUserName` →
   `DeliveryAdvisorDisplayName` and the same pair for the sales advisor. Those
   are matched username/name pairs, so each fetch teaches a little of the staff
   directory for free — one day at one centre yielded **59 names**, covering 10
   of 13 hosts.
2. **Garage `lookup_user`** on `<username>@tesla.com` for whoever is left,
   taking only `given_name` and `family_name`. That call returns far more —
   vault UUID, device counts, an email hash — and none of it belongs in a
   mileage report.

Cached in `.staff-cache.json`, gitignored because it is a list of real people.

> **Never guess a name from the username.** `johanberry` is Joshua
> **Hanberry** — any split renders it "Joh Anberry". A host that cannot be
> resolved is shown as the raw username, and the run says how many.

#### The two percentages

Per host the report gives:

| | means |
|---|---|
| **share** | their cars ÷ all deliveries that day — how much of the work they did |
| **fsdRate** | their cars that drove FSD ÷ their own cars — how it went |

Different denominators, so they are not comparable to each other. `cars` is
always shown alongside: three cars at 100% is not a better day than twenty at
85%. Both are computed in `byHost()` in lib.js so the CLI, dashboard and export
cannot drift.

#### What counts as having driven on FSD

**At least one mile**, and the bar is inclusive — a car on exactly 1.0 has met
it. Below it the row is red, the car is left out of `drove` and the host's
`fsdRate` does not credit it. Anything less than a mile is a bay reposition or
a roll off the pad rather than a customer choosing the feature.

The figure is a judgement about what counts, not a fact about the data, so it
is settable: `droveThreshold` in config.json is the shipped default and
Admin › **Measurement** overrides it per machine. It used to be a hardcoded
0.5 and *exclusive*, which quietly passed cars that had barely moved.

Every caller reads it through `droveThreshold()` in lib.js, so the row colour,
the day's count, the leaderboard and the CLI cannot score a day differently.
Moving the bar re-judges the report on screen through `/api/rescore` rather
than re-running it — no measurement changes, and a re-run would in any case
return larger mileage, because FSD miles climb all day.

The API is **not** on the host that serves the UI. `intrepid.tesla.com` only
serves the Angular shell and returns HTML for every path, including
`/cogs/api/*`. Real endpoints live on a separate host, named in
`https://intrepid.tesla.com/cogs/assets/environment/environment.json`:

```
baseUrl: https://intrepidapi.tesla.com/cogs
```

| endpoint | gives |
|---|---|
| `GET /api/cogs/getTssAppointmentsByDate?trtId=&date=&searchQuery=` | one row per appointment: `vin`, `referenceNumber`, `startDateTime`, `status`, nested `cogInfo` |
| `GET /api/cogs/getDeliveryAppointmentDetails?rn=` | `DeliveryAdvisorDisplayName`, `SalesAdvisorDisplayName` |

`trtId` is **required** and must be a real TRT — omitting it or passing an
unknown one returns `500 TSS Request failed with status code 400`. `date` is a
plain query parameter, so one cookie serves any number of dates with no re-auth.

Site names come from `/api/location/getLocations` on the sibling location
service — every Tesla location, ~1,850 records and 7.5 MB, reduced to a
`trtId → name` map and cached for a week in `.trt-cache.json`. That map also
backs the dashboard's type-ahead, so a TRT can be found by typing "Houston"
instead of remembering `17589`. `getTrtByTrtId` exists in the bundle but 404s
against this deployment, hence the whole-list approach.

Useful extras on the appointment row, not currently exported:
`cogInfo.vehicleCogStatusName` (Ready for Prep / In Wash / In Charge / Finished
Goods), `cogInfo.bayLocation`, and `cogInfo.additionalAttributes.chargingLevel`.
Per-vehicle status history is available from
`getVehicleStatusLogByVinWithPdiTask?vin=&vehicleShipmentId=` — where
`vehicleShipmentId` is **`cogInfo.id`**, not `vehicleId` or `vehicleMapId`. Those
two return an empty log rather than an error, which is an easy trap.

#### The customer, and where they are not

Each row shows the customer's name, linked to
`https://os.tesla.com/vehicle-order/<RN>`.

The name is **not** in the appointment detail, despite appearances. That
payload's `Drivers` block looks like it should hold the customer and does not:
across every record sampled it held internal staff — `IsExternal: false`, no
email, `AdUsername` matching the delivery host — and `DriverName` was null
throughout. `searchAppointmentsByVin` returns nulls for its name fields on
delivered cars. An earlier version of this file claimed the `Drivers` block
carried customer name, email and phone; that was wrong.

The actual route is the appointment row's **`userId`**, which is the customer's
`my_tesla_unique_id` — the same key Garage's `lookup_user` accepts. Intrepid
names the account, Garage names the person.

> **PII:** only `given_name` and `family_name` are taken. `lookup_user` also
> returns the customer's email, a vault UUID, device counts and an email hash;
> none of it reaches the page, the export or the log. Names are cached in
> memory for the life of the process and deliberately **not** written to disk,
> unlike the staff directory — a run needs one lookup per car anyway, so a
> disk cache would buy nothing and leave customer names in a file.

---

## Credentials

**Every credential comes from the Zo Projects Hub** (`http://localhost:3100`),
which signs in once for the whole estate and writes to
`%LOCALAPPDATA%\ZoProjects\credentials.json`. This board reads that file; it
has no sign-in of its own and its Admin panel only reports what it found.

Three are used here: the **Garage cookie** (basic mode runs on this alone), the
**Intrepid cookie** (advanced mode), and the **Garage MCP token** (names only —
see below).

`.connections.json` still exists for this board's own settings — mode, chosen
centre, threshold. It no longer holds a credential anything writes.

### Connect to Intrepid *(advanced only)*

On the Hub: **Admin › Intrepid › Connect**. It imports the cookie from an
isolated Tesla sign-in window rather than asking anyone to find one.

#### Why it can't just read your normal browser

The obvious version — read the cookie out of the Chrome you're already signed
into — is impossible on a modern managed Chrome, and it is worth writing down
so nobody spends a day rediscovering it:

| Protection | Effect |
|---|---|
| **App-bound encryption** (Chrome 127+) | cookie values are sealed with a key that only unwraps inside the originating profile. Copying `Cookies` + `Local State` to a temp dir and reading them headless returns **zero** rows — every value fails to decrypt |
| **Debug-port lockout** (Chrome 136+) | `--remote-debugging-port` is **ignored on the default profile**. A non-default `--user-data-dir` still honours it |

Those two are mutually exclusive. Getting at your everyday session needs an ABE
bypass — injecting into Chrome, or abusing its elevation COM service — which is
fragile, antivirus-flagged, and the wrong shape for a tool colleagues run.

So the clean path: a **separate profile** with the debug port open, where the
browser decrypts its *own* live cookies for us over CDP `Storage.getCookies`.
Your normal browser is never touched.

> That window has a debug port open while it runs, so anything local can read
> its cookies. Keep it for signing in and close it when you're done. It is a
> throwaway profile with one session on it, not your browser.

The profile lives in `%LOCALAPPDATA%\cookie-grabber-profiles\chrome` — the same
place `~/cookie-grabber` uses, deliberately, so a machine already set up for
that tool needs no second sign-in. That's a shared path convention, not a code
dependency: `intrepid-connect.js` is self-contained, because this project
already carries one cross-repo coupling and a second would be a choice to
repeat it.

Needs Chrome or Edge. Firefox stores cookies unencrypted and needs no window at
all, but is not wired up here — paste manually if that's your browser.

### Refreshing the cookie by hand *(fallback)*

The credential is the **`cogs-authorization`** cookie, an Express signed session
— and it is the *only* header required. No Origin, Referer, User-Agent or
X-Correlation-ID. Paste it under **Admin › Connections**; a whole `Cookie:`
header is fine, the relevant pair is extracted.

It is **HttpOnly and scoped to `intrepidapi.tesla.com`**, so it is invisible to
`document.cookie` on the SPA page. Pasting `document.cookie` from
`intrepid.tesla.com` will not work; that string contains only analytics and
Akamai cookies.

To capture it:

1. Open the readiness page with DevTools → **Network**, filter `intrepidapi`
2. Change the date so a request fires
3. Right-click the XHR → **Copy → Copy as cURL**
4. Pull the `cogs-authorization=...` value out of the `-b` argument
5. Paste it into Admin › Connections and Save

Alternatively DevTools → Application → Cookies → `https://intrepidapi.tesla.com`.

Expiry shows up as an identical `401 / No token provided` for every failure mode
— absent, malformed, or unknown session. The script surfaces it as
*"Intrepid cookie expired or rejected — paste a fresh one"*.

Login is Entra/Azure AD auth-code:
`intrepidapi.tesla.com/cogs/login` → `login.microsoftonline.com/9026c5f4-…`
with `redirect_uri=https://intrepidapi.tesla.com/cogs/auth/cb`. That redirect URI
is fixed, so a localhost server-side OAuth flow is not possible without an app
registration change. Pasted-cookie refresh is the practical path.

### Garage · MCP — names, and only names

Almost everything this board reads from Garage goes over the **session
cookie**. One call does not: `lookup_user`, which turns an AD username or a
customer id into a display name. Garage exposes no find-a-person route over
REST, so that one goes over **MCP**, which wants an OAuth bearer token.

Sign in on the Hub: **Admin › Garage · MCP › Connect**. Authorization code with
PKCE, dynamic client registration, `resource` bound to the Garage MCP endpoint.
The Hub holds the registration and the tokens in the shared store.

**Leaving it unset costs display names and nothing else.** Every report still
runs; rows show usernames where names would be. Nothing waits on this token —
it is fetched lazily, on the first call that needs a name.

#### Who refreshes it

This board does, and it is the only thing that may:

> The Hub **mints** and never refreshes. Exactly **one** board consumes and
> rotates — this one, the only board that speaks MCP at all.

That rule is what keeps a rotating token safe in a shared file. It is not
decoration: an earlier arrangement had this board and the Charging Tracker
sharing one OAuth client, and because refreshing rotates the refresh token,
whichever refreshed first stranded the other. One writer, no such failure. A
second MCP consumer would bring it straight back — see `credstore.js`.

#### So other boards ask this one

`GET /api/staff?users=crieder,lcolman` →
`{ "names": { "crieder": "Colton Rieder", "lcolman": "Leonardo Colman" } }`

When ZO-003 wanted full names instead of usernames, the answer was **not** to
copy the OAuth client into it — that is precisely the second consumer the rule
forbids. Instead the one call with no cookie equivalent is offered over HTTP.
The single-writer property is untouched: still one MCP client, still one
rotator.

Names come from the same disk cache the reports use, so a roster this board has
already seen costs nothing. Unknown usernames come back **absent** rather than
echoed, because `staffName()` falls back to the username itself and a caller
cannot tell that echo from a real name. No admin password: a display name is not
privileged, the caller already has the username, and nothing else `lookup_user`
returns is passed on.

This board's old `.tokens.json` and `.client.json` are deleted on first run.
They were registered against a redirect URI nothing serves now.

---

## FSD Sub-Intent

Whether the customer has said they want FSD. Advanced mode only, shown as a
badge on the row.

**It is not in Intrepid.** That was checked properly before this was built:
both Intrepid front-ends — the root SPA and the `/cogs/` app, all twenty-nine
lazy chunks — contain zero occurrences of `fsd`, `autopilot` or `intended`, and
`getDeliveryAppointmentDetails` returns staff and nothing else. It lives on the
**order**, in Tesla OS:

```
GET  {os}/v1/overview/{RN}/overview   →  order.fsdLabel
```

Keyed by reference number, which is why it is advanced-only — a basic run has
no RN to ask about.

### Four states, and the difference between two of them matters

| badge | meaning | in the morning brief |
|---|---|---|
| **Sub-Intent** | intends to subscribe, or is transferring FSD from another car | not listed |
| **Has FSD** | already owns it — bought, subscribed, complimentary, Luxe Package | not listed |
| *(none)* | a bare trial, or nothing on the order | **listed** |
| *(none)* | **not asked** — no RN, no session, order not visible | not listed, counted |

The last two rows look identical on screen and are opposite in meaning. A
customer who said nothing is someone to talk to; a customer we failed to look
up is not, and naming them would be telling their advisor something untrue.
Unknown rows are counted in the run notices instead.

### Two traps, both measured

**`isFsdSubscribed` is not the signal.** The order carries a boolean of that
name and on a seven-order sample it agreed perfectly with "Subscription
Intended". It does not hold: `RN128978811` and `RN129032768`, delivered
2026-08-24, both carry `fsd.trial` — no intent at all — with
`isFsdSubscribed:true`. Classification is from the `fsdLabel` message key only.

**`fsdLabel` has two shapes** — a bare string, or `{message, messageParams}`
with the trial expiry in it. Both occur in a single day. Anything reading it
must branch on `typeof`, as Tesla OS's own renderer does.

### Connect once; it renews itself after that

Admin › Alerts › **Tesla OS session** › Connect. One time, by hand.

After that it keeps itself signed in. The token lasts about eighty minutes and
Chrome *deletes* it at expiry, so by the time a run needs it, it is usually
gone entirely — and the morning brief fires before anyone is at a desk. A run
whose stored session has lapsed opens a Tesla OS tab, lets Entra re-issue
silently, takes the token and closes the tab behind itself. Nothing is said
about it; that is the normal case.

**The first connect is deliberately not automatic.** A board that has never
been connected has no business opening a browser window on its own, on a
machine that may not be set up for it, for an optional column — and the first
sign-in is the one that may genuinely need a person, since Entra only re-issues
silently once a profile has been through it. So a cold board says "connect this
once" and waits. Only a session that has worked before is repaired unasked.

A failed renewal stops trying for ten minutes rather than making every run
wait. Pressing Connect clears that and retries immediately.

None of this is required. Without Tesla OS every mileage figure is still
correct and only the badge is missing, which is why that row is amber rather
than red.

---

## Morning brief

Admin › Alerts › **Morning brief**. A separate card from the hourly digest,
meant to go out an hour before the doors open. It says where **yesterday**
finished — the percentage alone, not the list — and then names today's
customers who have **not** stated Sub-Intent, addressed to the advisor who owns
each one. Always those two dates, whatever the dashboard is showing.

**This is the one card that carries customer names, and that is deliberate.**
The hourly digest is VIN-only and stays that way: it fires up to nine times a
day about cars that are merely mid-window, and a name repeated that often is
exposure with nothing gained. The brief fires once, is addressed to a named
advisor about their own customer, and does not survive being reduced to a VIN.
That split is enforced by `assertNoPii`, which `digestCard` calls and which
throws if a customer name or reference number reaches the hourly card.

### An empty list has three meanings

The headline is the only line most people read, so it has to distinguish them.
`briefCard` takes `total` as well as `unknown` for exactly this:

| state | headline |
|---|---|
| nobody to chase, all checked | "Every one of today's customers…  Nothing to chase." |
| some unknown, rest clean | "Nothing to chase among the *38* we could check." |
| **`unknown >= total`** | "Sub-Intent could not be read for **any** of today's *44* cars…" — bold, `Warning` coloured |
| no deliveries at all | "No deliveries on the board today." |

The third row is the one that matters, and it was wrong until 2026-08-25: a
board that could not reach Tesla OS opened the morning with *"Nothing to
chase"*, with the truth demoted to a small grey footnote underneath. That is
the null ≠ "none" invariant surviving all the way through the
data layer and then being thrown away by the presentation layer (see [Four
states, and the difference between two of them matters](#four-states-and-the-difference-between-two-of-them-matters))
— the rows were
correctly `null`, and the card still said the reassuring thing. A never-connected
board is now a routine state rather than an exotic one, so it would have been
seen. When `unchecked` holds the footnote is suppressed, because the headline
has already said it louder. `unchecked` is also on the flat payload, so a flow
branching on `noIntent: 0` can tell a clean morning from a blind one.

---

## Hourly Teams alerts

Admin › **Alerts**. During your hours of operation, on every hour, the board
runs today's report itself and posts one Adaptive Card to a Power Automate
webhook listing the cars that have not yet reached the FSD bar. A car at or
above the bar is finished and is never posted. **An hour with nothing to chase
posts nothing at all** — a channel that only ever shows work to do is one
people keep reading.

Settings live in `.connections.json` as five flat keys (`alertsOn`,
`alertWebhook`, `alertStart`, `alertEnd`, `alertDays`). Flat rather than one
nested object because `saveConnections` is a shallow merge: a nested object
would be replaced wholesale by any patch that touched it, so saving the
webhook would silently blank the day list.

**The end hour is included.** 09:00–17:00 posts nine times, and the 17:00 one
is usually the useful one. Alerts fire on the hour; the minutes are stored
because `<input type="time">` emits them, and ignored.

**The webhook URL is a credential.** It is never returned to the page — the
panel shows the host and nothing else, and the input box is never pre-filled.
Note that this is *not* the masked-tail treatment the Intrepid cookie gets:
the last eight characters of a Power Automate URL are the end of the `sig`
HMAC, which is the secret itself.

> **Paste the whole URL.** Copied through a terminal it gets cut at the first
> `&`, which keeps the address and loses the signature. Every post then fails
> `401`, and it reads like a tenant policy problem rather than a truncated
> paste. Both the panel and the server refuse a URL with no `sig=`.

**Send now** is a manual override: it runs the report and posts immediately,
ignoring the hours, the days and the switch. It does not affect the next
scheduled post. **Preview** does the same and posts nothing, which is how the
whole thing is testable without putting cards in a channel. **Test** posts a
sample card without running a report, and fires even when alerts are switched
off — a test button that silently did nothing while off would be
indistinguishable from a broken webhook.

### What the card carries, and what it never does

VIN, model, miles, handover time, and the delivery advisor when the run was in
advanced mode. **Never the customer name and never the reference number** —
both identify the person who took delivery, and this goes to a channel. There
is an assertion for it.

Capped at 12 cars with an "and N more" line: Teams caps an incoming payload
around 28 KB and collapses a tall card behind *Show more*, so rows past the
twelfth are unread by construction.

Cars are listed fewest-miles-first — the inverse of the dashboard's sort,
because a chase list should lead with the worst case rather than the best
story.

### Scheduling, and why it behaves the way it does

A 30-second tick compares the current wall-clock hour against the last hour a
digest was decided for — a *name* like `2026-08-13T14`, not a timestamp. Not a
`setTimeout` chained to the next boundary: that is stateful about the future,
so a laptop that sleeps through one fire loses the following hour too, with
nothing to notice.

Consequences, all of which fall out of the marker rather than being
special-cased:

| Situation | Behaviour |
|---|---|
| Sleep 08:30, wake 11:20 | **One** post, for hour 11. Not three catch-ups for the hours it slept through |
| Spring forward | 02:00 does not exist locally, so it never produces a key and nothing is attempted for it |
| **Fall back** | 01:00 happens twice and produces the same name twice, so **only the first posts**. One post per named hour — deliberate, not a bug |
| Restart at 09:47 | No post until 10:00. A card labelled as the nine o'clock check, sent at 09:47, would be a lie |
| Restart at 09:02 | Posts within 30 s — the boundary is still in reach |
| Restart inside a posting hour | Can produce one duplicate. The marker is in memory on purpose: persisting it would race the admin panel on `.connections.json` every hour, and a crash loop that persisted it would *suppress* alerts. A duplicate gets noticed and ignored; a silence does not |

**Only one report runs at a time.** Reports used to be serialised by
convention — one operator, one tab. An hourly background run makes a second
report routine, and two concurrent runs share the MCP session, the settled
measurement cache and its dirty flag, and the module-level notices array,
which `takeNotices()` drains with a `splice` — so a concurrent run does not
merely race the warnings, it *steals* them. Acquisition is asymmetric: a user
run **queues** (the progress panel says it is waiting on the hourly check),
and the scheduler **skips** and retries on the next tick, because a digest
four minutes late is worse than one missed hour.

**A failing hour is not retried.** A 401 will still be a 401 in thirty
seconds, and 120 retries an hour is how a board gets rate-limited. One attempt
and one warning per hour; the failure surfaces in `/api/state` so the panel can
show it. **Errors are never posted to Teams** — an alert channel that fills
with plumbing failures gets muted, and then the real alerts are lost too.

---

## Configuration

`config.json`:

| key | meaning |
|---|---|
| `port` | default 3120. `PORT=` in the environment wins over it. The launcher reads this same value, so changing it here also moves the browser tab it opens |
| `droveThreshold` | miles a car must reach to count as having driven on FSD, default 1. This is the shipped default; Admin › Measurement saves a per-machine override to `.connections.json` that wins over it |
| `windowHours` | how long after handoff miles are counted for, default 12. Past it a car is never read again and its figure is final. Changing this invalidates the stored measurements rather than re-labelling them |
| `trtId` | last-resort default. The centre chosen in the dashboard nav is saved to `.connections.json` and wins over this; `--trt=` on the CLI wins over both |
| `lookbackHours` | vitals floor, default 168 (7 days). Widened automatically when the date is older, so the baseline is never lost |
| `concurrency` | parallel mileage lookups, one per delivered car. This is now the whole runtime |
| `scopeConcurrency` | parallel telemetry probes for cars with no routing location. Rarely used since the VRL filter landed |
| `outputDir` | `~` expands to `%USERPROFILE%` |

Mode and the chosen TRT live in `.connections.json`, not here — per-machine
choices that have to survive a restart, sitting next to the credential they
depend on.

**The TRT sticks until it is changed.** Pick a centre from the nav once and
every later visit, and every CLI run without `--trt=`, uses it. It was
session-only originally, on the theory that a dashboard left open on one
centre should not silently become someone else's default — but this runs on
one person's machine against one centre, so that guarded nothing and cost a
re-entry every visit. Admin › Maintenance › **Reset dashboard** clears it.

## Notes

- Cybertrucks appear in this data (`7G2CEH…`, model `ct`). Do not assume 3/Y.
- If the CSV is open in Excel the write fails with `EBUSY`. The script detects
  that and writes a timestamped file alongside rather than losing the run.
- Used inventory is re-delivered and shows up in the day's population — a 2022
  car with an 08-01 delivery date is not a bug.
- Runs report their phase as they go — the dashboard polls `/api/progress`,
  the CLI logs to stdout. Left over from when a run took twelve minutes; still
  useful for a wide date range.
- No dependencies, no build step. Node 18+.

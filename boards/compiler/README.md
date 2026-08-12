# The Compiler

A board of tools over the two systems that between them describe a vehicle.
**Garage** says what a car *is* — model, tag, ownership, delivery stage.
**Intrepid** says what is *wrong* with it — service visits, containment
campaigns, logistics holds. Neither can answer alone, so the board joins them.

Local, zero dependencies, no build step. `node server.js` and open the port.

Two tools: **Service Visits**, which asks both systems what is holding a car
up, and **Cars on Ground**, which asks Intrepid alone where each car stands in
the receiving ladder. The board is built to take more.

---

## Quick start

```sh
node server.js            # http://localhost:3131
```

Or double-click `Start The Compiler.cmd`.

First run needs both sources connected — Admin (code below) › Sources. Both
are one **Connect** press each: the board opens an isolated Chrome profile,
you sign in, and it reads the cookie back over CDP. Both sign-ins share the
same window, so the second Connect usually needs no second sign-in.

---

## The two sites

The TRT picker beside "The Compiler" sets two things: the **main site** and,
optionally, an **offsite** lot. Both use the same type-ahead; leave the second
empty on a board that only has one site.

Service Visits then opens with a **Sites** filter — *Onsite*, *Offsite*,
*Onsite & Offsite* — in the same chips as every other facet.

### The two sites use two different fields, and that is not a mistake

The centre is `vehicle_routing_location`. The offsite lot is `trt_id`.

Measured at Cypress on 2026-08-11, across its 576 undelivered cars:

| trt_id | cars | |
|---|---|---|
| 487417 | 161 | the offsite lot |
| 17589 | 160 | the centre itself |
| *(none)* | 111 | |
| 15047, 8162, 16402, … | 144 | logistics codes not yet shed |

`trt_id` therefore **cannot enumerate a centre** — it misses the 111 carrying
none and the 144 still on a transit code. VRL can, which is what enumeration
has always used. But `trt_id` is the only field that knows which *lot* a car is
standing on.

**Intrepid cannot help here.** It has never heard of 487417: not in
`getLocations` (1,856 records), not in `getCogInventoryCars`, and asked about
those cars directly it places them at 17589. The offsite lot exists only in
Garage. This is also why the picker's name search cannot find it — that search
reads Intrepid's directory. Type the number instead.

So: **enumerate by VRL, split by `trt_id`.** Both indexed, so all three scopes
are one query each and cost exactly what the single-site scan did.

```
Onsite   vehicle_routing_location:17589 AND NOT trt_id:487417      415
Offsite  trt_id:487417                                             176
Both     (vehicle_routing_location:17589 OR trt_id:487417)         591
```

The three are **disjoint by construction** — onsite excludes the lot — so
Onsite + Offsite = Both, with nothing counted twice. Offsite is deliberately
not confined to the VRL: 15 of those 176 sit outside it and are still on the
lot. With no offsite configured, the query is byte-identical to what the board
built before any of this. Cars on Ground is unaffected and stays on the main
site.

The picker opens with both fields already filled in. It writes both on every
save, so a blank offsite box means "clear it" — which is why it is prefilled
rather than starting empty.

---

## Service Visits

Pick a centre in the nav, press **Service Visits**, choose what to look for and
which cars to look at, and run the scan.

### What it looks for

| Kind | Source | Meaning |
|---|---|---|
| Service visits | `getScaServiceVisitByVin` | An SCA service visit — the SV number, when it opened, when it is due |
| Containment | `bulkGetCampaignContainmentHolds` | An active containment campaign, with its title and action type |
| Logistics holds | `getLogisticsHoldByVin` | Held in logistics, with the reason spelled out |

Each is a toggle because each costs a call per vehicle. Containment batches
five VINs to a call; the other two do not. Turning one off on a wide selection
is a real saving, not a cosmetic filter.

### The SV number opens the visit in the Service App

An SV number is a link to:

```
https://serviceapp.tesla.com/service/service-visit-actions/active-service-visit-actions/<serviceVisitID>
```

The board still cannot *read* a visit — the concern text lives in SCA and the
Intrepid header carries none of it. But it can hand the visit to the app that
can, and that costs nothing: `serviceVisitID` is already on every row, so there
is no extra call and no new field.

**Why this route and not the one a human lands on.** Searching in SCA gives
`/service/service-home/product-details/<accountId>/<vin>/service-visit/<id>`,
and that first segment is unusable here. It is not a vehicle id: one value was
seen against three different VINs, and single VINs against several values — it
is account-level, and it appears in neither Garage nor Intrepid. Garage's own
device id is 16 digits and a different namespace entirely. The
`active-service-visit-actions` route takes the visit id alone, which is the
only reason this link can be built at all.

Two caveats worth knowing before trusting a click:

- The route is named **active**. Every id checked against it came from a visit
  that was open at the time, so an old closed visit may land somewhere thinner.
- A visit with no `serviceVisitID` renders as plain text, exactly as before.

### What it can filter on

Every value in the menu was read off the index rather than invented — a sample
of 600 cars at one centre, tallied per field. A filter offering values the data
has never held is worse than no filter: it returns nothing and looks broken.

| Facet | Field | Values |
|---|---|---|
| Delivery state | `delivered` | Undelivered · Delivered |
| Vehicle tag | `vehicle_type` | Customer · Inventory · Service loaner · Internal · Marketing · Engineering · Mobile service · Energy |
| Ownership | `ownership` | Customer · Tesla Motors |
| Category | `vehicle_category` | Standard service loaner · Core operations · Mobile EV · Mobile tire · Mobile tire lite · Event |
| Fleet status | `fleet_status` | Active · Inactive · Pending cycle in · Pending cycle out |
| Delivery stage | `delivery_stage` | General assembly · Arrived at VRL · Arrived not at VRL · Rectification · At service center · In-garage delivered · Post delivery owned · Frozen |
| Model | `model` | Model 3 · Y · S · X · Cybertruck |
| **Title status** | *(not indexed — see below)* | New · Used · Salvaged · TBD |

Facets AND together; values inside one facet OR. Nothing selected in a facet
means no opinion, so the query only ever narrows. The Lucene it built is
returned with every scan and shown in the server log, so a surprising result
can be checked rather than argued with.

### New / Used is the one Garage cannot answer

There is no title field anywhere in the vehicle index. The answer lives in
Intrepid's Falcon record as `TitleStatus` — `falconVehicleSearch?vin=` — one
call per VIN, so it cannot go into the Lucene query and is applied *after* the
population is in hand. Three consequences worth knowing:

- Selecting a title value costs an extra call per vehicle. Leave the facet
  empty and no title is looked up at all.
- The title pass runs **before** the hold lookups, so filtering to Used first
  means the expensive per-vehicle hold calls only run on cars that survived.
- `total` is the index match; `scanned` is what was left after the title
  filter. A notice states both.

**Values come back in mixed case** — `NEW`, `USED` and `Used` all appear at
the same centre on the same day. Both sides compare lowercased, exactly as
Intrepid's own page does. Anything matching these raw drops a third of the
used cars and looks like a data problem rather than a bug.

A car Falcon has no record of is **left out** rather than assumed to be New —
an absence of evidence is not evidence, and the notice says how many.

**Values are quoted at query time.** A bare `vehicle_type:customer-vehicle`
parses the hyphen as an operator and quietly matches the wrong set.

### Why enumeration is Garage and not Intrepid

Intrepid has its own vehicle list — `getTssAppointmentsByDate`, which is what
its vehicle-readiness page calls "cars on ground". It is a **per-date
appointment list**, and a car that was booked and then stuck does not
necessarily appear on any date: one VIN with an open SV, an appointment on the
3rd and `isDelivered: false` was absent from every date from the 3rd to the
8th. Enumerating that way would silently miss exactly the cars worth finding.

Tesladex has no such gap — a car is in the index whether or not anyone
scheduled it — so scope comes from Garage and only the holds come from
Intrepid.

### Cost and the cap

One index query per hundred vehicles, then per vehicle: one call for the
service visit, one for logistics, and a fifth of a call for containment. A
centre's ~540 undelivered cars is about two minutes. Scans stop at
**1,200 vehicles** and say so in a notice rather than silently truncating —
if the notice appears, narrow the filter; nothing past that point was checked.

### Reading a row

State lives in the border, never a fill: amber for a service visit, red for
containment, blue for a logistics hold. The VIN links to that car's vitals in
Garage — `/vehicles/<vin>/vitals`, which is Garage's own route, the same href
its VIN-debug page builds.

**Flagged only** is the default view because the clear cars are not the
question. **All scanned** shows the whole selection.

### Export

**Export** writes an `.xlsx` of exactly what is on screen — no re-scan, so the
file matches the page and costs nothing. Re-scanning would also legitimately
return something different: service visits open and close while you read.

"On screen" includes the Flagged only / All scanned toggle, so the view is in
the filename. Exporting 8 rows when someone believed they had 40 is a nasty
surprise; a file called `…-flagged-…` is not.

```
compiler-service-visits-<site>-<flagged|all>-<yyyy-mm-dd>.xlsx
```

One row per vehicle, twenty-four columns: the identity and tag fields, a
`Flagged` yes/no, a `Blockers` summary, then a count plus the detail for each
of the three kinds. **Not one row per hold** — a car with two campaigns is
still one car, and a sheet that repeats it double-counts the moment anyone
sums a column. Multiples are joined into the cell *and* counted in their own
column, so both readings stay available.

Counts are written as numbers rather than text, so a column sums without
anyone retyping it — the reason this is xlsx and not CSV. The header row is
frozen and auto-filtered. Dates are normalised to `YYYY-MM-DD`; Intrepid
returns them in three different formats.

The writer (`xlsx.js`) has no dependencies and stores rather than deflates.

---

## Cars on Ground

Pick a centre, press **Cars on Ground**, choose which rungs of the ladder to
list, and run. **VRI Pending** is pre-selected because it is the question the
tool was built for.

Intrepid calls that rung "Receiving Inspection Pending"; nobody at a centre
does. They are **VRIs** — Vehicle Receiving Inspection — so that is what the
board calls them. The rename is display-only and lives in `COG_LABELS` in
`lib.js`; Intrepid's own string is kept beside it as `apiName`, so grepping
the board for what Intrepid actually returned still finds it. Nothing keys on
either string — the status is matched by id everywhere it matters.

The ladder is Intrepid's own, read from `getVehicleStatusOptions` rather than
copied here, and it is not in id order — `displayOrder` is:

| | | |
|---|---|---|
| 11 | Too Dirty to Inspect | |
| **1** | **VRI Pending** | `Receiving Inspection Pending` upstream · the default |
| 2 | PDI Pending | |
| 4 | Ready for Prep | |
| 5 | In Service | |
| 6 | In Wash | |
| 7 | In Charge | |
| 8 | Finished Goods | |

### Three calls, none of them per vehicle

| Call | Gives |
|---|---|
| `getCogInventoryCars?trtId=&pageSize=` | every car on ground at the centre |
| `getAllVehicleShipments?trtId=` (POST `{vins}`) | the COG record per VIN, in bulk |
| `getVehicleStatusOptions` | id → name |

A 700-car centre is about three seconds, which is why this tool has no scan
cap and no concurrency knob. It is also why it enumerates from
`getCogInventoryCars` rather than from the appointment list — no date in the
query, so it cannot miss a car the way `getTssAppointmentsByDate` does. See
*Why enumeration is Garage and not Intrepid* above; the same gap, dodged a
different way.

The inventory list repeats a VIN when a car has more than one shipment leg
behind it, so it is deduplicated to one row per car — otherwise a car is
counted twice and the lot looks bigger than it is. A VIN with two COG records
resolves to the most recently updated one, which is the live one.

`pageSize` is asked at 5,000 where Intrepid's own page asks 1,000. Nothing
observed comes near either, but if the reply ever hits the ceiling a notice
says so rather than handing back a quietly short list.

### Dwell is the answer, so it is the number on the row

Dwell is now minus `arrivalTimeStamp`, which is what Intrepid's own page
computes. Those timestamps carry no offset and Intrepid reads them as local
time, so this does too — the answers are in months and an hours-wide timezone
argument changes nothing anyone reads off the screen.

Hours below two days, days above: a car standing since 2022 rendered as
"36,207h" is accurate and useless. Rows sort longest-first by default, because
on a pending-inspection list that is the running order rather than a
preference. **Newest first** reverses it.

The border earns its colour from dwell, not from status — a car pending
inspection for an hour and one pending for two years are the same status and
completely different problems. Amber past a week, red past a month.

### Cars with no COG record count as VRIs

A car Intrepid holds **no COG record for at all** is counted as VRI Pending,
because that is what Intrepid's own page shows for it:
`getCogVehicleData` sets the status to pending before it looks at anything,
and only overwrites it if a record turns up.

This board shipped for about an hour doing the opposite — reporting those
separately, on the reasoning that a centre with no COG records at all would
otherwise have its whole lot called "awaiting inspection". Which is true:
Houston-Cypress has 6 of 698 that way, Denver-Littleton 85 of 91, Orlando
77 of 77. It is also beside the point. Houston's screen said 6 and the board
said 0, and a board that disagrees with the screen the work is actually run
off is wrong no matter how good the reasoning behind the disagreement. The
count matches Intrepid.

The distinction is kept where it costs nothing: each such row carries a
**No COG record** marker, a notice gives the number, and the export has a
`Status source` column reading `COG record` or `No COG record`. So the
question "is this status read off a record or inferred from the absence of
one?" is still answerable per car — it just no longer changes the number.

If Intrepid ever stops publishing a receiving-inspection rung, those
cars are counted nowhere rather than guessed onto some other status, and the
notice says so.

### Reading the strip

`On ground` is the whole centre; `Listed` is what the chosen statuses matched.
Longest, median and over-30d are over the listed cars, in days, so the tiles
compare side by side. An empty result spells the whole ladder out underneath
it — a healthy lot answering "none pending" should read as an answer, not as a
broken tool.

### Export

Same rules as the other tool: exactly what is on screen, no re-scan, status in
the filename.

```
compiler-cars-on-ground-<site>-<statuses|all-statuses>-<yyyy-mm-dd>.xlsx
```

Nineteen columns. Dwell goes out **twice** — a readable `1508d` to look at, and
the same span as a number in both hours and days, so a column can be sorted,
filtered above a threshold or averaged without anyone parsing a duration back
out of a string.

---

## Credentials

| | |
|---|---|
| Admin password | `226565` — six-digit gate, same as the other boards. House default; override with `.admin.json` |
| Garage | `…_s_garage_session` cookie in `.connections.json` |
| Intrepid | `cogs-authorization` cookie in `.connections.json` |

Both live in one gitignored file. The admin password is a guard against fat
fingers rather than an attacker, but it is checked server-side all the same,
because a client-only gate is no gate at all.

### Two cookies, no OAuth, and nothing shared with any other board

Garage's index is reachable over its own web session:
`GET /api/1/tesladex/search?type=vehicle&query=…&fields[]=…&size=…&from=…`,
authenticated by the `…_s_garage_session` cookie alone. Verified against the
MCP `tesladex_search` tool on the same query — same total, same rows, same
fields — so the board reads the same index either way.

It used to go through MCP, which meant a registered OAuth client, a token
store, a refresh dance and a session handshake to reach exactly that data.
That is gone. What it bought was cost rather than capability: for one
afternoon this board shared an OAuth client registration with another
dashboard, and since refreshing rotates the refresh token, whichever board
refreshed first would strand the other.

**This board now requires nothing from any other project and nothing outside
its own folder.** No shared module, no shared token store, no shared
registration; delete every sibling dashboard and it still runs. The one thing
in common is the *path* of the isolated browser profile the sign-in window
uses — a convention, not a dependency: if another tool already signed that
profile in, Connect just works; if not, it opens and asks.

Two consequences of the REST endpoint worth knowing:

- A bare `*:*` is rejected as a full-text search, where the MCP tool allowed
  it. The health check probes `delivered:true` instead.
- A dead session does not answer `401` — it redirects to SSO or returns the
  sign-in page with a `200`. Both are read as "sign in again" rather than as a
  parse failure, so the panel points at the right fix.

Intrepid's cookie is HttpOnly and scoped to `intrepidapi.tesla.com`, so
`document.cookie` on the SPA will not show it. **Connect** handles this: it
opens an isolated Chrome debug profile, waits for the sign-in, and reads the
cookie over CDP. Pasting by hand still works — DevTools › Application ›
Cookies on `intrepidapi.tesla.com`.

Both sources are required and there is no degraded mode. A scan missing half
its sources would answer the question wrongly instead of refusing, which is
the worse failure.

---

## Layout

```
config.json     port, hosts, concurrency, the shipped admin password
lib.js          everything that talks to Garage or Intrepid, plus the facets
server.js       thin HTTP layer; no tool logic lives here
index.html      the board — ZO-1, one file, no build
```

`FACETS` and `HOLD_KINDS` are defined once in `lib.js` and sent to the page at
boot, so the filter menu, the query builder and the row labels cannot drift
into three different vocabularies. Adding a facet is one entry in that object.

The COG ladder is not in that boot payload. It is fetched when the Cars on
Ground menu first opens, because a board that will not paint at all because
Intrepid is down is worse than one whose second tool says so when you reach
for it.

Style is **ZO-1** — see `~/zo-projects-theme.md`. Inter only, uppercase
micro-labels tracking wide, display numerals tracking tight, 18px cards and
4px buttons, state in the border.

## Adding the next tool

Put a button in `.tools` in the hero, a modal for its options, and a route in
`server.js` that calls into `lib.js`. The nav, TRT picker, admin panel,
progress bar, notices and both connections are already there and are not
specific to either existing tool.

What Cars on Ground had to touch, and a third tool will too: `S.tool` decides
which renderer the list uses, `paintStats()` writes the strip rather than
filling in fixed tiles, and `/api/export` branches on `kind`. Two tools
sharing one hardcoded strip would leave whichever ran last staring at tiles
that count the other one's question.

One trap, twice now: a class rule setting `display` beats the browser's own
`[hidden]` rule, so anything hidden by attribute needs a `[hidden]` rule of
its own in the CSS — see `.list-head` and `.chip`.

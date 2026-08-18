# The Compiler

A board of tools over the systems that between them describe a vehicle.
**Garage** says what a car *is* — model, tag, ownership, delivery stage.
**Intrepid** says what is *wrong* with it — service visits, containment
campaigns, logistics holds. The **Service App** says what the work actually
*is*: the symptom on each ticket, which neither of the other two carries.
**Tesla OS** says who is *waiting* for it — the order a VIN has been matched
to, which none of the others knows exists. None of them can answer alone, so
the board joins them.

Local, zero dependencies, no build step. `node server.js` and open the port.

Three tools: **Service Visits**, which asks Garage and Intrepid what is
holding a car up; **Cars on Ground**, which asks Intrepid alone where each car
stands in the receiving ladder; and **Pending Inventory**, which asks Tesla OS which
cars are matched to a customer with no appointment booked and Garage what
those cars are. The board is built to take more.

---

## Quick start

```sh
node server.js            # http://localhost:3131
```

Or double-click `Start The Compiler.cmd`.

First run needs Garage and Intrepid connected, which happens once on the **Zo
Projects Hub** and covers every board. The **Service App** and **Tesla OS**
connect on this board instead — Admin (code below) › Sources › Connect, or, for
SCA, the prompt the board shows when it opens. All four share one isolated
Chrome profile, so every Connect after the first usually needs no sign-in.

Garage and Intrepid are required. The other two are not, and they are missing
in different ways: without SCA a service visit shows as a bare number instead
of what it is for; without Tesla OS, Pending Inventory will not run at all, and the
other two tools do not notice.

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

### One VIN, and none of the filters

The dialog opens with a **One VIN** box above everything else. Paste a VIN,
press Look up, and the board goes straight to that car.

**Every filter below it is ignored, deliberately.** A VIN is not a narrower
version of a centre scan — it is a different question, asked about a car that
may be at another site, delivered, or in a state no facet on the menu selects.
Applying the site or the facets would answer *"no cars found"* about a car the
reader is holding the VIN for, which is the worst possible reply. The kinds go
unsent too: all three are cheap on one car, and a lookup that quietly skipped
containment because a toggle was off would be a lie rather than a saving.

It is the same route, the same enumeration and the same row shape — the server
just queries `vin:<VIN>` instead of a centre — so the ticket panel, the
concern editor, the export and every write behave on it exactly as they do
inside a scan. The view opens on **All scanned** rather than Flagged, because
"Nothing flagged" in answer to a VIN reads as "no such car".

A VIN that is not in the index says so in those words, which is a different
sentence from an empty scan and points at a different next move.

### What it looks for

| Kind | Source | Meaning |
|---|---|---|
| Service visits | `getScaServiceVisitByVin` | An SCA service visit — the SV number and when it opened, then the ticket itself from SCA and the receiving inspection from the status log |
| Containment | `bulkGetCampaignContainmentHolds` | An active containment campaign, with its title and action type |
| Logistics holds | `getLogisticsHoldByVin` | Held in logistics, with the reason spelled out |

Each is a toggle because each costs a call per vehicle. Containment batches
five VINs to a call; the other two do not. Turning one off on a wide selection
is a real saving, not a cosmetic filter.

### Where the car is

Every row carries a site pill, in the slot the Title status pill used to have.
Title is a fetched field most scans never ask for, so that pill was usually
absent; the site is on every row. Title is still filterable and still exported.

**Garage says which site; the site directory names it.** Garage's `trt_id` is
the only field that knows a car is standing at Collision rather than at the
centre it routes to. It does *not* carry the name, and
`delivery_details.destination_trt_city` is not the name either — that is where
the car is *going*. One Cypress car reads `trt_id: 7198` (Collision Houston)
with `destination_trt_city: "Houston - Cypress"`; naming from it would
confidently print the wrong place. So the name comes from the ~1,850-site
directory the board already caches for the TRT picker. No new source, and it
works with SCA disconnected.

**`trt_id` is not complete, and the pill is built around that.** On a 436-car
Cypress scan: 199 name a real site, 84 carry logistics codes not yet shed
(8162, 16402 …), and 107 carry nothing. Fed by `trt_id` alone the pill would
print "TRT 8162" on a fifth of the list and nothing on another quarter. So it
falls back to `vehicle_routing_location`, which is complete, whenever the
directory cannot name the `trt_id`. Every row ends up with a site.

A car is **marked** only when `trt_id` named a site and that site is not the
one being scanned — 33 of 436 at Cypress, including 7 at Collision Houston. A
car whose `trt_id` is a stale logistics code falls back quietly rather than
being flagged: it is not known to be elsewhere, only known to have a stale
code.

> **Caveat worth knowing.** Some logistics codes *do* resolve to real names —
> 20 Cypress cars mark as "Robo Service Austin Factory" (trt 15047) and one as
> "Pack Service Fremont Factory". Those are almost certainly stale codes rather
> than cars in Austin, and nothing in Garage distinguishes a stale code from a
> real position. The pill reports Garage faithfully; it is not proof of where
> a car is standing.

### What the visit is actually for

Under each SV number sits the concern the visit was opened for: the symptom,
its type and category, the estimated hours, and a link to its photos. One line
per concern, so a car with three of them shows three.

```
SV02D972BB · opened 8/13/2026 · VRI completed 8/13/2026
Tesla Service Houston-Cypress
BACKLITE GLASS [ Crack / Shattered ] · Cosmetic · Logistics Damage · 1.08h · See images (3)
```

The second line is the **service centre the car is checked in at**, which is
not always the centre being scanned — a Cypress scan turns up visits at
Richmond, at Tesla Collision Houston, and one as far off as
Cleveland-Lyndhurst. **See images** opens the photos attached to that concern.

This comes from **SCA**, not Intrepid, and it is worth knowing why. Intrepid's
`getScaServiceVisitByVin` returns a visit *header* whose `activities`,
`noteList`, `severityDescription` and `estimateDetails` are always null and
whose `activityCount` is always 0 — checked across 21 real visits. A dozen
guessed detail endpoints on that API all 404. The detail is not hidden in
Intrepid; it is not in Intrepid.

SCA answers it in two calls per vehicle that has a visit:

```
GET /case/api/visit/VIN/<vin>?includeActivities=true&includeContact=true&includeTags=true
GET /case/api/visit/<serviceVisitID>/activities
```

**Two calls and not one.** The row already holds Intrepid's `serviceVisitID`,
so the first call looks skippable. It is not: nothing has ever proven
Intrepid's id is byte-identical to SCA's. The ranges match and the numbers look
right, which is exactly the kind of evidence that holds until the day it does
not. Going in by VIN needs no such assumption. The visits are then matched on
`serviceVisitNumber` — a printed string on both sides — with the id as a
fallback.

Only vehicles that already have a visit get here, so the cost tracks how many
cars are in for work rather than the size of the centre: a 443-car scan of
Cypress with 45 visits spends 90 calls and about two seconds.

**The long form is in the ticket panel, above the images.** The row compresses
a concern into one dot-joined line because it has one line; open the car and
each concern gets its symptom at reading size, its classification under it,
the narrative a technician typed, and who logged it and when. Every concern on
the visit, not just the first — a visit with three of them is three pieces of
work, and the panel that can move it should say so.

Above the images rather than below, because the words come first: a photo of a
scratched fender means something once you have read *FENDER, LH [ Paint /
Chips ] · Logistics Damage*, and very little before it.

### Remove a courtesy line, or change what a concern says

Two buttons in the ticket panel, and which one you get depends on the concern:

| | |
|---|---|
| **Courtesy Service Provided** | **Remove** — takes the line off the visit |
| everything else | **Edit** — change the symptom, from SCA's own catalogue |

The courtesy line is matched on its symptom text, because SCA has no flag for
"this is the courtesy line" — the catalogue entry is a symptom like any other.

**Remove is not a cancel, and that is the whole point.** Cancelling closes the
ticket and disturbs billing, which this board has been told twice never to do.
This returns the activity to *outstanding work* — SCA's own label for the
button is `activity_remove_and_return_to_outstanding_work`. The concern
survives, it is simply no longer on this visit, and the slider says so in
those words before it will move.

```
POST /case/api/visit/<svid>/removeactivities         body [<activityID>]
PUT  /case/api/case/activities/update/<id>?preventOverride=false
POST /integration/api/persona/symptom/search?modelId=<n>&locale=en-US  {term}
GET  /integration/api/persona/symptom/<symptomCode>/<modelId>?locale=en-US
```

#### All four were captured, not guessed

The bundle gave the URLs; the bodies came off the wire while Ed pressed the
buttons in the debug Chrome with `capture-act.js` recording. That is the rule
on this host after `cancelServiceVisits` returned `success:true` while closing
a ticket, and it earned its keep again here — three things a guess would have
got wrong:

1. **The update PUT carries the whole activity, parts included.** On the
   captured ticket that was a correction line holding an $850 backlite glass
   and two more parts. Read the record without `includeParts=true`, echo it
   back, and the PUT writes an empty parts list. So the body is built from
   `POST /activity/api/activity/visit/<svid>/activities?includeParts=true`,
   which returns the wrapper in exactly the shape the PUT wants it — 112
   fields, verified field-for-field against what SCA itself sent.
2. **Two fields move with the symptom and are not in the search results.**
   `cosmeticIssue` and `hyperSymptom` come from
   `additionalAttributes` / `reportingAttribute` on the *single-symptom* GET,
   which the search never populates. SCA reads exactly those two when you pick
   a symptom. Carrying the old ones over would misfile the car, since
   hyperSymptom is what the concern filter groups by.
3. **The GET is code-then-model.** `persona/symptom/<symptomCode>/<modelId>`.
   The other way round answers *"Record not found"*.

SCA follows its own PUT with an `activityextension/add` and a second PUT at
`preventOverride=true`. Neither is sent here: the first PUT already returns the
new symptom on the record, and the extension call carried nothing but nulls.

#### Judged on the read-back, never on the 200

Both writes re-read the record and report what the read said. Remove also
reads **before** it fires and refuses if the line is not on the visit — without
that, "it is not on the visit now" is equally true of something that was never
there, so a stale tab would get a confident success for doing nothing.

The round trip was measured on a live ticket: change the symptom, change it
back, then diff the activity against what it was beforehand. **One field
differed — `modifyDate`, which the server sets.** Parts, narrative, estimate
and status were byte-identical.

Four ways to be refused, all of them tested: a line already off the visit, an
activity that is not on this visit, a symptom code the model's catalogue does
not have, and a code that did not come from SCA's list at all.

### Call Onsite / Send to Body

A car with an open service visit that Garage places at the **offsite lot**
gets two buttons, stacked, on its row and at the top of its ticket panel:

| | |
|---|---|
| **Call Onsite** | the VIN, that it is at the offsite lot, and to bring it onsite and check it in with service |
| **Send to Body** | the VIN, its concerns, and to take it to the body shop and check it in |

Both post to the **SV Call** webhook — its own field under Admin › Teams, kept
apart from the VRI-list one because clearing that one sets `teams: null` and
would take this with it, and because the two go to different chats: a standing
list for whoever runs the lot, one-off asks for whoever moves cars.

**Each message is checked before it is sent, against a fresh read rather than
against the tab.**

- *Call Onsite* re-reads `trt_id` from Garage and refuses if the car is not at
  the offsite lot any more — the message asserts where the car is, so the
  board confirms it still is. A tab open since the morning is exactly the
  caller that would send somebody out for a car already onsite.
- *Send to Body* re-reads the ticket from SCA and names the concerns from
  that, **leaving the courtesy line out**. It refuses if there is nothing but
  the courtesy line, or if SCA is not connected: the message names the work,
  so the board will not send one it cannot name. This matters more since the
  board can now edit a symptom and remove a line — the row on screen may be
  describing concerns that have changed.

With no webhook saved the buttons stay put and say where to paste one when
pressed, rather than vanishing and leaving nothing to ask about.

**On a row they sit in their own middle column and the row never changes
size.** Two details, both learned by getting them wrong: the outcome goes to
the notice strip rather than into the row, because a row that grows a line of
text pushes the whole list down under the cursor that just pressed it; and
both the button column and the holds column are fixed widths, because sized to
their content they tracked the longest hold line on each card and the buttons
landed at a different x on every row. The buttons themselves have a minimum
width so that becoming "Sending" mid-press cannot resize them.

The offsite lot has **no name to print** — it exists only in Garage, so the
site directory cannot resolve it — and the message says "the offsite lot (TRT
487417)" rather than the bare "TRT 487417" a lookup miss would leave.

### The photos are fetched when you ask, never on a scan

A concern's attachments arrive on the row as **ids and filenames only**. One
sampled image was **3.4 MB**; a scan that pulled them would move a hundred
megabytes to draw a list nobody has clicked. **See images** opens a viewer and
the bytes are fetched then.

The viewer is an ordinary `.modal.wide` — 760px, the same width as the admin
panel once it is unlocked, which is the state anyone actually reads that panel
in. It started as a full-screen overlay and that was wrong: these come off a
phone at 4032×3024, and blown up to fill a monitor they are harder to read, not
easier. Height is capped at 58vh as well as width, which is the part that
matters — a portrait photo constrained only by width still runs taller than the
window, so you would scroll around a single image to see the damage. Photos
stack down the scrolling body; two across at this width are thumbnails.

Being a real modal rather than a bespoke overlay also means the scrim, the
Escape key and the close button come for free instead of being reimplemented.
The one thing it adds to `hideModal()` is emptying itself on close: a phone
photo decodes to roughly 48 MB of bitmap whatever the 1.6 MB that came down the
wire, so three left in a hidden div is ~145 MB held for nothing.

They come through the board on `GET /api/sca/photo/<attachmentId>`, not
straight from SCA, for two reasons: an `<img>` cannot send a bearer token, and
a credential that never reaches the page cannot leak from one. The board
streams the upstream response rather than buffering it, and marks it cacheable
for an hour — an attachment id names one uploaded file forever, so reopening a
viewer should not refetch megabytes.

Upstream is `document/api`, a different base from every other SCA call here:

```
GET /document/api/Attachment/downloadfilebyid/<id>?interceptionexcluded=true
```

There is a `downloadthumbnailfilebyid` twin. It is not used: it 404s wherever
`thumbnailPath` is null, which was every attachment sampled, so the full image
is the only size that reliably exists.

### VRI completed — and the field that looks right and is not

Beside each SV number is **when the car cleared receiving inspection**. It
replaced the estimated completion date, which said less about a visit that has
been open four months than the inspection that let the car onto the lot.

**It does not come from `vriPassedDate`.** That field is on the COG record,
it is free, this board already puts it on the Cars on Ground sheet, and it
reads exactly like the answer. It is stamped at **Ready for Prep** — downstream
of the inspection, and re-stamped every time a car goes round again. Measured
on the 33 Cypress service-visit cars carrying both: exact on 17, and **up to 96
days late** on the rest. One car reads `2026-07-27` against a real inspection on
`2026-04-23`. ZO-003 hit this first, on a bigger sample, and found it matched
on 1 of 684.

The honest source is the vehicle status log:

```
POST /getAllVehicleShipments?trtId=<trt>   {vins:[…]}   → the per-vehicle cog record id
GET  /getVehicleStatusLogByVinWithPdiTask?vin=<vin>&vehicleShipmentId=<that id>
```

Take the most recent `Receiving Inspection Completed` entry. Three traps in
those two lines:

- **The id is `id` on the cog record, not `shipment.ShipmentId`** from the
  inventory list. The latter is the *transport* shipment — three different VINs
  came back sharing one — and the status log returns zero rows for it.
- **The log is newest-first**, so `find()` lands on the most recent inspection.
  That is the one wanted: a car re-inspected after repair cleared on the
  re-inspection.
- **Anchor on "completed".** A `Receiving Inspection Pending` entry records who
  queued the car, not an inspection anyone did.

`trtId` genuinely filters the batched call — the same VINs return 0 records
under another centre — so a car whose cog record lives elsewhere shows **no VRI
on record** rather than a date. Said out loud on the row and counted in the
notices, because a blank would read as "never inspected" when it means "not
found here". At Cypress that is 2 of 45.

The batched call is 500 VINs to a request and is already how Cars on Ground
works, so the cost is one status-log call per car with a visit — about three
seconds on top of a 45-visit scan.

**SCA is optional.** Without it the board loses these lines and nothing else —
Cars on Ground, containment and logistics never touch it. A scan with SCA
disconnected still returns every row; the visits simply show as bare numbers.
A visit whose lookup failed is silent on the row rather than showing a false
"no concern", and the count of failures goes in the notices.

### Moving a car to another service centre

Click a row and the **ticket editor** opens — a 1040px panel sized to the Zo
Hub's unlocked admin panel, holding everything the row lets you do. It began
as an inline expander and that was wrong: the dropdown fought the cards below
it for stacking order, the slider had no room, and a screen of half-open cards
was unreadable. A modal is also one-at-a-time by construction, so the
bookkeeping that closed other rows is gone.

**Move Ticket** is the first section: the centre the visit is at, an arrow, and
a type-ahead for where it is going.

```
PUT /case/api/unscheduledvisit/<serviceVisitID>/<scaLocationID>/<trtid>/location
```

Two facts about that line cost a session each and neither is guessable.

**It is visit-level, not activity-level.** The obvious call —
`location/trt/updateactivityscaLocation/{activityId}/{scaLocationId}` — is
wrong. It answers **HTTP 200 with `success:false`**: *"Activity already in a
Service Visit. Please move to outstanding to complete action."* SCA's own UI
renders that picker on the visit page regardless, so the control being there
proves nothing. **Never read a 200 from SCA as success** — check the envelope's
`success`, then re-read the record.

**The visit must be unscheduled — `appointmentID: null`.** Cancelling the
appointment in SCA is what produces that state, and it is the same thing the
error above means by "move to outstanding". At Cypress this is the common case
by a distance: of 45 visits with a ticket, **7 are movable and 38 are blocked**
by an attached appointment. Blocked rows say so and say what to do; they do not
show a control that would fail.

> **Cancelling the appointment is not cancelling the ticket.** Closing a ticket
> disturbs billing. Nothing on this board closes a ticket, and nothing on it
> cancels an appointment either — that stays a deliberate act in SCA.

Ruled out live, so they do not need probing again: `dinmove/moveactivity` is
site-based and `validatedin` returns "Invalid Value" for vehicles;
`activitycorrection/move` moves parts and labour lines; and diversion — the
app's real "send this visit elsewhere" feature — is switched **off** at Cypress
(`enable-servicevisit-diversion: false`).

**The picker** is `POST /integration/api/trt/trtbyterm {term}`, proxied through
the board so the bearer stays server-side, two-character minimum and 180ms
debounce copied from the nav TRT type-ahead. It returns **both** ids the move
needs — `scaLocationID` and `trtid` — and neither implies the other, so a row
missing either is not offered. Filtered to Service (1), SemiServiceCenter (41)
and BodyRepair (30); SCA's own picker omits BodyRepair, which would rule out
the Collision moves this exists for. Mobile, Energy, Warehouse, Robotics and
the `DO NOT USE … CLOSED` rows are dropped.

The search is **global** — typing "Richmond" offers Melbourne as readily as
Houston — so the confirm step names the car, the centre it is leaving and the
centre it is going to, and nothing saves on select.

**Refusals, all server-side in `scaMoveVisit()`:** the visit must be on that
VIN, must be open, must be unscheduled, and must not already be at the target.
Afterwards the visit is re-read and the move is only reported if the record
actually changed; every ticket's status is compared before and after and a
change is called out loudly rather than passed over.

### Move Ticket — one slide, booked or not

Pick a destination and a slider appears; drag it the whole way and the visit
moves. If an appointment is attached it is cancelled
first, in the same gesture. You never leave the board.

The slider is the confirmation — a button can be caught by a stray click or a
repeated Enter, an end-to-end drag cannot. It springs back if released short,
retracts if the destination changes, and `End` does the same from the keyboard.
There is no confirm dialog on top of it; two confirmations only teach people to
dismiss both.

**The call, and the two dead ends in front of it.** The move is

```
PUT /case/api/visit/<svid>/dateTime      body: the visit, spread, with
    locationDescription, trtid, scaLocationID, inventoryLocationID,
    scaLocationTypeID, functionID  swapped, and serviceVisitDateTime nulled
```

which is SCA's own `changeLocationInSV`. Nulling the date in that same write is
what clears the booking. Two other endpoints look right and are not:
`updateactivityscaLocation` is activity-level and answers **200 with
`success:false`** while a concern sits on a visit, and `unscheduledvisit/…/
location` only works once the visit is already unscheduled.

**The body is spread from `GET /case/api/visit/<svid>`, not from a form**, and
that distinction is the whole safety argument. SCA's own dialog builds it from
its form state and gets fields wrong — measured on a real visit, it set
`carWash` and `charge` from false to **true** out of its defaults. Echoing the
record leaves them alone, and the result reports it if they move anyway.

**The appointment**, where there is one, is cancelled first on TSS:

```
POST tss.tesla.com/react/api/proxy/api/Service/CancelAppointment
```

A different host *and* a different credential: the raw `access_token` cookie
with no scheme, plus `Calling-Application: TSS-Components (SCA)` and a `UserId`
header. The SecureToken bearer gets `401 Unauthorized user!`. Connect captures
that cookie alongside the token so one press covers both.

> **Cancelling the appointment is not cancelling the ticket.**
> `servicevisit/cancelServiceVisits` reads like the obvious call and is not: it
> cancels the visit and its open tickets, which disturbs billing. It is not in
> this codebase and must not come back. Nothing here calls `cancelActivity`
> either.

Proven end to end on a real booking: appointment `76308000` for 30 Sep
cancelled, visit moved Cypress → Tesla Collision Houston, visit still open,
both tickets status 1, `carWash`/`charge`/`transportationMethodID` unchanged.

### Cancel the appointment, without moving

**Cancel appointment only** sits on a booked visit beside the picker. It does
the cancel half of the move and stops there: TSS releases the slot, the visit
is written back with its dates nulled, and the car stays exactly where it is.

Both calls are needed. `CancelAppointment` on its own answers `success:true`
and leaves the booking showing in SCA — measured before this was built, which
is why the second write is not an optimisation to remove later.

A button rather than a slider, because the two actions are not equally hard to
undo: an appointment can simply be rebooked, whereas the move is compound. It
still confirms and still names the date. Every rule the move obeys applies
here unchanged — undelivered cars only, open visits only, ticket never touched
— and it additionally checks the **service centre did not move**, since this
call has no business changing it.

### The rule that guards the cancel

> **Undelivered cars only.** An undelivered car's appointment belongs to Tesla.
> A delivered car's belongs to a customer who has arranged their day around it,
> and this board will not cancel one.

**The check is a fresh read from Garage on every call, never a field off the
request.** That distinction is the whole safeguard: the page could be an hour
stale, and a stale `delivered:false` is precisely the input that would cancel a
real booking.

It sits immediately before the cancel, inside the branch that only runs when
there is an appointment — moving a car with no booking is harmless on any car,
cancelling somebody's booking is not. It was briefly **lost** when the earlier
cancel-and-move was deleted, and the rewrite would have shipped without it; that
was caught on the last edit before it went out. It does not move again.

It **fails closed**. A VIN that errors, is missing from the index, or matches
more than one record is refused. Not-known reads as not-allowed:

```
5YJ3E1EA0JF004865   REFUSED — is already delivered
5YJ3E1EA0JF999999   REFUSED — is not in the Garage index
7SAYGDET6TA758651   allowed
```

The panel offers the button only where it would succeed, and says why when it
does not — a delivered car with a booking gets the reason, not a greyed
control. Both layers matter: the panel is a courtesy, the server check is the
guarantee.

**Still never the ticket.** This cancels the *appointment*. `cancelActivity`
closes the ticket and disturbs billing, and is not called here or anywhere.

**The partial failure is real and is reported as one.** Two writes cannot be
made atomic over an API with no transaction. If the cancel lands and the move
then fails, the appointment is gone and the car has not moved — so that is
what it says, in the row and in the notices, rather than a generic error:

> *The appointment was cancelled, but the move failed — … The car is still at
> Tesla Service Houston-Cypress and now has no appointment. Move it from the
> row, or rebook it in the Service App.*

At Cypress today: of 45 visits with a ticket, 7 move directly and 38 need the
cancel first.

### The SV number opens the visit in the Service App

An SV number is a link. Which link depends on whether SCA answered for that
car:

```
with a ticket     /service/service-home/product-details/<userId>/<vin>/service-visit/<id>
without one       /service/service-visit-actions/active-service-visit-actions/<id>
```

The first is the page a human lands on from SCA's own search. It was
unbuildable for a long time and the reason is worth recording: that first
segment is account-level, not per-vehicle — one value was seen against three
different VINs, and single VINs against several values — and it appears in
neither Garage nor Intrepid. Garage's device id is 16 digits and a different
namespace entirely.

It turns out to be `userId` on **SCA's own visit header**, which the board now
fetches anyway for the concern text. So a row with a ticket gets the real page,
and a row without one keeps the short form, which takes the visit id alone.

Two caveats on the short form:

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
| **Scheduled for delivery** | `delivery_details.scheduled_delivery_date` | Yes *(presence, not a value)* |
| **Title status** | *(not indexed — see below)* | New · Used · Salvaged · TBD |

Facets AND together; values inside one facet OR. Nothing selected in a facet
means no opinion, so the query only ever narrows. The Lucene it built is
returned with every scan and shown in the server log, so a surprising result
can be checked rather than argued with.

### Scheduled for delivery is an existence test

The other facets ask what a car *is*. This one asks whether anybody is waiting
for it, which is what turns a service visit from a queue entry into a
deadline. One option, **Yes** — off means no opinion, on means the car has a
delivery appointment booked, on any date.

`exists: true` on the facet marks the difference: the chosen value never
reaches the query, only the fact that something was chosen, and `buildQuery`
writes a range over the whole field instead of an OR group.

```
delivery_details.scheduled_delivery_date:[* TO *]
```

Three things about that line were each a dead end first:

- **The field is nested under `delivery_details`.** The flat
  `scheduled_delivery_date` that `tesladex_fields` appears to offer is **422
  `Unknown fields`** — the listing is a tree and the leaf names in it are not
  the query paths. Sibling leaves on the same object include `eta2sc_date`,
  `destination_trt_id`, `scheduled_delivery_location_trt_id` and a
  `_local` / `_utc` pair of each date.
- **`_exists_:` is rejected**, because tesladex validates every field name in
  the query against its own map and `_exists_` is not in it. The Elasticsearch
  idiom does not survive the wrapper.
- **`:*` is wrong for a date.** A wildcard is a term query and the field is
  mapped `date`; the open range is the form that works.

At Houston-Cypress: 612 undelivered, **333 with a delivery booked**. Nested
projection also works — asking for `delivery_details.scheduled_delivery_date`
in `fields` returns only that leaf rather than the whole object, which keeps
the destination city and the rest of the delivery record off this server. It
is fetched on every scan whether or not the facet is set, because it costs
nothing on a query already running and the export offers it as a column.

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

### What the scan spends its time on

A Cypress scan of ~480 undelivered cars was 43 seconds and is now 7–13,
depending mostly on how Intrepid feels at that moment. Measured per phase,
before and after:

| phase | was | now | |
|---|---|---|---|
| enumerate | 5.8s | 1.1s | Garage, 5 pages of 100 |
| containment | 12.2s | 0.2s | 97 calls became 5 |
| holds | 21.4s | 4.5s | 2 calls per car, at a higher concurrency |
| tickets | 2.8s | 5.4s | SCA, and it is real work — 56 cars with visits |
| VRI | 0.8s | 0.6s | |

Two changes did it, and one of them was free:

**The containment batch was five VINs and is a hundred.** Measured against a
real centre, a hundred come back in the same second five did — the call spends
its time on the round trip, not on the cars. That is 483 cars in five calls
instead of ninety-seven.

> **A hundred is the ceiling and it truncates in silence.** Asked for 200 it
> answers 200 OK with exactly 100 keys and no complaint — the same shape of
> trap as the delivery pipeline's page size. The batch is pinned, and the scan
> counts the keys that come back rather than trusting them: fewer keys than
> VINs raises a notice, because a dropped car reads as a car with no
> containment hold.

**Reads run sixteen at a time, writes still run six.** `CONFIG.concurrency`
stays at 6 for waking cars and popping trunks — that pool poking a fleet is
deliberately gentle. Reads had no business inheriting it. Interleaved A/B on
the same 100 VINs, alternating to cancel out upstream drift: **1.4s at six,
0.6s at sixteen.** Past sixteen the curve flattens and the gain is tenths of a
second against an endpoint other people also use.

**The rest is upstream and outside the board's control.** Back-to-back scans
returning byte-identical results have come in at 12.8s, 24.0s and 39.7s: both
Garage and Intrepid vary by minute, and the same 100-call probe that takes
1.4s at one moment takes 14 seconds at another. The phase timings above are
one honest run each, not a promise.

There is **no bulk logistics endpoint** — `bulkGetLogisticsHoldByVin`,
`bulkGetLogisticsHolds` and `getLogisticsHoldByVins` are all 404 — so the
per-car pass stays two calls per car. Containment is the only one of the three
Intrepid publishes in bulk.

### An empty 200 means "none", not "it failed"

`getScaServiceVisitByVin` answers **zero bytes** for a car with no open visit —
about one car in ten at Cypress. The board parsed that as "did not return
JSON" and threw, and the caller swallowed the throw and recorded no visits.
Right answer, wrong route, and it had a real cost: a cookie dying mid-scan
would have been indistinguishable from a clean car. An empty body is now
`null` and a genuine failure still throws.

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
compiler-service-visits-<site>-<flagged|all>[-vin-delivery|-vin-ticket]-<yyyy-mm-dd>.xlsx
```

**Export** opens a chooser first — *which columns*, never which rows. The
narrow presets never declare their own columns; they filter the full list, or
a header renamed in one place would go stale in the other.

| Preset | |
|---|---|
| **All data** | every column — the sheet you open to work from |
| **VIN + delivery date** | two columns — the one you paste somewhere else |
| **VIN + ticket** | VIN, SV number, symptom, type, category, hours, centre, VRI |

**VIN + ticket** is offered on Service Visits only. Cars on Ground has no
ticket columns to keep, so a preset that filtered to them there would hand back
a sheet of nothing but VINs; asking for it anyway falls back to every column
rather than to an empty one.

The preset lands in the filename for the reason the view does: a two-column
file and a thirty-four-column one both called `…-2026-08-13.xlsx` are
indistinguishable in a downloads folder.

One row per vehicle, thirty-four columns: the identity and tag fields, a
`Flagged` yes/no, a `Blockers` summary, then a count plus the detail for each
of the three kinds, and — when SCA was connected for the scan — what each
ticket says. **Not one row per hold** — a car with two campaigns is still one
car, and a sheet that repeats it double-counts the moment anyone sums a
column. Multiples are joined into the cell *and* counted in their own column,
so both readings stay available. `Est. hours` is the sum across a car's
concerns, as a number, so a centre's booked hours total in the sheet.

Ticket columns come out blank on a scan that ran without SCA, and the chooser
says so rather than leaving it to be discovered in Excel.

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

### Time on ground

A second filter in the same menu, under the ladder. **Any** · **Under 24h** ·
**Under 3d** · **Under 7d** · **Under 30d**, one at a time — the windows nest,
so "under 24h and under 7d" is just "under 24h".

The status filter alone does not answer the question people bring to this
tool. Houston-Cypress has 763 cars on ground and the oldest has been standing
**four and a half years**; today's arrivals are eighty rows somewhere inside
that, and they are the ones still worth walking out to.

| Window | Listed | Hidden |
|---|---|---|
| Any | 763 | — |
| Under 24h | 80 | 683 |
| Under 3d | 175 | 588 |
| Under 7d | 248 | 515 |
| Under 30d | 339 | 424 |

Measured from `arrivalTimeStamp`, the same span the rows already show as
dwell, so the filter and the number on the row can never disagree.

**Applied by the scan, not by the page.** It could be done client-side off
rows already fetched — the sort toggles are — but then the strip, the export
and the trunk button would each need telling separately what "listed" means,
and three places that can disagree is three places that eventually will. A
rescan is three seconds.

**The window is validated against `DWELL_WINDOWS` in `lib.js`, not just
accepted.** A window the menu never offered — a typo'd `0.5` — would hide
almost the whole lot and read as an empty centre rather than as a bad request.

Cars with **no arrival timestamp are dropped** by any window rather than kept.
"Under 24h" is a claim about the car and an unknown dwell does not support it;
keeping them would put a car that has stood for two years at the top of a list
of this morning's arrivals. A notice gives the count, because that is the one
case where the window is hiding something it could not judge rather than
something it judged.

Under a window the last tile changes from **Over 30d** — which would read 0 by
construction — to **Older**, the count the window is hiding. The backlog is
still the story of the lot even when it is deliberately off the screen. The
window also goes in the subtitle and the export filename, for the reason the
view already does: a screen showing 3 rows when the centre has 400 pending has
to say why, or it reads as a broken scan.

An empty result under a window says *Nothing that recent* rather than *No cars
in that status*. The two want opposite next moves — widen the window, or widen
the status — and one message would send half the readers the wrong way.

### Export

Same rules as the other tool: exactly what is on screen, no re-scan, status in
the filename.

```
compiler-cars-on-ground-<site>-<statuses|all-statuses>[-under24h]-<yyyy-mm-dd>.xlsx
```

Same two presets as the other tool — **All data** or **VIN + delivery date**,
where the date is Intrepid's `scheduledDeliveryDate` rather than the index's.

Twenty columns. Dwell goes out **twice** — a readable `1508d` to look at, and
the same span as a number in both hours and days, so a column can be sorted,
filtered above a threshold or averaged without anyone parsing a duration back
out of a string.

### Open all trunks

The list on screen can be made to raise its hands. **Open all trunks** wakes
every car listed and pops its liftgate, because an open trunk is visible from
the end of a row and a VIN on a screen is not. It respects the status filter —
"that list" means the rows you are looking at, not the whole centre.

This is the only control on the board that changes something in the world
rather than reading it, so it asks first, with the count in the question:
*open 176 trunks*, never *open all trunks*. It is one chip away from the sort
toggles, which do nothing at all.

**Both steps are per-vehicle, and the batch call is a trap.** Garage has
`POST /api/1/vehicles/batch_wake_up` taking `{vehicle_ids:[…]}` — its own
advanced-search page uses it to poke up to 5,000 cars in one call. It answers
**403 `you may not access this feature`** for a service-centre role, because
it belongs to the batch tooling rather than to the vehicle page. Don't swap it
back in to save calls; it fails only once a run is already underway.

| Call | |
|---|---|
| `POST /api/1/vehicles/<id>/wake_up?device_type=vehicle` | the Poke button · `{"response":"ok"}` |
| `POST /api/1/vehicles/<id>/open_trunk?device_type=vehicle` | no body · the id is Garage's 16-digit device id |

There is **no `close_trunk`** anywhere in Garage's bundle, and no
`actuate_trunk` either — `open_trunk` is the whole vocabulary. The liftgate
commands sit beside `flash_lights`, `honk_horn` and `locate_ping`, which are
the other three ways to make a car identify itself.

#### Writes need a CSRF token, and it is not in the cookie

Reads need only the session cookie. Garage is Rails, so every POST is checked
against the per-session token its pages carry in `<meta name="csrf-token">`.
It is scraped from `/vehicles` with the same session — **one extra GET per
run, not per car** — and cached. A 422 buys exactly one retry with a fresh
token, because a token can age out mid-run and Rails answers that
indistinguishably from a real refusal.

`device_type=vehicle` rides in the **query string on every call** and is also
injected into the body whenever there is one. Both were copied out of Garage's
own service class rather than guessed.

#### Rounds, not a sleep

Cars on Ground is an Intrepid tool and holds only VINs, so the ids are looked
up off tesladex first, 150 VINs to a query. `vpn_state` comes back free in the
same query and says who is already awake.

A poked car answers somewhere between a few seconds and a minute, and some
never do. Rather than sleep for the worst case and fire everything at the end,
each round opens what it can and only the refusals go round again — at 0s,
20s, 45s and 90s, re-poking the outstanding cars before each retry. The online
ones pop within a second of the click, which is the difference between a tool
you stand and wait for and one you walk behind.

Whatever is still shut at the end is listed in the result window, grouped by
what Garage said rather than one line per car: two hundred rows all reading
*vehicle is offline* hide the one that says something else, and that one is
the only interesting line on the screen. VINs the index has never heard of are
reported separately — two of them is noise, two hundred means the session is
reading a different environment and the run was meaningless.

---

## Pending Inventory

Pick a centre and press **Pending Inventory**. There is no modal: the bucket is
the bucket and the centre is already chosen, so a dialog would be a click spent
on nothing.

> The tool was called **Expenable** until 2026-08-16 and the code still says
> `exp` — `expScan`, `/api/exp/scan`, `S.expFilters`, `expBtn`. The name
> changed; renaming forty identifiers across three files to match a label did
> not seem worth the churn, so this note is here instead.

It answers one question — **which cars are matched to a customer and have no
delivery appointment booked** — and it answers it as a wheel of cards with the
car rendered on each one. Cypress runs about 55 cars in ten seconds.

Four systems, each the only one that can say its part:

| | |
|---|---|
| **Tesla OS** | that an order exists, which VIN it is matched to, and when |
| **Garage** | what that car actually is — paint, wheels, interior, seats, roof, tow |
| **Intrepid** | whether it has turned up, and whether it has a service visit |
| **Service App** | what that visit is for, if there is one |

Most of it is free: OS returns the bucket 25 rows at a time, Garage answers
every VIN 50 to a query, and the on-ground inventory is one call for the whole
centre. The one per-vehicle cost is the service-visit check — the same call
Service Visits makes, once per VIN — and the SCA and VRI lookups behind it run
only on the handful of cars that come back with a visit. Cypress: 54 cars, 8
with a visit, about eight seconds.

### The picture is the point

A row reading *Quicksilver, Glider 18, Black Console 2* is three lookups for
anyone who then has to walk out and find the car. The rendered car is
recognised at a glance, so the list is cards and the words sit underneath the
picture rather than replacing it.

The card is portrait with the picture at the top — the shape a trading card
is, for the same reason — then year and model, then the VIN, with the RN in
the bottom corner. The **spec sits in a panel beside the focused card** rather
than inside it, so the picture keeps the card and the words get room to be
read straight.

### The wheel

Cards are stacked vertically: one in focus, its neighbours cut off above and
below, and the whole thing turns when you scroll it. Arrow keys work, the two
buttons under the spec work, and clicking a half-visible neighbour brings it
into focus.

### The SV bubble opens the Service Visits editor — the actual one

A card whose car has a service visit carries an **SV** bubble beside the
days-waiting badge. Pressing it opens the ticket panel: move the visit to
another centre, its photos, its contacts, the billing address — the whole
thing.

**It is not a second copy of that panel, and that is the requirement rather
than an implementation detail.** The bubble calls `openTicket(r)`, which is
the same function the Service Visits list calls on a row click, which calls
the same `editPanelHtml()` and `wireEditPanel()`. Whatever that editor grows
next — another write, another guard, another line of detail — the bubble has
it the same day.

For that to work the two rows have to be the same shape, and they are because
the server makes them so:

- `expScan` builds `visits[]` with the same fields, from the same
  `getScaServiceVisitByVin` call, as the Service Visits scan does.
- Both then run those rows through **`enrichVisits()`**, lifted out of
  `scanVehicles` whole. That is the subtle part — matching SCA's ticket to
  Intrepid's visit by printed number, dropping visits SCA has already closed,
  attaching the receiving inspection — and there is exactly one of it. Two
  copies would drift, and the second panel would become a lie about the first.
- The row also carries `delivered`, read from Garage with the spec, because
  that is what decides whether the panel offers to cancel an appointment as
  part of a move. The server re-reads it before writing either way.

Only the focused card's bubble is live; on a card half off the screen it is
inert, like the RN link next to it.

#### The position is a number, not an index

The first version moved a card per wheel event with a cooldown to stop a
trackpad flying through the lot. It stepped, and you could feel every notch
land — *"not smooth like I'm imagining"*, which was fair.

So the deck has a **position**, `deckPos`, a float in card units. The scroll
adds a *distance* to a target, an animation loop eases the position toward it
at 17% of the remaining gap per frame, and each frame writes the transform of
the cards near it. Halfway between two cards is now a real state: both are
half-sized and half-faded, passing each other. When the scrolling stops, the
target rounds to the nearest card, so it always comes to rest **on** one.

Four things this depends on:

- **The scroll adds to the TARGET, not to the current position.** A flick
  arrives as thirty events in a quarter-second and the eased position is
  always behind them; adding each event to the lagging position throws most of
  the gesture away. Measured that way round first — a hard flick moved one
  card instead of three.
- **`deltaMode` is normalised.** Firefox reports lines and pages where Chrome
  reports pixels, and a line is not three pixels.
- **The markup is built once per list, never per frame.** Every card exists as
  a box, but only the nine nearest are `display:` anything, and each card's
  image sits in `data-src` until the wheel brings it near. Rebuilding markup at
  60fps is what made the first version feel like it was chewing. One image size
  for every card, too: swapping an `<img>` src as a card comes into focus
  reloads it, and a card that flickers on arrival is worse than one rendered
  at 500px for a slot 360 wide.
- **The wheel only takes the scroll once it is in view, and hands it back at
  the ends.** The deck starts below the fold, and a wheel that swallowed the
  scroll on its way past would trap the page. Scrolling down on the last card
  carries on to the footer rather than sitting there refusing. A finished scan
  scrolls the deck into view by itself.

#### It turns on an arc, and the axis is off to the left

A card leaving the centre does not slide straight up or down — it **swings
left as it goes**, above and below alike, because a wheel turns about an axis
and this one's is off to the left of the column. That is what the reference
sketch showed, and it is the whole difference between a wheel and a list that
slides.

The horizontal offset is the sagitta of that turn, `R(1 − cos θ)`: nearly
nothing for the first few degrees and then opening up, which is how a circle
actually reads. It is capped at 190px, because the column is only so wide and
a card that swings out of it is clipped rather than turned — which is also why
the card column is 540px for a 360px card, and why the cards are anchored to
its **right** edge. The focused card sits next to the spec panel it belongs
to, and everything to its left is room to turn into.

Three numbers set the feel, all at the top of the deck section in
`index.html`:

| | |
|---|---|
| `DECK_STEP` 455 | centre to centre. A card is ~410 tall, so this leaves ~55px of air between one and the next. Tuned from both ends: at 420 they nearly touched and read as clutter, at 500 they were too far apart to read as one wheel |
| `DECK_ARC` 1000 / `DECK_ANG` 0.45 | the swing: ~100px left at one card of distance, capped at 190 |
| `.wheel` 1000px | the height. With the step above, most of each neighbour shows and the card beyond it stays off screen |

The step and the height are read together — the step alone decides the gap,
and the two of them decide how much of a neighbour you see. The neighbours
only shrink 5.5% and fade 26% per card of distance, so they stay big enough to
read the model off: a stack you can only see one and a half cards of is a card
with a smudge above it.

The card shows the tow hitch only when there is one — a card line that says
"none" is spent saying nothing — but the **panel names every field even when
it is empty**, because in eight labelled rows a silently absent one reads as a
car that has no roof. There the value says *not on record*.

The renderer is Tesla's own configurator compositor, and it takes **no
credential at all** — a plain `<img src>`, unlike the SCA photos, which have to
be proxied so the bearer never reaches the page. The recipe is copied from OS's
own `CompositorImage` component: `STUD_3QTR` (`_V2` for S and X), and a
different crop for Cybertruck.

**Feed it the marketing codes, not Garage's.** `cfg_mkt_option_codes` off the
OS row is the short `$`-prefixed list. Garage's 50-code *manufacturing*
`option_codes` renders the car and leaves **black voids where the wheels should
be** — a real dead end, not a compositor bug.

### Trim: the code is shown beside the name, on purpose

Ed asked for trim as Standard / Premium. **Neither system says that.** Garage's
`cfg_trim` is the battery/variant code (`74`, `62D`, `P74D`) and OS renders
`ord_trim_code` raw — its own bundle has no label map either, so the pipeline
screen shows a code too.

What every OS row carries is exactly one `MT…` marketing code, and
cross-tabulating those against Garage over a real centre split cleanly:

| | | | | | |
|---|---|---|---|---|---|
| `MT367` | Model 3 | 62 RWD | `MTY77` | Model Y | 62D AWD |
| `MT369` | Model 3 | 74 RWD | `MTY60` | Model Y | 74 RWD |
| `MT370` | Model 3 | 74D AWD | `MTY48` | Model Y | 74D AWD |
| | | | `MTY70` | Model Y | P74D AWD |
| `MTC04` / `MTC07` / `MTC08` | Cybertruck | AWD | | | |

The grouping is measured. The **names** are read off Tesla's current lineup —
62 is the Standard pack, 74 the Premium one, a leading P is Performance — and
that is the only inference in the tool. So the card shows the code beside the
name: a wrong label is then obvious to anyone who sells these, instead of being
a quiet fiction. An unknown code shows as itself rather than being guessed at
from the number.

### Reading a card

The **RN opens the order in Tesla OS** (`os.tesla.com/vehicle-order/<RN>/`) and
the VIN beside it opens the car in Garage, so a card opens both halves of what
it is made of.

The badge in the corner of the picture is **days since the car was matched**,
and the border warms at 7 days and reddens at 14. The counter under the spec
says which card of how many is in focus. That is a reading aid, not a
policy — nobody has said what counts as too long — and it is the same job dwell
does on a car on ground. Cards are sorted longest-waiting first; a car with no
match date sorts last, because an unknown wait cannot claim to be the longest.

The age is **derived on the page from the timestamp**. OS also sends
`time_since_matched`, in minutes, as a string, fixed at the moment the row was
fetched — a tab left open would keep reporting the age it had on load.

**A VIN Garage has never heard of is a car that has not been built yet** — the
order exists and the VIN is assigned, but nothing has come down the line to be
indexed. Its panel says exactly that, in one sentence, and it keeps its
picture: the order and the option codes are OS's, so the render still works. A
column of blank spec lines would read as a car without a colour, which is a
different and wrong thing. The count gets its own tile and a notice.

The board says *not built* rather than *not in Garage's index* everywhere it
comes up — on the card, in the notice, in the filter panel, and in the export
column. `inGarage` is still the test; it is just not what the reader is asking
about. One describes a database, the other describes the car.

### Filters and sort

**Filters** in the list head opens a panel of every facet the cards carry —
waiting, model, year, trim, motor, paint, wheels, interior, seats, roof, tow
hitch, and whether Garage has the car at all. Multi-select within a group (two
colours means either will do), AND across groups. **Sort** beside it offers
longest waiting, newest matched, soonest ETA, and by model.

**None of it is part of the scan, and it could not be.** The bucket is the
bucket: Tesla OS decides what is in it and there is no narrower one to ask
for, so a rescan would return the same cars and spend ten seconds doing it.
Same argument as the ticket-concern filter on Service Visits, and the same
door — `visibleRows()`, which the count, the subtitle and the export all read,
so the three cannot disagree about what is listed. On the other two tools a
facet narrows the Lucene query and makes the scan genuinely cheaper, which is
why they work the other way round. Neither is a house style; each follows from
whether the filter can save any work.

The counts beside each option are measured **against the other groups**, so
the number next to *Pearl White* is what you would have if you added it to
everything already picked. Options that would reach nothing are dropped rather
than shown at zero, and a group whose single option covers every card left —
every centre is all one model year — is dropped entirely rather than offered
as a button that does nothing.

Two consequences worth knowing:

- **A car that has not been built vanishes the moment you pick a colour.** It
  has no colour yet, so it cannot match one. The panel says so above the
  groups, with the count.
- **A window is "7 days or more", not "under"** — the opposite of Cars on
  Ground, because the question is the opposite. A car with no match date is
  dropped by a window rather than kept, the same call the time-on-ground
  filter makes about a missing arrival.

Filters clear on every scan; the sort order survives one. A colour picked at
one centre is a claim about a fleet the next scan may not contain, whereas an
order is a habit about how you read a list. What is applied is named in the
subtitle and counted on the chip, and it lands in the export filename, because
a sheet of 6 cards and a sheet of 55 are otherwise the same file with
different contents.

### Four ways this API says "nothing here" when it means "you asked wrongly"

All four were found by probing, and every one of them is **HTTP 200** with an
empty page and no error:

1. **`recordsPerPage: 100` returns zero rows.** 25 works, and 25 is what the
   pipeline itself asks for. This is not a tuning knob.
2. **`currentPage` is 1-based.** `0` is another silent empty.
3. **The TRT must be a string.** `["17589"]` works; `[17589]` returns nothing.
4. **The `order-range` sub-tab is dead** — `Missing required parameter:
   endPoint`. `pending-actions` is the live one, and for this bucket
   `bucket-totals` reports both as the same number.

The one signal that separates a wrong question from a quiet centre is
`dependentOnFilters`: a response that accepted the filter echoes the bucket's
filter names back, and one that ignored it echoes `[]`. A zero-row page with an
empty echo is **thrown, not rendered** — see `assertFiltered()` in `os.js`.

The bucket is found by **name**, not by a pinned id, because buckets are
configured per site — Cypress's list carries a Lease Return bucket another
centre will not have. A missing bucket throws too: "not published to this role"
and "nothing in it" render identically and mean opposite things.

### Keep-alive had to be turned off

Node has kept sockets alive by default since v19, and the OS BFF closes an idle
connection sooner than Node forgets about it. A scan, then a second scan
straight after it, died with `socket hang up` before a byte was sent; a third
fifteen seconds later was fine, because by then Node had dialled fresh. `os.js`
uses its own agent with `keepAlive: false`, and retries once — and only once,
and only on a connection that never carried a reply. Everything it sends is a
search, so a re-send cannot double anything up.

### Export

**All data** is 18 columns: the order, the ids, the whole spec, the match date
and *Days since matched* as a **number** beside it, so a column can be sorted
or averaged without anyone parsing "3 days". **VIN + RN** is the two ids, for
pasting somewhere that is not a spreadsheet — the same job *VIN + delivery
date* does on the other two tools, which this bucket cannot offer, because not
having been given a date is what put a car in it.

---

## Credentials

| | |
|---|---|
| Admin password | `226565` — six-digit gate, same as the other boards. House default; override with `.admin.json` |
| Garage | `…_s_garage_session` cookie, signed in on the Hub |
| Intrepid | `cogs-authorization` cookie, signed in on the Hub |
| Service App | 9-hour bearer token, signed in **here**, in `.connections.json` |
| Tesla OS | `osAccessToken`, signed in **here**, resent as a header — see below |

All of it lands in one gitignored file. The admin password is a guard against
fat fingers rather than an attacker, but it is checked server-side all the
same, because a client-only gate is no gate at all.

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

Both cookies are required and there is no degraded mode for them. A scan
missing half its sources would answer the question wrongly instead of
refusing, which is the worse failure.

### The Service App signs in here, and it is not a cookie

The one credential this board does not read from the Hub. Two reasons, and
both are about SCA rather than about the Hub:

- **Nothing else uses it.** A Hub row for SCA would be a sign-in exactly one
  board could ever consume, sitting beside two that all of them do. Keeping it
  here also leaves `credstore.js` alone — that file is copied into every board,
  so a key added for one consumer is five edits.
- **It is a bearer token, not a session cookie.** SCA mints a JWT at
  `/integration/api/authentication/code/gettoken` and parks it in
  `localStorage.SecureToken`. `Storage.getCookies` — the whole of the Hub's
  capture — cannot see localStorage. The grab here attaches to the *page*
  target and evaluates inside it instead.

Everything else about the sign-in is the Hub's arrangement for the Hub's
reasons: the same isolated debug profile, the same directory, so a machine
already signed in for Garage or Intrepid usually connects SCA with no window
appearing at all. **Admin › Sources › Connect**, or the prompt on the board
when it opens.

**A decoded token is proof, where a cookie needed a probe.** The Hub probes
every cookie it captures, because Garage hands anonymous visitors a
`_garage_session` too — a cookie that exists is not a session that works. A
bearer JWT cannot be minted without a completed SSO round trip, and it states
its own expiry, audience and roles. So there is no probe here, and the panel
can show "9h left" where the cookies can only show "saved".

The token lasts about nine hours, which is a working day, and the board treats
anything under five minutes remaining as already gone rather than starting a
scan that will die halfway through.

**Not read-only, and every write is named.** The token carries
`SCA_All_Default_Create` and `SCA_PartPick`. The board makes exactly these
calls that change a record, and nothing else:

| | |
|---|---|
| move a visit to another centre | `PUT visit/<svid>/dateTime` |
| clear a booking | TSS `CancelAppointment`, then the same dateTime PUT |
| switch a contact to Tesla, set the billing address | `saveContact` / `saveaddress` |
| take a courtesy line off a visit | `POST visit/<svid>/removeactivities` |
| change a concern's symptom | `PUT case/activities/update/<id>` |

Every one of them was captured off SCA's own UI rather than inferred, checks
`success` rather than the status code, and re-reads the record afterwards.
**`cancelActivity` is not among them and never will be** — it closes the
ticket and disturbs billing. Neither is `cancelServiceVisits`, which is
deleted from this board rather than merely unused, because it answers
`success:true` while cancelling both the visit and its open tickets.

### Tesla OS is a cookie you have to resend as a header

The second board-local credential, for the same reason as the first: nothing
else in the estate speaks to `os.tesla.com`, so a Hub row for it would serve
exactly one board.

Entra SSO leaves two cookies on the host, `osAccessToken` and `expiresIn`.
**The cookie alone is not enough.** A same-origin `fetch` from inside the
signed-in page, with `credentials:'include'`, still gets `401 Authentication
failed`. The app's own axios factory resends the cookie *value* as a header,
and that is what the BFF actually reads:

```
X-Os-Access-Token: <osAccessToken>
X-Requested-With : XMLHttpRequest
Accept-Language  : en
```

The good consequence is that **no browser is needed at runtime** — with those
headers the BFF answers plain Node over https, so the board holds a token
rather than driving a page.

Unlike SCA's, this token is **opaque**: it does not state its own expiry, so
"there is a token" and "there is a session" are different questions. The panel
answers the second one by asking `GET /v1/auth/check`, the cheapest
authenticated call the pipeline has, cached a minute so polling is free. The
load-bearing guard is neither of those, though — `os.js` turns a 401 into
`needsOs`, so a session that dies mid-scan surfaces as *connect it again*
rather than as a centre with nothing matched.

That guard was worth having twice. `expScan()` used to swallow the error from
its first call and report a live centre as an **unknown TRT** — the wrong
message *and* the wrong fix, sending the reader to the picker to repair a
sign-in. Only an answer of "no such site" means that now; errors propagate.

**Read-only.** Three POSTs and a GET, all searches. The pipeline has write
paths — reassign, reschedule, bulk actions — and they are deliberately not
mapped.

---

## Layout

```
config.json     port, hosts, concurrency, the shipped admin password
lib.js          everything that talks to Garage or Intrepid, plus the facets
sca.js          the Service App: its sign-in, and the two calls that read a ticket
os.js           Tesla OS: its sign-in, and the delivery-pipeline bucket
server.js       thin HTTP layer; no tool logic lives here
index.html      the board — ZO-1, one file, no build
```

`sca.js` and `os.js` are self-contained and store nothing: each hands a
captured token to `lib.js`, which stays the only writer of
`.connections.json`. Deleting `sca.js` would cost the board its ticket column;
deleting `os.js` would cost it Pending Inventory. Neither would break anything else.

They are siblings rather than one shared module, and that is the same trade
`credstore.js` and `xlsx.js` already make on this estate: two is not a
pattern, and the two differ in the one place that matters — SCA's credential
states its own expiry and this one has to be asked.

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

Put a button in `.tools` in the hero, a modal for its options if it has any,
and a route in `server.js` that calls into `lib.js`. The nav, TRT picker,
admin panel, progress bar, notices and every connection are already there and
are not specific to any existing tool.

What Cars on Ground had to touch, and Pending Inventory touched again: `S.tool`
decides which renderer the list uses, `paintStats()` writes the strip rather
than filling in fixed tiles, and `/api/export` branches on `kind`. Tools
sharing one hardcoded strip would leave whichever ran last staring at tiles
that count another one's question.

Pending Inventory added one thing to that list and nothing else: the `.list` element
gets a `cards` class and holds a wheel instead of a column of rows. The head,
the empty state, the export and the count are all one implementation still —
a second list would have been three more places for the screen and the sheet
to disagree. `S.expIndex` is an index into the rows *currently listed*, not a
VIN: the list it indexes is rebuilt by every filter and sort, so the position
is clamped rather than followed.

A tool with no options needs no modal. Pending Inventory's hero button *is* its run
button, spinner and all.

One trap, twice now: a class rule setting `display` beats the browser's own
`[hidden]` rule, so anything hidden by attribute needs a `[hidden]` rule of
its own in the CSS — see `.list-head` and `.chip`.

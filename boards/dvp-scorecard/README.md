# DVP Scorecard

Credits each delivery **cleanliness score** to whoever put that car into
**Finished Goods** — the prep/detail step — and ranks the prep team, cleanest to
dirtiest. The survey asks the customer about cleanliness; the person who finished
the car is the one accountable for it.

Same house style (ZO-1), same admin code, same Connect-to-Intrepid flow as the
FSD Tracker. **Intrepid only** — no Garage, no Tableau.

## Run

```
node server.js          # or double-click "Start DVP Scorecard.cmd"
```

Opens `http://localhost:3130`. No dependencies, no build. Node 18+.

## Use

1. Sign in to Intrepid on the **Zo Projects Hub** (`http://localhost:3100`) — once,
   for every board. Admin here only reports what it is reading.
2. Set your **delivery centre (TRT)** — top-right, remembered.
3. **Drag a survey export (.xlsx) onto the page.**

Only two columns are read from the file: the **Reference Number** and the
**score** (the 20–100% metric). A Delivered Date column, if present, is used to
know which centre-days to look up. Columns are auto-detected by header, with a
value-pattern fallback.

## How it works

The score is the only thing that comes from the upload. Everything else is
Intrepid:

1. Collect the delivery dates named in the file.
2. `getTssAppointmentsByDate` for each → every RN → VIN + shipment id.
3. Join the upload's RNs to those appointments → pair **VIN ↔ score**.
4. `getVehicleStatusLogByVinWithPdiTask` per VIN → the `vehicleStatusLogs`
   entry where `vehicleCogStatusName === "Finished Goods"` → **`createdBy`** =
   the prep person. (Not `cogInfo.updatedBy`, which is only the last toucher.)
5. Attribute every score to its prep person → leaderboard.

Validated against a real QTD-Cypress export: 220/220 cars attributed in ~10s.

## The leaderboard

One row per prep person: cars finished, **mean cleanliness %** (a single-hue
meter — magnitude, not a red/green judgement), and how many fell below 100%.
Cleanest at the top, dirtiest at the bottom. A **3-car floor** to be ranked for
the top/bottom spots — one lucky car should not top the board — everyone is
still listed. Click a person to see their individual cars (VIN, RN, score).

## Inspection (VRI) metrics

Two counts per person, from the same status log the rest of the board uses:
**VRIs completed** and **faults caught at VRI** — cars that did not pass, shown
with the catch rate beside the count. A catch is a **credit**: damage found on
arrival is the inspection working. It is deliberately kept out of the
Productivity total, because the inspection is already counted there as a VRI.

Intrepid has no "inspection failed" status. A failure is detected from its side
effect — the car goes straight into service, so the log gets a
`Receiving Inspection Completed` and an `In Service` entry sharing a
`createdDate` to the second:

```
id=16247950  statusId=9  svcVisit=-         2026-08-10T18:58:05Z  Receiving Inspection Completed
id=16247951  statusId=5  svcVisit=47682012  2026-08-10T18:58:05Z  In Service
```

**Do not replace this with `vriPassedDate`.** It looks like the direct answer
and it is not: the field is stamped at *Ready for Prep*, downstream of the
inspection, so a car that fails, gets repaired and moves on has it populated and
the failure vanishes. Over a 21-day window at Cypress the log test found 8
failures among 726 delivered cars and `vriPassedDate` would have found **none**
of them. It is carried through as a cross-check and disagreements surface as a
notice. `check-vri-signal.js` re-runs the whole comparison against any centre.

### Tickets post-VRI

The mirror of a catch: cars the inspector **passed** that went to service anyway
**before they were delivered**. Shown as a percentage of the cars that person
inspected, with the VINs behind it. Delivery is the cutoff — a visit opened
after handover is the customer's and says nothing about the inspection.

Cars that failed the VRI are excluded: the fault was caught, not missed, and it
is already counted as a catch. Over 726 delivered cars at Cypress no car fell in
both groups, so the two metrics never contradict each other.

**Read the rate as a prompt, not a verdict.** The gap between inspection and
ticket ran from the same day to **258 days** in that window — a car that stood
on the lot for eight months can pick up a fault nobody could have seen at
receiving. The per-VIN list shows each gap so a same-day find is visibly
different from a long one. `check-post-vri.js` reproduces the distribution.

Counted on the **In Service transition**, not on the presence of a service-visit
id: 12 of the 47 had no id attached. Both are shown — the id appears beside the
date when Intrepid recorded one.

## Credentials & privacy

- The Intrepid cookie lives in `.connections.json` (gitignored), fetched by
  Connect — see the FSD Tracker's notes on the isolated Chrome debug profile.
- **No customer PII** leaves the server: the per-car payload is RN, VIN, score,
  and the prep person's username only. Names, emails, verbatims are never sent
  to the page.
- The prep person shows as their **full name** (`Colton Rieder`), resolved from
  the username Intrepid records. See below for where that comes from. The
  username is still the identity, still in the export, and still the tooltip on
  every name — only the label changed.

## Full names, and why this board does not call Garage

Intrepid names people by AD username, so the board used to read `crieder` where
it meant Colton Rieder. Garage's `lookup_user` is the only thing that closes
that gap, and **this board deliberately does not call it.**

The reason is in `credstore.js` and it is not a style preference. The Hub mints
the Garage MCP token and never refreshes it; exactly **one** board consumes and
rotates it — ZO-002, the FSD Tracker. A second MCP consumer would recreate a bug
this estate has already had, where two clients shared a refresh token and
whichever refreshed first invalidated the other. Copying the OAuth client in
here would have been the obvious move and the wrong one.

So ZO-002 offers the one call with no cookie equivalent over plain HTTP:

```
GET http://127.0.0.1:3120/api/staff?users=crieder,lcolman
    → { "names": { "crieder": "Colton Rieder", "lcolman": "Leonardo Colman" } }
```

This board asks once per compile for the whole roster, caches the answers in
`.staff-cache.json` (gitignored — real employee names), and never asks about the
same person twice. A username Garage does not know is remembered as a miss, so
it does not cost a lookup on every compile.

**It degrades in one direction only.** No ZO-002, no answer, no name — and the
board shows the username, which is exactly what it showed before. Names are
decoration over a key that already worked, so nothing is ranked, grouped or
joined on them. A compile that could not reach the service says so in the
notices rather than quietly implying usernames were the best available.

Set `nameService` to `""` in `config.json` to switch the lookup off entirely.

## Files

| File | Role |
|---|---|
| `server.js` | routes: upload/compile, admin, export, progress |
| `lib.js` | Intrepid layer + the compile pipeline + leaderboard |
| `xlsx-read.js` | dependency-free xlsx reader (zip + inflate + column autodetect) |
| `xlsx.js` | xlsx writer (the export) |
| `intrepid-connect.js` | one-click Intrepid cookie capture via a debug browser |
| `index.html` | the ZO-1 dashboard |
| `package-portable.js` | bundles Node into a send-anywhere zip |

## Notes

- Windows x64 for the portable build (bundled `node.exe`).
- A real Excel file is deflated; the reader handles both deflated and stored
  entries, self-closing empty cells, inline strings and shared strings.

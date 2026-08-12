# DVP Scorecard

Joining delivery **CSAT / survey data** (Tableau BI) with **Intrepid delivery
ops** into one scorecard. Started 2026-08-02 after pausing the FSD Tracker.

## The idea

Every delivery has a **Reference Number (RN)**. That single key ties together
three systems we already know how to read:

| Source | Keyed on | Gives |
|---|---|---|
| Tableau BI (AdvisorCSAT-Delivery) | RN | CSAT per metric, Vehicle Cleanliness score, dissatisfaction topics, verbatims |
| Intrepid | RN | delivery host, advisor, customer, appointment status, dates, TRT |
| Garage vitals (FSD Tracker) | RN → VIN | post-delivery FSD miles |

So a scorecard row = **who delivered it × how the customer rated it × what they
drove**, all joined on RN.

## Data already pulled (`data/`)

- `csat-cypress-qtd.json` — 220 QTD-Cypress survey responses. Columns:
  SurveyEndDate, Delivered Date, Reference Number, Model, dissatisfaction
  topics, Additional Info Needed, How to Improve Communication, Why Not Trade
  in, Additional Feedback, and the per-RN metric score (this pull = **Vehicle
  Cleanliness**: 208×100% / 9×80% / 2×60% / 1×40%, mean 98.5%).
- `csat-verbatims.json` — same responses, full verbatim text.

⚠️ Both hold customer names + free-text — PII. Local only. No git remote.

## How each source is reached (recipes)

- **BI:** cookie **+ `X-XSRF-TOKEN` header**; set metric via
  `set-parameter-value-from-index` (`idx`, not `index`); export via
  `export-crosstab-to-excel-server` (`sheetdocId` is a `{GUID}`) → download temp
  file by `resultKey`. Sessions are short-lived — grab a fresh id from the live
  browser.
- **Intrepid:** `cogs-authorization` cookie; `getTssAppointmentsByDate` for the
  RN list; `getDeliveryAppointmentDetails?rn=` for host/advisor. Host =
  `DriverADUserName`; customer via `userId` → Garage `lookup_user`.

## CONFIRMED data model (2026-08-02)

Tableau is **scrapped** — its request URL changes as data updates and differs
per centre. Instead the user uploads an **xlsx** (easy to request their end).
From the xlsx we need only **Reference Number**, the **metric score (20–100%)**,
and **Delivery Date**.

Pipeline (all Intrepid except score, which is the xlsx):
1. xlsx → RN, score, delivery date(s)
2. `getTssAppointmentsByDate?trtId=<trt>&date=<d>` for each date → rows with
   `vin`, `referenceNumber`, `cogInfo.id` (shipmentId)
3. match appointment RN → xlsx RN → pair **VIN ↔ score**
4. `getVehicleStatusLogByVinWithPdiTask?vin=<vin>&vehicleShipmentId=<cogInfo.id>`
   → `vehicleStatusLogs[]`; take the entry where
   `vehicleCogStatusName === "Finished Goods"` → **`createdBy`** = the prep
   person who owns that cleanliness score. (NOT cogInfo.updatedBy = last
   toucher.) Verified: VIN 7SAYGDED3TA748894 → crieder@tesla.com.
5. attribute each score to its Finished-Goods setter → **leaderboard**, cleanest
   → dirtiest, by that person's cars.

Name: `createdBy` is an email (crieder@tesla.com) → Garage `lookup_user` for a
display name, same as [[fsd-tracker]] did for hosts/customers.

## Open questions before building

1. Scope — per **host**, per **advisor**, or per **delivery**? (Host owns the
   handoff; they differ from advisor ~1/3 of the time.)
2. Which CSAT metrics on the card, or all of them?
3. Time window / centre — QTD Cypress like the sample, or configurable?
4. Live tool (like FSD Tracker dashboard) or one-shot report?

## Status

Scaffolding only. Nothing built yet — waiting on the direction above.

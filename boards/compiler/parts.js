/* Parts — the Service App calls that bill a part onto an undelivered car.

   Every endpoint in this file was captured off Ed's own clicks on 2026-08-26
   (7SAYGDED4TA761850 → visit 48190829) and none of it was guessed. The wire is
   kept outside the board in ~/parts-probe: FLOW.md is the write-up,
   RUN-keycard-48190829.jsonl + bodies-keycard/ are the run itself, and
   `node report.js <n>` reads any single call back. That matters because the
   board's standing rule for SCA is **capture it, never infer it** — the last
   time it was skipped, two guesses in a row were wrong and one of them closed
   a live ticket.

   ── this file has no policy in it ──

   One function per endpoint, each doing exactly what the app does and nothing
   more. The gates, the ordering and the read-backs live in lib.js, next to
   scaSwitchContactToTesla, for the same reason sca.js splits that way: the
   rules about which cars may be written to are not facts about SCA's API, and
   burying them here would mean a caller could reach an endpoint without them.

   ── never trust a 200 ──

   SCA answers 200 while refusing. Three of the writes in the capture did
   exactly that — the estimated-completion-time before Prepared, a technician
   against a removed correction, an update to an activity that had just been
   removed. All three returned HTTP 200 with `success:false` in the envelope.
   So `req()` below resolves rather than throws on a non-200, every wrapper
   returns the envelope, and `ok()` is the only thing allowed to call a write
   successful. Reading the record back afterwards is lib.js's job on top. */

"use strict";

const https = require("https");

/* ── this flow spans THREE hosts, and the routing is by path ──

   Not a detail. Everything the rest of this board has ever spoken to lives on
   serviceapp.tesla.com, so the first cut of this file sent all of it there and
   every parts call came back **404** — which reads exactly like a wrong path
   and is not. The Parts service is its own deployment:

     serviceapp.tesla.com              /case /integration /appointment
                                       /activity /invoice /notification /document
     service-center-app-parts.tesla.com   every BARE /api/… path
     servicecenterapp.tesla.com           /audit/api

   The bare-`/api/` prefixes on the parts host are: correction,
   activitycorrection, activitycorrectionpart, activitycorrectionpartautomation,
   activitycorrectionowner, partsrecommendation, partallocation, partrequest,
   partautomation, partpickrequest, compatiblepart, serviceai, mrb, voucher.

   The rule below is therefore mechanical: a path whose first segment is `api`
   is the parts host, anything else is the app host. That is exactly how the
   browser splits them, so it cannot drift as endpoints are added.

   Same bearer token on both — one SSO, verified live. */
const HOST       = "serviceapp.tesla.com";
const PARTS_HOST = "service-center-app-parts.tesla.com";

const hostFor = path => (/^\/api\//.test(path) ? PARTS_HOST : HOST);

/* One helper for all three verbs. Resolves with the status and the parsed
   envelope instead of throwing, because a 200 here is not success and a
   non-200 is often the more readable error — see the header. 401 is the one
   exception: a dead token is not a fact about this request, and every caller
   would otherwise have to re-derive that from the envelope. */
function req(token, method, path, body){
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Authorization: "Bearer " + token,
      Accept: "application/json"
    };
    if(payload !== null){
      headers["Content-Type"]  = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const r = https.request({ hostname: hostFor(path), port: 443, path, method, headers }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if(res.statusCode === 401){
          const e = new Error("Service App token expired — connect SCA again");
          e.needsSca = true; return reject(e);
        }
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf.slice(0, 400) });
      });
    });
    r.on("error", err => {
      if(!err.message) err.message = err.code || "connection failed";
      reject(err);
    });
    if(payload !== null) r.write(payload);
    r.end();
  });
}

/* The only definition of a successful write on this board. SCA's envelope is
   {success, message, messageCode, localizedMessage, responseObject}; a call
   that omits `success` entirely (a few lookups do) counts as fine on 200. */
const ok = r => r.status === 200 && (!r.body || r.body.success !== false);

/* What SCA said when it refused, preferring its own words to a status code.
   `message` is the useful one — "The estimated completion time cannot be set
   before the Prepared Motion Status" is worth showing verbatim. */
const why = r =>
  (r.body && (r.body.message || r.body.localizedMessage)) ||
  (r.status !== 200 ? `Service App HTTP ${r.status}` : "the Service App refused it") ;

const unwrap = r => (r.body && Object.prototype.hasOwnProperty.call(r.body, "responseObject")
  ? r.body.responseObject : r.body);

const q = v => encodeURIComponent(String(v));

/* ─────────────────────────── resolving a VIN ───────────────────────────

   Two calls, and they disagree about the model id.

   `search` answers with the account (userID) and enough to describe the car —
   owner name, model name, colour, RN. `profile` answers with `modelCode`.
   Both carry a model id and **they are different id spaces**: search said
   `modelId: 17` for a Model Y whose every downstream call wants **36**.
   Correction search, symptom search, part search, the create body and the
   activity body all mean 36. Take it from profile.modelCode and never from
   search.modelId — the wrong one returns the wrong parts and the wrong
   corrections rather than erroring, which is the worst failure available here.

   `scaLoctionId` is spelled that way by SCA. Send it as spelled. */

async function findByVin(token, vin, scaLocationId){
  const r = await req(token, "POST", "/case/api/customerinformation/search", {
    term: String(vin), customerSearchOption: null, scaLoctionId: Number(scaLocationId)
  });
  if(!ok(r)) throw new Error(`Could not look that VIN up in the Service App — ${why(r)}`);
  const rows = unwrap(r) || [];
  return rows.find(x => String(x.vin || "").toUpperCase() === String(vin).toUpperCase()) || null;
}

async function profileOf(token, userId, vin){
  const r = await req(token, "GET",
    `/case/api/customerinformation/profile?userId=${q(userId)}&vin=${q(vin)}` +
    `&productType=1&refreshCache=false`);
  if(!ok(r)) throw new Error(`Could not read that car's profile — ${why(r)}`);
  return unwrap(r) || null;
}

/* ──────────────────────────── the service visit ────────────────────────

   Created in motion 25 (Preparation) with no appointment and no date. Every
   field below is echoed from the captured create; the ones that look odd are
   SCA's own defaults and are left alone deliberately — `carWash` and `charge`
   true, `notes` a single space, `appointmentDate` a single space,
   `isLocationMismatch` true. The Move Ticket write learnt this the hard way:
   SCA's dialog builds its body from form state and flips fields nobody chose,
   so echoing the shape it actually sends is strictly safer than tidying it. */
async function createVisit(token, { userId, vin, modelCode, site }){
  const r = await req(token, "POST", `/case/api/visit/${q(userId)}/${q(vin)}/create`, {
    locationID: site.locationId, scaLocationID: site.scaLocationId,
    scaLocationTypeID: site.scaLocationTypeId ?? 1, trtid: site.trtId,
    inventoryLocationID: site.inventoryLocationId ?? site.locationId,
    serviceVisitStatusID: 1, serviceVisitMotionStatusID: 25,
    visitTypeID: 1, difficultyLevelID: 3,
    serviceVisitDateTime: null, serviceVisitContact: null, activityIDs: [],
    transportationMethodID: 4, campaigns: [],
    tSSCustomerConfirmation: true, tSSReminder: true, tSSReminderHours: 48,
    serviceVisitEndDateTime: "", scheduleInTSS: false,
    frtSchedulingOverrideSelected: false,
    carWash: true, charge: true, checkInMethod: 1, checkOutMethod: 1,
    appointmentID: null, isMobileHubRepair: null, isDiagnosed: null,
    vehicleType: null, mobileRoutingEnabled: false,
    formattedServiceAddress: null, serviceAddress: null,
    vin: String(vin), userId: Number(userId), startTime: null,
    modelCode: String(modelCode), productType: 1, siteName: "",
    serviceSubRegionId: 0, latitude: 0, longitude: 0, severity: 0,
    notes: " ", siteId: 0, appointmentDate: " ", unitId: 0,
    unitMandated: false, arrivalTimes: [], endDate: "",
    additionalAttributes: null, isLocationMismatch: true
  });
  if(!ok(r)) throw new Error(`The Service App would not open a ticket — ${why(r)}`);
  const o = unwrap(r) || {};
  const svid = o.serviceVisitID ?? o.serviceVisitId ?? null;
  if(!svid) throw new Error("The Service App opened a ticket but did not say which — nothing to work on");
  return { serviceVisitId: Number(svid), caseId: o.caseID ?? null, visit: o };
}

/* The visit as the app reads it back, and the read that tells us what SCA
   added on its own — including the courtesy activity. */
const visitWithUidAndVin = (token, svid) =>
  req(token, "GET", `/case/api/visit/${q(svid)}/withuidandvin`).then(r => {
    if(!ok(r)) throw new Error(`Could not read visit ${svid} back — ${why(r)}`);
    return unwrap(r);
  });

/* The activity wrappers on a visit, in the shape the update PUTs expect.
   `includeParts` matters: the update carries correctionPartDTO, so a body
   built from a parts-less read would blank the parts already on the line. */
async function visitActivities(token, svid, site){
  const r = await req(token, "POST",
    `/activity/api/activity/visit/${q(svid)}/activities` +
    `?scaLocationId=${q(site.scaLocationId)}&locale=en_US&includeParts=true` +
    `&includeChildEquipment=false`, {});
  if(!ok(r)) throw new Error(`Could not read the activities on visit ${svid} — ${why(r)}`);
  const o = unwrap(r) || {};
  return (o.data || o.activities || (Array.isArray(o) ? o : [])) || [];
}

/* ────────────────────────────── the activity ───────────────────────────

   Two calls: mint it, then attach it. `addactivities` takes a bare array of
   ids and the 0 in the path is the case id the app sends for a new one. */
async function createActivity(token, { userId, vin, modelCode, site, narrative }){
  const r = await req(token, "POST", "/case/api/case/activities", {
    serviceVisit: { myTime: 0, isVisitRepeatRepair: false, isArchived: false },
    activityDTO: {
      internalNotes: [], externalNotes: [], attachments: [], approvals: [],
      correctionPartDTO: [],
      narrative: String(narrative || "Missing Part"),
      activityCategoryID: 8, locationID: site.locationId, trtid: site.trtId,
      activityStatusID: 1, activitySourceID: 3, preDiagnoseTypeID: 31,
      carWontDrive: false, failureDate: new Date().toISOString(),
      severityLevelID: 0, isExternal: false,
      scaLocationID: String(site.scaLocationId)
    },
    correctionPartDTO: [], currentCorrectionIndex: 1,
    totalParts: 0, totalSerializedPartsRequired: 0,
    vin: String(vin), modelCode: String(modelCode),
    assetID: -1, userID: String(userId)
  });
  if(!ok(r)) throw new Error(`The Service App would not add the activity — ${why(r)}`);
  const o = unwrap(r) || {};
  if(!o.activityID) throw new Error("The activity was created without an id — nothing to work on");
  return { activityId: o.activityID, activityNumber: o.activityNumber || "",
           concernId: o.concernID ?? null, caseId: o.caseID ?? null };
}

async function attachActivity(token, svid, activityId){
  const r = await req(token, "POST", `/case/api/case/0/visit/${q(svid)}/addactivities`,
                      [Number(activityId)]);
  if(!ok(r)) throw new Error(`The activity would not attach to the ticket — ${why(r)}`);
  return true;
}

/* ─────────────────────────────── symptoms ──────────────────────────────

   The search and the single-symptom GET are already in sca.js and behave the
   same here, so they are not duplicated — lib.js calls sca.symptoms() and
   sca.symptomDetail(). What is here is the write, which differs from the
   Service Visits editor's only in that this one owns the whole wrapper.

   cosmeticIssue and hyperSymptom travel WITH the symptom and are not in the
   search results — only the single-symptom GET has them, and that GET is
   code-then-model. Setting a symptom without them leaves two fields describing
   the previous one. */
async function updateActivity(token, wrapper, { preventOverride = false } = {}){
  const id = wrapper && wrapper.activityDTO && wrapper.activityDTO.activityID;
  if(!id) throw new Error("Refusing to update an activity with no id in the body");
  const r = await req(token, "PUT",
    `/case/api/case/activities/update/${q(id)}?preventOverride=${preventOverride}`, wrapper);
  return { ok: ok(r), why: ok(r) ? "" : why(r), res: r };
}

/* ──────────────────────────── correction codes ─────────────────────────

   `activitySource: 3` matches what the app sends from this screen. The search
   is per model and per VIN, so the codes offered are the ones legal on this
   car — "Key card" returned two for a Model Y. */
async function correctionSearch(token, { term, modelCode, vin }){
  const r = await req(token, "POST", "/api/correction/correctioncode/search", {
    modelCode: String(modelCode), searchTerm: String(term || ""),
    localeId: "en-US", countryCode: "US", vin: String(vin), activitySource: 3
  });
  if(!ok(r)) throw new Error(`Correction code search failed — ${why(r)}`);
  return (unwrap(r) || []).map(c => ({
    id: c.id, code: c.code, name: c.name,
    description: c.description || "", workType: c.workType || "",
    type: c.correctionCodeType || ""
  }));
}

/* Everything the correction LINE needs that the search does not carry —
   subSystemId above all, which the update body sends and which appears
   nowhere else. Also frt, chargedHours, topicId, procedureURL and the
   sublet/failure-mode flags, so the line is built from SCA's own description
   of the code rather than from constants copied off one captured ticket.

   Its `payType` array is the CODE-level list — 14 entries here, including
   both 10 and 5. It is not the one the pay-type rule may use: the activity
   call narrows the same code to four. See payTypesFor(). */
async function correctionDetails(token, { correctionCode, modelCode, site }){
  const r = await req(token, "GET",
    `/api/correction/correctiondetails/${q(correctionCode)}/${q(modelCode)}` +
    `?scaLocationId=${q(site.scaLocationId)}`);
  if(!ok(r)) throw new Error(`Could not read that correction code — ${why(r)}`);
  const d = unwrap(r) || {};
  return {
    code       : d.correctionCode, correctionId: d.correctionid ?? null,
    name       : d.correctionName || "", description: d.description || "",
    subSystemId: d.subSystemId ?? null, topicId: d.topicId ?? null,
    frt        : Number(d.frt || 0), chargedHours: Number(d.chargedHours || 0),
    failureModeEnabled: Boolean(d.isFailureModeEnabled),
    isSublet   : Boolean(d.isSublet),
    procedureURL: (d.modelLevelAdditionalAttribute &&
                   d.modelLevelAdditionalAttribute.procedureURL) || "",
    payTypeCodes: [].concat(d.payType || [])
  };
}

const validateCorrection = (token, { correctionCode, site, modelId }) =>
  req(token, "POST", "/integration/api/warpservice/validatecorrectioncode", [{
    correctionCode: String(correctionCode), locationID: site.locationId,
    scaLocationID: site.scaLocationId, modelId: Number(modelId), trtId: site.trtId
  }]).then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

/* FRT, charged hours, difficulty and list price for a code at this site.
   Fired by the app after the correction lands; worth showing on the node card
   because it is the money and the time the line will carry. */
const correctionTerms = (token, { correctionCode, site, modelId }) =>
  req(token, "POST", "/integration/api/warpservice/correctioncode", {
    correctionCode: String(correctionCode), locationID: site.locationId,
    modelId: Number(modelId), trtId: site.trtId
  }).then(r => (ok(r) ? unwrap(r) : null));

/* One entry for correctionPartDTO, in the exact shape the captured PUT sent.
   The constants here are SCA's own defaults for a fresh line and are echoed
   rather than reasoned about; everything that varies per code comes from
   correctionDetails(), so this does not bake one ticket's numbers into the
   board. */
const correctionLine = (d, payTypeId) => ({
  activityCorrectionID: 0,
  partIns: [], isSupersededView: false, laborDiscount: 0, isFlatRate: false,
  listFrtRate: 0, show: true, showNotes: true,
  failureModeEnabled: Boolean(d.failureModeEnabled),
  isDiagnostic: false, quantityPicked: 0, isContainerEnabled: false,
  alerts: [], referralCredit: 0, referralCreditBalance: 0, betterment: 0,
  tools: [], diagnosticReasons: [],
  serviceDescription: d.name,
  correctionCode: String(d.code),
  subSystemID: d.subSystemId,
  chargedHours: 0,
  isSublet: Boolean(d.isSublet),
  payTypeID: Number(payTypeId),
  contextualTags: [], procedureURL: d.procedureURL || "", reasonCodeComment: ""
});

/* The whole activity wrapper again, with the correction on correctionPartDTO.
   Same rule as the symptom write: SPREAD the record, never invent the body. */
async function updateCorrection(token, wrapper){
  const r = await req(token, "PUT", "/api/activitycorrection/update", wrapper);
  return { ok: ok(r), why: ok(r) ? "" : why(r), out: ok(r) ? unwrap(r) : null };
}

/* ────────────────────────────── pay types ──────────────────────────────

   THE important one for this tool's rule, and the reason the rule is written
   against this call and not the other.

   `lookup/paytypes` is the whole vocabulary — 25 entries, always including
   both Transportation Damage and Rectification. Asking it whether Transport
   Damage is available would therefore always answer yes, and the fallback
   could never fire.

   THIS call is per activity and per correction code, and it answers with the
   handful that are actually legal there — on the captured car, four of the
   twenty-five. It is the only call that can decide the rule. */
async function payTypesFor(token, { activityId, activityCorrectionId = 0, correctionCode }){
  const r = await req(token, "GET",
    `/case/api/paytype/paytypes/activity/${q(activityId)}` +
    `?activitycorrectionid=${q(activityCorrectionId)}` +
    `&correctioncode=${q(correctionCode || "")}`);
  if(!ok(r)) throw new Error(`Could not read which pay types this activity allows — ${why(r)}`);
  return (unwrap(r) || []).map(p => ({
    id: p.payTypeID ?? p.id, name: p.description ?? p.name ?? ""
  })).filter(p => p.id != null);
}

const allPayTypes = token =>
  req(token, "GET", "/case/api/lookup/paytypes")
    .then(r => (ok(r) ? (unwrap(r) || []) : []).map(p => ({
      id: p.payTypeID ?? p.id, name: p.description ?? p.name ?? ""
    })));

/* ──────────────────────────────── parts ────────────────────────────────

   partssearch is the searcher and the only one. `partscatalog/vin` looks like
   the catalogue and is not: 207 KB of category tree — 22 categories, 84
   subcategories, 179 system groups — with `parts: []` at every single leaf.
   The parts are lazy-loaded per group, so there is nothing there to cache and
   nothing to page through. Do not reach for it again; this comment is here to
   stop the next session spending an hour on it.

   partsrecommendation is keyed on the CORRECTION CODE, which is what makes
   the auto-fill possible: pick the correction and the part proposes itself,
   so nobody types a part number in the common case. */

async function partSearch(token, { term, modelId, site }){
  const t = String(term || "").trim();
  if(t.length < 2) return [];
  const r = await req(token, "GET",
    `/integration/api/sbom/parts/partssearch?term=${q(t)}&Modelid=${q(modelId)}` +
    `&locationId=${q(site.locationId)}&countryCode=US` +
    `&scaLocationId=${q(site.scaLocationId)}&locale=en-US` +
    `&AllowRestrictedParts=true&interceptionexcluded=false`);
  if(!ok(r)) throw new Error(`Part search failed — ${why(r)}`);
  return (unwrap(r) || []).map(p => ({
    partNumber: p.partNumber, name: p.name || "",
    type: p.partType || "", status: p.partStatus || "",
    isSerialized: Boolean(p.isSerialized || p.isSerializedPart),
    procurement: p.partProcurementType || "",
    minOrder: p.minimumOrderQuantity ?? 0,
    superseded: Boolean(p.isSuperseded)
  }));
}

const partsRecommended = (token, { vin, modelId, correctionCode, site }) =>
  req(token, "GET",
    `/api/partsrecommendation?Vin=${q(vin)}&ModelId=${q(modelId)}&ModelCode=${q(modelId)}` +
    `&CorrectionCode=${q(correctionCode)}&LocationId=${q(site.locationId)}` +
    `&ScaLocationId=${q(site.scaLocationId)}`)
    .then(r => (ok(r) ? (unwrap(r) || []) : []));

/* Stock and price at this location, so the node card can say whether the part
   is actually on the shelf before anybody commits to billing it.

   Two different body shapes, and they are not interchangeable — the first cut
   sent the price call a `{scaLocationId, partNumbers}` object of its own
   invention and got a cheerful 200 with every price null. Both bodies below
   are the captured ones.

   Swift answers stock as `quantity` (not availableQuantity) plus the
   binLocation PickReturn needs; SpaceXERP answers `unitPrice` and the
   `commodityCode` that goes onto the billed line. */
const partDetails = (token, site, partNumbers) =>
  req(token, "POST",
    `/integration/api/swiftinventory/parts/location/${q(site.locationId)}/partdetails` +
    `?isBinLevelPart=false&interceptionexcluded=true`,
    [].concat(partNumbers)).then(r => (ok(r) ? (unwrap(r) || []) : []));

const partPrice = (token, site, partNumbers) =>
  req(token, "POST", "/integration/api/SpaceXERP/part/UnitPrice/scalocationid", {
    locationID   : site.locationId,
    partList     : [].concat(partNumbers),
    scaLocationID: site.scaLocationID ?? site.scaLocationId,
    countryId    : 0
  }).then(r => (ok(r) ? (unwrap(r) || []) : []));

/* ── what "in stock" actually means ──

   Swift's `quantity` is what is on the shelf, and it is NOT what the Service
   App shows as available. Cypress holds 2 key cards and both are allocated to
   other jobs, so the answer to "how many can I have" is **nought**, which is
   what Ed's screen says and what this board has to say. Free = on hand minus
   allocated.

   Requests are a third number and deliberately not subtracted: 13 outstanding
   requests against 2 cards is a backlog, not a claim on the shelf. It is worth
   showing beside the count and worth nobody's arithmetic.

   Both endpoints take a batch, which is what makes it affordable to put a
   stock figure on every row of a search result rather than only on the
   chosen part. */
const partAllocation = (token, site, partNumbers) =>
  req(token, "POST", "/api/partallocation/batch-get-part-allocation-count?interceptionexcluded=true",
      { locationId: site.locationId, partNumberList: [].concat(partNumbers) })
    .then(r => (ok(r) ? (unwrap(r) || []) : []));

const partRequests = (token, site, partNumbers) =>
  req(token, "POST", "/api/partrequest/batch-get-part-requests-count?interceptionexcluded=true",
      { locationId: site.locationId, partNumberList: [].concat(partNumbers) })
    .then(r => (ok(r) ? (unwrap(r) || []) : []));

/* ─────────────────────── the catalogue, for browsing ───────────────────────

   `partssearch` above answers "is this part here" — a term, one model, two
   characters minimum. It cannot answer "what parts are there", and that is
   what Parts Catalog asks. A different API entirely, mined out of the Angular
   bundle and then proven live; nothing else on this board uses it.

   ── no VIN is needed, and the tool rests on that ──

   The entry point the app itself uses is `POST partscatalog/vin`, which takes
   {vin, modelID, productionDate, locationID}. Called with the VIN blank it
   answers 200 / "Error retrieving Parts Catalog from EPC". But
   `partscatalog/id/<catalogId>/US?vin=` returns the **identical object** with
   the VIN empty, and the parts POST below takes `vin:""` and answers normally.
   So this tool needs no car on screen — unlike the quick-add rail next door,
   which does. Don't re-probe `partscatalog/vin`; it is a dead end for us.

   ── the whole skeleton is ONE call ──

   Catalogue 3115 (Model Y Feb 2025, "Opal") is 22 categories → 84
   subcategories → 179 system groups, and all three levels come back nested in
   a single ~400ms GET. Parts are the only level that has to be fetched, which
   is why the page can draw the tree instantly and lazily fill the leaf.

   `productTypeId` is 1 = Vehicle. 2 is Energy (25 catalogues) and 3 is Optimus
   (4), both measured, both out of scope for a vehicle board — one parameter
   away if that ever changes. Country is US for the same reason every other
   call on this board hard-codes it. */
const PRODUCT_TYPE_VEHICLE = 1;
const CATALOG_COUNTRY      = "US";

const catalogList = token =>
  req(token, "GET",
    `/integration/api/partscatalog/productType/${PRODUCT_TYPE_VEHICLE}/${CATALOG_COUNTRY}`)
    .then(r => {
      if(!ok(r)) throw new Error(`The Service App would not list the catalogues — ${why(r)}`);
      return unwrap(r) || [];
    });

/* The `vin=` is deliberately empty — see above. It is sent rather than
   dropped because the parameter is required and an absent one 400s. */
const catalogTree = (token, catalogId) =>
  req(token, "GET",
    `/integration/api/partscatalog/id/${q(catalogId)}/${CATALOG_COUNTRY}` +
    `?vin=&productTypeId=${PRODUCT_TYPE_VEHICLE}`)
    .then(r => {
      if(!ok(r)) throw new Error(`The Service App would not open that catalogue — ${why(r)}`);
      return unwrap(r) || null;
    });

/* Answers the system group back WITH its `parts[]` filled in, not a bare
   array — so the caller reads `.parts`, and an empty group is a group with no
   parts rather than a call that failed. */
/* `vin` is the one optional argument and it changes the ANSWER, not the list:
   the same five parts come back either way, but with a VIN the ones that
   apply to that car carry `recommendationType: "RECOMMENDED"`. Empty when
   browsing, which is what it has always sent. */
const catalogParts = (token, { catalogId, categoryId, subCategoryId, systemGroupId, vin }) =>
  req(token, "POST", "/integration/api/partscatalog/parts?interceptionexcluded=true", {
    vin          : String(vin || "").trim().toUpperCase(),
    catalogID    : Number(catalogId),
    categoryID   : Number(categoryId),
    subCategoryID: Number(subCategoryId),
    systemGroupID: Number(systemGroupId),
    productTypeId: PRODUCT_TYPE_VEHICLE
  }).then(r => {
    if(!ok(r)) throw new Error(`The Service App would not list that group's parts — ${why(r)}`);
    return unwrap(r) || null;
  });

/* The catalogue for ONE CAR, chosen by SCA from the VIN.

   An earlier note in this file said the vin route was a dead end that "looks
   like the front door". That was true of the question being asked then —
   browsing with no VIN, where it answers 200 / "Error retrieving Parts
   Catalog from EPC". With a real VIN it is exactly the front door, and it is
   worth two things:

     - it picks the catalogue itself. No model list, no generation to guess:
       7SAYGDEE4TA751019 comes back as 3115, "Model Y Feb 2025", Opal.
     - it returns the WHOLE tree in that one call, so the by-id GET is not
       needed afterwards.

   **`modelID` is ignored, and sending 0 is the safe reading of that.** 17,
   36, 8, 1 and 0 all answer with the same catalogue for the same VIN —
   measured. The VIN alone drives it, so nothing has to be looked up first,
   and that matters more here than it looks: this file's own header warns
   that `search.modelId` says 17 for a Model Y where every other call wants
   36. Sending a real id would mean picking between two id spaces for a
   parameter that has no effect. `productionDate: null` is fine too. Both are
   sent because SCA sends them.

   **A wrong VIN is a 200.** Truncated, fictional, a real VIN from another
   marque, or empty — all four come back `success:false` / "Error retrieving
   Parts Catalog from EPC". The fourth 200-that-means-no on this board, and
   `ok()` is what catches it. */
const catalogForVin = (token, vin) =>
  req(token, "POST", "/integration/api/partscatalog/vin?interceptionexcluded=true", {
    vin           : String(vin || "").trim().toUpperCase(),
    modelID       : 0,
    productionDate: null,
    /* Zero, not null. Both `modelID` and `locationID` are ignored — 5171,
       15138 and 0 all answer with the same catalogue — but they must be
       PRESENT and numeric: `locationID: null` is refused with "Model
       validation(s) failed", a message that names the wrong field and cost a
       round of debugging for exactly that reason. */
    locationID    : 0
  }).then(r => {
    /* SCA's own message names EPC, which is a system the person holding the
       VIN has never heard of. What they need to know is that the VIN did not
       resolve. */
    if(!ok(r)) throw new Error(
      `No catalogue for that VIN — the Service App could not match it to a model.`);
    return unwrap(r) || null;
  });

/* Searches one catalogue by part name OR part number, and it is NOT
   `partssearch` next door — that one demands a `Modelid` and a site, and the
   catalogue knows neither. A catalogue carries `catalogModelId` 8 for a Model
   Y where partssearch wants 36, a different vocabulary entirely; every
   attempt to bridge them answered "Model validation(s) failed".

   This one takes the catalogue's own id and nothing else. No VIN, no model,
   no location — the same reason `partscatalog/id/` needs none.

   **It came out of the bundle, where it is called `getPartNotesFromEPC`** — a
   name that describes neither the arguments nor the answer. Four guessed
   paths 404'd before it turned up (`partscatalog/search/<id>/US`,
   `partscatalog/parts/search`, `partsearch`, `searchparts`), which is the
   house rule earning its keep once more: mine it, don't guess it.

   Every hit carries the ids of the category, subcategory and system group it
   lives in — so a result can put the tree on that node rather than reciting a
   part number at somebody. Proven: 10 of 10 hits for "bumper" resolved
   against the tree AND the group really listed the part. */
const catalogSearch = (token, { catalogId, term }) =>
  req(token, "POST", "/integration/api/partscatalog/search?interceptionexcluded=false", {
    catalogId  : Number(catalogId),
    term       : String(term || "").trim(),
    countryCode: CATALOG_COUNTRY
  }).then(r => {
    if(!ok(r)) throw new Error(`The Service App would not search the catalogue — ${why(r)}`);
    return (unwrap(r) || []).map(h => ({
      partNumber : h.partNumber,
      name       : h.title || "",
      notes      : h.notes || "",
      categoryId : h.categoryId,
      subCategoryId: h.subcategoryId,      // SCA's lower-case c, kept at the edge
      systemGroupId: h.systemGroupId,
      groupTitle : h.systemGroupTitle || "",
      /* A string off the wire. Kept as a number for sorting and dropped from
         the page — a relevance score is the search's working, not an answer
         anybody reads. */
      score      : Number(h.score) || 0
    }));
  });

/* Bills the part onto the correction. payTypeID is where Transportation
   Damage actually lands. */
async function createParts(token, part){
  const r = await req(token, "POST",
    "/api/activitycorrectionpartautomation/createparts", [part]);
  if(!ok(r)) throw new Error(`The Service App would not add the part — ${why(r)}`);
  const rows = unwrap(r) || [];
  return rows[0] || null;
}

/* The billed lines as the RECORD has them, not as createparts described them.

   `createparts` does hand its id straight back, and picking still has to be
   judged from here: the line is `isDraftPart: true` the instant it is made,
   and a pick that quietly does not take shows up three steps later as a close
   refusing with "Please pick parts before closing the activity" — a long way
   from the thing that actually went wrong. */
async function activityDetail(token, activityId, site){
  const r = await req(token, "GET",
    `/activity/api/activity/activitybyscalocationid/${q(activityId)}` +
    `?scaLocationId=${q(site.scaLocationId)}&locale=en_US&includeParts=true`);
  return ok(r) ? (unwrap(r) || null) : null;
}

/* 1 open, 2 closed, 3 cancelled — read off a real one of each rather than
   taken from a table, because SCA publishes no list of these. */
const ACTIVITY_CLOSED = 2;

async function partLinesOn(token, activityId, site){
  const w = await activityDetail(token, activityId, site);
  if(!w) return [];
  const out = [];
  for(const c of [].concat(w.correctionPartDTO || []))
    for(const p of [].concat(c.partIns || []))
      if(p) out.push(p);
  return out;
}

const prnDetail = (token, svid, partIds) =>
  req(token, "POST", `/api/activitycorrectionpart/prndetail/servicevisit/${q(svid)}/part`,
      [].concat(partIds)).then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

/* Picks the part off the shelf. binLocation comes from the part detail read;
   without it the line stays unpicked and the ticket cannot close clean. */
async function pick(token, { serviceVisitId, activityId, activityCorrectionId,
                             activityCorrectionPartId, binLocation, isSerialized = false }){
  const r = await req(token, "POST", "/case/api/PickReturn", {
    serviceVisitID: String(serviceVisitId), isPick: true,
    activityCorrectionPickReturnDtos: [{
      activityCorrectionID: activityCorrectionId,
      activityCorrectionPartID: activityCorrectionPartId,
      isSerialized: Boolean(isSerialized),
      activityID: activityId,
      fullFillmentLocationId: null,
      binLocation: binLocation || null
    }]
  });
  return { ok: ok(r), why: ok(r) ? "" : why(r) };
}

/* ───────────────────────────── the technician ──────────────────────────── */

async function userSearch(token, term){
  const t = String(term || "").trim();
  if(t.length < 2) return [];
  const r = await req(token, "GET", `/integration/api/user/search?searchTerm=${q(t)}`);
  if(!ok(r)) throw new Error(`Could not search the Service App's users — ${why(r)}`);
  return (unwrap(r) || [])
    .filter(u => u && u.userID && u.enabled !== false)
    .map(u => ({ userId: u.userID, name: u.displayName ||
                 `${u.firstName || ""} ${u.lastName || ""}`.trim(),
                 title: u.title || "", email: u.email || "" }));
}

/* Refuses against a REMOVED correction — captured live: "Correction Owner for
   ActivityCorrectionID: … can't be saved, the code have be removed." So this
   has to run against the correction that is still on the activity, and after
   any removals rather than before. */
const setOwner = (token, activityCorrectionId, ownerId) =>
  req(token, "POST", "/api/activitycorrectionowner/saveactivitycorrectionowners",
      [{ activityCorrectionID: Number(activityCorrectionId), ownerID: Number(ownerId) }])
    .then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

const ownersOf = (token, activityCorrectionId) =>
  req(token, "GET",
    `/api/activitycorrectionowner/owners?activityCorrectionId=${q(activityCorrectionId)}`)
    .then(r => (ok(r) ? (unwrap(r) || []) : []));

/* ──────────────────────── removing the courtesy line ───────────────────

   NOT cancelActivity, which closes a ticket and must never be called from
   this board. removeactivities returns the line to outstanding work and
   leaves the ticket open — SCA's own label for it is
   activity_remove_and_return_to_outstanding_work.

   After this the removed activity is GONE: an update against it answers
   "Activity does not exist". Captured 2 s after a real removal. */
const removeActivities = (token, svid, activityIds) =>
  req(token, "POST", `/case/api/visit/${q(svid)}/removeactivities`,
      [].concat(activityIds).map(Number))
    .then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

/* ───────────────────── cancelling the visit ─────────────────────────

   Captured off Ed cancelling 48190773 by hand, and the finding matters: the
   cancel is **not** `servicevisit/cancelServiceVisits`. That call is the one
   this board is forbidden to make — it flipped a live ticket from status 1 to
   3 while answering 200/success — and it is not what SCA's own UI does.

   SCA cancels a visit with the ORDINARY motion PUT, to motion 10, and then
   records the reason:

     PUT  /case/api/case/visit/servicevisitmotion/  { serviceVisitMotion: 10,
                                                      serviceVisitDateTime: null }
     POST /case/api/feedback                        { feedbackCategoryID, … }

   So there is no new cancel endpoint at all — `setMotion` already does it.
   Only the reason record is new.

   Measured on 48192893 after Ed cancelled it by hand: visit motion 10 /
   status 3, its COURTESY line cancelled to status 3, and the Part Picker
   activity left at status 1 — open, in outstanding work. Cancelling a visit
   does not necessarily cancel everything on it, so lib.js reads each one back
   and says which is which rather than claiming a clean sweep. */

/* `Lookup/feedbackcategories`, read live. 30 is Ed's: a mistakenly-opened
   parts ticket is a parts delay. */
const FEEDBACK = {
  PARTS_DELAY: { id: 30, text: "Parts delays" },
  DUPLICATE  : { id: 29, text: "Duplicate or aging Service Visit" }
};

/* Read off a visit SCA had cancelled, like ACTIVITY_CLOSED: 10 is the
   cancelled motion and it leaves the visit at serviceVisitStatusID 3. */
const MOTION_CANCELLED = 10;

/* `typeCode` is not optional and dropping it does not error — it returns a
   DIFFERENT vocabulary. Without it the endpoint answers the FRT feedback list
   ("Diagnostic tool not working", "Wi-Fi Issue", …) with ids 1-11, in which
   30 does not exist and 10 means "Tooling or equipment not available". Asking
   the wrong question here would have filed every cancelled parts ticket under
   somebody's tooling complaint. */
const feedbackCategories = (token, typeCode = "CANCEL_SERVICEVISIT") =>
  req(token, "GET", `/case/api/Lookup/feedbackcategories?typeCode=${q(typeCode)}`)
    .then(r => (ok(r) ? (unwrap(r) || []) : []));

/* referenceType 2 is a service visit and feedbackTypeID 3 is the cancellation
   reason — both echoed from the capture, not chosen. `descriptions` carries
   the category's own wording, because SCA sends the text as well as the id
   and this sends back exactly what it would. */
const addFeedback = (token, { serviceVisitId, category, serviceVisitDateTime = null }) =>
  req(token, "POST", "/case/api/feedback", {
    referenceId          : String(serviceVisitId),
    allowMultipleFeedback: true,
    referenceType        : 2,
    feedbackTypeID       : 3,
    form                 : { descriptions: [category.text], comment: "", followUpReasons: [] },
    feedbackCategoryID   : category.id,
    serviceVisitDateTime : serviceVisitDateTime
  }).then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

/* ─────────────────────── customer repair notes ─────────────────────────

   Captured 2026-08-26 off Ed's own clicks on visit 48192893, activity
   125807826 — the write that was missing from the keycard run, because that
   run never needed one.

   What LOOKS like typing a note is not. The button generates the text with
   SCA's chatbot and the save is three calls behind it:

     POST /activity/api/chatbot/generatecustomerrepairnotes
          {activityId, locale}  ->  responseObject.generatedRepairNotes
     POST /case/api/note/<activityId>                      <- the note record
     POST /activity/api/activity/savegeneratedcustomerepairnotes

   This board writes a fixed sentence, so the chatbot call is skipped: asking
   an AI to describe work it cannot see, then throwing the answer away, is a
   round trip for nothing. The other two are sent exactly as captured.

   SCA also fired `activityextension/add` and a wrapper PUT at
   `preventOverride=true` around these. Neither is needed — same finding as
   the symptom edit, and the note reads back without them.

   Note paths are `<referenceId>/<noteType>/<referenceType>`; referenceType 2
   is an activity and 3 is a service visit. The customer note on an activity
   is `/<activityId>/2/2/`. */

/* `isAIAssisted` is false where the capture had true, and that is the one
   field here that is not a copy. It describes where the words came from, and
   ours came from Admin › Parts, not from the chatbot. Claiming otherwise
   would put a lie in a customer-visible record to save an argument with a
   boolean. */
const addCustomerNote = (token, activityId, text) =>
  req(token, "POST", `/case/api/note/${q(activityId)}`, {
    description  : String(text),
    referenceID  : Number(activityId),
    referenceType: 2,
    noteType     : 2,
    noteSourceType: 1,
    isAIAssisted : false
  }).then(r => ({ ok: ok(r), noteId: ok(r) ? unwrap(r) : null,
                  why: ok(r) ? "" : why(r) }));

/* The second half of the save. Generated and edited carry the same string
   here because nothing edited anything — which is exactly the shape the
   capture had, Ed having accepted the generated text unchanged. */
const saveGeneratedNotes = (token, activityId, text) =>
  req(token, "POST", "/activity/api/activity/savegeneratedcustomerepairnotes", {
    GeneratedRepairNotes: String(text),
    EditedRepairNotes   : String(text),
    ActivityId          : Number(activityId),
    AdditionalAttributes: { locale: "en_US" }
  }).then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

const customerNotesRequired = (token, activityId, svid) =>
  req(token, "GET",
    `/activity/api/activitysummary/checkcustomernotesrequired/${q(activityId)}` +
    `?visitId=${q(svid)}`)
    /* The envelope's own `success` flickered true/false across identical calls
       in the capture while responseObject stayed put, so the ANSWER is
       responseObject and `success` is not evidence here. Nothing branches on
       this any more — the board writes a note either way — but it is kept as
       a read for anyone diagnosing a close that refuses. */
    .then(r => Boolean(r.body && r.body.responseObject === true));

const customerNoteOn = (token, activityId) =>
  req(token, "GET", `/case/api/case/${q(activityId)}/2/2/notebyreferenceid`)
    .then(r => (ok(r) ? unwrap(r) : null));

const publicNotesEnabled = (token, trtId, scaLocationId) =>
  req(token, "GET",
    `/case/api/Lookup/publicnotesenabledflag/${q(trtId)}/US?scaLocationId=${q(scaLocationId)}`)
    .then(r => Boolean(ok(r) && unwrap(r) === true));

/* ───────────────────────────── closing it out ──────────────────────────── */

const closeActivity = (token, activityId) =>
  req(token, "PUT", `/case/api/activity/${q(activityId)}/Close`)
    .then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

/* The ladder. `close-with-activities` is the same call under a different path
   and is the one the app uses for 39 Service Complete; everything else goes
   to the bare route.

   serviceVisitDateTime is echoed, never formatted here: SCA hands back
   "2026/8/25 19:45:00" on one step and "8/25/2026 7:45:00 PM" on the next, and
   inventing either format is a guess where echoing is free. */
function setMotion(token, { serviceVisitId, motion, serviceVisitDateTime = null,
                            withActivities = false }){
  const path = "/case/api/case/visit/servicevisitmotion/" +
               (withActivities ? "close-with-activities" : "");
  return req(token, "PUT", path, {
    visitID: String(serviceVisitId),
    serviceVisitMotion: Number(motion),
    cancelActivities: false,
    customerCancelConfirmation: false,
    serviceVisitDateTime: serviceVisitDateTime,
    noEtaWarningConfirmation: false
  }).then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));
}

/* Refuses before motion 29 — "The estimated completion time cannot be set
   before the Prepared Motion Status". Caller must have set Prepared first. */
const setEtc = (token, svid, when) =>
  req(token, "PUT", `/case/api/visit/${q(svid)}/estimatedCompletionDateTime`,
      { Data: when, updateETP: true, isSuggestedETCApplied: false })
    .then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

const ackUnpaidBalance = (token, svid) =>
  req(token, "POST", `/case/api/servicevisit/acknowledeUnpaidBalance/${q(svid)}`)
    .then(r => ({ ok: ok(r), why: ok(r) ? "" : why(r) }));

/* Motion id → name, read live rather than hard-coded: the ladder this tool
   drives is fixed, but the names shown beside it should be SCA's. */
const motionStatuses = token =>
  req(token, "GET", "/case/api/Lookup/servicevisitmotionstatus?interceptionexcluded=true")
    .then(r => {
      const m = {};
      for(const x of (ok(r) ? (unwrap(r) || []) : []))
        m[x.serviceVisitMotionStatusID] = x.description;
      return m;
    });

/* The ladder itself, in the order Ed drove it and proven in that order.

   42 "Ready for Service" exists in the lookup and is deliberately absent:
   it was named in the spec but never fired in the capture, and this board
   does not make transitions nobody has seen succeed. Decided 2026-08-26. */
const LADDER = [
  { motion: 29, name: "Prepared" },
  { motion:  2, name: "Arrived" },
  { motion:  8, name: "Service" },
  { motion: 39, name: "Service Complete", withActivities: true },
  { motion:  7, name: "Ready for Pick Up" },
  { motion:  9, name: "Delivered" }
];

/* The key card, as it was written to the record. Editable per run and
   overridable in Admin; this is only the starting point. */
const DEFAULT_SYMPTOM = {
  symptomId: 5800, symptomCode: "13067524",
  description: "KEY CARD [ Missing / Lost ]",
  hyper: "Missing", cosmetic: "No"
};

const PAYTYPE_PREFERRED = 10;   // Transportation Damage
const PAYTYPE_FALLBACK  = 5;    // Rectification
const DEFAULT_TECH      = { userId: 75169, name: "Bart Raymond" };

module.exports = {
  req, ok, why, unwrap,
  findByVin, profileOf,
  createVisit, visitWithUidAndVin, visitActivities,
  createActivity, attachActivity, updateActivity,
  correctionSearch, correctionDetails, correctionLine, validateCorrection, correctionTerms, updateCorrection,
  payTypesFor, allPayTypes,
  partSearch, partsRecommended, partDetails, partPrice, partAllocation, partRequests,
  catalogList, catalogTree, catalogParts, catalogSearch, catalogForVin,
  createParts, prnDetail, pick, partLinesOn, activityDetail, ACTIVITY_CLOSED,
  userSearch, setOwner, ownersOf,
  removeActivities,
  customerNotesRequired, customerNoteOn, publicNotesEnabled,
  addCustomerNote, saveGeneratedNotes,
  closeActivity, setMotion, setEtc, ackUnpaidBalance, motionStatuses,
  feedbackCategories, addFeedback, FEEDBACK, MOTION_CANCELLED,
  LADDER, DEFAULT_SYMPTOM, DEFAULT_TECH, PAYTYPE_PREFERRED, PAYTYPE_FALLBACK
};

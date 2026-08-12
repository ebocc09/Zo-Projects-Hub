#!/usr/bin/env node
/* The evidence behind the post-VRI ticket metric — re-runnable.

   Cars that PASSED their VRI and then had a service visit opened afterwards:
   the faults the inspection missed. lib.js postVriTicket() decides which of
   those count, and cites numbers from this script. Run it to re-check that
   reasoning against a centre, or after an Intrepid change.

   The questions it was written to answer, before anything was built:
     1. How many delivered cars have one?
     2. How long after the VRI does it land? A visit three days later is a
        plausible miss; one four months later is probably unrelated wear, and
        counting it against the inspector would be dishonest.
     3. Does it land BEFORE or AFTER the car was finished for delivery? A visit
        opened after handover is the customer's, not the centre's.
     4. Do cars that already failed their VRI also pick up a later visit? That
        decides whether "caught" and "missed" can double-count the same car.

   node check-post-vri.js [trtId] [days back] */

"use strict";

const https = require("https");
const credstore = require("./credstore");

const HOST = "intrepidapi.tesla.com", COGS = "/cogs/api/cogs";
const cookie = credstore.intrepidCookie().value.trim();
if(!cookie){ console.error("No Intrepid cookie — sign in on the Hub."); process.exit(1); }

const trt  = process.argv[2] || "17589";
const back = Number(process.argv[3] || 21);
const TODAY = "2026-08-10";

function once(path, body){
  return new Promise((res, rej) => {
    const pl = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: HOST, path: COGS + path, method: body ? "POST" : "GET",
      headers: { Cookie: cookie, Accept: "application/json",
        ...(pl ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) } : {}) },
      timeout: 60000 },
      x => { let b = ""; x.on("data", c => b += c);
             x.on("end", () => x.statusCode === 200
               ? (() => { try { res(JSON.parse(b)); } catch { rej(new Error("unparsable")); } })()
               : rej(new Error("HTTP " + x.statusCode))); });
    r.on("error", rej);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if(pl) r.write(pl); r.end();
  });
}
async function call(p, b, tries = 3){
  let last;
  for(let i = 0; i < tries; i++){
    try { return await once(p, b); }
    catch(e){ last = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}
function pool(items, n, fn){
  const out = new Array(items.length); let i = 0, done = 0;
  return Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while(i < items.length){ const k = i++;
      try { out[k] = await fn(items[k]); } catch(e){ out[k] = { error: e.message }; }
      if(++done % 100 === 0) process.stderr.write(`  ${done}/${items.length}\r`); }
  })).then(() => out);
}
const t = s => s ? new Date(String(s).replace(/Z$/, "")).getTime() : null;
const days = ms => ms / 86400000;

(async () => {
  // The board's population: cars DELIVERED in the window.
  const dates = [];
  for(let i = 1; i <= back; i++){
    const d = new Date(TODAY + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const appts = [];
  for(const d of dates){
    const rows = await call(`/getTssAppointmentsByDate?trtId=${trt}&date=${d}&searchQuery=`);
    for(const r of (Array.isArray(rows) ? rows : [])){
      if(r && r.vin && r.cogInfo && r.cogInfo.id) appts.push({ vin: r.vin, ship: r.cogInfo.id, date: d });
    }
  }
  const uniq = new Map();
  for(const a of appts) if(!uniq.has(a.vin)) uniq.set(a.vin, a);
  console.log(`delivered in last ${back} days at ${trt}: ${uniq.size} cars\n`);

  const cars = await pool([...uniq.values()], 8, async c => {
    const d = await call(`/getVehicleStatusLogByVinWithPdiTask?vin=${c.vin}&vehicleShipmentId=${c.ship}`);
    const es = (d && d.vehicleStatusLogs) || [];
    const vri = es.find(e => /receiving inspection completed/i.test(e.vehicleCogStatusName || ""));
    if(!vri) return null;
    const failEntry = es.find(e => e !== vri
      && /^\s*in service\s*$/i.test(String(e.vehicleCogStatusName || ""))
      && t(e.createdDate) === t(vri.createdDate));
    const fg = es.find(e => /finished goods/i.test(e.vehicleCogStatusName || ""));
    // Every In Service STRICTLY after the VRI — the failure's own entry shares
    // the VRI timestamp, so it drops out here rather than needing special-casing.
    const post = es.filter(e => /^\s*in service\s*$/i.test(String(e.vehicleCogStatusName || ""))
                             && t(e.createdDate) > t(vri.createdDate))
                   .sort((a, b) => t(a.createdDate) - t(b.createdDate));
    return { vin: c.vin, delivered: c.date, vriAt: vri.createdDate, vriBy: vri.createdBy,
             failed: Boolean(failEntry), finishedAt: fg ? fg.createdDate : null, post };
  });

  const ok = cars.filter(c => c && !c.error);
  const withPost = ok.filter(c => c.post.length);
  console.log(`cars with a completed VRI      : ${ok.length}`);
  console.log(`failed the VRI (caught)        : ${ok.filter(c => c.failed).length}`);
  console.log(`service visit AFTER the VRI    : ${withPost.length}  (${(withPost.length/ok.length*100).toFixed(1)}%)`);
  console.log(`  of those, car had FAILED VRI : ${withPost.filter(c => c.failed).length}   ← would double-count`);
  console.log(`  of those, car PASSED the VRI : ${withPost.filter(c => !c.failed).length}`);

  /* Q2 — how long after the VRI? */
  const lags = withPost.filter(c => !c.failed).map(c => days(t(c.post[0].createdDate) - t(c.vriAt)));
  lags.sort((a, b) => a - b);
  const q = p => lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))].toFixed(1) : "-";
  console.log(`\n── lag VRI → first later service visit (passed cars, ${lags.length}) ──`);
  console.log(`  min ${q(0)}d · p25 ${q(.25)}d · median ${q(.5)}d · p75 ${q(.75)}d · p90 ${q(.9)}d · max ${lags.length?lags[lags.length-1].toFixed(1):"-"}d`);
  const buckets = [[0,1],[1,3],[3,7],[7,14],[14,30],[30,90],[90,1e9]];
  for(const [lo,hi] of buckets){
    const n = lags.filter(v => v >= lo && v < hi).length;
    if(n) console.log(`    ${String(lo).padStart(3)}–${hi>1e8?"∞":hi} days: ${String(n).padStart(3)}  ${"█".repeat(Math.round(n/Math.max(1,lags.length)*40))}`);
  }

  /* Q3 — the cutoff Ed set: the visit only counts if it was opened before the
     car was DELIVERED. After handover it is the customer's visit, not the
     centre's, and it says nothing about the inspection.
     Delivery is taken as the end of the appointment day, which is the only
     delivery timing the compile carries per car. */
  const endOfDeliveryDay = c => t(c.delivered + "T23:59:59");
  const passed = withPost.filter(c => !c.failed);
  const preDel = passed.filter(c => c.post.some(e => t(e.createdDate) <= endOfDeliveryDay(c)));
  console.log(`\n── against the delivery cutoff (${passed.length} passed cars with a later visit) ──`);
  console.log(`  visit opened BEFORE delivery: ${preDel.length}   ← counts, the centre had the car`);
  console.log(`  visit opened AFTER  delivery: ${passed.length - preDel.length}   ← the customer's, excluded`);
  console.log(`  → post-VRI ticket rate on the board would be ${(preDel.length/ok.length*100).toFixed(1)}% of ${ok.length} cars`);

  const rel = passed.filter(c => c.finishedAt);
  const before = rel.filter(c => t(c.post[0].createdDate) < t(c.finishedAt)).length;
  console.log(`\n── for reference, relative to Finished Goods (${rel.length} with both) ──`);
  console.log(`  visit opened BEFORE the car was finished: ${before}`);
  console.log(`  visit opened AFTER  the car was finished: ${rel.length - before}`);

  console.log(`\n── sample, passed VRI then a service visit ──`);
  for(const c of withPost.filter(c => !c.failed).slice(0, 14)){
    const lag = days(t(c.post[0].createdDate) - t(c.vriAt)).toFixed(1);
    const side = c.finishedAt ? (t(c.post[0].createdDate) < t(c.finishedAt) ? "pre-finish " : "post-finish") : "no-finish  ";
    console.log(`  ${c.vin}  vri ${c.vriAt.slice(0,10)} by ${String(c.vriBy||"").padEnd(16)} +${lag.padStart(6)}d  ${side}  sv=${c.post[0].serviceVisitId ?? "-"}  (${c.post.length} visit(s))`);
  }
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

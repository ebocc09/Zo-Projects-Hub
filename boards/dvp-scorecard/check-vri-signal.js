#!/usr/bin/env node
/* The evidence behind how a failed VRI is detected — re-runnable.

   lib.js statusSetters() calls a VRI failed on a same-timestamp pair of log
   entries rather than on Intrepid's own vriPassedDate field, and the comment
   there cites numbers. This is what produced them. Run it against a centre to
   re-check that reasoning, or to check it still holds after an Intrepid change.

   Do the two signals agree across a whole centre?

     A. same-timestamp pair   Receiving Inspection Completed + In Service
     B. vriPassedDate == null on the shipment record

   If they agree, B is the better primary: it is explicit rather than inferred,
   and it arrives in a BULK call (500 VINs a request) instead of one status-log
   request per car.

   Also reports whether the appointment's own cogInfo carries vriPassedDate,
   because the DVP compile already fetches appointments — if it is there, the
   metric costs no extra traffic at all.

   node check-vri-signal.js [trtId] [YYYY-MM-DD for the appointment check] */

"use strict";

const https = require("https");
const credstore = require("./credstore");

const HOST = "intrepidapi.tesla.com", COGS = "/cogs/api/cogs";
const cookie = credstore.intrepidCookie().value.trim();
if(!cookie){ console.error("No Intrepid cookie — sign in on the Hub."); process.exit(1); }

const trt  = process.argv[2] || "17589";
const date = process.argv[3] || new Date().toISOString().slice(0, 10);

function once(path, body){
  return new Promise((res, rej) => {
    const pl = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: HOST, path: COGS + path, method: body ? "POST" : "GET",
      headers: { Cookie: cookie, Accept: "application/json",
        ...(pl ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pl) } : {}) },
      timeout: 60000 },
      x => { let b = ""; x.on("data", c => b += c);
             x.on("end", () => x.statusCode === 200
               ? (() => { try { res(JSON.parse(b)); }
                          catch { rej(new Error(`unparsable (${b.length}b): ${b.slice(0,80)}`)); } })()
               : rej(new Error("HTTP " + x.statusCode))); });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    if(pl) r.write(pl); r.end();
  });
}
/* A dropped connection mid-scan would otherwise abort a ten-minute run. */
async function call(path, body, tries = 3){
  let last;
  for(let i = 0; i < tries; i++){
    try { return await once(path, body); }
    catch(e){ last = e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  throw last;
}
function pool(items, n, fn){
  const out = new Array(items.length); let i = 0, done = 0;
  return Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while(i < items.length){ const k = i++;
      try { out[k] = await fn(items[k]); } catch(e){ out[k] = { error: e.message }; }
      if(++done % 100 === 0) process.stderr.write(`  ${done}/${items.length}\r`);
    }
  })).then(() => out);
}
const same = (a, b) => a && b && new Date(a).getTime() === new Date(b).getTime();

(async () => {
  /* ── does the appointment already carry it? ── */
  try{
    const appts = await call(`/getTssAppointmentsByDate?trtId=${trt}&date=${date}&searchQuery=`);
    const rows = Array.isArray(appts) ? appts : (appts && appts.Data) || [];
    const withCog = rows.find(r => r && r.cogInfo);
    console.log(`── appointments on ${date}: ${rows.length} row(s) ──`);
    if(withCog){
      console.log(`  cogInfo keys: ${Object.keys(withCog.cogInfo).join(", ")}`);
      console.log(`  'vriPassedDate' present in cogInfo: ${"vriPassedDate" in withCog.cogInfo}`);
      const n = rows.filter(r => r.cogInfo && r.cogInfo.vriPassedDate != null).length;
      console.log(`  populated on ${n}/${rows.filter(r => r.cogInfo).length} appointments with a cogInfo`);
    } else console.log("  no cogInfo on any appointment this date");
  }catch(e){ console.log(`  appointment check failed: ${e.message}`); }

  /* ── the agreement test, whole centre ── */
  const inv = await call(`/getCogInventoryCars?trtId=${trt}&matchStatus=&vehicleTypes=&pageSize=5000`);
  const vins = [...new Set((Array.isArray(inv) ? inv : []).map(r => r && r.vin).filter(Boolean))];
  console.log(`\n── whole centre: ${vins.length} VINs ──`);

  const ships = new Map();
  for(let i = 0; i < vins.length; i += 500){
    const got = await call(`/getAllVehicleShipments?trtId=${trt}`, { vins: vins.slice(i, i + 500) });
    for(const r of Array.isArray(got) ? got : []){
      if(!r || !r.vin) continue;
      const prev = ships.get(r.vin);
      if(!prev || new Date(r.updatedDate || 0) >= new Date(prev.updatedDate || 0)) ships.set(r.vin, r);
    }
  }
  console.log(`  shipment records: ${ships.size}`);

  const cars = await pool([...ships.entries()].map(([vin, rec]) => ({ vin, rec })), 10, async t => {
    const d = await call(`/getVehicleStatusLogByVinWithPdiTask?vin=${t.vin}&vehicleShipmentId=${t.rec.id}`);
    const es = (d && d.vehicleStatusLogs) || [];
    const vri = es.find(e => /receiving inspection completed/i.test(e.vehicleCogStatusName || ""));
    const svc = vri && es.find(e => e !== vri
      && /^\s*in service\s*$/i.test(String(e.vehicleCogStatusName || ""))
      && same(e.createdDate, vri.createdDate));
    return { vin: t.vin, hasVri: Boolean(vri), A: Boolean(svc),
             B: t.rec.vriPassedDate == null, passedAt: t.rec.vriPassedDate,
             vriAt: vri ? vri.createdDate : null, by: vri ? vri.createdBy : null };
  });

  const ok = cars.filter(c => c && !c.error);
  const errs = cars.length - ok.length;
  const noVri = ok.filter(c => !c.hasVri);
  const scored = ok.filter(c => c.hasVri);

  const both = scored.filter(c => c.A && c.B).length;
  const onlyA = scored.filter(c => c.A && !c.B);
  const onlyB = scored.filter(c => !c.A && c.B);
  const neither = scored.filter(c => !c.A && !c.B).length;

  console.log(`\n══ agreement over ${scored.length} cars with a completed VRI (${errs} errors, ${noVri.length} no VRI yet) ══`);
  console.log(`  both say FAILED                  : ${both}`);
  console.log(`  timestamp-pair only (A, not B)   : ${onlyA.length}`);
  console.log(`  vriPassedDate null only (B not A): ${onlyB.length}`);
  console.log(`  both say passed                  : ${neither}`);

  for(const c of onlyA.slice(0, 10)) console.log(`    A-only ${c.vin} vriAt=${c.vriAt} passedAt=${c.passedAt}`);
  for(const c of onlyB.slice(0, 10)) console.log(`    B-only ${c.vin} vriAt=${c.vriAt} by=${c.by}`);

  /* Cars with no VRI entry yet — do they have a null vriPassedDate too? That is
     the false-positive trap for using B on its own. */
  const noVriNull = noVri.filter(c => c.B).length;
  console.log(`\n  cars with NO completed VRI whose vriPassedDate is also null: ${noVriNull}/${noVri.length}`);
  console.log(`  → B alone cannot be used without excluding not-yet-inspected cars.`);

  /* Does vriPassedDate equal the VRI log timestamp on passes? If so the field
     is written by the same action and the two are one source, not two. */
  const passes = scored.filter(c => !c.A && !c.B);
  const eq = passes.filter(c => same(c.passedAt, c.vriAt)).length;
  console.log(`\n  on passes, vriPassedDate === VRI log timestamp: ${eq}/${passes.length}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

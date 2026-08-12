#!/usr/bin/env node
/* Second audit: how much is the window figure at the mercy of when the car
   happened to report?

   The measurement takes the last sample at or before handoff + 12 h. If the
   car went quiet at +1 h and said nothing more until +20 h, that figure is
   whatever it had driven by +1 h — and any driving in the remaining eleven
   hours of the window is invisible. This measures how often that happens and
   how much is at stake when it does.

     blind h     hours between the last in-window sample and the window edge
     ambiguous   miles between the last in-window sample and the first one
                 after the edge — driving that happened somewhere in between,
                 partly inside the window and partly outside it

   Usage: node audit-edge.js [date] [trt] [limit]                          */

const L = require("./lib.js");

const DATE  = process.argv[2] || "2026-08-04";
const TRT   = process.argv[3] || "17589";
const LIMIT = Number(process.argv[4] || 30);

const H = 3600000;

(async () => {
  await L.ensureSession();

  const [from, to] = L.dayRangeEpoch(DATE);
  const page = await L.callTool("tesladex_search", {
    query : `delivery_date_epoch:[${from} TO ${to}] AND vehicle_routing_location:${Number(TRT)}`,
    fields: ["vin", "delivery_date_epoch"],
    size  : LIMIT,
    sort  : "delivery_date_epoch:asc"
  });
  if(!page || page.error) throw new Error("tesladex: " + (page && page.error));

  const cars = (page.results || []).filter(r => r.vin && r.delivery_date_epoch != null);
  const out = [];

  for(const car of cars){
    const t0   = car.delivery_date_epoch * 1000;
    const ends = t0 + 12 * H;

    const data = await L.callTool("device_historical_vitals", {
      device_id: car.vin,
      fields   : ["GUI_fsdUserTotalMiles"],
      hours    : Math.min(Math.ceil((Date.now() - t0) / H) + 36, 336),
      asc      : true
    });

    const mi = ((data && data.rows) || [])
      .filter(r => r.GUI_fsdUserTotalMiles != null)
      .map(r => ({ t: Date.parse(r.time + "Z"), v: r.GUI_fsdUserTotalMiles }))
      .sort((a, b) => a.t - b.t);
    if(!mi.length) continue;

    const base   = (mi.filter(r => r.t <= t0).pop()) || mi[0];
    const inWin  = mi.filter(r => r.t > t0 && r.t <= ends);
    const last   = (mi.filter(r => r.t <= ends).pop());
    const after  = mi.filter(r => r.t > ends);
    const miles  = last ? Number((last.v - base.v).toFixed(3)) : null;

    out.push({
      vin   : car.vin,
      miles,
      n     : inWin.length,
      blindH: last ? Number(((ends - last.t) / H).toFixed(1)) : null,
      amb   : after.length && last ? Number((after[0].v - last.v).toFixed(3)) : null,
      gapH  : after.length && last ? Number(((after[0].t - last.t) / H).toFixed(1)) : null
    });
  }

  console.log(`${out.length} cars · ${DATE} · TRT ${TRT}\n`);
  console.log("VIN                 window mi  samples  blind h   ambiguous mi  over gap");
  console.log("-".repeat(78));
  for(const r of out){
    console.log(
      r.vin + "  " +
      String(r.miles).padStart(9) + "  " +
      String(r.n).padStart(7) + "  " +
      String(r.blindH).padStart(7) + "  " +
      String(r.amb == null ? "-" : r.amb).padStart(13) + "  " +
      String(r.gapH == null ? "-" : r.gapH + "h").padStart(8) +
      (r.n === 0 ? "   ← NO in-window samples" : "") +
      (r.blindH >= 4 ? "   ← long blind tail" : "")
    );
  }

  const blind = out.map(r => r.blindH).filter(v => v != null).sort((a, b) => a - b);
  const amb   = out.filter(r => r.amb != null && r.amb > 0.05);
  console.log("\n" + "=".repeat(70));
  console.log(`cars with no in-window samples : ${out.filter(r => r.n === 0).length}/${out.length}`);
  console.log(`blind tail  median ${blind[Math.floor(blind.length/2)]}h · ` +
              `p90 ${blind[Math.floor(blind.length*0.9)]}h · max ${blind[blind.length-1]}h`);
  console.log(`cars with ambiguous miles at the edge : ${amb.length}/${out.length}`);
  if(amb.length){
    const v = amb.map(r => r.amb).sort((a, b) => a - b);
    console.log(`  median ${v[Math.floor(v.length/2)]} mi · max ${v[v.length-1]} mi ` +
                `(excluded from the figure — the cut is conservative)`);
  }
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

#!/usr/bin/env node
/* Audit: is the reported figure really "FSD miles in the 12 h after the car
   became delivered"?

   Deliberately does not call fsdMilesFor. It pulls the raw telemetry and
   recomputes the delta from scratch, so agreement means two independent
   implementations agree rather than one implementation agreeing with itself.

   For each car it reports:
     recomputed    the delta this script derives, vs what the tracker returns
     anchor        tesladex delivery_date_epoch — what the window starts from
     flag flip     when the car's own `delivered` vital goes no → yes
     before        FSD miles accrued in the 24 h BEFORE the anchor
                   (should be ~0: that would be lot moves leaking in)
     pre-flag      FSD miles accrued between the anchor and the flag flip
     at edge       whether the car was mid-drive when the window closed

   Usage: node audit-window.js [date] [trt] [limit]                        */

const L = require("./lib.js");

const DATE  = process.argv[2] || "2026-08-04";
const TRT   = process.argv[3] || "17589";
const LIMIT = Number(process.argv[4] || 12);

const H = 3600000;
const iso = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const hhmm = min => (min < 0 ? "-" : "") + Math.floor(Math.abs(min) / 60) + "h" +
                    String(Math.abs(min) % 60).padStart(2, "0");

(async () => {
  await L.ensureSession();

  const [from, to] = L.dayRangeEpoch(DATE);
  const page = await L.callTool("tesladex_search", {
    query : `delivery_date_epoch:[${from} TO ${to}] AND vehicle_routing_location:${Number(TRT)}`,
    fields: ["vin", "delivery_date_epoch"],
    size  : LIMIT,
    sort  : "delivery_date_epoch:asc"
  });

  // Loudly, not as an empty result set — a silent zero here would read as
  // "nothing was delivered" and quietly pass the audit.
  if(!page || page.error) throw new Error("tesladex: " + (page && page.error));

  const cars = (page.results || []).filter(r => r.vin && r.delivery_date_epoch != null);
  console.log(`${cars.length} cars · ${DATE} · TRT ${TRT}\n`);

  const out = [];

  for(const car of cars){
    const t0    = car.delivery_date_epoch * 1000;
    const ends  = t0 + 12 * H;
    const hours = Math.ceil((Date.now() - t0) / H) + 36;

    const data = await L.callTool("device_historical_vitals", {
      device_id: car.vin,
      fields   : ["GUI_fsdUserTotalMiles", "delivered"],
      hours    : Math.min(hours, 336),
      asc      : true
    });

    const rows = ((data && data.rows) || [])
      .map(r => ({ t: Date.parse(r.time + "Z"),
                   v: r.GUI_fsdUserTotalMiles,
                   d: r.delivered }))
      .sort((a, b) => a.t - b.t);

    const mi = rows.filter(r => r.v != null);
    if(!mi.length){ console.log(`${car.vin}  no samples`); continue; }

    // Independent recomputation of the tracker's definition.
    const before = mi.filter(r => r.t <= t0);
    const base   = before.length ? before[before.length - 1] : mi[0];
    const within = mi.filter(r => r.t <= ends);
    const last   = within[within.length - 1];
    const mine   = last ? Number((last.v - base.v).toFixed(3)) : null;

    // What the tracker itself says.
    const theirs = await L.fsdMilesFor(car.vin, new Date(t0).toISOString());

    // The car's own delivered flag.
    const flags = rows.filter(r => r.d != null);
    const firstYes = flags.find(r => r.d === "yes");
    const lastNo   = [...flags].reverse().find(r => r.d === "no" && (!firstYes || r.t < firstYes.t));
    const flipMin  = firstYes ? Math.round((firstYes.t - t0) / 60000) : null;

    // Leakage before the anchor: did FSD miles move in the 24 h before it?
    const dayBefore = mi.filter(r => r.t >= t0 - 24 * H && r.t <= t0);
    const beforeMi  = dayBefore.length
      ? Number((dayBefore[dayBefore.length - 1].v - dayBefore[0].v).toFixed(3)) : 0;

    // Miles banked between the anchor and the car agreeing it is delivered.
    let preFlag = null;
    if(firstYes){
      const upto = mi.filter(r => r.t <= firstYes.t);
      if(upto.length) preFlag = Number((upto[upto.length - 1].v - base.v).toFixed(3));
    }

    // Was it mid-drive at the edge? Compare the last in-window reading with
    // the next one after the window closed.
    const after = mi.filter(r => r.t > ends);
    const edge  = after.length && last
      ? Number((after[0].v - last.v).toFixed(3)) : null;

    out.push({ vin: car.vin, t0, base, last, mine, theirs, flipMin, firstYes,
               lastNo, beforeMi, preFlag, edge, nextAfter: after[0] || null });
  }

  console.log("VIN                anchor (UTC)         recomputed  tracker  agree  " +
              "baseline gap  flag flip   pre-flag mi  before mi  edge");
  console.log("-".repeat(132));

  for(const r of out){
    const agree = r.mine != null && r.theirs.miles != null &&
                  Math.abs(r.mine - r.theirs.miles) < 0.0005;
    console.log(
      r.vin + "  " +
      iso(r.t0) + "  " +
      String(r.mine).padStart(10) + "  " +
      String(r.theirs.miles).padStart(7) + "  " +
      (agree ? "  yes" : "  NO ") + "  " +
      String(Math.round((r.t0 - r.base.t) / 60000) + "m").padStart(12) + "  " +
      String(r.flipMin == null ? "never" : hhmm(r.flipMin)).padStart(9) + "  " +
      String(r.preFlag == null ? "-" : r.preFlag).padStart(11) + "  " +
      String(r.beforeMi).padStart(9) + "  " +
      String(r.edge == null ? "-" : r.edge).padStart(6)
    );
  }

  const agreed = out.filter(r => r.mine != null && r.theirs.miles != null &&
                                 Math.abs(r.mine - r.theirs.miles) < 0.0005).length;
  const flips  = out.filter(r => r.flipMin != null).map(r => r.flipMin).sort((a, b) => a - b);
  const leaked = out.filter(r => r.beforeMi > 0.05);
  const preAll = out.filter(r => r.preFlag != null && r.preFlag > 0.05);

  console.log("\n" + "=".repeat(60));
  console.log(`recompute agrees with tracker : ${agreed}/${out.length}`);
  if(flips.length){
    console.log(`delivered-flag flip vs anchor : median ${hhmm(flips[Math.floor(flips.length/2)])
      }, min ${hhmm(flips[0])}, max ${hhmm(flips[flips.length-1])} (n=${flips.length})`);
    console.log(`  flips BEFORE the anchor     : ${flips.filter(f => f < 0).length}`);
    console.log(`  flips AFTER the anchor      : ${flips.filter(f => f >= 0).length}`);
  }
  console.log(`FSD miles in 24 h before anchor: ${leaked.length} car(s) over 0.05 mi`);
  if(leaked.length) leaked.forEach(r => console.log(`  ${r.vin}  ${r.beforeMi} mi`));
  console.log(`miles banked before flag flip  : ${preAll.length} car(s) over 0.05 mi`);
  if(preAll.length){
    const vals = preAll.map(r => r.preFlag).sort((a, b) => a - b);
    console.log(`  median ${vals[Math.floor(vals.length/2)]} mi, max ${vals[vals.length-1]} mi`);
  }
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

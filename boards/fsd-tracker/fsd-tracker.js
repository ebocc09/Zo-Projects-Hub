#!/usr/bin/env node
/* FSD Tracker — CLI.

   Writes a CSV of FSD miles driven in the hours after delivery — the window
   is `windowHours` in config.json, 12 by default. The measurement itself
   lives in lib.js, shared with the dashboard so the two cannot disagree.

   Usage:
     node fsd-tracker.js                          today
     node fsd-tracker.js 2026-08-01               one date
     node fsd-tracker.js 2026-07-26..2026-08-01   inclusive range
     node fsd-tracker.js today out.csv            explicit output path

     --trt=17589      which centre (else config.json)
     --advanced       add the reference number and advisor from Intrepid
     --basic          force Garage-only even if advanced is the saved default

   Basic is Garage alone and needs no credential. A day takes under a minute,
   nearly all of it reading mileage curves. */

"use strict";

const fs   = require("fs");
const path = require("path");
const {
  CONFIG, resolvePath, collectReport, summarise, byHost, savedTrtId,
  expandDates, isDate, windowHours
} = require("./lib");

const log  = (...a) => console.log(...a);
const warn = (...a) => console.log("!", ...a);
const pad  = (s, n) => String(s).padEnd(n);

const esc = v => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* Excel keeps the file open and locks it, which cost several runs during
   development. Rather than lose the work, fall back to a suffixed name. */
function writeCsvSafely(target, csv){
  try{
    fs.writeFileSync(target, csv);
    return target;
  }catch(err){
    if(err.code !== "EBUSY" && err.code !== "EPERM") throw err;
    const alt = target.replace(/\.csv$/i, "") + "-" + Date.now() + ".csv";
    fs.writeFileSync(alt, csv);
    warn(`${path.basename(target)} was locked (open in Excel?) — wrote ${path.basename(alt)} instead`);
    return alt;
  }
}

async function main(){
  // Three sources, most specific first: --trt=NNNNN, then whatever the
  // dashboard was last set to, then config.json as a machine-level default.
  // Sharing the dashboard's choice means the two agree without anyone having
  // to set the centre twice. There is no fleet-wide fallback, so an absent
  // TRT is an error rather than a guess.
  const argv = process.argv.slice(2);
  const trtArg = argv.find(a => /^--trt=/.test(a));
  // No flag means the saved setting decides, so the CLI and the dashboard
  // agree by default and either can be overridden per run.
  const mode = argv.includes("--advanced") ? "advanced"
             : argv.includes("--basic")    ? "basic"
             : undefined;
  const args = argv.filter(a => !/^--(trt=|advanced$|basic$)/.test(a));
  const trtId = trtArg ? trtArg.split("=")[1].trim()
              : (savedTrtId() || CONFIG.trtId || null);

  if(!trtId || !/^\d+$/.test(String(trtId))){
    throw new Error('No TRT — pass --trt=17589, choose one in the dashboard, ' +
                    'or set "trtId" in config.json');
  }

  const spec  = args[0] || "today";
  const dates = expandDates(spec);
  if(!dates.length || !dates.every(isDate)){
    throw new Error(`Bad date spec "${spec}" — use YYYY-MM-DD, YYYY-MM-DD..YYYY-MM-DD, or today`);
  }

  const label = dates.length === 1 ? dates[0] : `${dates[0]}_to_${dates[dates.length - 1]}`;
  const out   = args[1]
    ? resolvePath(args[1])
    : path.join(CONFIG.outputDir.replace("~", process.env.USERPROFILE || ""), `fsd-${label}.csv`);

  log(`FSD Tracker — TRT ${trtId}, ${dates.length} date(s): ${label}`);

  let lastTick = 0;

  const { rows, notices, mode: ran } = await collectReport({
    dates, trtId, mode,
    onProgress(p){
      if(p.phase === "scope"){
        // Only cars with no routing location reach this; normally none do.
        const now = Date.now();
        if(now - lastTick < 4000 && p.done !== p.total) return;
        lastTick = now;
        log(`  placing stray cars ${p.done}/${p.total}`);
      }else if(p.phase === "scoped"){
        log(`  ${p.date}: ${p.delivered} at TRT ${trtId} of ${p.national} nationally`);
      }else if(p.phase === "vehicles" && (p.done % 10 === 0 || p.done === p.total)){
        log(`  measuring ${p.done}/${p.total}`);
      }
    }
  });

  if(!rows.length){
    warn("nothing delivered in that window — no file written");
    for(const n of notices) warn(n);
    return;
  }

  /* Basic mode has no reference number and no host, so those columns are
     dropped rather than written empty — a blank column reads as missing data
     rather than as a source that was never consulted. */
  const advanced = ran === "advanced";
  /* The column names the window rather than saying "post_delivery", which
     would read as "ever since" — it is the first N hours and nothing after. */
  const milesCol = `fsd_miles_first_${windowHours()}h`;
  const header = advanced
    ? `reference_number,vin,delivery_date,delivery_host,${milesCol}`
    : `vin,delivery_date,${milesCol}`;

  let csv = header + "\n";
  for(const r of rows){
    const cells = advanced
      ? [r.rn, r.vin, r.date, r.host || r.hostUser || "", r.miles]
      : [r.vin, r.date, r.miles];
    csv += cells.map(esc).join(",") + "\n";
  }
  const written = writeCsvSafely(out, csv);
  const s = summarise(rows);

  log("");
  log(`wrote ${written}`);
  log(`  ${pad("mode", 16)}${ran}${advanced ? "" : "  (no reference number or advisor)"}`);
  log(`  ${pad("vehicles", 16)}${s.vehicles}`);
  log(`  ${pad("resolved", 16)}${s.resolved}${s.failed ? `  (${s.failed} failed)` : ""}`);
  // States the bar it scored against: the figure is settable, so a count on
  // its own does not say what it counted.
  log(`  ${pad("drove FSD", 16)}${s.drove}  (${s.adoption}%, at least ${s.threshold} mi)`);
  log(`  ${pad("total FSD miles", 16)}${s.totalMi}`);
  // Not a footnote: a run of today's deliveries is almost entirely this, and
  // the totals above are a snapshot rather than a result.
  if(s.open){
    warn(`${s.open} car(s) are still inside the ${s.windowHours}h window — those ` +
         `figures will climb. Re-run once the window has closed for final numbers.`);
  }
  if(s.gapMedian != null){
    log(`  ${pad("baseline gap", 16)}median ${s.gapMedian} min, max ${s.gapMax} min`);
    if(s.gapLeaky) warn(`${s.gapLeaky} row(s) have a baseline gap over 60 min — staff driving may be counted`);
  }
  if(s.altCounter){
    warn(`${s.altCounter} car(s) have a stuck FSD odometer and were measured on the ` +
         `backup counter — those rows would otherwise have read zero`);
  }

  /* Per host. `share` is their slice of the day; `fsd` is how many of their
     own cars drove — two different questions, so both are shown with the car
     count beside them to keep a 1-car 100% in proportion. */
  if(advanced){
    const hosts = byHost(rows);
    if(hosts.length){
      log("");
      log(`  ${pad("delivery host", 22)}${pad("cars", 6)}${pad("share", 7)}${pad("drove", 7)}${pad("fsd", 6)}${pad("total mi", 10)}avg mi`);
      for(const h of hosts){
        log(`  ${pad(h.host || "(unknown)", 22)}${pad(h.cars, 6)}${pad(h.share + "%", 7)}` +
            `${pad(h.drove, 7)}${pad(h.fsdRate + "%", 6)}${pad(h.totalMi, 10)}${h.avgMi}`);
      }
    }
  }
  for(const n of notices) warn(n);
  for(const b of rows.filter(r => r.error).slice(0, 5)) warn(`${b.vin || "?"}: ${b.error}`);
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

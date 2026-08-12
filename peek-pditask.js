#!/usr/bin/env node
/* What is in the half of getVehicleStatusLogByVinWithPdiTask that ZO-003
   throws away?

   Deliberately narrow. It calls exactly two endpoints, both of which the
   boards already call on every run, for one vehicle. It prints KEY NAMES and
   value TYPES only — never a value — because the question is "does a
   pre-delivery task block exist and what is it called", and that is answerable
   without reading anyone's data.

   node peek-pditask.js <trtId> <YYYY-MM-DD> */

"use strict";

const https = require("https");
const credstore = require("./credstore");

const HOST = "intrepidapi.tesla.com";
const BASE = "/cogs/api/cogs";

const cookie = credstore.intrepidCookie().value.trim();
if(!cookie){ console.error("No Intrepid cookie — sign in on the Hub."); process.exit(1); }

const trt  = process.argv[2];
const date = process.argv[3];
if(!trt || !date){ console.error("usage: peek-pditask.js <trtId> <YYYY-MM-DD>"); process.exit(1); }

function get(path){
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: BASE + path, method: "GET",
      headers: { Cookie: cookie, Accept: "application/json",
                 "User-Agent": "Mozilla/5.0 (zo-hub peek)" },
      timeout: 25000
    }, res => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => {
        if(res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${b.slice(0,120)}`));
        try { resolve(JSON.parse(b)); } catch(e){ reject(new Error("unparsable: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

/* Key path -> type. No values, ever. Arrays collapse to their first element
   so a 40-row list prints as one shape. */
function keyTypes(v, prefix = "", out = new Map()){
  if(Array.isArray(v)){
    out.set(prefix + "[]", `array(${v.length})`);
    if(v.length) keyTypes(v[0], prefix + "[]", out);
    return out;
  }
  if(v && typeof v === "object"){
    for(const k of Object.keys(v)) keyTypes(v[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.set(prefix, v === null ? "null" : typeof v);
  return out;
}

(async () => {
  const appts = await get(
    `/getTssAppointmentsByDate?trtId=${encodeURIComponent(trt)}&date=${encodeURIComponent(date)}&searchQuery=`);
  const rows = Array.isArray(appts) ? appts : [];
  console.log(`appointments on ${date} at TRT ${trt}: ${rows.length}`);

  const pick = rows.find(r => r.vin && r.cogInfo && r.cogInfo.id);
  if(!pick){ console.log("no row with both a VIN and a shipment id — nothing to peek at"); return; }
  console.log("using one vehicle (VIN withheld)\n");

  console.log("── appointment row: keys ──");
  for(const [k, t] of keyTypes(pick)) console.log(`  ${k}: ${t}`);

  const d = await get(`/getVehicleStatusLogByVinWithPdiTask`
    + `?vin=${encodeURIComponent(pick.vin)}`
    + `&vehicleShipmentId=${encodeURIComponent(pick.cogInfo.id)}`);

  console.log("\n── getVehicleStatusLogByVinWithPdiTask: top-level keys ──");
  for(const k of Object.keys(d)) {
    const v = d[k];
    console.log(`  ${k}: ${Array.isArray(v) ? `array(${v.length})`
      : v === null ? "null" : typeof v}`);
  }

  console.log("\n── everything that is NOT vehicleStatusLogs ──");
  const rest = { ...d };
  delete rest.vehicleStatusLogs;
  const kt = keyTypes(rest);
  if(!kt.size) console.log("  (nothing — the endpoint only returns the log)");
  for(const [k, t] of kt) console.log(`  ${k}: ${t}`);
})().catch(e => { console.error("failed:", e.message); process.exit(1); });

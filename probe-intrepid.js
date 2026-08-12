#!/usr/bin/env node
/* Read-only Intrepid endpoint probe.

   GET only, one request at a time, and it prints status codes and the SHAPE of
   what comes back — key names, array lengths — never the values. Customer data
   is the thing this API is full of, and a probe's job is to find out what
   exists, not to page it into a terminal.

   Usage:  node probe-intrepid.js discovery
           node probe-intrepid.js paths <file-of-paths>
           node probe-intrepid.js one <path>                 # shape only
           node probe-intrepid.js one <path> --keys-deep     # nested key names */

"use strict";

const https = require("https");
const credstore = require("./credstore");

const HOST = "intrepidapi.tesla.com";
const COGS = "/cogs/api/cogs";
const LOC  = "/cogs/api/location";

const cookie = credstore.intrepidCookie().value.trim();
if(!cookie){ console.error("No Intrepid cookie in the store — sign in on the Hub."); process.exit(1); }

function get(path){
  return new Promise(resolve => {
    const req = https.request({
      hostname: HOST, path, method: "GET",
      headers: { Cookie: cookie, Accept: "application/json",
                 "User-Agent": "Mozilla/5.0 (zo-hub probe)" },
      timeout: 20000
    }, res => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => resolve({ status: res.statusCode, ct: res.headers["content-type"] || "", body: b }));
    });
    req.on("error", e => resolve({ status: 0, ct: "", body: String(e.message) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, ct: "", body: "timeout" }); });
    req.end();
  });
}

/* Key names only, recursively, with array element counts. Never a value. */
function shape(v, depth = 0, maxDepth = 2){
  if(v === null) return "null";
  if(Array.isArray(v)){
    if(!v.length) return "[]";
    return `[${v.length} × ${depth < maxDepth ? shape(v[0], depth + 1, maxDepth) : "…"}]`;
  }
  if(typeof v === "object"){
    const k = Object.keys(v);
    if(depth >= maxDepth) return `{${k.length} keys}`;
    return "{" + k.slice(0, 40).map(x => x).join(", ") + (k.length > 40 ? ", …" : "") + "}";
  }
  return typeof v;
}

const DISCOVERY = [
  "/cogs/v3/api-docs", "/cogs/v2/api-docs", "/cogs/swagger-ui/index.html",
  "/cogs/swagger-resources", "/cogs/openapi.json", "/cogs/actuator",
  "/cogs/actuator/mappings", "/v3/api-docs", "/swagger-ui/index.html",
  COGS, LOC, "/cogs/api"
];

(async () => {
  const mode = process.argv[2] || "discovery";

  const report = async path => {
    const r = await get(path);
    let note = "";
    if(r.status === 200){
      if(/json/.test(r.ct)){
        try { note = shape(JSON.parse(r.body)); }
        catch { note = `${r.body.length}b unparsable`; }
      } else {
        note = `${r.ct.split(";")[0]} ${r.body.length}b`;
      }
    } else if(r.status === 0){
      note = r.body;
    } else {
      note = r.body.slice(0, 90).replace(/\s+/g, " ");
    }
    console.log(String(r.status).padStart(3), path.padEnd(58), note.slice(0, 150));
    return r;
  };

  if(mode === "discovery"){
    for(const p of DISCOVERY) await report(p);
    return;
  }

  if(mode === "paths"){
    const list = require("fs").readFileSync(process.argv[3], "utf8")
      .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
    for(const p of list) await report(p.startsWith("/cogs") ? p : COGS + p);
    return;
  }

  if(mode === "one"){
    const p = process.argv[3];
    const r = await get(p.startsWith("/cogs") ? p : COGS + p);
    console.log("status", r.status, r.ct);
    if(/json/.test(r.ct)){
      const j = JSON.parse(r.body);
      const deep = process.argv.includes("--keys-deep");
      console.log(JSON.stringify(deep ? keysDeep(j) : shape(j, 0, 3), null, 1));
    } else {
      console.log(r.body.slice(0, 400));
    }
    return;
  }
})();

/* Every key path present, no values. */
function keysDeep(v, prefix = "", out = new Set()){
  if(Array.isArray(v)){ if(v.length) keysDeep(v[0], prefix + "[]", out); return [...out]; }
  if(v && typeof v === "object"){
    for(const k of Object.keys(v)) keysDeep(v[k], prefix ? prefix + "." + k : k, out);
    return [...out];
  }
  out.add(`${prefix}: ${v === null ? "null" : typeof v}`);
  return [...out];
}

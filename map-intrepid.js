#!/usr/bin/env node
/* Enumerate Intrepid's API surface from the SPA that calls it.

   The API self-documents nowhere — no swagger, no actuator, and the root's
   /v3/api-docs is behind a different auth realm than the cogs cookie. But the
   front end has to name every endpoint it uses, so its JS bundles are an
   accurate, complete and entirely read-only index of the API.

   Downloads the SPA's scripts and pulls out anything shaped like a route.
   Nothing is called — this only lists what exists to be called.            */

"use strict";

const https = require("https");
const credstore = require("./credstore");

const SPA = "https://intrepid.tesla.com/cogs";
const cookie = credstore.intrepidCookie().value.trim();

function get(url){
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { Cookie: cookie, Accept: "*/*",
                 "User-Agent": "Mozilla/5.0 (zo-hub map)" },
      timeout: 30000
    }, res => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", e => resolve({ status: 0, body: String(e.message), headers: {} }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout", headers: {} }); });
    req.end();
  });
}

(async () => {
  const page = await get(SPA);
  console.log("SPA", page.status, (page.headers["content-type"] || "").split(";")[0],
              page.body.length + "b");
  if(page.status !== 200){ console.log(page.body.slice(0, 300)); return; }

  const srcs = [...page.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  const css  = [...page.body.matchAll(/<link[^>]+href="([^"]+\.js)"/g)].map(m => m[1]);
  const all  = [...new Set([...srcs, ...css])]
    .map(s => s.startsWith("http") ? s : new URL(s, SPA + "/").href);

  console.log("scripts:", all.length);

  const routes = new Set();
  for(const url of all){
    const r = await get(url);
    if(r.status !== 200) { console.log("  skip", r.status, url.slice(-60)); continue; }
    console.log("  read", (r.body.length / 1024 | 0) + "kb", url.slice(-70));

    /* Endpoint-shaped string literals. Intrepid's routes are verb-first
       camelCase under the api base, so this keys on that rather than on any
       path containing a slash — which in a bundle is mostly CSS and icons. */
    for(const m of r.body.matchAll(/["'`]\/((?:get|bulk|search|list|find|fetch|save|create|update|post|put|delete|upload|download|export|falcon|is|has|validate|generate|send|print)[A-Za-z0-9_]{2,})["'`]/g)){
      routes.add("/" + m[1]);
    }
    // Template-literal routes: `/getFoo/${id}` and `/getFoo?x=`
    for(const m of r.body.matchAll(/["'`]\/((?:get|bulk|search|list|find|fetch|save|create|update|upload|download|export|falcon|print)[A-Za-z0-9_]{2,})[/?]/g)){
      routes.add("/" + m[1]);
    }
    // Anything under an api/<service>/ base, to reveal sibling services.
    for(const m of r.body.matchAll(/["'`]([^"'`]*\/api\/[a-z][a-zA-Z0-9_-]{2,})["'`]/g)){
      routes.add("BASE " + m[1]);
    }
  }

  const bases = [...routes].filter(r => r.startsWith("BASE ")).sort();
  const paths = [...routes].filter(r => !r.startsWith("BASE ")).sort();

  console.log("\n── service bases (" + bases.length + ") ──");
  for(const b of bases) console.log("  " + b.slice(5));

  console.log("\n── endpoints (" + paths.length + ") ──");
  for(const p of paths) console.log("  " + p);
})();

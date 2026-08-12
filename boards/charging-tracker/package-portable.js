#!/usr/bin/env node
/* Builds the send-to-a-colleague zip: the tracked source plus a Node runtime,
   so the recipient installs nothing and is never prompted for anything. Unzip,
   double-click, done — which matters because Node cannot be installed on a
   corp device without admin rights.

   Source comes from `git archive HEAD`, not from the working directory. That
   is the whole safety argument, and it matters more here than in the sibling
   dashboards: this folder holds .tokens.json and .tokens.eng.json (Garage
   OAuth for BOTH environments), .client.json and .client.eng.json, .teams.json
   and .garage.json — which carries live Garage session cookies that are your
   full identity. The archive contains exactly what is tracked, so no
   overlooked glob can sweep any of them in. Uncommitted edits are therefore
   NOT included, which this says out loud rather than surprising anyone. The
   staged tree is then re-checked against the same pattern server.js refuses to
   serve, because "it should be impossible" is not the same as "it was
   checked".

   The runtime is whichever Node is executing this script, via process.execPath
   — no path guessing, and it is by definition a working binary. It also lifts
   the recipient over the Node 20 floor the one-click Garage sign-in needs.
   Node's LICENSE ships beside it because the MIT terms require it.

     node package-portable.js [outDir]        default: ~/Desktop            */

"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const log  = (...a) => console.log(...a);

const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), "Desktop");

const stamp = new Date().toISOString().slice(0, 10);
const NAME  = `charging-tracker-portable-${stamp}`;
const zip   = path.join(outDir, NAME + ".zip");

const rmrf = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
const mb   = n => (n / 1048576).toFixed(1) + " MB";
const psq  = s => "'" + String(s).replace(/'/g, "''") + "'";

function walk(d, hit = []){
  for(const e of fs.readdirSync(d, { withFileTypes: true })){
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, hit) : hit.push(p);
  }
  return hit;
}

const dirSize = d => walk(d).reduce((n, f) => n + fs.statSync(f).size, 0);

/* ── 1. tracked source only ── */

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ct-pack-"));
const root  = path.join(stage, "charging-tracker");
fs.mkdirSync(root, { recursive: true });

let dirty = "";
try { dirty = execFileSync("git", ["status", "--porcelain"], { cwd: HERE, encoding: "utf8" }).trim(); }
catch { /* not a git checkout; the archive step below will fail loudly */ }
if(dirty){
  log("! uncommitted changes are NOT in this build — commit them first if they should be:");
  for(const line of dirty.split("\n").slice(0, 10)) log("   " + line);
  log("");
}

/* Round-trip through a zip rather than a tar: the `tar` first on PATH here is
   GNU tar from git-bash, which reads a leading "C:" as a remote host and dies
   with "Cannot connect to C". PowerShell is already needed for the final
   archive, so this adds no new tool. */
const srcZip = path.join(stage, "src.zip");
execFileSync("git", ["archive", "--format=zip", "-o", srcZip, "HEAD"], { cwd: HERE });
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Expand-Archive -Path ${psq(srcZip)} -DestinationPath ${psq(root)} -Force`]);
fs.unlinkSync(srcZip);
log(`source: ${fs.readdirSync(root).length} tracked files`);

/* The same pattern server.js refuses to serve. If this ever fires, something
   is wrong with .gitignore and the build must not go out. */
const SECRET_FILE = /(^|[\\/])\.(tokens|client|teams|garage)(\.[a-z0-9]+)?\.json$/i;
const leaked = walk(root).filter(f => SECRET_FILE.test(f));
if(leaked.length){
  rmrf(stage);
  console.error("\nREFUSING TO BUILD — credential files reached the staging tree:");
  for(const f of leaked) console.error("   " + path.relative(root, f));
  console.error("\nCheck .gitignore, and `git rm --cached` anything already tracked.\n");
  process.exit(1);
}
log("checked: no credential files in the archive");

/* ── 2. the runtime ── */

const runtime = path.join(root, "runtime");
fs.mkdirSync(runtime, { recursive: true });

const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, path.join(runtime, path.basename(nodeExe)));
log(`runtime: ${path.basename(nodeExe)} ${process.version} ${process.arch} — ${
      mb(fs.statSync(nodeExe).size)}`);

// MIT requires the licence to travel with the binary.
const lic = path.join(path.dirname(nodeExe), "LICENSE");
if(fs.existsSync(lic)){
  fs.copyFileSync(lic, path.join(runtime, "LICENSE-nodejs.txt"));
}else{
  log("! Node's LICENSE was not found beside the binary — add it by hand before sending");
}

/* ── 3. a note for whoever opens the zip ── */

fs.writeFileSync(path.join(root, "READ ME FIRST.txt"), `Charging Tracker
================

A Supercharging dashboard: enter VINs, watch each car's charge level climb, and
get told the moment one reaches its target — or is finished and still sitting
on the charger.

TO RUN
------
  Double-click  "start-dashboard.bat"

That opens http://localhost:3118 in your browser. Close the black window to
stop it. Nothing is installed and no admin rights are needed — Node is bundled
in the runtime folder.

Windows may say "Windows protected your PC" the first time, because the folder
came out of a downloaded zip. Click "More info" then "Run anyway". It says that
about anything arriving this way; it has not detected a problem.

Windows, 64-bit only. Keep the folder together; the runtime folder is not
optional.

FIRST RUN
---------
You must be on the Tesla network or VPN.

1. A browser tab opens asking you to sign in to Garage. That is Bouncer, the
   normal Tesla sign-in. This copy registers itself as its own OAuth client the
   first time; nothing is shared with whoever sent you this.
2. Back on the dashboard, paste one or more VINs and press Monitor.

You see exactly the vehicles your own Garage permissions allow. There are no
shared credentials in this zip — the sender's tokens are not in it, and cannot
be: the build is made from tracked files only, and refuses to run if a
credential file ever reaches it.

LIVE READINGS (optional)
------------------------
By default everything reads Garage's cached snapshots, which trail a charging
car by 8-12 minutes. For real-time readings:

  Admin (top right, code 226565) > Live vitals > Sign in

A separate Tesla sign-in window opens; sign in there and it connects itself.
No DevTools, nothing to copy. It is off until you do this.

ALERTS
------
When a car reaches its target you get an alert, and this is ON out of the box:
with nothing configured it hands an email to your local Outlook, addressed to
you. Nothing to set up, and nothing leaves your machine to get there.

  Admin > Alerts

Paste a Power Automate webhook URL there to post cards into Teams instead of
emailing, or hit Mute to stop alerts entirely while still keeping your target
configured.

Your tokens, settings and monitored VINs stay inside this folder — delete it and
nothing of this is left. The one thing kept elsewhere is the live-vitals sign-in
window, which needs its own separate browser profile and puts it under
%LOCALAPPDATA%\\cookie-grabber-profiles. It is only created if you use it.

Full detail — every setting, how charging is detected, why USOE and not SOC —
is in README.md.
`.replace(/\n/g, "\r\n"));

/* ── 4. zip it ── */

log(`staged: ${mb(dirSize(root))} uncompressed`);
rmrf(zip);
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Compress-Archive -Path ${psq(root)} -DestinationPath ${psq(zip)} -CompressionLevel Optimal`],
  { stdio: "inherit" });
rmrf(stage);

log("");
log(`wrote ${zip}`);
log(`      ${mb(fs.statSync(zip).size)}`);
log("");
log("Note: many mail filters strip zips containing an .exe. If it bounces,");
log("share it through OneDrive or Teams instead.");

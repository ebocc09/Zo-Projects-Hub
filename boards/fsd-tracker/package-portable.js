#!/usr/bin/env node
/* Builds the send-to-a-colleague zip: the tracked source plus a Node runtime,
   so the recipient installs nothing.

   Source comes from `git archive HEAD`, not from the working directory. That
   is the whole safety argument — the archive contains exactly what is tracked,
   so the gitignored credential and cache files (.connections.json with a live
   session cookie, .staff-cache.json with real names) cannot be swept in by an
   overlooked glob. Uncommitted edits are therefore NOT included, which the
   script says out loud rather than surprising anyone.

   The runtime is whichever Node is executing this script, via process.execPath
   — no path guessing, and it is by definition a working binary. Node's LICENSE
   ships beside it because the MIT terms require it.

     node package-portable.js [outDir]        default: ~/Desktop            */

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const log  = (...a) => console.log(...a);

const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), "Desktop");

const stamp = new Date().toISOString().slice(0, 10);
const NAME  = `fsd-tracker-portable-${stamp}`;
const zip   = path.join(outDir, NAME + ".zip");

const rmrf = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
const mb   = n => (n / 1048576).toFixed(1) + " MB";

function dirSize(d){
  let total = 0;
  for(const e of fs.readdirSync(d, { withFileTypes: true })){
    const p = path.join(d, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/* ── 1. tracked source only ── */

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fsd-pack-"));
const root  = path.join(stage, "fsd-tracker");
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
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Expand-Archive -Path ${psq(srcZip)} -DestinationPath ${psq(root)} -Force`]);
fs.unlinkSync(srcZip);
log(`source: ${fs.readdirSync(root).length} tracked files`);

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

// The note quotes a URL, so take the port from the same place the launcher and
// the server do rather than repeating 3120 in a third spot.
let notePort = 3120;
try { notePort = Number(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).port) || 3120; }
catch { /* archived config unreadable — 3120 is what the server would fall back to anyway */ }

fs.writeFileSync(path.join(root, "READ ME FIRST.txt"), `FSD Tracker
===========

How far customers drive on Full Self-Driving AFTER taking delivery.

TO RUN
------
  Double-click  "Start FSD Tracker.cmd"

That opens http://localhost:${notePort} in your browser. Close the black window to
stop it. Nothing is installed — Node is bundled in the runtime folder.

Windows, 64-bit only. Keep the folder together; the runtime folder is not
optional.

If Windows shows "Windows protected your PC", the zip arrived with a download
mark on it. Right-click the ZIP first, Properties, tick Unblock, then extract
again. If it still refuses, your machine blocks unsigned programs and IT has
to allow it — nothing in the folder can work around that.

IF PORT ${notePort} IS ALREADY TAKEN
${"-".repeat(("IF PORT " + notePort + " IS ALREADY TAKEN").length)}
Open config.json in Notepad and change "port" to something else, e.g. 3121.
The launcher reads that too, so the browser follows.

FIRST RUN
---------
1. Open Admin (top right). The code is in config.json as defaultAdminPassword.
2. Sources > "Sign in to Garage". A Tesla sign-in tab opens; it comes straight
   back. That is the only credential basic mode needs, and it is remembered.
3. Close Admin and pick your delivery centre from the button in the top bar.
   It is remembered until you change it.

Nothing here reads or writes anything outside this folder.

TWO MODES (Admin > Sources)
---------------------------
  Basic     Garage only. VIN, delivery date and time, model, FSD miles.
  Advanced  Adds Intrepid for the reference number and the delivery host, and
            unlocks the per-host leaderboard and filter. Press "Connect to
            Intrepid" and it fetches the cookie itself.

Full detail, including why the numbers mean what they mean, is in README.md.
`.replace(/\n/g, "\r\n"));

/* ── 4. zip it ── */

log(`staged: ${mb(dirSize(root))} uncompressed`);
rmrf(zip);
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Compress-Archive -Path '${root.replace(/'/g, "''")}' -DestinationPath '${
    zip.replace(/'/g, "''")}' -CompressionLevel Optimal`], { stdio: "inherit" });
rmrf(stage);

log("");
log(`wrote ${zip}`);
log(`      ${mb(fs.statSync(zip).size)}`);
log("");
log("Note: many mail filters strip zips containing an .exe. If it bounces,");
log("share it through OneDrive or Teams instead.");

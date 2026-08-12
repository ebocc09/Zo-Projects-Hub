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
const NAME  = `dvp-scorecard-portable-${stamp}`;
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
const root  = path.join(stage, "dvp-scorecard");
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

fs.writeFileSync(path.join(root, "READ ME FIRST.txt"), `DVP Scorecard
=============

Credits each delivery cleanliness score to whoever put the car into "Finished
Goods" — a leaderboard of who sends out the cleanest cars.

TO RUN
------
  Double-click  "Start DVP Scorecard.cmd"

That opens http://localhost:3130 in your browser. Close the black window to
stop it. Nothing is installed — Node is bundled in the runtime folder.

Windows, 64-bit only. Keep the folder together; the runtime folder is not
optional.

FIRST RUN
---------
1. Open Admin (top right). The code is in config.json as defaultAdminPassword.
2. "Connect" to Intrepid. First time: press "Sign-in window", sign in to Tesla
   there, then press "Connect". It is remembered.
3. Close Admin and set your delivery centre (TRT) from the button top-right.

Then just drag a survey export (.xlsx) onto the page. Only two columns are
read: the Reference Number and the score.

Nothing here reads or writes anything outside this folder.

HOW IT WORKS
------------
The xlsx gives RN + score. Intrepid turns each RN into a VIN, then reads that
car's status log for who set "Finished Goods" — the prep person. Every score is
credited to that person and the board ranks them cleanest to dirtiest.

Full detail is in README.md.
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

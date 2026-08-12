#!/usr/bin/env node
/* Builds the send-to-a-colleague zip for the WHOLE estate: the hub, every
   board, the theme spec, and a Node runtime — so the recipient installs
   nothing and needs no admin rights.

   The per-board packagers, one in each board folder, still exist and still
   build single-board zips. This one is for "here is everything".

   ── source is the working tree, not `git archive HEAD` ──

   The per-board scripts archive HEAD, and rest their safety argument on it:
   the archive holds exactly what is tracked, so a gitignored credential file
   cannot be swept in by an overlooked glob.

   That argument does not survive contact with this repo. `.trt-cache.json` is
   *tracked* under boards/dvp-scorecard, so the ignore rule never applied to it
   and `git archive` would ship it. Meanwhile uncommitted board edits are the
   normal state here, and archiving HEAD would quietly send a stale board —
   which is the exact failure this zip exists to avoid.

   So the source is the working tree minus everything ignored
   (`git ls-files --cached --others --exclude-standard`), minus an explicit
   STATE list for tracked-but-machine-local files. The safety argument moves
   from "git decides" to an explicit refusal gate: if anything matching SECRET
   reaches the staging tree, the build stops and nothing is written. A check
   that runs is worth more than an invariant that is merely asserted.

   ── one runtime, not five ──

   node.exe is ~88 MB. A copy per board would be ~440 MB for five identical
   binaries. The hub spawns boards with `spawn(process.execPath, ...)`
   (server.js), so a board started through the hub already inherits the hub's
   runtime; and each board launcher now falls back to `..\..\runtime\node.exe`
   before it falls back to PATH, so a directly double-clicked board finds it
   too. One copy at the root covers every path in.

   The runtime is whichever Node is executing this script, via process.execPath
   — no path guessing, and it is by definition a working binary. Node's LICENSE
   ships beside it because the MIT terms require it.

     node package-portable.js [outDir]        default: ~/Desktop            */

"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const log  = (...a) => console.log(...a);
const psq  = s => "'" + String(s).replace(/'/g, "''") + "'";

const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), "Desktop");

const stamp = new Date().toISOString().slice(0, 10);
const NAME  = `zo-projects-portable-${stamp}`;
const zip   = path.join(outDir, NAME + ".zip");

const rmrf = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
const mb   = n => (n / 1048576).toFixed(1) + " MB";

function walk(d, hit = []){
  for(const e of fs.readdirSync(d, { withFileTypes: true })){
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, hit) : hit.push(p);
  }
  return hit;
}
const dirSize = d => walk(d).reduce((n, f) => n + fs.statSync(f).size, 0);

/* SECRET, STATE and the enumeration moved to estate-files.js when the GitHub
   publisher and the updater started needing the same answers. One copy, three
   callers — a credential-blocking rule that exists in triplicate is one that
   will eventually only be right in two places. */
/* SECRET is still applied to the staged tree below rather than to the list:
   checking what actually landed catches a copy bug as well as a listing bug. */
const { SECRET, vettedFiles } = require("./estate-files");

/* ── 1. source ── */

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "zo-pack-"));
const root  = path.join(stage, "zo-projects");
fs.mkdirSync(root, { recursive: true });

const { files: listed, dropped } = vettedFiles(HERE);

let copied = 0;
for(const rel of listed){
  const src = path.join(HERE, rel);
  const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}
log(`source: ${copied} files (${dropped.length} machine-local dropped)`);

/* The theme spec lives outside the repo but every board README points at it,
   so a recipient who has only the zip cannot read what the boards reference. */
const theme = path.join(os.homedir(), "zo-projects-theme.md");
if(fs.existsSync(theme)){
  fs.copyFileSync(theme, path.join(root, "zo-projects-theme.md"));
  log("theme:  zo-projects-theme.md");
}else{
  log("! zo-projects-theme.md not found — the READMEs will reference a missing file");
}

/* The gate. Nothing below this line runs if a credential slipped through. */
const leaked = walk(root).filter(f => SECRET.test(f));
if(leaked.length){
  rmrf(stage);
  console.error("\nREFUSING TO BUILD — credential files reached the staging tree:");
  for(const f of leaked) console.error("   " + path.relative(root, f));
  console.error("\nCheck .gitignore, and `git rm --cached` anything already tracked.\n");
  process.exit(1);
}
log("checked: no credential files in the build");

/* ── 2. the runtime ── */

const runtime = path.join(root, "runtime");
fs.mkdirSync(runtime, { recursive: true });

const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, path.join(runtime, path.basename(nodeExe)));
log(`runtime: ${path.basename(nodeExe)} ${process.version} ${process.arch} — ${
      mb(fs.statSync(nodeExe).size)}`);

const lic = path.join(path.dirname(nodeExe), "LICENSE");
if(fs.existsSync(lic)){
  fs.copyFileSync(lic, path.join(runtime, "LICENSE-nodejs.txt"));
}else{
  log("! Node's LICENSE was not found beside the binary — add it by hand before sending");
}

/* ── 3. a note for whoever opens the zip ── */

fs.writeFileSync(path.join(root, "READ ME FIRST.txt"), `Zo Projects
===========

Five dashboards over Garage and Intrepid, and one hub that starts them.

  ZO-000  Zo Projects Hub    the way in — starts and stops the rest
  ZO-001  Charging Tracker   Supercharging: watch a car's charge climb
  ZO-002  FSD Tracker        post-delivery FSD miles
  ZO-003  DVP Scorecard      CSAT joined to Intrepid, per delivery
  ZO-004  The Compiler       service visits, holds, and cars on ground

TO RUN
------
  Double-click  "Start Zo Hub.cmd"

That opens http://localhost:3100 in your browser. Start any board from there.
Close the black window to stop it.

Nothing is installed and no admin rights are needed — Node is bundled in the
runtime folder. Windows, 64-bit. Keep the folder together: the runtime folder
is not optional, and one copy at the top serves every board.

You can also start a board on its own by double-clicking its own launcher in
its folder under "boards" — it finds the same shared runtime.

Windows may say "Windows protected your PC" the first time, because the folder
came out of a downloaded zip. Click "More info" then "Run anyway". It says that
about anything arriving this way; it has not detected a problem.

FIRST RUN
---------
You must be on the Tesla network or VPN.

There are NO credentials in this zip. It is a fresh copy: you sign in as
yourself, and you see exactly what your own Garage and Intrepid permissions
allow. The sender's cookies and tokens are not in here and cannot be — the
build refuses to run if a credential file reaches it.

  1. Open the hub and go to Admin (top right). The code is 226565.
  2. Under Sources, press Connect for Garage and for Intrepid.

Connect opens an isolated Chrome window, you sign in normally, and it reads the
session back. Both sign-ins share that window, so the second Connect usually
needs no second sign-in. This step needs Google Chrome installed — it is the
one thing not bundled here.

The hub holds the sign-ins and every board reads them, so this is done once
rather than per board.

WHERE YOUR SIGN-INS ARE KEPT
----------------------------
Not in this folder. The hub writes them to

  %LOCALAPPDATA%\\ZoProjects\\credentials.json

which on your machine is C:\\Users\\<you>\\AppData\\Local\\ZoProjects. That path
is worked out when the hub runs, so it is always your own account — nothing
about the machine this zip was built on comes with it. The file does not exist
until you sign in; the hub creates it the first time you press Connect, and
every board reads it, which is why signing in once is enough.

Two consequences worth knowing:

  - Deleting this folder does NOT sign you out. To do that, delete
    %LOCALAPPDATA%\\ZoProjects as well.
  - Replacing this folder with a newer copy keeps you signed in, because the
    sign-ins were never in the folder to begin with.

Each board still keeps its own settings and caches beside itself, inside this
folder. The sign-in window also gets an isolated browser profile under
%LOCALAPPDATA%\\cookie-grabber-profiles, created only if you press Connect.

MORE
----
README.md at the top explains the hub, the serials and how boards are added.
Each board has its own README.md with the real detail — what it calls, what it
counts, and why. zo-projects-theme.md is the house style the boards are built
to.
`.replace(/\n/g, "\r\n"));

/* ── 4. zip it ── */

log(`staged: ${mb(dirSize(root))} uncompressed`);
rmrf(zip);
fs.mkdirSync(outDir, { recursive: true });

/* .NET rather than Compress-Archive: an 88 MB binary takes minutes through the
   cmdlet and seconds through ZipFile. Same format either way. */
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
  `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psq(root)}, ${psq(zip)}, ` +
  `[System.IO.Compression.CompressionLevel]::Optimal, $true)`],
  { stdio: "inherit" });
rmrf(stage);

log("");
log(`wrote ${zip}`);
log(`      ${mb(fs.statSync(zip).size)}`);
log("");
log("Note: many mail filters strip zips containing an .exe, and this one is");
log("large. Share it through OneDrive or Teams rather than as an attachment.");

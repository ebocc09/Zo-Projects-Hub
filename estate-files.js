/* ============================================================================
   Which files belong to the estate, and which must never leave this machine.
   ----------------------------------------------------------------------------
   Three things now decide that question — the portable zip (package-portable),
   the GitHub publisher (publish.js), and the updater applying a download
   (updater.js). They were going to hold three copies of the same
   credential-blocking regex, which is precisely the drift that a gate exists to
   prevent: the copy that matters is always the one nobody remembered to update.

   So the lists live here once, and all three import them.
   ========================================================================== */
"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = __dirname;

/* Live credentials. Reaching a staging tree or a publish list abandons the
   whole operation — never a quiet skip, because a skipped credential looks
   identical to one that was never there. */
const SECRET = /(^|[\\/])\.(connections|tokens|client|teams|garage|admin)(\.[a-z0-9]+)?\.json$/i;

/* Machine-local state: caches, logs, scratch. Not dangerous, but it is this
   machine's, it goes stale, and every board rebuilds it on demand. Dropped
   quietly — including the dvp trt-cache, which is *tracked*, so .gitignore
   never applied to it and only this list keeps it out. */
const STATE = [
  /(^|[\\/])\.(trt-cache|staff-cache|measure-cache|vin-trt-cache)\.json$/i,
  /(^|[\\/])\.port\.tmp$/i,
  /(^|[\\/])logs[\\/]/i,
  /\.log$/i,
  /(^|[\\/])credentials\.json$/i,
  /* What the updater sets aside before overwriting a locally-edited file. It
     lives inside the estate folder and is untracked, so without this it would
     be swept into the next publish — uploading one machine's private edits to
     everyone else, which is the opposite of what keeping a backup is for. */
  /(^|[\\/])\.zo-backup[\\/]/i,
];

const isSecret = p => SECRET.test(String(p));
const isState  = p => STATE.some(re => re.test(String(p)));

/**
 * Every file git knows about — tracked or untracked-but-not-ignored — minus
 * machine-local state. The working tree rather than HEAD on purpose: an
 * uncommitted board edit is the normal state here, and publishing HEAD would
 * quietly ship something older than what is on screen.
 * @returns {{files: string[], dropped: string[]}} POSIX-separated repo-relative paths
 */
function vettedFiles(root = ROOT){
  const run = args => execFileSync("git", args,
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .split("\n").map(s => s.trim()).filter(Boolean);

  const listed = run(["ls-files", "--cached", "--others", "--exclude-standard"]);
  /* Untracked-but-not-ignored files ship too — that is deliberate, because an
     uncommitted board edit is the normal state here. But it also means any
     scratch file left lying in the tree goes out with everything else, and on a
     public repo that is how a debug dump or a half-finished note gets
     published. Reported separately so the review list can say which files are
     new to the repo rather than burying them among seventy others. */
  const untracked = new Set(run(["ls-files", "--others", "--exclude-standard"])
    .map(p => p.split(path.sep).join("/")));

  const files = [], dropped = [];
  for(const rel of listed){
    if(isState(rel)){ dropped.push(rel); continue; }
    const abs = path.join(root, rel);
    // git lists deleted-but-staged paths too; only real files can be shipped.
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if(!st.isFile()) continue;
    files.push(rel.split(path.sep).join("/"));
  }
  const sorted = files.sort();
  return { files: sorted, dropped, untracked: sorted.filter(f => untracked.has(f)) };
}

/**
 * The gate. Throws naming every offender rather than returning a boolean —
 * a caller that forgets to check a boolean fails open, which is the wrong way
 * for this particular check to fail.
 */
function assertNoSecrets(paths, what = "the publish set"){
  const leaked = paths.filter(isSecret);
  if(!leaked.length) return;
  const err = new Error(
    `Refusing to continue — credential files reached ${what}:\n` +
    leaked.map(p => "   " + p).join("\n") +
    "\n\nCheck .gitignore, and `git rm --cached` anything already tracked."
  );
  err.leaked = leaked;
  throw err;
}

/**
 * Git's own object id for a file's contents: sha1 over "blob <len>\0<bytes>".
 * Lets a machine with no git installed compare its files against a GitHub tree
 * listing, which is the whole basis of the update check.
 */
function blobSha(buf){
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return crypto.createHash("sha1")
    .update("blob " + body.length + "\0", "utf8")
    .update(body)
    .digest("hex");
}

function blobShaOf(abs){
  try { return blobSha(fs.readFileSync(abs)); }
  catch { return null; }                       // absent counts as "differs"
}

/**
 * Resolve a repo-relative path from an untrusted source and refuse anything
 * that escapes the root. These paths arrive from a network response, so
 * "../.." in a tree entry has to be a refusal rather than a write.
 */
function safeJoin(root, rel){
  const clean = String(rel).replace(/\\/g, "/");
  if(!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean)) return null;
  if(clean.split("/").some(seg => seg === ".." || seg === "." || seg === "")) return null;
  const abs = path.resolve(root, clean);
  const base = path.resolve(root);
  if(abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

module.exports = {
  ROOT, SECRET, STATE,
  isSecret, isState,
  vettedFiles, assertNoSecrets,
  blobSha, blobShaOf, safeJoin,
};

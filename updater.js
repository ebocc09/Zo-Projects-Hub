/* ============================================================================
   Pulling published estate updates.
   ----------------------------------------------------------------------------
   Runs on every Hub, including the ones that arrived as a zip — so it cannot
   assume git exists. It compares content hashes against the manifest published
   alongside the files, which is both git-free and more reliable than reading
   commits: it converges on the right answer whatever the history looks like,
   and whatever state the local copy has drifted into.

   Everything comes from raw.githubusercontent.com rather than the GitHub API.
   The anonymous API allows 60 requests an hour per IP and a corporate network
   puts the whole team behind one address; the CDN has no such limit.

   ── nothing is touched until everything has landed ──

   Downloads go to a staging directory and are verified against the manifest
   before a single live file is written. A dropped connection halfway through
   leaves the estate exactly as it was, rather than a board with three new files
   and four old ones.
   ========================================================================== */
"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const { ROOT, isSecret, isState, blobSha, blobShaOf, safeJoin } = require("./estate-files");
const { STORE_FILE } = require("./credstore");

const OWNER = "ebocc09";
const REPO  = "Zo-Projects-Hub";
const REF   = "main";
const MANIFEST = ".estate.json";
const RAW = (p, bust) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}/${p}` +
  (bust ? `?t=${Date.now()}` : "");

/* Beside credentials.json, deliberately outside the repo: it records what the
   updater installed, and a file inside the tree it manages would be overwritten
   by the very updates it is meant to be tracking. */
const MANIFEST_FILE = path.join(path.dirname(STORE_FILE), "installed.json");

function readInstalled(){
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")); }
  catch { return { published: null, files: {} }; }
}
function writeInstalled(data){
  fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
  const tmp = MANIFEST_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MANIFEST_FILE);          // rename is atomic; a half-written
}                                             // manifest would strand the estate

async function get(url, { binary = false } = {}){
  const res = await fetch(url, {
    headers: { "User-Agent": "zo-projects-hub", "Cache-Control": "no-cache" },
    redirect: "follow",
  });
  if(!res.ok){
    const e = new Error(`${res.status} ${res.statusText} for ${url.split("?")[0]}`);
    e.status = res.status;
    throw e;
  }
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

function friendly(err){
  if(err && err.status === 404)
    return "Nothing published yet — the repository has no .estate.json. " +
           "Publish once from the Hub that owns the estate.";
  if(err && /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(String(err.message)))
    return "Could not reach GitHub. Check the connection, or whether a network " +
           "policy is blocking raw.githubusercontent.com.";
  return (err && err.message) || String(err);
}

/** Repo-relative folder a path belongs to, e.g. "boards/compiler"; null = Hub file. */
function boardDirOf(rel){
  const m = rel.match(/^(boards\/[^/]+)\//);
  return m ? m[1] : null;
}

/* registry.withState() replaces each board's relative `dir` with an absolute
   one, so the registry entries handed to us do not compare against repo paths.
   Convert back rather than matching on a basename, which would collide the day
   two boards are nested under different parents. */
function relDirOf(board){
  if(!board || !board.dir) return null;
  const rel = path.relative(ROOT, board.dir).split(path.sep).join("/");
  return rel === "" ? "." : rel;
}
const boardFor = (boards, dir) => boards.find(b => relDirOf(b) === dir) || null;

/* server.js loads registry.js once at boot, and index.html is re-read on every
   request — so those two Hub files need very different things said about them
   after an update. */
const LIVE_ON_SAVE = /^index\.html$/;

/**
 * Compare the published manifest against what is on disk.
 * @param {Array} boards registry entries, for naming and restart decisions
 */
async function check(boards = []){
  const published = JSON.parse(await get(RAW(MANIFEST, true)));
  const remote = published.files || {};
  const installed = readInstalled();

  /* raw.githubusercontent is a CDN and lags a publish by a few minutes. Without
     this, checking straight after publishing fetches the *previous* manifest,
     finds the local files differ from it, and offers to install the older
     version over the newer one — an update that runs backwards. Anything older
     than what this machine already has is the CDN catching up, not an update. */
  if(installed.published && published.published &&
     new Date(published.published) < new Date(installed.published)){
    return {
      upToDate: true, behindCdn: true,
      published: published.published, since: installed.published,
      changed: [], removed: [], refused: [], groups: [], needsRestart: false, total: 0,
    };
  }

  const changed = [], refused = [];
  for(const [rel, sha] of Object.entries(remote)){
    if(isSecret(rel) || isState(rel)){ refused.push({ rel, why: "not a publishable file" }); continue; }
    const abs = safeJoin(ROOT, rel);
    if(!abs){ refused.push({ rel, why: "path escapes the estate folder" }); continue; }
    const local = blobShaOf(abs);
    if(local === sha) continue;
    changed.push({ rel, sha, kind: local === null ? "new" : "changed" });
  }

  /* Removals are limited to what this updater installed. A file the publisher
     never sent is somebody's own, and deleting it because it is absent upstream
     would be the updater overstepping. */
  const removed = Object.keys(installed.files || {})
    .filter(rel => !remote[rel])
    .filter(rel => { const a = safeJoin(ROOT, rel); return a && fs.existsSync(a); })
    .map(rel => ({ rel }));

  const groups = new Map();
  for(const item of [...changed, ...removed.map(r => ({ ...r, kind: "removed" }))]){
    const dir = boardDirOf(item.rel);
    const board = dir ? boardFor(boards, dir) : null;
    const key = dir || "__hub__";
    if(!groups.has(key)){
      groups.set(key, {
        key,
        // A folder with no registry entry is a board this copy has never seen —
        // which is exactly what a brand-new dashboard looks like on arrival.
        // Name it by its folder rather than reporting it as unknown.
        serial: board ? board.serial : (dir ? dir.replace(/^boards\//, "") : "Hub"),
        name  : board ? board.name   : (dir ? dir.replace(/^boards\//, "") + " (new)" : "Hub"),
        isHub : !dir,
        files : [],
      });
    }
    groups.get(key).files.push(item);
  }

  const hub = groups.get("__hub__");
  const needsRestart = !!hub && hub.files.some(f => !LIVE_ON_SAVE.test(f.rel));

  return {
    upToDate: changed.length === 0 && removed.length === 0,
    published: published.published || null,
    changed, removed, refused,
    groups: [...groups.values()].sort((a, b) => (a.isHub ? 1 : 0) - (b.isHub ? 1 : 0)),
    needsRestart,
    total: changed.length + removed.length,
  };
}

/**
 * Download, verify, then install.
 * @param {{boards:Array, stopBoard:Function, startBoard:Function, isRunning:Function}} io
 */
async function apply(io = {}){
  const { boards = [], stopBoard, startBoard, isRunning } = io;
  const plan = await check(boards);
  if(plan.upToDate) return { ok: true, nothing: true, ...plan };

  /* ── 1. stage everything, verify everything ── */
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "zo-update-"));
  try{
    for(const item of plan.changed){
      const body = await get(RAW(item.rel, true), { binary: true });
      const got = blobSha(body);
      if(got !== item.sha){
        // Almost always means a publish landed while this was downloading.
        throw new Error(
          `${item.rel} did not match the published hash — the estate was ` +
          `republished mid-download. Nothing has been changed; try again.`);
      }
      const dst = path.join(stage, item.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, body);
    }

    /* ── 2. stop the boards about to change under them ── */
    const dirs = new Set(plan.changed.concat(plan.removed).map(f => boardDirOf(f.rel)).filter(Boolean));
    const toRestart = [];
    for(const dir of dirs){
      const board = boardFor(boards, dir);
      if(!board) continue;                     // a board this copy does not have
                                               // yet has nothing to stop
      if(isRunning && isRunning(board)){
        toRestart.push(board);
        if(stopBoard) await stopBoard(board);
      }
    }

    /* ── 3. install, keeping anything edited locally ── */
    const installed = readInstalled();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(ROOT, ".zo-backup", stamp);
    const backedUp = [];

    const keep = (rel, abs) => {
      // Matches neither what we installed nor what is arriving: somebody edited
      // it here. Overwriting silently would throw away work with no trace.
      const now = blobShaOf(abs);
      if(now === null) return false;
      if(now === (installed.files || {})[rel]) return false;
      const dst = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      backedUp.push(rel);
      return true;
    };

    for(const item of plan.changed){
      const abs = safeJoin(ROOT, item.rel);
      if(!abs) continue;                       // already refused in check()
      if(fs.existsSync(abs)) keep(item.rel, abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(path.join(stage, item.rel), abs);
    }

    for(const item of plan.removed){
      const abs = safeJoin(ROOT, item.rel);
      if(!abs || !fs.existsSync(abs)) continue;
      keep(item.rel, abs);
      try { fs.unlinkSync(abs); } catch {}
    }

    /* ── 4. record what is now installed ── */
    const remoteManifest = JSON.parse(await get(RAW(MANIFEST, true)));
    writeInstalled({ published: remoteManifest.published, files: remoteManifest.files });

    /* ── 5. bring the boards back ── */
    /* Report what actually came back, not what we asked to come back. A board
       that fails to rebind its port is the single most likely way an update
       goes wrong, and "Restarted ZO-004" over a dead board would send someone
       looking anywhere but here. */
    const restarted = [], failed = [];
    for(const board of toRestart){
      const r = startBoard ? await startBoard(board) : { ok: true };
      if(r && r.ok === false) failed.push({ serial: board.serial, error: r.error || "did not come back up" });
      else restarted.push(board.serial);
    }

    return {
      ok: true, nothing: false,
      installed: plan.changed.length,
      deleted: plan.removed.length,
      restarted, failed,
      backedUp,
      backupDir: backedUp.length ? backupDir : null,
      needsRestart: plan.needsRestart,
      groups: plan.groups,
    };
  }finally{
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { check, apply, friendly, MANIFEST_FILE, OWNER, REPO, REF,
                   /* publish.js records what it just sent, so the publishing
                      machine knows it is ahead while the CDN catches up. */
                   recordInstalled: writeInstalled };

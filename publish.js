/* ============================================================================
   Publishing the estate to GitHub.
   ----------------------------------------------------------------------------
   One button on the Hub's admin panel, so a board fix reaches everyone holding
   a copy instead of waiting for the next zip.

   ── an orphan branch, not this repo's history ──

   The local repo has a hundred-odd commits, and among the things they contain
   is boards/dvp-scorecard/.trt-cache.json — 214KB of TRT data that is *tracked*,
   so .gitignore never applied to it. The estate-files STATE list keeps it out
   of the files we publish today, but pushing this repo's history would publish
   every version of it that was ever committed. The repository is public.

   So publishing does not push `main`. It builds a fresh tree from the vetted
   file list and commits it onto a local `publish` branch that is rooted at
   nothing. GitHub gets a clean snapshot per push and no history from here.
   Ed's working tree, index and main branch are never touched by any of it —
   the tree is assembled through a throwaway index file.
   ========================================================================== */
"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT, vettedFiles, assertNoSecrets, blobShaOf } = require("./estate-files");

const REMOTE_URL = "https://github.com/ebocc09/Zo-Projects-Hub.git";
const LOCAL_REF  = "refs/heads/publish";   // the snapshot chain, local only
const TARGET     = "main";                 // what it lands on at GitHub

/* A hash listing published inside the tree itself. Without it every consumer
   would have to ask the GitHub API for a recursive tree, and the anonymous
   limit is 60 requests an hour *per IP* — one corporate NAT means the whole
   team shares it. With it, checking for updates is a single CDN fetch and no
   API call at all. */
const MANIFEST = ".estate.json";

/* stderr is piped rather than inherited: several calls here probe for things
   that legitimately do not exist yet — the publish branch on a first run — and
   letting git's "fatal:" reach the console would fill the Hub log with failures
   that are the expected answer. It is still captured, so a real error survives
   into gitFailure(). */
function git(args, opts = {}){
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

/* git writes the useful part of a failure to stderr, and execFileSync's own
   message is just the command line. Surface the former. */
function gitFailure(err){
  const text = [err && err.stderr, err && err.stdout, err && err.message]
    .filter(Boolean).map(String).join("\n").trim();
  if(/ENOENT/i.test(text) && !/remote/i.test(text))
    return "git is not installed on this machine, or is not on PATH.";
  if(/could not read Username|Authentication failed|403|401/i.test(text))
    return "GitHub rejected the credentials. The stored token needs Contents: " +
           "Read and write on Zo-Projects-Hub — the Task Tracker token alone is " +
           "scoped to that repo only.";
  if(/non-fast-forward|rejected|fetch first/i.test(text))
    return "GitHub has commits this machine has not seen — something changed the " +
           "repo outside the Hub. Resolve that before publishing again.";
  return text || "git failed with no output.";
}

/** path → blob sha for whatever was last published, or null on a first run. */
function publishedTree(){
  let out;
  try { out = git(["ls-tree", "-r", "-z", "--full-tree", LOCAL_REF]); }
  catch { return null; }                       // branch does not exist yet
  const map = new Map();
  for(const rec of out.split("\0")){
    if(!rec) continue;
    // "<mode> <type> <sha>\t<path>" — -z means no quoting to unpick.
    const m = rec.match(/^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/);
    if(m) map.set(m[2], m[1]);
  }
  return map;
}

/**
 * What a publish would change, without changing anything.
 * @returns {{files:string[], dropped:string[], added:string[], changed:string[],
 *            removed:string[], first:boolean}}
 */
function preview(){
  const { files, dropped } = vettedFiles(ROOT);
  assertNoSecrets(files, "the publish set");

  const prev = publishedTree();
  if(!prev) return { files, dropped, added: files, changed: [], removed: [], first: true };

  const added = [], changed = [];
  for(const rel of files){
    const was = prev.get(rel);
    if(!was){ added.push(rel); continue; }
    if(was !== blobShaOf(path.join(ROOT, rel))) changed.push(rel);
  }
  const now = new Set(files);
  const removed = [...prev.keys()].filter(p => !now.has(p)).sort();
  return { files, dropped, added, changed, removed, first: false };
}

/* An identity is required to write a commit object and this repo may not have
   one configured. Passed per-invocation rather than written to config. */
function identityArgs(){
  const has = k => { try { return !!git(["config", k]).trim(); } catch { return false; } };
  if(has("user.email") && has("user.name")) return [];
  return ["-c", "user.name=Zo Projects Hub", "-c", "user.email=zo-hub@localhost"];
}

/* The token goes in the environment, not in argv and not in .git/config: argv
   is readable by any other process on the machine, and config would leave it
   on disk. */
function authEnv(token){
  const basic = Buffer.from("x-access-token:" + token).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",                  // fail instead of hanging on a prompt
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + basic,
  };
}

function ensureRemote(){
  let url = "";
  try { url = git(["remote", "get-url", "origin"]).trim(); } catch {}
  if(!url) git(["remote", "add", "origin", REMOTE_URL]);
  return url || REMOTE_URL;
}

/**
 * Build the snapshot and push it.
 * @param {{token:string, message?:string}} opts
 */
function publish({ token, message } = {}){
  if(!token) throw new Error("No GitHub token saved — add one in Admin › Sign-ins.");

  const plan = preview();
  const nothing = !plan.first && !plan.added.length && !plan.changed.length && !plan.removed.length;
  if(nothing) return { ok: true, nothing: true, ...plan };

  const idx = path.join(os.tmpdir(), `zo-publish-${process.pid}-${Date.now()}.idx`);
  const withIndex = { env: { ...process.env, GIT_INDEX_FILE: idx } };

  let commit;
  try{
    // A throwaway index means none of this reaches the real one, so an
    // interrupted publish cannot leave staged changes behind.
    git(["read-tree", "--empty"], withIndex);

    // Paths on stdin rather than argv: 69 files is comfortably under Windows'
    // command-line limit today, but the estate only ever grows.
    git(["update-index", "--add", "--stdin"], { ...withIndex, input: plan.files.join("\n") + "\n" });

    // The manifest is written straight into the object store and added by hash,
    // so it never appears in the working tree — publishing must not leave a
    // stray file behind for the next `git status` to report.
    const manifest = { published: new Date().toISOString(), files: {} };
    for(const rel of plan.files) manifest.files[rel] = blobShaOf(path.join(ROOT, rel));
    const blob = git(["hash-object", "-w", "--stdin"],
                     { input: JSON.stringify(manifest, null, 2) + "\n" }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${MANIFEST}`], withIndex);

    const tree = git(["write-tree"], withIndex).trim();

    let parent = null;
    try { parent = git(["rev-parse", "--verify", LOCAL_REF]).trim(); } catch {}

    const msg = (message && message.trim()) || defaultMessage(plan);
    commit = git([
      ...identityArgs(), "commit-tree", tree,
      ...(parent ? ["-p", parent] : []),
      "-m", msg,
    ]).trim();

    git(["update-ref", LOCAL_REF, commit]);
  }catch(err){
    throw new Error(gitFailure(err));
  }finally{
    try { fs.unlinkSync(idx); } catch {}
  }

  ensureRemote();
  try{
    git(["push", "origin", `${LOCAL_REF}:refs/heads/${TARGET}`], { env: authEnv(token) });
  }catch(err){
    // The commit exists locally; only the push failed. Leaving the ref in place
    // means a retry re-pushes the same snapshot rather than stacking a second.
    throw new Error(gitFailure(err));
  }

  return { ok: true, nothing: false, commit, ...plan };
}

function defaultMessage(plan){
  if(plan.first) return `Publish the estate — ${plan.files.length} files`;
  const boards = new Set();
  for(const rel of [...plan.added, ...plan.changed, ...plan.removed]){
    const m = rel.match(/^boards\/([^/]+)\//);
    boards.add(m ? m[1] : "hub");
  }
  const n = plan.added.length + plan.changed.length + plan.removed.length;
  return `Update ${[...boards].sort().join(", ")} — ${n} file${n === 1 ? "" : "s"}`;
}

module.exports = { preview, publish, REMOTE_URL, LOCAL_REF, TARGET, MANIFEST };

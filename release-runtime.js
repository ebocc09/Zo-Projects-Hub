#!/usr/bin/env node
/* ============================================================================
   Publishing the Node runtime as a GitHub *release asset*.
   ----------------------------------------------------------------------------
   The portable zip has always carried Node (package-portable copies
   process.execPath into runtime/). The GitHub copy never has, and could not:
   publish.js builds its tree from estate-files' vettedFiles(), which can only
   list what git sees in the working tree — and a 92 MB binary does not belong
   in the working tree of a public repo.

   So it goes somewhere git history never reaches. Release assets are stored
   outside the object store, allow 2 GB apiece, and download anonymously from
   a public repo. Nothing about a clone, a Download-ZIP, or the updater's
   per-file CDN fetch grows by a single byte.

   ── why not commit it ──

   node.exe is 92.5 MB today and GitHub hard-rejects any blob at 100 MiB. That
   is not a comfortable margin to leave between the estate and "publishing is
   broken and the fix is rewriting history on a public repo". A release asset
   has no such ceiling, and the binary is stock Node either way.

   ── why the zip, and why it carries the licence ──

   The asset is a zip rather than a bare node.exe: ~36 MB against ~92 MB, over
   a corporate link, once per recipient. Windows' own tar.exe unpacks it, so
   get-runtime.cmd needs no PowerShell and no execution-policy argument.

   Node's LICENSE rides inside the zip because the MIT terms require it to
   travel with the binary — package-portable already does this for the zip
   path, and the GitHub path has the same obligation.

   ── what the recipient trusts ──

   runtime.json is committed and published; the asset is not. So the sha256 of
   the asset arrives through the reviewed, hash-manifested channel and the
   92 MB of bytes arrive through the cheap one, and get-runtime.cmd refuses
   anything that does not match. A tampered release asset fails the check.

     node release-runtime.js              upload, then write runtime.json
     node release-runtime.js --dry-run    build and hash only, upload nothing
   ========================================================================== */
"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { REMOTE_URL } = require("./publish");
const { publishToken } = require("./credstore");

const HERE   = __dirname;
const DRY    = process.argv.includes("--dry-run");
const log    = (...a) => console.log(...a);
const psq    = s => "'" + String(s).replace(/'/g, "''") + "'";
const mb     = n => (n / 1048576).toFixed(1) + " MB";

/* Parsed from publish.js rather than restated. Two constants naming the same
   repository is one constant and one thing that will eventually be wrong. */
const m = REMOTE_URL.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
if(!m){ console.error("Cannot read owner/repo out of " + REMOTE_URL); process.exit(1); }
const [, OWNER, REPO] = m;

/* The runtime is whichever Node is running this script — no path guessing, and
   it is by definition a working binary. Same argument package-portable makes. */
const nodeExe = process.execPath;
const VERSION = process.version;                        // "v24.18.0"
const ARCH    = process.arch;                           // "x64"
const TAG     = `runtime-${VERSION}-win-${ARCH}`;
const ASSET   = `node-win-${ARCH}.zip`;

if(process.platform !== "win32"){
  console.error("This packages the Windows runtime; run it on Windows.");
  process.exit(1);
}

/* ── 1. build the zip ── */

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "zo-runtime-"));
const inner = path.join(stage, "payload");
fs.mkdirSync(inner, { recursive: true });

fs.copyFileSync(nodeExe, path.join(inner, "node.exe"));
log(`runtime: node.exe ${VERSION} ${ARCH} — ${mb(fs.statSync(nodeExe).size)}`);

const lic = path.join(path.dirname(nodeExe), "LICENSE");
if(fs.existsSync(lic)){
  fs.copyFileSync(lic, path.join(inner, "LICENSE-nodejs.txt"));
}else{
  console.error("\nRefusing to build — Node's LICENSE is not beside the binary at");
  console.error("   " + path.dirname(nodeExe));
  console.error("\nThe MIT terms require it to ship with the binary. Copy it there, or");
  console.error("point this script at a full Node distribution rather than a lone exe.\n");
  fs.rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

const zipPath = path.join(stage, ASSET);
/* includeBaseDirectory false, so the zip root holds node.exe directly and
   `tar -xf <zip> -C runtime` lands it at runtime\node.exe with no strip. */
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
  `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psq(inner)}, ${psq(zipPath)}, ` +
  `[System.IO.Compression.CompressionLevel]::Optimal, $false)`],
  { stdio: "inherit" });

const bytes  = fs.readFileSync(zipPath);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
log(`asset:   ${ASSET} — ${mb(bytes.length)}`);
log(`sha256:  ${sha256}`);

/* ── 2. upload it ── */

async function api(url, opts = {}){
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "zo-projects-hub",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/* GitHub's failures here are all one of three things, and the raw JSON says
   none of them plainly. Same shape as publish.js's gitFailure(). */
function explain(status, body){
  const msg = (body && (body.message || body.raw)) || "";
  if(status === 401)
    return "GitHub rejected the token outright. It may have expired, or never had " +
           "this repository selected.";
  if(status === 403 || /not permitted|resource not accessible/i.test(msg))
    return "The token authenticated but was refused. Publishing a release asset needs " +
           "Contents: Read and write on " + REPO + " — the same permission the estate " +
           "publisher uses. Check it at github.com/settings/personal-access-tokens.";
  if(status === 404)
    return "GitHub returned 404 for " + OWNER + "/" + REPO + ". On a fine-grained token " +
           "that usually means the repository is not in the token's selected list, " +
           "rather than that it does not exist.";
  return `GitHub returned ${status}${msg ? " — " + msg : ""}`;
}

let TOKEN = "";

async function main(){
  if(DRY){
    log("\n--dry-run: nothing uploaded, runtime.json not written.");
    log(`would upload as ${OWNER}/${REPO} release ${TAG} / ${ASSET}`);
    return;
  }

  TOKEN = publishToken();
  if(!TOKEN) throw new Error("No publish token saved — add one in Admin › Sign-ins.");

  const base = `https://api.github.com/repos/${OWNER}/${REPO}`;

  /* The tag is version-pinned, so a given runtime is uploaded once and every
     later run for the same Node version reuses the release. A Node upgrade
     makes a new tag and leaves the old one downloadable, which is what lets an
     older runtime.json in someone's folder keep working. */
  let rel = await api(`${base}/releases/tags/${encodeURIComponent(TAG)}`);
  if(rel.status === 404){
    log(`\nrelease: creating ${TAG}`);
    rel = await api(`${base}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: TAG,
        name: `Node ${VERSION} (win-${ARCH})`,
        body:
          `Stock Node.js ${VERSION} for Windows ${ARCH}, zipped with its licence.\n\n` +
          "Fetched automatically by `get-runtime.cmd` on first run when no Node is " +
          "present — you do not need to download this by hand. The estate pins its " +
          "sha256 in `runtime.json` and refuses anything that does not match.",
        draft: false,
        prerelease: false,
      }),
    });
    if(!rel.ok) throw new Error(explain(rel.status, rel.body));
  }else if(!rel.ok){
    throw new Error(explain(rel.status, rel.body));
  }else{
    log(`\nrelease: ${TAG} already exists`);
  }

  const relId = rel.body.id;

  /* Assets are immutable once uploaded — same name twice is a 422, not a
     replace. Re-running after a rebuilt zip has to delete first. */
  const existing = (rel.body.assets || []).find(a => a.name === ASSET);
  if(existing){
    log(`asset:   replacing the existing ${ASSET}`);
    const del = await api(`${base}/releases/assets/${existing.id}`, { method: "DELETE" });
    if(!del.ok && del.status !== 404) throw new Error(explain(del.status, del.body));
  }

  log(`upload:  ${mb(bytes.length)} …`);
  const up = await api(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${relId}/assets` +
    `?name=${encodeURIComponent(ASSET)}`,
    { method: "POST",
      headers: { "Content-Type": "application/zip", "Content-Length": String(bytes.length) },
      body: bytes });
  if(!up.ok) throw new Error(explain(up.status, up.body));

  /* The API's own browser_download_url rather than one assembled from the tag:
     it is what GitHub will actually serve, including any escaping we would
     otherwise have to reproduce by hand. */
  const url = up.body.browser_download_url;

  /* ── 3. pin it ──
     One key per line, values quoted and free of embedded quotes, because
     get-runtime.cmd parses this with `for /f delims="` — cmd has no JSON
     parser and the bootstrap has to run before any Node exists. Keep it flat
     and keep it one-per-line; a reflowed file will not parse. */
  const manifest = {
    version: VERSION,
    arch:    ARCH,
    tag:     TAG,
    asset:   ASSET,
    size:    bytes.length,
    sha256,
    url,
  };
  fs.writeFileSync(path.join(HERE, "runtime.json"),
                   JSON.stringify(manifest, null, 2) + "\n");

  log("");
  log(`published ${url}`);
  log(`wrote     runtime.json`);
  log("");
  log("Now press Push to GitHub on the Hub's admin panel, so runtime.json reaches");
  log("everyone. Until you do, the release exists but nothing points at it.");
}

main()
  .catch(err => { console.error("\n" + (err && err.message || err) + "\n"); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} });

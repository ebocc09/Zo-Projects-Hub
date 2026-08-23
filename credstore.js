/* The shared credential store.

   One file, outside every project, holding the two session cookies that all
   the Zo boards use. The Hub writes it; every board reads it. Sign in once.

   ── why a file and not a service ──

   The obvious alternative is for boards to ask the Hub for credentials over
   HTTP. That would make the Hub a runtime dependency: with it closed, nothing
   works. A file has no such failure mode — the Hub can be deleted and every
   board keeps running on whatever was last written.

   ── why this is safe when sharing an OAuth client was not ──

   Two boards briefly shared a Garage OAuth client, and that was a genuine
   bug: refreshing rotates the refresh token, so whichever board refreshed
   first invalidated the other's copy. Session cookies do not rotate. Two
   readers of the same cookie do not interfere, and a copy going stale is a
   fact about the session's age, not about who read it last. Sharing the value
   is fine; sharing a mutable registration was not.

   ── the MCP token, and the one rule it depends on ──

   Alongside the cookies sits `garageMcp`: a dynamically-registered OAuth
   client and its tokens, for Garage's MCP endpoint. It is here because
   `lookup_user` — turning a username into a display name — is the one thing
   with no cookie equivalent, and a board is no place for a second sign-in.

   Storing an OAuth token in a shared file walks back toward a bug this estate
   has already had once: two boards shared a Garage client, refreshing rotates
   the refresh token, and whichever refreshed first invalidated the other.
   What makes it safe here is a rule, so the rule is written down rather than
   remembered:

     The Hub MINTS and never refreshes — authorize, exchange, sign out.
     Exactly ONE board consumes and rotates: ZO-002, the only board that
     speaks MCP at all. One writer of rotations, so no copy can be
     invalidated underneath anyone.

   A second MCP consumer would reintroduce the original bug exactly. If one is
   ever needed, this key does not simply get read a second time — the refresh
   has to move somewhere single-writer first.

   ── precedence ──

   Shared first, local second. Nothing writes the local copy any more: every
   sign-in happens on the Hub, and a board's own `.connections.json` keeps only
   its non-credential settings. A hand-edited cookie there still works as a
   deliberate override for a machine the Hub has never run on, but it is a
   fallback rather than a feature — shared wins, because the whole point of the
   Hub is that signing in there fixes every board at once.

   Copied into each project rather than required across folders. Every board
   stays self-contained and runnable on its own; duplication is the price and
   it is the right one — the same trade already made for xlsx.js.           */

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

/* Beside the browser profiles the sign-in flow already uses, for the same
   reason: one obvious place per machine for things that are neither project
   files nor secrets worth a keychain. */
const STORE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), ".zo-projects"),
  "ZoProjects");

const STORE_FILE = path.join(STORE_DIR, "credentials.json");

/* Version 2 added garageMcp. No migration step: a version 1 file spreads over
   this and simply arrives with garageMcp empty, which is indistinguishable
   from never having signed in to MCP. */
const EMPTY = { version: 2, updated: null, garage: {}, intrepid: "",
                garageMcp: { client: null, tokens: null },
                /* A GitHub personal access token, for boards hosted on Pages
                   that sync their own data back to a repo. It is here for the
                   same reason everything else is: so it lives outside every
                   project folder and cannot be committed by accident. */
                github: { token: "" },

                /* Publishing the estate is a *separate* token, deliberately.
                   The one above is handed out — the Task Tracker tile copies it
                   to a clipboard and shows it as a QR for teammates to scan. A
                   single shared token that could also push to the estate repo
                   would hand every teammate who scanned that code the ability
                   to publish to everyone else. Two purposes, two credentials. */
                publish: { token: "" } };

function readStore(){
  try{
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { ...EMPTY, ...raw,
             garage   : { ...(raw.garage || {}) },
             garageMcp: { ...EMPTY.garageMcp, ...(raw.garageMcp || {}) },
             github   : { ...EMPTY.github, ...(raw.github || {}) },
             publish  : { ...EMPTY.publish, ...(raw.publish || {}) } };
  }catch{
    // Missing or malformed reads as absent. A board must not fail to start
    // because a shared file it does not own got mangled.
    return { ...EMPTY, garage: {}, garageMcp: { ...EMPTY.garageMcp },
             github: { ...EMPTY.github }, publish: { ...EMPTY.publish } };
  }
}

/* Merge, never replace: writing the Intrepid cookie must not blank Garage,
   and writing one Garage environment must not blank the other.

   Written atomically — temp file, then rename. Read-modify-write on a cookie
   was survivable, because losing one write just means signing in again. The
   MCP refresh token rotates: a torn or lost write there strands the session
   with no way back except a fresh sign-in nobody would know to do. */
function writeStore(patch){
  const cur = readStore();
  const next = {
    ...cur,
    ...patch,
    garage   : { ...cur.garage, ...(patch.garage || {}) },
    garageMcp: { ...cur.garageMcp, ...(patch.garageMcp || {}) },
    github   : { ...cur.github, ...(patch.github || {}) },
    publish  : { ...cur.publish, ...(patch.publish || {}) },
    version  : 2,
    updated  : new Date().toISOString()
  };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = STORE_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
  return next;
}

/* ── what a board asks for ──
   `env` is "prod" or "eng"; only the Charging Tracker has two, but the store
   is keyed by it for everyone so a second environment never needs a format
   change. `local` is whatever the board found in its own connections file. */

function garageCookie(env = "prod", local = ""){
  const shared = (readStore().garage || {})[env] || "";
  const value = shared || local || "";
  return { value, source: shared ? "hub" : (local ? "local" : null) };
}

function intrepidCookie(local = ""){
  const shared = readStore().intrepid || "";
  const value = shared || local || "";
  return { value, source: shared ? "hub" : (local ? "local" : null) };
}

/* ── the MCP client and its tokens ──
   Read on every call rather than cached: the Hub can be signed in while a
   board is running, and a board that needed restarting to notice would make
   the whole arrangement feel broken. */

/* The raw token, for the one button that exists to hand it to you. Everything
   else should ask summary() instead, which never returns it. */
function githubToken(){ return readStore().github.token || ""; }
const setGithubToken = token => writeStore({ github: { token: String(token || "").trim() } });

/* Never handed to a board, never copied to a clipboard, never drawn as a QR —
   the only caller is publish.js. Kept apart from githubToken() so the two can
   never be confused at the point of use. */
function publishToken(){ return readStore().publish.token || ""; }
const setPublishToken = token => writeStore({ publish: { token: String(token || "").trim() } });

function mcpClient(){ return readStore().garageMcp.client || null; }
function mcpTokens(){ return readStore().garageMcp.tokens || null; }

const setMcpClient = client => writeStore({ garageMcp: { client } });
const setMcpTokens = tokens => writeStore({ garageMcp: { tokens } });
const clearMcp     = ()     => writeStore({ garageMcp: { client: null, tokens: null } });

/* For the panel: what is in the shared store, without returning any of it. */
function summary(){
  const s = readStore();
  const mask = v => (v ? "…" + String(v).slice(-8) : "");
  const t = s.garageMcp.tokens;
  return {
    file   : STORE_FILE,
    updated: s.updated,
    garage : Object.fromEntries(Object.entries(s.garage || {})
      .map(([k, v]) => [k, { set: Boolean(v), hint: mask(v) }])),
    intrepid: { set: Boolean(s.intrepid), hint: mask(s.intrepid) },
    // Expiry rather than a hint: a masked token tells nobody anything, and
    // "expired an hour ago" is the fact the panel is actually being asked.
    garageMcp: {
      set       : Boolean(t && t.refresh_token),
      registered: Boolean(s.garageMcp.client),
      expiresAt : t && t.expires_at ? new Date(t.expires_at).toISOString() : null
    },
    /* Masked by the prefix rather than the tail: GitHub tokens all start
       github_pat_ and the interesting part is which one this is, so the first
       few characters after the prefix identify it without handing it over. */
    publish: {
      set : Boolean(s.publish.token),
      hint: s.publish.token ? s.publish.token.slice(0, 15) + "…" : ""
    },
    github: {
      set : Boolean(s.github.token),
      hint: s.github.token ? s.github.token.slice(0, 15) + "…" : ""
    }
  };
}

function clearStore(){
  try { fs.unlinkSync(STORE_FILE); return { cleared: true }; }
  catch { return { cleared: false }; }
}

/* ── settings, which are not credentials ────────────────────────────────

   One preference so far — the language every board renders in — and a
   separate file from the credentials, deliberately. A preference gets written
   from an admin panel by whoever happens to be looking at it. The credential
   file holds a refresh token that rotates and cannot survive a torn write.
   Keeping them apart means flipping the language can never be the thing that
   strands an MCP session.

   Same arrangement as everything else here: the Hub writes it, every board
   reads it, and a board started with no Hub running still comes up in
   whatever was last chosen. Read on every call rather than cached, because
   the whole point is that changing it on the Hub reaches a board that is
   already open.                                                          */

const SETTINGS_FILE = path.join(STORE_DIR, "settings.json");

const LANGUAGES = ["en", "es"];
const SETTINGS_EMPTY = { version: 1, updated: null, language: "en" };

function readSettings(){
  try{
    return { ...SETTINGS_EMPTY, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  }catch{
    // Missing or malformed reads as the default, for the same reason the
    // credential store does it: a board must not fail to start because a
    // shared file it does not own got mangled.
    return { ...SETTINGS_EMPTY };
  }
}

/* Anything unrecognised answers "en". A board should render in a language it
   actually has strings for rather than trust a hand-edited file. */
function language(){
  const v = String(readSettings().language || "").toLowerCase();
  return LANGUAGES.includes(v) ? v : "en";
}

/* Temp-then-rename like writeStore, so a board reading mid-write sees the old
   file rather than half of the new one. No 0600 here — there is nothing
   secret in it, and a mode that says otherwise would misrepresent the file. */
function setLanguage(v){
  const want = String(v || "").toLowerCase();
  const lang = LANGUAGES.includes(want) ? want : "en";
  const next = { ...readSettings(), language: lang,
                 version: 1, updated: new Date().toISOString() };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

module.exports = { STORE_FILE, readStore, writeStore,
                   garageCookie, intrepidCookie, summary, clearStore,
                   mcpClient, mcpTokens, setMcpClient, setMcpTokens, clearMcp,
                   githubToken, setGithubToken,
                   publishToken, setPublishToken,
                   SETTINGS_FILE, LANGUAGES, readSettings, language, setLanguage };

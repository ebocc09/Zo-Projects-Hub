/* Garage's MCP endpoint, and the one credential that is not a cookie.

   Everything else this estate reads from Garage goes over the session cookie
   the Hub grabs. `lookup_user` is the exception — turning an AD username or a
   customer id into a display name. Garage's UI exposes no find-a-person route
   and six candidate shapes under /api/1/users all 404, so that one answer is
   only reachable over MCP, and MCP wants OAuth.

   Authorization code + PKCE against whatever authorization server Garage
   names, with dynamic client registration — nothing to obtain in advance and
   nothing to paste.

   ── who may do what ──

   The Hub MINTS: authorizeUrl, exchangeCode, signOut. It registers the client
   and performs the initial exchange, and it never refreshes.

   ZO-002 CONSUMES: accessToken. It refreshes when the access token is stale
   and writes the rotated pair back. It is the only board that speaks MCP, and
   therefore the only writer of rotations — see the long note in credstore.js
   for why that single-writer property is the whole safety argument, and what
   would have to change before a second consumer could exist.

   accessToken deliberately does NOT register a client. On a board, a missing
   registration means "the Hub has not signed in yet", and quietly registering
   a second client there would produce exactly the split-brain this arrangement
   exists to avoid.

   ── why the URL lives here rather than in each caller's config ──

   The `resource` parameter binds the token to one MCP endpoint (RFC 8707), so
   the Hub and the board have to agree on it exactly. Two config files that
   must match are two config files that will eventually not. One constant,
   copied with the module.                                                   */

"use strict";

const https  = require("https");
const crypto = require("crypto");

const credstore = require("./credstore");

const GARAGE_URL   = "https://garage.vn.teslamotors.com";
const SCOPE        = "garage:mcp offline_access";
const CLIENT_NAME  = "Zo Projects Hub";

/* Fixed, not derived from a port: registration and exchange must present the
   same redirect, and the Hub is the only thing that ever performs either. */
const REDIRECT_URI = "http://localhost:3100/callback";

const garageUrl = () => GARAGE_URL.replace(/\/+$/, "");
const mcpUrl    = () => garageUrl() + "/mcp";

function request(url, { method = "GET", headers = {}, body = null } = {}){
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on("error", reject);
    if(body) req.write(body);
    req.end();
  });
}

async function postForm(url, fields){
  const body = new URLSearchParams(fields).toString();
  return request(url, {
    method : "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded",
               "Content-Length": Buffer.byteLength(body),
               Accept: "application/json" },
    body
  });
}

const b64url = b => b.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const needsAuth = msg => {
  const err = new Error(msg);
  err.needsAuth = true;
  return err;
};

let AS_META = null;
let PENDING = null;      // { verifier, state } for the sign-in currently in flight

/* RFC 9728: ask the resource which authorization server it trusts, then read
   that server's metadata. */
async function discover(){
  if(AS_META) return AS_META;

  const pr = await request(garageUrl() + "/.well-known/oauth-protected-resource",
                           { headers: { Accept: "application/json" } });
  if(pr.status !== 200) throw new Error(`protected-resource discovery HTTP ${pr.status}`);
  const issuer = (JSON.parse(pr.body).authorization_servers || [])[0];
  if(!issuer) throw new Error("Garage did not advertise an authorization server");

  const as = await request(issuer.replace(/\/+$/, "") + "/.well-known/oauth-authorization-server",
                           { headers: { Accept: "application/json" } });
  if(as.status !== 200) throw new Error(`authorization-server discovery HTTP ${as.status}`);

  AS_META = JSON.parse(as.body);
  return AS_META;
}

/* Hub only — see the header. */
async function ensureClient(){
  const existing = credstore.mcpClient();
  if(existing && existing.client_id) return existing;

  const meta = await discover();
  if(!meta.registration_endpoint){
    throw new Error("Garage's authorization server does not offer dynamic client registration");
  }

  const body = JSON.stringify({
    client_name               : CLIENT_NAME,
    redirect_uris             : [REDIRECT_URI],
    grant_types               : ["authorization_code", "refresh_token"],
    response_types            : ["code"],
    token_endpoint_auth_method: "none",
    scope                     : SCOPE
  });

  const res = await request(meta.registration_endpoint, {
    method : "POST",
    headers: { "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body),
               Accept: "application/json" },
    body
  });
  if(res.status !== 200 && res.status !== 201){
    throw new Error(`Client registration failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  }

  const client = JSON.parse(res.body);
  credstore.setMcpClient(client);
  return client;
}

async function authorizeUrl(){
  const meta   = await discover();
  const client = await ensureClient();

  const verifier  = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));

  PENDING = { verifier, state };

  return meta.authorization_endpoint + "?" + new URLSearchParams({
    response_type        : "code",
    client_id            : client.client_id,
    redirect_uri         : REDIRECT_URI,
    scope                : SCOPE,
    state,
    code_challenge       : challenge,
    code_challenge_method: "S256",
    // RFC 8707 — bind the token to this MCP resource specifically.
    resource             : mcpUrl()
  }).toString();
}

function storeTokens(t, prev){
  const next = {
    access_token : t.access_token,
    // A refresh response may omit the refresh token, meaning "keep the one you
    // have". Dropping it would silently downgrade the session to one hour.
    refresh_token: t.refresh_token || (prev && prev.refresh_token) || null,
    // A minute early, so a call never lands on a token expiring mid-flight.
    expires_at   : Date.now() + ((t.expires_in || 3600) - 60) * 1000
  };
  credstore.setMcpTokens(next);
  return next;
}

async function exchangeCode(code, state){
  if(!PENDING || state !== PENDING.state){
    throw new Error("Sign-in state did not match — start the sign-in again");
  }
  const meta   = await discover();
  const client = await ensureClient();

  const res = await postForm(meta.token_endpoint, {
    grant_type   : "authorization_code",
    code,
    redirect_uri : REDIRECT_URI,
    client_id    : client.client_id,
    code_verifier: PENDING.verifier,
    resource     : mcpUrl()
  });
  PENDING = null;
  if(res.status !== 200){
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
  }
  storeTokens(JSON.parse(res.body), null);
  return true;
}

/* The consumer's entry point. Read from the store every time rather than
   cached at boot: the Hub can be signed in while a board is running, and a
   board that needed restarting to notice would make the whole arrangement
   feel broken. */
async function accessToken(){
  const tokens = credstore.mcpTokens();
  if(!tokens) throw needsAuth("Not signed in to Garage MCP — sign in on the Zo Projects Hub");

  if(tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;

  if(!tokens.refresh_token){
    throw needsAuth("Garage MCP session expired — sign in again on the Zo Projects Hub");
  }

  const client = credstore.mcpClient();
  if(!client || !client.client_id){
    // Tokens without a registration: the store was half-cleared. Refreshing is
    // impossible and registering here would create a second client.
    throw needsAuth("Garage MCP registration is missing — sign in again on the Zo Projects Hub");
  }

  const meta = await discover();
  const res  = await postForm(meta.token_endpoint, {
    grant_type   : "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id    : client.client_id,
    resource     : mcpUrl()
  });

  if(res.status !== 200){
    // Spent or revoked. Clearing the tokens but keeping the registration means
    // the next sign-in is one press rather than a re-registration, and stops
    // every later call repeating this same round trip to learn the same thing.
    credstore.setMcpTokens(null);
    throw needsAuth(`Garage MCP session expired (HTTP ${res.status}) — sign in again on the Zo Projects Hub`);
  }

  return storeTokens(JSON.parse(res.body), tokens).access_token;
}

/* Hub only. Drops the registration too: a client registered against a redirect
   the Hub no longer serves is worse than none, because it fails at the last
   step of a sign-in rather than the first. */
function signOut(){
  credstore.clearMcp();
  AS_META = null;
  PENDING = null;
  return { ok: true };
}

/* For the panel, without returning anything secret. */
function status(){
  const s = credstore.summary().garageMcp;
  return { ...s, resource: mcpUrl(), redirectUri: REDIRECT_URI };
}

module.exports = { authorizeUrl, exchangeCode, accessToken, signOut, status,
                   mcpUrl, garageUrl, GARAGE_URL, SCOPE, REDIRECT_URI };

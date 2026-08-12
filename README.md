# Zo Projects Hub · ZO-000

The board every other board hangs off. One way in, one sign-in, one serial per
dashboard.

```sh
node server.js            # http://localhost:3100
```

Zero dependencies, no build step.

---

## What it does, and what it deliberately does not

Three jobs:

1. Say what boards exist, what their serials are, and which are running.
2. Start and stop them.
3. Own the Garage and Intrepid sign-ins, write them where every board reads,
   and keep them alive — re-checking each session and reopening the one that
   has expired.

It knows **nothing** about what any board does. A board is a folder with a
`server.js` and a port. Anything more would mean every board being rewritten
against the hub, and the hub becoming the thing that breaks all of them.

---

## Serials

`ZO-000` upward, in order of first commit, never reused.

| Serial | Board | Port | Folder |
|---|---|---|---|
| **ZO-000** | Zo Projects Hub | 3100 | `.` |
| **ZO-001** | Charging Tracker | 3118 | `boards/charging-tracker` |
| **ZO-002** | FSD Tracker | 3120 | `boards/fsd-tracker` |
| **ZO-003** | DVP Scorecard | 3130 | `boards/dvp-scorecard` |
| **ZO-004** | The Compiler | 3131 | `boards/compiler` |
| **ZO-006** | Task Tracker | — | hosted on GitHub Pages |

The point is a short handle you can say out loud — "in ZO-002, change the
window to eight hours" — that survives a rename, a re-port or a move. Name and
port are both mutable; the serial is not. The hub is ZO-000 because giving it
001 would have renumbered everything the first time it was listed.

**There is no ZO-005.** It was a parking-spot mapper, built and dropped. The
serial goes with it rather than to the next board: a note saying "in ZO-005"
should resolve to one thing or to nothing, never to a different tool than the
one it meant.

**Adding a board:** one entry in `registry.js`. The registry's port and the
project's own `config.json` are two statements of the same fact and they
drift, so the hub reads the project's and reports the disagreement rather than
trusting its own.

### Boards hosted elsewhere

A board marked `external: true` carries a `url` instead of a folder and a
port. The hub lists it, links to it, and does not pretend to run it: no start,
no stop, no port probe — a TCP check against somebody else's server would only
ever measure our own network. It shows as **Hosted** rather than Running.

They are listed at all because the hub's job is to be the one way in to every
board, and a board being someone else's process does not change that.

---

## Sign in once, and only here

Admin (six-digit code, same as every board) owns four credentials:

| | What it is | What it buys |
|---|---|---|
| Garage · prod | session cookie | `garage.vn.teslamotors.com` |
| Garage · eng | session cookie | `garage.dev.teslamotors.com` |
| Intrepid | session cookie | `intrepidapi.tesla.com` |
| Garage · MCP | OAuth token | one call: username → display name |
| GitHub | personal access token | a hosted board syncing to its own repo |

The three cookies are grabbed the same way: **Connect** opens an isolated
Chrome profile with the debug port on, waits for the sign-in, and reads the
cookie back over CDP. They share one browser window, so a second Connect on
the same host usually needs no second sign-in.

**One press, not two.** The waiting happens server-side, in `signin.js`, and
the panel polls for the outcome — so signing in inside the window is the last
thing anyone has to do, and the row settles by itself. That also means the
panel, or the whole tab, can be closed mid-sign-in: the capture completes
regardless and the row is already connected when you come back.

A cookie that exists is not a session that works — Garage issues anonymous
visitors a `_garage_session` too — so a captured header is probed before it is
adopted, and an unchanged header is never re-probed. Those probes are the only
knowledge of any API in the Hub, and they buy "connected" meaning connected.

Garage's two environments are two hosts, and the sign-in has to go to the
right one — the cookie names are identical, so a window pointed at production
yields a production cookie no matter which row asked for it. Each row opens
its own host, and the cookie read prefers an exact host match over a
parent-domain one.

They are written to:

```
%LOCALAPPDATA%\ZoProjects\credentials.json
```

**No board has a sign-in of its own.** Each shows what it is reading and links
back here. That is the entire point: four dashboards with four Connect buttons
meant four sessions expiring on four different afternoons, and no way to tell
from one board why another had stopped working.

### Sessions are re-checked, and a dead one opens its own window

A cookie used to be probed once, at capture, and then trusted forever. The row
read `saved …a1b2c3d4` whether the session had died an hour ago or was fine, the
front page counted it as connected either way, and the first thing to notice an
expiry was a board taking a 401 in the middle of something.

Every five minutes the hub now re-probes all three cookies — the same cheap
request the capture uses, one per credential. Rows read `· checked` when the
answer was yes. **Two rejections in a row** marks a session expired, and the
sign-in window opens on its own.

Two rejections rather than one because Garage returns the occasional blip, and
one bad answer is not worth a browser window. And a probe that gets *no answer*
— dropped VPN, DNS hiccup, closed lid — is not a rejection at all: the row says
`· last check failed` and stays green. Nothing is red until a server has
actually looked at the credential and said no.

The window opens **once per expiry**, not once per sweep, so a session that
stays dead overnight does not stack up windows. Three cookies dying together —
one laptop, one SSO, the usual case — open one at a time rather than three tabs
racing the same debug port.

A dead cookie is never deleted from the store. A false positive that wiped a
working credential would be worse than the stale row this replaced, and a dead
value sitting in the file costs nothing.

**Admin › Sign-ins › Check now** runs a sweep immediately rather than waiting
out the interval. Three knobs in `config.json`:

```json
"healthCheckMs": 300000,
"healthStrikes": 2,
"autoReconnect": true
```

Set `autoReconnect` to `false` to keep the red row and the honest count without
the window — worth knowing if a cookie ever expires mid-screenshare.

Garage · MCP is left out of all of this. It reports its own expiry already, and
ZO-002 refreshes it on the next call, so there is nothing to detect and nothing
to fix.

### The GitHub token is the odd one

The others are read from the store by the boards themselves. This one nothing
reads — it is pasted into a board hosted elsewhere, which has no access to this
machine at all. So the hub's job for it is narrower: keep it somewhere that is
not a project folder, and hand it over on request. **Token** on that board's
tile copies it to the clipboard; **Admin › Sign-ins › Pasted by hand** sets it.

Handing it over is ungated, unlike everything else here, and that is deliberate
rather than an oversight. The hub binds `127.0.0.1`, so reaching that route
means already being on this machine — where the credentials file can simply be
opened. A gate would stop nobody it was not already too late for, and putting
the six-digit code in front of a button meant to be pressed the moment the page
opens is how a convenience gets abandoned. Setting it still needs the code.

### Why a file and not a service

Boards could ask the hub for credentials over HTTP. That would make the hub a
runtime dependency: with it closed, nothing works. A file has no such failure
mode — **delete the hub entirely and every board keeps running** on what was
last written.

### Why this is safe when sharing an OAuth client was not

Two boards briefly shared a Garage OAuth client and that was a real bug:
refreshing rotates the refresh token, so whichever board refreshed first
invalidated the other's copy. Session cookies do not rotate. Two readers of
the same cookie cannot interfere, and a copy going stale is a fact about the
session's age rather than about who read it last. Sharing a value is fine;
sharing a mutable registration was not.

The MCP token is a rotating credential in a shared file, so that argument does
not cover it and a second one is needed:

> The Hub **mints** and never refreshes. Exactly **one** board consumes and
> rotates — ZO-002, the only board that speaks MCP at all. One writer of
> rotations, so no copy can be invalidated underneath anyone.

A second MCP consumer would reproduce the original bug exactly. If one is ever
wanted, the refresh has to move somewhere single-writer first — reading the
key a second time is not enough. The rule is repeated in `credstore.js` beside
the key itself, which is where anyone about to break it will actually be.

### Precedence

Shared first, local second — and nothing writes local any more. A board's
`.connections.json` keeps its own settings (mode, chosen centre, thresholds)
and no longer holds a credential anyone can set from a UI. A hand-edited
cookie there is still read as a last resort, for a machine the Hub has never
run on, but it is a fallback rather than a feature: shared has to win, or
signing in centrally would quietly do nothing on a board with a stale local
copy.

---

## Starting boards

Launched **detached**, so a board outlives the hub: closing this should not
take down four dashboards someone is reading, and a board that dies should not
take the hub with it. Each board's output goes to `logs/<serial>.log` rather
than the hub's stdout, which would interleave five servers into one unreadable
stream.

Success is reported when the **port answers**, not when the process spawns — a
board that crashes on boot would otherwise look launched until someone clicked
it. Status is a TCP probe, so a board started by hand outside the hub shows as
running too.

Stopping is by port rather than by remembered pid, for the same reason:
whoever holds the port is the one to stop.

---

## MCP, and how little of it is left

All of these boards used to reach Garage over MCP — an OAuth client, a token
store, a refresh dance and a JSON-RPC handshake per board. Garage's own web
app reads the same data over its session cookie:

| What | Cookie endpoint |
|---|---|
| Index search | `/api/1/tesladex/search?type=…&query=…&fields[]=…&size=…&from=…` |
| Historical vitals | `/api/1/vehicles/<id>/vitals_snapshots/datatank_historical_vitals?fields[]=…&hours=…` |

Both verified against the MCP tools on identical queries — same totals, same
rows, same fields.

**MCP now survives in exactly one place:** `lookup_user`, in ZO-002, which
turns an AD username or a customer id into a display name. Garage's UI exposes
no find-a-person route and six candidate shapes under `/api/1/users` all 404,
so that one call still needs it. Everything else is cookies.

Its token is a Hub credential like the others — minted here, read from the
same file, listed in the same panel. ZO-002 no longer registers a client or
holds tokens of its own. Because the token is only worth names, a Hub with
that row unset costs display names and nothing else: every report still runs,
with usernames where names would be.

`garage-oauth.js` holds the flow and is copied into ZO-002, the same way
`credstore.js` is.

Two differences from the tools, both handled where the calls live:

- A bare `*:*` is refused as a full-text search. Health checks probe a real
  field instead.
- A dead session does not `401` — it redirects to SSO or returns the sign-in
  page under a `200`. Both read as "sign in again" rather than as a parse
  failure.

---

## Layout

```
zo-hub/
  config.json      port, the shipped admin code, session-check settings
  registry.js      every board, its serial, folder and port
  credstore.js     the shared credential store — copied into each board too
  connect.js       isolated sign-in window and the CDP cookie read
  signin.js        waiting for a sign-in to finish, and proving what it found
  probes.js        is this session alive — live / rejected / no answer
  health.js        re-probes the cookies on a timer, reopens a dead sign-in
  garage-oauth.js  the MCP token — copied into ZO-002, which consumes it
  server.js        launch, stop, status, admin, the OAuth callback
  index.html       the board — ZO-1, one file, no build
  logs/            per-board server output, one file per serial
  boards/
    charging-tracker/   ZO-001
    fsd-tracker/        ZO-002
    dvp-scorecard/      ZO-003
    compiler/           ZO-004
```

**One folder, one repo.** Each board was its own repository in the home
directory; they are now subtrees under `boards/` with their histories
preserved — the FSD audit work, the Charging Tracker OAuth removal and the
rest are all reachable from this repo's log. Paths resolve relative to this
folder rather than to a home directory, so the estate can be zipped, moved or
handed over with nothing outside it.

### Sharing it

Zip the folder. That is the whole procedure. What deliberately does *not*
travel with it:

- **Credentials.** They live in `%LOCALAPPDATA%\ZoProjects\credentials.json`,
  outside the project, and each board's local fallback is gitignored. A
  recipient signs in on their own Hub as themselves.
- **Runtime state** — chosen centre, caches, thresholds. Machine state, not
  something to hand over.

A recipient needs Node and nothing else; there are no dependencies to install
and no build step in any board.

`credstore.js` is **copied** into each project rather than required across
folders, so every board stays self-contained and runnable on its own.
Duplication is the price and it is the right one — the same trade already made
for `xlsx.js`, and now for `garage-oauth.js` into ZO-002.

The sign-in machinery itself is no longer copied anywhere. `connect.js` used
to live in all four boards; it exists once, here, because the Hub is the only
thing that opens a sign-in window.

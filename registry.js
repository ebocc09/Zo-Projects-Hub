/* Every board on the estate, with its serial.

   ── serials ──

   `ZO-001` upward, assigned in order of first commit and never reused. The
   point is a short, stable handle you can say out loud — "in ZO-002, change
   the window to eight hours" — that does not change when a board is renamed,
   re-ported or moved. Name and port are both mutable; the serial is not.

   The Hub is ZO-000 because it is the thing the others hang off, and giving
   it 001 would have renumbered everything the first time it was listed.

   ── adding a board ──

   One entry here. `dir` is relative to THIS folder, not to the user's home:
   every board lives under `boards/`, so the whole estate is one directory
   that can be zipped and handed over with nothing outside it and nothing to
   reconfigure on the other end.

   `port` must match that project's own config, and the Hub reports a mismatch
   rather than silently launching something on a port it will then fail to
   find.                                                                     */

"use strict";

const path = require("path");
const fs   = require("fs");

const ROOT = __dirname;

const BOARDS = [
  {
    serial: "ZO-000",
    name  : "Zo Projects Hub",
    dir   : ".",
    port  : 3100,
    blurb : "This board. Sign-ins, serials, and the way in to everything else.",
    self  : true
  },
  {
    serial: "ZO-001",
    name  : "Charging Tracker",
    dir   : "boards/charging-tracker",
    port  : 3118,
    blurb : "USOE and Supercharging across the fleet, live or cached.",
    sources: ["garage"]
  },
  {
    serial: "ZO-002",
    name  : "FSD Tracker",
    dir   : "boards/fsd-tracker",
    port  : 3120,
    blurb : "Miles customers drive on FSD in the twelve hours after handoff.",
    sources: ["garage", "intrepid"]
  },
  {
    serial: "ZO-003",
    name  : "DVP Scorecard",
    dir   : "boards/dvp-scorecard",
    port  : 3130,
    blurb : "Delivery CSAT joined to Intrepid on reference number.",
    sources: ["intrepid"]
  },
  {
    serial: "ZO-004",
    name  : "The Compiler",
    dir   : "boards/compiler",
    port  : 3131,
    blurb : "Service visits, containment and logistics holds across a centre.",
    sources: ["garage", "intrepid"]
  },
  /* ── hosted elsewhere ──
     Not a folder and not a port: Task Tracker lives on GitHub Pages and is
     always up whether this Hub is running or not. It is listed anyway because
     the Hub's job is to be the one way in to every board, and a board being
     somebody else's process does not change that.

     ZO-006 rather than ZO-005. Serials are assigned in order and never reused,
     and 005 belonged to a board that was tried and dropped. Handing it to a
     different tool would make the log lie about which board a note referred
     to, which is the exact failure serials exist to prevent. */
  {
    serial  : "ZO-006",
    name    : "Task Tracker",
    external: true,
    url     : "https://ebocc09.github.io/Task-Tracker/",
    blurb   : "Shared team board. Hosted on Pages; syncs with a GitHub token.",
    // Not a credential this board reads from the store — one it needs pasted
    // into its own sync field, which is what the Token button is for.
    needsToken: "github"
  }
];

const dirOf = b => path.join(ROOT, b.dir);

/* A board that is listed but not on disk is worth saying out loud rather than
   rendering as a dead tile: the usual cause is a folder renamed without the
   registry being told. */
function withState(b){
  /* An external board has no folder to be missing and no port to be wrong, so
     none of the checks below mean anything for it. Reporting it as "folder not
     found" would be the Hub inventing a fault in something it does not host. */
  if(b.external) return { ...b, present: true, entry: null, port: null,
                          portMismatch: false };

  const dir = dirOf(b);
  const present = fs.existsSync(dir);
  let entry = null;
  if(present){
    for(const f of ["server.js", "index.js"]){
      if(fs.existsSync(path.join(dir, f))){ entry = f; break; }
    }
  }

  /* The registry's port and the project's own config are two statements of
     the same fact, and they drift. Read theirs and report the disagreement
     instead of trusting ours. */
  let configPort = null;
  try{
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    if(cfg && cfg.port) configPort = Number(cfg.port);
  }catch{ /* not every board keeps a config.json */ }

  return { ...b, dir, present, entry,
           port: configPort || b.port,
           portMismatch: Boolean(configPort && configPort !== b.port) };
}

const boards = () => BOARDS.map(withState);
const bySerial = s => boards().find(b => b.serial === String(s || "").toUpperCase());

module.exports = { boards, bySerial, ROOT };

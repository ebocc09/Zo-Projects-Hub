/* Runs the page's paintBoard() against a real API response in a DOM stub.

   A syntax check cannot catch "fmt called without a person" — only executing
   the render can. This exists because exactly that shipped once.             */

"use strict";
const fs = require("fs");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const src  = html.match(/<script>([\s\S]*)<\/script>/)[1];
const data = JSON.parse(fs.readFileSync(process.argv[2] || "/tmp/dvp-api.json", "utf8"));

const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const made = {};
const el = id => made[id] || (made[id] = {
  id, value: "", textContent: "", innerHTML: "", hidden: false, disabled: false,
  className: "", style: {}, dataset: {}, files: [],
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  addEventListener(){}, removeEventListener(){},
  querySelector(){ return el(id + ":q"); },
  querySelectorAll(){ return []; },
  insertAdjacentHTML(){}, appendChild(){}, remove(){}, focus(){}, select(){}, click(){}
});

global.document = {
  getElementById: id => (ids.has(id) ? el(id) : null),
  querySelectorAll: () => [], querySelector: () => null,
  addEventListener(){}, createElement: () => el("new"),
  body: el("body")
};
global.window = { addEventListener(){}, open: () => null, location: {} };
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), headers: { get(){ return null; } } });
global.setTimeout = f => 0; global.setInterval = () => 0;
global.clearInterval = () => {}; global.clearTimeout = () => {};

/* Expose the page's internals so we can drive render() directly. */
const mod = new Function(src + "\n;return { render, paintBoard, S, visible };")();

mod.render(data);
const table = el("board").innerHTML;

// \b so "<thead" is not counted as a "<th"
const rows    = (table.match(/<tr\b/g) || []).length;
const headers = (table.match(/<th\b/g) || []).length;
const cells   = (table.match(/<td\b/g) || []).length;
// Everyone is shown now — thin samples are marked, not filtered out.
const people  = data.people.length;

/* The table has no horizontal scroll, so the declared widths must total 100%
   or the layout drifts. */
const widthPcts = [...table.matchAll(/width:(\d+(?:\.\d+)?)%/g)].map(m => +m[1]);
const declared = widthPcts.reduce((a, w) => a + w, 0);
const cssLead = (html.match(/\.sc \.lead\{width:(\d+)%/) || [])[1];
const cssRk   = (html.match(/\.sc \.rk\{width:(\d+)%/) || [])[1];
console.log("  column widths: metrics", declared + "% + name " + cssLead + "% + rank " + cssRk + "% =",
  declared + Number(cssLead || 0) + Number(cssRk || 0) + "%");

console.log("render: OK, no throw");
console.log("  <tr>", rows, " <th>", headers, " <td>", cells);
console.log("  expected rows: 2 header + 1 avg +", people, "people =", 3 + people);
console.log("  row count matches:", rows === 3 + people ? "yes" : "NO — " + rows);

/* Every body row must have the same cell count as the header, or the grid shears. */
const bodyRows = table.split("<tr").slice(1).map(r => (r.match(/<td/g) || []).length).filter(n => n > 0);
const widths = [...new Set(bodyRows)];
console.log("  cells per row:", widths.join(", "), widths.length === 1 ? "(uniform)" : "*** RAGGED ***");

console.log("  'undefined' leaked into output:", /undefined/.test(table) ? "*** YES ***" : "no");
console.log("  'NaN' leaked into output:", /NaN/.test(table) ? "*** YES ***" : "no");

/* Every metric cell that HAS a value is tinted, in every sort — a plain cell
   with a number in it reads as broken. Cells showing "—" (someone who only
   washes has no cleanliness score) are legitimately untinted, so the target is
   the count of non-null values rather than rows x columns. */
/* Derived from the header rather than hardcoded, so adding a metric column
   keeps the assertion honest instead of quietly passing on a stale count. */
const metricCols = widthPcts.length;
const want = data.people.length * metricCols;   // every metric cell tinted, blanks included
console.log("  metric columns:", metricCols);

for(const sort of ["contribution", "weighted", "cars", "washed", "vri", "caught", "missed"]){
  mod.S.sort = sort;
  try { mod.paintBoard(); }
  catch(e){ console.log(`  *** THREW: sort=${sort} — ${e.message}`); process.exit(1); }
  const out = el("board").innerHTML;
  const tinted = (out.match(/tint-(good|bad)/g) || []).length;
  console.log(`  sort=${sort}: ${tinted}/${want} metric cells tinted`,
    tinted === want ? "(all)" : "*** SOME PLAIN ***");
}
const dashes = (el("board").innerHTML.match(/>—</g) || []).length;
console.log(`  cells showing "—" (no value):`, dashes);

/* No rows at all — an upload that credits nobody. */
mod.S.people = [];
try { mod.paintBoard(); console.log("  empty board: no throw"); }
catch(e){ console.log("  *** THREW on empty board:", e.message); process.exit(1); }

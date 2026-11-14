// M6.6 rules review (d): figures read from a contributor list capped at 500 rows never read as complete
// when the list was cut; figures that showed no basis, population, coverage or limitation now say it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const C = await import("../src/analytics/model/capped.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const row = (ref, value) => ({ ref, value, ticket: null, at_ms: 0 });

// A page as the snapshot holds it: 500 rows of a figure that has 812.
const truncated = { items: Array.from({ length: 500 }, (_, i) => row(`visit:T${i}/verify#${(i % 3) + 1}`, i % 5 ? 1000 : null)), total: 812, order: "impact", truncated: true };
const whole = { items: truncated.items.slice(0, 40), total: 40, order: "impact", truncated: false };

test("a page is cut when the observer says so or holds fewer rows than its total", () => {
  assert.equal(C.pageCut(truncated), true);
  assert.equal(C.pageCut({ ...truncated, truncated: false }), true, "total above the rows held");
  assert.equal(C.pageCut(whole), false);
  assert.equal(C.pageCut(undefined), false);
});

test("Flow 'Visits after the first' (Flow.tsx:240-258): exact from a whole list, 'at least' with the cap from a cut one", () => {
  const later = (r) => /#([2-9]|\d\d)$/.test(r.ref);
  const exact = C.cappedCount(whole, later);
  assert.equal(exact.atLeast, false);
  assert.equal(C.cappedText(exact), String(exact.n));
  const cut = C.cappedCount(truncated, later);
  assert.equal(cut.atLeast, true);
  assert.equal(C.cappedText(cut), `at least ${cut.n} (the list is cut at 500 rows)`);
  assert.match(src("analytics/ui/areas/Flow.tsx"), /\["Visits after the first", cappedText\(later, count\)\]/);
});

test("Flow open counts (diagram, waits, human approval): the reply's basis count first; from a cut list only as a lower bound", () => {
  const open = (r) => r.value === null;
  assert.deepEqual(C.countOr(37, truncated, open), { n: 37, atLeast: false }, "the metric's basis_counts.open wins");
  assert.deepEqual(C.countOr(null, truncated, open), { n: 100, atLeast: true });
  assert.deepEqual(C.countOr(undefined, whole, open), { n: 8, atLeast: false });
  const flow = src("analytics/ui/areas/Flow.tsx");
  assert.match(flow, /countOr\(g\.basis_counts\?\.open, page/);
  assert.match(flow, /countOr\(t\.W3\?\.basis_counts\?\.open, s\.contributors\.W3/);
  assert.match(flow, /openAtLeast: openC\.atLeast/);
  assert.match(src("analytics/ui/charts/index.tsx"), /r\.openAtLeast \? "at least " : ""/);
});

test("Economics 'Executions by recorded cost' (Economics.tsx:279-292): a cut list draws its rows and says how many of the reply's total", () => {
  const eco = src("analytics/ui/areas/Economics.tsx");
  assert.match(eco, /cut=\{pageCut\(s\.contributors\.K1\)\}/);
  assert.match(eco, /The list behind these bins is cut at \$\{LIST_CAP\} rows: \$\{values\.length\} of \$\{withCost \?\? "more"\} executions with a recorded cost are drawn, so the bins are lower bounds\./);
  assert.match(eco, /withCost=\{k1\?\.coverage\.covered \?\? null\}/, "the count with a cost is the reply's, not the list's");
});

test("Compare dot strips (Compare.tsx:133-134): a ticket missing from a cut list is 'not placed', never 'without a recorded value'", () => {
  const cmp = src("analytics/ui/areas/Compare.tsx");
  assert.match(cmp, /cut=\{pageCut\(s\.contributors\.C3\)\}/);
  assert.match(cmp, /cut=\{pageCut\(s\.contributors\.K4\)\}/);
  assert.match(cmp, /not placed \(without a value in the list; the list is cut at \$\{LIST_CAP\} rows, so some may have one\)/);
  assert.match(cmp, /with no recorded rounds not counted/);
});

test("run-record figures say their basis and the merged tickets they leave out", () => {
  assert.equal(C.runRecordFoot(10, 10), "From the run records cleanup writes, one per finished ticket.");
  assert.equal(C.runRecordFoot(10, 12), "From the run records cleanup writes, one per finished ticket; 2 merged tickets with no run record are not in it.");
  assert.equal(C.runRecordFoot(10, null, "; x"), "From the run records cleanup writes, one per finished ticket; x.");
  assert.match(src("analytics/ui/areas/Pulse.tsx"), /chart="pulse-first-pass" foot=\{runRecordFoot\(/);
  assert.match(src("analytics/ui/areas/Quality.tsx"), /runRecordFoot\(merged\.length, t\.T1\?\.numerator_value \?\? null\)/);
});

test("labels the review found missing are on screen", () => {
  const pulse = src("analytics/ui/areas/Pulse.tsx");
  assert.match(pulse, /plural\(executions, "execution"\)\} claimed/, "X1's denominator, said");
  assert.match(pulse, /Base: the executions claimed in this window \(X1's denominator\)/);
  assert.match(pulse, /coverage \{coverageText\(st\.row\.coverage\)\}/, "the ladder step's coverage");
  const flow = src("analytics/ui/areas/Flow.tsx");
  assert.match(flow, /Measured visits only \(C1, from the cell's lifecycle log\)/);
  assert.match(flow, /Measured waits only: a wait still open is not counted\./);
  assert.match(flow, /Station read from the agent's label\{agents\.coverage\.share/);
  const q = src("analytics/ui/areas/Quality.tsx");
  assert.match(q, /Q4, a count only and partial/);
  assert.match(q, /R2, reconstructed from the review records/);
  const eco = src("analytics/ui/areas/Economics.tsx");
  assert.match(eco, /Per-model usage from the execution stream \(K2, K3\)/);
  assert.match(eco, /coverage \$\{coverageText\(t\.K3\.coverage\)\}/);
});

test("integration is not acceptance: the standing note, and the Economics block is 'Cost beside integrated work'", () => {
  assert.match(src("analytics/ui/areas/shared.tsx"), /ACCEPTANCE_NOTE = "MACH records integration, not business acceptance\."/);
  assert.match(src("analytics/ui/areas/Pulse.tsx"), /“Accepted delivery” \(T2\); it counts commits on the integration branch\. \{ACCEPTANCE_NOTE\}/);
  const eco = src("analytics/ui/areas/Economics.tsx");
  assert.match(eco, /title="Cost beside integrated work"/);
  assert.doesNotMatch(eco, /verified delivery/);
  assert.match(eco, /A cost is counted on the day its execution completed/);
  assert.doesNotMatch(eco, /Cost is recorded when an execution is claimed/);
});

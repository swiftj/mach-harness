// M6.5.2 Factory Analytics prototype: the seeded simulated observer (src/analytics/fixtures/).
// Deterministic; IDs and names held to the observer's catalog; the recorded limit never exceeded;
// missing values kept apart from zero; the observe scorecard's formulas reproduced from the runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const F = await import("../src/analytics/fixtures/index.ts");
const { CATALOG } = await import("../src/analytics/fixtures/catalog.ts");
const C = await import("../src/analytics/contract.ts");

const ALL = { window: "all", risk: null, app_type: null, model: null };
const W28 = { window: "28d", risk: null, app_type: null, model: null };

test("the same seed gives the same history and the same snapshot, byte for byte", () => {
  const a = JSON.stringify(F.generateHistory({ seed: 6502 }));
  const b = JSON.stringify(F.generateHistory({ seed: 6502 }));
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify(F.generateHistory({ seed: 7 })));
  assert.equal(JSON.stringify(F.simulatedSnapshot(W28, { seed: 99 })), JSON.stringify(F.simulatedSnapshot(W28, { seed: 99 })));
});

test("the history holds what the prototype must show: retries, failures, interruptions, unknown outcomes, people's waits, missing cost and usage", () => {
  const h = F.historyFor({});
  const outcomes = new Set(h.executions.map((e) => e.outcome));
  for (const o of ["completed", "failed", "interrupted", "unknown"]) assert.ok(outcomes.has(o), o);
  assert.ok(h.executions.some((e) => e.attempt > 1), "a retry");
  assert.ok(h.executions.some((e) => e.costUsd === null), "an execution without a recorded cost");
  assert.ok(h.executions.some((e) => e.usage === null), "an execution without usage");
  assert.ok(h.waits.some((w) => w.kind === "human"), "a person's approval wait");
  assert.ok(h.waits.some((w) => w.kind === "capacity"), "a capacity hold");
  assert.ok(h.tickets.some((t) => !t.lifecycle), "a cell without a lifecycle log");
  assert.ok(h.tickets.some((t) => t.writer === "hand"), "hand-driven work");
  assert.ok(h.tickets.some((t) => t.outcome.startsWith("escalated")), "an escalation");
  assert.ok(new Set(h.executions.map((e) => e.costUsd)).size > 20, "costs vary");
});

test("catalog IDs, names, kinds and targets are the observer's (catalog.go), in its order", () => {
  const go = readFileSync(new URL("../../../../apps/observer/internal/metrics/catalog.go", import.meta.url), "utf8");
  const rows = [...go.matchAll(/\{ID: "([A-Za-z0-9]+)", Name: "([^"]+)", Kind: "(\w+)"/g)].map((m) => ({ id: m[1], name: m[2], kind: m[3] }));
  assert.equal(rows.length, CATALOG.length);
  rows.forEach((r, i) => assert.deepEqual({ id: CATALOG[i].id, name: CATALOG[i].name, kind: CATALOG[i].kind }, r));
  assert.deepEqual([...C.METRIC_IDS], rows.map((r) => r.id));
  for (const [, id, target] of go.matchAll(/ID: "(\w+)"[^\n]*Target: "([^"]+)"/g)) assert.equal(CATALOG.find((d) => d.id === id).target, target, id);
});

test("the bucket function is the observer's", () => {
  assert.equal(F.bucketOf(999), 0);
  assert.equal(F.bucketOf(1000), 1);
  assert.equal(F.bucketOf(2000), 4);
  assert.equal(F.bucketOf(30 * 86_400_000), 63);
  assert.equal(Math.round(F.bucketUpper(3)), 2000);
});

test("supervised executions never exceed the recorded max_parallel", () => {
  for (const seed of [6502, 1, 42]) {
    const h = F.generateHistory({ seed });
    const edges = h.executions.flatMap((e) => [[e.claimedAt, 1], [e.endedAt, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let n = 0;
    for (const [t, d] of edges) {
      n += d;
      const limit = h.limits.find((l) => t >= l.from && t < l.to)?.value ?? h.limits.at(-1).value;
      assert.ok(n <= limit, `seed ${seed}: ${n} running at ${new Date(t).toISOString()}, limit ${limit}`);
    }
  }
});

test("every row is honest about missing values: null with a reason, never 0; coverage counts the gaps", () => {
  const s = F.simulatedSnapshot(W28);
  for (const row of Object.values(s.totals)) {
    assert.ok(["measured", "inferred", "bounded", "open", "unknown", "not-recorded"].includes(row.basis), row.id);
    if (row.value === null) assert.ok(row.null_reason, `${row.id} has no value and no reason`);
  }
  assert.equal(s.totals.K5.value, null);
  assert.equal(s.totals.K5.basis, "not-recorded");
  const k1 = s.totals.K1;
  assert.equal(k1.denominator_value, k1.coverage.covered, "K1's mean is over executions with a cost only");
  assert.equal(k1.coverage.eligible - k1.coverage.counted, k1.coverage.excluded.reduce((n, x) => n + x.count, 0), "every excluded member has a reason");
  const c1 = s.totals.C1;
  assert.equal(c1.sample_count, c1.basis_counts.measured, "durations average measured visits only");
  assert.ok(c1.basis_counts.open + c1.basis_counts.unknown > 0, "open and unknown visits are counted apart");
  assert.equal(c1.distribution.histogram.reduce((n, b) => n + b.count, 0), c1.sample_count);
  assert.ok(k1.coverage.of > k1.coverage.covered);
  const nulls = s.contributors.K1.items.filter((c) => c.value === null);
  assert.equal(nulls.length, k1.coverage.of - k1.coverage.covered, "each execution without a cost is listed, with value null");
  assert.ok(nulls.every((c) => c.basis === "not-recorded"));
});

test("the observe scorecard (Q2, Q3, R5, R6, G1, G2) uses observe.py's formulas over the run records", () => {
  const s = F.simulatedSnapshot(ALL);
  const runs = s.runs;
  const merged = runs.filter((r) => r.outcome === "merged");
  const r3 = (v) => Math.round(v * 1000) / 1000;
  assert.equal(s.totals.Q2.value, r3(merged.filter((r) => r.first_pass).length / merged.length));
  assert.equal(s.totals.Q3.value, r3(merged.reduce((n, r) => n + r.rounds, 0) / merged.length));
  assert.equal(s.totals.R5.value, r3(runs.filter((r) => r.escalated).length / runs.length));
  assert.equal(s.totals.R6.value, r3(runs.filter((r) => r.outcome === "abandoned").length / runs.length));
  const ff = runs.reduce((n, r) => n + r.tests_seen_failing_first, 0);
  const fp = runs.reduce((n, r) => n + r.tests_passing_on_first_run, 0);
  assert.equal(s.totals.G1.value, r3(ff / (ff + fp)));
  assert.equal(s.totals.G2.value, r3(runs.reduce((n, r) => n + r.deviations, 0) / runs.length));
  assert.equal(s.totals.Q2.met, s.totals.Q2.value > 0.85);
});

test("filters: risk narrows ticket facts; a filter a metric cannot honour makes it unavailable, never silently unfiltered", () => {
  const all = F.simulatedSnapshot(W28);
  const high = F.simulatedSnapshot({ ...W28, risk: "high" });
  assert.ok(high.runs.every((r) => r.risk === "high"));
  assert.ok(high.totals.T1.numerator_value < all.totals.T1.numerator_value);
  const opus = F.simulatedSnapshot({ ...W28, model: "opus" });
  for (const id of ["T1", "K1", "Q2"]) {
    assert.equal(opus.totals[id].status, "unavailable", `${id} is not recorded per model`);
    assert.equal(opus.totals[id].value, null);
    assert.match(opus.totals[id].null_reason, /cannot be narrowed/);
  }
  assert.equal(opus.totals.K2.status, "available");
  assert.deepEqual(opus.grouped["K2|model"].groups.map((g) => g.key), ["opus"]);
});

test("sparse mode is a project with two finished runs; no-log mode records no station figures", () => {
  const sp = F.simulatedSnapshot(ALL, { size: "sparse" });
  assert.equal(sp.runs.length, 2);
  const nl = F.simulatedSnapshot(W28, { coverage: "lifecycle-missing" });
  assert.equal(nl.totals.C1.basis, "not-recorded");
  assert.equal(nl.totals.C1.value, null);
  assert.deepEqual(nl.transitions, []);
  assert.ok(!nl.concurrency.lines.some((l) => l.kind === "visit"), "no station-visit line without a log: absent, not zero");
  assert.notEqual(nl.totals.T2.value, null, "intake-log figures stay");
});

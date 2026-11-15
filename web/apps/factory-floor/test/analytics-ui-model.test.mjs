// M6.5 Factory Analytics, the areas' pure models (src/analytics/model/sample.ts, series.ts,
// pulse.ts, cohorts.ts): documented minimums, density, day and week series, the brush, keyboard
// movement between marks, sorting and paging, Pulse's arrangements and Compare's cohorts.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const Sm = await import("../src/analytics/model/sample.ts");
const Se = await import("../src/analytics/model/series.ts");
const P = await import("../src/analytics/model/pulse.ts");
const Co = await import("../src/analytics/model/cohorts.ts");
const F = await import("../src/analytics/fixtures/index.ts");

const D = 86_400_000;
const ALL = { window: "all", risk: null, app_type: null, model: null };
const W28 = { ...ALL, window: "28d" };
const run = (id, o = {}) => ({ ticket_id: id, record_version: 2, outcome: "merged", rounds: 1, first_pass: true, verify_failures: 0, review_rejections: 0, escalated: false, human_approval: false, deviations: 0, blockers: 0, tests_seen_failing_first: 0, tests_passing_on_first_run: 0, closed_at: { ms: 0 }, event_id: id, ...o });

test("minimums: medians from two, the 90th from ten, verdicts and comparisons from five", () => {
  assert.deepEqual(Sm.durationShows(0), { single: false, median: false, p90: false, mean: false });
  assert.deepEqual(Sm.durationShows(1), { single: true, median: false, p90: false, mean: false });
  assert.deepEqual(Sm.durationShows(4), { single: false, median: true, p90: false, mean: true });
  assert.equal(Sm.durationShows(10).p90, true);
  assert.equal(Sm.verdictAllowed(4), false);
  assert.equal(Sm.verdictAllowed(5), true);
  assert.equal(Sm.comparisonAllowed(5, 4), false);
  assert.equal(Sm.comparisonAllowed(5, 9), true);
});

test("shareText: k of n below five, a percentage from five, none over nothing", () => {
  assert.equal(Sm.shareText(1, 1), "1 of 1");
  assert.equal(Sm.shareText(3, 4), "3 of 4");
  assert.equal(Sm.shareText(37, 55), "67%");
  assert.equal(Sm.shareText(1, 88), "1.1%");
  assert.equal(Sm.shareText(0, 0), "none");
});

test("density: empty, single, few and many from what was recorded", () => {
  const empty = { runs: [], totals: {}, transitions: [] };
  assert.equal(Sm.densityOf(empty), "empty");
  assert.equal(Sm.densityOf({ ...empty, totals: { X1: { denominator_value: 2 } } }), "few", "executions without a finished run are not empty");
  assert.equal(Sm.densityOf({ ...empty, runs: [run("A")] }), "single");
  const sparse = F.simulatedSnapshot(ALL, { size: "sparse" });
  assert.equal(Sm.densityOf(sparse), "few");
  assert.equal(Sm.densityOf(F.simulatedSnapshot(W28)), "many");
});

test("grain: days up to sixty, weeks beyond", () => {
  assert.equal(Se.grainFor(0, 28 * D), "day");
  assert.equal(Se.grainFor(0, 60 * D), "day");
  assert.equal(Se.grainFor(0, 61 * D), "week");
});

test("periodSeries rolls days into whole weeks ending at the window's end, summing, never averaging rates", () => {
  const from = Date.UTC(2026, 9, 1);
  const to = from + 14 * D;
  const day = (i) => new Date(from + i * D).toISOString().slice(0, 10);
  const rate = { kind: "rate", status: "available", groups: [{ key: day(0), value: 1, numerator: 1, denominator: 1 }, { key: day(1), value: 0.25, numerator: 1, denominator: 4 }, { key: day(9), value: 0.5, numerator: 2, denominator: 4 }] };
  const weeks = Se.periodSeries(rate, from, to, "week");
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].numerator, 2);
  assert.equal(weeks[0].denominator, 5);
  assert.equal(weeks[0].value, 2 / 5, "summed numerator over summed denominator, not the mean of 1 and 0.25");
  assert.equal(weeks[1].to, to);
  const count = { kind: "count", status: "available", groups: [{ key: day(3), value: 2, numerator: 2, denominator: null }] };
  const cw = Se.periodSeries(count, from, to, "week");
  assert.deepEqual(cw.map((w) => w.value), [2, 0], "an answered count is zero on an empty week");
  const nr = Se.periodSeries({ kind: "count", status: "not-recorded", groups: [] }, from, to, "week");
  assert.deepEqual(nr.map((w) => w.value), [null, null], "a count with no answer has no weeks, not zero weeks");
  const days = Se.periodSeries(count, from, to, "day");
  assert.equal(days.length, 14);
  assert.equal(days[3].value, 2);
});

test("a short first week says how many days it holds", () => {
  const from = Date.UTC(2026, 9, 1);
  const to = from + 10 * D;
  const w = Se.periodSeries({ kind: "count", status: "available", groups: [] }, from, to, "week");
  assert.deepEqual(w.map((x) => x.days), [3, 7]);
});

test("brush: a drag snaps outward to whole periods; a click is not a range", () => {
  assert.equal(Se.brushIndices(10, 12, 0, 100, 10), null);
  assert.deepEqual(Se.brushIndices(15, 42, 0, 100, 10), { first: 1, last: 4 });
  assert.deepEqual(Se.brushIndices(42, 15, 0, 100, 10), { first: 1, last: 4 }, "either direction");
  assert.deepEqual(Se.brushIndices(-50, 500, 0, 100, 10), { first: 0, last: 9 }, "clamped to the plot");
  const periods = [{ from: 0, to: D }, { from: D, to: 2 * D }, { from: 2 * D, to: 3 * D }];
  assert.deepEqual(Se.brushWindow(periods, 2, 1), { from: D, to: 3 * D });
  assert.equal(Se.brushWindow(periods, 5, 6), null);
});

test("nextMark: arrows move within a chart, Home and End jump, other keys are left alone", () => {
  assert.equal(Se.nextMark(0, "ArrowRight", 5), 1);
  assert.equal(Se.nextMark(4, "ArrowRight", 5), 4);
  assert.equal(Se.nextMark(0, "ArrowLeft", 5), 0);
  assert.equal(Se.nextMark(2, "End", 5), 4);
  assert.equal(Se.nextMark(2, "Home", 5), 0);
  assert.equal(Se.nextMark(1, "ArrowDown", 6, 3), 4);
  assert.equal(Se.nextMark(4, "ArrowUp", 6, 3), 1);
  assert.equal(Se.nextMark(1, "Tab", 5), null);
  assert.equal(Se.nextMark(0, "ArrowRight", 0), null);
});

test("sortRows: either direction, nulls always last, ties by key", () => {
  const rows = [{ k: "b", v: 2 }, { k: "a", v: null }, { k: "c", v: 2 }, { k: "d", v: 9 }];
  const by = (dir) => Se.sortRows(rows, (r) => r.v, dir, (r) => r.k).map((r) => r.k);
  assert.deepEqual(by("desc"), ["d", "b", "c", "a"]);
  assert.deepEqual(by("asc"), ["b", "c", "d", "a"]);
});

test("pageOf: pages are whole and clamped", () => {
  const rows = Array.from({ length: 23 }, (_, i) => i);
  const p = Se.pageOf(rows, 2, 10);
  assert.deepEqual(p.items, [20, 21, 22]);
  assert.equal(p.pages, 3);
  assert.deepEqual([p.from, p.to], [21, 23]);
  assert.equal(Se.pageOf(rows, 9, 10).page, 2);
  assert.deepEqual(Se.pageOf([], 0, 10), { items: [], page: 0, pages: 1, from: 0, to: 0 });
});

test("beltShares: stations in belt order, shares of one whole, no human wait", () => {
  const s = F.simulatedSnapshot(W28);
  const b = P.beltShares(s.grouped["C1|station"]);
  const order = ["groom", "plan", "audit", "build", "verify", "review", "merge", "cleanup"];
  assert.deepEqual(b.map((x) => x.station), order.filter((st) => b.some((x) => x.station === st)));
  assert.ok(Math.abs(b.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
  assert.equal(P.beltShares(undefined).length, 0);
});

test("outcomePartition: completed, failed, interrupted and unknown divide the claims, the rest has no end recorded", () => {
  const s = F.simulatedSnapshot(W28);
  const p = P.outcomePartition(s);
  assert.equal(p.partition, true);
  assert.equal(p.missing, null);
  assert.equal(p.parts.reduce((n, x) => n + x.count, 0), p.claimed);
  assert.equal(p.claimed, s.totals.X1.denominator_value);
  assert.equal(p.parts.find((x) => x.key === "completed").count, s.totals.S3.numerator_value);
});

test("outcomePartition refuses a strip when counts overlap, and says when nothing is recorded", () => {
  const row = (num, den) => ({ numerator_value: num, denominator_value: den, status: "available", basis: "measured" });
  const base = { totals: { X1: row(1, 10), S3: row(9, 10), S2: row(2, 10), S1: row(0, 10) }, grouped: { "S1|kind": { groups: [] } } };
  const over = P.outcomePartition(base);
  assert.equal(over.partition, false, "9 + 1 + 2 > 10: not parts of one whole");
  assert.equal(over.missing, null);
  const none = P.outcomePartition({ totals: { X1: row(0, 0) }, grouped: {} });
  assert.match(none.missing, /no execution/);
  const nr = P.outcomePartition({ totals: { X1: row(1, 4), S3: row(null, null), S2: row(0, 4) }, grouped: {} });
  assert.match(nr.missing, /not recorded/);
  const open = P.outcomePartition({ totals: { X1: row(0, 10), S3: row(6, 6), S2: row(1, 10), S1: row(0, 10) }, grouped: { "S1|kind": { groups: [] } } });
  assert.deepEqual(open.parts.at(-1), { key: "open", count: 3 });
});

test("costSeries: recorded dollars and the executions that recorded none, per day or week", () => {
  const s = F.simulatedSnapshot(W28);
  const days = P.costSeries(s.grouped["K1|day"], s.window.from_ms, s.window.to_ms, "day");
  assert.equal(days.length, Math.ceil((s.window.to_ms - Math.floor(s.window.from_ms / D) * D) / D), "every UTC day the window touches");
  const total = days.reduce((n, d) => n + d.cost, 0);
  assert.ok(Math.abs(total - s.totals.K1.numerator_value) < 1e-6);
  const without = days.reduce((n, d) => n + d.without, 0);
  assert.equal(without, s.totals.K1.coverage.of - s.totals.K1.coverage.covered);
  const weeks = P.costSeries(s.grouped["K1|day"], s.window.from_ms, s.window.to_ms, "week");
  assert.ok(weeks.length >= 4 && weeks.length <= 5);
  assert.ok(Math.abs(weeks.reduce((n, d) => n + d.cost, 0) - total) < 1e-6);
  assert.equal(weeks.reduce((n, d) => n + d.without, 0), without);
  const nr = P.costSeries({ kind: "mean", status: "unavailable", groups: [] }, s.window.from_ms, s.window.to_ms, "day");
  assert.ok(nr.every((d) => d.cost === null), "no answer is not zero dollars");
});

test("configOf: one id, not recorded, or more than one, never merged", () => {
  assert.equal(Co.configOf("A", { A: ["c1", "c1"] }), "c1");
  assert.equal(Co.configOf("A", { A: [null, null] }), Co.NOT_RECORDED);
  assert.equal(Co.configOf("A", {}), Co.NOT_RECORDED);
  assert.equal(Co.configOf("A", undefined), Co.NOT_RECORDED);
  assert.equal(Co.configOf("A", { A: ["c1", null] }), Co.MIXED, "partly recorded is not the recorded one");
  assert.equal(Co.configOf("A", { A: ["c1", "c2"] }), Co.MIXED);
});

test("cohortOptions: every cohort present, special cohorts last and kept apart", () => {
  const runs = [run("A"), run("B"), run("C"), run("D"), run("E")];
  const configs = { A: ["c1"], B: ["c1"], C: ["c2"], D: [null], E: ["c1", null] };
  const o = Co.cohortOptions("config", runs, configs, 0);
  assert.deepEqual(o.map((x) => [x.key, x.runs]), [["c1", 2], ["c2", 1], ["mixed", 1], ["not-recorded", 1]]);
  assert.equal(o[0].code, true);
  assert.equal(o.at(-1).label, "Configuration not recorded");
  assert.deepEqual(Co.cohortRuns("config", "not-recorded", runs, configs, 0).map((r) => r.ticket_id), ["D"]);
  assert.deepEqual(Co.defaultPair(o), ["c1", "c2"]);
});

test("cohorts by risk keep belt order and an explicit unknown; by period split at the middle", () => {
  const runs = [run("A", { risk: "high" }), run("B", { risk: "low" }), run("C"), run("D", { risk: "low", closed_at: { ms: 10 } })];
  assert.deepEqual(Co.cohortOptions("risk", runs, undefined, 5).map((x) => x.key), ["low", "high", "unknown"]);
  const p = Co.cohortOptions("period", runs, undefined, 5);
  assert.deepEqual(p.map((x) => [x.key, x.runs]), [["earlier", 3], ["later", 1]]);
  assert.equal(Co.cohortLabel("risk", "unknown"), "Risk not recorded");
});

test("simulatedInsights: the simulation's findings in the observer's reply shape, words in display, no number invented", async () => {
  const { simulatedInsights } = await import("../src/analytics/model/insights.ts");
  const { findings } = await import("../src/analytics/model/findings.ts");
  const s = F.simulatedSnapshot(W28);
  const r = simulatedInsights(s);
  assert.equal(r.insights.length, findings(s).length);
  assert.equal(r.source, "simulation");
  for (const i of r.insights) {
    assert.ok(i.title && i.threshold);
    for (const m of i.measurements) {
      assert.equal(m.value, null, "a simulated measurement's number is never parsed back out of words");
      assert.ok(typeof m.display === "string" && m.display.length > 0);
    }
  }
  assert.deepEqual(simulatedInsights(F.simulatedSnapshot(ALL, { size: "sparse" })).insights, []);
});

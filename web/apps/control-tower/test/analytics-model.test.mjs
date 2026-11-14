// M6.5.2 Factory Analytics prototype: the pure chart models, formatting and findings
// (src/analytics/model/). Zero-based scales, counts kept exactly, rates from summed numerators and
// denominators, small samples shown as counts, and findings that are fixed rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const M = await import("../src/analytics/model/charts.ts");
const Fmt = await import("../src/analytics/model/format.ts");
const { findings } = await import("../src/analytics/model/findings.ts");
const F = await import("../src/analytics/fixtures/index.ts");

const D = 86_400_000;
const W28 = { window: "28d", risk: null, app_type: null, model: null };

test("niceTicks start at zero and reach the maximum", () => {
  for (const max of [0.4, 1, 3, 7, 22, 133.6, 980]) {
    const t = M.niceTicks(max, 4);
    assert.equal(t[0], 0);
    assert.ok(t.at(-1) >= max, `${max}: ${t}`);
    assert.ok(t.length <= 7);
  }
  assert.deepEqual(M.niceTicks(0), [0, 1]);
});

test("histogramBins keep every count and stay contiguous", () => {
  const hist = new Array(64).fill(0);
  for (const ms of [500, 3000, 61_000, 62_000, 900_000, 3_600_000, 7_200_000]) hist[F.bucketOf(ms)]++;
  const buckets = hist.flatMap((n, b) => (n ? [{ ge_ms: b === 0 ? 0 : Math.round(F.bucketUpper(b - 1)), le_ms: Math.round(F.bucketUpper(b)), count: n }] : []));
  const bins = M.histogramBins(buckets);
  assert.ok(bins.find((x) => x.fromMs <= 61_000 && x.toMs > 62_000).count >= 2, "61 s and 62 s share a doubling");
  assert.equal(bins.reduce((n, b) => n + b.count, 0), 7);
  for (let i = 1; i < bins.length; i++) assert.ok(Math.abs(bins[i].fromMs - bins[i - 1].toMs) < 1e-6);
  assert.deepEqual(M.histogramBins(undefined), []);
});

test("daily series: an empty day is a zero count, but a rate with no denominator is null", () => {
  const from = Date.UTC(2026, 10, 1);
  const to = from + 4 * D;
  const count = M.dailySeries({ kind: "count", groups: [{ key: "2026-11-02", value: 3, numerator: 3, denominator: null }] }, from, to);
  assert.deepEqual(count.map((p) => p.value), [0, 3, 0, 0]);
  const rate = M.dailySeries({ kind: "rate", groups: [{ key: "2026-11-02", value: 0.5, numerator: 1, denominator: 2 }] }, from, to);
  assert.deepEqual(rate.map((p) => p.value), [null, 0.5, null, null]);
});

test("weekly rolls days into whole weeks by summing numerators and denominators", () => {
  const from = Date.UTC(2026, 9, 16);
  const to = from + 29 * D;
  const days = Array.from({ length: 29 }, (_, i) => ({ day: "", t: from + i * D, value: null, numerator: i % 2, denominator: 1 }));
  const w = M.weekly(days, "rate", to);
  assert.equal(w.length, 4, "the partial first week is left out");
  for (const x of w) {
    assert.equal(x.denominator, 7);
    assert.equal(x.value, x.numerator / 7);
  }
  assert.equal(M.trendClaimable(w, "rate"), true);
  assert.equal(M.trendClaimable(w.slice(0, 2), "rate"), false);
});

test("bottleneck ranking orders by total measured time, so volume outweighs one slow visit", () => {
  const row = { groups: [
    { key: "verify", numerator: 3 * 3_600_000, denominator: 1, p50_ms: 10_800_000 },
    { key: "build", numerator: 40 * 600_000, denominator: 40, p50_ms: 600_000 },
    { key: "human", numerator: 1, denominator: 0 },
  ] };
  const r = M.bottleneckRanking(row);
  assert.deepEqual(r.map((x) => x.station), ["build", "verify"]);
  assert.ok(Math.abs(r.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
});

test("the Factory Flow layout keeps the belt on one row, the person's wait and exits below it, nothing overlapping", () => {
  const s = F.simulatedSnapshot(W28);
  for (const width of [820, 1000, 1240]) {
    const L = M.flowLayout(s.transitions, width);
    const main = L.nodes.filter((n) => !["human", "blocked", "abandoned"].includes(n.station));
    assert.equal(new Set(main.map((n) => n.y)).size, 1);
    for (const n of L.nodes.filter((n) => ["human", "blocked", "abandoned"].includes(n.station))) assert.ok(n.y > main[0].y + main[0].h);
    for (const a of L.nodes) for (const b of L.nodes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.station} overlaps ${b.station} at ${width}`);
    for (const n of L.nodes) assert.ok(n.x >= 0 && n.x + n.w <= width + 0.5, `${n.station} inside ${width}`);
    assert.equal(L.edges.length, s.transitions.filter((t) => L.nodes.some((n) => n.station === t.to)).length);
    assert.ok(L.edges.some((e) => e.kind === "revise"));
  }
});

test("remediation paths count each finished ticket once", () => {
  const s = F.simulatedSnapshot({ ...W28, window: "all" });
  const paths = M.remediationPaths(s.runs);
  assert.equal(paths.reduce((n, p) => n + p.tickets.length, 0), s.runs.length);
  assert.equal(new Set(paths.flatMap((p) => p.tickets)).size, s.runs.length);
  const rounds = M.roundsDistribution(s.runs);
  assert.equal(rounds.reduce((n, r) => n + r.tickets, 0), s.runs.filter((r) => r.outcome === "merged").length);
});

test("strip layout never overlaps dots", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, x: 100 + (i % 7) * 2 }));
  const dots = M.stripLayout(items, 50, 3, 30);
  for (const a of dots) for (const b of dots) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 6 || Math.abs(a.y - b.y) >= 6.9, `${a.id}/${b.id}`);
});

test("formatting: durations, cost, tokens, shares; small samples as counts", () => {
  assert.equal(Fmt.durationText(48_000), "48 s");
  assert.equal(Fmt.durationText(4 * 60_000 + 12_000), "4 min 12 s");
  assert.equal(Fmt.durationText(26 * 60_000 + 20_000), "26 min");
  assert.equal(Fmt.durationText(72 * 60_000), "1 h 12 min");
  assert.equal(Fmt.durationText(51 * 3_600_000), "2 d 3 h");
  assert.equal(Fmt.durationText(null), "–");
  assert.equal(Fmt.usd(2.857), "$2.86");
  // Cost and token words are data/format.ts's (the lead's decision, M6.5): cents kept, no space before k/M.
  assert.equal(Fmt.usd(1204.4), "$1,204.40");
  assert.equal(Fmt.usd(0.004), "< $0.01");
  assert.equal(Fmt.usd(null), "–");
  assert.equal(Fmt.tokens(812), "812");
  assert.equal(Fmt.tokens(34_200), "34.2k");
  assert.equal(Fmt.tokens(1_270_000), "1.27M");
  assert.equal(Fmt.pct(0.593), "59%");
  assert.equal(Fmt.pct(0.035), "3.5%");
  assert.equal(Fmt.pct(0.899, 1), "89.9%");
  assert.equal(Fmt.valueText({ kind: "rate", unit: "", value: 0.5, numerator_value: 1, denominator_value: 2 }), "1 of 2");
  assert.equal(Fmt.valueText({ kind: "rate", unit: "", value: 0.6, numerator_value: 6, denominator_value: 10 }), "60%");
  assert.equal(Fmt.valueText({ kind: "rate", unit: "", value: null, numerator_value: 0, denominator_value: 0 }), null);
  assert.equal(Fmt.durationCompact(128_000), "2.1 min");
});

test("findings are fixed rules: deterministic, sourced, and never advise weakening a gate", () => {
  const s = F.simulatedSnapshot(W28);
  const a = findings(s);
  assert.deepEqual(a, findings(s));
  assert.ok(a.length >= 3);
  for (const f of a) {
    assert.ok(f.condition && f.sample && f.window && f.why && f.investigate && f.metrics.length, f.id);
    const words = `${f.title} ${f.why} ${f.investigate}`.toLowerCase();
    assert.doesNotMatch(words, /\b(skip|bypass|disable|lower the|loosen|weaken|remove the (gate|check|approval)|because)\b/, f.id);
  }
  assert.deepEqual(findings(F.simulatedSnapshot({ ...W28, window: "all" }, { size: "sparse" })), [], "two runs: no rule's sample is met");
});

test("comparisons say too few, or describe without a cause", () => {
  const mk = (label, n, fp) => ({ label, runs: Array.from({ length: n }, (_, i) => ({ ticket_id: `${label}${i}`, outcome: "merged", first_pass: i < fp, rounds: i < fp ? 1 : 2, escalated: false })) });
  assert.match(M.compareWords(M.cohortSummary(mk("a", 3, 1)), M.cohortSummary(mk("b", 9, 9))), /Too few/);
  const w = M.compareWords(M.cohortSummary(mk("a", 10, 9)), M.cohortSummary(mk("b", 10, 4)));
  assert.match(w, /not a cause/);
});

test("transition kinds and reference words come from the record alone", () => {
  assert.equal(M.transitionKind({ from: "verify", to: "build" }), "revise");
  assert.equal(M.transitionKind({ from: "review", to: "build" }), "revise");
  assert.equal(M.transitionKind({ from: "build", to: "verify" }), "forward");
  assert.equal(M.transitionKind({ from: "review", to: "blocked" }), "exit");
  assert.deepEqual(M.refLabel({ ref: "visit:SYN-050/build#2", ticket: "SYN-050", execution: null }), { primary: "SYN-050 build #2", secondary: null });
  assert.deepEqual(M.refLabel({ ref: "gate:SYN-003/review#2", ticket: "SYN-003", execution: null }), { primary: "SYN-003", secondary: "review round 2" });
});

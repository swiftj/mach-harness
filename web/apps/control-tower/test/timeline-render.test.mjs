// M6.3 tracks rendering (src/timeline/render): the pure parts. Level of detail, culling, hit-testing,
// ruler ticks and their labels, pan and zoom limits, the tone a span is drawn in, and the words of the
// timing grammar for every basis (docs/mach-next/M6_3_DESIGN.md sections 3B and 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const lod = await import("../src/timeline/render/lod.ts");
const scale = await import("../src/timeline/render/scale.ts");
const words = await import("../src/timeline/render/words.ts");
const palette = await import("../src/timeline/render/palette.ts");
const { at, span } = await import("../src/timeline/dev/fixture.ts");
const { MIN_WINDOW_MS } = await import("../src/timeline/contract.ts");

const T0 = Date.UTC(2026, 10, 12, 23, 18, 0);
const S = 1000;
const M = 60 * S;
const visit = (id, a, b, o = {}) => span(id, "visit", at(a), b === null ? null : at(b, o.end ?? {}), { attrs: { action: "build" }, ...o });

// ---------------------------------------------------------------- level of detail

test("level of detail follows design 3B: density under 1.5 px, label from 28, duration from 96", () => {
  assert.equal(lod.lodOf(1.49), "density");
  assert.equal(lod.lodOf(1.5), "geometry");
  assert.equal(lod.lodOf(27.9), "geometry");
  assert.equal(lod.lodOf(28), "label");
  assert.equal(lod.lodOf(95.9), "label");
  assert.equal(lod.lodOf(96), "duration");
});

test("sub-pixel spans merge into one density run per stretch, with their count", () => {
  // 1000 px for 1000 s: 1 px per second. 50 spans of 0.5 s, back to back, then one of 60 s.
  const sc = scale.scaleOf({ from: T0, to: T0 + 1000 * S }, 1000);
  const spans = [];
  for (let i = 0; i < 50; i++) spans.push(visit(`v${i}`, T0 + i * S, T0 + i * S + 500));
  spans.push(visit("big", T0 + 100 * S, T0 + 160 * S));
  const plan = lod.planRow(spans, [], sc, T0 + 2000 * S);
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].count, 50);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].span.id, "big");
  assert.equal(plan.items[0].lod, "label");
});

test("instants are drawn one by one under one per 6 px, as count pips above", () => {
  const sc = scale.scaleOf({ from: T0, to: T0 + 600 * S }, 600);
  const sparse = Array.from({ length: 10 }, (_, i) => span(`t${i}`, "tool", at(T0 + i * 20 * S), at(T0 + i * 20 * S + 100)));
  const p1 = lod.planRow(sparse, [], sc, T0 + 900 * S);
  assert.equal(p1.instants.length, 10);
  assert.equal(p1.pips.length, 0);
  // 100 calls in 100 px: a burst, thinned even though the window is wide.
  const dense = Array.from({ length: 100 }, (_, i) => span(`d${i}`, "tool", at(T0 + i * S), at(T0 + i * S + 100)));
  const p2 = lod.planRow(dense, [], sc, T0 + 900 * S);
  assert.equal(p2.instants.length, 0);
  assert.ok(p2.pips.length > 0);
  assert.equal(p2.pips.reduce((n, p) => n + p.count, 0), 100);
});

// ---------------------------------------------------------------- culling

test("culling: two binary searches; an open span never hides what follows it", () => {
  const spans = [visit("open", T0, null), ...Array.from({ length: 1000 }, (_, i) => visit(`v${i}`, T0 + (i + 1) * M, T0 + (i + 1) * M + 30 * S))];
  const index = lod.laneIndex(spans);
  const [a, b] = lod.visibleRange(index, T0 + 500 * M, T0 + 510 * M);
  const ids = index.spans.slice(a, b).map((s) => s.id);
  assert.ok(ids.includes("open"), "the open span reaches every later window");
  assert.ok(ids.includes("v499") && ids.includes("v509"));
  assert.ok(!ids.includes("v700"));
  // Only the open span and the window's neighbours are looked at, not all 1001.
  assert.ok(b - a < 520);
});

test("an unsorted lane is sorted once and cached by array", () => {
  const spans = [visit("b", T0 + 2 * M, T0 + 3 * M), visit("a", T0, T0 + M)];
  const i1 = lod.laneIndex(spans);
  assert.deepEqual(i1.spans.map((s) => s.id), ["a", "b"]);
  assert.equal(lod.laneIndex(spans), i1);
});

test("nothing after the live edge: a span starting later is not placed; one ending later is open", () => {
  const live = T0 + 10 * M;
  assert.equal(lod.spanTimes(visit("late", T0 + 11 * M, T0 + 12 * M), live), null);
  const t = lod.spanTimes(visit("x", T0 + 5 * M, T0 + 20 * M), live);
  assert.equal(t.open, true);
  assert.equal(t.to, live);
});

test("an unknown end is a point at the known end, never a length", () => {
  const s = span("u", "visit", at(T0), at(null), { basis: "unknown" });
  const t = lod.spanTimes(s, T0 + M);
  assert.equal(t.endUnknown, true);
  assert.equal(t.from, t.to);
  const s2 = span("u2", "visit", null, at(T0 + M), { basis: "unknown" });
  const t2 = lod.spanTimes(s2, T0 + 2 * M);
  assert.equal(t2.startUnknown, true);
  assert.equal(t2.from, T0 + M);
});

// ---------------------------------------------------------------- hit-testing

test("hit-testing finds the narrowest span, then marks, pips and runs; aggregates carry their count", () => {
  const sc = scale.scaleOf({ from: T0, to: T0 + 1000 * S }, 1000);
  const spans = [visit("a", T0 + 10 * S, T0 + 100 * S), visit("b", T0 + 200 * S, T0 + 300 * S)];
  for (let i = 0; i < 20; i++) spans.push(visit(`tiny${i}`, T0 + (500 + i) * S, T0 + (500 + i) * S + 400));
  const mark = { id: "m", kind: "gate", at: T0 + 400 * S, until: null, eventId: null, entity: "gate:x", label: "Gate passed", verdict: "passed", authority: "authoritative" };
  const plan = lod.planRow(spans, [mark], sc, T0 + 2000 * S);
  assert.equal(lod.hitRow(plan, 50).span.id, "a");
  assert.equal(lod.hitRow(plan, 250).span.id, "b");
  assert.equal(lod.hitRow(plan, 150), null);
  assert.equal(lod.hitRow(plan, 402).kind, "mark");
  const agg = lod.hitRow(plan, 510);
  assert.equal(agg.kind, "aggregate");
  assert.equal(agg.count, 20);
});

// ---------------------------------------------------------------- ruler

test("tick steps: majors at least 72 px apart, from 100 ms to a day, each with a finer minor", () => {
  for (const [span, width] of [
    [2 * S, 1200],
    [MIN_WINDOW_MS, 1200],
    [10 * M, 1200],
    [3 * 60 * M, 1200],
    [5 * 24 * 60 * M, 1200],
  ]) {
    const { major, minor } = scale.tickStep(span, width);
    assert.ok((major / span) * width >= 72 || major === scale.DAY, `${span}: ${major}`);
    assert.ok(minor < major && major % minor === 0);
    assert.equal(scale.DAY % major, 0, "every major divides a day, so midnight is a major");
  }
  assert.equal(scale.tickStep(1 * S, 1200).major, 100);
  assert.equal(scale.tickStep(30 * 24 * 60 * M, 1200).major, scale.DAY);
});

test("tick labels follow the step: HH:MM:SS.s, HH:MM:SS, HH:MM, DD Mon (UTC); elapsed for simulation time", () => {
  const t = Date.UTC(2026, 10, 12, 23, 41, 7, 250);
  assert.equal(scale.tickLabel(t, 200), "23:41:07.2");
  assert.equal(scale.tickLabel(t, 5 * S), "23:41:07");
  assert.equal(scale.tickLabel(t, 10 * M), "23:41");
  assert.equal(scale.tickLabel(t, scale.DAY), "12 Nov");
  assert.equal(scale.tickLabel(65_300, 500, false), "01:05.3");
  assert.equal(scale.tickLabel(65_300, 5 * S, false), "01:05");
  assert.equal(scale.tickLabel(3_725_000, 10 * M, false), "1:02:00");
});

test("date changes are the UTC midnights in the window, and always major ticks", () => {
  const w = { from: Date.UTC(2026, 10, 12, 23, 0), to: Date.UTC(2026, 10, 13, 1, 0) };
  const days = scale.dateChanges(w);
  assert.deepEqual(days, [Date.UTC(2026, 10, 13)]);
  const ticks = scale.ticksFor(w, 1200);
  assert.ok(ticks.majors.includes(days[0]));
  assert.deepEqual(scale.dateChanges({ from: 0, to: 4 * M }), [], "simulation time has no dates");
});

test("the window is never narrower than MIN_WINDOW_MS; zoom keeps the anchor under the pointer", () => {
  const w = { from: T0, to: T0 + 60 * S };
  const z = scale.zoomAbout(w, 0.001, T0 + 30 * S);
  assert.equal(z.to - z.from, MIN_WINDOW_MS);
  assert.ok(Math.abs((T0 + 30 * S - z.from) / (z.to - z.from) - 0.5) < 1e-9);
  const z2 = scale.zoomAbout(w, 2, T0 + 15 * S);
  assert.ok(Math.abs((T0 + 15 * S - z2.from) / (z2.to - z2.from) - 0.25) < 1e-9);
  assert.equal(scale.clampWindow({ from: T0, to: T0 + 10 }).to - scale.clampWindow({ from: T0, to: T0 + 10 }).from, MIN_WINDOW_MS);
  const f = scale.frameWindow(T0, T0 + 100);
  assert.ok(f.to - f.from >= MIN_WINDOW_MS);
});

// ---------------------------------------------------------------- tone: outcome only when known

test("outcome colour only once the end is held; open work is live; waits keep their own tone", () => {
  const s = visit("v", T0, T0 + 5 * M, { outcome: "failed" });
  const before = lod.spanTimes(s, T0 + 3 * M);
  assert.equal(palette.toneOf(s, before, T0 + 3 * M), "live");
  const after = lod.spanTimes(s, T0 + 6 * M);
  assert.equal(palette.toneOf(s, after, T0 + 6 * M), "fail");
  const noOutcome = visit("n", T0, T0 + M);
  assert.equal(palette.toneOf(noOutcome, lod.spanTimes(noOutcome, T0 + 2 * M), T0 + 2 * M), "neutral");
  const p = span("p", "person-wait", at(T0), null);
  assert.equal(palette.toneOf(p, lod.spanTimes(p, T0 + M), T0 + M), "human");
  const interrupted = visit("i", T0, T0 + M, { end: { reason: "interrupted" } });
  assert.equal(palette.toneOf(interrupted, lod.spanTimes(interrupted, T0 + 2 * M), T0 + 2 * M), "halt");
});

// ---------------------------------------------------------------- words

test("durationWords: every basis in the words of design section 5", () => {
  const live = T0 + 60 * M;
  assert.equal(words.durationWords(visit("m", T0, T0 + 4 * M + 12 * S), live), "took 4 min 12 s");
  const bounded = span("b", "visit", at(T0), at(null, { notBefore: T0 + 4 * M + 10 * S, notAfter: T0 + 4 * M + 14 * S, precision: "bounded" }), { basis: "bounded" });
  assert.equal(words.durationWords(bounded, live), "between 4 min 10 s and 4 min 14 s");
  const inferred = span("i", "visit", at(T0), at(T0 + 4 * M, { basis: "inferred", rule: "visit-end-at-next-visit" }));
  assert.equal(words.durationWords(inferred, live), "about 4 min, placed by rule: visit end at next visit");
  assert.equal(words.durationWords(visit("o", T0, null), T0 + 4 * M), "running for 4 min");
  assert.equal(words.durationWords(span("w", "slice-wait", at(T0), null), T0 + 4 * M), "waiting for 4 min");
  assert.equal(words.durationWords(span("us", "visit", null, at(T0), { basis: "unknown" }), live), "start not known");
  assert.equal(words.durationWords(span("ue", "visit", at(T0), at(null), { basis: "unknown" }), live), "end not known");
  assert.equal(words.durationWords(visit("ms", T0, T0 + 340), live), "took 340 ms");
});

test("durationWords: an interrupted span never 'took'; one ended after the live edge is still running", () => {
  const live = T0 + 60 * M;
  const i = visit("i", T0, T0 + 4 * M + 12 * S, { end: { reason: "interrupted" }, outcome: "interrupted" });
  assert.equal(words.durationWords(i, live), "interrupted after 4 min 12 s");
  assert.ok(!words.describeSpan(i, live).includes("took"));
  const sup = visit("s", T0, T0 + 2 * M, { end: { reason: "superseded" } });
  assert.equal(words.durationWords(sup, live), "superseded after 2 min");
  const resumed = visit("r", T0, T0 + 9 * M, { attrs: { action: "build", interruptedAt: T0 + 3 * M } });
  assert.match(words.durationWords(resumed, live), /^ran 9 min, interrupted once/);
  assert.equal(words.durationWords(visit("f", T0, T0 + 9 * M), T0 + 4 * M), "running for 4 min");
});

test("describeSpan: one sentence; the outcome only once it is known", () => {
  const s = visit("v", T0, T0 + 4 * M + 12 * S, { outcome: "failed", ids: { ticket: "LOCAL-031" }, attrs: { action: "verify", round: 2 } });
  assert.equal(words.describeSpan(s, T0 + 2 * M), "Verify visit, round 2 for LOCAL-031: running for 2 min.");
  assert.equal(words.describeSpan(s, T0 + 10 * M), "Verify visit, round 2 for LOCAL-031: took 4 min 12 s, failed.");
  const pending = visit("p", T0, T0 + M, { attrs: { action: "build" } });
  assert.equal(words.describeSpan(pending, T0 + 2 * M), "Build visit: took 1 min, no outcome recorded yet.");
  const agent = span("a", "agent", at(T0), at(T0 + 3 * M), { outcome: "completed", attrs: { label: "reviewer", model: "opus", toolCalls: 17, toolsCountOnly: true } });
  assert.equal(words.describeSpan(agent, T0 + 4 * M), "Agent reviewer (Opus): took 3 min, 17 tool calls, not observable one by one, completed.");
  const wait = span("w", "person-wait", at(T0), null);
  assert.equal(words.describeSpan(wait, T0 + 5 * M), "Waiting for a person: waiting for 5 min.");
});

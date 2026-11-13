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

// ---------------------------------------------------------------- wave 2: ended without an exit record

test("ended without an exit record: never running, never 'took'; 'within' the bound, in the inspector's words", () => {
  const live = T0 + 8 * 60 * M; // viewed hours later
  const raw = span("v", "visit", at(T0), at(T0 + 73 * M, { basis: "inferred", rule: "execution-ended", reason: "interrupted" }), { attrs: { action: "build", round: 2 } });
  const s = { ...raw, duration: { ms: null, minMs: null, maxMs: 73 * M, basis: "inferred" } };
  assert.equal(words.endedWithoutExit(s), true);
  assert.equal(words.durationWords(s, live), "ended without an exit record, within 1 h 13 min");
  const d = words.describeSpan(s, live);
  assert.ok(!/took|running/.test(d), d);
  assert.ok(!d.includes("no outcome recorded yet"));
  const t = lod.spanTimes(s, live);
  assert.equal(t.open, false, "drawn to the bound, not to the live edge");
  assert.equal(t.to, T0 + 73 * M);
  assert.match(words.precisionLine(s, live), /no exit recorded; closed at a bound by rule: execution ended/);
  // A recorded interruption is still "interrupted after".
  assert.equal(words.durationWords(visit("i", T0, T0 + 2 * M, { end: { reason: "interrupted" } }), live), "interrupted after 2 min");
});

test("people and the line: a seat votes, a person approves the review, a merge visit merges; different words", () => {
  const live = T0 + 60 * M;
  const seat = span("s", "seat", at(T0), at(T0 + 3 * M, { reason: "refused" }), { outcome: "REJECT", attrs: { model: "opus", vote: "REJECT" }, ids: { ticket_id: "LOCAL-029", seat: "security" } });
  assert.equal(words.describeSpan(seat, live), "Review seat security (Opus) for LOCAL-029: took 3 min, voted reject.");
  assert.equal(words.describeSpan(seat, T0 + M), "Review seat security (Opus) for LOCAL-029: running for 1 min.", "no vote before the verdict");
  const wait = span("w", "person-wait", at(T0), at(T0 + 6 * M), { outcome: "human.approval_recorded", entity: "gate:LOCAL-029/human-approval#1", ids: { ticket_id: "LOCAL-029" } });
  assert.equal(words.personApproved(wait, live), true);
  assert.equal(words.personApproved(wait, T0 + M), false);
  assert.equal(words.describeSpan(wait, live), "Waiting for a person for LOCAL-029: waited 6 min, a person approved the review.");
  const merge = span("m", "visit", at(T0), at(T0 + M), { outcome: "merged", attrs: { action: "merge" }, ids: { ticket_id: "LOCAL-029", station: "merge" } });
  assert.equal(words.isMergeVisit(merge), true);
  assert.equal(words.describeSpan(merge, live), "Merge visit for LOCAL-029: took 1 min, merged into the main branch.");
  assert.notEqual(words.describeSpan(wait, live).includes("merged"), true);
});

// ---------------------------------------------------------------- wave 2: label placement

const draw = await import("../src/timeline/render/draw.ts");

test("inline labels in thin rows keep clear of marks: pushed past one at the start, cut before one further on, dropped without room", () => {
  assert.deepEqual(draw.inlineRoom(10, 200, []), { x: 10, right: 200 });
  const pushed = draw.inlineRoom(10, 200, [{ x: 12 }]);
  assert.ok(pushed.x >= 12 + draw.MARK_HALF + 4, "after the mark at the start");
  const cut = draw.inlineRoom(10, 200, [{ x: 120 }]);
  assert.equal(cut.x, 10);
  assert.ok(cut.right <= 120 - draw.MARK_HALF - 4);
  assert.equal(draw.inlineRoom(10, 40, [{ x: 14 }, { x: 36 }]), null, "no room: no label");
  assert.deepEqual(draw.inlineRoom(10, 200, [{ x: 400 }]), { x: 10, right: 200 }, "marks elsewhere change nothing");
});

test("the label column drops a detail that cannot show six characters; the label has priority", () => {
  const { showDetail } = words;
  assert.equal(words.DETAIL_MIN_CHARS, 6);
  assert.equal(showDetail(120, 60, 80, 30), true);
  assert.equal(showDetail(120, 100, 80, 30), false);
  assert.equal(showDetail(120, 60, 20, 30), true, "a short detail shows whole");
});

test("an empty row's chevron points at the nearest span, on its side", () => {
  const sc = scale.scaleOf({ from: T0 + 60 * M, to: T0 + 70 * M }, 1000);
  const live = T0 + 200 * M;
  const before = visit("a", T0, T0 + 50 * M);
  const after = visit("b", T0 + 90 * M, T0 + 95 * M);
  assert.equal(draw.edgeChevron([before, after], sc, live).spanId, "a");
  assert.equal(draw.edgeChevron([before, after], sc, live).side, -1);
  assert.equal(draw.edgeChevron([visit("c", T0, T0 + 30 * M), after], sc, live).spanId, "b");
  assert.equal(draw.edgeChevron([visit("c", T0, T0 + 30 * M), after], sc, live).side, 1);
  assert.equal(draw.edgeChevron([visit("in", T0 + 62 * M, T0 + 63 * M)], sc, live), null, "something in view: no chevron");
  assert.equal(draw.edgeChevron([visit("open", T0, null)], sc, live), null, "an open span reaches the window");
});

test("a collapsed group's summary knows its first failure in view", async () => {
  const fx = (await import("../src/timeline/dev/fixture.ts")).proofFixture();
  const node = fx.tree.byId.get("cell:LOCAL-032");
  const cols = lod.subtreeColumns(node, scale.scaleOf({ from: T0, to: T0 + 80 * M }, 1000), T0 + 80 * M);
  assert.equal(cols.firstFail, T0 + 41 * M);
});

// ---------------------------------------------------------------- wave 2: keyboard model

const keys = await import("../src/timeline/render/keys.ts");
const { layoutOf, proofFixture, makeTree } = await import("../src/timeline/dev/fixture.ts");

function keyWorld() {
  const a1 = visit("a1", T0 + 1 * M, T0 + 2 * M);
  const a2 = visit("a2", T0 + 4 * M, T0 + 5 * M);
  const a3 = visit("a3", T0 + 30 * M, T0 + 31 * M);
  const b1 = visit("b1", T0 + 1 * M + 30 * S, T0 + 3 * M);
  const tree = makeTree([
    { id: "g", kind: "cell", label: "Group", children: [
      { id: "a", kind: "station", label: "A", lanes: [[a1, a2, a3]] },
      { id: "b", kind: "station", label: "B", lanes: [[b1]] },
    ] },
    { id: "z", kind: "station", label: "Z", lanes: [] },
  ]);
  const layout = layoutOf(tree, new Set(["g"]));
  return { tree, layout, window: { from: T0, to: T0 + 10 * M }, liveAt: T0 + 60 * M, scrollTop: 0, height: 60 };
}

test("keys: Up and Down stop on every row, a group row too, keeping the time on the new row", () => {
  const w = keyWorld();
  let r = keys.keyAction({ key: "ArrowDown" }, { ...w, cursor: null });
  assert.deepEqual(r.cursor, { trackId: "g", lane: 0, spanId: null }, "the first key lands on the first row");
  r = keys.keyAction({ key: "ArrowDown" }, { ...w, cursor: { trackId: "g", lane: 0, spanId: null } });
  assert.equal(r.cursor.trackId, "a");
  // From span a1 (01:00 - 02:00, middle 01:30) down to b: b1 spans 01:30, so the cursor lands on it.
  r = keys.keyAction({ key: "ArrowDown" }, { ...w, cursor: { trackId: "a", lane: 0, spanId: "a1" } });
  assert.deepEqual(r.cursor, { trackId: "b", lane: 0, spanId: "b1" });
  r = keys.keyAction({ key: "ArrowUp" }, { ...w, cursor: { trackId: "g", lane: 0, spanId: null } });
  assert.equal(r.handled, true);
  assert.equal(r.cursor, undefined, "nothing above the first row");
  // Scrolled into view: the last row lies below a 60 px screen.
  r = keys.keyAction({ key: "ArrowDown" }, { ...w, cursor: { trackId: "b", lane: 0, spanId: null } });
  assert.equal(r.cursor.trackId, "z");
  assert.ok(r.scrollTop > 0);
});

test("keys: Left and Right walk the row's spans, panning them into view, and stop at the ends", () => {
  const w = keyWorld();
  let r = keys.keyAction({ key: "ArrowRight" }, { ...w, cursor: { trackId: "a", lane: 0, spanId: null } });
  assert.equal(r.cursor.spanId, "a1");
  r = keys.keyAction({ key: "ArrowRight" }, { ...w, cursor: { trackId: "a", lane: 0, spanId: "a2" } });
  assert.equal(r.cursor.spanId, "a3");
  assert.ok(r.window.from <= T0 + 30 * M && r.window.to >= T0 + 31 * M, "a3 panned into view");
  assert.equal(r.window.to - r.window.from, 10 * M, "a pan, not a zoom");
  r = keys.keyAction({ key: "ArrowRight" }, { ...w, cursor: { trackId: "a", lane: 0, spanId: "a3" } });
  assert.equal(r.handled, true);
  assert.equal(r.cursor.spanId, "a3", "at the row's end nothing moves");
  assert.equal(r.window, undefined);
  r = keys.keyAction({ key: "ArrowLeft" }, { ...w, cursor: { trackId: "a", lane: 0, spanId: "a1" } });
  assert.equal(r.cursor.spanId, "a1");
});

test("keys: Enter selects or toggles; Alt+arrows and * expand and collapse", () => {
  const w = keyWorld();
  let r = keys.keyAction({ key: "Enter" }, { ...w, cursor: { trackId: "a", lane: 0, spanId: "a2" } });
  assert.equal(r.select.id, "a2");
  r = keys.keyAction({ key: "Enter" }, { ...w, cursor: { trackId: "g", lane: 0, spanId: null } });
  assert.equal(r.toggle, "g");
  r = keys.keyAction({ key: "ArrowLeft", altKey: true }, { ...w, cursor: { trackId: "g", lane: 0, spanId: null } });
  assert.equal(r.toggle, "g", "collapse an open group");
  r = keys.keyAction({ key: "ArrowRight", altKey: true }, { ...w, cursor: { trackId: "g", lane: 0, spanId: null } });
  assert.equal(r.toggle, undefined, "already open");
  const closed = { ...w, layout: layoutOf(w.tree, new Set()) };
  assert.equal(keys.keyAction({ key: "*" }, { ...closed, cursor: { trackId: "g", lane: 0, spanId: null } }).toggle, "g");
  // A cursor whose row was collapsed away stands on its nearest shown ancestor.
  assert.equal(keys.cursorRow({ ...closed, cursor: { trackId: "a", lane: 0, spanId: "a1" } }).node.id, "g");
});

test("keys: + - 0 zoom about the cursor; Shift+arrows pan a tenth; PageDown a screen; global keys pass through", () => {
  const w = keyWorld();
  const c = { trackId: "a", lane: 0, spanId: "a2" };
  const anchor = T0 + 4 * M + 30 * S;
  const zin = keys.keyAction({ key: "+" }, { ...w, cursor: c }).window;
  assert.ok(zin.to - zin.from < 10 * M);
  assert.ok(Math.abs((anchor - zin.from) / (zin.to - zin.from) - (anchor - w.window.from) / (10 * M)) < 1e-9, "the cursor stays where it was on screen");
  assert.ok(keys.keyAction({ key: "=" }, { ...w, cursor: c }).window.to - keys.keyAction({ key: "=" }, { ...w, cursor: c }).window.from < 10 * M);
  const zout = keys.keyAction({ key: "-" }, { ...w, cursor: c }).window;
  assert.ok(zout.to - zout.from > 10 * M);
  const framed = keys.keyAction({ key: "0" }, { ...w, cursor: c }).window;
  assert.ok(framed.from <= T0 + 4 * M && framed.to >= T0 + 5 * M && framed.to - framed.from < 2 * M);
  const pan = keys.keyAction({ key: "ArrowRight", shiftKey: true }, { ...w, cursor: c }).window;
  assert.equal(pan.from - w.window.from, M);
  const page = keys.keyAction({ key: "PageDown" }, { ...w, cursor: { trackId: "g", lane: 0, spanId: null } });
  assert.ok(page.cursor.trackId !== "g");
  for (const key of [",", ".", "<", ">", "[", "]", "{", "}", " ", "Home", "End", "l", "f", "i", "s", "t", "1", "2", "3", "?", "g", "/", "n", "p", "z", "a", "Escape"]) {
    assert.equal(keys.keyAction({ key }, { ...w, cursor: c }).handled, false, `${key} is the global map's`);
  }
  assert.equal(keys.keyAction({ key: "+", ctrlKey: true }, { ...w, cursor: c }).handled, false, "browser zoom is left alone");
});

test("the proof fixture holds what the page must show", () => {
  const fx = proofFixture();
  assert.ok(fx.tree.byId.has("grammar/no-exit"));
  assert.ok(fx.marks.some((m) => m.kind === "merge") && fx.marks.some((m) => m.kind === "human" && m.verdict === "approved"));
  assert.ok(fx.tree.byId.get("seat:LOCAL-029/review#1/security"));
});

// M6.6 (I-04): scrubbed back, the Timeline's tracks, hover words, table rows and lenses are held at the
// playhead. The recorded history is replayed progressively: at each playhead t the track model, the
// words a hover card and the table say, and the lens marks are built from the spans as they stood at t
// (derive.ts `spansAsOf`, `marksAsOf`) and must name no outcome, end or start later than t. The
// detector is shown to catch the same model built from the uncut spans (the M6.3 behaviour).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { sim, scene as S } from "./_load.mjs";

const grammar = new URL("../../../packages/ui/src/factory/grammar.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@mach/ui") return nextResolve(grammar, context);
    return nextResolve(specifier, context);
  },
});

const data = await import("../src/timeline/data/scene.ts");
const derive = await import("../src/timeline/data/derive.ts");
const { buildTrackTree } = await import("../src/timeline/tracks/build.ts");
const { layoutRows } = await import("../src/timeline/tracks/layout.ts");
const model = await import("../src/timeline/a11y/model.ts");
const words = await import("../src/timeline/render/words.ts");
const frame = await import("../src/timeline/controls/frame.ts");
const { NO_FILTERS } = await import("../src/timeline/contract.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const { SCENARIO, finalScene } = sim;
const final = finalScene(SCENARIO);
/** The whole recorded history, as the observer serves it at the head: every end and outcome known. */
const ALL = data.spansOfScene(final);
const MARKS = data.marksOfScene(final, ALL);
const endOf = (s) => (s.end ? (s.end.at ?? s.end.notAfter ?? s.end.notBefore) : null);
const startOf = (s) => (s.start ? (s.start.at ?? s.start.notBefore ?? s.start.notAfter) : endOf(s));
const byId = new Map(ALL.map((s) => [s.id, s]));
/** Every span whose end (and so its outcome) lies after t: the words of its outcome must not be said at t. */
const decidedAfter = (t) => ALL.filter((s) => s.outcome !== null && endOf(s) !== null && endOf(s) > t);

// Each end moment, one millisecond before it (the leak window), and a spread across the run.
const SAMPLE = [...new Set([...ALL.map(endOf).filter((x) => x !== null).map((x) => x - 1), ...Array.from({ length: 40 }, (_, i) => Math.round((i / 39) * SCENARIO.duration))])]
  .filter((t) => t > 0)
  .sort((a, b) => a - b)
  .filter((_, i, a) => a.length < 160 || i % Math.ceil(a.length / 160) === 0);

/** Everything the tracks, the table and the hover cards would show at t, from a span set. */
function shownAt(spans, marks, t) {
  const tree = buildTrackTree(spans, "product", NO_FILTERS, t);
  const all = new Set();
  const walk = (n) => {
    all.add(n.id);
    n.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  const layout = layoutRows(tree, all);
  const win = { from: 0, to: SCENARIO.duration };
  const index = model.indexWindow(win, t);
  const rows = model.buildGridRows(layout, index, all).rows;
  const treeSpans = [];
  for (const n of tree.byId.values()) {
    for (const lane of n.lanes ?? []) treeSpans.push(...lane.spans);
    treeSpans.push(...(n.ribbons ?? []));
  }
  const hover = treeSpans.map((s) => `${words.describeSpan(s, t)} | ${words.durationWords(s, t)}`);
  const table = rows.filter((r) => r.type === "span").map((r) => ({ span: r.span, words: `${words.describeSpan(r.span, t)} | ${words.durationWords(r.span, t)}` }));
  return { tree, treeSpans, hover, table, marks };
}

/** What at t reveals a later moment: a span begun after t, an end or outcome after t, a mark after t, an outcome's words said early. */
function leaks(shown, t) {
  const out = [];
  for (const s of shown.treeSpans) {
    const st = startOf(s);
    if (st !== null && st > t) out.push(`track ${s.id} starts at ${st} > ${t}`);
    if (s.end && endOf(s) !== null && endOf(s) > t) out.push(`track ${s.id} ends at ${endOf(s)} > ${t}`);
    if (s.outcome !== null && !(s.end && s.end.at !== null && s.end.at <= t)) out.push(`track ${s.id} outcome ${s.outcome} before its end`);
  }
  for (const r of shown.table) if (r.span.outcome !== null && endOf(r.span) > t) out.push(`table ${r.span.id} outcome ${r.span.outcome}`);
  for (const m of shown.marks) {
    if (m.at > t) out.push(`mark ${m.id} at ${m.at} > ${t}`);
    if (m.until !== null && m.until > t) out.push(`mark ${m.id} until ${m.until} > ${t}`);
  }
  // A span open at t is said to be open: its hover and table words name no outcome decided later.
  const said = [...shown.hover, ...shown.table.map((r) => r.words)].join("\n");
  for (const s of decidedAfter(t)) {
    const own = shown.treeSpans.find((x) => x.id === s.id);
    if (!own) continue;
    const w = `${words.describeSpan(own, t)} | ${words.durationWords(own, t)}`;
    const outcome = words.outcomeWords(s.outcome);
    if (outcome && w.toLowerCase().includes(outcome.toLowerCase()) && !w.toLowerCase().includes("open")) out.push(`${s.id} says "${outcome}" at ${t}`);
    if (/\b(failed|passed|approved|rejected|completed)\b/i.test(w) && !said.includes(w)) out.push(`${s.id} words not in the model`);
  }
  return out;
}

test("the detector works: the uncut history, read at an earlier playhead, shows later outcomes", () => {
  const t = Math.round(SCENARIO.duration / 3);
  const found = leaks(shownAt(ALL, MARKS, t), t);
  assert.ok(found.length > 10, `only ${found.length} found`);
});

test("I-04: replayed progressively, nothing later than the playhead reaches the track model, hover words, table rows or lens marks", () => {
  assert.ok(SAMPLE.length > 40);
  let spans = 0;
  let rows = 0;
  let open = 0;
  for (const t of SAMPLE) {
    const shown = shownAt(derive.spansAsOf(ALL, t), derive.marksAsOf(MARKS, t), t);
    spans += shown.treeSpans.length;
    rows += shown.table.length;
    open += shown.treeSpans.filter((s) => s.end === null).length;
    assert.deepEqual(leaks(shown, t).slice(0, 5), [], `at t = ${t}`);
  }
  // The model is not empty: the check looked at real tracks, rows and open spans.
  assert.ok(spans > 1000 && rows > 500 && open > 50, `spans ${spans}, rows ${rows}, open ${open}`);
});

test("I-04: a span still open at the playhead reads as open at that moment, with no outcome; one ended by then keeps its outcome", () => {
  const visit = ALL.find((s) => s.kind === "visit" && s.outcome !== null && s.end?.at !== null && startOf(s) !== null && s.end.at - startOf(s) > 2);
  assert.ok(visit, "a decided visit in the scenario");
  const mid = Math.floor((startOf(visit) + visit.end.at) / 2);
  const held = derive.spansAsOf([visit], mid)[0];
  assert.equal(held.end, null);
  assert.equal(held.outcome, null);
  assert.equal(held.duration.basis, "open");
  assert.match(words.describeSpan(held, mid), /open|at work|waiting/);
  assert.doesNotMatch(words.describeSpan(held, mid), new RegExp(words.outcomeWords(visit.outcome), "i"));
  assert.equal(derive.spansAsOf([visit], visit.end.at)[0].outcome, visit.outcome, "decided at its end: the outcome shows from that moment");
  assert.deepEqual(derive.spansAsOf([visit], startOf(visit) - 1), [], "not begun: not drawn");
  // Unchanged spans keep their identity (the tree is rebuilt from the same objects).
  const done = ALL.filter((s) => endOf(s) !== null && endOf(s) < 1000);
  for (const s of derive.spansAsOf(done, 1000)) assert.ok(byId.get(s.id) === s || s.outcome === null);
});

test("I-04: marks after the playhead are dropped; an interval still running at the playhead has no end yet", () => {
  const m = [
    { id: "a", kind: "failure", at: 10, until: null, eventId: null, entity: null, label: "x", verdict: null, authority: "observed" },
    { id: "b", kind: "human", at: 20, until: 90, eventId: null, entity: null, label: "A person was needed.", verdict: "required", authority: "observed" },
    { id: "c", kind: "merge", at: 60, until: null, eventId: null, entity: null, label: "merged", verdict: null, authority: "observed" },
  ];
  assert.deepEqual(derive.marksAsOf(m, 50).map((x) => [x.id, x.until]), [["a", null], ["b", null]]);
  assert.equal(derive.marksAsOf(m, 100)[1], m[1], "unchanged marks keep their identity");
  const series = { from: 0, to: 100, bucketMs: 10, buckets: [{ from: 0, active: {} }, { from: 10, active: {} }, { from: 40, active: {} }], limits: [], complete: true };
  assert.deepEqual(derive.seriesAsOf(series, 25).buckets.map((b) => b.from), [0, 10], "a bucket counts its whole width: only those ended by the playhead");
});

test("I-04: the cut moment, captions and the reveal (off by default, tinted when on, off again on Return to live)", async () => {
  const s = { following: false, playhead: 123_456, liveAt: 900_000, extent: { start: 0, end: 900_000 }, timeline: {} };
  assert.equal(frame.heldAtOf(s), s.playhead, "paused: the playhead itself (a mark jumped to is drawn at it)");
  const held = frame.heldAtOf({ ...s, playing: true });
  assert.ok(held !== null && held <= s.playhead && s.playhead - held < 1000, "playing: rounded down, never past the playhead");
  assert.equal(frame.heldAtOf({ ...s, timeline: { revealAfter: true } }), null, "revealed: the tracks show what is held up to the live edge");
  assert.equal(frame.heldAtOf({ ...s, following: true, playhead: 900_000 }), null, "following live: unchanged");
  const a = frame.asOfPlayhead(s);
  assert.equal(a.revealed, false);
  assert.match(frame.asOfCaption(a), /what had happened by the playhead at .*nothing later is drawn/);
  assert.match(frame.asOfShort(a), /^As of the playhead at /);
  const r = frame.asOfPlayhead({ ...s, timeline: { revealAfter: true } });
  assert.equal(r.revealed, true);
  assert.match(frame.asOfCaption(r), /^Showing what happened after the playhead/);
  assert.match(frame.asOfShort(r), /^Including what happened after the playhead/);
  // The store: off by default, and "Return to live" turns it off.
  const { manualClock } = await import("../src/scene/clock.ts");
  const store = S.createSceneStore({ fixture: SCENARIO, clock: manualClock() });
  assert.notEqual(store.getState().timeline.revealAfter, true);
  store.setTimelineView({ revealAfter: true });
  store.followLive();
  assert.notEqual(store.getState().timeline.revealAfter, true);
  // The workspace and the band are wired to it (the band is tinted only when revealed).
  const ws = src("timeline/Workspace.tsx");
  assert.match(ws, /spansAsOf\(allSpans, heldAt\)/);
  assert.match(ws, /marksAsOf\(fetched\.marks, heldAt\)/);
  assert.match(ws, /liveAt: shownAt/);
  assert.match(ws, /heldAt=\{heldAt\}/);
  assert.match(src("timeline/render/TrackCanvas.tsx"), /afterPlayheadBand\(revealed,/);
  assert.match(src("timeline/controls/TimelineToolbar.tsx"), /Show what happened after this moment/);
});

// ---------------------------------------------------------------- the overview strip (lead's decision on I-04)

const OV = await import("../src/timeline/overview/model.ts");
const { densityOf, concurrencyOf } = derive;

test("I-04 overview: replayed progressively, no density, activity or landmark after the playhead; the extent stays whole", () => {
  const whole = { from: 0, to: SCENARIO.duration };
  const times = ALL.flatMap((s) => [startOf(s), endOf(s)]).filter((x) => x !== null).sort((a, b) => a - b);
  const density = densityOf(times, whole, 120, true);
  const concurrency = concurrencyOf(ALL, whole, 120, SCENARIO.duration, [], true);
  const o = { density, concurrency, marks: MARKS, loading: false };
  let seen = 0;
  for (const t of SAMPLE) {
    const held = OV.overviewAsOf(o, t);
    assert.equal(held.density.from, whole.from);
    assert.equal(held.density.to, whole.to, "plain extent: the brush still navigates the whole history");
    for (const b of held.density.buckets) assert.ok(b.from + held.density.bucketMs <= t, `density bucket ${b.from} runs past ${t}`);
    if (held.concurrency) for (const b of held.concurrency.buckets) assert.ok(b.from + held.concurrency.bucketMs <= t, `activity bucket ${b.from} runs past ${t}`);
    for (const m of held.marks) {
      assert.ok(m.at <= t, `landmark ${m.id} at ${m.at} > ${t}`);
      assert.ok(m.until === null || m.until <= t, `landmark ${m.id} until ${m.until} > ${t}`);
    }
    // What the strip draws and says from them: aggregated landmarks and the window's words.
    const agg = OV.aggregateMarks(held.marks, whole, 800, t);
    for (const p of agg.points) assert.ok(OV.tOf(p.x, whole, 800) <= t + SCENARIO.duration / 800 + 1, `a landmark is drawn after ${t}`);
    seen += held.marks.length;
  }
  assert.ok(seen > 50, `the check looked at landmarks (${seen})`);
  // The detector: the uncut strip at an early playhead holds later landmarks.
  const early = SCENARIO.duration / 4;
  assert.ok(MARKS.some((m) => m.at > early));
  assert.equal(OV.overviewAsOf(o, SCENARIO.duration + 1).marks.length, MARKS.length, "at the end: everything");
  assert.equal(OV.AFTER_NOT_SHOWN, "after this moment, not shown");
  const src2 = src("timeline/overview/TemporalOverview.tsx");
  assert.match(src2, /heldAt === null \? fetched : overviewAsOf\(fetched, heldAt\)/);
  assert.match(src2, /Held at the playhead, \$\{spokenTime\(heldAt\)\}: \$\{AFTER_NOT_SHOWN\}/, "an accessible label");
});

// ---------------------------------------------------------------- N10: every run of a ticket is labelled in "Why did it retry?"

test("N10: a run with no build or verify visit of its own (inside another run's visit) is still labelled, at the pass it fell in", async () => {
  const IM = await import("../src/timeline/investigate/model.ts");
  const T0 = Date.UTC(2026, 10, 13, 5, 0);
  const at = (m) => T0 + m * 60_000;
  const end = (t, reason = "completed") => ({ eventId: null, at: t, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason });
  const sp = (id, kind, entity, parent, ids, from, to, reason = "completed", attrs = {}) => ({ id, kind, entity, parent, ids, start: end(from, null), end: to === null ? null : end(to, reason), duration: { ms: to === null ? null : to - from, minMs: null, maxMs: null, basis: to === null ? "open" : "measured" }, outcome: null, authority: "observed", attrs });
  const tk = { ticket_id: "LOCAL-001" };
  const spans = [
    sp("execution:x1", "execution", "execution:x1", "cell:LOCAL-001", { ...tk, execution_id: "x1" }, at(0), at(5), "failed", { attempt: 1 }),
    sp("execution:x2", "execution", "execution:x2", "cell:LOCAL-001", { ...tk, execution_id: "x2" }, at(8), at(9), "failed", { attempt: 2 }),
    sp("execution:x3", "execution", "execution:x3", "cell:LOCAL-001", { ...tk, execution_id: "x3" }, at(60), at(70), "interrupted", { attempt: 3 }),
    sp("visit:b1", "visit", "visit:LOCAL-001/build#1", "execution:x1", { ...tk, station: "build", execution_id: "x1" }, at(2), at(62)),
    sp("visit:v1", "visit", "visit:LOCAL-001/verify#1", "execution:x3", { ...tk, station: "verify", execution_id: "x3" }, at(63), at(64), "completed"),
    sp("visit:b2", "visit", "visit:LOCAL-001/build#2", "execution:x3", { ...tk, station: "build", execution_id: "x3" }, at(66), at(67)),
  ];
  const l = IM.ladderOf("LOCAL-001", spans, [], at(80));
  const labels = [...l.attempts, ...l.unvisited].map((r) => r.label).sort();
  assert.deepEqual(labels, ["Run 1 of 3", "Run 2 of 3", "Run 3 of 3"], "each run labelled once");
  assert.equal(l.unvisited.length, 1);
  assert.equal(l.unvisited[0].ref, "execution:x2");
  assert.equal(l.unvisited[0].fromSlot, 0, "placed at the pass whose build was open when it started");
  assert.equal(l.unvisited[0].endReason, "failed");
  // Held before run 2 began: it is not there (nothing after the playhead).
  assert.equal(IM.ladderOf("LOCAL-001", spans, [], at(7)).unvisited.length, 0);
  assert.match(src("timeline/investigate/Retries.tsx"), /no visit of its own/);
});

// M6.3 live pass: defects seen watching a real supervised run live (L1–L8) and the performance
// measurement's P1–P3. Pure functions and the data layer, in node.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const contract = await import("../src/timeline/contract.ts");
const frame = await import("../src/timeline/controls/frame.ts");
const hash = await import("../src/shell/source/hash.ts");
const overview = await import("../src/timeline/overview/useOverviewData.ts");
const lensData = await import("../src/timeline/investigate/useLensData.ts");
const extent = await import("../src/timeline/data/extent.ts");
const observerData = await import("../src/timeline/data/observer.ts");
const { createObserverClient } = await import("../src/live/observer.ts");
const { buildTrackTree, markTrackOf } = await import("../src/timeline/tracks/build.ts");
const draw = await import("../src/timeline/render/draw.ts");
const palette = await import("../src/timeline/render/palette.ts");
const lod = await import("../src/timeline/render/lod.ts");
const words = await import("../src/timeline/render/words.ts");
const inspectorModel = await import("../src/timeline/inspector/model.ts");
const inspectorWords = await import("../src/shell/inspector/words.ts");
const selectors = await import("../src/sim/selectors.ts");
const { at, span } = await import("../src/timeline/dev/fixture.ts");

const T0 = Date.UTC(2026, 10, 13, 16, 52, 42);
const S = 1000;
const M = 60 * S;
const whole = { from: T0, to: T0 + 15 * M };

// ---------------------------------------------------------------- L1

test("L1: a following window is the last stretch up to the live edge, wherever the edge is", () => {
  const w = frame.followWindow(3 * M);
  assert.equal(frame.isFollow(w), true);
  assert.equal(frame.isAll(w), false, "a following window is not 'all'");
  assert.equal(frame.isPinned(w), false);
  assert.deepEqual(frame.resolveWindow(w, whole, whole), { from: whole.to - 3 * M, to: whole.to });
  const later = { from: T0, to: T0 + 20 * M };
  assert.deepEqual(frame.resolveWindow(w, later, later), { from: later.to - 3 * M, to: later.to }, "it moves with the edge");
  assert.equal(frame.isAll(frame.ALL_WINDOW), true);
  assert.equal(frame.isPinned({ from: T0, to: T0 + M }), true);
});

test("L1: a lens chosen while following keeps following at its frame's length; not following, it pins", () => {
  const frameWin = { from: T0 + M, to: T0 + 4 * M };
  const lens = { id: "concurrency", preset: () => ({ grouping: "execution", window: frameWin }) };
  const view = { ...contract.INITIAL_TIMELINE_VIEW };
  const tree = buildTrackTree([], "product", contract.NO_FILTERS, whole.to);
  const following = frame.switchLens(lens, tree, view, whole, null, true);
  assert.equal(frame.isFollow(following.patch.window), true);
  assert.equal(frame.followLength(following.patch.window), 3 * M, "the frame sets the zoom level only");
  const pinned = frame.switchLens(lens, tree, view, whole, null, false);
  assert.deepEqual(pinned.patch.window, frameWin);
  // "No lens" gives back the window from before the lens (the following default), in both cases.
  for (const chosen of [following, pinned]) {
    const now = { ...view, ...chosen.patch };
    const left = frame.switchLens(null, tree, now, whole, chosen.memo, true);
    assert.equal(left.patch.window, null);
    assert.equal(left.patch.lens, null);
  }
  // The person moved the window after the lens: theirs stays.
  const moved = { ...view, ...pinned.patch, window: { from: T0, to: T0 + M } };
  assert.equal("window" in frame.switchLens(null, tree, moved, whole, pinned.memo, true).patch, false);
});

test("L1: a pinned window the live edge has passed says how far ahead; following again keeps a lens's zoom", () => {
  const pin = { from: T0, to: T0 + 3 * M };
  assert.equal(frame.pinnedBehind(pin, pin, T0 + 6 * M), 3 * M);
  assert.equal(frame.pinnedBehind(pin, pin, T0 + 3 * M), null, "the edge still in the window");
  assert.equal(frame.pinnedBehind(null, pin, T0 + 6 * M), null, "the default follows");
  assert.equal(frame.pinnedBehind(frame.followWindow(M), pin, T0 + 6 * M), null);
  assert.equal(frame.followingAgain(pin, false), null);
  assert.equal(frame.followLength(frame.followingAgain(pin, true)), 3 * M);
  assert.equal(frame.windowFollows(null), true);
  assert.equal(frame.windowFollows(pin), false);
});

test("L1: the address keeps a following window as win=live-<ms>", () => {
  const h = hash.formatHash({ route: "timeline", sel: null, at: null, win: frame.followWindow(180_000), group: "product" });
  assert.equal(h, "#timeline?win=live-180000");
  const back = hash.parseHash(h).win;
  assert.equal(frame.isFollow(back), true);
  assert.equal(frame.followLength(back), 180_000);
  assert.equal(hash.parseHash("#timeline?win=all").win.from, Number.NEGATIVE_INFINITY);
  assert.equal(hash.parseHash("#timeline?win=live-0").win, null);
});

test("L1 (iv): nothing running since the last recorded moment; null while something runs", () => {
  const done = span("v", "visit", at(T0), at(T0 + 2 * M), { ids: { station: "build" } });
  const person = span("h", "visit", at(T0 + 2 * M), null, { ids: { station: "human-approval" } });
  const wait = span("w", "slice-wait", at(T0), null);
  // Since the last work that runs ended, not the last record (a Factory disabled later is not work).
  assert.equal(frame.idleSinceOf([done, person, wait], { from: T0, to: T0 + 9 * M }), T0 + 2 * M);
  assert.equal(frame.idleSinceOf([person, wait], { from: T0, to: T0 + 9 * M }), T0 + 9 * M, "no work ran: the recorded end");
  assert.equal(frame.idleSinceOf([done, span("x", "execution", at(T0), null)], null), null);
});

// ---------------------------------------------------------------- L3, L5, L7

test("L3: cost by model is read only from usage received by the playhead", () => {
  const usage = { event: { type: "execution.usage", data: { models: { haiku: { cost_usd: 0.02 }, opus: { cost_usd: 0.53 } } } } };
  const other = { event: { type: "agent.progressed" } };
  assert.deepEqual(inspectorWords.modelCostsOf([other]), [], "nothing recorded by then: nothing shown");
  assert.deepEqual(inspectorWords.modelCostsOf([other, usage]), [["haiku", 0.02], ["opus", 0.53]]);
});

test("L3: a count-only agent's tool calls are not read from its final count before it ends", () => {
  const agent = span("a", "agent", at(T0), at(T0 + M), { attrs: { toolsCountOnly: true, toolCalls: 21 } });
  assert.match(inspectorModel.toolCallsWords(agent, T0 + 2 * M), /^21 tool calls/);
  assert.doesNotMatch(inspectorModel.toolCallsWords(agent, T0 + 10 * S), /21/);
});

test("L5: an execution ended when its process ended; the supervisor's later record is not its end", () => {
  assert.equal(selectors.executionEndedAt({ processEndedAt: T0 + 4 * M, endedAt: T0 + 6 * M }), T0 + 4 * M);
  assert.equal(selectors.executionEndedAt({ processEndedAt: null, endedAt: T0 + 6 * M }), T0 + 6 * M);
  assert.equal(selectors.executionEndedAt({ processEndedAt: null, endedAt: null }), null);
});

test("L7a: a human-approval visit is drawn as a wait on a person, terracotta, never a work bar", () => {
  const visit = span("visit:T/human-approval#1", "visit", at(T0), null, { ids: { station: "human-approval", ticket_id: "T" } });
  assert.equal(draw.familyOfSpan(visit), "person");
  assert.equal(draw.shortLabel(visit), "Waiting for a person");
  assert.equal(palette.toneOf(visit, lod.spanTimes(visit, T0 + M), T0 + M), "human");
  const build = span("visit:T/build#1", "visit", at(T0), null, { ids: { station: "build", ticket_id: "T" } });
  assert.equal(draw.familyOfSpan(build), "bar");
  assert.equal(palette.toneOf(build, lod.spanTimes(build, T0 + M), T0 + M), "live");
});

test("L7c, L7d: the stations' own words are worded, the raw word kept; an untitled slice is named once", () => {
  assert.deepEqual(inspectorModel.outcomeWordsOf("AWAITING_HUMAN"), { words: "review approved; waiting for a person's approval", own: "AWAITING_HUMAN" });
  assert.deepEqual(inspectorModel.outcomeWordsOf("finished"), { words: "finished", own: null });
  assert.equal(inspectorWords.sliceTitle({ id: "SLICE-002", title: "SLICE-002" }), null);
  assert.equal(inspectorWords.sliceTitle({ id: "SLICE-002", title: "Word counts" }), "Word counts");
});

// ---------------------------------------------------------------- L2, L6, L7b

test("L2: a capacity wait with its recorded limit says 'waiting for a free place (1 of 1 in use)'", () => {
  const wait = span("capacity-wait:slice:SLICE-002@x", "capacity-wait", at(T0, { precision: "bounded", notBefore: T0 - 5 * S }), null, { entity: "slice:SLICE-002", ids: { slice_id: "SLICE-002", wave_id: "WAVE-001" }, attrs: { limit: 1 } });
  assert.equal(words.capacityWords(wait), "waiting for a free place (1 of 1 in use)");
  assert.equal(draw.shortLabel(wait), "Waiting for a free place (1 of 1 in use)");
  assert.equal(words.capacityWords({ attrs: {} }), "waiting for capacity");
  // On the slice's Waits row.
  const tree = buildTrackTree([wait, span("wave:WAVE-001", "wave", at(T0), null, { entity: "wave:WAVE-001", ids: { wave_id: "WAVE-001" } })], "product", contract.NO_FILTERS, T0 + M);
  assert.deepEqual(tree.ofSpan.get(wait.id)?.trackId, "slice:SLICE-002/waits");
});

/** One execution with an agent and a station visit (the visit's parent is the execution, its ids name the wave). */
function liveRun() {
  const ids = { ticket_id: "LOCAL-001", slice_id: "SLICE-001", wave_id: "WAVE-001" };
  return [
    span("execution:x1", "execution", at(T0 + 2 * M), at(T0 + 6 * M), { entity: "execution:x1", ids: { ...ids, execution_id: "x1" } }),
    span("agent:x1/a", "agent", at(T0 + 3 * M), at(T0 + 4 * M), { entity: "agent:x1/a", parent: "workflow:x1/w", ids: { ...ids, execution_id: "x1", agent_id: "x1/a" }, attrs: { label: "LOCAL-001: what next?" } }),
    span("visit:LOCAL-001/build#1", "visit", at(T0 + 3 * M), at(T0 + 4 * M), { entity: "visit:LOCAL-001/build#1", parent: "execution:x1", ids: { ...ids, station: "build", execution_id: "x1" } }),
  ];
}

test("L6: a mark is drawn only on a track about its entity, never on a row that merely names it", () => {
  const spans = liveRun();
  const exec = buildTrackTree(spans, "execution", contract.NO_FILTERS, T0 + 10 * M);
  assert.equal(markTrackOf(exec, "wave:WAVE-001"), null, "the wave's intake has no row in the execution grouping (it was drawn on an agent row)");
  assert.notEqual(markTrackOf(exec, "execution:x1"), null);
  const product = buildTrackTree(spans, "product", contract.NO_FILTERS, T0 + 10 * M);
  assert.equal(markTrackOf(product, "wave:WAVE-001"), "wave:WAVE-001");
  assert.equal(markTrackOf(product, "visit:LOCAL-001/build#1"), "station:LOCAL-001/build");
  // L7b: the supervisor's recovery of the execution is not drawn on the Build row (its visit's parent).
  assert.notEqual(markTrackOf(product, "execution:x1"), "station:LOCAL-001/build");
});

// ---------------------------------------------------------------- L4 is observer side (Go); L8, P1–P3

test("L8: the overview asks ahead of the live edge and does not ask again while the edge moves inside it", () => {
  const first = overview.askedExtent(null, whole);
  assert.ok(first.to > whole.to);
  let asked = first;
  let asks = 0;
  for (let t = whole.to; t < whole.to + 60 * S; t += S) {
    const next = overview.askedExtent(asked, { from: whole.from, to: t });
    if (next !== asked) asks += 1;
    asked = next;
  }
  assert.equal(asks, 0, "a minute of live-edge steps, no request");
  assert.notEqual(overview.askedExtent(asked, { from: whole.from, to: first.to + S }), asked, "past what was asked: asked again");
  assert.ok(overview.NOTIFY_THROTTLE_MS >= 2000 && lensData.NOTIFY_THROTTLE_MS >= 2000);
});

test("L8: a lens on a following window asks the same range while the window moves within a step", () => {
  const ranges = new Set();
  for (let t = 0; t < 20 * S; t += S) {
    const r = lensData.lensRange({ from: T0 + t, to: T0 + 3 * M + t });
    ranges.add(`${r.from}-${r.to}`);
  }
  assert.ok(ranges.size <= 2, `${ranges.size} ranges asked in 20 s of a following 3 min window`);
  const r = lensData.lensRange({ from: T0, to: T0 + 3 * M });
  assert.ok(r.from <= T0 && r.to >= T0 + 3 * M);
});

test("L8: identical requests in flight are one request; one caller giving up does not stop the others", async () => {
  const calls = [];
  const fetch = (url, init) =>
    new Promise((resolve, reject) => {
      calls.push(url);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(() => resolve({ status: 200, json: async () => ({ ok: true, data: { items: [] } }) }), 20);
    });
  const client = createObserverClient({ fetch });
  const a = new AbortController();
  const p1 = client.marks({ fromMs: 0, toMs: 1000, signal: a.signal });
  const p2 = client.marks({ fromMs: 0, toMs: 1000 });
  a.abort();
  await assert.rejects(p1, /abort/i);
  await p2;
  assert.equal(calls.length, 1);
  await client.marks({ fromMs: 0, toMs: 1000 });
  assert.equal(calls.length, 2, "answered: the next ask is a new request");
});

test("L8: the recorded extent is read once for every caller until the provider says its cursor moved", async () => {
  let reads = 0;
  const listeners = new Set();
  const data = {
    extent: () => whole,
    density: async () => {
      reads += 1;
      return { bucketMs: M, buckets: [{ from: T0, count: 3 }], total: 3 };
    },
    nextMark: async () => null,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
  };
  const [a, b] = await Promise.all([extent.sharedRecordedExtent(data), extent.sharedRecordedExtent(data)]);
  assert.deepEqual(a, b);
  await extent.sharedRecordedExtent(data);
  assert.equal(reads, 1);
  for (const l of listeners) l();
  await extent.sharedRecordedExtent(data);
  assert.equal(reads, 2);
});

test("P3: the playhead moving, or the scene reading another history window for it, is not a data change", () => {
  const log = {};
  const base = { log, logVersion: 3, arrived: 10, series: null, factoryStatus: null, playhead: T0 };
  assert.equal(observerData.observerDataChanged(base, { ...base, playhead: T0 + M }), false);
  assert.equal(observerData.observerDataChanged(base, { ...base, playhead: T0 - M, log: {}, logVersion: 4 }), false, "another window shown");
  assert.equal(observerData.observerDataChanged(base, { ...base, logVersion: 4 }), true, "the same log grew");
  assert.equal(observerData.observerDataChanged(base, { ...base, arrived: 11 }), true);
  // L8: the same series read again is not a change; new counts are.
  const series = { bucketMs: M, buckets: [{ fromMs: T0, count: 3 }], total: 3, coarse: false };
  assert.equal(observerData.observerDataChanged({ ...base, series }, { ...base, series: { ...series, buckets: [{ fromMs: T0, count: 3 }] } }), false);
  assert.equal(observerData.observerDataChanged({ ...base, series }, { ...base, series: { ...series, total: 4, buckets: [{ fromMs: T0, count: 4 }] } }), true);
});

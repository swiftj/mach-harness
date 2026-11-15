// M6.3 Timeline, round 5 (browser end-to-end findings, client side):
// - case 7: a slice that waited to the end and never got a cell is in the product tree, under its wave, with its Waits row;
// - case 10: a past tile re-read before the observer's projection took a late event in (its reply cursor behind the
//   stream's) is read again, without a request storm, and the provider listens to arrivals while a history window is shown;
// - case 8: an interrupted, timed-out or unknown-outcome execution never "took", "failed" or "running", and the work inside
//   an ended execution is closed at its end, with and without an observer that closes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { live } from "./_load.mjs";
import { fakeObserver, fakeTimers } from "./fixtures/observer.mjs";
import { span, at } from "./fixtures/spans.mjs";

const { createObserverTimelineData } = await import("../src/timeline/data/observer.ts");
const { closeEndedChildren } = await import("../src/timeline/data/derive.ts");
const { createTileCache } = await import("../src/timeline/data/cache.ts");
const { buildTrackTree } = await import("../src/timeline/tracks/index.ts");
const { durationWords, describeSpan, stoppedState } = await import("../src/timeline/render/words.ts");
const { durationSentence, spanHeadline } = await import("../src/timeline/inspector/model.ts");
const { NO_FILTERS } = await import("../src/timeline/contract.ts");

// ---------------------------------------------------------------- case 7

test("case 7: a slice with only an open dependency wait (no cell) is under its wave, with a Waits row", () => {
  const spans = [
    span({ kind: "wave", entity: "wave:W3", ids: { wave_id: "W3" }, start: at(0) }),
    span({ kind: "cell", entity: "cell:T1", ids: { ticket_id: "T1", slice_id: "S1", wave_id: "W3" }, start: at(1), end: at(50), outcome: "merged" }),
    span({ kind: "slice-wait", entity: "slice:S9", parent: "slice:S9", ids: { slice_id: "S9", ticket_id: "T9", wave_id: "W3" }, start: at(2) }),
  ];
  const tree = buildTrackTree(spans, "product", NO_FILTERS, at(100));
  const slice = tree.byId.get("slice:S9");
  assert.ok(slice, "the slice is in the tree");
  assert.equal(slice.parentId, "wave:W3", "under its wave, not 'No wave recorded'");
  const waits = slice.children.find((c) => c.kind === "waits");
  assert.ok(waits, "with its Waits row");
  assert.equal(waits.lanes[0].spans[0].id, "slice-wait:slice:S9");
  assert.equal(waits.lanes[0].spans[0].end, null);
  assert.ok(!tree.byId.has("factory/unplanned"));
});

// ---------------------------------------------------------------- case 10

function fakeStore(initial = {}) {
  let state = { source: "live", logVersion: 0, arrived: 10, liveAt: at(600), extent: { kind: "so-far", start: at(0), end: at(600), events: 10, belowFloor: 0 }, series: null, connection: null, ...initial };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();
const wire = (kind, entity, from, to, ids = {}) => ({
  span_id: `${kind}:${entity}`,
  kind,
  entity,
  parent: null,
  ids,
  start: { event_id: `${entity}-s`, at: iso(from), precision: "ms", basis: "recorded" },
  end: to === null ? null : { event_id: `${entity}-e`, at: iso(to), precision: "ms", basis: "recorded", reason: "completed" },
  duration: { ms: to === null ? null : to - from, min_ms: null, max_ms: null, basis: to === null ? "open" : "measured" },
  outcome: null,
  lane: 0,
  authority: "authoritative",
});

function clocked() {
  const timers = fakeTimers();
  let now = at(600);
  Object.defineProperty(timers, "now", { get: () => now });
  return { timers, tick: (ms) => (now += ms) };
}

test("case 10: arrivals while a history window is shown (logVersion still) tell the provider's listeners", () => {
  const server = fakeObserver();
  const store = fakeStore();
  const provider = createObserverTimelineData(live.createObserverClient({ fetch: server.fetch }), store, { timers: fakeTimers() });
  let told = 0;
  provider.subscribe(() => (told += 1));
  store.set({ arrived: 11 }); // the shown log is a history window: logVersion does not move
  assert.equal(told, 1);
});

test("case 10: a past tile answered from behind the stream's cursor is read again once due, then left alone", async () => {
  const { timers, tick } = clocked();
  const server = fakeObserver();
  server.spans = [wire("cell", "cell:old", at(0), at(1))];
  server.commit([{ id: "a", type: "x", time: { order_ms: at(0) } }]);
  const head = (n) => `${server.generation}.${n}`;
  const store = fakeStore({ connection: { cursor: head(1) } });
  const provider = createObserverTimelineData(live.createObserverClient({ fetch: server.fetch }), store, { timers, now: () => timers.now });
  const requests = () => server.requests.filter((r) => r.includes("/spans?")).length;
  let told = 0;
  provider.subscribe(() => (told += 1));
  const past = { from: at(0), to: at(5) }; // one tile
  assert.equal((await provider.spans({ window: past })).spans.length, 1);
  assert.equal(timers.pendingTimeouts, 0, "a reply at the stream's cursor schedules nothing");

  // A late event reaches the stream (cursor 2) before the projection (replies still at 1).
  store.set({ arrived: 11, connection: { cursor: head(2) } });
  tick(2000);
  const first = await provider.spans({ window: past });
  assert.equal(first.spans.length, 1, "the projection has not taken it in yet");
  const n = requests();
  assert.ok(timers.pendingTimeouts > 0, "a notice is due: the reply lags the stream");
  // The projection catches up; the notice re-reads the past tile.
  server.spans = [...server.spans, wire("visit", "visit:T/audit#1", at(2), at(3), { ticket_id: "T", station: "audit" })];
  server.commit([{ id: "late", type: "x", time: { order_ms: at(2) } }]);
  tick(2000);
  const before = told;
  while (timers.pendingTimeouts) timers.runTimeouts();
  assert.ok(told > before, "told again");
  const second = await provider.spans({ window: past });
  assert.deepEqual(second.spans.map((s) => s.id).sort(), ["cell:cell:old", "visit:visit:T/audit#1"]);
  assert.equal(requests(), n + 1, "one request for the tile");
  // Caught up: nothing more is scheduled, and the tile is served as held.
  while (timers.pendingTimeouts) timers.runTimeouts();
  await provider.spans({ window: past });
  assert.equal(requests(), n + 1);
});

test("case 10: replies that never catch up are re-read a bounded number of times per stream position", async () => {
  const { timers, tick } = clocked();
  const server = fakeObserver();
  server.spans = [wire("cell", "cell:old", at(0), at(1))];
  const store = fakeStore({ connection: { cursor: `${server.generation}.99` } });
  const provider = createObserverTimelineData(live.createObserverClient({ fetch: server.fetch }), store, { timers, now: () => timers.now });
  provider.subscribe(() => undefined);
  const past = { from: at(0), to: at(5) }; // one tile
  for (let i = 0; i < 30; i++) {
    await provider.spans({ window: past });
    tick(2000);
    while (timers.pendingTimeouts) timers.runTimeouts();
  }
  const n = server.requests.filter((r) => r.includes("/spans?")).length;
  assert.ok(n <= 10, `${n} requests for one tile whose replies never caught up`);
});

test("the tile cache: markLagging puts one held tile behind, due after behindAfterMs", async () => {
  let now = 0;
  const cache = createTileCache({ now: () => now, behindAfterMs: 2000 });
  let loads = 0;
  const load = async () => ({ value: ++loads, version: null });
  await cache.get("k", false, load);
  assert.equal(cache.markLagging("missing"), null);
  assert.equal(cache.markLagging("k"), 2000);
  assert.equal((await cache.get("k", false, load)).value, 1, "not due yet");
  now = 2000;
  assert.equal((await cache.get("k", false, load)).value, 2, "re-read once due");
});

// ---------------------------------------------------------------- case 8

const EXEC = { ticket_id: "T", execution_id: "x1" };
const bounded = (s, endAt, max, attrs) => ({ ...s, end: { ...s.end, at: endAt }, duration: { ms: max - 999, minMs: max - 1998, maxMs: max, basis: "bounded" }, attrs });

test("case 8: interrupted, timed out, could not start: 'after at most', never took, failed or running", () => {
  const base = span({ kind: "execution", entity: "execution:x1", ids: EXEC, start: at(0), end: at(6.8), reason: "interrupted", outcome: "interrupted" });
  for (const [state, word] of [["interrupted", "interrupted"], ["timed-out", "timed out"], ["could-not-start", "could not start"]]) {
    const s = bounded(base, at(6.8), 408999, { state });
    assert.equal(stoppedState(s), state);
    const words = durationWords(s, at(100));
    assert.match(words, new RegExp(`^${word}.* after at most 6 min 4[89] s$`));
    const all = `${words} ${describeSpan(s, at(100))} ${durationSentence(s, at(100)).text} ${spanHeadline(s, at(100))}`;
    assert.doesNotMatch(all, /\btook\b|\bfailed\b|\brunning\b|at work/, all);
  }
  // An older observer: reason "interrupted", no attrs.state, a measured duration: still never "took".
  const old = { ...base, attrs: {} };
  assert.match(durationWords(old, at(100)), /^interrupted after at most/);
});

test("case 8: an unknown outcome: 'outcome not known; last record at …', never running or completed", () => {
  // A recorded process end, outcome not known.
  const recorded = { ...span({ kind: "execution", entity: "execution:x2", ids: { ...EXEC, execution_id: "x2" }, start: at(0), end: at(30), reason: "unknown" }), attrs: { state: "unknown" } };
  assert.match(durationWords(recorded, at(100)), /^outcome not known; last record at /);
  // Bounded only by the next claim of the ticket.
  const boundedOnly = { ...recorded, end: { eventId: null, at: null, precision: "bounded", notBefore: null, notAfter: at(45), basis: "inferred", rule: "execution-outcome-unknown", reason: "unknown" }, duration: { ms: null, minMs: null, maxMs: at(45) - at(0), basis: "inferred" } };
  assert.match(durationWords(boundedOnly, at(100)), /^outcome not known; ended by .* at the latest$/);
  // An observer that sent attrs.state "unknown" with no end at all.
  const noEnd = { ...recorded, end: null, duration: { ms: null, minMs: null, maxMs: null, basis: "open" } };
  for (const s of [recorded, boundedOnly, noEnd]) {
    const all = `${durationWords(s, at(100))} ${describeSpan(s, at(100))} ${durationSentence(s, at(100)).text} ${spanHeadline(s, at(100))}`;
    assert.doesNotMatch(all, /\btook\b|\brunning\b|at work|finished|completed/, all);
    assert.match(all, /outcome not known/);
  }
});

function children(execEnd, execReason, withServerFix) {
  const exec = { ...span({ kind: "execution", entity: "execution:x1", ids: EXEC, start: at(0), end: execEnd, reason: execReason }), attrs: { state: execReason === "unknown" ? "unknown" : "interrupted" } };
  const kids = [
    span({ kind: "claim", entity: "execution:x1/claim", ids: EXEC, start: at(0) }),
    span({ kind: "workflow", entity: "workflow:x1/belt", parent: "execution:x1", ids: EXEC, start: at(1) }),
    span({ kind: "agent-queue", entity: "agent:x1/a1", parent: "workflow:x1/belt", ids: EXEC, start: at(2) }),
    span({ kind: "agent", entity: "agent:x1/a1", parent: "workflow:x1/belt", ids: EXEC, start: at(3) }),
    span({ kind: "tool", entity: "tool:x1/a1/1", parent: "agent:x1/a1", ids: EXEC, start: at(4) }),
    span({ kind: "agent", entity: "agent:x1/late", parent: "workflow:x1/belt", ids: EXEC, start: at(80) }),
  ];
  if (withServerFix) {
    for (let i = 0; i < kids.length - 1; i++) {
      const k = kids[i];
      kids[i] = { ...k, end: { eventId: null, at: execEnd, precision: "ms", notBefore: null, notAfter: null, basis: "inferred", rule: "execution-ended", reason: execReason === "unknown" ? "unknown" : "interrupted" }, duration: { ms: null, minMs: null, maxMs: execEnd - k.start.at, basis: "inferred" }, authority: "reconstructed" };
    }
  }
  return [exec, ...kids];
}

for (const withServerFix of [false, true]) {
  for (const reason of ["interrupted", "unknown"]) {
    test(`case 8: the work inside an ${reason} execution is closed at its end (${withServerFix ? "observer closed it" : "safety net"})`, () => {
      const spans = children(at(30), reason, withServerFix);
      const out = closeEndedChildren(spans);
      if (withServerFix) assert.deepEqual(out.slice(0, -1), spans.slice(0, -1), "an observer's closing is kept as sent");
      for (const s of out.slice(1, -1)) {
        assert.ok(s.end, `${s.kind} is closed`);
        assert.equal(s.end.rule, "execution-ended");
        assert.equal(s.end.reason, reason === "unknown" ? "unknown" : "interrupted");
        assert.equal(s.authority, "reconstructed");
        assert.equal(s.outcome, null);
        const words = durationWords(s, at(100));
        assert.doesNotMatch(words, /\btook\b|\brunning\b/, `${s.kind}: ${words}`);
        assert.match(words, reason === "unknown" ? /outcome not known/ : /ended without an exit record/);
      }
      assert.equal(out.at(-1).end, null, "a span that starts after the execution's end is left as it is");
    });
  }
}

test("case 8: an execution that has not ended leaves its work open; a bounded end closes it at the bound", () => {
  const running = children(null, "interrupted", false);
  running[0] = { ...running[0], end: null, attrs: { state: "running" } };
  assert.equal(closeEndedChildren(running), running);
  const unknown = children(at(30), "unknown", false);
  unknown[0] = { ...unknown[0], end: { eventId: null, at: null, precision: "bounded", notBefore: null, notAfter: at(45), basis: "inferred", rule: "execution-outcome-unknown", reason: "unknown" } };
  const out = closeEndedChildren(unknown);
  assert.equal(out[2].end.notAfter, at(45));
  assert.equal(out[2].end.at, null);
  assert.equal(out[2].duration.maxMs, at(45) - at(1));
});

test("case 8: the observer provider runs the net on an M6.3 (windowed) answer and on the structure", async () => {
  const server = fakeObserver();
  const execWire = { ...wire("execution", "execution:x1", at(0), at(30), EXEC), attrs: { state: "interrupted" } };
  execWire.end.reason = "interrupted";
  const wf = { ...wire("workflow", "workflow:x1/belt", at(1), null, EXEC), parent: "execution:x1" };
  server.spans = [execWire, wf];
  const provider = createObserverTimelineData(live.createObserverClient({ fetch: server.fetch }), fakeStore(), { timers: fakeTimers() });
  const page = await provider.spans({ window: { from: at(0), to: at(60) } });
  assert.equal(page.spans.find((s) => s.kind === "workflow").end.rule, "execution-ended");
  const structure = await provider.structure();
  assert.equal(structure.spans.find((s) => s.kind === "workflow").end.rule, "execution-ended");
});

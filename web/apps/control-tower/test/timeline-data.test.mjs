// M6.3 Execution Timeline, data layer: the observer provider against the in-memory observer
// (parsing, truncation, degradation on an older observer, tile cache, abort, throttled refetch on
// logVersion, marks) and the simulation provider on the M6.0 scenario (every kind the scenario has,
// no tool spans for count-only agents, no outcome before its event).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { fakeObserver, fakeTimers, settle } from "./fixtures/observer.mjs";
import { beltRun, finalize } from "./fixtures/v3.mjs";

// The modules behind data/index.ts (its React hook pulls in .tsx, which node's test runner does not load).
const { createObserverTimelineData } = await import("../src/timeline/data/observer.ts");
const { createSimulationTimelineData } = await import("../src/timeline/data/simulation.ts");
const { spansOfScene } = await import("../src/timeline/data/scene.ts");
const { readSpan } = await import("../src/timeline/data/parse.ts");
const { tilesFor } = await import("../src/timeline/data/derive.ts");
const { createObserverClient } = live;

const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

/** A span in the observer's wire shape. */
function wire(kind, entity, { start = 0, end = null, startExtra = {}, endExtra = {}, basis, outcome = null, attrs, ids = {}, parent = null, authority = "authoritative", id } = {}) {
  const at = (ms) => (ms === null ? null : iso(T0 + ms));
  return {
    span_id: id ?? `${kind}:${entity}`,
    kind,
    entity,
    parent,
    ids,
    start: start === null ? null : { event_id: `e-${kind}-${entity}-s`, at: at(start), precision: "ms", basis: "recorded", ...startExtra },
    end: end === null ? null : { event_id: `e-${kind}-${entity}-e`, at: at(end), precision: "ms", basis: "recorded", reason: "completed", ...endExtra },
    duration: { ms: end !== null && start !== null ? end - start : null, min_ms: null, max_ms: null, basis: basis ?? (end === null ? "open" : "measured") },
    outcome,
    lane: 0,
    authority,
    ...(attrs ? { attrs } : {}),
  };
}

/** The store parts the provider reads, settable by hand. */
function fakeStore(initial = {}) {
  let state = { source: "live", logVersion: 0, liveAt: T0 + 60 * MIN, extent: { kind: "so-far", start: T0, end: T0 + 60 * MIN, events: 10, belowFloor: 0 }, series: null, ...initial };
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
    get listeners() {
      return listeners.size;
    },
  };
}

function setup({ spans = [], marks = null, concurrency = null, store = fakeStore(), timers = fakeTimers(), ...rest } = {}) {
  const server = fakeObserver(rest);
  server.spans = spans;
  server.marks = marks;
  server.concurrency = concurrency;
  const client = createObserverClient({ fetch: server.fetch });
  const provider = createObserverTimelineData(client, store, { timers });
  const spanRequests = () => server.requests.filter((r) => r.includes("/spans?"));
  return { server, client, store, timers, provider, spanRequests };
}

const W = (from, to) => ({ from: T0 + from, to: T0 + to });

// ---------------------------------------------------------------- parsing

test("parses every span kind, RFC 3339 times to ms, bounded ends, open spans, inferred starts and attrs", async () => {
  const kinds = ["wave", "slice-wait", "slice-eligible", "capacity-wait", "cell", "round", "visit", "task", "seat", "gate-wait", "person-wait", "claim", "execution", "workflow", "agent-queue", "agent", "tool"];
  const spans = kinds.map((k, i) => wire(k, `${k}:x${i}`, { start: i * 1000, end: i * 1000 + 500, outcome: "done", ids: { ticket_id: "LOCAL-031" } }));
  spans.push(
    wire("execution", "execution:bounded", { start: 0, end: 9000, endExtra: { at: null, not_before: iso(T0 + 8000), not_after: iso(T0 + 9500) }, basis: "bounded", outcome: "finished" }),
    wire("agent", "agent:open", { start: 2000, end: null, outcome: "done", attrs: { label: "verify the build", model: "claude-sonnet-5-5", agent_type: "verifier", tool_calls: 12, tools_count_only: true, last_tool: "Bash", tokens: 4100 } }),
    wire("task", "visit:LOCAL-031/build#1/task:T01#red", { start: 3000, end: 4000, startExtra: { basis: "inferred", rule: "previous-completion" }, basis: "inferred", outcome: "red", authority: "reconstructed" }),
    wire("visit", "visit:LOCAL-031/review#2", { start: 100, end: 900, attrs: { action: "review", round: 2 } }),
    wire("execution", "execution:x1", { start: 0, end: 5000, attrs: { attempt: 2, state: "finished", cost_usd: 1.25 } }),
    wire("seat", "seat:LOCAL-031/review#2/security", { start: 0, end: 800, attrs: { model: "opus", vote: "REJECT" } }),
    wire("slice-wait", "slice:SLICE-024", { id: "slice-wait:slice:SLICE-024#2", start: 0, end: 700, attrs: { reasons: ["waiting on SLICE-021"], depends_on: ["SLICE-021"] } }),
    { span_id: "mystery:1", kind: "mystery", entity: "x", start: { at: iso(T0) } },
  );
  const { provider } = setup({ spans });
  const page = await provider.spans({ window: W(0, 30 * MIN) });
  const by = new Map(page.spans.map((s) => [s.id, s]));
  for (const [i, k] of kinds.entries()) {
    const s = by.get(`${k}:${k}:x${i}`);
    assert.ok(s, `kind ${k} parsed`);
    assert.equal(s.kind, k);
    assert.equal(s.start.at, T0 + i * 1000, "RFC 3339 to epoch ms");
    assert.equal(s.end.at, T0 + i * 1000 + 500);
    assert.equal(s.duration.basis, "measured");
  }
  assert.ok(!by.has("mystery:1"), "an unknown kind is dropped, not guessed");

  const bounded = by.get("execution:execution:bounded");
  assert.equal(bounded.end.at, null);
  assert.equal(bounded.end.notBefore, T0 + 8000);
  assert.equal(bounded.end.notAfter, T0 + 9500);
  assert.equal(bounded.duration.basis, "bounded");

  const open = by.get("agent:agent:open");
  assert.equal(open.end, null);
  assert.equal(open.duration.basis, "open");
  assert.equal(open.outcome, null, "an outcome without an end is never kept");
  assert.deepEqual(open.attrs, { label: "verify the build", model: "claude-sonnet-5-5", agentType: "verifier", toolCalls: 12, toolsCountOnly: true, lastTool: "Bash", tokens: 4100 });

  const task = by.get("task:visit:LOCAL-031/build#1/task:T01#red");
  assert.equal(task.start.basis, "inferred");
  assert.equal(task.start.rule, "previous-completion");
  assert.equal(task.duration.basis, "inferred");
  assert.equal(task.authority, "reconstructed");

  assert.deepEqual(by.get("visit:visit:LOCAL-031/review#2").attrs, { action: "review", round: 2 });
  assert.deepEqual(by.get("execution:execution:x1").attrs, { attempt: 2, state: "finished", costUsd: 1.25 });
  assert.deepEqual(by.get("seat:seat:LOCAL-031/review#2/security").attrs, { model: "opus", vote: "REJECT" });
  assert.deepEqual(by.get("slice-wait:slice:SLICE-024#2").attrs, { reasons: ["waiting on SLICE-021"], dependsOn: ["SLICE-021"] });
  assert.deepEqual(by.get("cell:cell:x4").attrs, {}, "a missing attrs is an empty record, nothing invented");
  for (let i = 1; i < page.spans.length; i++) assert.ok((page.spans[i - 1].start?.at ?? 0) <= (page.spans[i].start?.at ?? 0), "sorted by start");
});

test("a span with only an end, or a missing duration, is read without inventing a start or a measurement", () => {
  const onlyEnd = readSpan({ span_id: "agent:a", kind: "agent", entity: "agent:a", start: null, end: { at: iso(T0), reason: "completed", basis: "recorded" }, outcome: "done", authority: "observed" });
  assert.equal(onlyEnd.start, null);
  assert.equal(onlyEnd.duration.basis, "unknown");
  assert.equal(onlyEnd.outcome, "done");
  const noBasis = readSpan({ span_id: "cell:c", kind: "cell", entity: "cell:c", start: { at: T0 }, end: { at: T0 + 10 } });
  assert.equal(noBasis.duration.basis, "unknown", "never measured by assumption");
  assert.equal(noBasis.authority, "reconstructed", "an unstated authority is not upgraded");
  assert.equal(readSpan({ span_id: "cell:c", kind: "cell", entity: "cell:c" }), null, "no time at all: not a span");
});

test("count-only agents never yield tool spans, even when the observer sends some", async () => {
  const spans = [
    wire("agent", "agent:wf1", { start: 0, end: 5000, outcome: "done", attrs: { tools_count_only: true, tool_calls: 7 } }),
    wire("tool", "tool:t1", { start: 100, end: 200, parent: "agent:wf1", outcome: "ok" }),
    wire("agent", "agent:main", { start: 0, end: 5000, outcome: "done", attrs: { tools_count_only: false, tool_calls: 1 } }),
    wire("tool", "tool:t2", { start: 100, end: 200, parent: "agent:main", outcome: "ok" }),
  ];
  const { provider } = setup({ spans });
  const ids = (await provider.spans({ window: W(0, 10 * MIN) })).spans.map((s) => s.id);
  assert.ok(!ids.includes("tool:tool:t1"));
  assert.ok(ids.includes("tool:tool:t2"));
});

// ---------------------------------------------------------------- truncation and degradation

test("truncation is surfaced with the uncapped total", async () => {
  const spans = Array.from({ length: 8 }, (_, i) => wire("tool", `tool:t${i}`, { start: i * 100, end: i * 100 + 50 }));
  const { server, provider } = setup({ spans });
  server.spanCap = 5;
  const page = await provider.spans({ window: W(0, 10_000) });
  assert.equal(page.truncated, true);
  assert.equal(page.total, 8);
  assert.equal(page.spans.length, 5);
  assert.match(page.version, /\.\d+$/, "the version is the reply's cursor");
});

test("an observer before M6.3 (no window, silent cap): filtered here, and said to be unwindowed", async () => {
  const spans = [wire("cell", "cell:in", { start: 0, end: 1000 }), wire("cell", "cell:out", { start: 50 * MIN, end: 51 * MIN })];
  const { provider } = setup({ spans });
  const old = setup({ spans });
  old.server.spansRoute = "m61";
  const page = await old.provider.spans({ window: W(0, 5 * MIN) });
  assert.deepEqual(page.spans.map((s) => s.id), ["cell:cell:in"], "out-of-window spans are not shown");
  assert.equal(page.truncated, false);
  assert.equal(old.provider.availability().unwindowed, true);
  await provider.spans({ window: W(0, 5 * MIN) });
  assert.equal(provider.availability().unwindowed, false);
  assert.equal(provider.availability().spans, "ok");
});

test("a 404 on /marks, /concurrency or /spans degrades to an honest 'not available', never a throw", async () => {
  const { provider, server } = setup({ spans: [wire("cell", "cell:a", { start: 0, end: 1000 })] });
  assert.deepEqual(await provider.marks(W(0, MIN)), []);
  assert.equal(await provider.nextMark(T0, 1, ["failure"]), null);
  const c = await provider.concurrency(W(0, 10 * MIN), 10);
  assert.deepEqual(c.buckets, []);
  assert.equal(c.complete, false);
  const a = provider.availability();
  assert.equal(a.marks, "unavailable");
  assert.equal(a.concurrency, "unavailable");
  server.spansRoute = false;
  const page = await provider.spans({ window: W(10 * MIN, 20 * MIN) });
  assert.deepEqual(page.spans, []);
  assert.equal(provider.availability().spans, "unavailable");
  server.down = true;
  const d = await provider.density(W(0, 10 * MIN), 10);
  assert.deepEqual(d.buckets, []);
  assert.equal(d.complete, false);
  assert.equal(provider.availability().density, "unknown", "a failed request says nothing about whether it is served");
});

// ---------------------------------------------------------------- caching, abort, refetch

test("tiles: the same window again costs nothing; panning fetches only the new tile", async () => {
  const spans = Array.from({ length: 30 }, (_, i) => wire("visit", `visit:v${i}`, { start: i * MIN, end: i * MIN + 30_000 }));
  const { provider, spanRequests } = setup({ spans });
  const window = W(0, 10 * MIN);
  const tiles = tilesFor(window);
  const first = await provider.spans({ window });
  assert.equal(spanRequests().length, tiles.length);
  assert.ok(first.spans.length >= 10);
  await provider.spans({ window });
  assert.equal(spanRequests().length, tiles.length, "served from the cache");
  const size = tiles[0].to - tiles[0].from;
  const panned = { from: window.from + size, to: window.to + size };
  const newTiles = tilesFor(panned).filter((t) => !tiles.some((o) => o.from === t.from));
  await provider.spans({ window: panned });
  assert.equal(spanRequests().length, tiles.length + newTiles.length, "only the new tile was fetched");
  await provider.spans({ window, kinds: ["visit"] });
  assert.ok(spanRequests().length > tiles.length + newTiles.length, "other filters are another cache key");
});

test("a superseded request is aborted, and so is one whose caller gave up", async () => {
  const spans = [wire("cell", "cell:a", { start: 0, end: 1000 }), wire("cell", "cell:b", { start: 400 * MIN, end: 401 * MIN })];
  const { server, provider } = setup({ spans });
  server.hold = true;
  const older = provider.spans({ window: W(0, 10 * MIN) });
  await settle(3);
  const newer = provider.spans({ window: W(400 * MIN, 410 * MIN) });
  await assert.rejects(older, (e) => e.name === "AbortError");
  await settle(3);
  assert.ok(server.aborted.some((u) => u.includes(`from_ms=${T0}`)), "the older tile's request was cancelled");
  server.hold = false;
  server.release();
  const page = await newer;
  assert.deepEqual(page.spans.map((s) => s.id), ["cell:cell:b"]);

  server.hold = true;
  const controller = new AbortController();
  const given = provider.spans({ window: W(900 * MIN, 905 * MIN) }, controller.signal);
  await settle(3);
  controller.abort();
  await assert.rejects(given, (e) => e.name === "AbortError");
  server.hold = false;
  server.release();
});

test("a shared tile survives the supersession of one of its callers", async () => {
  const spans = [wire("cell", "cell:a", { start: 0, end: 1000 })];
  const { server, provider, spanRequests } = setup({ spans });
  server.hold = true;
  const older = provider.spans({ window: W(0, 10 * MIN) });
  await settle(3);
  const newer = provider.spans({ window: W(0, 10 * MIN) });
  await assert.rejects(older, (e) => e.name === "AbortError");
  server.hold = false;
  server.release();
  const page = await newer;
  assert.deepEqual(page.spans.map((s) => s.id), ["cell:cell:a"]);
  assert.equal(server.aborted.length, 0, "the newer caller still needed the same tiles");
  assert.equal(spanRequests().length, tilesFor(W(0, 10 * MIN)).length, "one request per tile, shared");
});

test("live: logVersion moving refetches only tiles at the live edge, throttled to one notice per 500 ms", async () => {
  const store = fakeStore({ liveAt: T0 + 60 * MIN });
  const timers = fakeTimers();
  const spans = [wire("cell", "cell:old", { start: 0, end: MIN }), wire("execution", "execution:now", { start: 55 * MIN, end: null, outcome: null })];
  const { server, provider, spanRequests } = setup({ spans, store, timers });
  let told = 0;
  const off = provider.subscribe(() => (told += 1));
  const past = W(0, 10 * MIN);
  const edge = W(50 * MIN, 60 * MIN);
  await provider.spans({ window: past });
  const atEdge = await provider.spans({ window: edge });
  assert.equal(atEdge.spans[0].end, null);
  const before = spanRequests().length;

  store.set({ logVersion: 1 });
  assert.equal(told, 1, "the first change is told at once");
  for (let v = 2; v <= 50; v++) store.set({ logVersion: v });
  assert.equal(told, 1, "no notice per event while throttled");
  assert.equal(timers.pendingTimeouts, 1);
  timers.runTimeouts();
  assert.equal(told, 2, "one more after the throttle");
  timers.runTimeouts();
  assert.equal(told, 2, "nothing pending: no extra notice");

  // The execution ended meanwhile.
  server.spans = [spans[0], wire("execution", "execution:now", { start: 55 * MIN, end: 58 * MIN, outcome: "finished" })];
  server.commit([{ id: "e1", type: "x", time: { order_ms: T0 + 58 * MIN } }]);
  await provider.spans({ window: past });
  assert.equal(spanRequests().length, before, "a past tile is reused");
  const refreshed = await provider.spans({ window: edge });
  assert.ok(spanRequests().length > before, "the edge tile is refetched");
  assert.equal(refreshed.spans[0].end.at, T0 + 58 * MIN);
  assert.equal(refreshed.spans[0].outcome, "finished");
  off();
  assert.equal(store.listeners, 0, "no store subscription without listeners");
});

test("replay: logVersion moving (windows loading) does not refetch anything", async () => {
  const store = fakeStore({ source: "replay" });
  const { provider, spanRequests } = setup({ spans: [wire("cell", "cell:a", { start: 0, end: MIN })], store });
  assert.equal(provider.source, "replay");
  const off = provider.subscribe(() => {});
  await provider.spans({ window: W(50 * MIN, 60 * MIN) });
  const n = spanRequests().length;
  store.set({ logVersion: 9 });
  await provider.spans({ window: W(50 * MIN, 60 * MIN) });
  assert.equal(spanRequests().length, n);
  off();
});

// ---------------------------------------------------------------- marks, concurrency, density, one span

test("marks in a window, and the next and previous mark of a kind", async () => {
  const mark = (id, kind, at, extra = {}) => ({ mark_id: id, kind, at: iso(T0 + at), event_id: `ev-${id}`, entity: "cell:LOCAL-031", label: `${kind} ${id}`, verdict: null, authority: "authoritative", ...extra });
  const marks = [mark("m1", "failure", MIN), mark("m2", "gate", 2 * MIN, { verdict: "refused" }), mark("m3", "failure", 5 * MIN), mark("m4", "human", 6 * MIN, { until: iso(T0 + 9 * MIN), verdict: "required" })];
  const { provider } = setup({ marks });
  const inWindow = await provider.marks(W(0, 3 * MIN));
  assert.deepEqual(inWindow.map((m) => m.id), ["m1", "m2"]);
  assert.equal(inWindow[1].verdict, "refused");
  assert.equal(inWindow[0].at, T0 + MIN);
  assert.deepEqual((await provider.marks(W(8 * MIN, 8.5 * MIN))).map((m) => m.id), ["m4"], "an interval mark overlapping the window");
  assert.equal((await provider.nextMark(T0 + MIN, 1, ["failure"])).id, "m3", "strictly after");
  assert.equal((await provider.nextMark(T0 + 5 * MIN, -1, ["failure"])).id, "m1", "strictly before");
  assert.equal(await provider.nextMark(T0 + 5 * MIN, 1, ["failure"]), null);
  assert.equal(provider.availability().marks, "ok");
});

test("concurrency and filtered density from the observer", async () => {
  const concurrency = (from, to, bucket) => ({
    from_ms: from,
    to_ms: to,
    bucket_ms: bucket,
    buckets: [{ from_ms: from, active: { execution: { max: 2, mean: 1.5 }, nonsense: { max: 9 } } }],
    limits: [{ name: "max_parallel", value: 2, from_ms: T0, to_ms: null }],
    complete: true,
  });
  const { server, provider } = setup({ concurrency, series: true });
  const c = await provider.concurrency(W(0, 10 * MIN), 10);
  assert.equal(c.bucketMs, MIN);
  assert.deepEqual(c.buckets[0].active, { execution: { max: 2, mean: 1.5 } });
  assert.deepEqual(c.limits, [{ name: "max_parallel", value: 2, from: T0, to: null }]);
  assert.equal(c.complete, true);
  server.commit([
    { id: "a", type: "station.entered", ids: { ticket_id: "LOCAL-031" }, time: { order_ms: T0 + 1000 } },
    { id: "b", type: "station.entered", ids: { ticket_id: "LOCAL-032" }, time: { order_ms: T0 + 2000 } },
  ]);
  const d = await provider.density(W(0, 10 * MIN), 10, { ticket: "LOCAL-031" });
  assert.deepEqual(d.buckets, [{ from: T0, count: 1 }]);
  assert.ok(server.requests.some((u) => u.includes("/series?") && u.includes("ticket=LOCAL-031")));
});

test("one span by id; a missing one is null", async () => {
  const { provider } = setup({ spans: [wire("agent", "agent:a1", { start: 0, end: 100, outcome: "done" })] });
  assert.equal((await provider.span("agent:agent:a1")).outcome, "done");
  assert.equal(await provider.span("agent:nope"), null);
});

// ---------------------------------------------------------------- simulation

function simStore(liveAt) {
  const log = sim.fixtureLog(sim.SCENARIO);
  return fakeStore({ source: "simulation", log, logVersion: 0, liveAt: liveAt ?? sim.SCENARIO.duration, extent: { kind: "whole-run", start: 0, end: sim.SCENARIO.duration, events: log.size(), belowFloor: 0 } });
}

test("simulation: spans of every kind the scenario has, simulated authority and precision", async () => {
  const provider = createSimulationTimelineData(simStore());
  assert.equal(provider.source, "simulation");
  const page = await provider.spans({ window: { from: 0, to: sim.SCENARIO.duration } });
  const kinds = new Set(page.spans.map((s) => s.kind));
  for (const k of ["wave", "slice-wait", "slice-eligible", "cell", "round", "visit", "task", "seat", "gate-wait", "claim", "execution", "workflow", "agent", "tool"]) assert.ok(kinds.has(k), `has ${k}`);
  for (const s of page.spans) {
    assert.equal(s.authority, "simulated");
    if (s.start) assert.equal(s.start.precision, "simulated");
  }
  assert.equal(page.truncated, false);
  const ids = new Set(page.spans.map((s) => s.id));
  assert.equal(ids.size, page.spans.length, "span ids are unique");
  const visit = page.spans.find((s) => s.id === "visit:visit:LOCAL-031/verify#1");
  assert.equal(visit.outcome, "failed");
  assert.equal(visit.end.reason, "failed");
  assert.equal(visit.start.eventId?.startsWith("sim:"), true, "the bounding event is named");
  const round1 = page.spans.find((s) => s.id === "round:gate:LOCAL-031/round#1");
  assert.equal(round1.outcome, "FAIL_WITH_EVIDENCE");
  const seat = page.spans.find((s) => s.id === "seat:seat:LOCAL-032/review#1/security");
  assert.equal(seat.attrs.vote, "REJECT");
  const filtered = await provider.spans({ window: { from: 0, to: sim.SCENARIO.duration }, ticket: "LOCAL-033", kinds: ["visit"] });
  assert.ok(filtered.spans.length > 0 && filtered.spans.every((s) => s.kind === "visit" && s.ids.ticket_id === "LOCAL-033"));
  assert.ok((await provider.marks({ from: 0, to: sim.SCENARIO.duration })).some((m) => m.kind === "failure"));
});

test("simulation: nothing after the simulated now; no outcome before its event", async () => {
  const liveAt = 1_500_000;
  const provider = createSimulationTimelineData(simStore(liveAt));
  const page = await provider.spans({ window: { from: 0, to: sim.SCENARIO.duration } });
  assert.ok(page.spans.length > 0);
  for (const s of page.spans) {
    assert.ok((s.start?.at ?? s.end?.at) <= liveAt, `${s.id} began by now`);
    if (s.end) assert.ok(s.end.at <= liveAt, `${s.id} ended by now`);
    if (s.outcome !== null) assert.ok(s.end && s.end.at <= liveAt, `${s.id}: outcome only with its end`);
  }
  const open = page.spans.find((s) => s.id === "visit:visit:LOCAL-031/verify#1");
  assert.equal(open.end, null, "verify#1 of LOCAL-031 failed at 1,640,800: still open at 1,500,000");
  assert.equal(open.outcome, null);
  assert.equal(open.duration.basis, "open");
  for (const m of await provider.marks({ from: 0, to: sim.SCENARIO.duration })) assert.ok(m.at <= liveAt);
  const next = await provider.nextMark(0, 1, ["failure"]);
  assert.ok(next === null || next.at <= liveAt);
});

test("simulation: concurrency by sweeping, density from the log, extent", async () => {
  const store = simStore();
  const provider = createSimulationTimelineData(store);
  const window = { from: 0, to: sim.SCENARIO.duration };
  const c = await provider.concurrency(window, 50);
  const peak = Math.max(...c.buckets.map((b) => b.active.execution?.max ?? 0));
  assert.equal(peak, 3, "three executions ran at once");
  assert.ok(c.buckets.every((b) => (b.active.execution?.mean ?? 0) <= (b.active.execution?.max ?? 0)));
  assert.equal(c.limits[0]?.name, "max_parallel");
  const d = await provider.density(window, 100);
  assert.equal(d.buckets.reduce((n, b) => n + b.count, 0), store.getState().log.size());
  assert.deepEqual(provider.extent(), window);
});

test("simulation: subscribers are told when the simulated now moves, throttled", () => {
  const store = simStore(1000);
  const timers = fakeTimers();
  const provider = createSimulationTimelineData(store, { timers });
  let told = 0;
  const off = provider.subscribe(() => (told += 1));
  for (let t = 2000; t < 20_000; t += 1000) store.set({ liveAt: t });
  assert.equal(told, 1);
  timers.runTimeouts();
  assert.equal(told, 2);
  off();
});

test("scene spans: a count-only (Dynamic Workflow) agent yields no tool span; per-call agents keep theirs", () => {
  const log = live.createLiveLog();
  log.ingest(finalize(beltRun().events));
  const spans = spansOfScene(log.head(), log);
  const agents = spans.filter((s) => s.kind === "agent");
  const countOnly = agents.filter((s) => s.attrs.toolsCountOnly === true);
  assert.ok(countOnly.length > 0, "the belt run has workflow agents");
  const tools = spans.filter((s) => s.kind === "tool");
  for (const t of tools) assert.ok(!countOnly.some((a) => a.entity === t.parent), `${t.id} is not under a count-only agent`);
  for (const a of countOnly) assert.equal(typeof a.attrs.toolCalls, "number", "the count is carried instead");
  for (const s of spans) if (s.outcome !== null) assert.ok(s.end !== null, `${s.id}: no outcome without an end`);
});

// ---------------------------------------------------------------- wave 2: availability, closed visits, extent, density, robustness

const { recordedExtent } = await import("../src/timeline/data/extent.ts");
const { closeEndedVisits } = await import("../src/timeline/data/derive.ts");
const { BACKOFF_MS } = await import("../src/timeline/data/observer.ts");
const { ev, finalize: finalizeV3 } = await import("./fixtures/v3.mjs");

test("availability(): the simulation serves everything; the observer says ok, unavailable, or unknown after a failure", async () => {
  const simProvider = createSimulationTimelineData(simStore());
  assert.deepEqual(simProvider.availability(), { spans: "ok", marks: "ok", concurrency: "ok", density: "ok", unwindowed: false });
  const { provider } = setup({ spans: [wire("cell", "cell:a", { start: 0, end: 1000 })] });
  assert.deepEqual(provider.availability(), { spans: "unknown", marks: "unknown", concurrency: "unknown", density: "unknown", unwindowed: false }, "nothing asked yet");
  const before = provider.availability();
  assert.equal(provider.availability(), before, "the same object while nothing changed");
  await provider.spans({ window: W(0, MIN) });
  assert.equal(provider.availability().spans, "ok");
  assert.notEqual(provider.availability(), before);
});

test("parses the M6.3 observer's closed visits, interrupted_at, limits' applies_to and history's capped", async () => {
  const visit = wire("visit", "visit:T/build#1", {
    start: 0,
    end: 136_000,
    endExtra: { basis: "inferred", rule: "execution-ended", reason: "interrupted", event_id: "e-x-end" },
    basis: "inferred",
    authority: "reconstructed",
    attrs: { interrupted_at_ms: T0 + 136_000, interrupted_reason: "execution-ended" },
    ids: { ticket_id: "T", execution_id: "x1", station: "build", visit_id: "T/build#1" },
  });
  visit.duration = { ms: null, min_ms: null, max_ms: 136_000, basis: "inferred" };
  const s = readSpan(visit);
  assert.deepEqual([s.end.basis, s.end.rule, s.end.reason, s.outcome, s.authority], ["inferred", "execution-ended", "interrupted", null, "reconstructed"]);
  assert.deepEqual([s.duration.ms, s.duration.maxMs, s.duration.basis], [null, 136_000, "inferred"]);
  assert.equal(s.attrs.interruptedAt, T0 + 136_000);
  const superseded = readSpan(wire("visit", "visit:T/verify#1", { start: 0, end: 5000, endExtra: { basis: "inferred", rule: "unclosed-visit", reason: "superseded" } }));
  assert.deepEqual([superseded.end.rule, superseded.end.reason], ["unclosed-visit", "superseded"]);

  const { provider, server } = setup({
    concurrency: (from, to, bucket) => ({
      from_ms: from, to_ms: to, bucket_ms: bucket, buckets: [], complete: true,
      limits: [
        { name: "max_parallel", value: 2, from: iso(T0), to: null, applies_to: ["execution", "cell"] },
        { name: "poll_seconds", value: 300, from: iso(T0), to: null, applies_to: null },
        { name: "older", value: 1, from: iso(T0), to: null },
      ],
    }),
  });
  const c = await provider.concurrency(W(0, 10 * MIN), 10);
  assert.deepEqual(c.limits.map((l) => [l.name, l.appliesTo]), [["max_parallel", ["execution", "cell"]], ["poll_seconds", null], ["older", undefined]]);
  assert.ok(!("appliesTo" in c.limits[2]), "absent stays absent");

  // /history's capped, passed on as is (absent from an older observer).
  const client = createObserverClient({ fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: { generation: "g", events: [], more: true, capped: true } }) }) });
  assert.equal((await client.history({ limit: 10 })).capped, true);
  assert.ok(!("capped" in (await createObserverClient({ fetch: server.fetch }).history({ limit: 10 }))));
});

test("safety net: an older observer's open visit whose execution ended in the same answer is closed by rule, never 'open'", async () => {
  const ids = (v) => ({ ticket_id: "T", execution_id: "x1", station: "build", visit_id: v });
  const spans = [
    wire("execution", "execution:x1", { start: 0, end: 136_000, ids: { ticket_id: "T", execution_id: "x1" }, outcome: "exited" }),
    // Open, though x1 ended: the run showed "Revise … 7 h 3 min", still running.
    wire("visit", "visit:T/build#1", { start: 10_000, end: null, ids: ids("T/build#1"), parent: "execution:x1", attrs: { action: "revise" } }),
    // Open, its execution still running: it stays open.
    wire("execution", "execution:x2", { start: 200_000, end: null, ids: { ticket_id: "T", execution_id: "x2" } }),
    wire("visit", "visit:T/build#2", { start: 210_000, end: null, ids: { ...ids("T/build#2"), execution_id: "x2" } }),
  ];
  const { provider } = setup({ spans });
  const page = await provider.spans({ window: W(0, 60 * MIN) });
  const v1 = page.spans.find((s) => s.id === "visit:visit:T/build#1");
  assert.ok(v1.end, "never presented as open");
  assert.deepEqual([v1.end.at, v1.end.basis, v1.end.rule, v1.end.reason, v1.end.eventId], [T0 + 136_000, "inferred", "execution-ended", "interrupted", "e-execution-execution:x1-e"]);
  assert.deepEqual([v1.outcome, v1.authority, v1.duration.basis, v1.duration.ms, v1.duration.maxMs], [null, "reconstructed", "inferred", null, 126_000]);
  const v2 = page.spans.find((s) => s.id === "visit:visit:T/build#2");
  assert.equal(v2.end, null, "an execution still running leaves its visit open");
  // A visit that began after the execution ended is not that execution's: left as it is.
  const late = { ...v1, id: "visit:late", start: { ...v1.start, at: T0 + 500_000 }, end: null };
  const exec = page.spans.find((s) => s.id === "execution:execution:x1");
  assert.equal(closeEndedVisits([exec, late])[1].end, null);
});

test("simulation provider: a visit the scene closed (execution ended without an exit) is inferred, interrupted, reconstructed; a later exit marks it interrupted", async () => {
  const TICKET = "LOCAL-001";
  const ids = (x) => ({ ticket_id: TICKET, visit_id: `${TICKET}/build#1`, station: "build", round: 1, execution_id: x });
  const entities = [`cell:${TICKET}`, `station:${TICKET}/build`, `visit:${TICKET}/build#1`];
  const out = [
    ev("station.entered", { stream: "cell-lifecycle", key: `c:${TICKET}:k`, seq: 1, t: T0, ids: ids("x1"), entities, data: { station: "build", stage: "building", action: "build", resumed: false, unclosed_visit: null, head: null, counts: {} } }),
    ev("execution.process_ended", { stream: "execution-record", key: "x:x1", seq: 2, t: T0 + 136_000, precision: "s", ids: { ticket_id: TICKET, execution_id: "x1" }, entities: ["execution:x1", `cell:${TICKET}`], data: { ended: "exited", exit_code: 0, seconds: 136 } }),
  ];
  const logOf = (events) => {
    const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
    log.ingest(events);
    return log;
  };
  const log = logOf(finalizeV3([...out]));
  const store = fakeStore({ source: "live", log, logVersion: log.version(), liveAt: T0 + 7 * 3_600_000, extent: { kind: "so-far", start: T0, end: T0 + 7 * 3_600_000, events: log.size(), belowFloor: 0 } });
  const provider = createSimulationTimelineData(store, { source: "live" });
  const page = await provider.spans({ window: { from: T0, to: T0 + 7 * 3_600_000 } });
  const v = page.spans.find((s) => s.kind === "visit");
  assert.deepEqual([v.end.at, v.end.basis, v.end.rule, v.end.reason, v.outcome, v.authority], [T0 + 136_000, "inferred", "execution-ended", "interrupted", null, "reconstructed"]);
  assert.deepEqual([v.duration.ms, v.duration.maxMs, v.duration.basis], [null, 136_000, "inferred"]);
  assert.deepEqual(await provider.span(v.id), v);

  out.push(ev("station.exited", { stream: "cell-lifecycle", key: `c:${TICKET}:k`, seq: 3, t: T0 + 3_608_000, ids: ids("x2"), entities, data: { station: "build", outcome: "built", stage: "built", duration_ms: 1000, closed_by: null, head: null, counts: {} } }));
  const later = logOf(finalizeV3(out));
  const v2 = spansOfScene(later.head(), later).find((s) => s.kind === "visit");
  assert.equal(v2.end.basis, "recorded");
  assert.equal(v2.attrs.interruptedAt, T0 + 136_000, "the stop is carried, so no view says it 'took' entry to exit");
});

test("recordedExtent: first to last recorded thing, not to the wall clock; null when nothing is held", async () => {
  // A 73-minute run viewed seven hours later.
  const HOUR = 3_600_000;
  const events = Array.from({ length: 37 }, (_, i) => T0 + Math.round((i * 73 * MIN) / 36));
  const store = fakeStore({ source: "live", liveAt: T0 + 8 * HOUR, extent: { kind: "so-far", start: T0, end: T0 + 8 * HOUR, events: 37, belowFloor: 0 } });
  const fake = {
    extent: () => ({ from: T0, to: T0 + 8 * HOUR }),
    density: async (w, n) => densityOfTimes(events, w, n),
    nextMark: async () => ({ id: "m", kind: "review", at: T0 + 70 * MIN, until: null }),
    spans: async () => { throw new Error("not asked when density is served"); },
  };
  const r = await recordedExtent(fake);
  assert.ok(r.from === T0, `from ${r.from - T0}`);
  assert.ok(r.to >= T0 + 73 * MIN && r.to <= T0 + 73 * MIN + (8 * HOUR) / 1000 + 1000, `to is the last bucket's end (${(r.to - T0) / MIN} min)`);
  // Without density: the spans' bounds and the last mark.
  const noDensity = { ...fake, density: async (w) => ({ from: w.from, to: w.to, bucketMs: 1000, buckets: [], complete: false }), spans: async () => ({ spans: [{ ...readSpan(wire("cell", "cell:a", { start: 5 * MIN, end: 80 * MIN })) }, readSpan(wire("visit", "visit:open", { start: 10 * MIN }))] }) };
  assert.deepEqual(await recordedExtent(noDensity), { from: T0 + 5 * MIN, to: T0 + 80 * MIN });
  assert.equal(await recordedExtent({ ...fake, extent: () => null }), null);
  // The observer provider, through its own density: the extent runs to the wall clock, the recorded one does not.
  const { provider } = setup({ store, series: true });
  assert.equal(provider.extent().to, T0 + 8 * HOUR);
  void provider;
});

function densityOfTimes(times, w, n) {
  const size = Math.max(1, Math.ceil((w.to - w.from) / n));
  const m = new Map();
  for (const t of times) if (t >= w.from && t < w.to) { const k = w.from + Math.floor((t - w.from) / size) * size; m.set(k, (m.get(k) ?? 0) + 1); }
  return { from: w.from, to: w.to, bucketMs: size, buckets: [...m].sort((a, b) => a[0] - b[0]).map(([from, count]) => ({ from, count })), complete: true };
}

test("density says whether the ticket or execution filter was applied", async () => {
  const provider = createSimulationTimelineData(simStore());
  const window = { from: 0, to: sim.SCENARIO.duration };
  assert.equal((await provider.density(window, 50)).filtered, false);
  const ticket = Object.keys(simStore().getState().log.head().cells)[0];
  assert.equal((await provider.density(window, 50, { ticket })).filtered, true);
  const { provider: obs } = setup({ series: true });
  assert.equal((await obs.density(W(0, 10 * MIN), 10)).filtered, false);
  assert.equal((await obs.density(W(0, 10 * MIN), 10, { ticket: "T" })).filtered, true);
});

/** Timers on a virtual clock: `advance(ms)` runs what falls due, in order. */
function clockTimers() {
  let now = 0;
  let next = 1;
  const due = new Map();
  return {
    setTimeout(fn, ms) { const h = next++; due.set(h, { fn, at: now + ms }); return h; },
    clearTimeout(h) { due.delete(h); },
    get now() { return now; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const first = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > end) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].fn();
        await settle();
      }
      now = end;
    },
  };
}

test("robustness: a failed tile keeps its last good answer; back-off 1, 2, 5, then 15 s; no request storm over a minute; subscribers told once on recovery", async () => {
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 5000, 15_000]);
  const timers = clockTimers();
  // At the live edge, so the tile goes stale when events arrive.
  const spans = [wire("visit", "visit:v1", { start: 55 * MIN, end: 56 * MIN })];
  const store = fakeStore();
  const { provider, server, spanRequests } = setup({ spans, store, timers });
  let told = 0;
  provider.subscribe(() => (told += 1));
  const window = W(50 * MIN, 60 * MIN);
  const good = await provider.spans({ window });
  assert.equal(good.spans.length, 1);
  // The live edge moves (events arrive), so the tile is stale; then the observer goes down.
  server.down = true;
  store.set({ logVersion: 1 });
  await timers.advance(600);
  const toldBefore = told;
  const before = server.requests.length;
  // A view re-asking every second for a minute.
  for (let s = 0; s < 60; s++) {
    const page = await provider.spans({ window });
    assert.deepEqual(page.spans.map((x) => x.id), ["visit:visit:v1"], "the last good tile stands");
    await provider.marks(window);
    await provider.density(window, 10);
    await timers.advance(1000);
  }
  const sent = server.requests.length - before;
  assert.ok(spanRequests().length >= 2, "the stale tile was asked for again and failed");
  // One failing round, then one probe per back-off step: 1 s, 2 s, 5 s, then every 15 s (~7 in a minute).
  if (process.env.SHOW) console.log("requests while down over a minute:", sent);
  assert.ok(sent <= 10, `${sent} requests in a minute while the observer is down`);
  assert.equal(told, toldBefore, "no notice per failure");
  // It comes back: the next probe succeeds, subscribers are told once, and the view re-asks.
  server.down = false;
  await timers.advance(15_000);
  assert.equal(told, toldBefore + 1, "told once when the observer answers again");
  await timers.advance(60_000);
  assert.equal(told, toldBefore + 1, "and not again");
  store.set({ logVersion: 2 });
  await timers.advance(600);
  const after = spanRequests().length;
  await provider.spans({ window });
  assert.equal(spanRequests().length, after + 1, "a stale tile is read again at once: requests flow again");
});

test("robustness: a cursor_reset (409) or a new epoch clears the tiles once and tells subscribers once", async () => {
  const timers = clockTimers();
  const spans = [wire("visit", "visit:v1", { start: MIN, end: 2 * MIN })];
  const { provider, server, spanRequests } = setup({ spans, timers, store: fakeStore({ source: "replay" }) });
  let told = 0;
  provider.subscribe(() => (told += 1));
  const window = W(0, 10 * MIN);
  await provider.spans({ window });
  const n = spanRequests().length;
  // A new epoch: the observer rebuilt its history; the next answer comes from another generation.
  server.generation = "ffffffffffffffff";
  await provider.marks(window); // marks 404 here: not a failure, not an epoch
  server.marks = [];
  await provider.marks(window);
  assert.equal(told, 1, "the new epoch is told once");
  await provider.spans({ window });
  assert.ok(spanRequests().length > n, "the span tiles were dropped and read again");
  await provider.spans({ window });
  assert.equal(told, 1);
  // A cursor_reset answer.
  const realFetch = server.fetch;
  let resets = 0;
  const client = createObserverClient({ fetch: async (url, init) => (url.includes("/spans?") && resets++ < 1 ? { status: 409, json: async () => ({ ok: false, error: { kind: "cursor_reset", message: "reset" } }) } : realFetch(url, init)) });
  const store = fakeStore({ source: "replay" });
  const p2 = createObserverTimelineData(client, store, { timers });
  let told2 = 0;
  p2.subscribe(() => (told2 += 1));
  const first = await p2.spans({ window });
  assert.deepEqual(first.spans, [], "nothing held yet");
  assert.equal(told2, 1, "told once, to re-ask");
  const again = await p2.spans({ window });
  assert.equal(again.spans.length, 1);
  assert.equal(told2, 1);
});

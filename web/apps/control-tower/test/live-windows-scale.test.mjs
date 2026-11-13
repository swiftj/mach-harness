// M6.2 acceptance, D17: a long history (the run's 230,853 events) is not loaded eagerly. Live starts
// from the observer's snapshot at the window's first cursor and holds a recent window; replay and
// scrubbing back read `/history` windows on demand; the timeline draws the whole history from
// `/series`. Measured through the in-memory observer (test/fixtures/observer.mjs, indexed like the
// real one) against a generated history; the numbers are printed as test diagnostics.
//
// Targets (D17): first render <= 3 s and heap <= 250 MB for the history; scrub median <= 100 ms
// within a loaded window and <= 500 ms when a window must be fetched; counts equal the observer's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import vm from "node:vm";
import { live } from "./_load.mjs";
import { beltRun, finalize } from "./fixtures/v3.mjs";
import { fakeObserver, fakeTimers, seeded, settle } from "./fixtures/observer.mjs";

const { manualClock } = await import("../src/scene/clock.ts");
v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc");
const heapMb = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1048576;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const hex = (n, w) => n.toString(16).padStart(w, "0");
const TARGET = 230_853;

/** Belts in 12 lanes, one after the other per lane, cut to exactly TARGET events. */
function history() {
  const events = [];
  let n = 0;
  for (let r = 0; events.length < TARGET; r++) {
    for (let lane = 0; lane < 12 && events.length < TARGET; lane++) {
      n++;
      const run = beltRun({ ticket: `LOCAL-${hex(n, 4)}`, slice: `SLICE-${hex(n, 4)}`, wave: `WAVE-${hex(r, 3)}`, execution: `x${hex(n, 12)}`, intakeGen: hex(n, 8), cellGen: hex(n * 7919, 8).slice(-8), t0: T0 + r * 900_000 + lane * 4_000 });
      for (const e of run.events) events.push(e);
    }
  }
  return finalize(events).slice(0, TARGET);
}

/** Wait (on settled promise chains) until a condition holds. */
async function until(cond, rounds = 400) {
  for (let i = 0; i < rounds && !cond(); i++) await settle(2);
  return cond();
}

const SERVER = fakeObserver({ snapshot: true, series: true });
SERVER.commit(history());

test("D17 live: first render from the summaries and the newest window (no snapshot), a bounded heap, counts equal to the observer's", async (t) => {
  const before = heapMb();
  const t0 = performance.now();
  const client = live.createObserverClient({ fetch: SERVER.fetch });
  const { store, source, log, windows } = live.createLiveFactory({ client, openStream: SERVER.openStream, clock: manualClock(), timers: fakeTimers() });
  await source.start();
  source.flush();
  const s0 = store.getState();
  s0.log.sceneAt(s0.playhead); // the first scene drawn
  const firstRender = performance.now() - t0;
  assert.ok(await until(() => windows.span() !== null), "the history's span is known");
  const heap = heapMb() - before;
  const status = source.status();
  t.diagnostic(`live first render ${firstRender.toFixed(0)} ms; heap +${heap.toFixed(1)} MB; held ${status.held} of ${status.total}; series ${store.getState().series?.buckets.length} buckets, total ${store.getState().series?.total}`);
  assert.ok(firstRender <= 3000, `first render ${firstRender.toFixed(0)} ms`);
  assert.ok(heap <= 250, `heap +${heap.toFixed(1)} MB`);
  assert.equal(status.total, TARGET, "the observer's total");
  assert.equal(store.getState().series.total, TARGET, "the series' total");
  assert.ok(status.held <= 20_000 && status.held > 0, `held ${status.held}`);
  // Bounded start: the summaries and the newest window, never the observer's whole projected state.
  assert.equal(log.head().completeness.state, "partial", "history before the window is said not loaded");
  assert.deepEqual(SERVER.snapshotsAt, [], "no /snapshot at all");
  // The stream resumes from the cursor: nothing before the window was fetched page by page.
  assert.ok(SERVER.requests.filter((r) => r.includes("/events?")).length < 40, "no eager paging of the whole history");

  // Scrub within the held window.
  const rand = seeded(17);
  const floor = log.floorTime();
  const edge = store.getState().liveAt;
  const inside = [];
  for (let i = 0; i < 120; i++) {
    const at = floor + rand() * (edge - floor);
    const a = performance.now();
    store.seek(at);
    const st = store.getState();
    st.log.sceneAt(st.playhead);
    inside.push(performance.now() - a);
  }
  // Scrub back past it: windows fetched on demand.
  const start = windows.start();
  const fetchedTimes = [];
  for (let i = 0; i < 12; i++) {
    const at = start + rand() * (floor - start - 1);
    const a = performance.now();
    store.seek(at);
    assert.ok(await until(() => !store.getState().windowLoading), "the window loads");
    const st = store.getState();
    st.log.sceneAt(st.playhead);
    fetchedTimes.push(performance.now() - a);
    assert.notEqual(st.log, log, "a window log is shown");
    assert.ok(st.log.floorTime() <= at, "the window holds the playhead");
  }
  t.diagnostic(`live scrub within the window: median ${median(inside).toFixed(1)} ms, p95 ${p95(inside).toFixed(1)} ms; past it (fetch): median ${median(fetchedTimes).toFixed(0)} ms, p95 ${p95(fetchedTimes).toFixed(0)} ms; windows ${JSON.stringify(windows.stats())}`);
  assert.ok(median(inside) <= 100, `within ${median(inside)}`);
  assert.ok(median(fetchedTimes) <= 500, `fetched ${median(fetchedTimes)}`);
  // Back to live: the store's own log, selection kept.
  store.select("cell:LOCAL-0001");
  store.followLive();
  assert.equal(store.getState().log, log);
  assert.equal(store.getState().selection, "cell:LOCAL-0001");
  source.stop();
  store.dispose();
});

test("D17 replay: windows on demand from the history's start; the same history gives the same scene at the same moment", async (t) => {
  const before = heapMb();
  const t0 = performance.now();
  const client = live.createObserverClient({ fetch: SERVER.fetch });
  const { store, windows } = await live.createReplay(client, { clock: manualClock() });
  assert.ok(await until(() => !store.getState().windowLoading));
  const s0 = store.getState();
  s0.log.sceneAt(s0.playhead);
  const firstRender = performance.now() - t0;
  const heap = heapMb() - before;
  t.diagnostic(`replay first render ${firstRender.toFixed(0)} ms; heap +${heap.toFixed(1)} MB; span ${JSON.stringify(windows.span())}`);
  assert.ok(firstRender <= 3000, `first render ${firstRender.toFixed(0)} ms`);
  assert.ok(heap <= 250, `heap +${heap.toFixed(1)} MB`);
  assert.equal(store.getState().playhead, windows.start(), "a replay starts at the history's first moment");
  assert.equal(store.getState().extent.start, windows.start(), "the extent is the whole history, not the window");

  const rand = seeded(23);
  const span = windows.span();
  const near = [];
  const far = [];
  const probes = [];
  for (let i = 0; i < 40; i++) {
    const hereT = store.getState().playhead;
    // Mostly small scrubs (within the window), sometimes a jump anywhere.
    const jump = i % 4 === 0;
    const at = jump ? span.start + rand() * (span.end - span.start) : Math.min(span.end, Math.max(span.start, hereT + (rand() - 0.5) * span.windowMs * 0.5));
    const a = performance.now();
    store.seek(at);
    const loading = store.getState().windowLoading;
    assert.ok(await until(() => !store.getState().windowLoading));
    const st = store.getState();
    const scene = st.log.sceneAt(st.playhead);
    (loading ? far : near).push(performance.now() - a);
    if (i % 5 === 0) probes.push({ at: st.playhead, cells: Object.fromEntries(Object.values(scene.cells).map((c) => [c.ticketId, [c.stage, c.station, c.visits.length]])) });
  }
  t.diagnostic(`replay scrub: no fetch median ${median(near).toFixed(1)} ms (n=${near.length}); fetch median ${far.length ? median(far).toFixed(0) : "-"} ms, p95 ${far.length ? p95(far).toFixed(0) : "-"} ms (n=${far.length})`);
  assert.ok(median(near) <= 100, `near ${median(near)}`);
  if (far.length) assert.ok(median(far) <= 500, `far ${median(far)}`);

  // Determinism: a fresh replay, scrubbed straight to each probe, draws the same scene there.
  const again = await live.createReplay(client, { clock: manualClock() });
  for (const p of probes) {
    again.store.seek(p.at);
    assert.ok(await until(() => !again.store.getState().windowLoading));
    const st = again.store.getState();
    const scene = st.log.sceneAt(st.playhead);
    assert.deepEqual(Object.fromEntries(Object.values(scene.cells).map((c) => [c.ticketId, [c.stage, c.station, c.visits.length]])), p.cells, `the same scene at ${p.at}`);
  }
  store.dispose();
  again.store.dispose();
});

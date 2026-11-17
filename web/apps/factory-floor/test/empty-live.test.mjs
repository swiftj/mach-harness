// A live Factory Floor on a project with no history at all (a fresh MACH project: no intake ledger, no
// cell, no archive). A real user's tab froze ("Page Unresponsive") the moment they held the moment at
// the live edge: the store asked the windowed history for a window that cannot exist, the refusal
// asked again at once, and the microtask loop never let the page paint. And the timeline strip's
// playhead swept left to right and jumped back at every heartbeat, because the extent's start was the
// last confirmed edge. These tests drive the store exactly as the page does, with an empty observer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";

const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { togglePlayback, nudge } = await import("../src/shell/keyboard.ts");
const { createSceneLog, provenance } = sim;

const WALL = Date.UTC(2026, 10, 17, 9, 0, 0);
/** More loads than any user action could justify: past it the store is looping, and the test says so instead of hanging. */
const LOAD_LIMIT = 50;

/** The observer of a project with nothing recorded: no series buckets, no history. */
const emptyClient = {
  session: async () => ({ generation: "g1" }),
  series: async () => ({ bucketMs: 60_000, buckets: [], toMs: WALL, total: 0, coarse: false }),
  history: async () => ({ events: [], more: false, nextFromOrder: null }),
  events: async () => ({ events: [], head: null }),
};

/** A turn of the event loop: a microtask loop that never ends never gets here. */
const macrotask = () => new Promise((resolve) => setImmediate(resolve));

async function emptyLiveFloor() {
  const clock = manualClock(0);
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  const history = live.createWindowedHistory({ client: emptyClient, definitions: live.LIVE_DEFINITIONS, source: "live" });
  await history.init();
  assert.equal(history.start(), null, "an empty project has no windowed history");
  let loads = 0;
  const windows = {
    start: () => history.start(),
    peek: (t) => history.peek(t),
    load(t) {
      loads += 1;
      if (loads > LOAD_LIMIT) throw new Error(`the store asked for a history window ${loads} times`);
      return history.load(t);
    },
  };
  const store = createSceneStore({ source: "live", log, clock, windows, wallClock: () => WALL + clock.now() });
  const off = store.subscribe(() => undefined);
  store.setConnection({ ...store.getState().connection, state: "live" });
  return { clock, store, off, loads: () => loads };
}

test("empty live Floor: holding the moment at the live edge returns, asks for no window and leaves the page free", async () => {
  const { clock, store, off, loads } = await emptyLiveFloor();
  clock.advance(10_000); // about ten seconds on the page, as the user was
  assert.equal(store.getState().following, true);
  const held = store.getState().playhead;
  // The transport's button at the live edge (and Space): hold this moment.
  togglePlayback(store);
  for (let i = 0; i < 5; i++) await macrotask();
  assert.ok(loads() <= 1, `asked for a history window ${loads()} times`);
  const s = store.getState();
  assert.equal(s.following, false, "held, not at the edge");
  assert.equal(s.playing, false);
  assert.equal(s.windowLoading, false, "nothing is loading: there is no history to load");
  assert.ok(Math.abs(s.playhead - (held - 1)) <= 1, "the playhead holds the moment shown");
  // Play from the hold, step back, nudge back: every frame moves the playhead, none loops or fetches.
  togglePlayback(store);
  clock.frames(30, 16);
  nudge(store, -10_000);
  store.stepPrevious();
  for (let i = 0; i < 5; i++) await macrotask();
  assert.ok(loads() <= 1, `asked for a history window ${loads()} times after playing and stepping back`);
  assert.equal(store.getState().windowLoading, false);
  store.followLive();
  assert.equal(store.getState().following, true);
  off();
  store.dispose();
});

test("empty live Floor: the extent's start stays where the page opened; heartbeats do not move it", async () => {
  const { clock, store, off } = await emptyLiveFloor();
  const start = store.getState().extent.start;
  assert.equal(start, WALL, "the extent starts at now, never at 1970");
  // The observer's heartbeat every 15 s confirms the live edge (its watermark, a little behind now).
  for (let beat = 1; beat <= 8; beat++) {
    clock.advance(15_000);
    store.setLiveEdge(WALL + beat * 15_000 - 2_000);
    assert.equal(store.getState().extent.start, start, `heartbeat ${beat} moved the extent's start`);
  }
  const s = store.getState();
  assert.ok(s.liveAt >= WALL + 120_000, "the live edge still runs with the clock");
  assert.equal(s.playhead, s.liveAt, "following: the playhead is now");
  off();
  store.dispose();
});

test("empty live Floor: following the edge with nothing moving does bounded work per second", async () => {
  const { clock, store, off, loads } = await emptyLiveFloor();
  let notified = 0;
  const count = store.subscribe(() => (notified += 1));
  const before = clock.framesRun;
  for (let s = 0; s < 60; s++) clock.advance(1000);
  // One wake-up a second for the clock label, never sixty frames a second.
  assert.ok(clock.framesRun - before <= 70, `${clock.framesRun - before} frames in 60 s`);
  assert.ok(notified <= 70, `${notified} store updates in 60 s`);
  assert.ok(clock.pending <= 1, `${clock.pending} wake-ups queued`);
  assert.equal(loads(), 0);
  count();
  off();
  store.dispose();
});

test("live Floor: a history window that cannot be loaded is not asked for again and again", async () => {
  // A history exists (its span is known) but its windows cannot be read: the observer refuses, or the
  // network is gone. Scrubbing back must not loop on the refusal.
  const clock = manualClock(0);
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  let loads = 0;
  const windows = {
    start: () => WALL - 3_600_000,
    peek: () => null,
    load() {
      loads += 1;
      if (loads > LOAD_LIMIT) throw new Error(`the store asked for a history window ${loads} times`);
      return Promise.reject(new Error("unavailable"));
    },
  };
  const store = createSceneStore({ source: "live", log, clock, windows, wallClock: () => WALL + clock.now() });
  const off = store.subscribe(() => undefined);
  store.seek(WALL - 1_800_000);
  assert.equal(store.getState().windowLoading, true, "asked for, while it loads");
  for (let i = 0; i < 5; i++) await macrotask();
  assert.equal(loads, 1, `asked ${loads} times for one moment`);
  assert.equal(store.getState().windowLoading, false, "a refusal is not shown as loading for ever");
  // Another moment asks afresh, once.
  store.seek(WALL - 900_000);
  for (let i = 0; i < 5; i++) await macrotask();
  assert.equal(loads, 2);
  off();
  store.dispose();
});

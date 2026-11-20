// A live Factory Floor on a project with no history at all (a fresh MACH project: no intake ledger, no
// cell, no archive). A real user's tab once froze here ("Page Unresponsive"): the store asked for a
// history window that could not exist, again and again. The Floor now shows only the present and reads
// no history windows at all; these tests drive the store and the Line's model exactly as the page
// does, with an empty observer, and hold that the page does bounded work and says something useful.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";

const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { lineModel, stationStats, feedOf } = await import("../src/line/model.ts");
const { historyIndexOf } = await import("../src/shell/history.ts");
const { createSceneLog, provenance } = sim;

const WALL = Date.UTC(2026, 10, 17, 9, 0, 0);

function emptyLiveFloor() {
  const clock = manualClock(0);
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  const store = createSceneStore({ source: "live", log, clock, wallClock: () => WALL + clock.now() });
  const off = store.subscribe(() => undefined);
  store.setConnection({ ...store.getState().connection, state: "live" });
  return { clock, store, off };
}

test("empty live Floor: the store has no history windows to ask for", () => {
  const { store, off } = emptyLiveFloor();
  assert.equal("windowLoading" in store.getState(), false);
  assert.equal("seek" in store, false, "nothing can move the store into a history it does not hold");
  off();
  store.dispose();
});

test("empty live Floor: the extent's start stays where the page opened; heartbeats do not move it", () => {
  const { clock, store, off } = emptyLiveFloor();
  const start = store.getState().extent.start;
  assert.equal(start, WALL, "the extent starts at now, never at 1970");
  // The observer's heartbeat every 15 s confirms the live edge (its watermark, a little behind now).
  for (let beat = 1; beat <= 8; beat++) {
    clock.advance(15_000);
    store.setLiveEdge(WALL + beat * 15_000 - 2_000);
    assert.equal(store.getState().extent.start, start, `heartbeat ${beat} moved the extent's start`);
  }
  assert.ok(store.getState().now >= WALL + 120_000, "now still runs with the clock");
  off();
  store.dispose();
});

test("empty live Floor: with nothing moving the store does bounded work per second", () => {
  const { clock, store, off } = emptyLiveFloor();
  let notified = 0;
  const count = store.subscribe(() => (notified += 1));
  const before = clock.framesRun;
  for (let s = 0; s < 60; s++) clock.advance(1000);
  // One wake-up a second for the clock label, never sixty frames a second.
  assert.ok(clock.framesRun - before <= 70, `${clock.framesRun - before} frames in 60 s`);
  assert.ok(notified <= 70, `${notified} store updates in 60 s`);
  assert.ok(clock.pending <= 1, `${clock.pending} wake-ups queued`);
  count();
  off();
  store.dispose();
});

test("empty live Floor: the Line has no rows, nothing needs a person, and the feed is empty (the view says so)", () => {
  const { clock, store, off } = emptyLiveFloor();
  clock.advance(5_000);
  const s = store.getState();
  const scene = s.log.sceneAt(s.now);
  const model = lineModel(scene, s.now);
  assert.deepEqual(model.rows, []);
  assert.deepEqual(model.needs, []);
  assert.equal(model.landedHidden, 0);
  const stats = stationStats(scene, model.rows);
  assert.equal(stats.length, 7, "every station still has its heading");
  for (const st of stats) {
    assert.equal(st.typicalMs, null, "no typical time is made up");
    assert.equal(st.atWork, 0);
  }
  assert.deepEqual(feedOf(historyIndexOf(s.log).moments, s.now), []);
  off();
  store.dispose();
});

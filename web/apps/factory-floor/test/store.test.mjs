// The one store, driven by a manual clock: the simulation running on its own, selection, focus,
// hover, workspaces, the held Floor, and the development hook. There is no playback: no play, pause,
// seek, step, speed or return-to-live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { createSceneStore, installMachSimHook, PLAYBACK_BASE_RATE } = await import("../src/scene/store.ts");
const { manualClock, switchableClock } = await import("../src/scene/clock.ts");
const { SCENARIO } = sim;

const make = (extra = {}) => {
  const clock = manualClock();
  const store = createSceneStore({ fixture: SCENARIO, clock, ...extra });
  return { clock, store };
};

test("the simulation runs on its own while watched, at its rate, and holds at its end", () => {
  const { clock, store } = make();
  assert.equal(store.getState().now, 0);
  clock.frames(5, 100);
  assert.equal(store.getState().now, 0, "nobody watches: no frame loop, nothing moves");
  const off = store.subscribe(() => {});
  clock.frames(1, 0); // the first frame only sets the reference time
  clock.frames(10, 100);
  assert.equal(store.getState().now, 1000 * PLAYBACK_BASE_RATE);
  for (let i = 0; i < 4000; i++) clock.frames(1, 250);
  assert.equal(store.getState().now, SCENARIO.duration, "held at the end");
  assert.equal(clock.pendingFrames, 0, "and asks for no more frames");
  off();
});

test("the store has no playback controls", () => {
  const { store } = make();
  for (const name of ["play", "pause", "toggle", "seek", "seekToSeq", "seekToEvent", "seekToChapter", "stepNext", "stepPrevious", "setSpeed", "followLive", "setTimelineView", "setHighlightInterval"]) {
    assert.equal(name in store, false, `${name} is gone`);
  }
  for (const key of ["playhead", "liveAt", "following", "playing", "speed", "timeline", "interval", "series", "windowLoading"]) {
    assert.equal(key in store.getState(), false, `${key} is gone from the state`);
  }
});

test("selection asks the camera to focus; focus requests repeat; a selection without focus leaves the camera", () => {
  const { store } = make();
  store.select("cell:LOCAL-031");
  const first = store.getState().focus;
  assert.equal(first.target, "cell:LOCAL-031");
  assert.equal(store.getState().follow, false, "framing what the person picked takes the camera off follow");
  store.focusOn("cell:LOCAL-031");
  assert.notEqual(store.getState().focus.nonce, first.nonce);
  store.select("cell:LOCAL-033", { focus: false });
  assert.equal(store.getState().focus.target, "cell:LOCAL-031");
  store.setFollow(true);
  store.focusOn("overview", "follow");
  assert.equal(store.getState().follow, true, "the follow camera's own requests keep follow on");
});

test("hover highlights the dependency set; Theater Mode is one state", () => {
  const { store } = make({ at: SCENARIO.duration });
  let notified = 0;
  const off = store.subscribe(() => notified++);
  store.hover("slice:SLICE-025");
  assert.ok(store.getState().highlighted.includes("dependency:SLICE-025->SLICE-024"));
  assert.ok(store.getState().highlighted.includes("slice:SLICE-021"));
  store.hover(null);
  assert.deepEqual(store.getState().highlighted, []);
  store.setWorkspace("floor");
  store.setTheater(true);
  assert.equal(store.getState().theater, true);
  const before = store.getState();
  store.setTheater(true);
  assert.equal(store.getState(), before, "no change, no new state");
  assert.ok(notified >= 4);
  off();
});

test("workspace: the Line by default; switching keeps the selection; Theater Mode is the Floor's", () => {
  const { store } = make();
  assert.equal(store.getState().workspace, "line");
  store.select("cell:LOCAL-031", { focus: false });
  store.setTheater(true);
  assert.equal(store.getState().theater, false, "Theater Mode cannot start on the Line");
  store.setWorkspace("floor");
  store.setTheater(true);
  assert.equal(store.getState().theater, true);
  store.setWorkspace("analytics");
  assert.equal(store.getState().theater, false, "it ends on leaving the Floor");
  assert.equal(store.getState().selection, "cell:LOCAL-031");
  store.setWorkspace("timeline");
  assert.equal(store.getState().workspace, "analytics", "an unknown workspace is ignored");
});

test("showOnLine selects without moving the camera; showOnFloor frames the selection", async () => {
  const { showOnLine, showOnFloor } = await import("../src/scene/store.ts");
  const { store } = make();
  store.setWorkspace("analytics");
  showOnLine(store, "cell:LOCAL-032");
  assert.equal(store.getState().workspace, "line");
  assert.equal(store.getState().selection, "cell:LOCAL-032");
  assert.equal(store.getState().focus, null, "the Line has no camera to move");
  showOnFloor(store);
  assert.equal(store.getState().workspace, "floor");
  assert.equal("view" in store.getState(), false, "the Floor has one drawing: no Atlas/Blueprint choice");
  assert.equal("setView" in store, false);
  assert.equal(store.getState().focus.target, "cell:LOCAL-032");
});

test("window.__machSim (development and capture builds): the simulation's moment and the manual clock", () => {
  const base = manualClock();
  const clock = switchableClock(base);
  const store = createSceneStore({ fixture: SCENARIO, clock });
  const target = {};
  const off = installMachSimHook(store, target, clock);
  const hook = target.__machSim;
  assert.equal(hook.version, 2);
  assert.equal(hook.duration, SCENARIO.duration);
  hook.seek(1_000_000);
  assert.equal(hook.state().now, 1_000_000);
  hook.seek(500_000);
  assert.equal(store.getState().now, 500_000, "the hook can set the moment either way; the interface cannot");
  for (const name of ["play", "pause", "setSpeed", "followLive", "step", "seekToChapter"]) assert.equal(name in hook, false, `${name} is not offered`);
  hook.useManualClock();
  const watch = store.subscribe(() => {});
  hook.advance(1000, 100);
  assert.equal(hook.state().now, 500_000 + 1000 * PLAYBACK_BASE_RATE);
  hook.setWorkspace("floor");
  hook.select("cell:LOCAL-031");
  assert.deepEqual([hook.state().workspace, hook.state().selection], ["floor", "cell:LOCAL-031"]);
  watch();
  off();
  assert.equal("__machSim" in target, false);
  assert.throws(() => installMachSimHook(createSceneStore({ source: "live", log: sim.createSceneLog({ definitions: SCENARIO.definitions, provenance: sim.provenance("live") }), clock: base }), {}), /simulation only/);
});

test("heldStore: held, a hidden workspace sees nothing change and is told nothing; released, it catches up once", async () => {
  const { heldStore } = await import("../src/scene/store.ts");
  const { clock, store } = make({ workspace: "floor" });
  const held = heldStore(store);
  let told = 0;
  const off = held.subscribe(() => told++);
  held.hold(true);
  const frozen = held.getState();
  clock.frames(1, 0);
  clock.frames(10, 100);
  store.select("cell:LOCAL-031");
  assert.equal(told, 0);
  assert.equal(held.getState(), frozen);
  assert.notEqual(store.getState().now, frozen.now, "the store itself goes on");
  held.select("cell:LOCAL-033", { focus: false });
  assert.equal(store.getState().selection, "cell:LOCAL-033", "actions go straight to the store");
  held.hold(false);
  assert.equal(told, 1);
  assert.equal(held.getState(), store.getState());
  store.hover("cell:LOCAL-031");
  assert.equal(told, 2, "released, it follows every change");
  off();
});

test("A3: heldStore holds itself when the workspace leaves the Floor; the switch never reaches it", async () => {
  const { heldStore, showOnFloor, showOnLine } = await import("../src/scene/store.ts");
  const { store } = make({ workspace: "floor" });
  const held = heldStore(store);
  const seen = [];
  const off = held.subscribe(() => seen.push(held.getState()));
  store.select("cell:LOCAL-031", { focus: false });
  assert.equal(seen.length, 1, "on the Floor it follows every change");
  const before = held.getState();
  showOnLine(store);
  assert.equal(held.held(), true);
  assert.equal(seen.length, 1);
  assert.equal(held.getState(), before);
  assert.equal(held.getState().workspace, "floor", "the hidden Floor still sees itself as it was");
  store.select("cell:LOCAL-033", { focus: false });
  assert.equal(seen.length, 1, "nothing while the Line is up");
  showOnFloor(store);
  assert.equal(held.held(), false);
  assert.equal(held.getState(), store.getState());
  off();
});

test("A3: a heldStore made while the Line is up starts held", async () => {
  const { heldStore } = await import("../src/scene/store.ts");
  const { store } = make();
  const held = heldStore(store);
  assert.equal(held.held(), true);
  held.hold(false);
  assert.equal(held.held(), true, "releasing by hand does not show the Floor while it is not up");
});

test("A4: a store view hidden by hand keeps its state and tells nothing; shown again, it catches up once", async () => {
  const { storeView } = await import("../src/scene/view.ts");
  const { store } = make();
  const view = storeView(store);
  let told = 0;
  const off = view.subscribe(() => told++);
  store.select("cell:LOCAL-031", { focus: false });
  assert.equal(told, 1, "shown: every change");
  view.setShown(false);
  const frozen = view.getState();
  store.select("cell:LOCAL-032", { focus: false });
  store.select("cell:LOCAL-033", { focus: false });
  assert.equal(told, 1);
  assert.equal(view.getState(), frozen);
  view.select("cell:LOCAL-034", { focus: false });
  assert.equal(store.getState().selection, "cell:LOCAL-034", "actions go straight to the store");
  view.setShown(true);
  assert.equal(told, 2, "caught up once");
  assert.equal(view.getState(), store.getState());
  off();
});

// The one store, driven by a manual clock: playback, live-follow, stepping, selection, focus, hover, the hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { createSceneStore, installMachSimHook, PLAYBACK_BASE_RATE, SPEEDS } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { SCENARIO, nextEventTime } = sim;

const make = (extra = {}) => {
  const clock = manualClock();
  const store = createSceneStore({ fixture: SCENARIO, clock, ...extra });
  return { clock, store };
};

test("play advances factory time by wall time x rate x speed; pause stops it", () => {
  const { clock, store } = make();
  store.play();
  clock.frames(1, 0); // the first frame only sets the reference time
  clock.frames(10, 100);
  assert.equal(store.getState().playhead, 1000 * PLAYBACK_BASE_RATE);
  store.setSpeed(4);
  clock.frames(5, 100);
  assert.equal(store.getState().playhead, 1000 * PLAYBACK_BASE_RATE + 500 * PLAYBACK_BASE_RATE * 4);
  store.pause();
  const held = store.getState().playhead;
  clock.frames(10, 100);
  assert.equal(store.getState().playhead, held);
  assert.equal(clock.pending, 0);
});

test("speeds are 0.5x to 16x; anything else is ignored", () => {
  const { store } = make();
  assert.deepEqual([...SPEEDS], [0.5, 1, 2, 4, 8, 16]);
  store.setSpeed(32);
  assert.equal(store.getState().speed, 1);
  store.setSpeed(0.5);
  assert.equal(store.getState().speed, 0.5);
});

test("live-follow pins the playhead to the simulated now; seeking back replays; followLive returns", () => {
  const { clock, store } = make();
  store.play();
  clock.frames(1, 0);
  clock.frames(20, 100);
  assert.equal(store.getState().following, true);
  assert.equal(store.getState().playhead, store.getState().liveAt);
  store.seek(5000);
  let s = store.getState();
  assert.equal(s.following, false);
  assert.equal(s.playhead, 5000);
  clock.frames(10, 100);
  s = store.getState();
  assert.equal(s.playhead, 5000 + 1000 * PLAYBACK_BASE_RATE, "the replay plays on");
  assert.ok(s.liveAt > s.playhead, "the factory keeps running ahead");
  store.followLive();
  s = store.getState();
  assert.equal(s.following, true);
  assert.equal(s.playhead, s.liveAt);
});

test("stepping moves event by event and pauses", () => {
  const { store } = make({ at: 10 * 60000 });
  store.play();
  store.stepNext();
  const s = store.getState();
  assert.equal(s.playing, false);
  assert.equal(s.playhead, nextEventTime(SCENARIO, 10 * 60000));
  const after = s.cursor;
  store.stepPrevious();
  assert.ok(store.getState().cursor < after);
  store.stepNext();
  assert.equal(store.getState().cursor, after);
});

test("stepping works the same under reduced motion", () => {
  const { store } = make({ reducedMotion: true, at: 0 });
  assert.equal(store.getState().reducedMotion, true);
  for (let i = 0; i < 5; i++) store.stepNext();
  assert.equal(store.getState().cursor, SCENARIO.events.filter((e) => e.t <= store.getState().playhead).length);
  assert.ok(store.getState().cursor >= 5);
});

test("the run ends: playback stops at the duration, and play again replays from the start", () => {
  const { clock, store } = make({ at: SCENARIO.duration - 1000, speed: 16 });
  store.play();
  clock.frames(1, 0);
  clock.frames(5, 100);
  assert.equal(store.getState().playhead, SCENARIO.duration);
  assert.equal(store.getState().playing, false);
  store.play();
  assert.equal(store.getState().playhead, 0);
  assert.equal(store.getState().playing, true);
  store.dispose();
});

test("chapters and seq seek; selection asks the camera to focus; focus requests repeat", () => {
  const { store } = make();
  store.seekToChapter("human-gate");
  const chapter = SCENARIO.chapters.find((c) => c.id === "human-gate");
  assert.equal(store.getState().playhead, chapter.t);
  assert.equal(store.getState().focus.target, chapter.focus);
  assert.equal(store.getState().focus.reason, "chapter");
  store.seekToSeq(100);
  assert.equal(store.getState().playhead, SCENARIO.events[99].t);
  store.select("cell:LOCAL-031");
  const first = store.getState().focus;
  assert.equal(first.target, "cell:LOCAL-031");
  store.focusOn("cell:LOCAL-031");
  assert.notEqual(store.getState().focus.nonce, first.nonce);
  store.select("cell:LOCAL-033", { focus: false });
  assert.equal(store.getState().focus.target, "cell:LOCAL-031");
});

test("hover highlights the dependency set; view and theater are one state each", () => {
  const { store } = make({ at: SCENARIO.duration });
  let notified = 0;
  const off = store.subscribe(() => notified++);
  store.hover("slice:SLICE-025");
  assert.ok(store.getState().highlighted.includes("dependency:SLICE-025->SLICE-024"));
  assert.ok(store.getState().highlighted.includes("slice:SLICE-021"));
  store.hover(null);
  assert.deepEqual(store.getState().highlighted, []);
  store.setView("blueprint");
  store.setTheater(true);
  assert.equal(store.getState().view, "blueprint");
  assert.equal(store.getState().theater, true);
  const before = store.getState();
  store.setView("blueprint");
  assert.equal(store.getState(), before, "no change, no new state");
  assert.ok(notified >= 4);
  off();
});

test("window.__machSim: seeking and reading (version 1 members)", () => {
  const { store } = make();
  const target = {};
  const remove = installMachSimHook(store, target);
  const hook = target.__machSim;
  assert.equal(hook.version, 1);
  assert.equal(hook.eventCount, SCENARIO.events.length);
  hook.seek(12 * 60000);
  assert.equal(hook.state().playhead, 12 * 60000);
  hook.seekToChapter("blocker");
  assert.equal(hook.state().playhead, SCENARIO.chapters.find((c) => c.id === "blocker").t);
  const cursor = hook.state().cursor;
  hook.step(3);
  assert.ok(hook.state().cursor > cursor);
  hook.step(-3);
  assert.equal(hook.state().cursor, cursor);
  remove();
  assert.equal(target.__machSim, undefined);
});

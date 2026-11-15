// Pass 2: the capture hook's driving controls and manual clock, one camera-follow flag, the
// supervisor and scheduler as actors, and known (never predicted) timing for work in flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { createSceneStore, installMachSimHook, cameraFollows, PLAYBACK_BASE_RATE } = await import("../src/scene/store.ts");
const { manualClock, switchableClock } = await import("../src/scene/clock.ts");
const { SCENARIO, sceneAt, finalScene, entityAt, eventsFor, latestEventFor, actorOfEvent, actorOf, allAgents, agentTimingAt, toolCallTimingAt, visitTimingAt, ACTOR_KINDS } = sim;

const withHook = () => {
  const base = manualClock(1000);
  const clock = switchableClock(base);
  const store = createSceneStore({ fixture: SCENARIO, clock });
  const target = {};
  installMachSimHook(store, target, clock);
  return { base, clock, store, hook: target.__machSim };
};

// ---------------------------------------------------------------- (1) the capture hook

test("hook: the capture script can select, focus, switch mode and theater, set speed, play and pause", () => {
  const { hook } = withHook();
  hook.select("cell:LOCAL-031");
  assert.equal(hook.state().selection, "cell:LOCAL-031");
  hook.focus("gate:LOCAL-032/human-approval");
  assert.equal(hook.state().focus, "gate:LOCAL-032/human-approval");
  hook.focus("overview");
  assert.equal(hook.state().focus, "overview");
  hook.setMode("blueprint");
  assert.equal(hook.state().view, "blueprint");
  hook.setTheater(true);
  assert.equal(hook.state().theater, true);
  hook.setSpeed(8);
  assert.equal(hook.state().speed, 8);
  hook.play();
  assert.equal(hook.state().playing, true);
  hook.pause();
  assert.equal(hook.state().playing, false);
  hook.select(null);
  assert.equal(hook.state().selection, null);
});

test("hook: the manual clock advances factory time by exact milliseconds, frame by frame", () => {
  const { hook, base } = withHook();
  assert.equal(hook.clockMode(), "live");
  hook.useManualClock();
  assert.equal(hook.clockMode(), "manual");
  assert.equal(hook.state().clock, "manual");
  hook.seek(10 * 60000);
  hook.setSpeed(2);
  hook.play();
  hook.advance(0); // the first frame sets the reference time
  base.frames(30, 100); // browser frames are ignored while manual
  assert.equal(hook.state().playhead, 10 * 60000);
  hook.advance(1000);
  assert.equal(hook.state().playhead, 10 * 60000 + 1000 * PLAYBACK_BASE_RATE * 2);
  // Thirty frames of exactly 40 ms each: 1.2 s of wall time.
  for (let i = 0; i < 30; i++) hook.advance(40);
  assert.equal(hook.state().playhead, 10 * 60000 + 2200 * PLAYBACK_BASE_RATE * 2);
  // The same steps from the same start give the same frames.
  const again = withHook().hook;
  again.useManualClock();
  again.seek(10 * 60000);
  again.setSpeed(2);
  again.play();
  again.advance(0);
  again.advance(1000);
  for (let i = 0; i < 30; i++) again.advance(40);
  assert.equal(again.state().playhead, hook.state().playhead);
  assert.equal(again.state().cursor, hook.state().cursor);
});

test("hook: back to the live clock, time continues without a leap", () => {
  const { hook, base } = withHook();
  hook.useManualClock();
  hook.play();
  hook.advance(500);
  const at = hook.state().playhead;
  hook.useLiveClock();
  base.frames(1, 100);
  assert.equal(hook.state().playhead, at + 100 * PLAYBACK_BASE_RATE);
});

test("hook: without a switchable clock the manual controls refuse, and version 1 is unchanged", () => {
  const store = createSceneStore({ fixture: SCENARIO, clock: manualClock() });
  const target = {};
  installMachSimHook(store, target);
  const hook = target.__machSim;
  assert.equal(hook.version, 1);
  assert.equal(hook.clockMode(), "fixed");
  assert.throws(() => hook.useManualClock());
  assert.throws(() => hook.advance(100));
  for (const name of ["seek", "seekToSeq", "seekToChapter", "step", "play", "pause", "setSpeed", "state"]) assert.equal(typeof hook[name], "function", name);
  const live = switchableClock(manualClock());
  assert.throws(() => live.advance(10), /manual/);
});

// ---------------------------------------------------------------- (2) camera follow

test("follow: on by default, off when the person pans or zooms, back on with return-to-live", () => {
  const { store } = withHook();
  assert.equal(store.getState().follow, true);
  assert.equal(cameraFollows(store.getState()), true);
  store.setFollow(false); // what a view calls on pan or zoom
  assert.equal(cameraFollows(store.getState()), false);
  store.followLive();
  assert.equal(store.getState().follow, true);
  assert.equal(cameraFollows(store.getState()), true);
});

test("follow: a camera request the person made releases it; the follow camera's own requests do not", () => {
  const { store } = withHook();
  store.focusOn("cell:LOCAL-031", "follow");
  assert.equal(store.getState().follow, true);
  store.select("cell:LOCAL-033");
  assert.equal(store.getState().follow, false);
  store.setFollow(true);
  store.select("cell:LOCAL-031", { focus: false });
  assert.equal(store.getState().follow, true, "selecting without framing leaves follow alone");
  store.seekToChapter("blocker");
  assert.equal(store.getState().follow, false);
});

test("follow: the camera follows only live; Theater Mode does not force live or change follow", () => {
  const { store } = withHook();
  store.seek(SCENARIO.duration);
  store.seek(5 * 60000); // replay
  assert.equal(store.getState().follow, true);
  assert.equal(cameraFollows(store.getState()), false, "replaying: nothing live to follow");
  store.setTheater(true);
  assert.equal(store.getState().following, false);
  assert.equal(store.getState().playhead, 5 * 60000);
  assert.equal(store.getState().follow, true);
  store.setFollow(false);
  store.setTheater(false);
  assert.equal(store.getState().follow, false);
});

// ---------------------------------------------------------------- (3) the supervisor and the scheduler

test("actors: the supervisor and the scheduler have stable refs, state, and the events behind them", () => {
  const end = finalScene(SCENARIO);
  const supervisor = entityAt(end, "actor:supervisor");
  const scheduler = entityAt(end, "actor:scheduler");
  assert.equal(supervisor.kind, "actor");
  assert.equal(scheduler.value.id, "scheduler");
  const bySupervisor = eventsFor(SCENARIO, "actor:supervisor");
  const byScheduler = eventsFor(SCENARIO, "actor:scheduler");
  assert.equal(supervisor.value.acts, bySupervisor.length);
  assert.equal(scheduler.value.acts, byScheduler.length);
  assert.equal(supervisor.value.lastSeq, bySupervisor[bySupervisor.length - 1].seq);
  for (const kind of ["scheduling.decided", "work.claimed", "execution.started", "station.observed", "execution.completed"]) assert.ok(bySupervisor.some((e) => e.type === kind), kind);
  for (const kind of ["dependency.resolved", "dependency.blocked", "work.scheduled", "slice.integrated", "human.required"]) assert.ok(byScheduler.some((e) => e.type === kind), kind);
  assert.equal(actorOfEvent(SCENARIO, bySupervisor[0].seq), "actor:supervisor");
  // At the start, neither has acted yet.
  assert.equal(entityAt(sceneAt(SCENARIO, 0), "actor:scheduler").value.acts, 0);
  assert.equal(latestEventFor(SCENARIO, "actor:scheduler", 60000).type, "dependency.blocked");
});

test("actors: attribution is truthful to the fixture", () => {
  for (const event of SCENARIO.events) {
    const actor = actorOf(event);
    if (!actor) continue;
    // Both act inside the supervisor's tick here, so every event they wrote carries source supervisor.
    assert.equal(event.source, "supervisor", `${event.type} seq ${event.seq}`);
    assert.ok(ACTOR_KINDS[actor].includes(event.type) || event.type === "human.required");
  }
  // Intake's own kinds, the engineer's commands and the stations' facts belong to no actor.
  for (const kind of ["wave.discovered", "slice.materialized", "factory.activated", "human.approval_recorded", "agent.started", "review.decided"]) {
    assert.equal(actorOf(SCENARIO.events.find((e) => e.type === kind)), null, kind);
  }
});

// ---------------------------------------------------------------- (4) known timing, nothing predictive

test("timing: an agent at work shows only what is known at t; a finished one, its whole span", () => {
  const t = 15 * 60000;
  const scene = sceneAt(SCENARIO, t);
  const running = allAgents(scene).find((a) => a.status === "running");
  const now = agentTimingAt(running, t);
  assert.deepEqual(Object.keys(now).sort(), ["elapsed", "finished", "finishedAt", "started", "startedAt"], "no fraction, no expected length");
  assert.deepEqual(now, { started: true, startedAt: running.startedAt, elapsed: t - running.startedAt, finishedAt: null, finished: false });
  // The same agent from the final scene, asked about time t, still reveals nothing about its end.
  const later = allAgents(finalScene(SCENARIO)).find((a) => a.id === running.id);
  assert.ok(later.finishedAt === null || later.finishedAt > t);
  assert.deepEqual(agentTimingAt(later, t), now);
  if (later.finishedAt !== null) {
    const done = agentTimingAt(later, later.finishedAt + 60000);
    assert.equal(done.finished, true);
    assert.equal(done.elapsed, later.finishedAt - later.startedAt);
  }
  assert.deepEqual(agentTimingAt(later, later.startedAt - 1), { started: false, startedAt: later.startedAt, elapsed: 0, finishedAt: null, finished: false });
});

test("timing: tool calls and station visits the same way", () => {
  const t = 15 * 60000;
  const scene = sceneAt(SCENARIO, t);
  const agent = allAgents(scene).find((a) => a.toolCalls.length > 1);
  const call = agent.toolCalls[0];
  const known = toolCallTimingAt(call, t);
  assert.equal(known.finished, true);
  assert.equal(known.elapsed, call.finishedAt - call.startedAt);
  const visit = scene.cells["LOCAL-031"].visits.find((v) => v.leftAt === null);
  assert.ok(visit, "LOCAL-031 is at a station");
  assert.deepEqual(visitTimingAt(visit, t), { started: true, startedAt: visit.enteredAt, elapsed: t - visit.enteredAt, finishedAt: null, finished: false });
});

// M6.2, the follow-ups the three view owners reported after connecting the views to live execution:
// one meaning per scene field whatever the source, facts the views had to infer now carried by the
// scene, stable bays, a store-level time scale, incremental history folds, and the observer client in
// the documented shapes. Over the v3 fixtures (test/fixtures/v3.mjs) and the in-memory observer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { beltRun, ev, finalize } from "./fixtures/v3.mjs";
import { fakeObserver, fakeTimers, settle } from "./fixtures/observer.mjs";

const { createSceneStore, timeScaleOf, PLAYBACK_BASE_RATE } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { DISCONNECTED_AFTER } = await import("../src/scene/connection.ts");
const {
  createSceneLog,
  provenance,
  SCENARIO,
  finalScene,
  activityOf,
  entityAt,
  stableEntityAt,
  ENTITY_KINDS,
  bayOrder,
  capacityWaits,
  capacityWaitOf,
  gateRefusals,
  cellHome,
  costCompletenessOf,
  isLateEntry,
  moments,
  createLogFold,
} = sim;
const DEFS = live.LIVE_DEFINITIONS;
const logOf = (events, extra = {}) => {
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live"), ...extra });
  log.ingest(events);
  return log;
};
const RUN = beltRun();
const EVENTS = finalize(RUN.events);
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const unpos = (e) => {
  const copy = { ...e };
  delete copy.pos;
  return copy;
};

// ---------------------------------------------------------------- 1. visit rounds

test("1. a revise visit belongs to the round it starts, in the simulation and in the lifecycle log alike", () => {
  // Live: the lifecycle log records the revise visit under the round it starts.
  const cell = logOf(EVENTS).head().cells["LOCAL-031"];
  const revises = cell.visits.filter((v) => v.action === "revise");
  assert.deepEqual(revises.map((v) => v.round), [2, 3]);
  // The simulation, converted where it enters the scene: LOCAL-031 revises after verification round 1.
  const simCell = finalScene(SCENARIO).cells["LOCAL-031"];
  const simRevise = simCell.visits.filter((v) => v.action === "revise");
  assert.ok(simRevise.length >= 1);
  for (const v of simRevise) {
    const next = simCell.visits[simCell.visits.indexOf(v) + 1];
    assert.equal(v.round, next.round, "the revise visit and the verification after it share their round");
    assert.equal(v.round, 2);
  }
  // Every visit before the first revision is round 1.
  const first = simCell.visits.indexOf(simRevise[0]);
  assert.ok(simCell.visits.slice(0, first).every((v) => v.round === 1));
});

// ---------------------------------------------------------------- 2. waves merge; bays never move

const waveEvent = (wave, slices, t, seq) => ev("wave.discovered", { stream: "intake-log", key: "i:0badc0de", seq, t, precision: "s", ids: { wave_id: wave }, entities: [`wave:${wave}`], data: { slices, approval: { approved_at: null, by_role: "person" } } });
const sliceEvent = (wave, slice, ticket, t, seq) => ev("slice.materialized", { stream: "intake-log", key: "i:0badc0de", seq, t, precision: "s", ids: { wave_id: wave, slice_id: slice, ticket_id: ticket }, entities: [`wave:${wave}`, `slice:${slice}`, `cell:${ticket}`], data: { digest: "d", adopted: false, dependencies: [], reissued: null } });

test("2. a repeated wave.discovered merges into the wave's slices (union, order of first sight)", () => {
  const log = logOf(finalize([waveEvent("WAVE-1", ["S1", "S2"], T0, 1), waveEvent("WAVE-1", ["S3", "S1"], T0 + 5000, 2)]));
  const wave = log.head().waves["WAVE-1"];
  assert.deepEqual(wave.sliceIds, ["S1", "S2", "S3"]);
  assert.equal(wave.discoveredAt, T0, "it keeps the moment it was first seen");
});

test("2. bays are ordered by their first event and never move, even when an older wave arrives late", () => {
  const a = waveEvent("WAVE-A", ["S1"], T0, 1);
  const b = waveEvent("WAVE-B", ["S2", "S3"], T0 + 10_000, 2);
  // Delivered together: by the order of their first event.
  const together = logOf(finalize([b, a]));
  assert.deepEqual(bayOrder(together).slots.map((s) => s.sliceId), ["S1", "S2", "S3"]);
  assert.deepEqual(bayOrder(together).waveIds, ["WAVE-A", "WAVE-B"]);
  // WAVE-B first, WAVE-A late: B's bays keep their indices, A's slice comes after.
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
  log.ingest(finalize([b]));
  const before = bayOrder(log);
  assert.deepEqual(before.slots.map((s) => s.sliceId), ["S2", "S3"]);
  log.ingest(finalize([a], 10));
  const after = bayOrder(log);
  assert.deepEqual(after.slots.map((s) => s.sliceId), ["S2", "S3", "S1"], "an assigned bay index never changes");
  assert.deepEqual(after.waveIds, ["WAVE-B", "WAVE-A"]);
  assert.equal(bayOrder(log), after, "the same object while nothing changes");
  // A slice's cell opens: the bay learns its ticket and keeps its index.
  log.ingest(finalize([sliceEvent("WAVE-B", "S3", "LOCAL-9", T0 + 20_000, 3)], 20));
  assert.deepEqual(bayOrder(log).slots[1], { sliceId: "S3", ticketId: "LOCAL-9" });
});

test("2. a cell seen before its slice keeps its bay when the slice becomes known", () => {
  const stray = ev("station.entered", { stream: "cell-lifecycle", key: "c:LOCAL-7:aa", seq: 1, t: T0, ids: { ticket_id: "LOCAL-7", cell_instance: "aa", visit_id: "LOCAL-7/build#1", station: "build", round: 1 }, entities: ["cell:LOCAL-7"], data: { station: "build", stage: "building", action: "build", resumed: false, unclosed_visit: null, head: null, counts: {} } });
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
  log.ingest(finalize([waveEvent("WAVE-A", ["S1"], T0 - 5000, 1), stray]));
  assert.deepEqual(bayOrder(log).slots.map((s) => s.sliceId), ["S1", "cell:LOCAL-7"]);
  log.ingest(finalize([sliceEvent("WAVE-A", "S9", "LOCAL-7", T0 + 1000, 2)], 10));
  assert.deepEqual(bayOrder(log).slots, [{ sliceId: "S1", ticketId: "S1" }, { sliceId: "S9", ticketId: "LOCAL-7" }]);
});

// ---------------------------------------------------------------- 3. approved, not merged

test("3. an approved cell not merged yet is known: review completed, merge next, who merges not recorded", () => {
  const scene = logOf(EVENTS).head();
  const a = activityOf(scene, "cell:LOCAL-031");
  assert.equal(scene.cells["LOCAL-031"].stage, "approved");
  assert.equal(a.state, "completed");
  assert.deepEqual(a.awaiting, { step: "merge", label: "Approved, not merged yet", by: null, basis: null });
  // pr-open: the same care.
  const pr = ev("station.exited", { stream: "cell-lifecycle", key: "c:LOCAL-031:3f2a9c1e", seq: 999, t: RUN.end + 10_000, ids: { ticket_id: "LOCAL-031", cell_instance: "3f2a9c1e", visit_id: "LOCAL-031/merge#1", station: "merge" }, entities: ["cell:LOCAL-031"], data: { station: "merge", outcome: "pr-open", stage: "pr-open", duration_ms: 10, closed_by: null, head: null, counts: {} } });
  const withPr = logOf(finalize([...RUN.events, pr])).head();
  const p = activityOf(withPr, "cell:LOCAL-031");
  assert.equal(p.state, "completed");
  assert.equal(p.awaiting.label, "Pull request open, not merged yet");
  // Where an event says a person must merge (the execution stopped at this stage waiting for one), say so.
  const stoppedHere = RUN.events.map((e) => (e.type === "execution.completed" ? { ...e, data: { ...e.data, stage: "approved" } } : e));
  const waiting = activityOf(logOf(finalize(stoppedHere)).head(), "cell:LOCAL-031");
  assert.equal(waiting.state, "waiting-person");
  assert.equal(waiting.awaiting.by, "person");
});

// ---------------------------------------------------------------- 4. verification targets listed

test("4. the verification round carries the received list of targets, with its authority, so 'expected' is a fact", () => {
  const log = logOf(EVENTS);
  const entered = log.entries().find((e) => e.event.type === "station.entered" && e.event.data.station === "verify");
  const listed = log.entries().find((e) => e.event.type === "verify.targets_listed");
  const before = log.sceneAtCursor(log.entries().indexOf(listed)).cells["LOCAL-031"].verifications[0];
  assert.ok(log.entries().indexOf(entered) < log.entries().indexOf(listed));
  assert.equal(before.listed, null, "nothing is expected before a list is received");
  assert.equal(before.checks.length, 0);
  const after = log.sceneAt(listed.t).cells["LOCAL-031"].verifications[0];
  assert.deepEqual(after.listed, { eventId: listed.id, authority: "reconstructed", count: 2, late: false });
  assert.equal(after.checks.filter((c) => c.result === "pending").length, 2);
  // The simulation's verification.started lists them too, as simulated.
  const v = finalScene(SCENARIO).cells["LOCAL-031"].verifications[0];
  assert.equal(v.listed.authority, "simulated");
  assert.equal(v.listed.count, v.checks.length);
});

// ---------------------------------------------------------------- 5. event ids on rounds, seats, verdicts, decisions, gates, approvals

test("5. review rounds, seats' verdicts, decisions, gates and human approvals name the event that made them", () => {
  const log = logOf(EVENTS);
  const cell = log.head().cells["LOCAL-031"];
  const round = cell.reviews.find((r) => r.round === 3);
  const byId = (id) => log.entry(id).event;
  assert.equal(byId(round.eventId).type, "review.round_started");
  assert.equal(byId(round.decidedEventId).type, "review.decided");
  assert.equal(round.late, false);
  for (const seat of round.seats) {
    assert.equal(byId(seat.votedEventId).type, "review.verdict_submitted");
    assert.equal(byId(seat.votedEventId).data.seat, seat.seat);
  }
  assert.equal(byId(round.humanApproval.eventId).type, "human.approval_recorded");
  const gate = log.head().gates["LOCAL-031/review#3"];
  assert.equal(byId(gate.meta.eventId).type, "review.decided");
  assert.equal(gate.meta.late, false);
  // The observer's own `late` flag reaches the scene; lateness to this browser stays on the entry.
  const decided = EVENTS.find((e) => e.type === "review.decided");
  const flagged = logOf(EVENTS.map((e) => (e.id === decided.id ? { ...e, late: true } : e)));
  const r = flagged.head().cells["LOCAL-031"].reviews.find((x) => x.decidedEventId === decided.id);
  assert.equal(r.decidedLate, true);
  assert.equal(isLateEntry(flagged, decided.id), true);
  // Delivered after everything else (to this browser): the entry says late, the scene is the same.
  const held = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
  held.ingest(EVENTS.filter((e) => e.id !== decided.id));
  held.ingest([decided]);
  assert.equal(isLateEntry(held, decided.id), true);
  assert.deepStrictEqual(held.head(), logOf(EVENTS).head(), "delivery order never changes the scene");
});

// ---------------------------------------------------------------- 6. slice risk; the human-approval visit; a cell with no slice

test("6. a slice's risk follows the cell's recorded risk; the human-approval visit's action is stop; a cell with no slice has a home", () => {
  const scene = logOf(EVENTS).head();
  const slice = scene.slices["SLICE-021"];
  assert.equal(slice.risk, "Medium");
  assert.ok(!slice.meta.unknown.includes("risk"), "work.scheduled recorded the risk; the slice knows it");
  const high = RUN.events.map((e) => (e.type === "review.round_started" ? { ...e, data: { ...e.data, risk: "High" } } : e));
  assert.equal(logOf(finalize(high)).head().slices["SLICE-021"].risk, "High", "the review's recorded risk reaches the slice");
  const human = scene.cells["LOCAL-031"].visits.find((v) => v.station === "human-approval");
  assert.equal(human.action, "stop");
  assert.notEqual(human.action, "build");
  assert.equal(human.meta.inferred.action, "awaiting-human");
  // A cell with no slice: its ticket is the lane title, its wave not recorded.
  const stray = ev("station.entered", { stream: "cell-lifecycle", key: "c:AUTO-1:aa", seq: 1, t: T0, ids: { ticket_id: "AUTO-1", cell_instance: "aa", visit_id: "AUTO-1/build#1", station: "build", round: 1 }, entities: ["cell:AUTO-1"], data: { station: "build", stage: "building", action: "build", resumed: false, unclosed_visit: null, head: null, counts: {} } });
  const home = cellHome(logOf(finalize([stray])).head(), "AUTO-1");
  assert.deepEqual(home, { ticketId: "AUTO-1", sliceId: null, waveId: null, laneTitle: "AUTO-1", sliceKnown: false, waveKnown: false });
  assert.deepEqual(cellHome(scene, "LOCAL-031"), { ticketId: "LOCAL-031", sliceId: "SLICE-021", waveId: "WAVE-007", laneTitle: "LOCAL-031", sliceKnown: true, waveKnown: true });
});

// ---------------------------------------------------------------- 7. capacity waits and gate refusals with no gate state

test("7. a capacity wait with no cell yet, and a refused gate no gate state stands for, are held and selectable", () => {
  const wait = ev("capacity.wait_changed", { stream: "observer", key: "i:0badc0de", seq: 7, t: T0, ids: { ticket_id: "LOCAL-77", slice_id: "SLICE-77" }, entities: ["slice:SLICE-77"], data: { state: "waiting", scope: "execution", limit: 2 } });
  const scene = logOf(finalize([wait])).head();
  assert.equal(scene.cells["LOCAL-77"], undefined, "no cell was invented for it");
  assert.equal(capacityWaits(scene).length, 1);
  assert.deepEqual(capacityWaitOf(scene, "LOCAL-77"), { ticketId: "LOCAL-77", sliceId: "SLICE-77", executionId: null, scope: "execution", limit: 2, since: T0, eventId: wait.id, late: false });
  const released = ev("capacity.wait_changed", { stream: "observer", key: "i:0badc0de", seq: 8, t: T0 + 60_000, ids: { ticket_id: "LOCAL-77" }, entities: [], data: { state: "released", scope: "execution", limit: 2 } });
  assert.equal(capacityWaits(logOf(finalize([wait, released])).head()).length, 0);

  const refused = ev("gate.evaluated", { stream: "cell-lifecycle", key: "c:LOCAL-031:3f2a9c1e", seq: 500, t: RUN.end + 1000, ids: { ticket_id: "LOCAL-031", cell_instance: "3f2a9c1e", visit_id: null, station: "build" }, entities: ["cell:LOCAL-031"], data: { gate: "build.start", verdict: "refused", reason_code: "audit-stale", subject: null, status: null, audit_tier: null, counts: {} } });
  const s2 = logOf(finalize([...RUN.events, refused])).head();
  const found = gateRefusals(s2, "LOCAL-031");
  assert.equal(found.length, 1);
  assert.equal(found[0].gate, "build.start");
  assert.equal(found[0].gateId, null);
  assert.equal(found[0].eventId, refused.id);
  assert.equal(gateRefusals(s2).length, 1);
  // A refusal a gate state does stand for is not listed here (it is the gate's state).
  const verdict = s2.cells["LOCAL-031"].gateLog.find((g) => g.gate === "verify.verdict" && g.verdict === "refused");
  assert.equal(verdict.gateId, "LOCAL-031/verification#1");
});

// ---------------------------------------------------------------- 8. entity kinds

test("8. visit, seat, workflow, execution and project are entity kinds, found by identity", () => {
  for (const kind of ["visit", "seat", "workflow", "execution", "project"]) assert.ok(ENTITY_KINDS.includes(kind), kind);
  const withProject = RUN.events.map((e) => ({ ...e, ids: { ...e.ids, project_id: "team-space" } }));
  const scene = logOf(finalize(withProject)).head();
  assert.equal(entityAt(scene, "visit:LOCAL-031/verify#1").value.outcomeWord, "FAIL_WITH_EVIDENCE");
  const seat = entityAt(scene, "seat:LOCAL-031/review#2/security").value;
  assert.equal(seat.vote, "REJECT");
  assert.equal(seat.findings, 1);
  const wf = entityAt(scene, "workflow:x1a2b3c4d5e6f/task0001").value;
  assert.equal(wf.executionId, "x1a2b3c4d5e6f");
  assert.ok(wf.agentIds.length > 20);
  assert.equal(wf.status, "completed");
  assert.equal(entityAt(scene, "execution:x1a2b3c4d5e6f").kind, "execution");
  const project = entityAt(scene, "project:team-space").value;
  assert.equal(project.name, null, "not recorded in events");
  assert.equal(project.cells, 1);
  // For a React selector: the same object while nothing in it changed.
  assert.equal(stableEntityAt(scene, "seat:LOCAL-031/review#2/security"), stableEntityAt(scene, "seat:LOCAL-031/review#2/security"));
  const log = logOf(finalize(withProject));
  const lateScene = log.sceneAt(log.headTime() - 1);
  assert.equal(stableEntityAt(lateScene, "seat:LOCAL-031/review#2/security").value, stableEntityAt(scene, "seat:LOCAL-031/review#2/security").value, "unchanged between scenes: same object");
});

// ---------------------------------------------------------------- 9. one time scale

test("9. one store-level time scale: 1 at the live edge, the chosen playback rate everywhere else", () => {
  assert.equal(timeScaleOf({ source: "live", following: true, speed: 4 }), 1);
  assert.equal(timeScaleOf({ source: "live", following: false, speed: 1 }), PLAYBACK_BASE_RATE, "scrubbed back inside a live store: playback");
  assert.equal(timeScaleOf({ source: "live", following: false, speed: 4 }), PLAYBACK_BASE_RATE * 4);
  assert.equal(timeScaleOf({ source: "replay", following: false, speed: 2 }), PLAYBACK_BASE_RATE * 2);
  assert.equal(timeScaleOf({ source: "simulation", following: true, speed: 1 }), PLAYBACK_BASE_RATE);
  // It is the rate the playhead actually moves at while playing.
  const clock = manualClock(0);
  const store = createSceneStore({ source: "replay", log: logOf(EVENTS), clock, at: EVENTS[0].time.order_ms });
  store.setSpeed(2);
  store.play();
  clock.frames(1, 0);
  const t0 = store.getState().playhead;
  clock.frames(10, 100);
  assert.equal(store.getState().playhead - t0, 1000 * timeScaleOf(store.getState()));
});

// ---------------------------------------------------------------- 10. incremental folds

test("10. moments and other folds over a log read only what was added; late inserts rebuild once; identity is stable", () => {
  let reads = 0;
  const fold = createLogFold((entry) => {
    reads += 1;
    return { t: entry.t, id: entry.id };
  });
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
  const half = Math.floor(EVENTS.length / 2);
  log.ingest(EVENTS.slice(0, half));
  const first = fold(log);
  assert.equal(reads, half);
  assert.equal(fold(log), first, "unchanged log: the same fold");
  log.ingest(EVENTS.slice(half, half + 10));
  assert.equal(fold(log).items.length, half + 10);
  assert.equal(reads, half + 10, "appends read only the new entries");
  // A late insertion: read again once, in order.
  log.ingest(EVENTS.slice(half + 10));
  const lateOne = { ...EVENTS[5], id: "i:late:1", order: EVENTS[5].order.replace(/~0000$/, "~0001") };
  log.ingest([lateOne]);
  const rebuilt = fold(log).items;
  assert.equal(rebuilt.length, EVENTS.length + 1);
  assert.ok(rebuilt.every((x, i) => i === 0 || rebuilt[i - 1].t <= x.t));
  // moments(log) is the same list a fresh full read gives, and the same array while unchanged.
  const m = moments(log, "major");
  assert.equal(moments(log, "major"), m);
  const fresh = logOf([...EVENTS, lateOne]);
  assert.deepEqual(m.map((x) => x.id), moments(fresh, "major").map((x) => x.id));
  const at = EVENTS[half].time.order_ms;
  assert.deepEqual(moments(log, "major", at).map((x) => x.id), m.filter((x) => x.t <= at).map((x) => x.id));
});

// ---------------------------------------------------------------- 11 to 14: the observer client

async function setupLive({ snapshot = false, history = EVENTS.slice(0, 200), pageLimit = 100 } = {}) {
  const server = fakeObserver({ snapshot });
  server.commit(history.map(unpos));
  const clock = manualClock(0);
  const timers = fakeTimers();
  const client = live.createObserverClient({ fetch: server.fetch });
  const { store, source, log } = live.createLiveFactory({ client, openStream: server.openStream, clock, timers, pageLimit, staleAfterMs: 30_000 });
  await source.start();
  await settle();
  clock.frames(1, 16);
  return { server, clock, timers, store, source, log, client };
}

test("11. /factory/status is read in the observer's documented shape and exposed from the store", async () => {
  const { store, source, server, timers } = await setupLive();
  const f = store.getState().factoryStatus;
  assert.equal(f.factoryPresent, true);
  assert.equal(f.enabled, true);
  assert.equal(f.paused, false);
  assert.equal(f.mode, "supervised");
  assert.deepEqual(f.supervisor, { leasePresent: true, heartbeatFresh: true, heartbeatAgeSeconds: 4, leaseExpired: false });
  assert.deepEqual(f.sources, [{ key: "i:0badc0de", state: "live", lagBytes: 0, lastReadAgeMs: 120, runtime: null }]); // runtime: execution streams only (observer M6.2)
  assert.equal(f.readAt, Date.parse("2026-11-12T09:00:00Z"));
  server.status = { ...server.status, summary: { ...server.status.summary, paused: true } };
  timers.tick();
  await settle();
  assert.equal(store.getState().factoryStatus.paused, true);
  source.stop();
  // The simulation has none.
  const sim = createSceneStore({ fixture: SCENARIO, clock: manualClock(0) });
  sim.setFactoryStatus(f);
  assert.equal(sim.getState().factoryStatus, null);
});

test("12. after N failed attempts the connection is disconnected, still retrying; the observer back on the same origin resumes from the cursor", async () => {
  const { server, store, source, timers, clock, log } = await setupLive();
  const cursor = source.status().cursor;
  server.down = true;
  server.drop();
  assert.equal(store.getState().connection.state, "reconnecting");
  for (let i = 0; i < DISCONNECTED_AFTER + 1; i++) {
    timers.runTimeouts();
    await settle();
  }
  const c = store.getState().connection;
  assert.equal(c.state, "disconnected", "not reconnecting forever");
  assert.ok(c.attempts > DISCONNECTED_AFTER);
  assert.equal(timers.pendingTimeouts, 1, "and still retrying, with back-off");
  // The observer restarts with its sessions, index and port: the same origin, the same session.
  server.down = false;
  server.commit(EVENTS.slice(200, 230).map(unpos));
  timers.runTimeouts();
  await settle();
  clock.frames(1, 16);
  assert.equal(store.getState().connection.state, "live");
  assert.equal(log.size(), 230);
  assert.equal(log.stats().duplicates, 0, "resumed from the cursor: nothing applied twice");
  const firstPage = server.requests.filter((r) => r.includes("/events")).at(-2) ?? "";
  assert.ok(firstPage.includes(encodeURIComponent(cursor)) || server.requests.some((r) => r.includes(`after=${encodeURIComponent(cursor)}`)), "history resumed after the held cursor");
  source.stop();
});

test("13. after a gap, history continues from the observer's floor; the summaries seed what the window does not touch (never the whole snapshot)", async () => {
  const { server, store, source, clock, log } = await setupLive({ snapshot: true });
  const stream = server.live()[0];
  stream.closed = true;
  const later = server.commit(EVENTS.slice(200, 260).map(unpos));
  stream.closed = false;
  server.expire(later.at(-1).pos - 20);
  // The run's own cell is in the window (left to its events); another cell and its ended execution are not.
  server.summaries.cells = [{ ticket_id: "LOCAL-031", slice_id: "SLICE-021", stage: "verified", round: 2 }, { ticket_id: "LOCAL-040", slice_id: "SLICE-040", stage: "building", round: 1 }];
  server.summaries.runs = [{ execution_id: "x0000000000aa", ticket_id: "LOCAL-040", state: "ended", attempt: 1 }];
  server.sendGap();
  await settle();
  clock.frames(1, 16);
  assert.deepEqual(server.snapshotsAt, [], "the observer's whole projected state is never fetched");
  assert.equal(log.size(), 200 + 20 + 3, "then exactly what follows the floor (and three client markers: the gap, the window, the seed)");
  const head = log.head();
  assert.equal(head.completeness.state, "reconstructed");
  assert.equal(head.cells["LOCAL-040"].stage, "building");
  assert.equal(head.executions.x0000000000aa.meta.authority, "reconstructed");
  assert.equal(head.executions.x0000000000aa.ended, "exited", "an execution whose process ended is never seeded as running");
  assert.notEqual(sim.activityOf(head, "execution:x0000000000aa").state, "executing");
  assert.ok(!head.cells["LOCAL-031"].meta.eventId.startsWith("k:"), "a summary never stands in for a cell the window's events describe");
  assert.equal(store.getState().connection.state, "live");
  source.stop();
});

test("13. replay reads /history windows in order, marks a window that starts part-way, and falls back to paged /events", async () => {
  const server = fakeObserver();
  server.commit(EVENTS.map(unpos));
  const client = live.createObserverClient({ fetch: server.fetch });
  const whole = await live.loadHistory(client, { pageLimit: 64 });
  assert.equal(whole.size(), EVENTS.length);
  assert.ok(server.requests.some((r) => r.includes("/history")));
  assert.ok(!server.requests.some((r) => r.includes("/events")));
  assert.equal(whole.head().completeness.state, "complete");
  const from = EVENTS[100].time.order_ms;
  const windowed = await live.loadHistory(client, { pageLimit: 64, fromMs: from });
  assert.ok(windowed.size() < EVENTS.length);
  assert.equal(windowed.head().completeness.state, "partial", "history before the window is not loaded, and the scene says so");
  assert.equal(windowed.head().completeness.gaps[0].reason, "before-window");
  const old = fakeObserver({ history: false });
  old.commit(EVENTS.map(unpos));
  const fallback = await live.loadHistory(live.createObserverClient({ fetch: old.fetch }), { pageLimit: 64 });
  assert.equal(fallback.size(), EVENTS.length);
  assert.ok(old.requests.some((r) => r.includes("/events")));
});

test("14. cost completeness comes from execution.usage.cost_complete and its reasons, never guessed", () => {
  const usage = EVENTS.find((e) => e.type === "execution.usage");
  const x = (data) => logOf(EVENTS.map((e) => (e.id === usage.id ? { ...e, data: { ...e.data, ...data } } : e))).head().executions.x1a2b3c4d5e6f;
  assert.deepEqual(costCompletenessOf(x({ cost_complete: false, cost_incomplete_reasons: ["budget-stop", "agents-killed-in-flight"] })), { complete: false, reasons: ["budget-stop", "agents-killed-in-flight"], eventId: usage.id });
  assert.equal(costCompletenessOf(x({ cost_complete: true, cost_incomplete_reasons: [] })).complete, true);
  assert.equal(costCompletenessOf(x({ budget_exhausted: true })).complete, null, "a record without the field (revision 0) does not say; nothing is inferred from a budget stop");
});

// ---------------------------------------------------------------- 15. no frame loop leaks

test("15. a live store runs its follow loop only while watched: one made and dropped (StrictMode) leaks no frame loop", () => {
  const clock = manualClock(0);
  const dropped = createSceneStore({ source: "live", log: logOf(EVENTS), clock });
  assert.equal(clock.pending, 0, "nothing asked for while nobody watches");
  clock.frames(5, 16);
  assert.equal(clock.pending, 0);
  const watched = createSceneStore({ source: "live", log: logOf(EVENTS), clock });
  const off = watched.subscribe(() => undefined);
  assert.equal(clock.pending, 1, "watching starts the follow loop");
  clock.frames(3, 16);
  assert.equal(clock.pending, 1, "one loop, not one per frame");
  off();
  assert.equal(clock.pending, 0, "the last watcher leaving stops it");
  // Explicit playback runs without a watcher (tests and the capture script).
  watched.seek(EVENTS[10].time.order_ms);
  watched.play();
  assert.equal(clock.pending, 1);
  watched.dispose();
  dropped.dispose();
  assert.equal(clock.pending, 0);
});

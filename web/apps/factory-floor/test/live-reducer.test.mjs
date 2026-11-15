// M6.2: the one reducer over version 3 events, a belt run built from the real stream fixture and
// lifecycle records: the expected scene, honest degraded states, provenance on every value,
// determinism, and the simulation still labelled as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { BELT_AGENTS, beltRun, finalize } from "./fixtures/v3.mjs";

const { createSceneLog, provenance, activityOf, toolActivity, authorityOf, isKnown, entityAt, liveEntityAt, relatedRefs, eventIdsFor, refsOfEntry, eventsFor, SCENARIO, sceneAt, finalScene, allAgents, describeEntry, agentTimeline, cellTimelines } = sim;
const DEFS = live.LIVE_DEFINITIONS;
const logOf = (events, extra = {}) => {
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live"), ...extra });
  log.ingest(events);
  return log;
};

const RUN = beltRun();
const EVENTS = finalize(RUN.events);

test("v3 fixture: every event has the envelope's required fields and a kind the contract lists", () => {
  for (const e of EVENTS) {
    assert.equal(e.schema_version, 3);
    assert.ok(live.parseCursor !== undefined);
    assert.ok(sim.parseV3(e), e.id);
    assert.ok(sim.isKnownV3Kind(e.type), e.type);
    assert.match(e.order, /^[0-9]{15}~[1-6]~[^~]+~[0-9]{12}~[0-9]{4}$/);
  }
  assert.equal(new Set(EVENTS.map((e) => e.id)).size, EVENTS.length, "ids are unique");
  // The workflow agents are the real belt's: 29 of them in its last snapshot.
  assert.equal(BELT_AGENTS.length, 29);
});

test("a belt run (build, verify fails, revise, verify, review rejects, revise, verify, review approves, human gate) gives the expected scene", () => {
  const scene = logOf(EVENTS).head();
  const cell = scene.cells["LOCAL-031"];
  assert.equal(scene.provenance.source, "live");
  assert.equal(cell.stage, "approved");
  assert.equal(cell.round, 3);
  assert.deepEqual(cell.visits.map((v) => `${v.station}:${v.outcomeWord}`), [
    "build:built",
    "verify:FAIL_WITH_EVIDENCE",
    "build:built",
    "verify:PASS",
    "review:REJECTED",
    "build:built",
    "verify:PASS",
    "review:AWAITING_HUMAN",
    "human-approval:approved",
  ]);
  assert.deepEqual(cell.visits.map((v) => v.outcome), ["done", "failed", "done", "passed", "rejected", "done", "passed", "awaiting-human", "approved"]);
  assert.deepEqual(cell.visits[2].action, "revise");
  assert.ok(cell.visits.every((v) => v.durationMs !== null && v.durationMs >= 0 && v.meta.end === "measured"), "visit durations are measured");
  assert.equal(scene.gates["LOCAL-031/verification#1"].state, "failed");
  assert.equal(scene.gates["LOCAL-031/verification#2"].state, "passed");
  assert.equal(scene.gates["LOCAL-031/review#2"].state, "failed");
  assert.equal(scene.gates["LOCAL-031/review#3"].state, "passed");
  assert.equal(scene.gates["LOCAL-031/human-approval"].state, "passed");
  assert.equal(scene.gates["LOCAL-031/human-approval"].detail, "Approved by a person.");
  assert.equal(scene.counters.verificationFailures, 1);
  assert.equal(cell.reviews.length, 2);
  assert.equal(cell.reviews[0].outcome, "REJECTED");
  assert.equal(cell.reviews[0].findings[0].id, "LOCAL-031/r2/security/1");
  assert.equal(cell.reviews[1].outcome, "APPROVED");
  assert.equal(cell.reviews[1].humanApproval.by, "a person", "people's names never appear (D15)");
  assert.deepEqual(cell.verifications.map((v) => v.status), ["FAIL_WITH_EVIDENCE", "PASS", "PASS"]);
  assert.deepEqual(cell.verifications[0].checks.map((c) => `${c.targetId}:${c.result}`), ["AC-01:pass", "R1:fail"]);
  const x = scene.executions.x1a2b3c4d5e6f;
  assert.equal(x.state, "completed");
  assert.equal(x.workflowStatus, "completed");
  assert.equal(x.ended, "exited");
  assert.deepEqual(x.phases, ["Preflight", "Groom", "Build", "Verify", "Review", "Wrap up", "Learn"]);
  assert.equal(scene.counters.costUsd, 1.82, "cost counted once, from the recorded usage");
  assert.equal(Object.keys(x.queued).length, 0, "every queued agent started");
});

test("workflow agents are counted, not ticked: count known, calls unknown (contract 8.1)", () => {
  const scene = logOf(EVENTS).head();
  const cell = scene.cells["LOCAL-031"];
  const workers = Object.values(cell.agents).filter((a) => a.observation === "count-only");
  assert.equal(workers.length, RUN.agents.length);
  for (const a of workers) {
    const tpl = RUN.agents.find((r) => r.id === a.id).template;
    assert.equal(a.toolCalls.length, 0, "no per-call activity for a workflow agent");
    assert.equal(a.toolCallCount, tpl.toolCalls);
    assert.equal(a.tokens, tpl.tokens);
    assert.equal(a.durationMs, tpl.durationMs);
    assert.equal(a.lifecycle, "done");
    assert.equal(a.modelName, tpl.model);
    const activity = toolActivity(a);
    assert.equal(activity.kind, "count");
    assert.equal(activity.count, tpl.toolCalls);
    assert.equal(a.meta.authority, "observed");
  }
  const builder = workers.find((a) => a.role === "builder");
  assert.equal(builder.station, "build");
  assert.equal(builder.meta.inferred["ids.station"], "label", "the station is read from the worker's label, and says so");
  const security = workers.find((a) => a.seat === "security");
  assert.equal(security.role, "reviewer");
  // The main loop's calls are observed one by one.
  const main = cell.agents["x1a2b3c4d5e6f/main"];
  assert.equal(main.observation, "per-call");
  assert.equal(toolActivity(main).kind, "calls");
  assert.equal(main.toolCalls[0].toolName, "Workflow");
  assert.equal(main.lifecycle, "done", "the main loop ends with its process");
  // A running agent mid-run: elapsed known, no fraction, count so far.
  const log = logOf(EVENTS);
  const mid = BuilderMid(log);
  assert.equal(mid.lifecycle, "running");
  assert.ok(mid.toolCallCount === null || mid.toolCallCount < 12);
  assert.equal(mid.finishedAt, null);
});

function BuilderMid(log) {
  const started = log.entries().find((e) => e.event.type === "agent.started" && e.event.data.agent_type === "mach:builder");
  return sim.findAgent(log.sceneAt(started.t + 1000), started.event.ids.agent_id);
}

test("degraded states: executing, waiting for a person, completed, failed, interrupted, stale, unknown", () => {
  const log = logOf(EVENTS);
  const entries = log.entries();
  const at = (pred) => entries.find(pred).t;
  const building = log.sceneAt(at((e) => e.event.type === "station.entered" && e.event.data.station === "build") + 1);
  assert.equal(activityOf(building, "cell:LOCAL-031").state, "executing");
  assert.equal(activityOf(building, "cell:LOCAL-031", { stale: true }).state, "stale", "a lost connection makes executing stale");
  const gate = log.sceneAt(at((e) => e.event.type === "human.required"));
  assert.equal(activityOf(gate, "cell:LOCAL-031").state, "waiting-person");
  const end = log.head();
  assert.equal(activityOf(end, "execution:x1a2b3c4d5e6f").state, "completed");
  // Approved and not merged: its state is known (review done, merge next); who merges is not recorded.
  const approved = activityOf(end, "slice:SLICE-021");
  assert.equal(approved.state, "completed");
  assert.deepEqual(approved.awaiting, { step: "merge", label: "Approved, not merged yet", by: null, basis: null });
  assert.match(approved.reason, /Who merges is not recorded/);
  const agent = Object.values(end.cells["LOCAL-031"].agents).find((a) => a.observation === "count-only");
  assert.equal(activityOf(end, `agent:${agent.id}`).state, "completed");
  assert.equal(activityOf(end, "cell:NOPE").state, "unknown");

  // An interrupted execution, an agent closed by the observer with status unknown, a failed one.
  const run = beltRun({ ticket: "LOCAL-040", slice: "SLICE-040", execution: "x0000000000aa", approve: false });
  const cut = run.events.filter((e) => e.type !== "execution.completed" && e.type !== "workflow.finished");
  const ended = cut.find((e) => e.type === "execution.process_ended");
  ended.data = { ended: "interrupted", exit_code: null, seconds: 10 };
  const lastStart = [...cut].reverse().find((e) => e.type === "agent.started");
  const closeIdx = cut.findIndex((e) => e.type === "agent.finished" && e.ids.agent_id === lastStart.ids.agent_id);
  cut[closeIdx] = { ...cut[closeIdx], authority: "reconstructed", data: { ...cut[closeIdx].data, status: "unknown" }, time: { ...cut[closeIdx].time, precision: "bounded" } };
  const s2 = logOf(finalize(cut)).head();
  assert.equal(activityOf(s2, "execution:x0000000000aa").state, "interrupted");
  assert.equal(activityOf(s2, `agent:${lastStart.ids.agent_id}`).state, "unknown");
  assert.equal(sim.findAgent(s2, lastStart.ids.agent_id).meta.end, "inferred");
});

test("waiting for resources only where a wait is recorded (capacity.wait_changed), never from silence", () => {
  const run = beltRun({ ticket: "LOCAL-050", slice: "SLICE-050", execution: "x0000000000bb" });
  const claim = run.events.find((e) => e.type === "work.claimed");
  const wait = { ...claim, id: "o:c:LOCAL-050:w:1", type: "capacity.wait_changed", authority: "reconstructed", origin: { ...claim.origin, stream: "observer", key: "o" }, order: claim.order.replace(/~1~/, "~6~"), data: { state: "waiting", scope: "execution", limit: 2 }, inferred: { "data.state": "held-sentence" } };
  const log = logOf(finalize([...run.events, wait]));
  const s = log.sceneAt(claim.time.order_ms);
  assert.equal(activityOf(s, "execution:x0000000000bb").state, "waiting-resources");
  const plain = logOf(finalize(run.events)).sceneAt(claim.time.order_ms);
  assert.notEqual(activityOf(plain, "execution:x0000000000bb").state, "waiting-resources");
});

test("every value a view may draw carries its authority, what is unknown, and how its times are known", () => {
  const scene = logOf(EVENTS).head();
  const cell = scene.cells["LOCAL-031"];
  assert.equal(authorityOf(cell.meta, "stage"), "authoritative");
  assert.equal(isKnown(cell.meta, "title"), false, "no product definitions in a live scene: the title is a placeholder");
  assert.equal(isKnown(cell.meta, "risk"), true, "work.scheduled recorded the risk");
  const task = cell.tasks.find((k) => k.id === "T1");
  assert.equal(isKnown(task.meta, "startedAt"), false, "no record says when a task started");
  assert.equal(task.meta.start, "unknown");
  for (const gate of Object.values(scene.gates)) assert.ok(["authoritative", "reconstructed"].includes(gate.meta.authority), gate.id);
  const artifact = cell.artifacts[0];
  assert.equal(artifact.meta.authority, "reconstructed");
  assert.equal(artifact.writer.agentId, null, "who wrote it is never recorded for workflow agents");
  // The simulation says simulated, everywhere.
  const s = finalScene(SCENARIO);
  assert.equal(s.provenance.source, "simulation");
  assert.equal(s.provenance.label, "Simulation");
  assert.equal(s.cells["LOCAL-031"].meta.authority, "simulated");
  assert.ok(allAgents(s).every((a) => a.meta.authority === "simulated" && a.observation === "per-call"));
  assert.equal(sceneAt(SCENARIO, 0).provenance.source, "simulation");
});

test("event-to-entity links in both directions (for Evidence Theater and Analytics)", () => {
  const log = logOf(EVENTS);
  const ids = eventIdsFor(log, "gate:LOCAL-031/review#2");
  assert.ok(ids.length >= 4);
  for (const id of ids) assert.ok(refsOfEntry(log, id).includes("gate:LOCAL-031/review#2"));
  const finding = eventsFor(log, "finding:LOCAL-031/r2/security/1");
  assert.equal(finding.length, 1);
  assert.equal(finding[0].authority, "reconstructed");
  assert.ok(eventsFor(log, "visit:LOCAL-031/verify#1").length >= 4, "visit refs index their events");
  const visit = liveEntityAt(log.head(), "visit:LOCAL-031/verify#1");
  assert.equal(visit.value.outcomeWord, "FAIL_WITH_EVIDENCE");
  assert.equal(liveEntityAt(log.head(), "seat:LOCAL-031/review#2/security").value.vote, "REJECT");
  assert.equal(liveEntityAt(log.head(), "workflow:x1a2b3c4d5e6f/task0001").value.executionId, "x1a2b3c4d5e6f");
  assert.ok(describeEntry(log.entries().at(-1)).length > 5);
});

test("timelines over a live log: open spans have no end; agents carry their count, not ticks", () => {
  const log = logOf(EVENTS);
  const mid = log.entries().find((e) => e.event.type === "agent.started" && e.event.data.agent_type === "mach:verifier");
  const lanes = cellTimelines(log, mid.t + 1000);
  const span = lanes[0].agents.find((a) => a.agentId === mid.event.ids.agent_id);
  assert.equal(span.end, null);
  const timeline = agentTimeline(log, mid.event.ids.agent_id, mid.t + 1000);
  assert.equal(timeline.observation, "count-only");
  assert.deepEqual(timeline.tools, []);
});

test("determinism: the same events give the same scene object graph", () => {
  const a = logOf(EVENTS).head();
  const b = logOf(structuredClone(EVENTS)).head();
  assert.deepStrictEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(relatedRefs(a, "cell:LOCAL-031").includes("slice:SLICE-021"));
  assert.equal(entityAt(a, "cell:LOCAL-031").value.ticketId, "LOCAL-031");
});

test("an unknown kind from a later revision is kept and not reduced", () => {
  const extra = { ...EVENTS[5], id: "i:0badc0de:999", type: "station.teleported", order: EVENTS[5].order.replace(/~0{0,}(\d+)~0000$/, "~000000000999~0000"), data: { anything: 1 } };
  const log = logOf(finalize([...EVENTS.slice(0, 6), extra]));
  assert.ok(log.entry("i:0badc0de:999"));
  assert.match(describeEntry(log.entry("i:0badc0de:999")), /does not understand/);
  assert.equal(log.head().cursor, 7);
});

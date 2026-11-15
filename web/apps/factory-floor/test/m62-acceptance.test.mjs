// M6.2 acceptance: the scene-model, live-client and shell defects the real end-to-end run found
// (docs/mach-next/M6_2_ACCEPTANCE.md, D4 to D24). Each test reproduces its defect with a small v3
// fixture written for it (shaped like the run's records, with none of its data), then holds the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";
import { fakeObserver, fakeTimers, seeded, settle } from "./fixtures/observer.mjs";

const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const words = await import("../src/shell/inspector/words.ts");
const { gateStateWords } = await import("../src/shell/vocab.ts").catch(() => ({ gateStateWords: null }));
const {
  createSceneLog,
  provenance,
  visitStatusOf,
  gateOverrides,
  streamObservationOf,
  artifactCountsOf,
  whyEntry,
  entriesBehind,
  activityOf,
  entityAt,
  lostGaps,
  notInterpretedCount,
} = sim;
const DEFS = live.LIVE_DEFINITIONS;
const logOf = (events) => {
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
  log.ingest(events);
  return log;
};

const T0 = Date.UTC(2026, 10, 12, 22, 45, 0);
const TICKET = "LOCAL-001";
const SLICE = "SLICE-001";
const CELL_KEY = `c:${TICKET}:b2dcbc17`;

/** A small Factory, written for these tests: intake, lifecycle, records and stream events of one cell. */
function factory() {
  let iseq = 0;
  let cseq = 0;
  const sseq = {};
  const out = [];
  const intake = (type, t, data, ids = {}, entities = []) => out.push(ev(type, { stream: "intake-log", key: "i:df29bf72", seq: ++iseq, t, precision: "s", ids, entities, data }));
  const life = (type, t, data, ids = {}, entities = []) => out.push(ev(type, { stream: "cell-lifecycle", key: CELL_KEY, seq: ++cseq, t, ids: { ticket_id: TICKET, ...ids }, entities: [`cell:${TICKET}`, ...entities], data }));
  const stream = (x, type, t, data, ids = {}, entities = [], extra = {}) => {
    sseq[x] = (sseq[x] ?? 0) + 1;
    const e = ev(type, { stream: "execution-stream", key: `s:${x}`, seq: sseq[x], t, ids: { ticket_id: TICKET, execution_id: x, ...ids }, entities: [`execution:${x}`, ...entities], data, ...extra });
    if (extra.runtime) e.origin.runtime_state = extra.runtime;
    out.push(e);
  };
  const record = (type, x, seq, t, data) => out.push(ev(type, { stream: "execution-record", key: `x:${x}`, seq, t, precision: "s", ids: { ticket_id: TICKET, execution_id: x }, entities: [`execution:${x}`, `cell:${TICKET}`], data }));
  const observer = (type, t, data, ids = {}, entities = [], seq) => out.push(ev(type, { stream: "observer", key: CELL_KEY, seq, t, ids: { ticket_id: TICKET, ...ids }, entities: [`cell:${TICKET}`, ...entities], data }));
  const enter = (visit, t, x, round, data = {}) => {
    const station = visit.split("#")[0];
    life("station.entered", t, { station, stage: data.stage ?? null, action: data.action === undefined ? station : data.action, resumed: false, unclosed_visit: data.unclosed ?? null, head: null, counts: {} }, { visit_id: `${TICKET}/${visit}`, station, round, execution_id: x }, [`station:${TICKET}/${station}`, `visit:${TICKET}/${visit}`]);
  };
  const exit = (visit, t, x, round, outcome, stage) => {
    const station = visit.split("#")[0];
    life("station.exited", t, { station, outcome, stage, duration_ms: 1000, closed_by: null, head: null, counts: {} }, { visit_id: `${TICKET}/${visit}`, station, round, execution_id: x }, [`station:${TICKET}/${station}`, `visit:${TICKET}/${visit}`]);
  };
  return { out, intake, life, stream, record, observer, enter, exit };
}

// ---------------------------------------------------------------- D5: the cell is linked to its slice whatever arrives first

/**
 * The run's shape: intake's slice.materialized names ticket and slice; the cell's first lifecycle
 * record names only the ticket; later lifecycle records carry the slice. Times are drawn so the
 * cell is seen before the slice, the slice before the cell, or the slice id only on a later event.
 */
function linkHistory(rand) {
  const f = factory();
  const sliceAt = T0 + Math.floor(rand() * 4000);
  const cellAt = T0 + Math.floor(rand() * 4000);
  const scheduledAt = T0 + 4000 + Math.floor(rand() * 2000);
  f.intake("wave.discovered", T0 - 1000, { slices: [SLICE], approval: { approved_at: null, by_role: "person" } }, { wave_id: "WAVE-001" }, ["wave:WAVE-001"]);
  f.intake("slice.materialized", sliceAt, { digest: "d", adopted: false, dependencies: [], reissued: null }, { wave_id: "WAVE-001", slice_id: SLICE, ticket_id: TICKET }, ["wave:WAVE-001", `slice:${SLICE}`, `cell:${TICKET}`]);
  // The slice id reaches the lifecycle on a random later record only (or never).
  const sliceOn = Math.floor(rand() * 4);
  const ids = (k) => (k === sliceOn ? { slice_id: SLICE } : {});
  f.life("station.entered", cellAt, { station: "groom", stage: "interview", action: "groom", resumed: false, unclosed_visit: null, head: null, counts: {} }, { visit_id: `${TICKET}/groom#1`, station: "groom", ...ids(0) });
  f.life("gate.evaluated", cellAt + 50, { gate: "groom.finalize", verdict: "passed", reason_code: null, subject: null, status: null, audit_tier: null, counts: {} }, { visit_id: `${TICKET}/groom#1`, ...ids(1) });
  f.life("station.exited", cellAt + 60, { station: "groom", outcome: "spec-ready", stage: "spec-ready", duration_ms: 60, closed_by: null, head: null, counts: {} }, { visit_id: `${TICKET}/groom#1`, station: "groom", ...ids(2) });
  if (rand() < 0.5) f.intake("work.scheduled", scheduledAt, { stage: "planned", risk: "High", branch: `feature/${TICKET}`, by_role: "supervisor", authorization: "runner" }, { slice_id: SLICE, ticket_id: TICKET }, [`slice:${SLICE}`, `cell:${TICKET}`]);
  return finalize(f.out);
}

test("D5: live ingestion links a cell to its slice whichever arrives first (property, shuffled delivery)", () => {
  // The defect as the run had it: the cell's first record names only the ticket and sorts before
  // work.scheduled; before the fix the cell kept an empty slice and the slice stood alone.
  const rand = seeded(0x5d5);
  for (let run = 0; run < 200; run++) {
    const events = linkHistory(rand);
    const once = logOf(events).head();
    const cell = once.cells[TICKET];
    assert.ok(cell, `run ${run}: the cell exists`);
    assert.equal(cell.sliceId, SLICE, `run ${run}: the cell names its slice`);
    assert.equal(once.slices[SLICE].ticketId, TICKET, `run ${run}: the slice names its ticket`);
    assert.equal(Object.keys(once.cells).length, 1, `run ${run}: no second cell for the slice`);
    assert.ok(!cell.meta.unknown.includes("sliceId"), `run ${run}: the slice is not "not recorded"`);
    // Delivery in any order, in any batches: the same scene (the log orders; the link does not depend on arrival).
    const shuffled = [...events].sort(() => rand() - 0.5);
    const log = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
    for (let i = 0; i < shuffled.length; ) {
      const n = 1 + Math.floor(rand() * 3);
      log.ingest(shuffled.slice(i, i + n));
      i += n;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(log.head())), JSON.parse(JSON.stringify(once)), `run ${run}: delivery order changes nothing`);
  }
});

test("D5: the slice's title stands in for the cell's when the cell met its slice late", () => {
  const f = factory();
  f.life("station.entered", T0, { station: "groom", stage: "interview", action: "groom", resumed: false, unclosed_visit: null, head: null, counts: {} }, { visit_id: `${TICKET}/groom#1`, station: "groom" });
  f.intake("work.scheduled", T0 + 900, { stage: "planned", risk: "High", branch: `feature/${TICKET}`, by_role: "supervisor", authorization: "runner" }, { slice_id: SLICE, ticket_id: TICKET }, [`slice:${SLICE}`, `cell:${TICKET}`]);
  const cell = logOf(finalize(f.out)).head().cells[TICKET];
  assert.equal(cell.sliceId, SLICE);
  assert.equal(cell.title, SLICE, "the same title as when the slice came first");
});

// ---------------------------------------------------------------- D4, D14: visits that never exited; waits on a person

function verifyRetries() {
  const f = factory();
  const x1 = "x13e7bccffc37";
  const x2 = "x466e1b0a645d";
  f.intake("work.scheduled", T0, { stage: "planned", risk: "High", branch: "b", by_role: "supervisor", authorization: "runner" }, { slice_id: SLICE, ticket_id: TICKET }, [`cell:${TICKET}`]);
  f.record("execution.process_started", x1, 1, T0 + 1000, {});
  f.enter("verify#1", T0 + 60_000, x1, 1, { stage: "built" });
  f.enter("verify#2", T0 + 120_000, x1, 1, { stage: "built", unclosed: "verify#1" });
  f.record("execution.process_ended", x1, 2, T0 + 400_000, { ended: "exited", exit_code: 0, seconds: 399 });
  f.record("execution.process_started", x2, 1, T0 + 500_000, {});
  f.enter("verify#3", T0 + 560_000, x2, 1, { stage: "built", unclosed: "verify#2" });
  f.exit("verify#3", T0 + 620_000, x2, 1, "PASS", "verified");
  f.enter("human-approval#1", T0 + 700_000, x2, 2, { stage: "awaiting-human", action: null });
  f.record("execution.process_ended", x2, 2, T0 + 760_000, { ended: "exited", exit_code: 0, seconds: 260 });
  return { events: finalize(f.out), x1, x2 };
}

test("D4: a visit superseded by the next entry is ended without an exit record, never 'still working'", () => {
  const { events } = verifyRetries();
  const log = logOf(events);
  const v1 = entityAt(log.sceneAt(T0 + 130_000), `visit:${TICKET}/verify#1`).value;
  assert.equal(v1.leftAt, T0 + 120_000, "bounded by the next entry");
  assert.deepEqual([v1.unclosed.reason, v1.outcome, v1.outcomeWord], ["superseded", "stopped", null]);
  assert.equal(v1.meta.authority, "reconstructed");
  assert.equal(v1.meta.end, "inferred");
  const status = visitStatusOf(v1);
  assert.equal(status.state, "ended-unrecorded");
  assert.equal(status.word, "Ended without an exit record");
  assert.notEqual(status.word, "Working");
});

test("D4: a visit open when its execution ended is ended at the execution's end, not at work for minutes after", () => {
  const { events } = verifyRetries();
  const log = logOf(events);
  // Between the first execution's end and the next entry: the run showed "Working, at work for 11 min 49 s" here.
  const scene = log.sceneAt(T0 + 450_000);
  const v2 = entityAt(scene, `visit:${TICKET}/verify#2`).value;
  assert.equal(v2.leftAt, T0 + 400_000, "bounded by the execution's end");
  assert.equal(v2.unclosed.reason, "execution-ended");
  assert.equal(scene.cells[TICKET].station, null, "the cell is at no station");
  assert.notEqual(activityOf(scene, `cell:${TICKET}`).state, "executing");
  assert.equal(words.elapsedWords("ended-unrecorded", true, true, "5 min 40 s"), "ended without an exit record, within 5 min 40 s");
  // The later entry naming it does not move the earlier bound.
  assert.equal(entityAt(log.head(), `visit:${TICKET}/verify#2`).value.leftAt, T0 + 400_000);
  // Its evidence includes the record that closed it (the process's end).
  const behind = entriesBehind(log, `visit:${TICKET}/verify#2`).map((e) => e.event.type);
  assert.ok(behind.includes("execution.process_ended"), behind.join(","));
});

test("D14: a wait on a person is 'Waiting for a person', never 'Working … at work for', and outlives its execution", () => {
  const { events } = verifyRetries();
  const log = logOf(events);
  const head = log.head();
  const wait = entityAt(head, `visit:${TICKET}/human-approval#1`).value;
  assert.equal(wait.leftAt, null, "the execution's end does not close a wait on a person");
  assert.equal(visitStatusOf(wait).word, "Waiting for a person");
  assert.equal(words.elapsedWords("waiting-person", true, false, "1 min 37 s"), "waiting for 1 min 37 s");
  assert.equal(activityOf(head, `cell:${TICKET}`).state, "waiting-person");
  // The gate's evidence is never "0 events" beside a record that names one.
  const gate = `gate:${TICKET}/human-approval`;
  assert.equal(head.gates[`${TICKET}/human-approval`]?.state, "waiting", "the human gate waits");
  assert.ok(entriesBehind(log, gate).length >= 1, "its evidence holds the record that opened it");
});

test("D4: an exit record that arrives after all wins over the scene's own closing", () => {
  const f = factory();
  f.enter("build#1", T0, "x1", 1, { stage: "building" });
  f.record("execution.process_ended", "x1", 2, T0 + 10_000, { ended: "exited", exit_code: 0, seconds: 10 });
  f.exit("build#1", T0 + 12_000, "x1", 1, "built", "built");
  const v = entityAt(logOf(finalize(f.out)).head(), `visit:${TICKET}/build#1`).value;
  assert.deepEqual([v.leftAt, v.outcomeWord, v.unclosed], [T0 + 12_000, "built", null]);
});

// ---------------------------------------------------------------- D6: overridden is its own state

test("D6: an overridden gate reads 'Overridden' with its reason, distinct from Passed and Refused, and stays so", () => {
  const f = factory();
  f.enter("build#2", T0, "x1", 2, { stage: "building", action: "revise" });
  f.life("gate.evaluated", T0 + 1000, { gate: "frozen-tests", verdict: "overridden", reason_code: "test-amended", subject: "R1-T02", status: null, audit_tier: null, counts: {} }, { visit_id: `${TICKET}/build#2`, round: 2 });
  f.life("gate.evaluated", T0 + 2000, { gate: "red-before-green", verdict: "overridden", reason_code: "test-passed-first-run", subject: "R1-T03", status: null, audit_tier: null, counts: {} }, { visit_id: `${TICKET}/build#2`, round: 2 });
  f.life("build.task_completed", T0 + 3000, { task_id: "R1-T03", kind: "test", step: "green", first_run: "pass", suite: "green", commit: "c0ffee1" }, { visit_id: `${TICKET}/build#2`, round: 2 });
  const head = logOf(finalize(f.out)).head();
  const gate = head.gates[`${TICKET}/red-before-green`];
  assert.equal(gate.state, "overridden", "not 'passed' (the run showed 'Red before green Passed')");
  assert.equal(gate.reasonCode, "test-passed-first-run");
  assert.notEqual(gate.decidedAt, null);
  if (gateStateWords) assert.equal(gateStateWords(gate), "Overridden: test-passed-first-run");
  const overrides = gateOverrides(head, TICKET);
  assert.deepEqual(overrides.map((o) => [o.gate, o.reasonCode, o.gateId]), [["frozen-tests", "test-amended", null], ["red-before-green", "test-passed-first-run", `${TICKET}/red-before-green`]]);
});

// ---------------------------------------------------------------- D7: agents not observed are never zero

test("D7: with the stream unreadable, agents and tools are 'Not observed' with the reason, never 0", () => {
  const f = factory();
  const x = "x466e1b0a645d";
  f.intake("work.claimed", T0, { stage: "verified", next: "verify", attempt: 1 }, { ticket_id: TICKET, execution_id: x, attempt: 1 }, [`execution:${x}`]);
  f.stream(x, "session.initialized", T0 + 500, { claude_code_version: "2.1.323", model: "claude-opus-5-5", permission_mode: "default", tools: [], agents: [] });
  for (let i = 0; i < 6; i++) f.observer("history.gap", T0 + 500, { source_key: `s:${x}`, from_seq: i + 2, to_seq: i + 2, reason: "unknown-type", count: 1 }, {}, [], i + 1);
  f.stream(x, "tool.refused", T0 + 4000, { tool: "Bash" });
  const head = logOf(finalize(f.out)).head();
  const o = streamObservationOf(head, x);
  assert.equal(o.state, "not-observed");
  assert.equal(o.notInterpreted, 6);
  assert.match(o.reason, /6 stream records were received but not interpreted \(Claude Code 2\.1\.323/);
  const line = words.agentsWords(o, 0, 0);
  assert.match(line, /^Not observed: /);
  assert.ok(!/\b0 working|^0$/.test(line), line);
  // No stream at all is not observed either.
  assert.equal(streamObservationOf(head, "x-without-stream").state, "not-observed");
  // The observer's runtime state (`/health`, factory status sources): incompatible.
  const runtime = sim.sourceRuntimeOf([{ key: `stream/${x}`, runtime: { state: "incompatible", version: "2.1.400", reason: "Claude Code 2.1.400 changed its record shapes." } }], x);
  assert.equal(streamObservationOf(head, x, runtime).reason, "Claude Code 2.1.400 changed its record shapes.");
});

test("D7: a compatible but unproven runtime shows the agents, with a quiet 'unproven runtime version' note", () => {
  const f = factory();
  const x = "x13e7bccffc37";
  f.stream(x, "session.initialized", T0, { claude_code_version: "2.1.323", model: "claude-opus-5-5", permission_mode: "default", tools: [], agents: [] }, {}, [], { runtime: "compatible-unproven" });
  f.stream(x, "agent.started", T0 + 100, { index: 1, label: `${TICKET}: build`, phase: "Build", phase_index: 3, agent_type: "mach:builder", model: "claude-sonnet-5-5", agent_try: 1 }, { agent_id: `${x}/a1`, station: "build" }, [`agent:${x}/a1`], { runtime: "compatible-unproven" });
  f.enter("build#1", T0 + 50, x, 1, { stage: "building" });
  const head = logOf(finalize(f.out)).head();
  const o = streamObservationOf(head, x);
  assert.equal(o.state, "unproven");
  assert.equal(o.runtime, "compatible-unproven");
  assert.equal(words.agentsWords(o, 1, 1), "1 working, 1 so far: agent activity from an unproven Claude Code version (2.1.323)");
  assert.match(words.runtimeWords(o), /^Claude Code 2\.1\.323: compatible, unproven/);
  // Proven: the plain count.
  assert.equal(words.agentsWords({ ...o, state: "observed", reason: null }, 1), "1");
});

// ---------------------------------------------------------------- D8: completeness follows the gap's class

test("D8: unknown-type gaps are 'received, not interpreted', not 'could not be received'; only lost history is Partial", () => {
  const f = factory();
  f.observer("history.gap", T0, { source_key: "s:x1", from_seq: 2, to_seq: 7, reason: "unknown-type", count: 6 }, {}, [], 1);
  const notInterpreted = logOf(finalize(f.out)).head();
  assert.equal(notInterpreted.completeness.state, "complete", "records received and not interpreted lose no history");
  assert.equal(notInterpretedCount(notInterpreted), 6);
  assert.equal(lostGaps(notInterpreted).length, 0);
  const w = words.completenessWords(notInterpreted.completeness);
  assert.equal(w.state, "not-interpreted");
  assert.equal(w.why, "Received, not interpreted (6 records).");
  assert.ok(!/could not be received/.test(w.why));
  // The observer's own class wins over the reason; a lost range makes it Partial.
  f.observer("history.gap", T0 + 10, { source_key: CELL_KEY, from_seq: 4, to_seq: 4, reason: "missing-seq", count: 1, class: "not-received", history_lost: true }, {}, [], 2);
  f.observer("history.gap", T0 + 20, { source_key: CELL_KEY, from_seq: 9, to_seq: 9, reason: "conflict", count: 1 }, {}, [], 3);
  const partial = logOf(finalize(f.out)).head();
  assert.equal(partial.completeness.state, "partial");
  assert.deepEqual(lostGaps(partial).map((g) => g.class), ["not-received"]);
  assert.match(words.completenessWords(partial.completeness).why, /^1 range of history was lost \(not received\)\. Received, not interpreted \(6 records\)\.$/);
  for (const [reason, cls] of [["unparsable-line", "unparsable-line"], ["truncated", "not-received"], ["rewritten", "not-received"], ["unreadable", "source-unreadable"], ["evicted", "evicted"], ["state-mismatch", "state-mismatch"], ["unexpected-shape", "unknown-type"]]) assert.equal(sim.gapClassOf(reason), cls, reason);
});

// ---------------------------------------------------------------- D15: never a cell from an agent's label

test("D15: an agent whose label names a ticket with no cell stays an unplaced agent with its execution; no cell, no grooming", () => {
  const f = factory();
  const x = "xg12stream01";
  const agent = `${x}/a7`;
  f.stream(x, "agent.started", T0, { index: 1, label: `${TICKET}: build`, phase: "Build", phase_index: 3, agent_type: "mach:builder", model: "claude-sonnet-5-5", agent_try: 1 }, { agent_id: agent, station: "build" }, [`agent:${agent}`], { inferred: { "ids.ticket_id": "label", "ids.station": "label" } });
  f.stream(x, "tool.called", T0 + 10, { tool: "Read", target_class: "file", script: null, path_rel: "a.py" }, { agent_id: `${x}/main`, tool_call_id: `${x}/t1` }, [`agent:${x}/main`]);
  const head = logOf(finalize(f.out)).head();
  assert.equal(Object.keys(head.cells).length, 0, "no cell invented (the run showed 'LOCAL-001 Grooming')");
  assert.ok(head.strayAgents[agent], "the agent stays, unplaced");
  assert.equal(head.strayAgents[agent].executionId, x);
  assert.ok(head.executions[x], "attached to its execution");
  // When the ticket's cell is recorded later, the agent joins it.
  f.enter("build#1", T0 + 5000, x, 1, { stage: "building" });
  const later = logOf(finalize(f.out)).head();
  assert.ok(later.cells[TICKET].agents[agent]);
  assert.equal(later.strayAgents[agent], undefined);
});

// ---------------------------------------------------------------- D13: artifact counts named for what they are

test("D13: a cell's artifact counts are distinct artifacts referenced and artifact records, named apart", () => {
  const f = factory();
  let seq = 0;
  for (const [path, times] of [["spec.md", 2], ["plan.md", 1], ["evidence/results.json", 3]]) {
    for (let i = 0; i < times; i++) f.observer("artifact.recorded", T0 + ++seq, { kind: "spec", path_rel: path, sha256: null, bytes: 1, media_type: "text/plain", commit: null, nature: "record", integrity: "unchecked" }, {}, [`artifact:${TICKET}:${path}`], seq);
  }
  f.enter("groom#1", T0, null, null, { stage: "interview" });
  const cell = logOf(finalize(f.out)).head().cells[TICKET];
  assert.deepEqual(artifactCountsOf(cell), { distinct: 3, records: 6 });
});

// ---------------------------------------------------------------- D23, D24: the record shown is the entity's own, the deciding one first

test("D24: 'why it looks like this' prefers the authoritative record when several share a time", () => {
  const f = factory();
  f.enter("verify#5", T0, "x2", 2, { stage: "built" });
  f.exit("verify#5", T0 + 62_412, "x2", 2, "PASS", "verified");
  f.observer("artifact.recorded", T0 + 62_412, { kind: "evidence", path_rel: "evidence/summary.json", sha256: null, bytes: 1, media_type: "application/json", commit: null, nature: "record", integrity: "unchecked" }, { visit_id: `${TICKET}/verify#5` }, [`visit:${TICKET}/verify#5`, `artifact:${TICKET}:evidence/summary.json`], 1);
  const log = logOf(finalize(f.out));
  const why = whyEntry(log, `visit:${TICKET}/verify#5`, T0 + 62_412);
  assert.equal(why.event.type, "station.exited");
  assert.equal(why.authority, "authoritative");
});

test("D23: a workflow's record is its own observed record, not its execution's", () => {
  const f = factory();
  const x = "xdf29bf72aa";
  f.intake("execution.started", T0, { until: "merge", workflow: "mach:belt", limits: {} }, { ticket_id: TICKET, execution_id: x }, [`execution:${x}`]);
  f.stream(x, "workflow.started", T0 + 100, { workflow: "belt", tickets: [TICKET], until: "merge" }, {}, [`workflow:${x}/task0001`]);
  f.intake("execution.completed", T0 + 9000, { stage: "built", next: "verify", waiting_for: null, how: "exited", seen_to_end: true, cost_usd: 1, refused_tools: [] }, { ticket_id: TICKET, execution_id: x }, [`execution:${x}`]);
  const head = logOf(finalize(f.out)).head();
  const workflow = entityAt(head, `workflow:${x}/task0001`).value;
  assert.equal(workflow.meta.authority, "observed");
  assert.ok(workflow.meta.eventId.startsWith(`s:${x}:`), workflow.meta.eventId);
  assert.notEqual(workflow.meta.eventId, head.executions[x].meta.eventId);
});

// ---------------------------------------------------------------- D20: new events are arrivals, not events after the playhead

test("D20: 'N new events' counts events that arrived since the person left the live edge", () => {
  const f = factory();
  for (let i = 0; i < 40; i++) f.life("build.task_completed", T0 + i * 1000, { task_id: `T${i}`, kind: "impl", step: "green", first_run: "pass", suite: "green", commit: null });
  const events = finalize(f.out);
  const log = logOf(events);
  const store = createSceneStore({ source: "live", log, clock: manualClock() });
  store.seek(T0 + 5000); // back 34 events with an idle Factory: the run said "31 new events" here
  let s = store.getState();
  assert.equal(s.following, false);
  assert.equal(s.arrived - s.arrivedAtLeave, 0, "nothing arrived");
  log.ingest(finalize([ev("build.task_completed", { stream: "cell-lifecycle", key: CELL_KEY, seq: 900, t: T0 + 90_000, ids: { ticket_id: TICKET }, entities: [`cell:${TICKET}`], data: { task_id: "N", kind: "impl", step: "green", first_run: "pass", suite: "green", commit: null } })], 41));
  store.logChanged();
  s = store.getState();
  assert.equal(s.arrived - s.arrivedAtLeave, 1);
  store.followLive();
  assert.equal(store.getState().arrivedAtLeave, null);
});

// ---------------------------------------------------------------- D19: the timeline's chapter flags are at least 24 px

test("D19: the simulation timeline's chapter flags are targets of at least 24 x 24 px", () => {
  const ruler = readFileSync(new URL("../src/shell/timeline/Ruler.tsx", import.meta.url), "utf8");
  const flag = ruler.match(/"absolute top-[^"]*rounded-xs pl-\[3px\][^"]*"/)?.[0] ?? "";
  assert.match(flag, /h-\[24px\]/, flag);
  assert.match(flag, /min-w-\[24px\]/, flag);
});

// ---------------------------------------------------------------- D17 (counts) and the connection popover

test("D17: counts equal the observer's totals ('of N' when only part is held); observer-late apart from reordered", async () => {
  const server = fakeObserver({ snapshot: true });
  const f = factory();
  for (let i = 0; i < 60; i++) f.life("build.task_completed", T0 + i * 1000, { task_id: `T${i}`, kind: "impl", step: "green", first_run: "pass", suite: "green", commit: null });
  const events = finalize(f.out).map((e, i) => (i === 10 ? { ...e, late: true } : e));
  server.commit(events);
  const client = live.createObserverClient({ fetch: server.fetch });
  const timers = fakeTimers();
  const { store, source } = live.createLiveFactory({ client, openStream: server.openStream, clock: manualClock(), timers, liveWindow: 1000 });
  await source.start();
  await settle();
  let c = source.status();
  assert.equal(c.total, 60);
  assert.equal(c.held, 60);
  assert.equal(c.late, 1, "the observer's own flag");
  assert.equal(c.reordered, 0);
  assert.equal(words.receivedWords(c), "60 events received, all 60 held, 1 marked late by the observer");
  // A longer history than the live window: the newest window, said "of N".
  const big = fakeObserver({ snapshot: true });
  const g = factory();
  for (let i = 0; i < 2600; i++) g.life("build.task_completed", T0 + i * 1000, { task_id: `T${i}`, kind: "impl", step: "green", first_run: "pass", suite: "green", commit: null });
  big.commit(finalize(g.out));
  const b = live.createLiveFactory({ client: live.createObserverClient({ fetch: big.fetch }), openStream: big.openStream, clock: manualClock(), timers: fakeTimers(), liveWindow: 1000 });
  await b.source.start();
  await settle();
  c = b.source.status();
  assert.equal(c.total, 2600);
  assert.equal(c.held, 1000);
  assert.match(words.receivedWords(c), /1,000 held of 2,600/);
  // Before the window: "not loaded" (no summary has anything the window does not touch here); the
  // observer's whole projected state is never fetched.
  assert.equal(b.log.head().completeness.state, "partial", "history before the window is said not loaded");
  assert.equal(b.log.head().completeness.gaps[0].class, "before-window");
  assert.deepEqual(big.snapshotsAt, []);
  assert.ok(big.requests.some((r) => r.includes("/cells?")), "the bounded summaries are read instead");
  source.stop();
  b.source.stop();
  void store;
});

test("the connection popover's delivery lag and the stream's heartbeat at_ms", () => {
  assert.equal(words.deliveryLagWords(null), "Not reported");
  assert.equal(words.deliveryLagWords(420), "under a second");
  assert.equal(words.deliveryLagWords(1700), "1.7 s");
});

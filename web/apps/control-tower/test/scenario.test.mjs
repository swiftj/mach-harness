// Scenario invariants: the fixture is a faithful, complete, self-consistent MACH run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { SCENARIO, buildScenario, REAL_KINDS, SIM_KINDS, EVENT_CATALOG, NEXT_ACTIONS, STAGE_TRANSITIONS, MAX_ROUNDS, isoAt } = sim;
const events = SCENARIO.events;
const of = (type) => events.filter((e) => e.type === type);
const first = (pred) => events.find(pred);
const minutes = (t) => `${Math.floor(t / 60000)}:${String(Math.floor(t / 1000) % 60).padStart(2, "0")}`;

const ENVELOPE = ["schema_version", "seq", "at", "type", "project_id", "source_commit", "wave_id", "slice_id", "revision", "ticket_id", "runner_id", "execution_id", "source", "cause", "refs", "data"];

test("the scenario is deterministic: building it again gives the same bytes", () => {
  assert.equal(JSON.stringify(buildScenario()), JSON.stringify(SCENARIO));
});

test("every event has the factory-event v2 envelope, plus t", () => {
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), [...ENVELOPE, "t"].sort(), `seq ${e.seq}`);
    assert.equal(e.schema_version, 2);
    assert.ok(["intake", "engineer", "supervisor"].includes(e.source), `seq ${e.seq} source ${e.source}`);
    assert.equal(e.at, isoAt(e.t));
    assert.match(e.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(typeof e.data, "object");
  }
});

test("seq is strictly increasing by one and time never goes backwards", () => {
  events.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    if (i > 0) assert.ok(e.t >= events[i - 1].t, `seq ${e.seq} goes back in time`);
  });
});

test("causes point backwards; real kinds leave cause null, as MACH does today", () => {
  for (const e of events) {
    if (e.cause !== null) assert.ok(e.cause < e.seq, `seq ${e.seq} cause ${e.cause}`);
    if (REAL_KINDS.includes(e.type)) assert.equal(e.cause, null, `real kind ${e.type} seq ${e.seq} sets cause`);
  }
});

// The data fields each real emitter writes (intake.py, supervisor.py, activation.py).
const REAL_FIELDS = {
  "factory.activated": ["autonomy", "by", "limits", "allow_merge", "persistent", "backlog", "excluded_slices"],
  "wave.discovered": ["slices", "approval"],
  "intake.validated": ["digest"],
  "slice.materialized": ["digest", "adopted", "dependencies"],
  "slice.integrated": ["commit"],
  "dependency.resolved": ["depends_on"],
  "dependency.blocked": ["reasons"],
  "work.scheduled": ["stage", "risk", "branch", "by", "authorization"],
  "human.required": ["reason"],
  "revision.discovered": ["from_commit", "commit"],
  "scheduling.decided": ["state", "dispatched", "started", "held"],
  "work.claimed": ["stage", "next", "attempt"],
  "execution.started": ["session_id", "until", "workflow", "limits"],
  "station.observed": ["from_stage", "stage"],
  "execution.completed": ["stage", "next", "waiting_for", "how", "seen_to_end", "cost_usd", "session_id", "refused_tools"],
};

test("real kinds carry exactly the data fields their real emitter writes", () => {
  for (const e of events) {
    const fields = REAL_FIELDS[e.type];
    if (!REAL_KINDS.includes(e.type)) continue;
    assert.ok(fields, `no field list for real kind ${e.type}`);
    assert.deepEqual(Object.keys(e.data).sort(), [...fields].sort(), `${e.type} seq ${e.seq}`);
  }
});

test("every kind in the fixture is in the catalog", () => {
  for (const e of events) assert.ok(EVENT_CATALOG[e.type], e.type);
  const used = new Set(events.map((e) => e.type));
  for (const kind of SIM_KINDS) assert.ok(used.has(kind), `simulation kind ${kind} is defined but never used`);
});

test("every beat the contract asks for is present (section 4)", () => {
  // An approved wave arrives and becomes tickets.
  const wave = first((e) => e.type === "wave.discovered");
  assert.ok(wave);
  assert.equal(wave.data.slices.length, 5);
  assert.equal(of("slice.materialized").length, 5);
  // Scheduler decisions: runnable, waiting and why.
  assert.ok(of("dependency.blocked").some((e) => e.slice_id === "SLICE-024" && /SLICE-021/.test(e.data.reasons.join())));
  assert.ok(of("scheduling.decided").some((e) => e.data.dispatched.length === 3));
  // A Dynamic Workflow starting.
  assert.ok(of("workflow.started").length >= 4);
  // Three construction cells in parallel: three cells with a running agent at the same moment.
  assert.ok(maxConcurrent((e) => e.ticket_id) >= 3, "three cells were never active at once");
  // Several agents at once; tool activity and artifacts.
  assert.ok(maxConcurrentAgents() >= 5, `at most ${maxConcurrentAgents()} agents ran at once`);
  assert.ok(of("tool.started").length > 300);
  assert.ok(of("artifact.written").length > 100);
  // A build progressing to success, test-first.
  assert.ok(of("task.red").length >= 10 && of("task.green").length >= 10);
  // Verification with results; one failure that returns to build, then passes.
  const fail = first((e) => e.type === "verification.verdict" && e.data.status === "FAIL_WITH_EVIDENCE");
  assert.ok(fail, "no failed verification");
  const back = first((e) => e.type === "build.revised" && e.ticket_id === fail.ticket_id && e.data.because === "verification");
  assert.ok(back && back.seq > fail.seq, "the failed verification did not return to build");
  assert.ok(of("verification.verdict").some((e) => e.ticket_id === fail.ticket_id && e.data.status === "PASS" && e.seq > back.seq));
  assert.ok(of("evidence.captured").some((e) => e.data.result === "fail"));
  // Reviewer fan-out with findings, an outvoted blocker and a rejecting blocker.
  assert.ok(of("review.vote").length >= 9);
  assert.ok(of("review.decided").some((e) => e.data.overruled_blockers_from.length > 0), "no outvoted blocker");
  assert.ok(of("review.decided").some((e) => e.data.outcome === "REJECTED" && e.data.blockers > 0), "no rejected round");
  assert.ok(of("review.finding").some((e) => e.data.severity === "note"));
  // A required human approval, by a named person.
  const gate = first((e) => e.type === "review.decided" && e.data.outcome === "AWAITING_HUMAN");
  assert.ok(gate);
  assert.ok(of("human.required").some((e) => e.ticket_id === gate.ticket_id && e.seq > gate.seq));
  const approval = first((e) => e.type === "human.approval_recorded" && e.ticket_id === gate.ticket_id);
  assert.ok(approval && approval.data.by.split(" ").length >= 2 && approval.source === "engineer");
  // Integration of finished work, with revalidation.
  assert.ok(of("merge.completed").length >= 3);
  assert.ok(of("merge.revalidated").some((e) => e.data.needed));
  assert.ok(of("slice.integrated").length >= 3);
  assert.ok(of("cleanup.completed").length >= 3);
  // A dependency-blocked slice becomes eligible and is dispatched.
  assert.ok(first((e) => e.type === "dependency.resolved" && e.slice_id === "SLICE-024"));
  assert.ok(first((e) => e.type === "work.scheduled" && e.slice_id === "SLICE-024"));
});

test("factory time is in the tens of minutes, with busy and quiet stretches", () => {
  assert.ok(SCENARIO.duration > 30 * 60000 && SCENARIO.duration < 90 * 60000, minutes(SCENARIO.duration));
  // Busy: some minute has more than 60 events. Quiet: some minute after the start has fewer than 10.
  const perMinute = new Map();
  for (const e of events) perMinute.set(Math.floor(e.t / 60000), (perMinute.get(Math.floor(e.t / 60000)) ?? 0) + 1);
  const counts = [...Array(Math.ceil(SCENARIO.duration / 60000)).keys()].map((m) => perMinute.get(m) ?? 0);
  assert.ok(Math.max(...counts) > 60, `busiest minute has ${Math.max(...counts)} events`);
  assert.ok(counts.slice(2).some((n) => n < 10), "no quiet minute");
});

test("every agent that starts either finishes once, after it started, or is still running at the end", () => {
  const started = new Map();
  for (const e of of("agent.started")) {
    assert.ok(!started.has(e.data.agent_id), `${e.data.agent_id} started twice`);
    started.set(e.data.agent_id, e);
  }
  const finished = new Set();
  for (const e of of("agent.finished")) {
    const s = started.get(e.data.agent_id);
    assert.ok(s && s.seq < e.seq, `${e.data.agent_id} finished before starting`);
    assert.ok(!finished.has(e.data.agent_id), `${e.data.agent_id} finished twice`);
    finished.add(e.data.agent_id);
  }
  const running = [...started.keys()].filter((id) => !finished.has(id));
  // Only LOCAL-034's execution is still at work when the scenario ends.
  for (const id of running) assert.equal(started.get(id).ticket_id, "LOCAL-034", `${id} never finished`);
  // A sub-agent's parent is running when it starts.
  for (const e of of("agent.started")) {
    if (!e.data.parent_agent_id) continue;
    assert.ok(started.get(e.data.parent_agent_id)?.seq < e.seq);
    assert.ok(!finished.has(e.data.parent_agent_id) || of("agent.finished").find((f) => f.data.agent_id === e.data.parent_agent_id).seq > e.seq);
  }
});

test("no tool call happens outside a running agent, and every call returns", () => {
  const live = new Set();
  const calls = new Map();
  for (const e of events) {
    if (e.type === "agent.started") live.add(e.data.agent_id);
    if (e.type === "agent.finished") {
      assert.ok(![...calls.values()].some((c) => c.agent === e.data.agent_id && c.open), `${e.data.agent_id} finished with a call open`);
      live.delete(e.data.agent_id);
    }
    if (e.type === "tool.started") {
      assert.ok(live.has(e.data.agent_id), `tool call ${e.data.call_id} by ${e.data.agent_id}, who is not running`);
      assert.ok(!calls.has(e.data.call_id));
      calls.set(e.data.call_id, { agent: e.data.agent_id, open: true });
    }
    if (e.type === "tool.finished") {
      const call = calls.get(e.data.call_id);
      assert.ok(call && call.open && call.agent === e.data.agent_id, `tool.finished ${e.data.call_id} without a start`);
      call.open = false;
    }
  }
  assert.ok([...calls.values()].every((c) => !c.open), "a tool call never returned");
});

test("every artifact has a writer, and an agent writer was at work when it was written", () => {
  const liveAgents = new Set();
  const openCalls = new Set();
  for (const e of events) {
    if (e.type === "agent.started") liveAgents.add(e.data.agent_id);
    if (e.type === "agent.finished") liveAgents.delete(e.data.agent_id);
    if (e.type === "tool.started") openCalls.add(e.data.call_id);
    if (e.type === "tool.finished") openCalls.delete(e.data.call_id);
    if (e.type !== "artifact.written") continue;
    const w = e.data.writer;
    assert.ok(w.agent_id || w.script, `artifact ${e.data.artifact_id} has no writer`);
    if (w.agent_id) assert.ok(liveAgents.has(w.agent_id), `${e.data.artifact_id}: writer ${w.agent_id} not running`);
    if (w.call_id) assert.ok(openCalls.has(w.call_id), `${e.data.artifact_id}: call ${w.call_id} not in flight`);
  }
});

test("stations follow run.py's table, and stages change only as the station scripts change them", () => {
  const stage = new Map(); // ticket -> stage (absent: no cell)
  const archived = new Set();
  for (const e of events) {
    if (e.type === "cell.stage_changed") {
      const from = stage.get(e.ticket_id) ?? null;
      assert.equal(e.data.from, from, `seq ${e.seq}: from ${e.data.from}, but the cell was ${from}`);
      assert.ok(STAGE_TRANSITIONS.some((x) => x.from === from && x.to === e.data.to), `illegal stage change ${from} -> ${e.data.to} (seq ${e.seq})`);
      stage.set(e.ticket_id, e.data.to);
    }
    if (e.type === "cleanup.completed") archived.add(e.ticket_id);
    if (e.type === "station.entered") {
      const now = archived.has(e.ticket_id) ? "none" : stage.get(e.ticket_id) ?? "none";
      assert.ok(NEXT_ACTIONS[now].includes(e.data.action), `${e.ticket_id} entered ${e.data.station} (${e.data.action}) at stage ${now}, seq ${e.seq}`);
      assert.equal(e.data.stage ?? "none", now === "none" ? "none" : now);
    }
  }
  // Product slices are never groomed again: the first station is plan.
  for (const ticket of new Set(of("station.entered").map((e) => e.ticket_id))) {
    assert.equal(of("station.entered").find((e) => e.ticket_id === ticket).data.station, "plan");
  }
});

test("a station is left before the next is entered, and stations alternate with 'what next?'", () => {
  const at = new Map();
  for (const e of events) {
    if (e.type === "station.entered") {
      assert.ok(!at.get(e.ticket_id), `${e.ticket_id} entered ${e.data.station} while still at ${at.get(e.ticket_id)}`);
      at.set(e.ticket_id, e.data.station);
    }
    if (e.type === "station.left") {
      assert.equal(at.get(e.ticket_id), e.data.station);
      at.set(e.ticket_id, null);
    }
  }
});

test("review rounds never exceed three, are numbered by judging round, and the first review after a failed verification is round 2", () => {
  for (const e of [...of("review.started"), ...of("review.decided"), ...of("build.revised"), ...of("verification.verdict")]) {
    assert.ok(e.data.round >= 1 && e.data.round <= MAX_ROUNDS, `${e.type} round ${e.data.round}`);
  }
  const failed = first((e) => e.type === "verification.verdict" && e.data.status === "FAIL_WITH_EVIDENCE");
  const firstReview = first((e) => e.type === "review.started" && e.ticket_id === failed.ticket_id);
  assert.equal(firstReview.data.round, 2);
  assert.equal(firstReview.data.delta, null, "no earlier review packet, so no delta");
  // A round after a rejected review is a delta review.
  const rejected = first((e) => e.type === "review.decided" && e.data.outcome === "REJECTED");
  const after = first((e) => e.type === "review.started" && e.ticket_id === rejected.ticket_id && e.seq > rejected.seq);
  assert.ok(after.data.delta && after.data.delta.earlier_blocker_files.length > 0);
});

test("votes follow from findings, and the decision follows review.py's rules", () => {
  for (const decided of of("review.decided")) {
    const started = of("review.started").find((e) => e.ticket_id === decided.ticket_id && e.data.round === decided.data.round);
    const votes = of("review.vote").filter((e) => e.ticket_id === decided.ticket_id && e.data.round === decided.data.round);
    const findings = of("review.finding").filter((e) => e.ticket_id === decided.ticket_id && e.data.round === decided.data.round);
    assert.equal(votes.length, started.data.panel.length, "every seat votes");
    for (const vote of votes) {
      const blockers = findings.filter((f) => f.data.seat === vote.data.seat && f.data.severity === "blocker").length;
      assert.equal(vote.data.vote, blockers ? "REJECT" : "APPROVE");
      assert.equal(vote.data.model, started.data.risk === "High" ? "opus" : "sonnet");
    }
    for (const f of findings.filter((x) => x.data.severity === "blocker")) assert.ok(f.data.rule && f.data.file, "a blocker names a rule and a file");
    const approvals = votes.filter((v) => v.data.vote === "APPROVE").length;
    const veto = findings.some((f) => f.data.seat === "security" && f.data.severity === "blocker");
    const pass = approvals >= started.data.approvals_needed && !veto;
    const expected = pass ? (started.data.human_approval_required ? "AWAITING_HUMAN" : "APPROVED") : decided.data.round >= MAX_ROUNDS ? "ESCALATE" : "REJECTED";
    assert.equal(decided.data.outcome, expected, `${decided.ticket_id} round ${decided.data.round}`);
  }
});

test("a dependency-blocked slice is never dispatched before what it waits for is merged and integrated", () => {
  for (const scheduled of of("work.scheduled")) {
    const deps = SCENARIO.definitions.slices[scheduled.slice_id].dependencies;
    for (const dep of deps) {
      const integrated = first((e) => e.type === "slice.integrated" && e.slice_id === dep);
      const merged = first((e) => e.type === "merge.completed" && e.slice_id === dep);
      assert.ok(merged && integrated, `${scheduled.slice_id} dispatched although ${dep} never merged`);
      assert.ok(merged.seq < integrated.seq && integrated.seq < scheduled.seq, `${scheduled.slice_id} dispatched before ${dep} was integrated`);
    }
  }
  // SLICE-025 waits on SLICE-024, which never lands in this run: never dispatched.
  assert.ok(!of("work.scheduled").some((e) => e.slice_id === "SLICE-025"));
});

test("High risk stops at the human gate: no merge before a person approves", () => {
  const approval = first((e) => e.type === "human.approval_recorded");
  const merged = first((e) => e.type === "merge.completed" && e.ticket_id === approval.ticket_id);
  assert.ok(merged.seq > approval.seq);
  // Its first execution ended at the gate; a second one, started after the approval, merged it.
  const executions = of("execution.started").filter((e) => e.ticket_id === approval.ticket_id);
  assert.equal(executions.length, 2);
  assert.ok(executions[1].seq > approval.seq);
  const firstEnd = first((e) => e.type === "execution.completed" && e.execution_id === executions[0].execution_id);
  assert.equal(firstEnd.data.waiting_for, "human-approval");
});

test("merges are commit-bound: a revalidated merge lands the revalidated head; the first merge needed none", () => {
  const merges = of("merge.completed");
  assert.equal(merges[0].data.revalidated, false);
  for (const m of merges) {
    const r = first((e) => e.type === "merge.revalidated" && e.ticket_id === m.ticket_id);
    assert.equal(r.data.approved_commit, m.data.approved_commit);
    assert.equal(m.data.landed_commit, r.data.needed ? r.data.head : m.data.approved_commit);
  }
});

test("supervisor records land on its 60-second ticks", () => {
  const tickKinds = ["station.observed", "execution.completed", "slice.integrated", "human.required", "work.claimed", "scheduling.decided", "dependency.resolved"];
  for (const e of events.filter((x) => tickKinds.includes(x.type))) {
    const intoTick = (e.t - 30000) % 60000;
    assert.ok(e.t >= 30000 && intoTick < 8000, `${e.type} seq ${e.seq} at ${minutes(e.t)} is not on a tick`);
  }
});

function maxConcurrentAgents() {
  let live = 0;
  let best = 0;
  for (const e of events) {
    if (e.type === "agent.started") best = Math.max(best, ++live);
    if (e.type === "agent.finished") live--;
  }
  return best;
}

function maxConcurrent() {
  const live = new Map();
  let best = 0;
  for (const e of events) {
    if (e.type === "agent.started") live.set(e.data.agent_id, e.ticket_id);
    if (e.type === "agent.finished") live.delete(e.data.agent_id);
    best = Math.max(best, new Set(live.values()).size);
  }
  return best;
}

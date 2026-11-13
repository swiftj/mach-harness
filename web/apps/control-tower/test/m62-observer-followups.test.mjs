// M6.1/M6.2 follow-ups after the observer's M6.2 update (commit 0cf50ec): a cell idle between two
// executions, bays kept across history windows, the observer's new fields (history completeness,
// runtime states, plan facts, evidence visit links) and a bounded start on a long history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const { createSceneLog, provenance, activityOf, bayOrder } = sim;
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

function factory() {
  let iseq = 0;
  let cseq = 0;
  const rseq = {};
  const out = [];
  const intake = (type, t, data, ids = {}, entities = []) => out.push(ev(type, { stream: "intake-log", key: "i:df29bf72", seq: ++iseq, t, precision: "s", ids, entities, data }));
  const life = (type, t, data, ids = {}, entities = []) => out.push(ev(type, { stream: "cell-lifecycle", key: CELL_KEY, seq: ++cseq, t, ids: { ticket_id: TICKET, ...ids }, entities: [`cell:${TICKET}`, ...entities], data }));
  const record = (type, x, t, data = {}) => {
    rseq[x] = (rseq[x] ?? 0) + 1;
    out.push(ev(type, { stream: "execution-record", key: `x:${x}`, seq: rseq[x], t, precision: "s", ids: { ticket_id: TICKET, execution_id: x }, entities: [`execution:${x}`, `cell:${TICKET}`], data }));
  };
  const claim = (x, t, next = "build", stage = "planned") => {
    intake("work.claimed", t, { stage, next, attempt: 1 }, { ticket_id: TICKET, slice_id: SLICE, execution_id: x, attempt: 1 }, [`execution:${x}`, `cell:${TICKET}`]);
    intake("execution.started", t + 100, { until: "merge", workflow: "mach:belt", limits: {} }, { ticket_id: TICKET, slice_id: SLICE, execution_id: x }, [`execution:${x}`, `cell:${TICKET}`]);
    record("execution.process_started", x, t + 200);
  };
  const enter = (visit, t, x, round = 1, stage = null) => {
    const station = visit.split("#")[0];
    life("station.entered", t, { station, stage, action: station, resumed: false, unclosed_visit: null, head: null, counts: {} }, { visit_id: `${TICKET}/${visit}`, station, round, ...(x ? { execution_id: x } : {}) }, [`station:${TICKET}/${station}`, `visit:${TICKET}/${visit}`]);
  };
  const exit = (visit, t, x, outcome, stage, round = 1, extra = {}) => {
    const station = visit.split("#")[0];
    life("station.exited", t, { station, outcome, stage, duration_ms: 1000, closed_by: null, head: null, counts: {}, ...extra }, { visit_id: `${TICKET}/${visit}`, station, round, ...(x ? { execution_id: x } : {}) }, [`station:${TICKET}/${station}`, `visit:${TICKET}/${visit}`]);
  };
  const completed = (x, t, stage, next, waitingFor = null) =>
    intake("execution.completed", t, { stage, next, waiting_for: waitingFor, how: "exited", seen_to_end: true, cost_usd: 0.5, refused_tools: [] }, { ticket_id: TICKET, slice_id: SLICE, execution_id: x }, [`execution:${x}`, `cell:${TICKET}`]);
  intake("work.scheduled", T0 - 5_000, { stage: "planned", risk: "Medium", branch: `feature/${TICKET}`, by_role: "supervisor", authorization: "runner" }, { slice_id: SLICE, ticket_id: TICKET }, [`slice:${SLICE}`, `cell:${TICKET}`]);
  return { out, intake, life, record, claim, enter, exit, completed };
}

// ---------------------------------------------------------------- task 3: a cell between two executions

const X1 = "x13e7bccffc37";
const X2 = "x466e1b0a645d";

function twoExecutions({ unattributed = false, waitingFor = null } = {}) {
  const f = factory();
  f.claim(X1, T0);
  f.enter("build#1", T0 + 10_000, unattributed ? null : X1, 1, "building");
  if (!unattributed) f.exit("build#1", T0 + 60_000, X1, "built", "built");
  f.record("execution.process_ended", X1, T0 + 70_000, { ended: "exited", exit_code: 0, seconds: 70 });
  f.completed(X1, T0 + 80_000, unattributed ? "building" : "built", "verify", waitingFor);
  f.claim(X2, T0 + 200_000, "verify", "built");
  f.enter("verify#1", T0 + 210_000, X2, 1, "built");
  return finalize(f.out);
}

test("activityOf: a cell idle between two executions is not 'executing'; it says what its last execution recorded", () => {
  const log = logOf(twoExecutions());
  // The process has ended, the supervisor has not recorded the outcome yet: before the fix the
  // execution's "running" state made the cell "executing" (drawn "Working").
  const ended = activityOf(log.sceneAt(T0 + 75_000), `cell:${TICKET}`);
  assert.equal(ended.state, "unknown");
  assert.match(ended.reason, /process ended/);
  assert.match(ended.reason, /No execution is running/);
  assert.equal(ended.between.outcomeRecorded, false);
  assert.equal(ended.between.endedAt, T0 + 70_000);

  // Between the two executions: idle, with the last one's recorded end, stage and next step.
  const idle = activityOf(log.sceneAt(T0 + 150_000), `cell:${TICKET}`);
  assert.equal(idle.state, "unknown");
  assert.match(idle.reason, /^Idle between executions: the last one ended at built\. The next step recorded is verify\./);
  assert.deepEqual({ ...idle.between }, { executionId: X1, endedAt: T0 + 80_000, stage: "built", next: "verify", waitingFor: null, outcomeRecorded: true });
  assert.equal(idle.since, T0 + 80_000);
  // A lost connection never turns idle into "executing" or "stale" (it was not executing).
  assert.equal(activityOf(log.sceneAt(T0 + 150_000), `cell:${TICKET}`, { stale: true }).state, "unknown");

  // The next execution is claimed and at work: executing again.
  assert.equal(activityOf(log.sceneAt(T0 + 200_050), `cell:${TICKET}`).state, "executing");
  const working = activityOf(log.sceneAt(T0 + 215_000), `cell:${TICKET}`);
  assert.equal(working.state, "executing");
  assert.equal(working.between, undefined);
});

test("activityOf: a station visit with no execution named, left open when the execution ended, is not work going on", () => {
  const log = logOf(twoExecutions({ unattributed: true }));
  const scene = log.sceneAt(T0 + 150_000);
  // The visit names no execution, so the execution's end does not close it: the cell is still "at build".
  assert.equal(scene.cells[TICKET].station, "build");
  const a = activityOf(scene, `cell:${TICKET}`);
  assert.notEqual(a.state, "executing", "before the fix: executing, 'At build.'");
  assert.equal(a.between.executionId, X1);
  // While the execution ran, the same open visit was work.
  assert.equal(activityOf(log.sceneAt(T0 + 30_000), `cell:${TICKET}`).state, "executing");
});

test("activityOf: an execution that stopped waiting for a person leaves the cell waiting for a person", () => {
  const log = logOf(twoExecutions({ waitingFor: "a person to resolve the open questions" }));
  const a = activityOf(log.sceneAt(T0 + 150_000), `cell:${TICKET}`);
  assert.equal(a.state, "waiting-person");
  assert.match(a.reason, /waiting for a person to resolve the open questions/);
});

test("activityOf: the simulation's reading is unchanged (a cell at a station is at work)", () => {
  const { finalScene, SCENARIO } = sim;
  const scene = finalScene(SCENARIO.fixture ?? SCENARIO);
  for (const cell of Object.values(scene.cells)) {
    const a = activityOf(scene, `cell:${cell.ticketId}`);
    assert.equal(a.between, undefined, "no 'between executions' in the simulation");
  }
});

// ---------------------------------------------------------------- task 4: bays kept across history windows

import { beltRun } from "./fixtures/v3.mjs";
import { fakeObserver, settle } from "./fixtures/observer.mjs";
const { manualClock } = await import("../src/scene/clock.ts");
const hex = (n, w) => n.toString(16).padStart(w, "0");

test("bays: a ticket keeps its Atlas bay whichever history window holds the playhead; selection is kept", async () => {
  // Six belts an hour apart: each window of the replay holds a different few.
  const events = [];
  for (let n = 1; n <= 6; n++) {
    const run = beltRun({ ticket: `LOCAL-${hex(n, 4)}`, slice: `SLICE-${hex(n, 4)}`, wave: `WAVE-${hex(n, 3)}`, execution: `x${hex(n, 12)}`, intakeGen: hex(n, 8), cellGen: hex(n * 7919, 8).slice(-8), t0: T0 + n * 3_600_000 });
    events.push(...run.events);
  }
  const server = fakeObserver({ series: true });
  server.commit(finalize(events));
  const client = live.createObserverClient({ fetch: server.fetch });
  const { store, windows } = await live.createReplay(client, { clock: manualClock(), windowEvents: 500, keep: 2 });
  const until = async (cond) => {
    for (let i = 0; i < 400 && !cond(); i++) await settle(2);
  };
  const span = windows.span();
  assert.ok(span && span.end - span.start > span.windowMs * 3, "several windows");
  const seen = new Map();
  const logs = new Set();
  const visit = async (at) => {
    store.seek(at);
    await until(() => !store.getState().windowLoading);
    const st = store.getState();
    logs.add(st.log);
    const order = bayOrder(st.log);
    order.slots.forEach((slot, i) => {
      if (seen.has(slot.ticketId)) assert.equal(i, seen.get(slot.ticketId), `${slot.ticketId} keeps bay ${seen.get(slot.ticketId)} at ${at}`);
      else seen.set(slot.ticketId, i);
    });
    return order;
  };
  // Forward, then a jump to the end, then back to the start (windows evicted and re-read: keep is 2).
  const points = [0.05, 0.3, 0.55, 0.95, 0.75, 0.1, 0.5].map((f) => span.start + f * (span.end - span.start));
  store.select("cell:LOCAL-0001");
  for (const at of points) {
    await visit(at);
    assert.equal(store.getState().selection, "cell:LOCAL-0001", "selection is kept across windows");
  }
  assert.ok(logs.size >= 3, `several window logs were shown (${logs.size})`);
  assert.ok(seen.size >= 6, `every ticket got a bay (${seen.size})`);
  // A window that has not seen a later ticket still draws the bays it was given (none moves, none goes).
  const first = await visit(points[0]);
  assert.equal(first.slots.length, seen.size);
  // Logs of another history (another replay) have bays of their own.
  const other = await live.createReplay(client, { clock: manualClock(), windowEvents: 500 });
  await until(() => !other.store.getState().windowLoading);
  assert.notEqual(bayOrder(other.store.getState().log), first);
  store.dispose();
  other.store.dispose();
});

// ---------------------------------------------------------------- task 1: the observer's new fields

/** A fetch answering with the observer's own shapes (field names as apps/observer/internal writes them). */
function observerShapes(routes) {
  return async (url) => {
    const path = new URL(url, "http://127.0.0.1").pathname.replace(/^\/api\/v1/, "");
    const data = routes[path];
    return data === undefined ? { status: 404, json: async () => ({ ok: false, error: { kind: "not_found", message: "no" } }) } : { status: 200, json: async () => ({ ok: true, data }) };
  };
}

const HISTORY = { completeness: "partial", partial: "", lost: { evicted: 1, "not-received": 2 }, not_interpreted: { "unknown-type": 17 }, classes: { evicted: 1, "not-received": 2, "unknown-type": 17, conflict: 1 }, gaps: { "missing-seq": 2, "unknown-type": 17 }, not_v3: 0 };
const RUNTIME = { policy: "structural", proven_versions: ["2.1.322", "2.1.323"], state: "compatible-unproven", versions: [{ version: "2.1.324", state: "compatible-unproven", executions: 2, records_refused: 0 }] };

test("observer client: history completeness, runtime states, plan facts and evidence visit links, by the observer's own field names", async () => {
  const client = live.createObserverClient({
    fetch: observerShapes({
      "/session": { generation: "g1", versions: { event: { schema: 3, revision: 2, kinds: [] } }, capabilities: { snapshot: true, stream_observations: { policy: "structural", ok: true, claude_code_version: "2.1.324", state: "compatible-unproven", proven_versions: ["2.1.322", "2.1.323"], versions: RUNTIME.versions, reason: "observed on a Claude Code version the fixtures do not come from; every record matched the known shapes" } }, project: { folder: "eng" } },
      "/health": {
        status: "ok",
        index: { generation: "g1", head: "g1.230853", floor: "g1.0" },
        projection: { pos: 230853, history: HISTORY },
        ingest: { runtime: RUNTIME, delivery: { last_hold_ms: 40, hold_ms_p95: 300 } },
        freshness: { sources: [{ key: "stream/x466e1b0a645d", state: "live", runtime: { name: "claude-code", version: "2.1.324", state: "incompatible", proven_versions: ["2.1.322"], records_accepted: 900, records_refused: 3, refused_by_class: { "assistant-shape": 3 }, reason: "some records did not match the known shapes and were refused" } }] },
      },
      "/snapshot": { cursor: "g1.10", generation: "g1", pos: 10, reconstructed: false, state: { cells: { [TICKET]: { ticket_id: TICKET, slice_id: SLICE, stage: "planned", risk: "High", app_type: "library", plan: { app_type: "library", risk: "High", contracts: 2, tasks: 7, recorded_by: "c:LOCAL-001:b2:6" }, round: 1 } }, history: HISTORY } },
      [`/cells/${TICKET}`]: { ticket_id: TICKET, slice_id: SLICE, stage: "planned", risk: "High", app_type: "library", plan: { app_type: "library", risk: "High", contracts: 2, tasks: 7, recorded_by: "c:LOCAL-001:b2:6" }, round: 1, cursor: "g1.10" },
      "/artifacts": {
        items: [
          { id: "a1", ref: "artifact:LOCAL-001:evidence/run.log", ticket_id: TICKET, path_rel: "evidence/run.log", kind: "verification-log", nature: "evidence", media_type: "text/plain", bytes: 10, sha256: "ab", integrity: "match", verified_evidence: true, targets: [], round: 2, round_basis: "recorded", commit: "70c370b2b753", visit_id: `${TICKET}/verify#3`, visit: { visit_id: `${TICKET}/verify#3`, basis: "recorded", rule: "check-hash" }, content_access: "text", provenance: {} },
          { id: "a2", ref: "artifact:LOCAL-001:review/round-1/findings.md", ticket_id: TICKET, path_rel: "review/round-1/findings.md", kind: "review-findings", nature: "prose", media_type: "text/markdown", bytes: 5, sha256: "cd", integrity: "match", verified_evidence: false, targets: [], round: 1, round_basis: "recorded", visit: { visit_id: `${TICKET}/review#1`, basis: "reconstructed", rule: "round-and-time" }, content_access: "text", provenance: {} },
          { id: "a3", ref: "artifact:LOCAL-001:evidence/x.png", ticket_id: TICKET, path_rel: "evidence/x.png", kind: "screenshot", nature: "evidence", integrity: "unchecked", verified_evidence: false, targets: [], round: null, visit: null, content_access: "media", provenance: {} },
        ],
        more: false,
      },
    }),
  });
  const session = await client.session();
  assert.deepEqual({ ...session.streamObservations, versions: undefined }, { ok: true, reason: session.streamObservations.reason, policy: "structural", state: "compatible-unproven", claudeCodeVersion: "2.1.324", provenVersions: ["2.1.322", "2.1.323"], versions: undefined });
  assert.deepEqual(session.streamObservations.versions, [{ version: "2.1.324", state: "compatible-unproven", executions: 2, recordsRefused: 0 }]);

  const health = await client.health();
  assert.equal(health.history.completeness, "partial");
  assert.deepEqual(health.history.lost, { evicted: 1, "not-received": 2 });
  assert.deepEqual(health.history.notInterpreted, { "unknown-type": 17 });
  assert.equal(health.runtime.state, "compatible-unproven");
  assert.deepEqual(health.sources[0].runtime, { state: "incompatible", version: "2.1.324", reason: "some records did not match the known shapes and were refused", recordsAccepted: 900, recordsRefused: 3 });

  const snap = await client.snapshot();
  assert.equal(snap.state.history.completeness, "partial");
  assert.deepEqual(snap.state.cells[0].plan, { app_type: "library", risk: "High", contracts: 2, tasks: 7, recorded_by: "c:LOCAL-001:b2:6" });

  const cell = await client.cell(TICKET);
  assert.deepEqual(cell.plan, { appType: "library", risk: "High", contracts: 2, tasks: 7, recordedBy: "c:LOCAL-001:b2:6" });

  const { items } = await client.artifacts({ ticket: TICKET });
  assert.deepEqual(items.map((a) => a.visit), [{ visitId: `${TICKET}/verify#3`, basis: "recorded", rule: "check-hash" }, { visitId: `${TICKET}/review#1`, basis: "reconstructed", rule: "round-and-time" }, null]);
  assert.equal(items[0].roundBasis, "recorded");

  // A history only of records not interpreted is complete (never partial).
  assert.equal(live.readObserverHistory({ completeness: "complete", lost: {}, not_interpreted: { "unknown-type": 4 } }).completeness, "complete");
  assert.equal(live.readObserverHistory({ lost: { evicted: 1 } }).completeness, "partial", "an older reply without `completeness`: partial only when something was lost");
});

test("plan facts: the plan's exit (schema revision 2) sets app type, risk and the contract and task counts on the cell", async () => {
  const words = await import("../src/shell/inspector/words.ts");
  const f = factory();
  f.claim(X1, T0);
  f.enter("plan#1", T0 + 1000, X1, 1, "spec-ready");
  const before = logOf(finalize(f.out)).head().cells[TICKET];
  assert.equal(before.plan, null);
  assert.ok(before.meta.unknown.includes("appType"), "not recorded before the plan's exit");
  f.exit("plan#1", T0 + 5000, X1, "planned", "planned", 1, { app_type: "library", risk: "High", counts: { contracts: 2, tasks: 7 } });
  const cell = logOf(finalize(f.out)).head().cells[TICKET];
  assert.deepEqual({ ...cell.plan, eventId: undefined }, { appType: "library", risk: "High", contracts: 2, tasks: 7, eventId: undefined, authority: "authoritative" });
  assert.equal(cell.appType, "library");
  assert.equal(cell.risk, "High");
  assert.ok(!cell.meta.unknown.includes("appType"));
  assert.equal(words.planWords(cell.plan), "app type library, High risk, 2 contracts, 7 tasks (recorded at the plan's exit)");
  assert.equal(words.planWords({ ...cell.plan, contracts: null, authority: "reconstructed" }), "app type library, High risk, contracts not recorded, 7 tasks (from the observer's summary of the plan's exit)");
});

test("gaps by class: unknown-type is received-not-interpreted (complete), evicted and not-received lose history; described by class", () => {
  const f = factory();
  const gap = (seq, t, data) => f.out.push(ev("history.gap", { stream: "observer", key: CELL_KEY, seq, t, ids: { ticket_id: TICKET }, entities: [`cell:${TICKET}`], data }));
  gap(1, T0, { source_key: `stream/${X1}`, from_seq: 2, to_seq: 8, reason: "unexpected-shape", count: 7, class: "unknown-type", history_lost: false });
  const a = logOf(finalize(f.out));
  assert.equal(a.head().completeness.state, "complete");
  assert.match(sim.describeEntry(a.entries().find((e) => e.event.type === "history.gap")), /^7 record\(s\) received, not interpreted \(unexpected-shape\)\.$/);
  gap(2, T0 + 10, { source_key: "intake", from_seq: null, to_seq: null, reason: "evicted", count: 1200, class: "evicted", history_lost: true });
  const b = logOf(finalize(f.out));
  assert.equal(b.head().completeness.state, "partial");
  assert.match(sim.describeEntry(b.entries().filter((e) => e.event.type === "history.gap")[1]), /^1200 record\(s\) of history lost: no longer held by the observer \(evicted\)\.$/);
  // An older observer (no class): the reason's class, as the observer maps it.
  assert.equal(sim.gapClassOf("no-timestamps"), "unknown-type");
  assert.equal(sim.gapClassOf("missing-seq"), "not-received");
});

test("runtime states: unproven, not stated yet, or some records refused are said where agent activity is shown; never silence", async () => {
  const words = await import("../src/shell/inspector/words.ts");
  const stream = (f, type, t, data, runtime, ids = {}, entities = []) => {
    const e = ev(type, { stream: "execution-stream", key: `s:${X1}`, seq: f.out.length + 1, t, ids: { ticket_id: TICKET, execution_id: X1, ...ids }, entities: [`execution:${X1}`, ...entities], data });
    if (runtime) e.origin.runtime_state = runtime;
    f.out.push(e);
  };
  const run = (runtime) => {
    const f = factory();
    f.claim(X1, T0);
    stream(f, "agent.started", T0 + 1000, { index: 1, label: `${TICKET}: build`, phase: "Build", phase_index: 3, agent_type: "mach:builder", model: "claude-sonnet-5-5", agent_try: 1 }, runtime, { agent_id: `${X1}/a1` }, [`agent:${X1}/a1`]);
    return logOf(finalize(f.out)).head();
  };
  const unknown = sim.streamObservationOf(run("unknown"), X1);
  assert.equal(unknown.state, "unproven");
  assert.equal(words.agentsWords(unknown, 1), "1: agent activity from a Claude Code version its stream has not stated yet");
  const partial = sim.streamObservationOf(run("incompatible"), X1, { state: "incompatible", version: "2.1.400", reason: "r", recordsRefused: 3 });
  assert.equal(partial.state, "partial", "records that matched are still shown");
  assert.match(words.agentsWords(partial, 1), /some of its records were refused/);
  assert.equal(words.runtimeStateWords(partial), "Claude Code 2.1.400: some records refused for their shape (3); nothing of them is shown");
  const proven = sim.streamObservationOf(run("proven"), X1);
  assert.equal(proven.state, "observed");
  assert.equal(words.agentsWords(proven, 1), "1");
  assert.match(words.runtimeStateWords(proven), /: proven/);
  assert.equal(words.runtimeSummaryWords({ state: "compatible-unproven", provenVersions: [], versions: [{ version: "2.1.324", state: "compatible-unproven", executions: 2, recordsRefused: 0 }] }), "2.1.324 compatible, unproven (2 executions)");
});

test("the live source merges /health's runtime summary and history completeness into the Factory status", async () => {
  const { fakeTimers } = await import("./fixtures/observer.mjs");
  const server = fakeObserver();
  server.runtime = RUNTIME;
  server.summaries.history = HISTORY;
  server.commit(finalize(factory().out));
  const client = live.createObserverClient({ fetch: server.fetch });
  const { store, source } = live.createLiveFactory({ client, openStream: server.openStream, clock: manualClock(), timers: fakeTimers() });
  await source.start();
  await settle();
  const status = store.getState().factoryStatus;
  assert.equal(status.runtime.state, "compatible-unproven");
  assert.equal(status.history.completeness, "partial");
  assert.deepEqual(status.history.lost, { evicted: 1, "not-received": 2 });
  source.stop();
  store.dispose();
});

test("a long history starts from the summaries (with the observer's history) and its newest window; never /snapshot", async () => {
  const { fakeTimers } = await import("./fixtures/observer.mjs");
  const server = fakeObserver({ snapshot: true });
  const f = factory();
  for (let i = 0; i < 300; i++) f.life("build.task_completed", T0 + i * 1000, { task_id: `T${i}`, kind: "impl", step: "green", first_run: "pass", suite: "green", commit: null });
  server.commit(finalize(f.out));
  server.summaries.history = HISTORY;
  server.summaries.cells = [{ ticket_id: "LOCAL-077", slice_id: "SLICE-077", stage: "merged", round: 1, app_type: "web", plan: { app_type: "web", risk: "Low", contracts: 0, tasks: 3, recorded_by: null } }];
  server.summaries.waves = [{ wave_id: "WAVE-077", slices: ["SLICE-077"], revision: 1 }];
  const client = live.createObserverClient({ fetch: server.fetch });
  const { log, source } = live.createLiveFactory({ client, openStream: server.openStream, clock: manualClock(), timers: fakeTimers(), liveWindow: 1000, pageLimit: 100 });
  await source.start();
  await settle();
  // 302 events in all here; a window of 1000 holds them all: no summaries needed.
  assert.ok(!server.requests.some((r) => r.includes("/cells?")), "a short history reads no summaries");
  source.stop();
  // Longer than the window.
  const big = fakeObserver({ snapshot: true });
  const g = factory();
  for (let i = 0; i < 2600; i++) g.life("build.task_completed", T0 + i * 1000, { task_id: `T${i}`, kind: "impl", step: "green", first_run: "pass", suite: "green", commit: null });
  big.commit(finalize(g.out));
  big.summaries.history = HISTORY;
  big.summaries.cells = server.summaries.cells;
  big.summaries.waves = server.summaries.waves;
  const b = live.createLiveFactory({ client: live.createObserverClient({ fetch: big.fetch }), openStream: big.openStream, clock: manualClock(), timers: fakeTimers(), liveWindow: 1000, pageLimit: 100 });
  await b.source.start();
  await settle();
  const head = b.log.head();
  assert.deepEqual(big.snapshotsAt, [], "no /snapshot");
  assert.ok(big.requests.filter((r) => r.includes("/events?")).length <= 14, "only the window's pages (and the probe)");
  assert.equal(head.completeness.state, "reconstructed");
  assert.deepEqual(head.completeness.observer.lost, { evicted: 1, "not-received": 2 }, "the observer's own history facts, from /project");
  assert.equal(head.cells["LOCAL-077"].stage, "merged");
  assert.equal(head.cells["LOCAL-077"].plan.tasks, 3);
  assert.ok(head.waves["WAVE-077"], "an untouched wave is seeded");
  assert.ok(!head.cells[TICKET].meta.eventId.startsWith("k:"), "the window's own cell is never seeded");
  const words = await import("../src/shell/inspector/words.ts");
  assert.match(words.completenessWords(head.completeness).why, /seeded from the observer's projected state.*The observer's own history is partial \(no longer held by the observer: 1, not received: 2\)/);
  void log;
  b.source.stop();
});

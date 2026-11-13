// M6.2 acceptance re-check after the fix rounds (docs/mach-next/M6_2_ACCEPTANCE.md, "Re-check after the
// fix rounds"): D6, D10, R4, R5, R6 and R7, each reproduced with a small v3 fixture written for it
// (shaped like the run's records, with none of its data), then held. D17's memory is measured in
// test/live-windows-scale.test.mjs and in the browser (README section 11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
// Loaded tolerantly, so each test fails on its own against a tree without the fix (not the whole file).
const words = await import("../src/shell/inspector/words.ts");
const time = await import("../src/shell/time.ts").catch(() => ({}));
const consensus = await import("../src/atlas/consensus.ts").catch(() => ({}));
const { createSceneLog, provenance, entityAt, activityOf, visitStatusOf } = sim;
const DEFS = live.LIVE_DEFINITIONS;
const logOf = (events) => {
  const log = createSceneLog({ definitions: DEFS, provenance: provenance("live") });
  log.ingest(events);
  return log;
};

const T0 = Date.UTC(2026, 10, 12, 22, 45, 0);
const TICKET = "LOCAL-001";
const CELL_KEY = `c:${TICKET}:b2dcbc17`;

/** One cell's lifecycle and executions, written for these tests. */
function factory() {
  let cseq = 0;
  let iseq = 0;
  const out = [];
  const life = (type, t, data, ids = {}, entities = []) => out.push(ev(type, { stream: "cell-lifecycle", key: CELL_KEY, seq: ++cseq, t, ids: { ticket_id: TICKET, ...ids }, entities: [`cell:${TICKET}`, ...entities], data }));
  const intake = (type, t, data, ids = {}, entities = []) => out.push(ev(type, { stream: "intake-log", key: "i:df29bf72", seq: ++iseq, t, precision: "s", ids, entities, data }));
  const record = (type, x, seq, t, data) => out.push(ev(type, { stream: "execution-record", key: `x:${x}`, seq, t, precision: "s", ids: { ticket_id: TICKET, execution_id: x }, entities: [`execution:${x}`, `cell:${TICKET}`], data }));
  /** A lifecycle gate evaluation as the observer writes it: its own gate ref among the entities. */
  const gate = (t, name, verdict, { round = null, reason = null, subject = null, visit } = {}) =>
    life("gate.evaluated", t, { gate: name, verdict, reason_code: reason, subject, status: null, audit_tier: null, counts: {} }, { visit_id: visit ? `${TICKET}/${visit}` : null, round }, [`gate:${TICKET}/${name}${round ? `#${round}` : ""}`]);
  const enter = (visit, t, x, round, data = {}) => {
    const station = visit.split("#")[0];
    life("station.entered", t, { station, stage: data.stage ?? null, action: station, resumed: false, unclosed_visit: data.unclosed ?? null, head: null, counts: {} }, { visit_id: `${TICKET}/${visit}`, station, round, execution_id: x }, [`station:${TICKET}/${station}`, `visit:${TICKET}/${visit}`]);
  };
  const exit = (visit, t, x, round, outcome, stage) => {
    const station = visit.split("#")[0];
    life("station.exited", t, { station, outcome, stage, duration_ms: 1000, closed_by: null, head: null, counts: {} }, { visit_id: `${TICKET}/${visit}`, station, round, execution_id: x }, [`station:${TICKET}/${station}`, `visit:${TICKET}/${visit}`]);
  };
  return { out, life, intake, record, gate, enter, exit };
}

/** The run's gate evaluations (lifecycle lines 2 to 58 of run A, in shape): passes, refusals and two overrides. */
function gateHistory() {
  const f = factory();
  f.intake("work.scheduled", T0, { stage: "planned", risk: "High", branch: `feature/${TICKET}`, by_role: "supervisor", authorization: "runner" }, { slice_id: "SLICE-001", ticket_id: TICKET }, [`cell:${TICKET}`]);
  f.gate(T0 + 1_000, "groom.finalize", "passed", { visit: "groom#1" });
  f.gate(T0 + 2_000, "plan.check", "passed", { visit: "plan#1" });
  f.gate(T0 + 3_000, "build.start", "passed", { round: 1, visit: "build#1" });
  f.gate(T0 + 4_000, "build.finish", "passed", { round: 1, visit: "build#1" });
  f.gate(T0 + 5_000, "verify.start", "passed", { round: 1, visit: "verify#1" });
  f.gate(T0 + 6_000, "verify.start", "passed", { round: 1, visit: "verify#1" });
  f.gate(T0 + 7_000, "verify.finish", "refused", { round: 1, reason: "incomplete-evidence", visit: "verify#2" });
  f.gate(T0 + 8_000, "verify.verdict", "passed", { round: 1, reason: "PASS", visit: "verify#3" });
  f.gate(T0 + 9_000, "frozen-tests", "overridden", { round: 2, reason: "test-amended", subject: "R1-T02", visit: "build#2" });
  f.gate(T0 + 10_000, "red-before-green", "overridden", { round: 2, reason: "test-passed-first-run", subject: "R1-T03", visit: "build#2" });
  f.gate(T0 + 11_000, "build.finish", "passed", { round: 2, visit: "build#2" });
  return finalize(f.out);
}

// ---------------------------------------------------------------- D6: every evaluated gate, especially every override, is listed

test("D6: the cell's Gates list holds every evaluated gate once, the frozen-tests override among them, each a ref", () => {
  const head = logOf(gateHistory()).head();
  const list = sim.cellGateList(head, TICKET);
  const byRef = new Map(list.map((e) => [e.ref, e.gate]));
  const frozen = byRef.get(`gate:${TICKET}/frozen-tests#2`);
  assert.ok(frozen, `frozen-tests is listed: ${[...byRef.keys()].join(", ")}`);
  assert.equal(frozen.state, "overridden");
  assert.equal(frozen.reasonCode, "test-amended");
  assert.equal(sim.gateStateWords(frozen), "Overridden: test-amended");
  assert.equal(sim.recordedGateWords(frozen.recorded.name), "Frozen tests");
  // Every evaluated gate is reachable from the list: the evaluation's own gate, or the gate state it is.
  for (const g of head.cells[TICKET].gateLog) {
    const shown = sim.gateOfRef(head, g.ref.slice("gate:".length));
    assert.ok(list.some((e) => e.gate === shown), `${g.ref} is in the list`);
  }
  // Gate states are listed once: the red-before-green override is the gate state, not a second entry.
  const rbg = list.filter((e) => e.gate.gate === "red-before-green" || e.gate.recorded?.name === "red-before-green");
  assert.equal(rbg.length, 1);
  assert.equal(rbg[0].gate.state, "overridden");
  assert.equal(rbg[0].ref, `gate:${TICKET}/red-before-green`);
  // verify.start evaluated twice in round 1: one entry, both evaluations behind it.
  const vs = byRef.get(`gate:${TICKET}/verify.start#1`);
  assert.equal(vs.recorded.evaluations.length, 2);
  assert.equal(byRef.get(`gate:${TICKET}/verify.finish#1`).state, "failed");
  // Oldest first.
  const times = list.map((e) => e.gate.openedAt);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  // Every override is in the list (gateOverrides is the reviewers' view of the same facts).
  for (const o of sim.gateOverrides(head, TICKET)) assert.ok(list.some((e) => e.gate.state === "overridden" && (e.ref === o.ref || e.gate.id === o.gateId)), o.gate);
});

// ---------------------------------------------------------------- R5: the observer's gate refs resolve to the same entity

test("R5: the observer's own gate refs open the gate the scene's refs open, decided long before, never 'not started'", () => {
  const log = logOf(gateHistory());
  const head = log.head();
  const at = (ref) => entityAt(head, ref)?.value ?? null;
  assert.equal(at(`gate:${TICKET}/plan.check`), head.gates[`${TICKET}/plan-check`], "plan.check is the plan check");
  assert.equal(at(`gate:${TICKET}/verify.verdict#1`), head.gates[`${TICKET}/verification#1`], "verify.verdict#1 is round 1's verdict");
  assert.equal(at(`gate:${TICKET}/red-before-green#2`), head.gates[`${TICKET}/red-before-green`], "red-before-green#2 is the red-before-green gate");
  assert.equal(at(`gate:${TICKET}/red-before-green#2`).state, "overridden");
  const frozen = at(`gate:${TICKET}/frozen-tests#2`);
  assert.equal(frozen.gate, "recorded");
  assert.equal(frozen.state, "overridden");
  assert.equal(frozen.decidedAt, T0 + 9_000);
  // The same object while nothing changes (the inspector's selector must not re-render forever).
  assert.equal(at(`gate:${TICKET}/frozen-tests#2`), frozen);
  // Before its evaluation it does not exist: "not started" is then right.
  assert.equal(entityAt(log.sceneAt(T0 + 8_500), `gate:${TICKET}/frozen-tests#2`), null);
  // The scene's own refs are unchanged.
  assert.equal(at(`gate:${TICKET}/plan-check`), head.gates[`${TICKET}/plan-check`]);
});

// ---------------------------------------------------------------- D10: one source of truth for the consensus gate

test("D10: the Atlas's consensus gate says what the inspector says about the same gate, never 'Open' after a decision", () => {
  const gate = { id: `${TICKET}/review#2`, ticketId: TICKET, gate: "review", round: 2, state: "passed", detail: "AWAITING_HUMAN: 3 approved, 3 needed.", openedAt: T0, decidedAt: T0 + 56_000, seq: 70, reasonCode: null, meta: sim.SIM_META };
  const scene = { gates: { [gate.id]: gate }, cells: { [TICKET]: { ticketId: TICKET, reviews: [{ round: 1, outcome: "REJECTED" }, { round: 2, outcome: "AWAITING_HUMAN" }] } } };
  // No panel sits any more (the decision is past its afterglow): the chamber still names this gate.
  const shown = consensus.chamberGate(scene, null, null);
  assert.equal(shown.gate, gate);
  assert.equal(shown.ref, `gate:${TICKET}/review#2`, "selecting it opens the inspector on the same gate");
  assert.match(shown.label, /LOCAL-001 round 2, passed/);
  assert.ok(shown.label.toLowerCase().includes(sim.gateStateWords(gate).toLowerCase()), "the inspector's words");
  assert.match(shown.label, /a person must approve next at the human approval gate/);
  assert.doesNotMatch(shown.label, /\bopen\b/i);
  // While the panel sits, the same gate and words.
  const sitting = consensus.chamberGate(scene, { cell: scene.cells[TICKET], roundIndex: 1 }, null);
  assert.equal(sitting.ref, shown.ref);
  assert.match(sitting.label, /round 2: passed/);
  // Before any review: no gate, said so.
  assert.match(consensus.chamberGate({ gates: {}, cells: {} }, null, null).label, /no review yet/);
});

// ---------------------------------------------------------------- R4: a visit's end is printed as text

test("R4: a visit that ended without an exit record says when, as text, never '[object Object]'", () => {
  const f = factory();
  f.record("execution.process_started", "x1", 1, T0, {});
  f.enter("verify#1", T0 + 60_000, "x1", 1, { stage: "built" });
  f.enter("verify#2", T0 + 120_000, "x1", 1, { stage: "built", unclosed: "verify#1" });
  const visit = entityAt(logOf(finalize(f.out)).head(), `visit:${TICKET}/verify#1`).value;
  const status = visitStatusOf(visit);
  assert.equal(status.state, "ended-unrecorded");
  const clock = (t) => new Date(t).toISOString().slice(11, 19);
  const left = words.visitLeftWords(visit, status, clock);
  assert.equal(typeof left, "string");
  assert.equal(left, "no exit record; ended by 22:47:00 at the latest");
  assert.doesNotMatch(String(left), /object/);
  assert.equal(words.visitLeftWords({ leftAt: null }, { state: "waiting-person" }, clock), "not yet: waiting for a person");
  assert.equal(words.visitLeftWords({ leftAt: null }, { state: "working" }, clock), "still open");
});

// ---------------------------------------------------------------- R6: a process that ended is not "running" nor "not known"

test("R6: after its process ended and before the supervisor records it, an execution is 'ended, outcome not recorded yet' everywhere", () => {
  const f = factory();
  const x = "x13e7bccffc37";
  f.intake("work.scheduled", T0, { stage: "planned", risk: "High", branch: "b", by_role: "supervisor", authorization: "runner" }, { slice_id: "SLICE-001", ticket_id: TICKET }, [`cell:${TICKET}`]);
  f.intake("execution.started", T0 + 1_000, { until: "merge", workflow: "mach:belt", limits: {} }, { ticket_id: TICKET, execution_id: x }, [`execution:${x}`]);
  f.record("execution.process_started", x, 1, T0 + 2_000, {});
  f.enter("build#1", T0 + 3_000, x, 1, { stage: "planned" });
  f.exit("build#1", T0 + 60_000, x, 1, "built", "built");
  f.record("execution.process_ended", x, 2, T0 + 90_000, { ended: "exited", exit_code: 0, seconds: 88 });
  const head = logOf(finalize(f.out)).head();
  const execution = head.executions[x];
  assert.equal(execution.state, "running", "the supervisor has not recorded it");
  assert.deepEqual(sim.executionStatusOf(execution), { word: "Ended, outcome not recorded yet", running: false }, "the inspector's state");
  const xa = activityOf(head, `execution:${x}`);
  assert.equal(xa.state, "unknown");
  assert.equal(xa.label, "Ended, outcome not recorded yet", "the Blueprint's execution row");
  const ca = activityOf(head, `cell:${TICKET}`);
  assert.equal(ca.label, "Idle, outcome not recorded yet", "the Atlas's mast and cell label, not 'not known'");
  assert.equal(sim.activityLabel(ca, () => "Not known"), "Idle, outcome not recorded yet");
  // Recorded by the supervisor: completed, as before.
  f.intake("execution.completed", T0 + 95_000, { stage: "built", next: "verify", waiting_for: null, how: "exited", seen_to_end: true, cost_usd: 1, refused_tools: [] }, { ticket_id: TICKET, execution_id: x }, [`execution:${x}`]);
  assert.equal(sim.executionStatusOf(logOf(finalize(f.out)).head().executions[x]).word, "Completed");
});

test("M6.3 polish: an execution the supervisor moved on from (a later claim of the same ticket, no end recorded) is not running on the Floor", () => {
  const f = factory();
  const [a, b] = ["x13e7bccffc01", "x13e7bccffc02"];
  const claim = (x, t, attempt) => f.intake("work.claimed", t, { stage: "planned", next: "build", attempt }, { ticket_id: TICKET, execution_id: x, attempt }, [`execution:${x}`, `cell:${TICKET}`]);
  claim(a, T0, 1);
  f.intake("execution.started", T0 + 1_000, { until: "merge", workflow: "mach:belt", limits: {} }, { ticket_id: TICKET, execution_id: a }, [`execution:${a}`]);
  f.enter("build#1", T0 + 3_000, a, 1, { stage: "planned" });
  const open = logOf(finalize([...f.out])).head();
  assert.equal(sim.executionStatusOf(open.executions[a]).word, "Running", "nothing later yet: it may still be running");
  // The supervisor attempt number repeats: the order of claims is what tells them apart.
  claim(b, T0 + 600_000, 1);
  const head = logOf(finalize(f.out)).head();
  assert.deepEqual(sim.executionStatusOf(head.executions[a]), { word: "Outcome not known", running: false });
  assert.equal(activityOf(head, `execution:${a}`).state, "unknown");
  assert.equal(head.executions[a].movedOnAt, T0 + 600_000);
  assert.equal(sim.executionStatusOf(head.executions[b]).word, "Claimed, not started");
  assert.ok(head.cells[TICKET].visits.every((v) => v.executionId !== a || v.leftAt !== null), "its open visit closes at the later claim");
});

test("M6.3 polish: an interrupted process outranks an outcome-unknown recovery in every Floor reading, as in the observer", () => {
  const f = factory();
  const x = "x13e7bccffc03";
  f.intake("execution.started", T0 + 1_000, { until: "merge", workflow: "mach:belt", limits: {} }, { ticket_id: TICKET, execution_id: x }, [`execution:${x}`]);
  f.record("execution.process_started", x, 1, T0 + 2_000, {});
  f.record("execution.process_ended", x, 2, T0 + 90_000, { ended: "interrupted", exit_code: null, seconds: 88 });
  f.intake("recovery.started", T0 + 120_000, { kind: "outcome-unknown" }, { ticket_id: TICKET, execution_id: x }, [`execution:${x}`]);
  const head = logOf(finalize(f.out)).head();
  assert.equal(sim.executionStatusOf(head.executions[x]).word, "Interrupted");
  assert.equal(activityOf(head, `execution:${x}`).state, "interrupted");
});

// ---------------------------------------------------------------- R7: the live clock, the empty state and the idle frame loop

function liveStore(events, wallStart) {
  const clock = manualClock(0);
  const log = logOf(events);
  const store = createSceneStore({ source: "live", log, clock, wallClock: () => wallStart + clock.now() });
  return { clock, log, store };
}

test("R7: the live edge is the wall clock from the first frame, not the last event's time", () => {
  const events = gateHistory();
  const last = events.at(-1).time.order_ms;
  const wall = last + 4 * 3_600_000; // the page opens four hours after the last event
  const { store, clock } = liveStore(events, wall);
  assert.equal(store.getState().liveAt, wall, "at once, before any frame or heartbeat");
  assert.equal(store.getState().playhead, wall);
  const off = store.subscribe(() => undefined);
  store.setConnection({ ...store.getState().connection, state: "live" });
  clock.frames(1, 16);
  assert.ok(Math.abs(store.getState().liveAt - (wall + 16)) <= 1, `${store.getState().liveAt - wall}`);
  // The observer's clock says 3 s later than the browser's: the edge follows the observer's.
  store.observeClock(wall + clock.now() + 3_000);
  clock.frames(70, 16);
  assert.ok(Math.abs(store.getState().liveAt - (wall + clock.now() + 3_000)) < 1_100, `${store.getState().liveAt - (wall + clock.now())}`);
  // Stale: frozen, as before.
  store.setConnection({ ...store.getState().connection, state: "stale", staleSince: last });
  const frozen = store.getState().liveAt;
  clock.frames(120, 16);
  assert.equal(store.getState().liveAt, frozen);
  off();
  store.dispose();
});

test("R7: an empty project shows an empty state, never 1 January 1970; with a wall clock its edge is now", () => {
  assert.deepEqual(time.timeCodeText({ playhead: 0, liveAt: 0, source: "live" }), { code: "--:--:--", clock: "No events yet" });
  assert.deepEqual(time.timeCodeText({ playhead: 5_800, liveAt: 5_800, source: "live" }), { code: "--:--:--", clock: "No events yet" });
  assert.doesNotMatch(JSON.stringify(time.timeCodeText({ playhead: 5_800, liveAt: 5_800, source: "replay" })), /1970/);
  const t = Date.UTC(2026, 10, 13, 3, 0, 0, 500);
  assert.deepEqual(time.timeCodeText({ playhead: t, liveAt: t, source: "live" }), { code: "03:00:00.5", clock: "UTC, 13 Nov 2026" });
  const { store } = liveStore([], t);
  assert.equal(store.getState().liveAt, t);
  assert.doesNotMatch(time.timeCodeText(store.getState()).clock, /1970/);
});

test("R7: following the live edge with nothing moving asks for no frames: it wakes once a second, and runs frames only while a motion is in progress", () => {
  const events = gateHistory();
  const wall = events.at(-1).time.order_ms + 600_000;
  const { store, clock, log } = liveStore(events, wall);
  let notified = 0;
  const off = store.subscribe(() => (notified += 1));
  store.setConnection({ ...store.getState().connection, state: "live" });
  const before = clock.framesRun;
  notified = 0;
  clock.frames(600, 1000 / 60); // ten seconds, idle
  const idleFrames = clock.framesRun - before;
  assert.ok(idleFrames <= 2, `idle: ${idleFrames} frames in 10 s (was 600)`);
  assert.ok(notified >= 9 && notified <= 12, `the clock label moves once a second: ${notified} changes`);
  const edge = store.getState().liveAt;
  assert.ok(Math.abs(edge - (wall + clock.now())) < 1_100, "and the edge keeps up with the wall clock");
  // An event arrives: frames for its motion, then waits again.
  const t = wall + clock.now() - 200;
  log.ingest(finalize([ev("gate.evaluated", { stream: "cell-lifecycle", key: CELL_KEY, seq: 99, t, ids: { ticket_id: TICKET, round: 2 }, entities: [`cell:${TICKET}`], data: { gate: "build.finish", verdict: "passed", reason_code: null, subject: null, status: null, audit_tier: null, counts: {} } })], 1000));
  store.logChanged();
  const atArrival = clock.framesRun;
  clock.frames(60, 1000 / 60); // one second: the motion is in progress
  const moving = clock.framesRun - atArrival;
  assert.ok(moving >= 50, `frames while a motion is in progress: ${moving}`);
  clock.frames(120, 1000 / 60); // past the motion window
  const settled = clock.framesRun;
  clock.frames(600, 1000 / 60);
  assert.ok(clock.framesRun - settled <= 2, `idle again: ${clock.framesRun - settled} frames in 10 s`);
  // Playback still runs every frame.
  store.seek(events[3].time.order_ms);
  store.play();
  const playing = clock.framesRun;
  clock.frames(30, 1000 / 60);
  assert.ok(clock.framesRun - playing >= 29);
  off();
  store.dispose();
  assert.equal(clock.pending, 0, "nothing left asked for");
});

// ---------------------------------------------------------------- observer 7353ffb: free text is labelled; unknown risk is null

const freeText = await import("../src/shell/inspector/free-text.ts").catch(() => ({}));

test("R1 label: a catalog entry served as free text carries 'Free text, not checked for names' wherever it is listed or opened", async () => {
  const items = [
    { id: "a1", ref: `artifact:${TICKET}:review/round-1/findings.md`, ticket_id: TICKET, path_rel: "review/round-1/findings.md", kind: "findings", free_text: true, free_text_note: "free text, not checked for names" },
    { id: "a2", ref: `artifact:${TICKET}:evidence/results.json@9f2c0a1b3d4e`, ticket_id: TICKET, path_rel: "evidence/results.json", kind: "verification-results", free_text: true, free_text_note: "free text, not checked for names" },
    { id: "a3", ref: `artifact:${TICKET}:spec.md`, ticket_id: TICKET, path_rel: "spec.md", kind: "spec", free_text: false, free_text_note: null },
    { id: "a4", ref: `artifact:${TICKET}:plan.md`, ticket_id: TICKET, path_rel: "plan.md", kind: "plan" }, // an observer before the field
  ];
  const fetch = async (url) =>
    url.includes("/content")
      ? { status: 200, json: async () => "", text: async () => "## Finding\nprose", headers: { get: (h) => ({ "x-mach-free-text": "unchecked-for-names", "x-mach-redacted": "2" })[h.toLowerCase()] ?? null } }
      : { status: 200, json: async () => ({ ok: true, data: { items, more: false } }) };
  const client = live.createObserverClient({ fetch });
  const { items: entries } = await client.artifacts({ ticket: TICKET });
  assert.deepEqual(entries.map((e) => [e.freeText, e.freeTextNote]), [[true, "free text, not checked for names"], [true, "free text, not checked for names"], [false, null], [false, null]]);
  assert.equal(live.FREE_TEXT_LABEL, "Free text, not checked for names");
  assert.equal(live.freeTextLabel(entries[0]), "Free text, not checked for names");
  assert.equal(live.freeTextLabel(entries[2]), null);
  // Scene artifacts find their entries by ref (any version) or by ticket and path.
  const art = (id, path) => ({ id: `${TICKET}:${id}`, ticketId: TICKET, path });
  assert.equal(freeText.freeTextLabelOf(entries, art("review/round-1/findings.md", "review/round-1/findings.md")), "Free text, not checked for names");
  assert.equal(freeText.freeTextLabelOf(entries, art("evidence/results.json", "evidence/results.json")), "Free text, not checked for names", "a versioned ref");
  assert.equal(freeText.freeTextLabelOf(entries, art("spec.md", "spec.md")), null);
  assert.equal(freeText.freeTextLabelOf(entries, art("plan.md", "plan.md")), null);
  // Opening the content: the header says the same.
  const content = await client.artifactContent("a1");
  assert.deepEqual(content.labels, { freeText: true, redacted: 2 });
  assert.deepEqual(live.readContentLabels({ get: () => null }), { freeText: false, redacted: null });
});

test("observer 7353ffb: risk and app type null (or empty, or missing) when unknown read as not recorded", async () => {
  for (const value of [null, "", undefined]) {
    const body = { ticket_id: TICKET, stage: "planned", round: 1, plan: null, cursor: "g.1", ...(value === undefined ? {} : { risk: value, app_type: value }) };
    const client = live.createObserverClient({ fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: body }) }) });
    const cell = await client.cell(TICKET);
    assert.equal(cell.risk, null, JSON.stringify(value));
    assert.equal(cell.appType, null, JSON.stringify(value));
  }
});

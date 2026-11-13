// Version 3 fixture events, built the way the observer would serve them (docs/mach-next/M6_1_EVENT_CONTRACT.md,
// schemas/factory-event.v3.schema.json). The workflow agents are taken from the real belt stream
// (tests/fixtures/execution-streams/belt-build-verify-review.jsonl, its final task_progress snapshot):
// their labels, phases, models, agent types, tool-call counts, token totals and durations are the real
// ones; the lifecycle records around them follow lifecycle.py's record shapes as the contract maps them.
//
// No randomness except where a test passes its own seeded generator.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..", "..");

/** The 29 workflow agents of the real belt run, from its last snapshot. */
export const BELT_AGENTS = (() => {
  const lines = readFileSync(join(repo, "tests", "fixtures", "execution-streams", "belt-build-verify-review.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines.filter((r) => Array.isArray(r.workflow_progress) && r.workflow_progress.some((a) => a.agentId)).at(-1);
  return last.workflow_progress.filter((a) => a.agentId).map((a) => ({
    index: a.index,
    label: a.label,
    phase: a.phaseTitle,
    phaseIndex: a.phaseIndex,
    model: a.model,
    agentType: a.agentType ?? null,
    toolCalls: a.toolCalls,
    tokens: a.tokens,
    lastTool: a.lastToolName,
    durationMs: a.durationMs,
  }));
})();
export const PHASES = ["Preflight", "Groom", "Build", "Verify", "Review", "Wrap up", "Learn"];

const RANK = { "intake-log": 1, "cell-lifecycle": 2, "execution-record": 3, "run-record": 4, "execution-stream": 5, observer: 6 };
const pad = (n, w) => String(Math.max(0, Math.floor(n))).padStart(w, "0");
const iso = (ms) => new Date(ms).toISOString();
const NULL_IDS = { project_id: null, wave_id: null, slice_id: null, revision: null, ticket_id: null, cell_instance: null, execution_id: null, runner_id: null, visit_id: null, station: null, round: null, attempt: null, seat: null, agent_id: null, parent_agent_id: null, tool_call_id: null };

/** One schema-shaped v3 event. `pos` is assigned by finalize(). */
export function ev(type, { stream, key, seq, part = 0, t, occurred = t, precision = "ms", authority, ids = {}, entities = [], data = {}, writer, script = null, unknown = [], inferred = {}, parent = null, cause = null, provenance = null, lag = 0 }) {
  const id = stream === "observer" ? `o:${key}:${seq}${part ? `:${part}` : ""}` : `${key}:${seq}${part ? `.${part}` : ""}`;
  const order_ms = t + lag;
  return {
    schema_version: 3,
    schema_revision: 0,
    id,
    type,
    pos: 0,
    origin: { stream, key, seq, part, writer: writer ?? (stream === "intake-log" ? "intake" : stream === "cell-lifecycle" ? "station" : stream === "execution-stream" ? "claude" : stream === "observer" ? "observer" : "executor"), script, source_version: stream === "execution-stream" ? "claude-code 2.1.322" : "1" },
    authority: authority ?? (stream === "execution-stream" ? "observed" : stream === "observer" ? "reconstructed" : "authoritative"),
    time: { occurred_at: occurred === null ? null : iso(occurred), precision, not_before: null, not_after: null, observed_at: iso(order_ms), order_ms },
    order: `${pad(order_ms, 15)}~${RANK[stream]}~${stream === "observer" ? "o" : key}~${pad(seq, 12)}~${pad(part, 4)}`,
    ids: { ...NULL_IDS, ...ids },
    entities: [...new Set(entities)],
    parent,
    cause,
    artifacts: [],
    unknown,
    inferred,
    provenance: provenance ?? (stream === "observer" ? { basis: [], rule: "fixture", files: [] } : null),
    late: false,
    withheld: 0,
    data,
  };
}

/** Sort by history order and give delivery positions 1..n, as an observer committing in order would. */
export function finalize(events, startPos = 1) {
  const sorted = [...events].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return sorted.map((e, i) => ({ ...e, pos: startPos + i }));
}

const template = (pred) => BELT_AGENTS.find(pred);
const T = {
  clerk: template((a) => a.label.endsWith("what next?")),
  build: template((a) => a.label.endsWith(": build")),
  verify: template((a) => a.label.endsWith(": verify")),
  revise: template((a) => a.label.endsWith(": revise")),
  panel: template((a) => a.label.endsWith("seat the panel")),
  architecture: template((a) => a.label.endsWith("architecture reviewer")),
  security: template((a) => a.label.endsWith("security reviewer")),
  product: template((a) => a.label.endsWith("product reviewer")),
  tally: template((a) => a.label.endsWith("tally")),
};

let counter = 0;
const defaultIds = { agent: () => `a${pad(++counter, 16)}`, gen: () => "3f2a9c1e" };

/**
 * One ticket through the belt in one supervised execution: build, verify (fails), revise, verify,
 * review (rejected), revise, verify, review (approved, awaiting a person), and, with `approve`, the
 * person's approval. Returns events without positions.
 */
export function beltRun({ ticket = "LOCAL-031", slice = "SLICE-021", wave = "WAVE-007", execution = "x1a2b3c4d5e6f", t0 = Date.UTC(2026, 10, 12, 9, 0, 0), intakeGen = "0badc0de", cellGen = "3f2a9c1e", approve = true, ids = defaultIds, dependencies = [], intakeSeq = 1, progressEvery = 1 } = {}) {
  const out = [];
  const intakeKey = `i:${intakeGen}`;
  const cellKey = `c:${ticket}:${cellGen}`;
  const streamKey = `s:${execution}`;
  const recKey = `x:${execution}`;
  let iseq = intakeSeq;
  let cseq = 0;
  let sseq = 0;
  let oseq = 0;
  let t = t0;
  const intake = (type, data, extra = {}) => out.push(ev(type, { stream: "intake-log", key: intakeKey, seq: iseq++, t, precision: "s", ids: { wave_id: wave, slice_id: slice, ticket_id: ticket, ...extra.ids }, entities: [`wave:${wave}`, `slice:${slice}`, `cell:${ticket}`, ...(extra.entities ?? [])], data, writer: extra.writer }));
  const visits = {};
  let round = 1;
  let currentVisit = null;
  const life = (type, data, extra = {}) =>
    out.push(ev(type, { stream: "cell-lifecycle", key: cellKey, seq: ++cseq, t, ids: { ticket_id: ticket, slice_id: slice, wave_id: wave, cell_instance: cellGen, execution_id: execution, visit_id: currentVisit?.id ?? null, station: currentVisit?.station ?? null, round: ["build", "verify", "review", "human-approval"].includes(currentVisit?.station) ? round : null, ...extra.ids }, entities: [`cell:${ticket}`, ...(currentVisit ? [`station:${ticket}/${currentVisit.station}`, `visit:${currentVisit.id}`] : []), ...(extra.entities ?? [])], data, script: extra.script ?? null }));
  const enter = (station, action, data = {}) => {
    visits[station] = (visits[station] ?? 0) + 1;
    currentVisit = { station, id: `${ticket}/${station}#${visits[station]}`, at: t };
    life("station.entered", { station, stage: data.stage ?? null, action, resumed: false, unclosed_visit: null, head: data.head ?? null, counts: data.counts ?? {} });
  };
  const exit = (outcome, stage, counts = {}) => {
    life("station.exited", { station: currentVisit.station, outcome, stage, duration_ms: t - currentVisit.at, closed_by: null, head: null, counts });
    currentVisit = null;
  };
  const observer = (type, data, extra = {}) => out.push(ev(type, { stream: "observer", key: extra.basisKey ?? cellKey, seq: ++oseq, t, ids: { ticket_id: ticket, slice_id: slice, round, station: currentVisit?.station ?? null, visit_id: currentVisit?.id ?? null, ...extra.ids }, entities: [`cell:${ticket}`, ...(extra.entities ?? [])], data }));
  const stream = (type, data, extra = {}) => out.push(ev(type, { stream: "execution-stream", key: streamKey, seq: ++sseq, t: extra.at ?? t, lag: extra.lag ?? 40, ids: { ticket_id: ticket, slice_id: slice, execution_id: execution, ...extra.ids }, entities: [`execution:${execution}`, `cell:${ticket}`, ...(extra.entities ?? [])], data, unknown: extra.unknown ?? [], inferred: extra.inferred ?? {}, parent: extra.parent ?? null }));
  const workflowRef = `workflow:${execution}/task0001`;
  let index = 0;
  const agents = [];
  /** One workflow agent from a real template: queued, started, progressed (from snapshots), finished. Returns its end time. */
  const agent = (tpl, { start = t, station = null, seat = null, labelTicket = true } = {}) => {
    const id = `${execution}/${ids.agent()}`;
    const i = ++index;
    const label = labelTicket ? tpl.label.replace(/^TICKET-\d+/, ticket) : tpl.label;
    const inferred = station ? { "ids.ticket_id": "label", "ids.station": "label", ...(seat ? { "ids.seat": "label" } : {}) } : {};
    const common = { parent: workflowRef, entities: [workflowRef] };
    stream("agent.queued", { index: i, label, phase: tpl.phase, phase_index: tpl.phaseIndex, model: tpl.model.replace(/^claude-|-5-\d$/g, "") }, { ...common, at: start - 2 });
    stream("agent.started", { index: i, label, phase: tpl.phase, phase_index: tpl.phaseIndex, agent_type: tpl.agentType, model: tpl.model, agent_try: 1 }, { ...common, at: start, ids: { agent_id: id, station, seat }, entities: [workflowRef, `agent:${id}`], inferred, unknown: tpl.agentType ? [] : ["data.agent_type"] });
    const steps = Math.max(1, Math.floor(tpl.toolCalls / progressEvery));
    for (let k = 1; k <= steps; k++) {
      const calls = Math.min(tpl.toolCalls, k * progressEvery);
      if (calls >= tpl.toolCalls) break;
      stream("agent.progressed", { tool_calls: calls, tokens: Math.round((tpl.tokens * calls) / tpl.toolCalls), last_tool: k % 2 ? "Read" : "Bash" }, { ...common, at: start + Math.round((tpl.durationMs * k) / (steps + 1)), ids: { agent_id: id, station, seat }, entities: [workflowRef, `agent:${id}`] });
    }
    const end = start + tpl.durationMs;
    stream("agent.finished", { status: "done", duration_ms: tpl.durationMs, tokens: tpl.tokens, tool_calls: tpl.toolCalls }, { ...common, at: end, ids: { agent_id: id, station, seat }, entities: [workflowRef, `agent:${id}`] });
    agents.push({ id, label, template: tpl, station, seat });
    return end;
  };

  // ---- intake and dispatch
  intake("wave.discovered", { slices: [slice], approval: { approved_at: iso(t0 - 3600_000), by_role: "person" } }, { ids: { slice_id: null, ticket_id: null }, entities: [] });
  t += 1000;
  intake("slice.materialized", { digest: "ab12", adopted: false, dependencies, reissued: null }, { entities: dependencies.map((d) => `dependency:${slice}->${d}`) });
  t += 1000;
  intake("dependency.resolved", { depends_on: dependencies });
  t += 1000;
  intake("work.scheduled", { stage: "planned", risk: "Medium", branch: `feature/${ticket}`, by_role: "supervisor", authorization: "runner" });
  t += 2000;
  intake("work.claimed", { stage: "planned", next: "build", attempt: 1 }, { ids: { execution_id: execution, attempt: 1 }, entities: [`execution:${execution}`], writer: "supervisor" });
  t += 1000;
  intake("execution.started", { until: "merge", workflow: "mach:belt", limits: { minutes: 60, budget_usd: 5 } }, { ids: { execution_id: execution }, entities: [`execution:${execution}`], writer: "supervisor" });
  out.push(ev("execution.process_started", { stream: "execution-record", key: recKey, seq: 1, t, precision: "s", ids: { ticket_id: ticket, execution_id: execution }, entities: [`execution:${execution}`, `cell:${ticket}`] }));
  t += 500;
  stream("session.initialized", { claude_code_version: "2.1.322", model: "claude-opus-5-5", permission_mode: "dontAsk", tools: ["Workflow", "Read"], agents: ["mach:builder", "mach:verifier", "mach:reviewer"] });
  stream("tool.called", { tool: "Workflow", target_class: "workflow", script: null, path_rel: null }, { ids: { agent_id: `${execution}/main`, tool_call_id: `${execution}/toolu_wf` }, entities: [`agent:${execution}/main`, `tool:${execution}/toolu_wf`] });
  stream("workflow.started", { workflow: "belt", tickets: [ticket], until: "merge" }, { entities: [workflowRef], parent: `agent:${execution}/main` });
  stream("workflow.phases_declared", { phases: PHASES.map((title, i) => ({ index: i + 1, title })) }, { entities: [workflowRef] });
  t += 200;
  stream("tool.returned", { status: "ok", duration_ms: 200 }, { ids: { agent_id: `${execution}/main`, tool_call_id: `${execution}/toolu_wf` }, entities: [`agent:${execution}/main`, `tool:${execution}/toolu_wf`] });
  t += 100;

  const clerk = () => {
    t = agent(T.clerk, { start: t + 3 }) + 5;
  };

  // ---- build, round 1
  clerk();
  enter("build", "build", { stage: "building", counts: { tasks: 2 } });
  t = agent(T.build, { start: t + 5, station: "build" });
  life("build.task_completed", { task_id: "T1", kind: "test", step: "red", first_run: "fail", suite: "red", commit: "aaaa111" });
  t += 5;
  life("build.task_completed", { task_id: "T2", kind: "impl", step: "green", first_run: "pass", suite: "green", commit: "bbbb222" });
  t += 5;
  observer("artifact.recorded", { kind: "commit", path_rel: "commit/bbbb222", sha256: null, bytes: null, media_type: null, commit: "bbbb222", nature: "code", integrity: "unchecked" }, { entities: [`artifact:${ticket}:commit/bbbb222`] });
  exit("built", "built", { tasks_done: 2 });

  // ---- verify, round 1: fails
  clerk();
  enter("verify", "verify", { stage: "built", counts: { items: 2 } });
  observer("verify.targets_listed", { targets: [{ id: "AC-01", kind: "scenario" }, { id: "R1", kind: "matrix rule" }], source: "spec.json" });
  t = agent(T.verify, { start: t + 5, station: "verify" });
  life("verify.check_recorded", { target_id: "AC-01", target_kind: "scenario", result: "pass", evidence: [{ file: "evidence/AC-01.png", sha256: "9f2c0a1b3d4e" }], rerecorded: false });
  t += 3;
  life("verify.check_recorded", { target_id: "R1", target_kind: "matrix rule", result: "fail", evidence: [{ file: "evidence/R1.txt", sha256: "1c2d3e4f5a6b" }], rerecorded: false });
  t += 3;
  life("gate.evaluated", { gate: "verify.verdict", verdict: "refused", reason_code: "FAIL_WITH_EVIDENCE", subject: null, status: "FAIL_WITH_EVIDENCE", audit_tier: null, counts: { checks_passed: 1, checks_failed: 1 } }, { entities: [`gate:${ticket}/verification#${round}`] });
  exit("FAIL_WITH_EVIDENCE", "built", { checks_passed: 1, checks_failed: 1 });

  const reviseAndVerify = () => {
    round += 1;
    clerk();
    enter("build", "revise", { stage: "building" });
    t = agent(T.revise, { start: t + 5, station: "build" });
    life("build.task_completed", { task_id: `T${round + 1}`, kind: "impl", step: "green", first_run: "pass", suite: "green", commit: `cccc${round}33` });
    t += 5;
    exit("built", "built");
    clerk();
    enter("verify", "verify", { stage: "built" });
    observer("verify.targets_listed", { targets: [{ id: "AC-01", kind: "scenario" }, { id: "R1", kind: "matrix rule" }], source: "spec.json" });
    t = agent(T.verify, { start: t + 5, station: "verify" });
    for (const target of ["AC-01", "R1"]) {
      life("verify.check_recorded", { target_id: target, target_kind: target === "R1" ? "matrix rule" : "scenario", result: "pass", evidence: [{ file: `evidence/${target}.png`, sha256: "0123456789ab" }], rerecorded: false });
      t += 3;
    }
    life("gate.evaluated", { gate: "verify.verdict", verdict: "passed", reason_code: "PASS", subject: null, status: "PASS", audit_tier: null, counts: { checks_passed: 2, checks_failed: 0 } }, { entities: [`gate:${ticket}/verification#${round}`] });
    exit("PASS", "verified", { checks_passed: 2, checks_failed: 0 });
  };

  const review = (outcome) => {
    clerk();
    enter("review", "review", { stage: "verified", head: `cccc${round}33` });
    const seats = ["architecture", "security", "product"];
    life("review.round_started", { risk: "Medium", max_rounds: 3, tuning: false, approvals_needed: 2, human_approval_required: outcome === "AWAITING_HUMAN", panel: seats.map((seat) => ({ seat, model: "claude-sonnet-5-5" })), delta: round > 1, restarted: false }, { entities: [`gate:${ticket}/review#${round}`, ...seats.map((s) => `seat:${ticket}/review#${round}/${s}`)] });
    t = agent(T.panel, { start: t + 5, station: "review" });
    const start = t + 5;
    let end = start;
    for (const seat of seats) end = Math.max(end, agent(T[seat], { start, station: "review", seat }));
    t = end + 5;
    const rejected = outcome === "REJECTED";
    for (const seat of seats) {
      const vote = rejected && seat === "security" ? "REJECT" : "APPROVE";
      life("review.verdict_submitted", { seat, vote, blockers: vote === "REJECT" ? 1 : 0, notes: 1, rules: vote === "REJECT" ? ["INV-02"] : [], model: "claude-sonnet-5-5" }, { ids: { seat }, entities: [`gate:${ticket}/review#${round}`, `seat:${ticket}/review#${round}/${seat}`] });
      if (vote === "REJECT") observer("review.finding", { seat, n: 1, severity: "blocker", rule: "INV-02", file_rel: "src/invite.ts", title: "Token compared with ==" }, { ids: { seat }, entities: [`finding:${ticket}/r${round}/${seat}/1`, `gate:${ticket}/review#${round}`] });
      t += 2;
    }
    t = agent(T.tally, { start: t + 3, station: "review" });
    life("review.decided", { outcome, approvals: rejected ? 2 : 3, approvals_needed: 2, votes: Object.fromEntries(seats.map((s) => [s, rejected && s === "security" ? "REJECT" : "APPROVE"])), blockers: rejected ? 1 : 0, security_veto: rejected, human_approval_required: outcome === "AWAITING_HUMAN" }, { entities: [`gate:${ticket}/review#${round}`] });
    t += 5;
    exit(outcome, rejected ? "built" : "awaiting-human");
  };

  reviseAndVerify();
  review("REJECTED");
  reviseAndVerify();
  review("AWAITING_HUMAN");
  clerk();
  enter("human-approval", null, { stage: "awaiting-human" });
  intake("human.required", { reason: `${ticket} waits at the human-approval gate.` }, { writer: "supervisor" });

  // ---- the execution ends at the human gate (until: merge, it cannot pass a person)
  t += 2000;
  stream("workflow.finished", { status: "completed", notification_status: "completed", total_tokens: 632068, tool_uses: 200, duration_ms: t - t0, stop_reason: null, workflow_json: true, tickets: [{ ticket, outcome: "stopped", stage: "awaiting-human", waiting_for: "a person", stations: ["build", "verify", "review"] }] }, { entities: [workflowRef] });
  stream("execution.usage", { total_cost_usd: 1.82, subtype: "success", is_error: false, terminal_reason: null, budget_exhausted: false, models: { "claude-sonnet-5-5": { cost_usd: 1.5 } } });
  t += 1000;
  out.push(ev("execution.process_ended", { stream: "execution-record", key: recKey, seq: 2, t, precision: "s", ids: { ticket_id: ticket, execution_id: execution }, entities: [`execution:${execution}`, `cell:${ticket}`], data: { ended: "exited", exit_code: 0, seconds: Math.round((t - t0) / 1000) } }));
  t += 2000;
  intake("execution.completed", { stage: "awaiting-human", next: "stop", waiting_for: "a person", how: "exited", seen_to_end: true, cost_usd: 1.82, refused_tools: [] }, { ids: { execution_id: execution }, entities: [`execution:${execution}`], writer: "supervisor" });

  if (approve) {
    t += 60_000;
    life("human.approval_recorded", { by_role: "person", note_given: false }, { entities: [`gate:${ticket}/human-approval#${round}`] });
    t += 10;
    exit("approved", "approved");
  }
  return { events: out, end: t, agents, intakeSeq: iseq, round };
}

/** Opaque ids from a seeded generator: random lengths, the contract's id alphabet ([A-Za-z0-9._-]), no shape to parse. */
export function seededIds(rand) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
  const word = (min, max) => {
    const n = min + Math.floor(rand() * (max - min + 1));
    let out = "";
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
    return out;
  };
  return { ticket: () => word(3, 14), execution: () => word(5, 20), agent: () => word(1, 24) };
}

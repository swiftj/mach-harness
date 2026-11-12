/**
 * The reducer: scene + event -> next scene. Pure and immutable: it never changes the scene it is
 * given, and it copies only what an event touches, so consecutive scenes share everything else.
 * The engine (engine.ts) runs it once over the whole fixture and keeps every scene.
 */
import type { AnySimEvent } from "./events";
import type { EngineEvent } from "./v3";
import { isV3 } from "./v3";
import type { EntityMeta, SceneProvenance } from "./provenance";
import { COMPLETE, PROVENANCE, SIM_META } from "./provenance";
import { reduceV3 } from "./reduce-v3";
import type {
  AgentState,
  ArtifactState,
  CellState,
  Counters,
  DependencyState,
  ExecutionState,
  GateState,
  ProductDefinitions,
  ReviewRoundState,
  Scene,
  SliceState,
  TaskState,
  ToolCallState,
  VerificationState,
} from "./model";
import { gateId } from "./model";
import { actorOf, emptyActors } from "./actors";
import type { GateKind, SchedulerState } from "./vocabulary";
import { MAX_ROUNDS } from "./vocabulary";

/** The live-only fields of an execution, empty: the simulation never sets them. */
export const EMPTY_EXECUTION_EXTRAS = {
  processStartedAt: null,
  processEndedAt: null,
  ended: null,
  exitCode: null,
  recovery: null,
  workflowId: null,
  workflowStatus: null,
  stopReason: null,
  phases: [],
  queued: {},
  usage: null,
  claudeCodeVersion: null,
  refused: [],
  capacityWait: null,
} as const satisfies Partial<ExecutionState>;

export const EMPTY_COUNTERS: Counters = {
  events: 0,
  agentsActive: 0,
  agentsStarted: 0,
  toolCallsActive: 0,
  toolCalls: 0,
  artifacts: 0,
  commits: 0,
  testRuns: 0,
  checksPassed: 0,
  checksFailed: 0,
  verificationFailures: 0,
  reviewRounds: 0,
  blockers: 0,
  notes: 0,
  humanApprovals: 0,
  merged: 0,
  integrated: 0,
  executionsRunning: 0,
  costUsd: 0,
};

export function emptyScene(definitions: ProductDefinitions, source: SceneProvenance = PROVENANCE.simulation): Scene {
  return {
    provenance: source,
    completeness: COMPLETE,
    cursor: 0,
    at: 0,
    lastSeq: null,
    lastEventId: null,
    project: definitions.project,
    factory: { enabled: false, autonomy: null, enabledBy: null, allowMerge: false, limits: null, runnerId: null, productCommit: null, paused: false },
    supervisor: { lastDecisionAt: null, lastDecision: null, attention: {} },
    waves: {},
    slices: {},
    dependencies: {},
    cells: {},
    executions: {},
    gates: {},
    actors: emptyActors(),
    counters: EMPTY_COUNTERS,
    strayAgents: {},
    capacityWaits: {},
  };
}

// ---------------------------------------------------------------- small immutable helpers

/**
 * Records the reducer created during the current transient run (see beginTransient). Only the log
 * opens one, and only for scenes it discards: a record created and owned by the run may be written
 * in place by a later event of the same run instead of being copied again. Every scene the log keeps
 * or hands out is sealed first (endTransient), so no scene anyone holds is ever changed.
 */
let owned: WeakSet<object> | null = null;

/** Start a run in which the reducer may update the records it created itself in place. */
export function beginTransient(): void {
  owned = new WeakSet();
}
/** Seal everything created so far: from now on, every update copies again. */
export function endTransient(): void {
  owned = null;
}

export const put = <T>(record: Readonly<Record<string, T>>, key: string, value: T): Readonly<Record<string, T>> => {
  if (owned && owned.has(record)) {
    (record as Record<string, T>)[key] = value;
    return record;
  }
  const copy = { ...record, [key]: value };
  if (owned) owned.add(copy);
  return copy;
};
export const replaceLast = <T>(list: readonly T[], match: (item: T) => boolean, update: (item: T) => T): readonly T[] => {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as T;
    if (match(item)) {
      const copy = list.slice();
      copy[i] = update(item);
      return copy;
    }
  }
  return list;
};
export const bump = (counters: Counters, changes: Partial<Record<keyof Counters, number>>): Counters => {
  const next = { ...counters };
  for (const key of Object.keys(changes) as Array<keyof Counters>) next[key] = Math.round((next[key] + (changes[key] ?? 0)) * 100) / 100;
  return next;
};

export function withSlice(scene: Scene, id: string | null, update: (slice: SliceState) => SliceState): Scene {
  const slice = id ? scene.slices[id] : undefined;
  return slice ? { ...scene, slices: put(scene.slices, slice.id, update(slice)) } : scene;
}
export function withCell(scene: Scene, ticket: string | null, update: (cell: CellState) => CellState): Scene {
  const cell = ticket ? scene.cells[ticket] : undefined;
  return cell ? { ...scene, cells: put(scene.cells, cell.ticketId, update(cell)) } : scene;
}
export function withAgent(cell: CellState, agentId: string, update: (agent: AgentState) => AgentState): CellState {
  const agent = cell.agents[agentId];
  return agent ? { ...cell, agents: put(cell.agents, agentId, update(agent)) } : cell;
}
export function withExecution(scene: Scene, id: string | null, update: (execution: ExecutionState) => ExecutionState): Scene {
  const execution = id ? scene.executions[id] : undefined;
  return execution ? { ...scene, executions: put(scene.executions, execution.id, update(execution)) } : scene;
}
export function setGate(
  scene: Scene,
  ticket: string,
  gate: GateKind,
  round: number | null,
  state: GateState["state"],
  detail: string,
  t: number,
  seq: number,
  meta: EntityMeta = SIM_META,
  reasonCode: string | null = null,
): Scene {
  const id = gateId(ticket, gate, round ?? undefined);
  const before = scene.gates[id];
  const decided = state === "open" || state === "waiting" ? null : t;
  const next: GateState = before
    ? { ...before, state, detail, decidedAt: decided, seq, meta, reasonCode: reasonCode ?? before.reasonCode }
    : { id, ticketId: ticket, gate, round, state, detail, openedAt: t, decidedAt: decided, seq, reasonCode, meta };
  return { ...scene, gates: put(scene.gates, id, next) };
}
export function schedule(slice: SliceState, state: SchedulerState, t: number, seq: number, reasons?: readonly string[]): SliceState {
  if (slice.scheduler === state && !reasons) return slice;
  return {
    ...slice,
    scheduler: state,
    reasons: reasons ?? slice.reasons,
    since: slice.scheduler === state ? slice.since : t,
    history: slice.scheduler === state ? slice.history : [...slice.history, { state, at: t, seq }],
  };
}

export function newCell(ticketId: string, sliceId: string, definitions: ProductDefinitions, t: number, meta: EntityMeta = SIM_META): CellState {
  const def = definitions.slices[sliceId];
  return {
    ticketId,
    sliceId,
    title: def?.title ?? sliceId,
    risk: def?.risk ?? "Medium",
    appType: def?.appType ?? "web",
    branch: `feature/${ticketId}`,
    stage: "interview",
    observedStage: null,
    stageHistory: [],
    station: null,
    action: null,
    stationSince: null,
    visits: [],
    round: 1,
    loop: 0,
    executionId: null,
    workflowPhase: null,
    suite: "unknown",
    lastTest: null,
    testsRun: 0,
    tasks: [],
    verifications: [],
    reviews: [],
    agents: {},
    agentOrder: [],
    activeAgentIds: [],
    artifacts: [],
    merged: null,
    archived: null,
    openedAt: t,
    cellInstance: null,
    gateLog: [],
    capacityWait: null,
    runRecord: null,
    historyBegan: null,
    meta,
  };
}

// ---------------------------------------------------------------- the reducer

/**
 * The one reducer. It takes the simulation's events (factory-event v2 plus `t`) and the observer's
 * version 3 events (v3.ts), distinguished by `schema_version`, and builds the one Scene type from
 * either. The version 3 cases live in reduce-v3.ts for size; this is their only entry point.
 */
export function reduce(scene: Scene, event: EngineEvent, definitions: ProductDefinitions): Scene {
  if (isV3(event)) return reduceV3(scene, event, definitions);
  return reduceSim(scene, event, definitions);
}

function reduceSim(scene: Scene, event: AnySimEvent, definitions: ProductDefinitions): Scene {
  const actor = actorOf(event);
  if (!actor) return reduceEvent(scene, event, definitions);
  const next = reduceEvent(scene, event, definitions);
  const before = next.actors[actor];
  return { ...next, actors: { ...next.actors, [actor]: { ...before, acts: before.acts + 1, lastActedAt: event.t, lastSeq: event.seq, lastKind: event.type } } };
}

function reduceEvent(scene: Scene, event: AnySimEvent, definitions: ProductDefinitions): Scene {
  const t = event.t;
  const seq = event.seq;
  let s: Scene = { ...scene, cursor: scene.cursor + 1, at: t, lastSeq: seq, lastEventId: `sim:${seq}`, counters: bump(scene.counters, { events: 1 }) };
  const ticket = event.ticket_id;
  // intake.py open_cell writes the cell's files and finalizes it before it records work.scheduled.
  if (ticket && !s.cells[ticket] && (event.type === "artifact.written" || event.type === "cell.stage_changed")) {
    s = { ...s, cells: put(s.cells, ticket, newCell(ticket, event.slice_id ?? "", definitions, t)) };
  }

  switch (event.type) {
    // ------------------------------------------------ activation and intake
    case "factory.activated": {
      const d = event.data;
      return { ...s, factory: { ...s.factory, enabled: true, autonomy: d.autonomy, enabledBy: d.by, allowMerge: d.allow_merge, limits: d.limits, runnerId: event.runner_id } };
    }
    case "factory.disabled":
      return { ...s, factory: { ...s.factory, enabled: false } };
    case "revision.discovered":
      return { ...s, factory: { ...s.factory, productCommit: event.data.commit } };
    case "wave.discovered": {
      const id = event.wave_id ?? "";
      const def = definitions.waves[id];
      return {
        ...s,
        waves: put(s.waves, id, {
          id,
          title: def?.title ?? id,
          epicTitle: def?.epicTitle ?? "",
          revision: event.revision,
          sliceIds: event.data.slices,
          approvedBy: event.data.approval.actor,
          approvedAt: event.data.approval.approved_at,
          state: "discovered",
          discoveredAt: t,
          seq,
          meta: SIM_META,
        }),
      };
    }
    case "intake.validated": {
      const wave = s.waves[event.wave_id ?? ""];
      return wave ? { ...s, waves: put(s.waves, wave.id, { ...wave, state: "validated" }) } : s;
    }
    case "slice.materialized": {
      const id = event.slice_id ?? "";
      const def = definitions.slices[id];
      const dependsOn = event.data.dependencies;
      const slice: SliceState = {
        id,
        title: def?.title ?? id,
        summary: def?.summary ?? "",
        waveId: event.wave_id ?? "",
        revision: event.revision,
        risk: def?.risk ?? "Medium",
        ticketId: ticket ?? "",
        dependsOn,
        scheduler: "materialized",
        reasons: [],
        since: t,
        integratedCommit: null,
        history: [{ state: "materialized", at: t, seq }],
        meta: SIM_META,
      };
      let dependencies = s.dependencies;
      for (const to of dependsOn) {
        const key = `${id}->${to}`;
        const done = s.slices[to]?.scheduler === "integrated";
        const edge: DependencyState = { id: key, from: id, to, state: done ? "satisfied" : "blocking", satisfiedAt: done ? t : null, satisfiedSeq: done ? seq : null, meta: SIM_META };
        dependencies = put(dependencies, key, edge);
      }
      return { ...s, slices: put(s.slices, id, slice), dependencies };
    }
    case "dependency.resolved":
      return withSlice(s, event.slice_id, (slice) => schedule(slice, "eligible", t, seq, ["Everything it depends on is integrated." + (slice.dependsOn.length ? "" : " It depends on nothing.")]));
    case "dependency.blocked":
      return withSlice(s, event.slice_id, (slice) => schedule(slice, slice.scheduler === "dispatched" ? "dispatched" : "waiting-on-dependency", t, seq, event.data.reasons));
    case "work.scheduled": {
      s = withSlice(s, event.slice_id, (slice) => schedule(slice, "dispatched", t, seq, [`Dispatched by ${event.data.by}.`]));
      const id = ticket ?? "";
      const existing = s.cells[id] ?? newCell(id, event.slice_id ?? "", definitions, t);
      const cell: CellState = { ...existing, risk: event.data.risk, branch: event.data.branch, stage: existing.stageHistory.length ? existing.stage : event.data.stage };
      return { ...s, cells: put(s.cells, id, cell) };
    }
    case "slice.integrated": {
      s = withSlice(s, event.slice_id, (slice) => ({ ...schedule(slice, "integrated", t, seq, [`Its work is on the integration branch (${event.data.commit.slice(0, 12)}).`]), integratedCommit: event.data.commit }));
      let dependencies = s.dependencies;
      for (const edge of Object.values(s.dependencies)) {
        if (edge.to === event.slice_id && edge.state !== "satisfied") dependencies = put(dependencies, edge.id, { ...edge, state: "satisfied", satisfiedAt: t, satisfiedSeq: seq });
      }
      return { ...s, dependencies, counters: bump(s.counters, { integrated: 1 }) };
    }
    case "human.required": {
      const key = ticket ?? event.slice_id ?? "factory";
      s = { ...s, supervisor: { ...s.supervisor, attention: put(s.supervisor.attention, key, { reason: event.data.reason, at: t, seq }) } };
      if (ticket && /human-approval/.test(event.data.reason)) {
        const cell = s.cells[ticket];
        const round = cell?.round ?? null;
        s = setGate(s, ticket, "human-approval", round, "waiting", event.data.reason, t, seq);
      }
      return s;
    }
    case "scheduling.decided": {
      const d = event.data;
      return {
        ...s,
        supervisor: {
          ...s.supervisor,
          lastDecisionAt: t,
          lastDecision: { dispatched: d.dispatched, started: d.started, held: d.held.map((h) => ({ id: h.slice_id ?? h.ticket_id ?? "", why: h.why })) },
        },
      };
    }
    // ------------------------------------------------ executions and the workflow
    case "work.claimed": {
      const id = event.execution_id ?? "";
      const execution: ExecutionState = {
        id,
        ticketId: ticket ?? "",
        sliceId: event.slice_id,
        state: "claimed",
        attempt: event.data.attempt,
        next: event.data.next,
        stageAtStart: event.data.stage,
        sessionId: null,
        workflow: null,
        workflowRunning: false,
        phase: null,
        claimedAt: t,
        startedAt: null,
        workflowFinishedAt: null,
        endedAt: null,
        outcome: null,
        ...EMPTY_EXECUTION_EXTRAS,
        meta: SIM_META,
      };
      s = { ...s, executions: put(s.executions, id, execution) };
      return withCell(s, ticket, (cell) => ({ ...cell, executionId: id }));
    }
    case "execution.started":
      s = withExecution(s, event.execution_id, (x) => ({ ...x, state: "running", startedAt: t, sessionId: event.data.session_id, workflow: event.data.workflow }));
      return { ...s, counters: bump(s.counters, { executionsRunning: 1 }) };
    case "execution.completed":
    case "execution.failed": {
      const failed = event.type === "execution.failed";
      s = withExecution(s, event.execution_id, (x) => ({
        ...x,
        state: failed ? "failed" : "completed",
        endedAt: t,
        workflowRunning: false,
        outcome: {
          stage: event.data.stage,
          next: event.data.next,
          waitingFor: event.type === "execution.completed" ? event.data.waiting_for : null,
          costUsd: event.type === "execution.completed" ? event.data.cost_usd : 0,
        },
      }));
      return { ...s, counters: bump(s.counters, { executionsRunning: -1, costUsd: event.type === "execution.completed" ? event.data.cost_usd : 0 }) };
    }
    case "workflow.started":
      return withExecution(s, event.execution_id, (x) => ({ ...x, workflowRunning: true, workflow: event.data.workflow }));
    case "workflow.phase":
      s = withExecution(s, event.execution_id, (x) => ({ ...x, phase: event.data.phase }));
      return withCell(s, ticket, (cell) => ({ ...cell, workflowPhase: event.data.phase }));
    case "workflow.finished":
      s = withExecution(s, event.execution_id, (x) => ({ ...x, workflowRunning: false, workflowFinishedAt: t }));
      return withCell(s, ticket, (cell) => ({ ...cell, workflowPhase: null }));
    case "station.observed":
      return withCell(s, ticket, (cell) => ({ ...cell, observedStage: event.data.stage }));
    // ------------------------------------------------ stations and stages
    case "station.entered": {
      const d = event.data;
      // The scene's meaning is the lifecycle log's: a visit belongs to the judging round it starts. The
      // simulation records a revision under the round it revises (build.revised moves the round on
      // after it), so a revise visit is converted here, at the simulation's edge, to the round it starts.
      const round = d.action === "revise" ? Math.min(d.round + 1, MAX_ROUNDS) : d.round;
      return withCell(s, ticket, (cell) => ({
        ...cell,
        station: d.station,
        action: d.action,
        stationSince: t,
        visits: [...cell.visits, { station: d.station, action: d.action, round, enteredAt: t, enteredSeq: seq, leftAt: null, outcome: null, visitId: null, outcomeWord: null, durationMs: null, meta: SIM_META }],
      }));
    }
    case "station.left":
      return withCell(s, ticket, (cell) => ({
        ...cell,
        station: null,
        action: null,
        stationSince: null,
        visits: replaceLast(cell.visits, (v) => v.leftAt === null, (v) => ({ ...v, leftAt: t, outcome: event.data.outcome })),
      }));
    case "cell.stage_changed":
      return withCell(s, ticket, (cell) => ({ ...cell, stage: event.data.to, stageHistory: [...cell.stageHistory, { stage: event.data.to, at: t, seq, by: event.data.by }] }));
    // ------------------------------------------------ agents and tools
    case "agent.started": {
      const d = event.data;
      const agent: AgentState = {
        id: d.agent_id,
        ticketId: ticket ?? "",
        executionId: event.execution_id,
        role: d.role,
        agentType: d.agent_type,
        seat: d.seat,
        tier: d.tier,
        model: d.model,
        effort: d.effort,
        label: d.label,
        parentId: d.parent_agent_id,
        phase: d.phase,
        station: d.station,
        status: "running",
        startedAt: t,
        startedSeq: seq,
        finishedAt: null,
        summary: null,
        currentToolCallId: null,
        toolCalls: [],
        lifecycle: "running",
        observation: "per-call",
        toolCallCount: 0,
        lastTool: null,
        tokens: null,
        durationMs: null,
        refused: [],
        workflowId: null,
        index: null,
        modelName: d.model,
        meta: SIM_META,
      };
      s = withCell(s, ticket, (cell) => {
        let next: CellState = { ...cell, agents: put(cell.agents, agent.id, agent), agentOrder: [...cell.agentOrder, agent.id], activeAgentIds: [...cell.activeAgentIds, agent.id] };
        if (agent.role === "reviewer" && agent.seat) {
          next = { ...next, reviews: replaceLast(next.reviews, () => true, (r) => ({ ...r, seats: r.seats.map((seat) => (seat.seat === agent.seat ? { ...seat, agentId: agent.id } : seat)) })) };
        }
        return next;
      });
      return { ...s, counters: bump(s.counters, { agentsActive: 1, agentsStarted: 1 }) };
    }
    case "agent.finished":
      s = withCell(s, ticket, (cell) => ({
        ...withAgent(cell, event.data.agent_id, (a) => ({
          ...a,
          status: event.data.outcome === "error" ? "error" : "done",
          lifecycle: event.data.outcome === "error" ? "error" : "done",
          finishedAt: t,
          durationMs: t - a.startedAt,
          summary: event.data.summary,
          currentToolCallId: null,
        })),
        activeAgentIds: cell.activeAgentIds.filter((id) => id !== event.data.agent_id),
      }));
      return { ...s, counters: bump(s.counters, { agentsActive: -1 }) };
    case "tool.started": {
      const d = event.data;
      const call: ToolCallState = {
        id: d.call_id,
        agentId: d.agent_id,
        ticketId: ticket ?? "",
        tool: d.tool,
        target: d.target,
        startedAt: t,
        startedSeq: seq,
        finishedAt: null,
        status: "running",
        result: "running",
        summary: null,
        artifactIds: [],
        toolName: d.tool,
        meta: SIM_META,
      };
      s = withCell(s, ticket, (cell) => withAgent(cell, d.agent_id, (a) => ({ ...a, currentToolCallId: call.id, toolCalls: [...a.toolCalls, call], toolCallCount: a.toolCalls.length + 1, lastTool: d.tool })));
      return { ...s, counters: bump(s.counters, { toolCallsActive: 1, toolCalls: 1 }) };
    }
    case "tool.finished": {
      const d = event.data;
      s = withCell(s, ticket, (cell) =>
        withAgent(cell, d.agent_id, (a) => ({
          ...a,
          currentToolCallId: a.currentToolCallId === d.call_id ? null : a.currentToolCallId,
          toolCalls: replaceLast(a.toolCalls, (c) => c.id === d.call_id, (c) => ({ ...c, finishedAt: t, status: d.ok ? "ok" : "error", result: d.ok ? "ok" : "error", summary: d.summary })),
        })),
      );
      return { ...s, counters: bump(s.counters, { toolCallsActive: -1 }) };
    }
    case "artifact.written": {
      const d = event.data;
      const artifact: ArtifactState = {
        id: d.artifact_id,
        ticketId: ticket ?? "",
        kind: d.kind,
        path: d.path,
        label: d.label,
        station: d.station,
        round: d.round,
        version: d.version,
        sha: d.sha,
        summary: d.summary,
        writer: { agentId: d.writer.agent_id, callId: d.writer.call_id, script: d.writer.script },
        writtenAt: t,
        seq,
        record: null,
        meta: SIM_META,
      };
      s = withCell(s, ticket, (cell) => {
        const index = cell.artifacts.findIndex((a) => a.id === artifact.id);
        const artifacts = index >= 0 ? cell.artifacts.map((a, i) => (i === index ? artifact : a)) : [...cell.artifacts, artifact];
        let next: CellState = { ...cell, artifacts };
        const agentId = d.writer.agent_id;
        const callId = d.writer.call_id;
        if (agentId && callId) {
          next = withAgent(next, agentId, (a) => ({ ...a, toolCalls: replaceLast(a.toolCalls, (c) => c.id === callId, (c) => ({ ...c, artifactIds: [...c.artifactIds, artifact.id] })) }));
        }
        return next;
      });
      return { ...s, counters: bump(s.counters, { artifacts: 1, commits: d.kind === "commit" || d.kind === "merge-commit" ? 1 : 0 }) };
    }
    // ------------------------------------------------ gates and the build
    case "gate.checked":
      return setGate(s, ticket ?? "", event.data.gate, null, event.data.passed ? "passed" : "failed", event.data.detail, t, seq);
    case "task.started": {
      const d = event.data;
      const task: TaskState = { id: d.task_id, kind: d.kind, text: d.text, files: d.files, ids: d.ids, loop: d.loop, status: "active", startedAt: t, doneAt: null, commit: null, meta: SIM_META };
      return withCell(s, ticket, (cell) => ({ ...cell, tasks: [...cell.tasks, task] }));
    }
    case "task.red":
    case "task.green":
    case "task.done": {
      const status = event.type === "task.red" ? "red" : event.type === "task.green" ? "green" : "done";
      s = withCell(s, ticket, (cell) => ({ ...cell, tasks: replaceLast(cell.tasks, (x) => x.id === event.data.task_id, (x) => ({ ...x, status, doneAt: t, commit: event.data.commit })) }));
      if (event.type === "task.done") return s;
      const cell = ticket ? s.cells[ticket] : undefined;
      const reds = cell?.tasks.filter((x) => x.status === "red").length ?? 0;
      const greens = cell?.tasks.filter((x) => x.status === "green").length ?? 0;
      return setGate(s, ticket ?? "", "red-before-green", null, "passed", `${reds} test task(s) seen failing first; ${greens} implementation task(s) green.`, t, seq);
    }
    case "test.result": {
      const d = event.data;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        suite: d.failed > 0 ? "red" : "green",
        testsRun: cell.testsRun + 1,
        lastTest: { context: d.context, command: d.command, passed: d.passed, failed: d.failed, skipped: d.skipped, seconds: d.seconds, at: t, taskId: d.task_id },
      }));
      return { ...s, counters: bump(s.counters, { testRuns: 1 }) };
    }
    case "build.revised":
      return withCell(s, ticket, (cell) => ({ ...cell, loop: event.data.loop, round: Math.min(event.data.round, MAX_ROUNDS) }));
    // ------------------------------------------------ verification
    case "verification.started": {
      const d = event.data;
      const v: VerificationState = {
        round: d.round,
        status: "running",
        startedAt: t,
        decidedAt: null,
        requiredEvidence: d.required_evidence,
        checks: d.targets.map((x) => ({ targetId: x.id, targetKind: x.kind, title: x.title, result: "pending", evidence: [], note: null, at: null })),
        listed: { eventId: `sim:${seq}`, authority: "simulated", count: d.targets.length, late: false },
      };
      s = withCell(s, ticket, (cell) => ({ ...cell, verifications: [...cell.verifications, v] }));
      return setGate(s, ticket ?? "", "verification", d.round, "open", `${d.targets.length} checks to prove`, t, seq);
    }
    case "evidence.captured": {
      const d = event.data;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        verifications: replaceLast(cell.verifications, (v) => v.round === d.round, (v) => ({
          ...v,
          checks: v.checks.map((c) => (c.targetId === d.target_id ? { ...c, result: d.result, evidence: d.evidence, note: d.note, at: t } : c)),
        })),
      }));
      return { ...s, counters: bump(s.counters, d.result === "pass" ? { checksPassed: 1 } : { checksFailed: 1 }) };
    }
    case "verification.verdict": {
      const d = event.data;
      s = withCell(s, ticket, (cell) => ({ ...cell, verifications: replaceLast(cell.verifications, (v) => v.round === d.round, (v) => ({ ...v, status: d.status, decidedAt: t })) }));
      s = setGate(s, ticket ?? "", "verification", d.round, d.status === "PASS" ? "passed" : "failed", `${d.status}: ${d.checks_passed} passed, ${d.checks_failed} failed`, t, seq);
      return d.status === "PASS" ? s : { ...s, counters: bump(s.counters, { verificationFailures: 1 }) };
    }
    // ------------------------------------------------ review
    case "review.started": {
      const d = event.data;
      const round: ReviewRoundState = {
        round: d.round,
        risk: d.risk,
        approvalsNeeded: d.approvals_needed,
        humanApprovalRequired: d.human_approval_required,
        humanApprovalReasons: d.human_approval_reasons,
        delta: d.delta ? { sinceCommit: d.delta.since_commit, filesChanged: d.delta.files_changed, earlierBlockerFiles: d.delta.earlier_blocker_files } : null,
        isDelta: d.delta !== null,
        seats: d.panel.map((p) => ({ seat: p.role, model: p.model, agentId: null, vote: null, votedAt: null, votedEventId: null, votedLate: false })),
        findings: [],
        startedAt: t,
        outcome: null,
        decidedAt: null,
        approvals: null,
        overruledBlockersFrom: [],
        humanApproval: null,
        eventId: `sim:${seq}`,
        late: false,
        decidedEventId: null,
        decidedLate: false,
      };
      s = withCell(s, ticket, (cell) => ({ ...cell, reviews: [...cell.reviews, round] }));
      s = setGate(s, ticket ?? "", "review", d.round, "open", `${d.panel.length} seat(s), ${d.approvals_needed} approval(s) needed`, t, seq);
      return { ...s, counters: bump(s.counters, { reviewRounds: 1 }) };
    }
    case "review.finding": {
      const d = event.data;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => r.round === d.round, (r) => ({
          ...r,
          findings: [...r.findings, { id: d.finding_id, round: d.round, seat: d.seat, severity: d.severity, title: d.title, rule: d.rule, file: d.file, at: t, outvoted: false, meta: SIM_META }],
        })),
      }));
      return { ...s, counters: bump(s.counters, d.severity === "blocker" ? { blockers: 1 } : { notes: 1 }) };
    }
    case "review.vote": {
      const d = event.data;
      return withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => r.round === d.round, (r) => ({ ...r, seats: r.seats.map((seat) => (seat.seat === d.seat ? { ...seat, vote: d.vote, votedAt: t, votedEventId: `sim:${seq}` } : seat)) })),
      }));
    }
    case "review.decided": {
      const d = event.data;
      const passed = d.outcome === "APPROVED" || d.outcome === "AWAITING_HUMAN";
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => r.round === d.round, (r) => ({
          ...r,
          outcome: d.outcome,
          decidedAt: t,
          decidedEventId: `sim:${seq}`,
          approvals: d.approvals,
          overruledBlockersFrom: d.overruled_blockers_from,
          findings: r.findings.map((f) => (passed && f.severity === "blocker" ? { ...f, outvoted: true } : f)),
        })),
      }));
      s = setGate(s, ticket ?? "", "review", d.round, passed ? "passed" : "failed", `${d.outcome}: ${d.approvals} approved, ${d.approvals_needed} needed`, t, seq);
      if (d.outcome === "AWAITING_HUMAN") s = setGate(s, ticket ?? "", "human-approval", d.round, "waiting", "The panel approved; a person must approve before merge.", t, seq);
      return s;
    }
    case "human.approval_recorded": {
      const d = event.data;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => r.round === d.round, (r) => ({ ...r, outcome: "APPROVED", humanApproval: { by: d.by, note: d.note, at: t, eventId: `sim:${seq}`, late: false } })),
      }));
      const attention = { ...s.supervisor.attention };
      if (ticket) delete attention[ticket];
      s = { ...s, supervisor: { ...s.supervisor, attention } };
      s = setGate(s, ticket ?? "", "human-approval", d.round, "passed", `Approved by ${d.by}`, t, seq);
      return { ...s, counters: bump(s.counters, { humanApprovals: 1 }) };
    }
    // ------------------------------------------------ merge and cleanup
    case "merge.revalidated":
      return setGate(s, ticket ?? "", "merge-revalidation", null, event.data.needed ? "passed" : "skipped", event.data.note, t, seq);
    case "merge.completed":
      s = withCell(s, ticket, (cell) => ({ ...cell, merged: { commit: event.data.merge_commit, at: t, revalidated: event.data.revalidated } }));
      return { ...s, counters: bump(s.counters, { merged: 1 }) };
    case "cleanup.completed":
      return withCell(s, ticket, (cell) => ({ ...cell, archived: { archive: event.data.archive, at: t } }));
    default:
      return s;
  }
}

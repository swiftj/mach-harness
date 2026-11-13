/**
 * The reducer's version 3 cases: the observer's normalised events (docs/mach-next/M6_1_EVENT_CONTRACT.md
 * section 11) applied to the same Scene the simulation builds. Called only from reduce() in
 * reducer.ts; pure and structurally shared like the rest of it.
 *
 * What it holds to:
 * - Nothing is invented. A value that applies but is not recorded keeps the scene's placeholder and is
 *   named in the entity's `meta.unknown`; a value read from a worker's label is named in
 *   `meta.inferred`. Views must read the meta before drawing a placeholder.
 * - Ids are opaque. Agent, tool and execution ids are never parsed; an agent's ticket, station and
 *   seat come from the event's `ids`, a finding's and an artifact's ids from the event's `entities`.
 * - Workflow agents are counted, not ticked (contract D13, 8.1): `observation: "count-only"`, an
 *   empty `toolCalls`, and `toolCallCount`, `lastTool`, `tokens` from snapshots.
 * - Spans use measured times (`occurred_at`); `t` (order_ms) only places the event.
 * - `seq` fields hold the event's `pos`, stable under late insertion; links use event ids.
 */
import type { FactoryLimits, StationOutcome } from "./events";
import type {
  AgentState,
  ArtifactState,
  CellState,
  DependencyState,
  ExecutionState,
  FindingState,
  ProductDefinitions,
  QueuedAgentState,
  ReviewRoundState,
  Scene,
  SliceState,
  TaskState,
  ToolCallState,
  VerificationState,
} from "./model";
import { gateId } from "./model";
import type { Authority, EntityMeta, HistoryGapState } from "./provenance";
import type { AnyV3Event, FactoryEventV3, UnknownV3Event, V3DataMap } from "./v3";
import { isEntityRefString, isKnownV3Kind, occurredMs, timeQualityOf } from "./v3";
import type { AgentRole, AppType, ArtifactKind, BeltPhase, CellStage, ModelId, Risk, StationId, StepAction, ToolName } from "./vocabulary";
import { ARTIFACT_KINDS, BELT_PHASES, CELL_STAGES, MAX_ROUNDS, RISKS, TOOLS } from "./vocabulary";
import { bump, EMPTY_EXECUTION_EXTRAS, newCell, put, replaceLast, schedule, setGate, withAgent, withCell, withExecution, withSlice } from "./reducer";

type E<K extends keyof V3DataMap> = FactoryEventV3<K>;

// ---------------------------------------------------------------- provenance helpers

function metaOf(e: Pick<FactoryEventV3, "authority" | "id" | "time" | "unknown" | "inferred" | "late">, extra: Partial<EntityMeta> = {}): EntityMeta {
  return {
    authority: e.authority as Authority,
    eventId: e.id,
    fields: {},
    unknown: [],
    inferred: {},
    start: timeQualityOf(e.time.precision),
    end: "unknown",
    late: e.late === true,
    ...extra,
  };
}

/** The entity's meta after a later event touched it: authority, event and lateness move on; what is unknown or inferred is kept unless resolved. */
function touch(prev: EntityMeta, e: Pick<FactoryEventV3, "authority" | "id" | "late">, patch: Partial<EntityMeta> = {}): EntityMeta {
  return { ...prev, authority: e.authority as Authority, eventId: e.id, late: e.late === true, ...patch };
}

/** The union of two id lists in order of first sight: everything already held keeps its place. */
function union(held: readonly string[], more: readonly string[]): readonly string[] {
  const added = more.filter((id, i) => !held.includes(id) && more.indexOf(id) === i);
  return added.length ? [...held, ...added] : held;
}

/** A recorded risk reaches the cell's slice too: the slice's risk is the cell's once one is recorded. */
function withSliceRisk(s: Scene, sliceId: string | null | undefined, risk: SliceState["risk"] | null, e: AnyV3Event): Scene {
  if (!risk) return s;
  return withSlice(s, sliceId ?? null, (slice) => (slice.risk === risk && isKnownField(slice.meta, "risk") ? slice : { ...slice, risk, meta: { ...slice.meta, unknown: without(slice.meta.unknown, "risk"), fields: { ...slice.meta.fields, risk: e.authority as Authority } } }));
}
const isKnownField = (meta: EntityMeta, field: string): boolean => !meta.unknown.includes(field);

const without = (list: readonly string[], ...names: string[]): readonly string[] => (names.some((n) => list.includes(n)) ? list.filter((x) => !names.includes(x)) : list);
const withAll = (list: readonly string[], ...names: string[]): readonly string[] => {
  const missing = names.filter((n) => !list.includes(n));
  return missing.length ? [...list, ...missing] : list;
};

/** When the fact happened, if measured; otherwise where it is placed (and the caller marks it inferred). */
function when(e: Pick<FactoryEventV3, "time">): number {
  return occurredMs(e) ?? e.time.order_ms;
}

// ---------------------------------------------------------------- vocabulary mappings (recorded words, never ids)

/** The four model tiers, from a recorded model name or alias. Null when it is none of them. */
export function modelIdOf(name: string | null | undefined): ModelId | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const id of ["fable", "opus", "sonnet", "haiku"] as const) if (lower.includes(id)) return id;
  return null;
}

const AGENT_TYPE_ROLE: Readonly<Record<string, AgentRole>> = {
  "mach:builder": "builder",
  "mach-builder": "builder",
  "mach:verifier": "verifier",
  "mach-verifier": "verifier",
  "mach:reviewer": "reviewer",
  "mach-reviewer": "reviewer",
  "mach:contract-engineer": "contract-engineer",
  "mach-contract-engineer": "contract-engineer",
};
const STATION_ROLE: Partial<Record<StationId, AgentRole>> = { groom: "intent", plan: "intent", audit: "audit", merge: "merge", cleanup: "cleanup", observe: "observe" };

function roleOf(agentType: string | null, station: StationId | null): { role: AgentRole; rule: string | null } {
  if (agentType && AGENT_TYPE_ROLE[agentType]) return { role: AGENT_TYPE_ROLE[agentType] as AgentRole, rule: null };
  if (station && STATION_ROLE[station]) return { role: STATION_ROLE[station] as AgentRole, rule: "station" };
  return { role: "clerk", rule: agentType ? "unrecognised-agent-type" : "no-agent-type" };
}

function toolOf(name: string): { tool: ToolName; known: boolean } {
  return (TOOLS as readonly string[]).includes(name) ? { tool: name as ToolName, known: true } : { tool: "Bash", known: false };
}

function artifactKindOf(kind: string): { kind: ArtifactKind; known: boolean } {
  return (ARTIFACT_KINDS as readonly string[]).includes(kind) ? { kind: kind as ArtifactKind, known: true } : { kind: "evidence", known: false };
}

function stageOf(stage: string | null | undefined): CellStage | null {
  return stage && (CELL_STAGES as readonly string[]).includes(stage) ? (stage as CellStage) : null;
}

const DEFAULT_ACTION: Partial<Record<StationId, StepAction>> = { audit: "audit", groom: "groom", plan: "plan", build: "build", verify: "verify", review: "review", merge: "merge", cleanup: "cleanup" };

/**
 * A visit's action when its record names none. A station's own action is identity (the build
 * station builds); the human-approval gate is where run.py answers `stop` (awaiting-human: stop, a
 * person decides), so that visit's action is `stop`, never a station's work. For a station with no
 * action of its own the action is `stop` and listed as not recorded.
 */
function actionOf(recorded: StepAction | null, station: StationId): { action: StepAction; unknown: boolean; rule: string | null } {
  if (recorded) return { action: recorded, unknown: false, rule: null };
  const own = DEFAULT_ACTION[station];
  if (own) return { action: own, unknown: false, rule: "station" };
  if (station === "human-approval") return { action: "stop", unknown: false, rule: "awaiting-human" };
  return { action: "stop", unknown: true, rule: null };
}

/** A station's own outcome word mapped onto the simulation's vocabulary; the word itself is kept verbatim beside it. */
function outcomeOf(word: string): StationOutcome {
  switch (word) {
    case "PASS":
    case "passed":
      return "passed";
    case "FAIL_WITH_EVIDENCE":
    case "INCOMPLETE_EVIDENCE":
    case "failed":
    case "refused":
      return "failed";
    case "APPROVED":
    case "approved":
      return "approved";
    case "REJECTED":
    case "rejected":
      return "rejected";
    case "AWAITING_HUMAN":
    case "awaiting-human":
      return "awaiting-human";
    case "merged":
      return "merged";
    case "archived":
      return "archived";
    case "escalated":
    case "ESCALATE":
    case "stopped":
    case "spec-open":
      return "stopped";
    default:
      return "done";
  }
}

const firstRef = (e: Pick<FactoryEventV3, "entities">, kind: string): string | null => {
  const prefix = `${kind}:`;
  const found = e.entities.find((r) => r.startsWith(prefix) && isEntityRefString(r));
  return found ? found.slice(prefix.length) : null;
};

// ---------------------------------------------------------------- cells and executions met before their opening event

const CELL_PLACEHOLDERS = ["title", "summary", "risk", "appType"] as const;

/**
 * The cell an event belongs to, opened from this event if it has not been seen (hand-driven tickets,
 * AUTO-*, late observers). Only records that name the ticket themselves open a cell: an agent's
 * label never does (D15). A cell opened without a slice takes the slice a record already linked to
 * its ticket (slice.materialized), so the link does not depend on which arrived first (D5). Agents
 * met before their cell (stray) are adopted when it opens.
 */
function ensureCell(s: Scene, e: AnyV3Event, definitions: ProductDefinitions): Scene {
  const ticket = e.ids.ticket_id;
  if (!ticket || s.cells[ticket]) return s;
  const named = e.ids.slice_id && !labelled(e, "slice_id") ? e.ids.slice_id : "";
  const sliceId = named || (Object.values(s.slices).find((x) => x.ticketId === ticket)?.id ?? "");
  const def = sliceId ? definitions.slices[sliceId] : undefined;
  const unknown = def ? [] : [...CELL_PLACEHOLDERS, ...(sliceId ? [] : ["sliceId"])];
  // Until a record says otherwise, the stage is a placeholder: unknown, not "interview".
  const meta = metaOf(e, { unknown: [...unknown, "stage"], start: "inferred", fields: { stage: "reconstructed" } });
  let cell: CellState = { ...newCell(ticket, sliceId, definitions, when(e), meta), title: def?.title ?? (sliceId || ticket), cellInstance: e.ids.cell_instance };
  let strayAgents = s.strayAgents;
  for (const agent of Object.values(s.strayAgents)) {
    if (agent.ticketId !== ticket) continue;
    if (strayAgents === s.strayAgents) strayAgents = { ...strayAgents };
    delete (strayAgents as Record<string, AgentState>)[agent.id];
    cell = { ...cell, agents: put(cell.agents, agent.id, agent), agentOrder: [...cell.agentOrder, agent.id], activeAgentIds: agent.lifecycle === "running" ? [...cell.activeAgentIds, agent.id] : cell.activeAgentIds };
  }
  if (cell.agentOrder.length > 1) {
    const order = [...cell.agentOrder].sort((a, b) => (cell.agents[a] as AgentState).startedSeq - (cell.agents[b] as AgentState).startedSeq);
    cell = { ...cell, agentOrder: order };
  }
  return { ...s, cells: put(s.cells, ticket, cell), strayAgents };
}

/** Whether an id of the event was read from a worker's label (contract `inferred`). */
function labelled(e: Pick<FactoryEventV3, "inferred">, id: "ticket_id" | "slice_id"): boolean {
  return Boolean(e.inferred[`ids.${id}`]);
}

/**
 * Link a cell and its slice when a record names both (D5): whichever was seen first, the cell gets
 * the slice and the slice the ticket. Ids read from a label never link anything.
 */
function linkSlice(input: Scene, e: AnyV3Event, definitions: ProductDefinitions): Scene {
  const ticket = e.ids.ticket_id;
  const sliceId = e.ids.slice_id;
  if (!ticket || !sliceId || labelled(e, "ticket_id") || labelled(e, "slice_id")) return input;
  let s = input;
  const cell = s.cells[ticket];
  if (cell && !cell.sliceId) {
    const def = definitions.slices[sliceId];
    const titleUnknown = !isKnownField(cell.meta, "title");
    s = withCell(s, ticket, (c) => ({
      ...c,
      sliceId,
      title: def?.title ?? (titleUnknown ? sliceId : c.title),
      meta: { ...c.meta, unknown: def ? without(c.meta.unknown, "sliceId", ...CELL_PLACEHOLDERS) : without(c.meta.unknown, "sliceId") },
    }));
  }
  const slice = s.slices[sliceId];
  if (slice && !slice.ticketId) s = withSlice(s, sliceId, (x) => ({ ...x, ticketId: ticket }));
  return s;
}

function newExecution(e: AnyV3Event, id: string, extra: Partial<ExecutionState> = {}): ExecutionState {
  return {
    id,
    ticketId: e.ids.ticket_id ?? "",
    sliceId: e.ids.slice_id,
    state: "claimed",
    attempt: e.ids.attempt ?? 1,
    next: "build",
    stageAtStart: null,
    sessionId: null,
    workflow: null,
    workflowRunning: false,
    phase: null,
    claimedAt: e.time.order_ms,
    startedAt: null,
    workflowFinishedAt: null,
    endedAt: null,
    outcome: null,
    ...EMPTY_EXECUTION_EXTRAS,
    meta: metaOf(e, { unknown: ["next", "attempt", "claimedAt"], start: "inferred" }),
    ...extra,
  };
}

function ensureExecution(s: Scene, e: AnyV3Event): Scene {
  const id = e.ids.execution_id;
  if (!id || s.executions[id]) return s;
  return { ...s, executions: put(s.executions, id, newExecution(e, id)) };
}

/** Recorded spend of an execution: the stream's usage when present, else the supervisor's completion record. */
function costOf(x: ExecutionState | undefined): number {
  if (!x) return 0;
  return x.usage?.costUsd ?? x.outcome?.costUsd ?? 0;
}
function withCost(s: Scene, before: ExecutionState | undefined, id: string | null): Scene {
  const after = id ? s.executions[id] : undefined;
  const delta = costOf(after) - costOf(before);
  return delta ? { ...s, counters: bump(s.counters, { costUsd: delta }) } : s;
}

// ---------------------------------------------------------------- agents

function findAgentCell(s: Scene, agentId: string, ticket: string | null): { ticket: string | null; agent: AgentState | undefined } {
  if (ticket && s.cells[ticket]?.agents[agentId]) return { ticket, agent: s.cells[ticket]?.agents[agentId] };
  if (s.strayAgents[agentId]) return { ticket: null, agent: s.strayAgents[agentId] };
  // An agent's ticket is fixed at its start; a later event of it may carry no ticket. Look it up by identity, never by parsing its id.
  for (const cell of Object.values(s.cells)) if (cell.agents[agentId]) return { ticket: cell.ticketId, agent: cell.agents[agentId] };
  return { ticket: null, agent: undefined };
}

function updateAgent(s: Scene, agentId: string, ticket: string | null, update: (a: AgentState) => AgentState): Scene {
  const found = findAgentCell(s, agentId, ticket);
  if (!found.agent) return s;
  if (found.ticket === null) return { ...s, strayAgents: put(s.strayAgents, agentId, update(found.agent)) };
  return withCell(s, found.ticket, (cell) => withAgent(cell, agentId, update));
}

function placeAgent(s: Scene, agent: AgentState): Scene {
  const cell = agent.ticketId ? s.cells[agent.ticketId] : undefined;
  if (!cell) return { ...s, strayAgents: put(s.strayAgents, agent.id, agent) };
  return withCell(s, cell.ticketId, (c) => {
    let next: CellState = { ...c, agents: put(c.agents, agent.id, agent), agentOrder: [...c.agentOrder, agent.id] };
    if (agent.lifecycle === "running") next = { ...next, activeAgentIds: [...next.activeAgentIds, agent.id] };
    if (agent.role === "reviewer" && agent.seat) {
      next = { ...next, reviews: replaceLast(next.reviews, () => true, (r) => ({ ...r, seats: r.seats.map((seat) => (seat.seat === agent.seat && seat.agentId === null ? { ...seat, agentId: agent.id } : seat)) })) };
    }
    return next;
  });
}

function agentOf(e: AnyV3Event, id: string, extra: Partial<AgentState>): AgentState {
  const d = e.data as Partial<V3DataMap["agent.started"]>;
  const station = e.ids.station;
  const agentType = d.agent_type ?? null;
  const { role, rule } = roleOf(agentType, station);
  const model = modelIdOf(d.model);
  const phase = d.phase && (BELT_PHASES as readonly string[]).includes(d.phase) ? (d.phase as BeltPhase) : null;
  const unknown = ["effort", "tier", ...(model ? [] : ["model"]), ...(phase ? [] : ["phase"]), ...(e.ids.ticket_id ? [] : ["ticketId"])];
  const inferred: Record<string, string> = { ...e.inferred };
  if (rule) inferred.role = rule;
  const m = model ?? "sonnet";
  return {
    id,
    ticketId: e.ids.ticket_id ?? "",
    executionId: e.ids.execution_id,
    role,
    agentType,
    seat: e.ids.seat,
    tier: m === "fable" ? "planning" : m === "opus" ? "contracts" : m === "sonnet" ? "build" : "utility",
    model: m,
    effort: "medium",
    label: d.label ?? id,
    parentId: e.ids.parent_agent_id,
    phase: phase ?? "Preflight",
    station,
    status: "running",
    startedAt: when(e),
    startedSeq: e.pos,
    finishedAt: null,
    summary: null,
    currentToolCallId: null,
    toolCalls: [],
    lifecycle: "running",
    observation: "count-only",
    toolCallCount: null,
    lastTool: null,
    tokens: null,
    durationMs: null,
    refused: [],
    workflowId: firstRef(e, "workflow"),
    index: typeof d.index === "number" ? d.index : null,
    modelName: d.model ?? null,
    meta: metaOf(e, { unknown, inferred }),
    ...extra,
  };
}

// ---------------------------------------------------------------- the reducer

export function reduceV3(scene: Scene, event: AnyV3Event | UnknownV3Event, definitions: ProductDefinitions): Scene {
  const projectId = event.ids.project_id;
  const base: Scene = {
    ...scene,
    cursor: scene.cursor + 1,
    at: event.time.order_ms,
    lastSeq: event.pos,
    lastEventId: event.id,
    counters: bump(scene.counters, { events: 1 }),
    // The project is named by its events (`ids.project_id`); its name and branch are not in them.
    ...(projectId && !scene.project.id ? { project: { ...scene.project, id: projectId } } : {}),
  };
  // A kind from a later revision within version 3: kept in the log and the index, not reduced (contract 14).
  if (!isKnownV3Kind(event.type)) return base;
  const e = event as AnyV3Event;
  const next = apply(base, e, definitions);
  const actor = actorOfV3(e);
  if (!actor) return next;
  const before = next.actors[actor];
  return { ...next, actors: { ...next.actors, [actor]: { ...before, acts: before.acts + 1, lastActedAt: e.time.order_ms, lastSeq: e.pos, lastKind: e.type } } };
}

const SUPERVISOR_TYPES = new Set(["revision.discovered", "scheduling.decided", "work.claimed", "execution.started", "station.observed", "recovery.started", "execution.completed", "execution.failed"]);
const SCHEDULER_TYPES = new Set(["dependency.resolved", "dependency.blocked", "slice.integrated", "work.scheduled"]);

/** The supervisor or the scheduler, from the kind and the recorded writer (never from prose). */
export function actorOfV3(e: { readonly type: string; readonly origin: FactoryEventV3["origin"] }): "supervisor" | "scheduler" | null {
  if (e.origin.stream !== "intake-log") return null;
  if (SUPERVISOR_TYPES.has(e.type)) return "supervisor";
  if (SCHEDULER_TYPES.has(e.type)) return "scheduler";
  if (e.type === "human.required" && e.origin.writer === "supervisor") return "supervisor";
  return null;
}

function apply(input: Scene, e: AnyV3Event, definitions: ProductDefinitions): Scene {
  let s = input;
  const t = e.time.order_ms;
  const seq = e.pos;
  const ticket = e.ids.ticket_id;
  const at = when(e);
  s = linkSlice(s, e, definitions);
  if (e.origin.stream === "execution-stream" && e.ids.execution_id) s = observeStream(ensureExecution(s, e), e);

  switch (e.type) {
    // ------------------------------------------------ activation and intake (intake log)
    case "factory.activated": {
      const d = e.data;
      return { ...s, factory: { ...s.factory, enabled: true, paused: false, autonomy: d.autonomy, enabledBy: d.by_role, allowMerge: d.allow_merge, limits: d.limits as unknown as FactoryLimits, runnerId: e.ids.runner_id } };
    }
    case "factory.disabled":
      return { ...s, factory: { ...s.factory, enabled: false } };
    case "factory.paused":
      return { ...s, factory: { ...s.factory, paused: true } };
    case "factory.resumed":
      return { ...s, factory: { ...s.factory, paused: false } };
    case "revision.discovered":
      return { ...s, factory: { ...s.factory, productCommit: e.data.commit } };
    case "wave.discovered": {
      const id = e.ids.wave_id ?? "";
      const def = definitions.waves[id];
      const prior = s.waves[id];
      // A wave discovered again (a new revision, a re-read) adds to what is known of it, never replaces
      // it: its slices are the union in order of first sight, and it keeps the moment it was first seen.
      return {
        ...s,
        waves: put(s.waves, id, {
          id,
          title: def?.title ?? id,
          epicTitle: def?.epicTitle ?? "",
          revision: e.ids.revision ?? prior?.revision ?? null,
          sliceIds: prior ? union(prior.sliceIds, e.data.slices) : union([], e.data.slices),
          approvedBy: e.data.approval.by_role === "person" ? "a person" : e.data.approval.by_role,
          approvedAt: e.data.approval.approved_at ?? prior?.approvedAt ?? "",
          state: prior?.state ?? "discovered",
          discoveredAt: prior?.discoveredAt ?? at,
          seq: prior?.seq ?? seq,
          meta: prior ? touch(prior.meta, e) : metaOf(e, { unknown: def ? [] : ["title", "epicTitle"] }),
        }),
      };
    }
    case "intake.validated": {
      const wave = s.waves[e.ids.wave_id ?? ""];
      return wave ? { ...s, waves: put(s.waves, wave.id, { ...wave, state: "validated", meta: touch(wave.meta, e) }) } : s;
    }
    case "intake.refused":
      return { ...s, supervisor: { ...s.supervisor, attention: put(s.supervisor.attention, e.ids.wave_id ?? "intake", { reason: e.data.problems.join(" "), at: t, seq }) } };
    case "slice.materialized": {
      const id = e.ids.slice_id ?? "";
      const def = definitions.slices[id];
      const dependsOn = e.data.dependencies;
      const prior = s.slices[id];
      const knownCell = ticket ? s.cells[ticket] : undefined;
      const cellRisk = knownCell && isKnownField(knownCell.meta, "risk") ? knownCell.risk : null;
      const slice: SliceState = {
        id,
        title: def?.title ?? id,
        summary: def?.summary ?? "",
        waveId: e.ids.wave_id ?? "",
        revision: e.ids.revision,
        risk: def?.risk ?? (cellRisk ?? prior?.risk ?? "Medium"),
        ticketId: ticket ?? "",
        dependsOn,
        scheduler: "materialized",
        reasons: [],
        since: at,
        integratedCommit: null,
        history: [...(prior?.history ?? []), { state: "materialized", at, seq }],
        meta: metaOf(e, { unknown: def ? [] : ["title", "summary", ...(cellRisk ? [] : ["risk"])] }),
      };
      let dependencies = s.dependencies;
      for (const to of dependsOn) {
        const key = `${id}->${to}`;
        const done = s.slices[to]?.scheduler === "integrated";
        const edge: DependencyState = { id: key, from: id, to, state: done ? "satisfied" : "blocking", satisfiedAt: done ? at : null, satisfiedSeq: done ? seq : null, meta: metaOf(e) };
        dependencies = put(dependencies, key, edge);
      }
      return linkSlice({ ...s, slices: put(s.slices, id, slice), dependencies }, e, definitions);
    }
    case "dependency.resolved":
      return withSlice(s, e.ids.slice_id, (slice) => ({ ...schedule(slice, "eligible", at, seq, []), meta: touch(slice.meta, e) }));
    case "dependency.blocked":
      return withSlice(s, e.ids.slice_id, (slice) => ({ ...schedule(slice, slice.scheduler === "dispatched" ? "dispatched" : "waiting-on-dependency", at, seq, e.data.reasons), meta: touch(slice.meta, e) }));
    case "work.scheduled": {
      s = withSlice(s, e.ids.slice_id, (slice) => ({ ...schedule(slice, "dispatched", at, seq, []), meta: touch(slice.meta, e) }));
      s = ensureCell(s, e, definitions);
      const d = e.data;
      s = withSliceRisk(s, e.ids.slice_id, d.risk, e);
      return withCell(s, ticket, (cell) => {
        const stage = stageOf(d.stage);
        const unknown = without(cell.meta.unknown, ...(d.risk ? ["risk"] : []), ...(stage ? ["stage"] : []));
        return {
          ...cell,
          risk: d.risk ?? cell.risk,
          branch: d.branch,
          stage: cell.stageHistory.length ? cell.stage : (stage ?? cell.stage),
          openedAt: cell.stageHistory.length ? cell.openedAt : at,
          meta: { ...touch(cell.meta, e, { unknown, start: timeQualityOf(e.time.precision) }), fields: stage ? { ...cell.meta.fields, stage: "authoritative" } : cell.meta.fields },
        };
      });
    }
    case "slice.integrated": {
      s = withSlice(s, e.ids.slice_id, (slice) => ({ ...schedule(slice, "integrated", at, seq, []), integratedCommit: e.data.commit, meta: touch(slice.meta, e) }));
      let dependencies = s.dependencies;
      for (const edge of Object.values(s.dependencies)) {
        if (edge.to === e.ids.slice_id && edge.state !== "satisfied") dependencies = put(dependencies, edge.id, { ...edge, state: "satisfied", satisfiedAt: at, satisfiedSeq: seq, meta: touch(edge.meta, e) });
      }
      return { ...s, dependencies, counters: bump(s.counters, { integrated: 1 }) };
    }
    case "revision.superseded":
      return withSlice(s, e.ids.slice_id, (slice) => ({ ...slice, revision: e.ids.revision ?? slice.revision, reasons: [e.data.effect], meta: touch(slice.meta, e) }));
    case "human.required": {
      const key = ticket ?? e.ids.slice_id ?? "factory";
      return { ...s, supervisor: { ...s.supervisor, attention: put(s.supervisor.attention, key, { reason: e.data.reason, at: t, seq }) } };
    }
    case "scheduling.decided": {
      const d = e.data;
      return {
        ...s,
        supervisor: {
          ...s.supervisor,
          lastDecisionAt: t,
          lastDecision: { dispatched: d.dispatched, started: d.started, held: d.held.map((h) => ({ id: h.slice_id ?? h.ticket_id ?? "", why: h.why })) },
        },
      };
    }
    case "work.claimed": {
      const id = e.ids.execution_id ?? "";
      s = ensureCell(s, e, definitions);
      const before = s.executions[id];
      const execution = newExecution(e, id, {
        attempt: e.data.attempt,
        next: e.data.next ?? "build",
        stageAtStart: stageOf(e.data.stage),
        claimedAt: at,
        meta: metaOf(e, { unknown: e.data.next ? [] : ["next"] }),
      });
      s = { ...s, executions: put(s.executions, id, before ? { ...execution, processStartedAt: before.processStartedAt, processEndedAt: before.processEndedAt, ended: before.ended } : execution) };
      return withCell(s, ticket, (cell) => ({ ...cell, executionId: id }));
    }
    case "execution.started": {
      s = ensureExecution(s, e);
      const wasRunning = s.executions[e.ids.execution_id ?? ""]?.state === "running";
      s = withExecution(s, e.ids.execution_id, (x) => ({ ...x, state: "running", startedAt: at, workflow: e.data.workflow, meta: touch(x.meta, e, { unknown: without(x.meta.unknown, "startedAt") }) }));
      s = withCell(s, ticket, (cell) => ({ ...cell, executionId: e.ids.execution_id }));
      return wasRunning ? s : { ...s, counters: bump(s.counters, { executionsRunning: 1 }) };
    }
    case "execution.completed":
    case "execution.failed": {
      const id = e.ids.execution_id;
      s = ensureExecution(s, e);
      const before = id ? s.executions[id] : undefined;
      const failed = e.type === "execution.failed";
      const d = e.data;
      const cost = e.type === "execution.completed" ? e.data.cost_usd : null;
      s = withExecution(s, id, (x) => ({
        ...x,
        state: failed ? "failed" : "completed",
        endedAt: at,
        workflowRunning: false,
        outcome: { stage: stageOf(d.stage), next: d.next ?? "stop", waitingFor: e.type === "execution.completed" ? e.data.waiting_for : null, costUsd: cost ?? 0 },
        meta: touch(x.meta, e, { end: timeQualityOf(e.time.precision), unknown: cost === null && !failed ? withAll(x.meta.unknown, "costUsd") : x.meta.unknown }),
      }));
      s = withCost(s, before, id);
      s = closeVisitsOf(s, id, at, e);
      return before?.state === "running" ? { ...s, counters: bump(s.counters, { executionsRunning: -1 }) } : s;
    }
    case "station.observed": {
      s = ensureCell(s, e, definitions);
      const stage = stageOf(e.data.stage);
      return withCell(s, ticket, (cell) => {
        // A sampled stage never overrides the lifecycle log's (contract 11.1: superseded where a lifecycle log exists).
        const authoritative = cell.meta.fields.stage === "authoritative";
        if (!stage) return cell;
        return authoritative
          ? { ...cell, observedStage: stage }
          : {
              ...cell,
              observedStage: stage,
              stage,
              stageHistory: cell.stage === stage ? cell.stageHistory : [...cell.stageHistory, { stage, at, seq, by: "supervisor (sampled)" }],
              meta: { ...touch(cell.meta, e), fields: { ...cell.meta.fields, stage: "observed" }, unknown: without(cell.meta.unknown, "stage") },
            };
      });
    }
    case "recovery.started":
      s = ensureExecution(s, e);
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, recovery: e.data.kind, meta: touch(x.meta, e) }));

    // ------------------------------------------------ the cell lifecycle log
    case "station.entered":
      return stationEntered(ensureCell(s, e, definitions), e, at);
    case "station.exited":
      return stationExited(ensureCell(s, e, definitions), e, at);
    case "gate.evaluated":
      return gateEvaluated(ensureCell(s, e, definitions), e, at);
    case "build.task_completed": {
      s = ensureCell(s, e, definitions);
      const d = e.data;
      s = withCell(s, ticket, (cell) => {
        const existing = cell.tasks.find((k) => k.id === d.task_id);
        const task: TaskState = existing
          ? { ...existing, status: d.step, doneAt: at, commit: d.commit, meta: touch(existing.meta, e, { end: timeQualityOf(e.time.precision) }) }
          : {
              id: d.task_id,
              kind: d.kind,
              text: "",
              files: [],
              ids: [],
              loop: Math.max(0, (e.ids.round ?? cell.round) - 1),
              status: d.step,
              startedAt: at,
              doneAt: at,
              commit: d.commit,
              meta: metaOf(e, { unknown: ["startedAt", "text", "files", "ids"], start: "unknown", end: timeQualityOf(e.time.precision) }),
            };
        const tasks = existing ? cell.tasks.map((k) => (k.id === d.task_id ? task : k)) : [...cell.tasks, task];
        const suite = d.suite === "red" || d.suite === "green" ? d.suite : cell.suite;
        return { ...cell, tasks, suite };
      });
      if (d.step === "done") return s;
      const cell = ticket ? s.cells[ticket] : undefined;
      const reds = cell?.tasks.filter((x) => x.status === "red").length ?? 0;
      const greens = cell?.tasks.filter((x) => x.status === "green").length ?? 0;
      // A recorded override stays visible: later tasks never turn it back into a plain pass (D6).
      if (s.gates[gateId(ticket ?? "", "red-before-green")]?.state === "overridden") return s;
      return setGate(s, ticket ?? "", "red-before-green", null, "passed", `${reds} test task(s) seen failing first; ${greens} implementation task(s) green.`, at, seq, metaOf(e));
    }
    case "verify.targets_listed": {
      s = ensureCell(s, e, definitions);
      const targets = e.data.targets;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        verifications: replaceLast(cell.verifications, (v) => e.ids.round === null || v.round === e.ids.round, (v) => {
          const known = new Map(v.checks.map((c) => [c.targetId, c]));
          const listed = targets.map((x) => known.get(x.id) ?? { targetId: x.id, targetKind: x.kind, title: x.id, result: "pending" as const, evidence: [], note: null, at: null });
          // A check recorded for a target the list does not name is kept: it was recorded.
          const extra = v.checks.filter((c) => !targets.some((x) => x.id === c.targetId));
          return { ...v, checks: [...listed, ...extra], listed: { eventId: e.id, authority: e.authority as Authority, count: targets.length, late: e.late === true } };
        }),
      }));
      const round = e.ids.round ?? s.cells[ticket ?? ""]?.round ?? 1;
      const gate = s.gates[gateId(ticket ?? "", "verification", round)];
      return gate && gate.state === "open" ? setGate(s, ticket ?? "", "verification", round, "open", `${targets.length} checks to prove`, gate.openedAt, gate.seq, touch(gate.meta, e)) : s;
    }
    case "verify.check_recorded": {
      s = ensureCell(s, e, definitions);
      const d = e.data;
      let previous: "pending" | "pass" | "fail" | null = null;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        verifications: replaceLast(cell.verifications, (v) => e.ids.round === null || v.round === e.ids.round, (v) => {
          const found = v.checks.find((c) => c.targetId === d.target_id);
          previous = found?.result ?? null;
          const check = { targetId: d.target_id, targetKind: d.target_kind, title: found?.title ?? d.target_id, result: d.result, evidence: d.evidence.map((x) => x.file), note: null, at };
          return { ...v, checks: found ? v.checks.map((c) => (c.targetId === d.target_id ? check : c)) : [...v.checks, check] };
        }),
      }));
      const undo = previous === "pass" ? { checksPassed: -1 } : previous === "fail" ? { checksFailed: -1 } : {};
      s = { ...s, counters: bump(bump(s.counters, undo), d.result === "pass" ? { checksPassed: 1 } : { checksFailed: 1 }) };
      return s;
    }
    case "review.round_started":
      return reviewStarted(ensureCell(s, e, definitions), e, at);
    case "review.verdict_submitted": {
      s = ensureCell(s, e, definitions);
      const d = e.data;
      return withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => e.ids.round === null || r.round === e.ids.round, (r) => ({ ...r, seats: r.seats.map((seat) => (seat.seat === d.seat ? { ...seat, vote: d.vote, votedAt: at, votedEventId: e.id, votedLate: e.late === true } : seat)) })),
      }));
    }
    case "review.decided":
      return reviewDecided(ensureCell(s, e, definitions), e, at);
    case "human.approval_recorded": {
      s = ensureCell(s, e, definitions);
      const round = e.ids.round ?? s.cells[ticket ?? ""]?.round ?? 1;
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => r.round === round, (r) => ({ ...r, outcome: "APPROVED", humanApproval: { by: "a person", note: null, at, eventId: e.id, late: e.late === true } })),
      }));
      const attention = { ...s.supervisor.attention };
      if (ticket) delete attention[ticket];
      s = { ...s, supervisor: { ...s.supervisor, attention } };
      s = setGate(s, ticket ?? "", "human-approval", round, "passed", "Approved by a person.", at, seq, metaOf(e));
      return { ...s, counters: bump(s.counters, { humanApprovals: 1 }) };
    }
    case "merge.completed": {
      s = ensureCell(s, e, definitions);
      const d = e.data;
      s = setGate(s, ticket ?? "", "merge-revalidation", null, d.revalidated ? "passed" : "skipped", d.revalidated ? "Main had moved: merged into the branch and the suite passed again." : "Main had not moved; no revalidation was needed.", at, seq, metaOf(e));
      s = withCell(s, ticket, (cell) => ({ ...cell, merged: { commit: d.merge_commit ?? d.landed_commit ?? "", at, revalidated: d.revalidated }, meta: touch(cell.meta, e) }));
      return { ...s, counters: bump(s.counters, { merged: 1 }) };
    }
    case "cleanup.completed":
      s = ensureCell(s, e, definitions);
      return withCell(s, ticket, (cell) => ({ ...cell, archived: { archive: e.data.archive ?? "", at }, meta: touch(cell.meta, e, { end: timeQualityOf(e.time.precision) }) }));

    // ------------------------------------------------ execution and run records
    case "execution.process_started":
      s = ensureExecution(s, e);
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, processStartedAt: at, meta: touch(x.meta, e) }));
    case "execution.process_ended": {
      s = ensureExecution(s, e);
      s = withExecution(s, e.ids.execution_id, (x) => ({ ...x, processEndedAt: at, ended: e.data.ended, exitCode: e.data.exit_code, workflowRunning: false, meta: touch(x.meta, e, { end: timeQualityOf(e.time.precision) }) }));
      s = closeVisitsOf(s, e.ids.execution_id, at, e);
      // The main loop is the process: it ends with it (identity, not inference). How it ended is the process's exit.
      const mainId = e.ids.execution_id ? `${e.ids.execution_id}/main` : null;
      if (!mainId || findAgentCell(s, mainId, ticket).agent?.lifecycle !== "running") return s;
      const lifecycle = e.data.ended === "exited" ? (e.data.exit_code === 0 ? "done" : "error") : "unknown";
      s = updateAgent(s, mainId, ticket, (a) => ({ ...a, lifecycle, status: lifecycle === "error" ? "error" : "done", finishedAt: at, durationMs: at - a.startedAt, currentToolCallId: null, meta: touch(a.meta, e, { end: timeQualityOf(e.time.precision), inferred: { ...a.meta.inferred, finishedAt: "process-ended" } }) }));
      const found = findAgentCell(s, mainId, ticket);
      if (found.ticket) s = withCell(s, found.ticket, (cell) => ({ ...cell, activeAgentIds: cell.activeAgentIds.filter((x) => x !== mainId) }));
      return { ...s, counters: bump(s.counters, { agentsActive: -1 }) };
    }
    case "run.recorded":
      s = ensureCell(s, e, definitions);
      return withCell(s, ticket, (cell) => ({ ...cell, runRecord: { outcome: e.data.outcome, rounds: e.data.rounds, firstPass: e.data.first_pass, at }, meta: touch(cell.meta, e) }));

    // ------------------------------------------------ the execution stream (observed)
    case "session.initialized":
      s = ensureExecution(s, e);
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, claudeCodeVersion: e.data.claude_code_version, observation: { ...x.observation, version: e.data.claude_code_version } }));
    case "workflow.started":
      s = ensureExecution(s, e);
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, workflowRunning: true, workflow: e.data.workflow, workflowId: firstRef(e, "workflow"), workflowStatus: "running", workflowMeta: x.workflowMeta ? touch(x.workflowMeta, e) : metaOf(e) }));
    case "workflow.phases_declared":
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, phases: e.data.phases.map((p) => p.title), workflowMeta: x.workflowMeta ? touch(x.workflowMeta, e) : metaOf(e) }));
    case "workflow.finished":
      s = withExecution(s, e.ids.execution_id, (x) => ({ ...x, workflowRunning: false, workflowFinishedAt: at, workflowStatus: e.data.status, stopReason: e.data.stop_reason, workflowMeta: x.workflowMeta ? touch(x.workflowMeta, e, { end: timeQualityOf(e.time.precision) }) : metaOf(e, { end: timeQualityOf(e.time.precision) }) }));
      return withCell(s, ticket, (cell) => ({ ...cell, workflowPhase: null }));
    case "agent.queued": {
      s = ensureExecution(s, e);
      const d = e.data;
      const queued: QueuedAgentState = { index: d.index, label: d.label, phase: d.phase, modelName: d.model, ticketId: ticket, queuedAt: at, eventId: e.id };
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, queued: put(x.queued, String(d.index), queued) }));
    }
    case "agent.started": {
      const id = e.ids.agent_id;
      if (!id) return s;
      // Never a cell from an agent's label (D15): an agent whose ticket has no cell stays stray, with its execution.
      s = ensureExecution(s, e);
      if (findAgentCell(s, id, ticket).agent) return s; // a repeated start (a new snapshot of the same agent): the first one stands
      const d = e.data;
      s = withExecution(s, e.ids.execution_id, (x) => {
        if (!x.queued[String(d.index)]) return x;
        const queued = { ...x.queued };
        delete queued[String(d.index)];
        return { ...x, queued };
      });
      s = placeAgent(s, agentOf(e, id, {}));
      if (ticket && d.phase && (BELT_PHASES as readonly string[]).includes(d.phase)) s = withCell(s, ticket, (cell) => ({ ...cell, workflowPhase: d.phase as BeltPhase }));
      return { ...s, counters: bump(s.counters, { agentsActive: 1, agentsStarted: 1 }) };
    }
    case "agent.progressed": {
      const id = e.ids.agent_id;
      if (!id) return s;
      const d = e.data;
      return updateAgent(s, id, ticket, (a) => ({
        ...a,
        toolCallCount: d.tool_calls ?? a.toolCallCount,
        tokens: d.tokens ?? a.tokens,
        lastTool: d.last_tool ?? a.lastTool,
        meta: touch(a.meta, e),
      }));
    }
    case "agent.finished": {
      const id = e.ids.agent_id;
      if (!id) return s;
      const d = e.data;
      let wasRunning = false;
      s = updateAgent(s, id, ticket, (a) => {
        wasRunning = a.lifecycle === "running";
        return {
          ...a,
          lifecycle: d.status,
          status: d.status === "error" ? "error" : "done",
          finishedAt: at,
          durationMs: d.duration_ms,
          tokens: d.tokens ?? a.tokens,
          toolCallCount: d.tool_calls ?? a.toolCallCount,
          currentToolCallId: null,
          meta: touch(a.meta, e, { end: d.status === "unknown" ? "inferred" : timeQualityOf(e.time.precision), unknown: d.status === "unknown" ? withAll(a.meta.unknown, "outcome") : a.meta.unknown }),
        };
      });
      const found = findAgentCell(s, id, ticket);
      if (found.ticket) s = withCell(s, found.ticket, (cell) => ({ ...cell, activeAgentIds: cell.activeAgentIds.filter((x) => x !== id) }));
      return wasRunning ? { ...s, counters: bump(s.counters, { agentsActive: -1 }) } : s;
    }
    case "tool.called":
      return toolCalled(ensureExecution(s, e), e, at);
    case "tool.returned": {
      const agentId = e.ids.agent_id;
      const callId = e.ids.tool_call_id;
      if (!agentId || !callId) return s;
      const d = e.data;
      let closed = false;
      s = updateAgent(s, agentId, ticket, (a) => ({
        ...a,
        currentToolCallId: a.currentToolCallId === callId ? null : a.currentToolCallId,
        toolCalls: replaceLast(a.toolCalls, (c) => c.id === callId && c.finishedAt === null, (c) => {
          closed = true;
          return { ...c, finishedAt: at, status: d.status === "error" ? "error" : "ok", result: d.status, meta: touch(c.meta, e, { end: d.status === "unknown" ? "inferred" : timeQualityOf(e.time.precision) }) };
        }),
      }));
      return closed ? { ...s, counters: bump(s.counters, { toolCallsActive: -1 }) } : s;
    }
    case "tool.refused": {
      s = ensureExecution(s, e);
      const agentId = e.ids.agent_id;
      s = withExecution(s, e.ids.execution_id, (x) => ({ ...x, refused: [...x.refused, { tool: e.data.tool, agentId, at }] }));
      return agentId ? updateAgent(s, agentId, ticket, (a) => ({ ...a, refused: [...a.refused, e.data.tool] })) : s;
    }
    case "execution.usage": {
      s = ensureExecution(s, e);
      const id = e.ids.execution_id;
      const before = id ? s.executions[id] : undefined;
      const d = e.data;
      const reasons = Array.isArray(d.cost_incomplete_reasons) ? d.cost_incomplete_reasons.filter((r) => typeof r === "string") : [];
      s = withExecution(s, id, (x) => ({ ...x, usage: { costUsd: d.total_cost_usd, budgetExhausted: d.budget_exhausted, terminalReason: d.terminal_reason, costComplete: typeof d.cost_complete === "boolean" ? d.cost_complete : null, costIncompleteReasons: reasons, eventId: e.id } }));
      return withCost(s, before, id);
    }

    // ------------------------------------------------ observer reconstruction
    case "review.finding": {
      s = ensureCell(s, e, definitions);
      const d = e.data;
      const round = e.ids.round ?? 1;
      const finding: FindingState = {
        id: firstRef(e, "finding") ?? `${ticket ?? ""}/r${round}/${d.seat}/${d.n}`,
        round,
        seat: d.seat,
        severity: d.severity,
        title: d.title,
        rule: d.rule,
        file: d.file_rel,
        at,
        outvoted: false,
        meta: metaOf(e),
      };
      s = withCell(s, ticket, (cell) => ({
        ...cell,
        reviews: replaceLast(cell.reviews, (r) => r.round === round, (r) => (r.findings.some((f) => f.id === finding.id) ? r : { ...r, findings: [...r.findings, finding] })),
      }));
      return { ...s, counters: bump(s.counters, d.severity === "blocker" ? { blockers: 1 } : { notes: 1 }) };
    }
    case "artifact.recorded":
      return artifactRecorded(ensureCell(s, e, definitions), e, at);
    case "capacity.wait_changed": {
      const waiting = e.data.state === "waiting";
      // Held at the scene whether or not the ticket's cell or execution is known yet (a slice held for
      // a place before its cell opens): a recorded wait is never lost for want of an entity to hang it on.
      const capacityWaits = { ...s.capacityWaits };
      if (ticket && waiting) capacityWaits[ticket] = { ticketId: ticket, sliceId: e.ids.slice_id, executionId: e.ids.execution_id, scope: e.data.scope, limit: e.data.limit, since: at, eventId: e.id, late: e.late === true };
      else if (ticket) delete capacityWaits[ticket];
      s = { ...s, capacityWaits };
      s = withCell(s, ticket, (cell) => ({ ...cell, capacityWait: waiting ? { since: at, limit: e.data.limit, eventId: e.id } : null }));
      return withExecution(s, e.ids.execution_id, (x) => ({ ...x, capacityWait: waiting ? { since: at, limit: e.data.limit } : null }));
    }
    case "history.began": {
      const began = { ...s.completeness.began };
      for (const r of e.entities) if (isEntityRefString(r)) began[r] = { reason: e.data.reason, at, eventId: e.id };
      s = { ...s, completeness: { ...s.completeness, state: s.completeness.state === "reconstructed" ? "reconstructed" : "partial", began } };
      if (!ticket) return s;
      s = ensureCell(s, e, definitions);
      const snapshotStage = stageOf(e.data.snapshot.stage);
      return withCell(s, ticket, (cell) => ({
        ...cell,
        historyBegan: { reason: e.data.reason, at },
        round: e.data.snapshot.round ?? cell.round,
        stage: snapshotStage && cell.meta.fields.stage !== "authoritative" ? snapshotStage : cell.stage,
        meta: { ...touch(cell.meta, e), fields: snapshotStage && cell.meta.fields.stage !== "authoritative" ? { ...cell.meta.fields, stage: "reconstructed" } : cell.meta.fields, unknown: snapshotStage ? without(cell.meta.unknown, "stage") : cell.meta.unknown },
      }));
    }
    case "history.gap": {
      const cls = typeof e.data.class === "string" && e.data.class ? e.data.class : gapClassOf(e.data.reason);
      const lost = typeof e.data.history_lost === "boolean" ? e.data.history_lost : !NOT_LOST.has(cls);
      const gap: HistoryGapState = {
        eventId: e.id,
        at,
        reason: e.data.reason,
        source: e.data.source_key,
        from: e.data.from_seq === null ? null : String(e.data.from_seq),
        to: e.data.to_seq === null ? null : String(e.data.to_seq),
        count: e.data.count,
        class: cls,
        lost,
      };
      const c = s.completeness;
      // Records received and not interpreted (unknown-type) lose no history: counted, never partial (D8).
      const notInterpreted = cls === "unknown-type" ? { ...c.notInterpreted, [gap.source]: (c.notInterpreted[gap.source] ?? 0) + (gap.count ?? 1) } : c.notInterpreted;
      return { ...s, completeness: { ...c, state: c.state === "reconstructed" ? "reconstructed" : lost ? "partial" : c.state, gaps: [...c.gaps, gap], notInterpreted } };
    }

    // ------------------------------------------------ the client's own markers
    case "client.history_missing": {
      const reason = e.data.reason === "reset" ? "observer-index-reset" : e.data.reason === "window" ? "before-window" : "cursor-expired";
      const gap: HistoryGapState = { eventId: e.id, at, reason, source: "client", from: e.data.after, to: e.data.resumed_at, count: null, class: reason, lost: true };
      return { ...s, completeness: { ...s.completeness, state: s.completeness.state === "reconstructed" ? "reconstructed" : "partial", since: at, gaps: [...s.completeness.gaps, gap] } };
    }
    case "client.snapshot_applied":
      return applySnapshot(s, e, at, definitions);
    default:
      return s;
  }
}

// ---------------------------------------------------------------- visits that never exited (D4, D14)

const withoutKey = (record: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> => {
  if (!(key in record)) return record;
  const out = { ...record };
  delete out[key];
  return out;
};

/**
 * Close the open visits of a cell that `pick` names, as ended without an exit record: `leftAt` is the
 * bound (the cell's next entry, or its execution's end), the outcome "stopped" with no word of the
 * station's own, the end inferred, the authority reconstructed. A cell whose current station was one
 * of them is at no station any more.
 */
function closeVisits(cell: CellState, pick: (v: CellState["visits"][number]) => boolean, reason: "superseded" | "execution-ended", at: number, e: AnyV3Event): CellState {
  let current = false;
  let changed = false;
  const visits = cell.visits.map((v) => {
    if (v.leftAt !== null || !pick(v)) return v;
    changed = true;
    if (cell.station === v.station && cell.visits.lastIndexOf(v) === cell.visits.findLastIndex((x) => x.station === v.station)) current = true;
    return {
      ...v,
      leftAt: Math.max(v.enteredAt, at),
      outcome: "stopped" as const,
      outcomeWord: null,
      durationMs: null,
      unclosed: { reason, at: Math.max(v.enteredAt, at), eventId: e.id },
      meta: { ...v.meta, authority: "reconstructed" as const, eventId: e.id, end: "inferred" as const, late: e.late === true, unknown: withAll(v.meta.unknown, "outcome"), inferred: { ...v.meta.inferred, leftAt: reason === "superseded" ? "unclosed-visit" : "execution-ended" } },
    };
  });
  if (!changed) return cell;
  return current ? { ...cell, visits, station: null, action: null, stationSince: null } : { ...cell, visits };
}

/** An execution ended: every visit it entered and never exited ended with it. A wait on a person (human approval) is not its work and stays open. */
function closeVisitsOf(input: Scene, executionId: string | null, at: number, e: AnyV3Event): Scene {
  if (!executionId) return input;
  let s = input;
  for (const cell of Object.values(input.cells)) {
    if (!cell.visits.some((v) => v.leftAt === null && v.executionId === executionId && v.station !== "human-approval")) continue;
    s = withCell(s, cell.ticketId, (c) => closeVisits(c, (v) => v.executionId === executionId && v.station !== "human-approval", "execution-ended", at, e));
  }
  return s;
}

// ---------------------------------------------------------------- what a stream showed (D7) and gaps (D8)

const STRUCTURAL = new Set(["workflow.started", "workflow.phases_declared", "workflow.finished", "agent.queued", "agent.started", "agent.progressed", "agent.finished", "tool.called", "tool.returned"]);

/** Count a stream record against its execution, and keep the runtime state the observer stamped on it. */
function observeStream(s: Scene, e: AnyV3Event): Scene {
  return withExecution(s, e.ids.execution_id, (x) => {
    const o = x.observation;
    const runtime = e.origin.runtime_state ?? o.runtime;
    return { ...x, observation: { ...o, records: o.records + 1, structural: o.structural + (STRUCTURAL.has(e.type) ? 1 : 0), runtime } };
  });
}

/** Gap classes that lose no history: records received and not interpreted, and a conflict (the first record kept). */
const NOT_LOST = new Set(["unknown-type", "conflict"]);

/** The class of a gap from its precise reason, for observers that send no `class`. */
export function gapClassOf(reason: string): string {
  switch (reason) {
    case "unknown-type":
    case "unparsable-line":
    case "state-mismatch":
    case "evicted":
    case "conflict":
      return reason;
    case "unexpected-shape":
    case "no-timestamps":
      return "unknown-type";
    case "unreadable":
    case "source-unreadable":
      return "source-unreadable";
    case "missing-seq":
    case "truncated":
    case "rewritten":
      return "not-received";
    default:
      // The observer's own default (event.GapClass): an unknown reason is a record not interpreted.
      return "unknown-type";
  }
}

// ---------------------------------------------------------------- lifecycle cases

function stationEntered(input: Scene, e: E<"station.entered">, at: number): Scene {
  let s = input;
  const ticket = e.ids.ticket_id;
  const d = e.data;
  const cell = ticket ? s.cells[ticket] : undefined;
  if (!cell) return s;
  const known = actionOf(d.action, d.station);
  const action: StepAction = known.action;
  const round = e.ids.round ?? cell.round;
  const stage = stageOf(d.stage);
  const visit = {
    station: d.station,
    action,
    round,
    enteredAt: at,
    enteredSeq: e.pos,
    leftAt: null,
    outcome: null,
    visitId: e.ids.visit_id,
    outcomeWord: null,
    durationMs: null,
    executionId: e.ids.execution_id,
    unclosed: null,
    meta: metaOf(e, { unknown: known.unknown ? ["action"] : [], inferred: known.rule ? { action: known.rule } : {} }),
  };
  // The entry names the visit before it that never exited (`unclosed_visit`): that one ended here (D4).
  if (d.unclosed_visit) {
    const id = d.unclosed_visit.includes("/") ? d.unclosed_visit : `${ticket}/${d.unclosed_visit}`;
    s = withCell(s, ticket, (c) => closeVisits(c, (v) => v.visitId === id, "superseded", at, e));
  }
  s = withCell(s, ticket, (c) => ({
    ...c,
    station: d.station,
    action,
    stationSince: at,
    visits: [...c.visits, visit],
    round: e.ids.round !== null ? Math.min(e.ids.round, MAX_ROUNDS) : c.round,
    loop: action === "revise" && e.ids.round !== null ? Math.max(0, e.ids.round - 1) : c.loop,
    cellInstance: c.cellInstance ?? e.ids.cell_instance,
    stage: stage ?? c.stage,
    stageHistory: stage && stage !== c.stage ? [...c.stageHistory, { stage, at, seq: e.pos, by: d.station }] : c.stageHistory,
    meta: { ...touch(c.meta, e), fields: stage ? { ...c.meta.fields, stage: "authoritative" } : c.meta.fields, unknown: stage ? without(c.meta.unknown, "stage") : c.meta.unknown },
  }));
  if (d.station === "verify") {
    // Nothing to prove is listed yet: `verify.targets_listed` (reconstructed) gives the list when it comes.
    const v: VerificationState = { round, status: "running", startedAt: at, decidedAt: null, checks: [], requiredEvidence: [], listed: null };
    s = withCell(s, ticket, (c) => ({ ...c, verifications: [...c.verifications.filter((x) => !(x.round === round && x.status === "running")), v] }));
    s = setGate(s, ticket ?? "", "verification", round, "open", "Checks to prove not listed yet.", at, e.pos, metaOf(e));
  }
  if (d.station === "human-approval") s = setGate(s, ticket ?? "", "human-approval", round, "waiting", "A person must approve before merge.", at, e.pos, metaOf(e));
  return s;
}

const APP_TYPES: readonly string[] = ["web", "cli", "api", "rest", "grpc", "desktop", "mobile", "library"];
const riskOf = (value: unknown): Risk | null => (typeof value === "string" && (RISKS as readonly string[]).includes(value) ? (value as Risk) : null);
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * The plan's facts on a cell (D11, schema revision 2): app type and risk from the plan's exit (or the
 * observer's summary), the contract and task counts from its counts. The cell's own `appType` and
 * `risk` take them when they are words the scene knows; an app type it does not know stays in
 * `plan.appType` only (the cell's field keeps saying "not recorded").
 */
function withPlanFacts(cell: CellState, facts: { appType: string | null; risk: Risk | null; contracts: number | null; tasks: number | null }, eventId: string | null, authority: Authority): CellState {
  if (facts.appType === null && facts.risk === null && facts.contracts === null && facts.tasks === null) return cell;
  const prior = cell.plan;
  const plan = {
    appType: facts.appType ?? prior?.appType ?? null,
    risk: facts.risk ?? prior?.risk ?? null,
    contracts: facts.contracts ?? prior?.contracts ?? null,
    tasks: facts.tasks ?? prior?.tasks ?? null,
    eventId: eventId ?? prior?.eventId ?? null,
    authority,
  };
  const appType = plan.appType !== null && APP_TYPES.includes(plan.appType) ? (plan.appType as AppType) : null;
  const known = [...(appType ? ["appType"] : []), ...(facts.risk ? ["risk"] : [])];
  return {
    ...cell,
    plan,
    appType: appType ?? cell.appType,
    risk: facts.risk ?? cell.risk,
    meta: known.length ? { ...cell.meta, unknown: without(cell.meta.unknown, ...known), fields: { ...cell.meta.fields, ...Object.fromEntries(known.map((k) => [k, authority])) } } : cell.meta,
  };
}

function stationExited(input: Scene, e: E<"station.exited">, at: number): Scene {
  const ticket = e.ids.ticket_id;
  const d = e.data;
  const stage = stageOf(d.stage);
  if (d.station === "plan" || d.app_type || d.risk) {
    const facts = { appType: typeof d.app_type === "string" && d.app_type ? d.app_type : null, risk: riskOf(d.risk), contracts: d.station === "plan" ? countOf(d.counts?.contracts) : null, tasks: d.station === "plan" ? countOf(d.counts?.tasks) : null };
    input = withCell(input, ticket, (c) => withPlanFacts(c, facts, e.id, e.authority as Authority));
  }
  // An exit record wins over a closing the scene inferred (an unclosed visit resumed and exited after all).
  const match = (v: CellState["visits"][number]): boolean => (e.ids.visit_id ? v.visitId === e.ids.visit_id && (v.leftAt === null || v.unclosed !== null) : v.leftAt === null && v.station === d.station);
  return withCell(input, ticket, (c) => {
    const closesCurrent = c.station === d.station;
    return {
      ...c,
      station: closesCurrent ? null : c.station,
      action: closesCurrent ? null : c.action,
      stationSince: closesCurrent ? null : c.stationSince,
      visits: replaceLast(c.visits, match, (v) => ({
        ...v,
        leftAt: at,
        outcome: outcomeOf(d.outcome),
        outcomeWord: d.outcome,
        durationMs: d.duration_ms,
        unclosed: null,
        meta: touch(v.meta, e, { end: timeQualityOf(e.time.precision), inferred: d.closed_by ? { ...v.meta.inferred, leftAt: "closed-by-cleanup" } : withoutKey(v.meta.inferred, "leftAt"), unknown: without(v.meta.unknown, "outcome") }),
      })),
      stage: stage ?? c.stage,
      stageHistory: stage && stage !== c.stage ? [...c.stageHistory, { stage, at, seq: e.pos, by: d.station }] : c.stageHistory,
      meta: { ...touch(c.meta, e), fields: stage ? { ...c.meta.fields, stage: "authoritative" } : c.meta.fields, unknown: stage ? without(c.meta.unknown, "stage") : c.meta.unknown },
    };
  });
}

/** The gate state (`scene.gates` id) a lifecycle gate evaluation sets, or null when none stands for it. */
function gateStateOf(gate: string, verdict: "passed" | "refused" | "overridden", ticket: string, round: number): string | null {
  const passed = verdict === "passed";
  switch (gate) {
    case "audit.readiness":
      return gateId(ticket, "audit");
    case "plan.check":
      return gateId(ticket, "plan-check");
    case "verify.verdict":
      return gateId(ticket, "verification", round);
    case "build.red":
    case "build.green":
    case "red-before-green":
      return passed ? null : gateId(ticket, "red-before-green");
    case "merge.land":
      return passed ? null : gateId(ticket, "merge-revalidation");
    default:
      return null;
  }
}

/** A gate state from a verdict: an override is its own state, never a pass (D6). */
const gateWord = (verdict: "passed" | "refused" | "overridden"): "passed" | "failed" | "overridden" => (verdict === "overridden" ? "overridden" : verdict === "passed" ? "passed" : "failed");
const overrideDetail = (d: V3DataMap["gate.evaluated"]): string => `Overridden${d.subject ? ` for ${d.subject}` : ""}: ${d.reason_code ?? "no reason code"}.`;

function gateEvaluated(input: Scene, e: E<"gate.evaluated">, at: number): Scene {
  let s = input;
  const ticket = e.ids.ticket_id ?? "";
  const d = e.data;
  const round = e.ids.round;
  const passed = d.verdict !== "refused";
  const word = gateWord(d.verdict);
  const matched = gateStateOf(d.gate, d.verdict, ticket, round ?? s.cells[ticket]?.round ?? 1);
  // The observer names the evaluation with its own gate ref (`gate:<cell>/<gate>[#<round>]`, contract
  // 5.2); kept so that ref resolves to this evaluation (and to the gate state it set), never parsed.
  const ownRef = e.entities.find((x) => x.startsWith("gate:")) ?? `gate:${ticket}/${d.gate}${round ? `#${round}` : ""}`;
  s = withCell(s, ticket, (c) => ({ ...c, gateLog: [...c.gateLog, { gate: d.gate, verdict: d.verdict, reasonCode: d.reason_code, subject: d.subject, round, at, eventId: e.id, late: e.late === true, gateId: matched, ref: ownRef }] }));
  const meta = metaOf(e);
  switch (d.gate) {
    case "audit.readiness":
      return setGate(s, ticket, "audit", null, word, word === "overridden" ? overrideDetail(d) : d.audit_tier ? `Readiness ${d.audit_tier}.` : passed ? "Readiness gate passed." : "Readiness gate refused.", at, e.pos, meta, d.reason_code);
    case "plan.check":
      return setGate(s, ticket, "plan-check", null, word, word === "overridden" ? overrideDetail(d) : passed ? "The plan covers every requirement." : `Refused: ${d.reason_code ?? "no reason code"}.`, at, e.pos, meta, d.reason_code);
    case "verify.verdict": {
      const r = round ?? s.cells[ticket]?.round ?? 1;
      const status = d.status ?? (passed ? "PASS" : "FAIL_WITH_EVIDENCE");
      s = withCell(s, ticket, (c) => ({ ...c, verifications: replaceLast(c.verifications, (v) => v.round === r, (v) => ({ ...v, status, decidedAt: at })) }));
      const counts = d.counts;
      const passedCount = typeof counts.checks_passed === "number" ? counts.checks_passed : null;
      const failedCount = typeof counts.checks_failed === "number" ? counts.checks_failed : null;
      const detail = passedCount !== null && failedCount !== null ? `${status}: ${passedCount} passed, ${failedCount} failed` : status;
      s = setGate(s, ticket, "verification", r, word === "overridden" ? "overridden" : status === "PASS" ? "passed" : "failed", word === "overridden" ? overrideDetail(d) : detail, at, e.pos, meta, d.reason_code);
      return status === "PASS" || word === "overridden" ? s : { ...s, counters: bump(s.counters, { verificationFailures: 1 }) };
    }
    case "build.red":
    case "build.green":
    case "red-before-green":
      if (word === "overridden") return setGate(s, ticket, "red-before-green", null, "overridden", overrideDetail(d), at, e.pos, meta, d.reason_code);
      return passed ? s : setGate(s, ticket, "red-before-green", null, "failed", `Refused ${d.gate.startsWith("build.") ? `${d.gate.slice(6)} step` : "the red-before-green check"}${d.subject ? ` for ${d.subject}` : ""}: ${d.reason_code ?? "no reason code"}.`, at, e.pos, meta, d.reason_code);
    case "merge.land":
      if (word === "overridden") return setGate(s, ticket, "merge-revalidation", null, "overridden", overrideDetail(d), at, e.pos, meta, d.reason_code);
      return passed ? s : setGate(s, ticket, "merge-revalidation", null, "failed", `Refused: ${d.reason_code ?? "no reason code"}.`, at, e.pos, meta, d.reason_code);
    default:
      return s;
  }
}

function reviewStarted(input: Scene, e: E<"review.round_started">, at: number): Scene {
  let s = input;
  const ticket = e.ids.ticket_id;
  const d = e.data;
  const cell = ticket ? s.cells[ticket] : undefined;
  if (!cell) return s;
  const round = e.ids.round ?? cell.reviews.length + 1;
  const state: ReviewRoundState = {
    round,
    risk: d.risk,
    approvalsNeeded: d.approvals_needed,
    humanApprovalRequired: d.human_approval_required,
    humanApprovalReasons: [],
    delta: null,
    isDelta: d.delta,
    seats: d.panel.map((p) => ({ seat: p.seat, model: modelIdOf(p.model) ?? "sonnet", agentId: null, vote: null, votedAt: null, votedEventId: null, votedLate: false })),
    findings: [],
    startedAt: at,
    outcome: null,
    decidedAt: null,
    approvals: null,
    overruledBlockersFrom: [],
    humanApproval: null,
    eventId: e.id,
    late: e.late === true,
    decidedEventId: null,
    decidedLate: false,
  };
  const restarted = cell.reviews.some((r) => r.round === round);
  s = withCell(s, ticket, (c) => ({ ...c, reviews: restarted ? c.reviews.map((r) => (r.round === round ? state : r)) : [...c.reviews, state], risk: d.risk, meta: { ...c.meta, unknown: without(c.meta.unknown, "risk") } }));
  s = withSliceRisk(s, cell.sliceId || e.ids.slice_id, d.risk, e);
  s = setGate(s, ticket ?? "", "review", round, "open", `${d.panel.length} seat(s), ${d.approvals_needed} approval(s) needed`, at, e.pos, metaOf(e));
  return restarted ? s : { ...s, counters: bump(s.counters, { reviewRounds: 1 }) };
}

function reviewDecided(input: Scene, e: E<"review.decided">, at: number): Scene {
  let s = input;
  const ticket = e.ids.ticket_id;
  const d = e.data;
  const round = e.ids.round ?? s.cells[ticket ?? ""]?.reviews.at(-1)?.round ?? 1;
  const passed = d.outcome === "APPROVED" || d.outcome === "AWAITING_HUMAN";
  // Outvoted blockers follow from the votes and the outcome (contract 12.2): a seat that rejected an approved round.
  const overruled = passed ? (Object.entries(d.votes).filter(([, vote]) => vote === "REJECT").map(([seat]) => seat) as ReviewRoundState["overruledBlockersFrom"][number][]) : [];
  s = withCell(s, ticket, (c) => ({
    ...c,
    reviews: replaceLast(c.reviews, (r) => r.round === round, (r) => ({
      ...r,
      outcome: d.outcome,
      decidedAt: at,
      decidedEventId: e.id,
      decidedLate: e.late === true,
      approvals: d.approvals,
      overruledBlockersFrom: overruled,
      findings: r.findings.map((f) => (passed && f.severity === "blocker" ? { ...f, outvoted: true } : f)),
    })),
  }));
  s = setGate(s, ticket ?? "", "review", round, passed ? "passed" : "failed", `${d.outcome}: ${d.approvals} approved, ${d.approvals_needed} needed`, at, e.pos, metaOf(e));
  if (d.outcome === "AWAITING_HUMAN") s = setGate(s, ticket ?? "", "human-approval", round, "waiting", "The panel approved; a person must approve before merge.", at, e.pos, metaOf(e));
  return s;
}

function toolCalled(input: Scene, e: E<"tool.called">, at: number): Scene {
  let s = input;
  const agentId = e.ids.agent_id;
  const callId = e.ids.tool_call_id;
  const ticket = e.ids.ticket_id;
  if (!agentId || !callId) return s;
  // Per-call tools exist only for the main loop and Agent-tool sub-agents (contract D13). They have no
  // agent.started of their own: the first call makes them known. The main loop's id is the
  // contract's `<execution>/main`, compared whole, not parsed.
  if (!findAgentCell(s, agentId, ticket).agent) {
    const isMain = e.ids.execution_id !== null && agentId === `${e.ids.execution_id}/main`;
    const agent = agentOf(e, agentId, {
      label: isMain ? "Main loop" : "Sub-agent",
      observation: "per-call",
      toolCallCount: 0,
      startedAt: at,
      meta: metaOf(e, { unknown: ["startedAt", "effort", "tier", "model", "phase"], start: "inferred" }),
    });
    s = placeAgent(s, agent);
    s = { ...s, counters: bump(s.counters, { agentsActive: 1, agentsStarted: 1 }) };
  }
  const d = e.data;
  const { tool, known } = toolOf(d.tool);
  const call: ToolCallState = {
    id: callId,
    agentId,
    ticketId: ticket ?? "",
    tool,
    target: d.path_rel ?? d.script ?? d.target_class,
    startedAt: at,
    startedSeq: e.pos,
    finishedAt: null,
    status: "running",
    result: "running",
    summary: null,
    artifactIds: [],
    toolName: d.tool,
    meta: metaOf(e, { unknown: known ? [] : ["tool"] }),
  };
  s = updateAgent(s, agentId, ticket, (a) =>
    a.toolCalls.some((c) => c.id === callId) ? a : { ...a, currentToolCallId: callId, toolCalls: [...a.toolCalls, call], toolCallCount: (a.toolCallCount ?? 0) + 1, lastTool: d.tool },
  );
  return { ...s, counters: bump(s.counters, { toolCallsActive: 1, toolCalls: 1 }) };
}

function artifactRecorded(input: Scene, e: E<"artifact.recorded">, at: number): Scene {
  const ticket = e.ids.ticket_id;
  const d = e.data;
  const { kind, known } = artifactKindOf(d.kind);
  const id = firstRef(e, "artifact") ?? `${ticket ?? ""}:${d.path_rel}`;
  let s = withCell(input, ticket, (cell) => {
    const versions = cell.artifacts.filter((a) => a.path === d.path_rel).length;
    const artifact: ArtifactState = {
      id,
      ticketId: ticket ?? "",
      kind,
      path: d.path_rel,
      label: d.path_rel,
      station: e.ids.station,
      round: e.ids.round,
      version: versions + 1,
      sha: d.sha256,
      summary: "",
      // Which agent wrote it is never recorded for workflow agents (contract 12.2).
      writer: { agentId: null, callId: null, script: e.origin.script },
      writtenAt: at,
      seq: e.pos,
      record: { nature: d.nature, integrity: d.integrity, bytes: d.bytes, mediaType: d.media_type, commit: d.commit },
      meta: metaOf(e, { unknown: ["writer", "summary", ...(known ? [] : ["kind"])] }),
    };
    const index = cell.artifacts.findIndex((a) => a.id === id);
    return { ...cell, artifactRecords: cell.artifactRecords + 1, artifacts: index >= 0 ? cell.artifacts.map((a, i) => (i === index ? artifact : a)) : [...cell.artifacts, artifact] };
  });
  s = { ...s, counters: bump(s.counters, { artifacts: 1, commits: d.commit && d.nature === "code" ? 1 : 0 }) };
  return s;
}

const SCHEDULER_WORDS: Readonly<Record<string, SliceState["scheduler"]>> = {
  ready: "eligible",
  eligible: "eligible",
  active: "dispatched",
  dispatched: "dispatched",
  blocked: "waiting-on-dependency",
  "waiting-on-dependency": "waiting-on-dependency",
  completed: "integrated",
  integrated: "integrated",
};

/**
 * Seed or correct the scene from an observer snapshot (after a gap or a reset). Everything it sets is
 * `reconstructed`; what the snapshot does not say is left as it was.
 */
function applySnapshot(input: Scene, e: E<"client.snapshot_applied">, at: number, definitions: ProductDefinitions): Scene {
  let s = input;
  const st = e.data.state;
  const meta = (unknown: string[] = []): EntityMeta => ({ authority: "reconstructed", eventId: e.id, fields: {}, unknown, inferred: {}, start: "unknown", end: "unknown", late: false });
  for (const w of st.waves ?? []) {
    if (s.waves[w.wave_id]) continue;
    s = { ...s, waves: put(s.waves, w.wave_id, { id: w.wave_id, title: definitions.waves[w.wave_id]?.title ?? w.wave_id, epicTitle: "", revision: w.revision ?? null, sliceIds: w.slices ?? [], approvedBy: "a person", approvedAt: "", state: "validated", discoveredAt: at, seq: 0, meta: meta(["title", "epicTitle", "approvedAt", "discoveredAt"]) }) };
  }
  for (const x of st.slices ?? []) {
    const scheduler = x.state ? SCHEDULER_WORDS[x.state] : undefined;
    const prior = s.slices[x.slice_id];
    const slice: SliceState = prior
      ? { ...prior, scheduler: scheduler ?? prior.scheduler, meta: { ...prior.meta, authority: "reconstructed", eventId: e.id } }
      : {
          id: x.slice_id,
          title: definitions.slices[x.slice_id]?.title ?? x.slice_id,
          summary: "",
          waveId: "",
          revision: x.revision ?? null,
          risk: "Medium",
          ticketId: x.ticket_id ?? "",
          dependsOn: x.dependencies ?? [],
          scheduler: scheduler ?? "materialized",
          reasons: [],
          since: at,
          integratedCommit: null,
          history: [],
          meta: meta(["title", "summary", "risk", "waveId", "since", ...(scheduler ? [] : ["scheduler"])]),
        };
    s = { ...s, slices: put(s.slices, slice.id, slice) };
  }
  for (const c of st.cells ?? []) {
    const stage = stageOf(c.stage);
    const prior = s.cells[c.ticket_id];
    const cell: CellState = prior ?? { ...newCell(c.ticket_id, c.slice_id ?? "", definitions, at, meta(["title", "summary", "risk", "appType", "openedAt"])), title: c.slice_id ?? c.ticket_id };
    let next: CellState = { ...cell, stage: stage ?? cell.stage, round: c.rounds ?? cell.round, meta: { ...cell.meta, authority: "reconstructed", eventId: e.id, fields: stage ? { ...cell.meta.fields, stage: "reconstructed" } : cell.meta.fields } };
    // The plan's facts as the observer projected them (`plan`, else the cell's own app type and risk).
    const plan = c.plan ?? null;
    next = withPlanFacts(next, { appType: plan?.app_type ?? c.app_type ?? null, risk: riskOf(plan?.risk ?? c.risk), contracts: countOf(plan?.contracts), tasks: countOf(plan?.tasks) }, plan?.recorded_by ?? null, "reconstructed");
    s = { ...s, cells: put(s.cells, c.ticket_id, next) };
  }
  for (const x of st.executions ?? []) {
    const prior = s.executions[x.execution_id];
    const state = x.state === "running" || x.state === "active" ? "running" : x.state === "claimed" ? "claimed" : x.state === "completed" || x.state === "finished" ? "completed" : x.state === "failed" ? "failed" : null;
    // The observer's process states (`/runs`): the process ended and the supervisor has not recorded
    // the outcome (`ended`), or it ended badly. Never read as still running.
    const ended = x.state === "ended" ? "exited" : x.state === "interrupted" || x.state === "timed-out" || x.state === "could-not-start" ? x.state : null;
    const base = prior ?? newExecution({ ...e, ids: { ...e.ids, ticket_id: x.ticket_id ?? null, execution_id: x.execution_id } } as unknown as AnyV3Event, x.execution_id, { meta: meta(["next", "claimedAt", "startedAt"]) });
    s = { ...s, executions: put(s.executions, x.execution_id, { ...base, state: state ?? (ended ? "running" : base.state), ended: ended ?? base.ended, attempt: x.attempt ?? base.attempt, meta: { ...base.meta, authority: "reconstructed", eventId: e.id } }) };
  }
  for (const g of st.gates ?? []) {
    const kind = g.gate as Parameters<typeof gateId>[1];
    const state = g.state === "passed" || g.state === "failed" || g.state === "waiting" || g.state === "open" || g.state === "skipped" ? g.state : null;
    if (!state) continue;
    s = setGate(s, g.ticket_id, kind, g.round ?? null, state, "From the observer's snapshot.", at, 0, meta());
  }
  return { ...s, completeness: { ...s.completeness, state: "reconstructed", since: at, observer: st.history ?? s.completeness.observer } };
}

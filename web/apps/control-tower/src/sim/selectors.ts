/**
 * Selectors the views need on top of sceneAt: events in a time window (for animations), what
 * changed between two times, the events behind any entity (for the inspector), per-cell and
 * per-agent timelines (for the synchronized timeline), and the run's significant moments. All pure.
 * Static results (timelines, moments) are computed once per fixture and cached.
 */
import type { AnySimEvent, EventKind } from "./events";
import type { Significance } from "./catalog";
import { EVENT_CATALOG } from "./catalog";
import { describe } from "./describe";
import { describeEntry, significanceOf } from "./describe-v3";
import { indexFixture, lowerBound, upperBound } from "./engine";
import type { LogEntry, SceneLog } from "./log";
import { isSceneLog } from "./log";
import type { LogFold } from "./fold";
import { countThrough, createLogFold } from "./fold";
import type { ActivityState, Authority, EntityMeta } from "./provenance";
import type {
  AnyRef,
  ActorId,
  ActorState,
  AgentState,
  ArtifactState,
  CellState,
  Chapter,
  DependencyState,
  EntityRef,
  ExecutionState,
  FindingState,
  Fixture,
  GateState,
  Scene,
  SeatState,
  SliceState,
  StationVisit,
  ToolCallState,
  WaveState,
} from "./model";
import { gateId, isActorRef, ref, refId, refKind } from "./model";
import type { CapacityWaitState, GateEvaluation, LiveEntityKind, LiveRef } from "./model";
import { gateOfRef } from "./gates";

/**
 * Where events come from: a simulation fixture (the M6.0 API, returning the fixture's own events) or
 * a scene log (live, replay, or a fixture's log), returning log entries. Every selector below that
 * takes a fixture also takes a log; views move from `state.fixture` to `state.log` one call at a time.
 */
export type History = Fixture | SceneLog;

/** The scene log behind a history. */
export function logOf(history: History): SceneLog {
  return isSceneLog(history) ? history : indexFixture(history).log;
}

/** The scene at t, from either kind of history. */
export function sceneAtIn(history: History, t: number): Scene {
  return logOf(history).sceneAt(t);
}
const sceneAt = sceneAtIn;
import type { CellStage, StationId, StepAction } from "./vocabulary";

// ---------------------------------------------------------------- events in time

/** Events with from < event.t <= to, in order. */
export function eventsBetween(fixture: Fixture, from: number, to: number): readonly AnySimEvent[];
export function eventsBetween(log: SceneLog, from: number, to: number): readonly LogEntry[];
export function eventsBetween(history: History, from: number, to: number): readonly AnySimEvent[] | readonly LogEntry[] {
  if (!isSceneLog(history)) {
    const index = indexFixture(history);
    return index.events.slice(upperBound(index.times, from), upperBound(index.times, to));
  }
  const times = history.times();
  return history.entries().slice(upperBound(times, from), upperBound(times, to));
}

/**
 * Events in the last `windowMs` before t (t - windowMs < event.t <= t), optionally filtered by
 * kind. A view draws each one's motion from `t - event.t`.
 */
export function eventsInWindow(fixture: Fixture, t: number, windowMs: number, kinds?: readonly string[]): readonly AnySimEvent[];
export function eventsInWindow(log: SceneLog, t: number, windowMs: number, kinds?: readonly string[]): readonly LogEntry[];
export function eventsInWindow(history: History, t: number, windowMs: number, kinds?: readonly string[]): readonly AnySimEvent[] | readonly LogEntry[] {
  if (!isSceneLog(history)) {
    const found = eventsBetween(history, t - windowMs, t);
    return kinds ? found.filter((e) => kinds.includes(e.type)) : found;
  }
  const found = eventsBetween(history, t - windowMs, t);
  return kinds ? found.filter((e) => kinds.includes(e.event.type)) : found;
}

export interface Changes {
  readonly from: number;
  readonly to: number;
  /** forward: these events happened; backward: they are undone; none: same moment. */
  readonly direction: "forward" | "backward" | "none";
  readonly events: readonly AnySimEvent[];
  /** Every entity those events touch, without duplicates. */
  readonly refs: readonly EntityRef[];
}

/** What changed between two playhead times, in either direction. */
export function changesBetween(fixture: Fixture, t1: number, t2: number): Changes;
export function changesBetween(log: SceneLog, t1: number, t2: number): LogChanges;
export function changesBetween(history: History, t1: number, t2: number): Changes | LogChanges {
  const log = logOf(history);
  const times = log.times();
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  const a = upperBound(times, lo);
  const b = upperBound(times, hi);
  const entries = log.entries().slice(a, b);
  const refs = new Set<EntityRef>();
  for (const entry of entries) for (const r of entry.refs) refs.add(r);
  const direction = a === b ? "none" : t2 > t1 ? "forward" : "backward";
  if (isSceneLog(history)) return { from: t1, to: t2, direction, entries, refs: [...refs] };
  return { from: t1, to: t2, direction, events: entries.map((e) => e.event as AnySimEvent), refs: [...refs] };
}

export interface LogChanges {
  readonly from: number;
  readonly to: number;
  readonly direction: "forward" | "backward" | "none";
  readonly entries: readonly LogEntry[];
  readonly refs: readonly EntityRef[];
}

/** Simulation only: the event with this seq. Live and replay: use entryById (events are linked by id). */
export function eventBySeq(fixture: Fixture, seq: number): AnySimEvent | null {
  const index = indexFixture(fixture);
  const i = index.indexBySeq.get(seq);
  return i === undefined ? null : (index.events[i] ?? null);
}

/** The entities an event touches. */
export function refsOfEvent(fixture: Fixture, seq: number): readonly EntityRef[] {
  const index = indexFixture(fixture);
  const i = index.indexBySeq.get(seq);
  return i === undefined ? [] : (index.refsByEvent[i] ?? []);
}

/** The supervisor or scheduler that wrote an event, or null (intake, the engineer, the stations). */
export function actorOfEvent(fixture: Fixture, seq: number): AnyRef | null {
  const index = indexFixture(fixture);
  const i = index.indexBySeq.get(seq);
  return i === undefined ? null : (index.actorsByEvent[i] ?? null);
}

/** The events behind an entity, oldest first; with t, only those that have happened by t. */
export function eventsFor(fixture: Fixture, entity: AnyRef, t?: number): readonly AnySimEvent[];
export function eventsFor(log: SceneLog, entity: AnyRef, t?: number): readonly LogEntry[];
export function eventsFor(history: History, entity: AnyRef, t?: number): readonly AnySimEvent[] | readonly LogEntry[] {
  const found = entriesFor(logOf(history), entity, t);
  return isSceneLog(history) ? found : found.map((e) => e.event as AnySimEvent);
}

function entriesFor(log: SceneLog, entity: AnyRef, t?: number): readonly LogEntry[] {
  const all = log.entriesFor(entity);
  if (t === undefined) return all;
  let n = all.length;
  while (n > 0 && (all[n - 1] as LogEntry).t > t) n--;
  return n === all.length ? all : all.slice(0, n);
}

/** The latest event behind an entity at time t: what the inspector shows as "why it looks like this". */
export function latestEventFor(fixture: Fixture, entity: AnyRef, t: number): AnySimEvent | null;
export function latestEventFor(log: SceneLog, entity: AnyRef, t: number): LogEntry | null;
export function latestEventFor(history: History, entity: AnyRef, t: number): AnySimEvent | LogEntry | null {
  const found = entriesFor(logOf(history), entity, t);
  const last = found[found.length - 1];
  if (!last) return null;
  return isSceneLog(history) ? last : (last.event as AnySimEvent);
}

/** Time of the next event strictly after t, or null at the end (simulation) or at the live edge (live: nothing later received yet). */
export function nextEventTime(history: History, t: number): number | null {
  const times = logOf(history).times();
  return times[upperBound(times, t)] ?? null;
}

/** Time of the latest event strictly before t, or null at the start (or the retained floor). */
export function previousEventTime(history: History, t: number): number | null {
  const times = logOf(history).times();
  const i = lowerBound(times, t) - 1;
  return i >= 0 ? (times[i] ?? null) : null;
}

// ---------------------------------------------------------------- event-to-entity links (Evidence Theater, Analytics)

/** One event by id, with the entities it touches, its authority and time quality. */
export function entryById(history: History, id: string): LogEntry | null {
  return logOf(history).entry(id) ?? null;
}

/** The entities an event touches (event id → refs). Live: the observer's `entities`; never derived from ids. */
export function refsOfEntry(history: History, id: string): readonly EntityRef[] {
  return logOf(history).entry(id)?.refs ?? [];
}

/** The ids of the events behind an entity, in history order, up to t (entity ref → event ids). */
export function eventIdsFor(history: History, entity: AnyRef, t?: number): readonly string[] {
  return entriesFor(logOf(history), entity, t).map((e) => e.id);
}

/**
 * How far the history reaches. Simulation: the whole recorded run (`whole-run`). Live and replay:
 * what has been received so far (`so-far`): `end` is the live edge, never a future the client has
 * not seen; `events` counts what is held, not what the run will have.
 */
export interface Extent {
  readonly kind: "whole-run" | "so-far";
  readonly start: number;
  readonly end: number;
  readonly events: number;
  /** Events compacted away below `start` (live): replay cannot go below the floor. */
  readonly belowFloor: number;
}

export function extentOf(history: History, liveAt?: number): Extent {
  if (!isSceneLog(history)) return { kind: "whole-run", start: 0, end: history.duration, events: history.events.length, belowFloor: 0 };
  const start = history.floorTime() ?? liveAt ?? 0;
  const end = Math.max(liveAt ?? history.headTime() ?? start, history.headTime() ?? start);
  return { kind: history.provenance.source === "simulation" ? "whole-run" : "so-far", start, end, events: history.size(), belowFloor: history.dropped() };
}

// ---------------------------------------------------------------- the scene, flattened

export type EntityState =
  | { kind: "wave"; value: WaveState }
  | { kind: "slice"; value: SliceState }
  | { kind: "cell"; value: CellState }
  | { kind: "station"; value: { station: StationId; ticketId: string | null; visits: readonly StationVisit[]; cells: readonly string[] } }
  | { kind: "execution"; value: ExecutionState }
  | { kind: "agent"; value: AgentState }
  | { kind: "tool"; value: ToolCallState }
  | { kind: "artifact"; value: ArtifactState }
  | { kind: "gate"; value: GateState }
  | { kind: "dependency"; value: DependencyState }
  | { kind: "finding"; value: FindingState }
  | { kind: "actor"; value: ActorState }
  | { kind: "visit"; value: VisitEntity }
  | { kind: "seat"; value: SeatEntity }
  | { kind: "workflow"; value: WorkflowEntity }
  | { kind: "project"; value: ProjectEntity };

/** One station visit, with the cell it belongs to (`visit:<ticket>/<station>#<n>`). */
export type VisitEntity = StationVisit & { readonly ticketId: string; readonly visitId: string };

/** One review seat (`seat:<ticket>/review#<round>/<seat>`): it exists from its round's start, whether or not its reviewer is seen. */
export interface SeatEntity {
  readonly ticketId: string;
  readonly round: number;
  readonly seat: string;
  readonly model: SeatState["model"];
  readonly agentId: string | null;
  readonly vote: "APPROVE" | "REJECT" | null;
  readonly votedAt: number | null;
  readonly votedEventId: string | null;
  readonly votedLate: boolean;
  /** The round's start: the event that made the seat. */
  readonly eventId: string;
  readonly late: boolean;
  readonly findings: number;
}

/** A Dynamic Workflow (`workflow:<execution>/<task>`), as its execution records it. Its agents are found by identity. */
export interface WorkflowEntity {
  readonly id: string;
  readonly executionId: string;
  readonly ticketId: string;
  readonly name: string | null;
  readonly status: ExecutionState["workflowStatus"];
  readonly stopReason: ExecutionState["stopReason"];
  readonly finishedAt: number | null;
  /** The declared phase list (not phases entered: those are not observable). */
  readonly phases: readonly string[];
  readonly queued: number;
  /** The workflow's own records (workflow.*, observed): never its execution's (D23). */
  readonly agentIds: readonly string[];
  readonly meta: EntityMeta;
}

/** The project (`project:<id>`): what the history holds about it. */
export interface ProjectEntity {
  readonly id: string;
  /** Not recorded in events (the observer's session may name its folder). Null: not recorded. */
  readonly name: string | null;
  readonly integrationBranch: string | null;
  readonly factory: Scene["factory"];
  readonly waves: number;
  readonly slices: number;
  readonly cells: number;
  readonly executions: number;
}

const agentsCache = new WeakMap<Readonly<Record<string, CellState>>, readonly AgentState[]>();

/** Every agent in the scene (finished ones too), in start order. */
export function allAgents(scene: Scene): readonly AgentState[] {
  const cached = agentsCache.get(scene.cells);
  if (cached) return cached;
  const out: AgentState[] = [];
  for (const cell of Object.values(scene.cells)) for (const id of cell.agentOrder) out.push(cell.agents[id] as AgentState);
  for (const agent of Object.values(scene.strayAgents)) out.push(agent);
  out.sort((a, b) => a.startedAt - b.startedAt || a.startedSeq - b.startedSeq);
  agentsCache.set(scene.cells, out);
  return out;
}

export function activeAgents(scene: Scene): readonly AgentState[] {
  return allAgents(scene).filter((a) => a.status === "running");
}

/** Tool calls running now, across every cell. */
export function toolCallsInFlight(scene: Scene): readonly ToolCallState[] {
  const out: ToolCallState[] = [];
  for (const agent of activeAgents(scene)) {
    const call = agent.currentToolCallId ? agent.toolCalls.find((c) => c.id === agent.currentToolCallId) : undefined;
    if (call) out.push(call);
  }
  return out;
}

/** An agent by its id, wherever it is. Ids are opaque: this looks it up, it never reads the id. */
export function findAgent(scene: Scene, agentId: string): AgentState | null {
  for (const cell of Object.values(scene.cells)) {
    const agent = cell.agents[agentId];
    if (agent) return agent;
  }
  return scene.strayAgents[agentId] ?? null;
}

export function findToolCall(scene: Scene, callId: string): ToolCallState | null {
  for (const agent of allAgents(scene)) {
    const call = agent.toolCalls.find((c) => c.id === callId);
    if (call) return call;
  }
  return null;
}

export function findArtifact(scene: Scene, artifactId: string): ArtifactState | null {
  for (const cell of Object.values(scene.cells)) {
    const artifact = cell.artifacts.find((a) => a.id === artifactId);
    if (artifact) return artifact;
  }
  return null;
}

/** The cells at a station now. */
export function cellsAtStation(scene: Scene, station: StationId): readonly CellState[] {
  return Object.values(scene.cells).filter((cell) => cell.station === station);
}

/** Look up any entity by its reference. Null when it does not exist (yet) at this moment. */
export function entityAt(scene: Scene, entity: AnyRef): EntityState | null {
  const id = refId(entity);
  switch (refKind(entity)) {
    case "actor": {
      const actor = isActorRef(entity) ? scene.actors[id as ActorId] : undefined;
      return actor ? { kind: "actor", value: actor } : null;
    }
    case "wave":
      return scene.waves[id] ? { kind: "wave", value: scene.waves[id] } : null;
    case "slice":
      return scene.slices[id] ? { kind: "slice", value: scene.slices[id] } : null;
    case "cell":
      return scene.cells[id] ? { kind: "cell", value: scene.cells[id] } : null;
    case "execution":
      return scene.executions[id] ? { kind: "execution", value: scene.executions[id] } : null;
    case "gate": {
      // Either vocabulary: the scene's gate id or the observer's evaluation ref (R5).
      const gate = gateOfRef(scene, id);
      return gate ? { kind: "gate", value: gate } : null;
    }
    case "dependency":
      return scene.dependencies[id] ? { kind: "dependency", value: scene.dependencies[id] } : null;
    case "agent": {
      const agent = findAgent(scene, id);
      return agent ? { kind: "agent", value: agent } : null;
    }
    case "tool": {
      const call = findToolCall(scene, id);
      return call ? { kind: "tool", value: call } : null;
    }
    case "artifact": {
      const artifact = findArtifact(scene, id);
      return artifact ? { kind: "artifact", value: artifact } : null;
    }
    case "finding": {
      for (const cell of Object.values(scene.cells)) for (const round of cell.reviews) {
        const finding = round.findings.find((f) => f.id === id);
        if (finding) return { kind: "finding", value: finding };
      }
      return null;
    }
    case "station": {
      // The station ref's grammar (`<ticket>/<station>`) is the contract's (5.2), not an opaque id.
      const [ticketId, station] = id.includes("/") ? (id.split("/") as [string, StationId]) : [null, id as StationId];
      if (ticketId) {
        const cell = scene.cells[ticketId];
        if (!cell) return null;
        return { kind: "station", value: { station, ticketId, visits: cell.visits.filter((v) => v.station === station), cells: cell.station === station ? [ticketId] : [] } };
      }
      const visits = Object.values(scene.cells).flatMap((cell) => cell.visits.filter((v) => v.station === station));
      return { kind: "station", value: { station, ticketId: null, visits, cells: cellsAtStation(scene, station).map((c) => c.ticketId) } };
    }
    // Live and replay kinds: found by identity in the scene, never by parsing the id.
    case "visit":
      for (const cell of Object.values(scene.cells)) {
        const visit = cell.visits.find((v) => v.visitId === id);
        if (visit) return { kind: "visit", value: { ...visit, ticketId: cell.ticketId, visitId: id } };
      }
      return null;
    case "seat":
      for (const cell of Object.values(scene.cells)) {
        for (const round of cell.reviews) {
          for (const seat of round.seats) {
            if (ref.seat(cell.ticketId, round.round, seat.seat) !== entity) continue;
            return {
              kind: "seat",
              value: {
                ticketId: cell.ticketId,
                round: round.round,
                seat: seat.seat,
                model: seat.model,
                agentId: seat.agentId,
                vote: seat.vote,
                votedAt: seat.votedAt,
                votedEventId: seat.votedEventId,
                votedLate: seat.votedLate,
                eventId: round.eventId,
                late: round.late,
                findings: round.findings.filter((f) => f.seat === seat.seat).length,
              },
            };
          }
        }
      }
      return null;
    case "workflow":
      for (const x of Object.values(scene.executions)) {
        if (x.workflowId !== id) continue;
        const agentIds = allAgents(scene).filter((a) => a.workflowId === id).map((a) => a.id);
        return { kind: "workflow", value: { id, executionId: x.id, ticketId: x.ticketId, name: x.workflow, status: x.workflowStatus, stopReason: x.stopReason, finishedAt: x.workflowFinishedAt, phases: x.phases, queued: Object.keys(x.queued).length, agentIds, meta: x.workflowMeta ?? x.meta } };
      }
      return null;
    case "project":
      if (!scene.project.id || scene.project.id !== id) return null;
      return {
        kind: "project",
        value: {
          id,
          name: scene.project.name || null,
          integrationBranch: scene.project.integrationBranch || null,
          factory: scene.factory,
          waves: Object.keys(scene.waves).length,
          slices: Object.keys(scene.slices).length,
          cells: Object.keys(scene.cells).length,
          executions: Object.keys(scene.executions).length,
        },
      };
  }
}

/**
 * The set to highlight with an entity: for a slice, everything it waits for and everything that
 * waits for it (transitively), with the edges and cells; for a dependency, its chain: both ends,
 * the prerequisite's own prerequisites and the dependent's dependents (transitively); for a cell,
 * its slice and that slice's set; for an agent, its cell, parent and children.
 */
export function relatedRefs(scene: Scene, entity: EntityRef): readonly EntityRef[] {
  const out = new Set<EntityRef>([entity]);
  const id = refId(entity);
  // Walks the dependency graph from one slice, adding each slice reached, its cell and the links
  // crossed. "up" follows prerequisites (an edge runs from the dependent to its prerequisite);
  // "down" follows dependents.
  const visit = (start: string, direction: "up" | "down"): void => {
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      out.add(ref.slice(current));
      const ticket = scene.slices[current]?.ticketId;
      if (ticket && scene.cells[ticket]) out.add(ref.cell(ticket));
      for (const edge of Object.values(scene.dependencies)) {
        if (direction === "up" && edge.from === current) {
          out.add(ref.dependency(edge.from, edge.to));
          queue.push(edge.to);
        }
        if (direction === "down" && edge.to === current) {
          out.add(ref.dependency(edge.from, edge.to));
          queue.push(edge.from);
        }
      }
    }
  };
  const addSliceSet = (sliceId: string): void => {
    visit(sliceId, "up");
    visit(sliceId, "down");
  };
  switch (refKind(entity)) {
    case "slice":
      addSliceSet(id);
      break;
    case "dependency": {
      // The link's chain: the prerequisite and everything it waits on, the dependent and everything
      // that waits on it, with their cells and links. Sibling prerequisites of the dependent are
      // not part of this link's chain and dim.
      const [from, to] = id.split("->") as [string, string];
      visit(to, "up");
      visit(from, "down");
      break;
    }
    case "cell": {
      const cell = scene.cells[id];
      if (cell) addSliceSet(cell.sliceId);
      break;
    }
    case "agent": {
      const agent = findAgent(scene, id);
      if (agent) {
        out.add(ref.cell(agent.ticketId));
        if (agent.parentId) out.add(ref.agent(agent.parentId));
        for (const other of allAgents(scene)) if (other.parentId === agent.id) out.add(ref.agent(other.id));
        if (agent.currentToolCallId) out.add(ref.tool(agent.currentToolCallId));
      }
      break;
    }
    case "tool": {
      const call = findToolCall(scene, id);
      if (call) {
        out.add(ref.agent(call.agentId)).add(ref.cell(call.ticketId));
        for (const artifactId of call.artifactIds) out.add(ref.artifact(artifactId));
      }
      break;
    }
    case "artifact": {
      const artifact = findArtifact(scene, id);
      if (artifact) {
        out.add(ref.cell(artifact.ticketId));
        if (artifact.writer.agentId) out.add(ref.agent(artifact.writer.agentId));
        if (artifact.writer.callId) out.add(ref.tool(artifact.writer.callId));
      }
      break;
    }
    case "gate": {
      const gate = gateOfRef(scene, id);
      if (gate) out.add(ref.cell(gate.ticketId));
      break;
    }
    default:
      break;
  }
  return [...out];
}

// ---------------------------------------------------------------- timelines (static per fixture)

export interface Span {
  readonly start: number;
  /** null: still open when the scenario ends. */
  readonly end: number | null;
}
export interface StationSpan extends Span {
  readonly station: StationId;
  readonly action: StationVisit["action"];
  readonly round: number;
  readonly outcome: StationVisit["outcome"];
  readonly seq: number;
}
export interface AgentSpan extends Span {
  readonly agentId: string;
  readonly label: string;
  readonly role: AgentState["role"];
  readonly seat: AgentState["seat"];
  readonly model: AgentState["model"];
  readonly parentId: string | null;
  readonly station: StationId | null;
  /** Lane within the cell, so overlapping agents do not draw on top of each other. */
  readonly row: number;
}
export interface ToolSpan extends Span {
  readonly callId: string;
  readonly tool: ToolCallState["tool"];
  readonly target: string;
  readonly status: ToolCallState["status"];
}
export interface CellTimeline {
  readonly ticketId: string;
  readonly sliceId: string;
  readonly title: string;
  readonly opened: number;
  readonly stations: readonly StationSpan[];
  readonly stages: readonly { readonly stage: CellStage; readonly at: number; readonly seq: number }[];
  readonly agents: readonly AgentSpan[];
  readonly rows: number;
  readonly moments: readonly Moment[];
}
export interface AgentTimeline extends AgentSpan {
  readonly ticketId: string;
  /** Per-call spans. Empty and meaningless for a count-only agent: read `observation` and `toolCallCount`. */
  readonly tools: readonly ToolSpan[];
  readonly observation: AgentState["observation"];
  readonly toolCallCount: number | null;
  readonly lastTool: string | null;
}

const timelineCache = new WeakMap<Scene, readonly CellTimeline[]>();

/**
 * One timeline per cell, in the order the cells were opened, as known at playhead time t: spans
 * still open at t have `end: null` and no outcome, and nothing that starts after t is listed. Pass
 * `fixture.duration` for the whole recorded run (then hide what lies beyond the live edge).
 * Cached per scene: the same object for every t between two events.
 */
export function cellTimelines(history: History, t: number): readonly CellTimeline[] {
  const scene = sceneAt(history, t);
  const cached = timelineCache.get(scene);
  if (cached) return cached;
  const all = momentsOf(history, "minor", t);
  const out = Object.values(scene.cells)
    .sort((a, b) => a.openedAt - b.openedAt)
    .map((cell): CellTimeline => {
      const rowsEnd: number[] = [];
      const agents = cell.agentOrder.map((id) => {
        const a = cell.agents[id] as AgentState;
        let row = rowsEnd.findIndex((end) => end <= a.startedAt);
        if (row < 0) row = rowsEnd.length;
        rowsEnd[row] = a.finishedAt ?? Infinity;
        return { agentId: a.id, label: a.label, role: a.role, seat: a.seat, model: a.model, parentId: a.parentId, station: a.station, row, start: a.startedAt, end: a.finishedAt };
      });
      return {
        ticketId: cell.ticketId,
        sliceId: cell.sliceId,
        title: cell.title,
        opened: cell.openedAt,
        stations: cell.visits.map((v) => ({ station: v.station, action: v.action, round: v.round, outcome: v.outcome, seq: v.enteredSeq, start: v.enteredAt, end: v.leftAt })),
        stages: cell.stageHistory.map((s) => ({ stage: s.stage, at: s.at, seq: s.seq })),
        agents,
        rows: rowsEnd.length,
        moments: all.filter((m) => m.ticketId === cell.ticketId),
      };
    });
  timelineCache.set(scene, out);
  return out;
}

export function cellTimeline(history: History, ticketId: string, t: number): CellTimeline | null {
  return cellTimelines(history, t).find((x) => x.ticketId === ticketId) ?? null;
}

/** An agent's span and tool calls as known at t (open calls have `end: null` and status "running"). */
export function agentTimeline(history: History, agentId: string, t: number): AgentTimeline | null {
  for (const cell of cellTimelines(history, t)) {
    const span = cell.agents.find((a) => a.agentId === agentId);
    if (!span) continue;
    const agent = findAgent(sceneAt(history, t), agentId) as AgentState;
    return {
      ...span,
      ticketId: cell.ticketId,
      tools: agent.toolCalls.map((c) => ({ callId: c.id, tool: c.tool, target: c.target, status: c.status, start: c.startedAt, end: c.finishedAt })),
      observation: agent.observation,
      toolCallCount: agent.toolCallCount,
      lastTool: agent.lastTool,
    };
  }
  return null;
}

// ---------------------------------------------------------------- moments and chapters

export interface Moment {
  /** The event's id (`sim:<seq>` in the simulation). */
  readonly id: string;
  /** Simulation: the event's seq. Live and replay: its delivery position. Link by `id`. */
  readonly seq: number;
  readonly t: number;
  readonly kind: EventKind;
  readonly significance: Significance;
  readonly ticketId: string | null;
  readonly text: string;
  readonly refs: readonly EntityRef[];
}

const RANK: Record<Significance, number> = { chapter: 3, major: 2, minor: 1, ambient: 0 };
const momentCache = new WeakMap<Fixture, readonly Moment[]>();

/** One entry as a moment, whatever its source. */
function momentOfEntry(entry: LogEntry): Moment {
  const event = entry.event;
  const sim = event.schema_version !== 3;
  return {
    id: entry.id,
    seq: sim ? (event as AnySimEvent).seq : (event as { pos: number }).pos,
    t: entry.t,
    kind: event.type as EventKind,
    significance: sim ? EVENT_CATALOG[(event as AnySimEvent).type].significance : significanceOf(event.type),
    ticketId: sim ? (event as AnySimEvent).ticket_id : ((event as { ids: { ticket_id: string | null } }).ids.ticket_id ?? null),
    text: describeEntry(entry),
    refs: entry.refs,
  };
}

/** A log's moments at or above each significance, kept incrementally (src/sim/fold.ts): a batch of events costs what it adds. */
const momentFolds: Readonly<Record<Significance, (log: SceneLog) => LogFold<Moment>>> = {
  ambient: createLogFold((entry) => momentOfEntry(entry)),
  minor: createLogFold((entry) => (RANK[significanceOfEntry(entry)] >= RANK.minor ? momentOfEntry(entry) : null)),
  major: createLogFold((entry) => (RANK[significanceOfEntry(entry)] >= RANK.major ? momentOfEntry(entry) : null)),
  chapter: createLogFold((entry) => (RANK[significanceOfEntry(entry)] >= RANK.chapter ? momentOfEntry(entry) : null)),
};
function significanceOfEntry(entry: LogEntry): Significance {
  const event = entry.event;
  return event.schema_version !== 3 ? EVENT_CATALOG[(event as AnySimEvent).type].significance : significanceOf(event.type);
}

/** The first `n` items of a fold's list, one array per (list, n) while it is in use, so a selector can compare by identity. */
const prefixCache = new WeakMap<readonly Moment[], Map<number, readonly Moment[]>>();
function prefix(items: readonly Moment[], n: number): readonly Moment[] {
  let byCount = prefixCache.get(items);
  if (!byCount) prefixCache.set(items, (byCount = new Map()));
  let hit = byCount.get(n);
  if (!hit) {
    hit = items.slice(0, n);
    byCount.set(n, hit);
    // A small LRU: scrubbing asks for many counts; only the recent ones are worth keeping.
    if (byCount.size > 16) byCount.delete(byCount.keys().next().value as number);
  } else {
    byCount.delete(n);
    byCount.set(n, hit);
  }
  return hit;
}

/**
 * Events at or above a significance, with a sentence each, for timeline markers. With t, only the
 * moments that have happened by t (a view showing what is known at t should pass it).
 */
export function moments(history: History, atLeast: Significance = "major", t?: number): readonly Moment[] {
  return momentsOf(history, atLeast, t);
}

function momentsOf(history: History, atLeast: Significance, t?: number): readonly Moment[] {
  if (isSceneLog(history)) {
    // Incremental per log: only events added since the last read are described (fold.ts). Same array
    // for the same (significance, count) while it is in use.
    const items = momentFolds[atLeast](history).items;
    return prefix(items, t === undefined ? items.length : countThrough(items, t));
  }
  const fixture = history;
  let all = momentCache.get(fixture);
  if (!all) {
    const index = indexFixture(fixture);
    all = index.events.map((event, i) => ({
      id: `sim:${event.seq}`,
      seq: event.seq,
      t: event.t,
      kind: event.type,
      significance: EVENT_CATALOG[event.type].significance,
      ticketId: event.ticket_id,
      text: describe(event),
      refs: index.refsByEvent[i] ?? [],
    }));
    momentCache.set(fixture, all);
  }
  const floor = RANK[atLeast];
  return all.filter((m) => RANK[m.significance] >= floor && (t === undefined || m.t <= t));
}

/**
 * The storyboard's chapters. Simulation only: a recorded scenario knows its chapters in advance. A
 * live or replayed history has none (they would be future knowledge); its equivalent is the moments
 * received so far.
 */
export function chapters(history: History): readonly Chapter[] {
  return isSceneLog(history) ? [] : history.chapters;
}

/** The chapter the playhead is in (the last one that has started), or null before the first (and always, live). */
export function chapterAt(history: History, t: number): Chapter | null {
  let found: Chapter | null = null;
  for (const chapter of chapters(history)) if (chapter.t <= t) found = chapter;
  return found;
}

// ---------------------------------------------------------------- what is known about work in flight

/**
 * What is actually known about a span of work at time t: when it started, how long it has run, and
 * when it finished if it has. Nothing predictive: the simulation, like MACH, does not know how long
 * work will take, so there is no completion fraction for work in flight. Draw elapsed time (a
 * growing arc, a counter, ticks), never "x% done".
 */
export interface KnownTiming {
  /** False before the work started (t < startedAt). */
  readonly started: boolean;
  readonly startedAt: number;
  /** Milliseconds of work so far: up to t while running, the whole span once finished. */
  readonly elapsed: number;
  /** When it finished, if it had by t; otherwise null. */
  readonly finishedAt: number | null;
  readonly finished: boolean;
}

export function timingAt(startedAt: number, finishedAt: number | null, t: number): KnownTiming {
  const finished = finishedAt !== null && finishedAt <= t;
  return {
    started: t >= startedAt,
    startedAt,
    elapsed: Math.max(0, (finished ? (finishedAt as number) : t) - startedAt),
    finishedAt: finished ? finishedAt : null,
    finished,
  };
}

/** An agent's known timing at t (pass the agent from the scene at t, or any later scene). */
export function agentTimingAt(agent: Pick<AgentState, "startedAt" | "finishedAt">, t: number): KnownTiming {
  return timingAt(agent.startedAt, agent.finishedAt, t);
}

/** A tool call's known timing at t. */
export function toolCallTimingAt(call: Pick<ToolCallState, "startedAt" | "finishedAt">, t: number): KnownTiming {
  return timingAt(call.startedAt, call.finishedAt, t);
}

/** A station visit's known timing at t. */
export function visitTimingAt(visit: Pick<StationVisit, "enteredAt" | "leftAt">, t: number): KnownTiming {
  return timingAt(visit.enteredAt, visit.leftAt, t);
}

// ---------------------------------------------------------------- honest states (contract 8.1)

/**
 * What is known of an agent's tool activity:
 * - `calls`: each call is observed (the simulation, a main loop, an Agent-tool sub-agent);
 * - `count`: only how many calls it has made and the last tool's name (a Dynamic Workflow agent).
 *   Draw a number and a word, never ticks, bars or a "now running" beyond `lastTool`.
 */
export type ToolActivity =
  | { readonly kind: "calls"; readonly calls: readonly ToolCallState[]; readonly inFlight: ToolCallState | null }
  | { readonly kind: "count"; readonly count: number | null; readonly lastTool: string | null };

export function toolActivity(agent: AgentState): ToolActivity {
  if (agent.observation === "count-only") return { kind: "count", count: agent.toolCallCount, lastTool: agent.lastTool };
  const inFlight = agent.currentToolCallId ? (agent.toolCalls.find((c) => c.id === agent.currentToolCallId) ?? null) : null;
  return { kind: "calls", calls: agent.toolCalls, inFlight };
}

/** The authority behind one field of an entity (its own if the field has none recorded). */
export function authorityOf(meta: EntityMeta, field?: string): Authority {
  return (field && meta.fields[field]) || meta.authority;
}

/** Whether a field's value is recorded (false: the scene holds a placeholder; draw "not recorded"). */
export function isKnown(meta: EntityMeta, field: string): boolean {
  return !meta.unknown.includes(field);
}

/** Agents queued in a workflow and not yet started, across executions (live). */
export function queuedAgents(scene: Scene): readonly (ExecutionState["queued"][string] & { readonly executionId: string })[] {
  const out: (ExecutionState["queued"][string] & { readonly executionId: string })[] = [];
  for (const x of Object.values(scene.executions)) for (const q of Object.values(x.queued)) out.push({ ...q, executionId: x.id });
  return out.sort((a, b) => a.queuedAt - b.queuedAt);
}

export interface Activity {
  readonly state: ActivityState;
  /** A short sentence saying why, from what is recorded. */
  readonly reason: string;
  /** Since when, if known. */
  readonly since: number | null;
  readonly authority: Authority;
  /**
   * Work done and the next step not taken yet, when that is what is known: an approved cell not
   * merged yet (`step: "merge"`), a cell whose pull request is open. `by` is who takes the step when
   * an event says so (`line`: the Factory's own merge; `person`), else null: not recorded.
   */
  readonly awaiting?: { readonly step: "merge"; readonly label: string; readonly by: "line" | "person" | null; readonly basis: string | null };
  /**
   * Live: no execution is running for the cell and its last one has ended (the cell is idle between
   * executions). What that execution recorded: when it ended, the stage it left, the next step, and
   * what it stopped waiting for. Nothing says when the next execution starts.
   */
  readonly between?: { readonly executionId: string; readonly endedAt: number | null; readonly stage: CellStage | null; readonly next: StepAction | null; readonly waitingFor: string | null; readonly outcomeRecorded: boolean };
  /**
   * A short label for what is known when the state alone would say too little (R6): an execution
   * whose process ended before the supervisor recorded it is "ended, outcome not recorded yet", never
   * "running" nor "not known"; a cell idle between executions says so.
   */
  readonly label?: string;
}

/** The words a mast, a label or a status line prints for an activity: its own label, else the state's. */
export function activityLabel(activity: Activity, words: (state: ActivityState) => string): string {
  return activity.label ?? words(activity.state);
}

export interface ActivityOptions {
  /** The connection is stale or lost: what was executing can no longer be said to be. */
  readonly stale?: boolean;
}

const unknownActivity = (reason: string, authority: Authority = "reconstructed"): Activity => ({ state: "unknown", reason, since: null, authority });

/**
 * The state a view may draw for a cell, slice, execution or agent: executing, waiting on a dependency,
 * waiting for resources (only where a wait is recorded), waiting for a person, completed, failed,
 * interrupted, stale (the connection is lost while it was executing) or unknown. Every state comes
 * from a recorded fact; silence is never read as waiting (contract D16).
 */
const activityCache = new WeakMap<Scene, Map<string, Activity>>();
export function activityOf(scene: Scene, entity: EntityRef, options: ActivityOptions = {}): Activity {
  // A scene never changes; views ask this for every bay on every store change, so it is answered once per scene.
  let perScene = activityCache.get(scene);
  if (!perScene) activityCache.set(scene, (perScene = new Map()));
  const key = options.stale ? `${entity}\u0000stale` : entity;
  const hit = perScene.get(key);
  if (hit) return hit;
  const out = activityOfUncached(scene, entity, options);
  perScene.set(key, out);
  return out;
}

function activityOfUncached(scene: Scene, entity: EntityRef, options: ActivityOptions): Activity {
  const id = refId(entity);
  const stale = (a: Activity): Activity => (options.stale && a.state === "executing" ? { ...a, state: "stale", reason: `${a.reason} The connection is lost: this may have changed.` } : a);
  switch (refKind(entity)) {
    case "cell": {
      const cell = scene.cells[id];
      return cell ? stale(cellActivity(scene, cell)) : unknownActivity("Not in the history received.");
    }
    case "slice": {
      const slice = scene.slices[id];
      if (!slice) return unknownActivity("Not in the history received.");
      const authority = slice.meta.authority;
      if (slice.scheduler === "integrated") return { state: "completed", reason: "Integrated.", since: slice.since, authority };
      if (slice.scheduler === "waiting-on-dependency") return { state: "waiting-dependency", reason: slice.reasons.join(" ") || "Waiting for what it depends on.", since: slice.since, authority };
      const cell = slice.ticketId ? scene.cells[slice.ticketId] : undefined;
      if (slice.scheduler === "dispatched" && cell) return stale(cellActivity(scene, cell));
      if (slice.scheduler === "eligible") return { state: "unknown", reason: "Eligible and not dispatched; why it waits is not recorded.", since: slice.since, authority };
      return { state: "unknown", reason: "Taken in; not yet planned.", since: slice.since, authority };
    }
    case "execution": {
      const x = scene.executions[id];
      return x ? stale(executionActivity(x)) : unknownActivity("Not in the history received.");
    }
    case "agent": {
      const agent = findAgent(scene, id);
      if (!agent) return unknownActivity("Not in the history received.");
      const authority = agent.meta.authority;
      switch (agent.lifecycle) {
        case "queued":
          return { state: "waiting-resources", reason: "Queued in its workflow; not started.", since: agent.startedAt, authority };
        case "running":
          return stale({ state: "executing", reason: "Running.", since: agent.startedAt, authority });
        case "done":
          return { state: "completed", reason: "Finished.", since: agent.finishedAt, authority };
        case "error":
          return { state: "failed", reason: "Ended in an error.", since: agent.finishedAt, authority };
        case "unknown":
          return { state: "unknown", reason: "Its execution ended with no record of how it finished.", since: agent.finishedAt, authority };
      }
      return unknownActivity("No recorded state.");
    }
    default:
      return unknownActivity("Activity is defined for cells, slices, executions and agents.");
  }
}

/**
 * An execution's state in words, from what is recorded (R6): its process may have ended before the
 * supervisor recorded the outcome; it is then "Ended, outcome not recorded yet", never "running".
 */
export function executionStatusOf(x: Pick<ExecutionState, "state" | "processEndedAt" | "ended"> & Partial<Pick<ExecutionState, "recovery" | "movedOnAt">>, historyEndedAt: number | null = null): { readonly word: string; readonly running: boolean } {
  // One order with executionActivity and the observer's ExecStateIn (shared contracts 2.3): how the
  // process was stopped, then an outcome-unknown recovery, then the supervisor's failure or completion.
  if (x.ended === "interrupted") return { word: "Interrupted", running: false };
  if (x.ended === "timed-out") return { word: "Timed out", running: false };
  if (x.ended === "could-not-start") return { word: "Could not start", running: false };
  if (x.recovery === "outcome-unknown" && x.state !== "completed" && x.state !== "failed") return { word: "Outcome not known", running: false };
  if (x.state === "completed") return { word: "Completed", running: false };
  if (x.state === "failed") return { word: "Failed", running: false };
  if (x.processEndedAt !== null || x.ended !== null) return { word: "Ended, outcome not recorded yet", running: false };
  if (x.movedOnAt != null) return { word: "Outcome not known", running: false };
  // A history that is no longer live (a replay, a disabled Factory with no lease): open is not running.
  if (historyEndedAt !== null) return { word: "No end recorded", running: false };
  return x.state === "claimed" ? { word: "Claimed, not started", running: true } : { word: "Running", running: true };
}

function executionActivity(x: ExecutionState): Activity {
  const authority = x.meta.authority;
  if (x.ended === "interrupted" || x.ended === "timed-out") return { state: "interrupted", reason: x.ended === "timed-out" ? "Its process timed out." : "Its process was interrupted.", since: x.processEndedAt, authority };
  if (x.recovery === "outcome-unknown" && x.state !== "completed" && x.state !== "failed") return { state: "unknown", reason: "The supervisor could not learn how it ended.", since: x.endedAt, authority };
  if (x.state === "failed") return { state: "failed", reason: "The supervisor recorded a failure.", since: x.endedAt, authority };
  if (x.state === "completed") return { state: "completed", reason: "The supervisor recorded its end.", since: x.endedAt, authority };
  if (x.capacityWait) return { state: "waiting-resources", reason: "Held: every execution place is in use (recorded).", since: x.capacityWait.since, authority: "reconstructed" };
  if (x.ended || x.processEndedAt !== null) return { state: "unknown", reason: "Its process ended; the supervisor has not recorded the outcome yet.", since: x.processEndedAt, authority, label: "Ended, outcome not recorded yet" };
  if (x.movedOnAt !== null) return { state: "unknown", reason: "A later record (another claim of the same ticket, or the supervisor stopping for a person) shows the supervisor had moved on from it; how it ended is not recorded.", since: x.movedOnAt, authority: "reconstructed", label: "Outcome not known" };
  return { state: "executing", reason: x.state === "claimed" ? "Claimed by the supervisor." : "Running.", since: x.startedAt ?? x.claimedAt, authority };
}

function cellActivity(scene: Scene, cell: CellState): Activity {
  const authority = cell.meta.authority;
  if (cell.merged || cell.runRecord?.outcome === "merged") return { state: "completed", reason: "Merged.", since: cell.merged?.at ?? cell.runRecord?.at ?? null, authority };
  if (cell.runRecord?.outcome === "abandoned") return { state: "failed", reason: "Abandoned.", since: cell.runRecord.at, authority };
  if (cell.stage === "awaiting-human" || cell.stage === "spec-open") return { state: "waiting-person", reason: cell.stage === "spec-open" ? "The spec has open questions." : "A person must approve.", since: cell.stageHistory.at(-1)?.at ?? null, authority };
  if (cell.stage === "blocked") return { state: "waiting-person", reason: "Escalated to a person.", since: cell.stageHistory.at(-1)?.at ?? null, authority };
  // The human gate's id is the ticket's (one per ticket): looked up, never a scan of every gate per cell.
  const human = scene.gates[gateId(cell.ticketId, "human-approval")];
  const waitingGate = human?.state === "waiting" ? human : undefined;
  if (waitingGate) return { state: "waiting-person", reason: "A person must approve.", since: waitingGate.openedAt, authority: waitingGate.meta.authority };
  const execution = cell.executionId ? scene.executions[cell.executionId] : undefined;
  if (execution) {
    const x = executionActivity(execution);
    if (x.state === "interrupted" || x.state === "failed" || x.state === "waiting-resources") return x;
  }
  if (cell.capacityWait) return { state: "waiting-resources", reason: "Held: every execution place is in use (recorded).", since: cell.capacityWait.since, authority: "reconstructed" };
  // The simulation keeps M6.0's reading (a cell at a station is at work); its executions never end
  // without a record.
  if (authority === "simulated") {
    if (cell.station) return { state: "executing", reason: `At ${cell.station}.`, since: cell.stationSince, authority };
    if (execution && (execution.state === "running" || execution.state === "claimed")) return { state: "executing", reason: "Its execution is running.", since: execution.startedAt ?? execution.claimedAt, authority: execution.meta.authority };
  } else {
    // Live: at work only while the execution doing the work is running. A station visit left open by
    // an execution that has ended (no exit record) is not work going on.
    if (cell.station) {
      const open = cell.visits.findLast((v) => v.station === cell.station && v.leftAt === null);
      const owner = open?.executionId ? scene.executions[open.executionId] : execution;
      if (!owner || !hasEnded(owner)) return { state: "executing", reason: `At ${cell.station}.`, since: cell.stationSince, authority };
    }
    if (execution && !hasEnded(execution)) return { state: "executing", reason: execution.state === "claimed" ? "Claimed by the supervisor; its process has not started." : "Its execution is running.", since: execution.startedAt ?? execution.claimedAt, authority: execution.meta.authority };
  }
  const slice = scene.slices[cell.sliceId];
  if (slice?.scheduler === "waiting-on-dependency") return { state: "waiting-dependency", reason: slice.reasons.join(" ") || "Waiting for what it depends on.", since: slice.since, authority: slice.meta.authority };
  if (cell.stage === "approved" || cell.stage === "pr-open") return awaitingMerge(scene, cell, authority);
  if (execution && authority !== "simulated") return betweenExecutions(cell, execution);
  return { state: "unknown", reason: "Between stations; nothing recorded says what it waits for.", since: null, authority };
}

/** The execution has ended: the supervisor recorded its end, or its process ended (D4). */
const hasEnded = (x: ExecutionState): boolean => x.state === "completed" || x.state === "failed" || x.ended !== null || x.processEndedAt !== null || x.movedOnAt !== null;

/**
 * A live cell whose last execution has ended and none is running: idle between executions. Said from
 * what that execution recorded (its end, the stage it left, the next step, what it stopped waiting
 * for); a recorded wait for a person is `waiting-person`, anything else is `unknown`, because no
 * record says when the next execution starts or what holds it (silence is never a wait, D16).
 */
function betweenExecutions(cell: CellState, x: ExecutionState): Activity {
  const recorded = x.state === "completed" || x.state === "failed";
  const endedAt = recorded ? x.endedAt : x.processEndedAt;
  const between = { executionId: x.id, endedAt, stage: x.outcome?.stage ?? null, next: x.outcome?.next ?? null, waitingFor: x.outcome?.waitingFor ?? null, outcomeRecorded: recorded };
  const authority = x.meta.authority;
  if (!recorded) {
    return { state: "unknown", reason: "Idle: its process ended and the supervisor has not recorded the outcome yet. No execution is running.", since: endedAt, authority, between, label: "Idle, outcome not recorded yet" };
  }
  const left = between.stage ? ` at ${between.stage}` : "";
  if (between.waitingFor && (between.stage === null || between.stage === cell.stage)) {
    return { state: "waiting-person", reason: `Idle between executions: the last one stopped${left}, waiting for ${between.waitingFor}.`, since: endedAt, authority, between };
  }
  const next = between.next && between.next !== "stop" ? ` The next step recorded is ${between.next}.` : "";
  return { state: "unknown", reason: `Idle between executions: the last one ended${left}.${next} No execution is running; nothing recorded says when the next starts.`, since: endedAt, authority, between, label: "Idle between executions" };
}

/**
 * An approved cell not merged yet (or one whose pull request is open): its state is known. Review is
 * done (`completed`); the merge is the next step. Who merges is in the merge policy, which no event
 * carries, so it is said only where an event says it: the last execution stopped waiting for a person
 * at this stage (`execution.completed.waiting_for`), or its merge station ran and was refused.
 */
function awaitingMerge(scene: Scene, cell: CellState, authority: Authority): Activity {
  const since = cell.stageHistory.at(-1)?.at ?? null;
  const pr = cell.stage === "pr-open";
  const label = pr ? "Pull request open, not merged yet" : "Approved, not merged yet";
  const x = cell.executionId ? scene.executions[cell.executionId] : undefined;
  const stopped = x?.outcome && x.outcome.stage === cell.stage ? x.outcome : null;
  if (stopped?.waitingFor) {
    return { state: "waiting-person", reason: `${label}. The last execution stopped here, waiting for ${stopped.waitingFor}.`, since, authority: x?.meta.authority ?? authority, awaiting: { step: "merge", label, by: "person", basis: x?.meta.eventId ?? null } };
  }
  const refused = [...cell.gateLog].reverse().find((g) => (g.gate === "merge.run" || g.gate === "merge.land") && g.verdict === "refused");
  if (refused && refused.at >= (since ?? 0)) {
    return { state: "waiting-person", reason: `${label}. The merge station was refused (${refused.reasonCode ?? "no reason code"}).`, since: refused.at, authority, awaiting: { step: "merge", label, by: "person", basis: refused.eventId } };
  }
  return { state: "completed", reason: `${label}. ${pr ? "The pull request has not landed." : "Review approved it."} Who merges is not recorded.`, since, authority, awaiting: { step: "merge", label, by: null, basis: null } };
}

// ---------------------------------------------------------------- live-only entities

export type LiveEntityState = Extract<EntityState, { kind: LiveEntityKind }>;

/**
 * The live-only kinds (`visit:`, `seat:`, `workflow:`, `project:`). Kept for callers written before
 * they were EntityKinds: it is entityAt narrowed to them.
 */
export function liveEntityAt(scene: Scene, entity: LiveRef): LiveEntityState | null {
  const found = entityAt(scene, entity);
  return found && (found.kind === "visit" || found.kind === "seat" || found.kind === "workflow" || found.kind === "project") ? found : null;
}

/**
 * entityAt for a React selector: the same object for the same entity while its content is the same.
 * The live kinds (visit, seat, workflow, project) are assembled from several parts of the scene, so
 * entityAt makes a new object each call; this keeps the previous one when every field is the same
 * (shallow: the parts are the scene's own stable objects).
 */
const stableValues = new Map<string, unknown>();
const stableByScene = new WeakMap<Scene, Map<string, EntityState | null>>();
export function stableEntityAt(scene: Scene, entity: AnyRef): EntityState | null {
  let perScene = stableByScene.get(scene);
  if (!perScene) stableByScene.set(scene, (perScene = new Map()));
  if (perScene.has(entity)) return perScene.get(entity) ?? null;
  const found = entityAt(scene, entity);
  let out = found;
  if (found) {
    const prev = stableValues.get(entity) as EntityState | undefined;
    if (prev && prev.kind === found.kind && shallowSame(prev.value, found.value)) out = prev;
    else stableValues.set(entity, found);
    if (stableValues.size > 512) stableValues.delete(stableValues.keys().next().value as string);
  }
  perScene.set(entity, out);
  return out;
}
function shallowSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    if (x === y) continue;
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- lateness

/**
 * Whether an event reached this history late: the observer flagged it (`late`), or it reached this
 * browser after events that sort after it and was inserted where it belongs. Either way a view draws
 * what it set as a state change, never as motion replayed from its start. False for an unknown id.
 */
export function isLateEntry(log: SceneLog, eventId: string | null | undefined): boolean {
  return eventId ? (log.entry(eventId)?.late ?? false) : false;
}

// ---------------------------------------------------------------- cost

export interface CostCompleteness {
  /** True: the recorded spend is all of it. False: it may be under-reported. Null: no record says. */
  readonly complete: boolean | null;
  /** Why it may be incomplete, as the record says (`budget-stop`, `agents-killed-in-flight`). */
  readonly reasons: readonly string[];
  /** The event that says so. */
  readonly eventId: string | null;
}

/**
 * Whether an execution's recorded cost is complete, from the stream's own verdict only
 * (`execution.usage.cost_complete` and its reasons, schema revision 1). Nothing is guessed: with
 * no usage record, or one written before the field existed, it is not known (null).
 */
export function costCompletenessOf(x: ExecutionState): CostCompleteness {
  if (!x.usage) return { complete: null, reasons: [], eventId: null };
  return { complete: x.usage.costComplete, reasons: x.usage.costIncompleteReasons, eventId: x.usage.eventId };
}

// ---------------------------------------------------------------- recorded facts no gate state stands for

/** Recorded waits for an execution place, by ticket (capacity.wait_changed; reconstructed by the observer). */
export function capacityWaits(scene: Scene): readonly CapacityWaitState[] {
  return Object.values(scene.capacityWaits).sort((a, b) => a.since - b.since || (a.ticketId < b.ticketId ? -1 : 1));
}

/** The recorded capacity wait of one ticket, whether or not its cell is in the scene. */
export function capacityWaitOf(scene: Scene, ticketId: string): CapacityWaitState | null {
  return scene.capacityWaits[ticketId] ?? null;
}

export interface GateRefusal extends GateEvaluation {
  readonly ticketId: string;
}

/**
 * Gate evaluations the lifecycle log recorded as refused that no gate state stands for (a refused
 * `build.start`, `verify.start`, `groom.finalize`, `merge.run`, the round limit...), oldest first.
 * With a ticket, that cell's only. They are facts: draw them, never fold them into another gate.
 */
export function gateRefusals(scene: Scene, ticketId?: string): readonly GateRefusal[] {
  const cells = ticketId ? (scene.cells[ticketId] ? [scene.cells[ticketId]] : []) : Object.values(scene.cells);
  const out: GateRefusal[] = [];
  for (const cell of cells) for (const g of cell.gateLog) if (g.verdict === "refused" && g.gateId === null) out.push({ ...g, ticketId: cell.ticketId });
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- where a cell stands

export interface CellHome {
  readonly ticketId: string;
  /** The slice it builds, when recorded. */
  readonly sliceId: string | null;
  /** The wave its slice belongs to, when recorded (the slice's own, else a wave that lists it). */
  readonly waveId: string | null;
  /** The lane's title: the slice's title when recorded, else the ticket. Never a placeholder. */
  readonly laneTitle: string;
  readonly sliceKnown: boolean;
  readonly waveKnown: boolean;
}

/**
 * A cell's home in the picture, defined for every cell: a cell with no slice (a hand-driven ticket,
 * history begun part-way) stands under its own ticket, in a wave that is "not recorded".
 */
export function cellHome(scene: Scene, ticketId: string): CellHome {
  const cell = scene.cells[ticketId];
  const slice = cell?.sliceId ? scene.slices[cell.sliceId] : undefined;
  const waveId = slice ? (scene.waves[slice.waveId] ? slice.waveId : (Object.values(scene.waves).find((w) => w.sliceIds.includes(slice.id))?.id ?? null)) : cell?.sliceId ? (Object.values(scene.waves).find((w) => w.sliceIds.includes(cell.sliceId))?.id ?? null) : null;
  const title = slice && isKnown(slice.meta, "title") ? slice.title : ticketId;
  return { ticketId, sliceId: cell?.sliceId || null, waveId, laneTitle: title, sliceKnown: Boolean(slice), waveKnown: waveId !== null };
}

// ---------------------------------------------------------------- bays: a stable assignment table

/** One bay: the slice it is for and its cell's ticket (the slice's id until a ticket is known). A cell with no slice has `cell:<ticket>`. */
export interface BayClaim {
  readonly sliceId: string;
  readonly ticketId: string;
}

export interface BayOrder {
  /** Changes whenever `slots` or `waveIds` change. */
  readonly version: number;
  /** Index i is bay i, for the life of the log (and so of its store): a bay never moves. */
  readonly slots: readonly BayClaim[];
  /** Waves in the order they were assigned, also never reordered. */
  readonly waveIds: readonly string[];
}

interface BayTable {
  /** The version of each log of the lineage the table last read. */
  seen: WeakMap<SceneLog, number>;
  slots: BayClaim[];
  index: Map<string, number>;
  waveIds: string[];
  out: BayOrder;
}
/** One table per lineage (SceneLog.lineage): every log showing part of the same history shares it. */
const bayTables = new WeakMap<object, BayTable>();

/** The order key of the first retained event that touches an entity, or null. */
function firstOrder(log: SceneLog, entity: EntityRef): string | null {
  return log.entriesFor(entity)[0]?.order ?? null;
}

/**
 * The bays a log's history calls for, with an assignment table kept for the life of the log: what is
 * new is ordered by the contract's `order` of its first event (a wave's slices by their place in the
 * wave), then appended. Once a bay index is given it never changes, even when an older wave arrives
 * late. A slice outside any wave and a cell whose slice is not known each get a bay too; when a
 * cell's slice becomes known, its bay is kept and re-keyed to the slice.
 *
 * The table belongs to the log's lineage, not to the log: the windows of a long history (and the
 * live log they are read behind) are separate logs of one history, and a ticket keeps its bay
 * whichever window holds the playhead. A window that does not know something another one did never
 * takes it away (a bay stays; a ticket learned stays learned).
 */
export function bayOrder(log: SceneLog): BayOrder {
  const lineage = log.lineage ?? log;
  let table = bayTables.get(lineage);
  const logVersion = log.version();
  if (table && table.seen.get(log) === logVersion) return table.out;
  if (!table) {
    table = { seen: new WeakMap(), slots: [], index: new Map(), waveIds: [], out: { version: 0, slots: [], waveIds: [] } };
    bayTables.set(lineage, table);
  }
  const scene = log.head();
  let changed = false;
  const ticketOfSlice = new Map<string, string>();
  for (const c of Object.values(scene.cells)) if (c.sliceId) ticketOfSlice.set(c.sliceId, c.ticketId);
  const ticketFor = (sliceId: string): string => ticketOfSlice.get(sliceId) ?? (scene.slices[sliceId]?.ticketId || sliceId);

  // Waves: new ones by the order of their first event.
  const newWaves = Object.values(scene.waves)
    .filter((w) => !table.waveIds.includes(w.id))
    .map((w) => ({ id: w.id, key: firstOrder(log, ref.wave(w.id)) ?? "" }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  if (newWaves.length) {
    table.waveIds = [...table.waveIds, ...newWaves.map((w) => w.id)];
    changed = true;
  }

  // Candidates not yet assigned, each with its key: (order of first event, place in its wave).
  const candidates: { sliceId: string; ticketId: string; key: string; place: number }[] = [];
  const offered = new Set<string>();
  const offer = (sliceId: string, key: string | null, place: number): void => {
    if (!sliceId || offered.has(sliceId)) return;
    offered.add(sliceId);
    if (table.index.has(sliceId)) return;
    candidates.push({ sliceId, ticketId: ticketFor(sliceId), key: key ?? "", place });
  };
  for (const w of Object.values(scene.waves)) {
    const key = firstOrder(log, ref.wave(w.id));
    w.sliceIds.forEach((id, i) => offer(id, key, i));
  }
  for (const id of Object.keys(scene.slices)) offer(id, firstOrder(log, ref.slice(id)), 0);
  const tickets = new Set<string>();
  for (const slot of table.slots) tickets.add(slot.ticketId);
  for (const c of candidates) tickets.add(c.ticketId);
  for (const sliceId of offered) tickets.add(ticketFor(sliceId));
  for (const c of Object.values(scene.cells)) {
    if (tickets.has(c.ticketId)) continue;
    const key = `cell:${c.ticketId}`;
    if (table.index.has(key)) continue;
    candidates.push({ sliceId: key, ticketId: c.ticketId, key: firstOrder(log, ref.cell(c.ticketId)) ?? "", place: 0 });
  }
  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.place - b.place || (a.sliceId < b.sliceId ? -1 : 1)));

  let slots = table.slots;
  for (const c of candidates) {
    // A cell drawn before its slice was known keeps its bay: the bay is re-keyed to the slice.
    const standIn = table.index.get(`cell:${c.ticketId}`);
    if (standIn !== undefined && c.ticketId !== c.sliceId) {
      if (slots === table.slots) slots = slots.slice();
      slots[standIn] = { sliceId: c.sliceId, ticketId: c.ticketId };
      table.index.delete(`cell:${c.ticketId}`);
      table.index.set(c.sliceId, standIn);
      changed = true;
      continue;
    }
    if (slots === table.slots) slots = slots.slice();
    table.index.set(c.sliceId, slots.length);
    slots.push({ sliceId: c.sliceId, ticketId: c.ticketId });
    changed = true;
  }
  // A ticket learned later (the slice's cell opened) updates the slot; its index stays. Only a ticket
  // this log knows replaces the slice's id: a window from before the cell opened never undoes it.
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as BayClaim;
    if (slot.sliceId.startsWith("cell:")) continue;
    const ticketId = ticketFor(slot.sliceId);
    if (ticketId !== slot.ticketId && ticketId !== slot.sliceId) {
      if (slots === table.slots) slots = slots.slice();
      slots[i] = { sliceId: slot.sliceId, ticketId };
      changed = true;
    }
  }
  table.slots = slots;
  table.seen.set(log, logVersion);
  if (changed) table.out = { version: table.out.version + 1, slots: table.slots, waveIds: table.waveIds };
  return table.out;
}

// ---------------------------------------------------------------- M6.2 acceptance fixes

/** Authority rank for "why it looks like this": the record that decides wins at the same moment (D24). */
const AUTHORITY_RANK: Readonly<Record<Authority, number>> = { authoritative: 3, observed: 2, reconstructed: 1, simulated: 0 };

/**
 * The event that explains an entity at t: the latest behind it, and among several sharing that time,
 * the most authoritative (authoritative > observed > reconstructed), then the latest in order.
 */
export function whyEntry(log: SceneLog, entity: AnyRef, t: number): LogEntry | null {
  const found = entriesFor(log, entity, t);
  return whyOf(found, found.length);
}

/** whyEntry over a list already in order: the first `upto` entries (those that have happened). */
export function whyOf(entries: readonly LogEntry[], upto: number): LogEntry | null {
  const last = entries[upto - 1];
  if (!last) return null;
  let best = last;
  for (let i = upto - 2; i >= 0; i--) {
    const e = entries[i] as LogEntry;
    if (e.t !== last.t) break;
    if (AUTHORITY_RANK[e.authority] > AUTHORITY_RANK[best.authority]) best = e;
  }
  return best;
}

/**
 * The events behind an entity, in order: those that name it, and the event its own record names
 * (`meta.eventId`) when that one does not name it (D14: a human-approval gate set by a station's
 * entry or a review's decision; a visit closed by its execution's end).
 */
export function entriesBehind(log: SceneLog, entity: AnyRef): readonly LogEntry[] {
  const own = log.entriesFor(entity);
  const found = entityAt(log.head(), entity);
  const metaId = found && "meta" in (found.value as object) ? ((found.value as { meta?: EntityMeta }).meta?.eventId ?? null) : null;
  const extra = metaId ? log.entry(metaId) : undefined;
  if (!extra || own.includes(extra)) return own;
  const out = [...own];
  let i = out.length;
  while (i > 0 && (out[i - 1] as LogEntry).order > extra.order) i--;
  out.splice(i, 0, extra);
  return out;
}

/** What a station visit is doing, in words a view can print as they are (D4, D14). */
export interface VisitStatus {
  /**
   * `working`: open, at work; `waiting-person`: open, a person must act (never "working");
   * `ended`: an exit record closed it; `ended-unrecorded`: it never exited, and the scene closed it
   * at a bound (its next entry, or its execution's end).
   */
  readonly state: "working" | "waiting-person" | "ended" | "ended-unrecorded";
  readonly word: string;
  /** Why, when it ended without an exit record. */
  readonly detail: string | null;
}

export function visitStatusOf(visit: Pick<StationVisit, "station" | "leftAt" | "outcome" | "outcomeWord" | "unclosed">): VisitStatus {
  if (visit.unclosed) {
    const detail = visit.unclosed.reason === "superseded" ? "The station was entered again before this visit recorded an exit; its outcome is not known." : "Its execution ended before this visit recorded an exit; its outcome is not known.";
    return { state: "ended-unrecorded", word: "Ended without an exit record", detail };
  }
  if (visit.leftAt === null) return visit.station === "human-approval" ? { state: "waiting-person", word: "Waiting for a person", detail: null } : { state: "working", word: "Working", detail: null };
  const word = visit.outcomeWord ?? visit.outcome ?? "ended";
  return { state: "ended", word: word.replace(/^./, (c) => c.toUpperCase()), detail: null };
}

export interface GateOverride extends GateEvaluation {
  readonly ticketId: string;
}

/**
 * Every gate evaluation recorded as overridden (D6), oldest first, whether or not a gate state stands
 * for it (frozen-tests has none): reviewers must see each one, with its reason code.
 */
export function gateOverrides(scene: Scene, ticketId?: string): readonly GateOverride[] {
  const cells = ticketId ? (scene.cells[ticketId] ? [scene.cells[ticketId]] : []) : Object.values(scene.cells);
  const out: GateOverride[] = [];
  for (const cell of cells) for (const g of cell.gateLog) if (g.verdict === "overridden") out.push({ ...g, ticketId: cell.ticketId });
  return out.sort((a, b) => a.at - b.at);
}

/** The runtime state the observer reports for one execution's stream source (`/health` or `/factory/status` freshness). */
export interface SourceRuntime {
  readonly state: "proven" | "compatible-unproven" | "incompatible" | "unknown" | null;
  readonly version: string | null;
  readonly reason: string | null;
  /** Records refused for their shape (counted by the observer; nothing of them is shown). */
  readonly recordsRefused?: number | null;
}

/**
 * What can be said about an execution's agents and tools (D7), with the observer's judgement of the
 * Claude Code runtime that wrote its stream (observer M6.2: each record is accepted or refused on its
 * own shape):
 * - `observed`: its stream was read and described agents, the workflow or tools, from a proven
 *   runtime (or an observer too old to say);
 * - `unproven`: as observed, from a runtime version the observer's fixtures do not come from
 *   (`compatible-unproven`), or whose stream has not said its version yet (`unknown`): every record
 *   read matched the known shapes. Say so, never silently;
 * - `partial`: as observed, but some records did not match the known shapes and were refused
 *   (`incompatible`): what is shown is what matched;
 * - `not-observed`: no stream was received, every record was refused, or its records were received
 *   and not interpreted: agents and tools are "not observed", never zero.
 */
export interface StreamObservationState {
  readonly state: "observed" | "unproven" | "partial" | "not-observed";
  readonly reason: string | null;
  readonly version: string | null;
  /** Records received and not interpreted. */
  readonly notInterpreted: number;
  /** The runtime's state as the observer judged it; null when the observer does not say (before M6.2). */
  readonly runtime: "proven" | "compatible-unproven" | "incompatible" | "unknown" | null;
  /** Records the observer refused for their shape, when it reports them. */
  readonly recordsRefused: number | null;
}

export function streamObservationOf(scene: Scene, executionId: string, source: SourceRuntime | null = null): StreamObservationState {
  const x = scene.executions[executionId];
  const o = x?.observation;
  let notInterpreted = 0;
  for (const [key, n] of Object.entries(scene.completeness.notInterpreted)) if (key === `s:${executionId}` || key === `stream/${executionId}`) notInterpreted += n;
  const version = source?.version ?? o?.version ?? x?.claudeCodeVersion ?? null;
  const runtime = source?.state ?? o?.runtime ?? null;
  const recordsRefused = source?.recordsRefused ?? null;
  const named = version ? `Claude Code ${version}` : "its Claude Code version";
  const base = { version, notInterpreted, runtime, recordsRefused };
  const seen = (): StreamObservationState => {
    if (runtime === "incompatible") return { ...base, state: "partial", reason: `Some of its stream records did not match the known shapes and were refused${recordsRefused ? ` (${recordsRefused})` : ""}; what is shown is what matched.` };
    if (runtime === "compatible-unproven") return { ...base, state: "unproven", reason: `${named} is not one the observer has been proved on; every record read matched the known shapes.` };
    if (runtime === "unknown") return { ...base, state: "unproven", reason: "Its stream has not said which Claude Code version wrote it yet; every record read matched the known shapes." };
    return { ...base, state: "observed", reason: null };
  };
  if (o && o.structural > 0) return seen();
  if (runtime === "incompatible") return { ...base, state: "not-observed", reason: source?.reason ?? `${named}'s records did not match the known shapes and were refused.` };
  if (notInterpreted > 0) return { ...base, state: "not-observed", reason: `${notInterpreted} stream record${notInterpreted === 1 ? " was" : "s were"} received but not interpreted (${named} is not supported by the observer).` };
  if (!o || o.records === 0) return { ...base, state: "not-observed", reason: "No stream records were received for this execution." };
  return seen();
}

/** The runtime state of one execution's stream, from `/factory/status` freshness sources (`stream/<execution>`), or null. */
export function sourceRuntimeOf(sources: readonly { readonly key: string; readonly runtime?: SourceRuntime | null }[] | null | undefined, executionId: string): SourceRuntime | null {
  const found = sources?.find((x) => x.key === `stream/${executionId}` || x.key === `s:${executionId}`);
  return found?.runtime ?? null;
}

/**
 * A cell's artifact counts, each labelled for what it is (D13): `distinct` artifacts the history
 * references (one per path or ref), `records` received about them (`artifact.recorded`, a path
 * recorded again counts again). Files available to view are the observer's catalog, not the scene's.
 */
export function artifactCountsOf(cell: CellState): { readonly distinct: number; readonly records: number } {
  return { distinct: cell.artifacts.length, records: cell.artifactRecords };
}

/** Gaps that lost history (not the ones only not interpreted). */
export function lostGaps(scene: Scene): readonly Scene["completeness"]["gaps"][number][] {
  return scene.completeness.gaps.filter((g) => g.lost);
}

/** Records received and not interpreted, over every source. */
export function notInterpretedCount(scene: Scene): number {
  let n = 0;
  for (const v of Object.values(scene.completeness.notInterpreted)) n += v;
  return n;
}

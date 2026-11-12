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
  SliceState,
  StationVisit,
  ToolCallState,
  WaveState,
} from "./model";
import { isActorRef, ref, refId, refKind } from "./model";
import type { LiveEntityKind, LiveRef } from "./model";

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
import type { CellStage, StationId } from "./vocabulary";

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
  | { kind: "actor"; value: ActorState };

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
    case "gate":
      return scene.gates[id] ? { kind: "gate", value: scene.gates[id] } : null;
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
      const gate = scene.gates[id];
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
const logMomentCache = new WeakMap<SceneLog, { version: number; all: readonly Moment[] }>();

/**
 * Events at or above a significance, with a sentence each, for timeline markers. With t, only the
 * moments that have happened by t (a view showing what is known at t should pass it).
 */
export function moments(history: History, atLeast: Significance = "major", t?: number): readonly Moment[] {
  return momentsOf(history, atLeast, t);
}

function momentsOf(history: History, atLeast: Significance, t?: number): readonly Moment[] {
  if (isSceneLog(history)) {
    // A live log grows: moments are rebuilt when its version changes (they are only what has been received).
    let held = logMomentCache.get(history);
    if (!held || held.version !== history.version()) {
      const all = history.entries().map((entry): Moment => {
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
      });
      held = { version: history.version(), all };
      logMomentCache.set(history, held);
    }
    const floor = RANK[atLeast];
    return held.all.filter((m) => RANK[m.significance] >= floor && (t === undefined || m.t <= t));
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
export function activityOf(scene: Scene, entity: EntityRef, options: ActivityOptions = {}): Activity {
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

function executionActivity(x: ExecutionState): Activity {
  const authority = x.meta.authority;
  if (x.ended === "interrupted" || x.ended === "timed-out") return { state: "interrupted", reason: x.ended === "timed-out" ? "Its process timed out." : "Its process was interrupted.", since: x.processEndedAt, authority };
  if (x.recovery === "outcome-unknown") return { state: "unknown", reason: "The supervisor could not learn how it ended.", since: x.endedAt, authority };
  if (x.state === "failed") return { state: "failed", reason: "The supervisor recorded a failure.", since: x.endedAt, authority };
  if (x.state === "completed") return { state: "completed", reason: "The supervisor recorded its end.", since: x.endedAt, authority };
  if (x.capacityWait) return { state: "waiting-resources", reason: "Held: every execution place is in use (recorded).", since: x.capacityWait.since, authority: "reconstructed" };
  if (x.ended) return { state: "unknown", reason: "Its process ended; the supervisor has not recorded the outcome yet.", since: x.processEndedAt, authority };
  return { state: "executing", reason: x.state === "claimed" ? "Claimed by the supervisor." : "Running.", since: x.startedAt ?? x.claimedAt, authority };
}

function cellActivity(scene: Scene, cell: CellState): Activity {
  const authority = cell.meta.authority;
  if (cell.merged || cell.runRecord?.outcome === "merged") return { state: "completed", reason: "Merged.", since: cell.merged?.at ?? cell.runRecord?.at ?? null, authority };
  if (cell.runRecord?.outcome === "abandoned") return { state: "failed", reason: "Abandoned.", since: cell.runRecord.at, authority };
  if (cell.stage === "awaiting-human" || cell.stage === "spec-open") return { state: "waiting-person", reason: cell.stage === "spec-open" ? "The spec has open questions." : "A person must approve.", since: cell.stageHistory.at(-1)?.at ?? null, authority };
  if (cell.stage === "blocked") return { state: "waiting-person", reason: "Escalated to a person.", since: cell.stageHistory.at(-1)?.at ?? null, authority };
  const waitingGate = Object.values(scene.gates).find((g) => g.ticketId === cell.ticketId && g.gate === "human-approval" && g.state === "waiting");
  if (waitingGate) return { state: "waiting-person", reason: "A person must approve.", since: waitingGate.openedAt, authority: waitingGate.meta.authority };
  const execution = cell.executionId ? scene.executions[cell.executionId] : undefined;
  if (execution) {
    const x = executionActivity(execution);
    if (x.state === "interrupted" || x.state === "failed" || x.state === "waiting-resources") return x;
  }
  if (cell.capacityWait) return { state: "waiting-resources", reason: "Held: every execution place is in use (recorded).", since: cell.capacityWait.since, authority: "reconstructed" };
  if (cell.station) return { state: "executing", reason: `At ${cell.station}.`, since: cell.stationSince, authority };
  if (execution && (execution.state === "running" || execution.state === "claimed")) return { state: "executing", reason: "Its execution is running.", since: execution.startedAt ?? execution.claimedAt, authority: execution.meta.authority };
  const slice = scene.slices[cell.sliceId];
  if (slice?.scheduler === "waiting-on-dependency") return { state: "waiting-dependency", reason: slice.reasons.join(" ") || "Waiting for what it depends on.", since: slice.since, authority: slice.meta.authority };
  return { state: "unknown", reason: "Between stations; nothing recorded says what it waits for.", since: null, authority };
}

// ---------------------------------------------------------------- live-only entities

export type LiveEntityState =
  | { kind: "visit"; value: StationVisit & { readonly ticketId: string } }
  | { kind: "seat"; value: { readonly ticketId: string; readonly round: number; readonly seat: string; readonly model: string; readonly agentId: string | null; readonly vote: "APPROVE" | "REJECT" | null } }
  | { kind: "workflow"; value: ExecutionState };

/**
 * The live-only kinds (`visit:`, `seat:`, `workflow:`), found by identity in the scene: a visit by
 * its recorded visit id, a seat by its round's panel, a workflow by its execution's workflow id. No
 * id is parsed.
 */
export function liveEntityAt(scene: Scene, entity: LiveRef): LiveEntityState | null {
  const id = entity.slice(entity.indexOf(":") + 1);
  switch (entity.slice(0, entity.indexOf(":")) as LiveEntityKind) {
    case "visit":
      for (const cell of Object.values(scene.cells)) {
        const visit = cell.visits.find((v) => v.visitId === id);
        if (visit) return { kind: "visit", value: { ...visit, ticketId: cell.ticketId } };
      }
      return null;
    case "seat":
      for (const cell of Object.values(scene.cells)) {
        for (const round of cell.reviews) {
          for (const seat of round.seats) {
            if (ref.seat(cell.ticketId, round.round, seat.seat) === entity) return { kind: "seat", value: { ticketId: cell.ticketId, round: round.round, seat: seat.seat, model: seat.model, agentId: seat.agentId, vote: seat.vote } };
          }
        }
      }
      return null;
    case "workflow":
      for (const x of Object.values(scene.executions)) if (x.workflowId === id) return { kind: "workflow", value: x };
      return null;
    default:
      return null;
  }
}

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
import { finalScene, indexFixture, lowerBound, upperBound } from "./engine";
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
import type { CellStage, StationId } from "./vocabulary";

// ---------------------------------------------------------------- events in time

/** Events with from < event.t <= to, in order. */
export function eventsBetween(fixture: Fixture, from: number, to: number): readonly AnySimEvent[] {
  const index = indexFixture(fixture);
  return index.events.slice(upperBound(index.times, from), upperBound(index.times, to));
}

/**
 * Events in the last `windowMs` before t (t - windowMs < event.t <= t), optionally filtered by
 * kind. A view draws each one's motion from `t - event.t`.
 */
export function eventsInWindow(fixture: Fixture, t: number, windowMs: number, kinds?: readonly EventKind[]): readonly AnySimEvent[] {
  const found = eventsBetween(fixture, t - windowMs, t);
  return kinds ? found.filter((e) => kinds.includes(e.type)) : found;
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
export function changesBetween(fixture: Fixture, t1: number, t2: number): Changes {
  const index = indexFixture(fixture);
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  const a = upperBound(index.times, lo);
  const b = upperBound(index.times, hi);
  const events = index.events.slice(a, b);
  const refs = new Set<EntityRef>();
  for (let i = a; i < b; i++) for (const r of index.refsByEvent[i] ?? []) refs.add(r);
  return { from: t1, to: t2, direction: a === b ? "none" : t2 > t1 ? "forward" : "backward", events, refs: [...refs] };
}

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
export function eventsFor(fixture: Fixture, entity: AnyRef, t?: number): readonly AnySimEvent[] {
  const index = indexFixture(fixture);
  const positions = index.eventsByRef.get(entity) ?? [];
  const out: AnySimEvent[] = [];
  for (const i of positions) {
    const event = index.events[i] as AnySimEvent;
    if (t !== undefined && event.t > t) break;
    out.push(event);
  }
  return out;
}

/** The latest event behind an entity at time t: what the inspector shows as "why it looks like this". */
export function latestEventFor(fixture: Fixture, entity: AnyRef, t: number): AnySimEvent | null {
  const found = eventsFor(fixture, entity, t);
  return found[found.length - 1] ?? null;
}

/** Time of the next event strictly after t, or null at the end. */
export function nextEventTime(fixture: Fixture, t: number): number | null {
  const index = indexFixture(fixture);
  return index.times[upperBound(index.times, t)] ?? null;
}

/** Time of the latest event strictly before t, or null at the start. */
export function previousEventTime(fixture: Fixture, t: number): number | null {
  const index = indexFixture(fixture);
  const i = lowerBound(index.times, t) - 1;
  return i >= 0 ? (index.times[i] ?? null) : null;
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
  out.sort((a, b) => a.startedSeq - b.startedSeq);
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

export function findAgent(scene: Scene, agentId: string): AgentState | null {
  // Agent IDs carry their ticket number (ag-031-07), but look everywhere in case a fixture differs.
  for (const cell of Object.values(scene.cells)) {
    const agent = cell.agents[agentId];
    if (agent) return agent;
  }
  return null;
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
  if (isActorRef(entity)) {
    const actor = scene.actors[id as ActorId];
    return actor ? { kind: "actor", value: actor } : null;
  }
  switch (refKind(entity)) {
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
 * waits for it (transitively), with the edges and cells; for a dependency, both ends; for a cell,
 * its slice and that slice's set; for an agent, its cell, parent and children.
 */
export function relatedRefs(scene: Scene, entity: EntityRef): readonly EntityRef[] {
  const out = new Set<EntityRef>([entity]);
  const id = refId(entity);
  const addSliceSet = (sliceId: string): void => {
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
    visit(sliceId, "up");
    visit(sliceId, "down");
  };
  switch (refKind(entity)) {
    case "slice":
      addSliceSet(id);
      break;
    case "dependency": {
      const [from, to] = id.split("->") as [string, string];
      out.add(ref.slice(from)).add(ref.slice(to));
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
  readonly tools: readonly ToolSpan[];
}

const timelineCache = new WeakMap<Fixture, readonly CellTimeline[]>();

/** One timeline per cell, in the order the cells were opened. */
export function cellTimelines(fixture: Fixture): readonly CellTimeline[] {
  const cached = timelineCache.get(fixture);
  if (cached) return cached;
  const scene = finalScene(fixture);
  const all = moments(fixture, "minor");
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
  timelineCache.set(fixture, out);
  return out;
}

export function cellTimeline(fixture: Fixture, ticketId: string): CellTimeline | null {
  return cellTimelines(fixture).find((x) => x.ticketId === ticketId) ?? null;
}

export function agentTimeline(fixture: Fixture, agentId: string): AgentTimeline | null {
  for (const cell of cellTimelines(fixture)) {
    const span = cell.agents.find((a) => a.agentId === agentId);
    if (!span) continue;
    const agent = findAgent(finalScene(fixture), agentId) as AgentState;
    return {
      ...span,
      ticketId: cell.ticketId,
      tools: agent.toolCalls.map((c) => ({ callId: c.id, tool: c.tool, target: c.target, status: c.status, start: c.startedAt, end: c.finishedAt })),
    };
  }
  return null;
}

// ---------------------------------------------------------------- moments and chapters

export interface Moment {
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

/** Events at or above a significance, with a sentence each, for timeline markers. */
export function moments(fixture: Fixture, atLeast: Significance = "major"): readonly Moment[] {
  let all = momentCache.get(fixture);
  if (!all) {
    const index = indexFixture(fixture);
    all = index.events.map((event, i) => ({
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
  return all.filter((m) => RANK[m.significance] >= floor);
}

export function chapters(fixture: Fixture): readonly Chapter[] {
  return fixture.chapters;
}

/** The chapter the playhead is in (the last one that has started), or null before the first. */
export function chapterAt(fixture: Fixture, t: number): Chapter | null {
  let found: Chapter | null = null;
  for (const chapter of fixture.chapters) if (chapter.t <= t) found = chapter;
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

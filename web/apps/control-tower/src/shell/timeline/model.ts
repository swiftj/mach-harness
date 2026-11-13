/**
 * The timeline's model: everything the tracks draw.
 *
 * - Simulation: computed once from the fixture with the simulation's own selectors (cellTimelines,
 *   moments, the final scene). Nothing depends on the playhead; what has not happened yet is hidden
 *   by the live edge (`kind: "whole-run"`).
 * - Live and replay: built from what has been received (`kind: "so-far"`), from the newest scene and
 *   the history index, and rebuilt as events arrive (at most a few times a second, see Timeline.tsx).
 *   There is no future: the right end is the live edge. A track is reused for a cell whose scene
 *   object did not change (the log keeps unchanged entities' objects), so a batch costs what it
 *   touched. Workflow agents' tool calls are a count, never ticks (contract 8.1).
 */
import {
  cellTimelines,
  finalScene,
  isKnown,
  moments,
  ref,
  SCENARIO,
  type AgentState,
  type AnyRef,
  type EntityRef,
  type GateState,
  type CellState,
  type Moment,
  type Scene,
  type SceneLog,
  type StationId,
  type StationOutcome,
  type TimeQuality,
  type ToolName,
  executionEndedAt,
} from "../../sim";
import type { HistoryIndex } from "../history";
import { toolFamily } from "../vocab";

export interface StationItem {
  ref: EntityRef;
  station: StationId;
  round: number;
  start: number;
  end: number | null;
  outcome: StationOutcome | null;
  /** How its start and end are known (live): measured, or placed (inferred). Simulation: simulated. */
  startQuality: TimeQuality;
  endQuality: TimeQuality;
}
export interface GateItem {
  ref: EntityRef;
  gate: GateState["gate"];
  t: number;
  state: GateState["state"];
  round: number | null;
}
export interface MarkItem {
  /** Actors (actor:supervisor, actor:scheduler) are named here even before the store can select them. */
  ref: AnyRef | null;
  t: number;
  kind: "fail" | "person" | "attention" | "merge" | "decision" | "integrated" | "wave";
  text: string;
  /** Live and replay: the event behind the mark. */
  eventId?: string | null;
}
export interface WaitItem {
  ref: EntityRef;
  start: number;
  end: number | null;
  /** Waiting on a dependency, or ready but not yet dispatched. */
  kind: "dependency" | "eligible";
}
export interface ToolItem {
  ref: EntityRef;
  tool: ToolName;
  family: ReturnType<typeof toolFamily>;
  target: string;
  start: number;
  end: number | null;
  /** When the call is known to have failed (its end), or null: never draw it as failed before this time. */
  failedAt: number | null;
}
export interface AgentItem {
  ref: EntityRef;
  agent: AgentState;
  row: number;
  start: number;
  end: number | null;
  tools: ToolItem[];
}
export interface ArtifactItem {
  ref: EntityRef;
  t: number;
  label: string;
}

export interface Track {
  id: string;
  /** What selecting the track header selects. */
  ref: EntityRef;
  kind: "factory" | "slice";
  title: string;
  ticketId: string | null;
  sliceId: string | null;
  stations: StationItem[];
  gates: GateItem[];
  marks: MarkItem[];
  waits: WaitItem[];
  agents: AgentItem[];
  artifacts: ArtifactItem[];
  agentRows: number;
  /** Execution spans, for selecting an execution. */
  executions: Array<{ ref: EntityRef; start: number; end: number | null }>;
}

export interface TimelineModel {
  /** `whole-run`: the simulation's recorded run; `so-far`: real history up to the live edge (no future). */
  kind: "whole-run" | "so-far";
  /** Where the history held begins (simulation: 0). */
  start: number;
  /** Simulation: the run's end. So far: the live edge when the model was built (the view uses the store's). */
  end: number;
  /** Kept for the M6.0 readers: the same as `end`. */
  duration: number;
  /** Agent spans (count-only agents included). */
  agentCount: number;
  tracks: Track[];
  /** Every time an outcome becomes known (station visits ending, tool calls failing), ascending: the tracks redraw when the live edge passes one. */
  stationEnds: readonly number[];
  /** Major and chapter moments, for the ruler. */
  moments: readonly Moment[];
  /** Where each entity is drawn: track id, row (-1: the main row) and span. */
  locate(entity: EntityRef): { trackId: string; row: number; start: number; end: number | null } | null;
}

let cached: TimelineModel | null = null;

export function timelineModel(): TimelineModel {
  if (cached) return cached;
  const fixture = SCENARIO;
  const scene = finalScene(fixture);
  // The whole recorded run; the live edge hides what has not happened, and anything coloured by how
  // it ends carries the time that end is known, so the drawing never shows it earlier.
  const cells = cellTimelines(fixture, fixture.duration);
  const tracks: Track[] = [];
  const where = new Map<EntityRef, { trackId: string; row: number; start: number; end: number | null }>();

  // The factory track: people's acts, the scheduler's decisions, integrations.
  const factory: Track = {
    id: "factory",
    ref: ref.wave(Object.keys(scene.waves)[0] ?? "WAVE-007"),
    kind: "factory",
    title: "Factory",
    ticketId: null,
    sliceId: null,
    stations: [],
    gates: [],
    marks: [],
    waits: [],
    agents: [],
    artifacts: [],
    agentRows: 0,
    executions: [],
  };
  for (const e of fixture.events) {
    switch (e.type) {
      case "factory.activated":
        factory.marks.push({ ref: null, t: e.t, kind: "person", text: `${e.data.by} enabled the Factory` });
        break;
      case "wave.discovered":
        factory.marks.push({ ref: ref.wave(e.wave_id ?? ""), t: e.t, kind: "wave", text: `${e.wave_id} arrived, approved by ${e.data.approval.actor}` });
        break;
      case "scheduling.decided":
        factory.marks.push({ ref: ref.actor("supervisor"), t: e.t, kind: "decision", text: `Line supervisor: dispatched ${e.data.dispatched.length}, started ${e.data.started.length}, held ${e.data.held.length}` });
        break;
      case "slice.integrated":
        factory.marks.push({ ref: ref.slice(e.slice_id ?? ""), t: e.t, kind: "integrated", text: `${e.slice_id} integrated` });
        break;
      case "human.required":
        factory.marks.push({ ref: e.ticket_id ? ref.gate(`${e.ticket_id}/human-approval`) : null, t: e.t, kind: "attention", text: `A person is needed for ${e.ticket_id ?? e.slice_id}` });
        break;
      case "human.approval_recorded":
        factory.marks.push({ ref: ref.gate(`${e.ticket_id}/human-approval`), t: e.t, kind: "person", text: `${e.data.by} approved ${e.ticket_id}` });
        break;
      default:
        break;
    }
  }
  factory.marks.sort((a, b) => a.t - b.t);
  where.set(factory.ref, { trackId: "factory", row: -1, start: 0, end: null });
  tracks.push(factory);

  // One track per slice, in slice order; a slice that never gets a cell still has its waits.
  const slices = Object.values(scene.slices).sort((a, b) => a.id.localeCompare(b.id));
  for (const slice of slices) {
    const timeline = cells.find((c) => c.sliceId === slice.id) ?? null;
    const ticketId = slice.ticketId;
    const cell = scene.cells[ticketId] ?? null;
    const trackId = slice.id;
    const track: Track = {
      id: trackId,
      ref: cell ? ref.cell(ticketId) : ref.slice(slice.id),
      kind: "slice",
      title: slice.title,
      ticketId,
      sliceId: slice.id,
      stations: [],
      gates: [],
      marks: [],
      waits: [],
      agents: [],
      artifacts: [],
      agentRows: timeline?.rows ?? 0,
      executions: [],
    };
    const put = (r: EntityRef, row: number, start: number, end: number | null) => {
      const prior = where.get(r);
      if (!prior) where.set(r, { trackId, row, start, end });
      else where.set(r, { trackId, row, start: Math.min(prior.start, start), end: prior.end === null || end === null ? null : Math.max(prior.end, end) });
    };

    // Scheduler waits, from the slice's own history.
    const history = slice.history;
    history.forEach((h, i) => {
      const next = history[i + 1];
      if (h.state === "waiting-on-dependency" || h.state === "eligible") {
        track.waits.push({ ref: ref.slice(slice.id), start: h.at, end: next ? next.at : null, kind: h.state === "eligible" ? "eligible" : "dependency" });
      }
    });
    for (const dep of Object.values(scene.dependencies)) {
      if (dep.from !== slice.id) continue;
      const first = history[0]?.at ?? 0;
      put(ref.dependency(dep.from, dep.to), -1, first, dep.satisfiedAt);
    }
    put(ref.slice(slice.id), -1, history[0]?.at ?? 0, slice.integratedCommit ? (history[history.length - 1]?.at ?? null) : null);

    if (timeline && cell) {
      for (const s of timeline.stations) {
        const r = ref.station(s.station, ticketId);
        track.stations.push({ ref: r, station: s.station, round: s.round, start: s.start, end: s.end, outcome: s.outcome, startQuality: "simulated", endQuality: "simulated" });
        put(r, -1, s.start, s.end);
        if (s.outcome === "failed" || s.outcome === "rejected") {
          const gate = s.station === "verify" ? ref.gate(`${ticketId}/verification#${s.round}`) : ref.gate(`${ticketId}/review#${s.round}`);
          track.marks.push({ ref: gate, t: s.end ?? s.start, kind: "fail", text: s.station === "verify" ? `Verification failed, round ${s.round}` : `Review rejected, round ${s.round}` });
        }
      }
      for (const gate of Object.values(scene.gates)) {
        if (gate.ticketId !== ticketId) continue;
        const t = gate.decidedAt ?? gate.openedAt;
        track.gates.push({ ref: ref.gate(gate.id), gate: gate.gate, t, state: gate.state, round: gate.round });
        put(ref.gate(gate.id), -1, gate.openedAt, gate.decidedAt);
      }
      for (const round of cell.reviews) {
        if (round.humanApproval) track.marks.push({ ref: ref.gate(`${ticketId}/human-approval`), t: round.humanApproval.at, kind: "person", text: `${round.humanApproval.by} approved` });
        for (const f of round.findings) put(ref.finding(f.id), -1, f.at, f.at);
      }
      if (cell.merged) track.marks.push({ ref: ref.station("merge", ticketId), t: cell.merged.at, kind: "merge", text: `Merged ${cell.merged.commit.slice(0, 7)}${cell.merged.revalidated ? " after revalidation" : ""}` });
      for (const a of cell.artifacts) {
        track.artifacts.push({ ref: ref.artifact(a.id), t: a.writtenAt, label: a.label });
        put(ref.artifact(a.id), -1, a.writtenAt, a.writtenAt);
      }
      for (const ex of Object.values(scene.executions)) {
        if (ex.ticketId !== ticketId) continue;
        track.executions.push({ ref: ref.execution(ex.id), start: ex.claimedAt, end: executionEndedAt(ex) });
        put(ref.execution(ex.id), -1, ex.claimedAt, executionEndedAt(ex));
      }
      for (const span of timeline.agents) {
        const agent = cell.agents[span.agentId] as AgentState;
        const tools = agent.toolCalls.map((c) => ({
          ref: ref.tool(c.id),
          tool: c.tool,
          family: toolFamily(c.tool, c.target),
          target: c.target,
          start: c.startedAt,
          end: c.finishedAt,
          failedAt: c.status === "error" ? c.finishedAt : null,
        }));
        track.agents.push({ ref: ref.agent(agent.id), agent, row: span.row, start: span.start, end: span.end, tools });
        put(ref.agent(agent.id), span.row, span.start, span.end);
        for (const tool of tools) put(tool.ref, span.row, tool.start, tool.end);
      }
      put(ref.cell(ticketId), -1, cell.openedAt, cell.archived?.at ?? null);
    }
    track.marks.sort((a, b) => a.t - b.t);
    tracks.push(track);
  }

  cached = {
    kind: "whole-run",
    start: 0,
    end: fixture.duration,
    duration: fixture.duration,
    agentCount: tracks.reduce((n, tr) => n + tr.agents.length, 0),
    tracks,
    stationEnds: tracks
      .flatMap((tr) => [...tr.stations.map((x) => x.end), ...tr.agents.flatMap((a) => a.tools.map((c) => c.failedAt))])
      .filter((e): e is number => e !== null)
      .sort((a, b) => a - b),
    moments: moments(fixture, "major"),
    locate: (entity) => {
      const found = where.get(entity);
      if (found) return found;
      // A station without a cell ("station:build") is every cell's visits: no single span.
      return null;
    },
  };
  return cached;
}

// ---------------------------------------------------------------- live and replay

const EMPTY_TRACK = { stations: [], gates: [], marks: [], waits: [], agents: [], artifacts: [], agentRows: 0, executions: [] };

interface CellPart {
  agents: AgentItem[];
  rows: number;
}
/** Agents and their per-call tools for one cell object: reused while the cell is the same object. */
const cellParts = new WeakMap<CellState, CellPart>();

function cellPart(cell: CellState): CellPart {
  const held = cellParts.get(cell);
  if (held) return held;
  const rowsEnd: number[] = [];
  const agents: AgentItem[] = [];
  for (const id of cell.agentOrder) {
    const agent = cell.agents[id];
    if (!agent || agent.lifecycle === "queued") continue;
    let row = rowsEnd.findIndex((end) => end <= agent.startedAt);
    if (row < 0) row = rowsEnd.length;
    rowsEnd[row] = agent.finishedAt ?? Infinity;
    // Count-only agents (Dynamic Workflow agents) have no observable calls: no ticks, ever.
    const tools =
      agent.observation === "per-call"
        ? agent.toolCalls.map((c) => ({ ref: ref.tool(c.id), tool: c.tool, family: toolFamily(c.tool, c.target), target: c.target, start: c.startedAt, end: c.finishedAt, failedAt: c.status === "error" ? c.finishedAt : null }))
        : [];
    agents.push({ ref: ref.agent(agent.id), agent, row, start: agent.startedAt, end: agent.finishedAt, tools });
  }
  const part = { agents, rows: rowsEnd.length };
  cellParts.set(cell, part);
  return part;
}

/**
 * The timeline as received so far: one track per cell (in the order the cells were opened), one per
 * slice that has no cell yet but has a recorded wait, and the Factory track from the history index.
 */
export function liveTimelineModel(log: SceneLog, liveAt: number, index: HistoryIndex): TimelineModel {
  const scene: Scene = log.head();
  const start = log.floorTime() ?? liveAt;
  const tracks: Track[] = [];
  const where = new Map<string, { trackId: string; row: number; start: number; end: number | null }>();
  const put = (r: string, trackId: string, row: number, s0: number, e: number | null) => {
    const prior = where.get(r);
    if (!prior) where.set(r, { trackId, row, start: s0, end: e });
    else where.set(r, { trackId, row, start: Math.min(prior.start, s0), end: prior.end === null || e === null ? null : Math.max(prior.end, e) });
  };

  const firstWave = Object.values(scene.waves).sort((a, b) => a.discoveredAt - b.discoveredAt)[0];
  const factory: Track = { id: "factory", ref: firstWave ? ref.wave(firstWave.id) : ref.actor("supervisor"), kind: "factory", title: "Factory", ticketId: null, sliceId: null, ...EMPTY_TRACK, marks: index.factoryMarks.map((m) => ({ ref: m.ref, t: m.t, kind: m.kind, text: m.text, eventId: m.eventId })) };
  tracks.push(factory);

  // Gates and executions by ticket, once per build.
  const gatesBy = new Map<string, GateState[]>();
  for (const g of Object.values(scene.gates)) (gatesBy.get(g.ticketId) ?? gatesBy.set(g.ticketId, []).get(g.ticketId))?.push(g);
  const execBy = new Map<string, Track["executions"]>();
  for (const x of Object.values(scene.executions)) (execBy.get(x.ticketId) ?? execBy.set(x.ticketId, []).get(x.ticketId))?.push({ ref: ref.execution(x.id), start: x.claimedAt, end: executionEndedAt(x) });

  const cells = Object.values(scene.cells).sort((a, b) => a.openedAt - b.openedAt || a.ticketId.localeCompare(b.ticketId));
  const withCell = new Set<string>();
  for (const cell of cells) {
    const ticketId = cell.ticketId;
    withCell.add(cell.sliceId);
    const trackId = `cell:${ticketId}`;
    const part = cellPart(cell);
    const track: Track = {
      id: trackId,
      ref: ref.cell(ticketId),
      kind: "slice",
      title: isKnown(cell.meta, "title") ? cell.title : ticketId,
      ticketId,
      sliceId: cell.sliceId || null,
      stations: [],
      gates: [],
      marks: [],
      waits: [],
      agents: part.agents,
      artifacts: [],
      agentRows: part.rows,
      executions: execBy.get(ticketId) ?? [],
    };
    for (const v of cell.visits) {
      const r = ref.station(v.station, ticketId);
      track.stations.push({ ref: r, station: v.station, round: v.round, start: v.enteredAt, end: v.leftAt, outcome: v.outcome, startQuality: v.meta.start, endQuality: v.leftAt === null ? "unknown" : v.meta.end });
      put(r, trackId, -1, v.enteredAt, v.leftAt);
      if (v.outcome === "failed" || v.outcome === "rejected") {
        const gate = v.station === "verify" ? ref.gate(`${ticketId}/verification#${v.round}`) : ref.gate(`${ticketId}/review#${v.round}`);
        track.marks.push({ ref: gate, t: v.leftAt ?? v.enteredAt, kind: "fail", text: v.station === "verify" ? `Verification failed, round ${v.round}` : `Review rejected, round ${v.round}` });
      }
    }
    for (const g of gatesBy.get(ticketId) ?? []) {
      track.gates.push({ ref: ref.gate(g.id), gate: g.gate, t: g.decidedAt ?? g.openedAt, state: g.state, round: g.round });
      put(ref.gate(g.id), trackId, -1, g.openedAt, g.decidedAt);
    }
    for (const round of cell.reviews) {
      // People by role only (contract D15).
      if (round.humanApproval) track.marks.push({ ref: ref.gate(`${ticketId}/human-approval`), t: round.humanApproval.at, kind: "person", text: "A person approved" });
      for (const f of round.findings) put(ref.finding(f.id), trackId, -1, f.at, f.at);
    }
    if (cell.merged) track.marks.push({ ref: ref.station("merge", ticketId), t: cell.merged.at, kind: "merge", text: `Merged ${cell.merged.commit.slice(0, 7)}${cell.merged.revalidated ? " after revalidation" : ""}` });
    for (const a of cell.artifacts) {
      track.artifacts.push({ ref: ref.artifact(a.id), t: a.writtenAt, label: a.label });
      put(ref.artifact(a.id), trackId, -1, a.writtenAt, a.writtenAt);
    }
    for (const x of track.executions) put(x.ref, trackId, -1, x.start, x.end);
    for (const a of part.agents) {
      put(a.ref, trackId, a.row, a.start, a.end);
      for (const tool of a.tools) put(tool.ref, trackId, a.row, tool.start, tool.end);
    }
    const slice = scene.slices[cell.sliceId];
    if (slice) put(ref.slice(slice.id), trackId, -1, slice.history[0]?.at ?? cell.openedAt, null);
    put(ref.cell(ticketId), trackId, -1, cell.openedAt, cell.archived?.at ?? null);
    track.marks.sort((a, b) => a.t - b.t);
    tracks.push(track);
  }

  // Slices still waiting for a cell: their recorded waits only.
  for (const slice of Object.values(scene.slices).sort((a, b) => a.id.localeCompare(b.id))) {
    if (withCell.has(slice.id)) continue;
    const trackId = `slice:${slice.id}`;
    const track: Track = { id: trackId, ref: ref.slice(slice.id), kind: "slice", title: slice.title || slice.id, ticketId: null, sliceId: slice.id, ...EMPTY_TRACK, waits: [], marks: [] };
    slice.history.forEach((h, i) => {
      const next = slice.history[i + 1];
      if (h.state === "waiting-on-dependency" || h.state === "eligible") track.waits.push({ ref: ref.slice(slice.id), start: h.at, end: next ? next.at : null, kind: h.state === "eligible" ? "eligible" : "dependency" });
    });
    put(ref.slice(slice.id), trackId, -1, slice.history[0]?.at ?? start, null);
    tracks.push(track);
  }

  return {
    kind: "so-far",
    start,
    end: liveAt,
    duration: liveAt,
    agentCount: tracks.reduce((n, tr) => n + tr.agents.length, 0),
    tracks,
    stationEnds: [],
    moments: index.moments,
    locate: (entity) => where.get(entity) ?? null,
  };
}

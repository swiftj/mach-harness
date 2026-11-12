/**
 * The timeline's static model: everything the tracks draw, computed once from the fixture with the
 * simulation's own selectors (cellTimelines, moments, the final scene). Nothing here depends on the
 * playhead; what has not happened yet is hidden by the live edge, never recomputed.
 */
import {
  cellTimelines,
  finalScene,
  moments,
  ref,
  SCENARIO,
  type AgentState,
  type AnyRef,
  type EntityRef,
  type GateKind,
  type GateState,
  type Moment,
  type StationId,
  type StationOutcome,
  type ToolName,
} from "../../sim";
import { toolFamily } from "../vocab";

export interface StationItem {
  ref: EntityRef;
  station: StationId;
  round: number;
  start: number;
  end: number | null;
  outcome: StationOutcome | null;
}
export interface GateItem {
  ref: EntityRef;
  gate: GateKind;
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
  duration: number;
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
        track.stations.push({ ref: r, station: s.station, round: s.round, start: s.start, end: s.end, outcome: s.outcome });
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
        track.executions.push({ ref: ref.execution(ex.id), start: ex.claimedAt, end: ex.endedAt });
        put(ref.execution(ex.id), -1, ex.claimedAt, ex.endedAt);
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
    duration: fixture.duration,
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

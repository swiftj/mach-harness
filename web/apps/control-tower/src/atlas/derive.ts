/**
 * Everything the Atlas draws, derived from the scene and the playhead. Pure functions: the same
 * (fixture, t) always gives the same picture, forwards or backwards. The only time source is the
 * playhead; every motion is `animationProgress(name, (t - event.t) / PLAYBACK_BASE_RATE)`, i.e. the
 * spec's durations (wall ms at 1x) converted to factory ms.
 */
import { animationProgress, liftedArc, type ArtifactKind as UiArtifactKind, type FactoryAnimationName, type FactoryState, type GatePosition, type ModelTier as UiTier, type AgentRole as UiRole, type ToolFamily, type Vec3 } from "@mach/ui";
import { agentTimingAt, eventsInWindow, finalScene, type AnySimEvent, type EventKind, type AgentState, type ArtifactState, type CellState, type Fixture, type GateState, type Scene, type StationId, type ToolCallState } from "../sim";
import { PLAYBACK_BASE_RATE } from "../scene";
import { FLOOR_Z, PLATE_Z, plantLayout, type BaySlot, type PlantLayout } from "./layout";

export const RATE = PLAYBACK_BASE_RATE;
/** A recent event keeps its afterglow (callouts, the chamber's last decision) this long, factory ms. */
export const AFTERGLOW = 30_000;

/** Progress of a named factory animation `elapsed` factory ms after its event. */
export function anim(name: FactoryAnimationName, elapsed: number, reduced: boolean, durationMs?: number): number {
  return animationProgress(name, elapsed / RATE, { reduced, duration: durationMs });
}

/** Quantise a progress so unchanged things keep identical props (spec g: 1/240). */
export function q(p: number): number {
  return Math.round(p * 240) / 240;
}

// ---------------------------------------------------------------- render clocks

/**
 * Animation windows by event kind (factory ms): how long after an event its motion is still
 * changing on screen. A part re-renders with the playhead only while one of its events is inside
 * its window; otherwise its picture is settled and it does not re-render (spec g: React commits).
 */
export const WINDOWS: Partial<Record<EventKind, number>> = {
  "agent.started": 480 * RATE,
  "agent.finished": 360 * RATE,
  "tool.started": 240 * RATE,
  "artifact.written": 520 * RATE,
  "evidence.captured": 300 * RATE,
  "verification.started": 420 * RATE,
  "verification.verdict": 1600 * RATE,
  "execution.started": 600 * RATE,
  "merge.completed": 1100 * RATE + 520 * RATE,
  "merge.revalidated": 520 * RATE,
  "review.started": 700 * RATE + 3 * 90 * RATE,
  "review.vote": 600 * RATE,
  "review.finding": 520 * RATE,
  "review.decided": 1600 * RATE,
  "human.approval_recorded": 700 * RATE,
  "station.entered": 1400 * RATE,
  "station.left": 1400 * RATE,
  "work.scheduled": 1400 * RATE,
  "wave.discovered": 1400 * RATE,
  "slice.materialized": 1900 * RATE,
  "dependency.resolved": 800 * RATE,
  "slice.integrated": 800 * RATE,
  "cleanup.completed": 520 * RATE,
  "gate.checked": 520 * RATE,
  "test.result": 160 * RATE,
};
const MAX_WINDOW = Math.max(...Object.values(WINDOWS).map((w) => w ?? 0));

/** Whether any event (optionally filtered) is still inside its animation window at t. */
export function animating(fixture: Fixture, t: number, filter?: (e: AnySimEvent) => boolean, windows: Partial<Record<EventKind, number>> = WINDOWS): boolean {
  for (const e of eventsInWindow(fixture, t, MAX_WINDOW)) {
    const w = windows[e.type];
    if (w !== undefined && t - e.t < w && (!filter || filter(e))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- vocabulary mapping (sim -> grammar)

export function uiArtifact(kind: ArtifactState["kind"]): UiArtifactKind {
  switch (kind) {
    case "intent":
    case "spec":
    case "contract":
    case "plan":
    case "commit":
    case "evidence":
    case "vote":
    case "decision":
    case "merge-commit":
    case "build-report":
      return kind;
    case "build-state":
    case "review-packet":
    case "run-record":
    case "archive":
      return kind;
    case "verification-results":
    case "verification-summary":
      return "results";
    case "verification-findings":
    case "findings-copy":
    case "review-findings":
      return "findings";
    case "review-diff":
      return "diff";
  }
}

export function toolFamily(call: ToolCallState): ToolFamily {
  const target = call.target.toLowerCase();
  switch (call.tool) {
    case "Read":
    case "Glob":
      return "read";
    case "Write":
    case "Edit":
      return "write";
    case "Grep":
    case "Agent":
      return "search";
    case "Bash":
      if (/^git\b|\bgit (commit|merge|worktree|push|rebase)/.test(target)) return "git";
      if (/test|vitest|playwright|pytest|jest|verify\.py|build\.py (red|green)/.test(target)) return "test";
      return "run";
    default:
      return "run";
  }
}

export function uiTier(model: AgentState["model"]): UiTier {
  return model;
}

export function uiRole(agent: AgentState): UiRole {
  switch (agent.role) {
    case "contract-engineer":
    case "builder":
    case "verifier":
    case "reviewer":
      return agent.role;
    case "intent":
      return "contract-engineer";
    case "clerk":
    case "merge":
    case "cleanup":
    case "audit":
    case "observe":
      return "supervisor";
  }
}

export function agentState(agent: AgentState): FactoryState {
  return agent.status === "running" ? "active" : agent.status === "error" ? "failed" : "succeeded";
}

/** Elapsed time, as lettered beside work in flight: "40 s", "6 min", "1 h 12". */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- gates

export interface GateView {
  id: string | null;
  position: GatePosition;
  from: GatePosition;
  progress: number;
  gate: GateState | null;
}

const OPEN: GateView = { id: null, position: "open", from: "open", progress: 1, gate: null };

/** A gate's arm from its state: closes when work arrives, opens on a pass, refuses on a failure. */
export function gateView(gate: GateState | undefined | null, t: number, reduced: boolean): GateView {
  if (!gate) return OPEN;
  switch (gate.state) {
    case "open":
      return { id: gate.id, position: "closed", from: "open", progress: q(anim("gateClose", t - gate.openedAt, reduced)), gate };
    case "waiting":
      return { id: gate.id, position: "waiting", from: "open", progress: q(anim("gateClose", t - gate.openedAt, reduced)), gate };
    case "passed":
    case "skipped": {
      const at = gate.decidedAt ?? gate.openedAt;
      return { id: gate.id, position: "open", from: "closed", progress: q(anim(gate.gate === "human-approval" ? "humanRelease" : "gateOpen", t - at, reduced)), gate };
    }
    case "failed":
      return { id: gate.id, position: "refusing", from: "closed", progress: q(anim("gateRefuse", t - (gate.decidedAt ?? gate.openedAt), reduced)), gate };
  }
}

/** The most recent gate of a kind (optionally for one ticket) that has opened by now. */
export function latestGate(scene: Scene, kind: GateState["gate"], ticketId?: string): GateState | null {
  let found: GateState | null = null;
  for (const g of Object.values(scene.gates)) {
    if (g.gate !== kind || (ticketId && g.ticketId !== ticketId)) continue;
    if (!found || g.openedAt > found.openedAt || (g.openedAt === found.openedAt && g.seq > found.seq)) found = g;
  }
  return found;
}

// ---------------------------------------------------------------- where a cell's work is

const FLOOR_STATIONS: readonly StationId[] = ["groom", "plan", "audit", "build", "verify"];

/** The station holding the cell's work: the current one, or the last one visited. */
export function workStation(cell: CellState): StationId | null {
  return cell.station ?? cell.visits[cell.visits.length - 1]?.station ?? null;
}

export function onFloor(station: StationId | null): boolean {
  return station === null || FLOOR_STATIONS.includes(station);
}

export type PadName = "intent" | "build" | "verify";
export function padOf(station: StationId | null): PadName | null {
  if (station === "groom" || station === "plan") return "intent";
  if (station === "build" || station === "audit") return "build";
  if (station === "verify") return "verify";
  return null;
}

// ---------------------------------------------------------------- legs: work travelling between places

export type LegKind = "wave" | "cut" | "dispatch" | "handoff" | "travel" | "return" | "integrate";

export interface Leg {
  id: string;
  ticketId: string;
  kind: LegKind;
  /** factory ms */
  start: number;
  dur: number;
  route: Vec3[];
  state: FactoryState;
  /** For cards: what rides. */
  card?: UiArtifactKind;
  label: string;
  /** Priority for the motion budget (higher first). */
  priority: number;
  /** The spec animation whose curve and reduced treatment apply. */
  motion: FactoryAnimationName;
}

const legCache = new WeakMap<Fixture, readonly Leg[]>();

const TRAVEL_MS = 1400 * RATE;

function stationPoint(L: PlantLayout, bay: BaySlot, station: StationId | null, side: "in" | "out"): Vec3 {
  switch (station) {
    case "review":
      return side === "in" ? L.review.entry : L.review.gate;
    case "human-approval":
      return side === "in" ? L.human.parked : L.human.gate;
    case "merge":
      return side === "in" ? { ...L.integration.merge, y: L.integration.merge.y - 22 } : L.integration.merge;
    case "cleanup":
      return { ...L.archive.cleanup, y: L.archive.cleanup.y + 22 };
    default: {
      const pad = padOf(station);
      return pad ? bay.pads[pad] : bay.entrance;
    }
  }
}

/** The route from one station to the next, along the drawn tracks. */
export function routeBetween(L: PlantLayout, bay: BaySlot, from: StationId | null, to: StationId | null): Vec3[] {
  const z = PLATE_Z;
  if (onFloor(from) && onFloor(to)) {
    const a = stationPoint(L, bay, from, "out");
    const b = stationPoint(L, bay, to, "in");
    return [{ ...a, y: bay.railY }, { ...b, y: bay.railY }];
  }
  const doorOut: Vec3[] = [
    { ...bay.pads.verify, y: bay.railY },
    { x: bay.door.x, y: bay.railY, z },
    { x: bay.aisleX, y: bay.railY, z },
    { x: bay.aisleX, y: L.floor.transferY, z },
    { x: L.floor.riserX, y: L.floor.transferY, z },
    { x: L.floor.riserX, y: L.ry, z },
    L.review.entry,
  ];
  const down = (toY: number, fromGate: boolean): Vec3[] => [
    ...(fromGate ? [L.review.gate, { x: L.cx, y: L.ry, z }] : [L.human.gate]),
    { x: L.cx, y: toY, z },
  ];
  const mergeIn = L.integration.merge.y - 22;
  if (onFloor(from) && to === "review") return doorOut;
  if (from === "review" && to === "human-approval") return down(L.human.parked.y, true);
  if (from === "review" && to === "merge") return down(mergeIn, true);
  if (from === "human-approval" && to === "merge") return down(mergeIn, false);
  if (from === "merge" && to === "cleanup") return [...(L.tracks.trunk ?? []), ...(L.tracks.toArchive ?? []).slice(1)];
  if (from === "review" && onFloor(to)) return liftedArc(L.review.entry, { ...bay.pads.build, z: FLOOR_Z }, 92, 40);
  return [stationPoint(L, bay, from, "out"), stationPoint(L, bay, to, "in")];
}

/** Every journey in the run, computed once per fixture from its events and the cells' visits. */
export function legsOf(fixture: Fixture): readonly Leg[] {
  const hit = legCache.get(fixture);
  if (hit) return hit;
  const L = plantLayout(fixture);
  const out: Leg[] = [];
  const fin = finalScene(fixture);
  for (const e of fixture.events) {
    if (e.type === "wave.discovered") {
      out.push({ id: `wave:${e.seq}`, ticketId: e.wave_id ?? "", kind: "wave", start: e.t, dur: TRAVEL_MS, route: [L.intake.dockEdge, { ...L.intake.hopper, x: L.intake.hopper.x - 22 }], state: "active", card: "spec", label: `${e.wave_id} arrives`, priority: 3, motion: "packetTravel" });
    } else if (e.type === "slice.materialized" && e.slice_id) {
      const bay = L.bayBySlice.get(e.slice_id);
      if (!bay) continue;
      const h = L.intake.hopper;
      out.push({ id: `cut:${e.seq}`, ticketId: e.ticket_id ?? "", kind: "cut", start: e.t, dur: 900 * RATE, route: [{ ...h, x: h.x + 22 }, { x: 112, y: h.y, z: PLATE_Z }, { x: 112, y: bay.pad.y, z: PLATE_Z }, bay.pad], state: "active", card: "spec", label: `${e.ticket_id} cut from ${e.slice_id}`, priority: 2, motion: "artifactHandoff" });
    } else if (e.type === "work.scheduled" && e.ticket_id) {
      const bay = L.bayByTicket.get(e.ticket_id);
      if (!bay) continue;
      const route: Vec3[] = [
        bay.pad,
        { x: 186, y: bay.pad.y, z: PLATE_Z },
        { x: 186, y: L.mid, z: PLATE_Z },
        { x: L.floor.spineX, y: L.mid, z: PLATE_Z },
        ...(L.tracks[`spur:${bay.ticketId}`] ?? []),
        { ...bay.entrance, z: PLATE_Z },
      ].filter((p, i, a) => i === 0 || Math.hypot(a[i - 1]!.x - p.x, a[i - 1]!.y - p.y) > 0.5);
      out.push({ id: `dispatch:${e.seq}`, ticketId: e.ticket_id, kind: "dispatch", start: e.t, dur: TRAVEL_MS, route, state: "active", label: `${e.ticket_id} dispatched`, priority: 4, motion: "packetTravel" });
    } else if (e.type === "merge.completed" && e.ticket_id) {
      const m = L.integration.merge;
      out.push({ id: `integrate:${e.seq}`, ticketId: e.ticket_id, kind: "integrate", start: e.t, dur: 1100 * RATE, route: [{ ...m, x: m.x - 22 }, { x: m.x - 22 - 96, y: m.y, z: PLATE_Z }], state: "succeeded", label: `${e.ticket_id} merged into main`, priority: 5, motion: "mergeIntegrate" });
    }
  }
  for (const cell of Object.values(fin.cells)) {
    const bay = L.bayByTicket.get(cell.ticketId);
    if (!bay) continue;
    for (let k = 1; k < cell.visits.length; k++) {
      const prev = cell.visits[k - 1]!;
      const next = cell.visits[k]!;
      const start = prev.leftAt ?? next.enteredAt;
      const gap = next.enteredAt - start;
      const dur = gap >= 1500 ? Math.min(TRAVEL_MS, gap) : TRAVEL_MS;
      const both = onFloor(prev.station) && onFloor(next.station);
      if (both && prev.station === "verify" && next.station === "build") continue; // drawn by the retry loop
      const route = routeBetween(L, bay, prev.station, next.station);
      if (both) {
        const written = cell.artifacts.filter((a) => a.station === prev.station && a.writtenAt <= start);
        const last = written[written.length - 1];
        out.push({ id: `handoff:${cell.ticketId}:${k}`, ticketId: cell.ticketId, kind: "handoff", start, dur: Math.max(dur, 900 * RATE), route, state: "active", card: last ? uiArtifact(last.kind) : "plan", label: `${last?.label ?? "work"} handed to ${next.station}`, priority: 2, motion: "artifactHandoff" });
      } else {
        const isReturn = prev.station === "review" && onFloor(next.station);
        out.push({
          id: `travel:${cell.ticketId}:${k}`,
          ticketId: cell.ticketId,
          kind: isReturn ? "return" : "travel",
          start,
          dur: isReturn ? 1600 * RATE : dur,
          route,
          state: isReturn ? "failed" : next.station === "human-approval" ? "human" : "active",
          label: isReturn ? `${cell.ticketId} returned to build` : `${cell.ticketId} to ${next.station}`,
          priority: isReturn ? 9 : 4,
          motion: isReturn ? "verifyReturn" : "packetTravel",
        });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  legCache.set(fixture, out);
  return out;
}

/** Legs in flight at t, within the motion budget (spec e.1: 12 packets; over it, the lowest priority snap). */
export function legsInFlight(fixture: Fixture, t: number, reduced: boolean): { leg: Leg; p: number }[] {
  const all = legsOf(fixture);
  const live: { leg: Leg; p: number }[] = [];
  for (const leg of all) {
    if (leg.start > t) break;
    const elapsed = t - leg.start;
    if (elapsed >= leg.dur) continue;
    const p = reduced ? 1 : animationProgress(leg.motion, elapsed, { duration: leg.dur });
    if (reduced && elapsed > 160 * RATE) continue;
    live.push({ leg, p: q(p) });
  }
  live.sort((a, b) => b.leg.priority - a.leg.priority);
  return live.slice(0, 12);
}

// ---------------------------------------------------------------- the review chamber

/** The cell whose panel sits in the chamber now (or just decided), if any. */
export function chamberOccupant(scene: Scene, t: number): { cell: CellState; roundIndex: number } | null {
  let best: { cell: CellState; roundIndex: number } | null = null;
  for (const cell of Object.values(scene.cells)) {
    const i = cell.reviews.length - 1;
    const r = cell.reviews[i];
    if (!r) continue;
    const live = cell.station === "review" || (r.decidedAt !== null && t - r.decidedAt < AFTERGLOW * 2);
    if (!live) continue;
    if (!best || r.startedAt > (best.cell.reviews[best.roundIndex]?.startedAt ?? 0)) best = { cell, roundIndex: i };
  }
  return best;
}

// ---------------------------------------------------------------- agents in place

export interface PlacedAgent {
  agent: AgentState;
  at: Vec3;
  arrive: number;
  leave: number;
  state: FactoryState;
  /** How long the agent has worked by t (factory ms): known, never a fraction. */
  elapsed: number;
  /** Order among agents sharing one spot (label stacking). */
  stack: number;
  /** Reduced motion: arrival and departure are opacity only, never a growing or sinking post. */
  reduced: boolean;
}

/** Agents present at t (running, or leaving): where they stand and how far they have arrived. */
export function placeAgents(_scene: Scene | null, L: PlantLayout, cell: CellState, t: number, reduced: boolean): PlacedAgent[] {
  const bay = L.bayByTicket.get(cell.ticketId);
  if (!bay) return [];
  const leaveMs = 360 * RATE;
  const seatCount = new Map<string, number>();
  const out: PlacedAgent[] = [];
  for (const id of cell.agentOrder) {
    const a = cell.agents[id] as AgentState;
    if (a.finishedAt !== null && t - a.finishedAt > leaveMs) continue;
    let at: Vec3;
    let key: string;
    const pad = padOf(a.station);
    if (a.role === "reviewer" && a.seat && a.seat !== "general") {
      at = { ...L.review.seats[a.seat], z: PLATE_Z };
      key = `seat:${a.seat}`;
    } else if (a.station === "merge") {
      at = L.integration.mergeSpot;
      key = "merge";
    } else if (a.station === "cleanup") {
      at = L.archive.cleanupSpot;
      key = "cleanup";
    } else if (pad) {
      key = `${cell.ticketId}:${pad}`;
      const seat = seatCount.get(key) ?? 0;
      const base = { x: bay.pads[pad].x - 10 + seat * 18, y: bay.railY + 32, z: FLOOR_Z };
      at = base;
    } else {
      key = `${cell.ticketId}:console`;
      const seat = seatCount.get(key) ?? 0;
      at = { ...bay.clerkSpot, x: bay.clerkSpot.x + seat * 12 };
    }
    const stack = seatCount.get(key) ?? 0;
    seatCount.set(key, stack + 1);
    out.push({
      agent: a,
      at,
      arrive: q(anim("agentArrive", t - a.startedAt, reduced)),
      leave: a.finishedAt !== null ? q(anim("agentLeave", t - a.finishedAt, reduced)) : 0,
      state: agentState(a),
      elapsed: agentTimingAt(a, t).elapsed,
      stack,
      reduced,
    });
  }
  return out;
}

/** All tool calls of a cell that have started, in start order (cached per cell object). */
const callsCache = new WeakMap<CellState, ToolCallState[]>();
export function callsOf(cell: CellState): ToolCallState[] {
  const hit = callsCache.get(cell);
  if (hit) return hit;
  const out: ToolCallState[] = [];
  for (const id of cell.agentOrder) out.push(...(cell.agents[id] as AgentState).toolCalls);
  out.sort((a, b) => a.startedAt - b.startedAt || a.startedSeq - b.startedSeq);
  callsCache.set(cell, out);
  return out;
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The work lamp's intensity, 0..1 (spec b.3): rising over `stateChange` when a floor station starts,
 * falling over `stateChange` after the last one ends. Shared by the SVG pool and the WebGL light.
 */
export function lampLevel(cell: CellState, t: number, reduced = false): number {
  const floor = (st: string | null) => st === "plan" || st === "groom" || st === "build" || st === "verify" || st === "audit";
  if (floor(cell.station) && cell.stationSince !== null) return anim("stateChange", t - cell.stationSince, reduced);
  const last = cell.visits[cell.visits.length - 1];
  if (last && floor(last.station) && last.leftAt !== null && t - last.leftAt < 260 * RATE) return 1 - anim("stateChange", t - last.leftAt, reduced);
  return 0;
}

/** Minutes of elapsed work: the grammar draws one tick per minute, so pictures change only at these steps. */
export function minuteOf(ms: number): number {
  return Math.min(12, Math.floor(ms / 60_000));
}

/** Whole seconds of elapsed work: the step at which a lettered or named elapsed time changes. */
export function secondOf(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * A render key that changes exactly when any shown elapsed time changes: the whole seconds of every
 * working agent (optionally only those `which` accepts). Parts that letter or name an elapsed time
 * re-render on it, so the same playhead gives the same text however it was reached.
 */
export function agentsElapsedKey(scene: Scene, t: number, which?: (a: AgentState) => boolean): string {
  let k = "";
  for (const c of Object.values(scene.cells)) {
    for (const id of c.activeAgentIds) {
      const a = c.agents[id];
      if (!a || (which && !which(a))) continue;
      k += `${secondOf(agentTimingAt(a, t).elapsed)},`;
    }
  }
  return k;
}

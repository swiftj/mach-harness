/**
 * Everything the Atlas draws, derived from the scene and the playhead. Pure functions: the same
 * (log, t) always gives the same picture, forwards or backwards. The only time source is the
 * playhead; every motion is `animationProgress(name, (t - event.t) / RATE)`, i.e. the spec's
 * durations (wall ms at 1x) converted to factory ms.
 *
 * M6.2: events come from the store's scene log (`LogEntry`), whatever the source. The simulation and
 * a historical replay play factory time at the base rate (10 factory ms per wall ms at 1x), so a
 * motion lasts its spec duration times that rate in factory ms; live time is real time, so live
 * motions last their spec duration. In live mode an event that arrives after an event that sorts
 * after it (`late`) is drawn at its end state: its travel already happened and is not replayed.
 */
import { animationProgress, liftedArc, type ArtifactKind as UiArtifactKind, type FactoryAnimationName, type FactoryState, type GatePosition, type MarkState, type ModelTier as UiTier, type AgentRole as UiRole, type ToolFamily, type Vec3 } from "@mach/ui";
import { agentTimingAt, createLogFold, entityAt, eventsInWindow, isKnown, toolActivity, type ActivityState, type AgentState, type ArtifactState, type CellState, type EntityRef, type GateState, type LogEntry, type Scene, type SceneLog, type SceneSource, type StationId, type StationVisit, type ToolCallState } from "../sim";
import { PLAYBACK_BASE_RATE } from "../scene";
import { FLOOR_Z, PLATE_Z, type BaySlot, type PlantLayout } from "./layout";

/**
 * Factory ms per spec ms: the store's one time scale (`timeScaleOf` in src/scene), set before the
 * Atlas draws. 1 at the live edge; the chosen playback rate for the simulation, a replay, and a live
 * store scrubbed back.
 */
export let RATE: number = PLAYBACK_BASE_RATE;
/** Whether the Atlas draws live execution (late events snap; the nine activity states apply). */
export let LIVE = false;
export function setMotionSource(source: SceneSource, scale: number): void {
  RATE = scale;
  LIVE = source !== "simulation";
}
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

// ---------------------------------------------------------------- log entries

/** An id an event names (`ticket_id`, `slice_id`, `wave_id`): the v3 envelope's `ids`, or the simulation's own field. */
export function idOf(entry: LogEntry, key: "ticket_id" | "slice_id" | "wave_id"): string | null {
  const e = entry.event as unknown as { ids?: Record<string, unknown> } & Record<string, unknown>;
  const v = e.ids?.[key] ?? e[key];
  return typeof v === "string" && v ? v : null;
}

export function kindOf(entry: LogEntry): string {
  return entry.event.type;
}

// ---------------------------------------------------------------- render clocks

/**
 * Animation windows by event kind (spec ms, wall time at 1x): how long after an event its motion is
 * still changing on screen. A part re-renders with the playhead only while one of its events is
 * inside its window; otherwise its picture is settled and it does not re-render (spec g: React
 * commits). Simulation kinds and v3 kinds side by side; `agent.progressed` (a workflow agent's
 * count) has no window: a count changes, nothing moves.
 */
export const WINDOWS: Readonly<Record<string, number>> = {
  "agent.started": 480,
  "agent.finished": 360,
  "tool.started": 240,
  "tool.called": 240,
  "artifact.written": 520,
  "artifact.recorded": 520,
  "evidence.captured": 300,
  "verify.check_recorded": 160,
  "verification.started": 420,
  "verification.verdict": 1600,
  "gate.evaluated": 1600,
  "execution.started": 600,
  "merge.completed": 1100 + 520,
  "merge.revalidated": 520,
  "review.started": 700 + 3 * 90,
  "review.round_started": 700 + 3 * 90,
  "review.vote": 600,
  "review.verdict_submitted": 600,
  "review.finding": 520,
  "review.decided": 1600,
  "human.approval_recorded": 700,
  "station.entered": 1400,
  "station.left": 1400,
  "station.exited": 1400,
  "work.scheduled": 1400,
  "wave.discovered": 1400,
  "slice.materialized": 1900,
  "dependency.resolved": 800,
  "slice.integrated": 800,
  "cleanup.completed": 520,
  "gate.checked": 520,
  "test.result": 160,
  "build.task_completed": 160,
};
const MAX_WINDOW = Math.max(...Object.values(WINDOWS));

/** Whether any event (optionally filtered) is still inside its animation window at t. */
export function animating(log: SceneLog, t: number, filter?: (e: LogEntry) => boolean, windows: Readonly<Record<string, number>> = WINDOWS): boolean {
  for (const e of eventsInWindow(log, t, MAX_WINDOW * RATE)) {
    const w = windows[e.event.type];
    if (w === undefined || t - e.t >= w * RATE) continue;
    if (LIVE && e.late) continue; // arrived late: drawn at its end state
    if (!filter || filter(e)) return true;
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

/** The simulation's agent state (M6.0): running, error or done. */
export function agentState(agent: AgentState): FactoryState {
  return agent.status === "running" ? "active" : agent.status === "error" ? "failed" : "succeeded";
}

/**
 * The nine activity states (`activityOf`) drawn with the grammar's seven states and the three
 * conditions. The two waits share the waiting mark: a dependency wait also hangs its padlocked cable
 * (spec d.3), a resource wait is lettered "waits for an execution place".
 */
export function activityMark(state: ActivityState): MarkState {
  switch (state) {
    case "executing":
      return "active";
    case "waiting-dependency":
    case "waiting-resources":
      return "waiting";
    case "waiting-person":
      return "human";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "stale":
      return "stale";
    case "unknown":
      return "unknown";
  }
}

/** The words for an activity state, as a mast or a label letters them. */
export function activityWord(state: ActivityState): string {
  switch (state) {
    case "executing":
      return "Working";
    case "waiting-dependency":
      return "Waits on a dependency";
    case "waiting-resources":
      return "Waits for an execution place";
    case "waiting-person":
      return "Waits for a person";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "stale":
      return "As last seen";
    case "unknown":
      return "Not known";
  }
}

/** How the Atlas reads what it shows: the simulation as before, or real execution (live, replay) and whether the connection is stale. */
export interface ViewMode {
  readonly live: boolean;
  readonly stale: boolean;
}
export const SIM_MODE: ViewMode = { live: false, stale: false };

/**
 * An agent's state as drawn. Simulation: as M6.0 (running, error, done). Live and replay: from its
 * recorded lifecycle; a running agent on a stale connection is drawn as last seen, never as working.
 */
export function agentMark(agent: AgentState, mode: ViewMode): MarkState {
  if (!mode.live) return agentState(agent);
  switch (agent.lifecycle) {
    case "queued":
      return "waiting";
    case "running":
      return mode.stale ? "stale" : "active";
    case "done":
      return "succeeded";
    case "error":
      return "failed";
    case "unknown":
      return "unknown";
  }
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
  /** Let through on a recorded override (drawn open and marked, never as a plain pass). */
  overridden: boolean;
}

const OPEN: GateView = { id: null, position: "open", from: "open", progress: 1, gate: null, overridden: false };

/** A gate's arm from its state: closes when work arrives, opens on a pass or an override, refuses on a failure. */
export function gateView(gate: GateState | undefined | null, t: number, reduced: boolean): GateView {
  if (!gate) return OPEN;
  switch (gate.state) {
    case "open":
      return { id: gate.id, position: "closed", from: "open", progress: q(anim("gateClose", t - gate.openedAt, reduced)), gate, overridden: false };
    case "waiting":
      return { id: gate.id, position: "waiting", from: "open", progress: q(anim("gateClose", t - gate.openedAt, reduced)), gate, overridden: false };
    case "passed":
    case "skipped":
    case "overridden": {
      const at = gate.decidedAt ?? gate.openedAt;
      return { id: gate.id, position: "open", from: "closed", progress: q(anim(gate.gate === "human-approval" ? "humanRelease" : "gateOpen", t - at, reduced)), gate, overridden: gate.state === "overridden" };
    }
    case "failed":
      return { id: gate.id, position: "refusing", from: "closed", progress: q(anim("gateRefuse", t - (gate.decidedAt ?? gate.openedAt), reduced)), gate, overridden: false };
  }
}

/**
 * A gate's state in words, from the gate's own record (never from its arm's position, nor from the
 * cell's stage): "passed", "refused", "overridden (test-passed-first-run)", "waiting for a person",
 * "deciding", "not needed", or "not reached yet" when no record exists.
 */
export function gateWord(gate: GateState | undefined | null): string {
  if (!gate) return "not reached yet";
  switch (gate.state) {
    case "open":
      return "deciding";
    case "waiting":
      return "waiting for a person";
    case "passed":
      return "passed";
    case "skipped":
      return "not needed";
    case "overridden":
      return `overridden${gate.reasonCode ? ` (${gate.reasonCode})` : ""}`;
    case "failed":
      return `refused${gate.reasonCode ? ` (${gate.reasonCode})` : ""}`;
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

// ---------------------------------------------------------------- station visits

const PASSING: ReadonlySet<string> = new Set(["done", "passed", "approved", "awaiting-human", "merged", "archived"]);

/**
 * A visit as drawn, from its own record only: working while open, interrupted when it ended without
 * an exit record (the scene closed it: superseded or its execution ended), failed or passed by its
 * outcome, blocked when it stopped (escalated, open questions), unknown when it ended with no outcome.
 */
export function visitMark(v: StationVisit): MarkState {
  if (v.unclosed) return "interrupted";
  if (v.leftAt === null) return v.station === "human-approval" ? "human" : "active";
  if (v.outcome === "failed" || v.outcome === "rejected") return "failed";
  if (v.outcome === "stopped") return "blocked";
  if (v.outcome !== null && PASSING.has(v.outcome)) return "succeeded";
  return "unknown";
}

/** A visit's state in words, for a name: the station's own word, or why it has none. */
export function visitWord(v: StationVisit): string {
  if (v.unclosed) return `ended without an exit record (${v.unclosed.reason === "superseded" ? "the station was entered again" : "its execution ended"})`;
  if (v.leftAt === null) return v.station === "human-approval" ? "waiting for a person" : "working";
  return v.outcomeWord ?? v.outcome ?? "ended, outcome not recorded";
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

const legCache = new WeakMap<SceneLog, { version: number; layout: PlantLayout; rate: number; legs: readonly Leg[] }>();


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

/** An intake, dispatch or merge event, as the legs need it: read once per log entry (incrementally). */
interface LegEvent {
  readonly t: number;
  readonly id: string;
  readonly type: "wave.discovered" | "slice.materialized" | "work.scheduled" | "merge.completed";
  readonly ticket: string | null;
  readonly slice: string | null;
  readonly wave: string | null;
  readonly late: boolean;
}

/**
 * The log's leg-making events, kept by the shared incremental fold (`createLogFold`): an append reads
 * only the new entries, a late insertion re-reads once. (It replaced a scan of the whole log on every
 * change.)
 */
const legEvents = createLogFold<LegEvent>((entry) => {
  const type = entry.event.type;
  if (type !== "wave.discovered" && type !== "slice.materialized" && type !== "work.scheduled" && type !== "merge.completed") return null;
  return { t: entry.t, id: entry.id, type, ticket: idOf(entry, "ticket_id"), slice: idOf(entry, "slice_id"), wave: idOf(entry, "wave_id"), late: entry.late };
});

/**
 * Every journey known so far: one per intake, dispatch and merge event received, and one per
 * station-to-station move of each cell (from its visits in the head scene: a move is known once the
 * cell has entered its next station, never guessed ahead). Recomputed when the log changes; a leg
 * already known never changes. A leg whose event arrived late (live) is left out: it is drawn at its
 * end, not replayed.
 */
export function legsOf(log: SceneLog, L: PlantLayout): readonly Leg[] {
  const version = log.version();
  const hit = legCache.get(log);
  if (hit && hit.version === version && hit.layout === L && hit.rate === RATE) return hit.legs;
  const TRAVEL_MS = 1400 * RATE;
  const out: Leg[] = [];
  const head = log.head();
  for (const entry of legEvents(log).items) {
    const type = entry.type;
    if (LIVE && entry.late) continue;
    const t = entry.t;
    const ticket = entry.ticket;
    if (type === "wave.discovered") {
      const wave = entry.wave;
      out.push({ id: `wave:${entry.id}`, ticketId: wave ?? "", kind: "wave", start: t, dur: TRAVEL_MS, route: [L.intake.dockEdge, { ...L.intake.hopper, x: L.intake.hopper.x - 22 }], state: "active", card: "spec", label: `${wave ?? "A wave"} arrives`, priority: 3, motion: "packetTravel" });
    } else if (type === "slice.materialized") {
      const slice = entry.slice;
      const bay = slice ? L.bayBySlice.get(slice) : undefined;
      if (!bay) continue;
      const h = L.intake.hopper;
      out.push({ id: `cut:${entry.id}`, ticketId: ticket ?? "", kind: "cut", start: t, dur: 900 * RATE, route: [{ ...h, x: h.x + 22 }, { x: 112, y: h.y, z: PLATE_Z }, { x: 112, y: bay.pad.y, z: PLATE_Z }, bay.pad], state: "active", card: "spec", label: `${ticket ?? bay.ticketId} cut from ${slice}`, priority: 2, motion: "artifactHandoff" });
    } else if (type === "work.scheduled" && ticket) {
      const bay = L.bayByTicket.get(ticket);
      if (!bay) continue;
      const route: Vec3[] = [
        bay.pad,
        { x: 186, y: bay.pad.y, z: PLATE_Z },
        { x: 186, y: L.mid, z: PLATE_Z },
        { x: L.floor.spineX, y: L.mid, z: PLATE_Z },
        ...(L.tracks[`spur:${bay.ticketId}`] ?? []),
        { ...bay.entrance, z: PLATE_Z },
      ].filter((p, i, a) => i === 0 || Math.hypot(a[i - 1]!.x - p.x, a[i - 1]!.y - p.y) > 0.5);
      out.push({ id: `dispatch:${entry.id}`, ticketId: ticket, kind: "dispatch", start: t, dur: TRAVEL_MS, route, state: "active", label: `${ticket} dispatched`, priority: 4, motion: "packetTravel" });
    } else if (type === "merge.completed" && ticket) {
      const m = L.integration.merge;
      out.push({ id: `integrate:${entry.id}`, ticketId: ticket, kind: "integrate", start: t, dur: 1100 * RATE, route: [{ ...m, x: m.x - 22 }, { x: m.x - 22 - 96, y: m.y, z: PLATE_Z }], state: "succeeded", label: `${ticket} merged into main`, priority: 5, motion: "mergeIntegrate" });
    }
  }
  for (const cell of Object.values(head.cells)) {
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
  legCache.set(log, { version, layout: L, rate: RATE, legs: out });
  return out;
}

/** Legs in flight at t, within the motion budget (spec e.1: 12 packets; over it, the lowest priority snap). */
export function legsInFlight(log: SceneLog, L: PlantLayout, t: number, reduced: boolean): { leg: Leg; p: number }[] {
  const all = legsOf(log, L);
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

export interface SittingPanel {
  cell: CellState;
  roundIndex: number;
}

/**
 * Every review panel sitting now (or just decided), oldest first. Live and replay can have several at
 * once; the simulation has one at a time.
 */
export function panelsSitting(scene: Scene, t: number): SittingPanel[] {
  const out: SittingPanel[] = [];
  for (const cell of Object.values(scene.cells)) {
    const i = cell.reviews.length - 1;
    const r = cell.reviews[i];
    if (!r) continue;
    const live = cell.station === "review" || (r.decidedAt !== null && t - r.decidedAt < AFTERGLOW * 2);
    if (live) out.push({ cell, roundIndex: i });
  }
  return out.sort((a, b) => (a.cell.reviews[a.roundIndex]?.startedAt ?? 0) - (b.cell.reviews[b.roundIndex]?.startedAt ?? 0) || (a.cell.ticketId < b.cell.ticketId ? -1 : 1));
}

/**
 * The panel the chamber shows: the one of `prefer` (the ticket of what the person selected) when that
 * panel sits, else the latest to start. The person steps between sitting panels by selecting them.
 */
export function chamberOccupant(scene: Scene, t: number, prefer: string | null = null): SittingPanel | null {
  const all = panelsSitting(scene, t);
  if (!all.length) return null;
  return (prefer ? all.find((p) => p.cell.ticketId === prefer) : undefined) ?? all[all.length - 1]!;
}

/** The ticket an entity belongs to, read from the scene (never parsed from its id): null when none. */
export function ticketOfRef(scene: Scene, entity: EntityRef | null): string | null {
  if (!entity) return null;
  const found = entityAt(scene, entity);
  const v = found?.value as { ticketId?: unknown } | undefined;
  return typeof v?.ticketId === "string" ? v.ticketId : null;
}

// ---------------------------------------------------------------- agents in place

export interface PlacedAgent {
  agent: AgentState;
  at: Vec3;
  arrive: number;
  leave: number;
  /** A state, or (live) a condition. */
  state: MarkState;
  /** How long the agent has worked by t (factory ms): known, never a fraction. */
  elapsed: number;
  /** Whether its start is recorded (false: elapsed is "not recorded", never 0). */
  elapsedKnown: boolean;
  /** Whether its start was placed rather than measured (lettered "≈"). */
  elapsedInferred: boolean;
  /** Whether its model is recorded (false: the head is drawn open, "model not recorded"). */
  tierKnown: boolean;
  /** Known only from the observer's reconstruction (closed by it): drawn open. */
  open: boolean;
  /** Order among agents sharing one spot (label stacking). */
  stack: number;
  /** Reduced motion: arrival and departure are opacity only, never a growing or sinking post. */
  reduced: boolean;
}

/** Agents in a cell in the order they stand: by their index in the workflow where known (live), else in start order. */
function standingOrder(cell: CellState): readonly string[] {
  const order = cell.agentOrder;
  if (!order.some((id) => cell.agents[id]?.index != null)) return order;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...order].sort((a, b) => (cell.agents[a]?.index ?? Infinity) - (cell.agents[b]?.index ?? Infinity) || pos.get(a)! - pos.get(b)!);
}

/**
 * Agents present at t (running, or leaving): where they stand and how far they have arrived. Placed
 * from the scene's own fields only (station, seat, the index in its workflow), never from an id.
 * Agents whose cell is not known (`scene.strayAgents`) are not placed.
 */
export function placeAgents(L: PlantLayout, cell: CellState, t: number, reduced: boolean, mode: ViewMode = SIM_MODE): PlacedAgent[] {
  const bay = L.bayByTicket.get(cell.ticketId);
  if (!bay) return [];
  const leaveMs = 360 * RATE;
  const seatCount = new Map<string, number>();
  const out: PlacedAgent[] = [];
  for (const id of standingOrder(cell)) {
    const a = cell.agents[id] as AgentState;
    if (a.lifecycle === "queued") continue;
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
    const startKnown = isKnown(a.meta, "startedAt");
    out.push({
      agent: a,
      at,
      // An agent whose start is not recorded has no arrival to animate: it stands.
      arrive: startKnown ? q(anim("agentArrive", t - a.startedAt, reduced)) : 1,
      leave: a.finishedAt !== null ? q(anim("agentLeave", t - a.finishedAt, reduced)) : 0,
      state: agentMark(a, mode),
      elapsed: agentTimingAt(a, t).elapsed,
      elapsedKnown: startKnown,
      elapsedInferred: a.meta.start === "inferred",
      tierKnown: isKnown(a.meta, "model"),
      open: a.meta.authority === "reconstructed",
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
  // Per-call agents only (the simulation, a main loop): a workflow agent's calls are not observable.
  for (const id of cell.agentOrder) {
    const activity = toolActivity(cell.agents[id] as AgentState);
    if (activity.kind === "calls") out.push(...activity.calls);
  }
  out.sort((a, b) => a.startedAt - b.startedAt || a.startedSeq - b.startedSeq);
  callsCache.set(cell, out);
  return out;
}

/**
 * What is known of a cell's count-only agents (Dynamic Workflow agents): how many tool calls they
 * have reported and the last tool's name, never the calls themselves (contract 8.1). `calls` is null
 * when no agent has reported a count yet; `agent` is the one whose last tool is named (a running one
 * first, else the latest to start).
 */
export interface CountedTools {
  agents: number;
  running: number;
  calls: number | null;
  lastTool: string | null;
  agent: AgentState | null;
}
const countCache = new WeakMap<CellState, CountedTools>();
export function countedToolsOf(cell: CellState): CountedTools {
  const hit = countCache.get(cell);
  if (hit) return hit;
  let agents = 0;
  let running = 0;
  let calls: number | null = null;
  let pick: AgentState | null = null;
  for (const id of cell.agentOrder) {
    const a = cell.agents[id] as AgentState;
    const activity = toolActivity(a);
    if (activity.kind !== "count") continue;
    agents += 1;
    if (a.lifecycle === "running") running += 1;
    if (activity.count !== null) calls = (calls ?? 0) + activity.count;
    if (activity.lastTool !== null && (!pick || (a.lifecycle === "running" && pick.lifecycle !== "running") || (a.lifecycle === pick.lifecycle && a.startedAt >= pick.startedAt))) pick = a;
  }
  const out = { agents, running, calls, lastTool: pick?.lastTool ?? null, agent: pick };
  countCache.set(cell, out);
  return out;
}

/** Elapsed time as lettered: measured ("6 min"), placed ("≈ 6 min") or not recorded. */
export function fmtElapsedKnown(ms: number, known: boolean, inferred: boolean): string {
  if (!known) return "elapsed not recorded";
  return `${inferred ? "≈ " : ""}${fmtElapsed(ms)}`;
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

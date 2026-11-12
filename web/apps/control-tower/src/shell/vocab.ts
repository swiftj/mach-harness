/**
 * The shell's bridge between the simulation's vocabulary (src/sim) and the factory grammar in
 * @mach/ui (shapes, inks, words). Presentation only: nothing here decides what is happening.
 */
import {
  cellStages,
  factoryStates,
  type AgentRole as GrammarRole,
  type ArtifactKind as GrammarArtifact,
  type FactoryMarkShape,
  type FactoryState,
  type GateKind as GrammarGate,
  type ModelTier as GrammarTier,
  type StationKind,
  type ToolFamily,
} from "@mach/ui";
import { ENTITY_KINDS, isoAt, MODELS, type ActorId, type AgentRole, type AnyRef, type EntityRef, type ArtifactKind, type CellStage, type EntityKind, type GateKind, type GateState, type ModelId, type SchedulerState, type StationOutcome, type Telemetry, type ToolName } from "../sim";

// ---------------------------------------------------------------- time

/**
 * What a time `t` means, set once by the app when it chooses its source (App.tsx):
 * - `scenario`: the simulation's ms from the scenario start, printed as a time code (mm:ss.s);
 * - `wall`: real history's `order_ms` (Unix ms), printed as wall-clock UTC (HH:MM:SS).
 * Only one source is shown at a time, so one module-wide base is enough and every caller of
 * `timecode` prints the right kind of time without being told.
 */
export type TimeBase = "scenario" | "wall";
let timeBase: TimeBase = "scenario";
export function setTimeBase(base: TimeBase): void {
  timeBase = base;
}
export function getTimeBase(): TimeBase {
  return timeBase;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Wall-clock UTC of a Unix ms time: HH:MM:SS (with tenths: HH:MM:SS.s). */
export function utcClock(t: number, tenths = false): string {
  const d = new Date(Math.max(0, t));
  const base = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return tenths ? `${base}.${Math.floor(d.getUTCMilliseconds() / 100)}` : base;
}

/** The UTC date of a Unix ms time, in words: 12 Nov 2026. */
export function utcDate(t: number): string {
  const d = new Date(Math.max(0, t));
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Factory time as mm:ss.s from the scenario start (the spec's time code); for real history, wall-clock UTC. */
export function timecode(t: number, tenths = true): string {
  if (timeBase === "wall") return utcClock(t, tenths);
  const total = Math.max(0, t) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** The wall clock at time t (UTC, HH:MM:SS): simulated for the simulation, real for real history. */
export function clockAt(t: number): string {
  if (timeBase === "wall") return utcClock(t);
  return isoAt(Math.max(0, Math.floor(t / 1000) * 1000)).slice(11, 19);
}

/** A duration in plain words: 48 s, 4 min 12 s, 1 h 3 min. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Spoken form of a time code, for screen readers. */
export function spokenTime(t: number): string {
  if (timeBase === "wall") {
    const d = new Date(Math.max(0, t));
    return `${d.getUTCHours()} ${pad2(d.getUTCMinutes())} and ${d.getUTCSeconds()} seconds UTC`;
  }
  const total = Math.floor(Math.max(0, t) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- grammar mapping

export function tierOf(model: ModelId): GrammarTier {
  return model;
}
export function modelName(model: ModelId): string {
  return MODELS[model].name;
}

/** The emblem a sim role wears. Clerks and the merge and cleanup workers act for the line supervisor. */
export function roleOf(role: AgentRole): GrammarRole {
  switch (role) {
    case "contract-engineer":
    case "intent":
      return "contract-engineer";
    case "builder":
      return "builder";
    case "verifier":
      return "verifier";
    case "reviewer":
      return "reviewer";
    default:
      return "supervisor";
  }
}

export const ROLE_WORDS: Record<AgentRole, string> = {
  clerk: "Clerk",
  intent: "Plan worker",
  "contract-engineer": "Contract engineer",
  builder: "Builder",
  verifier: "Verifier",
  reviewer: "Reviewer",
  merge: "Merge worker",
  cleanup: "Cleanup worker",
  audit: "Audit worker",
  observe: "Observer",
};

export function gateOf(gate: GateKind): GrammarGate {
  switch (gate) {
    case "audit":
    case "plan-check":
      return "audit";
    case "red-before-green":
      return "red-green";
    case "verification":
      return "verification";
    case "review":
      return "consensus";
    case "human-approval":
      return "human";
    case "merge-revalidation":
      return "revalidation";
  }
}

export const GATE_WORDS: Record<GateKind, string> = {
  audit: "Audit gate",
  "plan-check": "Plan check",
  "red-before-green": "Red before green",
  verification: "Verification verdict",
  review: "Review consensus",
  "human-approval": "Human approval",
  "merge-revalidation": "Merge revalidation",
};

export function artifactOf(kind: ArtifactKind): GrammarArtifact {
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
      return kind;
    case "build-state":
    case "build-report":
      return "build-report";
    case "findings-copy":
    case "verification-findings":
    case "review-findings":
      return "findings";
    case "verification-results":
    case "verification-summary":
    case "archive":
    case "run-record":
      return "results";
    case "review-packet":
      return "spec";
    case "review-diff":
      return "commit";
  }
}

export function toolFamily(tool: ToolName, target: string): ToolFamily {
  switch (tool) {
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
      if (/^git\b/.test(target)) return "git";
      if (/\btest|vitest|playwright|pytest|suite\b/.test(target)) return "test";
      return "run";
    default:
      return "run";
  }
}

export function outcomeState(outcome: StationOutcome | null): FactoryState {
  switch (outcome) {
    case null:
      return "active";
    case "failed":
    case "rejected":
      return "failed";
    case "awaiting-human":
      return "human";
    case "stopped":
      return "idle";
    default:
      return "succeeded";
  }
}

export function gateState(state: GateState["state"]): FactoryState {
  return ({ open: "active", passed: "succeeded", failed: "failed", waiting: "human", skipped: "idle" } as const)[state];
}

export const GATE_STATE_WORDS: Record<GateState["state"], string> = {
  open: "Checking",
  passed: "Passed",
  failed: "Refused",
  waiting: "Waiting for a person",
  skipped: "Not needed",
};

export function runState(status: "running" | "done" | "ok" | "error"): FactoryState {
  return status === "running" ? "active" : status === "error" ? "failed" : "succeeded";
}

export function stageLook(stage: CellStage): { label: string; state: FactoryState; mark?: FactoryMarkShape } {
  if (stage === "spec-open") return { label: "Spec has open questions", state: "human" };
  return cellStages[stage];
}

export function schedulerLook(state: SchedulerState): { label: string; state: FactoryState; mark?: FactoryMarkShape } {
  switch (state) {
    case "materialized":
      return { label: "Ticket filed", state: "idle" };
    case "waiting-on-dependency":
      return { label: "Waiting on a dependency", state: "waiting" };
    case "eligible":
      return { label: "Eligible", state: "idle" };
    case "dispatched":
      return { label: "Dispatched", state: "active" };
    case "integrated":
      return { label: "Integrated", state: "succeeded", mark: "double-ring" };
  }
}

export function stateWord(state: FactoryState): string {
  return factoryStates[state].label;
}

export const STATION_WORDS: Record<StationKind, string> = {
  intake: "Intake",
  groom: "Groom",
  plan: "Plan",
  audit: "Audit",
  build: "Build",
  verify: "Verify",
  review: "Review",
  "human-approval": "Human approval",
  merge: "Merge",
  cleanup: "Cleanup",
  observe: "Observe",
};

/**
 * Every kind the shell can show: the store's entity kinds plus the actors (actor:supervisor,
 * actor:scheduler). Written so it compiles whether or not "actor" is already in EntityKind.
 */
export type ShellKind = EntityKind | "actor";

export function kindOf(entity: AnyRef): ShellKind {
  return entity.slice(0, entity.indexOf(":")) as ShellKind;
}

/** The ref as a store selection, if the store can hold it (actors only once "actor" is an EntityKind). */
export function selectable(entity: AnyRef | null): EntityRef | null {
  if (!entity) return null;
  return (ENTITY_KINDS as readonly string[]).includes(kindOf(entity)) ? (entity as EntityRef) : null;
}

export const ACTOR_WORDS: Record<ActorId, { role: string; does: string }> = {
  supervisor: {
    role: "Line supervisor",
    does: "Ticks once a minute: reads each cell's stage, claims and starts executions, records how they ended, and decides what to start next.",
  },
  scheduler: {
    role: "Scheduler",
    does: "Intake's dependency-aware plan: decides which slices are ready and which wait and why, opens a cell for each dispatched slice, and records integration.",
  },
};

export const KIND_WORDS: Record<ShellKind, string> = {
  actor: "Actor",
  wave: "Delivery wave",
  slice: "Slice",
  cell: "Cell",
  station: "Station visit",
  execution: "Execution",
  agent: "Agent",
  tool: "Tool call",
  artifact: "Artifact",
  gate: "Gate",
  dependency: "Dependency",
  finding: "Review finding",
  project: "Project",
  workflow: "Workflow",
  visit: "Visit",
  seat: "Review seat",
};

export const TELEMETRY_WORDS: Record<Telemetry, { label: string; description: string }> = {
  exists: { label: "Exists", description: "MACH emits this event today." },
  derivable: { label: "Derivable", description: "Not emitted, but recorded on disk; an observer could derive it." },
  missing: { label: "Missing", description: "Not recorded anywhere today." },
};

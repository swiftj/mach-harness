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
import { ENTITY_KINDS, gateNameWords, MODELS, type ActorId, type AgentRole, type AnyRef, type EntityRef, type ArtifactKind, type CellStage, type EntityKind, type GateKind, type GateState, type ModelId, type SchedulerState, type StationOutcome, type Telemetry, type ToolName } from "../sim";

// ---------------------------------------------------------------- time

// The time words live in a module of their own (no grammar import), so plain tests can read them.
export { setTimeBase, getTimeBase, utcClock, utcDate, timecode, clockAt, duration, spokenTime, timeCodeText, isMoment, type TimeBase } from "./time";

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

export function gateOf(gate: GateKind | "recorded"): GrammarGate {
  switch (gate) {
    // A gate no gate kind stands for (frozen-tests, build.start...): the plain check glyph.
    case "recorded":
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
  // An override let the work through: drawn as through, and always named "Overridden" beside it (never "Passed").
  return ({ open: "active", passed: "succeeded", failed: "failed", waiting: "human", skipped: "idle", overridden: "succeeded" } as const)[state];
}

// One source of truth for a gate's state in words, shared with the Atlas and the Blueprint (D10).
export { GATE_STATE_WORDS, gateStateWords } from "../sim";

/** A gate's name: its kind's words, or a recorded gate's own lifecycle name ("Frozen tests"). */
export function gateName(gate: Pick<GateState, "gate" | "recorded">): string {
  return gateNameWords(gate, GATE_WORDS);
}

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

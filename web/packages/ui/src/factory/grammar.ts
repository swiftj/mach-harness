import { factoryTokens } from "../tokens/tokens";

/**
 * The factory's semantic grammar as data: every kind of thing on the plant, every state, and how
 * each reads. Presentation only. The simulation decides what is happening; these tables say how it
 * looks. Words follow MACH's own vocabulary (CLAUDE.md sections 2, 4 and 5).
 */

/** A factory colour role, as `var(--mach-factory-<name>)`. */
export type FactoryColor =
  | "ground"
  | "grid"
  | "grid-major"
  | "plate-top"
  | "plate-lit"
  | "plate-shade"
  | "plate-edge"
  | "floor"
  | "hatch"
  | "shadow"
  | "ink"
  | "ink-soft"
  | "route"
  | "live"
  | "live-soft"
  | "pass"
  | "pass-soft"
  | "fail"
  | "fail-soft"
  | "wait"
  | "wait-soft"
  | "human"
  | "human-soft"
  | "select"
  | "lamp";

export function fc(name: FactoryColor): string {
  return `var(--mach-factory-${name})`;
}

/* ------------------------------------------------------------------------------------------------ */
/* States                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The seven visual states every factory thing can be in. `selected` and `dimmed` are not states:
 * they are modifiers that combine with any state.
 */
export type FactoryState = "idle" | "active" | "succeeded" | "failed" | "waiting" | "human" | "blocked";

/** The shape that carries a state without colour. */
export type FactoryMarkShape = "ring-dashed" | "ring-sector" | "disc-tick" | "disc-cross" | "ring-hourglass" | "ring-dot" | "octagon-bar" | "double-ring";

export interface FactoryStateLook {
  label: string;
  description: string;
  /** Stroke and mark colour. */
  ink: FactoryColor;
  /** Tint for faces and fills. */
  soft: FactoryColor;
  mark: FactoryMarkShape;
  /** Outline dash for the thing's own outline: dashed means not yet settled. */
  dash?: string;
  /** Outline weight multiplier. */
  weight: number;
}

export const factoryStates: Record<FactoryState, FactoryStateLook> = {
  idle: { label: "Idle", description: "Nothing is happening here now.", ink: "ink-soft", soft: "plate-top", mark: "ring-dashed", dash: "3 2.5", weight: 1 },
  active: { label: "Working", description: "Work is in progress here.", ink: "live", soft: "live-soft", mark: "ring-sector", weight: 1.25 },
  succeeded: { label: "Passed", description: "Finished and passed.", ink: "pass", soft: "pass-soft", mark: "disc-tick", weight: 1 },
  failed: { label: "Failed", description: "Finished and failed; the evidence says why.", ink: "fail", soft: "fail-soft", mark: "disc-cross", weight: 1.5 },
  waiting: { label: "Waiting", description: "Ready, held back by something else (a dependency, capacity).", ink: "wait", soft: "wait-soft", mark: "ring-hourglass", dash: "5 2.5", weight: 1.25 },
  human: { label: "Waiting for a person", description: "Held until a person decides.", ink: "human", soft: "human-soft", mark: "ring-dot", weight: 1.5 },
  blocked: { label: "Blocked", description: "Escalated: cannot move until a person intervenes.", ink: "fail", soft: "fail-soft", mark: "octagon-bar", weight: 2 },
};

/** Opacity of a dimmed thing (not on the highlighted path). Text in a dimmed thing stays at least 0.55. */
export const dimmedOpacity = 0.28;
export const dimmedTextOpacity = 0.55;

/** Real cell stages (cell.json) and scheduler states, mapped to a visual state and words. */
export type CellStage =
  | "waiting-on-dependency"
  | "eligible"
  | "dispatched"
  | "interview"
  | "spec-ready"
  | "planned"
  | "building"
  | "built"
  | "verified"
  | "awaiting-human"
  | "approved"
  | "pr-open"
  | "merged"
  | "blocked";

export interface CellStageLook {
  label: string;
  state: FactoryState;
  /** Overrides the state's mark where the stage is final. */
  mark?: FactoryMarkShape;
  /** Where the stage sits on the belt, 0 (before the cell exists) to 9 (merged). */
  step: number;
}

export const cellStages: Record<CellStage, CellStageLook> = {
  "waiting-on-dependency": { label: "Waiting on a dependency", state: "waiting", step: 0 },
  eligible: { label: "Eligible", state: "idle", step: 0 },
  dispatched: { label: "Dispatched", state: "active", step: 1 },
  interview: { label: "Grooming", state: "active", step: 1 },
  "spec-ready": { label: "Spec ready", state: "idle", step: 2 },
  planned: { label: "Planned", state: "idle", step: 3 },
  building: { label: "Building", state: "active", step: 4 },
  built: { label: "Built", state: "idle", step: 5 },
  verified: { label: "Verified", state: "succeeded", step: 6 },
  "awaiting-human": { label: "Awaiting a person", state: "human", step: 7 },
  approved: { label: "Approved", state: "succeeded", step: 7 },
  "pr-open": { label: "Pull request open", state: "active", step: 8 },
  merged: { label: "Merged", state: "succeeded", mark: "double-ring", step: 9 },
  blocked: { label: "Blocked, escalated", state: "blocked", step: -1 },
};

/* ------------------------------------------------------------------------------------------------ */
/* Stations                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export type StationKind = "intake" | "groom" | "plan" | "audit" | "build" | "verify" | "review" | "human-approval" | "merge" | "cleanup" | "observe";

export interface StationLook {
  label: string;
  /** The skill that runs it, as the person would type it. */
  skill: string;
  /** Height of the machine in the Atlas, in plan units. */
  height: number;
  /** The region it stands in. */
  region: RegionKind;
}

const e = factoryTokens.elevation;

export const stations: Record<StationKind, StationLook> = {
  intake: { label: "Intake", skill: "/mach-ticket", height: 16, region: "intake" },
  groom: { label: "Groom", skill: "/mach-intent", height: e.stationLow, region: "floor" },
  plan: { label: "Plan", skill: "/mach-intent", height: e.stationLow, region: "floor" },
  audit: { label: "Audit", skill: "/mach-audit", height: 14, region: "intake" },
  build: { label: "Build", skill: "/mach-build", height: e.stationHigh, region: "floor" },
  verify: { label: "Verify", skill: "/mach-verify", height: 18, region: "floor" },
  review: { label: "Review", skill: "/mach-review", height: e.stationLow, region: "review" },
  "human-approval": { label: "Human approval", skill: "review.py approve-human", height: 30, region: "human" },
  merge: { label: "Merge", skill: "/mach-merge", height: 16, region: "integration" },
  cleanup: { label: "Cleanup", skill: "/mach-cleanup", height: 10, region: "archive" },
  observe: { label: "Observe", skill: "/mach-observe", height: 20, region: "archive" },
};

/** Belt order (CLAUDE.md section 5). */
export const stationOrder: readonly StationKind[] = ["intake", "groom", "plan", "audit", "build", "verify", "review", "human-approval", "merge", "cleanup", "observe"];

/* ------------------------------------------------------------------------------------------------ */
/* Regions                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export type RegionKind = "intake" | "floor" | "review" | "human" | "integration" | "archive";

export const regions: Record<RegionKind, { label: string; description: string }> = {
  intake: { label: "Intake and scheduling", description: "Waves arrive, tickets are filed, the scheduler decides what may start." },
  floor: { label: "Construction floor", description: "One cell per ticket: grooming, planning, building and verification, each in its own worktree." },
  review: { label: "Review chamber", description: "Three fresh reviewers in parallel; their findings decide the vote." },
  human: { label: "Human approval", description: "Where high-risk work waits for a person." },
  integration: { label: "Integration", description: "Approved work is revalidated and merged into the main line." },
  archive: { label: "Archive and observe", description: "Finished cells are archived; the observer learns from the record." },
};

/* ------------------------------------------------------------------------------------------------ */
/* Agents                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export type AgentRole = "scheduler" | "supervisor" | "contract-engineer" | "builder" | "verifier" | "reviewer";
export type ReviewerSeat = "architecture" | "security" | "product";
export type ModelTier = "fable" | "opus" | "sonnet" | "haiku";

export const agentRoles: Record<AgentRole, { label: string }> = {
  scheduler: { label: "Scheduler" },
  supervisor: { label: "Line supervisor" },
  "contract-engineer": { label: "Contract engineer" },
  builder: { label: "Builder" },
  verifier: { label: "Verifier" },
  reviewer: { label: "Reviewer" },
};

export const reviewerSeats: Record<ReviewerSeat, { label: string; letter: string }> = {
  architecture: { label: "Architecture", letter: "A" },
  security: { label: "Security", letter: "S" },
  product: { label: "Product", letter: "P" },
};

/** Tier is read from the head's shape and the agent's height: heavier models stand taller. */
export const modelTiers: Record<ModelTier, { label: string; head: "diamond" | "square" | "circle" | "triangle"; height: number }> = {
  fable: { label: "Fable", head: "diamond", height: 32 },
  opus: { label: "Opus", head: "square", height: 28 },
  sonnet: { label: "Sonnet", head: "circle", height: 24 },
  haiku: { label: "Haiku", head: "triangle", height: 18 },
};

/* ------------------------------------------------------------------------------------------------ */
/* Gates, artifacts, tool calls                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export type GateKind = "audit" | "red-green" | "verification" | "consensus" | "human" | "revalidation";
export type GatePosition = "open" | "closed" | "refusing" | "waiting";

export const gates: Record<GateKind, { label: string; symbol: StationKind | "red-green" }> = {
  audit: { label: "Audit gate", symbol: "audit" },
  "red-green": { label: "Red before green", symbol: "red-green" },
  verification: { label: "Verification verdict", symbol: "verify" },
  consensus: { label: "Review consensus", symbol: "review" },
  human: { label: "Human approval", symbol: "human-approval" },
  revalidation: { label: "Merge revalidation", symbol: "merge" },
};

export const gatePositions: Record<GatePosition, { label: string; state: FactoryState }> = {
  open: { label: "Open", state: "succeeded" },
  closed: { label: "Closed", state: "idle" },
  refusing: { label: "Refused", state: "failed" },
  waiting: { label: "Waiting for a person", state: "human" },
};

export type ArtifactKind =
  | "intent"
  | "spec"
  | "contract"
  | "plan"
  | "commit"
  | "build-report"
  | "evidence"
  | "results"
  | "vote"
  | "findings"
  | "decision"
  | "merge-commit";

export const artifacts: Record<ArtifactKind, { label: string; file: string }> = {
  intent: { label: "Intent", file: "intent.md" },
  spec: { label: "Spec", file: "spec.json" },
  contract: { label: "Contract", file: "*.proto" },
  plan: { label: "Plan", file: "plan.md" },
  commit: { label: "Commit", file: "commit" },
  "build-report": { label: "Build report", file: "build-report.json" },
  evidence: { label: "Evidence", file: "evidence/" },
  results: { label: "Results", file: "results.json" },
  vote: { label: "Vote", file: "votes/" },
  findings: { label: "Findings", file: "findings.md" },
  decision: { label: "Decision", file: "decision.json" },
  "merge-commit": { label: "Merge commit", file: "merge commit" },
};

export type ToolFamily = "read" | "write" | "run" | "search" | "test" | "git";

export const toolFamilies: Record<ToolFamily, { label: string; examples: string }> = {
  read: { label: "Read", examples: "Read, Glob" },
  write: { label: "Write", examples: "Edit, Write" },
  run: { label: "Run", examples: "Bash, a station script" },
  search: { label: "Search", examples: "Grep, a sub-agent lookup" },
  test: { label: "Test", examples: "The suite, a single test" },
  git: { label: "Git", examples: "commit, worktree, merge" },
};

export type EdgeKind = "route" | "branch" | "join" | "retry" | "dependency" | "handoff" | "escalation";

export type Lod = "far" | "mid" | "near";

/** The semantic zoom level for a camera zoom, with hysteresis so it does not flicker at a threshold. */
export function lodForZoom(zoom: number, previous?: Lod): Lod {
  const z = factoryTokens.zoom;
  const h = previous ? z.hysteresis : 0;
  const farEdge = previous === "far" ? z.far + h : z.far - h;
  const nearEdge = previous === "near" ? z.near - h : z.near + h;
  if (zoom < farEdge) return "far";
  if (zoom > nearEdge) return "near";
  return "mid";
}

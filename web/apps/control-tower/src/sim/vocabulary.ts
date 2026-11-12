/**
 * The words MACH itself uses, as data. Every list here is copied from the real Factory, with the
 * file it comes from, so the simulation cannot drift into a vocabulary of its own.
 */

/** Real stations in belt order (CLAUDE.md section 5; skills/run/scripts/run.py). */
export const STATIONS = [
  "intake",
  "groom",
  "plan",
  "audit",
  "build",
  "verify",
  "review",
  "human-approval",
  "merge",
  "cleanup",
  "observe",
] as const;
export type StationId = (typeof STATIONS)[number];

/** Stages a cell records in cell.json (run.py next_step). */
export const CELL_STAGES = [
  "interview",
  "spec-open",
  "spec-ready",
  "planned",
  "building",
  "built",
  "verified",
  "awaiting-human",
  "approved",
  "pr-open",
  "merged",
  "blocked",
] as const;
export type CellStage = (typeof CELL_STAGES)[number];

/** What run.py next_step can answer ("action"). */
export const STEP_ACTIONS = ["audit", "groom", "plan", "build", "revise", "verify", "review", "merge", "cleanup", "stop"] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** The station each step works at. A revision is the build station again. */
export const ACTION_STATION: Readonly<Record<StepAction, StationId | null>> = {
  audit: "audit",
  groom: "groom",
  plan: "plan",
  build: "build",
  revise: "build",
  verify: "verify",
  review: "review",
  merge: "merge",
  cleanup: "cleanup",
  stop: null,
};

/**
 * run.py next_step as a table: for each recorded stage, the actions it can answer. `none` is a
 * ticket with no cell (not yet groomed, or finished and cleaned up). Tests check every station the
 * scenario enters against this table.
 */
export const NEXT_ACTIONS: Readonly<Record<CellStage | "none", readonly StepAction[]>> = {
  none: ["groom", "stop"],
  interview: ["groom"],
  "spec-open": ["groom", "stop"],
  "spec-ready": ["plan"],
  planned: ["audit", "build", "stop"],
  building: ["build"],
  built: ["revise", "verify"],
  verified: ["review"],
  "awaiting-human": ["stop"],
  approved: ["merge", "cleanup", "stop"],
  "pr-open": ["merge"],
  merged: ["cleanup"],
  blocked: ["stop"],
};

/**
 * Stage changes the station scripts can make, with the script that makes them. A failed
 * verification leaves the stage at `built` (verify.py cmd_finish), so it is not a stage change.
 */
export const STAGE_TRANSITIONS: ReadonlyArray<{ from: CellStage | null; to: CellStage; by: string }> = [
  { from: null, to: "interview", by: "cell.py open" },
  { from: null, to: "spec-ready", by: "intake.py open_cell (cell.py open, then finalize)" },
  { from: "interview", to: "spec-ready", by: "cell.py finalize" },
  { from: "interview", to: "spec-open", by: "cell.py finalize" },
  { from: "spec-ready", to: "planned", by: "cell.py check-plan" },
  { from: "planned", to: "building", by: "build.py start" },
  { from: "building", to: "built", by: "build.py finish" },
  { from: "built", to: "building", by: "build.py revise" },
  { from: "built", to: "blocked", by: "build.py revise (third failed round)" },
  { from: "built", to: "verified", by: "verify.py finish (PASS)" },
  { from: "verified", to: "approved", by: "review.py tally (APPROVED)" },
  { from: "verified", to: "awaiting-human", by: "review.py tally (AWAITING_HUMAN)" },
  { from: "verified", to: "built", by: "review.py tally (REJECTED)" },
  { from: "verified", to: "blocked", by: "review.py tally (ESCALATE)" },
  { from: "awaiting-human", to: "approved", by: "review.py approve-human" },
  { from: "approved", to: "built", by: "merge.py (approval void, or suite fails after revalidation)" },
  { from: "approved", to: "pr-open", by: "merge.py run (pr)" },
  { from: "approved", to: "merged", by: "merge.py run" },
  { from: "pr-open", to: "merged", by: "merge.py run" },
];

/** The intake scheduler's view of a slice (intake.py plan, plus the contract's names). */
export const SCHEDULER_STATES = ["materialized", "waiting-on-dependency", "eligible", "dispatched", "integrated"] as const;
export type SchedulerState = (typeof SCHEDULER_STATES)[number];

export const RISKS = ["Low", "Medium", "High"] as const;
export type Risk = (typeof RISKS)[number];

/** Model tiers (CLAUDE.md section 2; run.py Project.model). */
export type ModelTier = "planning" | "contracts" | "build" | "utility";
export type ModelId = "fable" | "opus" | "sonnet" | "haiku";
export type Effort = "low" | "medium" | "high";

export const MODELS: Readonly<Record<ModelId, { tier: ModelTier; name: string; modelId: string }>> = {
  fable: { tier: "planning", name: "Claude Fable 5.2", modelId: "claude-fable-5-2" },
  opus: { tier: "contracts", name: "Claude Opus 5.5", modelId: "claude-opus-5-5" },
  sonnet: { tier: "build", name: "Claude Sonnet 5.5", modelId: "claude-sonnet-5-5" },
  haiku: { tier: "utility", name: "Claude Haiku 5.5", modelId: "claude-haiku-5-5" },
};
export const TIER_MODEL: Readonly<Record<ModelTier, ModelId>> = { planning: "fable", contracts: "opus", build: "sonnet", utility: "haiku" };

/**
 * Who does the work inside one execution of the belt workflow (workflows/belt.js):
 * - `clerk`: the Haiku relay that runs one run.py command and reports its JSON;
 * - `intent`: the worker the belt starts for a `plan` step (the intent skill on the contracts tier),
 *   which starts the `contract-engineer` agent (agents/contract-engineer.md);
 * - `builder`, `verifier`, `reviewer`: agents/*.md;
 * - `merge`, `cleanup`: the utility-tier workers that run those skills;
 * - `audit`, `observe`: the workers for those skills (not used by the scenario).
 */
export const AGENT_ROLES = ["clerk", "intent", "contract-engineer", "builder", "verifier", "reviewer", "merge", "cleanup", "audit", "observe"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Real agent types, as a plugin install names them (executions load MACH as a plugin). */
export const AGENT_TYPES: Readonly<Partial<Record<AgentRole, string>>> = {
  "contract-engineer": "mach:contract-engineer",
  builder: "mach:builder",
  verifier: "mach:verifier",
  reviewer: "mach:reviewer",
};

/** Review seats (review.py ROLES). */
export const REVIEW_SEATS = ["architecture", "security", "product", "general"] as const;
export type ReviewSeat = (typeof REVIEW_SEATS)[number];

/** Review panels by risk (review.py PANELS); High seats run on the contracts tier, others on build. */
export const PANELS: Readonly<Record<Risk, { reviewers: number; approvals: number; human_approval: boolean }>> = {
  High: { reviewers: 3, approvals: 3, human_approval: true },
  Medium: { reviewers: 3, approvals: 2, human_approval: false },
  Low: { reviewers: 1, approvals: 1, human_approval: false },
};

/** Judging rounds per ticket, counting failed verifications (review.py MAX_LOOPS, build.py revise). */
export const MAX_ROUNDS = 3;

/** Phases of the belt workflow (workflows/belt.js meta.phases). */
export const BELT_PHASES = ["Preflight", "Groom", "Build", "Verify", "Review", "Wrap up", "Learn"] as const;
export type BeltPhase = (typeof BELT_PHASES)[number];

/** Build task kinds (build.py KINDS) and the step that completes each (STEP_FOR). */
export const TASK_KINDS = ["test", "impl", "contract", "refactor", "docs"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STEP: Readonly<Record<TaskKind, "red" | "green" | "done">> = {
  test: "red",
  impl: "green",
  contract: "done",
  refactor: "done",
  docs: "done",
};

/** Built-in tools an execution may use (policy.py BASE_TOOLS), plus the shell. */
export const TOOLS = ["Workflow", "Skill", "Agent", "Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;
export type ToolName = (typeof TOOLS)[number];

/** Gates the line closes on a ticket. */
export const GATE_KINDS = ["audit", "plan-check", "red-before-green", "verification", "review", "human-approval", "merge-revalidation"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const ARTIFACT_KINDS = [
  "intent",
  "spec",
  "contract",
  "plan",
  "commit",
  "build-state",
  "build-report",
  "findings-copy",
  "evidence",
  "verification-results",
  "verification-summary",
  "verification-findings",
  "review-packet",
  "review-diff",
  "vote",
  "review-findings",
  "decision",
  "merge-commit",
  "archive",
  "run-record",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Verification evidence kinds (verify.py REQUIRED_EVIDENCE for a web slice). */
export type AppType = "web" | "cli" | "api" | "rest" | "grpc" | "desktop" | "mobile" | "library";

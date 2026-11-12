/**
 * The data shapes of the simulation: the fixture, entity references, and the scene that
 * sceneAt(fixture, t) returns. Everything is plain, serialisable data. Scene objects are frozen by
 * convention (never mutate them): the engine shares unchanged parts between moments.
 */
import type { AnySimEvent, FactoryLimits, ReviewOutcome, StationOutcome, TargetKind, VerificationStatus } from "./events";
import type {
  AgentRole,
  AppType,
  ArtifactKind,
  BeltPhase,
  CellStage,
  Effort,
  GateKind,
  ModelId,
  ModelTier,
  ReviewSeat,
  Risk,
  SchedulerState,
  StationId,
  StepAction,
  TaskKind,
  ToolName,
} from "./vocabulary";

// ---------------------------------------------------------------- references

export const ENTITY_KINDS = [
  "wave",
  "slice",
  "cell",
  "station",
  "execution",
  "agent",
  "tool",
  "artifact",
  "gate",
  "dependency",
  "finding",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * One string names any selectable thing: `<kind>:<id>`.
 * - `wave:WAVE-007`, `slice:SLICE-021`, `cell:LOCAL-031`, `execution:x1a2b3c4d5e6f`
 * - `station:LOCAL-031/build` (a station as one cell visits it) or `station:build` (the station itself)
 * - `agent:ag-031-07`, `tool:tc-031-0042`, `artifact:LOCAL-031:plan.md`
 * - `gate:LOCAL-031/review#2` (round-numbered gates: verification, review), `gate:LOCAL-031/audit`
 * - `dependency:SLICE-024->SLICE-021` (the first waits for the second)
 * - `finding:LOCAL-032/r1/security/1`
 */
export type EntityRef = `${EntityKind}:${string}`;

export function refKind(ref: EntityRef): EntityKind {
  return ref.slice(0, ref.indexOf(":")) as EntityKind;
}
export function refId(ref: EntityRef): string {
  return ref.slice(ref.indexOf(":") + 1);
}
export const ref = {
  wave: (id: string): EntityRef => `wave:${id}`,
  slice: (id: string): EntityRef => `slice:${id}`,
  cell: (ticketId: string): EntityRef => `cell:${ticketId}`,
  station: (station: StationId, ticketId?: string): EntityRef => (ticketId ? `station:${ticketId}/${station}` : `station:${station}`),
  execution: (id: string): EntityRef => `execution:${id}`,
  agent: (id: string): EntityRef => `agent:${id}`,
  tool: (id: string): EntityRef => `tool:${id}`,
  artifact: (id: string): EntityRef => `artifact:${id}`,
  gate: (id: string): EntityRef => `gate:${id}`,
  dependency: (from: string, to: string): EntityRef => `dependency:${from}->${to}`,
  finding: (id: string): EntityRef => `finding:${id}`,
};

/** Gate IDs: `<ticket>/<gate>`, with `#<round>` for verification and review. */
export function gateId(ticketId: string, gate: GateKind, round?: number): string {
  return gate === "verification" || gate === "review" ? `${ticketId}/${gate}#${round ?? 1}` : `${ticketId}/${gate}`;
}

// ---------------------------------------------------------------- the fixture

/** What the events' refs point at: the approved product definitions, as intake reads them from the integration branch. */
export interface ProductDefinitions {
  readonly project: { readonly id: string; readonly name: string; readonly integrationBranch: string };
  readonly waves: Readonly<Record<string, WaveDefinition>>;
  readonly slices: Readonly<Record<string, SliceDefinition>>;
}
export interface WaveDefinition {
  readonly id: string;
  readonly title: string;
  readonly epicId: string;
  readonly epicTitle: string;
}
export interface SliceDefinition {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly waveId: string;
  readonly epicId: string;
  readonly risk: Risk;
  readonly appType: AppType;
  readonly dependencies: readonly string[];
  readonly specPath: string;
}

/** A named stretch of the run, for timeline markers and the capture script. */
export interface Chapter {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Start, in scenario ms; the seq of the event that opens it. */
  readonly t: number;
  readonly seq: number;
  readonly focus: EntityRef | null;
}

export interface Fixture {
  readonly id: string;
  readonly title: string;
  /** Scenario time zero, as UTC (events' `at` is this plus `t`). */
  readonly startAt: string;
  /** Last event's `t` plus a short tail, so the end state can be held on screen. */
  readonly duration: number;
  readonly events: readonly AnySimEvent[];
  readonly definitions: ProductDefinitions;
  readonly chapters: readonly Chapter[];
}

// ---------------------------------------------------------------- the scene

export interface Scene {
  /** How many events are applied (events[0 .. cursor-1]). */
  readonly cursor: number;
  /** `t` of the last applied event (0 before any). */
  readonly at: number;
  readonly lastSeq: number | null;
  readonly project: ProductDefinitions["project"];
  readonly factory: FactoryState;
  readonly supervisor: SupervisorState;
  readonly waves: Readonly<Record<string, WaveState>>;
  readonly slices: Readonly<Record<string, SliceState>>;
  readonly dependencies: Readonly<Record<string, DependencyState>>;
  readonly cells: Readonly<Record<string, CellState>>;
  readonly executions: Readonly<Record<string, ExecutionState>>;
  readonly gates: Readonly<Record<string, GateState>>;
  readonly counters: Counters;
}

export interface FactoryState {
  readonly enabled: boolean;
  readonly autonomy: "observe" | "supervised" | null;
  readonly enabledBy: string | null;
  readonly allowMerge: boolean;
  readonly limits: FactoryLimits | null;
  readonly runnerId: string | null;
  /** The product commit intake last read (revision.discovered). */
  readonly productCommit: string | null;
}

export interface SupervisorState {
  readonly lastDecisionAt: number | null;
  readonly lastDecision: { readonly dispatched: readonly string[]; readonly started: readonly string[]; readonly held: readonly { readonly id: string; readonly why: string }[] } | null;
  /** Things a person must decide, by slice or ticket (human.required). */
  readonly attention: Readonly<Record<string, { readonly reason: string; readonly at: number; readonly seq: number }>>;
}

export interface WaveState {
  readonly id: string;
  readonly title: string;
  readonly epicTitle: string;
  readonly revision: number | null;
  readonly sliceIds: readonly string[];
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly state: "discovered" | "validated";
  readonly discoveredAt: number;
  readonly seq: number;
}

export interface SliceState {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly waveId: string;
  readonly revision: number | null;
  readonly risk: Risk;
  readonly ticketId: string;
  readonly dependsOn: readonly string[];
  readonly scheduler: SchedulerState;
  /** The scheduler's own reasons, as intake.py writes them. */
  readonly reasons: readonly string[];
  readonly since: number;
  readonly integratedCommit: string | null;
  readonly history: readonly { readonly state: SchedulerState; readonly at: number; readonly seq: number }[];
}

export interface DependencyState {
  readonly id: string;
  /** The slice that waits. */
  readonly from: string;
  /** The slice it waits for. */
  readonly to: string;
  readonly state: "blocking" | "satisfied";
  readonly satisfiedAt: number | null;
  readonly satisfiedSeq: number | null;
}

export interface StationVisit {
  readonly station: StationId;
  readonly action: StepAction;
  readonly round: number;
  readonly enteredAt: number;
  readonly enteredSeq: number;
  readonly leftAt: number | null;
  readonly outcome: StationOutcome | null;
}

export interface TaskState {
  readonly id: string;
  readonly kind: TaskKind;
  readonly text: string;
  readonly files: readonly string[];
  readonly ids: readonly string[];
  readonly loop: number;
  readonly status: "active" | "red" | "green" | "done";
  readonly startedAt: number;
  readonly doneAt: number | null;
  readonly commit: string | null;
}

export interface TestRun {
  readonly context: string;
  readonly command: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly seconds: number;
  readonly at: number;
  readonly taskId: string | null;
}

export interface VerificationCheck {
  readonly targetId: string;
  readonly targetKind: TargetKind;
  readonly title: string;
  readonly result: "pending" | "pass" | "fail";
  readonly evidence: readonly string[];
  readonly note: string | null;
  readonly at: number | null;
}

export interface VerificationState {
  readonly round: number;
  readonly status: "running" | VerificationStatus;
  readonly startedAt: number;
  readonly decidedAt: number | null;
  readonly checks: readonly VerificationCheck[];
  readonly requiredEvidence: readonly string[];
}

export interface FindingState {
  readonly id: string;
  readonly round: number;
  readonly seat: ReviewSeat;
  readonly severity: "blocker" | "note";
  readonly title: string;
  readonly rule: string | null;
  readonly file: string | null;
  readonly at: number;
  /** Set when the round is decided: a blocker that did not stop an approval. */
  readonly outvoted: boolean;
}

export interface SeatState {
  readonly seat: ReviewSeat;
  readonly model: ModelId;
  readonly agentId: string | null;
  readonly vote: "APPROVE" | "REJECT" | null;
  readonly votedAt: number | null;
}

export interface ReviewRoundState {
  readonly round: number;
  readonly risk: Risk;
  readonly approvalsNeeded: number;
  readonly humanApprovalRequired: boolean;
  readonly humanApprovalReasons: readonly string[];
  readonly delta: { readonly sinceCommit: string; readonly filesChanged: readonly string[]; readonly earlierBlockerFiles: readonly string[] } | null;
  readonly seats: readonly SeatState[];
  readonly findings: readonly FindingState[];
  readonly startedAt: number;
  readonly outcome: ReviewOutcome | null;
  readonly decidedAt: number | null;
  readonly approvals: number | null;
  readonly overruledBlockersFrom: readonly ReviewSeat[];
  readonly humanApproval: { readonly by: string; readonly note: string | null; readonly at: number } | null;
}

export interface ToolCallState {
  readonly id: string;
  readonly agentId: string;
  readonly ticketId: string;
  readonly tool: ToolName;
  readonly target: string;
  readonly startedAt: number;
  readonly startedSeq: number;
  readonly finishedAt: number | null;
  readonly status: "running" | "ok" | "error";
  readonly summary: string | null;
  readonly artifactIds: readonly string[];
}

export interface AgentState {
  readonly id: string;
  readonly ticketId: string;
  readonly executionId: string | null;
  readonly role: AgentRole;
  readonly agentType: string | null;
  readonly seat: ReviewSeat | null;
  readonly tier: ModelTier;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly label: string;
  readonly parentId: string | null;
  readonly phase: BeltPhase;
  readonly station: StationId | null;
  readonly status: "running" | "done" | "error";
  readonly startedAt: number;
  readonly startedSeq: number;
  readonly finishedAt: number | null;
  readonly summary: string | null;
  readonly currentToolCallId: string | null;
  readonly toolCalls: readonly ToolCallState[];
}

export interface ArtifactState {
  readonly id: string;
  readonly ticketId: string;
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly label: string;
  readonly station: StationId | null;
  readonly round: number | null;
  readonly version: number;
  readonly sha: string | null;
  readonly summary: string;
  readonly writer: { readonly agentId: string | null; readonly callId: string | null; readonly script: string | null };
  readonly writtenAt: number;
  readonly seq: number;
}

export interface CellState {
  readonly ticketId: string;
  readonly sliceId: string;
  readonly title: string;
  readonly risk: Risk;
  readonly appType: AppType;
  readonly branch: string;
  readonly stage: CellStage;
  /** What the supervisor last saw (station.observed); lags `stage` by up to one tick. */
  readonly observedStage: CellStage | null;
  readonly stageHistory: readonly { readonly stage: CellStage; readonly at: number; readonly seq: number; readonly by: string }[];
  readonly station: StationId | null;
  readonly action: StepAction | null;
  readonly stationSince: number | null;
  readonly visits: readonly StationVisit[];
  /** Judging round, 1 to 3 (build loop + 1). */
  readonly round: number;
  readonly loop: number;
  readonly executionId: string | null;
  readonly workflowPhase: BeltPhase | null;
  readonly suite: "unknown" | "green" | "red";
  readonly lastTest: TestRun | null;
  readonly testsRun: number;
  readonly tasks: readonly TaskState[];
  readonly verifications: readonly VerificationState[];
  readonly reviews: readonly ReviewRoundState[];
  readonly agents: Readonly<Record<string, AgentState>>;
  /** Agent IDs in start order. */
  readonly agentOrder: readonly string[];
  readonly activeAgentIds: readonly string[];
  readonly artifacts: readonly ArtifactState[];
  readonly merged: { readonly commit: string; readonly at: number; readonly revalidated: boolean } | null;
  readonly archived: { readonly archive: string; readonly at: number } | null;
  readonly openedAt: number;
}

export interface ExecutionState {
  readonly id: string;
  readonly ticketId: string;
  readonly sliceId: string | null;
  readonly state: "claimed" | "running" | "completed" | "failed";
  readonly attempt: number;
  readonly next: StepAction;
  readonly stageAtStart: CellStage | null;
  readonly sessionId: string | null;
  readonly workflow: string | null;
  readonly workflowRunning: boolean;
  readonly phase: BeltPhase | null;
  readonly claimedAt: number;
  readonly startedAt: number | null;
  readonly workflowFinishedAt: number | null;
  readonly endedAt: number | null;
  readonly outcome: { readonly stage: CellStage | null; readonly next: StepAction; readonly waitingFor: string | null; readonly costUsd: number } | null;
}

export interface GateState {
  readonly id: string;
  readonly ticketId: string;
  readonly gate: GateKind;
  readonly round: number | null;
  readonly state: "open" | "passed" | "failed" | "waiting" | "skipped";
  readonly detail: string;
  readonly openedAt: number;
  readonly decidedAt: number | null;
  readonly seq: number;
}

export interface Counters {
  readonly events: number;
  readonly agentsActive: number;
  readonly agentsStarted: number;
  readonly toolCallsActive: number;
  readonly toolCalls: number;
  readonly artifacts: number;
  readonly commits: number;
  readonly testRuns: number;
  readonly checksPassed: number;
  readonly checksFailed: number;
  readonly verificationFailures: number;
  readonly reviewRounds: number;
  readonly blockers: number;
  readonly notes: number;
  readonly humanApprovals: number;
  readonly merged: number;
  readonly integrated: number;
  readonly executionsRunning: number;
  readonly costUsd: number;
}

/**
 * The data shapes of the simulation: the fixture, entity references, and the scene that
 * sceneAt(fixture, t) returns. Everything is plain, serialisable data. Scene objects are frozen by
 * convention (never mutate them): the engine shares unchanged parts between moments.
 */
import type { AnySimEvent, FactoryLimits, ReviewOutcome, StationOutcome, TargetKind, VerificationStatus } from "./events";
import type { Authority, Completeness, EntityMeta, SceneProvenance } from "./provenance";
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
  "actor",
  // The kinds the contract adds (5.2). Live and replay make them; the simulation does not.
  "project",
  "workflow",
  "visit",
  "seat",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * The kinds only real history makes (contract 5.2): a project, a Dynamic Workflow, one station
 * visit, one review seat. They are ordinary EntityKinds since M6.2's second wave; the list is kept
 * for code that asks "is this a kind the simulation never makes?".
 */
export const LIVE_ENTITY_KINDS = ["project", "workflow", "visit", "seat"] as const;
export type LiveEntityKind = (typeof LIVE_ENTITY_KINDS)[number];
/** A reference of one of the live-only kinds. Every LiveRef is an EntityRef. */
export type LiveRef = `${LiveEntityKind}:${string}`;
/** Kept for compatibility: every reference is an EntityRef now. */
export type AnyEntityRef = EntityRef;

/**
 * One string names any selectable thing: `<kind>:<id>`.
 * - `wave:WAVE-007`, `slice:SLICE-021`, `cell:LOCAL-031`, `execution:x1a2b3c4d5e6f`
 * - `station:LOCAL-031/build` (a station as one cell visits it) or `station:build` (the station itself)
 * - `agent:ag-031-07`, `tool:tc-031-0042`, `artifact:LOCAL-031:plan.md`
 * - `gate:LOCAL-031/review#2` (round-numbered gates: verification, review), `gate:LOCAL-031/audit`
 * - `dependency:SLICE-024->SLICE-021` (the first waits for the second)
 * - `finding:LOCAL-032/r1/security/1`
 * - `actor:supervisor`, `actor:scheduler`
 * - live only: `visit:LOCAL-031/build#2`, `seat:LOCAL-031/review#2/security`,
 *   `workflow:<execution>/<task>`, `project:<id>`
 *
 * Agent and tool ids are opaque (contract 5.2): `agent:<execution>/<agentId>` in production. Nothing
 * may parse meaning out of them; read the agent's ticket, station and seat from the scene.
 */
export type EntityRef = `${EntityKind}:${string}`;

/**
 * The supervisor and the scheduler: `actor:supervisor`, `actor:scheduler`. An EntityRef of kind
 * "actor", narrowed to the two actors. See README section 2, "Actors".
 */
export type ActorRef = `actor:${ActorId}`;
/** Everything that has an identity in the record. */
export type AnyRef = EntityRef | ActorRef;
export function isActorRef(value: string): value is ActorRef {
  return value === "actor:supervisor" || value === "actor:scheduler";
}

export function refKind(ref: EntityRef): EntityKind {
  return ref.slice(0, ref.indexOf(":")) as EntityKind;
}
export function refId(ref: AnyRef): string {
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
  actor: (id: ActorId): ActorRef => `actor:${id}`,
  visit: (visitId: string): EntityRef => `visit:${visitId}`,
  seat: (ticketId: string, round: number, seat: string): EntityRef => `seat:${ticketId}/review#${round}/${seat}`,
  workflow: (workflowId: string): EntityRef => `workflow:${workflowId}`,
  project: (id: string): EntityRef => `project:${id}`,
};

/**
 * The parts of MACH that act in the event record without being Claude agents:
 * - `supervisor`: the line supervisor (skills/run/scripts/supervisor.py), which ticks, observes
 *   stages, claims and starts executions, records their end, and decides what to start;
 * - `scheduler`: intake's dependency-aware plan and dispatch (intake.py Factory.plan, record,
 *   open_cell), which decides what is ready, what waits and why, records integration, and opens cells.
 */
export const ACTORS = ["supervisor", "scheduler"] as const;
export type ActorId = (typeof ACTORS)[number];

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
  /** Where this scene comes from: live, replay or simulation. The same object for every scene of one log. */
  readonly provenance: SceneProvenance;
  /** How complete its history is up to this moment: complete, partial (gaps, late beginnings) or reconstructed (snapshot). */
  readonly completeness: Completeness;
  /** How many events are applied (events[0 .. cursor-1]). */
  readonly cursor: number;
  /** `t` of the last applied event (0 before any). Simulation: ms from the scenario start; live and replay: the event's `order_ms`. */
  readonly at: number;
  /** Simulation: the event's seq. Live and replay: the event's delivery position (`pos`); link by `lastEventId`, never by this. */
  readonly lastSeq: number | null;
  /** Id of the last applied event (`sim:<seq>` for the simulation). */
  readonly lastEventId: string | null;
  readonly project: ProductDefinitions["project"];
  readonly factory: FactoryState;
  readonly supervisor: SupervisorState;
  readonly waves: Readonly<Record<string, WaveState>>;
  readonly slices: Readonly<Record<string, SliceState>>;
  readonly dependencies: Readonly<Record<string, DependencyState>>;
  readonly cells: Readonly<Record<string, CellState>>;
  readonly executions: Readonly<Record<string, ExecutionState>>;
  readonly gates: Readonly<Record<string, GateState>>;
  /** The supervisor and the scheduler: who they are and when they last acted. */
  readonly actors: Readonly<Record<ActorId, ActorState>>;
  readonly counters: Counters;
  /**
   * Live only: agents seen in an execution whose cell is not in the scene (its ticket is not known,
   * or its cell has not been seen). Kept so they can be selected; never placed in a cell by guessing.
   */
  readonly strayAgents: Readonly<Record<string, AgentState>>;
  /**
   * Live: recorded waits for an execution place (capacity.wait_changed, `waiting`), by ticket, held
   * whether or not the ticket's cell or execution is in the scene. Released waits are removed.
   */
  readonly capacityWaits: Readonly<Record<string, CapacityWaitState>>;
}

/** A recorded wait for an execution place (contract 10.6, `capacity.wait_changed`; reconstructed). */
export interface CapacityWaitState {
  readonly ticketId: string;
  readonly sliceId: string | null;
  readonly executionId: string | null;
  readonly scope: string;
  readonly limit: number | null;
  readonly since: number;
  readonly eventId: string;
  readonly late: boolean;
}

export interface ActorState {
  readonly id: ActorId;
  readonly title: string;
  /** The real code that acts: file and functions. */
  readonly code: string;
  /** Events this actor has written so far. */
  readonly acts: number;
  readonly lastActedAt: number | null;
  readonly lastSeq: number | null;
  readonly lastKind: string | null;
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
  /** factory.paused / factory.resumed. */
  readonly paused: boolean;
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
  readonly meta: EntityMeta;
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
  readonly meta: EntityMeta;
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
  readonly meta: EntityMeta;
}

export interface StationVisit {
  readonly station: StationId;
  readonly action: StepAction;
  readonly round: number;
  readonly enteredAt: number;
  readonly enteredSeq: number;
  readonly leftAt: number | null;
  readonly outcome: StationOutcome | null;
  /** Live: the lifecycle visit id (`<ticket>/<station>#<n>`), the `visit:` ref's id. Simulation: null. */
  readonly visitId: string | null;
  /** Live: the station's own outcome word, verbatim (`built`, `PASS`, `APPROVED`, a merge error code...); `outcome` is its mapping. */
  readonly outcomeWord: string | null;
  /** Live: the measured duration from station.exited (same clock as its entry). Null while open or when not recorded. */
  readonly durationMs: number | null;
  /** Live: the execution its entry record names (`ids.execution_id`); null when none (groom, hand-driven). */
  readonly executionId: string | null;
  /**
   * Live: the visit never exited, and the scene closed it (D4): the cell's next entry recorded it as
   * an `unclosed_visit` (`superseded`), or its execution ended (`execution-ended`). `leftAt` is then
   * the bound (`at`), `outcome` is "stopped", `outcomeWord` null, `meta.end` "inferred" and the
   * authority reconstructed. Never "still working". Null when an exit record closed it, or while open.
   */
  readonly unclosed: { readonly reason: "superseded" | "execution-ended"; readonly at: number; readonly eventId: string } | null;
  readonly meta: EntityMeta;
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
  /** Live: no record says when a task started (contract 11, `task.started` has no source); `startedAt` is then its completion and `meta.unknown` lists it. */
  readonly meta: EntityMeta;
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
  /**
   * The list of targets to prove, when one was received (`verify.targets_listed`, reconstructed by
   * the observer from spec.json; the simulation's `verification.started`). Checks still `pending`
   * are then "expected" as a fact; without it, nothing is expected.
   */
  readonly listed: { readonly eventId: string; readonly authority: Authority; readonly count: number; readonly late: boolean } | null;
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
  readonly meta: EntityMeta;
}

export interface SeatState {
  readonly seat: ReviewSeat;
  readonly model: ModelId;
  readonly agentId: string | null;
  readonly vote: "APPROVE" | "REJECT" | null;
  readonly votedAt: number | null;
  /** The verdict's event (`review.verdict_submitted`; simulation `review.vote`), and whether it arrived late. */
  readonly votedEventId: string | null;
  readonly votedLate: boolean;
}

export interface ReviewRoundState {
  readonly round: number;
  readonly risk: Risk;
  readonly approvalsNeeded: number;
  readonly humanApprovalRequired: boolean;
  readonly humanApprovalReasons: readonly string[];
  readonly delta: { readonly sinceCommit: string; readonly filesChanged: readonly string[]; readonly earlierBlockerFiles: readonly string[] } | null;
  /** Live: whether this round is a delta review (the lifecycle log records only the flag; `delta` stays null). */
  readonly isDelta: boolean;
  readonly seats: readonly SeatState[];
  readonly findings: readonly FindingState[];
  readonly startedAt: number;
  readonly outcome: ReviewOutcome | null;
  readonly decidedAt: number | null;
  readonly approvals: number | null;
  readonly overruledBlockersFrom: readonly ReviewSeat[];
  readonly humanApproval: { readonly by: string; readonly note: string | null; readonly at: number; readonly eventId: string; readonly late: boolean } | null;
  /** The event that started the round (its seats exist from it), and whether it arrived late. */
  readonly eventId: string;
  readonly late: boolean;
  /** The decision's event, and whether it arrived late. */
  readonly decidedEventId: string | null;
  readonly decidedLate: boolean;
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
  /** The honest result: `unknown` when the call was still open when its execution ended (an observer closing). `status` is its legacy projection. */
  readonly result: "running" | "ok" | "error" | "unknown";
  readonly summary: string | null;
  readonly artifactIds: readonly string[];
  /** The tool's own name as recorded (`tool` is its mapping onto the simulation's vocabulary). */
  readonly toolName: string;
  readonly meta: EntityMeta;
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
  /**
   * Per-call tool activity. Only when `observation` is "per-call" (the simulation, a main loop, an
   * Agent-tool sub-agent). For a Dynamic Workflow agent it is empty and says nothing: its calls are
   * not observable (contract D13, 8.1); read `toolCallCount` and `lastTool`.
   */
  readonly toolCalls: readonly ToolCallState[];
  // ---- added in M6.2
  /** The honest status: queued, running, done, error, or ended with no closing record (`unknown`). `status` is its legacy projection. */
  readonly lifecycle: "queued" | "running" | "done" | "error" | "unknown";
  /** How its tools are known: each call (`per-call`) or only a count and the last tool's name (`count-only`). */
  readonly observation: "per-call" | "count-only";
  /** How many tool calls it has made, when known (null: not reported yet). For `per-call` agents, toolCalls.length. */
  readonly toolCallCount: number | null;
  /** The name of the last tool a snapshot reported (count-only), or of the last call (per-call). */
  readonly lastTool: string | null;
  /** One token total, as reported. No split, no cost (contract 8.1). Null when not reported. */
  readonly tokens: number | null;
  /** Measured duration once finished (agent.finished duration_ms). */
  readonly durationMs: number | null;
  /** Tools this agent was refused, by name, in order. */
  readonly refused: readonly string[];
  /** Live: the workflow it ran in (`workflow:` ref id) and its index there. */
  readonly workflowId: string | null;
  readonly index: number | null;
  /** The model as recorded (`claude-sonnet-5-5`, `sonnet`); `model` is its mapping onto the four tiers. */
  readonly modelName: string | null;
  readonly meta: EntityMeta;
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
  /** Live: what the observer recorded (artifact.recorded). Simulation: null. */
  readonly record: { readonly nature: string; readonly integrity: string; readonly bytes: number | null; readonly mediaType: string | null; readonly commit: string | null } | null;
  readonly meta: EntityMeta;
}

/** The facts the plan station fixed for a cell (D11), and the record they came from. */
export interface PlanFacts {
  readonly appType: string | null;
  readonly risk: Risk | null;
  readonly contracts: number | null;
  readonly tasks: number | null;
  /** The plan exit's event id (or the observer's `recorded_by`), null when seeded without one. */
  readonly eventId: string | null;
  readonly authority: Authority;
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
  /** `artifact.recorded` records received for the cell (a path recorded again counts again); `artifacts` holds the distinct ones. */
  readonly artifactRecords: number;
  /**
   * Live: what the plan station fixed (schema revision 2: `station.exited` of the plan carries
   * `app_type` and `risk`, its counts `contracts` and `tasks`; the observer's `/cells/{t}` `plan`).
   * Null until a plan exit (or the observer's summary) is received; each part null when not recorded.
   */
  readonly plan: PlanFacts | null;
  readonly merged: { readonly commit: string; readonly at: number; readonly revalidated: boolean } | null;
  readonly archived: { readonly archive: string; readonly at: number } | null;
  readonly openedAt: number;
  // ---- added in M6.2
  /** Live: the cell's generation (`ids.cell_instance`). */
  readonly cellInstance: string | null;
  /** Live: every gate evaluation the lifecycle log recorded, in order (`gate.evaluated`), including refusals M6.0 could not show. */
  readonly gateLog: readonly GateEvaluation[];
  /** Live: a recorded wait for an execution place (capacity.wait_changed); null when none is recorded. */
  readonly capacityWait: { readonly since: number; readonly limit: number | null; readonly eventId: string } | null;
  /** Live: the run record cleanup wrote (run.recorded): the cell's authoritative completion. */
  readonly runRecord: { readonly outcome: "merged" | "abandoned"; readonly rounds: number | null; readonly firstPass: boolean; readonly at: number } | null;
  /** Live: where this cell's history begins when it begins part-way (history.began). */
  readonly historyBegan: { readonly reason: string; readonly at: number } | null;
  readonly meta: EntityMeta;
}

export interface GateEvaluation {
  readonly gate: string;
  readonly verdict: "passed" | "refused" | "overridden";
  readonly reasonCode: string | null;
  readonly subject: string | null;
  readonly round: number | null;
  readonly at: number;
  readonly eventId: string;
  readonly late: boolean;
  /**
   * The gate state this evaluation set (`scene.gates` id), or null when no gate state stands for it
   * (a refused `build.start`, `verify.start`, `merge.run`, the round limit...): such an evaluation is
   * still a recorded fact, read with `gateRefusals`.
   */
  readonly gateId: string | null;
}

/** An agent a workflow has queued but not started: known by its index only (contract 5.2). */
export interface QueuedAgentState {
  readonly index: number;
  readonly label: string;
  readonly phase: string | null;
  readonly modelName: string | null;
  readonly ticketId: string | null;
  readonly queuedAt: number;
  readonly eventId: string;
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
  // ---- added in M6.2 (live; the simulation leaves them empty)
  /** The process's own start and end (execution.process_started / _ended), measured to the second. */
  readonly processStartedAt: number | null;
  readonly processEndedAt: number | null;
  readonly ended: "exited" | "timed-out" | "interrupted" | "could-not-start" | null;
  readonly exitCode: number | null;
  /** The supervisor's recovery kind, when it recovered this execution (recovery.started). */
  readonly recovery: string | null;
  /** The Dynamic Workflow it ran: its `workflow:` ref id and recorded status (`completed` only from task_updated, D14). */
  readonly workflowId: string | null;
  readonly workflowStatus: "running" | "completed" | "killed" | "unknown" | null;
  readonly stopReason: "budget" | "unknown" | null;
  /** The declared phase list (not phases entered: those are not observable). */
  readonly phases: readonly string[];
  /** Agents queued and not yet started, by index. */
  readonly queued: Readonly<Record<string, QueuedAgentState>>;
  /** Recorded spend (execution.usage); never per agent. */
  readonly usage: {
    readonly costUsd: number | null;
    readonly budgetExhausted: boolean;
    readonly terminalReason: string | null;
    /** The stream's own verdict (execution.usage.cost_complete): false when the spend may be under-reported; null when the record does not say (before schema revision 1). */
    readonly costComplete: boolean | null;
    /** Why it may be incomplete, as recorded (`budget-stop`, `agents-killed-in-flight`). */
    readonly costIncompleteReasons: readonly string[];
    /** The `execution.usage` event. */
    readonly eventId: string;
  } | null;
  readonly claudeCodeVersion: string | null;
  readonly refused: readonly { readonly tool: string; readonly agentId: string | null; readonly at: number }[];
  /** A recorded wait for an execution place (capacity.wait_changed, reconstructed from the scheduler's decision). */
  readonly capacityWait: { readonly since: number; readonly limit: number | null } | null;
  /** Live: what is known of its stream (agents, tools): see StreamObservation. */
  readonly observation: StreamObservation;
  /** Live: the meta of its Dynamic Workflow's own records (workflow.*); null before one is seen. */
  readonly workflowMeta: EntityMeta | null;
  readonly meta: EntityMeta;
}

/**
 * What the execution's stream let the observer see (D7). Counts are of records received for it;
 * `runtime` is the last `origin.runtime_state` the observer stamped on them (null: an older observer).
 */
export interface StreamObservation {
  /** Stream records received (any kind). */
  readonly records: number;
  /** Records that describe agents, the workflow or tool calls. */
  readonly structural: number;
  readonly runtime: "proven" | "compatible-unproven" | "incompatible" | "unknown" | null;
  /** The Claude Code version its stream's `session.initialized` names. */
  readonly version: string | null;
}

export interface GateState {
  readonly id: string;
  readonly ticketId: string;
  readonly gate: GateKind;
  readonly round: number | null;
  /** `overridden`: the gate let the work through on a recorded override (its reason code in `reasonCode`); never the same as passed. */
  readonly state: "open" | "passed" | "failed" | "waiting" | "skipped" | "overridden";
  readonly detail: string;
  readonly openedAt: number;
  readonly decidedAt: number | null;
  readonly seq: number;
  /** Live: the reason code the gate recorded (gate.evaluated), when one exists. */
  readonly reasonCode: string | null;
  readonly meta: EntityMeta;
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

/**
 * The event model. The envelope is the real MACH Factory event, version 2
 * (docs/mach-next/schemas/factory-event.schema.json; intake.py Factory.emit), field for field.
 * Real kinds (`RealKind`) carry the `data` fields the real emitters write. Simulation kinds
 * (`SimKind`) are what the experience needs and MACH does not emit today; each is described, with
 * its telemetry status, in catalog.ts.
 */
import type {
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
  AgentRole,
  StationId,
  StepAction,
  TaskKind,
  ToolName,
} from "./vocabulary";

export const SCHEMA_VERSION = 2;

/** The 22 kinds in intake.py EVENT_TYPES, unchanged. */
export const REAL_KINDS = [
  "wave.discovered",
  "intake.validated",
  "intake.refused",
  "slice.materialized",
  "slice.integrated",
  "dependency.resolved",
  "dependency.blocked",
  "work.scheduled",
  "revision.superseded",
  "human.required",
  "factory.activated",
  "factory.disabled",
  "factory.paused",
  "factory.resumed",
  "revision.discovered",
  "scheduling.decided",
  "work.claimed",
  "execution.started",
  "station.observed",
  "recovery.started",
  "execution.completed",
  "execution.failed",
] as const;
export type RealKind = (typeof REAL_KINDS)[number];

/** Kinds the simulation adds. Not part of factory-event v2. */
export const SIM_KINDS = [
  "workflow.started",
  "workflow.phase",
  "workflow.finished",
  "station.entered",
  "station.left",
  "cell.stage_changed",
  "agent.started",
  "agent.finished",
  "tool.started",
  "tool.finished",
  "artifact.written",
  "gate.checked",
  "task.started",
  "task.red",
  "task.green",
  "task.done",
  "test.result",
  "build.revised",
  "verification.started",
  "evidence.captured",
  "verification.verdict",
  "review.started",
  "review.finding",
  "review.vote",
  "review.decided",
  "human.approval_recorded",
  "merge.revalidated",
  "merge.completed",
  "cleanup.completed",
] as const;
export type SimKind = (typeof SIM_KINDS)[number];

export type EventKind = RealKind | SimKind;
export type EventSource = "intake" | "engineer" | "supervisor";

export interface FactoryLimits {
  max_parallel: number;
  max_execution_minutes: number;
  max_runs_per_day: number;
  max_budget_usd_per_run: number;
  max_budget_usd_per_day: number;
  max_attempts: number;
  poll_seconds: number;
}

export type ReviewOutcome = "APPROVED" | "AWAITING_HUMAN" | "REJECTED" | "ESCALATE";
export type VerificationStatus = "PASS" | "FAIL_WITH_EVIDENCE" | "INCOMPLETE_EVIDENCE";
export type TargetKind = "scenario" | "matrix rule" | "holdout";
export type StationOutcome = "done" | "passed" | "failed" | "approved" | "rejected" | "awaiting-human" | "merged" | "archived" | "stopped";
export type TestContext = "baseline" | "red" | "green" | "done" | "finish" | "verify" | "revalidate";

/** `data` by kind. Real kinds: exactly the fields their emitter writes. */
export interface EventDataMap {
  // ---- real: intake and scheduling (intake.py) ----
  "wave.discovered": { slices: string[]; approval: { actor: string; approved_at: string } };
  "intake.validated": { digest: string };
  "intake.refused": { problems: string[] };
  "slice.materialized": { digest: string; adopted: boolean; dependencies: string[] };
  "slice.integrated": { commit: string };
  "dependency.resolved": { depends_on: string[] };
  "dependency.blocked": { reasons: string[] };
  "work.scheduled": { stage: CellStage; risk: Risk; branch: string; by: string; authorization: string };
  "revision.superseded": { from_revision: number | null; effect: string };
  "human.required": { reason: string };
  // ---- real: activation (activation.py) ----
  "factory.activated": {
    autonomy: "observe" | "supervised";
    by: string;
    limits: FactoryLimits;
    allow_merge: boolean;
    persistent: boolean;
    backlog: string | null;
    excluded_slices: string[];
  };
  "factory.disabled": { by: string; stopped: boolean };
  "factory.paused": { by: string; reason: string | null };
  "factory.resumed": { by: string; retrying: string[] };
  // ---- real: supervisor (supervisor.py) ----
  "revision.discovered": { from_commit: string | null; commit: string };
  "scheduling.decided": {
    state: "supervised" | "observe" | "paused";
    dispatched: string[];
    started: string[];
    held: Array<{ slice_id?: string; ticket_id?: string; why: string }>;
  };
  "work.claimed": { stage: CellStage | null; next: StepAction; attempt: number };
  "execution.started": { session_id: string; until: string | null; workflow: string; limits: { minutes: number; budget_usd: number } };
  "station.observed": { from_stage: CellStage | null; stage: CellStage };
  "recovery.started": { kind: string };
  "execution.completed": {
    stage: CellStage | null;
    next: StepAction;
    waiting_for: string | null;
    how: string;
    seen_to_end: boolean;
    cost_usd: number;
    session_id: string;
    refused_tools: string[];
  };
  "execution.failed": {
    stage: CellStage | null;
    next: StepAction;
    how: string;
    claude_error: string | null;
    exit_code: number | null;
    attempt: number;
    session_id: string;
  };

  // ---- simulation: the Dynamic Workflow ----
  "workflow.started": { workflow: string; args: string[]; until: string | null; phases: BeltPhase[]; session_id: string };
  "workflow.phase": { workflow: string; phase: BeltPhase };
  "workflow.finished": {
    workflow: string;
    tickets: Array<{ ticket: string; outcome: "stopped" | "stuck" | "error"; stage: CellStage | ""; waiting_for: string }>;
    learning: string;
  };
  // ---- simulation: stations and stages ----
  "station.entered": {
    station: StationId;
    action: StepAction;
    stage: CellStage | null;
    round: number;
    reason: string;
    agent_type: string | null;
    model: ModelId | null;
  };
  "station.left": { station: StationId; action: StepAction; outcome: StationOutcome; stage: CellStage | null; note: string };
  "cell.stage_changed": { from: CellStage | null; to: CellStage; by: string };
  // ---- simulation: agents and tools ----
  "agent.started": {
    agent_id: string;
    role: AgentRole;
    agent_type: string | null;
    seat: ReviewSeat | null;
    tier: ModelTier;
    model: ModelId;
    effort: Effort;
    label: string;
    parent_agent_id: string | null;
    phase: BeltPhase;
    station: StationId | null;
  };
  "agent.finished": { agent_id: string; outcome: "done" | "error"; summary: string };
  "tool.started": { call_id: string; agent_id: string; tool: ToolName; target: string };
  "tool.finished": { call_id: string; agent_id: string; ok: boolean; summary: string };
  "artifact.written": {
    artifact_id: string;
    kind: ArtifactKind;
    path: string;
    label: string;
    writer: { agent_id: string | null; call_id: string | null; script: string | null };
    station: StationId | null;
    round: number | null;
    version: number;
    sha: string | null;
    summary: string;
  };
  // ---- simulation: gates and the build ----
  "gate.checked": { gate: Extract<GateKind, "audit" | "plan-check">; passed: boolean; detail: string; tier: string | null; score: number | null };
  "task.started": { task_id: string; kind: TaskKind; text: string; files: string[]; ids: string[]; loop: number };
  "task.red": { task_id: string; commit: string; test_file: string; failing: number; note: string };
  "task.green": { task_id: string; commit: string; passed: number; note: string };
  "task.done": { task_id: string; commit: string; note: string };
  "test.result": {
    context: TestContext;
    command: string;
    passed: number;
    failed: number;
    skipped: number;
    seconds: number;
    exit_code: number;
    task_id: string | null;
  };
  "build.revised": { loop: number; round: number; rounds_left: number; findings: string; because: "verification" | "review" };
  // ---- simulation: verification ----
  "verification.started": {
    round: number;
    app_type: AppType;
    head: string;
    targets: Array<{ id: string; kind: TargetKind; title: string }>;
    required_evidence: string[];
  };
  "evidence.captured": { round: number; target_id: string; target_kind: TargetKind; result: "pass" | "fail"; evidence: string[]; note: string };
  "verification.verdict": { round: number; status: VerificationStatus; checks_passed: number; checks_failed: number; head: string; findings: string | null };
  // ---- simulation: review ----
  "review.started": {
    round: number;
    max_rounds: number;
    risk: Risk;
    approvals_needed: number;
    human_approval_required: boolean;
    human_approval_reasons: string[];
    panel: Array<{ role: ReviewSeat; model: ModelId }>;
    head: string;
    diff_stat: string;
    delta: { since_commit: string; files_changed: string[]; earlier_blocker_files: string[] } | null;
  };
  "review.finding": {
    round: number;
    seat: ReviewSeat;
    finding_id: string;
    severity: "blocker" | "note";
    title: string;
    rule: string | null;
    file: string | null;
  };
  "review.vote": { round: number; seat: ReviewSeat; vote: "APPROVE" | "REJECT"; blockers: number; notes: number; model: ModelId; head: string };
  "review.decided": {
    round: number;
    outcome: ReviewOutcome;
    approvals: number;
    approvals_needed: number;
    votes: Partial<Record<ReviewSeat, "APPROVE" | "REJECT">>;
    blockers: number;
    overruled_blockers_from: ReviewSeat[];
    security_veto: boolean;
    head: string;
    findings: string;
  };
  "human.approval_recorded": { round: number; by: string; note: string | null; head: string };
  // ---- simulation: merge and cleanup ----
  "merge.revalidated": { needed: boolean; onto: string | null; head: string; approved_commit: string; tests: string; passed: number; seconds: number; note: string };
  "merge.completed": { method: "local" | "pr"; into: string; merge_commit: string; approved_commit: string; landed_commit: string; revalidated: boolean };
  "cleanup.completed": { archive: string; outcome: "merged" | "abandoned"; rounds: number; first_pass: boolean; run_record: string };
}

/** The factory-event v2 envelope, typed by kind. */
export interface FactoryEvent<K extends EventKind = EventKind> {
  readonly schema_version: 2;
  readonly seq: number;
  /** UTC, whole seconds, `YYYY-MM-DDTHH:MM:SSZ`, as intake.now() writes it. */
  readonly at: string;
  readonly type: K;
  readonly project_id: string | null;
  readonly source_commit: string | null;
  readonly wave_id: string | null;
  readonly slice_id: string | null;
  readonly revision: number | null;
  readonly ticket_id: string | null;
  readonly runner_id: string | null;
  readonly execution_id: string | null;
  readonly source: EventSource;
  /** Seq of the event that led to this one. Real emitters never set it today; the simulation sets it on its own kinds. */
  readonly cause: number | null;
  readonly refs: Readonly<Record<string, string>> | null;
  readonly data: EventDataMap[K];
}

/**
 * A fixture event: the envelope plus `t`, milliseconds since the scenario's start. `t` is the
 * simulation's clock (the envelope's `at` has one-second resolution, as in MACH). It is the only
 * field that is not part of factory-event v2.
 */
export type SimEvent<K extends EventKind = EventKind> = FactoryEvent<K> & { readonly t: number };

/** The discriminated union: `switch (event.type)` narrows `event.data`. */
export type AnySimEvent = { [K in EventKind]: SimEvent<K> }[EventKind];

export function isKind<K extends EventKind>(event: AnySimEvent, kind: K): event is Extract<AnySimEvent, { type: K }> {
  return event.type === kind;
}

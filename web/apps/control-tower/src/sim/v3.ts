/**
 * Factory event version 3: the observer's normalised view (docs/mach-next/M6_1_EVENT_CONTRACT.md,
 * schema docs/mach-next/schemas/factory-event.v3.schema.json). The reducer takes these natively,
 * beside the simulation's v2-plus-`t` events (events.ts); both build the same Scene.
 *
 * Consumers are tolerant within version 3 (contract D12): an unknown kind is kept in the log, shown
 * as "an event this version does not understand", and not reduced; unknown fields are ignored.
 *
 * Two client-only kinds (`client.*`, ids `k:...`) mark what the client itself knows about its history:
 * a range it missed (its cursor fell below the observer's floor) and a snapshot it was seeded from.
 * They never come from the observer and never leave the browser.
 */
import type { AnySimEvent } from "./events";
import type { ObserverHistory } from "./provenance";
import type { CellStage, ReviewSeat, Risk, StationId, StepAction } from "./vocabulary";

export const V3_SCHEMA_VERSION = 3;

/** The 54 kinds of contract section 11, in its order. */
export const V3_KINDS = [
  // 11.1 intake log (22)
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
  // 11.2 cell lifecycle (11)
  "station.entered",
  "station.exited",
  "gate.evaluated",
  "build.task_completed",
  "verify.check_recorded",
  "review.round_started",
  "review.verdict_submitted",
  "review.decided",
  "human.approval_recorded",
  "merge.completed",
  "cleanup.completed",
  // 11.3 execution and run records (3)
  "execution.process_started",
  "execution.process_ended",
  "run.recorded",
  // 11.4 execution streams (12)
  "session.initialized",
  "workflow.started",
  "workflow.phases_declared",
  "workflow.finished",
  "agent.queued",
  "agent.started",
  "agent.progressed",
  "agent.finished",
  "tool.called",
  "tool.returned",
  "tool.refused",
  "execution.usage",
  // 11.5 observer (6)
  "review.finding",
  "artifact.recorded",
  "verify.targets_listed",
  "capacity.wait_changed",
  "history.began",
  "history.gap",
] as const;
export type V3Kind = (typeof V3_KINDS)[number];

export const CLIENT_KINDS = ["client.history_missing", "client.snapshot_applied"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export type V3Authority = "authoritative" | "observed" | "reconstructed";
export type Precision = "ms" | "s" | "arrival" | "bounded" | "unknown";
export type OriginStream = "intake-log" | "cell-lifecycle" | "execution-record" | "run-record" | "execution-stream" | "observer";
export type Writer = "intake" | "engineer" | "supervisor" | "station" | "executor" | "cleanup" | "claude" | "observer";

export interface V3Origin {
  readonly stream: OriginStream;
  readonly key: string;
  readonly seq: number | null;
  readonly part: number | null;
  readonly writer: Writer;
  readonly script: string | null;
  readonly source_version: string;
  /**
   * Execution streams (observer M6.2): the runtime version's state when the record was read:
   * `proven` (a version the parser was proved on), `compatible-unproven` (a newer version whose
   * records matched the known shapes), `incompatible`. Absent from older observers.
   */
  readonly runtime_state?: "proven" | "compatible-unproven" | "incompatible" | "unknown";
}

export interface V3Time {
  readonly occurred_at: string | null;
  readonly precision: Precision;
  readonly not_before: string | null;
  readonly not_after: string | null;
  readonly observed_at: string;
  readonly order_ms: number;
}

export interface V3Ids {
  readonly project_id: string | null;
  readonly wave_id: string | null;
  readonly slice_id: string | null;
  readonly revision: number | null;
  readonly ticket_id: string | null;
  readonly cell_instance: string | null;
  readonly execution_id: string | null;
  readonly runner_id: string | null;
  readonly visit_id: string | null;
  readonly station: StationId | null;
  readonly round: number | null;
  readonly attempt: number | null;
  readonly seat: ReviewSeat | null;
  readonly agent_id: string | null;
  readonly parent_agent_id: string | null;
  readonly tool_call_id: string | null;
}

type ByRole = "engineer" | "supervisor" | "person";
type Counts = Readonly<Record<string, number | boolean>>;
type Stage = CellStage | "spec-open";

/** `data` by kind, for the fields the client reads. The schema's `$defs` is exact. */
export interface V3DataMap {
  "wave.discovered": { slices: string[]; approval: { approved_at: string | null; by_role: ByRole } };
  "intake.validated": { digest: string };
  "intake.refused": { problems: string[] };
  "slice.materialized": { digest: string; adopted: boolean; dependencies: string[]; reissued?: boolean | null; /** M6.6: the intake ledger's title for this revision (free text), null when not recorded. */ title?: string | null };
  "slice.integrated": { commit: string };
  "dependency.resolved": { depends_on: string[] };
  "dependency.blocked": { reasons: string[] };
  "work.scheduled": { stage: Stage | null; risk: Risk | null; branch: string; by_role: ByRole; authorization: string | null };
  "revision.superseded": { from_revision: number | null; effect: string };
  "human.required": { reason: string };
  "factory.activated": { autonomy: "observe" | "supervised"; by_role: ByRole; limits: Readonly<Record<string, number>>; allow_merge: boolean; persistent: boolean; backlog: string | null; excluded_slices: string[] };
  "factory.disabled": { by_role: ByRole; stopped: boolean };
  "factory.paused": { by_role: ByRole; reason: string | null };
  "factory.resumed": { by_role: ByRole; retrying: string[] };
  "revision.discovered": { from_commit: string | null; commit: string };
  "scheduling.decided": { state: "supervised" | "observe" | "paused"; dispatched: string[]; started: string[]; held: Array<{ slice_id?: string | null; ticket_id?: string | null; why: string }> };
  "work.claimed": { stage: Stage | null; next: StepAction | null; attempt: number };
  "execution.started": { until: string | null; workflow: string; limits: Readonly<Record<string, number>> };
  "station.observed": { from_stage: Stage | null; stage: Stage };
  "recovery.started": { kind: "ended-while-unwatched" | "still-running" | "claim-never-started" | "outcome-unknown" | "took-over-from-dead-supervisor" };
  "execution.completed": { stage: Stage | null; next: StepAction | null; waiting_for: string | null; how: string | null; seen_to_end: boolean; cost_usd: number | null; refused_tools: string[] };
  "execution.failed": { stage: Stage | null; next: StepAction | null; how: string | null; claude_error: string | null; exit_code: number | null; attempt: number };
  "station.entered": { station: StationId; stage: Stage | null; action: StepAction | null; resumed: boolean; unclosed_visit: string | null; head: string | null; counts: Counts };
  /** Revision 2: on the plan's exit, `app_type` and `risk` (the plan's own facts); `counts.contracts` and `counts.tasks`. */
  "station.exited": { station: StationId; outcome: string; stage: Stage | null; duration_ms: number | null; closed_by: "cleanup" | null; head: string | null; counts: Counts; app_type?: string | null; risk?: Risk | null };
  "gate.evaluated": { gate: string; verdict: "passed" | "refused" | "overridden"; reason_code: string | null; subject: string | null; status: "PASS" | "FAIL_WITH_EVIDENCE" | "INCOMPLETE_EVIDENCE" | null; audit_tier: string | null; counts: Counts };
  "build.task_completed": { task_id: string; kind: "test" | "impl" | "contract" | "refactor" | "docs"; step: "red" | "green" | "done"; first_run: "pass" | "fail" | "not-run" | null; suite: "unknown" | "red" | "green" | null; commit: string | null };
  "verify.check_recorded": { target_id: string; target_kind: "scenario" | "matrix rule" | "holdout"; result: "pass" | "fail"; evidence: Array<{ file: string; sha256: string | null; bytes?: number | null }>; rerecorded: boolean };
  "review.round_started": { risk: Risk; max_rounds: number; tuning: boolean; approvals_needed: number; human_approval_required: boolean; panel: Array<{ seat: ReviewSeat; model: string | null }>; delta: boolean; restarted: boolean };
  "review.verdict_submitted": { seat: ReviewSeat; vote: "APPROVE" | "REJECT"; blockers: number; notes: number; rules: string[]; model: string | null };
  "review.decided": { outcome: "APPROVED" | "AWAITING_HUMAN" | "REJECTED" | "ESCALATE"; approvals: number; approvals_needed: number; votes: Readonly<Record<string, "APPROVE" | "REJECT">>; blockers: number; security_veto: boolean; human_approval_required: boolean };
  "human.approval_recorded": { by_role: "person"; note_given: boolean };
  "merge.completed": { method: "local" | "pr"; merge_commit: string | null; approved_commit: string | null; landed_commit: string | null; revalidated: boolean; pull_request: number | null };
  "cleanup.completed": { outcome: "merged" | "abandoned"; archive: string | null; bundle: boolean; uncommitted_saved: boolean };
  "execution.process_started": Record<string, never>;
  "execution.process_ended": { ended: "exited" | "timed-out" | "interrupted" | "could-not-start"; exit_code: number | null; seconds: number | null };
  "run.recorded": {
    record_version: number;
    outcome: "merged" | "abandoned";
    rounds: number | null;
    first_pass: boolean;
    verify_failures: number;
    review_rejections: number;
    escalated: boolean;
    human_approval: boolean;
    deviations: number;
    blockers: number;
    tests_seen_failing_first: number;
    tests_passing_on_first_run: number;
    risk: Risk | null;
    app_type: string | null;
    merge_method: "local" | "pr" | null;
    merge_commit: string | null;
  };
  "session.initialized": { claude_code_version: string | null; model: string | null; permission_mode: string | null; tools: string[]; agents: string[] };
  "workflow.started": { workflow: string; tickets: string[]; until: string | null };
  "workflow.phases_declared": { phases: Array<{ index: number; title: string }> };
  "workflow.finished": {
    status: "completed" | "killed" | "unknown";
    notification_status: string | null;
    total_tokens: number | null;
    tool_uses: number | null;
    duration_ms: number | null;
    stop_reason: "budget" | "unknown" | null;
    workflow_json: boolean;
    tickets: Array<{ ticket: string; outcome: string | null; stage: string | null; waiting_for: string | null; stations: string[] }>;
  };
  "agent.queued": { index: number; label: string; phase: string | null; phase_index: number | null; model: string | null };
  "agent.started": { index: number; label: string; phase: string | null; phase_index: number | null; agent_type: string | null; model: string | null; agent_try: number | null };
  "agent.progressed": { tool_calls: number | null; tokens: number | null; last_tool: string | null };
  "agent.finished": { status: "done" | "error" | "unknown"; duration_ms: number | null; tokens: number | null; tool_calls: number | null };
  "tool.called": { tool: string; target_class: string; script: string | null; path_rel: string | null };
  "tool.returned": { status: "ok" | "error" | "unknown"; duration_ms: number | null };
  "tool.refused": { tool: string; summary: string };
  "execution.usage": {
    total_cost_usd: number | null;
    subtype: string | null;
    is_error: boolean | null;
    terminal_reason: string | null;
    budget_exhausted: boolean;
    models: Readonly<Record<string, { cost_usd?: number | null; input_tokens?: number | null; output_tokens?: number | null }>>;
    /** Schema revision 1: the stream's own verdict on whether the reported spend is all of it, and why not. Absent before revision 1. */
    cost_complete?: boolean | null;
    cost_incomplete_reasons?: string[] | null;
  };
  "review.finding": { seat: ReviewSeat; n: number; severity: "blocker" | "note"; rule: string | null; file_rel: string | null; title: string };
  "artifact.recorded": { kind: string; path_rel: string; sha256: string | null; bytes: number | null; media_type: string | null; commit: string | null; nature: "evidence" | "record" | "code" | "prose"; integrity: "match" | "mismatch" | "missing" | "unchecked" };
  "verify.targets_listed": { targets: Array<{ id: string; kind: "scenario" | "matrix rule" | "holdout" }>; source: "spec.json" };
  "capacity.wait_changed": { state: "waiting" | "released"; scope: "execution"; limit: number | null };
  "history.began": { reason: string; snapshot: { stage?: string | null; round?: number | null; station?: string | null; state?: string | null } };
  "history.gap": {
    source_key: string;
    from_seq: number | null;
    to_seq: number | null;
    /** The precise cause (missing-seq, truncated, rewritten, unparsable-line, unknown-type, unexpected-shape, state-mismatch, conflict, unreadable, evicted). */
    reason: string;
    count: number | null;
    /** Observer M6.2: the class (not-received, unparsable-line, unknown-type, state-mismatch, evicted, source-unreadable, conflict) and whether history was lost. Absent from older observers. */
    class?: string;
    history_lost?: boolean;
  };
  // ---- client-only
  "client.history_missing": { reason: "expired" | "reset" | "window"; after: string | null; resumed_at: string | null };
  "client.snapshot_applied": { cursor: string; generation: string; state: ObserverSnapshotState };
}

/**
 * What the observer's `GET /api/v1/snapshot` returns as `state` (M6_1_OBSERVER_DESIGN.md section 10).
 * Not yet built by the observer; read tolerantly: every part optional, unknown fields ignored.
 */
export interface ObserverSnapshotState {
  readonly factory?: { readonly enabled?: boolean; readonly paused?: boolean; readonly autonomy?: "observe" | "supervised" | null } | null;
  readonly waves?: ReadonlyArray<{ readonly wave_id: string; readonly slices?: readonly string[]; readonly revision?: number | null }>;
  readonly slices?: ReadonlyArray<{ readonly slice_id: string; readonly ticket_id?: string | null; readonly state?: string | null; readonly dependencies?: readonly string[]; readonly revision?: number | null; readonly title?: string | null }>;
  readonly cells?: ReadonlyArray<{
    readonly ticket_id: string;
    readonly slice_id?: string | null;
    readonly stage?: string | null;
    readonly risk?: string | null;
    readonly current_visit?: string | null;
    readonly rounds?: number | null;
    /** Observer M6.2: the cell's app type, and the plan's facts (`plan {app_type, risk, contracts, tasks, recorded_by}`). */
    readonly app_type?: string | null;
    readonly plan?: { readonly app_type: string | null; readonly risk: string | null; readonly contracts: number | null; readonly tasks: number | null; readonly recorded_by: string | null } | null;
  }>;
  readonly executions?: ReadonlyArray<{ readonly execution_id: string; readonly ticket_id?: string | null; readonly state?: string | null; readonly attempt?: number | null }>;
  readonly gates?: ReadonlyArray<{ readonly ticket_id: string; readonly gate: string; readonly round?: number | null; readonly state?: string | null }>;
  /** Observer M6.2 (`state.history`): how complete the observer's history is, by gap class. */
  readonly history?: ObserverHistory | null;
}

/** One v3 event, typed by kind. */
export interface FactoryEventV3<K extends V3Kind | ClientKind = V3Kind | ClientKind> {
  readonly schema_version: 3;
  readonly schema_revision: number;
  readonly id: string;
  readonly type: K;
  readonly pos: number;
  readonly origin: V3Origin;
  readonly authority: V3Authority;
  readonly time: V3Time;
  readonly order: string;
  readonly ids: V3Ids;
  readonly entities: readonly string[];
  readonly parent: string | null;
  readonly cause: { readonly event_id: string; readonly basis: "recorded" | "identity" } | null;
  readonly artifacts: ReadonlyArray<{ readonly ref: string; readonly sha256: string | null; readonly commit: string | null }>;
  readonly unknown: readonly string[];
  readonly inferred: Readonly<Record<string, string>>;
  readonly provenance: { readonly basis: readonly string[]; readonly rule: string; readonly files: readonly string[] } | null;
  readonly late: boolean;
  readonly withheld: number;
  readonly data: V3DataMap[K];
}

/** The discriminated union the reducer switches on. */
export type AnyV3Event = { [K in V3Kind | ClientKind]: FactoryEventV3<K> }[V3Kind | ClientKind];

/**
 * A v3 event of a kind this client does not know (a later revision within version 3). Kept in the
 * log and the entity index, never reduced.
 */
export interface UnknownV3Event extends Omit<FactoryEventV3<V3Kind>, "type" | "data"> {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const KNOWN = new Set<string>([...V3_KINDS, ...CLIENT_KINDS]);
export function isKnownV3Kind(type: string): type is V3Kind | ClientKind {
  return KNOWN.has(type);
}

const ORDER_RE = /^[0-9]{15}~[0-9]~[^~]+~[0-9]{12}~[0-9]{4}$/;
const REF_RE = /^(project|workflow|wave|slice|cell|station|visit|execution|agent|tool|artifact|gate|dependency|finding|seat|actor):.+$/;

/**
 * Check the envelope of one received event, tolerantly: the fields the engine relies on must be
 * there and well formed; everything else is taken as it comes. Returns null for anything that is
 * not a version 3 event (the caller counts it as refused).
 */
export function parseV3(value: unknown): AnyV3Event | UnknownV3Event | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (e.schema_version !== 3 || typeof e.id !== "string" || typeof e.type !== "string" || typeof e.order !== "string" || !ORDER_RE.test(e.order)) return null;
  const time = e.time as Record<string, unknown> | undefined;
  if (!time || typeof time.order_ms !== "number" || !Number.isFinite(time.order_ms)) return null;
  if (!e.ids || typeof e.ids !== "object" || !Array.isArray(e.entities) || !e.data || typeof e.data !== "object") return null;
  if (typeof e.pos !== "number") return null;
  return value as AnyV3Event | UnknownV3Event;
}

export function isEntityRefString(value: string): boolean {
  return REF_RE.test(value);
}

/** Milliseconds of `time.occurred_at`, or null when not known. */
export function occurredMs(event: Pick<FactoryEventV3, "time">): number | null {
  const at = event.time.occurred_at;
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a v3 time is a measurement (a record carried it) or a placement. */
export function timeQualityOf(precision: Precision): "measured" | "inferred" {
  return precision === "ms" || precision === "s" ? "measured" : "inferred";
}

// ---------------------------------------------------------------- what the engine takes

/** Anything the engine can apply: a simulation event (v2 + `t`) or a version 3 event (known or not). */
export type EngineEvent = AnySimEvent | AnyV3Event | UnknownV3Event;

export function isV3(event: EngineEvent): event is AnyV3Event | UnknownV3Event {
  return event.schema_version === 3;
}

/** The event's id: its own for v3, `sim:<seq>` for the simulation. */
export function eventIdOf(event: EngineEvent): string {
  return isV3(event) ? event.id : `sim:${event.seq}`;
}

/**
 * The event's place on the client's time axis, `t`: the simulation's scenario milliseconds, or a v3
 * event's `order_ms` (Unix milliseconds; contract 12.1 "the client keeps t as an internal number").
 * Spans and durations use measured times (`occurred_at`), never this.
 */
export function eventTimeOf(event: EngineEvent): number {
  return isV3(event) ? event.time.order_ms : event.t;
}

const pad = (n: number, width: number): string => String(Math.max(0, Math.floor(n))).padStart(width, "0");

/**
 * The event's history order key. A v3 event carries its own (contract 6.3). A simulation event gets
 * one of the same shape with source rank 0 and key `sim`, so the fixture's order (t, then seq) is
 * kept exactly.
 */
export function eventOrderOf(event: EngineEvent): string {
  return isV3(event) ? event.order : `${pad(event.t, 15)}~0~sim~${pad(event.seq, 12)}~0000`;
}

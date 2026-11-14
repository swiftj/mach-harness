/**
 * Factory Analytics (M6.5): the shape the workspace reads.
 *
 * `MetricRow` and `MetricGroup` mirror the observer's `GET /api/v1/metrics` rows field for field
 * (apps/observer/internal/metrics/metrics.go: `Row`, `Group`, `Coverage`, and the embedded `Def`),
 * snake_case as the JSON is. IDs are the catalog's (M6_1_SHARED_CONTRACTS.md 4.2); nothing here
 * renames or redefines one.
 *
 * Fields marked PROPOSED are not served by the observer at the M6.3 baseline; the prototype's
 * fixture fills them so the design can be judged, and the lead decides whether the observer serves
 * them (see the M6.5.2 report). Fixture-only fields (seeds, lifecycle internals) live in
 * `fixtures/`, never here.
 *
 * Rules carried by the types: a value is `number | null`, never a defaulted 0; `null_reason` says
 * why it is null; `basis` keeps measured, inferred, bounded, unknown and not-recorded apart.
 */
import type { SnapshotHistory } from "./wire/history";
import type { EntityRef } from "../sim/model";

/** The catalog, in its order. */
export const METRIC_IDS = [
  "T1", "T2", "T3",
  "C1", "C2", "C3", "C4", "C5",
  "W1", "W2", "W2b", "W3", "W4", "W5",
  "Q1", "Q2", "Q3", "Q4",
  "R1", "R2", "R3", "R4", "R5", "R6",
  "X1", "X2", "X3",
  "S1", "S2", "S3", "S4", "S5", "S6",
  "K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10",
  "G1", "G2", "G3", "G4",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/** The observe station's scorecard, in observe.py's order (shared contracts 4.4). */
export const SCORECARD_IDS = ["Q3", "Q2", "R5", "G1", "R6", "G2"] as const satisfies readonly MetricId[];

export type MetricKind = "rate" | "mean" | "count" | "duration";
export type Availability = "yes" | "lifecycle" | "stream" | "no";
export type Authority = "authoritative" | "reconstructed" | "observed" | "";
/** How a value or a member is known (M6_5_DESIGN.md section 2.3); counted apart, never averaged together. */
export type Basis = "measured" | "bounded" | "inferred" | "open" | "unknown" | "not-recorded";
/** metrics.go `Row.Status`: whether this observer can answer the metric at all. */
export type MetricStatus = "available" | "partial" | "deferred" | "not-recorded" | "unavailable";

/** Dimensions the observer accepts in `group_by` (routes.go `groupDims`), plus the M6.5 periods. */
export type Dimension =
  | "day" | "week" | "risk" | "app_type" | "station" | "round" | "seat" | "model" | "phase" | "wave" | "stage" | "gate"
  | "reason_code" | "kind" | "tool" | "rule" | "target_kind" | "stop_reason" | "writer" | "ticket" | "token_kind" | "outcome";

/** query.go `Excluded`: members of the population left out of the value, and why. */
export interface Excluded {
  readonly reason: string;
  readonly count: number;
}

/** query.go `Coverage`. `covered`/`of`/`share` are the pre-M6.5 fields (covered = counted, of = eligible). */
export interface Coverage {
  readonly covered: number | null;
  readonly of: number | null;
  readonly share: number | null;
  readonly reason?: string;
  readonly eligible?: number | null;
  readonly counted?: number | null;
  readonly excluded?: readonly Excluded[];
  /** What one eligible member is ("completed executions"), where the observer says. */
  readonly unit?: string;
  /** Counts beside the population that are not its members (e.g. execution-model pairs with no cost). */
  readonly other?: readonly { readonly reason: string; readonly count: number; readonly unit: string | null }[];
}

/** query.go `BasisCounts`: members by how their value is known. `open` is null where it cannot be attributed. */
export interface BasisCounts {
  readonly measured: number;
  readonly bounded: number;
  readonly inferred: number;
  readonly open: number | null;
  readonly unknown: number;
  readonly not_recorded: number;
}

/** query.go `HistBucket`: members with ge_ms <= duration < le_ms. */
export interface HistBucket {
  readonly ge_ms: number;
  readonly le_ms: number;
  readonly count: number;
}

/** query.go `Distribution`: percentiles read from the log histogram (the upper bound of the bucket holding each). */
export interface Distribution {
  readonly p10: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly histogram: readonly HistBucket[];
  /** "exact": nearest rank over every measured value; "histogram": inside a log-histogram bucket (see `percentile_bounds`). */
  readonly percentile_basis: "histogram" | "exact";
  readonly percentile_bounds?: Readonly<Record<string, readonly [number, number]>>;
  readonly over: string;
}

/** query.go `Figure`: one computed value with what it stands on. A group and a trend bucket are Figures. */
export interface Figure {
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly p50_ms?: number;
  readonly p90_ms?: number;
  readonly min_ms?: number;
  readonly max_ms?: number;
  readonly null_reason?: string;
  readonly value_rounded?: number;
  readonly sample_count: number | null;
  readonly basis_counts: BasisCounts | null;
  readonly coverage: Coverage;
  readonly met?: boolean;
  readonly distribution?: Distribution;
  /** How p50_ms and p90_ms were found: exact, or inside a histogram bucket whose bounds are given (then show the range, never an exact time). */
  readonly percentile_basis?: "exact" | "histogram";
  readonly p50_bounds_ms?: readonly [number, number];
  readonly p90_bounds_ms?: readonly [number, number];
}

/** query.go `Group`. `key` is the value ("a|b" for two dimensions); `keys` names them. */
export interface MetricGroup extends Figure {
  readonly key: string;
  readonly keys?: Readonly<Record<string, string>>;
}

/** query.go `Bucket`: one period of a trend (`bucket=day|week`). */
export interface TrendBucket extends Figure {
  readonly period: string;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly suspect: boolean;
}

/** query.go `Row` (with `Def` embedded). The fields up to `groups` are those served before M6.5, same names and meaning. */
export interface MetricRow {
  readonly id: MetricId;
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: string;
  /** The catalog's numerator and denominator, in its words. */
  readonly numerator: string;
  readonly denominator: string;
  readonly dimensions: readonly string[] | null;
  readonly source: string;
  readonly authority: Authority;
  readonly limitations: string;
  readonly availability: Availability;
  readonly target?: string;
  readonly parity_with?: string;

  readonly value: number | null;
  readonly numerator_value: number | null;
  readonly denominator_value: number | null;
  readonly p50_ms?: number;
  readonly p90_ms?: number;
  readonly min_ms?: number;
  readonly max_ms?: number;
  readonly met?: boolean;
  /** The row's basis: "measured" or "inferred" (reconstructed) for a value, "not-recorded" or "unknown" for none. */
  readonly basis: Basis;
  readonly null_reason?: string;
  readonly coverage: Coverage;
  readonly group_by?: string;
  readonly groups?: readonly MetricGroup[];

  // M6.5 (query.go).
  readonly family?: string;
  readonly description?: string;
  readonly formula?: string;
  readonly status?: MetricStatus;
  readonly status_reason?: string;
  readonly value_rounded?: number;
  readonly sample_count?: number | null;
  /** What one member of the sample is: "station visits", "merged tickets", "executions claimed". */
  readonly population?: string;
  readonly basis_counts?: BasisCounts | null;
  readonly sources?: readonly string[];
  readonly target_check?: { readonly value: number; readonly direction: "below" | "above"; readonly met: boolean | null };
  readonly group_dims?: readonly string[];
  readonly groups_reason?: string;
  readonly buckets?: readonly TrendBucket[];
  readonly distribution?: Distribution;
  /** As on a Figure: how p50_ms and p90_ms were found, and the bucket's bounds when it was a histogram. */
  readonly percentile_basis?: "exact" | "histogram";
  readonly p50_bounds_ms?: readonly [number, number];
  readonly p90_bounds_ms?: readonly [number, number];
  readonly suspect?: boolean;
  /** Under a playhead: the figure counts whole UTC days, up to `effective_to_ms` (exact false). */
  readonly as_of?: { readonly exact: boolean; readonly effective_to_ms: number | null } | null;
}

/** `GET /api/v1/metrics` data. */
export interface MetricsResponse {
  readonly metrics: readonly MetricRow[];
  readonly definitions_version: number;
  readonly group_overflow: number;
  readonly partial: boolean;
  readonly rules: string;
}

/** state.go `RunRecord`, as `GET /api/v1/analytics/runs` serves it (one per finished ticket, from runs.jsonl). */
export interface RunRecord {
  readonly ticket_id: string;
  readonly slice_id?: string;
  readonly record_version: number | null;
  readonly outcome: string;
  readonly rounds: number | null;
  readonly first_pass: boolean;
  readonly verify_failures: number;
  readonly review_rejections: number;
  readonly escalated: boolean;
  readonly human_approval: boolean;
  readonly deviations: number;
  readonly blockers: number;
  readonly tests_seen_failing_first: number;
  readonly tests_passing_on_first_run: number;
  readonly risk?: string;
  readonly app_type?: string;
  readonly merge_method?: string;
  readonly merge_commit?: string;
  readonly closed_at: { readonly ms: number } | null;
  readonly event_id: string;
}

// ------------------------------------------------------------------------------------------------
// The workspace's query and the snapshot it assembles (PROPOSED: the observer filters by one
// `group_by` today; `risk`, `app_type`, `model` and `from`/`to` as filters are a lead decision).
// ------------------------------------------------------------------------------------------------

export type WindowKey = "7d" | "14d" | "28d" | "all";
export const RISKS = ["low", "medium", "high"] as const;
export const APP_TYPES = ["web", "cli", "api", "library"] as const;
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export type Risk = (typeof RISKS)[number];
export type AppType = (typeof APP_TYPES)[number];
export type Model = (typeof MODELS)[number];

export interface AnalyticsFilters {
  readonly window: WindowKey;
  readonly risk: Risk | null;
  readonly app_type: AppType | null;
  readonly model: Model | null;
}

/** The dimension each filter narrows. A metric without that dimension is shown unfiltered and says so. */
export const FILTER_DIMENSION: Readonly<Record<Exclude<keyof AnalyticsFilters, "window">, Dimension>> = { risk: "risk", app_type: "app_type", model: "model" };

/** The stations MACH records visits for, in belt order. "human" is the approval wait between review and merge. */
export const STATIONS = ["groom", "plan", "audit", "build", "verify", "review", "human", "merge", "cleanup"] as const;
export type Station = (typeof STATIONS)[number];

/**
 * One drill-down row (M6_5_DESIGN.md 3.3 `contributors`): an entity behind a figure, with the value it
 * contributed. No free text: words are derived from the ref, the basis and the fields.
 */
export interface Contributor {
  readonly ref: EntityRef;
  readonly ticket: string | null;
  readonly cell: string | null;
  readonly execution: string | null;
  /** In the metric's unit; null when the member is counted but has no value (missing is not zero). */
  readonly value: number | null;
  readonly unit: string;
  readonly basis: Basis;
  readonly at_ms: number | null;
  readonly from_ms: number | null;
  readonly to_ms: number | null;
  readonly risk: string | null;
  readonly app_type: string | null;
}

/** `contributors?metric=&group=&order=impact|recent&limit=`: bounded (limit ≤ 500). */
export interface ContributorPage {
  readonly items: readonly Contributor[];
  readonly total: number;
  readonly order: "impact" | "recent";
  readonly truncated: boolean;
}

/** M6_5_DESIGN.md 3.2 `flow`: one recorded move (consecutive visits of one cell), not a trajectory. */
export interface Transition {
  readonly from: Station;
  /** PROPOSED: "blocked" and "abandoned" as exits, from the cell's final state, so the drawing can end a path. */
  readonly to: Station | "blocked" | "abandoned";
  readonly count: number;
  /** Unique tickets that made this move at least once. */
  readonly tickets: number;
}

/** `GET /api/v1/concurrency`, reduced to what the parallelism panel draws. */
export interface ConcurrencySeries {
  readonly bucket_ms: number;
  readonly from_ms: number;
  /** `recorded`: each bucket's peak counting only spans with a recorded end (an inferred end counted to its latest possible time is left out). */
  readonly lines: readonly { readonly kind: "execution" | "visit" | "agent"; readonly counts: readonly number[]; readonly recorded?: readonly number[] }[];
  /** The recorded `max_parallel`, where recorded; absent means not recorded, never inferred. */
  readonly limits: readonly { readonly from_ms: number; readonly to_ms: number; readonly value: number }[];
}

/** Where the numbers come from and how current each source is. */
export interface SourceFreshness {
  readonly source: "intake log" | "cell lifecycle" | "execution stream" | "run records" | "execution records";
  readonly last_event_ms: number | null;
  readonly events: number;
  /** Share of the entities this source should cover that it did (e.g. cells with a lifecycle log). */
  readonly coverage: Coverage;
  readonly note?: string;
  /** When the observer last read this source (its clock), where it said; not when its last event happened. */
  readonly last_read_ms?: number | null;
}

export interface AnalyticsSnapshot {
  readonly source: "simulated" | "live" | "replay";
  readonly generated_at_ms: number;
  readonly window: { readonly from_ms: number; readonly to_ms: number };
  readonly filters: AnalyticsFilters;
  readonly definitions_version: number;
  readonly partial: boolean;
  readonly group_overflow: number;
  /** One row per catalog metric, ungrouped. */
  readonly totals: Readonly<Partial<Record<MetricId, MetricRow>>>;
  /** `${id}|${dimension}` → the row grouped by that dimension. */
  readonly grouped: Readonly<Record<string, MetricRow>>;
  /** `${id}` or `${id}|${dimension}=${value}` → who contributed. */
  readonly contributors: Readonly<Record<string, ContributorPage>>;
  readonly runs: readonly RunRecord[];
  readonly transitions: readonly Transition[];
  readonly concurrency: ConcurrencySeries | null;
  readonly freshness: readonly SourceFreshness[];
  /** M6.6 (I-03): how complete the counted history is (the reply's `history.partial`, `history.gaps`, `suspect_days`); absent from the fixture. */
  readonly history?: SnapshotHistory;
  /** Real-run D4: held on the history's first UTC day, no whole day precedes the playhead: day-counted figures have nothing to count (not "nothing recorded"). */
  readonly no_whole_day?: true;
}

export const groupedKey = (id: MetricId, dim: Dimension): string => `${id}|${dim}`;
export const contributorKey = (id: MetricId, dim?: Dimension, value?: string): string => (dim ? `${id}|${dim}=${value}` : id);

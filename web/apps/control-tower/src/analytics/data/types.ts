/**
 * The typed values the Analytics data layer hands to the workspace, validated from the observer's
 * `/api/v1/analytics/...` replies (M6_5_DESIGN.md section 3; field names as the observer serves
 * them: apps/observer/internal/metrics/query.go, project/flow.go, project/contributors.go,
 * project/flow_runs.go, server/analytics_*.go) or adapted from the simulation's fixture.
 *
 * Rules the types carry:
 * - a number the reply did not give is `null`, never 0;
 * - an availability, status or basis this client does not know is `"unknown"`, never a guess;
 * - prose is `UncheckedText` (text.ts), never a string; identifiers, codes, numbers and the
 *   observer's own catalog strings are strings.
 */
import type { UncheckedText } from "./text";

/** Where the figures come from. The simulation is always labelled Simulated by the UI. */
export type AnalyticsSource = "simulation" | "observer";

// ------------------------------------------------------------------------------------ envelope

export interface AnalyticsWindow {
  readonly from_ms: number | null;
  readonly to_ms: number | null;
  /** The window widened to whole UTC days, as the observer counted it; null for an open side. */
  readonly effective_from_ms: number | null;
  readonly effective_to_ms: number | null;
  readonly last_runs: number | null;
}

export interface HistoryGap {
  readonly class: string;
  readonly at_ms: number | null;
  readonly count: number | null;
}

/** One class of source the projection applied events from (`history.sources`, always the four in this order). */
export interface HistorySource {
  /** "stream" covers execution streams and execution records. */
  readonly source: "intake" | "lifecycle" | "stream" | "runs" | "unknown";
  /** The recorded time of the newest event of that class applied (at the cursor, or as of the playhead). */
  readonly last_event_ms: number | null;
  readonly events: number | null;
  /** When the observer last read a file of that class, on its own clock now: not a replay value, not comparable across observers. */
  readonly last_read_ms: number | null;
  /** "hour" with as_of_ms when the playhead's hour also held later events: whole hours before it are counted. */
  readonly precision: string | null;
  /** Why a value is null: no-events, no-recorded-time, not-tracked, not-read. */
  readonly reason: readonly string[];
}

export interface AnalyticsHistory {
  /** null when the reply did not say. */
  readonly complete: boolean | null;
  readonly complete_window: boolean | null;
  readonly from_ms: number | null;
  /** How precise `from_ms` is ("minute": the first held event, floored). */
  readonly from_precision: string | null;
  /** The projection's partial reason code, null when none. */
  readonly partial: string | null;
  readonly gaps: readonly HistoryGap[];
  /** Per kind of source: its last recorded event and how many events it held (`history.sources`; [] from an observer that does not serve it). */
  readonly sources: readonly HistorySource[];
}

/** The fields every analytics reply carries (M6_5_DESIGN.md 3). */
export interface AnalyticsEnvelope {
  readonly source: AnalyticsSource;
  /** The projection position the reply describes: pass it as `at` to every other query of the view. */
  readonly cursor: string;
  readonly projection: { readonly format: number | null; readonly definitions: number | null };
  readonly generated_ms: number | null;
  readonly window: AnalyticsWindow;
  readonly filters: Readonly<Record<string, string>>;
  readonly history: AnalyticsHistory;
  /**
   * `as_of` (when `as_of_ms` was asked and honoured): `exact` true when nothing recorded after `ms` is
   * counted (flow, contributors, runs); false when the figure is cut at whole UTC days before it
   * (metrics, insights: `effective_to_ms` is the playhead's midnight). `rule` is the observer's words,
   * to show whenever `exact` is false. Null otherwise.
   */
  readonly as_of: { readonly ms: number; readonly exact: boolean; readonly effective_to_ms: number | null; readonly rule: string | null } | null;
  /** The observer's stated rules for the reply (one string or several in the wire format; always a list here). */
  readonly rules: readonly string[];
}

// ------------------------------------------------------------------------------------- metrics

/** `status`: whether the observer can answer the metric. */
export type MetricStatus = "available" | "partial" | "deferred" | "not-recorded" | "unavailable" | "unknown";
/** `availability`: the M6.1 catalog's source class. */
export type CatalogAvailability = "yes" | "lifecycle" | "stream" | "no" | "unknown";
export type MetricKind = "rate" | "mean" | "count" | "duration" | "unknown";
export type Authority = "authoritative" | "reconstructed" | "observed" | "unknown";
/** How a value or member is known. `recorded` is a contributor of a recorded fact (a refusal, a cost). */
export type Basis = "measured" | "bounded" | "inferred" | "open" | "unknown" | "not-recorded" | "recorded";

export interface BasisCounts {
  readonly measured: number | null;
  readonly bounded: number | null;
  readonly inferred: number | null;
  /** null where open members cannot be attributed (a filter, a group, a period). */
  readonly open: number | null;
  readonly unknown: number | null;
  readonly not_recorded: number | null;
}

export interface Excluded {
  readonly reason: string;
  readonly count: number | null;
  /** Set when the count is in another unit than the coverage's (and is not part of it). */
  readonly unit: string | null;
}

export interface Coverage {
  readonly eligible: number | null;
  readonly counted: number | null;
  /** counted / eligible as the observer gives it; null when eligible is 0 or not tracked. */
  readonly share: number | null;
  readonly reason: string | null;
  readonly excluded: readonly Excluded[];
  /** The population the coverage counts, when it is not the denominator's. */
  readonly unit: string | null;
  /** Exclusions counted in another unit (K2: execution-model pairs with no cost), beside the coverage, not part of it. */
  readonly other: readonly Excluded[];
}

export interface HistBucket {
  readonly ge_ms: number;
  readonly le_ms: number;
  readonly count: number;
}

export interface Distribution {
  readonly p10: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly histogram: readonly HistBucket[];
  /** "histogram" (read from the log histogram: the bucket's upper bound) or "exact"; "unknown" otherwise. */
  readonly percentile_basis: "histogram" | "exact" | "unknown";
  /** Per percentile, the bucket that holds it: [ge_ms, le_ms]. */
  readonly percentile_bounds: Readonly<Record<string, readonly [number, number]>>;
  readonly over: string | null;
}

/** One computed value with what it stands on (a row, a group, a trend bucket). */
export interface Figure {
  readonly value: number | null;
  /** observe.py's round(value, 3) as the observer gives it; null when not given. */
  readonly value_rounded: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly null_reason: string | null;
  readonly sample_count: number | null;
  readonly basis_counts: BasisCounts | null;
  readonly bounds: { readonly min_ms: number | null; readonly max_ms: number | null } | null;
  readonly coverage: Coverage;
  readonly p50_ms: number | null;
  readonly p90_ms: number | null;
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly met: boolean | null;
  readonly distribution: Distribution | null;
  /** How p50_ms and p90_ms were found: "exact" (nearest rank) or "histogram" (a bucket's upper bound); null when not said (or a word this client does not know). */
  readonly percentile_basis: "exact" | "histogram" | null;
  /** With "histogram": the bucket holding the percentile, [ge_ms, le_ms]. */
  readonly p50_bounds_ms: readonly [number, number] | null;
  readonly p90_bounds_ms: readonly [number, number] | null;
}

/** A group value: a code, or prose (`group_by=phase`) that must be contained. */
export type GroupValue = { readonly kind: "code"; readonly text: string } | { readonly kind: "unchecked"; readonly text: UncheckedText };

export interface MetricGroup extends Figure {
  /** dimension → value, in the order of `group_by`. */
  readonly keys: Readonly<Record<string, GroupValue>>;
  /** Whether any value is prose: such a group never goes in a URL, a series name or an export without its label. */
  readonly prose: boolean;
  /** An identity safe to use as a React key or a cache key (never shown, never in a URL): the group's index for prose groups. */
  readonly id: string;
}

export interface TrendBucket extends Figure {
  readonly period: string;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly suspect: boolean;
}

export interface MetricRow extends Figure {
  readonly id: string;
  readonly name: string;
  readonly family: string | null;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly description: string | null;
  readonly formula: string | null;
  /** The catalog's numerator and denominator in its words. */
  readonly numerator_words: string | null;
  readonly denominator_words: string | null;
  readonly population: string | null;
  readonly dimensions: readonly string[];
  readonly sources: readonly string[];
  readonly authority: Authority;
  readonly limitations: string | null;
  readonly availability: CatalogAvailability;
  readonly status: MetricStatus;
  readonly status_reason: string | null;
  /** The row's own basis: how its value is known. */
  readonly basis: Basis;
  readonly target: string | null;
  readonly parity_with: string | null;
  readonly target_check: { readonly value: number; readonly direction: "below" | "above" | "unknown"; readonly met: boolean | null } | null;
  /** The dimensions the groups are keyed by; [] when not grouped. */
  readonly group_dims: readonly string[];
  /** null when not grouped; [] when grouped and empty. */
  readonly groups: readonly MetricGroup[] | null;
  readonly groups_reason: string | null;
  readonly groups_omitted: number | null;
  readonly buckets: readonly TrendBucket[] | null;
  readonly suspect: boolean;
  /** How this row is cut at the playhead (as_of_ms): whole UTC days before it; null when not asked. */
  readonly as_of: { readonly ms: number; readonly exact: boolean; readonly effective_to_ms: number | null; readonly rule: string | null } | null;
}

export interface MetricsReply extends AnalyticsEnvelope {
  readonly metrics: readonly MetricRow[];
  readonly definitions_version: number | null;
  readonly group_overflow: number | null;
  readonly suspect_days: readonly string[];
}

// ---------------------------------------------------------------------------------------- flow

export interface MeasuredStats {
  readonly count: number | null;
  readonly total_ms: number | null;
  readonly mean_ms: number | null;
  readonly median_ms: number | null;
  readonly p90_ms: number | null;
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly percentile_basis: "exact" | "histogram" | "unknown";
}

export interface BoundSummary {
  readonly count: number | null;
  readonly total_min_ms: number | null;
  readonly total_max_ms: number | null;
  readonly upper_unknown: number | null;
}

export interface DurationSummary {
  readonly count: number | null;
  /** Members by basis (measured, bounded, inferred, open, unknown); a basis the reply did not give is null. */
  readonly basis: Readonly<Record<"measured" | "bounded" | "inferred" | "open" | "unknown", number | null>>;
  /** Statistics over measured durations only; null when none were measured. */
  readonly measured: MeasuredStats | null;
  readonly bounded: BoundSummary | null;
  readonly inferred: BoundSummary | null;
}

export interface WaitSummary {
  readonly kind: string;
  readonly count: number | null;
  readonly tickets: number | null;
  readonly without_ticket: number | null;
  readonly duration: DurationSummary;
  /** Waits with no later visit (only on the overall wait list). */
  readonly next_station_unknown: number | null;
}

export interface StationFlow {
  readonly station: string;
  readonly visits: number | null;
  readonly tickets: number | null;
  readonly revise_entries: number | null;
  readonly open_visits: number | null;
  readonly duration: DurationSummary;
  readonly gates: { readonly evaluated: number | null; readonly refused: number | null; readonly overridden: number | null; readonly tickets: number | null };
  readonly waits_before: readonly WaitSummary[];
}

/** A count of recorded consecutive visits of one cell, not a trajectory. */
export interface FlowTransition {
  readonly from: string;
  readonly to: string;
  readonly terminal: boolean;
  readonly count: number | null;
  readonly tickets: number | null;
  readonly revise: number | null;
}

export interface Bottleneck {
  /** null when nothing was measured. */
  readonly rank: number | null;
  readonly kind: "station" | "wait" | "unknown";
  readonly key: string;
  readonly total_measured_ms: number | null;
  readonly count: number | null;
  readonly measured: number | null;
  readonly not_measured: number | null;
  readonly tickets_delayed: number | null;
  readonly median_ms: number | null;
  readonly p90_ms: number | null;
}

export interface FlowReply extends AnalyticsEnvelope {
  readonly stations: readonly StationFlow[];
  readonly transitions: readonly FlowTransition[];
  readonly waits: readonly WaitSummary[];
  readonly bottlenecks: readonly Bottleneck[];
  readonly coverage: { readonly tickets: number | null; readonly tickets_with_lifecycle: number | null; readonly visits: number | null; readonly visits_measured: number | null };
  readonly unit: string;
  readonly wait_kinds: readonly string[];
  /** Parts the source cannot give (the simulation's fixture has no stations or waits): absent, never empty-as-zero. */
  readonly missing: readonly ("stations" | "waits" | "bottlenecks" | "coverage")[];
}

// -------------------------------------------------------------------------------- contributors

export interface ContributorItem {
  /** An entity ref in the scene's grammar (`visit:…`, `cell:…`, `execution:…`). */
  readonly ref: string;
  readonly span_id: string | null;
  readonly ticket: string | null;
  /** The cell's entity ref (`cell:SYN-012`). */
  readonly cell: string | null;
  readonly execution: string | null;
  /** In `unit`; null when not measured (min_ms and max_ms say what is known) or not recorded. */
  readonly value: number | null;
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly unit: string;
  readonly basis: Basis;
  readonly at_ms: number | null;
  readonly from_ms: number | null;
  readonly to_ms: number | null;
  readonly risk: string | null;
  readonly app_type: string | null;
  readonly wave: string | null;
  /** The item's codes for the figure's dimensions. */
  readonly group: Readonly<Record<string, string>>;
}

export interface ContributorsReply extends AnalyticsEnvelope {
  readonly metric: string;
  readonly figure: { readonly id: string; readonly catalog: boolean; readonly entities: string | null; readonly unit: string; readonly dimensions: readonly string[] } | null;
  readonly group: Readonly<Record<string, string>>;
  readonly items: readonly ContributorItem[];
  readonly total: number | null;
  readonly truncated: boolean;
  readonly by_basis: Readonly<Record<string, number>>;
  readonly order: "impact" | "recent" | "unknown";
  readonly limit: number | null;
  /** Items dropped by this client because they fall after the "as of" time (a replay) or have no recorded time: counted, never shown. */
  readonly after_as_of: number;
}

// ---------------------------------------------------------------------------------------- runs

/** A time the observer recorded, with its precision and bounds. */
export interface Stamp {
  readonly at_ms: number | null;
  readonly not_before_ms: number | null;
  readonly not_after_ms: number | null;
  readonly precision: string | null;
  readonly authority: string | null;
}

export interface UsageFacts {
  readonly recorded: boolean;
  /** null when nothing was recorded; false when the record may be lower than what was spent. */
  readonly complete: boolean | null;
  readonly incomplete_reasons: readonly string[];
  readonly sources: readonly string[];
  readonly cost_usd: number | null;
  readonly cost_source: string | null;
  readonly supervisor_cost_usd: number | null;
  readonly tokens_total: number | null;
  readonly models: readonly string[];
}

export interface ExecutionItem {
  readonly execution_id: string;
  readonly ticket_id: string | null;
  readonly state: string;
  readonly attempt: number | null;
  readonly started_ms: number | null;
  readonly risk: string | null;
  readonly app_type: string | null;
  readonly wave: string | null;
  readonly usage: UsageFacts;
  /** The recorded snapshot's comparable identity (`config_id`), null when none was recorded. Digests and versions only. */
  readonly config_id: string | null;
  readonly provenance_recorded: boolean;
  /** not-recorded | capture-failed | not-understood | unknown; null when recorded. */
  readonly provenance_reason: string | null;
  readonly source_commit: string | null;
  /** The snapshot as recorded (digests, versions, codes), unparsed: for an inspector, never for prose. */
  readonly provenance: Readonly<Record<string, unknown>> | null;
}

export interface RunItem {
  readonly ticket_id: string;
  readonly slice_id: string | null;
  readonly record_version: number | null;
  /** merged | abandoned | unknown. */
  readonly outcome: string;
  readonly rounds: number | null;
  readonly first_pass: boolean | null;
  readonly verify_failures: number | null;
  readonly review_rejections: number | null;
  readonly escalated: boolean | null;
  readonly human_approval: boolean | null;
  readonly deviations: number | null;
  readonly blockers: number | null;
  readonly tests_seen_failing_first: number | null;
  readonly tests_passing_on_first_run: number | null;
  readonly risk: string | null;
  readonly app_type: string | null;
  readonly wave: string | null;
  readonly merge_method: string | null;
  readonly merge_commit: string | null;
  readonly closed_at: Stamp | null;
  readonly executions: readonly ExecutionItem[];
}

interface RunsCommon extends AnalyticsEnvelope {
  readonly total: number | null;
  readonly offset: number | null;
  readonly more: boolean;
  readonly excluded: readonly Excluded[];
  /** Items dropped by this client because they fall after the "as of" time or have no recorded time: counted, never shown. */
  readonly after_as_of: number;
}
export interface RunsReply extends RunsCommon {
  readonly of: "runs";
  readonly items: readonly RunItem[];
}
export interface ExecutionsReply extends RunsCommon {
  readonly of: "executions";
  readonly items: readonly ExecutionItem[];
}

// ------------------------------------------------------------------------------------ insights

/** One measurement behind a finding. `display` is set only by the simulation (the prototype's findings carry formatted words, not numbers). */
export interface InsightMeasurement {
  readonly metric: string;
  readonly label: string | null;
  readonly value: number | null;
  readonly unit: string | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly sample_count: number | null;
  readonly coverage: { readonly eligible: number | null; readonly counted: number | null; readonly share: number | null } | null;
  /** Which window it was measured in: the selection, or the later and earlier halves of a comparison. */
  readonly window: "selection" | "later" | "earlier" | "unknown";
  readonly display: string | null;
}

/** One Improvement Opportunity (apps/observer/internal/insight `Finding`). Its words are the observer's own rule templates (group A). */
export interface Insight {
  readonly id: string;
  readonly rule: string;
  /** The code the rule is about (a station, a wait kind, a gate), null for a whole-Factory rule. */
  readonly subject: string | null;
  readonly severity: "attention" | "note" | "unknown";
  readonly title: string;
  readonly condition: string | null;
  readonly threshold: string | null;
  readonly measurements: readonly InsightMeasurement[];
  readonly sample: { readonly count: number | null; readonly unit: string | null; readonly coverage_share: number | null; readonly population: string | null } | null;
  readonly window: { readonly from_ms: number | null; readonly to_ms: number | null; readonly last_runs: number | null; readonly comparison: { readonly from_ms: number | null; readonly to_ms: number | null } | null };
  readonly filters: Readonly<Record<string, string>>;
  readonly why: string | null;
  readonly investigation: { readonly label: string; readonly text: string } | null;
  /** The contributors query behind it; `relation` says whether it lists the figure's own members ("members") or related ones. */
  readonly contributors: {
    readonly metric: string;
    readonly group: Readonly<Record<string, string>>;
    readonly order: "impact" | "recent" | "unknown";
    readonly limit: number | null;
    readonly path: string | null;
    readonly relation: string | null;
    readonly note: string | null;
  } | null;
}

/** A rule in the catalog the reply states (`rules`). */
export interface InsightRule {
  readonly id: string;
  readonly severity: "attention" | "note" | "unknown";
  readonly condition: string | null;
  readonly threshold: string | null;
  readonly minimum: string | null;
  readonly metrics: readonly string[];
}

export interface InsightsReply extends AnalyticsEnvelope {
  readonly insights: readonly Insight[];
  /** Rules that could not be evaluated on this selection, and why (too small a sample, no comparison window). */
  readonly not_evaluated: readonly { readonly rule: string; readonly subject: string | null; readonly reason: string }[];
  readonly insight_rules: readonly InsightRule[];
  readonly notice: string | null;
  readonly investigation_label: string | null;
}

// ------------------------------------------------------------------------ concurrency, freshness

/** `/api/v1/concurrency` reduced to what Analytics draws. Not pinned to the view's cursor: the route takes none. */
export interface ConcurrencyReply {
  readonly source: AnalyticsSource;
  readonly cursor: string | null;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly bucket_ms: number;
  /** Per span kind, the most active in each bucket from `from_ms` (null where the reply has no bucket). */
  readonly lines: readonly { readonly kind: string; readonly max: readonly (number | null)[] }[];
  /** Recorded limits, each with the span kinds it bounds (null: none of them). */
  readonly limits: readonly { readonly name: string; readonly value: number; readonly from_ms: number; readonly to_ms: number | null; readonly applies_to: readonly string[] | null }[];
  readonly complete: boolean | null;
}

export type FreshnessSource = "intake log" | "cell lifecycle" | "execution stream" | "run records" | "execution records";

/** When the observer last read each kind of source (`/factory/status` `freshness.sources`). */
export interface SourceFreshness {
  readonly source: FreshnessSource;
  /** Files of this kind the observer follows; null when it follows none (then `reason` says so). */
  readonly files: number | null;
  /** The latest time any of them was read (the observer's clock); null when not said. */
  readonly last_read_ms: number | null;
  /** Bytes written but not read yet, summed. */
  readonly lag_bytes: number | null;
  /** Files by state (live, ended, stale, …). */
  readonly states: Readonly<Record<string, number>>;
  readonly reason: string | null;
}

export interface FreshnessReply {
  readonly source: AnalyticsSource;
  readonly read_at_ms: number | null;
  readonly watermark_ms: number | null;
  readonly sources: readonly SourceFreshness[];
}

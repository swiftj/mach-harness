/**
 * From the data layer's typed replies (types.ts) to the prototype's contract shapes (../contract.ts),
 * which the area components take. One direction only; contract.ts is not changed. What the contract
 * cannot hold is left out and said (see the notes on each function), never filled with a guess:
 * - a prose group (`group_by=phase`) has no string key the contract could carry safely: it is left
 *   out of `groups` and the row's `groups_reason` says so (render those with `UncheckedText` from the
 *   typed reply);
 * - a status this client does not know is left out (`status` is optional); a row of a kind it does
 *   not know is left out of the snapshot.
 */
import type {
  AnalyticsFilters, AnalyticsSnapshot, ConcurrencySeries, SourceFreshness, Basis as ContractBasis, Contributor, ContributorPage, Coverage as ContractCoverage, Dimension, MetricGroup as ContractGroup,
  MetricId, MetricRow as ContractRow, RunRecord, Transition,
} from "../contract";
import { contributorKey, groupedKey } from "../contract";
import type { EntityRef } from "../../sim/model";
import type { AnalyticsHistory, ConcurrencyReply, FlowReply, FreshnessReply, ContributorsReply, Coverage, Figure, FlowTransition, HistorySource, MetricGroup, MetricRow, RunItem } from "./types";

function coverage(c: Coverage): ContractCoverage {
  return { covered: c.counted, of: c.eligible, share: c.share, ...(c.reason ? { reason: c.reason } : {}), eligible: c.eligible, counted: c.counted, excluded: c.excluded.map((e) => ({ reason: e.reason, count: e.count ?? 0 })) };
}

function figure(f: Figure) {
  return {
    value: f.value,
    numerator: f.numerator,
    denominator: f.denominator,
    ...(f.p50_ms !== null ? { p50_ms: f.p50_ms } : {}),
    ...(f.p90_ms !== null ? { p90_ms: f.p90_ms } : {}),
    ...(f.min_ms !== null ? { min_ms: f.min_ms } : {}),
    ...(f.max_ms !== null ? { max_ms: f.max_ms } : {}),
    ...(f.null_reason ? { null_reason: f.null_reason } : {}),
    ...(f.value_rounded !== null ? { value_rounded: f.value_rounded } : {}),
    sample_count: f.sample_count,
    basis_counts: f.basis_counts
      ? { measured: f.basis_counts.measured ?? 0, bounded: f.basis_counts.bounded ?? 0, inferred: f.basis_counts.inferred ?? 0, open: f.basis_counts.open, unknown: f.basis_counts.unknown ?? 0, not_recorded: f.basis_counts.not_recorded ?? 0 }
      : null,
    coverage: coverage(f.coverage),
    ...(f.met !== null ? { met: f.met } : {}),
    ...(f.distribution && f.distribution.percentile_basis === "histogram"
      ? { distribution: { p10: f.distribution.p10, p25: f.distribution.p25, p50: f.distribution.p50, p75: f.distribution.p75, p90: f.distribution.p90, min: f.distribution.min, max: f.distribution.max, histogram: f.distribution.histogram, percentile_basis: "histogram" as const, over: f.distribution.over ?? "" } }
      : {}),
  };
}

function group(g: MetricGroup): ContractGroup | null {
  if (g.prose) return null;
  const keys: Record<string, string> = {};
  for (const [k, v] of Object.entries(g.keys)) if (v.kind === "code") keys[k] = v.text;
  return { ...figure(g), key: Object.values(keys).join("|"), keys };
}

/**
 * A typed row as the contract's `MetricRow`. Notes: basis counts the reply did not give become 0 in
 * the contract (it has no null there; `basis_counts` itself stays null when absent); a distribution
 * whose percentiles are not from the histogram is left out (the contract only has that basis).
 */
export function toContractRow(r: MetricRow): ContractRow | null {
  // A kind the contract does not know cannot be drawn by it: left out rather than guessed.
  if (r.kind === "unknown") return null;
  const groups = r.groups?.map(group);
  const dropped = groups ? groups.filter((g) => g === null).length : 0;
  return {
    ...figure(r),
    id: r.id as MetricId,
    name: r.name,
    kind: r.kind,
    unit: r.unit,
    numerator: r.numerator_words ?? "",
    denominator: r.denominator_words ?? "",
    dimensions: r.dimensions,
    source: r.sources[0] ?? "",
    authority: r.authority === "unknown" ? "" : r.authority,
    limitations: r.limitations ?? "",
    availability: r.availability === "unknown" ? "no" : r.availability,
    ...(r.target ? { target: r.target } : {}),
    ...(r.parity_with ? { parity_with: r.parity_with } : {}),
    numerator_value: r.numerator,
    denominator_value: r.denominator,
    basis: r.basis === "recorded" ? "measured" : r.basis,
    ...(r.group_dims.length ? { group_by: r.group_dims.join(",") } : {}),
    ...(groups ? { groups: groups.filter((g): g is ContractGroup => g !== null) } : {}),
    ...(r.family ? { family: r.family } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.formula ? { formula: r.formula } : {}),
    ...(r.status !== "unknown" ? { status: r.status } : {}),
    ...(r.status_reason ? { status_reason: r.status_reason } : {}),
    ...(r.population ? { population: r.population } : {}),
    sources: r.sources,
    ...(r.target_check && r.target_check.direction !== "unknown" ? { target_check: { value: r.target_check.value, direction: r.target_check.direction, met: r.target_check.met } } : {}),
    group_dims: r.group_dims,
    ...(dropped ? { groups_reason: `${dropped} group${dropped === 1 ? "" : "s"} named in free text not checked for names are listed apart` } : r.groups_reason ? { groups_reason: r.groups_reason } : {}),
    ...(r.buckets ? { buckets: r.buckets.map((b) => ({ ...figure(b), period: b.period, from_ms: b.from_ms, to_ms: b.to_ms, suspect: b.suspect })) } : {}),
    suspect: r.suspect,
  };
}

/** A run as the contract's `RunRecord` (`closed_at: {ms}`; numbers not recorded become 0 and false, as the observer's run record holds them). */
export function toContractRun(r: RunItem): RunRecord {
  return {
    ticket_id: r.ticket_id,
    ...(r.slice_id ? { slice_id: r.slice_id } : {}),
    record_version: r.record_version,
    outcome: r.outcome,
    rounds: r.rounds,
    first_pass: r.first_pass === true,
    verify_failures: r.verify_failures ?? 0,
    review_rejections: r.review_rejections ?? 0,
    escalated: r.escalated === true,
    human_approval: r.human_approval === true,
    deviations: r.deviations ?? 0,
    blockers: r.blockers ?? 0,
    tests_seen_failing_first: r.tests_seen_failing_first ?? 0,
    tests_passing_on_first_run: r.tests_passing_on_first_run ?? 0,
    ...(r.risk ? { risk: r.risk } : {}),
    ...(r.app_type ? { app_type: r.app_type } : {}),
    ...(r.merge_method ? { merge_method: r.merge_method } : {}),
    ...(r.merge_commit ? { merge_commit: r.merge_commit } : {}),
    closed_at: r.closed_at?.at_ms != null ? { ms: r.closed_at.at_ms } : null,
    event_id: "",
  };
}

/** For Compare: per run, the `config_id` of each of its executions (null: no provenance recorded). */
export function configsOf(runs: readonly RunItem[]): Record<string, (string | null)[]> {
  const out: Record<string, (string | null)[]> = {};
  for (const r of runs) out[r.ticket_id] = r.executions.map((x) => (x.provenance_recorded ? x.config_id : null));
  return out;
}

/** A contributors reply as the contract's page. `cell` becomes the ticket id (the observer serves the cell's ref); a `recorded` basis (a recorded fact) is kept as the observer's word. */
export function toContractContributors(reply: ContributorsReply): ContributorPage {
  const items: Contributor[] = reply.items.map((c) => ({
    ref: c.ref as EntityRef,
    ticket: c.ticket,
    cell: c.cell ? c.cell.replace(/^cell:/, "") : null,
    execution: c.execution,
    value: c.value,
    unit: c.unit,
    basis: c.basis as ContractBasis, // "recorded" is not in the contract's Basis (reported to the lead)
    at_ms: c.at_ms,
    from_ms: c.from_ms,
    to_ms: c.to_ms,
    risk: c.risk,
    app_type: c.app_type,
  }));
  return { items, total: reply.total ?? items.length, order: reply.order === "recent" ? "recent" : "impact", truncated: reply.truncated };
}

/** Flow transitions as the contract's (station names are the observer's; a terminal move keeps its `to`). */
export function toContractTransitions(ts: readonly FlowTransition[]): Transition[] {
  return ts.map((t) => ({ from: t.from as Transition["from"], to: t.to as Transition["to"], count: t.count ?? 0, tickets: t.tickets ?? 0 }));
}

/** The parts of one view, read at one cursor, assembled into the contract's snapshot. */
export interface SnapshotParts {
  readonly source: AnalyticsSnapshot["source"];
  readonly filters: AnalyticsFilters;
  readonly window: { readonly from_ms: number; readonly to_ms: number };
  readonly generated_ms: number;
  /** The ungrouped metrics reply's rows. */
  readonly totals: readonly MetricRow[];
  /** Rows grouped by one dimension. */
  readonly grouped?: readonly MetricRow[];
  readonly contributors?: readonly { readonly metric: MetricId; readonly dimension?: Dimension; readonly value?: string; readonly reply: ContributorsReply }[];
  readonly runs?: readonly RunItem[];
  readonly transitions?: readonly FlowTransition[];
  readonly definitions_version: number | null;
  readonly partial: boolean;
  readonly group_overflow: number | null;
  readonly concurrency?: ConcurrencyReply | null;
  readonly freshness?: FreshnessReply | null;
  /** The envelope's per-source history (last event, events), when served. */
  readonly historySources?: readonly HistorySource[];
  /** The flow reply's coverage: how many tickets kept a lifecycle log (the lifecycle source's coverage). */
  readonly flowCoverage?: FlowReply["coverage"] | null;
}

const CONTRACT_LINES = ["execution", "visit", "agent"] as const;

/**
 * Concurrency as the contract's series: the execution, visit and agent lines, each bucket's most
 * active. A line with a bucket the reply did not hold is left out (the contract has no null count);
 * limits are those bounding executions (`max_parallel`), an open end drawn to the reply's end.
 */
export function toContractConcurrency(c: ConcurrencyReply): ConcurrencySeries {
  const lines: { kind: (typeof CONTRACT_LINES)[number]; counts: number[] }[] = [];
  for (const kind of CONTRACT_LINES) {
    const line = c.lines.find((l) => l.kind === kind);
    if (line && line.max.every((x) => x !== null)) lines.push({ kind, counts: line.max as number[] });
  }
  const limits = c.limits.filter((l) => l.applies_to?.includes("execution")).map((l) => ({ from_ms: l.from_ms, to_ms: l.to_ms ?? c.to_ms, value: l.value }));
  return { bucket_ms: c.bucket_ms, from_ms: c.from_ms, lines, limits };
}

/**
 * Freshness as the contract's list. The observer says when it last read each source, not when its
 * last event happened: `last_event_ms` is null and the note gives the read time. `events` is not
 * served per source (null, though the contract types it as a number: reported to the lead).
 * Coverage is known for the cell lifecycle only (tickets with a lifecycle log, from flow).
 */
const HISTORY_SOURCE: Readonly<Record<string, string>> = { intake: "intake log", lifecycle: "cell lifecycle", stream: "execution stream", runs: "run records" };

export function toContractFreshness(f: FreshnessReply, flow: FlowReply["coverage"] | null | undefined, history: readonly HistorySource[] = []): SourceFreshness[] {
  const untracked = (reason: string) => ({ covered: null, of: null, share: null, reason });
  return f.sources.map((x) => {
    const lifecycle = x.source === "cell lifecycle" && flow && flow.tickets !== null && flow.tickets_with_lifecycle !== null;
    // The envelope's history.sources gives the time of a source's last event and its count, where served.
    const h = history.find((y) => HISTORY_SOURCE[y.source] === x.source);
    return {
      source: x.source,
      last_event_ms: h?.last_event_ms ?? null,
      events: (h?.events ?? null) as unknown as number,
      coverage: lifecycle
        ? { covered: flow!.tickets_with_lifecycle, of: flow!.tickets, share: flow!.tickets ? flow!.tickets_with_lifecycle! / flow!.tickets : null }
        : untracked("coverage is not tracked for this source"),
      last_read_ms: x.last_read_ms ?? h?.last_read_ms ?? null,
      note: x.last_read_ms !== null ? `${x.files ?? 0} file${x.files === 1 ? "" : "s"} followed` : (x.reason ?? "not read"),
    };
  });
}

const HISTORY_REASON: Readonly<Record<string, string>> = {
  "no-events": "no events of this source were applied",
  "no-recorded-time": "its events carry no recorded time",
  "not-tracked": "not tracked",
  "not-read": "the observer did not say when it last read it",
};

/**
 * The contract's freshness for one view: `/factory/status` (when read) for files and read times,
 * and the envelope's `history.sources` (at the view's cursor, or as of the playhead) for each
 * source's last event and count. Without the status reply, the four history classes alone; a value
 * neither gives stays null and the note says why. `history.sources` empty and no status: [].
 */
export function freshnessFor(status: FreshnessReply | null, history: AnalyticsHistory, flow: FlowReply["coverage"] | null | undefined): SourceFreshness[] {
  if (status) return toContractFreshness(status, flow, history.sources);
  return history.sources.flatMap((h) => {
    const source = HISTORY_SOURCE[h.source] as SourceFreshness["source"] | undefined;
    if (!source) return [];
    const lifecycle = source === "cell lifecycle" && flow && flow.tickets !== null && flow.tickets_with_lifecycle !== null;
    const notes = [h.precision === "hour" ? "counted to whole hours before the playhead" : null, h.source === "stream" ? "execution streams and execution records are one source here" : null, ...h.reason.map((r) => HISTORY_REASON[r] ?? r)].filter(
      (n): n is string => n !== null,
    );
    return [
      {
        source,
        last_event_ms: h.last_event_ms,
        events: h.events as number, // null when not served (the contract types it as a number: reported to the lead)
        coverage: lifecycle
          ? { covered: flow!.tickets_with_lifecycle, of: flow!.tickets, share: flow!.tickets ? flow!.tickets_with_lifecycle! / flow!.tickets : null }
          : { covered: null, of: null, share: null, reason: "coverage is not tracked for this source" },
        last_read_ms: h.last_read_ms,
        ...(notes.length ? { note: notes.join("; ") } : {}),
      },
    ];
  });
}

/** Concurrency and freshness are null and [] when their replies are not given (absent, said by the areas). */
export function toContractSnapshot(p: SnapshotParts): AnalyticsSnapshot {
  const totals: Partial<Record<MetricId, ContractRow>> = {};
  for (const r of p.totals) {
    const row = toContractRow(r);
    if (row) totals[r.id as MetricId] = row;
  }
  const grouped: Record<string, ContractRow> = {};
  for (const r of p.grouped ?? []) {
    const row = r.group_dims.length === 1 ? toContractRow(r) : null;
    if (row) grouped[groupedKey(r.id as MetricId, r.group_dims[0] as Dimension)] = row;
  }
  const contributors: Record<string, ContributorPage> = {};
  for (const c of p.contributors ?? []) contributors[contributorKey(c.metric, c.dimension, c.value)] = toContractContributors(c.reply);
  return {
    source: p.source,
    generated_at_ms: p.generated_ms,
    window: p.window,
    filters: p.filters,
    definitions_version: p.definitions_version ?? 0,
    partial: p.partial,
    group_overflow: p.group_overflow ?? 0,
    totals,
    grouped,
    contributors,
    runs: (p.runs ?? []).map(toContractRun),
    transitions: toContractTransitions(p.transitions ?? []),
    concurrency: p.concurrency ? toContractConcurrency(p.concurrency) : null,
    freshness: p.freshness ? toContractFreshness(p.freshness, p.flowCoverage, p.historySources ?? []) : [],
  };
}

/**
 * Validation of the observer's analytics replies into the typed values of types.ts. Tolerant of
 * unknown fields; strict about meaning: a missing number is null (never 0), an enumeration value this
 * client does not know is "unknown", prose is wrapped (text.ts). A reply without its cursor is not an
 * analytics reply and throws `AnalyticsProtocolError`.
 */
import type {
  ConcurrencyReply, FreshnessReply, FreshnessSource, InsightMeasurement, InsightRule, SourceFreshness,
  AnalyticsEnvelope, AnalyticsSource, Authority, Basis, BasisCounts, Bottleneck, BoundSummary, CatalogAvailability, ContributorItem, ContributorsReply, Coverage, Distribution,
  DurationSummary, Excluded, ExecutionItem, ExecutionsReply, Figure, FlowReply, FlowTransition, GroupValue, HistBucket, Insight, InsightsReply, MeasuredStats, MetricGroup, MetricKind,
  MetricRow, MetricStatus, MetricsReply, RunItem, RunsReply, Stamp, StationFlow, TrendBucket, UsageFacts, WaitSummary,
} from "./types";
import { PROSE_DIMENSIONS, UNDECLARED_POLICY, proseLimit, unchecked, type DisplayPolicy } from "./text";

export class AnalyticsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsProtocolError";
  }
}

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | "unknown" => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : "unknown");
const codes = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(v))) if (typeof x === "string") out[k] = x;
  return out;
};
const counts = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v))) if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
  return out;
};

const STATUSES = ["available", "partial", "deferred", "not-recorded", "unavailable"] as const;
const AVAILABILITIES = ["yes", "lifecycle", "stream", "no"] as const;
const KINDS = ["rate", "mean", "count", "duration"] as const;
const AUTHORITIES = ["authoritative", "reconstructed", "observed"] as const;
const BASES = ["measured", "bounded", "inferred", "open", "unknown", "not-recorded", "recorded"] as const;

/** A basis word; "not_recorded" is read as "not-recorded"; anything else unknown. */
export function readBasis(v: unknown): Basis {
  return oneOf(v === "not_recorded" ? "not-recorded" : v, BASES);
}
export const readStatus = (v: unknown): MetricStatus => oneOf(v, STATUSES);

// ------------------------------------------------------------------------------------ envelope

export function readEnvelope(data: unknown, source: AnalyticsSource): AnalyticsEnvelope {
  const d = obj(data);
  const cursor = str(d.cursor);
  if (!cursor) throw new AnalyticsProtocolError("The analytics reply carries no cursor.");
  const w = obj(d.window);
  const p = obj(d.projection);
  const h = obj(d.history);
  // Insights state a rule catalog (objects) under `rules`: read by readInsights, not here.
  const rules = typeof d.rules === "string" ? [d.rules] : strings(d.rules);
  return {
    source,
    cursor,
    projection: { format: num(p.format), definitions: num(p.definitions) },
    generated_ms: num(d.generated_ms),
    window: { from_ms: num(w.from_ms), to_ms: num(w.to_ms), effective_from_ms: num(w.effective_from_ms), effective_to_ms: num(w.effective_to_ms), last_runs: num(w.last_runs) },
    filters: codes(d.filters),
    history: {
      complete: bool(h.complete),
      complete_window: bool(h.complete_window),
      from_ms: num(h.from_ms),
      from_precision: str(h.from_precision),
      partial: str(h.partial) ?? (typeof d.partial === "string" && d.partial ? d.partial : null),
      gaps: arr(h.gaps).map((g) => ({ class: str(obj(g).class) ?? "unknown", at_ms: num(obj(g).at_ms), count: num(obj(g).count) })),
      sources: arr(h.sources).map((x) => {
        const o = obj(x);
        return { source: oneOf(o.source, ["intake", "lifecycle", "stream", "runs"] as const), last_event_ms: num(o.last_event_ms), events: num(o.events), last_read_ms: num(o.last_read_ms), precision: str(o.precision), reason: strings(o.reason) };
      }),
    },
    as_of: readAsOf(d.as_of),
    rules,
  };
}

// ------------------------------------------------------------------------------------- metrics

function readExcluded(v: unknown): Excluded[] {
  return arr(v).map((x) => ({ reason: str(obj(x).reason) ?? "unknown", count: num(obj(x).count), unit: str(obj(x).unit) }));
}

const pair = (v: unknown): readonly [number, number] | null => {
  const a = arr(v);
  const lo = num(a[0]);
  const hi = num(a[1]);
  return lo !== null && hi !== null ? [lo, hi] : null;
};

/** `as_of` on a reply or a metric row; null when absent. */
function readAsOf(v: unknown): { ms: number; exact: boolean; effective_to_ms: number | null; rule: string | null } | null {
  if (!v || typeof v !== "object") return null;
  const a = obj(v);
  const ms = num(a.ms);
  return ms === null ? null : { ms, exact: a.exact === true, effective_to_ms: num(a.effective_to_ms), rule: str(a.rule) };
}

/** `coverage`: `eligible`/`counted` (M6.5), else the older `of`/`covered`. */
export function readCoverage(v: unknown): Coverage {
  const c = obj(v);
  return { eligible: num(c.eligible) ?? num(c.of), counted: num(c.counted) ?? num(c.covered), share: num(c.share), reason: str(c.reason), excluded: readExcluded(c.excluded), unit: str(c.unit), other: readExcluded(c.other) };
}

function readBasisCounts(v: unknown): BasisCounts | null {
  if (!v || typeof v !== "object") return null;
  const b = obj(v);
  return { measured: num(b.measured), bounded: num(b.bounded), inferred: num(b.inferred), open: num(b.open), unknown: num(b.unknown), not_recorded: num(b.not_recorded) };
}

function readDistribution(v: unknown): Distribution | null {
  if (!v || typeof v !== "object") return null;
  const d = obj(v);
  const histogram: HistBucket[] = [];
  for (const x of arr(d.histogram)) {
    const b = obj(x);
    const ge = num(b.ge_ms);
    const le = num(b.le_ms);
    const c = num(b.count);
    if (ge !== null && le !== null && c !== null) histogram.push({ ge_ms: ge, le_ms: le, count: c });
  }
  const bounds: Record<string, readonly [number, number]> = {};
  for (const [k, x] of Object.entries(obj(d.percentile_bounds))) {
    const pair = arr(x);
    const a = num(pair[0]);
    const b = num(pair[1]);
    if (a !== null && b !== null) bounds[k] = [a, b];
  }
  return {
    p10: num(d.p10), p25: num(d.p25), p50: num(d.p50), p75: num(d.p75), p90: num(d.p90), min: num(d.min), max: num(d.max),
    histogram,
    percentile_basis: oneOf(d.percentile_basis, ["histogram", "exact"] as const),
    percentile_bounds: bounds,
    over: str(d.over),
  };
}

/** A figure. Rows serve their numbers as `numerator_value`/`denominator_value` (`numerator` is the catalog's words); groups and buckets as `numerator`/`denominator`. */
function readFigure(f: Obj, row: boolean): Figure {
  const b = f.bounds && typeof f.bounds === "object" ? obj(f.bounds) : null;
  return {
    value: num(f.value),
    value_rounded: num(f.value_rounded),
    numerator: row ? num(f.numerator_value) : num(f.numerator),
    denominator: row ? num(f.denominator_value) : num(f.denominator),
    null_reason: str(f.null_reason),
    sample_count: num(f.sample_count),
    basis_counts: readBasisCounts(f.basis_counts),
    bounds: b ? { min_ms: num(b.min_ms), max_ms: num(b.max_ms) } : null,
    coverage: readCoverage(f.coverage),
    p50_ms: num(f.p50_ms),
    p90_ms: num(f.p90_ms),
    min_ms: num(f.min_ms),
    max_ms: num(f.max_ms),
    met: bool(f.met),
    distribution: readDistribution(f.distribution),
    percentile_basis: f.percentile_basis === "exact" || f.percentile_basis === "histogram" ? f.percentile_basis : null,
    p50_bounds_ms: pair(f.p50_bounds_ms),
    p90_bounds_ms: pair(f.p90_bounds_ms),
  };
}

function readGroup(v: unknown, dims: readonly string[], index: number, policy: DisplayPolicy): MetricGroup {
  const g = obj(v);
  const raw = codes(g.keys);
  // An older observer's group has only `key`; with one dimension it is that dimension's value.
  if (!Object.keys(raw).length && typeof g.key === "string" && dims.length === 1) raw[dims[0]!] = g.key;
  const keys: Record<string, GroupValue> = {};
  let prose = false;
  for (const [dim, value] of Object.entries(raw)) {
    const p = PROSE_DIMENSIONS[dim];
    if (p) {
      const t = unchecked(value, p.field, proseLimit(policy, dim));
      prose = true;
      if (t) keys[dim] = { kind: "unchecked", text: t };
    } else keys[dim] = { kind: "code", text: value };
  }
  return { ...readFigure(g, false), keys, prose, id: prose ? `group#${index}` : Object.entries(raw).map(([k, x]) => `${k}=${x}`).join("&") };
}

function readBucket(v: unknown): TrendBucket | null {
  const b = obj(v);
  const from = num(b.from_ms);
  const to = num(b.to_ms);
  if (from === null || to === null) return null;
  return { ...readFigure(b, false), period: str(b.period) ?? "", from_ms: from, to_ms: to, suspect: b.suspect === true };
}

export function readMetricRow(v: unknown, policy: DisplayPolicy = UNDECLARED_POLICY): MetricRow | null {
  const r = obj(v);
  const id = str(r.id);
  if (!id) return null;
  const dims = strings(r.group_dims).length ? strings(r.group_dims) : str(r.group_by) ? (r.group_by as string).split(",") : [];
  const tc = r.target_check && typeof r.target_check === "object" ? obj(r.target_check) : null;
  const tv = tc ? num(tc.value) : null;
  return {
    ...readFigure(r, true),
    id,
    name: str(r.name) ?? id,
    family: str(r.family),
    kind: oneOf(r.kind, KINDS) satisfies MetricKind,
    unit: str(r.unit) ?? "",
    description: str(r.description),
    formula: str(r.formula),
    numerator_words: typeof r.numerator === "string" ? r.numerator : null,
    denominator_words: typeof r.denominator === "string" ? r.denominator : null,
    population: str(r.population),
    dimensions: strings(r.dimensions),
    sources: strings(r.sources).length ? strings(r.sources) : str(r.source) ? [r.source as string] : [],
    authority: oneOf(r.authority, AUTHORITIES) satisfies Authority,
    limitations: str(r.limitations),
    availability: oneOf(r.availability, AVAILABILITIES) satisfies CatalogAvailability,
    status: readStatus(r.status),
    status_reason: str(r.status_reason),
    basis: readBasis(r.basis),
    target: str(r.target),
    parity_with: str(r.parity_with),
    target_check: tc && tv !== null ? { value: tv, direction: oneOf(tc.direction, ["below", "above"] as const), met: bool(tc.met) } : null,
    group_dims: dims,
    groups: Array.isArray(r.groups) ? r.groups.map((g, i) => readGroup(g, dims, i, policy)) : null,
    groups_reason: str(r.groups_reason),
    groups_omitted: num(r.groups_omitted),
    buckets: Array.isArray(r.buckets) ? r.buckets.map(readBucket).filter((b): b is TrendBucket => b !== null) : null,
    suspect: r.suspect === true,
    as_of: readAsOf(r.as_of),
  };
}

export function readMetrics(data: unknown, source: AnalyticsSource, policy: DisplayPolicy = UNDECLARED_POLICY): MetricsReply {
  const d = obj(data);
  if (!Array.isArray(d.metrics)) throw new AnalyticsProtocolError("The metrics reply carries no metrics list.");
  return {
    ...readEnvelope(d, source),
    metrics: d.metrics.map((x) => readMetricRow(x, policy)).filter((x): x is MetricRow => x !== null),
    definitions_version: num(d.definitions_version),
    group_overflow: num(d.group_overflow),
    suspect_days: strings(d.suspect_days),
  };
}

// ---------------------------------------------------------------------------------------- flow

function readStats(v: unknown): MeasuredStats | null {
  if (!v || typeof v !== "object") return null;
  const m = obj(v);
  return { count: num(m.count), total_ms: num(m.total_ms), mean_ms: num(m.mean_ms), median_ms: num(m.median_ms), p90_ms: num(m.p90_ms), min_ms: num(m.min_ms), max_ms: num(m.max_ms), percentile_basis: oneOf(m.percentile_basis, ["exact", "histogram"] as const) };
}
function readBounds(v: unknown): BoundSummary | null {
  if (!v || typeof v !== "object") return null;
  const b = obj(v);
  return { count: num(b.count), total_min_ms: num(b.total_min_ms), total_max_ms: num(b.total_max_ms), upper_unknown: num(b.upper_unknown) };
}
function readDuration(v: unknown): DurationSummary {
  const d = obj(v);
  const b = obj(d.basis);
  return {
    count: num(d.count),
    basis: { measured: num(b.measured), bounded: num(b.bounded), inferred: num(b.inferred), open: num(b.open), unknown: num(b.unknown) },
    measured: readStats(d.measured),
    bounded: readBounds(d.bounded),
    inferred: readBounds(d.inferred),
  };
}
function readWait(v: unknown): WaitSummary {
  const w = obj(v);
  return { kind: str(w.kind) ?? "unknown", count: num(w.count), tickets: num(w.tickets), without_ticket: num(w.without_ticket), duration: readDuration(w.duration), next_station_unknown: num(w.next_station_unknown) };
}
function readStation(v: unknown): StationFlow | null {
  const s = obj(v);
  const station = str(s.station);
  if (!station) return null;
  const g = obj(s.gates);
  return {
    station,
    visits: num(s.visits),
    tickets: num(s.tickets),
    revise_entries: num(s.revise_entries),
    open_visits: num(s.open_visits),
    duration: readDuration(s.duration),
    gates: { evaluated: num(g.evaluated), refused: num(g.refused), overridden: num(g.overridden), tickets: num(g.tickets) },
    waits_before: arr(s.waits_before).map(readWait),
  };
}
function readTransition(v: unknown): FlowTransition | null {
  const t = obj(v);
  const from = str(t.from);
  const to = str(t.to);
  if (!from || !to) return null;
  return { from, to, terminal: t.terminal === true, count: num(t.count), tickets: num(t.tickets), revise: num(t.revise) };
}
function readBottleneck(v: unknown): Bottleneck | null {
  const b = obj(v);
  const key = str(b.key);
  if (!key) return null;
  return {
    rank: num(b.rank), kind: oneOf(b.kind, ["station", "wait"] as const), key, total_measured_ms: num(b.total_measured_ms), count: num(b.count), measured: num(b.measured),
    not_measured: num(b.not_measured), tickets_delayed: num(b.tickets_delayed), median_ms: num(b.median_ms), p90_ms: num(b.p90_ms),
  };
}

export function readFlow(data: unknown, source: AnalyticsSource): FlowReply {
  const d = obj(data);
  const c = obj(d.coverage);
  const missing: FlowReply["missing"][number][] = [];
  if (!Array.isArray(d.stations)) missing.push("stations");
  if (!Array.isArray(d.waits)) missing.push("waits");
  if (!Array.isArray(d.bottlenecks)) missing.push("bottlenecks");
  if (!d.coverage || typeof d.coverage !== "object") missing.push("coverage");
  return {
    ...readEnvelope(d, source),
    stations: arr(d.stations).map(readStation).filter((x): x is StationFlow => x !== null),
    transitions: arr(d.transitions).map(readTransition).filter((x): x is FlowTransition => x !== null),
    waits: arr(d.waits).map(readWait),
    bottlenecks: arr(d.bottlenecks).map(readBottleneck).filter((x): x is Bottleneck => x !== null),
    coverage: { tickets: num(c.tickets), tickets_with_lifecycle: num(c.tickets_with_lifecycle), visits: num(c.visits), visits_measured: num(c.visits_measured) },
    unit: str(d.unit) ?? "ms",
    wait_kinds: strings(d.wait_kinds),
    missing,
  };
}

// -------------------------------------------------------------------------------- contributors

export function readContributor(v: unknown): ContributorItem | null {
  const c = obj(v);
  const ref = str(c.ref);
  if (!ref || !/^[a-z]+:.+/.test(ref)) return null;
  return {
    ref,
    span_id: str(c.span_id),
    ticket: str(c.ticket),
    cell: str(c.cell),
    execution: str(c.execution),
    value: num(c.value),
    min_ms: num(c.min_ms),
    max_ms: num(c.max_ms),
    unit: str(c.unit) ?? "",
    basis: readBasis(c.basis),
    at_ms: num(c.at_ms),
    from_ms: num(c.from_ms),
    to_ms: num(c.to_ms),
    risk: str(c.risk),
    app_type: str(c.app_type),
    wave: str(c.wave),
    group: codes(c.group),
  };
}

export function readContributors(data: unknown, source: AnalyticsSource): ContributorsReply {
  const d = obj(data);
  if (!Array.isArray(d.items)) throw new AnalyticsProtocolError("The contributors reply carries no items.");
  const f = d.figure && typeof d.figure === "object" ? obj(d.figure) : null;
  return {
    ...readEnvelope(d, source),
    metric: str(d.metric) ?? "",
    figure: f ? { id: str(f.id) ?? "", catalog: f.catalog === true, entities: str(f.entities), unit: str(f.unit) ?? "", dimensions: strings(f.dimensions) } : null,
    group: codes(d.group),
    items: d.items.map(readContributor).filter((x): x is ContributorItem => x !== null),
    total: num(d.total),
    truncated: d.truncated === true,
    by_basis: counts(d.by_basis),
    order: oneOf(d.order, ["impact", "recent"] as const),
    limit: num(d.limit),
    after_as_of: 0,
  };
}

// ---------------------------------------------------------------------------------------- runs

export function readStamp(v: unknown): Stamp | null {
  if (typeof v === "number" && Number.isFinite(v)) return { at_ms: v, not_before_ms: null, not_after_ms: null, precision: null, authority: null };
  if (!v || typeof v !== "object") return null;
  const s = obj(v);
  // `ms` is the fixture's older shape.
  return { at_ms: num(s.at_ms) ?? num(s.ms), not_before_ms: num(s.not_before_ms), not_after_ms: num(s.not_after_ms), precision: str(s.precision), authority: str(s.authority) };
}

function readUsage(v: unknown): UsageFacts {
  const u = obj(v);
  return {
    recorded: u.recorded === true,
    complete: bool(u.complete),
    incomplete_reasons: strings(u.incomplete_reasons),
    sources: strings(u.sources),
    cost_usd: num(u.cost_usd),
    cost_source: str(u.cost_source),
    supervisor_cost_usd: num(u.supervisor_cost_usd),
    tokens_total: num(u.tokens_total),
    models: strings(u.models),
  };
}

export function readExecution(v: unknown): ExecutionItem | null {
  const x = obj(v);
  const id = str(x.execution_id);
  if (!id) return null;
  const prov = x.provenance && typeof x.provenance === "object" ? obj(x.provenance) : null;
  const recorded = x.provenance_recorded === true && prov !== null;
  return {
    execution_id: id,
    ticket_id: str(x.ticket_id),
    state: str(x.state) ?? "unknown",
    attempt: num(x.attempt),
    started_ms: num(x.started_ms),
    risk: str(x.risk),
    app_type: str(x.app_type),
    wave: str(x.wave),
    usage: readUsage(x.usage),
    config_id: prov ? str(prov.config_id) : null,
    provenance_recorded: recorded,
    provenance_reason: recorded ? null : (oneOf(x.provenance_reason, ["not-recorded", "capture-failed", "not-understood"] as const)),
    source_commit: str(x.source_commit),
    provenance: prov,
  };
}

export function readRun(v: unknown): RunItem | null {
  const r = obj(v);
  const ticket = str(r.ticket_id);
  if (!ticket) return null;
  return {
    ticket_id: ticket,
    slice_id: str(r.slice_id),
    record_version: num(r.record_version),
    outcome: oneOf(r.outcome, ["merged", "abandoned"] as const),
    rounds: num(r.rounds),
    first_pass: bool(r.first_pass),
    verify_failures: num(r.verify_failures),
    review_rejections: num(r.review_rejections),
    escalated: bool(r.escalated),
    human_approval: bool(r.human_approval),
    deviations: num(r.deviations),
    blockers: num(r.blockers),
    tests_seen_failing_first: num(r.tests_seen_failing_first),
    tests_passing_on_first_run: num(r.tests_passing_on_first_run),
    risk: str(r.risk),
    app_type: str(r.app_type),
    wave: str(r.wave),
    merge_method: str(r.merge_method),
    merge_commit: str(r.merge_commit),
    closed_at: readStamp(r.closed_at),
    executions: arr(r.executions).map(readExecution).filter((x): x is ExecutionItem => x !== null),
  };
}

export function readRuns(data: unknown, source: AnalyticsSource): RunsReply | ExecutionsReply {
  const d = obj(data);
  if (!Array.isArray(d.items)) throw new AnalyticsProtocolError("The runs reply carries no items.");
  const common = { ...readEnvelope(d, source), total: num(d.total), offset: num(d.offset), more: d.more === true, excluded: readExcluded(d.excluded), after_as_of: 0 };
  if (d.of === "executions") return { ...common, of: "executions", items: d.items.map(readExecution).filter((x): x is ExecutionItem => x !== null) };
  return { ...common, of: "runs", items: d.items.map(readRun).filter((x): x is RunItem => x !== null) };
}

// ------------------------------------------------------------------------------------ insights

const SEVERITIES = ["attention", "note"] as const;

function readMeasurement(v: unknown): InsightMeasurement | null {
  const m = obj(v);
  const metric = str(m.metric);
  if (!metric) return null;
  const c = m.coverage && typeof m.coverage === "object" ? obj(m.coverage) : null;
  return {
    metric,
    label: str(m.label),
    value: num(m.value),
    unit: str(m.unit),
    numerator: num(m.numerator),
    denominator: num(m.denominator),
    sample_count: num(m.sample_count),
    coverage: c ? { eligible: num(c.eligible), counted: num(c.counted), share: num(c.share) } : null,
    window: oneOf(m.window, ["selection", "later", "earlier"] as const),
    display: str(m.display),
  };
}

export function readInsight(v: unknown): Insight | null {
  const i = obj(v);
  const rule = str(i.rule);
  if (!rule) return null;
  const w = obj(i.window);
  const cmp = w.comparison && typeof w.comparison === "object" ? obj(w.comparison) : null;
  const sm = i.sample && typeof i.sample === "object" ? obj(i.sample) : null;
  const inv = i.investigation && typeof i.investigation === "object" ? obj(i.investigation) : null;
  const c = i.contributors && typeof i.contributors === "object" ? obj(i.contributors) : null;
  return {
    id: str(i.id) ?? rule,
    rule,
    subject: str(i.subject),
    severity: oneOf(i.severity, SEVERITIES),
    title: str(i.title) ?? rule,
    condition: str(i.condition),
    threshold: str(i.threshold),
    measurements: arr(i.measurements).map(readMeasurement).filter((x): x is InsightMeasurement => x !== null),
    sample: sm ? { count: num(sm.count), unit: str(sm.unit), coverage_share: num(sm.coverage_share), population: str(sm.population) } : null,
    window: { from_ms: num(w.from_ms), to_ms: num(w.to_ms), last_runs: num(w.last_runs), comparison: cmp ? { from_ms: num(cmp.from_ms), to_ms: num(cmp.to_ms) } : null },
    filters: codes(i.filters),
    why: str(i.why),
    investigation: inv && str(inv.text) ? { label: str(inv.label) ?? "", text: inv.text as string } : null,
    contributors:
      c && str(c.metric)
        ? { metric: c.metric as string, group: codes(c.group), order: oneOf(c.order, ["impact", "recent"] as const), limit: num(c.limit), path: str(c.path), relation: str(c.relation), note: str(c.note) }
        : null,
  };
}

export function readInsights(data: unknown, source: AnalyticsSource): InsightsReply {
  const d = obj(data);
  if (!Array.isArray(d.insights)) throw new AnalyticsProtocolError("The insights reply carries no insights.");
  const insight_rules: InsightRule[] = [];
  for (const v of arr(d.rules)) {
    const r = obj(v);
    const id = str(r.id);
    if (id) insight_rules.push({ id, severity: oneOf(r.severity, SEVERITIES), condition: str(r.condition), threshold: str(r.threshold), minimum: str(r.minimum), metrics: strings(r.metrics) });
  }
  return {
    ...readEnvelope(d, source),
    rules: [],
    insights: d.insights.map(readInsight).filter((x): x is Insight => x !== null),
    not_evaluated: arr(d.not_evaluated).map((v) => ({ rule: str(obj(v).rule) ?? "unknown", subject: str(obj(v).subject), reason: str(obj(v).reason) ?? "" })),
    insight_rules,
    notice: str(d.notice),
    investigation_label: str(d.investigation_label),
  };
}

// ------------------------------------------------------------------------ concurrency, freshness

/** `/api/v1/concurrency`: per span kind, each bucket's `max`; a bucket the reply does not hold is null (not 0). */
export function readConcurrencyReply(data: unknown, source: AnalyticsSource, asked: { readonly fromMs: number; readonly toMs: number; readonly bucketMs: number }): ConcurrencyReply {
  const d = obj(data);
  const from = num(d.from_ms) ?? asked.fromMs;
  const to = num(d.to_ms) ?? asked.toMs;
  const bucket = num(d.bucket_ms) ?? asked.bucketMs;
  if (!(bucket > 0) || !(to > from)) throw new AnalyticsProtocolError("The concurrency reply has no usable range.");
  const n = Math.ceil((to - from) / bucket);
  const lines = new Map<string, (number | null)[]>();
  const held = new Set<number>();
  for (const raw of arr(d.buckets)) {
    const b = obj(raw);
    const at = num(b.from_ms);
    if (at === null) continue;
    const i = Math.floor((at - from) / bucket);
    if (i < 0 || i >= n) continue;
    held.add(i);
    for (const [kind, v] of Object.entries(obj(b.active))) {
      const max = num(obj(v).max);
      if (max === null) continue;
      if (!lines.has(kind)) lines.set(kind, new Array<number | null>(n).fill(null));
      lines.get(kind)![i] = max;
    }
  }
  // Within a bucket the reply holds, a kind it does not list had none active: 0 is recorded there, not assumed elsewhere.
  for (const counts of lines.values()) for (const i of held) if (counts[i] === null) counts[i] = 0;
  const limits: ConcurrencyReply["limits"][number][] = [];
  for (const raw of arr(d.limits)) {
    const l = obj(raw);
    const name = str(l.name);
    const value = num(l.value);
    const lf = num(l.from_ms);
    if (!name || value === null || lf === null) continue;
    limits.push({ name, value, from_ms: lf, to_ms: num(l.to_ms), applies_to: Array.isArray(l.applies_to) ? strings(l.applies_to) : null });
  }
  return { source, cursor: str(d.cursor), from_ms: from, to_ms: to, bucket_ms: bucket, lines: [...lines].map(([kind, max]) => ({ kind, max })), limits, complete: bool(d.complete) };
}

const SOURCE_OF: readonly (readonly [RegExp, FreshnessSource])[] = [
  [/^ledger$/, "intake log"],
  [/^cell\//, "cell lifecycle"],
  [/^stream\//, "execution stream"],
  [/^runs$/, "run records"],
];
const NOT_FOLLOWED: Readonly<Record<FreshnessSource, string>> = {
  "intake log": "the observer follows no intake log in this project",
  "cell lifecycle": "the observer follows no open cell's lifecycle log (finished cells are read from the archive)",
  "execution stream": "the observer follows no execution stream in this project",
  "run records": "the observer follows no run records file in this project",
  // The supervisor's execution records are events of the intake log; there is no file of their own.
  "execution records": "execution records are events of the intake log; the observer reports no separate read time for them",
};

/** When each kind of source was last read, from `/factory/status` (`readAt` and each source's `lastReadAgeMs`, as the client reads them). */
export function readFreshness(
  status: { readonly readAt: number | null; readonly ingest: { readonly watermark: number | null }; readonly sources: readonly { readonly key: string; readonly state: string | null; readonly lagBytes: number | null; readonly lastReadAgeMs: number | null }[] },
  source: AnalyticsSource,
): FreshnessReply {
  const acc = new Map<FreshnessSource, { files: number; last: number | null; lag: number | null; states: Record<string, number> }>();
  for (const s of status.sources) {
    const kind = SOURCE_OF.find(([re]) => re.test(s.key))?.[1];
    if (!kind) continue;
    const a = acc.get(kind) ?? { files: 0, last: null, lag: null, states: {} };
    a.files += 1;
    const read = status.readAt !== null && s.lastReadAgeMs !== null ? status.readAt - s.lastReadAgeMs : null;
    if (read !== null && (a.last === null || read > a.last)) a.last = read;
    if (s.lagBytes !== null) a.lag = (a.lag ?? 0) + s.lagBytes;
    const st = s.state ?? "unknown";
    a.states[st] = (a.states[st] ?? 0) + 1;
    acc.set(kind, a);
  }
  const all: FreshnessSource[] = ["intake log", "cell lifecycle", "execution stream", "run records", "execution records"];
  const sources: SourceFreshness[] = all.map((kind) => {
    const a = acc.get(kind);
    return a
      ? { source: kind, files: a.files, last_read_ms: a.last, lag_bytes: a.lag, states: a.states, reason: a.last === null ? "the observer did not say when it last read these" : null }
      : { source: kind, files: null, last_read_ms: null, lag_bytes: null, states: {}, reason: NOT_FOLLOWED[kind] };
  });
  return { source, read_at_ms: status.readAt, watermark_ms: status.ingest.watermark, sources };
}

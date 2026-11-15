/**
 * FIXTURE ONLY: a stand-in for the observer's analytics reads over a simulated history. It folds the
 * facts into aggregate cells the way apps/observer/internal/metrics does (counts, sums, min, max and
 * the same 64-bucket log histogram, p50 and p90 read as the bucket's upper bound; an empty
 * denominator is null with a reason) and returns an `AnalyticsSnapshot`.
 *
 * It is not a second metric engine for the product: nothing outside `fixtures/` imports it except
 * the development proof page. In production every number comes from the observer.
 *
 * Filters: `risk` and `app_type` narrow every ticket-derived fact (PROPOSED: the observer keeps one
 * dimension per cell today); `model` narrows only what is recorded per model (K2, K3, K7, K8, K10).
 */
import {
  contributorKey, groupedKey, STATIONS,
  type AnalyticsFilters, type AnalyticsSnapshot, type Basis, type BasisCounts, type Contributor, type ContributorPage, type Coverage, type Dimension,
  type Distribution, type MetricGroup, type MetricId, type MetricRow, type RunRecord, type SourceFreshness, type Station, type Transition,
} from "../contract";
import type { EntityRef } from "../../sim/model";
import { CATALOG, defOf } from "./catalog";
import { generateHistory, FIXTURE_END, rng, type FxHistory, type FxTicket, type HistoryOptions } from "./facts";

const D = 86_400_000;
export const BUCKETS = 64;

// ------------------------------------------------------------------- aggregate cells, as metrics.go

interface Agg { num: number; den: number; count: number; sum: number; min: number | null; max: number | null; hist: number[] | null; covered: number; of: number; open: number; unknown: number }
const agg = (): Agg => ({ num: 0, den: 0, count: 0, sum: 0, min: null, max: null, hist: null, covered: 0, of: 0, open: 0, unknown: 0 });

/** Why members were left out of a covered metric's value (query.go `Excluded` reasons, in the fixture's words). */
const COVER_REASON: Partial<Record<MetricId, string>> = {
  T1: "the cell kept no lifecycle log",
  K1: "no result: the run reported no cost",
  K2: "the stream carried no per-model usage",
  K3: "the stream carried no per-model usage",
  K4: "no execution of the ticket recorded a cost",
};
const EX_OPEN = "open: started and not yet ended";
const EX_UNKNOWN = "unknown: an end's time, or its start, was not recorded";

/** metrics.go `bucket`. */
export function bucketOf(ms: number): number {
  if (ms < 1000) return 0;
  const b = Math.floor(3 * Math.log2(ms / 1000)) + 1;
  return Math.min(Math.max(b, 1), BUCKETS - 1);
}
/** metrics.go `upper`. */
export const bucketUpper = (b: number): number => (b === 0 ? 1000 : 1000 * 2 ** (b / 3));
function quantile(h: readonly number[], count: number, q: number): number | undefined {
  if (count === 0) return undefined;
  const target = Math.ceil(q * count);
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i]!;
    if (seen >= target) return Math.round(bucketUpper(i));
  }
  return undefined;
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;

class Table {
  readonly cells = new Map<MetricId, Map<string, Agg>>();
  private each(id: MetricId, groups: readonly string[], f: (a: Agg) => void) {
    let m = this.cells.get(id);
    if (!m) this.cells.set(id, (m = new Map()));
    for (const g of ["", ...groups]) {
      let a = m.get(g);
      if (!a) m.set(g, (a = agg()));
      f(a);
    }
  }
  rate(id: MetricId, g: readonly string[], num: number, den: number) { this.each(id, g, (a) => { a.num += num; a.den += den; }); }
  count(id: MetricId, g: readonly string[], n = 1) { this.each(id, g, (a) => { a.num += n; }); }
  cover(id: MetricId, g: readonly string[], covered: boolean) { this.each(id, g, (a) => { a.of++; if (covered) a.covered++; }); }
  duration(id: MetricId, g: readonly string[], ms: number) {
    const b = bucketOf(ms);
    this.each(id, g, (a) => {
      a.count++;
      a.sum += ms;
      a.min = a.min === null ? ms : Math.min(a.min, ms);
      a.max = a.max === null ? ms : Math.max(a.max, ms);
      (a.hist ??= new Array(BUCKETS).fill(0))[b]++;
    });
  }
  /** A member with no measured duration, counted apart (never averaged in). */
  unmeasured(id: MetricId, g: readonly string[], basis: "open" | "unknown") { this.each(id, g, (a) => { a[basis]++; }); }
  touch(id: MetricId) { if (!this.cells.has(id)) this.cells.set(id, new Map()); }
}

function distributionOf(a: Agg): Distribution | undefined {
  if (!a.hist || a.count === 0) return undefined;
  const q = (x: number) => quantile(a.hist!, a.count, x) ?? null;
  const clamp = (v: number | null) => (v === null ? null : Math.min(a.max!, Math.max(a.min!, v)));
  return {
    p10: clamp(q(0.1)), p25: clamp(q(0.25)), p50: clamp(q(0.5)), p75: clamp(q(0.75)), p90: clamp(q(0.9)), min: a.min, max: a.max,
    histogram: a.hist.flatMap((n, b) => (n ? [{ ge_ms: b === 0 ? 0 : Math.round(bucketUpper(b - 1)), le_ms: Math.round(bucketUpper(b)), count: n }] : [])),
    percentile_basis: "histogram",
    over: "measured members only",
  };
}

function coverageOf(id: MetricId, a: Agg | undefined): Coverage {
  if (!a) return { covered: null, of: null, share: null, reason: "coverage is not tracked for this metric" };
  if (a.of > 0) {
    const missing = a.of - a.covered;
    return { covered: a.covered, of: a.of, share: round3(a.covered / a.of), eligible: a.of, counted: a.covered, excluded: missing ? [{ reason: COVER_REASON[id] ?? "no source record", count: missing }] : [] };
  }
  if (a.open || a.unknown) {
    const excluded = [...(a.open ? [{ reason: EX_OPEN, count: a.open }] : []), ...(a.unknown ? [{ reason: EX_UNKNOWN, count: a.unknown }] : [])];
    const eligible = a.count + a.open + a.unknown;
    return { covered: a.count, of: eligible, share: round3(a.count / eligible), eligible, counted: a.count, excluded };
  }
  return { covered: null, of: null, share: null, reason: "coverage is not tracked for this metric" };
}

function valueOf(id: MetricId, kind: MetricRow["kind"], a: Agg | undefined): MetricGroup {
  const none = { sample_count: null, basis_counts: null, coverage: coverageOf(id, a) } as const;
  if (!a) return { key: "", value: null, numerator: null, denominator: null, null_reason: "no events of this kind have been observed", ...none };
  const bc: BasisCounts | null = kind === "duration" ? { measured: a.count, bounded: 0, inferred: 0, open: a.open, unknown: a.unknown, not_recorded: 0 } : null;
  switch (kind) {
    case "count":
      return { key: "", value: a.num, numerator: a.num, denominator: null, sample_count: a.num, basis_counts: null, coverage: coverageOf(id, a) };
    case "rate":
    case "mean":
      return a.den === 0
        ? { key: "", value: null, numerator: round3(a.num), denominator: a.den, null_reason: "the denominator is empty", sample_count: 0, basis_counts: null, coverage: coverageOf(id, a) }
        : { key: "", value: round3(a.num / a.den), numerator: round3(a.num), denominator: a.den, sample_count: a.den, basis_counts: null, coverage: coverageOf(id, a) };
    case "duration": {
      if (a.count === 0) return { key: "", value: null, numerator: a.sum, denominator: a.count, null_reason: "no measured durations", sample_count: 0, basis_counts: bc, coverage: coverageOf(id, a) };
      const dist = distributionOf(a)!;
      return { key: "", value: Math.round(a.sum / a.count), numerator: a.sum, denominator: a.count, p50_ms: dist.p50 ?? undefined, p90_ms: dist.p90 ?? undefined, min_ms: a.min!, max_ms: a.max!, sample_count: a.count, basis_counts: bc, coverage: coverageOf(id, a), distribution: dist };
    }
  }
}

const FILTER_DIMS = ["risk", "app_type", "model"] as const;

function rowOf(t: Table, id: MetricId, filters: AnalyticsFilters, groupBy?: Dimension): MetricRow {
  const d = defOf(id);
  const base = {
    id, name: d.name, kind: d.kind, unit: d.unit ?? "", numerator: d.numerator ?? "", denominator: d.denominator ?? "", dimensions: d.dimensions ?? null,
    source: d.source, authority: d.authority ?? "", limitations: d.limitations ?? "", availability: d.availability,
    ...(d.target ? { target: d.target } : {}), ...(d.parity_with ? { parity_with: d.parity_with } : {}),
    family: id.replace(/[0-9b]+$/, ""), formula: d.numerator ? `${d.numerator} / ${d.denominator}` : "", population: d.denominator ?? "", sources: [d.source],
  } as const;
  if (d.unavailable) {
    return { ...base, value: null, numerator_value: null, denominator_value: null, basis: d.availability === "no" ? "not-recorded" : "unknown", null_reason: d.unavailable, status: d.deferred ? "deferred" : "not-recorded", status_reason: d.unavailable, sample_count: null, basis_counts: null, coverage: { covered: null, of: null, share: null, reason: "no value" } };
  }
  // A filter the metric cannot honour makes it unavailable, never silently unfiltered (M6_5_DESIGN.md 3).
  const unsupported = FILTER_DIMS.filter((k) => filters[k] && !(d.dimensions ?? []).includes(k));
  if (unsupported.length) {
    const reason = `not recorded by ${unsupported.map((k) => (k === "app_type" ? "app type" : k)).join(" or ")}, so it cannot be narrowed to ${unsupported.map((k) => filters[k]).join(", ")}`;
    return { ...base, value: null, numerator_value: null, denominator_value: null, basis: "unknown", null_reason: reason, status: "unavailable", status_reason: reason, sample_count: null, basis_counts: null, coverage: { covered: null, of: null, share: null, reason: "no value" } };
  }
  const cells = t.cells.get(id);
  const total = valueOf(id, d.kind, cells?.get(""));
  const basis: Basis = d.authority === "reconstructed" ? "inferred" : "measured";
  let met: boolean | undefined;
  let target_check: MetricRow["target_check"];
  if (d.target) {
    const [op, lim] = d.target.split(" ");
    if (total.value !== null) met = (op === "<" && total.value < Number(lim)) || (op === ">" && total.value > Number(lim));
    target_check = { value: Number(lim), direction: op === "<" ? "below" : "above", met: met ?? null };
  }
  const row: MetricRow = {
    ...base,
    value: total.value, numerator_value: total.numerator, denominator_value: total.denominator,
    ...(total.p50_ms !== undefined ? { p50_ms: total.p50_ms, p90_ms: total.p90_ms, min_ms: total.min_ms, max_ms: total.max_ms, distribution: total.distribution } : {}),
    ...(met !== undefined ? { met } : {}),
    ...(target_check ? { target_check } : {}),
    basis,
    ...(total.null_reason ? { null_reason: total.null_reason } : {}),
    status: d.partial ? "partial" : "available",
    ...(d.partial ? { status_reason: d.partial } : {}),
    sample_count: total.sample_count,
    basis_counts: total.basis_counts,
    coverage: total.coverage,
    suspect: false,
  };
  if (!groupBy) return row;
  const prefix = `${groupBy}=`;
  const groups = [...(cells?.keys() ?? [])]
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((k) => ({ ...valueOf(id, d.kind, cells!.get(k)), key: k.slice(prefix.length), keys: { [groupBy]: k.slice(prefix.length) } }));
  return { ...row, group_by: groupBy, group_dims: [groupBy], groups };
}

// --------------------------------------------------------------------------------------- snapshot

export interface SnapshotOptions extends HistoryOptions {
  /** "lifecycle-missing": a history whose cells kept no lifecycle log (before M6.1): station figures are not recorded. */
  readonly coverage?: "normal" | "lifecycle-missing";
}

const WINDOW_DAYS: Readonly<Record<AnalyticsFilters["window"], number | null>> = { "7d": 7, "14d": 14, "28d": 28, all: null };
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const histories = new Map<string, FxHistory>();

export function historyFor(opts: HistoryOptions = {}): FxHistory {
  const key = `${opts.seed ?? 6502}:${opts.size ?? "full"}`;
  let h = histories.get(key);
  if (!h) histories.set(key, (h = generateHistory(opts)));
  return h;
}

export function simulatedSnapshot(filters: AnalyticsFilters, opts: SnapshotOptions = {}): AnalyticsSnapshot {
  const h = historyFor(opts);
  const noLog = opts.coverage === "lifecycle-missing";
  const days = WINDOW_DAYS[filters.window];
  const to = FIXTURE_END;
  const from = days === null ? h.start : to - days * D;
  const inW = (t: number | null) => t !== null && t >= from && t < to;
  const keep = (tk: FxTicket) => (!filters.risk || tk.risk === filters.risk) && (!filters.app_type || tk.app === filters.app_type);
  const tickets = new Map(h.tickets.filter(keep).map((tk) => [tk.id, tk]));
  const has = (id: string) => tickets.has(id);
  const logged = (id: string) => !noLog && (tickets.get(id)?.lifecycle ?? false);
  const T = new Table();
  const C: Record<string, Contributor[]> = {};
  /** The fixture writes a label and a note for its own reading; the contract carries neither (no free text). */
  type Draft = { ref: EntityRef; label: string; ticket: string | null; value: number | null; basis: Basis; at_ms: number | null; note?: string | undefined };
  const contrib = (key: string, c: Draft) => {
    const id = key.split("|")[0] as MetricId;
    const tk = c.ticket ? h.tickets.find((x) => x.id === c.ticket) : undefined;
    const open = c.note?.startsWith("still") ?? false;
    (C[key] ??= []).push({
      ref: c.ref, ticket: c.ticket, cell: c.ticket, execution: c.ref.startsWith("execution:") ? c.ref.slice(10) : null,
      value: c.value, unit: defOf(id).unit ?? "", basis: open ? "open" : c.basis, at_ms: c.at_ms,
      from_ms: c.at_ms, to_ms: c.value !== null && c.at_ms !== null && defOf(id).kind === "duration" ? c.at_ms + c.value : null,
      risk: tk?.risk ?? null, app_type: tk?.app ?? null,
    });
  };
  const both = (id: MetricId, dim: Dimension, value: string, c: Draft) => { contrib(contributorKey(id), c); contrib(contributorKey(id, dim, value), c); };
  const cellRef = (ticket: string): EntityRef => `cell:${ticket}`;

  // Delivery: T1 merges (lifecycle), T2 integrations (intake log).
  for (const tk of tickets.values()) {
    if (inW(tk.mergedAt)) {
      if (logged(tk.id)) {
        T.count("T1", [`risk=${tk.risk}`, `app_type=${tk.app}`, `writer=${tk.writer}`, `day=${dayKey(tk.mergedAt!)}`]);
        contrib("T1", { ref: cellRef(tk.id), label: tk.id, ticket: tk.id, value: 1, basis: "measured", at_ms: tk.mergedAt });
      }
      T.cover("T1", [], logged(tk.id));
    }
    if (inW(tk.integratedAt) && tk.slice) {
      T.count("T2", [`wave=${tk.wave}`, `day=${dayKey(tk.integratedAt!)}`]);
      contrib("T2", { ref: `slice:${tk.slice}`, label: tk.slice, ticket: tk.id, value: 1, basis: "measured", at_ms: tk.integratedAt });
    }
  }
  T.touch("T1");
  T.touch("T2");

  // Station visits: C1 (measured durations only), C2.
  const visitsByTicket = new Map<string, number>();
  for (const v of h.visits) {
    if (!has(v.ticket) || !logged(v.ticket) || !inW(v.start) || v.station === "human") continue;
    visitsByTicket.set(v.ticket, (visitsByTicket.get(v.ticket) ?? 0) + 1);
    T.rate("C2", [`station=${v.station}`], 1, 0);
    const tk = tickets.get(v.ticket)!;
    const ref: EntityRef = `visit:${v.ticket}/${v.station}#${v.n}`;
    if (v.end !== null && v.ended !== "interrupted") {
      const ms = v.end - v.start;
      T.duration("C1", [`station=${v.station}`, `round=${v.round}`, `risk=${tk.risk}`, `day=${dayKey(v.start)}`], ms);
      both("C1", "station", v.station, { ref, label: `${v.ticket} ${v.station} #${v.n}`, ticket: v.ticket, value: ms, basis: "measured", at_ms: v.start, ...(v.round > 1 ? { note: `round ${v.round}` } : {}) });
    } else {
      T.unmeasured("C1", [`station=${v.station}`, `round=${v.round}`, `risk=${tk.risk}`], v.ended === "open" ? "open" : "unknown");
      both("C1", "station", v.station, { ref, label: `${v.ticket} ${v.station} #${v.n}`, ticket: v.ticket, value: null, basis: v.end === null && v.ended === "open" ? "unknown" : "unknown", at_ms: v.start, note: v.ended === "open" ? "still open: no exit yet" : "ended without an exit record (interrupted): not counted" });
    }
  }
  // C2's denominator: tickets with a log; every station's group shares it.
  const withLog = [...tickets.values()].filter((tk) => logged(tk.id) && (visitsByTicket.get(tk.id) ?? 0) > 0).length;
  const c2 = T.cells.get("C2");
  if (c2) for (const a of c2.values()) a.den = withLog;
  T.touch("C1");
  T.touch("C2");

  // End to end: C3 (product tickets, dispatch → merge), C4 (eligible → integrated).
  for (const tk of tickets.values()) {
    if (tk.slice && inW(tk.mergedAt) && logged(tk.id)) {
      const ms = tk.mergedAt! - tk.scheduledAt;
      T.duration("C3", [`risk=${tk.risk}`], ms);
      contrib("C3", { ref: cellRef(tk.id), label: tk.id, ticket: tk.id, value: ms, basis: "measured", at_ms: tk.mergedAt });
    }
    if (tk.slice && inW(tk.integratedAt)) {
      T.duration("C4", [`wave=${tk.wave}`], tk.integratedAt! - tk.eligibleAt);
      contrib("C4", { ref: `slice:${tk.slice}`, label: tk.slice, ticket: tk.id, value: tk.integratedAt! - tk.eligibleAt, basis: "measured", at_ms: tk.integratedAt });
    }
  }
  T.touch("C3");
  T.touch("C4");

  // Waits.
  const WAIT_METRIC = { dependency: "W1", queue: "W2", capacity: "W2b", human: "W3" } as const;
  for (const w of h.waits) {
    if (!has(w.ticket) || !inW(w.start)) continue;
    if (w.kind === "human" && !logged(w.ticket)) continue;
    const id = WAIT_METRIC[w.kind];
    const tk = tickets.get(w.ticket)!;
    const ref: EntityRef = w.kind === "human" ? `gate:${w.ticket}/review#${w.round ?? 1}` : w.kind === "dependency" ? `slice:${tk.slice}` : cellRef(w.ticket);
    if (w.end === null) {
      contrib(id, { ref, label: w.ticket, ticket: w.ticket, value: null, basis: "open", at_ms: w.start, note: "still waiting: no end recorded" });
      T.unmeasured(id, w.kind === "human" ? [`risk=${tk.risk}`] : [], "open");
      continue;
    }
    T.duration(id, w.kind === "human" ? [`risk=${tk.risk}`] : tk.wave ? [`wave=${tk.wave}`] : [], w.end - w.start);
    contrib(id, { ref, label: w.ticket, ticket: w.ticket, value: w.end - w.start, basis: id === "W2b" ? "inferred" : "measured", at_ms: w.start });
  }
  for (const id of ["W1", "W2", "W2b", "W3"] as const) T.touch(id);

  // Executions.
  const execs = h.executions.filter((e) => has(e.ticket) && inW(e.claimedAt));
  for (const e of execs) {
    const ref: EntityRef = `execution:${e.id}`;
    const label = `${e.ticket} attempt ${e.attempt}`;
    T.duration("W4", [], e.startedAt - e.claimedAt);
    if (e.outcome === "completed") T.duration("W5", [], e.observedAt - e.endedAt);
    T.rate("X1", [`stage=${e.stage}`], e.outcome === "failed" ? 1 : 0, 1);
    if (e.outcome === "failed") contrib("X1", { ref, label, ticket: e.ticket, value: 1, basis: "measured", at_ms: e.endedAt, note: "execution.failed: retried" });
    T.rate("S1", e.recovery ? [`kind=${e.recovery}`] : [], e.recovery ? 1 : 0, 1);
    if (e.recovery) contrib("S1", { ref, label, ticket: e.ticket, value: 1, basis: "measured", at_ms: e.endedAt, note: e.recovery === "interrupted" ? "interrupted, then recovered" : "outcome unknown" });
    T.rate("S2", [], e.outcome === "unknown" ? 1 : 0, 1);
    if (e.outcome === "unknown") contrib("S2", { ref, label, ticket: e.ticket, value: 1, basis: "unknown", at_ms: e.endedAt });
    if (e.outcome === "completed" || e.outcome === "failed") T.rate("S3", [`stage=${e.stage}`], e.outcome === "completed" ? 1 : 0, 1);
    if (e.parkedForPerson) {
      T.count("S4", []);
      contrib("S4", { ref, label, ticket: e.ticket, value: 1, basis: "measured", at_ms: e.endedAt, note: "parked for a person" });
    }
    for (const tool of e.refusedTools) T.count("S5", [`tool=${tool}`]);
    T.rate("S6", e.workflow === "finished" ? [] : [`stop_reason=${e.workflow === "killed-budget" ? "budget" : "stopped"}`], e.workflow === "finished" ? 0 : 1, 1);
    // K1: recorded cost, coverage = executions with a result.
    T.cover("K1", [`day=${dayKey(e.claimedAt)}`], e.costUsd !== null);
    if (e.costUsd !== null) T.rate("K1", [`stage=${e.stage}`, `day=${dayKey(e.claimedAt)}`], e.costUsd, 1);
    else T.rate("K1", [`day=${dayKey(e.claimedAt)}`], 0, 0);
    contrib("K1", { ref, label, ticket: e.ticket, value: e.costUsd, basis: e.costUsd === null ? "not-recorded" : "measured", at_ms: e.claimedAt, ...(e.costUsd === null ? { note: "no result: cost not recorded" } : e.workflow === "killed-budget" ? { note: "killed at its budget: reported cost may be low" } : {}) });
    // K2, K3 from the stream's per-model usage.
    T.cover("K2", [], e.usage !== null);
    T.cover("K3", [], e.usage !== null);
    for (const u of e.usage ?? []) {
      if (filters.model && u.model !== filters.model) continue;
      T.rate("K2", [`model=${u.model}`], u.costUsd, 1);
      const kinds = { input: u.input, output: u.output, cache_read: u.cacheRead, cache_creation: u.cacheCreate } as const;
      T.rate("K3", [`model=${u.model}`], u.input + u.output + u.cacheRead + u.cacheCreate, 1);
      for (const [k, n] of Object.entries(kinds)) {
        const c = T.cells.get("K3")!;
        const key = `token_kind=${k}`;
        if (!c.has(key)) c.set(key, agg());
        c.get(key)!.num += n;
        c.get(key)!.den += 1;
      }
    }
    // Agents (stream): K7–K10.
    for (const g of e.agents) {
      if (filters.model && g.model !== filters.model) continue;
      const st = g.station ? [`station=${g.station}`] : [];
      if (g.tokens !== null) T.rate("K7", [...st, ...(g.seat ? [`seat=${g.seat}`] : []), `model=${g.model}`, `phase=${g.phase}`], g.tokens, 1);
      T.duration("K8", [...st, ...(g.seat ? [`seat=${g.seat}`] : []), `model=${g.model}`], g.durMs);
      if (g.station) contrib(contributorKey("K8", "station", g.station), { ref: g.id as EntityRef, label: `${e.ticket} ${g.station}${g.seat ? ` ${g.seat}` : ""}`, ticket: e.ticket, value: g.durMs, basis: "measured", at_ms: g.start });
      T.duration("K9", [`phase=${g.phase}`], Math.max(1, g.queuedMs));
      if (g.toolCalls !== null) T.rate("K10", [...st, `model=${g.model}`], g.toolCalls, 1);
    }
  }
  for (const id of ["W4", "W5", "X1", "S1", "S2", "S3", "S4", "S5", "S6", "K1", "K2", "K3", "K7", "K8", "K9", "K10"] as const) T.touch(id);
  // K4: per ticket.
  const perTicket = new Map<string, { sum: number; any: boolean; missing: number }>();
  for (const e of execs) {
    const p = perTicket.get(e.ticket) ?? { sum: 0, any: false, missing: 0 };
    if (e.costUsd !== null) { p.sum += e.costUsd; p.any = true; } else p.missing++;
    perTicket.set(e.ticket, p);
  }
  for (const [ticket, p] of perTicket) {
    T.cover("K4", [], p.any);
    if (p.any) T.rate("K4", [`ticket=${ticket}`], p.sum, 1);
    contrib("K4", { ref: cellRef(ticket), label: ticket, ticket, value: p.any ? Math.round(p.sum * 100) / 100 : null, basis: p.any ? "measured" : "not-recorded", at_ms: null, ...(p.missing ? { note: `${p.missing} execution${p.missing > 1 ? "s" : ""} without a recorded cost` } : {}) });
  }
  T.touch("K4");

  // Rounds: Q1, Q4, R1, R2, R3.
  for (const x of h.rounds) {
    if (!has(x.ticket) || !logged(x.ticket) || !inW(x.at)) continue;
    const tk = tickets.get(x.ticket)!;
    if (x.round === 1 && x.verify) {
      T.rate("Q1", [`risk=${tk.risk}`, `day=${dayKey(x.at)}`], x.verify === "PASS" ? 1 : 0, 1);
      contrib("Q1", { ref: `gate:${x.ticket}/verify#1`, label: x.ticket, ticket: x.ticket, value: x.verify === "PASS" ? 1 : 0, basis: "measured", at_ms: x.at, note: x.verify === "PASS" ? "passed first time" : "failed with evidence" });
    }
    for (const k of x.failedChecks) {
      T.count("Q4", [`target_kind=${k}`]);
      both("Q4", "target_kind", k, { ref: `gate:${x.ticket}/verify#${x.round}`, label: `${x.ticket} round ${x.round}`, ticket: x.ticket, value: 1, basis: "measured", at_ms: x.at });
    }
    if (x.review && x.review !== "AWAITING_HUMAN") {
      const rej = x.review === "REJECTED" || x.review === "ESCALATE";
      T.rate("R1", [`risk=${tk.risk}`, `round=${x.round}`], rej ? 1 : 0, 1);
      if (rej) contrib("R1", { ref: `gate:${x.ticket}/review#${x.round}`, label: `${x.ticket} round ${x.round}`, ticket: x.ticket, value: 1, basis: "measured", at_ms: x.at, note: x.review === "ESCALATE" ? "escalated" : "rejected" });
      if (tk.risk !== "low") T.rate("R3", [`risk=${tk.risk}`], x.securityVeto ? 1 : 0, 1);
    } else if (x.review === "AWAITING_HUMAN") {
      T.rate("R1", [`risk=${tk.risk}`, `round=${x.round}`], 0, 1);
      T.rate("R3", [`risk=${tk.risk}`], 0, 1);
    }
    for (const b of x.blockers) {
      T.count("R2", [`rule=${b.rule}`, `seat=${b.seat}`]);
      both("R2", "rule", b.rule, { ref: `finding:${x.ticket}/r${x.round}/${b.seat}`, label: `${x.ticket} round ${x.round}`, ticket: x.ticket, value: 1, basis: "inferred", at_ms: x.at, note: `${b.seat} seat` });
    }
  }
  for (const id of ["Q1", "Q4", "R1", "R2", "R3"] as const) T.touch(id);

  // Gates: X2, X3.
  for (const g of h.gates) {
    if (!has(g.ticket) || !logged(g.ticket) || !inW(g.at)) continue;
    if (g.verdict === "overridden") {
      T.rate("X3", [`gate=${g.gate}`], 1, 0);
      continue;
    }
    T.rate("X2", [`gate=${g.gate}`, `station=${g.station}`, ...(g.reason ? [`reason_code=${g.reason}`] : [])], g.verdict === "refused" ? 1 : 0, 1);
    if (g.verdict === "refused") both("X2", "station", g.station, { ref: `gate:${g.ticket}/${g.station}`, label: `${g.ticket} ${g.gate}`, ticket: g.ticket, value: 1, basis: "measured", at_ms: g.at, note: g.reason ?? undefined });
  }
  const buildTasks = h.visits.filter((v) => v.station === "build" && has(v.ticket) && logged(v.ticket) && inW(v.start) && v.end !== null).length * 4;
  const x3 = T.cells.get("X3");
  if (x3) for (const a of x3.values()) a.den = buildTasks;
  else T.rate("X3", [], 0, buildTasks);
  T.touch("X2");

  // Run records (runs.jsonl), and the observe scorecard over them: Q2, Q3, R5, R6, G1, G2.
  const runs: RunRecord[] = [];
  for (const tk of tickets.values()) {
    if (!inW(tk.closedAt)) continue;
    const outcome = tk.outcome === "merged" || tk.outcome === "escalated-merged" ? "merged" : "abandoned";
    const escalated = tk.outcome.startsWith("escalated");
    const tkRounds = h.rounds.filter((x) => x.ticket === tk.id);
    runs.push({
      ticket_id: tk.id, ...(tk.slice ? { slice_id: tk.slice } : {}), record_version: 2, outcome, rounds: outcome === "merged" ? tk.rounds : tk.rounds, first_pass: tk.firstPass && outcome === "merged",
      verify_failures: tkRounds.filter((x) => x.verify === "FAIL_WITH_EVIDENCE").length, review_rejections: tkRounds.filter((x) => x.review === "REJECTED" || x.review === "ESCALATE").length,
      escalated, human_approval: tk.humanApproval, deviations: tk.deviations, blockers: tkRounds.reduce((s, x) => s + x.blockers.length, 0),
      tests_seen_failing_first: tk.testsFailFirst, tests_passing_on_first_run: tk.testsPassFirst, risk: tk.risk, app_type: tk.app,
      ...(outcome === "merged" ? { merge_method: tk.mergeMethod, merge_commit: hash7(tk.id) } : {}), closed_at: { ms: tk.closedAt! }, event_id: `ev-run-${tk.id}`,
    });
  }
  runs.sort((a, b) => a.closed_at!.ms - b.closed_at!.ms);
  for (const run of runs) {
    const g = [`risk=${run.risk}`, `app_type=${run.app_type}`, `day=${dayKey(run.closed_at!.ms)}`];
    const merged = run.outcome === "merged";
    const ref = cellRef(run.ticket_id);
    if (merged) {
      T.rate("Q2", g, run.first_pass ? 1 : 0, 1);
      contrib("Q2", { ref, label: run.ticket_id, ticket: run.ticket_id, value: run.first_pass ? 1 : 0, basis: "measured", at_ms: run.closed_at!.ms, note: run.first_pass ? "first pass" : `${run.rounds} rounds` });
      if (run.rounds !== null) T.rate("Q3", g, run.rounds, 1);
    }
    T.rate("R5", [`risk=${run.risk}`], run.escalated ? 1 : 0, 1);
    if (run.escalated) contrib("R5", { ref, label: run.ticket_id, ticket: run.ticket_id, value: 1, basis: "measured", at_ms: run.closed_at!.ms, note: merged ? "escalated, merged by a person" : "escalated, abandoned" });
    T.rate("R6", [], run.outcome === "abandoned" ? 1 : 0, 1);
    T.rate("G1", [`risk=${run.risk}`], run.tests_seen_failing_first, run.tests_seen_failing_first + run.tests_passing_on_first_run);
    T.rate("G2", [], run.deviations, 1);
  }
  for (const id of ["Q2", "Q3", "R5", "R6", "G1", "G2"] as const) T.touch(id);

  // G3: evidence integrity (reconstructed by the observer).
  const r = rng(h.seed + 7);
  const verifies = h.visits.filter((v) => v.station === "verify" && has(v.ticket) && logged(v.ticket) && inW(v.start) && v.end !== null).length;
  const catalogued = verifies * 4;
  T.rate("G3", [], catalogued - Math.floor(r() * 3), catalogued);

  // Rows.
  const totals: Partial<Record<MetricId, MetricRow>> = {};
  for (const d of CATALOG) totals[d.id] = rowOf(T, d.id, filters);
  const grouped: Record<string, MetricRow> = {};
  const G: readonly (readonly [MetricId, Dimension])[] = [
    ["T1", "day"], ["T1", "risk"], ["T1", "writer"], ["T2", "day"], ["T2", "wave"], ["C1", "station"], ["C1", "round"], ["C1", "risk"], ["C2", "station"], ["C3", "risk"],
    ["W3", "risk"], ["Q1", "risk"], ["Q1", "day"], ["Q2", "day"], ["Q2", "risk"], ["Q2", "app_type"], ["Q3", "risk"], ["Q4", "target_kind"], ["R1", "round"], ["R1", "risk"], ["R2", "rule"], ["R2", "seat"], ["R3", "risk"],
    ["R5", "risk"], ["G1", "risk"], ["X1", "stage"], ["X2", "station"], ["X2", "gate"], ["X2", "reason_code"], ["X3", "gate"], ["S1", "kind"], ["S3", "stage"], ["S5", "tool"], ["S6", "stop_reason"],
    ["K1", "day"], ["K1", "stage"], ["K2", "model"], ["K3", "model"], ["K3", "token_kind"], ["K4", "ticket"], ["K7", "station"], ["K7", "model"], ["K8", "station"], ["K8", "model"], ["K8", "seat"], ["K9", "phase"], ["K10", "station"], ["K10", "model"],
  ];
  for (const [id, dim] of G) grouped[groupedKey(id, dim)] = rowOf(T, id, filters, dim);
  // Station visits for a cell with no lifecycle log: C1, C2, Q1… say "not recorded".
  if (noLog) {
    for (const d of CATALOG) {
      if (d.availability !== "lifecycle") continue;
      const nr = { value: null, numerator_value: null, denominator_value: null, basis: "not-recorded" as const, null_reason: "not recorded: no cell in this history kept a lifecycle log (cells before M6.1 record no station visits)", coverage: { covered: 0, of: tickets.size, share: 0 } };
      totals[d.id] = { ...totals[d.id]!, ...nr, status: "not-recorded", status_reason: nr.null_reason, sample_count: null, basis_counts: null, p50_ms: undefined, p90_ms: undefined, min_ms: undefined, max_ms: undefined, distribution: undefined };
      for (const k of Object.keys(grouped)) if (k.startsWith(`${d.id}|`)) grouped[k] = { ...grouped[k]!, ...nr, groups: [] };
    }
  }

  const contributors: Record<string, ContributorPage> = {};
  for (const [k, items] of Object.entries(C)) {
    if (totals[k.split("|")[0] as MetricId]?.status === "unavailable" || totals[k.split("|")[0] as MetricId]?.basis === "not-recorded") continue;
    const order = items.some((c) => typeof c.value === "number" && c.value > 1) ? "impact" : "recent";
    const sorted = [...items].sort((a, b) => (order === "impact" ? (b.value ?? -1) - (a.value ?? -1) : (b.at_ms ?? 0) - (a.at_ms ?? 0)) || (a.ref < b.ref ? -1 : 1));
    const cap = k === "K1" || k === "K4" ? 500 : 50;
    contributors[k] = { items: sorted.slice(0, cap), total: items.length, order, truncated: items.length > cap };
  }

  return {
    source: "simulated",
    generated_at_ms: to,
    window: { from_ms: from, to_ms: to },
    filters,
    definitions_version: 1,
    partial: false,
    group_overflow: 0,
    totals,
    grouped,
    contributors,
    runs,
    transitions: noLog ? [] : transitionsOf(h, has, logged, inW),
    concurrency: concurrencyOf(h, has, from, to, noLog),
    freshness: freshnessOf(h, tickets, execs, runs, noLog),
  };
}

function hash7(s: string): string {
  let x = 2166136261;
  for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
  return x.toString(16).padStart(8, "0").slice(0, 7);
}

function transitionsOf(h: FxHistory, has: (id: string) => boolean, logged: (id: string) => boolean, inW: (t: number | null) => boolean): Transition[] {
  const counts = new Map<string, { from: Station; to: Transition["to"]; count: number; tickets: Set<string> }>();
  const add = (from: Station, to: Transition["to"], ticket: string) => {
    const k = `${from}>${to}`;
    const c = counts.get(k) ?? { from, to, count: 0, tickets: new Set<string>() };
    c.count++;
    c.tickets.add(ticket);
    counts.set(k, c);
  };
  const byTicket = new Map<string, FxHistory["visits"][number][]>();
  for (const v of h.visits) if (has(v.ticket) && logged(v.ticket) && inW(v.start)) (byTicket.get(v.ticket) ?? byTicket.set(v.ticket, []).get(v.ticket)!).push(v);
  for (const [ticket, vs] of byTicket) {
    vs.sort((a, b) => a.start - b.start);
    for (let i = 1; i < vs.length; i++) {
      const a = vs[i - 1]!.station;
      const b = vs[i]!.station;
      if (a !== b) add(a, b, ticket); // a resumed visit (retry) is not a move
    }
    const tk = h.tickets.find((t) => t.id === ticket)!;
    const last = vs[vs.length - 1]!.station;
    if (tk.outcome === "blocked" || tk.outcome.startsWith("escalated")) add(tk.outcome === "escalated-merged" ? "review" : last, "blocked", ticket);
    if (tk.outcome === "abandoned" || tk.outcome === "escalated-abandoned") add(last, "abandoned", ticket);
  }
  return [...counts.values()].map((c) => ({ from: c.from, to: c.to, count: c.count, tickets: c.tickets.size })).sort((a, b) => STATIONS.indexOf(a.from) - STATIONS.indexOf(b.from) || b.count - a.count);
}

function concurrencyOf(h: FxHistory, has: (id: string) => boolean, from: number, to: number, noLog: boolean): AnalyticsSnapshot["concurrency"] {
  const bucket = to - from > 20 * D ? 6 * 3_600_000 : to - from > 8 * D ? 3 * 3_600_000 : 3_600_000;
  const n = Math.ceil((to - from) / bucket);
  const ex = h.executions.filter((e) => has(e.ticket)).map((e) => [e.claimedAt, e.endedAt] as const);
  const vi = h.visits.filter((v) => has(v.ticket) && v.station !== "human").map((v) => [v.start, v.end ?? to] as const);
  const ag = h.executions.filter((e) => has(e.ticket)).flatMap((e) => e.agents.map((g) => [g.start, g.start + g.durMs] as const));
  const step = 10 * 60_000;
  const series = (xs: readonly (readonly [number, number])[]) => {
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let t = from + i * bucket; t < Math.min(to, from + (i + 1) * bucket); t += step) {
        let c = 0;
        for (const [a, b] of xs) if (a <= t && b > t) c++;
        peak = Math.max(peak, c);
      }
      out[i] = peak;
    }
    return out;
  };
  return {
    bucket_ms: bucket,
    from_ms: from,
    // Without a lifecycle log there are no station visits to count: the line is absent, not zero.
    lines: noLog ? [{ kind: "execution", counts: series(ex) }, { kind: "agent", counts: series(ag) }] : [{ kind: "execution", counts: series(ex) }, { kind: "visit", counts: series(vi) }, { kind: "agent", counts: series(ag) }],
    limits: h.limits.filter((l) => l.to > from).map((l) => ({ from_ms: Math.max(l.from, from), to_ms: l.to, value: l.value })),
  };
}

function freshnessOf(h: FxHistory, tickets: ReadonlyMap<string, FxTicket>, execs: FxHistory["executions"], runs: readonly RunRecord[], noLog: boolean): SourceFreshness[] {
  const all = [...tickets.values()];
  const lastOf = (xs: readonly (number | null)[]) => xs.reduce<number | null>((m, x) => (x !== null && (m === null || x > m) ? x : m), null);
  const logged = all.filter((t) => t.lifecycle && !noLog).length;
  const withUsage = execs.filter((e) => e.usage !== null).length;
  const withCost = execs.filter((e) => e.costUsd !== null).length;
  const share = (a: number, b: number) => ({ covered: a, of: b, share: b ? round3(a / b) : null });
  return [
    { source: "intake log", last_event_ms: lastOf(all.flatMap((t) => [t.scheduledAt, t.integratedAt])), events: all.length * 6, coverage: share(all.filter((t) => t.slice).length, all.filter((t) => t.slice).length), note: all.some((t) => !t.slice) ? `every product slice; the ${all.filter((t) => !t.slice).length} hand-driven and telemetry tickets have none` : "every product slice" },
    { source: "cell lifecycle", last_event_ms: noLog ? null : lastOf(h.visits.map((v) => v.end ?? v.start)), events: noLog ? 0 : h.visits.length * 3, coverage: share(logged, all.length), note: noLog ? "no cell kept a lifecycle log" : "cells without a lifecycle log are left out of station figures" },
    { source: "execution records", last_event_ms: lastOf(execs.map((e) => e.observedAt)), events: execs.length * 4, coverage: share(withCost, execs.length), note: "share of executions with a recorded cost" },
    { source: "execution stream", last_event_ms: lastOf(execs.map((e) => e.endedAt)), events: execs.reduce((s, e) => s + e.agents.length * 2, 0), coverage: share(withUsage, execs.length), note: "share of executions whose stream carried per-model usage" },
    { source: "run records", last_event_ms: lastOf(runs.map((x) => x.closed_at?.ms ?? null)), events: runs.length, coverage: share(runs.length, runs.length), note: "one record per ticket finished in the window" },
  ];
}

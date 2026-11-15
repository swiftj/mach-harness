/**
 * Development only, never built: snapshots for the density modes the proof page shows, made from the
 * seeded simulated fixture and labelled Simulated wherever shown.
 *
 * - `emptySnapshot`: a project with nothing recorded (every row answered, every count zero, every
 *   rate without a denominator), as an observer over an empty history answers.
 * - `repeatSnapshot`: the fixture's whole history laid end to end `k` times, each copy shifted back
 *   by the history's length, tickets renamed per copy. Repeating a sample `k` times keeps every rate,
 *   mean and percentile exactly and multiplies every count by `k`, so the figures stay true of the
 *   copied data; only the volume (about 340 tickets over 250 days) is new. It exists to judge the
 *   layout at that volume, nothing else.
 * - `simulatedConfigs`: execution configurations for the fixture's runs, which record none: an early
 *   stretch with no provenance, then two configurations and a few tickets that ran under both.
 */
import type { AnalyticsSnapshot, Contributor, ContributorPage, MetricGroup, MetricRow, RunRecord } from "../contract";
import type { RunConfigs } from "../model/cohorts";

const D = 86_400_000;

const scaleCoverage = (c: MetricRow["coverage"], k: number): MetricRow["coverage"] => ({ ...c, covered: c.covered === null ? null : c.covered * k, of: c.of === null ? null : c.of * k, ...(c.counted !== undefined ? { counted: c.counted === null ? null : c.counted * k } : {}), ...(c.eligible !== undefined ? { eligible: c.eligible === null ? null : c.eligible * k } : {}) });
const scaleDist = (d: MetricRow["distribution"], k: number): MetricRow["distribution"] => (d ? { ...d, histogram: d.histogram.map((b) => ({ ...b, count: b.count * k })) } : d);

function scaleFigure<T extends MetricGroup | MetricRow>(f: T, kind: MetricRow["kind"], k: number): T {
  const isRow = "numerator_value" in f;
  const num = isRow ? (f as MetricRow).numerator_value : (f as MetricGroup).numerator;
  const den = isRow ? (f as MetricRow).denominator_value : (f as MetricGroup).denominator;
  const value = f.value === null ? null : kind === "count" ? f.value * k : f.value;
  const base = { ...f, value, coverage: scaleCoverage(f.coverage, k), ...(f.distribution ? { distribution: scaleDist(f.distribution, k) } : {}), ...(f.basis_counts ? { basis_counts: Object.fromEntries(Object.entries(f.basis_counts).map(([b, n]) => [b, n === null ? null : n * k])) } : {}), ...(f.sample_count !== undefined && f.sample_count !== null ? { sample_count: f.sample_count * k } : {}) };
  return (isRow ? { ...base, numerator_value: num === null ? null : num * k, denominator_value: den === null ? null : den * k } : { ...base, numerator: num === null ? null : num * k, denominator: den === null ? null : den * k }) as T;
}

const renameTicket = (id: string, copy: number) => (copy === 0 ? id : id.replace(/(\d+)$/, (n) => String(Number(n) + copy * 100).padStart(3, "0")));
const renameRef = (ref: string, copy: number) => (copy === 0 ? ref : ref.replace(/([A-Z]+-)(\d+)/g, (_m, p: string, n: string) => `${p}${String(Number(n) + copy * 100).padStart(3, "0")}`).replace(/(xsyn|xauto|xloc)(\d+)/g, (_m, p: string, n: string) => `${p}${copy}${n}`));

export function repeatSnapshot(s: AnalyticsSnapshot, k: number): AnalyticsSnapshot {
  const span = Math.ceil((s.window.to_ms - s.window.from_ms) / D) * D;
  const shift = (t: number | null, copy: number) => (t === null ? null : t - copy * span);
  const dayShift = (key: string, copy: number) => new Date(Date.parse(`${key}T00:00:00Z`) - copy * span).toISOString().slice(0, 10);
  const totals = Object.fromEntries(Object.entries(s.totals).map(([id, r]) => [id, scaleFigure(r!, r!.kind, k)])) as AnalyticsSnapshot["totals"];
  const grouped: Record<string, MetricRow> = {};
  for (const [key, row] of Object.entries(s.grouped)) {
    if (key.endsWith("|day")) {
      const groups: MetricGroup[] = [];
      for (let c = k - 1; c >= 0; c--) for (const g of row.groups ?? []) groups.push({ ...g, key: dayShift(g.key, c), keys: { day: dayShift(g.key, c) } });
      grouped[key] = { ...scaleFigure(row, row.kind, k), groups };
    } else grouped[key] = { ...scaleFigure(row, row.kind, k), groups: (row.groups ?? []).map((g) => scaleFigure(g, row.kind, k)) };
  }
  const contributors: Record<string, ContributorPage> = {};
  for (const [key, page] of Object.entries(s.contributors)) {
    const items: Contributor[] = [];
    for (let c = 0; c < k; c++)
      for (const it of page.items)
        items.push({ ...it, ref: renameRef(it.ref, c) as Contributor["ref"], ticket: it.ticket ? renameTicket(it.ticket, c) : null, cell: it.cell ? renameTicket(it.cell, c) : null, execution: it.execution ? renameRef(it.execution, c) : null, at_ms: shift(it.at_ms, c), from_ms: shift(it.from_ms, c), to_ms: shift(it.to_ms, c) });
    contributors[key] = { ...page, items: items.slice(0, 500), total: page.total * k, truncated: items.length > 500 };
  }
  const runs: RunRecord[] = [];
  for (let c = k - 1; c >= 0; c--) for (const r of s.runs) runs.push({ ...r, ticket_id: renameTicket(r.ticket_id, c), event_id: `${r.event_id}~${c}`, closed_at: r.closed_at ? { ms: r.closed_at.ms - c * span } : null });
  const conc = s.concurrency;
  const perCopy = conc ? Math.round(span / conc.bucket_ms) : 0;
  return {
    ...s,
    window: { from_ms: s.window.to_ms - k * span, to_ms: s.window.to_ms },
    totals,
    grouped,
    contributors,
    runs,
    transitions: s.transitions.map((t) => ({ ...t, count: t.count * k, tickets: t.tickets * k })),
    concurrency: conc
      ? {
          ...conc,
          from_ms: conc.from_ms - (k - 1) * span,
          lines: conc.lines.map((l) => ({ ...l, counts: Array.from({ length: k }, () => [...l.counts, ...new Array(Math.max(0, perCopy - l.counts.length)).fill(0)].slice(0, perCopy)).flat() })),
          limits: Array.from({ length: k }, (_, c) => conc.limits.map((x) => ({ ...x, from_ms: x.from_ms - (k - 1 - c) * span, to_ms: x.to_ms - (k - 1 - c) * span }))).flat(),
        }
      : null,
    freshness: s.freshness.map((f) => ({ ...f, events: f.events * k, coverage: scaleCoverage(f.coverage, k) })),
  };
}

function emptyFigure<T extends MetricGroup | MetricRow>(f: T): T {
  const isRow = "numerator_value" in f;
  const count = (f as MetricRow).kind === "count";
  const base = { ...f, value: count ? 0 : null, coverage: { covered: 0, of: 0, share: null }, distribution: undefined, basis_counts: null, p50_ms: undefined, p90_ms: undefined, min_ms: undefined, max_ms: undefined, met: undefined, null_reason: count ? undefined : "no value: nothing recorded in this window", sample_count: 0 };
  return (isRow ? { ...base, numerator_value: 0, denominator_value: (f as MetricRow).kind === "count" ? null : 0, groups: [] } : { ...base, numerator: 0, denominator: 0 }) as unknown as T;
}

export function emptySnapshot(s: AnalyticsSnapshot): AnalyticsSnapshot {
  const totals = Object.fromEntries(Object.entries(s.totals).map(([id, r]) => [id, r!.status === "deferred" || r!.basis === "not-recorded" ? r : emptyFigure(r!)])) as AnalyticsSnapshot["totals"];
  return {
    ...s,
    totals,
    grouped: Object.fromEntries(Object.entries(s.grouped).map(([k, r]) => [k, { ...emptyFigure(r), groups: [] }])),
    contributors: {},
    runs: [],
    transitions: [],
    concurrency: null,
    freshness: s.freshness.map((f) => ({ ...f, last_event_ms: null, events: 0, coverage: { covered: 0, of: 0, share: null } })),
  };
}

/** One finished run: the sparse fixture narrowed to its first ticket by risk (the dev loader applies it, the page shows no filter). */
export const ONE_RUN_RISK = "medium" as const;

export function simulatedConfigs(runs: readonly RunRecord[]): RunConfigs {
  const sorted = [...runs].filter((r) => r.closed_at).sort((a, b) => a.closed_at!.ms - b.closed_at!.ms);
  const A = "3f2a91c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1";
  const B = "9c41e07ab2d3c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9";
  const out: Record<string, (string | null)[]> = {};
  sorted.forEach((r, i) => {
    const at = i / Math.max(1, sorted.length - 1);
    if (at < 0.3) out[r.ticket_id] = [null];
    else if (at < 0.62) out[r.ticket_id] = i % 9 === 0 ? [A, null] : [A, A];
    else if (at < 0.66) out[r.ticket_id] = [A, B];
    else out[r.ticket_id] = [B];
  });
  return out;
}

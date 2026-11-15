/**
 * `simulatedAnalytics(seed)`: Analytics over the prototype's seeded fixture (../fixtures), for the
 * simulation source, which has no observer. Every reply says `source: "simulation"`; the UI labels it
 * Simulated wherever it is shown.
 *
 * This file is an adapter, not a metric engine: the fixture already folds its history into rows in
 * the observer's wire shape (`AnalyticsSnapshot`), and the rows here pass through the same parser as
 * an observer's replies. Where the fixture's shape differs from the observer's API it is translated
 * (risk words, a cell's ref, `closed_at`), and what the fixture cannot answer is `unsupported` with
 * the reason, never an empty answer: a window other than 7, 14, 28 days or all, `last_runs`, filters
 * other than risk, app type and model, two group dimensions, weekly buckets, executions and insights.
 */
import type { AnalyticsFilters, AnalyticsSnapshot, WindowKey } from "../contract";
import { FIXTURE_END, simulatedSnapshot } from "../fixtures";
import { findings, type Finding } from "../model/findings";
import { readContributor, readFlow, readMetricRow, readRun } from "./parse";
import type { AnalyticsData, AnalyticsQuery, AnalyticsResult, CallOptions } from "./provider";
import { readDisplayPolicy, UNCHECKED_NOTE } from "./text";
import type { AnalyticsEnvelope, ContributorItem, Insight, MetricRow, RunItem } from "./types";

const SIMULATED_NOTICE = "Simulated: these opportunities come from the prototype's rules over a seeded fixture. They are advisory and read-only, and none of them is a reason to change verification, security review or a person's approval.";
const INVESTIGATION_LABEL = "Possible investigation (a suggestion to look further, not a conclusion)";

/**
 * A prototype finding in the observer's insight shape. The prototype carries words, not numbers: a
 * measurement keeps its words in `display` and its value is null; the catalog ID is read from the
 * label's "(Q2)" where it names one. It states no severity (`unknown`), no threshold and no
 * contributors query (it links to an area instead).
 */
function insightOf(f: Finding, s: AnalyticsSnapshot): Insight {
  return {
    id: f.id,
    rule: f.id,
    subject: null,
    severity: "unknown",
    title: f.title,
    condition: f.condition,
    threshold: null,
    measurements: f.measurements.map((m) => ({
      metric: /\(([A-Z]\d+b?)\)/.exec(m.label)?.[1] ?? "",
      label: m.label,
      value: null,
      unit: null,
      numerator: null,
      denominator: null,
      sample_count: null,
      coverage: null,
      window: "selection" as const,
      display: m.value,
    })),
    sample: { count: null, unit: null, coverage_share: null, population: f.sample },
    window: { from_ms: s.window.from_ms, to_ms: s.window.to_ms, last_runs: null, comparison: null },
    filters: {},
    why: f.why,
    investigation: { label: INVESTIGATION_LABEL, text: f.investigate },
    contributors: null,
  };
}

const D = 86_400_000;
const WINDOWS: readonly (readonly [WindowKey, number])[] = [["7d", 7], ["14d", 14], ["28d", 28]];
/** The simulation's rules line, stated on every reply. */
export const SIMULATION_RULE = "Simulated: a seeded fixture, not a Factory's recorded history";

/** The observer's declared policy for the fields analytics can carry (phase titles), so the simulation contains them the same way. */
const POLICY = readDisplayPolicy({
  people: "role",
  free_text: { checked_for_names: false, note: UNCHECKED_NOTE, event_fields: [{ kind: "agent.started", path: "data.phase", max: 60 }, { kind: "agent.queued", path: "data.phase", max: 60 }] },
});

const cap = (risk: string | null | undefined): string | null => (risk ? risk.charAt(0).toUpperCase() + risk.slice(1).toLowerCase() : null);

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The request was superseded.", "AbortError");
}

type Plan = { readonly ok: true; readonly filters: AnalyticsFilters; readonly from: number | null; readonly to: number | null } | { readonly ok: false; readonly reason: string };

/** The fixture's filters for a query, or why the simulation cannot answer it. */
function plan(query: AnalyticsQuery, start: number): Plan {
  if (query.lastRuns) return { ok: false, reason: "The simulation does not select the last N runs; choose a window." };
  for (const k of Object.keys(query.filters ?? {}) as (keyof NonNullable<AnalyticsQuery["filters"]>)[]) {
    if (query.filters?.[k] && k !== "risk" && k !== "app_type" && k !== "model") return { ok: false, reason: `The simulation cannot filter by ${k}.` };
  }
  let window: WindowKey = "all";
  const from = query.fromMs ?? null;
  const to = query.toMs ?? null;
  if (to !== null && to < FIXTURE_END) return { ok: false, reason: "The simulation's history is fixed; it cannot be read up to an earlier time." };
  if (from !== null) {
    const match = WINDOWS.find(([, days]) => from === FIXTURE_END - days * D);
    if (match) window = match[0];
    else if (from > start) return { ok: false, reason: "The simulation offers the last 7, 14 or 28 days, or all of its history." };
  }
  const f = query.filters ?? {};
  const filters = {
    window,
    risk: (f.risk ? f.risk.toLowerCase() : null) as AnalyticsFilters["risk"],
    app_type: (f.app_type ?? null) as AnalyticsFilters["app_type"],
    model: (f.model ?? null) as AnalyticsFilters["model"],
  };
  return { ok: true, filters, from, to };
}

/** The fixture's risk words ("high") as the observer serves them ("High"), in a row's groups and buckets. */
function observerRow(row: unknown, dims: readonly string[]): unknown {
  const r = row as Record<string, unknown>;
  if (!Array.isArray(r.groups)) return r;
  return {
    ...r,
    group_dims: dims,
    groups: r.groups.map((g: Record<string, unknown>) => {
      const keys: Record<string, string> = { ...((g.keys as Record<string, string> | undefined) ?? (dims.length === 1 && typeof g.key === "string" ? { [dims[0]!]: g.key } : {})) };
      if (keys.risk) keys.risk = cap(keys.risk)!;
      return { ...g, keys };
    }),
  };
}

export interface SimulatedAnalyticsOptions {
  readonly size?: "full" | "sparse";
  readonly coverage?: "normal" | "lifecycle-missing";
}

export function simulatedAnalytics(seed = 6502, options: SimulatedAnalyticsOptions = {}): AnalyticsData {
  const cursor = `simulation.${seed}.${options.size ?? "full"}.${options.coverage ?? "normal"}`;
  const snapshots = new Map<string, AnalyticsSnapshot>();
  const snap = (filters: AnalyticsFilters): AnalyticsSnapshot => {
    const key = JSON.stringify(filters);
    let s = snapshots.get(key);
    if (!s) snapshots.set(key, (s = simulatedSnapshot(filters, { seed, ...(options.size ? { size: options.size } : {}), ...(options.coverage ? { coverage: options.coverage } : {}) })));
    return s;
  };
  const start = snap({ window: "all", risk: null, app_type: null, model: null }).window.from_ms;

  const envelope = (s: AnalyticsSnapshot, p: Extract<Plan, { ok: true }>, query: AnalyticsQuery): AnalyticsEnvelope => ({
    source: "simulation",
    cursor,
    projection: { format: null, definitions: s.definitions_version },
    generated_ms: s.generated_at_ms,
    window: { from_ms: p.from, to_ms: p.to, effective_from_ms: p.from === null ? null : s.window.from_ms, effective_to_ms: p.to === null ? null : s.window.to_ms, last_runs: null },
    filters: Object.fromEntries(Object.entries(query.filters ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")),
    history: { complete: !s.partial, complete_window: !s.partial, from_ms: start, from_precision: null, partial: null, gaps: [], sources: [] },
    as_of: null,
    rules: [SIMULATION_RULE],
  });

  /** Runs `body` on the snapshot the query selects, or answers why it cannot. */
  const run = async <T>(query: AnalyticsQuery, options: CallOptions | undefined, body: (s: AnalyticsSnapshot, env: AnalyticsEnvelope) => AnalyticsResult<T>): Promise<AnalyticsResult<T>> => {
    aborted(options?.signal);
    if (options?.at && options.at !== cursor) return { status: "cursor-gone", reason: "That cursor is not the simulation's." };
    const p = plan(query, start);
    if (!p.ok) return { status: "unsupported", reason: p.reason };
    const s = snap(p.filters);
    return body(s, envelope(s, p, query));
  };

  return {
    source: "simulation",
    displayPolicy: async (signal) => {
      aborted(signal);
      return POLICY;
    },
    metrics: (query, options) =>
      run(query, options, (s, env) => {
        const ids = query.ids?.length ? query.ids : (Object.keys(s.totals) as string[]);
        const by = query.groupBy ?? [];
        const metrics: MetricRow[] = [];
        for (const id of ids) {
          const total = s.totals[id as keyof typeof s.totals];
          if (!total) continue;
          let wire: Record<string, unknown> = { ...total, groups: null };
          if (by.length === 1) {
            const g = s.grouped[`${id}|${by[0]}`];
            wire = g ? (observerRow(g, by) as Record<string, unknown>) : { ...wire, group_dims: by, groups: null, groups_reason: `The simulation does not group ${id} by ${by[0]}.` };
          } else if (by.length > 1) wire = { ...wire, group_dims: by, groups: null, groups_reason: "The simulation groups by one dimension at a time." };
          if (query.bucket === "day") {
            const days = s.grouped[`${id}|day`];
            wire.buckets = Array.isArray(days?.groups) ? days.groups.map((g) => ({ ...g, period: g.key, from_ms: Date.parse(`${g.key}T00:00:00Z`), to_ms: Date.parse(`${g.key}T00:00:00Z`) + D, suspect: false })) : null;
          }
          if (!query.distribution) {
            delete wire.distribution;
            if (Array.isArray(wire.groups)) wire.groups = (wire.groups as Record<string, unknown>[]).map(({ distribution: _d, ...g }) => g);
          }
          const row = readMetricRow(wire, POLICY);
          if (row) metrics.push(row);
        }
        if (query.bucket === "week") return { status: "unsupported", reason: "The simulation has daily buckets only." };
        return { status: "ok", value: { ...env, metrics, definitions_version: s.definitions_version, group_overflow: s.group_overflow, suspect_days: [] } };
      }),
    flow: (query, options) =>
      run(query, options, (s, env) => {
        // The fixture records transitions only; stations, waits and bottlenecks are reported missing, not empty.
        const flow = readFlow({ cursor, transitions: s.transitions.map((t) => ({ ...t, terminal: t.to === "blocked" || t.to === "abandoned", revise: null })) }, "simulation");
        return { status: "ok", value: { ...flow, ...env } };
      }),
    contributors: (query, options) =>
      run(query, options, (s, env) => {
        const group = Object.entries(query.group ?? {});
        if (group.length > 1) return { status: "unsupported", reason: "The simulation lists contributors for one group at a time." };
        const key = group.length ? `${query.metric}|${group[0]![0]}=${group[0]![1]}` : query.metric;
        const page = s.contributors[key];
        if (!page) return { status: "unsupported", reason: `The simulation lists no contributors for ${query.metric}${group.length ? ` in that group` : ""}.` };
        const all = page.items
          .map((c) => readContributor({ ...c, cell: c.cell ? `cell:${c.cell}` : null, risk: cap(c.risk), group: Object.fromEntries(group) }))
          .filter((c): c is ContributorItem => c !== null);
        const order = query.order ?? "impact";
        const sorted = [...all].sort(order === "recent" ? (a, b) => (b.at_ms ?? -Infinity) - (a.at_ms ?? -Infinity) : (a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
        const limit = Math.min(500, Math.max(1, query.limit ?? 100));
        const byBasis: Record<string, number> = {};
        for (const c of all) byBasis[c.basis] = (byBasis[c.basis] ?? 0) + 1;
        return {
          status: "ok",
          value: { ...env, metric: query.metric, figure: null, group: Object.fromEntries(group), items: sorted.slice(0, limit), total: all.length, truncated: all.length > limit, by_basis: byBasis, order, limit, after_as_of: 0 },
        };
      }),
    runs: (query, options) =>
      run(query, options, (s, env) => {
        const all = s.runs.map((r) => readRun({ ...r, risk: cap(r.risk) })).filter((r): r is RunItem => r !== null);
        const offset = Math.max(0, query.offset ?? 0);
        const limit = Math.max(1, query.limit ?? 100);
        const items = all.slice(offset, offset + limit);
        return { status: "ok", value: { ...env, of: "runs", items, total: all.length, offset, more: offset + limit < all.length, excluded: [], after_as_of: 0 } };
      }),
    executions: async (_query, options) => {
      aborted(options?.signal);
      return { status: "unsupported", reason: "The simulation does not list executions." };
    },
    insights: (query, options) =>
      run(query, options, (s, env) => {
        const insights = findings(s).map((f) => insightOf(f, s));
        return { status: "ok", value: { ...env, insights, not_evaluated: [], insight_rules: [], notice: SIMULATED_NOTICE, investigation_label: INVESTIGATION_LABEL } };
      }),
    concurrency: async (_query, options) => {
      aborted(options?.signal);
      const c = snap({ window: "all", risk: null, app_type: null, model: null }).concurrency;
      if (!c) return { status: "unsupported", reason: "The simulation records no concurrency here." };
      const to = c.from_ms + c.bucket_ms * Math.max(0, ...c.lines.map((l) => l.counts.length));
      return {
        status: "ok",
        value: {
          source: "simulation", cursor, from_ms: c.from_ms, to_ms: to, bucket_ms: c.bucket_ms,
          lines: c.lines.map((l) => ({ kind: l.kind, max: [...l.counts] })),
          limits: c.limits.map((l) => ({ name: "max_parallel", value: l.value, from_ms: l.from_ms, to_ms: l.to_ms, applies_to: ["execution"] })),
          complete: true,
        },
      };
    },
    freshness: async (options) => {
      aborted(options?.signal);
      return { status: "unsupported", reason: "The simulation reads no source files, so nothing was last read." };
    },
  };
}

/**
 * The simulation's findings (findings.ts) in the observer's Improvement Opportunities reply shape
 * (data/types.ts `InsightsReply`), so the areas render one shape whatever the source. The
 * simulation's measurements are words already; they travel in `display` and their numbers stay null
 * (nothing is parsed back out of words). Pure.
 */
import type { AnalyticsSnapshot } from "../contract";
import type { Insight, InsightMeasurement, InsightsReply } from "../data/types";
import { findings } from "./findings";

export function simulatedInsights(s: AnalyticsSnapshot): InsightsReply {
  const items: Insight[] = findings(s).map((f) => ({
    id: f.id,
    rule: f.id,
    subject: null,
    severity: f.rank <= 2 ? "attention" : "note",
    title: f.title,
    condition: null,
    threshold: f.condition,
    measurements: f.measurements.map((m, i) => ({ metric: f.metrics[Math.min(i, f.metrics.length - 1)] ?? "", label: m.label, value: null, unit: null, numerator: null, denominator: null, sample_count: null, coverage: null, window: "selection" as const, display: m.value })),
    sample: { count: null, unit: null, coverage_share: null, population: f.sample },
    window: { from_ms: s.window.from_ms, to_ms: s.window.to_ms, last_runs: null, comparison: null },
    filters: {},
    why: f.why,
    investigation: { label: "Possible investigation (a suggestion to look further, not a conclusion)", text: f.investigate },
    contributors: null,
  }));
  return {
    source: "simulation",
    cursor: "simulation",
    as_of: null,
    projection: { format: null, definitions: s.definitions_version },
    generated_ms: s.generated_at_ms,
    window: { from_ms: s.window.from_ms, to_ms: s.window.to_ms, effective_from_ms: s.window.from_ms, effective_to_ms: s.window.to_ms, last_runs: null },
    filters: {},
    history: { complete: !s.partial, complete_window: !s.partial, from_ms: null, from_precision: null, partial: null, gaps: [], sources: [] },
    rules: ["Simulated: a seeded fixture, not a Factory's recorded history"],
    insights: items,
    not_evaluated: [],
    insight_rules: [],
    notice: null,
    investigation_label: null,
  };
}

// ---------------------------------------------------------------- how an opportunity is shown

/** The first letter upper-case (the observer's titles may start with a station code: "build holds …"). */
export const capitalFirst = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

const dayWords = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The population an opportunity was measured over, in the observer's terms: the last N runs, or a window. */
export interface InsightPopulation {
  readonly lastRuns: number | null;
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

/**
 * Where an opportunity's figures come from: its contributors query's own parameters first, then its
 * `window`, then the observe station's "last N finished runs" its sample names. Null members: the
 * view's window applies.
 */
export function insightPopulation(f: Pick<Insight, "window" | "sample" | "contributors">): InsightPopulation {
  const q = f.contributors?.path ? new URLSearchParams(f.contributors.path.split("?")[1] ?? "") : null;
  const num = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
  const lastRuns = num(q?.get("last_runs")) ?? f.window.last_runs ?? num(/\bthe last (\d+) finished runs\b/.exec(f.sample?.population ?? "")?.[1]);
  if (lastRuns) return { lastRuns, fromMs: null, toMs: null };
  return { lastRuns: null, fromMs: num(q?.get("from_ms")) ?? f.window.from_ms, toMs: num(q?.get("to_ms")) ?? f.window.to_ms };
}

/** The population in words, said beside the figure ("over the last 20 finished runs, the observe station's window"). Null: the view's own window. */
export function populationWords(f: Pick<Insight, "window" | "sample" | "contributors">): string | null {
  const p = insightPopulation(f);
  if (p.lastRuns) return `over the last ${p.lastRuns} finished runs, the observe station's window`;
  const cmp = f.window.comparison;
  if (p.fromMs !== null && p.toMs !== null) return `from ${dayWords(p.fromMs)} to ${dayWords(p.toMs - 1)}${cmp && cmp.from_ms !== null && cmp.to_ms !== null ? `, against ${dayWords(cmp.from_ms)} to ${dayWords(cmp.to_ms - 1)}` : ""}`;
  return f.sample?.population ? `over ${f.sample.population}` : null;
}

/** The sample beside the figure: "n 16 merged tickets, coverage 98%". */
export function sampleWords(f: Pick<Insight, "sample">): string | null {
  const s = f.sample;
  if (!s || s.count === null) return null;
  const cov = s.coverage_share !== null && s.coverage_share < 1 ? `, coverage ${Math.round(s.coverage_share * 100)}%` : "";
  return `n ${s.count}${s.unit ? ` ${s.count === 1 ? s.unit.replace(/s$/, "") : s.unit}` : ""}${cov}`;
}

/** Whether a measurement only repeats the figure the title already states (so each figure is shown once). */
export function repeatsTitle(m: Pick<InsightMeasurement, "value">, title: string): boolean {
  if (m.value === null) return false;
  const UNIT_MS: Readonly<Record<string, number>> = { d: 86_400_000, h: 3_600_000, min: 60_000, s: 1000 };
  const shown = [...title.matchAll(/(\d+(?:\.\d+)?)\s?(%|d|h|min|s)?(?![\w])/g)].map((x) => ({ n: Number(x[1]), unit: x[2] ?? "" }));
  const v = m.value;
  return shown.some((x) => {
    if (x.unit === "%") return Math.abs(x.n - v * 100) <= 0.051;
    // A duration said in the title's own unit and rounding (4.7 d for 4 d 17 h).
    if (x.unit) return Math.abs(x.n * UNIT_MS[x.unit]! - v) <= 0.051 * UNIT_MS[x.unit]!;
    return Math.abs(x.n - v) <= 0.0006 * Math.max(1, Math.abs(x.n));
  });
}

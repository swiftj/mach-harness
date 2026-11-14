/**
 * What one Analytics view asks the source, decided from the store's state alone. Pure, erasable
 * syntax only (test/analytics-wire.test.mjs loads it directly).
 *
 * - The source decides the provider and the label, and nothing else may: simulated data never under
 *   a live or replay label, an observer's never under Simulated (`sourceCheck`).
 * - The period: a preset ends at the newest record the source holds, or at the playhead when the
 *   view describes the history through it; a chosen interval is cut at the playhead (a replay never
 *   shows a later outcome). The simulation's fixture has its own fixed end.
 * - Filters are codes (`High`, `cli`, `sonnet`). The model narrows Economics alone.
 * - One snapshot per view: the view's key is its period, filters and "as of", never the area, so
 *   moving between areas reads at the same cursor.
 */
import type { AnalyticsArea, AnalyticsFilters, AnalyticsWindow } from "../../scene/analytics";
import type { SceneSource } from "../../sim/provenance";
import type { AnalyticsSource } from "../data/types";
import type { AreaSource, Pick } from "../ui/types";
import { utcClock } from "../../shell/time";
import { dayLabel } from "../../timeline/render/scale";

export const DAY_MS = 86_400_000;
const PRESET_DAYS = { "7d": 7, "14d": 14, "28d": 28 } as const;

// --------------------------------------------------------------------------------------- source

/** The provider a source reads from: the seeded fixture for the simulation, the observer otherwise (or none when no observer answered). */
export function providerFor(source: SceneSource, hasClient: boolean): AnalyticsSource | null {
  if (source === "simulation") return "simulation";
  return hasClient ? "observer" : null;
}

/**
 * The label rule: the area source shown for a scene source and the provider actually used, or why
 * they cannot be shown together. Simulated figures are shown only for the simulation and always
 * labelled so; an observer's never for the simulation.
 */
export function sourceCheck(scene: SceneSource, provider: AnalyticsSource | null): { readonly ok: true; readonly area: AreaSource } | { readonly ok: false; readonly reason: string } {
  if (provider === null) return { ok: false, reason: "No observer answered for this source, so there is nothing to read Factory Analytics from. Nothing simulated is shown in its place." };
  if (scene === "simulation") return provider === "simulation" ? { ok: true, area: "simulation" } : { ok: false, reason: "The Simulation reads no observer: its figures are the seeded fixture's, labelled Simulated." };
  if (provider === "simulation") return { ok: false, reason: "Simulated figures are never shown for a real source." };
  return { ok: true, area: scene };
}

/** The words for where the figures come from. Simulated is said for the simulation and nowhere else. */
export function sourceWords(area: AreaSource): string {
  return area === "simulation" ? "Simulated history (not real execution)" : area === "live" ? "Live Factory" : "Historical replay";
}

// --------------------------------------------------------------------------------------- window

export interface WindowInput {
  readonly provider: AnalyticsSource;
  /** The playhead when the view describes the history through it; null: up to the edge. */
  readonly asOfMs: number | null;
  /** The newest record the source holds (the scene log's head time); null when nothing is held yet. */
  readonly newestMs: number | null;
  /** The simulation fixture's end (fixtures FIXTURE_END). */
  readonly fixtureEnd: number;
}

export type WindowQuery =
  | { readonly ok: true; readonly fromMs: number | null; readonly toMs: number | null; readonly cut: boolean }
  | { readonly ok: false; readonly reason: string };

const startOfDay = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/**
 * The query window for a period. A preset is whole UTC days ending with the day of the newest record
 * (or of the playhead); `toMs` is left open: the "as of" cut (`as_of_ms`) bounds it, never a guess.
 * An interval ending after the playhead is cut there (`cut`); one that begins after it has nothing to show.
 */
export function windowQuery(w: AnalyticsWindow, input: WindowInput): WindowQuery {
  if (input.provider === "simulation") {
    // The fixture answers its presets only (data/simulation.ts); an interval is passed on and refused there, with its reason.
    if (w === "all") return { ok: true, fromMs: null, toMs: null, cut: false };
    if (typeof w === "string") return { ok: true, fromMs: input.fixtureEnd - PRESET_DAYS[w] * DAY_MS, toMs: null, cut: false };
    return { ok: true, fromMs: w.from, toMs: w.to, cut: false };
  }
  if (w === "all") return { ok: true, fromMs: null, toMs: null, cut: false };
  if (typeof w === "string") {
    // The last N whole UTC days ending with the day of the newest recorded event (or of the playhead),
    // asked with both ends so the period the label states is the period the observer counts.
    const end = input.asOfMs ?? input.newestMs;
    if (end === null) return { ok: true, fromMs: null, toMs: null, cut: false };
    const last = startOfDay(end) + DAY_MS;
    return { ok: true, fromMs: last - PRESET_DAYS[w] * DAY_MS, toMs: input.asOfMs !== null ? null : last, cut: false };
  }
  if (input.asOfMs !== null && w.from >= input.asOfMs) return { ok: false, reason: "The chosen period begins after the playhead: nothing in it had happened yet. Choose an earlier period, or move the playhead." };
  if (input.asOfMs !== null && w.to > input.asOfMs) return { ok: true, fromMs: w.from, toMs: input.asOfMs, cut: true };
  return { ok: true, fromMs: w.from, toMs: w.to, cut: false };
}

// --------------------------------------------------------------------------------------- filters

export type QueryFilters = Readonly<Partial<Record<"risk" | "app_type" | "model", string>>>;

/** The shared filters as the observer's codes (risk `High`); the model only when asked (Economics). */
export function filtersQuery(f: AnalyticsFilters, withModel: boolean): QueryFilters {
  const out: Record<string, string> = {};
  if (f.risk) out.risk = f.risk.charAt(0).toUpperCase() + f.risk.slice(1);
  if (f.appType) out.app_type = f.appType;
  if (withModel && f.model) out.model = f.model;
  return out;
}

/** The identity of a view's snapshot: period, filters (not the model), "as of" and provider. Areas share it. */
export function viewKey(provider: AnalyticsSource, w: WindowQuery, f: AnalyticsFilters, asOfMs: number | null): string {
  const win = w.ok ? `${w.fromMs ?? ""}-${w.toMs ?? ""}` : "none";
  return `${provider}|${win}|${f.risk ?? ""}|${f.appType ?? ""}|${asOfMs ?? ""}`;
}

// --------------------------------------------------------------------------------------- as of

export interface AsOfFacts {
  readonly area: AreaSource;
  /** The playhead when the view is through it. */
  readonly asOfMs: number | null;
  readonly window: AnalyticsWindow;
  /** The metrics reply's "as of": exact (lists) or by whole UTC days (metrics), or cut by the window's end (an older observer). */
  readonly metricsExact: boolean | null;
  readonly widened: boolean;
  readonly cut: boolean;
  /** The UTC midnight the figures are counted to (metrics by whole days, finished tickets cut there too); null when not cut so. */
  readonly dayCut?: number | null;
  /** D4: no whole UTC day of the history is complete before the playhead. */
  readonly noWholeDay?: boolean;
}

/** A moment as the Timeline says it, to the second: "4 Nov 14:20:05 UTC" (its `dayLabel` and `utcClock`). */
export const momentWords = (t: number): string => `${dayLabel(t)} ${utcClock(t)} UTC`;

/** The last whole UTC day a day cut counts through: the day before the midnight `dayCut` ("3 Nov"). */
export const lastWholeDay = (dayCut: number): string => dayLabel(dayCut - 1);

/**
 * The caption: which history the figures describe, in words. The complete recorded history, a
 * selected window, or through the playhead. Under a day cut (M6.6, I-07/I-08) it names the last whole
 * UTC day counted, never a midnight that reads as including the next day, says the playhead is later,
 * and names the parts cut at the playhead itself (the flow drawing and the rows behind a figure).
 */
export function asOfWords(f: AsOfFacts, clock: (t: number) => string, day: (dayCut: number) => string = lastWholeDay): string {
  if (f.area === "simulation") {
    // I-31: the fixture has no moments the floor's playhead could cut it at; said so beside "Simulated".
    return f.window === "all" ? "The whole simulated history; the playhead does not apply to it, so these figures may run past the moment the floor shows" : "A selected window of the simulated history; the playhead does not apply to it";
  }
  const cut = f.cut ? " The chosen period was cut at the playhead." : "";
  if (f.asOfMs !== null && f.noWholeDay) {
    return `No whole UTC day is complete before the playhead at ${clock(f.asOfMs)}; day-counted figures are not available. The flow drawing and the rows behind a figure run to the playhead.${cut}`.replace(/\.$/, "");
  }
  if (f.asOfMs !== null && f.dayCut != null && !f.widened) {
    const playDay = dayLabel(f.asOfMs);
    const today = f.asOfMs > f.dayCut ? ` The playhead is at ${clock(f.asOfMs)}; the part of ${playDay} before it is not in these figures.` : ` The playhead is at ${clock(f.asOfMs)}.`;
    return `Counted through the end of ${day(f.dayCut)} (UTC), the last whole day before the playhead.${today} The flow drawing and the rows behind a figure run to the playhead itself.${cut}`.replace(/\.$/, "");
  }
  if (f.asOfMs !== null) {
    const head = `Through the playhead at ${clock(f.asOfMs)}: nothing recorded later is counted`;
    const metrics = f.widened
      ? "; an observer without exact playhead cuts counts the metrics to the end of the playhead's UTC day, so outcomes later that day may be included"
      : f.metricsExact === false
        ? "; the flow drawing and the rows behind a figure run to the playhead itself, while metrics count whole UTC days before it"
        : "";
    return `${head}${metrics}${f.cut ? ". The chosen period was cut at the playhead" : ""}`;
  }
  return f.window === "all" ? "The complete recorded history" : "A selected window of the recorded history";
}

/** Each figure's own tag under a day cut (I-08, T-03): a readout seen alone never reads as the playhead's moment. */
export const dayCutTag = (effectiveToMs: number): string => `to end of ${lastWholeDay(effectiveToMs)}`;

// --------------------------------------------------------------------------------------- plan

/** A metrics query grouped by one dimension (the ids that the areas read grouped that way). */
export interface GroupPart {
  readonly dim: string;
  readonly ids: readonly string[];
  readonly distribution: boolean;
}

const G: Readonly<Record<string, GroupPart>> = {
  station: { dim: "station", ids: ["C1", "X2", "K7", "K8", "K10"], distribution: true },
  day: { dim: "day", ids: ["T1", "T2", "K1", "Q1"], distribution: false },
  model: { dim: "model", ids: ["K2", "K3"], distribution: false },
  token_kind: { dim: "token_kind", ids: ["K3"], distribution: false },
  target_kind: { dim: "target_kind", ids: ["Q4"], distribution: false },
  rule: { dim: "rule", ids: ["R2"], distribution: false },
  kind: { dim: "kind", ids: ["S1"], distribution: false },
  stop_reason: { dim: "stop_reason", ids: ["S6"], distribution: false },
  risk: { dim: "risk", ids: ["W3"], distribution: true },
  phase: { dim: "phase", ids: ["K9"], distribution: false },
};

/** What an area reads, beyond the ungrouped totals. */
export interface AreaPlan {
  readonly groups: readonly GroupPart[];
  readonly runs: boolean;
  readonly flow: boolean;
  readonly insights: boolean;
  readonly concurrency: boolean;
  readonly freshness: boolean;
  /** Economics reads with the model filter. */
  readonly model: boolean;
  /** Contributors the area reads from the snapshot (not the drawer's): fixed ones and per-group ones of a grouped metric. */
  readonly contributors: readonly { readonly metric: string; readonly dim?: string; readonly value?: string }[];
  /** Contributors per group of `metric` grouped by `dim` (Flow's open visits per station). */
  readonly perGroup: readonly { readonly metric: string; readonly dim: string }[];
}

/** A Reliability ending and the figure whose rows list it. */
export const ENDING_ROWS: Readonly<Record<string, string>> = { failed: "X1", interrupted: "S1", unknown: "S2", parked: "S4" };

export function planFor(area: AnalyticsArea, pick: Pick | null): AreaPlan {
  const none = { groups: [], runs: true, flow: false, insights: false, concurrency: false, freshness: false, model: false, contributors: [], perGroup: [] };
  switch (area) {
    case "pulse":
      return { ...none, groups: [G.day!, G.station!, G.kind!], flow: true, insights: true, freshness: true };
    case "flow":
      return { ...none, groups: [G.station!, G.risk!], flow: true, concurrency: true, contributors: [{ metric: "W1" }, { metric: "W2" }, { metric: "W2b" }, { metric: "W3" }], perGroup: [{ metric: "C1", dim: "station" }] };
    case "quality":
      return { ...none, groups: [G.target_kind!, G.rule!, G.day!], contributors: [{ metric: "K4" }, ...(pick && (pick.dim === "target_kind" || pick.dim === "rule") ? [{ metric: pick.dim === "target_kind" ? "Q4" : "R2", dim: pick.dim, value: pick.value }] : [])] };
    case "economics":
      return { ...none, groups: [G.model!, G.token_kind!, G.day!, G.station!, G.phase!], model: true, contributors: [{ metric: "K1" }] };
    case "reliability":
      return { ...none, groups: [G.kind!, G.stop_reason!], contributors: pick?.dim === "outcome" && ENDING_ROWS[pick.value] ? [{ metric: ENDING_ROWS[pick.value]! }] : [] };
    case "compare":
      return { ...none, contributors: [{ metric: "C3" }, { metric: "K4" }] };
    case "opportunities":
      return { ...none, runs: false, insights: true };
  }
}

// --------------------------------------------------------------------------------------- misc

/** A bucket for the parallelism panel: the smallest of a few round sizes giving at most `max` buckets. */
export function concurrencyBucket(fromMs: number, toMs: number, max = 160): number {
  const span = Math.max(1, toMs - fromMs);
  for (const m of [60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, DAY_MS]) if (span / m <= max) return m;
  return Math.ceil(span / max / DAY_MS) * DAY_MS;
}

/**
 * The catalog figures whose rows the observer's contributors route lists (apps/observer/internal/project
 * `ContributorFigures`). Rows of any other figure are not asked for: a request it would refuse is not made.
 */
export const OBSERVER_CONTRIBUTORS: ReadonlySet<string> = new Set(["C1", "C3", "C4", "K4", "W1", "W2", "W2b", "W3", "S4", "Q1", "Q4", "R1", "R5", "X2", "X3", "X1", "S1", "S2", "K1", "K2", "Q2", "Q3", "R2"]);

/** Whether a provider lists the rows of a figure (the simulation answers or refuses from its fixture itself). */
export const listsRowsOf = (provider: "simulation" | "observer", metric: string): boolean => provider === "simulation" || OBSERVER_CONTRIBUTORS.has(metric);

/** A group code the observer's contributors route accepts: the codes its records carry, so anything but control characters and commas. */
export const observerCode = (v: string): boolean => v.length > 0 && v.length <= 128 && !/[\p{Cc},]/u.test(v);

/** Whether the rows of one group of a figure can be asked of a provider. */
export const listsGroupOf = (provider: "simulation" | "observer", group: Readonly<Record<string, string>>): boolean => provider === "simulation" || Object.values(group).every(observerCode);

/** A contributors key in the contract's grammar (`C1`, `C1|station=build`). */
export const contributorsKey = (metric: string, dim?: string, value?: string): string => (dim ? `${metric}|${dim}=${value}` : metric);

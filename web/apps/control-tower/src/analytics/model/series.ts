/**
 * Time series for the trend charts, the brush that turns a dragged range into a window, and the
 * keyboard movement between marks. Pure; tested in test/analytics-ui-model.test.mjs.
 *
 * A series is built from the observer's per-day groups. When a window holds more days than a chart
 * can draw legibly, the days are rolled into whole weeks by summing numerators and denominators
 * (never by averaging rates). A count with nothing recorded on a day is a zero only when the row is
 * answered at all; a rate with an empty denominator has no value.
 */
import type { MetricRow } from "../contract";
import { dailySeries, type DayPoint } from "./charts";

const D = 86_400_000;

export interface Period {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  /** Days rolled into it (1 for a day). */
  readonly days: number;
}

export type Grain = "day" | "week";

/** Days up to this many are drawn as days; more are rolled into weeks. */
export const MAX_DAY_BARS = 60;

export function grainFor(from: number, to: number, maxDays = MAX_DAY_BARS): Grain {
  return Math.ceil((to - from) / D) > maxDays ? "week" : "day";
}

/**
 * The row's series over [from, to) at the grain the window allows. Weeks end at `to` and are counted
 * back from it, so the newest period is always whole; the oldest may be short and says how many days
 * it holds.
 */
export function periodSeries(row: MetricRow | undefined, from: number, to: number, grain: Grain = grainFor(from, to)): Period[] {
  const days = dailySeries(row, from, to);
  if (grain === "day") return days.map((p) => ({ key: p.day, from: p.t, to: p.t + D, value: p.value, numerator: p.numerator, denominator: p.denominator, days: 1 }));
  return rollWeeks(days, row?.kind ?? "count", to);
}

export function rollWeeks(days: readonly DayPoint[], kind: MetricRow["kind"], to: number): Period[] {
  const out: Period[] = [];
  if (days.length === 0) return out;
  const first = days[0]!.t;
  for (let end = to; end > first; end -= 7 * D) {
    const start = end - 7 * D;
    const these = days.filter((p) => p.t >= start && p.t < end);
    if (these.length === 0) continue;
    const anyNum = these.some((p) => p.numerator !== null);
    const anyDen = these.some((p) => p.denominator !== null);
    const num = anyNum ? these.reduce((s, p) => s + (p.numerator ?? 0), 0) : null;
    const den = anyDen ? these.reduce((s, p) => s + (p.denominator ?? 0), 0) : null;
    let value: number | null;
    if (kind === "count") value = these.some((p) => p.value !== null) ? these.reduce((s, p) => s + (p.value ?? 0), 0) : null;
    else value = num !== null && den ? num / den : null;
    out.unshift({ key: new Date(Math.max(start, these[0]!.t)).toISOString().slice(0, 10), from: Math.max(start, these[0]!.t), to: end, value, numerator: num, denominator: den, days: these.length });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ brush

/**
 * A dragged range over `n` equal periods spanning [x0, x1] in pixels, snapped outward to whole
 * periods. Returns the first and last period index, or null when the drag is too short to mean a
 * range (under `minPx`).
 */
export function brushIndices(a: number, b: number, x0: number, x1: number, n: number, minPx = 4): { readonly first: number; readonly last: number } | null {
  if (n <= 0 || x1 <= x0) return null;
  const lo = Math.max(x0, Math.min(a, b));
  const hi = Math.min(x1, Math.max(a, b));
  if (hi - lo < minPx) return null;
  const step = (x1 - x0) / n;
  const first = Math.max(0, Math.min(n - 1, Math.floor((lo - x0) / step)));
  const last = Math.max(first, Math.min(n - 1, Math.ceil((hi - x0) / step) - 1));
  return { first, last };
}

/** The window a brushed range of periods stands for: from the first period's start to the last one's end. */
export function brushWindow(periods: readonly Pick<Period, "from" | "to">[], first: number, last: number): { readonly from: number; readonly to: number } | null {
  const a = periods[Math.min(first, last)];
  const b = periods[Math.max(first, last)];
  if (!a || !b) return null;
  return { from: a.from, to: b.to };
}

// --------------------------------------------------------------------------------- keyboard marks

/**
 * The mark to focus after a key, among `n` marks in reading order (one Tab stop per chart; the
 * arrows move inside it). `cols` > 1 lays them out as a grid (up and down move by a row).
 * Unknown keys return null so the event is left alone.
 */
export function nextMark(current: number, key: string, n: number, cols = 1): number | null {
  if (n <= 0) return null;
  const i = Math.max(0, Math.min(n - 1, current));
  switch (key) {
    case "ArrowRight":
      return Math.min(n - 1, i + 1);
    case "ArrowLeft":
      return Math.max(0, i - 1);
    case "ArrowDown":
      return cols > 1 ? Math.min(n - 1, i + cols) : Math.min(n - 1, i + 1);
    case "ArrowUp":
      return cols > 1 ? Math.max(0, i - cols) : Math.max(0, i - 1);
    case "Home":
      return 0;
    case "End":
      return n - 1;
    case "PageDown":
      return Math.min(n - 1, i + 7);
    case "PageUp":
      return Math.max(0, i - 7);
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------- ranking

export type SortDir = "asc" | "desc";

/**
 * Rows sorted by one column; null values always last whatever the direction (missing is not
 * smallest), then by the key in `tie` so the order is stable.
 */
export function sortRows<T>(rows: readonly T[], value: (r: T) => number | string | null, dir: SortDir, tie: (r: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    if (c !== 0) return dir === "asc" ? c : -c;
    return tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0;
  });
}

/** One page of rows and what is around it. */
export function pageOf<T>(rows: readonly T[], page: number, size: number): { readonly items: readonly T[]; readonly page: number; readonly pages: number; readonly from: number; readonly to: number } {
  const pages = Math.max(1, Math.ceil(rows.length / Math.max(1, size)));
  const p = Math.max(0, Math.min(pages - 1, page));
  const from = p * size;
  const items = rows.slice(from, from + size);
  return { items, page: p, pages, from: rows.length ? from + 1 : 0, to: from + items.length };
}

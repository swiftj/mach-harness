/**
 * How much a sample can say. The documented minimums every area applies before it writes a rate, a
 * percentile, a target verdict, a trend or a comparison, and the density of a history (empty, one
 * finished run, a handful, many) that decides which of those an area offers at all.
 *
 * Pure; tested in test/analytics-ui-model.test.mjs.
 *
 * The minimums (one place, so the words on screen and the tests agree):
 * - a rate is a percentage from SMALL_SAMPLE members; below, it is "k of n" (format.ts);
 * - a target verdict ("meets", "misses") needs SMALL_SAMPLE members, as the observe station refuses
 *   reports on fewer than five tickets;
 * - a median needs 2 measured members (with 1, the value is "the one measured"), a 90th percentile
 *   needs MIN_PERCENTILE (10): below that the 90th is the largest value or next to it;
 * - a trend (a direction over time) needs MIN_TREND_PERIODS periods with a value and
 *   MIN_TREND_MEMBERS members across them;
 * - a comparison sentence needs SMALL_SAMPLE members in each cohort.
 */
import type { AnalyticsSnapshot } from "../contract";
import { SMALL_SAMPLE } from "./format";

export { SMALL_SAMPLE };
export const MIN_MEDIAN = 2;
export const MIN_PERCENTILE = 10;
export const MIN_TREND_PERIODS = 3;
export const MIN_TREND_MEMBERS = SMALL_SAMPLE * 2;

/** Which central figures a duration with `n` measured members may show. */
export function durationShows(n: number | null | undefined): { readonly median: boolean; readonly single: boolean; readonly p90: boolean; readonly mean: boolean } {
  const k = n ?? 0;
  return { single: k === 1, median: k >= MIN_MEDIAN, p90: k >= MIN_PERCENTILE, mean: k >= MIN_MEDIAN };
}

/** Whether a target verdict may be written over `n` members. */
export const verdictAllowed = (n: number | null | undefined): boolean => (n ?? 0) >= SMALL_SAMPLE;

/** Whether a sentence comparing two cohorts may be written. */
export const comparisonAllowed = (a: number, b: number): boolean => a >= SMALL_SAMPLE && b >= SMALL_SAMPLE;

/**
 * The history's density:
 * - "empty": nothing recorded at all (no finished run, no execution, no merge, no visit);
 * - "single": exactly one finished run;
 * - "few": fewer than SMALL_SAMPLE finished runs (rates as k of n, no verdicts, no trends);
 * - "many": enough for rates and, where the periods allow, trends.
 */
export type Density = "empty" | "single" | "few" | "many";

export function densityOf(s: Pick<AnalyticsSnapshot, "runs" | "totals" | "transitions">): Density {
  const t = s.totals;
  const executions = t.X1?.denominator_value ?? 0;
  const merges = t.T1?.numerator_value ?? 0;
  const integrations = t.T2?.numerator_value ?? 0;
  const visits = t.C1?.denominator_value ?? 0;
  if (s.runs.length === 0 && executions === 0 && merges === 0 && integrations === 0 && visits === 0 && s.transitions.length === 0) return "empty";
  if (s.runs.length === 1) return "single";
  if (s.runs.length < SMALL_SAMPLE) return "few";
  return "many";
}

/** "1 of 1", "3 of 4", "67%": a share over n members, as the minimums allow. */
export function shareText(k: number, n: number): string {
  if (n === 0) return "none";
  if (n < SMALL_SAMPLE) return `${k} of ${n}`;
  const p = (k / n) * 100;
  return p !== 0 && Math.abs(p) < 10 && Math.round(p) !== p ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

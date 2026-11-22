/**
 * Time at Groom for small changes beside full slices (M18): the measure of whether asking for a
 * small change got shorter. Read from C1 grouped by station and change (measured groom visits) and
 * C2 grouped by station and widened (tickets at Groom that began as small changes and became full
 * slices, which the observer counts as full slices).
 *
 * A comparison is offered only when each side has SMALL_SAMPLE measured visits (`comparisonAllowed`);
 * below that the counts are said in words and no figure is set beside another.
 *
 * Pure; tested in test/m18-groom-split.test.mjs.
 */
import type { MetricGroup, MetricRow } from "../contract";
import { comparisonAllowed, SMALL_SAMPLE } from "./sample";

export type GroomSplit =
  | { readonly state: "not-told-apart"; readonly reason: string }
  | { readonly state: "too-few"; readonly small: number; readonly full: number; readonly widened: number | null; readonly needed: number }
  | { readonly state: "compare"; readonly small: MetricGroup; readonly full: MetricGroup; readonly widened: number | null };

const groom = (row: MetricRow | undefined, value: string): MetricGroup | undefined => row?.groups?.find((g) => g.key === `groom|${value}`);

export function groomSplit(byChange: MetricRow | undefined, byWidened: MetricRow | undefined): GroomSplit {
  if (!byChange || !Array.isArray(byChange.groups)) {
    return { state: "not-told-apart", reason: byChange?.groups_reason ?? byChange?.null_reason ?? "This source does not record which tickets were small changes." };
  }
  const small = groom(byChange, "small");
  const full = groom(byChange, "full");
  const widened = byWidened && Array.isArray(byWidened.groups) ? (groom(byWidened, "yes")?.denominator ?? 0) : null;
  const ns = small?.denominator ?? 0;
  const nf = full?.denominator ?? 0;
  if (!small || !full || !comparisonAllowed(ns, nf)) return { state: "too-few", small: ns, full: nf, widened, needed: SMALL_SAMPLE };
  return { state: "compare", small, full, widened };
}

/** The note on small changes that became full slices, or null when there were none (or it is not served). */
export function widenedWords(n: number | null): string | null {
  if (!n) return null;
  return n === 1
    ? "1 ticket counted here as a full slice began as a small change and became a full slice."
    : `${n} tickets counted here as full slices began as small changes and became full slices.`;
}

/** The words for a split too thin to compare: the counts, and what a comparison needs. */
export function tooFewWords(s: { readonly small: number; readonly full: number; readonly needed: number }): string {
  const v = (n: number) => `${n} measured visit${n === 1 ? "" : "s"}`;
  return `Too few to compare yet: ${v(s.small)} of small changes and ${v(s.full)} of full slices in this window. Times are set side by side once each has at least ${s.needed}.`;
}

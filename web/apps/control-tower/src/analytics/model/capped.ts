/**
 * Counts read from a contributor list (M6.6 rules review, section d). The snapshot asks for at most
 * `SNAPSHOT_CONTRIBUTORS` (500) rows per figure; a count or sum read from a list cut there is a lower
 * bound, never presented as complete. Where the reply carries the figure itself (a metric's
 * `basis_counts`, a page's `total`), that is used instead. Pure: no React.
 */
import type { ContributorPage } from "../contract";

/** The rows the snapshot asks for per figure (wire/load.ts `SNAPSHOT_CONTRIBUTORS`). */
export const LIST_CAP = 500;

/** Whether a page holds fewer rows than the figure has: cut by the cap or by the observer. */
export function pageCut(page: Pick<ContributorPage, "items" | "total" | "truncated"> | undefined | null): boolean {
  return !!page && (page.truncated || page.total > page.items.length);
}

/** A count of a page's rows matching `pred`: exact when the page is whole, a lower bound when it was cut. */
export interface CappedCount {
  readonly n: number;
  readonly atLeast: boolean;
}

export function cappedCount<T extends ContributorPage["items"][number]>(page: (Pick<ContributorPage, "total" | "truncated"> & { readonly items: readonly T[] }) | undefined | null, pred: (row: T) => boolean): CappedCount {
  if (!page) return { n: 0, atLeast: false };
  return { n: page.items.filter(pred).length, atLeast: pageCut(page) };
}

/** "12", or "at least 12 (the list is cut at 500 rows)". */
export function cappedText(c: CappedCount, fmt: (n: number) => string = (n) => n.toLocaleString("en-GB"), cap = LIST_CAP): string {
  return c.atLeast ? `at least ${fmt(c.n)} (the list is cut at ${cap.toLocaleString("en-GB")} rows)` : fmt(c.n);
}

/** A count the reply carries (a metric's basis count) when it has one, else read from the page (and said as a lower bound when cut). */
export function countOr(fromReply: number | null | undefined, page: Parameters<typeof cappedCount>[0], pred: (row: ContributorPage["items"][number]) => boolean): CappedCount {
  return fromReply !== null && fromReply !== undefined && Number.isFinite(fromReply) ? { n: fromReply, atLeast: false } : cappedCount(page, pred);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/**
 * Basis and coverage of a figure read from run records (rules review d): merged tickets with no run
 * record are not in it. `mergedTotal`: tickets merged in the window as the reply counts them (T1), if known.
 */
export function runRecordFoot(withRecord: number, mergedTotal: number | null, also = ""): string {
  const missing = mergedTotal !== null ? Math.max(0, mergedTotal - withRecord) : 0;
  return `From the run records cleanup writes, one per finished ticket${missing ? `; ${plural(missing, "merged ticket")} with no run record ${missing === 1 ? "is" : "are"} not in it` : ""}${also}.`;
}

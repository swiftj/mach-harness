/**
 * Why recorded cost does not cover every execution, in the observer's own words (real-run defect D8).
 * K1 counts completed executions only; the reply's `coverage.excluded` says which were left out and why
 * ("failed: the Factory's record of a failed execution carries no cost"; "no result yet, or outcome
 * unknown"). A cost that failed executions recorded in their own stream results, when a reply carries
 * it (`coverage.other` with a dollar unit), is said on its own line and is never part of K1, K4 or the
 * per-ticket figure. The observer does not carry that cost with the metric, so it is read from the view's
 * own executions list (`failedCostOf`); `failedResultCost` reads it from a reply that does carry it. Pure: no React.
 */
import type { Coverage } from "../contract";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** "2 failed: …; 1 no result yet, or outcome unknown". Null when nothing was excluded. */
export function costExclusionWords(c: Pick<Coverage, "excluded" | "of" | "covered"> | undefined): string | null {
  const ex = (c?.excluded ?? []).filter((e) => e.count > 0 && !(e as { unit?: string | null }).unit);
  if (ex.length) return ex.map((e) => `${e.count.toLocaleString("en-GB")} ${e.reason}`).join("; ");
  const missing = Math.max(0, (c?.of ?? 0) - (c?.covered ?? 0));
  return missing ? `${plural(missing, "execution")} without a recorded cost; the reply does not say why` : null;
}

/** The cost failed executions recorded in their own results, beside (never in) the figure; null when the reply does not carry it. */
export function failedResultCost(c: Pick<Coverage, "excluded" | "other"> | undefined): { usd: number; executions: number | null } | null {
  const other = c?.other ?? [];
  const money = other.find((o) => o.unit !== null && /^(usd|\$|dollars?)$/i.test(o.unit.trim()));
  if (!money || !Number.isFinite(money.count) || money.count <= 0) return null;
  const counted = other.find((o) => o.unit !== null && /execution/i.test(o.unit))?.count ?? c?.excluded?.find((e) => /^failed\b/i.test(e.reason))?.count ?? null;
  return { usd: money.count, executions: counted !== null && Number.isFinite(counted) ? counted : null };
}

/** "Not in this figure: $3.45 recorded by 2 failed executions in their own results." */
export function failedResultCostWords(f: { usd: number; executions: number | null }): string {
  const who = f.executions !== null ? plural(f.executions, "failed execution") : "failed executions";
  return `Not in this figure: $${f.usd.toFixed(2)} recorded by ${who} in their own results.`;
}

/** What the executions list (`runs?of=executions`, the view's window, filters and cut) says about failed executions' own cost. */
export type FailedCost = { readonly kind: "sum"; readonly usd: number; readonly executions: number } | { readonly kind: "some" } | null;

/**
 * The cost failed executions recorded in their own stream results (`usage.cost_usd`), from the view's
 * executions list. A number only when the list is complete for the window; when it was cut short, only
 * that some did (never a partial sum read as the whole). Null when no failed execution recorded one.
 * `cutMs`: under a day cut, executions from that midnight on are not in the figure's window either.
 */
export function failedCostOf(items: readonly { readonly state: string; readonly started_ms: number | null; readonly usage: { readonly cost_usd: number | null } }[], truncated: boolean, cutMs: number | null = null): FailedCost {
  const failed = items.filter((x) => x.state === "failed" && x.usage.cost_usd !== null && x.usage.cost_usd > 0 && (cutMs === null || (x.started_ms !== null && x.started_ms < cutMs)));
  if (!failed.length) return null;
  if (truncated) return { kind: "some" };
  return { kind: "sum", usd: failed.reduce((n, x) => n + (x.usage.cost_usd ?? 0), 0), executions: failed.length };
}

/** The line beside the figure for a FailedCost. */
export function failedCostWords(f: Exclude<FailedCost, null>): string {
  return f.kind === "sum" ? failedResultCostWords({ usd: f.usd, executions: f.executions }) : "Not in this figure: some failed executions recorded a cost in their own results (the list of executions is cut short, so no sum is given).";
}

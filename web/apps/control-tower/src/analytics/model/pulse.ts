/**
 * The arrangements behind Factory Pulse's four small charts: the belt's share of measured station
 * time in belt order, how claimed executions ended (only when the counts really partition the
 * claims), and recorded cost per period with the periods where executions recorded no cost.
 *
 * None computes a metric: each arranges numerators and denominators the observer served. Pure;
 * tested in test/analytics-ui-model.test.mjs.
 */
import { groupedKey, STATIONS, type AnalyticsSnapshot, type MetricRow, type Station } from "../contract";
import { bottleneckRanking, dailySeries, groupOf, type StationLoad } from "./charts";
import { grainFor, type Grain } from "./series";

const D = 86_400_000;

/** Stations with measured time, in belt order (the human approval wait is not a station visit). */
export function beltShares(c1ByStation: MetricRow | undefined): StationLoad[] {
  return bottleneckRanking(c1ByStation)
    .filter((l) => l.station !== "human")
    .sort((a, b) => STATIONS.indexOf(a.station) - STATIONS.indexOf(b.station));
}

export type OutcomeKey = "completed" | "failed" | "interrupted" | "unknown" | "open";
export interface OutcomePart {
  readonly key: OutcomeKey;
  readonly count: number;
}
export interface OutcomePartition {
  /** Executions claimed in the window: the whole the parts divide. */
  readonly claimed: number;
  readonly parts: readonly OutcomePart[];
  /**
   * True only when completed + failed + interrupted + unknown ≤ claimed, so the strip is one whole;
   * the rest is "no end recorded" (`open`). False when the counts overlap (a recovery counted twice,
   * say): the caller then shows each over its own base, never as parts.
   */
  readonly partition: boolean;
  /** Why there is no strip: no claims, or a count not recorded. Null when there is one. */
  readonly missing: string | null;
}

/** How claimed executions ended: S3's numerator, X1's, S1's interrupted group and S2's, over X1's denominator. */
export function outcomePartition(s: Pick<AnalyticsSnapshot, "totals" | "grouped">): OutcomePartition {
  const t = s.totals;
  const claimed = t.X1?.denominator_value ?? null;
  const completed = t.S3?.numerator_value ?? null;
  const failed = t.X1?.numerator_value ?? null;
  const unknown = t.S2?.numerator_value ?? null;
  const interruptedGroup = groupOf(s.grouped[groupedKey("S1", "kind")], "interrupted");
  const s1Answered = !!s.grouped[groupedKey("S1", "kind")] && t.S1?.status !== "unavailable" && t.S1?.basis !== "not-recorded";
  const interrupted = interruptedGroup ? interruptedGroup.numerator ?? null : s1Answered ? 0 : null;
  if (claimed === null) return { claimed: 0, parts: [], partition: false, missing: "executions claimed are not recorded" };
  if (claimed === 0) return { claimed: 0, parts: [], partition: false, missing: "no execution was claimed in this window" };
  if (completed === null || failed === null || unknown === null || interrupted === null) return { claimed, parts: [], partition: false, missing: "an ending is not recorded" };
  const ended = completed + failed + interrupted + unknown;
  const parts: OutcomePart[] = [
    { key: "completed", count: completed },
    { key: "failed", count: failed },
    { key: "interrupted", count: interrupted },
    { key: "unknown", count: unknown },
  ];
  if (ended > claimed) return { claimed, parts, partition: false, missing: null };
  return { claimed, parts: ended < claimed ? [...parts, { key: "open", count: claimed - ended }] : parts, partition: true, missing: null };
}

export interface CostPeriod {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  /** Recorded dollars (K1's numerator); null when the row has no answer. */
  readonly cost: number | null;
  /** Executions with a recorded cost (K1's denominator). */
  readonly withCost: number;
  /** Executions claimed in the period that recorded no cost: their cost is unknown, not zero. */
  readonly without: number;
}

/** Recorded cost per day or week (from K1 by day), with how many executions recorded none. */
export function costSeries(k1ByDay: MetricRow | undefined, from: number, to: number, grain: Grain = grainFor(from, to)): CostPeriod[] {
  const answered = !!k1ByDay && (k1ByDay.status === undefined || k1ByDay.status === "available" || k1ByDay.status === "partial");
  const days = dailySeries(k1ByDay, from, to).map((p) => {
    const g = k1ByDay?.groups?.find((x) => x.key === p.day);
    const of = g?.coverage.of ?? 0;
    const covered = g?.coverage.covered ?? 0;
    return { key: p.day, from: p.t, to: p.t + D, cost: answered ? (g?.numerator ?? 0) : null, withCost: g?.denominator ?? 0, without: Math.max(0, of - covered) };
  });
  if (grain === "day") return days;
  const out: CostPeriod[] = [];
  if (days.length === 0) return out;
  const first = days[0]!.from;
  for (let end = to; end > first; end -= 7 * D) {
    const start = end - 7 * D;
    const these = days.filter((d) => d.from >= start && d.from < end);
    if (these.length === 0) continue;
    out.unshift({
      key: these[0]!.key,
      from: Math.max(start, these[0]!.from),
      to: end,
      cost: answered ? these.reduce((s, d) => s + (d.cost ?? 0), 0) : null,
      withCost: these.reduce((s, d) => s + d.withCost, 0),
      without: these.reduce((s, d) => s + d.without, 0),
    });
  }
  return out;
}

/** Stations in belt order with their words; `human` is the approval wait. */
export const BELT: readonly Station[] = STATIONS.filter((s) => s !== "human");

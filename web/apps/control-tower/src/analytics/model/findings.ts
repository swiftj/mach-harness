/**
 * Deterministic findings over the observer's rows. Each rule is fixed text with a stated condition,
 * reads only rows the snapshot carries, and is advisory and read-only: it names what to look at,
 * never what to change. No rule proposes weakening verification, security or a person's approval,
 * and none states a cause.
 *
 * Pure; the same snapshot gives the same findings in the same order.
 */
import { groupedKey, type AnalyticsSnapshot, type MetricId } from "../contract";
import { bottleneckRanking, rankGroups } from "./charts";
import { durationText, pct, plural, SMALL_SAMPLE, usd, windowText } from "./format";

export type AreaId = "pulse" | "flow" | "quality" | "economics" | "reliability" | "compare" | "opportunities";

export interface Finding {
  readonly id: string;
  readonly title: string;
  /** The rule, as a condition anyone can check against the measurements. */
  readonly condition: string;
  readonly measurements: readonly { readonly label: string; readonly value: string }[];
  readonly sample: string;
  readonly window: string;
  readonly why: string;
  readonly investigate: string;
  readonly link: { readonly area: AreaId; readonly focus?: string; readonly label: string };
  readonly metrics: readonly MetricId[];
  /** Ordering only: rules are listed by this fixed rank, then by id. Not a score. */
  readonly rank: number;
}

export function findings(s: AnalyticsSnapshot): Finding[] {
  const out: Finding[] = [];
  const win = windowText(s.window.from_ms, s.window.to_ms);
  const t = s.totals;

  // 1. Observe-scorecard targets missed, on enough tickets.
  const q2 = t.Q2;
  if (q2 && q2.value !== null && q2.met === false && (q2.denominator_value ?? 0) >= SMALL_SAMPLE) {
    const rem = s.runs.filter((r) => r.outcome === "merged" && !r.first_pass);
    const vf = rem.filter((r) => r.verify_failures > 0).length;
    out.push({
      id: "first-pass-below-target",
      title: "Fewer tickets pass first time than the observe target",
      condition: "Q2 first-pass rate is below the observe station's target, over at least five merged tickets.",
      measurements: [
        { label: "First-pass rate (Q2)", value: pct(q2.value) },
        { label: "Target", value: "above 85%" },
        { label: "Remediated, via a failed verification", value: `${vf} of ${rem.length}` },
      ],
      sample: plural(q2.denominator_value ?? 0, "merged ticket"),
      window: win,
      why: "Each extra judging round repeats build, verification and review for the same slice.",
      investigate: "Read the remediation paths and the verification failures by kind; compare with the blockers by rule.",
      link: { area: "quality", focus: "paths", label: "Open remediation paths" },
      metrics: ["Q2", "Q3", "Q4"],
      rank: 1,
    });
  }

  // 2. Where measured station time went.
  const ranking = bottleneckRanking(s.grouped[groupedKey("C1", "station")]);
  const top = ranking[0];
  if (top && top.share >= 0.35 && top.visits >= SMALL_SAMPLE) {
    out.push({
      id: `station-time-${top.station}`,
      title: `Most measured station time is spent in ${top.station}`,
      condition: "One station holds at least 35% of all measured visit time (C1's numerator by station), over at least five visits.",
      measurements: [
        { label: "Share of measured time", value: pct(top.share) },
        { label: "Visits", value: String(top.visits) },
        { label: "Median, 90th percentile", value: `${durationText(top.p50)}, ${durationText(top.p90)}` },
      ],
      sample: plural(top.visits, "measured visit"),
      window: win,
      why: "Time here is multiplied by every ticket that passes through, including revise rounds.",
      investigate: `Open ${top.station} in Factory Flow and read its slowest visits and its revise rounds.`,
      link: { area: "flow", focus: top.station, label: `Open ${top.station} in Factory Flow` },
      metrics: ["C1"],
      rank: 2,
    });
  }

  // 3. Verification failures concentrated in one kind.
  const q4 = rankGroups(s.grouped[groupedKey("Q4", "target_kind")]);
  const q4Total = q4.reduce((n, g) => n + (g.value ?? 0), 0);
  const kind = q4[0];
  if (kind && (kind.value ?? 0) >= 3 && q4Total > 0 && (kind.value ?? 0) / q4Total >= 0.4) {
    out.push({
      id: `verify-kind-${kind.key}`,
      title: `Verification failures cluster in ${kind.key} checks`,
      condition: "One check kind holds at least 40% of failed checks (Q4), with at least three failures.",
      measurements: [
        { label: `Failed ${kind.key} checks`, value: String(kind.value) },
        { label: "All failed checks", value: String(q4Total) },
      ],
      sample: plural(q4Total, "failed check"),
      window: win,
      why: "A recurring kind of failed evidence often points to one gap in how the slice is built or specified.",
      investigate: "Open the failures of this kind and read the verifier's findings for the tickets they came from.",
      link: { area: "quality", focus: "failures", label: "Open failure categories" },
      metrics: ["Q4"],
      rank: 3,
    });
  }

  // 4. A person's approval waits are long.
  const w3 = t.W3;
  if (w3 && w3.p90_ms !== undefined && (w3.denominator_value ?? 0) >= SMALL_SAMPLE && w3.p90_ms > 8 * 3_600_000) {
    out.push({
      id: "human-approval-wait",
      title: "Tickets wait hours for a person's approval",
      condition: "The 90th percentile of human approval waits (W3) is over 8 hours, over at least five waits.",
      measurements: [
        { label: "Median wait", value: durationText(w3.p50_ms) },
        { label: "90th percentile", value: durationText(w3.p90_ms) },
        { label: "Rounds awaiting a person", value: String(w3.denominator_value) },
      ],
      sample: plural(w3.denominator_value ?? 0, "approval wait"),
      window: win,
      why: "The ticket is finished and verified while it waits; the wait is the person's queue, not the Factory's.",
      investigate: "See which tickets waited longest and when the approvals arrived. The approval itself stays required.",
      link: { area: "flow", focus: "human", label: "Open the approval wait" },
      metrics: ["W3"],
      rank: 4,
    });
  }

  // 5. Recorded cost is incomplete.
  const k1 = t.K1;
  if (k1 && k1.coverage.share !== null && k1.coverage.share < 0.95 && k1.coverage.of !== null) {
    const missing = (k1.coverage.of ?? 0) - (k1.coverage.covered ?? 0);
    out.push({
      id: "cost-coverage",
      title: `${plural(missing, "execution")} have no recorded cost`,
      condition: "Fewer than 95% of claimed executions carry a recorded cost (K1 coverage).",
      measurements: [
        { label: "With a recorded cost", value: `${k1.coverage.covered} of ${k1.coverage.of}` },
        { label: "Recorded total", value: usd(k1.numerator_value) },
      ],
      sample: plural(k1.coverage.of ?? 0, "execution"),
      window: win,
      why: "A run without a result reports no cost, so every cost total here is a lower bound.",
      investigate: "List the executions without a recorded cost and read how each ended.",
      link: { area: "economics", focus: "coverage", label: "Open cost coverage" },
      metrics: ["K1"],
      rank: 5,
    });
  }

  // 6. A blocker rule that recurs across tickets.
  const r2 = rankGroups(s.grouped[groupedKey("R2", "rule")]);
  const rule = r2[0];
  if (rule && (rule.value ?? 0) >= 3) {
    const tickets = new Set((s.contributors[`R2|rule=${rule.key}`]?.items ?? []).map((c) => c.ticket)).size;
    if (tickets >= 2)
      out.push({
        id: "recurring-blocker",
        title: `Reviewers block most often on “${rule.key}”`,
        condition: "One rule accounts for the most blocker findings (R2), on at least two tickets and three findings.",
        measurements: [
          { label: "Blockers citing it", value: String(rule.value) },
          { label: "Tickets", value: String(tickets) },
        ],
        sample: plural(r2.reduce((n, g) => n + (g.value ?? 0), 0), "blocker finding"),
        window: win,
        why: "The observe station proposes a rule when a pattern like this recurs; this is the same grouping.",
        investigate: "Read the findings that cite it. Tuning, if any, goes through a factory-tuning ticket and its review.",
        link: { area: "quality", focus: "blockers", label: "Open blockers by rule" },
        metrics: ["R2"],
        rank: 6,
      });
  }

  // 7. Executions whose outcome is unknown.
  const s2 = t.S2;
  if (s2 && (s2.numerator_value ?? 0) > 0) {
    out.push({
      id: "outcome-unknown",
      title: `${plural(s2.numerator_value ?? 0, "execution")} ended with an unknown outcome`,
      condition: "Any execution was closed as outcome-unknown (S2).",
      measurements: [
        { label: "Unknown", value: `${s2.numerator_value} of ${s2.denominator_value}` },
        { label: "Recoveries started (S1)", value: String(t.S1?.numerator_value ?? "–") },
      ],
      sample: plural(s2.denominator_value ?? 0, "claimed execution"),
      window: win,
      why: "The supervisor could not tell how these ended; nothing about them is counted as success or failure.",
      investigate: "Open each one and check the cell's own records for what happened.",
      link: { area: "reliability", focus: "unknown", label: "Open execution outcomes" },
      metrics: ["S2", "S1"],
      rank: 7,
    });
  }

  return out.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
}

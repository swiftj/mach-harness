/**
 * Pure chart models for Factory Analytics: scales and ticks, histograms read from the observer's
 * log buckets, daily and weekly series, the bottleneck ranking, the Factory Flow layout, remediation
 * paths, strip layouts and comparison cohorts. No React, no DOM; tested in
 * test/analytics-model.test.mjs.
 *
 * None of these computes a metric. They arrange rows the observer returned: sums of numerators and
 * denominators across groups (shared contracts 4.6: rates are recomputed from summed numerators and
 * denominators, never averaged), bucket counts, and positions.
 */
import { STATIONS, type Contributor, type HistBucket, type MetricGroup, type MetricRow, type RunRecord, type Station, type Transition } from "../contract";
import { SMALL_SAMPLE } from "./format";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

// ------------------------------------------------------------------------------------- scales

export interface Linear {
  readonly d0: number;
  readonly d1: number;
  readonly r0: number;
  readonly r1: number;
  (v: number): number;
}
export function linear(d0: number, d1: number, r0: number, r1: number): Linear {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return Object.assign((v: number) => r0 + (v - d0) * k, { d0, d1, r0, r1 });
}

/** Round tick steps (1, 2, 5 × 10^n) from 0 to at least max, about `target` of them. Zero-based. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const top = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Log-scale duration ticks that read as people say them, inside [lo, hi]. */
const DURATION_TICKS = [S, 10 * S, MIN, 5 * MIN, 15 * MIN, 30 * MIN, H, 2 * H, 4 * H, 8 * H, D, 2 * D, 7 * D, 30 * D];
export function durationTicks(lo: number, hi: number, maxTicks = 6): number[] {
  const inside = DURATION_TICKS.filter((t) => t >= lo * 0.999 && t <= hi * 1.001);
  if (inside.length <= maxTicks) return inside;
  const step = Math.ceil(inside.length / maxTicks);
  return inside.filter((_, i) => i % step === 0);
}
export function logScale(lo: number, hi: number, r0: number, r1: number): (v: number) => number {
  const a = Math.log(Math.max(1, lo));
  const b = Math.log(Math.max(lo + 1, hi));
  return (v: number) => r0 + ((Math.log(Math.max(1, v)) - a) / (b - a)) * (r1 - r0);
}

// ----------------------------------------------------------------------------------- histograms

export interface HistBin {
  readonly fromMs: number;
  readonly toMs: number;
  readonly count: number;
}
/**
 * The observer's histogram buckets (each a third of a doubling of time, `ge_ms` to `le_ms`, empty ones
 * possibly left out) merged into whole doublings, with empty doublings between the first and last
 * filled in and one empty bin either side. Counts are kept exactly; nothing is smoothed.
 */
export function histogramBins(buckets: readonly HistBucket[] | undefined): HistBin[] {
  if (!buckets || buckets.length === 0) return [];
  const byK = new Map<number, number>();
  for (const b of buckets) {
    // Bucket 0 is under a second; bucket i >= 1 starts at 2^((i-1)/3) s, so its doubling is floor((i-1)/3).
    const i = b.ge_ms < 1000 ? 0 : Math.round(3 * Math.log2(b.ge_ms / 1000)) + 1;
    const k = i === 0 ? -1 : Math.floor((i - 1) / 3);
    byK.set(k, (byK.get(k) ?? 0) + b.count);
  }
  const ks = [...byK.keys()].filter((k) => (byK.get(k) ?? 0) > 0);
  if (ks.length === 0) return [];
  const lo = Math.max(-1, Math.min(...ks) - 1);
  const hi = Math.max(...ks) + 1;
  const out: HistBin[] = [];
  for (let k = lo; k <= hi; k++) out.push({ fromMs: k === -1 ? 0 : 1000 * 2 ** k, toMs: k === -1 ? 1000 : 1000 * 2 ** (k + 1), count: byK.get(k) ?? 0 });
  return out;
}

/** Values in equal-width bins from zero: [0, step), [step, 2·step)… Null values are not binned (they are counted apart). */
export function valueBins(values: readonly (number | null)[], step: number): { from: number; to: number; count: number }[] {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0 || !(step > 0)) return [];
  const n = Math.floor(Math.max(...xs) / step) + 1;
  const out = Array.from({ length: n }, (_, i) => ({ from: i * step, to: (i + 1) * step, count: 0 }));
  for (const v of xs) out[Math.min(n - 1, Math.floor(v / step))]!.count++;
  return out;
}

export const histTotal = (buckets: readonly HistBucket[] | undefined): number => (buckets ?? []).reduce((s, b) => s + b.count, 0);

// ---------------------------------------------------------------------------------- transitions

export type TransitionKind = "forward" | "revise" | "exit";
/** A move back to build after a failed verification or a rejected review is a revise loop; blocked and abandoned are exits. */
export function transitionKind(t: Pick<Transition, "from" | "to">): TransitionKind {
  if (t.to === "blocked" || t.to === "abandoned") return "exit";
  if (t.to === "build" && (t.from === "verify" || t.from === "review")) return "revise";
  return "forward";
}

/** Words for a contributing entity, from its reference alone: "SYN-050 build #1", "SYN-050". */
export function refLabel(c: Pick<Contributor, "ref" | "ticket" | "execution">): { readonly primary: string; readonly secondary: string | null } {
  const [kind, ...rest] = c.ref.split(":");
  const id = rest.join(":");
  if (kind === "visit") {
    const m = /^(.+)\/(\w+)#(\d+)$/.exec(id);
    if (m) return { primary: m[1]!, secondary: `${m[2]}, visit ${m[3]}` };
  }
  if (kind === "gate") {
    const m = /^(.+)\/(\w+)(?:#(\d+))?$/.exec(id);
    if (m) return { primary: m[1]!, secondary: m[3] ? `${m[2]} round ${m[3]}` : `${m[2]} gate` };
  }
  if (kind === "finding") {
    const m = /^(.+)\/r(\d+)\/(\w+)/.exec(id);
    if (m) return { primary: m[1]!, secondary: `round ${m[2]}, ${m[3]} seat` };
  }
  if (kind === "execution" || kind === "agent") return { primary: c.ticket ?? id, secondary: kind === "agent" ? "agent" : `execution ${c.execution ?? id}` };
  // Any other kind (a wait, a human hold, a task): the ticket in words, the kind beside it; never the raw id as text.
  const ticket = c.ticket ?? (id.includes("/") ? id.split("/")[0]! : null);
  if (ticket) return { primary: ticket, secondary: KIND_WORDS[kind ?? ""] ?? (kind ? kind.replace(/[-_]/g, " ") : null) };
  return { primary: id, secondary: null };
}

const KIND_WORDS: Readonly<Record<string, string>> = { human: "waiting for a person", wait: "wait", task: "build task", cell: "ticket", slice: "slice", review: "review", verification: "verification" };



// --------------------------------------------------------------------------------------- series

export interface DayPoint {
  readonly day: string;
  readonly t: number;
  /** Count, rate or mean for the day; null when the day has no denominator (never 0 for a rate). */
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
}

/** Every UTC day in [from, to), with the group's value or, for a count, 0 when nothing was recorded. */
export function dailySeries(row: MetricRow | undefined, from: number, to: number): DayPoint[] {
  // A row with no answer (not recorded, deferred, not available under a filter) has no days, not zero days.
  const answered = !!row && (row.status === undefined || row.status === "available" || row.status === "partial");
  const byDay = new Map((row?.groups ?? []).map((g) => [g.key, g] as const));
  const out: DayPoint[] = [];
  for (let t = Math.floor(from / D) * D; t < to; t += D) {
    const day = new Date(t).toISOString().slice(0, 10);
    const g = byDay.get(day);
    if (row?.kind === "count" && answered) out.push({ day, t, value: g?.value ?? 0, numerator: g?.numerator ?? 0, denominator: null });
    else out.push({ day, t, value: g?.value ?? null, numerator: g?.numerator ?? null, denominator: g?.denominator ?? null });
  }
  return out;
}

export interface WeekPoint {
  readonly from: number;
  readonly to: number;
  readonly numerator: number;
  readonly denominator: number;
  /** num/den for rates and means; the sum for counts; null when the denominator is empty. */
  readonly value: number | null;
  readonly days: number;
}

/** Days rolled into weeks ending at `to`, by summing numerators and denominators. */
export function weekly(points: readonly DayPoint[], kind: MetricRow["kind"], to: number): WeekPoint[] {
  const weeks: WeekPoint[] = [];
  // Whole weeks only, counted back from the window's end: a partial first week would read as a dip.
  const n = Math.floor(points.length / 7);
  for (let w = 0; w < n; w++) {
    const end = to - w * 7 * D;
    const start = end - 7 * D;
    const days = points.filter((p) => p.t + D > start && p.t < end);
    if (days.length === 0) continue;
    const num = days.reduce((s, p) => s + (p.numerator ?? 0), 0);
    const den = days.reduce((s, p) => s + (p.denominator ?? 0), 0);
    weeks.unshift({ from: Math.max(start, days[0]!.t), to: end, numerator: num, denominator: den, value: kind === "count" ? num : den === 0 ? null : num / den, days: days.length });
  }
  return weeks;
}

/** Whether a series has enough behind it to call a direction: at least three periods with values and SMALL_SAMPLE members in all. */
export function trendClaimable(weeks: readonly WeekPoint[], kind: MetricRow["kind"]): boolean {
  const withValue = weeks.filter((w) => w.value !== null);
  const members = kind === "count" ? withValue.reduce((s, w) => s + w.numerator, 0) : withValue.reduce((s, w) => s + w.denominator, 0);
  return withValue.length >= 3 && members >= SMALL_SAMPLE * 2;
}

// ---------------------------------------------------------------------------------- bottlenecks

export interface StationLoad {
  readonly station: Station;
  readonly visits: number;
  /** Sum of measured visit durations (C1's numerator for the station). */
  readonly totalMs: number;
  readonly share: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}

/**
 * Where measured station time went: each station's total measured time (visits × their durations,
 * which is C1's numerator), so one slow visit cannot outrank a station that held dozens. Ties keep
 * belt order. The human approval wait is not a station visit and is ranked separately (W3).
 */
export function bottleneckRanking(c1ByStation: MetricRow | undefined): StationLoad[] {
  const groups = (c1ByStation?.groups ?? []).filter((g) => (STATIONS as readonly string[]).includes(g.key) && (g.denominator ?? 0) > 0);
  const total = groups.reduce((s, g) => s + (g.numerator ?? 0), 0);
  return groups
    .map((g) => ({ station: g.key as Station, visits: g.denominator ?? 0, totalMs: g.numerator ?? 0, share: total ? (g.numerator ?? 0) / total : 0, p50: g.p50_ms ?? null, p90: g.p90_ms ?? null, max: g.max_ms ?? null }))
    .sort((a, b) => b.totalMs - a.totalMs || STATIONS.indexOf(a.station) - STATIONS.indexOf(b.station));
}

// ---------------------------------------------------------------------------------- Factory Flow

export interface FlowNode {
  readonly station: Station | "blocked" | "abandoned";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface FlowEdge {
  readonly from: FlowNode["station"];
  readonly to: FlowNode["station"];
  readonly count: number;
  readonly kind: TransitionKind;
  /** SVG path. */
  readonly d: string;
  /** Where its count label sits. */
  readonly lx: number;
  readonly ly: number;
  /** Stroke width, by count: 1 to 6 px on a square-root scale (area reads as volume). */
  readonly weight: number;
}
export interface FlowLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

/**
 * The belt laid out left to right on one row, the human approval wait set below between review and
 * merge, revise loops drawn as arcs under the row back to build, and exits (blocked, abandoned) as
 * stubs below. Edges are recorded station-to-station moves, not ticket trajectories.
 */
export function flowLayout(transitions: readonly Transition[], width: number, opts: { nodeW?: number; nodeH?: number; top?: number } = {}): FlowLayout {
  const main: Station[] = ["groom", "plan", "audit", "build", "verify", "review", "merge", "cleanup"];
  const top = opts.top ?? 34;
  const gap = 18;
  const nodeW = opts.nodeW ?? Math.max(78, Math.min(132, (width - gap * (main.length - 1)) / main.length));
  const nodeH = opts.nodeH ?? 74;
  const used = nodeW * main.length + gap * (main.length - 1);
  const x0 = Math.max(0, (width - used) / 2);
  const nodes = new Map<FlowNode["station"], FlowNode>();
  main.forEach((st, i) => nodes.set(st, { station: st, x: x0 + i * (nodeW + gap), y: top, w: nodeW, h: nodeH }));
  const rv = nodes.get("review")!;
  const mg = nodes.get("merge")!;
  const humanY = top + nodeH + 92;
  const humanW = Math.max(nodeW, 124);
  nodes.set("human", { station: "human", x: Math.min(width - humanW - 2, (rv.x + mg.x + nodeW) / 2 - humanW / 2), y: humanY, w: humanW, h: nodeH - 14 });
  // Exits sit under the station most tickets left from, right-aligned to it, below the revise loops.
  const exitY = humanY + 22;
  const exitW = 104;
  const placed: { x: number; w: number }[] = [nodes.get("human")!];
  for (const exit of ["blocked", "abandoned"] as const) {
    const from = transitions.filter((t) => t.to === exit).sort((p, q) => q.count - p.count)[0];
    const src = from ? nodes.get(from.from) : undefined;
    let x = src ? src.x + src.w - exitW : x0;
    for (const o of placed) if (x < o.x + o.w + 10 && x + exitW > o.x - 10) x = o.x - exitW - 14;
    x = Math.max(0, x);
    placed.push({ x, w: exitW });
    nodes.set(exit, { station: exit, x, y: exitY, w: exitW, h: 30 });
  }

  const max = Math.max(1, ...transitions.map((t) => t.count));
  const weight = (c: number) => 1 + 5 * Math.sqrt(c / max);
  const edges: FlowEdge[] = [];
  let reviseDepth = 0;
  for (const t of transitions) {
    const a = nodes.get(t.from);
    const b = nodes.get(t.to);
    if (!a || !b) continue;
    const w = weight(t.count);
    if (transitionKind(t) === "revise") {
      // Under the row, from the bottom of the later station back to the bottom of build.
      reviseDepth++;
      const depth = 26 + reviseDepth * 22;
      const ax = a.x + a.w * 0.35;
      const bx = b.x + b.w * 0.65;
      const y = a.y + a.h;
      edges.push({ from: t.from, to: t.to, count: t.count, kind: transitionKind(t), weight: w, d: `M${ax} ${y}C${ax} ${y + depth} ${bx} ${y + depth} ${bx} ${y + 6}`, lx: (ax + bx) / 2, ly: y + depth * 0.75 + 15 });
    } else if (t.to === "human") {
      const ax = a.x + a.w * 0.7;
      edges.push({ from: t.from, to: t.to, count: t.count, kind: transitionKind(t), weight: w, d: `M${ax} ${a.y + a.h}C${ax} ${b.y - 20} ${b.x + 12} ${b.y - 30} ${b.x + 18} ${b.y - 4}`, lx: ax + 8, ly: (a.y + a.h + b.y) / 2 + 6 });
    } else if (t.from === "human") {
      const bx = b.x + b.w * 0.25;
      edges.push({ from: t.from, to: t.to, count: t.count, kind: transitionKind(t), weight: w, d: `M${a.x + a.w - 18} ${a.y}C${a.x + a.w - 12} ${a.y - 30} ${bx} ${b.y + b.h + 20} ${bx} ${b.y + b.h + 4}`, lx: bx + 6, ly: (a.y + b.y + b.h) / 2 + 12 });
    } else if (transitionKind(t) === "exit") {
      // From the station's right edge, down to the exit box: clear of the revise loops' start points.
      const ax = a.x + a.w - 8;
      const bx = b.x + b.w - 14;
      edges.push({ from: t.from, to: t.to, count: t.count, kind: transitionKind(t), weight: Math.min(2.5, Math.max(1, w * 0.6)), d: `M${ax} ${a.y + a.h}C${ax} ${b.y - 30} ${bx} ${b.y - 30} ${bx} ${b.y - 3}`, lx: bx, ly: b.y - 6 });
    } else {
      // Forward: along the row, or skipping a station in an arc above it.
      const ia = main.indexOf(t.from as Station);
      const ib = main.indexOf(t.to as Station);
      const y = a.y + a.h / 2;
      if (ib === ia + 1) edges.push({ from: t.from, to: t.to, count: t.count, kind: transitionKind(t), weight: w, d: `M${a.x + a.w} ${y}H${b.x - 3}`, lx: (a.x + a.w + b.x) / 2, ly: y - 8 });
      else {
        const lift = 22 + (ib - ia) * 4;
        edges.push({ from: t.from, to: t.to, count: t.count, kind: transitionKind(t), weight: w, d: `M${a.x + a.w / 2} ${a.y}C${a.x + a.w / 2} ${a.y - lift} ${b.x + b.w / 2} ${b.y - lift} ${b.x + b.w / 2} ${b.y - 4}`, lx: (a.x + b.x + b.w) / 2, ly: a.y - lift + 4 });
      }
    }
  }
  const bottom = Math.max(...[...nodes.values()].map((n) => n.y + n.h)) + 8;
  return { width, height: bottom, nodes: [...nodes.values()], edges };
}

// ------------------------------------------------------------------------------ remediation paths

export type PathKey = "first-pass" | "verify-then-pass" | "review-then-pass" | "both-then-pass" | "escalated-merged" | "escalated-abandoned" | "abandoned";
export interface RemediationPath {
  readonly key: PathKey;
  readonly words: string;
  /** The rounds this path took, as marks: pass, verification failure, rejection, escalation, abandonment. */
  readonly steps: readonly ("pass" | "verify-fail" | "reject" | "escalate" | "abandon")[];
  readonly tickets: readonly string[];
}

/** How finished tickets got to their outcome, from runs.jsonl fields only. Counts are tickets, not rounds. */
export function remediationPaths(runs: readonly RunRecord[]): RemediationPath[] {
  const words: Readonly<Record<PathKey, string>> = {
    "first-pass": "Passed verification and review first time",
    "verify-then-pass": "Failed verification, revised, then passed",
    "review-then-pass": "Rejected in review, revised, then approved",
    "both-then-pass": "Failed verification and was rejected, then passed",
    "escalated-merged": "Escalated at the third round; a person merged it",
    "escalated-abandoned": "Escalated at the third round; abandoned",
    abandoned: "Abandoned before a verdict",
  };
  const out = new Map<PathKey, { steps: RemediationPath["steps"]; tickets: string[] }>();
  for (const r of runs) {
    let key: PathKey;
    let steps: RemediationPath["steps"];
    if (r.escalated) {
      key = r.outcome === "merged" ? "escalated-merged" : "escalated-abandoned";
      steps = [...Array.from({ length: Math.max(0, (r.rounds ?? 3) - 1) }, (): RemediationPath["steps"][number] => (r.verify_failures > 0 ? "verify-fail" : "reject")), "escalate", ...(r.outcome === "merged" ? (["pass"] as const) : (["abandon"] as const))];
    } else if (r.outcome !== "merged") {
      key = "abandoned";
      steps = ["abandon"];
    } else if (r.first_pass) {
      key = "first-pass";
      steps = ["pass"];
    } else if (r.verify_failures > 0 && r.review_rejections > 0) {
      key = "both-then-pass";
      steps = ["verify-fail", "reject", "pass"];
    } else if (r.verify_failures > 0) {
      key = "verify-then-pass";
      steps = [...Array.from({ length: r.verify_failures }, () => "verify-fail" as const), "pass"];
    } else {
      key = "review-then-pass";
      steps = [...Array.from({ length: Math.max(1, r.review_rejections) }, () => "reject" as const), "pass"];
    }
    const p = out.get(key) ?? { steps, tickets: [] };
    if (steps.length > p.steps.length) p.steps = steps;
    p.tickets.push(r.ticket_id);
    out.set(key, p);
  }
  const order: PathKey[] = ["first-pass", "verify-then-pass", "review-then-pass", "both-then-pass", "escalated-merged", "escalated-abandoned", "abandoned"];
  return order.filter((k) => out.has(k)).map((k) => ({ key: k, words: words[k], steps: out.get(k)!.steps, tickets: out.get(k)!.tickets }));
}

/** Judging rounds per merged ticket (Q3's records), as counts per round number. */
export function roundsDistribution(runs: readonly RunRecord[]): { rounds: number; tickets: number; escalated: number }[] {
  const m = new Map<number, { tickets: number; escalated: number }>();
  for (const r of runs) {
    if (r.outcome !== "merged" || r.rounds === null) continue;
    const e = m.get(r.rounds) ?? { tickets: 0, escalated: 0 };
    e.tickets++;
    if (r.escalated) e.escalated++;
    m.set(r.rounds, e);
  }
  const max = Math.max(3, ...m.keys());
  return Array.from({ length: max }, (_, i) => ({ rounds: i + 1, ...(m.get(i + 1) ?? { tickets: 0, escalated: 0 }) }));
}

// ------------------------------------------------------------------------------------ strip plots

export interface StripDot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}
/**
 * Dots on one axis without overlap: each dot takes the first row (alternating above and below the
 * centre) where it clears the dots already placed by `r * 2 + 1`. Input order decides ties, so the
 * layout is stable.
 */
export function stripLayout(items: readonly { id: string; x: number }[], cy: number, r: number, maxRows = 6): StripDot[] {
  const placed: StripDot[] = [];
  const sorted = [...items].sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1));
  for (const it of sorted) {
    for (let k = 0; k <= maxRows * 2; k++) {
      const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (r * 2 + 1);
      const y = cy + off;
      if (placed.every((p) => Math.abs(p.y - y) > 0.1 || Math.abs(p.x - it.x) >= r * 2 + 1)) {
        placed.push({ id: it.id, x: it.x, y });
        break;
      }
      if (k === maxRows * 2) placed.push({ id: it.id, x: it.x, y: cy });
    }
  }
  return placed;
}

/** The median of the values given (no interpolation across a gap when even: the lower middle, as a recorded value). */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

// ---------------------------------------------------------------------------------------- groups

export function groupOf(row: MetricRow | undefined, key: string): MetricGroup | undefined {
  return row?.groups?.find((g) => g.key === key);
}

/** Groups sorted by value, largest first, nulls last; keys break ties. */
export function rankGroups(row: MetricRow | undefined, by: "value" | "numerator" | "denominator" = "value"): MetricGroup[] {
  return [...(row?.groups ?? [])].sort((a, b) => (b[by] ?? -Infinity) - (a[by] ?? -Infinity) || (a.key < b.key ? -1 : 1));
}

// ------------------------------------------------------------------------------------ concurrency

/** A stepped path for counts per bucket, on its own scale: [x0..x1] × [yBase..yTop]. */
export function stepPath(counts: readonly number[], x0: number, x1: number, yBase: number, yTop: number, scaleMax: number): string {
  if (counts.length === 0) return "";
  const dx = (x1 - x0) / counts.length;
  const y = (c: number) => yBase - (c / Math.max(1, scaleMax)) * (yBase - yTop);
  let d = "";
  counts.forEach((c, i) => {
    d += `${i === 0 ? "M" : "L"}${(x0 + i * dx).toFixed(1)} ${y(c).toFixed(1)}H${(x0 + (i + 1) * dx).toFixed(1)}`;
  });
  return d;
}

// --------------------------------------------------------------------------------------- compare

export interface Cohort {
  readonly label: string;
  readonly runs: readonly RunRecord[];
}
export interface CohortSummary {
  readonly label: string;
  readonly finished: number;
  readonly merged: number;
  readonly firstPass: number;
  readonly rounds: readonly number[];
  readonly escalated: number;
  /** Whether this cohort is big enough to state a rate (SMALL_SAMPLE merged tickets). */
  readonly enough: boolean;
}
export function cohortSummary(c: Cohort): CohortSummary {
  const merged = c.runs.filter((r) => r.outcome === "merged");
  return {
    label: c.label,
    finished: c.runs.length,
    merged: merged.length,
    firstPass: merged.filter((r) => r.first_pass).length,
    rounds: merged.map((r) => r.rounds).filter((x): x is number => x !== null),
    escalated: c.runs.filter((r) => r.escalated).length,
    enough: merged.length >= SMALL_SAMPLE,
  };
}

/** Cautious words for a difference between two cohorts' rates; never a cause. */
export function compareWords(a: CohortSummary, b: CohortSummary): string {
  if (!a.enough || !b.enough) return `Too few merged tickets to compare (${a.merged} and ${b.merged}; at least ${SMALL_SAMPLE} each).`;
  const ra = a.firstPass / a.merged;
  const rb = b.firstPass / b.merged;
  const diff = Math.round(Math.abs(ra - rb) * 100);
  if (diff < 10) return `First-pass rates are within ${Math.max(diff, 1)} ${Math.max(diff, 1) === 1 ? "point" : "points"} of each other; with these sample sizes that is no recorded difference.`;
  return `${ra > rb ? a.label : b.label} passed first time more often in this window (${diff} points). This is an observed difference between groups of tickets, not a cause: the work in each group differed.`;
}

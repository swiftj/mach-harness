/**
 * What to draw of a row at this zoom, decided once per draw and reused for hit-testing. Pure.
 *
 * Culling: a lane's spans are sorted by start; a prefix maximum of their ends makes "the first span
 * that may reach the window" a binary search too, so an open span (end +Infinity) never hides what
 * follows it. Only [first, last) is looked at.
 *
 * Level of detail (design section 3B):
 * - under 1.5 px: the span joins its row's density run (one tint bar; the count is in the hover card);
 * - 1.5 px to 28 px: geometry only; 28 px and wider: a label; 96 px and wider: a duration as well;
 * - instants (tool calls, gate and review verdicts, people's acts) are drawn one by one only while
 *   the row holds fewer than one per 6 px in view; otherwise as count pips.
 */
import { extentOf, noEndRecorded, type TimelineMark, type TimelineSpan, type TrackNode } from "../contract";
import type { Scale } from "./scale";
import { xAt } from "./scale";

export const LOD = { densityPx: 1.5, labelPx: 28, durationPx: 96, instantPx: 6, pipPx: 24, stubPx: 24 } as const;

export type SpanLod = "geometry" | "label" | "duration";

export function lodOf(widthPx: number): SpanLod | "density" {
  if (widthPx < LOD.densityPx) return "density";
  if (widthPx < LOD.labelPx) return "geometry";
  if (widthPx < LOD.durationPx) return "label";
  return "duration";
}

/** Spans drawn as instants (ticks), whatever their length. */
export function isInstantSpan(span: TimelineSpan): boolean {
  return span.kind === "tool";
}

// ---------------------------------------------------------------- culling

export interface LaneIndex {
  readonly spans: readonly TimelineSpan[];
  readonly starts: Float64Array;
  /** Prefix maximum of each span's latest instant (+Infinity while open). */
  readonly maxTo: Float64Array;
}

const indexes = new WeakMap<readonly TimelineSpan[], LaneIndex>();

/** The lane's index, built once per spans array (the tracks model keeps arrays stable across rebuilds). */
export function laneIndex(spans: readonly TimelineSpan[]): LaneIndex {
  const cached = indexes.get(spans);
  if (cached) return cached;
  let list = spans;
  const from = (s: TimelineSpan) => extentOf(s)?.from ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < spans.length; i++) {
    if (from(spans[i]!) < from(spans[i - 1]!)) {
      list = [...spans].sort((a, b) => from(a) - from(b));
      break;
    }
  }
  const starts = new Float64Array(list.length);
  const maxTo = new Float64Array(list.length);
  let running = Number.NEGATIVE_INFINITY;
  list.forEach((s, i) => {
    const x = extentOf(s);
    starts[i] = x ? x.from : Number.POSITIVE_INFINITY;
    running = Math.max(running, x ? x.to : Number.NEGATIVE_INFINITY);
    maxTo[i] = running;
  });
  const index = { spans: list, starts, maxTo };
  indexes.set(spans, index);
  return index;
}

/** [first, last): the only spans of the lane that can touch [from, to]. Two binary searches. */
export function visibleRange(index: LaneIndex, from: number, to: number): [number, number] {
  const n = index.spans.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.maxTo[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  lo = first;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.starts[mid]! <= to) lo = mid + 1;
    else hi = mid;
  }
  return [first, lo];
}

// ---------------------------------------------------------------- geometry in time

export interface SpanTimes {
  /** Where the drawing starts (the earliest bound when only bounded; the known end when the start is not known). */
  readonly from: number;
  /** Where it ends: the end (its latest bound), or the live edge while open. Never after `liveAt`. */
  readonly to: number;
  /** Not ended by the live edge. */
  readonly open: boolean;
  readonly startUnknown: boolean;
  readonly endUnknown: boolean;
  /** Open at the end of a history that is no longer live (noEndRecorded): drawn to that end, uncapped, with the ring-query; never live. */
  readonly noEnd?: boolean;
}

/** The span's drawable times at `liveAt`, or null when nothing of it is known by then. */
export function spanTimes(span: TimelineSpan, liveAt: number): SpanTimes | null {
  const s = span.start;
  const e = span.end;
  const startUnknown = s === null || (s.at === null && s.notBefore === null && s.notAfter === null);
  const endUnknown = e !== null && e.at === null && e.notBefore === null && e.notAfter === null;
  const endLatest = e ? (e.notAfter ?? e.at ?? e.notBefore) : null;
  const open = e === null || (endLatest !== null && endLatest > liveAt && !endUnknown);
  let from: number;
  if (startUnknown) {
    if (!e || endUnknown) return null;
    const anchor = e.at ?? e.notBefore;
    if (anchor === null || anchor > liveAt) return null;
    return { from: anchor, to: anchor, open: false, startUnknown, endUnknown };
  } else from = s!.notBefore ?? s!.at ?? (s!.notAfter as number);
  if (from > liveAt) return null;
  if (noEndRecorded(span, liveAt)) return { from, to: Math.max(from, Math.min(liveAt, span.attrs.historyEndsAt!)), open: false, startUnknown, endUnknown, noEnd: true };
  let to: number;
  if (endUnknown) to = from;
  else if (open) to = liveAt;
  else to = Math.min(liveAt, endLatest as number);
  return { from, to: Math.max(from, to), open, startUnknown, endUnknown };
}

// ---------------------------------------------------------------- the row plan

export interface PlacedSpan {
  readonly span: TimelineSpan;
  readonly times: SpanTimes;
  readonly x0: number;
  readonly x1: number;
  readonly lod: SpanLod;
}

export interface PlacedMark {
  readonly mark: TimelineMark;
  readonly x: number;
}

/** Spans too small to draw one by one: a tint bar whose opacity says how many. */
export interface DensityRun {
  readonly x0: number;
  readonly x1: number;
  readonly count: number;
  readonly from: number;
  readonly to: number;
}

/** Instants too dense to draw one by one, gathered per 24 px. */
export interface Pip {
  readonly x0: number;
  readonly x1: number;
  readonly count: number;
  readonly from: number;
  readonly to: number;
}

export interface RowPlan {
  /** Spans drawn one by one, in start order. */
  readonly items: readonly PlacedSpan[];
  /** Instant spans drawn one by one (empty when thinned to pips). */
  readonly instants: readonly PlacedSpan[];
  readonly marks: readonly PlacedMark[];
  readonly runs: readonly DensityRun[];
  readonly pips: readonly Pip[];
  /** Spans looked at after culling (for the benchmark). */
  readonly considered: number;
}

export const EMPTY_PLAN: RowPlan = { items: [], instants: [], marks: [], runs: [], pips: [], considered: 0 };

/** Density run opacity: one span reads faint, many read solid; logarithmic, capped. */
export function runAlpha(count: number): number {
  return Math.min(0.85, 0.22 + 0.16 * Math.log2(1 + count));
}

/**
 * Plan one row: cull, place, choose the level of detail, merge sub-pixel spans into runs and thin
 * dense instants into pips. `marks` are the row's instants that are not spans (verdicts, people).
 */
export function planRow(spans: readonly TimelineSpan[], marks: readonly TimelineMark[], scale: Scale, liveAt: number): RowPlan {
  if (spans.length === 0 && marks.length === 0) return EMPTY_PLAN;
  const index = laneIndex(spans);
  // Margin: caps, stubs and labels reach a little past a span's own time.
  const margin = (LOD.stubPx + 8) / scale.k;
  const qFrom = scale.from - margin;
  const qTo = Math.min(scale.to + margin, liveAt);
  const [first, last] = visibleRange(index, qFrom, qTo);
  const items: PlacedSpan[] = [];
  const instantSpans: PlacedSpan[] = [];
  const runs: { x0: number; x1: number; count: number; from: number; to: number }[] = [];
  let considered = 0;
  for (let i = first; i < last; i++) {
    const span = index.spans[i]!;
    considered++;
    const times = spanTimes(span, liveAt);
    if (!times) continue;
    if (times.to < qFrom || times.from > qTo) continue;
    const x0 = xAt(scale, times.from);
    const x1 = xAt(scale, times.to);
    if (isInstantSpan(span)) {
      instantSpans.push({ span, times, x0, x1, lod: "geometry" });
      continue;
    }
    const w = x1 - x0;
    const unknown = times.startUnknown || times.endUnknown;
    const lod = unknown ? "geometry" : lodOf(w);
    if (lod === "density") {
      const run = runs[runs.length - 1];
      if (run && x0 <= run.x1 + 1) {
        run.x1 = Math.max(run.x1, x1);
        run.count++;
        run.to = Math.max(run.to, times.to);
      } else runs.push({ x0, x1: Math.max(x1, x0 + 1), count: 1, from: times.from, to: times.to });
      continue;
    }
    items.push({ span, times, x0, x1, lod });
  }
  const placedMarks: PlacedMark[] = [];
  for (const mark of marks) {
    if (mark.at > liveAt) continue;
    const x = xAt(scale, mark.at);
    if (x < -8 || x > scale.width + 8) continue;
    placedMarks.push({ mark, x });
  }
  // "In view": the stretch of the row the instants occupy, so a burst is thinned even in a wide window.
  const instantCount = instantSpans.length + placedMarks.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of instantSpans) {
    lo = Math.min(lo, s.x0);
    hi = Math.max(hi, s.x0);
  }
  for (const m of placedMarks) {
    lo = Math.min(lo, m.x);
    hi = Math.max(hi, m.x);
  }
  const occupied = instantCount ? Math.min(scale.width, hi - lo) + LOD.instantPx : 1;
  if (instantCount * LOD.instantPx <= occupied) {
    return { items, instants: instantSpans, marks: placedMarks, runs, pips: [], considered };
  }
  // Too dense: gather every instant into 24 px pips.
  const buckets = new Map<number, { x0: number; x1: number; count: number; from: number; to: number }>();
  const add = (x: number, from: number, to: number) => {
    const b = Math.floor(x / LOD.pipPx);
    const p = buckets.get(b);
    if (p) {
      p.x0 = Math.min(p.x0, x);
      p.x1 = Math.max(p.x1, x);
      p.count++;
      p.from = Math.min(p.from, from);
      p.to = Math.max(p.to, to);
    } else buckets.set(b, { x0: x, x1: x, count: 1, from, to });
  };
  for (const s of instantSpans) add(s.x0, s.times.from, s.times.to);
  for (const m of placedMarks) add(m.x, m.mark.at, m.mark.at);
  const pips = [...buckets.values()].sort((a, b) => a.x0 - b.x0);
  return { items, instants: [], marks: [], runs, pips, considered };
}

// ---------------------------------------------------------------- hit-testing

export type RowHit =
  | { readonly kind: "span"; readonly span: TimelineSpan; readonly from: number; readonly to: number }
  | { readonly kind: "mark"; readonly mark: TimelineMark }
  | { readonly kind: "aggregate"; readonly count: number; readonly from: number; readonly to: number };

/** The extent a placed span answers the pointer over: its body, or its mark and stub when an end is not known. */
function reach(p: PlacedSpan): [number, number] {
  if (p.times.startUnknown) return [p.x0 - LOD.stubPx, p.x0 + 5];
  if (p.times.endUnknown) return [p.x0 - 5, p.x0 + LOD.stubPx];
  return [p.x0, Math.max(p.x1, p.x0 + 1)];
}

/**
 * What in the row is under `x`. Instants and marks first (nearest within 4 px), then the narrowest
 * span whose reach holds x (binary search by start, then a short scan back), then a pip, then a
 * density run. Aggregates report their count.
 */
export function hitRow(plan: RowPlan, x: number, slop = 3): RowHit | null {
  let best: { d: number; hit: RowHit } | null = null;
  for (const m of plan.marks) {
    const d = Math.abs(m.x - x);
    if (d <= 5 && (!best || d < best.d)) best = { d, hit: { kind: "mark", mark: m.mark } };
  }
  for (const s of plan.instants) {
    const d = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0;
    if (d <= 4 && (!best || d < best.d)) best = { d, hit: { kind: "span", span: s.span, from: s.times.from, to: s.times.to } };
  }
  if (best) return best.hit;

  const items = plan.items;
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.x0 - LOD.stubPx <= x + slop) lo = mid + 1;
    else hi = mid;
  }
  let chosen: PlacedSpan | null = null;
  for (let i = lo - 1, n = 0; i >= 0 && n < 12; i--, n++) {
    const p = items[i]!;
    const [a, b] = reach(p);
    if (x >= a - slop && x <= b + slop) {
      if (!chosen || b - a < reach(chosen)[1] - reach(chosen)[0]) chosen = p;
    }
  }
  if (chosen) return { kind: "span", span: chosen.span, from: chosen.times.from, to: chosen.times.to };

  for (const p of plan.pips) {
    const c = (p.x0 + p.x1) / 2;
    if (Math.abs(c - x) <= LOD.pipPx / 2) return { kind: "aggregate", count: p.count, from: p.from, to: p.to };
  }
  for (const r of plan.runs) {
    if (x >= r.x0 - 1 && x <= r.x1 + 1) return { kind: "aggregate", count: r.count, from: r.from, to: r.to };
  }
  return null;
}

// ---------------------------------------------------------------- collapsed summary

export interface SubtreeColumns {
  /** Per 2 px column: how many spans of the subtree cover it. */
  readonly counts: Uint16Array;
  /** Per column: 1 when a span covering it is known to have failed by the live edge. */
  readonly failed: Uint8Array;
  readonly bin: number;
  readonly total: number;
  /** The earliest failure recorded in view (a failed or refused end at or before the live edge), or null. */
  readonly firstFail: number | null;
}

function* descendants(node: TrackNode): Generator<TrackNode> {
  for (const c of node.children) {
    yield c;
    yield* descendants(c);
  }
}

/** A collapsed group's density strip: its whole subtree's spans, binned at 2 px. */
export function subtreeColumns(node: TrackNode, scale: Scale, liveAt: number, bin = 2): SubtreeColumns {
  const n = Math.max(1, Math.ceil(scale.width / bin));
  const counts = new Uint16Array(n);
  const failed = new Uint8Array(n);
  let total = 0;
  let firstFail: number | null = null;
  const qTo = Math.min(scale.to, liveAt);
  for (const d of descendants(node)) {
    for (const lane of d.lanes) {
      const index = laneIndex(lane.spans);
      const [first, last] = visibleRange(index, scale.from, qTo);
      for (let i = first; i < last; i++) {
        const span = index.spans[i]!;
        const t = spanTimes(span, liveAt);
        if (!t || t.to < scale.from) continue;
        const c0 = Math.max(0, Math.floor(xAt(scale, t.from) / bin));
        const c1 = Math.min(n - 1, Math.floor(xAt(scale, t.to) / bin));
        const bad = !t.open && span.end !== null && span.end.at !== null && span.end.at <= liveAt && (span.end.reason === "failed" || span.end.reason === "refused");
        total++;
        if (bad && span.end!.at! >= scale.from && (firstFail === null || span.end!.at! < firstFail)) firstFail = span.end!.at!;
        for (let c = c0; c <= c1; c++) {
          const v = counts[c] ?? 0;
          if (v < 65535) counts[c] = v + 1;
          if (bad) failed[c] = 1;
        }
      }
    }
  }
  return { counts, failed, bin, total, firstFail };
}

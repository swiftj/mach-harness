/**
 * The temporal overview's pure parts: time to pixels, the density columns and their log scale, the
 * activity steps, landmark aggregation per pixel column, the brush arithmetic (clamping, minimum
 * width, keyboard steps, wheel zoom) and the adaptive time ticks. No DOM, no React: tested in plain
 * node (test/timeline-overview.test.mjs).
 *
 * Scale: nothing here iterates events. Density and concurrency are bucketed series (one pass over the
 * buckets plus one over the columns); marks are aggregated per pixel column in one pass, O(n + width).
 */
import { MIN_WINDOW_MS, type ConcurrencyBucket, type ConcurrencySeries, type DensitySeries, type SpanKind, type TimelineMark, type TimeWindow } from "../contract";
import { duration } from "../../shell/time";

// ---------------------------------------------------------------- time and pixels

export function xOf(t: number, extent: TimeWindow, width: number): number {
  const span = Math.max(1, extent.to - extent.from);
  return ((t - extent.from) / span) * width;
}

export function tOf(x: number, extent: TimeWindow, width: number): number {
  const span = Math.max(1, extent.to - extent.from);
  return extent.from + (x / Math.max(1, width)) * span;
}

// ---------------------------------------------------------------- density

/** Height of a count on a log scale: 0 for nothing, at least 1 px for anything, `height` at the peak. */
export function logHeight(count: number, peak: number, height: number): number {
  if (count <= 0 || peak <= 0 || height <= 0) return 0;
  return Math.max(1, (Math.log1p(count) / Math.log1p(peak)) * height);
}

export interface DensityColumns {
  /** Per pixel column: the most events recorded in one bucket touching it. */
  readonly values: Float64Array;
  /** The largest bucket count in the series (not only in view). */
  readonly peak: number;
  readonly total: number;
}

/**
 * One value per 1 px column: the largest bucket count that touches the column. A column is never the
 * sum of buckets (that would change with the width); the peak is per bucket, labelled with its length.
 */
export function densityColumns(series: DensitySeries, extent: TimeWindow, width: number): DensityColumns {
  const w = Math.max(0, Math.floor(width));
  const values = new Float64Array(w);
  let peak = 0;
  let total = 0;
  for (const b of series.buckets) {
    if (b.count <= 0) continue;
    total += b.count;
    if (b.count > peak) peak = b.count;
    if (w === 0) continue;
    const x0 = Math.max(0, Math.floor(xOf(b.from, extent, w)));
    const x1 = Math.min(w - 1, Math.max(x0, Math.ceil(xOf(b.from + series.bucketMs, extent, w)) - 1));
    for (let x = x0; x <= x1; x++) if (b.count > values[x]!) values[x] = b.count;
  }
  return { values, peak, total };
}

// ---------------------------------------------------------------- activity

export interface Step {
  readonly x0: number;
  readonly x1: number;
  readonly value: number;
}

/**
 * The most spans of `kind` active per bucket, as runs of equal value in pixel space (stepped, never
 * smoothed). A bucket the series does not list counts as none active.
 */
export function concurrencySteps(series: ConcurrencySeries, kind: SpanKind, extent: TimeWindow, width: number): { steps: Step[]; peak: number } {
  const steps: Step[] = [];
  let peak = 0;
  const run: { cur: { x0: number; x1: number; value: number } | null } = { cur: null };
  const push = (x0: number, x1: number, value: number) => {
    if (x1 <= x0) return;
    const cur = run.cur;
    if (cur && cur.value === value && Math.abs(cur.x1 - x0) < 0.01) {
      cur.x1 = x1;
      return;
    }
    if (cur) steps.push(cur);
    run.cur = { x0, x1, value };
  };
  let prevEnd: number | null = null;
  for (const b of series.buckets) {
    const v = b.active[kind]?.max ?? 0;
    if (v > peak) peak = v;
    const x0 = xOf(b.from, extent, width);
    const x1 = xOf(b.from + series.bucketMs, extent, width);
    if (prevEnd !== null && x0 > prevEnd + 0.01) push(prevEnd, x0, 0);
    push(x0, x1, v);
    prevEnd = x1;
  }
  if (run.cur) steps.push(run.cur);
  return { steps, peak };
}

/** Whether a concurrency answer has nothing to draw because the observer does not serve it. */
export function concurrencyUnavailable(series: ConcurrencySeries | null): boolean {
  return series === null || (!series.complete && series.buckets.length === 0);
}

// ---------------------------------------------------------------- landmarks

/** What the overview draws for a mark, by family (shape first, colour second). */
export type MarkFamily = "failure" | "halt" | "gate" | "human" | "gap";

/** The mark kinds the overview asks for. Retries, verdicts, waves and merges are reachable by the jump menu, not drawn here. */
export const OVERVIEW_MARK_KINDS = ["failure", "recovery", "interruption", "human", "gate", "gap"] as const;

export function familyOf(mark: TimelineMark): MarkFamily | null {
  switch (mark.kind) {
    case "failure":
      return "failure";
    case "recovery":
    case "interruption":
      return "halt";
    case "gate":
      return mark.verdict === "refused" || mark.verdict === "overridden" ? "gate" : null;
    case "human":
      return "human";
    case "gap":
      return "gap";
    default:
      return null;
  }
}

/** One glyph: every instant of a family whose time falls in pixel column `x`. */
export interface MarkPoint {
  readonly x: number;
  readonly family: MarkFamily;
  readonly count: number;
  /** The earliest mark in the column (its label names the glyph). */
  readonly first: TimelineMark;
  /** For gates: any refusal in the column draws the glyph filled. */
  readonly refused: boolean;
}

/** One bar: intervals of a family that overlap once rounded to pixels (person waits, gaps). */
export interface MarkBar {
  readonly x0: number;
  readonly x1: number;
  readonly family: "human" | "gap";
  readonly count: number;
  readonly first: TimelineMark;
  /** A person wait still open at `liveAt` (no recorded end). */
  readonly open: boolean;
}

const FAMILIES: readonly MarkFamily[] = ["gap", "human", "halt", "gate", "failure"];

/**
 * Marks to glyphs, in one pass: instants to one glyph per family per pixel column with a count;
 * intervals (a person wait with an end, or still open; a gap) to bars, merged where they touch.
 * A person-required mark without `until` is an open wait: its bar runs to `liveAt`.
 */
export function aggregateMarks(marks: readonly TimelineMark[], extent: TimeWindow, width: number, liveAt: number): { points: MarkPoint[]; bars: MarkBar[] } {
  const w = Math.max(0, Math.floor(width));
  const nf = FAMILIES.length;
  const counts = new Int32Array(w * nf);
  const firsts: Array<TimelineMark | undefined> = new Array(w * nf);
  const refused = new Uint8Array(w);
  // Intervals, bucketed by their first column (a counting sort: O(n + width), no comparisons).
  // Family 0 is gap, 1 is human; `head[f * (w + 1) + col]` is the newest interval starting there.
  const n = marks.length;
  const ix0 = new Float64Array(n);
  const ix1 = new Float64Array(n);
  const iopen = new Uint8Array(n);
  const imark: TimelineMark[] = [];
  const next = new Int32Array(n);
  const head = new Int32Array(2 * (w + 1)).fill(-1);
  const span = Math.max(1, extent.to - extent.from);
  const scale = w / span;
  for (let k = 0; k < n; k++) {
    const m = marks[k]!;
    const family = familyOf(m);
    if (!family) continue;
    const openWait = family === "human" && m.until === null && m.verdict === "required";
    if ((family === "human" || family === "gap") && (m.until !== null || openWait)) {
      const end = m.until ?? Math.max(m.at, liveAt);
      const a = (m.at - extent.from) * scale;
      const b = (end - extent.from) * scale;
      if (b < 0 || a > w) continue;
      const j = imark.length;
      imark.push(m);
      ix0[j] = Math.max(0, a);
      ix1[j] = Math.min(w, Math.max(b, a));
      iopen[j] = openWait ? 1 : 0;
      const slot = (family === "gap" ? 0 : w + 1) + Math.min(w, Math.floor(ix0[j]!));
      next[j] = head[slot]!;
      head[slot] = j;
      continue;
    }
    const x = Math.floor((m.at - extent.from) * scale);
    if (x < 0 || x >= w) continue;
    const i = FAMILY_INDEX[family] * w + x;
    counts[i]!++;
    const prev = firsts[i];
    if (!prev || m.at < prev.at) firsts[i] = m;
    if (family === "gate" && m.verdict === "refused") refused[x] = 1;
  }
  const points: MarkPoint[] = [];
  for (let f = 0; f < nf; f++) {
    const family = FAMILIES[f]!;
    for (let x = 0; x < w; x++) {
      const c = counts[f * w + x]!;
      if (c > 0) points.push({ x, family, count: c, first: firsts[f * w + x]!, refused: family === "gate" && refused[x] === 1 });
    }
  }
  const bars: MarkBar[] = [];
  for (const [fi, family] of [
    [0, "gap"],
    [1, "human"],
  ] as const) {
    let cur: { x0: number; x1: number; family: "human" | "gap"; count: number; first: TimelineMark; open: boolean } | null = null;
    for (let col = 0; col <= w; col++) {
      // Within a column, earliest start first (the list is newest-first; columns are short).
      const here: number[] = [];
      for (let j = head[fi * (w + 1) + col]!; j !== -1; j = next[j]!) here.push(j);
      if (here.length > 1) here.sort((p, q) => ix0[p]! - ix0[q]!);
      for (const j of here) {
        if (cur && ix0[j]! <= cur.x1 + 1) {
          cur.x1 = Math.max(cur.x1, ix1[j]!);
          cur.count++;
          cur.open = cur.open || iopen[j] === 1;
          continue;
        }
        if (cur) bars.push(cur);
        cur = { x0: ix0[j]!, x1: ix1[j]!, family, count: 1, first: imark[j]!, open: iopen[j] === 1 };
      }
    }
    if (cur) bars.push(cur);
  }
  return { points, bars };
}

const FAMILY_INDEX: Record<MarkFamily, number> = { gap: 0, human: 1, halt: 2, gate: 3, failure: 4 };

// ---------------------------------------------------------------- the brush

/** The window clamped to the extent and never narrower than `minMs` (the whole extent when it is shorter). */
export function clampWindow(w: TimeWindow, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow {
  const extLen = extent.to - extent.from;
  if (extLen <= minMs) return { from: extent.from, to: extent.to };
  const len = Math.max(minMs, Math.min(extLen, w.to - w.from));
  const from = Math.min(Math.max(w.from, extent.from), extent.to - len);
  return { from, to: from + len };
}

/** Move without resizing; stops at either end of the extent. */
export function moveWindow(w: TimeWindow, deltaMs: number, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow {
  return clampWindow({ from: w.from + deltaMs, to: w.to + deltaMs }, extent, minMs);
}

/** Move one edge to `t`, keeping the other where it is and the window at least `minMs` wide. */
export function resizeWindow(w: TimeWindow, edge: "start" | "end", t: number, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow {
  const extLen = extent.to - extent.from;
  if (extLen <= minMs) return { from: extent.from, to: extent.to };
  const c = clampWindow(w, extent, minMs);
  if (edge === "start") {
    const from = Math.max(extent.from, Math.min(t, c.to - minMs));
    return { from, to: c.to };
  }
  const to = Math.min(extent.to, Math.max(t, c.from + minMs));
  return { from: c.from, to };
}

/** A window drawn from `a` to `b` (either order); too narrow a window grows about its middle. */
export function windowBetween(a: number, b: number, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow {
  let from = Math.min(a, b);
  let to = Math.max(a, b);
  if (to - from < minMs) {
    const mid = (from + to) / 2;
    from = mid - minMs / 2;
    to = mid + minMs / 2;
  }
  return clampWindow({ from, to }, extent, minMs);
}

/** Zoom by `factor` (above 1: wider, out) about `anchor`, which stays where it is on screen. */
export function zoomWindow(w: TimeWindow, anchor: number, factor: number, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow {
  const len = w.to - w.from;
  const extLen = extent.to - extent.from;
  const next = Math.max(Math.min(minMs, extLen), Math.min(extLen, len * factor));
  const ratio = len > 0 ? (anchor - w.from) / len : 0.5;
  const from = anchor - ratio * next;
  return clampWindow({ from, to: from + next }, extent, minMs);
}

/** A window centred on `t`, its length kept. */
export function centreWindow(w: TimeWindow, t: number, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow {
  const len = w.to - w.from;
  return clampWindow({ from: t - len / 2, to: t + len / 2 }, extent, minMs);
}

/** Whether the window shows (practically) everything: a drag inside it then draws a new window. */
export function isWhole(w: TimeWindow, extent: TimeWindow): boolean {
  const extLen = Math.max(1, extent.to - extent.from);
  return w.from <= extent.from + extLen * 0.001 && w.to >= extent.to - extLen * 0.001;
}

export type BrushPart = "start" | "end" | "move";

/**
 * The keyboard on the brush's three sliders. Arrows: 1% of the extent (Shift: 10%). Start and end:
 * PageUp and PageDown 10%, Home and End to the extent's ends (or as far as the minimum width lets).
 * Move: PageUp one window later, PageDown one window earlier (a slider's value goes up with PageUp),
 * Home and End to either end. Returns null for a key the slider does not handle.
 */
export function keyStep(part: BrushPart, key: string, shift: boolean, w: TimeWindow, extent: TimeWindow, minMs = MIN_WINDOW_MS): TimeWindow | null {
  const extLen = extent.to - extent.from;
  const step = extLen * (shift ? 0.1 : 0.01);
  const big = extLen * 0.1;
  const c = clampWindow(w, extent, minMs);
  const len = c.to - c.from;
  let delta: number | null = null;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      delta = -step;
      break;
    case "ArrowRight":
    case "ArrowUp":
      delta = step;
      break;
    case "PageUp":
      delta = part === "move" ? len : big;
      break;
    case "PageDown":
      delta = part === "move" ? -len : -big;
      break;
    case "Home":
      if (part === "move") return clampWindow({ from: extent.from, to: extent.from + len }, extent, minMs);
      return resizeWindow(c, part, part === "start" ? extent.from : c.from, extent, minMs);
    case "End":
      if (part === "move") return clampWindow({ from: extent.to - len, to: extent.to }, extent, minMs);
      return resizeWindow(c, part, part === "end" ? extent.to : c.to, extent, minMs);
    default:
      return null;
  }
  if (part === "move") return moveWindow(c, delta, extent, minMs);
  return resizeWindow(c, part, (part === "start" ? c.from : c.to) + delta, extent, minMs);
}

// ---------------------------------------------------------------- words

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A window's length in words, for screen readers: "2 hours 15 minutes", "45 seconds", "3 days 4 hours". */
export function windowWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return plural(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${plural(m, "minute")} ${plural(s % 60, "second")}` : plural(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${plural(h, "hour")} ${plural(m % 60, "minute")}` : plural(h, "hour");
  const d = Math.floor(h / 24);
  return h % 24 ? `${plural(d, "day")} ${plural(h % 24, "hour")}` : plural(d, "day");
}

/** A count with thousands separators, independent of the browser's locale: 12,408. */
export function countText(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A bucket's length in words: "a second", "30 s", "a minute", "5 min", "an hour", "2 h 30 min", "a day", "2 days". */
export function bucketWords(ms: number): string {
  if (!(ms > 0)) return "a bucket";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s === 1) return "a second";
  if (s < 60) return `${s} s`;
  if (s === 60) return "a minute";
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  if (s === 3600) return "an hour";
  const m = Math.round(s / 60);
  if (s < 86_400) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
  if (s === 86_400) return "a day";
  const h = Math.round(s / 3600);
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h / 24} days`;
}

/** The density legend's peak: the most events recorded in one bucket, "37 in a minute", "3,452 in 5 min". */
export function peakWords(count: number, bucketMs: number): string {
  return `${countText(count)} in ${bucketWords(bucketMs)}`;
}

// ---------------------------------------------------------------- recorded limits

/** The span kinds the activity band counts. */
export const PLOTTED_KINDS: readonly SpanKind[] = ["execution", "visit", "agent"];

export type RecordedLimit = ConcurrencySeries["limits"][number];

/** What a limit bounds, read defensively: the contract's limit has no such field; the data layer may add `appliesTo`. */
export function appliesToOf(limit: RecordedLimit): string | null | undefined {
  const l = limit as RecordedLimit & { appliesTo?: unknown; applies_to?: unknown };
  const v = l.appliesTo !== undefined ? l.appliesTo : l.applies_to;
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : null;
}

/**
 * Whether a recorded limit belongs on the activity band: only when it bounds something counted
 * there. A limit naming a kind applies when that kind is plotted; a limit naming none (null) never;
 * an older observer that says nothing (absent) only for `max_parallel`.
 */
export function limitBoundsPlot(limit: RecordedLimit, plotted: readonly SpanKind[] = PLOTTED_KINDS): boolean {
  const a = appliesToOf(limit);
  if (a === undefined) return limit.name === "max_parallel";
  return a !== null && (plotted as readonly string[]).includes(a);
}

export function limitName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

/** One interval of a limit at one level, in pixels. */
export interface LimitSegment {
  readonly name: string;
  readonly label: string;
  readonly value: number;
  /** The span kind it bounds (an older observer's `max_parallel`: executions). */
  readonly kind: SpanKind;
  readonly x0: number;
  readonly x1: number;
  /** The first interval of this limit drawn: the one that carries its name. */
  readonly first: boolean;
}

/**
 * The drawn intervals of the relevant limits, each at its own level. An interval still in force
 * (`to` null) runs to `openEnd` (the last recorded activity), never into an idle tail.
 */
export function limitSegments(limits: readonly RecordedLimit[], extent: TimeWindow, width: number, openEnd: number, plotted: readonly SpanKind[] = PLOTTED_KINDS): LimitSegment[] {
  const rel = limits.filter((l) => limitBoundsPlot(l, plotted)).slice().sort((a, b) => a.from - b.from);
  const seen = new Set<string>();
  const out: LimitSegment[] = [];
  for (const l of rel) {
    const x0 = Math.max(0, xOf(l.from, extent, width));
    const x1 = Math.min(width, xOf(l.to ?? Math.max(l.from, openEnd), extent, width));
    if (x1 <= x0) continue;
    const first = !seen.has(l.name);
    seen.add(l.name);
    out.push({ name: l.name, label: limitName(l.name), value: l.value, kind: (appliesToOf(l) ?? "execution") as SpanKind, x0, x1, first });
  }
  return out;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PlacedLabel {
  readonly text: string;
  /** Left of the text and its baseline. */
  readonly x: number;
  readonly y: number;
  readonly box: Box;
}

const LABEL_H = 11;
const hits = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Limit labels, placed once each at the left of the limit's first interval, above or else below its
 * line, shifted right past anything in the way; never over another label or a `blocked` box, never out
 * of [top, bottom] or the interval. A limit whose name cannot be placed is `dropped` (its line stays;
 * the caller says its value in the legend). A later level of the same limit gets its value alone,
 * where there is room.
 */
export function placeLimitLabels(
  segments: readonly LimitSegment[],
  yOf: (value: number) => number,
  measure: (text: string) => number,
  bounds: { readonly top: number; readonly bottom: number; readonly width: number },
  blocked: readonly Box[] = [],
): { placed: PlacedLabel[]; dropped: Array<{ name: string; label: string; kind: SpanKind; values: number[] }> } {
  const taken: Box[] = [...blocked];
  const placed: PlacedLabel[] = [];
  const dropped = new Map<string, { name: string; label: string; kind: SpanKind; values: number[] }>();
  const tryPlace = (text: string, s: LimitSegment): PlacedLabel | null => {
    const tw = measure(text);
    const y = yOf(s.value);
    for (const base of [y - 3, y + LABEL_H]) {
      const top = base - 9;
      if (top < bounds.top || base + 2 > bounds.bottom) continue;
      let x = s.x0 + 6;
      const right = Math.min(s.x1, bounds.width) - 3;
      for (let guard = 0; guard < 64 && x + tw <= right; guard++) {
        const box = { x: x - 3, y: top, w: tw + 6, h: LABEL_H };
        const hit = taken.find((b) => hits(box, b));
        if (!hit) return { text, x, y: base, box };
        x = hit.x + hit.w + 4;
      }
    }
    return null;
  };
  const named = new Set<string>();
  for (const s of segments) {
    if (s.first) {
      const p = tryPlace(`${s.label} ${s.value}`, s);
      if (p) {
        placed.push(p);
        taken.push(p.box);
        named.add(s.name);
      } else dropped.set(s.name, { name: s.name, label: s.label, kind: s.kind, values: [s.value] });
      continue;
    }
    const d = dropped.get(s.name);
    if (d) {
      if (d.values[d.values.length - 1] !== s.value) d.values.push(s.value);
      continue;
    }
    if (!named.has(s.name)) continue;
    const p = tryPlace(String(s.value), s);
    if (p) {
      placed.push(p);
      taken.push(p.box);
    }
  }
  return { placed, dropped: [...dropped.values()] };
}

/** Steps with the trailing run of zero removed: after the last span ended, nothing is drawn. */
export function trimTrailingZero(steps: readonly Step[]): Step[] {
  let n = steps.length;
  while (n > 0 && steps[n - 1]!.value === 0) n--;
  return steps.slice(0, n);
}

// ---------------------------------------------------------------- the idle tail

/**
 * When the last recorded event happened, as bounds: exact (`at === until`) from a mark, or within the
 * last density bucket that recorded anything. Null when nothing is recorded.
 */
export function lastRecorded(density: DensitySeries | null, marks: readonly TimelineMark[], liveAt: number): { at: number; until: number } | null {
  let dFrom = -Infinity;
  let dUntil = -Infinity;
  if (density) {
    for (let i = density.buckets.length - 1; i >= 0; i--) {
      const b = density.buckets[i]!;
      if (b.count > 0 && b.from <= liveAt) {
        dFrom = b.from;
        dUntil = Math.min(liveAt, b.from + density.bucketMs);
        break;
      }
    }
  }
  let mT = -Infinity;
  for (const m of marks) {
    if (m.at <= liveAt && m.at > mT) mT = m.at;
    if (m.until !== null && m.until <= liveAt && m.until > mT) mT = m.until;
  }
  if (dFrom === -Infinity && mT === -Infinity) return null;
  return { at: Math.max(dFrom, mT), until: Math.max(dUntil, mT) };
}

/** Fewer pixels than this between the last record and the live edge is no tail worth naming. */
export const MIN_TAIL_PX = 48;

/** The idle stretch from the last recorded event to the live edge, in pixels, or null when it is too short to name. */
export function idleTail(last: { at: number; until: number } | null, liveAt: number, extent: TimeWindow, width: number): { x: number; liveX: number; idleMs: number } | null {
  if (!last) return null;
  const x = xOf(last.until, extent, width);
  const liveX = Math.min(width, xOf(liveAt, extent, width));
  if (liveX - x < MIN_TAIL_PX) return null;
  return { x, liveX, idleMs: liveAt - last.until };
}

/** "last recorded 06:42:10" when exact; a range at the clock's resolution when only bounded. */
export function lastRecordedWords(last: { at: number; until: number }, clock: (t: number) => string): string {
  const a = clock(last.at);
  const b = clock(last.until);
  return a === b ? `last recorded ${a}` : `last recorded ${a}–${b}`;
}

// ---------------------------------------------------------------- person waits

/** Who a person mark waits for, by role, from its own sentence; "a person" when it names no role. */
export function roleOf(mark: TimelineMark): string {
  const s = mark.label.toLowerCase();
  for (const role of ["an engineer", "a product manager", "a reviewer"]) if (s.includes(role)) return role;
  return "a person";
}

/** A length in the shell's words ("7 h 1 min", "51 min"), without a "0 min" tail: "7 h". */
export function lengthWords(ms: number): string {
  return duration(ms).replace(/ 0 min$/, "");
}

/** "waiting for a person for 7 h 1 min" (open) or "waited 51 min for a person" (ended). */
export function waitWords(mark: TimelineMark, liveAt: number): string {
  const role = roleOf(mark);
  if (mark.until === null) return `waiting for ${role} for ${lengthWords(Math.max(0, liveAt - mark.at))}`;
  return `waited ${lengthWords(Math.max(0, mark.until - mark.at))} for ${role}`;
}

// ---------------------------------------------------------------- what a column and a window hold

const KIND_WORDS: Partial<Record<SpanKind, [string, string]>> = {
  execution: ["execution running", "executions running"],
  visit: ["cell in a station", "cells in a station"],
  agent: ["agent", "agents"],
};

const FAMILY_NOUNS: Record<MarkFamily, [string, string]> = {
  failure: ["failure", "failures"],
  halt: ["recovery or interruption", "recoveries and interruptions"],
  gate: ["gate refusal or override", "gate refusals and overrides"],
  human: ["person needed", "people needed"],
  gap: ["gap in history", "gaps in history"],
};

const FAMILY_ORDER: readonly MarkFamily[] = ["failure", "halt", "gate", "human", "gap"];

/** Counts by family as one phrase, most serious first: "3 failures, 1 gate refusal or override". */
export function familyCounts(by: ReadonlyMap<MarkFamily, number>): string {
  return FAMILY_ORDER.filter((f) => (by.get(f) ?? 0) > 0)
    .map((f) => familyCount(f, by.get(f)!))
    .join(", ");
}

export function familyCount(family: MarkFamily, n: number): string {
  return `${countText(n)} ${FAMILY_NOUNS[family][n === 1 ? 0 : 1]}`;
}

function activeWords(active: ConcurrencyBucket["active"] | Partial<Record<SpanKind, number>>): string | null {
  const parts: string[] = [];
  for (const [kind, v] of Object.entries(active) as Array<[SpanKind, { max: number } | number | undefined]>) {
    const n = typeof v === "number" ? v : (v?.max ?? 0);
    if (!n) continue;
    const words = KIND_WORDS[kind];
    parts.push(words ? `${n} ${words[n === 1 ? 0 : 1]}` : `${n} ${kind}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/** The bucket of a sorted series containing `t`, by binary search, or null. */
function bucketAt<B extends { readonly from: number }>(buckets: readonly B[], bucketMs: number, t: number): B | null {
  let lo = 0;
  let hi = buckets.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid]!.from <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const b = buckets[found]!;
  return t < b.from + bucketMs ? b : null;
}

export interface ColumnInput {
  readonly x: number;
  readonly extent: TimeWindow;
  readonly width: number;
  readonly liveAt: number;
  readonly density: DensitySeries | null;
  readonly concurrency: ConcurrencySeries | null;
  readonly points: readonly MarkPoint[];
  readonly bars: readonly MarkBar[];
  readonly clock: (t: number) => string;
}

/**
 * What the pointer's column holds, as lines: the time, the events recorded in that bucket, the spans
 * active by kind, and the landmarks there (one sentence for one, counts by family for many).
 */
export function describeColumn(i: ColumnInput): { title: string; lines: string[] } {
  const t = tOf(i.x, i.extent, i.width);
  const lines: string[] = [];
  if (t > i.liveAt) return { title: i.clock(t), lines: ["Not yet recorded: after the live edge"] };
  const d = i.density;
  if (d) {
    const b = bucketAt(d.buckets, d.bucketMs, t);
    const noun = bucketWords(d.bucketMs).replace(/^an? /, "");
    lines.push(b ? `${countText(b.count)} event${b.count === 1 ? "" : "s"} recorded in the ${noun} from ${i.clock(b.from)}` : `No events recorded in this ${noun}`);
  } else lines.push("Events recorded: not read");
  const c = i.concurrency;
  if (c && c.buckets.length) {
    const b = bucketAt(c.buckets, c.bucketMs, t);
    const w = b ? activeWords(b.active) : null;
    lines.push(w ? `Most at once: ${w}` : "No recorded spans active");
  }
  const near = i.points.filter((p) => Math.abs(p.x + 0.5 - i.x) <= 3);
  const over = i.bars.filter((b) => i.x >= b.x0 - 2 && i.x <= Math.max(b.x0 + 2, b.x1) + 2);
  const total = near.reduce((n, p) => n + p.count, 0) + over.length;
  if (total === 1) {
    const one = near[0]?.first ?? over[0]!.first;
    lines.push(one.kind === "human" && over.length ? `${one.label}: ${waitWords(one, i.liveAt)}` : one.label);
  } else if (total > 1) {
    const by = new Map<MarkFamily, number>();
    for (const p of near) by.set(p.family, (by.get(p.family) ?? 0) + p.count);
    for (const b of over) by.set(b.family, (by.get(b.family) ?? 0) + b.count);
    lines.push(familyCounts(by));
    for (const b of over) if (b.family === "human") lines.push(`${b.first.label}: ${waitWords(b.first, i.liveAt)}${b.count > 1 ? ` (and ${b.count - 1} more)` : ""}`);
  }
  return { title: i.clock(t), lines };
}

/**
 * A window's totals in one sentence, for the keyboard: events recorded in the buckets it touches,
 * the most spans at once by kind, and its landmarks by family.
 */
export function describeWindow(win: TimeWindow, density: DensitySeries | null, concurrency: ConcurrencySeries | null, marks: readonly TimelineMark[]): string {
  const parts: string[] = [];
  if (density) {
    let n = 0;
    for (const b of density.buckets) if (b.from < win.to && b.from + density.bucketMs > win.from) n += b.count;
    parts.push(`${countText(n)} events recorded`);
  } else parts.push("events not yet read");
  if (concurrency && concurrency.buckets.length) {
    const most: Partial<Record<SpanKind, number>> = {};
    for (const b of concurrency.buckets) {
      if (b.from >= win.to || b.from + concurrency.bucketMs <= win.from) continue;
      for (const k of PLOTTED_KINDS) {
        const v = b.active[k]?.max ?? 0;
        if (v > (most[k] ?? 0)) most[k] = v;
      }
    }
    const w = activeWords(most);
    parts.push(w ? `at most ${w} at once` : "no recorded spans active");
  }
  const by = new Map<MarkFamily, number>();
  for (const m of marks) {
    const f = familyOf(m);
    if (!f || m.at > win.to || (m.until ?? m.at) < win.from) continue;
    by.set(f, (by.get(f) ?? 0) + 1);
  }
  parts.push(by.size ? familyCounts(by) : "no failures, waits or gaps");
  return `In this window: ${parts.join("; ")}.`;
}

// ---------------------------------------------------------------- ticks

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Tick steps, smallest first: every one divides a UTC day (or is whole days). */
export const TICK_STEPS = [SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY] as const;

export interface Tick {
  readonly t: number;
  readonly x: number;
  readonly label: string;
  /** A UTC midnight (or the first tick, which carries the date). */
  readonly major: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function wallLabel(t: number, step: number, withDate: boolean): string {
  const d = new Date(t);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (step >= DAY) return date;
  const time = step < MINUTE ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  if (withDate) return `${date} ${time}`;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) return date;
  return time;
}

function scenarioLabel(t: number, step: number): string {
  const s = Math.max(0, Math.round(t / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return step < MINUTE ? `${h}:${pad2(m)}:${pad2(sec)}` : `${h}:${pad2(m)}`;
  return `${pad2(m)}:${pad2(sec)}`;
}

/**
 * Adaptive ticks for the whole extent: the smallest step whose labels are at least `minSpacing` px
 * apart, aligned to UTC (wall) or to the scenario's start. Wall time: the first tick carries the date
 * and a UTC midnight is labelled by its date.
 */
export function chooseTicks(extent: TimeWindow, width: number, wall: boolean, minSpacing = 84): { step: number; ticks: Tick[] } {
  const span = extent.to - extent.from;
  if (span <= 0 || width <= 0) return { step: 0, ticks: [] };
  const step = TICK_STEPS.find((s) => (s / span) * width >= minSpacing) ?? Math.ceil(span / DAY / Math.max(1, width / minSpacing)) * DAY;
  const ticks: Tick[] = [];
  let t = Math.ceil(extent.from / step) * step;
  for (; t <= extent.to; t += step) {
    const x = xOf(t, extent, width);
    const first = ticks.length === 0;
    const midnight = wall && t % DAY === 0;
    ticks.push({ t, x, label: wall ? wallLabel(t, step, first && step < DAY && !midnight) : scenarioLabel(t, step), major: wall && (midnight || first) });
  }
  return { step, ticks };
}

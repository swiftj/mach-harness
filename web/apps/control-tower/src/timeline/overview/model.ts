/**
 * The temporal overview's pure parts: time to pixels, the density columns and their log scale, the
 * activity steps, landmark aggregation per pixel column, the brush arithmetic (clamping, minimum
 * width, keyboard steps, wheel zoom) and the adaptive time ticks. No DOM, no React: tested in plain
 * node (test/timeline-overview.test.mjs).
 *
 * Scale: nothing here iterates events. Density and concurrency are bucketed series (one pass over the
 * buckets plus one over the columns); marks are aggregated per pixel column in one pass, O(n + width).
 */
import { MIN_WINDOW_MS, type ConcurrencySeries, type DensitySeries, type SpanKind, type TimelineMark, type TimeWindow } from "../contract";

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
  const intervals: Array<{ x0: number; x1: number; family: "human" | "gap"; mark: TimelineMark; open: boolean }> = [];
  for (const m of marks) {
    const family = familyOf(m);
    if (!family) continue;
    const openWait = family === "human" && m.until === null && m.verdict === "required";
    if ((family === "human" || family === "gap") && (m.until !== null || openWait)) {
      const end = m.until ?? Math.max(m.at, liveAt);
      const a = xOf(m.at, extent, w);
      const b = xOf(end, extent, w);
      if (b < 0 || a > w) continue;
      intervals.push({ x0: Math.max(0, a), x1: Math.min(w, Math.max(b, a)), family, mark: m, open: openWait });
      continue;
    }
    const x = Math.floor(xOf(m.at, extent, w));
    if (x < 0 || x >= w) continue;
    const i = FAMILIES.indexOf(family) * w + x;
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
  intervals.sort((p, q) => (p.family === q.family ? p.x0 - q.x0 : p.family < q.family ? -1 : 1));
  const bars: MarkBar[] = [];
  let cur: { x0: number; x1: number; family: "human" | "gap"; count: number; first: TimelineMark; open: boolean } | null = null;
  for (const it of intervals) {
    if (cur && cur.family === it.family && it.x0 <= cur.x1 + 1) {
      cur.x1 = Math.max(cur.x1, it.x1);
      cur.count++;
      cur.open = cur.open || it.open;
      continue;
    }
    if (cur) bars.push(cur);
    cur = { x0: it.x0, x1: it.x1, family: it.family, count: 1, first: it.mark, open: it.open };
  }
  if (cur) bars.push(cur);
  return { points, bars };
}

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

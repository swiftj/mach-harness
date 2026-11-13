/**
 * Time to pixels and back, the window's pan and zoom, and the ruler's adaptive ticks. Pure.
 *
 * Ticks run from 100 ms to one day. The major step is the smallest whose ticks stand at least 72 px
 * apart; each major step has a fixed minor subdivision, so the ruler reads like a drafting scale.
 * Every step divides a day exactly, so UTC midnight is always a major tick and a date change is
 * always marked on one.
 */
import { MIN_WINDOW_MS, type TimeWindow } from "../contract";

export interface Scale {
  readonly from: number;
  readonly to: number;
  readonly width: number;
  /** CSS px per ms. */
  readonly k: number;
}

export function scaleOf(window: TimeWindow, width: number): Scale {
  const span = Math.max(1, window.to - window.from);
  return { from: window.from, to: window.to, width, k: Math.max(1, width) / span };
}

export const xAt = (s: Scale, t: number): number => (t - s.from) * s.k;
export const tAt = (s: Scale, x: number): number => s.from + x / s.k;

/** Never narrower than MIN_WINDOW_MS: a narrower window grows about its centre. */
export function clampWindow(w: TimeWindow, minMs: number = MIN_WINDOW_MS): TimeWindow {
  const span = w.to - w.from;
  if (span >= minMs) return w;
  const mid = (w.from + w.to) / 2;
  return { from: mid - minMs / 2, to: mid + minMs / 2 };
}

/** Zoom by `factor` (under 1 zooms in) keeping time `anchor` under the same pixel. */
export function zoomAbout(w: TimeWindow, factor: number, anchor: number): TimeWindow {
  const span = w.to - w.from;
  const next = Math.max(MIN_WINDOW_MS, span * factor);
  const ratio = span > 0 ? (anchor - w.from) / span : 0.5;
  const from = anchor - next * ratio;
  return { from, to: from + next };
}

export function panBy(w: TimeWindow, ms: number): TimeWindow {
  return { from: w.from + ms, to: w.to + ms };
}

/** The window that frames [from, to] with a margin on each side, never under MIN_WINDOW_MS. */
export function frameWindow(from: number, to: number, margin = 0.08): TimeWindow {
  const span = Math.max(0, to - from);
  const pad = Math.max(span * margin, 500);
  return clampWindow({ from: from - pad, to: to + pad });
}

// ---------------------------------------------------------------- ticks

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** [major, minor] pairs, finest first. Each minor divides its major; each major divides a day. */
export const TICK_STEPS: ReadonlyArray<readonly [number, number]> = [
  [100, 20],
  [200, 50],
  [500, 100],
  [SECOND, 200],
  [2 * SECOND, 500],
  [5 * SECOND, SECOND],
  [10 * SECOND, 2 * SECOND],
  [15 * SECOND, 5 * SECOND],
  [30 * SECOND, 5 * SECOND],
  [MINUTE, 10 * SECOND],
  [2 * MINUTE, 30 * SECOND],
  [5 * MINUTE, MINUTE],
  [10 * MINUTE, 2 * MINUTE],
  [15 * MINUTE, 5 * MINUTE],
  [30 * MINUTE, 5 * MINUTE],
  [HOUR, 10 * MINUTE],
  [2 * HOUR, 30 * MINUTE],
  [3 * HOUR, HOUR],
  [6 * HOUR, HOUR],
  [12 * HOUR, 3 * HOUR],
  [DAY, 6 * HOUR],
];

export const MAJOR_MIN_PX = 72;

/** The major and minor step for a window `spanMs` wide drawn across `width` px. */
export function tickStep(spanMs: number, width: number, minPx: number = MAJOR_MIN_PX): { major: number; minor: number } {
  const k = Math.max(1, width) / Math.max(1, spanMs);
  for (const [major, minor] of TICK_STEPS) if (major * k >= minPx) return { major, minor };
  return { major: DAY, minor: 6 * HOUR };
}

export interface Ticks {
  readonly major: number;
  readonly minor: number;
  readonly majors: readonly number[];
  readonly minors: readonly number[];
}

/** Major and minor tick times within the window (minors exclude the majors). */
export function ticksFor(window: TimeWindow, width: number): Ticks {
  const { major, minor } = tickStep(window.to - window.from, width);
  const majors: number[] = [];
  const minors: number[] = [];
  const first = Math.ceil(window.from / minor) * minor;
  // A guard against a pathological width: never more than a few thousand ticks.
  const limit = 4000;
  for (let t = first, n = 0; t <= window.to && n < limit; t += minor, n++) {
    const r = Math.round(t / minor) * minor;
    if (r % major === 0) majors.push(r);
    else minors.push(r);
  }
  return { major, minor, majors, minors };
}

/** Whether times are Unix ms (wall clock) or the simulation's ms from its start. */
export function isWallTime(t: number): boolean {
  return t > DAY;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov": the UTC day of a Unix ms time. */
export function dayLabel(t: number): string {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * A tick's label, its format following the step: HH:MM:SS.s under a second, HH:MM:SS under a minute,
 * HH:MM under a day, DD Mon from a day. UTC for wall time. Simulation time (ms from the start) reads
 * as elapsed time: mm:ss.s, mm:ss, h:mm.
 */
export function tickLabel(t: number, step: number, wall: boolean = isWallTime(t)): string {
  if (wall) {
    if (step >= DAY) return dayLabel(t);
    const d = new Date(t);
    const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    if (step >= MINUTE) return hm;
    const hms = `${hm}:${pad2(d.getUTCSeconds())}`;
    if (step >= SECOND) return hms;
    return `${hms}.${Math.floor(d.getUTCMilliseconds() / 100)}`;
  }
  const v = Math.max(0, t);
  const h = Math.floor(v / HOUR);
  const m = Math.floor((v % HOUR) / MINUTE);
  const s = Math.floor((v % MINUTE) / SECOND);
  const tenths = Math.floor((v % SECOND) / 100);
  if (step >= DAY) return `day ${Math.floor(v / DAY) + 1}`;
  if (step >= MINUTE) return h ? `${h}:${pad2(m)}:00` : `${pad2(m)}:00`;
  const base = h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  return step >= SECOND ? base : `${base}.${tenths}`;
}

/** UTC midnights inside the window (wall time only): where the date changes. */
export function dateChanges(window: TimeWindow): number[] {
  if (!isWallTime(window.from)) return [];
  const out: number[] = [];
  for (let t = Math.ceil(window.from / DAY) * DAY; t <= window.to && out.length < 400; t += DAY) out.push(t);
  return out;
}

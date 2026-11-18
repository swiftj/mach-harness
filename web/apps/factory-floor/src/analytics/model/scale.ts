/**
 * Time axis ticks and labels for Analytics' charts: the step for a span drawn across a width, the
 * tick times, and their labels (UTC for wall time; elapsed time for the simulation's scenario ms).
 */

/** An interval of source time, `from < to`. */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

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

/**
 * Time in words for the shell: the time base (scenario or wall clock), time codes, dates and durations.
 * No grammar import, so the words are tested in plain node (test/m62-recheck-fixes.test.mjs).
 */
/**
 * What a time `t` means, set once by the app when it chooses its source (App.tsx):
 * - `scenario`: the simulation's ms from the scenario start, printed as a time code (mm:ss.s);
 * - `wall`: real history's `order_ms` (Unix ms), printed as a moment with its date, in the person's
 *   locale and time zone ("Today 14:53:26"; see `wallMoment`).
 * Only one source is shown at a time, so one module-wide base is enough and every caller of
 * `timecode` prints the right kind of time without being told.
 */
import { momentWords, spanWords, type MomentWords, type Precision } from "@mach/ui/datetime";

export type TimeBase = "scenario" | "wall";
let timeBase: TimeBase = "scenario";
export function setTimeBase(base: TimeBase): void {
  timeBase = base;
}
export function getTimeBase(): TimeBase {
  return timeBase;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Wall-clock UTC of a Unix ms time: HH:MM:SS (with tenths: HH:MM:SS.s). */
export function utcClock(t: number, tenths = false): string {
  const d = new Date(Math.max(0, t));
  const base = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return tenths ? `${base}.${Math.floor(d.getUTCMilliseconds() / 100)}` : base;
}

/** The UTC date of a Unix ms time, in words: 12 Nov 2026. */
export function utcDate(t: number): string {
  const d = new Date(Math.max(0, t));
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * A real-history moment in words, with its date, in the person's locale and time zone (the shared
 * formatter, @mach/ui/datetime): "Today 14:53", "Yesterday 20:02:23", "24 Nov 20:02", with the full
 * moment and zone in `exact` and its age when older (`age`, "3 d ago").
 */
export function wallMoment(t: number, precision: Precision = "minute", now?: number): MomentWords {
  return momentWords(t, { precision, ...(now !== undefined ? { now } : {}) });
}

/**
 * Factory time as mm:ss.s from the scenario start (the spec's time code); for real history, the moment
 * with its date ("Today 14:53:26" to the second; "Today 14:53" when `tenths` is false).
 */
export function timecode(t: number, tenths = true): string {
  if (timeBase === "wall") return wallMoment(t, tenths ? "second" : "minute").text;
  return scenarioCode(t, tenths);
}

/** As `timecode`, worded for inside a sentence: "since today 14:53". */
export function timecodeInline(t: number, tenths = false): string {
  if (timeBase === "wall") return wallMoment(t, tenths ? "second" : "minute").inline;
  return scenarioCode(t, tenths);
}

/**
 * A span of two moments: real history to the second, the second one without its day when it is the
 * same day ("Today 14:53:26 to 14:55:02"); the Simulation's two time codes. `toPrefix` goes before the
 * second ("at most ").
 */
export function spanCode(from: number, to: number, toPrefix = ""): string {
  if (timeBase !== "wall") return `${scenarioCode(from, false)} to ${toPrefix}${scenarioCode(to, false)}`;
  const words = spanWords(from, to, { precision: "second" });
  const head = `${wallMoment(from, "second").text} to `;
  return `${head}${toPrefix}${words.slice(head.length)}`;
}

function scenarioCode(t: number, tenths: boolean): string {
  const total = Math.max(0, t) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/**
 * A duration in plain words, the one vocabulary of the Factory Floor (the Line, the Floor and
 * Analytics; the observer's insight wording matches it): 48 s, 4 min 12 s, 1 h 3 min, 1 h, 1 d 15 h,
 * 2 d. Two units at most, the smaller left out when it is zero.
 */
export function duration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Whether a real-history time is a moment at all (Unix ms below a day is none: nothing is known yet, never 1970). */
export function isMoment(t: number | null | undefined): t is number {
  return typeof t === "number" && t > 86_400_000;
}

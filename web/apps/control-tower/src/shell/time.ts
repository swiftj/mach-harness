/**
 * Time in words for the shell: the time base (scenario or wall clock), time codes, dates, durations,
 * and what the transport's time code says (with an empty state for a history with nothing in it).
 * No grammar import, so the words are tested in plain node (test/m62-recheck-fixes.test.mjs).
 */
import { isoAt } from "../sim/scenario/recorder";

/**
 * What a time `t` means, set once by the app when it chooses its source (App.tsx):
 * - `scenario`: the simulation's ms from the scenario start, printed as a time code (mm:ss.s);
 * - `wall`: real history's `order_ms` (Unix ms), printed as wall-clock UTC (HH:MM:SS).
 * Only one source is shown at a time, so one module-wide base is enough and every caller of
 * `timecode` prints the right kind of time without being told.
 */
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

/** Factory time as mm:ss.s from the scenario start (the spec's time code); for real history, wall-clock UTC. */
export function timecode(t: number, tenths = true): string {
  if (timeBase === "wall") return utcClock(t, tenths);
  const total = Math.max(0, t) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** The wall clock at time t (UTC, HH:MM:SS): simulated for the simulation, real for real history. */
export function clockAt(t: number): string {
  if (timeBase === "wall") return utcClock(t);
  return isoAt(Math.max(0, Math.floor(t / 1000) * 1000)).slice(11, 19);
}

/** A duration in plain words: 48 s, 4 min 12 s, 1 h 3 min. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Spoken form of a time code, for screen readers. */
export function spokenTime(t: number): string {
  if (timeBase === "wall") {
    const d = new Date(Math.max(0, t));
    return `${d.getUTCHours()} ${pad2(d.getUTCMinutes())} and ${d.getUTCSeconds()} seconds UTC`;
  }
  const total = Math.floor(Math.max(0, t) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"}`;
}

/**
 * The transport's time code and the line under it (R7). Real history: wall-clock UTC and the date,
 * or, before anything is known (no moment yet: an empty project before its first event, with no
 * wall clock), an empty state, never 1 January 1970. The simulation: scenario time and its clock.
 */
export function timeCodeText(s: { readonly playhead: number; readonly liveAt: number; readonly source: "simulation" | "live" | "replay" }, size: "md" | "lg" = "md"): { readonly code: string; readonly clock: string } {
  const wall = timeBase === "wall" || s.source !== "simulation";
  if (!wall) return { code: timecode(s.playhead), clock: `${clockAt(s.playhead)} UTC` };
  if (!isMoment(s.playhead)) return { code: "--:--:--", clock: s.source === "replay" ? "No events in this history" : "No events yet" };
  return { code: `${utcClock(s.playhead, true)}${size === "lg" ? " UTC" : ""}`, clock: `UTC, ${utcDate(s.playhead)}` };
}

/** Whether a real-history time is a moment at all (Unix ms below a day is none: nothing is known yet, never 1970). */
export function isMoment(t: number | null | undefined): t is number {
  return typeof t === "number" && t > 86_400_000;
}

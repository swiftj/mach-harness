/**
 * Moments in words, for both apps: one formatter for every time a screen shows of something that
 * happened. Pure (no React, no window), so each app's tests import it directly (`@mach/ui/datetime`).
 *
 * In the person's own locale and time zone. A moment of today reads "Today 14:53", of yesterday
 * "Yesterday 20:02", of an earlier day "24 Nov 20:02", and of another year "24 Nov 2025, 20:02". The
 * full date, time and time zone ("Tuesday 24 November 2026, 20:02:23 CET") go in the title and the
 * accessible name, and the machine-readable moment in a <time datetime>. A moment from before
 * yesterday also says how old it is ("3 d ago"), so an old record is never mistaken for a new one.
 *
 * Durations and playback clocks (m:ss) are not moments and are not formatted here.
 */

/** How finely a moment is shown: to the minute (most screens), the second (an event record), or the tenth. */
export type Precision = "minute" | "second" | "tenth";

export interface MomentOptions {
  /** The clock "today" is read against (ms); the wall clock by default. */
  readonly now?: number;
  readonly precision?: Precision;
  /** Tests fix these; screens leave them to the person's browser. */
  readonly locale?: string;
  readonly timeZone?: string;
}

export interface MomentWords {
  /** Standalone: "Today 14:53", "Yesterday 20:02", "24 Nov 20:02", "24 Nov 2025, 20:02". */
  readonly text: string;
  /** Inside a sentence: "today 14:53", "yesterday 20:02", "24 Nov 20:02". */
  readonly inline: string;
  /** The time alone, at the precision asked: "14:53", "14:53:26". */
  readonly clock: string;
  /** The full moment with its time zone: "Tuesday 24 November 2026, 20:02:23 CET". */
  readonly exact: string;
  /** The machine-readable moment for <time datetime>. */
  readonly iso: string;
  /** How old it is when it is from before yesterday ("3 d ago"); null for today and yesterday. */
  readonly age: string | null;
  /** today, yesterday, or earlier (a later day reads as its date, and is "earlier" too). */
  readonly day: "today" | "yesterday" | "earlier";
}

const DAY_MS = 86_400_000;

function toMs(t: number | string | Date): number {
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/** The calendar day (y, m, d) of a moment in a time zone. */
function dayParts(ms: number, timeZone: string | undefined): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Whole calendar days from `a`'s day to `b`'s day in the time zone. */
function daysBetween(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

function clockOf(ms: number, precision: Precision, locale: string | undefined, timeZone: string | undefined): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone, hour: "2-digit", minute: "2-digit" };
  if (precision !== "minute") opts.second = "2-digit";
  if (precision === "tenth") opts.fractionalSecondDigits = 1;
  return new Intl.DateTimeFormat(locale, opts).format(new Date(ms));
}

/** "12 s ago", "3 min ago", "2 h ago", "3 d ago": one unit, the largest that fits; "just now" under a second. */
export function ageWords(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** A moment in words (see the file's comment). An unreadable moment reads as itself, with no age. */
export function momentWords(t: number | string | Date, options: MomentOptions = {}): MomentWords {
  const { precision = "minute", locale, timeZone } = options;
  const ms = toMs(t);
  if (!Number.isFinite(ms)) {
    const raw = String(t);
    return { text: raw, inline: raw, clock: raw, exact: raw, iso: raw, age: null, day: "earlier" };
  }
  const now = options.now ?? Date.now();
  const date = new Date(ms);
  const clock = clockOf(ms, precision, locale, timeZone);
  const here = dayParts(ms, timeZone);
  const today = dayParts(now, timeZone);
  const back = daysBetween(here, today);
  const day = back === 0 ? "today" : back === 1 ? "yesterday" : "earlier";
  const sameYear = here.y === today.y;
  const dateWords = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
  const dated = sameYear ? `${dateWords} ${clock}` : `${dateWords}, ${clock}`;
  const text = day === "today" ? `Today ${clock}` : day === "yesterday" ? `Yesterday ${clock}` : dated;
  const inline = day === "today" ? `today ${clock}` : day === "yesterday" ? `yesterday ${clock}` : dated;
  const exactOpts: Intl.DateTimeFormatOptions = { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" };
  if (precision === "tenth") exactOpts.fractionalSecondDigits = 1;
  const exact = new Intl.DateTimeFormat(locale, exactOpts).format(date);
  const age = back >= 2 && now > ms ? ageWords(now - ms) : null;
  return { text, inline, clock, exact, iso: date.toISOString(), age, day };
}

/**
 * Two moments as a span, the second without its day when it is the same day: "Today 14:53:26 to
 * 14:55:02", "Yesterday 23:58 to today 00:04".
 */
export function spanWords(from: number, to: number, options: MomentOptions = {}): string {
  const a = momentWords(from, options);
  const b = momentWords(to, options);
  const { timeZone } = options;
  const sameDay = daysBetween(dayParts(from, timeZone), dayParts(to, timeZone)) === 0;
  return `${a.text} to ${sameDay ? b.clock : b.inline}`;
}

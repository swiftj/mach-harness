/**
 * How fresh the page is (the top bar's freshness, beside the connection badge), and the tickets on
 * this computer the page does not show. Pure: words and thresholds, tested in plain node
 * (test/floor-freshness.test.mjs).
 *
 * Freshness is the age of the newest record the page has received (its own time, not when it
 * arrived), in words that follow the clock: "last record 12 s ago", "last record 3 min ago". While a
 * ticket is at work the Factory records something every few seconds to minutes: a station entering
 * or leaving, each build task, each verification check, each review verdict. The longest normal
 * silence is one build task or one check, which is minutes; ten minutes with nothing while a ticket
 * is at work is longer than any of them, so the words turn to the warning tone then. That is a fact
 * to look at, never a verdict: the page does not say anything stopped. With no ticket at work there
 * is nothing to expect, so it says so ("no ticket at work") and never warns.
 */
import type { CellState, Scene } from "../sim";
import { finishedAt } from "../sim";
import { utcClock } from "./time";

/** Past this age of the newest record, while a ticket is at work, the freshness turns to the warning tone. */
export const STALE_RECORD_MS = 10 * 60_000;

/** An age in one unit, the largest that fits: "12 s", "3 min", "2 h", "4 d"; under a second, null ("just now"). */
export function ageWords(ms: number): string | null {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 1) return null;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** "12 s ago", "3 min ago", or "just now". */
export function agoWords(ms: number): string {
  const age = ageWords(ms);
  return age === null ? "just now" : `${age} ago`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The exact moment, as the style guide's exact format, in UTC as real history is: "Tuesday 24 November 2026, 14:00:05 UTC". */
export function exactUtc(t: number): string {
  const d = new Date(Math.max(0, t));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${utcClock(t)} UTC`;
}

/**
 * Whether a ticket is at work: it is in the line (cleanup has not closed it) and a station visit is
 * open that is not a person's approval. A ticket waiting for a person, held for a place or between
 * steps records nothing until it moves, so it is not counted.
 */
export function atWork(cell: Pick<CellState, "visits" | "archived" | "runRecord" | "station">): boolean {
  if (finishedAt(cell) !== null) return false;
  const last = cell.visits[cell.visits.length - 1];
  return Boolean(last && last.leftAt === null && last.station !== "human-approval");
}

/** The tickets at work in a scene. */
export function ticketsAtWork(scene: Pick<Scene, "cells">): string[] {
  return Object.values(scene.cells)
    .filter(atWork)
    .map((c) => c.ticketId)
    .sort();
}

export interface Freshness {
  /** The words shown: "last record 12 s ago", "no ticket at work", "no record received yet". */
  readonly text: string;
  readonly tone: "neutral" | "warning";
  /** The newest record's time (for the exact moment), or null when none has been received. */
  readonly at: number | null;
  /** The accessible name and tooltip: the words and the exact moment. */
  readonly full: string;
}

/**
 * The freshness words at `now` (Unix ms): the newest record's age, the warning tone past
 * STALE_RECORD_MS while `working` tickets are at work, "no ticket at work" when none is.
 */
export function freshnessOf(newest: number | null, now: number, working: number): Freshness {
  const exact = newest !== null ? exactUtc(newest) : null;
  const last = newest !== null ? `last record ${agoWords(now - newest)}` : null;
  if (working === 0) {
    return { text: "no ticket at work", tone: "neutral", at: newest, full: `No ticket at work. ${last ? `The ${last}, ${exact}.` : "No record received yet."}` };
  }
  if (newest === null) return { text: "no record received yet", tone: "neutral", at: null, full: "No record received yet." };
  const old = now - newest > STALE_RECORD_MS;
  const at = `${working} ticket${working === 1 ? "" : "s"} at work`;
  return {
    text: last as string,
    tone: old ? "warning" : "neutral",
    at: newest,
    full: `${(last as string)[0]!.toUpperCase()}${(last as string).slice(1)}, ${exact}; ${at}.${old ? ` Nothing has been recorded for over ${STALE_RECORD_MS / 60_000} minutes while a ticket is at work.` : ""}`,
  };
}

/** What the page announces when the freshness tone changes (polite, once per change), or null for no change worth saying. */
export function freshnessAnnouncement(before: Freshness["tone"] | null, now: Freshness): string | null {
  if (before === null || before === now.tone) return null;
  if (now.tone === "warning") return `Nothing recorded for over ${STALE_RECORD_MS / 60_000} minutes while a ticket is at work.`;
  return now.text === "no ticket at work" ? "No ticket at work." : "Records are arriving again.";
}

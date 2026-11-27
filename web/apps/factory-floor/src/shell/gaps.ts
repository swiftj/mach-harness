/**
 * The Partial badge's popover: each range of history that was lost, in words a person can read out
 * (which source, between which record numbers, when it was noticed, and the observer's reason), so a
 * report says what happened. Pure, tested in plain node (test/floor-gaps.test.mjs).
 *
 * Two places hold lost ranges: the gap records this page received (`history.gap`, and the page's own
 * markers for what it missed), and the observer's own account in its health reply (`lost_ranges`: the
 * latest ranges it lost, including ones before what this page loaded). The same range is listed once.
 * Only identifiers, record numbers, codes and times are used: a gap carries no free text.
 */
import type { HistoryGapState, LostRange } from "../sim";
import { wallMoment } from "./time";

export interface LostRangeLine {
  /** Event id of the gap record, for a stable key. */
  readonly id: string;
  /** Which source, in words: "ticket 6's lifecycle log", "the intake log". */
  readonly source: string;
  /** Between which records: "records 4 to 6", "record 7", or null when the record numbers are not known. */
  readonly records: string | null;
  /** The observer's reason, in words. */
  readonly reason: string;
  /** The reason as recorded (a code), shown beside the words so a report can quote it. */
  readonly code: string;
  /** When it was noticed, "today 14:02:10", or null when not recorded. */
  readonly noticed: string | null;
}

/** Which source a gap's partition key names, in words. Keys: `c:<ticket>:<generation>`, `i:...`, `r:...`, `s:...`, `x:...`, `client`. */
export function sourceWords(key: string): string {
  if (key === "client") return "this page's connection to the observer";
  const [kind, ...rest] = key.split(":");
  switch (kind) {
    case "c":
      return rest.length >= 2 ? `ticket ${rest.slice(0, -1).join(":")}'s lifecycle log` : "a ticket's lifecycle log";
    case "i":
      return "the intake log";
    case "r":
      return "the run records (runs.jsonl)";
    case "s":
      return rest[0] ? `execution ${rest[0]}'s stream` : "an execution's stream";
    case "x":
      return rest[0] ? `execution ${rest[0]}'s record` : "an execution's record";
    default:
      return key.startsWith("cell/") ? `ticket ${key.slice(5)}'s lifecycle log` : key;
  }
}

/** The observer's reason codes for a lost range, in plain words. */
export const GAP_REASON_WORDS: Readonly<Record<string, string>> = {
  "missing-seq": "record numbers were skipped: the records between them were never received",
  truncated: "the file became shorter than what had been read: what was cut off was not received",
  rewritten: "the file was replaced by another: what the old one held after the last read was not received",
  "unparsable-line": "a line could not be read as a record",
  "state-mismatch": "the ticket's cell.json says it moved on, but its log has no record of the move",
  evicted: "the observer no longer holds that part of its history",
  unreadable: "the file could not be read",
  "cursor-expired": "missed while this page was away from the observer",
  "observer-index-reset": "the observer rebuilt its index",
  "before-window": "before the history this page loaded",
};

const rangeWords = (from: string | number | null, to: string | number | null): string | null => {
  if (from === null && to === null) return null;
  if (from === null || to === null || String(from) === String(to)) return `record ${from ?? to}`;
  return `records ${from} to ${to}`;
};

/** Every lost range, the page's and the observer's, oldest first, each once. */
export function lostRangeLines(gaps: readonly HistoryGapState[], observer: readonly LostRange[]): LostRangeLine[] {
  const seen = new Set<string>();
  const out: (LostRangeLine & { order: number })[] = [];
  for (const g of gaps) {
    if (!g.lost || seen.has(g.eventId)) continue;
    seen.add(g.eventId);
    const client = g.source === "client";
    out.push({
      id: g.eventId,
      source: sourceWords(g.source),
      // The page's own markers carry cursors, not record numbers.
      records: client ? null : rangeWords(g.from, g.to),
      reason: GAP_REASON_WORDS[g.reason] ?? g.reason.replace(/-/g, " "),
      code: g.reason,
      noticed: g.noticedAt !== null && g.noticedAt !== undefined ? wallMoment(g.noticedAt, "second").inline : null,
      order: g.at,
    });
  }
  for (const r of observer) {
    if (seen.has(r.eventId)) continue;
    seen.add(r.eventId);
    out.push({
      id: r.eventId,
      source: sourceWords(r.sourceKey),
      records: rangeWords(r.fromSeq, r.toSeq),
      reason: GAP_REASON_WORDS[r.reason] ?? r.reason.replace(/-/g, " "),
      code: r.reason,
      noticed: r.noticedMs !== null ? wallMoment(r.noticedMs, "second").inline : null,
      order: r.atMs ?? 0,
    });
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...line }) => line);
}

/** One line a person can read out for a lost range. */
export function lostRangeSentence(l: LostRangeLine): string {
  return `${l.source[0]!.toUpperCase()}${l.source.slice(1)}${l.records ? `, ${l.records}` : ""}: ${l.reason} (${l.code})${l.noticed ? `; noticed at ${l.noticed}` : ""}.`;
}

/** What a person can do about lost history, in one line. */
export const LOST_RANGES_ACTION =
  "Nothing is needed for the Factory to go on: this is only what the Floor could not show. Reloading the page reads its history again from the observer; a range lost at its source stays lost, and these lines are what to quote in a report (/mach report).";

/**
 * Incomplete history in Factory Analytics' words (M6.6, I-03). Pure, erasable syntax only.
 *
 * Every analytics reply says how complete the history it counted is: `history.partial` (the
 * projection's reason), `history.gaps` (each class, time and count), the metrics reply's
 * `suspect_days` and each row's and bucket's `suspect`. The Timeline draws a gap as a mark saying
 * "History is missing here"; Analytics says the same words where the figures the gap affects are: one
 * line over the area, and "history incomplete here" beside a figure or a day the observer marks.
 * Nothing is filled in. Under a playhead nothing later than it is named.
 */
import { gapClassWord } from "../../sim/provenance";
import { momentWords } from "./query";
import { dayLabel } from "../../timeline/render/scale";

/** What a snapshot carries about its history's completeness. */
export interface SnapshotHistory {
  /** The projection's partial reason code; null when none. */
  readonly partial: string | null;
  readonly gaps: readonly { readonly class: string; readonly at_ms: number | null; readonly count: number | null }[];
  /** UTC days ("2026-11-04") whose figures a gap may affect. */
  readonly suspect_days: readonly string[];
  /** The playhead the view is cut at, if any: gaps and days after it are not named. */
  readonly as_of_ms?: number | null;
}

/** The words beside a figure or a column the observer marks suspect. */
export const HISTORY_SUSPECT_WORDS = "History is missing here: the observer holds a gap in this window, so this figure may count less than happened. Nothing is filled in.";

/** Classes that are not a loss: records received and kept apart, or repaired. */
const NOT_LOST: ReadonlySet<string> = new Set(["unknown-type", "conflict"]);
const SHOWN = 3;

const dayOf = (iso: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** The incomplete-history line for a view, or null when its history is complete. */
export function historyWords(h: SnapshotHistory, moment: (t: number) => string = momentWords): { readonly title: string; readonly body: string; readonly days: readonly number[] } | null {
  const asOf = h.as_of_ms ?? null;
  const gaps = h.gaps.filter((g) => asOf === null || g.at_ms === null || g.at_ms <= asOf);
  const days = h.suspect_days
    .map(dayOf)
    .filter((d): d is number => d !== null && (asOf === null || d <= asOf))
    .sort((a, b) => a - b);
  if (!gaps.length && !days.length && !h.partial) return null;
  const parts: string[] = [];
  const lost = gaps.filter((g) => !NOT_LOST.has(g.class));
  const kept = gaps.filter((g) => NOT_LOST.has(g.class));
  const gapText = (g: SnapshotHistory["gaps"][number]) => `${gapClassWord(g.class)}${g.count !== null ? ` (${g.count.toLocaleString("en-GB")} record${g.count === 1 ? "" : "s"})` : ""}${g.at_ms !== null ? ` at ${moment(g.at_ms)}` : ""}`;
  if (lost.length) parts.push(`History is missing here: ${lost.slice(0, SHOWN).map(gapText).join("; ")}${lost.length > SHOWN ? `; and ${lost.length - SHOWN} more` : ""}.`);
  if (kept.length) parts.push(`History was repaired or kept apart: ${kept.slice(0, SHOWN).map(gapText).join("; ")}${kept.length > SHOWN ? `; and ${kept.length - SHOWN} more` : ""}.`);
  if (h.partial && !gaps.length) parts.push(`The observer's history is partial (${gapClassWord(h.partial)}).`);
  if (days.length) parts.push(`Figures for ${days.slice(0, 6).map(dayLabel).join(", ")}${days.length > 6 ? ` and ${days.length - 6} more days` : ""} (UTC) may count less than happened; each such figure says “history incomplete here”.`);
  parts.push("Nothing is filled in: a missing record is not counted.");
  return { title: lost.length || h.partial ? "Incomplete history." : "History repaired.", body: parts.join(" "), days };
}

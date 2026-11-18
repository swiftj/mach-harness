/**
 * A ticket's epic and issue on the Line (M11): the epic's recorded name, contained as free text
 * (never in a label, a tooltip or the address), else its id; and the slice's issue number as plain
 * text. Nothing links outside the page.
 */
import { FreeText } from "../shell/inspector/FreeText";
import type { LineRow } from "./model";

/** The epic's name when recorded, else its id; null when neither is. `labelled`: the panel shows the free-text label once already. */
export function EpicName({ row, labelled = false }: { row: Pick<LineRow, "epicId" | "epicTitle">; labelled?: boolean }) {
  if (row.epicTitle) return <FreeText field="epicTitle" text={row.epicTitle} labelled={labelled} expandable={false} />;
  return row.epicId ? <span className="font-mono">{row.epicId}</span> : null;
}

/** "Issue #131", or null when no issue is recorded. */
export const issueWords = (issue: number | null): string | null => (issue !== null ? `Issue #${issue}` : null);

/** One short line for a row: its issue and its epic, as far as each is recorded; null when neither is. */
export function EpicLine({ row, labelled = false, className }: { row: Pick<LineRow, "epicId" | "epicTitle" | "issue">; labelled?: boolean; className?: string }) {
  const issue = issueWords(row.issue);
  const epic = row.epicTitle || row.epicId;
  if (!issue && !epic) return null;
  return (
    <span className={className} data-line-epic="">
      {issue ? <span className="font-mono">{issue}</span> : null}
      {issue && epic ? " · " : null}
      {epic ? <EpicName row={row} labelled={labelled} /> : null}
    </span>
  );
}

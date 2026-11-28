/**
 * A finished ticket whose files were not kept (cleanup.archive): the cleanup station keeps a ticket's
 * archive only as the project's setting says (by default, only for a ticket a person decided something
 * on), so once its cell folder is gone its evidence files and lanes' records may be nowhere to read.
 * The observer says so (`not_kept`, with the run record's reason); these are the words the Factory
 * Floor shows for it. No React, no fetch: tested in plain node (test/evidence-not-kept.test.mjs).
 */

/** The fact, said the same way wherever the files would have been shown. */
export const NOT_KEPT_WORDS = "The evidence files were not kept after cleanup (cleanup.archive).";

/** One file a check names that was not kept: the change record still names it with its SHA-256. */
export const NOT_KEPT_FILE_WORDS = "This file was not kept after cleanup (cleanup.archive). The change record merged with the ticket names it with its SHA-256.";

/** An abandoned ticket: abandoning deletes its work, nothing of it was merged. */
export const ABANDONED_WORDS = "This ticket was abandoned, and its work was deleted when it was abandoned. Nothing of it was merged.";

/** One file a check names, of an abandoned ticket. */
export const ABANDONED_FILE_WORDS = "This file was deleted with the ticket's work when it was abandoned.";

/** The lanes of a build whose files were not kept. */
export const NOT_KEPT_LANES_WORDS = "Built in lanes, but the cell's files were not kept after cleanup (cleanup.archive), so its lanes are not shown.";

/** The run record's reason when it says more than the fact itself; null when it says nothing more. */
export function notKeptDetail(reason: string | null | undefined): string | null {
  const r = typeof reason === "string" ? reason.trim() : "";
  return r && r !== NOT_KEPT_WORDS ? r.slice(0, 400) : null;
}

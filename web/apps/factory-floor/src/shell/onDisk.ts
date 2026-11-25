/**
 * Tickets on this computer the page does not show (or shows as finished): one plain line each, with
 * what is known and what a person can do. Pure, tested in plain node (test/floor-on-disk.test.mjs).
 *
 * The observer's health reply lists every ticket folder under `.factory/worktrees/` with whether it
 * holds a lifecycle log and cell.json (`freshness.sources[].cell`). A folder the scene holds no cell
 * for, or holds one for that its records say finished, is said here. Nothing is invented for such a
 * ticket: only that its folder exists, and what was or was not received. A folder with cell.json and
 * no lifecycle log is a ticket whose stations wrote no record at all (the lifecycle helper could not
 * be loaded, so nothing is written): that is told from the files and said so.
 */
import type { CellState, Scene } from "../sim";
import { finishedAt } from "../sim";

/** A ticket's folder as the observer last saw it (`freshness.sources[].cell`). */
export interface CellFolder {
  readonly ticketId: string;
  /** The folder is there now. */
  readonly folder: boolean;
  readonly lifecycleLog: boolean;
  readonly cellJson: boolean;
  /** When the observer first saw the folder (Unix ms), or null when not reported. */
  readonly firstSeenMs: number | null;
}

export type OnDiskKind = "no-records" | "not-received" | "finished-still-here";

export interface OnDiskLine {
  readonly ticketId: string;
  readonly kind: OnDiskKind;
  /** What is known, in one sentence. */
  readonly text: string;
  /** What a person can do, in one sentence. */
  readonly action: string;
}

/**
 * A folder just made, or a ticket just finished, is given this long before it is said: a station
 * writes its first record within moments of making the folder, and cleanup removes the folder
 * moments after its own records.
 */
export const ON_DISK_GRACE_MS = 15_000;

/** The installed lifecycle helper every station loads to write its records. */
export const LIFECYCLE_HELPER = ".claude/skills/mach-intent/scripts/lifecycle.py";

/** The lines to show at `now` (Unix ms), in ticket order. */
export function onDiskLines(folders: readonly CellFolder[], scene: Pick<Scene, "cells">, now: number): OnDiskLine[] {
  const out: OnDiskLine[] = [];
  for (const f of [...folders].sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0))) {
    if (!f.folder) continue;
    const t = f.ticketId;
    const seenFor = f.firstSeenMs === null ? Infinity : now - f.firstSeenMs;
    const cell: CellState | undefined = scene.cells[t];
    const finished = cell ? finishedAt(cell) : null;
    if (f.cellJson && !f.lifecycleLog && seenFor >= ON_DISK_GRACE_MS && (!cell || cell.historyBegan?.reason === "no-lifecycle-log")) {
      out.push({
        ticketId: t,
        kind: "no-records",
        text: `Ticket ${t} has a workspace on this computer, but no station has written a record for it: its folder holds cell.json and no lifecycle log.`,
        action: `If a station is working on it, its lifecycle helper (${LIFECYCLE_HELPER}) is probably missing, so nothing it does is recorded: /mach doctor says when MACH's files are missing, and running the installer again restores them.`,
      });
    } else if (!cell && seenFor >= ON_DISK_GRACE_MS) {
      out.push({
        ticketId: t,
        kind: "not-received",
        text: `Ticket ${t} has a workspace on this computer but none of its records have reached this page yet.`,
        action: "The observer reads the folder again on its own every few seconds. If this stays, the connection badge says whether the observer is still catching up.",
      });
    } else if (finished !== null && now - finished >= ON_DISK_GRACE_MS) {
      out.push({
        ticketId: t,
        kind: "finished-still-here",
        text: `Ticket ${t}: its records say it finished, but its workspace is still here.`,
        action: "Cleanup may not have finished removing it, or the ticket was taken up again and the new run's records have not reached this page yet; the observer reads again on its own.",
      });
    }
  }
  return out;
}

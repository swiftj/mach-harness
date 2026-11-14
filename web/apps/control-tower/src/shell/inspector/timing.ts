/**
 * The inspector's time and tally wording, as plain functions over the scene's own state, so the
 * choice of timestamp and the reading of a count are tested (test/inspector-wording.test.mjs)
 * rather than left inside JSX. No React, no design system: node's test runner imports this file.
 */
import type { CellState, ReviewRoundState, StationVisit, WaveState } from "../../sim";

/** Where an entity stands at the playhead, and the moment that standing began. */
export interface Timing {
  readonly phase: "running" | "finished";
  /** The moment the line names: when it started (running) or when it ended (finished). */
  readonly since: number | null;
  /** Overrides "In progress since" / "Finished at" for an entity that neither runs nor finishes. */
  readonly sinceWord?: string;
}

/** A cell is finished when it is merged, at the merge, not at the moment it was opened. */
export function cellTiming(cell: Pick<CellState, "merged" | "openedAt">): Timing {
  return cell.merged ? { phase: "finished", since: cell.merged.at } : { phase: "running", since: cell.openedAt };
}

/** A station visit is finished when the cell left it, at that moment. */
export function stationTiming(last: Pick<StationVisit, "enteredAt" | "leftAt"> | undefined): Timing {
  if (!last) return { phase: "finished", since: null };
  return last.leftAt === null ? { phase: "running", since: last.enteredAt } : { phase: "finished", since: last.leftAt };
}

/** A wave arrives and is checked; it never "finishes". The only time it carries is its arrival. */
export function waveTiming(wave: Pick<WaveState, "discoveredAt">): Timing {
  return { phase: "finished", since: wave.discoveredAt, sinceWord: "Arrived at" };
}

/** The words before the time in "Finished at 42:42, as of the playhead." */
export function timingWords(t: Timing): string {
  return t.sinceWord ?? (t.phase === "running" ? "In progress since" : "Finished at");
}

/**
 * A review round's tally. Approvals and the approvals needed are two different counts, never a
 * fraction: three of three seats approving where two were needed reads "3 of 3 approved, 2 needed",
 * not "3 of 2".
 */
export function reviewTally(round: Pick<ReviewRoundState, "approvals" | "approvalsNeeded" | "seats">): string {
  const needed = `${round.approvalsNeeded} needed`;
  if (round.approvals === null) return `${round.seats.length} seats, ${needed}`;
  return `${round.approvals} of ${round.seats.length} approved, ${needed}`;
}

/** A station on its own, across cells (I-22): when its latest visit began (one is in progress) or ended. */
export function stationAcrossTiming(working: number, last: Pick<StationVisit, "enteredAt" | "leftAt"> | undefined): Timing {
  if (!last) return { phase: "finished", since: null };
  if (working || last.leftAt === null) return { phase: "running", since: last.enteredAt, sinceWord: "Latest visit began at" };
  return { phase: "finished", since: last.leftAt, sinceWord: "Latest visit ended at" };
}

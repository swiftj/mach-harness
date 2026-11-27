/**
 * A ticket's judging rounds, read once for every view: the round a person reads now, its limit, whether
 * another round follows, and the history of its rounds with each time a person changed them.
 *
 * The records number each round from the ticket's start (the lifecycle's `round`, build.json's loop + 1).
 * The build station records when a person changes the rounds (skills/intent/scripts/rounds.py): a
 * carry-on of a stopped ticket ("carried-on-by-person": by a person's decision, one more round; by a
 * person starting the Factory, a fresh set) or a fresh count ("rounds-reset", a person started the
 * Factory). Each says the limit in force (`max_rounds`) and the rounds that no longer count
 * (`rounds_base`). A person reads a round as its number less those, against that limit: "3 of 3", then
 * after one more round "3 of 4" until the revision starts and "4 of 4" once it has, or after a fresh set
 * "1 of 3". Without such a record the limit is the configured one (MAX_ROUNDS), and never below a round
 * that really started: a round is never shown above its limit. Nothing here is estimated.
 */
import { MAX_ROUNDS } from "./vocabulary";
import type { CarriedOnState, CellState } from "./model";

type RoundCell = Pick<CellState, "round" | "stage"> & { readonly roundMax?: number | null; readonly roundBase?: number | null; readonly carriedOn?: readonly CarriedOnState[] };

/** The rounds that no longer count (a person started the Factory); 0 when none. */
export function roundBase(cell: RoundCell): number {
  return Math.max(0, cell.roundBase ?? 0);
}

/** The round limit in force: the recorded one, else the configured one; never below a round that really started. */
export function roundLimit(cell: RoundCell): number {
  return Math.max(cell.roundMax ?? MAX_ROUNDS, cell.round - roundBase(cell));
}

/** A recorded round (its number since the ticket began) as a person reads it now, or null for a round of an earlier set. */
export function shownRound(cell: RoundCell, round: number): number | null {
  const shown = round - roundBase(cell);
  return shown >= 1 ? shown : null;
}

/** The round a person reads now, never above the limit. */
export function roundNow(cell: RoundCell): number {
  return Math.min(Math.max(1, cell.round - roundBase(cell)), roundLimit(cell));
}

/** "3 of 3": the round in force and its limit. */
export function roundOfWords(cell: RoundCell): string {
  return `${roundNow(cell)} of ${roundLimit(cell)}`;
}

/**
 * The allowance in force at a moment: the rounds set aside and the limit, from the last record of a
 * person changing the rounds at or before it (none: nothing set aside, the configured limit).
 */
export function allowanceAt(cell: RoundCell, at: number): { readonly base: number; readonly max: number } {
  let base = 0;
  let max: number = MAX_ROUNDS;
  for (const c of carryOns(cell)) {
    if (c.at > at) break;
    base = c.base ?? base;
    max = c.max ?? max;
  }
  return { base: Math.max(0, base), max };
}

/**
 * A recorded round read as it was when it happened (`at`: when it started): its number less the rounds
 * set aside then, of the limit then, never above it ("4 of 4" for a round under a carry-on, even after a
 * later fresh set). Without `at`, against the allowance in force now.
 */
export function roundAgainstLimit(cell: RoundCell, round: number, at?: number): string {
  if (at === undefined) {
    const shown = shownRound(cell, round);
    return shown === null ? `${round}, of an earlier set of rounds` : `${shown} of ${Math.max(roundLimit(cell), shown)}`;
  }
  const a = allowanceAt(cell, at);
  const shown = round - a.base;
  if (shown < 1) return String(round);
  return `${shown} of ${Math.max(a.max, shown)}`;
}

/** The number a person read for a recorded round when it happened (`at`), never above its limit then. */
export function shownRoundAt(cell: RoundCell, round: number, at: number): number {
  return Math.max(1, round - allowanceAt(cell, at).base);
}

/** Stopped by the line (the round limit, or a stop for a person): no next round runs without a person. */
export function stoppedForPerson(cell: Pick<CellState, "stage">): boolean {
  return cell.stage === "blocked";
}

/**
 * The round, as a person reads it, that a failed judging round (its recorded number) sends the work back
 * to, or null when none follows: the failed round was the last of the limit, or the ticket is stopped
 * for a person.
 */
export function nextRoundAfter(cell: RoundCell, failedRound: number): number | null {
  if (stoppedForPerson(cell)) return null;
  const next = failedRound + 1 - roundBase(cell);
  return next >= 1 && next <= roundLimit(cell) ? next : null;
}

/** The records of a person changing the rounds, oldest first. */
export function carryOns(cell: RoundCell): readonly CarriedOnState[] {
  return cell.carriedOn ?? [];
}

/**
 * The rounds as the panels list them: each judging round (by its recorded number) with its verification
 * and review, in the order they happened, and each time a person changed the rounds between them. A round
 * of the set in force also says how a person reads it ("1 of 3").
 */
export type RoundGroup<V, R> =
  | { readonly kind: "round"; readonly key: string; readonly round: number; readonly reads: string | null; readonly verification: V | null; readonly review: R | null }
  | { readonly kind: "carried-on"; readonly key: string; readonly carry: CarriedOnState };

export function roundGroups<V extends { readonly round: number; readonly startedAt: number }, R extends { readonly round: number; readonly startedAt: number }>(
  cell: RoundCell & { readonly verifications: readonly V[]; readonly reviews: readonly R[] },
): RoundGroup<V, R>[] {
  const rounds = new Map<number, { at: number; verification: V | null; review: R | null }>();
  const put = (round: number, at: number, set: (g: { verification: V | null; review: R | null }) => void) => {
    const g = rounds.get(round) ?? { at, verification: null, review: null };
    g.at = Math.min(g.at, at);
    set(g);
    rounds.set(round, g);
  };
  for (const v of cell.verifications) put(v.round, v.startedAt, (g) => (g.verification = v));
  // The first review of a round is the round's own; a repeat (no judging round used) does not replace it.
  for (const r of cell.reviews) put(r.round, r.startedAt, (g) => (g.review = g.review ?? r));
  const out: (RoundGroup<V, R> & { readonly order: number })[] = [...rounds.entries()].map(([round, g]) => ({
    kind: "round" as const,
    key: `round/${round}`,
    round,
    // Once a person changed the rounds, each round says how it read when it ran ("4 of 4", "1 of 3").
    reads: carryOns(cell).length ? roundAgainstLimit(cell, round, g.at) : null,
    verification: g.verification,
    review: g.review,
    order: g.at,
  }));
  carryOns(cell).forEach((c, i) => out.push({ kind: "carried-on", key: `carry/${i}`, carry: c, order: c.at }));
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...g }) => g as RoundGroup<V, R>);
}

/** What a person's change to the rounds was, in a few words. */
export function carriedOnTitle(c: Pick<CarriedOnState, "outcome" | "by">): string {
  if (c.outcome === "rounds-reset") return "A fresh set of rounds";
  return c.by === "person-start" ? "Carried on, with a fresh set of rounds" : "Carried on, with one more round";
}

/** The words for one record: who changed the rounds, and what its next round reads. */
export function carriedOnWords(c: Pick<CarriedOnState, "outcome" | "round" | "max" | "by">): string {
  const next = c.round !== null && c.max !== null ? ` Its next round reads ${c.round} of ${c.max}.` : "";
  if (c.outcome === "rounds-reset") return `A person started work on it again, which gave it a fresh set of rounds.${next}`;
  if (c.by === "person-start") return `A person started work on it again, which gave it a fresh set of rounds and carried it on from the build step.${next}`;
  if (c.by === "person-decision") return `A person carried it on with a fix, which gave it one more round.${next}`;
  return `A person carried it on.${next}`;
}

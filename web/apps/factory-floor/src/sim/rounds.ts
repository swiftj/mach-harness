/**
 * A ticket's judging rounds, read once for every view: the round it is in, its limit, whether another
 * round follows, and the history of its rounds with each time a person carried it on.
 *
 * The limit is the configured one (MAX_ROUNDS) until a person's carry-on record sets another: one more
 * round by a person's decision ("person-decision": round 4 of 4), or a fresh allowance when a person
 * starts the Factory or pulls the ticket by hand ("person-start": round 1 of 3 again). Without such a
 * record a round is never shown above its limit: the limit reads as the recorded round only when a
 * later round really started. A ticket stopped after its last round shows the rounds it used and no
 * next round. Nothing here is estimated: every figure is a record's.
 */
import { MAX_ROUNDS } from "./vocabulary";
import type { CarriedOnState, CellState } from "./model";

type RoundCell = Pick<CellState, "round" | "stage"> & { readonly roundMax?: number | null; readonly carriedOn?: readonly CarriedOnState[] };

/** The round limit in force: a carry-on's, else the configured one; never below a round that really started. */
export function roundLimit(cell: RoundCell): number {
  return Math.max(cell.roundMax ?? MAX_ROUNDS, cell.round);
}

/** The round shown now, never above the limit. */
export function roundNow(cell: RoundCell): number {
  return Math.min(Math.max(1, cell.round), roundLimit(cell));
}

/** "3 of 3": the round in force and its limit. */
export function roundOfWords(cell: RoundCell): string {
  return `${roundNow(cell)} of ${roundLimit(cell)}`;
}

/** Any round number read against the cell's limit ("2 of 3"), capped so it never reads past the limit. */
export function roundAgainstLimit(cell: RoundCell, round: number): string {
  const limit = Math.max(roundLimit(cell), round);
  return `${round} of ${limit}`;
}

/** Stopped by the line (the round limit, or a stop for a person): no next round runs without a person. */
export function stoppedForPerson(cell: Pick<CellState, "stage">): boolean {
  return cell.stage === "blocked";
}

/**
 * The round a failed judging round sends the work back to, or null when none follows: the failed round
 * was the last of the limit, or the ticket is stopped for a person.
 */
export function nextRoundAfter(cell: RoundCell, failedRound: number): number | null {
  if (stoppedForPerson(cell)) return null;
  const next = failedRound + 1;
  return next <= roundLimit(cell) ? next : null;
}

/** The carry-ons a person recorded, oldest first. */
export function carryOns(cell: RoundCell): readonly CarriedOnState[] {
  return cell.carriedOn ?? [];
}

/** One line of a ticket's round history: a judging result, or a person carrying it on. */
export type RoundEntry =
  | { readonly kind: "verification"; readonly round: number; readonly at: number | null; readonly passed: boolean | null; readonly failed: readonly string[]; readonly checks: number }
  | { readonly kind: "review"; readonly round: number; readonly at: number | null; readonly outcome: string | null; readonly blockers: number }
  | { readonly kind: "carried-on"; readonly at: number; readonly round: number | null; readonly max: number | null; readonly by: CarriedOnState["by"] };

/** Every judging round and every carry-on, in the order they happened (a round of a fresh allowance keeps its own number). */
export function roundHistory(cell: Pick<CellState, "verifications" | "reviews"> & RoundCell): RoundEntry[] {
  const out: (RoundEntry & { readonly order: number })[] = [];
  for (const v of cell.verifications) {
    const failed = v.checks.filter((c) => c.result === "fail").map((c) => c.targetId);
    const passed = v.status === "running" ? null : v.status === "PASS";
    out.push({ kind: "verification", round: v.round, at: v.decidedAt ?? v.startedAt, passed, failed, checks: v.checks.length, order: v.decidedAt ?? v.startedAt });
  }
  for (const r of cell.reviews) {
    const blockers = r.findings.filter((f) => f.severity === "blocker" && !f.outvoted).length;
    out.push({ kind: "review", round: r.round, at: r.decidedAt, outcome: r.outcome, blockers, order: r.decidedAt ?? r.startedAt });
  }
  for (const c of carryOns(cell)) out.push({ kind: "carried-on", at: c.at, round: c.round, max: c.max, by: c.by, order: c.at });
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...e }) => e as RoundEntry);
}

/**
 * The rounds as the inspector lists them: each judging round with its verification and review, in the
 * order they happened, and each carry-on between them. A fresh allowance numbers its rounds from 1
 * again, so a round is matched to its verification and review within its own allowance.
 */
export type RoundGroup<V, R> =
  | { readonly kind: "round"; readonly key: string; readonly round: number; readonly verification: V | null; readonly review: R | null }
  | { readonly kind: "carried-on"; readonly key: string; readonly carry: CarriedOnState };

export function roundGroups<V extends { readonly round: number; readonly startedAt: number }, R extends { readonly round: number; readonly startedAt: number }>(
  cell: RoundCell & { readonly verifications: readonly V[]; readonly reviews: readonly R[] },
): RoundGroup<V, R>[] {
  const starts = carryOns(cell).filter((c) => c.by === "person-start").map((c) => c.at);
  const allowance = (t: number) => starts.filter((s) => s <= t).length;
  const rounds = new Map<string, { round: number; at: number; verification: V | null; review: R | null }>();
  const put = (round: number, at: number, set: (g: { verification: V | null; review: R | null }) => void) => {
    const key = `${allowance(at)}/${round}`;
    const g = rounds.get(key) ?? { round, at, verification: null, review: null };
    g.at = Math.min(g.at, at);
    set(g);
    rounds.set(key, g);
  };
  for (const v of cell.verifications) put(v.round, v.startedAt, (g) => (g.verification = v));
  // The first review of a round is the round's own; a repeat (no judging round used) does not replace it.
  for (const r of cell.reviews) put(r.round, r.startedAt, (g) => (g.review = g.review ?? r));
  const out: (RoundGroup<V, R> & { readonly order: number })[] = [...rounds.entries()].map(([key, g]) => ({ kind: "round" as const, key, round: g.round, verification: g.verification, review: g.review, order: g.at }));
  carryOns(cell).forEach((c, i) => out.push({ kind: "carried-on", key: `carry/${i}`, carry: c, order: c.at }));
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...g }) => g as RoundGroup<V, R>);
}

/** The words for one carry-on: who gave the rounds, and what they read now. */
export function carriedOnWords(c: Pick<CarriedOnState, "round" | "max" | "by">): string {
  const now = c.round !== null && c.max !== null ? ` It went on in round ${c.round} of ${c.max}.` : "";
  if (c.by === "person-start") return `A person started the Factory or pulled it by hand, which gave it a fresh set of rounds.${now}`;
  if (c.by === "person-decision") return `A person carried it on with a fix, which gave it one more round.${now}`;
  return `A person carried it on.${now}`;
}

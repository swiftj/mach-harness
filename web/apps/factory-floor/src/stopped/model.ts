/**
 * What stopped a ticket, for the one panel a person opens from a "Stopped" box on the Line, the "Needs
 * you" strip, or the stopped cell in the Floor's inspector. Pure: no React, so tests read it directly.
 *
 * Where MACH's own list is read (M23), its facts lead (`situation.stopped`: the station, the rounds,
 * each failed item with the verifier's or reviewer's note, the findings file) and its options are the
 * decision. Elsewhere the page reads the same facts from the records it holds: the last failed
 * verification's checks, the last rejected review's blocking findings, the findings file it wrote. A
 * figure no record carries is left out, never guessed.
 */
import { roundGroups, roundLimit, shownRound, type CellState, type RoundGroup, type VerificationState, type ReviewRoundState } from "../sim";
import type { NeedTicket, StoppedFacts } from "../needs/model";
import type { UncheckedText } from "../text/unchecked";

/** One failed item: from MACH's list (its words, free text) or from the records (the IDs and the reviewers' titles). */
export type FailedItem =
  | { readonly from: "mach"; readonly id: string; readonly text: UncheckedText | null; readonly note: UncheckedText | null }
  | { readonly from: "verifier"; readonly id: string; readonly round: number }
  | { readonly from: "reviewer"; readonly id: string; readonly round: number; readonly seat: string; readonly title: string };

export interface StoppedView {
  readonly ticketId: string;
  /** What stopped it, in one sentence: MACH's own when its list is read, else the Line's. */
  readonly sentence: string;
  /** When it stopped (source time), or null when no record says. */
  readonly at: number | null;
  /** The station that stopped it, in words ("Verification", "Review"), or null. */
  readonly station: string | null;
  readonly round: { readonly used: number | null; readonly max: number | null };
  readonly failed: readonly FailedItem[];
  /** The findings file, project-relative; never a link. */
  readonly findingsFile: string | null;
  /** Every round so far and each time a person carried it on, oldest first. */
  readonly rounds: readonly RoundGroup<VerificationState, ReviewRoundState>[];
}

const STATION_WORDS: Readonly<Record<string, string>> = { verify: "Verification", review: "Review", build: "Build", "human-approval": "a person's approval", person: "a person's approval", merge: "Merge" };

/** The last judging round that failed, and the station that judged it, from the records. */
function lastFailure(cell: CellState): { station: "verify" | "review"; round: number } | null {
  const v = [...cell.verifications].reverse().find((x) => x.status === "FAIL_WITH_EVIDENCE" && x.decidedAt !== null) ?? null;
  const r = [...cell.reviews].reverse().find((x) => (x.outcome === "REJECTED" || x.outcome === "ESCALATE") && x.decidedAt !== null) ?? null;
  if (!v && !r) return null;
  if (v && (!r || (v.decidedAt ?? 0) >= (r.decidedAt ?? 0))) return { station: "verify", round: v.round };
  return { station: "review", round: (r as ReviewRoundState).round };
}

function failedFromRecords(cell: CellState): FailedItem[] {
  const last = lastFailure(cell);
  if (!last) return [];
  if (last.station === "verify") {
    const v = [...cell.verifications].reverse().find((x) => x.status === "FAIL_WITH_EVIDENCE" && x.round === last.round);
    return (v?.checks ?? []).filter((c) => c.result === "fail").map((c) => ({ from: "verifier" as const, id: c.targetId, round: last.round }));
  }
  const r = [...cell.reviews].reverse().find((x) => x.round === last.round && (x.outcome === "REJECTED" || x.outcome === "ESCALATE"));
  return (r?.findings ?? []).filter((f) => f.severity === "blocker" && !f.outvoted).map((f) => ({ from: "reviewer" as const, id: f.rule ?? f.id, round: last.round, seat: f.seat, title: f.title }));
}

/** The findings file the last failed round wrote, as the records name it. */
function findingsFromRecords(cell: CellState): string | null {
  const last = lastFailure(cell);
  if (!last) return null;
  const kind = last.station === "verify" ? "verification-findings" : "review-findings";
  const a = [...cell.artifacts].reverse().find((x) => x.kind === kind && (x.round === null || x.round === last.round)) ?? null;
  return a ? a.path : null;
}

export function stoppedView(input: { readonly ticketId: string; readonly cell: CellState | null; readonly sentence: string; readonly at: number | null; readonly need: NeedTicket | null }): StoppedView {
  const { cell, need } = input;
  const facts: StoppedFacts | null = need?.stopped ?? null;
  const last = cell ? lastFailure(cell) : null;
  const station = facts?.station ?? last?.station ?? null;
  const usedFromRecords = cell ? Math.min(Math.max(0, ...cell.verifications.map((v) => shownRound(cell, v.round) ?? 0), ...cell.reviews.map((r) => shownRound(cell, r.round) ?? 0)), roundLimit(cell)) : null;
  return {
    ticketId: input.ticketId,
    sentence: need?.summary ?? input.sentence,
    at: input.at,
    station: station ? (STATION_WORDS[station] ?? station) : null,
    round: {
      used: facts?.round.used ?? (usedFromRecords ? usedFromRecords : null),
      max: facts?.round.max ?? (cell ? roundLimit(cell) : null),
    },
    // MACH's items lead; when it names none, the failed checks and blocking findings the records hold.
    failed: facts && facts.failed.length ? facts.failed.map((f) => ({ from: "mach" as const, ...f })) : cell ? failedFromRecords(cell) : [],
    findingsFile: facts?.findingsFile ?? (cell ? findingsFromRecords(cell) : null),
    rounds: cell ? roundGroups(cell) : [],
  };
}

/** A round's result in words: "Verification failed: 9 of 11 proven", "Review rejected, 2 blocking findings". */
export function roundResultWords(g: Extract<RoundGroup<VerificationState, ReviewRoundState>, { kind: "round" }>): string {
  const parts: string[] = [];
  const v = g.verification;
  if (v) {
    const passed = v.checks.filter((c) => c.result === "pass").length;
    const of = v.checks.length ? `: ${passed} of ${v.checks.length} proven` : "";
    parts.push(v.status === "running" ? "Verification running" : v.status === "PASS" ? `Verification passed${of}` : `Verification failed${of}`);
  }
  const r = g.review;
  if (r) {
    const blockers = r.findings.filter((f) => f.severity === "blocker" && !f.outvoted).length;
    const b = blockers ? `, ${blockers} blocking finding${blockers === 1 ? "" : "s"}` : "";
    parts.push(r.outcome === null ? "Review in progress" : r.outcome === "APPROVED" ? "Review approved" : r.outcome === "AWAITING_HUMAN" ? "Review approved, waiting for a person" : `Review rejected${b}`);
  }
  return parts.join(". ") || "Nothing judged in this round yet";
}

/**
 * The stations' own outcome words in plain words, for the inspector and the Line. The raw word is
 * still shown where the record is quoted ("The station said").
 */
import { gateStateWords, visitStatusOf, type GateState, type StationVisit } from "../../sim";

/** The stations' own outcome words (review.py, verify.py) in plain words; the raw word stays beside them. */
const STATION_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  AWAITING_HUMAN: "review approved; waiting for a person's approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  ESCALATE: "escalated to a person",
  PASS: "passed",
  FAIL_WITH_EVIDENCE: "failed, with evidence",
  INCOMPLETE_EVIDENCE: "evidence incomplete",
  APPROVE: "approve",
  REJECT: "reject",
  // A person's answer at the approval gate (M9): a wait's outcome and the human-approval visit's.
  "sent-back": "sent back to the build station by a person",
  SENT_BACK: "sent back to the build station by a person",
};

/** An outcome in words, and the station's own word when it is one (shown beside them, in mono); null words when it is already plain. */
export function outcomeWordsOf(outcome: string): { words: string; own: string | null } {
  const words = STATION_OUTCOME_WORDS[outcome];
  if (words) return { words, own: outcome };
  // A wait's outcome is the record that closed it (an event type such as work.claimed): said as such.
  if (/^[a-z_]+\.[a-z_]+$/.test(outcome)) return { words: `closed by a ${outcome} record`, own: null };
  return { words: outcome, own: null };
}

/**
 * The same plain words, capitalised, for a place that shows one word as a state ("Failed, with
 * evidence" for FAIL_WITH_EVIDENCE); a word that is not a station's own is left as it is.
 */
export function outcomeStateWords(outcome: string): string {
  const { words } = outcomeWordsOf(outcome);
  return words ? words[0]!.toUpperCase() + words.slice(1) : words;
}

/**
 * A station visit's state as one word, with a station's own outcome word in plain words
 * (visitStatusOf's word, which quotes the record, otherwise).
 */
export function visitStateWords(visit: Pick<StationVisit, "station" | "leftAt" | "outcome" | "outcomeWord" | "unclosed">): string {
  const status = visitStatusOf(visit);
  return status.state === "ended" ? outcomeStateWords(visit.outcomeWord ?? visit.outcome ?? "ended") : status.word;
}

/**
 * A gate's position in words (gateStateWords), with a reason that is a station's own outcome code in
 * plain words: "Refused: failed, with evidence", never "Refused: FAIL_WITH_EVIDENCE". Other reason
 * codes (findings-invalid, wrong-stage) are left as recorded.
 */
export function gatePositionWords(gate: Pick<GateState, "state" | "reasonCode">): string {
  const code = gate.reasonCode;
  if (!code || (gate.state !== "overridden" && gate.state !== "failed")) return gateStateWords(gate);
  const { own, words } = outcomeWordsOf(code);
  return own ? gateStateWords({ ...gate, reasonCode: words }) : gateStateWords(gate);
}

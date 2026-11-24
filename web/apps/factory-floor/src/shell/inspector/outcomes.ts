/**
 * The stations' own outcome words in plain words, for the inspector and the Line. The raw word is
 * still shown where the record is quoted ("The station said").
 */
import { gateStateWords, visitStatusOf, type GateEvaluation, type GateState, type StationVisit } from "../../sim";

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
 * The reason codes the stations record with `gate.evaluated` (skills/<station>/scripts: the codes
 * written in the record itself and the `code` of each refusal the station raises), in plain words.
 * Each is read from the station's own message for that code; a code not listed here is shown as
 * recorded, never guessed at.
 */
export const GATE_REASON_WORDS: Readonly<Record<string, string>> = {
  // intent station: groom and plan (cell.py)
  "spec-invalid": "the slice's spec did not pass its check",
  "open-questions": "the spec still has open questions",
  "plan-invalid": "the plan did not pass its check",
  "spec-question": "the plan raised a question about the spec for the product manager",
  "spec-changed": "the slice's spec changed",
  replanned: "the ticket was planned again",
  "policy-accepted": "a person accepted the policy concern",
  "adr-changed": "an architecture decision changed",
  "adr-conflict": "the plan cannot follow an architecture decision, and an engineer has not decided yet",
  "adr-exception": "an engineer recorded an exception to an architecture decision",
  "adr-accepted": "an engineer accepted the architecture decision the plan proposes",
  "adr-not-accepted": "the plan proposes an architecture decision no engineer has accepted yet",
  // intent station: its other refusals (the code of each CellError in cell.py); not-recorded is the last resort
  "adr-accept-failed": "the architecture decision could not be marked accepted",
  "adr-baseline-missing": "a required architecture decision has not been accepted yet",
  "adr-exists": "an architecture decision with that name already exists",
  "adr-folder-setting": "the setting for the architecture decisions' folder is not usable",
  "adr-id-invalid": "that is not an architecture decision's ID",
  "adr-missing": "the architecture decision does not exist",
  "adr-not-binding": "the architecture decision is not accepted, so it binds nothing",
  "adr-not-committed": "the accepted architecture decision was not committed",
  "adr-not-proposed": "the plan does not propose that architecture decision, or it is not a readable proposal",
  "adr-unchanged": "the architecture decision the plan stopped at has not changed",
  "already-widened": "the change is already a full slice",
  "app-type-invalid": "the app type is not one MACH knows",
  "applies-to-invalid": "what the architecture decision applies to could not be read",
  "build-station-missing": "the build station is not installed",
  "claim-failed": "the claim could not be recorded",
  "claim-held": "another worker holds the ticket",
  "claim-refused": "the claim was refused",
  "config-unreadable": "the factory's settings could not be read",
  "exception-exists": "an exception to that architecture decision is already recorded",
  "factory-tuning": "a factory-tuning ticket never proposes an architecture decision",
  "from-studio": "the slice came from Product Studio, where this is decided",
  "git-unreadable": "git could not read the repository",
  judged: "the ticket has been through a judging round",
  "lanes-folder-unknown": "a folder among the lanes is not one of the ticket's lanes",
  "no-branch": "the ticket has no branch of its own",
  "not-from-studio": "the slice did not come from Product Studio",
  "not-small": "the change is not a small change",
  "nothing-to-record": "there was nothing to record",
  "open-failed": "the ticket's workspace could not be opened",
  "person-missing": "the person who decided was not named",
  "person-only": "only a person can decide this, and nobody is here in an unattended run",
  "plan-missing": "there is no plan yet",
  "policy-acceptance-invalid": "the policy acceptance could not be recorded as given",
  "principles-closed": "the product principles are no longer read for this ticket",
  "principles-unreadable": "the product principles could not be read",
  "question-missing": "the question was not given",
  "reason-missing": "no reason was given",
  "ref-refused": "git would not keep the old work under a saved name",
  "reset-failed": "git could not return the branch to its spec",
  "rule-unknown": "that is not a rule for a small change",
  "several-projects": "the project could not be told apart from another",
  "slice-id-invalid": "that is not a slice ID",
  "small-not-allowed": "this ticket is never a small change",
  "small-unjudged": "whether the change is still small could not be judged",
  "spec-missing": "the spec file is missing",
  "spec-not-ready": "the spec is not finalized yet",
  "spec-not-recorded": "no spec is recorded for the ticket yet",
  "spec-outside-cell": "the spec is outside the ticket's workspace",
  "spec-wrong-folder": "the spec is not in the slices folder",
  "ticket-id-invalid": "that is not a ticket ID",
  "ticket-missing": "the local ticket does not exist",
  "ticket-unreadable": "the local ticket could not be read",
  "title-missing": "the architecture decision has no usable title",
  "uncommitted-unsaved": "uncommitted work could not be saved",
  "work-on-main": "the ticket's work is already on main",
  "worktree-not-removed": "git would not remove a lane's workspace",
  "not-recorded": "no reason was recorded",
  // audit station: the readiness tier (audit.py)
  gold: "readiness tier Gold",
  silver: "readiness tier Silver",
  bronze: "readiness tier Bronze",
  // build station: what a recorded override let through (build.py OVERRIDDEN_GATE)
  "test-amended": "a committed test was changed",
  "files-outside-plan": "files outside the plan were changed",
  "test-passed-first-run": "a new test passed before any code was written",
  "red-not-attributed": "the failing run did not name the new test",
  "test-written-early": "the test was written in an earlier task",
  "no-baseline": "the project has no test suite yet",
  "impl-already-done": "the work was already done",
  "not-a-secret": "what looked like a secret is not one",
  // build station: its own records and refusals (build.py, landing.py)
  "not-finished": "not every task is finished, or a spec ID has no test",
  "round-limit": "the ticket has used every round it is allowed",
  "commands-set": "the build's commands were set",
  sequential: "too few builders were free, so the plan is built one task at a time",
  "lane-handed-back": "a lane was handed back to the cell",
  "lane-set-aside": "a lane was set aside; its tasks are built again in the cell",
  "lanes-interaction": "the lanes' tests fail only when their work is joined",
  "landing-failed": "the lanes' work could not be landed",
  "branch-moved": "the ticket's branch moved, so nothing was landed",
  "red-before-green": "the new tests already pass before any code is written",
  "red-attribution": "the suite fails, but its output never mentions the new test",
  "red-ids-not-named": "no test names the spec IDs the plan gives the task",
  "suite-broken": "the change broke a suite that was passing",
  "suite-red": "the suite does not pass",
  "frozen-tests": "the task changes tests that are already committed",
  scope: "the task changed files the plan did not give it",
  "lane-scope": "the task changed files the plan gives another lane",
  "changed-no-files": "the task changed no files",
  "secret-candidate": "what was about to be committed looks like it holds a secret",
  "claude-config": "the task writes Claude Code configuration",
  "adr-files": "the task changes architecture decision records, which only people change",
  "baseline-red": "the tests already failed before any change",
  "baseline-red-after-main": "the tests fail once the latest main is merged in",
  "main-conflict": "bringing the branch up to date with main conflicts",
  "audit-missing": "there is no audit report",
  "audit-stale": "the audit report is out of date",
  "audit-bronze": "the repository's readiness tier is Bronze",
  "no-test-command": "no test command is known for the build",
  "command-missing": "the command is not installed",
  "plan-order": "tasks are done in plan order, and this was not the next one",
  "wrong-step": "the task was completed with the wrong step",
  "task-already-done": "the task is already done",
  "lanes-not-done": "not every lane is done",
  "lanes-not-ready": "the tasks before the lanes are not done yet",
  "no-free-place": "no place is free for another builder",
  // merge station (merge.py)
  "landed-overlap": "what landed on main since approval touches the same ground",
  "main-moved": "main moved on since the ticket was tested",
  "main-moving": "main kept moving while the ticket was being merged",
  "revalidation-conflict": "main moved on since approval, and bringing the branch up to date conflicts",
  "sent-back": "with the latest main merged in the tests fail, so the ticket went back to the build station",
  "approval-void": "the approval no longer stands",
  "exception-expired": "a security exception expired",
  "merge-failed": "git could not merge the branch",
  "remote-unreachable": "the shared repository could not be reached",
  "no-shared-main": "the shared repository has no main branch to test against",
  // review station (review.py)
  "no-passing-verification": "there is no passing verification",
  "evidence-missing": "evidence the verification lists is missing",
  "votes-missing": "not every seat has voted",
  "scan-unanswered": "the security scan has items no one answered",
  "still-rejected": "the round would still be rejected",
  "not-awaiting-human": "the ticket is not waiting for a person's approval",
  // verify station (verify.py)
  "incomplete-evidence": "the evidence is incomplete",
  "not-built": "nothing is recorded as built yet",
  "stale-evidence": "evidence is older than this verification run",
  "builder-evidence": "the builder's own test run is not evidence",
  "mock-as-evidence": "the design mock was given as evidence",
  "mock-changed": "the approved design mock is missing or changed",
  // more than one station
  "code-changed": "the code changed after it was built or verified",
  "uncommitted-changes": "the work has uncommitted changes",
  "cell-dirty": "the work has uncommitted changes",
  "wrong-stage": "the ticket is not at the stage this step needs",
  "not-started": "the station's work has not started",
  "already-started": "the station's work had already started",
  "no-cell": "the ticket has no workspace yet",
  "unknown-task": "the plan has no such task",
};

/**
 * A code that only repeats the verdict: the intent station records `refused` when a command stops
 * without a code of its own, so "Refused: refused" says nothing. Read as no reason.
 */
const VERDICT_ONLY = new Set(["refused", "refuse", "passed", "pass", "overridden", "override"]);

/** A recorded reason code in words, or null when none was recorded (or the code only repeats the verdict). */
export function gateReasonOf(code: string | null | undefined): { readonly words: string; readonly code: string; readonly known: boolean } | null {
  const c = code?.trim();
  if (!c || VERDICT_ONLY.has(c.toLowerCase())) return null;
  const words = GATE_REASON_WORDS[c] ?? STATION_OUTCOME_WORDS[c];
  return words ? { words, code: c, known: true } : { words: c, code: c, known: false };
}

/** What a gate's panel says when a refusal or an override recorded no reason. */
export const NO_REASON_WORDS = "No reason was recorded";

/**
 * A gate's position in words (gateStateWords), with its recorded reason in plain words: "Refused: the
 * plan did not pass its check", "Refused: failed, with evidence", never "Refused: FAIL_WITH_EVIDENCE".
 * A code not in the table is shown as recorded. No reason (or one that only repeats the verdict)
 * leaves the verdict alone ("Refused"), never "Refused: refused".
 */
export function gatePositionWords(gate: Pick<GateState, "state" | "reasonCode"> & { readonly gate?: GateState["gate"] }): string {
  if (gate.state !== "overridden" && gate.state !== "failed") return gateStateWords(gate);
  const reason = gateReasonOf(gate.reasonCode);
  return gateStateWords({ ...gate, reasonCode: reason ? reason.words : null });
}

type Verdict = GateEvaluation["verdict"];
const VERDICT_WORDS: Readonly<Record<Verdict, string>> = { passed: "Passed", refused: "Refused", overridden: "Overridden" };

/** One evaluation of a gate, in words: "Refused for T2: the suite does not pass". */
export function evaluationWords(e: Pick<GateEvaluation, "verdict" | "reasonCode" | "subject">): string {
  const reason = gateReasonOf(e.reasonCode);
  return `${VERDICT_WORDS[e.verdict]}${e.subject ? ` for ${e.subject}` : ""}${reason ? `: ${reason.words}` : e.verdict === "passed" ? "" : `: ${NO_REASON_WORDS.toLowerCase()}`}`;
}

/** What a gate's Decision section says beyond its position (which the panel's header shows). */
export interface GateDecision {
  /** The recorded reason; `none` when a refusal or an override recorded none; null when there is nothing to say. */
  readonly reason: { readonly words: string; readonly code: string; readonly known: boolean } | "none" | null;
  /** The task, check or seat the evaluation names, when it names one. */
  readonly subject: string | null;
  /** The gate's own sentence, only where it adds to the position and the reason. */
  readonly detail: string | null;
  /** Every evaluation of a gate evaluated more than once, oldest first. */
  readonly evaluations: readonly Pick<GateEvaluation, "verdict" | "reasonCode" | "subject" | "at">[];
}

/**
 * The Decision section of a gate. `evaluation` is the latest lifecycle evaluation that set this gate
 * state (from the cell's gate log), or null when the gate was set otherwise (a review's tally, a
 * person, the simulation). A gate set by an evaluation is described by its verdict and reason: its
 * sentence ("Refused: plan-invalid.") only repeats them, so it is left out. "No reason was recorded"
 * is said only of a refusal or an override an evaluation recorded without a reason.
 */
export function gateDecisionOf(gate: Pick<GateState, "state" | "reasonCode" | "detail" | "recorded" | "gate">, evaluation: Pick<GateEvaluation, "verdict" | "reasonCode" | "subject" | "at"> | null): GateDecision {
  const evaluations = gate.recorded?.evaluations ?? [];
  const latest = evaluations.length ? evaluations[evaluations.length - 1]! : evaluation;
  const fromRecord = latest !== null;
  const stopped = gate.state === "failed" || gate.state === "overridden";
  // The latest evaluation's own code: a gate state keeps an earlier code when a later record has none.
  const found = gateReasonOf(latest ? latest.reasonCode : stopped ? gate.reasonCode : null);
  const reason = found ?? (fromRecord && stopped ? "none" : null);
  const detail = gate.recorded || (fromRecord && (stopped || found)) ? null : gate.detail.trim() || null;
  return { reason, subject: latest?.subject ?? null, detail, evaluations: evaluations.length > 1 ? evaluations : [] };
}

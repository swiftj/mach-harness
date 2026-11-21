/**
 * What the case and verdict screen shows, from the engine's answers alone (case.show, case.check, idea.show,
 * verdict.record, idea.publish). Pure, so it is unit-tested against the real fixtures (test/shape-case-model.test.mjs).
 *
 * It maps what the engine reported to words and a look, and builds the arguments of the two acts. It decides no
 * product rule: whether a verdict holds, whether Go is allowed, whether an idea may be published and where it goes
 * are the engine's, and every act can still be refused in the engine's words.
 *
 * The verdict is the product manager's alone. Nothing here ranks, orders by preference, pre-selects or recommends
 * one of the three choices: `verdictChoices` is a fixed order with words of the same weight, and no function takes a
 * brief, a case or a check and returns a decision.
 */
import type { CaseModel, IdeaGithubView, IdeaPublished, IdeaRow, IdeaShow, IdeaVerdict, VerdictDecision } from "@mach/ui/api";

/** The three verdicts, in the one fixed order. Each meaning says what follows, never whether it is right. */
export const verdictChoices: ReadonlyArray<{ decision: VerdictDecision; word: string; meaning: string }> = [
  { decision: "go", word: "Go", meaning: "Shape it into work: size it and find its route next." },
  { decision: "not-now", word: "Not now", meaning: "Keep it with your reason, to come back to later." },
  { decision: "no", word: "No", meaning: "Keep it with your reason. It stays on the board." },
];

export const decisionWord = (decision: string): string => verdictChoices.find((c) => c.decision === decision)?.word ?? decision;

/** The one sentence beside the choices: MACH never recommends, and what the verdict is recorded with. */
export function recordedWithSentence(revision: number, changedSinceCheck: boolean): string {
  const brief =
    revision === 0
      ? "the brief as it stands (there is none yet)"
      : changedSinceCheck
        ? `the brief as it stands now (it changed since revision ${revision}, so MACH checks it first)`
        : `the brief's revision ${revision}`;
  return `MACH never recommends a verdict. Yours is recorded with your GitHub name and ${brief}.`;
}

/** The reason as the engine takes it: one line. Line breaks typed in the box become spaces; nothing else changes. */
export const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** The host's limit on a reason (one line, at most 500 characters). */
export const reasonLimit = 500;

/** What is missing before the act can be confirmed, in words, or null. Only that a choice and a reason are given. */
/**
 * What the form still needs before the confirmation opens. `goWhy` is the engine's own sentence when a Go cannot be
 * recorded now (`idea.show`'s `acts.go`): said when Go is chosen, before the click, never by disabling or ranking it.
 */
export function verdictFormProblem(decision: VerdictDecision | null, reason: string, goWhy: string | null = null): { field: "choice" | "reason"; message: string } | null {
  if (!decision) return { field: "choice", message: "Choose Go, Not now or No." };
  if (decision === "go" && goWhy) return { field: "choice", message: goWhy };
  const line = oneLine(reason);
  if (!line) return { field: "reason", message: "Write your reason. A verdict is kept with the reason in your own words." };
  if (line.length > reasonLimit) return { field: "reason", message: `Shorten your reason to ${reasonLimit} characters or fewer. It has ${line.length}.` };
  return null;
}

export const verdictArgs = (ideaId: string, decision: VerdictDecision, reason: string) => ({ idea_id: ideaId, decision, reason: oneLine(reason) });

/** One hard question as the screen shows it. */
export interface QuestionView {
  id: string;
  question: string;
  /** answered: the PM's answer; left: not answered on purpose (with the reason when one was written); open: neither. */
  state: "answered" | "left" | "open";
  answer: string | null;
  /** Why it was left unanswered, the PM's words; null when "Not answered." was written alone. */
  leftBecause: string | null;
}

export function questionViews(model: CaseModel): QuestionView[] {
  return model.questions.map((q) => {
    if (q.state === "answered") return { id: q.id, question: q.question, state: "answered", answer: q.answer, leftBecause: null };
    if (q.state === "not_answered") return { id: q.id, question: q.question, state: "left", answer: null, leftBecause: q.answer && q.answer.trim() ? q.answer : null };
    return { id: q.id, question: q.question, state: "open", answer: null, leftBecause: null };
  });
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The counts the engine gave, in words: "2 answered · 1 left unanswered on purpose". */
export function questionCounts(model: Pick<CaseModel, "answered" | "not_answered" | "open">): string {
  const parts = [`${model.answered} answered`];
  if (model.not_answered > 0) parts.push(`${model.not_answered} left unanswered on purpose`);
  if (model.open > 0) parts.push(count(model.open, "with no answer yet", "with no answer yet"));
  return parts.join(" · ");
}

/** The case check's result as a state: its word and look. The findings themselves are shown in the engine's words. */
export function caseCheckState(check: { passes: boolean; errors: string[]; warnings: string[] }): { word: string; tone: "success" | "danger"; glyph: "check" | "alert" } {
  return check.passes ? { word: "Passes its check", tone: "success", glyph: "check" } : { word: "Does not pass its check", tone: "danger", glyph: "alert" };
}

/** Where the verdict stands, from idea.show's verdict (which says whether it holds). */
export type VerdictState = { kind: "none" } | { kind: "holds"; verdict: IdeaVerdict } | { kind: "stale"; verdict: IdeaVerdict };

export function verdictState(verdict: IdeaVerdict | null): VerdictState {
  if (!verdict) return { kind: "none" };
  return verdict.stale || !verdict.holds ? { kind: "stale", verdict } : { kind: "holds", verdict };
}

/** What the verdict was recorded for, in words. Revision 0 with no brief: given before any brief was written. */
export function verdictFor(verdict: Pick<IdeaVerdict, "revision" | "brief_sha256">): string {
  if (verdict.revision === 0 || verdict.brief_sha256 === null) return "Given before any brief was written";
  return `For the brief's revision ${verdict.revision}`;
}

/** What follows a verdict that holds, in words. Go leads on; Not now and No are kept and the idea stays on the board. */
export function verdictConsequence(decision: string): { sentence: string; wayOn: "route" | null } {
  if (decision === "go") return { sentence: "Next, size it to find its route: one slice, an epic or several epics. Nothing is created until you say so there.", wayOn: "route" };
  return { sentence: "It is kept with your reason, and the idea stays on the board. You can record a different verdict whenever you want to.", wayOn: null };
}

/** Where the idea is saved, from Studio's records (no network). */
export type PublishState =
  | { kind: "not-published" }
  | { kind: "stopped" }
  | { kind: "number-taken"; others: number[] }
  | { kind: "github"; issue: number | null; url: string | null; upToDate: boolean; changedOnGithub: boolean; changedAfterVerdict: boolean; verdictOnGithub: boolean | null; closed: boolean }
  | { kind: "folder" };

export function publishState(github: IdeaGithubView): PublishState {
  if (github.unfinished) return { kind: "stopped" };
  if (github.number_taken) return { kind: "number-taken", others: github.other_issues };
  if (github.saved === "github")
    return {
      kind: "github",
      issue: github.issue,
      url: github.url,
      upToDate: github.up_to_date,
      changedOnGithub: github.changed_on_github,
      changedAfterVerdict: github.changed_after_verdict,
      verdictOnGithub: github.verdict_on_github,
      closed: github.state === "closed",
    };
  if (github.saved === "folder") return { kind: "folder" };
  return { kind: "not-published" };
}

/** The act publishing offers in each state, or null when what is saved is already what is here. */
export function publishAct(state: PublishState, next: IdeaRow["next"]["kind"]): { label: string; again: boolean } | null {
  switch (state.kind) {
    case "not-published":
      return { label: "Save to GitHub", again: false };
    case "stopped":
      return { label: "Save again to finish", again: true };
    case "number-taken":
      return null;
    case "folder":
      return { label: "Save again", again: true };
    case "github":
      if (state.upToDate && !state.changedOnGithub && next !== "publish") return null;
      return { label: "Save the changes to GitHub", again: true };
  }
}

/** Renumbering is offered only where the engine reported the number taken, or named it as the next step. */
export const renumberOffered = (state: PublishState, next: IdeaRow["next"]["kind"]): boolean => state.kind === "number-taken" || next === "renumber";

/** What a publish did, for the dialog's result. */
export type PublishOutcome =
  | { where: "github"; issue: number; url: string; by: string; verdictPosted: boolean; revision: number; note: string }
  | { where: "folder"; folder: string; whyFolder: string; revision: number; note: string };

export function publishOutcome(result: IdeaPublished): PublishOutcome {
  if (result.saved_to === "github") return { where: "github", issue: result.issue, url: result.url, by: result.by, verdictPosted: result.verdict_posted, revision: result.revision, note: result.note };
  return { where: "folder", folder: result.folder, whyFolder: result.why_folder, revision: result.revision, note: result.note };
}

/**
 * The page's parts (M16 layout): the case, the verdict and publishing, one open at a time. Which part opens on arrival
 * follows what the engine reported: publishing when saving stopped part way, the number is taken, or the board's next
 * step is to publish or renumber; otherwise the verdict. It never depends on which verdict was recorded.
 */
export type CasePart = "case" | "verdict" | "publish";

export function openOnArrival(state: PublishState, next: IdeaRow["next"]["kind"]): CasePart {
  if (state.kind === "stopped" || state.kind === "number-taken" || next === "publish" || next === "renumber") return "publish";
  return "verdict";
}

/** The case part's one line: what the case holds, in words. The check's result is its pill; its findings are beside the parts. */
export function caseSummary(model: Pick<CaseModel, "customer" | "questions" | "answered" | "not_answered" | "open"> | null): string {
  if (!model) return "No case yet. It is written in the conversation on the Explore step.";
  const told = model.customer ? "Told as the customer would hear it" : "Not yet told as the customer would hear it";
  const n = model.questions.length;
  if (n === 0) return `${told}. No questions are written in the case.`;
  return `${told}, with ${count(n, "hard question", "hard questions")}: ${questionCounts(model)}`;
}

/** The verdict part's one line, in the same words for every decision; the decision itself is the part's pill. */
export function verdictSummary(state: VerdictState, shaped: boolean, note: string): string {
  // With no verdict yet, the engine's own note (who decides, and that recording creates nothing) is the summary.
  if (state.kind === "none") return note;
  const by = state.verdict.by ? ` by ${state.verdict.by}` : " with nobody signed in to GitHub";
  // What to do about it is the banner just under the row, in the engine's words.
  if (state.kind === "stale") return `Recorded${by} on an earlier brief, so it no longer holds.`;
  if (shaped) return `Recorded${by}. The idea is shaped into work.`;
  return `Recorded${by}. ${verdictConsequence(state.verdict.decision).wayOn === "route" ? "Next, size it to find its route." : "It is kept with your reason, and the idea stays on the board."}`;
}

/** The publishing part's one line: where the idea is saved and what, if anything, is left to do. */
export function publishSummary(state: PublishState): string {
  switch (state.kind) {
    case "not-published":
      return "Saved nowhere others can read it yet.";
    case "stopped":
      return "Saving stopped part way. Save again to finish.";
    case "number-taken":
      return "Another idea on GitHub uses this number. Give yours the next free number, then save it.";
    case "folder":
      return "In a folder in your workspace, for you to commit.";
    case "github":
      if (state.changedOnGithub) return "The issue was edited on GitHub after it was saved. Save again to put the saved brief back.";
      return state.upToDate ? `${state.issue !== null ? `Issue #${state.issue}` : "The issue"} shows the brief and the verdict as they are here.` : "The brief or the verdict changed here since it was saved.";
  }
}

/** What publishing would save, from idea.show: the brief as the issue's body; the verdict as a signed comment only while it holds. Never the case. */
export function whatIsSaved(show: Pick<IdeaShow, "brief" | "verdict">): { brief: string; verdict: string; caseNote: string } {
  const brief = show.brief.exists ? `The brief, revision ${show.brief.revision}, as the issue's body.` : "The brief: there is none yet, so the issue's body says so.";
  const v = verdictState(show.verdict);
  const verdict =
    v.kind === "holds"
      ? `Your verdict, ${decisionWord(v.verdict.decision)}, with your reason, as a comment signed with your GitHub name.`
      : v.kind === "stale"
        ? "No verdict: the one recorded no longer holds for the brief as it is now."
        : "No verdict: none is recorded yet.";
  return { brief, verdict, caseNote: "The case is never published. It stays in your workspace." };
}

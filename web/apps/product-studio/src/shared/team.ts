/**
 * M20: several product managers sharing one GitHub repository (docs/mach-next/M20_TEAMS_AND_MOVING.md, A3 and A4). The
 * engine decides everything here: which issue keeps a number, whose text was taken, what waits for a choice. This only
 * arranges what it reported into the app's words. No addresses are built: an issue is linked only when the engine gave
 * its address.
 */
import type { NumbersFromGithub, Refresh, SameIdTwice, SameMoment, SharedTextChanged, SharedTextNote, SliceGithub, Status } from "@mach/ui/api";

/* ── A number taken at the same moment ─────────────────────────────────── */

/** The notice on a slice whose number someone else's slice holds: what happened, then the one act. */
export function numberTakenWords(sliceId: string, github: Pick<SliceGithub, "number_taken" | "same_moment">): { title: string; body: string } | null {
  const moment = github.same_moment ?? null;
  if (moment) {
    return {
      title: `Someone else marked ${sliceId} ready at the same moment`,
      body: `${holderWords(moment)} issue #${moment.holder} was made first and keeps the number. Your issue #${moment.issue} was closed and never reached the builders. Your draft is unchanged: give it a new number, then mark it ready again.`,
    };
  }
  if (!github.number_taken) return null;
  return {
    title: `Another slice on GitHub uses ${sliceId}`,
    body: "Your draft is unchanged: give it a new number, then mark it ready.",
  };
}

/** "ada-pm's", or "Another product manager's" when the engine did not name them. */
export function holderWords(moment: SameMoment): string {
  return moment.by ? `${moment.by}'s` : "Another product manager's";
}

/** One line in the list of what waits for the person, for a slice that needs a new number. */
export function numberTakenLine(github: Pick<SliceGithub, "same_moment">): string {
  return github.same_moment
    ? "needs a new number: someone else marked the same number ready at the same moment, and theirs keeps it."
    : "needs a new number, because another slice on GitHub uses it.";
}

/** Whether a refusal's hint asks for a new number, and for what: a slice or an epic. */
export function renumberHint(hint: { kind: string; target: string | null } | null | undefined): { id: string; kind: "slice" | "epic" } | null {
  if (!hint?.target) return null;
  if (hint.kind === "renumber_slice") return { id: hint.target, kind: "slice" };
  if (hint.kind === "renumber_epic") return { id: hint.target, kind: "epic" };
  return null;
}

/* ── Team notices on the project home ─────────────────────────────────── */

export interface TeamNotice {
  key: string;
  text: string;
  /** The issue to link, when the engine gave its address. */
  link: { number: number; url: string | null } | null;
}

/**
 * The calm notices for the project home: each number held twice (the engine's own sentence), then the text MACH took in
 * from someone else in this visit's refresh. Nothing here blocks anything; the act a closed slice needs is the slice's own.
 */
export function teamNotices(status: Status, refresh: Refresh | null): TeamNotice[] {
  const notices: TeamNotice[] = [];
  const clashes: SameIdTwice[] = refresh?.github.same_id_twice ?? status.same_id_twice ?? [];
  for (const clash of clashes) notices.push({ key: `twice-${clash.kind}-${clash.id ?? clash.others.join("-")}`, text: clash.note, link: null });
  for (const note of refresh?.github.text_taken ?? []) {
    const link = note.issue ? { number: note.issue, url: issueUrl(status, note.target) } : null;
    notices.push({ key: `taken-${note.target}`, text: takenWords(note, status), link });
  }
  return notices;
}

function issueUrl(status: Status, target: string): string | null {
  if (target === "project") return status.project?.url ?? null;
  return status.epics.find((e) => e.epic_id === target)?.url ?? null;
}

/**
 * What a refresh's text_taken means, in the engine's own pattern for the same event at "mark ready" (studio.text_words),
 * with the issue linked beside it rather than written into the sentence.
 */
export function takenWords(note: SharedTextNote, status: Status): string {
  if (note.kind === "project") return "The project's name, vision and outcomes on GitHub hold text someone else wrote. MACH took it into your workspace instead of writing yours over it.";
  const title = status.epics.find((e) => e.epic_id === note.target)?.title;
  const named = title ? `${note.target}, “${title}”,` : note.target;
  return `${named} on GitHub holds text someone else wrote. MACH took it into your workspace instead of writing yours over it.`;
}

/* ── Shared text changed on both sides ─────────────────────────────────── */

export type Take = "mine" | "theirs";

export interface VersionField {
  label: string;
  /** One paragraph, or a list. */
  value: string | string[];
}

/** The project's or an epic's text as the side-by-side choice shows it, field by field, whole. */
export function versionFields(kind: SharedTextChanged["kind"], text: SharedTextChanged["theirs"]): VersionField[] {
  if (!text) return [];
  if (kind === "project" && "vision" in text) {
    return [
      { label: "Name", value: text.name },
      { label: "Vision", value: text.vision },
      { label: "Intended outcomes", value: text.outcomes },
    ];
  }
  if ("acceptance_criteria" in text) {
    return [
      { label: "Title", value: text.title },
      { label: "Done when", value: text.acceptance_criteria },
    ];
  }
  return [];
}

/** "the project" or "EPIC-001". */
export function sharedWhat(changed: Pick<SharedTextChanged, "kind" | "target">): string {
  return changed.kind === "project" ? "the project" : changed.target;
}

/** The words of the choice: its heading, what it says, and each confirmation. Theirs is whole; nothing is blended. */
export function sharedTextWords(changed: Pick<SharedTextChanged, "kind" | "target" | "readable">) {
  const what = sharedWhat(changed);
  const parts = changed.kind === "project" ? "name, vision and outcomes" : "title and criteria";
  const nextReady = changed.kind === "project" ? "the next time you mark a slice ready" : "the next time you mark one of its slices ready";
  return {
    heading: `Someone else changed ${what} on GitHub`,
    lead: changed.readable
      ? `Their ${parts} on GitHub differ from yours here, and you changed yours too. Choose which version to go on from: one or the other, whole.`
      : `Their change on GitHub is not in the form MACH writes, so it cannot be shown or taken here. Read it on GitHub. You can keep yours, or ask the person who changed it.`,
    mine: {
      button: "Keep mine",
      title: `Keep your version of ${what}?`,
      description: `Your ${parts} stay as they are. MACH writes them over theirs on GitHub ${nextReady}.`,
      done: `Kept your version of ${what}`,
    },
    theirs: {
      button: "Take theirs",
      title: `Take their version of ${what}?`,
      description: `Their ${parts} replace yours here, whole, and your changes are dropped. Nothing is written to GitHub: it already holds their version.`,
      done: `Took their version of ${what}`,
    },
  };
}

/** This person's own text, from the shared status, in the same shape as theirs. */
export function mineOf(status: Status, changed: Pick<SharedTextChanged, "kind" | "target">): SharedTextChanged["theirs"] {
  if (changed.kind === "project") {
    const p = status.project;
    return p ? { name: p.name, vision: p.vision, outcomes: p.outcomes } : null;
  }
  const epic = status.epics.find((e) => e.epic_id === changed.target);
  return epic ? { title: epic.title, acceptance_criteria: epic.acceptance_criteria } : null;
}

/** Where a choice waits, for the page that shows it (a focus target on Vision). */
export const sharedTextAnchor = (target: string) => `shared-${target}`;

/* ── Marking ready: what happened to the shared text ───────────────────── */

/** `slice.ready`'s shared_text, each with whether it waits for a choice. */
export function sharedTextAfterReady(notes: SharedTextNote[] | undefined): Array<{ key: string; text: string; choose: string | null }> {
  return (notes ?? []).map((note) => ({ key: `${note.target}-${note.taken ? "taken" : "changed"}`, text: note.note ?? "", choose: note.changed ? note.target : null }));
}

/* ── Starting a project ─────────────────────────────────────────────── */

export type ProjectStartNote = { kind: "taken"; issue: number; url: string | null; note: string } | { kind: "not_checked"; note: string };

/** What naming the product leaves to say once the page has moved on: the project taken from GitHub, or GitHub not checked. */
export function projectStartNote(result: { taken_from_github?: number; url?: string | null; github_not_checked?: string; note?: string }): ProjectStartNote | null {
  if (result.taken_from_github) return { kind: "taken", issue: result.taken_from_github, url: result.url ?? null, note: result.note ?? "" };
  if (result.github_not_checked) return { kind: "not_checked", note: result.note ?? result.github_not_checked };
  return null;
}

/* ── Making drafts: numbers not checked against GitHub ─────────────────── */

const NOT_CHECKED = " MACH could not read GitHub before numbering";

/**
 * `prd.apply` and `idea.apply` put the sentence about GitHub's numbers at the end of their note. It is shown on its own,
 * apart from what was made, so it is not lost inside a success message. The words stay the engine's.
 */
export function splitNumbersNote(note: string, numbers: NumbersFromGithub | undefined): { made: string; numbers: string | null } {
  if (!numbers || numbers.checked) return { made: note, numbers: null };
  const at = note.indexOf(NOT_CHECKED);
  if (at < 0) return { made: note, numbers: null };
  return { made: note.slice(0, at), numbers: note.slice(at + 1) };
}

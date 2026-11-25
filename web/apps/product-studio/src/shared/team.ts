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
      body: `${holderWords(moment)} issue #${moment.holder} was made first and keeps the number. Your issue #${moment.issue} was closed and never reached the builders. Your draft is unchanged: mark it ready again, and MACH gives it the next free number.`,
    };
  }
  if (!github.number_taken) return null;
  return {
    title: `Another slice on GitHub uses ${sliceId}`,
    body: "Your draft is unchanged: marking it ready gives it the next free number.",
  };
}

/** "ada-pm's", or "Another product manager's" when the engine did not name them. */
export function holderWords(moment: SameMoment): string {
  return moment.by ? `${moment.by}'s` : "Another product manager's";
}

/** One line in the list of what waits for the person, for a slice that needs a new number. */
export function numberTakenLine(github: Pick<SliceGithub, "same_moment">): string {
  return github.same_moment
    ? "gets a new number when you mark it ready again: someone else marked the same number ready at the same moment, and theirs keeps it."
    : "gets a new number when you mark it ready, because another slice on GitHub uses it.";
}

/* ── Issue numbers in a sentence, linked ───────────────────────────────── */

/** Addresses the engine gave, by issue number. */
export type IssueUrls = Record<string, string | null | undefined>;

/** The addresses of the two issues of a number taken at the same moment: this person's, and the one that keeps it. */
export function momentUrls(moment: SameMoment | null | undefined): IssueUrls {
  if (!moment) return {};
  return { [String(moment.issue)]: moment.issue_url ?? null, [String(moment.holder)]: moment.holder_url ?? null };
}

/** The addresses a refusal's hint gave for the issues it names (several project issues). */
export function hintUrls(hint: { issues?: Array<{ issue: number; url: string | null }> } | null | undefined): IssueUrls {
  return Object.fromEntries((hint?.issues ?? []).map((item) => [String(item.issue), item.url]));
}

export type IssuePart = string | { number: number; url: string };

/**
 * A sentence cut where it names an issue ("#3") that the engine gave an address for, so the issue can be shown linked in
 * place. A number without an address stays plain text: no address is ever built here.
 */
export function issueParts(text: string, urls: IssueUrls): IssuePart[] {
  const parts: IssuePart[] = [];
  let at = 0;
  for (const found of text.matchAll(/#(\d+)\b/g)) {
    const url = urls[found[1] as string];
    if (!url || found.index === undefined) continue;
    if (found.index > at) parts.push(text.slice(at, found.index));
    parts.push({ number: Number(found[1]), url });
    at = found.index + found[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/* ── An epic's number taken at the same moment ─────────────────────────── */

/** The notice on an epic whose number someone else's epic took at the same moment: what happened, then the one act. */
export function epicNumberTakenWords(epicId: string, moment: SameMoment | null | undefined): { title: string; body: string } | null {
  if (!moment) return null;
  return {
    title: `Someone else saved a different epic as ${epicId} at the same moment`,
    body: `Their issue #${moment.holder} was made first and keeps the number. Your issue #${moment.issue} was closed, and none of your slices reached the builders. Your epic is unchanged: mark its slice ready again, and MACH gives the epic the next free number.`,
  };
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
  /** The addresses of the issues the text names, to link them in place. */
  urls: IssueUrls;
  /** Several project issues: the extra ones MACH can close for the person (`project.close-issue`). */
  close: number[];
}

/**
 * The calm notices for the project home: each number held twice (the engine's own sentence), then the text MACH took in
 * from someone else in this visit's refresh. Nothing here blocks anything; the act a closed slice needs is the slice's own.
 */
export function teamNotices(status: Status, refresh: Refresh | null): TeamNotice[] {
  const notices: TeamNotice[] = [];
  const clashes: SameIdTwice[] = refresh?.github.same_id_twice ?? status.same_id_twice ?? [];
  for (const clash of clashes) {
    const close = clash.kind === "project" ? extraProjectIssues(clash.others, status.project?.issue) : [];
    notices.push({ key: `twice-${clash.kind}-${clash.id ?? clash.others.join("-")}`, text: clash.note, link: null, urls: clash.urls ?? {}, close });
  }
  for (const note of refresh?.github.text_taken ?? []) {
    const link = note.issue ? { number: note.issue, url: issueUrl(status, note.target) } : null;
    notices.push({ key: `taken-${note.target}`, text: takenWords(note, status), link, urls: {}, close: [] });
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
      : `Their change on GitHub is not in the form MACH writes, so it cannot be shown or taken here. Read it on GitHub. Keep yours, and MACH writes it over theirs ${nextReady}; theirs stays in the issue's history on GitHub.`,
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

/** `close`: the extra project issues MACH can close for the person (`project.close-issue`), each one click and a confirm. */
export type ProjectStartNote =
  | { kind: "taken"; issue: number; url: string | null; note: string; close: number[] }
  | { kind: "warned"; note: string; close: number[] }
  | { kind: "not_checked"; note: string };

/**
 * Before the product is named: the repository's project already on GitHub, as last read. Said before the person types
 * anything, since naming it takes that project's words instead of theirs. Null when GitHub held none or was not read.
 */
export function projectOnGithubWords(found: Status["project_on_github"]): { title: string; body: string } | null {
  if (!found) return null;
  if (found.readable && found.name) {
    return {
      title: `This repository already has a project: ${found.name}`,
      body: `Its issue on GitHub is #${found.issue}. When you name the product, MACH takes its name, vision and outcomes from GitHub, and what you type is not used. A repository holds one project.`,
    };
  }
  return {
    title: "This repository already has a project on GitHub",
    body: `Its issue is #${found.issue}, but its text is not in the form MACH writes, so MACH cannot take its words. When you name the product, your own words define the project, and the first slice you mark ready writes them to #${found.issue}. What it holds now stays in its history on GitHub.`,
  };
}

/**
 * What naming the product leaves to say once the page has moved on: the project taken from GitHub, what MACH warned
 * about (several project issues, one it cannot read), or GitHub not checked. Each extra project issue the engine named
 * can be closed from the notice.
 */
export function projectStartNote(result: {
  taken_from_github?: number;
  url?: string | null;
  github_not_checked?: string;
  note?: string;
  warned?: string[];
  extra_issues?: number[];
}): ProjectStartNote | null {
  const close = (result.extra_issues ?? []).filter((n) => Number.isInteger(n) && n > 0 && n !== result.taken_from_github);
  if (result.taken_from_github) return { kind: "taken", issue: result.taken_from_github, url: result.url ?? null, note: result.note ?? "", close };
  if (result.warned?.length) return { kind: "warned", note: result.note ?? result.warned.join(" "), close };
  if (result.github_not_checked) return { kind: "not_checked", note: result.note ?? result.github_not_checked };
  return null;
}

/**
 * The project issues to offer closing when the repository has several: every one but the issue this project follows
 * (the status's own, else the oldest, which is the one MACH uses).
 */
export function extraProjectIssues(issues: number[], following: number | null | undefined): number[] {
  const sorted = [...new Set(issues.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (sorted.length < 2) return [];
  const kept = following && sorted.includes(following) ? following : sorted[0];
  return sorted.filter((n) => n !== kept);
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

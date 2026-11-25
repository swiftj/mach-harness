/**
 * What the Technical needs screen shows, from the engine's answers alone (`need.list`, the acts' results). Pure, so it
 * is unit-tested against the real fixtures (test/needs-technical.test.mjs). It maps the flags the engine reported to a
 * look and builds the arguments of each act; it decides no product rule, and every act can still be refused in the
 * engine's words. It never names, judges or offers anything about an engineer's decision: `adrs_behind` is shown as
 * the engine reports it, read only.
 */
import type { AdrBehind, ApiErrorHint, NeedKind, NeedList, NeedsPublishResult, TechnicalNeed } from "@mach/ui/api";

/** The six kinds in the engine's order (issue_rules.NEED_KINDS), repeated here so this file stays pure. */
export const kindOrder: readonly NeedKind[] = ["people", "data", "connections", "never", "priority", "given"];

/** Each kind's name on the page, in the product manager's terms. */
export const kindNames: Record<NeedKind, string> = {
  people: "Who uses it",
  data: "What it keeps",
  connections: "What it works with",
  never: "What must never happen",
  priority: "What wins in a conflict",
  given: "Already decided elsewhere",
};

/**
 * The design's question for each kind (M17_DESIGN.md part A), used only when the engine's `kinds` leaves one out. The
 * engine's own wording is preferred whenever it is there.
 */
export const designQuestions: Record<NeedKind, string> = {
  people: "Who uses it, how many, from where, and at what busiest moment?",
  data: "What does it keep, how sensitive is that, and how long must it be kept?",
  connections: "What must it work with that already exists?",
  never: "What must never happen, and what does it cost if it does?",
  priority: "When two qualities conflict (speed, cost, safety, ease of change), which wins?",
  given: "What is already decided outside this product?",
};

/** How far a kind is answered, from the engine's lists. */
export type KindState = "answered" | "nothing-to-say" | "unanswered";

/** The word, tone and shape of each kind's state, so it reads in greyscale (style guide 8.2). */
export const kindLook: Record<KindState, { word: string; tone: "neutral" | "success"; glyph: "check" | "minus" | "dashed" }> = {
  answered: { word: "Answered", tone: "success", glyph: "check" },
  "nothing-to-say": { word: "Nothing to say", tone: "neutral", glyph: "minus" },
  unanswered: { word: "Not answered yet", tone: "neutral", glyph: "dashed" },
};

export interface NeedView extends TechnicalNeed {
  /** The engineers' decisions written for an older revision of this need, as the engine listed them. */
  behind: AdrBehind[];
}

export interface KindView {
  kind: NeedKind;
  name: string;
  question: string;
  state: KindState;
  /** Active needs of this kind, in the engine's order. */
  needs: NeedView[];
}

/** The decisions the engine flagged as written under an older revision of one need. */
export function behindFor(list: Pick<NeedList, "adrs_behind">, needId: string): AdrBehind[] {
  return list.adrs_behind.filter((row) => row.need_id === needId);
}

/** The six kinds in their fixed order, each with its question (the engine's), its needs and its state. */
export function kindViews(list: Pick<NeedList, "needs" | "kinds" | "nothing_to_say" | "adrs_behind">): KindView[] {
  return kindOrder.map((kind) => {
    const row = list.kinds.find((k) => k.kind === kind);
    const ids = row?.needs ?? list.needs.filter((n) => n.kind === kind && n.status === "active").map((n) => n.need_id);
    const needs = ids
      .map((id) => list.needs.find((n) => n.need_id === id))
      .filter((n): n is TechnicalNeed => Boolean(n && n.status === "active"))
      .map((n) => ({ ...n, behind: behindFor(list, n.need_id) }));
    const nothing = row ? row.nothing_to_say : list.nothing_to_say.includes(kind);
    const state: KindState = needs.length ? "answered" : nothing ? "nothing-to-say" : "unanswered";
    return { kind, name: kindNames[kind], question: row?.question?.trim() || designQuestions[kind], state, needs };
  });
}

/** Retired needs, out of the way but listed, in ID order. */
export function retiredNeeds(list: Pick<NeedList, "needs">): TechnicalNeed[] {
  return list.needs.filter((n) => n.status !== "active").sort((a, b) => a.need_id.localeCompare(b.need_id, "en", { numeric: true }));
}

/** True for a project with nothing said yet: no need, active or retired, and no kind with nothing to say. */
export function isEmpty(list: Pick<NeedList, "needs" | "nothing_to_say">): boolean {
  return list.needs.length === 0 && list.nothing_to_say.length === 0;
}

/** "1 of 6 kinds answered"; counts a kind with nothing to say as answered, as the engine does. */
export function answeredWords(list: Pick<NeedList, "unanswered">): string {
  const done = kindOrder.length - list.unanswered.length;
  return `${done} of ${kindOrder.length} kinds answered`;
}

/** "4 needs, 1 retired"; "1 need". */
export function countWords(active: number, retired: number): string {
  const live = `${active} ${active === 1 ? "need" : "needs"}`;
  return retired ? `${live}, ${retired} retired` : live;
}

/* ---------------------------------------------------------------- publishing */

/** Where the needs stand with the engineer, from the engine's flags, the most pressing first. */
export type PublishState = "none" | "newer-elsewhere" | "unfinished" | "changed-on-github" | "never-published" | "unpublished" | "published";

export function publishState(list: Pick<NeedList, "needs" | "unpublished_changes" | "published">): PublishState {
  const p = list.published;
  if (p.newer_elsewhere) return "newer-elsewhere";
  if (p.unfinished) return "unfinished";
  if (list.needs.length === 0) return "none";
  if (p.changed_on_github) return "changed-on-github";
  if (p.saved === null) return "never-published";
  if (list.unpublished_changes) return "unpublished";
  return "published";
}

export const publishLook: Record<PublishState, { word: string; tone: "neutral" | "success" | "warning" | "info"; glyph: "dashed" | "check" | "pen" | "alert" | "branch" }> = {
  none: { word: "Nothing to publish yet", tone: "neutral", glyph: "dashed" },
  "never-published": { word: "Not published yet", tone: "neutral", glyph: "dashed" },
  unpublished: { word: "Changes not published", tone: "warning", glyph: "pen" },
  published: { word: "Published", tone: "success", glyph: "check" },
  unfinished: { word: "Publishing stopped part way", tone: "warning", glyph: "alert" },
  "changed-on-github": { word: "Changed on GitHub after approval", tone: "warning", glyph: "alert" },
  "newer-elsewhere": { word: "A newer version is on GitHub", tone: "info", glyph: "branch" },
};

/** Whether the page offers the publish act in this state. The engine still decides. */
export function publishOffered(state: PublishState): boolean {
  return state !== "none" && state !== "published";
}

/** The publish act's name in this state; the dialog's confirming button and the toast use the same words. */
export function publishLabel(state: PublishState): string {
  return state === "unfinished" ? "Finish publishing" : state === "unpublished" ? "Publish the changes" : "Publish the needs";
}

/** What is not published, in one or two sentences, from the engine's flags and counts only. */
export function unpublishedWords(state: PublishState, list: Pick<NeedList, "active" | "retired" | "published" | "unanswered">): string {
  const here = countWords(list.active.length, list.retired.length);
  const version = list.published.revision;
  switch (state) {
    case "none":
      return "There is nothing to publish yet. Add a need, or answer a question in the conversation.";
    case "never-published":
      return `The engineer does not have your needs yet. Publishing gives them all of them: ${here}.`;
    case "unpublished":
      return version !== null
        ? `You changed the needs since version ${version}, and the engineer does not have the changes. Publishing gives them all of them: ${here}.`
        : `You have changes the engineer does not have. Publishing gives them all of them: ${here}.`;
    case "published":
      return `The engineer has exactly the needs listed here${version !== null ? `, as version ${version}` : ""}.`;
    case "unfinished":
      return "Publishing to GitHub stopped part way. Publish again to finish; nothing is made twice.";
    case "changed-on-github":
      return "The needs on the project's issue were edited after they were approved, so the engineer cannot rely on them. Publish them again to save a version you approved.";
    case "newer-elsewhere":
      return "Someone else published a newer version. Publishing yours replaces it, and theirs is kept; or take theirs instead.";
  }
}

/** The kinds not answered yet, by name, for the publish dialog: they are published as not answered. */
export function unansweredNames(list: Pick<NeedList, "unanswered">): string[] {
  return kindOrder.filter((kind) => list.unanswered.includes(kind)).map((kind) => kindNames[kind]);
}

/** A refusal that a choice between versions resolves, which this page offers in place. */
export function isNeedsReconcileHint(hint: ApiErrorHint | null | undefined): boolean {
  return hint?.kind === "reconcile" && hint.target === "needs";
}

export type PublishOutcome = {
  revision: number;
  /** Set when it went to the project's issue on GitHub. */
  github: { issue: number; url: string; approvedBy: string } | null;
  /** The folder is always written. */
  folder: string;
  whyFolder: string | null;
  /** What the product manager does next, in the engine's words. */
  waysOn: string[];
  note: string;
};

/** What a publish did, for the dialog's result and the page after it. */
export function publishOutcome(result: NeedsPublishResult): PublishOutcome {
  return {
    revision: result.revision,
    github: result.saved_to === "github" ? { issue: result.issue, url: result.url, approvedBy: result.approved_by } : null,
    folder: result.folder,
    whyFolder: result.saved_to === "folder" ? result.why_folder || null : null,
    waysOn: result.ways_on,
    note: result.note,
  };
}

/* ---------------------------------------------------------------- the acts' arguments */

export interface NeedDraft {
  statement: string;
  why: string;
  /** A given only. */
  said_by: string;
  said_on: string;
}

/** The host's bounds (issue_rules.NEED_LIMITS, SAID_BY_LIMIT): the fields stop there rather than be refused. */
export const limits = { statement: 400, why: 300, said_by: 100 } as const;

/** A need's statement and why are one line each: a line break typed or pasted becomes a space. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** Whether a kind asks who said it and when. Only a given does. */
export function asksWho(kind: NeedKind): boolean {
  return kind === "given";
}

/** Fields left empty (or a date not in the form the engine takes), so the form asks before anything is sent. */
export function emptyFields(kind: NeedKind, draft: NeedDraft): Array<keyof NeedDraft> {
  const keys: Array<keyof NeedDraft> = asksWho(kind) ? ["statement", "why", "said_by", "said_on"] : ["statement", "why"];
  return keys.filter((key) => (key === "said_on" ? !/^\d{4}-\d{2}-\d{2}$/.test(draft.said_on.trim()) : draft[key].trim() === ""));
}

export type AddArgs =
  | { kind: Exclude<NeedKind, "given">; statement: string; why: string }
  | { kind: "given"; statement: string; why: string; said_by: string; said_on: string };
export type SetArgs = { need_id: string; statement?: string; why?: string; said_by?: string; said_on?: string };

/** need.add: the statement and why trimmed; a given also says who said it and when, and no other kind does. */
export function addArgs(kind: NeedKind, draft: NeedDraft): AddArgs {
  const statement = draft.statement.trim();
  const why = draft.why.trim();
  if (kind === "given") return { kind, statement, why, said_by: draft.said_by.trim(), said_on: draft.said_on.trim() };
  return { kind, statement, why };
}

/** need.set with only what changed, or null when nothing did. Who and when are sent only for a given. */
export function setArgs(need: TechnicalNeed, draft: NeedDraft): SetArgs | null {
  const args: SetArgs = { need_id: need.need_id };
  const keys: Array<keyof NeedDraft> = asksWho(need.kind) ? ["statement", "why", "said_by", "said_on"] : ["statement", "why"];
  const changed = keys.filter((key) => draft[key].trim() !== (need[key] ?? ""));
  if (!changed.length) return null;
  for (const key of changed) args[key] = draft[key].trim();
  return args;
}

/** The draft a form starts from: empty for a new need, the need's own words for a change. */
export function draftOf(need: TechnicalNeed | null): NeedDraft {
  return { statement: need?.statement ?? "", why: need?.why ?? "", said_by: need?.said_by ?? "", said_on: need?.said_on ?? "" };
}

/**
 * Where a refusal of add or set is shown: beside the statement when the statement was sent (the engine's checks of a
 * need, such as a technology named, are checks of its statement), otherwise above the form. Shown as written.
 */
export function refusalPlace(args: AddArgs | SetArgs): "statement" | "form" {
  return typeof args.statement === "string" ? "statement" : "form";
}

/** The other way to say it when a statement is refused: a kind other than a given may be recorded as one instead. */
export function givenOffered(mode: "add" | "change", kind: NeedKind, refusedAtStatement: boolean): boolean {
  return mode === "add" && kind !== "given" && refusedAtStatement;
}

/** A given's date as the person reads it ("2 Nov 2026"); the engine's own text when it is not a date. */
export function saidOnWords(saidOn: string | undefined, locale?: string): string | null {
  if (!saidOn) return null;
  const found = saidOn.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!found) return saidOn;
  const date = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])));
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

/** "Said by Jo Bloggs, CTO, on 2 Nov 2026." for a given; null for any other need. */
export function saidWords(need: Pick<TechnicalNeed, "kind" | "said_by" | "said_on">, locale?: string): string | null {
  if (need.kind !== "given") return null;
  const who = need.said_by?.trim() || "someone not recorded";
  const when = saidOnWords(need.said_on, locale);
  return when ? `Said by ${who}, on ${when}.` : `Said by ${who}, date not recorded.`;
}

/** One decision the engineers recorded for an older revision of a need, in words. Read only: nothing is reopened. */
export function behindWords(row: AdrBehind): string {
  return `Recorded for revision ${row.served_revision} of this need. It is at revision ${row.revision_now} now; an engineer decides whether the change matters.`;
}

/** The terminal command that talks through the needs, from the host's own (`capabilities.needs_command`), or null. */
export function needsCommand(command: string | null | undefined): string | null {
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

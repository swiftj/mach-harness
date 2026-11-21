/**
 * What the Product principles screen shows, from the engine's answers alone. Pure, so it is
 * unit-tested against the real fixtures (test/principles-model.test.mjs). It maps the flags the
 * engine reported to a look and builds the arguments of an act; it decides no product rule, and
 * every act can still be refused in the engine's words.
 */
import type { ApiErrorHint, Principle, PrincipleList, PrinciplesPublishResult, StatusSliceRow } from "@mach/ui/api";

/** Where the principles stand with the builders, from the engine's flags, the most pressing first. */
export type PublishState =
  /** No principles at all. */
  | "none"
  /** Someone else published a newer version on GitHub while this workspace has unpublished changes. */
  | "newer-elsewhere"
  /** A publish to GitHub stopped part way. */
  | "unfinished"
  /** The section on the project's issue no longer matches what was approved. */
  | "changed-on-github"
  /** Principles exist here and were never published. */
  | "never-published"
  /** Published once, changed here since. */
  | "unpublished"
  /** What is here is what was published. */
  | "published";

export function publishState(list: Pick<PrincipleList, "principles" | "unpublished_changes" | "published">): PublishState {
  const p = list.published;
  if (p.newer_elsewhere) return "newer-elsewhere";
  if (p.unfinished) return "unfinished";
  if (list.principles.length === 0) return "none";
  if (p.changed_on_github) return "changed-on-github";
  if (p.saved === null) return "never-published";
  if (list.unpublished_changes) return "unpublished";
  return "published";
}

/** The word, tone and shape of each state, so it reads in greyscale (style guide 8.2). */
export const stateLook: Record<PublishState, { word: string; tone: "neutral" | "success" | "warning" | "info"; glyph: "dashed" | "check" | "pen" | "alert" | "branch" }> = {
  none: { word: "Nothing to publish yet", tone: "neutral", glyph: "dashed" },
  "never-published": { word: "Not published yet", tone: "neutral", glyph: "dashed" },
  unpublished: { word: "Changes not published", tone: "warning", glyph: "pen" },
  published: { word: "Published", tone: "success", glyph: "check" },
  unfinished: { word: "Publishing stopped part way", tone: "warning", glyph: "alert" },
  "changed-on-github": { word: "Changed on GitHub after approval", tone: "warning", glyph: "alert" },
  "newer-elsewhere": { word: "A newer version is on GitHub", tone: "info", glyph: "branch" },
};

/** Whether the screen offers "Publish" as its main act in this state. The engine still decides. */
export function publishOffered(state: PublishState): boolean {
  return state !== "none" && state !== "published";
}

/** Principles in force first, then retired ones, each in ID order. */
export function splitPrinciples(principles: Principle[]): { active: Principle[]; retired: Principle[] } {
  const sorted = [...principles].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return { active: sorted.filter((p) => p.status === "active"), retired: sorted.filter((p) => p.status !== "active") };
}

export interface PrincipleDraft {
  title: string;
  statement: string;
  reason: string;
}

/** A principle is one line each: a line break typed or pasted becomes a space. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** Fields left empty, so the form can ask for them before anything is sent. */
export function emptyFields(draft: PrincipleDraft): Array<keyof PrincipleDraft> {
  return (["title", "statement", "reason"] as const).filter((key) => draft[key].trim() === "");
}

export type AddArgs = { title: string; statement: string; reason: string };
export type SetArgs = { principle_id: string; title?: string; statement?: string; reason?: string };

export function addArgs(draft: PrincipleDraft): AddArgs {
  return { title: draft.title.trim(), statement: draft.statement.trim(), reason: draft.reason.trim() };
}

/** principle.set with only what changed, or null when nothing did. */
export function setArgs(original: Principle, draft: PrincipleDraft): SetArgs | null {
  const args: SetArgs = { principle_id: original.id };
  const changed = (["title", "statement", "reason"] as const).filter((key) => draft[key].trim() !== original[key]);
  if (!changed.length) return null;
  for (const key of changed) args[key] = draft[key].trim();
  return args;
}

/**
 * Where a refusal of add or set is shown: beside the statement when the statement was sent (the
 * engine's checks of a principle are checks of its statement), otherwise above the form. The
 * message is shown as written either way; nothing is read out of it.
 */
export function refusalPlace(args: AddArgs | SetArgs): "statement" | "form" {
  return typeof args.statement === "string" ? "statement" : "form";
}

/** A refusal that a choice between versions resolves, which this screen offers in place. */
export function isPrinciplesReconcileHint(hint: ApiErrorHint | null | undefined): boolean {
  return hint?.kind === "reconcile" && hint.target === "principles";
}

export interface SliceToCheck {
  id: string;
  title: string | null;
  /** Principles it answered under an older revision. */
  older: string[];
  /** Principles in force it does not answer. */
  unanswered: string[];
  /** The engine's sentence about it, as written. */
  note: string | null;
}

/** The slices the engine listed as answered under older principles, with what status says of each. */
export function slicesToCheck(list: Pick<PrincipleList, "slices_answered_under_older">, slices: Pick<StatusSliceRow, "slice_id" | "title" | "principles">[] | null | undefined): SliceToCheck[] {
  return list.slices_answered_under_older.map((id) => {
    const row = slices?.find((s) => s.slice_id === id);
    const flag = row?.principles;
    return { id, title: row?.title ?? null, older: flag?.older ?? [], unanswered: flag?.unanswered ?? [], note: flag?.note ?? null };
  });
}

export type PublishOutcome =
  | { where: "github"; revision: number; issue: number; url: string; approvedBy: string; note: string }
  | { where: "folder"; revision: number; folder: string; whyFolder: string | null; waysOn: string[]; note: string };

/** What a publish did, for the dialog's result. The engine's folder answer also says why it was not GitHub. */
export function publishOutcome(result: PrinciplesPublishResult): PublishOutcome {
  if (result.saved_to === "github") {
    return { where: "github", revision: result.revision, issue: result.issue, url: result.url, approvedBy: result.approved_by, note: result.note };
  }
  return { where: "folder", revision: result.revision, folder: result.folder, whyFolder: result.why_folder || null, waysOn: result.ways_on, note: result.note };
}

/** "1 in force, 1 retired"; "2 in force". */
export function countWords(active: number, retired: number): string {
  const inForce = `${active} in force`;
  return retired ? `${inForce}, ${retired} retired` : inForce;
}

/* ---------------------------------------------------------------- the screen's parts (M16 layout) */

/** The words of the publish act in this state, as the screen has always named it. */
export function publishLabel(state: PublishState): string {
  return state === "unfinished" ? "Finish publishing" : state === "unpublished" ? "Publish the changes" : "Publish the principles";
}

/** One line for the "In force" part: how many principles every slice must keep. */
export function inForceSummary(active: number): string {
  if (!active) return "None in force. Add one to give every slice a rule to keep.";
  return `${active === 1 ? "1 principle" : `${active} principles`} every slice must keep.`;
}

/** One line for the "Slices to check" part, naming the slice when there is only one. */
export function toCheckSummary(slices: Pick<SliceToCheck, "id">[]): string {
  const only = slices.length === 1 ? slices[0] : undefined;
  if (only) return `${only.id} answers an older version of a principle, or leaves one in force unanswered.`;
  return `${slices.length} slices answer an older version of a principle, or leave one in force unanswered.`;
}

/** One line for the "Retired" part: which principles slices no longer answer. */
export function retiredSummary(ids: string[]): string {
  return `${ids.join(", ")}: slices no longer answer ${ids.length === 1 ? "it" : "them"}.`;
}

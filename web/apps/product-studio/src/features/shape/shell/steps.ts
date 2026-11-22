/**
 * Shape's six steps and where an idea's next step leads (shell-owned; M16 app foundation). Pure: the engine decides
 * every stage, verdict and next step (`status.ideas.ideas[].next`); this only maps what it reported to a page and a
 * few words. Unit-tested in test/shape-steps.test.mjs.
 */
import type { IdeaNextKind, IdeaRow, ShapeRoute, Status } from "@mach/ui/api";

export type ShapeStep = "ideas" | "explore" | "brief" | "case" | "route" | "look-back";

export const shapeSteps: ReadonlyArray<{ step: ShapeStep; name: string }> = [
  { step: "ideas", name: "Ideas" },
  { step: "explore", name: "Explore" },
  { step: "brief", name: "The brief" },
  { step: "case", name: "The case" },
  { step: "route", name: "Size and route" },
  { step: "look-back", name: "Look back" },
];

export const stepName = (step: ShapeStep): string => shapeSteps.find((s) => s.step === step)?.name ?? "";

/** The board, and one idea's page for a step. */
export const shapeHome = "/shape";
export const changePath = "/shape/change";
export const ideaPath = (ideaId: string, step?: Exclude<ShapeStep, "ideas">): string =>
  step ? `/shape/ideas/${encodeURIComponent(ideaId)}/${step}` : `/shape/ideas/${encodeURIComponent(ideaId)}`;

/** The step an idea's page path names, or null. */
export function stepOfPath(path: string): { ideaId: string; step: Exclude<ShapeStep, "ideas"> } | null {
  const found = path.match(/^\/shape\/ideas\/(IDEA-\d{3,})\/(explore|brief|case|route|look-back)$/);
  return found ? { ideaId: found[1] as string, step: found[2] as Exclude<ShapeStep, "ideas"> } : null;
}

/**
 * Which step holds the engine's next step for an idea. Writing the brief happens in the conversation, so it is
 * Explore's; publishing and renumbering sit with the verdict, which is what is published. A kind the app does not know
 * goes by the stage.
 */
export function stepForNext(kind: IdeaNextKind, stage: IdeaRow["stage"]): Exclude<ShapeStep, "ideas"> {
  switch (kind) {
    case "explore":
    case "write_brief":
      return "explore";
    case "check_brief":
      return "brief";
    case "record_verdict":
    case "publish":
    case "renumber":
      return "case";
    case "size":
    case "map":
    case "settle":
    case "apply":
      return "route";
    case "look_back":
      return "look-back";
  }
  switch (stage) {
    case "new":
    case "exploring":
      return "explore";
    case "brief":
      return "brief";
    case "decided":
      return "case";
    default:
      return kind === "none" ? "look-back" : "route";
  }
}

/** Where an idea's next step is, as a path. */
export const nextPathOf = (row: Pick<IdeaRow, "idea_id" | "stage" | "next">): string => ideaPath(row.idea_id, stepForNext(row.next.kind, row.stage));

const routeWords: Record<ShapeRoute, string> = { "small-change": "A small change", "one-slice": "One slice", epic: "An epic", "several-epics": "Several epics" };
const decisionWords: Record<string, string> = { go: "Go", "not-now": "Not now", no: "No" };

export const verdictWords = (decision: string): string => decisionWords[decision] ?? decision;

/**
 * The few words under each step of the stepper, from the idea's row only (what the engine reported). Null where it
 * reported nothing to say.
 */
export function stepCaption(step: ShapeStep, row: IdeaRow, ideasOnBoard: number): string | null {
  switch (step) {
    case "ideas":
      return `${ideasOnBoard} on the board`;
    case "explore":
      return row.stage === "new" || row.stage === "exploring" ? row.stage_words : null;
    case "brief":
      if (!row.has_brief) return "Not written yet";
      if (!row.brief_checked) return "Not checked yet";
      return row.brief_passes ? "Passes its check" : "Does not pass yet";
    case "case":
      if (row.verdict) return row.verdict.stale ? "Verdict no longer holds" : verdictWords(row.verdict.decision);
      return row.has_case ? "No verdict yet" : "Not written yet";
    case "route":
      return row.route ? (routeWords[row.route] ?? row.route) : "Not sized yet";
    case "look-back":
      return row.next.kind === "look_back" ? "Ready to look back" : row.stage === "shaped" ? "After a slice ships" : null;
  }
}

/** The first idea on the board with something to do, in the engine's order, or null. */
export function firstWithANextStep(ideas: readonly IdeaRow[]): IdeaRow | null {
  return ideas.find((row) => row.next.kind !== "none") ?? null;
}

/**
 * Shape's steps in the top bar's breadcrumb: Shape, then the idea's title and the step, or "Change what exists".
 * Null for any page outside Shape, so the layout's own breadcrumb runs as before.
 */
export function shapeBreadcrumb(path: string, status: Pick<Status, "ideas"> | null): string[] | null {
  if (path === "/shape") return ["Shape"];
  if (path === "/shape/change") return ["Shape", "Change what exists"];
  const page = stepOfPath(path);
  const bare = path.match(/^\/shape\/ideas\/(IDEA-\d{3,})$/);
  const ideaId = page?.ideaId ?? bare?.[1];
  if (!ideaId) return path.startsWith("/shape/") ? ["Shape"] : null;
  const title = status?.ideas?.ideas.find((row) => row.idea_id === ideaId)?.title ?? ideaId;
  return page ? ["Shape", title, stepName(page.step)] : ["Shape", title];
}

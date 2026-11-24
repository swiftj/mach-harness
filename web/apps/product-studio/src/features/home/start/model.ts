/**
 * Starting a project from nothing (M19): the ways the start screen offers, where a way already started stands, and which
 * step a way that needs the project is at. Pure: every state is what the engine reported (`status`, `prd.status`,
 * `request.list`); this only maps it to a few words and a place in the app. Unit-tested in test/start-model.test.mjs.
 */
import type { IdeaRow, PrdStatus, PrdSummary, RequestItem, Status } from "@mach/ui/api";
import { nextPathOf } from "../../shape/shell/steps.ts";

export type WayId = "describe" | "prd" | "idea" | "request";

export interface Way {
  id: WayId;
  /** What the person chooses, as a short sentence in their words. */
  title: string;
  /** What happens, in plain short sentences. */
  happens: string;
  /** What they need to have, read after "You need ". */
  needs: string;
  /** The button that starts it. */
  action: string;
}

/**
 * Every way to start, in the order the screen lists them. A request is offered only when one is waiting (see
 * `requestsToStartFrom`). Starting from a teammate's project on GitHub is not one: MACH cannot yet bring a project in from
 * GitHub, so it is not offered.
 */
export const ways: readonly Way[] = [
  {
    id: "describe",
    title: "Describe the product yourself",
    happens: "You write its name, a one-sentence vision and the outcomes people should get. Then you add its epics and define one slice at a time.",
    needs: "only what you already know about the product.",
    action: "Describe the product",
  },
  {
    id: "prd",
    title: "Start from a PRD",
    happens:
      "MACH reads the document and proposes epics and thin slices, each resting on the lines it cites. You settle what it leaves out, name the product, and make the drafts.",
    needs: "one Markdown or plain-text file. Export Word, PDF or Google Docs to one of those first.",
    action: "Choose the file",
  },
  {
    id: "idea",
    title: "Shape an idea first",
    happens:
      "Explore the idea in a conversation, write its brief and make the case before any epic exists. You decide whether it is worth building, and name the product when you turn it into work.",
    needs: "a few words for the idea.",
    action: "Add the idea",
  },
  {
    id: "request",
    title: "Start from a request",
    happens: "Someone filed it on GitHub. You name the product, add the epic it belongs to, and pick it up as a draft slice.",
    needs: "nothing more: the request is already here.",
    action: "Start from it",
  },
];

export const wayById = (id: WayId): Way => ways.find((w) => w.id === id) as Way;

/** The requests a project can start from: counted (labelled by someone with write access) and not picked up here. */
export function requestsToStartFrom(items: readonly RequestItem[] | null | undefined): RequestItem[] {
  return (items ?? []).filter((item) => item.state === "accepted" && !item.picked_up_here && !item.idea_template);
}

/* ── Where a way already started stands ─────────────────────────────── */

export interface Started {
  kind: "prd" | "idea";
  id: string;
  /** The PRD's file name or the idea's title: the person's own words or file. */
  name: string;
  /** Where it stands, in one sentence. */
  stands: string;
  /** The page that carries on, and the button that goes there. */
  to: string;
  action: string;
}

/** Where a PRD stands before any drafts are made from it, from the engine's summary only. */
export function prdStands(prd: PrdSummary): string {
  if (!prd.document_matches) return "The copy in your workspace no longer matches what was imported. Import the document again.";
  if (!prd.mapped) return "Imported. Next, MACH proposes its map of epics and thin slices.";
  const left = prd.not_covered?.length ?? 0;
  if (left > 0) return `Its map is recorded. ${left === 1 ? "1 section" : `${left} sections`} no slice covers still ${left === 1 ? "needs" : "need"} your word.`;
  return "Its map is recorded and settled. Next, name the product and make the drafts.";
}

/**
 * The ways already started in a project that has no definition yet: each PRD nothing has been made from, then each idea
 * not yet shaped into work, in the engine's order. Empty when nothing was started.
 */
export function startedWays(status: Pick<Status, "prds" | "ideas">): Started[] {
  const prds: Started[] = (status.prds ?? [])
    .filter((prd) => !(prd.applied ?? []).length)
    .map((prd) => ({ kind: "prd", id: prd.prd_id, name: prd.name, stands: prdStands(prd), to: `/prds/${prd.prd_id}`, action: `Continue with ${prd.prd_id}` }));
  const ideas: Started[] = (status.ideas?.ideas ?? [])
    .filter((row: IdeaRow) => row.stage !== "shaped")
    .map((row) => ({
      kind: "idea",
      id: row.idea_id,
      name: row.title,
      stands: row.next.kind === "none" ? row.stage_words : row.next.sentence,
      to: nextPathOf(row),
      action: `Continue with ${row.idea_id}`,
    }));
  return [...prds, ...ideas];
}

/* ── A way that needs the project ────────────────────────────────────── */

/**
 * Whether the PRD page should ask the person to name the product before making the drafts: the map is recorded, every
 * section is settled (the engine's `can_apply`), nothing was made yet, and there is no project. The engine refuses
 * `prd apply` without a project ("No project yet"), so the step comes first, on the same page.
 */
export function prdNeedsTheProduct(data: Pick<PrdStatus, "map" | "can_apply">, project: Status["project"] | undefined): boolean {
  return Boolean(data.map && !data.map.applied && data.can_apply && !project);
}

export type RequestStep = "name" | "epic" | "pick";

/** The step the way from a request is at: name the product, add the epic it belongs to, then pick it up. */
export function requestStep(status: Pick<Status, "project" | "epics">): RequestStep {
  if (!status.project) return "name";
  if (!status.epics.some((epic) => epic.status !== "deferred")) return "epic";
  return "pick";
}

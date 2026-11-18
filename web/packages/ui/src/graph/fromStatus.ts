import type { EpicStatus, ProjectStatus, SliceStateLabel, SliceStatus, Status, StatusSliceRow } from "../api/types";
import { builderStates, epicStates, githubMarks, githubMarksOf, sliceStates } from "../lifecycle/states";
import type { GraphState, MachEdge, MachNode } from "./types";

/** Short words for a node's footer; the full wording is in the node's accessible name and sheet. */
const attentionWords = { changed_on_github: "Changed on GitHub", newer_elsewhere: "Newer version elsewhere", number_taken: "Number taken", unfinished: "Saving did not finish" };

const fromSlice: Record<SliceStatus, GraphState> = {
  draft: "proposed",
  interviewing: "interviewing",
  ready_for_approval: "ready",
  approved_for_engineering: "approved",
  superseded: "superseded",
};

const fromBuilders: Record<SliceStateLabel, GraphState> = {
  "mach:ready": "ready_to_build",
  "mach:building": "building",
  "mach:question": "question",
  "mach:shipped": "shipped",
};

/** An epic is a container, never approved: open reads as the open ring, set aside as faded. */
const fromEpic: Record<EpicStatus, GraphState> = {
  open: "proposed",
  deferred: "superseded",
};

const fromProject: Record<ProjectStatus, GraphState> = { draft: "proposed", active: "approved", archived: "superseded" };

export interface ProductGraphInput {
  status: Status;
  /** Work-order dependencies by slice ID. Defaults to the status rows' own `dependencies`. */
  dependencies?: Record<string, string[]>;
}

/**
 * The visual state of a slice on the graph. Presentation only: it reads what the engine reported
 * (the slice's status, and the state it read from the slice's issue) and never decides anything.
 */
export function sliceGraphState(row: StatusSliceRow): GraphState {
  const base = fromSlice[row.status];
  if (base !== "approved" || !row.github.state_label) return base;
  return fromBuilders[row.github.state_label];
}

/** The first thing the engine reports as needing the PM on this slice's issue, in a footer's words. */
function attentionOf(row: StatusSliceRow): string | undefined {
  const mark = githubMarksOf(row.github).find((m) => m !== "folder");
  return mark ? attentionWords[mark] : undefined;
}

/** Builds graph nodes and edges from the engine's `status`. No positions: run layoutGraph. */
export function productGraphFromStatus({ status, dependencies }: ProductGraphInput): { nodes: MachNode[]; edges: MachEdge[] } {
  const needs = dependencies ?? Object.fromEntries(status.slices.filter((s) => s.dependencies.length).map((s) => [s.slice_id, s.dependencies]));
  const nodes: MachNode[] = [];
  const edges: MachEdge[] = [];
  const project = status.project;
  const rootId = project ? `project:${project.project_id}` : null;

  if (project && rootId) {
    nodes.push({
      id: rootId,
      type: "mach",
      position: { x: 0, y: 0 },
      ariaLabel: `Project ${project.name}, ${project.status}`,
      data: {
        kind: "product",
        artifactId: project.project_id,
        title: project.name,
        state: fromProject[project.status],
        stateLabel: project.status === "draft" ? "Draft" : project.status === "active" ? "Active" : "Archived",
        meta: `${project.outcomes.length} ${project.outcomes.length === 1 ? "outcome" : "outcomes"}`,
      },
    });
  }

  for (const epic of status.epics) {
    const id = `epic:${epic.epic_id}`;
    const slices = status.slices.filter((s) => s.epic_id === epic.epic_id).length;
    nodes.push({
      id,
      type: "mach",
      position: { x: 0, y: 0 },
      ariaLabel: `Epic ${epic.epic_id}, ${epic.title}, ${epicStates[epic.status].label}${epic.issue ? `, issue #${epic.issue}` : ""}`,
      data: {
        kind: "epic",
        artifactId: epic.epic_id,
        title: epic.title,
        state: fromEpic[epic.status],
        stateLabel: epicStates[epic.status].label,
        meta: `${slices} ${slices === 1 ? "slice" : "slices"}`,
      },
    });
    if (rootId) edges.push({ id: `${rootId}->${id}`, source: rootId, target: id, type: "contains", data: { kind: "contains" } });
  }

  for (const row of status.slices) {
    const id = `slice:${row.slice_id}`;
    const attention = attentionOf(row);
    const meta = row.open_questions > 0 ? `${row.open_questions} open ${row.open_questions === 1 ? "question" : "questions"}` : row.github.issue ? `#${row.github.issue}` : undefined;
    const words = [
      sliceStates[row.status].label,
      row.github.state_label ? builderStates[row.github.state_label].label : null,
      ...githubMarksOf(row.github).map((mark) => githubMarks[mark].label),
      row.github.issue ? `issue #${row.github.issue}` : null,
    ].filter(Boolean);
    nodes.push({
      id,
      type: "mach",
      position: { x: 0, y: 0 },
      ariaLabel: `Slice ${row.slice_id}, ${row.title}, ${words.join(", ")}`,
      data: { kind: "slice", artifactId: row.slice_id, title: row.title, state: sliceGraphState(row), meta, attention },
    });
    edges.push({ id: `epic:${row.epic_id}->${id}`, source: `epic:${row.epic_id}`, target: id, type: "contains", data: { kind: "contains" } });
  }

  const known = new Set(status.slices.map((s) => s.slice_id));
  for (const [sliceId, list] of Object.entries(needs)) {
    for (const need of list) {
      if (!known.has(need) || !known.has(sliceId)) continue;
      edges.push({
        id: `dep:${sliceId}->${need}`,
        source: `slice:${need}`,
        target: `slice:${sliceId}`,
        type: "depends",
        ariaLabel: `${sliceId} needs ${need}`,
        data: { kind: "depends" },
      });
    }
  }

  return { nodes, edges };
}

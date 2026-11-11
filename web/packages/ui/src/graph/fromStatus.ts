import type { EpicStatus, FeedbackWave, ProjectStatus, SliceStatus, Status, StatusSliceRow } from "../api/types";
import { epicStates, sliceStates, sourceStates } from "../lifecycle/states";
import type { GraphState, MachEdge, MachNode } from "./types";

const fromSlice: Record<SliceStatus, GraphState> = {
  draft: "proposed",
  interviewing: "interviewing",
  ready_for_approval: "ready",
  approved_for_engineering: "approved",
  superseded: "superseded",
};

const fromEpic: Record<EpicStatus, GraphState> = {
  proposed: "proposed",
  approved: "approved",
  deferred: "superseded",
  completed: "accepted",
  superseded: "superseded",
};

const fromProject: Record<ProjectStatus, GraphState> = { draft: "proposed", active: "approved", archived: "superseded" };

export interface ProductGraphInput {
  status: Status;
  /** `feedback.waves`, when known: lets sent slices show as submitted, accepted or blocked. */
  reviews?: FeedbackWave[];
  /** Work-order dependencies by slice ID (status rows do not carry them; `slice show` does). */
  dependencies?: Record<string, string[]>;
}

/**
 * The visual state of a slice on the graph. Presentation only: it reads what the engine reported
 * (the slice's status, whether its wave was sent, what review said) and never decides anything.
 */
export function sliceGraphState(row: StatusSliceRow, status: Status, reviews: FeedbackWave[] = []): GraphState {
  const base = fromSlice[row.status];
  if (base !== "approved") return base;
  const waves = status.waves.filter((wave) => wave.slices.includes(row.slice_id) && wave.status !== "superseded");
  const review = reviews.find((r) => r.slices.includes(row.slice_id));
  if (review?.status === "Accepted") return "accepted";
  if (review?.status === "Blocked by a check") return "blocked";
  if (waves.some((wave) => wave.sent)) return "submitted";
  return base;
}

/** Builds graph nodes and edges from the engine's `status` (and optionally `feedback`). No positions: run layoutGraph. */
export function productGraphFromStatus({ status, reviews = [], dependencies = {} }: ProductGraphInput): { nodes: MachNode[]; edges: MachEdge[] } {
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
    const attention = epic.source === "conflict" || epic.source === "collision" ? sourceStates[epic.source].label : undefined;
    nodes.push({
      id,
      type: "mach",
      position: { x: 0, y: 0 },
      ariaLabel: `Epic ${epic.epic_id}, ${epic.title}, ${epicStates[epic.status].label}${attention ? `, ${attention}` : ""}`,
      data: {
        kind: "epic",
        artifactId: epic.epic_id,
        title: epic.title,
        state: fromEpic[epic.status],
        stateLabel: epicStates[epic.status].label,
        meta: `${slices} ${slices === 1 ? "slice" : "slices"}`,
        attention,
      },
    });
    if (rootId) edges.push({ id: `${rootId}->${id}`, source: rootId, target: id, type: "contains", data: { kind: "contains" } });
  }

  for (const row of status.slices) {
    const id = `slice:${row.slice_id}`;
    const state = sliceGraphState(row, status, reviews);
    const attention = row.source === "conflict" || row.source === "collision" ? sourceStates[row.source].label : undefined;
    const meta =
      row.open_questions > 0
        ? `${row.open_questions} open ${row.open_questions === 1 ? "question" : "questions"}`
        : status.waves.find((w) => w.slices.includes(row.slice_id) && w.status !== "superseded")?.wave_id;
    nodes.push({
      id,
      type: "mach",
      position: { x: 0, y: 0 },
      ariaLabel: `Slice ${row.slice_id}, ${row.title}, ${sliceStates[row.status].label}${attention ? `, ${attention}` : ""}`,
      data: { kind: "slice", artifactId: row.slice_id, title: row.title, state, meta, attention },
    });
    edges.push({ id: `epic:${row.epic_id}->${id}`, source: `epic:${row.epic_id}`, target: id, type: "contains", data: { kind: "contains" } });
  }

  for (const [sliceId, needs] of Object.entries(dependencies)) {
    for (const need of needs) {
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

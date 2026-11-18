/**
 * Where each recommended next step leads. The engine decides what is next (`status.next_actions`);
 * this only maps its kind and target to a screen or an in-place act.
 */
import { artifactKind, type ApiErrorHint, type NextAction, type Status } from "@mach/ui/api";

export type ActionRoute =
  /** Go to a screen. */
  | { type: "navigate"; to: string; label: string; state?: unknown }
  /** A personal act confirmed in place (epic approval). */
  | { type: "approve-epic"; epicId: string; label: string }
  /** Start a slice: ask for its title, then open its interview. */
  | { type: "new-slice"; epicId: string | null; label: string }
  /** Give a draft the next free number, confirmed in place. */
  | { type: "renumber"; id: string; label: string }
  /** Add an epic, in a dialog on the screen that asked. */
  | { type: "add-epic"; label: string }
  /** Answer the builders' question: reopen the slice (confirmed in place), then its interview. */
  | { type: "answer-question"; sliceId: string; label: string };

export function routeFor(action: NextAction): ActionRoute {
  const id = action.target;
  const kind = artifactKind(id);
  const slice = kind === "slice" ? id : null;
  switch (action.kind) {
    case "define_project":
      return { type: "navigate", to: "/vision", label: "Define the project" };
    case "add_epic":
      return { type: "add-epic", label: "Add an epic" };
    case "approve_epic":
      return id && kind === "epic" ? { type: "approve-epic", epicId: id, label: "Review and approve" } : { type: "navigate", to: "/vision", label: "Open" };
    case "start_slice":
      return { type: "new-slice", epicId: kind === "epic" ? id : null, label: "Start a slice" };
    case "continue_interview":
      return slice ? { type: "navigate", to: `/slices/${slice}/interview`, label: "Continue the interview" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "mark_ready":
      return slice ? { type: "navigate", to: `/slices/${slice}`, label: "Read it and mark it ready" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "finish_ready":
      return slice ? { type: "navigate", to: `/slices/${slice}`, label: "Finish marking it ready" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "answer_question":
      return slice ? { type: "answer-question", sliceId: slice, label: "Answer it" } : { type: "navigate", to: "/inbox", label: "Open decisions" };
    case "reconcile":
      return { type: "navigate", to: "/inbox", label: "Choose a version" };
    case "renumber_slice":
      return slice ? { type: "renumber", id: slice, label: "Give it a new number" } : { type: "navigate", to: "/inbox", label: "Open decisions" };
    default:
      return byTarget(id);
  }
}

function byTarget(target: string | null): ActionRoute {
  const kind = artifactKind(target);
  if (kind === "slice") return { type: "navigate", to: `/slices/${target}`, label: "Open the slice" };
  if (kind === "epic") return { type: "navigate", to: "/vision", label: "Open the epic" };
  return { type: "navigate", to: "/roadmap", label: "Open" };
}

/** The engine's recommended next steps, in its order. */
export function nextActions(status: Status): NextAction[] {
  return status.next_actions;
}

/** Where a refusal's hint leads: the next-action kinds, plus the acts that resolve a refusal. */
export function routeForHint(hint: ApiErrorHint): ActionRoute {
  const t = hint.target;
  switch (hint.kind) {
    case "reopen_slice":
      return t ? { type: "navigate", to: `/slices/${t}`, label: `Open ${t} to reopen it` } : { type: "navigate", to: "/roadmap", label: "Open the roadmap" };
    case "renumber_epic":
      return t ? { type: "renumber", id: t, label: `Give ${t} a new number` } : { type: "navigate", to: "/vision", label: "Open the epics" };
    case "edit_epic":
      return { type: "navigate", to: "/vision", label: t ? `Edit ${t}` : "Edit the epics", state: { focus: "epics" } };
    case "edit_project":
      return { type: "navigate", to: "/vision", label: "Edit the project" };
    default: {
      const route = routeFor({ kind: hint.kind, target: t, title: "", reason: null });
      if (route.type === "approve-epic") return { ...route, label: `Approve ${route.epicId}` };
      if (route.type === "renumber") return { ...route, label: `Give ${route.id} a new number` };
      return route;
    }
  }
}

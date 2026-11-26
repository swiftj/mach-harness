/**
 * Where each recommended next step leads. The engine decides what is next (`status.next_actions`);
 * this only maps its kind and target to a screen or an in-place act.
 */
import type { ApiErrorHint, NextAction, Status } from "@mach/ui/api";
import { artifactKind } from "@mach/ui/ids";

export type ActionRoute =
  /** Go to a screen; `state.focus` names the place on it to bring into view (M20: a choice waiting on Vision). */
  | { type: "navigate"; to: string; label: string; state?: { focus: string } }
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
    case "join_project":
      // The project home brings it in by itself, before anything else is shown.
      return { type: "navigate", to: "/", label: "Bring in the project" };
    case "choose_version":
      // The two choices sit in the "From GitHub" panel on the project home.
      return { type: "navigate", to: "/", label: "Keep yours or take GitHub's" };
    case "reopen_changed":
      return slice ? { type: "navigate", to: `/slices/${slice}`, label: "Reopen it" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "import_waiting":
      return { type: "navigate", to: "/move", label: "Finish bringing it in" };
    case "read_slice":
      return slice ? { type: "navigate", to: `/slices/${slice}`, label: "Read it" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "mocks_waiting":
      return slice ? { type: "navigate", to: `/slices/${slice}`, label: "See its pictures" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "define_project":
      return { type: "navigate", to: "/vision", label: "Define the project" };
    case "add_epic":
      return { type: "add-epic", label: "Add an epic" };
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
      // The engine's target is a slice, or "principles" when someone else published newer product principles, or (M20)
      // "project" or an epic when someone else changed its own text: that choice waits on Vision, beside the text.
      if (id === "principles") return { type: "navigate", to: "/principles", label: "Choose a version of the principles" };
      if (id === "project") return { type: "navigate", to: "/vision", label: "Choose a version of the project", state: { focus: "shared-project" } };
      if (kind === "epic" && id) return { type: "navigate", to: "/vision", label: `Choose a version of ${id}`, state: { focus: `shared-${id}` } };
      return { type: "navigate", to: "/inbox", label: "Choose a version" };
    case "renumber_slice":
      // Another slice on GitHub holds the number: marking it ready gives it the next free number in the same act, so
      // this goes straight to that act. No step comes before it.
      return slice ? { type: "navigate", to: `/slices/${slice}`, label: "Read it and mark it ready" } : { type: "navigate", to: "/inbox", label: "Open decisions" };
    case "renumber_epic":
      // M20: an epic's number taken at the same moment by someone else's epic: the same act, in place.
      return kind === "epic" && id ? { type: "renumber", id, label: "Give it a new number" } : { type: "navigate", to: "/vision", label: "Open the epics" };
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
    case "edit_project":
      return { type: "navigate", to: "/vision", label: "Edit the project" };
    case "ready_without_mocks":
      // The mark-ready dialog offers "Mark ready without the pictures" itself; elsewhere, the slice's page.
      return t ? { type: "navigate", to: `/slices/${t}`, label: `Open ${t}` } : { type: "navigate", to: "/roadmap", label: "Open the roadmap" };
    case "start_anyway":
      // The project home brings the project in from GitHub, and offers starting one's own when GitHub cannot be read.
      return { type: "navigate", to: "/", label: "Open the project home" };
    default: {
      const route = routeFor({ kind: hint.kind, target: t, title: "", reason: null });
      if (route.type === "renumber") return { ...route, label: `Give ${route.id} a new number` };
      return route;
    }
  }
}

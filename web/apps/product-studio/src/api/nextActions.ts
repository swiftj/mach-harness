/**
 * Where each recommended next step leads. The engine decides what is next (`status.next_actions`);
 * this only maps its kind and target to a screen or an in-place act.
 */
import { artifactKind, idInPath, type ApiErrorHint, type NextAction, type Status } from "@mach/ui/api";

export type ActionRoute =
  /** Go to a screen. */
  | { type: "navigate"; to: string; label: string; state?: unknown }
  /** A personal act confirmed in place (epic approval). */
  | { type: "approve-epic"; epicId: string; label: string }
  /** Start a slice: ask for its title, then open its interview. */
  | { type: "new-slice"; epicId: string | null; label: string }
  /** Fetch from the shared project now. */
  | { type: "refresh"; label: string };

export function routeFor(action: NextAction): ActionRoute {
  const t = action.target;
  const kind = artifactKind(t);
  const id = t && kind === "path" ? idInPath(t) : t;
  switch (action.kind) {
    case "define_project":
      return { type: "navigate", to: "/vision", label: "Define the project" };
    case "add_epic":
      return { type: "navigate", to: "/vision", label: "Add an epic", state: { focus: "epics" } };
    case "approve_epic":
      return id && kind === "epic" ? { type: "approve-epic", epicId: id, label: "Review and approve" } : { type: "navigate", to: "/vision", label: "Open" };
    case "start_slice":
      return { type: "new-slice", epicId: kind === "epic" ? id : null, label: "Start a slice" };
    case "continue_interview":
      return id ? { type: "navigate", to: `/slices/${id}/interview`, label: "Continue the interview" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "approve_slice":
      return id ? { type: "navigate", to: `/slices/${id}`, label: "Review the specification" } : { type: "navigate", to: "/roadmap", label: "Open" };
    case "create_wave":
    case "approve_wave":
    case "send_wave":
    case "review_feedback":
      return { type: "navigate", to: "/waves", label: action.kind === "send_wave" ? "Prepare to send" : "Open delivery waves" };
    case "reconcile":
    case "renumber":
      return { type: "navigate", to: "/inbox", label: "Settle it" };
    case "refresh":
      return { type: "refresh", label: "Refresh now" };
    default:
      return byTarget(t);
  }
}

function byTarget(target: string | null): ActionRoute {
  const kind = artifactKind(target);
  const id = target && kind === "path" ? idInPath(target) : target;
  const idKind = artifactKind(id);
  if (kind === "path") return { type: "navigate", to: "/inbox", label: "Open" };
  if (idKind === "slice") return { type: "navigate", to: `/slices/${id}`, label: "Open the slice" };
  if (idKind === "epic") return { type: "navigate", to: "/vision", label: "Open the epic" };
  if (idKind === "wave") return { type: "navigate", to: "/waves", label: "Open the wave" };
  if (kind === "project") return { type: "navigate", to: "/vision", label: "Open the vision" };
  return { type: "navigate", to: "/roadmap", label: "Open" };
}

/** The engine's recommended next steps, in its order. */
export function nextActions(status: Status): NextAction[] {
  return status.next_actions ?? [];
}

/** Where a refusal's hint leads: the next-action kinds, plus the acts that resolve a refusal. */
export function routeForHint(hint: ApiErrorHint): ActionRoute {
  const t = hint.target;
  switch (hint.kind) {
    case "reopen_slice":
      return t ? { type: "navigate", to: `/slices/${t}`, label: `Open ${t} to reopen it` } : { type: "navigate", to: "/roadmap", label: "Open the roadmap" };
    case "renumber_slice":
    case "renumber_epic":
    case "renumber_wave":
      return { type: "navigate", to: "/inbox", label: t ? `Renumber ${t}` : "Open decisions" };
    case "edit_epic":
      return { type: "navigate", to: "/vision", label: t ? `Edit ${t}` : "Edit the epics", state: { focus: "epics" } };
    case "edit_project":
      return { type: "navigate", to: "/vision", label: "Edit the project" };
    case "name_approver":
      return { type: "navigate", to: "/waves", label: "Name who approves" };
    default: {
      const route = routeFor({ kind: hint.kind, target: t, title: "", reason: null });
      if (route.type === "approve-epic") return { ...route, label: `Approve ${route.epicId}` };
      return route;
    }
  }
}

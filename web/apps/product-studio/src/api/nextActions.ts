/**
 * Where each recommended next step leads. The engine decides what is next (`status.next_actions`);
 * this only maps its kind and target to a screen or an in-place act.
 */
import { artifactKind, idInPath, suggestionText, type NextAction, type Status } from "@mach/ui/api";

export type ActionRoute =
  /** Go to a screen. */
  | { type: "navigate"; to: string; label: string }
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
      return { type: "navigate", to: "/vision#epics", label: "Add an epic" };
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

/**
 * The actions to show: the engine's structured list when it reports one; otherwise its sentences,
 * with the terminal command removed and the first ID they mention as the target.
 */
export function nextActions(status: Status): NextAction[] {
  if (status.next_actions) return status.next_actions;
  return status.suggested_next.map((sentence) => {
    const target = sentence.match(/\b(?:SLICE|EPIC|WAVE)-\d{3,}\b/)?.[0] ?? null;
    const command = sentence.match(/\(([^()]*)\)\s*\.?\s*$/)?.[1] ?? "";
    // The bracketed command names the operation; it is read to choose the screen, never shown.
    const kind =
      /^project init/.test(command) ? "define_project"
      : /^epic approve/.test(command) ? "approve_epic"
      : /^slice new/.test(command) ? "start_slice"
      : /^slice resume/.test(command) ? "continue_interview"
      : /^slice approve/.test(command) ? "approve_slice"
      : /^send/.test(command) ? "send_wave"
      : /^wave/.test(command) ? "approve_wave"
      : /reconcile|renumber/.test(command) ? "reconcile"
      : "other";
    return { kind, target, title: suggestionText(sentence), reason: null };
  });
}

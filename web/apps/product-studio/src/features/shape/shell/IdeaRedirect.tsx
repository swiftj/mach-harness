import { Navigate, useParams } from "react-router";
import { IdeaStepFrame } from "./IdeaStepFrame";
import { nextPathOf } from "./steps";
import { useIdea } from "./useIdea";

/**
 * /shape/ideas/:ideaId opens the idea at the step that holds the engine's next step for it (shell-owned). While the
 * status loads, or for an idea the board does not hold, the frame says so.
 */
export function IdeaRedirect() {
  const ideaId = useParams().ideaId ?? "";
  const { row } = useIdea(ideaId);
  if (row) return <Navigate to={nextPathOf(row)} replace />;
  return <IdeaStepFrame ideaId={ideaId} step="explore">{() => null}</IdeaStepFrame>;
}

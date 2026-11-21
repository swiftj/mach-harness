import { useParams } from "react-router";
import { NotBuiltYet } from "../../../shared/ScreenFrame";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";

/**
 * Explore one idea: the Shape conversation, one open question at a time, and what MACH looked up beside it.
 *
 * Owned by screen engineer 2 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: client.ideaConversation (current, history, start, subscribe, reply, interrupt, stop), idea.show (source, lookups.items), idea.stage, epic.current for a rule's words.
 * Fixtures: ?idea=exploring|request|fault|change, idea.lookups.
 */
export function ExploreScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="explore" lead="Open questions, one at a time, answered in your own words. Facts are looked up, never asked.">
      {() => <NotBuiltYet what="The conversation about this idea, and what was looked up: what exists today, what is already wanted, and what stands in the way." />}
    </IdeaStepFrame>
  );
}

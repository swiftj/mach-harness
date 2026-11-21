import { useParams } from "react-router";
import { NotBuiltYet } from "../../../shared/ScreenFrame";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";

/**
 * The case as the customer would hear it, the hard questions with the product manager's answers, and the verdict.
 *
 * Owned by screen engineer 4 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: case.show, case.check, idea.show (verdict, verdict_note), verdict.record, idea.publish, idea.renumber.
 * Fixtures: ?case=none, ?verdict=..., ?publish-idea=....
 */
export function CaseScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="case" lead="Before any epic exists: the case as the customer would hear it, the hardest questions, and your verdict.">
      {() => <NotBuiltYet what="The case, the hard questions and their answers, and your verdict: Go, Not now or No, in your own words. Then save it to GitHub." />}
    </IdeaStepFrame>
  );
}

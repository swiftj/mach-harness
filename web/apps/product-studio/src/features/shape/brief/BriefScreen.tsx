import { useParams } from "react-router";
import { NotBuiltYet } from "../../../shared/ScreenFrame";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";

/**
 * The brief, as written, beside its check.
 *
 * Owned by screen engineer 3 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: brief.show (text, model, findings, verdict), brief.check.
 * Fixtures: ?brief=passes|finding|stale-verdict|change-starter|none.
 */
export function BriefScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="brief" lead="One page, written by the conversation and owned by you. It never reaches the builders as instructions; the slice specs do.">
      {() => <NotBuiltYet what="The brief as written, and its check: what passes, and each problem to fix beside the line it concerns." />}
    </IdeaStepFrame>
  );
}

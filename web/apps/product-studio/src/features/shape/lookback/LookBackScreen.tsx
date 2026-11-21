import { useParams } from "react-router";
import { NotBuiltYet } from "../../../shared/ScreenFrame";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";

/**
 * Look back: each outcome and assumption of the brief, recorded by the product manager once a slice has shipped, and the whole chain.
 *
 * Owned by screen engineer 6 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: lookback.record, idea.chain, idea.show (lookback).
 * Fixtures: ?fixture=status.ideas-look-back, ?lookback=..., ?chain=looked-back.
 */
export function LookBackScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="look-back" lead="Once a slice made from this idea has shipped, each outcome and assumption comes back for you to record.">
      {() => <NotBuiltYet what="Each outcome and assumption with what you saw, and the chain from why it was wanted to what shipped." />}
    </IdeaStepFrame>
  );
}

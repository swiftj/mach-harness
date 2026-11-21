import { useParams } from "react-router";
import { NotBuiltYet } from "../../../shared/ScreenFrame";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";

/**
 * Size and route: what a script counted, the route its rule names, the proposed map with its coverage, settling and applying.
 *
 * Owned by screen engineer 5 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: idea.size, idea.show (route), idea.map, idea.map-status, idea.settle, idea.apply.
 * Fixtures: ?size=..., ?map=..., ?map-status=..., ?settle=..., ?apply=....
 */
export function RouteScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="route" lead="A script, not a model, counts what the brief touches and names a route. You decide what is created.">
      {() => <NotBuiltYet what="What was counted, the route the rule names, and the map: each outcome carried by a slice or settled, then the drafts made when you say so." />}
    </IdeaStepFrame>
  );
}

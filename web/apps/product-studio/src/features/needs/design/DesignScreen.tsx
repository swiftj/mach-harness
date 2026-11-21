import { useParams } from "react-router";
import { CircleAlert } from "lucide-react";
import { ErrorState } from "@mach/ui";
import { NotBuiltYet, ScreenFrame } from "../../../shared/ScreenFrame";
import { Loaded } from "../shell/LoadStates";
import { DESIGNS_LABEL } from "../shell/paths";
import { useDesignShow } from "../shell/useNeeds";

/**
 * One design you already have (M17 part D): the six topics with what the document decides and the lines it cites,
 * conflicts with three equal choices, and publishing it. A placeholder until its screen engineer builds it
 * (docs/mach-next/M17_APP_FOUNDATION.md). It reads `design.show` through the client and shows loading and error
 * states; an ID that is not DES-NN is never sent. No ADR act is shown or offered.
 */
export function DesignScreen() {
  const { designId = "" } = useParams();
  const shown = useDesignShow(designId);
  return (
    <ScreenFrame title={shown.data ? `${shown.data.design.design_id} ${shown.data.design.name ?? ""}`.trim() : DESIGNS_LABEL} lead={shown.data?.note}>
      {shown.valid ? (
        <Loaded state={shown} reading="Reading the design">
          {() => <NotBuiltYet what="What the document decides for each topic and the lines it cites, the conflicts that wait for your word, and publishing it." />}
        </Loaded>
      ) : (
        <ErrorState icon={<CircleAlert />} title="Not a design" message={`"${designId}" is not a design's ID, such as DES-01.`} />
      )}
    </ScreenFrame>
  );
}

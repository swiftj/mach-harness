import { Link } from "react-router";
import { FileText } from "lucide-react";
import { EmptyState } from "@mach/ui";
import { NotBuiltYet, ScreenFrame } from "../../../shared/ScreenFrame";
import { Loaded } from "../shell/LoadStates";
import { DESIGNS_LABEL, designPath } from "../shell/paths";
import { useDesignList } from "../shell/useNeeds";

/**
 * A design you already have (M17 part D): the designs brought in, and bringing one in. A placeholder until its screen
 * engineer builds it (docs/mach-next/M17_APP_FOUNDATION.md). It reads `design.list` through the client and shows
 * loading, error and empty states. No ADR act is shown or offered.
 */
export function DesignListScreen() {
  const list = useDesignList();
  return (
    <ScreenFrame title={DESIGNS_LABEL}>
      <Loaded state={list} reading="Reading the designs you brought in">
        {(data) =>
          data.designs.length === 0 ? (
            <EmptyState icon={<FileText />} title="No design brought in yet" />
          ) : (
            <div className="flex flex-col gap-6">
              <ul className="flex flex-col gap-2">
                {data.designs.map((design) => (
                  <li key={design.design_id}>
                    <Link to={designPath(design.design_id)} className="text-accent-ink underline underline-offset-2">
                      {design.design_id} {design.name}
                    </Link>
                  </li>
                ))}
              </ul>
              <NotBuiltYet what="Bringing in a design, and each design with what it decides and the conflicts that wait for your word." />
            </div>
          )
        }
      </Loaded>
    </ScreenFrame>
  );
}

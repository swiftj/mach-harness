import { Link } from "react-router";
import { ListChecks } from "lucide-react";
import { EmptyState, Text } from "@mach/ui";
import { NotBuiltYet, ScreenFrame } from "../../../shared/ScreenFrame";
import { Loaded } from "../shell/LoadStates";
import { DESIGNS_LABEL, DESIGNS_PATH, NEEDS_LABEL } from "../shell/paths";
import { useNeedList } from "../shell/useNeeds";

/**
 * Technical needs (M17 part D): a placeholder until its screen engineer builds it (docs/mach-next/M17_APP_FOUNDATION.md).
 * It reads `need.list` through the client and shows loading, error and empty states; the six kinds, the conversation
 * (useNeedsConversation), the publish act and, read only, the ADRs behind a need are this folder's to build. No ADR
 * act is shown or offered.
 */
export function TechnicalNeedsScreen() {
  const list = useNeedList();
  return (
    <ScreenFrame title={NEEDS_LABEL} lead={list.data?.note}>
      <Loaded state={list} reading="Reading your technical needs">
        {(data) => (
          <div className="flex flex-col gap-6">
            {data.needs.length === 0 && data.nothing_to_say.length === 0 ? (
              <EmptyState icon={<ListChecks />} title="No technical needs yet" description={data.next ?? undefined} />
            ) : (
              <>
                {data.next ? <Text>{data.next}</Text> : null}
                <NotBuiltYet what="Each kind of need with its needs or 'nothing to say', the conversation beside them, and publishing them." />
              </>
            )}
            <Text>
              <Link to={DESIGNS_PATH} className="text-accent-ink underline underline-offset-2">
                {DESIGNS_LABEL}
              </Link>
            </Text>
          </div>
        )}
      </Loaded>
    </ScreenFrame>
  );
}

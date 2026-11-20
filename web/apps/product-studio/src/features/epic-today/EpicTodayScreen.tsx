import { useParams } from "react-router";
import { useStatus } from "../../api/store";
import { NotBuiltYet, ScreenFrame } from "../../shared/ScreenFrame";

/**
 * How an epic works today: `epic.current` ({epic_id}), which changes nothing. Always show its
 * `note` (it may be behind GitHub; the slices are the authority). Fixtures: epic.current,
 * ?epic=nothing-shipped|after-retire.
 */
export function EpicTodayScreen() {
  const epicId = useParams().epicId ?? "";
  const title = useStatus().data?.epics.find((e) => e.epic_id === epicId)?.title ?? epicId;
  return (
    <ScreenFrame title={`How ${title} works today`} lead="The rules in force, from the slices of this epic that have shipped.">
      <NotBuiltYet what="The rules in force, those replaced or retired, and the slices they came from will be shown here." />
    </ScreenFrame>
  );
}

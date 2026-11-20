import { useParams } from "react-router";
import { useSliceShow } from "../../api/useSliceShow";
import { NotBuiltYet, SliceScreenFrame } from "../../shared/ScreenFrame";

/**
 * A slice made from a PRD: `slice.resume` (`prd`: cited lines fenced, drafted answers, the why
 * line), `slice.check` (`prd_problems`); act `prd.confirm`. Fixtures: ?resume=from-prd, prd.draft,
 * prd.confirm, slice.check.prd-pending.
 */
export function SlicePrdScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="From the PRD" lead="Answers drafted from the PRD's lines. Accept them, or set them aside to discuss in the interview.">
      <NotBuiltYet what="The PRD lines this slice cites and the answers drafted from them will be shown here." />
    </SliceScreenFrame>
  );
}

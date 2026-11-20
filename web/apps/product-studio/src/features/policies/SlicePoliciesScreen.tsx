import { useParams } from "react-router";
import { useSliceShow } from "../../api/useSliceShow";
import { NotBuiltYet, SliceScreenFrame } from "../../shared/ScreenFrame";

/**
 * One slice's principles and policies: `slice.show` (`spec.model.principles`, `spec.model.policies`,
 * the check's findings), `status.slices[].principles`; acts `policy.accept` (the owner's words,
 * confirmed in a dialog). Fixtures: ?show=open-concern|concern-accepted.
 */
export function SlicePoliciesScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="Principles and policies" lead="How this slice keeps each principle and follows each policy.">
      <NotBuiltYet what="Each principle and policy this slice answers, and any concern waiting for its owner, will be shown here." />
    </SliceScreenFrame>
  );
}

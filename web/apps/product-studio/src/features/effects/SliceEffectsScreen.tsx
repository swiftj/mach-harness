import { useParams } from "react-router";
import { useSliceShow } from "../../api/useSliceShow";
import { NotBuiltYet, SliceScreenFrame } from "../../shared/ScreenFrame";

/**
 * What one slice does to behaviour that has shipped: `slice.show` (`spec.model.effects`,
 * `check.shipped`, the effects findings), `slice.resume` (`shipped_rules`, fenced), and
 * `status.slices[].shipped_moved`. Fixtures: ?show=effects, ?fixture=status.shipped-moved,
 * ?resume=shipped-rules.
 */
export function SliceEffectsScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="Effects on shipped behaviour" lead="Which rules that have already shipped this slice keeps, changes, replaces or retires.">
      <NotBuiltYet what="Each shipped rule this slice touches, and what it does to it, will be shown here." />
    </SliceScreenFrame>
  );
}

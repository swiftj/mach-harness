import { useParams } from "react-router";
import { useSliceShow } from "../../api/useSliceShow";
import { NotBuiltYet, SliceScreenFrame } from "../../shared/ScreenFrame";

/**
 * One slice's design mocks: `slice.mock.list`; acts `slice.mock.add` with
 * `uploadFile(file, uploadLimits.mock)` and `slice.mock.remove`. After "Mark ready to build" on
 * GitHub, `slice.ready`'s `mocks` says the pictures wait to be committed. The pictures themselves
 * are not served by the host. Fixtures: slice.mock.list, ?mocks=empty, ?ready=with-mocks,
 * ?refuse=slice.mock.add.
 */
export function SliceMocksScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="Design mocks" lead="Approved pictures of the screen, each for one scenario or for the slice as a whole.">
      <NotBuiltYet what="The pictures attached to this slice, and a way to attach one, will be here." />
    </SliceScreenFrame>
  );
}

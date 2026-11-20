import { useParams } from "react-router";
import { NotBuiltYet, ScreenFrame } from "../../shared/ScreenFrame";

/**
 * One PRD: `prd.status` (map, coverage, sections not covered), `prd.show` (the text, fenced, as
 * plain text); acts `prd.map`, `prd.settle`, `prd.apply`. Fixtures:
 * ?prd-status=no-map|uncovered|one-left|applied, ?refuse=prd.apply.
 */
export function PrdScreen() {
  const prdId = useParams().prdId ?? "";
  return (
    <ScreenFrame title={prdId} lead="How the PRD's sections map to epics and slices, and what is left to settle.">
      <NotBuiltYet what="The map of epics and slices, each section and what covers it, will be shown here." />
    </ScreenFrame>
  );
}

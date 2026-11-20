import { NotBuiltYet, ScreenFrame } from "../../shared/ScreenFrame";

/**
 * The imported PRDs: `prd.list`; act `prd.import` with `uploadFile(file, uploadLimits.prd)`.
 * Fixtures: prd.list, ?prd=empty, ?refuse=prd.import.
 */
export function PrdListScreen() {
  return (
    <ScreenFrame title="Start from a PRD" lead="Bring in an approved PRD. It stays in your workspace and is never sent anywhere.">
      <NotBuiltYet what="The PRDs you imported, and a way to import one, will be here." />
    </ScreenFrame>
  );
}

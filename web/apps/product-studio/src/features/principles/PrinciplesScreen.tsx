import { NotBuiltYet, ScreenFrame } from "../../shared/ScreenFrame";

/**
 * Product principles (M13 A). Reads `principle.list`; acts `principle.add`, `principle.set`,
 * `principle.retire`, `principle.publish` and `reconcile.principles`, each a person's act
 * confirmed in a dialog. Fixtures: ?principles=empty|unpublished|newer-elsewhere.
 */
export function PrinciplesScreen() {
  return (
    <ScreenFrame title="Product principles" lead="One sentence each that every slice must keep. Each slice says how it keeps them.">
      <NotBuiltYet what="Your principles, where they are published, and the slices answered under an older version will be listed here." />
    </ScreenFrame>
  );
}

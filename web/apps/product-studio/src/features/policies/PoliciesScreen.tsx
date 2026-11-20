import { NotBuiltYet, ScreenFrame } from "../../shared/ScreenFrame";

/**
 * Policy packs (M14 A). Reads `policy.list` (packs, problems, slices answered under an older
 * version) and `status` for the slices to settle. Fixtures: policy.list, status.principles.
 */
export function PoliciesScreen() {
  return (
    <ScreenFrame title="Policy packs" lead="Your organisation's policies. Engineers change them; each slice says how it follows them.">
      <NotBuiltYet what="Each policy pack, its owner, and the slices with a concern its owner has to settle will be listed here." />
    </ScreenFrame>
  );
}

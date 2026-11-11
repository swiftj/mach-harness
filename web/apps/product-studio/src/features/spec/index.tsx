import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function SpecScreen() {
  return (
    <Page>
      <EmptyState title="Slice" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ path: "slices/:sliceId", element: <SpecScreen /> }],
};

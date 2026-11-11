import { Layers } from "lucide-react";
import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function WavesScreen() {
  return (
    <Page>
      <EmptyState title="Delivery waves" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ path: "waves", element: <WavesScreen /> }],
  nav: { to: "/waves", label: "Delivery waves", icon: Layers, section: "deliver", order: 50 },
};

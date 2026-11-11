import { Network } from "lucide-react";
import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function RoadmapScreen() {
  return (
    <Page>
      <EmptyState title="Roadmap" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ path: "roadmap", element: <RoadmapScreen /> }],
  nav: { to: "/roadmap", label: "Roadmap", icon: Network, section: "work", order: 30 },
};

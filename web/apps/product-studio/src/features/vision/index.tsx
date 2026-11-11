import { Compass } from "lucide-react";
import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function VisionScreen() {
  return (
    <Page>
      <EmptyState title="Vision" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ path: "vision", element: <VisionScreen /> }],
  nav: { to: "/vision", label: "Vision", icon: Compass, section: "work", order: 20 },
};

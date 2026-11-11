import { RefreshCw } from "lucide-react";
import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function ActivityScreen() {
  return (
    <Page>
      <EmptyState title="Shared project" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ path: "shared", element: <ActivityScreen /> }],
  nav: { to: "/shared", label: "Shared project", icon: RefreshCw, section: "deliver", order: 60 },
};

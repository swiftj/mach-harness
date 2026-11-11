import { House } from "lucide-react";
import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function WorkspaceScreen() {
  return (
    <Page>
      <EmptyState title="Workspace" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ index: true, element: <WorkspaceScreen /> }],
  nav: { to: "/", label: "Workspace", icon: House, section: "work", order: 10 },
};

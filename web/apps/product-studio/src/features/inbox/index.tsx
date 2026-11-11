import { Inbox } from "lucide-react";
import { EmptyState, Page } from "@mach/ui";
import type { Feature } from "../types";

/** Placeholder: this feature's owner replaces everything in this folder. Keep the `feature` export's shape. */
function InboxScreen() {
  return (
    <Page>
      <EmptyState title="Decisions" description="This screen is being built." />
    </Page>
  );
}

export const feature: Feature = {
  routes: [{ path: "inbox", element: <InboxScreen /> }],
  nav: { to: "/inbox", label: "Decisions", icon: Inbox, section: "attention", order: 40 },
};

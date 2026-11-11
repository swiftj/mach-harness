import { Inbox } from "lucide-react";
import type { Feature } from "../types";
import { InboxScreen } from "./InboxScreen";

/** The Decision Inbox: conflicts, collisions, review that needs the PM, withdrawn approvals, open questions. */
export const feature: Feature = {
  routes: [{ path: "inbox", element: <InboxScreen /> }],
  nav: { to: "/inbox", label: "Decisions", icon: Inbox, section: "attention", order: 40 },
};

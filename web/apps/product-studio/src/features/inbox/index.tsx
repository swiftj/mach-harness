import type { Feature } from "../types";
import { InboxScreen } from "./InboxScreen";

/** The Decision Inbox: conflicts, collisions, review that needs the PM, withdrawn approvals, open questions, requests. */
export const feature: Feature = {
  routes: [{ path: "inbox", element: <InboxScreen /> }],
  destination: { to: "/inbox", label: "Decisions", description: "Versions to choose, open questions, requests", order: 40 },
};

import type { Feature } from "../types";

/**
 * Jira (M13 E): each epic's and slice's Jira key, a file to import into Jira, and the keys handed
 * back. MACH never calls Jira. Shell-owned; the screen is JiraScreen.tsx.
 */
export const feature: Feature = {
  routes: [{ path: "jira", lazy: () => import("./JiraScreen").then((m) => ({ Component: m.JiraScreen })) }],
  destination: { to: "/jira", label: "Jira", description: "Jira keys, and a file to import into Jira", order: 70 },
};

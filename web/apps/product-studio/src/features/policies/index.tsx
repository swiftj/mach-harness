import type { Feature } from "../types";

/**
 * Policy packs (M14 A): the organisation's packs, and per slice the principles and policies its
 * spec answers, with any flagged concern and its owner's acceptance. Shell-owned; the screens are
 * PoliciesScreen.tsx and SlicePoliciesScreen.tsx.
 */
export const feature: Feature = {
  routes: [
    { path: "policies", lazy: () => import("./PoliciesScreen").then((m) => ({ Component: m.PoliciesScreen })) },
    { path: "slices/:sliceId/policies", lazy: () => import("./SlicePoliciesScreen").then((m) => ({ Component: m.SlicePoliciesScreen })) },
  ],
  destination: { to: "/policies", label: "Policy packs", description: "Your organisation's policies and concerns to settle", order: 24 },
};

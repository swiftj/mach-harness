import type { Feature } from "../types";

/**
 * The PRD on-ramp (M13 D): import a PRD, map it to epics and thin slices, settle the sections no
 * slice cites, make the drafts, and confirm a slice's drafted answers. Shell-owned; the screens are
 * PrdListScreen.tsx, PrdScreen.tsx and SlicePrdScreen.tsx.
 */
export const feature: Feature = {
  routes: [
    { path: "prds", lazy: () => import("./PrdListScreen").then((m) => ({ Component: m.PrdListScreen })) },
    { path: "prds/:prdId", lazy: () => import("./PrdScreen").then((m) => ({ Component: m.PrdScreen })) },
    { path: "slices/:sliceId/prd", lazy: () => import("./SlicePrdScreen").then((m) => ({ Component: m.SlicePrdScreen })) },
  ],
  destination: { to: "/prds", label: "Start from a PRD", description: "Turn an approved PRD into epics and slices", order: 26 },
};

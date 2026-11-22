import type { Feature } from "../types";

/**
 * Technical needs (M17): what the product requires of whatever is built, said without technology, and a design the
 * team already has. Optional: a project that never opens it behaves as before. Shell-owned; the screens are in
 * technical/ and design/ (docs/mach-next/M17_APP_FOUNDATION.md). In the product's own navigation beside Vision. No
 * page here shows or offers an ADR act.
 */
export const feature: Feature = {
  routes: [
    { path: "needs", lazy: () => import("./technical/TechnicalNeedsScreen").then((m) => ({ Component: m.TechnicalNeedsScreen })) },
    { path: "needs/design", lazy: () => import("./design/DesignListScreen").then((m) => ({ Component: m.DesignListScreen })) },
    { path: "needs/design/:designId", lazy: () => import("./design/DesignScreen").then((m) => ({ Component: m.DesignScreen })) },
  ],
  // Beside Vision and outcomes (20), before Product principles (22).
  destination: { to: "/needs", label: "Technical needs", description: "What the product requires of whatever is built", order: 21 },
};

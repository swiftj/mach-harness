import type { Feature } from "../types";

/**
 * Product principles (M13 A): one sentence each that must hold in every slice; add, change,
 * retire, publish, and choose a version someone else published. Shell-owned; the screen is
 * PrinciplesScreen.tsx.
 */
export const feature: Feature = {
  routes: [{ path: "principles", lazy: () => import("./PrinciplesScreen").then((m) => ({ Component: m.PrinciplesScreen })) }],
  destination: { to: "/principles", label: "Product principles", description: "Rules every slice must keep", order: 22 },
};

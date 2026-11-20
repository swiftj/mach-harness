import type { Feature } from "../types";

/**
 * Effects on shipped behaviour (M13 B), for one slice. Shell-owned; the screen is
 * SliceEffectsScreen.tsx.
 */
export const feature: Feature = {
  routes: [{ path: "slices/:sliceId/effects", lazy: () => import("./SliceEffectsScreen").then((m) => ({ Component: m.SliceEffectsScreen })) }],
};

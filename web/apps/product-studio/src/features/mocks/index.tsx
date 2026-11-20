import type { Feature } from "../types";

/** Design mocks (M14 C), for one slice. Shell-owned; the screen is SliceMocksScreen.tsx. */
export const feature: Feature = {
  routes: [{ path: "slices/:sliceId/mocks", lazy: () => import("./SliceMocksScreen").then((m) => ({ Component: m.SliceMocksScreen })) }],
};

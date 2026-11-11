import type { Feature } from "../types";

/** The Specification Workspace: one slice, read from `slice.show`. Loaded on demand. */
export const feature: Feature = {
  routes: [{ path: "slices/:sliceId", lazy: () => import("./SpecScreen").then((m) => ({ Component: m.SpecScreen })) }],
};

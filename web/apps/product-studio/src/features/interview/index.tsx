import type { Feature } from "../types";

/** The Guided Intent Interview for one slice. Reached from the slice's specification. Loaded on demand. */
export const feature: Feature = {
  routes: [{ path: "slices/:sliceId/interview", lazy: () => import("./InterviewScreen").then((m) => ({ Component: m.InterviewScreen })) }],
};

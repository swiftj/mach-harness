import type { Feature } from "../types";
import { InterviewScreen } from "./InterviewScreen";

/** The Guided Intent Interview for one slice. Reached from the slice's specification. */
export const feature: Feature = {
  routes: [{ path: "slices/:sliceId/interview", element: <InterviewScreen /> }],
};

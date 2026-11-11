import type { Feature } from "../types";
import { SpecScreen } from "./SpecScreen";

/** The Specification Workspace: one slice, read from `slice.show`. */
export const feature: Feature = {
  routes: [{ path: "slices/:sliceId", element: <SpecScreen /> }],
};

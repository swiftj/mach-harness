import type { Feature } from "../types";
import { HomeScreen } from "./HomeScreen";

/** The project home: the default screen, and the way to everything else. */
export const feature: Feature = {
  routes: [{ index: true, element: <HomeScreen /> }],
};

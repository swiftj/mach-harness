import type { Feature } from "../types";
import { VisionScreen } from "./VisionScreen";

export const feature: Feature = {
  routes: [{ path: "vision", element: <VisionScreen /> }],
  destination: { to: "/vision", label: "Vision and outcomes", description: "The project's vision, outcomes and epics", order: 20 },
};

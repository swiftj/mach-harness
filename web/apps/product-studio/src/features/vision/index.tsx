import { Compass } from "lucide-react";
import type { Feature } from "../types";
import { VisionScreen } from "./VisionScreen";

export const feature: Feature = {
  routes: [{ path: "vision", element: <VisionScreen /> }],
  nav: { to: "/vision", label: "Vision", icon: Compass, section: "work", order: 20 },
};

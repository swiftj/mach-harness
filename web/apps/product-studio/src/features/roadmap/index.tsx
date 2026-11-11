import { Network } from "lucide-react";
import type { Feature } from "../types";
import { RoadmapScreen } from "./RoadmapScreen";

export const feature: Feature = {
  routes: [{ path: "roadmap", element: <RoadmapScreen /> }],
  nav: { to: "/roadmap", label: "Roadmap", icon: Network, section: "work", order: 30 },
};

import { Network } from "lucide-react";
import type { Feature } from "../types";

export const feature: Feature = {
  // Loaded on demand: the map brings React Flow, and ELK on first layout, which no other screen needs.
  routes: [{ path: "roadmap", lazy: () => import("./RoadmapScreen").then((m) => ({ Component: m.RoadmapScreen })) }],
  nav: { to: "/roadmap", label: "Roadmap", icon: Network, section: "work", order: 30 },
};

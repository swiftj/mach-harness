import type { Feature } from "../types";

export const feature: Feature = {
  // Loaded on demand: the map brings React Flow, and ELK on first layout, which no other screen needs.
  routes: [{ path: "roadmap", lazy: () => import("./RoadmapScreen").then((m) => ({ Component: m.RoadmapScreen })) }],
  destination: { to: "/roadmap", label: "Roadmap", description: "Epics and slices as a map, with what depends on what", order: 30 },
};

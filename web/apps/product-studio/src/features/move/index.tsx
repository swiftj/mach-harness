import type { Feature } from "../types";

/**
 * Moving the whole project (M21 F): download it as one file for another repository, bring one in here (always looked at
 * first), finish or set aside one that stopped part way, and look up what an ID was before. Reachable with no project
 * yet, from the start screen, because bringing a project in is the first thing a new repository may need.
 */
export const feature: Feature = {
  routes: [{ path: "move", lazy: () => import("./MoveScreen").then((m) => ({ Component: m.MoveScreen })) }],
  destination: { to: "/move", label: "Move this project", description: "Take it to another repository, or bring one in", order: 75 },
};

import type { Feature } from "../types";

/**
 * Shape (M16): ideas, briefs and the case, before any epic. Optional: a project with no ideas shows one quiet way in
 * (this destination) and nothing else changes. Shell-owned; the screens are in ideas/, explore/, brief/, case/,
 * route/ and lookback/ (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6).
 */
export const feature: Feature = {
  routes: [
    { path: "shape", lazy: () => import("./ideas/IdeasBoardScreen").then((m) => ({ Component: m.IdeasBoardScreen })) },
    { path: "shape/change", lazy: () => import("./route/ChangeScreen").then((m) => ({ Component: m.ChangeScreen })) },
    { path: "shape/ideas/:ideaId", lazy: () => import("./shell/IdeaRedirect").then((m) => ({ Component: m.IdeaRedirect })) },
    { path: "shape/ideas/:ideaId/explore", lazy: () => import("./explore/ExploreScreen").then((m) => ({ Component: m.ExploreScreen })) },
    { path: "shape/ideas/:ideaId/brief", lazy: () => import("./brief/BriefScreen").then((m) => ({ Component: m.BriefScreen })) },
    { path: "shape/ideas/:ideaId/case", lazy: () => import("./case/CaseScreen").then((m) => ({ Component: m.CaseScreen })) },
    { path: "shape/ideas/:ideaId/route", lazy: () => import("./route/RouteScreen").then((m) => ({ Component: m.RouteScreen })) },
    { path: "shape/ideas/:ideaId/look-back", lazy: () => import("./lookback/LookBackScreen").then((m) => ({ Component: m.LookBackScreen })) },
  ],
  // The sketch puts Shape right after the project home: before the project's vision and outcomes.
  destination: { to: "/shape", label: "Shape", description: "Ideas, briefs and the case, before any epic", order: 10 },
};

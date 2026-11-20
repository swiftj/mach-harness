import type { Feature } from "../types";

/**
 * How an epic works today (M13 C), from the slices merged on this computer. Reached from each
 * epic on the project home. Shell-owned; the screen is EpicTodayScreen.tsx.
 */
export const feature: Feature = {
  routes: [{ path: "epics/:epicId/today", lazy: () => import("./EpicTodayScreen").then((m) => ({ Component: m.EpicTodayScreen })) }],
};

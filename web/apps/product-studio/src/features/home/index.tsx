import type { Feature } from "../types";
import { HomeScreen } from "./HomeScreen";

/**
 * The project home: the default screen, and the way to everything else. With no project yet it is the start screen
 * (start/StartScreen.tsx), and a request filed on GitHub is started from on its own page.
 */
export const feature: Feature = {
  routes: [
    { index: true, element: <HomeScreen /> },
    { path: "start/requests/:number", lazy: () => import("./start/RequestStartScreen").then((m) => ({ Component: m.RequestStartScreen })) },
  ],
};

import type { Feature } from "../types";
import { SharedScreen } from "./SharedScreen";

/** Collaboration and refresh: bring in what other product managers shared, and where everything stands. */
export const feature: Feature = {
  routes: [{ path: "shared", element: <SharedScreen /> }],
  destination: { to: "/shared", label: "Shared project", description: "What others have shared, and where everything stands", order: 60 },
};

import type { Feature } from "../types";
import { GithubScreen } from "./GithubScreen";

/** Where the project, its epics and its slices stand on GitHub, read when the PM refreshes. */
export const feature: Feature = {
  routes: [{ path: "github", element: <GithubScreen /> }],
  destination: { to: "/github", label: "On GitHub", description: "Your project, epics and slices as saved for the builders", order: 60 },
};

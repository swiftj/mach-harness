import { RefreshCw } from "lucide-react";
import type { Feature } from "../types";
import { SharedScreen } from "./SharedScreen";

/** Collaboration and refresh: bring in what other product managers shared, and where everything stands. */
export const feature: Feature = {
  routes: [{ path: "shared", element: <SharedScreen /> }],
  nav: { to: "/shared", label: "Shared project", icon: RefreshCw, section: "deliver", order: 60 },
};

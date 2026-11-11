import { House } from "lucide-react";
import type { Feature } from "../types";
import { WorkspaceScreen } from "./WorkspaceScreen";

export const feature: Feature = {
  routes: [{ index: true, element: <WorkspaceScreen /> }],
  nav: { to: "/", label: "Workspace", icon: House, section: "work", order: 10 },
};

import type { ComponentType } from "react";
import type { RouteObject } from "react-router";

/** One entry in the navigation rail. A feature without one is reached from other screens. */
export interface NavEntry {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  section: "work" | "attention" | "deliver";
  order: number;
}

/** What every feature folder exports from its index.tsx. Routes are children of the app layout. */
export interface Feature {
  routes: RouteObject[];
  nav?: NavEntry;
}

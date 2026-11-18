import type { RouteObject } from "react-router";

/**
 * A secondary screen, reached from the project home's row of links and the top bar's "More" menu.
 * A feature without one is reached from other screens (a slice's specification, its interview).
 */
export interface Destination {
  to: string;
  label: string;
  /** One line in the "More" menu: what the screen is for. */
  description: string;
  order: number;
}

/** What every feature folder exports from its index.tsx. Routes are children of the app layout. */
export interface Feature {
  routes: RouteObject[];
  destination?: Destination;
}

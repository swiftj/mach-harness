import type { Destination, Feature } from "./types";
import { feature as home } from "./home";
import { feature as vision } from "./vision";
import { feature as roadmap } from "./roadmap";
import { feature as spec } from "./spec";
import { feature as interview } from "./interview";
import { feature as inbox } from "./inbox";
import { feature as waves } from "./waves";
import { feature as activity } from "./activity";

/** Every feature of the app. Add a folder under features/ and list it here; nothing else needs to change. */
export const features: Feature[] = [home, vision, roadmap, spec, interview, inbox, waves, activity];

export const routes = features.flatMap((feature) => feature.routes);

/** The secondary screens, in menu order. The project home is the default screen and leads to each. */
export const destinations: Destination[] = features.flatMap((feature) => (feature.destination ? [feature.destination] : [])).sort((a, b) => a.order - b.order);

/** The secondary screen a path belongs to, if any. */
export const destinationFor = (path: string): Destination | undefined => destinations.find((d) => path === d.to || path.startsWith(`${d.to}/`));

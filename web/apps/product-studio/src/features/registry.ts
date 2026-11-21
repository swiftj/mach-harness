import type { Destination, Feature } from "./types";
import { feature as home } from "./home";
import { feature as vision } from "./vision";
import { feature as roadmap } from "./roadmap";
import { feature as spec } from "./spec";
import { feature as interview } from "./interview";
import { feature as inbox } from "./inbox";
import { feature as activity } from "./activity";
// M15: the screens for what M13 and M14 added (docs/mach-next/M15_STUDIO_FOUNDATION.md).
import { feature as principles } from "./principles";
import { feature as policies } from "./policies";
import { feature as effects } from "./effects";
import { feature as epicToday } from "./epic-today";
import { feature as prd } from "./prd";
import { feature as jira } from "./jira";
import { feature as mocks } from "./mocks";
// M16: Shape (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md).
import { feature as shape } from "./shape";
// M17: Technical needs (docs/mach-next/M17_APP_FOUNDATION.md).
import { feature as needs } from "./needs";

/** Every feature of the app. Add a folder under features/ and list it here; nothing else needs to change. */
export const features: Feature[] = [home, vision, roadmap, spec, interview, inbox, activity, principles, policies, effects, epicToday, prd, jira, mocks, shape, needs];

export const routes = features.flatMap((feature) => feature.routes);

/** The secondary screens, in menu order. The project home is the default screen and leads to each. */
export const destinations: Destination[] = features.flatMap((feature) => (feature.destination ? [feature.destination] : [])).sort((a, b) => a.order - b.order);

/** The secondary screen a path belongs to, if any. */
export const destinationFor = (path: string): Destination | undefined => destinations.find((d) => path === d.to || path.startsWith(`${d.to}/`));

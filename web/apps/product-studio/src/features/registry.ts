import type { Feature, NavEntry } from "./types";
import { feature as workspace } from "./workspace";
import { feature as vision } from "./vision";
import { feature as roadmap } from "./roadmap";
import { feature as spec } from "./spec";
import { feature as interview } from "./interview";
import { feature as inbox } from "./inbox";
import { feature as waves } from "./waves";
import { feature as activity } from "./activity";

/** Every feature of the app. Add a folder under features/ and list it here; nothing else needs to change. */
export const features: Feature[] = [workspace, vision, roadmap, spec, interview, inbox, waves, activity];

export const routes = features.flatMap((feature) => feature.routes);

export const navigation: NavEntry[] = features.flatMap((feature) => (feature.nav ? [feature.nav] : [])).sort((a, b) => a.order - b.order);

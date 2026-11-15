/**
 * The M6.0 scenario: one deterministic run, built once from the script in story.ts. Building it
 * again gives the same events, byte for byte.
 */
import type { Fixture } from "../model";
import { buildScenario } from "./story";

export { buildScenario, tickAfter } from "./story";
export { CONTENT, DEFINITIONS, PEOPLE, PROJECT, SLICE_IDS, TICKETS, WAVE } from "./content";
export { SCENARIO_START, SCENARIO_START_MS, isoAt } from "./recorder";

/** The fixture every view renders. */
export const SCENARIO: Fixture = buildScenario();

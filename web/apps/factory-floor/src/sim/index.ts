/**
 * The simulation's public API. Views import from here (`../sim`) and nowhere deeper.
 * See README.md in this folder.
 */
export * from "./vocabulary";
export * from "./events";
export * from "./model";
export { EVENT_CATALOG, CATALOG_ENTRIES } from "./catalog";
export type { CatalogEntry, Telemetry, Significance } from "./catalog";
export { sceneAt, sceneAtCursor, finalScene, cursorAt, indexFixture, fixtureLog, SIM_CHECKPOINT_EVERY } from "./engine";
export type { SimIndex } from "./engine";
export * from "./provenance";
export * from "./v3";
export { createSceneLog, isSceneLog, reuse } from "./log";
export type { LogEntry, SceneLog, SceneLogOptions, IngestResult, LogStats } from "./log";
export { describeEntry, describeV3, significanceOf } from "./describe-v3";
export { modelIdOf, gapClassOf } from "./reduce-v3";
export { emptyScene, reduce } from "./reducer";
export * from "./selectors";
export * from "./gates";
export * from "./fold";
export { describe } from "./describe";
export { actorOf, ACTOR_INFO, ACTOR_KINDS } from "./actors";
export { progress, spanProgress, ease, easeOut, motionProgress, MOTION } from "./motion";
export { SCENARIO, buildScenario, tickAfter, PEOPLE, PROJECT, WAVE, TICKETS, SLICE_IDS, SCENARIO_START, isoAt } from "./scenario";

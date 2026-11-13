/** The hierarchical track model (design section 4): both groupings, filters, layout. */
export { buildTrackTree, markTrackOf } from "./build";
export { layoutRows, defaultExpanded } from "./layout";
/** Additive, for the investigation lenses: no contract change. */
export { spansOnTrack, ancestorsOf, roundsOf, attemptsOf, type RoundOf, type AttemptOf, type AttemptVisit, type Bounds } from "./lens";

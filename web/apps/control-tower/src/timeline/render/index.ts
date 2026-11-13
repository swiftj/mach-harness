/**
 * The Execution Timeline's canvas part (design sections 3B and 5): the hierarchical tracks, their
 * sticky labels, the window's ruler, and the words of the timing grammar. Siblings import only these.
 */
export { TrackCanvas } from "./TrackCanvas";
export { TrackLabels, LABEL_DEFAULT, LABEL_MIN, LABEL_MAX } from "./TrackLabels";
export { WindowRuler } from "./WindowRuler";
export { describeSpan, durationWords, nodeState, countsWords, shownCounts, fitLabel, openWord } from "./words";

/**
 * The Timeline's accessibility part (design section 9): the structured alternative (a virtualised
 * tree-grid of the same tree and window) and the screen-reader descriptions shared with the canvas's
 * live region and the workspace's visually hidden summary of the window.
 */
export { TimelineTable } from "./TimelineTable";
export { rowSummary, windowSummary, summaryWords, attentionWords } from "./describe";
export { GRID_KEYS } from "./model";

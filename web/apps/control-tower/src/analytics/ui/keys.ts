/**
 * What a key pressed on a chart's mark does. A chart owns the keys it moves or acts with: they never
 * reach the Control Tower's own shortcuts (Space plays and pauses, the arrows step the playhead), even
 * on a mark that has no action. Pure, so the test runner checks it (test/analytics-ui-keys.test.mjs).
 */

/** The keys a chart keeps for itself. */
export const CHART_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter", " ", "Spacebar", "Escape"]);

export interface ChartKeyOutcome {
  /** Stop the event at the chart: the shell never sees it. */
  readonly stop: boolean;
  /** Cancel the browser's default (scrolling the sheet on Space or an arrow). */
  readonly prevent: boolean;
  /** Run the mark's action. */
  readonly activate: boolean;
}

export function chartKey(key: string, hasAction: boolean, modifiers: { readonly ctrl?: boolean; readonly meta?: boolean; readonly alt?: boolean } = {}): ChartKeyOutcome {
  // A chord with Ctrl, Meta or Alt is the browser's or the system's, never the chart's.
  if (modifiers.ctrl || modifiers.meta || modifiers.alt || !CHART_KEYS.has(key)) return { stop: false, prevent: false, activate: false };
  const press = key === "Enter" || key === " " || key === "Spacebar";
  return { stop: true, prevent: true, activate: press && hasAction };
}

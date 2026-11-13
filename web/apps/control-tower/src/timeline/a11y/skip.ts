/**
 * "Skip to the tracks" (round 6, defect 16): the Timeline's tracks were 32 Tab stops from the top of the
 * page (the header, the transport and the toolbar come first). The shell's skip links are the page's
 * first Tab stops; this one, offered while the Timeline is up, moves focus straight to where the tracks
 * are worked by keyboard: the canvas (its `role=application`, keys named in its aria-describedby) or, in
 * the table, the grid's focusable row (its roving tab stop), else the grid itself.
 *
 * Nothing else changes: the toolbars keep their Tab stops and every shortcut stays as it was.
 */

/** The part of `Element` the lookup uses, so the order is testable without a DOM. */
export interface Queryable {
  querySelector(selector: string): unknown;
}

/** In order of preference: the canvas, the table's focusable row, the table. */
export const TRACKS_TARGETS = [
  "[data-timeline-workspace] [role=application]",
  '[data-timeline-workspace] [role=treegrid] [role=row][tabindex="0"]',
  "[data-timeline-workspace] [role=treegrid]",
] as const;

/** Where "Skip to the tracks" puts focus, or null when the tracks are not drawn yet (loading, empty). */
export function tracksFocusTarget<T>(root: Queryable): T | null {
  for (const selector of TRACKS_TARGETS) {
    const el = root.querySelector(selector);
    if (el) return el as T;
  }
  return null;
}

/** Moves focus to the tracks; falls back to `fallback` (the stage) when they are not drawn. True when the tracks took it. */
export function focusTracks(root: Queryable, fallback: { focus(): void } | null): boolean {
  const el = tracksFocusTarget<{ focus(options?: { preventScroll?: boolean }): void }>(root);
  if (el) {
    el.focus();
    return true;
  }
  fallback?.focus();
  return false;
}

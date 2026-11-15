/**
 * Whether the person is dragging the playhead (the ruler or the tracks), for the stage: while a drag
 * lasts the hidden view is not updated at all, and it is brought up to date once, when the drag ends
 * (findings, scrubbing row). Interface state only; the scene store does not know about it.
 */
let dragging = false;
const listeners = new Set<(dragging: boolean) => void>();

export function isScrubbing(): boolean {
  return dragging;
}

export function setScrubbing(next: boolean): void {
  if (next === dragging) return;
  dragging = next;
  for (const l of [...listeners]) l(next);
}

export function onScrubbing(listener: (dragging: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

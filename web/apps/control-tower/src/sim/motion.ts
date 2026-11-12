/**
 * Motion as a function of the playhead. A view never keeps progress of its own: it asks how far
 * along an event-driven motion is at time t, so pausing, scrubbing and changing speed always show
 * the right frame. All functions are pure.
 */

/** 0 before `start`, 1 after `start + duration`, linear in between. */
export function progress(t: number, start: number, duration: number): number {
  if (duration <= 0) return t >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (t - start) / duration));
}

/** Progress through a span that may still be open (`end` null: not finished at t). */
export function spanProgress(t: number, start: number, end: number | null, expected: number): number {
  if (end !== null && t >= end) return 1;
  return Math.min(0.98, progress(t, start, end !== null ? end - start : expected));
}

/** Smooth ease for interface-scale motion (cubic in and out). */
export function ease(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Ease out, for things that arrive. */
export function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

/**
 * The standard motion lengths, in factory milliseconds. Factory time runs faster than wall time
 * (see PLAYBACK_BASE_RATE in src/scene), so these are long in factory terms and short on screen.
 */
export const MOTION = {
  /** A packet travelling between stations, a route drawing. */
  travel: 20_000,
  /** A gate closing or opening. */
  gate: 8_000,
  /** An artifact appearing. */
  appear: 6_000,
  /** A highlight fading after an event. */
  afterglow: 30_000,
} as const;

/**
 * Under prefers-reduced-motion, any motion that has started is shown at its end state: state
 * changes without travel. Pass the store's `reducedMotion` flag.
 */
export function motionProgress(t: number, start: number, duration: number, reducedMotion: boolean): number {
  if (reducedMotion) return t >= start ? 1 : 0;
  return progress(t, start, duration);
}

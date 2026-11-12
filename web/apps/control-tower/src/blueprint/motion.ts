/**
 * Factory motion for the Blueprint, as a function of the playhead (M6_0_VISUAL_SPEC.md e).
 *
 * Every hook here subscribes to the store with a selector that returns a quantised number, so a
 * component re-renders only while its own motion is in progress, and settles (returns a constant)
 * before and after. Elapsed factory time is converted to the 1x wall time the grammar's durations
 * are written in, so an animation lasts the same share of the run at any speed and scrubbing
 * backwards shows the earlier frame.
 */
import { animationProgress, type FactoryAnimationName } from "@mach/ui";
import { PLAYBACK_BASE_RATE, useSceneStore, type SceneStoreState } from "../scene";

const STEPS = 48;

/** Progress 0..1 of a named grammar animation whose event happened at factory time `at`. */
export function eventProgress(s: Pick<SceneStoreState, "playhead" | "reducedMotion">, at: number | null | undefined, name: FactoryAnimationName, delay = 0): number {
  if (at === null || at === undefined) return 0;
  const elapsed = (s.playhead - at) / PLAYBACK_BASE_RATE;
  return Math.round(animationProgress(name, elapsed, { reduced: s.reducedMotion, delay }) * STEPS) / STEPS;
}

export function useEventProgress(at: number | null | undefined, name: FactoryAnimationName, delay = 0): number {
  return useSceneStore((s) => eventProgress(s, at, name, delay));
}

/** The playhead, floored to `step` factory ms (1000: a clock that ticks once per factory second). */
export function usePlayhead(step = 1000): number {
  return useSceneStore((s) => Math.floor(s.playhead / step) * step);
}

/** Whether the playhead has reached `at` (for things that exist from an event on). */
export function useReached(at: number): boolean {
  return useSceneStore((s) => s.playhead >= at);
}

/** x of the playhead on an axis, to half a pixel, or null when it is outside the axis. */
export function usePlayheadX(x0: number, width: number, start: number, end: number): number | null {
  return useSceneStore((s) => {
    if (s.playhead < start || s.playhead > end) return null;
    return Math.round((x0 + ((s.playhead - start) / (end - start)) * width) * 2) / 2;
  });
}

export function useReducedMotion(): boolean {
  return useSceneStore((s) => s.reducedMotion);
}

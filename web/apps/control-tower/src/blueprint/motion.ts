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
import { isStale, PLAYBACK_BASE_RATE, useSceneStore, type SceneStoreState } from "../scene";

const STEPS = 48;

/**
 * Factory ms per 1x wall ms: the simulation and a replay play their history at PLAYBACK_BASE_RATE;
 * live time runs at the wall's own pace, so a live animation lasts what the grammar says.
 */
function rateOf(s: Pick<SceneStoreState, "source">): number {
  return s.source === "live" ? 1 : PLAYBACK_BASE_RATE;
}

/**
 * Progress 0..1 of a named grammar animation whose event happened at factory time `at`. `late`: the
 * event reached the history after events that sort after it (the log inserted it where it belongs).
 * Its mark then takes the reduced form, a brief state change, never a travel replayed from the start:
 * the person was not shown it happening, so the drawing must not pretend they are.
 */
export function eventProgress(s: Pick<SceneStoreState, "playhead" | "reducedMotion" | "source">, at: number | null | undefined, name: FactoryAnimationName, delay = 0, late = false): number {
  if (at === null || at === undefined) return 0;
  const elapsed = (s.playhead - at) / rateOf(s);
  return Math.round(animationProgress(name, elapsed, { reduced: s.reducedMotion || late, delay }) * STEPS) / STEPS;
}

export function useEventProgress(at: number | null | undefined, name: FactoryAnimationName, delay = 0, late = false): number {
  return useSceneStore((s) => eventProgress(s, at, name, delay, late));
}

/**
 * Whether the event that last set an entity arrived late (see `eventProgress`). Simulation entities
 * carry no event id and are never late.
 */
export function useLate(eventId: string | null | undefined): boolean {
  return useSceneStore((s) => (eventId ? (s.log.entry(eventId)?.late ?? false) : false));
}

/**
 * The connection is stale or lost (live only): the last confirmed moment, else null. While it is set
 * nothing on the sheet may be drawn as executing, and nothing moves: the playhead stops at the edge
 * (the store no longer carries it forward) and work in flight is drawn as last seen.
 */
export function useStaleSince(): number | null {
  return useSceneStore((s) => (isStale(s.connection) ? (s.connection?.staleSince ?? s.liveAt) : null));
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

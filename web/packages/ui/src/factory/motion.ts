import { factoryTokens } from "../tokens/tokens";

/**
 * Factory motion is a pure function of the playhead. Every animation is computed from
 * `elapsed = playhead - event.at` (ms), so scrubbing backwards, pausing and changing speed always
 * show the right frame. Nothing here reads a clock, keeps state or draws a random number.
 *
 *   const p = animationProgress("packetTravel", playhead - event.at, { reduced });
 *   <Packet at={pointAlong(route, p).point} />
 */

export type Easing = (t: number) => number;

export function clamp01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A CSS-style cubic-bezier easing as a pure function (Newton's method, then bisection). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    const v = clamp01(x);
    if (v === 0 || v === 1) return v;
    let t = v;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - v;
      if (Math.abs(err) < 1e-5) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = v;
    for (let i = 0; i < 24; i++) {
      const s = sx(t);
      if (Math.abs(s - v) < 1e-5) break;
      if (s < v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/**
 * The factory's curves. `standard`, `enter` and `exit` are the design system's own. The rest are
 * the factory's: `travel` for anything moving along a route (accelerates out of a station, settles
 * into the next), `draw` for a line being drawn, `settle` for things arriving, `refuse` for a gate
 * that drops back shut (a single damped overshoot that ends exactly at 1).
 */
export const easings = {
  linear: (t: number) => clamp01(t),
  standard: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0, 0, 0, 1),
  exit: cubicBezier(0.4, 0, 1, 1),
  travel: cubicBezier(0.45, 0, 0.25, 1),
  draw: cubicBezier(0.3, 0, 0.2, 1),
  settle: cubicBezier(0.16, 0.84, 0.3, 1),
  refuse: (t: number) => {
    const v = clamp01(t);
    if (v === 1) return 1;
    // Drops in the first 35%, overshoots by 12%, then settles; continuous and pure.
    if (v < 0.35) return cubicBezier(0.5, 0, 0.9, 0.6)(v / 0.35) * 1.12;
    const k = (v - 0.35) / 0.65;
    return 1 + 0.12 * Math.cos(k * Math.PI * 1.5) * (1 - k) * (1 - k);
  },
} satisfies Record<string, Easing>;

export type EasingName = keyof typeof easings;

/** Every factory animation, with its trigger, duration, curve and reduced-motion treatment. */
export type ReducedTreatment = "snap" | "fade";

export interface FactoryAnimation {
  duration: number;
  easing: EasingName;
  /** snap: jump to the end state at the event; fade: a 160ms opacity change with no travel. */
  reduced: ReducedTreatment;
}

const m = factoryTokens.motion;

export const factoryAnimations = {
  packetTravel: { duration: m.packetTravel, easing: "travel", reduced: "snap" },
  pathDraw: { duration: m.pathDraw, easing: "draw", reduced: "fade" },
  agentArrive: { duration: m.agentArrive, easing: "settle", reduced: "fade" },
  agentLeave: { duration: m.agentLeave, easing: "exit", reduced: "fade" },
  toolTick: { duration: m.toolTick, easing: "settle", reduced: "snap" },
  artifactMaterialise: { duration: m.artifactMaterialise, easing: "settle", reduced: "fade" },
  artifactHandoff: { duration: m.artifactHandoff, easing: "travel", reduced: "snap" },
  gateClose: { duration: m.gateClose, easing: "standard", reduced: "snap" },
  gateOpen: { duration: m.gateOpen, easing: "settle", reduced: "snap" },
  gateRefuse: { duration: m.gateRefuse, easing: "refuse", reduced: "snap" },
  testResult: { duration: m.testResult, easing: "settle", reduced: "snap" },
  verifyReturn: { duration: m.verifyReturn, easing: "travel", reduced: "snap" },
  fanOut: { duration: m.fanOut, easing: "draw", reduced: "fade" },
  voteConverge: { duration: m.voteConverge, easing: "travel", reduced: "snap" },
  humanRelease: { duration: m.humanRelease, easing: "settle", reduced: "snap" },
  mergeIntegrate: { duration: m.mergeIntegrate, easing: "travel", reduced: "fade" },
  dependencyUnlock: { duration: m.dependencyUnlock, easing: "standard", reduced: "snap" },
  cellComplete: { duration: m.cellComplete, easing: "settle", reduced: "fade" },
  stateChange: { duration: m.stateChange, easing: "standard", reduced: "snap" },
} satisfies Record<string, FactoryAnimation>;

export type FactoryAnimationName = keyof typeof factoryAnimations;

const FADE_MS = 160;

/**
 * Progress 0..1 of a named animation, `elapsed` ms after its event. Negative elapsed (the playhead is
 * before the event) is 0. Under reduced motion, `snap` animations jump to 1 at the event and `fade`
 * animations return a 160ms linear ramp the caller applies to opacity only (never to position).
 */
export function animationProgress(
  name: FactoryAnimationName,
  elapsed: number,
  options: { reduced?: boolean; duration?: number; delay?: number } = {},
): number {
  const spec: FactoryAnimation = factoryAnimations[name];
  const t = elapsed - (options.delay ?? 0);
  if (t < 0) return 0;
  if (options.reduced) return spec.reduced === "snap" ? 1 : clamp01(t / FADE_MS);
  const duration = options.duration ?? spec.duration;
  if (duration <= 0) return 1;
  return easings[spec.easing](t / duration);
}

/** Progress of a span of work (an agent working, a station running) from its start and end events. */
export function spanProgress(playhead: number, startAt: number, endAt: number | undefined): number {
  if (playhead <= startAt) return 0;
  if (endAt === undefined || endAt <= startAt) return 0;
  return clamp01((playhead - startAt) / (endAt - startAt));
}

/** The delay of item `i` in a staggered group: fan-out branches, accumulating test results. */
export function staggerDelay(i: number, each: number, cap = Infinity): number {
  return Math.min(i * each, cap);
}

/** Map progress `p` onto the sub-interval [from, to] of an animation: 0 before, 1 after. */
export function segment(p: number, from: number, to: number): number {
  if (to <= from) return p >= to ? 1 : 0;
  return clamp01((p - from) / (to - from));
}

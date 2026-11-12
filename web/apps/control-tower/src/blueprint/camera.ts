/**
 * The camera (M6_0_VISUAL_SPEC.md f.1): one translation and scale, applied as a CSS transform on the
 * stage. Zoom 0.35 to 3. The sheet is paper on a desk: it never slides away to leave empty desk where
 * there is more drawing to show (see `clamp`). Focus frames a rectangle with a padding of 64 px or 12%
 * of the viewport, at no more than 2.2x, clear of what is pinned over the stage.
 */
import type { Rect } from "./layout";

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export interface Size {
  readonly w: number;
  readonly h: number;
}

export const ZOOM = { min: 0.35, max: 3, focusMax: 2.2 } as const;

/**
 * Keep the sheet where it can be read. Along each axis: if the sheet at this zoom is longer than the
 * stage, its edges may not come inside the stage's edges (no empty space above, left, below or right
 * while there is drawing beyond the other edge); if it is shorter, it is centred (there is nothing to
 * pan to). This is what a document viewer does, and it is why a focus near the top of the sheet sits at
 * the top of the stage rather than under a band of empty ground.
 */
export function clamp(c: Camera, view: Size, sheet: Size): Camera {
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, c.k));
  return { x: axis(c.x, view.w, sheet.w * k), y: axis(c.y, view.h, sheet.h * k), k };
}

function axis(at: number, view: number, length: number): number {
  if (length <= view) return (view - length) / 2;
  return Math.min(0, Math.max(view - length, at));
}

export function fitCamera(view: Size, rect: Rect): Camera {
  const pad = Math.max(24, Math.min(view.w, view.h) * 0.04);
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.min((view.w - pad * 2) / rect.w, (view.h - pad * 2) / rect.h)));
  return { x: (view.w - rect.w * k) / 2 - rect.x * k, y: (view.h - rect.h * k) / 2 - rect.y * k, k };
}

/**
 * What is pinned over the stage and would cover a framed target: along the top, the zone ruler and the
 * column head; along the left, the lanes' gutter. Each is a fixed part in screen px plus a part that
 * scales with the zoom (sheet units). `leftFrom` is the sheet x from which the gutter covers the drawing:
 * a target that starts left of it (a whole lane, with its own gutter) needs no room kept for it.
 */
export interface Reserve {
  readonly topPx: number;
  readonly top: number;
  readonly leftPx: number;
  readonly left: number;
  readonly leftFrom: number;
}

const NO_RESERVE: Reserve = { topPx: 0, top: 0, leftPx: 0, left: 0, leftFrom: Infinity };

/**
 * Frame a rectangle: fit it (never closer than 2.2x), centred in the part of the stage that nothing
 * pinned covers. A rectangle taller than the view at the zoom that fits its width (a long lane) is not
 * shrunk to fit its height: it is anchored at the top, so the reader starts at its title and reads down.
 * The caller clamps the result.
 */
export function focusCamera(view: Size, rect: Rect, reserve: Reserve = NO_RESERVE, minK: number = ZOOM.min): Camera {
  const pad = Math.max(64, Math.min(view.w, view.h) * 0.12);
  const gutter = rect.x >= reserve.leftFrom;
  // The room on the left grows with the zoom, so the zoom that fits the width solves for both at once.
  const left = (k: number): number => (gutter ? reserve.leftPx + reserve.left * k : 0);
  const kW = (view.w - pad * 2 - (gutter ? reserve.leftPx : 0)) / (rect.w + (gutter ? reserve.left : 0));
  const top = (k: number): number => reserve.topPx + reserve.top * k;
  const kH = (view.h - pad * 2 - reserve.topPx) / (rect.h + reserve.top);
  const fitted = Math.min(kW, Math.max(kH, Math.min(kW, 1)));
  // Never closer than 2.2x; never further out than the level of detail the target is read at (spec f.1:
  // "not below the current level's lower threshold for that entity type").
  const k = Math.min(ZOOM.focusMax, Math.max(ZOOM.min, minK, fitted));
  const l = left(k);
  const t = top(k);
  // Wider than the stage at that zoom: start at its left, where a lane's title is.
  const wide = rect.w * k > view.w - l - pad * 0.7;
  const x = wide ? l + pad * 0.35 - rect.x * k : l + (view.w - l - rect.w * k) / 2 - rect.x * k;
  const tall = rect.h * k > view.h - t - pad * 2;
  const y = tall ? t + pad * 0.35 - rect.y * k : t + (view.h - t - rect.h * k) / 2 - rect.y * k;
  return { x, y, k };
}

/** Where a sheet rectangle is on the stage, in px. */
export function onScreen(c: Camera, r: Rect): Rect {
  return { x: c.x + r.x * c.k, y: c.y + r.y * c.k, w: r.w * c.k, h: r.h * c.k };
}

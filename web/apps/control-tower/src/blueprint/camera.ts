/**
 * The camera (M6_0_VISUAL_SPEC.md f.1): one translation and scale, applied as a CSS transform on the
 * stage. Zoom 0.35 to 3; at least 20% of the sheet stays on screen; focus frames a rectangle with a
 * padding of 64 px or 12% of the viewport, at no more than 2.2x.
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

export function clamp(c: Camera, view: Size, sheet: Size): Camera {
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, c.k));
  const sw = sheet.w * k;
  const sh = sheet.h * k;
  const keepX = Math.min(view.w, sw) * 0.2;
  const keepY = Math.min(view.h, sh) * 0.2;
  const x = Math.min(view.w - keepX, Math.max(keepX - sw, c.x));
  const y = Math.min(view.h - keepY, Math.max(keepY - sh, c.y));
  return { x, y, k };
}

export function fitCamera(view: Size, rect: Rect): Camera {
  const pad = Math.max(24, Math.min(view.w, view.h) * 0.04);
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.min((view.w - pad * 2) / rect.w, (view.h - pad * 2) / rect.h)));
  return { x: (view.w - rect.w * k) / 2 - rect.x * k, y: (view.h - rect.h * k) / 2 - rect.y * k, k };
}

/**
 * Frame a rectangle: fit it (never closer than 2.2x), centred. A rectangle taller than the view at the
 * zoom that fits its width (a long lane) is not shrunk to fit its height: it is anchored at the top, so
 * the reader starts at its title and reads down.
 */
export function focusCamera(view: Size, rect: Rect): Camera {
  const pad = Math.max(64, Math.min(view.w, view.h) * 0.12);
  const kW = (view.w - pad * 2) / rect.w;
  const kH = (view.h - pad * 2) / rect.h;
  const k = Math.min(ZOOM.focusMax, Math.max(ZOOM.min, Math.min(kW, Math.max(kH, Math.min(kW, 1)))));
  const x = (view.w - rect.w * k) / 2 - rect.x * k;
  const tall = rect.h * k > view.h - pad * 2;
  const y = tall ? pad * 0.5 - rect.y * k : (view.h - rect.h * k) / 2 - rect.y * k;
  return { x, y, k };
}

/**
 * The Atlas camera: one `{ x, y, zoom }` applied as a CSS transform on the scene wrapper (spec f.1).
 * This is interface state, the only state the Atlas keeps besides hover; it never touches factory
 * progress. Easing here is interface motion (camera focus 650 ms, follow 900 ms, standard curve),
 * driven by requestAnimationFrame and performance.now, never by the playhead.
 */
import { easings, factoryTokens } from "@mach/ui";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraStore {
  get(): Camera;
  set(next: Camera, opts?: { user?: boolean }): void;
  subscribe(listener: (cam: Camera, user: boolean) => void): () => void;
  /** Ease to a camera over `ms` (interface motion); `0` cuts. Cancelled by any later set. */
  animateTo(target: Camera, ms: number): void;
  /** The viewport size in CSS px. */
  viewport: { width: number; height: number };
  /** The plant's projected bounds, for clamping. */
  bounds: ScreenRect;
}

const Z = factoryTokens.zoom;

export function clampZoom(z: number): number {
  return Math.min(Z.max, Math.max(Z.min, z));
}

export function createCamera(bounds: ScreenRect): CameraStore {
  let cam: Camera = { x: 0, y: 0, zoom: 1 };
  const listeners = new Set<(cam: Camera, user: boolean) => void>();
  let raf: number | null = null;
  const store: CameraStore = {
    viewport: { width: 1, height: 1 },
    bounds,
    get: () => cam,
    set(next, opts) {
      if (raf !== null && opts?.user) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      cam = clampPan({ ...next, zoom: clampZoom(next.zoom) }, store);
      for (const l of [...listeners]) l(cam, Boolean(opts?.user));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    animateTo(target, ms) {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      if (ms <= 0) {
        store.set(target);
        return;
      }
      const from = cam;
      const t0 = performance.now();
      const lz0 = Math.log(from.zoom);
      const lz1 = Math.log(clampZoom(target.zoom));
      const step = (now: number) => {
        const k = easings.standard(Math.min(1, (now - t0) / ms));
        const zoom = Math.exp(lz0 + (lz1 - lz0) * k);
        // Interpolate the world point at the viewport centre, so the frame glides rather than swings.
        const vw = store.viewport.width / 2;
        const vh = store.viewport.height / 2;
        const c0 = { x: (vw - from.x) / from.zoom, y: (vh - from.y) / from.zoom };
        const c1 = { x: (vw - target.x) / target.zoom, y: (vh - target.y) / target.zoom };
        const cx = c0.x + (c1.x - c0.x) * k;
        const cy = c0.y + (c1.y - c0.y) * k;
        cam = clampPan({ zoom, x: vw - cx * zoom, y: vh - cy * zoom }, store);
        for (const l of [...listeners]) l(cam, false);
        raf = k < 1 ? requestAnimationFrame(step) : null;
      };
      raf = requestAnimationFrame(step);
    },
  };
  return store;
}

/** Keep at least 20% of the plant's bounds on screen (spec f.1). */
function clampPan(cam: Camera, store: CameraStore): Camera {
  const b = store.bounds;
  const { width: vw, height: vh } = store.viewport;
  const minVisW = Math.min(b.width * cam.zoom * 0.2, vw * 0.5);
  const minVisH = Math.min(b.height * cam.zoom * 0.2, vh * 0.5);
  const left = b.x * cam.zoom + cam.x;
  const right = (b.x + b.width) * cam.zoom + cam.x;
  const top = b.y * cam.zoom + cam.y;
  const bottom = (b.y + b.height) * cam.zoom + cam.y;
  let { x, y } = cam;
  if (right < minVisW) x += minVisW - right;
  if (left > vw - minVisW) x -= left - (vw - minVisW);
  if (bottom < minVisH) y += minVisH - bottom;
  if (top > vh - minVisH) y -= top - (vh - minVisH);
  return { x, y, zoom: cam.zoom };
}

/** The camera that frames a screen rect in the viewport, padded by max(64 px, 12%). */
export function frame(rect: ScreenRect, viewport: { width: number; height: number }, maxZoom = 2.2, minZoom: number = Z.min): Camera {
  const pad = Math.max(64, Math.min(viewport.width, viewport.height) * 0.12);
  const zw = (viewport.width - pad * 2) / Math.max(1, rect.width);
  const zh = (viewport.height - pad * 2) / Math.max(1, rect.height);
  const zoom = clampZoom(Math.max(minZoom, Math.min(maxZoom, zw, zh)));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return { zoom, x: viewport.width / 2 - cx * zoom, y: viewport.height / 2 - cy * zoom };
}

/** Zoom by `factor` keeping the world point under (cx, cy) fixed (spec f.1). */
export function zoomAt(cam: Camera, factor: number, cx: number, cy: number): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  const k = zoom / cam.zoom;
  return { zoom, x: cx - (cx - cam.x) * k, y: cy - (cy - cam.y) * k };
}

/** The world (projected) rect visible in the viewport. */
export function visibleRect(cam: Camera, viewport: { width: number; height: number }): ScreenRect {
  return { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: viewport.width / cam.zoom, height: viewport.height / cam.zoom };
}

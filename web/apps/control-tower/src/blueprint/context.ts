/**
 * What the view shares with its parts without re-rendering the drawing:
 * - the camera, as a tiny external store (the overlays and the minimap subscribe; the drawing does not);
 * - the layers that pinned parts are portalled into (gutters that stay at the left edge when the camera
 *   pans, the column head that stays at the top), and whether lanes are animating an expansion;
 * - a registry of tool-call positions per agent lane, for hit-testing the batched ticks.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import type { EntityRef } from "../sim";
import type { Camera } from "./camera";

export interface CameraStore {
  get(): Camera;
  set(c: Camera): void;
  subscribe(fn: () => void): () => void;
  /** The stage's size in CSS px (the container, not the window). */
  size(): { w: number; h: number };
  setSize(source: () => { w: number; h: number }): void;
}

export function createCameraStore(): CameraStore {
  let cam: Camera = { x: 0, y: 0, k: 1 };
  let source = (): { w: number; h: number } => ({ w: 0, h: 0 });
  const listeners = new Set<() => void>();
  return {
    get: () => cam,
    set(c) {
      cam = c;
      for (const l of [...listeners]) l();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    size: () => source(),
    setSize(fn) {
      source = fn;
    },
  };
}

export const CameraContext = createContext<CameraStore | null>(null);

export function useCamera(): Camera {
  const store = useContext(CameraContext);
  if (!store) throw new Error("No camera");
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface Layers {
  /** Lane gutters (and the wave's), below the row gutters so a lane's full-height backing never covers its rows. */
  gutter: SVGGElement | null;
  rows: SVGGElement | null;
  animate: boolean;
}

export const LayersContext = createContext<Layers>({ gutter: null, rows: null, animate: false });

export function useLayers(): Layers {
  return useContext(LayersContext);
}

/** A lane of batched ticks: the x of each call (sheet coordinates), its entity and its tree id. */
export interface TickHits {
  readonly xs: readonly number[];
  readonly refs: readonly EntityRef[];
  readonly tids: readonly string[];
}

export interface HitRegistry {
  set(agentId: string, hits: TickHits | null): void;
  get(agentId: string): TickHits | undefined;
}

export function createHitRegistry(): HitRegistry {
  const map = new Map<string, TickHits>();
  return {
    set(id, hits) {
      if (hits) map.set(id, hits);
      else map.delete(id);
    },
    get: (id) => map.get(id),
  };
}

export const HitContext = createContext<HitRegistry>(createHitRegistry());

/** The nearest call to sheet x within `tolerance`, or null. */
export function nearestHit(hits: TickHits, x: number, tolerance: number): number | null {
  let best = -1;
  let dist = tolerance;
  for (let i = 0; i < hits.xs.length; i++) {
    const d = Math.abs((hits.xs[i] as number) - x);
    if (d <= dist) {
      dist = d;
      best = i;
    }
  }
  return best < 0 ? null : best;
}

/** The level of detail, as React state (it changes only when the camera crosses a threshold). */
export const LodContext = createContext<"overview" | "detail" | "near">("detail");

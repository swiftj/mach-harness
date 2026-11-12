/**
 * React bindings for the one store. React 19's useSyncExternalStore; no other dependency.
 *
 *   const playhead = useSceneStore((s) => s.playhead);
 *   const scene = useScene();                       // sceneAt(fixture, playhead), stable between events
 *   const cell = useScene((scene) => scene.cells["LOCAL-031"]);
 *   const { select, seek } = useSceneActions();
 *
 * Selectors must return a value that is the same (===) when nothing it depends on changed: a field,
 * or an object taken from the scene. Derive new objects with useMemo, not inside the selector.
 */
import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { Scene } from "../sim/model";
import { sceneAt } from "../sim/engine";
import { SCENARIO } from "../sim/scenario";
import { browserClock } from "./clock";
import { createSceneStore, installMachSimHook, shouldExposeHook, type SceneStore, type SceneStoreState } from "./store";

let defaultStore: SceneStore | null = null;

/** The app's store: the M6.0 scenario on the browser clock, with reduced motion from the media query. */
export function getSceneStore(): SceneStore {
  if (defaultStore) return defaultStore;
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const store = createSceneStore({ fixture: SCENARIO, clock: browserClock(), reducedMotion: media?.matches ?? false });
  media?.addEventListener("change", (e) => store.setReducedMotion(e.matches));
  if (shouldExposeHook()) installMachSimHook(store, window);
  defaultStore = store;
  return store;
}

const StoreContext = createContext<SceneStore | null>(null);

/** Optional: give a subtree its own store (tests, a second preview). Without it, getSceneStore() is used. */
export function SceneStoreProvider({ store, children }: { store: SceneStore; children?: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useStore(): SceneStore {
  return useContext(StoreContext) ?? getSceneStore();
}

export function useSceneStore<T>(selector: (state: SceneStoreState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}

/** The scene at the playhead (or a part of it). Re-renders only when the selected value changes. */
export function useScene(): Scene;
export function useScene<T>(selector: (scene: Scene) => T): T;
export function useScene<T>(selector?: (scene: Scene) => T): T | Scene {
  const store = useStore();
  const read = () => {
    const s = store.getState();
    const scene = sceneAt(s.fixture, s.playhead);
    return selector ? selector(scene) : scene;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The store's actions, stable across renders. */
export function useSceneActions(): Omit<SceneStore, "getState" | "subscribe" | "dispose"> {
  return useStore();
}

/** Space toggles play, arrows step by event: wire once in the shell if it wants the defaults. */
export function usePlaybackKeys(enabled = true): void {
  const store = useStore();
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))) return;
      if (e.key === " ") store.toggle();
      else if (e.key === "ArrowRight" && e.shiftKey) store.stepNext();
      else if (e.key === "ArrowLeft" && e.shiftKey) store.stepPrevious();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, store]);
}

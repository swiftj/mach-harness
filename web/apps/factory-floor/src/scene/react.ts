/**
 * React bindings for the one store. React 19's useSyncExternalStore; no other dependency.
 *
 *   const now = useSceneStore((s) => s.now);
 *   const scene = useScene();                       // log.sceneAt(now), stable between events
 *   const cell = useScene((scene) => scene.cells["131"]);
 *   const { select, hover } = useSceneActions();
 *
 * Selectors must return a value that is the same (===) when nothing it depends on changed: a field,
 * or an object taken from the scene. Derive new objects with useMemo, not inside the selector.
 */
import { createContext, createElement, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Scene } from "../sim/model";
import { SCENARIO } from "../sim/scenario";
import { browserClock, switchableClock } from "./clock";
import { createSceneStore, installMachSimHook, shouldExposeHook, type SceneStore, type SceneStoreState } from "./store";

let defaultStore: SceneStore | null = null;

/** The app's simulation store: the M6.0 scenario on the browser clock, running on its own, with reduced motion from the media query. */
export function getSceneStore(): SceneStore {
  if (defaultStore) return defaultStore;
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  // Development and capture builds run on a clock the capture script can switch to manual; production uses the browser's.
  const switchable = shouldExposeHook() ? switchableClock(browserClock()) : null;
  const store = createSceneStore({ fixture: SCENARIO, clock: switchable ?? browserClock(), reducedMotion: media?.matches ?? false });
  media?.addEventListener("change", (e) => store.setReducedMotion(e.matches));
  if (switchable) installMachSimHook(store, window, switchable);
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

/** The scene now (or a part of it). Re-renders only when the selected value changes. */
export function useScene(): Scene;
export function useScene<T>(selector: (scene: Scene) => T): T;
export function useScene<T>(selector?: (scene: Scene) => T): T | Scene {
  const store = useStore();
  const read = () => {
    const s = store.getState();
    // Either source. The log returns the same object for the same moment while it is in use.
    const scene = s.log.sceneAt(s.now);
    return selector ? selector(scene) : scene;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The store's actions, stable across renders. */
export function useSceneActions(): Omit<SceneStore, "getState" | "subscribe" | "dispose"> {
  return useStore();
}

/**
 * Frame-rate updates without React renders: calls `onNow` with the store state whenever the moment
 * shown moves (and once at mount), so a component can write a running time straight to a DOM node.
 */
export function useNowEffect(onNow: (s: SceneStoreState) => void, deps: readonly unknown[]): void {
  const store = useStore();
  const latest = useRef(onNow);
  useLayoutEffect(() => {
    latest.current = onNow;
  });
  useEffect(() => {
    let now = Number.NaN;
    const run = () => {
      const s = store.getState();
      if (s.now === now) return;
      now = s.now;
      latest.current(s);
    };
    run();
    return store.subscribe(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ...deps]);
}

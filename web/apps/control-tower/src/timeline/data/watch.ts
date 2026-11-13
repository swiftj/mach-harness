/**
 * Tells a provider's subscribers that earlier answers may be stale, throttled: the first change is
 * told at once, then at most one more per `throttleMs` however many events arrive. Subscribes to the
 * store only while someone listens.
 */
import type { SceneStore, SceneStoreState } from "../../scene/store";

/** At most one "may be stale" notice per this many ms (design: never one request per event). */
export const THROTTLE_MS = 500;

export interface TimerLike {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: TimerLike = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface StoreWatcher {
  subscribe(listener: () => void): () => void;
}

export function storeWatcher(
  store: SceneStore,
  options: {
    readonly timers?: TimerLike;
    readonly throttleMs: number;
    /** Whether a store change may have made answers stale. */
    readonly changed: (prev: SceneStoreState, next: SceneStoreState) => boolean;
    /** Run before listeners are told (drop stale caches). */
    readonly before?: () => void;
  },
): StoreWatcher {
  const timers = options.timers ?? globalTimers;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  let last: SceneStoreState = store.getState();
  let timer: unknown = null;
  let pending = false;

  const fire = () => {
    options.before?.();
    for (const l of [...listeners]) l();
  };
  const cool = () => {
    timer = timers.setTimeout(() => {
      timer = null;
      if (pending) {
        pending = false;
        fire();
        cool();
      }
    }, options.throttleMs);
  };
  const onStore = () => {
    const next = store.getState();
    const prev = last;
    last = next;
    if (next === prev || !options.changed(prev, next)) return;
    if (timer !== null) {
      pending = true;
      return;
    }
    fire();
    cool();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        last = store.getState();
        unsubscribe = store.subscribe(onStore);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe) {
          unsubscribe();
          unsubscribe = null;
          if (timer !== null) timers.clearTimeout(timer);
          timer = null;
          pending = false;
        }
      };
    },
  };
}

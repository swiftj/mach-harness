/**
 * A view of the one store that a hidden part of the screen reads (A4): shown, it follows every change;
 * hidden, getState() keeps returning the state as of the moment it was hidden and no listener is told
 * of changes, so a subtree reading it renders nothing new and runs no effect a change would start.
 * Shown again, it catches up at once. Actions go straight to the one store. It listens to the store
 * only while it has listeners itself. The Floor's held store (heldStore, store.ts) is built on it.
 */
import type { SceneStore, SceneStoreState } from "./store";

export interface StoreViewPolicy {
  /**
   * A change of the store. Return "show" or "hide" to switch the view before anything is told (the
   * change is then handled as shown or hidden); undefined leaves it as it is. Hidden by `decide`, the
   * view keeps the state of its last catch-up, so the change that hid it never reaches the subtree.
   */
  readonly decide?: (state: SceneStoreState) => "show" | "hide" | undefined;
}

export interface StoreView extends SceneStore {
  /** Hide (keeping the state as of now) or show (catching up at once). */
  setShown(shown: boolean): void;
  shown(): boolean;
}

export function storeView(store: SceneStore, policy: StoreViewPolicy = {}): StoreView {
  const listeners = new Set<() => void>();
  let isShown = true;
  let state = store.getState();
  let off: (() => void) | null = null;
  const notify = () => {
    state = store.getState();
    for (const l of [...listeners]) l();
  };
  const show = (next: boolean, snapshot: boolean) => {
    if (next === isShown) return;
    isShown = next;
    if (isShown) {
      if (state !== store.getState()) notify();
    } else if (snapshot) state = store.getState();
  };
  const onChange = () => {
    const d = policy.decide?.(store.getState());
    if (d) {
      const was = isShown;
      show(d === "show", false);
      // Shown again by `decide`: it has caught up already.
      if (isShown && !was) return;
    }
    if (isShown) notify();
  };
  return {
    ...store,
    getState: () => (isShown ? store.getState() : state),
    subscribe(listener) {
      listeners.add(listener);
      off ??= store.subscribe(onChange);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && off) {
          off();
          off = null;
        }
      };
    },
    setShown: (next) => show(next, true),
    shown: () => isShown,
  };
}

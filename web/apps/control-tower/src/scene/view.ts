/**
 * A view of the one store that a hidden part of the screen reads (A4): shown, it follows every change;
 * hidden, getState() keeps returning the state as of its last catch-up and no listener is told of
 * changes, so a subtree reading it renders nothing new and runs no effect a change would start.
 * Actions go straight to the one store. It listens to the store only while it has listeners itself.
 *
 * What happens to changes while hidden is the caller's policy:
 * - the Factory Floor's hidden workspace (heldStore, store.ts): never caught up until shown again;
 * - the Stage's hidden view (Stage.tsx gatedStore): caught up on a timer during playback and once,
 *   when the browser is idle, after a jump.
 */
import type { SceneStore, SceneStoreState } from "./store";

export interface StoreViewPolicy {
  /**
   * A change of the store. Return "show" or "hide" to switch the view before anything is told (the
   * change is then handled as shown or hidden); undefined leaves it as it is.
   */
  readonly decide?: (state: SceneStoreState) => "show" | "hide" | undefined;
  /** A change of the store while hidden. */
  readonly hiddenChange?: () => void;
  /** The first listener arrived: start anything the policy needs; returns what to stop when the last leaves. */
  readonly attach?: () => () => void;
  /** About to be shown again (before it catches up). */
  readonly shownAgain?: () => void;
  /**
   * When hidden by `setShown(false)`: true keeps the state as of that moment; false (the Stage's
   * rule) keeps the state as of the last catch-up. Hidden by `decide`, it is always the last catch-up,
   * so the change that hid it never reaches the hidden subtree.
   */
  readonly snapshotOnHide?: boolean;
}

export interface StoreView extends SceneStore {
  setShown(shown: boolean): void;
  shown(): boolean;
  /** Whether the hidden view shows an earlier state than the store's. */
  stale(): boolean;
  /** Bring a hidden view up to date now (one notification); nothing when shown or current. */
  catchUp(): void;
}

export function storeView(store: SceneStore, policy: StoreViewPolicy = {}): StoreView {
  const listeners = new Set<() => void>();
  let isShown = true;
  let state = store.getState();
  let off: (() => void) | null = null;
  let detach: (() => void) | null = null;
  const notify = () => {
    state = store.getState();
    for (const l of [...listeners]) l();
  };
  const show = (next: boolean, snapshot: boolean) => {
    if (next === isShown) return;
    isShown = next;
    if (isShown) {
      policy.shownAgain?.();
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
    if (isShown) return notify();
    policy.hiddenChange?.();
  };
  return {
    ...store,
    getState: () => (isShown ? store.getState() : state),
    subscribe(listener) {
      listeners.add(listener);
      if (!off) {
        off = store.subscribe(onChange);
        detach = policy.attach?.() ?? null;
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && off) {
          off();
          off = null;
          detach?.();
          detach = null;
        }
      };
    },
    setShown: (next) => show(next, policy.snapshotOnHide === true),
    shown: () => isShown,
    stale: () => state !== store.getState(),
    catchUp() {
      if (isShown || state === store.getState()) return;
      notify();
    },
  };
}

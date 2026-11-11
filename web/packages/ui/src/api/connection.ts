import { useSyncExternalStore } from "react";

/**
 * The browser's link to the local host, not to the shared repository (that is `refresh.refreshed`).
 *
 *   connecting    the first request has not answered yet
 *   online        the last request reached the host
 *   offline       the last request could not reach the host
 *   unauthorized  the host answered but the session is gone (a new start is needed)
 */
export type ConnectionState = "connecting" | "online" | "offline" | "unauthorized";

export interface ConnectionStore {
  get(): ConnectionState;
  set(next: ConnectionState): void;
  subscribe(listener: () => void): () => void;
}

export function createConnectionStore(initial: ConnectionState = "connecting"): ConnectionStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (next === state) return;
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Re-renders when the connection changes. */
export function useConnectionState(store: ConnectionStore): ConnectionState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * App-wide engine state, shared by every screen so they agree and reload together.
 *
 *   const status = useStatus();          // loads once, shared; status.reload() after a change
 *   const session = useSession();        // project, capabilities (interview availability)
 *   const refresh = useRefresh();        // the last refresh this visit; refresh.run()
 *
 * After any operation that changes state, call reloadStatus() (useEngineAct does it for you).
 */
import { useEffect, useSyncExternalStore } from "react";
import { isMachApiError, MachApiError, type Feedback, type Refresh, type Session, type Status } from "@mach/ui/api";
import { client } from "./client";

export interface Loadable<T> {
  data: T | null;
  error: MachApiError | null;
  loading: boolean;
  /** When the data last arrived (ms since epoch). */
  at: number | null;
}

function store<T>(load: () => Promise<T>) {
  let state: Loadable<T> = { data: null, error: null, loading: false, at: null };
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<Loadable<T>>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };
  const run = (): Promise<void> => {
    inflight ??= (async () => {
      set({ loading: true });
      try {
        set({ data: await load(), error: null, loading: false, at: Date.now() });
      } catch (error) {
        set({ error: asError(error), loading: false });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  return {
    get: () => state,
    run,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function asError(error: unknown): MachApiError {
  return isMachApiError(error) ? error : new MachApiError("internal", String(error), "app");
}

const statusStore = store<Status>(() => client.op("status", {}));
const sessionStore = store<Session>(() => client.session());
const refreshStore = store<Refresh>(async () => {
  const result = await client.op("refresh", {});
  void statusStore.run();
  return result;
});
const feedbackStore = store<Feedback>(() => client.op("feedback", {}));

function useStore<T>(s: ReturnType<typeof store<T>>, autoload: boolean): Loadable<T> {
  const state = useSyncExternalStore(s.subscribe, s.get, s.get);
  useEffect(() => {
    if (autoload && state.data === null && !state.loading && state.error === null) void s.run();
  }, [autoload, s, state.data, state.loading, state.error]);
  return state;
}

/** The engine's `status`: every artifact with its state. Loaded once and shared. */
export function useStatus(): Loadable<Status> & { reload: () => Promise<void> } {
  return { ...useStore(statusStore, true), reload: statusStore.run };
}

export function reloadStatus(): Promise<void> {
  return statusStore.run();
}

/** GET /api/session: project, CSRF (kept by the client), interview capability. */
export function useSession(): Loadable<Session> {
  return useStore(sessionStore, true);
}

/**
 * The last `refresh` this visit (it fetches from the shared project). Not run automatically;
 * the workspace runs it once when opened. Status is reloaded after every refresh.
 */
export function useRefresh(): Loadable<Refresh> & { run: () => Promise<void> } {
  return { ...useStore(refreshStore, false), run: refreshStore.run };
}

/** `feedback` for sent waves (fetches). Loaded on first use, shared. */
export function useFeedback(enabled: boolean): Loadable<Feedback> & { reload: () => Promise<void> } {
  return { ...useStore(feedbackStore, enabled), reload: feedbackStore.run };
}

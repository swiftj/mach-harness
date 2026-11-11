/**
 * App-wide engine state, shared by every screen so they agree and reload together.
 *
 *   const status = useStatus();          // loads once, shared; status.reload() after a change
 *   const session = useSession();        // project, capabilities (interview availability)
 *   const refresh = useRefresh();        // the last refresh this visit; refresh.run()
 *
 * Every operation that may change the workspace reloads the status by itself (client.onChange).
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
  let again = false;
  const listeners = new Set<() => void>();
  const set = (next: Partial<Loadable<T>>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };
  const run = (): Promise<void> => {
    // A reload asked for while one is running reads again afterwards: the running read may have
    // started before the change it is meant to show.
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        set({ loading: true });
        try {
          set({ data: await load(), error: null, loading: false, at: Date.now() });
        } catch (error) {
          set({ error: asError(error), loading: false });
        }
      } while (again);
      inflight = null;
    })();
    return inflight;
  };
  return {
    get: () => state,
    run,
    /** Resolves when the read in flight (if any) has settled. */
    settled: (): Promise<void> => inflight ?? Promise.resolve(),
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

// Every act that may change the workspace (anywhere in the app) reloads the shared status, so a
// screen never shows what was true before it: a reconcile, an approval, a wave, a draft write.
client.onChange((operation) => {
  if (operation === "feedback" || operation === "refresh") return; // refresh reloads status itself
  void statusStore.run();
});

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

/** Waits for the status reload an act started (through client.onChange) to arrive. */
export function statusSettled(): Promise<void> {
  return statusStore.settled();
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

/**
 * Choosing where the scenes come from, at start-up, with no new command and no setting that could
 * mislabel what is shown:
 *
 * - **Live Factory**: the page is served by the observer (the same origin answers `/api/v1/session`
 *   with a valid session). The default whenever an observer answers.
 * - **Historical replay**: the same real history, loaded once and played back (`?replay`, or the
 *   Replay item in the source menu). Needs an observer too.
 * - **Simulation**: the M6.0 scenario (`?simulation`, or the menu item); also what the app shows
 *   when no observer answers, and it says so on screen.
 *
 * The question asked of the page is only ever "does an observer answer here?". The answer decides the
 * source; nothing the person sets can make a simulation read as real, or real history as simulated.
 * Reads only: no route here writes anything (the observer serves GET only).
 */
import { createLiveFactory, createObserverClient, createReplay, ObserverError, type EventSourceLike, type FetchLike, type LiveSource, type ObserverClient, type ObserverSession } from "../../live";
import { browserClock, type SceneStore } from "../../scene";

export type SourceChoice = "live" | "replay" | "simulation";

/** What the URL asks for: `?simulation`, `?replay`, or nothing (live when an observer answers). */
export function requestedSource(search: string): SourceChoice | null {
  const params = new URLSearchParams(search);
  if (params.has("simulation")) return "simulation";
  if (params.has("replay")) return "replay";
  return null;
}

/** The address for a source, keeping the hash (view and selection) and every other parameter. */
export function urlFor(choice: SourceChoice, location: Pick<Location, "pathname" | "search" | "hash">): string {
  const params = new URLSearchParams(location.search);
  params.delete("simulation");
  params.delete("replay");
  params.delete("source");
  if (choice !== "live") params.set(choice, "");
  const query = params.toString().replace(/=(&|$)/g, "$1");
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

export const browserFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, { headers: init?.headers, credentials: "same-origin", cache: "no-store" });
  return { status: response.status, json: () => response.json() };
};

export function observerClient(): ObserverClient {
  return createObserverClient({ fetch: browserFetch });
}

/** What answered at `/api/v1/session`. */
export type Probe =
  | { readonly kind: "observer"; readonly session: ObserverSession }
  /** An observer answered, but this browser has no valid session (missing, expired, or the observer restarted). */
  | { readonly kind: "no-session"; readonly message: string }
  /** Nothing that speaks the observer's API answered here (a static build, the dev server with no observer). */
  | { readonly kind: "none"; readonly message: string };

export async function probeObserver(client: ObserverClient): Promise<Probe> {
  try {
    return { kind: "observer", session: await client.session() };
  } catch (error) {
    if (error instanceof ObserverError && error.kind === "unauthorized") return { kind: "no-session", message: error.message };
    return { kind: "none", message: error instanceof Error ? error.message : "No observer answered." };
  }
}

/** Timers from the browser, for the live source. */
const browserTimers = {
  setTimeout: (callback: () => void, ms: number): unknown => window.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
  setInterval: (callback: () => void, ms: number): unknown => window.setInterval(callback, ms),
  clearInterval: (handle: unknown) => window.clearInterval(handle as number),
};

/** The Live Factory: a live store fed by the observer's stream. The caller starts and stops the source. */
export function createBrowserLive(client: ObserverClient, reducedMotion: boolean): { store: SceneStore; source: LiveSource } {
  const clock = browserClock();
  const { store, source } = createLiveFactory({
    client,
    // Same origin: the session cookie goes with the request. EventSource cannot set headers, so the
    // schema is named in the URL (`?schema=3`, done by the source).
    openStream: (url) => new EventSource(url) as unknown as EventSourceLike,
    clock,
    timers: browserTimers,
  });
  store.setReducedMotion(reducedMotion);
  return { store, source };
}

/**
 * Historical replay: the observer's history, read in windows around the playhead (D17): its span and
 * counts first, then the window being watched. A replay is watched from its start.
 */
export async function createBrowserReplay(client: ObserverClient, reducedMotion: boolean): Promise<SceneStore> {
  const { store } = await createReplay(client, { clock: browserClock(), reducedMotion });
  return store;
}

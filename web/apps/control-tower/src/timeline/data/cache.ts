/**
 * A small LRU of window answers (tiles), shared by every caller of one provider. Each entry holds
 * the answer and the version it came from (the observer's reply cursor). Callers waiting on the same
 * tile share one request; when every caller of an in-flight request has gone (aborted or
 * superseded), the request is aborted. Tiles that touched the live edge when fetched can be marked
 * stale (`invalidateEdge`): the next caller refetches them, older tiles are reused as they are.
 */

export interface Loaded<T> {
  readonly value: T;
  /** The version of the truth it came from (reply cursor), null when the reply did not say. */
  readonly version: string | null;
}

interface Entry<T> {
  value: Loaded<T> | null;
  stale: boolean;
  /** The tile reached the live edge when fetched: its answer can grow. */
  edge: boolean;
  /** An edge invalidation arrived while the request was in flight: its answer is stale on arrival. */
  dirty: boolean;
  inflight: Promise<Loaded<T>> | null;
  controller: AbortController | null;
  waiters: number;
}

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The request was superseded.", "AbortError");
}

export function isAbort(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

/** Resolve with the promise, or reject as soon as the signal aborts (calling `onAbort` once). */
function raced<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}

export interface TileCache<T> {
  /** The tile's answer: from the cache when fresh, else from `load` (shared with other waiters). */
  get(key: string, edge: boolean, load: (signal: AbortSignal) => Promise<Loaded<T>>, signal?: AbortSignal): Promise<Loaded<T>>;
  /** The last good answer held for a tile, fresh or stale, without loading: what a failed refresh falls back to. */
  peek(key: string): Loaded<T> | null;
  /** Mark every tile that reached the live edge as stale. */
  invalidateEdge(): void;
  clear(): void;
  readonly size: number;
}

export function createTileCache<T>(max = 96): TileCache<T> {
  const entries = new Map<string, Entry<T>>();
  const evict = () => {
    for (const [key, e] of entries) {
      if (entries.size <= max) break;
      if (!e.inflight) entries.delete(key);
    }
  };
  return {
    get(key, edge, load, signal) {
      let e = entries.get(key);
      if (e) {
        entries.delete(key);
        entries.set(key, e); // most recent last
      }
      if (e?.value && !e.stale && !e.inflight) return signal?.aborted ? Promise.reject(abortError(signal)) : Promise.resolve(e.value);
      if (!e) {
        e = { value: null, stale: false, edge, dirty: false, inflight: null, controller: null, waiters: 0 };
        entries.set(key, e);
      }
      const entry = e;
      if (!entry.inflight) {
        const controller = new AbortController();
        entry.controller = controller;
        entry.edge = edge;
        entry.dirty = false;
        const request = load(controller.signal).then(
          (value) => {
            if (entry.inflight === request) {
              entry.value = value;
              entry.stale = entry.dirty;
              entry.inflight = null;
              entry.controller = null;
              evict();
            }
            return value;
          },
          (error: unknown) => {
            if (entry.inflight === request) {
              entry.inflight = null;
              entry.controller = null;
              if (!entry.value) entries.delete(key);
            }
            throw error;
          },
        );
        entry.inflight = request;
      }
      entry.waiters += 1;
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        entry.waiters -= 1;
        if (entry.waiters === 0 && entry.inflight && entry.controller) {
          // Nobody wants it any more: cancel it, and forget it unless an older answer is kept.
          entry.controller.abort();
          entry.inflight = null;
          entry.controller = null;
          if (!entry.value) entries.delete(key);
        }
      };
      const inflight = entry.inflight as Promise<Loaded<T>>;
      return raced(inflight, signal, leave).then(
        (v) => {
          if (!left) {
            left = true;
            entry.waiters -= 1;
          }
          return v;
        },
        (error: unknown) => {
          if (!left) {
            left = true;
            entry.waiters -= 1;
          }
          throw error;
        },
      );
    },
    peek(key) {
      return entries.get(key)?.value ?? null;
    },
    invalidateEdge() {
      for (const e of entries.values()) {
        if (!e.edge) continue;
        if (e.inflight) e.dirty = true;
        else e.stale = true;
      }
    },
    clear() {
      for (const e of entries.values()) e.controller?.abort();
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** One AbortSignal that aborts when any of the given ones does. */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

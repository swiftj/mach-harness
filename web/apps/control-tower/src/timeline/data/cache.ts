/**
 * A small LRU of window answers (tiles), shared by every caller of one provider. Each entry holds
 * the answer and the version it came from (the observer's reply cursor). Callers waiting on the same
 * tile share one request; when every caller of an in-flight request has gone (aborted or
 * superseded), the request is aborted. Tiles that touched the live edge when fetched, or that hold
 * an open span, can be marked stale (`invalidateEdge`): the next caller refetches them. Every other
 * tile can be marked behind (`markBehind`, the projection's cursor moved: a late or out-of-order event
 * may have reached it): it is re-read when next asked for, but not more often than `behindAfterMs`.
 *
 * The cache is bounded by tile count and, with `weigh`, by total weight (spans held), evicting the
 * least recently used tile that nobody is waiting on. `onDrop` is told of every answer let go.
 */

export interface Loaded<T> {
  readonly value: T;
  /** The version of the truth it came from (reply cursor), null when the reply did not say. */
  readonly version: string | null;
}

interface Entry<T> {
  value: Loaded<T> | null;
  /** When `value` arrived (the cache's clock). */
  fetchedAt: number;
  /** The answer holds an open span: it can change however old the tile is. */
  open: boolean;
  /** The cursor moved since `value` was read: re-read once it is `behindAfterMs` old. */
  behind: boolean;
  /** The cursor moved while the request was in flight: behind on arrival. */
  behindOnArrival: boolean;
  weight: number;
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
  /** Mark every tile that reached the live edge, or holds an open span, as stale. */
  invalidateEdge(): void;
  /**
   * Mark every other tile as behind. Returns the ms until every tile newly behind may be re-read (0:
   * now), or null when none fell behind now: the caller tells its listeners again then, so a late event reaches a
   * past tile even when nothing else arrives after it.
   */
  markBehind(): number | null;
  /**
   * Mark one tile behind: its answer came from a reply older than events the client already holds
   * (the observer answered before its projection took them in). Re-read once it is `behindAfterMs`
   * old. Returns the ms until then, or null when the tile is not held.
   */
  markLagging(key: string): number | null;
  clear(): void;
  readonly size: number;
  /** Total weight held (spans, with `weigh`). */
  readonly weight: number;
}

export interface TileCacheOptions<T> {
  /** Tiles kept. */
  readonly max?: number;
  /** Total weight kept (with `weigh`). */
  readonly maxWeight?: number;
  readonly weigh?: (value: T) => number;
  /** Whether an answer holds an open span (re-read on every invalidation). */
  readonly holdsOpen?: (value: T) => boolean;
  /** Told of every answer let go (evicted, replaced, cleared). */
  readonly onDrop?: (value: T) => void;
  readonly now?: () => number;
  /** A behind tile is re-read only once it is this old (default 2 s). */
  readonly behindAfterMs?: number;
}

/** A behind tile is re-read at most this often by default. */
export const BEHIND_AFTER_MS = 2000;

export function createTileCache<T>(options: number | TileCacheOptions<T> = {}): TileCache<T> {
  const o: TileCacheOptions<T> = typeof options === "number" ? { max: options } : options;
  const max = o.max ?? 96;
  const maxWeight = o.maxWeight ?? Number.POSITIVE_INFINITY;
  const weigh = o.weigh ?? (() => 0);
  const holdsOpen = o.holdsOpen ?? (() => false);
  const now = o.now ?? (() => Date.now());
  const behindAfter = o.behindAfterMs ?? BEHIND_AFTER_MS;
  const entries = new Map<string, Entry<T>>();
  let weight = 0;
  const drop = (e: Entry<T>) => {
    if (!e.value) return;
    weight -= e.weight;
    e.weight = 0;
    o.onDrop?.(e.value.value);
  };
  const evict = () => {
    for (const [key, e] of entries) {
      if (entries.size <= max && weight <= maxWeight) break;
      if (e.inflight || e.waiters > 0) continue;
      drop(e);
      entries.delete(key);
    }
  };
  const due = (e: Entry<T>): boolean => e.behind && now() - e.fetchedAt >= behindAfter;
  return {
    get(key, edge, load, signal) {
      let e = entries.get(key);
      if (e) {
        entries.delete(key);
        entries.set(key, e); // most recent last
      }
      if (e?.value && !e.stale && !due(e) && !e.inflight) return signal?.aborted ? Promise.reject(abortError(signal)) : Promise.resolve(e.value);
      if (!e) {
        e = { value: null, fetchedAt: 0, open: false, behind: false, behindOnArrival: false, weight: 0, stale: false, edge, dirty: false, inflight: null, controller: null, waiters: 0 };
        entries.set(key, e);
      }
      const entry = e;
      if (!entry.inflight) {
        const controller = new AbortController();
        entry.controller = controller;
        entry.edge = edge;
        entry.dirty = false;
        entry.behindOnArrival = false;
        const request = load(controller.signal).then(
          (value) => {
            if (entry.inflight === request) {
              drop(entry);
              entry.value = value;
              entry.weight = weigh(value.value);
              weight += entry.weight;
              entry.fetchedAt = now();
              entry.open = holdsOpen(value.value);
              entry.stale = entry.dirty || (entry.open && entry.behindOnArrival);
              entry.behind = entry.behindOnArrival;
              entry.inflight = null;
              entry.controller = null;
              if (entries.get(key) === entry) evict();
              else drop(entry);
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
        if (entry.waiters === 0) evict();
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
        if (!e.edge && !e.open) continue;
        if (e.inflight) e.dirty = true;
        else e.stale = true;
      }
    },
    markBehind() {
      let latest: number | null = null;
      const t = now();
      for (const e of entries.values()) {
        if (e.inflight) e.behindOnArrival = true;
        // Only a tile newly behind needs a notice: one already behind was told of when it fell behind.
        if (!e.value || e.stale || e.behind) continue;
        e.behind = true;
        const wait = Math.max(0, behindAfter - (t - e.fetchedAt));
        if (latest === null || wait > latest) latest = wait;
      }
      return latest;
    },
    markLagging(key) {
      const e = entries.get(key);
      if (!e?.value) return null;
      if (e.inflight) {
        e.behindOnArrival = true;
        return behindAfter;
      }
      e.behind = true;
      return Math.max(0, behindAfter - (now() - e.fetchedAt));
    },
    clear() {
      for (const e of entries.values()) {
        e.controller?.abort();
        drop(e);
      }
      entries.clear();
      weight = 0;
    },
    get size() {
      return entries.size;
    },
    get weight() {
      return weight;
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

/**
 * The Timeline's data from the observer (live and replay): `/api/v1/spans`, `/marks`, `/concurrency`
 * and `/series`, read through the one ObserverClient the app already holds (no second connection).
 *
 * Windows are quantised outward to tiles, and tiles are cached by (query, tile) with the reply cursor
 * as their version, so panning reuses what is held. A request superseded by a newer one for the same
 * filters is aborted. While live, tiles that reached the live edge are marked stale when the store's
 * logVersion moves, at most once per THROTTLE_MS, and subscribers are told to re-query: one request per
 * stale tile per re-query, never one per event.
 *
 * Nothing here throws into the view but an abort: a route the observer does not serve (an older
 * observer: 404) or a failed request answers empty, and `availability()` says which. Nothing is
 * invented to fill a gap.
 *
 * When the observer fails (down, erring), a tile that failed keeps its last good answer, and nothing
 * more is asked of the observer until a back-off passes (1 s, 2 s, 5 s, then every 15 s); then one
 * request probes it. Subscribers are told once, when it answers again, never once per failure. A
 * `cursor_reset` (409) or a reply from a new epoch (the cursor's generation changed) clears every
 * tile once and tells subscribers once.
 */
import { ObserverError, parseCursor, type ObserverClient } from "../../live/observer";
import type { SceneStore } from "../../scene/store";
import type { ConcurrencySeries, DensitySeries, SpanPage, SpanQuery, TimeWindow, TimelineData, TimelineMark, TimelineSpan } from "../contract";
import { abortError, anySignal, createTileCache, isAbort, type Loaded, type TileCache } from "./cache";
import { byStart, closeEndedVisits, honest, spanMatches, tilesFor, type FilteredDensity } from "./derive";
import { readConcurrency, readMark, readSpan } from "./parse";
import { availabilityState, type Part, type PartState } from "./availability";
import { storeWatcher, THROTTLE_MS, type TimerLike } from "./watch";

/** The observer's own cap on spans per reply (apps/observer server.go MaxSpans). */
export const OBSERVER_SPAN_CAP = 5000;
/** The observer's `/series` bucket limit. */
const MAX_SERIES_BUCKETS = 2000;
/** How long to leave a failing observer alone before one probe: then every 15 s. */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 15_000];

/** Thrown instead of a request while the observer is being left alone after a failure. */
class BackingOff extends Error {
  constructor() {
    super("Waiting before asking the observer again.");
    this.name = "BackingOff";
  }
}

export interface ObserverTimelineOptions {
  readonly timers?: TimerLike;
  readonly throttleMs?: number;
  /** Tiles kept per kind of answer. */
  readonly maxTiles?: number;
  /** Spans per page asked of the observer (its maximum is 1000). */
  readonly pageLimit?: number;
  /** The most spans read for one tile before saying the answer is cut. */
  readonly maxSpansPerTile?: number;
}

interface SpanTile {
  readonly spans: readonly TimelineSpan[];
  readonly truncated: boolean;
  readonly total: number;
  /** The reply said `truncated` (an M6.3 observer): the window was honoured. */
  readonly windowed: boolean;
}

const notFound = (error: unknown): boolean => error instanceof ObserverError && (error.kind === "not_found" || error.status === 404);
const isReset = (error: unknown): boolean => error instanceof ObserverError && (error.kind === "cursor_reset" || error.status === 409);
const cursorPos = (version: string | null): number => parseCursor(version)?.pos ?? -1;

export function createObserverTimelineData(client: ObserverClient, store: SceneStore, options: ObserverTimelineOptions = {}): TimelineData {
  const source = store.getState().source === "replay" ? "replay" : "live";
  const timers: TimerLike = options.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };
  const pageLimit = Math.min(1000, Math.max(1, options.pageLimit ?? 1000));
  const perTile = options.maxSpansPerTile ?? OBSERVER_SPAN_CAP;
  const spanTiles = createTileCache<SpanTile>(options.maxTiles ?? 96);
  const markTiles = createTileCache<readonly TimelineMark[]>(options.maxTiles ?? 96);
  const seriesCache = createTileCache<DensitySeries>(32);
  const concurrencyCache = createTileCache<ConcurrencySeries>(32);
  const caches: readonly TileCache<unknown>[] = [spanTiles, markTiles, seriesCache, concurrencyCache] as readonly TileCache<unknown>[];
  /** The latest spans() call per filter set: a newer one supersedes it. */
  const latest = new Map<string, AbortController>();

  const availability = availabilityState({
    spans: client.spans ? "unknown" : "unavailable",
    marks: client.marks ? "unknown" : "unavailable",
    concurrency: client.concurrency ? "unknown" : "unavailable",
  });
  const mark = (part: Part, state: PartState) => availability.set(part, state);
  const failedState = (error: unknown): PartState => (notFound(error) ? "unavailable" : "failed");

  const isEdge = (tile: TimeWindow): boolean => source === "live" && tile.to > store.getState().liveAt - 1;

  const watcher = storeWatcher(store, {
    timers: options.timers,
    throttleMs: options.throttleMs ?? THROTTLE_MS,
    changed: (prev, next) => prev.logVersion !== next.logVersion || prev.series !== next.series,
    before: () => {
      if (source !== "live") return;
      for (const c of caches) c.invalidateEdge();
    },
  });

  // ---- health: back-off after failures, one probe at a time, resets and epochs.
  let failures = 0;
  let retry: unknown = null;
  let probe: (() => Promise<unknown>) | null = null;
  /** The cursor generation answers came from; a different one means the observer's history was rebuilt. */
  let epoch: string | null = null;
  /** A reset was already acted on and nothing has succeeded since: a second one is a failure, not another reset. */
  let resetSeen = false;
  const backingOff = (): boolean => retry !== null;
  const clearAll = () => {
    for (const c of caches) c.clear();
  };
  const succeeded = (version: string | null): void => {
    resetSeen = false;
    const generation = parseCursor(version)?.generation ?? null;
    if (generation !== null) {
      const before = epoch;
      epoch = generation;
      if (before !== null && before !== generation) {
        // A new epoch: every held tile is from a history that no longer exists. Clear once, tell once.
        clearAll();
        watcher.notify();
        return;
      }
    }
    if (failures > 0) {
      failures = 0;
      probe = null;
      if (retry !== null) timers.clearTimeout(retry);
      retry = null;
      watcher.notify(); // the observer answers again: one re-query for everything
    }
  };
  const failed = (error: unknown, again: () => Promise<unknown>): void => {
    if (notFound(error) || isAbort(error)) return; // a route this observer does not serve is not a failure of the observer
    if (isReset(error) && !resetSeen) {
      resetSeen = true;
      epoch = null;
      clearAll();
      watcher.notify();
      return;
    }
    probe ??= again;
    if (retry !== null) return; // one back-off per failing round, however many tiles failed in it
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] as number;
    failures += 1;
    retry = timers.setTimeout(() => {
      retry = null;
      const p = probe;
      probe = null;
      if (p) void p().catch(() => undefined);
    }, wait);
  };
  /** A load that is not sent while backing off, and records how the observer answered. */
  const guarded = <T>(load: (signal: AbortSignal) => Promise<Loaded<T>>, again: () => Promise<unknown>) =>
    async (signal: AbortSignal): Promise<Loaded<T>> => {
      if (backingOff()) throw new BackingOff();
      try {
        const value = await load(signal);
        succeeded(value.version);
        return value;
      } catch (error) {
        // A 404 is an answer: the observer is up, it just does not serve the route.
        if (notFound(error)) succeeded(null);
        else if (!isAbort(error) && !signal.aborted) failed(error, again);
        throw error;
      }
    };
  /** A tile through its cache: fresh, else loaded (guarded), else on failure the last good answer held. */
  const tile = <T>(cache: TileCache<T>, key: string, edge: boolean, load: (signal: AbortSignal) => Promise<Loaded<T>>, signal?: AbortSignal): Promise<Loaded<T>> => {
    const run = (): Promise<Loaded<T>> => cache.get(key, edge, loader);
    const loader = guarded(load, run);
    return cache.get(key, edge, loader, signal).catch((error: unknown) => {
      if (isAbort(error) || signal?.aborted) throw error;
      const held = cache.peek(key);
      if (held) return held;
      throw error;
    });
  };
  /** A request outside the tile caches (one span, the next mark): not sent while backing off. */
  const direct = async <T>(request: () => Promise<T>, version: (value: T) => string | null): Promise<T> => {
    if (backingOff()) throw new BackingOff();
    try {
      const value = await request();
      succeeded(version(value));
      return value;
    } catch (error) {
      if (notFound(error)) succeeded(null);
      throw error;
    }
  };

  const loadSpanTile = async (query: SpanQuery, t: TimeWindow, signal: AbortSignal): Promise<Loaded<SpanTile>> => {
    const fetchSpans = client.spans as NonNullable<ObserverClient["spans"]>;
    const spans: TimelineSpan[] = [];
    let version: string | null = null;
    let truncated = false;
    let total: number | null = null;
    let windowed = false;
    for (let offset = 0; ; ) {
      const page = await fetchSpans({ fromMs: t.from, toMs: t.to, kinds: query.kinds, ticket: query.ticket, execution: query.execution, wave: query.wave, limit: pageLimit, offset, signal });
      if (cursorPos(page.cursor) >= cursorPos(version)) version = page.cursor;
      for (const raw of page.items) {
        const span = readSpan(raw);
        if (span) spans.push(span);
      }
      windowed = windowed || page.truncated !== null;
      if (page.truncated === true) truncated = true;
      total = page.totalUncapped ?? page.total ?? total;
      offset += page.items.length;
      if (!page.more || page.items.length === 0) break;
      if (offset >= perTile) {
        truncated = true;
        break;
      }
    }
    // An observer before M6.3 cuts at its cap without saying so: at the cap, say it may be cut.
    if (!windowed && (total ?? 0) >= OBSERVER_SPAN_CAP) truncated = true;
    return { value: { spans, truncated, total: Math.max(total ?? 0, spans.length), windowed }, version };
  };

  const filterKey = (q: SpanQuery): string => JSON.stringify([[...(q.kinds ?? [])].sort(), q.ticket ?? "", q.execution ?? "", q.wave ?? ""]);

  const data: TimelineData = {
    source,
    extent() {
      const s = store.getState();
      const firstBucket = s.series?.buckets[0]?.fromMs ?? null;
      if (s.extent.events === 0 && firstBucket === null) return null;
      const from = firstBucket === null ? s.extent.start : Math.min(firstBucket, s.extent.start);
      return { from, to: Math.max(s.extent.end, s.liveAt, from) };
    },

    async spans(query, signal) {
      const empty = (version = ""): SpanPage => ({ spans: [], truncated: false, total: 0, version });
      if (!client.spans) return empty();
      const key = filterKey(query);
      const own = new AbortController();
      const combined = anySignal([own.signal, signal]);
      const tiles = tilesFor(query.window);
      const requests = tiles.map((t) => tile(spanTiles, `spans|${key}|${t.from}|${t.to}`, isEdge(t), (s) => loadSpanTile(query, t, s), combined));
      // Supersede the previous call for these filters only once this one holds its tiles, so shared tiles survive.
      latest.get(key)?.abort(abortError());
      latest.set(key, own);
      let settled: PromiseSettledResult<Loaded<SpanTile>>[];
      try {
        settled = await Promise.allSettled(requests);
      } finally {
        if (latest.get(key) === own) latest.delete(key);
      }
      if (combined.aborted) throw abortError(combined);
      const aborted = settled.find((r) => r.status === "rejected" && isAbort(r.reason));
      if (aborted) throw (aborted as PromiseRejectedResult).reason;
      const answers = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!answers.length) {
        mark("spans", failure && !(failure.reason instanceof BackingOff) ? failedState(failure.reason) : availability.parts.spans === "available" ? "failed" : availability.parts.spans);
        return empty();
      }
      // Newest version wins for a span held by several tiles (an open span seen again later, now ended).
      const chosen = new Map<string, { span: TimelineSpan; pos: number }>();
      let version: string | null = null;
      // A tile that could not be read is a part of the window not shown: say the answer is cut.
      let truncated = failure !== undefined;
      let total = 0;
      let windowed = false;
      for (const a of answers) {
        const pos = cursorPos(a.version);
        if (pos >= cursorPos(version)) version = a.version;
        truncated = truncated || a.value.truncated;
        total = Math.max(total, a.value.total);
        windowed = windowed || a.value.windowed;
        for (const span of a.value.spans) {
          const held = chosen.get(span.id);
          if (!held || pos > held.pos) chosen.set(span.id, { span, pos });
        }
      }
      availability.setWindowed(windowed);
      mark("spans", failure && !(failure.reason instanceof BackingOff) ? "failed" : "available");
      const spans = closeEndedVisits(honest([...chosen.values()].map((c) => c.span)))
        .filter((s) => spanMatches(s, query))
        .sort(byStart);
      return { spans, truncated, total: truncated ? Math.max(total, spans.length) : spans.length, version: version ?? "" };
    },

    async span(id, signal) {
      if (!client.spans) return null;
      const fetchSpans = client.spans;
      try {
        const page = await direct(() => fetchSpans({ span: id, signal }), (p) => p.cursor);
        for (const raw of page.items) {
          const span = readSpan(raw);
          if (span && span.id === id) return honest([span])[0] ?? null;
        }
        return null;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        if (!(error instanceof BackingOff)) failed(error, () => fetchSpans({ span: id }));
        return null;
      }
    },

    async marks(window, kinds, signal) {
      if (!client.marks) return [];
      const fetchMarks = client.marks;
      const k = kinds?.length ? [...kinds].sort().join(",") : "";
      const tiles = tilesFor(window);
      const requests = tiles.map((t) =>
        tile(markTiles, `marks|${k}|${t.from}|${t.to}`, isEdge(t), async (s) => {
          const page = await fetchMarks({ fromMs: t.from, toMs: t.to, kinds, limit: 1000, signal: s });
          const marks: TimelineMark[] = [];
          for (const raw of page.items) {
            const m = readMark(raw);
            if (m) marks.push(m);
          }
          return { value: marks, version: page.cursor };
        }, signal),
      );
      const settled = await Promise.allSettled(requests);
      if (signal?.aborted) throw abortError(signal);
      const aborted = settled.find((r) => r.status === "rejected" && isAbort(r.reason));
      if (aborted) throw (aborted as PromiseRejectedResult).reason;
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failure && !(failure.reason instanceof BackingOff)) mark("marks", failedState(failure.reason));
      else if (!failure) mark("marks", "available");
      const byId = new Map<string, TimelineMark>();
      for (const a of settled) if (a.status === "fulfilled") for (const m of a.value.value) byId.set(m.id, m);
      return [...byId.values()]
        .filter((m) => (!kinds?.length || kinds.includes(m.kind)) && m.at <= window.to && (m.until ?? m.at) >= window.from)
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    },

    async nextMark(t, direction, kinds, signal) {
      if (!client.marks) return null;
      const fetchMarks = client.marks;
      const ask = () => fetchMarks({ ...(direction === 1 ? { afterMs: t } : { beforeMs: t }), kinds, limit: 1, signal });
      try {
        const page = await direct(ask, (p) => p.cursor);
        let best: TimelineMark | null = null;
        for (const raw of page.items) {
          const m = readMark(raw);
          // Strictly after or before, of the asked kinds, even if the observer was loose about either.
          if (!m || (kinds.length && !kinds.includes(m.kind)) || (direction === 1 ? m.at <= t : m.at >= t)) continue;
          if (!best || (direction === 1 ? m.at < best.at : m.at > best.at)) best = m;
        }
        mark("marks", "available");
        return best;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        if (!(error instanceof BackingOff)) {
          mark("marks", failedState(error));
          failed(error, ask);
        }
        return null;
      }
    },

    async density(window, buckets, filter, signal) {
      const from = Math.floor(window.from);
      const to = Math.max(from + 1, Math.ceil(window.to));
      let bucketMs = Math.max(1000, Math.ceil((to - from) / Math.max(1, buckets) / 1000) * 1000);
      bucketMs = Math.max(bucketMs, Math.ceil((to - from) / MAX_SERIES_BUCKETS / 1000) * 1000);
      const filtered = Boolean(filter?.ticket || filter?.execution);
      const nothing: FilteredDensity = { from, to, bucketMs, buckets: [], complete: false, filtered };
      if (!client.seriesFor && filtered) return nothing;
      const key = `series|${filter?.ticket ?? ""}|${filter?.execution ?? ""}|${from}|${to}|${bucketMs}`;
      try {
        const answer = await tile(seriesCache, key, isEdge({ from, to }), async (s) => {
          if (client.seriesFor) {
            const r = await client.seriesFor({ fromMs: from, toMs: to, bucketMs, ticket: filter?.ticket, execution: filter?.execution, signal: s });
            return { value: { from: r.fromMs, to: r.toMs, bucketMs: r.bucketMs, buckets: r.buckets.map((b) => ({ from: b.fromMs, count: b.count })), complete: r.complete === true }, version: r.cursor };
          }
          const r = await (client.series as NonNullable<ObserverClient["series"]>)({ fromMs: from, toMs: to, bucketMs });
          return { value: { from: r.fromMs, to: r.toMs, bucketMs: r.bucketMs, buckets: r.buckets.map((b) => ({ from: b.fromMs, count: b.count })), complete: false }, version: null };
        }, signal);
        mark("density", "available");
        return { ...answer.value, filtered };
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        if (!(error instanceof BackingOff)) mark("density", notFound(error) || (error instanceof ObserverError && error.kind === "unavailable") ? "unavailable" : "failed");
        return nothing;
      }
    },

    async concurrency(window, buckets, signal) {
      const from = Math.floor(window.from);
      const to = Math.max(from + 1, Math.ceil(window.to));
      const bucketMs = Math.max(1000, Math.ceil((to - from) / Math.max(1, buckets) / 1000) * 1000);
      const nothing: ConcurrencySeries = { from, to, bucketMs, buckets: [], limits: [], complete: false };
      if (!client.concurrency) return nothing;
      const fetchConcurrency = client.concurrency;
      try {
        const answer = await tile(concurrencyCache, `concurrency|${from}|${to}|${bucketMs}`, isEdge({ from, to }), async (s) => {
          const raw = await fetchConcurrency({ fromMs: from, toMs: to, bucketMs, signal: s });
          const parsed = readConcurrency(raw, { from, to, bucketMs });
          return { value: parsed ?? nothing, version: typeof raw.cursor === "string" ? raw.cursor : null };
        }, signal);
        mark("concurrency", "available");
        return answer.value;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        if (!(error instanceof BackingOff)) mark("concurrency", failedState(error));
        return nothing;
      }
    },

    availability: () => availability.read(),
    subscribe: watcher.subscribe,
  };
  return data;
}

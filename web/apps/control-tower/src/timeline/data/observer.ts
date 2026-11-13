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
 * observer: 404) or a failed request answers empty, and `timelineAvailability` says why. Nothing is
 * invented to fill a gap.
 */
import { ObserverError, parseCursor, type ObserverClient } from "../../live/observer";
import type { SceneStore } from "../../scene/store";
import type { ConcurrencySeries, DensitySeries, SpanPage, SpanQuery, TimeWindow, TimelineData, TimelineMark, TimelineSpan } from "../contract";
import { abortError, anySignal, createTileCache, isAbort, type Loaded } from "./cache";
import { byStart, honest, spanMatches, tilesFor } from "./derive";
import { readConcurrency, readMark, readSpan } from "./parse";
import { setAvailability, type PartState, type TimelineAvailability } from "./availability";
import { storeWatcher, THROTTLE_MS, type TimerLike } from "./watch";

/** The observer's own cap on spans per reply (apps/observer server.go MaxSpans). */
export const OBSERVER_SPAN_CAP = 5000;
/** The observer's `/series` bucket limit. */
const MAX_SERIES_BUCKETS = 2000;

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
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The observer did not answer.");
const cursorPos = (version: string | null): number => parseCursor(version)?.pos ?? -1;

export function createObserverTimelineData(client: ObserverClient, store: SceneStore, options: ObserverTimelineOptions = {}): TimelineData {
  const source = store.getState().source === "replay" ? "replay" : "live";
  const pageLimit = Math.min(1000, Math.max(1, options.pageLimit ?? 1000));
  const perTile = options.maxSpansPerTile ?? OBSERVER_SPAN_CAP;
  const spanTiles = createTileCache<SpanTile>(options.maxTiles ?? 96);
  const markTiles = createTileCache<readonly TimelineMark[]>(options.maxTiles ?? 96);
  const seriesCache = createTileCache<DensitySeries>(32);
  const concurrencyCache = createTileCache<ConcurrencySeries>(32);
  /** The latest spans() call per filter set: a newer one supersedes it. */
  const latest = new Map<string, AbortController>();

  const availability: { -readonly [K in keyof TimelineAvailability]: TimelineAvailability[K] } = {
    spans: client.spans ? "unknown" : "unavailable",
    marks: client.marks ? "unknown" : "unavailable",
    concurrency: client.concurrency ? "unknown" : "unavailable",
    density: "unknown",
    windowed: null,
    messages: {},
  };
  const mark = (part: "spans" | "marks" | "concurrency" | "density", state: PartState, message: string | null = null) => {
    availability[part] = state;
    availability.messages = { ...availability.messages, [part]: message ?? undefined };
  };

  const isEdge = (tile: TimeWindow): boolean => source === "live" && tile.to > store.getState().liveAt - 1;

  const watcher = storeWatcher(store, {
    timers: options.timers,
    throttleMs: options.throttleMs ?? THROTTLE_MS,
    changed: (prev, next) => prev.logVersion !== next.logVersion || prev.series !== next.series,
    before: () => {
      if (source !== "live") return;
      spanTiles.invalidateEdge();
      markTiles.invalidateEdge();
      seriesCache.invalidateEdge();
      concurrencyCache.invalidateEdge();
    },
  });

  const loadSpanTile = async (query: SpanQuery, tile: TimeWindow, signal: AbortSignal): Promise<Loaded<SpanTile>> => {
    const fetchSpans = client.spans as NonNullable<ObserverClient["spans"]>;
    const spans: TimelineSpan[] = [];
    let version: string | null = null;
    let truncated = false;
    let total: number | null = null;
    let windowed = false;
    for (let offset = 0; ; ) {
      const page = await fetchSpans({ fromMs: tile.from, toMs: tile.to, kinds: query.kinds, ticket: query.ticket, execution: query.execution, wave: query.wave, limit: pageLimit, offset, signal });
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
      const requests = tiles.map((tile) => spanTiles.get(`spans|${key}|${tile.from}|${tile.to}`, isEdge(tile), (s) => loadSpanTile(query, tile, s), combined));
      // Supersede the previous call for these filters only once this one holds its tiles, so shared tiles survive.
      latest.get(key)?.abort(abortError());
      latest.set(key, own);
      let answers: Loaded<SpanTile>[];
      try {
        answers = await Promise.all(requests);
      } catch (error) {
        if (isAbort(error) || combined.aborted) {
          // Every tile request already left; settle the rest so nothing is reported unhandled.
          await Promise.allSettled(requests);
          throw isAbort(error) ? error : abortError(combined);
        }
        await Promise.allSettled(requests);
        mark("spans", notFound(error) ? "unavailable" : "failed", messageOf(error));
        return empty();
      } finally {
        if (latest.get(key) === own) latest.delete(key);
      }
      // Newest version wins for a span held by several tiles (an open span seen again later, now ended).
      const chosen = new Map<string, { span: TimelineSpan; pos: number }>();
      let version: string | null = null;
      let truncated = false;
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
      availability.windowed = windowed;
      mark("spans", "available");
      const spans = honest([...chosen.values()].map((c) => c.span))
        .filter((s) => spanMatches(s, query))
        .sort(byStart);
      return { spans, truncated, total: truncated ? Math.max(total, spans.length) : spans.length, version: version ?? "" };
    },

    async span(id, signal) {
      if (!client.spans) return null;
      try {
        const page = await client.spans({ span: id, signal });
        for (const raw of page.items) {
          const span = readSpan(raw);
          if (span && span.id === id) return honest([span])[0] ?? null;
        }
        return null;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        return null;
      }
    },

    async marks(window, kinds, signal) {
      if (!client.marks) return [];
      const fetchMarks = client.marks;
      const k = kinds?.length ? [...kinds].sort().join(",") : "";
      const tiles = tilesFor(window);
      const requests = tiles.map((tile) =>
        markTiles.get(`marks|${k}|${tile.from}|${tile.to}`, isEdge(tile), async (s) => {
          const page = await fetchMarks({ fromMs: tile.from, toMs: tile.to, kinds, limit: 1000, signal: s });
          const marks: TimelineMark[] = [];
          for (const raw of page.items) {
            const m = readMark(raw);
            if (m) marks.push(m);
          }
          return { value: marks, version: page.cursor };
        }, signal),
      );
      let answers: Loaded<readonly TimelineMark[]>[];
      try {
        answers = await Promise.all(requests);
      } catch (error) {
        await Promise.allSettled(requests);
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        mark("marks", notFound(error) ? "unavailable" : "failed", notFound(error) ? "This observer does not serve marks." : messageOf(error));
        return [];
      }
      mark("marks", "available");
      const byId = new Map<string, TimelineMark>();
      for (const a of answers) for (const m of a.value) byId.set(m.id, m);
      return [...byId.values()]
        .filter((m) => (!kinds?.length || kinds.includes(m.kind)) && m.at <= window.to && (m.until ?? m.at) >= window.from)
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    },

    async nextMark(t, direction, kinds, signal) {
      if (!client.marks) return null;
      try {
        const page = await client.marks({ ...(direction === 1 ? { afterMs: t } : { beforeMs: t }), kinds, limit: 1, signal });
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
        mark("marks", notFound(error) ? "unavailable" : "failed", notFound(error) ? "This observer does not serve marks." : messageOf(error));
        return null;
      }
    },

    async density(window, buckets, filter, signal) {
      const from = Math.floor(window.from);
      const to = Math.max(from + 1, Math.ceil(window.to));
      let bucketMs = Math.max(1000, Math.ceil((to - from) / Math.max(1, buckets) / 1000) * 1000);
      bucketMs = Math.max(bucketMs, Math.ceil((to - from) / MAX_SERIES_BUCKETS / 1000) * 1000);
      const nothing: DensitySeries = { from, to, bucketMs, buckets: [], complete: false };
      const filtered = Boolean(filter?.ticket || filter?.execution);
      if (!client.seriesFor && filtered) return nothing;
      const key = `series|${filter?.ticket ?? ""}|${filter?.execution ?? ""}|${from}|${to}|${bucketMs}`;
      try {
        const answer = await seriesCache.get(key, isEdge({ from, to }), async (s) => {
          if (client.seriesFor) {
            const r = await client.seriesFor({ fromMs: from, toMs: to, bucketMs, ticket: filter?.ticket, execution: filter?.execution, signal: s });
            return { value: { from: r.fromMs, to: r.toMs, bucketMs: r.bucketMs, buckets: r.buckets.map((b) => ({ from: b.fromMs, count: b.count })), complete: r.complete === true }, version: r.cursor };
          }
          const r = await (client.series as NonNullable<ObserverClient["series"]>)({ fromMs: from, toMs: to, bucketMs });
          return { value: { from: r.fromMs, to: r.toMs, bucketMs: r.bucketMs, buckets: r.buckets.map((b) => ({ from: b.fromMs, count: b.count })), complete: false }, version: null };
        }, signal);
        mark("density", "available");
        return answer.value;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        mark("density", notFound(error) || (error instanceof ObserverError && error.kind === "unavailable") ? "unavailable" : "failed", messageOf(error));
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
        const answer = await concurrencyCache.get(`concurrency|${from}|${to}|${bucketMs}`, isEdge({ from, to }), async (s) => {
          const raw = await fetchConcurrency({ fromMs: from, toMs: to, bucketMs, signal: s });
          const parsed = readConcurrency(raw, { from, to, bucketMs });
          return { value: parsed ?? nothing, version: typeof raw.cursor === "string" ? raw.cursor : null };
        }, signal);
        mark("concurrency", "available");
        return answer.value;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        mark("concurrency", notFound(error) ? "unavailable" : "failed", notFound(error) ? "This observer does not serve concurrency." : messageOf(error));
        return nothing;
      }
    },

    subscribe: watcher.subscribe,
  };
  setAvailability(data, () => ({ ...availability, messages: { ...availability.messages } }));
  return data;
}


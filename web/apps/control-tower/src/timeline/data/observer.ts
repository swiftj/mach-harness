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
 *
 * Past tiles (T5): when the store's log moves, a late or out-of-order event may belong to any window.
 * Tiles holding an open span are re-read like edge tiles; every other tile is marked behind and read
 * again when next asked for, at most once per BEHIND_AFTER_MS, and subscribers are told again when
 * that time has passed so a late event shows even if nothing follows it.
 *
 * Memory (A6): span tiles are bounded by the spans they hold in all (MAX_HELD_SPANS), and a span held
 * by several tiles unchanged is one object, shared by id.
 *
 * Structure (X4): `structure()` reads the structural kinds over the whole history (no window), paged
 * to completion within the observer's cap, cached, and re-read when the cursor moves, throttled.
 */
import { ObserverError, parseCursor, type ObserverClient } from "../../live/observer";
import type { SceneStore } from "../../scene/store";
import { historyEndedAt } from "../../scene/connection";
import { STRUCTURAL_KINDS } from "../contract";
import type { ConcurrencySeries, DensitySeries, SpanPage, SpanQuery, TimeWindow, TimelineData, TimelineMark, TimelineSpan } from "../contract";
import { abortError, anySignal, BEHIND_AFTER_MS, createTileCache, isAbort, type Loaded, type TileCache } from "./cache";
import { byStart, closeEndedChildren, closeEndedVisits, endsWithHistory, honest, marksAnswer, spanMatches, tilesFor, type FilteredDensity } from "./derive";
import { readConcurrency, readMark, readSpan } from "./parse";
import { availabilityState, type Part, type PartState } from "./availability";
import { storeWatcher, THROTTLE_MS, type TimerLike } from "./watch";

/** The observer's own cap on spans per reply (apps/observer server.go MaxSpans). */
export const OBSERVER_SPAN_CAP = 5000;
/** The observer's `/series` bucket limit. */
const MAX_SERIES_BUCKETS = 2000;
/** Spans held across every span tile (A6). */
export const MAX_HELD_SPANS = 120_000;
/** Pages of marks read for one tile before saying the answer is cut (T8). */
export const MAX_MARK_PAGES = 10;
/** The structure is read again at most this often while the cursor moves. */
export const STRUCTURE_REFRESH_MS = 2000;
/** Structural spans read in all (the observer caps one query at OBSERVER_SPAN_CAP anyway). */
const MAX_STRUCTURE = 20_000;
/** Re-reads of lagging tiles for one stream position before leaving them to the next event. */
export const MAX_LAG_ROUNDS = 8;
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
  /** Spans held across every span tile. */
  readonly maxHeldSpans?: number;
  /** A past tile is re-read at most this often while the cursor moves. */
  readonly behindAfterMs?: number;
  readonly structureRefreshMs?: number;
  readonly now?: () => number;
}

/** What the provider holds, for tests and diagnostics (not in the contract). */
export interface HeldCounts {
  /** Span references held by span tiles (shared objects counted once per tile). */
  readonly spans: number;
  /** Distinct span objects shared by id. */
  readonly shared: number;
  readonly tiles: number;
  readonly structure: number;
}

/** Same span, same facts: safe to share one object between tiles. */
function sameSpan(a: TimelineSpan, b: TimelineSpan): boolean {
  const end = (x: TimelineSpan["end"], y: TimelineSpan["end"]) =>
    x === y || (x !== null && y !== null && x.at === y.at && x.notBefore === y.notBefore && x.notAfter === y.notAfter && x.reason === y.reason && x.basis === y.basis && x.rule === y.rule && x.eventId === y.eventId && x.precision === y.precision);
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.parent === b.parent &&
    a.outcome === b.outcome &&
    a.authority === b.authority &&
    end(a.start, b.start) &&
    end(a.end, b.end) &&
    a.duration.basis === b.duration.basis &&
    a.duration.ms === b.duration.ms &&
    a.duration.minMs === b.duration.minMs &&
    a.duration.maxMs === b.duration.maxMs &&
    JSON.stringify(a.ids) === JSON.stringify(b.ids) &&
    JSON.stringify(a.attrs) === JSON.stringify(b.attrs)
  );
}

interface MarkTile {
  readonly marks: readonly TimelineMark[];
  readonly truncated: boolean;
}

interface SpanTile {
  readonly spans: readonly TimelineSpan[];
  readonly truncated: boolean;
  readonly total: number;
  /** The reply said `truncated` (an M6.3 observer): the window was honoured. */
  readonly windowed: boolean;
  /**
   * Its pages answered from different projection positions (recheck R6): offset paging across them
   * can skip a span inserted mid-read, so the tile is marked lagging and read again.
   */
  readonly mixed?: boolean;
}

const notFound = (error: unknown): boolean => error instanceof ObserverError && (error.kind === "not_found" || error.status === 404);
const isReset = (error: unknown): boolean => error instanceof ObserverError && (error.kind === "cursor_reset" || error.status === 409);
const cursorPos = (version: string | null): number => parseCursor(version)?.pos ?? -1;

export function createObserverTimelineData(client: ObserverClient, store: SceneStore, options: ObserverTimelineOptions = {}): TimelineData {
  const source = store.getState().source === "replay" ? "replay" : "live";
  const timers: TimerLike = options.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>) };
  const pageLimit = Math.min(1000, Math.max(1, options.pageLimit ?? 1000));
  const perTile = options.maxSpansPerTile ?? OBSERVER_SPAN_CAP;
  const now = options.now ?? (() => Date.now());
  const behindAfterMs = options.behindAfterMs ?? BEHIND_AFTER_MS;

  // ---- one object per unchanged span, shared by the tiles holding it (A6).
  const pool = new Map<string, { span: TimelineSpan; refs: number }>();
  const share = (span: TimelineSpan): TimelineSpan => {
    const held = pool.get(span.id);
    if (held && sameSpan(held.span, span)) {
      held.refs += 1;
      return held.span;
    }
    if (!held || held.refs === 0) {
      pool.set(span.id, { span, refs: 1 });
      return span;
    }
    return span; // changed while an older version is still held elsewhere: kept apart, counted in its tile
  };
  const release = (tile: SpanTile) => {
    for (const s of tile.spans) {
      const held = pool.get(s.id);
      if (held && held.span === s && --held.refs <= 0) pool.delete(s.id);
    }
  };

  const common = { now, behindAfterMs };
  const spanTiles = createTileCache<SpanTile>({ ...common, max: options.maxTiles ?? 96, maxWeight: options.maxHeldSpans ?? MAX_HELD_SPANS, weigh: (v) => v.spans.length, holdsOpen: (v) => v.spans.some((x) => x.end === null), onDrop: release });
  const markTiles = createTileCache<MarkTile>({ ...common, max: options.maxTiles ?? 96 });
  const seriesCache = createTileCache<DensitySeries>({ ...common, max: 32 });
  const concurrencyCache = createTileCache<ConcurrencySeries>({ ...common, max: 32 });
  const structureCache = createTileCache<SpanTile>({ now, behindAfterMs: options.structureRefreshMs ?? STRUCTURE_REFRESH_MS, max: 2, onDrop: release });
  const caches: readonly TileCache<unknown>[] = [spanTiles, markTiles, seriesCache, concurrencyCache, structureCache] as readonly TileCache<unknown>[];
  /** The latest spans() call per filter set: a newer one supersedes it. */
  const latest = new Map<string, AbortController>();

  const availability = availabilityState({
    spans: client.spans ? "unknown" : "unavailable",
    marks: client.marks ? "unknown" : "unavailable",
    concurrency: client.concurrency ? "unknown" : "unavailable",
  });
  const mark = (part: Part, state: PartState) => availability.set(part, state);
  const failedState = (error: unknown): PartState => (notFound(error) ? "unavailable" : "failed");

  /**
   * The history's last recorded time when it is no longer live, else null: a replay, or a Factory whose
   * own records leave it disabled (factory.disabled last) with no supervisor lease held. Presentation
   * only (endsWithHistory); a live, enabled Factory keeps "at work".
   */
  const historyEnd = (): number | null => historyEndedAt({ ...store.getState(), source });

  const isEdge = (tile: TimeWindow): boolean => source === "live" && tile.to > store.getState().liveAt - 1;

  /** A notice due when the behind tiles may be re-read (one at a time). */
  let behindTimer: unknown = null;
  const watcher = storeWatcher(store, {
    timers: options.timers,
    throttleMs: options.throttleMs ?? THROTTLE_MS,
    // `logVersion` is the SHOWN log's version: while the scene shows a history window (the playhead or the
    // Timeline's window away from the live edge) it does not move with arrivals. `arrived` does, for every
    // event the store takes in, late and out-of-order ones included (T5).
    changed: (prev, next) =>
      prev.logVersion !== next.logVersion ||
      prev.arrived !== next.arrived ||
      prev.series !== next.series ||
      prev.factoryStatus?.recordedState !== next.factoryStatus?.recordedState ||
      prev.factoryStatus?.supervisor.leasePresent !== next.factoryStatus?.supervisor.leasePresent,
    before: () => {
      if (source !== "live") return;
      let wait: number | null = null;
      for (const c of caches) {
        c.invalidateEdge();
        const w = c.markBehind();
        if (w !== null && (wait === null || w > wait)) wait = w;
      }
      if (wait !== null && wait > 0) noticeIn(wait);
    },
  });
  /**
   * Tell subscribers again in `wait` ms. One timer is pending at a time; a notice due after it is
   * remembered (`laterDue`) and the timer is armed again for it when it fires, so a tile that falls
   * behind while an earlier notice is pending is still told about once it is due (recheck R1).
   */
  let timerDue = 0;
  let laterDue = 0;
  function noticeIn(wait: number): boolean {
    const due = now() + wait;
    if (behindTimer !== null) {
      if (due <= timerDue) return false;
      laterDue = Math.max(laterDue, due);
      return true;
    }
    timerDue = due;
    behindTimer = timers.setTimeout(() => {
      behindTimer = null;
      watcher.notify();
      const next = laterDue;
      laterDue = 0;
      if (next > timerDue) noticeIn(Math.max(1, next - now()));
    }, wait);
    return true;
  }

  // ---- lagging replies (T5): the observer's stream can deliver an event before its span projection
  // has taken it in, so a tile re-read on that event's notice may answer from just before it (its reply
  // cursor is behind the stream's). Such a tile stays behind and is read again once BEHIND_AFTER_MS old,
  // for as long as replies lag what the stream delivered, at most MAX_LAG_ROUNDS times per stream position.
  let lagAt = -1;
  let lagRounds = 0;
  const streamPos = (): { generation: string; pos: number } | null => parseCursor(store.getState().connection?.cursor ?? null);
  const checkLag = (cache: TileCache<unknown>, key: string, version: string | null): void => {
    if (source !== "live" || version === null) return;
    const held = streamPos();
    const got = parseCursor(version);
    if (!held || !got || held.generation !== got.generation || got.pos >= held.pos) return;
    if (held.pos !== lagAt) {
      lagAt = held.pos;
      lagRounds = 0;
    }
    if (lagRounds >= MAX_LAG_ROUNDS) return;
    const wait = cache.markLagging(key);
    if (wait === null) return;
    if (noticeIn(Math.max(wait, 50))) lagRounds += 1;
  };

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
    return cache.get(key, edge, loader, signal).then((answer) => {
      checkLag(cache as TileCache<unknown>, key, answer.version);
      return answer;
    }).catch((error: unknown) => {
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
    let first: string | null | undefined;
    let mixed = false;
    for (let offset = 0; ; ) {
      const page = await fetchSpans({ fromMs: t.from, toMs: t.to, kinds: query.kinds, ticket: query.ticket, execution: query.execution, wave: query.wave, limit: pageLimit, offset, signal });
      if (first === undefined) first = page.cursor;
      else if (page.cursor !== first) mixed = true;
      if (cursorPos(page.cursor) >= cursorPos(version)) version = page.cursor;
      for (const raw of page.items) {
        const span = readSpan(raw);
        if (span) spans.push(share(span));
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
    return { value: { spans, truncated, total: Math.max(total ?? 0, spans.length), windowed, ...(mixed ? { mixed } : {}) }, version };
  };

  /** A tile read across projection positions is read again once due (R6). */
  const lagIfMixed = (key: string) => (answer: Loaded<SpanTile>): Loaded<SpanTile> => {
    if (answer.value.mixed) {
      const wait = spanTiles.markLagging(key);
      if (wait !== null) noticeIn(Math.max(wait, 50));
    }
    return answer;
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
      const requests = tiles.map((t) => {
        const k = `spans|${key}|${t.from}|${t.to}`;
        return tile(spanTiles, k, isEdge(t), (s) => loadSpanTile(query, t, s), combined).then(lagIfMixed(k));
      });
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
      // The client's safety net is for an older observer only: an M6.3 observer (a windowed reply) already
      // closed what its rules close, and deliberately left the rest open (T3).
      const held = honest([...chosen.values()].map((c) => c.span));
      // The children of an ended execution are closed on every answer (an observer that closes them leaves nothing to do).
      const spans = closeEndedChildren(windowed ? held : closeEndedVisits(held))
        .filter((s) => spanMatches(s, query))
        .sort(byStart);
      return { spans: endsWithHistory(spans, historyEnd()), truncated, total: truncated ? Math.max(total, spans.length) : spans.length, version: version ?? "" };
    },

    async span(id, signal) {
      if (!client.spans) return null;
      const fetchSpans = client.spans;
      try {
        const page = await direct(() => fetchSpans({ span: id, signal }), (p) => p.cursor);
        for (const raw of page.items) {
          const span = readSpan(raw);
          if (span && span.id === id) return endsWithHistory(honest([span]), historyEnd())[0] ?? null;
        }
        return null;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        if (!(error instanceof BackingOff)) failed(error, () => fetchSpans({ span: id }));
        return null;
      }
    },

    async structure(signal) {
      const empty = (): SpanPage => ({ spans: [], truncated: false, total: 0, version: "" });
      if (!client.spans) return empty();
      const fetchSpans = client.spans;
      const want = new Set<string>(STRUCTURAL_KINDS);
      const load = async (s: AbortSignal): Promise<Loaded<SpanTile>> => {
        const spans: TimelineSpan[] = [];
        let version: string | null = null;
        let truncated = false;
        let total: number | null = null;
        let kinds: readonly string[] | undefined = STRUCTURAL_KINDS;
        let said = false;
        for (let offset = 0; ; ) {
          let page;
          try {
            page = await fetchSpans({ kinds, limit: pageLimit, offset, signal: s });
          } catch (error) {
            // An observer that refuses one of the kinds (older): ask for every kind and keep the structural ones here.
            if (kinds && offset === 0 && error instanceof ObserverError && (error.kind === "invalid" || error.status === 400)) {
              kinds = undefined;
              continue;
            }
            throw error;
          }
          if (cursorPos(page.cursor) >= cursorPos(version)) version = page.cursor;
          for (const raw of page.items) {
            const span = readSpan(raw);
            if (span && want.has(span.kind)) spans.push(share(span));
          }
          if (page.truncated === true) truncated = true;
          said = said || page.truncated !== null;
          total = page.totalUncapped ?? page.total ?? total;
          offset += page.items.length;
          if (!page.more || page.items.length === 0) break;
          if (offset >= MAX_STRUCTURE) {
            truncated = true;
            break;
          }
        }
        // An observer before M6.3 cuts at its cap without saying so.
        if (!said && (total ?? 0) >= OBSERVER_SPAN_CAP) truncated = true;
        return { value: { spans, truncated, total: Math.max(total ?? 0, spans.length), windowed: true }, version };
      };
      try {
        const answer = await tile(structureCache, "structure", false, load, signal);
        mark("spans", "available");
        const spans = endsWithHistory(closeEndedChildren(honest(answer.value.spans)).sort(byStart), historyEnd());
        return { spans, truncated: answer.value.truncated, total: answer.value.truncated ? answer.value.total : spans.length, version: answer.version ?? "" };
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw isAbort(error) ? error : abortError(signal);
        if (!(error instanceof BackingOff)) mark("spans", failedState(error));
        return empty();
      }
    },

    async marks(window, kinds, signal) {
      if (!client.marks) return marksAnswer([], false, false);
      const fetchMarks = client.marks;
      const k = kinds?.length ? [...kinds].sort().join(",") : "";
      const tiles = tilesFor(window);
      const requests = tiles.map((t) =>
        tile(markTiles, `marks|${k}|${t.from}|${t.to}`, isEdge(t), async (s) => {
          // Paged to completion within MAX_MARK_PAGES (T8): by offset when the observer pages, else by moving
          // the window's start to the last mark read; a page that adds nothing new ends it as cut.
          const byId = new Map<string, TimelineMark>();
          let version: string | null = null;
          let truncated = false;
          let fromMs = t.from;
          let offset = 0;
          for (let pages = 0; ; pages++) {
            if (pages >= MAX_MARK_PAGES) {
              truncated = true;
              break;
            }
            const page = await fetchMarks({ fromMs, toMs: t.to, kinds, limit: 1000, offset, signal: s });
            if (cursorPos(page.cursor) >= cursorPos(version)) version = page.cursor;
            const before = byId.size;
            let last = Number.NEGATIVE_INFINITY;
            for (const raw of page.items) {
              const m = readMark(raw);
              if (!m) continue;
              byId.set(m.id, m);
              if (m.at > last) last = m.at;
            }
            const more = page.more === true || ((page.more === null || page.more === undefined) && page.truncated === true);
            if (!more) break;
            if (byId.size === before || page.items.length === 0) {
              truncated = true; // no progress: the observer did not page as asked
              break;
            }
            if (page.more === true) offset += page.items.length;
            else {
              if (!(last > fromMs)) {
                truncated = true;
                break;
              }
              fromMs = last;
            }
          }
          return { value: { marks: [...byId.values()], truncated }, version };
        }, signal),
      );
      const settled = await Promise.allSettled(requests);
      if (signal?.aborted) throw abortError(signal);
      const aborted = settled.find((r) => r.status === "rejected" && isAbort(r.reason));
      if (aborted) throw (aborted as PromiseRejectedResult).reason;
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failure && !(failure.reason instanceof BackingOff)) mark("marks", failedState(failure.reason));
      else if (!failure) mark("marks", "available");
      // The same mark from several tiles (or repeated after a reconnect) is one mark: by id.
      const byId = new Map<string, TimelineMark>();
      let truncated = false;
      for (const a of settled) {
        if (a.status !== "fulfilled") continue;
        truncated = truncated || a.value.value.truncated;
        for (const m of a.value.value.marks) byId.set(m.id, m);
      }
      const marks = [...byId.values()]
        .filter((m) => (!kinds?.length || kinds.includes(m.kind)) && m.at <= window.to && (m.until ?? m.at) >= window.from)
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      return marksAnswer(marks, truncated, !truncated && failure === undefined);
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
  return Object.assign(data, {
    /** Not in the contract: the exact time of the newest event the client holds (recordedExtent reads it). */
    lastRecordedAt(): number | null {
      const s = store.getState();
      if (s.extent.events === 0) return null;
      return s.log?.headTime?.() ?? null;
    },
    /** Not in the contract: what is held, for tests and diagnostics. */
    held(): HeldCounts {
      return { spans: spanTiles.weight, shared: pool.size, tiles: spanTiles.size, structure: structureCache.size };
    },
  });
}

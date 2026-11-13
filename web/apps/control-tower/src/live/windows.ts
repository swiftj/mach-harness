/**
 * A long history, read in windows on demand (D17), for Historical replay and for a live store
 * scrubbed back past what it holds. Nothing is loaded eagerly: the timeline draws the whole history
 * from `/api/v1/series` (counts per time bucket), and the scene at a moment is built from the window
 * that holds it.
 *
 * - **A fixed grid.** The history's span is cut into windows of equal length, chosen once from its
 *   size so that a window holds about `windowEvents` events. A moment always maps to the same window,
 *   so the same history gives the same scene at the same moment, however it was scrubbed to.
 * - **One window** is the state at its start (`/snapshot?at=` the cursor just before its first event,
 *   seeded as a reconstructed `client.snapshot_applied`) plus every event in it, in order
 *   (`/history?from_ms&to_ms`), reduced into a scene log of its own. An observer without `/snapshot`
 *   gives a window that says "partial before here" instead.
 * - **A small LRU** of windows (`keep`, default 4): scrubbing back and forth near the playhead costs a
 *   fetch only when a new window is needed; scrubbing within one is the log's own checkpoints.
 *
 * Reads only. Wall time is never read here.
 */
import { createSceneLog } from "../sim/log";
import type { SceneLog } from "../sim/log";
import type { ProductDefinitions } from "../sim/model";
import { provenance as provenanceOf } from "../sim/provenance";
import type { SceneSource } from "../sim/provenance";
import type { AnyV3Event, EngineEvent } from "../sim/v3";
import { parseV3 } from "../sim/v3";
import type { HistoryWindow, HistoryWindows, SeriesState } from "../scene/store";
import type { ObserverClient, SeriesData } from "./observer";
import { ObserverError, parseCursor } from "./observer";
import { clientEvent } from "./markers";

export interface WindowedHistory extends HistoryWindows {
  /** Learn the history's span (from `/series`, else the first and last events). Call once before use. */
  init(): Promise<void>;
  /** The span and size the grid was cut from (null before init). */
  span(): { readonly start: number; readonly end: number; readonly total: number | null; readonly windowMs: number } | null;
  /** The series the span came from, for the timeline. */
  series(): SeriesState | null;
  /** Fetches made so far (tests and measurements). */
  stats(): { readonly fetched: number; readonly hits: number; readonly held: number };
}

export interface WindowedHistoryOptions {
  readonly client: ObserverClient;
  readonly definitions: ProductDefinitions;
  readonly source: SceneSource;
  readonly origin?: string | null;
  /** About this many events per window (default 5,000). */
  readonly windowEvents?: number;
  /** Windows kept (default 4). */
  readonly keep?: number;
  /** Page size for `/history` (default 5,000, the observer's maximum). */
  readonly pageLimit?: number;
  /** A known end of history (live: the newest event held); default: the last event the observer has. */
  readonly end?: number | null;
}

const MIN_WINDOW_MS = 60_000;

export function createWindowedHistory(options: WindowedHistoryOptions): WindowedHistory {
  const { client, definitions } = options;
  const windowEvents = Math.max(500, options.windowEvents ?? 5000);
  const keep = Math.max(1, options.keep ?? 4);
  const pageLimit = options.pageLimit ?? 5000;
  const prov = provenanceOf(options.source, options.origin ?? null);
  let span: { start: number; end: number; total: number | null; windowMs: number } | null = null;
  let seriesState: SeriesState | null = null;
  let snapshots = true;
  let generation = "";
  const held = new Map<number, HistoryWindow>();
  const pending = new Map<number, Promise<HistoryWindow>>();
  let fetched = 0;
  let hits = 0;

  const parse = (raw: readonly unknown[]): EngineEvent[] => raw.map(parseV3).filter((e): e is NonNullable<typeof e> => e !== null);
  const indexOf = (t: number): number => (span ? Math.max(0, Math.floor((t - span.start) / span.windowMs)) : 0);
  const bounds = (k: number): { from: number; to: number } => {
    const s = span as NonNullable<typeof span>;
    const from = s.start + k * s.windowMs;
    const last = from + s.windowMs > s.end;
    return { from, to: last ? Infinity : from + s.windowMs };
  };

  /** Every event of [from, to) in order. */
  const readWindow = async (from: number, to: number): Promise<EngineEvent[]> => {
    const out: EngineEvent[] = [];
    let fromOrder: string | null = null;
    for (;;) {
      const page = await client.history({ fromOrder, fromMs: fromOrder ? null : from, toMs: Number.isFinite(to) ? to : null, limit: pageLimit });
      out.push(...parse(page.events));
      if (!page.more || !page.nextFromOrder) return out;
      fromOrder = page.nextFromOrder;
    }
  };

  /** The state just before the window: the snapshot at the cursor before its first event (or the first event after it). */
  const seedFor = async (from: number, events: readonly EngineEvent[]): Promise<EngineEvent | null> => {
    let first = events.reduce<number | null>((min, e) => (e.schema_version === 3 && (min === null || e.pos < min) ? e.pos : min), null);
    if (first === null) {
      // An empty window: the state at its start is the state before the first event after it.
      const after = await client.history({ fromMs: from, limit: 1 });
      const next = parse(after.events)[0];
      first = next && next.schema_version === 3 ? next.pos : null;
    }
    if (snapshots && first !== null && first > 1) {
      try {
        const snapshot = await client.snapshot(`${generation}.${first - 1}`);
        return clientEvent("client.snapshot_applied", 1, from - 1, { cursor: snapshot.cursor, generation: snapshot.generation, state: snapshot.state } as AnyV3Event["data"]);
      } catch (error) {
        if (error instanceof ObserverError && error.kind === "not_found") snapshots = false;
        else if (!(error instanceof ObserverError && (error.kind === "cursor_expired" || error.kind === "cursor_reset"))) throw error;
      }
    }
    if (first !== null && first <= 1) return null; // the window begins the history: nothing before it
    return clientEvent("client.history_missing", 1, from - 1, { reason: "window", after: null, resumed_at: null } as AnyV3Event["data"]);
  };

  const build = async (k: number): Promise<HistoryWindow> => {
    const { from, to } = bounds(k);
    fetched += 1;
    const events = await readWindow(from, to);
    const seed = await seedFor(from, events);
    const log: SceneLog = createSceneLog({ definitions, provenance: prov, checkpointEvery: 128, cacheSize: 256 });
    log.ingest(seed ? [seed, ...events] : events);
    return { log, from, to };
  };

  const remember = (k: number, w: HistoryWindow): void => {
    held.delete(k);
    held.set(k, w);
    while (held.size > keep) held.delete(held.keys().next().value as number);
  };

  const self: WindowedHistory = {
    async init() {
      const session = await client.session();
      generation = session.generation;
      snapshots = session.snapshot;
      let data: SeriesData | null = null;
      try {
        data = await client.series();
      } catch (error) {
        if (!(error instanceof ObserverError) || (error.kind !== "not_found" && error.kind !== "invalid")) throw error;
      }
      let start: number | null = data && data.buckets.length ? data.buckets[0]!.fromMs : null;
      let end: number | null = data ? Math.max(data.toMs, ...data.buckets.map((b) => b.fromMs + data!.bucketMs)) : null;
      let total = data?.total ?? null;
      if (start === null) {
        const first = parse((await client.history({ limit: 1 })).events)[0];
        start = first && first.schema_version === 3 ? first.time.order_ms : null;
      }
      if (start === null) return;
      if (options.end !== undefined && options.end !== null) end = Math.max(end ?? 0, options.end);
      if (end === null || end <= start) end = start + MIN_WINDOW_MS;
      if (total === null) {
        // Coarse: sample the span (D17 fallback) so the timeline still draws where history is.
        data = await coarseSeries(client, start, end);
        const page = await client.events(`${generation}.0`, 1).catch((e: unknown) => (e instanceof ObserverError ? { head: typeof e.detail.head === "string" ? e.detail.head : null } : { head: null }));
        total = parseCursor(page.head)?.pos ?? null;
      }
      const windows = total ? Math.max(1, Math.ceil(total / windowEvents)) : 1;
      span = { start, end, total, windowMs: Math.max(MIN_WINDOW_MS, Math.ceil((end - start + 1) / windows)) };
      seriesState = data ? { bucketMs: data.bucketMs, buckets: data.buckets, total: data.total ?? total, coarse: data.coarse } : null;
    },
    span: () => span,
    series: () => seriesState,
    start: () => span?.start ?? null,
    peek(t) {
      if (!span) return null;
      const w = held.get(indexOf(t));
      if (w) hits += 1;
      return w ?? null;
    },
    load(t) {
      if (!span) return Promise.reject(new Error("The history's span is not known yet."));
      const k = indexOf(t);
      const hit = held.get(k);
      if (hit) {
        remember(k, hit);
        return Promise.resolve(hit);
      }
      const running = pending.get(k);
      if (running) return running;
      const p = build(k).then(
        (w) => {
          pending.delete(k);
          remember(k, w);
          return w;
        },
        (error: unknown) => {
          pending.delete(k);
          throw error;
        },
      );
      pending.set(k, p);
      return p;
    },
    stats: () => ({ fetched, hits, held: held.size }),
  };
  return self;
}

/**
 * Counts per time bucket without `/series`: a few `/history` reads with a small limit, each a lower
 * bound when it is full (`atLeast`). Coarse, and said so.
 */
export async function coarseSeries(client: ObserverClient, start: number, end: number, samples = 24, limit = 200): Promise<SeriesData> {
  const bucketMs = Math.max(1000, Math.ceil((end - start + 1) / samples));
  const buckets: { fromMs: number; count: number; atLeast?: boolean }[] = [];
  for (let k = 0; k < samples; k++) {
    const from = start + k * bucketMs;
    if (from > end) break;
    const page = await client.history({ fromMs: from, toMs: from + bucketMs, limit });
    if (page.events.length) buckets.push({ fromMs: from, count: page.events.length, ...(page.more ? { atLeast: true } : {}) });
  }
  return { fromMs: start, toMs: end, bucketMs, buckets, total: null, coarse: true };
}

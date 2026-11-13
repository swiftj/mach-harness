/**
 * The live source: connects the observer's stream to one scene log and one store.
 *
 *   session ─► history pages (GET /events?after=<cursor>) ─► SSE /stream?after=<cursor>&schema=3
 *        ▲                                                         │ hello · events · heartbeat
 *        └──── recover: gap (cursor expired) / reset (new epoch) ◄──┘ gap · reset · error
 *
 * - **Durable cursor.** Every event carries `<epoch>.<pos>`; the source resumes from the last one it
 *   applied (`?after=`; an EventSource cannot set Last-Event-ID itself when reopened by hand).
 * - **Batches per frame.** Received events are queued and applied to the log once per animation
 *   frame (contract 14; architecture 7.2), then the store is told once.
 * - **Duplicates and late events** are the log's business: same id is dropped, an earlier `order`
 *   is inserted and the scenes re-derived.
 * - **Bounded start (D17).** A history longer than `liveWindow` events (or one the observer no longer
 *   holds from its beginning) is never fetched whole, and neither is the observer's whole projected
 *   state (`/snapshot`: about 35 MB of JSON at 230,000 events). The source reads the observer's
 *   summaries (`/waves`, `/slices`, `/cells`, `/runs`, `/project`: bounded by how many there are, not
 *   by events), then the newest `liveWindow` events (`/events?after=`), and seeds from the summaries
 *   only what no event of the window touches (its state then held through the window), as a
 *   reconstructed `client.snapshot_applied`; a `client.history_missing` marker says history before
 *   the window is not loaded. The timeline's density comes from `/series`; scrubbing back reads
 *   `/history` windows on demand (`windows.ts`).
 * - **gap** (the cursor fell below the observer's floor): history between is missing. A
 *   `client.history_missing` marker goes into the log (the scene says partial), then the bounded
 *   start again from the observer's newest window.
 * - **reset** (the index was rebuilt: a new epoch): ids and order are deterministic (contract 6.4),
 *   so history is fetched again (the bounded start for a long history, else from the start of the
 *   new epoch); what is already held de-duplicates.
 * - Neither touches selection, hover, view, camera follow or a replay's playhead: they live in the
 *   store, and the store keeps them across `logChanged`.
 * - **Staleness.** No message (event or heartbeat) for `staleAfterMs` (default 2.5 heartbeats):
 *   `stale`, with `staleSince` the last confirmed moment. Any message: `live` again.
 * - **Lost observer.** A dropped stream is `reconnecting`; after DISCONNECTED_AFTER failed attempts
 *   in a row it is `disconnected`, still retrying with back-off (1 s doubling to 30 s). The observer
 *   keeps its sessions, its index and its port across a restart, so when it answers again on the
 *   same origin the source resumes from its cursor: nothing is reloaded, nothing applied twice.
 * - **No session.** The observer answered 401: `no-session`, no retry (a new link is needed).
 * - **The Factory's state.** `/factory/status` is read every `statusEveryMs` and handed to the store
 *   (`state.factoryStatus`): enabled, paused, Factory state present, the supervisor's heartbeat,
 *   per-source lag.
 *
 * Wall time only through the injected clock and timers.
 */
import { createSceneLog } from "../sim/log";
import type { SceneLog } from "../sim/log";
import type { ProductDefinitions } from "../sim/model";
import { provenance } from "../sim/provenance";
import type { AnyV3Event, EngineEvent, ObserverSnapshotState } from "../sim/v3";
import { parseV3 } from "../sim/v3";
import type { Clock } from "../scene/clock";
import type { ConnectionStatus } from "../scene/connection";
import { DISCONNECTED_AFTER, INITIAL_CONNECTION } from "../scene/connection";
import type { SceneStore } from "../scene/store";
import { createSceneStore } from "../scene/store";
import type { ObserverClient } from "./observer";
import type { SceneSource } from "../sim/provenance";
import { ObserverError, parseCursor, timeOf } from "./observer";
import { clientEvent } from "./markers";
import { createWindowedHistory, type WindowedHistory } from "./windows";

/** The parts of the browser's EventSource the source uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { readonly data: string; readonly lastEventId?: string }) => void): void;
  onmessage: ((event: { readonly data: string; readonly lastEventId: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}
export type OpenStream = (url: string) => EventSourceLike;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LiveSourceOptions {
  readonly client: ObserverClient;
  readonly openStream: OpenStream;
  readonly log: SceneLog;
  readonly store: SceneStore;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly base?: string;
  /** Silence before `stale` (default: 2.5 x the observer's heartbeat, or 37.5 s). */
  readonly staleAfterMs?: number;
  /** Reconnection back-off: first delay, cap (defaults 1 s, 30 s). */
  readonly retryMs?: number;
  readonly retryCapMs?: number;
  readonly statusEveryMs?: number;
  readonly pageLimit?: number;
  /** A cursor kept from an earlier session (sessionStorage), to resume without reloading. */
  readonly cursor?: string | null;
  /** The observer's settle window, used when a heartbeat carries no watermark (contract 6.5). */
  readonly settleMs?: number;
  /**
   * The most recent events loaded at start (default 20,000). A longer history starts from the
   * observer's summaries and this many events (D17); what is before them is read in windows, on
   * demand, when the person scrubs back (`windows`).
   */
  readonly liveWindow?: number;
  /** A long history read in windows: initialised here once connected (its span, the series). */
  readonly windows?: WindowedHistory;
  /** How often the series is read again (default 30 s). */
  readonly seriesEveryMs?: number;
}

export interface LiveSource {
  start(): Promise<void>;
  stop(): void;
  /** For tests and the inspector: what the source holds now. */
  status(): ConnectionStatus;
  /** Apply what is queued now, without waiting for a frame (tests). */
  flush(): void;
}

export function createLiveSource(options: LiveSourceOptions): LiveSource {
  const { client, openStream, log, store, clock, timers } = options;
  const base = options.base ?? "/api/v1";
  const pageLimit = options.pageLimit ?? 1000;
  const retryMs = options.retryMs ?? 1000;
  const retryCapMs = options.retryCapMs ?? 30_000;
  const settleMs = options.settleMs ?? 1500;
  let staleAfterMs = options.staleAfterMs ?? 37_500;

  let status: ConnectionStatus = { ...INITIAL_CONNECTION, cursor: options.cursor ?? null };
  let stream: EventSourceLike | null = null;
  let queue: unknown[] = [];
  let frame: number | null = null;
  let lastMessageWall = clock.now();
  let retryTimer: unknown = null;
  let staleTimer: unknown = null;
  let statusTimer: unknown = null;
  let stopped = false;
  let recovering = false;
  let markers = 0;
  let refused = 0;
  let seriesTimer: unknown = null;
  const liveWindow = Math.max(1000, options.liveWindow ?? 20_000);

  const publish = (patch: Partial<ConnectionStatus>): void => {
    status = { ...status, ...patch };
    store.setConnection(status);
  };

  const confirmed = (): number => Math.max(status.confirmedAt ?? 0, log.headTime() ?? 0);

  /** The observer's total: its head position, the highest seen (cursors, pages, positions). */
  const seeTotal = (cursorOrPos: string | number | null | undefined): void => {
    const pos = typeof cursorOrPos === "number" ? cursorOrPos : parseCursor(cursorOrPos ?? null)?.pos;
    if (typeof pos === "number" && pos > (status.total ?? 0)) status = { ...status, total: pos };
  };

  const apply = (events: readonly EngineEvent[]): void => {
    if (refused !== status.refused) publish({ refused });
    if (!events.length) return;
    // The observer's own `late` flag, on events not already held (a re-delivery is not late twice).
    let flagged = 0;
    for (const e of events) if (e.schema_version === 3 && e.late && !log.entry(e.id)) flagged += 1;
    for (const e of events) if (e.schema_version === 3 && !e.id.startsWith("k:")) seeTotal(e.pos);
    const result = log.ingest(events);
    if (result.added) store.logChanged();
    const head = log.headTime();
    publish({
      received: status.received + result.added,
      duplicates: status.duplicates + result.duplicates,
      late: status.late + flagged,
      reordered: status.reordered + result.late,
      held: heldEvents(),
      confirmedAt: head === null ? status.confirmedAt : Math.max(status.confirmedAt ?? 0, head),
    });
  };

  /** Events held now, the client's own markers apart. */
  const heldEvents = (): number => Math.max(0, log.stats().events - log.entries().reduce((n, e) => (e.id.startsWith("k:") ? n + 1 : n), 0));

  const parseAll = (raw: readonly unknown[]): EngineEvent[] => {
    const out: EngineEvent[] = [];
    for (const item of raw) {
      const event = parseV3(typeof item === "string" ? safeJson(item) : item);
      if (event) out.push(event);
      else refused += 1;
    }
    return out;
  };

  const flush = (): void => {
    if (frame !== null) clock.cancel(frame);
    frame = null;
    const batch = queue;
    queue = [];
    apply(parseAll(batch));
  };

  const heard = (): void => {
    lastMessageWall = clock.now();
    if (status.state === "stale" || status.state === "connecting" || status.state === "reconnecting" || status.state === "disconnected") publish({ state: "live", staleSince: null, attempts: 0, reason: null });
  };

  const closeStream = (): void => {
    if (stream) {
      stream.onmessage = null;
      stream.onerror = null;
      stream.close();
    }
    stream = null;
  };

  const backfill = async (after: string): Promise<string> => {
    let cursor = after;
    for (;;) {
      const page = await client.events(cursor, pageLimit);
      seeTotal(page.head);
      apply(parseAll(page.events));
      if (page.watermark !== null) {
        store.setLiveEdge(page.watermark);
        publish({ watermark: page.watermark });
      }
      cursor = page.next ?? cursor;
      publish({ cursor, generation: page.generation || status.generation });
      if (!page.more) return cursor;
    }
  };

  const reconnectLater = (reason: string): void => {
    if (stopped || retryTimer !== null) return;
    const attempts = status.attempts + 1;
    // Not "reconnecting" forever: after a few failures in a row the observer is said to be lost, and
    // the source goes on trying (an observer restarted on the same port is found again).
    publish({ state: attempts > DISCONNECTED_AFTER ? "disconnected" : "reconnecting", attempts, reason, staleSince: status.staleSince ?? confirmed() });
    const delay = Math.min(retryCapMs, retryMs * 2 ** Math.min(10, attempts - 1));
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const openLive = (): void => {
    closeStream();
    const cursor = status.cursor ?? `${status.generation ?? ""}.0`;
    const es = openStream(`${base}/stream?schema=3&after=${encodeURIComponent(cursor)}`);
    stream = es;
    es.addEventListener("hello", (m) => {
      const d = safeJson(m.data) as Record<string, unknown> | null;
      const beat = typeof d?.heartbeat_ms === "number" ? d.heartbeat_ms : null;
      if (beat && options.staleAfterMs === undefined) staleAfterMs = beat * 2.5;
      if (typeof d?.generation === "string" && status.generation && d.generation !== status.generation) {
        void recover("reset");
        return;
      }
      heard();
    });
    es.onmessage = (m) => {
      heard();
      queue.push(m.data);
      if (m.lastEventId) {
        status = { ...status, cursor: m.lastEventId };
        seeTotal(m.lastEventId);
      }
      if (frame === null) frame = clock.request(() => flush());
    };
    es.addEventListener("heartbeat", (m) => {
      heard();
      const d = (safeJson(m.data) ?? {}) as Record<string, unknown>;
      const at = timeOf(d.at_ms ?? d.at);
      const watermark = timeOf(d.watermark_ms ?? d.watermark) ?? (at === null ? null : at - settleMs);
      if (watermark !== null) store.setLiveEdge(watermark);
      seeTotal(typeof d.head === "string" ? d.head : null);
      publish({ watermark, sourceLagMs: at !== null && watermark !== null ? Math.max(0, at - watermark) : status.sourceLagMs, confirmedAt: Math.max(confirmed(), watermark ?? 0) });
    });
    es.addEventListener("gap", (m) => {
      const d = (safeJson(m.data) ?? {}) as Record<string, unknown>;
      void recover("expired", typeof d.floor === "string" ? d.floor : null);
    });
    es.addEventListener("reset", () => void recover("reset"));
    es.onerror = () => {
      flush();
      closeStream();
      reconnectLater("The stream dropped; resuming from the last cursor.");
    };
  };

  /** History is missing (expired) or the index was rebuilt (reset): reload, keep everything the person set. */
  const recover = async (reason: "expired" | "reset", floor: string | null = null): Promise<void> => {
    if (recovering || stopped) return;
    recovering = true;
    flush();
    closeStream();
    const before = status.cursor;
    publish({ state: "connecting", reason: reason === "expired" ? "History was missed; reloading." : "The observer rebuilt its index; reloading.", gaps: status.gaps + (reason === "expired" ? 1 : 0), resets: status.resets + (reason === "reset" ? 1 : 0) });
    try {
      const session = await client.session();
      publish({ generation: session.generation });
      if (reason === "expired") {
        markers += 1;
        apply([clientEvent("client.history_missing", markers, confirmed(), { reason, after: before, resumed_at: floor } as AnyV3Event["data"])]);
      }
      // The bounded start again: a short history from the epoch's start (what is held de-duplicates),
      // a long one (or one whose start has expired) from the summaries and its newest window. Never
      // the observer's whole state.
      let after = await startWindow(session.generation);
      after = await backfillFrom(after);
      publish({ cursor: after });
      recovering = false;
      openLive();
    } catch (error) {
      recovering = false;
      reconnectLater(error instanceof Error ? error.message : "Recovery failed.");
    }
  };

  /** Backfill, starting at the floor when the requested cursor has expired. */
  const backfillFrom = async (after: string): Promise<string> => {
    try {
      return await backfill(after);
    } catch (error) {
      if (error instanceof ObserverError && error.kind === "cursor_expired" && typeof error.detail.floor === "string") return backfill(error.detail.floor);
      throw error;
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      const session = await client.session();
      const held = parseCursor(status.cursor);
      if (held && held.generation !== session.generation) {
        publish({ generation: held.generation });
        await recover("reset");
        return;
      }
      publish({ generation: session.generation, state: status.state === "reconnecting" || status.state === "disconnected" ? status.state : "connecting" });
      const start = status.cursor ?? (await startWindow(session.generation));
      const cursor = await backfill(start);
      publish({ cursor });
      openLive();
      void startWindows();
    } catch (error) {
      if (error instanceof ObserverError && error.kind === "cursor_expired") return recover("expired");
      if (error instanceof ObserverError && error.kind === "cursor_reset") return recover("reset");
      if (error instanceof ObserverError && error.kind === "unauthorized") {
        // 401: the observer does not know this browser. Retrying cannot help; a new link can.
        publish({ state: "no-session", reason: error.message, staleSince: confirmed() || null });
        return;
      }
      if (error instanceof ObserverError && error.kind === "invalid") {
        publish({ state: "disconnected", attempts: 0, reason: error.message, staleSince: confirmed() || null });
        return;
      }
      reconnectLater(error instanceof Error ? error.message : "The observer could not be reached.");
    }
  };

  /**
   * Where a fresh page starts (D17): from the beginning when the history is short and whole;
   * otherwise from the observer's summaries and its newest `liveWindow` events (see the header).
   * Returns the cursor to read on from.
   */
  const startWindow = async (generation: string): Promise<string> => {
    const origin = `${generation}.0`;
    let head: number | null = null;
    let floor = 0;
    try {
      const probe = await client.events(origin, 1);
      head = parseCursor(probe.head)?.pos ?? null;
      floor = parseCursor(probe.floor)?.pos ?? 0;
    } catch (error) {
      if (!(error instanceof ObserverError) || error.kind !== "cursor_expired") throw error;
      head = parseCursor(typeof error.detail.head === "string" ? error.detail.head : null)?.pos ?? null;
      floor = parseCursor(typeof error.detail.floor === "string" ? error.detail.floor : null)?.pos ?? 0;
    }
    seeTotal(head);
    if (head === null || (head <= liveWindow && floor === 0)) return origin;
    // The summaries first: the window's events read next reach at least as far as they describe, so
    // whatever changed after them is an event of the window, and is left to the events.
    let summaries: Awaited<ReturnType<ObserverClient["summaries"]>> | null = null;
    try {
      summaries = await client.summaries();
    } catch (error) {
      if (!(error instanceof ObserverError)) throw error;
    }
    const from = Math.max(floor, head - liveWindow);
    let cursor = `${generation}.${from}`;
    const events: EngineEvent[] = [];
    for (;;) {
      const page = await client.events(cursor, pageLimit);
      seeTotal(page.head);
      events.push(...parseAll(page.events));
      cursor = page.next ?? cursor;
      if (!page.more) break;
    }
    if (!events.length) return cursor;
    let t0 = Infinity;
    for (const e of events) if (e.schema_version === 3 && e.time.order_ms < t0) t0 = e.time.order_ms;
    markers += 1;
    const seeds: EngineEvent[] = [clientEvent("client.history_missing", markers, t0 - 1, { reason: "window", after: null, resumed_at: null } as AnyV3Event["data"])];
    const seed = summaries ? untouched(summaries.state, events) : null;
    if (seed) {
      markers += 1;
      seeds.push(clientEvent("client.snapshot_applied", markers, t0 - 1, { cursor: summaries?.cursor ?? "", generation, state: seed } as AnyV3Event["data"]));
    }
    apply([...seeds, ...events]);
    publish({ cursor });
    return cursor;
  };

  /** The history before what is held: its span and series, so scrubbing back loads windows and the timeline draws it all. */
  const startWindows = async (): Promise<void> => {
    try {
      if (options.windows && !options.windows.span()) await options.windows.init();
      const series = options.windows?.series() ?? null;
      if (series) store.setSeries(series);
      else await readSeries();
    } catch {
      // Advisory: without the span the store holds only what it received.
    }
  };

  const readSeries = async (): Promise<void> => {
    try {
      const s = await client.series();
      store.setSeries({ bucketMs: s.bucketMs, buckets: s.buckets, total: s.total, coarse: s.coarse });
    } catch {
      // `/series` is optional (observer M6.2).
    }
  };

  const checkStale = (): void => {
    if (status.state !== "live") return;
    if (clock.now() - lastMessageWall > staleAfterMs) publish({ state: "stale", staleSince: confirmed() || null, reason: "Nothing heard from the observer; what is shown may have changed." });
  };

  const readStatus = async (): Promise<void> => {
    try {
      const s = await client.factoryStatus();
      let merged = s;
      try {
        // `/health` adds the delivery hold and the per-stream runtime (observer M6.2); optional.
        const h = await client.health();
        // and the streams' runtimes summed and the observer's history completeness (observer M6.2).
        merged = { ...s, delivery: h.delivery ?? s.delivery, sources: s.sources.some((x) => x.runtime) || !h.sources.length ? s.sources : h.sources, runtime: h.runtime, history: h.history };
        seeTotal(h.head);
      } catch {
        // An older observer: no delivery figure.
      }
      store.setFactoryStatus(merged);
      publish({ deliveryLagMs: merged.delivery?.lastHoldMs ?? status.deliveryLagMs, supervisor: { heartbeatAgeSeconds: s.supervisor.heartbeatAgeSeconds, live: s.supervisor.heartbeatFresh, present: s.supervisor.leasePresent === true, readAt: s.readAt } });
    } catch {
      // Status is advisory; the stream's own state already says whether the observer answers.
    }
  };

  return {
    async start() {
      stopped = false;
      publish({ state: "connecting" });
      staleTimer = timers.setInterval(checkStale, 1000);
      statusTimer = timers.setInterval(() => void readStatus(), options.statusEveryMs ?? 10_000);
      seriesTimer = timers.setInterval(() => void (options.windows?.series() ? undefined : readSeries()), options.seriesEveryMs ?? 30_000);
      void readStatus();
      await connect();
    },
    stop() {
      stopped = true;
      flush();
      closeStream();
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      if (staleTimer !== null) timers.clearInterval(staleTimer);
      if (statusTimer !== null) timers.clearInterval(statusTimer);
      if (seriesTimer !== null) timers.clearInterval(seriesTimer);
      retryTimer = staleTimer = statusTimer = seriesTimer = null;
      publish({ state: "disconnected", attempts: 0, reason: "Closed.", staleSince: confirmed() || null });
    },
    status: () => ({ ...status, received: status.received }),
    flush,
  };
}

/**
 * The part of the observer's summaries no event of `events` touches (by ids and entity refs): their
 * state at the summaries' cursor is their state through the whole window, so it may stand at the
 * window's start. Everything an event of the window touches is left to the events. Null when nothing
 * is left.
 */
export function untouched(state: ObserverSnapshotState, events: readonly EngineEvent[]): ObserverSnapshotState | null {
  const touched = new Set<string>();
  for (const e of events) {
    if (e.schema_version !== 3) continue;
    const ids = e.ids;
    if (ids.wave_id) touched.add(`wave:${ids.wave_id}`);
    if (ids.slice_id) touched.add(`slice:${ids.slice_id}`);
    if (ids.ticket_id) touched.add(`cell:${ids.ticket_id}`);
    if (ids.execution_id) touched.add(`execution:${ids.execution_id}`);
    for (const r of e.entities) touched.add(r);
  }
  const waves = (state.waves ?? []).filter((w) => !touched.has(`wave:${w.wave_id}`));
  const slices = (state.slices ?? []).filter((x) => !touched.has(`slice:${x.slice_id}`) && !(x.ticket_id && touched.has(`cell:${x.ticket_id}`)));
  const cells = (state.cells ?? []).filter((c) => !touched.has(`cell:${c.ticket_id}`) && !(c.slice_id && touched.has(`slice:${c.slice_id}`)));
  const executions = (state.executions ?? []).filter((x) => !touched.has(`execution:${x.execution_id}`) && !(x.ticket_id && touched.has(`cell:${x.ticket_id}`)));
  if (!waves.length && !slices.length && !cells.length && !executions.length) return null;
  return { waves, slices, cells, executions, gates: [], history: state.history ?? null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The definitions a live scene has: none (titles come from records; what is missing is marked unknown). */
export const LIVE_DEFINITIONS: ProductDefinitions = { project: { id: "", name: "", integrationBranch: "" }, waves: {}, slices: {} };

/** A live log: checkpoints every 128 events, 256 scenes cached, the newest 50,000 events retained (about 60 MB of heap, measured). */
export function createLiveLog(options: { readonly retain?: number; readonly checkpointEvery?: number; readonly origin?: string | null; readonly lineage?: object } = {}): SceneLog {
  return createSceneLog({ definitions: LIVE_DEFINITIONS, provenance: provenance("live", options.origin ?? null), checkpointEvery: options.checkpointEvery ?? 128, cacheSize: 256, retain: options.retain ?? 50_000, lineage: options.lineage });
}

/** A store and a source wired together: the Live Factory. The caller starts the source. */
export function createLiveFactory(options: Omit<LiveSourceOptions, "log" | "store" | "windows"> & { readonly retain?: number; readonly windowEvents?: number }): { readonly store: SceneStore; readonly source: LiveSource; readonly log: SceneLog; readonly windows: WindowedHistory } {
  // One history: the live log and the windows read behind it share a lineage, so a ticket keeps its
  // Atlas bay when the playhead moves between them.
  const lineage = {};
  const log = createLiveLog({ retain: options.retain, lineage });
  // Scrubbing back past what the live log holds reads the history in windows (D17).
  const windows = createWindowedHistory({ client: options.client, definitions: LIVE_DEFINITIONS, source: "live", windowEvents: options.windowEvents, lineage });
  const store = createSceneStore({ source: "live", log, clock: options.clock, windows });
  const source = createLiveSource({ ...options, log, store, windows });
  return { store, source, log, windows };
}

/**
 * Historical replay of a long history (D17): nothing is loaded up front but the span and the series;
 * the store shows the window holding the playhead, starting at the history's first moment. Falls
 * back to loading the whole retained history (`loadHistory`) when the observer serves no `/history`.
 */
export async function createReplay(client: ObserverClient, options: { readonly clock: Clock; readonly reducedMotion?: boolean; readonly windowEvents?: number; readonly keep?: number }): Promise<{ readonly store: SceneStore; readonly windows: WindowedHistory | null }> {
  const session = await client.session();
  const windows = createWindowedHistory({ client, definitions: LIVE_DEFINITIONS, source: "replay", origin: session.project, windowEvents: options.windowEvents, keep: options.keep });
  try {
    await windows.init();
  } catch (error) {
    if (!(error instanceof ObserverError) || (error.kind !== "not_found" && error.kind !== "unavailable")) throw error;
    const log = await loadHistory(client);
    return { store: createSceneStore({ source: "replay", log, clock: options.clock, reducedMotion: options.reducedMotion, at: log.floorTime() ?? undefined }), windows: null };
  }
  const span = windows.span();
  if (!span) {
    const log = createSceneLog({ definitions: LIVE_DEFINITIONS, provenance: provenance("replay", session.project) });
    return { store: createSceneStore({ source: "replay", log, clock: options.clock, reducedMotion: options.reducedMotion }), windows: null };
  }
  // The store's own log is the last window (the replay's end); every other moment is a window on demand.
  const last = await windows.load(span.end);
  const store = createSceneStore({ source: "replay", log: last.log, clock: options.clock, reducedMotion: options.reducedMotion, windows, at: span.start });
  store.setSeries(windows.series());
  return { store, windows };
}

/**
 * Historical Replay: load an observer's history into a log (no stream), for a replay store. Nothing
 * here touches the Factory; it reads.
 *
 * It reads `/api/v1/history` in `order`, one window page after another (late events are where they
 * belong), optionally between `fromMs` and `toMs`. When the window starts after the history's
 * beginning, or the observer says part of it may have left its memory (`complete: false`), a
 * `client.history_missing` marker at the window's start makes the scene say `partial` from there.
 * An observer without `/history` (404, 503) is read with the paged `/events` instead. With `retain`,
 * a long history keeps only its newest events (the rest compacted into the floor).
 */
export async function loadHistory(
  client: ObserverClient,
  options: { readonly pageLimit?: number; readonly fromMs?: number | null; readonly toMs?: number | null; readonly retain?: number; readonly source?: SceneSource } = {},
): Promise<SceneLog> {
  const session = await client.session();
  const log = createSceneLog({ definitions: LIVE_DEFINITIONS, provenance: provenance(options.source ?? "replay", session.project), checkpointEvery: 128, cacheSize: 256, retain: options.retain });
  const limit = options.pageLimit ?? 1000;
  const parse = (raw: readonly unknown[]) => raw.map(parseV3).filter((e): e is NonNullable<typeof e> => e !== null);
  try {
    let fromOrder: string | null = null;
    let first = true;
    for (;;) {
      const page = await client.history({ fromOrder, fromMs: fromOrder ? null : (options.fromMs ?? null), toMs: options.toMs ?? null, limit });
      const events = parse(page.events);
      if (first && events.length && (!page.complete || (options.fromMs ?? null) !== null)) {
        // What came before the window is not loaded: say so where the window begins.
        const t = Math.min(...events.map((e) => e.time.order_ms));
        log.ingest([clientEvent("client.history_missing", 1, t, { reason: "window", after: null, resumed_at: null } as AnyV3Event["data"])]);
      }
      first = false;
      log.ingest(events);
      if (!page.more || !page.nextFromOrder) break;
      fromOrder = page.nextFromOrder;
    }
    return log;
  } catch (error) {
    if (!(error instanceof ObserverError) || (error.kind !== "not_found" && error.kind !== "unavailable")) throw error;
  }
  // The paged /events fallback: the whole retained history in delivery order (the log sorts it).
  let cursor = `${session.generation}.0`;
  for (;;) {
    const page = await client.events(cursor, limit);
    log.ingest(parse(page.events));
    cursor = page.next ?? cursor;
    if (!page.more) return log;
  }
}

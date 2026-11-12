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
 * - **gap** (the cursor fell below the observer's floor): history between is missing. A
 *   `client.history_missing` marker goes into the log (the scene says partial), then a snapshot if
 *   the observer serves one, then history from the snapshot's cursor or the floor.
 * - **reset** (the index was rebuilt: a new epoch): ids and order are deterministic (contract 6.4),
 *   so history is fetched again from the start of the new epoch; what is already held de-duplicates.
 * - Neither touches selection, hover, view, camera follow or a replay's playhead: they live in the
 *   store, and the store keeps them across `logChanged`.
 * - **Staleness.** No message (event or heartbeat) for `staleAfterMs` (default 2.5 heartbeats):
 *   `stale`, with `staleSince` the last confirmed moment. Any message: `live` again.
 * - **Supervisor freshness.** `/factory/status` is read every `statusEveryMs` for the lease's
 *   heartbeat age.
 *
 * Wall time only through the injected clock and timers.
 */
import { createSceneLog } from "../sim/log";
import type { SceneLog } from "../sim/log";
import type { ProductDefinitions } from "../sim/model";
import { provenance } from "../sim/provenance";
import type { AnyV3Event, EngineEvent } from "../sim/v3";
import { parseV3 } from "../sim/v3";
import type { Clock } from "../scene/clock";
import type { ConnectionStatus } from "../scene/connection";
import { INITIAL_CONNECTION } from "../scene/connection";
import type { SceneStore } from "../scene/store";
import { createSceneStore } from "../scene/store";
import type { ObserverClient, ObserverSnapshot } from "./observer";
import { ObserverError, parseCursor, timeOf } from "./observer";

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
}

export interface LiveSource {
  start(): Promise<void>;
  stop(): void;
  /** For tests and the inspector: what the source holds now. */
  status(): ConnectionStatus;
  /** Apply what is queued now, without waiting for a frame (tests). */
  flush(): void;
}

const pad = (n: number, width: number): string => String(Math.max(0, Math.floor(n))).padStart(width, "0");

/** A client marker event (`k:` id, rank 7, key `k`): placed at `t`, never sent anywhere. */
function clientEvent<K extends "client.history_missing" | "client.snapshot_applied">(type: K, n: number, t: number, data: AnyV3Event["data"]): EngineEvent {
  const iso = new Date(t).toISOString();
  return {
    schema_version: 3,
    schema_revision: 0,
    id: `k:${type.slice(7)}:${n}`,
    type,
    pos: 0,
    origin: { stream: "observer", key: "k", seq: n, part: 0, writer: "observer", script: null, source_version: "control-tower" },
    authority: "reconstructed",
    time: { occurred_at: iso, precision: "bounded", not_before: null, not_after: iso, observed_at: iso, order_ms: t },
    order: `${pad(t, 15)}~7~k~${pad(n, 12)}~0000`,
    ids: { project_id: null, wave_id: null, slice_id: null, revision: null, ticket_id: null, cell_instance: null, execution_id: null, runner_id: null, visit_id: null, station: null, round: null, attempt: null, seat: null, agent_id: null, parent_agent_id: null, tool_call_id: null },
    entities: [],
    parent: null,
    cause: null,
    artifacts: [],
    unknown: [],
    inferred: {},
    provenance: { basis: [], rule: `client-${type.slice(7)}`, files: [] },
    late: false,
    withheld: 0,
    data,
  } as unknown as EngineEvent;
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

  const publish = (patch: Partial<ConnectionStatus>): void => {
    status = { ...status, ...patch };
    store.setConnection(status);
  };

  const confirmed = (): number => Math.max(status.confirmedAt ?? 0, log.headTime() ?? 0);

  const apply = (events: readonly EngineEvent[]): void => {
    if (refused !== status.refused) publish({ refused });
    if (!events.length) return;
    const result = log.ingest(events);
    if (result.added) store.logChanged();
    const head = log.headTime();
    publish({ received: status.received + result.added, duplicates: status.duplicates + result.duplicates, late: status.late + result.late, confirmedAt: head === null ? status.confirmedAt : Math.max(status.confirmedAt ?? 0, head) });
  };

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
    if (status.state === "stale" || status.state === "connecting" || status.state === "reconnecting") publish({ state: "live", staleSince: null, attempts: 0, reason: null });
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
    publish({ state: "reconnecting", attempts, reason, staleSince: status.staleSince ?? confirmed() });
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
      if (m.lastEventId) status = { ...status, cursor: m.lastEventId };
      if (frame === null) frame = clock.request(() => flush());
    };
    es.addEventListener("heartbeat", (m) => {
      heard();
      const d = (safeJson(m.data) ?? {}) as Record<string, unknown>;
      const at = timeOf(d.at);
      const watermark = timeOf(d.watermark_ms ?? d.watermark) ?? (at === null ? null : at - settleMs);
      if (watermark !== null) store.setLiveEdge(watermark);
      publish({ watermark, sourceLagMs: at !== null && watermark !== null ? Math.max(0, at - watermark) : status.sourceLagMs, confirmedAt: Math.max(confirmed(), watermark ?? 0) });
    });
    es.addEventListener("gap", () => void recover("expired"));
    es.addEventListener("reset", () => void recover("reset"));
    es.onerror = () => {
      flush();
      closeStream();
      reconnectLater("The stream dropped; resuming from the last cursor.");
    };
  };

  /** History is missing (expired) or the index was rebuilt (reset): reload, keep everything the person set. */
  const recover = async (reason: "expired" | "reset"): Promise<void> => {
    if (recovering || stopped) return;
    recovering = true;
    flush();
    closeStream();
    const before = status.cursor;
    publish({ state: "connecting", reason: reason === "expired" ? "History was missed; reloading." : "The observer rebuilt its index; reloading.", gaps: status.gaps + (reason === "expired" ? 1 : 0), resets: status.resets + (reason === "reset" ? 1 : 0) });
    try {
      const session = await client.session();
      publish({ generation: session.generation });
      let after = `${session.generation}.0`;
      if (reason === "expired") {
        markers += 1;
        apply([clientEvent("client.history_missing", markers, confirmed(), { reason, after: before, resumed_at: null } as AnyV3Event["data"])]);
      }
      if (session.snapshot) {
        const snapshot: ObserverSnapshot = await client.snapshot();
        markers += 1;
        apply([clientEvent("client.snapshot_applied", markers, confirmed(), { cursor: snapshot.cursor, generation: snapshot.generation, state: snapshot.state } as AnyV3Event["data"])]);
        after = snapshot.cursor || after;
      }
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
      publish({ generation: session.generation, state: status.state === "reconnecting" ? "reconnecting" : "connecting" });
      const cursor = await backfill(status.cursor ?? `${session.generation}.0`);
      publish({ cursor });
      openLive();
    } catch (error) {
      if (error instanceof ObserverError && error.kind === "cursor_expired") return recover("expired");
      if (error instanceof ObserverError && error.kind === "cursor_reset") return recover("reset");
      if (error instanceof ObserverError && (error.kind === "unauthorized" || error.kind === "invalid")) {
        publish({ state: "disconnected", reason: error.message, staleSince: confirmed() || null });
        return;
      }
      reconnectLater(error instanceof Error ? error.message : "The observer could not be reached.");
    }
  };

  const checkStale = (): void => {
    if (status.state !== "live") return;
    if (clock.now() - lastMessageWall > staleAfterMs) publish({ state: "stale", staleSince: confirmed() || null, reason: "Nothing heard from the observer; what is shown may have changed." });
  };

  const readStatus = async (): Promise<void> => {
    try {
      const s = await client.factoryStatus();
      publish({ supervisor: { heartbeatAgeSeconds: s.heartbeatAgeSeconds, live: s.leaseLive, present: s.leasePresent, readAt: s.readAt } });
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
      retryTimer = staleTimer = statusTimer = null;
      publish({ state: "disconnected", reason: "Closed.", staleSince: confirmed() || null });
    },
    status: () => ({ ...status, received: status.received }),
    flush,
  };
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
export function createLiveLog(options: { readonly retain?: number; readonly checkpointEvery?: number; readonly origin?: string | null } = {}): SceneLog {
  return createSceneLog({ definitions: LIVE_DEFINITIONS, provenance: provenance("live", options.origin ?? null), checkpointEvery: options.checkpointEvery ?? 128, cacheSize: 256, retain: options.retain ?? 50_000 });
}

/** A store and a source wired together: the Live Factory. The caller starts the source. */
export function createLiveFactory(options: Omit<LiveSourceOptions, "log" | "store"> & { readonly retain?: number }): { readonly store: SceneStore; readonly source: LiveSource; readonly log: SceneLog } {
  const log = createLiveLog({ retain: options.retain });
  const store = createSceneStore({ source: "live", log, clock: options.clock });
  const source = createLiveSource({ ...options, log, store });
  return { store, source, log };
}

/**
 * Historical Replay: load an observer's whole retained history into a log (no stream), for a
 * replay store. Nothing here touches the Factory; it reads.
 */
export async function loadHistory(client: ObserverClient, options: { readonly pageLimit?: number } = {}): Promise<SceneLog> {
  const session = await client.session();
  const log = createSceneLog({ definitions: LIVE_DEFINITIONS, provenance: provenance("replay", session.project), checkpointEvery: 128, cacheSize: 256 });
  let cursor = `${session.generation}.0`;
  for (;;) {
    const page = await client.events(cursor, options.pageLimit ?? 1000);
    log.ingest(page.events.map(parseV3).filter((e): e is NonNullable<typeof e> => e !== null));
    cursor = page.next ?? cursor;
    if (!page.more) return log;
  }
}

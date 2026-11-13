/**
 * The live connection's state, as the store holds it and every view may read it. Simulation and
 * replay have no connection (`null`). The live source (src/live/source.ts) is the only writer.
 *
 * - `connecting`: no stream yet (first load, or after a reset while history reloads);
 * - `live`: the stream is open and a message (event or heartbeat) arrived within the stale bound;
 * - `reconnecting`: the stream dropped; resuming from the durable cursor (the first few attempts);
 * - `stale`: open as far as the browser knows, but silent beyond the stale bound;
 * - `disconnected`: the observer has not answered for `DISCONNECTED_AFTER` attempts in a row; the
 *   source keeps retrying with back-off and resumes from the cursor when it answers (the same
 *   origin, the same session: the observer keeps both across a restart); or the person closed it;
 * - `no-session`: the observer answered 401: it does not know this browser (the session expired or
 *   was dropped). No retry; the person needs a new link.
 *
 * Times are factory time (`t`, Unix ms for live) where a view prints them ("stale since 14:02:10"),
 * so they come from the stream, not the browser's clock.
 */
import type { ObserverHistory } from "../sim/provenance";
export type ConnectionState = "connecting" | "live" | "reconnecting" | "stale" | "disconnected" | "no-session";

/** Failed reconnection attempts in a row after which the state is `disconnected` (still retrying). */
export const DISCONNECTED_AFTER = 4;

export interface SupervisorFreshness {
  /** Seconds since the Factory Supervisor's lease heartbeat, as the observer read it. */
  readonly heartbeatAgeSeconds: number | null;
  /** The lease's own verdict (heartbeat recent and process alive). Null when no lease exists. */
  readonly live: boolean | null;
  /** Whether a lease exists at all (no supervisor enabled: false). */
  readonly present: boolean;
  /** When the observer read it, factory time. */
  readonly readAt: number | null;
}

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Factory time of the last thing the stream confirmed (an event's order_ms or a heartbeat's time). */
  readonly confirmedAt: number | null;
  /** When the state became stale or disconnected: the last confirmed moment. Null otherwise. */
  readonly staleSince: number | null;
  /** Consecutive reconnection attempts. */
  readonly attempts: number;
  /** The durable cursor (`<epoch>.<pos>`) the client resumes from. */
  readonly cursor: string | null;
  readonly generation: string | null;
  /** Observer-reported lag: its heartbeat time minus its watermark (how far settled history trails now). */
  readonly sourceLagMs: number | null;
  /** The observer's watermark: history is complete up to here, late arrivals apart (contract 6.6). */
  readonly watermark: number | null;
  readonly supervisor: SupervisorFreshness | null;
  /** Why it is in this state, in words ("cursor expired; reloaded from a snapshot"). */
  readonly reason: string | null;
  /**
   * The observer's delivery lag: how long it held the newest event between reading and sending it
   * (heartbeat `at_ms` minus `watermark_ms`, else `/health` `ingest.delivery.last_hold_ms`). Null: not reported.
   */
  readonly deliveryLagMs: number | null;
  /** Counters for the inspector and tests. Events received over the wire (unique). */
  readonly received: number;
  readonly duplicates: number;
  /** Events the observer itself marked late (its `late` flag). */
  readonly late: number;
  /** Events placed before ones this browser already held (a delivery fact, not lateness). */
  readonly reordered: number;
  /** Events held in the browser now (the live window), and the observer's own total (its head position). "held of total" when only part is held. */
  readonly held: number | null;
  readonly total: number | null;
  readonly gaps: number;
  readonly resets: number;
  /** Received lines that were not version 3 events (refused, never applied). */
  readonly refused: number;
}

export const INITIAL_CONNECTION: ConnectionStatus = {
  state: "connecting",
  confirmedAt: null,
  staleSince: null,
  attempts: 0,
  cursor: null,
  generation: null,
  sourceLagMs: null,
  watermark: null,
  supervisor: null,
  reason: null,
  deliveryLagMs: null,
  received: 0,
  duplicates: 0,
  late: 0,
  reordered: 0,
  held: null,
  total: null,
  gaps: 0,
  resets: 0,
  refused: 0,
};

/**
 * The Factory's state on this machine, as the observer reads it from the Factory's own files
 * (`GET /api/v1/factory/status`, apps/observer/README.md). Read tolerantly: anything not reported is
 * null. The Control Tower only reads it; nothing here can enable, pause or schedule anything.
 */
/** A Claude Code runtime's state as the observer judges its stream records (observer M6.2). */
export type RuntimeState = "proven" | "compatible-unproven" | "incompatible" | "unknown";

/** One execution stream's runtime (`freshness.sources[].runtime`). */
export interface SourceRuntimeStatus {
  readonly state: RuntimeState | null;
  readonly version: string | null;
  readonly reason: string | null;
  /** Stream records accepted and refused for their shape (refused ones are counted, nothing of them shown). Null: not reported. */
  readonly recordsAccepted?: number | null;
  readonly recordsRefused?: number | null;
}

/** Every stream's runtime, summed (`ingest.runtime` / `session.capabilities.stream_observations`). */
export interface RuntimeSummary {
  /** The worst state over every stream read (`unknown` before any). */
  readonly state: RuntimeState;
  /** The Claude Code versions the observer's fixtures prove. */
  readonly provenVersions: readonly string[];
  readonly versions: readonly { readonly version: string | null; readonly state: RuntimeState | null; readonly executions: number | null; readonly recordsRefused: number | null }[];
}

export interface FactoryStatus {
  /** The project has Factory state (a `.factory/` folder). */
  readonly factoryPresent: boolean | null;
  /** The machine-local policy, summarised: enabled, paused, the effective mode, autonomy. */
  readonly enabled: boolean | null;
  readonly paused: boolean | null;
  readonly mode: string | null;
  readonly autonomy: string | null;
  /** The Factory's state as its own records left it (`recorded_mode.state`: e.g. `disabled` after factory.disabled). Absent: not read. */
  readonly recordedState?: string | null;
  readonly supervisor: {
    readonly leasePresent: boolean | null;
    readonly heartbeatFresh: boolean | null;
    readonly heartbeatAgeSeconds: number | null;
    readonly leaseExpired: boolean | null;
  };
  /** Per source the observer follows: its state and how far its reading lags the file (bytes) and the clock (ms). */
  readonly sources: readonly {
    readonly key: string;
    readonly state: string | null;
    readonly lagBytes: number | null;
    readonly lastReadAgeMs: number | null;
    /** Execution streams (`stream/<execution>`): the runtime version's state (observer M6.2, `runtime {name, version, state, reason, records_accepted, records_refused}`). Null: not reported. */
    readonly runtime: SourceRuntimeStatus | null;
  }[];
  /**
   * The streams' runtimes summed (`/health` `ingest.runtime`, observer M6.2): the worst state over
   * every stream and each version seen. Null: not reported (an older observer, or `/health` not read).
   */
  readonly runtime: RuntimeSummary | null;
  /** How complete the observer's history is (`/health` `projection.history`, observer M6.2). Null: not reported. */
  readonly history: ObserverHistory | null;
  /** The observer's ingest: stale, its watermark (Unix ms), catching up. */
  readonly ingest: { readonly stale: boolean | null; readonly watermark: number | null; readonly catchingUp: boolean | null };
  /** The observer's read-to-send hold, last and 95th percentile (`ingest.delivery`, observer M6.2). Null: not reported. */
  readonly delivery: { readonly lastHoldMs: number | null; readonly p95HoldMs: number | null } | null;
  /** When the observer read the files (Unix ms). */
  readonly readAt: number | null;
}

/** Whether what the scene shows as executing may have changed unseen. */
export function isStale(status: ConnectionStatus | null): boolean {
  return status !== null && status.state !== "live" && status.state !== "connecting";
}

/**
 * When the history shown is no longer live, its last recorded time; else null. No longer live: a
 * replay, or a Factory whose own records leave it disabled (factory.disabled last) with no supervisor
 * lease held. Then work still open at the end is "no end recorded", never running (presentation only:
 * nothing is closed). A live, enabled Factory, or one whose status is not read yet, is live.
 */
export function historyEndedAt(s: { readonly source: string; readonly factoryStatus: FactoryStatus | null; readonly extent: { readonly events: number }; readonly log?: { headTime?(): number | null } | null }): number | null {
  const f = s.factoryStatus;
  const closed = s.source === "replay" || (s.source === "live" && f?.recordedState === "disabled" && f.supervisor.leasePresent === false);
  if (!closed || s.extent.events === 0) return null;
  return s.log?.headTime?.() ?? null;
}

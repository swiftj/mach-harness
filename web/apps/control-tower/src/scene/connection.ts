/**
 * The live connection's state, as the store holds it and every view may read it. Simulation and
 * replay have no connection (`null`). The live source (src/live/source.ts) is the only writer.
 *
 * - `connecting`: no stream yet (first load, or after a reset while history reloads);
 * - `live`: the stream is open and a message (event or heartbeat) arrived within the stale bound;
 * - `reconnecting`: the stream dropped; resuming from the durable cursor;
 * - `stale`: open as far as the browser knows, but silent beyond the stale bound;
 * - `disconnected`: given up (the observer refused, or the person closed it).
 *
 * Times are factory time (`t`, Unix ms for live) where a view prints them ("stale since 14:02:10"),
 * so they come from the stream, not the browser's clock.
 */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "stale" | "disconnected";

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
  /** Counters for the inspector and tests. */
  readonly received: number;
  readonly duplicates: number;
  readonly late: number;
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
  received: 0,
  duplicates: 0,
  late: 0,
  gaps: 0,
  resets: 0,
  refused: 0,
};

/** Whether what the scene shows as executing may have changed unseen. */
export function isStale(status: ConnectionStatus | null): boolean {
  return status !== null && status.state !== "live" && status.state !== "connecting";
}

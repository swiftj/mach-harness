/**
 * The observer's read-only HTTP API (`/api/v1`, docs/mach-next/M6_1_OBSERVER_DESIGN.md section 12,
 * contract section 14), as the Control Tower reads it. `fetch` is injected so tests run against an
 * in-memory fake; the browser passes its own (same origin, cookie credentials).
 *
 * Every response is M5's envelope: `{ok: true, data}` or `{ok: false, error: {kind, message, ...}}`.
 * The client names the schema it reads (`X-MACH-Event-Schema: 3`). Everything is read tolerantly:
 * unknown fields are ignored, missing optional ones are null.
 */

import type { FactoryStatus } from "../scene/connection";
import type { ObserverSnapshotState } from "../sim/v3";

export type { FactoryStatus };

export interface FetchResponseLike {
  readonly status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { readonly headers?: Readonly<Record<string, string>>; readonly credentials?: "same-origin" }) => Promise<FetchResponseLike>;

export type ObserverErrorKind = "invalid" | "unauthorized" | "not_found" | "cursor_reset" | "cursor_expired" | "unavailable" | "internal" | "network" | "protocol";

export class ObserverError extends Error {
  readonly kind: ObserverErrorKind;
  readonly status: number;
  /** The error object's other fields (`generation`, `floor`, `head`, `reason`, `cursor`). */
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(kind: ObserverErrorKind, message: string, status: number, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ObserverError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

export interface ObserverSession {
  readonly generation: string;
  readonly eventSchema: number | null;
  readonly eventRevision: number | null;
  readonly kinds: readonly string[];
  readonly snapshot: boolean;
  readonly streamObservations: { readonly ok: boolean; readonly reason: string | null } | null;
  readonly people: "role";
  readonly project: string | null;
}

export interface EventsPage {
  readonly generation: string;
  readonly events: readonly unknown[];
  readonly next: string | null;
  readonly head: string | null;
  readonly floor: string | null;
  readonly more: boolean;
  /** The observer's watermark (contract 6.6), Unix ms, when the response carries it. */
  readonly watermark: number | null;
}

export interface ObserverSnapshot {
  /** The cursor the state is at: stream from it (`after=`) for no gap and no repeat. */
  readonly cursor: string;
  readonly generation: string;
  /** Rebuilt from the observer's nearest checkpoint (a cursor earlier than its projection). */
  readonly reconstructed: boolean;
  /** The projected state, normalised to the shape the reducer reads (every part optional). */
  readonly state: ObserverSnapshotState;
}

/** A window of history in `order` (`GET /api/v1/history`), for replay. */
export interface HistoryPage {
  readonly generation: string;
  readonly events: readonly unknown[];
  /** Page on with `from_order` = this while `more`. */
  readonly nextFromOrder: string | null;
  readonly more: boolean;
  /** False when part of the window may have left the observer's memory. */
  readonly complete: boolean;
  readonly watermark: number | null;
}

/** Counts of events per time bucket (`GET /api/v1/series`), for drawing a long history without loading it. */
export interface SeriesData {
  readonly fromMs: number;
  readonly toMs: number;
  readonly bucketMs: number;
  /** Sparse: buckets with no event are absent. `atLeast`: the count is a lower bound (coarse sampling). */
  readonly buckets: readonly { readonly fromMs: number; readonly count: number; readonly atLeast?: boolean }[];
  /** Events in the range, as the observer counts them (null for coarse sampling). */
  readonly total: number | null;
  /** True when sampled through `/history` because `/series` is not served. */
  readonly coarse: boolean;
}

/** The parts of `GET /api/v1/health` the Control Tower reads (observer M6.2; absent parts are null). */
export interface ObserverHealth {
  readonly delivery: { readonly lastHoldMs: number | null; readonly p95HoldMs: number | null } | null;
  readonly head: string | null;
  readonly sources: FactoryStatus["sources"];
}

export interface ObserverClient {
  session(): Promise<ObserverSession>;
  /** Events after a cursor, in delivery order. */
  events(after: string, limit?: number): Promise<EventsPage>;
  /** History in `order` within a window (`from_order` inclusive start, `to_order` end), for replay. */
  history(window?: { readonly fromOrder?: string | null; readonly toOrder?: string | null; readonly fromMs?: number | null; readonly toMs?: number | null; readonly limit?: number }): Promise<HistoryPage>;
  /** The projected state at a cursor (default: the observer's own position) and that cursor. */
  snapshot(at?: string): Promise<ObserverSnapshot>;
  factoryStatus(): Promise<FactoryStatus>;
  /** Counts per time bucket; throws not_found on an observer without the route. */
  series(window?: { readonly fromMs?: number | null; readonly toMs?: number | null; readonly bucketMs?: number | null }): Promise<SeriesData>;
  health(): Promise<ObserverHealth>;
}

export const EVENT_SCHEMA = 3;

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? (value.filter((x) => typeof x === "string") as string[]) : []);

/**
 * `/api/v1/factory/status` in the observer's documented shape (apps/observer/README.md): the policy
 * `summary {enabled, paused, mode, autonomy}`, `factory_present`, `supervisor {lease_present,
 * heartbeat_fresh, heartbeat_age_seconds, lease_expired}`, `read_at`, and `freshness` (per-source
 * state and lag, the ingest's watermark). Missing parts are null.
 */
export function readFactoryStatus(data: unknown): FactoryStatus {
  const d = obj(data);
  const summary = obj(d.summary);
  const supervisor = obj(d.supervisor);
  const freshness = obj(d.freshness);
  const ingest = obj(freshness.ingest);
  return {
    factoryPresent: bool(d.factory_present),
    enabled: bool(summary.enabled),
    paused: bool(summary.paused),
    mode: str(summary.mode),
    autonomy: str(summary.autonomy),
    supervisor: {
      leasePresent: bool(supervisor.lease_present),
      heartbeatFresh: bool(supervisor.heartbeat_fresh),
      heartbeatAgeSeconds: num(supervisor.heartbeat_age_seconds),
      leaseExpired: bool(supervisor.lease_expired),
    },
    sources: list(freshness.sources).map((x) => {
      const src = obj(x);
      return { key: str(src.key) ?? "", state: str(src.state), lagBytes: num(src.lag_bytes), lastReadAgeMs: num(src.last_read_age_ms), runtime: readRuntime(src.runtime) };
    }),
    ingest: { stale: bool(ingest.stale), watermark: timeOf(ingest.watermark_ms), catchingUp: bool(ingest.catching_up) },
    delivery: ingest.delivery && typeof ingest.delivery === "object" ? { lastHoldMs: num(obj(ingest.delivery).last_hold_ms), p95HoldMs: num(obj(ingest.delivery).hold_ms_p95) } : null,
    readAt: timeOf(d.read_at),
  };
}

const RUNTIME_STATES = ["proven", "compatible-unproven", "incompatible", "unknown"] as const;
/** A stream source's runtime (`runtime: {name, version, state, reason, ...}`, observer M6.2), or null when absent. */
function readRuntime(value: unknown): FactoryStatus["sources"][number]["runtime"] {
  if (!value || typeof value !== "object") return null;
  const r = obj(value);
  const state = typeof r.state === "string" && (RUNTIME_STATES as readonly string[]).includes(r.state) ? (r.state as (typeof RUNTIME_STATES)[number]) : null;
  return { state, version: str(r.version), reason: str(r.reason) };
}

/** A gate state word from a human gate of the snapshot. */
const humanGateState = (g: Record<string, unknown>): string => (g.closed ? (g.closed_by === "rejected" ? "failed" : "passed") : "waiting");

/**
 * `/api/v1/snapshot`'s `state` (the observer's projection: `waves`, `slices`, `cells`, `executions`
 * as maps by id, `gates` as the human gates) in the shape the reducer reads. Arrays are taken too.
 */
export function readSnapshotState(data: unknown): ObserverSnapshotState {
  const d = obj(data);
  const waves = list(d.waves).map((x) => obj(x)).filter((w) => typeof w.wave_id === "string");
  const slices = list(d.slices).map((x) => obj(x)).filter((x) => typeof x.slice_id === "string");
  const cells = list(d.cells).map((x) => obj(x)).filter((c) => typeof c.ticket_id === "string");
  const executions = list(d.executions)
    .map((x) => {
      const o = obj(x);
      return Object.keys(obj(o.run)).length ? obj(o.run) : o;
    })
    .filter((x) => typeof x.execution_id === "string");
  const gates = list(d.gates).map((x) => obj(x));
  return {
    waves: waves.map((w) => ({ wave_id: w.wave_id as string, slices: strings(w.slices), revision: num(w.revision) })),
    slices: slices.map((x) => ({ slice_id: x.slice_id as string, ticket_id: str(x.ticket_id), state: str(x.state), dependencies: strings(x.dependencies ?? x.depends_on), revision: num(x.revision) })),
    cells: cells.map((c) => ({ ticket_id: c.ticket_id as string, slice_id: str(c.slice_id), stage: str(c.stage), risk: str(c.risk), current_visit: str(c.current_visit), rounds: num(c.round ?? c.rounds) })),
    executions: executions.map((x) => ({ execution_id: x.execution_id as string, ticket_id: str(x.ticket_id), state: str(x.state), attempt: num(x.attempt) })),
    gates: gates
      .filter((g) => typeof g.ticket_id === "string" && (g.gate === undefined ? g.kind === "approval" : true))
      .map((g) => ({ ticket_id: g.ticket_id as string, gate: typeof g.gate === "string" ? g.gate : "human-approval", round: num(g.round), state: typeof g.state === "string" ? g.state : humanGateState(g) })),
  };
}

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A time the observer sent: Unix ms, or an RFC 3339 string. */
export function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const KINDS: Readonly<Record<string, ObserverErrorKind>> = {
  invalid: "invalid",
  unauthorized: "unauthorized",
  not_found: "not_found",
  cursor_reset: "cursor_reset",
  cursor_expired: "cursor_expired",
  unavailable: "unavailable",
  internal: "internal",
};

export function createObserverClient(options: { readonly fetch: FetchLike; readonly base?: string }): ObserverClient {
  const base = options.base ?? "/api/v1";
  const get = async (path: string): Promise<Record<string, unknown>> => {
    let response: FetchResponseLike;
    try {
      response = await options.fetch(`${base}${path}`, { headers: { "X-MACH-Event-Schema": String(EVENT_SCHEMA), Accept: "application/json" }, credentials: "same-origin" });
    } catch (error) {
      throw new ObserverError("network", error instanceof Error ? error.message : "The observer could not be reached.", 0);
    }
    let body: Record<string, unknown>;
    try {
      body = obj(await response.json());
    } catch {
      throw new ObserverError("protocol", "The observer's response was not JSON.", response.status);
    }
    if (body.ok === true) return obj(body.data);
    const error = obj(body.error);
    throw new ObserverError(KINDS[str(error.kind) ?? ""] ?? "protocol", str(error.message) ?? `The observer answered ${response.status}.`, response.status, error);
  };

  return {
    async session() {
      const d = await get("/session");
      const versions = obj(d.versions);
      const event = obj(versions.event);
      const capabilities = obj(d.capabilities);
      const observations = capabilities.stream_observations === undefined ? null : obj(capabilities.stream_observations);
      return {
        generation: str(d.generation) ?? "",
        eventSchema: num(event.schema),
        eventRevision: num(event.revision),
        kinds: Array.isArray(event.kinds) ? (event.kinds.filter((k) => typeof k === "string") as string[]) : [],
        snapshot: capabilities.snapshot === true,
        streamObservations: observations ? { ok: observations.ok === true, reason: str(observations.reason) } : null,
        people: "role",
        project: str(obj(d.project).folder),
      };
    },
    async events(after, limit = 1000) {
      const d = await get(`/events?after=${encodeURIComponent(after)}&limit=${limit}`);
      return {
        generation: str(d.generation) ?? "",
        events: Array.isArray(d.events) ? d.events : [],
        next: str(d.next),
        head: str(d.head),
        floor: str(d.floor),
        more: d.more === true,
        watermark: timeOf(d.watermark_ms ?? d.watermark),
      };
    },
    async history(window = {}) {
      const q = new URLSearchParams();
      if (window.fromOrder) q.set("from_order", window.fromOrder);
      else if (typeof window.fromMs === "number") q.set("from_ms", String(Math.max(0, Math.floor(window.fromMs))));
      if (window.toOrder) q.set("to_order", window.toOrder);
      else if (typeof window.toMs === "number") q.set("to_ms", String(Math.max(0, Math.floor(window.toMs))));
      q.set("limit", String(window.limit ?? 1000));
      const d = await get(`/history?${q.toString()}`);
      return {
        generation: str(d.generation) ?? "",
        events: Array.isArray(d.events) ? d.events : [],
        nextFromOrder: str(d.next_from_order),
        more: d.more === true,
        complete: d.complete !== false,
        watermark: timeOf(d.watermark_ms),
      };
    },
    async snapshot(at) {
      const d = await get(at ? `/snapshot?at=${encodeURIComponent(at)}` : "/snapshot");
      return { cursor: str(d.cursor) ?? "", generation: str(d.generation) ?? "", reconstructed: d.reconstructed === true, state: readSnapshotState(d.state) };
    },
    async factoryStatus() {
      return readFactoryStatus(await get("/factory/status"));
    },
    async series(window = {}) {
      const q = new URLSearchParams();
      if (typeof window.fromMs === "number") q.set("from_ms", String(Math.max(0, Math.floor(window.fromMs))));
      if (typeof window.toMs === "number") q.set("to_ms", String(Math.max(0, Math.floor(window.toMs))));
      if (typeof window.bucketMs === "number") q.set("bucket_ms", String(Math.max(1000, Math.round(window.bucketMs / 1000) * 1000))); // whole seconds (observer M6.2)
      const d = await get(`/series${q.size ? `?${q.toString()}` : ""}`);
      const buckets = list(d.buckets)
        .map((x) => obj(x))
        .map((b) => ({ fromMs: num(b.from_ms) ?? 0, count: num(b.count) ?? 0 }))
        .filter((b) => b.count > 0);
      return { fromMs: num(d.from_ms) ?? buckets[0]?.fromMs ?? 0, toMs: num(d.to_ms) ?? 0, bucketMs: num(d.bucket_ms) ?? 60_000, buckets, total: num(d.total), coarse: false };
    },
    async health() {
      const d = await get("/health");
      const freshness = obj(d.freshness);
      const ingest = obj(d.ingest);
      const delivery = ingest.delivery && typeof ingest.delivery === "object" ? obj(ingest.delivery) : null;
      const status = readFactoryStatus({ freshness });
      return { delivery: delivery ? { lastHoldMs: num(delivery.last_hold_ms), p95HoldMs: num(delivery.hold_ms_p95) } : null, head: str(obj(d.index).head) ?? str(freshness.head), sources: status.sources };
    },
  };
}

/** `<epoch>.<pos>` parts; null when the cursor is not one. */
export function parseCursor(cursor: string | null): { readonly generation: string; readonly pos: number } | null {
  if (!cursor) return null;
  const dot = cursor.lastIndexOf(".");
  if (dot <= 0) return null;
  const pos = Number(cursor.slice(dot + 1));
  return Number.isInteger(pos) && pos >= 0 ? { generation: cursor.slice(0, dot), pos } : null;
}

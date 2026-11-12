/**
 * The observer's read-only HTTP API (`/api/v1`, docs/mach-next/M6_1_OBSERVER_DESIGN.md section 12,
 * contract section 14), as the Control Tower reads it. `fetch` is injected so tests run against an
 * in-memory fake; the browser passes its own (same origin, cookie credentials).
 *
 * Every response is M5's envelope: `{ok: true, data}` or `{ok: false, error: {kind, message, ...}}`.
 * The client names the schema it reads (`X-MACH-Event-Schema: 3`). Everything is read tolerantly:
 * unknown fields are ignored, missing optional ones are null.
 */

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
  readonly cursor: string;
  readonly generation: string;
  readonly reconstructed: boolean;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface FactoryStatus {
  readonly leasePresent: boolean;
  readonly heartbeatAgeSeconds: number | null;
  readonly leaseLive: boolean | null;
  readonly readAt: number | null;
}

export interface ObserverClient {
  session(): Promise<ObserverSession>;
  /** Events after a cursor, in delivery order. */
  events(after: string, limit?: number): Promise<EventsPage>;
  snapshot(at?: string): Promise<ObserverSnapshot>;
  factoryStatus(): Promise<FactoryStatus>;
}

export const EVENT_SCHEMA = 3;

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
    async snapshot(at) {
      const d = await get(at ? `/snapshot?at=${encodeURIComponent(at)}` : "/snapshot");
      return { cursor: str(d.cursor) ?? "", generation: str(d.generation) ?? "", reconstructed: d.reconstructed === true, state: obj(d.state) };
    },
    async factoryStatus() {
      const d = await get("/factory/status");
      const lease = obj(d.lease);
      return {
        leasePresent: lease.present === true,
        heartbeatAgeSeconds: num(lease.heartbeat_age_seconds),
        leaseLive: typeof lease.live === "boolean" ? lease.live : null,
        readAt: timeOf(d.read_at),
      };
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

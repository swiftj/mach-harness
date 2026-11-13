/**
 * The observer's read-only HTTP API (`/api/v1`, docs/mach-next/M6_1_OBSERVER_DESIGN.md section 12,
 * contract section 14), as the Control Tower reads it. `fetch` is injected so tests run against an
 * in-memory fake; the browser passes its own (same origin, cookie credentials).
 *
 * Every response is M5's envelope: `{ok: true, data}` or `{ok: false, error: {kind, message, ...}}`.
 * The client names the schema it reads (`X-MACH-Event-Schema: 3`). Everything is read tolerantly:
 * unknown fields are ignored, missing optional ones are null.
 */

import type { FactoryStatus, RuntimeState, RuntimeSummary } from "../scene/connection";
import type { ObserverHistory } from "../sim/provenance";
import type { ObserverSnapshotState } from "../sim/v3";

export type { FactoryStatus, RuntimeState, RuntimeSummary };

export interface FetchResponseLike {
  readonly status: number;
  json(): Promise<unknown>;
  /** The reply's headers (the browser's fetch has them; a test double may not). */
  readonly headers?: { get(name: string): string | null };
  text?(): Promise<string>;
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
  /**
   * `capabilities.stream_observations` (observer M6.2): `ok` is false only when stream records were
   * refused (null in the reply before any stream is read, said here as false); `state` is the worst
   * runtime state over every stream; `versions` each version seen.
   */
  readonly streamObservations: {
    readonly ok: boolean;
    readonly reason: string | null;
    readonly policy: string | null;
    readonly state: RuntimeState | null;
    readonly claudeCodeVersion: string | null;
    readonly provenVersions: readonly string[];
    readonly versions: RuntimeSummary["versions"];
  } | null;
  readonly people: "role";
  readonly project: string | null;
  /** The observer's clock when it answered (Unix ms), if the session says it (`now_ms`, or `now`); else null. */
  readonly nowMs: number | null;
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
  /** `ingest.runtime`: the streams' runtimes summed. */
  readonly runtime: RuntimeSummary | null;
  /** `projection.history`: how complete the observer's history is, by gap class. */
  readonly history: ObserverHistory | null;
}

/** The plan's facts on a cell (`/cells/{t}` `plan`, observer M6.2, D11); each null when not recorded. */
export interface ObserverPlanFacts {
  readonly appType: string | null;
  readonly risk: string | null;
  readonly contracts: number | null;
  readonly tasks: number | null;
  /** The event that recorded them (the plan's exit), null when a run record gave them. */
  readonly recordedBy: string | null;
}

/** The parts of `GET /api/v1/cells/{ticket}` the Control Tower reads. */
export interface ObserverCell {
  readonly ticketId: string;
  readonly sliceId: string | null;
  readonly stage: string | null;
  readonly risk: string | null;
  readonly appType: string | null;
  readonly round: number | null;
  readonly plan: ObserverPlanFacts | null;
  /** The projection's cursor the reply describes. */
  readonly cursor: string | null;
}

/**
 * The station visit an artifact belongs to (observer M6.2, D12): `recorded` when a verification check
 * names the file with its hash (`rule: check-hash`), `reconstructed` when the observer joined it by
 * its verification folder (`folder`), its round and file time (`round-and-time`) or its round only
 * (`round`). For M6.4 (Evidence Theater); nothing draws it yet.
 */
export interface ArtifactVisitLink {
  readonly visitId: string;
  readonly basis: "recorded" | "reconstructed";
  readonly rule: string | null;
}

/** One entry of the observer's evidence catalog (`GET /api/v1/artifacts`), metadata only. */
export interface ArtifactEntry {
  readonly id: string;
  readonly ref: string | null;
  readonly ticketId: string | null;
  readonly path: string | null;
  readonly kind: string | null;
  readonly nature: string | null;
  readonly mediaType: string | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly integrity: string | null;
  readonly verifiedEvidence: boolean;
  readonly round: number | null;
  /** `recorded` when the round came from results.json's review loop or the review folder's number. */
  readonly roundBasis: string | null;
  readonly commit: string | null;
  /** The visit it belongs to; null when no visit fits. */
  readonly visit: ArtifactVisitLink | null;
  readonly contentAccess: string | null;
  /**
   * The served text holds free prose the observer cannot check for names no record gives (`free_text`,
   * R1, the product owner's decision): it is served, and must be labelled wherever it is listed or
   * opened. False for media, records of identifiers only, and content that is not served.
   */
  readonly freeText: boolean;
  /** The observer's own words for it (`free_text_note`), e.g. "free text, not checked for names"; null when not free text. */
  readonly freeTextNote: string | null;
}

/** The label every listing or opening of a free-text evidence document carries (R1). */
export const FREE_TEXT_LABEL = "Free text, not checked for names";

/** The label for a catalog entry, or null when it holds no free text. */
export function freeTextLabel(entry: Pick<ArtifactEntry, "freeText"> | null | undefined): string | null {
  return entry?.freeText ? FREE_TEXT_LABEL : null;
}

/** What an artifact content reply's headers say (`X-MACH-Free-Text`, `X-MACH-Redacted`). */
export interface ContentLabels {
  readonly freeText: boolean;
  /** Replacements the observer made, when it says. */
  readonly redacted: number | null;
}
export function readContentLabels(headers: { get(name: string): string | null } | null | undefined): ContentLabels {
  const free = headers?.get("X-MACH-Free-Text") ?? null;
  const red = headers?.get("X-MACH-Redacted") ?? null;
  const n = red === null ? NaN : Number(red);
  return { freeText: free !== null && free.trim().toLowerCase() === "unchecked-for-names", redacted: Number.isFinite(n) ? n : null };
}

/**
 * The observer's current summaries (`/waves`, `/slices`, `/cells`, `/runs`), bounded by how many
 * waves, slices, cells and executions there are, never by how many events: the state a long history
 * starts from (D17) without the whole snapshot. `cursor` is the projection position they describe
 * (the highest of the replies).
 */
export interface ObserverSummaries {
  readonly cursor: string | null;
  readonly state: ObserverSnapshotState;
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
  /** One cell's detail (`/cells/{ticket}`): its plan facts and stage. */
  cell(ticket: string): Promise<ObserverCell>;
  /** The evidence catalog, metadata only (`/artifacts`), one page. */
  artifacts(query?: { readonly ticket?: string; readonly limit?: number; readonly offset?: number }): Promise<{ readonly items: readonly ArtifactEntry[]; readonly more: boolean }>;
  /** One served text (`/artifacts/{id}/content`) with what its headers say (free text, redactions). */
  artifactContent(id: string): Promise<{ readonly text: string; readonly labels: ContentLabels }>;
  /** The current waves, slices, cells and executions, paged through (see ObserverSummaries). */
  summaries(): Promise<ObserverSummaries>;
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
    // `/factory/status` carries neither; `/health` does (merged by the live source).
    runtime: null,
    history: null,
  };
}

const RUNTIME_STATES = ["proven", "compatible-unproven", "incompatible", "unknown"] as const;
const runtimeState = (value: unknown): RuntimeState | null => (typeof value === "string" && (RUNTIME_STATES as readonly string[]).includes(value) ? (value as RuntimeState) : null);

/** A stream source's runtime (`runtime: {name, version, state, reason, records_accepted, records_refused, ...}`, observer M6.2), or null when absent. */
function readRuntime(value: unknown): FactoryStatus["sources"][number]["runtime"] {
  if (!value || typeof value !== "object") return null;
  const r = obj(value);
  return { state: runtimeState(r.state), version: str(r.version), reason: str(r.reason), recordsAccepted: num(r.records_accepted), recordsRefused: num(r.records_refused) };
}

/**
 * The streams' runtimes summed: `/health` `ingest.runtime` or `/session`
 * `capabilities.stream_observations` (`{policy, state, proven_versions, versions[{version, state,
 * executions, records_refused}]}`, observer M6.2), or null when absent.
 */
export function readRuntimeSummary(value: unknown): RuntimeSummary | null {
  if (!value || typeof value !== "object") return null;
  const r = obj(value);
  const state = runtimeState(r.state);
  if (!state) return null;
  const versions = list(r.versions).map((x) => {
    const v = obj(x);
    return { version: str(v.version), state: runtimeState(v.state), executions: num(v.executions), recordsRefused: num(v.records_refused) };
  });
  return { state, provenVersions: strings(r.proven_versions), versions };
}

const counts = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(value))) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
};

/**
 * History completeness by gap class (observer M6.2: `/snapshot` `state.history`, `/project`
 * `history`, `/health` `projection.history`): `{completeness, lost, not_interpreted, classes, gaps,
 * partial, not_v3}`. Null when absent (an older observer). Partial only when something was lost.
 */
export function readObserverHistory(value: unknown): ObserverHistory | null {
  if (!value || typeof value !== "object") return null;
  const h = obj(value);
  const lost = counts(h.lost);
  const completeness = h.completeness === "partial" || h.completeness === "complete" ? h.completeness : Object.values(lost).some((n) => n > 0) ? "partial" : "complete";
  return { completeness, lost, notInterpreted: counts(h.not_interpreted), classes: counts(h.classes), partial: str(h.partial) || null };
}

const planOf = (value: unknown): ObserverPlanFacts | null => {
  if (!value || typeof value !== "object") return null;
  const p = obj(value);
  return { appType: str(p.app_type) || null, risk: str(p.risk) || null, contracts: num(p.contracts), tasks: num(p.tasks), recordedBy: str(p.recorded_by) || null };
};

/** One catalog entry (`/artifacts` items), with its visit link (observer M6.2). */
export function readArtifactEntry(value: unknown): ArtifactEntry {
  const a = obj(value);
  const v = a.visit && typeof a.visit === "object" ? obj(a.visit) : null;
  const visit: ArtifactVisitLink | null = v && typeof v.visit_id === "string" && (v.basis === "recorded" || v.basis === "reconstructed") ? { visitId: v.visit_id, basis: v.basis, rule: str(v.rule) } : null;
  return {
    id: str(a.id) ?? "",
    ref: str(a.ref),
    ticketId: str(a.ticket_id),
    path: str(a.path_rel),
    kind: str(a.kind),
    nature: str(a.nature),
    mediaType: str(a.media_type),
    bytes: num(a.bytes),
    sha256: str(a.sha256),
    integrity: str(a.integrity),
    verifiedEvidence: a.verified_evidence === true,
    round: num(a.round),
    roundBasis: str(a.round_basis) || null,
    commit: str(a.commit) || null,
    visit,
    contentAccess: str(a.content_access),
    freeText: a.free_text === true,
    freeTextNote: a.free_text === true ? (str(a.free_text_note) ?? "free text, not checked for names") : null,
  };
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
    cells: cells.map((c) => {
      const plan = planOf(c.plan);
      return {
        ticket_id: c.ticket_id as string,
        slice_id: str(c.slice_id),
        stage: str(c.stage),
        risk: str(c.risk) || null,
        current_visit: str(c.current_visit),
        rounds: num(c.round ?? c.rounds),
        app_type: str(c.app_type) || null,
        plan: plan ? { app_type: plan.appType, risk: plan.risk, contracts: plan.contracts, tasks: plan.tasks, recorded_by: plan.recordedBy } : null,
      };
    }),
    executions: executions.map((x) => ({ execution_id: x.execution_id as string, ticket_id: str(x.ticket_id), state: str(x.state), attempt: num(x.attempt) })),
    gates: gates
      .filter((g) => typeof g.ticket_id === "string" && (g.gate === undefined ? g.kind === "approval" : true))
      .map((g) => ({ ticket_id: g.ticket_id as string, gate: typeof g.gate === "string" ? g.gate : "human-approval", round: num(g.round), state: typeof g.state === "string" ? g.state : humanGateState(g) })),
    history: readObserverHistory(d.history),
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
        streamObservations: observations
          ? {
              ok: observations.ok === true,
              reason: str(observations.reason),
              policy: str(observations.policy),
              state: runtimeState(observations.state),
              claudeCodeVersion: str(observations.claude_code_version),
              provenVersions: strings(observations.proven_versions),
              versions: readRuntimeSummary({ state: "unknown", versions: observations.versions })?.versions ?? [],
            }
          : null,
        people: "role",
        project: str(obj(d.project).folder),
        nowMs: num(d.now_ms) ?? (typeof d.now === "string" && Number.isFinite(Date.parse(d.now)) ? Date.parse(d.now) : null),
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
      return {
        delivery: delivery ? { lastHoldMs: num(delivery.last_hold_ms), p95HoldMs: num(delivery.hold_ms_p95) } : null,
        head: str(obj(d.index).head) ?? str(freshness.head),
        sources: status.sources,
        runtime: readRuntimeSummary(ingest.runtime),
        history: readObserverHistory(obj(d.projection).history),
      };
    },
    async cell(ticket) {
      const d = await get(`/cells/${encodeURIComponent(ticket)}`);
      return { ticketId: str(d.ticket_id) ?? ticket, sliceId: str(d.slice_id) || null, stage: str(d.stage) || null, risk: str(d.risk) || null, appType: str(d.app_type) || null, round: num(d.round), plan: planOf(d.plan), cursor: str(d.cursor) };
    },
    async artifacts(query = {}) {
      const q = new URLSearchParams();
      if (query.ticket) q.set("ticket", query.ticket);
      q.set("limit", String(query.limit ?? 200));
      if (query.offset) q.set("offset", String(query.offset));
      const d = await get(`/artifacts?${q.toString()}`);
      return { items: list(d.items).map(readArtifactEntry), more: d.more === true };
    },
    async artifactContent(id) {
      let response: FetchResponseLike;
      try {
        response = await options.fetch(`${base}/artifacts/${encodeURIComponent(id)}/content`, { credentials: "same-origin" });
      } catch (error) {
        throw new ObserverError("network", error instanceof Error ? error.message : "The observer did not answer.", 0);
      }
      if (response.status !== 200) throw new ObserverError(response.status === 404 ? "not_found" : response.status === 401 ? "unauthorized" : "unavailable", `The artifact's content was not served (${response.status}).`, response.status);
      const text = response.text ? await response.text() : String(await response.json());
      return { text, labels: readContentLabels(response.headers) };
    },
    async summaries() {
      let cursor: string | null = null;
      const seeCursor = (c: unknown): void => {
        const pos = parseCursor(str(c))?.pos;
        if (pos !== undefined && (cursor === null || pos > (parseCursor(cursor)?.pos ?? -1))) cursor = str(c);
      };
      /** Every page of a list route (`items`, `more`, `offset`, `cursor`), at most `cap` items. */
      const all = async (route: string, cap = 50_000): Promise<unknown[]> => {
        const out: unknown[] = [];
        for (let offset = 0; out.length < cap; ) {
          const d = await get(`${route}?limit=1000&offset=${offset}`);
          seeCursor(d.cursor);
          const items = list(d.items);
          out.push(...items);
          if (d.more !== true || !items.length) break;
          offset += items.length;
        }
        return out;
      };
      const waves = await get("/waves");
      seeCursor(waves.cursor);
      const [slices, cells, runs] = [await all("/slices"), await all("/cells"), await all("/runs")];
      // How complete the observer's history is (`/project` `history`, observer M6.2); optional.
      let history: unknown = null;
      try {
        const project = await get("/project");
        seeCursor(project.cursor);
        history = project.history;
      } catch (error) {
        if (!(error instanceof ObserverError)) throw error;
      }
      const state = readSnapshotState({ waves: waves.items, slices, cells, executions: runs, history });
      return { cursor, state };
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

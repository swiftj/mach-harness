/**
 * The observer's read-only HTTP API (`/api/v1`, docs/mach-next/M6_1_OBSERVER_DESIGN.md section 12,
 * contract section 14), as the Factory Floor reads it. `fetch` is injected so tests run against an
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
export type FetchLike = (
  url: string,
  init?: { readonly headers?: Readonly<Record<string, string>>; readonly credentials?: "same-origin"; /** M6.3: lets a superseded request be cancelled (a fetch that ignores it is still safe: the answer is discarded). */ readonly signal?: AbortSignal },
) => Promise<FetchResponseLike>;

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
  /** `capabilities.evidence_media` (M6.4): screenshots and recordings are served; null when the session does not say. */
  readonly evidenceMedia?: boolean | null;
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

/** The parts of `GET /api/v1/health` the Factory Floor reads (observer M6.2; absent parts are null). */
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

/** The parts of `GET /api/v1/cells/{ticket}` the Factory Floor reads. */
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
  /** M7: k for a review folder round-N.k (a repeat of judging round N after a voided approval); null otherwise. */
  readonly repeat?: number | null;
  /** M7: a review decision the merge station voided: codes and commits only. Null when it stands. */
  readonly voided?: { readonly reason_code: string; readonly outcome_before?: string } | null;
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
  // ---- M6.4 (evidence player): read so the player can say where a file is read from, what it proves and why it is withheld.
  /** `cell` (the live worktree's cell folder) or `archive` (the finished ticket's archive); null when the reply does not say. */
  readonly origin?: "cell" | "archive" | null;
  /** `artifact:<ticket>:<path>` (no version); null when absent. */
  readonly logical?: string | null;
  /** The hash the verifier recorded for it, when a record names one. */
  readonly recordedSha256?: string | null;
  /** The checks it is evidence for (`targets[{id, kind, result}]`): identifiers and codes only. */
  readonly targets?: readonly ArtifactTarget[];
  /** The observer's catalog words for why its content is or is not served (`access_reason`, group A); null when absent. */
  readonly accessReason?: string | null;
}

/** A check an evidence file proves (`targets[]` of a catalog entry). */
export interface ArtifactTarget {
  readonly id: string;
  readonly kind: string | null;
  readonly result: string | null;
}

/** A recorded time as the projection serves it (`TimeView`: `at`, `precision`, bounds, the event that recorded it). */
export interface ObserverTimeView {
  readonly atMs: number | null;
  readonly notBeforeMs: number | null;
  readonly notAfterMs: number | null;
  readonly precision: string | null;
  readonly eventId: string | null;
}

/** One file a recorded check names (`/cells/{t}/evidence` `checks[].evidence[]`), linked to its catalog entry when there is one. */
export interface CellEvidenceFile {
  /** The path the check names, relative to the cell (`evidence/…`): group B, a file name may hold a name. */
  readonly file: string;
  /** The hash the check recorded. */
  readonly sha256: string | null;
  /** The catalog id, or null when the file is not catalogued (`integrity` is then `missing`). */
  readonly artifactId: string | null;
  /** `match`, `mismatch` (the file differs from what this check recorded), `missing` or `unchecked`. */
  readonly integrity: string;
  /** The catalog entry's `content_access`, when catalogued. */
  readonly contentAccess: string | null;
  /** M15: for a design mock's check, which file this is: the approved mock or the capture of the built screen. Null otherwise. */
  readonly role?: MockRole | null;
}

export type MockRole = "approved-mock" | "capture";

/**
 * M15: a design mock's side-by-side record, as the observer serves it from results.json (M14 part C).
 * The verifier's words are free text, not checked for names; nothing is compared here or in the page.
 */
export interface MockFacts {
  /** `matches`, `differs`, `cannot compare`; null when not compared yet or a word this page does not know. */
  readonly compared: "matches" | "differs" | "cannot compare" | null;
  /** Whether a difference fails the check; null when not recorded. */
  readonly binding: boolean | null;
  /** The scenario it was approved for (`AC-NN`), when recorded. */
  readonly forScenario: string | null;
  readonly note: string | null;
  readonly differences: readonly string[];
  readonly freeText: boolean;
}

/** One recorded verification check with its files. */
export interface CellEvidenceCheck {
  readonly targetId: string;
  /** `scenario`, `matrix rule`, `holdout`, or another kind the verifier wrote; null when not recorded. */
  readonly targetKind: string | null;
  readonly result: string | null;
  readonly round: number | null;
  readonly visitId: string | null;
  readonly at: ObserverTimeView | null;
  readonly evidence: readonly CellEvidenceFile[];
  /** M15: a design mock's record (target kind `design mock`); null for every other check. */
  readonly mock?: MockFacts | null;
}

/** `GET /api/v1/cells/{ticket}/evidence`: the cell's catalogued artifacts and its recorded checks. */
export interface CellEvidence {
  readonly ticketId: string;
  readonly artifacts: readonly ArtifactEntry[];
  readonly checks: readonly CellEvidenceCheck[];
  /** The project's tracked Factory Floor setting (`settings.evidence_media`); null when the reply does not say. */
  readonly evidenceMedia: boolean | null;
  /** Where the observer read the setting from (`settings.source`), a catalog string. */
  readonly settingsSource: string | null;
  readonly cursor: string | null;
  /** The observer's own note on what verified evidence is (a catalog string). */
  readonly note: string | null;
}

/** Why the content route refused, as its reason codes (`error.reason`), plus what the client itself saw. */
export type ArtifactRefusal =
  | "credential-name"
  | "media-disabled"
  | "link"
  | "too-large"
  | "changed"
  | "duplicate"
  | "type"
  | "unavailable"
  | "not-found"
  | "unauthorized"
  | "invalid"
  | "network"
  | "refused";

/** What a served text's headers say (`X-MACH-Free-Text`, `X-MACH-Redacted`, `X-MACH-Truncated`, `X-MACH-Evidence-Match`). */
export interface TextContentLabels extends ContentLabels {
  /** The observer cut the text short. */
  readonly truncated: boolean;
  /** `X-MACH-Evidence-Match`: the bytes served are the bytes the catalog hashed (`match`); null when the header is absent. */
  readonly evidenceMatch: string | null;
}

export type ArtifactTextResult =
  | { readonly ok: true; readonly text: string; readonly labels: TextContentLabels }
  | { readonly ok: false; readonly reason: ArtifactRefusal; readonly status: number; /** True when a 503 was retried once and refused again. */ readonly retried: boolean };

/** A catalog id as the observer issues them (`^a[0-9a-f]{24}$`): anything else is never put in a URL. */
export const ARTIFACT_ID = /^a[0-9a-f]{24}$/;

/**
 * The content route's URL for an image or video element: by catalog id only, never by path. Null for
 * anything that is not a catalog id, so a path or prose can never reach the address of a request.
 */
export function artifactContentUrl(id: string, base = "/api/v1"): string | null {
  return ARTIFACT_ID.test(id) ? `${base}/artifacts/${id}/content` : null;
}

const REFUSALS: ReadonlySet<string> = new Set(["credential-name", "media-disabled", "link", "too-large", "changed", "duplicate", "type"]);

/** A refusal reply's reason code: the envelope's `error.reason` when it is one the route uses, else one from the status. */
export function refusalOf(status: number, body: unknown): ArtifactRefusal {
  const reason = str(obj(obj(body).error).reason);
  if (reason && REFUSALS.has(reason)) return reason as ArtifactRefusal;
  if (status === 503) return "unavailable";
  if (status === 404) return "not-found";
  if (status === 401) return "unauthorized";
  if (status === 400) return "invalid";
  if (status === 413) return "too-large";
  if (status === 415) return "type";
  return "refused";
}

/** The headers of a served text. */
export function readTextContentLabels(headers: { get(name: string): string | null } | null | undefined): TextContentLabels {
  const base = readContentLabels(headers);
  const truncated = (headers?.get("X-MACH-Truncated") ?? "").trim().toLowerCase() === "true";
  const match = headers?.get("X-MACH-Evidence-Match") ?? null;
  return { ...base, truncated, evidenceMatch: match === null ? null : match.trim().toLowerCase() };
}

const timeView = (value: unknown): ObserverTimeView | null => {
  if (!value || typeof value !== "object") return null;
  const t = obj(value);
  return { atMs: timeOf(t.at), notBeforeMs: timeOf(t.not_before), notAfterMs: timeOf(t.not_after), precision: str(t.precision), eventId: str(t.event_id) || null };
};

/** `/cells/{ticket}/evidence`'s `data`, read tolerantly. */
export function readCellEvidence(data: unknown, ticket: string): CellEvidence {
  const d = obj(data);
  const settings = d.settings && typeof d.settings === "object" ? obj(d.settings) : null;
  return {
    ticketId: str(d.ticket_id) ?? ticket,
    artifacts: list(d.artifacts).map(readArtifactEntry).filter((a) => a.id !== ""),
    checks: list(d.checks)
      .map((x) => obj(x))
      .filter((k) => typeof k.target_id === "string" && k.target_id !== "")
      .map((k) => ({
        targetId: k.target_id as string,
        targetKind: str(k.target_kind) || null,
        result: str(k.result) || null,
        round: num(k.round),
        visitId: str(k.visit_id) || null,
        at: timeView(k.at),
        evidence: list(k.evidence).map((x) => {
          const f = obj(x);
          const role = f.role === "approved-mock" || f.role === "capture" ? f.role : null;
          return { file: str(f.file) ?? "", sha256: str(f.sha256) || null, artifactId: str(f.artifact_id) || null, integrity: str(f.integrity) ?? "missing", contentAccess: str(f.content_access) || null, ...(role ? { role } : {}) };
        }),
        mock: readMockFacts(k.mock),
      })),
    evidenceMedia: settings ? bool(settings.evidence_media) : null,
    settingsSource: settings ? str(settings.source) : null,
    cursor: str(d.cursor),
    note: str(d.note),
  };
}

/** A check's `mock` (M15), read tolerantly: an unknown result reads as not compared, never as a match. */
export function readMockFacts(value: unknown): MockFacts | null {
  if (!value || typeof value !== "object") return null;
  const m = obj(value);
  const compared = m.compared === "matches" || m.compared === "differs" || m.compared === "cannot compare" ? m.compared : null;
  return {
    compared,
    binding: typeof m.binding === "boolean" ? m.binding : null,
    forScenario: str(m.for) || null,
    note: str(m.note) || null,
    differences: strings(m.differences),
    freeText: m.free_text === true,
  };
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
 * The observer's current summaries (`/slices`, `/cells`, `/runs`), bounded by how many
 * slices, cells and executions there are, never by how many events: the state a long history
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
  factoryStatus(): Promise<FactoryStatus>;
  health(): Promise<ObserverHealth>;
  /** One cell's detail (`/cells/{ticket}`): its plan facts and stage. */
  cell(ticket: string): Promise<ObserverCell>;
  /** The evidence catalog, metadata only (`/artifacts`), one page. */
  artifacts(query?: { readonly ticket?: string; readonly limit?: number; readonly offset?: number }): Promise<{ readonly items: readonly ArtifactEntry[]; readonly more: boolean }>;
  /** One served text (`/artifacts/{id}/content`) with what its headers say (free text, redactions). */
  artifactContent(id: string): Promise<{ readonly text: string; readonly labels: ContentLabels }>;
  /** The current slices, cells and executions, paged through (see ObserverSummaries). */
  summaries(): Promise<ObserverSummaries>;
  // ---- M6.4 (evidence player). Optional like the M6.3 methods; createObserverClient has them all.
  /** `/cells/{ticket}/evidence`: the cell's checks, each with its files linked to the catalog. */
  cellEvidence?(ticket: string, signal?: AbortSignal): Promise<CellEvidence>;
  /**
   * M22: `/cells/{ticket}`'s `lanes` and `command_changes`, unparsed, as `{ lanes, command_changes }`
   * (src/line/lanesModel.ts readCellBuild reads it): a build in lanes as the cell's files record it,
   * and which of its commands changed when. Each is null when the reply has none: a build not in
   * lanes, one whose commands never changed, or an observer from before them.
   */
  cellLanes?(ticket: string, signal?: AbortSignal): Promise<unknown>;
  /**
   * One served text by catalog id, with its headers; a refusal is a value with its reason code, never
   * thrown. A 503 ("too many reads at once") is asked again once after its Retry-After, then given up.
   */
  artifactText?(id: string, signal?: AbortSignal): Promise<ArtifactTextResult>;
  /** The URL an image or video element loads (the content route, by catalog id only); null for anything that is not a catalog id. */
  artifactContentUrl?(id: string): string | null;
  /** `/api/v1/concurrency`, unparsed (Analytics reads it); throws not_found on an observer without the route. */
  concurrency?(query: ObserverConcurrencyQuery): Promise<Readonly<Record<string, unknown>>>;
  // ---- M6.5 (Factory Analytics). Optional like the M6.3 methods; each returns the reply's `data`
  // unparsed (src/analytics/data validates it). A 404 (`not_found`) means an observer without
  // analytics; a 400 (`invalid`) carries the observer's reason in its message.
  /** `GET /api/v1/analytics/metrics`. */
  analyticsMetrics?(query: ObserverAnalyticsMetricsQuery): Promise<Readonly<Record<string, unknown>>>;
  /** `GET /api/v1/analytics/flow`. */
  analyticsFlow?(query: ObserverAnalyticsQuery): Promise<Readonly<Record<string, unknown>>>;
  /** `GET /api/v1/analytics/contributors`. */
  analyticsContributors?(query: ObserverAnalyticsContributorsQuery): Promise<Readonly<Record<string, unknown>>>;
  /** `GET /api/v1/analytics/runs`. */
  analyticsRuns?(query: ObserverAnalyticsRunsQuery): Promise<Readonly<Record<string, unknown>>>;
  /** `GET /api/v1/analytics/insights` (M6_5_DESIGN.md 3.5). */
  analyticsInsights?(query: ObserverAnalyticsQuery): Promise<Readonly<Record<string, unknown>>>;
  /** `/session`'s `display_policy` unparsed (`free_text` says which fields hold prose); null when absent. */
  displayPolicy?(): Promise<Readonly<Record<string, unknown>> | null>;
  // ---- Decisions in force. Optional like the methods above; each returns the reply's `data` unparsed
  // (src/decisions/model.ts reads it). A 404 (`not_found`) from /decisions means an observer without the route.
  /** `GET /api/v1/decisions`: every ADR, the required baseline, what waits on a person. */
  decisions?(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  /** `GET /api/v1/decisions/{adr}`: one decision's page. */
  decision?(id: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

/** The filters every analytics route reads (M6_5_DESIGN.md 3); a route that cannot honour one answers 400. Values are identifiers or codes, never prose. */
export const ANALYTICS_FILTERS = ["risk", "app_type", "model", "station", "epic", "outcome", "provenance"] as const;
export type ObserverAnalyticsFilter = (typeof ANALYTICS_FILTERS)[number];

/** The common analytics parameters: one cursor (`at`) for every query of a view, a window or the last N runs, filters. */
export interface ObserverAnalyticsQuery {
  readonly at?: string | null;
  readonly fromMs?: number | null;
  readonly toMs?: number | null;
  readonly lastRuns?: number | null;
  readonly filters?: Readonly<Partial<Record<ObserverAnalyticsFilter, string>>>;
  readonly signal?: AbortSignal;
}
export interface ObserverAnalyticsMetricsQuery extends ObserverAnalyticsQuery {
  readonly ids?: readonly string[];
  /** At most two dimensions. */
  readonly groupBy?: readonly string[];
  readonly bucket?: "day" | "week" | null;
  readonly distribution?: boolean;
}
export interface ObserverAnalyticsContributorsQuery extends ObserverAnalyticsQuery {
  readonly metric: string;
  /** dimension → code, every one must match (`group=station:verify,round:1`). */
  readonly group?: Readonly<Record<string, string>>;
  readonly order?: "impact" | "recent";
  readonly limit?: number;
}
export interface ObserverAnalyticsRunsQuery extends ObserverAnalyticsQuery {
  readonly of?: "runs" | "executions";
  readonly limit?: number;
  readonly offset?: number;
}

/** The query string of an analytics route's common parameters (exported for tests). Only identifiers and numbers. */
export function analyticsParams(query: ObserverAnalyticsQuery): URLSearchParams {
  const q = new URLSearchParams();
  if (query.at) q.set("at", query.at);
  if (typeof query.fromMs === "number" && Number.isFinite(query.fromMs)) q.set("from_ms", String(Math.max(0, Math.floor(query.fromMs))));
  if (typeof query.toMs === "number" && Number.isFinite(query.toMs)) q.set("to_ms", String(Math.max(0, Math.ceil(query.toMs))));
  if (typeof query.lastRuns === "number" && query.lastRuns > 0) q.set("last_runs", String(Math.floor(query.lastRuns)));
  for (const name of ANALYTICS_FILTERS) {
    const v = query.filters?.[name];
    if (typeof v === "string" && v) q.set(name, v);
  }
  return q;
}

export interface ObserverConcurrencyQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly bucketMs: number;
  readonly kinds?: readonly string[];
  readonly signal?: AbortSignal;
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
    recordedState: str(obj(d.recorded_mode).state),
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
    repeat: num(a.repeat),
    voided: a.voided && typeof a.voided === "object" && typeof obj(a.voided).reason_code === "string" ? { reason_code: str(obj(a.voided).reason_code) ?? "recorded", outcome_before: str(obj(a.voided).outcome_before) ?? undefined } : null,
    commit: str(a.commit) || null,
    visit,
    contentAccess: str(a.content_access),
    freeText: a.free_text === true,
    freeTextNote: a.free_text === true ? (str(a.free_text_note) ?? "free text, not checked for names") : null,
    origin: a.origin === "cell" || a.origin === "archive" ? a.origin : null,
    logical: str(a.logical) || null,
    recordedSha256: str(a.recorded_sha256) || null,
    targets: list(a.targets)
      .map((x) => obj(x))
      .filter((t) => typeof t.id === "string" && t.id !== "")
      .map((t) => ({ id: t.id as string, kind: str(t.kind) || null, result: str(t.result) || null })),
    accessReason: str(a.access_reason) || null,
  };
}

/** A gate state word from a human gate of the snapshot. */
const humanGateState = (g: Record<string, unknown>): string => (g.closed ? (g.closed_by === "rejected" || g.closed_by === "sent-back" ? "failed" : "passed") : "waiting");

/**
 * `/api/v1/snapshot`'s `state` (the observer's projection: `slices`, `cells`, `executions`
 * as maps by id, `gates` as the human gates) in the shape the reducer reads. Arrays are taken too.
 */
export function readSnapshotState(data: unknown): ObserverSnapshotState {
  const d = obj(data);
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
    slices: slices.map((x) => ({ slice_id: x.slice_id as string, ticket_id: str(x.ticket_id), state: str(x.state), dependencies: strings(x.dependencies ?? x.depends_on), revision: num(x.revision),
      title: str(x.title) || null, epic_id: str(x.epic_id) || null, epic_title: str(x.epic_title) || null, issue: num(x.issue) })),
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

export function createObserverClient(options: { readonly fetch: FetchLike; readonly base?: string; /** How a Retry-After is waited out (the browser's timer from the shell; tests pass their own). Without it the retry is at once. */ readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }): ObserverClient {
  const base = options.base ?? "/api/v1";
  const sleep = options.sleep ?? defaultSleep;
  const getOnce = async (path: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const aborted = (): never => {
      throw signal?.reason ?? new DOMException("The request was superseded.", "AbortError");
    };
    if (signal?.aborted) aborted();
    let response: FetchResponseLike;
    try {
      response = await options.fetch(`${base}${path}`, { headers: { "X-MACH-Event-Schema": String(EVENT_SCHEMA), Accept: "application/json" }, credentials: "same-origin", ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) aborted();
      throw new ObserverError("network", error instanceof Error ? error.message : "The observer could not be reached.", 0);
    }
    let body: Record<string, unknown>;
    try {
      body = obj(await response.json());
    } catch {
      if (signal?.aborted) aborted();
      throw new ObserverError("protocol", "The observer's response was not JSON.", response.status);
    }
    if (signal?.aborted) aborted();
    if (body.ok === true) return obj(body.data);
    const error = obj(body.error);
    throw new ObserverError(KINDS[str(error.kind) ?? ""] ?? "protocol", str(error.message) ?? `The observer answered ${response.status}.`, response.status, error);
  };
  // Identical requests in flight are one request (L8 of the live run: the overview, the lenses and the
  // default window asked the same thing at once). Each caller keeps its own abort: the shared request is
  // aborted only when every caller waiting on it has given up.
  const inflight = new Map<string, { readonly promise: Promise<Record<string, unknown>>; readonly ctl: AbortController; waiting: number }>();
  const get = (path: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("The request was superseded.", "AbortError"));
    let entry = inflight.get(path);
    if (!entry) {
      const ctl = new AbortController();
      const promise = getOnce(path, ctl.signal);
      const made = { promise, ctl, waiting: 0 };
      entry = made;
      inflight.set(path, made);
      const forget = () => {
        if (inflight.get(path) === made) inflight.delete(path);
      };
      promise.then(forget, forget);
    }
    const shared = entry;
    shared.waiting += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = () => {
        done = true;
        shared.waiting -= 1;
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (done) return;
        settle();
        if (shared.waiting === 0) {
          if (inflight.get(path) === shared) inflight.delete(path);
          shared.ctl.abort();
        }
        reject(signal?.reason ?? new DOMException("The request was superseded.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (value) => {
          if (done) return;
          settle();
          resolve(value);
        },
        (error: unknown) => {
          if (done) return;
          settle();
          reject(error);
        },
      );
    });
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
        evidenceMedia: bool(capabilities.evidence_media),
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
    async factoryStatus() {
      return readFactoryStatus(await get("/factory/status"));
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
    async cellEvidence(ticket, signal) {
      const d = await get(`/cells/${encodeURIComponent(ticket)}/evidence`, signal);
      return readCellEvidence(d, ticket);
    },
    async cellLanes(ticket, signal) {
      const d = await get(`/cells/${encodeURIComponent(ticket)}`, signal);
      return {
        lanes: d.lanes && typeof d.lanes === "object" ? d.lanes : null,
        command_changes: Array.isArray(d.command_changes) ? d.command_changes : null,
      };
    },
    async artifactText(id, signal) {
      const url = artifactContentUrl(id, base);
      if (!url) return { ok: false, reason: "invalid", status: 0, retried: false };
      const once = async (): Promise<{ readonly response: FetchResponseLike | null }> => {
        try {
          return { response: await options.fetch(url, { credentials: "same-origin", headers: { Accept: "text/plain" }, ...(signal ? { signal } : {}) }) };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          return { response: null };
        }
      };
      let retried = false;
      let { response } = await once();
      if (response && response.status === 503) {
        retried = true;
        const after = Number(response.headers?.get("Retry-After") ?? "1");
        await sleep(Math.min(5, Math.max(0, Number.isFinite(after) ? after : 1)) * 1000, signal);
        ({ response } = await once());
      }
      if (!response) return { ok: false, reason: "network", status: 0, retried };
      if (response.status !== 200) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { ok: false, reason: refusalOf(response.status, body), status: response.status, retried };
      }
      // Served text is plain text; never JSON-parsed, never markup.
      const text = response.text ? await response.text() : "";
      return { ok: true, text, labels: readTextContentLabels(response.headers) };
    },
    artifactContentUrl(id) {
      return artifactContentUrl(id, base);
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
      const state = readSnapshotState({ slices, cells, executions: runs, history });
      return { cursor, state };
    },
    async concurrency(query) {
      const q = new URLSearchParams();
      q.set("from_ms", String(Math.max(0, Math.floor(query.fromMs))));
      q.set("to_ms", String(Math.max(0, Math.ceil(query.toMs))));
      q.set("bucket_ms", String(Math.max(1000, Math.round(query.bucketMs / 1000) * 1000)));
      if (query.kinds?.length) q.set("kinds", query.kinds.join(","));
      return get(`/concurrency?${q.toString()}`, query.signal);
    },
    // ---- M6.5 analytics (raw `data`; src/analytics/data parses it).
    async analyticsMetrics(query) {
      const q = analyticsParams(query);
      if (query.ids?.length) q.set("ids", query.ids.join(","));
      if (query.groupBy?.length) q.set("group_by", query.groupBy.join(","));
      if (query.bucket) q.set("bucket", query.bucket);
      if (query.distribution) q.set("distribution", "1");
      return get(`/analytics/metrics${q.size ? `?${q.toString()}` : ""}`, query.signal);
    },
    async analyticsFlow(query) {
      const q = analyticsParams(query);
      return get(`/analytics/flow${q.size ? `?${q.toString()}` : ""}`, query.signal);
    },
    async analyticsContributors(query) {
      const q = analyticsParams(query);
      q.set("metric", query.metric);
      const group = Object.entries(query.group ?? {}).map(([k, v]) => `${k}:${v}`);
      if (group.length) q.set("group", group.join(","));
      if (query.order) q.set("order", query.order);
      if (typeof query.limit === "number") q.set("limit", String(Math.floor(query.limit)));
      return get(`/analytics/contributors?${q.toString()}`, query.signal);
    },
    async analyticsRuns(query) {
      const q = analyticsParams(query);
      if (query.of && query.of !== "runs") q.set("of", query.of);
      if (typeof query.limit === "number") q.set("limit", String(Math.floor(query.limit)));
      if (typeof query.offset === "number" && query.offset > 0) q.set("offset", String(Math.floor(query.offset)));
      return get(`/analytics/runs${q.size ? `?${q.toString()}` : ""}`, query.signal);
    },
    async analyticsInsights(query) {
      const q = analyticsParams(query);
      return get(`/analytics/insights${q.size ? `?${q.toString()}` : ""}`, query.signal);
    },
    async displayPolicy() {
      const d = await get("/session");
      return d.display_policy && typeof d.display_policy === "object" ? obj(d.display_policy) : null;
    },
    async decisions(signal) {
      return get("/decisions", signal);
    },
    async decision(id, signal) {
      if (!/^ADR-[0-9]{4}$/.test(id)) throw new ObserverError("invalid", "An architecture decision is named by its ID, such as ADR-0007.", 0);
      return get(`/decisions/${id}`, signal);
    },
  };
}

/** No timer of its own (src/live reads time only through what it is given): without an injected `sleep`, the one retry is asked at once. */
function defaultSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  return signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve();
}

/** `<epoch>.<pos>` parts; null when the cursor is not one. */
export function parseCursor(cursor: string | null): { readonly generation: string; readonly pos: number } | null {
  if (!cursor) return null;
  const dot = cursor.lastIndexOf(".");
  if (dot <= 0) return null;
  const pos = Number(cursor.slice(dot + 1));
  return Number.isInteger(pos) && pos >= 0 ? { generation: cursor.slice(0, dot), pos } : null;
}

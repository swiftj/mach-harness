/**
 * `AnalyticsData`: the one interface the Analytics workspace reads, with two implementations, as the
 * Timeline has: `observerAnalytics(client)` (live and replay) and `simulatedAnalytics(seed)` (the
 * prototype's seeded fixture, always `source: "simulation"`, which the UI labels Simulated).
 *
 * Every method takes the view's cursor (`at`, null for the first query of a view) and answers an
 * `AnalyticsResult`: the typed reply, or why there is none. Aborts reject with an AbortError;
 * a network or protocol failure rejects with the error. Views should not call these directly but
 * through a snapshot (snapshot.ts), which keeps one cursor per view.
 */
import type { ObserverAnalyticsFilter } from "../../live/observer";
import type { DisplayPolicy } from "./text";
import type { AnalyticsSource, ConcurrencyReply, FreshnessReply, ContributorsReply, ExecutionsReply, FlowReply, InsightsReply, MetricsReply, RunsReply } from "./types";

/** The common query (M6_5_DESIGN.md 3): a time window or the last N finished runs, and filters. */
export interface AnalyticsQuery {
  /** Inclusive start, Unix ms. The observer widens the window to whole UTC days and says so in `window`. */
  readonly fromMs?: number | null;
  /** Exclusive end, Unix ms. */
  readonly toMs?: number | null;
  /** The last N finished runs by `closed_at` (the observe station's population); exclusive with a window. */
  readonly lastRuns?: number | null;
  /** Identifiers and codes only (`risk: "High"`, `app_type: "cli"`), never prose. */
  readonly filters?: Readonly<Partial<Record<ObserverAnalyticsFilter, string>>>;
}

export interface MetricsQuery extends AnalyticsQuery {
  readonly ids?: readonly string[];
  readonly groupBy?: readonly string[];
  readonly bucket?: "day" | "week" | null;
  readonly distribution?: boolean;
}
export interface ContributorsQuery extends AnalyticsQuery {
  readonly metric: string;
  /** dimension → code (never a prose group value). */
  readonly group?: Readonly<Record<string, string>>;
  readonly order?: "impact" | "recent";
  /** 1 to 500. */
  readonly limit?: number;
}
export interface RunsQuery extends AnalyticsQuery {
  readonly limit?: number;
  readonly offset?: number;
}

/** Options every call takes. */
export interface CallOptions {
  /** The view's cursor; null or absent for the first query of a view (the head). */
  readonly at?: string | null;
  /** A playhead (`as_of_ms`): nothing recorded later is counted (exactly, or by whole UTC days: the reply's `as_of` says). Combinable with `at`. */
  readonly asOfMs?: number | null;
  readonly signal?: AbortSignal;
}

/** The parallelism panel's range. */
export interface ConcurrencyQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly bucketMs: number;
  readonly kinds?: readonly string[];
}

/**
 * Why a reply is absent, so the UI can say so in words and never draw an empty chart as zero:
 * - `no-analytics`: the observer has no such route (404: an older observer, or `insights` not yet built);
 * - `invalid`: the observer refused the query (400), with its reason;
 * - `cursor-gone`: the view's cursor can no longer be read (409 ahead / 410 expired): begin a new snapshot;
 * - `unsupported`: this source cannot answer it (the simulation, for what its fixture lacks), with the reason.
 */
export type AnalyticsAbsence =
  | { readonly status: "no-analytics"; readonly reason: string }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "cursor-gone"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string };

export type AnalyticsResult<T> = { readonly status: "ok"; readonly value: T } | AnalyticsAbsence;

export interface AnalyticsData {
  /** `simulation` is fixture data: the UI must label every figure from it Simulated. */
  readonly source: AnalyticsSource;
  /** The free-text policy (`/session` `display_policy`); the simulation declares the observer's defaults. */
  displayPolicy(signal?: AbortSignal): Promise<DisplayPolicy>;
  metrics(query: MetricsQuery, options?: CallOptions): Promise<AnalyticsResult<MetricsReply>>;
  flow(query: AnalyticsQuery, options?: CallOptions): Promise<AnalyticsResult<FlowReply>>;
  contributors(query: ContributorsQuery, options?: CallOptions): Promise<AnalyticsResult<ContributorsReply>>;
  runs(query: RunsQuery, options?: CallOptions): Promise<AnalyticsResult<RunsReply>>;
  executions(query: RunsQuery, options?: CallOptions): Promise<AnalyticsResult<ExecutionsReply>>;
  insights(query: AnalyticsQuery, options?: CallOptions): Promise<AnalyticsResult<InsightsReply>>;
  /** `/api/v1/concurrency` (not pinned to a cursor: the route takes none). */
  concurrency(query: ConcurrencyQuery, options?: { readonly signal?: AbortSignal }): Promise<AnalyticsResult<ConcurrencyReply>>;
  /** When each kind of source was last read (`/factory/status`). */
  freshness(options?: { readonly signal?: AbortSignal }): Promise<AnalyticsResult<FreshnessReply>>;
}

/** The route names, for cache keys and the snapshot. */
export type AnalyticsRoute = "metrics" | "flow" | "contributors" | "runs" | "executions" | "insights";

/** A canonical, order-independent key of a query (for the cache). Identifiers and numbers only. */
export function queryKey(route: AnalyticsRoute, query: object): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined && x !== null && x !== "" && x !== false && !(Array.isArray(x) && !x.length) && !(x && typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length)) out[k] = canon(x);
      }
      return out;
    }
    return v;
  };
  return `${route}:${JSON.stringify(canon(query))}`;
}

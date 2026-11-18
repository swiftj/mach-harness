/**
 * One consistent snapshot per view (M6_5_DESIGN.md 3: "All charts of one view pass the same cursor
 * so they describe one state of the projection").
 *
 * `beginSnapshot(data, options)` returns a store-free session. Its first query goes to the head; the
 * cursor of the first reply is then passed as `at` to every other query of the session, and queries
 * asked before that reply arrived wait for it, so no two charts of a view mix projection states. The
 * view begins a new snapshot when the person refreshes, or when the live edge has advanced
 * (`shouldRefresh`), not more often than `SNAPSHOT_REFRESH_MS`; there is no polling loop here.
 *
 * Replies are kept in a cache keyed by (cursor, route, query), shared by every snapshot of one
 * provider (`snapshotCache`), so going back to a view at the same cursor reads nothing again.
 * Requests are abortable: `snapshot.abort()` cancels every request of the session.
 */
import { parseCursor } from "../../live/observer";
import type { AnalyticsData, AnalyticsQuery, AnalyticsResult, AnalyticsRoute, CallOptions, ContributorsQuery, MetricsQuery, RunsQuery } from "./provider";
import { queryKey } from "./provider";
import type { ContributorsReply, ExecutionsReply, FlowReply, InsightsReply, MetricsReply, RunsReply } from "./types";

/** The quickest a view refreshes on its own when the live edge advances. */
export const SNAPSHOT_REFRESH_MS = 2000;
/** Replies kept per provider. */
export const SNAPSHOT_CACHE_MAX = 64;

/** A reply read through a view's snapshot (at its cursor). */
export type SnapshotResult<T> = AnalyticsResult<T>;

export interface SnapshotOptions {
  /** A cursor to read at (a view restored at a known state); null: the head. */
  readonly at?: string | null;
  readonly cache?: SnapshotCache;
}

export interface AnalyticsSnapshotSession {
  /** The cursor every query of this view reads at; null until the first reply. */
  readonly cursor: string | null;
  /** True after a reply came back at another cursor than the view's (it is not used) or the cursor is gone: begin a new snapshot. */
  readonly broken: boolean;
  metrics(query: MetricsQuery): Promise<SnapshotResult<MetricsReply>>;
  flow(query: AnalyticsQuery): Promise<SnapshotResult<FlowReply>>;
  contributors(query: ContributorsQuery): Promise<SnapshotResult<ContributorsReply>>;
  runs(query: RunsQuery): Promise<SnapshotResult<RunsReply>>;
  executions(query: RunsQuery): Promise<SnapshotResult<ExecutionsReply>>;
  insights(query: AnalyticsQuery): Promise<SnapshotResult<InsightsReply>>;
  /** Cancels every request of this session; later calls reject with an AbortError. */
  abort(): void;
}

/** Replies by (cursor, route, query), least recently used dropped first. */
export interface SnapshotCache {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  readonly size: number;
  clear(): void;
}

export function createSnapshotCache(max = SNAPSHOT_CACHE_MAX): SnapshotCache {
  const entries = new Map<string, unknown>();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const v = entries.get(key);
      entries.delete(key);
      entries.set(key, v);
      return v;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

const caches = new WeakMap<AnalyticsData, SnapshotCache>();
/** The cache shared by every snapshot of a provider. */
export function snapshotCache(data: AnalyticsData): SnapshotCache {
  let c = caches.get(data);
  if (!c) caches.set(data, (c = createSnapshotCache()));
  return c;
}

/**
 * Whether a view should begin a new snapshot: the live head has moved past the view's cursor, and at
 * least `SNAPSHOT_REFRESH_MS` passed since it began. A cursor of another generation always refreshes.
 */
export function shouldRefresh(viewCursor: string | null, headCursor: string | null, sinceBeginMs: number, minMs = SNAPSHOT_REFRESH_MS): boolean {
  if (!viewCursor || !headCursor || viewCursor === headCursor) return false;
  if (sinceBeginMs < minMs) return false;
  const a = parseCursor(viewCursor);
  const b = parseCursor(headCursor);
  if (!a || !b) return false;
  return a.generation !== b.generation || b.pos > a.pos;
}

function abortError(): DOMException {
  return new DOMException("The analytics snapshot was abandoned.", "AbortError");
}

export function beginSnapshot(data: AnalyticsData, options: SnapshotOptions = {}): AnalyticsSnapshotSession {
  const cache = options.cache ?? snapshotCache(data);
  const controller = new AbortController();
  let cursor: string | null = options.at ?? null;
  let broken = false;
  // While the first query is out, the others wait for its cursor; a failed first query lets the next one go first.
  let pinning: Promise<void> | null = null;

  const call = async <T extends { readonly cursor: string }, Q extends AnalyticsQuery>(
    route: AnalyticsRoute,
    query: Q,
    fetch: (query: Q, options: CallOptions) => Promise<AnalyticsResult<T>>,
  ): Promise<SnapshotResult<T>> => {
    if (controller.signal.aborted) throw abortError();
    while (!cursor && pinning) {
      await pinning.catch(() => undefined);
      if (controller.signal.aborted) throw abortError();
    }
    const key = (c: string) => `${c}|${queryKey(route, query)}`;
    if (cursor) {
      const hit = cache.get(key(cursor)) as SnapshotResult<T> | undefined;
      if (hit) return hit;
    }
    const first = !cursor;
    let release: () => void = () => undefined;
    if (first) pinning = new Promise<void>((resolve) => (release = resolve));
    try {
      const result = await fetch(query, { at: cursor, signal: controller.signal });
      if (controller.signal.aborted) throw abortError();
      if (result.status !== "ok") {
        if (result.status === "cursor-gone") broken = true;
        return result;
      }
      const value = result.value;
      if (first && !cursor) cursor = value.cursor;
      else if (value.cursor !== cursor) {
        // Not this view's state: never mixed into it.
        broken = true;
        return { status: "cursor-gone", reason: "The reply describes another state of the projection than this view's." };
      }
      const answer: SnapshotResult<T> = { status: "ok", value };
      cache.set(key(value.cursor), answer);
      return answer;
    } finally {
      if (first) {
        pinning = null;
        release();
      }
    }
  };

  return {
    get cursor() {
      return cursor;
    },
    get broken() {
      return broken;
    },
    metrics: (q) => call("metrics", q, (x, o) => data.metrics(x, o)),
    flow: (q) => call("flow", q, (x, o) => data.flow(x, o)),
    insights: (q) => call("insights", q, (x, o) => data.insights(x, o)),
    contributors: (q) => call("contributors", q, (x, o) => data.contributors(x, o)),
    runs: (q) => call("runs", q, (x, o) => data.runs(x, o)),
    executions: (q) => call("executions", q, (x, o) => data.executions(x, o)),
    abort() {
      controller.abort(abortError());
    },
  };
}

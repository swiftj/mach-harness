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
 *
 * "As of" (a replay at the playhead): every query asks `as_of_ms` = the playhead, beside the view's
 * cursor. The observer answers flow, contributors and runs exactly (nothing recorded later), and
 * metrics and insights by whole UTC days before the playhead (`asOf.exact` false, `asOf.rule` its
 * words, which the UI shows). An observer without `as_of_ms` answers 400; the snapshot then falls
 * back to `to_ms` = the playhead (an earlier `to_ms` is kept). That observer widens the window to the
 * end of the playhead's day, so a figure may include later outcomes of that day: `asOf.widened` says
 * so and the UI must say it. Lists (runs, executions, contributors) are cut here at the playhead: items placed
 * after it, or with no recorded time, are dropped and counted (`after_as_of`), never shown.
 */
import { parseCursor } from "../../live/observer";
import type { AnalyticsData, AnalyticsQuery, AnalyticsResult, AnalyticsRoute, CallOptions, ContributorsQuery, MetricsQuery, RunsQuery } from "./provider";
import { queryKey } from "./provider";
import type { ContributorsReply, ExecutionsReply, FlowReply, InsightsReply, MetricsReply, RunsReply } from "./types";

/** The quickest a view refreshes on its own when the live edge advances: the Timeline's structure cadence (timeline/data/observer.ts STRUCTURE_REFRESH_MS). */
export const SNAPSHOT_REFRESH_MS = 2000;
/** Replies kept per provider. */
export const SNAPSHOT_CACHE_MAX = 64;

/** Said when the observer could not answer as of the playhead and the window's end was cut instead. */
export const WIDENED_RULE = "counted to the end of the playhead's UTC day: outcomes later that day may be included";

/** What a reply says about the "as of" time it was asked for. */
export interface AsOf {
  readonly ms: number;
  /** The observer counted nothing recorded after `ms` (`as_of.exact`). */
  readonly exact: boolean;
  /** The observer's rule when not exact ("whole UTC days before the playhead; …"), or this client's for the fallback. */
  readonly rule: string | null;
  /** The observer counted up to this time (its effective window end), later than `ms`: same-day outcomes after the playhead may be in the figure. */
  readonly widened: boolean;
  readonly effectiveToMs: number | null;
}

export type SnapshotResult<T> = AnalyticsResult<T & { readonly asOf: AsOf | null }>;

export interface SnapshotOptions {
  /** A replay's playhead (Unix ms): nothing after it is shown. Null or absent: the whole recorded history (or the query's window). */
  readonly asOfMs?: number | null;
  /** A cursor to read at (a view restored at a known state); null: the head. */
  readonly at?: string | null;
  readonly cache?: SnapshotCache;
}

export interface AnalyticsSnapshotSession {
  /** The cursor every query of this view reads at; null until the first reply. */
  readonly cursor: string | null;
  readonly asOfMs: number | null;
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
/** Providers whose observer answered 400 to `as_of_ms` (an observer before it): "as of" falls back to `to_ms`. */
const asOfUnsupported = new WeakSet<AnalyticsData>();
/** The cache shared by every snapshot of a provider. */
export function snapshotCache(data: AnalyticsData): SnapshotCache {
  let c = caches.get(data);
  if (!c) caches.set(data, (c = createSnapshotCache()));
  return c;
}

/** The query with the "as of" time applied to its window end (an earlier end is kept). A `last_runs` query keeps its population and is cut as a list. */
export function asOfQuery<Q extends AnalyticsQuery>(query: Q, asOfMs: number | null): Q {
  if (asOfMs === null || query.lastRuns) return query;
  const to = typeof query.toMs === "number" ? Math.min(query.toMs, asOfMs) : asOfMs;
  return { ...query, toMs: to };
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
  const asOfMs = typeof options.asOfMs === "number" && Number.isFinite(options.asOfMs) ? options.asOfMs : null;
  const controller = new AbortController();
  let cursor: string | null = options.at ?? null;
  let broken = false;
  // While the first query is out, the others wait for its cursor; a failed first query lets the next one go first.
  let pinning: Promise<void> | null = null;

  const call = async <T extends { readonly cursor: string; readonly window?: { readonly effective_to_ms: number | null }; readonly as_of?: { readonly exact: boolean; readonly effective_to_ms: number | null; readonly rule: string | null } | null }, Q extends AnalyticsQuery>(
    route: AnalyticsRoute,
    query: Q,
    fetch: (query: Q, options: CallOptions) => Promise<AnalyticsResult<T>>,
    cut: (value: T) => T = (v) => v,
  ): Promise<SnapshotResult<T>> => {
    if (controller.signal.aborted) throw abortError();
    while (!cursor && pinning) {
      await pinning.catch(() => undefined);
      if (controller.signal.aborted) throw abortError();
    }
    // Exact "as of" unless this observer refused as_of_ms: then the window's end is cut instead.
    const widen = () => asOfMs !== null && asOfUnsupported.has(data);
    const asked = (): Q => (widen() ? asOfQuery(query, asOfMs) : query);
    const key = (c: string) => `${c}|${widen() ? "to" : "at"}|${queryKey(route, asked())}`;
    if (cursor) {
      const hit = cache.get(key(cursor)) as SnapshotResult<T> | undefined;
      if (hit) return hit;
    }
    const first = !cursor;
    let release: () => void = () => undefined;
    if (first) pinning = new Promise<void>((resolve) => (release = resolve));
    try {
      const opts = (): CallOptions => ({ at: cursor, signal: controller.signal, ...(asOfMs !== null && !widen() ? { asOfMs } : {}) });
      let result = await fetch(asked(), opts());
      if (asOfMs !== null && !widen() && result.status === "invalid" && /as_of_ms/.test(result.reason)) {
        asOfUnsupported.add(data);
        result = await fetch(asked(), opts());
      }
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
      let asOf: AsOf | null = null;
      if (asOfMs !== null && value.as_of) {
        asOf = { ms: asOfMs, exact: value.as_of.exact, rule: value.as_of.exact ? null : value.as_of.rule, effectiveToMs: value.as_of.effective_to_ms, widened: false };
      } else if (asOfMs !== null) {
        // Cut by to_ms (an observer without as_of_ms, or a reply that did not say): the day may be widened past the playhead.
        const eff = value.window?.effective_to_ms ?? null;
        const widened = eff === null || eff > asOfMs;
        asOf = { ms: asOfMs, exact: false, rule: widened ? WIDENED_RULE : null, effectiveToMs: eff, widened };
      }
      const answer: SnapshotResult<T> = { status: "ok", value: { ...cut(value), asOf } };
      cache.set(key(value.cursor), answer);
      return answer;
    } finally {
      if (first) {
        pinning = null;
        release();
      }
    }
  };

  /** Items after the playhead, or with no recorded time, are dropped and counted. */
  const cutList = <V extends { readonly items: readonly unknown[]; readonly after_as_of: number }>(value: V, timeOf: (item: V["items"][number]) => number | null): V => {
    if (asOfMs === null) return value;
    const kept = value.items.filter((i) => {
      const t = timeOf(i);
      return t !== null && t <= asOfMs; // an item with no recorded time may be later: not shown
    });
    return { ...value, items: kept, after_as_of: value.items.length - kept.length };
  };

  return {
    get cursor() {
      return cursor;
    },
    asOfMs,
    get broken() {
      return broken;
    },
    metrics: (q) => call("metrics", q, (x, o) => data.metrics(x, o)),
    flow: (q) => call("flow", q, (x, o) => data.flow(x, o)),
    insights: (q) => call("insights", q, (x, o) => data.insights(x, o)),
    contributors: (q) => call("contributors", q, (x, o) => data.contributors(x, o), (v) => cutList(v, (i) => i.at_ms)),
    runs: (q) => call("runs", q, (x, o) => data.runs(x, o), (v) => cutList(v, (r) => r.closed_at?.at_ms ?? null)),
    executions: (q) => call("executions", q, (x, o) => data.executions(x, o), (v) => cutList(v, (x) => x.started_ms)),
    abort() {
      controller.abort(abortError());
    },
  };
}

/**
 * `observerAnalytics(client)`: Analytics read from the observer (live and replay) through the
 * ObserverClient the shell already holds (its cookie, its in-flight sharing). Each reply is
 * validated (parse.ts); a 404 is "this observer has no analytics", a 400 surfaces the observer's
 * reason, a 409 or 410 means the view's cursor is gone. Anything else rejects.
 */
import { ObserverError, type ObserverAnalyticsQuery, type ObserverClient } from "../../live/observer";
import { AnalyticsProtocolError, readConcurrencyReply, readContributors, readFlow, readFreshness, readInsights, readMetrics, readRuns } from "./parse";
import type { AnalyticsData, AnalyticsQuery, AnalyticsResult, CallOptions } from "./provider";
import { UNDECLARED_POLICY, readDisplayPolicy, type DisplayPolicy } from "./text";
import type { ExecutionsReply, RunsReply } from "./types";

const NO_ANALYTICS = "This observer does not serve Factory Analytics (an older observer).";

function common(query: AnalyticsQuery, options: CallOptions | undefined): ObserverAnalyticsQuery {
  return {
    at: options?.at ?? null,
    fromMs: query.fromMs ?? null,
    toMs: query.toMs ?? null,
    lastRuns: query.lastRuns ?? null,
    asOfMs: options?.asOfMs ?? null,
    ...(query.filters ? { filters: query.filters } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

/** Runs a call and turns the observer's refusals into absences; other failures and aborts reject. */
async function answer<T>(call: (() => Promise<unknown>) | undefined, parse: (data: unknown) => T, route: string): Promise<AnalyticsResult<T>> {
  if (!call) return { status: "no-analytics", reason: NO_ANALYTICS };
  try {
    return { status: "ok", value: parse(await call()) };
  } catch (error) {
    if (!(error instanceof ObserverError)) throw error;
    if (error.kind === "not_found" || error.status === 404) return { status: "no-analytics", reason: route === "insights" ? "This observer does not serve Improvement Opportunities." : route === "concurrency" ? "This observer does not serve concurrency." : NO_ANALYTICS };
    if (error.kind === "invalid" || error.status === 400) return { status: "invalid", reason: error.message };
    if (error.kind === "cursor_reset" || error.kind === "cursor_expired" || error.status === 409 || error.status === 410) return { status: "cursor-gone", reason: error.message };
    throw error;
  }
}

export function observerAnalytics(client: ObserverClient): AnalyticsData {
  let policy: Promise<DisplayPolicy> | null = null;
  // The policy is read once per provider; a failure is not remembered (the next caller asks again).
  const readPolicy = (): Promise<DisplayPolicy> => {
    if (!client.displayPolicy) return Promise.resolve(UNDECLARED_POLICY);
    policy ??= client.displayPolicy().then(readDisplayPolicy, (error: unknown) => {
      policy = null;
      if (error instanceof ObserverError) return UNDECLARED_POLICY;
      throw error;
    });
    return policy;
  };
  const runsCall = (query: Parameters<AnalyticsData["runs"]>[0], options: CallOptions | undefined, of: "runs" | "executions") =>
    client.analyticsRuns && (() => client.analyticsRuns!({ ...common(query, options), of, ...(query.limit ? { limit: query.limit } : {}), ...(query.offset ? { offset: query.offset } : {}) }));
  const runsOf = (d: unknown): RunsReply => {
    const r = readRuns(d, "observer");
    if (r.of !== "runs") throw new AnalyticsProtocolError("Asked for run records; the reply holds executions.");
    return r;
  };
  const executionsOf = (d: unknown): ExecutionsReply => {
    const r = readRuns(d, "observer");
    if (r.of !== "executions") throw new AnalyticsProtocolError("Asked for executions; the reply holds run records.");
    return r;
  };
  return {
    source: "observer",
    displayPolicy: () => readPolicy(),
    async metrics(query, options) {
      const pol = await readPolicy();
      return answer(
        client.analyticsMetrics &&
          (() =>
            client.analyticsMetrics!({
              ...common(query, options),
              ...(query.ids ? { ids: query.ids } : {}),
              ...(query.groupBy ? { groupBy: query.groupBy } : {}),
              ...(query.bucket ? { bucket: query.bucket } : {}),
              ...(query.distribution ? { distribution: true } : {}),
            })),
        (d) => readMetrics(d, "observer", pol),
        "metrics",
      );
    },
    flow: (query, options) => answer(client.analyticsFlow && (() => client.analyticsFlow!(common(query, options))), (d) => readFlow(d, "observer"), "flow"),
    contributors: (query, options) =>
      answer(
        client.analyticsContributors &&
          (() =>
            client.analyticsContributors!({
              ...common(query, options),
              metric: query.metric,
              ...(query.group ? { group: query.group } : {}),
              ...(query.order ? { order: query.order } : {}),
              ...(query.limit ? { limit: query.limit } : {}),
            })),
        (d) => readContributors(d, "observer"),
        "contributors",
      ),
    runs: (query, options) => answer(runsCall(query, options, "runs"), runsOf, "runs"),
    executions: (query, options) => answer(runsCall(query, options, "executions"), executionsOf, "runs"),
    insights: (query, options) => answer(client.analyticsInsights && (() => client.analyticsInsights!(common(query, options))), (d) => readInsights(d, "observer"), "insights"),
    concurrency: (query, options) =>
      answer(
        client.concurrency && (() => client.concurrency!({ fromMs: query.fromMs, toMs: query.toMs, bucketMs: query.bucketMs, ...(query.kinds ? { kinds: query.kinds } : {}), ...(options?.signal ? { signal: options.signal } : {}) })),
        (d) => readConcurrencyReply(d, "observer", query),
        "concurrency",
      ),
    freshness: () => answer(() => client.factoryStatus(), (d) => readFreshness(d as Parameters<typeof readFreshness>[0], "observer"), "freshness"),
  };
}

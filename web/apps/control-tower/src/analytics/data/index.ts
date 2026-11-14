/** Factory Analytics' data layer: the observer and simulation providers behind one interface, one cursor per view, containment of prose, shared number words. React glue (useAnalyticsData, useAnalyticsSnapshot) is imported from ./react; the UncheckedText component, shared with the inspectors, from src/text/UncheckedText, so this index loads in plain node. */
export type { AnalyticsData, AnalyticsQuery, MetricsQuery, ContributorsQuery, RunsQuery, CallOptions, ConcurrencyQuery, AnalyticsResult, AnalyticsAbsence, AnalyticsRoute } from "./provider";
export { queryKey } from "./provider";
export { observerAnalytics } from "./observer";
export { simulatedAnalytics, SIMULATION_RULE, type SimulatedAnalyticsOptions } from "./simulation";
export { beginSnapshot, shouldRefresh, asOfQuery, snapshotCache, createSnapshotCache, SNAPSHOT_REFRESH_MS, SNAPSHOT_CACHE_MAX, WIDENED_RULE, AS_OF_UNSUPPORTED, type AnalyticsSnapshotSession, type SnapshotOptions, type SnapshotResult, type AsOf, type SnapshotCache } from "./snapshot";
export { unchecked, isUnchecked, uncheckedView, readDisplayPolicy, UNDECLARED_POLICY, UNCHECKED_NOTE, PROSE_DIMENSIONS, type UncheckedText, type UncheckedView, type DisplayPolicy, type FreeTextField } from "./text";
export { AnalyticsProtocolError, readMetrics, readMetricRow, readFlow, readContributors, readRuns, readInsights, readEnvelope, readConcurrencyReply, readFreshness } from "./parse";
export { countWords, durationWords, percentOf, recordedUsd, tokenWords, sampleWords, coverageWords, roundObserve, NO_VALUE } from "./format";
export { toContractRow, toContractRun, toContractContributors, toContractTransitions, toContractSnapshot, toContractConcurrency, toContractFreshness, freshnessFor, configsOf, type SnapshotParts } from "./adapt";
export type * from "./types";

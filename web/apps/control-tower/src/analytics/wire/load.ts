/**
 * One area's figures, read through the view's snapshot (data/snapshot.ts: one cursor for every
 * query of the view) and assembled into the contract's shape by data/adapt.ts. No React: the
 * workspace calls `loadArea` and shows what it answers; the unit tests call it over the simulated
 * provider and over recorded observer replies.
 *
 * The ungrouped totals are read first: they pin the view's cursor and decide the area's state (an
 * observer without analytics, a refused query, a cursor no longer readable). The other parts follow
 * at that cursor. A part that cannot be read is left out and named in `notes`; the areas then say
 * "not served" for it, never draw it as zero.
 */
import type { AnalyticsFilters as ContractFilters, AnalyticsSnapshot, Dimension, MetricId, WindowKey } from "../contract";
import { configsOf, freshnessFor, toContractSnapshot, type SnapshotParts } from "../data/adapt";
import type { AnalyticsData, AnalyticsResult, ContributorsQuery } from "../data/provider";
import type { AnalyticsSnapshotSession, AsOf, SnapshotResult } from "../data/snapshot";
import type { ContributorsReply, InsightsReply, MetricRow, MetricsReply, RunItem } from "../data/types";
import type { RunConfigs } from "../model/cohorts";
import type { AreaData, AreaSource } from "../ui/types";
import { concurrencyBucket, listsGroupOf, listsRowsOf, type AreaPlan, type QueryFilters } from "./query";
import type { SnapshotHistory } from "./history";

export const NO_ANALYTICS_REASON = "This observer does not serve Factory Analytics: it is older than the Analytics routes. Run an observer from this release to read these figures.";
const NO_INSIGHTS_REASON = "This observer does not serve Improvement Opportunities.";
/** Runs read per page, and the most pages read for one view. */
export const RUNS_PAGE = 1000;
export const RUNS_PAGES_MAX = 5;
/** Contributors read for a figure the area itself draws from (the drawer reads its own). */
export const SNAPSHOT_CONTRIBUTORS = 500;

export interface LoadInput {
  readonly session: AnalyticsSnapshotSession;
  /** For the two routes not pinned to a cursor (concurrency, freshness). */
  readonly data: AnalyticsData;
  readonly source: AreaSource;
  readonly plan: AreaPlan;
  readonly fromMs: number | null;
  readonly toMs: number | null;
  /** The shared filters as codes, without the model. */
  readonly filters: QueryFilters;
  /** The model, for Economics (plan.model). */
  readonly model: string | null;
  /** The contract's filters, as the snapshot states them. */
  readonly contractFilters: ContractFilters;
  /** Where the history ends when the reply does not say (the newest record's day end, the playhead, the fixture's end). */
  readonly endMs: number | null;
  /** Told the view's cursor as soon as the totals pinned it (before the other parts are read). */
  readonly onCursor?: (cursor: string | null) => void;
}

export interface LoadResult {
  readonly data: AreaData<AnalyticsSnapshot>;
  readonly insights: AreaData<InsightsReply> | undefined;
  readonly configs: RunConfigs | undefined;
  readonly cursor: string | null;
  /** The totals reply's "as of", when one was asked. */
  readonly asOf: AsOf | null;
  /** Under a playhead: the UTC midnight every figure of the view is counted to (metrics by day, the run list cut there too). */
  readonly dayCut?: number | null;
  /** D4: under a playhead, no whole UTC day of the history is complete before it: day-counted figures have nothing to count. */
  readonly noWholeDay?: boolean;
  /** The newest event the observer applied (history.sources), when it said. */
  readonly lastEventMs?: number | null;
  /** Parts not read, in words. */
  readonly notes: readonly string[];
  /** The view's cursor can no longer be read: begin a new snapshot at the head. */
  readonly restart: boolean;
}

/** An absence (or a failure) as the area's state. */
export function absenceState(r: Exclude<AnalyticsResult<unknown>, { status: "ok" }>): AreaData<never> {
  switch (r.status) {
    case "no-analytics":
      return { state: "unavailable", reason: NO_ANALYTICS_REASON };
    case "invalid":
      return { state: "error", status: 400, reason: r.reason };
    case "cursor-gone":
      return { state: "error", status: 409, reason: r.reason };
    case "unsupported":
      return { state: "unavailable", reason: r.reason };
  }
}

export function failureState(error: unknown): AreaData<never> {
  const status = error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : null;
  const reason = error instanceof Error ? error.message : String(error);
  return { state: "error", status: status && status > 0 ? status : null, reason: reason || "no answer" };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const D = 86_400_000;

function contractWindowKey(fromMs: number | null, toMs: number | null, endMs: number | null): WindowKey {
  if (fromMs === null && toMs === null) return "all";
  if (toMs === null && endMs !== null && fromMs !== null) {
    const days = Math.round((Math.ceil(endMs / D) * D - fromMs) / D);
    if (days === 7) return "7d";
    if (days === 14) return "14d";
    if (days === 28) return "28d";
  }
  return "all";
}

export async function loadArea(input: LoadInput): Promise<LoadResult> {
  const { session, plan } = input;
  const notes: string[] = [];
  const base = { fromMs: input.fromMs, toMs: input.toMs, filters: input.filters };
  // The observer filters by a recorded model id; the store holds a tier (the family the id names).
  let modelId: string | null = null;
  if (plan.model && input.model) {
    const r = await session.metrics({ ...base, ids: ["K2"], groupBy: ["model"] }).catch((e: unknown) => {
      if (isAbort(e)) throw e;
      return null;
    });
    const ids = r?.status === "ok" ? (r.value.metrics[0]?.groups ?? []).flatMap((g) => (g.keys.model?.kind === "code" ? [g.keys.model.text] : [])) : [];
    const family = ids.filter((id) => id === input.model || id.split("-").includes(input.model!));
    // None recorded: the tier is passed as it is, so the figures say there is nothing for it rather than showing every model.
    modelId = family.length === 1 ? family[0]! : family.length === 0 ? input.model : null;
    if (family.length > 1) notes.push(`more than one recorded model is a ${input.model} model (${family.join(", ")}): the model filter names one; figures are shown for all models`);
    else if (family.length === 0) notes.push(`no execution in this window recorded a ${input.model} model`);
  }
  const withModel = modelId ? { ...base, filters: { ...input.filters, model: modelId } } : base;
  const fail = (data: AreaData<never>, restart = false): LoadResult => ({ data, insights: undefined, configs: undefined, cursor: session.cursor, asOf: null, notes, restart });

  // The totals first: they pin the cursor and decide the area's state.
  let totals: SnapshotResult<MetricsReply>;
  try {
    totals = await session.metrics({ ...withModel, distribution: true });
  } catch (error) {
    if (isAbort(error)) throw error;
    return fail(failureState(error));
  }
  if (totals.status !== "ok") return fail(absenceState(totals), totals.status === "cursor-gone");
  // D1: the totals must be those of this view's cut (the snapshot keys and checks replies by it); defence in depth.
  if ((totals.value.asOf?.ms ?? null) !== session.asOfMs) return fail({ state: "error", status: 409, reason: "The figures read describe another moment than this view's." }, true);
  const t = totals.value;
  input.onCursor?.(session.cursor);

  const part = async <T>(what: string, run: () => Promise<SnapshotResult<T> | AnalyticsResult<T>>): Promise<T | null> => {
    try {
      const r = await run();
      if (r.status === "ok") return r.value;
      if (r.status === "cursor-gone") throw new CursorGone(r.reason);
      if (r.status !== "unsupported" || input.source !== "simulation") notes.push(`${what}: ${r.reason}`);
      return null;
    } catch (error) {
      if (isAbort(error) || error instanceof CursorGone) throw error;
      notes.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  try {
    const grouped = Promise.all(
      plan.groups.map((g) => part(`${g.ids.join(", ")} by ${g.dim}`, () => session.metrics({ ...(g.ids.some((id) => id.startsWith("K")) ? withModel : base), ids: g.ids, groupBy: [g.dim], ...(g.distribution ? { distribution: true } : {}) }))),
    );
    const runs = plan.runs ? readRuns(session, base, part) : Promise.resolve(null);
    const flow = plan.flow ? part("flow", () => session.flow(base)) : Promise.resolve(null);
    let insights: Promise<AreaData<InsightsReply> | undefined> = Promise.resolve(undefined);
    if (plan.insights) {
      insights = session.insights(base).then(
        (r): AreaData<InsightsReply> => (r.status === "ok" ? { state: "ready", value: r.value } : r.status === "no-analytics" ? { state: "unavailable", reason: NO_INSIGHTS_REASON } : absenceState(r)),
        (e: unknown): AreaData<InsightsReply> => {
          if (isAbort(e)) throw e;
          return failureState(e);
        },
      );
    }
    const contributorsOf = (metric: string, dim?: string, value?: string) =>
      part(`contributors of ${metric}${dim ? ` (${dim} ${value})` : ""}`, () => session.contributors({ ...base, metric, ...(dim && value !== undefined ? { group: { [dim]: value } } : {}), order: "impact", limit: SNAPSHOT_CONTRIBUTORS } satisfies ContributorsQuery)).then((reply) => (reply ? { metric, dim, value, reply } : null));
    // The contributors route has no model filter: under one, Economics' cost rows are not listed rather than shown unfiltered.
    const modelled = plan.model && input.model !== null;
    if (modelled && plan.contributors.length) notes.push(`per-execution costs are not listed under a model filter (the rows route cannot narrow by model)`);
    const fixed = Promise.all((modelled ? [] : plan.contributors).filter((c) => listsRowsOf(input.data.source, c.metric)).filter((c) => {
      if (c.dim && c.value !== undefined && !listsGroupOf(input.data.source, { [c.dim]: c.value })) {
        notes.push(`the rows of ${c.metric} for ${c.dim} “${c.value}” are not listed: the observer's rows route takes identifiers only`);
        return false;
      }
      return true;
    }).map((c) => contributorsOf(c.metric, c.dim, c.value)));
    // Every part is awaited below; one that fails after the view was abandoned must not surface as an unhandled rejection.
    for (const p of [grouped, runs, flow, insights, fixed]) p.catch(() => undefined);
    const groupedRows = await grouped;
    const perGroup = Promise.all(
      plan.perGroup.flatMap((pg) => {
        const row = groupedRows.flatMap((r) => r?.metrics ?? []).find((m) => m.id === pg.metric && m.group_dims.length === 1 && m.group_dims[0] === pg.dim);
        return (row?.groups ?? []).flatMap((g) => {
          const v = g.keys[pg.dim];
          return v && v.kind === "code" && listsGroupOf(input.data.source, { [pg.dim]: v.text }) ? [contributorsOf(pg.metric, pg.dim, v.text)] : [];
        });
      }),
    );
    const [runItems, flowReply, insightsData, fixedC, groupC] = await Promise.all([runs, flow, insights, fixed, perGroup]);

    // The window the figures describe: the observer's effective window, else the history's start and the end the caller knows.
    // The whole recorded history ends with the day of the newest event the observer applied (history.sources), never earlier.
    const lastEvent = Math.max(-Infinity, ...(t.history.sources ?? []).map((x) => x.last_event_ms ?? -Infinity));
    const lastDay = Number.isFinite(lastEvent) ? Math.floor(lastEvent / D) * D + D : null;
    const to = t.window.effective_to_ms ?? input.toMs ?? (input.source !== "simulation" && t.asOf === null && lastDay !== null ? Math.max(lastDay, input.endMs ?? 0) : null) ?? input.endMs ?? t.generated_ms ?? Date.now();
    // Nothing held yet (an empty history): the window is the last day, not an invented period.
    const from = t.window.effective_from_ms ?? input.fromMs ?? t.history.from_ms ?? Math.floor((to - 1) / D) * D;
    const dayCutAt = t.asOf && !t.asOf.exact && t.asOf.effectiveToMs !== null ? t.asOf.effectiveToMs : null;
    // D4: held at a playhead on the history's first day, the day cut lies at or before where the history
    // begins: no whole day to count. The window is never inverted: it is the playhead's day up to the
    // playhead, which the exactly-cut parts (flow, rows) cover.
    const firstHeld = t.history.from_ms ?? from;
    const noWholeDay = dayCutAt !== null && session.asOfMs !== null && dayCutAt <= Math.max(from, firstHeld);
    const window = noWholeDay ? { from_ms: dayCutAt, to_ms: Math.max(dayCutAt + 1, session.asOfMs!) } : { from_ms: Math.min(from, to), to_ms: to };

    const [concurrency, freshness] = await Promise.all([
      plan.concurrency && window.to_ms > window.from_ms ? part("concurrency", () => input.data.concurrency({ fromMs: window.from_ms, toMs: window.to_ms, bucketMs: concurrencyBucket(window.from_ms, window.to_ms) })) : Promise.resolve(null),
      plan.freshness ? part("freshness", () => input.data.freshness()) : Promise.resolve(null),
    ]);

    const dayCut = dayCutAt;
    const groupedMetrics: MetricRow[] = groupedRows.flatMap((r) => r?.metrics ?? []).filter((m) => m.group_dims.length === 1);
    const contributors = [...fixedC, ...groupC].filter((c): c is { metric: string; dim: string | undefined; value: string | undefined; reply: ContributorsReply } => c !== null);
    const parts: SnapshotParts = {
      source: input.source === "simulation" ? "simulated" : input.source,
      filters: { ...input.contractFilters, window: contractWindowKey(input.fromMs, input.toMs, input.endMs) },
      window,
      generated_ms: t.generated_ms ?? window.to_ms,
      totals: t.metrics,
      grouped: groupedMetrics,
      contributors: contributors.map((c) => ({ metric: c.metric as MetricId, ...(c.dim ? { dimension: c.dim as Dimension, value: c.value ?? "" } : {}), reply: c.reply })),
      // Under a playhead the metrics count whole UTC days (to effective_to_ms); finished tickets are cut at the
      // same midnight, so a figure read from the run list never disagrees with the same quantity from /metrics.
      runs: dayCut !== null ? (runItems ?? []).filter((r) => r.closed_at?.at_ms != null && r.closed_at.at_ms < dayCut) : (runItems ?? []),
      transitions: flowReply?.transitions ?? [],
      definitions_version: t.definitions_version ?? t.projection.definitions,
      partial: t.history.complete === false && t.history.partial !== null && t.history.partial !== "",
      group_overflow: t.group_overflow ?? 0,
      concurrency,
      freshness,
      flowCoverage: flowReply?.coverage ?? null,
      historySources: t.history.sources,
    };
    if (plan.runs && runItems === null) notes.push("finished tickets were not listed: figures read from run records are not shown");
    // I-03: how complete the counted history is, said where the figures are (wire/history.ts).
    const history: SnapshotHistory = { partial: t.history.partial, gaps: t.history.gaps, suspect_days: t.suspect_days, as_of_ms: session.asOfMs };
    const contract = toContractSnapshot(parts);
    const snapshot: AnalyticsSnapshot = { ...(noWholeDay ? { ...withoutWholeDay(contract), no_whole_day: true as const } : contract), history };
    return {
      // Freshness from the status reply and the view's own history.sources (either alone is enough).
      data: { state: "ready", value: plan.freshness ? { ...snapshot, freshness: asOfFreshness(freshnessFor(freshness, t.history, flowReply?.coverage ?? null), session.asOfMs) } : snapshot },
      insights: insightsData,
      configs: runItems ? configsOf(runItems) : undefined,
      dayCut,
      noWholeDay,
      lastEventMs: Number.isFinite(lastEvent) ? lastEvent : null,
      cursor: session.cursor,
      asOf: t.asOf,
      notes,
      restart: false,
    };
  } catch (error) {
    if (error instanceof CursorGone) return fail({ state: "error", status: 409, reason: error.message }, true);
    throw error;
  }
}

class CursorGone extends Error {}

/** Said beside a figure counted by whole UTC days when none is complete before the playhead (D4). */
export const NO_WHOLE_DAY_REASON = "no whole UTC day is complete before the playhead, so there is nothing to count by day";

/** D4: day-counted figures with no value say why (wording only; values are left as the observer gave them). */
function withoutWholeDay(s: AnalyticsSnapshot): AnalyticsSnapshot {
  const say = (r: AnalyticsSnapshot["totals"][keyof AnalyticsSnapshot["totals"]]) => (r && r.value === null && r.as_of && !r.as_of.exact ? { ...r, null_reason: NO_WHOLE_DAY_REASON } : r);
  const totals = Object.fromEntries(Object.entries(s.totals).map(([k, r]) => [k, say(r)]));
  const grouped = Object.fromEntries(Object.entries(s.grouped).map(([k, r]) => [k, say(r)!]));
  return { ...s, totals, grouped };
}

/** Said beside a source whose read time is not shown under a playhead. */
export const READ_NOW_NOTE = "when the observer last read it is its time now, not the playhead's, so it is not shown";

/**
 * M6.6 (I-39): under a playhead, when the observer last read each source is its clock now, later than
 * the moment the view describes: not shown (the column then goes), and the note says why.
 */
export function asOfFreshness<F extends { readonly last_read_ms?: number | null; readonly note?: string }>(rows: readonly F[], asOfMs: number | null): F[] {
  if (asOfMs === null) return rows as F[];
  return rows.map((f) => (f.last_read_ms == null ? f : { ...f, last_read_ms: null, note: f.note ? `${f.note}; ${READ_NOW_NOTE}` : READ_NOW_NOTE }));
}

type Part = <T>(what: string, run: () => Promise<SnapshotResult<T> | AnalyticsResult<T>>) => Promise<T | null>;

/** Every finished ticket of the window, page by page (at most RUNS_PAGES_MAX pages; more is said, not guessed). */
async function readRuns(session: AnalyticsSnapshotSession, base: { fromMs: number | null; toMs: number | null; filters: QueryFilters }, part: Part): Promise<RunItem[] | null> {
  const out: RunItem[] = [];
  for (let page = 0; page < RUNS_PAGES_MAX; page++) {
    const reply = await part("finished tickets", () => session.runs({ ...base, limit: RUNS_PAGE, ...(page ? { offset: page * RUNS_PAGE } : {}) }));
    if (!reply) return page === 0 ? null : out;
    out.push(...reply.items);
    if (!reply.more) return out;
  }
  return out;
}

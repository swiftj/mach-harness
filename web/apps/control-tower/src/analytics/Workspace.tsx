/**
 * The Factory Analytics workspace as the Shell mounts it (M6.5.4, M6.5.6).
 *
 * It reads the store's Analytics state (`state.analytics`, which the address carries) and the source:
 * the Simulation reads the seeded fixture (`simulatedAnalytics`, labelled Simulated everywhere), live
 * and replay read the observer (`observerAnalytics`). A source and a provider that disagree are never
 * shown together (wire/query.ts `sourceCheck`).
 *
 * One snapshot per view (period, filters, "as of"): every area of the view reads at its cursor, and a
 * new period or filter keeps that cursor, so the figures of one view always describe one state of the
 * projection. A new head is read only when the person asks ("Refresh"), when the view begins, or when
 * the cursor can no longer be read. While live, a view whose edge has moved says it is not current.
 *
 * Every way out goes through the scene store: a row opens its entity in the Timeline (with the
 * interval it measured as the window) or on the floor; the Shell's address sync gives each such move a
 * history entry, so the browser's Back returns here with the same area, period, filters, pick and drawer.
 * Analytics never fetches an artifact: a verification or review row opens in the Timeline, whose
 * inspector holds the guarded access.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@mach/ui";
import type { ObserverClient } from "../live/observer";
import { showInTimeline, showOnFloor, useSceneStore, useStore } from "../scene";
import type { SceneStore } from "../scene/store";
import type { AnyRef, EntityRef } from "../sim/model";
import { useAnalyticsAsOf } from "../shell/analyticsAsOf";
import { useSource } from "../shell/source/context";
import type { AnalyticsSnapshot, ContributorPage } from "./contract";
import { toContractContributors } from "./data/adapt";
import { observerAnalytics } from "./data/observer";
import type { AnalyticsData } from "./data/provider";
import { simulatedAnalytics } from "./data/simulation";
import { shouldRefresh } from "./data/snapshot";
import type { InsightsReply } from "./data/types";
import { FIXTURE_END } from "./fixtures";
import type { RunConfigs } from "./model/cohorts";
import { clockText } from "./model/format";
import { capitalFirst, insightPopulation, insightRowsKey } from "./model/insights";
import type { AreaData, Interval, OpenWhere, RowsRequest } from "./ui/types";
import { AnalyticsView, type AnalyticsUiView } from "./ui/Workspace";
import { absenceState, failureState } from "./wire/load";
import { loadView, SharedCursor, ViewSession } from "./wire/views";
import { asOfWords, DAY_MS, listsGroupOf, listsRowsOf, filtersQuery, planFor, providerFor, sourceCheck, sourceWords, viewKey, windowQuery } from "./wire/query";
import { focusOfRowsKey, fromUiPatch, parseRowsKey, rowsOfFocus, toUiView, type RowsMemo } from "./wire/view";

/** One provider per store and client (a new store, a new source, gets a new one). */
const providers = new WeakMap<SceneStore, { client: ObserverClient | null; data: AnalyticsData | null }>();
function providerOf(store: SceneStore, client: ObserverClient | null): AnalyticsData | null {
  const found = providers.get(store);
  if (found && found.client === client) return found.data;
  const kind = providerFor(store.getState().source, client !== null);
  const data = kind === "simulation" ? simulatedAnalytics() : kind === "observer" && client ? observerAnalytics(client) : null;
  providers.set(store, { client, data });
  return data;
}

/** Per store: the drawers' words, and the cursor the views read at (kept across periods and filters). */
const memos = new WeakMap<SceneStore, { rows: RowsMemo; shared: SharedCursor }>();
function memoOf(store: SceneStore) {
  let m = memos.get(store);
  if (!m) memos.set(store, (m = { rows: new Map(), shared: new SharedCursor() }));
  return m;
}
/** The next view of this store reads the head (a refresh). */
function forgetCursor(store: SceneStore): void {
  memoOf(store).shared.forget();
}

interface Loaded {
  readonly key: string;
  readonly data: AreaData<AnalyticsSnapshot>;
  readonly insights: AreaData<InsightsReply> | undefined;
  readonly configs: RunConfigs | undefined;
  readonly cursor: string | null;
  readonly metricsExact: boolean | null;
  readonly widened: boolean;
  readonly dayCut: number | null;
  readonly notes: readonly string[];
}

/**
 * The drawer of an Improvement Opportunity named in the address: its own rows key, title and
 * population once the opportunities are read; until then the drawer waits (never the view's window).
 */
function insightRows(id: string, insights: AreaData<InsightsReply> | undefined, fallback: RowsRequest | null): RowsRequest {
  const f = insights?.state === "ready" ? insights.value.insights.find((x) => x.id === id) : undefined;
  const key = f ? insightRowsKey(f) : null;
  if (f && key) return { key, title: capitalFirst(f.title), unit: "count", population: insightPopulation(f), insight: f.id };
  const state: RowsRequest["pending"] = !insights || insights.state === "loading" ? "loading" : "gone";
  return { key: fallback?.key ?? "", title: fallback?.title ?? "Rows of an improvement opportunity", unit: fallback?.unit ?? "count", insight: id, pending: state };
}

/** The population a drawer lists over: an opportunity's own (last N runs, or its window), else the view's window. */
function rowsWindow(pop: RowsRequest["population"] | null, wq: { readonly fromMs: number | null; readonly toMs: number | null }): { fromMs: number | null; toMs: number | null; lastRuns?: number } {
  if (pop?.lastRuns) return { fromMs: null, toMs: null, lastRuns: pop.lastRuns };
  if (pop && (pop.fromMs !== null || pop.toMs !== null)) return { fromMs: pop.fromMs, toMs: pop.toMs };
  return { fromMs: wq.fromMs, toMs: wq.toMs };
}

/** A Timeline window around an interval, with a margin so the span is not flush with the edges. */
function framed(iv: Interval): Interval {
  const pad = Math.max(60_000, Math.round((iv.to - iv.from) * 0.05));
  return { from: iv.from - pad, to: iv.to + pad };
}

export function AnalyticsWorkspace() {
  const store = useStore();
  const { client = null } = useSource();
  const state = useSceneStore((s) => s.analytics);
  const sceneSource = useSceneStore((s) => s.source);
  const asOf = useAnalyticsAsOf();
  // The newest record's day (a preset ends with it); re-renders once a day, not per event.
  const newestDay = useSceneStore((s) => {
    const h = s.log.headTime();
    return h === null ? null : Math.floor(h / DAY_MS);
  });
  const headCursor = useSceneStore((s) => s.connection?.cursor ?? null);
  const data = providerOf(store, client);
  const check = sourceCheck(sceneSource, data?.source ?? null);
  const area = check.ok ? check.area : "live";

  const asOfMs = area === "simulation" ? null : asOf.toMs;
  const newestMs = newestDay === null ? null : newestDay * DAY_MS;
  const wq = data ? windowQuery(state.window, { provider: data.source, asOfMs, newestMs, fixtureEnd: FIXTURE_END }) : null;
  const key = data && wq ? viewKey(data.source, wq, state.filters, asOfMs) : "none";

  // The view's snapshot: a new one per view key, at the cursor the views read at; `refresh` asks the head again.
  const [refresh, setRefresh] = useState(0);
  const session = useMemo<ViewSession | null>(() => {
    if (!data) return null;
    void key;
    void refresh; // a refresh forgot the cursor first (forgetCursor)
    return new ViewSession(data, asOfMs, memoOf(store).shared);
    // A new period, filter, "as of" or refresh begins a new snapshot; nothing else does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key, refresh]);
  useEffect(() => () => session?.abort(), [session]);

  // The area's figures at the view's cursor.
  // An opportunity's rows open from the address need the opportunities read, whatever the area.
  const insightId = state.focus?.insight ?? null;
  const plan = useMemo(() => {
    const p = planFor(state.area, state.pick && { dim: state.pick.dim as never, value: state.pick.value });
    return insightId !== null && !p.insights ? { ...p, insights: true } : p;
  }, [state.area, state.pick, insightId]);
  const model = state.area === "economics" ? state.filters.model : null;
  const loadKey = `${key}|${newestDay ?? ""}|${refresh}|${state.area}|${state.pick ? `${state.pick.dim}:${state.pick.value}` : ""}|${model ?? ""}|${insightId !== null ? "i" : ""}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!session || !data || !wq || !wq.ok || !check.ok) return;
    let live = true;
    loadView(session, memoOf(store).shared, {
      data,
      source: check.area,
      plan,
      fromMs: wq.fromMs,
      toMs: wq.toMs,
      filters: filtersQuery(state.filters, false),
      model,
      contractFilters: { window: "all", risk: state.filters.risk, app_type: (state.filters.appType as never) ?? null, model: (model as never) ?? null },
      endMs: check.area === "simulation" ? FIXTURE_END : asOfMs ?? (newestMs !== null ? newestMs + DAY_MS : null),
    }).then(
      (r) => {
        if (!live) return;
        if (r.restart) {
          setRefresh((n) => n + 1);
          return;
        }
        setLoaded({ key: loadKey, data: r.data, insights: r.insights, configs: r.configs, cursor: r.cursor, metricsExact: r.asOf ? r.asOf.exact : null, widened: r.asOf?.widened ?? false, dayCut: r.dayCut ?? null, notes: r.notes });
      },
      (e: unknown) => {
        if (!live || (e instanceof DOMException && e.name === "AbortError")) return;
        setLoaded({ key: loadKey, data: failureState(e), insights: undefined, configs: undefined, cursor: null, metricsExact: null, widened: false, dayCut: null, notes: [] });
      },
    );
    return () => {
      live = false;
    };
    // loadKey names everything the load reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, session]);

  const current = loaded && loaded.key === loadKey ? loaded : null;
  // Live at the edge: once the stream's cursor has moved past the view's, the view says it is not current.
  const edgeMoved = area === "live" && asOf.through === "edge" && !!current?.cursor && shouldRefresh(current.cursor, headCursor, 0, 0);
  const areaData: AreaData<AnalyticsSnapshot> = !wq ? { state: "loading" } : !wq.ok ? { state: "unavailable", reason: wq.reason } : !current ? { state: "loading" } : current.data.state === "ready" && edgeMoved ? { ...current.data, stale: { reason: "New events have been recorded since these figures were read." } } : current.data;

  // The drawer: the store's focus, or one the store cannot hold (an insight's rows over several groups).
  const [override, setOverride] = useState<RowsRequest | null>(null);
  const snapshot = areaData.state === "ready" ? areaData.value : null;
  const focusRows = rowsOfFocus(state.focus, memoOf(store).rows, state.focus ? snapshot?.totals[state.focus.metric as keyof AnalyticsSnapshot["totals"]] : undefined);
  const rows = insightId !== null ? insightRows(insightId, current?.insights, focusRows) : (focusRows ?? override);
  const view = useMemo(() => toUiView(state, rows), [state, rows]);

  const [rowsData, setRowsData] = useState<{ key: string; data: AreaData<ContributorPage> } | null>(null);
  const rowsKey = rows && !rows.pending ? rows.key : null;
  // An opportunity's rows are listed over its own population (its last N runs, or its window), not the view's.
  const pop = rows?.population ?? null;
  const popKey = pop ? `${pop.lastRuns ?? ""}-${pop.fromMs ?? ""}-${pop.toMs ?? ""}` : "";
  useEffect(() => {
    if (!rowsKey || !session || !wq?.ok) return;
    const k = parseRowsKey(rowsKey);
    const tag = `${rowsKey}|${popKey}|${loadKey}`;
    if (!k || !listsRowsOf(data?.source ?? "observer", k.metric) || !listsGroupOf(data?.source ?? "observer", k.group)) return;
    let live = true;
    session
      .get()
      .then((x) => x.contributors({ ...rowsWindow(pop, wq), filters: filtersQuery(state.filters, false), metric: k.metric, ...(Object.keys(k.group).length ? { group: k.group } : {}), order: "impact", limit: 500 }))
      .then(
        (r) => live && setRowsData({ key: tag, data: r.status === "ok" ? { state: "ready", value: toContractContributors(r.value) } : absenceState(r) }),
        (e: unknown) => live && !(e instanceof DOMException && e.name === "AbortError") && setRowsData({ key: tag, data: failureState(e) }),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, popKey, loadKey, session]);
  const rowsFor = useCallback(
    (req: RowsRequest): AreaData<ContributorPage> =>
      req.pending === "loading"
        ? { state: "loading" }
        : req.pending === "gone"
          ? { state: "unavailable", reason: "This improvement opportunity does not hold in the current view, so its rows are not listed. Open Improvement opportunities to see the ones that do." }
          : !parseRowsKey(req.key)
        ? { state: "unavailable", reason: "These rows cannot be listed: the figure's key is not one the observer answers." }
        : !listsRowsOf(data?.source ?? "observer", parseRowsKey(req.key)!.metric)
          ? { state: "unavailable", reason: `This observer does not list the rows behind ${parseRowsKey(req.key)!.metric}; the figure itself is the recorded one.` }
          : !listsGroupOf(data?.source ?? "observer", parseRowsKey(req.key)!.group)
            ? { state: "unavailable", reason: "This observer lists rows by identifier only, and this group's code is not one; the figure itself is the recorded one." }
          : rowsData && rowsData.key === `${req.key}|${popKey}|${loadKey}` ? rowsData.data : { state: "loading" },
    [rowsData, loadKey, popKey, data],
  );

  const onView = useCallback(
    (p: Partial<AnalyticsUiView>) => {
      if (p.rows !== undefined) setOverride(p.rows && parseRowsKey(p.rows.key) && !focusOfRowsKey(p.rows.key) ? p.rows : null);
      store.setAnalyticsView(fromUiPatch(p, memoOf(store).rows));
    },
    [store],
  );
  const onOpen = useCallback(
    (ref: EntityRef, where: OpenWhere, interval?: Interval) => {
      if (where === "timeline") showInTimeline(store, ref, interval ? { window: framed(interval) } : undefined);
      else showOnFloor(store, undefined, { ref });
    },
    [store],
  );
  // Under the Simulation the fixture's tickets are not in the simulated run: their rows are not links.
  const canOpen = useMemo(() => (area === "simulation" ? (ref: string) => store.getState().log.entriesFor(ref as AnyRef).length > 0 : undefined), [area, store]);

  if (!check.ok || !data) {
    return (
      <div className="flex h-full items-center justify-center p-8" data-analytics-home="" tabIndex={-1}>
        <EmptyState title="No Factory Analytics for this source" description={check.ok ? "No observer answered for this source." : check.reason} />
      </div>
    );
  }

  const caption = asOfWords({ area, asOfMs, window: state.window, metricsExact: current?.metricsExact ?? null, widened: current?.widened ?? false, dayCut: current?.dayCut ?? null, cut: wq?.ok ? wq.cut : false }, clockText);
  return (
    <div className="flex h-full min-h-0 flex-col" data-analytics-home="" tabIndex={-1} data-analytics-cursor={current?.cursor ?? undefined} data-analytics-pending={current ? undefined : ""}>
      <div className="min-h-0 flex-1">
        <AnalyticsView
          data={areaData}
          {...(current?.insights ? { insights: current.insights } : {})}
          {...(current?.configs ? { configs: current.configs } : {})}
          source={area}
          asOf={caption}
          sourceLabel={sourceWords(area)}
          view={view}
          onView={onView}
          onOpen={onOpen}
          rowsFor={rowsFor}
          {...(canOpen ? { canOpen } : {})}
          notice={
            edgeMoved || (current && current.notes.length) ? (
              <div className="mb-6 flex max-w-[72ch] flex-wrap items-center gap-3 rounded-md border border-line bg-surface-sunken px-3 py-2 text-body-sm text-ink-muted" role="status">
                {edgeMoved ? (
                  <>
                    <span>New events have been recorded since these figures were read.</span>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-sm border border-line-control px-2 text-ink hover:bg-surface"
                      onClick={() => {
                        forgetCursor(store);
                        setRefresh((n) => n + 1);
                      }}
                      data-analytics-refresh=""
                    >
                      <RefreshCw size={12} aria-hidden="true" />
                      Refresh
                    </button>
                  </>
                ) : null}
                {current && current.notes.length ? (
                  <span data-analytics-notes={current.notes.length}>
                    Some figures in this view are not shown: {current.notes.join("; ")}.
                  </span>
                ) : null}
              </div>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

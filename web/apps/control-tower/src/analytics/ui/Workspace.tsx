/**
 * The Factory Analytics workspace: one bar of shared filters (period, risk, app type), the areas as
 * contextual navigation on the left, the sheet, and the Rows drawer listing the entities behind any
 * figure.
 *
 * `AnalyticsView` is controlled: its data, its view state and every way out (opening an entity,
 * changing the view) are the caller's. It fetches nothing and navigates nowhere. The Model control
 * lives in Economics alone: the caller loads Economics' data with the model and every other area's
 * without it.
 *
 * `AnalyticsWorkspace` is the prototype's uncontrolled wrapper (a `load` function over the simulated
 * fixture), kept so the Shell's bridge keeps working until it mounts `AnalyticsView` itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import { APP_TYPES, RISKS, type AnalyticsFilters, type AnalyticsSnapshot, type ContributorPage, type Model, type Station, type WindowKey } from "../contract";
import type { InsightsReply } from "../data/types";
import type { RunConfigs } from "../model/cohorts";
import type { AreaId } from "../model/findings";
import { clockText, dayText, windowText } from "../model/format";
import { simulatedInsights } from "../model/insights";
import { Compare } from "./areas/Compare";
import { Economics } from "./areas/Economics";
import { Flow } from "./areas/Flow";
import { Opportunities } from "./areas/Opportunities";
import { Pulse } from "./areas/Pulse";
import { Quality } from "./areas/Quality";
import { CanOpenRef, Rows } from "./areas/RefList";
import { Reliability } from "./areas/Reliability";
import type { AreaData, AreaSource, CompareChoice, Interval, OnOpen, Pick, RowsRequest, WindowChoice } from "./types";
import "./analytics.css";

export const AREAS: readonly { id: AreaId; label: string; question: string }[] = [
  { id: "pulse", label: "Factory Pulse", question: "How is the Factory doing?" },
  { id: "flow", label: "Flow and bottlenecks", question: "Where does time go?" },
  { id: "quality", label: "Quality and remediation", question: "What passes, what fails?" },
  { id: "economics", label: "Agent and model economics", question: "What was recorded as spent?" },
  { id: "reliability", label: "Reliability and autonomy", question: "How did executions end?" },
  { id: "compare", label: "Compare", question: "Two cohorts side by side" },
  { id: "opportunities", label: "Improvement opportunities", question: "What the rules found" },
];

/** The workspace's interface state (the Shell keeps it in the scene store and the address). */
export interface AnalyticsUiView {
  readonly area: AreaId;
  readonly window: WindowChoice;
  readonly risk: string | null;
  readonly appType: string | null;
  /** Read by Economics only. */
  readonly model: string | null;
  readonly station: Station | null;
  readonly pick: Pick | null;
  readonly compare: CompareChoice | null;
  readonly rows: RowsRequest | null;
}

export interface AnalyticsViewProps {
  /** The data for the area on screen (Economics' loaded with `view.model`, the others without it). */
  readonly data: AreaData<AnalyticsSnapshot>;
  readonly insights?: AreaData<InsightsReply>;
  readonly configs?: RunConfigs;
  readonly source: AreaSource;
  /** The moment the figures describe, as words. */
  readonly asOf: string;
  /** Where the figures come from, as words ("Live observer", "Simulated history, seed 6502"). */
  readonly sourceLabel: string;
  readonly view: AnalyticsUiView;
  readonly onView: (patch: Partial<AnalyticsUiView>) => void;
  readonly onOpen: OnOpen;
  /** The rows behind a figure when the snapshot does not carry them (live: a contributors query). */
  readonly rowsFor?: (req: RowsRequest) => AreaData<ContributorPage>;
  /** Where the history begins, for the whole-history caption; optional. */
  readonly historyFrom?: number;
  /** Whether a row's entity can be opened here (the Simulation's fixture tickets are not in its run); absent: every row opens. */
  readonly canOpen?: (ref: string) => boolean;
}

const WINDOWS: readonly { key: WindowKey; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "14d", label: "14 days" },
  { key: "28d", label: "28 days" },
  { key: "all", label: "Whole history" },
];

const sameWindow = (a: WindowChoice, b: WindowChoice) => (typeof a === "string" || typeof b === "string" ? a === b : a.from === b.from && a.to === b.to);

export function AnalyticsView({ data, insights, configs, source, asOf, sourceLabel, view, onView, onOpen, rowsFor, canOpen }: AnalyticsViewProps) {
  const sheet = useRef<HTMLElement>(null);
  const [undo, setUndo] = useState<WindowChoice | null>(null);
  // The control that opened the Rows drawer gets focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const onRows = useCallback(
    (r: RowsRequest) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onView({ rows: r });
    },
    [onView],
  );
  const closeRows = useCallback(() => {
    onView({ rows: null });
    const el = opener.current;
    opener.current = null;
    requestAnimationFrame(() => (el && el.isConnected ? el.focus() : sheet.current?.focus()));
  }, [onView]);
  const onArea = useCallback((area: AreaId, focus?: string) => {
    onView({
      area,
      rows: null,
      ...(area === "flow" && focus && focus !== "paths" ? { station: focus as Station } : {}),
      ...(area === "reliability" && focus?.startsWith("outcome:") ? { pick: { dim: "outcome" as const, value: focus.slice(8) } } : {}),
    });
    if (focus && !focus.includes(":")) requestAnimationFrame(() => document.getElementById(focus)?.scrollIntoView({ block: "start" }));
  }, [onView]);
  const onWindow = useCallback(
    (w: Interval) => {
      setUndo(view.window);
      onView({ window: w });
    },
    [onView, view.window],
  );
  const lastArea = useRef(view.area);
  useEffect(() => {
    if (lastArea.current !== view.area) sheet.current?.scrollTo({ top: 0 });
    lastArea.current = view.area;
  }, [view.area]);
  const area = AREAS.find((a) => a.id === view.area) ?? AREAS[0]!;
  const active = [view.risk, view.appType].filter(Boolean).length;
  const common = { data, source, asOf, onOpen, onRows, onArea, onWindow } as const;
  const snapshot = data.state === "ready" ? data.value : null;
  const ranged = typeof view.window !== "string" ? view.window : null;
  const rowsData: AreaData<ContributorPage> | null = view.rows ? (rowsFor ? rowsFor(view.rows) : snapshot ? { state: "ready", value: snapshot.contributors[view.rows.key] ?? { items: [], total: 0, order: "impact", truncated: false } } : { state: "loading" }) : null;

  return (
    <CanOpenRef.Provider value={canOpen ?? null}>
    <div className="an-root flex h-full min-h-0 flex-col" data-area={view.area}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-5 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-label text-ink">Factory Analytics</span>
          {source === "simulation" ? (
            <span className="an-simulated inline-flex h-6 items-center rounded-full border border-warning-line px-2.5 text-caption font-semibold text-warning-ink" data-simulated="">
              Simulated
            </span>
          ) : null}
          <span className="an-num min-w-0 truncate text-caption text-ink-muted" title={`${sourceLabel}. ${asOf}`}>
            {sourceLabel}. {snapshot ? `${windowText(snapshot.window.from_ms, snapshot.window.to_ms)}. ` : ""}
            {asOf}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3" role="group" aria-label="Filters for every area">
          {ranged ? (
            <span className="inline-flex h-7 items-center gap-2 rounded-sm border border-accent px-2 text-body-sm text-accent-ink" data-analytics-chip-window="">
              <span className="an-num font-semibold">
                {dayText(ranged.from)} – {dayText(ranged.to - 1)}
              </span>
              {undo !== null ? (
                <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => { onView({ window: undo }); setUndo(null); }}>
                  <Undo2 size={13} aria-hidden="true" />
                  Undo
                </button>
              ) : null}
            </span>
          ) : null}
          <div className="flex rounded-sm border border-line-control" role="radiogroup" aria-label="Period">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                role="radio"
                aria-checked={sameWindow(view.window, w.key)}
                onClick={() => {
                  if (!sameWindow(view.window, w.key)) setUndo(view.window);
                  onView({ window: w.key });
                }}
                className={`h-7 px-2.5 text-body-sm ${sameWindow(view.window, w.key) ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-muted hover:text-ink"}`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <FilterSelect label="Risk" value={view.risk} options={RISKS} onChange={(v) => onView({ risk: v })} />
          <FilterSelect label="App type" value={view.appType} options={APP_TYPES} onChange={(v) => onView({ appType: v })} />
          {active ? (
            <button type="button" className="an-link text-body-sm" onClick={() => onView({ risk: null, appType: null })}>
              Clear {active === 1 ? "filter" : `${active} filters`}
            </button>
          ) : null}
        </div>
      </div>

      <div className="an-layout relative min-h-0" data-drill={view.rows ? "open" : "closed"}>
        <nav aria-label="Analytics areas" className="overflow-y-auto border-r border-line bg-surface-nav py-3">
          <ul>
            {AREAS.map((a) => {
              const cur = a.id === view.area;
              return (
                <li key={a.id}>
                  <button type="button" aria-current={cur ? "page" : undefined} onClick={() => onArea(a.id)} className={`relative block w-full px-4 py-2 text-left ${cur ? "bg-accent-soft" : "hover:bg-surface-sunken"} ${a.id === "compare" ? "mt-3 border-t border-line pt-3" : ""}`}>
                    {cur ? <span className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-accent" aria-hidden="true" /> : null}
                    <span className={`block text-body-sm ${cur ? "font-semibold text-accent-ink" : "text-ink"}`}>{a.label}</span>
                    <span className="block text-caption text-ink-subtle">{a.question}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <main ref={sheet} className="an-sheet focus:outline-none" aria-label={area.label} tabIndex={-1}>
          <div className="an-sheet-inner">
            {view.area === "pulse" ? <Pulse {...common} insights={insights} /> : null}
            {view.area === "flow" ? <Flow {...common} station={view.station} onStation={(st) => onView({ station: st })} /> : null}
            {view.area === "quality" ? <Quality {...common} pick={view.pick} onPick={(p) => onView({ pick: p })} /> : null}
            {view.area === "economics" ? <Economics {...common} model={view.model} onModel={(m) => onView({ model: m })} /> : null}
            {view.area === "reliability" ? <Reliability {...common} pick={view.pick} onPick={(p) => onView({ pick: p })} /> : null}
            {view.area === "compare" ? <Compare {...common} configs={configs} compare={view.compare} onCompare={(c) => onView({ compare: c })} /> : null}
            {view.area === "opportunities" ? <Opportunities {...common} insights={insights} /> : null}
          </div>
        </main>

        {view.rows && rowsData ? <Rows key={view.rows.key} req={view.rows} data={rowsData} onClose={closeRows} onOpen={onOpen} /> : null}
      </div>
    </div>
    </CanOpenRef.Provider>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | null; options: readonly string[]; onChange(v: string | null): void }) {
  return (
    <label className="flex items-center gap-1.5 text-body-sm text-ink-muted">
      {label}
      <select className={`h-7 rounded-sm border bg-surface px-1.5 text-body-sm ${value ? "border-accent text-accent-ink" : "border-line-control text-ink"}`} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// ------------------------------------------------------------------------- the prototype's wrapper

export interface WorkspaceState {
  readonly area: AreaId;
  readonly filters: AnalyticsFilters;
  readonly station: Station | null;
  readonly drill: RowsRequest | null;
  readonly pick?: Pick | null;
  readonly compare?: CompareChoice | null;
}

/** The prototype's uncontrolled workspace over a `load` function (the simulated fixture). */
export function AnalyticsWorkspace({ load, initial, onState, sourceLabel }: { load(f: AnalyticsFilters): AnalyticsSnapshot; initial: WorkspaceState; onState?(s: WorkspaceState): void; sourceLabel: string }) {
  const [state, setState] = useState<WorkspaceState>(initial);
  useEffect(() => onState?.(state), [state, onState]);
  const filters = useMemo<AnalyticsFilters>(() => ({ ...state.filters, model: state.area === "economics" ? state.filters.model : null }), [state.filters, state.area]);
  const snapshot = useMemo(() => load(filters), [load, filters]);
  const insights = useMemo<AreaData<InsightsReply>>(() => ({ state: "ready", value: simulatedInsights(load({ ...filters, model: null })) }), [load, filters]);
  const view: AnalyticsUiView = { area: state.area, window: state.filters.window, risk: state.filters.risk, appType: state.filters.app_type, model: state.filters.model, station: state.station, pick: state.pick ?? null, compare: state.compare ?? null, rows: state.drill };
  const onView = useCallback((p: Partial<AnalyticsUiView>) => {
    setState((s) => {
      const w = p.window;
      return {
        area: p.area ?? s.area,
        filters: {
          window: w !== undefined && typeof w === "string" ? w : s.filters.window,
          risk: p.risk !== undefined ? (p.risk as AnalyticsFilters["risk"]) : s.filters.risk,
          app_type: p.appType !== undefined ? (p.appType as AnalyticsFilters["app_type"]) : s.filters.app_type,
          model: p.model !== undefined ? (p.model as Model | null) : s.filters.model,
        },
        station: p.station !== undefined ? p.station : s.station,
        drill: p.rows !== undefined ? p.rows : s.drill,
        pick: p.pick !== undefined ? p.pick : (s.pick ?? null),
        compare: p.compare !== undefined ? p.compare : (s.compare ?? null),
      };
    });
  }, []);
  return <AnalyticsView data={{ state: "ready", value: snapshot }} insights={insights} source="simulation" asOf={`As of ${clockText(snapshot.generated_at_ms)}`} sourceLabel={sourceLabel} view={view} onView={onView} onOpen={() => undefined} />;
}

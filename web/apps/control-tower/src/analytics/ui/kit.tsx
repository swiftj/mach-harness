/**
 * The workspace's small parts: the area frame that turns a load state into words, the readout every
 * number wears (value, definition, sample, coverage, basis, the rows behind it), the chart frame
 * (title, question, accessible summary, a table instead of the chart), marks that take one Tab stop
 * per chart and move with the arrow keys, the hover and focus card, chips, and the not-recorded state.
 */
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Popover, PopoverContent, PopoverTrigger, Spinner } from "@mach/ui";
import { ChartColumn, Info, Rows3, Table2, X } from "lucide-react";
import type { AnalyticsSnapshot, MetricRow } from "../contract";
import type { AreaId } from "../model/findings";
import { BASIS_WORDS, coverageText, durationText, p50Text, p90Text, sampleText, targetText, valueText, windowText } from "../model/format";
import { densityOf, durationShows, verdictAllowed, type Density } from "../model/sample";
import { nextMark } from "../model/series";
import { chartKey } from "./keys";
import { useRemembered } from "./remember";
import { dayCutTag, lastWholeDay } from "../wire/query";
import { HISTORY_SUSPECT_WORDS, historyWords } from "../wire/history";
import { spoken } from "./charts/a11y";
import type { AreaData, AreaSource, Interval, OnOpen, RowsRequest } from "./types";

/** Kept for the prototype's callers. */
export type DrillRequest = RowsRequest;

// ------------------------------------------------------------------------------------- context

export interface AnalyticsCtx {
  readonly snapshot: AnalyticsSnapshot;
  readonly source: AreaSource;
  readonly asOf: string;
  readonly density: Density;
  readonly open: OnOpen;
  readonly rows?: ((r: RowsRequest) => void) | undefined;
  readonly area?: ((a: AreaId, focus?: string) => void) | undefined;
  readonly window?: ((w: Interval) => void) | undefined;
}
export const Ctx = createContext<AnalyticsCtx | null>(null);
export function useAnalytics(): AnalyticsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAnalytics outside an area");
  return v;
}

// ------------------------------------------------------------------------------------- width

export function useWidth<T extends HTMLElement>(fallback = 600, min = 120): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(min, Math.floor(el.getBoundingClientRect().width)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

// ------------------------------------------------------------------------------------ area frame

const SOURCE_WORDS: Readonly<Record<AreaSource, string>> = { simulation: "simulated", live: "live", replay: "replay" };

/**
 * One area: its heading and introduction always; below them the figures when the data is ready, or
 * what the load state is in words. An error says what the observer answered; stale figures are shown
 * under a note saying so.
 */
export function AreaFrame({ id, title, intro, props, children, aside }: { id: AreaId; title: string; intro: ReactNode; props: { data: AreaData<AnalyticsSnapshot>; source: AreaSource; asOf: string; onOpen: OnOpen; onRows?: ((r: RowsRequest) => void) | undefined; onArea?: ((a: AreaId, f?: string) => void) | undefined; onWindow?: ((w: Interval) => void) | undefined }; children: () => ReactNode; aside?: ReactNode }) {
  const d = props.data;
  const snapshot = d.state === "ready" ? d.value : null;
  const ctx = useMemo<AnalyticsCtx | null>(() => (snapshot ? { snapshot, source: props.source, asOf: props.asOf, density: densityOf(snapshot), open: props.onOpen, rows: props.onRows, area: props.onArea, window: props.onWindow } : null), [snapshot, props.source, props.asOf, props.onOpen, props.onRows, props.onArea, props.onWindow]);
  const w = snapshot?.window;
  return (
    <section className="an-area flex flex-col gap-8" data-analytics-area={id} data-analytics-source={SOURCE_WORDS[props.source]} data-analytics-ready={d.state === "ready" ? "" : undefined} data-analytics-state={d.state} data-analytics-window={w ? `${w.from_ms}-${w.to_ms}` : undefined} aria-labelledby={`an-${id}-h`} aria-busy={d.state === "loading" || undefined}>
      <header className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 id={`an-${id}-h`} className="text-title-1 text-ink">
            {title}
          </h1>
          {intro ? <div className="an-intro mt-1.5 max-w-[68ch] text-body text-ink-muted">{intro}</div> : null}
        </div>
        {aside}
      </header>
      {snapshot?.history ? <HistoryLine history={snapshot.history} /> : null}
      {snapshot?.no_whole_day ? (
        <p className="max-w-[72ch] rounded-md border border-line bg-surface-sunken px-3 py-2 text-body-sm text-ink-muted" role="note" data-no-whole-day="">
          <span className="font-semibold text-ink">No whole UTC day before the playhead.</span> Figures counted by whole UTC days have nothing to count yet; that is not the same as nothing recorded. The flow drawing and the rows behind a figure run to the playhead.
        </p>
      ) : null}
      {d.state === "ready" && d.stale ? (
        <p className="an-stale flex items-start gap-2 rounded-md border border-line px-3 py-2 text-body-sm text-ink-muted" role="status" data-state="stale">
          <span className="font-semibold text-ink">Not current.</span> {d.stale.reason} The figures below are as they were; {props.asOf.charAt(0).toLowerCase() + props.asOf.slice(1)}.
        </p>
      ) : null}
      {d.state === "loading" ? (
        <div className="flex items-center gap-3 py-10 text-body text-ink-muted" role="status">
          <Spinner size="sm" />
          Reading the figures for this window from the {props.source === "simulation" ? "simulated history" : "observer"}.
        </div>
      ) : d.state === "error" ? (
        <div className="max-w-[72ch] rounded-md border border-danger-line bg-danger-soft px-4 py-3" role="alert" data-state="error">
          <p className="text-label text-danger-ink">{d.status !== null ? `The observer answered ${d.status}: ${d.reason}` : `The observer did not answer: ${d.reason}`}</p>
          <p className="mt-1 text-body-sm text-ink">Nothing in this area is shown in place of the answer. Change the window or filters, or try again once the observer is reachable.</p>
        </div>
      ) : d.state === "unavailable" ? (
        <NotRecorded title="Not available from this source" what={d.reason} why="Nothing is drawn in its place: a missing figure is not a zero." state="unavailable" />
      ) : ctx ? (
        <Ctx.Provider value={ctx}>{children()}</Ctx.Provider>
      ) : null}
    </section>
  );
}

/**
 * M6.6 (I-03): incomplete history over the figures of this area, in the Timeline's words for a gap
 * ("History is missing here"): the observer's partial reason, each gap's time and class, and the UTC
 * days it marks suspect. Nothing when the history is complete.
 */
function HistoryLine({ history }: { history: NonNullable<AnalyticsSnapshot["history"]> }) {
  const w = historyWords(history);
  if (!w) return null;
  return (
    <div className="an-history flex max-w-[72ch] items-start gap-2 rounded-md border border-dashed border-line-strong px-3 py-2 text-body-sm text-ink-muted" data-history-incomplete="" role="note" aria-label="Incomplete history">
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 10 10" className="mt-1 shrink-0">
        <path d="M1 5H3.4M6.6 5H9" style={{ stroke: "currentColor", strokeWidth: 1.4 }} />
        <path d="M4.2 2.5L5.8 7.5" style={{ stroke: "currentColor", strokeWidth: 1.2 }} />
      </svg>
      <p>
        <span className="font-semibold text-ink">{w.title}</span> {w.body}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------------------------ definition

/** The catalog's definition of a row in a popover: formula, source and authority, limitations, availability. */
export function Definition({ row, children, label }: { row: MetricRow; children?: ReactNode; label?: string | undefined }) {
  const { snapshot } = useAnalytics();
  const shownAs = label && label !== row.name ? label : null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        {children ? (
          // The name is the visible figure followed by what it is (label in name, WCAG 2.5.3).
          <button type="button" className="an-figure-word">
            {children}
            <span className="sr-only">{`, ${label ?? row.name}: definition`}</span>
          </button>
        ) : (
          <button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-sunken hover:text-ink" aria-label={`Definition of ${label ?? row.name}`}>
            <Info size={14} aria-hidden="true" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0">
        <div className="border-b border-line px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="an-mono rounded-xs bg-surface-sunken px-1 text-caption text-ink-muted" translate="no">
              {row.id}
            </span>
            <span className="text-label">{row.name}</span>
          </div>
          {shownAs ? <p className="mt-0.5 text-caption text-ink-subtle">Shown here as “{shownAs}”; the catalog's name and meaning are unchanged.</p> : null}
        </div>
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-body-sm">
          <dt className="text-ink-muted">Counts</dt>
          <dd>{row.numerator || "–"}</dd>
          <dt className="text-ink-muted">Over</dt>
          <dd>{row.denominator || "–"}</dd>
          <dt className="text-ink-muted">Source</dt>
          <dd>
            {row.source}
            {row.authority ? <span className="text-ink-subtle"> ({row.authority})</span> : null}
          </dd>
          <dt className="text-ink-muted">Known as</dt>
          <dd>{BASIS_WORDS[row.basis]}</dd>
          <dt className="text-ink-muted">Sample</dt>
          <dd className="an-num">{row.value === null && row.denominator_value === null ? "none" : sampleText(row)}</dd>
          <dt className="text-ink-muted">Coverage</dt>
          <dd className="an-num">
            {coverageText(row.coverage)}
            {(row.coverage.excluded ?? []).map((x) => (
              <div key={x.reason} className="text-caption text-ink-subtle">
                {x.count} left out: {x.reason}
              </div>
            ))}
          </dd>
          {row.basis_counts ? (
            <>
              <dt className="text-ink-muted">Members</dt>
              <dd className="an-num">
                {Object.entries(row.basis_counts)
                  .filter(([, n]) => n)
                  .map(([k, n]) => `${n} ${k.replace("_", " ")}`)
                  .join(", ") || "none"}
              </dd>
            </>
          ) : null}
          {row.kind === "duration" && row.value !== null ? (
            <>
              <dt className="text-ink-muted">Mean</dt>
              <dd className="an-num">{durationText(row.value)} (the catalog's value; the median leads because durations are skewed)</dd>
            </>
          ) : null}
          {row.p50_ms !== undefined ? (
            <>
              <dt className="text-ink-muted">Percentiles</dt>
              <dd className="an-num">
                {row.percentile_basis === "histogram"
                  ? `read inside log-histogram buckets, so each is about: median between ${row.p50_bounds_ms ? `${durationText(row.p50_bounds_ms[0])} and ${durationText(row.p50_bounds_ms[1])}` : "its bucket's bounds"}${row.p90_bounds_ms ? `, 90th between ${durationText(row.p90_bounds_ms[0])} and ${durationText(row.p90_bounds_ms[1])}` : ""}`
                  : row.percentile_basis === "exact"
                    ? "exact: nearest rank over every measured value"
                    : "basis not stated by this observer"}
              </dd>
            </>
          ) : null}
          {row.as_of && !row.as_of.exact && row.as_of.effective_to_ms !== null ? (
            <>
              <dt className="text-ink-muted">Counted to</dt>
              <dd className="an-num">The end of {lastWholeDay(row.as_of.effective_to_ms)} (UTC): whole UTC days before the playhead; the playhead's own day is not in this figure</dd>
            </>
          ) : null}
          {row.status === "partial" ? (
            <>
              <dt className="text-ink-muted">In part</dt>
              <dd>{row.status_reason}</dd>
            </>
          ) : null}
          <dt className="text-ink-muted">Window</dt>
          <dd className="an-num">{windowText(snapshot.window.from_ms, snapshot.window.to_ms)}</dd>
          {row.target ? (
            <>
              <dt className="text-ink-muted">Target</dt>
              <dd>
                {targetText(row.target, row.kind)} <span className="text-ink-subtle">(observe station)</span>
              </dd>
            </>
          ) : null}
          {row.limitations ? (
            <>
              <dt className="text-ink-muted">Limits</dt>
              <dd>{row.limitations}</dd>
            </>
          ) : null}
          {row.null_reason ? (
            <>
              <dt className="text-ink-muted">No value</dt>
              <dd>{row.null_reason}</dd>
            </>
          ) : null}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

// --------------------------------------------------------------------------------------- readout

/** The words beside a value that compares it with its target, only when the sample allows a verdict. */
export function verdictWords(row: MetricRow): { readonly text: string; readonly tone: "meets" | "misses" | "quiet" } | null {
  if (!row.target || row.value === null) return null;
  if (!verdictAllowed(row.denominator_value) || row.met === undefined) return { text: `target ${targetText(row.target, row.kind)}; too few to judge`, tone: "quiet" };
  return row.met ? { text: `meets ${targetText(row.target, row.kind)}`, tone: "meets" } : { text: `misses ${targetText(row.target, row.kind)}`, tone: "misses" };
}

/** The headline a row shows: for a duration the median (or the one value), else its value in its unit. */
export function headline(row: MetricRow): { readonly text: string | null; readonly lead: string | null; readonly raw: number | null } {
  if (row.kind === "duration" || row.unit === "ms") {
    const n = row.denominator_value;
    const shows = durationShows(n);
    if (row.value === null) return { text: null, lead: null, raw: null };
    if (shows.single) return { text: durationText(row.value), lead: "the one measured", raw: row.value };
    if (row.p50_ms !== undefined) return { text: p50Text(row), lead: "median", raw: row.p50_ms };
    return { text: durationText(row.value), lead: "mean", raw: row.value };
  }
  return { text: valueText(row), lead: null, raw: row.value };
}

/**
 * One number as Analytics shows it: the value (or why there is none), what it is, and a quiet line
 * of provenance: sample, coverage, basis; for a duration the catalog's mean beside the median. The
 * definition and the rows are one keystroke away.
 */
export function Readout({ row, label, drill, size = "md", note }: { row: MetricRow | undefined; label?: string; drill?: RowsRequest; size?: "lg" | "md" | "sm"; note?: ReactNode }) {
  const { rows: open } = useAnalytics();
  if (!row) return null;
  const h = headline(row);
  const missing = rowMissing(row);
  const isDuration = (row.kind === "duration" || row.unit === "ms") && h.text !== null;
  const shows = durationShows(row.denominator_value);
  const verdict = verdictWords(row);
  return (
    <div className="min-w-0" data-readout={row.id} data-value={h.raw ?? undefined} data-state={missing ? stateOf(row) : undefined}>
      <div className="flex items-start gap-1 text-body-sm text-ink-muted">
        <span className="min-w-0 pt-0.5">{label ?? row.name}</span>
        <Definition row={row} label={label} />
      </div>
      {h.text !== null && !missing ? (
        <div className={`an-fig leading-none text-ink ${size === "lg" ? "text-[32px]" : size === "md" ? "text-[24px]" : "text-[19px]"}`}>
          {h.lead ? <span className="mr-1.5 align-middle text-caption font-normal text-ink-subtle">{h.lead}</span> : null}
          {h.text}
          {verdict ? <span className={`ml-2 align-middle text-caption font-normal ${verdict.tone === "meets" ? "text-success-ink" : verdict.tone === "misses" ? "text-warning-ink" : "text-ink-subtle"}`}>{verdict.text}</span> : null}
        </div>
      ) : (
        <div className={`leading-tight text-ink-muted ${size === "lg" ? "text-title-3" : "text-body"}`}>{missing?.title ?? "No value"}</div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-ink-subtle">
        {h.text !== null && !missing ? <span className="an-num">n {sampleText(row)}</span> : <span>{(row.null_reason ?? missing?.why ?? "").replace(/^not (recorded|available):\s*/, "")}</span>}
        {isDuration && shows.mean && h.lead === "median" ? <span className="an-num">mean {durationText(row.value)}</span> : null}
        {isDuration && shows.p90 && row.p90_ms !== undefined ? <span className="an-num">90th {p90Text(row)}</span> : null}
        {row.coverage.share !== null && row.coverage.share < 1 ? <span className="an-num">coverage {coverageText(row.coverage)}</span> : null}
        {row.basis !== "measured" && h.text !== null && !missing ? <span>{BASIS_WORDS[row.basis]}</span> : null}
        {/* M6.6 (I-08): counted by whole UTC days under a playhead: the figure says its last day itself, so it never reads as the playhead's moment. */}
        {row.as_of && !row.as_of.exact && row.as_of.effective_to_ms !== null && h.text !== null && !missing ? (
          <span className="an-num" data-day-cut="" title={`Counted through the end of ${lastWholeDay(row.as_of.effective_to_ms)} (UTC), the last whole day before the playhead; the playhead's own day is not in this figure.`}>
            {dayCutTag(row.as_of.effective_to_ms)}
          </span>
        ) : null}
        {/* M6.6 (I-03): history in this window is incomplete (a gap in the observer's record): said where the figure is. */}
        {row.suspect && h.text !== null && !missing ? (
          <span data-history-suspect="" title={HISTORY_SUSPECT_WORDS}>
            history incomplete here
          </span>
        ) : null}
        {note}
        {drill && open && h.text !== null && !missing ? (
          <button type="button" className="an-link inline-flex items-center gap-1" onClick={() => open(drill)}>
            <Rows3 size={12} aria-hidden="true" />
            Rows
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- frame

export interface TableSpec {
  readonly columns: readonly { readonly label: string; readonly num?: boolean }[];
  readonly rows: readonly (readonly ReactNode[])[];
}

/** The state a row without a value is in, for `data-state`. */
export function stateOf(row: MetricRow | undefined): "not-recorded" | "unavailable" | "deferred" {
  if (!row) return "unavailable";
  if (row.status === "unavailable") return "unavailable";
  if (row.status === "deferred") return "deferred";
  return "not-recorded";
}

/** Why a row has nothing to draw: not recorded, not computed yet, or not answerable under the filters. Null when it has. */
export function rowMissing(row: MetricRow | undefined): { readonly title: string; readonly why: string } | null {
  if (!row) return { title: "Not served", why: "This observer returned no row for the metric." };
  const why = (row.status_reason ?? row.null_reason ?? "").replace(/^not (recorded|available):\s*/, "");
  if (row.status === "unavailable") return { title: "Not available with these filters", why: `${row.name}: ${why.replace(/\.$/, "")}.` };
  if (row.status === "deferred") return { title: "Not computed yet", why: `${row.name}: ${why}.` };
  if (row.status === "not-recorded" || row.basis === "not-recorded") return { title: "Not recorded", why: `${row.name}: ${why}.` };
  return null;
}

/**
 * A chart with its question, an accessible summary, and a table instead of the chart. `requires`
 * replaces the chart with the reason when a row it draws has nothing to give.
 */
export function ChartFrame({ chart, title, question, summary, table, actions, children, id, foot, requires, chips, size = "md", targetEquivalent }: { chart: string; title: string; question?: ReactNode; summary: string; table?: TableSpec; actions?: ReactNode; children: ReactNode; id?: string; foot?: ReactNode; requires?: readonly (MetricRow | undefined)[]; chips?: ReactNode; size?: "md" | "sm"; targetEquivalent?: string }) {
  const [asTable, setAsTable] = useRemembered(`table:${chart}`, false);
  const sid = useId();
  const missingRow = (requires ?? []).find((r) => rowMissing(r) !== null);
  const missing = missingRow !== undefined || (requires ?? []).some((r) => !r) ? rowMissing(missingRow) : null;
  if (missing)
    return (
      <figure className="m-0 min-w-0" id={id} data-chart={chart} aria-labelledby={`${sid}-t`}>
        <h3 id={`${sid}-t`} className="mb-2 text-label text-ink">
          {title}
        </h3>
        <NotRecorded title={missing.title} what={missing.why} why="Nothing is drawn in its place: a missing figure is not a zero." compact state={stateOf(missingRow)} />
      </figure>
    );
  return (
    <figure className="m-0 min-w-0" aria-labelledby={`${sid}-t`} aria-describedby={`${sid}-s`} id={id} data-chart={chart} data-target-equivalent={targetEquivalent}>
      <div className="mb-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={`${sid}-t`} className={size === "sm" ? "text-caption text-ink-muted" : "text-label text-ink"}>
            {title}
          </h3>
          {question ? <p className="text-caption text-ink-muted">{question}</p> : null}
        </div>
        <div className={`flex shrink-0 items-center gap-1 ${size === "sm" ? "-mt-1.5" : ""}`}>
          {actions}
          {table ? (
            <button type="button" className="inline-flex h-7 items-center gap-1 rounded-sm px-1.5 text-caption text-ink-muted hover:bg-surface-sunken hover:text-ink" aria-pressed={asTable} data-chart-exit="" onClick={() => setAsTable((x) => !x)}>
              {asTable ? <ChartColumn size={13} aria-hidden="true" /> : <Table2 size={13} aria-hidden="true" />}
              {asTable ? "Chart" : "Table"}
            </button>
          ) : null}
        </div>
      </div>
      {chips ? <div className="mb-2 flex flex-wrap gap-2">{chips}</div> : null}
      <p id={`${sid}-s`} className="sr-only">
        {spoken(summary)}
      </p>
      {asTable && table ? <DataTable spec={table} caption={title} /> : children}
      {foot ? <figcaption className="mt-2 text-caption text-ink-subtle">{foot}</figcaption> : null}
    </figure>
  );
}

export function DataTable({ spec, caption }: { spec: TableSpec; caption: string }) {
  return (
    // A scrolling region must take focus so it can be scrolled from the keyboard (axe scrollable-region-focusable).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="an-table-region max-h-80 overflow-auto" role="region" aria-label={`${caption}, as a table`} tabIndex={0}>
      <table className="an-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {spec.columns.map((c, i) => (
              <th key={i} scope="col" className={c.num ? "num" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) =>
                // The first cell names the row (a day, a station, a ticket): a row header for screen readers.
                j === 0 ? (
                  <th key={j} scope="row" className={spec.columns[j]?.num ? "num" : undefined}>
                    {cell}
                  </th>
                ) : (
                  <td key={j} className={spec.columns[j]?.num ? "num" : undefined}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ tips

/** The hover and focus card: a title and exact values, row by row. */
export interface Card {
  readonly title: string;
  readonly rows?: readonly (readonly [string, string])[];
  readonly foot?: string;
}
export interface TipState {
  readonly x: number;
  readonly y: number;
  readonly card: Card;
}

/** A hover and focus card anchored in the chart's own box, kept inside it. */
export function useTip(width?: number): [TipState | null, (t: TipState | null) => void, ReactNode] {
  const [tip, setTip] = useState<TipState | null>(null);
  let node: ReactNode = null;
  if (tip) {
    const W = 240;
    const half = W / 2;
    const left = width === undefined ? tip.x : Math.max(Math.min(half, width / 2), Math.min(Math.max(width - half, width / 2), tip.x));
    node = (
      <div className="an-tip" style={{ left, top: tip.y, width: W, transform: "translate(-50%, calc(-100% - 8px))" }} role="presentation">
        <div className="font-semibold">{tip.card.title}</div>
        {tip.card.rows?.length ? (
          <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
            {tip.card.rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="opacity-75">{k}</dt>
                <dd className="an-num text-right">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {tip.card.foot ? <div className="mt-1 opacity-75">{tip.card.foot}</div> : null}
      </div>
    );
  }
  return [tip, setTip, node];
}

/** Words for assistive technology from a card. */
export const cardWords = (c: Card): string => [c.title, ...(c.rows ?? []).map(([k, v]) => `${k} ${v}`), c.foot ?? ""].filter(Boolean).join(". ");

// ---------------------------------------------------------------------------------- keyboard marks

/**
 * One Tab stop per chart: the active mark is tabbable, the arrows move between marks, Home and End
 * jump, Enter and Space activate. `cols` lays marks out as a grid.
 */
export interface MarkNav {
  readonly active: number;
  readonly tabIndex: (i: number) => 0 | -1;
  readonly register: (i: number) => (el: SVGGElement | HTMLElement | null) => void;
  readonly onKey: (i: number, e: KeyboardEvent) => boolean;
  readonly focusAt: (i: number) => void;
}
export function useMarkNav(n: number, cols = 1): MarkNav {
  const [active, setActive] = useState(0);
  const els = useRef(new Map<number, SVGGElement | HTMLElement>());
  const a = Math.max(0, Math.min(n - 1, active));
  const focusAt = useCallback((i: number) => {
    setActive(i);
    els.current.get(i)?.focus();
  }, []);
  const register = useCallback(
    (i: number) => (el: SVGGElement | HTMLElement | null) => {
      if (el) els.current.set(i, el);
      else els.current.delete(i);
    },
    [],
  );
  const onKey = useCallback(
    (i: number, e: KeyboardEvent) => {
      const next = nextMark(i, e.key, n, cols);
      if (next === null) return false;
      e.preventDefault();
      focusAt(next);
      return true;
    },
    [n, cols, focusAt],
  );
  return { active: a, tabIndex: (i) => (i === a ? 0 : -1), register, onKey, focusAt };
}

/**
 * A focusable, activatable SVG mark: a hit area larger than the drawing, a focus ring, a name for
 * assistive technology, and the card on hover or focus. With `nav`, only the chart's active mark is
 * in the Tab order.
 */
export function Mark({ name, x, y, w, h, tipAt, card, onTip, onActivate, pressed, children, nav, index = 0, onKeyExtra, overlay }: { overlay?: ReactNode; name?: string; x: number; y: number; w: number; h: number; tipAt: { x: number; y: number }; card: Card; onTip(t: TipState | null): void; onActivate?: (() => void) | undefined; pressed?: boolean | undefined; children: ReactNode; nav?: MarkNav; index?: number; onKeyExtra?: (e: KeyboardEvent) => boolean }) {
  const show = () => onTip({ ...tipAt, card });
  const hide = () => onTip(null);
  const label = name ?? cardWords(card);
  return (
    // The mark's name carries every value it draws, spoken as words, and begins with its visible
    // label. Its written words (`overlay`) are drawn over it, outside the control and hidden from
    // assistive technology, so nothing is read twice and pointer events pass through to the mark.
    <>
      <g
        ref={nav ? nav.register(index) : undefined}
        className="an-mark"
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        role={onActivate ? "button" : "img"}
        tabIndex={nav ? nav.tabIndex(index) : onActivate ? 0 : -1}
        aria-label={spoken(label)}
        aria-pressed={onActivate ? pressed : undefined}
        onClick={onActivate}
        onKeyDown={(e) => {
          // The chart keeps its keys: Space or an arrow on a mark never reaches the shell's shortcuts.
          const k = chartKey(e.key, !!onActivate, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
          if (k.stop) e.stopPropagation();
          if (onKeyExtra?.(e)) return;
          if (nav?.onKey(index, e)) return;
          if (e.key === "Escape") {
            // Escape leaves the chart: focus goes to the chart's own Table control (or the figure).
            const fig = (e.currentTarget as Element).closest("figure");
            const exit = fig?.querySelector<HTMLElement>("[data-chart-exit]");
            if (exit || fig) {
              e.preventDefault();
              e.stopPropagation();
              onTip(null);
              (exit ?? (fig as HTMLElement)).focus();
            }
            return;
          }
          if (k.prevent) e.preventDefault();
          if (k.activate) onActivate?.();
        }}
      >
        <g aria-hidden="true">{children}</g>
        <rect className="an-hit" x={x - 2} y={y - 2} width={Math.max(6, w + 4)} height={Math.max(6, h + 4)} />
        <rect className="an-ring" x={x - 2} y={y - 2} width={Math.max(6, w + 4)} height={Math.max(6, h + 4)} rx={3} />
      </g>
      {overlay ? (
        <g aria-hidden="true" style={{ pointerEvents: "none" }}>
          {overlay}
        </g>
      ) : null}
    </>
  );
}

/**
 * A polite announcement that speaks when `on` (a selection) changes, never when the data under it
 * refreshes: the words are taken at the moment of the change and held until the next one.
 */
export function Announce({ on, children }: { on: string | null; children: string }) {
  const [said, setSaid] = useState<{ on: string | null; text: string }>({ on, text: "" });
  if (said.on !== on) setSaid({ on, text: on === null ? "" : children });
  return (
    <p className="sr-only" role="status">
      {said.text}
    </p>
  );
}

/**
 * Keeps Tab inside `box` while it is open: from the last tabbable control Tab goes to the first, and
 * Shift+Tab from the first (or from the box itself) to the last.
 */
export function trapTab(e: KeyboardEvent, box: HTMLElement | null): void {
  if (e.key !== "Tab" || !box) return;
  const all = [...box.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
  if (all.length === 0) {
    e.preventDefault();
    return;
  }
  const first = all[0]!;
  const last = all[all.length - 1]!;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || at === box)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

// ------------------------------------------------------------------------------------------ chips

/** A cross-filter in force, as a button that removes it. */
export function Chip({ label, value, onRemove }: { label: string; value: string; onRemove(): void }) {
  return (
    <button type="button" data-analytics-chip="" onClick={onRemove} className="an-chip inline-flex h-7 items-center gap-1.5 rounded-full border border-accent pl-3 pr-2 text-body-sm text-accent-ink" aria-label={`${label} ${value}, remove this filter`}>
      <span className="text-ink-muted">{label}</span>{" "}
      <span className="font-semibold">{value}</span>
      <X size={13} aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------------- unavailable

/** What MACH does not record, said plainly, with what would be needed. */
export function NotRecorded({ title, what, why, compact = false, state = "not-recorded" }: { title: string; what: ReactNode; why: ReactNode; compact?: boolean; state?: "not-recorded" | "unavailable" | "deferred" }) {
  return (
    <div className={`an-hatch rounded-md border border-dashed border-line-control ${compact ? "px-3 py-2" : "px-4 py-3"}`} data-state={state}>
      <div className="text-label text-ink">{title}</div>
      <p className="text-body-sm text-ink-muted">{what}</p>
      <p className="mt-0.5 text-caption text-ink-subtle">{why}</p>
    </div>
  );
}

/** Few records: the chart is replaced by the counts and no direction is claimed. */
export function TooFew({ what, n, need, periods }: { what: string; n: number; need: number; periods?: number }) {
  return (
    <div className="rounded-md border border-line bg-surface-sunken px-4 py-3" data-state="sparse">
      <div className="text-label text-ink">Too few records for a trend</div>
      <p className="text-body-sm text-ink-muted">
        <span className="an-num font-semibold text-ink">{n}</span> {n === 1 ? what.replace(/(?<=[a-z])s(?=\b|$)/, "") : what} in this window. A direction needs at least <span className="an-num">{need}</span>
        {(periods ?? 3) > 1 ? ` across ${periods ?? 3} periods` : ""}, so none is drawn or claimed.
      </p>
    </div>
  );
}

export function SectionHead({ title, question, children, id }: { title: string; question?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h2 className="text-title-3 text-ink" id={id}>
        {title}
      </h2>
      {question ? <p className="text-body-sm text-ink-muted">{question}</p> : null}
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A small key for a mark: a swatch shape and its words. */
export function Key({ shape, label, tone }: { shape: "bar" | "line" | "dash" | "dot" | "hatch" | "tick"; label: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
      <svg width="16" height="10" aria-hidden="true">
        {shape === "bar" ? <rect x="1" y="1" width="14" height="8" rx="1.5" style={{ fill: tone }} /> : null}
        {shape === "line" ? <line x1="1" x2="15" y1="5" y2="5" style={{ stroke: tone, strokeWidth: 2 }} /> : null}
        {shape === "dash" ? <line x1="1" x2="15" y1="5" y2="5" style={{ stroke: tone, strokeWidth: 1.2, strokeDasharray: "4 2" }} /> : null}
        {shape === "dot" ? <circle cx="8" cy="5" r="3.5" style={{ fill: tone }} /> : null}
        {shape === "tick" ? <line x1="8" x2="8" y1="0" y2="10" style={{ stroke: tone, strokeWidth: 2 }} /> : null}
        {shape === "hatch" ? (
          <g>
            <rect x="1" y="1" width="14" height="8" rx="1.5" style={{ fill: "none", stroke: tone, strokeWidth: 0.8 }} />
            <path d="M3 9L9 1M8 9L14 1" style={{ stroke: tone, strokeWidth: 1 }} />
          </g>
        ) : null}
      </svg>
      {label}
    </span>
  );
}

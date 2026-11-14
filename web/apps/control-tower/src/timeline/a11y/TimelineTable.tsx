/**
 * The structured alternative to the canvas (design section 9): the same tree and window as a real
 * WAI-ARIA tree-grid. Tracks are rows (aria-level, aria-expanded, aria-setsize/posinset); opening a
 * track lists its spans in the window as child rows in time order. Virtualised: only the rows in view
 * (and the focused one) are in the DOM, with aria-rowcount and aria-rowindex saying where they are.
 *
 * Columns: Track, What (describeSpan), Started, Ended, Duration and how it is known (durationWords),
 * Outcome (only once outcomeKnownAt allows it), Authority (the AuthorityBadge's word and glyph).
 * Narrower than STACK_BELOW (200% zoom, a narrow window) the columns stack in each row, so a row reads
 * without scrolling sideways; the column headers are then for screen readers only.
 *
 * The store's selection is marked (aria-selected and a bar in the selection ink) and scrolled into view
 * when it changes, wherever it was made.
 *
 * Keyboard (row focus, roving tabindex): Up/Down, Left/Right (close or go to the parent / open or go to
 * the first child), Home/End and Ctrl+Home/End, PageUp/PageDown, Enter (select a span; open or close a
 * track). Every key the grid uses prevents its default, so the global map (src/shell/keyboard.ts, which
 * skips defaultPrevented events) never also acts on it; the playback keys stay global.
 */
import { ChevronRight } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn, StateMark, type MarkState } from "@mach/ui";
import { AuthorityBadge, NotRecorded } from "../../shell/inspector/parts";
import { getTimeBase, spokenTime, timecode } from "../../shell/vocab";
import { attentionOf, outcomeKnownAt, type SelectGesture, type SpanEnd, type TimelineSpan, type TimelineTableProps } from "../contract";
import { countsWords, describeSpan, durationWords, nodeState, shownCounts } from "../render";
import { useAsOf } from "../controls";
import { attentionWords, codesOnlyName, countWords, heldEnd, momentWords, openContext, summaryWords, windowSummary, type Attention, type TrackSummary } from "./describe";
import { useSceneStore } from "../../scene";
import { buildGridRows, gridKey, indexWindow, scrollToShow, STACK_BELOW, STACKED, visibleRange, WIDE, type GridGeometry, type GridRow } from "./model";

/** The Track column's width (resizable by its header's separator), then the rest. */
const columns = (track: number): string => `${track}px minmax(220px,2fr) 96px 96px minmax(150px,1.1fr) 104px 132px`;
const TRACK_COL = { min: 200, max: 520, initial: 300 } as const;
/** Stacked (narrow): the track, then what, then the times, duration, outcome and authority on one line. */
const STACKED_GRID = {
  gridTemplateColumns: "auto auto minmax(0,1fr) auto auto",
  gridTemplateRows: "20px 20px 20px",
  gridTemplateAreas: '"track track track track track" "what what what what what" "start end dur outcome auth"',
  alignContent: "center",
} as const;
/** A span row stacked: what it was, then its state mark and the times; the indent is the row's. */
const STACKED_SPAN = {
  gridTemplateColumns: "auto auto auto minmax(0,1fr) auto auto",
  gridTemplateRows: "20px 20px",
  gridTemplateAreas: '"what what what what what what" "track start end dur outcome auth"',
  alignContent: "center",
} as const;
type Area = "track" | "what" | "start" | "end" | "dur" | "outcome" | "auth";
/** In a stacked row the time cells say which end they are (the column headers are for screen readers only). */
const AREA_PREFIX: Partial<Record<Area, string>> = { start: "from", end: "to" };
const COLCOUNT = 7;
const INDENT = 14;

const MARK: Readonly<Record<Attention, MarkState | null>> = { none: null, open: "active", person: "human", unknown: "unknown", interrupted: "interrupted", failed: "failed" };

function Mark({ attention, state: given }: { attention?: Attention; state?: MarkState | null }) {
  const state = given !== undefined ? given : attention ? MARK[attention] : null;
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="-6 -6 12 12" className="shrink-0 overflow-visible">
      {state ? <StateMark state={state} r={5} surface="var(--mach-surface)" /> : null}
    </svg>
  );
}

/** A moment: the time code in mono tabular figures, spoken in full for screen readers. */
function Moment({ t, approx }: { t: number; approx?: boolean }) {
  return (
    <span className="font-mono text-[12px] text-ink tabular">
      <span aria-hidden="true">
        {approx ? "≈ " : ""}
        {timecode(t)}
      </span>
      <span className="sr-only">
        {approx ? "about " : ""}
        {spokenTime(t)}
      </span>
    </span>
  );
}

/** One end of a span, as it is known: a time, bounds, a time placed by rule, still open, or not recorded. */
function EndCell({ end, which, liveAt, open }: { end: SpanEnd | null; which: "start" | "end"; liveAt: number; open?: boolean }): ReactNode {
  if (which === "end" && open) return <span className="text-body-sm text-ink-muted">Still open</span>;
  if (!end) return <NotRecorded />;
  if (end.at === null && end.notBefore !== null && end.notAfter !== null) {
    if (end.notBefore > liveAt) return <span className="text-body-sm text-ink-muted">Still open</span>;
    return <BoundedMoment lo={end.notBefore} hi={end.notAfter} />;
  }
  if (end.at === null) return <NotRecorded />;
  if (end.basis === "inferred") return <Moment t={end.at} approx />;
  return <Moment t={end.at} />;
}

/**
 * An end known only between two times, in a time column: both times, stacked as a range on the row's
 * two short lines (never "between … and" wrapped and cut); said in full to a screen reader and in the
 * title.
 */
function BoundedMoment({ lo, hi }: { lo: number; hi: number }) {
  return (
    <span className="flex flex-col whitespace-nowrap font-mono text-[11px] leading-[13px] text-ink-muted tabular" title={`between ${timecode(lo)} and ${timecode(hi)}`} data-bounded="">
      <span aria-hidden="true">{timecode(lo)}</span>
      <span aria-hidden="true">–{timecode(hi)}</span>
      <span className="sr-only">
        between {spokenTime(lo)} and {spokenTime(hi)}
      </span>
    </span>
  );
}

function outcomeText(span: TimelineSpan, liveAt: number): string {
  if (!outcomeKnownAt(span, liveAt) || !span.outcome) return "";
  const r = span.end?.reason;
  if (r === "interrupted" || r === "superseded") return "";
  const words = span.outcome.replace(/[-_]+/g, " ").toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
}

const Stacked = createContext(false);

function Cell({ children, className, area }: { children?: ReactNode; className?: string; area: Area }) {
  const stacked = useContext(Stacked);
  const prefix = stacked ? AREA_PREFIX[area] : undefined;
  return (
    <div role="gridcell" className={cn("flex min-w-0 items-center overflow-hidden", stacked ? "gap-1 px-1 first:pl-0" : "px-2", className)} style={stacked ? { gridArea: area } : undefined}>
      {prefix && children ? (
        <span aria-hidden="true" className="shrink-0 text-caption text-ink-subtle">
          {prefix}
        </span>
      ) : null}
      {children}
    </div>
  );
}

interface RowProps {
  readonly row: GridRow;
  readonly index: number;
  readonly active: boolean;
  readonly liveAt: number;
  readonly summary: TrackSummary | null;
  /** The store's selection is this row (aria-selected). */
  readonly selected: boolean;
  readonly geometry: GridGeometry;
  readonly tree: TimelineTableProps["tree"];
  readonly trackCol: number;
  onActivate(index: number, row: GridRow, how?: SelectGesture): void;
}

/**
 * A track's label as the label column sets it: its first part (the id) never cut while the " · "
 * details after it can be cut instead.
 */
function TrackLabel({ label, strong }: { label: string; strong: boolean }) {
  const cut = label.indexOf(" · ");
  const id = cut < 0 ? label : label.slice(0, cut);
  // Non-breaking around the separator: a flex item drops its leading space.
  const rest = cut < 0 ? "" : `\u00a0·\u00a0${label.slice(cut + 3)}`;
  return (
    <span className={cn("flex min-w-0 shrink items-baseline", strong && "font-semibold")} title={label} data-track-label="">
      <span className="min-w-0 shrink-0 truncate" style={{ maxWidth: "100%" }}>
        {id}
      </span>
      {rest ? <span className="min-w-0 truncate">{rest}</span> : null}
    </span>
  );
}

const Row = memo(function Row({ row, index, active, liveAt, summary, selected, geometry, tree, trackCol, onActivate }: RowProps) {
  const stacked = geometry.header === 0;
  const pad = (stacked ? 4 : 8) + (row.level - 1) * INDENT;
  const common = {
    role: "row",
    "aria-rowindex": index + 2,
    "aria-level": row.level,
    "aria-setsize": row.setSize,
    "aria-posinset": row.posInSet,
    tabIndex: active ? 0 : -1,
    "data-key": row.key,
    "aria-selected": row.type === "more" ? undefined : selected,
    onClick: (e: { detail: number }) => onActivate(index, row, e.detail >= 2 ? "double-click" : "click"),
    style: {
      top: index * geometry.row,
      height: geometry.row,
      ...(stacked ? { ...(row.type === "span" ? STACKED_SPAN : STACKED_GRID), paddingLeft: pad + (row.type === "track" ? 4 : 22), paddingRight: 8 } : { gridTemplateColumns: columns(trackCol) }),
      // The selection: a bar in the selection ink at the row's start.
      boxShadow: selected ? "inset 3px 0 0 var(--mach-factory-select)" : undefined,
    },
    className: cn(
      "absolute inset-x-0 grid cursor-default border-b border-line text-body-sm text-ink hover:bg-surface-sunken",
      selected && "bg-surface-sunken",
      "focus-visible:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
    ),
  } as const;

  if (row.type === "more") {
    return (
      <div {...common}>
        <div role="gridcell" aria-colspan={COLCOUNT} className="col-span-full row-span-full flex items-center italic text-ink-subtle" style={{ paddingLeft: stacked ? 0 : pad + 18 }}>
          {row.hidden > 0 ? `${row.hidden.toLocaleString("en-GB")} more: narrow the window` : "Nothing of this track in this window"}
        </div>
      </div>
    );
  }

  if (row.type === "span") {
    const span = row.span;
    const attention = attentionOf(span, liveAt);
    const word = attentionWords(attention);
    const open = heldEnd(span, liveAt) === null;
    const outcome = outcomeText(span, liveAt);
    // An open wave, slice, cell or round is "open", with when anything beneath it last ended.
    const context = openContext(tree, span, liveAt);
    const sentence = describeSpan(span, liveAt, context);
    const dur = durationWords(span, liveAt, context);
    return (
      <div {...common}>
        <Cell area="track">
          <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: stacked ? 0 : pad + 18 }}>
            <Mark attention={attention} />
            {word ? <span className="truncate text-caption text-ink-muted">{word}</span> : null}
          </span>
        </Cell>
        <Cell area="what">
          <span className="truncate" title={sentence}>
            {sentence}
          </span>
        </Cell>
        <Cell area="start">
          <EndCell end={span.start} which="start" liveAt={liveAt} />
        </Cell>
        <Cell area="end">
          <EndCell end={span.end} which="end" liveAt={liveAt} open={open} />
        </Cell>
        <Cell area="dur">
          <span className="truncate" title={dur}>
            {dur}
          </span>
        </Cell>
        <Cell area="outcome">{outcome ? <span className="truncate">{outcome}</span> : null}</Cell>
        <Cell area="auth">
          <AuthorityBadge authority={span.authority} />
        </Cell>
      </div>
    );
  }

  const node = row.node;
  const s = summary;
  // The row's own state, never a child's verdict; what happened beneath it as counts (as the label column).
  const own = nodeState(node, liveAt);
  const counted = countsWords(shownCounts(node));
  const word = own.words ? own.words[0]!.toUpperCase() + own.words.slice(1) : "";
  const what = s ? summaryWords(node, s) : codesOnlyName(node);
  return (
    <div {...common} aria-expanded={row.expandable ? row.expanded : undefined}>
      <Cell area="track">
        <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: stacked ? 0 : pad }}>
          {row.expandable ? <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-ink-subtle", row.expanded && "rotate-90")} /> : <span aria-hidden="true" className="w-3.5 shrink-0" />}
          <Mark state={own.state} />
          <TrackLabel label={node.label} strong={row.level <= 2} />
          {counted.length ? <span className="shrink-0 text-caption font-medium" style={{ color: node.counts?.failed || node.counts?.rejected ? "var(--mach-factory-fail)" : "var(--mach-factory-halt)" }}>{counted.join(", ")}</span> : null}
          {word ? <span className="shrink-0 text-caption text-ink-muted">· {word}</span> : null}
          {/* The note or detail takes only the room the label leaves (basis 0): the label ("SYN-006 · run 2/3",
              "Claim") is never cut for it; only a label longer than the whole column is cut, in its details. */}
          {node.note ?? node.detail ? <span className={cn("min-w-0 flex-1 basis-0 truncate text-caption text-ink-subtle", node.note && "italic")}>{node.note ?? node.detail}</span> : null}
        </span>
      </Cell>
      <Cell area="what">
        <span className="truncate text-ink-muted" title={what}>
          {s ? countWords(s) : ""}
        </span>
      </Cell>
      <Cell area="start">{s && s.firstStart !== null ? <Moment t={s.firstStart} /> : null}</Cell>
      <Cell area="end">{s && s.count > 0 ? s.stillOpen ? <span className="text-ink-muted">Still open</span> : s.lastEnd !== null ? <Moment t={s.lastEnd} /> : <NotRecorded /> : null}</Cell>
      <Cell area="dur" />
      <Cell area="outcome" />
      <Cell area="auth" />
    </div>
  );
});

/**
 * The Track column's resizer: a 24 px pointer handle on the header's edge. Not a tab stop: the grid is
 * one tab stop (the audit holds it), and nothing is lost without it (every cell's full text is in its
 * title and read in full by a screen reader; narrow, the columns stack).
 */
function ColumnResizer({ width, onWidth }: { width: number; onWidth(w: number): void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(TRACK_COL.min, Math.min(TRACK_COL.max, w)));
  return (
    <div
      aria-hidden="true"
      title="Drag to resize the Track column"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onWidth(clamp(d.w + e.clientX - d.x));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onWidth(TRACK_COL.initial)}
      className="group absolute inset-y-0 -right-3 z-[2] flex w-6 cursor-col-resize touch-none justify-center"
    >
      <span className="h-full w-px bg-line group-hover:w-1 group-hover:bg-line-strong" />
    </div>
  );
}

/**
 * windowSummary for the tree and window, computed when idle (keyed on them, not on every live-edge
 * step); the live edge is read when it runs. The table and the workspace's hidden summary (A5).
 */
export function useIdleSummary(tree: TimelineTableProps["tree"], win: TimelineTableProps["viewport"]["window"], liveAt: number, eager = true): string {
  const live = useRef(liveAt);
  useLayoutEffect(() => {
    live.current = liveAt;
  });
  const [text, setText] = useState(() => (eager ? windowSummary(tree, win, liveAt) : ""));
  useEffect(() => {
    const run = () => setText(windowSummary(tree, win, live.current));
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    if (w.requestIdleCallback && w.cancelIdleCallback) {
      const h = w.requestIdleCallback(run, { timeout: 500 });
      return () => w.cancelIdleCallback!(h);
    }
    const h = window.setTimeout(run, 50);
    return () => window.clearTimeout(h);
  }, [tree, win.from, win.to]); // eslint-disable-line react-hooks/exhaustive-deps
  return text;
}

export const TimelineTable = memo(function TimelineTable({ tree, layout, viewport, onSelect, onToggle }: TimelineTableProps) {
  const { window: win, liveAt } = viewport;
  const [openLeaves, setOpenLeaves] = useState<ReadonlySet<string>>(() => new Set());
  // The focused row, by key; its last index stands in when a rebuild removes it (a track closed above it).
  const [active, setActive] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [narrow, setNarrow] = useState(false);
  const geometry: GridGeometry = narrow ? STACKED : WIDE;
  const selection = useSceneStore((st) => st.selection);
  // When the selection went to a span's nearest selectable ancestor, the span itself is the detail.
  const detail = useSceneStore((st) => st.selectionDetail);
  const grid = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const summaryId = useId();

  // Per window: spans and summaries are computed lazily, once each.
  const index = useMemo(() => indexWindow(win, liveAt), [win.from, win.to, liveAt, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const model = useMemo(() => buildGridRows(layout, index, openLeaves), [layout, index, openLeaves]);
  // A5: the window's summary walks every span; it is keyed on the tree and the window, not on each step
  // of the live edge, and computed when the browser is idle (the live edge is read when it runs).
  const caption = useIdleSummary(tree, win, liveAt);
  const asOf = useAsOf();
  const [trackCol, setTrackCol] = useState<number>(TRACK_COL.initial);

  const count = model.rows.length;
  const found = active.key === null ? undefined : model.indexOf.get(active.key);
  const activeIndex = count === 0 ? -1 : Math.min(count - 1, found ?? active.index);

  // The grid exists only while there are rows: measured again whenever it appears (a table opened on an
  // empty window and then filled would otherwise keep the default height and never render its last rows).
  const hasGrid = count > 0;
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => {
      setHeight(el.clientHeight);
      setNarrow(el.clientWidth < STACK_BELOW);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    // The scroll position is the element's own: a grid mounted anew starts where it is.
    setScrollTop(el.scrollTop);
    return () => ro.disconnect();
  }, [hasGrid]);

  const focusRow = useCallback(
    (i: number) => {
      const row = model.rows[i];
      if (!row) return;
      setActive({ key: row.key, index: i });
      const el = grid.current;
      if (el) {
        const next = scrollToShow(i, el.scrollTop, el.clientHeight, geometry);
        if (next !== el.scrollTop) {
          el.scrollTop = next;
          setScrollTop(next);
        }
      }
      pendingFocus.current = true;
    },
    [model, geometry],
  );

  // The store's selection: the span row that is it, else the track row that is it, else the track that
  // shows it (its most specific). Marked aria-selected and scrolled into view when it changes.
  const selectedIndex = useMemo(() => {
    if (!selection) return -1;
    let track = -1;
    let span = -1;
    for (let i = 0; i < model.rows.length; i++) {
      const r = model.rows[i] as GridRow;
      if (r.type === "span" && detail && (r.span.entity === detail || r.span.id === detail)) return i;
      if (span < 0 && r.type === "span" && (r.span.entity === selection || r.span.id === selection)) span = i;
      if (track < 0 && r.type === "track" && r.node.ref === selection) track = i;
    }
    if (span >= 0) return span;
    if (track >= 0) return track;
    const id = tree.tracksOf(selection)[0];
    return id ? (model.indexOf.get(`track:${id}`) ?? -1) : -1;
  }, [selection, detail, model, tree]);
  useEffect(() => {
    const el = grid.current;
    if (!el || selectedIndex < 0) return;
    const next = scrollToShow(selectedIndex, el.scrollTop, el.clientHeight, geometry);
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      setScrollTop(next);
    }
    // Only when the selection (or what it lands on) changes, not on every scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, detail, selectedIndex, narrow]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const key = model.rows[activeIndex]?.key;
    if (!key) return;
    grid.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  });

  const toggle = useCallback(
    (row: GridRow) => {
      if (row.type !== "track" || !row.expandable) return;
      if (row.node.children.length > 0) {
        onToggle(row.node.id);
        return;
      }
      setOpenLeaves((prev) => {
        const next = new Set(prev);
        if (next.has(row.node.id)) next.delete(row.node.id);
        else next.add(row.node.id);
        return next;
      });
    },
    [onToggle],
  );

  const onActivate = useCallback(
    (i: number, row: GridRow, how: SelectGesture = "key") => {
      setActive({ key: row.key, index: i });
      if (row.type === "span") onSelect(row.span, how);
      else if (row.type === "track") toggle(row);
    },
    [onSelect, toggle],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (activeIndex < 0) return;
    const page = Math.max(1, Math.floor((height - geometry.header) / geometry.row) - 1);
    const action = gridKey(model, activeIndex, e, page);
    if (!action) return;
    e.preventDefault();
    const row = model.rows[action.index];
    if (!row) return;
    if (action.type === "focus") focusRow(action.index);
    else if (action.type === "toggle") {
      toggle(row);
      pendingFocus.current = true;
    } else if (row.type === "span") onSelect(row.span, "key");
  };

  const range = visibleRange(scrollTop, height, count, 8, geometry);
  const shown: number[] = [];
  for (let i = range.start; i < range.end; i++) shown.push(i);
  // The focused row stays in the DOM when scrolled away, so focus is never lost to the page.
  if (activeIndex >= 0 && (activeIndex < range.start || activeIndex >= range.end)) {
    shown.push(activeIndex);
    shown.sort((a, b) => a - b);
  }
  const wall = getTimeBase() === "wall";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {asOf.caption ? <p className="shrink-0 border-b border-line bg-surface-sunken px-3 py-1 text-caption text-ink-muted">{asOf.caption}</p> : null}
      <p id={summaryId} className="shrink-0 border-b border-line px-3 py-1.5 text-caption text-ink-muted">
        {caption}
      </p>
      {count === 0 ? (
        <p className="px-3 py-3 text-body-sm text-ink-muted">No track to list for this window.</p>
      ) : (
        <div
          ref={grid}
          role="treegrid"
          tabIndex={-1}
          aria-label={`Tracks and spans from ${momentWords(win.from)} to ${momentWords(Math.min(win.to, Math.max(win.from, liveAt)))}${wall ? " UTC" : ""}`}
          aria-describedby={summaryId}
          aria-rowcount={count + 1}
          aria-colcount={COLCOUNT}
          className="relative min-h-0 flex-1 overflow-auto"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
        >
          <div className={narrow ? undefined : "min-w-[1080px]"}>
            <div role="rowgroup" className={narrow ? "sr-only" : "sticky top-0 z-[1] border-b border-line-strong bg-surface"}>
              <div role="row" aria-rowindex={1} className="grid text-label text-ink-muted" style={{ gridTemplateColumns: columns(trackCol), height: WIDE.header }}>
                {["Track", "What", wall ? "Started (UTC)" : "Started", wall ? "Ended (UTC)" : "Ended", "Duration, and how it is known", "Outcome", "Authority"].map((h, i) => (
                  <div key={h} role="columnheader" className="relative flex items-center px-2 text-[12px] font-semibold">
                    {h}
                    {i === 0 && !narrow ? <ColumnResizer width={trackCol} onWidth={setTrackCol} /> : null}
                  </div>
                ))}
              </div>
            </div>
            <div role="rowgroup" className="relative" style={{ height: count * geometry.row }}>
              <Stacked.Provider value={narrow}>
                {shown.map((i) => {
                  const row = model.rows[i] as GridRow;
                  return (
                    <Row
                      key={row.key}
                      row={row}
                      index={i}
                      active={i === activeIndex}
                      liveAt={liveAt}
                      summary={row.type === "track" ? index.summaryOf(row.node) : null}
                      selected={i === selectedIndex}
                      geometry={geometry}
                      tree={tree}
                      trackCol={trackCol}
                      onActivate={onActivate}
                    />
                  );
                })}
              </Stacked.Provider>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

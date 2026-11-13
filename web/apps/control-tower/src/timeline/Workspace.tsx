/**
 * The Execution Timeline workspace (docs/mach-next/M6_3_DESIGN.md, section 3): the shared transport,
 * the Timeline's controls, the temporal overview, the ruler and the hierarchical tracks, and the
 * structured alternative (the table) when asked for. Composition only: every part is reached through
 * its entry point in the contract (./data, ./tracks, ./render, ./overview, ./controls, ./a11y).
 *
 * Owned here: the size of each region, the span query for the window, the track tree's identity
 * across rebuilds, scrolling, and revealing a selection made elsewhere. Time, selection, hover,
 * focus and playback are the store's; the window, grouping, expansion, filters and the table are the
 * Timeline's interface state, kept in the store (`timeline`), so a workspace switch keeps them.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Button, LoadingState } from "@mach/ui";
import { entityAt, stableEntityAt, type EntityRef } from "../sim";
import { useSceneStore, useStore, type SceneStore } from "../scene";
import { quantizedEdge } from "../shell/timeline/Timeline";
import { Transport } from "../shell/timeline/Transport";
import { utcClock } from "../shell/vocab";
import { LABEL_GUTTER, NO_FILTERS, OVERVIEW_HEIGHT, RULER_HEIGHT, type Grouping, type SpanPage, type TimelineData, type TimelineHit, type TimelineMark, type TimelineSpan, type TimelineTableProps, type TimelineViewport, type TimeWindow, type TrackNode, type TrackTree } from "./contract";
import { TimelineToolbar } from "./controls";
import { ancestorsOf, anyInWindow, clampWindow, extentOfSpans, panToInclude, refForSpan, spanIdForRef, spansOfRef } from "./controls/frame";
import { useTimelineData } from "./data";
import { TemporalOverview } from "./overview";
import { TrackCanvas, TrackLabels, WindowRuler } from "./render";
import { buildTrackTree, defaultExpanded, layoutRows } from "./tracks";

/** The overview is shorter on a short window (design section 3A). */
const SHORT_OVERVIEW = 72;
const MAX_GUTTER = 320;
/** How often new events may re-query the window's spans. */
const REQUERY_MS = 500;
const NO_SPANS: readonly TimelineSpan[] = [];
const NO_MARKS: readonly TimelineMark[] = [];

// ---------------------------------------------------------------- the structured alternative, when it exists

/**
 * The table (./a11y) is built separately. It is looked up with import.meta.glob, which yields nothing
 * (and no build error) while the module is absent, so the toggle fails soft until it lands.
 */
const a11yModules = import.meta.glob<{ TimelineTable: ComponentType<TimelineTableProps> }>("./a11y/index.ts");
const loadA11y = a11yModules["./a11y/index.ts"];
const LazyTable = loadA11y
  ? lazy<ComponentType<TimelineTableProps>>(() =>
      loadA11y().then(
        (m) => ({ default: m.TimelineTable }),
        () => ({ default: TableUnavailable }),
      ),
    )
  : null;

function TableUnavailable(_props: Partial<TimelineTableProps>) {
  return <p className="px-4 py-3 text-body-sm text-ink-muted">The table view is not available in this build.</p>;
}

// ---------------------------------------------------------------- helpers

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** The size of an element, live. */
function useSize<T extends HTMLElement>(): [(el: T | null) => void, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, size];
}

/** The live edge in steps (about 1/1000 of what is held, at least 250 ms): the workspace re-renders a few times a second at most. */
function quantizedLiveAt(s: { extent: { start: number; end: number }; liveAt: number }): number {
  const step = Math.max(250, Math.round((Math.max(s.extent.end, s.liveAt) - s.extent.start) / 1000));
  return Math.ceil(s.liveAt / step) * step;
}

const contains = (outer: TimeWindow, inner: TimeWindow): boolean => inner.from >= outer.from && inner.to <= outer.to;
const widen = (w: TimeWindow): TimeWindow => {
  const half = (w.to - w.from) / 2;
  return { from: w.from - half, to: w.to + half };
};
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";

interface Fetched {
  readonly range: TimeWindow | null;
  readonly page: SpanPage | null;
  readonly marks: readonly TimelineMark[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * The spans and marks for the window: queried for the window widened by half its width on each side,
 * again when the window leaves what was fetched or the data says it changed. While a query runs, the
 * previous answer stays on screen.
 */
function useWindowSpans(data: TimelineData, win: TimeWindow): Fetched & { retry: () => void } {
  const [fetched, setFetched] = useState<Fetched>({ range: null, page: null, marks: NO_MARKS, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    let last = 0;
    const off = data.subscribe(() => {
      if (timer) return;
      timer = globalThis.setTimeout(() => {
        timer = 0;
        last = performance.now();
        setTick((t) => t + 1);
      }, Math.max(0, last + REQUERY_MS - performance.now()));
    });
    return () => {
      off();
      if (timer) globalThis.clearTimeout(timer);
    };
  }, [data]);
  const inRange = fetched.range !== null && contains(fetched.range, win) && fetched.error === null;
  // What to ask for: a new range only when the window has left the fetched one; else the same range again on a tick.
  const want = inRange && fetched.range ? fetched.range : widen(win);
  const key = `${Math.round(want.from)}:${Math.round(want.to)}:${inRange ? "same" : "new"}:${tick}`;
  const asked = useRef("");
  useEffect(() => {
    if (asked.current === key) return;
    asked.current = key;
    const ctl = new AbortController();
    const range = want;
    setFetched((f) => (f.loading ? f : { ...f, loading: true }));
    Promise.all([data.spans({ window: range }, ctl.signal), data.marks(range, undefined, ctl.signal).catch((e: unknown) => (isAbort(e) ? Promise.reject(e) : NO_MARKS))]).then(
      ([page, marks]) => {
        if (!ctl.signal.aborted) setFetched({ range, page, marks, loading: false, error: null });
      },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        setFetched((f) => ({ ...f, loading: false, error: errorText(e) }));
      },
    );
    return () => {
      ctl.abort();
      asked.current = "";
    };
    // `want` is captured through `key`, which names it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { ...fetched, retry };
}

/** Which ref a span selects or hovers: its entity when the history knows it, else its nearest known parent's. */
function makeRefOf(store: SceneStore, spans: readonly TimelineSpan[]) {
  const byId = new Map(spans.map((s) => [s.id, s] as const));
  return (span: TimelineSpan): EntityRef | null => {
    const s = store.getState();
    const head = s.log.head();
    const now = s.log.sceneAt(s.playhead);
    const known = (ref: string) => {
      try {
        return stableEntityAt(head, ref as EntityRef) !== null || entityAt(now, ref as EntityRef) !== null;
      } catch {
        return false;
      }
    };
    return refForSpan(span, byId, known) as EntityRef | null;
  };
}

/** The last tree built for a data source: the next build starts from it (stable identity, incremental). */
const previousTrees = new WeakMap<TimelineData, TrackTree>();

/** Groupings already seeded with their default expansion, per store: seeded once, then the person's. */
const seeded = new WeakMap<SceneStore, Set<Grouping>>();

// ---------------------------------------------------------------- the workspace

export function TimelineWorkspace() {
  const store = useStore();
  const data = useTimelineData();
  const view = useSceneStore((s) => s.timeline);
  const source = useSceneStore((s) => s.source);
  const connection = useSceneStore((s) => s.connection?.state ?? null);
  const selection = useSceneStore((s) => s.selection);
  const focusNonce = useSceneStore((s) => (s.focus && s.focus.target !== "overview" ? s.focus.nonce : 0));
  const liveAt = useSceneStore(quantizedLiveAt);
  const start = useSceneStore((s) => s.extent.start);
  const edge = useSceneStore((s) => (s.source === "simulation" ? s.extent.end : quantizedEdge(s.extent.start, s.liveAt)));
  const short = useMedia("(max-height: 759px)");
  const overviewH = short ? SHORT_OVERVIEW : OVERVIEW_HEIGHT;

  // The whole history held: the store's extent, reaching back further when the data source knows more.
  const dataFrom = data.extent()?.from ?? null;
  const whole = useMemo<TimeWindow>(() => ({ from: dataFrom === null ? start : Math.min(start, dataFrom), to: edge }), [start, edge, dataFrom]);
  // No window chosen: the whole history, following the live edge.
  const win = view.window ?? whole;

  const fetched = useWindowSpans(data, win);
  const spans = fetched.page?.spans ?? NO_SPANS;

  // The tree, rebuilt from the previous one so track identity (expansion, scroll, selection) survives.
  // Kept per data source, outside the component, so a workspace switch keeps it too.
  const tree = useMemo(() => buildTrackTree(spans, view.grouping, view.filters, liveAt, previousTrees.get(data)), [data, spans, view.grouping, view.filters, liveAt]);
  useEffect(() => {
    previousTrees.set(data, tree);
  }, [data, tree]);

  // Expansion: the store's, seeded once per grouping with the tracks' defaults.
  useEffect(() => {
    if (!tree.roots.length) return;
    let done = seeded.get(store);
    if (!done) seeded.set(store, (done = new Set()));
    if (done.has(tree.grouping)) return;
    done.add(tree.grouping);
    const current = store.getState().timeline.expanded;
    const add = defaultExpanded(tree).filter((id) => !current.includes(id));
    if (add.length) store.setTimelineView({ expanded: [...current, ...add] });
  }, [tree, store]);
  const expanded = useMemo(() => new Set(view.expanded), [view.expanded]);
  const layout = useMemo(() => layoutRows(tree, expanded), [tree, expanded]);

  // Regions.
  const [measure, size] = useSize<HTMLDivElement>();
  const [gutter, setGutter] = useState(LABEL_GUTTER);
  const timeWidth = Math.max(0, size.width - gutter);
  const tracksH = Math.max(0, size.height - RULER_HEIGHT);
  const [scrollTop, setScrollTop] = useState(0);
  const maxScroll = Math.max(0, layout.totalHeight - tracksH);
  const top = Math.min(scrollTop, maxScroll);

  const viewport = useMemo<TimelineViewport>(() => ({ window: win, width: timeWidth, liveAt }), [win, timeWidth, liveAt]);

  // ---- the person's actions
  const pendingReveal = useRef<string | null>(null);
  /** The ref whose span was last looked up (once per reveal: a span that never lands in the tree is not asked for again). */
  const loadingSpanFor = useRef<string | null>(null);
  const ownSelection = useRef<string | null>(null);

  const onWindow = useCallback(
    (next: TimeWindow | null) => {
      pendingReveal.current = null;
      store.setTimelineView({ window: next ? clampWindow(next, whole) : null });
    },
    [store, whole],
  );
  const onScroll = useCallback(
    (y: number) => {
      pendingReveal.current = null;
      setScrollTop(Math.max(0, Math.min(maxScroll, y)));
    },
    [maxScroll],
  );
  const onToggle = useCallback(
    (id: string) => {
      const current = store.getState().timeline.expanded;
      store.setTimelineView({ expanded: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] });
    },
    [store],
  );
  const refOf = useMemo(() => makeRefOf(store, spans), [store, spans]);
  const selectRef = useCallback(
    (ref: EntityRef | null) => {
      ownSelection.current = ref;
      store.select(ref, { focus: false });
    },
    [store],
  );
  const onHover = useCallback(
    (hit: TimelineHit | null) => {
      const ref = hit?.span ? refOf(hit.span) : hit?.mark?.entity && /^[a-z]+:.+/.test(hit.mark.entity) ? (hit.mark.entity as EntityRef) : null;
      store.hover(ref);
    },
    [refOf, store],
  );
  const onSelect = useCallback(
    (hit: TimelineHit) => {
      if (hit.span) {
        selectRef(refOf(hit.span));
        return;
      }
      if (hit.mark) {
        const m = hit.mark;
        if (m.eventId && store.getState().log.entry(m.eventId)) store.seekToEvent(m.eventId);
        else store.seek(m.at);
        if (m.entity && /^[a-z]+:.+/.test(m.entity)) selectRef(m.entity as EntityRef);
        return;
      }
      // An aggregate of spans too small to draw one by one: zoom to it.
      if (hit.count > 0 && hit.to > hit.from) onWindow({ from: hit.from, to: hit.to });
    },
    [onWindow, refOf, selectRef, store],
  );
  const onLabelSelect = useCallback((node: TrackNode) => selectRef(node.ref), [selectRef]);
  const onGutter = useCallback((w: number) => setGutter(Math.round(Math.max(LABEL_GUTTER, Math.min(MAX_GUTTER, w)))), []);
  const onTableSelect = useCallback((span: TimelineSpan) => selectRef(refOf(span)), [refOf, selectRef]);

  // ---- revealing a selection made elsewhere (another view, the inspector, "Show in Timeline", F)
  useEffect(() => {
    if (!selection) {
      pendingReveal.current = null;
      return;
    }
    if (selection !== ownSelection.current) {
      pendingReveal.current = selection;
      loadingSpanFor.current = null;
    }
    ownSelection.current = null;
  }, [selection]);
  useEffect(() => {
    // A focus request (Show in Timeline, F) frames the selection even when it did not change.
    const sel = store.getState().selection;
    if (focusNonce && sel) {
      pendingReveal.current = sel;
      loadingSpanFor.current = null;
    }
  }, [focusNonce, store]);
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const ref = pendingReveal.current;
    if (!ref) return;
    const tracks = tree.tracksOf(ref);
    const trackId = tracks[0];
    if (!trackId) {
      // Not in what is loaded (outside the fetched window, or not yet arrived): find its span and pan to it.
      const id = spanIdForRef(ref);
      if (!id || loadingSpanFor.current === ref) return;
      loadingSpanFor.current = ref;
      // Not aborted on re-render: the answer is checked against what is still wanted when it comes.
      data.span(id).then(
        (span) => {
          if (pendingReveal.current !== ref || !span) return;
          const ext = extentOfSpans([span], store.getState().liveAt);
          const current = store.getState().timeline.window;
          if (ext && current) store.setTimelineView({ window: clampWindow(panToInclude(current, ext), whole) });
          setRevealTick((t) => t + 1);
        },
        () => undefined,
      );
      return;
    }
    // 1. Its tracks visible: every ancestor expanded.
    const current = store.getState().timeline.expanded;
    const missing = ancestorsOf(tree, trackId).filter((id) => !current.includes(id));
    if (missing.length) {
      store.setTimelineView({ expanded: [...current, ...missing] });
      return;
    }
    // 2. Scrolled into view.
    const row = layout.rowOf(trackId);
    if (row && tracksH > 0 && (row.y < top || row.y + row.height > top + tracksH)) setScrollTop(Math.max(0, Math.min(maxScroll, row.y - tracksH / 3)));
    // 3. Its span in the window.
    const chosen = store.getState().timeline.window;
    const ext = extentOfSpans(spansOfRef(tree, ref), store.getState().liveAt);
    if (ext && chosen) {
      const next = panToInclude(chosen, ext);
      if (next !== chosen) store.setTimelineView({ window: clampWindow(next, whole) });
    }
    pendingReveal.current = null;
  }, [tree, layout, selection, focusNonce, revealTick, data, store, whole, top, tracksH, maxScroll]);

  // ---- states
  const empty = !fetched.loading && fetched.page !== null && fetched.page.total === 0 && spans.length === 0;
  const nothingHere = !fetched.loading && spans.length > 0 && !anyInWindow(tree, win);
  const disconnected = source === "live" && (connection === "disconnected" || connection === "stale" || connection === "reconnecting");

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-timeline-workspace="">
      <h2 className="sr-only">Execution Timeline</h2>
      {/* The shared transport. Its collapse button belongs to the docked timeline and is not shown here. */}
      <div className="shrink-0 [&_[aria-keyshortcuts='Shift+T']]:hidden">
        <Transport collapsed={false} onCollapse={noop} />
      </div>
      <TimelineToolbar data={data} tree={tree} view={view} onView={store.setTimelineView} />

      {disconnected ? (
        <p role="status" className="shrink-0 border-b border-line bg-warning-soft px-3 py-1.5 text-body-sm text-ink">
          Not connected to the observer: showing what was received, up to {utcClock(liveAt)} UTC. Nothing after it is drawn.
        </p>
      ) : null}
      {fetched.page?.truncated ? (
        <p role="status" className="shrink-0 border-b border-line bg-surface-sunken px-3 py-1.5 text-body-sm text-ink-muted">
          This window holds {fetched.page.total.toLocaleString("en")} spans; {fetched.page.spans.length.toLocaleString("en")} are shown. Narrow the window to see every one.
        </p>
      ) : null}
      {fetched.error ? (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-danger-line bg-danger-soft px-3 py-1.5 text-body-sm text-ink">
          <span className="min-w-0 flex-1 truncate">Could not read the spans for this window: {fetched.error}</span>
          <Button size="sm" onClick={fetched.retry}>
            Try again
          </Button>
        </div>
      ) : null}

      {/* A: the whole history, with the brush. Aligned with the tracks' time column. */}
      <section aria-label="Whole history" className="flex shrink-0 border-b border-line" style={{ height: overviewH }}>
        <div className="flex shrink-0 flex-col justify-end border-r border-line px-3 pb-2" style={{ width: gutter }}>
          <span className="text-label text-ink">Whole history</span>
          <span className="text-caption text-ink-subtle">Drag to choose a window</span>
        </div>
        <div className="min-w-0 flex-1">
          {timeWidth > 0 ? (
            <TemporalOverview data={data} extent={whole} window={win} liveAt={liveAt} width={timeWidth} height={overviewH} filters={view.filters} onWindow={onWindow} />
          ) : null}
        </div>
      </section>

      {view.table ? (
        <section aria-label="Timeline as a table" className="min-h-0 flex-1 overflow-auto">
          {LazyTable ? (
            <Suspense fallback={<LoadingState label="Preparing the table" className="px-4" />}>
              <LazyTable tree={tree} layout={layout} viewport={viewport} onSelect={onTableSelect} onToggle={onToggle} />
            </Suspense>
          ) : (
            <TableUnavailable />
          )}
        </section>
      ) : (
        <section aria-label="Tracks" ref={measure} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* The ruler row: the gutter, then the ruler for the window. */}
          <div className="flex shrink-0 border-b border-line" style={{ height: RULER_HEIGHT }}>
            <div className="shrink-0 border-r border-line" style={{ width: gutter }} aria-hidden="true" />
            <div className="min-w-0 flex-1">{timeWidth > 0 ? <WindowRuler viewport={viewport} onWindow={onWindow} /> : null}</div>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="shrink-0 border-r border-line" style={{ width: gutter }}>
              <TrackLabels layout={layout} height={tracksH} scrollTop={top} width={gutter} onToggle={onToggle} onSelect={onLabelSelect} onResize={onGutter} />
            </div>
            <div className="relative min-w-0 flex-1">
              {timeWidth > 0 && tracksH > 0 ? (
                <TrackCanvas
                  tree={tree}
                  layout={layout}
                  viewport={viewport}
                  marks={fetched.marks}
                  height={tracksH}
                  scrollTop={top}
                  truncated={fetched.page?.truncated ?? false}
                  onScroll={onScroll}
                  onWindow={onWindow}
                  onHover={onHover}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              ) : null}
            </div>
          </div>
          <StateOverlay
            loading={fetched.loading && fetched.page === null}
            empty={empty}
            nothingHere={nothingHere}
            filtered={hasFilters(view.filters)}
            source={source}
            onShowAll={() => onWindow(null)}
            onClearFilters={() => store.setTimelineView({ filters: NO_FILTERS })}
          />
        </section>
      )}
    </div>
  );
}

function noop() {}

function hasFilters(f: { tickets: readonly string[]; executions: readonly string[]; slices: readonly string[]; stations: readonly string[]; kinds: readonly string[]; attentionOnly: boolean }): boolean {
  return f.tickets.length + f.executions.length + f.slices.length + f.stations.length + f.kinds.length > 0 || f.attentionOnly;
}

/** The designed states over the tracks: reading, nothing recorded yet, nothing in this window. */
function StateOverlay({ loading, empty, nothingHere, filtered, source, onShowAll, onClearFilters }: { loading: boolean; empty: boolean; nothingHere: boolean; filtered: boolean; source: string; onShowAll: () => void; onClearFilters: () => void }) {
  if (!loading && !empty && !nothingHere) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6" style={{ top: RULER_HEIGHT }}>
      <div className="pointer-events-auto mt-10 h-fit max-w-md rounded-md border border-dashed border-line-strong bg-surface px-5 py-4">
        {loading ? (
          <LoadingState label={source === "simulation" ? "Laying out the simulated run" : "Reading the history held for this window"} className="py-0" />
        ) : empty ? (
          <>
            <p className="text-label text-ink">{filtered ? "Nothing matches these filters" : "No execution recorded yet"}</p>
            <p className="mt-1 text-body-sm text-ink-muted">
              {filtered
                ? "No span in what is held matches the filters chosen."
                : source === "live"
                  ? "Spans appear here as the Factory records work: waves, cells, station visits, executions and their agents."
                  : "This history holds no span to draw."}
            </p>
            {filtered ? (
              <Button size="sm" className="mt-3" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-label text-ink">Nothing recorded in this window</p>
            <p className="mt-1 text-body-sm text-ink-muted">The history holds spans before or after it.</p>
            <Button size="sm" className="mt-3" onClick={onShowAll}>
              Show all
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

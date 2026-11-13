/**
 * The Execution Timeline workspace (docs/mach-next/M6_3_DESIGN.md, section 3): the shared transport,
 * the Timeline's controls, the temporal overview, the investigation band (when a lens is on), the
 * ruler and the hierarchical tracks, or the structured alternative (the table) in their place. Composition only:
 * every part is reached through its entry point in the contract (./data, ./tracks, ./render,
 * ./overview, ./controls, ./investigate, ./a11y).
 *
 * Owned here: the size of each region, the default window (the recorded activity, controls/frame.ts
 * `activityWindow`), the span query for the window, the track tree's identity across rebuilds,
 * scrolling and the label column (kept per store across workspace switches), the keyboard cursor,
 * revealing a selection made elsewhere, and the chosen interval the floor highlights. Time,
 * selection, hover, focus and playback are the store's; the window, grouping, expansion, filters,
 * lens and the table are the Timeline's interface state, kept in the store (`timeline`).
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Button, LoadingState } from "@mach/ui";
import { entityAt, stableEntityAt, type EntityRef } from "../sim";
import { useSceneStore, useStore, type SceneStore } from "../scene";
import { quantizedEdge } from "../shell/timeline/Timeline";
import { Transport } from "../shell/timeline/Transport";
import { utcClock } from "../shell/vocab";
import {
  LABEL_GUTTER,
  NO_FILTERS,
  OVERVIEW_HEIGHT,
  RULER_HEIGHT,
  type Grouping,
  type InvestigationPanelProps,
  type LensDefinition,
  type SpanPage,
  type TimelineCursor,
  type TimelineData,
  type TimelineHit,
  type TimelineMark,
  type TimelineSpan,
  type TimelineTableProps,
  type TimelineViewport,
  type TimelineViewState,
  type TimeWindow,
  type TrackNode,
  type TrackTree,
} from "./contract";
import { TimelineToolbar } from "./controls";
import { activityWindow, ancestorsOf, anyInWindow, cellsInInterval, clampWindow, extentOfSpans, isAll, panToInclude, refForSpan, resolveWindow, spanIdForRef, spansOfRef } from "./controls/frame";
import { recordedExtent, useTimelineData } from "./data";
import { TemporalOverview } from "./overview";
import { TrackCanvas, TrackLabels, WindowRuler } from "./render";
import { buildTrackTree, defaultExpanded, layoutRows } from "./tracks";

/** The overview is shorter on a short window (design section 3A). */
const SHORT_OVERVIEW = 72;
const MAX_GUTTER = 320;
/** The investigation band's most height. */
const MAX_BAND = 220;
/** How often new events may re-query the window's spans. */
const REQUERY_MS = 500;
/** How often new events may re-read the activity the default window is framed on. */
const ACTIVITY_REQUERY_MS = 2000;
const NO_SPANS: readonly TimelineSpan[] = [];
const NO_MARKS: readonly TimelineMark[] = [];

// ---------------------------------------------------------------- parts built separately, when they exist

/**
 * The table (./a11y) and the investigation lenses (./investigate) are built separately. Each is looked
 * up with import.meta.glob, which yields nothing (and no build error) while the module is absent, so
 * their controls fail soft until they land.
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

type InvestigateModule = { LENSES: readonly LensDefinition[]; InvestigationPanel: ComponentType<InvestigationPanelProps> };
const investigateModules = import.meta.glob<InvestigateModule>("./investigate/index.ts");
const loadInvestigate = investigateModules["./investigate/index.ts"];
let investigate: Promise<InvestigateModule | null> | null = null;
const investigateModule = (): Promise<InvestigateModule | null> =>
  (investigate ??= loadInvestigate ? loadInvestigate().then(
    (m) => m,
    () => null,
  ) : Promise.resolve(null));
const LazyPanel = loadInvestigate
  ? lazy<ComponentType<InvestigationPanelProps>>(() => investigateModule().then((m) => ({ default: m?.InvestigationPanel ?? PanelUnavailable })))
  : null;

function PanelUnavailable(_props: Partial<InvestigationPanelProps>) {
  return <p className="px-3 py-2 text-body-sm text-ink-muted">The investigation lenses are not available in this build.</p>;
}

/** The lenses, once their module has loaded; null while it has not or when it is absent. */
function useLenses(): readonly LensDefinition[] | null {
  const [lenses, setLenses] = useState<readonly LensDefinition[] | null>(null);
  useEffect(() => {
    let live = true;
    void investigateModule().then((m) => {
      if (live) setLenses(m?.LENSES ?? null);
    });
    return () => {
      live = false;
    };
  }, []);
  return lenses;
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

/** A listener on the data, throttled: a counter that moves at most once per `ms`. */
function useDataTick(data: TimelineData, ms: number): number {
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
      }, Math.max(0, last + ms - performance.now()));
    });
    return () => {
      off();
      if (timer) globalThis.clearTimeout(timer);
    };
  }, [data, ms]);
  return tick;
}

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
  const dataTick = useDataTick(data, REQUERY_MS);
  const [retries, setRetries] = useState(0);
  const tick = dataTick + retries;
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
  const retry = useCallback(() => setRetries((t) => t + 1), []);
  return { ...fetched, retry };
}

/**
 * What the default window is framed on beyond the loaded spans: the data layer's recorded extent
 * (`recordedExtent`: density, else the last mark and span bounds). Re-read when the data says it changed (at most
 * every ACTIVITY_REQUERY_MS) or the history's span moves by more than a fiftieth.
 */
function useActivity(data: TimelineData, whole: TimeWindow): { recorded: TimeWindow | null } {
  const tick = useDataTick(data, ACTIVITY_REQUERY_MS);
  const [got, setGot] = useState<{ recorded: TimeWindow | null }>({ recorded: null });
  const step = Math.max(60_000, (whole.to - whole.from) / 50);
  const key = `${tick}:${Math.round(whole.from)}:${Math.ceil(whole.to / step)}`;
  // The history's span as of the key: a few re-reads a minute at most, not one per live-edge step.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const asked = useMemo(() => whole, [key]);
  useEffect(() => {
    const ctl = new AbortController();
    // Read when the history's span moves (`asked`); the data layer measures from its own extent.
    void asked;
    recordedExtent(data, ctl.signal).then(
      (recorded) => {
        if (!ctl.signal.aborted) setGot({ recorded });
      },
      () => {
        if (!ctl.signal.aborted) setGot({ recorded: null });
      },
    );
    return () => ctl.abort();
  }, [data, asked]);
  return got;
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

/** Scroll position, label column width and the band's state, per store: kept across workspace switches. */
interface Kept {
  scrollTop: number;
  gutter: number;
  bandOpen: boolean;
}
const kept = new WeakMap<SceneStore, Kept>();
function keptFor(store: SceneStore): Kept {
  return kept.get(store) ?? { scrollTop: 0, gutter: LABEL_GUTTER, bandOpen: true };
}

const LENS_WORDS: Record<NonNullable<TimelineViewState["lens"]>, string> = { retries: "Retries", concurrency: "Concurrency", waits: "Waits", review: "Review", recovery: "Recovery" };

// ---------------------------------------------------------------- the workspace

export function TimelineWorkspace() {
  const store = useStore();
  const data = useTimelineData();
  const lenses = useLenses();
  const view = useSceneStore((s) => s.timeline);
  const source = useSceneStore((s) => s.source);
  const connection = useSceneStore((s) => s.connection?.state ?? null);
  const followingLive = useSceneStore((s) => s.source === "live" && s.following);
  const selection = useSceneStore((s) => s.selection);
  const focusNonce = useSceneStore((s) => (s.focus && s.focus.target !== "overview" ? s.focus.nonce : 0));
  const liveAt = useSceneStore(quantizedLiveAt);
  const start = useSceneStore((s) => s.extent.start);
  const edge = useSceneStore((s) => (s.source === "simulation" ? s.extent.end : quantizedEdge(s.extent.start, s.liveAt)));
  const short = useMedia("(max-height: 759px)");
  const overviewH = short ? SHORT_OVERVIEW : OVERVIEW_HEIGHT;
  const available = data.availability();

  // The whole history held: the store's extent, reaching back further when the data source knows more.
  const dataFrom = data.extent()?.from ?? null;
  const whole = useMemo<TimeWindow>(() => ({ from: dataFrom === null ? start : Math.min(start, dataFrom), to: edge }), [start, edge, dataFrom]);

  // The default window (nothing chosen): the recorded activity (controls/frame.ts, activityWindow).
  // It is framed from the spans loaded for the previous default, so it settles in a query or two.
  const activity = useActivity(data, whole);
  const [framedOn, setFramedOn] = useState<readonly TimelineSpan[]>(NO_SPANS);
  const fallback = useMemo(
    () => activityWindow({ whole, dataFrom, density: null, recorded: activity.recorded, spans: framedOn, lastMark: null, followingLive }),
    [whole, dataFrom, activity, framedOn, followingLive],
  );
  const win = resolveWindow(view.window, whole, fallback);

  const fetched = useWindowSpans(data, win);
  const spans = fetched.page?.spans ?? NO_SPANS;
  // The loaded spans feed the default window (derived during render: the next render frames on them).
  if (view.window === null && spans !== framedOn) setFramedOn(spans);

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

  // Regions. The label column's width and the scroll position survive a workspace switch.
  const keep = keptFor(store);
  const [frameRef, frameSize] = useSize<HTMLDivElement>();
  const [measure, size] = useSize<HTMLDivElement>();
  const [gutter, setGutter] = useState(keep.gutter);
  const [bandOpen, setBandOpen] = useState(keep.bandOpen);
  const fullWidth = frameSize.width;
  const timeWidth = Math.max(0, (size.width || fullWidth) - gutter);
  const tracksH = Math.max(0, size.height - RULER_HEIGHT);
  const [scrollTop, setScrollTop] = useState(keep.scrollTop);
  const maxScroll = Math.max(0, layout.totalHeight - tracksH);
  const top = layout.rows.length ? Math.min(scrollTop, maxScroll) : scrollTop;
  useEffect(() => {
    kept.set(store, { scrollTop, gutter, bandOpen });
  }, [store, scrollTop, gutter, bandOpen]);

  const viewport = useMemo<TimelineViewport>(() => ({ window: win, width: timeWidth, liveAt }), [win, timeWidth, liveAt]);

  // ---- the person's actions
  const pendingReveal = useRef<string | null>(null);
  /** The ref whose span was last looked up (once per reveal: a span that never lands in the tree is not asked for again). */
  const loadingSpanFor = useRef<string | null>(null);
  const ownSelection = useRef<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);

  const onWindow = useCallback(
    (next: TimeWindow | null) => {
      pendingReveal.current = null;
      // The overview's "all" (null) and anything as wide as the whole history: all of it, following the live edge.
      store.setTimelineView({ window: clampWindow(next ?? { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY }, whole) });
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
  const spanById = useMemo(() => new Map(spans.map((s) => [s.id, s] as const)), [spans]);
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

  // The keyboard cursor: the canvas moves it, the workspace keeps it; on a span, that span is hovered.
  const [cursor, setCursor] = useState<TimelineCursor | null>(null);
  const onCursor = useCallback(
    (next: TimelineCursor | null) => {
      setCursor(next);
      const span = next?.spanId ? spanById.get(next.spanId) : undefined;
      store.hover(span ? refOf(span) : null);
    },
    [refOf, spanById, store],
  );
  // A cursor on a track that no longer exists (a rebuild, a grouping switch) is dropped.
  const liveCursor = cursor && tree.byId.has(cursor.trackId) ? cursor : null;

  const onLabelSelect = useCallback((node: TrackNode) => selectRef(node.ref), [selectRef]);
  const onGutter = useCallback((w: number) => setGutter(Math.round(Math.max(LABEL_GUTTER, Math.min(MAX_GUTTER, w)))), []);
  const onTableSelect = useCallback((span: TimelineSpan) => selectRef(refOf(span)), [refOf, selectRef]);

  /** From the investigation band: select, seek when a moment is given, and frame it in the Timeline. */
  const onReveal = useCallback(
    (ref: string, at?: number) => {
      if (/^[a-z]+:.+/.test(ref)) store.select(ref as EntityRef, { focus: false });
      if (at !== undefined && Number.isFinite(at)) {
        store.seek(at);
        const next = panToInclude(win, { from: at, to: at });
        if (next !== win) store.setTimelineView({ window: clampWindow(next, whole) });
      }
      ownSelection.current = null;
      pendingReveal.current = ref;
      loadingSpanFor.current = null;
      setRevealTick((t) => t + 1);
    },
    [store, win, whole],
  );

  // ---- revealing a selection made elsewhere (another view, the inspector, "Show in Timeline", 3, F)
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
    // A focus request (Show in Timeline, 3, F) frames the selection even when it did not change.
    const sel = store.getState().selection;
    if (focusNonce && sel) {
      pendingReveal.current = sel;
      loadingSpanFor.current = null;
    }
  }, [focusNonce, store]);
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
          if (ext) {
            const next = panToInclude(win, ext);
            if (next !== win) store.setTimelineView({ window: clampWindow(next, whole) });
          }
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
    // 3. Its span in the window: panned to it keeping the zoom, or framed when it is wider than the window.
    const ext = extentOfSpans(spansOfRef(tree, ref), store.getState().liveAt);
    if (ext) {
      const next = panToInclude(win, ext);
      if (next !== win) store.setTimelineView({ window: clampWindow(next, whole) });
    }
    pendingReveal.current = null;
  }, [tree, layout, selection, focusNonce, revealTick, data, store, whole, win, top, tracksH, maxScroll]);

  // ---- the chosen interval, for the floor: the cells active in a window the person chose
  const explicit = view.window !== null && !isAll(view.window);
  useEffect(() => {
    if (!explicit) {
      store.setHighlightInterval(null);
      return;
    }
    store.setHighlightInterval({ from: win.from, to: win.to, refs: cellsInInterval(spans, win) as EntityRef[] });
  }, [explicit, win, spans, store]);

  // ---- ready for measurement: once the first tracks (or the table, or a designed empty state) are on screen
  const [ready, setReady] = useState(false);
  const settled = !fetched.loading && fetched.page !== null;
  const drawable = view.table || (timeWidth > 0 && tracksH > 0);
  useEffect(() => {
    if (ready || !settled || !drawable) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(id);
  }, [ready, settled, drawable]);

  // ---- states
  const spansUnserved = available.spans === "unavailable";
  const empty = !fetched.loading && fetched.page !== null && fetched.page.total === 0 && spans.length === 0;
  const nothingHere = !fetched.loading && spans.length > 0 && !anyInWindow(tree, win);
  const disconnected = source === "live" && (connection === "disconnected" || connection === "stale" || connection === "reconnecting");
  const bandH = Math.min(MAX_BAND, Math.max(0, Math.round((frameSize.height || 0) * 0.3)));

  return (
    <div ref={frameRef} className="flex h-full min-h-0 flex-col bg-surface" data-timeline-workspace="" data-timeline-ready={ready ? "" : undefined} data-timeline-spans={spans.length}>
      <h2 className="sr-only">Execution Timeline</h2>
      {/* The shared transport, without the docked timeline's collapse button. */}
      <div className="shrink-0">
        <Transport collapsed={false} />
      </div>
      <TimelineToolbar data={data} tree={tree} view={view} onView={store.setTimelineView} spans={spans} drawn={win} whole={whole} lenses={lenses} />

      {disconnected ? (
        <p role="status" className="shrink-0 border-b border-line bg-warning-soft px-3 py-1.5 text-body-sm text-ink">
          Not connected to the observer: showing what was received, up to {utcClock(liveAt)} UTC. Nothing after it is drawn.
        </p>
      ) : null}
      {available.unwindowed ? (
        <p role="status" className="shrink-0 border-b border-line bg-surface-sunken px-3 py-1 text-caption text-ink-muted" data-timeline-unwindowed="">
          This observer cannot read spans by time window: every span it holds is read, whatever the window.
        </p>
      ) : null}
      {fetched.page?.truncated ? (
        <p role="status" className="shrink-0 border-b border-line bg-surface-sunken px-3 py-1.5 text-body-sm text-ink-muted">
          This window holds {fetched.page.total.toLocaleString("en")} spans; {fetched.page.spans.length.toLocaleString("en")} are shown. Narrow the window to see every one.
        </p>
      ) : null}
      {fetched.error && !spansUnserved ? (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-danger-line bg-danger-soft px-3 py-1.5 text-body-sm text-ink">
          <span className="min-w-0 flex-1 truncate">Could not read the spans for this window: {fetched.error}</span>
          <Button size="sm" onClick={fetched.retry}>
            Try again
          </Button>
        </div>
      ) : null}

      {/* A: the whole history, with the brush. The overview draws its own legend column, `gutter` wide, so its plot lines up with the tracks. */}
      <section aria-label="Whole history" className="shrink-0">
        {fullWidth > 0 ? <TemporalOverview data={data} extent={whole} window={win} liveAt={liveAt} width={fullWidth} height={overviewH} gutter={gutter} filters={view.filters} onWindow={onWindow} /> : <div style={{ height: overviewH }} />}
      </section>

      {/* The investigation band, when a lens is on. */}
      {view.lens ? (
        <section aria-label={`Investigation: ${LENS_WORDS[view.lens]}`} className="shrink-0 border-b border-line bg-surface" data-timeline-band="">
          <button
            type="button"
            aria-expanded={bandOpen}
            onClick={() => setBandOpen((o) => !o)}
            className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-label text-ink hover:bg-surface-sunken [&_svg]:size-3.5"
          >
            {bandOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {lenses?.find((l) => l.id === view.lens)?.label ?? LENS_WORDS[view.lens]}
            <span className="text-caption font-normal text-ink-subtle">{bandOpen ? "Hide the lens's findings" : "Show the lens's findings"}</span>
          </button>
          {bandOpen ? (
            <div className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: Math.max(96, bandH) }}>
              {LazyPanel ? (
                <Suspense fallback={<LoadingState label="Preparing the lens" className="px-3 py-2" />}>
                  <LazyPanel lens={view.lens} data={data} tree={tree} spans={spans} viewport={viewport} width={fullWidth} onView={store.setTimelineView} onReveal={onReveal} />
                </Suspense>
              ) : (
                <PanelUnavailable />
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-label={view.table ? "Timeline as a table" : "Tracks"} ref={measure} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* The ruler row: the gutter, then the ruler for the window. Kept with the table too: same window. */}
        <div className="flex shrink-0 border-b border-line" style={{ height: RULER_HEIGHT }}>
          <div className="shrink-0 border-r border-line" style={{ width: gutter }} aria-hidden="true" />
          <div className="min-w-0 flex-1">{timeWidth > 0 ? <WindowRuler viewport={viewport} onWindow={onWindow} /> : null}</div>
        </div>
        {view.table ? (
          <div className="min-h-0 flex-1 overflow-auto" data-timeline-table="">
            {LazyTable ? (
              <Suspense fallback={<LoadingState label="Preparing the table" className="px-4" />}>
                <LazyTable tree={tree} layout={layout} viewport={viewport} onSelect={onTableSelect} onToggle={onToggle} />
              </Suspense>
            ) : (
              <TableUnavailable />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="shrink-0 border-r border-line" style={{ width: gutter }}>
              <TrackLabels layout={layout} height={tracksH} scrollTop={top} width={gutter} onToggle={onToggle} onSelect={onLabelSelect} onResize={onGutter} onScroll={onScroll} />
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
                  cursor={liveCursor}
                  onCursor={onCursor}
                  onScroll={onScroll}
                  onWindow={onWindow}
                  onHover={onHover}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              ) : null}
            </div>
          </div>
        )}
        <StateOverlay
          loading={fetched.loading && fetched.page === null && !spansUnserved}
          unserved={spansUnserved}
          empty={empty}
          nothingHere={nothingHere}
          filtered={hasFilters(view.filters)}
          source={source}
          onShowAll={() => onWindow(null)}
          onClearFilters={() => store.setTimelineView({ filters: NO_FILTERS })}
        />
      </section>
    </div>
  );
}

function hasFilters(f: { tickets: readonly string[]; executions: readonly string[]; slices: readonly string[]; stations: readonly string[]; kinds: readonly string[]; attentionOnly: boolean }): boolean {
  return f.tickets.length + f.executions.length + f.slices.length + f.stations.length + f.kinds.length > 0 || f.attentionOnly;
}

/** The designed states over the tracks: reading, not served, nothing recorded yet, nothing in this window. */
function StateOverlay({ loading, unserved, empty, nothingHere, filtered, source, onShowAll, onClearFilters }: { loading: boolean; unserved: boolean; empty: boolean; nothingHere: boolean; filtered: boolean; source: string; onShowAll: () => void; onClearFilters: () => void }) {
  if (!loading && !unserved && !empty && !nothingHere) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6" style={{ top: RULER_HEIGHT }}>
      <div className="pointer-events-auto mt-10 h-fit max-w-md rounded-md border border-dashed border-line-strong bg-surface px-5 py-4">
        {unserved ? (
          <>
            <p className="text-label text-ink">Spans are not served by this observer</p>
            <p className="mt-1 text-body-sm text-ink-muted">This observer does not answer for spans, so the tracks cannot be drawn. That is not the same as nothing recorded: the Factory Floor and the docked timeline still show the history it serves.</p>
          </>
        ) : loading ? (
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

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
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, LoadingState } from "@mach/ui";
import { entityAt, stableEntityAt, type EntityRef } from "../sim";
import { useSceneStore, useStore, type SceneStore } from "../scene";
import { quantizedEdge } from "../shell/timeline/Timeline";
import { Transport } from "../shell/timeline/Transport";
import { utcClock } from "../shell/vocab";
import {
  NO_FILTERS,
  OVERVIEW_HEIGHT,
  RULER_HEIGHT,
  type Grouping,
  type LensDefinition,
  type SelectGesture,
  type SpanPage,
  type TimelineCursor,
  type TimelineData,
  type TimelineHit,
  type TimelineMark,
  type TimelineSpan,
  type TimelineViewport,
  type TimelineViewState,
  type TimeWindow,
  type TrackNode,
  type TrackTree,
} from "./contract";
import {
  activation,
  activityWindow,
  ancestorsOf,
  anyInWindow,
  cellsInInterval,
  clampWindow,
  extentOfSpans,
  fittingExpansion,
  followingAgain,
  followingZoom,
  frameRevealRef,
  idleSinceOf,
  isAll,
  isPinned,
  leadWindow,
  lensMemos,
  panToInclude,
  pinnedBehind,
  heldAtOf,
  quantizedLiveAt,
  resolveWindow,
  seekTargetOf,
  selectionForSpan,
  spanIdForRef,
  spanLookup,
  spansOfRef,
  switchLens,
  TimelineToolbar,
  transportCompact,
  unionSpans,
  type Activated,
  type SpanSelection,
} from "./controls";
import { TimelineTable, useIdleSummary } from "./a11y";
import { marksAsOf, sharedRecordedExtent, spansAsOf, useTimelineData } from "./data";
import { factoryIntervals } from "./data/factoryIntervals";
import { InvestigationPanel, LENSES } from "./investigate";
import { TemporalOverview } from "./overview";
import { LABEL_DEFAULT, LABEL_MAX, LABEL_MIN, TrackCanvas, TrackLabels, WindowRuler } from "./render";
import { buildTrackTree, defaultExpanded, layoutRows } from "./tracks";

/** The overview is shorter on a short window (design section 3A). */
const SHORT_OVERVIEW = 72;
/**
 * How often new events may re-query the window's spans (L8 of the live run: at 500 ms the tracks alone
 * asked twice a second while busy). Only the data layer's notices (its cursor moved) re-query, never a
 * timer of the workspace's own, never a live-edge step.
 */
const REQUERY_MS = 2000;
/** How often new events may re-read the activity the default window is framed on, and the structure. */
const ACTIVITY_REQUERY_MS = 4000;
/** A re-query of the same range on a notice re-reads the window's marks at most this often (the spans every notice). */
const MARKS_REQUERY_MS = 5000;
const NO_SPANS: readonly TimelineSpan[] = [];
const NO_MARKS: readonly TimelineMark[] = [];

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
    // From the subscription, not from 0 (P1): the mount's own query is the first; a notice the provider
    // gives as the workspace subscribes (it moved while nobody listened) waits `ms`, instead of asking
    // for the same tiles again 40 ms later.
    let last = performance.now();
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
/**
 * Whether the window can be asked for yet. "wait": a live or replay store that has taken in no event and
 * is still connecting: its window is the epoch or the wall clock, not the history, and every answer would
 * be thrown away (on a fresh page that was hundreds of requests in the first second). "empty": the
 * connection is up and the history holds nothing: the answer is empty without asking.
 */
type Hold = "wait" | "empty" | null;
const EMPTY_FETCHED: Fetched = { range: null, page: { spans: [], truncated: false, total: 0, version: "" }, marks: [], loading: false, error: null };

function useWindowSpans(data: TimelineData, win: TimeWindow, hold: Hold = null): Fetched & { retry: () => void } {
  const [fetched, setFetched] = useState<Fetched>({ range: null, page: null, marks: NO_MARKS, loading: true, error: null });
  const dataTick = useDataTick(data, REQUERY_MS);
  const [retries, setRetries] = useState(0);
  const tick = dataTick + retries;
  const inRange = fetched.range !== null && contains(fetched.range, win) && fetched.error === null;
  // What to ask for: a new range only when the window has left the fetched one; else the same range again on a tick.
  const want = inRange && fetched.range ? fetched.range : widen(win);
  const key = hold ? `hold:${hold}` : `${Math.round(want.from)}:${Math.round(want.to)}:${inRange ? "same" : "new"}:${tick}`;
  const asked = useRef("");
  /** The key whose answer is held: any other key is still loading (derived, not set in the effect). */
  const answered = useRef("");
  /** The marks last read, for which range and when: a notice on the same range within MARKS_REQUERY_MS keeps them. */
  const marksHeld = useRef<{ from: number; to: number; at: number; marks: readonly TimelineMark[] } | null>(null);
  useEffect(() => {
    if (asked.current === key) return;
    if (hold) return;
    asked.current = key;
    const ctl = new AbortController();
    const range = want;
    const held = marksHeld.current;
    const keep = held !== null && held.from === range.from && held.to === range.to && performance.now() - held.at < MARKS_REQUERY_MS;
    const marksAsked = keep ? Promise.resolve(held.marks) : data.marks(range, undefined, ctl.signal).catch((e: unknown) => (isAbort(e) ? Promise.reject(e) : NO_MARKS));
    Promise.all([data.spans({ window: range }, ctl.signal), marksAsked]).then(
      ([page, marks]) => {
        if (!ctl.signal.aborted) {
          if (!keep) marksHeld.current = { from: range.from, to: range.to, at: performance.now(), marks };
          answered.current = key;
          setFetched({ range, page, marks, loading: false, error: null });
        }
      },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        answered.current = key;
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
  if (hold === "empty") return { ...EMPTY_FETCHED, retry };
  // eslint-disable-next-line react-hooks/refs -- read to tell an answered key from one still asked for
  return { ...fetched, loading: fetched.loading || answered.current !== key, retry };
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
    sharedRecordedExtent(data, ctl.signal).then(
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

/**
 * The structural spans of the whole history (X4: waves, cells, rounds, executions, workflows and the
 * waits between them), read once and again when the data says it changed (at most every
 * ACTIVITY_REQUERY_MS). An answer at the same version and size as the last keeps the previous object,
 * so nothing downstream rebuilds for it. A provider without `structure()` builds from the window alone.
 */
/** The last structure answered per provider: a workspace mounted again starts from it, settled (P1). */
const lastStructure = new WeakMap<TimelineData, SpanPage>();

function useStructure(data: TimelineData): { page: SpanPage | null; settled: boolean } {
  const tick = useDataTick(data, ACTIVITY_REQUERY_MS);
  const [got, setGot] = useState<{ data: TimelineData; page: SpanPage | null; settled: boolean }>(() => {
    const cached = lastStructure.get(data) ?? null;
    return { data, page: cached, settled: cached !== null };
  });
  useEffect(() => {
    if (typeof data.structure !== "function") return;
    const ctl = new AbortController();
    data.structure(ctl.signal).then(
      (page) => {
        if (ctl.signal.aborted) return;
        lastStructure.set(data, page);
        setGot((g) => (g.data === data && g.page && g.page.version === page.version && g.page.total === page.total && g.page.spans.length === page.spans.length ? (g.settled ? g : { ...g, settled: true }) : { data, page, settled: true }));
      },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        setGot((g) => (g.data === data ? { ...g, settled: true } : { data, page: null, settled: true }));
      },
    );
    return () => ctl.abort();
  }, [data, tick]);
  if (typeof data.structure !== "function") return NO_STRUCTURE;
  return got.data === data ? got : { page: null, settled: false };
}
const NO_STRUCTURE = { page: null, settled: true } as const;

/**
 * What a span selects (X3): its own entity when the history resolves it (`visit:`, `seat:`,
 * `workflow:` and the rest), else its nearest known parent's ref with the span kept as the detail.
 */
function makeSelectionOf(store: SceneStore, spans: readonly TimelineSpan[]) {
  const byId = spanLookup(spans);
  return (span: TimelineSpan): SpanSelection => {
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
    return selectionForSpan(span, byId, known);
  };
}

const REF = /^[a-z]+:.+/;
/** A key naming what a hit points at, for telling a second select of the same thing from a first. */
const hitKey = (hit: TimelineHit): string => (hit.span ? `span:${hit.span.id}` : hit.mark ? `mark:${hit.mark.id}` : "");

/** The last tree built for a data source: the next build starts from it (stable identity, incremental). */
const previousTrees = new WeakMap<TimelineData, TrackTree>();

/**
 * Groupings whose expansion the person has changed, per store: until then the expansion is seeded
 * (the tracks' defaults, opened further while the rows fit: X9), only ever adding; after, it is theirs.
 */
const touched = new WeakMap<SceneStore, Set<Grouping>>();
const touchedFor = (store: SceneStore): Set<Grouping> => {
  let t = touched.get(store);
  if (!t) touched.set(store, (t = new Set()));
  return t;
};

/** Scroll position, label column width and the band's state, per store: kept across workspace switches. */
interface Kept {
  scrollTop: number;
  gutter: number;
}
const kept = new WeakMap<SceneStore, Kept>();
function keptFor(store: SceneStore): Kept {
  return kept.get(store) ?? { scrollTop: 0, gutter: LABEL_DEFAULT };
}

// ---------------------------------------------------------------- the workspace

/**
 * Rebuild triggers (the performance guard: nothing here rebuilds per frame or per hover):
 * - the tree: the spans (a new window fetch or structural answer, each throttled by the data's
 *   notifications: REQUERY_MS / ACTIVITY_REQUERY_MS), the grouping, the filters, and the quantized
 *   live edge (at most 1/1000 of the history per step, rounded down);
 * - the layout: the tree and the expansion;
 * - the window: the person's choice, or the default (the recorded activity, or the simulation's
 *   lead window) which moves only with the quantized edge;
 * Hover goes to the store (store.hover) and never reaches these memos; the playhead is read by the
 * toolbar's caption alone (useAsOf, which changes only when the playhead is behind and moves a second).
 */
export function TimelineWorkspace({ data: given }: { readonly data?: TimelineData } = {}) {
  const store = useStore();
  const provided = useTimelineData();
  const data = given ?? provided;
  const lenses: readonly LensDefinition[] = LENSES;
  const view = useSceneStore((s) => s.timeline);
  const source = useSceneStore((s) => s.source);
  const connection = useSceneStore((s) => s.connection?.state ?? null);
  const followingLive = useSceneStore((s) => s.source === "live" && s.following);
  const selection = useSceneStore((s) => s.selection);
  const focusNonce = useSceneStore((s) => (s.focus && s.focus.target !== "overview" ? s.focus.nonce : 0));
  const liveAt = useSceneStore(quantizedLiveAt);
  // M6.6 (I-04): scrubbed back, the tracks, their words, the table and the lenses are held at the
  // playhead (rounded down), as the inspector is; null when they show what is held up to the live edge.
  const heldAt = useSceneStore(heldAtOf);
  /** The moment the tracks speak as of: the playhead when held there, else the live edge. */
  const shownAt = heldAt ?? liveAt;
  // M6.6 (reliability 3): the Factory's disabled and paused stretches, read once per log version and
  // cut at the playhead like everything else here.
  const logVersion = useSceneStore((s) => s.log.version());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- logVersion stands for the log's contents
  const factoryStretches = useMemo(() => factoryIntervals(store.getState().log.entries(), heldAt), [store, logVersion, heldAt]);
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
  // The simulation's run is recorded from the start (its future is only hidden): its default runs from
  // the start to just past what is revealed (X9), the whole run once all of it is.
  const fallback = useMemo(
    () => (source === "simulation" ? leadWindow(whole, liveAt) : activityWindow({ whole, dataFrom, density: null, recorded: activity.recorded, spans: framedOn, lastMark: null, followingLive })),
    [source, whole, liveAt, dataFrom, activity, framedOn, followingLive],
  );
  const win = resolveWindow(view.window, whole, fallback);

  // The provider's own extent: null while it holds nothing of the history (an observer before its first event).
  const hold: Hold = source !== "live" || dataFrom !== null ? null : connection === "connecting" || connection === "reconnecting" ? "wait" : "empty";
  const fetched = useWindowSpans(data, win, hold);
  const structure = useStructure(data);
  /** The window's spans or the structure still arriving: rows may yet be added above a revealed one. */
  const fetchedLoading = fetched.loading || !structure.settled;
  const windowSpans = fetched.page?.spans ?? NO_SPANS;
  // X4: the tree is built from the whole history's structural spans and the window's detailed ones,
  // so a track's identity and place do not depend on which window was loaded (a fresh `win=` deep link
  // builds the same tree as navigating there).
  const structural = structure.page?.spans ?? NO_SPANS;
  const allSpans = useMemo(() => unionSpans(structural, windowSpans), [structural, windowSpans]);
  // The loaded spans feed the default window (derived during render: the next render frames on them).
  if (view.window === null && allSpans !== framedOn) setFramedOn(allSpans);
  // What had happened by the playhead (I-04): nothing begun after it, nothing ended or decided after it.
  const spans = useMemo(() => (heldAt === null ? allSpans : spansAsOf(allSpans, heldAt)), [allSpans, heldAt]);
  const marks = useMemo(() => (heldAt === null ? fetched.marks : marksAsOf(fetched.marks, heldAt)), [fetched.marks, heldAt]);

  // The tree, rebuilt from the previous one so track identity (expansion, scroll, selection) survives.
  // Kept per data source, outside the component, so a workspace switch keeps it too.
  const tree = useMemo(() => buildTrackTree(spans, view.grouping, view.filters, shownAt, previousTrees.get(data)), [data, spans, view.grouping, view.filters, shownAt]);
  useEffect(() => {
    previousTrees.set(data, tree);
  }, [data, tree]);

  const expanded = useMemo(() => new Set(view.expanded), [view.expanded]);
  const layout = useMemo(() => layoutRows(tree, expanded), [tree, expanded]);

  // Regions. The label column's width and the scroll position survive a workspace switch.
  const keep = keptFor(store);
  const [frameRef, frameSize] = useSize<HTMLDivElement>();
  const [measure, size] = useSize<HTMLDivElement>();
  const [gutter, setGutter] = useState(keep.gutter);
  const fullWidth = frameSize.width;
  const timeWidth = Math.max(0, (size.width || fullWidth) - gutter);
  const tracksH = Math.max(0, size.height - RULER_HEIGHT);
  const [scrollTop, setScrollTop] = useState(keep.scrollTop);
  const maxScroll = Math.max(0, layout.totalHeight - tracksH);
  const top = layout.rows.length ? Math.min(scrollTop, maxScroll) : scrollTop;
  useEffect(() => {
    kept.set(store, { scrollTop, gutter });
  }, [store, scrollTop, gutter]);

  // Expansion (X9): until the person opens or closes a row in this grouping, the tracks' defaults,
  // opened level by level (waves, slices, cells; or executions) while every row fits the tracks'
  // height. Only ever adds. Re-run only when the tree gains or loses rows (its size), never per step.
  const treeSize = tree.byId.size;
  useEffect(() => {
    if (!tree.roots.length || tracksH <= 0 || touchedFor(store).has(tree.grouping)) return;
    const current = store.getState().timeline.expanded;
    const base = [...new Set([...current, ...defaultExpanded(tree)])];
    const want = fittingExpansion(tree, base, tracksH, (open) => layoutRows(tree, open).totalHeight);
    const add = want.filter((id) => !current.includes(id));
    if (add.length) store.setTimelineView({ expanded: [...current, ...add] });
    // `tree` is read as of its size: a rebuild with the same rows changes nothing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeSize, tree.grouping, tracksH, store]);

  const viewport = useMemo<TimelineViewport>(() => ({ window: win, width: timeWidth, liveAt: shownAt }), [win, timeWidth, shownAt]);

  // ---- the person's actions
  const pendingReveal = useRef<string | null>(null);
  /** The ref whose span was last looked up (once per reveal: a span that never lands in the tree is not asked for again). */
  const loadingSpanFor = useRef<string | null>(null);
  /** A reveal asked for by a lens's Frame: its rows are brought into view, the framed window is not panned. */
  const frameOnly = useRef<string | null>(null);
  const ownSelection = useRef<string | null>(null);
  /**
   * The row a reveal brought into view, kept in view for a few seconds while the first mount still
   * changes the rows above it (the default expansion, rows that arrive late): until the person scrolls,
   * opens or closes a row, or another reveal begins.
   */
  const anchor = useRef<{ trackId: string; until: number } | null>(null);
  const [revealTick, setRevealTick] = useState(0);

  const drawnRef = useRef(win);
  useEffect(() => {
    drawnRef.current = win;
  });
  const onWindow = useCallback(
    (next: TimeWindow | null) => {
      pendingReveal.current = null;
      // Round 6, defect 8: a zoom (wheel, keys) while following the live edge stays anchored on it and
      // keeps following; a pan, or a drag of the window's right end, pins as before.
      const drawn = drawnRef.current;
      const s = store.getState();
      const kept = next && Math.abs(next.from - drawn.from) > 1 ? followingZoom(drawn, next.to - next.from, whole, s.source === "live" && s.following) : null;
      // The overview's "all" (null) and anything as wide as the whole history: all of it, following the live edge.
      store.setTimelineView({ window: kept ?? clampWindow(next ?? { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY }, whole) });
    },
    [store, whole],
  );
  const onScroll = useCallback(
    (y: number) => {
      pendingReveal.current = null;
      anchor.current = null;
      setScrollTop(Math.max(0, Math.min(maxScroll, y)));
    },
    [maxScroll],
  );
  const onToggle = useCallback(
    (id: string) => {
      touchedFor(store).add(store.getState().timeline.grouping);
      anchor.current = null;
      const current = store.getState().timeline.expanded;
      store.setTimelineView({ expanded: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] });
    },
    [store],
  );
  const selectionOf = useMemo(() => makeSelectionOf(store, spans), [store, spans]);
  const refOf = useCallback((span: TimelineSpan) => selectionOf(span).ref as EntityRef | null, [selectionOf]);
  const spanById = useMemo(() => new Map(spans.map((s) => [s.id, s] as const)), [spans]);
  const selectRef = useCallback(
    (ref: EntityRef | null, detail?: string | null) => {
      ownSelection.current = ref;
      store.select(ref, { focus: false, detail: detail ?? null });
    },
    [store],
  );
  /** "Go to": seek the playhead to a span's start or a mark's moment (by its event when the history holds it). */
  const goTo = useCallback(
    (hit: TimelineHit) => {
      const target = seekTargetOf(hit);
      if (!target) return;
      if (target.eventId && store.getState().log.entry(target.eventId)) store.seekToEvent(target.eventId);
      else store.seek(target.at);
    },
    [store],
  );
  /** The last thing selected from the tracks or the table, and the selection it made. */
  const lastActivated = useRef<Activated | null>(null);
  /**
   * X13: selecting never seeks. A second select of the same span or mark (Enter twice, the second
   * click of a double-click) while it is still the selection is "go to": the playhead seeks there, and
   * the transport's live control says it is reviewing an earlier moment.
   */
  const activate = useCallback(
    (hit: TimelineHit, sel: SpanSelection, how: SelectGesture = "key") => {
      const key = hitKey(hit);
      if (activation(lastActivated.current, key, store.getState().selection, how) === "seek") {
        goTo(hit);
        return;
      }
      lastActivated.current = { key, selection: sel.ref ?? store.getState().selection };
      if (sel.ref) selectRef(sel.ref as EntityRef, sel.detail);
    },
    [goTo, selectRef, store],
  );
  const selectSpan = useCallback((span: TimelineSpan, how?: SelectGesture) => activate({ trackId: "", lane: 0, span, mark: null, count: 1, from: span.start?.at ?? 0, to: span.end?.at ?? 0 }, selectionOf(span), how), [activate, selectionOf]);
  const onHover = useCallback(
    (hit: TimelineHit | null) => {
      const ref = hit?.span ? refOf(hit.span) : hit?.mark?.entity && REF.test(hit.mark.entity) ? (hit.mark.entity as EntityRef) : null;
      store.hover(ref);
    },
    [refOf, store],
  );
  const onSelect = useCallback(
    (hit: TimelineHit, how?: SelectGesture) => {
      if (hit.span) {
        activate(hit, selectionOf(hit.span), how);
        return;
      }
      if (hit.mark) {
        const m = hit.mark;
        activate(hit, { ref: m.entity && REF.test(m.entity) ? m.entity : null, detail: null }, how);
        return;
      }
      // An aggregate of spans too small to draw one by one: zoom to it.
      if (hit.count > 0 && hit.to > hit.from) onWindow({ from: hit.from, to: hit.to });
    },
    [activate, onWindow, selectionOf],
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
  const onGutter = useCallback((w: number) => setGutter(Math.round(Math.max(LABEL_MIN, Math.min(LABEL_MAX, w)))), []);
  const onTableSelect = selectSpan;

  /**
   * From the investigation band: select by the same rule as a click on the tracks (X3: the span's own
   * ref when the history resolves it, else its nearest known ref with the span as the detail), seek when
   * a moment is given (the band's items are "go to"), and frame it in the Timeline.
   */
  const spanByEntity = useMemo(() => spanLookup(spans), [spans]);
  const onReveal = useCallback(
    (ref: string, at?: number) => {
      const span = spanByEntity.get(ref);
      if (span) {
        const sel = selectionOf(span);
        if (sel.ref) store.select(sel.ref as EntityRef, { focus: false, detail: sel.detail });
      } else if (REF.test(ref)) store.select(ref as EntityRef, { focus: false });
      if (at !== undefined && Number.isFinite(at)) {
        store.seek(at);
        const next = panToInclude(win, { from: at, to: at });
        if (next !== win) store.setTimelineView({ window: clampWindow(next, whole) });
      }
      ownSelection.current = null;
      pendingReveal.current = ref;
      frameOnly.current = null;
      loadingSpanFor.current = null;
      setRevealTick((t) => t + 1);
    },
    [selectionOf, spanByEntity, store, win, whole],
  );

  /**
   * After a lens's Frame (the window already set to the framed interval): the rows it concerns are
   * brought into view by the same reveal as a selection (ancestors expanded, scrolled to), with no
   * selection, no seek, and the framed window kept (`frameOnly`: step 3 does not pan).
   */
  const onFrameRows = useCallback(
    (refs: readonly string[]) => {
      const ref = frameRevealRef(refs, (r) => tree.tracksOf(r).length > 0);
      if (!ref) return;
      frameOnly.current = ref;
      pendingReveal.current = ref;
      loadingSpanFor.current = null;
      setRevealTick((t) => t + 1);
    },
    [tree],
  );

  // ---- revealing a selection made elsewhere (another view, the inspector, "Show in Timeline", 3, F)
  useEffect(() => {
    if (!selection) {
      pendingReveal.current = null;
      return;
    }
    if (selection !== ownSelection.current) {
      pendingReveal.current = selection;
      frameOnly.current = null;
      loadingSpanFor.current = null;
    }
    ownSelection.current = null;
  }, [selection]);
  useEffect(() => {
    // A focus request (Show in Timeline, 3, F) frames the selection even when it did not change.
    const sel = store.getState().selection;
    if (focusNonce && sel) {
      pendingReveal.current = sel;
      frameOnly.current = null;
      loadingSpanFor.current = null;
    }
  }, [focusNonce, store]);
  useEffect(() => {
    const ref = pendingReveal.current;
    if (!ref) {
      // A row revealed moments ago: kept in view while rows above it are still being added.
      const a = anchor.current;
      if (!a) return;
      if (Date.now() > a.until) {
        anchor.current = null;
        return;
      }
      const row = layout.rowOf(a.trackId);
      if (row && tracksH > 0 && (row.y < top || row.y + row.height > top + tracksH)) setScrollTop(Math.max(0, Math.min(maxScroll, row.y - tracksH / 3)));
      return;
    }
    anchor.current = null;
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
          const ext = frameOnly.current === ref ? null : extentOfSpans([span], store.getState().liveAt);
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
    // 2. Scrolled into view. Not yet laid out or measured (the workspace just mounted, as when Analytics
    //    opens an entity here): wait for the next layout rather than give the reveal up with the rows at the top.
    const row = layout.rowOf(trackId);
    if (!row || tracksH <= 0) return;
    if (row.y < top || row.y + row.height > top + tracksH) {
      const to = Math.max(0, Math.min(maxScroll, row.y - tracksH / 3));
      setScrollTop(to);
      // The scroll range may not have grown to the expanded rows yet: stay pending until the row fits.
      if (row.y + row.height > to + tracksH) return;
    }
    // 3. Its span in the window: panned to it keeping the zoom, or framed when it is wider than the
    //    window. Not after a lens's Frame: the window is the framed interval the person asked for.
    const ext = frameOnly.current === ref ? null : extentOfSpans(spansOfRef(tree, ref), store.getState().liveAt);
    if (ext) {
      const next = panToInclude(win, ext);
      if (next !== win) store.setTimelineView({ window: clampWindow(next, whole) });
    }
    // The window's spans still loading can add rows above this one and move it: stay pending until they are in.
    if (fetchedLoading) return;
    anchor.current = { trackId, until: Date.now() + 5000 };
    pendingReveal.current = null;
    frameOnly.current = null;
  }, [tree, layout, selection, focusNonce, revealTick, data, store, whole, win, top, tracksH, maxScroll, fetchedLoading]);

  // ---- L1: following and a pinned window are never both claimed.
  // A pinned window the live edge has passed says so in the toolbar ("Window pinned · live edge is 3 min
  // ahead — Follow") and takes the camera-follow claim off the transport; "Return to live" (L, End), the
  // transport's follow chip and "Follow" give the following window back.
  const live = source === "live";
  const aheadRaw = live ? pinnedBehind(view.window, win, liveAt) : null;
  // Rounded to 10 s: the words change slowly; nothing re-renders per live-edge step for it.
  const ahead = aheadRaw === null ? null : Math.max(1000, Math.round(aheadRaw / 10_000) * 10_000);
  const followAgain = useCallback(() => {
    const s = store.getState();
    if (!isPinned(s.timeline.window)) return;
    store.setTimelineView({ window: followingAgain(win, s.timeline.lens !== null) });
  }, [store, win]);
  const onFollow = useCallback(() => {
    followAgain();
    if (!store.getState().follow) store.setFollow(true);
  }, [followAgain, store]);
  const pinned = useMemo(() => (ahead === null ? null : { ahead, onFollow }), [ahead, onFollow]);
  // L1 (iv): live with nothing running, the transport's live-state says since when, so the default
  // window (framed on the recorded activity) is never read as the tracks tracking the clock.
  const idleSince = useMemo(() => (live ? idleSinceOf(spans, activity.recorded) : null), [live, spans, activity.recorded]);
  const cameraFollow = useSceneStore((s) => s.follow);
  const liveReturns = useSceneStore((s) => s.liveReturns);
  const seen = useRef({ cameraFollow, liveReturns });
  useEffect(() => {
    const was = seen.current;
    seen.current = { cameraFollow, liveReturns };
    if (!live) return;
    if (liveReturns !== was.liveReturns || (cameraFollow && !was.cameraFollow)) {
      followAgain();
      return;
    }
    if (cameraFollow && ahead !== null) store.setFollow(false);
  }, [live, cameraFollow, liveReturns, ahead, followAgain, store]);

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
  // Both the window's spans and the whole history's structure have answered (X4: the tree is final).
  const settled = !fetched.loading && (fetched.page !== null || fetched.error !== null) && structure.settled;
  const drawable = view.table || (timeWidth > 0 && tracksH > 0);
  useEffect(() => {
    if (ready || !settled || !drawable) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(id);
  }, [ready, settled, drawable]);

  // ---- states
  const spansUnserved = available.spans === "unavailable";
  const filtered = hasFilters(view.filters);
  const empty = !fetched.loading && fetched.page !== null && fetched.page.total === 0 && allSpans.length === 0;
  // Spans are held, but the filters leave no track at all.
  const filteredOut = !fetched.loading && !empty && filtered && spans.length > 0 && tree.roots.length === 0;
  const nothingHere = !fetched.loading && !filteredOut && spans.length > 0 && !anyInWindow(tree, win);
  const link = source === "live" && (connection === "disconnected" || connection === "stale" || connection === "reconnecting" || connection === "no-session") ? connection : null;
  // Re-reading the window while the previous answer stays on screen.
  const refreshing = fetched.loading && fetched.page !== null;

  // ---- accessibility: the window in words (aria-describedby of the tracks), and Escape out of the band
  const summaryId = useId();
  // Worded when the browser is idle, keyed on the tree and the window, never per live-edge step (A5, R5).
  const summary = useIdleSummary(tree, win, shownAt, false);
  const tracksBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The canvas names its keys in aria-describedby; the window's summary is added beside them.
    const app = tracksBox.current?.querySelector<HTMLElement>("[role=application]");
    if (!app) return;
    const ids = (app.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    if (!ids.includes(summaryId)) app.setAttribute("aria-describedby", [...ids, summaryId].join(" "));
  });
  /** The band's own changes; closing the lens there gives back the filters and grouping it set, as the toolbar's "No lens" does. */
  const onBandView = useCallback(
    (patch: Partial<TimelineViewState>) => {
      if (patch.lens === null && store.getState().timeline.lens !== null) {
        const next = switchLens(null, tree, store.getState().timeline, win, lensMemos.get(store));
        lensMemos.delete(store);
        store.setTimelineView({ ...patch, ...next.patch });
        return;
      }
      store.setTimelineView(patch);
    },
    [store, tree, win],
  );
  const onBandKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    const button = document.querySelector<HTMLElement>("[data-timeline-workspace] [data-timeline-investigate]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    button.focus();
  }, []);

  return (
    <div
      ref={frameRef}
      className="flex h-full min-h-0 flex-col bg-surface"
      data-timeline-workspace=""
      data-timeline-ready={ready ? "" : undefined}
      data-timeline-spans={allSpans.length}
      data-timeline-held-at={heldAt ?? undefined}
      data-timeline-window={`${Math.round(win.from)}-${Math.round(win.to)}`}
      data-timeline-grouping={view.grouping}
    >
      <h2 className="sr-only">Execution Timeline</h2>
      {/* The shared transport, without the docked timeline's collapse button. */}
      <div className="shrink-0">
        <Transport collapsed={false} idleSince={idleSince} compact={transportCompact(fullWidth)} />
      </div>
      <TimelineToolbar data={data} tree={tree} view={view} onView={store.setTimelineView} spans={spans} drawn={win} whole={whole} lenses={lenses} pinned={pinned} />

      {link ? <LinkNotice state={link} liveAt={liveAt} /> : null}
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
        {fullWidth > 0 && hold !== "wait" ? <TemporalOverview data={data} extent={whole} window={win} liveAt={liveAt} width={fullWidth} height={overviewH} gutter={gutter} filters={view.filters} onWindow={onWindow} /> : <div style={{ height: overviewH }} />}
      </section>

      {/* The investigation band, when a lens is on. */}
      {/* The investigation band, when a lens is on: the panel draws its own header, collapse and close (at most 220 px). Escape returns to Investigate. */}
      {view.lens ? (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="shrink-0" data-timeline-band={view.lens} onKeyDown={onBandKey}>
          <InvestigationPanel lens={view.lens} data={data} tree={tree} spans={spans} viewport={viewport} heldAt={heldAt} width={fullWidth} onView={onBandView} onReveal={onReveal} onFrameRows={onFrameRows} />
        </div>
      ) : null}

      <section aria-label={view.table ? "Timeline as a table" : "Tracks"} ref={measure} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* The ruler row: the gutter, then the ruler for the window. Kept with the table too: same window. */}
        <div className="flex shrink-0 border-b border-line" style={{ height: RULER_HEIGHT }}>
          <div className="shrink-0 border-r border-line" style={{ width: gutter }} aria-hidden="true" />
          <div className="min-w-0 flex-1">{timeWidth > 0 ? <WindowRuler viewport={viewport} onWindow={onWindow} factory={factoryStretches} /> : null}</div>
        </div>
        {view.table ? (
          <div className="min-h-0 flex-1 overflow-auto" data-timeline-table="">
            <TimelineTable tree={tree} layout={layout} viewport={viewport} onSelect={onTableSelect} onToggle={onToggle} />
          </div>
        ) : (
          // The canvas comes first in the document so the tracks are reached by Tab before the label
          // column's resize separator (the label buttons are not Tab stops: the canvas keys cover them);
          // the row is reversed so the labels still sit on the left.
          <div className="flex min-h-0 flex-1 flex-row-reverse">
            <div ref={tracksBox} className="relative min-w-0 flex-1">
              {timeWidth > 0 && tracksH > 0 ? (
                <TrackCanvas
                  tree={tree}
                  layout={layout}
                  viewport={viewport}
                  marks={marks}
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
                  defaultWindow={fallback}
                />
              ) : null}
              <p id={summaryId} className="sr-only" aria-live="off" data-timeline-summary="">
                {summary}
              </p>
            </div>
            <div className="shrink-0 border-r border-line" style={{ width: gutter }}>
              <TrackLabels layout={layout} height={tracksH} scrollTop={top} width={gutter} onToggle={onToggle} onSelect={onLabelSelect} onResize={onGutter} onScroll={onScroll} />
            </div>
          </div>
        )}
        {refreshing ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 h-0.5 animate-pulse bg-accent" style={{ top: RULER_HEIGHT - 1 }} data-timeline-refreshing="" /> : null}
        <StateOverlay
          loading={fetched.loading && fetched.page === null && !spansUnserved}
          unserved={spansUnserved}
          empty={empty}
          filteredOut={filteredOut}
          nothingHere={nothingHere}
          filtered={filtered}
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

/**
 * The observer link, when it is not live (X23). Stale: answers have stopped arriving but the link is
 * open; reconnecting and disconnected: the link is down and being retried; no session: the one-time
 * link was used up. In each case what was received stays drawn, and nothing after it is.
 */
function LinkNotice({ state, liveAt }: { state: "stale" | "reconnecting" | "disconnected" | "no-session"; liveAt: number }) {
  const upTo = `${utcClock(liveAt)} UTC`;
  const words =
    state === "stale"
      ? { title: "The observer has gone quiet", body: `Nothing new has arrived for a while. The tracks show what was received, up to ${upTo}; nothing after it is drawn.` }
      : state === "reconnecting"
        ? { title: "Reconnecting to the observer", body: `The tracks show what was received, up to ${upTo}. They catch up when the link is back.` }
        : state === "no-session"
          ? { title: "This page's observer session has ended", body: `The tracks show what was received, up to ${upTo}. Open a new link from the observer to see more.` }
          : { title: "Not connected to the observer", body: `Still trying. The tracks show what was received, up to ${upTo}; nothing after it is drawn.` };
  return (
    <p role="status" className="flex shrink-0 items-baseline gap-2 border-b border-warning-line bg-warning-soft px-3 py-1.5 text-body-sm text-ink" data-timeline-link={state}>
      <span className="shrink-0 font-semibold">{words.title}.</span>
      <span className="min-w-0 truncate text-ink-muted" title={words.body}>
        {words.body}
      </span>
    </p>
  );
}

/** The designed states over the tracks: reading, not served, nothing recorded yet, filtered to nothing, nothing in this window. */
function StateOverlay({ loading, unserved, empty, filteredOut, nothingHere, filtered, source, onShowAll, onClearFilters }: { loading: boolean; unserved: boolean; empty: boolean; filteredOut: boolean; nothingHere: boolean; filtered: boolean; source: string; onShowAll: () => void; onClearFilters: () => void }) {
  if (!loading && !unserved && !empty && !filteredOut && !nothingHere) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6" style={{ top: RULER_HEIGHT }} data-timeline-state={unserved ? "unserved" : loading ? "loading" : empty ? "empty" : filteredOut ? "filtered" : "nothing-here"}>
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
            <p className="text-label text-ink">No execution recorded yet</p>
            <p className="mt-1 text-body-sm text-ink-muted">
              {source === "live" ? "Spans appear here as the Factory records work: waves, cells, station visits, executions and their agents." : "This history holds no span to draw."}
            </p>
          </>
        ) : filteredOut ? (
          <>
            <p className="text-label text-ink">Nothing matches these filters</p>
            <p className="mt-1 text-body-sm text-ink-muted">Work is recorded in what is held, but no track matches every filter chosen.</p>
            <Button size="sm" className="mt-3" onClick={onClearFilters}>
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <p className="text-label text-ink">Nothing recorded in this window</p>
            <p className="mt-1 text-body-sm text-ink-muted">{filtered ? "Nothing that matches the filters lies in this window; the history holds some before or after it." : "The history holds spans before or after it."}</p>
            <Button size="sm" className="mt-3" onClick={onShowAll}>
              Show all
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

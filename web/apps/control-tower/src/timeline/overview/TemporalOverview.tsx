/**
 * The temporal overview (docs/mach-next/M6_3_DESIGN.md, section 3A): the navigation instrument for
 * the whole held history, never zoomed. One canvas for density, activity, landmarks and the time
 * axis; DOM for the brush (the detailed window), the playhead, the live edge, the legend and what
 * assistive technology reads.
 *
 * The brush: drag inside to move, drag an edge to resize, drag on the empty overview to draw a new
 * window, click outside it to centre it there, double-click to show everything, wheel to zoom about
 * the pointer. Alt with a click or drag seeks the playhead instead. Keyboard: a group of three
 * sliders (window start, window end, move window). A window covering everything is reported as
 * `null`, so a live window keeps growing with the edge.
 *
 * The playhead and the live edge are written to the DOM from the store on every frame
 * (`usePlayheadEffect`); nothing here re-renders per frame.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { cn, useTheme } from "@mach/ui";
import { isStale, useSceneStore, useStore } from "../../scene";
import { setScrubbing } from "../../shell/scrub";
import { spokenTime, timecode, getTimeBase, utcClock } from "../../shell/time";
import { usePlayheadEffect } from "../../shell/timeline/playhead";
import "../../shell/shell.css";
import { MIN_WINDOW_MS, type TemporalOverviewProps, type TimeWindow } from "../contract";
import { activityY, drawOverview, overviewLayout, readOverviewPalette, type ActivityLayer, type TailLayer } from "./draw";
import {
  afterLabelLeft,
  aggregateMarks,
  brokenAxis,
  centreWindow,
  compressByDefault,
  idleGaps,
  inferredOf,
  inferredPeak,
  lastFromRecorded,
  windowFromU,
  windowToU,
  uOf,
  type Axis,
  chooseTicks,
  concurrencySteps,
  concurrencyUnavailable,
  densityColumns,
  describeColumn,
  describeWindow,
  historyWords,
  windowAsOf,
  familyCounts,
  idleTail,
  isWhole,
  keyStep,
  lastRecorded,
  lastRecordedWords,
  lengthWords,
  limitSegments,
  moveWindow,
  peakWords,
  placeLimitLabels,
  resizeWindow,
  tOf,
  trimTrailingZero,
  waitWords,
  windowBetween,
  windowWords,
  xOf,
  zoomWindow,
  type Box,
  type BrushPart,
  type MarkPoint,
  overviewAsOf,
  AFTER_NOT_SHOWN,
} from "./model";
import { useOverviewData } from "./useOverviewData";
import { sharedRecordedExtent } from "../data";
import { asOfPlayhead, heldAtOf } from "../controls/frame";

/** Room on the right so the end handle can be grabbed at the live edge. */
const RIGHT_PAD = 12;
/** The width of the overview's "after the playhead" words (10 px sans), with their padding. */
const AFTER_LABEL_W = 92;
/** The room the live edge's "now" takes before the edge. */
const NOW_CHIP_W = 30;
/** Below this total width the legend is left out (the plot still starts at the caller's gutter). */
const LEGEND_MIN_WIDTH = 720;
/** Pixels a press must travel before it is a drag. */
const DRAG_PX = 4;
const DOUBLE_CLICK_MS = 450;
/** During a brush drag the window is reported at most this often; the brush itself follows every frame. */
export const DRAG_COMMIT_MS = 120;
const HANDLE_W = 24;

interface Drag {
  readonly mode: "start" | "end" | "move" | "draw" | "seek";
  readonly pointerId: number;
  readonly x0: number;
  readonly t0: number;
  readonly win0: TimeWindow;
  moved: boolean;
  /** Where the brush is drawn now; reported to the caller at most every DRAG_COMMIT_MS. */
  live: TimeWindow | null;
  sent: TimeWindow | null;
  sentAt: number;
  timer: number | null;
}

interface Tip {
  /** Viewport coordinates: the pointer's x, and the plot's top and bottom. */
  readonly ax: number;
  readonly top: number;
  readonly bottom: number;
  readonly title: string;
  readonly lines: readonly string[];
}

/** One 2D context for measuring label text before drawing (placement feeds the legend). */
let measureCtx: CanvasRenderingContext2D | null = null;
function labelMeasure(): (text: string) => number {
  if (typeof document === "undefined") return (t) => t.length * 6;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  if (!ctx) return (t) => t.length * 6;
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--mach-font-mono").trim() || "monospace";
  ctx.font = `500 10px ${mono}`;
  return (t) => ctx.measureText(t).width;
}

export function TemporalOverview({ data, extent, window: win, liveAt, width, height, filters, gutter, onWindow }: TemporalOverviewProps) {
  const store = useStore();
  const { resolved: theme } = useTheme();
  const connection = useSceneStore((s) => s.connection);
  const source = useSceneStore((s) => s.source);
  const stale = isStale(connection);

  // The plot starts where the tracks' time axis starts: at the caller's gutter. The legend fills that
  // column when there is width for it; the overview draws no column of its own.
  const lead = Math.max(0, Math.round(gutter));
  const legend = width >= LEGEND_MIN_WIDTH && lead > 0;
  const pw = Math.max(0, Math.floor(width - lead - RIGHT_PAD));
  const L = overviewLayout(height);
  const wall = getTimeBase() === "wall" || source !== "simulation";
  const clock = useCallback((t: number) => (wall ? utcClock(t) : timecode(t, false)), [wall]);

  const fetched = useOverviewData(data, extent, pw, filters);
  // M6.6 (I-04): held at the playhead (reveal off), nothing after it is drawn or said: the series are
  // cut there and the stretch after it is plain extent the brush still moves over.
  const heldAt = useSceneStore(heldAtOf);
  const got = useMemo(() => (heldAt === null ? fetched : overviewAsOf(fetched, heldAt)), [fetched, heldAt]);
  /** The moment marks and waits are drawn to: the playhead when held there, else the live edge. */
  const shownAt = heldAt ?? liveAt;
  const fetchedLast = useRecordedLast(data, fetched.density);
  const recorded = heldAt === null ? fetchedLast : null;

  // ------------------------------------------------------------ the axis (X10: idle time compressed)
  // The axis is the whole history's, held or not, so the brush and the strip do not change shape while
  // scrubbing; held at the playhead, a break after it is drawn without its words (nothing is said there).
  const gaps = useMemo(() => idleGaps(fetched.density, fetched.marks, extent), [fetched.density, fetched.marks, extent]);
  const [compressPref, setCompressPref] = useState<boolean | null>(null);
  const compress = gaps.length > 0 && (compressPref ?? compressByDefault(gaps, extent));
  const axis: Axis = useMemo(() => (compress ? brokenAxis(extent, gaps, pw) : extent), [compress, extent, gaps, pw]);
  const breakLayer = useMemo(() => (axis.breaks ?? []).map((b) => ({ x0: xOf(b.from, axis, pw), x1: xOf(b.to, axis, pw), label: heldAt !== null && b.to > heldAt ? "" : lengthWords(b.to - b.from), from: b.from, to: b.to })), [axis, pw, heldAt]);
  // The brush's edges, which a break's length or the idle tail's words must not run under (round 6,
  // defect 13). The canvas is redrawn when the window's edges move a whole pixel.
  const edge0 = Math.round(xOf(Math.max(extent.from, win.from), axis, pw));
  const edge1 = Math.round(xOf(Math.min(extent.to, win.to), axis, pw));
  const brushEdges = useMemo(() => [edge0, edge1], [edge0, edge1]);

  // ------------------------------------------------------------ derived drawing (pixel space)
  const density = useMemo(() => (got.density ? densityColumns(got.density, axis, pw) : null), [got.density, axis, pw]);
  const noActivity = concurrencyUnavailable(got.concurrency);
  const marks = useMemo(() => aggregateMarks(got.marks, axis, pw, shownAt), [got.marks, axis, pw, shownAt]);
  const ticks = useMemo(() => chooseTicks(axis, pw, wall, L.compact ? 76 : 84).ticks, [axis, pw, wall, L.compact]);

  // The idle tail: from the last recorded event to the live edge, drawn quiet and named once. The last
  // record's time is exact when the data layer knows it; else only its bucket, said as "between" (X11).
  const last = useMemo(() => lastFromRecorded(recorded, liveAt) ?? lastRecorded(got.density, got.marks, liveAt), [recorded, got.density, got.marks, liveAt]);
  const tail = useMemo((): (TailLayer & { box: Box | null; words: string }) | null => {
    // Held at the playhead, "nothing recorded since" would speak of what came after it: no tail.
    const t = heldAt === null ? idleTail(last, liveAt, axis, pw) : null;
    if (!t || !last) return null;
    const minuteClock = (x: number) => (got.density && got.density.bucketMs >= 60_000 ? clock(x).slice(0, -3) : clock(x));
    const label = lastRecordedWords(last, wall ? minuteClock : clock);
    const tw = labelMeasure()(label);
    const lx = Math.round(t.x) + 4;
    // A compressed tail is said by its break (X10): no label runs into it.
    const broken = (axis.breaks ?? []).some((b) => b.from >= (last.until ?? 0) - 1 && b.to <= liveAt + 1);
    const fits = !broken && lx + tw <= t.liveX - 6;
    const idle = broken ? "" : `nothing recorded for ${lengthWords(t.idleMs)}`;
    return { ...t, label, labelX: fits ? lx : null, idle, box: fits ? { x: lx - 2, y: L.plotBottom - 12, w: tw + 4, h: 11 } : null, words: `${lastRecordedWords(last, clock)}; nothing recorded for ${lengthWords(t.idleMs)} since` };
  }, [last, liveAt, heldAt, axis, pw, clock, wall, got.density, L.plotBottom]);

  const activity = useMemo((): (ActivityLayer & { peaks: { executions: number; visits: number; agents: number }; inferred: number; dropped: Array<{ label: string; kind: string; values: number[] }> }) | null => {
    const c = got.concurrency;
    if (!c || noActivity) return null;
    const ex = concurrencySteps(c, "execution", axis, pw);
    const vi = concurrencySteps(c, "visit", axis, pw);
    const ag = concurrencySteps(c, "agent", axis, pw);
    const executions = trimTrailingZero(ex.steps);
    const agents = trimTrailingZero(ag.steps);
    // Cells in a station: the recorded part as the line, the part whose end was inferred as a band above it (T9).
    const inferredSaid = inferredPeak(c, "visit");
    const visits = inferredSaid ? trimTrailingZero(concurrencySteps(c, "visit", axis, pw, (b) => (b.active.visit?.max ?? 0) - (inferredOf(b, "visit") ?? 0)).steps) : trimTrailingZero(vi.steps);
    const visitsInferred = inferredSaid
      ? c.buckets.flatMap((b) => {
          const inf = inferredOf(b, "visit") ?? 0;
          if (!inf) return [];
          const hi = b.active.visit?.max ?? 0;
          return [{ x0: xOf(b.from, axis, pw), x1: xOf(b.from + c.bucketMs, axis, pw), lo: hi - inf, hi }];
        })
      : [];
    // A limit still in force is drawn as far as anything was recorded or active, not into the idle tail.
    const activeEnd = Math.max(0, ...[executions, visits, agents].map((s) => (s.length ? s[s.length - 1]!.x1 : 0)));
    const openEnd = Math.max(last?.until ?? extent.from, tOf(activeEnd, axis, pw));
    const limits = limitSegments(c.limits, axis, pw, openEnd);
    const top = Math.max(1, ex.peak, vi.peak, ag.peak, ...limits.map((l) => l.value));
    const vmax = top + Math.max(0.5, top * 0.08);
    const placed = placeLimitLabels(limits, activityY(L, vmax), labelMeasure(), { top: L.plotTop, bottom: L.plotBottom, width: pw }, tail?.box ? [tail.box] : []);
    return { executions, visits, visitsInferred, agents, limits, limitLabels: placed.placed, dropped: placed.dropped, vmax, peaks: { executions: ex.peak, visits: vi.peak, agents: ag.peak }, inferred: inferredSaid ?? 0 };
  }, [got.concurrency, noActivity, extent, axis, pw, last, L, tail]);
  const empty = !got.loading && !got.failed && (density?.total ?? 0) === 0 && got.marks.length === 0 && !(activity && (activity.peaks.executions || activity.peaks.visits || activity.peaks.agents));

  // ------------------------------------------------------------ the canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pw <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(pw * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverview(ctx, { width: pw, height, layout: L, density: empty ? null : density, activity: empty ? null : activity, points: marks.points, bars: marks.bars, ticks, tail: empty ? null : tail, breaks: empty ? [] : breakLayer, avoid: brushEdges }, readOverviewPalette(canvas));
    // `theme` re-reads the palette when the theme changes.
  }, [pw, height, L, density, activity, marks, ticks, tail, empty, theme, breakLayer, brushEdges]);

  // ------------------------------------------------------------ playhead and live edge (per frame, no React)
  const headRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const futureRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  usePlayheadEffect(
    (s) => {
      const clampX = (t: number) => Math.max(0, Math.min(pw, xOf(t, axis, pw)));
      // Scrubbed back (T6, M6.6 I-04): held at the playhead the stretch after it is plain extent, labelled
      // "after this moment, not shown"; with what happened after it revealed, a quiet tint, as on the tracks.
      const after = afterRef.current;
      if (after) {
        const a = asOfPlayhead(s);
        const behind = a.behind;
        after.style.backgroundColor = a.revealed ? "" : "transparent";
        after.dataset.overviewAfter = a.revealed ? "revealed" : "held";
        const hx = clampX(s.playhead);
        const lx2 = clampX(s.liveAt);
        after.style.display = behind && lx2 - hx >= 2 ? "block" : "none";
        after.style.left = `${hx}px`;
        after.style.width = `${Math.max(0, lx2 - hx)}px`;
        const label = after.firstElementChild as HTMLElement | null;
        if (label) {
          // Beside the landmark glyphs, never over one (round 6, defect 13); not drawn where none is free.
          // Clear of the live edge's "now" too (live only), which stands just before the edge.
          const at = afterLabelLeft(hx, lx2 - (data.source === "live" ? NOW_CHIP_W : 0), marks.points, AFTER_LABEL_W);
          // No free stretch on the landmark row: just below it, on its own ground, at the playhead.
          const room = lx2 - hx - (data.source === "live" ? NOW_CHIP_W : 0) > AFTER_LABEL_W + 8;
          label.style.display = room ? "block" : "none";
          const words = a.revealed ? "after the playhead" : AFTER_NOT_SHOWN;
          if (label.textContent !== words) label.textContent = words;
          label.style.left = `${Math.round(at ?? 6)}px`;
          label.style.top = at !== null ? "0px" : `${L.bandBase - L.bandTop + 2}px`;
        }
      }
      if (headRef.current) {
        headRef.current.style.transform = `translateX(${clampX(s.playhead)}px)`;
        headRef.current.style.visibility = s.playhead >= extent.from && s.playhead <= extent.to ? "visible" : "hidden";
      }
      const lx = clampX(s.liveAt);
      if (liveRef.current) liveRef.current.style.transform = `translateX(${lx}px)`;
      // What has not happened yet (the simulation's recorded future) is hatched; real history ends at the edge.
      if (futureRef.current) {
        futureRef.current.style.left = `${lx}px`;
        futureRef.current.style.width = `${Math.max(0, pw - lx)}px`;
      }
    },
    [pw, axis, marks, data.source, L, heldAt],
  );

  // ------------------------------------------------------------ the brush
  const c = useMemo(() => ({ from: Math.max(extent.from, win.from), to: Math.min(extent.to, win.to) }), [extent.from, extent.to, win.from, win.to]);
  const whole = isWhole(c, extent);
  const minMs = MIN_WINDOW_MS;

  const report = useCallback((next: TimeWindow | null) => onWindow(next === null || isWhole(next, extent) ? null : next), [onWindow, extent]);

  const plotRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const dimLeftRef = useRef<HTMLDivElement>(null);
  const dimRightRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const tipRef = useRef<((tip: Tip | null) => void) | null>(null);
  const setTip = (tip: Tip | null) => tipRef.current?.(tip);
  const bindTip = useCallback((show: ((tip: Tip | null) => void) | null) => {
    tipRef.current = show;
  }, []);

  /** Writes the brush's geometry straight to the DOM: used on every render and every drag frame. */
  const applyBrush = useCallback(
    (w: TimeWindow) => {
      const cw = { from: Math.max(extent.from, w.from), to: Math.min(extent.to, w.to) };
      const x0 = Math.round(xOf(cw.from, axis, pw));
      const x1 = Math.max(x0 + 1, Math.round(xOf(cw.to, axis, pw)));
      const wh = String(isWhole(cw, extent));
      const inner = Math.min(8, Math.max(2, (x1 - x0) / 4));
      const outer = HANDLE_W - inner;
      const mv = moveRef.current;
      if (mv) {
        mv.style.left = `${x0}px`;
        mv.style.width = `${x1 - x0}px`;
        mv.dataset.whole = wh;
      }
      for (const [el, left, grip] of [
        [startRef.current, x0 - outer, outer],
        [endRef.current, x1 - inner, inner],
      ] as const) {
        if (!el) continue;
        el.style.left = `${left}px`;
        el.dataset.whole = wh;
        const g = el.firstElementChild as HTMLElement | null;
        if (g) g.style.left = `${grip - 2.5}px`;
      }
      if (dimLeftRef.current) dimLeftRef.current.style.width = wh === "true" ? "0px" : `${Math.max(0, x0)}px`;
      if (dimRightRef.current) {
        dimRightRef.current.style.left = `${x1}px`;
        dimRightRef.current.style.width = wh === "true" ? "0px" : `${Math.max(0, pw - x1)}px`;
      }
    },
    [extent, axis, pw],
  );
  useLayoutEffect(() => applyBrush(drag.current?.live ?? c));

  const flush = useCallback(
    (d: Drag) => {
      if (d.timer !== null) {
        window.clearTimeout(d.timer);
        d.timer = null;
      }
      if (d.live && d.live !== d.sent) {
        d.sent = d.live;
        d.sentAt = performance.now();
        report(d.live);
      }
    },
    [report],
  );
  /** A drag frame: the brush follows at once; the caller hears at most every DRAG_COMMIT_MS. */
  const follow = (d: Drag, next: TimeWindow) => {
    d.live = next;
    applyBrush(next);
    const due = d.sentAt + DRAG_COMMIT_MS - performance.now();
    if (due <= 0) flush(d);
    else if (d.timer === null) d.timer = window.setTimeout(() => flush(d), due);
  };

  const tAt = useCallback(
    (clientX: number) => {
      const el = plotRef.current;
      if (!el) return extent.from;
      const r = el.getBoundingClientRect();
      return Math.max(extent.from, Math.min(extent.to, tOf(clientX - r.left, axis, pw)));
    },
    [extent, axis, pw],
  );
  // Brush arithmetic in axis units, so a move or a key step is even on screen across a break (X10).
  const U = useCallback((w: TimeWindow) => windowToU(w, axis), [axis]);
  const T = useCallback((w: TimeWindow) => windowFromU(w, axis), [axis]);
  const u = useCallback((t: number) => uOf(t, axis), [axis]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || pw <= 0) return;
    const part = (e.target as HTMLElement).closest<HTMLElement>("[data-brush]")?.dataset.brush as BrushPart | undefined;
    const t = tAt(e.clientX);
    let mode: Drag["mode"];
    if (e.altKey && part !== "start" && part !== "end") mode = "seek";
    else if (part === "start" || part === "end") mode = part;
    else if (part === "move" && !whole) mode = "move";
    else mode = "draw";
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, pointerId: e.pointerId, x0: e.clientX, t0: t, win0: c, moved: false, live: null, sent: null, sentAt: 0, timer: null };
    setTip(null);
    if (mode === "seek") {
      setScrubbing(true);
      store.seek(t);
    }
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      const t = tAt(e.clientX);
      if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
      d.moved = true;
      if (d.mode === "seek") store.seek(t);
      else if (d.mode === "move") follow(d, T(moveWindow(U(d.win0), u(t) - u(d.t0), extent, minMs)));
      else if (d.mode === "start" || d.mode === "end") follow(d, T(resizeWindow(U(d.win0), d.mode, u(t), extent, minMs)));
      else follow(d, T(windowBetween(u(d.t0), u(t), extent, minMs)));
      return;
    }
    if (e.pointerType === "touch") return;
    // Hover: what this column holds.
    const el = plotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < 0 || x > pw || got.loading) {
      setTip(null);
      return;
    }
    const col = describeColumn({ x, extent: axis, width: pw, liveAt, density: got.density, concurrency: noActivity ? null : got.concurrency, points: marks.points, bars: marks.bars, clock });
    setTip({ ax: e.clientX, top: r.top, bottom: r.top + L.plotBottom + 18, title: col.title, lines: col.lines });
  };

  // A double click (two presses without a drag, close in time and place) shows everything.
  const lastClick = useRef<{ at: number; x: number } | null>(null);
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.mode === "seek") {
      drag.current = null;
      setScrubbing(false);
      return;
    }
    if (d.moved) {
      flush(d);
      drag.current = null;
      lastClick.current = null;
      return;
    }
    drag.current = null;
    const prev = lastClick.current;
    if (prev && e.timeStamp - prev.at < DOUBLE_CLICK_MS && Math.abs(e.clientX - prev.x) < 6) {
      lastClick.current = null;
      onWindow(null);
      return;
    }
    lastClick.current = { at: e.timeStamp, x: e.clientX };
    if (d.mode === "draw" && !whole) report(T(centreWindow(U(c), u(d.t0), extent, minMs)));
  };

  const cancel = () => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "seek") setScrubbing(false);
    else flush(d);
    drag.current = null;
  };
  useEffect(
    () => () => {
      const d = drag.current;
      if (d?.timer != null) window.clearTimeout(d.timer);
    },
    [],
  );

  // Wheel zooms about the pointer; a sideways wheel pans. Native listener: React's is passive.
  const wheelState = useRef({ c, extent, axis, pw, report });
  useLayoutEffect(() => {
    wheelState.current = { c, extent, axis, pw, report };
  });
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { c: cw, extent: ext, axis: ax, pw: width, report: send } = wheelState.current;
      const w = windowToU(cw, ax);
      if (width <= 0) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (Math.abs(dx) > Math.abs(dy)) {
        send(windowFromU(moveWindow(w, (dx / width) * (ext.to - ext.from), ext, minMs), ax));
        return;
      }
      const r = el.getBoundingClientRect();
      const anchor = uOf(tOf(e.clientX - r.left, ax, width), ax);
      const factor = Math.exp(Math.max(-200, Math.min(200, dy)) * 0.002);
      send(windowFromU(zoomWindow(w, anchor, factor, ext, minMs), ax));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [minMs]);

  const onKey = (part: BrushPart) => (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyStep(part, e.key, e.shiftKey, U(c), extent, minMs);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    report(T(next));
  };

  // ------------------------------------------------------------ words
  const descId = useId();
  const len = windowWords(c.to - c.from);
  const sliderCommon = { "aria-valuemin": Math.round(extent.from / 1000), "aria-valuemax": Math.round(extent.to / 1000), "aria-describedby": descId };
  const peakText = density && density.peak > 0 && got.density ? peakWords(density.peak, got.density.bucketMs) : null;
  // Held at the playhead, the window's words stop there too (M6.6).
  const windowText = useMemo(() => describeWindow(windowAsOf(c, heldAt), got.density, noActivity ? null : got.concurrency, got.marks), [c, heldAt, got.density, got.concurrency, noActivity, got.marks]);
  const summary = useMemo(() => {
    const counts = new Map<MarkPoint["family"], number>();
    for (const p of marks.points) counts.set(p.family, (counts.get(p.family) ?? 0) + p.count);
    for (const b of marks.bars) counts.set(b.family, (counts.get(b.family) ?? 0) + b.count);
    const parts = counts.size ? [familyCounts(counts)] : [];
    const waits = got.marks.filter((m) => m.kind === "human" && (m.until !== null || m.verdict === "required"));
    const waitText = waits.slice(0, 5).map((m) => `${m.label}: ${waitWords(m, shownAt)}`);
    if (waits.length > 5) waitText.push(`and ${waits.length - 5} more person waits`);
    return [parts.length ? parts.join(", ") : "no failures, waits or gaps", ...waitText].join("; ");
  }, [marks, got.marks, shownAt]);
  const droppedText = activity?.dropped.map((d) => `${d.label} ${d.values.join(", then ")}`).join("; ") ?? "";
  const droppedByKind = useMemo(() => {
    const by: Record<string, { text: string; title: string }> = {};
    for (const d of activity?.dropped ?? []) by[d.kind] = { text: d.values.join("→"), title: `Recorded limit, the dashed line: ${d.label} ${d.values.join(", then ")}` };
    return by;
  }, [activity]);

  const brushH = L.plotBottom + 1;

  return (
    <div className="relative flex shrink-0 select-none border-b border-line bg-surface" style={{ width, height }}>
      {legend ? (
        <Legend
          width={lead}
          height={height}
          compact={L.compact}
          peak={peakText}
          activity={activity?.peaks ?? null}
          inferred={activity?.inferred ?? 0}
          limits={droppedByKind}
          noActivity={!got.loading && noActivity}
          unfiltered={got.unfiltered}
          zoomed={!whole}
          onShowAll={() => onWindow(null)}
          partialDensity={got.density?.complete === false}
          partialActivity={got.concurrency?.complete === false && !noActivity}
          compress={gaps.length ? { on: compress, idle: lengthWords(gaps.reduce((n, g) => n + Math.max(0, Math.min(g.to, heldAt ?? g.to) - g.from), 0)), toggle: () => setCompressPref(!compress) } : null}
        />
      ) : lead > 0 ? (
        <div aria-hidden="true" className="shrink-0" style={{ width: lead }} />
      ) : null}
      <div
        ref={plotRef}
        className="relative touch-none"
        style={{ width: pw, height, marginRight: RIGHT_PAD }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onPointerLeave={() => setTip(null)}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0" style={{ width: pw, height }} />
        <div ref={futureRef} aria-hidden="true" className="mach-future pointer-events-none absolute opacity-60" style={{ top: L.bandTop, height: L.plotBottom - L.bandTop, left: pw, width: 0 }} />
        {/* After the playhead (T6): what the tracks and lenses show but the inspector does not yet. */}
        <div ref={afterRef} aria-hidden="true" className="pointer-events-none absolute bg-ink/[0.06]" style={{ top: L.bandTop, height: L.plotBottom - L.bandTop, left: 0, width: 0, display: "none" }}>
          <span className="absolute top-0 whitespace-nowrap rounded-xs bg-surface px-0.5 text-[10px] leading-[12px] text-ink-subtle" style={{ left: 6 }}>after the playhead</span>
        </div>

        {/* Outside the brush the overview is dimmed, not hidden. Geometry is written by applyBrush. */}
        <div ref={dimLeftRef} aria-hidden="true" className="pointer-events-none absolute left-0 bg-surface opacity-55" style={{ top: 0, height: brushH }} />
        <div ref={dimRightRef} aria-hidden="true" className="pointer-events-none absolute bg-surface opacity-55" style={{ top: 0, height: brushH }} />

        <div ref={liveRef} aria-hidden="true" className="pointer-events-none absolute left-0 w-px bg-factory-live" style={{ top: L.bandTop, height: L.plotBottom - L.bandTop }}>
          {data.source === "live" ? <span className="absolute right-[3px] top-[-3px] rounded-xs bg-surface px-0.5 font-mono text-[10px] leading-[12px] text-factory-live">now</span> : null}
        </div>
        <div ref={headRef} aria-hidden="true" className="pointer-events-none absolute left-0 z-[3] w-0" style={{ top: 0, height: L.plotBottom + 6 }}>
          <div className="absolute -left-px top-[2px] bottom-[5px] w-[1.5px] bg-ink" />
          <div className="absolute -left-[4px] bottom-0 size-[8px] rotate-45 rounded-[1px] border-[1.5px] border-ink bg-surface" />
        </div>

        {/* The brush: a group of three sliders. */}
        <div role="group" aria-label="Detailed window over the whole history" className="absolute inset-x-0 top-0" style={{ height: brushH }}>
          <div
            ref={moveRef}
            data-brush="move"
            role="slider"
            tabIndex={0}
            aria-label="Move window"
            {...sliderCommon}
            aria-valuenow={Math.round(c.from / 1000)}
            aria-valuetext={`From ${spokenTime(c.from)} to ${spokenTime(c.to)}, ${len}`}
            onKeyDown={onKey("move")}
            className={cn(
              "absolute top-0 cursor-grab rounded-[2px] border border-factory-select outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus active:cursor-grabbing",
              "data-[whole=true]:cursor-default data-[whole=true]:border-transparent",
            )}
            style={{ height: brushH }}
          />
          <BrushHandle ref={startRef} part="start" height={brushH} label="Window start" common={sliderCommon} now={c.from} text={`${spokenTime(c.from)}, window ${len}`} onKeyDown={onKey("start")} />
          <BrushHandle ref={endRef} part="end" height={brushH} label="Window end" common={sliderCommon} now={c.to} text={`${spokenTime(c.to)}, window ${len}`} onKeyDown={onKey("end")} />
        </div>
        <p id={descId} className="sr-only">
          {windowText}
        </p>

        {/* States, in words, never a blank band. */}
        {!got.loading && got.marksIncomplete ? (
          <p className="pointer-events-none absolute left-1 z-[4] rounded-xs bg-surface/85 px-1 text-[10px] leading-[12px] text-ink-muted" style={{ top: L.bandTop - 2 }}>
            landmarks incomplete in this window
          </p>
        ) : null}
        {got.loading ? <Note>Reading the whole history</Note> : got.failed ? <Note>The history could not be read. It will be asked for again when anything changes.</Note> : empty ? <Note>No history yet. Events appear here as the Factory records them.</Note> : null}
        {stale && connection ? (
          <div className="pointer-events-none absolute right-1 z-[4] flex items-center gap-1.5 rounded-xs border border-line bg-surface-raised px-1.5 py-px text-[11px] leading-[16px] text-ink-muted" style={{ top: L.plotTop + 2 }}>
            <span aria-hidden="true" className="size-[7px] rounded-full border border-factory-stale" />
            {connection.state === "no-session" ? "Not connected" : connection.state === "disconnected" ? "Disconnected" : connection.state === "reconnecting" ? "Reconnecting" : "Stale"}
            {connection.staleSince ? <span className="font-mono tabular">as of {wall ? `${utcClock(connection.staleSince)} UTC` : timecode(connection.staleSince, false)}</span> : null}
          </div>
        ) : null}
        <TipLayer bind={bindTip} />
        <p className="sr-only">
          {historyWords(extent, density ? density.total : null, heldAt, spokenTime)}; {summary}.
          {tail ? ` ${tail.words}.` : ""}
          {droppedText ? ` Recorded limit: ${droppedText}.` : ""}
          {got.marksIncomplete ? " Landmarks incomplete in this window: the source returned only part of them." : ""}
          {breakLayer.some((b) => b.label) ? ` Idle time compressed: ${breakLayer.filter((b) => b.label).map((b) => `${b.label} from ${spokenTime(b.from)}`).join("; ")}.` : ""}
          {got.unfiltered ? " Event counts are for every ticket: the filter has more than one." : ""}
          {heldAt !== null ? ` Held at the playhead, ${spokenTime(heldAt)}: ${AFTER_NOT_SHOWN}.` : ""}
        </p>
      </div>
    </div>
  );
}

/** The data layer's last recorded instant (X11), re-read when the density answer changes; null until known. */
function useRecordedLast(data: TemporalOverviewProps["data"], density: unknown): (TimeWindow & { lastIsBucket?: boolean; lastBucket?: TimeWindow }) | null {
  const [got, setGot] = useState<(TimeWindow & { lastIsBucket?: boolean; lastBucket?: TimeWindow }) | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    sharedRecordedExtent(data, ac.signal).then(
      (r) => !ac.signal.aborted && setGot(r),
      () => !ac.signal.aborted && setGot(null),
    );
    return () => ac.abort();
  }, [data, density]);
  return got;
}

/**
 * The hover tooltip, in a portal on the document body so no workspace overflow clips it; below the
 * plot, or above it when the viewport has no room. Its own state: hovering never re-renders the overview.
 */
function TipLayer({ bind }: { bind: (show: ((tip: Tip | null) => void) | null) => void }) {
  const [tip, setTip] = useState<Tip | null>(null);
  useLayoutEffect(() => {
    bind(setTip);
    return () => bind(null);
  }, [bind]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(8, Math.min(vw - w - 8, tip.ax - w / 2));
    const top = tip.bottom + h + 8 <= vh ? tip.bottom : Math.max(8, tip.top - h - 6);
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.style.visibility = "visible";
  }, [tip]);
  if (!tip || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} role="presentation" className="pointer-events-none fixed left-0 top-0 z-50 max-w-80 rounded-sm border border-line bg-surface-raised px-2.5 py-1.5 shadow-2" style={{ visibility: "hidden" }}>
      <p className="font-mono text-[11px] text-ink-subtle tabular">{tip.title}</p>
      {tip.lines.map((l, i) => (
        <p key={i} className="text-caption text-ink">
          {l}
        </p>
      ))}
    </div>,
    document.body,
  );
}

function Note({ children }: { children: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] flex items-center justify-center px-4" style={{ height: "calc(100% - 22px)" }}>
      <p className="rounded-xs bg-surface/80 px-2 text-caption text-ink-muted">{children}</p>
    </div>
  );
}

function BrushHandle({ ref, ...props }: {
  ref: Ref<HTMLDivElement>;
  part: "start" | "end";
  height: number;
  label: string;
  common: Record<string, number | string>;
  now: number;
  text: string;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={ref}
      data-brush={props.part}
      role="slider"
      tabIndex={0}
      aria-label={props.label}
      {...props.common}
      aria-valuenow={Math.round(props.now / 1000)}
      aria-valuetext={props.text}
      onKeyDown={props.onKeyDown}
      className="group absolute top-0 z-[2] cursor-ew-resize rounded-xs outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
      style={{ width: HANDLE_W, height: props.height }}
    >
      {/* Geometry (left of the handle and of this grip) is written by applyBrush. */}
      <div
        aria-hidden="true"
        className="absolute top-1/2 h-[18px] w-[5px] -translate-y-1/2 rounded-[2px] border border-factory-select bg-surface group-data-[whole=true]:opacity-0 group-data-[whole=true]:group-hover:opacity-100 group-data-[whole=true]:group-focus-visible:opacity-100"
      />
    </div>
  );
}

function Swatch({ kind }: { kind: "density" | "executions" | "visits" | "agents" }) {
  return (
    <svg aria-hidden="true" width="14" height="10" viewBox="0 0 14 10" className="shrink-0">
      {kind === "density" ? <path d="M0 10V6h2V3h2v2h2V1h2v4h2V7h2V4h2v6Z" style={{ fill: "var(--mach-ink-subtle)", opacity: 0.45 }} /> : null}
      {kind === "executions" ? (
        <>
          <path d="M0 10V6h5V3h5v4h4v3Z" style={{ fill: "var(--mach-factory-live)", opacity: 0.16 }} />
          <path d="M0 6h5V3h5v4h4" style={{ fill: "none", stroke: "var(--mach-factory-live)", strokeWidth: 1.5 }} />
        </>
      ) : null}
      {kind === "visits" ? <path d="M0 7.5h4v-4h6v3h4" style={{ fill: "none", stroke: "var(--mach-factory-ink-soft)", strokeWidth: 1 }} /> : null}
      {kind === "agents" ? <path d="M0 5.5h3v-3h5v5h3v-2h3" style={{ fill: "none", stroke: "var(--mach-factory-ink)", strokeWidth: 1, opacity: 0.6 }} /> : null}
    </svg>
  );
}

/** A limit drawn without its label: its value beside the kind it bounds, the name in the title. */
function LimitNote({ limit }: { limit: { text: string; title: string } | undefined }) {
  if (!limit) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular text-ink-subtle" title={limit.title}>
      <svg aria-hidden="true" width="9" height="2" className="shrink-0">
        <path d="M0 1h3M5 1h3" style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 1 }} />
      </svg>
      {limit.text}
    </span>
  );
}

/** The compact legend's line: "1 run · 1 cell · 3 agents" (most at once of each). */
function atOnceWords(a: { executions: number; visits: number; agents: number }): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return `${n(a.executions, "run", "runs")} · ${n(a.visits, "cell", "cells")} · ${n(a.agents, "agent", "agents")}`;
}

function Legend(props: {
  width: number;
  height: number;
  compact: boolean;
  peak: string | null;
  activity: { executions: number; visits: number; agents: number } | null;
  /** The most cells in a station at once whose end was inferred (T9); 0 when none or not said. */
  inferred: number;
  /** The density / concurrency answer is partial (`complete: false`, T8). */
  partialDensity: boolean;
  partialActivity: boolean;
  /** Compress idle time (X10): present only when there is idle time to compress. */
  compress: { on: boolean; idle: string; toggle: () => void } | null;
  /** Recorded limits drawn without a label (no room on the plot), by the kind they bound: named on that kind's row. */
  limits: Readonly<Record<string, { text: string; title: string }>>;
  noActivity: boolean;
  unfiltered: boolean;
  zoomed: boolean;
  onShowAll: () => void;
}) {
  const { compact, activity } = props;
  const showAll = props.zoomed ? (
    <button type="button" onClick={props.onShowAll} className="-mr-1 ml-auto flex h-full shrink-0 items-center rounded-xs px-1 text-accent-ink underline underline-offset-2 hover:decoration-2">
      Show all
    </button>
  ) : null;
  const row = cn("flex min-w-0 items-center gap-1.5 whitespace-nowrap", compact ? "h-[13px] text-[10px]" : "h-[14px] text-[11px]");
  const value = "ml-auto shrink-0 font-mono tabular text-ink-muted";
  return (
    <div className="flex shrink-0 flex-col overflow-hidden border-r border-line pl-3 pr-2.5 [&_span:not(.shrink-0)]:truncate" style={{ width: props.width, height: props.height, paddingTop: compact ? 3 : 5 }}>
      <div className={cn(row, "text-ink-muted")} title={props.unfiltered ? "Events recorded by every ticket: the filter names more than one" : "Events recorded per bucket, on a log scale: never load or utilisation"}>
        <Swatch kind="density" />
        <span>{props.unfiltered ? "events recorded, all tickets" : "events recorded"}</span>
        {props.partialDensity ? <span className="ml-auto shrink-0 text-ink-subtle" title="The source answered for only part of the history: counts are partial">partial</span> : null}
        {/* On the first row, two rows from "Show all", so the two small targets keep 24 px apart. */}
        {props.compress ? (
          // Compress idle time (X10): a broken axis over stretches with nothing recorded.
          <button
            type="button"
            aria-pressed={props.compress.on}
            aria-label="Compress idle time"
            onClick={props.compress.toggle}
            title={`Compress idle time: draw ${props.compress.idle} with nothing recorded as breaks in the axis`}
            // A full 24 px target (WCAG 2.5.8) without growing the row, ending clear of the brush's start handle, which reaches into this column.
            className="relative z-[1] -my-[5px] mr-5 ml-auto flex h-6 min-w-6 shrink-0 items-center gap-1 rounded-xs px-1 text-ink-muted hover:bg-surface-sunken hover:text-ink aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-[var(--mach-focus)]"
          >
            <svg aria-hidden="true" width="12" height="9" viewBox="0 0 12 9" className="shrink-0">
              <path d="M0 4.5h3M9 4.5h3M3.5 8l2-7M6.5 8l2-7" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1 }} />
            </svg>
            <span className={props.compress.on ? "underline decoration-1 underline-offset-2" : undefined}>idle</span>
          </button>
        ) : null}
      </div>
      {/* The peak on its own line, so neither it nor the name is cut. */}
      <div className={cn(row, "pl-5 text-ink-subtle")} title="The most events recorded in one bucket of the series">
        {props.peak ? (
          <span>
            peak <span className="font-mono tabular text-ink-muted">{props.peak}</span>
          </span>
        ) : null}
      </div>
      {props.noActivity ? (
        <>
          <p className={cn("mt-0.5 italic text-ink-subtle", compact ? "text-[10px] leading-[12px]" : "text-[11px] leading-[14px]")}>Activity is not available from this observer</p>
          {props.zoomed ? <div className={cn(row, "mt-auto mb-1 text-ink-subtle")}>{showAll}</div> : null}
        </>
      ) : compact ? (
        <div className={cn(row, "text-ink-muted")} title={`Most spans active at once, counted from recorded spans: executions running, cells in a station, agents${Object.values(props.limits).map((l) => `. ${l.title}`).join("")}`}>
          {/* One line of words (X20): never glyphs and bare numbers. */}
          <span className="shrink-0 text-ink-subtle">at once</span>
          <span>{activity ? atOnceWords(activity) : "not known"}</span>
        </div>
      ) : null}
      {compact && props.zoomed ? <div className={cn(row, "text-ink-subtle")}>{showAll}</div> : null}
      {compact || props.noActivity ? null : (
        <>
          <div className={cn(row, "text-ink-subtle")} title="Most spans active at once, counted from recorded spans">
            <span>most at once</span>
            {props.partialActivity ? <span className="shrink-0" title="The source answered for only part of the history: counts are partial">partial</span> : null}
            {showAll}
          </div>
          <div className={cn(row, "text-ink-muted")}>
            <Swatch kind="executions" />
            <span>executions running</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <LimitNote limit={props.limits.execution} />
              <span className={value}>{activity?.executions ?? "–"}</span>
            </span>
          </div>
          <div className={cn(row, "text-ink-muted")} title={props.inferred ? `Including ${props.inferred} ended without an exit record (the lighter band above the line)` : undefined}>
            <Swatch kind="visits" />
            <span>{props.inferred ? `cells in a station, including ${props.inferred} ended without an exit record` : "cells in a station"}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <LimitNote limit={props.limits.visit} />
              <span className={value}>{activity?.visits ?? "–"}</span>
            </span>
          </div>
          <div className={cn(row, "text-ink-muted")}>
            <Swatch kind="agents" />
            <span>agents</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <LimitNote limit={props.limits.agent} />
              <span className={value}>{activity?.agents ?? "–"}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

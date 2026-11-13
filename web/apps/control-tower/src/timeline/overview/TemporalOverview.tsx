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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn, useTheme } from "@mach/ui";
import { isStale, useSceneStore, useStore } from "../../scene";
import { setScrubbing } from "../../shell/scrub";
import { spokenTime, timecode, duration, getTimeBase, utcClock } from "../../shell/time";
import { usePlayheadEffect } from "../../shell/timeline/playhead";
import "../../shell/shell.css";
import { LABEL_GUTTER, MIN_WINDOW_MS, type TemporalOverviewProps, type TimeWindow } from "../contract";
import { drawOverview, overviewLayout, readOverviewPalette, type ActivityLayer } from "./draw";
import {
  aggregateMarks,
  centreWindow,
  chooseTicks,
  concurrencySteps,
  concurrencyUnavailable,
  countText,
  densityColumns,
  isWhole,
  keyStep,
  moveWindow,
  resizeWindow,
  tOf,
  windowBetween,
  windowWords,
  xOf,
  zoomWindow,
  type BrushPart,
  type MarkBar,
  type MarkPoint,
} from "./model";
import { useOverviewData } from "./useOverviewData";

/** Room on the right so the end handle can be grabbed at the live edge. */
const RIGHT_PAD = 12;
/** Below this width the legend column is left out and the plot takes the whole width. */
const LEGEND_MIN_WIDTH = 720;
/** Pixels a press must travel before it is a drag. */
const DRAG_PX = 4;
const DOUBLE_CLICK_MS = 450;

interface Drag {
  readonly mode: "start" | "end" | "move" | "draw" | "seek";
  readonly pointerId: number;
  readonly x0: number;
  readonly t0: number;
  readonly win0: TimeWindow;
  moved: boolean;
}

interface Tip {
  readonly x: number;
  readonly text: string;
  readonly when: string;
}

const FAMILY_WORDS: Record<MarkPoint["family"], [string, string]> = {
  failure: ["failure", "failures"],
  halt: ["recovery or interruption", "recoveries and interruptions"],
  gate: ["gate refusal or override", "gate refusals and overrides"],
  human: ["person needed", "people needed"],
  gap: ["gap in history", "gaps in history"],
};

/** "/min" for a minute's bucket, else " per 5 min". */
function perBucket(ms: number): string {
  if (ms === 1000) return "/s";
  if (ms === 60_000) return "/min";
  if (ms === 3_600_000) return "/h";
  return ` per ${duration(ms)}`;
}

function limitName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

export function TemporalOverview({ data, extent, window: win, liveAt, width, height, filters, onWindow }: TemporalOverviewProps) {
  const store = useStore();
  const { resolved: theme } = useTheme();
  const connection = useSceneStore((s) => s.connection);
  const source = useSceneStore((s) => s.source);
  const stale = isStale(connection);

  const legend = width >= LEGEND_MIN_WIDTH ? LABEL_GUTTER : 0;
  const pw = Math.max(0, Math.floor(width - legend - RIGHT_PAD));
  const L = overviewLayout(height);
  const wall = getTimeBase() === "wall" || source !== "simulation";

  const got = useOverviewData(data, extent, pw, filters);

  // ------------------------------------------------------------ derived drawing (pixel space)
  const density = useMemo(() => (got.density ? densityColumns(got.density, extent, pw) : null), [got.density, extent, pw]);
  const noActivity = concurrencyUnavailable(got.concurrency);
  const activity = useMemo((): (ActivityLayer & { peaks: { executions: number; visits: number; agents: number } }) | null => {
    const c = got.concurrency;
    if (!c || noActivity) return null;
    const ex = concurrencySteps(c, "execution", extent, pw);
    const vi = concurrencySteps(c, "visit", extent, pw);
    const ag = concurrencySteps(c, "agent", extent, pw);
    const limits = c.limits.map((l) => ({ label: limitName(l.name), value: l.value, x0: Math.max(0, xOf(l.from, extent, pw)), x1: Math.min(pw, xOf(l.to ?? extent.to, extent, pw)) })).filter((l) => l.x1 > l.x0);
    const top = Math.max(1, ex.peak, vi.peak, ag.peak, ...limits.map((l) => l.value));
    return { executions: ex.steps, visits: vi.steps, agents: ag.steps, limits, vmax: top + Math.max(0.5, top * 0.08), peaks: { executions: ex.peak, visits: vi.peak, agents: ag.peak } };
  }, [got.concurrency, noActivity, extent, pw]);
  const marks = useMemo(() => aggregateMarks(got.marks, extent, pw, liveAt), [got.marks, extent, pw, liveAt]);
  const ticks = useMemo(() => chooseTicks(extent, pw, wall, L.compact ? 76 : 84).ticks, [extent, pw, wall, L.compact]);
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
    drawOverview(ctx, { width: pw, height, layout: L, density: empty ? null : density, activity: empty ? null : activity, points: marks.points, bars: marks.bars, ticks }, readOverviewPalette(canvas));
    // `theme` re-reads the palette when the theme changes.
  }, [pw, height, L, density, activity, marks, ticks, empty, theme]);

  // ------------------------------------------------------------ playhead and live edge (per frame, no React)
  const headRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const futureRef = useRef<HTMLDivElement>(null);
  usePlayheadEffect(
    (s) => {
      const clampX = (t: number) => Math.max(0, Math.min(pw, xOf(t, extent, pw)));
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
    [pw, extent.from, extent.to],
  );

  // ------------------------------------------------------------ the brush
  const c = useMemo(() => ({ from: Math.max(extent.from, win.from), to: Math.min(extent.to, win.to) }), [extent.from, extent.to, win.from, win.to]);
  const bx0 = Math.round(xOf(c.from, extent, pw));
  const bx1 = Math.max(bx0 + 1, Math.round(xOf(c.to, extent, pw)));
  const whole = isWhole(c, extent);
  const minMs = MIN_WINDOW_MS;

  const report = useCallback((next: TimeWindow | null) => onWindow(next === null || isWhole(next, extent) ? null : next), [onWindow, extent]);

  const plotRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const tAt = useCallback(
    (clientX: number) => {
      const el = plotRef.current;
      if (!el) return extent.from;
      const r = el.getBoundingClientRect();
      return Math.max(extent.from, Math.min(extent.to, tOf(clientX - r.left, extent, pw)));
    },
    [extent, pw],
  );

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
    drag.current = { mode, pointerId: e.pointerId, x0: e.clientX, t0: t, win0: c, moved: false };
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
      else if (d.mode === "move") report(moveWindow(d.win0, t - d.t0, extent, minMs));
      else if (d.mode === "start" || d.mode === "end") report(resizeWindow(d.win0, d.mode, t, extent, minMs));
      else report(windowBetween(d.t0, t, extent, minMs));
      return;
    }
    if (e.pointerType === "touch") return;
    // Hover: name the landmark under the pointer.
    const el = plotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y > L.plotBottom) {
      if (tip) setTip(null);
      return;
    }
    setTip(findTip(marks.points, marks.bars, x, y <= L.bandBase + 2));
  };

  // A double click (two presses without a drag, close in time and place) shows everything.
  const lastClick = useRef<{ at: number; x: number } | null>(null);
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (d.mode === "seek") {
      setScrubbing(false);
      return;
    }
    if (d.moved) {
      lastClick.current = null;
      return;
    }
    const prev = lastClick.current;
    if (prev && e.timeStamp - prev.at < DOUBLE_CLICK_MS && Math.abs(e.clientX - prev.x) < 6) {
      lastClick.current = null;
      onWindow(null);
      return;
    }
    lastClick.current = { at: e.timeStamp, x: e.clientX };
    if (d.mode === "draw" && !whole) report(centreWindow(c, d.t0, extent, minMs));
  };

  const cancel = () => {
    if (drag.current?.mode === "seek") setScrubbing(false);
    drag.current = null;
  };

  // Wheel zooms about the pointer; a sideways wheel pans. Native listener: React's is passive.
  const wheelState = useRef({ c, extent, pw, report });
  useLayoutEffect(() => {
    wheelState.current = { c, extent, pw, report };
  });
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { c: w, extent: ext, pw: width, report: send } = wheelState.current;
      if (width <= 0) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (Math.abs(dx) > Math.abs(dy)) {
        send(moveWindow(w, (dx / width) * (ext.to - ext.from), ext, minMs));
        return;
      }
      const r = el.getBoundingClientRect();
      const anchor = tOf(e.clientX - r.left, ext, width);
      const factor = Math.exp(Math.max(-200, Math.min(200, dy)) * 0.002);
      send(zoomWindow(w, anchor, factor, ext, minMs));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [minMs]);

  const onKey = (part: BrushPart) => (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyStep(part, e.key, e.shiftKey, c, extent, minMs);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    report(next);
  };

  // ------------------------------------------------------------ words
  const len = windowWords(c.to - c.from);
  const sliderCommon = { "aria-valuemin": Math.round(extent.from / 1000), "aria-valuemax": Math.round(extent.to / 1000) };
  const peakText = density && density.peak > 0 && got.density ? `${countText(density.peak)}${perBucket(got.density.bucketMs)}` : null;
  const summary = useMemo(() => {
    const counts = new Map<MarkPoint["family"], number>();
    for (const p of marks.points) counts.set(p.family, (counts.get(p.family) ?? 0) + p.count);
    for (const b of marks.bars) counts.set(b.family, (counts.get(b.family) ?? 0) + b.count);
    const parts = [...counts].map(([f, n]) => `${n} ${FAMILY_WORDS[f][n === 1 ? 0 : 1]}`);
    return parts.length ? parts.join(", ") : "no failures, waits or gaps";
  }, [marks]);

  const handleW = 24;
  const inner = Math.min(8, Math.max(2, (bx1 - bx0) / 4));
  const brushH = L.plotBottom + 1;

  return (
    <div className="relative flex shrink-0 select-none border-b border-line bg-surface" style={{ width, height }}>
      {legend ? (
        <Legend width={legend} height={height} compact={L.compact} peak={peakText} activity={activity?.peaks ?? null} noActivity={!got.loading && noActivity} unfiltered={got.unfiltered} zoomed={!whole} onShowAll={() => onWindow(null)} />
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

        {/* Outside the brush the overview is dimmed, not hidden. */}
        {!whole ? (
          <>
            <div aria-hidden="true" className="pointer-events-none absolute left-0 bg-surface opacity-55" style={{ top: 0, height: brushH, width: Math.max(0, bx0) }} />
            <div aria-hidden="true" className="pointer-events-none absolute bg-surface opacity-55" style={{ top: 0, height: brushH, left: bx1, width: Math.max(0, pw - bx1) }} />
          </>
        ) : null}

        <div ref={liveRef} aria-hidden="true" className="pointer-events-none absolute left-0 w-px bg-factory-live" style={{ top: L.bandTop, height: L.plotBottom - L.bandTop }} />
        <div ref={headRef} aria-hidden="true" className="pointer-events-none absolute left-0 z-[3] w-0" style={{ top: 0, height: L.plotBottom + 6 }}>
          <div className="absolute -left-px top-[2px] bottom-[5px] w-[1.5px] bg-ink" />
          <div className="absolute -left-[4px] bottom-0 size-[8px] rotate-45 rounded-[1px] border-[1.5px] border-ink bg-surface" />
        </div>

        {/* The brush: a group of three sliders. */}
        <div role="group" aria-label="Detailed window over the whole history" className="absolute inset-x-0 top-0" style={{ height: brushH }}>
          <div
            data-brush="move"
            role="slider"
            tabIndex={0}
            aria-label="Move window"
            {...sliderCommon}
            aria-valuenow={Math.round(c.from / 1000)}
            aria-valuetext={`From ${spokenTime(c.from)} to ${spokenTime(c.to)}, ${len}`}
            onKeyDown={onKey("move")}
            className={cn(
              "absolute top-0 rounded-[2px] border outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
              whole ? "border-transparent" : "cursor-grab border-factory-select active:cursor-grabbing",
            )}
            style={{ left: bx0, width: bx1 - bx0, height: brushH }}
          />
          <BrushHandle part="start" x={bx0} inner={inner} outer={handleW - inner} height={brushH} whole={whole}
            label="Window start" common={sliderCommon} now={c.from} text={`${spokenTime(c.from)}, window ${len}`} onKeyDown={onKey("start")} />
          <BrushHandle part="end" x={bx1} inner={inner} outer={handleW - inner} height={brushH} whole={whole}
            label="Window end" common={sliderCommon} now={c.to} text={`${spokenTime(c.to)}, window ${len}`} onKeyDown={onKey("end")} />
        </div>

        {/* States, in words, never a blank band. */}
        {got.loading ? <Note>Reading the whole history</Note> : got.failed ? <Note>The history could not be read. It will be asked for again when anything changes.</Note> : empty ? <Note>No history yet. Events appear here as the Factory records them.</Note> : null}
        {stale && connection ? (
          <div className="pointer-events-none absolute right-1 z-[4] flex items-center gap-1.5 rounded-xs border border-line bg-surface-raised px-1.5 py-px text-[11px] leading-[16px] text-ink-muted" style={{ top: L.plotTop + 2 }}>
            <span aria-hidden="true" className="size-[7px] rounded-full border border-factory-stale" />
            {connection.state === "no-session" ? "Not connected" : connection.state === "disconnected" ? "Disconnected" : connection.state === "reconnecting" ? "Reconnecting" : "Stale"}
            {connection.staleSince ? <span className="font-mono tabular">as of {wall ? `${utcClock(connection.staleSince)} UTC` : timecode(connection.staleSince, false)}</span> : null}
          </div>
        ) : null}
        {tip ? (
          <div role="presentation" className="pointer-events-none absolute z-10 max-w-80 -translate-x-1/2 rounded-sm border border-line bg-surface-raised px-2.5 py-1.5 shadow-2" style={{ left: Math.max(130, Math.min(pw - 130, tip.x)), top: L.plotBottom + 4 }}>
            <p className="text-caption text-ink">{tip.text}</p>
            <p className="font-mono text-[11px] text-ink-subtle tabular">{tip.when}</p>
          </div>
        ) : null}
        <p className="sr-only">
          Whole history from {spokenTime(extent.from)} to {spokenTime(extent.to)}: {density ? `${countText(density.total)} events recorded` : "events not yet read"}; {summary}.
          {got.unfiltered ? " Event counts are for every ticket: the filter has more than one." : ""}
        </p>
      </div>
    </div>
  );
}

function findTip(points: readonly MarkPoint[], bars: readonly MarkBar[], x: number, inBand: boolean): Tip | null {
  let best: MarkPoint | null = null;
  let bestD = 6;
  if (inBand) {
    for (const p of points) {
      const d = Math.abs(p.x + 0.5 - x);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
  }
  if (best) {
    const more = best.count > 1 ? ` (and ${best.count - 1} more ${FAMILY_WORDS[best.family][1]} here)` : "";
    return { x: best.x, text: `${best.first.label}${more}`, when: timecode(best.first.at, false) };
  }
  for (const b of bars) {
    if (x >= b.x0 - 3 && x <= Math.max(b.x0 + 3, b.x1) + 3) {
      const until = b.first.until !== null ? ` to ${timecode(b.first.until, false)}` : b.open ? ", still waiting" : "";
      const more = b.count > 1 ? ` (and ${b.count - 1} more)` : "";
      return { x, text: `${b.first.label}${more}`, when: `${timecode(b.first.at, false)}${until}` };
    }
  }
  return null;
}

function Note({ children }: { children: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] flex items-center justify-center px-4" style={{ height: "calc(100% - 22px)" }}>
      <p className="rounded-xs bg-surface/80 px-2 text-caption text-ink-muted">{children}</p>
    </div>
  );
}

function BrushHandle(props: {
  part: "start" | "end";
  x: number;
  inner: number;
  outer: number;
  height: number;
  whole: boolean;
  label: string;
  common: Record<string, number>;
  now: number;
  text: string;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { part, x, inner, outer, height, whole } = props;
  const left = part === "start" ? x - outer : x - inner;
  const grip = part === "start" ? outer : inner;
  return (
    <div
      data-brush={part}
      role="slider"
      tabIndex={0}
      aria-label={props.label}
      {...props.common}
      aria-valuenow={Math.round(props.now / 1000)}
      aria-valuetext={props.text}
      onKeyDown={props.onKeyDown}
      className="group absolute top-0 z-[2] cursor-ew-resize rounded-xs outline-none focus-visible:outline-2 focus-visible:outline-focus"
      style={{ left, width: inner + outer, height }}
    >
      <div
        aria-hidden="true"
        className={cn("absolute top-1/2 h-[18px] w-[5px] -translate-y-1/2 rounded-[2px] border border-factory-select bg-surface", whole && "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")}
        style={{ left: grip - 2.5 }}
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

function Legend(props: {
  width: number;
  height: number;
  compact: boolean;
  peak: string | null;
  activity: { executions: number; visits: number; agents: number } | null;
  noActivity: boolean;
  unfiltered: boolean;
  zoomed: boolean;
  onShowAll: () => void;
}) {
  const { compact, activity } = props;
  const row = cn("flex items-center gap-1.5 whitespace-nowrap", compact ? "h-[13px] text-[10px]" : "h-[14px] text-[11px]");
  const value = "ml-auto font-mono tabular text-ink-muted";
  return (
    <div className="flex shrink-0 flex-col border-r border-line pl-3 pr-2.5" style={{ width: props.width, height: props.height, paddingTop: compact ? 3 : 5 }}>
      <div className={cn(row, "text-ink-muted")} title={props.unfiltered ? "Events recorded by every ticket: the filter names more than one" : "Events recorded per bucket, on a log scale: never load or utilisation"}>
        <Swatch kind="density" />
        <span>{props.unfiltered ? "events recorded, all tickets" : "events recorded"}</span>
        {props.peak ? <span className={value}>{props.peak}</span> : null}
      </div>
      {props.noActivity ? (
        <p className={cn("mt-0.5 italic text-ink-subtle", compact ? "text-[10px] leading-[12px]" : "text-[11px] leading-[14px]")}>Activity is not available from this observer</p>
      ) : compact ? (
        <div className={cn(row, "text-ink-muted")} title="Most spans active at once, counted from recorded spans: executions running, cells in a station, agents">
          <span className="text-ink-subtle">spans at once</span>
          <span className="ml-auto flex items-center gap-1 font-mono tabular">
            <Swatch kind="executions" />
            {activity?.executions ?? "–"}
            <Swatch kind="visits" />
            {activity?.visits ?? "–"}
            <Swatch kind="agents" />
            {activity?.agents ?? "–"}
          </span>
        </div>
      ) : (
        <>
          <div className={cn(row, "text-ink-subtle")}>recorded spans, most at once</div>
          <div className={cn(row, "text-ink-muted")}>
            <Swatch kind="executions" />
            <span>executions running</span>
            <span className={value}>{activity?.executions ?? "–"}</span>
          </div>
          <div className={cn(row, "text-ink-muted")}>
            <Swatch kind="visits" />
            <span>cells in a station</span>
            <span className={value}>{activity?.visits ?? "–"}</span>
          </div>
          <div className={cn(row, "text-ink-muted")}>
            <Swatch kind="agents" />
            <span>agents</span>
            <span className={value}>{activity?.agents ?? "–"}</span>
          </div>
        </>
      )}
      {props.zoomed ? (
        <button type="button" onClick={props.onShowAll} className="mt-auto mb-0 -ml-1 flex h-6 w-fit items-center rounded-xs px-1 text-[11px] text-accent-ink underline underline-offset-2 hover:decoration-2">
          Show all
        </button>
      ) : null}
    </div>
  );
}

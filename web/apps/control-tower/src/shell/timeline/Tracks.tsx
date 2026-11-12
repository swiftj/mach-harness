/**
 * The tracks: one per slice (its cell's station visits, rounds, gates and waits), expandable into
 * its agents' rows with their tool calls, plus the factory track (people, scheduler, integrations).
 * Drawn on canvas; headers, focus and hover text are DOM. The playhead and the live edge move by
 * direct DOM writes (usePlayheadEffect), so playback never re-renders this component.
 */
import { ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { cn, useTheme } from "@mach/ui";
import { SCENARIO, type EntityRef } from "../../sim";
import { useScene, useSceneStore, useStore } from "../../scene";
import { StateGlyph } from "../glyphs";
import { schedulerLook, stageLook, timecode, duration as words } from "../vocab";
import { drawTracks, hitTest, layoutTracks, readPalette, tOf, xOf, type Hit, type View } from "./draw";
import type { TimelineModel, Track } from "./model";
import { usePlayheadEffect } from "./playhead";

export const GUTTER = 176;
const AXIS_H = 22;
const CHAPTER_TIMES = SCENARIO.chapters.map((c) => c.t);

export interface TimeWindow {
  v0: number;
  v1: number;
}

const TICK_STEPS = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];

function TrackHeader({ track, expanded, onToggle, height, focused }: { track: Track; expanded: boolean; onToggle: () => void; height: number; focused: boolean }) {
  const stage = useScene((s) => (track.ticketId ? s.cells[track.ticketId]?.stage : undefined));
  const scheduler = useScene((s) => (track.sliceId ? s.slices[track.sliceId]?.scheduler : undefined));
  const exists = track.kind === "factory" || scheduler !== undefined;
  const look = stage ? stageLook(stage) : scheduler ? schedulerLook(scheduler) : null;
  const { select } = useStore();
  return (
    <div style={{ height }} className={cn("flex items-start gap-1 border-b border-line pl-2 pr-2", focused && "bg-surface-sunken")}>
      {track.agentRows > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${track.ticketId ?? track.title}: ${track.agents.length} agents`}
          className="mt-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-ink-subtle hover:bg-surface-sunken hover:text-ink"
        >
          <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform duration-[var(--mach-duration-fast)]", expanded && "rotate-90")} />
        </button>
      ) : (
        <span className="mt-1.5 size-5 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={() => select(track.ref)}
        className={cn("mt-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-0.5 text-left hover:bg-surface-sunken", !exists && "opacity-55")}
      >
        <span className="sr-only">Select </span>
        {look ? <StateGlyph state={look.state} mark={look.mark} size={11} /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-caption leading-tight text-ink">{track.kind === "factory" ? "Factory" : track.ticketId}</span>
          {track.kind === "slice" && height > 26 ? <span className="block truncate text-[11px] leading-tight text-ink-subtle">{track.sliceId}</span> : null}
          <span className="sr-only">
            {track.kind === "factory" ? ": the wave and its people" : `, ${track.title}`}
            {look ? `: ${look.label}` : ""}
          </span>
        </span>
      </button>
    </div>
  );
}

export const Tracks = memo(function Tracks({
  model,
  window: win,
  onWindow,
  expanded,
  onToggle,
}: {
  model: TimelineModel;
  window: TimeWindow;
  onWindow: (w: TimeWindow) => void;
  expanded: ReadonlySet<string>;
  onToggle: (trackId: string, open?: boolean) => void;
}) {
  const store = useStore();
  const { resolved: theme } = useTheme();
  const selection = useSceneStore((s) => s.selection);
  const hovered = useSceneStore((s) => s.hovered);
  // Only the related cells and slices are drawn (as bands), so subscribe to just those: a string,
  // stable while they stay the same, so an agent's changing tool call does not redraw the tracks.
  const highlightKey = useSceneStore((s) => s.highlighted.filter((r) => r.startsWith("cell:") || r.startsWith("slice:")).join("|"));
  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLCanvasElement>(null);
  const axisRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focusedTrack, setFocusedTrack] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; hit: Hit; t: number } | null>(null);
  const drag = useRef<{ x: number; moved: boolean; id: number } | null>(null);

  const layout = useMemo(() => layoutTracks(model, expanded), [model, expanded]);
  const view: View = useMemo(() => ({ v0: win.v0, v1: win.v1, width: Math.max(1, width) }), [win.v0, win.v1, width]);
  const highlightSet = useMemo(() => new Set(highlightKey ? (highlightKey.split("|") as EntityRef[]) : []), [highlightKey]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // A selected agent or tool call opens its track so its span can be shown.
  useEffect(() => {
    if (!selection) return;
    const where = model.locate(selection);
    if (where && where.row >= 0 && !expanded.has(where.trackId)) onToggle(where.trackId, true);
  }, [selection, model, expanded, onToggle]);

  // Redraw only when what is drawn changes: never on a tick.
  useLayoutEffect(() => {
    const canvas = bodyRef.current;
    const axis = axisRef.current;
    if (!canvas || !axis || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const palette = readPalette(canvas);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(layout.height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${layout.height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTracks({ ctx, model, rows: layout.rows, view, height: layout.height, palette, selection, hovered, highlighted: highlightSet, focusedTrack, chapters: CHAPTER_TIMES });
    }
    axis.width = Math.round(width * dpr);
    axis.height = Math.round(AXIS_H * dpr);
    axis.style.width = `${width}px`;
    axis.style.height = `${AXIS_H}px`;
    const actx = axis.getContext("2d");
    if (actx) {
      actx.setTransform(dpr, 0, 0, dpr, 0, 0);
      actx.clearRect(0, 0, width, AXIS_H);
      const span = view.v1 - view.v0;
      const step = TICK_STEPS.find((s) => (s / span) * width >= 64) ?? 600_000;
      actx.font = `11px ${palette.mono}`;
      actx.fillStyle = palette.inkSubtle;
      actx.strokeStyle = palette.lineStrong;
      actx.beginPath();
      for (let t = Math.ceil(view.v0 / step) * step; t <= view.v1; t += step) {
        const x = Math.round(xOf(view, t)) + 0.5;
        actx.moveTo(x, AXIS_H - 6);
        actx.lineTo(x, AXIS_H);
        if (x + 36 < width) actx.fillText(timecode(t, step < 60_000), x + 3, 13);
      }
      // Minor ticks.
      const minor = step / 5;
      for (let t = Math.ceil(view.v0 / minor) * minor; t <= view.v1; t += minor) {
        const x = Math.round(xOf(view, t)) + 0.5;
        actx.moveTo(x, AXIS_H - 3);
        actx.lineTo(x, AXIS_H);
      }
      actx.stroke();
    }
  }, [width, layout, view, model, selection, hovered, highlightSet, focusedTrack, theme]);

  // The playhead cursor and the live edge: direct DOM writes, every frame, no render.
  usePlayheadEffect(
    (s) => {
      const x = xOf(view, s.playhead);
      const live = xOf(view, s.liveAt);
      if (cursorRef.current) {
        cursorRef.current.style.transform = `translateX(${x}px)`;
        cursorRef.current.style.visibility = x < -1 || x > view.width + 1 ? "hidden" : "visible";
      }
      if (maskRef.current) maskRef.current.style.transform = `translateX(${Math.max(0, Math.min(view.width, live))}px)`;
      // Page the window along with playback when zoomed in.
      const spanMs = win.v1 - win.v0;
      if (s.playing && spanMs < model.duration && s.playhead > win.v1) {
        const v0 = Math.min(model.duration - spanMs, s.playhead - spanMs * 0.1);
        onWindow({ v0, v1: v0 + spanMs });
      }
    },
    [view, win.v0, win.v1, model.duration, onWindow],
  );

  const pointAt = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const canvas = bodyRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = pointAt(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, moved: false, id: e.pointerId };
    store.seek(tOf(view, p.x));
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = pointAt(e);
    if (!p) return;
    if (drag.current) {
      if (Math.abs(e.clientX - drag.current.x) > 3) drag.current.moved = true;
      store.seek(tOf(view, Math.max(0, Math.min(view.width, p.x))));
      setTip(null);
      return;
    }
    const hit = hitTest(layout.rows, view, p.x, p.y, model.duration);
    const liveAt = store.getState().liveAt;
    const t = tOf(view, p.x);
    // Nothing is known past the live edge: no hover there.
    const shown = hit && t <= liveAt ? hit : null;
    setTip(shown ? { x: p.x, y: p.y, hit: shown, t } : null);
    const ref = shown?.ref ?? null;
    if (store.getState().hovered !== ref) store.hover(ref);
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const p = pointAt(e);
    if (!p) return;
    const hit = hitTest(layout.rows, view, p.x, p.y, model.duration);
    if (hit?.ref && tOf(view, p.x) <= store.getState().liveAt) {
      store.select(hit.ref);
      setFocusedTrack(hit.trackId);
    }
  };
  const onPointerLeave = () => {
    setTip(null);
    if (store.getState().hovered) store.hover(null);
  };

  const zoomAround = useCallback(
    (factor: number, atX: number) => {
      const span = win.v1 - win.v0;
      const next = Math.min(model.duration, Math.max(30_000, span * factor));
      const anchor = tOf(view, atX);
      const ratio = view.width > 0 ? atX / view.width : 0.5;
      let v0 = anchor - next * ratio;
      v0 = Math.max(0, Math.min(model.duration - next, v0));
      onWindow({ v0, v1: v0 + next });
    },
    [win, model.duration, view, onWindow],
  );

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const p = pointAt(e);
    if (!p) return;
    if (e.ctrlKey || e.metaKey) {
      zoomAround(Math.pow(1.0025, e.deltaY), p.x);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      const span = win.v1 - win.v0;
      if (span >= model.duration) return;
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / view.width) * span;
      const v0 = Math.max(0, Math.min(model.duration - span, win.v0 + d));
      onWindow({ v0, v1: v0 + span });
    }
  };

  // Ctrl+wheel must be cancellable: React's wheel listener is passive, so add our own.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = (e: globalThis.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = layout.rows.map((r) => r.track.id);
    const i = focusedTrack ? ids.indexOf(focusedTrack) : -1;
    let handled = true;
    if (e.key === "ArrowLeft" && !e.shiftKey && !e.altKey) store.stepPrevious();
    else if (e.key === "ArrowRight" && !e.shiftKey && !e.altKey) store.stepNext();
    else if (e.key === "ArrowDown") setFocusedTrack(ids[Math.min(ids.length - 1, i + 1)] ?? null);
    else if (e.key === "ArrowUp") setFocusedTrack(ids[Math.max(0, i - 1)] ?? null);
    else if (e.key === "Enter" && focusedTrack) {
      const row = layout.rows.find((r) => r.track.id === focusedTrack);
      if (row) store.select(row.track.ref);
    } else if ((e.key === "ArrowRight" && e.altKey) || e.key === "*") {
      if (focusedTrack) onToggle(focusedTrack, true);
    } else if (e.key === "ArrowLeft" && e.altKey) {
      if (focusedTrack) onToggle(focusedTrack, false);
    } else if (e.key === "+" || e.key === "=") zoomAround(1 / 1.5, xOf(view, store.getState().playhead));
    else if (e.key === "-") zoomAround(1.5, xOf(view, store.getState().playhead));
    else if (e.key === "0") onWindow({ v0: 0, v1: model.duration });
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Keep the focused track in view.
  useEffect(() => {
    if (!focusedTrack) return;
    const row = layout.rows.find((r) => r.track.id === focusedTrack);
    const el = scrollRef.current;
    if (!row || !el) return;
    if (row.y < el.scrollTop) el.scrollTop = row.y;
    else if (row.y + row.height > el.scrollTop + el.clientHeight) el.scrollTop = row.y + row.height - el.clientHeight;
  }, [focusedTrack, layout]);

  const tipText = tip ? `${tip.hit.start !== tip.hit.end && tip.hit.end !== tip.hit.start ? `${timecode(tip.hit.start, false)} to ${tip.hit.end === null ? "now" : timecode(tip.hit.end, false)}` : timecode(tip.hit.start)}` : "";
  const tipDur = tip && tip.hit.end !== null && tip.hit.end - tip.hit.start >= 1000 ? words(tip.hit.end - tip.hit.start) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The time axis. */}
      <div className="flex shrink-0 border-b border-line">
        <div style={{ width: GUTTER }} className="flex shrink-0 items-center px-3 text-[11px] text-ink-subtle">
          Factory time, from start
        </div>
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <canvas ref={axisRef} aria-hidden="true" className="block" />
        </div>
      </div>
      {/* Tracks: headers and canvas scroll together. */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onWheel={onWheel}>
        <div className="flex">
          <div style={{ width: GUTTER }} className="shrink-0 border-r border-line">
            {layout.rows.map((r) => (
              <TrackHeader key={r.track.id} track={r.track} height={r.height} expanded={r.expanded} focused={focusedTrack === r.track.id} onToggle={() => onToggle(r.track.id)} />
            ))}
          </div>
          <div ref={wrapRef} className="relative min-w-0 flex-1">
            {/* One tab stop for every track, with its own arrow keys: an application region, which the
                lint rule does not count as interactive. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <div
              role="application"
              aria-roledescription="timeline tracks"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              aria-label="Execution tracks. Left and right arrows step between events; up and down choose a track; Enter selects it."
              aria-describedby="mach-tracks-hint"
              onKeyDown={onKeyDown}
              onFocus={() => setFocusedTrack((f) => f ?? layout.rows[1]?.track.id ?? null)}
              className="relative outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <canvas
                ref={bodyRef}
                aria-hidden="true"
                className="block cursor-crosshair touch-none"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => (drag.current = null)}
                onPointerLeave={onPointerLeave}
              />
            </div>
            {tip ? (
              <div
                role="presentation"
                className="pointer-events-none absolute z-10 max-w-80 rounded-sm border border-line bg-surface-raised px-2.5 py-1.5 shadow-2"
                style={{ left: Math.min(tip.x + 14, Math.max(0, view.width - 300)), top: tip.y + 14 }}
              >
                <p className="truncate text-caption font-semibold text-ink">{tip.hit.title}</p>
                {tip.hit.detail ? <p className="truncate text-caption text-ink-muted">{tip.hit.detail}</p> : null}
                <p className="font-mono text-[11px] text-ink-subtle tabular">
                  {tipText}
                  {tipDur ? `, ${tipDur}` : ""}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <p id="mach-tracks-hint" className="sr-only">
        Click a span to select it and move the playhead there; drag to scrub. Ctrl and the scroll wheel zoom time; plus, minus and zero zoom while the tracks have focus.
      </p>
      {/* Overlays over the time area: the live edge (nothing beyond it has happened) and the playhead. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 overflow-hidden" style={{ left: GUTTER }}>
        <div ref={maskRef} className="mach-future absolute inset-y-0 left-0 w-full border-l border-dashed border-line-strong" />
        <div ref={cursorRef} className="absolute inset-y-0 left-0 w-0">
          <div className="absolute inset-y-0 -left-px w-0.5 bg-ink" />
          <div className="absolute -left-[5px] top-0 size-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-ink" />
        </div>
      </div>
    </div>
  );
});

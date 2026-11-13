/**
 * The time ruler of the detailed window: adaptive ticks from 100 ms to a day (majors at least 72 px
 * apart, with minors), UTC labels in 11 px mono whose format follows the step, and date changes
 * marked with a full-height tick and the day. The playhead and the live edge are DOM written on every
 * store tick. Dragging the ruler pans time; the wheel zooms about the pointer (horizontal wheel pans).
 */
import { memo, useEffect, useLayoutEffect, useRef, type PointerEvent } from "react";
import { useTheme } from "@mach/ui";
import { usePlayheadEffect } from "../../shell/timeline/playhead";
import { RULER_HEIGHT, type TimeWindow, type WindowRulerProps } from "../contract";
import { readPalette } from "./palette";
import { clampWindow, dateChanges, dayLabel, isWallTime, panBy, scaleOf, tAt, tickLabel, ticksFor, xAt, zoomAbout } from "./scale";

export const WindowRuler = memo(function WindowRuler({ viewport, onWindow }: WindowRulerProps) {
  const { window: win, width, liveAt } = viewport;
  const { resolved: theme } = useTheme();
  const ref = useRef<HTMLCanvasElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; win: TimeWindow } | null>(null);
  const latest = useRef({ viewport, onWindow });
  const pending = useRef<TimeWindow | null>(null);
  useLayoutEffect(() => {
    latest.current = { viewport, onWindow };
    pending.current = null;
  });

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0) return;
    const p = readPalette(canvas);
    const dpr = window.devicePixelRatio || 1;
    const H = RULER_HEIGHT;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.ground;
    ctx.fillRect(0, 0, width, H);
    const scale = scaleOf(win, width);
    const ticks = ticksFor(win, width);
    const wall = isWallTime(win.from);
    const days = new Set(dateChanges(win));

    // Minors, then majors: a drafting scale along the bottom edge.
    ctx.fillStyle = p.plateEdge;
    for (const t of ticks.minors) ctx.fillRect(Math.round(xAt(scale, t)), H - 4, 1, 4);
    for (const t of ticks.majors) {
      const x = Math.round(xAt(scale, t));
      if (days.has(t)) {
        ctx.fillStyle = p.inkMuted;
        ctx.fillRect(x, 3, 1, H - 3);
        ctx.fillStyle = p.plateEdge;
      } else ctx.fillRect(x, H - 8, 1, 8);
    }
    ctx.fillStyle = p.plateEdge;
    ctx.fillRect(0, H - 1, width, 1);

    // Labels: after each major, skipped where they would collide; a new day's tick carries the day.
    const mono = `400 11px ${p.mono}`;
    const day = `600 11px ${p.mono}`;
    ctx.textBaseline = "alphabetic";
    let lastRight = -Infinity;
    for (const t of ticks.majors) {
      const x = Math.round(xAt(scale, t));
      const isDay = days.has(t) && ticks.major < 86_400_000;
      const text = isDay ? dayLabel(t) : tickLabel(t, ticks.major, wall);
      ctx.font = isDay ? day : mono;
      const w = ctx.measureText(text).width;
      if (x + 4 < lastRight + 10 || x + 4 + w > width - 2) continue;
      ctx.fillStyle = isDay ? p.ink : p.inkSubtle;
      ctx.fillText(text, x + 4, 13);
      lastRight = x + 4 + w;
    }
    // Where the window starts, when no label is near the left edge: the day (wall time) to anchor the reading.
    if (wall && (ticks.majors.length === 0 || xAt(scale, ticks.majors[0]!) > 70)) {
      ctx.font = day;
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(dayLabel(win.from), 4, 13);
    }
    // Nothing is known after the live edge.
    const xl = xAt(scale, liveAt);
    if (xl < width) {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = p.ground;
      ctx.fillRect(Math.max(0, xl + 1), 0, width, H - 1);
      ctx.globalAlpha = 1;
    }
  }, [win, width, liveAt, theme]);

  usePlayheadEffect(
    (s) => {
      const scale = scaleOf(win, width);
      const x = xAt(scale, s.playhead);
      if (playRef.current) {
        playRef.current.style.transform = `translateX(${Math.round(x)}px)`;
        playRef.current.style.visibility = x < -6 || x > width + 6 ? "hidden" : "visible";
      }
      const l = xAt(scale, Math.max(s.liveAt, liveAt));
      if (liveRef.current) {
        liveRef.current.style.transform = `translateX(${Math.round(l)}px)`;
        liveRef.current.style.visibility = l < 0 || l >= width ? "hidden" : "visible";
      }
    },
    [win.from, win.to, width, liveAt],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { viewport: v, onWindow: go } = latest.current;
      const base = pending.current ?? v.window;
      const scale = scaleOf(base, v.width);
      const unit = e.deltaMode === 1 ? 16 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      let next: TimeWindow;
      if (Math.abs(dx) > Math.abs(dy) || e.shiftKey) next = panBy(base, (Math.abs(dx) > Math.abs(dy) ? dx : dy) / scale.k);
      else {
        const r = el.getBoundingClientRect();
        next = zoomAbout(base, Math.exp(dy * 0.0022), tAt(scale, e.clientX - r.left));
      }
      pending.current = clampWindow(next);
      go(pending.current);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, win };
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const k = scaleOf(d.win, width).k;
    onWindow(panBy(d.win, -(e.clientX - d.x) / k));
  };

  return (
    <div className="relative overflow-hidden" style={{ width, height: RULER_HEIGHT }}>
      <canvas
        ref={ref}
        aria-hidden="true"
        className="block cursor-ew-resize touch-none select-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div ref={liveRef} className="absolute inset-y-0 left-0 w-0">
          <div className="absolute inset-y-0 left-0 border-l border-dashed" style={{ borderColor: "var(--mach-factory-plate-edge)" }} />
        </div>
        <div ref={playRef} className="absolute inset-y-0 left-0 w-0">
          <div className="absolute bottom-0 -left-px top-0 w-0.5 bg-ink" />
          <div className="absolute -left-[5px] top-0 size-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-ink" />
        </div>
      </div>
    </div>
  );
});

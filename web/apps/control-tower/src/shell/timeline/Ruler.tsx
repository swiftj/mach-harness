/**
 * The scrubber over everything held: chapters (the simulation's storyboard) or landmarks (real
 * history: a wave arriving, the Factory enabled or paused, executions starting and ending, verdicts,
 * a person needed or approving), the significant moments as ticks, the live edge, the playhead, and
 * (when the tracks are zoomed) the window they show. A slider for assistive technology: its value is
 * written directly on every frame.
 *
 * Simulation: a chapter's title appears only once the playhead has reached it, and the run beyond the
 * live edge is shown as not yet happened. Real history has no future: the live edge is the right end,
 * and nothing can be sought past it. Moments and landmarks are aggregated by pixel, so a long history
 * (hundreds of thousands of events) draws one mark per column, not one per event.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@mach/ui";
import { useSceneStore, useStore } from "../../scene";
import { lastAtOrBefore, quotingKindOf, type Landmark } from "../history";
import { stepChapter } from "../keyboard";
import { useHistoryIndex } from "../source/context";
import { spokenTime, timecode } from "../vocab";
import { GUTTER, type TimeWindow } from "./Tracks";
import { setScrubbing } from "../scrub";
import { usePlayheadEffect } from "./playhead";
import { codesOnlyWords } from "../../text/fields";

interface Tip {
  x: number;
  text: string;
  t: number;
}

/** One path of 1-px columns, one per pixel that has at least one item. */
function columns(items: readonly { t: number }[], v0: number, span: number, width: number, top: number, bottom: number): string {
  if (width <= 0 || span <= 0) return "";
  let d = "";
  let lastX = -1;
  for (const m of items) {
    const x = Math.round(((m.t - v0) / span) * width);
    if (x < 0 || x > width || x === lastX) continue;
    lastX = x;
    d += `M${x + 0.5} ${top}V${bottom}`;
  }
  return d;
}

export const Ruler = memo(function Ruler({ extent, window: win, zoomed, onWindow }: { extent: TimeWindow; window: TimeWindow; zoomed: boolean; onWindow: (w: TimeWindow) => void }) {
  const store = useStore();
  const index = useHistoryIndex();
  const source = useSceneStore((s) => s.source);
  const storyboard = index.storyboard;
  const chapters = index.landmarks;
  const current = useSceneStore((s) => (index.storyboard ? lastAtOrBefore(index.landmarks, s.playhead) : null));
  // Chapters up to this index have been reached by the playhead; later ones are numbers only.
  const reached = current ? chapters.indexOf(current) : -1;
  const trackRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  const dragging = useRef(false);
  const v0 = extent.v0;
  const span = Math.max(1, extent.v1 - extent.v0);
  // The whole history's density (`/api/v1/series`), so what is not held is still drawn (D17).
  const series = useSceneStore((s) => (s.source === "simulation" ? null : s.series));
  const density = useMemo(() => {
    if (!series || !series.buckets.length || width <= 0) return null;
    const max = Math.max(...series.buckets.map((b) => b.count));
    let d = "";
    for (const b of series.buckets) {
      const x0 = ((b.fromMs - v0) / span) * width;
      const x1 = ((b.fromMs + series.bucketMs - v0) / span) * width;
      if (x1 < 0 || x0 > width) continue;
      const h = Math.max(1, Math.round((Math.log1p(b.count) / Math.log1p(max)) * 8));
      d += `M${Math.max(0, x0).toFixed(1)} ${8 - h}h${Math.max(1, Math.min(width, x1) - Math.max(0, x0)).toFixed(1)}v${h}h-${Math.max(1, Math.min(width, x1) - Math.max(0, x0)).toFixed(1)}Z`;
    }
    return d;
  }, [series, width, v0, span]);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  usePlayheadEffect(
    (s) => {
      const p = (s.playhead - v0) / span;
      if (headRef.current) headRef.current.style.left = `${Math.max(0, Math.min(1, p)) * 100}%`;
      // The simulation shades what has happened so far; real history has happened up to its right end.
      if (liveRef.current) liveRef.current.style.width = `${Math.max(0, Math.min(1, (s.liveAt - v0) / span)) * 100}%`;
      const slider = sliderRef.current;
      if (slider) {
        slider.setAttribute("aria-valuemin", String(Math.round(v0 / 1000)));
        slider.setAttribute("aria-valuemax", String(Math.round((s.source === "simulation" ? extent.v1 : s.liveAt) / 1000)));
        slider.setAttribute("aria-valuenow", String(Math.round(s.playhead / 1000)));
        // Spoken text changes at most once a second of factory time to keep screen readers calm.
        const where = s.source === "simulation" ? (s.following ? ", live" : ", replay") : s.source === "replay" ? ", replay" : s.following ? ", at the live edge" : ", reviewing earlier history";
        slider.setAttribute("aria-valuetext", `${spokenTime(s.playhead)}${where}`);
      }
    },
    [v0, span, extent.v1],
  );

  // Storyboard chapter labels: numbered always; a title only once reached, and only where it fits before the next one.
  const labels = useMemo(() => {
    const out: Array<{ number: boolean; title: boolean }> = [];
    if (!storyboard) return out;
    let lastEnd = -Infinity;
    chapters.forEach((c, i) => {
      const x = ((c.t - v0) / span) * width;
      const next = chapters[i + 1];
      const nextX = next ? ((next.t - v0) / span) * width : width;
      const numW = i + 1 >= 10 ? 20 : 13;
      const number = x >= lastEnd + 2;
      const w = c.title.length * 6.1 + numW + 8;
      const title = i <= reached && number && x + w < nextX - 4 && x + w < width;
      out.push({ number, title });
      if (title) lastEnd = x + w;
      else if (number) lastEnd = x + numW;
    });
    return out;
  }, [width, v0, span, reached, chapters, storyboard]);

  // Ticks, in pixel space, one per column: recomputed when what is held, the width or the extent changes.
  const ticks = useMemo(() => {
    const major = columns(index.moments.filter((m) => m.significance !== "chapter"), v0, span, width, 3, 10);
    const chapter = columns(index.moments.filter((m) => m.significance === "chapter"), v0, span, width, 0, 10);
    const landmarks = storyboard ? "" : columns(chapters, v0, span, width, 0, 6);
    return { major, chapter, landmarks };
    // index.version stands for its (mutated) arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, index.version, v0, span, width, chapters, storyboard]);

  const tAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return v0;
    const r = el.getBoundingClientRect();
    // Seeking past the live edge is clamped by the store: there is nothing there to see.
    return Math.max(v0, Math.min(v0 + span, v0 + ((clientX - r.left) / r.width) * span));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    setScrubbing(true);
    store.seek(tAt(e.clientX));
    sliderRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) {
      store.seek(tAt(e.clientX));
      return;
    }
    const t = tAt(e.clientX);
    const tolerance = (6 / Math.max(1, width)) * span;
    const liveAt = store.getState().liveAt;
    // The nearest landmark, else the nearest moment, within 6 px and not beyond the live edge.
    const near = <T extends { t: number }>(list: readonly T[]): T | null => {
      const before = lastAtOrBefore(list, t + tolerance);
      return before && Math.abs(before.t - t) <= tolerance && before.t <= liveAt ? before : null;
    };
    const mark: Landmark | null = storyboard ? null : near(chapters);
    const moment = mark ? null : near(index.moments);
    // A tooltip says codes and counts only: an event that carries prose is named by its kind (C1).
    const found = mark ? { t: mark.t, text: (mark.eventType && codesOnlyWords(mark.eventType)) || mark.title } : moment ? { t: moment.t, text: (storyboard ? null : codesOnlyWords(quotingKindOf(store.getState().log, moment) ?? "", moment.ticketId)) || moment.text } : null;
    setTip(found ? { x: ((found.t - v0) / span) * width, text: found.text, t: found.t } : null);
  };
  const stop = () => {
    dragging.current = false;
    setScrubbing(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let handled = true;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") store.stepPrevious();
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") store.stepNext();
    else if (e.key === "PageUp") stepChapter(store, -1);
    else if (e.key === "PageDown") stepChapter(store, 1);
    else if (e.key === "Home") store.seek(store.getState().extent.start);
    else if (e.key === "End") store.followLive();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const label = storyboard ? "Chapters" : chapters.length ? "Landmarks" : "Moments";

  return (
    <div className="flex h-[38px] shrink-0 border-b border-line">
      <div style={{ width: GUTTER }} className="flex shrink-0 items-center justify-between gap-2 px-3">
        <span className="text-[11px] text-ink-subtle" title={storyboard ? "The scenario's storyboard" : "Real moments: waves arriving, the Factory enabled or paused, executions starting and ending, verdicts, people needed or approving"}>
          {label}
        </span>
        {zoomed ? (
          <button type="button" onClick={() => onWindow(extent)} className="rounded-xs px-1 text-[11px] text-accent-ink underline underline-offset-2 hover:decoration-2">
            Show all
          </button>
        ) : null}
      </div>
      <div
        ref={trackRef}
        className="relative min-w-0 flex-1 cursor-pointer select-none touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onPointerLeave={() => setTip(null)}
      >
        {/* The slider is the strip itself; the storyboard's chapter flags are buttons inside the same strip. */}
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          aria-label={source === "simulation" ? "Playhead over the whole run" : "Playhead over the history received so far"}
          aria-valuemin={0}
          aria-valuemax={0}
          aria-valuenow={0}
          onKeyDown={onKeyDown}
          className="absolute inset-x-0 bottom-0 h-[16px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <div className="absolute inset-x-0 bottom-[7px] h-px bg-line-strong" />
          {density ? (
            <svg aria-hidden="true" data-series={series?.coarse ? "coarse" : "series"} width={Math.max(1, width)} height="8" className="pointer-events-none absolute left-0 bottom-[8px] h-[8px]">
              <path d={density} style={{ fill: "var(--mach-ink-subtle)", opacity: 0.35 }} />
            </svg>
          ) : null}
          <div ref={liveRef} className="absolute bottom-[6px] left-0 h-[3px] bg-factory-live-soft" />
          <svg aria-hidden="true" width={Math.max(1, width)} height="10" className="absolute left-0 bottom-[3px] h-[10px] overflow-visible">
            <path d={ticks.major} style={{ stroke: "var(--mach-ink-subtle)", strokeWidth: 1 }} />
            <path d={ticks.chapter} style={{ stroke: "var(--mach-ink)", strokeWidth: 1.5 }} />
          </svg>
          {zoomed ? (
            <div
              className="absolute bottom-[1px] h-[14px] rounded-xs border border-factory-select"
              style={{ left: `${((win.v0 - v0) / span) * 100}%`, width: `${((win.v1 - win.v0) / span) * 100}%` }}
            />
          ) : null}
          <div ref={headRef} className="absolute bottom-0 h-[16px] w-0">
            <div className="absolute -left-[5px] bottom-[2px] size-[10px] rotate-45 rounded-[1px] border-2 border-ink bg-surface" />
          </div>
        </div>
        {storyboard ? (
          chapters.map((c, i) => {
            const left = ((c.t - v0) / span) * 100;
            const isCurrent = current?.id === c.id;
            const known = i <= reached;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => store.seekToChapter(c.id)}
                title={known ? `${i + 1}. ${(c.eventType && codesOnlyWords(c.eventType)) || c.title} (${timecode(c.t, false)})` : `Chapter ${i + 1} (${timecode(c.t, false)}): not reached yet`}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "absolute top-0 flex h-[24px] min-w-[24px] items-center gap-1 whitespace-nowrap rounded-xs pl-[3px] pr-1 text-[11px] leading-none",
                  isCurrent ? "text-ink" : "text-ink-subtle hover:text-ink",
                )}
                style={{ left: `${left}%`, zIndex: isCurrent ? 2 : 1 }}
              >
                <span aria-hidden="true" className="absolute -left-px top-[3px] h-[20px] w-px bg-current opacity-60" />
                <span className="sr-only">Chapter </span>
                <span className={cn("font-mono tabular", isCurrent && "font-semibold", !labels[i]?.number && "sr-only")}>{i + 1}</span>
                {known ? (
                  <>
                    <span className="sr-only">: </span>
                    <span className={cn("truncate", isCurrent && "font-semibold", !labels[i]?.title && "sr-only")}>{(c.eventType && codesOnlyWords(c.eventType)) || c.title}</span>
                  </>
                ) : (
                  <span className="sr-only">, not reached yet</span>
                )}
                <span className="sr-only">, at {timecode(c.t, false)}</span>
              </button>
            );
          })
        ) : (
          // Real landmarks: one flag per pixel column along the top. Stepped with [ and ] (or PageUp
          // and PageDown on the slider); named by hovering, by the transport and in Theater Mode.
          <svg aria-hidden="true" width={Math.max(1, width)} height="8" className="pointer-events-none absolute left-0 top-[4px]">
            <path d={ticks.landmarks} style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 1.5 }} />
          </svg>
        )}
        {tip ? (
          <div role="presentation" className="pointer-events-none absolute bottom-[20px] z-10 max-w-80 -translate-x-1/2 rounded-sm border border-line bg-surface-raised px-2.5 py-1.5 shadow-2" style={{ left: Math.max(150, Math.min(width - 150, tip.x)) }}>
            <p className="text-caption text-ink">{tip.text}</p>
            <p className="font-mono text-[11px] text-ink-subtle tabular">{timecode(tip.t)}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});

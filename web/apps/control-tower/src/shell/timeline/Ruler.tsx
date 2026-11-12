/**
 * The scrubber over the whole run: chapters as numbered flags, the run's significant moments as
 * ticks, the live edge, the playhead, and (when the tracks are zoomed) the window they show. A
 * chapter's title appears only once the playhead has reached it: before that its flag is a number,
 * so the ruler never names what has not happened yet. A slider for assistive technology: its value
 * is written directly on every frame.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@mach/ui";
import { chapterAt, SCENARIO, type Moment } from "../../sim";
import { useSceneStore, useStore } from "../../scene";
import { stepChapter } from "../keyboard";
import { spokenTime, timecode } from "../vocab";
import { GUTTER, type TimeWindow } from "./Tracks";
import { usePlayheadEffect } from "./playhead";

const CHAPTERS = SCENARIO.chapters;

export const Ruler = memo(function Ruler({ moments, duration, window: win, onWindow }: { moments: readonly Moment[]; duration: number; window: TimeWindow; onWindow: (w: TimeWindow) => void }) {
  const store = useStore();
  const current = useSceneStore((s) => chapterAt(s.fixture, s.playhead));
  // Chapters up to this index have been reached by the playhead; later ones are numbers only.
  const reached = current ? CHAPTERS.findIndex((c) => c.id === current.id) : -1;
  const trackRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<{ x: number; moment: Moment } | null>(null);
  const dragging = useRef(false);

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
      const p = s.playhead / duration;
      if (headRef.current) headRef.current.style.left = `${p * 100}%`;
      if (liveRef.current) liveRef.current.style.width = `${(s.liveAt / duration) * 100}%`;
      const slider = sliderRef.current;
      if (slider) {
        slider.setAttribute("aria-valuenow", String(Math.round(s.playhead / 1000)));
        // Spoken text changes at most once a second of factory time to keep screen readers calm.
        slider.setAttribute("aria-valuetext", `${spokenTime(s.playhead)}${s.following ? ", live" : ", replay"}`);
      }
    },
    [duration],
  );

  // Chapter labels: numbered always; a title only once reached, and only where it fits before the next one.
  const labels = useMemo(() => {
    const out: Array<{ number: boolean; title: boolean }> = [];
    let lastEnd = -Infinity;
    CHAPTERS.forEach((c, i) => {
      const x = (c.t / duration) * width;
      const next = CHAPTERS[i + 1];
      const nextX = next ? (next.t / duration) * width : width;
      const numW = i + 1 >= 10 ? 20 : 13;
      const number = x >= lastEnd + 2;
      const w = c.title.length * 6.1 + numW + 8;
      const title = i <= reached && number && x + w < nextX - 4 && x + w < width;
      out.push({ number, title });
      if (title) lastEnd = x + w;
      else if (number) lastEnd = x + numW;
    });
    return out;
  }, [width, duration, reached]);

  const ticks = useMemo(() => {
    let major = "";
    let chapter = "";
    for (const m of moments) {
      const x = (m.t / duration) * 1000;
      if (m.significance === "chapter") chapter += `M${x.toFixed(2)} 0V10`;
      else major += `M${x.toFixed(2)} 3V10`;
    }
    return { major, chapter };
  }, [moments, duration]);

  const tAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    store.seek(tAt(e.clientX));
    sliderRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) {
      store.seek(tAt(e.clientX));
      return;
    }
    const t = tAt(e.clientX);
    const tolerance = (6 / Math.max(1, width)) * duration;
    const near = moments.reduce<Moment | null>((best, m) => (Math.abs(m.t - t) <= tolerance && (!best || Math.abs(m.t - t) < Math.abs(best.t - t)) ? m : best), null);
    const liveAt = store.getState().liveAt;
    setTip(near && near.t <= liveAt ? { x: (near.t / duration) * width, moment: near } : null);
  };
  const stop = () => {
    dragging.current = false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let handled = true;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") store.stepPrevious();
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") store.stepNext();
    else if (e.key === "PageUp") stepChapter(store, -1);
    else if (e.key === "PageDown") stepChapter(store, 1);
    else if (e.key === "Home") store.seek(0);
    else if (e.key === "End") store.followLive();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const zoomed = win.v1 - win.v0 < duration - 1;

  return (
    <div className="flex h-[38px] shrink-0 border-b border-line">
      <div style={{ width: GUTTER }} className="flex shrink-0 items-center justify-between gap-2 px-3">
        <span className="text-[11px] text-ink-subtle">Chapters</span>
        {zoomed ? (
          <button type="button" onClick={() => onWindow({ v0: 0, v1: duration })} className="rounded-xs px-1 text-[11px] text-accent-ink underline underline-offset-2 hover:decoration-2">
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
        onPointerLeave={() => setTip(null)}
      >
        {/* The slider is the strip itself; the chapter flags are buttons inside the same strip. */}
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          aria-label="Playhead over the whole run"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={0}
          onKeyDown={onKeyDown}
          className="absolute inset-x-0 bottom-0 h-[16px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <div className="absolute inset-x-0 bottom-[7px] h-px bg-line-strong" />
          <div ref={liveRef} className="absolute bottom-[6px] left-0 h-[3px] bg-factory-live-soft" />
          <svg aria-hidden="true" viewBox="0 0 1000 10" preserveAspectRatio="none" className="absolute inset-x-0 bottom-[3px] h-[10px] w-full overflow-visible">
            <path d={ticks.major} style={{ stroke: "var(--mach-ink-subtle)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" }} />
            <path d={ticks.chapter} style={{ stroke: "var(--mach-ink)", strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" }} />
          </svg>
          {zoomed ? (
            <div
              className="absolute bottom-[1px] h-[14px] rounded-xs border border-factory-select"
              style={{ left: `${(win.v0 / duration) * 100}%`, width: `${((win.v1 - win.v0) / duration) * 100}%` }}
            />
          ) : null}
          <div ref={headRef} className="absolute bottom-0 h-[16px] w-0">
            <div className="absolute -left-[5px] bottom-[2px] size-[10px] rotate-45 rounded-[1px] border-2 border-ink bg-surface" />
          </div>
        </div>
        {CHAPTERS.map((c, i) => {
          const left = (c.t / duration) * 100;
          const isCurrent = current?.id === c.id;
          const known = i <= reached;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => store.seekToChapter(c.id)}
              title={known ? `${i + 1}. ${c.title} (${timecode(c.t, false)})` : `Chapter ${i + 1} (${timecode(c.t, false)}): not reached yet`}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "absolute top-[3px] flex h-[16px] items-center gap-1 whitespace-nowrap rounded-xs pl-[3px] pr-1 text-[11px] leading-none",
                isCurrent ? "text-ink" : "text-ink-subtle hover:text-ink",
              )}
              style={{ left: `${left}%`, zIndex: isCurrent ? 2 : 1 }}
            >
              <span aria-hidden="true" className="absolute -left-px top-0 h-[20px] w-px bg-current opacity-60" />
              <span className="sr-only">Chapter </span>
              <span className={cn("font-mono tabular", isCurrent && "font-semibold", !labels[i]?.number && "sr-only")}>{i + 1}</span>
              {known ? (
                <>
                  <span className="sr-only">: </span>
                  <span className={cn("truncate", isCurrent && "font-semibold", !labels[i]?.title && "sr-only")}>{c.title}</span>
                </>
              ) : (
                <span className="sr-only">, not reached yet</span>
              )}
              <span className="sr-only">, at {timecode(c.t, false)}</span>
            </button>
          );
        })}
        {tip ? (
          <div role="presentation" className="pointer-events-none absolute bottom-[20px] z-10 max-w-80 -translate-x-1/2 rounded-sm border border-line bg-surface-raised px-2.5 py-1.5 shadow-2" style={{ left: Math.max(150, Math.min(width - 150, tip.x)) }}>
            <p className="text-caption text-ink">{tip.moment.text}</p>
            <p className="font-mono text-[11px] text-ink-subtle tabular">{timecode(tip.moment.t)}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});

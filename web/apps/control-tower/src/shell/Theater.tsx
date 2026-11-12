/**
 * Theater Mode's overlays (spec f.7): the simulation stamp top left, the mode word top right, a
 * caption naming the chapter and the latest significant moment, and a slim progress line with the
 * time code. Pointer movement shows a compact transport for 2.5 s; it stays while hovered or focused.
 */
import { ChevronsLeft, ChevronsRight, Minimize2, Pause, Play, StepBack, StepForward } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@mach/ui";
import { chapterAt, moments, SCENARIO, type Moment } from "../sim";
import { useSceneStore, useStore } from "../scene";
import { SimulationStamp } from "./chrome";
import { stepChapter } from "./keyboard";
import { IconButton, TimeCode } from "./timeline/Transport";
import { usePlayheadEffect } from "./timeline/playhead";

const MAJOR = moments(SCENARIO, "major");

function latest(t: number): Moment | null {
  let lo = 0;
  let hi = MAJOR.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((MAJOR[mid] as Moment).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return MAJOR[lo - 1] ?? null;
}

function Caption() {
  const chapter = useSceneStore((s) => chapterAt(s.fixture, s.playhead));
  const moment = useSceneStore((s) => latest(s.playhead));
  if (!chapter) return null;
  const recent = moment && moment.t >= chapter.t ? moment : null;
  return (
    <div className="max-w-[min(720px,70%)] rounded-sm bg-surface/90 px-3 py-2 shadow-1 backdrop-blur-[2px]" data-theater-caption="">
      <p className="font-serif text-body-lg leading-snug text-ink">{chapter.title}</p>
      {recent ? <p className="mt-0.5 text-body-sm text-ink-muted">{recent.text}</p> : null}
    </div>
  );
}

export function TheaterOverlay() {
  const view = useSceneStore((s) => s.view);
  const playing = useSceneStore((s) => s.playing);
  const following = useSceneStore((s) => s.following);
  const store = useStore();
  const [awake, setAwake] = useState(true);
  const [held, setHeld] = useState(false);
  const fillRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const duration = SCENARIO.duration;

  useEffect(() => {
    const wake = () => {
      setAwake(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAwake(false), 2500);
    };
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  usePlayheadEffect((s) => {
    if (fillRef.current) fillRef.current.style.width = `${(s.playhead / duration) * 100}%`;
    if (liveRef.current) liveRef.current.style.width = `${(s.liveAt / duration) * 100}%`;
  }, []);

  const shown = awake || held;
  return (
    <>
      <div className="pointer-events-none absolute left-4 top-4 z-20">
        <SimulationStamp size="lg" className="shadow-1" />
      </div>
      <p className="pointer-events-none absolute right-4 top-4 z-20 text-body-sm text-ink-muted" aria-hidden="true">
        {view === "atlas" ? "Atlas" : "Blueprint"}
      </p>
      <div className="pointer-events-none absolute bottom-7 left-4 z-20">
        <Caption />
      </div>
      <div
        className={cn("mach-theater-bar absolute bottom-9 right-4 z-20 flex items-center gap-1 rounded-md border border-line bg-surface-raised px-1.5 py-1 shadow-2", shown ? "opacity-100" : "pointer-events-none opacity-0")}
        role="toolbar"
        aria-label="Theater transport"
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
      >
        <IconButton label="Previous chapter" shortcut="[" onClick={() => stepChapter(store, -1)}>
          <ChevronsLeft aria-hidden="true" />
        </IconButton>
        <IconButton label="Previous event" shortcut="," onClick={store.stepPrevious}>
          <StepBack aria-hidden="true" />
        </IconButton>
        <IconButton label={playing ? "Pause" : "Play"} shortcut="Space" onClick={store.toggle}>
          {playing ? <Pause aria-hidden="true" fill="currentColor" /> : <Play aria-hidden="true" fill="currentColor" />}
        </IconButton>
        <IconButton label="Next event" shortcut="." onClick={store.stepNext}>
          <StepForward aria-hidden="true" />
        </IconButton>
        <IconButton label="Next chapter" shortcut="]" onClick={() => stepChapter(store, 1)}>
          <ChevronsRight aria-hidden="true" />
        </IconButton>
        {following ? null : (
          <button type="button" onClick={store.followLive} className="mx-1 h-7 rounded-sm px-2 text-caption font-semibold text-accent-ink underline underline-offset-[3px]">
            Return to live
          </button>
        )}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <IconButton label="Leave Theater Mode" shortcut="T" onClick={() => store.setTheater(false)}>
          <Minimize2 aria-hidden="true" />
        </IconButton>
      </div>
      {/* The 3 px progress line and the time code. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex h-6 items-end" aria-hidden="true">
        <div className="relative h-[3px] flex-1 bg-line">
          <div ref={liveRef} className="absolute inset-y-0 left-0 bg-factory-live-soft" />
          <div ref={fillRef} className="absolute inset-y-0 left-0 bg-ink" />
        </div>
        <div className="absolute bottom-1.5 right-4 flex items-center gap-2">
          {following ? <span className="text-caption font-semibold text-factory-live">Live</span> : <span className="text-caption text-ink-muted">Replay</span>}
          <TimeCode size="lg" />
        </div>
      </div>
    </>
  );
}

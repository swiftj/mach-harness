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
import { FollowState, IconButton, TimeCode } from "./timeline/Transport";
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

/** Height of the strips Theater Mode keeps free of the views (the stage is inset by these). */
export const THEATER_TOP = 48;
export const THEATER_BOTTOM = 64;

function Caption() {
  const chapter = useSceneStore((s) => chapterAt(s.fixture, s.playhead));
  const moment = useSceneStore((s) => latest(s.playhead));
  if (!chapter) return null;
  const recent = moment && moment.t >= chapter.t ? moment : null;
  return (
    <div className="min-w-0" data-theater-caption="">
      <p className="truncate font-sans text-body-lg font-semibold leading-snug text-ink">{chapter.title}</p>
      {recent ? <p className="truncate text-body-sm text-ink-muted">{recent.text}</p> : null}
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
  // Two strips the views never draw into (the stage is inset by them), so nothing here can sit over
  // either view's sheet furniture: the stamp and the mode word above, the caption, transport and
  // time code below.
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4" style={{ height: THEATER_TOP }}>
        <SimulationStamp size="lg" />
        <p className="text-body-sm text-ink-muted" aria-hidden="true">
          {view === "atlas" ? "Atlas" : "Blueprint"}
        </p>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-4 px-4 pb-[3px]" style={{ height: THEATER_BOTTOM }}>
        <div className="pointer-events-none min-w-0 flex-1">
          <Caption />
        </div>
        <div
          className={cn("mach-theater-bar flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-raised px-1.5 py-1 shadow-1", shown ? "opacity-100" : "pointer-events-none opacity-0")}
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
          <span className="mx-1">
            <FollowState compact />
          </span>
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
        <div className="pointer-events-none flex shrink-0 items-center gap-2" aria-hidden="true">
          {following ? <span className="text-caption font-semibold text-factory-live">Live</span> : <span className="text-caption text-ink-muted">Replay</span>}
          <TimeCode size="lg" />
        </div>
      </div>
      {/* The 3 px progress line along the bottom edge. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[3px] bg-line" aria-hidden="true">
        <div ref={liveRef} className="absolute inset-y-0 left-0 bg-factory-live-soft" />
        <div ref={fillRef} className="absolute inset-y-0 left-0 bg-ink" />
      </div>
    </>
  );
}

/**
 * Theater Mode's overlays (spec f.7): the source stamp (and, live, the connection) top left, the
 * drawing's name (the Atlas) top right, and below a caption naming the chapter (the simulation) or the latest
 * landmark (real history) and the latest significant moment, beside camera follow and the way out.
 * The way out shows for 2.5 s after the pointer moves; it stays while hovered or focused.
 */
import { Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@mach/ui";
import { useSceneStore, useStore } from "../scene";
import { indexFor, lastAtOrBefore, quotingKindOf } from "./history";
import { ConnectionBadge, SourceStamp } from "./SourceBadge";
import { FollowState } from "./FollowState";
import { IconButton } from "./IconButton";
import { KindWords } from "./inspector/FreeText";

/** Height of the strips Theater Mode keeps free of the views (the stage is inset by these). */
export const THEATER_TOP = 48;
export const THEATER_BOTTOM = 64;

function Caption() {
  const chapter = useSceneStore((s) => lastAtOrBefore(indexFor(s).landmarks, s.now));
  const moment = useSceneStore((s) => lastAtOrBefore(indexFor(s).moments, s.now));
  const log = useSceneStore((s) => s.log);
  if (!chapter && !moment) return null;
  const recent = moment && (!chapter || moment.t >= chapter.t) && moment.text !== chapter?.title ? moment : null;
  return (
    <div className="min-w-0" data-theater-caption="">
      {chapter ? (
        <p className="truncate font-sans text-body-lg font-semibold leading-snug text-ink">
          <KindWords kind={chapter.eventType} text={chapter.title} />
        </p>
      ) : null}
      {recent ? (
        <p className={chapter ? "truncate text-body-sm text-ink-muted" : "truncate font-sans text-body-lg font-semibold leading-snug text-ink"}>
          <KindWords kind={quotingKindOf(log, recent)} text={recent.text} />
        </p>
      ) : null}
    </div>
  );
}

export function TheaterOverlay() {
  const source = useSceneStore((s) => s.source);
  const store = useStore();
  const [awake, setAwake] = useState(true);
  const [held, setHeld] = useState(false);
  const timer = useRef<number | null>(null);

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

  const shown = awake || held;
  // Two strips the Atlas never draws into (the stage is inset by them), so nothing here can sit over
  // the Atlas's sheet furniture: the stamp and the drawing's name above, the caption and controls below.
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4" style={{ height: THEATER_TOP }}>
        <span className="pointer-events-auto flex items-center gap-2">
          <SourceStamp source={source} size="lg" />
          <ConnectionBadge />
        </span>
        <p className="text-body-sm text-ink-muted" aria-hidden="true">
          Atlas
        </p>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-4 px-4" style={{ height: THEATER_BOTTOM }}>
        <div className="pointer-events-none min-w-0 flex-1">
          <Caption />
        </div>
        <div
          className={cn("mach-theater-bar flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-raised px-1.5 py-1 shadow-1", shown ? "opacity-100" : "pointer-events-none opacity-0")}
          role="toolbar"
          aria-label="Theater Mode"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <span className="mx-1">
            <FollowState />
          </span>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          <IconButton label="Leave Theater Mode" shortcut="T" onClick={() => store.setTheater(false)}>
            <Minimize2 aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </>
  );
}

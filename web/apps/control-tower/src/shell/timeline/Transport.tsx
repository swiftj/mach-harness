/**
 * The transport: play and pause, stepping by event and by chapter (or, for real history, landmark),
 * speed, where the playhead is (the live edge, reviewing earlier history while live keeps arriving,
 * a replay), the time code, the current chapter or landmark, and the reduced-motion note. Re-renders
 * only when the transport's own state changes; the time code is written directly every frame.
 *
 * Live: the live edge is the right end of time; nothing here can move past it, and nothing here can
 * pause the Factory. Pausing at the live edge holds the view on that moment while events keep
 * arriving ("N new events"); "Return to live" re-attaches.
 */
import { ChevronsLeft, ChevronsRight, LocateFixed, PanelBottomClose, PanelBottomOpen, Pause, Play, StepBack, StepForward } from "lucide-react";
import { memo, useId, useRef, type ReactNode } from "react";
import { cn, Tooltip } from "@mach/ui";
import { cameraFollows, isStale, SPEEDS, useSceneStore, useStore, type PlaybackSpeed } from "../../scene";
import { indexFor, lastAtOrBefore } from "../history";
import { stepChapter, togglePlayback } from "../keyboard";
import { clockAt, duration as words, getTimeBase, timecode, utcClock, utcDate } from "../vocab";
import { usePlayheadEffect } from "./playhead";

export function IconButton({ label, shortcut, onClick, children, pressed, className, disabled }: { label: string; shortcut?: string; onClick: () => void; children: ReactNode; pressed?: boolean; className?: string; disabled?: boolean }) {
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        aria-pressed={pressed}
        disabled={disabled}
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors duration-[var(--mach-duration-fast)] hover:bg-surface-sunken hover:text-ink disabled:opacity-40 [&_svg]:size-4",
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The time code. Simulation: factory time from the start (mm:ss.s) and the simulated clock. Real
 * history: wall-clock UTC (HH:MM:SS.s) and the date. Written per frame, never rendered.
 */
export function TimeCode({ size = "md" }: { size?: "md" | "lg" }) {
  const codeRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  usePlayheadEffect((s) => {
    const wall = getTimeBase() === "wall";
    if (codeRef.current) codeRef.current.textContent = wall ? `${timecode(s.playhead)}${size === "lg" ? " UTC" : ""}` : timecode(s.playhead);
    if (clockRef.current) clockRef.current.textContent = wall ? `UTC, ${utcDate(s.playhead)}` : `${clockAt(s.playhead)} UTC`;
  }, []);
  return (
    <span className="flex items-baseline gap-2 tabular" aria-hidden="true">
      <span ref={codeRef} data-frame="" className={cn("font-mono text-ink tabular", size === "lg" ? "text-[13px]" : "text-[15px] font-semibold")}>
        00:00.0
      </span>
      {size === "md" ? <span ref={clockRef} data-frame="" className="font-mono text-[11px] text-ink-subtle tabular max-[1099px]:hidden" /> : null}
    </span>
  );
}

function SpeedControl() {
  const speed = useSceneStore((s) => s.speed);
  const { setSpeed } = useStore();
  const name = useId();
  return (
    <fieldset className="flex shrink-0 items-center rounded-sm border border-line p-0.5" aria-keyshortcuts="{ }">
      <legend className="sr-only">Playback speed</legend>
      {SPEEDS.map((s) => (
        <label
          key={s}
          className={cn(
            "flex h-6 min-w-[30px] cursor-pointer items-center justify-center rounded-xs px-1 font-mono text-[11px] tabular text-ink-muted",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
            speed === s ? "bg-surface-sunken font-semibold text-ink" : "hover:text-ink",
          )}
        >
          <input type="radio" name={name} value={s} checked={speed === s} onChange={() => setSpeed(s as PlaybackSpeed)} className="sr-only" />
          <span aria-hidden="true">{s === 0.5 ? "½" : s}×</span>
          <span className="sr-only">{s} times</span>
        </label>
      ))}
    </fieldset>
  );
}

/** "Return to live": re-attaches the playhead to the live edge. */
function ReturnToLive({ compact }: { compact?: boolean }) {
  const { followLive } = useStore();
  return (
    <Tooltip content="Return to live (L)">
      <button
        type="button"
        onClick={followLive}
        aria-keyshortcuts="L"
        data-return-live=""
        className={cn("inline-flex h-6 shrink-0 items-center rounded-sm px-2 text-caption font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2", compact && "h-7")}
      >
        Return to live
      </button>
    </Tooltip>
  );
}

function Pill({ kind, children }: { kind: "edge" | "review" | "stale"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-caption font-semibold",
        kind === "edge" ? "border-factory-live text-factory-live" : kind === "stale" ? "border-warning-line bg-warning-soft text-warning-ink" : "border-line-strong text-ink-muted",
      )}
    >
      <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
        {kind === "edge" ? <circle cx="4" cy="4" r="3.2" style={{ fill: "currentColor" }} /> : kind === "stale" ? <path d="M1 1H7V7H1Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4 }} /> : <circle cx="4" cy="4" r="3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4 }} />}
      </svg>
      {children}
    </span>
  );
}

/**
 * Where the playhead is, in words and shape:
 * - simulation: Live or Replay, and how far behind;
 * - live: at the live edge (or "as last seen" when the connection is stale), or reviewing an earlier
 *   moment with the count of events received since and a way back;
 * - replay: replaying, or at its last event.
 */
export function LiveState({ compact }: { compact?: boolean }) {
  const source = useSceneStore((s) => s.source);
  const following = useSceneStore((s) => s.following);
  const behind = useSceneStore((s) => (s.following ? 0 : Math.round((s.liveAt - s.playhead) / 10_000) * 10_000));
  const stale = useSceneStore((s) => isStale(s.connection));
  const staleSince = useSceneStore((s) => s.connection?.staleSince ?? null);
  const newer = useSceneStore((s) => (s.following ? 0 : Math.max(0, s.log.size() - s.cursor)));
  const atEnd = useSceneStore((s) => s.playhead >= s.liveAt);

  if (source === "replay") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5" data-live-state={atEnd ? "replay-end" : "replay"}>
        <Pill kind="review">{atEnd ? "At its last event" : "Replaying"}</Pill>
        {!atEnd && behind >= 10_000 && !compact ? <span className="text-caption text-ink-subtle max-[1099px]:hidden">{words(behind)} before its end</span> : null}
      </span>
    );
  }
  if (source === "live") {
    if (following) {
      return (
        <span className="inline-flex shrink-0 items-center" data-live-state={stale ? "stale" : "live"}>
          {stale ? <Pill kind="stale">As last seen{staleSince !== null ? ` ${utcClock(staleSince)}` : ""}</Pill> : <Pill kind="edge">At the live edge</Pill>}
        </span>
      );
    }
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5" data-live-state="reviewing">
        <Pill kind="review">
          Reviewing
          {behind >= 10_000 && !compact ? <span className="font-normal text-ink-subtle max-[1099px]:hidden">{words(behind)} back</span> : null}
        </Pill>
        {newer > 0 ? (
          <span className="text-caption font-semibold text-ink tabular" data-new-events={newer}>
            {newer.toLocaleString("en-GB")} new event{newer === 1 ? "" : "s"}
          </span>
        ) : null}
        <ReturnToLive compact={compact} />
      </span>
    );
  }
  if (following) {
    return (
      <span className="inline-flex shrink-0 items-center" data-live-state="live">
        <Pill kind="edge">Live</Pill>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-live-state="replay">
      <Pill kind="review">
        Replay
        {behind >= 10_000 && !compact ? <span className="font-normal text-ink-subtle max-[1099px]:hidden">{words(behind)} behind</span> : null}
      </Pill>
      <ReturnToLive compact={compact} />
    </span>
  );
}

/**
 * Camera follow, the store's one flag: "Following" while the views keep the live action in frame;
 * it goes off when the person pans, zooms or focuses something, and this turns it back on. In replay
 * the flag can be on but waits for the live edge, and says so.
 */
export function FollowState({ compact }: { compact?: boolean }) {
  const follow = useSceneStore((s) => s.follow);
  const active = useSceneStore((s) => cameraFollows(s));
  const { setFollow } = useStore();
  const label = active ? "Following" : follow ? "Follow at live" : "Follow off";
  return (
    <Tooltip content={follow ? "The camera keeps the live work in view. Panning or zooming stops it. (Shift+F turns it back on)" : "Turn camera follow back on (Shift+F)"}>
      <button
        type="button"
        onClick={() => setFollow(!follow)}
        aria-pressed={follow}
        aria-keyshortcuts="Shift+F"
        data-follow-state={active ? "following" : follow ? "armed" : "off"}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-caption font-semibold transition-colors duration-[var(--mach-duration-fast)] [&_svg]:size-3.5",
          active ? "border-factory-live text-factory-live" : follow ? "border-line-strong text-ink-muted" : "border-dashed border-line-strong text-ink-muted hover:text-ink",
        )}
      >
        <LocateFixed aria-hidden="true" className={active ? undefined : "opacity-70"} />
        {compact && !active ? (follow ? "Follow" : "Follow off") : label}
        <span className="sr-only">: camera follow {follow ? "on" : "off"}</span>
      </button>
    </Tooltip>
  );
}

/** The chapter (simulation) or the latest landmark (real history) at the playhead. */
function ChapterName() {
  const index = useSceneStore(indexFor);
  const chapter = useSceneStore((s) => lastAtOrBefore(indexFor(s).landmarks, s.playhead));
  if (!chapter) return null;
  const n = index.landmarks.indexOf(chapter) + 1;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-body-sm" title={chapter.title}>
      {index.storyboard ? (
        <span className="shrink-0 text-caption text-ink-subtle tabular">
          {n} of {index.landmarks.length}
        </span>
      ) : (
        <span className="min-w-0 shrink truncate text-caption text-ink-subtle">Last landmark, {timecode(chapter.t, false)}</span>
      )}
      <span className="truncate font-sans font-semibold text-ink">{chapter.title}</span>
    </span>
  );
}

export const Transport = memo(function Transport({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: () => void }) {
  const playing = useSceneStore((s) => s.playing);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const source = useSceneStore((s) => s.source);
  // Live at the edge, the button holds the view on this moment; the Factory goes on regardless.
  const atEdge = useSceneStore((s) => s.source === "live" && s.following);
  const store = useStore();
  const chapterWord = source === "simulation" ? "chapter" : "landmark";
  const playLabel = atEdge ? "Hold this moment (events keep arriving)" : playing ? "Pause" : "Play";
  return (
    // The bar lies over the timeline's 24 px resize handle: only its controls take the pointer, so the
    // bar's empty space is the handle.
    <div
      className="pointer-events-none relative z-[1] flex h-10 shrink-0 items-center gap-1 border-b border-line px-2 [&_button]:pointer-events-auto [&_fieldset]:pointer-events-auto [&_[title]]:pointer-events-auto"
      role="toolbar"
      aria-label="Transport"
    >
      {/* On a very narrow window the chapter buttons give way; [ and ] still step by chapter. */}
      <IconButton label={`Previous ${chapterWord}`} shortcut="[" onClick={() => stepChapter(store, -1)} className="max-[759px]:hidden">
        <ChevronsLeft aria-hidden="true" />
      </IconButton>
      <IconButton label="Previous event" shortcut="," onClick={store.stepPrevious}>
        <StepBack aria-hidden="true" />
      </IconButton>
      <Tooltip content={`${playLabel} (Space)`}>
        <button
          type="button"
          onClick={() => togglePlayback(store)}
          aria-label={playLabel}
          aria-keyshortcuts="Space"
          data-transport="play"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-inverse transition-colors hover:bg-ink-muted [&_svg]:size-4"
        >
          {playing || atEdge ? <Pause aria-hidden="true" fill="currentColor" /> : <Play aria-hidden="true" fill="currentColor" className="translate-x-px" />}
        </button>
      </Tooltip>
      <IconButton label="Next event" shortcut="." onClick={store.stepNext}>
        <StepForward aria-hidden="true" />
      </IconButton>
      <IconButton label={`Next ${chapterWord}`} shortcut="]" onClick={() => stepChapter(store, 1)} className="max-[759px]:hidden">
        <ChevronsRight aria-hidden="true" />
      </IconButton>

      <div className="ml-2 flex shrink-0 flex-col justify-center leading-none">
        <TimeCode />
        <span className="sr-only">{source === "simulation" ? "Simulated factory time" : "Time, UTC"}</span>
      </div>
      <div className="mx-2 h-5 w-px shrink-0 bg-line min-[1100px]:mx-3" aria-hidden="true" />
      <LiveState />
      <span className="ml-2">
        <FollowState />
      </span>
      <div className="mx-3 hidden h-5 w-px shrink-0 bg-line min-[1280px]:block" aria-hidden="true" />
      <div className={cn("hidden min-w-0 flex-1 overflow-hidden", source === "simulation" ? "min-[1280px]:flex" : "min-[1600px]:flex")}>
        <ChapterName />
      </div>
      <div className={cn("flex-1", source === "simulation" ? "min-[1280px]:hidden" : "min-[1600px]:hidden")} />
      {reduced ? (
        <span className="mr-2 inline-flex h-6 shrink-0 items-center rounded-sm border border-dashed border-line-strong px-2 text-caption text-ink-muted" title="Your system asks for reduced motion: changes appear without travel; stepping by event still works.">
          Motion reduced
        </span>
      ) : null}
      <SpeedControl />
      <IconButton label={collapsed ? "Expand the timeline" : "Collapse the timeline"} shortcut="Shift+T" onClick={onCollapse} className="ml-1">
        {collapsed ? <PanelBottomOpen aria-hidden="true" /> : <PanelBottomClose aria-hidden="true" />}
      </IconButton>
    </div>
  );
});

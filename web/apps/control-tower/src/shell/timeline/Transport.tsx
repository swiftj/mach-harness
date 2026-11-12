/**
 * The transport: play and pause, stepping by event and by chapter, speed, live versus replay, the
 * factory time code, the current chapter, and the reduced-motion note. Re-renders only when the
 * transport's own state changes; the time code is written directly every frame.
 */
import { ChevronsLeft, ChevronsRight, LocateFixed, PanelBottomClose, PanelBottomOpen, Pause, Play, StepBack, StepForward } from "lucide-react";
import { memo, useId, useRef, type ReactNode } from "react";
import { cn, Tooltip } from "@mach/ui";
import { chapterAt, SCENARIO } from "../../sim";
import { cameraFollows, SPEEDS, useSceneStore, useStore, type PlaybackSpeed } from "../../scene";
import { stepChapter } from "../keyboard";
import { clockAt, duration as words, timecode } from "../vocab";
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

/** The time code: factory time from the start (mm:ss.s), and the simulated clock. Written per frame, never rendered. */
export function TimeCode({ size = "md" }: { size?: "md" | "lg" }) {
  const codeRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  usePlayheadEffect((s) => {
    if (codeRef.current) codeRef.current.textContent = timecode(s.playhead);
    if (clockRef.current) clockRef.current.textContent = `${clockAt(s.playhead)} UTC`;
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

/** Live or replay, said in words and shape; in replay, how far behind live and a way back. */
function LiveState() {
  const following = useSceneStore((s) => s.following);
  const behind = useSceneStore((s) => (s.following ? 0 : Math.round((s.liveAt - s.playhead) / 10_000) * 10_000));
  const { followLive } = useStore();
  if (following) {
    return (
      <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-factory-live px-2 text-caption font-semibold text-factory-live" data-live-state="live">
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3.2" style={{ fill: "currentColor" }} />
        </svg>
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-live-state="replay">
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-strong px-2 text-caption font-semibold text-ink-muted">
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4 }} />
        </svg>
        Replay
        {behind >= 10_000 ? <span className="font-normal text-ink-subtle max-[1099px]:hidden">{words(behind)} behind</span> : null}
      </span>
      <Tooltip content="Return to live (L)">
        <button
          type="button"
          onClick={followLive}
          aria-keyshortcuts="L"
          className="inline-flex h-6 items-center rounded-sm px-2 text-caption font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2"
        >
          Return to live
        </button>
      </Tooltip>
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
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-caption font-semibold transition-colors duration-[var(--mach-duration-fast)] [&_svg]:size-3.5",
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

function ChapterName() {
  const chapter = useSceneStore((s) => chapterAt(s.fixture, s.playhead));
  if (!chapter) return null;
  const n = SCENARIO.chapters.indexOf(chapter) + 1;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-body-sm">
      <span className="shrink-0 text-caption text-ink-subtle tabular">
        {n} of {SCENARIO.chapters.length}
      </span>
      <span className="truncate font-sans font-semibold text-ink">{chapter.title}</span>
    </span>
  );
}

export const Transport = memo(function Transport({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: () => void }) {
  const playing = useSceneStore((s) => s.playing);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const store = useStore();
  return (
    // The bar lies over the timeline's 24 px resize handle: only its controls take the pointer, so the
    // bar's empty space is the handle.
    <div
      className="pointer-events-none relative z-[1] flex h-10 shrink-0 items-center gap-1 border-b border-line px-2 [&_button]:pointer-events-auto [&_fieldset]:pointer-events-auto [&_[title]]:pointer-events-auto"
      role="toolbar"
      aria-label="Transport"
    >
      {/* On a very narrow window the chapter buttons give way; [ and ] still step by chapter. */}
      <IconButton label="Previous chapter" shortcut="[" onClick={() => stepChapter(store, -1)} className="max-[759px]:hidden">
        <ChevronsLeft aria-hidden="true" />
      </IconButton>
      <IconButton label="Previous event" shortcut="," onClick={store.stepPrevious}>
        <StepBack aria-hidden="true" />
      </IconButton>
      <Tooltip content={`${playing ? "Pause" : "Play"} (Space)`}>
        <button
          type="button"
          onClick={store.toggle}
          aria-label={playing ? "Pause" : "Play"}
          aria-keyshortcuts="Space"
          data-transport="play"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-inverse transition-colors hover:bg-ink-muted [&_svg]:size-4"
        >
          {playing ? <Pause aria-hidden="true" fill="currentColor" /> : <Play aria-hidden="true" fill="currentColor" className="translate-x-px" />}
        </button>
      </Tooltip>
      <IconButton label="Next event" shortcut="." onClick={store.stepNext}>
        <StepForward aria-hidden="true" />
      </IconButton>
      <IconButton label="Next chapter" shortcut="]" onClick={() => stepChapter(store, 1)} className="max-[759px]:hidden">
        <ChevronsRight aria-hidden="true" />
      </IconButton>

      <div className="ml-2 flex shrink-0 flex-col justify-center leading-none">
        <TimeCode />
        <span className="sr-only">Simulated factory time</span>
      </div>
      <div className="mx-2 h-5 w-px shrink-0 bg-line min-[1100px]:mx-3" aria-hidden="true" />
      <LiveState />
      <span className="ml-2">
        <FollowState />
      </span>
      <div className="mx-3 hidden h-5 w-px shrink-0 bg-line min-[1280px]:block" aria-hidden="true" />
      <div className="hidden min-w-0 flex-1 min-[1280px]:flex">
        <ChapterName />
      </div>
      <div className="flex-1 min-[1280px]:hidden" />
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

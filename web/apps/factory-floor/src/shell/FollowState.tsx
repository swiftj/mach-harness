/**
 * Camera follow, the store's one flag, for the Floor's drawings: "Following" while the camera keeps
 * the live work in frame; it goes off when the person pans, zooms or frames something, and this
 * turns it back on (Shift+F does the same).
 */
import { LocateFixed } from "lucide-react";
import { cn, Tooltip } from "@mach/ui";
import { useSceneStore, useStore } from "../scene";

export function FollowState() {
  const follow = useSceneStore((s) => s.follow);
  const { setFollow } = useStore();
  return (
    <Tooltip content={follow ? "The camera keeps the live work in view. Panning or zooming stops it. (Shift+F turns it back on)" : "Turn camera follow back on (Shift+F)"}>
      <button
        type="button"
        onClick={() => setFollow(!follow)}
        aria-pressed={follow}
        aria-keyshortcuts="Shift+F"
        data-follow-state={follow ? "following" : "off"}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-caption font-semibold transition-colors duration-[var(--mach-duration-fast)] [&_svg]:size-3.5",
          follow ? "border-factory-live text-factory-live" : "border-dashed border-line-strong text-ink-muted hover:text-ink",
        )}
      >
        <LocateFixed aria-hidden="true" className={follow ? undefined : "opacity-70"} />
        {follow ? "Following" : "Follow off"}
        <span className="sr-only">: camera follow {follow ? "on" : "off"}</span>
      </button>
    </Tooltip>
  );
}

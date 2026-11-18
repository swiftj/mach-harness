import { Fragment } from "react";
import { RelativeTime, type SliceGithub } from "@mach/ui";

type TimeKey = keyof SliceGithub["times"];

const words: Record<TimeKey, string> = {
  marked_ready: "Marked ready",
  building: "Taken by the builders",
  question: "Question asked",
  shipped: "Shipped",
};

/** The moment that goes with where the slice is now: when it shipped, was taken, was asked about, or was marked ready. */
const forProgress: Partial<Record<NonNullable<SliceGithub["progress"]>, TimeKey>> = {
  shipped: "shipped",
  being_built: "building",
  question: "question",
  ready_to_build: "marked_ready",
};

/**
 * When things happened to a slice, as the engine read them from its issue. `latest` shows the one
 * moment that goes with where it is now; `all` shows each moment the engine knows. A moment the
 * engine does not know is not shown.
 */
export function SliceTimes({ github, mode }: { github: SliceGithub; mode: "latest" | "all" }) {
  const keys: TimeKey[] =
    mode === "all" ? (["marked_ready", "building", "question", "shipped"] as TimeKey[]) : github.progress && forProgress[github.progress] ? [forProgress[github.progress]!] : [];
  const known = keys.filter((key) => github.times[key]);
  if (!known.length) return null;
  return (
    <span className="text-caption text-ink-muted">
      {known.map((key, index) => (
        <Fragment key={key}>
          {index ? " · " : ""}
          {words[key]} <RelativeTime iso={github.times[key]!} />
        </Fragment>
      ))}
    </span>
  );
}

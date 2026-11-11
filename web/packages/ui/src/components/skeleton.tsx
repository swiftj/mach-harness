import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * A placeholder in the shape of the content that is loading. Shimmers gently; under reduced
 * motion it is a still block. Mark the loading region with aria-busy, not each skeleton.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-sm bg-surface-sunken bg-[linear-gradient(90deg,transparent_0%,var(--mach-line)_50%,transparent_100%)] bg-[length:200%_100%]",
        "animate-[mach-shimmer_1.6s_linear_infinite] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/** Lines of text, the last one shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}

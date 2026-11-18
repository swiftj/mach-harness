import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

export interface CommandLineProps {
  /** The command, shown in mono and copied as it is. */
  command: string;
  /** What the command does, for the copy button's accessible name ("Copy the command to approve LOCAL-014"). */
  purpose?: string;
  className?: string;
}

/**
 * One command for a person to copy and run themselves (a `/mach` command in Claude Code). The page
 * never runs it. The button says "Copied" for a moment, in words, so the result is never colour alone;
 * when the browser refuses the clipboard it says so and the command stays selectable.
 */
export function CommandLine({ command, purpose, className }: CommandLineProps) {
  const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = () => {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip) {
      setState("refused");
      return;
    }
    clip.writeText(command).then(
      () => setState("copied"),
      () => setState("refused"),
    );
  };
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-sm border border-line bg-surface-sunken py-1 pl-2.5 pr-1", className)} data-command-line="">
      <code className="min-w-0 flex-1 select-all truncate font-mono text-[13px] text-ink" translate="no">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={purpose ? `Copy the command ${purpose}` : "Copy the command"}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-xs border border-line-control bg-surface px-2.5 text-caption font-semibold text-ink hover:bg-surface-raised [&_svg]:size-3.5"
      >
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span aria-live="polite">{state === "copied" ? "Copied" : state === "refused" ? "Select it to copy" : "Copy"}</span>
      </button>
    </div>
  );
}

/** A square icon button with its name in a tooltip and its key, if it has one, said with it. */
import type { ReactNode } from "react";
import { cn, Tooltip } from "@mach/ui";

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

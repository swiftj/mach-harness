import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@mach/ui";

/**
 * Reference detail behind a closed summary that says what and how much is inside ("2 lines from the brief", "What
 * each count is made of"). A real button with `aria-expanded`; the detail follows it in reading order and stays in
 * the page while closed (`hidden`), so nothing it holds is lost. Use it for what a person may want to check, never for
 * what they need in order to decide or act.
 *
 *   <Fold label="2 lines from the brief">…the quotation…</Fold>                 quiet: a line of text with a chevron
 *   <Fold boxed label="What each count is made of">…</Fold>                     boxed: the guide's disclosure (7.10)
 */
export function Fold({
  label,
  boxed = false,
  defaultOpen = false,
  className,
  children,
}: {
  label: ReactNode;
  boxed?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn(boxed && "rounded-md border border-line bg-surface", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          "flex min-h-6 items-center gap-2 text-left text-body-sm font-semibold text-ink-muted hover:text-ink",
          boxed ? "w-full rounded-md px-4 py-2.5" : "rounded-xs",
        )}
      >
        <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 transition-transform duration-[var(--mach-duration-fast)]", open && "rotate-90")} />
        {label}
      </button>
      <div id={id} hidden={!open} className={cn(boxed ? "border-t border-line px-4 py-3 text-body-sm text-ink" : "pt-2")}>
        {children}
      </div>
    </div>
  );
}

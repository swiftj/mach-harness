import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@mach/ui";

/**
 * Reference detail behind a closed summary that says what and how much is inside ("Rests on 2 lines of the brief",
 * "What MACH found: 3"). A real button with `aria-expanded`; the detail follows it in reading order and stays in
 * the page while closed (`hidden`), so nothing it holds is lost. Use it for what a person may want to check, never for
 * what they need in order to decide or act.
 *
 *   <Fold label="Rests on 2 lines of the brief">…the quotation…</Fold>       quiet: a line of text with a chevron
 *   <Fold small label="Connections: 1 earlier rule">…</Fold>                  quiet, caption-sized, for dense lists
 *   <Fold boxed label="What each count is made of">…</Fold>                    boxed: the guide's disclosure (7.10)
 *   <Fold heading={3} label="Shipped rules: 4">…</Fold>                        the label is a heading of that level
 *
 * A label that folds a group says how many it holds: "<What>: <count>" ("Done when: 3 criteria", "Files that could not
 * be read: 2") or a sentence with the count in it ("Rests on 5 lines of the PRD").
 */
export function Fold({
  label,
  boxed = false,
  small = false,
  heading,
  defaultOpen = false,
  className,
  children,
}: {
  label: ReactNode;
  boxed?: boolean;
  small?: boolean;
  /** Put the label in a heading of this level, so a folded group keeps its place in the page's outline. */
  heading?: 2 | 3 | 4;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const button = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={id}
      onClick={() => setOpen((was) => !was)}
      className={cn(
        "flex min-h-6 items-center gap-2 text-left font-semibold text-ink-muted hover:text-ink",
        small ? "gap-1.5 text-caption" : "text-body-sm",
        boxed ? "w-full rounded-md px-4 py-2.5" : "rounded-xs",
      )}
    >
      <ChevronRight aria-hidden="true" className={cn("shrink-0 transition-transform duration-[var(--mach-duration-fast)]", small ? "size-3.5" : "size-4", open && "rotate-90")} />
      {label}
    </button>
  );
  const Head = heading ? (`h${heading}` as "h2" | "h3" | "h4") : null;
  return (
    <div className={cn(boxed && "rounded-md border border-line bg-surface", className)}>
      {Head ? <Head className="m-0 text-body-sm">{button}</Head> : button}
      <div id={id} hidden={!open} className={cn(boxed ? "border-t border-line px-4 py-3 text-body-sm text-ink" : small ? "pt-1.5" : "pt-2")}>
        {children}
      </div>
    </div>
  );
}

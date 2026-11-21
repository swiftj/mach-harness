import { Children, isValidElement, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { Heading, cn } from "@mach/ui";

/**
 * The window is the desk (M16 layout, docs/mach-next/M16_LAYOUT.md). A work screen fills the window's height under the
 * top bar and does not scroll as a page: one slim context row, then a work area whose panes scroll on their own. In a
 * window narrower than 1,024 pixels or shorter than 620, it falls back to ordinary page scroll in one column.
 *
 *   <WorkScreen header={<ContextRow identity=… title=… trail=… about=… />}>
 *     <WorkPanes>
 *       <WorkPane label="The brief">…the one thing the person is doing…</WorkPane>
 *       <WorkPane label="Check" side>…what they refer to while doing it…</WorkPane>
 *     </WorkPanes>
 *   </WorkScreen>
 *
 * The fallback widths and heights are written out in each class (Tailwind reads class names as written):
 * `max-[1023px]:` and `[@media(max-height:619px)]:`.
 */
export function WorkScreen({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div data-work-screen="" className="flex h-full min-h-0 flex-col max-[1023px]:h-auto [@media(max-height:619px)]:h-auto">
      {header}
      {children}
    </div>
  );
}

/**
 * The slim context row, two short lines and an optional third:
 *
 *   IDEA-006 Members pay fines online                                   [the page's acts]
 *   Size and route  > About this step              ✓ Ideas — ✓ Explore — … — 6 Look back
 *   [below: a row of page tabs, as on a slice]
 *
 * `identity` is what the item is (its ID and name), `title` the page's one h1 (title-2), `trail` where it is on its path
 * (a one-line stepper or the lifecycle path), `actions` the page's acts (at most one primary). The page's lead paragraph
 * is not shown open: it sits behind "About this step" (`about`), closed by default. Each line wraps when the window is
 * too narrow for it, so nothing is cut off.
 */
export function ContextRow({
  identity,
  title,
  trail,
  actions,
  about,
  aboutLabel = "About this step",
  below,
}: {
  identity?: ReactNode;
  title: ReactNode;
  trail?: ReactNode;
  actions?: ReactNode;
  about?: ReactNode;
  aboutLabel?: string;
  below?: ReactNode;
}) {
  const aboutId = useId();
  const [open, setOpen] = useState(false);
  return (
    <header className={cn("flex shrink-0 flex-col border-b border-line px-10 pt-3", below ? "gap-2 pb-0" : "gap-1 pb-3")}>
      {identity || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2">
          {identity ? <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">{identity}</div> : <span />}
          {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
          <Heading level={1} size="title-2" className="min-w-0 break-words">
            {title}
          </Heading>
          {about ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={aboutId}
              onClick={() => setOpen((was) => !was)}
              className="inline-flex min-h-6 items-center gap-1 rounded-xs text-body-sm font-semibold text-ink-muted hover:text-ink"
            >
              <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform duration-[var(--mach-duration-fast)]", open && "rotate-90")} />
              {aboutLabel}
            </button>
          ) : null}
        </div>
        {trail ? <div className="flex min-w-0 justify-end">{trail}</div> : null}
      </div>
      {about ? (
        <div id={aboutId} hidden={!open} className="max-w-reading pb-1 text-body text-ink-muted">
          {about}
        </div>
      ) : null}
      {below}
    </header>
  );
}

/**
 * The work area: a wide pane for the one thing the person is doing, and, when there is something to refer to while
 * doing it, a narrow pane beside it. Never a second pane just to fill space: with one child, one pane.
 */
export function WorkPanes({ children }: { children: ReactNode }) {
  const twoPanes = Children.toArray(children).some((child) => isValidElement<{ side?: boolean }>(child) && child.props.side);
  return (
    <div
      data-work-area=""
      className={cn(
        "grid min-h-0 flex-1",
        twoPanes ? "grid-cols-[minmax(0,1fr)_22rem] max-[1279px]:grid-cols-[minmax(0,1fr)_19rem]" : "grid-cols-[minmax(0,1fr)]",
        "max-[1023px]:block [@media(max-height:619px)]:block",
      )}
    >
      {children}
    </div>
  );
}

/**
 * One pane: a labelled region that scrolls on its own. While it has more than fits, a keyboard can reach it (it joins
 * the tab order) and scroll it with the arrow and page keys; focus is never held in it. `side` is the narrow pane
 * (surface, a rule at its left). `width` caps the wide pane's content: "wide" (60rem, for a work
 * screen with a narrow pane beside it), "content" (the page content maximum, for a body moved in whole) or "reading".
 */
export function WorkPane({
  label,
  side = false,
  width = "wide",
  children,
}: {
  label: string;
  side?: boolean;
  width?: "wide" | "reading" | "content";
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const scrolls = useScrolls(ref);
  return (
    <section
      ref={ref}
      data-pane={side ? "side" : "main"}
      aria-label={label}
      // Reachable by keyboard only while it scrolls; otherwise its links and buttons are the stops.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={scrolls ? 0 : undefined}
      className={cn(
        "relative min-h-0 overflow-y-auto overscroll-contain",
        "max-[1023px]:overflow-visible [@media(max-height:619px)]:overflow-visible",
        side ? "border-l border-line bg-surface px-6 py-6 max-[1023px]:border-l-0 max-[1023px]:border-t" : "px-10 py-6",
      )}
    >
      <div className={cn(!side && width === "wide" && "max-w-[60rem]", !side && width === "content" && "max-w-content", !side && width === "reading" && "max-w-[calc(var(--mach-reading-measure)+5rem)]")}>{children}</div>
    </section>
  );
}

/** Whether a pane has more than fits, kept up to date as its content and the window change. */
function useScrolls(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setScrolls(node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== "visible");
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
}

/** A page that keeps its own single-column body inside a work screen: the body in one scrolling pane. */
export function OnePane({ label, width = "wide", children }: { label: string; width?: "wide" | "reading" | "content"; children: ReactNode }) {
  return (
    <WorkPanes>
      <WorkPane label={label} width={width}>
        {children}
      </WorkPane>
    </WorkPanes>
  );
}

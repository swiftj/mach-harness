import { Children, createContext, isValidElement, useContext, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Heading, cn, scrollEdgeClasses, useScrollEdges } from "@mach/ui";

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
 * Every box that scrolls on its own (a pane, a board, a wide table) follows one rule, "more below": while it has more
 * than it shows it is a named region in the tab order, and a hairline at each edge where more is hidden says so.
 *
 * The fallback widths and heights are written out in each class (Tailwind reads class names as written):
 * `max-[1023px]:` and `[@media(max-height:619px)]:`.
 */
const Split = createContext<"side" | "conversation">("side");
const ActsSlot = createContext<{ slot: HTMLElement | null; setSlot: (node: HTMLElement | null) => void } | null>(null);

export function WorkScreen({ header, children }: { header: ReactNode; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <ActsSlot.Provider value={{ slot, setSlot }}>
      <div data-work-screen="" className="flex h-full min-h-0 flex-col max-[1023px]:h-auto [@media(max-height:619px)]:h-auto">
        {header}
        {children}
      </div>
    </ActsSlot.Provider>
  );
}

/**
 * The page's acts, written where the screen knows them (inside a step frame, a pane or a part) and shown in the
 * context row at the right, with any acts the row was given. At most one primary among them.
 */
export function ContextActs({ children }: { children: ReactNode }) {
  const ctx = useContext(ActsSlot);
  if (!ctx?.slot) return null;
  return createPortal(children, ctx.slot);
}

/**
 * The slim context row, two short lines and an optional third:
 *
 *   IDEA-006 Members pay fines online                                   [the page's acts]
 *   Size and route  > About this step              ✓ Ideas — ✓ Explore — … — 6 Look back
 *   [below: a row of page tabs, as on a slice]
 *
 * `identity` is what the item is (its ID and name), `title` the page's one h1 (title-2), `trail` where it is on its path
 * (a one-line stepper or the lifecycle path), `actions` the page's acts (at most one primary; `ContextActs` adds more
 * from inside the screen). With no identity, the acts sit at the right of the title line, so a page with nothing to
 * name above its title spends one line, not two. The page's lead paragraph is not shown open: it sits behind "About
 * this page" (`about`; a Shape step says "About this step"), closed by default. Each line wraps when the window is
 * too narrow for it, so nothing is cut off.
 */
export function ContextRow({
  identity,
  title,
  trail,
  actions,
  about,
  aboutLabel = "About this page",
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
  const ctx = useContext(ActsSlot);
  const acts = (
    <div ref={ctx?.setSlot} className="flex flex-wrap items-center justify-end gap-2 empty:hidden">
      {actions}
    </div>
  );
  return (
    <header className={cn("flex shrink-0 flex-col border-b border-line px-10 pt-3", below ? "gap-2 pb-0" : "gap-1 pb-3")}>
      {identity ? (
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">{identity}</div>
          {acts}
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
        {trail || !identity ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-6 gap-y-2">
            {trail}
            {identity ? null : acts}
          </div>
        ) : null}
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
 *
 * `split`: "side" (the default, a 22rem narrow pane; 19rem below 1,280) or "conversation" (the guide's guided question
 * screen, 8.10: the question `1.15fr` and the document beside it `minmax(22rem, 1fr)`).
 */
export function WorkPanes({ split = "side", children }: { split?: "side" | "conversation"; children: ReactNode }) {
  // Two panes when two are given (a screen leaves the narrow one out, as null, when it has nothing to refer to).
  const twoPanes = Children.toArray(children).filter((child) => isValidElement(child)).length > 1;
  return (
    <Split.Provider value={split}>
    <div
      data-work-area=""
      className={cn(
        "grid min-h-0 flex-1",
        !twoPanes && "grid-cols-[minmax(0,1fr)]",
        twoPanes && split === "side" && "grid-cols-[minmax(0,1fr)_22rem] max-[1279px]:grid-cols-[minmax(0,1fr)_19rem]",
        twoPanes && split === "conversation" && "grid-cols-[minmax(0,1.15fr)_minmax(22rem,1fr)]",
        "max-[1023px]:block [@media(max-height:619px)]:block",
      )}
    >
      {children}
    </div>
    </Split.Provider>
  );
}

const widths = {
  wide: "max-w-[60rem]",
  content: "max-w-content",
  reading: "max-w-[calc(var(--mach-reading-measure)+5rem)]",
  column: "mx-auto max-w-[44rem]",
  full: "",
} as const;

/**
 * One pane: a labelled region that scrolls on its own. While it has more than fits, a keyboard can reach it (it joins
 * the tab order) and scroll it with the arrow and page keys, and a hairline at its bottom edge says more is below;
 * focus is never held in it. `side` is the narrow pane (surface, a rule at its left). `width` caps the wide pane's
 * content: "wide" (60rem, beside a narrow pane), "content" (the page content maximum, for a body moved in whole),
 * "reading", "column" (a centred 44rem column, the guided question screen's) or "full".
 *
 * `header` stays at the top of the pane while the rest scrolls under it (a conversation's heading and its acts), with
 * a rule under it; in the page-scroll fallback it is an ordinary first block.
 */
export function WorkPane({
  label,
  side = false,
  width = "wide",
  header,
  surface,
  as: Tag = "section",
  children,
}: {
  label: string;
  /** "aside" when the narrow pane is complementary to the page (the slice so far beside an interview). */
  as?: "section" | "aside";
  side?: boolean;
  width?: keyof typeof widths;
  header?: ReactNode;
  /** The pane's own ground: "canvas" for a wide pane and "surface" for the narrow one unless set. */
  surface?: "canvas" | "surface";
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const edges = useScrollEdges(ref);
  // The guided question screen's document column keeps the page's 40px padding (8.10); a narrow pane has 24px.
  const split = useContext(Split);
  const pad = side && split === "side" ? "6" : "10";
  const ground = surface ?? (side ? "surface" : "canvas");
  const cap = side ? "" : widths[width];
  // The "more below" mark takes its own line under the scrolling box while the pane scrolls, so it never covers the
  // pane's last line; a pane that fits has no such line.
  const scrolls = edges.above || edges.below;
  return (
    <div
      data-pane-frame=""
      className={cn(
        "flex min-h-0 flex-col max-[1023px]:block [@media(max-height:619px)]:block",
        ground === "surface" ? "bg-surface" : "bg-canvas",
        side && "border-l border-l-line max-[1023px]:border-l-0 max-[1023px]:border-t max-[1023px]:border-t-line",
      )}
    >
      <Tag
        ref={ref}
        data-pane={side ? "side" : "main"}
        data-more={edges.more ? [edges.above && "above", edges.below && "below"].filter(Boolean).join(" ") || "end" : undefined}
        aria-label={label}
        // Reachable by keyboard only while it scrolls; otherwise its links and buttons are the stops.
        tabIndex={edges.more ? 0 : undefined}
        className={cn(
          "relative min-h-0 flex-1 overflow-y-auto overscroll-contain",
          "max-[1023px]:overflow-visible [@media(max-height:619px)]:overflow-visible",
          pad === "6" ? "px-6" : "px-10",
          header ? "pb-6" : "py-6",
        )}
      >
        {header ? (
          <div
            className={cn(
              "sticky top-0 z-10 mb-6 border-b border-line pb-3 pt-5 max-[1023px]:static [@media(max-height:619px)]:static",
              pad === "6" ? "-mx-6 px-6" : "-mx-10 px-10",
              ground === "surface" ? "bg-surface" : "bg-canvas",
            )}
          >
            <div className={cap}>{header}</div>
          </div>
        ) : null}
        <div className={cap}>{children}</div>
      </Tag>
      {scrolls ? <MoreBelow wide={pad === "10"} shown={edges.below} /> : null}
    </div>
  );
}

/**
 * The "more below" mark of a pane. A pane's bottom edge is the window's, where a hairline alone is easy to miss, so
 * the hairline carries two quiet words at its right: a line across the pane's foot, "More below" and a down chevron
 * in `caption` `ink-subtle`. It sits on its own line under the pane's scrolling box, kept there for as long as the
 * pane scrolls, so it never covers a line of the pane and nothing moves when it comes and goes: at the pane's end the
 * line stays, empty and without its rule. It is hidden from assistive technology, which reads the whole pane.
 */
function MoreBelow({ wide, shown }: { wide: boolean; shown: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-more-below={shown ? "" : undefined}
      className={cn(
        "flex shrink-0 justify-end border-t py-0.5 text-caption text-ink-subtle max-[1023px]:hidden [@media(max-height:619px)]:hidden",
        wide ? "px-10" : "px-6",
        shown ? "border-line" : "border-transparent",
      )}
    >
      <span className={cn("inline-flex items-center gap-1", !shown && "invisible")}>
        More below
        <ChevronDown className="size-3.5" />
      </span>
    </div>
  );
}

/** A page that keeps its own single-column body inside a work screen: the body in one scrolling pane. */
export function OnePane({ label, width = "wide", children }: { label: string; width?: keyof typeof widths; children: ReactNode }) {
  return (
    <WorkPanes>
      <WorkPane label={label} width={width}>
        {children}
      </WorkPane>
    </WorkPanes>
  );
}

/**
 * A box that scrolls on its own inside a pane, down or sideways (a board, a wide table, a long quotation). It follows
 * the "more below" rule: while it has more than it shows it is a named region in the tab order, and a hairline at each
 * edge where more is hidden says which way. When everything fits it is a plain box and adds no tab stop.
 * `framed` keeps a visible border on every side (a table's frame); otherwise the edges are drawn only where more is.
 */
export function ScrollRegion({
  label,
  as: Tag = "div",
  framed = false,
  className,
  children,
}: {
  label: string;
  as?: "div" | "section";
  framed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const edges = useScrollEdges(ref);
  const sides = { top: true, bottom: true, left: true, right: true };
  return (
    <Tag
      ref={ref as never}
      role={Tag === "div" && edges.more ? "region" : undefined}
      aria-label={Tag === "section" || edges.more ? label : undefined}
      data-more={edges.more ? [edges.above && "above", edges.below && "below", edges.before && "before", edges.after && "after"].filter(Boolean).join(" ") : undefined}
      tabIndex={edges.more ? 0 : undefined}
      className={cn(
        // Positioned, so visually hidden text inside it is placed inside it and never stretches the page.
        "relative min-h-0 overflow-auto overscroll-contain border",
        framed ? cn("border-line", framedEdges(edges)) : cn("border-transparent", scrollEdgeClasses(edges, sides)),
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** A framed box already has a rule on every side: the side where more is hidden takes the stronger rule. */
function framedEdges(edges: ReturnType<typeof useScrollEdges>): string {
  return cn(edges.above && "border-t-line-strong", edges.below && "border-b-line-strong", edges.before && "border-l-line-strong", edges.after && "border-r-line-strong");
}

/**
 * A board's area under the context row (style guide 8.9): columns side by side in one region that fills the rest of
 * the window and scrolls on its own, sideways when the window is narrower than the columns and down when a column holds
 * more than fits, under the "more below" rule. `above` holds what must be read before the board (a banner). In a
 * window narrower than 1,024 or shorter than 620 the region grows with its content and the page scrolls.
 */
export function WorkBoard({ label, above, children }: { label: string; above?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-10 pb-4 pt-5 max-[1023px]:flex-none [@media(max-height:619px)]:flex-none">
      {above}
      <ScrollRegion as="section" label={label} className="flex flex-1 flex-col gap-6 rounded-md pb-2 max-[1023px]:flex-none [@media(max-height:619px)]:flex-none">
        {children}
      </ScrollRegion>
    </div>
  );
}

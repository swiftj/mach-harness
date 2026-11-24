import { createContext, useContext, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@mach/ui";

/**
 * A screen of several parts, one open at a time (M16 layout). Each part is a row: its name and a one-line summary of
 * its state in plain words ("Route: several epics", "1 outcome still to settle"); the part that needs the person is
 * open and the others are closed, and any can be opened (opening one closes the one that was open). A closed part
 * stays in the page (`hidden`), so what it holds keeps its state.
 *
 * When the parts are the steps of a path, each carries its place: `done`, `current` (the accent, the current place) or
 * `later`, as a number or a tick and in words for assistive technology, so the parts are the stepper too.
 *
 * Each summary says the part's state in one line, in the same pattern everywhere: what is there and how many, then
 * what is still to do ("2 in force, 1 retired", "1 outcome still to settle: O-2", "Nothing to record yet").
 *
 *   const [open, setOpen] = useState("coverage");
 *   <Parts label="Sizing and the map" open={open} onOpenChange={setOpen}>
 *     <Part id="route" number={1} place="done" name="Size it" summary="Route: several epics">…</Part>
 *     <Part id="coverage" number={3} place="current" name="Settle what no slice carries" summary="1 outcome still to settle">…</Part>
 *   </Parts>
 *
 * Opening a part keeps the row that was pressed where it was on the screen: when the part above it closes, the pane
 * scrolls by the same amount, so nothing moves under the pointer.
 */
interface PartsContext {
  open: string | null;
  toggle: (id: string, from: HTMLElement) => void;
  level: 2 | 3;
}

const Ctx = createContext<PartsContext | null>(null);

/** How far above the pane's foot a part's act ends on arrival (the "more below" mark has its own line under the pane). */
const ACT_CLEAR = 24;

export function Parts({
  label,
  open,
  onOpenChange,
  headingLevel = 2,
  children,
}: {
  label: string;
  open: string | null;
  onOpenChange: (id: string | null) => void;
  headingLevel?: 2 | 3;
  children: ReactNode;
}) {
  const anchor = useRef<{ node: HTMLElement; top: number } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const held = anchor.current;
    anchor.current = null;
    if (held) {
      // The person opened a part: the row they pressed stays where it was.
      if (!held.node.isConnected) return;
      const moved = held.node.getBoundingClientRect().top - held.top;
      if (Math.abs(moved) < 1) return;
      const scroller = held.node.closest<HTMLElement>("[data-pane], main");
      if (scroller) scroller.scrollTop += moved;
      return;
    }
    // On arrival, or when an act moved the journey on, the part that needs the person is brought into its pane's view:
    // just enough for the whole part to show, or its row at the top of the pane when it is taller. Only the pane moves.
    const item = list.current?.querySelector<HTMLElement>(':scope > li:has(> * > button[aria-expanded="true"])');
    const pane = item?.closest<HTMLElement>("[data-pane]");
    if (!item || !pane || getComputedStyle(pane).overflowY === "visible") return;
    const bring = (onlyOn: boolean) => {
      const box = pane.getBoundingClientRect();
      const at = item.getBoundingClientRect();
      const header = pane.querySelector<HTMLElement>(":scope > .sticky")?.offsetHeight ?? 0;
      const toRow = at.top - box.top - header - 8;
      if (at.bottom <= box.bottom && at.top >= box.top + header) return;
      // The part's own act, when it marks one (`data-part-act`), must be in view too: the row goes to the top, and if
      // the act is still below the pane's foot, the pane goes on until the act is clear of its foot.
      const act = item.querySelector<HTMLElement>("[data-part-act]");
      const actBelow = act ? act.getBoundingClientRect().bottom - box.bottom + ACT_CLEAR : 0;
      const fitAll = Math.max(0, at.bottom - box.bottom + 24);
      const by = onlyOn ? actBelow : Math.max(Math.min(toRow, fitAll), actBelow);
      if (!onlyOn || by > 0) pane.scrollTop += by;
    };
    bring(false);
    // What the part shows may arrive a moment later (a quotation read from the engine) and push the act back under the
    // pane's foot. Until the person does anything, or a few seconds pass, the pane goes on by as much as the part grew.
    if (typeof ResizeObserver === "undefined") return;
    let left = pane.scrollTop;
    const watch = new ResizeObserver(() => {
      if (Math.abs(pane.scrollTop - left) > 1) return stop();
      bring(true);
      left = pane.scrollTop;
    });
    const events = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
    const timer = window.setTimeout(() => stop(), 3000);
    function stop() {
      watch.disconnect();
      window.clearTimeout(timer);
      for (const name of events) pane?.removeEventListener(name, stop);
    }
    for (const name of events) pane.addEventListener(name, stop, { passive: true });
    watch.observe(item);
    return stop;
  }, [open]);
  const toggle = (id: string, from: HTMLElement) => {
    anchor.current = { node: from, top: from.getBoundingClientRect().top };
    onOpenChange(open === id ? null : id);
  };
  return (
    <Ctx.Provider value={{ open, toggle, level: headingLevel }}>
      <ol ref={list} aria-label={label} className="flex flex-col border-y border-line">
        {children}
      </ol>
    </Ctx.Provider>
  );
}

export type PartPlace = "done" | "current" | "later";

const placeWords: Record<PartPlace, string> = { done: ", done", current: ", current step", later: ", not reached" };

export function Part({
  id,
  name,
  summary,
  number,
  place,
  status,
  attention,
  children,
}: {
  id: string;
  /** The part's name. May hold an identifier set as one ("O-1 Members renew online"). */
  name: ReactNode;
  /** One line: the part's state in plain words. Must carry anything blocking the next act. */
  summary: ReactNode;
  /** The part's number when the parts are the steps of a path. */
  number?: number;
  place?: PartPlace;
  /** A status pill or mark beside the summary (word, shape and tone). */
  status?: ReactNode;
  /**
   * What must stay in view whether the part is open or closed: a problem that blocks the next act (a malformed pack's
   * reasons). Shown under the row, never folded.
   */
  attention?: ReactNode;
  /** The part's body. A part with nothing to show yet has none, and is a row that cannot be opened. */
  children?: ReactNode;
}) {
  const ctx = useContext(Ctx);
  const bodyId = useId();
  const buttonId = useId();
  if (!ctx) throw new Error("Part must be inside Parts");
  const open = ctx.open === id && Boolean(children);
  const Heading = ctx.level === 2 ? "h2" : "h3";
  const marker =
    number !== undefined && place ? (
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-caption font-semibold tabular",
          place === "current" && "border-accent bg-accent-soft text-accent-ink",
          place === "done" && "border-line-strong bg-surface-sunken text-ink-muted",
          place === "later" && "border-line-strong text-ink-subtle",
        )}
      >
        {place === "done" ? <Check className="size-3.5" strokeWidth={2.5} /> : number}
      </span>
    ) : null;
  const words = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className={cn("text-title-3", place === "later" ? "text-ink-muted" : "text-ink")}>
        {name}
        {place ? <span className="sr-only">{placeWords[place]}</span> : null}
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm font-normal text-ink-muted">
        <span className="min-w-0 break-words">{summary}</span>
        {status}
      </span>
    </span>
  );
  return (
    <li className="border-t border-line first:border-t-0">
      <Heading className="m-0">
        {children ? (
          <button
            id={buttonId}
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={(event) => ctx.toggle(id, event.currentTarget)}
            className="flex w-full items-start gap-3 rounded-sm px-1 py-3 text-left hover:bg-surface-sunken"
          >
            {marker}
            {words}
            <ChevronRight aria-hidden="true" className={cn("mt-1 size-4 shrink-0 text-ink-muted transition-transform duration-[var(--mach-duration-fast)]", open && "rotate-90")} />
          </button>
        ) : (
          <span className="flex w-full items-start gap-3 px-1 py-3">
            {marker}
            {words}
          </span>
        )}
      </Heading>
      {attention ? <div className={cn("pb-3", marker ? "pl-10" : "pl-1")}>{attention}</div> : null}
      {children ? (
        <div id={bodyId} role="region" aria-labelledby={buttonId} hidden={!open} className={cn("pb-6 pt-1", marker ? "pl-10" : "pl-1")}>
          {children}
        </div>
      ) : null}
    </li>
  );
}

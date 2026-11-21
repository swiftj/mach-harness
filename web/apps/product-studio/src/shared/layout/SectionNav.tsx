import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@mach/ui";

/**
 * A document's sections, in the narrow pane beside it (M16 layout): where you are, and a way to jump. The section at
 * the top of the document's pane is marked (`aria-current="location"`, a bar and semibold, never colour alone);
 * choosing one moves to it and gives its heading focus. Each item may carry a short note (a count of problems).
 *
 *   <SectionNav label="Sections of the brief" items={[{ id: "brief-section-problem", label: "Problem" }, …]} />
 *
 * `onGo` replaces the default jump (scroll the element with that id into view and focus its heading) when a section
 * lives behind a tab that must be chosen first.
 */
export interface SectionNavItem {
  /** The id of the section element in the page. */
  id: string;
  label: string;
  note?: ReactNode;
}

export function SectionNav({
  label,
  items,
  onGo,
  title = "On this page",
  columns = 1,
}: {
  label: string;
  items: SectionNavItem[];
  onGo?: (id: string) => void;
  title?: string;
  /** Two columns where the list sits above a document in the same pane, so the document keeps most of the height. */
  columns?: 1 | 2;
}) {
  const [current, choose] = useCurrentSection(items.map((i) => i.id));
  return (
    <nav aria-label={label} className="flex flex-col gap-1">
      <p className="px-2 pb-1 text-label text-ink-muted">{title}</p>
      <ul className={columns === 2 ? "grid grid-cols-2 gap-x-2" : "flex flex-col"}>
        {items.map((item) => {
          const here = item.id === current;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={here ? "location" : undefined}
                onClick={() => {
                  choose(item.id);
                  if (onGo) onGo(item.id);
                  else goToSection(item.id);
                }}
                className={cn(
                  "relative flex min-h-8 w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-body-sm text-ink hover:bg-surface-sunken",
                  here && "bg-surface-sunken font-semibold",
                )}
              >
                {here ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-ink-muted" /> : null}
                <span className="min-w-0 truncate">{item.label}</span>
                {item.note}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Moves to a section and gives its heading focus, without moving it twice. */
export function goToSection(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  const heading = target.querySelector<HTMLElement>("h1, h2, h3, h4") ?? target;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

/**
 * The section whose top has passed the top of its scrolling pane (or the first), as the pane scrolls. A section the
 * person jumped to stays marked until they scroll on from where the jump left them (the last sections of a document can
 * never reach the top, so the scroll position alone would mark another).
 */
export function useCurrentSection(ids: string[]): [string | null, (id: string) => void] {
  const key = ids.join(" ");
  const [current, setCurrent] = useState<string | null>(ids[0] ?? null);
  const chosen = useRef<{ id: string; at: number | null } | null>(null);
  const choose = useCallback((id: string) => {
    chosen.current = { id, at: null };
    setCurrent(id);
  }, []);
  useEffect(() => {
    const list = key ? key.split(" ") : [];
    const first = list.map((id) => document.getElementById(id)).find(Boolean);
    const scroller: HTMLElement | Window = first?.closest<HTMLElement>("[data-pane], main") ?? window;
    const position = () => (scroller instanceof Window ? scroller.scrollY : scroller.scrollTop);
    const measure = () => {
      const held = chosen.current;
      if (held) {
        // The jump's own scroll sets where it left the pane; a scroll away from there lets go of the choice.
        if (held.at === null) {
          window.requestAnimationFrame(() => {
            if (chosen.current === held) held.at = position();
          });
          return;
        }
        if (Math.abs(position() - held.at) < 4) return;
        chosen.current = null;
      }
      const top = scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
      let found: string | null = list[0] ?? null;
      for (const id of list) {
        const node = document.getElementById(id);
        if (!node || node.offsetParent === null) continue;
        if (node.getBoundingClientRect().top - top <= 32) found = id;
      }
      // At the end of the document the last sections may never reach the top: the last one shown wins.
      if (!(scroller instanceof Window) && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        const shown = list.filter((id) => document.getElementById(id)?.offsetParent);
        const last = shown.at(-1);
        if (last && scroller.scrollTop > 0) found = last;
      }
      setCurrent(found);
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => scroller.removeEventListener("scroll", measure);
  }, [key]);
  return [current, choose];
}

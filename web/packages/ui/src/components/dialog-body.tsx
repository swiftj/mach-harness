import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * The dialog's height rule (M16): a dialog never grows past the window. The title and the buttons stay in view; the
 * description and the body scroll between them. When there is more than fits, the scrolling part is a named region a
 * keyboard can reach and scroll, and a hairline at its top or bottom edge says there is more that way.
 */
export function DialogBody({ title, children }: { title: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ more: false, above: false, below: false });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const more = node.scrollHeight > node.clientHeight + 1;
      const next = { more, above: more && node.scrollTop > 1, below: more && node.scrollTop + node.clientHeight < node.scrollHeight - 1 };
      setEdges((was) => (was.more === next.more && was.above === next.above && was.below === next.below ? was : next));
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    for (const child of Array.from(node.children)) observer?.observe(child);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  const label = typeof title === "string" ? title : undefined;
  return (
    <div
      ref={ref}
      // A region only when it scrolls, so a keyboard can reach it and scroll it; otherwise it is plain text.
      role={edges.more ? "region" : undefined}
      aria-label={edges.more ? (label ? `${label}, details` : "Details") : undefined}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={edges.more ? 0 : undefined}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto border-y border-transparent px-6 pt-1.5",
        edges.above && "border-t-line",
        edges.below && "border-b-line",
        edges.more && "pb-4",
      )}
    >
      {children}
    </div>
  );
}

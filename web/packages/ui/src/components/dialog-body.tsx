import { useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { scrollEdgeClasses, useScrollEdges } from "../lib/scroll-edges";

/**
 * The dialog's height rule (M16): a dialog never grows past the window. The title and the buttons stay in view; the
 * description and the body scroll between them. When there is more than fits, the scrolling part is a named region a
 * keyboard can reach and scroll, and a hairline at its top or bottom edge says there is more that way (the family's
 * "more below" rule, `useScrollEdges`, which every scrolling pane and board in the apps follows too).
 */
export function DialogBody({ title, children }: { title: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref);
  const label = typeof title === "string" ? title : undefined;
  return (
    <div
      ref={ref}
      // A region only when it scrolls, so a keyboard can reach it and scroll it; otherwise it is plain text.
      role={edges.more ? "region" : undefined}
      aria-label={edges.more ? (label ? `${label}, details` : "Details") : undefined}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={edges.more ? 0 : undefined}
      className={cn("min-h-0 flex-1 overflow-y-auto border-y border-transparent px-6 pt-1.5", scrollEdgeClasses(edges), edges.more && "pb-4")}
    >
      {children}
    </div>
  );
}

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Where a scrolling box has more than it shows (M16 "more below" rule). `more` is true while the box has more than
 * fits in either direction and actually scrolls (a box whose overflow is `visible`, such as a pane in the page-scroll
 * fallback, never does); each edge is true while something is hidden past it. Kept up to date as the box scrolls and
 * as it or its content changes size.
 *
 * The family draws it one way everywhere: a hairline in `line` at each edge where more is hidden, and the box joins
 * the tab order (a keyboard can then scroll it) only while `more` is true. See `scrollEdgeClasses`.
 */
export interface ScrollEdges {
  more: boolean;
  above: boolean;
  below: boolean;
  before: boolean;
  after: boolean;
}

const none: ScrollEdges = { more: false, above: false, below: false, before: false, after: false };

function same(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.more === b.more && a.above === b.above && a.below === b.below && a.before === b.before && a.after === b.after;
}

export function measureScrollEdges(node: HTMLElement): ScrollEdges {
  const style = getComputedStyle(node);
  const scrollsY = style.overflowY !== "visible" && node.scrollHeight > node.clientHeight + 1;
  const scrollsX = style.overflowX !== "visible" && node.scrollWidth > node.clientWidth + 1;
  return {
    more: scrollsY || scrollsX,
    above: scrollsY && node.scrollTop > 1,
    below: scrollsY && node.scrollTop + node.clientHeight < node.scrollHeight - 1,
    before: scrollsX && node.scrollLeft > 1,
    after: scrollsX && node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
  };
}

export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(none);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = measureScrollEdges(node);
      setEdges((was) => (same(was, next) ? was : next));
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(node);
    for (const child of Array.from(node.children)) resize?.observe(child);
    // Content that is added or removed later (a part opened, a turn arrived) changes what is hidden.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      for (const child of Array.from(node.children)) resize?.observe(child);
      measure();
    });
    mutation?.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open", "class"] });
    return () => {
      node.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [ref]);
  return edges;
}

/**
 * The hairlines for the edges where more is hidden. The box must carry a transparent border on the sides it may mark
 * (`border-y border-transparent`, or `border border-transparent`) so nothing moves when a line appears. A side that
 * already has a rule of its own (a pane's left rule, a context row above it) is simply not asked for.
 */
export function scrollEdgeClasses(edges: ScrollEdges, sides: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean } = { top: true, bottom: true }): string {
  return [
    sides.top && edges.above ? "border-t-line" : "",
    sides.bottom && edges.below ? "border-b-line" : "",
    sides.left && edges.before ? "border-l-line" : "",
    sides.right && edges.after ? "border-r-line" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

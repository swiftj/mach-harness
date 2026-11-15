/**
 * The ARIA tree plumbing: every selectable thing in the Blueprint is a `treeitem` element with an
 * accessible name, a level, its position among its siblings, `aria-expanded` where it has children
 * and `aria-selected` from the store. One item holds the tab stop (roving tabindex); the view moves
 * it with the arrow keys. Focus is drawn as the design system's ring around the item's bounds.
 */
import { createContext, memo, useCallback, useContext, type ReactNode } from "react";
import { fc } from "@mach/ui";
import type { EntityRef } from "../sim";
import { useSceneStore } from "../scene";
import type { TreeNode } from "./tree";

export interface TreeCtx {
  activeId: string | null;
  focusedId: string | null;
  register(id: string, el: SVGGElement | null): void;
}

export const TreeContext = createContext<TreeCtx | null>(null);

/**
 * The band of the sheet (in sheet y) the camera shows, widened by half a screen above and below and
 * quantised to 200 units, so it changes a few times per pan rather than every frame. Rows outside it
 * draw their tool calls as one path instead of one element each.
 */
export const BandContext = createContext<readonly [number, number]>([-Infinity, Infinity]);

export function useTreeCtx(): TreeCtx {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("Blueprint tree items must be inside the Blueprint view.");
  return ctx;
}

export function useSelected(entity: EntityRef): boolean {
  return useSceneStore((s) => s.selection === entity);
}

export function useHovered(entity: EntityRef): boolean {
  return useSceneStore((s) => s.hovered === entity);
}

export interface ItemProps {
  node: TreeNode;
  /** Position among its siblings and their number (aria-posinset, aria-setsize), from the parent's render. */
  pos: number;
  size: number;
  expanded?: boolean;
  /** The focus ring, in the item's own coordinates. */
  ring: { x: number; y: number; w: number; h: number; r?: number };
  children?: ReactNode;
  /** Child tree items, rendered after this one (the DOM is flat; aria-level carries the nesting). */
  group?: ReactNode;
}

export const Item = memo(function Item({ node, pos, size, expanded, ring, children, group }: ItemProps) {
  const ctx = useTreeCtx();
  const selected = useSelected(node.ref);
  const register = ctx.register;
  const setRef = useCallback((el: SVGGElement | null) => register(node.id, el), [register, node.id]);
  const focused = ctx.focusedId === node.id;
  return (
    <>
      {/* The drawing of the item, for the eye and the pointer; its accessible name says what it shows. */}
      <g aria-hidden="true" data-tid={node.id} data-ref={node.ref}>
        {children}
      </g>
      {/* The tree item itself: a focus target over the drawing, named, levelled and positioned. The tree is
          flat in the DOM (levels and positions say the hierarchy), so no item contains another's text. */}
      <g
        ref={setRef}
        role="treeitem"
        aria-level={node.level}
        aria-setsize={size}
        aria-posinset={pos}
        aria-expanded={node.children.length ? Boolean(expanded) : undefined}
        aria-selected={selected}
        aria-label={node.name}
        tabIndex={ctx.activeId === node.id ? 0 : -1}
        data-tid={node.id}
        data-ref={node.ref}
        style={{ outline: "none" }}
      >
        <rect x={ring.x} y={ring.y} width={ring.w} height={ring.h} style={{ fill: "transparent", pointerEvents: "none" }} />
        {focused ? (
          <rect
            x={ring.x - 3}
            y={ring.y - 3}
            width={ring.w + 6}
            height={ring.h + 6}
            rx={ring.r ?? 4}
            style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2, pointerEvents: "none" }}
          />
        ) : null}
      </g>
      {group}
    </>
  );
});

/** The selection mark of a lane or row: a 3 px bar in the selection ink at its left edge. */
export function SelectBar({ x, y, h }: { x: number; y: number; h: number }) {
  return <rect x={x} y={y} width={3} height={h} aria-hidden="true" style={{ fill: fc("select") }} />;
}

/** The disclosure chevron: right when collapsed, down when expanded. */
export function Chevron({ x, y, open }: { x: number; y: number; open: boolean }) {
  return (
    <path
      d={open ? `M${x - 3.5} ${y - 2}l3.5 3.5l3.5 -3.5` : `M${x - 1.5} ${y - 4}l3.5 3.5l-3.5 3.5`}
      aria-hidden="true"
      data-toggle="1"
      style={{ fill: "none", stroke: "var(--mach-ink-muted)", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }}
    />
  );
}

/** A hit target for the chevron (bigger than the glyph). */
export function ToggleTarget({ x, y }: { x: number; y: number }) {
  return <rect x={x - 8} y={y - 8} width={16} height={16} data-toggle="1" aria-hidden="true" style={{ fill: "transparent", cursor: "pointer" }} />;
}

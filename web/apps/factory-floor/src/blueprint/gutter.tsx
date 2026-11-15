/**
 * Gutters that stay readable while the camera pans. Every lane's and row's gutter (title, IDs, state,
 * disclosure) is portalled into one layer drawn above the drawing, and shifted right by
 * `--bp-gx` whenever the sheet's left edge has scrolled off the stage, so it stays pinned at the
 * stage's left edge like a frozen pane. Its backing is the sheet's own ground (and the lane's floor
 * tint), so the drawing passes under it. The shift is a CSS variable the camera writes, so panning
 * never re-renders React.
 */
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { fc } from "@mach/ui";
import type { EntityRef } from "../sim";
import { useContext } from "react";
import { LaneDimContext, useLayers } from "./context";
import { SHEET } from "./layout";

export function Gutter({ id, entity, y, h, ax, band = 0.55, row = false, dimmed = false, children }: { id: string; entity: EntityRef; y: number; h: number; ax: number; band?: number; row?: boolean; dimmed?: boolean; children: ReactNode }) {
  const layers = useLayers();
  const laneDimmed = useContext(LaneDimContext);
  const dim = dimmed || (row && laneDimmed);
  const host = row ? layers.rows : layers.gutter;
  if (!host) return null;
  const right = ax - 14;
  return createPortal(
    <g
      className="bp-gutter"
      data-gutter="1"
      data-tid={id}
      data-ref={entity}
      aria-hidden="true"
      style={{ transform: `translate(var(--bp-gx, 0px), ${y}px)`, transition: layers.animate ? "transform 400ms cubic-bezier(0.2, 0, 0, 1)" : "none", opacity: dim ? 0.4 : 1 }}
    >
      <rect x={SHEET.left - 4} y={0} width={right - SHEET.left + 4} height={h} style={{ fill: fc("ground") }} />
      {band > 0 ? <rect x={SHEET.left} y={0} width={right - SHEET.left} height={h} style={{ fill: fc("floor"), opacity: band }} /> : null}
      {/* The gutter's margin rule: the drafted line between the schedule and the drawing. */}
      <line x1={right} y1={0} x2={right} y2={h} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
      {children}
    </g>,
    host,
  );
}

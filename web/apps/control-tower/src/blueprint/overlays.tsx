/**
 * What stays on the stage, outside the camera: the sheet's zone marks as rulers along the top and
 * left edges (shown when the sheet's own border has scrolled off, so any point can still be cited),
 * a small title block (with the simulation label and the live playhead) when the sheet's own one is
 * off screen, and the overview, a thumbnail of the sheet's lanes with how far each has been built
 * and the camera's view, which can be dragged and whose lanes are buttons.
 */
import { memo, useContext, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { fc } from "@mach/ui";
import { useSceneStore } from "../scene";
import type { Camera } from "./camera";
import type { ColumnTemplate } from "./columns";
import { CameraContext, useCamera } from "./context";
import type { FlowNode } from "./flow";
import { SHEET, type Layout } from "./layout";
import { clockTenths } from "./time";

/** The sheet's border margin, where its own zone strip is drawn. */
export const MARGIN = 18;
/** The rulers' depth on the stage, in px: pinned parts sit just inside them. */
export const RULER = 14;

/** Whether the top and left rulers are shown: when the sheet's own border has scrolled off that edge. */
export function rulersShown(cam: Camera): { top: boolean; left: boolean } {
  return { top: cam.y + MARGIN * cam.k < 0, left: cam.x + MARGIN * cam.k < 0 };
}

export function zoneCounts(layout: Layout): { zx: number; zy: number } {
  return { zx: Math.max(8, Math.round(layout.width / 196)), zy: Math.max(4, Math.round(layout.height / 260)) };
}

/** Zone rulers along the stage's top and left edges, aligned to the camera. */
export function ZoneRulers({ layout }: { layout: Layout }) {
  const cam = useCamera();
  const store = useContext(CameraContext);
  const view = store?.size() ?? { w: 0, h: 0 };
  const { zx, zy } = zoneCounts(layout);
  const innerW = layout.width - MARGIN * 2;
  const innerH = layout.height - MARGIN * 2;
  const { top: showTop, left: showLeft } = rulersShown(cam);
  if (!showTop && !showLeft) return null;
  const zw = (innerW / zx) * cam.k;
  const zh = (innerH / zy) * cam.k;
  const ox = cam.x + MARGIN * cam.k;
  const oy = cam.y + MARGIN * cam.k;
  return (
    <svg className="bp-rulers" aria-hidden="true" width={view.w} height={view.h}>
      {showTop ? (
        <g>
          <rect x={0} y={0} width={view.w} height={RULER} style={{ fill: fc("ground") }} />
          <line x1={0} y1={RULER} x2={view.w} y2={RULER} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
          {Array.from({ length: zx }, (_, i) => {
            const x = ox + i * zw;
            if (x + zw < 0 || x > view.w) return null;
            return (
              <g key={i}>
                <line x1={x} y1={0} x2={x} y2={RULER} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
                <text x={x + zw / 2} y={10.5} textAnchor="middle" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600 }}>
                  {String.fromCharCode(65 + i)}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
      {showLeft ? (
        <g>
          <rect x={0} y={showTop ? RULER : 0} width={RULER} height={view.h} style={{ fill: fc("ground") }} />
          <line x1={RULER} y1={0} x2={RULER} y2={view.h} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
          {Array.from({ length: zy }, (_, i) => {
            const y = oy + i * zh;
            if (y + zh < 0 || y > view.h) return null;
            return (
              <g key={i}>
                <line x1={0} y1={y} x2={RULER} y2={y} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
                <text x={RULER / 2} y={y + zh / 2 + 3} textAnchor="middle" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600 }}>
                  {i + 1}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}

/**
 * The title block's live fact, pinned to the stage when the sheet's own block is off screen. It shows
 * only what the Shell's header does not: the playhead, and the simulation label while in Theater (where
 * the header is hidden).
 */
export function PinnedTitle({ layout, theater }: { layout: Layout; theater: boolean }) {
  const cam = useCamera();
  const store = useContext(CameraContext);
  const view = store?.size() ?? { w: 0, h: 0 };
  const t = useSceneStore((s) => Math.floor(s.playhead / 100) * 100);
  const tbW = 260;
  const tbH = 54 + 4 * 16;
  const sx = cam.x + (layout.width - MARGIN - tbW) * cam.k;
  const sy = cam.y + (layout.height - MARGIN - tbH) * cam.k;
  const visible = sx >= 0 && sy >= 0 && sx + tbW * cam.k <= view.w && sy + tbH * cam.k <= view.h;
  if (visible) return null;
  return (
    <div className="bp-title" aria-hidden="true">
      {theater ? <span className="bp-title-stamp">Simulation</span> : null}
      <span className="bp-title-fact">
        <span>Playhead</span>
        <span className="tabular">{clockTenths(t)}</span>
      </span>
    </div>
  );
}

/** Furthest column each lane has built, for the overview's progress strokes. */
function builtExtent(nodes: readonly FlowNode[]): { x: number; live: boolean; done: boolean } {
  let x = 0;
  let live = false;
  let done = false;
  for (const n of nodes) {
    if (n.kind === "future" || (n.kind === "end" && n.key.startsWith("f:"))) continue;
    x = Math.max(x, n.x);
    if (n.visit && n.visit.leftAt === null) live = true;
    if (n.kind === "end") done = true;
  }
  return { x, live, done };
}

export interface MinimapProps {
  layout: Layout;
  template: ColumnTemplate;
  /** Centre the camera on a sheet point, keeping the zoom. */
  centreOn(x: number, y: number): void;
  frameLane(laneId: string): void;
}

/**
 * The overview: the sheet's outline, each lane as a band with a stroke as long as it has been built
 * (live ink while a station works, pass ink once integrated), and the camera's view as a frame. Drag
 * or click to move the view. It appears only while the camera shows less than most of the sheet.
 *
 * It is one control, a listbox of the lanes (findings N1): the lanes are its options, never separate
 * targets, because a lane here is a few px tall and no row of lane buttons could meet the 24 px target
 * size (WCAG 2.5.8) without making the overview bigger. Tab reaches it once; Up and Down (Home, End)
 * choose a lane, Enter or Space frames it. With a pointer, a click on a lane's strip at the left edge
 * frames it, and a click or drag anywhere else moves the view there.
 */
export const Minimap = memo(function Minimap({ layout, template, centreOn, frameLane }: MinimapProps) {
  const cam = useCamera();
  const store = useContext(CameraContext);
  const view = store?.size() ?? { w: 0, h: 0 };
  const W = 150;
  const s = W / layout.width;
  const H = Math.min(180, layout.height * s);
  const sy = H / layout.height;
  const dragging = useRef(false);
  const id = useId();
  const [chosen, setChosen] = useState(0);
  const lanes = layout.lanes;
  const active = Math.min(chosen, Math.max(0, lanes.length - 1));
  const vx = (-cam.x / cam.k) * s;
  const vy = (-cam.y / cam.k) * sy;
  const vw = (view.w / cam.k) * s;
  const vh = (view.h / cam.k) * sy;
  const coverage = Math.min(1, view.w / cam.k / layout.width) * Math.min(1, view.h / cam.k / layout.height);
  if (coverage > 0.82) return null;
  const toSheet = (e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - box.left) / s, y: (e.clientY - box.top) / sy };
  };
  const ax = layout.ax;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!lanes.length || e.altKey || e.ctrlKey || e.metaKey) return;
    let next = active;
    if (e.key === "ArrowDown") next = Math.min(lanes.length - 1, active + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, active - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = lanes.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      const lane = lanes[active];
      if (lane) frameLane(lane.id);
    } else return;
    setChosen(next);
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="bp-minimap">
      <div
        className="bp-minimap-plot"
        role="listbox"
        tabIndex={lanes.length ? 0 : -1}
        aria-label="Overview of the sheet: Up and Down choose a lane, Enter frames it"
        aria-activedescendant={lanes.length ? `${id}-${active}` : undefined}
        style={{ width: W, height: H }}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          const option = (e.target as Element).closest("[role=option]");
          if (option) {
            const i = Number(option.getAttribute("data-index"));
            const lane = lanes[i];
            if (lane) {
              setChosen(i);
              frameLane(lane.id);
            }
            return;
          }
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = toSheet(e);
          centreOn(p.x, p.y);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const p = toSheet(e);
          centreOn(p.x, p.y);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        <svg width={W} height={H} aria-hidden="true">
          <rect x={0.5} y={0.5} width={W - 1} height={H - 1} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 1 }} />
          {layout.lanes.map((lane) => {
            const ext = lane.flow ? builtExtent(lane.flow.nodes) : null;
            const y = lane.y * sy;
            const h = Math.max(2, lane.h * sy);
            const row = (lane.cell && lane.expanded ? lane.row0 : lane.y + Math.min(lane.h / 2, 30)) * sy;
            return (
              <g key={lane.id}>
                <rect x={SHEET.left * s} y={y} width={(layout.width - SHEET.left * 2) * s} height={h - 0.5} style={{ fill: fc("floor"), opacity: lane.cell ? 0.9 : 0.4 }} />
                <line x1={(ax + (template.x.start ?? 0)) * s} y1={row} x2={(ax + (template.x.end ?? 0)) * s} y2={row} style={{ stroke: fc("plate-edge"), strokeWidth: 0.8, strokeDasharray: "2 2" }} />
                {ext ? <line x1={(ax + (template.x.start ?? 0)) * s} y1={row} x2={(ax + ext.x) * s} y2={row} style={{ stroke: fc(ext.done ? "pass" : ext.live ? "live" : "ink"), strokeWidth: 2.2, strokeLinecap: "round" }} /> : null}
              </g>
            );
          })}
          <rect x={vx} y={vy} width={vw} height={vh} style={{ fill: "none", stroke: fc("select"), strokeWidth: 1.4 }} />
        </svg>
        {lanes.map((lane, i) => (
          <div
            key={lane.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            data-index={i}
            className="bp-minimap-lane"
            style={{ top: lane.y * sy, height: Math.max(3, lane.h * sy - 1) }}
            aria-label={`${lane.slice.title}${lane.cell ? `, ${lane.cell.ticketId}` : ""}`}
          />
        ))}
      </div>
    </div>
  );
});

export type { Camera };

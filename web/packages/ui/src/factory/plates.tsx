import type { ReactNode } from "react";
import { factoryTokens } from "../tokens/tokens";
import { cellStages, dimmedOpacity, fc, regions, type CellStage, type FactoryColor, type Lod, type RegionKind } from "./grammar";
import { planeStroke, planeTransform, prismFaces, project, round, screenBounds, shadowPolygon, toPoints, type PlanBox, type Vec2 } from "./projection";
import { useFactoryIds } from "./scene";
import { StateMark } from "./symbols";
import { formatElapsed } from "./motion";

/**
 * The built environment: the ground sheet with its drafting grid, prisms (any raised block), region
 * plates and cell bays. Light comes from the upper left; the face toward plan +y is lit, the face
 * toward +x is in shade and carries section hatching. Every raised thing casts a flat contact shadow
 * away from the light, proportional to its height.
 */

/* ------------------------------------------------------------------------------------------------ */

export interface GroundGridProps {
  /** Plan extent of the grid. */
  x: number;
  y: number;
  w: number;
  d: number;
  lod?: Lod;
  /** Atmospheric fade toward the edges of the extent, 0 (none) to 1. */
  fade?: number;
}

/**
 * The ground: a drafting grid, minor every 24 plan units and major every 96, with registration
 * crosses at major intersections. Minor lines are dropped at far zoom. Lines fade toward the extent's
 * edges so the plant sits in a pool of drawing rather than on an endless sheet.
 */
export function GroundGrid({ x, y, w, d, lod = "mid", fade = 0.85 }: GroundGridProps) {
  const { minor, major } = factoryTokens.grid;
  const cx = x + w / 2;
  const cy = y + d / 2;
  const lines: ReactNode[] = [];
  const alpha = (u: number, half: number) => Math.max(0, 1 - fade * Math.pow(Math.abs(u) / half, 2));
  const step = lod === "far" ? major : minor;
  for (let gx = Math.ceil(x / step) * step; gx <= x + w; gx += step) {
    const isMajor = gx % major === 0;
    lines.push(
      <line
        key={`x${gx}`}
        x1={gx}
        y1={y}
        x2={gx}
        y2={y + d}
        style={{ stroke: fc(isMajor ? "grid-major" : "grid"), strokeWidth: (isMajor ? 1 : 0.75) * planeStroke, opacity: alpha(gx - cx, w / 2) }}
      />,
    );
  }
  for (let gy = Math.ceil(y / step) * step; gy <= y + d; gy += step) {
    const isMajor = gy % major === 0;
    lines.push(
      <line
        key={`y${gy}`}
        x1={x}
        y1={gy}
        x2={x + w}
        y2={gy}
        style={{ stroke: fc(isMajor ? "grid-major" : "grid"), strokeWidth: (isMajor ? 1 : 0.75) * planeStroke, opacity: alpha(gy - cy, d / 2) }}
      />,
    );
  }
  const crosses: ReactNode[] = [];
  if (lod !== "far") {
    for (let gx = Math.ceil(x / major) * major; gx <= x + w; gx += major) {
      for (let gy = Math.ceil(y / major) * major; gy <= y + d; gy += major) {
        const a = Math.min(alpha(gx - cx, w / 2), alpha(gy - cy, d / 2));
        crosses.push(
          <path key={`c${gx}-${gy}`} d={`M${gx - 4} ${gy}h8M${gx} ${gy - 4}v8`} style={{ stroke: fc("plate-edge"), strokeWidth: 0.9 * planeStroke, opacity: a }} />,
        );
      }
    }
  }
  return (
    <g aria-hidden="true" transform={planeTransform(0)}>
      {lines}
      {crosses}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export interface PrismProps {
  box: PlanBox;
  top?: FactoryColor;
  lit?: FactoryColor;
  shade?: FactoryColor;
  edge?: FactoryColor;
  /** Which side face carries section hatching. */
  hatch?: "lit" | "shade" | "both" | "none";
  shadow?: boolean;
  /** Outline weight in screen px. */
  weight?: number;
  /** Outline dash (for unsettled things). */
  dash?: string;
  /** The lit front edge (top face, toward plan +y) catches the light: drawn in `plate-rim`. Default on. */
  rim?: boolean;
  /** Drawn on the top face, in plan coordinates (the group carries the plane transform at the top). */
  children?: ReactNode;
}

/** A raised block: contact shadow, lit face, shaded face with hatching, top face, drafted outline. */
export function Prism({ box, top = "plate-top", lit = "plate-lit", shade = "plate-shade", edge = "plate-edge", hatch = "shade", shadow = true, weight = 1, dash, rim = true, children }: PrismProps) {
  const ids = useFactoryIds();
  const f = prismFaces(box);
  const h = box.h ?? 0;
  const zTop = (box.z ?? 0) + h;
  const outline = { stroke: fc(edge), strokeWidth: weight, strokeLinejoin: "round" as const, strokeDasharray: dash };
  return (
    <g>
      {shadow && h > 0 ? <polygon aria-hidden="true" points={toPoints(shadowPolygon(box).map(project))} style={{ fill: fc("shadow") }} /> : null}
      {h > 0 ? (
        <>
          <polygon aria-hidden="true" points={toPoints(f.lit)} style={{ fill: fc(lit) }} />
          {hatch === "lit" || hatch === "both" ? <polygon aria-hidden="true" points={toPoints(f.lit)} style={{ fill: `url(#${ids.hatch})` }} /> : null}
          <polygon aria-hidden="true" points={toPoints(f.shade)} style={{ fill: fc(shade) }} />
          {hatch === "shade" || hatch === "both" ? <polygon aria-hidden="true" points={toPoints(f.shade)} style={{ fill: `url(#${ids.hatch})` }} /> : null}
        </>
      ) : null}
      <polygon aria-hidden="true" points={toPoints(f.top)} style={{ fill: fc(top) }} />
      {children ? <g transform={planeTransform(zTop)}>{children}</g> : null}
      {/* Drafted outline: the silhouette and the near vertical edge, one weight. */}
      <path
        aria-hidden="true"
        d={
          h > 0
            ? `M${pt(f.top[0]!)}L${pt(f.top[1]!)}L${pt(f.shade[3]!)}L${pt(f.shade[2]!)}L${pt(f.lit[3]!)}L${pt(f.top[3]!)}Z M${pt(f.top[3]!)}L${pt(f.top[2]!)}L${pt(f.top[1]!)} M${pt(f.top[2]!)}L${pt(f.shade[2]!)}`
            : `M${pt(f.top[0]!)}L${pt(f.top[1]!)}L${pt(f.top[2]!)}L${pt(f.top[3]!)}Z`
        }
        style={{ ...outline, fill: "none" }}
      />
      {rim && h > 0 ? (
        <line aria-hidden="true" x1={round(f.top[3]!.x)} y1={round(f.top[3]!.y)} x2={round(f.top[2]!.x)} y2={round(f.top[2]!.y)} style={{ stroke: fc("plate-rim"), strokeWidth: weight, strokeLinecap: "round" }} />
      ) : null}
    </g>
  );
}

function pt(p: Vec2): string {
  return `${round(p.x)} ${round(p.y)}`;
}

/* ------------------------------------------------------------------------------------------------ */

export interface RegionPlateProps {
  /** Plan footprint of the region. */
  box: { x: number; y: number; w: number; d: number };
  kind: RegionKind;
  /** Overrides the region's own name. */
  title?: string;
  /** One short line lettered under the title, such as "3 cells". */
  caption?: string;
  height?: number;
  lod?: Lod;
  dimmed?: boolean;
  /** A thin live rule along the front edge while anything in the region is working. */
  active?: boolean;
  children?: ReactNode;
}

/**
 * A production region: a low plinth with a drafted rim (a second line inset by 8), corner
 * registration marks, and its name lettered on the floor in the serif, running along the flow.
 * Children are drawn on the plate's top face (plan coordinates).
 */
export function RegionPlate({ box, kind, title, caption, height = factoryTokens.elevation.regionPlate, lod = "mid", dimmed, active, children }: RegionPlateProps) {
  const name = title ?? regions[kind].label;
  const inset = 8;
  const letter = lod === "far" ? 26 : 19;
  return (
    <g aria-label={name} role="group" style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <Prism box={{ ...box, z: 0, h: height }} hatch="both">
        <rect
          aria-hidden="true"
          x={box.x + inset}
          y={box.y + inset}
          width={box.w - inset * 2}
          height={box.d - inset * 2}
          style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 0.75 * planeStroke, strokeDasharray: lod === "near" ? undefined : "1 0" }}
        />
        {/* Registration marks at the four corners of the inset. */}
        {lod !== "far"
          ? [
              [box.x + inset, box.y + inset, 1, 1],
              [box.x + box.w - inset, box.y + inset, -1, 1],
              [box.x + box.w - inset, box.y + box.d - inset, -1, -1],
              [box.x + inset, box.y + box.d - inset, 1, -1],
            ].map(([cx, cy, sx, sy]) => (
              <path
                key={`${cx}-${cy}`}
                aria-hidden="true"
                d={`M${cx! + sx! * 12} ${cy}H${cx}V${cy! + sy! * 12}`}
                style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.2 * planeStroke }}
              />
            ))
          : null}
        {active ? (
          <line aria-hidden="true" x1={box.x + inset} y1={box.y + box.d - inset} x2={box.x + box.w - inset} y2={box.y + box.d - inset} style={{ stroke: fc("live"), strokeWidth: 1.5 * planeStroke }} />
        ) : null}
        <text
          x={box.x + inset + 10}
          y={box.y + box.d - inset - (caption && lod !== "far" ? 22 : 10)}
          style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-serif)", fontSize: letter, fontWeight: 420, letterSpacing: "0.01em" }}
        >
          {name}
        </text>
        {caption && lod !== "far" ? (
          <text x={box.x + inset + 11} y={box.y + box.d - inset - 8} style={{ fill: "var(--mach-ink-muted)", fontSize: 10.5, fontWeight: 500 }}>
            {caption}
          </text>
        ) : null}
        {children}
      </Prism>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

/** Where things stand inside a cell bay, relative to its origin. One anatomy for every cell. */
export function cellAnatomy(origin: { x: number; y: number }, z: number = factoryTokens.elevation.regionPlate) {
  const { x, y } = origin;
  const floorZ = z + 4;
  const railY = y + 58;
  return {
    floorZ,
    size: factoryTokens.size.cell,
    /** The cell's conveyor, from its entrance (left) to its exit door (right). */
    rail: [
      { x: x + 6, y: railY, z: floorZ },
      { x: x + factoryTokens.size.cell.x, y: railY, z: floorZ },
    ],
    /** Machine centres: the intent bench (groom and plan), build, verify. */
    pads: {
      intent: { x: x + 40, y: railY, z: floorZ },
      build: { x: x + 110, y: railY, z: floorZ },
      verify: { x: x + 178, y: railY, z: floorZ },
    },
    /** Where an agent stands to work a pad: in front of it, toward the viewer. */
    agentSpot: (pad: "intent" | "build" | "verify", seat = 0) => {
      const px = { intent: 40, build: 110, verify: 178 }[pad];
      return { x: x + px - 10 + seat * 16, y: railY + 34, z: floorZ };
    },
    /** Artifact shelf along the back wall: slot i. */
    shelf: (i: number) => ({ x: x + 18 + i * 19, y: y + 18, z: floorZ }),
    /** The tool ticker: a strip along the front of the floor. Fraction 0..1 along it. */
    ticker: (f: number) => ({ x: x + 16 + f * (factoryTokens.size.cell.x - 40), y: y + factoryTokens.size.cell.y - 30, z: floorZ }),
    tickerLine: [
      { x: x + 16, y: y + factoryTokens.size.cell.y - 30, z: floorZ },
      { x: x + factoryTokens.size.cell.x - 24, y: y + factoryTokens.size.cell.y - 30, z: floorZ },
    ],
    /** The exit door, where the verification gate stands. */
    door: { x: x + factoryTokens.size.cell.x, y: railY, z: floorZ },
    /** The signal mast at the back left corner, carrying the stage mark. */
    mast: { x: x + 10, y: y + 10, z: floorZ + factoryTokens.elevation.cellRim },
  };
}

/**
 * The light pool of a cell's work lamp, in plan coordinates on the cell floor (elevation `z`): an
 * ellipse centred a little toward the build machine, filled with the `lampFalloff` gradient at the
 * lamp's intensity. A WebGL layer replacing it draws the same ellipse, projected with `planeMatrix(z)`.
 */
export function lampPool(origin: { x: number; y: number }, z: number = factoryTokens.elevation.regionPlate) {
  const { x: w, y: d } = factoryTokens.size.cell;
  return { cx: origin.x + w * 0.52, cy: origin.y + d * 0.5, rx: w * 0.5, ry: d * 0.56, z: z + 4 };
}

export interface CellPlateProps {
  origin: { x: number; y: number };
  /** The ticket ID, lettered on the floor. */
  ticket: string;
  /** The slice ID, lettered beside it at near zoom. */
  slice?: string;
  stage: CellStage;
  /** Base elevation (the top of the region plate the cell stands on). */
  z?: number;
  /** The work lamp: on while any station in the cell is working. */
  lit?: boolean;
  /**
   * The lamp's intensity, 0..1, for fading it in and out (stateChange, 260 ms) from the playhead.
   * Overrides `lit` when given: 0 is off, 1 is full.
   */
  lampIntensity?: number;
  /** 0..1, the cell-complete animation: the floor settles to the calm `done` tone. */
  completion?: number;
  /** Deprecated: kept for compatibility and no longer drawn. A stage in flight has no known end; use `elapsed`. */
  progress?: number;
  /** How long the current stage has run, in factory ms: shown beside the stage word on the mast at near zoom. */
  elapsed?: number;
  lod?: Lod;
  dimmed?: boolean;
  /** Draw the cell's own conveyor rail. */
  rail?: boolean;
  /** The machines, agents and artifacts, drawn between the back walls and the front section cut. */
  children?: ReactNode;
}

/**
 * A construction cell, drawn as an architectural section model of a bay: a floor slab, two back
 * walls standing full height (their inner faces lit), and the two front walls cut away at curb
 * height with poché hatching on the cut, so the work inside is always visible. A signal mast at the
 * back corner carries the stage mark (and, at near zoom, how long the stage has run). The ticket ID
 * is lettered on the floor. A finished cell's floor settles to the calm `done` tone.
 */
export function CellPlate({ origin, ticket, slice, stage, z = factoryTokens.elevation.regionPlate as number, lit, lampIntensity, completion = 0, elapsed, lod = "mid", dimmed, rail = true, children }: CellPlateProps) {
  const ids = useFactoryIds();
  const a = cellAnatomy(origin, z);
  const { x: w, y: d } = a.size;
  const { x, y } = origin;
  const wallH = factoryTokens.elevation.cellRim;
  const look = cellStages[stage];
  const lamp = Math.min(1, Math.max(0, lampIntensity ?? (lit ? 1 : 0)));
  const pool = lampPool(origin, z);
  const mast = project(a.mast);
  const mastTop = project({ ...a.mast, z: a.mast.z + 20 });
  return (
    <g role="group" aria-label={`Cell ${ticket}: ${look.label}`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      {/* Floor slab. */}
      <Prism box={{ x, y, w, d, z, h: 4 }} top="floor" hatch="none">
        {lamp > 0 ? <ellipse aria-hidden="true" cx={pool.cx} cy={pool.cy} rx={pool.rx} ry={pool.ry} style={{ fill: `url(#${ids.lamp})`, opacity: lamp }} /> : null}
        {completion > 0 ? <rect aria-hidden="true" x={x} y={y} width={w} height={d} style={{ fill: fc("done"), opacity: completion }} /> : null}
        {/* Floor lettering: the ticket, and the slice at near zoom. */}
        <text x={x + 14} y={y + d - 9} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: lod === "far" ? 16 : 11, fontWeight: 500 }} className="notranslate">
          {ticket}
        </text>
        {slice && lod === "near" ? (
          <text x={x + 80} y={y + d - 9} style={{ fill: "var(--mach-ink-subtle)", fontFamily: "var(--mach-font-mono)", fontSize: 9 }} className="notranslate">
            {slice}
          </text>
        ) : null}
        {rail ? (
          <g aria-hidden="true">
            <line x1={a.rail[0]!.x} y1={a.rail[0]!.y - 3} x2={a.rail[1]!.x} y2={a.rail[1]!.y - 3} style={{ stroke: fc("route"), strokeWidth: 0.9 * planeStroke }} />
            <line x1={a.rail[0]!.x} y1={a.rail[0]!.y + 3} x2={a.rail[1]!.x} y2={a.rail[1]!.y + 3} style={{ stroke: fc("route"), strokeWidth: 0.9 * planeStroke }} />
          </g>
        ) : null}
        {lod !== "far" ? (
          <line aria-hidden="true" x1={a.tickerLine[0]!.x} y1={a.tickerLine[0]!.y} x2={a.tickerLine[1]!.x} y2={a.tickerLine[1]!.y} style={{ stroke: fc("grid-major"), strokeWidth: 0.9 * planeStroke, strokeDasharray: "2 3" }} />
        ) : null}
      </Prism>
      {/* Back walls: left (along y) then back (along x); inner faces lit, so drawn as thin prisms. */}
      <Prism box={{ x, y, w: 4, d, z: z + 4, h: wallH }} hatch="none" shadow={false} top="plate-top" lit="plate-lit" shade="plate-top" />
      <Prism box={{ x, y, w, d: 4, z: z + 4, h: wallH }} hatch="none" shadow={false} top="plate-top" lit="plate-top" shade="plate-shade" />
      {/* Signal mast with the stage mark. */}
      <line aria-hidden="true" x1={mast.x} y1={mast.y} x2={mastTop.x} y2={mastTop.y} style={{ stroke: fc("ink-soft"), strokeWidth: 1.2 }} />
      <g transform={`translate(${round(mastTop.x)} ${round(mastTop.y - 6)})`}>
        <StateMark state={look.state} mark={look.mark} r={lod === "far" ? 8 : 6} />
        {lod === "near" ? (
          <text x={10} y={4} className="tabular" style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
            {look.label}
            {look.state === "active" && elapsed !== undefined ? <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}>{` · ${formatElapsed(elapsed)}`}</tspan> : null}
          </text>
        ) : null}
      </g>
      {children}
      {/* The section cut: front walls cut at curb height, poché on the cut faces. */}
      <Prism box={{ x, y: y + d - 3, w, d: 3, z: z + 4, h: 4 }} hatch="lit" shadow={false} top="plate-shade" />
      <Prism box={{ x: x + w - 3, y, w: 3, d: a.door.y - y - 14, z: z + 4, h: 4 }} hatch="shade" shadow={false} top="plate-shade" />
      <Prism box={{ x: x + w - 3, y: a.door.y + 14, w: 3, d: y + d - 3 - (a.door.y + 14), z: z + 4, h: 4 }} hatch="shade" shadow={false} top="plate-shade" />
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

/**
 * Selection: four drafted corner brackets around a thing's screen bounds, in the selection ink.
 * Selection is a place ("this one"), so it uses the accent family, never a fill.
 */
export function SelectionBrackets({ bounds, pad = 6, arm = 10, label }: { bounds: { x: number; y: number; width: number; height: number }; pad?: number; arm?: number; label?: string }) {
  const x0 = bounds.x - pad;
  const y0 = bounds.y - pad;
  const x1 = bounds.x + bounds.width + pad;
  const y1 = bounds.y + bounds.height + pad;
  const d = `M${x0} ${y0 + arm}V${y0}H${x0 + arm}M${x1 - arm} ${y0}H${x1}V${y0 + arm}M${x1} ${y1 - arm}V${y1}H${x1 - arm}M${x0 + arm} ${y1}H${x0}V${y1 - arm}`;
  return (
    <g aria-hidden="true">
      <path d={d} style={{ fill: "none", stroke: fc("select"), strokeWidth: factoryTokens.stroke.select, strokeLinecap: "square" }} />
      {label ? (
        <text x={x0} y={y0 - 6} style={{ fill: fc("select"), fontSize: 10.5, fontWeight: 600 }}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

/** Screen bounds of plan boxes: re-exported for framing selection and focus. */
export { screenBounds };

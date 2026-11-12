/**
 * The built plant: ground, region plates, bridges, the dock, every track, the trunk cut, the
 * conduit, and the floor lettering and drafting marks that name and dimension things. Static: it
 * changes only with the level of detail and the regions' captions (which change at events).
 */
import { memo, type ReactNode } from "react";
import { GroundGrid, Prism, RegionPlate, RoutePath, fc, planeStroke, planeTransform, project, round, type Lod, type RegionKind, type Vec3 } from "@mach/ui";
import type { PlantLayout, Rect } from "./layout";
import { PLATE_Z } from "./layout";

/** Lettering drawn into the plane at elevation z: reads along plan x (or along y when `alongY`). */
export function PlaneText({ x, y, z = PLATE_Z, size = 9, children, mono, serif, alongY, anchor = "start", tone = "muted", weight }: { x: number; y: number; z?: number; size?: number; children: ReactNode; mono?: boolean; serif?: boolean; alongY?: boolean; anchor?: "start" | "middle" | "end"; tone?: "muted" | "subtle" | "ink" | "fail" | "pass" | "wait" | "human" | "live"; weight?: number }) {
  const fill = tone === "muted" ? "var(--mach-ink-muted)" : tone === "subtle" ? "var(--mach-ink-subtle)" : tone === "ink" ? "var(--mach-ink)" : fc(tone);
  return (
    <g transform={planeTransform(z)} aria-hidden="true">
      <text
        x={x}
        y={y}
        transform={alongY ? `rotate(90 ${x} ${y})` : undefined}
        textAnchor={anchor}
        className="notranslate"
        style={{ fill, fontSize: size, fontFamily: mono ? "var(--mach-font-mono)" : serif ? "var(--mach-font-serif)" : undefined, fontWeight: weight }}
      >
        {children}
      </text>
    </g>
  );
}

/** A drafted dimension along plan x on the ground: extension lines, slash ticks, a value. */
export function PlanDimension({ x0, x1, y, z = 0, label, lod }: { x0: number; x1: number; y: number; z?: number; label: string; lod: Lod }) {
  if (lod === "far") return null;
  const s = planeStroke;
  return (
    <g transform={planeTransform(z)} aria-hidden="true">
      <path d={`M${x0} ${y - 10}V${y + 4}M${x1} ${y - 10}V${y + 4}M${x0} ${y}H${x1}`} style={{ fill: "none", stroke: "var(--mach-ink-subtle)", strokeWidth: 0.75 * s }} />
      <path d={`M${x0 - 3} ${y + 3}L${x0 + 3} ${y - 3}M${x1 - 3} ${y + 3}L${x1 + 3} ${y - 3}`} style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 1.1 * s }} />
      <text x={(x0 + x1) / 2} y={y - 4} textAnchor="middle" className="notranslate" style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5, fontFamily: "var(--mach-font-mono)" }}>
        {label}
      </text>
    </g>
  );
}

function regionBox(r: Rect) {
  return { x: r.x, y: r.y, w: r.w, d: r.d };
}

export interface PlantProps {
  layout: PlantLayout;
  lod: Lod;
  captions: Partial<Record<RegionKind, string>>;
  active: Partial<Record<RegionKind, boolean>>;
  dimRoutes: boolean;
}

/** Layers 1, 3 and 4 of spec b.4: ground, plates and bridges, routes on the plates. */
export function Plant({ layout, lod, captions, active, dimRoutes }: PlantProps) {
  return (
    <g>
      <Ground layout={layout} lod={lod} />
      <Regions layout={layout} lod={lod} captions={captions} active={active} />
      <Infrastructure layout={layout} lod={lod} dimRoutes={dimRoutes} />
    </g>
  );
}

/** 1. The drafting sheet the plant is drawn on. */
const Ground = memo(function Ground({ layout: L, lod }: { layout: PlantLayout; lod: Lod }) {
  const e = L.extent;
  return <GroundGrid x={e.x - 120} y={e.y - 120} w={e.w + 240} d={e.d + 240} lod={lod} fade={0.85} />;
});

/** 3. Plates, bridges, the dock and the conduit: re-drawn only when a caption or an active rule changes. */
const Regions = memo(function Regions({ layout: L, lod, captions, active }: Omit<PlantProps, "dimRoutes">) {
  const R = L.regions;
  const I = L.integration;
  return (
    <g>
      {/* The dock, where approved waves come in from Product Studio. */}
      <Prism box={{ x: L.dock.x, y: L.dock.y, w: L.dock.w, d: L.dock.d, z: 0, h: PLATE_Z - 2 }} hatch="both" top="plate-lit" />
      {lod !== "far" ? (
        <>
          <PlaneText x={L.dock.x + 6} y={L.dock.y + 12} z={PLATE_Z - 2} size={8} mono tone="subtle">
            DOCK · PRODUCT STUDIO
          </PlaneText>
          <PlaneText x={L.dock.x + 6} y={L.dock.y + L.dock.d - 6} z={PLATE_Z - 2} size={8} mono tone="subtle">
            approved waves only
          </PlaneText>
        </>
      ) : null}
      {/* Regions, back to front. */}
      <RegionPlate box={regionBox(R.intake)} kind="intake" caption={captions.intake} lod={lod} active={active.intake}>
        {lod !== "far" ? (
          <>
            <text x={136} y={L.bays[0] ? L.bays[0].pad.y - 34 : 0} style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
              HOLDING PADS
            </text>
            <text x={24} y={L.mid - 116} style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
              SUPERVISOR · 60 s TICK
            </text>
          </>
        ) : null}
      </RegionPlate>
      <RegionPlate box={regionBox(R.floor)} kind="floor" caption={captions.floor} lod={lod} active={active.floor}>
        {lod !== "far" ? (
          <>
            {/* Aisle and transfer lettering, painted on the floor. */}
            <text x={L.floor.riserX - 6} y={L.floor.transferY - 6} textAnchor="end" style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
              FRONT TRANSFER → REVIEW
            </text>
            <text x={L.floor.spineX + 6} y={L.mid - 6} style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
              DISPATCH
            </text>
          </>
        ) : null}
      </RegionPlate>
      <RegionPlate box={regionBox(R.review)} kind="review" caption={captions.review} lod={lod} active={active.review} />
      <RegionPlate box={regionBox(R.human)} kind="human" title="Approval" caption={captions.human} lod={lod} active={active.human} />
      <RegionPlate box={regionBox(R.integration)} kind="integration" title="Integration yard" caption={captions.integration} lod={lod} active={active.integration}>
        <TrunkCut y={I.trunkY} x0={I.trunkTo - 8} x1={I.trunkFrom + 8} lod={lod} />
      </RegionPlate>
      <RegionPlate box={regionBox(R.archive)} kind="archive" title="Archive" caption={captions.archive} lod={lod} active={active.archive} />
      {L.bridges.map((b, i) => (
        <Prism key={i} box={b} hatch="lit" top="plate-top" />
      ))}
      {/* The supervisor's conduit: from its console, over the catwalk, down the floor's left edge. */}
      <Conduit points={conduitPath(L)} />
    </g>
  );
});

/** 4. Tracks on the plate tops, the main line's ruler and lettering. */
const Infrastructure = memo(function Infrastructure({ layout: L, lod, dimRoutes }: { layout: PlantLayout; lod: Lod; dimRoutes: boolean }) {
  const I = L.integration;
  return (
    <g>
      <g style={{ opacity: dimRoutes ? 0.4 : 1 }}>
        {Object.entries(L.tracks).map(([name, pts]) =>
          name === "trunk" ? null : <RoutePath key={name} points={pts} lod={lod} label={undefined} arrow={name === "transfer" || name === "toArchive"} />,
        )}
        <RoutePath points={L.tracks.trunk ?? []} lod={lod} state="succeeded" chevrons={lod !== "far"} />
      </g>
      {/* Ruler on the main line: one tick every 24 pu, a numbered tick every 96. */}
      {lod !== "far" ? <Ruler y={I.trunkY + 12} x0={I.trunkTo} x1={I.trunkFrom} /> : null}
      <PlaneText x={I.trunkTo + 230} y={I.trunkY - 12} z={PLATE_Z} size={lod === "far" ? 14 : 10} mono tone="pass" weight={600}>
        main · integration branch
      </PlaneText>
    </g>
  );
});

function TrunkCut({ y, x0, x1, lod }: { y: number; x0: number; x1: number; lod: Lod }) {
  // A channel cut 6 deep into the plate: dark bed, hatched cheeks on both sides.
  const w = 16;
  return (
    <g aria-hidden="true">
      <rect x={x0} y={y - w / 2} width={x1 - x0} height={w} style={{ fill: fc("plate-shade") }} />
      <rect x={x0} y={y - w / 2} width={x1 - x0} height={3.5} style={{ fill: fc("hatch"), opacity: 0.8 }} />
      <rect x={x0} y={y + w / 2 - 2} width={x1 - x0} height={2} style={{ fill: fc("hatch"), opacity: 0.5 }} />
      <path d={`M${x0} ${y - w / 2}H${x1}M${x0} ${y + w / 2}H${x1}`} style={{ stroke: fc("plate-edge"), strokeWidth: planeStroke }} />
      {lod === "near" ? <path d={`M${x0} ${y - w / 2}V${y + w / 2}M${x1} ${y - w / 2}V${y + w / 2}`} style={{ stroke: fc("plate-edge"), strokeWidth: planeStroke }} /> : null}
    </g>
  );
}

function Ruler({ y, x0, x1 }: { y: number; x0: number; x1: number }) {
  const ticks: ReactNode[] = [];
  for (let x = x0; x <= x1; x += 24) {
    const major = Math.round(x - x0) % 96 === 0;
    ticks.push(<path key={x} d={`M${x} ${y}v${major ? 6 : 3.5}`} />);
  }
  return (
    <g transform={planeTransform(PLATE_Z)} aria-hidden="true" style={{ stroke: "var(--mach-ink-subtle)", strokeWidth: 0.8 * planeStroke, fill: "none" }}>
      <path d={`M${x0} ${y}H${x1}`} />
      {ticks}
    </g>
  );
}

export function conduitPath(L: PlantLayout): Vec3[] {
  const s = L.intake.supervisor;
  const z = PLATE_Z + 1;
  const lastRow = Math.max(...L.bays.map((b) => b.origin.y + 10));
  return [
    { x: s.x + 14, y: s.y, z },
    { x: s.x + 14, y: 7, z },
    { x: L.floor.conduitX, y: 7, z },
    { x: L.floor.conduitX, y: lastRow, z },
  ];
}

/** The conduit: a two-line cable tray, drawn in the plane. */
function Conduit({ points }: { points: Vec3[] }) {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${round(project(p).x)} ${round(project(p).y)}`).join("");
  return (
    <g aria-hidden="true">
      <path d={d} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 3.2, strokeLinejoin: "round" }} />
      <path d={d} style={{ fill: "none", stroke: fc("plate-top"), strokeWidth: 1.6, strokeLinejoin: "round" }} />
    </g>
  );
}

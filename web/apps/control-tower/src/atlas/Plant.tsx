/**
 * The built plant: ground, region plates, bridges, the dock, every track, the trunk cut, the
 * conduit, and the floor lettering and drafting marks that name and dimension things. Static: it
 * changes only with the level of detail and the regions' captions (which change at events).
 */
import { memo, type ReactNode } from "react";
import { GroundGrid, Prism, RegionPlate, RoutePath, factoryTokens, fc, offsetPolyline, planeStroke, planeTransform, project, round, roundedPath, type Lod, type RegionKind, type Vec3 } from "@mach/ui";
import { FloorLettering } from "@mach/ui";
import type { PlantLayout, Rect } from "./layout";
import { PLATE_Z } from "./layout";

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
  // The grid runs 96 pu past the plant and fades out; the stage beyond is plain ground (spec b.2).
  if (lod === "far") return <FarGrid x={e.x} y={e.y} w={e.w} d={e.d} fade={0.7} />;
  return <GroundGrid x={e.x} y={e.y} w={e.w} d={e.d} lod={lod} fade={0.7} />;
});

/**
 * The ground grid at far zoom: GroundGrid's far drawing (major lines only, no crosses, fading toward
 * the extent's edges) batched into one path per fade band instead of one line each, so the far view
 * spends 4 elements on the ground instead of 26 (the far element budget). Each line takes the band
 * nearest its own fade, so the picture is the same to within a few percent of opacity.
 */
const BANDS = [0.45, 0.65, 0.85, 1];
function FarGrid({ x, y, w, d, fade }: { x: number; y: number; w: number; d: number; fade: number }) {
  const step = factoryTokens.grid.major;
  const cx = x + w / 2;
  const cy = y + d / 2;
  const alpha = (u: number, half: number) => Math.max(0, 1 - fade * Math.pow(Math.abs(u) / half, 2));
  const band = (a: number) => BANDS.reduce((best, b, i) => (Math.abs(b - a) < Math.abs(BANDS[best]! - a) ? i : best), 0);
  const paths = BANDS.map(() => "");
  for (let gx = Math.ceil(x / step) * step; gx <= x + w; gx += step) paths[band(alpha(gx - cx, w / 2))] += `M${gx} ${y}V${y + d}`;
  for (let gy = Math.ceil(y / step) * step; gy <= y + d; gy += step) paths[band(alpha(gy - cy, d / 2))] += `M${x} ${gy}H${x + w}`;
  return (
    <g aria-hidden="true" transform={planeTransform(0)}>
      {paths.map((p, i) => (p ? <path key={i} d={p} style={{ fill: "none", stroke: fc("grid-major"), strokeWidth: planeStroke, opacity: BANDS[i] }} /> : null))}
    </g>
  );
}

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
          <FloorLettering at={{ x: L.dock.x + 6, y: L.dock.y + 12, z: PLATE_Z - 2 }} text="DOCK · PRODUCT STUDIO" size={8} font="mono" tone="subtle" weight={500} decorative />
          <FloorLettering at={{ x: L.dock.x + 6, y: L.dock.y + L.dock.d - 6, z: PLATE_Z - 2 }} text="approved waves only" size={8} font="mono" tone="subtle" weight={500} decorative />
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
      {/* Bridges; their poché is detail too small to read at far zoom (the far element budget). */}
      {L.bridges.map((b, i) => (
        <Prism key={i} box={b} hatch={lod === "far" ? "none" : "lit"} top="plate-top" />
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
        {lod === "far" ? <FarRails tracks={L.tracks} /> : null}
        {Object.entries(L.tracks).map(([name, pts]) =>
          name === "trunk" || (lod === "far" && !ARROWED.has(name)) ? null : <RoutePath key={name} points={pts} lod={lod} label={undefined} arrow={ARROWED.has(name)} />,
        )}
        <RoutePath points={L.tracks.trunk ?? []} lod={lod} state="succeeded" chevrons={lod !== "far"} />
      </g>
      {/* Ruler on the main line: one tick every 24 pu, a numbered tick every 96. */}
      {lod !== "far" ? <Ruler y={I.trunkY + 12} x0={I.trunkTo} x1={I.trunkFrom} /> : null}
      <FloorLettering at={{ x: I.trunkTo + 230, y: I.trunkY - 12, z: PLATE_Z }} text="main · integration branch" size={lod === "far" ? 14 : 10} font="mono" tone="pass" weight={600} decorative />
    </g>
  );
});

const ARROWED = new Set(["transfer", "toArchive"]);

/**
 * At far zoom (no chevrons, no sleepers) an idle track is just its two rails, so every idle track
 * without an arrowhead is drawn as one path: the same rails, gauge, corner radius, ink and weight as
 * RoutePath draws them, in one element instead of three per track (the far element budget).
 */
function FarRails({ tracks }: { tracks: Record<string, Vec3[]> }) {
  let d = "";
  for (const [name, pts] of Object.entries(tracks)) {
    if (name === "trunk" || ARROWED.has(name) || pts.length < 2) continue;
    d += roundedPath(offsetPolyline(pts, 3).map(project), 5) + roundedPath(offsetPolyline(pts, -3).map(project), 5);
  }
  return <path aria-hidden="true" d={d} style={{ fill: "none", stroke: fc("route"), strokeWidth: factoryTokens.stroke.route * 0.8, strokeLinecap: "round", strokeLinejoin: "round" }} />;
}

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

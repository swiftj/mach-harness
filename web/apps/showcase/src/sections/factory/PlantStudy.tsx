import {
  AgentMarker,
  Branches,
  CellPlate,
  DependencyLink,
  FactoryScene,
  GateGlyph,
  GroundGrid,
  Packet,
  Prism,
  RegionPlate,
  RetryLoop,
  RoutePath,
  StationMachine,
  cellAnatomy,
  factoryTokens,
  pointAlong,
  project,
  type CellStage,
  type FactoryState,
  type Lod,
  type Vec3,
} from "@mach/ui";

/**
 * The whole plant at fit zoom, in the U composition of M6_0_VISUAL_SPEC.md b.2: the back row flows
 * along +x (intake, the construction floor of two columns of three bays, the review chamber); the
 * chamber drops along +y through the approval gatehouse to the integration yard, whose main line runs
 * back along the front of the plant to the archive corner. Static: one moment, six bays.
 */
const S = factoryTokens.size;
const GAP = 56;
const Z = factoryTokens.elevation.regionPlate;
const rows = 3;
const W = 48 + 2 * S.cell.x + S.aisle;
// 48 of margin plus a 40 pu lettering strip along the front edge, where the region name is painted.
const D = 48 + 40 + rows * S.cell.y + (rows - 1) * S.cellGap;
const intake = { x: 0, y: 0, w: 240, d: D };
const floor = { x: 240 + GAP, y: 0, w: W, d: D };
const review = { x: floor.x + W + GAP, y: 0, w: 220, d: 232 };
const human = { x: review.x + 40, y: review.y + review.d + GAP, w: 180, d: 180 };
const yardY = Math.max(D, human.y + human.d) + GAP;
const integration = { x: floor.x + 120, y: yardY, w: review.x + review.w - (floor.x + 120), d: 132 };
const archive = { x: integration.x - GAP - 200, y: yardY, w: 200, d: 132 };

interface BayPlan {
  ticket: string;
  stage: CellStage;
  lamp: number;
  build: FactoryState;
  verify: FactoryState;
  plan: FactoryState;
  progress: number;
  loop?: boolean;
}

const bays: BayPlan[] = [
  { ticket: "LOCAL-031", stage: "building", lamp: 1, plan: "succeeded", build: "active", verify: "idle", progress: 0.55, loop: true },
  { ticket: "LOCAL-032", stage: "verified", lamp: 0, plan: "succeeded", build: "succeeded", verify: "succeeded", progress: 1 },
  { ticket: "LOCAL-033", stage: "merged", lamp: 0, plan: "succeeded", build: "succeeded", verify: "succeeded", progress: 1 },
  { ticket: "LOCAL-034", stage: "building", lamp: 0.7, plan: "succeeded", build: "succeeded", verify: "active", progress: 0.4 },
  { ticket: "LOCAL-035", stage: "waiting-on-dependency", lamp: 0, plan: "idle", build: "idle", verify: "idle", progress: 0 },
];

function origin(i: number) {
  const col = Math.floor(i / rows);
  const row = i % rows;
  return { x: floor.x + 24 + col * (S.cell.x + S.aisle), y: 24 + row * (S.cell.y + S.cellGap) };
}

/** The extent the camera fits: every plate, plus 24 pu of ground. */
export const plantExtent = { x: -24, y: -24, w: review.x + review.w + 48, d: yardY + 132 + 48 };

export function PlantStudy({ lod = "far", label }: { lod?: Lod; label: string }) {
  const seats: Vec3[] = [
    { x: review.x + 110, y: 64, z: Z },
    { x: review.x + 126, y: 116, z: Z },
    { x: review.x + 110, y: 168, z: Z },
  ];
  const chamberEntry = { x: review.x + 30, y: 116, z: Z };
  const riserX = floor.x + W - 12;
  const toReview: Vec3[] = [
    { x: riserX, y: D - 12, z: Z },
    { x: riserX, y: 116, z: Z },
    chamberEntry,
  ];
  const colX = review.x + review.w - 30;
  const down: Vec3[] = [
    { x: review.x + 196, y: 116, z: Z },
    { x: colX, y: 116, z: Z },
    { x: colX, y: yardY + 50, z: Z },
  ];
  const trunk: Vec3[] = [
    { x: integration.x + integration.w - 20, y: yardY + 48, z: Z },
    { x: archive.x + 40, y: yardY + 48, z: Z },
  ];
  const packet = pointAlong(toReview, 0.62);
  const bridges = [
    { x: 240, y: D / 2 - 10, w: GAP, d: 20, z: 0, h: Z },
    { x: floor.x + W, y: 106, w: GAP, d: 20, z: 0, h: Z },
    { x: colX - 10, y: review.d, w: 20, d: GAP, z: 0, h: Z },
    { x: colX - 10, y: human.y + human.d, w: 20, d: yardY - (human.y + human.d), z: 0, h: Z },
    { x: archive.x + archive.w, y: yardY + 38, w: GAP, d: 20, z: 0, h: Z },
  ];
  const a0 = cellAnatomy(origin(0));
  const a4 = cellAnatomy(origin(4));
  const tl = project({ x: plantExtent.x, y: plantExtent.y + plantExtent.d, z: 0 });
  const tr = project({ x: plantExtent.x + plantExtent.w, y: plantExtent.y, z: 0 });
  const top = project({ x: plantExtent.x, y: plantExtent.y, z: 60 });
  const bottom = project({ x: plantExtent.x + plantExtent.w, y: plantExtent.y + plantExtent.d, z: 0 });
  const vb = `${Math.round(tl.x)} ${Math.round(top.y)} ${Math.round(tr.x - tl.x)} ${Math.round(bottom.y - top.y)}`;
  return (
    <FactoryScene label={label} viewBox={vb} className="h-auto w-full rounded-md border border-line">
      <GroundGrid x={plantExtent.x - 96} y={plantExtent.y - 96} w={plantExtent.w + 192} d={plantExtent.d + 192} lod={lod} fade={0.7} />
      <RegionPlate box={intake} kind="intake" caption="WAVE-007, 5 slices" lod={lod} />
      <RegionPlate box={archive} kind="archive" title="Archive" caption="1 archived" lod={lod} />
      <RegionPlate box={integration} kind="integration" caption="main" lod={lod} />
      <RegionPlate box={floor} kind="floor" caption="5 cells, 2 working" active lod={lod} />
      <RegionPlate box={review} kind="review" lod={lod} active />
      <RegionPlate box={human} kind="human" title="Approval" lod={lod} />
      {bridges.map((b, i) => (
        <Prism key={i} box={b} hatch="lit" />
      ))}
      <StationMachine kind="intake" state="succeeded" at={{ x: 70, y: D / 2, z: Z }} lod={lod} />
      <StationMachine kind="audit" state="succeeded" at={{ x: 170, y: D / 2 - 90, z: Z }} lod={lod} />
      <GateGlyph kind="audit" position="open" at={{ x: 226, y: D / 2, z: Z }} lod={lod} />
      <AgentMarker agentRole="scheduler" tier="haiku" state="idle" at={{ x: 70, y: D / 2 + 50, z: Z }} lod={lod} />
      <RoutePath points={[{ x: 110, y: D / 2, z: Z }, { x: floor.x + 12, y: D / 2, z: Z }]} lod={lod} />
      <RoutePath points={toReview} state="active" lod={lod} />
      <RoutePath points={down} lod={lod} />
      <RoutePath points={trunk} state="succeeded" lod={lod} arrow />
      {bays.map((b, i) => {
        const o = origin(i);
        const a = cellAnatomy(o);
        return (
          <CellPlate key={b.ticket} origin={o} ticket={b.ticket} stage={b.stage} lit={b.lamp > 0} lampIntensity={b.lamp} completion={b.stage === "merged" ? 1 : 0} progress={b.progress} lod={lod} dimmed={b.stage === "waiting-on-dependency"}>
            <StationMachine kind="plan" state={b.plan} at={a.pads.intent} lod={lod} />
            <StationMachine kind="build" state={b.build} progress={b.progress} round={b.loop ? 2 : undefined} at={a.pads.build} lod={lod} />
            <StationMachine kind="verify" state={b.verify} progress={b.progress} at={a.pads.verify} lod={lod} />
            {b.build === "active" ? <AgentMarker agentRole="builder" tier="sonnet" state="active" progress={b.progress} at={a.agentSpot("build")} lod={lod} /> : null}
            {b.verify === "active" ? <AgentMarker agentRole="verifier" tier="sonnet" state="active" progress={b.progress} at={a.agentSpot("verify")} lod={lod} /> : null}
          </CellPlate>
        );
      })}
      <RetryLoop from={{ ...a0.pads.verify, z: a0.floorZ + 18 }} to={{ ...a0.pads.build, z: a0.floorZ + 22 }} round={2} lift={30} lod={lod} />
      {bays.map((_, i) => {
        const a = cellAnatomy(origin(i));
        return <GateGlyph key={i} kind="verification" position={i === 1 || i === 2 ? "open" : "closed"} at={{ ...a.door, x: a.door.x + 10 }} lod={lod} />;
      })}
      <DependencyLink from={{ ...cellAnatomy(origin(2)).mast }} to={{ ...a4.mast }} state="blocking" lift={40} />
      <Branches origin={chamberEntry} targets={seats} mode="fan-out" progress={1} states={["active", "active", "active"]} />
      {(["architecture", "security", "product"] as const).map((seat, i) => (
        <AgentMarker key={seat} agentRole="reviewer" seat={seat} tier="opus" state="active" progress={0.5 + i * 0.15} at={{ ...seats[i]!, x: seats[i]!.x + 8 }} lod={lod} />
      ))}
      <GateGlyph kind="consensus" position="closed" lamps={["pass", "pending", "off"]} at={{ x: review.x + 196, y: 116, z: Z }} lod={lod} />
      <GateGlyph kind="human" position="waiting" at={{ x: colX, y: human.y + human.d / 2, z: Z }} axis="x" lod={lod} />
      <StationMachine kind="human-approval" state="human" at={{ x: human.x + 60, y: human.y + 70, z: Z }} lod={lod} />
      <GateGlyph kind="revalidation" position="open" at={{ x: colX, y: yardY + 40, z: Z }} axis="x" lod={lod} />
      <StationMachine kind="merge" state="succeeded" at={{ x: colX - 40, y: yardY + 48, z: Z }} lod={lod} />
      <StationMachine kind="cleanup" state="succeeded" at={{ x: archive.x + 50, y: yardY + 44, z: Z }} lod={lod} />
      <StationMachine kind="observe" state="idle" at={{ x: archive.x + 130, y: yardY + 50, z: Z }} lod={lod} />
      <Packet at={packet.point} angle={packet.angle} ticket="LOCAL-032" lod={lod} />
    </FactoryScene>
  );
}

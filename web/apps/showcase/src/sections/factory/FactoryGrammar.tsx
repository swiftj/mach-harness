import { useState } from "react";
import {
  AgentMarker,
  ArtifactCard,
  Branches,
  CellPlate,
  DependencyLink,
  Escalation,
  FactoryScene,
  FindingsFlag,
  BlueprintLane,
  BlueprintSheet,
  TimeRuler,
  blueprintSheetLayout,
  FloorLettering,
  PlanDimension,
  TaskBoard,
  type TaskCell,
  GateGlyph,
  GroundGrid,
  Heading,
  Packet,
  Prism,
  RegionPlate,
  RetryLoop,
  RoutePath,
  StateMark,
  StationMachine,
  Text,
  ToolTick,
  agentRoles,
  cellAnatomy,
  artifacts,
  cellStages,
  factoryStates,
  factoryTokens,
  gatePositions,
  gates,
  modelTiers,
  pointAlong,
  project,
  regions,
  stationOrder,
  stations,
  toolFamilies,
  type AgentRole,
  type ArtifactKind,
  type CellStage,
  type FactoryState,
  type GateKind,
  type GatePosition,
  type ModelTier,
  type RegionKind,
  type ToolFamily,
} from "@mach/ui";
import { Section } from "../../layout";
import { Group, RowOf, Scrub, Tile } from "./kit";
import { AtlasStudy, BlueprintStudy } from "./Studies";
import { PlantStudy } from "./PlantStudy";

const workStates: FactoryState[] = ["idle", "active", "succeeded", "failed", "waiting", "human", "blocked"];

export function FactoryGrammar() {
  return (
    <div className="flex flex-col gap-16">
      <header className="flex max-w-reading flex-col gap-3">
        <Heading level={1} size="display">
          Factory grammar
        </Heading>
        <Text size="body-lg" editorial tone="muted">
          The visual alphabet of the Living Factory: a plant drawing brought to life. Every primitive in every state, with sliders standing in for the
          playhead. The Atlas, the Blueprint and the shell are assembled from these and nothing else.
        </Text>
      </header>
      <Projection />
      <Studies />
      <Places />
      <Stations />
      <Agents />
      <Gates />
      <Artifacts />
      <Tools />
      <Connections />
      <Lettering />
      <States />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Projection() {
  const ox = project({ x: 96, y: 0, z: 0 });
  const oy = project({ x: 0, y: 96, z: 0 });
  const oz = project({ x: 0, y: 0, z: 60 });
  return (
    <Section
      id="factory-projection"
      title="Projection and light"
      intro="A 2:1 dimetric drawing. Work flows along plan x, down to the right; cells line up along plan y; elevation rises at 0.82. Light comes from the upper left: faces toward the viewer's left are lit, faces toward the right are in shade and carry section hatching. Shadows fall to the right, as long as the thing is tall."
    >
      <Group title="The ground, the axes and one block" note="The grid is drafted, minor every 24 plan units and major every 96 with registration crosses, and fades toward its edges so the plant sits in a pool of drawing.">
        <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-6">
          <FactoryScene label="Ground grid with the three axes and one block showing its lit face, shaded face and contact shadow" viewBox="-230 -110 460 260" className="h-auto w-full rounded-xs border border-line">
            <GroundGrid x={-192} y={-192} w={384} d={384} />
            <Prism box={{ x: 24, y: 24, w: 72, d: 48, z: 0, h: 36 }} />
            <g style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 1.2, fill: "none" }} aria-hidden="true">
              <line x1={0} y1={0} x2={ox.x} y2={ox.y} />
              <line x1={0} y1={0} x2={oy.x} y2={oy.y} />
              <line x1={0} y1={0} x2={oz.x} y2={oz.y} />
            </g>
            <g style={{ fill: "var(--mach-ink)", fontSize: 11, fontWeight: 600 }}>
              <text x={ox.x + 6} y={ox.y + 4}>
                x, the flow
              </text>
              <text x={oy.x - 6} y={oy.y + 4} textAnchor="end">
                y, across the floor
              </text>
              <text x={oz.x + 6} y={oz.y}>
                z, elevation
              </text>
            </g>
          </FactoryScene>
          <dl className="m-0 flex flex-col text-body-sm">
            {[
              ["Angle", `${factoryTokens.projection.angleDeg} degrees (2:1)`],
              ["screen x", "(x − y) × 0.894"],
              ["screen y", "(x + y) × 0.447 − z × 0.82"],
              ["Grid", "24 minor, 96 major"],
              ["Region plate", "8 high"],
              ["Cell", "216 × 132, rim 14"],
              ["Station pad", "36 square, 10 to 30 high"],
              ["Shadow", "height × (0.5, −0.18) on the plan"],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-[110px_1fr] gap-2 border-b border-line py-1.5 last:border-b-0">
                <dt className="text-ink-muted">{k}</dt>
                <dd className="m-0 font-mono text-mono text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Studies() {
  const [t, setT] = useState(0.62);
  return (
    <Section
      id="factory-studies"
      title="Composition studies"
      intro="One cell, drawn both ways from the same primitives. The Atlas shows it as a place where work happens; the Blueprint shows the same run as a precise drawing of what happened, in order. The slider stands in for the playhead in both."
    >
      <figure id="factory-plant-fit" className="m-0 flex flex-col gap-2">
        <PlantStudy lod="far" label="The whole plant at fit zoom: intake, two columns of bays, the review chamber, approval, integration and the archive in a U" />
        <figcaption className="text-caption text-ink-muted">
          The plant at fit zoom, far level. The U: the back row flows from intake across the floor to the review chamber; the chamber drops through
          approval to the integration yard, whose main line runs back along the front to the archive. Framed to its projected bounds.
        </figcaption>
      </figure>
      <Scrub label="Playhead" value={t} onChange={setT} hint="The cell's second round: build, verify, the verdict gate, the panel fanning out, the votes." />
      <AtlasStudy t={t} />
      <BlueprintStudy t={t} />
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Places() {
  const [done, setDone] = useState(0.7);
  const [lamp, setLamp] = useState(1);
  const regionKinds = Object.keys(regions) as RegionKind[];
  const stages: CellStage[] = ["building", "verified", "awaiting-human", "blocked"];
  return (
    <Section
      id="factory-places"
      title="Regions and cells"
      intro="A region is a low plinth with a drafted rim and its name lettered on the floor in bold, running with the flow. A cell is an architectural section model of a bay: two back walls standing, the two front walls cut at curb height with poché on the cut, so the work inside is always seen."
    >
      <Group title="Production regions" note="Six regions, in belt order. The live rule along the front edge marks a region where something is working.">
        <div className="grid grid-cols-3 gap-4">
          {regionKinds.map((k, i) => (
            <Tile key={k} caption={regions[k].label} detail={regions[k].description} label={`${regions[k].label} region plate`} viewBox="-132 -16 316 166" width={330} height={174}>
              <RegionPlate box={{ x: 0, y: 0, w: 192, d: 132 }} kind={k} active={i === 1} caption={i === 1 ? "3 cells" : undefined} />
            </Tile>
          ))}
        </div>
      </Group>
      <Group
        title="Cells by stage"
        note="The mast at the back corner carries the stage mark. The lamp is on while any station in the cell works. A completed cell takes the passed wash on its floor."
        tools={
          <div className="flex flex-wrap gap-3">
            <Scrub label="Lamp" value={lamp} onChange={setLamp} hint="lampIntensity, stateChange 260 ms" />
            <Scrub label="Cell complete" value={done} onChange={setDone} hint="cellComplete, 900 ms, settle" />
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          {stages.map((s) => (
            <Tile key={s} caption={cellStages[s].label} detail={`Stage ${s}`} label={`Cell at stage ${s}`} viewBox="-146 -46 352 226" width={480} height={308}>
              <CellPlate origin={{ x: 0, y: 0 }} ticket="TCK-112" slice="SLICE-007" stage={s} lampIntensity={s === "building" ? lamp : 0} elapsed={s === "building" ? 6 * 60000 + 40000 : undefined} lod="near">
                <Bay stage={s} />
              </CellPlate>
            </Tile>
          ))}
          <Tile caption="Merged" detail="Calm done floor, settled machines, double ring" label="Merged cell" viewBox="-146 -46 352 226" width={480} height={308}>
            <CellPlate origin={{ x: 0, y: 0 }} ticket="TCK-109" stage="merged" completion={done} lod="near">
              <Bay stage="merged" />
            </CellPlate>
          </Tile>
          <Tile caption="Waiting on a dependency" detail="Scheduler state: no cell work yet" label="Cell waiting on a dependency" viewBox="-146 -46 352 226" width={480} height={308}>
            <CellPlate origin={{ x: 0, y: 0 }} ticket="TCK-113" stage="waiting-on-dependency" lod="near" dimmed>
              <Bay stage="waiting-on-dependency" />
            </CellPlate>
          </Tile>
        </div>
      </Group>
      <Group title="Semantic zoom" note="Far: plates, IDs and stage marks only, larger. Mid: machines and agents, no words. Near: every label, sleepers on the rails, slice IDs on the floor.">
        <div className="grid grid-cols-3 gap-4">
          {(["far", "mid", "near"] as const).map((lod) => (
            <Tile key={lod} caption={lod === "far" ? "Far, below 0.6" : lod === "mid" ? "Mid, 0.6 to 1.4" : "Near, above 1.4"} label={`Cell at ${lod} zoom`} viewBox="-146 -46 352 226" width={330} height={212}>
              <CellPlate origin={{ x: 0, y: 0 }} ticket="TCK-112" slice="SLICE-007" stage="building" lit lod={lod} elapsed={(0.6) * 12 * 60000}>
                <StationMachine kind="build" state="active" elapsed={(0.6) * 12 * 60000} at={{ x: 110, y: 58, z: 12 }} lod={lod} />
                <AgentMarker agentRole="builder" tier="sonnet" state="active" elapsed={(0.6) * 12 * 60000} at={{ x: 100, y: 92, z: 12 }} lod={lod} />
              </CellPlate>
            </Tile>
          ))}
        </div>
      </Group>
    </Section>
  );
}

/** A cell's three machines and its working agent, in states that follow the stage. */
function Bay({ stage }: { stage: CellStage }) {
  const a = cellAnatomy({ x: 0, y: 0 });
  const done = (["verified", "awaiting-human", "approved", "merged"] as CellStage[]).includes(stage);
  const build: FactoryState = stage === "building" ? "active" : done || stage === "blocked" ? "succeeded" : "idle";
  const verify: FactoryState = done ? "succeeded" : stage === "blocked" ? "failed" : "idle";
  const plan: FactoryState = stage === "waiting-on-dependency" ? "idle" : "succeeded";
  return (
    <>
      <StationMachine kind="plan" state={plan} at={a.pads.intent} settled={stage === "merged"} />
      <StationMachine kind="build" state={build} elapsed={6 * 60000} at={a.pads.build} settled={stage === "merged"} />
      <StationMachine kind="verify" state={verify} round={stage === "blocked" ? 3 : undefined} at={a.pads.verify} settled={stage === "merged"} />
      {stage === "building" ? <AgentMarker agentRole="builder" tier="sonnet" state="active" elapsed={6 * 60000} at={a.agentSpot("build")} /> : null}
      {stage === "blocked" ? <AgentMarker agentRole="verifier" tier="sonnet" state="blocked" at={a.agentSpot("verify")} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Stations() {
  const [p, setP] = useState(0.45);
  const elapsed = p * 15 * 60000;
  const shown: FactoryState[] = ["idle", "active", "succeeded", "failed"];
  return (
    <Section
      id="factory-stations"
      title="Stations"
      intro="Each station kind has one drafted symbol. In the Atlas it is inscribed on the top face of the machine; while it works a live ring stands around it with one tick per minute of elapsed work, because nobody knows how long work in flight will take. Only a measured fraction fills the ring. In the Blueprint the same symbol sits in a process bubble, after the instrument bubbles of a piping drawing."
    >
      <Scrub label="Elapsed" value={p} onChange={setP} hint={`${Math.round(p * 15)} of 15 minutes of work: one tick per minute, never a fill`} />
      <Group title="Every station, in belt order">
        <div className="flex flex-col">
          {stationOrder.map((k) => (
            <RowOf
              key={k}
              title={
                <span className="flex flex-col">
                  {stations[k].label}
                  <span className="font-mono text-mono font-normal text-ink-muted">{stations[k].skill}</span>
                </span>
              }
            >
              {shown.map((s) => (
                <Tile key={s} caption={factoryStates[s].label} label={`${stations[k].label} machine, ${factoryStates[s].label}`} viewBox="-44 -50 88 74" width={112} height={94}>
                  <StationMachine kind={k} state={s} elapsed={elapsed} fraction={k === "verify" && s === "active" ? { done: 5, of: 8 } : undefined} at={{ x: 0, y: 0, z: 0 }} round={s === "failed" && k === "verify" ? 2 : undefined} />
                </Tile>
              ))}
              <Tile caption="Settled" detail="Finished, at rest" label={`${stations[k].label} machine, settled`} viewBox="-44 -50 88 74" width={112} height={94}>
                <StationMachine kind={k} state="succeeded" settled at={{ x: 0, y: 0, z: 0 }} />
              </Tile>
              {shown.map((s) => (
                <Tile key={`b${s}`} caption={factoryStates[s].label} detail="Blueprint" label={`${stations[k].label} process symbol, ${factoryStates[s].label}`} viewBox="-30 -26 60 60" width={76} height={76}>
                  <StationMachine kind={k} state={s} elapsed={elapsed} fraction={k === "verify" && s === "active" ? { done: 5, of: 8 } : undefined} at={{ x: 0, y: 0 }} variant="blueprint" showLabel={false} round={s === "failed" && k === "verify" ? 2 : undefined} />
                </Tile>
              ))}
              <Tile caption="Unbuilt" detail="Blueprint, not reached" label={`${stations[k].label} process symbol, not reached yet`} viewBox="-30 -26 60 60" width={76} height={76}>
                <StationMachine kind={k} state="idle" planned at={{ x: 0, y: 0 }} variant="blueprint" showLabel={false} />
              </Tile>
            </RowOf>
          ))}
        </div>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Agents() {
  const [arrive, setArrive] = useState(1);
  const [work, setWork] = useState(0.45);
  const elapsed = work * 15 * 60000;
  const roles: AgentRole[] = ["scheduler", "supervisor", "clerk", "intent", "contract-engineer", "builder", "verifier", "reviewer", "audit", "merge", "cleanup", "observe"];
  const tiers: ModelTier[] = ["fable", "opus", "sonnet", "haiku"];
  return (
    <Section
      id="factory-agents"
      title="Agents"
      intro="An agent is a standing figure. Its head's shape and its height are its model tier: Fable a diamond, Opus a square, Sonnet a circle, Haiku a triangle, heavier models standing taller. Its role is the emblem on its floor disc. While it works its head is lit and ringed, with one tick per minute it has worked."
    >
      <div className="flex flex-wrap gap-3">
        <Scrub label="Arrival" value={arrive} onChange={setArrive} hint="agentArrive, 480 ms, settle" />
        <Scrub label="Elapsed" value={work} onChange={setWork} hint={`${Math.round(work * 15)} min: one tick per minute`} />
      </div>
      <Group title="Tiers and roles">
        <RowOf title="Tier">
          {tiers.map((t) => (
            <Tile key={t} caption={modelTiers[t].label} detail={`${modelTiers[t].head}, ${modelTiers[t].height} high`} label={`${modelTiers[t].label} agent`} viewBox="-30 -46 60 58" width={96} height={92} grid>
              <AgentMarker agentRole="builder" tier={t} state="active" elapsed={elapsed} arrive={arrive} at={{ x: 0, y: 0, z: 0 }} />
            </Tile>
          ))}
        </RowOf>
        <RowOf title="Role">
          {roles.map((r) => (
            <Tile key={r} caption={agentRoles[r].label} label={`${agentRoles[r].label} agent`} viewBox="-30 -46 60 58" width={96} height={92} grid>
              <AgentMarker agentRole={r} tier={r === "reviewer" || r === "contract-engineer" ? "opus" : r === "scheduler" ? "haiku" : "sonnet"} seat={r === "reviewer" ? "security" : undefined} state="idle" arrive={arrive} at={{ x: 0, y: 0, z: 0 }} />
            </Tile>
          ))}
        </RowOf>
        <RowOf title="State">
          {workStates.map((s) => (
            <Tile key={s} caption={factoryStates[s].label} label={`Agent, ${factoryStates[s].label}`} viewBox="-30 -46 60 58" width={96} height={92} grid>
              <AgentMarker agentRole="verifier" tier="sonnet" state={s} elapsed={elapsed} arrive={arrive} at={{ x: 0, y: 0, z: 0 }} />
            </Tile>
          ))}
        </RowOf>
        <RowOf title="Blueprint">
          {tiers.map((t) => (
            <Tile key={t} caption={modelTiers[t].label} label={`${modelTiers[t].label} agent in the Blueprint`} viewBox="-20 -18 190 34" width={230} height={42}>
              <AgentMarker agentRole="reviewer" seat="architecture" tier={t} state="active" elapsed={elapsed} arrive={arrive} at={{ x: 0, y: 0 }} variant="blueprint" showLabel />
            </Tile>
          ))}
        </RowOf>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Gates() {
  const [p, setP] = useState(1);
  const kinds = Object.keys(gates) as GateKind[];
  const positions: GatePosition[] = ["closed", "open", "refusing", "waiting"];
  const lampsFor = (k: GateKind, pos: GatePosition) =>
    k === "consensus" ? (pos === "open" ? ["pass", "pass", "pass"] : pos === "refusing" ? ["pass", "fail", "pass"] : ["pass", "pending", "off"]) : k === "red-green" ? (pos === "open" ? ["fail", "pass"] : ["fail", "off"]) : undefined;
  return (
    <Section
      id="factory-gates"
      title="Gates"
      intro="A gate is a portal frame across the route: two posts, a lintel with the gate's plaque and lamps, and a barrier arm. Open raises the arm; closed lowers it; refusing drops it shut with one damped overshoot; waiting holds it for a person. The arm's angle, not its colour, says which."
    >
      <Scrub label="Transition" value={p} onChange={setP} hint="gateOpen 520 ms settle · gateClose 420 ms · gateRefuse 640 ms refuse curve" />
      <Group title="Every gate, every position">
        {kinds.map((k) => (
          <RowOf key={k} title={gates[k].label}>
            {positions
              .filter((pos) => pos !== "waiting" || k === "human")
              .map((pos) => (
                <Tile key={pos} caption={gatePositions[pos].label} label={`${gates[k].label}, ${gatePositions[pos].label}`} viewBox="-44 -66 92 84" width={116} height={106} grid>
                  <GateGlyph kind={k} position={pos} from={pos === "open" ? "closed" : "open"} progress={p} at={{ x: 0, y: 0, z: 0 }} lamps={lampsFor(k, pos) as never} />
                </Tile>
              ))}
            {positions
              .filter((pos) => pos !== "waiting" || k === "human")
              .map((pos) => (
                <Tile key={`b${pos}`} caption={gatePositions[pos].label} detail="Blueprint" label={`${gates[k].label} in the Blueprint, ${gatePositions[pos].label}`} viewBox="-30 -30 60 62" width={76} height={78}>
                  <GateGlyph kind={k} position={pos} at={{ x: 0, y: 0 }} variant="blueprint" showLabel={false} lamps={lampsFor(k, pos) as never} />
                </Tile>
              ))}
          </RowOf>
        ))}
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Artifacts() {
  const [p, setP] = useState(1);
  const kinds = Object.keys(artifacts) as ArtifactKind[];
  return (
    <Section
      id="factory-artifacts"
      title="Artifacts"
      intro="An artifact is a sheet standing on the floor with a folded corner and its kind's mark. It materialises by rising out of the floor as its mark draws; it is handed off by riding a dotted handoff route. The file name is its label."
    >
      <Scrub label="Materialise" value={p} onChange={setP} hint="artifactMaterialise, 520 ms, settle" />
      <Group title="Every artifact kind">
        <div className="grid grid-cols-6 gap-4">
          {kinds.map((k) => (
            <Tile key={k} caption={artifacts[k].label} detail={artifacts[k].file} label={`${artifacts[k].label} artifact`} viewBox="-22 -26 44 36" width={110} height={90} grid>
              <ArtifactCard kind={k} progress={p} state={k === "findings" ? "failed" : "succeeded"} at={{ x: 0, y: 0, z: 0 }} />
            </Tile>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-6 gap-4 border-t border-line pt-5">
          {kinds.map((k) => (
            <Tile key={k} caption={artifacts[k].label} detail="Blueprint" label={`${artifacts[k].label} artifact in the Blueprint`} viewBox="-14 -14 28 28" width={56} height={56}>
              <ArtifactCard kind={k} progress={p} state={k === "findings" ? "failed" : "succeeded"} at={{ x: 0, y: 0 }} variant="blueprint" showLabel={false} />
            </Tile>
          ))}
        </div>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Tools() {
  const [p, setP] = useState(1);
  const families = Object.keys(toolFamilies) as ToolFamily[];
  const run: Array<[ToolFamily, FactoryState]> = [
    ["read", "succeeded"],
    ["read", "succeeded"],
    ["search", "succeeded"],
    ["write", "succeeded"],
    ["test", "failed"],
    ["write", "succeeded"],
    ["run", "succeeded"],
    ["test", "succeeded"],
    ["git", "succeeded"],
    ["read", "succeeded"],
    ["write", "succeeded"],
    ["test", "active"],
  ];
  return (
    <Section
      id="factory-tools"
      title="Tool calls"
      intro="A tool call is a tick on the cell's ticker strip: a short stem with its family's cap. Ticks accumulate in time order along the front of the cell floor, like a recorder trace, so a burst of activity reads as density, never as flashing."
    >
      <Scrub label="Tick" value={p} onChange={setP} hint="toolTick, 240 ms, settle" />
      <Group title="Families and states">
        <RowOf title="Family">
          {families.map((f) => (
            <Tile key={f} caption={toolFamilies[f].label} detail={toolFamilies[f].examples} label={`${toolFamilies[f].label} tool call`} viewBox="-16 -22 32 28" width={96} height={84}>
              <ToolTick family={f} progress={p} at={{ x: 0, y: 0 }} variant="blueprint" />
            </Tile>
          ))}
        </RowOf>
        <RowOf title="State">
          {(["idle", "active", "succeeded", "failed"] as FactoryState[]).map((s) => (
            <Tile key={s} caption={factoryStates[s].label} label={`Test tool call, ${factoryStates[s].label}`} viewBox="-16 -22 32 28" width={96} height={84}>
              <ToolTick family="test" state={s} progress={p} at={{ x: 0, y: 0 }} variant="blueprint" />
            </Tile>
          ))}
        </RowOf>
        <RowOf title="Ticker">
          <Tile caption="A builder's run on the ticker" detail="Twelve calls; the last still running" label="Ticker with twelve tool calls" viewBox="-20 -30 280 44" width={560} height={88}>
            <line x1={0} y1={0} x2={250} y2={0} aria-hidden="true" style={{ stroke: "var(--mach-factory-grid-major)", strokeDasharray: "2 3" }} />
            {run.map(([f, s], i) => (
              <ToolTick key={i} family={f} state={s} progress={i === run.length - 1 ? p : 1} at={{ x: 8 + i * 20, y: 0 }} variant="blueprint" />
            ))}
          </Tile>
        </RowOf>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Connections() {
  const [draw, setDraw] = useState(0.8);
  const [travel, setTravel] = useState(0.4);
  const [unlock, setUnlock] = useState(0.5);
  const route = [
    { x: -60, y: 30, z: 0 },
    { x: 40, y: 30, z: 0 },
    { x: 40, y: -50, z: 0 },
    { x: 120, y: -50, z: 0 },
  ];
  const at = pointAlong(route, travel);
  const seats = [
    { x: 30, y: -44, z: 0 },
    { x: 42, y: 0, z: 0 },
    { x: 30, y: 44, z: 0 },
  ];
  return (
    <Section
      id="factory-connections"
      title="Routes, loops and links"
      intro="Routes are conveyor track; a handoff is dotted; a retry is a dashed arc lifted off the floor in the fail ink with the round count at its crest; a fan-out splays from one door to many seats and joins back; a dependency is an overhead cable with a padlock; an escalation is the only thing that rises straight up."
    >
      <div className="flex flex-wrap gap-3">
        <Scrub label="Draw" value={draw} onChange={setDraw} hint="pathDraw 600 ms · fanOut 700 ms · verifyReturn 1600 ms" />
        <Scrub label="Packet" value={travel} onChange={setTravel} hint="packetTravel 1400 ms, travel" />
        <Scrub label="Unlock" value={unlock} onChange={setUnlock} hint="dependencyUnlock 800 ms" />
      </div>
      <Group title="Atlas">
        <div className="grid grid-cols-3 gap-4">
          <Tile caption="Route, idle and live" detail="Rails 6 apart, chevrons every 48" label="Two routes, one idle, one live, with a packet" viewBox="-110 -60 220 140" width={330} height={210} grid>
            <RoutePath points={route.map((p) => ({ ...p, y: p.y + 40 }))} progress={draw} lod="near" />
            <RoutePath points={route} state="active" progress={draw} arrow />
            <Packet at={at.point} angle={at.angle} ticket="TCK-112" lod="near" />
          </Tile>
          <Tile caption="Retry loop, round 2 of 3" detail="Verify back to build" label="Retry loop from verify back to build, round 2 of 3" viewBox="-110 -80 220 140" width={330} height={210} grid>
            <StationMachine kind="build" state="idle" at={{ x: -30, y: 0, z: 0 }} />
            <StationMachine kind="verify" state="failed" at={{ x: 60, y: 0, z: 0 }} />
            <RetryLoop from={{ x: 60, y: 0, z: 18 }} to={{ x: -30, y: 0, z: 22 }} round={2} progress={draw} lod="near" />
          </Tile>
          <Tile caption="Fan-out and join" detail="Three seats; votes converge" label="Reviewer fan-out to three seats and join" viewBox="-100 -70 200 130" width={330} height={210} grid>
            <Branches origin={{ x: -70, y: 0, z: 0 }} targets={seats} mode="fan-out" progress={[draw, Math.max(0, draw - 0.1), Math.max(0, draw - 0.2)]} states={["active", "active", "active"]} />
            <Branches origin={{ x: 120, y: 0, z: 0 }} targets={seats} mode="join" progress={draw} states={["succeeded", "failed", "succeeded"]} />
          </Tile>
          <Tile caption="Dependency, blocking then satisfied" detail="Cable lifted 46, padlock at the crest" label="Dependency link unlocking" viewBox="-110 -80 220 150" width={330} height={225} grid>
            <Prism box={{ x: -80, y: -10, w: 36, d: 36, z: 0, h: 10 }} />
            <Prism box={{ x: 40, y: 20, w: 36, d: 36, z: 0, h: 10 }} top="wait-soft" />
            <DependencyLink from={{ x: -62, y: 8, z: 10 }} to={{ x: 58, y: 38, z: 10 }} state="satisfied" progress={unlock} />
          </Tile>
          <Tile caption="Escalation" detail="The only vertical" label="Escalation riser to a person" viewBox="-110 -110 220 150" width={330} height={225} grid>
            <StationMachine kind="review" state="blocked" at={{ x: 0, y: 0, z: 0 }} />
            <Escalation from={{ x: 0, y: 0, z: 14 }} height={70} progress={draw} label="Escalated" />
          </Tile>
          <Tile caption="Handoff" detail="An artifact carried between stations" label="Artifact handoff along a dotted route" viewBox="-110 -60 220 140" width={330} height={210} grid>
            <RoutePath kind="handoff" points={[{ x: -60, y: 0, z: 0 }, { x: 80, y: 0, z: 0 }]} progress={1} arrow />
            {(() => {
              const h = pointAlong([{ x: -60, y: 0, z: 0 }, { x: 80, y: 0, z: 0 }], travel);
              return <ArtifactCard kind="build-report" at={h.point} />;
            })()}
          </Tile>
        </div>
      </Group>
      <Group title="Blueprint">
        <FactoryScene label="Blueprint connections" viewBox="0 0 1000 170" className="h-auto w-full rounded-xs border border-line">
          <RoutePath variant="blueprint" points={[{ x: 30, y: 90 }, { x: 160, y: 90 }]} state="succeeded" progress={1} />
          <RoutePath variant="blueprint" points={[{ x: 30, y: 130 }, { x: 160, y: 130 }]} state="active" progress={draw} />
          <Packet variant="blueprint" at={{ x: 30 + 130 * travel, y: 130 }} />
          <StationMachine variant="blueprint" kind="build" state="succeeded" at={{ x: 230, y: 110 }} showLabel={false} />
          <StationMachine variant="blueprint" kind="verify" state="failed" round={2} at={{ x: 330, y: 110 }} showLabel={false} />
          <RetryLoop variant="blueprint" from={{ x: 330, y: 92 }} to={{ x: 230, y: 92 }} round={2} progress={draw} lift={46} />
          <Branches variant="blueprint" origin={{ x: 420, y: 100 }} targets={[{ x: 520, y: 60 }, { x: 520, y: 100 }, { x: 520, y: 140 }]} mode="fan-out" progress={draw} states={["succeeded", "failed", "active"]} />
          <Branches variant="blueprint" origin={{ x: 620, y: 100 }} targets={[{ x: 530, y: 60 }, { x: 530, y: 100 }, { x: 530, y: 140 }]} mode="join" progress={draw} states={["succeeded", "failed", "succeeded"]} />
          <DependencyLink variant="blueprint" from={{ x: 680, y: 40 }} to={{ x: 800, y: 130 }} state="satisfied" progress={unlock} />
          <Escalation variant="blueprint" from={{ x: 880, y: 150 }} height={90} progress={draw} label="Escalated" />
        </FactoryScene>
      </Group>
      <Group title="Blueprint furniture" note="The time ruler; unbuilt nodes and routes, at full contrast with dashed lines; dependencies sharing a gutter channel; deep lanes with their disclosure chevrons; and a sheet whose title block has its own strip.">
        <FactoryScene label="Blueprint furniture" viewBox="0 0 1000 300" className="h-auto w-full rounded-xs border border-line">
          <TimeRuler x={190} y={34} width={780} from={0} to={46 * 60000} playhead={draw * 46 * 60000} />
          <BlueprintLane x={10} y={56} width={980} height={230} depth={1} title="Invite a teammate" id="TCK-112" state="active" expanded>
            <BlueprintLane x={10} y={140} width={980} height={40} depth={2} title="Agents" expanded />
            <BlueprintLane x={10} y={180} width={980} height={36} depth={3} title="Builder" expanded />
            <BlueprintLane x={10} y={216} width={980} height={34} depth={4} title="Tool calls" expanded />
            <BlueprintLane x={10} y={250} width={980} height={34} depth={5} title="Artifacts" collapsed summary="9 files" />
          </BlueprintLane>
          <StationMachine variant="blueprint" kind="build" state="succeeded" at={{ x: 240, y: 98 }} showLabel={false} />
          <RoutePath variant="blueprint" points={[{ x: 257, y: 98 }, { x: 323, y: 98 }]} state="succeeded" />
          <StationMachine variant="blueprint" kind="verify" state="active" elapsed={7 * 60000} fraction={{ done: 5, of: 8 }} at={{ x: 340, y: 98 }} showLabel={false} />
          <RoutePath variant="blueprint" points={[{ x: 357, y: 98 }, { x: 423, y: 98 }]} planned />
          <GateGlyph variant="blueprint" kind="verification" position="closed" planned at={{ x: 440, y: 98 }} showLabel={false} />
          <RoutePath variant="blueprint" points={[{ x: 456, y: 98 }, { x: 523, y: 98 }]} planned />
          <GateGlyph variant="blueprint" kind="plan-check" position="open" at={{ x: 560, y: 98 }} showLabel={false} />
          <StationMachine variant="blueprint" kind="review" state="idle" planned at={{ x: 620, y: 98 }} showLabel={false} />
          <DependencyLink variant="blueprint" from={{ x: 700, y: 78 }} to={{ x: 940, y: 200 }} state="blocking" channelX={900} />
          <DependencyLink variant="blueprint" from={{ x: 700, y: 118 }} to={{ x: 940, y: 240 }} state="satisfied" progress={unlock} channelX={906} />
        </FactoryScene>
        <FactoryScene label="Blueprint sheet with its title block in a strip" viewBox="0 0 1000 220" className="h-auto w-full rounded-xs border border-line">
          <BlueprintSheet width={1000} height={220} title="Execution blueprint" subtitle="Title block in its own strip" simulationLabel="Simulation" zonesX={10} zonesY={2} titleBlock="strip" facts={[["Cell", "TCK-112"]]}>
            {(() => {
              const c = blueprintSheetLayout(1000, 220, 1, "strip").content;
              return <rect x={c.x + 8} y={c.y + 8} width={c.w - 16} height={c.h - 16} aria-hidden="true" style={{ fill: "none", stroke: "var(--mach-factory-plate-edge)", strokeDasharray: "4 4" }} />;
            })()}
          </BlueprintSheet>
        </FactoryScene>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Lettering() {
  const a = cellAnatomy({ x: 0, y: 0 });
  const tasks: TaskCell[] = ["green", "green", "green", "red", "green", "active", "pending", "pending", "pending", "overridden", "pending", "pending"];
  return (
    <Section
      id="factory-lettering"
      title="Lettering, dimensions and marks"
      intro="Words belong on the plant where a draughtsman would put them: a maker's plate on a machine's face, a word painted on the floor beside a gate, a name under a figure, a dimension along a bay. Two marks stand beside the machines: the findings flag and the red/green task board."
    >
      <Group title="Label placements" note="Name plates show at mid and near zoom on machines at least 10 high. Floor lettering at a gate runs along its span on the downstream side. Agent labels can sit under the floor disc when the space beside the head is taken.">
        <div className="grid grid-cols-2 gap-4">
          <Tile caption="Name plates and an agent labelled below" detail="nameplate · labelPosition below" label="Cell with name plates on its machines and an agent labelled below its disc" viewBox="-146 -46 352 226" width={480} height={308}>
            <CellPlate origin={{ x: 0, y: 0 }} ticket="LOCAL-031" slice="SLICE-021" stage="building" lit elapsed={(0.55) * 12 * 60000} lod="mid">
              <StationMachine kind="plan" label="Plan" state="succeeded" nameplate at={a.pads.intent} />
              <StationMachine kind="build" state="active" elapsed={(0.55) * 12 * 60000} nameplate at={a.pads.build} />
              <StationMachine kind="verify" state="idle" nameplate at={a.pads.verify} />
              <TaskBoard tasks={tasks} at={{ x: 70, y: 28, z: a.floorZ }} columns={6} />
              <AgentMarker agentRole="builder" tier="sonnet" state="active" elapsed={(0.55) * 12 * 60000} at={a.agentSpot("build")} labelPosition="below" showLabel />
            </CellPlate>
            <GateGlyph kind="verification" position="closed" at={{ ...a.door, x: a.door.x + 10 }} floorLabel="Verdict" />
          </Tile>
          <Tile caption="Floor lettering and a plan dimension" detail="FloorLettering · PlanDimension" label="Plate with floor lettering and a dimension along a bay" viewBox="-146 -46 352 226" width={480} height={308}>
            <RegionPlate box={{ x: 0, y: 0, w: 216, d: 148 }} kind="floor" title="Bay 4" caption="Reserved" lod="near">
              <rect x={24} y={24} width={168} height={70} style={{ fill: "none", stroke: "var(--mach-factory-plate-edge)", strokeDasharray: "5 4" }} aria-hidden="true" />
            </RegionPlate>
            <FloorLettering at={{ x: 30, y: 52, z: 8 }} text="SLICE-024 waits on a dependency" font="sans" size={9} tone="wait" weight={600} />
            <FloorLettering at={{ x: 30, y: 66, z: 8 }} text="LOCAL-035" font="mono" size={10} />
            <FloorLettering at={{ x: 206, y: 130, z: 8 }} text="Aisle" axis="y" size={8} tone="subtle" />
            <PlanDimension from={{ x: 24, y: 24, z: 8 }} to={{ x: 192, y: 24, z: 8 }} offset={10} label="168 pu" />
          </Tile>
        </div>
      </Group>
      <Group title="Findings flags" note="A blocker is a solid pennant with a bar; a note an outlined pennant. The count sits on the pennant; the cited rule is lettered at near zoom.">
        <div className="flex flex-wrap gap-4">
          <Tile caption="Blocker" detail="severity blocker, rule INV-02" label="Blocking finding flag" viewBox="-30 -40 90 50" width={150} height={84} grid>
            <FindingsFlag at={{ x: 0, y: 0, z: 0 }} severity="blocker" rule="INV-02" lod="near" />
          </Tile>
          <Tile caption="Three blockers" detail="count 3" label="Flag for three blocking findings" viewBox="-30 -40 90 50" width={150} height={84} grid>
            <FindingsFlag at={{ x: 0, y: 0, z: 0 }} severity="blocker" count={3} rule="FR-04" lod="near" />
          </Tile>
          <Tile caption="Note" detail="severity note" label="Non-blocking note flag" viewBox="-30 -40 90 50" width={150} height={84} grid>
            <FindingsFlag at={{ x: 0, y: 0, z: 0 }} severity="note" lod="near" />
          </Tile>
          <Tile caption="Blueprint" detail="variant blueprint" label="Findings flag in the Blueprint" viewBox="-10 -24 80 30" width={150} height={56}>
            <FindingsFlag at={{ x: 0, y: 0 }} severity="blocker" count={2} rule="AC-03" variant="blueprint" />
          </Tile>
        </div>
      </Group>
      <Group title="Red/green task board" note="One cell per plan task: pending dashed, active outlined live, red half filled (its test was seen failing), green full, overridden slashed. At far zoom the board is a single plate, filled when every task is green.">
        <div className="flex flex-wrap gap-4">
          <Tile caption="Atlas" detail="Upright beside the build machine" label="Task board standing on the floor" viewBox="-30 -46 90 56" width={170} height={106} grid>
            <TaskBoard tasks={tasks} at={{ x: -10, y: 0, z: 0 }} columns={6} />
          </Tile>
          <Tile caption="Atlas, all green" detail="Far zoom" label="Task board, all green, far zoom" viewBox="-30 -46 90 56" width={170} height={106} grid>
            <TaskBoard tasks={tasks.map(() => "green")} at={{ x: -10, y: 0, z: 0 }} columns={6} lod="far" />
          </Tile>
          <Tile caption="Blueprint" detail="A flat strip under the build node" label="Task board in the Blueprint" viewBox="-6 -6 92 26" width={230} height={66}>
            <TaskBoard tasks={tasks} at={{ x: 0, y: 0 }} columns={12} variant="blueprint" />
          </Tile>
        </div>
      </Group>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function States() {
  const stageList = Object.keys(cellStages) as CellStage[];
  return (
    <Section
      id="factory-states"
      title="Lifecycle states"
      intro="Seven visual states. Each has a word, a mark whose shape alone tells it apart, an ink and a tint. Selected and dimmed are modifiers that combine with any state."
    >
      <Group title="State marks">
        <div className="grid grid-cols-7 gap-3">
          {workStates.map((s) => (
            <figure key={s} className="m-0 flex flex-col items-start gap-2">
              <FactoryScene label={factoryStates[s].label} viewBox="-14 -14 28 28" width={40} height={40} ground={false}>
                <StateMark state={s} r={11} />
              </FactoryScene>
              <figcaption className="flex flex-col">
                <span className="text-body-sm font-semibold text-ink">{factoryStates[s].label}</span>
                <span className="text-caption text-ink-muted">{factoryStates[s].description}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </Group>
      <Group title="Cell stages" note="The real stages from cell.json and the scheduler's slice states, each mapped to a visual state.">
        <ul className="m-0 grid list-none grid-cols-2 gap-x-8 p-0">
          {stageList.map((s) => (
            <li key={s} className="grid grid-cols-[28px_200px_minmax(0,1fr)] items-center gap-3 border-b border-line py-2">
              <FactoryScene label="" aria-hidden="true" viewBox="-9 -9 18 18" width={20} height={20} ground={false}>
                <StateMark state={cellStages[s].state} mark={cellStages[s].mark} r={8} />
              </FactoryScene>
              <span className="font-mono text-mono text-ink">{s}</span>
              <span className="text-body-sm text-ink-muted">{cellStages[s].label}</span>
            </li>
          ))}
        </ul>
      </Group>
    </Section>
  );
}

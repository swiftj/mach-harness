import {
  AgentMarker,
  ArtifactCard,
  BlueprintLane,
  BlueprintSheet,
  Branches,
  Callout,
  CellPlate,
  DependencyLink,
  DimensionLine,
  FactoryScene,
  GateGlyph,
  GroundGrid,
  Packet,
  Prism,
  RegionPlate,
  RetryLoop,
  RoutePath,
  SelectionBrackets,
  StationMachine,
  ToolTick,
  cellAnatomy,
  pointAlong,
  project,
  segment,
  type ArtifactKind,
  type CellStage,
  type FactoryState,
  type GateLamp,
  type ToolFamily,
  type Vec3,
} from "@mach/ui";

/**
 * Two static composition studies of one cell, driven by a stand-in playhead `t` (0..1). The story is
 * the cell's second judging round: verification failed once (the loop is already drawn), build works
 * again, verification passes, the verdict gate opens, the work travels to the review chamber, the
 * panel fans out and the votes converge.
 */
function story(t: number) {
  const build = segment(t, 0, 0.35);
  const verify = segment(t, 0.35, 0.6);
  const gate = segment(t, 0.6, 0.7);
  const travel = segment(t, 0.66, 0.82);
  const fan = segment(t, 0.72, 0.9);
  const votes = segment(t, 0.9, 1);
  const buildState: FactoryState = build < 1 ? "active" : "succeeded";
  const verifyState: FactoryState = t < 0.35 ? "idle" : verify < 1 ? "active" : "succeeded";
  const stage: CellStage = t < 0.35 ? "building" : t < 0.6 ? "built" : "verified";
  return { build, verify, gate, travel, fan, votes, buildState, verifyState, stage };
}

const ticks: Array<[ToolFamily, number, FactoryState?]> = [
  ["read", 0.02],
  ["read", 0.05],
  ["search", 0.08],
  ["write", 0.12],
  ["test", 0.16, "failed"],
  ["write", 0.2],
  ["run", 0.24],
  ["test", 0.28],
  ["git", 0.33],
  ["read", 0.38],
  ["run", 0.43],
  ["test", 0.48],
  ["test", 0.53],
  ["write", 0.57],
];

/* ------------------------------------------------------------------------------------------------ */

export function AtlasStudy({ t }: { t: number }) {
  const s = story(t);
  const cell = { x: 32, y: 30 };
  const a = cellAnatomy(cell);
  const z = a.floorZ;
  const chamber = { x: 330, y: 12, w: 214, d: 200 };
  const cz = 8;
  const gateAt = { ...a.door, x: a.door.x + 14 };
  // The bridge carries the route across the gap between the two plates, at plate height.
  const bridge = { x: 286, y: a.door.y - 10, w: chamber.x - 286 + 4, d: 20, z: 0, h: z };
  const toChamber: Vec3[] = [a.door, { x: chamber.x + 40, y: a.door.y, z }];
  // Seats in a row on one screen line (spec b.2).
  const seats: Vec3[] = [-1, 0, 1].map((k) => ({ x: chamber.x + 40 + 96 + k * 30, y: a.door.y - k * 30, z: cz }));
  const consensusAt = { x: chamber.x + 192, y: a.door.y, z: cz };
  const packet = s.travel > 0 && s.travel < 1 ? pointAlong(toChamber, s.travel) : null;
  const inner = s.build < 1 ? pointAlong([a.pads.build, a.pads.verify], 0) : s.verify < 1 ? pointAlong([a.pads.build, a.pads.verify], segment(s.verify, 0, 0.3)) : null;
  const shelf: Array<[ArtifactKind, number]> = [
    ["intent", 1],
    ["spec", 1],
    ["contract", 1],
    ["plan", 1],
    ["commit", s.build],
    ["build-report", segment(s.build, 0.7, 1)],
    ["evidence", segment(s.verify, 0.3, 0.8)],
    ["results", segment(s.verify, 0.6, 1)],
  ];
  const votes: FactoryState[] = [s.votes > 0.2 ? "succeeded" : "active", s.votes > 0.6 ? "succeeded" : "active", s.votes > 0.9 ? "succeeded" : "active"];
  const lamps: GateLamp[] = votes.map((v) => (v === "succeeded" ? "pass" : s.fan >= 1 ? "pending" : "off"));
  const crest = project({ x: (a.pads.verify.x + a.pads.build.x) / 2, y: a.pads.build.y, z: z + 30 });
  const cellBounds = (() => {
    const pts = [project({ ...cell, z: 8 }), project({ x: cell.x + 216, y: cell.y, z: 30 }), project({ x: cell.x + 216, y: cell.y + 148, z: 8 }), project({ x: cell.x, y: cell.y + 148, z: 8 })];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys) - 30, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) + 30 };
  })();

  return (
    <figure className="m-0 flex flex-col gap-2">
      <FactoryScene label="Atlas study: cell TCK-112 in its second round, beside the review chamber" viewBox="-250 -70 820 420" className="h-auto w-full rounded-md border border-line">
        <GroundGrid x={-120} y={-80} w={760} d={420} lod="near" />
        {/* A dependency from a finished cell off the drawing: satisfied, receding. */}
        <DependencyLink from={{ x: -40, y: 250, z: 0 }} to={{ x: cell.x + 6, y: a.door.y + 30, z }} state="satisfied" progress={1} lift={40} />
        <RegionPlate box={{ x: 0, y: 0, w: 290, d: 252 }} kind="floor" caption="1 of 3 cells" active lod="near" />
        <RegionPlate box={chamber} kind="review" lod="near" active={s.fan > 0 && s.votes < 1}>
          {/* The three seats of the panel, inlaid in the chamber floor. */}
          {seats.map((p, i) => (
            <circle key={i} cx={p.x + 8} cy={p.y} r={13} aria-hidden="true" style={{ fill: "var(--mach-factory-floor)", stroke: "var(--mach-factory-plate-edge)", strokeWidth: 1.2 }} />
          ))}
        </RegionPlate>
        <Prism box={bridge} hatch="lit" />
        <CellPlate origin={cell} ticket="TCK-112" slice="SLICE-007" stage={s.stage} lit={t < 0.6} elapsed={(s.build < 1 ? s.build : s.verify) * 12 * 60000} lod="near">
          {/* Machines on the rail, back to front. */}
          <StationMachine kind="plan" label="Groom and plan" state="succeeded" at={a.pads.intent} />
          <StationMachine kind="build" state={s.buildState} elapsed={(s.build) * 12 * 60000} round={2} at={a.pads.build} />
          <StationMachine kind="verify" state={s.verifyState} elapsed={(s.verify) * 12 * 60000} round={2} at={a.pads.verify} />
          {shelf.map(([k, p], i) => (p > 0 ? <ArtifactCard key={k} kind={k} progress={p} at={a.shelf(i)} /> : null))}
          {ticks.map(([f, at, st], i) =>
            t >= at ? <ToolTick key={i} family={f} state={st ?? (i === ticks.length - 1 && t < 0.6 ? "active" : "succeeded")} progress={segment(t, at, at + 0.02)} at={a.ticker(i / (ticks.length - 1))} /> : null,
          )}
          <AgentMarker agentRole="contract-engineer" tier="opus" state="succeeded" at={a.agentSpot("intent")} />
          <AgentMarker agentRole="builder" tier="sonnet" state={s.buildState === "active" ? "active" : "idle"} elapsed={(s.build) * 12 * 60000} at={a.agentSpot("build")} leave={segment(t, 0.36, 0.42)} />
          <AgentMarker agentRole="verifier" tier="sonnet" state={s.verifyState === "active" ? "active" : s.verifyState === "succeeded" ? "succeeded" : "idle"} elapsed={(s.verify) * 12 * 60000} arrive={segment(t, 0.34, 0.4)} at={a.agentSpot("verify")} />
          {inner ? <Packet at={inner.point} angle={inner.angle} ticket="TCK-112" /> : null}
        </CellPlate>
        <RetryLoop from={{ ...a.pads.verify, z: z + 20 }} to={{ ...a.pads.build, z: z + 24 }} round={2} progress={1} lift={30} lod="near" />
        <GateGlyph kind="verification" position={s.gate > 0 ? "open" : "closed"} progress={s.gate > 0 ? s.gate : 1} at={gateAt} lod="near" />
        <RoutePath points={toChamber} state={s.travel > 0 && s.travel < 1 ? "active" : "idle"} progress={1} lod="near" />
        {packet ? <Packet at={packet.point} angle={packet.angle} ticket="TCK-112" lod="near" /> : null}
        <Branches origin={toChamber[toChamber.length - 1]!} targets={seats} mode="fan-out" progress={[s.fan, segment(s.fan, 0.1, 1), segment(s.fan, 0.2, 1)]} states={["active", "active", "active"]} />
        <Branches origin={consensusAt} targets={seats} mode="join" progress={s.votes} states={votes} />
        {(["architecture", "security", "product"] as const).map((seat, i) => (
          <AgentMarker key={seat} agentRole="reviewer" seat={seat} tier="opus" state={votes[i]!} elapsed={(s.votes) * 12 * 60000} arrive={segment(s.fan, 0.3 + i * 0.15, 0.7 + i * 0.1)} at={{ ...seats[i]!, x: seats[i]!.x + 8 }} />
        ))}
        <GateGlyph kind="consensus" position={s.votes >= 1 ? "open" : "closed"} progress={1} lamps={lamps} at={consensusAt} lod="near" />
        <SelectionBrackets bounds={cellBounds} pad={4} />
        <Callout x={crest.x + 30} y={crest.y - 8} dx={40} dy={-40} text="Verification failed once" detail="AC-03 unproven; findings.md returned to build" tone="fail" />
      </FactoryScene>
      <figcaption className="text-caption text-ink-muted">
        Atlas: the cell as a place. Selected cell bracketed; the lamp is on while it works; the retry loop stands over the line with its round count;
        work leaves through the verdict gate and fans out to three reviewer seats.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export function BlueprintStudy({ t }: { t: number }) {
  const s = story(t);
  const W = 1120;
  const H = 470;
  const Y1 = 142;
  const Y2 = 192;
  const col = { groom: 232, plan: 302, audit: 372, build: 452, verify: 542, gate: 622, seats: 712, consensus: 802, human: 872, merge: 942 };
  const seatY = [Y1 - 34, Y1, Y1 + 34];
  const votes: FactoryState[] = [s.votes > 0.2 ? "succeeded" : "active", s.votes > 0.6 ? "succeeded" : "active", s.votes > 0.9 ? "succeeded" : "active"];
  const cellState: FactoryState = t < 0.6 ? "active" : "succeeded";
  const toolX = (at: number) => (at < 0.35 ? col.build - 44 + (at / 0.35) * 84 : col.verify - 40 + ((at - 0.35) / 0.25) * 80);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <FactoryScene label="Blueprint study: cell TCK-112, the same run drawn as a precise graph" viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded-md border border-line">
        <BlueprintSheet
          width={W}
          height={H}
          title="Execution blueprint"
          subtitle="Wave 3, team invitations · run 14"
          simulationLabel="Simulation"
          facts={[
            ["Cell", "TCK-112"],
            ["Slice", "SLICE-007"],
          ]}
        >
          <BlueprintLane x={24} y={40} width={W - 48} height={310} depth={0} title="Team invitations" id="WAVE-003" state="active">
            <BlueprintLane x={24} y={86} width={W - 48} height={146} depth={1} title="Invite a teammate" id="TCK-112" state={cellState} selected>
              {/* Round labels. */}
              <text x={col.build - 26} y={Y2 + 4} textAnchor="end" style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
                Round 2
              </text>
              {/* The line, in order. */}
              <RoutePath variant="blueprint" points={[{ x: col.groom + 17, y: Y1 }, { x: col.plan - 19, y: Y1 }]} state="succeeded" />
              <RoutePath variant="blueprint" points={[{ x: col.plan + 17, y: Y1 }, { x: col.audit - 17, y: Y1 }]} state="succeeded" />
              <RoutePath variant="blueprint" points={[{ x: col.audit + 17, y: Y1 }, { x: col.build - 19, y: Y1 }]} state="succeeded" />
              <RoutePath variant="blueprint" points={[{ x: col.build + 17, y: Y1 }, { x: col.verify - 19, y: Y1 }]} state="succeeded" />
              <RetryLoop variant="blueprint" from={{ x: col.verify, y: Y1 + 17 }} to={{ x: col.build, y: Y2 - 19 }} crestY={Y1 + 27} round={2} progress={1} />
              <RoutePath variant="blueprint" points={[{ x: col.build + 17, y: Y2 }, { x: col.verify - 19, y: Y2 }]} state={t < 0.35 ? "idle" : t < 0.6 ? "active" : "succeeded"} progress={t < 0.35 ? 0 : 1} />
              <RoutePath
                variant="blueprint"
                points={[{ x: col.verify + 17, y: Y2 }, { x: col.gate - 30, y: Y2 }, { x: col.gate - 30, y: Y1 }, { x: col.gate - 17, y: Y1 }]}
                state={s.verify >= 1 ? "succeeded" : "idle"}
                progress={s.verify >= 1 ? 1 : 0}
              />
              <Branches variant="blueprint" origin={{ x: col.gate + 17, y: Y1 }} targets={seatY.map((y) => ({ x: col.seats - 12, y }))} mode="fan-out" progress={[s.fan, segment(s.fan, 0.1, 1), segment(s.fan, 0.2, 1)]} states={["active", "active", "active"]} />
              <Branches variant="blueprint" origin={{ x: col.consensus - 17, y: Y1 }} targets={seatY.map((y) => ({ x: col.seats + 12, y }))} mode="join" progress={s.votes} states={votes} />
              <RoutePath variant="blueprint" points={[{ x: col.consensus + 17, y: Y1 }, { x: col.human - 17, y: Y1 }]} progress={s.votes >= 1 ? 1 : 0} state="succeeded" />
              <RoutePath variant="blueprint" points={[{ x: col.human + 17, y: Y1 }, { x: col.merge - 19, y: Y1 }]} progress={0} />

              {/* Nodes. */}
              <StationMachine variant="blueprint" kind="groom" state="succeeded" at={{ x: col.groom, y: Y1 }} />
              <StationMachine variant="blueprint" kind="plan" state="succeeded" at={{ x: col.plan, y: Y1 }} />
              <GateGlyph variant="blueprint" kind="audit" position="open" at={{ x: col.audit, y: Y1 }} />
              <StationMachine variant="blueprint" kind="build" state="succeeded" at={{ x: col.build, y: Y1 }} showLabel={false} />
              <StationMachine variant="blueprint" kind="verify" state="failed" at={{ x: col.verify, y: Y1 }} showLabel={false} />
              <StationMachine variant="blueprint" kind="build" state={s.buildState} elapsed={(s.build) * 12 * 60000} round={2} at={{ x: col.build, y: Y2 }} />
              <StationMachine variant="blueprint" kind="verify" state={s.verifyState} elapsed={(s.verify) * 12 * 60000} round={2} at={{ x: col.verify, y: Y2 }} />
              <GateGlyph variant="blueprint" kind="verification" position={s.gate > 0 ? "open" : "closed"} at={{ x: col.gate, y: Y1 }} showLabel={false} />
              <text x={col.gate} y={Y1 + 31} textAnchor="middle" style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
                Verdict
              </text>
              {seatY.map((y, i) => (
                <AgentMarker key={i} variant="blueprint" agentRole="reviewer" seat={(["architecture", "security", "product"] as const)[i]} tier="opus" state={s.fan > 0.3 ? votes[i]! : "idle"} progress={s.votes} arrive={segment(s.fan, 0.3 + i * 0.15, 0.7 + i * 0.1)} at={{ x: col.seats, y }} />
              ))}
              <GateGlyph variant="blueprint" kind="consensus" position={s.votes >= 1 ? "open" : "closed"} lamps={votes.map((v) => (v === "succeeded" ? "pass" : s.fan >= 1 ? "pending" : "off"))} at={{ x: col.consensus, y: Y1 }} />
              <GateGlyph variant="blueprint" kind="human" position="waiting" at={{ x: col.human, y: Y1 + 0 }} showLabel={false} />
              <text x={col.human} y={Y1 + 31} textAnchor="middle" style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
                Human
              </text>
              <StationMachine variant="blueprint" kind="merge" state="idle" at={{ x: col.merge, y: Y1 }} />

              {/* Artifacts at the handoffs. */}
              <ArtifactCard variant="blueprint" kind="intent" at={{ x: (col.groom + col.plan) / 2, y: Y1 - 22 }} />
              <ArtifactCard variant="blueprint" kind="plan" at={{ x: (col.plan + col.audit) / 2, y: Y1 - 22 }} />
              <ArtifactCard variant="blueprint" kind="commit" at={{ x: (col.build + col.verify) / 2, y: Y1 - 22 }} />
              <ArtifactCard variant="blueprint" kind="findings" state="failed" at={{ x: col.verify + 30, y: Y1 + 34 }} />
              {s.build > 0.5 ? <ArtifactCard variant="blueprint" kind="commit" progress={segment(s.build, 0.5, 0.8)} at={{ x: (col.build + col.verify) / 2, y: Y2 + 24 }} /> : null}
              {s.verify > 0.6 ? <ArtifactCard variant="blueprint" kind="evidence" progress={segment(s.verify, 0.6, 1)} at={{ x: col.gate - 30, y: Y2 + 24 }} /> : null}
              {s.votes >= 1 ? <ArtifactCard variant="blueprint" kind="decision" at={{ x: (col.consensus + col.human) / 2, y: Y1 - 22 }} /> : null}
              <Callout x={col.verify + 10} y={Y1 - 12} dx={36} dy={-26} text="Verification failed" detail="AC-03 unproven" tone="fail" />
            </BlueprintLane>

            <BlueprintLane x={24} y={232} width={W - 48} height={50} depth={2} title="Agents" state={t < 0.6 ? "active" : "idle"}>
              <AgentMarker variant="blueprint" agentRole="contract-engineer" tier="opus" state="succeeded" at={{ x: col.plan, y: 257 }} showLabel={false} />
              <AgentMarker variant="blueprint" agentRole="builder" tier="sonnet" state={s.buildState === "active" ? "active" : "succeeded"} elapsed={(s.build) * 12 * 60000} at={{ x: col.build, y: 257 }} showLabel />
              <AgentMarker variant="blueprint" agentRole="verifier" tier="sonnet" state={s.verifyState === "active" ? "active" : s.verifyState} elapsed={(s.verify) * 12 * 60000} at={{ x: col.verify, y: 257 }} showLabel />
            </BlueprintLane>
            <BlueprintLane x={24} y={282} width={W - 48} height={62} depth={3} title="Tool calls" summary={`${ticks.filter(([, at]) => t >= at).length} calls`}>
              <line x1={col.build - 52} y1={308} x2={col.verify + 52} y2={308} aria-hidden="true" style={{ stroke: "var(--mach-factory-grid-major)", strokeDasharray: "2 3" }} />
              {ticks.map(([f, at, st], i) =>
                t >= at ? <ToolTick key={i} variant="blueprint" family={f} state={st ?? "succeeded"} progress={segment(t, at, at + 0.02)} at={{ x: toolX(at), y: 308 }} /> : null,
              )}
              <DimensionLine x1={col.groom - 16} x2={col.audit + 16} y={334} label="8m 14s" />
              <DimensionLine x1={col.build - 18} x2={col.verify + 18} y={334} label="23m 40s, two rounds" />
              <DimensionLine x1={col.gate - 16} x2={col.consensus + 16} y={334} label={s.votes >= 1 ? "6m 05s" : "running"} />
            </BlueprintLane>
          </BlueprintLane>
          <BlueprintLane x={24} y={356} width={560} height={30} depth={1} title="Revoke an invitation" id="TCK-113" state="waiting" collapsed summary="Waiting on TCK-112" />
          <DependencyLink variant="blueprint" from={{ x: col.merge, y: Y1 + 17 }} to={{ x: 560, y: 371 }} state="blocking" />
        </BlueprintSheet>
      </FactoryScene>
      <figcaption className="text-caption text-ink-muted">
        Blueprint: the same cell as a drawing. Rounds stack as rows with the loop between them; the panel fans out and joins on the consensus
        diamond; agents and tool calls hang in nested lanes under the stations they served; durations are dimensioned; the next slice waits on this
        one through a dependency.
      </figcaption>
    </figure>
  );
}

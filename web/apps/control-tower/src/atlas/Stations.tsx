/**
 * The regions' working parts outside the cells: intake (dock, manifest, hopper, supervisor console,
 * scheduler, holding pads, audit), the review chamber (seats, fan-out, findings, votes, consensus
 * gate), the approval gatehouse, integration (revalidation gate, merge machine, merge commits on
 * the main line) and the archive corner (cleanup, observe, the archive stack). Each reads the scene
 * and the playhead; nothing here keeps state.
 */
import {
  AgentMarker,
  Branches,
  FindingsFlag,
  PlanDimension,
  GateGlyph,
  StationMachine,
  Prism,
  StateMark,
  StationSymbol,
  depthOf,
  fc,
  planeStroke,
  planeTransform,
  prismFaces,
  project,
  round,
  toPoints,
  type FactoryState,
  type GateLamp,
  type Lod,
  type Vec3,
} from "@mach/ui";
import { FloorLettering } from "@mach/ui";
import { PANELS, eventsInWindow, ref, sceneAt, type Risk, type CellState, type EntityRef, type EventKind, type Fixture, type Scene, type SliceState } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { Hit, isDimmed, useAtlas, useHighlight, usePlayheadKeyed } from "./context";
import { AFTERGLOW, RATE, agentsElapsedKey, animating, anim, chamberOccupant, gateView, latestGate, placeAgents, q, type PlacedAgent } from "./derive";
import { PLATE_Z, type BaySlot, type PlantLayout } from "./layout";
import { AgentFigure, onShelf } from "./Bay";
import { Card } from "./reduced";

/** The playhead keyed to a part's own animations (see usePlayheadKeyed), with the scene and flags. */
function useFrame(key: (fixture: Fixture, t: number) => string | number) {
  const t = usePlayheadKeyed((s) => key(s.fixture, s.playhead));
  const reduced = useSceneStore((s) => s.reducedMotion);
  const scene = useScene();
  const fixture = useSceneStore((s) => s.fixture);
  return { t, reduced, scene, fixture };
}

const has = (...kinds: string[]) => (e: { type: string }) => kinds.includes(e.type);
const recentOf = (fixture: Fixture, t: number, kinds: Parameters<typeof eventsInWindow>[3], ms: number) => eventsInWindow(fixture, t, ms, kinds).length > 0;

// ---------------------------------------------------------------- intake

/** Whether each actor's last act is within the afterglow: part of the intake's render key. */
type Actors = Partial<Record<"scheduler" | "supervisor", { lastActedAt: number | null }>>;
function actorsOf(scene: Scene): Actors | undefined {
  return (scene as Scene & { actors?: Actors }).actors;
}
function actorKey(f: Fixture, t: number): string {
  const a = actorsOf(sceneAt(f, t));
  if (!a) return "";
  return Object.values(a)
    .map((x) => (x && x.lastActedAt !== null && t - x.lastActedAt < AFTERGLOW ? 1 : 0))
    .join("");
}

const INTAKE_KINDS: EventKind[] = ["wave.discovered", "slice.materialized", "intake.validated"];
const DECISION_KINDS: EventKind[] = ["scheduling.decided", "dependency.blocked", "dependency.resolved", "work.scheduled"];

export function IntakeWorks() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene, fixture } = useFrame((f, now) =>
    animating(f, now, has("wave.discovered", "slice.materialized", "gate.checked", "work.scheduled"))
      ? now
      : `${recentOf(f, now, INTAKE_KINDS, 14_000)}${recentOf(f, now, DECISION_KINDS, AFTERGLOW)}${recentOf(f, now, ["gate.checked"], AFTERGLOW)}|${actorKey(f, now)}`,
  );
  const highlight = useHighlight();
  const I = L.intake;
  const recent = (kinds: Parameters<typeof eventsInWindow>[3], ms = AFTERGLOW) => eventsInWindow(fixture, t, ms, kinds);
  const intakeBusy = recent(INTAKE_KINDS, 14_000).length > 0;
  const anyWave = Object.values(scene.waves)[0];
  const hopperState: FactoryState = intakeBusy ? "active" : anyWave ? "succeeded" : "idle";
  const decided = recent(DECISION_KINDS);
  // The two actors of the record that are not agents: lit while their last act is recent.
  const actorBusy = (a: { lastActedAt: number | null } | undefined) => Boolean(a && a.lastActedAt !== null && t - a.lastActedAt < AFTERGLOW);
  const actors = actorsOf(scene);
  const schedulerBusy = actors ? actorBusy(actors.scheduler) : decided.length > 0;
  const supervisorBusy = actors ? actorBusy(actors.supervisor) : decided.length > 0;
  const lastDecision = scene.supervisor.lastDecision;
  const auditGate = latestGate(scene, "audit");
  const auditView = gateView(auditGate, t, reduced);
  const auditBusy = auditGate?.decidedAt != null && t - auditGate.decidedAt < AFTERGLOW;
  return (
    <g>
      {/* The wave's manifest: one sheet per slice, stacked on the dock. */}
      {anyWave ? (
        <Hit entity={ref.wave(anyWave.id)} label={`Wave ${anyWave.id}, ${anyWave.title}: ${anyWave.sliceIds.length} slices, approved by ${anyWave.approvedBy}`}>
          <g style={{ opacity: isDimmed(highlight, ref.wave(anyWave.id)) ? 0.28 : 1 }}>
            {/* At far zoom the stack is one sheet (spec b.7: artifacts as a count only; the name says how many). */}
            {(lod === "far" ? anyWave.sliceIds.slice(0, 1) : anyWave.sliceIds).map((s, i) => (
              <Card key={s} reduced={reduced} kind="spec" progress={q(anim("artifactMaterialise", t - anyWave.discoveredAt - i * 60 * RATE, reduced))} at={{ x: I.manifest.x - i * 2.4, y: I.manifest.y - i * 2, z: PLATE_Z - 2 }} lod={lod} showLabel={false} />
            ))}
          </g>
          {lod !== "far" ? (
            <FloorLettering at={{ x: L.dock.x + 6, y: L.dock.y + L.dock.d - 16, z: PLATE_Z - 2 }} text={anyWave.id} size={9} font="mono" tone="ink" weight={600} decorative />
          ) : null}
        </Hit>
      ) : null}
      {/* Supervisor console at the back of intake, its conduit running to the floor. It lights while
          the supervisor's last act is recent (actor:supervisor in the record). */}
      <Hit entity={"actor:supervisor" as EntityRef} label={`Line supervisor: ${supervisorBusy ? "acting" : "idle"}${lastDecision ? `, last decision dispatched ${lastDecision.dispatched.length}, started ${lastDecision.started.length}, held ${lastDecision.held.length}` : ""}`}>
        <Prism box={{ x: I.supervisor.x - 16, y: I.supervisor.y - 12, w: 32, d: 24, z: PLATE_Z, h: 12 }} top={supervisorBusy ? "live-soft" : "machine-top"} edge={supervisorBusy ? "live" : "plate-edge"} hatch="shade">
          <circle cx={I.supervisor.x} cy={I.supervisor.y} r={6} style={{ fill: "none", stroke: fc("ink"), strokeWidth: planeStroke }} />
          <circle cx={I.supervisor.x} cy={I.supervisor.y} r={3.4} style={{ fill: "none", stroke: fc("ink"), strokeWidth: planeStroke }} />
        </Prism>
      </Hit>
      {lod !== "far" && lastDecision ? (
        <FloorLettering at={{ x: I.supervisor.x - 18, y: I.supervisor.y + 22, z: PLATE_Z }} text={`dispatched ${lastDecision.dispatched.length} · started ${lastDecision.started.length} · held ${lastDecision.held.length}`} size={7.5} font="mono" tone={supervisorBusy ? "live" : "subtle"} weight={500} decorative />
      ) : null}
      {/* Inbound: the hopper where the wave is validated and cut into tickets. */}
      <Hit entity={ref.station("intake")} label={`Intake: ${hopperState}`}>
        <StationMachine nameplate showLabel={false} kind="intake" state={hopperState} at={I.hopper} lod={lod} planned={!anyWave} />
      </Hit>
      {/* The scheduler at its desk. Not an agent in the record: it lights only on scheduling events. */}
      {/* Furniture is detail: dropped at far zoom (spec b.7, the far element budget). */}
      {lod !== "far" ? (
        <Prism box={{ x: I.schedulerDesk.x - 14, y: I.schedulerDesk.y - 9, w: 28, d: 18, z: PLATE_Z, h: 8 }} hatch="shade">
          <rect x={I.schedulerDesk.x - 10} y={I.schedulerDesk.y - 5} width={20} height={10} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.8 * planeStroke }} />
          <path d={`M${I.schedulerDesk.x - 10} ${I.schedulerDesk.y}h20M${I.schedulerDesk.x} ${I.schedulerDesk.y - 5}v10`} style={{ stroke: fc("ink-soft"), strokeWidth: 0.6 * planeStroke }} />
        </Prism>
      ) : null}
      <Hit entity={"actor:scheduler" as EntityRef} label={`Scheduler: ${schedulerBusy ? "deciding" : "idle"}`}>
        <AgentMarker agentRole="scheduler" tier="haiku" state={schedulerBusy ? "active" : "idle"} at={I.scheduler} lod={lod} showLabel={false} />
      </Hit>
      {L.bays.map((b) => (
        <HoldingPad key={b.sliceId} bay={b} slice={scene.slices[b.sliceId]} cell={scene.cells[b.ticketId]} t={t} reduced={reduced} lod={lod} dimmed={isDimmed(highlight, ref.slice(b.sliceId), ref.cell(b.ticketId))} />
      ))}
      {/* Audit: the readiness gauge and the gate across intake's exit. */}
      <Hit entity={ref.station("audit")} label={`Audit: ${auditGate ? auditGate.detail : "not run yet"}`}>
        <StationMachine nameplate showLabel={false} kind="audit" state={auditBusy ? "active" : auditGate ? "succeeded" : "idle"} at={I.audit} lod={lod} planned={!auditGate} />
      </Hit>
      <Hit entity={auditGate ? `gate:${auditGate.id}` : "gate:audit"} label={`Audit gate: ${auditView.position}${auditGate ? `, ${auditGate.ticketId}` : ""}`}>
        <GateGlyph kind="audit" position={auditView.position} from={auditView.from} progress={auditView.progress} at={I.auditGate} axis="y" lod={lod} showLabel={false} floorLabel="Audit gate" planned={!auditGate} />
      </Hit>
    </g>
  );
}

function HoldingPad({ bay, slice, cell, t, reduced, lod, dimmed }: { bay: BaySlot; slice: SliceState | undefined; cell: CellState | undefined; t: number; reduced: boolean; lod: Lod; dimmed: boolean }) {
  const p = bay.pad;
  const state = slice?.scheduler;
  const waiting = state === "waiting-on-dependency";
  const gone = state === "dispatched" || state === "integrated";
  const mark: FactoryState = !slice ? "idle" : waiting ? "waiting" : gone ? "succeeded" : "idle";
  const word = !slice ? "" : waiting ? `WAITS · ${slice.dependsOn.map((d) => d.replace("SLICE-", "")).join(", ")}` : gone ? `→ ${cell?.ticketId ?? slice.ticketId}` : "ELIGIBLE";
  const mat = slice ? slice.history[0] : undefined;
  const cardP = mat ? q(anim("artifactMaterialise", t - mat.at - 900 * RATE, reduced)) : 0;
  const label = slice ? `Slice ${slice.id}, ${slice.title}: ${state}${slice.reasons.length ? `. ${slice.reasons.join(" ")}` : ""}` : `Holding pad ${bay.index + 1}: empty`;
  const pin = project({ x: p.x + 16, y: p.y - 16, z: PLATE_Z + 2 });
  const flat = gone && lod === "far";
  // The pad's lettering is drawn outside its hit target, so the target's name is the whole sentence.
  return (
    <g style={{ opacity: dimmed ? 0.28 : 1 }}>
      <Hit entity={ref.slice(bay.sliceId)} label={label}>
        {/* At far zoom a pad whose slice has left for the floor is only its outline (the far element budget). */}
        {flat ? (
          <polygon points={toPoints(prismFaces({ x: p.x - 20, y: p.y - 20, w: 40, d: 40, z: PLATE_Z + 2, h: 0 }).top)} style={{ fill: fc("floor"), stroke: fc("plate-edge"), strokeWidth: 0.8 }} />
        ) : (
          <Prism box={{ x: p.x - 20, y: p.y - 20, w: 40, d: 40, z: PLATE_Z, h: 2 }} top={waiting ? "wait-soft" : gone ? "floor" : "plate-top"} edge={waiting ? "wait" : "plate-edge"} dash={waiting ? "5 2.5" : undefined} hatch="none" shadow={false} />
        )}
      </Hit>
      <FloorLettering at={{ x: p.x - 17, y: p.y - 11, z: PLATE_Z + 2 }} text={slice ? bay.sliceId : `Pad ${bay.index + 1}`} size={lod === "far" ? 9 : 7} font="mono" tone="muted" weight={600} decorative />
      {lod !== "far" ? (
        <FloorLettering at={{ x: p.x - 17, y: p.y + 16, z: PLATE_Z + 2 }} text={word} size={6.2} font="mono" tone={waiting ? "wait" : "subtle"} weight={600} decorative />
      ) : null}
      <g aria-hidden="true" style={{ pointerEvents: "none" }}>
        {slice && !gone && lod !== "far" ? <Card reduced={reduced} kind="spec" progress={cardP} file={`${slice.ticketId}.md`} at={{ x: p.x - 2, y: p.y + 2, z: PLATE_Z + 2 }} lod={lod} showLabel={false} /> : null}
        {slice && !flat ? (
          <g transform={`translate(${round(pin.x)} ${round(pin.y)})`}>
            <StateMark state={mark} r={lod === "far" ? 6 : 4.4} />
          </g>
        ) : null}
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- review chamber

const SEATS = ["architecture", "security", "product"] as const;

export function ChamberWorks() {
  const { lod, layout: L, visibleBays } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => {
    if (animating(f, now, (e) => e.type.startsWith("review.") || e.type === "artifact.written" || e.type === "station.entered")) return now;
    const occ = chamberOccupant(sceneAt(f, now), now);
    return occ ? `${occ.cell.ticketId}/${occ.roundIndex}` : "empty";
  });
  const highlight = useHighlight();
  const R = L.review;
  const occ = chamberOccupant(scene, t);
  const round_ = occ ? occ.cell.reviews[occ.roundIndex] : undefined;
  const gate = occ ? scene.gates[`${occ.cell.ticketId}/review#${round_?.round ?? 1}`] : null;
  const v = gateView(gate, t, reduced);
  const lamps: GateLamp[] = SEATS.map((s) => {
    const seat = round_?.seats.find((x) => x.seat === s);
    if (!round_ || !seat) return "off";
    if (seat.vote === "APPROVE") return "pass";
    if (seat.vote === "REJECT") return "fail";
    return "pending";
  });
  const targets = SEATS.map((s) => R.seats[s]);
  const fan = round_ ? SEATS.map((_, i) => q(anim("fanOut", t - round_.startedAt - i * 90 * RATE, reduced))) : [0, 0, 0];
  const joinP = round_ ? SEATS.map((s) => {
    const seat = round_.seats.find((x) => x.seat === s);
    return seat?.votedAt != null ? q(anim("voteConverge", t - seat.votedAt, reduced)) : 0;
  }) : [0, 0, 0];
  const joinStates: FactoryState[] = round_ ? SEATS.map((s) => {
    const seat = round_.seats.find((x) => x.seat === s);
    return seat?.vote === "APPROVE" ? "succeeded" : seat?.vote === "REJECT" ? "failed" : "active";
  }) : ["idle", "idle", "idle"];
  const fanStates: FactoryState[] = SEATS.map((_, i) => (round_?.decidedAt != null ? (joinStates[i] ?? "idle") : "active"));
  const dim = occ ? isDimmed(highlight, ref.cell(occ.cell.ticketId)) : false;
  const packet = occ ? occ.cell.artifacts.find((a) => a.kind === "review-packet" && a.round === round_?.round) : undefined;
  const gateRef: EntityRef = gate ? `gate:${gate.id}` : "gate:review";
  const anyReview = Object.values(scene.cells).some((c) => c.reviews.length > 0);
  const consensusText = round_?.outcome ? `Consensus · ${round_.outcome === "AWAITING_HUMAN" ? "needs a person" : round_.outcome.toLowerCase()}` : "Consensus";
  return (
    <g style={{ opacity: dim ? 0.28 : 1 }}>
      {/* Seats inlaid in the chamber floor, each lettered. */}
      <g transform={planeTransform(PLATE_Z)} aria-hidden="true">
        {SEATS.map((s) => (
          <g key={s}>
            <circle cx={R.seats[s].x} cy={R.seats[s].y} r={13} style={{ fill: fc("floor"), stroke: fc("plate-edge"), strokeWidth: planeStroke }} />
            {lod !== "far" ? <circle cx={R.seats[s].x} cy={R.seats[s].y} r={9.5} style={{ fill: "none", stroke: fc("grid-major"), strokeWidth: 0.7 * planeStroke, strokeDasharray: "2 2" }} /> : null}
          </g>
        ))}
        {/* The panel's dashed triangle between the seats: the review symbol, inlaid. */}
        <path d={`M${R.seats.architecture.x} ${R.seats.architecture.y}L${R.seats.security.x} ${R.seats.security.y}L${R.seats.product.x} ${R.seats.product.y}Z`} style={{ fill: "none", stroke: fc("grid-major"), strokeWidth: planeStroke, strokeDasharray: "3 3" }} />
      </g>
      {lod !== "far"
        ? SEATS.map((s) => (
            <FloorLettering key={s} at={{ x: R.seats[s].x - 30, y: R.seats[s].y + 4, z: PLATE_Z }} text={s === "architecture" ? "A" : s === "security" ? "S" : "P"} size={8} font="mono" tone="subtle" weight={600} decorative />
          ))
        : null}
      {/* A reading desk beside each seat, facing the consensus gate (furniture: not at far zoom). */}
      {(lod === "far" ? [] : SEATS).map((s) => (
        <Prism key={`desk-${s}`} box={{ x: R.seats[s].x + 16, y: R.seats[s].y - 11, w: 9, d: 22, z: PLATE_Z, h: 7 }} hatch="shade" top={round_ ? "plate-top" : "plate-lit"}>
          <path d={`M${R.seats[s].x + 18} ${R.seats[s].y - 7}h5M${R.seats[s].x + 18} ${R.seats[s].y - 3}h5M${R.seats[s].x + 18} ${R.seats[s].y + 1}h3`} style={{ stroke: fc("ink-soft"), strokeWidth: 0.6 * planeStroke }} />
        </Prism>
      ))}
      {/* The rule board: the panel thresholds by risk tier, as review.py PANELS sets them. */}
      <RuleBoard L={L} lod={lod} risk={round_?.risk ?? null} />
      {/* The packet table at the entry: the review packet stands on it while the panel sits. */}
      <Prism box={{ x: R.packetTable.x - 12, y: R.packetTable.y - 8, w: 24, d: 16, z: PLATE_Z, h: 6 }} hatch="shade" />
      {packet && lod !== "far" ? (
        <Hit entity={ref.artifact(packet.id)} label={`Review packet ${packet.label}`} alias={onShelf(L, visibleBays, lod, occ!.cell, packet.id)}>
          <Card reduced={reduced} kind="review-packet" progress={q(anim("artifactMaterialise", t - packet.writtenAt, reduced))} at={{ ...R.packetTable, z: PLATE_Z + 6 }} lod={lod} showLabel={false} />
        </Hit>
      ) : null}
      {/* Reduced motion: fanOut "fades" (spec e): the branches are drawn whole and only their opacity ramps. */}
      {round_ ? (
        <g style={{ opacity: reduced ? q(Math.min(...fan)) : 1 }}>
          <Branches origin={R.entry} targets={targets} mode="fan-out" progress={reduced ? fan.map((p) => (p > 0 ? 1 : 0)) : fan} states={fanStates} label={`Review panel, ${occ?.cell.ticketId} round ${round_.round}: three seats`} />
        </g>
      ) : null}
      {round_ ? <Branches origin={R.gate} targets={targets} mode="join" progress={joinP} states={joinStates} label={`Votes, ${occ?.cell.ticketId} round ${round_.round}`} /> : null}
      {round_ ? <Findings occ={occ!.cell} roundIndex={occ!.roundIndex} L={L} t={t} reduced={reduced} lod={lod} /> : null}
      {/* The chamber's plaque: two short lines at the back-left corner, clear of the rule board at x + 132
          (one long line ran into it and overprinted "High · 3 of 3 + a person", findings D7). */}
      {round_ && lod !== "far" ? (
        <>
          <FloorLettering at={{ x: L.regions.review.x + 16, y: L.regions.review.y + 20, z: PLATE_Z }} text={`${occ!.cell.ticketId} · R${round_.round}`} size={8.5} font="mono" tone={round_.delta ? "live" : "muted"} weight={600} decorative />
          <FloorLettering at={{ x: L.regions.review.x + 16, y: L.regions.review.y + 31, z: PLATE_Z }} text={`${round_.approvalsNeeded} OF ${round_.seats.length} NEEDED`} size={7.5} font="mono" tone={round_.delta ? "live" : "muted"} weight={600} decorative />
        </>
      ) : null}
      {round_?.delta && lod !== "far" ? (
        <FloorLettering at={{ x: L.regions.review.x + 16, y: L.regions.review.y + 41, z: PLATE_Z }} text={`DELTA ${round_.delta.sinceCommit.slice(0, 7)} · ${round_.delta.filesChanged.length} FILES`} size={7} font="mono" tone="live" weight={500} decorative />
      ) : null}
      <Hit entity={gateRef} label={`${consensusText}: review consensus gate${occ ? `, ${occ.cell.ticketId} round ${round_?.round}` : ""}: ${v.position}${round_?.outcome ? `, ${round_.outcome}` : ""}`}>
        <GateGlyph kind="consensus" position={v.position} from={v.from} progress={v.progress} lamps={lamps} at={R.gate} axis="y" lod={lod} showLabel={false} floorLabel={consensusText} planned={!anyReview} />
      </Hit>
    </g>
  );
}

/** Findings as flags planted beside the seat that raised them; an outvoted blocker keeps its flag, struck through. */
function Findings({ occ, roundIndex, L, t, reduced, lod }: { occ: CellState; roundIndex: number; L: PlantLayout; t: number; reduced: boolean; lod: Lod }) {
  const r = occ.reviews[roundIndex];
  if (!r) return null;
  const counts = new Map<string, number>();
  return (
    <g>
      {r.findings.map((f) => {
        if (f.seat === "general") return null;
        // At far zoom only blocking findings are planted; notes are detail (the far element budget).
        if (lod === "far" && f.severity !== "blocker") return null;
        const k = counts.get(f.seat) ?? 0;
        counts.set(f.seat, k + 1);
        const seat = L.review.seats[f.seat];
        const at: Vec3 = { x: seat.x - 20 - k * 8, y: seat.y - 14, z: PLATE_Z };
        const blocker = f.severity === "blocker";
        const appear = anim("artifactMaterialise", t - f.at, reduced);
        const foot = project(at);
        return (
          <Hit key={f.id} entity={ref.finding(f.id)} label={`${blocker ? "Blocking finding" : "Note"}${f.rule ? ` citing ${f.rule}` : ""}, from the ${f.seat} seat: ${f.title}${f.outvoted ? ". Outvoted, reported" : ""}`}>
            <g style={{ opacity: Math.min(1, appear * 1.6) }}>
              <FindingsFlag at={at} severity={f.severity} rule={f.rule ?? undefined} lod={lod} />
              {/* An outvoted blocker keeps its flag, struck through: reported, not hidden. */}
              {f.outvoted ? <line aria-hidden="true" x1={round(foot.x - 2)} y1={round(foot.y - 12)} x2={round(foot.x + 14)} y2={round(foot.y - 26)} style={{ stroke: fc("fail"), strokeWidth: 1.4, strokeLinecap: "round" }} /> : null}
            </g>
          </Hit>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------- human approval gatehouse

export function GatehouseWorks() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => (animating(f, now, has("human.approval_recorded", "review.decided", "station.entered", "human.required")) ? now : "settled"));
  const highlight = useHighlight();
  const gate = latestGate(scene, "human-approval");
  const v = gateView(gate, t, reduced);
  const H = L.human;
  const waiting = gate?.state === "waiting";
  const approvals = Object.values(scene.cells).flatMap((c) => c.reviews.filter((r) => r.humanApproval).map((r) => ({ ticket: c.ticketId, by: r.humanApproval!.by, at: r.humanApproval!.at }))).sort((a, b) => a.at - b.at);
  const dim = gate ? isDimmed(highlight, ref.cell(gate.ticketId)) : false;
  return (
    <g style={{ opacity: dim ? 0.28 : 1 }}>
      {/* The booth where a person signs; its top carries the person symbol. */}
      <Prism box={{ x: H.booth.x - 16, y: H.booth.y - 14, w: 32, d: 26, z: PLATE_Z, h: 22 }} top={waiting ? "human-soft" : "plate-top"} edge={waiting ? "human" : "plate-edge"} hatch="shade">
        <g transform={`translate(${H.booth.x} ${H.booth.y - 1}) rotate(-45) translate(${-H.booth.x} ${-H.booth.y + 1})`}>
          <StationSymbol kind="human-approval" x={H.booth.x} y={H.booth.y - 1} size={16} color={waiting ? fc("human") : fc("ink-soft")} strokeWidth={1.3 * planeStroke} />
        </g>
      </Prism>
      {lod !== "far" ? (
        <FloorLettering at={{ x: L.regions.human.x + 12, y: L.regions.human.y + 18, z: PLATE_Z }} text={waiting ? `HELD FOR A PERSON · ${gate?.ticketId ?? ""}` : "HIGH RISK STOPS HERE"} size={7.5} font="mono" tone={waiting ? "human" : "subtle"} weight={600} decorative />
      ) : null}
      {/* The register: who approved what, as review.py approve-human records it. */}
      {lod !== "far" ? (
        <>
          <Prism box={{ x: L.regions.human.x + 16, y: L.regions.human.y + 26, w: 46, d: 16, z: PLATE_Z, h: 4 }} top="machine-top" hatch="shade" rim={false} />
          <FloorLettering at={{ x: L.regions.human.x + 19, y: L.regions.human.y + 33, z: PLATE_Z + 4 }} text={`Register · ${approvals.length} approval${approvals.length === 1 ? "" : "s"}`} size={5.6} font="sans" tone="muted" weight={600} decorative />
          {approvals.slice(-1).map((a) => (
            <FloorLettering key={a.ticket} at={{ x: L.regions.human.x + 19, y: L.regions.human.y + 39, z: PLATE_Z + 4 }} text={`${a.ticket} · ${a.by}`} size={5.2} font="sans" tone="human" weight={600} decorative />
          ))}
        </>
      ) : null}
      <Hit entity={gate ? `gate:${gate.id}` : "gate:human-approval"} label={`Human approval gate${gate ? `, ${gate.ticketId}` : ""}: ${waiting ? "waiting for a person" : v.position}`}>
        <GateGlyph kind="human" position={v.position} from={v.from} progress={v.progress} at={H.gate} axis="x" lod={lod} showLabel={false} floorLabel="Human approval" planned={!gate} />
      </Hit>
    </g>
  );
}

// ---------------------------------------------------------------- integration

export function IntegrationWorks() {
  const { lod, layout: L, visibleBays } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => (animating(f, now, has("merge.completed", "merge.revalidated", "station.entered", "slice.integrated")) ? now : "settled"));
  const highlight = useHighlight();
  const I = L.integration;
  const gate = latestGate(scene, "merge-revalidation");
  const v = gateView(gate, t, reduced);
  const revalText = gate ? `Revalidation · ${gate.state === "skipped" ? "not needed" : gate.state}` : "Revalidation";
  const merging = Object.values(scene.cells).filter((c) => c.station === "merge");
  const lastMerge = Object.values(scene.cells).reduce((m, c) => Math.max(m, c.merged?.at ?? -1), -1);
  const state: FactoryState = merging.length ? "active" : lastMerge >= 0 && t - lastMerge < AFTERGLOW ? "succeeded" : lastMerge >= 0 ? "succeeded" : "idle";
  const merged = Object.values(scene.cells).filter((c) => c.merged).sort((a, b) => (a.merged!.at - b.merged!.at));
  const waveKnown = Object.values(scene.waves).length > 0;
  const berth = (index: number): Vec3 => ({ x: I.merge.x - 130 - index * 120, y: I.trunkY, z: PLATE_Z });
  return (
    <g>
      {/* Berths on the main line, one per slice of the wave (the merges this run expects), drawn
          dashed until their merge commit lands; lettered only once intake knows the slices. */}
      <g aria-hidden="true">
        <g transform={planeTransform(PLATE_Z)}>
          {L.bays.map((b) => {
            const at = berth(b.index);
            const landed = Boolean(scene.cells[b.ticketId]?.merged);
            return landed ? null : <rect key={b.ticketId} x={at.x - 11} y={at.y - 9} width={22} height={18} rx={1.5} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: planeStroke, strokeDasharray: "3 2.5" }} />;
          })}
        </g>
        {lod !== "far"
          ? L.bays.map((b) => {
              const at = berth(b.index);
              const known = Boolean(scene.slices[b.sliceId]);
              const cell = scene.cells[b.ticketId];
              if (cell?.merged) return null;
              return <FloorLettering key={b.ticketId} at={{ x: at.x - 10, y: at.y + 18, z: PLATE_Z }} text={known ? `${b.ticketId} · berth` : `Berth ${b.index + 1}`} size={7.5} font={known ? "mono" : "sans"} tone="subtle" weight={500} decorative />;
            })
          : null}
        {lod !== "far" && waveKnown ? (
          // Behind the main line, clear of the berths' lettering in front of it.
          <PlanDimension from={{ ...berth(L.bays.length - 1), x: berth(L.bays.length - 1).x - 11, y: I.trunkY - 14 }} to={{ ...berth(0), x: berth(0).x + 11, y: I.trunkY - 14 }} offset={8} label={`${L.bays.length} berths · one per slice of the wave`} />
        ) : null}
      </g>
      <Hit entity={gate ? `gate:${gate.id}` : "gate:merge-revalidation"} label={`${revalText}: merge revalidation gate${gate ? `, ${gate.ticketId}: ${gate.state === "skipped" ? "skipped, main had not moved" : gate.state}` : ": idle"}`}>
        <GateGlyph kind="revalidation" position={v.position} from={v.from} progress={v.progress} at={I.gate} axis="x" lod={lod} dimmed={gate ? isDimmed(highlight, ref.cell(gate.ticketId)) : false} showLabel={false} floorLabel={revalText} planned={!gate} />
      </Hit>
      <Hit entity={ref.station("merge")} label={`Merge machine: ${merging.length ? `merging ${merging.map((c) => c.ticketId).join(", ")}` : state}`}>
        <StationMachine nameplate showLabel={false} kind="merge" state={state} at={I.merge} lod={lod} planned={state === "idle"} />
      </Hit>
      {/* The merge commits on the main line are artifacts: at far zoom only their count, in the yard's caption (spec b.7). */}
      {(lod === "far" ? [] : merged).map((c) => {
        const art = c.artifacts.find((a) => a.kind === "merge-commit");
        const at: Vec3 = berth(L.bayByTicket.get(c.ticketId)?.index ?? 0);
        const p = q(anim("artifactMaterialise", t - c.merged!.at - 1100 * RATE, reduced));
        const sl = scene.slices[c.sliceId];
        return (
          <g key={c.ticketId} style={{ opacity: isDimmed(highlight, ref.cell(c.ticketId)) ? 0.28 : 1 }}>
            {art ? (
              <Hit alias={onShelf(L, visibleBays, lod, c, art.id)} entity={ref.artifact(art.id)} label={`Merge commit for ${c.ticketId} on main: ${c.merged!.commit.slice(0, 7)}${c.merged!.revalidated ? ", revalidated" : ""}`}>
                <Card reduced={reduced} kind="merge-commit" progress={p} at={at} lod={lod} showLabel={false} />
              </Hit>
            ) : null}
            {lod !== "far" ? (
              // Two lines, so the lettering stays within its own berth (berths are 120 apart).
              <>
                <FloorLettering at={{ x: at.x - 10, y: at.y + 18, z: PLATE_Z }} text={`${c.ticketId} · ${c.merged!.commit.slice(0, 7)}`} size={7.5} font="mono" tone={sl?.scheduler === "integrated" ? "pass" : "muted"} weight={500} decorative />
                {sl?.scheduler === "integrated" ? <FloorLettering at={{ x: at.x - 10, y: at.y + 27, z: PLATE_Z }} text="integrated" size={7.5} font="mono" tone="pass" weight={500} decorative /> : null}
              </>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------- archive and observe

export function ArchiveWorks() {
  const { lod, layout: L, visibleBays } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => (animating(f, now, has("cleanup.completed", "artifact.written", "station.entered")) ? now : "settled"));
  const A = L.archive;
  const archived = Object.values(scene.cells).filter((c) => c.archived).sort((a, b) => a.archived!.at - b.archived!.at);
  const cleaning = Object.values(scene.cells).some((c) => c.station === "cleanup");
  const shelfAt = (i: number): Vec3 => ({ x: L.regions.archive.x + 26 + i * 30, y: A.stack.y, z: PLATE_Z });
  return (
    <g>
      <Hit entity={ref.station("cleanup")} label={`Cleanup: ${cleaning ? "archiving" : `${archived.length} cells archived`}`}>
        <StationMachine nameplate showLabel={false} kind="cleanup" state={cleaning ? "active" : archived.length ? "succeeded" : "idle"} at={A.cleanup} lod={lod} planned={!cleaning && archived.length === 0} />
      </Hit>
      <Hit entity={ref.station("observe")} label={`Observe: next pass after 5 finished tickets, ${archived.length} of 5`}>
        <StationMachine nameplate showLabel={false} kind="observe" state="idle" at={A.observe} lod={lod} planned />
      </Hit>
      {lod !== "far" ? (
        <FloorLettering at={{ x: A.observe.x - 40, y: A.observe.y - 28, z: PLATE_Z }} text={`Observe pass after 5 finished · ${archived.length} of 5`} size={7.5} font="sans" tone="subtle" weight={500} decorative />
      ) : null}
      {/* The runs.jsonl shelf: one slot per slice of the wave, dashed until that ticket's run is archived. */}
      <g aria-hidden="true" transform={planeTransform(PLATE_Z)}>
        {L.bays.map((b) =>
          scene.cells[b.ticketId]?.archived ? null : (
            <rect key={b.ticketId} x={shelfAt(b.index).x - 8} y={shelfAt(b.index).y - 2} width={16} height={4} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: planeStroke, strokeDasharray: "2 2" }} />
          ),
        )}
      </g>
      {lod !== "far" ? (
        <FloorLettering at={{ x: shelfAt(0).x - 8, y: shelfAt(0).y - 10, z: PLATE_Z }} text={`runs.jsonl · ${archived.length} of ${L.bays.length} recorded`} size={7.5} font="mono" tone="subtle" weight={500} decorative />
      ) : null}
      {/* Archives are artifacts: at far zoom only their count, in the region's caption (spec b.7). */}
      {(lod === "far" ? [] : archived).map((c) => {
        const art = c.artifacts.find((a) => a.kind === "archive");
        const p = q(anim("artifactMaterialise", t - c.archived!.at, reduced));
        const at = shelfAt(L.bayByTicket.get(c.ticketId)?.index ?? 0);
        return art ? (
          <Hit key={c.ticketId} entity={ref.artifact(art.id)} label={`Archive ${art.label}`} alias={onShelf(L, visibleBays, lod, c, art.id)}>
            <Card reduced={reduced} kind="archive" progress={p} at={at} lod={lod} showLabel={false} />
          </Hit>
        ) : null;
      })}
    </g>
  );
}

// ---------------------------------------------------------------- agents away from their bay

/** Reviewers at their seats, merge and cleanup workers at their machines. */
export function AwayAgents() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => {
    if (animating(f, now, has("agent.started", "agent.finished"))) return now;
    // Each working reviewer, merge or cleanup worker names its elapsed time to the second (its
    // accessible name), so re-render at each of those seconds (findings D8).
    return agentsElapsedKey(sceneAt(f, now), now, (a) => a.station === "review" || a.station === "merge" || a.station === "cleanup");
  });
  const highlight = useHighlight();
  const placed: PlacedAgent[] = [];
  for (const cell of Object.values(scene.cells)) for (const a of placeAgents(scene, L, cell, t, reduced)) if (a.at.z === PLATE_Z) placed.push(a);
  placed.sort((a, b) => depthOf(a.at) - depthOf(b.at));
  return (
    <g>
      {placed.map((a) => (
        <AgentFigure key={a.agent.id} placed={a} lod={lod} dimmed={isDimmed(highlight, ref.agent(a.agent.id), ref.cell(a.agent.ticketId))} />
      ))}
    </g>
  );
}

export type { Scene };

/** The chamber's rule board: what each risk tier needs to pass, lettered from review.py's PANELS. */
function RuleBoard({ L, lod, risk }: { L: PlantLayout; lod: Lod; risk: Risk | null }) {
  const R = L.regions.review;
  const x = R.x + 132;
  const y = R.y + 14;
  const rows: Array<[Risk, string]> = (["High", "Medium", "Low"] as const).map((r) => {
    const p = PANELS[r];
    return [r, `${r} · ${p.approvals} of ${p.reviewers}${p.human_approval ? " + a person" : ""}`];
  });
  // At far zoom its lettering is not drawn, so neither is the board (the far element budget).
  if (lod === "far") return null;
  return (
    <g aria-hidden="true">
      <Prism box={{ x, y, w: 74, d: 30, z: PLATE_Z, h: 3 }} top="machine-top" hatch="shade" rim={false} />
      <FloorLettering at={{ x: x + 4, y: y + 8, z: PLATE_Z + 3 }} text="Panel rules · review.py" size={6} font="sans" tone="subtle" weight={600} decorative />
      {rows.map(([r, text], i) => (
        <FloorLettering key={r} at={{ x: x + 4, y: y + 15 + i * 6.5, z: PLATE_Z + 3 }} text={text} size={5.6} font="sans" tone={risk === r ? "live" : "muted"} weight={risk === r ? 700 : 500} decorative />
      ))}
    </g>
  );
}

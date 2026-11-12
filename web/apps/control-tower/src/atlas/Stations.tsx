/**
 * The regions' working parts outside the cells: intake (dock, manifest, hopper, supervisor console,
 * scheduler, holding pads, audit), the review chamber (seats, fan-out, findings, votes, consensus
 * gate), the approval gatehouse, integration (revalidation gate, merge machine, merge commits on
 * the main line) and the archive corner (cleanup, observe, the archive stack). Each reads the scene
 * and the playhead; nothing here keeps state.
 */
import {
  AgentMarker,
  ArtifactCard,
  Branches,
  GateGlyph,
  Prism,
  StateMark,
  StationSymbol,
  depthOf,
  fc,
  planeStroke,
  planeTransform,
  project,
  round,
  type FactoryState,
  type GateLamp,
  type Lod,
  type Vec3,
} from "@mach/ui";
import { eventsInWindow, ref, sceneAt, type CellState, type EntityRef, type EventKind, type Fixture, type Scene, type SliceState } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { Hit, isDimmed, useAtlas, useHighlight, usePlayheadKeyed } from "./context";
import { AFTERGLOW, RATE, agentProgress, animating, anim, chamberOccupant, gateView, latestGate, placeAgents, q, type PlacedAgent } from "./derive";
import { PLATE_Z, type BaySlot, type PlantLayout } from "./layout";
import { PlaneText } from "./Plant";
import { Machine } from "./Machine";
import { AgentFigure } from "./Bay";

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

const INTAKE_KINDS: EventKind[] = ["wave.discovered", "slice.materialized", "intake.validated"];
const DECISION_KINDS: EventKind[] = ["scheduling.decided", "dependency.blocked", "dependency.resolved", "work.scheduled"];

export function IntakeWorks() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene, fixture } = useFrame((f, now) =>
    animating(f, now, has("wave.discovered", "slice.materialized", "gate.checked", "work.scheduled"))
      ? now
      : `${recentOf(f, now, INTAKE_KINDS, 14_000)}${recentOf(f, now, DECISION_KINDS, AFTERGLOW)}${recentOf(f, now, ["gate.checked"], AFTERGLOW)}`,
  );
  const highlight = useHighlight();
  const I = L.intake;
  const recent = (kinds: Parameters<typeof eventsInWindow>[3], ms = AFTERGLOW) => eventsInWindow(fixture, t, ms, kinds);
  const intakeBusy = recent(INTAKE_KINDS, 14_000).length > 0;
  const anyWave = Object.values(scene.waves)[0];
  const hopperState: FactoryState = intakeBusy ? "active" : anyWave ? "succeeded" : "idle";
  const decided = recent(DECISION_KINDS);
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
            {anyWave.sliceIds.map((s, i) => (
              <ArtifactCard key={s} kind="spec" progress={q(anim("artifactMaterialise", t - anyWave.discoveredAt - i * 60 * RATE, reduced))} at={{ x: I.manifest.x - i * 2.4, y: I.manifest.y - i * 2, z: PLATE_Z - 2 }} lod={lod} showLabel={false} />
            ))}
          </g>
          {lod !== "far" ? (
            <PlaneText x={L.dock.x + 6} y={L.dock.y + L.dock.d - 16} z={PLATE_Z - 2} size={9} mono tone="ink" weight={600}>
              {anyWave.id}
            </PlaneText>
          ) : null}
        </Hit>
      ) : null}
      {/* Supervisor console at the back of intake, its conduit running to the floor. */}
      <Prism box={{ x: I.supervisor.x - 16, y: I.supervisor.y - 12, w: 32, d: 24, z: PLATE_Z, h: 12 }} top={decided.length ? "live-soft" : "plate-top"} edge={decided.length ? "live" : "plate-edge"} hatch="shade">
        <circle cx={I.supervisor.x} cy={I.supervisor.y} r={6} style={{ fill: "none", stroke: fc("ink"), strokeWidth: planeStroke }} />
        <circle cx={I.supervisor.x} cy={I.supervisor.y} r={3.4} style={{ fill: "none", stroke: fc("ink"), strokeWidth: planeStroke }} />
      </Prism>
      {lod !== "far" && lastDecision ? (
        <PlaneText x={I.supervisor.x - 18} y={I.supervisor.y + 22} size={7.5} mono tone={decided.length ? "live" : "subtle"}>
          {`dispatched ${lastDecision.dispatched.length} · started ${lastDecision.started.length} · held ${lastDecision.held.length}`}
        </PlaneText>
      ) : null}
      {/* Inbound: the hopper where the wave is validated and cut into tickets. */}
      <Hit entity={ref.station("intake")} label={`Intake: ${hopperState}`}>
        <Machine kind="intake" state={hopperState} at={I.hopper} lod={lod} progress={intakeBusy ? 0.5 : 0} />
      </Hit>
      {/* The scheduler at its desk. Not an agent in the record: it lights only on scheduling events. */}
      <Prism box={{ x: I.schedulerDesk.x - 14, y: I.schedulerDesk.y - 9, w: 28, d: 18, z: PLATE_Z, h: 8 }} hatch="shade">
        <rect x={I.schedulerDesk.x - 10} y={I.schedulerDesk.y - 5} width={20} height={10} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.8 * planeStroke }} />
        <path d={`M${I.schedulerDesk.x - 10} ${I.schedulerDesk.y}h20M${I.schedulerDesk.x} ${I.schedulerDesk.y - 5}v10`} style={{ stroke: fc("ink-soft"), strokeWidth: 0.6 * planeStroke }} />
      </Prism>
      <g role="img" aria-label={`Scheduler, Haiku: ${decided.length ? "deciding" : "idle"}`}>
        <AgentMarker agentRole="scheduler" tier="haiku" state={decided.length ? "active" : "idle"} progress={decided.length ? 1 : 0} at={I.scheduler} lod={lod} showLabel={false} />
      </g>
      {L.bays.map((b) => (
        <HoldingPad key={b.sliceId} bay={b} slice={scene.slices[b.sliceId]} cell={scene.cells[b.ticketId]} t={t} reduced={reduced} lod={lod} dimmed={isDimmed(highlight, ref.slice(b.sliceId), ref.cell(b.ticketId))} />
      ))}
      {/* Audit: the readiness gauge and the gate across intake's exit. */}
      <Hit entity={ref.station("audit")} label={`Audit: ${auditGate ? auditGate.detail : "not run yet"}`}>
        <Machine kind="audit" state={auditBusy ? "active" : auditGate ? "succeeded" : "idle"} progress={auditBusy ? 1 : 0} at={I.audit} lod={lod} />
      </Hit>
      <GateStencil at={I.auditGate} axis="y" lod={lod} text={auditGate ? `AUDIT GATE · ${auditGate.detail.split(";")[0]?.slice(0, 22) ?? ""}` : "AUDIT GATE"} />
      <Hit entity={auditGate ? `gate:${auditGate.id}` : "gate:audit"} label={`Audit gate: ${auditView.position}${auditGate ? `, ${auditGate.ticketId}` : ""}`}>
        <GateGlyph kind="audit" position={auditView.position} from={auditView.from} progress={auditView.progress} at={I.auditGate} axis="y" lod={lod} showLabel={false} />
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
  return (
    <Hit entity={ref.slice(bay.sliceId)} label={label}>
      <g style={{ opacity: dimmed ? 0.28 : 1 }}>
        <Prism box={{ x: p.x - 20, y: p.y - 20, w: 40, d: 40, z: PLATE_Z, h: 2 }} top={waiting ? "wait-soft" : gone ? "floor" : "plate-top"} edge={waiting ? "wait" : "plate-edge"} dash={waiting ? "5 2.5" : undefined} hatch="none" shadow={false}>
          <text x={p.x - 17} y={p.y - 11} style={{ fill: "var(--mach-ink-muted)", fontSize: lod === "far" ? 9 : 7, fontFamily: "var(--mach-font-mono)", fontWeight: 600 }} className="notranslate">
            {bay.sliceId}
          </text>
          {lod !== "far" ? (
            <text x={p.x - 17} y={p.y + 16} style={{ fill: waiting ? fc("wait") : "var(--mach-ink-subtle)", fontSize: 6.2, fontFamily: "var(--mach-font-mono)", fontWeight: 600 }} className="notranslate">
              {word}
            </text>
          ) : null}
        </Prism>
        {slice && !gone ? <ArtifactCard kind="spec" progress={cardP} file={`${slice.ticketId}.md`} at={{ x: p.x - 2, y: p.y + 2, z: PLATE_Z + 2 }} lod={lod} showLabel={false} /> : null}
        {slice ? (
          <g transform={`translate(${round(pin.x)} ${round(pin.y)})`}>
            <StateMark state={mark} r={lod === "far" ? 6 : 4.4} />
          </g>
        ) : null}
      </g>
    </Hit>
  );
}

// ---------------------------------------------------------------- review chamber

const SEATS = ["architecture", "security", "product"] as const;

export function ChamberWorks() {
  const { lod, layout: L } = useAtlas();
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
  return (
    <g style={{ opacity: dim ? 0.28 : 1 }}>
      {/* Seats inlaid in the chamber floor, each lettered. */}
      <g transform={planeTransform(PLATE_Z)} aria-hidden="true">
        {SEATS.map((s) => (
          <g key={s}>
            <circle cx={R.seats[s].x} cy={R.seats[s].y} r={13} style={{ fill: fc("floor"), stroke: fc("plate-edge"), strokeWidth: planeStroke }} />
            <circle cx={R.seats[s].x} cy={R.seats[s].y} r={9.5} style={{ fill: "none", stroke: fc("grid-major"), strokeWidth: 0.7 * planeStroke, strokeDasharray: "2 2" }} />
          </g>
        ))}
        {/* The panel's dashed triangle between the seats: the review symbol, inlaid. */}
        <path d={`M${R.seats.architecture.x} ${R.seats.architecture.y}L${R.seats.security.x} ${R.seats.security.y}L${R.seats.product.x} ${R.seats.product.y}Z`} style={{ fill: "none", stroke: fc("grid-major"), strokeWidth: planeStroke, strokeDasharray: "3 3" }} />
      </g>
      {lod !== "far"
        ? SEATS.map((s) => (
            <PlaneText key={s} x={R.seats[s].x - 30} y={R.seats[s].y + 4} size={8} mono tone="subtle" weight={600}>
              {s === "architecture" ? "A" : s === "security" ? "S" : "P"}
            </PlaneText>
          ))
        : null}
      {/* A reading desk beside each seat, facing the consensus gate. */}
      {SEATS.map((s) => (
        <Prism key={`desk-${s}`} box={{ x: R.seats[s].x + 16, y: R.seats[s].y - 11, w: 9, d: 22, z: PLATE_Z, h: 7 }} hatch="shade" top={round_ ? "plate-top" : "plate-lit"}>
          <path d={`M${R.seats[s].x + 18} ${R.seats[s].y - 7}h5M${R.seats[s].x + 18} ${R.seats[s].y - 3}h5M${R.seats[s].x + 18} ${R.seats[s].y + 1}h3`} style={{ stroke: fc("ink-soft"), strokeWidth: 0.6 * planeStroke }} />
        </Prism>
      ))}
      {/* The packet table at the entry: the review packet stands on it while the panel sits. */}
      <Prism box={{ x: R.packetTable.x - 12, y: R.packetTable.y - 8, w: 24, d: 16, z: PLATE_Z, h: 6 }} hatch="shade" />
      {packet ? (
        <Hit entity={ref.artifact(packet.id)} label={`Review packet ${packet.label}`}>
          <ArtifactCard kind="build-report" progress={q(anim("artifactMaterialise", t - packet.writtenAt, reduced))} at={{ ...R.packetTable, z: PLATE_Z + 6 }} lod={lod} showLabel={false} />
        </Hit>
      ) : null}
      {round_ ? <Branches origin={R.entry} targets={targets} mode="fan-out" progress={fan} states={fanStates} label={`Review panel, ${occ?.cell.ticketId} round ${round_.round}: three seats`} /> : null}
      {round_ ? <Branches origin={R.gate} targets={targets} mode="join" progress={joinP} states={joinStates} label={`Votes, ${occ?.cell.ticketId} round ${round_.round}`} /> : null}
      {round_ ? <Findings occ={occ!.cell} roundIndex={occ!.roundIndex} L={L} t={t} reduced={reduced} lod={lod} /> : null}
      {round_ && lod !== "far" ? (
        <PlaneText x={L.regions.review.x + 16} y={L.regions.review.y + 22} size={8.5} mono tone={round_.delta ? "live" : "muted"} weight={600}>
          {`${occ!.cell.ticketId} · R${round_.round} · ${round_.approvalsNeeded}/3 NEEDED`}
        </PlaneText>
      ) : null}
      {round_?.delta && lod !== "far" ? (
        <PlaneText x={L.regions.review.x + 16} y={L.regions.review.y + 34} size={7.5} mono tone="live">
          {`DELTA SINCE ${round_.delta.sinceCommit.slice(0, 7)} · ${round_.delta.filesChanged.length} FILES`}
        </PlaneText>
      ) : null}
      <GateStencil at={R.gate} axis="y" lod={lod} text={round_?.outcome ? `CONSENSUS · ${round_.outcome.replace("_", " ")}` : "CONSENSUS"} tone={round_?.outcome === "REJECTED" ? "fail" : "subtle"} />
      <Hit entity={gateRef} label={`Review consensus gate${occ ? `, ${occ.cell.ticketId} round ${round_?.round}` : ""}: ${v.position}${round_?.outcome ? `, ${round_.outcome}` : ""}`}>
        <GateGlyph kind="consensus" position={v.position} from={v.from} progress={v.progress} lamps={lamps} at={R.gate} axis="y" lod={lod} showLabel={false} />
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
        const k = counts.get(f.seat) ?? 0;
        counts.set(f.seat, k + 1);
        const seat = L.review.seats[f.seat];
        const at: Vec3 = { x: seat.x - 20 - k * 8, y: seat.y - 14, z: PLATE_Z };
        const base = project(at);
        const p = anim("artifactMaterialise", t - f.at, reduced);
        const h = 16 * p;
        const top = project({ ...at, z: PLATE_Z + h });
        const blocker = f.severity === "blocker";
        const ink = blocker ? fc("fail") : fc("ink-soft");
        return (
          <Hit key={f.id} entity={ref.finding(f.id)} label={`${blocker ? "Blocker" : "Note"} from the ${f.seat} seat${f.rule ? ` (${f.rule})` : ""}: ${f.title}${f.outvoted ? ". Outvoted, reported" : ""}`}>
            <g>
              <line x1={base.x} y1={base.y} x2={top.x} y2={top.y} style={{ stroke: ink, strokeWidth: 1.2 }} />
              <path d={`M${round(top.x)} ${round(top.y)}l7 2.5l-7 2.5z`} style={{ fill: blocker ? fc("fail-soft") : fc("plate-top"), stroke: ink, strokeWidth: 1 }} />
              {blocker ? <text x={round(top.x + 2)} y={round(top.y + 4.6)} style={{ fill: ink, fontSize: 5, fontWeight: 800 }}>!</text> : null}
              {f.outvoted ? <line x1={top.x - 2} y1={top.y + 6} x2={top.x + 9} y2={top.y - 1} style={{ stroke: ink, strokeWidth: 1.2 }} /> : null}
              {lod === "near" && f.rule ? (
                <text x={round(top.x + 9)} y={round(top.y + 4)} style={{ fill: ink, fontSize: 8, fontFamily: "var(--mach-font-mono)", fontWeight: 600 }} className="notranslate">
                  {f.rule}
                </text>
              ) : null}
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
        <PlaneText x={L.regions.human.x + 12} y={L.regions.human.y + 18} size={7.5} mono tone={waiting ? "human" : "subtle"} weight={600}>
          {waiting ? `HELD FOR A PERSON · ${gate?.ticketId ?? ""}` : "HIGH RISK STOPS HERE"}
        </PlaneText>
      ) : null}
      <Hit entity={gate ? `gate:${gate.id}` : "gate:human-approval"} label={`Human approval gate${gate ? `, ${gate.ticketId}` : ""}: ${waiting ? "waiting for a person" : v.position}`}>
        <GateGlyph kind="human" position={v.position} from={v.from} progress={v.progress} at={H.gate} axis="x" lod={lod} showLabel={false} />
      </Hit>
    </g>
  );
}

// ---------------------------------------------------------------- integration

export function IntegrationWorks() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => (animating(f, now, has("merge.completed", "merge.revalidated", "station.entered", "slice.integrated")) ? now : "settled"));
  const highlight = useHighlight();
  const I = L.integration;
  const gate = latestGate(scene, "merge-revalidation");
  const v = gateView(gate, t, reduced);
  const merging = Object.values(scene.cells).filter((c) => c.station === "merge");
  const lastMerge = Object.values(scene.cells).reduce((m, c) => Math.max(m, c.merged?.at ?? -1), -1);
  const state: FactoryState = merging.length ? "active" : lastMerge >= 0 && t - lastMerge < AFTERGLOW ? "succeeded" : lastMerge >= 0 ? "succeeded" : "idle";
  const merged = Object.values(scene.cells).filter((c) => c.merged).sort((a, b) => (a.merged!.at - b.merged!.at));
  return (
    <g>
      <Hit entity={gate ? `gate:${gate.id}` : "gate:merge-revalidation"} label={`Merge revalidation gate${gate ? `, ${gate.ticketId}: ${gate.state === "skipped" ? "skipped, main had not moved" : gate.state}` : ": idle"}`}>
        <GateGlyph kind="revalidation" position={v.position} from={v.from} progress={v.progress} at={I.gate} axis="x" lod={lod} dimmed={gate ? isDimmed(highlight, ref.cell(gate.ticketId)) : false} showLabel={false} />
      </Hit>
      <GateStencil at={I.gate} axis="x" lod={lod} text={gate ? `REVALIDATION · ${gate.state === "skipped" ? "NOT NEEDED" : gate.state.toUpperCase()}` : "REVALIDATION"} />
      <Hit entity={ref.station("merge")} label={`Merge machine: ${merging.length ? `merging ${merging.map((c) => c.ticketId).join(", ")}` : state}`}>
        <Machine kind="merge" state={state} progress={merging.length ? 0.5 : 0} at={I.merge} lod={lod} />
      </Hit>
      {merged.map((c, k) => {
        const art = c.artifacts.find((a) => a.kind === "merge-commit");
        const at: Vec3 = { x: I.merge.x - 120 - k * 110, y: I.trunkY, z: PLATE_Z - 6 };
        const p = q(anim("artifactMaterialise", t - c.merged!.at - 1100 * RATE, reduced));
        const sl = scene.slices[c.sliceId];
        return (
          <g key={c.ticketId} style={{ opacity: isDimmed(highlight, ref.cell(c.ticketId)) ? 0.28 : 1 }}>
            {art ? (
              <Hit entity={ref.artifact(art.id)} label={`Merge commit for ${c.ticketId} on main: ${c.merged!.commit.slice(0, 7)}${c.merged!.revalidated ? ", revalidated" : ""}`}>
                <ArtifactCard kind="merge-commit" progress={p} at={at} lod={lod} showLabel={false} />
              </Hit>
            ) : null}
            {lod !== "far" ? (
              <PlaneText x={at.x - 10} y={at.y + 18} z={PLATE_Z} size={7.5} mono tone={sl?.scheduler === "integrated" ? "pass" : "muted"}>
                {`${c.ticketId} · ${c.merged!.commit.slice(0, 7)}${sl?.scheduler === "integrated" ? " · integrated" : ""}`}
              </PlaneText>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------- archive and observe

export function ArchiveWorks() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => (animating(f, now, has("cleanup.completed", "artifact.written", "station.entered")) ? now : "settled"));
  const A = L.archive;
  const archived = Object.values(scene.cells).filter((c) => c.archived).sort((a, b) => a.archived!.at - b.archived!.at);
  const cleaning = Object.values(scene.cells).some((c) => c.station === "cleanup");
  return (
    <g>
      <Hit entity={ref.station("cleanup")} label={`Cleanup: ${cleaning ? "archiving" : `${archived.length} cells archived`}`}>
        <Machine kind="cleanup" state={cleaning ? "active" : archived.length ? "succeeded" : "idle"} progress={cleaning ? 0.5 : 0} at={A.cleanup} lod={lod} />
      </Hit>
      <Hit entity={ref.station("observe")} label={`Observe: next pass after 5 finished tickets, ${archived.length} of 5`}>
        <Machine kind="observe" state="idle" at={A.observe} lod={lod} />
      </Hit>
      {lod !== "far" ? (
        <PlaneText x={A.observe.x - 20} y={A.observe.y + 34} size={7.5} mono tone="subtle">
          {`NEXT PASS · ${archived.length} OF 5 FINISHED`}
        </PlaneText>
      ) : null}
      {archived.map((c, k) => {
        const art = c.artifacts.find((a) => a.kind === "archive");
        const p = q(anim("artifactMaterialise", t - c.archived!.at, reduced));
        const at = { x: A.stack.x - k * 2.6, y: A.stack.y - k * 2.2, z: PLATE_Z };
        return art ? (
          <Hit key={c.ticketId} entity={ref.artifact(art.id)} label={`Archive ${art.label}`}>
            <ArtifactCard kind="decision" progress={p} at={at} lod={lod} showLabel={false} />
          </Hit>
        ) : null;
      })}
      {lod !== "far" && archived.length ? (
        <PlaneText x={A.stack.x - 22} y={A.stack.y + 14} size={7.5} mono tone="subtle">
          {`${archived.length} RUN RECORD${archived.length === 1 ? "" : "S"} · runs.jsonl`}
        </PlaneText>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------- agents away from their bay

/** Reviewers at their seats, merge and cleanup workers at their machines. */
export function AwayAgents() {
  const { lod, layout: L } = useAtlas();
  const { t, reduced, scene } = useFrame((f, now) => {
    if (animating(f, now, has("agent.started", "agent.finished"))) return now;
    let k = "";
    for (const c of Object.values(sceneAt(f, now).cells)) for (const id of c.activeAgentIds) {
      const a = c.agents[id]!;
      if (a.station === "review" || a.station === "merge" || a.station === "cleanup") k += `${Math.floor(agentProgress(a, now) * 24)},`;
    }
    return k;
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

/** A gate's name lettered on the floor beside it (mid and near), instead of an upright label that callouts would collide with. */
function GateStencil({ at, axis, lod, text, tone = "subtle" }: { at: Vec3; axis: "x" | "y"; lod: Lod; text: string; tone?: "subtle" | "fail" | "human" }) {
  if (lod === "far") return null;
  return axis === "y" ? (
    <PlaneText x={at.x + 8} y={at.y + 30} size={6.5} mono tone={tone} weight={600}>
      {text}
    </PlaneText>
  ) : (
    <PlaneText x={at.x - 34} y={at.y - 14} size={6.5} mono tone={tone} weight={600} alongY>
      {text}
    </PlaneText>
  );
}

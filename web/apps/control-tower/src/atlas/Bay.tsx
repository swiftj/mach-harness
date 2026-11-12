/**
 * One construction cell as a place (spec b.3): the bay, its line console and wall panel (the
 * Dynamic Workflow's phases), the artifact shelf, the red-before-green task board, the machines on
 * the rail, the verification results rack, the tool ticker, the feature branch with its commits, the
 * agents at work, the verification gate outside the door and the retry loop over the line.
 * Before the slice is dispatched the bay stands reserved and empty.
 */
import { memo, type ReactNode } from "react";
import {
  AgentMarker,
  ArtifactCard,
  CellPlate,
  GateGlyph,
  Prism,
  RetryLoop,
  StateMark,
  StationMachine,
  ToolTick,
  agentRoles,
  depthOf,
  dimmedOpacity,
  dimmedTextOpacity,
  fc,
  liftedArc,
  modelTiers,
  planeStroke,
  planeTransform,
  pointAlong,
  prismFaces,
  project,
  reviewerSeats,
  round,
  segment,
  toPoints,
  uprightTransform,
  type CellStage as UiStage,
  type FactoryState,
  type Lod,
  type PlanBox,
  type Vec3,
} from "@mach/ui";
import { FloorLettering, PlanDimension, TaskBoard as TaskBoardMark, type TaskCell } from "@mach/ui";
import { BELT_PHASES, ref, sceneAt, type CellState, type EntityRef, type ExecutionState, type GateState } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { Hit, isDimmed, useAtlas, useHighlight, usePlayheadKeyed } from "./context";
import { animating, anim, callsOf, lampLevel, gateView, latestGate, placeAgents, q, toolFamily, uiArtifact, uiRole, uiTier, type PlacedAgent } from "./derive";
import { FLOOR_Z, PLATE_Z, boxAt, type BaySlot } from "./layout";

const CELL_W = 216;
const CELL_D = 148;

function uiStage(stage: CellState["stage"]): UiStage {
  return stage === "spec-open" ? "interview" : stage;
}

function machineState(cell: CellState, kinds: readonly string[]): { state: FactoryState; round?: number } {
  if (cell.station && kinds.includes(cell.station)) return { state: "active", round: cell.round > 1 ? cell.round : undefined };
  const last = [...cell.visits].reverse().find((v) => kinds.includes(v.station));
  if (!last) return { state: "idle" };
  if (last.outcome === "failed") return { state: "failed", round: last.round > 1 ? last.round : undefined };
  return { state: "succeeded", round: last.round > 1 ? last.round : undefined };
}

export interface BayProps {
  bay: BaySlot;
  visible: boolean;
}

/** A bay subscribes to its own cell and the playhead; other bays do not re-render with it. */
export const Bay = memo(function Bay({ bay, visible }: BayProps) {
  const cell = useScene((s) => s.cells[bay.ticketId]);
  const slice = useScene((s) => s.slices[bay.sliceId]);
  if (!cell) return <ReservedBay bay={bay} waiting={slice?.scheduler === "waiting-on-dependency"} known={Boolean(slice)} />;
  return <LiveBay bay={bay} cell={cell} visible={visible} />;
});

function ReservedBay({ bay, waiting, known }: { bay: BaySlot; waiting: boolean; known: boolean }) {
  const { lod } = useAtlas();
  const highlight = useHighlight();
  const { x, y } = bay.origin;
  const dim = isDimmed(highlight, ref.slice(bay.sliceId), ref.cell(bay.ticketId));
  const mast = project({ x: x + 10, y: y + 10, z: PLATE_Z + 2 });
  // Spec b.2: a reserved bay is the cell outline only, dashed, with "Reserved" lettered, at dimmed
  // opacity, never heavier than a working bay. Its slice's wait is still marked, at the mast corner.
  return (
    <g aria-hidden="true" style={{ opacity: dim ? dimmedOpacity * 0.6 : 1 }}>
      <g style={{ opacity: dimmedOpacity + 0.17 }}>
        <BayOutline x={x} y={y} />
      </g>
      <g style={{ opacity: dimmedTextOpacity + 0.1 }}>
        <FloorLettering at={{ x: x + 14, y: y + CELL_D - 12, z: PLATE_Z }} text={bay.ticketId} size={lod === "far" ? 14 : 10} font="mono" tone="subtle" weight={500} decorative />
        {lod !== "far" ? (
          <FloorLettering at={{ x: x + 14, y: y + CELL_D - 28, z: PLATE_Z }} text={known ? (waiting ? `Reserved · ${bay.sliceId} waits on a dependency` : `Reserved · ${bay.sliceId}`) : "Reserved"} size={8.5} font="sans" tone={waiting ? "wait" : "subtle"} weight={600} decorative />
        ) : null}
      </g>
      {known ? (
        <g transform={`translate(${round(mast.x)} ${round(mast.y)})`}>
          <StateMark state={waiting ? "waiting" : "idle"} r={lod === "far" ? 6 : 4.5} />
        </g>
      ) : null}
    </g>
  );
}

function BayOutline({ x, y }: { x: number; y: number }) {
  return (
    <g transform={planeTransform(PLATE_Z)}>
      <rect x={x} y={y} width={CELL_W} height={CELL_D} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: planeStroke, strokeDasharray: "6 4" }} />
      <path
        d={`M${x} ${y + 12}V${y}H${x + 12}M${x + CELL_W - 12} ${y}H${x + CELL_W}V${y + 12}M${x + CELL_W} ${y + CELL_D - 12}V${y + CELL_D}H${x + CELL_W - 12}M${x + 12} ${y + CELL_D}H${x}V${y + CELL_D - 12}`}
        style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.2 * planeStroke }}
      />
    </g>
  );
}

/** A bay slot no slice uses: marked out on the floor, with the factory's capacity painted in it. */
export function FreeBay({ slot, maxParallel }: { slot: { x: number; y: number; index: number }; maxParallel: number | null }) {
  const { lod } = useAtlas();
  const { x, y } = slot;
  return (
    <g aria-hidden="true">
      <g style={{ opacity: dimmedOpacity + 0.17 }}>
        <BayOutline x={x} y={y} />
      </g>
      {lod !== "far" ? (
        <g style={{ opacity: dimmedTextOpacity + 0.1 }}>
          <FloorLettering at={{ x: x + 14, y: y + 26, z: PLATE_Z }} text={`Bay ${slot.index + 1} · free`} size={9} font="sans" tone="subtle" weight={600} decorative />
          {maxParallel !== null ? <FloorLettering at={{ x: x + 14, y: y + 40, z: PLATE_Z }} text={`At most ${maxParallel} cells at once (max_parallel)`} size={8} font="sans" tone="subtle" weight={500} decorative /> : null}
          <PlanDimension from={{ x, y: y + CELL_D, z: PLATE_Z }} to={{ x: x + CELL_W, y: y + CELL_D, z: PLATE_Z }} offset={14} label="216 pu · one worktree per ticket" />
        </g>
      ) : null}
    </g>
  );
}

function LiveBay({ bay, cell, visible }: { bay: BaySlot; cell: CellState; visible: boolean }) {
  const { lod, layout: L, lightLayer } = useAtlas();
  const highlight = useHighlight();
  const ticket = cell.ticketId;
  // Re-render with the playhead only while one of this cell's animations runs.
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.fixture, now, (e) => e.ticket_id === ticket)) return now;
    const c = sceneAt(s.fixture, now).cells[ticket];
    if (!c) return "none";
    // Settled: nothing in the cell's picture depends on the playhead until its next event.
    return `${c.activeAgentIds.length}`;
  });
  const reduced = useSceneStore((s) => s.reducedMotion);
  const exec = useScene((s) => {
    const c = s.cells[ticket];
    return c?.executionId ? s.executions[c.executionId] : undefined;
  });
  const vgate = useScene((s) => latestGate(s, "verification", ticket));
  const { x, y } = bay.origin;
  const cellRef = ref.cell(cell.ticketId);
  const dimCell = isDimmed(highlight, cellRef);
  const lamp = lightLayer ? 0 : q(lampLevel(cell, t, reduced));
  // No dial for open work: the machine's active state says "at work"; how far along is not known.
  const stationP = 0;
  const completion = cell.merged ? q(anim("cellComplete", t - cell.merged.at, reduced)) : 0;
  const agents = placeAgents(null, L, cell, t, reduced);
  const inBay = agents.filter((a) => a.at.z === FLOOR_Z).sort((a, b) => depthOf(a.at) - depthOf(b.at));

  if (!visible) {
    return <CellPlate origin={bay.origin} ticket={cell.ticketId} stage={uiStage(cell.stage)} lampIntensity={lamp} completion={completion} lod={lod} dimmed={dimCell} />;
  }

  const intent = machineState(cell, ["groom", "plan"]);
  const build = machineState(cell, ["build", "audit"]);
  const verify = machineState(cell, ["verify"]);
  const ver = cell.verifications[cell.verifications.length - 1];
  const verifyP = ver ? ver.checks.filter((c) => c.result !== "pending").length / Math.max(1, ver.checks.length) : 0;

  // Children in painter's order: things at the back (shelf, panel) first, then machines, agents.
  const kids: { depth: number; node: ReactNode }[] = [];
  kids.push({ depth: depthOf({ x: x + 16, y: y + 26 }), node: <Console key="console" bay={bay} cell={cell} exec={exec} t={t} reduced={reduced} lod={lod} /> });
  kids.push({ depth: depthOf({ x, y: y + 18 }), node: <Shelf key="shelf" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} highlight={highlight} /> });
  kids.push({ depth: depthOf({ x: x + 62, y: y + 82 }), node: <TaskBoard key="tasks" bay={bay} cell={cell} lod={lod} /> });
  kids.push({ depth: depthOf({ x: x + 168, y: y + 24 }), node: <ResultsRack key="results" bay={bay} cell={cell} lod={lod} t={t} reduced={reduced} /> });
  const machine = (key: string, kind: "plan" | "build" | "verify", at: Vec3, st: { state: FactoryState; round?: number }, p: number, station: "plan" | "build" | "verify") => {
    const sref = ref.station(station, cell.ticketId);
    return {
      depth: depthOf(at),
      node: (
        <StationMachine key={key} nameplate showLabel={false} label={kind === "plan" ? "Plan" : kind === "build" ? "Build" : "Verify"} kind={kind} state={st.state} progress={q(p)} round={st.round} at={at} lod={lod} dimmed={!dimCell && isDimmed(highlight, cellRef, sref)} />
      ),
    };
  };
  kids.push(machine("m-intent", "plan", bay.pads.intent, intent, cell.station === "plan" ? stationP : 0, "plan"));
  kids.push(machine("m-build", "build", bay.pads.build, build, cell.station === "build" ? stationP : 0, "build"));
  kids.push(machine("m-verify", "verify", bay.pads.verify, verify, cell.station === "verify" ? verifyP : 0, "verify"));
  kids.push({ depth: depthOf({ x, y: y + 118 }), node: <Ticker key="ticker" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} /> });
  kids.push({ depth: depthOf({ x, y: y + 128 }), node: <Branch key="branch" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} /> });
  for (const a of inBay) kids.push({ depth: depthOf(a.at) + 0.5, node: <AgentFigure key={a.agent.id} placed={a} lod={lod} dimmed={!dimCell && isDimmed(highlight, cellRef, ref.agent(a.agent.id))} proxied /> });
  kids.sort((a, b) => a.depth - b.depth);

  return (
    <g>
      <CellPlate origin={bay.origin} ticket={cell.ticketId} slice={cell.sliceId} stage={uiStage(cell.stage)} lampIntensity={lamp} completion={completion} progress={q(stationP)} lod={lod} dimmed={dimCell} rail>
        {kids.map((k) => k.node)}
      </CellPlate>
      <VerificationGate bay={bay} gate={vgate} t={t} reduced={reduced} lod={lod} dimmed={dimCell} />
      <VerifyLoop bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} dimmed={dimCell} />
      <BayHits items={bayHits(bay, cell, inBay, vgate, lod, t, reduced, { intent, build, verify })} />
    </g>
  );
}

interface HitItem {
  entity: EntityRef;
  label: string;
  box: PlanBox;
}

/**
 * The bay's hit targets, drawn after its picture as transparent proxies, in the spec's reading
 * order (f.11): the cell, its machines in belt order, the agents, the artifacts, then the task
 * board, the results rack, the verdict gate and a findings card in flight. Drawing them last also
 * puts them on top for pointing, so the picture itself can stay in painter's order.
 */
function bayHits(bay: BaySlot, cell: CellState, agents: PlacedAgent[], gate: GateState | null, lod: Lod, t: number, reduced: boolean, st: Record<"intent" | "build" | "verify", { state: FactoryState; round?: number }>): HitItem[] {
  const { x, y } = bay.origin;
  const T = cell.ticketId;
  const items: HitItem[] = [{ entity: ref.cell(T), label: `Cell ${T}, ${cell.title}: ${cell.stage}, round ${cell.round} of 3`, box: { x, y, w: CELL_W, d: CELL_D, z: FLOOR_Z, h: 0 } }];
  const machine = (pad: "intent" | "build" | "verify", station: "plan" | "build" | "verify", name: string, h: number) => {
    const s = st[pad];
    items.push({ entity: ref.station(station, T), label: `${name} station, ${T}: ${s.state}${s.round ? `, round ${s.round} of 3` : ""}`, box: boxAt(bay.pads[pad], 40, 40, h) });
  };
  machine("intent", "plan", "Plan", 12);
  machine("build", "build", "Build", 22);
  machine("verify", "verify", "Verify", 18);
  for (const a of [...agents].sort((m, n) => m.at.x - n.at.x)) {
    items.push({ entity: ref.agent(a.agent.id), label: `${agentName(a)}${a.agent.role === "reviewer" ? " reviewer" : ""}, ${modelTiers[uiTier(a.agent.model)].label}, ${T}: ${a.agent.status === "running" ? "working" : a.agent.status}`, box: boxAt(a.at, 18, 18, modelTiers[uiTier(a.agent.model)].height + 8) });
  }
  if (lod !== "far") {
    for (const { artifact: a, at } of shelfSlots(bay, cell)) {
      items.push({ entity: ref.artifact(a.id), label: `Artifact ${a.label} (${a.path}), written ${a.writer.agentId ? "by an agent" : "by a script"}`, box: { x: at.x - 7, y: at.y - 1.5, w: 14, d: 3, z: FLOOR_Z, h: 18 } });
    }
    if (cell.tasks.length) {
      const green = cell.tasks.filter((k) => k.status === "green" || k.status === "done").length;
      const red = cell.tasks.filter((k) => k.status === "red").length;
      items.push({ entity: `gate:${T}/red-before-green`, label: `Red before green, ${T}: ${cell.tasks.length} tasks, ${red} seen failing first, ${green} passing`, box: { x: x + 60, y: y + 80, w: 38, d: Math.ceil(cell.tasks.length / 5) * 6.4 + 2, z: FLOOR_Z, h: 1 } });
    }
  }
  // The verdict gate and its results rack are one entity: the gate carries the checks in its name.
  const v = gateView(gate, t, reduced);
  const ver = cell.verifications[cell.verifications.length - 1];
  const checks = ver ? `, ${ver.checks.filter((c) => c.result === "pass").length} of ${ver.checks.length} checks passed` : "";
  items.push({ entity: `gate:${gate ? gate.id : `${T}/verification#1`}`, label: `Verification verdict gate, ${T}: ${v.position}${gate ? `, round ${gate.round}` : ""}${checks}`, box: boxAt(bay.gate, 8, 46, 36) });
  return items;
}

function BayHits({ items }: { items: HitItem[] }) {
  return (
    <g>
      {items.map((it) => {
        const f = prismFaces(it.box);
        const pts = (it.box.h ?? 0) > 0 ? [f.top[0]!, f.top[1]!, f.shade[3]!, f.shade[2]!, f.lit[3]!, f.top[3]!] : f.top;
        return (
          <Hit key={it.entity} entity={it.entity} label={it.label}>
            <polygon points={toPoints(pts)} style={{ fill: "transparent" }} />
          </Hit>
        );
      })}
    </g>
  );
}

/** The artifacts standing on the shelf and where: the most recent ones, oldest first. */
function shelfSlots(bay: BaySlot, cell: CellState): { artifact: CellState["artifacts"][number]; at: Vec3 }[] {
  const all = cell.artifacts;
  const slots = 7;
  const shown = all.length > slots ? all.slice(all.length - (slots - 1)) : all;
  const offset = all.length > shown.length ? 1 : 0;
  return shown.map((artifact, i) => ({ artifact, at: { x: bay.origin.x + 34 + (i + offset) * 19, y: bay.origin.y + 18, z: FLOOR_Z } }));
}

/** The line console at the entrance, and the wall panel showing the belt workflow's phases. */
function Console({ bay, cell, exec, t, reduced, lod }: { bay: BaySlot; cell: CellState; exec: ExecutionState | undefined; t: number; reduced: boolean; lod: Lod }) {
  const { x, y } = bay.origin;
  const running = Boolean(exec && exec.workflowRunning);
  const phaseIdx = cell.workflowPhase ? BELT_PHASES.indexOf(cell.workflowPhase) : -1;
  const lit = exec?.startedAt != null ? q(anim("pathDraw", t - exec.startedAt, reduced)) : 0;
  const c = bay.console;
  return (
    <g>
      <Prism box={{ x: c.x - 7, y: c.y - 6, w: 14, d: 12, z: FLOOR_Z, h: 9 }} top={running ? "live-soft" : "plate-top"} edge={running ? "live" : "plate-edge"} hatch="shade">
        <path d={`M${c.x - 4} ${c.y - 2}h8M${c.x - 4} ${c.y + 1}h5`} aria-hidden="true" style={{ stroke: running ? fc("live") : fc("ink-soft"), strokeWidth: planeStroke }} />
      </Prism>
      {/* The wall panel: seven phase lamps of mach:belt on the back wall's inner face. */}
      <g transform={uprightTransform({ x: x + 162, y: y + 4, z: FLOOR_Z }, 14)} aria-hidden="true">
        <rect x={0} y={2} width={50} height={9} rx={1} style={{ fill: fc("plate-top"), stroke: running ? fc("live") : fc("plate-edge"), strokeWidth: 0.8 }} />
        {BELT_PHASES.map((ph, i) => {
          const done = phaseIdx > i || (!running && exec?.workflowFinishedAt != null && phaseIdx >= i);
          const now = running && phaseIdx === i;
          const fill = now ? fc("live") : done ? fc("pass") : "transparent";
          return <rect key={ph} x={3 + i * 6.6} y={4.5} width={4} height={4} style={{ fill, stroke: now ? fc("live") : done ? fc("pass") : fc("ink-soft"), strokeWidth: 0.6, opacity: running || done ? Math.max(0.25, lit) : 0.6 }} />;
        })}
      </g>
      {lod === "near" ? (
        <FloorLettering at={{ x: x + 162, y: y + 14, z: FLOOR_Z }} text={running ? `mach:belt · ${cell.workflowPhase ?? "Preflight"}` : exec ? "mach:belt · idle" : "no execution"} size={6.5} font="mono" tone={running ? "live" : "subtle"} weight={500} decorative />
      ) : null}
    </g>
  );
}

/** The back shelf: artifacts in the order written; older ones collapse into a counted stack. */
function Shelf({ bay, cell, t, reduced, lod, highlight }: { bay: BaySlot; cell: CellState; t: number; reduced: boolean; lod: Lod; highlight: ReadonlySet<string> }) {
  const { x, y } = bay.origin;
  const all = cell.artifacts;
  if (lod === "far") {
    return all.length ? (
      <FloorLettering at={{ x: x + 30, y: y + 22, z: FLOOR_Z }} text={`${all.length} files`} size={12} font="mono" tone="muted" weight={500} decorative />
    ) : null;
  }
  const slots = shelfSlots(bay, cell);
  const hidden = all.length - slots.length;
  const stackAt = { x: x + 34, y: y + 18, z: FLOOR_Z };
  return (
    <g>
      {hidden > 0 ? (
        <g aria-hidden="true">
          {/* Earlier files: one sheet with a drafted edge behind it, and the count. */}
          <path d={`M${round(project({ ...stackAt, x: stackAt.x - 9 }).x)} ${round(project({ ...stackAt, x: stackAt.x - 9, z: FLOOR_Z + 16 }).y)}h-2v${round(18 * 0.82)}`} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.8 }} />
          <ArtifactCard kind={uiArtifact(all[hidden - 1]?.kind ?? "plan")} at={stackAt} lod="mid" showLabel={false} />
          <FloorLettering at={{ x: stackAt.x - 8, y: stackAt.y + 9, z: FLOOR_Z }} text={`+${hidden}`} size={7.5} font="mono" tone="muted" weight={600} decorative />
        </g>
      ) : null}
      {slots.map(({ artifact: a, at }) => {
        const p = q(anim("artifactMaterialise", t - a.writtenAt, reduced));
        const aref = ref.artifact(a.id);
        const failed = a.kind === "verification-findings" || (a.kind === "review-findings" && cell.reviews.some((r) => r.outcome === "REJECTED" && r.round === a.round));
        return <ArtifactCard key={a.id} kind={uiArtifact(a.kind)} state={failed ? "failed" : "succeeded"} progress={p} file={a.label} at={at} lod={lod} showLabel={false} dimmed={highlight.size > 0 && !highlight.has(aref) && !highlight.has(ref.cell(cell.ticketId))} />;
      })}
    </g>
  );
}

/** Red before green: one chip per build task, a test task fills red when seen failing, an implementation green when the suite passes. */
function TaskBoard({ bay, cell, lod }: { bay: BaySlot; cell: CellState; lod: Lod }) {
  if (lod === "far" || cell.tasks.length === 0) return null;
  const { x, y } = bay.origin;
  const tasks: TaskCell[] = cell.tasks.map((k) => (k.status === "active" ? "active" : k.status === "red" ? "red" : "green"));
  // Upright on two legs on the clear floor between the plan bench and the build machine.
  return <TaskBoardMark tasks={tasks} at={{ x: x + 58, y: y + 84, z: FLOOR_Z }} columns={6} lod={lod} />;
}

/** Verification results accumulating: one mark per check of the current round. */
function ResultsRack({ bay, cell, lod, t, reduced }: { bay: BaySlot; cell: CellState; lod: Lod; t: number; reduced: boolean }) {
  const ver = cell.verifications[cell.verifications.length - 1];
  if (!ver || lod === "far") return null;
  const { x, y } = bay.origin;
  return (
    <g aria-hidden="true">
      <g>
        {ver.checks.map((c, i) => {
          const p = project({ x: x + 172 + (i % 5) * 8.4, y: y + 22 + Math.floor(i / 5) * 8.4, z: FLOOR_Z });
          const settle = c.at !== null ? anim("testResult", t - c.at, reduced) : 1;
          const state: FactoryState = c.result === "pass" ? "succeeded" : c.result === "fail" ? "failed" : "idle";
          return (
            <g key={c.targetId} transform={`translate(${round(p.x)} ${round(p.y - 2 * settle)})`} style={{ opacity: c.result === "pending" ? 0.7 : Math.min(1, 0.3 + settle) }}>
              <StateMark state={state} r={2.9} />
            </g>
          );
        })}
      </g>
    </g>
  );
}

/** Tool calls accumulate along the ticker; past 24, the oldest merge into a counted density bar. */
function Ticker({ bay, cell, t, reduced, lod }: { bay: BaySlot; cell: CellState; t: number; reduced: boolean; lod: Lod }) {
  const { x, y } = bay.origin;
  const calls = callsOf(cell);
  if (calls.length === 0) return null;
  const tickerY = y + CELL_D - 30;
  const x0 = x + 16;
  const x1 = x + CELL_W - 24;
  const span = x1 - x0;
  const MAX = 24;
  const merged = calls.length > MAX ? calls.length - 12 : 0;
  const shown = merged > 0 ? calls.slice(merged) : calls;
  const slotX = (i: number) => x0 + ((i + (merged > 0 ? 12 : 0)) / (MAX - 1)) * span;
  const bar = merged > 0 || lod === "far";
  const barEnd = lod === "far" ? x1 : x0 + (11 / (MAX - 1)) * span;
  const running = calls.filter((c) => c.status === "running").length;
  return (
    <g role="img" aria-label={`${calls.length} tool calls in ${cell.ticketId}, ${running} running`}>
      {bar ? (
        <g transform={planeTransform(FLOOR_Z)} aria-hidden="true">
          <line x1={x0} y1={tickerY} x2={barEnd} y2={tickerY} style={{ stroke: fc("ink"), strokeWidth: 1.5 * planeStroke }} />
          <path d={Array.from({ length: Math.floor((barEnd - x0) / 2) + 1 }, (_, i) => `M${x0 + i * 2} ${tickerY - 1.6}v1.6`).join("")} style={{ stroke: fc("ink-soft"), strokeWidth: 0.5 * planeStroke }} />
          <text x={x0} y={tickerY + 7} style={{ fill: "var(--mach-ink-muted)", fontSize: lod === "far" ? 10 : 6.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
            {lod === "far" ? `${calls.length} calls` : `${merged} calls`}
          </text>
        </g>
      ) : null}
      {lod !== "far"
        ? shown.map((c, i) => {
            const newest = i === shown.length - 1;
            const p = newest ? q(anim("toolTick", t - c.startedAt, reduced)) : 1;
            const state: FactoryState = c.status === "running" ? "active" : c.status === "error" ? "failed" : "succeeded";
            return <ToolTick key={c.id} family={toolFamily(c)} state={state} progress={p} detail={c.target} at={{ x: slotX(i), y: tickerY, z: FLOOR_Z }} />;
          })
        : null}
    </g>
  );
}

/** The feature branch: a line on the floor with one node per commit, the newest rising in. */
function Branch({ bay, cell, t, reduced, lod }: { bay: BaySlot; cell: CellState; t: number; reduced: boolean; lod: Lod }) {
  if (lod === "far") return null;
  const commits = cell.artifacts.filter((a) => a.kind === "commit");
  const { x, y } = bay.origin;
  const by = y + CELL_D - 18;
  const x0 = x + 100;
  const x1 = x + CELL_W - 14;
  const step = Math.min(9, (x1 - x0 - 6) / Math.max(1, commits.length));
  return (
    <g transform={planeTransform(FLOOR_Z)} aria-hidden="true">
      <line x1={x0} y1={by} x2={x1} y2={by} style={{ stroke: cell.merged ? fc("pass") : fc("ink-soft"), strokeWidth: planeStroke }} />
      {cell.merged ? <path d={`M${x1 - 3} ${by - 2.5}L${x1} ${by}L${x1 - 3} ${by + 2.5}`} style={{ fill: "none", stroke: fc("pass"), strokeWidth: planeStroke }} /> : null}
      {/* Settled commits as one path of rings; only the newest, while it rises in, is its own element. */}
      <path
        d={commits
          .map((c, i) => ({ c, cx: x0 + 4 + i * step }))
          .filter(({ c }) => anim("artifactMaterialise", t - c.writtenAt, reduced) >= 1)
          .map(({ cx }) => `M${round(cx - 1.9)} ${by}a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0`)
          .join("")}
        style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 0.9 * planeStroke }}
      />
      {commits.map((c, i) => {
        const p = anim("artifactMaterialise", t - c.writtenAt, reduced);
        return p < 1 ? <circle key={c.id} cx={x0 + 4 + i * step} cy={by} r={1.9 * Math.max(0.2, p)} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 0.9 * planeStroke }} /> : null;
      })}
      {lod === "near" ? (
        <text x={x0 - 3} y={by + 1.8} textAnchor="end" style={{ fill: "var(--mach-ink-subtle)", fontSize: 5.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
          {cell.branch}
        </text>
      ) : null}
    </g>
  );
}

export function agentName(placed: PlacedAgent): string {
  const a = placed.agent;
  const role = a.role === "reviewer" && a.seat && a.seat !== "general" ? reviewerSeats[a.seat].label : a.role === "clerk" ? "Clerk" : a.role === "intent" ? "Plan worker" : a.role === "merge" ? "Merge worker" : a.role === "cleanup" ? "Cleanup worker" : agentRoles[uiRole(a)].label;
  return role;
}

export function AgentFigure({ placed, lod, dimmed, proxied }: { placed: PlacedAgent; lod: Lod; dimmed: boolean; proxied?: boolean }) {
  const a = placed.agent;
  const seat = a.seat && a.seat !== "general" ? a.seat : undefined;
  const figure = <AgentMarker agentRole={uiRole(a)} tier={uiTier(a.model)} seat={seat} state={placed.state} progress={placed.progress} arrive={placed.arrive} leave={placed.leave} at={placed.at} lod={lod} dimmed={dimmed} showLabel={false} />;
  if (proxied) return figure;
  return (
    <Hit entity={ref.agent(a.id)} label={`${agentName(placed)}${a.role === "reviewer" ? " reviewer" : ""}, ${modelTiers[uiTier(a.model)].label}, ${a.ticketId}: ${a.status === "running" ? "working" : a.status}`}>
      {figure}
    </Hit>
  );
}

/** The verdict gate outside the door: closes when verification starts, opens on PASS, refuses on a failure. */
function VerificationGate({ bay, gate: g, t, reduced, lod, dimmed }: { bay: BaySlot; gate: GateState | null; t: number; reduced: boolean; lod: Lod; dimmed: boolean }) {
  const v = gateView(g, t, reduced);
  return (
      <GateGlyph kind="verification" position={v.position} from={v.from} progress={v.progress} at={bay.gate} axis="y" lod={lod} dimmed={dimmed} showLabel={false} />
  );
}

/** The return to build after a failed verification: the dashed arc over the line, pips at its crest. */
function VerifyLoop({ bay, cell, t, reduced, lod, dimmed }: { bay: BaySlot; cell: CellState; t: number; reduced: boolean; lod: Lod; dimmed: boolean }) {
  const failed = [...cell.verifications].reverse().find((v) => v.status === "FAIL_WITH_EVIDENCE" && v.decidedAt !== null);
  if (!failed || failed.decidedAt === null) return null;
  const p = q(anim("verifyReturn", t - failed.decidedAt, reduced));
  const from = { ...bay.pads.verify, y: bay.pads.verify.y - 6, z: FLOOR_Z + 18 };
  const to = { ...bay.pads.build, y: bay.pads.build.y - 6, z: FLOOR_Z + 22 };
  const cardP = segment(p, 0.6, 1);
  const findings = cell.artifacts.find((a) => a.kind === "verification-findings" && a.round === failed.round);
  const ride = pointAlong(liftedArc(from, to, 34, 28), cardP).point;
  return (
    <g>
      <RetryLoop from={from} to={to} round={failed.round + 1} progress={p} lod={lod} dimmed={dimmed} />
      {p > 0.2 && p < 1 ? (
        findings ? (
          <g aria-hidden="true">
            <ArtifactCard kind="findings" state="failed" progress={segment(p, 0, 0.4)} at={cardP > 0 ? ride : { ...from, z: FLOOR_Z + 18 }} lod={lod} showLabel={false} />
          </g>
        ) : null
      ) : null}
    </g>
  );
}

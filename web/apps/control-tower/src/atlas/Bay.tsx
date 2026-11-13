/**
 * One construction cell as a place (spec b.3): the bay, its line console and wall panel (the
 * Dynamic Workflow's phases), the artifact shelf, the red-before-green task board, the machines on
 * the rail, the verification results rack, the tool ticker, the feature branch with its commits, the
 * agents at work, the verification gate outside the door and the retry loop over the line.
 * Before the slice is dispatched the bay stands reserved and empty.
 */
import { memo, useMemo, type ReactNode } from "react";
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
import { AgentHead, FloorLettering, PlanDimension, StationSymbol, TaskBoard as TaskBoardMark, cellAnatomy, cellStages, factoryTokens, lampPool, markLook, useFactoryIds, type MarkState, type StationKind, type TaskCell } from "@mach/ui";
import { BELT_PHASES, activityOf, capacityWaitOf, type CapacityWaitState, type GateRefusal, type ActivityState, agentTimingAt, isKnown, ref, visitTimingAt, type CellState, type EntityRef, type ExecutionState, type GateState, type SceneLog, type StationId } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { Hit, isDimmed, useAtlas, useHighlight, usePlayheadKeyed } from "./context";
import { activityMark, activityWord, visitMark, visitWord, animating, anim, callsOf, countedToolsOf, fmtElapsed, idOf, secondOf, lampLevel, gateView, gateWord, latestGate, placeAgents, q, toolFamily, uiArtifact, uiRole, uiTier, type PadName, type PlacedAgent, type ViewMode } from "./derive";
import { FLOOR_Z, PLATE_Z, boxAt, type BaySlot, type PlantLayout } from "./layout";
import { Card } from "./reduced";

const CELL_W = 216;
const CELL_D = 148;

function uiStage(stage: CellState["stage"]): UiStage {
  return stage === "spec-open" ? "interview" : stage;
}

/**
 * A machine's state, from the visits to the station it is named for (D3). Passed only once a visit to
 * that station has exited with a passing outcome; a station not yet visited is not reached (idle,
 * drawn planned) whatever the cell's stage says and whatever its pad's other station did (a groom
 * that passed does not pass Plan; an audit does not pass Build). A visit that ended without an exit
 * record is interrupted, never working. While the cell is at one of the pad's stations the machine
 * works; live and replay, it shows what is known of the cell's activity when that is not "executing".
 * A cell with no recorded visits at all (its lifecycle log was not received) whose stage is past the
 * station is drawn "unknown": reconstructed from the stage, never a recorded pass.
 */
function machineState(cell: CellState, kinds: readonly StationId[], named: StationId, activity: ActivityState | null = null): MachineState {
  if (cell.station && kinds.includes(cell.station)) {
    return { state: activity && activity !== "executing" ? activityMark(activity) : "active", round: cell.round > 1 ? cell.round : undefined, word: cell.station === named ? undefined : `at ${cell.station}` };
  }
  const last = [...cell.visits].reverse().find((v) => v.station === named);
  if (!last) {
    if (cell.visits.length === 0 && stagePast(cell.stage, named)) return { state: "unknown", word: "reconstructed from the cell's stage, no visit recorded" };
    const other = [...cell.visits].reverse().find((v) => kinds.includes(v.station));
    return { state: "idle", word: other ? `not reached yet; ${other.station} ${other.leftAt === null ? "working" : `ended: ${visitWord(other)}`}` : "not reached yet" };
  }
  const round = last.round > 1 ? last.round : undefined;
  const state = visitMark(last);
  return { state, round, word: state === "succeeded" || state === "failed" || state === "active" ? undefined : visitWord(last) };
}

interface MachineState {
  state: MarkState;
  round?: number;
  /** Words for its accessible name when the state alone would mislead. */
  word?: string;
}

const STAGE_ORDER: readonly CellState["stage"][] = ["interview", "spec-open", "spec-ready", "planned", "building", "built", "verified", "awaiting-human", "approved", "pr-open", "merged"];
const STAGE_AFTER: Partial<Record<StationId, CellState["stage"]>> = { plan: "planned", build: "built", verify: "verified" };
function stagePast(stage: CellState["stage"], station: StationId): boolean {
  const after = STAGE_AFTER[station];
  return after !== undefined && STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(after);
}

export interface BayProps {
  bay: BaySlot;
  visible: boolean;
  /**
   * M6.2, a dense plant (more than six bays): this bay is drawn as its summary (plate, mast, machines
   * by symbol, agents as posts and heads) because it is at far zoom, or at mid zoom away from the
   * centre of the view while more than six bays are in it (spec b.6 and b.7; the element budgets).
   */
  summary?: boolean;
}

/** A bay subscribes to its own cell and the playhead; other bays do not re-render with it. */
export const Bay = memo(function Bay({ bay, visible, summary = false }: BayProps) {
  const cell = useScene((s) => s.cells[bay.ticketId]);
  const slice = useScene((s) => s.slices[bay.sliceId]);
  if (!cell) return <ReservedBay bay={bay} waiting={slice?.scheduler === "waiting-on-dependency"} known={Boolean(slice)} />;
  if (summary) return <SummaryBay bay={bay} cell={cell} visible={visible} />;
  return <LiveBay bay={bay} cell={cell} visible={visible} />;
});

/**
 * A bay at a dense plant's summary level of detail: the floor, the back walls as one line, the lamp,
 * the ticket, the mast with what is known of the cell's activity, the three machines as tinted
 * footprints with their symbols, the verdict gate's state, and the agents as posts and heads (no
 * emblems, no ticks, no shelf, no ticker). Everything stays where the full bay draws it, so zooming
 * in or bringing it to the centre only adds detail. Hit targets: the cell, its machines and agents
 * when on screen; the cell alone when off screen (so the arrows can still reach it).
 */
function SummaryBay({ bay, cell, visible }: { bay: BaySlot; cell: CellState; visible: boolean }) {
  const { lod, layout: L, mode } = useAtlas();
  const highlight = useHighlight();
  const ids = useFactoryIds();
  const ticket = cell.ticketId;
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.log, now, (e) => idOf(e, "ticket_id") === ticket && (e.event.type === "agent.started" || e.event.type === "agent.finished" || e.event.type === "station.entered" || e.event.type === "station.exited" || e.event.type === "station.left"))) return now;
    // Settled: re-render only when an agent comes or goes or the lamp changes (no elapsed is lettered here).
    const c = s.log.sceneAt(now).cells[ticket];
    return c ? `${c.activeAgentIds.join(",")}|${c.station ?? "-"}` : "none";
  });
  const reduced = useSceneStore((s) => s.reducedMotion);
  const activity = useScene((s) => (mode.live ? activityOf(s, ref.cell(ticket), { stale: mode.stale }).state : null));
  const vgate = useScene((s) => latestGate(s, "verification", ticket));
  const { x, y } = bay.origin;
  const a = cellAnatomy(bay.origin, PLATE_Z);
  const dim = isDimmed(highlight, ref.cell(ticket));
  const lamp = q(lampLevel(cell, t, reduced));
  const completion = cell.merged ? q(anim("cellComplete", t - cell.merged.at, reduced)) : 0;
  const stage = cellStages[uiStage(cell.stage)];
  const mastState: MarkState = activity && !(activity === "completed" && cell.merged) ? activityMark(activity) : stage.state;
  const mastMark = activity && !(activity === "completed" && cell.merged) ? undefined : stage.mark;
  const floor = prismFaces({ x, y, w: CELL_W, d: CELL_D, z: PLATE_Z, h: 4 });
  const wallZ = FLOOR_Z + factoryTokens.elevation.cellRim;
  const walls = [project({ x, y: y + CELL_D, z: wallZ }), project({ x, y, z: wallZ }), project({ x: x + CELL_W, y, z: wallZ })];
  const mast = project(a.mast);
  const mastTop = project({ ...a.mast, z: a.mast.z + 20 });
  const pool = lampPool(bay.origin, PLATE_Z);
  const st = { intent: machineState(cell, ["groom", "plan"], "plan", activity), build: machineState(cell, ["build", "audit"], "build", activity), verify: machineState(cell, ["verify"], "verify", activity) };
  const agents = placeAgents(L, cell, t, reduced, mode).filter((p) => p.at.z === FLOOR_Z);
  const finished = Boolean(cell.merged);
  const machines: Array<[PadName, StationKind, number]> = [
    ["intent", "plan", 12],
    ["build", "build", 22],
    ["verify", "verify", 18],
  ];
  const gate: MarkState | null = vgate ? (vgate.state === "passed" || vgate.state === "skipped" || vgate.state === "overridden" ? "succeeded" : vgate.state === "failed" ? "failed" : vgate.state === "waiting" ? "human" : "active") : null;
  const gateTop = project({ ...bay.gate, z: (bay.gate.z ?? PLATE_Z) + 30 });
  return (
    <g>
      <g role="group" aria-label={`Cell ${ticket}: ${activity ? activityWord(activity) : stage.label}`} style={{ opacity: dim ? dimmedOpacity : 1 }}>
        <polygon aria-hidden="true" points={toPoints(floor.top)} style={{ fill: fc("floor"), stroke: fc("plate-edge"), strokeWidth: 0.8 }} />
        <g transform={planeTransform(FLOOR_Z)} aria-hidden="true">
          {lamp > 0 ? <ellipse cx={pool.cx} cy={pool.cy} rx={pool.rx} ry={pool.ry} style={{ fill: `url(#${ids.lamp})`, opacity: lamp }} /> : null}
          {completion > 0 ? <rect x={x} y={y} width={CELL_W} height={CELL_D} style={{ fill: fc("done"), opacity: completion }} /> : null}
          <text x={x + 14} y={y + CELL_D - 9} className="notranslate" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: lod === "far" ? 16 : 11, fontWeight: 500 }}>
            {ticket}
          </text>
        </g>
        <polyline aria-hidden="true" points={toPoints(walls)} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 1.4, strokeLinejoin: "round" }} />
        <line aria-hidden="true" x1={mast.x} y1={mast.y} x2={mastTop.x} y2={mastTop.y} style={{ stroke: fc("ink-soft"), strokeWidth: 1.2 }} />
        <g transform={`translate(${round(mastTop.x)} ${round(mastTop.y - 6)})`}>
          <StateMark state={mastState} mark={mastMark} r={lod === "far" ? 8 : 6} />
        </g>
        {machines.map(([pad, kind, h]) => {
          const at = bay.pads[pad];
          const look = markLook(st[pad].state);
          const top = prismFaces({ x: at.x - 18, y: at.y - 18, w: 36, d: 36, z: FLOOR_Z, h }).top;
          const c = project({ ...at, z: FLOOR_Z + h });
          const idle = st[pad].state === "idle" || finished;
          return (
            <g key={pad} aria-hidden="true">
              <polygon points={toPoints(top)} style={{ fill: idle ? fc("machine-top") : fc(look.soft), stroke: idle ? fc("plate-edge") : fc(look.ink), strokeWidth: 1 }} />
              <StationSymbol kind={kind} x={round(c.x)} y={round(c.y)} size={lod === "far" ? 18 : 14} color={idle ? fc("ink-soft") : fc(look.ink === "live" ? "live" : "ink")} strokeWidth={1.3} />
            </g>
          );
        })}
        {gate ? (
          <g aria-hidden="true" transform={`translate(${round(gateTop.x)} ${round(gateTop.y)})`}>
            <StateMark state={gate} r={lod === "far" ? 6 : 4.5} />
            {/* Overridden, not passed: the mark struck through (shape, not colour alone). */}
            {vgate?.state === "overridden" ? <path d="M-6 6L6 -6" style={{ stroke: fc("wait"), strokeWidth: 1.6, strokeLinecap: "round" }} /> : null}
          </g>
        ) : null}
        {agents.map((p) => (
          <AgentPost key={p.agent.id} placed={p} />
        ))}
      </g>
      {visible ? (
        <BayHits items={bayHits(bay, cell, agents, vgate, "far", st, activity ? activityWord(activity) : undefined).filter((it) => !it.entity.startsWith("gate:"))} />
      ) : (
        <BayHits items={bayHits(bay, cell, [], vgate, "far", st, activity ? activityWord(activity) : undefined).slice(0, 1)} />
      )}
    </g>
  );
}

/** An agent at the summary level: its post and head only (spec b.6: agents drop role emblems at a dense plant). */
export function AgentPost({ placed }: { placed: PlacedAgent }) {
  const a = placed.agent;
  const tier = modelTiers[uiTier(a.model)];
  const present = (placed.reduced ? 1 : placed.arrive) * (1 - (placed.reduced ? 0 : placed.leave));
  const base = project(placed.at);
  const top = project({ ...placed.at, z: (placed.at.z ?? 0) + tier.height * (placed.reduced ? 1 : present) });
  const look = markLook(placed.state);
  const condition = placed.state === "interrupted" || placed.state === "stale" || placed.state === "unknown";
  const fill = placed.state === "active" ? fc("live") : condition || placed.open ? fc("plate-top") : fc(look.soft);
  const opacity = placed.reduced ? q(Math.max(0, Math.min(1, placed.arrive * (1 - placed.leave)))) : Math.min(1, present * 1.6);
  return (
    <g aria-hidden="true" style={{ opacity }}>
      <line x1={base.x} y1={base.y} x2={top.x} y2={top.y} style={{ stroke: fc(look.ink === "ink-soft" ? "ink" : look.ink), strokeWidth: 1.6, strokeLinecap: "round", strokeDasharray: placed.open ? "2 2" : placed.state === "stale" ? "0.1 2.6" : undefined }} />
      <g transform={`translate(${round(top.x)} ${round(top.y - 4)})`}>
        {placed.tierKnown ? <AgentHead tier={uiTier(a.model)} fill={fill} stroke={fc(look.ink)} /> : <circle r={4.4} style={{ fill, stroke: fc(look.ink), strokeWidth: 1.2, strokeDasharray: "1.6 1.4" }} />}
        {condition ? (
          <g transform="translate(7 -7)">
            <StateMark state={placed.state} r={4.2} />
          </g>
        ) : null}
      </g>
    </g>
  );
}

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
        <FloorLettering at={{ x: x + 14, y: y + CELL_D - 12, z: PLATE_Z }} text={known ? bay.ticketId : `Bay ${bay.index + 1}`} size={lod === "far" ? 14 : 10} font={known ? "mono" : "sans"} tone="subtle" weight={500} decorative />
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

/** Whether the scene log records the round's list of targets (the verification dial's denominator). */
function targetsListed(log: SceneLog, ticket: string, round: number): boolean {
  return log.entriesFor(ref.cell(ticket)).some((e) => e.event.type === "verify.targets_listed" && ((e.event as unknown as { ids?: { round?: number | null } }).ids?.round ?? round) === round);
}

function LiveBay({ bay, cell, visible }: { bay: BaySlot; cell: CellState; visible: boolean }) {
  const { lod, layout: L, mode } = useAtlas();
  const highlight = useHighlight();
  const ticket = cell.ticketId;
  // Re-render with the playhead only while one of this cell's animations runs.
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.log, now, (e) => idOf(e, "ticket_id") === ticket)) return now;
    const c = s.log.sceneAt(now).cells[ticket];
    if (!c) return "none";
    // Settled: the picture changes only at the next event, or when the elapsed time of a working
    // agent or of the current station passes another second. The ticks change once a minute, but the
    // elapsed time is also lettered and in the accessible names ("Build: Working, for 6 min 56 s"),
    // so it is re-rendered at every second it shows; otherwise the name would depend on how the
    // playhead got here (findings D8). Keyed on what is shown, so this is still a pure function of t.
    const visit = c.station ? c.visits[c.visits.length - 1] : undefined;
    let k = visit && visit.leftAt === null ? String(secondOf(visitTimingAt(visit, now).elapsed)) : "-";
    for (const id of c.activeAgentIds) k += `,${secondOf(agentTimingAt(c.agents[id]!, now).elapsed)}`;
    return k;
  });
  const reduced = useSceneStore((s) => s.reducedMotion);
  const exec = useScene((s) => {
    const c = s.cells[ticket];
    return c?.executionId ? s.executions[c.executionId] : undefined;
  });
  const vgate = useScene((s) => latestGate(s, "verification", ticket));
  // Live and replay: what is known about the cell's activity (the nine states; stale on a stale connection).
  const activity = useScene((s) => (mode.live ? activityOf(s, ref.cell(ticket), { stale: mode.stale }).state : null));
  const queued = useScene((s) => (mode.live && cell.executionId ? Object.values(s.executions[cell.executionId]?.queued ?? {}).length : 0));
  const log = useSceneStore((s) => s.log);
  // Recorded facts no gate state or stage stands for: a wait for an execution place, and gate
  // refusals with no matching gate (build.start, verify.start, merge.run...). Drawn, never folded away.
  const wait = useScene((s) => capacityWaitOf(s, ticket));
  // From the cell's own gate log (the same object until the cell changes): never a new array per read.
  const refusals = useMemo(() => cell.gateLog.filter((g) => g.verdict === "refused" && g.gateId === null).map((g) => ({ ...g, ticketId: ticket })), [cell.gateLog, ticket]);
  const { x, y } = bay.origin;
  const cellRef = ref.cell(cell.ticketId);
  const dimCell = isDimmed(highlight, cellRef);
  const lamp = q(lampLevel(cell, t, reduced));
  // Work in flight is "working, for this long" (spec principle 7): elapsed, never a fill.
  const visit = cell.station ? cell.visits[cell.visits.length - 1] : undefined;
  const stationElapsed = visit && visit.leftAt === null && isKnown(visit.meta, "enteredAt") ? visitTimingAt(visit, t).elapsed : undefined;
  const elapsedInferred = visit?.meta.start === "inferred";
  const finished = Boolean(cell.merged);
  const completion = cell.merged ? q(anim("cellComplete", t - cell.merged.at, reduced)) : 0;
  const agents = placeAgents(L, cell, t, reduced, mode);
  const inBay = agents.filter((a) => a.at.z === FLOOR_Z).sort((a, b) => depthOf(a.at) - depthOf(b.at));
  // The mast shows what is known about the cell's activity (live, replay); a merged cell keeps its double ring.
  const mast = activity && !(activity === "completed" && cell.merged) ? { state: activityMark(activity), label: activityWord(activity) } : undefined;

  if (!visible) {
    return <CellPlate origin={bay.origin} ticket={cell.ticketId} stage={uiStage(cell.stage)} activity={mast} lampIntensity={lamp} completion={completion} lod={lod} dimmed={dimCell} />;
  }

  const intent = machineState(cell, ["groom", "plan"], "plan", activity);
  const build = machineState(cell, ["build", "audit"], "build", activity);
  const verify = machineState(cell, ["verify"], "verify", activity);

  // At far zoom a finished bay, once settled, is its plate alone: the calm done floor, its ticket and
  // the mast's double ring say all there is to say from that distance (spec b.3, "finished work is
  // calm"; the far element budget). Its parts stay selectable and keep their names.
  if (lod === "far" && finished && completion >= 1) {
    return (
      <g>
        <CellPlate origin={bay.origin} ticket={cell.ticketId} slice={cell.sliceId} stage={uiStage(cell.stage)} activity={mast} lampIntensity={lamp} completion={completion} lod={lod} dimmed={dimCell} rail />
        <BayHits items={bayHits(bay, cell, inBay, vgate, lod, { intent, build, verify }, mast?.label, noticesWords(wait, refusals))} />
      </g>
    );
  }
  const ver = cell.verifications[cell.verifications.length - 1];
  // A real denominator: checks proven of checks declared. Live and replay: only when the round's
  // list of targets is recorded (verify.targets_listed); otherwise the dial shows no fraction.
  const verifyFraction = ver && (!mode.live || targetsListed(log, ticket, ver.round)) ? { done: ver.checks.filter((c) => c.result === "pass").length, of: ver.checks.length } : undefined;

  // Children in painter's order: things at the back (shelf, panel) first, then machines, agents.
  const kids: { depth: number; node: ReactNode }[] = [];
  // The line console and its phase panel are detail: not at far zoom (spec b.7; the far element budget).
  if (lod !== "far") kids.push({ depth: depthOf({ x: x + 16, y: y + 26 }), node: <Console key="console" bay={bay} cell={cell} exec={exec} t={t} reduced={reduced} lod={lod} queued={queued} stale={mode.stale} /> });
  kids.push({ depth: depthOf({ x, y: y + 18 }), node: <Shelf key="shelf" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} highlight={highlight} /> });
  kids.push({ depth: depthOf({ x: x + 62, y: y + 82 }), node: <TaskBoard key="tasks" bay={bay} cell={cell} lod={lod} /> });
  kids.push({ depth: depthOf({ x: x + 168, y: y + 24 }), node: <ResultsRack key="results" bay={bay} cell={cell} lod={lod} t={t} reduced={reduced} /> });
  const machine = (key: string, kind: "plan" | "build" | "verify", at: Vec3, st: MachineState, station: "plan" | "build" | "verify", fraction?: { done: number; of: number }) => {
    const sref = ref.station(station, cell.ticketId);
    const here = cell.station === station || (station === "plan" && cell.station === "groom") || (station === "build" && cell.station === "audit");
    return {
      depth: depthOf(at),
      node: (
        <StationMachine
          key={key}
          nameplate
          showLabel={false}
          label={kind === "plan" ? "Plan" : kind === "build" ? "Build" : "Verify"}
          kind={kind}
          state={st.state}
          elapsed={here ? stationElapsed : undefined}
          fraction={fraction}
          settled={finished}
          planned={st.state === "idle"}
          round={st.round}
          at={at}
          lod={lod}
          dimmed={!dimCell && isDimmed(highlight, cellRef, sref)}
        />
      ),
    };
  };
  kids.push(machine("m-intent", "plan", bay.pads.intent, intent, "plan"));
  kids.push(machine("m-build", "build", bay.pads.build, build, "build"));
  kids.push(machine("m-verify", "verify", bay.pads.verify, verify, "verify", verifyFraction));
  kids.push({ depth: depthOf({ x, y: y + 118 }), node: <Ticker key="ticker" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} mode={mode} /> });
  kids.push({ depth: depthOf({ x, y: y + 128 }), node: <Branch key="branch" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} /> });
  for (const a of inBay) kids.push({ depth: depthOf(a.at) + 0.5, node: <AgentFigure key={a.agent.id} placed={a} lod={lod} dimmed={!dimCell && isDimmed(highlight, cellRef, ref.agent(a.agent.id))} proxied /> });
  kids.sort((a, b) => a.depth - b.depth);

  return (
    <g>
      <CellPlate origin={bay.origin} ticket={cell.ticketId} slice={cell.sliceId} stage={uiStage(cell.stage)} activity={mast} lampIntensity={lamp} completion={completion} elapsed={stationElapsed} elapsedInferred={elapsedInferred} lod={lod} dimmed={dimCell} rail>
        {kids.map((k) => k.node)}
        {cell.historyBegan && lod !== "far" ? (
          // History begins part-way (history.began): said on the floor, beside the ticket.
          <FloorLettering at={{ x: x + 14, y: y + CELL_D - 24, z: FLOOR_Z }} text={`history from ${clock(cell.historyBegan.at)} · reconstructed`} size={6.5} font="mono" tone="subtle" weight={500} decorative />
        ) : null}
        {lod !== "far" ? <Notices x={x} y={y} wait={wait} refusals={refusals} overrides={overridesOf(cell)} lines={lod === "near" || L.bays.length <= 6 ? 3 : 1} /> : null}
      </CellPlate>
      {/* An unbuilt verdict gate (the cell has not reached verification) is not drawn at far zoom. */}
      {vgate || lod !== "far" ? <VerificationGate bay={bay} gate={vgate} t={t} reduced={reduced} lod={lod} dimmed={dimCell} /> : null}
      <VerifyLoop bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} dimmed={dimCell} />
      <BayHits items={bayHits(bay, cell, inBay, vgate, lod, { intent, build, verify }, mast?.label, noticesWords(wait, refusals))} />
    </g>
  );
}

/** A recorded moment as a clock time to the second, UTC. */
function clockS(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")} UTC`;
}

/** Refusals grouped by gate and reason, newest last: "verify.start (incomplete-evidence) ×2, last 22:53:10 UTC". */
function refusalGroups(refusals: readonly GateRefusal[]): { key: string; gate: string; reason: string | null; count: number; last: number }[] {
  const groups = new Map<string, { key: string; gate: string; reason: string | null; count: number; last: number }>();
  for (const r of refusals) {
    const key = `${r.gate}|${r.reasonCode ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.last = Math.max(g.last, r.at);
    } else groups.set(key, { key, gate: r.gate, reason: r.reasonCode, count: 1, last: r.at });
  }
  return [...groups.values()].sort((a, b) => a.last - b.last);
}

/** The notices in words, for the cell's accessible name. */
function noticesWords(wait: CapacityWaitState | null, refusals: readonly GateRefusal[]): string {
  const out: string[] = [];
  if (wait) out.push(`waits for an execution place since ${clockS(wait.since)}${wait.limit !== null ? `, at most ${wait.limit} at once` : ""}`);
  for (const g of refusalGroups(refusals)) out.push(`refused at ${g.gate}${g.reason ? ` (${g.reason})` : ""}${g.count > 1 ? ` ${g.count} times` : ""}, last at ${clockS(g.last)}`);
  return out.join("; ");
}

/**
 * The bay's notices, lettered on the clear floor band between the task board and the tool ticker, one
 * short line each with the grammar's mark: overrides (the bypass hook), a recorded wait for an
 * execution place (the waiting mark) and gate refusals no gate state stands for (the refused mark),
 * grouped. The cell's name carries them in full. A dense plant (more than six bays) at mid zoom
 * letters the first line only, for the element budget.
 */
function Notices({ x, y, wait, refusals, overrides, lines: max }: { x: number; y: number; wait: CapacityWaitState | null; refusals: readonly GateRefusal[]; overrides: CellState["gateLog"]; lines: number }) {
  const groups = refusalGroups(refusals);
  const lines: { key: string; kind: "wait" | "refused" | "override"; text: string }[] = [];
  if (overrides.length) lines.push({ key: "over", kind: "override", text: `OVERRIDDEN ${overrides.map((o) => o.gate).join(", ")}` });
  if (wait) lines.push({ key: "wait", kind: "wait", text: `WAITS FOR AN EXECUTION PLACE${wait.limit !== null ? ` · MAX ${wait.limit}` : ""}` });
  if (groups.length) lines.push({ key: "ref", kind: "refused", text: `REFUSED ${groups.map((g) => `${g.gate}${g.count > 1 ? ` ×${g.count}` : ""}`).join(", ")}` });
  if (!lines.length) return null;
  // A dense plant at mid zoom letters only the first line (the element budget); near zoom letters all.
  const shown = lines.slice(0, max);
  return (
    <g aria-hidden="true">
      {shown.map((l, i) => {
        const at = { x: x + 24, y: y + 103 + i * 6.5, z: FLOOR_Z };
        const m = project({ x: x + 18, y: at.y - 1.6, z: FLOOR_Z });
        const text = l.text.length > 58 ? `${l.text.slice(0, 57)}…` : l.text;
        return (
          <g key={l.key}>
            {l.kind === "override" ? (
              <g transform={planeTransform(FLOOR_Z)}>
                <path d={`M${x + 15} ${at.y - 1}c1.5 -3.4 5 -3.4 6.5 0l-1.6 -0.6m1.6 0.6l0.3 -1.7`} style={{ fill: "none", stroke: fc("wait"), strokeWidth: planeStroke, strokeLinecap: "round" }} />
              </g>
            ) : (
              <g transform={`translate(${round(m.x)} ${round(m.y)})`}>
                <StateMark state={l.kind === "wait" ? "waiting" : "failed"} r={2.3} />
              </g>
            )}
            <FloorLettering at={at} text={text} size={5.2} font="mono" tone={l.kind === "refused" ? "fail" : "wait"} weight={600} decorative />
          </g>
        );
      })}
    </g>
  );
}

/** A recorded moment as a clock time (live and replay times are Unix ms). */
function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** An agent's state in words, for its accessible name. */
export function agentWord(placed: PlacedAgent): string {
  switch (placed.state) {
    case "active":
      return "working";
    case "succeeded":
      return "done";
    case "failed":
      return "error";
    case "waiting":
      return "queued";
    case "interrupted":
      return "interrupted";
    case "stale":
      return "working when last seen; the connection is not live";
    case "unknown":
      return "ended, how is not recorded";
    default:
      return placed.agent.status;
  }
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
function bayHits(bay: BaySlot, cell: CellState, agents: PlacedAgent[], gate: GateState | null, lod: Lod, st: Record<"intent" | "build" | "verify", MachineState>, activity?: string, notices = ""): HitItem[] {
  const { x, y } = bay.origin;
  const T = cell.ticketId;
  const title = isKnown(cell.meta, "title") ? cell.title : "title not recorded";
  const items: HitItem[] = [{ entity: ref.cell(T), label: `Cell ${T}, ${title}: ${cell.stage}${activity ? `, ${activity.toLowerCase()}` : ""}, round ${cell.round} of 3${notices ? `; ${notices}` : ""}`, box: { x, y, w: CELL_W, d: CELL_D, z: FLOOR_Z, h: 0 } }];
  const machine = (pad: "intent" | "build" | "verify", station: "plan" | "build" | "verify", name: string, h: number) => {
    const s = st[pad];
    items.push({ entity: ref.station(station, T), label: `${name} station, ${T}: ${s.state}${s.word ? ` (${s.word})` : ""}${s.round ? `, round ${s.round} of 3` : ""}`, box: boxAt(bay.pads[pad], 40, 40, h) });
  };
  machine("intent", "plan", "Plan", 12);
  machine("build", "build", "Build", 22);
  machine("verify", "verify", "Verify", 18);
  for (const a of [...agents].sort((m, n) => m.at.x - n.at.x)) {
    items.push({ entity: ref.agent(a.agent.id), label: agentLabel(a), box: boxAt(a.at, 18, 18, modelTiers[uiTier(a.agent.model)].height + 8) });
  }
  if (lod !== "far") {
    for (const { artifact: a, at } of shelfSlots(bay, cell)) {
      const by = a.meta.authority === "reconstructed" ? "found by the observer (reconstructed)" : `written ${a.writer.agentId ? "by an agent" : "by a script"}`;
      items.push({ entity: ref.artifact(a.id), label: `Artifact ${a.label} (${a.path}), ${by}`, box: { x: at.x - 7, y: at.y - 1.5, w: 14, d: 3, z: FLOOR_Z, h: 18 } });
    }
    if (cell.tasks.length) {
      const green = cell.tasks.filter((k) => k.status === "green" || k.status === "done").length;
      const red = cell.tasks.filter((k) => k.status === "red").length;
      const over = overridesOf(cell);
      items.push({ entity: `gate:${T}/red-before-green`, label: `Red before green, ${T}: ${cell.tasks.length} tasks, ${red} seen failing first, ${green} passing${over.length ? `; overridden: ${over.map((o) => `${o.gate}${o.reasonCode ? ` (${o.reasonCode})` : ""}`).join(", ")}` : ""}`, box: { x: x + 60, y: y + 80, w: 38, d: Math.ceil(cell.tasks.length / 5) * 6.4 + 2, z: FLOOR_Z, h: 1 } });
    }
  }
  // The verdict gate and its results rack are one entity: the gate carries the checks in its name.
  const ver = cell.verifications[cell.verifications.length - 1];
  const checks = ver ? `, ${ver.checks.filter((c) => c.result === "pass").length} of ${ver.checks.length} checks passed` : "";
  items.push({ entity: `gate:${gate ? gate.id : `${T}/verification#1`}`, label: `Verification verdict gate, ${T}: ${gateWord(gate)}${gate ? `, round ${gate.round}` : ""}${checks}`, box: boxAt(bay.gate, 8, 46, 36) });
  return items;
}

function BayHits({ items }: { items: HitItem[] }) {
  return (
    <>
      {items.map((it) => {
        const f = prismFaces(it.box);
        const pts = (it.box.h ?? 0) > 0 ? [f.top[0]!, f.top[1]!, f.shade[3]!, f.shade[2]!, f.lit[3]!, f.top[3]!] : f.top;
        return (
          <Hit key={it.entity} entity={it.entity} label={it.label} points={toPoints(pts)} />
        );
      })}
    </>
  );
}

/**
 * The artifact has its own hit target on its cell's shelf right now: the bay is drawn whole, at mid
 * or near zoom, and the artifact is among the files standing on the shelf. A station showing the
 * same artifact then draws it as an alias (Hit `alias`), so it is one keyboard stop with one name.
 */
export function onShelf(L: PlantLayout, visibleBays: ReadonlySet<string>, lod: Lod, cell: CellState, artifactId: string): boolean {
  const bay = L.bayByTicket.get(cell.ticketId);
  if (!bay || lod === "far" || !visibleBays.has(cell.ticketId)) return false;
  return shelfSlots(bay, cell).some((s) => s.artifact.id === artifactId);
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
function Console({ bay, cell, exec, t, reduced, lod, queued, stale }: { bay: BaySlot; cell: CellState; exec: ExecutionState | undefined; t: number; reduced: boolean; lod: Lod; queued: number; stale: boolean }) {
  const { x, y } = bay.origin;
  // On a stale connection the workflow is not said to be running: its panel shows the phase as last seen.
  const running = Boolean(exec && exec.workflowRunning) && !stale;
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
        <FloorLettering at={{ x: x + 162, y: y + 14, z: FLOOR_Z }} text={running ? `mach:belt · ${cell.workflowPhase ?? "Preflight"}` : stale && exec?.workflowRunning ? `mach:belt · ${cell.workflowPhase ?? "Preflight"} · as last seen` : exec ? "mach:belt · idle" : "no execution"} size={6.5} font="mono" tone={running ? "live" : "subtle"} weight={500} decorative />
      ) : null}
      {queued > 0 ? (
        // Workflow agents queued and not started (agent.queued): a count at the console, no figures.
        <FloorLettering at={{ x: c.x - 8, y: c.y + 30, z: FLOOR_Z }} text={`${queued} queued`} size={6.5} font="mono" tone="wait" weight={600} decorative />
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
        // An artifact known from the observer's reconstruction (it found the file) stands open: dashed, unfilled.
        return <Card key={a.id} reduced={reduced} kind={uiArtifact(a.kind)} state={failed ? "failed" : "succeeded"} open={a.meta.authority === "reconstructed"} progress={p} file={a.label} at={at} lod={lod} showLabel={false} dimmed={highlight.size > 0 && !highlight.has(aref) && !highlight.has(ref.cell(cell.ticketId))} />;
      })}
    </g>
  );
}

/**
 * The build's gate evaluations let through on a recorded override (red-before-green, frozen-tests...),
 * one per gate (the latest), from the cell's own gate log: an override is never a pass.
 */
export function overridesOf(cell: CellState): CellState["gateLog"] {
  const latest = new Map<string, CellState["gateLog"][number]>();
  for (const g of cell.gateLog) if (g.verdict === "overridden") latest.set(g.gate, g);
  return [...latest.values()];
}

/** Red before green: one chip per build task, a test task fills red when seen failing, an implementation green when the suite passes. */
function TaskBoard({ bay, cell, lod }: { bay: BaySlot; cell: CellState; lod: Lod }) {
  if (lod === "far" || cell.tasks.length === 0) return null;
  const { x, y } = bay.origin;
  const tasks: TaskCell[] = cell.tasks.map((k) => (k.status === "active" ? "active" : k.status === "red" ? "red" : "green"));
  // Upright on two legs on the clear floor between the plan bench and the build machine. An override
  // of its gate is lettered with the bay's notices (Notices), with the override's own mark.
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

/**
 * Tool calls accumulate along the ticker; past 24, the oldest merge into a counted density bar. Only
 * calls observed one by one (the simulation, a main loop) are ticks. A Dynamic Workflow agent's calls
 * are not observable (contract 8.1): its count and the last tool's name are lettered under the ticker,
 * and nothing on the ticker moves for them.
 */
function Ticker({ bay, cell, t, reduced, lod, mode }: { bay: BaySlot; cell: CellState; t: number; reduced: boolean; lod: Lod; mode: ViewMode }) {
  const { x, y } = bay.origin;
  const calls = callsOf(cell);
  const counted = countedToolsOf(cell);
  if (calls.length === 0 && counted.agents === 0) return null;
  if (calls.length === 0) return <CountedTicker bay={bay} cell={cell} lod={lod} mode={mode} />;
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
      {counted.agents > 0 ? <CountedTicker bay={bay} cell={cell} lod={lod} mode={mode} below /> : null}
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
        const p = q(anim("artifactMaterialise", t - c.writtenAt, reduced));
        // Reduced motion: the ring appears at its size and fades in; it does not grow.
        return p < 1 ? <circle key={c.id} cx={x0 + 4 + i * step} cy={by} r={reduced ? 1.9 : 1.9 * Math.max(0.2, p)} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 0.9 * planeStroke, opacity: reduced ? p : 1 }} /> : null;
      })}
      {lod === "near" ? (
        <text x={x0 - 3} y={by + 1.8} textAnchor="end" style={{ fill: "var(--mach-ink-subtle)", fontSize: 5.5, fontFamily: "var(--mach-font-mono)" }} className="notranslate">
          {cell.branch}
        </text>
      ) : null}
    </g>
  );
}

/** A cell's count-only agents on the ticker: a count and the last tool's name, lettered; never ticks. */
function CountedTicker({ bay, cell, lod, mode, below }: { bay: BaySlot; cell: CellState; lod: Lod; mode: ViewMode; below?: boolean }) {
  const { x, y } = bay.origin;
  const c = countedToolsOf(cell);
  const tickerY = y + CELL_D - 30;
  const calls = c.calls === null ? "no count yet" : `${c.calls} tool call${c.calls === 1 ? "" : "s"}`;
  const last = c.lastTool ? ` · last ${c.lastTool}` : "";
  const live = c.running > 0 && !mode.stale;
  const text = lod === "far" ? (c.calls === null ? "count not reported" : `${c.calls} calls`) : `${calls} counted${last}${mode.stale && c.running > 0 ? " · as last seen" : ""}`;
  return (
    <g role="img" aria-label={`${cell.ticketId}: ${calls} counted for ${c.agents} workflow agent${c.agents === 1 ? "" : "s"}${last ? `, the last tool reported ${c.lastTool}` : ""}${c.running ? `, ${c.running} running` : ""}. Individual calls are not observable.`}>
      <FloorLettering at={{ x: x + 16, y: tickerY + (below ? 11 : 2), z: FLOOR_Z }} text={text} size={lod === "far" ? 10 : 6.5} font="mono" tone={live ? "live" : "muted"} weight={500} decorative />
    </g>
  );
}

/** The agent's accessible name: role, model (or "model not recorded"), ticket, state, and what is known of its tools. */
export function agentLabel(a: PlacedAgent): string {
  // The simulation keeps its M6.0 names.
  if (a.agent.meta.authority === "simulated") return `${agentName(a)}${a.agent.role === "reviewer" ? " reviewer" : ""}, ${modelTiers[uiTier(a.agent.model)].label}, ${a.agent.ticketId}: ${agentWord(a)}`;
  const tier = a.tierKnown ? modelTiers[uiTier(a.agent.model)].label : "model not recorded";
  const tools = a.agent.observation === "count-only" ? `, ${a.agent.toolCallCount === null ? "tool calls not reported yet" : `${a.agent.toolCallCount} tool calls`}${a.agent.lastTool ? `, last ${a.agent.lastTool}` : ""}` : "";
  const elapsed = a.state === "active" || a.state === "stale" ? (a.elapsedKnown ? `, for ${a.elapsedInferred ? "about " : ""}${fmtElapsed(a.elapsed)}` : ", start not recorded") : "";
  return `${agentName(a)}${a.agent.role === "reviewer" ? " reviewer" : ""}, ${tier}, ${a.agent.ticketId}: ${agentWord(a)}${elapsed}${tools}${a.open ? " (reconstructed)" : ""}`;
}

export function agentName(placed: PlacedAgent): string {
  const a = placed.agent;
  const role = a.role === "reviewer" && a.seat && a.seat !== "general" ? reviewerSeats[a.seat].label : a.role === "clerk" ? "Clerk" : a.role === "intent" ? "Plan worker" : a.role === "merge" ? "Merge worker" : a.role === "cleanup" ? "Cleanup worker" : agentRoles[uiRole(a)].label;
  return role;
}

export function AgentFigure({ placed, lod, dimmed, proxied }: { placed: PlacedAgent; lod: Lod; dimmed: boolean; proxied?: boolean }) {
  const a = placed.agent;
  const seat = a.seat && a.seat !== "general" ? a.seat : undefined;
  // Reduced motion (spec e: agentArrive / agentLeave "fade"): the figure stands at full height and
  // only its opacity follows arrival and departure; the post never grows or sinks.
  const marker = <AgentMarker agentRole={uiRole(a)} tier={uiTier(a.model)} tierKnown={placed.tierKnown} open={placed.open} seat={seat} state={placed.state} elapsed={placed.state === "active" && placed.elapsedKnown ? placed.elapsed : undefined} arrive={placed.reduced ? 1 : placed.arrive} leave={placed.reduced ? 0 : placed.leave} at={placed.at} lod={lod} dimmed={dimmed} showLabel={false} />;
  const figure = placed.reduced ? <g style={{ opacity: q(Math.max(0, Math.min(1, placed.arrive * (1 - placed.leave)))) }}>{marker}</g> : marker;
  if (proxied) return figure;
  return (
    <Hit entity={ref.agent(a.id)} label={agentLabel(placed)}>
      {figure}
    </Hit>
  );
}

/** The verdict gate outside the door: closes when verification starts, opens on PASS, refuses on a failure. */
function VerificationGate({ bay, gate: g, t, reduced, lod, dimmed }: { bay: BaySlot; gate: GateState | null; t: number; reduced: boolean; lod: Lod; dimmed: boolean }) {
  const v = gateView(g, t, reduced);
  return (
      <GateGlyph kind="verification" position={v.position} from={v.from} progress={v.progress} overridden={v.overridden} at={bay.gate} axis="y" lod={lod} dimmed={dimmed} showLabel={false} planned={!g} />
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

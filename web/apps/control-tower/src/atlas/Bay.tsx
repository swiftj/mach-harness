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
  ToolTick,
  agentRoles,
  depthOf,
  fc,
  liftedArc,
  modelTiers,
  planeStroke,
  planeTransform,
  pointAlong,
  project,
  reviewerSeats,
  round,
  segment,
  toPoints,
  uprightTransform,
  type CellStage as UiStage,
  type FactoryState,
  type Lod,
  type Vec3,
} from "@mach/ui";
import { BELT_PHASES, ref, sceneAt, type CellState, type ExecutionState, type GateState } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { Hit, isDimmed, useAtlas, useHighlight, usePlayheadKeyed } from "./context";
import { agentProgress, animating, anim, callsOf, gateView, latestGate, placeAgents, q, toolFamily, uiArtifact, uiRole, uiTier, type PlacedAgent } from "./derive";
import { FLOOR_Z, PLATE_Z, type BaySlot } from "./layout";
import { Machine } from "./Machine";
import { PlaneText, PlanDimension } from "./Plant";

const CELL_W = 216;
const CELL_D = 148;

function uiStage(stage: CellState["stage"]): UiStage {
  return stage === "spec-open" ? "interview" : stage;
}

/** Elapsed against an expected length, for a station's dial while its end is unknown. */
const EXPECTED_STATION: Record<string, number> = { plan: 140_000, groom: 140_000, build: 900_000, verify: 300_000 };

function stationProgress(cell: CellState, t: number): number {
  const expected = cell.station ? EXPECTED_STATION[cell.station] : undefined;
  return expected && cell.stationSince !== null ? Math.max(0, Math.min(0.96, (t - cell.stationSince) / expected)) : 0;
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
  // The bay is built and waiting: slab, walls and rail, with the machines' footprints marked out.
  return (
    <g aria-hidden="true">
      <CellPlate origin={bay.origin} ticket={bay.ticketId} stage={waiting ? "waiting-on-dependency" : "eligible"} lod={lod} dimmed={dim}>
        <g transform={planeTransform(FLOOR_Z)}>
          {(["intent", "build", "verify"] as const).map((p) => (
            <rect key={p} x={bay.pads[p].x - 20} y={bay.pads[p].y - 20} width={40} height={40} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: planeStroke, strokeDasharray: "4 3" }} />
          ))}
        </g>
        {lod !== "far" ? (
          <PlaneText x={x + 14} y={y + CELL_D - 26} z={FLOOR_Z} size={7.5} mono tone={waiting ? "wait" : "subtle"} weight={600}>
            {known ? (waiting ? `RESERVED · ${bay.sliceId} WAITS ON A DEPENDENCY` : `RESERVED · ${bay.sliceId}`) : "RESERVED"}
          </PlaneText>
        ) : null}
      </CellPlate>
    </g>
  );
}

/** A bay slot no slice uses: marked out on the floor, with the factory's capacity painted in it. */
export function FreeBay({ slot, maxParallel }: { slot: { x: number; y: number; index: number }; maxParallel: number | null }) {
  const { lod } = useAtlas();
  const { x, y } = slot;
  return (
    <g aria-hidden="true">
      <g transform={planeTransform(PLATE_Z)}>
        <rect x={x} y={y} width={CELL_W} height={CELL_D} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: planeStroke, strokeDasharray: "6 4" }} />
        <path
          d={`M${x} ${y + 12}V${y}H${x + 12}M${x + CELL_W - 12} ${y}H${x + CELL_W}V${y + 12}M${x + CELL_W} ${y + CELL_D - 12}V${y + CELL_D}H${x + CELL_W - 12}M${x + 12} ${y + CELL_D}H${x}V${y + CELL_D - 12}`}
          style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.2 * planeStroke }}
        />
      </g>
      {lod !== "far" ? (
        <>
          <PlaneText x={x + 14} y={y + 26} size={9} mono tone="subtle" weight={600}>
            {`BAY ${slot.index + 1} · FREE`}
          </PlaneText>
          {maxParallel !== null ? (
            <PlaneText x={x + 14} y={y + 40} size={7.5} mono tone="subtle">
              {`AT MOST ${maxParallel} CELLS AT ONCE (max_parallel)`}
            </PlaneText>
          ) : null}
          <PlanDimension x0={x} x1={x + CELL_W} y={y + CELL_D - 16} z={PLATE_Z} label="216 · one worktree per ticket" lod={lod} />
        </>
      ) : null}
    </g>
  );
}

function LiveBay({ bay, cell, visible }: { bay: BaySlot; cell: CellState; visible: boolean }) {
  const { lod, layout: L } = useAtlas();
  const highlight = useHighlight();
  const ticket = cell.ticketId;
  // Re-render with the playhead only while one of this cell's animations runs; otherwise only when
  // a quantised progress step (an agent's arc, the station dial) changes.
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.fixture, now, (e) => e.ticket_id === ticket)) return now;
    const c = sceneAt(s.fixture, now).cells[ticket];
    if (!c) return "none";
    let k = String(Math.floor(stationProgress(c, now) * 24));
    for (const id of c.activeAgentIds) k += `,${Math.floor(agentProgress(c.agents[id]!, now) * 24)}`;
    return k;
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
  const working = cell.station !== null && ["groom", "plan", "build", "verify", "audit"].includes(cell.station) && cell.activeAgentIds.length > 0;
  const stationP = Math.floor(stationProgress(cell, t) * 24) / 24;
  const completion = cell.merged ? q(anim("cellComplete", t - cell.merged.at, reduced)) : 0;
  const agents = placeAgents(null, L, cell, t, reduced);
  const inBay = agents.filter((a) => a.at.z === FLOOR_Z).sort((a, b) => depthOf(a.at) - depthOf(b.at));

  if (!visible) {
    return <CellPlate origin={bay.origin} ticket={cell.ticketId} stage={uiStage(cell.stage)} lit={working} completion={completion} lod={lod} dimmed={dimCell} />;
  }

  const intent = machineState(cell, ["groom", "plan"]);
  const build = machineState(cell, ["build", "audit"]);
  const verify = machineState(cell, ["verify"]);
  const ver = cell.verifications[cell.verifications.length - 1];
  const verifyP = ver ? ver.checks.filter((c) => c.result !== "pending").length / Math.max(1, ver.checks.length) : 0;

  // Children in painter's order: things at the back (shelf, panel) first, then machines, agents.
  const kids: { depth: number; node: ReactNode }[] = [];
  kids.push({ depth: -1e6, node: <CellHit key="hit" bay={bay} cell={cell} /> });
  kids.push({ depth: depthOf({ x: x + 16, y: y + 26 }), node: <Console key="console" bay={bay} cell={cell} exec={exec} t={t} reduced={reduced} lod={lod} /> });
  kids.push({ depth: depthOf({ x, y: y + 18 }), node: <Shelf key="shelf" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} highlight={highlight} /> });
  kids.push({ depth: depthOf({ x: x + 62, y: y + 82 }), node: <TaskBoard key="tasks" bay={bay} cell={cell} lod={lod} /> });
  kids.push({ depth: depthOf({ x: x + 168, y: y + 24 }), node: <ResultsRack key="results" bay={bay} cell={cell} lod={lod} t={t} reduced={reduced} /> });
  const machine = (key: string, kind: "plan" | "build" | "verify", at: Vec3, st: { state: FactoryState; round?: number }, p: number, station: "plan" | "build" | "verify") => {
    const sref = ref.station(station, cell.ticketId);
    return {
      depth: depthOf(at),
      node: (
        <Hit key={key} entity={sref} label={`${kind === "plan" ? "Plan" : kind === "build" ? "Build" : "Verify"} station, ${cell.ticketId}: ${st.state}${st.round ? `, round ${st.round} of 3` : ""}`}>
          <Machine kind={kind} state={st.state} progress={q(p)} round={st.round} at={at} lod={lod} dimmed={!dimCell && isDimmed(highlight, cellRef, sref)} />
        </Hit>
      ),
    };
  };
  kids.push(machine("m-intent", "plan", bay.pads.intent, intent, cell.station === "plan" ? stationP : 0, "plan"));
  kids.push(machine("m-build", "build", bay.pads.build, build, cell.station === "build" ? stationP : 0, "build"));
  kids.push(machine("m-verify", "verify", bay.pads.verify, verify, cell.station === "verify" ? verifyP : 0, "verify"));
  kids.push({ depth: depthOf({ x, y: y + 118 }), node: <Ticker key="ticker" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} /> });
  kids.push({ depth: depthOf({ x, y: y + 128 }), node: <Branch key="branch" bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} /> });
  for (const a of inBay) kids.push({ depth: depthOf(a.at) + 0.5, node: <AgentFigure key={a.agent.id} placed={a} lod={lod} dimmed={!dimCell && isDimmed(highlight, cellRef, ref.agent(a.agent.id))} /> });
  kids.sort((a, b) => a.depth - b.depth);

  return (
    <g>
      <CellPlate origin={bay.origin} ticket={cell.ticketId} slice={cell.sliceId} stage={uiStage(cell.stage)} lit={working} completion={completion} progress={q(stationP)} lod={lod} dimmed={dimCell} rail>
        {kids.map((k) => k.node)}
      </CellPlate>
      <VerificationGate bay={bay} cell={cell} gate={vgate} t={t} reduced={reduced} lod={lod} dimmed={dimCell} />
      <VerifyLoop bay={bay} cell={cell} t={t} reduced={reduced} lod={lod} dimmed={dimCell} />
    </g>
  );
}

/** The whole floor of the bay is the cell's hit target (drawn first, under everything inside). */
function CellHit({ bay, cell }: { bay: BaySlot; cell: CellState }) {
  const { x, y } = bay.origin;
  const pts = [
    { x, y, z: FLOOR_Z },
    { x: x + CELL_W, y, z: FLOOR_Z },
    { x: x + CELL_W, y: y + CELL_D, z: FLOOR_Z },
    { x, y: y + CELL_D, z: FLOOR_Z },
  ].map(project);
  return (
    <Hit entity={ref.cell(cell.ticketId)} label={`Cell ${cell.ticketId}, ${cell.title}: ${cell.stage}, round ${cell.round} of 3`}>
      <polygon points={toPoints(pts)} style={{ fill: "transparent" }} />
    </Hit>
  );
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
        <PlaneText x={x + 162} y={y + 14} z={FLOOR_Z} size={6.5} mono tone={running ? "live" : "subtle"}>
          {running ? `mach:belt · ${cell.workflowPhase ?? "Preflight"}` : exec ? "mach:belt · idle" : "no execution"}
        </PlaneText>
      ) : null}
    </g>
  );
}

/** The back shelf: artifacts in the order written; older ones collapse into a counted stack. */
function Shelf({ bay, cell, t, reduced, lod, highlight }: { bay: BaySlot; cell: CellState; t: number; reduced: boolean; lod: Lod; highlight: ReadonlySet<string> }) {
  const { x, y } = bay.origin;
  const all = cell.artifacts;
  const slots = 7;
  const shown = all.length > slots ? all.slice(all.length - (slots - 1)) : all;
  const hidden = all.length - shown.length;
  const at = (i: number): Vec3 => ({ x: x + 34 + i * 19, y: y + 18, z: FLOOR_Z });
  if (lod === "far") {
    return all.length ? (
      <PlaneText x={x + 30} y={y + 22} z={FLOOR_Z} size={12} mono tone="muted">
        {`${all.length} files`}
      </PlaneText>
    ) : null;
  }
  const offset = hidden > 0 ? 1 : 0;
  return (
    <g>
      {hidden > 0 ? (
        <g aria-label={`${hidden} earlier artifacts`} role="img">
          {[2, 1, 0].map((k) => (
            <ArtifactCard key={k} kind={uiArtifact(all[hidden - 1 - k]?.kind ?? "plan")} at={{ ...at(0), x: at(0).x - k * 2.2, y: at(0).y - k * 1.5 }} lod="mid" showLabel={false} />
          ))}
          <PlaneText x={at(0).x - 8} y={at(0).y + 9} z={FLOOR_Z} size={7.5} mono tone="muted" weight={600}>
            {`+${hidden}`}
          </PlaneText>
        </g>
      ) : null}
      {shown.map((a, i) => {
        const p = q(anim("artifactMaterialise", t - a.writtenAt, reduced));
        const aref = ref.artifact(a.id);
        const failed = a.kind === "verification-findings" || (a.kind === "review-findings" && cell.reviews.some((r) => r.outcome === "REJECTED" && r.round === a.round));
        return (
          <Hit key={a.id} entity={aref} label={`Artifact ${a.label} (${a.path}), written ${a.writer.agentId ? "by an agent" : "by a script"}`}>
            <ArtifactCard kind={uiArtifact(a.kind)} state={failed ? "failed" : "succeeded"} progress={p} file={a.label} at={at(i + offset)} lod={lod} showLabel={false} dimmed={highlight.size > 0 && !highlight.has(aref) && !highlight.has(ref.cell(cell.ticketId))} />
          </Hit>
        );
      })}
    </g>
  );
}

/** Red before green: one chip per build task, a test task fills red when seen failing, an implementation green when the suite passes. */
function TaskBoard({ bay, cell, lod }: { bay: BaySlot; cell: CellState; lod: Lod }) {
  if (lod === "far" || cell.tasks.length === 0) return null;
  const { x, y } = bay.origin;
  // On the clear floor between the plan bench and the build machine, in front of the rail.
  const per = 5;
  const chip = (i: number) => ({ cx: x + 62 + (i % per) * 7.2, cy: y + 82 + Math.floor(i / per) * 6.4 });
  const green = cell.tasks.filter((k) => k.status === "green" || k.status === "done").length;
  const red = cell.tasks.filter((k) => k.status === "red").length;
  return (
    <Hit entity={`gate:${cell.ticketId}/red-before-green`} label={`Red before green, ${cell.ticketId}: ${cell.tasks.length} tasks, ${red} seen failing first, ${green} passing`}>
      <g transform={planeTransform(FLOOR_Z)}>
        {cell.tasks.map((k, i) => {
          const { cx, cy } = chip(i);
          const isTest = k.kind === "test";
          const ink = k.status === "active" ? fc("live") : isTest ? fc("fail") : k.kind === "impl" ? fc("pass") : fc("ink");
          const filled = k.status !== "active";
          return (
            <g key={k.id}>
              <rect x={cx} y={cy} width={5.4} height={4.6} rx={0.6} style={{ fill: filled ? ink : fc("plate-top"), stroke: ink, strokeWidth: 0.9 * planeStroke }} />
              {k.loop > 0 ? <circle cx={cx + 2.7} cy={cy + 2.3} r={0.9} style={{ fill: fc("plate-top") }} /> : null}
            </g>
          );
        })}
      </g>
    </Hit>
  );
}

/** Verification results accumulating: one mark per check of the current round. */
function ResultsRack({ bay, cell, lod, t, reduced }: { bay: BaySlot; cell: CellState; lod: Lod; t: number; reduced: boolean }) {
  const ver = cell.verifications[cell.verifications.length - 1];
  if (!ver || lod === "far") return null;
  const { x, y } = bay.origin;
  const passed = ver.checks.filter((c) => c.result === "pass").length;
  return (
    <Hit entity={`gate:${cell.ticketId}/verification#${ver.round}`} label={`Verification round ${ver.round}, ${cell.ticketId}: ${passed} of ${ver.checks.length} checks passed, ${ver.status}`}>
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
    </Hit>
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
      {commits.map((c, i) => {
        const p = anim("artifactMaterialise", t - c.writtenAt, reduced);
        return <circle key={c.id} cx={x0 + 4 + i * step} cy={by} r={1.9 * Math.max(0.2, p)} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 0.9 * planeStroke }} />;
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

export function AgentFigure({ placed, lod, dimmed }: { placed: PlacedAgent; lod: Lod; dimmed: boolean }) {
  const a = placed.agent;
  const seat = a.seat && a.seat !== "general" ? a.seat : undefined;
  return (
    <Hit entity={ref.agent(a.id)} label={`${agentName(placed)}${a.role === "reviewer" ? " reviewer" : ""}, ${modelTiers[uiTier(a.model)].label}, ${a.ticketId}: ${a.status === "running" ? "working" : a.status}`}>
      <AgentMarker agentRole={uiRole(a)} tier={uiTier(a.model)} seat={seat} state={placed.state} progress={placed.progress} arrive={placed.arrive} leave={placed.leave} at={placed.at} lod={lod} dimmed={dimmed} showLabel={false} />
    </Hit>
  );
}

/** The verdict gate outside the door: closes when verification starts, opens on PASS, refuses on a failure. */
function VerificationGate({ bay, cell, gate: g, t, reduced, lod, dimmed }: { bay: BaySlot; cell: CellState; gate: GateState | null; t: number; reduced: boolean; lod: Lod; dimmed: boolean }) {
  const v = gateView(g, t, reduced);
  const id = g ? g.id : `${cell.ticketId}/verification#1`;
  return (
    <Hit entity={`gate:${id}`} label={`Verification verdict gate, ${cell.ticketId}: ${v.position}${g ? `, round ${g.round}` : ""}`}>
      <GateGlyph kind="verification" position={v.position} from={v.from} progress={v.progress} at={bay.gate} axis="y" lod={lod} dimmed={dimmed} showLabel={false} />
    </Hit>
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
          <Hit entity={ref.artifact(findings.id)} label={`Findings ${findings.label}: returned to build, round ${failed.round + 1} of 3`}>
            <ArtifactCard kind="findings" state="failed" progress={segment(p, 0, 0.4)} at={cardP > 0 ? ride : { ...from, z: FLOOR_Z + 18 }} lod={lod} showLabel={false} />
          </Hit>
        ) : null
      ) : null}
    </g>
  );
}

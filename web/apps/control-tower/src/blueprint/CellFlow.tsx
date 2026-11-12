/**
 * One cell's workflow, drawn with the grammar: process bubbles in belt order, gates as diamonds,
 * round rows with the return-to-build loop between them, the review panel's fan-out and join on the
 * consensus gate, the human gate, merge revalidation, cleanup and integration. Columns the belt has
 * not reached are drawn unbuilt. Every mark has a `data-ref` naming the entity it draws.
 */
import { memo, type ReactNode } from "react";
import {
  AgentMarker,
  ArtifactCard,
  Branches,
  Callout,
  DimensionLine,
  fc,
  GateGlyph,
  RetryLoop,
  RoutePath,
  StateMark,
  StationMachine,
  StationSymbol,
  TaskBoard,
  FindingsFlag,
  type FactoryState,
  type TaskCell,
  type GateLamp,
  type GatePosition,
} from "@mach/ui";
import type { AgentState, ArtifactState, CellState, EntityRef, GateState, ReviewRoundState, SliceState } from "../sim";
import { ref } from "../sim";
import type { ColumnTemplate } from "./columns";
import type { Flow, FlowNode } from "./flow";
import { useEventProgress, usePlayhead } from "./motion";
import { clock, duration } from "./time";
import { artifactFile, agentState, grammarArtifact, grammarGate, grammarSeat, stationKind, tierOf } from "./vocab";

const UNBUILT = 0.42;
const SEAT_KEYS = ["architecture", "security", "product"] as const;

const SHORT_GATE: Record<GateState["gate"], string> = {
  "plan-check": "Plan check",
  audit: "Audit",
  "red-before-green": "Red, green",
  verification: "Verdict",
  review: "Consensus",
  "human-approval": "Human",
  "merge-revalidation": "Revalidate",
};

export interface CellFlowProps {
  cell: CellState;
  slice: SliceState;
  flow: Flow;
  template: ColumnTemplate;
  /** x where the columns start, in lane coordinates. */
  ax: number;
  /** y of the main line, in lane coordinates. */
  row0: number;
  dimsY: number;
  laneH: number;
}

export const CellFlow = memo(function CellFlow({ cell, slice, flow, template, ax, row0, dimsY, laneH }: CellFlowProps) {
  const seats = template.seats;
  return (
    <g>
      {/* Centre lines: one per column, the drafted datum every round row and lane hangs from. */}
      <g aria-hidden="true">
        {flow.nodes.map((n) =>
          n.row === 0 ? <line key={`cl${n.key}`} x1={ax + n.x} y1={row0 - 46} x2={ax + n.x} y2={laneH - 6} style={{ stroke: fc("grid-major"), strokeWidth: 0.6, strokeDasharray: "14 3 2 3" }} /> : null,
        )}
      </g>
      <g transform={`translate(${ax} ${row0})`}>
        {flow.segments.map((s) => (
          <Segment key={`${s.from.key}>${s.to.key}`} from={s.from} to={s.to} retry={s.retry} seats={seats} cell={cell} />
        ))}
        {flow.nodes.map((n) => (
          <FlowMark key={n.key} node={n} cell={cell} slice={slice} seats={seats} next={nextOf(flow, n)} />
        ))}
        <Dimensions flow={flow} cell={cell} y={dimsY - row0} />
      </g>
    </g>
  );
});

function nextOf(flow: Flow, n: FlowNode): FlowNode | null {
  const i = flow.nodes.indexOf(n);
  return (flow.nodes[i + 1] as FlowNode | undefined) ?? null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Segments                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

function isBuilt(n: FlowNode): boolean {
  return n.kind !== "future" && !(n.kind === "end" && n.key.startsWith("f:"));
}

function startOf(n: FlowNode): number | null {
  if (n.visit) return n.visit.enteredAt;
  if (n.gate) return n.gate.openedAt;
  return null;
}

function routePoints(a: FlowNode, b: FlowNode, aOut = a.r + 3, bIn = b.r + 4): { x: number; y: number }[] {
  const p0 = { x: a.x + aOut, y: a.y };
  const p1 = { x: b.x - bIn, y: b.y };
  if (a.y === b.y) return [p0, p1];
  const mid = Math.round((p0.x + p1.x) / 2);
  return [p0, { x: mid, y: a.y }, { x: mid, y: b.y }, p1];
}

function Segment({ from, to, retry, seats, cell }: { from: FlowNode; to: FlowNode; retry: boolean; seats: readonly number[]; cell: CellState }) {
  if (retry) return <Retry from={from} to={to} />;
  if (to.col === "review") return <FanOut from={from} to={to} seats={seats} cell={cell} />;
  if (from.col === "review") return <Join from={from} to={to} seats={seats} cell={cell} />;
  return <Route from={from} to={to} />;
}

function Route({ from, to }: { from: FlowNode; to: FlowNode }) {
  const built = isBuilt(to);
  const startT = startOf(to) ?? (to.kind === "end" ? null : null);
  const draw = useEventProgress(startT, "pathDraw");
  const pts = routePoints(from, to);
  if (!built) {
    // Not reached yet: the grammar's planned route (a dashed hairline), at the unbuilt opacity.
    return (
      <g style={{ opacity: UNBUILT }}>
        <RoutePath variant="blueprint" points={pts} planned arrow={false} />
      </g>
    );
  }
  const active = (to.visit && to.visit.leftAt === null && to.visit.station !== "human-approval") || (to.gate?.state === "open" && to.gate.gate !== "red-before-green");
  const state: FactoryState = active ? "active" : "succeeded";
  return <RoutePath variant="blueprint" points={pts} state={state} progress={startT === null ? 1 : draw} />;
}

function Retry({ from, to }: { from: FlowNode; to: FlowNode }) {
  const p = useEventProgress(from.gate?.decidedAt, "verifyReturn");
  // The return leaves the refusing gate backwards, off its left vertex, and drops clear of its label.
  const out = from.x - from.r - 16;
  return (
    <g>
      {p > 0 ? <path d={`M${from.x - from.r - 1} ${from.y}H${out}`} aria-hidden="true" style={{ fill: "none", stroke: fc("fail"), strokeWidth: 1.6, strokeDasharray: "5 3", strokeLinecap: "round" }} /> : null}
      <RetryLoop variant="blueprint" from={{ x: out, y: from.y }} to={{ x: to.x, y: to.y - to.r - 4 }} crestY={from.y + 54} round={to.round} progress={p} />
    </g>
  );
}

function reviewRound(cell: CellState, seatsNode: FlowNode): ReviewRoundState | null {
  return cell.reviews.find((r) => r.round === seatsNode.round) ?? null;
}

function seatAgent(cell: CellState, round: ReviewRoundState | null, i: number): AgentState | null {
  const seat = round?.seats.find((s) => s.seat === SEAT_KEYS[i]);
  return seat?.agentId ? (cell.agents[seat.agentId] ?? null) : null;
}

function FanOut({ from, to, seats, cell }: { from: FlowNode; to: FlowNode; seats: readonly number[]; cell: CellState }) {
  const round = isBuilt(to) ? reviewRound(cell, to) : null;
  const p0 = useEventProgress(round?.startedAt, "fanOut", 0);
  const p1 = useEventProgress(round?.startedAt, "fanOut", 90);
  const p2 = useEventProgress(round?.startedAt, "fanOut", 180);
  const origin = { x: from.x + from.r + 3, y: from.y };
  const targets = seats.map((dy) => ({ x: to.x - 10, y: to.y + dy }));
  if (!round) return <UnbuiltBranches origin={origin} targets={targets} />;
  const states = SEAT_KEYS.map((_, i): FactoryState => {
    const a = seatAgent(cell, round, i);
    return a ? (a.status === "running" ? "active" : "succeeded") : "active";
  });
  return <Branches variant="blueprint" origin={origin} targets={targets} mode="fan-out" progress={[p0, p1, p2]} states={states} label={`Review round ${round.round}: the panel of three seats`} />;
}

function Join({ from, to, seats, cell }: { from: FlowNode; to: FlowNode; seats: readonly number[]; cell: CellState }) {
  const round = isBuilt(from) ? reviewRound(cell, from) : null;
  const votes = SEAT_KEYS.map((k) => round?.seats.find((s) => s.seat === k) ?? null);
  const p0 = useEventProgress(votes[0]?.votedAt, "voteConverge");
  const p1 = useEventProgress(votes[1]?.votedAt, "voteConverge");
  const p2 = useEventProgress(votes[2]?.votedAt, "voteConverge");
  const origin = { x: to.x - to.r - 3, y: to.y };
  const targets = seats.map((dy) => ({ x: from.x + 10, y: from.y + dy }));
  if (!round) return <UnbuiltBranches origin={origin} targets={targets} join />;
  const states = votes.map((v): FactoryState => (v?.vote === "APPROVE" ? "succeeded" : v?.vote === "REJECT" ? "failed" : "active"));
  return <Branches variant="blueprint" origin={origin} targets={targets} mode="join" progress={[p0, p1, p2]} states={states} label={`Votes, round ${round.round}`} />;
}

function UnbuiltBranches({ origin, targets, join }: { origin: { x: number; y: number }; targets: readonly { x: number; y: number }[]; join?: boolean }) {
  return (
    <g aria-hidden="true" style={{ opacity: UNBUILT }}>
      {targets.map((t, i) => {
        const dx = (t.x - origin.x) * 0.55;
        const d = join
          ? `M${t.x} ${t.y}C${t.x - dx} ${t.y} ${origin.x + dx} ${origin.y} ${origin.x} ${origin.y}`
          : `M${origin.x} ${origin.y}C${origin.x + dx} ${origin.y} ${t.x - dx} ${t.y} ${t.x} ${t.y}`;
        return <path key={i} d={d} style={{ fill: "none", stroke: fc("route"), strokeWidth: 1, strokeDasharray: "3 3" }} />;
      })}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Nodes                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

function Pick({ entity, children, label }: { entity: EntityRef; children: ReactNode; label?: string }) {
  return (
    <g data-ref={entity} aria-label={label} style={{ cursor: "pointer" }}>
      {children}
    </g>
  );
}

function FlowMark({ node, cell, slice, seats, next }: { node: FlowNode; cell: CellState; slice: SliceState; seats: readonly number[]; next: FlowNode | null }) {
  switch (node.kind) {
    case "start":
      return <StartMark node={node} cell={cell} slice={slice} />;
    case "end":
      return isBuilt(node) ? <EndMark node={node} slice={slice} /> : <FutureEnd node={node} />;
    case "future":
      return <FutureMark node={node} seats={seats} />;
    case "seats":
      return <SeatsMark node={node} cell={cell} seats={seats} />;
    case "gate":
      return <GateMark node={node} cell={cell} />;
    case "visit":
      return <VisitMark node={node} cell={cell} next={next} />;
  }
}

function Label({ y, text, sub, tone, opacity = 1 }: { y: number; text: string; sub?: string; tone?: string; opacity?: number }) {
  return (
    <g aria-hidden="true" style={{ opacity }}>
      <text y={y} textAnchor="middle" style={{ fill: tone ?? "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
        {text}
      </text>
      {sub ? (
        <text y={y + 11.5} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }} className="tabular">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function StartMark({ node, cell, slice }: { node: FlowNode; cell: CellState; slice: SliceState }) {
  const opened = cell.stageHistory[0];
  return (
    <Pick entity={ref.cell(cell.ticketId)}>
      <g transform={`translate(${node.x} ${node.y})`}>
        {/* The datum: where the cell's line starts (opened by intake at spec-ready). */}
        <circle r={7.5} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 1.25 }} />
        <circle r={2.4} style={{ fill: fc("ink") }} />
        <path d="M-12 0h-6M0 -12v-5" aria-hidden="true" style={{ stroke: fc("ink-soft"), strokeWidth: 0.75 }} />
        <Label y={22} text="Opened" sub={`${clock(cell.openedAt)} · ${opened?.stage ?? ""}`} />
      </g>
      <title>{`${cell.ticketId} opened by ${opened?.by ?? "intake"} at ${clock(cell.openedAt)} for ${slice.id}`}</title>
    </Pick>
  );
}

function EndMark({ node, slice }: { node: FlowNode; slice: SliceState }) {
  const at = slice.history.find((h) => h.state === "integrated")?.at ?? slice.since;
  const p = useEventProgress(at, "cellComplete");
  return (
    <Pick entity={ref.slice(slice.id)}>
      <g transform={`translate(${node.x} ${node.y})`} style={{ opacity: Math.max(0.2, p) }}>
        <StateMark state="succeeded" mark="double-ring" r={10} />
        <Label y={24} text="Integrated" sub={`${clock(at)} · ${slice.integratedCommit?.slice(0, 7) ?? ""}`} />
      </g>
    </Pick>
  );
}

function FutureEnd({ node }: { node: FlowNode }) {
  return (
    <g transform={`translate(${node.x} ${node.y})`} aria-hidden="true" style={{ opacity: UNBUILT }}>
      <circle r={9} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5" }} />
      <circle r={5.5} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5" }} />
      <Label y={24} text="Integrated" opacity={0.9} />
    </g>
  );
}

const FUTURE_LABEL: Partial<Record<string, string>> = {
  plan: "Plan",
  build: "Build",
  verify: "Verify",
  merge: "Merge",
  cleanup: "Cleanup",
};

function FutureMark({ node, seats }: { node: FlowNode; seats: readonly number[] }) {
  if (node.col === "review") {
    return (
      <g aria-hidden="true" style={{ opacity: UNBUILT }}>
        {seats.map((dy, i) => (
          <circle key={i} cx={node.x} cy={node.y + dy} r={7} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5" }} />
        ))}
      </g>
    );
  }
  const station = FUTURE_LABEL[node.col];
  if (station) {
    return (
      <g aria-hidden="true" style={{ opacity: UNBUILT }}>
        <StationMachine variant="blueprint" kind={stationKind(node.col)} state="idle" at={{ x: node.x, y: node.y }} label={station} />
      </g>
    );
  }
  const gate = node.col as GateState["gate"] | "consensus";
  const kind = gate === "consensus" ? "consensus" : grammarGate(gate as GateState["gate"]);
  return (
    <g aria-hidden="true" style={{ opacity: UNBUILT }} transform={`translate(${node.x} ${node.y})`}>
      <path d="M0 -14L14 0L0 14L-14 0Z" style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5" }} />
      <StationSymbol kind={kind === "red-green" ? "red-green" : kind === "consensus" ? "review" : kind === "human" ? "human-approval" : kind === "revalidation" ? "merge" : kind === "verification" ? "verify" : "audit"} size={12} color={fc("ink-soft")} strokeWidth={1.2} />
      <Label y={30} text={gate === "consensus" ? "Consensus" : SHORT_GATE[gate as GateState["gate"]]} opacity={0.9} />
    </g>
  );
}

/** Progress of a visit's work where the record says how far it is: checks decided, votes cast. */
function visitProgress(cell: CellState, node: FlowNode): number | undefined {
  const v = node.visit;
  if (!v || v.leftAt !== null) return undefined;
  if (v.station === "verify") {
    const ver = cell.verifications.find((x) => x.round === node.round);
    if (!ver || !ver.checks.length) return 0;
    return ver.checks.filter((c) => c.result !== "pending").length / ver.checks.length;
  }
  return undefined;
}

function headlineArtifacts(cell: CellState, node: FlowNode): ArtifactState[] {
  const v = node.visit;
  if (!v) return [];
  const end = v.leftAt ?? Infinity;
  return cell.artifacts.filter((a) => a.station === v.station && a.writtenAt >= v.enteredAt && a.writtenAt <= end + 1 && a.writer.agentId !== null);
}

const HEADLINE_ORDER: ArtifactState["kind"][] = ["merge-commit", "decision", "verification-summary", "verification-findings", "verification-results", "build-report", "plan", "contract", "commit", "archive", "run-record", "evidence", "vote", "review-findings", "findings-copy", "build-state", "review-packet", "review-diff", "intent", "spec"];

function VisitMark({ node, cell, next }: { node: FlowNode; cell: CellState; next: FlowNode | null }) {
  const v = node.visit!;
  const state: FactoryState = v.leftAt === null ? "active" : v.outcome === "failed" ? "failed" : "succeeded";
  const appear = useEventProgress(v.enteredAt, "stateChange");
  const arts = headlineArtifacts(cell, node);
  const head = [...arts].sort((a, b) => HEADLINE_ORDER.indexOf(a.kind) - HEADLINE_ORDER.indexOf(b.kind))[0];
  const task = v.station === "build" && v.leftAt === null ? cell.tasks[cell.tasks.length - 1] : undefined;
  // The build's tasks as the grammar's red/green board, for this build loop (round 1 is loop 0).
  const board: TaskCell[] | null = v.station === "build" ? cell.tasks.filter((t) => t.loop === node.round - 1).map((t) => (t.status === "active" ? "active" : t.status === "red" ? "red" : "green")) : null;
  const label = v.action === "revise" ? "Build" : undefined;
  const cardX = next ? (node.x + next.x) / 2 : node.x + 30;
  return (
    <>
      <Pick entity={ref.station(v.station, cell.ticketId)}>
        <g style={{ opacity: 0.35 + 0.65 * appear }}>
          <StationMachine variant="blueprint" kind={stationKind(v.station)} state={state} progress={visitProgress(cell, node)} round={node.round > 1 ? node.round : undefined} at={{ x: node.x, y: node.y }} label={label} showLabel />
        </g>
        {task ? (
          <text x={node.x} y={node.y + 41} textAnchor="middle" style={{ fill: fc("live"), fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }} className="tabular" aria-hidden="true">
            {task.id} {task.status}
          </text>
        ) : v.leftAt !== null ? (
          <text x={node.x} y={node.y + 41} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }} className="tabular" aria-hidden="true">
            {duration(v.leftAt - v.enteredAt)}
          </text>
        ) : null}
      </Pick>
      {head ? <HandoffCard artifact={head} count={arts.length} x={cardX} y={node.y - 25} ticket={cell.ticketId} /> : null}
      {board && board.length ? (
        <g data-ref={ref.station(v.station, cell.ticketId)}>
          <TaskBoard variant="blueprint" tasks={board} columns={8} at={{ x: node.x - (Math.min(8, board.length) * 5.8 + 2.6) / 2, y: node.y + 46 }} />
        </g>
      ) : null}
    </>
  );
}

function HandoffCard({ artifact, count, x, y, ticket }: { artifact: ArtifactState; count: number; x: number; y: number; ticket: string }) {
  const p = useEventProgress(artifact.writtenAt, "artifactMaterialise");
  const failed = artifact.kind === "verification-findings" || (artifact.kind === "review-findings" && false);
  return (
    <Pick entity={ref.artifact(artifact.id)}>
      <g aria-hidden="true">
        <ArtifactCard variant="blueprint" kind={grammarArtifact(artifact.kind)} state={failed ? "failed" : "succeeded"} progress={Math.max(p, 0.001)} at={{ x, y }} showLabel={false} />
        {count > 1 ? (
          <text x={x + 10} y={y + 8} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5, opacity: p }} className="tabular">
            {count}
          </text>
        ) : null}
      </g>
      <title>{`${artifactFile(artifact)} (${ticket})${count > 1 ? `, and ${count - 1} more written at this station` : ""}`}</title>
    </Pick>
  );
}

function gatePosition(g: GateState): GatePosition {
  switch (g.state) {
    case "open":
      return "closed";
    case "passed":
    case "skipped":
      return "open";
    case "failed":
      return "refusing";
    case "waiting":
      return "waiting";
  }
}

function lampsFor(cell: CellState, g: GateState): GateLamp[] | undefined {
  if (g.gate === "review") {
    const round = cell.reviews.find((r) => r.round === g.round);
    if (!round) return undefined;
    return SEAT_KEYS.map((k) => {
      const seat = round.seats.find((s) => s.seat === k);
      return seat?.vote === "APPROVE" ? "pass" : seat?.vote === "REJECT" ? "fail" : "pending";
    });
  }
  if (g.gate === "red-before-green") {
    const red = cell.tasks.some((t) => t.status === "red" || (t.kind === "test" && t.status === "done"));
    const green = cell.tasks.some((t) => t.status === "green" || (t.kind === "impl" && t.status === "done"));
    return [red ? "fail" : "off", green ? "pass" : "off"];
  }
  return undefined;
}

function gateSub(cell: CellState, g: GateState): string {
  const at = g.decidedAt ?? g.openedAt;
  if (g.gate === "verification") {
    const ver = cell.verifications.find((x) => x.round === g.round);
    if (ver) {
      const passed = ver.checks.filter((c) => c.result === "pass").length;
      return `${passed}/${ver.checks.length} · ${clock(at)}`;
    }
  }
  if (g.gate === "review") {
    const r = cell.reviews.find((x) => x.round === g.round);
    if (r && r.approvals !== null) return `${r.approvals} of ${r.approvalsNeeded} · ${clock(at)}`;
    if (r) return `${r.risk} · ${r.approvalsNeeded} of 3`;
  }
  if (g.state === "skipped") return "not needed";
  if (g.state === "open") return `since ${clock(g.openedAt)}`;
  return clock(at);
}

function GateMark({ node, cell }: { node: FlowNode; cell: CellState }) {
  const g = node.gate!;
  const position = gatePosition(g);
  const p = useEventProgress(g.decidedAt ?? g.openedAt, g.state === "failed" ? "gateRefuse" : g.state === "open" ? "gateClose" : "gateOpen");
  const kind = grammarGate(g.gate);
  const tone = g.state === "failed" ? fc("fail") : g.state === "waiting" ? fc("human") : undefined;
  const callout = gateCallout(cell, g);
  return (
    <>
      <Pick entity={ref.gate(g.id)}>
        <g style={{ opacity: g.state === "skipped" ? 0.7 : 1 }}>
          <GateGlyph variant="blueprint" kind={kind} position={position} progress={p} lamps={lampsFor(cell, g)} at={{ x: node.x, y: node.y }} showLabel={false} />
        </g>
        <g transform={`translate(${node.x} ${node.y})`}>
          <Label y={32} text={SHORT_GATE[g.gate]} sub={gateSub(cell, g)} tone={tone} />
        </g>
      </Pick>
      {callout ? <GateCallout node={node} gate={g} {...callout} /> : null}
    </>
  );
}

function gateCallout(cell: CellState, g: GateState): { text: string; detail: string; tone: "fail" | "human"; at: number } | null {
  if (g.gate === "verification" && g.state === "failed" && g.decidedAt !== null) {
    const ver = cell.verifications.find((x) => x.round === g.round);
    const failed = ver?.checks.filter((c) => c.result === "fail") ?? [];
    const passed = ver?.checks.filter((c) => c.result === "pass").length ?? 0;
    return { text: `${failed.map((c) => c.targetId).join(", ")} failed · ${passed} of ${ver?.checks.length ?? 0} passed`, detail: failed[0]?.title ?? g.detail, tone: "fail", at: g.decidedAt };
  }
  if (g.gate === "review" && g.state === "failed" && g.decidedAt !== null) {
    const r = cell.reviews.find((x) => x.round === g.round);
    const blocker = r?.findings.find((f) => f.severity === "blocker" && !f.outvoted);
    return { text: `Rejected: ${blocker ? `${blocker.seat} blocker ${blocker.rule ?? ""}` : g.detail}`, detail: blocker ? clip(blocker.title, 64) : "", tone: "fail", at: g.decidedAt };
  }
  if (g.gate === "human-approval") {
    const r = [...cell.reviews].reverse().find((x) => x.humanApproval);
    if (g.state === "passed" && r?.humanApproval) {
      return { text: `Approved by ${r.humanApproval.by}`, detail: `${clock(r.humanApproval.at)} · waited ${duration(r.humanApproval.at - g.openedAt)}`, tone: "human", at: r.humanApproval.at };
    }
    if (g.state === "waiting" || g.state === "open") {
      const req = [...cell.reviews].reverse().find((x) => x.humanApprovalRequired);
      return { text: "Waiting for a person", detail: `since ${clock(g.openedAt)}${req?.humanApprovalReasons[0] ? ` · ${clip(req.humanApprovalReasons[0], 48)}` : ""}`, tone: "human", at: g.openedAt };
    }
  }
  return null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function GateCallout({ node, gate, text, detail, tone, at }: { node: FlowNode; gate: GateState; text: string; detail: string; tone: "fail" | "human"; at: number }) {
  // A failed verdict is followed by the review column and a rejection by the human gate, so their
  // notes lean back over the work that failed; the human gate's leans forward over what is to come.
  const left = gate.gate === "verification" || gate.gate === "review";
  const dy = gate.gate === "review" ? -74 : -48;
  const p = useEventProgress(at, "stateChange");
  if (p <= 0) return null;
  return (
    <g style={{ opacity: p }} role="note" aria-label={`${text}. ${detail}`}>
      {left ? <Callout x={node.x - 7} y={node.y - 9} dx={-18} dy={dy} text={text} detail={detail} tone={tone} /> : <Callout x={node.x + 7} y={node.y - 9} dx={18} dy={dy} text={text} detail={detail} tone={tone} />}
    </g>
  );
}

function SeatsMark({ node, cell, seats }: { node: FlowNode; cell: CellState; seats: readonly number[] }) {
  const round = reviewRound(cell, node);
  const delta = round?.delta ?? null;
  // A delta round's tag sits below the panel (clear of the loop and the main line's labels). The panel
  // needs no heading of its own: the column head names it, the consensus label carries its count.
  const headY = node.row === 0 ? node.y + (seats[0] ?? -28) - 21 : node.y + (seats[2] ?? 28) + 22;
  return (
    <g>
      {delta ? (
        <g aria-hidden="true" transform={`translate(${node.x} ${headY})`}>
          <text textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontSize: 9, fontWeight: 600 }}>
            Δ delta · {delta.filesChanged.length} files since {delta.sinceCommit.slice(0, 7)}
          </text>
        </g>
      ) : null}
      {SEAT_KEYS.map((k, i) => (
        <Seat key={k} index={i} node={node} cell={cell} round={round} dy={seats[i] ?? 0} />
      ))}
    </g>
  );
}

function Seat({ index, node, cell, round, dy }: { index: number; node: FlowNode; cell: CellState; round: ReviewRoundState | null; dy: number }) {
  const seat = round?.seats.find((s) => s.seat === SEAT_KEYS[index]) ?? null;
  const agent = seatAgent(cell, round, index);
  const arrive = useEventProgress(agent?.startedAt, "agentArrive");
  const findings = round?.findings.filter((f) => f.seat === SEAT_KEYS[index]) ?? [];
  const x = node.x;
  const y = node.y + dy;
  if (!seat) return null;
  const state: FactoryState = seat.vote === "APPROVE" ? "succeeded" : seat.vote === "REJECT" ? "failed" : agent ? agentState(agent) : "idle";
  const outvoted = findings.find((f) => f.severity === "blocker" && f.outvoted);
  const blockers = findings.filter((f) => f.severity === "blocker");
  // Blockers carry the grammar's flag with their rule; notes are a small count beside the seat, so a
  // panel of three with notes does not become a thicket of pennants between the branches.
  const flag = blockers.length ? { severity: "blocker" as const, count: blockers.length, rule: blockers[0]?.rule ?? undefined } : null;
  const notes = findings.length - blockers.length;
  return (
    <>
      <Pick entity={agent ? ref.agent(agent.id) : ref.gate(`${cell.ticketId}/review#${round?.round ?? 1}`)}>
        <AgentMarker variant="blueprint" agentRole="reviewer" seat={grammarSeat(seat.seat)} tier={tierOf(seat.model)} state={state} arrive={agent ? arrive : 0.35} at={{ x, y }} showLabel={false} />
        {/* The seat's findings as the grammar's flag, planted beside it: a blocker flag (with its rule) when
            the seat filed one, otherwise a note flag counting its notes. */}
        {flag ? <FindingsFlag variant="blueprint" at={{ x: x + 10, y: y - 5 }} severity={flag.severity} count={flag.count} rule={flag.rule} lod="near" /> : null}
        {notes > 0 && !flag ? (
          <g transform={`translate(${x + 10} ${y - 8})`}>
            <circle r={3.6} style={{ fill: fc("plate-top"), stroke: fc("wait"), strokeWidth: 0.9 }} />
            <text y={2.5} textAnchor="middle" style={{ fill: fc("wait"), fontSize: 6.5, fontWeight: 700 }}>
              {notes}
            </text>
          </g>
        ) : null}
      </Pick>
      {outvoted && round?.outcome ? <OutvotedCallout x={x} y={y} rule={outvoted.rule} title={outvoted.title} seat={outvoted.seat} at={round.decidedAt ?? outvoted.at} /> : null}
    </>
  );
}

function OutvotedCallout({ x, y, rule, title, seat, at }: { x: number; y: number; rule: string | null; title: string; seat: string; at: number }) {
  const p = useEventProgress(at, "stateChange");
  if (p <= 0) return null;
  return (
    <g style={{ opacity: p }} role="note" aria-label={`Outvoted ${seat} blocker ${rule ?? ""}: ${title}`}>
      <Callout x={x - 15} y={y + 4} dx={-22} dy={30} text={`Blocker outvoted · ${seat} ${rule ?? ""}`} detail={clip(title, 60)} tone="fail" />
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Dimension lines                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

interface DimGroup {
  key: string;
  row: number;
  x1: number;
  x2: number;
  start: number;
  end: number | null;
  what: string;
}

function dimGroups(flow: Flow): DimGroup[] {
  const groups: DimGroup[] = [];
  const built = flow.nodes.filter((n) => n.visit || n.gate);
  const take = (key: string, what: string, nodes: FlowNode[], start: number | null, end: number | null): void => {
    if (!nodes.length || start === null) return;
    const xs = nodes.map((n) => n.x);
    groups.push({ key, row: nodes[0]!.row, x1: Math.min(...xs) - 18, x2: Math.max(...xs) + 18, start, end, what });
  };
  const byRound = new Map<number, FlowNode[]>();
  for (const n of built) {
    let list = byRound.get(n.round);
    if (!list) byRound.set(n.round, (list = []));
    list.push(n);
  }
  for (const [round, nodes] of byRound) {
    const plan = nodes.filter((n) => n.col === "plan" || n.col === "plan-check" || n.col === "audit");
    const planVisit = plan.find((n) => n.visit)?.visit;
    if (planVisit) take(`plan${round}`, "Plan", plan, planVisit.enteredAt, planVisit.leftAt);
    const bv = nodes.filter((n) => n.col === "build" || n.col === "red-before-green" || n.col === "verify" || n.col === "verification");
    const buildV = bv.find((n) => n.col === "build")?.visit;
    const verdict = bv.find((n) => n.col === "verification")?.gate;
    const verifyV = bv.find((n) => n.col === "verify")?.visit;
    if (buildV) take(`bv${round}`, `Build and verify, round ${round}`, bv.filter((n) => n.row === bv.find((m) => m.col === "build")!.row), buildV.enteredAt, verdict?.decidedAt ?? (verifyV ? verifyV.leftAt : buildV.leftAt) ?? null);
    const rv = nodes.filter((n) => n.col === "review" || n.col === "consensus");
    const reviewV = rv.find((n) => n.visit)?.visit;
    if (reviewV) take(`rv${round}`, `Review, round ${round}`, rv, reviewV.enteredAt, reviewV.leftAt);
    const human = nodes.filter((n) => n.col === "human-approval");
    const hg = human[0]?.gate;
    if (hg) take(`hu${round}`, "Waiting for a person", human, hg.openedAt, hg.decidedAt);
    const integ = nodes.filter((n) => n.col === "merge-revalidation" || n.col === "merge" || n.col === "cleanup");
    const mergeV = integ.find((n) => n.col === "merge")?.visit;
    const cleanV = integ.find((n) => n.col === "cleanup")?.visit;
    if (mergeV) take(`in${round}`, "Merge and cleanup", integ, mergeV.enteredAt, cleanV ? cleanV.leftAt : null);
  }
  return groups;
}

function Dimensions({ flow, cell, y }: { flow: Flow; cell: CellState; y: number }) {
  const groups = dimGroups(flow);
  void cell;
  return (
    <g>
      {groups.map((g) => (g.end !== null ? <Dim key={g.key} g={g} y={y + g.row * 21 + 14} /> : <LiveDim key={g.key} g={g} y={y + g.row * 21 + 14} />))}
    </g>
  );
}

function Dim({ g, y }: { g: DimGroup; y: number }) {
  return (
    <g aria-label={`${g.what}: ${duration((g.end ?? g.start) - g.start)}`} role="img">
      <DimensionLine x1={g.x1} x2={g.x2} y={y} label={duration((g.end ?? g.start) - g.start)} extend={5} />
    </g>
  );
}

function LiveDim({ g, y }: { g: DimGroup; y: number }) {
  const t = usePlayhead(1000);
  return (
    <g aria-label={`${g.what}: running for ${duration(t - g.start)}`} role="img">
      <path d={`M${g.x1} ${y - 5}V${y + 3}`} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
      <line x1={g.x1} y1={y} x2={g.x2} y2={y} aria-hidden="true" style={{ stroke: fc("live"), strokeWidth: 0.75, strokeDasharray: "4 3" }} />
      <text x={(g.x1 + g.x2) / 2} y={y - 4} textAnchor="middle" style={{ fill: fc("live"), fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="tabular">
        running {duration(Math.max(0, t - g.start))}
      </text>
    </g>
  );
}

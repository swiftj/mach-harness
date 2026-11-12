/**
 * A cell's workflow at the overview level of detail (camera under 0.55, which is where "Fit" lands on
 * a landscape stage). At that zoom the full drawing's marks are 6 to 9 px across and its labels are
 * hidden, so the sheet reads as specks. Here the same nodes, in the same places, are drawn as the
 * grammar's state marks set large (shape first, colour second, exactly as in the legend: working ring,
 * passed tick, failed cross, a person's ring and dot, unbuilt dashed), routes are drawn heavy, and only
 * the outcomes that matter carry a word. Nothing new is said and nothing is said early: every mark is
 * the node's state at the playhead, and every word is shown from its event on.
 *
 * Detail (task boards, elapsed times, artifact cards, dimension lines, findings flags, callouts) comes
 * back with the full drawing above 0.6. This level draws fewer elements than the full one.
 */
import { factoryStates, fc, StateMark, type FactoryState } from "@mach/ui";
import type { CellState, GateState, ReviewRoundState } from "../sim";
import { ref } from "../sim";
import type { Flow, FlowNode } from "./flow";
import { ActivityMark } from "./marks";
import { useEventProgress, useLate, useStaleSince } from "./motion";
import { agentState, gateState } from "./vocab";

/** Sizes in sheet units: about 15 px across on screen at a fit of 0.42. */
const R = { station: 18, gate: 19, seat: 11, start: 12, end: 18, future: 13 } as const;
const STROKE = { route: 4.5, planned: 2.4, retry: 4 } as const;
const WORD = 26;
const SEATS = ["architecture", "security", "product"] as const;

const ink = (s: FactoryState): string => fc(factoryStates[s].ink);

function built(n: FlowNode): boolean {
  return n.kind !== "future" && !(n.kind === "end" && n.key.startsWith("f:"));
}

function stateOf(n: FlowNode): FactoryState | null {
  if (!built(n)) return null;
  if (n.kind === "start" || n.kind === "end") return "succeeded";
  if (n.gate) return gateState(n.gate);
  if (n.visit) return n.visit.leftAt === null ? (n.visit.station === "human-approval" ? "human" : "active") : n.visit.outcome === "failed" ? "failed" : "succeeded";
  return null;
}

/** Where a route leaves and meets a node at this level (its large mark's edge). */
function radius(n: FlowNode): number {
  if (n.kind === "gate" || (n.kind === "future" && !["plan", "build", "verify", "merge", "cleanup", "review"].includes(n.col))) return R.gate;
  if (n.kind === "seats" || (n.kind === "future" && n.col === "review")) return R.seat + 4;
  if (n.kind === "start") return R.start;
  return R.station;
}

export function OverviewFlow({ cell, flow, seats }: { cell: CellState; flow: Flow; seats: readonly number[] }) {
  return (
    <g>
      {flow.segments.map((s) => (
        <OverviewSegment key={`${s.from.key}>${s.to.key}`} from={s.from} to={s.to} retry={s.retry} seats={seats} cell={cell} />
      ))}
      {flow.nodes.map((n) => (
        <OverviewNode key={n.key} node={n} cell={cell} seats={seats} flow={flow} />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function startOf(n: FlowNode): number | null {
  if (n.visit) return n.visit.enteredAt;
  if (n.gate) return n.gate.openedAt;
  return null;
}

function OverviewSegment({ from, to, retry, seats, cell }: { from: FlowNode; to: FlowNode; retry: boolean; seats: readonly number[]; cell: CellState }) {
  if (retry) return <OverviewRetry from={from} to={to} />;
  if (to.col === "review" || from.col === "review") return <OverviewBranches from={from} to={to} seats={seats} cell={cell} />;
  return <OverviewRoute from={from} to={to} />;
}

function routeD(a: FlowNode, b: FlowNode): string {
  const x0 = a.x + radius(a) + 4;
  const x1 = b.x - radius(b) - 4;
  if (a.y === b.y) return `M${x0} ${a.y}H${x1}`;
  const mid = Math.round((x0 + x1) / 2);
  return `M${x0} ${a.y}H${mid}V${b.y}H${x1}`;
}

function OverviewRoute({ from, to }: { from: FlowNode; to: FlowNode }) {
  const start = startOf(to);
  const late = useLate(to.visit?.meta.eventId ?? to.gate?.meta.eventId);
  const draw = useEventProgress(start, "pathDraw", 0, late);
  const stale = useStaleSince() !== null;
  const d = routeD(from, to);
  if (!built(to)) return <path d={d} aria-hidden="true" style={{ fill: "none", stroke: fc("route"), strokeWidth: STROKE.planned, strokeDasharray: "8 7" }} />;
  const p = start === null ? 1 : draw;
  if (p <= 0) return null;
  const active = !stale && ((to.visit && to.visit.leftAt === null && to.visit.station !== "human-approval") || (to.gate?.state === "open" && to.gate.gate !== "red-before-green"));
  return (
    <path
      d={d}
      pathLength={1}
      aria-hidden="true"
      style={{ fill: "none", stroke: ink(active ? "active" : "succeeded"), strokeWidth: STROKE.route, strokeLinecap: "round", strokeLinejoin: "round", strokeDasharray: p < 1 ? `${p} 1` : undefined }}
    />
  );
}

function OverviewRetry({ from, to }: { from: FlowNode; to: FlowNode }) {
  const late = useLate(from.gate?.meta.eventId);
  const p = useEventProgress(from.gate?.decidedAt, "verifyReturn", 0, late);
  if (p <= 0) return null;
  // Down from the refusing gate, back along under the round, and into the build that starts the next one.
  const crest = from.y + Math.max(40, (to.y - from.y) * 0.55);
  return (
    <path
      d={`M${from.x} ${from.y + R.gate + 3}V${crest}H${to.x}V${to.y - R.station - 4}`}
      aria-hidden="true"
      style={{ fill: "none", stroke: fc("fail"), strokeWidth: STROKE.retry, strokeDasharray: "10 6", strokeLinejoin: "round", opacity: p }}
    />
  );
}

function roundOf(cell: CellState, n: FlowNode): ReviewRoundState | null {
  return cell.reviews.find((r) => r.round === n.round) ?? null;
}

/** The panel's fan-out (into the seats) or join (into consensus), one stroke per seat. */
function OverviewBranches({ from, to, seats, cell }: { from: FlowNode; to: FlowNode; seats: readonly number[]; cell: CellState }) {
  const fan = to.col === "review";
  const seatsNode = fan ? to : from;
  const round = built(seatsNode) ? roundOf(cell, seatsNode) : null;
  const p = useEventProgress(fan ? round?.startedAt : null, "fanOut");
  return (
    <g aria-hidden="true">
      {seats.map((dy, i) => {
        const seat = round?.seats.find((s) => s.seat === SEATS[i]) ?? null;
        const sx = seatsNode.x + (fan ? -(R.seat + 3) : R.seat + 3);
        const sy = seatsNode.y + dy;
        const other = fan ? from : to;
        const ox = other.x + (fan ? radius(other) + 4 : -radius(other) - 4);
        const d = fan ? `M${ox} ${other.y}L${sx} ${sy}` : `M${sx} ${sy}L${ox} ${other.y}`;
        if (!round) return <path key={i} d={d} style={{ fill: "none", stroke: fc("route"), strokeWidth: STROKE.planned, strokeDasharray: "8 7" }} />;
        const st: FactoryState = fan ? "succeeded" : seat?.vote === "APPROVE" ? "succeeded" : seat?.vote === "REJECT" ? "failed" : "active";
        // A join stroke stands for a vote: it is drawn only once that seat has voted.
        if (!fan && !seat?.vote) return <path key={i} d={d} style={{ fill: "none", stroke: fc("route"), strokeWidth: STROKE.planned, strokeDasharray: "8 7" }} />;
        return <path key={i} d={d} style={{ fill: "none", stroke: ink(st), strokeWidth: STROKE.route * 0.75, strokeLinecap: "round", opacity: fan ? Math.max(0.2, p) : 1 }} />;
      })}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function Unbuilt({ node, gate }: { node: FlowNode; gate: boolean }) {
  const r = gate ? R.gate : R.future;
  return (
    <g transform={`translate(${node.x} ${node.y})`} aria-hidden="true">
      {gate ? (
        <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 2, strokeDasharray: "6 4" }} />
      ) : (
        <circle r={r} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 2, strokeDasharray: "6 4" }} />
      )}
    </g>
  );
}

function OverviewNode({ node, cell, seats, flow }: { node: FlowNode; cell: CellState; seats: readonly number[]; flow: Flow }) {
  if (node.kind === "seats") return <OverviewSeats node={node} cell={cell} seats={seats} flow={flow} />;
  if (node.kind === "future") {
    if (node.col === "review") return <g aria-hidden="true">{seats.map((dy, i) => <circle key={i} cx={node.x} cy={node.y + dy} r={R.seat} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 2, strokeDasharray: "5 4" }} />)}</g>;
    return <Unbuilt node={node} gate={radius(node) === R.gate} />;
  }
  if (node.kind === "end" && !built(node)) return <Unbuilt node={node} gate={false} />;
  if (node.kind === "gate") return <OverviewGate node={node} cell={cell} />;
  if (node.kind === "start") {
    return (
      <g data-ref={ref.cell(cell.ticketId)} style={{ cursor: "pointer" }} aria-hidden="true">
        <circle cx={node.x} cy={node.y} r={R.start} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 3 }} />
        <circle cx={node.x} cy={node.y} r={4.5} style={{ fill: fc("ink") }} />
      </g>
    );
  }
  if (node.kind === "end") return <OverviewEnd node={node} cell={cell} />;
  return <OverviewVisit node={node} cell={cell} />;
}

function OverviewVisit({ node, cell }: { node: FlowNode; cell: CellState }) {
  const v = node.visit!;
  const late = useLate(v.meta.eventId);
  const appear = useEventProgress(v.enteredAt, "stateChange", 0, late);
  const stale = useStaleSince() !== null;
  const st = stateOf(node) ?? "idle";
  return (
    <g data-ref={ref.station(v.station, cell.ticketId)} style={{ cursor: "pointer", opacity: 0.35 + 0.65 * appear }} aria-hidden="true">
      <g transform={`translate(${node.x} ${node.y})`}>
        {/* Held, never working, while the connection is stale. */}
        {stale && st === "active" ? <ActivityMark state="stale" r={R.station} /> : <StateMark state={st} r={R.station} progress={0} />}
      </g>
    </g>
  );
}

function OverviewEnd({ node, cell }: { node: FlowNode; cell: CellState }) {
  return (
    <g data-ref={ref.slice(cell.sliceId)} style={{ cursor: "pointer" }} aria-hidden="true">
      <g transform={`translate(${node.x} ${node.y})`}>
        <StateMark state="succeeded" mark="double-ring" r={R.end} />
      </g>
    </g>
  );
}

/** The few outcomes worth a word at this distance, from their event on. */
function gateWord(cell: CellState, g: GateState): { text: string; state: FactoryState; at: number } | null {
  if (g.gate === "verification" && g.state === "failed" && g.decidedAt !== null) {
    const failed = cell.verifications.find((x) => x.round === g.round)?.checks.filter((c) => c.result === "fail").map((c) => c.targetId) ?? [];
    return { text: failed.length ? `${failed.join(", ")} failed` : "Refused", state: "failed", at: g.decidedAt };
  }
  if (g.gate === "review" && g.state === "failed" && g.decidedAt !== null) return { text: "Rejected", state: "failed", at: g.decidedAt };
  if (g.gate === "human-approval" && (g.state === "waiting" || g.state === "open")) return { text: "Waiting for a person", state: "human", at: g.openedAt };
  if (g.gate === "human-approval" && g.state === "passed" && g.decidedAt !== null) return { text: "Approved", state: "human", at: g.decidedAt };
  return null;
}

function OverviewGate({ node, cell }: { node: FlowNode; cell: CellState }) {
  const g = node.gate!;
  const st = gateState(g);
  const word = gateWord(cell, g);
  const p = useEventProgress(word?.at, "stateChange");
  const r = R.gate;
  return (
    <g data-ref={ref.gate(g.id)} style={{ cursor: "pointer" }} aria-hidden="true">
      <g transform={`translate(${node.x} ${node.y})`} style={{ opacity: g.state === "skipped" ? 0.7 : 1 }}>
        <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} style={{ fill: fc("plate-top"), stroke: ink(st), strokeWidth: st === "failed" ? 4 : 3, strokeLinejoin: "round" }} />
        <StateMark state={st} r={8.5} progress={0} />
      </g>
      {/* As the full drawing's callouts: a refusal leans back over the work that failed, a person's gate
          forward over what is to come, so adjacent words (a rejection, then the human gate) never meet. */}
      {word && p > 0 ? (
        <text x={word.state === "failed" ? node.x + 8 : node.x - 8} y={node.y - r - 12} textAnchor={word.state === "failed" ? "end" : "start"} className="bp-keep" style={{ fill: ink(word.state), fontSize: WORD, fontWeight: 700, opacity: p }}>
          {word.text}
        </text>
      ) : null}
    </g>
  );
}

function flowGate(flow: Flow, round: number): GateState | null {
  return flow.nodes.find((n) => n.gate?.gate === "review" && n.round === round)?.gate ?? null;
}

function OverviewSeats({ node, cell, seats, flow }: { node: FlowNode; cell: CellState; seats: readonly number[]; flow: Flow }) {
  const round = roundOf(cell, node);
  return (
    <g>
      {SEATS.map((key, i) => {
        const seat = round?.seats.find((s) => s.seat === key) ?? null;
        if (!seat) return null;
        const agent = seat.agentId ? (cell.agents[seat.agentId] ?? null) : null;
        const st: FactoryState = seat.vote === "APPROVE" ? "succeeded" : seat.vote === "REJECT" ? "failed" : agent ? agentState(agent) : "idle";
        // A seat with no agent yet names the round's consensus gate, found in the flow (never built from an id).
        const consensus = flowGate(flow, node.round);
        const entity = agent ? ref.agent(agent.id) : consensus ? ref.gate(consensus.id) : ref.cell(cell.ticketId);
        return (
          <g key={key} data-ref={entity} style={{ cursor: "pointer" }} aria-hidden="true" transform={`translate(${node.x} ${node.y + (seats[i] ?? 0)})`}>
            <StateMark state={st} r={R.seat} progress={0} />
          </g>
        );
      })}
    </g>
  );
}

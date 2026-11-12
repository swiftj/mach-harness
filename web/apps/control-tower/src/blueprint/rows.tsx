/**
 * The rows under a cell's workflow drawing: each execution as a rail across the columns it ran,
 * and, when opened, its belt relay, station visits (by round) and gates; under a visit, one lane per
 * agent; under an agent, its tool calls as ticks on the visit's time axis, with the artifacts it
 * wrote and the findings it filed. Time is exact here: every axis is a ruler in run time.
 */
import { memo, useContext, useMemo, type ReactNode } from "react";
import { AgentHead, ArtifactCard, DimensionLine, fc, StateMark, StationSymbol, ToolCap, ToolTick, type FactoryState } from "@mach/ui";
import type { AgentState, CellState, ExecutionState, FindingState, GateState, StationVisit, ToolCallState } from "../sim";
import { useSceneStore } from "../scene";
import type { Flow } from "./flow";
import { SHEET, type Row } from "./layout";
import { usePlayheadX, useEventProgress } from "./motion";
import { axisEnd, clock, duration, rulerStep } from "./time";
import type { TreeNode } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, useSelected } from "./treeitem";
import { agentState, agentWords, artifactFile, gateState, GATE_WORDS, grammarArtifact, grammarSeat, modelWord, stationKind, tierOf, toolFamily, visitWords } from "./vocab";

/** Rows are new objects after every layout; a row component re-renders only when what it draws changed. */
function sameRowProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of Object.keys(a)) {
    if (k === "row") {
      const ra = a.row as Row;
      const rb = b.row as Row;
      if (ra.node !== rb.node || ra.y !== rb.y || ra.h !== rb.h || ra.expanded !== rb.expanded || ra.expandable !== rb.expandable) return false;
    } else if (k === "children") {
      continue;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}

export interface Axis {
  readonly x0: number;
  readonly w: number;
  readonly start: number;
  readonly end: number;
}

export function xAt(axis: Axis, t: number): number {
  return axis.x0 + ((Math.min(Math.max(t, axis.start), axis.end) - axis.start) / (axis.end - axis.start)) * axis.w;
}

/** The axis end of a span that may be open, as a store subscription (changes only when the window doubles). */
function useAxis(x0: number, w: number, start: number, end: number | null): Axis {
  const e = useSceneStore((s) => axisEnd(start, end, s.playhead));
  return useMemo(() => ({ x0, w, start, end: e }), [x0, w, start, e]);
}

const GUTTER_X = SHEET.left;
const INDENT = [24, 38, 52];

/* ------------------------------------------------------------------------------------------------ */

function Rule({ x, w, y, weight = 0.6, color = fc("plate-edge") }: { x: number; w: number; y: number; weight?: number; color?: string }) {
  return <line x1={x} y1={y} x2={x + w} y2={y} aria-hidden="true" style={{ stroke: color, strokeWidth: weight }} />;
}

/** The ruler of a time axis: a baseline, minor ticks, and run-time labels at major ticks. */
export const Ruler = memo(function Ruler({ axis, y, open }: { axis: Axis; y: number; open: boolean }) {
  const span = axis.end - axis.start;
  const step = rulerStep(span, 8);
  const minor = step / 5;
  const first = Math.ceil(axis.start / minor) * minor;
  const ticks: ReactNode[] = [];
  let minorPath = "";
  for (let t = first; t <= axis.end + 1; t += minor) {
    const x = Math.round(xAt(axis, t) * 2) / 2;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    if (major) {
      ticks.push(
        <text key={t} x={x} y={y + 9} textAnchor="middle" style={{ fill: "var(--mach-ink-subtle)", fontFamily: "var(--mach-font-mono)", fontSize: 7.5 }} className="tabular">
          {clock(t)}
        </text>,
      );
      minorPath += `M${x} ${y - 3}v3`;
    } else minorPath += `M${x} ${y - 1.5}v1.5`;
  }
  return (
    <g aria-hidden="true">
      <line x1={axis.x0} y1={y} x2={axis.x0 + axis.w} y2={y} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6, strokeDasharray: open ? "2 2" : undefined }} />
      <path d={minorPath} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
      {ticks}
    </g>
  );
});

/** The playhead on a time axis: the same ink as the timeline's playhead, only while it is on this axis. */
function PlayheadMark({ axis, y1, y2 }: { axis: Axis; y1: number; y2: number }) {
  const x = usePlayheadX(axis.x0, axis.w, axis.start, axis.end);
  if (x === null) return null;
  return (
    <g aria-hidden="true">
      <line x1={x} y1={y1} x2={x} y2={y2} style={{ stroke: "var(--mach-ink)", strokeWidth: 1 }} />
      <path d={`M${x - 3} ${y1 - 3}h6l-3 3.5z`} style={{ fill: "var(--mach-ink)" }} />
    </g>
  );
}

/** A span that is still open is drawn to the playhead, which moves; so it is its own component. */
function LiveSpan({ axis, start, y, color, weight }: { axis: Axis; start: number; y: number; color: string; weight: number }) {
  const x = usePlayheadX(axis.x0, axis.w, axis.start, axis.end);
  const x0 = xAt(axis, start);
  const x1 = x ?? axis.x0 + axis.w;
  return <line x1={x0} y1={y} x2={Math.max(x0 + 1, x1)} y2={y} aria-hidden="true" style={{ stroke: color, strokeWidth: weight, strokeLinecap: "round" }} />;
}

/* ------------------------------------------------------------------------------------------------ */
/* Execution                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface RowsProps {
  rows: readonly Row[];
  /** The rows' parent lane's y, to make row coordinates lane-local. */
  laneY: number;
  ax: number;
  aw: number;
  width: number;
  flow: Flow;
  cell: CellState;
}

/** Every row of one execution, nested as the tree is: execution > visits, gates, relay > agents > leaves. */
export function ExecutionRows({ exec, pos, size, rows, laneY, ax, aw, width, flow, cell }: RowsProps & { exec: Row; pos: number; size: number }) {
  const children = rows.filter((r) => r.node.parent === exec.id);
  const n = exec.node.children.length;
  return (
    <ExecItem row={exec} pos={pos} size={size} laneY={laneY} ax={ax} width={width} flow={flow} cell={cell}>
      {children.map((r) => {
        const agents = rows.filter((a) => a.node.parent === r.id);
        const at = exec.node.children.indexOf(r.node) + 1;
        if (r.node.kind === "gate") return <GateItem key={r.id} row={r} pos={at} size={n} laneY={laneY} ax={ax} width={width} />;
        return (
          <SpanItem key={r.id} row={r} pos={at} size={n} laneY={laneY} ax={ax} aw={aw} width={width}>
            {agents.map((a) => (
              <AgentItem key={a.id} row={a} pos={r.node.children.indexOf(a.node) + 1} size={r.node.children.length} laneY={laneY} ax={ax} width={width} parent={r.node} aw={aw} />
            ))}
          </SpanItem>
        );
      })}
    </ExecItem>
  );
}

function execColumns(flow: Flow, exec: ExecutionState): { x1: number; x2: number } | null {
  const xs: number[] = [];
  const end = exec.endedAt ?? Infinity;
  for (const n of flow.nodes) {
    const t = n.visit?.enteredAt ?? n.gate?.openedAt;
    if (t === undefined || t < exec.claimedAt || t > end) continue;
    xs.push(n.x);
  }
  if (!xs.length) return null;
  return { x1: Math.min(...xs), x2: Math.max(...xs) };
}

const ExecItem = memo(function ExecItem({ row, pos, size, laneY, ax, width, flow, cell, children }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; flow: Flow; cell: CellState; children: ReactNode }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  if (node.data.kind !== "execution") return null;
  const { execution: x, index, count } = node.data;
  const y = row.y - laneY;
  const cols = execColumns(flow, x);
  const running = x.state === "running" || x.state === "claimed";
  const ink = running ? fc("live") : x.state === "failed" ? fc("fail") : fc("ink-soft");
  const end = x.endedAt;
  const status = running ? "running" : x.outcome?.waitingFor && x.outcome.waitingFor !== "nothing" ? `returned, waiting for ${x.outcome.waitingFor}` : x.outcome ? `completed${x.outcome.stage ? `, ${x.outcome.stage}` : ""}` : x.state;
  const gx = GUTTER_X + INDENT[0]!;
  const railY = y + 18;
  return (
    <Item node={node} pos={pos} size={size} expanded={row.expanded} ring={{ x: GUTTER_X + 14, y: y + 3, w: width - GUTTER_X * 2 - 14, h: row.h - 6 }} group={children}>
      <Rule x={GUTTER_X + 18} w={width - GUTTER_X * 2 - 18} y={y} weight={0.6} />
      {selected ? <SelectBar x={GUTTER_X + 16} y={y + 1} h={row.h - 2} /> : null}
      {row.expandable ? <ToggleTarget x={gx} y={y + 16} /> : null}
      {row.expandable ? <Chevron x={gx} y={y + 16} open={row.expanded} /> : null}
      <text x={gx + 10} y={y + 15} style={{ fill: "var(--mach-ink)", fontSize: 11, fontWeight: 600 }}>
        Execution {index + 1}
        <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> of {count}</tspan>
      </text>
      <text x={gx + 10} y={y + 27} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }} className="notranslate">
        {x.id} · {x.workflow ?? "workflow"} · next {x.next}
      </text>
      {cols ? (
        <g aria-hidden="true">
          {/* The rail: an execution as a bracket across the columns it ran. */}
          <path d={`M${ax + cols.x1 - 16} ${railY - 5}v5H${ax + cols.x2 + (running ? 6 : 16)}${running ? "" : "v-5"}`} style={{ fill: "none", stroke: ink, strokeWidth: running ? 1.6 : 1.1 }} />
          {running ? <path d={`M${ax + cols.x2 + 6} ${railY - 3.5}l5 3.5l-5 3.5`} style={{ fill: "none", stroke: ink, strokeWidth: 1.4 }} /> : null}
          <text x={ax + cols.x1 - 16} y={railY - 8} style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }} className="tabular">
            <tspan style={{ fontFamily: "var(--mach-font-mono)" }}>{clock(x.startedAt ?? x.claimedAt)}</tspan>
            {end !== null ? <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> → {clock(end)} · {duration(end - (x.startedAt ?? x.claimedAt))}</tspan> : null}
            <tspan> · {status}</tspan>
            {x.outcome ? <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> · ${x.outcome.costUsd.toFixed(2)}</tspan> : null}
          </text>
        </g>
      ) : null}
      <g transform={`translate(${GUTTER_X + 6} ${y + 16})`}>
        <StateMark state={running ? "active" : x.state === "failed" ? "failed" : "succeeded"} r={4.5} progress={0} />
      </g>
      <title>{`${node.name}. Opened by the supervisor on ${cell.ticketId}.`}</title>
    </Item>
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* Visit (and the belt relay): a lane with a time axis                                               */
/* ------------------------------------------------------------------------------------------------ */

function spanOf(node: TreeNode): { start: number; end: number | null; agents: readonly AgentState[] } | null {
  if (node.data.kind === "visit") return { start: node.data.visit.enteredAt, end: node.data.visit.leftAt, agents: node.data.agents };
  if (node.data.kind === "relay") return { start: node.data.execution.startedAt ?? node.data.execution.claimedAt, end: node.data.execution.endedAt, agents: node.data.agents };
  return null;
}

const SpanItem = memo(function SpanItem({ row, pos, size, laneY, ax, aw, width, children }: { row: Row; pos: number; size: number; laneY: number; ax: number; aw: number; width: number; children: ReactNode }) {
  const node = row.node;
  const span = spanOf(node);
  const axis = useAxis(ax, aw, span?.start ?? 0, span?.end ?? null);
  const selected = useSelected(node.ref);
  if (!span) return null;
  const y = row.y - laneY;
  const gx = GUTTER_X + INDENT[1]!;
  const visit: StationVisit | null = node.data.kind === "visit" ? node.data.visit : null;
  const title = visit ? `${visitWords(visit)}` : "Belt relay";
  const round = visit ? (visit.action === "revise" ? visit.round + 1 : visit.round) : null;
  const sub = `${clock(span.start)}–${span.end !== null ? clock(span.end) : "now"}`;
  const open = span.end === null;
  const state: FactoryState = visit ? (open ? (visit.station === "human-approval" ? "human" : "active") : visit.outcome === "failed" || visit.outcome === "rejected" ? "failed" : "succeeded") : open ? "active" : "succeeded";
  const h = SHEET.visitRow;
  const ruleY = y + h - 9;
  return (
    <Item node={node} pos={pos} size={size} expanded={row.expanded} ring={{ x: GUTTER_X + 28, y: y + 2, w: width - GUTTER_X * 2 - 28, h: h - 4 }} group={children}>
      <Rule x={GUTTER_X + 30} w={width - GUTTER_X * 2 - 30} y={y} weight={0.5} color={fc("grid-major")} />
      {selected ? <SelectBar x={GUTTER_X + 28} y={y + 1} h={h - 2} /> : null}
      {row.expandable ? <ToggleTarget x={gx} y={y + 15} /> : null}
      {row.expandable ? <Chevron x={gx} y={y + 15} open={row.expanded} /> : null}
      <g transform={`translate(${gx + 16} ${y + 15})`} aria-hidden="true">
        {visit ? <StationSymbol kind={stationKind(visit.station)} size={13} color={fc(state === "active" ? "live" : "ink")} strokeWidth={1.3} /> : <circle r={4.5} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.1, strokeDasharray: "2 1.6" }} />}
      </g>
      <text x={gx + 28} y={y + 15} style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
        {title}
        {round !== null ? <tspan style={{ fill: round > 1 ? fc("fail") : "var(--mach-ink-muted)", fontWeight: 400 }}> · round {round}</tspan> : null}
      </text>
      <text x={gx + 28} y={y + 27} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }} className="tabular">
        {sub} · {span.agents.length} agent{span.agents.length === 1 ? "" : "s"} · {span.agents.reduce((n, a) => n + a.toolCalls.length, 0)} calls
      </text>
      <Ruler axis={axis} y={ruleY} open={open} />
      {/* Agents at a glance: one hairline per agent across its span, in its state ink. */}
      <AgentGlance axis={axis} agents={span.agents} y={y + 6} />
      <PlayheadMark axis={axis} y1={y + 4} y2={ruleY} />
    </Item>
  );
});

const AgentGlance = memo(function AgentGlance({ axis, agents, y }: { axis: Axis; agents: readonly AgentState[]; y: number }) {
  const shown = agents.slice(0, 6);
  let ticks = "";
  for (const a of agents) for (const c of a.toolCalls) {
    const x = Math.round(xAt(axis, c.startedAt) * 2) / 2;
    ticks += `M${x} ${y + 18}v-3`;
  }
  return (
    <g aria-hidden="true">
      {shown.map((a, i) =>
        a.finishedAt === null ? (
          <LiveSpan key={a.id} axis={axis} start={a.startedAt} y={y + 2 + i * 2.4} color={fc("live")} weight={1.4} />
        ) : (
          <line key={a.id} x1={xAt(axis, a.startedAt)} y1={y + 2 + i * 2.4} x2={Math.max(xAt(axis, a.startedAt) + 1, xAt(axis, a.finishedAt))} y2={y + 2 + i * 2.4} style={{ stroke: fc(a.status === "error" ? "fail" : "ink-soft"), strokeWidth: 1.4, strokeLinecap: "round" }} />
        ),
      )}
      <path d={ticks} style={{ stroke: fc("ink-soft"), strokeWidth: 0.8 }} />
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* Gate row                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const GateItem = memo(function GateItem({ row, pos, size, laneY, ax, width }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  if (node.data.kind !== "gate") return null;
  const g: GateState = node.data.gate;
  const y = row.y - laneY;
  const gx = GUTTER_X + INDENT[1]! + 16;
  const st = gateState(g);
  const ink = fc(st === "idle" ? "ink-soft" : st === "active" ? "live" : st === "succeeded" ? "pass" : st === "failed" ? "fail" : "human");
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: GUTTER_X + 28, y: y + 1, w: width - GUTTER_X * 2 - 28, h: row.h - 2 }}>
      {selected ? <SelectBar x={GUTTER_X + 28} y={y + 1} h={row.h - 2} /> : null}
      <path d={`M${gx} ${y + 6}l6 6l-6 6l-6 -6z`} aria-hidden="true" style={{ fill: st === "idle" ? fc("plate-top") : fc(st === "active" ? "live-soft" : st === "succeeded" ? "pass-soft" : st === "failed" ? "fail-soft" : "human-soft"), stroke: ink, strokeWidth: 1.1 }} />
      <text x={gx + 12} y={y + 15.5} style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
        {GATE_WORDS[g.gate]}
        {g.round ? <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> #{g.round}</tspan> : null}
      </text>
      <text x={ax} y={y + 15.5} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
        <tspan style={{ fill: ink, fontWeight: 600 }}>{g.state}</tspan>
        <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> {clock(g.openedAt)}{g.decidedAt !== null && g.decidedAt !== g.openedAt ? ` → ${clock(g.decidedAt)}` : ""}</tspan>
        <tspan> · {g.detail.length > 150 ? `${g.detail.slice(0, 149)}…` : g.detail}</tspan>
      </text>
    </Item>
  );
}, sameRowProps);

/* ------------------------------------------------------------------------------------------------ */
/* Agent lane                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

const AgentItem = memo(function AgentItem({ row, pos, size, laneY, ax, aw, width, parent }: { row: Row; pos: number; size: number; laneY: number; ax: number; aw: number; width: number; parent: TreeNode }) {
  const node = row.node;
  const span = spanOf(parent);
  const axis = useAxis(ax, aw, span?.start ?? 0, span?.end ?? null);
  const selected = useSelected(node.ref);
  const band = useContext(BandContext);
  if (node.data.kind !== "agent") return null;
  const a = node.data.agent;
  const y = row.y - laneY;
  const gx = GUTTER_X + INDENT[2]!;
  const st = agentState(a);
  const words = agentWords(a);
  const h = row.h;
  const base = row.expanded ? y + 44 : y + 18;
  // Off screen, an open agent's calls are drawn as one path; its leaves mount when the camera comes near.
  const near = row.y + row.h >= band[0] && row.y <= band[1];
  const leaves = row.expanded && near ? node.children : [];
  return (
    <Item
      node={node}
      pos={pos}
      size={size}
      expanded={row.expanded}
      ring={{ x: GUTTER_X + 42, y: y + 1, w: width - GUTTER_X * 2 - 42, h: h - 2 }}
      group={leaves.length ? leaves.map((leafNode, i) => <Leaf key={leafNode.id} node={leafNode} pos={i + 1} size={leaves.length} axis={axis} base={base} />) : undefined}
    >
      <Rule x={GUTTER_X + 44} w={width - GUTTER_X * 2 - 44} y={y} weight={0.4} color={fc("grid")} />
      {selected ? <SelectBar x={GUTTER_X + 42} y={y + 1} h={h - 2} /> : null}
      {row.expandable ? <ToggleTarget x={gx} y={y + 14} /> : null}
      {row.expandable ? <Chevron x={gx} y={y + 14} open={row.expanded} /> : null}
      <g transform={`translate(${gx + 16} ${y + 14})`} aria-hidden="true">
        <AgentHead tier={tierOf(a.model)} fill={st === "active" ? fc("live") : fc("plate-top")} stroke={fc(st === "active" ? "live" : st === "failed" ? "fail" : "ink")} />
      </g>
      {a.seat && grammarSeat(a.seat) ? (
        <text x={gx + 16} y={y + 5} textAnchor="middle" aria-hidden="true" style={{ fill: "var(--mach-ink-muted)", fontSize: 7.5, fontWeight: 700 }}>
          {a.seat[0]!.toUpperCase()}
        </text>
      ) : null}
      <text x={gx + 28} y={y + 13} style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
        {words.length > 28 ? `${words.slice(0, 27)}…` : words}
        <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> · {modelWord(a.model)}</tspan>
      </text>
      <text x={gx + 28} y={y + 24} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8 }} className="tabular">
        {a.agentType ?? a.role} · {a.toolCalls.length} calls{a.finishedAt !== null ? ` · ${duration(a.finishedAt - a.startedAt)}` : ""}
      </text>
      {/* The agent's span on its visit's axis; open while it works. */}
      {a.finishedAt === null ? (
        <LiveSpan axis={axis} start={a.startedAt} y={base + 1} color={fc("live")} weight={row.expanded ? 1 : 2} />
      ) : (
        <line x1={xAt(axis, a.startedAt)} y1={base + 1} x2={Math.max(xAt(axis, a.startedAt) + 1, xAt(axis, a.finishedAt))} y2={base + 1} aria-hidden="true" style={{ stroke: fc(a.status === "error" ? "fail" : "ink-soft"), strokeWidth: row.expanded ? 1 : 2, strokeLinecap: "round" }} />
      )}
      {row.expanded ? <AgentDetail agent={a} axis={axis} base={base} y={y} /> : null}
      {!row.expanded || !near ? <TickDensity agent={a} axis={axis} base={base} /> : null}
      <PlayheadMark axis={axis} y1={y + 3} y2={y + h - 3} />
    </Item>
  );
}, sameRowProps);

/** A collapsed agent's tool calls as one path: a stem per call, so a dense row costs one element. */
const TickDensity = memo(function TickDensity({ agent, axis, base }: { agent: AgentState; axis: Axis; base: number }) {
  let d = "";
  let live: ToolCallState | null = null;
  for (const c of agent.toolCalls) {
    if (c.status === "running") live = c;
    const x = Math.round(xAt(axis, c.startedAt) * 2) / 2;
    d += `M${x} ${base}v-6`;
  }
  return (
    <g aria-hidden="true">
      <path d={d} style={{ stroke: fc("ink"), strokeWidth: 0.9 }} />
      {live ? <line x1={xAt(axis, live.startedAt)} y1={base} x2={xAt(axis, live.startedAt)} y2={base - 7} style={{ stroke: fc("live"), strokeWidth: 1.6 }} /> : null}
    </g>
  );
});

/** An expanded agent's calls in detail: durations under the line, artifacts above it, a dimension for the agent's whole span. */
const AgentDetail = memo(function AgentDetail({ agent, axis, base, y }: { agent: AgentState; axis: Axis; base: number; y: number }) {
  let bars = "";
  for (const c of agent.toolCalls) {
    if (c.finishedAt === null) continue;
    const x1 = xAt(axis, c.startedAt);
    const x2 = Math.max(x1 + 1, xAt(axis, c.finishedAt));
    bars += `M${x1} ${base + 5}H${x2}`;
  }
  return (
    <g aria-hidden="true">
      <path d={bars} style={{ stroke: fc("ink-soft"), strokeWidth: 2.2, strokeLinecap: "butt" }} />
      {agent.finishedAt !== null ? <DimensionLine x1={xAt(axis, agent.startedAt)} x2={Math.max(xAt(axis, agent.startedAt) + 2, xAt(axis, agent.finishedAt))} y={y + 70} label={duration(agent.finishedAt - agent.startedAt)} extend={4} /> : null}
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* Leaves: tool calls, artifacts, findings                                                           */
/* ------------------------------------------------------------------------------------------------ */

const Leaf = memo(function Leaf({ node, pos, size, axis, base }: { node: TreeNode; pos: number; size: number; axis: Axis; base: number }) {
  switch (node.data.kind) {
    case "tool":
      return <ToolLeaf node={node} pos={pos} size={size} call={node.data.call} axis={axis} base={base} />;
    case "artifact": {
      const a = node.data.artifact;
      const x = xAt(axis, a.writtenAt);
      return (
        <Item node={node} pos={pos} size={size} ring={{ x: x - 9, y: base - 38, w: 18, h: 22, r: 2 }}>
          <ArtifactLeaf x={x} y={base - 27} kind={a.kind} at={a.writtenAt} file={artifactFile(a)} task={a.kind === "commit" ? (/\b(R\d-)?T\d\d\b/.exec(a.label)?.[0] ?? null) : null} />
        </Item>
      );
    }
    case "finding":
      return <FindingLeaf node={node} pos={pos} size={size} finding={node.data.finding} axis={axis} base={base} />;
    default:
      return null;
  }
});

function ArtifactLeaf({ x, y, kind, at, file, task }: { x: number; y: number; kind: Parameters<typeof grammarArtifact>[0]; at: number; file: string; task: string | null }) {
  const p = useEventProgress(at, "artifactMaterialise");
  const failed = kind === "verification-findings";
  return (
    <g>
      <ArtifactCard variant="blueprint" kind={grammarArtifact(kind)} state={failed ? "failed" : "succeeded"} progress={Math.max(0.001, p)} at={{ x, y }} showLabel={false} />
      {task ? (
        <text x={x + 9} y={y - 4} aria-hidden="true" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 7.5, opacity: p }}>
          {task}
        </text>
      ) : null}
      <title>{file}</title>
    </g>
  );
}

function ToolLeaf({ node, pos, size, call, axis, base }: { node: TreeNode; pos: number; size: number; call: ToolCallState; axis: Axis; base: number }) {
  const p = useEventProgress(call.startedAt, "toolTick");
  const x = xAt(axis, call.startedAt);
  const st: FactoryState = call.status === "running" ? "active" : call.status === "error" ? "failed" : "succeeded";
  const fam = toolFamily(call);
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: x - 5, y: base - 16, w: 10, h: 18, r: 2 }}>
      <ToolTick variant="blueprint" family={fam} state={st} progress={p} detail={`${call.tool} ${call.target}`} at={{ x, y: base }} />
      <title>{`${call.tool} ${call.target} · ${clock(call.startedAt)}${call.finishedAt !== null ? ` · ${duration(call.finishedAt - call.startedAt)}` : " · running"}${call.summary ? ` · ${call.summary}` : ""}`}</title>
    </Item>
  );
}

function FindingLeaf({ node, pos, size, finding, axis, base }: { node: TreeNode; pos: number; size: number; finding: FindingState; axis: Axis; base: number }) {
  const x = xAt(axis, finding.at);
  const blocker = finding.severity === "blocker";
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: x - 6, y: base + 9, w: 12, h: 12, r: 2 }}>
      {blocker ? (
        <path d={`M${x} ${base + 10}l5 5l-5 5l-5 -5z`} style={{ fill: finding.outvoted ? fc("plate-top") : fc("fail"), stroke: fc("fail"), strokeWidth: 1.1 }} />
      ) : (
        <circle cx={x} cy={base + 15} r={3} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.1 }} />
      )}
      <title>{node.name}</title>
    </Item>
  );
}

// ToolCap is part of the grammar; a legend row uses it.
export function ToolLegend({ x, y }: { x: number; y: number }) {
  const fams = ["read", "write", "run", "search", "test", "git"] as const;
  return (
    <g aria-hidden="true" transform={`translate(${x} ${y})`}>
      {fams.map((f, i) => (
        <g key={f} transform={`translate(${i * 56} 0)`}>
          <ToolCap family={f} color={fc("ink")} />
          <text x={8} y={3.5} style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
            {f}
          </text>
        </g>
      ))}
    </g>
  );
}

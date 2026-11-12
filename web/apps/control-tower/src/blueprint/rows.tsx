/**
 * The rows under a cell's workflow drawing: each execution as a rail across the columns it ran and,
 * when opened, one ruler for the whole execution (a broken scale, see axis.ts), then its belt relay,
 * station visits (by round) and gates; under a visit, one lane per agent; under an open agent, its
 * tool calls as a trace on the same axis, with the artifacts it wrote and the findings it filed.
 * Every row's gutter is portalled into the pinned gutter layer. Rows far from the viewport are not
 * rendered (their tree items mount when the camera or the keyboard comes near).
 */
import { memo, useContext, type ReactNode } from "react";
import { AgentHead, ArtifactCard, DimensionLine, fc, StateMark, StationSymbol, TimeRuler, type FactoryState } from "@mach/ui";
import type { AgentState, CellState, ExecutionState, FindingState, GateState, StationVisit } from "../sim";
import { useSceneStore } from "../scene";
import { execAxis, xOn, type ExecAxis } from "./axis";
import { LodContext } from "./context";
import type { Flow } from "./flow";
import { Gutter } from "./gutter";
import { SHEET, type Row } from "./layout";
import { useEventProgress } from "./motion";
import { clock, duration } from "./time";
import { ToolTrace } from "./ticks";
import type { TreeNode } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, useSelected, useTreeCtx } from "./treeitem";
import { agentState, agentWords, artifactFile, gateState, GATE_WORDS, grammarArtifact, grammarSeat, modelWord, STATION_WORDS, stationKind, tierOf } from "./vocab";

const GX = SHEET.left;
const INDENT = [22, 36, 50];

/** Rows are new objects after every layout; a row re-renders only when what it draws changed. */
function sameRowProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of Object.keys(a)) {
    if (k === "row") {
      const ra = a.row as Row;
      const rb = b.row as Row;
      if (ra.node !== rb.node || ra.y !== rb.y || ra.h !== rb.h || ra.expanded !== rb.expanded || ra.expandable !== rb.expandable) return false;
    } else if (k === "children") continue;
    else if (a[k] !== b[k]) return false;
  }
  return true;
}

function Rule({ x, w, y, weight = 0.6, color = fc("plate-edge") }: { x: number; w: number; y: number; weight?: number; color?: string }) {
  return <line x1={x} y1={y} x2={x + w} y2={y} aria-hidden="true" style={{ stroke: color, strokeWidth: weight }} />;
}

/** The focus ring's share of a row that falls under the pinned gutter. */
function GutterRing({ id, x, h }: { id: string; x: number; h: number }) {
  const ctx = useTreeCtx();
  if (ctx.focusedId !== id) return null;
  return <rect x={x} y={1} width={SHEET.gutter - (x - GX) - 16} height={h - 2} rx={3} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 }} />;
}

/* ------------------------------------------------------------------------------------------------ */
/* Execution                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface RowsProps {
  rows: readonly Row[];
  laneY: number;
  ax: number;
  aw: number;
  width: number;
  flow: Flow;
  cell: CellState;
}

function visitsOf(node: TreeNode): StationVisit[] {
  return node.children.flatMap((c) => (c.data.kind === "visit" ? [c.data.visit] : []));
}

/** Every row of one execution: execution > relay, visits, gates > agents > leaves; culled to the band. */
export function ExecutionRows({ exec, pos, size, rows, laneY, ax, aw, width, flow, cell }: RowsProps & { exec: Row; pos: number; size: number }) {
  const band = useContext(BandContext);
  const ctx = useTreeCtx();
  const x = exec.node.data.kind === "execution" ? exec.node.data.execution : null;
  const visits = visitsOf(exec.node);
  const axis = useSceneStore((s) => (x ? execAxis(ax, aw, x, visits, s.playhead) : null));
  if (!x || !axis) return null;
  const n = exec.node.children.length;
  const near = (r: Row): boolean => (r.y + r.h >= band[0] && r.y <= band[1]) || ctx.activeId === r.id || (ctx.activeId !== null && ctx.activeId.startsWith("t:") && r.node.kind === "agent" && r.node.children.some((c) => c.id === ctx.activeId));
  const children = exec.expanded ? rows.filter((r) => r.node.parent === exec.id) : [];
  return (
    <ExecItem row={exec} pos={pos} size={size} laneY={laneY} ax={ax} width={width} flow={flow} cell={cell} axis={axis}>
      {children.map((r) => {
        const at = exec.node.children.indexOf(r.node) + 1;
        const agents = rows.filter((a) => a.node.parent === r.id);
        const show = near(r) || agents.some(near);
        if (!show) return null;
        if (r.node.kind === "gate") return <GateItem key={r.id} row={r} pos={at} size={n} laneY={laneY} ax={ax} width={width} axis={axis} />;
        return (
          <SpanItem key={r.id} row={r} pos={at} size={n} laneY={laneY} ax={ax} width={width} axis={axis}>
            {agents.filter(near).map((a) => (
              <AgentItem key={a.id} row={a} pos={r.node.children.indexOf(a.node) + 1} size={r.node.children.length} laneY={laneY} ax={ax} width={width} axis={axis} />
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

const ExecItem = memo(function ExecItem({ row, pos, size, laneY, ax, width, flow, cell, axis, children }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; flow: Flow; cell: CellState; axis: ExecAxis; children: ReactNode }) {
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
  const gx = GX + INDENT[0]!;
  const railY = y + 18;
  return (
    <Item node={node} pos={pos} size={size} expanded={row.expanded} ring={{ x: ax - 12, y: y + 2, w: width - ax - SHEET.left + 10, h: row.h - 4 }} group={children}>
      <Rule x={ax - 14} w={width - ax - SHEET.left + 14} y={y} weight={0.6} />
      {cols ? (
        <g>
          {/* The rail: an execution as a bracket across the columns it ran. */}
          <path d={`M${ax + cols.x1 - 16} ${railY - 5}v5H${ax + cols.x2 + (running ? 6 : 16)}${running ? "" : "v-5"}`} style={{ fill: "none", stroke: ink, strokeWidth: running ? 1.6 : 1.1 }} />
          {running ? <path d={`M${ax + cols.x2 + 6} ${railY - 3.5}l5 3.5l-5 3.5`} style={{ fill: "none", stroke: ink, strokeWidth: 1.4 }} /> : null}
          <text x={ax + cols.x1 - 16} y={railY - 8} className="bp-fine tabular" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
            <tspan style={{ fontFamily: "var(--mach-font-mono)" }}>{clock(x.startedAt ?? x.claimedAt)}</tspan>
            {end !== null ? <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> → {clock(end)} · {duration(end - (x.startedAt ?? x.claimedAt))}</tspan> : null}
            <tspan> · {status}</tspan>
            {x.outcome ? <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> · ${x.outcome.costUsd.toFixed(2)}</tspan> : null}
          </text>
        </g>
      ) : null}
      {row.expanded ? <ExecRuler axis={axis} y={y + 32} /> : null}
      <Gutter row id={node.id} entity={node.ref} y={row.y} h={row.h} ax={ax}>
        <Rule x={GX + 14} w={SHEET.gutter - 28} y={0} weight={0.6} />
        {selected ? <SelectBar x={GX + 12} y={1} h={row.h - 2} /> : null}
        <GutterRing id={node.id} x={GX + 12} h={row.h} />
        {row.expandable ? <ToggleTarget x={gx} y={16} /> : null}
        {row.expandable ? <Chevron x={gx} y={16} open={row.expanded} /> : null}
        <g transform={`translate(${gx + 14} 16)`}>
          <StateMark state={running ? "active" : x.state === "failed" ? "failed" : "succeeded"} r={4.5} progress={0} />
        </g>
        <text x={gx + 24} y={15} className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 11, fontWeight: 600 }}>
          Execution {index + 1}
          <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> of {count}</tspan>
        </text>
        <text x={gx + 24} y={27} className="bp-fine notranslate" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }}>
          {x.id} · {x.workflow ?? "workflow"} · next {x.next}
        </text>
        {row.expanded ? (
          <text x={gx + 24} y={48} className="bp-fine" style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5 }}>
            one time axis for the execution · broken scale
          </text>
        ) : null}
      </Gutter>
      <title>{`${node.name}. Opened by the supervisor on ${cell.ticketId}.`}</title>
    </Item>
  );
});

/**
 * The execution's ruler, drawn once: for each visit's segment the grammar's `TimeRuler` (factory time,
 * majors at least 72 px apart, the playhead while it is inside), labelled with the station; for each
 * pause between visits, a break mark.
 */
const ExecRuler = memo(function ExecRuler({ axis, y }: { axis: ExecAxis; y: number }) {
  const base = y + 12;
  let breaks = "";
  for (const s of axis.segments) {
    if (s.kind !== "gap") continue;
    const cx = s.x0 + s.w / 2;
    breaks += `M${cx - 3.5} ${base + 3}l3 -6M${cx + 0.5} ${base + 3}l3 -6`;
  }
  return (
    <g aria-hidden="true" className="bp-fine">
      {axis.segments.map((s, i) =>
        s.kind === "visit" ? (
          <g key={i}>
            <SegmentRuler x={s.x0 + 1} y={base} width={Math.max(1, s.w - 2)} from={s.start} to={s.end} />
            {s.w > 44 ? (
              <text x={s.x0 + 2} y={base - 4} style={{ fill: s.open ? fc("live") : "var(--mach-ink-muted)", fontSize: 8.5, fontWeight: 600 }}>
                {`${STATION_WORDS[s.station ?? ""] ?? s.station}${s.round && s.round > 1 ? ` · r${s.round}` : ""}`}
              </text>
            ) : null}
          </g>
        ) : null,
      )}
      <path d={breaks} style={{ stroke: fc("ink-soft"), strokeWidth: 0.9 }} />
    </g>
  );
});

/** One visit's stretch of the ruler; the playhead is drawn on it only while the playhead is inside. */
function SegmentRuler({ x, y, width, from, to }: { x: number; y: number; width: number; from: number; to: number }) {
  const playhead = useSceneStore((s) => (s.playhead >= from && s.playhead <= to ? Math.floor(s.playhead / 1000) * 1000 : undefined));
  return <TimeRuler x={x} y={y} width={width} from={from} to={to} playhead={playhead} side="bottom" format="mm:ss" />;
}

/** A span that is still open, drawn to the playhead (its own component: it moves). */
function LiveSpan({ axis, start, y, color, weight }: { axis: ExecAxis; start: number; y: number; color: string; weight: number }) {
  const x1 = useSceneStore((s) => Math.round(xOn(axis, Math.min(s.playhead, axis.end)) * 2) / 2);
  const x0 = xOn(axis, start);
  return <line x1={x0} y1={y} x2={Math.max(x0 + 1, x1)} y2={y} aria-hidden="true" style={{ stroke: color, strokeWidth: weight, strokeLinecap: "round" }} />;
}

/* ------------------------------------------------------------------------------------------------ */
/* Visit (and the belt relay)                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function spanOf(node: TreeNode): { start: number; end: number | null; agents: readonly AgentState[] } | null {
  if (node.data.kind === "visit") return { start: node.data.visit.enteredAt, end: node.data.visit.leftAt, agents: node.data.agents };
  if (node.data.kind === "relay") return { start: node.data.execution.startedAt ?? node.data.execution.claimedAt, end: node.data.execution.endedAt, agents: node.data.agents };
  return null;
}

const SpanItem = memo(function SpanItem({ row, pos, size, laneY, ax, width, axis, children }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; axis: ExecAxis; children: ReactNode }) {
  const node = row.node;
  const span = spanOf(node);
  const selected = useSelected(node.ref);
  if (!span) return null;
  const y = row.y - laneY;
  const gx = GX + INDENT[1]!;
  const visit: StationVisit | null = node.data.kind === "visit" ? node.data.visit : null;
  const title = visit ? (visit.action === "revise" ? "Build (revise)" : (STATION_WORDS[visit.station] ?? visit.station)) : "Belt relay";
  const round = visit ? (visit.action === "revise" ? visit.round + 1 : visit.round) : null;
  const open = span.end === null;
  const state: FactoryState = visit ? (open ? (visit.station === "human-approval" ? "human" : "active") : visit.outcome === "failed" || visit.outcome === "rejected" ? "failed" : "succeeded") : open ? "active" : "succeeded";
  const h = row.h;
  const calls = span.agents.reduce((n, a) => n + a.toolCalls.length, 0);
  return (
    <Item node={node} pos={pos} size={size} expanded={row.expanded} ring={{ x: ax - 12, y: y + 2, w: width - ax - SHEET.left + 10, h: h - 4 }} group={children}>
      <Rule x={ax - 14} w={width - ax - SHEET.left + 14} y={y} weight={0.5} color={fc("grid-major")} />
      {visit ? <VisitSpan axis={axis} start={span.start} end={span.end} y={y + 14} state={state} /> : null}
      <AgentGlance axis={axis} agents={span.agents} y={y + 6} />
      <Gutter row id={node.id} entity={node.ref} y={row.y} h={h} ax={ax}>
        <Rule x={GX + 28} w={SHEET.gutter - 42} y={0} weight={0.5} color={fc("grid-major")} />
        {selected ? <SelectBar x={GX + 26} y={1} h={h - 2} /> : null}
        <GutterRing id={node.id} x={GX + 26} h={h} />
        {row.expandable ? <ToggleTarget x={gx} y={15} /> : null}
        {row.expandable ? <Chevron x={gx} y={15} open={row.expanded} /> : null}
        <g transform={`translate(${gx + 16} 15)`}>
          {visit ? <StationSymbol kind={stationKind(visit.station)} size={13} color={fc(state === "active" ? "live" : "ink")} strokeWidth={1.3} /> : <circle r={4.5} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.1, strokeDasharray: "2 1.6" }} />}
        </g>
        <text x={gx + 28} y={14} className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
          {title}
          {round !== null ? <tspan style={{ fill: round > 1 ? fc("fail") : "var(--mach-ink-muted)", fontWeight: 400 }}> · round {round}</tspan> : null}
        </text>
        <text x={gx + 28} y={25} className="bp-fine tabular" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }}>
          {clock(span.start)}–{span.end !== null ? clock(span.end) : "now"} · {span.agents.length} agent{span.agents.length === 1 ? "" : "s"} · {calls} calls
        </text>
      </Gutter>
    </Item>
  );
});

/** The visit's own span on the execution's axis: a bar in its state ink, open to the playhead while it runs. */
function VisitSpan({ axis, start, end, y, state }: { axis: ExecAxis; start: number; end: number | null; y: number; state: FactoryState }) {
  const color = fc(state === "active" ? "live" : state === "failed" ? "fail" : state === "human" ? "human" : "ink-soft");
  if (end === null) return <LiveSpan axis={axis} start={start} y={y + 10} color={color} weight={3} />;
  return <line x1={xOn(axis, start)} y1={y + 10} x2={Math.max(xOn(axis, start) + 1, xOn(axis, end))} y2={y + 10} aria-hidden="true" style={{ stroke: color, strokeWidth: 3, strokeLinecap: "butt", opacity: 0.55 }} />;
}

const AgentGlance = memo(function AgentGlance({ axis, agents, y }: { axis: ExecAxis; agents: readonly AgentState[]; y: number }) {
  const shown = agents.slice(0, 5);
  return (
    <g aria-hidden="true">
      {shown.map((a, i) =>
        a.finishedAt === null ? (
          <LiveSpan key={a.id} axis={axis} start={a.startedAt} y={y + 1 + i * 2.2} color={fc("live")} weight={1.2} />
        ) : (
          <line key={a.id} x1={xOn(axis, a.startedAt)} y1={y + 1 + i * 2.2} x2={Math.max(xOn(axis, a.startedAt) + 1, xOn(axis, a.finishedAt))} y2={y + 1 + i * 2.2} style={{ stroke: fc(a.status === "error" ? "fail" : "ink-soft"), strokeWidth: 1.2, strokeLinecap: "round" }} />
        ),
      )}
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* Gate row                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const GateItem = memo(function GateItem({ row, pos, size, laneY, ax, width, axis }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; axis: ExecAxis }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  if (node.data.kind !== "gate") return null;
  const g: GateState = node.data.gate;
  const y = row.y - laneY;
  const gx = GX + INDENT[1]! + 16;
  const st = gateState(g);
  const ink = fc(st === "idle" ? "ink-soft" : st === "active" ? "live" : st === "succeeded" ? "pass" : st === "failed" ? "fail" : "human");
  const soft = st === "idle" ? fc("plate-top") : fc(st === "active" ? "live-soft" : st === "succeeded" ? "pass-soft" : st === "failed" ? "fail-soft" : "human-soft");
  const mx = xOn(axis, g.decidedAt ?? g.openedAt);
  const left = mx > ax + (width - ax) * 0.55;
  const detail = g.detail.length > 120 ? `${g.detail.slice(0, 119)}…` : g.detail;
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: ax - 12, y: y + 1, w: width - ax - SHEET.left + 10, h: row.h - 2 }}>
      {/* The gate on the execution's axis, at its decision, with what it decided beside it. */}
      <path d={`M${mx} ${y + 6}l6 6l-6 6l-6 -6z`} aria-hidden="true" style={{ fill: soft, stroke: ink, strokeWidth: 1.1 }} />
      <text x={left ? mx - 10 : mx + 10} y={y + 15.5} textAnchor={left ? "end" : "start"} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
        <tspan style={{ fill: ink, fontWeight: 600 }}>{g.state}</tspan>
        <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> {clock(g.openedAt)}{g.decidedAt !== null && g.decidedAt !== g.openedAt ? ` → ${clock(g.decidedAt)}` : ""}</tspan>
        <tspan> · {detail}</tspan>
      </text>
      <Gutter row id={node.id} entity={node.ref} y={row.y} h={row.h} ax={ax}>
        {selected ? <SelectBar x={GX + 26} y={1} h={row.h - 2} /> : null}
        <GutterRing id={node.id} x={GX + 26} h={row.h} />
        <path d={`M${gx} 6l6 6l-6 6l-6 -6z`} style={{ fill: soft, stroke: ink, strokeWidth: 1.1 }} />
        <text x={gx + 12} y={15.5} className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
          {GATE_WORDS[g.gate]}
          {g.round ? <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> #{g.round}</tspan> : null}
        </text>
      </Gutter>
    </Item>
  );
}, sameRowProps);

/* ------------------------------------------------------------------------------------------------ */
/* Agent lane                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

const WINDOW = 12;

const AgentItem = memo(function AgentItem({ row, pos, size, laneY, ax, width, axis }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; axis: ExecAxis }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  const ctx = useTreeCtx();
  // At the overview a trace's caps are sub-pixel: an open lane draws as its single path there.
  const overview = useContext(LodContext) === "overview";
  if (node.data.kind !== "agent") return null;
  const a = node.data.agent;
  const y = row.y - laneY;
  const gx = GX + INDENT[2]!;
  const st = agentState(a);
  const words = agentWords(a);
  const h = row.h;
  const base = row.expanded ? y + 44 : y + 18;
  // Leaves are tree items only near the keyboard's position: a window around the active leaf.
  const leaves = row.expanded ? node.children : [];
  const activeIdx = ctx.activeId ? leaves.findIndex((l) => l.id === ctx.activeId) : -1;
  const windowed = activeIdx >= 0 ? leaves.slice(Math.max(0, activeIdx - WINDOW), activeIdx + WINDOW + 1) : [];
  const toolTids = a.toolCalls.map((c) => `t:${c.id}`);
  return (
    <Item
      node={node}
      pos={pos}
      size={size}
      expanded={row.expanded}
      ring={{ x: ax - 12, y: y + 1, w: width - ax - SHEET.left + 10, h: h - 2 }}
      group={windowed.length ? windowed.map((leafNode) => <Leaf key={leafNode.id} node={leafNode} pos={leaves.indexOf(leafNode) + 1} size={leaves.length} axis={axis} base={base} />) : undefined}
    >
      <Rule x={ax - 14} w={width - ax - SHEET.left + 14} y={y} weight={0.4} color={fc("grid")} />
      {a.finishedAt === null ? (
        <LiveSpan axis={axis} start={a.startedAt} y={base + 1} color={fc("live")} weight={row.expanded ? 1 : 2} />
      ) : (
        <line x1={xOn(axis, a.startedAt)} y1={base + 1} x2={Math.max(xOn(axis, a.startedAt) + 1, xOn(axis, a.finishedAt))} y2={base + 1} aria-hidden="true" style={{ stroke: fc(a.status === "error" ? "fail" : "ink-soft"), strokeWidth: row.expanded ? 1 : 2, strokeLinecap: "round" }} />
      )}
      <ToolTrace agent={a} tids={toolTids} axis={axis} base={base} open={row.expanded && !overview} laneKey={a.id} />
      {row.expanded && !overview ? <AgentDetail node={node} agent={a} axis={axis} base={base} y={y} /> : null}
      {/* The hit layer: one rectangle; the view finds the call under the pointer from the registry. */}
      <rect x={ax} y={y + 2} width={width - ax - SHEET.left} height={h - 4} data-ticks={a.id} style={{ fill: "transparent" }} />
      <Gutter row id={node.id} entity={node.ref} y={row.y} h={h} ax={ax}>
        <Rule x={GX + 42} w={SHEET.gutter - 56} y={0} weight={0.4} color={fc("grid")} />
        {selected ? <SelectBar x={GX + 40} y={1} h={h - 2} /> : null}
        <GutterRing id={node.id} x={GX + 40} h={h} />
        {row.expandable ? <ToggleTarget x={gx} y={14} /> : null}
        {row.expandable ? <Chevron x={gx} y={14} open={row.expanded} /> : null}
        <g transform={`translate(${gx + 16} 14)`}>
          <AgentHead tier={tierOf(a.model)} fill={st === "active" ? fc("live") : fc("plate-top")} stroke={fc(st === "active" ? "live" : st === "failed" ? "fail" : "ink")} />
        </g>
        {a.seat && grammarSeat(a.seat) ? (
          <text x={gx + 16} y={5} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontSize: 7.5, fontWeight: 700 }}>
            {a.seat[0]!.toUpperCase()}
          </text>
        ) : null}
        <text x={gx + 28} y={13} className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
          {words}
          <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> · {modelWord(a.model)}</tspan>
        </text>
        <text x={gx + 28} y={24} className="bp-fine tabular" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8 }}>
          {a.agentType ?? a.role} · {a.toolCalls.length} calls{a.finishedAt !== null ? ` · ${duration(a.finishedAt - a.startedAt)}` : ""}
        </text>
      </Gutter>
    </Item>
  );
}, sameRowProps);

/** An open agent's artifacts (with the task a commit closed), findings and its dimensioned span. */
const AgentDetail = memo(function AgentDetail({ node, agent, axis, base, y }: { node: TreeNode; agent: AgentState; axis: ExecAxis; base: number; y: number }) {
  return (
    <g aria-hidden="true">
      {node.children.map((leafNode) => {
        if (leafNode.data.kind === "artifact") {
          const art = leafNode.data.artifact;
          return <ArtifactMark key={leafNode.id} x={xOn(axis, art.writtenAt)} y={base - 27} kind={art.kind} at={art.writtenAt} file={artifactFile(art)} task={art.kind === "commit" ? (/\b(R\d-)?T\d\d\b/.exec(art.label)?.[0] ?? null) : null} />;
        }
        if (leafNode.data.kind === "finding") return <FindingMark key={leafNode.id} finding={leafNode.data.finding} x={xOn(axis, leafNode.data.finding.at)} base={base} />;
        return null;
      })}
      {agent.finishedAt !== null ? <DimensionLine x1={xOn(axis, agent.startedAt)} x2={Math.max(xOn(axis, agent.startedAt) + 2, xOn(axis, agent.finishedAt))} y={y + 70} label={duration(agent.finishedAt - agent.startedAt)} extend={4} /> : null}
    </g>
  );
});

function ArtifactMark({ x, y, kind, at, file, task }: { x: number; y: number; kind: Parameters<typeof grammarArtifact>[0]; at: number; file: string; task: string | null }) {
  const p = useEventProgress(at, "artifactMaterialise");
  const failed = kind === "verification-findings";
  return (
    <g>
      <ArtifactCard variant="blueprint" kind={grammarArtifact(kind)} state={failed ? "failed" : "succeeded"} progress={Math.max(0.001, p)} at={{ x, y }} showLabel={false} />
      {task ? (
        <text x={x + 9} y={y - 4} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 7.5, opacity: p }}>
          {task}
        </text>
      ) : null}
      <title>{file}</title>
    </g>
  );
}

function FindingMark({ finding, x, base }: { finding: FindingState; x: number; base: number }) {
  return finding.severity === "blocker" ? (
    <path d={`M${x} ${base + 10}l5 5l-5 5l-5 -5z`} style={{ fill: finding.outvoted ? fc("plate-top") : fc("fail"), stroke: fc("fail"), strokeWidth: 1.1 }} />
  ) : (
    <circle cx={x} cy={base + 15} r={3} style={{ fill: "none", stroke: fc("wait"), strokeWidth: 1.1 }} />
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Leaves: focus targets only (the drawing is the trace above)                                       */
/* ------------------------------------------------------------------------------------------------ */

const Leaf = memo(function Leaf({ node, pos, size, axis, base }: { node: TreeNode; pos: number; size: number; axis: ExecAxis; base: number }) {
  const t = node.data.kind === "tool" ? node.data.call.startedAt : node.data.kind === "artifact" ? node.data.artifact.writtenAt : node.data.kind === "finding" ? node.data.finding.at : 0;
  const x = xOn(axis, t);
  const ring = node.data.kind === "tool" ? { x: x - 5, y: base - 16, w: 10, h: 18, r: 2 } : node.data.kind === "artifact" ? { x: x - 9, y: base - 38, w: 18, h: 22, r: 2 } : { x: x - 6, y: base + 9, w: 12, h: 12, r: 2 };
  return <Item node={node} pos={pos} size={size} ring={ring} />;
});

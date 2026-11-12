/**
 * A slice's lane on the sheet: the gutter (title, IDs, stage, the scheduler's decisions and the
 * dependencies it waits on), the cell's workflow drawing when open, a one-line process strip when
 * closed, and the execution rows below. Waiting slices that have no cell yet show the belt they
 * will run, unbuilt, and why they wait.
 */
import { memo } from "react";
import { ArtifactCard, DependencyLink, fc, StateMark, type FactoryState } from "@mach/ui";
import type { EntityRef, Scene } from "../sim";
import { refKind } from "../sim";
import { useSceneStore } from "../scene";
import { CellFlow } from "./CellFlow";
import { COLUMN_ORDER, type ColumnTemplate } from "./columns";
import type { FlowNode } from "./flow";
import { SHEET, type Lane, type Layout, type Row } from "./layout";
import { useEventProgress } from "./motion";
import { ExecutionRows } from "./rows";
import { clock } from "./time";
import type { TreeNode } from "./tree";
import { Chevron, Item, SelectBar, ToggleTarget, useSelected } from "./treeitem";
import { artifactFile, gateState, grammarArtifact, stageState, stageWords } from "./vocab";

/** Whether a lane is outside the highlighted dependency chain (only slice-level subjects dim the sheet). */
function useDimmed(entities: readonly EntityRef[]): boolean {
  return useSceneStore((s) => {
    const subject = s.hovered ?? s.selection;
    if (!subject || !s.highlighted.length) return false;
    const k = refKind(subject);
    if (k !== "cell" && k !== "slice" && k !== "dependency") return false;
    return !entities.some((e) => s.highlighted.includes(e));
  });
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface LaneProps {
  lane: Lane;
  pos: number;
  size: number;
  rows: readonly Row[];
  layout: Pick<Layout, "ax" | "aw" | "width">;
  template: ColumnTemplate;
  animate: boolean;
}

export const LaneView = memo(function LaneView({ lane, pos, size, rows, layout, template, animate }: LaneProps) {
  const { node, slice, cell, flow } = lane;
  const selected = useSelected(node.ref);
  const dimmed = useDimmed(cell ? [`cell:${cell.ticketId}`, `slice:${slice.id}`] : [`slice:${slice.id}`]);
  const { ax, aw, width } = layout;
  const x = SHEET.left;
  const w = width - SHEET.left * 2;
  const h = lane.h;
  const state: FactoryState = cell ? stageState(cell.stage) : slice.scheduler === "waiting-on-dependency" ? "waiting" : "idle";
  const mark = cell?.stage === "merged" ? "double-ring" : undefined;
  const execRows = rows.filter((r) => r.depth === 0);
  const deps = node.children.filter((c) => c.kind === "dependency");
  const scriptArtifacts = node.children.filter((c) => c.kind === "artifact");
  const gx = x + 22;
  const at = (child: TreeNode): number => node.children.indexOf(child) + 1;
  const kids = node.children.length;
  const row0 = lane.row0 - lane.y;
  const history = slice.history;
  const eligible = history.find((hh) => hh.state === "eligible");
  const dispatched = history.find((hh) => hh.state === "dispatched");
  const waited = history.find((hh) => hh.state === "waiting-on-dependency");
  const schedLine = [waited ? `waited from ${clock(waited.at)}` : null, eligible ? `eligible ${clock(eligible.at)}` : null, dispatched ? `dispatched ${clock(dispatched.at)}` : null].filter(Boolean).join(" · ");
  const group = (
    <>
      {lane.expanded
        ? deps.map((d, i) => <DependencyItem key={d.id} node={d} pos={at(d)} size={kids} x={gx + 27} y={(cell ? 80 : 64) + i * 13} w={SHEET.gutter - 52} />)
        : null}
      {lane.expanded && cell && flow ? scriptArtifacts.map((a, i) => <ScriptArtifact key={a.id} node={a} pos={at(a)} size={kids} x={ax + flow.start.x - 30 + i * 17} y={row0 - 34} />) : null}
      {lane.expanded && cell && flow
        ? execRows.map((r) => <ExecutionRows key={r.id} exec={r} pos={at(r.node)} size={kids} rows={rows} laneY={lane.y} ax={ax} aw={aw} width={width} flow={flow} cell={cell} />)
        : null}
    </>
  );
  return (
    <g style={{ transform: `translate(0px, ${lane.y}px)`, transition: animate ? "transform 400ms cubic-bezier(0.2, 0, 0, 1)" : "none", opacity: dimmed ? 0.28 : 1 }}>
      <Item node={node} pos={pos} size={size} expanded={lane.expanded} ring={{ x: x + 2, y: 2, w: SHEET.gutter - 8, h: lane.expanded ? Math.min(h - 4, 96) : h - 4 }} group={group}>
        <rect x={x} y={0} width={w} height={h} aria-hidden="true" style={{ fill: fc("floor"), opacity: cell ? 0.55 : 0.3 }} />
        <line x1={x + 12} y1={0} x2={x + w} y2={0} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
        <path d={`M${x + 9} ${6}h-3v${h - 12}h3`} aria-hidden="true" style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 1 }} />
        {selected ? <SelectBar x={x + 4} y={1} h={h - 2} /> : null}
        <ToggleTarget x={gx} y={19} />
        <Chevron x={gx} y={19} open={lane.expanded} />
        <g transform={`translate(${gx + 15} 18)`} aria-hidden="true">
          <StateMark state={state} r={5.5} mark={mark} progress={0} />
        </g>
        <text x={gx + 27} y={22} style={{ fill: "var(--mach-ink)", fontSize: 12.5, fontWeight: 600 }}>
          {clip(slice.title, 34)}
          <title>{slice.title}</title>
        </text>
        <text x={gx + 27} y={36} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="notranslate">
          {cell ? `${cell.ticketId} · ` : ""}
          {slice.id}
          <tspan style={{ fontFamily: "var(--mach-font-sans)", fill: slice.risk === "High" ? fc("human") : "var(--mach-ink-muted)", fontWeight: slice.risk === "High" ? 600 : 400 }}> · {slice.risk} risk</tspan>
        </text>
        {cell && lane.expanded ? (
          <>
            <text x={gx + 27} y={52} style={{ fill: "var(--mach-ink)", fontSize: 10 }}>
              {stageWords(cell.stage)}
              <tspan style={{ fill: cell.round > 1 ? fc("fail") : "var(--mach-ink-muted)" }}> · round {cell.round} of 3</tspan>
            </text>
            <text x={gx + 27} y={66} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }} className="tabular">
              {schedLine}
            </text>
          </>
        ) : null}
        {cell && !lane.expanded ? <CollapsedSummary scene={null} ticket={cell.ticketId} x={gx + 27} y={50} lane={lane} /> : null}
        {!cell ? (
          <text x={gx + 27} y={50} style={{ fill: fc("wait"), fontSize: 9.5 }} className="tabular">
            {slice.scheduler === "waiting-on-dependency" ? `Waiting on a dependency since ${clock(waited?.at ?? slice.since)}` : slice.scheduler}
          </text>
        ) : null}
        {cell && flow && lane.expanded ? <CellFlow cell={cell} slice={slice} flow={flow} template={template} ax={ax} row0={row0} dimsY={lane.dimsY - lane.y} laneH={h} /> : null}
        {cell && flow && !lane.expanded ? <Strip nodes={flow.nodes} ax={ax} y={29} /> : null}
        {!cell ? <WaitingStrip template={template} ax={ax} y={row0} reason={slice.reasons[0] ?? ""} /> : null}
      </Item>
    </g>
  );
});

function CollapsedSummary({ ticket, x, y, lane }: { scene: Scene | null; ticket: string; x: number; y: number; lane: Lane }) {
  const cell = lane.cell!;
  const agents = cell.agentOrder.length;
  const calls = cell.agentOrder.reduce((n, id) => n + (cell.agents[id]?.toolCalls.length ?? 0), 0);
  const visits = cell.visits.length;
  void ticket;
  return (
    <text x={x} y={y} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }} className="tabular">
      {stageWords(cell.stage)} · {visits} visits · {agents} agents · {calls} calls · {cell.artifacts.length} artifacts
    </text>
  );
}

/** A closed cell's workflow on one line: a state mark at each column it has run, unbuilt rings for the rest. */
const Strip = memo(function Strip({ nodes, ax, y }: { nodes: readonly FlowNode[]; ax: number; y: number }) {
  const latest = new Map<string, FlowNode>();
  for (const n of nodes) latest.set(n.col, n);
  const list = [...latest.values()].sort((a, b) => a.x - b.x);
  return (
    <g aria-hidden="true">
      <line x1={ax + (list[0]?.x ?? 0)} y1={y} x2={ax + (list[list.length - 1]?.x ?? 0)} y2={y} style={{ stroke: fc("route"), strokeWidth: 0.75 }} />
      {list.map((n) => {
        const st: FactoryState | null = n.kind === "future" ? null : n.kind === "start" ? "succeeded" : n.gate ? gateState(n.gate) : n.visit ? (n.visit.leftAt === null ? (n.visit.station === "human-approval" ? "human" : "active") : n.visit.outcome === "failed" ? "failed" : "succeeded") : n.kind === "end" && !n.key.startsWith("f:") ? "succeeded" : null;
        return (
          <g key={n.col} transform={`translate(${ax + n.x} ${y})`}>
            {st ? <StateMark state={st} r={4.2} progress={0} mark={n.kind === "end" ? "double-ring" : undefined} /> : <circle r={3.6} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 0.9, strokeDasharray: "2 1.8", opacity: 0.7 }} />}
            {n.round > 1 && n.kind !== "future" ? (
              <text x={-6} y={-6} textAnchor="end" style={{ fill: fc("fail"), fontSize: 8, fontWeight: 700 }}>
                ×{n.round}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
});

/** A slice with no cell yet: the belt it will run, all unbuilt, held at the start. */
const WaitingStrip = memo(function WaitingStrip({ template, ax, y, reason }: { template: ColumnTemplate; ax: number; y: number; reason: string }) {
  const cols = COLUMN_ORDER.filter((c) => template.x[c] !== undefined);
  const x0 = ax + (template.x.start ?? 0);
  return (
    <g aria-hidden="true">
      <line x1={x0} y1={y} x2={ax + (template.x.end ?? 0)} y2={y} style={{ stroke: fc("route"), strokeWidth: 0.75, strokeDasharray: "3 3", opacity: 0.5 }} />
      {cols.map((c) =>
        c === "start" ? null : <circle key={c} cx={ax + (template.x[c] ?? 0)} cy={y} r={3.6} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 0.9, strokeDasharray: "2 1.8", opacity: 0.55 }} />,
      )}
      <g transform={`translate(${x0} ${y})`}>
        <StateMark state="waiting" r={6} />
      </g>
      <text x={x0 + 14} y={y - 8} style={{ fill: fc("wait"), fontSize: 9.5 }}>
        {clip(reason, 90)}
      </text>
    </g>
  );
});

function DependencyItem({ node, pos, size, x, y, w }: { node: TreeNode; pos: number; size: number; x: number; y: number; w: number }) {
  if (node.data.kind !== "dependency") return null;
  const dep = node.data.dep;
  const ok = dep.state === "satisfied";
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: x - 4, y: y - 9, w, h: 12, r: 2 }}>
      <g transform={`translate(${x} ${y - 3})`} aria-hidden="true">
        <rect x={-3.5} y={-1} width={7} height={5.5} rx={1} style={{ fill: ok ? fc("pass") : fc("wait") }} />
        <path d={ok ? "M-2 -1v-2.2a2 2 0 0 1 4 0" : "M-2 -1v-2a2 2 0 0 1 4 0v2"} style={{ fill: "none", stroke: ok ? fc("pass") : fc("wait"), strokeWidth: 1.1 }} />
      </g>
      <text x={x + 8} y={y} style={{ fill: ok ? fc("pass") : fc("wait"), fontSize: 9.5 }}>
        {ok ? `${dep.to} integrated · unlocked ${clock(dep.satisfiedAt ?? 0)}` : `waits for ${dep.to} to be integrated`}
      </text>
    </Item>
  );
}

function ScriptArtifact({ node, pos, size, x, y }: { node: TreeNode; pos: number; size: number; x: number; y: number }) {
  const at = node.data.kind === "artifact" ? node.data.artifact.writtenAt : 0;
  const p = useEventProgress(at, "artifactMaterialise");
  if (node.data.kind !== "artifact") return null;
  const a = node.data.artifact;
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: x - 9, y: y - 11, w: 18, h: 22, r: 2 }}>
      <ArtifactCard variant="blueprint" kind={grammarArtifact(a.kind)} progress={Math.max(0.001, p)} at={{ x, y }} showLabel={false} />
      <title>{`${artifactFile(a)} · ${a.writer.script ?? ""} · ${clock(a.writtenAt)}`}</title>
    </Item>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Dependencies across lanes                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Dependencies run in their own channel at the right edge of the drawing, past the "Integrated"
 * column: each leaves the prerequisite's integrated mark, drops through the channel in its own track,
 * and arrives at the dependent lane, so no cable crosses another lane's drawing. Blocking: dashed in
 * the wait ink, padlock shut. Satisfied: the unlock draws solid over it and the shackle opens.
 */
export const DependencyLayer = memo(function DependencyLayer({ scene, lanes, ax, aw, template }: { scene: Scene; lanes: readonly Lane[]; ax: number; aw: number; template: ColumnTemplate }) {
  const bySlice = new Map(lanes.map((l) => [l.slice.id, l]));
  const deps = Object.values(scene.dependencies).sort((a, b) => (a.to + a.from).localeCompare(b.to + b.from));
  const x0 = ax + aw + 26;
  const endX = ax + (template.x.end ?? aw) + 13;
  const anchorY = (l: Lane): number => l.row0;
  return (
    <g>
      <text x={x0 - 6} y={(lanes[0]?.y ?? 0) - 20} style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em" }} aria-hidden="true">
        DEPENDENCIES
      </text>
      {deps.map((dep, i) => {
        const from = bySlice.get(dep.to);
        const to = bySlice.get(dep.from);
        if (!from || !to) return null;
        const x = x0 + i * 16;
        return <Dependency key={dep.id} id={dep.id} stubFrom={endX} x={x} fromY={anchorY(from)} toY={anchorY(to)} labelX={x0 + deps.length * 16 + 8} satisfiedAt={dep.satisfiedAt} state={dep.state} fromSlice={dep.to} toSlice={dep.from} />;
      })}
    </g>
  );
});

function Dependency({ id, stubFrom, x, fromY, toY, labelX, satisfiedAt, state, fromSlice, toSlice }: { id: string; stubFrom: number; x: number; fromY: number; toY: number; labelX: number; satisfiedAt: number | null; state: "blocking" | "satisfied"; fromSlice: string; toSlice: string }) {
  const p = useEventProgress(satisfiedAt, "dependencyUnlock");
  const entity = `dependency:${id}` as EntityRef;
  const highlighted = useSceneStore((s) => s.highlighted.includes(entity));
  const dimmed = useSceneStore((s) => s.highlighted.length > 0 && !s.highlighted.includes(entity) && (s.hovered ?? s.selection) !== null && ["cell", "slice", "dependency"].includes(refKind((s.hovered ?? s.selection) as EntityRef)));
  const done = state === "satisfied" && p >= 1;
  const ink = done ? fc("pass") : fc("wait");
  const midY = (fromY + toY) / 2;
  return (
    <g data-ref={entity} style={{ cursor: "pointer" }}>
      {/* Out of the prerequisite's integrated mark into the channel, and from the channel into the dependent lane. */}
      <path d={`M${stubFrom} ${fromY}H${x - 6}`} aria-hidden="true" style={{ fill: "none", stroke: ink, strokeWidth: highlighted ? 1.8 : 1.2, strokeDasharray: done ? undefined : "4 3", opacity: dimmed ? 0.28 : done ? 0.7 : 1 }} />
      <DependencyLink variant="blueprint" from={{ x: x - 6, y: fromY }} to={{ x: x + 6, y: toY - 4 }} state={state} progress={state === "satisfied" ? p : 0} highlighted={highlighted} dimmed={dimmed} />
      {/* The inlet: where the cable meets the dependent lane, a short bar across the channel. */}
      <path d={`M${x} ${toY}h12`} aria-hidden="true" style={{ fill: "none", stroke: ink, strokeWidth: 2, strokeLinecap: "round", opacity: dimmed ? 0.28 : 1 }} />
      <text x={labelX} y={midY - 1} style={{ fill: ink, fontSize: 9.5, fontWeight: 600, opacity: dimmed ? 0.3 : 1 }} className="tabular">
        {toSlice.replace("SLICE-", "")} waits for {fromSlice.replace("SLICE-", "")}
        <tspan x={labelX} dy={12} style={{ fontWeight: 400, fontFamily: "var(--mach-font-mono)", fontSize: 9 }}>
          {state === "satisfied" && satisfiedAt !== null ? `unlocked ${clock(satisfiedAt)}` : "blocking"}
        </tspan>
      </text>
    </g>
  );
}

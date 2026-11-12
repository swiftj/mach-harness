/**
 * A slice's lane on the sheet: the gutter (title, IDs, stage, the scheduler's decisions and the
 * dependencies it waits on), the cell's workflow drawing when open, a one-line process strip when
 * closed, and the execution rows below. Waiting slices that have no cell yet show the belt they
 * will run, unbuilt, and why they wait.
 *
 * Live and replay: the section mark is the cell's activity (the nine states, "as last seen" while the
 * connection is stale, "not recorded" where nothing says), and a title, risk or app type the history
 * does not hold is said to be not recorded rather than drawn from a placeholder.
 */
import { memo, useContext } from "react";
import { ArtifactCard, DependencyLink, fc, StateMark, type FactoryState } from "@mach/ui";
import type { ActivityState, EntityRef, Scene } from "../sim";
import { activityOf, isKnown, refKind } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { activityWords, callCount } from "./facts";
import { ActivityMark } from "./marks";
import { CellFlow } from "./CellFlow";
import { COLUMN_ORDER, type ColumnTemplate } from "./columns";
import type { FlowNode } from "./flow";
import { SHEET, type Lane, type Layout, type Row } from "./layout";
import { useEventProgress, useLate, useStaleSince } from "./motion";
import { ExecutionRows } from "./rows";
import { clock } from "./time";
import type { TreeNode } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, useSelected, useTreeCtx } from "./treeitem";
import { Gutter } from "./gutter";
import { LaneDimContext, LodContext } from "./context";
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

/** Break a title into lines of at most `max` characters, at spaces. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The lane's story in a few words, for the overview lettering: what happened that matters. */
function storyOf(lane: Lane, activity: ActivityState | null): string[] {
  const { cell, slice } = lane;
  if (!cell) return [slice.scheduler === "waiting-on-dependency" ? `Waits for ${slice.dependsOn.map((d) => d.replace("SLICE-", "")).join(" and ")}` : slice.scheduler];
  const out = [`${stageWords(cell.stage)}${cell.round > 1 ? ` · round ${cell.round}` : ""}${activity === "stale" || activity === "unknown" || activity === "interrupted" ? ` · ${activityWords(activity)}` : ""}`];
  const human = [...cell.reviews].reverse().find((r) => r.humanApproval)?.humanApproval;
  const rejected = cell.reviews.find((r) => r.outcome === "REJECTED");
  const failedCheck = cell.verifications.find((v) => v.status === "FAIL_WITH_EVIDENCE")?.checks.find((c) => c.result === "fail");
  const outvoted = cell.reviews.flatMap((r) => r.findings).find((f) => f.outvoted);
  if (failedCheck) out.push(`${failedCheck.targetId} failed, back to build`);
  if (rejected) out.push(`Rejected: ${rejected.findings.find((f) => f.severity === "blocker")?.rule ?? "blocker"}`);
  if (outvoted) out.push(`Blocker ${outvoted.rule ?? ""} outvoted`);
  if (human) out.push(`Approved by ${human.by}`);
  else if (cell.stage === "awaiting-human") out.push("Waiting for a person");
  return out.slice(0, 3);
}

export interface LaneProps {
  lane: Lane;
  pos: number;
  size: number;
  rows: readonly Row[];
  layout: Pick<Layout, "ax" | "aw" | "width">;
  template: ColumnTemplate;
  animate: boolean;
}

/** The gutter's title width in characters at the drawing's 15 px bold sans. */
const TITLE_CHARS = 36;

export const LaneView = memo(function LaneView({ lane, pos, size, rows, layout, template, animate }: LaneProps) {
  const { node, slice, cell, flow } = lane;
  const selected = useSelected(node.ref);
  const ctx = useTreeCtx();
  const band = useContext(BandContext);
  const dimmed = useDimmed(cell ? [`cell:${cell.ticketId}`, `slice:${slice.id}`] : [`slice:${slice.id}`]);
  const staleSince = useStaleSince();
  const overviewLod = useContext(LodContext) === "overview";
  // The simulation's lanes keep the stage's mark (M6.0); a real history's lanes carry its activity state.
  const simulated = useScene((sc) => sc.provenance.source === "simulation");
  const activity = useScene((sc) => (simulated ? null : activityOf(sc, cell ? `cell:${cell.ticketId}` : `slice:${slice.id}`, { stale: staleSince !== null }).state));
  const { ax, aw, width } = layout;
  const x = SHEET.left;
  const w = width - SHEET.left * 2;
  const h = lane.h;
  const state: FactoryState = cell ? stageState(cell.stage) : slice.scheduler === "waiting-on-dependency" ? "waiting" : "idle";
  const mark = cell?.stage === "merged" ? "double-ring" : undefined;
  const titled = isKnown(slice.meta, "title");
  // The cell's risk once work is scheduled (the scheduler records it there), else the slice's.
  const riskKnown = cell ? isKnown(cell.meta, "risk") : isKnown(slice.meta, "risk");
  const risk = cell && riskKnown ? cell.risk : slice.risk;
  const execRows = rows.filter((r) => r.depth === 0);
  const deps = node.children.filter((c) => c.kind === "dependency");
  const scriptArtifacts = node.children.filter((c) => c.kind === "artifact");
  const gx = x + 20;
  const tx = gx + 36;
  const at = (child: TreeNode): number => node.children.indexOf(child) + 1;
  const kids = node.children.length;
  const row0 = lane.row0 - lane.y;
  const history = slice.history;
  const eligible = history.find((hh) => hh.state === "eligible");
  const dispatched = history.find((hh) => hh.state === "dispatched");
  const waited = history.find((hh) => hh.state === "waiting-on-dependency");
  const schedLine = [waited ? `waited from ${clock(waited.at)}` : null, eligible ? `eligible ${clock(eligible.at)}` : null, dispatched ? `dispatched ${clock(dispatched.at)}` : null].filter(Boolean).join(" · ");
  const lines = wrap(slice.title, TITLE_CHARS).slice(0, 2);
  const idY = 22 + lines.length * 17;
  const stageY = idY + 14;
  const schedY = stageY + 13;
  const depY = (cell ? schedY : stageY) + 13;
  const onScreen = lane.y + h >= band[0] && lane.y <= band[1];
  // Overview lettering: the title and the lane's story set large, for the establishing view.
  // The lane's header area: down to its first execution row (the rows' own gutters lie below).
  const headH = (lane.rows[0]?.y ?? lane.y + h) - lane.y;
  const overSize = Math.max(30, Math.min(44, headH / 6));
  // Characters per line at Source Sans 3 bold: about 0.5 em each (measured 0.48 on the fixture's titles).
  const overLines = wrap(slice.title, Math.floor((SHEET.gutter - 66) / (overSize * 0.5))).slice(0, headH > 200 ? 4 : 3);
  const story = storyOf(lane, activity);
  const group = (
    <LaneDimContext.Provider value={dimmed}>
      {lane.expanded ? deps.map((d) => <DependencyItem key={d.id} node={d} pos={at(d)} size={kids} />) : null}
      {lane.expanded && cell && flow ? scriptArtifacts.map((a, i) => <ScriptArtifact key={a.id} node={a} pos={at(a)} size={kids} x={ax + flow.start.x - 30 + i * 17} y={row0 - 34} />) : null}
      {lane.expanded && cell && flow
        ? execRows.map((r) => <ExecutionRows key={r.id} exec={r} pos={at(r.node)} size={kids} rows={rows} laneY={lane.y} ax={ax} aw={aw} width={width} flow={flow} cell={cell} />)
        : null}
    </LaneDimContext.Provider>
  );
  return (
    <g style={{ transform: `translate(0px, ${lane.y}px)`, transition: animate ? "transform 400ms cubic-bezier(0.2, 0, 0, 1)" : "none", opacity: dimmed ? 0.28 : 1 }}>
      <Item node={node} pos={pos} size={size} expanded={lane.expanded} ring={{ x: ax - 12, y: 2, w: width - ax - SHEET.left + 10, h: h - 4 }} group={group}>
        <rect x={x} y={0} width={w} height={h} aria-hidden="true" style={{ fill: fc("floor"), opacity: cell ? 0.55 : 0.3 }} />
        <line x1={x + 12} y1={0} x2={x + w} y2={0} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
        {cell && flow && lane.expanded && onScreen ? (
          <g className="bp-flow">
            <CellFlow cell={cell} slice={slice} flow={flow} template={template} ax={ax} row0={row0} dimsY={lane.dimsY - lane.y} laneH={h} />
          </g>
        ) : null}
        {cell && flow && !lane.expanded ? <Strip nodes={flow.nodes} ax={ax} y={29} /> : null}
        {!cell ? <WaitingStrip template={template} ax={ax} y={row0} reason={slice.reasons[0] ?? ""} /> : null}
      </Item>
      <Gutter id={node.id} entity={node.ref} y={lane.y} h={h} ax={ax} band={cell ? 0.55 : 0.3} dimmed={dimmed}>
        <line x1={x + 12} y1={0} x2={ax - 14} y2={0} style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
        <path d={`M${x + 9} 6h-3v${h - 12}h3`} style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 1 }} />
        {selected ? <SelectBar x={x + 4} y={1} h={h - 2} /> : null}
        {ctx.focusedId === node.id ? <rect x={x + 2} y={2} width={ax - x - 18} height={Math.min(h - 4, depY + deps.length * 13)} rx={4} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 }} /> : null}
        <ToggleTarget x={gx} y={19} />
        <Chevron x={gx} y={19} open={lane.expanded} />
        {/* The section mark: a drafted bubble with the slice's place in the wave, as on a sheet's section heading. */}
        <g transform={`translate(${gx + 20} 18)`}>
          <circle r={10} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 1 }} />
          <line x1={-10} y1={0} x2={10} y2={0} style={{ stroke: fc("ink-soft"), strokeWidth: 0.6 }} />
          <text y={-1.5} textAnchor="middle" className="bp-fine" style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 8.5, fontWeight: 700 }}>
            {pos}
          </text>
          <g transform="translate(0 5.5)">
            {activity ? <ActivityMark state={activity} r={3.2} mark={mark} /> : <StateMark state={state} r={3.2} mark={mark} progress={0} />}
          </g>
        </g>
        {/* Fine lettering is hidden at the overview: it is not drawn there at all (the element budget at Fit). */}
        {overviewLod ? null : (
        <g className="bp-fine">
          {lines.map((l, i) => (
            <text key={i} x={tx} y={22 + i * 17} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 15, fontWeight: 700 }}>
              {l}
            </text>
          ))}
          <text x={tx} y={idY} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="notranslate">
            {cell ? `${cell.ticketId} · ` : ""}
            {titled ? slice.id : null}
            {riskKnown ? (
              <tspan style={{ fontFamily: "var(--mach-font-sans)", fill: risk === "High" ? fc("human") : "var(--mach-ink-muted)", fontWeight: risk === "High" ? 600 : 400 }}>
                {titled ? " · " : ""}
                {risk} risk
              </tspan>
            ) : (
              <tspan style={{ fontFamily: "var(--mach-font-sans)", fill: "var(--mach-ink-subtle)" }}>{titled ? " · " : ""}risk not recorded</tspan>
            )}
            {titled ? null : <tspan style={{ fontFamily: "var(--mach-font-sans)", fill: "var(--mach-ink-subtle)" }}> · title not recorded</tspan>}
          </text>
          {cell && lane.expanded ? (
            <>
              <text x={tx} y={stageY} style={{ fill: "var(--mach-ink)", fontSize: 10 }}>
                {stageWords(cell.stage)}
                <tspan style={{ fill: cell.round > 1 ? fc("fail") : "var(--mach-ink-muted)" }}> · round {cell.round} of 3</tspan>
                {activity ? <tspan style={{ fill: activity === "interrupted" || activity === "failed" ? fc("fail") : "var(--mach-ink-muted)" }}> · {activity === "stale" ? `as last seen at ${clock(staleSince ?? 0)}` : activityWords(activity)}</tspan> : null}
              </text>
              <text x={tx} y={schedY} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }} className="tabular">
                {schedLine}
              </text>
            </>
          ) : null}
          {cell && !lane.expanded ? <CollapsedSummary scene={null} ticket={cell.ticketId} x={tx} y={stageY} lane={lane} activity={activity} /> : null}
          {!cell ? (
            <text x={tx} y={stageY} style={{ fill: fc("wait"), fontSize: 9.5 }} className="tabular">
              {slice.scheduler === "waiting-on-dependency" ? `Waiting on a dependency since ${clock(waited?.at ?? slice.since)}` : slice.scheduler}
            </text>
          ) : null}
          {lane.expanded ? deps.map((d, i) => <DependencyLine key={d.id} node={d} x={tx} y={depY + i * 13} />) : null}
        </g>
        )}
        <g className="bp-over">
          {overLines.map((l, i) => (
            <text key={i} x={tx} y={overSize + 4 + i * overSize * 1.12} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: overSize, fontWeight: 700 }}>
              {l}
            </text>
          ))}
          {(() => {
            // Story lines: at least 29 sheet px (11 px on screen at fit), wrapped to the gutter's width,
            // and set only where they fit above the lane's first execution row.
            const size = Math.max(29, overSize * 0.68);
            const lines = story.flatMap((line, k) => wrap(line, Math.floor((SHEET.gutter - 66) / (size * 0.47))).map((l) => ({ l, k })));
            const first = overSize + 4 + (overLines.length - 1) * overSize * 1.12 + size * 1.4;
            return lines.map(({ l, k }, i) => {
              const at = first + i * size * 1.18;
              if (at + 4 > headH) return null;
              const tone = /failed|Rejected|outvoted/.test(story[k] ?? "") ? fc("fail") : /person|Approved/.test(story[k] ?? "") ? fc("human") : k === 0 ? "var(--mach-ink-muted)" : fc("wait");
              return (
                <text key={i} x={tx} y={at} style={{ fill: tone, fontSize: size, fontWeight: 600 }}>
                  {l}
                </text>
              );
            });
          })()}
        </g>
      </Gutter>
    </g>
  );
});

function CollapsedSummary({ ticket, x, y, lane, activity }: { scene: Scene | null; ticket: string; x: number; y: number; lane: Lane; activity: ActivityState | null }) {
  const cell = lane.cell!;
  const agents = cell.agentOrder.length;
  const calls = cell.agentOrder.reduce((n, id) => {
    const a = cell.agents[id];
    return n + (a ? (callCount(a) ?? 0) : 0);
  }, 0);
  const visits = cell.visits.length;
  void ticket;
  return (
    <text x={x} y={y} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }} className="tabular">
      {stageWords(cell.stage)}
      {activity ? ` · ${activityWords(activity)}` : ""} · {visits} visits · {agents} agents · {calls} calls · {cell.artifacts.length} artifacts
    </text>
  );
}

/** A closed cell's workflow on one line: a state mark at each column it has run, unbuilt rings for the rest. */
const Strip = memo(function Strip({ nodes, ax, y }: { nodes: readonly FlowNode[]; ax: number; y: number }) {
  // At the overview the strip's marks are set large enough to read (same marks, same meaning).
  const big = useContext(LodContext) === "overview";
  const stale = useStaleSince() !== null;
  const r = big ? 13 : 4.2;
  const latest = new Map<string, FlowNode>();
  for (const n of nodes) latest.set(n.col, n);
  const list = [...latest.values()].sort((a, b) => a.x - b.x);
  return (
    <g aria-hidden="true">
      <line x1={ax + (list[0]?.x ?? 0)} y1={y} x2={ax + (list[list.length - 1]?.x ?? 0)} y2={y} style={{ stroke: fc("route"), strokeWidth: big ? 2.4 : 0.75 }} />
      {list.map((n) => {
        const drawn: FactoryState | null = n.kind === "future" ? null : n.kind === "start" ? "succeeded" : n.gate ? gateState(n.gate) : n.visit ? (n.visit.leftAt === null ? (n.visit.station === "human-approval" ? "human" : "active") : n.visit.outcome === "failed" ? "failed" : "succeeded") : n.kind === "end" && !n.key.startsWith("f:") ? "succeeded" : null;
        // Nothing is drawn as working while the connection is stale: the mark is held, as last seen.
        const st = stale && drawn === "active" ? "stale" : drawn;
        return (
          <g key={n.col} transform={`translate(${ax + n.x} ${y})`}>
            {st === "stale" ? <ActivityMark state="stale" r={r} /> : st ? <StateMark state={st} r={r} progress={0} mark={n.kind === "end" ? "double-ring" : undefined} /> : <circle r={r * 0.86} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: big ? 2 : 0.9, strokeDasharray: big ? "5 4" : "2 1.8" }} />}
            {n.round > 1 && n.kind !== "future" && !big ? (
              <text x={-6} y={-6} textAnchor="end" className="bp-fine" style={{ fill: fc("fail"), fontSize: 8, fontWeight: 700 }}>
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
  const big = useContext(LodContext) === "overview";
  const cols = COLUMN_ORDER.filter((c) => template.x[c] !== undefined);
  const x0 = ax + (template.x.start ?? 0);
  return (
    <g aria-hidden="true">
      <line x1={x0} y1={y} x2={ax + (template.x.end ?? 0)} y2={y} style={{ stroke: fc("route"), strokeWidth: big ? 2.4 : 0.75, strokeDasharray: big ? "8 7" : "3 3" }} />
      {cols.map((c) =>
        c === "start" ? null : <circle key={c} cx={ax + (template.x[c] ?? 0)} cy={y} r={big ? 11 : 3.6} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: big ? 2 : 0.9, strokeDasharray: big ? "5 4" : "2 1.8" }} />,
      )}
      <g transform={`translate(${x0} ${y})`}>
        <StateMark state="waiting" r={big ? 16 : 6} />
      </g>
      <text x={x0 + 14} y={y - 8} className="bp-fine" style={{ fill: fc("wait"), fontSize: 9.5 }}>
        {clip(reason, 90)}
      </text>
    </g>
  );
});

function DependencyItem({ node, pos, size }: { node: TreeNode; pos: number; size: number }) {
  // The item's visible line is in the lane's pinned gutter (DependencyLine); this is its focus target.
  return <Item node={node} pos={pos} size={size} ring={{ x: 0, y: 0, w: 0, h: 0 }} />;
}

function DependencyLine({ node, x, y }: { node: TreeNode; x: number; y: number }) {
  const ctx = useTreeCtx();
  if (node.data.kind !== "dependency") return null;
  const dep = node.data.dep;
  const ok = dep.state === "satisfied";
  return (
    <g data-tid={node.id} data-ref={node.ref}>
      {ctx.focusedId === node.id ? <rect x={x - 6} y={y - 10} width={SHEET.gutter - 76} height={13} rx={2} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 }} /> : null}
      <g transform={`translate(${x} ${y - 3})`}>
        <rect x={-3.5} y={-1} width={7} height={5.5} rx={1} style={{ fill: ok ? fc("pass") : fc("wait") }} />
        <path d={ok ? "M-2 -1v-2.2a2 2 0 0 1 4 0" : "M-2 -1v-2a2 2 0 0 1 4 0v2"} style={{ fill: "none", stroke: ok ? fc("pass") : fc("wait"), strokeWidth: 1.1 }} />
      </g>
      <text x={x + 8} y={y} style={{ fill: ok ? fc("pass") : fc("wait"), fontSize: 9.5 }}>
        {ok ? `${dep.to} integrated · unlocked ${clock(dep.satisfiedAt ?? 0)}` : `waits for ${dep.to} to be integrated`}
      </text>
    </g>
  );
}

function ScriptArtifact({ node, pos, size, x, y }: { node: TreeNode; pos: number; size: number; x: number; y: number }) {
  const at = node.data.kind === "artifact" ? node.data.artifact.writtenAt : 0;
  const late = useLate(node.data.kind === "artifact" ? node.data.artifact.meta.eventId : null);
  const p = useEventProgress(at, "artifactMaterialise", 0, late);
  // At the overview the cards are specks: the tree item stays (it is reachable and named), the card goes.
  const overview = useContext(LodContext) === "overview";
  if (node.data.kind !== "artifact") return null;
  const a = node.data.artifact;
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: x - 9, y: y - 11, w: 18, h: 22, r: 2 }}>
      {overview ? null : a.meta.authority === "reconstructed" ? (
        // Recorded by the observer from the cell's files, not written by a station: the card's outline, open and dashed.
        <path d={`M${x - 7} ${y - 9}h10l4 4v14h-14z`} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.9, strokeDasharray: "2.5 1.8", opacity: p }} />
      ) : (
        <ArtifactCard variant="blueprint" kind={grammarArtifact(a.kind)} progress={Math.max(0.001, p)} at={{ x, y }} showLabel={false} />
      )}
      <title>{`${artifactFile(a)} · ${a.writer.script ?? (a.meta.authority === "reconstructed" ? "recorded by the observer" : "")} · ${clock(a.writtenAt)}`}</title>
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
      <text x={x0 - 6} y={(lanes[0]?.y ?? 0) - 20} className="bp-fine" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em" }} aria-hidden="true">
        DEPENDENCIES
      </text>
      {deps.map((dep, i) => {
        const from = bySlice.get(dep.to);
        const to = bySlice.get(dep.from);
        if (!from || !to) return null;
        const x = x0 + i * 16;
        return <Dependency key={dep.id} id={dep.id} stubFrom={endX} x={x} fromY={anchorY(from)} toY={anchorY(to)} labelX={x0 + deps.length * 16 + 8} satisfiedAt={dep.satisfiedAt} state={dep.state} fromSlice={dep.to} toSlice={dep.from} eventId={dep.meta.eventId} />;
      })}
    </g>
  );
});

function Dependency({ id, stubFrom, x, fromY, toY, labelX, satisfiedAt, state, fromSlice, toSlice, eventId }: { id: string; stubFrom: number; x: number; fromY: number; toY: number; labelX: number; satisfiedAt: number | null; state: "blocking" | "satisfied"; fromSlice: string; toSlice: string; eventId: string }) {
  const late = useLate(eventId);
  const p = useEventProgress(satisfiedAt, "dependencyUnlock", 0, late);
  const entity = `dependency:${id}` as EntityRef;
  const highlighted = useSceneStore((s) => s.highlighted.includes(entity));
  const dimmed = useSceneStore((s) => s.highlighted.length > 0 && !s.highlighted.includes(entity) && (s.hovered ?? s.selection) !== null && ["cell", "slice", "dependency"].includes(refKind((s.hovered ?? s.selection) as EntityRef)));
  const done = state === "satisfied" && p >= 1;
  const ink = done ? fc("pass") : fc("wait");
  const midY = (fromY + toY) / 2;
  return (
    <g data-ref={entity} style={{ cursor: "pointer" }}>
      {/* The grammar's channel form: out of the prerequisite's integrated mark, down its own track in the
          channel, and into the dependent lane, with the padlock at the channel's middle. */}
      <DependencyLink variant="blueprint" from={{ x: stubFrom, y: fromY }} to={{ x: x + 14, y: toY }} channelX={x} state={state} progress={state === "satisfied" ? p : 0} highlighted={highlighted} dimmed={dimmed} />
      <text x={labelX} y={midY - 1} className="bp-fine tabular" style={{ fill: ink, fontSize: 9.5, fontWeight: 600, opacity: dimmed ? 0.3 : 1 }}>
        {toSlice.replace("SLICE-", "")} waits for {fromSlice.replace("SLICE-", "")}
        <tspan x={labelX} dy={12} style={{ fontWeight: 400, fontFamily: "var(--mach-font-mono)", fontSize: 9 }}>
          {state === "satisfied" && satisfiedAt !== null ? `unlocked ${clock(satisfiedAt)}` : "blocking"}
        </tspan>
      </text>
      <text x={labelX - 4} y={midY + 8} className="bp-over" style={{ fill: ink, fontSize: 30, fontWeight: 700, opacity: dimmed ? 0.3 : 1 }}>
        {toSlice.replace("SLICE-", "")} ← {fromSlice.replace("SLICE-", "")}
        <tspan x={labelX - 4} dy={34} style={{ fontWeight: 600 }}>
          {state === "satisfied" ? "unlocked" : "blocking"}
        </tspan>
      </text>
    </g>
  );
}

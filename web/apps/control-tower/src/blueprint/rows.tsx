/**
 * The rows under a cell's workflow drawing: each execution as a rail across the columns it ran and,
 * when opened, one ruler for the whole execution (a broken scale, see axis.ts), then its belt relay,
 * station visits (by round) and gates; under a visit, one lane per agent; under an open agent, its
 * tool calls as a trace on the same axis, with the artifacts it wrote and the findings it filed.
 * Every row's gutter is portalled into the pinned gutter layer. Rows far from the viewport are not
 * rendered (their tree items mount when the camera or the keyboard comes near).
 *
 * Live and replay (M6.2): an execution's times are its process's own start and end records and its
 * state is one of the nine activity states (interrupted and "outcome unknown" included); a visit's
 * span is its entry plus the measured duration; a build visit carries its tasks' completion marks
 * (no task has a recorded start); a verify visit its checks as recorded, and the targets listed for it
 * (reconstructed) as open "expected" marks; a workflow agent, whose calls are only counted, draws its
 * count and last tool on its span and never a tick. While the connection is stale, nothing here is
 * drawn as working: open spans stop where they were last seen.
 */
import { memo, useContext, type ReactNode } from "react";
import { AgentHead, ArtifactCard, fc, StationSymbol, TimeRuler, type FactoryState } from "@mach/ui";
import type { AgentState, CellState, EntityRef, ExecutionState, FindingState, GateState, StationVisit } from "../sim";
import { activityOf } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { execAxis, xOn, type ExecAxis } from "./axis";
import { LodContext } from "./context";
import { activityWords, agentStatusWords, callCount, execSpan, modelWords, perCall, placed, strokeOf, tokenWords, visitEnd } from "./facts";
import { visitRound, type Flow } from "./flow";
import { Gutter } from "./gutter";
import { SHEET, type Row } from "./layout";
import { ActivityMark, DimLine } from "./marks";
import { useEventProgress, useLate, useStaleSince } from "./motion";
import { clock, clockBare, duration, rulerOrigin } from "./time";
import { ToolTrace } from "./ticks";
import type { TreeNode } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, useSelected, useTreeCtx } from "./treeitem";
import { agentWords, artifactFile, GATE_WORDS, gateState as gateStateOf, grammarArtifact, visitMark, grammarSeat, modelWord, STATION_WORDS, stationKind, tierOf } from "./vocab";

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
          <SpanItem key={r.id} row={r} pos={at} size={n} laneY={laneY} ax={ax} width={width} axis={axis} cell={cell}>
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

/** The activity state of an entity at the playhead, aware of a stale connection (a string: stable for the store). */
function useActivity(entity: EntityRef, stale: boolean): ReturnType<typeof activityOf>["state"] {
  return useScene((sc) => activityOf(sc, entity, { stale }).state);
}

const ExecItem = memo(function ExecItem({ row, pos, size, laneY, ax, width, flow, cell, axis, children }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; flow: Flow; cell: CellState; axis: ExecAxis; children: ReactNode }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  const staleSince = useStaleSince();
  const activity = useActivity(node.ref, staleSince !== null);
  // Its own label when the state says too little (R6: its process ended, the outcome is not recorded yet).
  const label = useScene((sc) => activityOf(sc, node.ref, { stale: staleSince !== null }).label ?? null);
  if (node.data.kind !== "execution") return null;
  const { execution: x, index, count } = node.data;
  const y = row.y - laneY;
  const cols = execColumns(flow, x);
  const running = activity === "executing";
  const ink = running ? fc("live") : activity === "failed" || activity === "interrupted" ? fc("fail") : fc("ink-soft");
  const span = execSpan(x);
  const end = span.end;
  const endPlaced = end !== null && placed(span.endQuality);
  const waiting = x.outcome?.waitingFor && x.outcome.waitingFor !== "nothing" ? `, waiting for ${x.outcome.waitingFor}` : "";
  const how = x.ended === "exited" ? (x.exitCode !== null && x.exitCode !== 0 ? ` · exit ${x.exitCode}` : "") : x.ended ? ` · ${x.ended.replace(/-/g, " ")}` : "";
  const status = activity === "unknown" ? (x.recovery === "outcome-unknown" ? "outcome unknown" : label ? label.toLowerCase() : "not recorded") : activity === "stale" ? `as last seen at ${clock(staleSince ?? span.start)}` : x.state === "completed" ? `completed${waiting || (x.outcome?.stage ? `, ${x.outcome.stage}` : "")}` : activityWords(activity);
  const queued = Object.keys(x.queued).length;
  const cost = x.outcome?.costUsd ?? x.usage?.costUsd ?? null;
  const gx = GX + INDENT[0]!;
  const railY = y + 18;
  return (
    <Item node={node} pos={pos} size={size} expanded={row.expanded} ring={{ x: ax - 12, y: y + 2, w: width - ax - SHEET.left + 10, h: row.h - 4 }} group={children}>
      <Rule x={ax - 14} w={width - ax - SHEET.left + 14} y={y} weight={0.6} />
      {cols ? (
        <g>
          {/* The rail: an execution as a bracket across the columns it ran. */}
          <path d={`M${ax + cols.x1 - 16} ${railY - 5}v5H${ax + cols.x2 + (running ? 6 : 16)}${running ? "" : "v-5"}`} style={{ fill: "none", stroke: ink, strokeWidth: running ? 1.6 : 1.1, strokeDasharray: activity === "stale" || activity === "unknown" ? "4 3" : undefined }} />
          {running ? <path d={`M${ax + cols.x2 + 6} ${railY - 3.5}l5 3.5l-5 3.5`} style={{ fill: "none", stroke: ink, strokeWidth: 1.4 }} /> : null}
          <text x={ax + cols.x1 - 16} y={railY - 8} className="bp-fine tabular" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
            <tspan style={{ fontFamily: "var(--mach-font-mono)" }}>{end !== null ? clockBare(span.start) : clock(span.start)}</tspan>
            {end !== null ? <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> → {clock(end)} · {endPlaced || placed(span.startQuality) ? "≈ " : ""}{duration(end - span.start)}</tspan> : null}
            <tspan style={{ fill: activity === "interrupted" || activity === "failed" ? fc("fail") : undefined }}> · {status}{how}</tspan>
            {queued ? <tspan> · {queued} queued</tspan> : null}
            {cost !== null ? <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> · ${cost.toFixed(2)}</tspan> : null}
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
          <ActivityMark state={activity} r={4.5} />
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
        {/* The row's title at the overview, set large enough to read at fit. */}
        <text x={gx + 24} y={25} className="bp-over" style={{ fill: "var(--mach-ink-muted)", fontSize: 24, fontWeight: 600 }}>
          Execution {index + 1} of {count}
        </text>
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
  let placedD = "";
  for (const s of axis.segments) {
    if (s.kind === "visit" && s.placed) placedD += `M${s.x0 + 1} ${base + 2.5}h${Math.max(1, s.w - 2)}`;
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
                {`${s.placed ? "≈ " : ""}${STATION_WORDS[s.station ?? ""] ?? s.station}${s.round && s.round > 1 ? ` · r${s.round}` : ""}`}
              </text>
            ) : null}
          </g>
        ) : null,
      )}
      <path d={breaks} style={{ stroke: fc("ink-soft"), strokeWidth: 0.9 }} />
      {/* A visit whose start or end was placed, not measured: a dashed underline on its stretch of the ruler. */}
      {placedD ? <path d={placedD} style={{ stroke: fc("ink-soft"), strokeWidth: 0.9, strokeDasharray: "3 2" }} /> : null}
    </g>
  );
});

/**
 * One visit's stretch of the ruler; the playhead is drawn on it only while the playhead is inside.
 * Live and replay times are Unix ms: the ruler is given them from the local midnight, so it labels the
 * time of day; the simulation's run time is given as it is.
 */
function SegmentRuler({ x, y, width, from, to }: { x: number; y: number; width: number; from: number; to: number }) {
  const origin = rulerOrigin(from);
  const playhead = useSceneStore((s) => (s.playhead >= from && s.playhead <= to ? Math.floor(s.playhead / 1000) * 1000 - origin : undefined));
  return <TimeRuler x={x} y={y} width={width} from={from - origin} to={to - origin} playhead={playhead} side="bottom" format="mm:ss" />;
}

/**
 * A span that is still open, drawn to the playhead (its own component: it moves). While the connection
 * is stale it is drawn as last seen: dashed, in ink-soft, ending where the stream last confirmed.
 */
function LiveSpan({ axis, start, y, color, weight }: { axis: ExecAxis; start: number; y: number; color: string; weight: number }) {
  const staleSince = useStaleSince();
  const x1 = useSceneStore((s) => Math.round(xOn(axis, Math.min(s.playhead, axis.end)) * 2) / 2);
  const x0 = xOn(axis, start);
  const stale = staleSince !== null;
  return <line x1={x0} y1={y} x2={Math.max(x0 + 1, x1)} y2={y} aria-hidden="true" style={{ stroke: stale ? fc("ink-soft") : color, strokeWidth: weight, strokeLinecap: stale ? "butt" : "round", strokeDasharray: stale ? "4 3" : undefined }} />;
}

/* ------------------------------------------------------------------------------------------------ */
/* Visit (and the belt relay)                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function spanOf(node: TreeNode): { start: number; end: number | null; agents: readonly AgentState[] } | null {
  if (node.data.kind === "visit") return { start: node.data.visit.enteredAt, end: visitEnd(node.data.visit), agents: node.data.agents };
  if (node.data.kind === "relay") {
    const span = execSpan(node.data.execution);
    return { start: span.start, end: span.end, agents: node.data.agents };
  }
  return null;
}

const SpanItem = memo(function SpanItem({ row, pos, size, laneY, ax, width, axis, cell, children }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; axis: ExecAxis; cell: CellState; children: ReactNode }) {
  const node = row.node;
  const span = spanOf(node);
  const selected = useSelected(node.ref);
  const staleSince = useStaleSince();
  if (!span) return null;
  const y = row.y - laneY;
  const gx = GX + INDENT[1]!;
  const visit: StationVisit | null = node.data.kind === "visit" ? node.data.visit : null;
  const title = visit ? (visit.action === "revise" ? "Build (revise)" : (STATION_WORDS[visit.station] ?? visit.station)) : "Belt relay";
  const round = visit ? visitRound(visit) : null;
  const open = span.end === null;
  const stale = open && staleSince !== null;
  // A visit the scene closed without an exit record (D4) is interrupted: its span ends at the bound, dashed, never live.
  const vm = visit ? visitMark(visit) : null;
  const state: FactoryState = visit ? (open ? (stale ? "idle" : visit.station === "human-approval" ? "human" : "active") : vm === "failed" ? "failed" : vm === "interrupted" || vm === "unknown" || vm === "blocked" ? "idle" : "succeeded") : open ? (stale ? "idle" : "active") : "succeeded";
  const h = row.h;
  const calls = span.agents.reduce((n, a) => n + (callCount(a) ?? 0), 0);
  const counted = span.agents.some((a) => !perCall(a));
  const visitPlaced = visit ? placed(visit.meta.start) || (!open && placed(visit.meta.end)) : false;
  return (
    <Item node={node} pos={pos} size={size} expanded={row.expanded} ring={{ x: ax - 12, y: y + 2, w: width - ax - SHEET.left + 10, h: h - 4 }} group={children}>
      <Rule x={ax - 14} w={width - ax - SHEET.left + 14} y={y} weight={0.5} color={fc("grid-major")} />
      {visit ? <VisitSpan axis={axis} start={span.start} end={span.end} y={y + 14} state={state} placed={visitPlaced || Boolean(visit.unclosed)} word={visit.unclosed ? "no exit record" : visit.outcomeWord} /> : null}
      {visit && visit.station === "build" ? <TaskMarks axis={axis} cell={cell} from={span.start} to={span.end} y={y + 24} /> : null}
      {visit && visit.station === "verify" ? <CheckMarks axis={axis} cell={cell} round={round ?? 1} y={y + 24} /> : null}
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
          {span.end !== null ? clockBare(span.start) : clock(span.start)}–{span.end !== null ? clock(span.end) : stale ? `last seen ${clock(staleSince)}` : "now"} · {span.agents.length} agent{span.agents.length === 1 ? "" : "s"} · {calls} calls{counted ? " counted" : ""}
        </text>
      </Gutter>
      {visit?.visitId ? <title>{`${node.name}.`}</title> : null}
    </Item>
  );
});

/**
 * The visit's own span on the execution's axis: a bar in its state ink, open to the playhead while it
 * runs, with the station's own outcome word at its end. A span whose start or end was placed rather
 * than measured is dashed.
 */
function VisitSpan({ axis, start, end, y, state, placed: isPlaced, word }: { axis: ExecAxis; start: number; end: number | null; y: number; state: FactoryState; placed: boolean; word: string | null }) {
  const color = fc(state === "active" ? "live" : state === "failed" ? "fail" : state === "human" ? "human" : "ink-soft");
  if (end === null) return <LiveSpan axis={axis} start={start} y={y + 10} color={color} weight={3} />;
  const x0 = xOn(axis, start);
  const x1 = Math.max(x0 + 1, xOn(axis, end));
  return (
    <g aria-hidden="true">
      <line x1={x0} y1={y + 10} x2={x1} y2={y + 10} style={{ stroke: color, strokeWidth: 3, strokeLinecap: "butt", opacity: 0.55, strokeDasharray: isPlaced ? "5 3" : undefined }} />
      {word ? (
        <text x={x1 + 4} y={y + 13} className="bp-fine" style={{ fill: state === "failed" ? fc("fail") : "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 7.5 }}>
          {word}
        </text>
      ) : null}
    </g>
  );
}

/**
 * A build visit's tasks as completion marks: one upright at the moment each task was recorded done, in
 * the red or green its step was. No task has a recorded start (contract 11), so none is drawn as a span.
 */
const TaskMarks = memo(function TaskMarks({ axis, cell, from, to, y }: { axis: ExecAxis; cell: CellState; from: number; to: number | null; y: number }) {
  let red = "";
  let green = "";
  for (const t of cell.tasks) {
    if (t.doneAt === null || t.doneAt < from - 1 || (to !== null && t.doneAt > to + 1)) continue;
    const x = Math.round(xOn(axis, t.doneAt) * 2) / 2;
    const d = `M${x} ${y - 3.5}v5`;
    if (t.status === "red") red += d;
    else green += d;
  }
  if (!red && !green) return null;
  return (
    <g aria-hidden="true">
      {red ? <path d={red} style={{ stroke: fc("fail"), strokeWidth: 1.4 }} /> : null}
      {green ? <path d={green} style={{ stroke: fc("pass"), strokeWidth: 1.4 }} /> : null}
    </g>
  );
});

/**
 * A verify visit's checks: each recorded check at the moment it was recorded (a tick passed, a cross
 * failed, solid: the station recorded it), and each target listed for it but not recorded yet as an
 * open, dashed ring at the visit's end with the word "expected" (the list is reconstructed by the
 * observer from spec.json; it is what should be proven, not what has been).
 */
const CheckMarks = memo(function CheckMarks({ axis, cell, round, y }: { axis: ExecAxis; cell: CellState; round: number; y: number }) {
  const ver = cell.verifications.find((v) => v.round === round);
  if (!ver) return null;
  let pass = "";
  let fail = "";
  // Expected only from a fact: the list of targets received (`verify.targets_listed`), less what is recorded.
  const expected = ver.listed ? ver.checks.filter((c) => c.result === "pending") : [];
  for (const c of ver.checks) {
    if (c.at === null) continue;
    const x = Math.round(xOn(axis, c.at) * 2) / 2;
    if (c.result === "fail") fail += `M${x - 2.4} ${y - 2.4}l4.8 4.8M${x + 2.4} ${y - 2.4}l-4.8 4.8`;
    else pass += `M${x - 2.6} ${y}l1.8 2l3.4 -4`;
  }
  const endX = xOn(axis, ver.decidedAt ?? axis.end);
  return (
    <g aria-hidden="true">
      {pass ? <path d={pass} style={{ fill: "none", stroke: fc("pass"), strokeWidth: 1.2 }} /> : null}
      {fail ? <path d={fail} style={{ fill: "none", stroke: fc("fail"), strokeWidth: 1.2 }} /> : null}
      {expected.length ? (
        <g>
          {expected.slice(0, 8).map((c, i) => (
            <circle key={c.targetId} cx={endX + 6 + i * 7} cy={y} r={2.4} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.9, strokeDasharray: "1.6 1.2" }} />
          ))}
          <text x={endX + 6 + Math.min(8, expected.length) * 7 + 2} y={y + 3} className="bp-fine" style={{ fill: "var(--mach-ink-subtle)", fontSize: 7.5 }}>
            {expected.length} expected
          </text>
        </g>
      ) : null}
    </g>
  );
});

const AgentGlance = memo(function AgentGlance({ axis, agents, y }: { axis: ExecAxis; agents: readonly AgentState[]; y: number }) {
  const shown = agents.slice(0, 5);
  return (
    <g aria-hidden="true">
      {shown.map((a, i) =>
        a.finishedAt === null ? (
          <LiveSpan key={a.id} axis={axis} start={a.startedAt} y={y + 1 + i * 2.2} color={fc("live")} weight={1.2} />
        ) : (
          <line key={a.id} x1={xOn(axis, a.startedAt)} y1={y + 1 + i * 2.2} x2={Math.max(xOn(axis, a.startedAt) + 1, xOn(axis, a.finishedAt))} y2={y + 1 + i * 2.2} style={{ stroke: fc(a.status === "error" ? "fail" : "ink-soft"), strokeWidth: 1.2, strokeLinecap: "round", strokeDasharray: a.lifecycle === "unknown" ? "2 1.5" : undefined }} />
        ),
      )}
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* Gate row                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

function gateInk(st: FactoryState): { ink: string; soft: string } {
  return {
    ink: fc(st === "idle" ? "ink-soft" : st === "active" ? "live" : st === "succeeded" ? "pass" : st === "failed" ? "fail" : "human"),
    soft: st === "idle" ? fc("plate-top") : fc(st === "active" ? "live-soft" : st === "succeeded" ? "pass-soft" : st === "failed" ? "fail-soft" : "human-soft"),
  };
}

const GateItem = memo(function GateItem({ row, pos, size, laneY, ax, width, axis }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; axis: ExecAxis }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  const staleSince = useStaleSince();
  if (node.data.kind !== "gate") return null;
  const g: GateState = node.data.gate;
  const y = row.y - laneY;
  const gx = GX + INDENT[1]! + 16;
  const gst = gateStateOf(g);
  // An open gate is not shown as deciding while the connection is stale.
  const st: FactoryState = gst === "active" && staleSince !== null ? "idle" : gst;
  const { ink, soft } = gateInk(st);
  const stroke = strokeOf(g.meta.authority);
  const mx = xOn(axis, g.decidedAt ?? g.openedAt);
  const left = mx > ax + (width - ax) * 0.55;
  const over = g.state === "overridden";
  const detail = g.detail.length > 120 ? `${g.detail.slice(0, 119)}…` : g.detail;
  return (
    <Item node={node} pos={pos} size={size} ring={{ x: ax - 12, y: y + 1, w: width - ax - SHEET.left + 10, h: row.h - 2 }}>
      {/* The gate on the execution's axis, at its decision, with what it decided (and its reason code) beside it. */}
      <path d={`M${mx} ${y + 6}l6 6l-6 6l-6 -6z`} aria-hidden="true" style={{ fill: stroke.open ? fc("ground") : over ? fc("wait-soft") : soft, stroke: over ? fc("wait") : ink, strokeWidth: 1.1, strokeDasharray: stroke.dash }} />
      {/* Overridden, not passed: a bypass arc over the diamond (shape, not colour alone). */}
      {over ? <path d={`M${mx - 7} ${y + 11}c2 -7 12 -7 14 0`} aria-hidden="true" style={{ fill: "none", stroke: fc("wait"), strokeWidth: 1.2, strokeLinecap: "round" }} /> : null}
      <text x={left ? mx - 10 : mx + 10} y={y + 15.5} textAnchor={left ? "end" : "start"} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
        <tspan style={{ fill: over ? fc("wait") : ink, fontWeight: 600 }}>{g.state}</tspan>
        {g.reasonCode && g.reasonCode !== g.state ? <tspan style={{ fill: ink, fontFamily: "var(--mach-font-mono)" }}> {g.reasonCode}</tspan> : null}
        <tspan style={{ fontFamily: "var(--mach-font-mono)" }}> {g.decidedAt !== null && g.decidedAt !== g.openedAt ? `${clockBare(g.openedAt)} → ${clock(g.decidedAt)}` : clock(g.openedAt)}</tspan>
        <tspan> · {detail}</tspan>
      </text>
      <Gutter row id={node.id} entity={node.ref} y={row.y} h={row.h} ax={ax}>
        {selected ? <SelectBar x={GX + 26} y={1} h={row.h - 2} /> : null}
        <GutterRing id={node.id} x={GX + 26} h={row.h} />
        <path d={`M${gx} 6l6 6l-6 6l-6 -6z`} style={{ fill: stroke.open ? fc("ground") : over ? fc("wait-soft") : soft, stroke: over ? fc("wait") : ink, strokeWidth: 1.1, strokeDasharray: stroke.dash }} />
        {over ? <path d={`M${gx - 7} 11c2 -7 12 -7 14 0`} style={{ fill: "none", stroke: fc("wait"), strokeWidth: 1.2, strokeLinecap: "round" }} /> : null}
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

/** The state an agent's head is drawn in: never working while the connection is stale; "not recorded" when it ended with no record. */
function agentMarkState(a: AgentState, stale: boolean): FactoryState | "unknown" | "stale" {
  switch (a.lifecycle) {
    case "running":
      return stale ? "stale" : "active";
    case "queued":
      return "waiting";
    case "error":
      return "failed";
    case "unknown":
      return "unknown";
    default:
      return "succeeded";
  }
}

const AgentItem = memo(function AgentItem({ row, pos, size, laneY, ax, width, axis }: { row: Row; pos: number; size: number; laneY: number; ax: number; width: number; axis: ExecAxis }) {
  const node = row.node;
  const selected = useSelected(node.ref);
  const ctx = useTreeCtx();
  const staleSince = useStaleSince();
  // At the overview a trace's caps are sub-pixel: an open lane draws as its single path there.
  const overview = useContext(LodContext) === "overview";
  if (node.data.kind !== "agent") return null;
  const a = node.data.agent;
  const y = row.y - laneY;
  const gx = GX + INDENT[2]!;
  const st = agentMarkState(a, staleSince !== null);
  const words = agentWords(a);
  const h = row.h;
  const base = row.expanded ? y + 44 : y + 18;
  const calls = perCall(a);
  // Leaves are tree items only near the keyboard's position: a window around the active leaf.
  const leaves = row.expanded ? node.children : [];
  const activeIdx = ctx.activeId ? leaves.findIndex((l) => l.id === ctx.activeId) : -1;
  const windowed = activeIdx >= 0 ? leaves.slice(Math.max(0, activeIdx - WINDOW), activeIdx + WINDOW + 1) : [];
  const toolTids = calls ? a.toolCalls.map((c) => `t:${c.id}`) : [];
  const tokens = tokenWords(a.tokens);
  const took = a.durationMs ?? (a.finishedAt !== null ? a.finishedAt - a.startedAt : null);
  const tookPlaced = placed(a.meta.start) || placed(a.meta.end);
  const endX = a.finishedAt !== null ? Math.max(xOn(axis, a.startedAt) + 1, xOn(axis, a.finishedAt)) : null;
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
        <line x1={xOn(axis, a.startedAt)} y1={base + 1} x2={endX ?? 0} y2={base + 1} aria-hidden="true" style={{ stroke: fc(a.status === "error" ? "fail" : "ink-soft"), strokeWidth: row.expanded ? 1 : 2, strokeLinecap: "round", strokeDasharray: a.lifecycle === "unknown" || tookPlaced ? "4 3" : undefined }} />
      )}
      {calls ? <ToolTrace agent={a} tids={toolTids} axis={axis} base={base} open={row.expanded && !overview} laneKey={a.id} /> : <CountLabel agent={a} x={(endX ?? xOn(axis, Math.min(axis.end, a.startedAt))) + 6} y={base + 4} />}
      {row.expanded && !overview ? <AgentDetail node={node} agent={a} axis={axis} base={base} y={y} /> : null}
      {/* The hit layer: one rectangle; the view finds the call under the pointer from the registry. */}
      <rect x={ax} y={y + 2} width={width - ax - SHEET.left} height={h - 4} data-ticks={calls ? a.id : undefined} style={{ fill: "transparent" }} />
      <Gutter row id={node.id} entity={node.ref} y={row.y} h={h} ax={ax}>
        <Rule x={GX + 42} w={SHEET.gutter - 56} y={0} weight={0.4} color={fc("grid")} />
        {selected ? <SelectBar x={GX + 40} y={1} h={h - 2} /> : null}
        <GutterRing id={node.id} x={GX + 40} h={h} />
        {row.expandable ? <ToggleTarget x={gx} y={14} /> : null}
        {row.expandable ? <Chevron x={gx} y={14} open={row.expanded} /> : null}
        <g transform={`translate(${gx + 16} 14)`}>
          {st === "unknown" || st === "stale" ? <ActivityMark state={st} r={4.5} /> : <AgentHead tier={tierOf(a.model)} fill={st === "active" ? fc("live") : fc("plate-top")} stroke={fc(st === "active" ? "live" : st === "failed" ? "fail" : st === "waiting" ? "wait" : "ink")} />}
        </g>
        {a.seat && grammarSeat(a.seat) ? (
          <text x={gx + 16} y={5} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontSize: 7.5, fontWeight: 700 }}>
            {a.seat[0]!.toUpperCase()}
          </text>
        ) : null}
        <text x={gx + 28} y={13} className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
          {words}
          <tspan style={{ fill: "var(--mach-ink-muted)", fontWeight: 400 }}> · {modelWords(a, modelWord(a.model))}</tspan>
          {calls || a.label === words ? null : <tspan className="notranslate" style={{ fill: "var(--mach-ink-subtle)", fontWeight: 400, fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }}> · {a.label.length > 34 ? `${a.label.slice(0, 33)}…` : a.label}</tspan>}
        </text>
        <text x={gx + 28} y={24} className="bp-fine tabular" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 8 }}>
          {calls
            ? `${a.agentType ?? a.role} · ${a.toolCalls.length} calls${took !== null && a.finishedAt !== null ? ` · ${tookPlaced ? "≈ " : ""}${duration(took)}` : ""}`
            : `${a.meta.start === "unknown" ? "start not recorded" : `${a.meta.start === "inferred" ? "≈ " : ""}${clock(a.startedAt)}`} · ${a.phase} · ${agentStatusWords(a, staleSince !== null)}${took !== null && a.finishedAt !== null ? ` · ${tookPlaced ? "≈ " : ""}${duration(took)}` : ""}${tokens ? ` · ${tokens}` : ""}`}
        </text>
      </Gutter>
    </Item>
  );
}, sameRowProps);

/**
 * A workflow agent's tool activity, as much as is observable (contract 8.1): how many calls a snapshot
 * counted and the last tool it named, beside the span, and once, the reason there is nothing finer.
 * No tick, no bar, no "now running".
 */
function CountLabel({ agent, x, y }: { agent: AgentState; x: number; y: number }) {
  const n = callCount(agent);
  return (
    <text x={x} y={y} aria-hidden="true" className="bp-fine tabular" style={{ fill: "var(--mach-ink-muted)", fontSize: 8.5 }}>
      <tspan style={{ fontFamily: "var(--mach-font-mono)" }}>{n === null ? "calls not reported yet" : `${n} call${n === 1 ? "" : "s"}`}</tspan>
      {agent.lastTool ? <tspan> · last {agent.lastTool}</tspan> : null}
      <tspan style={{ fill: "var(--mach-ink-subtle)" }}> · calls not observable for workflow agents</tspan>
    </text>
  );
}

/** An open agent's artifacts (with the task a commit closed), findings and its dimensioned span. */
const AgentDetail = memo(function AgentDetail({ node, agent, axis, base, y }: { node: TreeNode; agent: AgentState; axis: ExecAxis; base: number; y: number }) {
  const took = agent.durationMs ?? (agent.finishedAt !== null ? agent.finishedAt - agent.startedAt : null);
  return (
    <g aria-hidden="true">
      {node.children.map((leafNode) => {
        if (leafNode.data.kind === "artifact") {
          const art = leafNode.data.artifact;
          return <ArtifactMark key={leafNode.id} x={xOn(axis, art.writtenAt)} y={base - 27} kind={art.kind} at={art.writtenAt} file={artifactFile(art)} task={art.kind === "commit" ? (/\b(R\d-)?T\d\d\b/.exec(art.label)?.[0] ?? null) : null} reconstructed={art.meta.authority === "reconstructed"} eventId={art.meta.eventId} />;
        }
        if (leafNode.data.kind === "finding") return <FindingMark key={leafNode.id} finding={leafNode.data.finding} x={xOn(axis, leafNode.data.finding.at)} base={base} />;
        return null;
      })}
      {agent.finishedAt !== null && took !== null ? <DimLine x1={xOn(axis, agent.startedAt)} x2={Math.max(xOn(axis, agent.startedAt) + 2, xOn(axis, agent.finishedAt))} y={y + 70} label={duration(took)} inferred={placed(agent.meta.start) || placed(agent.meta.end)} extend={4} /> : null}
    </g>
  );
});

function ArtifactMark({ x, y, kind, at, file, task, reconstructed, eventId }: { x: number; y: number; kind: Parameters<typeof grammarArtifact>[0]; at: number; file: string; task: string | null; reconstructed: boolean; eventId: string }) {
  const late = useLate(eventId);
  const p = useEventProgress(at, "artifactMaterialise", 0, late);
  const failed = kind === "verification-findings";
  return (
    <g>
      {reconstructed ? (
        // Reconstructed by the observer, not written by a station: the card's outline, open and dashed.
        <path d={`M${x - 7} ${y - 9}h10l4 4v14h-14z`} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.9, strokeDasharray: "2.5 1.8", opacity: p }} />
      ) : (
        <ArtifactCard variant="blueprint" kind={grammarArtifact(kind)} state={failed ? "failed" : "succeeded"} progress={Math.max(0.001, p)} at={{ x, y }} showLabel={false} />
      )}
      {task ? (
        <text x={x + 9} y={y - 4} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 7.5, opacity: p }}>
          {task}
        </text>
      ) : null}
      <title>{`${file}${reconstructed ? " (recorded by the observer)" : ""}`}</title>
    </g>
  );
}

function FindingMark({ finding, x, base }: { finding: FindingState; x: number; base: number }) {
  // A finding the observer reconstructed from findings.md is drawn open and dashed; one a station recorded, solid.
  const stroke = strokeOf(finding.meta.authority);
  return finding.severity === "blocker" ? (
    <path d={`M${x} ${base + 10}l5 5l-5 5l-5 -5z`} style={{ fill: finding.outvoted || stroke.open ? fc("plate-top") : fc("fail"), stroke: fc("fail"), strokeWidth: 1.1, strokeDasharray: stroke.dash }} />
  ) : (
    <circle cx={x} cy={base + 15} r={3} style={{ fill: "none", stroke: fc("wait"), strokeWidth: 1.1, strokeDasharray: stroke.dash }} />
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

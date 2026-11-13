/**
 * The Blueprint's hierarchy, as a pure function of the scene at the playhead:
 *
 *   wave → slice / cell → dependency, artifact written by a script, execution
 *        → execution → belt relay (the Haiku clerks), station visit (by round), gate
 *        → visit → agent → tool call, artifact, finding
 *
 * It is the ARIA tree (keyboard order, levels, names) and the input to the layout. Built per cell
 * and cached on the cell's state object, which the engine shares between moments until an event
 * touches that cell, so unchanged cells cost nothing.
 *
 * Every wave the history has named is a root, in the order the history gives them (a wave that
 * arrives later is appended; a late one is inserted where it belongs). A wave's lanes are its slices,
 * in history order. Nothing here waits for the end of a run: a slice, an execution, a visit or a
 * round appears as its first event is applied. A workflow agent whose calls are reported only as a
 * count has no tool-call items (contract D13): its node names the count and the last tool instead.
 */
import type { AgentState, ArtifactState, CellState, DependencyState, EntityRef, ExecutionState, FindingState, GateState, Scene, SliceState, StationVisit, ToolCallState, WaveState } from "../sim";
import { activityOf, capacityWaitOf, cellHome, gateOverrides, gateRefusals, isKnown, ref, SIM_META } from "../sim";
import { activityWords, agentStatusWords, callCount, execSpan, modelWords, perCall, placed, tokenWords, visitEnd } from "./facts";
import { visitRound } from "./flow";
import { agentWords, GATE_WORDS, gateWords, modelWord, stageWords, visitStateWords, visitWords } from "./vocab";
import { clock, duration } from "./time";

export type TreeKind = "wave" | "slice" | "dependency" | "artifact" | "execution" | "relay" | "visit" | "gate" | "agent" | "tool" | "finding";

export interface TreeNode {
  readonly id: string;
  readonly ref: EntityRef;
  readonly kind: TreeKind;
  /** 1 for the wave. */
  readonly level: number;
  readonly parent: string | null;
  readonly children: readonly TreeNode[];
  /** Accessible name: what it is, its state, its time. */
  readonly name: string;
  readonly ticketId: string | null;
  /** Kind-specific payload, by reference into the scene (never copied). */
  readonly data: TreeData;
}

export type TreeData =
  | { kind: "wave"; wave: WaveState }
  | { kind: "slice"; slice: SliceState; cell: CellState | null }
  | { kind: "dependency"; dep: DependencyState }
  | { kind: "artifact"; artifact: ArtifactState }
  | { kind: "execution"; execution: ExecutionState; index: number; count: number }
  | { kind: "relay"; execution: ExecutionState; agents: readonly AgentState[] }
  | { kind: "visit"; visit: StationVisit; index: number; occurrence: number; agents: readonly AgentState[] }
  | { kind: "gate"; gate: GateState }
  | { kind: "agent"; agent: AgentState }
  | { kind: "tool"; call: ToolCallState }
  | { kind: "finding"; finding: FindingState };

export interface Tree {
  /** The waves, in history order (empty before the first wave arrives). */
  readonly roots: readonly TreeNode[];
  /** Every node by id. */
  readonly byId: ReadonlyMap<string, TreeNode>;
  /** Tree ids that carry an entity ref; a station ref names every visit of that station (last wins for focus). */
  readonly byRef: ReadonlyMap<EntityRef, readonly string[]>;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function leaf(id: string, r: EntityRef, kind: TreeKind, level: number, parent: string, name: string, ticketId: string, data: TreeData): TreeNode {
  return { id, ref: r, kind, level, parent, children: [], name, ticketId, data };
}

/** Which execution owns a moment: the one whose window contains it, else the last one claimed before it. */
function executionAt(executions: readonly ExecutionState[], t: number): ExecutionState | null {
  let found: ExecutionState | null = null;
  for (const x of executions) {
    if (x.claimedAt <= t + 1) found = x;
  }
  for (const x of executions) if (x.claimedAt <= t && (x.endedAt === null || t <= x.endedAt)) return x;
  return found;
}

export function visitTreeId(ticketId: string, index: number): string {
  return `v:${ticketId}:${index}`;
}

interface CellTree {
  readonly cell: CellState;
  readonly parent: string;
  readonly executions: readonly ExecutionState[];
  readonly deps: readonly DependencyState[];
  readonly gates: readonly GateState[];
  /** The ticket's recorded capacity wait (held outside the cell), part of the lane's name. */
  readonly wait: unknown;
  readonly node: TreeNode;
}

const cellCache = new WeakMap<SliceState, CellTree>();

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface AgentMemo {
  readonly parent: string;
  readonly level: number;
  readonly artifacts: readonly ArtifactState[];
  readonly findings: readonly FindingState[];
  readonly node: TreeNode;
}
const agentCache = new WeakMap<AgentState, AgentMemo>();

/** An agent's node, kept identical while the agent, its artifacts and its findings are unchanged. */
function agentNode(agent: AgentState, cell: CellState, parent: string, level: number): TreeNode {
  const artifacts = cell.artifacts.filter((a) => a.writer.agentId === agent.id);
  const findings: FindingState[] = [];
  if (agent.role === "reviewer") {
    for (const round of cell.reviews) {
      const seat = round.seats.find((s) => s.agentId === agent.id);
      if (seat) for (const f of round.findings) if (f.seat === seat.seat) findings.push(f);
    }
  }
  const memo = agentCache.get(agent);
  if (memo && memo.parent === parent && memo.level === level && sameList(memo.artifacts, artifacts) && sameList(memo.findings, findings)) return memo.node;
  const node = makeAgentNode(agent, cell, parent, level);
  agentCache.set(agent, { parent, level, artifacts, findings, node });
  return node;
}

function makeAgentNode(agent: AgentState, cell: CellState, parent: string, level: number): TreeNode {
  const id = `a:${agent.id}`;
  const kids: TreeNode[] = [];
  const items: { t: number; node: TreeNode }[] = [];
  // Tool-call items only where each call was observed: a workflow agent's calls are a count, never items.
  if (perCall(agent)) for (const call of agent.toolCalls) {
    const words = `${call.tool} ${call.target}`;
    const state = call.status === "running" ? "running" : call.status === "error" ? "refused" : `${duration((call.finishedAt ?? call.startedAt) - call.startedAt)}`;
    items.push({ t: call.startedAt, node: leaf(`t:${call.id}`, ref.tool(call.id), "tool", level + 1, id, `Tool call ${words}, at ${clock(call.startedAt)}, ${state}`, cell.ticketId, { kind: "tool", call }) });
  }
  for (const a of cell.artifacts) {
    if (a.writer.agentId !== agent.id) continue;
    items.push({ t: a.writtenAt, node: leaf(`af:${a.id}`, ref.artifact(a.id), "artifact", level + 1, id, `Artifact ${a.label}, written at ${clock(a.writtenAt)}${a.version > 1 ? `, version ${a.version}` : ""}`, cell.ticketId, { kind: "artifact", artifact: a }) });
  }
  if (agent.role === "reviewer") {
    for (const round of cell.reviews) {
      const seat = round.seats.find((s) => s.agentId === agent.id);
      if (!seat) continue;
      for (const f of round.findings) {
        if (f.seat !== seat.seat) continue;
        items.push({ t: f.at, node: leaf(`f:${f.id}`, ref.finding(f.id), "finding", level + 1, id, `${f.severity === "blocker" ? "Blocker" : "Note"}${f.rule ? ` ${f.rule}` : ""}: ${f.title}${f.outvoted ? ", outvoted" : ""}`, cell.ticketId, { kind: "finding", finding: f }) });
      }
    }
  }
  items.sort((a, b) => a.t - b.t);
  for (const i of items) kids.push(i.node);
  const name = agentName(agent);
  return { id, ref: ref.agent(agent.id), kind: "agent", level, parent, children: kids, name, ticketId: cell.ticketId, data: { kind: "agent", agent } };
}

/** An agent's accessible name: who, model, status and its tool activity as it is known. */
function agentName(agent: AgentState): string {
  const took = agent.durationMs ?? (agent.finishedAt !== null ? agent.finishedAt - agent.startedAt : null);
  const approx = placed(agent.meta.start) || placed(agent.meta.end) ? "about " : "";
  const status = agent.lifecycle === "done" && took !== null ? `finished in ${approx}${duration(took)}` : agentStatusWords(agent, false);
  const model = modelWords(agent, modelWord(agent.model));
  if (perCall(agent)) return `${agentWords(agent)}, ${model}, ${status}, ${plural(agent.toolCalls.length, "tool call")}`;
  const n = callCount(agent);
  const tokens = tokenWords(agent.tokens);
  return `${agentWords(agent)} (${agent.label}), phase ${agent.phase}, ${model}, ${status}, ${n === null ? "tool calls not reported yet" : `${plural(n, "tool call")} counted`}${agent.lastTool ? `, last tool ${agent.lastTool}` : ""}${tokens ? `, ${tokens}` : ""}. Individual calls are not observable for workflow agents.`;
}

function buildCell(scene: Scene, slice: SliceState, cell: CellState, executions: readonly ExecutionState[], deps: readonly DependencyState[], gatesByExec: ReadonlyMap<string, readonly GateState[]>, level: number, parent: string): TreeNode {
  const laneId = `s:${slice.id}`;
  const children: TreeNode[] = [];
  for (const dep of deps) children.push(leaf(`d:${dep.id}`, ref.dependency(dep.from, dep.to), "dependency", level + 1, laneId, `Waits for ${dep.to}: ${dep.state === "satisfied" ? `satisfied at ${clock(dep.satisfiedAt ?? 0)}` : "blocking"}`, cell.ticketId, { kind: "dependency", dep }));
  // Artifacts no agent wrote (intake, cell.py finalize, review.py approve-human) belong to the cell.
  for (const a of cell.artifacts) {
    if (a.writer.agentId) continue;
    const by = a.writer.script ?? (a.meta.authority === "reconstructed" ? "the observer (reconstructed)" : "a script");
    children.push(leaf(`af:${a.id}`, ref.artifact(a.id), "artifact", level + 1, laneId, `Artifact ${a.label}, ${a.meta.authority === "reconstructed" ? "recorded" : "written"} by ${by} at ${clock(a.writtenAt)}`, cell.ticketId, { kind: "artifact", artifact: a }));
  }
  const agentsByExec = new Map<string, AgentState[]>();
  for (const id of cell.agentOrder) {
    const a = cell.agents[id] as AgentState;
    const key = a.executionId ?? "";
    let list = agentsByExec.get(key);
    if (!list) agentsByExec.set(key, (list = []));
    list.push(a);
  }
  const execOfVisit = new Map<number, string>();
  cell.visits.forEach((v, i) => {
    const x = executionAt(executions, v.enteredAt);
    if (x) execOfVisit.set(i, x.id);
  });
  executions.forEach((x, xi) => {
    const xid = `x:${x.id}`;
    const xLevel = level + 1;
    const own = agentsByExec.get(x.id) ?? [];
    const visitIdx = cell.visits.map((_, i) => i).filter((i) => execOfVisit.get(i) === x.id);
    const claimed = new Set<string>();
    const items: { t: number; node: TreeNode }[] = [];
    for (const i of visitIdx) {
      const v = cell.visits[i] as StationVisit;
      const end = v.leftAt ?? Infinity;
      const inVisit = own.filter((a) => a.startedAt >= v.enteredAt - 1 && a.startedAt <= end && (a.station === v.station || (a.station === null && a.phase === "Review" && v.station === "review")));
      for (const a of inVisit) claimed.add(a.id);
      const occurrence = cell.visits.slice(0, i).filter((w) => w.station === v.station).length;
      const vid = visitTreeId(cell.ticketId, i);
      const kids = inVisit.map((a) => agentNode(a, cell, vid, xLevel + 2));
      const state = visitStateWords(v);
      const left = visitEnd(v);
      const span = left !== null ? ` to ${clock(left)}, ${placed(v.meta.start) || placed(v.meta.end) ? "about " : ""}${duration(left - v.enteredAt)}` : "";
      const name = `${visitWords(v)}${v.visitId ? ` (visit ${v.visitId})` : ""}, round ${visitRound(v)}, ${state}, ${clock(v.enteredAt)}${span}, ${plural(inVisit.length, "agent")}`;
      items.push({ t: v.enteredAt, node: { id: vid, ref: ref.station(v.station, cell.ticketId), kind: "visit", level: xLevel + 1, parent: xid, children: kids, name, ticketId: cell.ticketId, data: { kind: "visit", visit: v, index: i, occurrence, agents: inVisit } } });
    }
    for (const g of gatesByExec.get(x.id) ?? []) {
      items.push({ t: g.openedAt + 0.5, node: leaf(`g:${g.id}`, ref.gate(g.id), "gate", xLevel + 1, xid, `${GATE_WORDS[g.gate]}${g.round ? ` round ${g.round}` : ""}: ${gateWords(g)}${g.reasonCode && g.state !== "overridden" && g.state !== "failed" ? `, reason ${g.reasonCode}` : ""}${g.decidedAt !== null ? ` at ${clock(g.decidedAt)}` : ""}. ${g.detail}`, cell.ticketId, { kind: "gate", gate: g }) });
    }
    items.sort((a, b) => a.t - b.t);
    const relayAgents = own.filter((a) => !claimed.has(a.id));
    const kids: TreeNode[] = [];
    if (relayAgents.length) {
      const rid = `r:${x.id}`;
      kids.push({ id: rid, ref: ref.execution(x.id), kind: "relay", level: xLevel + 1, parent: xid, children: relayAgents.map((a) => agentNode(a, cell, rid, xLevel + 2)), name: `Belt relay: ${plural(relayAgents.length, "clerk")} asking run.py what is next`, ticketId: cell.ticketId, data: { kind: "relay", execution: x, agents: relayAgents } });
    }
    for (const i of items) kids.push(i.node);
    const activity = activityOf(scene, ref.execution(x.id));
    const state = `${activity.label ? activity.label.toLowerCase() : activityWords(activity.state)}${x.state === "completed" && x.outcome?.waitingFor ? `, waiting for ${x.outcome.waitingFor}` : ""}`;
    const span = execSpan(x);
    const name = `Execution ${xi + 1} of ${executions.length}, ${x.workflow ?? "workflow"}, ${state}, started ${clock(span.start)}${span.end !== null ? `, ended ${clock(span.end)}` : ""}`;
    children.push({ id: xid, ref: ref.execution(x.id), kind: "execution", level: xLevel, parent: laneId, children: kids, name, ticketId: cell.ticketId, data: { kind: "execution", execution: x, index: xi, count: executions.length } });
  });
  // A title or risk the history does not hold is said to be not recorded, never read from a placeholder.
  const title = isKnown(slice.meta, "title") ? slice.title : "Title not recorded";
  const risk = isKnown(cell.meta, "risk") ? `${cell.risk} risk` : isKnown(slice.meta, "risk") ? `${slice.risk} risk` : "risk not recorded";
  const notices = laneNotices(scene, cell);
  const name = `${title}, ${cell.ticketId}, ${slice.id}, ${risk}, ${stageWords(cell.stage)}${cell.round > 1 ? `, round ${cell.round} of 3` : ""}${notices.length ? `; ${notices.map((n) => n.words).join("; ")}` : ""}`;
  return { id: laneId, ref: ref.cell(cell.ticketId), kind: "slice", level, parent, children, name, ticketId: cell.ticketId, data: { kind: "slice", slice, cell } };
}

export interface LaneNotice {
  readonly kind: "wait" | "refused" | "overridden";
  /** Short, for the gutter line. */
  readonly short: string;
  /** Full, for names. */
  readonly words: string;
  readonly at: number;
}

/**
 * Recorded facts the flow has no mark for: a wait for an execution place (capacity.wait_changed), gate
 * refusals no gate state stands for (gateRefusals: build.start, verify.start, merge.run...), grouped by
 * gate and reason, and overrides with no gate state (frozen-tests). Oldest first.
 */
export function laneNotices(scene: Scene, cell: CellState | null, ticketId = cell?.ticketId ?? ""): LaneNotice[] {
  const out: LaneNotice[] = [];
  const wait = capacityWaitOf(scene, ticketId);
  if (wait) out.push({ kind: "wait", short: `waits for an execution place since ${clock(wait.since)}${wait.limit !== null ? ` · at most ${wait.limit}` : ""}`, words: `waits for an execution place since ${clock(wait.since)}${wait.limit !== null ? `, at most ${wait.limit} at once` : ""}`, at: wait.since });
  if (cell) {
    const groups = new Map<string, { gate: string; reason: string | null; count: number; last: number }>();
    for (const r of gateRefusals(scene, ticketId)) {
      const key = `${r.gate}|${r.reasonCode ?? ""}`;
      const g = groups.get(key);
      if (g) {
        g.count += 1;
        g.last = Math.max(g.last, r.at);
      } else groups.set(key, { gate: r.gate, reason: r.reasonCode, count: 1, last: r.at });
    }
    for (const g of groups.values()) out.push({ kind: "refused", short: `refused ${g.gate}${g.reason ? ` · ${g.reason}` : ""}${g.count > 1 ? ` ×${g.count}` : ""} · ${clock(g.last)}`, words: `refused at ${g.gate}${g.reason ? ` (${g.reason})` : ""}${g.count > 1 ? ` ${g.count} times` : ""}, last at ${clock(g.last)}`, at: g.last });
    for (const o of gateOverrides(scene, ticketId)) {
      if (o.gateId !== null) continue;
      out.push({ kind: "overridden", short: `overridden ${o.gate}${o.reasonCode ? ` · ${o.reasonCode}` : ""} · ${clock(o.at)}`, words: `${o.gate} overridden${o.reasonCode ? ` (${o.reasonCode})` : ""} at ${clock(o.at)}`, at: o.at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The lane of a slice that has no cell yet: its dependencies, and why it waits. */
function waitingLane(scene: Scene, slice: SliceState, deps: readonly DependencyState[], wid: string): TreeNode {
  const laneId = `s:${slice.id}`;
  const kids = deps.map((dep) => leaf(`d:${dep.id}`, ref.dependency(dep.from, dep.to), "dependency", 3, laneId, `Waits for ${dep.to}: ${dep.state === "satisfied" ? `satisfied at ${clock(dep.satisfiedAt ?? 0)}` : "blocking"}`, slice.ticketId, { kind: "dependency", dep }));
  const wait = laneNotices(scene, null, slice.ticketId)[0];
  return { id: laneId, ref: ref.slice(slice.id), kind: "slice", level: 2, parent: wid, children: kids, name: `${isKnown(slice.meta, "title") ? slice.title : "Title not recorded"}, ${slice.id}, ${isKnown(slice.meta, "risk") ? `${slice.risk} risk` : "risk not recorded"}, ${slice.scheduler.replace(/-/g, " ")}${slice.reasons[0] ? `: ${slice.reasons[0]}` : ""}${wait ? `; ${wait.words}` : ""}`, ticketId: slice.ticketId, data: { kind: "slice", slice, cell: null } };
}

/** The wave a lane stands under for slices and cells the history never placed in a wave. */
const UNPLACED_WAVE = "(wave not recorded)";

const unplacedWaves = new WeakMap<Scene, WaveState>();
function unplacedWave(scene: Scene): WaveState {
  let w = unplacedWaves.get(scene);
  if (!w) {
    w = { id: UNPLACED_WAVE, title: "Wave not recorded", epicTitle: "", revision: null, sliceIds: [], approvedBy: "not recorded", approvedAt: "", state: "discovered", discoveredAt: 0, seq: 0, meta: { ...SIM_META, authority: "reconstructed", unknown: ["title", "approvedBy", "approvedAt", "discoveredAt"], start: "unknown", end: "unknown" } };
    unplacedWaves.set(scene, w);
  }
  return w;
}

/** A slice the history has not described, for a cell seen without one (history begun part-way). */
const standIns = new WeakMap<CellState, SliceState>();
function standInSlice(cell: CellState): SliceState {
  let s = standIns.get(cell);
  if (!s) {
    s = { id: cell.sliceId || cell.ticketId, title: cell.title, summary: "", waveId: "", revision: null, risk: cell.risk, ticketId: cell.ticketId, dependsOn: [], scheduler: "dispatched", reasons: [], since: cell.openedAt, integratedCommit: null, history: [], meta: { ...cell.meta, unknown: [...cell.meta.unknown, "waveId", "scheduler"] } };
    standIns.set(cell, s);
  }
  return s;
}

export function buildTree(scene: Scene): Tree {
  const byId = new Map<string, TreeNode>();
  const byRef = new Map<EntityRef, string[]>();
  const waves = Object.values(scene.waves);
  if (!waves.length && !Object.keys(scene.slices).length && !Object.keys(scene.cells).length) return { roots: [], byId, byRef };
  const gatesByTicket = new Map<string, GateState[]>();
  for (const g of Object.values(scene.gates)) {
    let list = gatesByTicket.get(g.ticketId);
    if (!list) gatesByTicket.set(g.ticketId, (list = []));
    list.push(g);
  }
  const execsByTicket = new Map<string, ExecutionState[]>();
  for (const x of Object.values(scene.executions)) {
    let list = execsByTicket.get(x.ticketId);
    if (!list) execsByTicket.set(x.ticketId, (list = []));
    list.push(x);
  }
  // Which wave each slice stands under: its own, else the wave that lists it, else none recorded.
  const lanesOf = new Map<string, SliceState[]>();
  const add = (waveId: string, slice: SliceState): void => {
    let list = lanesOf.get(waveId);
    if (!list) lanesOf.set(waveId, (list = []));
    list.push(slice);
  };
  const placed = new Set<string>();
  for (const slice of Object.values(scene.slices)) {
    const owner = scene.waves[slice.waveId] ? slice.waveId : (waves.find((w) => w.sliceIds.includes(slice.id))?.id ?? UNPLACED_WAVE);
    add(owner, slice);
    placed.add(slice.ticketId);
  }
  // A cell with no slice in the scene stands where the scene says it stands (cellHome): under the wave
  // that lists its slice when one does, else under "wave not recorded".
  for (const cell of Object.values(scene.cells)) {
    if (placed.has(cell.ticketId) || scene.slices[cell.sliceId]) continue;
    const home = cellHome(scene, cell.ticketId);
    add(home.waveId !== null && scene.waves[home.waveId] ? home.waveId : UNPLACED_WAVE, standInSlice(cell));
  }
  const ordered = lanesOf.has(UNPLACED_WAVE) ? [...waves, unplacedWave(scene)] : waves;
  const roots: TreeNode[] = [];
  for (const wave of ordered) {
    const wid = `w:${wave.id}`;
    const lanes: TreeNode[] = [];
    for (const slice of lanesOf.get(wave.id) ?? []) {
      const deps = Object.values(scene.dependencies).filter((d) => d.from === slice.id);
      const cell = scene.cells[slice.ticketId] ?? null;
      if (!cell) {
        lanes.push(waitingLane(scene, slice, deps, wid));
        continue;
      }
      const executions = (execsByTicket.get(cell.ticketId) ?? []).sort((a, b) => a.claimedAt - b.claimedAt);
      const gates = (gatesByTicket.get(cell.ticketId) ?? []).sort((a, b) => a.openedAt - b.openedAt || a.seq - b.seq);
      const cached = cellCache.get(slice);
      const wait = capacityWaitOf(scene, cell.ticketId);
      if (cached && cached.cell === cell && cached.parent === wid && cached.wait === wait && sameList(cached.executions, executions) && sameList(cached.deps, deps) && sameList(cached.gates, gates)) {
        lanes.push(cached.node);
        continue;
      }
      const node = buildCellWithGates(scene, slice, cell, executions, deps, gates, wid);
      cellCache.set(slice, { cell, executions, deps, gates, wait, parent: wid, node });
      lanes.push(node);
    }
    const count = lanes.length;
    roots.push({ id: wid, ref: ref.wave(wave.id), kind: "wave", level: 1, parent: null, children: lanes, name: `Wave ${wave.id}, ${wave.title}, ${plural(count, "slice")}`, ticketId: null, data: { kind: "wave", wave } });
  }
  const walk = (n: TreeNode): void => {
    byId.set(n.id, n);
    let list = byRef.get(n.ref);
    if (!list) byRef.set(n.ref, (list = []));
    list.push(n.id);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return { roots, byId, byRef };
}

/** Gates are assigned to the execution whose window contains the moment they opened. */
function buildCellWithGates(scene: Scene, slice: SliceState, cell: CellState, executions: readonly ExecutionState[], deps: readonly DependencyState[], gates: readonly GateState[], parent: string): TreeNode {
  const memo = new Map<string, GateState[]>();
  for (const g of gates) {
    const x = executionAt(executions, g.openedAt);
    if (!x) continue;
    let list = memo.get(x.id);
    if (!list) memo.set(x.id, (list = []));
    list.push(g);
  }
  return buildCell(scene, slice, cell, executions, deps, memo, 2, parent);
}

const treeCache = new WeakMap<Scene, Tree>();

/** The tree for a scene, cached on the scene object (the same object for every t between two events). */
export function treeOf(scene: Scene): Tree {
  let tree = treeCache.get(scene);
  if (!tree) treeCache.set(scene, (tree = buildTree(scene)));
  return tree;
}

/** Ancestors of a node, root first, not including the node. */
export function ancestors(tree: Tree, id: string): string[] {
  const out: string[] = [];
  let cur = tree.byId.get(id)?.parent ?? null;
  while (cur) {
    out.unshift(cur);
    cur = tree.byId.get(cur)?.parent ?? null;
  }
  return out;
}

/** The tree node that stands for an entity ref (the latest one, for a station visited more than once). */
export function nodeForRef(tree: Tree, entity: EntityRef): string | null {
  const ids = tree.byRef.get(entity);
  if (ids && ids.length) {
    // Prefer a node that is not the relay (an execution ref names both the execution and its relay).
    const exact = ids.filter((i) => !i.startsWith("r:"));
    return (exact[exact.length - 1] ?? ids[ids.length - 1]) as string;
  }
  // A slice ref for a slice that has a cell, or a cell ref for a slice lane.
  if (entity.startsWith("slice:")) return tree.byId.has(`s:${entity.slice(6)}`) ? `s:${entity.slice(6)}` : null;
  return null;
}

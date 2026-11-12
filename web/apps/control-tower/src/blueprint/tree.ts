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
 */
import type { AgentState, ArtifactState, CellState, DependencyState, EntityRef, ExecutionState, FindingState, GateState, Scene, SliceState, StationVisit, ToolCallState, WaveState } from "../sim";
import { ref } from "../sim";
import { agentWords, GATE_WORDS, modelWord, stageWords, visitWords } from "./vocab";
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
  readonly root: TreeNode | null;
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
  readonly executions: readonly ExecutionState[];
  readonly deps: readonly DependencyState[];
  readonly gates: readonly GateState[];
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
  for (const call of agent.toolCalls) {
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
  const status = agent.status === "running" ? "working" : agent.status === "error" ? "failed" : `finished in ${duration((agent.finishedAt ?? agent.startedAt) - agent.startedAt)}`;
  const name = `${agentWords(agent)}, ${modelWord(agent.model)}, ${status}, ${plural(agent.toolCalls.length, "tool call")}`;
  return { id, ref: ref.agent(agent.id), kind: "agent", level, parent, children: kids, name, ticketId: cell.ticketId, data: { kind: "agent", agent } };
}

function buildCell(slice: SliceState, cell: CellState, executions: readonly ExecutionState[], deps: readonly DependencyState[], gatesByExec: ReadonlyMap<string, readonly GateState[]>, level: number, parent: string): TreeNode {
  const laneId = `s:${slice.id}`;
  const children: TreeNode[] = [];
  for (const dep of deps) children.push(leaf(`d:${dep.id}`, ref.dependency(dep.from, dep.to), "dependency", level + 1, laneId, `Waits for ${dep.to}: ${dep.state === "satisfied" ? `satisfied at ${clock(dep.satisfiedAt ?? 0)}` : "blocking"}`, cell.ticketId, { kind: "dependency", dep }));
  // Artifacts no agent wrote (intake, cell.py finalize, review.py approve-human) belong to the cell.
  for (const a of cell.artifacts) {
    if (a.writer.agentId) continue;
    children.push(leaf(`af:${a.id}`, ref.artifact(a.id), "artifact", level + 1, laneId, `Artifact ${a.label}, written by ${a.writer.script ?? "a script"} at ${clock(a.writtenAt)}`, cell.ticketId, { kind: "artifact", artifact: a }));
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
      const state = v.outcome ?? (v.station === "human-approval" ? "waiting" : "running");
      const name = `${visitWords(v)}, round ${v.action === "revise" ? v.round + 1 : v.round}, ${state}, ${clock(v.enteredAt)}${v.leftAt !== null ? ` to ${clock(v.leftAt)}, ${duration(v.leftAt - v.enteredAt)}` : ""}, ${plural(inVisit.length, "agent")}`;
      items.push({ t: v.enteredAt, node: { id: vid, ref: ref.station(v.station, cell.ticketId), kind: "visit", level: xLevel + 1, parent: xid, children: kids, name, ticketId: cell.ticketId, data: { kind: "visit", visit: v, index: i, occurrence, agents: inVisit } } });
    }
    for (const g of gatesByExec.get(x.id) ?? []) {
      items.push({ t: g.openedAt + 0.5, node: leaf(`g:${g.id}`, ref.gate(g.id), "gate", xLevel + 1, xid, `${GATE_WORDS[g.gate]}${g.round ? ` round ${g.round}` : ""}: ${g.state}${g.decidedAt !== null ? ` at ${clock(g.decidedAt)}` : ""}. ${g.detail}`, cell.ticketId, { kind: "gate", gate: g }) });
    }
    items.sort((a, b) => a.t - b.t);
    const relayAgents = own.filter((a) => !claimed.has(a.id));
    const kids: TreeNode[] = [];
    if (relayAgents.length) {
      const rid = `r:${x.id}`;
      kids.push({ id: rid, ref: ref.execution(x.id), kind: "relay", level: xLevel + 1, parent: xid, children: relayAgents.map((a) => agentNode(a, cell, rid, xLevel + 2)), name: `Belt relay: ${plural(relayAgents.length, "clerk")} asking run.py what is next`, ticketId: cell.ticketId, data: { kind: "relay", execution: x, agents: relayAgents } });
    }
    for (const i of items) kids.push(i.node);
    const state = x.state === "running" ? "running" : x.state === "completed" ? `completed${x.outcome?.waitingFor ? `, waiting for ${x.outcome.waitingFor}` : ""}` : x.state;
    const name = `Execution ${xi + 1} of ${executions.length}, ${x.workflow ?? "workflow"}, ${state}, started ${clock(x.startedAt ?? x.claimedAt)}${x.endedAt !== null ? `, ended ${clock(x.endedAt)}` : ""}`;
    children.push({ id: xid, ref: ref.execution(x.id), kind: "execution", level: xLevel, parent: laneId, children: kids, name, ticketId: cell.ticketId, data: { kind: "execution", execution: x, index: xi, count: executions.length } });
  });
  const name = `${slice.title}, ${cell.ticketId}, ${slice.id}, ${slice.risk} risk, ${stageWords(cell.stage)}${cell.round > 1 ? `, round ${cell.round} of 3` : ""}`;
  return { id: laneId, ref: ref.cell(cell.ticketId), kind: "slice", level, parent, children, name, ticketId: cell.ticketId, data: { kind: "slice", slice, cell } };
}

export function buildTree(scene: Scene): Tree {
  const byId = new Map<string, TreeNode>();
  const byRef = new Map<EntityRef, string[]>();
  const wave = Object.values(scene.waves)[0];
  if (!wave) return { root: null, byId, byRef };
  const wid = `w:${wave.id}`;
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
  const lanes: TreeNode[] = [];
  for (const sliceId of wave.sliceIds) {
    const slice = scene.slices[sliceId];
    if (!slice) continue;
    const deps = Object.values(scene.dependencies).filter((d) => d.from === sliceId);
    const cell = scene.cells[slice.ticketId] ?? null;
    if (!cell) {
      const laneId = `s:${slice.id}`;
      const kids = deps.map((dep) => leaf(`d:${dep.id}`, ref.dependency(dep.from, dep.to), "dependency", 3, laneId, `Waits for ${dep.to}: ${dep.state === "satisfied" ? `satisfied at ${clock(dep.satisfiedAt ?? 0)}` : "blocking"}`, slice.ticketId, { kind: "dependency", dep }));
      lanes.push({ id: laneId, ref: ref.slice(slice.id), kind: "slice", level: 2, parent: wid, children: kids, name: `${slice.title}, ${slice.id}, ${slice.risk} risk, ${slice.scheduler.replace(/-/g, " ")}${slice.reasons[0] ? `: ${slice.reasons[0]}` : ""}`, ticketId: slice.ticketId, data: { kind: "slice", slice, cell: null } });
      continue;
    }
    const executions = (execsByTicket.get(cell.ticketId) ?? []).sort((a, b) => a.claimedAt - b.claimedAt);
    const gates = (gatesByTicket.get(cell.ticketId) ?? []).sort((a, b) => a.openedAt - b.openedAt || a.seq - b.seq);
    const cached = cellCache.get(slice);
    if (cached && cached.cell === cell && sameList(cached.executions, executions) && sameList(cached.deps, deps) && sameList(cached.gates, gates)) {
      lanes.push(cached.node);
      continue;
    }
    const node = buildCellWithGates(slice, cell, executions, deps, gates, wid);
    cellCache.set(slice, { cell, executions, deps, gates, node });
    lanes.push(node);
  }
  const root: TreeNode = { id: wid, ref: ref.wave(wave.id), kind: "wave", level: 1, parent: null, children: lanes, name: `Wave ${wave.id}, ${wave.title}, ${plural(wave.sliceIds.length, "slice")}`, ticketId: null, data: { kind: "wave", wave } };
  const walk = (n: TreeNode): void => {
    byId.set(n.id, n);
    let list = byRef.get(n.ref);
    if (!list) byRef.set(n.ref, (list = []));
    list.push(n.id);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return { root, byId, byRef };
}

/** Gates are assigned to the execution whose window contains the moment they opened. */
function buildCellWithGates(slice: SliceState, cell: CellState, executions: readonly ExecutionState[], deps: readonly DependencyState[], gates: readonly GateState[], parent: string): TreeNode {
  const memo = new Map<string, GateState[]>();
  for (const g of gates) {
    const x = executionAt(executions, g.openedAt);
    if (!x) continue;
    let list = memo.get(x.id);
    if (!list) memo.set(x.id, (list = []));
    list.push(g);
  }
  return buildCell(slice, cell, executions, deps, memo, 2, parent);
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

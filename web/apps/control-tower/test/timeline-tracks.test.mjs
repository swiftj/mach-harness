// The Execution Timeline's track model (src/timeline/tracks, design section 4): both groupings,
// identity across rebuilds, filters, lane packing, tracksOf, row layout, and scale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import "./_load.mjs";
import { span, at, changed, lcg } from "./fixtures/spans.mjs";

const tracks = await import("../src/timeline/tracks/index.ts");
const buildModule = await import("../src/timeline/tracks/build.ts");
const contract = await import("../src/timeline/contract.ts");
const { buildTrackTree, layoutRows, defaultExpanded } = tracks;
const { NO_FILTERS, extentOf, ROW_HEIGHT } = contract;

// ---------------------------------------------------------------- the hand-written fixture
//
// Two waves. W1: slices S1 (cell T1) and S2 (cell T2). W2: slice S3 (cell T3) and slice S4, which
// waits on S3 and has no cell yet. T9 is a cell with no slice. T1 is retried through rounds 1 to 3 by
// two executions, E1 and E2, whose boundary falls inside round 2; it ends waiting on a person. T2 waited
// on a dependency and on capacity, and its execution E3 is still running with parallel agents, one of
// them count-only. T3's execution E4 has 30 agents (lanes, not nodes).

const LIVE = at(600);
const cellIds = (t, s) => (s ? { ticket_id: t, slice_id: s } : { ticket_id: t });

function visit(t, s, station, n, from, to, x, extra = {}) {
  const id = `${t}/${station}#${n}`;
  return span({
    kind: "visit",
    entity: `visit:${id}`,
    parent: x ? `execution:${x}` : null,
    ids: { ...cellIds(t, s), visit_id: id, station, ...(extra.round ? { round: String(extra.round) } : {}), ...(x ? { execution_id: x } : {}) },
    start: from,
    end: to,
    outcome: extra.outcome ?? "ok",
    reason: extra.reason ?? "completed",
  });
}

function execution(x, t, attempt, from, to, reason = "completed") {
  const ids = { execution_id: x, ticket_id: t, attempt: String(attempt) };
  return [
    span({ kind: "claim", entity: `execution:${x}`, parent: `cell:${t}`, ids, start: from - 0.5 * 60_000, end: from }),
    span({ kind: "execution", entity: `execution:${x}`, parent: `cell:${t}`, ids, start: from, end: to, outcome: to ? "completed" : null, reason }),
  ];
}

function seat(t, s, round, name, from, to, vote) {
  return span({ kind: "seat", entity: `seat:${t}/review#${round}/${name}`, parent: `gate:${t}/review#${round}`, ids: { ...cellIds(t, s), round: String(round), seat: name }, start: from, end: to, outcome: vote, attrs: { model: "opus" } });
}

function agent(x, wf, name, queued, started, finished, attrs = {}) {
  const ids = { execution_id: x, agent_id: `${x}-${name}` };
  const entity = `agent:${x}-${name}`;
  const out = [];
  if (queued !== null) out.push(span({ kind: "agent-queue", entity, parent: wf, ids, start: queued, end: started }));
  out.push(span({ kind: "agent", entity, parent: wf, ids, start: started, end: finished, outcome: finished ? "done" : null, attrs: { label: name, model: "sonnet", ...attrs } }));
  return out;
}

function tool(x, parent, n, from, to) {
  return span({ kind: "tool", entity: `tool:${x}-tc${n}`, parent, ids: { execution_id: x, tool_call_id: `${x}-tc${n}` }, start: from, end: to, outcome: "ok" });
}

function fixture() {
  const out = [];
  // Waves and slices.
  out.push(span({ kind: "wave", entity: "wave:W1", ids: { wave_id: "W1" }, start: at(0), end: null }));
  out.push(span({ kind: "wave", entity: "wave:W2", ids: { wave_id: "W2" }, start: at(5), end: null }));
  out.push(span({ kind: "slice-eligible", entity: "slice:S1", parent: "slice:S1", ids: { slice_id: "S1", wave_id: "W1", ticket_id: "T1" }, start: at(1), end: at(2) }));
  out.push(span({ kind: "slice-wait", entity: "slice:S2", parent: "slice:S2", ids: { slice_id: "S2", wave_id: "W1", ticket_id: "T2" }, start: at(1), end: at(40), attrs: { dependsOn: ["S1"] } }));
  out.push(span({ kind: "capacity-wait", entity: "slice:S2", parent: "slice:S2", ids: { slice_id: "S2", wave_id: "W1", ticket_id: "T2" }, start: at(40), end: at(55), attrs: { reasons: ["max_parallel"] } }));
  out.push(span({ kind: "slice-eligible", entity: "slice:S3", parent: "slice:S3", ids: { slice_id: "S3", wave_id: "W2", ticket_id: "T3" }, start: at(6), end: at(7) }));
  out.push(span({ kind: "slice-wait", entity: "slice:S4", parent: "slice:S4", ids: { slice_id: "S4", wave_id: "W2", ticket_id: "" }, start: at(6), end: null, attrs: { dependsOn: ["S3"] } }));

  // T1: three rounds, two executions, a person wait still open.
  out.push(span({ kind: "cell", entity: "cell:T1", ids: cellIds("T1", "S1"), start: at(2), end: null }));
  out.push(span({ kind: "round", entity: "gate:T1/round#1", parent: "cell:T1", ids: { ...cellIds("T1", "S1"), round: "1" }, start: at(20), end: at(60), outcome: "REJECTED", reason: "failed" }));
  out.push(span({ kind: "round", entity: "gate:T1/round#2", parent: "cell:T1", ids: { ...cellIds("T1", "S1"), round: "2" }, start: at(61), end: at(110), outcome: "FAIL_WITH_EVIDENCE", reason: "failed" }));
  out.push(span({ kind: "round", entity: "gate:T1/round#3", parent: "cell:T1", ids: { ...cellIds("T1", "S1"), round: "3" }, start: at(111), end: at(170), outcome: "APPROVED" }));
  out.push(visit("T1", "S1", "groom", 1, at(2), at(8)));
  out.push(visit("T1", "S1", "plan", 1, at(8), at(14)));
  out.push(visit("T1", "S1", "audit", 1, at(14), at(16)));
  out.push(visit("T1", "S1", "build", 1, at(20), at(40), "E1", { round: 1 }));
  out.push(span({ kind: "task", entity: "visit:T1/build#1/task:t1#red", parent: "visit:T1/build#1", ids: { ...cellIds("T1", "S1"), visit_id: "T1/build#1", task_id: "t1", round: "1" }, start: { at: at(20), basis: "inferred", rule: "previous-completion" }, end: at(30) }));
  out.push(span({ kind: "task", entity: "visit:T1/build#1/task:t2#green", parent: "visit:T1/build#1", ids: { ...cellIds("T1", "S1"), visit_id: "T1/build#1", task_id: "t2", round: "1" }, start: { at: at(30), basis: "inferred", rule: "previous-completion" }, end: at(40) }));
  out.push(visit("T1", "S1", "verify", 1, at(40), at(45), "E1", { round: 1 }));
  out.push(span({ kind: "task", entity: "visit:T1/verify#1/task:ac1#checked", parent: "visit:T1/verify#1", ids: { ...cellIds("T1", "S1"), visit_id: "T1/verify#1", task_id: "ac1", round: "1" }, start: at(40), end: at(44) }));
  out.push(visit("T1", "S1", "review", 1, at(45), at(60), "E1", { round: 1, outcome: "REJECTED" }));
  out.push(seat("T1", "S1", 1, "architecture", at(45), at(58), "approve"));
  out.push(seat("T1", "S1", 1, "security", at(45), at(59), "reject"));
  out.push(seat("T1", "S1", 1, "product", at(45), at(57), "approve"));
  out.push(visit("T1", "S1", "build", 2, at(61), at(85), "E1", { round: 2 }));
  out.push(visit("T1", "S1", "verify", 2, at(90), at(110), "E2", { round: 2, outcome: "FAIL_WITH_EVIDENCE" }));
  out.push(visit("T1", "S1", "build", 3, at(111), at(140), "E2", { round: 3 }));
  out.push(visit("T1", "S1", "verify", 3, at(140), at(150), "E2", { round: 3 }));
  out.push(visit("T1", "S1", "review", 3, at(150), at(170), "E2", { round: 3, outcome: "APPROVED" }));
  out.push(seat("T1", "S1", 3, "architecture", at(150), at(165), "approve"));
  out.push(seat("T1", "S1", 3, "security", at(150), at(166), "approve"));
  out.push(seat("T1", "S1", 3, "product", at(150), at(168), "approve"));
  out.push(span({ kind: "gate-wait", entity: "gate:T1/approval:T1#3", parent: "cell:T1", ids: { ...cellIds("T1", "S1"), round: "3" }, start: at(170), end: at(175), outcome: "person" }));
  out.push(span({ kind: "person-wait", entity: "gate:T1/required:ev-77", parent: "cell:T1", ids: cellIds("T1", "S1"), start: at(180), end: null }));
  // E1 runs from round 1 into round 2 (the boundary at 60/61 falls inside it); E2 picks up in round 2.
  out.push(...execution("E1", "T1", 1, at(19), at(88), "interrupted"));
  out.push(...execution("E2", "T1", 2, at(89), at(171)));

  // T2: a visit with only an end recorded; E3 still running with parallel and count-only agents.
  out.push(span({ kind: "cell", entity: "cell:T2", ids: cellIds("T2", "S2"), start: at(55), end: null }));
  out.push(span({ kind: "visit", entity: "visit:T2/groom#1", ids: { ...cellIds("T2", "S2"), visit_id: "T2/groom#1", station: "groom" }, start: null, end: at(58), outcome: "ok" }));
  out.push(visit("T2", "S2", "build", 1, at(60), null, "E3", { round: 1 }));
  out.push(...execution("E3", "T2", 1, at(59), null));
  out.push(span({ kind: "workflow", entity: "workflow:E3/belt", parent: "execution:E3", ids: { execution_id: "E3", ticket_id: "T2", attempt: "1" }, start: at(60), end: null, attrs: { label: "mach-belt" } }));
  out.push(...agent("E3", "workflow:E3/belt", "builder", at(60), at(61), at(80)));
  out.push(...agent("E3", "workflow:E3/belt", "verifier", at(60), at(62), at(78)));
  out.push(...agent("E3", "workflow:E3/belt", "reviewer", null, at(65), null));
  out.push(...agent("E3", "workflow:E3/belt", "counted", at(63), at(64), at(90), { toolsCountOnly: true, toolCalls: 7 }));
  out.push(tool("E3", "agent:E3-builder", 1, at(62), at(63)));
  out.push(tool("E3", "agent:E3-builder", 2, at(62.5), at(64)));
  out.push(tool("E3", "execution:E3", 3, at(59.5), at(59.6)));

  // T3: E4 with 30 agents, more than one node each.
  out.push(span({ kind: "cell", entity: "cell:T3", ids: cellIds("T3", "S3"), start: at(7), end: at(300), outcome: "merged" }));
  out.push(visit("T3", "S3", "build", 1, at(10), at(200), "E4", { round: 1, outcome: "error", reason: "failed" }));
  out.push(...execution("E4", "T3", 1, at(9), at(210), "failed"));
  out.push(span({ kind: "workflow", entity: "workflow:E4/belt", parent: "execution:E4", ids: { execution_id: "E4", ticket_id: "T3", attempt: "1" }, start: at(10), end: at(205) }));
  for (let i = 0; i < 30; i++) {
    const q = at(10 + (i % 7) * 3);
    out.push(...agent("E4", "workflow:E4/belt", `a${String(i).padStart(2, "0")}`, q, q + 30_000, q + 30_000 + ((i * 37) % 11) * 60_000 + 60_000));
  }

  // T9: no slice, no wave.
  out.push(span({ kind: "cell", entity: "cell:T9", ids: { ticket_id: "T9" }, start: at(3), end: null }));
  out.push(visit("T9", null, "build", 1, at(4), at(9)));
  return out;
}

const ids = (nodes) => nodes.map((n) => n.id);
const walk = (nodes, fn) => {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
};
const allNodes = (tree) => {
  const out = [];
  walk(tree.roots, (n) => out.push(n));
  return out;
};
const pathTo = (tree, id) => {
  const out = [];
  for (let n = tree.byId.get(id); n; n = n.parentId ? tree.byId.get(n.parentId) : undefined) out.unshift(n.id);
  return out;
};
/** True when no two units on a lane overlap in time (an agent and its queue are one unit). */
function lanesDisjoint(lanes) {
  for (const lane of lanes) {
    const units = new Map();
    for (const s of lane.spans) {
      const key = s.kind === "agent" || s.kind === "agent-queue" ? s.entity : s.id;
      const x = extentOf(s);
      if (!x) continue;
      const u = units.get(key);
      units.set(key, u ? { from: Math.min(u.from, x.from), to: Math.max(u.to, x.to) } : { ...x });
    }
    const list = [...units.values()].sort((a, b) => a.from - b.from);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const prevEnd = prev.to > prev.from ? prev.to : prev.from + 0.5;
      if (list[i].from < prevEnd) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- product grouping

test("product grouping: waves → slices → cells, a sliceless cell and a cell-less slice still appear", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  assert.equal(tree.grouping, "product");
  assert.deepEqual(ids(tree.roots), ["wave:W1", "wave:W2", "factory/unplanned"]);
  assert.deepEqual(ids(tree.byId.get("wave:W1").children), ["slice:S1", "slice:S2"]);
  assert.deepEqual(ids(tree.byId.get("wave:W2").children), ["slice:S3", "slice:S4"]);
  assert.deepEqual(pathTo(tree, "cell:T1"), ["wave:W1", "slice:S1", "cell:T1"]);
  assert.deepEqual(pathTo(tree, "cell:T9"), ["factory/unplanned", "cell:T9"]);
  // S4 has no cell yet: its dependency wait sits on the slice's own waits row.
  assert.deepEqual(ids(tree.byId.get("slice:S4").children), ["slice:S4/waits"]);
  assert.equal(tree.byId.get("slice:S4/waits").lanes[0].spans[0].kind, "slice-wait");
  const cell = tree.byId.get("cell:T1");
  assert.equal(cell.ref, "cell:T1");
  assert.equal(cell.detail, null, "X6: the slice is the parent; its id is not repeated");
  assert.equal(cell.depth, 2);
  assert.equal(cell.lanes[0].spans[0].kind, "cell");
});

test("product grouping: a cell holds rounds, stations in belt order, waits, review seats per round and verification", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  const cell = tree.byId.get("cell:T1");
  assert.deepEqual(ids(cell.children), [
    "cell:T1/rounds",
    "station:T1/groom",
    "station:T1/plan",
    "station:T1/audit",
    "station:T1/build",
    "station:T1/verify",
    "station:T1/review",
    "cell:T1/waits",
    "cell:T1/review",
    "cell:T1/verification",
  ]);
  assert.equal(tree.byId.get("cell:T1/rounds").lanes.length, 1, "rounds are sequential: one lane");
  assert.deepEqual(tree.byId.get("cell:T1/rounds").lanes[0].spans.map((s) => s.attrs.round ?? s.ids.round), ["1", "2", "3"]);
  const build = tree.byId.get("station:T1/build");
  assert.equal(build.kind, "station");
  assert.equal(build.label, "Build");
  assert.deepEqual(build.lanes[0].spans.map((s) => s.entity), ["visit:T1/build#1", "visit:T1/build#2", "visit:T1/build#3"], "visits in sequence");
  assert.equal(build.lanes[1].spans[0].kind, "task", "build tasks on their own lane below the visits");
  assert.equal(tree.byId.get("cell:T1/verification").lanes[0].spans[0].entity, "visit:T1/verify#1/task:ac1#checked");
  // Waits: an approval wait and a person wait, distinct from slice waits of T2 which has a cell.
  assert.deepEqual(tree.byId.get("cell:T1/waits").lanes.flatMap((l) => l.spans.map((s) => s.kind)).sort(), ["gate-wait", "person-wait", "slice-eligible"]);
  assert.deepEqual(tree.byId.get("cell:T2/waits").lanes.flatMap((l) => l.spans.map((s) => s.kind)), ["slice-wait", "capacity-wait"]);
  // One row per seat per round, round 1 before round 3.
  assert.deepEqual(ids(tree.byId.get("cell:T1/review").children), [
    "seat:T1/review#1/architecture",
    "seat:T1/review#1/product",
    "seat:T1/review#1/security",
    "seat:T1/review#3/architecture",
    "seat:T1/review#3/product",
    "seat:T1/review#3/security",
  ]);
  assert.equal(tree.byId.get("seat:T1/review#1/security").label, "R1 security");
  assert.equal(tree.byId.get("seat:T1/review#1/security").detail, "opus");
});

test("product grouping: executions are ribbons on the cell, never rows; rounds and attempts are not nested", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  const cell = tree.byId.get("cell:T1");
  assert.deepEqual(cell.ribbons.map((s) => s.entity), ["execution:E1", "execution:E2"]);
  for (const n of allNodes(tree)) {
    assert.ok(!["execution", "claim", "workflow", "agents", "agent", "tools"].includes(n.kind), `${n.id} is ${n.kind}`);
    for (const lane of n.lanes) for (const s of lane.spans) assert.ok(!["execution", "claim", "agent", "tool", "workflow", "agent-queue"].includes(s.kind));
  }
  // E1 ends inside round 2: it is still only a ribbon on the cell, and round 2 is not under it.
  assert.ok(cell.ribbons[0].end.at > tree.byId.get("cell:T1/rounds").lanes[0].spans[1].start.at);
});

test("product grouping: attention, counts, unknown starts and open spans", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  assert.equal(tree.byId.get("cell:T1/waits").attention, "person", "an open person wait");
  // X1: a row's attention is its OWN (its latest span's); what failed beneath is counted.
  const rounds = tree.byId.get("cell:T1/rounds");
  const lastRound = rounds.lanes.flatMap((l) => l.spans).sort((a, b) => a.start.at - b.start.at).at(-1);
  assert.equal(rounds.attention, contract.attentionOf(lastRound, LIVE), "the latest round's own condition");
  assert.ok((rounds.counts?.rejected ?? 0) + (rounds.counts?.failed ?? 0) >= 1, "rejected rounds are counted");
  assert.notEqual(tree.byId.get("cell:T1").attention, "failed", "a cell does not wear its rounds' failure");
  assert.ok(tree.byId.get("cell:T1").counts, "the cell counts what happened beneath it");
  assert.equal(tree.byId.get("station:T1/groom").attention, "none");
  assert.equal(tree.byId.get("station:T2/build").attention, "open");
  // A span with only an end recorded still has a place on its station row.
  const groom = tree.byId.get("station:T2/groom");
  assert.equal(groom.lanes[0].spans[0].start, null);
  assert.equal(tree.ofSpan.get("visit:visit:T2/groom#1").trackId, "station:T2/groom");
  const subtree = (n) => n.lanes.reduce((a, l) => a + l.spans.length, 0) + n.children.reduce((a, c) => a + subtree(c), 0);
  for (const n of allNodes(tree)) assert.equal(n.spanCount, subtree(n), n.id);
  // Outcomes after the live edge are not an attention: at an earlier liveAt the rejected round is open.
  const early = buildTrackTree(fixture(), "product", NO_FILTERS, at(50));
  assert.equal(early.byId.get("cell:T1/rounds").attention, "open");
});

// ---------------------------------------------------------------- execution grouping

test("execution grouping: execution → claim → workflow → agents → tools; visits as ribbons", () => {
  const tree = buildTrackTree(fixture(), "execution", NO_FILTERS, LIVE);
  assert.deepEqual(ids(tree.roots), ["execution:E4", "execution:E1", "execution:E3", "execution:E2"], "by start time");
  const e1 = tree.byId.get("execution:E1");
  // X7, recheck R2: the ticket and its run among the cell's executions (short, so it survives the
  // default column); the start and the supervisor's attempt are the detail.
  assert.equal(e1.label, "T1 · run 1/2");
  assert.equal(e1.detail, "from 09:19 · supervisor attempt 1");
  assert.equal(tree.byId.get("execution:E2").label, "T1 · run 2/2");
  assert.equal(tree.byId.get("execution:E2").detail, "from 10:29 · supervisor attempt 2");
  assert.equal(e1.attention, "interrupted");
  assert.deepEqual(ids(e1.children), ["execution:E1/claim"]);
  assert.deepEqual(e1.ribbons.map((s) => s.entity), ["visit:T1/build#1", "visit:T1/verify#1", "visit:T1/review#1", "visit:T1/build#2"]);
  const e3 = tree.byId.get("execution:E3");
  assert.deepEqual(ids(e3.children), ["execution:E3/claim", "workflow:E3/belt", "execution:E3/tools"]);
  assert.equal(tree.byId.get("workflow:E3/belt").label, "mach-belt");
  const agents = tree.byId.get("workflow:E3/belt/agents");
  assert.equal(agents.kind, "agents");
  assert.equal(agents.lanes.length, 0, "few agents: one node each");
  assert.deepEqual(ids(agents.children), ["agent:E3-builder", "agent:E3-verifier", "agent:E3-counted", "agent:E3-reviewer"]);
  const builder = tree.byId.get("agent:E3-builder");
  assert.equal(builder.label, "builder");
  assert.equal(builder.detail, "sonnet");
  assert.deepEqual(builder.lanes[0].spans.map((s) => s.kind), ["agent-queue", "agent"], "queue immediately before its agent");
  assert.deepEqual(ids(builder.children), ["agent:E3-builder/tools"]);
  assert.equal(tree.byId.get("agent:E3-builder/tools").lanes.length, 2, "overlapping tool calls take two lanes");
  const counted = tree.byId.get("agent:E3-counted");
  assert.match(counted.note, /7 tool calls, counted, not observable one by one/);
  assert.equal(counted.children.length, 0, "no tool rows for a count-only agent");
  assert.equal(tree.byId.get("execution:E3/tools").lanes[0].spans[0].entity, "tool:E3-tc3", "main-loop calls");
  assert.equal(e3.attention, "open");
  for (const n of allNodes(tree)) assert.ok(!["round", "seat", "rounds", "cell", "wave", "slice", "station"].includes(n.kind), `${n.id} nests product structure`);
});

test("execution grouping: many agents are packed into lanes on the Agents node without overlap", () => {
  const tree = buildTrackTree(fixture(), "execution", NO_FILTERS, LIVE);
  const agents = tree.byId.get("workflow:E4/belt/agents");
  assert.equal(agents.children.length, 0);
  assert.equal(agents.detail, "30 agents");
  assert.ok(agents.lanes.length > 1 && agents.lanes.length < 30, `${agents.lanes.length} lanes`);
  assert.equal(agents.lanes.reduce((a, l) => a + l.spans.length, 0), 60);
  assert.ok(lanesDisjoint(agents.lanes));
  for (const lane of agents.lanes) {
    lane.spans.forEach((s, i) => {
      if (s.kind === "agent-queue") assert.equal(lane.spans[i + 1]?.entity, s.entity, "a queue is followed by its own agent");
    });
  }
  const located = tree.ofSpan.get("agent:agent:E4-a05");
  assert.equal(located.trackId, "workflow:E4/belt/agents");
  assert.equal(tree.ofSpan.get("agent-queue:agent:E4-a05").lane, located.lane);
});

// ---------------------------------------------------------------- identity

test("identity: ids are entity refs or <owner>/<kind>, and do not depend on order or on what else is loaded", () => {
  const spans = fixture();
  const a = buildTrackTree(spans, "product", NO_FILTERS, LIVE);
  const b = buildTrackTree([...spans].reverse(), "product", NO_FILTERS, LIVE);
  const onlyT1 = buildTrackTree(spans.filter((s) => s.ids.ticket_id === "T1" || s.kind === "wave"), "product", NO_FILTERS, LIVE);
  assert.deepEqual([...a.byId.keys()].sort(), [...b.byId.keys()].sort());
  for (const id of onlyT1.byId.keys()) assert.ok(a.byId.has(id), id);
  for (const n of allNodes(a)) assert.match(n.id, /^(wave|slice|cell|station|seat|factory):[^/]|^(cell|slice):[^/]+\/(rounds|waits|review|verification)$|^factory\/(unplanned|waits|unattached)$/, n.id);
  const lanesOf = (t) => allNodes(t).map((n) => [n.id, n.lanes.map((l) => l.spans.map((s) => s.id))]);
  assert.deepEqual(lanesOf(a).sort(), lanesOf(b).sort(), "same lanes whatever the input order");
});

test("identity: a rebuild returns the same node objects for unchanged subtrees", () => {
  const spans = fixture();
  for (const grouping of ["product", "execution"]) {
    const first = buildTrackTree(spans, grouping, NO_FILTERS, LIVE);
    const same = buildTrackTree(spans, grouping, NO_FILTERS, LIVE, first);
    for (const [id, node] of first.byId) assert.equal(same.byId.get(id), node, `${grouping}: ${id}`);
    // Equal content in new objects (a re-query) counts as unchanged too.
    const copies = buildTrackTree(spans.map((s) => ({ ...s })), grouping, NO_FILTERS, LIVE, first);
    for (const r of first.roots) assert.equal(copies.byId.get(r.id), r, `${grouping}: copies of ${r.id}`);
  }
  // One span changes: the builder's agent ends. Only its track and its ancestors are new objects.
  const prev = buildTrackTree(spans, "execution", NO_FILTERS, LIVE);
  const i = spans.findIndex((s) => s.id === "agent:agent:E3-reviewer");
  const next = [...spans];
  next[i] = changed(spans[i], { end: { eventId: "e", at: at(95), precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "completed" }, outcome: "done" });
  const after = buildTrackTree(next, "execution", NO_FILTERS, LIVE, prev);
  const touched = new Set(pathTo(after, "agent:E3-reviewer"));
  for (const [id, node] of prev.byId) {
    if (touched.has(id)) assert.notEqual(after.byId.get(id), node, `${id} changed`);
    else assert.equal(after.byId.get(id), node, `${id} kept`);
  }
  // A different grouping never reuses the previous tree.
  const other = buildTrackTree(spans, "product", NO_FILTERS, LIVE, prev);
  assert.equal(other.grouping, "product");
});

test("identity: the incremental path gives exactly what a full build gives", () => {
  const shape = (tree) =>
    allNodes(tree).map((n) => [n.id, n.parentId, n.depth, n.label, n.detail, n.note, n.attention, n.spanCount, n.lanes.map((l) => l.spans.map((s) => `${s.id}@${s.end?.at ?? "open"}`)), n.ribbons.map((s) => s.id)]);
  for (const grouping of ["product", "execution"]) {
    let spans = fixture();
    let tree = buildTrackTree(spans, grouping, NO_FILTERS, LIVE);
    const steps = [
      // the running reviewer agent ends; the count-only agent's count grows; a tool call arrives; a visit ends
      (list) => list.map((s) => (s.id === "agent:agent:E3-reviewer" ? changed(s, { end: { eventId: null, at: at(96), precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "failed" }, outcome: "error" }) : s)),
      (list) => list.map((s) => (s.id === "agent:agent:E3-counted" ? changed(s, { attrs: { ...s.attrs, toolCalls: 9, label: "counter" } }) : s)),
      (list) => [...list, tool("E3", "agent:E3-verifier", 9, at(70), at(71))],
      (list) => list.map((s) => (s.id === "visit:visit:T2/build#1" ? changed(s, { end: { eventId: null, at: at(99), precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "completed" } }) : s)),
    ];
    for (const step of steps) {
      spans = step(spans);
      tree = buildTrackTree(spans, grouping, NO_FILTERS, LIVE, tree);
      assert.deepEqual(shape(tree), shape(buildTrackTree(spans, grouping, NO_FILTERS, LIVE)), grouping);
    }
    if (grouping === "execution") {
      assert.match(tree.byId.get("agent:E3-counted").note, /^9 tool calls/);
      assert.equal(tree.byId.get("agent:E3-counted").label, "counter");
      assert.equal(tree.byId.get("agent:E3-reviewer").attention, "failed");
      assert.equal(tree.byId.get("agent:E3-verifier/tools").spanCount, 1);
    }
    // Building again from an older tree (its drafts have moved on) still gives the right answer.
    const old = buildTrackTree(fixture(), grouping, NO_FILTERS, LIVE);
    buildTrackTree(steps[0](fixture()), grouping, NO_FILTERS, LIVE, old);
    const fromOld = buildTrackTree(steps[1](fixture()), grouping, NO_FILTERS, LIVE, old);
    assert.deepEqual(shape(fromOld), shape(buildTrackTree(steps[1](fixture()), grouping, NO_FILTERS, LIVE)));
  }
});

// ---------------------------------------------------------------- filters

test("filters: tickets, executions, stations and kinds restrict spans; parents of kept children stay as groups", () => {
  const spans = fixture();
  const t2 = buildTrackTree(spans, "product", { ...NO_FILTERS, tickets: ["T2"] }, LIVE);
  assert.deepEqual(ids(t2.roots), ["wave:W1"]);
  assert.equal(t2.byId.get("wave:W1").lanes.length, 0, "the wave's own span has no ticket: the wave stays as a group");
  assert.deepEqual(ids(t2.byId.get("wave:W1").children), ["slice:S2"]);
  assert.ok(!t2.byId.has("cell:T1"));

  const builds = buildTrackTree(spans, "product", { ...NO_FILTERS, stations: ["build"] }, LIVE);
  for (const n of allNodes(builds)) {
    if (n.kind === "station") assert.match(n.id, /\/build$/);
    if (n.kind === "cell") assert.equal(n.lanes.length, 0, `${n.id} kept as a group`);
  }
  assert.ok(builds.byId.has("station:T9/build"));

  const e4 = buildTrackTree(spans, "execution", { ...NO_FILTERS, executions: ["E4"] }, LIVE);
  assert.deepEqual(ids(e4.roots), ["execution:E4"]);
  const t1Exec = buildTrackTree(spans, "execution", { ...NO_FILTERS, tickets: ["T2"] }, LIVE);
  assert.deepEqual(ids(t1Exec.roots), ["execution:E3"]);
  assert.ok(t1Exec.byId.has("execution:E3/tools"), "tools carry no ticket; they are found through their execution");

  const seats = buildTrackTree(spans, "product", { ...NO_FILTERS, kinds: ["seat"] }, LIVE);
  assert.deepEqual(allNodes(seats).filter((n) => n.lanes.length > 0).map((n) => n.kind).filter((k, i, a) => a.indexOf(k) === i), ["seat"]);

  const slices = buildTrackTree(spans, "execution", { ...NO_FILTERS, slices: ["S3"] }, LIVE);
  assert.deepEqual(ids(slices.roots), ["execution:E4"]);
});

test("filters: attentionOnly keeps only tracks that failed, were interrupted or wait on a person", () => {
  const tree = buildTrackTree(fixture(), "product", { ...NO_FILTERS, attentionOnly: true }, LIVE);
  const needs = (n) => ["person", "unknown", "interrupted", "failed"].includes(n.attention) || Boolean(n.counts && (n.counts.failed || n.counts.rejected || n.counts.interrupted || n.counts.unknown || n.counts.waitingPerson));
  for (const n of allNodes(tree)) assert.ok(needs(n), `${n.id}: ${n.attention}`);
  assert.ok(tree.byId.has("cell:T1/waits"));
  assert.ok(tree.byId.has("cell:T1/rounds"));
  assert.ok(!tree.byId.has("station:T1/groom"));
  assert.ok(!tree.byId.has("cell:T9"));
  const exec = buildTrackTree(fixture(), "execution", { ...NO_FILTERS, attentionOnly: true }, LIVE);
  assert.deepEqual(ids(exec.roots), ["execution:E4", "execution:E1"]);
});

// ---------------------------------------------------------------- lane packing

test("lane packing: never overlaps, is deterministic, and reuses a lane as soon as it is free", () => {
  const rand = lcg(7);
  const spans = [];
  for (let i = 0; i < 2000; i++) {
    const from = at(rand() * 600);
    const instant = rand() < 0.2;
    const open = rand() < 0.02;
    spans.push(span({ kind: "tool", entity: `tool:x-${i}`, parent: "execution:X", ids: { execution_id: "X", tool_call_id: `x-${i}` }, start: from, end: open ? null : instant ? from : from + rand() * 600_000 }));
  }
  spans.push(span({ kind: "execution", entity: "execution:X", ids: { execution_id: "X", attempt: "1" }, start: at(0), end: at(700) }));
  const tree = buildTrackTree(spans, "execution", NO_FILTERS, at(700));
  const row = tree.byId.get("execution:X/tools");
  assert.equal(row.lanes.reduce((a, l) => a + l.spans.length, 0), 2000);
  assert.ok(lanesDisjoint(row.lanes));
  const again = buildTrackTree([...spans].reverse(), "execution", NO_FILTERS, at(700));
  assert.deepEqual(again.byId.get("execution:X/tools").lanes.map((l) => l.spans.map((s) => s.id)), row.lanes.map((l) => l.spans.map((s) => s.id)));
  // Sequential visits share one lane; two instants at the same moment do not.
  const seq = [
    visit("T", null, "build", 1, at(0), at(10)),
    visit("T", null, "build", 2, at(10), at(20)),
    span({ kind: "round", entity: "gate:T/round#1", parent: "cell:T", ids: { ticket_id: "T", round: "1" }, start: at(5), end: at(5) }),
    span({ kind: "round", entity: "gate:T/round#2", parent: "cell:T", ids: { ticket_id: "T", round: "2" }, start: at(5), end: at(5) }),
  ];
  const t = buildTrackTree(seq, "product", NO_FILTERS, at(30));
  assert.equal(t.byId.get("station:T/build").lanes.length, 1);
  assert.equal(t.byId.get("cell:T/rounds").lanes.length, 2);
});

// ---------------------------------------------------------------- tracksOf

test("tracksOf: tracks holding spans about a ref, most specific first", () => {
  const product = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  assert.equal(product.tracksOf("station:T1/build")[0], "station:T1/build");
  assert.equal(product.tracksOf("visit:T1/build#2")[0], "station:T1/build");
  assert.equal(product.tracksOf("seat:T1/review#3/security")[0], "seat:T1/review#3/security");
  assert.deepEqual(product.tracksOf("gate:T1/review#1").slice(0, 3).sort(), ["seat:T1/review#1/architecture", "seat:T1/review#1/product", "seat:T1/review#1/security"]);
  assert.equal(product.tracksOf("gate:T1/round#2")[0], "cell:T1/rounds");
  assert.equal(product.tracksOf("gate:T1/required:ev-77")[0], "cell:T1/waits");
  const cell = product.tracksOf("cell:T1");
  assert.equal(cell[0], "cell:T1");
  assert.ok(cell.includes("station:T1/build") && cell.includes("seat:T1/review#1/security"));
  assert.deepEqual(product.tracksOf("slice:S4"), ["slice:S4", "slice:S4/waits"]);
  const e1 = product.tracksOf("execution:E1");
  assert.ok(e1.includes("station:T1/build") && e1.includes("cell:T1"), e1.join());
  assert.equal(e1.at(-1), "cell:T1", "the ribbon holder comes last");
  assert.deepEqual(product.tracksOf("agent:E3-builder"), []);
  assert.deepEqual(product.tracksOf("cell:NOPE"), []);

  const exec = buildTrackTree(fixture(), "execution", NO_FILTERS, LIVE);
  assert.equal(exec.tracksOf("agent:E3-builder")[0], "agent:E3-builder");
  assert.ok(exec.tracksOf("agent:E3-builder").includes("agent:E3-builder/tools"));
  assert.equal(exec.tracksOf("agent:E4-a03")[0], "workflow:E4/belt/agents");
  assert.equal(exec.tracksOf("execution:E1")[0], "execution:E1");
  assert.ok(exec.tracksOf("visit:T1/build#1").includes("execution:E1"), "the ribbon holder");
  assert.ok(exec.tracksOf("cell:T1").includes("execution:E2"));
});

// ---------------------------------------------------------------- layout

test("layout: lanes are rows, heights from ROW_HEIGHT, slice by binary search, rowOf", () => {
  const tree = buildTrackTree(fixture(), "execution", NO_FILTERS, LIVE);
  const expanded = new Set(defaultExpanded(tree));
  assert.ok(expanded.has("execution:E4") && expanded.has("workflow:E4/belt"));
  const layout = layoutRows(tree, expanded);
  const agents = tree.byId.get("workflow:E4/belt/agents");
  const agentRows = layout.rows.filter((r) => r.node === agents);
  assert.equal(agentRows.length, agents.lanes.length);
  assert.deepEqual(agentRows.map((r) => r.lane), agents.lanes.map((_, i) => i));
  let y = 0;
  for (const row of layout.rows) {
    assert.equal(row.y, y);
    assert.equal(row.height, ROW_HEIGHT[row.node.kind]);
    y += row.height;
  }
  assert.equal(layout.totalHeight, y);
  for (const [top, bottom] of [[0, 1], [0, 300], [17, 18], [250, 900], [layout.totalHeight - 5, layout.totalHeight + 100], [layout.totalHeight + 1, layout.totalHeight + 2]]) {
    const linear = layout.rows.filter((r) => r.y + r.height > top && r.y < bottom);
    assert.deepEqual(layout.slice(top, bottom), linear, `${top}..${bottom}`);
  }
  assert.deepEqual(layout.slice(40, 40), []);
  assert.equal(layout.rowOf("workflow:E4/belt/agents", 2).lane, 2);
  assert.equal(layout.rowOf("workflow:E4/belt/agents", agents.lanes.length), null);
  assert.equal(layout.rowOf("nope"), null);
  // Collapsed: no descendants.
  const closed = layoutRows(tree, new Set());
  assert.deepEqual(closed.rows.map((r) => r.node.id), ids(tree.roots));
  assert.ok(closed.rows.every((r) => !r.expanded && r.hasChildren));
});

test("defaultExpanded: waves, slices and cells open; cells' children closed beyond six cells", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  const open = new Set(defaultExpanded(tree));
  for (const id of ["wave:W1", "wave:W2", "slice:S1", "slice:S4", "cell:T1", "cell:T9", "factory/unplanned", "cell:T1/review"]) assert.ok(open.has(id), id);
  assert.ok(!open.has("station:T1/build"), "rows without children are never listed");
  const many = [];
  for (let c = 0; c < 8; c++) {
    many.push(span({ kind: "cell", entity: `cell:C${c}`, ids: { ticket_id: `C${c}` }, start: at(c), end: null }));
    many.push(seat(`C${c}`, null, 1, "security", at(c), at(c + 1), "approve"));
  }
  const big = new Set(defaultExpanded(buildTrackTree(many, "product", NO_FILTERS, LIVE)));
  assert.ok(big.has("cell:C0"));
  assert.ok(!big.has("cell:C0/review"));
});

// ---------------------------------------------------------------- scale

function generated(total) {
  const rand = lcg(42);
  const spans = [];
  const cells = 12;
  for (let w = 0; w < 2; w++) spans.push(span({ kind: "wave", entity: `wave:GW${w}`, ids: { wave_id: `GW${w}` }, start: at(w), end: null }));
  for (let c = 0; c < cells; c++) {
    const t = `G${c}`;
    const s = `GS${c}`;
    spans.push(span({ kind: "slice-eligible", entity: `slice:${s}`, parent: `slice:${s}`, ids: { slice_id: s, wave_id: `GW${c % 2}`, ticket_id: t }, start: at(c), end: at(c + 1) }));
    spans.push(span({ kind: "cell", entity: `cell:${t}`, ids: cellIds(t, s), start: at(c + 1), end: null }));
    for (let r = 1; r <= 3; r++) {
      spans.push(span({ kind: "round", entity: `gate:${t}/round#${r}`, parent: `cell:${t}`, ids: { ...cellIds(t, s), round: String(r) }, start: at(c + r * 100), end: at(c + r * 100 + 90), outcome: r < 3 ? "REJECTED" : "APPROVED", reason: r < 3 ? "failed" : "completed" }));
      for (const st of ["build", "verify", "review"]) spans.push(visit(t, s, st, r, at(c + r * 100 + 5), at(c + r * 100 + 60), `GX${c}-${r}`, { round: r }));
      for (const name of ["architecture", "security", "product"]) spans.push(seat(t, s, r, name, at(c + r * 100 + 60), at(c + r * 100 + 80), "approve"));
    }
    for (let r = 1; r <= 3; r++) spans.push(...execution(`GX${c}-${r}`, t, r, at(c + r * 100), at(c + r * 100 + 95)));
  }
  // Fill with agents (some in small workflows, most in large ones) and their tools.
  let n = 0;
  while (spans.length < total) {
    const c = n % cells;
    const r = 1 + (n % 3);
    const x = `GX${c}-${r}`;
    const wf = `workflow:${x}/w${n % 40 === 0 ? `small${n}` : "main"}`;
    const q = at(c + r * 100 + rand() * 90);
    const name = `g${n}`;
    spans.push(...agent(x, wf, name, q, q + 1000, q + 1000 + rand() * 600_000, n % 5 === 0 ? { toolsCountOnly: true, toolCalls: 3 } : {}));
    if (n % 5 !== 0) for (let k = 0; k < 4; k++) spans.push(tool(x, `agent:${x}-${name}`, `${n}-${k}`, q + 1000 + k * 2000, q + 2500 + k * 2000));
    n++;
  }
  const workflows = new Set(spans.filter((s) => s.kind === "agent").map((s) => s.parent));
  for (const wf of workflows) {
    const x = wf.slice("workflow:".length, wf.indexOf("/"));
    spans.push(span({ kind: "workflow", entity: wf, parent: `execution:${x}`, ids: { execution_id: x }, start: at(0), end: at(1000) }));
  }
  return spans;
}

test("scale: 60,000 spans build well under 100 ms and rebuild incrementally in a few ms", () => {
  const spans = generated(60_000);
  const agents = spans.filter((s) => s.kind === "agent").length;
  const time = (fn) => {
    const t0 = performance.now();
    const out = fn();
    return [out, performance.now() - t0];
  };
  // Warm the JIT once, as the app would have by its second build.
  buildTrackTree(spans, "product", NO_FILTERS, LIVE);
  buildTrackTree(spans, "execution", NO_FILTERS, LIVE);
  const report = [];
  const median = (xs) => [...xs].sort((x, y) => x - y)[xs.length >> 1];
  for (const grouping of ["product", "execution"]) {
    const [tree, cold] = time(() => buildTrackTree(spans, grouping, NO_FILTERS, LIVE));
    const [same, unchanged] = time(() => buildTrackTree(spans, grouping, NO_FILTERS, LIVE, tree));
    let reused = 0;
    for (const [id, node] of tree.byId) if (same.byId.get(id) === node) reused++;
    assert.equal(reused, tree.byId.size, `${grouping}: an unchanged rebuild reuses every node`);
    // One span changes at a time (an agent ends later, a visit ends later), as live data arrives.
    const agentsDone = spans.map((s, i) => [s, i]).filter(([s]) => s.kind === "agent" && s.end !== null).map(([, i]) => i);
    const visitAt = spans.findIndex((s) => s.kind === "visit");
    let current = spans;
    let last = same;
    const singles = [];
    for (let k = 0; k < 15; k++) {
      const i = k % 2 ? agentsDone[k * 101] : visitAt;
      const next = [...current];
      next[i] = changed(current[i], { end: { ...current[i].end, at: current[i].end.at + 1000 } });
      const [after, ms] = time(() => buildTrackTree(next, grouping, NO_FILTERS, LIVE, last));
      let kept = 0;
      for (const [id, node] of last.byId) if (after.byId.get(id) === node) kept++;
      assert.ok(kept >= last.byId.size - 8, `${grouping}: ${kept} of ${last.byId.size} nodes reused`);
      singles.push(ms);
      current = next;
      last = after;
    }
    // A tool call appended.
    const appended = [...current, span({ kind: "tool", entity: "tool:late", parent: "execution:GX1-1", ids: { execution_id: "GX1-1", tool_call_id: "late" }, start: at(150), end: at(151) })];
    const [withTool, append] = time(() => buildTrackTree(appended, grouping, NO_FILTERS, LIVE, last));
    const [, layout] = time(() => layoutRows(withTool, new Set(defaultExpanded(withTool))));
    const [, firstTracksOf] = time(() => withTool.tracksOf("cell:G3"));
    const [, nextTracksOf] = time(() => withTool.tracksOf("execution:GX3-2"));
    report.push(
      `${grouping}: build ${cold.toFixed(1)} ms, unchanged rebuild ${unchanged.toFixed(1)} ms, one span changed ${median(singles).toFixed(1)} ms median (max ${Math.max(...singles).toFixed(1)}), ` +
        `tool appended ${append.toFixed(1)} ms, layout ${layout.toFixed(1)} ms, tracksOf ${firstTracksOf.toFixed(1)} ms first / ${nextTracksOf.toFixed(2)} ms next, ${withTool.byId.size} nodes`,
    );
    assert.ok(cold < 300, `${grouping} build took ${cold} ms`);
    assert.ok(median(singles) < 25, `${grouping} incremental rebuild took ${median(singles)} ms`);
    for (const node of withTool.byId.values()) if (node.kind === "agents" && node.lanes.length > 0) assert.ok(lanesDisjoint(node.lanes), node.id);
  }
  console.log(`# ${spans.length} spans, ${agents} agents, 12 cells\n# ${report.join("\n# ")}`);
});

// ---------------------------------------------------------------- wave 2

const { spansOnTrack, ancestorsOf, roundsOf, attemptsOf } = tracks;

test("capacity waits as the observer names them (ids: ticket only) sit on their cell's Waits row; an unplaced cell is under 'No wave recorded'", () => {
  const spans = [
    ...fixture(),
    // apps/observer spans.go: capacity-wait:cell:<T>@<event>, entity and parent cell:<T>, ids { ticket_id }.
    { ...span({ kind: "capacity-wait", entity: "cell:T1", parent: "cell:T1", ids: { ticket_id: "T1" }, start: at(16), end: at(19) }), id: "capacity-wait:cell:T1@ev-9" },
    { ...span({ kind: "capacity-wait", entity: "cell:T9", parent: "cell:T9", ids: { ticket_id: "T9" }, start: at(3), end: null }), id: "capacity-wait:cell:T9@ev-3" },
  ];
  const tree = buildTrackTree(spans, "product", NO_FILTERS, LIVE);
  assert.equal(tree.ofSpan.get("capacity-wait:cell:T1@ev-9").trackId, "cell:T1/waits");
  assert.deepEqual(pathTo(tree, "cell:T1/waits"), ["wave:W1", "slice:S1", "cell:T1", "cell:T1/waits"], "its wave through the cell's slice");
  assert.equal(tree.ofSpan.get("capacity-wait:cell:T9@ev-3").trackId, "cell:T9/waits");
  assert.equal(tree.byId.get("factory/unplanned").label, "No wave recorded");
  assert.deepEqual(pathTo(tree, "cell:T9"), ["factory/unplanned", "cell:T9"], "never dropped");
});

test("the Verification row: verify visits' checks, with a count; not emitted when a cell has none; no 'executions' row is ever emitted", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  assert.equal(tree.byId.get("cell:T1/verification").detail, "1 check recorded");
  assert.ok(!tree.byId.has("cell:T2/verification"), "T2 has no checks: no row");
  assert.ok(!tree.byId.has("cell:T3/verification"));
  for (const g of ["product", "execution"]) for (const n of allNodes(buildTrackTree(fixture(), g, NO_FILTERS, LIVE))) assert.notEqual(n.kind, "executions", n.id);
});

test("attentionOnly: running alone does not count; failed, interrupted, refused and waiting on a person do", () => {
  const exec = buildTrackTree(fixture(), "execution", { ...NO_FILTERS, attentionOnly: true }, LIVE);
  assert.ok(!exec.byId.has("execution:E3"), "E3 is merely running");
  assert.ok(exec.byId.has("execution:E1"), "E1 was interrupted");
  assert.ok(exec.byId.has("execution:E4"), "E4 failed");
  const refused = span({ kind: "seat", entity: "seat:T5/review#1/security", parent: "gate:T5/review#1", ids: { ticket_id: "T5", round: "1", seat: "security" }, start: at(1), end: at(2), outcome: "REJECT", reason: "refused" });
  const running = span({ kind: "visit", entity: "visit:T6/build#1", ids: { ticket_id: "T6", station: "build", visit_id: "T6/build#1" }, start: at(1), end: null });
  const t = buildTrackTree([refused, running], "product", { ...NO_FILTERS, attentionOnly: true }, LIVE);
  assert.ok(t.byId.has("seat:T5/review#1/security"), "refused counts");
  assert.ok(!t.byId.has("cell:T6"), "an open visit alone does not");
});

test("lens helpers: spansOnTrack, ancestorsOf, roundsOf, attemptsOf (an attempt spanning a round boundary)", () => {
  const spans = fixture();
  const tree = buildTrackTree(spans, "product", NO_FILTERS, LIVE);
  // In time order; at the same instant, by id ("task:…" before "visit:…").
  assert.deepEqual(spansOnTrack(tree, "station:T1/build").map((s) => s.entity), ["visit:T1/build#1/task:t1#red", "visit:T1/build#1", "visit:T1/build#1/task:t2#green", "visit:T1/build#2", "visit:T1/build#3"]);
  assert.deepEqual(spansOnTrack(tree, "nope"), []);
  assert.deepEqual(ancestorsOf(tree, "seat:T1/review#3/product").map((n) => n.id), ["wave:W1", "slice:S1", "cell:T1", "cell:T1/review"]);
  assert.deepEqual(ancestorsOf(tree, "wave:W1"), []);

  const rounds = roundsOf(spans, "T1");
  assert.deepEqual(rounds.map((r) => r.round), [1, 2, 3]);
  assert.deepEqual(rounds[0].visits.map((v) => v.ids.station), ["build", "verify", "review"]);
  assert.deepEqual(rounds[0].seats.map((s) => s.ids.seat), ["architecture", "product", "security"], "seats in the order they began, then by id");
  assert.deepEqual(rounds[1].visits.map((v) => v.ids.station), ["build", "verify"]);
  assert.deepEqual([rounds[1].bounds.from, rounds[1].bounds.to, rounds[1].bounds.basis], [at(61), at(110), "measured"]);

  const attempts = attemptsOf(spans, "T1");
  assert.deepEqual(attempts.map((a) => [a.execution, a.attempt]), [["E1", 1], ["E2", 2]]);
  assert.deepEqual([attempts[0].bounds.from, attempts[0].bounds.to], [at(19), at(88)]);
  assert.equal(attempts[0].span.end.reason, "interrupted");
  assert.ok(attempts[0].claim);
  // E1 holds round 1 and the start of round 2; E2 the rest of round 2 and round 3.
  assert.deepEqual(attempts[0].visits.map((v) => [v.span.ids.visit_id, v.by]), [["T1/build#1", "recorded"], ["T1/verify#1", "recorded"], ["T1/review#1", "recorded"], ["T1/build#2", "recorded"]]);
  assert.deepEqual(attempts[1].visits.map((v) => v.span.ids.visit_id), ["T1/verify#2", "T1/build#3", "T1/verify#3", "T1/review#3"]);
  const r2 = new Set(rounds[1].visits.map((v) => v.ids.visit_id));
  assert.ok(attempts[0].visits.some((v) => r2.has(v.span.ids.visit_id)) && attempts[1].visits.some((v) => r2.has(v.span.ids.visit_id)), "round 2 falls in both attempts");
  // A visit with no execution on its record is placed by overlap only, and said so.
  const loose = span({ kind: "visit", entity: "visit:T1/audit#2", ids: { ticket_id: "T1", station: "audit", visit_id: "T1/audit#2" }, start: at(100), end: at(101) });
  const withLoose = attemptsOf([...spans, loose], "T1");
  assert.deepEqual(withLoose[1].visits.find((v) => v.span === loose)?.by, "overlap");
  // The groom visits before any execution are in no attempt.
  assert.ok(!withLoose.some((a) => a.visits.some((v) => v.span.ids.station === "groom")));
  // An open attempt has no end.
  const t2 = attemptsOf(spans, "T2");
  assert.deepEqual([t2[0].execution, t2[0].bounds.to, t2[0].bounds.basis], ["E3", null, "open"]);
});

test("execution grouping: an agent or workflow label drops the ticket its execution already shows", () => {
  const { withoutTicket, startWords } = buildModule;
  assert.equal(withoutTicket("LOCAL-001: build", "LOCAL-001"), "build");
  assert.equal(withoutTicket("LOCAL-001 · review architecture", "LOCAL-001"), "review architecture");
  assert.equal(withoutTicket("LOCAL-0012: build", "LOCAL-001"), "LOCAL-0012: build", "another ticket is not cut");
  assert.equal(withoutTicket("LOCAL-001", "LOCAL-001"), "LOCAL-001", "nothing would remain");
  assert.equal(withoutTicket("builder", undefined), "builder");
  assert.equal(startWords(Date.UTC(2026, 10, 12, 5, 29, 40)), "05:29");
  assert.equal(startWords(125_000), "02:05", "simulation time is elapsed");
  const spans = fixture().map((s) => (s.kind === "agent" && s.entity === "agent:E3-builder" ? { ...s, attrs: { ...s.attrs, label: "T2: builder" } } : s));
  const tree = buildTrackTree(spans, "execution", NO_FILTERS, LIVE);
  assert.equal(tree.byId.get("agent:E3-builder").label, "builder");
  const attempt = buildTrackTree(fixture().filter((s) => !(s.kind === "execution" && s.entity.includes("E3"))), "execution", NO_FILTERS, LIVE);
  assert.equal(attempt.byId.get("execution:E3")?.detail, "supervisor attempt 1", "the recorded attempt stays in the detail");
});

// ---------------------------------------------------------------- round 4 (ROUND4.md ids)

test("X4: the tree from structural spans plus a window's detail places every row as the whole history does", async () => {
  const all = fixture();
  const structural = all.filter((s) => contract.STRUCTURAL_KINDS.includes(s.kind));
  const win = { from: at(100), to: at(120) };
  const detail = all.filter((s) => !contract.STRUCTURAL_KINDS.includes(s.kind) && contract.overlaps(s, win));
  const union = [...structural, ...detail];
  const tree = buildTrackTree(union, "product", NO_FILTERS, LIVE);
  const whole = buildTrackTree(all, "product", NO_FILTERS, LIVE);
  assert.deepEqual(pathTo(tree, "cell:T1"), pathTo(whole, "cell:T1"), "the cell stays under its slice and wave");
  assert.ok(!tree.byId.get("factory/unplanned")?.children.some((c) => c.id === "cell:T1"));
  // The Rounds row holds every round, including those outside the window, so it draws an edge chevron, never vanishes.
  const rounds = tree.byId.get("cell:T1/rounds");
  assert.equal(rounds.lanes.flatMap((l) => l.spans).length, 3);
  const scaleMod = await import("../src/timeline/render/scale.ts");
  const drawMod = await import("../src/timeline/render/draw.ts");
  const far = { from: at(400), to: at(420) };
  const ch = drawMod.edgeChevron(rounds.lanes[0].spans, scaleMod.scaleOf(far, 600), LIVE);
  assert.ok(ch && ch.side === -1, "a chevron on the side the rounds lie");
  // Executions are numbered from the structural spans: the same labels whatever the window.
  const ex = buildTrackTree(union, "execution", NO_FILTERS, LIVE);
  const exWhole = buildTrackTree(all, "execution", NO_FILTERS, LIVE);
  assert.equal(ex.byId.get("execution:E2").label, exWhole.byId.get("execution:E2").label);
});

test("X1: a parent's attention is its own; rejections and failures beneath it are counts", () => {
  const tree = buildTrackTree(fixture(), "product", NO_FILTERS, LIVE);
  const rounds = tree.byId.get("cell:T1/rounds");
  assert.equal(rounds.attention, "none", "the latest round was approved");
  assert.deepEqual({ rejected: rounds.counts.rejected, failed: rounds.counts.failed }, { rejected: 1, failed: 1 });
  for (const id of ["cell:T1", "slice:S1", "wave:W1"]) {
    const n = tree.byId.get(id);
    assert.notEqual(n.attention, "failed", id);
    assert.ok(n.counts.rejected >= 1 && n.counts.failed >= 1, `${id} counts what happened beneath it`);
  }
  assert.equal(tree.byId.get("wave:W1").attention, "open", "the wave's own span is open");
});

// The reducer and the engine: pure, deterministic, identical forwards and backwards, and fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { sim } from "./_load.mjs";

const { SCENARIO, sceneAt, sceneAtCursor, finalScene, cursorAt, indexFixture, eventsBetween, eventsInWindow, changesBetween, eventsFor, latestEventFor, nextEventTime, previousEventTime, allAgents, activeAgents, toolCallsInFlight, entityAt, relatedRefs, cellTimelines, agentTimeline, moments, chapterAt } = sim;

const D = SCENARIO.duration;
// A fixed, scattered set of playhead times (no randomness: a linear congruential sequence with a fixed seed).
const SAMPLE = (() => {
  const out = [0, 1, D, D - 1];
  let x = 12345;
  for (let i = 0; i < 300; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Math.floor((x / 2147483648) * D));
  }
  return out;
})();

test("the same t gives the same scene, whatever was asked before", () => {
  const firstPass = new Map(SAMPLE.map((t) => [t, sceneAt(SCENARIO, t)]));
  for (const t of [...SAMPLE].reverse()) assert.equal(sceneAt(SCENARIO, t), firstPass.get(t));
  for (const t of SAMPLE) assert.equal(sceneAt(SCENARIO, t), firstPass.get(t));
});

test("a fresh index over a copy of the fixture gives equal scenes (no hidden state in the cache)", () => {
  const copy = structuredClone(SCENARIO);
  for (const t of SAMPLE.slice(0, 60)) assert.equal(JSON.stringify(sceneAt(copy, t)), JSON.stringify(sceneAt(SCENARIO, t)));
});

test("scrubbing backwards shows exactly what playing forwards showed", () => {
  const step = 7_000;
  const forward = [];
  for (let t = 0; t <= D; t += step) forward.push(JSON.stringify(sceneAt(SCENARIO, t)));
  let i = forward.length - 1;
  for (let t = Math.floor(D / step) * step; t >= 0; t -= step, i--) assert.equal(JSON.stringify(sceneAt(SCENARIO, t)), forward[i]);
});

test("earlier scenes are never changed by later events (structural sharing, no mutation)", () => {
  const early = sceneAt(SCENARIO, 20 * 60000);
  const before = JSON.stringify(early);
  sceneAt(SCENARIO, D);
  allAgents(finalScene(SCENARIO));
  assert.equal(JSON.stringify(early), before);
  // Untouched parts are shared: a cell that did not change between two events is the same object.
  const a = sceneAt(SCENARIO, 50 * 60000);
  const b = sceneAtCursor(SCENARIO, a.cursor + 1);
  const changed = indexFixture(SCENARIO).events[a.cursor].ticket_id;
  for (const id of Object.keys(a.cells)) if (id !== changed) assert.equal(a.cells[id], b.cells[id], id);
});

test("the scene at t has exactly the events up to t applied", () => {
  for (const t of SAMPLE) {
    const scene = sceneAt(SCENARIO, t);
    const expected = SCENARIO.events.filter((e) => e.t <= t).length;
    assert.equal(scene.cursor, expected);
    assert.equal(scene.counters.events, expected);
    assert.equal(cursorAt(SCENARIO, t), expected);
  }
});

test("the end state is the story's end", () => {
  const end = finalScene(SCENARIO);
  for (const ticket of ["LOCAL-031", "LOCAL-032", "LOCAL-033"]) {
    assert.equal(end.cells[ticket].stage, "merged");
    assert.ok(end.cells[ticket].archived);
  }
  assert.equal(end.cells["LOCAL-034"].stage, "building");
  assert.equal(end.slices["SLICE-024"].scheduler, "dispatched");
  assert.equal(end.slices["SLICE-025"].scheduler, "waiting-on-dependency");
  assert.equal(end.dependencies["SLICE-024->SLICE-021"].state, "satisfied");
  assert.equal(end.dependencies["SLICE-025->SLICE-022"].state, "satisfied");
  assert.equal(end.dependencies["SLICE-025->SLICE-024"].state, "blocking");
  assert.equal(end.gates["LOCAL-032/human-approval"].state, "passed");
  assert.equal(end.gates["LOCAL-031/verification#1"].state, "failed");
  assert.equal(end.gates["LOCAL-031/verification#2"].state, "passed");
  assert.equal(end.gates["LOCAL-032/review#1"].state, "failed");
  assert.equal(end.cells["LOCAL-031"].round, 2);
  assert.equal(end.cells["LOCAL-033"].reviews[0].findings.filter((f) => f.outvoted).length, 1);
  assert.equal(end.counters.merged, 3);
  assert.equal(end.counters.agentsActive, activeAgents(end).length);
  assert.equal(end.counters.toolCallsActive, 0);
});

test("the middle of the run: three cells at work, the human gate waiting", () => {
  const busy = sceneAt(SCENARIO, 15 * 60000);
  assert.equal(Object.values(busy.cells).filter((c) => c.activeAgentIds.length > 0).length, 3);
  // Agents are visibly at work most of the time: a tool call is in flight in most 10-second samples.
  let sampled = 0;
  let working = 0;
  for (let t = 2 * 60000; t < 50 * 60000; t += 10000, sampled++) if (toolCallsInFlight(sceneAt(SCENARIO, t)).length) working++;
  assert.ok(working / sampled > 0.6, `tools in flight in ${working} of ${sampled} samples`);
  const gate = SCENARIO.events.find((e) => e.type === "human.required");
  const waiting = sceneAt(SCENARIO, gate.t);
  assert.equal(waiting.gates["LOCAL-032/human-approval"].state, "waiting");
  assert.equal(waiting.cells["LOCAL-032"].stage, "awaiting-human");
});

test("selectors: windows, changes, the events behind an entity, stepping", () => {
  const t = 30 * 60000;
  const win = eventsInWindow(SCENARIO, t, 60000);
  assert.ok(win.every((e) => e.t > t - 60000 && e.t <= t));
  assert.deepEqual(eventsInWindow(SCENARIO, t, 60000, ["tool.started"]), win.filter((e) => e.type === "tool.started"));
  assert.equal(eventsBetween(SCENARIO, -1, D).length, SCENARIO.events.length, "from is exclusive: -1 includes the event at 0");
  const fwd = changesBetween(SCENARIO, 10 * 60000, 12 * 60000);
  const back = changesBetween(SCENARIO, 12 * 60000, 10 * 60000);
  assert.equal(fwd.direction, "forward");
  assert.equal(back.direction, "backward");
  assert.deepEqual(fwd.events, back.events);
  assert.ok(fwd.refs.includes("cell:LOCAL-031"));
  const behind = eventsFor(SCENARIO, "gate:LOCAL-032/human-approval");
  assert.deepEqual(behind.map((e) => e.type), ["review.decided", "station.entered", "human.required", "human.approval_recorded", "station.left"]);
  assert.equal(latestEventFor(SCENARIO, "gate:LOCAL-032/human-approval", behind[1].t).seq, behind[1].seq);
  const n = nextEventTime(SCENARIO, t);
  assert.ok(n > t && SCENARIO.events.some((e) => e.t === n));
  const p = previousEventTime(SCENARIO, t);
  assert.ok(p < t);
  assert.equal(nextEventTime(SCENARIO, D), null);
  assert.equal(previousEventTime(SCENARIO, 0), null);
});

test("selectors: any entity resolves, and hover sets cover the dependency graph", () => {
  const end = finalScene(SCENARIO);
  const agent = allAgents(end).find((a) => a.role === "contract-engineer");
  assert.equal(entityAt(end, `agent:${agent.id}`).value.id, agent.id);
  const call = agent.toolCalls[0];
  assert.equal(entityAt(end, `tool:${call.id}`).value.id, call.id);
  const artifact = end.cells["LOCAL-031"].artifacts.find((a) => a.kind === "plan");
  assert.equal(entityAt(end, `artifact:${artifact.id}`).value.path, "plan.md");
  assert.equal(entityAt(end, "station:LOCAL-031/verify").value.visits.length, 2);
  assert.equal(entityAt(end, "finding:LOCAL-032/r1/security/1").value.severity, "blocker");
  assert.equal(entityAt(sceneAt(SCENARIO, 0), "cell:LOCAL-031"), null);
  const related = relatedRefs(end, "slice:SLICE-025");
  for (const r of ["slice:SLICE-022", "slice:SLICE-024", "slice:SLICE-021", "dependency:SLICE-025->SLICE-024", "dependency:SLICE-024->SLICE-021"]) assert.ok(related.includes(r), r);
  assert.ok(relatedRefs(end, `artifact:${artifact.id}`).includes(`agent:${artifact.writer.agentId}`));
});

test("selectors: timelines and moments", () => {
  const lanes = cellTimelines(SCENARIO, SCENARIO.duration);
  assert.deepEqual(lanes.map((l) => l.ticketId), ["LOCAL-031", "LOCAL-032", "LOCAL-033", "LOCAL-034"]);
  const a = lanes[0];
  assert.deepEqual(a.stations.map((s) => s.station), ["plan", "build", "verify", "build", "verify", "review", "merge", "cleanup"]);
  for (const span of a.agents) {
    const overlapping = a.agents.filter((o) => o !== span && o.row === span.row && o.start < (span.end ?? Infinity) && span.start < (o.end ?? Infinity));
    assert.equal(overlapping.length, 0, "agents on one row never overlap");
  }
  const reviewer = agentTimeline(SCENARIO, a.agents.find((x) => x.role === "reviewer").agentId, SCENARIO.duration);
  assert.ok(reviewer.tools.length >= 5);
  const major = moments(SCENARIO);
  assert.ok(major.length > 20 && major.every((m) => m.significance === "major" || m.significance === "chapter"));
  assert.equal(chapterAt(SCENARIO, 0).id, "enabled");
  assert.equal(chapterAt(SCENARIO, D).id, "last-merge");
});

test("cost: index once, then sceneAt is a binary search (measured)", (t) => {
  const copy = structuredClone(SCENARIO);
  const t0 = performance.now();
  indexFixture(copy);
  const indexMs = performance.now() - t0;
  const frames = 20_000;
  const t1 = performance.now();
  let checksum = 0;
  for (let i = 0; i < frames; i++) checksum += sceneAt(copy, (i * 9973) % D).cursor;
  const perCallUs = ((performance.now() - t1) / frames) * 1000;
  t.diagnostic(`${SCENARIO.events.length} events; index ${indexMs.toFixed(1)} ms once; sceneAt ${perCallUs.toFixed(2)} µs per call (checksum ${checksum})`);
  assert.ok(indexMs < 1500, `indexing took ${indexMs} ms`);
  assert.ok(perCallUs < 50, `sceneAt took ${perCallUs} µs`);
});

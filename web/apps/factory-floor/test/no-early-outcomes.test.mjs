// No early outcomes: at playhead t, the scene and the timeline selectors expose nothing derived
// from an event later than t. No outcome, end time, verdict, vote or decision shows before its event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { SCENARIO, sceneAt, finalScene, cellTimelines, agentTimeline, moments, allAgents } = sim;
const events = SCENARIO.events;

// Every time an outcome is decided, one millisecond before (the leak window), plus a spread of times.
const OUTCOME_KINDS = new Set(["tool.finished", "agent.finished", "station.left", "verification.verdict", "review.vote", "review.decided", "human.approval_recorded", "merge.completed", "cleanup.completed", "execution.completed", "slice.integrated", "evidence.captured", "task.red", "task.green"]);
const SAMPLE = [...new Set([...events.filter((e) => OUTCOME_KINDS.has(e.type)).map((e) => e.t - 1), ...Array.from({ length: 60 }, (_, i) => Math.round((i / 59) * SCENARIO.duration))])]
  .filter((t) => t >= 0)
  .sort((a, b) => a - b);

/** Every problem in `value` for time t: a time field later than t, or an outcome without its time. */
function leaks(value, t, path = "scene", out = []) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaks(v, t, `${path}[${i}]`, out));
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    const here = `${path}.${key}`;
    // Times: anything named ...At (or at, end, since) must not lie after t.
    if (typeof v === "number" && /(At|^at|^end|^since)$/.test(key) && v > t) out.push(`${here} = ${v} > ${t}`);
    leaks(v, t, here, out);
  }
  // Outcomes need the event that decided them.
  const o = value;
  if ("leftAt" in o && "outcome" in o && o.leftAt === null && o.outcome !== null) out.push(`${path}: outcome ${o.outcome} without leftAt`);
  if ("end" in o && "outcome" in o && o.end === null && o.outcome !== null) out.push(`${path}: outcome ${o.outcome} without end`);
  if ("status" in o && "finishedAt" in o && o.finishedAt === null && o.status !== "running") out.push(`${path}: status ${o.status} without finishedAt`);
  if ("status" in o && "end" in o && "callId" in o && o.end === null && o.status !== "running") out.push(`${path}: tool status ${o.status} without end`);
  if ("status" in o && "decidedAt" in o && "checks" in o && o.decidedAt === null && o.status !== "running") out.push(`${path}: verdict ${o.status} without decidedAt`);
  if ("outcome" in o && "decidedAt" in o && "seats" in o && o.decidedAt === null && o.outcome !== null) out.push(`${path}: decision ${o.outcome} without decidedAt`);
  if ("vote" in o && "votedAt" in o && o.votedAt === null && o.vote !== null) out.push(`${path}: vote without votedAt`);
  if ("gate" in o && "decidedAt" in o && "state" in o && o.decidedAt === null && !["open", "waiting"].includes(o.state)) out.push(`${path}: gate ${o.state} without decidedAt`);
  if ("outcome" in o && "endedAt" in o && o.endedAt === null && o.outcome !== null) out.push(`${path}: execution outcome without endedAt`);
  if ("result" in o && "targetId" in o && o.at === null && o.result !== "pending") out.push(`${path}: check ${o.result} without at`);
  return out;
}

test("the detector works: the final scene, read at an earlier time, is caught leaking", () => {
  const found = leaks(finalScene(SCENARIO), 20 * 60000);
  assert.ok(found.length > 100, `only ${found.length} found`);
});

test("the scene at t exposes nothing decided after t", () => {
  for (const t of SAMPLE) {
    const found = leaks(sceneAt(SCENARIO, t), t);
    assert.deepEqual(found.slice(0, 5), [], `at t = ${t}`);
  }
});

test("cell timelines at t: spans open at t have no end and no outcome; nothing starts after t", () => {
  for (const t of SAMPLE) {
    const lanes = cellTimelines(SCENARIO, t);
    const found = leaks(lanes, t, "timelines");
    for (const lane of lanes) {
      for (const s of [...lane.stations, ...lane.agents]) if (s.start > t) found.push(`${lane.ticketId}: span starts at ${s.start} > ${t}`);
      for (const m of lane.moments) if (m.t > t) found.push(`${lane.ticketId}: moment at ${m.t} > ${t}`);
    }
    assert.deepEqual(found.slice(0, 5), [], `at t = ${t}`);
  }
});

test("agent tracks at t: tool calls open at t are running, with no end", () => {
  for (const t of SAMPLE.filter((_, i) => i % 7 === 0)) {
    for (const agent of allAgents(sceneAt(SCENARIO, t))) {
      const track = agentTimeline(SCENARIO, agent.id, t);
      assert.ok(track, agent.id);
      const found = leaks(track, t, `agent ${agent.id}`);
      for (const c of track.tools) if (c.start > t) found.push(`${c.callId} starts after t`);
      assert.deepEqual(found.slice(0, 5), [], `at t = ${t}`);
    }
  }
});

test("moments at t are only those that have happened; without t, the whole run (for a recorded ruler)", () => {
  const t = 30 * 60000;
  assert.ok(moments(SCENARIO, "major", t).every((m) => m.t <= t));
  assert.ok(moments(SCENARIO, "major").some((m) => m.t > t));
});

test("a span that ends in failure reads as plain work until its end", () => {
  // The verification of LOCAL-031 round 1 fails: one millisecond before its verdict it is still running.
  const verdict = events.find((e) => e.type === "verification.verdict" && e.data.status === "FAIL_WITH_EVIDENCE");
  const before = sceneAt(SCENARIO, verdict.t - 1);
  assert.equal(before.gates[`${verdict.ticket_id}/verification#1`].state, "open");
  const visit = cellTimelines(SCENARIO, verdict.t - 1).find((l) => l.ticketId === verdict.ticket_id).stations.at(-1);
  assert.equal(visit.station, "verify");
  assert.equal(visit.end, null);
  assert.equal(visit.outcome, null);
  const rejected = events.find((e) => e.type === "review.decided" && e.data.outcome === "REJECTED");
  const round = sceneAt(SCENARIO, rejected.t - 1).cells[rejected.ticket_id].reviews[0];
  assert.equal(round.outcome, null);
  assert.ok(round.findings.every((f) => !f.outvoted));
});

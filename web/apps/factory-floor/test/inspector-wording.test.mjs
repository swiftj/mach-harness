// The inspector's time and tally wording (findings N4): the moment a finished entity names, and a
// review tally that never prints approvals over approvals-needed as a fraction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { cellTiming, stationTiming, waveTiming, timingWords, reviewTally } = await import("../src/shell/inspector/timing.ts");
const { SCENARIO, finalScene, sceneAt } = sim;
const end = finalScene(SCENARIO);
const mergeOf = (ticket) => SCENARIO.events.find((e) => e.type === "merge.completed" && e.ticket_id === ticket);

test("a merged cell is finished at its merge, not at its dispatch (LOCAL-031)", () => {
  const cell = end.cells["LOCAL-031"];
  assert.ok(cell?.merged, "LOCAL-031 merges in the scenario");
  const timing = cellTiming(cell);
  assert.equal(timing.phase, "finished");
  assert.equal(timing.since, mergeOf("LOCAL-031").t);
  assert.notEqual(timing.since, cell.openedAt);
  assert.equal(timingWords(timing), "Finished at");
});

test("every merged cell names its merge time; an open cell names when it opened", () => {
  for (const cell of Object.values(end.cells)) {
    const timing = cellTiming(cell);
    if (cell.merged) assert.equal(timing.since, mergeOf(cell.ticketId).t, cell.ticketId);
    else assert.deepEqual([timing.phase, timing.since], ["running", cell.openedAt], cell.ticketId);
  }
  const t = mergeOf("LOCAL-031").t;
  const before = sceneAt(SCENARIO, t - 1).cells["LOCAL-031"];
  assert.deepEqual([cellTiming(before).phase, cellTiming(before).since], ["running", before.openedAt]);
});

test("a station visit is finished when the cell left it", () => {
  assert.deepEqual(stationTiming({ enteredAt: 10, leftAt: null }), { phase: "running", since: 10 });
  assert.deepEqual(stationTiming({ enteredAt: 10, leftAt: 25 }), { phase: "finished", since: 25 });
  for (const cell of Object.values(end.cells)) {
    for (const visit of cell.visits) if (visit.leftAt !== null) assert.equal(stationTiming(visit).since, visit.leftAt);
  }
});

test("a wave says when it arrived, never that it finished", () => {
  const timing = waveTiming({ discoveredAt: 31000 });
  assert.equal(timingWords(timing), "Arrived at");
  assert.equal(timing.since, 31000);
});

test("a review tally reads approvals of seats, then approvals needed, never 'x of needed'", () => {
  const rounds = Object.values(end.cells).flatMap((c) => c.reviews);
  assert.ok(rounds.some((r) => r.approvals !== null && r.approvals > r.approvalsNeeded), "the scenario has a round approved by more than were needed");
  for (const r of rounds) {
    const text = reviewTally(r);
    assert.ok(text.endsWith(`, ${r.approvalsNeeded} needed`), text);
    if (r.approvals !== null) assert.equal(text, `${r.approvals} of ${r.seats.length} approved, ${r.approvalsNeeded} needed`);
  }
  assert.equal(reviewTally({ approvals: 3, approvalsNeeded: 2, seats: [{}, {}, {}] }), "3 of 3 approved, 2 needed");
  assert.equal(reviewTally({ approvals: null, approvalsNeeded: 2, seats: [{}, {}, {}] }), "3 seats, 2 needed");
});

test("the decided review gate's detail does not print approvals over approvals needed", () => {
  for (const gate of Object.values(end.gates)) {
    if (gate.gate !== "review" || gate.decidedAt === null) continue;
    assert.match(gate.detail, /: \d+ approved, \d+ needed$/, gate.detail);
  }
});

// M9: a person at the approval gate may send the change back to the build station instead of
// approving it (human.approval_recorded with decision SENT_BACK). The gate and the wait end because
// the person answered, but nothing reads it as an approval. Old records with no decision, and any
// value other than SENT_BACK, still read as approvals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { beltRun, finalize } from "./fixtures/v3.mjs";

const words = await import("../src/timeline/render/words.ts");
const palette = await import("../src/timeline/render/palette.ts");
const inspector = await import("../src/timeline/inspector/model.ts");
const data = await import("../src/timeline/data/scene.ts");

const { createSceneLog, provenance, describeEntry, isSentBack, gateStateWords } = sim;
const sceneOf = (decision) => {
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  log.ingest(finalize(beltRun({ decision }).events));
  return log;
};

test("isSentBack: SENT_BACK in any case; anything else, a missing decision included, is an approval", () => {
  for (const v of ["SENT_BACK", "sent_back", " Sent_Back "]) assert.equal(isSentBack(v), true, v);
  for (const v of [undefined, null, "", "APPROVED", "approve", "maybe", 3]) assert.equal(isSentBack(v), false, String(v));
});

test("a send-back closes the person's gate without an approval, and the visit returns to build", () => {
  const log = sceneOf("SENT_BACK");
  const scene = log.head();
  const cell = scene.cells["LOCAL-031"];
  const gate = scene.gates["LOCAL-031/human-approval"];
  assert.equal(gate.state, "failed");
  assert.equal(gate.detail, "Sent back to the build station by a person.");
  assert.notEqual(gate.decidedAt, null);
  assert.equal(gateStateWords(gate), "Sent back by a person");
  const last = cell.reviews.at(-1);
  assert.equal(last.humanApproval, null, "a send-back is never an approval");
  assert.equal(last.humanSentBack.by, "a person");
  assert.equal(last.humanSentBack.noteGiven, true);
  assert.equal(last.outcome, "AWAITING_HUMAN", "the panel's own decision is kept");
  assert.equal(scene.counters.humanApprovals, 0);
  assert.equal(scene.counters.humanSendBacks, 1);
  assert.equal(cell.stage, "built");
  const visit = cell.visits.at(-1);
  assert.equal(visit.station, "human-approval");
  assert.equal(visit.outcomeWord, "sent-back");
  assert.equal(visit.outcome, "rejected");
  assert.equal(scene.supervisor.attention["LOCAL-031"], undefined, "the person answered; the ticket no longer waits for one");
  const entry = log.entries().find((x) => x.event.type === "human.approval_recorded");
  const text = describeEntry(entry);
  assert.match(text, /sent back to the build station by a person/);
  assert.doesNotMatch(text, /approv/);
});

test("no decision, APPROVED and an unknown value read as an approval, as before", () => {
  for (const decision of [undefined, "APPROVED", "approve", "maybe"]) {
    const log = sceneOf(decision);
    const scene = log.head();
    const gate = scene.gates["LOCAL-031/human-approval"];
    assert.equal(gate.state, "passed", String(decision));
    assert.equal(gate.detail, "Approved by a person.");
    const last = scene.cells["LOCAL-031"].reviews.at(-1);
    assert.equal(last.humanApproval.by, "a person");
    assert.equal(last.humanSentBack, null);
    assert.equal(scene.counters.humanApprovals, 1);
    assert.equal(scene.counters.humanSendBacks, 0);
    assert.match(describeEntry(log.entries().find((x) => x.event.type === "human.approval_recorded")), /a person approved/);
  }
});

test("the Timeline: the wait ends 'sent back', its mark is not an approval, and the words say so", () => {
  const scene = sceneOf("SENT_BACK").head();
  const spans = data.spansOfScene(scene);
  const wait = spans.find((s) => s.kind === "gate-wait" && s.entity === "gate:LOCAL-031/human-approval");
  assert.equal(wait.outcome, "sent-back");
  assert.equal(words.personApproved(wait, Number.MAX_SAFE_INTEGER), false);
  const marks = data.marksOfScene(scene, spans);
  const answer = marks.find((m) => m.id === `human-approved:${wait.id}`);
  assert.equal(answer.verdict, "sent-back");
  assert.match(answer.label, /sent the change back/);
  assert.equal(marks.some((m) => m.entity === wait.entity && m.verdict === "approved"), false);
  // The observer's spelling of the same outcome.
  assert.equal(words.outcomeWords("sent-back"), "sent back to the build station by a person");
  assert.equal(words.outcomeWords("human.approval_recorded"), "approved by a person");
  assert.equal(palette.outcomeTone("sent-back"), "fail");
  assert.equal(inspector.outcomeWordsOf("sent-back").words, "sent back to the build station by a person");
  const approved = data.spansOfScene(sceneOf(undefined).head()).find((s) => s.kind === "gate-wait" && s.entity === "gate:LOCAL-031/human-approval");
  assert.equal(approved.outcome, "passed");
  assert.equal(words.personApproved(approved, Number.MAX_SAFE_INTEGER), true);
});

test("the observer's snapshot: a human gate closed by a send-back is refused, one closed by an approval passed", () => {
  const state = live.readSnapshotState({
    gates: [
      { key: "approval:T-1#1", kind: "approval", ticket_id: "T-1", round: 1, opened: 1, closed: 2, closed_by: "sent-back" },
      { key: "approval:T-2#1", kind: "approval", ticket_id: "T-2", round: 1, opened: 1, closed: 2, closed_by: "human.approval_recorded" },
    ],
  });
  const by = Object.fromEntries(state.gates.map((g) => [g.ticket_id, g.state]));
  assert.deepEqual(by, { "T-1": "failed", "T-2": "passed" });
});

test("the history's landmarks: a send-back is a person's landmark in its own words", async () => {
  const { historyIndexOf } = await import("../src/shell/history.ts");
  const log = sceneOf("SENT_BACK");
  const person = historyIndexOf(log).landmarks.filter((l) => l.kind === "person" && !/needed|waits/.test(l.title)).map((l) => l.title);
  assert.ok(person.some((x) => /sent back to the build station by a person/.test(x)), person.join(" | "));
  assert.equal(person.some((x) => /approved/.test(x)), false, person.join(" | "));
});

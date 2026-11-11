// Unit tests for the interview screen's model (src/features/interview/model.ts): history, then the
// live stream's replay, must show every event once. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialModel, interviewReducer } from "../src/features/interview/model.ts";

const ev = (type, data, seq = null) => ({ type, data, seq });
const question = (id, n) => [
  ev("message", { message_id: id, text: `Question ${n}?`, kind: "question" }),
  ev("question", { message_id: id, number: n, title: `Question ${n}`, body: `Question ${n}?`, recommendation: "Yes", preface: "" }),
];
const turn = () => ev("turn", { outcome: "replied", seconds: 1, cost_usd: 0.01, session_cost_usd: 0.02, refused: 0 });

/** One interview: Q1, yes, Q2, yes, Q3 waiting, as the host saves it. */
function savedInterview(id) {
  return [
    ev("state", "starting"),
    ...question("m1", 1),
    ev("state", "waiting_for_reply"),
    turn(),
    ev("reply", { text: "yes" }),
    ev("activity", { kind: "check", text: "Checked the draft" }),
    ...question("m2", 2),
    ev("state", "waiting_for_reply"),
    turn(),
    ev("reply", { text: "yes" }),
    ev("activity", { kind: "check", text: "Checked the draft" }),
    ...question("m3", 3),
    ev("state", "waiting_for_reply"),
    turn(),
  ].map((event) => ({ event, interviewId: id }));
}

const run = (model, actions) => actions.reduce(interviewReducer, model);
const replies = (model) => model.timeline.filter((i) => i.type === "reply");
const activities = (model) => model.timeline.filter((i) => i.type === "activity");

test("history restores the transcript, the decisions and the waiting question", () => {
  const m = run(initialModel, [{ type: "history", events: savedInterview("iv1"), truncated: false }]);
  assert.equal(replies(m).length, 2);
  assert.equal(m.decisions.length, 2);
  assert.equal(m.awaiting, "m3");
  assert.equal(m.ended, null);
});

test("the stream's replay after a reload changes nothing, for every event kind", () => {
  const history = savedInterview("iv1");
  const loaded = run(initialModel, [{ type: "history", events: history, truncated: false }]);
  // The host replays the latest turn (from the reply that opened it) and the last question.
  const lastReply = history.map((e) => e.event.type).lastIndexOf("reply");
  const replayed = [...question("m3", 3), ...history.slice(lastReply).map((e) => e.event)].map((e, i) => ev(e.type, e.data, 100 + i));
  const after = run(loaded, [{ type: "attached", interviewId: "iv1" }, ...replayed.map((event) => ({ type: "event", event }))]);
  assert.equal(replies(after).length, 2, "no reply shown twice");
  assert.equal(activities(after).length, activities(loaded).length, "no activity shown twice");
  assert.equal(after.decisions.length, 2, "no decision counted twice");
  assert.equal(after.awaiting, "m3", "the question is still waiting for an answer");
  // What the host did not replay stays expected until the first new event closes the window.
  const live = run(after, [{ type: "event", event: ev("activity", { kind: "write", text: "Wrote the spec" }, 999) }]);
  assert.equal(live.replay, null, "a new event closes the replay window");
  assert.equal(activities(live).length, activities(loaded).length + 1);
});

test("after the replay, a live identical reply is new and counted", () => {
  const history = savedInterview("iv1");
  const loaded = run(initialModel, [{ type: "history", events: history, truncated: false }, { type: "attached", interviewId: "iv1" }]);
  const sent = run(loaded, [
    { type: "replied", text: "yes", answer: "accepted" },
    { type: "event", event: ev("state", "thinking", 200) },
    { type: "event", event: ev("reply", { text: "yes" }, 201) },
    { type: "event", event: ev("activity", { kind: "check", text: "Checked the draft" }, 202) },
  ]);
  assert.equal(replies(sent).length, 3, "the PM's new reply is shown once");
  assert.equal(replies(sent).at(-1).pending, false, "and confirmed by the host");
  assert.equal(sent.decisions.length, 3);
  assert.equal(activities(sent).length, activities(loaded).length + 1);
});

test("an earlier interview's end does not govern a resumed one", () => {
  const ended = [...savedInterview("iv1"), { event: ev("ended", { reason: "host_shutdown" }), interviewId: "iv1" }];
  const loaded = run(initialModel, [{ type: "history", events: ended, truncated: false }]);
  assert.equal(loaded.ended?.reason, "host_shutdown");
  const resumed = run(loaded, [
    { type: "attached", interviewId: "iv2" },
    { type: "event", event: ev("state", "starting", 1) },
    ...question("m3", 3).map((e, i) => ({ type: "event", event: { ...e, seq: 2 + i } })),
    { type: "event", event: ev("state", "waiting_for_reply", 4) },
  ]);
  assert.equal(resumed.ended, null, "the old host_shutdown is gone");
  assert.equal(resumed.awaiting, "m3", "the question can be answered");
  assert.equal(replies(resumed).length, 2, "the transcript is intact");
});

test("an end of the attached interview itself still shows", () => {
  const loaded = run(initialModel, [{ type: "history", events: savedInterview("iv1"), truncated: false }, { type: "attached", interviewId: "iv1" }]);
  const stopped = run(loaded, [{ type: "event", event: ev("ended", { reason: "stopped" }, 300) }]);
  assert.deepEqual(stopped.ended, { reason: "stopped", interviewId: "iv1" });
});

test("the replay is recognised whatever order the host writes an event's keys in", () => {
  const history = savedInterview("iv1");
  const loaded = run(initialModel, [{ type: "history", events: history, truncated: false }, { type: "attached", interviewId: "iv1" }]);
  // The live stream writes the same data with its keys in another order than the saved history.
  const reorder = (data) => (data && typeof data === "object" ? Object.fromEntries(Object.entries(data).reverse()) : data);
  const lastReply = history.map((e) => e.event.type).lastIndexOf("reply");
  const replayed = history.slice(lastReply).map((e, i) => ev(e.event.type, reorder(e.event.data), 500 + i));
  const after = run(loaded, replayed.map((event) => ({ type: "event", event })));
  assert.equal(replies(after).length, 2);
  assert.equal(after.decisions.length, 2);
  assert.equal(after.awaiting, "m3");
});

test("the host's replay starts with the question the last reply answered", () => {
  const history = savedInterview("iv1");
  const loaded = run(initialModel, [{ type: "history", events: history, truncated: false }, { type: "attached", interviewId: "iv1" }]);
  // As the host sends it: Q2 (answered by the last reply), the reply, the turn that asked Q3.
  const lastReply = history.map((e) => e.event.type).lastIndexOf("reply");
  const replayed = [...question("m2", 2), ...history.slice(lastReply).map((e) => e.event)].map((e, i) => ev(e.type, e.data, 600 + i));
  const after = run(loaded, replayed.map((event) => ({ type: "event", event })));
  assert.equal(replies(after).length, 2, "the replayed reply is not shown again");
  assert.equal(after.decisions.length, 2);
  assert.equal(after.awaiting, "m3", "Q3 still waits for its answer");
});

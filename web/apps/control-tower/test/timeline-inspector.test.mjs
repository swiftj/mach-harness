// The inspector's "In time" section (M6.3 design sections 3C and 5): which span stands for a
// selection, its duration in words for every basis, open and interrupted spans, outcomes only as of
// the playhead, parent, children and neighbours (order in time only), and evidence references.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const M = await import("../src/timeline/inspector/model.ts");
const { RULES } = { RULES: { "unclosed-visit": "bounded by the next entry: it never recorded an exit" } };

const end = (at, extra = {}) => ({ eventId: at === null ? null : `e-${at}`, at, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null, ...extra });
const clock = (t) => `t${t}`;

/** A span with sensible defaults; `start`/`end` given as times or as SpanEnd objects. */
function span({ kind = "visit", entity = "visit:T-1/build#1", parent = null, ids = {}, start = 0, finish = null, reason = "completed", duration, outcome = null, attrs = {}, id } = {}) {
  const s = typeof start === "number" ? end(start) : start;
  const e = finish === null ? null : typeof finish === "number" ? end(finish, { reason }) : finish;
  const d = duration ?? (e === null ? { ms: null, minMs: null, maxMs: null, basis: s === null ? "unknown" : "open" } : { ms: e.at - s.at, minMs: e.at - s.at, maxMs: e.at - s.at, basis: "measured" });
  return { id: id ?? `${kind}:${entity}`, kind, entity, parent, ids, start: s, end: e, duration: d, outcome, authority: "authoritative", attrs };
}

// ---------------------------------------------------------------- every basis

test("measured: took, and says it was measured", () => {
  const s = span({ start: 1_000, finish: 253_000 });
  assert.equal(M.durationSentence(s, 300_000, RULES).text, "took 4 min 12 s (measured)");
  assert.equal(M.durationSentence(s, 300_000).live, null);
});

test("bounded: between the two bounds", () => {
  const s = span({ start: 0, finish: end(null, { notBefore: 250_000, notAfter: 254_000, precision: "bounded", reason: "completed" }), duration: { ms: null, minMs: 250_000, maxMs: 254_000, basis: "bounded" } });
  assert.equal(M.durationSentence(s, 300_000).text, "between 4 min 10 s and 4 min 14 s");
  assert.equal(M.endedFact(s, 300_000, {}, clock).text, "between t250000 and t254000");
  const onlyMin = { ...s, duration: { ms: null, minMs: 60_000, maxMs: null, basis: "bounded" } };
  assert.equal(M.durationSentence(onlyMin, 300_000).text, "at least 1 min; the upper bound is not known");
});

test("inferred: about, placed by a rule in words (the inspector's RULE_WORDS first)", () => {
  const s = span({ kind: "task", start: end(0, { basis: "inferred", rule: "unclosed-visit" }), finish: 240_000, duration: { ms: 240_000, minMs: null, maxMs: null, basis: "inferred" } });
  assert.equal(M.durationSentence(s, 300_000, RULES).text, "about 4 min, placed by rule: bounded by the next entry: it never recorded an exit");
  const task = { ...s, start: end(0, { basis: "inferred", rule: "previous-completion" }) };
  assert.equal(M.durationSentence(task, 300_000, RULES).text, "about 4 min, placed by rule: it began when the previous task completed");
  assert.equal(M.beganFact(task, 300_000, RULES, clock).inferred, "placed by rule: it began when the previous task completed");
  assert.match(M.durationSentence({ ...task, start: end(0, { basis: "inferred", rule: "some-new-rule" }) }, 300_000).text, /placed by rule: some new rule$/);
});

test("open: at work for (work) or waiting for (waits), live, never an outcome", () => {
  const work = span({ start: 10_000, outcome: "built" });
  const d = M.durationSentence(work, 70_000);
  assert.equal(d.text, "at work for 1 min");
  assert.deepEqual(d.live, { startedAt: 10_000, mode: "work" });
  assert.equal(M.outcomeAsOf(work, 70_000), null);
  assert.equal(M.endedFact(work, 70_000).text, "Still open");
  const wait = span({ kind: "capacity-wait", entity: "cell:T-1", start: 10_000 });
  assert.equal(M.durationSentence(wait, 70_000).text, "waiting for 1 min");
  assert.equal(M.durationSentence(wait, 70_000).live.mode, "wait");
});

test("unknown: start not known, end not known; never extended", () => {
  const noStart = span({ start: null, finish: 50_000, duration: { ms: null, minMs: null, maxMs: null, basis: "unknown" } });
  assert.equal(M.durationSentence(noStart, 60_000).text, "start not known");
  assert.equal(M.beganFact(noStart, 60_000).text, "Not known: only its end is recorded");
  const noEnd = span({ start: 0, finish: end(null, { eventId: "e-x", reason: "unknown" }), duration: { ms: null, minMs: null, maxMs: null, basis: "unknown" } });
  assert.equal(M.durationSentence(noEnd, 60_000).text, "end not known");
  assert.equal(M.endedFact(noEnd, 60_000).text, "Not known; how it ended is not recorded");
  const unrecorded = { ...noEnd, end: end(null, { eventId: null, reason: null }) };
  assert.equal(M.endedFact(unrecorded, 60_000).state, "not-recorded");
  assert.equal(M.endedFact(unrecorded, 60_000).text, "Not recorded");
});

// ---------------------------------------------------------------- as of the playhead

test("a span that ends after the playhead is still open there, and its outcome does not show", () => {
  const s = span({ start: 0, finish: 100_000, outcome: "PASS" });
  assert.equal(M.outcomeAsOf(s, 99_999), null);
  assert.equal(M.endedFact(s, 99_999).state, "open");
  assert.equal(M.durationSentence(s, 60_000).text, "at work for 1 min");
  assert.equal(M.outcomeAsOf(s, 100_000), "PASS");
  assert.equal(M.durationSentence(s, 100_000).text, "took 1 min 40 s (measured)");
});

test("a span that begins after the playhead is not started there", () => {
  const s = span({ start: 50_000, finish: 60_000, outcome: "built" });
  assert.equal(M.durationSentence(s, 10_000).text, "Not started at the playhead");
  assert.equal(M.beganFact(s, 10_000).state, "not-started");
  assert.equal(M.outcomeAsOf(s, 10_000), null);
});

// ---------------------------------------------------------------- interruptions, attempts, rounds, agents, seats, waits

test("T4: a late exit is not a resumption: open for its span, exit recorded after its execution ended, never 'took'", () => {
  const v = span({ start: 0, finish: 300_000, attrs: { interruptedAt: 120_000 }, outcome: "built" });
  const text = M.durationSentence(v, 400_000, {}, clock).text;
  assert.equal(text, "open for 5 min; its exit was recorded after its execution ended (at t120000)");
  assert.doesNotMatch(text, /took|taken up|resum/);
  // While still open after the stop: open for, live, interrupted mode.
  const live = M.durationSentence(v, 200_000);
  assert.equal(live.live.mode, "interrupted");
  assert.equal(live.text, "open for 3 min 20 s");
  const superseded = span({ start: 0, finish: 60_000, reason: "superseded" });
  assert.equal(M.durationSentence(superseded, 70_000).text, "open for 1 min, then superseded");
  const interrupted = span({ kind: "execution", entity: "execution:x1", start: 0, finish: 60_000, reason: "interrupted" });
  assert.doesNotMatch(M.durationSentence(interrupted, 70_000).text, /took/);
});

test("attempt and round are said, and said to be different counts when both are present", () => {
  const both = span({ kind: "visit", ids: { round: "2" }, attrs: { attempt: 3 } });
  const r = M.attemptAndRound(both);
  assert.equal(r.attempt, 3);
  assert.equal(r.round, 2);
  assert.match(r.note, /different counts/);
  assert.equal(M.attemptAndRound(span({ attrs: { round: 1 } })).note, null);
});

test("a count-only agent: n tool calls reported as a count; individual calls are not observable", () => {
  const a = span({ kind: "agent", entity: "agent:x1/a7", attrs: { toolsCountOnly: true, toolCalls: 14 } });
  assert.equal(M.toolCallsWords(a), "14 tool calls reported as a count; individual calls are not observable");
  assert.equal(M.toolCallsWords({ ...a, attrs: { toolsCountOnly: true, toolCalls: 1 } }), "1 tool call reported as a count; individual calls are not observable");
  assert.equal(M.toolCallsWords(span({ kind: "agent", attrs: { toolCalls: 3 } })), null);
  // The agent's run stands for it before its queue.
  const queue = span({ kind: "agent-queue", entity: "agent:x1/a7", start: 0, finish: 5_000 });
  const run = { ...a, start: end(5_000), end: end(40_000, { reason: "completed" }), duration: { ms: 35_000, minMs: 35_000, maxMs: 35_000, basis: "measured" } };
  assert.equal(M.primarySpan("agent:x1/a7", [queue, run], 50_000).kind, "agent");
  assert.deepEqual(M.companionsOf("agent:x1/a7", run, [queue, run], 50_000).map((s) => s.kind), ["agent-queue"]);
  assert.equal(M.durationSentence(queue, 50_000).text, "took 5 s (measured)");
});

test("a seat's verdict is shown as its verdict, only once it was cast", () => {
  const seat = span({ kind: "seat", entity: "seat:T-1/review#1/security", parent: "gate:T-1/review#1", start: 0, finish: 90_000, outcome: "REJECT", attrs: { vote: "REJECT", round: 1 } });
  assert.equal(M.outcomeLabel(seat), "Verdict");
  assert.equal(M.outcomeAsOf(seat, 89_000), null);
  assert.equal(M.outcomeAsOf(seat, 90_000), "REJECT");
});

test("a person wait still open: waiting for a person, waiting for n, no outcome", () => {
  const w = span({ kind: "person-wait", entity: "gate:T-1/human", parent: "cell:T-1", start: 0 });
  assert.equal(M.primarySpan("gate:T-1/human", [w], 600_000), w);
  assert.equal(M.endedFact(w, 600_000).text, "Still open: waiting for a person");
  assert.equal(M.durationSentence(w, 600_000).text, "waiting for 10 min");
  assert.equal(M.durationSentence(w, 600_000).live.mode, "wait");
});

test("a dependency wait: with a recorded cause, and with the relationship recorded but not the cause", () => {
  const ref = "dependency:SLICE-024->SLICE-021";
  const withCause = span({ kind: "slice-wait", entity: "slice:SLICE-024", parent: "slice:SLICE-024", start: 0, finish: 30_000, attrs: { dependsOn: ["SLICE-021"] } });
  assert.equal(M.primarySpan(ref, [withCause], 40_000), withCause);
  assert.equal(M.dependencyWords(ref, withCause), "SLICE-024 waited on SLICE-021, as recorded with the wait.");
  const noCause = { ...withCause, attrs: {} };
  assert.equal(M.primarySpan(ref, [noCause], 40_000), noCause);
  assert.equal(M.dependencyWords(ref, noCause), "SLICE-024 depends on SLICE-021: the relationship is recorded; what this wait was waiting on is not recorded.");
  const other = { ...withCause, attrs: { dependsOn: ["SLICE-030"] } };
  assert.equal(M.primarySpan(ref, [other], 40_000), null);
  assert.equal(M.dependencyWords(ref, null), "SLICE-024 depends on SLICE-021: the relationship is recorded; no wait on it is recorded.");
});

// ---------------------------------------------------------------- which span, parent, children, neighbours

test("refs map to span ids and queries without parsing opaque ids", () => {
  assert.deepEqual(M.exactSpanIds("cell:T-1"), ["cell:cell:T-1"]);
  assert.deepEqual(M.exactSpanIds("visit:T-1/build#2"), ["visit:visit:T-1/build#2"]);
  assert.deepEqual(M.exactSpanIds("slice:S-1"), []);
  assert.equal(M.queryHintOf(null, "cell:T-1"), "ticket:T-1");
  assert.equal(M.queryHintOf(null, "seat:T-1/review#2/security"), "ticket:T-1");
  assert.equal(M.queryHintOf(null, "workflow:x1/w2"), "execution:x1");
  assert.equal(M.queryHintOf(null, "agent:x1/a7"), "", "an agent id is opaque: no scene, no narrowing");
  assert.deepEqual(M.queryOf("execution:x1", { from: 0, to: 9 }), { window: { from: 0, to: 9 }, execution: "x1" });
  assert.equal(M.hasTimeSection("station:build"), true, "a station on its own lists its visits across cells");
  assert.equal(M.queryHintOf(null, "station:build"), "kinds:visit");
  assert.deepEqual(M.queryOf("kinds:visit", { from: 0, to: 1 }), { window: { from: 0, to: 1 }, kinds: ["visit"] });
  assert.equal(M.hasTimeSection("station:T-1/build"), true);
  assert.equal(M.hasTimeSection("finding:T-1/r1/security/1"), false);
});

test("a station visit stands for its station's latest visit begun by the playhead", () => {
  const v1 = span({ entity: "visit:T-1/build#1", ids: { station: "build", ticket_id: "T-1" }, start: 0, finish: 60_000 });
  const v2 = span({ entity: "visit:T-1/build#2", ids: { station: "build", ticket_id: "T-1" }, start: 120_000, finish: 180_000 });
  const verify = span({ entity: "visit:T-1/verify#1", ids: { station: "verify", ticket_id: "T-1" }, start: 70_000, finish: 100_000 });
  const all = [v1, v2, verify];
  assert.equal(M.primarySpan("station:T-1/build", all, 90_000), v1);
  assert.equal(M.primarySpan("station:T-1/build", all, 130_000), v2);
  const n = M.neighboursOf(v2, all, 200_000);
  assert.equal(n.before.span, v1);
  assert.equal(n.before.words, "It started 1 min after the previous ended");
  assert.equal(n.after, null);
  // The next visit does not show before the playhead reaches it.
  assert.equal(M.neighboursOf(v1, all, 90_000).after, null);
  assert.equal(M.neighboursOf(v1, all, 130_000).after.words, "The next started 1 min after this ended");
});

test("gap words: overlap, touching, still open, unknown; and the order note never claims a cause", () => {
  const a = span({ entity: "tool:a", kind: "tool", parent: "agent:x", start: 0, finish: 10_000 });
  const b = span({ entity: "tool:b", kind: "tool", parent: "agent:x", start: 5_000, finish: 20_000 });
  const c = span({ entity: "tool:c", kind: "tool", parent: "agent:x", start: 20_300, finish: 30_000 });
  assert.equal(M.gapWords(a, b, 40_000, "before"), "It started 5 s before the previous ended");
  assert.equal(M.gapWords(b, c, 40_000, "after"), "The next started as this ended");
  assert.equal(M.gapWords(a, b, 8_000, "before"), "It started while the previous was still open");
  assert.match(M.gapWords(a, { ...c, start: end(null, { notBefore: 21_000 }) }, 40_000, "before"), /not known/);
  assert.doesNotMatch(M.ORDER_NOTE, /because|caused by|led to/);
  assert.match(M.ORDER_NOTE, /does not mean one caused the other/);
});

test("parent and children: the latest 8 begun by the playhead and a count of the rest", () => {
  const exec = span({ kind: "execution", entity: "execution:x1", parent: "cell:T-1", start: 0 });
  const cell = span({ kind: "cell", entity: "cell:T-1", start: 0 });
  const tools = Array.from({ length: 11 }, (_, i) => span({ kind: "agent", entity: `agent:x1/a${i}`, parent: "execution:x1", start: 1_000 * (i + 1), finish: 1_000 * (i + 1) + 500 }));
  const all = [cell, exec, ...tools];
  assert.equal(M.parentSpanOf(exec, all, 60_000), cell);
  const kids = M.childrenOf(exec, all, 60_000);
  assert.equal(kids.shown.length, 8);
  assert.equal(kids.rest, 3);
  assert.equal(kids.shown[0].entity, "agent:x1/a3");
  assert.equal(M.childrenOf(exec, all, 2_500).shown.length, 2);
  // A cell's capacity waits share its entity: companions, not children.
  const cap = span({ kind: "capacity-wait", entity: "cell:T-1", parent: "cell:T-1", start: 100, finish: 900, id: "capacity-wait:cell:T-1@e1" });
  assert.equal(M.primarySpan("cell:T-1", [cap, cell], 60_000), cell);
  assert.deepEqual(M.childrenOf(cell, [cap, cell, exec], 60_000).shown, [exec]);
  assert.deepEqual(M.companionsOf("cell:T-1", cell, [cap, cell], 60_000), [cap]);
});

// ---------------------------------------------------------------- evidence references

test("evidenceRefsOf: the artifacts the anatomies know, newest first, with the write and the checks that cite them", () => {
  const { SCENARIO, finalScene } = sim;
  const scene = finalScene(SCENARIO);
  const cell = Object.values(scene.cells).find((c) => c.artifacts.length > 1);
  assert.ok(cell, "the scenario writes artifacts");
  const refs = M.evidenceRefsOf(scene, `cell:${cell.ticketId}`);
  assert.equal(refs.length, cell.artifacts.length);
  for (const r of refs) assert.match(r.producedBy, /^sim:\d+$/);
  const times = refs.map((r) => cell.artifacts.find((a) => a.id === r.artifactId).writtenAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const a = cell.artifacts[0];
  const events = [
    { id: "v1", event: { type: "verify.check_recorded", data: { evidence: [{ file: a.path.split("/").pop() }] } } },
    { id: "v2", event: { type: "evidence.captured", data: { evidence: ["somewhere/else.png"] } } },
    { id: "v3", event: { type: "artifact.recorded", data: { evidence: [a.path] } } },
  ];
  const withChecks = M.evidenceRefsOf(scene, `cell:${cell.ticketId}`, events).find((r) => r.artifactId === a.id);
  assert.deepEqual(withChecks.verifiedBy, ["v1"], "a check naming its file verifies it; a record that is not a check does not");
  // By station, and nothing for a kind whose anatomy lists no artifacts.
  if (a.station) assert.ok(M.evidenceRefsOf(scene, `station:${cell.ticketId}/${a.station}`).some((r) => r.artifactId === a.id));
  assert.deepEqual(M.evidenceRefsOf(scene, "wave:nothing"), []);
});

// ---------------------------------------------------------------- wave 2

test("the outcome is compared with the playhead (order time), never one event late: two events in the same millisecond", () => {
  // Two events at t=60 000: the visit's exit and the next entry. Applying only the first leaves the
  // scene's last-applied time at 60 000 either way; the outcome follows the playhead, not that.
  const a = span({ entity: "visit:T-1/build#1", ids: { station: "build", ticket_id: "T-1" }, start: 0, finish: 60_000, outcome: "built" });
  const b = span({ entity: "visit:T-1/verify#1", ids: { station: "verify", ticket_id: "T-1" }, start: 60_000, finish: null });
  assert.equal(M.outcomeAsOf(a, 59_999), null, "not before its event");
  assert.equal(M.outcomeAsOf(a, 60_000), "built", "at the playhead's millisecond, with the other event of that millisecond");
  assert.equal(M.durationSentence(b, 60_000).text, "at work for under a second");
  assert.equal(M.outcomeAsOf(b, 60_000), null);
});

test("a station on its own lists its visits across cells in time order, the latest 12 and a count of the rest", () => {
  const visits = Array.from({ length: 15 }, (_, i) => span({ entity: `visit:T-${i % 3}/build#${i}`, id: `visit:v${i}`, ids: { station: "build", ticket_id: `T-${i % 3}` }, start: i * 60_000, finish: i * 60_000 + 30_000 }));
  const verify = span({ entity: "visit:T-0/verify#1", ids: { station: "verify", ticket_id: "T-0" }, start: 5_000, finish: 6_000 });
  const { shown, rest } = M.stationVisitsAcross("station:build", [...visits, verify], 20 * 60_000);
  assert.equal(shown.length, 12);
  assert.equal(rest, 3);
  assert.deepEqual(shown.map((s) => s.id), visits.slice(3).map((s) => s.id), "in time order, latest 12");
  assert.equal(M.stationVisitsAcross("station:build", visits, 90_000).shown.length, 2, "only those begun by the playhead");
  assert.ok(M.isStationAcrossCells("station:build") && !M.isStationAcrossCells("station:T-1/build"));
});

test("rule words: the Timeline's rules are worded, merged at the call site with the shared words first", () => {
  const shared = { "unclosed-visit": "SHARED" };
  const merged = { ...M.TIMELINE_RULE_WORDS, ...shared };
  assert.equal(M.ruleWords("previous-completion", merged), "it began when the previous task completed");
  assert.equal(M.ruleWords("execution-ended", merged), "bounded by its execution's end: it never recorded an exit");
  assert.equal(M.ruleWords("unclosed-visit", merged), "SHARED", "the shared vocabulary wins");
  assert.equal(M.ruleWords("execution-ended"), "bounded by its execution's end: it never recorded an exit", "worded even without the shared words");
});

test("an ended-without-exit visit: 'ended without an exit record, within <d>', never an outcome, never 'took'", () => {
  for (const [rule, reason] of [["execution-ended", "interrupted"], ["unclosed-visit", "superseded"]]) {
    const v = span({
      start: 0,
      finish: end(136_000, { basis: "inferred", rule, reason }),
      duration: { ms: null, minMs: null, maxMs: 136_000, basis: "inferred" },
      outcome: "built",
    });
    assert.ok(M.endedWithoutExit(v));
    const d = M.durationSentence(v, 7 * 3_600_000).text;
    assert.equal(d, "ended without an exit record, within 2 min 16 s");
    assert.doesNotMatch(d, /took|at work/);
    assert.equal(M.outcomeAsOf(v, 7 * 3_600_000), null, "no record says how it went");
    assert.match(M.endedFact(v, 7 * 3_600_000, RULES, clock).text, /ended without an exit record/);
  }
  // No bound at all: said so.
  const unbounded = span({ start: end(null, { notBefore: null }), finish: end(136_000, { basis: "inferred", rule: "execution-ended", reason: "interrupted" }), duration: { ms: null, minMs: null, maxMs: null, basis: "inferred" } });
  assert.equal(M.durationSentence({ ...unbounded, start: null }, 200_000).text, "ended without an exit record; how long is not known");
  // A task placed by rule is not a visit: it keeps "about, placed by rule".
  const task = span({ kind: "task", start: end(0, { basis: "inferred", rule: "previous-completion" }), finish: 60_000, duration: { ms: 60_000, minMs: null, maxMs: null, basis: "inferred" } });
  assert.equal(M.endedWithoutExit(task), false);
  assert.match(M.durationSentence(task, 100_000).text, /^about 1 min, placed by rule: it began when the previous task completed$/);
});

test("evidence references carry the catalog id, the producing event and the verifying events (stable for M6.4)", async () => {
  const scene = sim.fixtureLog(sim.SCENARIO).head();
  const cell = Object.values(scene.cells).find((c) => c.artifacts.length > 0);
  const refs = M.evidenceRefsOf(scene, `cell:${cell.ticketId}`);
  for (const r of refs) {
    assert.deepEqual(Object.keys(r).sort(), ["artifactId", "producedBy", "verifiedBy"]);
    assert.ok(cell.artifacts.some((a) => a.id === r.artifactId), "a catalog id the scene knows");
  }
  const src = (await import("node:fs")).readFileSync(new URL("../src/timeline/inspector/InTimeSection.tsx", import.meta.url), "utf8");
  assert.match(src, /data-evidence-artifact=\{r\.artifactId\}/);
  assert.match(src, /M6\.4 will make these references open the Evidence Theater/);
});

// ---------------------------------------------------------------- round 4: X2 (open is not at work), X3 (the picked span)

test("X2: an open cell, wave, slice or round is 'open', never 'at work'; work kinds and visits (not human approval) are at work", () => {
  for (const kind of ["cell", "wave", "round", "claim"]) {
    const d = M.durationSentence(span({ kind, entity: `${kind}:X`, start: 0 }), 600_000);
    assert.equal(d.text, "open 10 min", kind);
    assert.equal(d.live.mode, "open");
  }
  for (const kind of ["execution", "workflow", "agent", "tool", "task"]) assert.equal(M.durationSentence(span({ kind, entity: `${kind}:X`, start: 0 }), 60_000).live.mode, "work", kind);
  assert.equal(M.durationSentence(span({ ids: { station: "build" }, start: 0 }), 60_000).live.mode, "work");
  assert.equal(M.durationSentence(span({ ids: { station: "human-approval" }, start: 0 }), 60_000).live.mode, "open");
});

test("X2: an open cell says its last activity and since when it waits for a person", () => {
  const cell = span({ kind: "cell", entity: "cell:L-1", ids: { ticket_id: "L-1" }, start: 0 });
  const visit = span({ entity: "visit:L-1/review#2", parent: "execution:x3", ids: { ticket_id: "L-1", station: "review" }, start: 1_000, finish: 4_000 });
  const exec = span({ kind: "execution", entity: "execution:x3", ids: { ticket_id: "L-1" }, start: 500, finish: 4_200 });
  const wait = span({ kind: "person-wait", entity: "gate:L-1/supervisor", ids: { ticket_id: "L-1" }, start: 4_100 });
  const other = span({ kind: "execution", entity: "execution:y", ids: { ticket_id: "OTHER" }, start: 9_000, finish: 9_500 });
  const ctx = M.openContextOf(cell, [cell, visit, exec, wait, other], 10_000);
  assert.deepEqual(ctx, { lastActivity: 4_200, waitingSince: 4_100 });
  assert.equal(M.openContextWords(ctx, clock), "; last activity t4200; waiting for a person since t4100");
  // As of a playhead before the wait began: no wait.
  assert.equal(M.openContextOf(cell, [cell, visit, exec, wait], 4_050).waitingSince, null);
  assert.equal(M.openContextWords({ lastActivity: null, waitingSince: null }, clock), "");
});

test("X3: the span picked through an ancestor is the subject, headlined with its own state and time", () => {
  const r1 = span({ entity: "visit:L/verify#1", ids: { ticket_id: "L", station: "verify", round: "1" }, start: 1_000, finish: 5_000, reason: "failed", outcome: "failed" });
  const r2 = span({ entity: "visit:L/verify#2", ids: { ticket_id: "L", station: "verify", round: "2" }, start: 8_000, finish: 9_000, outcome: "passed" });
  const latest = M.subjectSpan("station:L/verify", null, [r1, r2], 10_000);
  assert.equal(latest.span.entity, "visit:L/verify#2");
  assert.equal(latest.picked, false);
  const picked = M.subjectSpan("station:L/verify", "visit:L/verify#1", [r1, r2], 10_000);
  assert.equal(picked.span.entity, "visit:L/verify#1");
  assert.equal(picked.picked, true);
  assert.equal(M.spanHeadline(picked.span, 10_000, clock), "Verify, round 1 — failed, t1000–t5000");
  // Before its end the outcome is not said.
  assert.equal(M.spanHeadline(r1, 3_000, clock), "Verify, round 1 — at work, from t1000");
  // A detail not held falls back to the ref's own span.
  assert.equal(M.subjectSpan("station:L/verify", "visit:L/verify#9", [r1, r2], 10_000).span.entity, "visit:L/verify#2");
});

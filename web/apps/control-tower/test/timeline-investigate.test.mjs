// M6.3 investigation lenses (src/timeline/investigate/model.ts and lenses.ts): the build → verify
// ladder with rounds and execution attempts crossing each other, comparison differences only from
// records, dependency links only when the dependency's instant is in the data, a person's approval of
// the code kept apart from the authorization to merge, and "resumed" only when a later record shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const M = await import("../src/timeline/investigate/model.ts");
const L = await import("../src/timeline/investigate/lenses.ts");
const { buildTrackTree } = await import("../src/timeline/tracks/build.ts");

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 5, 0, 0);
const t = (m, s = 0) => T0 + m * MIN + s * 1000;
const LIVE = t(200);

const end = (at, extra = {}) => ({ eventId: at === null ? null : `e-${at}`, at, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null, ...extra });

function span({ id, kind, entity, parent = null, ids = {}, start, finish = null, reason = "completed", outcome = null, attrs = {}, endExtra = {} }) {
  const e = finish === null ? null : end(finish, { reason, ...endExtra });
  return {
    id: id ?? `${kind}:${entity}`,
    kind,
    entity,
    parent,
    ids,
    start: start === null ? null : end(start),
    end: e,
    duration: { ms: finish !== null && start !== null ? finish - start : null, minMs: null, maxMs: null, basis: finish === null ? "open" : e.basis === "inferred" ? "inferred" : "measured" },
    outcome,
    authority: "authoritative",
    attrs,
  };
}

const visit = (ticket, station, n, from, to, { round = 1, exec = null, outcome = "completed", action = station, reason = "completed", endExtra = {}, attrs = {} } = {}) =>
  span({ kind: "visit", entity: `visit:${ticket}/${station}#${n}`, parent: exec ? `execution:${exec}` : null, ids: { ticket_id: ticket, station, round: String(round), ...(exec ? { execution_id: exec } : {}) }, start: from, finish: to, outcome, reason, attrs: { action, round, ...attrs }, endExtra });

const execution = (id, ticket, attempt, from, to, { reason = "completed", outcome = "completed" } = {}) =>
  span({ kind: "execution", entity: `execution:${id}`, parent: `cell:${ticket}`, ids: { ticket_id: ticket, execution_id: id, attempt: String(attempt) }, start: from, finish: to, reason, outcome, attrs: { attempt } });

const mark = (id, kind, at, entity, label, verdict = null, until = null) => ({ id, kind, at, until, eventId: `ev-${id}`, entity, label, verdict, authority: "authoritative" });

// One cell, three passes through build → verify. Round 1 holds passes 1 and 2 (pass 2's build is a
// revise), round 2 holds pass 3. Execution attempt 1 ran pass 1 and pass 2's revise; attempt 2 began
// mid-pass with pass 2's verification and ran pass 3. Rounds and attempts cross.
const TK = "LOCAL-031";
const spansA = [
  execution("x1", TK, 1, t(0), t(30), { reason: "interrupted", outcome: "interrupted" }),
  execution("x2", TK, 2, t(32), t(90)),
  visit(TK, "build", 1, t(1), t(10), { exec: "x1" }),
  visit(TK, "verify", 1, t(11), t(15), { exec: "x1", outcome: "FAIL_WITH_EVIDENCE", reason: "failed" }),
  visit(TK, "build", 2, t(16), t(25), { exec: "x1", action: "revise" }),
  visit(TK, "verify", 2, t(33), t(36), { exec: "x2" }),
  visit(TK, "review", 1, t(37), t(45), { exec: "x2" }),
  visit(TK, "build", 3, t(46), t(55), { exec: "x2", action: "revise", round: 2 }),
  visit(TK, "verify", 3, t(56), t(60), { exec: "x2", round: 2 }),
  span({ kind: "round", entity: `gate:${TK}/round#1`, parent: `cell:${TK}`, ids: { ticket_id: TK }, start: t(1), finish: t(45), reason: "failed", outcome: "REJECTED", attrs: { round: 1 } }),
  span({ kind: "round", entity: `gate:${TK}/round#2`, parent: `cell:${TK}`, ids: { ticket_id: TK }, start: t(46), finish: null, attrs: { round: 2 } }),
];
const marksA = [
  mark("g1", "failure", t(15), `visit:${TK}/verify#1`, "Verification ended FAIL_WITH_EVIDENCE: 3 of 5 checks.", "fail_with_evidence"),
  mark("g2", "gate", t(36), `visit:${TK}/verify#2`, "Gate verify.verdict passed (5 of 5 checks).", "passed"),
  mark("g3", "gate", t(60), `visit:${TK}/verify#3`, "Gate verify.verdict passed.", "passed"),
];

test("the ladder: one rung per pass, verdicts from marks, what followed from the next visit", () => {
  const l = M.ladderOf(TK, spansA, marksA, LIVE);
  assert.equal(l.rungs.length, 3);
  assert.deepEqual(l.rungs.map((r) => r.verdict.kind), ["failed", "passed", "passed"]);
  assert.deepEqual(l.rungs.map((r) => r.followed.kind), ["revise", "review", "nothing-yet"]);
  assert.equal(l.rungs[0].verdict.checks, "3 of 5 checks");
  assert.equal(l.rungs[0].verdict.mark.id, "g1");
});

test("rounds and execution attempts are laid over the slots independently and cross each other", () => {
  const l = M.ladderOf(TK, spansA, marksA, LIVE);
  // Slots: 0 b1, 1 v1, 2 b2, 3 v2, 4 b3, 5 v3.
  assert.deepEqual(l.rounds.map((r) => [r.label, r.fromSlot, r.toSlot]), [["Round 1", 0, 3], ["Round 2", 4, 5]]);
  assert.deepEqual(l.attempts.map((r) => [r.label, r.fromSlot, r.toSlot]), [["Run 1 of 2", 0, 2], ["Run 2 of 2", 3, 5]]);
  assert.deepEqual(l.attempts.map((r) => r.attempt), [1, 2], "the supervisor's attempt number is kept for the hover card only");
  // Attempt 2 begins inside round 1 and runs into round 2: neither contains the other.
  const a2 = l.attempts[1];
  assert.ok(a2.fromSlot <= l.rounds[0].toSlot && a2.toSlot > l.rounds[0].toSlot && l.attempts[0].toSlot < l.rounds[0].toSlot);
  assert.equal(l.attempts[0].endReason, "interrupted");
});

test("execution rails are named by run, like the tracks, even when the supervisor's attempt number repeats", () => {
  const spans = [
    execution("y1", "T-9", 1, t(0), t(10), { reason: "interrupted", outcome: "interrupted" }),
    execution("y2", "T-9", 1, t(12), t(30)),
    visit("T-9", "build", 1, t(1), t(9), { exec: "y1" }),
    visit("T-9", "verify", 1, t(13), t(20), { exec: "y2" }),
  ];
  const l = M.ladderOf("T-9", spans, [], LIVE);
  assert.deepEqual(l.attempts.map((r) => [r.label, r.attempt]), [["Run 1 of 2", 1], ["Run 2 of 2", 1]]);
  // Not yet started by the live edge: not counted.
  assert.deepEqual(M.ladderOf("T-9", spans, [], t(11)).attempts.map((r) => r.label), ["The only run"]);
});

test("comparison states differences only where both records carry the fact", () => {
  const l = M.ladderOf(TK, spansA, marksA, LIVE);
  const [r1, r2, r3] = l.rungs;
  const d12 = M.compareRungs(r1, r2, l);
  assert.ok(d12.some((s) => /Verdict: pass 1 failed, pass 2 passed/.test(s)));
  assert.ok(d12.some((s) => /Checks recorded: pass 1 3 of 5 checks, pass 2 5 of 5 checks/.test(s)));
  assert.ok(d12.some((s) => /What followed: pass 1 went to a revise visit, pass 2 to review/.test(s)));
  assert.ok(d12.some((s) => /Execution: pass 1 ran in run 1 of 2, pass 2 in run 2 of 2/.test(s)));
  // Pass 3's checks are not recorded and nothing followed it yet: neither is compared.
  const d23 = M.compareRungs(r2, r3, l);
  assert.ok(!d23.some((s) => /Checks/.test(s)));
  assert.ok(!d23.some((s) => /What followed/.test(s)));
  assert.ok(!d23.some((s) => /Verdict/.test(s)), "both passed: no verdict difference");
  assert.ok(d23.some((s) => /Review round: pass 2 in round 1, pass 3 in round 2/.test(s)));
  // Relative timings start at each pass's first event.
  const tm = M.rungTimings(r2, LIVE);
  assert.deepEqual(tm.map((x) => [x.part, x.from, x.to]), [["build", 0, 9 * MIN], ["verify", 17 * MIN, 20 * MIN]]);
});

test("a verdict with no mark and no recorded outcome is 'none', never guessed", () => {
  const spans = [visit("T-2", "build", 1, t(0), t(5)), visit("T-2", "verify", 1, t(6), t(9), { outcome: null })];
  const l = M.ladderOf("T-2", spans, [], LIVE);
  assert.equal(l.rungs[0].verdict.kind, "none");
  // A recorded outcome on the visit is used, and named as its source.
  const spans2 = [visit("T-2", "build", 1, t(0), t(5)), visit("T-2", "verify", 1, t(6), t(9), { outcome: "PASS" })];
  const v = M.ladderOf("T-2", spans2, [], LIVE).rungs[0].verdict;
  assert.equal(v.kind, "passed");
  assert.match(v.sources[0].what, /recorded outcome/);
  // Not before the live edge: a verdict recorded after it is not known yet.
  const early = M.ladderOf(TK, spansA, marksA, t(14)).rungs[0];
  assert.equal(early.verdict.kind, "none");
});

test("retries: unselected shows only cells with retries, selected shows that cell", () => {
  const plain = [visit("T-9", "build", 1, t(0), t(5)), visit("T-9", "verify", 1, t(6), t(9), { outcome: "PASS" })];
  const all = [...spansA, ...plain];
  assert.deepEqual(M.retryLadders(all, marksA, LIVE, null).ladders.map((l) => l.ticket), [TK]);
  assert.deepEqual(M.retryLadders(all, marksA, LIVE, "T-9").ladders.map((l) => l.ticket), ["T-9"]);
});

test("dependency links only to instants in the data, and the release is never attributed", () => {
  const wait = (n, from, to, deps) => span({ id: `slice-wait:slice:S-3${n > 1 ? `#${n}` : ""}`, kind: "slice-wait", entity: "slice:S-3", parent: "slice:S-3", ids: { slice_id: "S-3" }, start: from, finish: to, attrs: { dependsOn: deps, reasons: ["waiting on S-1"] } });
  const cellS1 = span({ kind: "cell", entity: "cell:T-1", ids: { ticket_id: "T-1", slice_id: "S-1" }, start: t(0), finish: t(20), outcome: "merged" });
  const items = M.waitItems([wait(1, t(1), t(21), ["S-1", "S-2"]), wait(2, t(30), null, ["S-2"]), cellS1], [], LIVE);
  assert.equal(items.length, 2);
  const [w1, w2] = items;
  assert.equal(w1.dependencies[0].slice, "S-1");
  assert.equal(w1.dependencies[0].instant.at, t(20));
  assert.equal(w1.dependencies[1].instant, null, "S-2 has no completion in the data: no link");
  assert.equal(w1.releaseNotRecorded, true);
  assert.equal(w2.to, null);
  assert.equal(w2.ended, null);
  // A merge mark of a cell of the slice is an instant too.
  const viaMark = M.waitItems([wait(1, t(1), t(21), ["S-2"]), span({ kind: "visit", entity: "visit:T-2/build#1", ids: { ticket_id: "T-2", slice_id: "S-2" }, start: t(0), finish: t(3) })], [mark("m", "merge", t(19), "cell:T-2", "The ticket's branch was merged.", "merged")], LIVE);
  assert.equal(viaMark[0].dependencies[0].instant.at, t(19));
});

const seat = (ticket, round, name, from, at, vote) => span({ kind: "seat", entity: `seat:${ticket}/review#${round}/${name}`, parent: `gate:${ticket}/review#${round}`, ids: { ticket_id: ticket, seat: name }, start: from, finish: at, reason: vote === "REJECT" ? "refused" : "completed", outcome: vote, attrs: { round, vote } });

test("review: seats, decision, a person's gate; approval of the code and merge authority kept apart", () => {
  const spans = [
    seat("T-4", 1, "architecture", t(0), t(5), "APPROVE"),
    seat("T-4", 1, "security", t(0), t(6), "REJECT"),
    seat("T-4", 1, "product", t(0), t(4), "APPROVE"),
    seat("T-4", 2, "architecture", t(20), t(24), "APPROVE"),
    seat("T-4", 2, "security", t(20), t(25), "APPROVE"),
    seat("T-4", 2, "product", t(20), t(23), "APPROVE"),
    span({ kind: "gate-wait", entity: "gate:T-4/human-approval", parent: "cell:T-4", ids: { ticket_id: "T-4" }, start: t(26), finish: t(40), outcome: "passed", attrs: { round: 2 } }),
  ];
  const marks = [
    mark("d1", "review", t(7), "gate:T-4/review#1", "Review round 1 decided REJECTED (security veto).", "rejected"),
    mark("d2", "review", t(26), "gate:T-4/review#2", "Review round 2 decided AWAITING_HUMAN.", "awaiting-human"),
    mark("h1", "human", t(40), "cell:T-4", "A person recorded an approval.", "approved"),
    mark("mg", "merge", t(45), "cell:T-4", "Merged by the merge policy (auto, medium risk).", "merged"),
  ];
  const [c] = M.reviewCells(spans, marks, LIVE);
  assert.equal(c.rounds.length, 2);
  assert.ok(c.rounds[0].securityVeto, "the decision records a security veto");
  assert.equal(c.rounds[1].securityVeto, null);
  assert.equal(c.rounds[0].human, null);
  assert.equal(c.rounds[1].human.approved.at, t(40));
  assert.equal(c.codeApproval.at, t(40));
  assert.equal(c.merge.authority, "policy");
  assert.deepEqual(c.notes, []);
  // Only the approval recorded: the merge authorization is said to be not recorded.
  const [onlyApproval] = M.reviewCells(spans, marks.filter((m) => m.kind !== "merge"), LIVE);
  assert.equal(onlyApproval.merge, null);
  assert.ok(onlyApproval.notes.some((n) => /authorization to merge is not recorded/.test(n)));
  // Only a bare merge recorded: no approval claimed, and its authority not invented.
  const [onlyMerge] = M.reviewCells(spans.filter((s) => s.kind === "seat"), [marks[0], marks[1], mark("mg2", "merge", t(45), "cell:T-4", "The ticket's branch was merged.", "merged")], LIVE);
  assert.equal(onlyMerge.codeApproval, null);
  assert.equal(onlyMerge.merge.authority, "not-recorded");
  assert.ok(onlyMerge.notes.some((n) => /No approval of the code by a person/.test(n)));
  // A rejection without a recorded veto is not called one.
  const [noVeto] = M.reviewCells(spans, [mark("d1", "review", t(7), "gate:T-4/review#1", "Review round 1 decided REJECTED.", "rejected")], LIVE);
  assert.equal(noVeto.rounds[0].securityVeto, null);
});

test("recovery: unknown outcomes stay unknown; 'resumed' only from a later record", () => {
  const spans = [
    execution("x1", "T-5", 1, t(0), t(10), { reason: "interrupted", outcome: "interrupted" }),
    span({ kind: "claim", entity: "execution:x2", parent: "cell:T-5", ids: { ticket_id: "T-5" }, start: t(12), finish: t(13) }),
    execution("x2", "T-5", 2, t(13), t(30)),
    execution("x3", "T-6", 1, t(0), t(20), { reason: "unknown", outcome: "unknown" }),
    visit("T-6", "build", 1, t(1), t(20), { exec: "x3", reason: "unknown", outcome: null, endExtra: { basis: "inferred", rule: "execution-ended" } }),
    visit("T-5", "build", 2, t(14), t(28), { exec: "x2", attrs: { interruptedAt: t(18) } }),
  ];
  const marks = [mark("r1", "recovery", t(11), "execution:x1", "The supervisor started a recovery (interrupted).", "interrupted"), mark("r2", "recovery", t(21), "execution:x3", "The supervisor started a recovery (outcome-unknown).", "outcome-unknown")];
  const { items, looseRecoveries } = M.recoveryItems(spans, marks, LIVE);
  const byRef = Object.fromEntries(items.map((i) => [i.span.entity, i]));
  assert.equal(byRef["execution:x1"].kind, "interrupted");
  assert.equal(byRef["execution:x1"].resumed.ref, "execution:x2");
  assert.match(byRef["execution:x1"].resumed.words, /run 2 of 2/);
  assert.equal(byRef["execution:x1"].label, "T-5 · run 1 of 2");
  assert.equal(byRef["execution:x1"].recoveries[0].id, "r1");
  assert.equal(byRef["execution:x3"].kind, "unknown");
  assert.equal(byRef["execution:x3"].resumed, null, "nothing later took T-6 up again");
  assert.equal(byRef["visit:T-6/build#1"].kind, "no-exit");
  assert.equal(byRef["visit:T-6/build#1"].resumed, null);
  // T4: an exit recorded after the execution ended is not a resumption; resumed only by a later record.
  assert.equal(byRef["visit:T-5/build#2"].kind, "late-exit");
  assert.notEqual(byRef["visit:T-5/build#2"].resumed?.ref, "visit:T-5/build#2", "never resumed by itself");
  assert.equal(looseRecoveries.length, 0);
  // Before the next attempt is held, the interrupted execution is not resumed.
  const early = M.recoveryItems(spans, marks, t(11, 30)).items.find((i) => i.span.entity === "execution:x1");
  assert.equal(early.resumed, null);
});

test("concurrency: stepped counts, max_parallel only as recorded, lanes per cell", () => {
  const series = {
    from: t(0),
    to: t(30),
    bucketMs: 10 * MIN,
    complete: true,
    limits: [{ name: "max_parallel", value: 3, from: t(0), to: null }, { name: "poll_seconds", value: 300, from: t(0), to: null }],
    buckets: [
      { from: t(0), active: { execution: { max: 1, mean: 1 } } },
      { from: t(10), active: { execution: { max: 3, mean: 2 }, visit: { max: 2, mean: 1 } } },
      { from: t(20), active: { execution: { max: 3, mean: 3 } } },
    ],
  };
  const spans = [span({ kind: "capacity-wait", entity: "cell:T-7", parent: "cell:T-7", ids: { ticket_id: "T-7" }, start: t(12), finish: t(18) }), span({ kind: "claim", entity: "execution:x9", parent: "cell:T-7", ids: { ticket_id: "T-7" }, start: t(18), finish: t(19) })];
  const v = M.concurrencyView(series, spans, { from: t(0), to: t(30) }, LIVE);
  assert.deepEqual(v.limits.map((l) => l.value), [3]);
  const ex = v.lines.find((l) => l.kind === "execution");
  assert.deepEqual(ex.steps.map((s) => s.count), [1, 3]);
  assert.equal(ex.peak, 3);
  assert.equal(v.lanes[0].ref, "cell:T-7");
  assert.deepEqual(v.lanes[0].segments.map((s) => s.kind), ["capacity", "claim"]);
  const none = M.concurrencyView({ ...series, limits: [] }, [], { from: t(0), to: t(30) }, LIVE);
  assert.equal(none.limits.length, 0);
});

test("lens definitions: five, each with one sentence, and presets set the grouping", () => {
  assert.deepEqual(L.LENSES.map((l) => l.id), ["retries", "concurrency", "waits", "review", "recovery"]);
  for (const l of L.LENSES) assert.match(l.about, /^[A-Z][^.]*\.$/);
  const tree = { grouping: "product", roots: [{ id: `cell:${TK}`, kind: "cell", ref: null, label: TK, detail: null, depth: 0, parentId: null, children: [], lanes: [{ spans: spansA }], ribbons: [], spanCount: spansA.length, attention: "none", note: null }], byId: new Map(), ofSpan: new Map(), tracksOf: () => [] };
  const view = { window: null, grouping: "execution", expanded: ["keep"], filters: { tickets: [], executions: [], slices: [], stations: [], kinds: [], attentionOnly: true }, table: false, lens: null };
  const r = L.LENSES[0].preset(tree, view);
  assert.equal(r.grouping, "product");
  for (const id of ["keep", `cell:${TK}`, `station:${TK}/build`, `station:${TK}/verify`]) assert.ok(r.expanded.includes(id), id);
  assert.ok(!r.expanded.includes(`cell:${TK}/review`), "no review row without seats: not stored");
  assert.equal(L.LENSES[1].preset(tree, view).filters.attentionOnly, false);
  // Recovery shows every execution: failures elsewhere (rounds, seats) have no row in that grouping.
  assert.equal(L.LENSES[4].preset(tree, view).filters.attentionOnly, false);
  // A preset stores only rows that exist: the waits lens opens no row its own kinds filter removes.
  const waits = L.LENSES[2].preset(tree, { ...view, expanded: [] });
  const shown = buildTrackTree(L.spansOfTree(tree), "product", { ...waits.filters, attentionOnly: false }, Number.MAX_SAFE_INTEGER);
  for (const id of waits.expanded) assert.ok(shown.byId.has(id), id);
  assert.equal(L.LENSES[4].preset(tree, view).grouping, "execution");
});

test("figures: the accessible name starts with the visible words when the description lacks them (WCAG 2.5.3)", async () => {
  const { figureName } = M;
  assert.equal(figureName("Round 1 of LOCAL-031, rejected", "Round 1"), "Round 1 of LOCAL-031, rejected");
  assert.equal(figureName("Build visit, 4 min", "build #2"), "build #2: Build visit, 4 min");
  assert.equal(figureName("A wait", ""), "A wait");
});

// ---------------------------------------------------------------- round 4

test("T7: a passed verify.start is not a verdict; only verify.verdict, verify.finish or the verification gate decide", () => {
  const v = visit("L", "verify", 1, t(10), null);
  const start = mark("g1", "gate", t(10, 30), "visit:L/verify#1", "Gate verify.start passed.", "passed");
  assert.notEqual(M.verdictOf(v, "L", [start], t(30)).kind, "passed");
  const done = visit("L", "verify", 1, t(10), t(20));
  const verdict = mark("g2", "gate", t(20), "visit:L/verify#1", "Gate verify.verdict passed.", "passed");
  assert.equal(M.verdictOf(done, "L", [start, verdict], t(30)).kind, "passed");
  const sim = mark("g3", "gate", t(20), "gate:L/verification#1", "Gate verification passed.", "passed");
  assert.equal(M.verdictOf(done, "L", [sim], t(30)).kind, "passed");
  // A refusal of any verification gate still counts as refused.
  assert.equal(M.verdictOf(done, "L", [mark("g4", "gate", t(20), "visit:L/verify#1", "Gate verify.finish refused (incomplete-evidence).", "refused")], t(30)).kind, "refused");
});

test("T14: the supervisor stopping for a person is not the review's approval; the recovery lens says the line stopped for a person", () => {
  const seat = span({ kind: "seat", entity: "seat:L/review#1/security", ids: { ticket_id: "L", seat: "security" }, start: t(1), finish: t(3), attrs: { vote: "REJECT" } });
  const decision = mark("d1", "review", t(4), "gate:L/review#1", "Review round 1 decided REJECTED.", "rejected");
  const pw = span({ kind: "person-wait", entity: "gate:L/supervisor-stop", ids: { ticket_id: "L" }, start: t(5), finish: null });
  const stop = mark("h1", "human", t(5), "gate:L/supervisor-stop", "The supervisor stopped for a person.", "required");
  const cells = M.reviewCells([seat, pw], [decision, stop], t(20));
  assert.equal(cells[0].rounds[0].human, null, "no approval was required by the review");
  const gw = span({ kind: "gate-wait", entity: "gate:L/human-approval#1", ids: { ticket_id: "L" }, start: t(5), finish: t(8), outcome: "approved" });
  const asked = mark("h2", "human", t(5), "gate:L/human-approval#1", "The review asked for a person's approval.", "required", t(8));
  assert.notEqual(M.reviewCells([seat, gw], [decision, asked], t(20))[0].rounds[0].human, null);
  const rec = M.recoveryItems([pw], [], t(20)).items;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].kind, "person");
  assert.match(rec[0].label, /Stopped for a person · L/);
});

test("X15: each lens preset frames the padded extent of what it shows", () => {
  const tree = buildTrackTree(spansA, "product", { tickets: [], executions: [], slices: [], stations: [], kinds: [], attentionOnly: false }, LIVE);
  const view = { window: null, grouping: "product", expanded: [], filters: { tickets: [], executions: [], slices: [], stations: [], kinds: [], attentionOnly: false }, table: false, lens: null };
  const r = L.lensOf("retries").preset(tree, view);
  assert.ok(r.window, "the retries lens frames its visits");
  assert.ok(r.window.from < t(1) && r.window.from >= t(1) - 4 * MIN);
  assert.ok(r.window.to > t(60) && r.window.to <= t(60) + 4 * MIN);
  const c = L.lensOf("concurrency").preset(tree, view);
  assert.ok(c.window.from <= t(0) && c.window.to >= t(90));
  assert.deepEqual(M.frameOf([]), null);
  for (const l of L.LENSES) assert.match(l.label, /\?$/, `${l.id} leads with a question (X17)`);
});

test("T9, X14: concurrency keeps the inferred part of cells in a station apart, and leaves headroom above the peak", () => {
  const series = {
    from: t(0), to: t(4), bucketMs: MIN, complete: true, limits: [{ name: "max_parallel", value: 2, from: t(0), to: null }],
    buckets: [
      { from: t(0), active: { visit: { max: 3, mean: 2, inferredMax: 1 }, execution: { max: 2, mean: 1 } } },
      { from: t(1), active: { visit: { max: 1, mean: 1, inferredMax: 0 } } },
    ],
  };
  const v = M.concurrencyView(series, [], { from: t(0), to: t(4) }, t(4));
  const visits = v.lines.find((l) => l.kind === "visit");
  assert.equal(visits.inferredPeak, 1);
  assert.deepEqual(visits.inferred.map((s) => s.count), [1, 0]);
  assert.ok(v.yMax > 3, "headroom above the peak");
  // A source that does not say has no inferred band.
  const old = { ...series, buckets: [{ from: t(0), active: { visit: { max: 3, mean: 2 } } }] };
  assert.deepEqual(M.concurrencyView(old, [], { from: t(0), to: t(4) }, t(4)).lines[0].inferred, []);
});

// M22, the build station's later states, on the Line and in the side panel: a lane handed back to
// the cell; a step recovered after an interruption; a lane made fresh; a lane set aside for the newer
// reasons; a join that landed on a branch that moved; the commands task (C-T01); a changed test
// command; a build built one task at a time because its suite was not passing. Each says what
// happened and that nothing was lost; none shows a builder's own words.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const M =await import("../src/line/lanesModel.ts");
const O = await import("../src/shell/inspector/outcomes.ts");

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const at = (min, s = 0) => new Date(T0 + min * 60_000 + s * 1000).toISOString().replace(".000Z", "Z");
const read = (r) => ({ read: r, why: null });
const LC = ["1111111111aaaaaaaaaa", "2222222222bbbbbbbbbb", "3333333333cccccccccc"];
const REF = "refs/mach/lanes-set-aside/T-3/L2/1";

const lane = (name, tasks, over = {}) => ({
  lane: name, tasks, status: "open", waiting: null, record: read("read"), handed_at: at(5), started_at: at(5), last_step_at: at(12), finished_at: null,
  done: 0, total: tasks.length, current: tasks[0], handed_back: null, made_fresh: [], recovered: [], ...over,
});

/** T-3: L1 = T02 T03, L2 = T04 T05 T06; T01 before. */
function reply(over = {}) {
  return {
    state: "open", source: "cell", build_json: read("read"), build_report: read("absent"), setting: 3, fork: "9999999999", opened_at: at(5),
    before: ["T01"], after: [],
    lanes: [lane("L1", ["T02", "T03"], { done: 2, status: "done", current: null, finished_at: at(20) }), lane("L2", ["T04", "T05", "T06"], { done: 1, current: "T05" })],
    batches: [], join: null, join_refusals: [], joining: null, join_started_at: null,
    tasks: [
      { task: "T01", kind: "contract", part: "before", status: "done", commit: "abcdef1234", at: at(4) },
      { task: "T02", kind: "test", part: "lane", lane: "L1", status: "done", lane_commit: LC[0], at: at(10) },
      { task: "T03", kind: "impl", part: "lane", lane: "L1", status: "done", lane_commit: LC[1], at: at(20) },
      { task: "T04", kind: "test", part: "lane", lane: "L2", status: "done", lane_commit: LC[2], at: at(9) },
      { task: "T05", kind: "impl", part: "lane", lane: "L2", status: "pending" },
      { task: "T06", kind: "docs", part: "lane", lane: "L2", status: "pending" },
    ],
    commits: [], report_timing: null, gates: [], deviations: [], command_changes: [],
    ...over,
  };
}

function handedBack(state) {
  const r = reply();
  r.lanes[1] = { ...r.lanes[1], status: "handed-back", handed_back: { at: at(15), finished_then: ["T04"], unfinished_then: ["T05", "T06"], built_in_cell: state === "joined" ? ["T05", "T06"] : [] } };
  if (state === "joined") {
    r.state = "joined";
    r.lanes[0] = { ...r.lanes[0], status: "joined" };
    r.join = { status: "JOINED", started_at: at(21), finished_at: at(22), tip: "5555555555", landed: 3, suite_passed: true, suite_seconds: 30, landing_seconds: 2, set_aside: [], interaction: null, moved_branch: null };
    r.tasks = r.tasks.map((t) => (t.task === "T05" || t.task === "T06" ? { ...t, handed_back: true } : t));
  }
  return r;
}

test("a lane handed back: a way on, in held, its remaining tasks built one at a time; the join is next when the others are done", () => {
  let r = M.readLanesReply(handedBack("open"));
  assert.equal(r.lanes[1].status, "handed-back");
  assert.deepEqual(r.lanes[1].handedBack.unfinished, ["T05", "T06"]);
  let line = M.laneLine(r, null);
  assert.deepEqual(line.chips.map((c) => [c.words, c.tone]), [["L1: done, 2 of 2", "done"], ["L2: handed back, its 2 remaining tasks are built one at a time", "held"]]);
  assert.equal(line.marker, "lanes done", "a lane handed back is ready for the join");
  assert.equal(line.moment.words, "Every lane is done: next, the lanes are joined.");
  let panel = M.lanesPanel(r, null);
  assert.equal(panel.groups.find((g) => g.key === "L2").note, "handed back: its finished tasks land at the join; T05 and T06 are built in the cell, one at a time, after the join");
  assert.match(panel.summary, /Lane L2 was handed back to the cell at 10:15:00 UTC: its 2 remaining tasks \(T05 and T06\) are built in the cell, one at a time, once the lanes are joined; its 1 finished task lands at the join\./);
  assert.equal(panel.groups.flatMap((g) => g.tasks).find((t) => t.task === "T05").status, "not done yet, built in the cell after the join");

  // Joined: its remaining tasks are built in the cell; once every one is done, said so.
  r = M.readLanesReply(handedBack("joined"));
  line = M.laneLine(r, null);
  assert.equal(line.chips[1].words, "L2: handed back, its 2 remaining tasks are built one at a time");
  assert.equal(line.moment.words, "Lanes joined: 3 tasks landed, the whole suite passed. L2 handed back: its 2 remaining tasks are built one at a time.");
  assert.equal(line.moment.tone, "done");
  panel = M.lanesPanel(r, null);
  assert.equal(panel.groups.find((g) => g.key === "L2").note, "handed back: its finished tasks landed at the join; T05 and T06 are built in the cell, one at a time, now that the lanes are joined");
  const raw = handedBack("joined");
  raw.tasks = raw.tasks.map((t) => (t.handed_back ? { ...t, status: "done", at: at(30) } : t));
  line = M.laneLine(M.readLanesReply(raw), null);
  assert.deepEqual([line.chips[1].words, line.chips[1].tone], ["L2: handed back, its 2 remaining tasks were built one at a time", "done"]);
  // One task: singular.
  const one = handedBack("open");
  one.lanes[1].handed_back.unfinished_then = ["T06"];
  assert.equal(M.laneLine(M.readLanesReply(one), null).chips[1].words, "L2: handed back, its 1 remaining task is built one at a time");
});

test("a step recovered after an interruption, and a lane made fresh: what happened, and that nothing was lost", () => {
  const raw = reply();
  raw.lanes[0].recovered = [{ task: "T02", at: at(11), commit: LC[0] }];
  raw.tasks[1] = { ...raw.tasks[1], recovered: { at: at(11), commit: LC[0] } };
  raw.lanes[1].made_fresh = [{ at: at(5, 10), why: null, ref: REF, state_file_kept: true }, { at: at(6), why: null, ref: null, state_file_kept: false }];
  raw.deviations = [
    { type: "step-recovered", lane: "L1", task: "T02", at: at(11), ref: null, commit: LC[0] }, // the same, from the lane's own record: said once
    { type: "step-recovered", lane: null, task: "T01", at: at(4), ref: null, commit: "abcdef1234" },
    { type: "lane-worktree-remade", lane: "L2", task: null, at: at(6), ref: null, commit: null },
    { type: "lane-files-set-aside", lane: "L1", task: null, at: at(21), ref: "refs/mach/lane-files/T-3/L1/1", commit: "abcdef9999" },
  ];
  const panel = M.lanesPanel(M.readLanesReply(raw), null);
  assert.deepEqual(panel.notes, [
    "In lane L1, the step of T02 was interrupted; the station found its commit (1111111111) and recorded it, so nothing was lost.",
    "The step of T01 was interrupted; the station found its commit (abcdef1234) and recorded it, so nothing was lost.",
    `Lane L2 was made fresh at 10:05:10 UTC, because its folder, branch or record belonged to another build. Nothing was lost: what was there before is kept under ${REF}, and its earlier record beside it in the cell.`,
    "Lane L2 was made fresh at 10:06:00 UTC, because its folder, branch or record belonged to another build. Nothing of its own was there to keep.",
    "Lane L2's worktree was made again on a new branch, because its branch was checked out somewhere else.",
    "Lane L1 had uncommitted files no task held; the station kept them under refs/mach/lane-files/T-3/L1/1, and the join went on without them.",
  ]);
  assert.equal(panel.groups.flatMap((g) => g.tasks).find((t) => t.task === "T02").status, "done, recovered after an interrupted step");
  // A ref that is not one the station makes is not shown.
  raw.lanes[1].made_fresh = [{ at: at(5), ref: "refs/heads/main; rm -rf /", state_file_kept: false }];
  raw.deviations = [];
  assert.match(M.lanesPanel(M.readLanesReply(raw), null).notes.at(-1), /Nothing of its own was there to keep\.$/);
});

test("a lane set aside for each newer reason, its commits kept; a join that landed on a branch that moved", () => {
  const raw = reply({ state: "joined" });
  raw.lanes = [{ ...raw.lanes[0], status: "joined" }, { ...raw.lanes[1], status: "set-aside", done: 3 }];
  raw.join = {
    status: "JOINED", started_at: at(21), finished_at: at(22), tip: "5555555555", landed: 3, suite_passed: true, suite_seconds: 30, landing_seconds: 2, interaction: null,
    set_aside: [{ lane: "L2", tasks: ["T04", "T05", "T06"], kept_as: REF, because: [
      { why: "branch-moved", other: null, commits: 1, commit: null },
      { why: "did-not-apply", other: null, commits: null, commit: LC[2] },
      { why: "case-clash", other: "L1", commits: null, commit: null },
      { why: "file-folder", other: "L1", commits: null, commit: null },
      { why: "unrecorded-commits", other: null, commits: null, commit: null },
      { why: "lane-history", other: null, commits: null, commit: null },
      { why: "something new", other: null, commits: null, commit: null },
    ] }],
    moved_branch: { from: "9999999999", to: "7777777777", commits: ["7777777777", "8888888888"], files: 3 },
  };
  const r = M.readLanesReply(raw);
  const words = r.join.setAside[0].because.map(M.asideWhyWords);
  assert.deepEqual(words, [
    "a commit made on the ticket's branch while the lanes were open changed its file",
    "its commit 3333333333 did not apply on the landed work",
    "one of its file names and one of L1's differ only by letter case",
    "one of its files and a folder of L1 have the same path, or the other way round",
    "its branch held commits no task recorded",
    "its commits were not one chain from the fork point",
    null,
  ]);
  assert.equal(M.asideWhyWords({ why: "branch-moved", other: null, commits: 2, commit: null }), "2 commits made on the ticket's branch while the lanes were open changed its files");
  assert.equal(M.asideWhyWords({ why: "same-file", other: "L1", commits: null, commit: null }), "it changed a file also changed by L1");
  const panel = M.lanesPanel(r, null);
  assert.match(panel.summary, /The ticket's branch moved while the lanes were open: they landed on top of the 2 commits made there\./);
  assert.match(panel.summary, /L2 was set aside \(a commit made on the ticket's branch while the lanes were open changed its file; its commit 3333333333 did not apply/);
  assert.match(panel.summary, /its tasks are built again in the cell, one at a time\. Its lane commits are kept under refs\/mach\/lanes-set-aside\/T-3\/L2\/1, so nothing is lost\./);
  const line = M.laneLine(r, null);
  assert.equal(line.moment.words, "Lanes joined: 3 tasks landed, the whole suite passed. The ticket's branch moved while the lanes were open: they landed on top of the 2 commits made there. L2 set aside: its 3 tasks are built again one at a time.");
  assert.equal(line.chips[1].words, "L2: set aside");
});

test("C-T01 and J-T01 are task IDs; the commands task has its own group", () => {
  const raw = reply();
  raw.tasks.push({ task: "C-T01", kind: "impl", part: "commands", status: "pending" }, { task: "J-T01", kind: "impl", part: "join", status: "pending" }, { task: "X-T01", status: "pending" });
  const r = M.readLanesReply(raw);
  assert.deepEqual(r.tasks.slice(-2).map((t) => t.task), ["C-T01", "J-T01"]);
  const panel = M.lanesPanel(r, null);
  const g = panel.groups.find((x) => x.key === "commands");
  assert.equal(g.title, "After a command changed");
  assert.equal(g.note, "Added when a new test or lint command left the suite or the linter failing; built in the cell.");
  assert.deepEqual(g.tasks.map((t) => t.task), ["C-T01"]);
});

test("a changed test command on the side panel: which and when, never the command or the reason", () => {
  assert.equal(M.commandsPanel([]), null);
  assert.equal(M.commandsPanel(null), null);
  const build = M.readCellBuild({ lanes: null, command_changes: [
    { at: at(40), commands: ["test"], loop: 0 },
    { at: at(50), commands: ["test", "lint"], loop: 1 },
    { at: null, commands: ["lint"], loop: null },
    { at: at(55), commands: ["pytest -k secret"], loop: 0 },
  ] });
  assert.equal(build.lanes, null);
  const panel = M.commandsPanel(build.commands);
  assert.deepEqual(panel.lines, [
    "The test command changed at 10:40:00 UTC.",
    "The test and lint commands changed at 10:50:00 UTC, in revision round 1.",
    "The lint command changed, at a time not recorded.",
  ]);
  assert.equal(panel.note, "Nothing done was undone: the build carried on from where it was. The old and the new command, and why it changed, are in the build's record for the reviewers.");
  // In a build in lanes too, from the same reply.
  assert.equal(M.readCellBuild({ lanes: reply(), command_changes: [{ at: at(40), commands: ["test"] }] }).lanes.state, "open");
});

test("built one task at a time because the suite was not passing, or because too few places were free", () => {
  const seq = (over) => M.lanesPanel(M.readLanesReply(reply({ state: "sequential", ...over })), null).summary;
  assert.equal(seq({ sequential_because: "suite", sequential_suite: "red" }), "Planned in 2 lanes, but the cell's suite was failing where they would open, so the plan is built one task at a time, as without lanes, and the builder makes the suite pass on the way.");
  assert.equal(seq({ sequential_because: "suite", sequential_suite: "unknown" }), "Planned in 2 lanes, but the cell's suite was not known to pass where they would open, so the plan is built one task at a time, as without lanes, and the builder makes the suite pass on the way.");
  assert.equal(seq({ sequential_because: "free-places" }), "Planned in 2 lanes, but too few builders' places were free when they were to open, so the plan is built one task at a time, as without lanes.");
});

test("the new gate reason codes have words", () => {
  for (const code of ["lane-handed-back", "commands-set", "join-started", "sequential", "lane-set-aside", "step-recovered", "lane-made-fresh", "landed-on-moved-branch"]) {
    assert.ok(O.gateReasonOf(code)?.known, code);
  }
  assert.equal(O.evaluationWords({ verdict: "passed", reasonCode: "step-recovered", subject: "T05" }), "Passed for T05: an interrupted step was recovered: its commit was found and recorded");
});

// M22: a build in lanes on the Line and in its side panel. The observer's reply (`/cells/{ticket}`'s
// `lanes`, read from the cell's build.json, lane.json files and build-report.json) and the ticket's
// events (a task built in a lane names its lane, event revision 9) become what the row and the panel
// show. A build not in lanes shows exactly what it showed before; nothing is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const M = await import("../src/line/lanesModel.ts");
const L = await import("../src/line/model.ts");
const { lanesKey } = await import("../src/line/useLanes.ts");
const { createSceneLog, provenance } = sim;

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const at = (min, s = 0) => new Date(T0 + min * 60_000 + s * 1000).toISOString().replace(".000Z", "Z");
const LC = ["1111111111aaaaaaaaaa", "2222222222bbbbbbbbbb", "3333333333cccccccccc", "4444444444dddddddddd"];
const LD = ["5555555555eeeeeeeeee", "6666666666ffffffffff", "7777777777aaaaaaaaaa", "8888888888bbbbbbbbbb"];
const read = (r) => ({ read: r, why: null });

/** The reply for T-3 with L1 = T02 T03, L2 = T04 T05 T06 T08 T09 T10, L3 = T07; T01 before, T11 after. */
function openReply(over = {}) {
  return {
    state: "open", source: "cell", build_json: read("read"), build_report: read("absent"), setting: 3, fork: "9999999999", opened_at: at(5),
    before: ["T01"], after: ["T11"],
    lanes: [
      { lane: "L1", tasks: ["T02", "T03"], status: "open", waiting: null, record: read("read"), handed_at: at(5), started_at: at(5, 30), last_step_at: at(12), finished_at: null, done: 1, total: 2, current: "T03" },
      { lane: "L2", tasks: ["T04", "T05", "T06", "T08", "T09", "T10"], status: "open", waiting: null, record: read("read"), handed_at: at(5), started_at: at(5, 20), last_step_at: at(14), finished_at: null, done: 2, total: 6, current: "T06" },
      { lane: "L3", tasks: ["T07"], status: "planned", waiting: "free-place", record: read("absent"), handed_at: null, started_at: null, last_step_at: null, finished_at: null, done: 0, total: 1, current: null },
    ],
    batches: [], join: null, join_refusals: [],
    tasks: [
      { task: "T01", kind: "contract", part: "before", lane: null, status: "done", set_aside: false, commit: "abcdef1234", lane_commit: null, at: at(4) },
      { task: "T02", kind: "test", part: "lane", lane: "L1", status: "done", set_aside: false, commit: null, lane_commit: LC[0], at: at(9), test_seconds: 4.5 },
      { task: "T03", kind: "impl", part: "lane", lane: "L1", status: "pending", set_aside: false, commit: null, lane_commit: null, at: null },
      { task: "T04", kind: "test", part: "lane", lane: "L2", status: "done", set_aside: false, commit: null, lane_commit: LC[2], at: at(8) },
      { task: "T05", kind: "impl", part: "lane", lane: "L2", status: "done", set_aside: false, commit: null, lane_commit: LC[3], at: at(13) },
      { task: "T06", kind: "test", part: "lane", lane: "L2", status: "pending" },
      { task: "T07", kind: "docs", part: "lane", lane: "L3", status: "pending" },
      { task: "T11", kind: "docs", part: "after", lane: null, status: "pending" },
    ],
    commits: [{ lane_commit: LC[0], task: "T02", lane: "L1", state: "not-joined", landed_commit: null }],
    report_timing: null, gates: [{ gate: "build.lanes-open", verdict: "passed", reason_code: null, lane: null, at: { at: at(5) } }],
    ...over,
  };
}

function joinedReply({ aside = false, interaction = false, report = false } = {}) {
  const lanes = [
    { lane: "L1", tasks: ["T02", "T03"], status: "joined", waiting: null, record: read("read"), handed_at: at(5), started_at: at(5), last_step_at: at(20), finished_at: at(20), done: 2, total: 2, current: null },
    { lane: "L2", tasks: ["T04", "T05"], status: aside ? "set-aside" : "joined", waiting: null, record: read("read"), handed_at: at(5), started_at: at(5), last_step_at: at(25), finished_at: at(25), done: 2, total: 2, current: null },
  ];
  const tasks = [
    { task: "T01", kind: "contract", part: "before", status: "done", commit: "abcdef1234", at: at(4) },
    { task: "T02", kind: "test", part: "lane", lane: "L1", status: "done", commit: LD[0], lane_commit: LC[0], at: at(10) },
    { task: "T03", kind: "impl", part: "lane", lane: "L1", status: "done", commit: LD[1], lane_commit: LC[1], at: at(20) },
    aside
      ? { task: "T04", kind: "test", part: "lane", lane: "L2", status: "pending", set_aside: true, commit: null, lane_commit: LC[2], at: null }
      : { task: "T04", kind: "test", part: "lane", lane: "L2", status: "done", commit: LD[2], lane_commit: LC[2], at: at(12) },
    aside
      ? { task: "T05", kind: "impl", part: "lane", lane: "L2", status: "pending", set_aside: true, commit: null, lane_commit: LC[3], at: null }
      : { task: "T05", kind: "impl", part: "lane", lane: "L2", status: "done", commit: LD[3], lane_commit: LC[3], at: at(25) },
    ...(interaction ? [{ task: "J-T01", kind: "impl", part: "join", status: "pending" }] : []),
    { task: "T11", kind: "docs", part: "after", status: "pending" },
  ];
  const landed = aside ? 2 : 4;
  return {
    ...openReply(),
    state: "joined",
    lanes,
    tasks,
    join: {
      status: interaction ? "INTERACTION" : "JOINED", started_at: at(26), finished_at: at(27), tip: LD[1], landed, suite_passed: !interaction, suite_seconds: 30, landing_seconds: 2.5,
      set_aside: aside ? [{ lane: "L2", tasks: ["T04", "T05"], because: [{ other: "L1", why: "same-file" }] }] : [],
      interaction: interaction ? { failing: 2, lanes_named: ["L2"], task: "J-T01" } : null,
    },
    commits: tasks.filter((t) => t.lane_commit).map((t) => ({ lane_commit: t.lane_commit, task: t.task, lane: t.lane, state: t.set_aside ? "set-aside" : "landed", landed_commit: t.set_aside ? null : t.commit })),
    report_timing: report
      ? { elapsed_seconds: 2400, lanes_wall_seconds: 1200, lanes_summed_seconds: 2100, lanes_ratio: 1.75, steps: [{ task: "T02", lane: "L1", seconds: 300, test_seconds: 4.5 }, { task: "T03", lane: "L1", seconds: null }], lanes: [] }
      : null,
  };
}

/** T-3's events: the build visit and the given tasks, each in its lane when it was. */
function cellOf(tasks) {
  const ids = { ticket_id: "T-3", slice_id: "SLICE-003", cell_instance: "3f2a9c1e", visit_id: "T-3/build#1", station: "build", round: 1 };
  const out = [];
  let seq = 0;
  const line = (type, t, data) => out.push(ev(type, { stream: "cell-lifecycle", key: "c:T-3:3f2a9c1e", seq: ++seq, t, ids, entities: ["cell:T-3"], data }));
  line("station.entered", T0, { station: "build", stage: "building", action: "build", resumed: false, unclosed_visit: null, head: null, counts: {} });
  for (const [i, t] of tasks.entries()) {
    line("build.task_completed", T0 + (i + 1) * 60_000, { task_id: t.id, kind: t.kind ?? "test", step: "red", first_run: "fail", suite: "red", commit: t.commit ?? "abcdef1", ...(t.lane ? { lane: t.lane } : {}) });
  }
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  log.ingest(finalize(out));
  return log.head().cells["T-3"];
}

test("the reply is read tolerantly: only identifiers, codes, commits, times and numbers", () => {
  const raw = openReply();
  raw.lanes.push({ lane: "lane four", tasks: ["T99"], status: "open" });
  raw.tasks.push({ task: "Write the login form", status: "done" }, { task: "T12", status: "Ada Lovelace did it", commit: "not a commit" });
  const r = M.readLanesReply(raw);
  assert.equal(r.lanes.length, 3, "a lane whose name is not a lane's is left out");
  assert.equal(r.tasks.find((t) => t.task === "T12").status, null);
  assert.equal(r.tasks.find((t) => t.task === "T12").commit, null);
  assert.ok(!r.tasks.some((t) => t.task === "Write the login form"));
  assert.equal(M.readLanesReply(null), null, "a cell not in lanes has no lanes");
  assert.equal(M.readLanesReply(undefined), null);
  assert.equal(r.gates[0].at, T0 + 5 * 60_000);
});

test("a build not in lanes shows exactly what it showed before", () => {
  assert.equal(M.laneLine(null, null), null);
  assert.equal(M.laneLine(M.readLanesReply({ ...openReply(), state: "planned" }), null), null, "planned, not opened yet");
  assert.equal(M.laneLine(M.readLanesReply({ ...openReply(), state: "sequential" }), null), null, "built one task at a time after all");
  const row = { detail: "task 2 of 9", state: "working", column: 2 };
  assert.equal(M.withLaneMarker(row, null), row, "the same row, untouched");
  // A task built in the cell carries no lane in the scene: its shape is as before.
  const cell = cellOf([{ id: "T01" }]);
  assert.ok(!("lane" in cell.tasks[0]));
});

test("on the Line: how many lanes, each lane's task and how far it got, and a lane waiting for a free place", () => {
  const line = M.laneLine(M.readLanesReply(openReply()), null);
  assert.equal(line.marker, "3 lanes");
  assert.deepEqual(line.chips.map((c) => c.words), ["L1: T03, 1 of 2 done", "L2: T06, 2 of 6 done", "L3: waiting for a free place"]);
  assert.deepEqual(line.chips.map((c) => c.tone), ["working", "working", "held"]);
  assert.equal(line.moment, null);
  assert.equal(M.withLaneMarker({ detail: null, state: "working", column: 2 }, line).detail, "3 lanes");
  assert.equal(M.withLaneMarker({ detail: null, state: "working", column: 3 }, line).detail, null, "only at Build");
});

test("an event that arrives before the reply is read again moves its lane on", () => {
  const reply = M.readLanesReply(openReply());
  const cell = cellOf([{ id: "T02", lane: "L1", commit: LC[0] }, { id: "T03", lane: "L1", kind: "impl", commit: LC[1] }, { id: "T06", lane: "L2" }]);
  assert.equal(cell.tasks.find((t) => t.id === "T03").lane, "L1", "the reducer keeps the event's lane");
  const line = M.laneLine(reply, cell);
  assert.deepEqual(line.chips.map((c) => c.words).slice(0, 2), ["L1: done, 2 of 2", "L2: T08, 3 of 6 done"]);
  // The panel follows the same events.
  const panel = M.lanesPanel(reply, cell);
  assert.equal(panel.groups.find((g) => g.key === "L1").note, "done");
  // The events of a ticket change its key, so the reply is read again.
  assert.notEqual(lanesKey(cellOf([{ id: "T02", lane: "L1" }])), lanesKey(cell));
});

test("every lane done: the join is next, said as its own moment", () => {
  const raw = openReply();
  raw.lanes = raw.lanes.slice(0, 2).map((l) => ({ ...l, status: "done", done: l.total, current: null, finished_at: at(25) }));
  const line = M.laneLine(M.readLanesReply(raw), null);
  assert.equal(line.marker, "lanes done");
  assert.equal(line.moment.words, "Every lane is done: next, the lanes are joined.");
  // A join that stopped and landed nothing says so, with landing's own code.
  raw.join_refusals = [{ at: at(26), reason_code: "branch-moved" }];
  assert.equal(M.laneLine(M.readLanesReply(raw), null).moment.words, "The join stopped and landed nothing (branch-moved); every lane's work is kept.");
});

test("joined; a lane set aside; a failure only when joined, with its fix task", () => {
  let line = M.laneLine(M.readLanesReply(joinedReply()), null);
  assert.equal(line.moment.words, "Lanes joined: 4 tasks landed, the whole suite passed.");
  assert.equal(line.moment.tone, "done");
  assert.deepEqual(line.chips.map((c) => c.words), ["L1: landed, 2 of 2 done", "L2: landed, 2 of 2 done"]);

  line = M.laneLine(M.readLanesReply(joinedReply({ aside: true })), null);
  assert.match(line.moment.words, /L2 set aside: its 2 tasks are built again one at a time\./);
  assert.equal(line.chips[1].words, "L2: set aside");
  assert.equal(line.moment.tone, "fail");

  const reply = M.readLanesReply(joinedReply({ interaction: true }));
  line = M.laneLine(reply, null);
  assert.equal(line.moment.words, "Failed only when joined: 2 tests fail together; J-T01 makes them pass together.");
  assert.equal(line.moment.tone, "fail");
  // Its fix task done, by an event (the join's task keeps its ID).
  line = M.laneLine(reply, cellOf([{ id: "J-T01", kind: "impl" }]));
  assert.equal(line.moment.words, "Failed only when joined: 2 tests fail together; J-T01 made them pass together.");
  assert.equal(line.moment.tone, "done");
});

test("a lane whose record could not be read says so; so does a build record that could not be", () => {
  const raw = openReply();
  raw.lanes[1] = { ...raw.lanes[1], record: { read: "unreadable", why: "not the JSON the build station writes" }, done: null, current: null };
  const reply = M.readLanesReply(raw);
  assert.equal(M.laneLine(reply, null).chips[1].words, "L2: its record could not be read");
  assert.equal(M.laneLine(reply, null).chips[1].tone, "unknown");
  const panel = M.lanesPanel(reply, null);
  assert.deepEqual(panel.problems, ["Lane L2's own record could not be read: not the JSON the build station writes. Its progress is not shown."]);
  assert.equal(panel.groups.find((g) => g.key === "L2").note, "progress not recorded");
  const none = M.readLanesReply({ state: "unreadable", build_json: { read: "unreadable", why: "a link, which the observer never follows" }, lanes: [], tasks: [] });
  assert.equal(M.laneLine(none, null).moment.words, "Built in lanes, but its build record could not be read.");
  assert.match(M.lanesPanel(none, null).problems[0], /could not be read: a link/);
  assert.equal(M.lanesPanel(none, null).timing, null);
});

test("in the side panel: the tasks grouped by lane, each with its time, or not recorded", () => {
  const panel = M.lanesPanel(M.readLanesReply(openReply()), null);
  assert.deepEqual(panel.groups.map((g) => g.title), ["Before the lanes", "Lane L1", "Lane L2", "Lane L3", "After the lanes"]);
  assert.deepEqual(panel.groups.map((g) => g.note), ["Built in the cell, one at a time.", "1 of 2 done", "2 of 6 done", "waiting for a free place", "Built in the cell, one at a time, once the lanes are joined."]);
  const t = (id) => panel.groups.flatMap((g) => g.tasks).find((x) => x.task === id);
  // T02: handed at 10:05, done at 10:09; T04 likewise, then T05 from T04's moment.
  assert.deepEqual([t("T02").seconds, t("T02").basis], [240, "recorded"]);
  assert.deepEqual([t("T04").seconds, t("T05").seconds], [180, 300]);
  assert.equal(t("T01").seconds, null, "the first task before the lanes has no recorded start here");
  assert.equal(t("T03").status, "not done yet");
  assert.equal(t("T02").commitWords, "lane commit 1111111111, on its lane's branch until the join");
  assert.match(panel.summary, /Built in 3 lanes at the same time.*1 lane waits for a free place/);
  // Not every lane finished: the lanes' times are not added up.
  assert.equal(panel.timing.wallSeconds, null);
  assert.equal(panel.timing.summedSeconds, null);
  assert.equal(panel.timing.basis, null);
});

test("the speed-up is a recorded fact: wall time against summed time, from the moments, then from the report", () => {
  let panel = M.lanesPanel(M.readLanesReply(joinedReply()), null);
  // Opened 10:05; L1 10:05 to 10:20, L2 10:05 to 10:25: wall 20 min, summed 35 min.
  assert.deepEqual([panel.timing.wallSeconds, panel.timing.summedSeconds, panel.timing.basis], [1200, 2100, "recorded"]);
  assert.equal(panel.timing.buildSeconds, null, "the whole build's time is the report's, not written yet");
  const t = (id) => panel.groups.flatMap((g) => g.tasks).find((x) => x.task === id);
  assert.equal(t("T02").commitWords, "lane commit 1111111111, landed as 5555555555");
  panel = M.lanesPanel(M.readLanesReply(joinedReply({ report: true })), null);
  assert.deepEqual([panel.timing.wallSeconds, panel.timing.summedSeconds, panel.timing.basis, panel.timing.buildSeconds], [1200, 2100, "report", 2400]);
  const r = (id) => panel.groups.flatMap((g) => g.tasks).find((x) => x.task === id);
  assert.deepEqual([r("T02").seconds, r("T02").basis], [300, "report"], "the report's own time wins");
  assert.deepEqual([r("T03").seconds, r("T03").basis], [600, "recorded"], "a step the report has no time for keeps the recorded moments'");
  assert.match(panel.timing.note, /not what a build one task at a time would have taken/);
});

test("set aside and failed together, in the side panel; a lane commit followed to its landed copy", () => {
  let panel = M.lanesPanel(M.readLanesReply(joinedReply({ aside: true })), null);
  assert.match(panel.summary, /L2 was set aside \(it changed a file also changed by L1\): its tasks are built again in the cell, one at a time\./);
  assert.equal(panel.groups.find((g) => g.key === "L2").note, "set aside: not landed; its tasks are built again in the cell, one at a time");
  const t4 = panel.groups.flatMap((g) => g.tasks).find((x) => x.task === "T04");
  assert.equal(t4.commitWords, "lane commit 3333333333, not landed: its lane was set aside");
  panel = M.lanesPanel(M.readLanesReply(joinedReply({ interaction: true })), null);
  assert.deepEqual(panel.groups.map((g) => g.key), ["before", "L1", "L2", "join", "after"]);
  assert.match(panel.summary, /failed only on the joined result \(2 failing tests, in files of L2\); J-T01 makes the lanes pass together/);
  const reply = M.readLanesReply(joinedReply());
  assert.equal(M.landedCommitOf(reply, LC[2]).landed, LD[2]);
  assert.equal(M.landedCommitOf(reply, LC[2].slice(0, 7)).landed, LD[2], "a short id is followed too");
  assert.equal(M.landedCommitOf(reply, "deadbee"), null);
  assert.equal(M.landedCommitOf(null, LC[0]), null);
});

test("the words are the product's: lanes, never the internal names", () => {
  const all = [];
  for (const raw of [openReply(), joinedReply(), joinedReply({ aside: true }), joinedReply({ interaction: true, report: true })]) {
    const reply = M.readLanesReply(raw);
    const line = M.laneLine(reply, null);
    const panel = M.lanesPanel(reply, null);
    all.push(line.marker ?? "", line.moment?.words ?? "", ...line.chips.map((c) => c.words), panel.summary, ...panel.groups.flatMap((g) => [g.title, g.note ?? ""]), panel.timing?.note ?? "");
  }
  const text = all.join(" ").toLowerCase();
  for (const word of ["engine", "light path", "kind", "fan out", "fan-out", "cherry"]) assert.ok(!text.includes(word), word);
});

test("the Simulation shows no lanes: the Line's rows never carry any", () => {
  // The Line model knows nothing of lanes: only the observer's reply adds them, and the Simulation has none.
  const cell = cellOf([{ id: "T02", lane: "L1" }]);
  const rows = L.lineModel({ ...emptyScene(), cells: { "T-3": cell } }, T0 + 3_600_000).rows;
  assert.ok(rows.every((r) => !("lanes" in r)));
});

function emptyScene() {
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  return log.head();
}

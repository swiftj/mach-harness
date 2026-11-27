// The Line's model (src/line/model.ts): stations as columns, each ticket a row at the station it
// stands at, in one of five states, from the scene the store holds now. Nothing estimated: what no
// record gives is null. Driven by the simulation's scenario at chosen moments, and by cells changed
// by hand for the states the scenario never reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const L = await import("../src/line/model.ts");
const { costWords, modelName } = await import("../src/line/words.ts");
const { SCENARIO, fixtureLog, MAX_ROUNDS } = sim;
const log = fixtureLog(SCENARIO);
const at = (t) => ({ scene: log.sceneAt(t), t, model: L.lineModel(log.sceneAt(t), t) });
const row = (m, id) => m.rows.find((r) => r.ticketId === id);
/** The station a row stands at, by name. */
const stationOf = (r) => L.LINE_STATIONS[r.column].name;

test("seven stations, left to right, each with its model setting under `models` in .factory/config.json", () => {
  assert.deepEqual(
    L.LINE_STATIONS.map((s) => s.name),
    ["Groom", "Plan", "Build", "Verify", "Review", "Merge", "Clean up"],
  );
  for (const s of L.LINE_STATIONS) assert.match(s.tiers, /^models\.(planning|contracts|build|utility)/, `${s.name}: a real tier key`);
  assert.equal(L.columnOf("audit"), 1, "the readiness check is counted with Plan");
  assert.equal(L.columnOf("human-approval"), 4, "a person's approval with Review");
  assert.equal(L.columnOf("intake"), null);
});

test("rows from the simulation: tickets appear, move station to station, and are working while a visit is open", () => {
  const { model } = at(600_000);
  assert.deepEqual(model.rows.map((r) => r.ticketId).sort(), ["131", "132", "133", "134", "135"]);
  for (const id of ["131", "132", "133"]) {
    const r = row(model, id);
    assert.equal(r.state, "working");
    assert.equal(stationOf(r), "Build");
    assert.deepEqual(r.passed, [1], "Plan passed (the scenario's cells start groomed)");
    assert.match(r.detail, /^task \d+/);
    assert.match(r.why, /^Builder at work/);
    assert.equal(r.command, `/mach explain ${id}`);
  }
});

test("a slice with no cell yet is held before Plan, with the dependency it waits for", () => {
  const { model } = at(600_000);
  const r = row(model, "134");
  assert.equal(r.state, "held");
  assert.equal(stationOf(r), "Plan");
  assert.equal(r.held.kind, "dependency");
  assert.match(r.why, /Waits for SLICE-021 to be merged first/);
  assert.equal(r.cost, null, "no execution: no cost, never $0");
});

test("work sent back: the arc runs from the station that sent it to Build, and the revision says why", () => {
  const verifyFailed = row(at(1_700_000).model, "131");
  assert.equal(verifyFailed.state, "working");
  assert.equal(stationOf(verifyFailed), "Build");
  assert.deepEqual(verifyFailed.sentBack, { from: 3, to: 2, times: 1 });
  assert.match(verifyFailed.why, /^Verification failed in round 1/);
  const rejected = row(at(2_000_000).model, "132");
  assert.deepEqual(rejected.sentBack, { from: 4, to: 2, times: 1 });
  assert.match(rejected.why, /^Review rejected round 1 with 1 blocking finding/);
  assert.equal(L.timesWords(1), "once");
  assert.equal(L.timesWords(2), "twice");
  assert.equal(L.timesWords(3), "3 times");
});

test("waiting for a person: between Review and Merge, in the Needs you list, with /mach decide", () => {
  const { model } = at(2_900_000);
  const r = row(model, "132");
  assert.equal(r.state, "person");
  assert.equal(r.beforeMerge, true);
  assert.equal(stationOf(r), "Review");
  assert.match(r.why, /3 of 3 reviewers approved in round 2/);
  assert.equal(r.needs, "Approve it, or send it back with your reason.");
  assert.equal(r.command, "/mach decide 132");
  assert.deepEqual(model.needs.map((x) => x.ticketId), ["132"]);
  assert.ok(r.since !== null && r.since <= 2_900_000);
});

test("landed: merged tickets sink below the rest, at Clean up once archived, with their recorded cost", () => {
  const { model } = at(SCENARIO.duration);
  const states = model.rows.map((r) => r.state);
  const firstLanded = states.indexOf("landed");
  assert.ok(firstLanded > 0 && states.slice(firstLanded).every((s) => s === "landed"), "landed rows come last");
  const r = row(model, "133");
  assert.equal(stationOf(r), "Clean up");
  assert.deepEqual(r.passed, [1, 2, 3, 4, 5]);
  assert.equal(r.roundsUsed, 1);
  assert.ok(r.cost && r.cost.usd > 0);
  assert.equal(model.needs.length, 0);
});

test("stopped: a blocked cell is stopped at its last station, says why, and needs a person", () => {
  const { scene, t } = at(2_000_000);
  const cell = scene.cells["132"];
  const lastReview = cell.reviews.at(-1);
  const blocked = { ...cell, stage: "blocked", reviews: [...cell.reviews.slice(0, -1), { ...lastReview, outcome: "ESCALATE", round: MAX_ROUNDS }] };
  const r = L.rowOfCell(scene, blocked, t);
  assert.equal(r.state, "stopped");
  assert.match(r.why, new RegExp(`round ${MAX_ROUNDS}, the last of ${MAX_ROUNDS}`));
  assert.equal(r.command, "/mach decide 132");
  assert.match(r.needs, /^Read what failed, then carry it on with a fix: the builder takes it up again at the build step\./);
});

test("held: a recorded wait for a free place says so, with its limit; otherwise the next station, never an invented reason", () => {
  const { scene, t } = at(1_200_000);
  const cell = { ...scene.cells["131"], visits: scene.cells["131"].visits.map((v) => (v.leftAt === null ? { ...v, leftAt: t, outcome: "done" } : v)), stage: "built" };
  const next = L.rowOfCell(scene, cell, t);
  assert.equal(next.state, "held");
  assert.equal(next.held.kind, "next");
  assert.equal(stationOf(next), "Verify");
  const waiting = L.rowOfCell(scene, { ...cell, capacityWait: { since: t - 60_000, limit: 3, eventId: "x" } }, t);
  assert.equal(waiting.held.kind, "capacity");
  assert.match(waiting.why, /Waiting for a free place to work \(at most 3 at once\)/);
  assert.equal(waiting.since, t - 60_000);
});

test("where the time went: one entry per visit, open ones 'so far', rework marked", () => {
  const { model } = at(2_000_000);
  const times = row(model, "131").times;
  assert.ok(times.length >= 4);
  assert.equal(times.at(-1).basis, "so-far", "the open visit is counted so far");
  assert.ok(times.some((x) => x.rework && L.LINE_STATIONS[x.column].name === "Build"), "the second build is rework");
  for (const x of times) assert.ok(x.ms === null || x.ms >= 0);
});

test("station figures come only from what the history holds: no visit, no typical time", () => {
  const early = at(60_000);
  for (const s of L.stationStats(early.scene, early.model.rows)) assert.equal(s.typicalMs, null, `${L.LINE_STATIONS[s.column].name}: nothing finished yet`);
  const late = at(SCENARIO.duration);
  const stats = L.stationStats(late.scene, late.model.rows);
  const build = stats[2];
  assert.ok(build.typicalMs > 0 && build.sample >= 3, "a median of the finished build visits");
  assert.equal(stats[0].typicalMs, null, "nobody groomed in this run: Groom says not recorded");
  assert.deepEqual(stats[3].sentBack, { back: 1, of: stats[3].sentBack.of }, "one verification sent work back");
  assert.equal(L.sentBackWords({ back: 0, of: 3 }), "none of 3 sent back");
  assert.equal(L.sentBackWords({ back: 1, of: 5 }), "1 of 5 sent back");
  assert.equal(L.sentBackWords({ back: 0, of: 0 }), null);
  assert.equal(stats[2].sentBack, null, "Build does not judge");
  assert.ok(build.models.length > 0, "the models recorded at Build");
});

test("words: model names and recorded money", () => {
  assert.equal(modelName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelName("sonnet"), "Sonnet 5.5");
  assert.equal(modelName("some-other-model"), "some-other-model");
  assert.equal(costWords(null), "not recorded");
  assert.equal(costWords({ usd: 4.181, partial: false }), "$4.18 recorded");
  assert.equal(costWords({ usd: 4, partial: true }), "at least $4.00 recorded");
});

test("only the newest few landed tickets keep a row", () => {
  const { scene, t } = at(SCENARIO.duration);
  const cells = { ...scene.cells };
  const base = scene.cells["133"];
  for (let i = 0; i < L.LANDED_SHOWN + 3; i++) cells[`LOCAL-9${i}`] = { ...base, ticketId: `LOCAL-9${i}`, sliceId: "", merged: { ...base.merged, at: base.merged.at + i } };
  const m = L.lineModel({ ...scene, cells }, t);
  assert.equal(m.rows.filter((r) => r.state === "landed").length, L.LANDED_SHOWN);
  assert.ok(m.landedHidden >= 3);
});

test("the feed is the newest moments first", () => {
  const moments = [{ id: "a", t: 1 }, { id: "b", t: 2 }, { id: "c", t: 3 }];
  assert.deepEqual(L.feedOf(moments, 3, 2).map((m) => m.id), ["c", "b"]);
});

test("the feed lists only moments at or before the clock, never later ones", () => {
  const moments = [{ id: "a", t: 1 }, { id: "b", t: 2 }, { id: "c", t: 3 }, { id: "d", t: 9 }];
  assert.deepEqual(L.feedOf(moments, 2).map((m) => m.id), ["b", "a"], "a moment exactly at the clock is listed; later ones are not");
  assert.deepEqual(L.feedOf(moments, 0), [], "before the first moment the feed is empty");
  assert.deepEqual(L.feedOf(moments, 100).map((m) => m.id), ["d", "c", "b", "a"]);
  // Out of order in the list: ordered by its own time, nothing added.
  assert.deepEqual(L.feedOf([moments[2], moments[0], moments[3], moments[1]], 3).map((m) => m.id), ["c", "b", "a"]);
});

test("Simulation: the feed never shows a moment later than the clock (the whole scenario's moments are indexed up front)", async () => {
  const { fixtureIndexOf } = await import("../src/shell/history.ts");
  const all = fixtureIndexOf(SCENARIO).moments;
  assert.ok(all.some((m) => m.t > 25 * 60_000), "the index holds moments later than 25:00, as the defect needed");
  for (const t of [0, 60_000, 25 * 60_000, 40 * 60_000, SCENARIO.duration]) {
    const feed = L.feedOf(all, t);
    assert.ok(feed.every((m) => m.t <= t), `at ${t}: nothing later than the clock`);
    for (let i = 1; i < feed.length; i++) assert.ok(feed[i - 1].t >= feed[i].t, "newest first");
    const expected = all.filter((m) => m.t <= t).slice(-12).reverse();
    assert.deepEqual(feed.map((m) => m.id), expected.map((m) => m.id), `at ${t}: the newest recorded moments, unchanged`);
  }
});

test("M11: a row carries its epic and its issue number where recorded, and nothing where not", () => {
  const { model, scene } = at(SCENARIO.duration);
  const r = row(model, "131");
  assert.equal(r.issue, 131, "the slice's issue, which is also its ticket");
  assert.equal(r.epicId, "EPIC-004");
  assert.equal(r.epicTitle, "Collect what customers owe");
  // A held slice (no cell yet) carries them too.
  const held = row(model, "135");
  assert.equal(held.issue, 135);
  assert.equal(held.epicId, "EPIC-004");
  // A slice from a ready folder, or a history from before M11: no issue, no epic, never guessed.
  const bare = { ...scene.slices["SLICE-025"], epicId: null, epicTitle: null, issue: null };
  const r2 = L.rowOfSlice(scene, bare);
  assert.equal(r2.issue, null);
  assert.equal(r2.epicId, null);
  assert.equal(r2.epicTitle, null);
});

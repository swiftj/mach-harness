// What an independent check found running the Floor against the real stations: no round anywhere reads
// above its limit (across a stop, one more round, a fresh set, and a fresh set after a round run under a
// carry-on; a past round keeps the reading it had when it ran), one reading of the round in force, a
// carried-on ticket that waits for the line says so from the records, a stopped ticket stands at the
// station that failed it, and "What just happened" says each stop, carry-on, fresh set and abandon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, live } from "./_load.mjs";
import { stoppedRun } from "./fixtures/stopped.mjs";

const L = await import("../src/line/model.ts");

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const sceneOf = (events) => {
  const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
  log.ingest(events);
  return log.head();
};
const now = (scene) => Math.max(...Object.values(scene.cells).flatMap((c) => c.visits.map((v) => v.leftAt ?? v.enteredAt))) + 60_000;

const SCENARIOS = {
  stopped: {},
  decided: { carry: [{ by: "person-decision", max: 4, then: "decided" }] },
  carried: { carry: [{ by: "person-decision", max: 4, then: "build" }] },
  fresh: { carry: [{ by: "person-start", max: 3, then: "fail-build" }] },
  "carried, then a fresh set": { carry: [{ by: "person-decision", max: 4, then: "build" }], reset: true },
  "no record, a fourth round": { extraBuild: true },
};
const nOfM = (words) => {
  const m = /(\d+) of (\d+)/.exec(words);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

test("no round reads above its limit, in any reading, in any scenario", () => {
  for (const [name, options] of Object.entries(SCENARIOS)) {
    const scene = sceneOf(stoppedRun(options));
    const cell = scene.cells["6"];
    const judged = cell.visits.filter((v) => v.round);
    const readings = [sim.roundOfWords(cell), ...judged.map((v) => sim.roundAgainstLimit(cell, v.round, v.enteredAt)), ...judged.map((v) => L.visitRoundWords(cell, v))];
    for (const g of sim.roundGroups(cell)) if (g.kind === "round" && g.reads) readings.push(g.reads);
    const row = L.rowOfCell(scene, cell, now(scene));
    readings.push(`${row.roundsUsed} of ${row.roundLimit}`);
    for (const words of readings) {
      const r = nOfM(words);
      if (r) assert.ok(r[0] <= r[1], `${name}: "${words}" reads above its limit`);
    }
    // One reading of the round in force everywhere: the scene's loop, the callout, the Facts and the Line use it.
    assert.equal(`${sim.roundNow(cell)} of ${sim.roundLimit(cell)}`, sim.roundOfWords(cell), name);
  }
});

test("a past round keeps its reading: round 4 ran as 4 of 4, and after a later fresh set it still reads 4 of 4", () => {
  const scene = sceneOf(stoppedRun(SCENARIOS["carried, then a fresh set"]));
  const cell = scene.cells["6"];
  assert.equal(sim.roundOfWords(cell), "1 of 3", "the round in force reads against the fresh set");
  const build4 = cell.visits.find((v) => v.station === "build" && v.round === 4);
  assert.equal(sim.roundAgainstLimit(cell, 4, build4.enteredAt), "4 of 4");
  assert.equal(L.visitRoundWords(cell, build4), "round 4 (4 of 4)");
  const build3 = cell.visits.find((v) => v.station === "build" && v.round === 3);
  assert.equal(sim.roundAgainstLimit(cell, 3, build3.enteredAt), "3 of 3");
});

test("a carried-on ticket waiting for the line says so from the records, since the carry-on", () => {
  const scene = sceneOf(stoppedRun({ carry: [{ by: "person-decision", max: 4, then: "decided" }] }));
  const cell = scene.cells["6"];
  const row = L.rowOfCell(scene, cell, now(scene));
  assert.equal(row.state, "held");
  assert.equal(row.held.kind, "carried");
  assert.equal(row.since, cell.carriedOn[0].at, "since the carry-on, not the stop");
  assert.equal(row.why, "A person carried it on with a fix, which gave it one more round. It waits for the line to take it up at the build step.");
  assert.match(row.needs, /if none is running, \/mach pull in Claude Code carries it on from the build step\./);
  assert.equal(sim.activityOf(scene, sim.ref.cell("6")).label, "Carried on; waits for the line");
  const reset = sceneOf(stoppedRun({ carry: [{ by: "person-start", max: 3, then: "decided" }] }));
  const r = L.rowOfCell(reset, reset.cells["6"], now(reset));
  assert.match(r.why, /^A person started work on it again, which gave it a fresh set of rounds\./);
  assert.doesNotMatch(sim.carriedOnWords(reset.cells["6"].carriedOn[0]), /started the Factory/);
});

test("a stopped ticket stands at the station that failed it, and is never told to fix by hand or abandon", () => {
  const scene = sceneOf(stoppedRun());
  const row = L.rowOfCell(scene, scene.cells["6"], now(scene));
  assert.equal(L.LINE_STATIONS[row.column].name, "Verify");
  assert.doesNotMatch(row.needs, /by hand|abandon/);
});

test("What just happened: a stop, a carry-on, a fresh set and an abandon each have their own sentence", () => {
  const events = stoppedRun({ carry: [{ by: "person-decision", max: 4, then: "decided" }], reset: true });
  const said = events.map((e) => ({ text: sim.describeV3(e), major: sim.significanceOfEvent(e) === "major" }));
  assert.ok(said.some((s) => s.major && s.text === "6 stopped for a person: it used its judging rounds without passing, and the build station will not run another."));
  assert.ok(said.some((s) => s.major && s.text === "A person carried 6 on with a fix, which gave it one more round, round 4 of 4: it is carried on from the build step."));
  assert.ok(said.some((s) => s.major && /^A person started work on 6 again, which gave it a fresh set of rounds/.test(s.text)));
  assert.ok(said.some((s) => s.text === "6: the build station refused another round: it has used every round it is allowed."));
  const abandon = { type: "run.recorded", schema_version: 3, ids: { ticket_id: "6" }, data: { outcome: "abandoned" } };
  assert.equal(sim.significanceOfEvent(abandon), "major");
  assert.equal(sim.describeV3(abandon), "6 was abandoned: its work was deleted, and nothing of it was merged.");
});

test("every round on the drawing comes through sim/rounds.ts: no 'of 3' in the shared machines, no raw round", () => {
  const ui = readFileSync(new URL("../../../packages/ui/src/factory/machines.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /of 3`/);
  assert.doesNotMatch(ui, /×\{judging\}/);
  const bay = src("atlas/Bay.tsx");
  assert.match(bay, /round=\{st\.round\?\.n\}\s*rounds=\{st\.round\?\.of\}/);
  assert.match(bay, /RetryLoop from=\{from\} to=\{to\} round=\{roundNow\(cell\)\}/);
  assert.doesNotMatch(src("atlas/Air.tsx"), /blocked-requires-sme/);
  assert.doesNotMatch(src("line/Workspace.tsx"), /keeps its item/);
});

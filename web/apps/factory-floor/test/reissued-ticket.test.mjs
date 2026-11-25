// A ticket taken in from a GitHub issue is named by the issue's number ("6"). When its work is
// abandoned and the slice is reissued, intake uses the same ticket again (intake.py reissue): a new
// cell folder .factory/worktrees/6/ with a new lifecycle log, which the observer names as the second
// incarnation (cell:6~2, ids.cell_instance new). The events here were served by the real observer
// over a project driven through the real stations: ticket 6 groomed, planned, started, abandoned by
// cleanup; then 6 groomed, planned and started again, at work now.
//
// The scene keyed both runs by the ticket, so the ticket at work kept the first run's archive and
// run record: the Floor treated it as archived (no camera follow, no gate overlays, drawn among the
// archived cells) while the builder worked on it in the terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, live } from "./_load.mjs";

const L = await import("../src/line/model.ts");
const EVENTS = JSON.parse(readFileSync(new URL("./fixtures/reissued-ticket-6.events.json", import.meta.url), "utf8"));

const headOf = (events) => {
  const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
  log.ingest(events);
  return log.head();
};

test("the fixture is what the observer served: two runs of ticket 6, the first abandoned and archived", () => {
  const instances = [...new Set(EVENTS.filter((e) => e.ids.ticket_id === "6" && e.ids.cell_instance).map((e) => e.ids.cell_instance))];
  assert.equal(instances.length, 2);
  assert.ok(EVENTS.some((e) => e.type === "cleanup.completed" && e.data.outcome === "abandoned"));
  assert.ok(EVENTS.some((e) => e.entities.includes("cell:6~2")));
});

test("a ticket opened again after its first run was archived is the run at work, not an archived cell", () => {
  const scene = headOf(EVENTS);
  const cell = scene.cells["6"];
  assert.ok(cell, "ticket 6 is in the scene");
  assert.equal(cell.station, "build");
  assert.equal(cell.stage, "building");
  assert.equal(cell.archived, null, "the first run's archive is not this run's");
  assert.equal(cell.runRecord, null, "the first run's record (abandoned) is not this run's");
  assert.equal(cell.cellInstance, EVENTS.at(-1).ids.cell_instance);
  assert.deepEqual(cell.visits.map((v) => v.station), ["groom", "plan", "build"], "this run's visits only");
  const row = L.lineModel(scene, Date.now()).rows.find((r) => r.ticketId === "6");
  assert.equal(row.state, "working");
});

test("before the second run opens, the first run stays as it was recorded: abandoned and archived", () => {
  const firstRun = EVENTS.filter((e) => !e.entities.some((x) => x.startsWith("cell:6~2")));
  const cell = headOf(firstRun).cells["6"];
  assert.notEqual(cell.archived, null);
  assert.equal(cell.runRecord.outcome, "abandoned");
});

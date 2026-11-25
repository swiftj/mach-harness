// The working floor's places (sim/places.ts, atlas/layout.ts): a finished ticket leaves the working
// floor for the Finished shelf; a bay never moves while its ticket is at work; when one leaves, the
// others stay where they are until a new ticket takes the free place; replay shows a ticket in its bay
// at any moment in the past when it was at work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const { layout: layoutModule, locateModule } = await import("./_atlas.mjs");
const { plantLayout } = layoutModule;
const { locate } = locateModule;
const L = await import("../src/line/model.ts");
const { createSceneLog, provenance, bayPlaces, baysAt, finishedAt, finishedCells, finishedOutcomeWords, waitingForCleanup, WAITING_FOR_CLEANUP, fixtureLog, SCENARIO } = sim;

const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
const DEFS = live.LIVE_DEFINITIONS;
const logOf = () => createSceneLog({ definitions: DEFS, provenance: provenance("live") });

let seq = 0;
const intake = (type, t, ids, data) => ev(type, { stream: "intake-log", key: "i:0badc0de", seq: ++seq, t, precision: "s", ids, entities: [`slice:${ids.slice_id}`, `cell:${ids.ticket_id}`], data });
const taken = (slice, ticket, t) => intake("slice.materialized", t, { epic_id: "EPIC-1", slice_id: slice, ticket_id: ticket }, { digest: "d", adopted: false, dependencies: [], reissued: null });
const life = (type, ticket, station, t, data, inst = `c${ticket}`) =>
  ev(type, {
    stream: "cell-lifecycle",
    key: `c:${ticket}:${inst}`,
    seq: ++seq,
    t,
    ids: { ticket_id: ticket, cell_instance: inst, visit_id: `${ticket}/${station}#1`, station, round: 1 },
    entities: [`cell:${ticket}`, `visit:${ticket}/${station}#1`],
    data,
  });
const entered = (ticket, station, t, inst) => life("station.entered", ticket, station, t, { station, stage: "building", action: station, resumed: false, unclosed_visit: null, head: null, counts: {} }, inst);
const cleaned = (ticket, t, outcome = "merged") => life("cleanup.completed", ticket, "cleanup", t, { outcome, archive: null, bundle: false });
const runRecord = (ticket, t, outcome) => ev("run.recorded", { stream: "run-record", key: "r:0badc0de", seq: ++seq, t, precision: "s", ids: { ticket_id: ticket }, entities: [`cell:${ticket}`], data: { record_version: 2, outcome, rounds: 1, first_pass: true } });

// Three tickets at work; T1 is cleaned up at +60 s; T4 arrives at +120 s.
const START = [
  taken("S1", "T1", T0),
  taken("S2", "T2", T0 + 1000),
  taken("S3", "T3", T0 + 2000),
  entered("T1", "build", T0 + 10_000),
  entered("T2", "build", T0 + 11_000),
  entered("T3", "build", T0 + 12_000),
];
const T1_DONE = T0 + 60_000;
const LATER = [cleaned("T1", T1_DONE), taken("S4", "T4", T0 + 120_000), entered("T4", "build", T0 + 121_000)];

const where = (places, t) => Object.fromEntries(baysAt(places, t).map((b) => [b.ticketId, b.index]));

test("a finished ticket leaves the working floor; the others stay in their places; the next ticket takes the free place", () => {
  const log = logOf();
  log.ingest(finalize(START));
  const before = bayPlaces(log);
  assert.deepEqual(where(before, T0 + 30_000), { T1: 0, T2: 1, T3: 2 });
  log.ingest(finalize(LATER, 100));
  const after = bayPlaces(log);
  assert.deepEqual(where(after, T1_DONE + 1), { T2: 1, T3: 2 }, "T1 left; T2 and T3 did not move");
  assert.deepEqual(where(after, T0 + 130_000), { T4: 0, T2: 1, T3: 2 }, "T4 takes the place T1 left");
  assert.equal(after.capacity, 3, "the floor's size is the most at work at once, not the tickets seen");
});

test("a bay never moves while its ticket is at work, however its records arrive", () => {
  const all = logOf();
  all.ingest(finalize([...START, ...LATER]));
  const together = bayPlaces(all);
  // The same history in pieces, one record at a time: every place a ticket at work held stays its place.
  const pieces = logOf();
  const held = new Map();
  for (const [i, e] of finalize([...START, ...LATER]).entries()) {
    pieces.ingest([{ ...e, pos: i + 1 }]);
    const p = bayPlaces(pieces);
    for (const b of baysAt(p, pieces.headTime())) {
      if (held.has(b.ticketId)) assert.equal(b.index, held.get(b.ticketId), `${b.ticketId} moved while at work`);
      held.set(b.ticketId, b.index);
    }
  }
  assert.deepEqual(where(bayPlaces(pieces), T0 + 130_000), where(together, T0 + 130_000), "in pieces or at once, the same places");
});

test("replay: at any moment in the past when a ticket was at work, it is in its bay", () => {
  const log = logOf();
  log.ingest(finalize([...START, ...LATER]));
  const places = bayPlaces(log);
  assert.equal(where(places, T0 + 59_000).T1, 0, "T1 at work at +59 s: in place 0");
  assert.equal(where(places, T1_DONE).T1, undefined, "finished at +60 s: gone");
  assert.equal(where(places, T0 + 5_000).T4, undefined, "T4 not there before it arrived");
  // The scene at a past moment agrees: T1 is not finished then.
  assert.equal(finishedAt(log.sceneAt(T0 + 59_000).cells.T1), null);
});

test("with no archive kept, the run record alone takes a finished ticket off the floor", () => {
  const log = logOf();
  log.ingest(finalize([...START, runRecord("T2", T0 + 70_000, "abandoned")]));
  const places = bayPlaces(log);
  assert.deepEqual(where(places, T0 + 80_000), { T1: 0, T3: 2 });
  const scene = log.head();
  assert.deepEqual(finishedCells(scene, Infinity).map((c) => c.ticketId), ["T2"]);
  assert.equal(finishedOutcomeWords(scene.cells.T2), "abandoned");
});

test("the layout: a bay's position depends on its place alone, and nothing downstream moves when a ticket leaves", () => {
  const log = logOf();
  log.ingest(finalize([...START, ...LATER]));
  const places = bayPlaces(log);
  const at = (t) => plantLayout(baysAt(places, t), places.capacity);
  const working = at(T0 + 30_000);
  const left = at(T1_DONE + 1);
  assert.deepEqual(left.bayByTicket.get("T2").origin, working.bayByTicket.get("T2").origin);
  assert.deepEqual(left.bayByTicket.get("T3").origin, working.bayByTicket.get("T3").origin);
  assert.equal(left.bayByTicket.has("T1"), false);
  assert.ok(left.freeBays.some((f) => f.index === 0), "T1's place is free");
  assert.deepEqual(left.regions, working.regions, "the floor and the regions downstream stay where they are");
  assert.deepEqual(left.tracks.spine, working.tracks.spine);
  assert.equal(at(T0 + 130_000).bayByTicket.get("T4").origin.x, working.bayByTicket.get("T1").origin.x, "T4 stands where T1 stood");
});

test("a finished ticket is found on the Finished shelf, and stays selectable", () => {
  const log = logOf();
  log.ingest(finalize([...START, ...LATER]));
  const places = bayPlaces(log);
  const layout = plantLayout(baysAt(places, T0 + 130_000), places.capacity);
  const scene = log.sceneAt(T0 + 130_000);
  const [box] = locate(layout, scene, T0 + 130_000, "cell:T1");
  assert.ok(box, "a finished ticket has a place to frame");
  assert.ok(box.x >= layout.regions.archive.x && box.x <= layout.regions.archive.x + layout.regions.archive.w, "on the shelf, in the archive");
  assert.deepEqual(locate(layout, scene, T0 + 130_000, "cell:T2").length, 1, "a ticket at work is framed in its bay");
});

test("merged and not yet cleaned up: still on the working floor, said plainly", () => {
  const merged = life("merge.completed", "T2", "merge", T0 + 40_000, { method: "local", approved_commit: "a", landed_commit: "b", merge_commit: "c", revalidated: false, change_record: null });
  const log = logOf();
  log.ingest(finalize([...START, merged]));
  const cell = log.head().cells.T2;
  assert.equal(waitingForCleanup(cell), true);
  assert.equal(WAITING_FOR_CLEANUP, "Merged, waiting for cleanup");
  assert.equal(where(bayPlaces(log), T0 + 50_000).T2, 1, "on the floor until cleanup closes it");
  const row = L.lineModel(log.head(), T0 + 50_000).rows.find((r) => r.ticketId === "T2");
  assert.equal(row.state, "landed");
  assert.equal(row.finished, false);
  assert.match(row.why, /^Merged, waiting for cleanup/);
});

test("a ticket used again keeps its place for its new run, and is off the floor between the runs", () => {
  const EVENTS = JSON.parse(readFileSync(new URL("./fixtures/reissued-ticket-6.events.json", import.meta.url), "utf8"));
  const log = logOf();
  log.ingest(EVENTS);
  const places = bayPlaces(log);
  const runs = places.spans.filter((s) => s.ticketId === "6");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].index, runs[1].index, "the same place");
  assert.ok(runs[0].to !== null && runs[0].to <= runs[1].from);
  assert.equal(where(places, runs[0].to)["6"], undefined, "between the runs it is not drawn at work");
  assert.equal(where(places, log.headTime())["6"], runs[1].index);
});

test("the simulation: archived cells leave the floor as the scenario plays, and are in place before", () => {
  const log = fixtureLog(SCENARIO);
  const places = bayPlaces(log);
  const scene = log.head();
  const done = finishedCells(scene, Infinity);
  assert.ok(done.length >= 1, "the scenario archives cells");
  for (const c of done) {
    const at = finishedAt(c);
    assert.equal(where(places, at - 1)[c.ticketId] !== undefined, true, `${c.ticketId} in its bay just before it finished`);
    assert.equal(where(places, at)[c.ticketId], undefined, `${c.ticketId} gone once finished`);
  }
});

test("the Line says finished plainly: a closed ticket is 'Abandoned', finished rows say 'finished ... ago'", () => {
  const log = logOf();
  log.ingest(finalize([...START, runRecord("T2", T0 + 70_000, "abandoned"), ...LATER]));
  const model = L.lineModel(log.head(), T0 + 200_000);
  const t2 = model.rows.find((r) => r.ticketId === "T2");
  assert.equal(t2.state, "closed");
  assert.equal(L.STATE_WORDS.closed, "Abandoned");
  assert.equal(t2.finished, true);
  assert.equal(t2.why, "Finished: abandoned, and cleaned up. Nothing of it was merged.");
  const t1 = model.rows.find((r) => r.ticketId === "T1");
  assert.equal(t1.finished, true);
  // Finished rows come after the rows still in the line.
  const firstDone = model.rows.findIndex((r) => r.finished);
  assert.ok(model.rows.slice(firstDone).every((r) => r.finished));
});

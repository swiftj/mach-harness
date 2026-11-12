// M6.2: duplicates, reordering and late events. In-order delivery, any arrival order within the settle
// bound, and any number of re-deliveries give the identical scene; a late event re-derives from the
// nearest checkpoint, at a bounded cost, keeping the identity of everything it did not change; ids are
// never parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { beltRun, finalize, seededIds } from "./fixtures/v3.mjs";
import { seeded } from "./fixtures/observer.mjs";

const { createSceneLog, provenance, findAgent, entityAt, relatedRefs, liveEntityAt, activityOf } = sim;
const make = (extra = {}) => createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live"), checkpointEvery: 32, cacheSize: 64, ...extra });

const TWO = finalize([...beltRun({ ticket: "LOCAL-031", slice: "SLICE-021", execution: "x00000000031a" }).events, ...beltRun({ ticket: "LOCAL-032", slice: "SLICE-022", execution: "x00000000032b", intakeGen: "1badc0de", cellGen: "4f2a9c1e", t0: Date.UTC(2026, 10, 12, 9, 0, 30) }).events]);
const SETTLE_MS = 1500;
const inOrder = (() => {
  const log = make();
  log.ingest(TWO);
  return log.head();
})();

/** Deliver in batches whose order is shuffled within the settle bound, with duplicates sprinkled in. */
function deliver(events, rand, { duplicates = 0.1 } = {}) {
  const keyed = events.map((e) => ({ e, key: e.time.order_ms + rand() * SETTLE_MS }));
  keyed.sort((a, b) => a.key - b.key);
  const arrival = [];
  for (const { e } of keyed) {
    arrival.push(e);
    if (rand() < duplicates) arrival.push(structuredClone(e));
  }
  const batches = [];
  for (let i = 0; i < arrival.length; ) {
    const n = 1 + Math.floor(rand() * 40);
    batches.push(arrival.slice(i, i + n));
    i += n;
  }
  return batches;
}

test("duplicates and reordering within the settle bound give the identical scene (60 shuffles)", () => {
  let lateTotal = 0;
  let rederivedTotal = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = seeded(seed);
    const log = make();
    let dupes = 0;
    for (const batch of deliver(TWO, rand)) {
      const r = log.ingest(batch);
      dupes += r.duplicates;
      lateTotal += r.late;
      rederivedTotal += r.rederived;
    }
    assert.deepStrictEqual(log.head(), inOrder, `seed ${seed}`);
    assert.ok(dupes > 0, "the delivery had duplicates");
    assert.equal(log.stats().conflicts, 0);
    assert.equal(log.size(), TWO.length);
  }
  assert.ok(lateTotal > 0, "some deliveries were late and re-derived");
  // Each late insert re-derives from the checkpoint before it: bounded by the reorder depth plus a checkpoint interval per batch.
  assert.ok(rederivedTotal / lateTotal < 400, `re-derivation per late event: ${(rederivedTotal / lateTotal).toFixed(1)} reductions`);
});

test("a pure re-delivery changes nothing: same head object, no transition", () => {
  const log = make();
  log.ingest(TWO);
  const head = log.head();
  const version = log.version();
  const r = log.ingest(TWO.slice(100, 180).map((e) => ({ ...structuredClone(e), pos: e.pos + 10_000, late: true })));
  assert.equal(r.duplicates, 80);
  assert.equal(r.added, 0);
  assert.equal(log.head(), head, "identical object: nothing re-renders");
  assert.equal(log.version(), version);
  // Same id with different content: a conflict, the first kept.
  const changed = { ...TWO[150], data: { ...TWO[150].data, extra: true } };
  assert.equal(log.ingest([changed]).conflicts, 1);
  assert.equal(log.head(), head);
});

test("a late event re-derives the affected scenes from the nearest checkpoint, keeping unchanged entities' identity", () => {
  const lateIndex = TWO.findIndex((e, i) => i > TWO.length - 200 && e.ids.ticket_id === "LOCAL-031" && e.type === "agent.progressed");
  const late = TWO[lateIndex];
  const log = make();
  log.ingest(TWO.filter((_, i) => i !== lateIndex));
  const before = log.head();
  const other = before.cells["LOCAL-032"];
  const r = log.ingest([{ ...late, late: true }]);
  assert.equal(r.late, 1);
  assert.ok(r.rederived > 0 && r.rederived <= TWO.length - lateIndex + 32, `re-derived ${r.rederived} for an event ${TWO.length - lateIndex} from the head`);
  assert.deepStrictEqual(log.head(), inOrder);
  assert.equal(log.head().cells["LOCAL-032"], other, "a cell the late event did not touch keeps its object");
  // Scenes before the insertion point are untouched; at it, the late event is in.
  assert.equal(log.sceneAt(late.time.order_ms).lastEventId !== undefined, true);
  assert.ok(log.entry(late.id).late);
});

test("an event older than the retained floor is refused; memory is bounded by `retain`", () => {
  const log = make({ retain: 200, checkpointEvery: 16 });
  log.ingest(TWO);
  const s = log.stats();
  assert.ok(s.events <= 200 + Math.max(16, 20), `kept ${s.events}`);
  assert.ok(s.dropped > 0 && s.compactions > 0);
  assert.deepStrictEqual(log.head(), inOrder, "compaction never changes the head");
  assert.equal(log.ingest([{ ...TWO[3], id: "i:0badc0de:99999" }]).belowFloor, 1);
  assert.equal(log.sceneAtCursor(0).cursor, log.dropped(), "replay cannot go below the floor");
});

test("no id is parsed: opaque, random ids with separators work everywhere", () => {
  const rand = seeded(7);
  const ids = seededIds(rand);
  const ticket = ids.ticket();
  const execution = ids.execution();
  const run = beltRun({ ticket, slice: "SLICE-0x", execution, ids: { agent: ids.agent, gen: () => "3f2a9c1e" } });
  const log = make();
  log.ingest(finalize(run.events));
  const head = log.head();
  const cell = head.cells[ticket];
  assert.ok(cell, "the cell is found under its opaque ticket id");
  assert.equal(cell.stage, "approved");
  for (const a of run.agents) {
    const agent = findAgent(head, a.id);
    assert.ok(agent, a.id);
    assert.equal(agent.ticketId, ticket);
    assert.equal(entityAt(head, `agent:${a.id}`).value.id, a.id);
    assert.ok(relatedRefs(head, `agent:${a.id}`).includes(`cell:${ticket}`));
    assert.equal(activityOf(head, `agent:${a.id}`).state, "completed");
  }
  assert.equal(liveEntityAt(head, `workflow:${execution}/task0001`).value.id, execution);
});

// Defects found while capturing real execution (docs/mach-next/M6_2_COMPLETION.md, section 7):
// a visit that stopped and was taken up again never "took" its whole span; the Factory's own
// lifecycle events read as sentences; and real history's playback speeds are named against real time.
// (The fourth, a viewport that scrolled when focus landed outside it, is CSS: `overflow: clip`.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, scene, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const words = await import("../src/shell/inspector/words.ts");
const { createSceneLog, provenance, entityAt, describeV3 } = sim;
const T0 = Date.UTC(2026, 10, 13, 5, 30, 0);
const TICKET = "LOCAL-001";
const logOf = (events) => {
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  log.ingest(events);
  return log;
};

test("a build visit that its execution left and a later one finished is 'not continuous', never 'took'", () => {
  const out = [];
  let seq = 0;
  const ids = (x) => ({ ticket_id: TICKET, visit_id: `${TICKET}/build#1`, station: "build", round: 1, execution_id: x });
  const entities = [`cell:${TICKET}`, `station:${TICKET}/build`, `visit:${TICKET}/build#1`];
  out.push(ev("station.entered", { stream: "cell-lifecycle", key: `c:${TICKET}:k`, seq: ++seq, t: T0, ids: ids("x1"), entities, data: { station: "build", stage: "building", action: "build", resumed: false, unclosed_visit: null, head: null, counts: {} } }));
  out.push(ev("execution.process_ended", { stream: "execution-record", key: "x:x1", seq: 2, t: T0 + 136_000, precision: "s", ids: { ticket_id: TICKET, execution_id: "x1" }, entities: ["execution:x1", `cell:${TICKET}`], data: { ended: "exited", exit_code: 0, seconds: 136 } }));
  const before = entityAt(logOf(finalize([...out])).head(), `visit:${TICKET}/build#1`).value;
  assert.equal(before.unclosed.reason, "execution-ended");
  out.push(ev("station.exited", { stream: "cell-lifecycle", key: `c:${TICKET}:k`, seq: ++seq, t: T0 + 3_608_000, ids: ids("x2"), entities, data: { station: "build", outcome: "built", stage: "built", duration_ms: 1000, closed_by: null, head: null, counts: {} } }));
  const v = entityAt(logOf(finalize(out)).head(), `visit:${TICKET}/build#1`).value;
  assert.deepEqual([v.leftAt, v.outcomeWord, v.unclosed], [T0 + 3_608_000, "built", null]);
  assert.deepEqual(v.interrupted, { reason: "execution-ended", at: T0 + 136_000 });
  assert.equal(words.elapsedWords("interrupted", true, true, "1 h 0 min"), "open for 1 h 0 min, not continuous");
  assert.match(words.interruptionWords(v, () => "05:32:16"), /^its execution ended by 05:32:16 and the visit was taken up again later$/);
  assert.equal(words.interruptionWords({ interrupted: null }, String), null);
});

test("a visit that ran through is not marked interrupted", () => {
  const ids = { ticket_id: TICKET, visit_id: `${TICKET}/build#1`, station: "build", round: 1, execution_id: "x1" };
  const entities = [`cell:${TICKET}`, `station:${TICKET}/build`, `visit:${TICKET}/build#1`];
  const out = [
    ev("station.entered", { stream: "cell-lifecycle", key: `c:${TICKET}:k`, seq: 1, t: T0, ids, entities, data: { station: "build", stage: "building", action: "build", resumed: false, unclosed_visit: null, head: null, counts: {} } }),
    ev("station.exited", { stream: "cell-lifecycle", key: `c:${TICKET}:k`, seq: 2, t: T0 + 60_000, ids, entities, data: { station: "build", outcome: "built", stage: "built", duration_ms: 60_000, closed_by: null, head: null, counts: {} } }),
  ];
  const v = entityAt(logOf(finalize(out)).head(), `visit:${TICKET}/build#1`).value;
  assert.ok(!v.interrupted);
});

test("the Factory's lifecycle events are sentences, by role only", () => {
  const say = (type, data) => describeV3(ev(type, { stream: "intake-log", key: "i:k", seq: 1, t: T0, precision: "s", ids: {}, entities: [], data }));
  assert.equal(say("factory.disabled", { by_role: "engineer", stopped: false }), "An engineer disabled the Factory on this machine.");
  assert.equal(say("factory.disabled", { by_role: "engineer", stopped: true }), "An engineer disabled the Factory on this machine, stopping what was running.");
  assert.equal(say("factory.activated", { by_role: "engineer", autonomy: "supervised", limits: {}, allow_merge: false, persistent: false, backlog: null, excluded_slices: [] }), "An engineer enabled the Factory on this machine (supervised).");
  assert.equal(say("factory.paused", { by_role: "supervisor", reason: "the day's budget is spent" }), "The supervisor paused the Factory: the day's budget is spent.");
  assert.equal(say("factory.resumed", { by_role: "person", retrying: [] }), "A person resumed the Factory.");
});

test("real history's speeds are named against real time; the simulation's stay relative", () => {
  const { playbackFactorOf, playbackFactorLabel, playbackFactorWords, PLAYBACK_BASE_RATE, SPEEDS } = scene;
  assert.deepEqual(SPEEDS.map((s) => playbackFactorLabel("replay", s)), ["5×", "10×", "20×", "40×", "80×", "160×"]);
  assert.deepEqual(SPEEDS.map((s) => playbackFactorLabel("live", s)), ["5×", "10×", "20×", "40×", "80×", "160×"]);
  assert.deepEqual(SPEEDS.map((s) => playbackFactorLabel("simulation", s)), ["½×", "1×", "2×", "4×", "8×", "16×"]);
  assert.equal(playbackFactorOf("replay", 2), 2 * PLAYBACK_BASE_RATE, "the label is the rate the store plays real history at");
  assert.equal(playbackFactorWords("replay", 2), "20 times real time");
  assert.equal(playbackFactorWords("simulation", 2), "2 times");
});

test("the viewports clip: focus landing outside them cannot scroll the drawing away", () => {
  for (const file of ["../src/atlas/atlas.css", "../src/blueprint/blueprint.css"]) {
    const css = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(css, /overflow: hidden;[\s\S]{0,400}?overflow: clip;/, file);
  }
});

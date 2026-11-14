// M6.6 (floor): a real supervised run held SLICE-003 for four minutes because the readiness audit
// was stale (scheduling.decided held[].why, words only). The floor, the Waiting list and the slice
// inspector said "Eligible". The scene now keeps the supervisor's holds with their recorded words,
// classifies nothing from them, and carries the slice title the observer took from the intake ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const { createSceneLog, provenance, activityOf, sliceHoldOf, holdOf, isKnown } = sim;
const t0 = Date.UTC(2026, 10, 14, 15, 10, 37, 999);
const WHY = "Dispatch by 'supervisor' was not authorized: the readiness audit is stale. Nothing was dispatched.";
let seq = 0;
const intake = (type, t, ids, data) => ev(type, { stream: "intake-log", key: "i:cb515669", seq: ++seq, t, precision: "s", ids: { project_id: "textkit", wave_id: "WAVE-001", ...ids }, entities: ids.slice_id ? [`slice:${ids.slice_id}`] : [], data });

function run({ releaseHold = false, title = "Unique link name" } = {}) {
  seq = 0;
  const events = [
    intake("wave.discovered", t0, {}, { slices: ["SLICE-003"], approval: { approved_at: "2026-11-13T09:00:00Z", by_role: "person" } }),
    intake("slice.materialized", t0, { slice_id: "SLICE-003", ticket_id: "LOCAL-003", revision: 2 }, { digest: "c".repeat(64), adopted: false, dependencies: [], reissued: null, title }),
    intake("dependency.resolved", t0, { slice_id: "SLICE-003", ticket_id: "LOCAL-003", revision: 2 }, { depends_on: [] }),
    intake("scheduling.decided", t0 + 494_000, {}, { state: "supervised", dispatched: [], started: [], held: [{ slice_id: "SLICE-003", why: WHY }] }),
  ];
  if (releaseHold) events.push(intake("scheduling.decided", t0 + 738_000, {}, { state: "supervised", dispatched: ["SLICE-003"], started: [], held: [] }));
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  log.ingest(finalize(events));
  return log.head();
}

test("a held slice keeps the supervisor's words and since when, and nothing classifies them", () => {
  const scene = run();
  const slice = scene.slices["SLICE-003"];
  assert.equal(slice.scheduler, "eligible");
  const hold = sliceHoldOf(scene, slice);
  assert.deepEqual(hold, { why: WHY, since: t0 + 494_000 });
  assert.deepEqual(holdOf(scene.supervisor.holds, slice), hold);
  const a = activityOf(scene, "slice:SLICE-003");
  // Not "waiting-person", not "waiting-resources": only the words are recorded.
  assert.equal(a.state, "unknown");
  assert.equal(a.label, "Held by the supervisor");
  assert.ok(!a.reason.includes("authorized"), "the activity's reason quotes no prose (it may reach an accessible name)");
  assert.equal(a.since, t0 + 494_000);
});

test("a hold ends with the decision that no longer holds it", () => {
  const scene = run({ releaseHold: true });
  assert.equal(sliceHoldOf(scene, scene.slices["SLICE-003"]), null);
  assert.deepEqual(scene.supervisor.holds, {});
});

test("the slice title recorded by the intake ledger reaches the scene; none recorded stays unknown", () => {
  const titled = run().slices["SLICE-003"];
  assert.equal(titled.title, "Unique link name");
  assert.ok(isKnown(titled.meta, "title"));
  const untitled = run({ title: null }).slices["SLICE-003"];
  assert.equal(untitled.title, "SLICE-003");
  assert.ok(!isKnown(untitled.meta, "title"));
});

test("the floor pad, the Waiting list and the slice inspector show the hold, its words contained", () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const pad = src("atlas/Stations.tsx");
  assert.match(pad, /HELD · SUPERVISOR/);
  assert.match(pad, /hold=\{sliceHoldOf\(scene, scene\.slices\[b\.sliceId\]\)\}/);
  for (const p of ["shell/inspector/RunNow.tsx", "shell/inspector/anatomies.tsx"]) {
    assert.match(src(p), /<FreeText field="heldWhy" text=\{hold\.why\} labelled \/>/, p);
  }
});

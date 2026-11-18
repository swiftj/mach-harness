// M7 N6 and the page half of N7, from the second live run's records (lending-desk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

function run() {
  let seq = 0;
  const t0 = Date.UTC(2026, 10, 15, 1, 0, 0, 999);
  const i = (type, t, ids, data, stream = "intake-log") => ev(type, { stream, key: stream === "intake-log" ? "i:92586180" : "r:runs", seq: ++seq, t, precision: "s", ids: { project_id: "lending-desk", wave_id: "WAVE-003", ...ids }, entities: ids.slice_id ? [`slice:${ids.slice_id}`] : [], data });
  const events = [
    i("slice.materialized", t0, { slice_id: "SLICE-005", ticket_id: "LOCAL-003", revision: 4 }, { digest: "a".repeat(64), adopted: false, dependencies: [], reissued: null, title: null }),
    i("human.required", t0 + 1000, { slice_id: "SLICE-005", ticket_id: "LOCAL-003", revision: 4 }, { reason: "2 execution(s) ended without moving it past 'building'." }),
    i("run.recorded", t0 + 50_000, { slice_id: "SLICE-005", ticket_id: "LOCAL-003" }, { record_version: 2, outcome: "abandoned", rounds: null, first_pass: false }, "run-record"),
    i("human.required", t0 + 60_000, { slice_id: "SLICE-005", ticket_id: "LOCAL-003", revision: 4 }, { reason: "Its ticket LOCAL-003 was abandoned. Reissue it to try again." }),
    i("slice.materialized", t0 + 70_000, { slice_id: "SLICE-005", ticket_id: "LOCAL-006", revision: 4 }, { digest: "a".repeat(64), adopted: false, dependencies: [], reissued: true, title: null }),
    i("work.claimed", t0 + 100_000, { slice_id: "SLICE-005", ticket_id: "LOCAL-006", execution_id: "x207c3682ca00" }, { stage: "spec-ready", next: "plan", attempt: 1 }),
    i("execution.started", t0 + 100_500, { slice_id: "SLICE-005", ticket_id: "LOCAL-006", execution_id: "x207c3682ca00" }, { until: "merge", workflow: "mach-belt", limits: { minutes: 30, budget_usd: 2.5 }, provenance: null, provenance_reason: "not-recorded", source_commit: null }),
    i("execution.failed", t0 + 200_000, { slice_id: "SLICE-005", ticket_id: "LOCAL-006", execution_id: "x207c3682ca00" }, { attempt: 1, claude_error: null, exit_code: -9, how: "killed", next: "plan", stage: "spec-ready" }),
  ];
  const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
  log.ingest(finalize(events));
  return log.head();
}

test("N6: a killed execution that did not move the ticket reads killed, with its exit code", () => {
  const s = run();
  const x = s.executions["x207c3682ca00"];
  assert.equal(sim.executionStatusOf(x).word, "Killed (exit -9)");
  const a = sim.activityOf(s, sim.ref.execution("x207c3682ca00"));
  assert.equal(a.label, "Killed");
  assert.match(a.reason, /exit -9/);
});

test("N7: an abandoned ticket waits on nobody and says what it was reissued as", () => {
  const s = run();
  assert.equal(s.supervisor.attention["LOCAL-003"], undefined);
  const cell = s.cells["LOCAL-003"];
  assert.equal(sim.reissuedAs(s, cell), "LOCAL-006");
  assert.equal(sim.ticketClosed(s, "LOCAL-003"), true);
  assert.equal(sim.ticketClosed(s, "LOCAL-006"), false);
  assert.equal(sim.activityOf(s, sim.ref.cell("LOCAL-003")).label, "Abandoned, reissued as LOCAL-006");
});

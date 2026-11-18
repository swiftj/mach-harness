// M7 follow-up: the page's words for a repeat review after a voided approval, a voided decision, a
// claim released before starting, a killed execution, a ticket parked as not progressing, and the
// release readiness snapshot. Codes in, fixed words out; never the recorded prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const pulse = await import("../src/analytics/model/pulse.ts");

test("a repeat review and a voided decision are worded from codes", () => {
  assert.equal(sim.reviewRepeatWords(1, "branch-changed-after-approval"), "Review repeated after the approval was voided: the branch changed");
  assert.equal(sim.reviewRepeatWords(null, "branch-changed-after-approval"), null);
  assert.equal(sim.voidedDecisionWords({ reason_code: "branch-changed-after-approval", outcome_before: "APPROVED" }), "Approved, then voided: the branch changed. Not the standing decision.");
  assert.equal(sim.voidedDecisionWords(null), null);
  const entry = live.readArtifactEntry({ id: "a", path_rel: "review/round-2/decision.json", round: 2, voided: { reason_code: "branch-changed-after-approval", outcome_before: "APPROVED" } });
  assert.equal(entry.voided.reason_code, "branch-changed-after-approval");
  assert.equal(live.readArtifactEntry({ id: "b", round: 2, repeat: 1 }).repeat, 1);
});

test("killed and released executions, and a parked ticket, in words", () => {
  const base = { processEndedAt: null, ended: null, recovery: null, movedOnAt: null };
  assert.equal(sim.executionStatusOf({ ...base, state: "completed", how: "killed", releasedAt: null }).word, "Killed");
  assert.equal(sim.executionStatusOf({ ...base, state: "claimed", how: null, releasedAt: 5 }).word, "Released before starting");
  assert.equal(sim.executionStatusOf({ ...base, state: "completed", how: "exited", releasedAt: null }).word, "Completed");
  assert.equal(sim.parkedWords("same-refusal"), "Parked: the build stopped on the same task with the same refusal twice");
  assert.equal(sim.parkedWords("anything else"), null);
});

test("the live reducer: a released claim, a killed run and a parked ticket from the supervisor's events", () => {
  let seq = 0;
  const t0 = Date.UTC(2026, 10, 14, 23, 3, 0, 999);
  const i = (type, t, ids, data) => ev(type, { stream: "intake-log", key: "i:92586180", seq: ++seq, t, precision: "s", ids: { project_id: "lending-desk", ...ids }, entities: [], data });
  const events = [
    i("work.claimed", t0, { ticket_id: "LOCAL-003", slice_id: "SLICE-005", execution_id: "xa1b6c30c0e44" }, { stage: "building", next: "build", attempt: 1 }),
    i("scheduling.decided", t0, {}, { state: "supervised", dispatched: [], started: [], held: [{ slice_id: "SLICE-005", ticket_id: "LOCAL-003", why: "the readiness audit is stale" }] }),
    i("work.claimed", t0 + 60_000, { ticket_id: "LOCAL-003", slice_id: "SLICE-005", execution_id: "xcd07441a6874" }, { stage: "building", next: "build", attempt: 2 }),
    i("execution.started", t0 + 61_000, { ticket_id: "LOCAL-003", slice_id: "SLICE-005", execution_id: "xcd07441a6874" }, { until: "merge", workflow: "mach-belt", limits: { minutes: 30, budget_usd: 2.5 }, provenance: null, provenance_reason: "not-recorded", source_commit: null }),
    i("execution.failed", t0 + 200_000, { ticket_id: "LOCAL-003", slice_id: "SLICE-005", execution_id: "xcd07441a6874" }, { stage: "building", next: "build", how: "exited", claude_error: null, exit_code: 0, attempt: 2, not_progressing: "same-refusal" }),
    i("human.required", t0 + 200_000, { ticket_id: "LOCAL-003", slice_id: "SLICE-005", execution_id: "xcd07441a6874" }, { reason: "Two executions in a row stopped at build task T05." }),
    i("work.claimed", t0 + 300_000, { ticket_id: "LOCAL-002", slice_id: "SLICE-002", execution_id: "xf4a33789d169" }, { stage: "building", next: "build", attempt: 1 }),
    i("execution.completed", t0 + 400_000, { ticket_id: "LOCAL-002", slice_id: "SLICE-002", execution_id: "xf4a33789d169" }, { stage: "built", next: "verify", waiting_for: null, how: "killed", exit_code: -9, seen_to_end: true, cost_usd: null, refused_tools: [] }),
  ];
  const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
  log.ingest(finalize(events));
  const s = log.head();
  assert.equal(sim.executionStatusOf(s.executions["xa1b6c30c0e44"]).word, "Released before starting");
  assert.equal(sim.executionStatusOf(s.executions["xf4a33789d169"]).word, "Killed (exit -9)");
  assert.equal(s.executions["xf4a33789d169"].exitCode, -9);
  assert.equal(sim.parkedWords(s.supervisor.attention["LOCAL-003"].code), "Parked: the build stopped on the same task with the same refusal twice");
});

test("the release readiness snapshot line, never inferred", () => {
  const latest = { release_id: "WAVE-002-e325cb6f23ba", commit: "e325cb6f23babe1c9ef56c561d9063e83c4b216d", outcome: "qualified_with_exceptions", product_acceptance: "accepted", waves: [], evaluated_at: "2026-11-14T23:00:08Z" };
  assert.equal(pulse.readinessLine({ ok: true, data: { items: [latest], latest } }), "Release WAVE-002-e325cb6f23ba at e325cb6f23ba: qualified with exceptions; product acceptance: accepted");
  assert.equal(pulse.readinessLine({ ok: true, data: { items: [], latest: null } }), null);
  assert.equal(pulse.readinessLine(null), null);
  assert.match(pulse.readinessLine({ data: { latest: { ...latest, product_acceptance: "Ann accepted it" } } }), /product acceptance: not recorded$/);
});

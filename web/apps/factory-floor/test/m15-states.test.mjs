// M15: the Factory changes of M13 and M14 on the Factory Floor. Each new wait has its own reason on the
// Line (place, shape from the existing five states, the "Needs you" entry where a person must act, the
// sentence, the real command), the Floor draws it consistently, a repeat review round is its own visit,
// the Jira key and the change record are identifiers on the ticket, and a design mock's check shows the
// approved mock beside the capture with the recorded result. Unknown codes fall back to what was shown before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const L = await import("../src/line/model.ts");
const E = await import("../src/evidence/model.ts");
const { createSceneLog, provenance, activityOf } = sim;

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);

/** A small live history builder: intake lines and one cell's lifecycle lines, in order. */
function history(ticket = "T-15") {
  const out = [];
  let iseq = 0;
  let cseq = 0;
  let t = T0;
  const visits = {};
  let current = null;
  const api = {
    t: () => t,
    wait(ms = 1000) {
      t += ms;
      return api;
    },
    intake(type, data, ids = {}, writer = "supervisor") {
      out.push(ev(type, { stream: "intake-log", key: "i:0badc0de", seq: ++iseq, t, precision: "s", ids: { slice_id: "SLICE-015", ticket_id: ticket, ...ids }, entities: [`cell:${ticket}`], data, writer }));
      t += 1000;
      return api;
    },
    life(type, data, round = 1) {
      out.push(ev(type, { stream: "cell-lifecycle", key: `c:${ticket}:3f2a9c1e`, seq: ++cseq, t, ids: { ticket_id: ticket, slice_id: "SLICE-015", cell_instance: "3f2a9c1e", visit_id: current?.id ?? null, station: current?.station ?? null, round }, entities: [`cell:${ticket}`], data }));
      t += 1000;
      return api;
    },
    enter(station, stage, round = 1) {
      visits[station] = (visits[station] ?? 0) + 1;
      current = { station, id: `${ticket}/${station}#${visits[station]}` };
      return api.life("station.entered", { station, stage, action: null, resumed: false, unclosed_visit: null, head: null, counts: {} }, round);
    },
    exit(outcome, stage, round = 1) {
      api.life("station.exited", { station: current.station, outcome, stage, duration_ms: 1000, closed_by: null, head: null, counts: {} }, round);
      current = null;
      return api;
    },
    gate(gate, verdict, reason, counts = {}, round = 1) {
      return api.life("gate.evaluated", { gate, verdict, reason_code: reason, subject: null, status: null, audit_tier: null, counts }, round);
    },
    scene() {
      const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
      log.ingest(finalize(out));
      return log.head();
    },
  };
  return api;
}

const planned = (h) => h.enter("groom", "interview").exit("spec-ready", "spec-ready").enter("plan", "spec-ready").exit("planned", "planned");
const rowOf = (scene, id) => L.lineModel(scene, T0 + 3_600_000).rows.find((r) => r.ticketId === id);

test("a conflict with main recorded by the build station is its own wait: a person resolves it", () => {
  const scene = planned(history()).gate("build.start", "refused", "main-conflict").scene();
  const row = rowOf(scene, "T-15");
  assert.equal(row.state, "person");
  assert.equal(row.stop, "main-conflict");
  assert.equal(L.LINE_STATIONS[row.column].key, "build");
  assert.match(row.why, /main branch conflicts/);
  assert.equal(row.command, "/mach decide T-15");
  assert.equal(row.alsoCommand, "/mach explain T-15");
  assert.equal(L.needVerb(row), "Resolve the conflict with main on");
  const model = L.lineModel(scene, T0 + 3_600_000);
  assert.ok(model.needs.some((r) => r.ticketId === "T-15"), "in the Needs you strip");
  const a = activityOf(scene, "cell:T-15");
  assert.equal(a.state, "waiting-person", "the Floor draws it as a wait for a person too");
});

test("a conflict resolved (the build entered again) is no longer a wait", () => {
  const scene = planned(history()).gate("build.start", "refused", "main-conflict").enter("build", "planned").scene();
  const row = rowOf(scene, "T-15");
  assert.equal(row.state, "working");
  assert.equal(row.stop ?? null, null);
});

test("the supervisor's recorded stop says main-conflict; an unknown code reads as before", () => {
  const known = planned(history()).intake("human.required", { reason: "waiting for main-conflict", needs: "main-conflict" }).scene();
  const row = rowOf(known, "T-15");
  assert.equal(row.stop, "main-conflict");
  assert.equal(row.personWords, "waiting for main-conflict");
  const unknown = planned(history()).intake("human.required", { reason: "waiting for a-future-stop", needs: null }).scene();
  const other = rowOf(unknown, "T-15");
  assert.equal(other.state, "person");
  assert.equal(other.stop ?? null, null);
  assert.equal(other.why, "The line recorded that a person is needed before it can go on.");
  assert.equal(L.needVerb(other), "Decide on");
});

test("a spec held only by a policy concern waits for the policy's owner, with the accept command", () => {
  const h = history().enter("groom", "interview").gate("groom.finalize", "refused", "open-questions", { open_questions: 0 }, null).exit("spec-open", "spec-open", null);
  const row = rowOf(h.scene(), "T-15");
  assert.equal(row.state, "person");
  assert.equal(row.stop, "policy-owner");
  assert.equal(L.LINE_STATIONS[row.column].key, "groom");
  assert.equal(row.command, '/mach policy accept T-15 <POL-id> "<the owner\'s words>"');
  assert.equal(row.alsoCommand, "/mach explain T-15");
  assert.match(row.needs, /owner accepts/);
  assert.equal(activityOf(h.scene(), "cell:T-15").label, "Waits for the policy's owner");
  // Open questions as well: the interview goes on, as before.
  const q = history().enter("groom", "interview").gate("groom.finalize", "refused", "open-questions", { open_questions: 2 }, null).exit("spec-open", "spec-open", null);
  const open = rowOf(q.scene(), "T-15");
  assert.equal(open.stop ?? null, null);
  assert.equal(open.detail, "open questions");
});

/** Built, verified, approved, then the merge-time recheck voids the approval. */
function rechecked() {
  const h = planned(history())
    .enter("build", "planned").exit("built", "built")
    .enter("verify", "built").gate("verify.verdict", "passed", "PASS").exit("PASS", "verified")
    .enter("review", "verified")
    .life("review.round_started", { risk: "Medium", max_rounds: 3, tuning: false, approvals_needed: 2, human_approval_required: false, panel: [{ seat: "architecture", model: null }, { seat: "security", model: null }, { seat: "product", model: null }], delta: false, restarted: false, repeat: 0 })
    .life("review.decided", { outcome: "APPROVED", approvals: 3, approvals_needed: 2, votes: {}, blockers: 0, security_veto: false, human_approval_required: false })
    .exit("APPROVED", "approved")
    .enter("merge", "approved")
    .gate("merge.landed_overlap", "refused", "landed-overlap", { landed_commits: 2, files: 1, problems: 0 })
    .gate("merge.land", "refused", "landed-overlap")
    .exit("landed-overlap", "built");
  return h;
}

test("sent back by the merge-time recheck: held at Verify, a dashed arc from Merge, no round used, nobody needed", () => {
  const scene = rechecked().scene();
  const row = rowOf(scene, "T-15");
  assert.equal(row.state, "held");
  assert.equal(row.stop, "merge-recheck");
  assert.equal(row.held.kind, "recheck");
  assert.equal(L.LINE_STATIONS[row.column].key, "verify");
  assert.deepEqual(row.sentBack, { from: 5, to: 3, times: 1 });
  assert.match(row.why, /uses no judging round/);
  assert.equal(row.command, "/mach explain T-15");
  assert.equal(row.roundsUsed, 1);
  assert.ok(!L.lineModel(scene, T0 + 3_600_000).needs.some((r) => r.ticketId === "T-15"), "not in Needs you: it moves on by itself");
  assert.equal(activityOf(scene, "cell:T-15").label, "Held: back to verify");
  const merge = L.stationStats(scene, L.lineModel(scene, T0).rows)[5];
  assert.deepEqual(merge.sentBack, { back: 1, of: 1 });
});

test("the repeat review round is its own visit and its own round entry, and counts no judging round", () => {
  const scene = rechecked()
    .enter("verify", "built").gate("verify.verdict", "passed", "PASS").exit("PASS", "verified")
    .enter("review", "verified")
    .life("review.round_started", { risk: "Medium", max_rounds: 3, tuning: false, approvals_needed: 2, human_approval_required: false, panel: [{ seat: "architecture", model: null }], delta: false, restarted: true, repeat: 1 })
    .life("review.decided", { outcome: "APPROVED", approvals: 3, approvals_needed: 2, votes: {}, blockers: 0, security_veto: false, human_approval_required: false })
    .exit("APPROVED", "approved")
    .scene();
  const cell = scene.cells["T-15"];
  assert.equal(cell.reviews.length, 2);
  assert.deepEqual(cell.reviews.map((r) => [r.round, r.repeat ?? 0]), [[1, 0], [1, 1]]);
  assert.equal(scene.counters.reviewRounds, 1, "a repeat is not another review round");
  const reviewVisits = cell.visits.filter((v) => v.station === "review");
  assert.equal(L.visitRoundWords(cell, reviewVisits[0]), "round 1");
  assert.equal(L.visitRoundWords(cell, reviewVisits[1]), "round 1, repeat 1 (no judging round used)");
  assert.equal(L.reviewOfVisit(cell, reviewVisits[1]).repeat, 1);
  const row = rowOf(scene, "T-15");
  assert.equal(row.rechecks, 1);
  assert.equal(row.roundsUsed, 1);
});

test("a slice waiting for its design mocks has a row and a Needs you entry until intake takes it in", () => {
  const mocks = "Waiting for its design mocks: the approved pictures must be committed to the integration branch at product/ready/SLICE-090/mocks/. product/ready/SLICE-090/mocks/x.png: it is not there.";
  const h = history().intake("intake.refused", { problems: [mocks], waiting: "mocks" }, { slice_id: "SLICE-090", ticket_id: null, issue: 90, revision: 1 }, "intake");
  const scene = h.scene();
  const model = L.lineModel(scene, T0 + 60_000);
  const row = model.rows.find((r) => r.sliceId === "SLICE-090");
  assert.ok(row, "listed");
  assert.equal(row.state, "person");
  assert.equal(row.stop, "waiting-mocks");
  assert.equal(row.issue, 90);
  assert.equal(row.personWords, mocks);
  assert.equal(row.command, "/mach product status");
  assert.equal(L.needVerb(row), "Commit the design mocks for");
  assert.ok(model.needs.includes(row));
  const taken = h.intake("slice.materialized", { digest: "ab12", adopted: false, dependencies: [], reissued: null }, { slice_id: "SLICE-090", ticket_id: "90", issue: 90, revision: 1 }, "intake").scene();
  assert.equal(L.lineModel(taken, T0 + 60_000).rows.filter((r) => r.stop === "waiting-mocks").length, 0);
  // Another refusal, with no waiting code, is not drawn as one.
  const other = history().intake("intake.refused", { problems: ["its Jira key is not the one that was approved"], waiting: null }, { slice_id: "SLICE-091", ticket_id: null }, "intake").scene();
  assert.equal(L.lineModel(other, T0).rows.filter((r) => r.stop === "waiting-mocks").length, 0);
});

test("the Jira key and the change record are identifiers on the ticket, where recorded", () => {
  const h = history().intake("slice.materialized", { digest: "ab12", adopted: false, dependencies: [], reissued: null, jira: "KEY-123" }, {}, "intake");
  planned(h).enter("build", "planned").exit("built", "built");
  let row = rowOf(h.scene(), "T-15");
  assert.equal(row.jira, "KEY-123");
  assert.equal(row.changeRecord, null);
  h.enter("merge", "approved").life("merge.completed", { method: "local", merge_commit: "abcdef3", approved_commit: "abcdef1", landed_commit: "abcdef1", revalidated: false, pull_request: null, change_record: { path: "docs/changes/T-15.md", sha256: null } }).exit("merged", "merged");
  row = rowOf(h.scene(), "T-15");
  assert.equal(row.changeRecord, "docs/changes/T-15.md");
  assert.equal(row.state, "landed");
  // Not recorded: null, never a guess.
  const bare = rowOf(planned(history()).scene(), "T-15");
  assert.equal(bare.jira, null);
  assert.equal(bare.changeRecord, null);
});

test("evidence: a design mock's check marks the approved mock and the capture, with the recorded result and words", () => {
  const reply = live.readCellEvidence(
    {
      ticket_id: "T-15",
      artifacts: [
        { id: "a000000000000000000000001", path_rel: "evidence/mocks/abc.png", kind: "evidence", media_type: "image/png", content_access: "media", integrity: "match", origin: "cell", targets: [{ id: "MOCK-1", role: "approved-mock" }] },
        { id: "a000000000000000000000002", path_rel: "evidence/signin.png", kind: "evidence", media_type: "image/png", content_access: "media", integrity: "match", origin: "cell", targets: [{ id: "MOCK-1", role: "capture" }] },
      ],
      checks: [
        {
          target_id: "MOCK-1", target_kind: "design mock", result: "fail", round: 1, visit_id: "T-15/verify#1", at: null, basis: "results.json",
          evidence: [
            { file: "evidence/mocks/abc.png", sha256: "abc", artifact_id: "a000000000000000000000001", integrity: "match", content_access: "media", role: "approved-mock" },
            { file: "evidence/signin.png", sha256: "def", artifact_id: "a000000000000000000000002", integrity: "match", content_access: "media", role: "capture" },
          ],
          mock: { compared: "differs", binding: true, for: "AC-01", note: "Captured the sign-in screen.", differences: ["the button is grey"], free_text: true, free_text_note: "free text, not checked for names" },
        },
      ],
      settings: { evidence_media: true },
    },
    "T-15",
  );
  const model = E.buildLiveModel(reply);
  const check = E.listedChecks(model)[0];
  assert.equal(E.kindWords(check.kind), "Design mock");
  const sides = E.mockSides(check);
  assert.equal(sides.approved.role, "approved-mock");
  assert.equal(sides.captures.length, 1);
  assert.equal(E.ROLE_WORDS[sides.approved.role], "Approved mock");
  assert.equal(E.ROLE_WORDS[sides.captures[0].role], "Captured screen");
  assert.equal(E.mockResultWords(check.mock), "Differs from the approved mock. Binding: a difference fails this check.");
  assert.deepEqual(check.mock.differences, ["the button is grey"]);
  assert.equal(check.mock.freeText, true);
  // Each picture is requested by its own catalog id, only while media is on.
  assert.deepEqual(E.contentRequest(model, { check: check.key, file: sides.approved.key }), { kind: "image", artifactId: "a000000000000000000000001" });
  const off = E.buildLiveModel({ ...reply, evidenceMedia: false });
  const offCheck = E.listedChecks(off)[0];
  assert.deepEqual(E.contentRequest(off, { check: offCheck.key, file: offCheck.files[0].key }), { kind: "none", reason: "media-disabled" });
  // A result the page does not know reads as not recorded, never as a match.
  assert.equal(live.readMockFacts({ compared: "looks-alike", binding: "yes" }).compared, null);
  assert.equal(E.mockResultWords(live.readMockFacts({ compared: "looks-alike" })), "Result not recorded. Whether it binds is not recorded.");
});

test("the Simulation's sample: MOCK-1 of ticket 131, drawn by the app, the approved mock beside the capture", () => {
  const scene = sim.finalScene(sim.SCENARIO);
  const model = E.buildSimModel(scene.cells["131"]);
  const mocks = E.listedChecks(model).filter((c) => c.id === "MOCK-1");
  assert.ok(mocks.length >= 1, "the sample is in the simulation");
  const check = mocks[0];
  assert.equal(check.kind, "design mock");
  assert.equal(check.mock.compared, "differs");
  assert.equal(check.mock.binding, false);
  assert.equal(check.result, "pass", "a difference on a mock that does not bind is a finding, not a failure");
  const sides = E.mockSides(check);
  assert.equal(sides.approved.sim.kind, "image");
  assert.equal(sides.approved.sim.role, "approved-mock");
  assert.equal(sides.captures[0].sim.role, "capture");
  assert.equal(sides.approved.origin, "simulation");
});

// cleanup.archive: a finished ticket whose cell was cleaned up with no archive kept. The observer
// answers `/cells/{t}/evidence` with `not_kept` (the run record's reason) and the lanes with state
// "not-kept"; the player and the lanes panel say so plainly, never as an error or an empty panel,
// and a file a check names reads "not kept", not "not there".
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const O = await import("../src/live/observer.ts");
const M = await import("../src/evidence/model.ts");
const N = await import("../src/evidence/notKept.ts");
const L = await import("../src/line/lanesModel.ts");

const T = "LOCAL-205";
const REASON = 'The evidence files were not kept after cleanup: cleanup.archive is "raised" and no person decided anything on this ticket.';
const at = (ms) => ({ at: new Date(ms).toISOString(), precision: "exact", event_id: `e${ms}`, pos: ms, authority: "authoritative" });

function reply(notKept) {
  return {
    ticket_id: T,
    artifacts: [],
    checks: [{ target_id: "AC-01", target_kind: "scenario", result: "pass", round: 1, visit_id: `${T}/verify#1`, at: at(Date.UTC(2026, 10, 20)),
      evidence: [{ file: "evidence/ac-01.png", sha256: "f".repeat(64), artifact_id: null, integrity: "missing" }] }],
    settings: { evidence_media: false, source: "default" },
    cursor: null,
    note: "verified evidence is a file results.json names with a matching hash; prose is written by an agent and is never proof",
    not_kept: notKept,
  };
}

test("the words, fixed", () => {
  assert.equal(N.NOT_KEPT_WORDS, "The evidence files were not kept after cleanup (cleanup.archive).");
  assert.equal(M.NOT_KEPT_WORDS, N.NOT_KEPT_WORDS);
  assert.equal(M.reasonWords("not-kept"), "This file was not kept after cleanup (cleanup.archive). The change record merged with the ticket names it with its SHA-256.");
  assert.equal(N.notKeptDetail(N.NOT_KEPT_WORDS), null, "the fallback is not said twice");
  assert.equal(N.notKeptDetail("  "), null);
  assert.equal(N.notKeptDetail(REASON), REASON);
});

test("not_kept is read tolerantly", () => {
  const d = O.readCellEvidence(reply({ reason: REASON, setting: "raised", chosen_by: "setting", published: null, raised_to_person: ["escalated", "Bad Code", 3], archive: null, outcome: "merged" }), T);
  assert.deepEqual(d.notKept, { reason: REASON, setting: "raised", chosenBy: "setting", raisedToPerson: ["escalated"], archive: null });
  assert.equal(O.readCellEvidence(reply(undefined), T).notKept, null, "an observer from before, or files that are there");
  assert.deepEqual(O.readNotKept({ setting: "keep-all", chosen_by: "someone" }), { reason: null, setting: null, chosenBy: null, raisedToPerson: [], archive: null });
  assert.equal(O.readNotKept([]), null);
});

test("the player says the files were not kept, with the run record's reason, and each file says not kept", () => {
  const model = M.buildLiveModel(O.readCellEvidence(reply({ reason: REASON, setting: "raised", chosen_by: "setting", raised_to_person: [] }), T));
  assert.deepEqual(M.notKeptWords(model.notKept), { title: N.NOT_KEPT_WORDS, detail: REASON });
  const file = model.runs[0].checks[0].files[0];
  assert.equal(file.state, "missing");
  assert.equal(file.reason, "not-kept");
  assert.equal(M.fileBanner(file), N.NOT_KEPT_FILE_WORDS);
  // A record with no reason: the fact alone.
  const plain = M.buildLiveModel(O.readCellEvidence(reply({ reason: null }), T));
  assert.deepEqual(M.notKeptWords(plain.notKept), { title: N.NOT_KEPT_WORDS, detail: null });
});

test("with the files there, nothing changes", () => {
  const model = M.buildLiveModel(O.readCellEvidence(reply(null), T));
  assert.equal(model.notKept, null);
  const file = model.runs[0].checks[0].files[0];
  assert.equal(file.reason, "not-catalogued");
  assert.equal(M.fileBanner(file), M.INTEGRITY_WORDS.missing.banner);
});

test("the lanes of a build whose files were not kept", () => {
  const reply = L.readLanesReply({
    state: "not-kept", source: "none", not_kept: { reason: REASON }, build_json: { read: "absent", why: REASON }, build_report: { read: "absent", why: null },
    before: [], after: [], lanes: [], batches: [], join_refusals: [], tasks: [], commits: [], deviations: [], command_changes: [], gates: [],
  });
  assert.equal(reply.state, "not-kept");
  assert.equal(reply.source, "none");
  assert.deepEqual(reply.notKept, { reason: REASON });
  const panel = L.lanesPanel(reply, null);
  assert.equal(panel.summary, `${N.NOT_KEPT_LANES_WORDS} ${REASON}`);
  assert.deepEqual(panel.problems, [], "not kept is not a file that could not be read");
  assert.equal(panel.timing, null);
  assert.deepEqual(L.laneLine(reply, null), { marker: null, chips: [], moment: null });
  const fallback = L.readLanesReply({ state: "not-kept", source: "none", build_json: { read: "absent" }, build_report: { read: "absent" } });
  assert.deepEqual(fallback.notKept, { reason: N.NOT_KEPT_WORDS });
  assert.equal(L.lanesPanel(fallback, null).summary, N.NOT_KEPT_LANES_WORDS);
});

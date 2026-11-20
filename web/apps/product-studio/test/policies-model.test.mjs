// Unit tests for the policy screens' model (src/features/policies/model.ts), against the engine's
// own fixtures (web/fixtures, the same files the fixture transport answers with) and, for the cases
// no fixture holds yet, a fixture copied and changed in the test. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acceptArgs,
  acceptFormErrors,
  acceptance,
  answerFindings,
  appliesToWords,
  checkWords,
  concernState,
  openConcerns,
  otherProblems,
  packRow,
  packState,
  policyRows,
  principleAnswerWords,
  principleRows,
  sliceTabState,
  slicesAnsweredUnderOlder,
} from "../src/features/policies/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const data = (name) => fixture(name).data;
const copy = (value) => JSON.parse(JSON.stringify(value));

/* The packs screen */

test("policy.list: one active pack, its owner, what it applies to, its version and statement count", () => {
  const list = data("policy.list");
  const row = packRow(list.packs[0]);
  assert.equal(row.id, "POL-privacy");
  assert.equal(row.title, "Privacy");
  assert.equal(row.owner, "Data protection officer (@acme/privacy)");
  assert.deepEqual(row.appliesTo, ["Every slice"]);
  assert.equal(row.version, "b7b600b3e580");
  assert.equal(row.statementCount, 2);
  assert.equal(row.statements, null, "the engine gives a count today, so no statement text is invented");
  assert.deepEqual(packState(row), { word: "Active", shape: "approved", tone: "success" });
  assert.deepEqual(otherProblems(list), []);
  assert.deepEqual(slicesAnsweredUnderOlder(list), []);
});

test("statements are listed when the engine gives their text", () => {
  const pack = { ...data("policy.list").packs[0], statements: [{ id: "POL-privacy-01", text: "An invitation email MUST name the workspace that sent it." }] };
  const row = packRow(pack);
  assert.equal(row.statementCount, 1);
  assert.equal(row.statements[0].id, "POL-privacy-01");
});

test("applies-to items read in plain words; an unknown form is shown as written", () => {
  assert.equal(appliesToWords("all"), "Every slice");
  assert.equal(appliesToWords("topic:sign-in"), "Slices about sign in");
  assert.equal(appliesToWords("app:web"), "Apps of the kind “web”");
  assert.equal(appliesToWords("path:src/billing/**"), "Code under src/billing/**");
  assert.equal(appliesToWords("odd"), "odd");
});

test("empty: no packs and no problems", () => {
  const list = { ...copy(data("policy.list")), packs: [] };
  assert.deepEqual(list.packs.map(packRow), []);
  assert.deepEqual(otherProblems(list), []);
});

test("a malformed pack carries the engine's reason, shown on the pack and not repeated above", () => {
  const list = copy(data("policy.list"));
  list.packs[0].problems = ["the header has no 'owner' field"];
  list.packs[0].binding = false;
  list.problems = ["policies/privacy/policy.md: the header has no 'owner' field", "policies/billing: the folder has no policy.md"];
  const row = packRow(list.packs[0]);
  assert.deepEqual(row.problems, ["the header has no 'owner' field"]);
  assert.deepEqual(packState(row), { word: "Cannot be read", shape: "blocked", tone: "danger" });
  assert.deepEqual(otherProblems(list), ["policies/billing: the folder has no policy.md"]);
});

test("a problem sent as an object (as the shared type describes it) still reads as a sentence", () => {
  const list = { ...copy(data("policy.list")), problems: [{ file: "policies/x", problem: "unreadable" }, {}] };
  assert.deepEqual(otherProblems(list), ["policies/x: unreadable", "A policy pack cannot be read."]);
});

test("a retired pack reads as retired", () => {
  const row = packRow({ ...data("policy.list").packs[0], status: "retired" });
  assert.equal(packState(row).word, "Retired");
});

test("slices answered under an older version: sorted, titled from status, the engine's sentence kept", () => {
  const list = copy(data("policy.list"));
  const note = "Policy packs changed after this spec answered them (POL-privacy changed). They bind slices marked ready from now on.";
  list.slices_answered_under_older = {
    "SLICE-002": { changes: [{ id: "POL-security", change: "retired" }], note: "Other." },
    "SLICE-001": { changes: [{ id: "POL-privacy", change: "changed", answered: "aaaaaaaaaaaa", now: "b7b600b3e580" }], note },
  };
  const status = data("status.principles");
  const older = slicesAnsweredUnderOlder(list, status.slices);
  assert.deepEqual(older.map((o) => o.sliceId), ["SLICE-001", "SLICE-002"]);
  assert.equal(older[0].title, "Invite a teammate");
  assert.equal(older[0].note, note);
  assert.deepEqual(older[0].packs, ["POL-privacy"]);
  assert.equal(older[1].title, null);
});

/* One slice: an open concern */

test("open concern: the statement, why, owner and an open resolution; one concern waits", () => {
  const show = data("slice.show.open-concern");
  assert.equal(sliceTabState(show.spec.model), "answers");
  const rows = policyRows(show.spec.model.policies, data("policy.list").packs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Privacy");
  assert.equal(rows[0].answer, "concerns");
  const [concern] = rows[0].concerns;
  assert.equal(concern.statementId, "POL-privacy-02");
  assert.equal(concern.statement, "Personal data MUST NOT be sent to a service outside the EU region.");
  assert.equal(concern.why, "The email service sits outside the EU.");
  assert.equal(concern.owner, "Data protection officer (@acme/privacy)");
  assert.equal(concern.resolution, "open");
  assert.equal(concern.accepted, null);
  assert.deepEqual(concernState("open"), { word: "Waiting for its owner", shape: "half", tone: "warning" });
  assert.deepEqual(openConcerns(rows).map((c) => [c.pack, c.statementId]), [["POL-privacy", "POL-privacy-02"]]);
});

test("open concern: the check's own finding is shown in its words", () => {
  const show = data("slice.show.open-concern");
  const found = answerFindings(show.check);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.equal(found[0].rule, "policy-concern-open");
  assert.match(found[0].message, /waits for Data protection officer/);
});

/* One slice: an accepted concern */

test("accepted concern: by whom, when, their words; no open concern left", () => {
  const rows = policyRows(data("slice.show.concern-accepted").spec.model.policies);
  const [concern] = rows[0].concerns;
  assert.equal(concern.resolution, "accepted");
  assert.deepEqual(concern.accepted, { name: "Data protection officer", on: "2026-11-20", words: "Accepted for the pilot only.", check: null });
  assert.equal(checkWords(concern.accepted.check), "How the name was checked is not recorded.");
  assert.deepEqual(openConcerns(rows), []);
  assert.equal(rows[0].title, null, "without policy.list the pack's ID stands in for its title");
});

test("an acceptance written since M15 carries the check in brackets: the name and the check are told apart", () => {
  const concern = { ...data("slice.show.concern-accepted").spec.model.policies[0].concerns[0], by: "dana (checked against the pack's owner)" };
  assert.deepEqual(acceptance(concern), { name: "dana", on: "2026-11-20", words: "Accepted for the pilot only.", check: "checked against the pack's owner" });
  const withField = { ...concern, by: "lee (checked against the project's list)", owner_check: "checked against the project's list" };
  assert.equal(acceptance(withField).name, "lee");
  assert.equal(checkWords(acceptance(withField).check), "Checked against the project's list.");
});

test("a concern met by changing the spec", () => {
  const show = copy(data("slice.show.open-concern"));
  show.spec.model.policies[0].concerns[0].resolution = "spec_changed";
  const rows = policyRows(show.spec.model.policies);
  assert.equal(rows[0].concerns[0].resolution, "spec_changed");
  assert.equal(concernState("spec_changed").word, "Met by changing the spec");
  assert.deepEqual(openConcerns(rows), []);
});

test("a followed pack lists no concern", () => {
  const rows = policyRows([{ pack: "POL-security", sha256: "1a2b3c4d5e6f", answer: "followed" }]);
  assert.deepEqual(rows[0].concerns, []);
  assert.equal(rows[0].answer, "followed");
});

/* One slice: the principles */

test("principles: titles from principle.list, older revision and retired flags from status", () => {
  const show = data("slice.show.concern-accepted");
  const list = data("principle.list.unpublished");
  const flag = data("status.principles").slices[0].principles;
  const rows = principleRows(show.spec.model.principles, list.principles, flag);
  assert.deepEqual(
    rows.map((r) => [r.id, r.title, r.answer, r.upheldBy.join(","), r.older, r.retired]),
    [
      ["PP-01", "Versions stay as published", "applies", "INV-02,AC-01", true, false],
      ["PP-02", "Senders are named", "applies", "AC-01", false, true],
    ],
  );
  const found = answerFindings(show.check).map((f) => f.rule);
  assert.deepEqual(found, ["principle-quote", "principle-revision", "principle-retired"]);
});

test("principles: does not apply and an exception keep the product manager's reason", () => {
  const rows = principleRows([
    { id: "PP-03", revision: 1, statement: "A x MUST y.", answer: "does_not_apply", upheld_by: [], reason: "This slice sends no invitation text." },
    { id: "PP-04", revision: 2, statement: "A z MUST w.", answer: "exception", upheld_by: [], reason: "The pilot needs it." },
  ]);
  assert.equal(rows[0].reason, "This slice sends no invitation text.");
  assert.equal(principleAnswerWords("does_not_apply").word, "Does not apply");
  assert.equal(rows[1].reason, "The pilot needs it.");
  assert.equal(principleAnswerWords("exception").word, "An exception");
  assert.equal(rows[0].title, null);
});

/* The tab's states */

test("states: no spec, nothing to answer, answers", () => {
  assert.equal(sliceTabState(null), "no-spec");
  assert.equal(sliceTabState({ invariants: [] }), "nothing-to-answer");
  assert.equal(sliceTabState({ principles: [], policies: [] }), "nothing-to-answer");
  assert.equal(sliceTabState(data("slice.show.open-concern").spec.model), "answers");
});

/* The acceptance */

test("the accept form asks for both fields and leaves every other judgement to the engine", () => {
  assert.deepEqual(Object.keys(acceptFormErrors("", " ")).sort(), ["by", "reason"]);
  assert.deepEqual(acceptFormErrors("dana", "short"), {}, "the engine judges length, not the app");
  assert.deepEqual(acceptArgs("SLICE-001", "POL-privacy-02", "  dana ", " Accepted for the pilot only. "), {
    slice_id: "SLICE-001",
    policy_id: "POL-privacy-02",
    by: "dana",
    reason: "Accepted for the pilot only.",
  });
});

test("the engine's acceptance and its refusal, as the fixture transport answers them", () => {
  const ok = fixture("policy.accept");
  assert.equal(ok.data.accepted, "POL-privacy-02");
  assert.deepEqual(ok.data.open_left, []);
  const refused = fixture("policy.accept.refused");
  assert.equal(refused.data, null);
  assert.equal(refused.refused, "POL-privacy-01 has no open concern in this spec. Open concerns: POL-privacy-02.");
});

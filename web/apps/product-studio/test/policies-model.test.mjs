// Unit tests for the policy screens' model (src/features/policies/model.ts), against the engine's
// own fixtures (web/fixtures, the same files the fixture transport answers with). Run: pnpm --filter @mach/product-studio test
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
  packAnswerSummary,
  packRow,
  packState,
  packSummary,
  policyRows,
  principleAnswerWords,
  principleRows,
  principleSummary,
  settledConcerns,
  sliceTabState,
  slicesAnsweredUnderOlder,
} from "../src/features/policies/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const data = (name) => fixture(name).data;

/* The packs screen */

test("policy.list: one active pack, its owner, what it applies to, its version and its statements", () => {
  const list = data("policy.list");
  const row = packRow(list.packs[0]);
  assert.equal(row.id, "POL-privacy");
  assert.equal(row.title, "Privacy");
  assert.equal(row.owner, "Data protection officer (@acme/privacy)");
  assert.deepEqual(row.appliesTo, ["Every slice"]);
  assert.equal(row.version, "b7b600b3e580");
  assert.deepEqual(row.statements.map((s) => s.id), ["POL-privacy-01", "POL-privacy-02"]);
  assert.equal(row.statements[0].text, "An invitation email MUST name the workspace that sent it.");
  assert.deepEqual(packState(row), { word: "Active", shape: "approved", tone: "success" });
  assert.deepEqual(otherProblems(list), []);
  assert.deepEqual(slicesAnsweredUnderOlder(list), []);
});

test("applies-to items read in plain words; an unknown form is shown as written", () => {
  assert.equal(appliesToWords("all"), "Every slice");
  assert.equal(appliesToWords("topic:sign-in"), "Slices about sign in");
  assert.equal(appliesToWords("app:web"), "Apps of the kind “web”");
  assert.equal(appliesToWords("path:src/billing/**"), "Code under src/billing/**");
  assert.equal(appliesToWords("odd"), "odd");
});

test("empty: no packs and no problems", () => {
  const list = data("policy.list.empty");
  assert.deepEqual(list.packs.map(packRow), []);
  assert.deepEqual(otherProblems(list), []);
});

test("a malformed pack carries the engine's reason, shown on the pack; a folder without policy.md is listed above", () => {
  const list = data("policy.list.problems");
  const row = packRow(list.packs[0]);
  assert.deepEqual(row.problems, ["the header says id 'POL-branding', but a pack in the folder 'brand' is POL-brand"]);
  assert.deepEqual(packState(row), { word: "Cannot be read", shape: "blocked", tone: "danger" });
  assert.deepEqual(otherProblems(list), ["policies/security: the folder has no policy.md"]);
});

test("a retired pack reads as retired", () => {
  const row = packRow({ ...data("policy.list").packs[0], status: "retired" });
  assert.equal(packState(row).word, "Retired");
});

test("slices answered under an older version: sorted, titled from status, the engine's sentence kept", () => {
  const list = data("policy.list.older");
  const status = data("status.policies-changed");
  const older = slicesAnsweredUnderOlder(list, status.slices);
  assert.deepEqual(older.map((o) => o.sliceId), ["SLICE-001", "SLICE-002", "SLICE-003", "SLICE-004"]);
  assert.equal(older[0].title, "Invite a teammate");
  assert.match(older[0].note, /^Policy packs changed after this spec answered them \(POL-privacy changed\)/);
  assert.deepEqual(older[0].packs, ["POL-privacy"]);
  assert.equal(slicesAnsweredUnderOlder(list)[0].title, null, "without status the slice has no title");
  assert.equal(status.slices[0].policies_changed, older[0].note, "status carries the same sentence per slice");
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
  assert.equal(concern.accepted.name, "Data protection officer");
  assert.equal(concern.accepted.words, "Accepted for the pilot only.");
  assert.equal(concern.accepted.check, "not checked against the owner");
  assert.equal(checkWords(concern.accepted.check), "Not checked against the owner.");
  assert.equal(checkWords(null), "How the name was checked is not recorded.");
  assert.deepEqual(openConcerns(rows), []);
  assert.equal(rows[0].title, null, "without policy.list the pack's ID stands in for its title");
});

test("an acceptance written since M15 carries the check in brackets: the name and the check are told apart", () => {
  const concern = { ...data("slice.show.concern-accepted").spec.model.policies[0].concerns[0], by: "dana (checked against the pack's owner)", owner_check: undefined };
  assert.deepEqual(acceptance(concern), { name: "dana", on: concern.on, words: "Accepted for the pilot only.", check: "checked against the pack's owner" });
  const withField = { ...concern, by: "lee (checked against the project's list)", owner_check: "checked against the project's list" };
  assert.equal(acceptance(withField).name, "lee");
  assert.equal(checkWords(acceptance(withField).check), "Checked against the project's list.");
});

test("a concern met by changing the spec", () => {
  const show = data("slice.show.concern-spec-changed");
  const rows = policyRows(show.spec.model.policies);
  assert.equal(rows[0].concerns[0].resolution, "spec_changed");
  assert.equal(concernState("spec_changed").word, "Met by changing the spec");
  assert.deepEqual(openConcerns(rows), []);
});

test("a followed pack lists no concern", () => {
  const rows = policyRows(data("slice.show.policy-followed").spec.model.policies);
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
  const rows = principleRows(data("slice.show.principle-exceptions").spec.model.principles);
  assert.deepEqual(rows.map((r) => r.answer), ["does_not_apply", "exception"]);
  assert.equal(rows[0].reason, "Renaming changes no published version.");
  assert.equal(principleAnswerWords("does_not_apply").word, "Does not apply");
  assert.equal(rows[1].reason, "The pilot sends from a shared address for one month.");
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
  assert.equal(ok.data.owner_check, "not checked against the owner");
  assert.match(ok.data.owner_check_note, /guards against accident, not forgery/);
  const refused = fixture("policy.accept.refused");
  assert.equal(refused.data, null);
  assert.equal(refused.refused, "POL-privacy-01 has no open concern in this spec. Open concerns: POL-privacy-02.");
});

test("an owner named by login: the name is checked, or the acceptance is refused in the engine's words", () => {
  const checked = data("policy.accept.checked");
  assert.equal(checkWords(checked.owner_check), "Checked against the pack's owner.");
  const refused = fixture("policy.accept.refused-owner");
  assert.equal(refused.data, null);
  assert.match(refused.refused, /is not one of the people who may accept this concern: the pack's owner names @dana-dpo/);
});

/* M16 layout: each row's one-line summary, from the engine's answers only */

test("packs page rows: owner, reach and statements; a malformed pack points to its reasons above, which never fold", () => {
  const [row] = data("policy.list").packs.map(packRow);
  assert.equal(packSummary(row), "Owner: Data protection officer (@acme/privacy). Every slice. 2 statements.");
  const malformed = data("policy.list.problems").packs.map(packRow).find((r) => r.problems.length);
  assert.equal(packSummary(malformed), "1 reason it cannot be read, shown above");
  assert.equal(packSummary({ ...row, owner: null, statements: [row.statements[0]] }), "Owner: not recorded. Every slice. 1 statement.");
});

test("slice page pack rows: followed, an open concern shown above, an accepted one and one met by changing the spec", () => {
  const followed = policyRows(data("slice.show.policy-followed").spec.model.policies)[0];
  assert.match(packAnswerSummary(followed), /^Followed\. Answered under version [0-9a-f]+\.$/);
  assert.deepEqual(settledConcerns(followed), []);
  const open = policyRows(data("slice.show.open-concern").spec.model.policies)[0];
  assert.equal(packAnswerSummary(open), "1 concern: 1 waits for its owner (shown above). Answered under version b7b600b3e580.");
  assert.deepEqual(settledConcerns(open), []);
  const accepted = policyRows(data("slice.show.concern-accepted").spec.model.policies)[0];
  assert.match(packAnswerSummary(accepted), /^1 concern: 1 accepted by its owner\. Answered under version /);
  assert.equal(settledConcerns(accepted).length, 1);
  const changed = policyRows(data("slice.show.concern-spec-changed").spec.model.policies)[0];
  assert.match(packAnswerSummary(changed), /^1 concern: 1 met by changing the spec\. /);
});

test("principle rows: what upholds it, or whether a reason is recorded, never the reason itself in the summary", () => {
  const rows = principleRows(data("slice.show.open-concern").spec.model.principles);
  assert.equal(principleSummary(rows[0]), `Upheld by ${rows[0].upheldBy.join(", ")}`);
  assert.equal(principleSummary({ ...rows[0], upheldBy: [] }), "What upholds it is not recorded");
  assert.equal(principleSummary({ ...rows[0], answer: "does_not_apply", reason: "No email" }), "Why it does not apply is recorded");
  assert.equal(principleSummary({ ...rows[0], answer: "does_not_apply", reason: null }), "Why it does not apply is not recorded");
  assert.equal(principleSummary({ ...rows[0], answer: "exception", reason: "For the pilot" }), "Your exception, in your own words");
});

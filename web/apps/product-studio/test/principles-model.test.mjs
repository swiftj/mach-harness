// Unit tests for the Product principles screen's model (src/features/principles/model.ts), against
// the real engine runs the fixture transport answers with (web/fixtures/principle.*.json and the
// status and reconcile runs). Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addArgs,
  countWords,
  emptyFields,
  isPrinciplesReconcileHint,
  oneLine,
  publishOffered,
  publishOutcome,
  publishState,
  refusalPlace,
  setArgs,
  slicesToCheck,
  splitPrinciples,
  stateLook,
} from "../src/features/principles/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const data = (name) => fixture(name).data;

test("empty: nothing to publish and no publish offered", () => {
  const list = data("principle.list.empty");
  assert.equal(publishState(list), "none");
  assert.equal(publishOffered("none"), false);
  assert.deepEqual(splitPrinciples(list.principles), { active: [], retired: [] });
});

test("unpublished changes: publish is the act, the stale slice is listed with status's note", () => {
  const list = data("principle.list.unpublished");
  assert.equal(publishState(list), "unpublished");
  assert.equal(publishOffered("unpublished"), true);
  const status = data("status.principles");
  const rows = slicesToCheck(list, status.slices);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "SLICE-001");
  assert.equal(rows[0].title, "Invite a teammate");
  assert.deepEqual(rows[0].older, ["PP-01"]);
  assert.match(rows[0].note, /older principles/);
});

test("a slice the status has not read yet is still listed, by its ID", () => {
  const rows = slicesToCheck({ slices_answered_under_older: ["SLICE-009"] }, null);
  assert.deepEqual(rows, [{ id: "SLICE-009", title: null, older: [], unanswered: [], note: null }]);
});

test("newer elsewhere comes first, over unpublished changes", () => {
  const list = data("principle.list.newer-elsewhere");
  assert.equal(list.unpublished_changes, true);
  assert.equal(publishState(list), "newer-elsewhere");
});

test("the remaining states follow the engine's flags", () => {
  const base = data("principle.list.unpublished");
  const with_ = (published, extra = {}) => ({ ...base, ...extra, published: { ...base.published, ...published } });
  assert.equal(publishState(with_({}, { unpublished_changes: false })), "published");
  assert.equal(publishOffered("published"), false);
  assert.equal(publishState(with_({ unfinished: true })), "unfinished");
  assert.equal(publishState(with_({ changed_on_github: true })), "changed-on-github");
  assert.equal(publishState(with_({ saved: null, revision: null })), "never-published");
  // A run that stopped part way is shown even before any principle is listed.
  assert.equal(publishState(with_({ unfinished: true }, { principles: [] })), "unfinished");
});

test("every state has a word and a shape, not only a tone", () => {
  for (const [state, look] of Object.entries(stateLook)) {
    assert.ok(look.word.length > 0, state);
    assert.ok(look.glyph, state);
  }
  const glyphs = ["published", "unpublished", "never-published"].map((s) => stateLook[s].glyph);
  assert.equal(new Set(glyphs).size, glyphs.length);
});

test("retired principles are listed apart, each list in ID order", () => {
  const { active, retired } = splitPrinciples([
    { id: "PP-10", status: "active" },
    { id: "PP-02", status: "retired" },
    { id: "PP-03", status: "active" },
  ]);
  assert.deepEqual(active.map((p) => p.id), ["PP-03", "PP-10"]);
  assert.deepEqual(retired.map((p) => p.id), ["PP-02"]);
});

test("add sends the three fields trimmed; set sends only what changed", () => {
  assert.deepEqual(addArgs({ title: " T ", statement: " A MUST B. ", reason: " R " }), { title: "T", statement: "A MUST B.", reason: "R" });
  const pp01 = data("principle.add").principle;
  const same = { title: pp01.title, statement: pp01.statement, reason: pp01.reason };
  assert.equal(setArgs(pp01, same), null);
  assert.deepEqual(setArgs(pp01, { ...same, statement: data("principle.set").principle.statement }), {
    principle_id: "PP-01",
    statement: "A published version MUST NOT be changed in place.",
  });
  assert.deepEqual(setArgs(pp01, { ...same, title: "New name " }), { principle_id: "PP-01", title: "New name" });
});

test("empty fields are asked for before anything is sent; line breaks become spaces", () => {
  assert.deepEqual(emptyFields({ title: "", statement: "  ", reason: "x" }), ["title", "statement"]);
  assert.equal(oneLine("A published version\nMUST NOT\r\n be changed."), "A published version MUST NOT be changed.");
});

test("the engine's wording refusal goes beside the statement whenever the statement was sent", () => {
  const refusal = fixture("principle.add.refused-wording");
  assert.equal(refusal.data, null);
  assert.match(refusal.refused, /MUST, MUST NOT/);
  assert.equal(refusalPlace(addArgs({ title: "T", statement: "S", reason: "R" })), "statement");
  assert.equal(refusalPlace({ principle_id: "PP-01", statement: "S" }), "statement");
  assert.equal(refusalPlace({ principle_id: "PP-01", title: "T" }), "form");
});

test("a publish refused for a newer version leads to the choice on this screen", () => {
  const refusal = fixture("principle.publish.refused-newer-elsewhere");
  assert.equal(isPrinciplesReconcileHint(refusal.hint), true);
  assert.equal(isPrinciplesReconcileHint({ kind: "reconcile", target: "SLICE-004" }), false);
  assert.equal(isPrinciplesReconcileHint(null), false);
});

test("publish outcome: GitHub with its issue and approver", () => {
  const outcome = publishOutcome(data("principle.publish"));
  assert.deepEqual(outcome, {
    where: "github",
    revision: 1,
    issue: 1,
    url: "https://github.com/acme/team-space/issues/1",
    approvedBy: "ada-pm",
    note: "Published on the project's issue (#1) as version 1. Slices marked ready from now on answer these principles.",
  });
});

test("publish outcome: the folder, with why and the ways on", () => {
  const outcome = publishOutcome({
    published: true,
    saved_to: "folder",
    revision: 1,
    sha256: "0".repeat(64),
    folder: "/p/.factory/studio/draft/product/ready/PRINCIPLES",
    why_folder: "The GitHub tool (gh) is not installed on this computer.",
    files: [],
    ways_on: ["Commit the folder product/ready/PRINCIPLES to the repository; the builders read it from the main branch."],
    active: 1,
    factory_authorized: false,
    note: "Published to the folder. Nothing was sent to GitHub and no work has started.",
  });
  assert.equal(outcome.where, "folder");
  assert.equal(outcome.whyFolder, "The GitHub tool (gh) is not installed on this computer.");
  assert.equal(outcome.waysOn.length, 1);
  assert.equal(publishOutcome({ ...outcome, saved_to: "folder", ways_on: [], why_folder: undefined }).whyFolder, null);
});

test("reconcile answers carry the engine's note", () => {
  const result = data("reconcile.principles");
  assert.equal(result.reconciled, "principles");
  assert.equal(result.took, "theirs");
  assert.ok(result.note.length > 0);
});

test("counts in words", () => {
  assert.equal(countWords(1, 1), "1 in force, 1 retired");
  assert.equal(countWords(2, 0), "2 in force");
});

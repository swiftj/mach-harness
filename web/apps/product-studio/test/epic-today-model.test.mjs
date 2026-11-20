// Unit tests for the "How <epic> works today" page's model (src/features/epic-today/model.ts), against
// the engine's own epic.current fixture runs. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conflicts, earlierText, epicPage, notApplied, sliceEffectsWords, sliceTitle } from "../src/features/epic-today/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8")).data;
const current = fixture("epic.current");
const epic = current.epic;

test("the rules in force are grouped by kind, then not yet reconciled, then no longer in force", () => {
  const page = epicPage(epic);
  assert.deepEqual(page.groups.map((g) => g.id), ["requirements", "not-reconciled", "no-longer"]);
  assert.deepEqual(page.groups[0].rules.map((r) => r.rule), ["SLICE-001/FR-01", "SLICE-002/FR-01", "SLICE-003/FR-01", "SLICE-003/FR-02"]);
  assert.equal(page.inForce, 4);
  assert.deepEqual(page.jumps.map((j) => [j.id, j.count]), [["requirements", 4], ["not-reconciled", 2], ["no-longer", 2]]);
});

test("every rule the engine listed appears exactly once", () => {
  const page = epicPage(epic);
  const shown = page.groups.flatMap((g) => g.rules.map((r) => r.rule)).sort();
  const listed = [...epic.in_force, ...epic.not_yet_reconciled, ...epic.no_longer_in_force].map((r) => r.rule).sort();
  assert.deepEqual(shown, listed);
});

test("a replaced rule is shown in its new form with the wording it took the place of", () => {
  const rule = epic.in_force.find((r) => r.rule === "SLICE-003/FR-01");
  assert.equal(rule.takes_the_place_of[0].rule, "SLICE-001/FR-02");
  assert.equal(earlierText(epic, "SLICE-001/FR-02"), "The system SHALL expire an invitation after 14 days.");
  assert.equal(earlierText(epic, "SLICE-404/FR-01"), null);
});

test("after a retire: the retired rule moves to no longer in force, as the engine says", () => {
  const after = fixture("epic.current.after-retire").epic;
  const page = epicPage(after);
  const gone = page.groups.find((g) => g.id === "no-longer").rules.map((r) => r.rule);
  assert.ok(gone.includes("SLICE-002/FR-01"));
  assert.ok(!page.groups.filter((g) => g.id !== "no-longer").some((g) => g.rules.some((r) => r.rule === "SLICE-002/FR-01")));
});

test("every kind has its group; an unknown kind is kept, never dropped", () => {
  const mixed = { ...epic, in_force: [...epic.in_force, { ...epic.not_yet_reconciled[0], rule: "SLICE-001/INV-09" }, { ...epic.in_force[0], rule: "SLICE-001/X-01", kind: "something new" }], not_yet_reconciled: [], no_longer_in_force: [] };
  const page = epicPage(mixed);
  assert.deepEqual(page.groups.map((g) => g.id), ["invariants", "requirements", "other"]);
});

test("not applied and conflicts: read in the engine's shapes, and listed in the jumps", () => {
  const withProblems = {
    ...epic,
    not_applied: [{ slice_id: "SLICE-007", problems: [{ line: 40, code: "effects-row", message: "Line 40 is not a row." }] }, "junk", null],
    conflicts: ["SLICE-001/FR-02 is replaced by SLICE-003 and changed by SLICE-005.", 4, ""],
  };
  const page = epicPage(withProblems);
  assert.deepEqual(page.notApplied, [{ slice_id: "SLICE-007", problems: [{ line: 40, code: "effects-row", message: "Line 40 is not a row." }] }]);
  assert.deepEqual(page.conflicts, ["SLICE-001/FR-02 is replaced by SLICE-003 and changed by SLICE-005."]);
  assert.deepEqual(page.jumps.slice(-2).map((j) => j.id), ["not-applied", "conflicts"]);
  assert.deepEqual(notApplied(undefined), []);
  assert.deepEqual(conflicts(null), []);
});

test("nothing shipped: the engine returns no epic and says why", () => {
  const none = fixture("epic.current.nothing-shipped");
  assert.equal(none.epic, null);
  assert.match(none.notes[0], /No shipped slice spec/);
  assert.match(none.note, /may be behind GitHub/);
});

test("each slice's title and effects state has words", () => {
  assert.equal(sliceTitle(epic, "SLICE-003"), "Invite with approval");
  assert.equal(sliceTitle(epic, "SLICE-099"), null);
  for (const s of epic.slices) assert.ok(sliceEffectsWords[s.effects], s.effects);
  assert.ok(sliceEffectsWords.problems);
});

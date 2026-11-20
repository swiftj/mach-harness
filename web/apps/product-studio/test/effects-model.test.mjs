// Unit tests for the Effects on shipped behaviour tab's model (src/features/effects/model.ts), against
// the engine's own fixture runs in web/fixtures. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effectProblems, effectWords, effectsView, shortCommit } from "../src/features/effects/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8")).data;
const clone = (v) => JSON.parse(JSON.stringify(v));

const shown = fixture("slice.show.effects");
const moved = fixture("status.shipped-moved").slices.find((s) => s.slice_id === "SLICE-004").shipped_moved;

test("rows: one per shipped rule, in the spec's order, each with the line the engine gave", () => {
  const view = effectsView(shown, null);
  assert.equal(view.state, "rows");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].row.shipped_rule, "SLICE-002/FR-01");
  assert.equal(view.rows[0].row.effect, "kept");
  assert.equal(view.rows[0].line, 87);
  assert.deepEqual(view.rows[0].problems, []);
  assert.deepEqual(view.sectionProblems, []);
  assert.equal(view.shipped.rules, 8);
  assert.equal(view.moved, null);
});

test("moved since checked: the engine's problem is placed beside the row on its line", () => {
  const view = effectsView(shown, moved);
  assert.equal(view.moved.note, moved.note);
  assert.equal(view.rows[0].problems.length, 1);
  assert.equal(view.rows[0].problems[0].source, "moved");
  assert.equal(view.rows[0].problems[0].message, moved.problems[0].message);
  assert.deepEqual(view.sectionProblems, []);
});

test("a problem whose line names no row stays with the whole section", () => {
  const away = { ...moved, problems: [{ ...moved.problems[0], line: 12 }] };
  const view = effectsView(shown, away);
  assert.deepEqual(view.rows[0].problems, []);
  assert.equal(view.sectionProblems.length, 1);
});

test("None. is a real answer: state none, no rows", () => {
  const view = effectsView(fixture("slice.show.policy-followed"), null);
  assert.equal(view.state, "none");
  assert.deepEqual(view.rows, []);
});

test("no section yet: the engine's effects-missing finding is shown in its words", () => {
  const view = effectsView(fixture("slice.show.effects-missing"), null);
  assert.equal(view.state, "no-section");
  assert.equal(view.sectionProblems.length, 1);
  assert.equal(view.sectionProblems[0].rule, "effects-missing");
  assert.match(view.sectionProblems[0].message, /^Missing section '## Effects on shipped behaviour'/);
});

test("no specification: state no-spec", () => {
  const empty = clone(shown);
  empty.spec = null;
  assert.equal(effectsView(empty, null).state, "no-spec");
});

test("a section with problems: each finding beside the row on its line, the rest with the section", () => {
  const view = effectsView(fixture("slice.show.effects-problems"), null);
  assert.equal(view.state, "rows");
  assert.deepEqual(view.rows.map((r) => [r.row.shipped_rule, r.line]), [["SLICE-001/FR-09", 87]]);
  assert.deepEqual(view.rows[0].problems.map((p) => p.rule), ["effects-not-shipped"]);
  assert.deepEqual(view.sectionProblems.map((p) => p.rule), ["effects-kept-scenario"]);
});

test("only findings about the section are taken, by the engine's section or rule code", () => {
  const errors = fixture("slice.show.errors");
  assert.deepEqual(effectProblems(errors.check), []);
  const check = { ...errors.check, diagnostics: [...errors.check.diagnostics, { severity: "warning", rule: "other", line: 3, section: "Effects on shipped behaviour", message: "About the section." }] };
  const found = effectProblems(check);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
});

test("an engine without diagnostics: error lines ending in an effects code are taken", () => {
  const check = { errors: ["x.md: Missing section. [effects-missing]", "x.md: Other. [trace-undefined]"], warnings: [] };
  assert.deepEqual(effectProblems(check).map((p) => p.message), ["x.md: Missing section. [effects-missing]"]);
});

test("every effect has a word, a meaning, and the commit is shown as 10 characters", () => {
  for (const effect of ["kept", "changed", "replaced", "retired"]) {
    assert.ok(effectWords[effect].word);
    assert.ok(effectWords[effect].means.endsWith("."));
  }
  assert.equal(effectWords.retired.inSlice, "");
  assert.equal(shortCommit("e91f18f1778277b63e0926669f46c7aa9ae75a58"), "e91f18f177");
  assert.equal(shortCommit(null), null);
});

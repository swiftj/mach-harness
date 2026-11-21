// Unit tests for The brief screen's model (src/features/shape/brief/briefModel.ts), against the engine's own brief.show,
// brief.check and idea.show fixture runs. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assumptionState,
  briefCounts,
  checkAgainWords,
  checkState,
  isNone,
  placeFindings,
  proseBlocks,
  revisionWords,
  rulesByEpic,
  sectionLines,
  verdictState,
} from "../src/features/shape/brief/briefModel.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const data = (name) => run(name).data;
const placesOf = (placed) => placed.all.map((f) => [f.rule, f.line, f.place.kind === "whole" ? "whole" : f.place.id]);

test("the section headings are found at the lines the engine numbers", () => {
  const show = data("brief.show.finding");
  const lines = sectionLines(show.text);
  assert.deepEqual(lines.map((s) => s.id), ["problem", "who", "outcomes", "not-doing", "assumptions", "open-questions", "risks", "touches"]);
  assert.equal(lines.find((s) => s.id === "outcomes").line, 11);
  assert.equal(show.text.split("\n")[10], "## Outcomes");
});

test("a brief with a problem: each finding sits beside the outcome or section its line falls in", () => {
  const show = data("brief.show.finding");
  const placed = placeFindings(show);
  assert.deepEqual(placesOf(placed), [
    ["brief-how-vague", 14, "O-1"],
    ["brief-outcome-how", 16, "O-2"],
    ["brief-open-question", 27, "open-questions"],
  ]);
  assert.deepEqual(placed.errors.map((f) => f.rule), ["brief-outcome-how"]);
  assert.deepEqual(placed.warnings.map((f) => f.rule), ["brief-how-vague", "brief-open-question"]);
  assert.equal(placed.outcome["O-2"][0].anchor, "brief-O-2");
  assert.equal(placed.outcome["O-2"][0].partName, "O-2");
  assert.equal(placed.section["open-questions"][0].partName, "Open questions");
  // The engine's words are kept exactly.
  assert.equal(placed.outcome["O-2"][0].message, "O-2 has no way to know it happened. Say what you would see or count.");
  const state = checkState(show);
  assert.equal(state.kind, "problems");
  assert.equal(state.word, "1 problem to fix");
  assert.equal(state.tone, "danger");
  assert.equal(state.glyph, "blocked");
});

test("the change's starter brief: placeholders are placed in Problem, Who has it, O-1 and Not doing", () => {
  const show = data("brief.show.change-starter");
  const placed = placeFindings(show);
  assert.deepEqual(placesOf(placed), [
    ["brief-placeholder", 5, "problem"],
    ["brief-placeholder", 9, "who"],
    ["brief-placeholder", 13, "O-1"],
    ["brief-placeholder", 14, "O-1"],
    ["brief-placeholder", 18, "not-doing"],
    ["brief-how-vague", 14, "O-1"],
  ]);
  assert.equal(checkState(show).word, "5 problems to fix");
  assert.equal(placed.whole.length, 0);
});

test("a finding with no line, or before any section, is about the whole brief", () => {
  const show = data("brief.show.finding");
  const placed = placeFindings({ ...show, findings: [{ severity: "error", rule: "brief-missing-section", line: 0, message: "x" }, { severity: "error", rule: "brief-title", line: 1, message: "y" }] });
  assert.deepEqual(placed.whole.map((f) => f.rule), ["brief-missing-section", "brief-title"]);
  assert.equal(placed.whole[0].anchor, null);
});

test("a brief that passes, and one that passes with warnings only", () => {
  const passes = data("brief.show.passes");
  assert.deepEqual(checkState(passes), { kind: "passes", word: "Passes its check", tone: "success", glyph: "ready", detail: "Nothing to fix. The next step is the case." });
  assert.equal(placeFindings(passes).all.length, 0);
  // Warnings only: the engine passes it; the screen says so and counts the warnings, never calling them problems.
  const finding = data("brief.show.finding");
  const warningsOnly = { ...finding, passes: true, findings: finding.findings.filter((f) => f.severity === "warning") };
  const state = checkState(warningsOnly);
  assert.equal(state.kind, "warnings");
  assert.equal(state.word, "Passes, 2 warnings");
  assert.equal(placeFindings(warningsOnly).errors.length, 0);
});

test("the check never decides by itself: a brief the engine says does not pass never reads as passing", () => {
  const show = { ...data("brief.show.finding"), findings: [] };
  assert.equal(checkState(show).kind, "problems");
  assert.equal(checkState(show).word, "Does not pass yet");
});

test("a stale verdict is said in the engine's words; a holding one by its decision", () => {
  const stale = data("brief.show.stale-verdict");
  const view = verdictState(stale.verdict);
  assert.equal(view.kind, "stale");
  assert.equal(view.decision, "Go");
  assert.equal(view.note, stale.verdict.stale_note);
  assert.match(view.note, /no longer holds/);
  assert.deepEqual(verdictState(null), { kind: "none" });
  assert.deepEqual(verdictState({ ...stale.verdict, holds: true, stale: false }), { kind: "holds", decision: "Go" });
  // The changed text is reported before it is checked again.
  assert.equal(stale.changed_since_check, true);
  assert.match(revisionWords(stale).changed, /after revision 1 was checked/);
  assert.equal(revisionWords(data("brief.show.passes")).changed, null);
  assert.equal(revisionWords({ revision: 0, changed_since_check: true }).line, "Not checked yet");
});

test("Check again says what happened, from the engine's answer", () => {
  const changed = checkAgainWords(data("brief.check.stale-verdict"));
  assert.equal(changed.title, "Checked again: the text had changed, so this is revision 2");
  assert.equal(changed.body, "It passes its check.");
  const finding = checkAgainWords(data("brief.check.finding"));
  assert.equal(finding.body, "It does not pass yet: 1 problem to fix.");
  const same = checkAgainWords({ ...data("brief.check.passes"), new_revision: false });
  assert.equal(same.title, "Checked again: nothing changed since revision 1");
  const warned = checkAgainWords({ ...data("brief.check.finding"), passes: true, errors: [] });
  assert.equal(warned.body, "It passes its check, with 2 warnings.");
});

test("assumptions show their state as a word and a shape", () => {
  const [a1, a2] = data("brief.show.finding").model.assumptions;
  assert.deepEqual(assumptionState(a1), { word: "Assumed, not confirmed", tone: "warning", glyph: "half" });
  const confirmed = assumptionState(a2);
  assert.match(confirmed.word, /^Confirmed by the head of lending services on .*2026/);
  assert.equal(confirmed.glyph, "approved");
  assert.equal(assumptionState({ ...a1, state: null }).word, "No state given");
});

test("counts come from the model and are never four zeros", () => {
  assert.deepEqual(briefCounts(data("brief.show.finding").model), [["Outcomes", 2], ["Assumptions", 2], ["Open questions", 1], ["Rules touched", 2]]);
  assert.equal(briefCounts({ outcomes: [], assumptions: [], open_questions: [], touches: { capabilities: [], shipped_rules: [] } }), null);
  assert.equal(briefCounts(null), null);
});

test("the product manager's words are split for reading, never interpreted as markup", () => {
  assert.deepEqual(proseBlocks("One.\n\n- a\n- b\n\nTwo\nlines."), [
    { kind: "paragraph", text: "One." },
    { kind: "list", items: ["a", "b"] },
    { kind: "paragraph", text: "Two lines." },
  ]);
  assert.deepEqual(proseBlocks("<b>bold</b> **x**"), [{ kind: "paragraph", text: "<b>bold</b> **x**" }]);
  assert.equal(isNone("None."), true);
  assert.equal(isNone(data("brief.show.passes").model.not_doing), false);
});

test("shipped rules are grouped by the epic the lookups recorded, for How this epic works today", () => {
  const model = data("brief.show.finding").model;
  const lookups = data("idea.show.exploring").lookups;
  // The real lookups recorded no epic for these rules: one group, no link.
  assert.deepEqual(rulesByEpic(model, lookups), [{ epicId: null, name: null, rules: ["SLICE-001/FR-01", "SLICE-001/INV-02"] }]);
  const withEpic = { ...lookups, items: { ...lookups.items, shipped_rules: [{ rule: "SLICE-001/FR-01", in_force: true, epic_id: "EPIC-001" }] } };
  assert.deepEqual(rulesByEpic(model, withEpic), [
    { epicId: "EPIC-001", name: "Lending", rules: ["SLICE-001/FR-01"] },
    { epicId: null, name: null, rules: ["SLICE-001/INV-02"] },
  ]);
  assert.deepEqual(rulesByEpic(model, null), [{ epicId: null, name: null, rules: ["SLICE-001/FR-01", "SLICE-001/INV-02"] }]);
});

test("no brief yet is the engine's refusal, which the screen shows as an invitation, not an error", () => {
  const none = run("brief.show.refused-none");
  assert.equal(none.data, null);
  assert.equal(none.refused, "IDEA-001 has no brief yet.");
  const board = data("status.ideas").ideas.ideas;
  assert.equal(board.find((r) => r.idea_id === "IDEA-001").has_brief, false);
});

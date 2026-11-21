// Unit tests for the M16 layout of a slice's specification and its interview: the specification's views chosen from
// the section list, the check's wording, and the sections of the slice so far beside the interview.
// Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkDetail, viewOf } from "../src/features/spec/specModel.ts";
import { docSections } from "../src/features/interview/model.ts";

test("the section list chooses the view: the why and the source are views, every other section is the specification", () => {
  assert.equal(viewOf("why"), "why");
  assert.equal(viewOf("source"), "source");
  for (const section of ["summary", "open-questions", "rules", "requirements", "decision-table", "scenarios", "dependencies", "assumptions", "effects"]) {
    assert.equal(viewOf(section), "spec", section);
  }
});

test("the check's sentence names MACH, never the engine, and keeps the rest of its words", () => {
  assert.equal(checkDetail("The engine's check found problems in the draft."), "MACH's check found problems in the draft.");
  assert.equal(checkDetail("The engine's check passed and you approved this slice."), "MACH's check passed and you approved this slice.");
  assert.equal(checkDetail("The spec is well formed, but it cannot be approved while questions are open."), "The spec is well formed, but it cannot be approved while questions are open.");
  assert.equal(checkDetail("The interviewer writes the spec once the questions are settled."), "The interviewer writes the spec once the questions are settled.");
});

test("a slice has one row of page tabs: the specification screen no longer has its own tabs", () => {
  const screen = readFileSync(new URL("../src/features/spec/SpecScreen.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(screen, /TabsList|TabsTrigger/);
  assert.match(screen, /"source" as const/, "the source view is in the section list");
});

test("nothing a person reads on these screens says 'engine'", () => {
  for (const file of ["spec/SpecScreen.tsx", "spec/SliceActs.tsx", "spec/SourceEditor.tsx", "interview/InterviewScreen.tsx", "interview/SliceDocument.tsx"]) {
    const text = readFileSync(new URL(`../src/features/${file}`, import.meta.url), "utf8");
    // Strings and JSX text only: comments may say how the code works.
    const shown = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert.doesNotMatch(shown, /["'`>][^"'`<]*\b[Ee]ngine\b[^"'`<]*["'`<]/, file);
  }
});

const model = {
  invariants: [{ id: "INV-01" }, { id: "INV-02" }],
  functional_requirements: [{ id: "FR-01" }, { id: "FR-02" }, { id: "FR-03" }],
  decision_matrix: { rules: [{ id: "R1" }] },
  scenarios: [{ id: "AC-01" }],
  open_questions: [],
  assumptions: ["Seats are counted per workspace."],
};

test("the slice so far lists only the sections it shows, in its order, with the heading ids the document uses", () => {
  const rows = docSections([], model, 0, new Set());
  assert.deepEqual(
    rows.map((r) => [r.id, r.label, r.note]),
    [
      ["doc-rules", "What must always be true", null],
      ["doc-reqs", "What it does", null],
      ["doc-cases", "Every case", null],
      ["doc-examples", "Examples to prove it", null],
      ["doc-assumptions", "Assumed", null],
    ],
  );
  assert.deepEqual(docSections([], null, 0, new Set()), [], "nothing written: no sections");
  assert.deepEqual(docSections([], { decision_matrix: null }, 2, new Set()).map((r) => [r.id, r.note]), [["doc-open", { kind: "open", count: 2 }]], "open questions from the check when the spec has none");
});

test("a section's note is its findings first, then what arrived with the latest write, then what is still open", () => {
  const findings = [{ section: "decision-table" }, { section: "decision-table" }, { section: "requirements" }, { section: null }, { section: "why" }];
  const rows = docSections(findings, { ...model, open_questions: ["a", "b"] }, 0, new Set(["FR-02", "FR-03", "INV-02", "AC-01"]));
  const notes = Object.fromEntries(rows.map((r) => [r.id, r.note]));
  assert.deepEqual(notes["doc-cases"], { kind: "problems", count: 2 });
  assert.deepEqual(notes["doc-reqs"], { kind: "problems", count: 1 }, "a finding outranks what is new");
  assert.deepEqual(notes["doc-rules"], { kind: "new", count: 1 });
  assert.deepEqual(notes["doc-examples"], { kind: "new", count: 1 });
  assert.deepEqual(notes["doc-open"], { kind: "open", count: 2 });
  assert.equal(notes["doc-assumptions"], null);
});

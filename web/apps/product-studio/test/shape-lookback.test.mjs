// Unit tests for the Look back screen's model (src/features/shape/lookback/model.ts), against the real engine runs the
// fixture transport answers with (web/fixtures/idea.show.*, idea.chain*, lookback.record*, status.ideas-*).
// Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NOTE_LIMIT,
  chainLines,
  confirmWords,
  emptyDraft,
  lookbackGate,
  lookbackItems,
  oneLine,
  placeMissing,
  progressLook,
  progressWords,
  recordArgs,
  recordedCount,
  resultChoices,
  resultLook,
  savedWhere,
  settledWords,
} from "../src/features/shape/lookback/model.ts";

const run = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const data = (name) => run(name).data;
const statusRow = (name, id = "IDEA-001") => data(name).ideas.ideas.find((row) => row.idea_id === id);

// ---- the gate: what the engine allows, never worked out from the slices ----

test("shaped with nothing shipped: waiting, in the engine's words", () => {
  const row = statusRow("status.ideas-shaped");
  const gate = lookbackGate(row, null);
  assert.equal(gate.kind, "waiting");
  assert.equal(gate.sentence, row.next.sentence);
  assert.match(gate.sentence, /once one has shipped/);
});

test("a slice has shipped: the look back is open, nothing recorded yet", () => {
  const show = data("idea.show.look-back");
  assert.equal(show.lookback, null);
  const gate = lookbackGate(show.idea, show.lookback);
  assert.equal(gate.kind, "open");
  assert.equal(lookbackGate(statusRow("status.ideas-look-back"), null).kind, "open");
});

test("partly recorded stays open; fully recorded (next step none) stays open for recording again", () => {
  const show = data("idea.show.looked-back");
  assert.equal(recordedCount(show.lookback), 3);
  assert.equal(lookbackGate(show.idea, show.lookback).kind, "open");
  const allDone = { ...show.idea, next: { kind: "none", sentence: "Nothing waits." } };
  assert.equal(lookbackGate(allDone, show.lookback).kind, "open");
});

test("an idea decided Not now or No never became work: an honest empty state, with its verdict", () => {
  for (const [fixture, word] of [["idea.show.not-now", "not-now"], ["idea.show.fault", "no"]]) {
    const show = data(fixture);
    const gate = lookbackGate(show.idea, show.lookback);
    assert.equal(gate.kind, "decided-against", fixture);
    assert.equal(gate.decision, word);
  }
});

test("ideas still being shaped are not shaped yet, with their next step's sentence", () => {
  for (const fixture of ["idea.show.request", "idea.show.exploring", "idea.show.brief-written", "idea.show.go", "idea.show.mapped"]) {
    const show = data(fixture);
    const gate = lookbackGate(show.idea, show.lookback);
    assert.equal(gate.kind, "not-shaped", fixture);
    assert.equal(gate.sentence, show.idea.next.sentence);
  }
});

// ---- the three-way record: equal weight, nothing pre-selected ----

test("no result is pre-selected, for outcomes and assumptions, and recording again starts empty too", () => {
  const draft = emptyDraft();
  assert.equal(draft.result, null);
  assert.equal(draft.note, "");
  for (const kind of ["outcome", "assumption"]) {
    const choices = resultChoices[kind];
    assert.equal(choices.length, 3);
    for (const choice of choices) {
      // No choice carries a default, a recommendation or a tone of its own.
      assert.deepEqual(Object.keys(choice).sort(), ["glyph", "value", "word"]);
    }
    assert.equal(new Set(choices.map((c) => c.glyph)).size, 3, "each choice has its own shape");
  }
  // A recorded result never becomes the form's starting choice.
  assert.notStrictEqual(emptyDraft(), emptyDraft());
});

test("the choices are the engine's results, with the words the person sees", () => {
  assert.deepEqual(resultChoices.outcome.map((c) => [c.value, c.word]), [["met", "Met"], ["not-met", "Not met"], ["too-early", "Too early to say"]]);
  assert.deepEqual(resultChoices.assumption.map((c) => [c.value, c.word]), [["confirmed", "Confirmed"], ["wrong", "Wrong"], ["unknown", "Still unknown"]]);
  assert.equal(resultLook("wrong").word, "Wrong");
  assert.equal(resultLook("something-new").word, "something-new");
});

test("a record needs a choice and a note; nothing is sent without both", () => {
  const none = recordArgs("IDEA-001", "outcome", "O-1", emptyDraft());
  assert.equal(none.args, null);
  assert.match(none.problems.result, /Met, Not met or Too early to say/);
  assert.match(none.problems.note, /own words/);
  const noNote = recordArgs("IDEA-001", "assumption", "A-1", { result: "wrong", note: "   " });
  assert.equal(noNote.args, null);
  assert.equal(noNote.problems.result, undefined);
  const tooLong = recordArgs("IDEA-001", "outcome", "O-1", { result: "met", note: "x".repeat(NOTE_LIMIT + 1) });
  assert.match(tooLong.problems.note, /500 characters; it is 501/);
  const wrongKind = recordArgs("IDEA-001", "outcome", "O-1", { result: "confirmed", note: "Seen." });
  assert.equal(wrongKind.args, null, "an assumption's result is not an outcome's");
});

test("the act's arguments are exactly one item, in the operation's shape", () => {
  const outcome = recordArgs("IDEA-001", "outcome", "O-1", { result: "met", note: "Calls at Central were down\nto 11 a week." });
  assert.deepEqual(outcome.args, { idea_id: "IDEA-001", outcome: "O-1", result: "met", note: "Calls at Central were down to 11 a week." });
  const assumption = recordArgs("IDEA-001", "assumption", "A-1", { result: "wrong", note: "About half the calls were about held items." });
  assert.deepEqual(assumption.args, { idea_id: "IDEA-001", assumption: "A-1", result: "wrong", note: "About half the calls were about held items." });
  assert.equal(oneLine("a\r\n  b\nc"), "a b c");
});

test("the confirmation repeats the result and says what the act does", () => {
  const words = confirmWords("outcome", "O-2", "too-early");
  assert.equal(words.title, "Record O-2 as Too early to say?");
  assert.match(words.description, /in your words/);
  assert.match(words.description, /idea's issue/);
  assert.doesNotMatch(words.description, /script/i);
});

// ---- what is already recorded, and where it was saved ----

test("recorded items come from the idea's record, with who, when, the note and where it is saved", () => {
  const show = data("idea.show.looked-back");
  const chain = data("idea.chain.looked-back");
  const items = lookbackItems(chain, show.lookback);
  assert.deepEqual(items.map((i) => [i.kind, i.id]), [["outcome", "O-1"], ["outcome", "O-2"], ["assumption", "A-1"], ["assumption", "A-2"]]);
  const o1 = items[0];
  assert.equal(o1.entry.result, "met");
  assert.equal(o1.entry.by, "ada-pm");
  assert.match(o1.entry.note, /11 a week/);
  assert.equal(items[3].entry, null);
  assert.equal(progressWords(items), "3 of 4 recorded");
  const github = show.idea.github;
  assert.deepEqual(savedWhere(show.lookback.outcomes["O-2"], github), { onIssue: 1, url: github.url, words: "Saved on the idea's issue" });
  assert.equal(savedWhere(show.lookback.outcomes["O-1"], github).words, "Already on the idea's issue");
});

test("a look back kept here only says so, and why", () => {
  const folder = data("lookback.record.folder");
  const saved = savedWhere({ comment: folder.comment }, null);
  assert.equal(saved.onIssue, null);
  assert.match(saved.words, /this computer only/);
  assert.match(savedWhere({ comment: { posted: false, why: "github_failed" } }, null).words, /Record it again/);
});

test("nothing recorded yet: every item waits, none is filled in", () => {
  const show = data("idea.show.look-back");
  const items = lookbackItems(data("idea.chain"), show.lookback);
  assert.ok(items.every((i) => i.entry === null));
  assert.equal(progressWords(items), "0 of 4 recorded");
});

// ---- the chain: every link, and what is missing said to be missing ----

test("each outcome is one line: its slices, each with its epic's acceptance, and the look back", () => {
  const chain = data("idea.chain");
  const lines = chainLines(chain);
  assert.deepEqual(lines.map((l) => l.outcome.outcome), ["O-1", "O-2"]);
  const o1 = lines[0];
  assert.deepEqual(o1.slices.map((s) => s.slice.slice_id), ["SLICE-005", "SLICE-006"]);
  assert.equal(o1.slices[0].slice.spec.functional_requirements.length, 9);
  assert.deepEqual(o1.slices[0].slice.spec.scenarios, ["AC-01", "AC-02", "AC-03"]);
  assert.equal(o1.slices[0].epic.epic_id, "EPIC-002");
  assert.equal(o1.slices[1].epic.epic_id, "EPIC-001");
  // Acceptance is always missing as built, with the engine's own reason; never a value.
  for (const { epic } of o1.slices) {
    assert.equal(epic.acceptance, null);
    assert.match(epic.missing, /keeps no copy of it/);
  }
});

test("missing values keep their reasons, each placed on its own link", () => {
  const chain = data("idea.chain");
  const [o1] = chainLines(chain);
  assert.deepEqual(o1.missing.placed.lookback, ["no look-back is recorded"]);
  assert.deepEqual(o1.missing.rest, []);
  const slice6 = o1.slices[1].slice;
  assert.equal(slice6.spec, null);
  assert.deepEqual(placeMissing(slice6.missing).placed.spec, ["no spec has been written yet"]);
  const sorted = placeMissing([
    "this outcome is no longer in the brief",
    "no slice serves it",
    "where it stands with the builders is not known: it is not saved to GitHub",
    "this slice is not in this workspace",
    "something new",
  ]);
  assert.deepEqual(sorted.placed.outcome, ["this outcome is no longer in the brief"]);
  assert.deepEqual(sorted.placed.slice, ["no slice serves it", "this slice is not in this workspace"]);
  assert.equal(sorted.placed.stands.length, 1);
  assert.deepEqual(sorted.rest, ["something new"], "a sentence the app does not place is still shown");
});

test("a slice the chain names but does not hold is still a row, said to be missing", () => {
  const chain = data("idea.chain");
  const lines = chainLines({ ...chain, slices: chain.slices.filter((s) => s.slice_id !== "SLICE-006") });
  const row = lines[1].slices[0];
  assert.equal(row.slice.slice_id, "SLICE-006");
  assert.deepEqual(row.slice.missing, ["this slice is not in this workspace"]);
  assert.equal(row.epic, null);
});

test("where each slice stands is a word and a shape; unknown is said, never guessed", () => {
  const chain = data("idea.chain.looked-back");
  const [shipped, draft] = chain.slices;
  assert.deepEqual(progressLook(shipped.progress), { word: "Shipped", glyph: "accepted", known: true });
  assert.deepEqual(progressLook(draft.progress), { word: "Drafted", glyph: "open", known: true });
  assert.equal(progressLook(null).known, false);
  const shapes = ["draft", "interviewing", "ready_for_approval", "approved", "ready_to_build", "being_built", "question", "shipped", "superseded"].map((p) => progressLook(p).glyph);
  assert.equal(new Set(shapes).size, shapes.length, "every place has its own shape");
});

test("the looked-back chain carries each result as recorded", () => {
  const lines = chainLines(data("idea.chain.looked-back"));
  assert.equal(lines[0].outcome.lookback.result, "met");
  assert.equal(resultLook(lines[1].outcome.lookback.result).word, "Too early to say");
  assert.equal(lines[0].missing.placed.lookback, undefined);
});

test("a settlement from the map reads in words", () => {
  assert.equal(settledWords(null), null);
  assert.equal(settledWords({ as: "out-of-scope", at: "x" }), "Settled as out of scope");
  assert.equal(settledWords({ as: "later", at: "x" }), "Settled as for later");
  assert.equal(settledWords(data("idea.chain").outcomes[1].settled), "Settled to a slice in the map");
});

test("refusals come back in the engine's words", () => {
  assert.match(run("lookback.record.refused-not-shipped").refused, /once a slice made from it has shipped/);
  assert.match(run("lookback.record.refused-secret").refused, /shaped like a secret/);
});

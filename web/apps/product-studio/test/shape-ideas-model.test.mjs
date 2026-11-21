// Unit tests for Shape's ideas board (src/features/shape/ideas/model.ts), against the real engine runs the fixture
// transport answers with (web/fixtures/status.ideas*.json, idea.list.*, idea.show.*, idea.add.*, request.list.idea).
// Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  addIdeaArgs,
  boardColumns,
  ideaCount,
  issueOption,
  oneLine,
  savedShown,
  showsReason,
  sourceShown,
  sourceWordsByKind,
  stageMeaning,
  stages,
  startOptions,
  titleLimit,
  titleProblem,
  verdictLook,
} from "../src/features/shape/ideas/model.ts";
import { nextPathOf } from "../src/features/shape/shell/steps.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const data = (name) => run(name).data;
const board = (name = "status.ideas") => data(name).ideas;

test("empty: status has no ideas field, and idea.list's empty board still gives five empty columns", () => {
  const empty = data("idea.list.empty");
  const { columns, elsewhere } = boardColumns(empty);
  assert.deepEqual(columns.map((c) => c.stage), stages);
  assert.ok(columns.every((c) => c.rows.length === 0));
  assert.deepEqual(elsewhere, []);
  // A status without Shape has no `ideas`: the screen shows its empty state.
  const plain = readdirSync(folder).filter((f) => /^status\.[a-z-]+\.json$/.test(f) && !f.startsWith("status.ideas"));
  assert.ok(plain.length > 0);
  for (const f of plain) assert.equal(data(f.slice(0, -5)).ideas, undefined, f);
});

test("the board: every stage holds its ideas in the engine's own order, and nothing is lost", () => {
  const b = board();
  const { columns, elsewhere } = boardColumns(b);
  assert.deepEqual(columns.map((c) => c.words), ["New", "Exploring", "Brief written", "Decided", "Shaped into work"]);
  for (const column of columns) assert.deepEqual(column.rows.map((r) => r.idea_id), b.by_stage[column.stage], column.stage);
  assert.deepEqual(columns.map((c) => c.rows.length), stages.map((s) => b.counts[s]));
  assert.equal(columns.reduce((n, c) => n + c.rows.length, 0), b.ideas.length);
  assert.deepEqual(elsewhere, []);
  for (const stage of stages) assert.ok(stageMeaning[stage].endsWith("."), stage);
});

test("no ranking: a reversed by_stage reverses the column; the app never sorts by anything of its own", () => {
  const b = board();
  const reversed = { ...b, by_stage: { ...b.by_stage, decided: [...b.by_stage.decided].reverse() } };
  const decided = boardColumns(reversed).columns.find((c) => c.stage === "decided");
  assert.deepEqual(decided.rows.map((r) => r.idea_id), ["IDEA-006", "IDEA-005", "IDEA-004"]);
});

test("an idea missing from by_stage, or at a place the app does not know, is still shown", () => {
  const b = board();
  const missing = { ...b, by_stage: { ...b.by_stage, new: [] } };
  assert.deepEqual(boardColumns(missing).columns[0].rows.map((r) => r.idea_id), ["IDEA-001"]);
  const odd = { ...b.ideas[0], idea_id: "IDEA-099", stage: "parked", stage_words: "Parked" };
  const { elsewhere } = boardColumns({ ...b, ideas: [...b.ideas, odd] });
  assert.deepEqual(elsewhere.map((r) => r.idea_id), ["IDEA-099"]);
});

test("each source in words, with its identifier; the words are the engine's own", () => {
  const rows = Object.fromEntries(board().ideas.map((r) => [r.idea_id, r]));
  assert.deepEqual(sourceShown(rows["IDEA-001"].source), { words: "From a request", id: "#57", issue: 57 });
  assert.deepEqual(sourceShown(rows["IDEA-002"].source), { words: "Filed in the idea template", id: "#58", issue: 58 });
  assert.deepEqual(sourceShown(rows["IDEA-003"].source), { words: "Typed by the product manager", id: null, issue: null });
  assert.deepEqual(sourceShown(rows["IDEA-004"].source), { words: "A fault from production", id: "AUTO-20261120T101500Z", issue: null });
  assert.deepEqual(sourceShown(rows["IDEA-007"].source), { words: "A change to a rule that has shipped", id: "SLICE-001/INV-02", issue: null });
  // The same words idea.show gives for each kind.
  for (const name of ["request", "exploring", "brief-written", "fault", "change"]) {
    const source = data(`idea.show.${name}`).source;
    assert.equal(sourceWordsByKind[source.kind], source.words, name);
  }
  assert.equal(sourceShown({ kind: "carrier-pigeon" }).words, "carrier-pigeon");
});

test("each verdict has a word and its own shape; the reason is quoted only for a decided idea", () => {
  const looks = ["go", "not-now", "no"].map(verdictLook);
  assert.deepEqual(looks.map((l) => l.word), ["Go", "Not now", "No"]);
  assert.equal(new Set(looks.map((l) => l.glyph)).size, 3);
  assert.equal(verdictLook("maybe").word, "maybe");
  const rows = Object.fromEntries(board().ideas.map((r) => [r.idea_id, r]));
  assert.equal(showsReason(rows["IDEA-004"]), true);
  assert.equal(showsReason(rows["IDEA-003"]), false);
  assert.equal(showsReason(rows["IDEA-008"]), false, "shaped: the card says what it was shaped into");
  // Board rows carry no reason; idea.show does, in the product manager's words.
  assert.equal(rows["IDEA-004"].verdict.reason, undefined);
  assert.match(data("idea.show.fault").verdict.reason, /supplier's fault/);
  assert.match(data("idea.show.not-now").verdict.reason, /after the summer/);
  assert.match(data("idea.show.go").verdict.reason, /every desk/);
});

test("a verdict that no longer holds is reported by the engine, never worked out here", () => {
  const row = board("status.ideas-stale-verdict").ideas[0];
  assert.equal(row.stage, "brief");
  assert.equal(row.verdict.stale, true);
  assert.equal(showsReason(row), false);
});

test("saved state: one per card, the most pressing first, each with a word and a shape", () => {
  const first = (name) => board(name).ideas[0].github;
  assert.equal(savedShown(first("status.ideas")).key, "not_yet");
  assert.equal(savedShown(first("status.ideas-folder")).key, "folder");
  const github = savedShown(first("status.ideas-shaped"));
  assert.equal(github.key, "github");
  assert.equal(github.issue, 1);
  assert.equal(github.url, "https://github.com/acme/team-space/issues/1");
  const changed = savedShown(first("status.ideas-changed"));
  assert.equal(changed.key, "changed_after_verdict");
  assert.equal(changed.attention, true);
  const unfinished = savedShown(board("status.ideas-unfinished").ideas[1].github);
  assert.equal(unfinished.key, "unfinished");
  assert.equal(unfinished.issue, 2);
  assert.equal(savedShown({ ...first("status.ideas"), number_taken: true }).key, "number_taken");
  assert.equal(savedShown({ ...first("status.ideas-changed"), changed_after_verdict: false }).key, "changed_on_github");
  for (const key of ["not_yet", "folder", "github"]) assert.equal(savedShown(key === "not_yet" ? first("status.ideas") : key === "folder" ? first("status.ideas-folder") : first("status.ideas-shaped")).attention, false, key);
  for (const g of [first("status.ideas"), first("status.ideas-folder"), first("status.ideas-shaped"), first("status.ideas-changed")]) {
    const shown = savedShown(g);
    assert.ok(shown.word && shown.glyph && shown.description.endsWith("."), shown.key);
  }
});

test("each card opens where the engine's next step is, and shows the engine's sentence as written", () => {
  const rows = Object.fromEntries(board().ideas.map((r) => [r.idea_id, r]));
  assert.equal(nextPathOf(rows["IDEA-001"]), "/shape/ideas/IDEA-001/explore");
  assert.equal(nextPathOf(rows["IDEA-002"]), "/shape/ideas/IDEA-002/brief");
  assert.equal(nextPathOf(rows["IDEA-003"]), "/shape/ideas/IDEA-003/case");
  assert.equal(nextPathOf(rows["IDEA-008"]), "/shape/ideas/IDEA-008/look-back");
  for (const row of Object.values(rows)) assert.ok(row.next.sentence.length > 0, row.idea_id);
});

test("adding: one line, trimmed, at most one source; empty and over-long titles are asked about first", () => {
  assert.deepEqual(addIdeaArgs("  Reserve a study room online ", { kind: "nothing" }), { title: "Reserve a study room online" });
  assert.deepEqual(addIdeaArgs("Reminder", { kind: "request", number: 57 }), { title: "Reminder", from_request: 57 });
  assert.deepEqual(addIdeaArgs("Renew", { kind: "idea", number: 58 }), { title: "Renew", from_issue: 58 });
  assert.equal(oneLine("Renew a loan\nthemselves"), "Renew a loan themselves");
  assert.match(titleProblem("   "), /short title/);
  assert.match(titleProblem("x".repeat(titleLimit + 1)), /120 characters or fewer/);
  assert.equal(titleProblem("x".repeat(titleLimit)), null);
  // The engine's answers for each source.
  assert.equal(data("idea.add").idea.source.kind, "typed");
  assert.equal(data("idea.add.from-request").idea.source.number, 57);
  assert.equal(data("idea.add.from-issue").idea.source.kind, "idea");
  assert.match(data("idea.add").note, /Nothing was sent anywhere/);
});

test("adding refused: the engine's own words", () => {
  assert.equal(run("idea.add.refused-twice").refused, "IDEA-001 was already started from #57.");
  assert.match(run("idea.add.refused-not-template").refused, /not in the idea template/);
  assert.doesNotMatch(run("idea.add.refused-not-template").refused, /--from/, "the app's wording, not the terminal's");
});

test("starting from an issue: only what the engine lists; idea issues are those in the idea template", () => {
  const items = data("request.list.idea").requests.items;
  const { requests, ideaIssues } = startOptions(items);
  assert.deepEqual(requests.map((i) => i.number), [42, 43]);
  assert.deepEqual(ideaIssues.map((i) => i.number), [43]);
  assert.deepEqual(startOptions(null), { requests: [], ideaIssues: [] });
  assert.equal(issueOption(items[0]), "#42: Let admins invite a teammate");
  assert.equal(issueOption({ number: 9, title: null }), "#9 (title not recorded)");
});

test("counts in words", () => {
  assert.equal(ideaCount(1), "1 idea");
  assert.equal(ideaCount(8), "8 ideas");
});

// Unit tests for the one place the app reads what moving a project answered (src/features/move/model.ts), against the
// real engine runs in web/fixtures (move_memory.py). Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  doneView,
  elapsedWords,
  exportView,
  fieldTitle,
  fileProblem,
  holdsWords,
  importRows,
  importView,
  isFullImport,
  itemText,
  itemsOf,
  lookupId,
  lookupWords,
  offersOnlyMine,
  readyView,
  renumberedPreview,
  sizeText,
  unfinishedImport,
} from "../src/features/move/model.ts";

const run = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const fixture = (name) => run(name).data;
/** What the host adds after an export: the one file to download (apps/studio/internal/server/downloads.go). */
const withDownload = (data) => ({ ...data, downloads: [{ name: data.file.split("/").pop(), url: "/api/downloads/t/x.zip", bytes: data.bytes }] });

/* ── Taking the project elsewhere ─────────────────────────────────────── */

test("export: what the file holds, the download, the note word for word", () => {
  const data = withDownload(fixture("project.export"));
  const view = exportView(data);
  assert.equal(view.holds, "2 epics, 3 slices and 1 principle");
  assert.match(view.fileName, /^mach-project-lending-\d{8}T\d{6}Z\.zip$/);
  assert.equal(view.download.bytes, data.bytes);
  assert.equal(view.downloadProblem, null);
  assert.equal(view.note, data.note);
  assert.equal(view.lead, data.in_words[0]);
  assert.deepEqual([view.chosen, view.notIncluded, view.rest], [[], [], []]);
  assert.equal(view.githubNotRead, null);
  assert.equal(view.fromHere, 7);
  assert.equal(view.fromGithub, 0);
  assert.deepEqual(view.staysBehind, data.stays_behind);
  assert.deepEqual(view.more, [], "nothing the screen does not know about");
});

test("export from a workspace without the project: read from GitHub, in the engine's words and order", () => {
  const data = withDownload(fixture("project.export.from-github"));
  const view = exportView(data);
  assert.equal(view.fromGithub, 5);
  assert.equal(view.lead, data.in_words[0]);
  assert.deepEqual(view.rest, data.in_words.slice(1));
});

test("export when GitHub could not be read: that sentence is said apart, and nowhere else", () => {
  const data = withDownload(fixture("project.export.github-not-read"));
  const view = exportView(data);
  assert.equal(view.githubNotRead, data.in_words[1]);
  assert.match(view.githubNotRead, /^MACH could not read GitHub just now/);
  assert.deepEqual(view.rest, []);
});

test("export: chosen versions and what was not included, each as written, before the rest", () => {
  const data = {
    ...withDownload(fixture("project.export.from-github")),
    chosen: [{ id: "SLICE-001", used: "github", issue: 3, note: "Note on SLICE-001." }],
    not_included: [{ id: "SLICE-004", what: "slice", issue: 9, reason: "Reason for SLICE-004." }],
  };
  data.in_words = [data.in_words[0], "Note on SLICE-001.", "Reason for SLICE-004.", ...data.in_words.slice(1)];
  const view = exportView(data);
  assert.deepEqual(view.chosen, ["Note on SLICE-001."]);
  assert.deepEqual(view.notIncluded, ["Reason for SLICE-004."]);
  assert.deepEqual(view.rest, fixture("project.export.from-github").in_words.slice(1));
});

test("export: lists the engine adds later are shown as they come, by their items' text", () => {
  const view = exportView({ ...withDownload(fixture("project.export")), left_out_note: "One slice was left out because it was closed." });
  assert.deepEqual(view.more, [{ title: "Left out note", items: ["One slice was left out because it was closed."] }]);
});

test("export: a file larger than the host serves says where it is instead", () => {
  const data = { ...fixture("project.export"), downloads: [], download_problem: "The file is larger than 64 MB. MACH saved it on this computer, in /x." };
  const view = exportView(data);
  assert.equal(view.download, null);
  assert.equal(view.downloadProblem, data.download_problem);
});

test("export refusals are the engine's words; only the one about slices only on GitHub offers to leave them out", () => {
  assert.equal(offersOnlyMine(run("project.export.refused-no-project").refused), false);
  assert.equal(offersOnlyMine(run("project.export.refused-unfinished").refused), false);
  assert.equal(offersOnlyMine(run("project.export.refused-no-project-no-github").refused), false);
  assert.equal(offersOnlyMine("2 slices of this project are on GitHub but not in your workspace: SLICE-004 (#12), SLICE-005. Open each here first, or export without them."), true);
});

/* ── Bringing a project in ──────────────────────────────────────────────── */

test("plan into an empty repository: it becomes the project, numbers stay, two were ready there", () => {
  const plan = fixture("project.import.plan");
  assert.ok(isFullImport(plan));
  const view = importView(plan);
  assert.equal(view.name, "Lending");
  assert.equal(view.mode, "new");
  assert.equal(view.holds, "2 epics, 3 slices and 1 principle");
  assert.deepEqual(view.renumbered, []);
  assert.equal(view.renumberedWords, null);
  assert.equal(view.readyThere, 2);
  assert.deepEqual(view.slices.filter((s) => s.readyThere).map((s) => s.to), ["SLICE-001", "SLICE-002"]);
  assert.deepEqual(view.after, plan.after);
  assert.equal(view.note, plan.note);
  assert.deepEqual(view.leftBehind, []);
});

test("plan joining a project: every epic and slice renumbered, old to new, and the joining project's words stay behind", () => {
  const view = importView(fixture("project.import.plan-join"));
  assert.equal(view.mode, "join");
  assert.equal(view.renumberedWords, "2 epics and 3 slices get new numbers");
  assert.deepEqual(view.renumbered.slice(0, 3), [
    { from: "EPIC-001", to: "EPIC-002" },
    { from: "EPIC-002", to: "EPIC-003" },
    { from: "SLICE-001", to: "SLICE-002" },
  ]);
  assert.deepEqual(renumberedPreview(view.renumbered), { first: view.renumbered.slice(0, 3), more: 2 });
  assert.deepEqual(view.leftBehind, ["The name, vision and outcomes of “Lending”: this project's own stay as they are."]);
});

test("the plan says how many it would mark ready, in its words; the choice is offered only when it does", () => {
  const plan = fixture("project.import.plan");
  const view = importView(plan);
  assert.equal(view.readyThere, plan.ready_in_source.count);
  assert.equal(view.readyWords, plan.ready_in_source.words);
  assert.equal(view.canMarkReady, true);
  assert.deepEqual(view.heldBack, []);
  const older = { ...plan, ready_in_source: undefined };
  assert.equal(importView(older).canMarkReady, false);
  assert.equal(importView({ ...plan, ready_in_source: { ...plan.ready_in_source, count: 1, held_back: ["SLICE-002"] } }).heldBack[0], "SLICE-002");
});

test("marking ready what was ready there: the engine's note, where it stopped, and the principles to publish first", () => {
  const stopped = readyView(fixture("project.imports.ready.stopped"));
  assert.equal(stopped.complete, false);
  assert.equal(stopped.stoppedAt, "SLICE-001");
  assert.deepEqual(stopped.left, ["SLICE-001", "SLICE-002"]);
  assert.equal(stopped.needsPrinciples, true);
  assert.equal(stopped.note, fixture("project.imports.ready.stopped").note);
  // Published, it stops at a slice that does not answer the principle: no publishing offered then.
  assert.equal(readyView(fixture("project.imports.ready")).needsPrinciples, false);
  // Brought in with "also mark ready": the report carries what marking ready did.
  const joined = doneView(fixture("project.import.join"));
  assert.equal(joined.ready.stoppedAt, "SLICE-002");
  assert.equal(joined.archiveSha, fixture("project.import.join").archive.sha256);
});

test("rows the engine lists are read by their sentence, else ID, file, line and why", () => {
  assert.equal(itemText({ id: "SLICE-004", file: "specs/slices/SLICE-002-x.md", line: 12, why: "inside code in the text; left as written" }),
    "SLICE-004 (specs/slices/SLICE-002-x.md, line 12): inside code in the text; left as written");
  assert.equal(itemText({ id: "SLICE-004", words: "SLICE-004 did not come with the project." }), "SLICE-004 did not come with the project.");
  assert.equal(itemText("As it is."), "As it is.");
  assert.deepEqual(itemsOf(undefined), []);
  assert.deepEqual(itemsOf("One sentence."), ["One sentence."]);
  const view = importView({
    ...fixture("project.import.plan"),
    principles_not_assessed: [
      { slice: "SLICE-001", principle: "PP-02", file: "specs/slices/SLICE-001-x.md", how: "slice_came" },
      { slice: "SLICE-001", principle: "PP-02", file: "specs/slices/SLICE-001-x.md", how: "slice_came" },
    ],
    dependencies_added: [{ slice: "SLICE-016", on: "SLICE-012", rule: "SLICE-012/FR-01", added: true, words: "SLICE-016 now depends on SLICE-012." }],
  });
  assert.deepEqual(view.notAssessed, ["SLICE-001: PP-02 not assessed yet"]);
  assert.deepEqual(view.dependenciesAdded, ["SLICE-016 now depends on SLICE-012."]);
});

test("the report once it is in: note, nothing kept or moved, no new problems", () => {
  const done = fixture("project.import");
  const view = doneView(done);
  assert.equal(view.note, done.note);
  assert.deepEqual(view.keptYours, []);
  assert.deepEqual(view.structuralErrors, []);
  assert.deepEqual(view.numbersMoved, []);
  assert.equal(view.ready, null);
  const joined = doneView(fixture("project.import.join"));
  assert.equal(joined.renumbered.length, 5);
});

test("a file brought in before is answered, not a plan", () => {
  assert.equal(isFullImport(fixture("project.import.already")), false);
});

/* ── Stopped part way, set aside, looked up ─────────────────────────────── */

test("an import that stopped part way: the engine's row, and the file's hash from the record not yet finished", () => {
  assert.equal(unfinishedImport(fixture("status.import-done")), null);
  const open = {
    imports: [{ ...fixture("project.imports").imports[0], finished_at: null, set_aside_at: null }],
    reads_only: true,
    note: "1 project was brought in here.",
  };
  const found = unfinishedImport(fixture("status.import-unfinished"), open);
  assert.match(found.text, /stopped part way\. Bring the same file in again to finish, or set it aside\.$/);
  assert.equal(found.sha256, open.imports[0].archive_sha256);
  assert.equal(unfinishedImport(fixture("status.import-unfinished"), fixture("project.imports.set-aside")).sha256, null);
});

test("the projects brought in here, in words", () => {
  const [row] = importRows(fixture("project.imports"));
  assert.equal(row.name, "Lending");
  assert.equal(row.state, "finished");
  assert.equal(row.holds, "2 epics, 3 slices and 1 principle");
  assert.equal(importRows(fixture("project.imports.set-aside"))[0].state, "set-aside");
  assert.deepEqual(importRows(fixture("project.imports.none")), []);
});

test("what an ID was: the engine's words, or its note when nothing matched", () => {
  assert.deepEqual(lookupWords(fixture("project.imports.lookup-join")), ["SLICE-001 of 'Lending' is SLICE-002 here (brought in on " + fixture("project.imports.lookup-join").found[0].words.split("brought in on ")[1]]);
  assert.deepEqual(lookupWords(fixture("project.imports.lookup-none")), ["SLICE-099 did not come from a project brought in here."]);
  assert.deepEqual(lookupId(" slice-007 "), { id: "SLICE-007" });
  assert.ok("problem" in lookupId(""));
  assert.ok("problem" in lookupId("SLICE-7"));
});

/* ── Small words ────────────────────────────────────────────────────────── */

test("the file is checked before it is sent, and a larger one is sent to /mach-studio", () => {
  assert.equal(fileProblem({ name: "lending.zip", size: 10 }), null);
  assert.match(fileProblem({ name: "lending.pdf", size: 10 }), /\.zip/);
  assert.match(fileProblem({ name: "lending.zip", size: 0 }), /empty/);
  assert.match(fileProblem({ name: "big.ZIP", size: 65 * 1024 * 1024 }), /\/mach-studio/);
});

test("words for counts, sizes, durations and field names", () => {
  assert.equal(holdsWords({ epics: 1, slices: 1, mocks: 2 }), "1 epic, 1 slice and 2 design mocks");
  assert.equal(holdsWords({}), "nothing yet");
  assert.equal(sizeText(8179), "8 KB");
  assert.equal(sizeText(12.5 * 1024 * 1024), "12.5 MB");
  assert.equal(elapsedWords(48_000), "48 s");
  assert.equal(elapsedWords(252_000), "4 min 12 s");
  assert.equal(elapsedWords(3_780_000), "1 h 3 min");
  assert.equal(fieldTitle("from_github"), "From GitHub");
});

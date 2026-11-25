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
  assert.deepEqual(view.leftOut, []);
  assert.deepEqual(view.staysBehind, data.stays_behind);
  assert.deepEqual(view.more, [], "nothing the screen does not know about");
});

test("export: fields the export is gaining are shown as they come, by their items' text", () => {
  const data = {
    ...withDownload(fixture("project.export")),
    from_here: { slices: 2, epics: 2 },
    from_github: [{ id: "SLICE-004", words: "SLICE-004 came from GitHub (#12)." }],
    left_out: [{ id: "SLICE-009", why: "it was closed on GitHub" }],
    left_out_note: "One slice was left out because it was closed.",
  };
  const view = exportView(data);
  assert.deepEqual(view.fromHere, ["2 epics and 2 slices"]);
  assert.deepEqual(view.fromGithub, ["SLICE-004 came from GitHub (#12)."]);
  assert.deepEqual(view.leftOut, ["SLICE-009: it was closed on GitHub"]);
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

test("the engine's own count of slices it would mark ready wins over the app's", () => {
  assert.equal(importView({ ...fixture("project.import.plan"), would_mark_ready: 1 }).readyThere, 1);
  assert.equal(importView({ ...fixture("project.import.plan"), would_mark_ready: ["SLICE-001"] }).readyThere, 1);
});

test("rows the engine lists are read by their sentence, else ID, file, line and why", () => {
  assert.equal(itemText({ id: "SLICE-004", file: "specs/slices/SLICE-002-x.md", line: 12, why: "inside code in the text; left as written" }),
    "SLICE-004 (specs/slices/SLICE-002-x.md, line 12): inside code in the text; left as written");
  assert.equal(itemText({ id: "SLICE-004", words: "SLICE-004 did not come with the project." }), "SLICE-004 did not come with the project.");
  assert.equal(itemText("As it is."), "As it is.");
  assert.deepEqual(itemsOf(undefined), []);
  assert.deepEqual(itemsOf("One sentence."), ["One sentence."]);
  const view = importView({ ...fixture("project.import.plan"), not_assessed: [{ id: "PP-01", words: "PP-01 was recorded as not assessed in SLICE-001." }] });
  assert.deepEqual(view.notAssessed, ["PP-01 was recorded as not assessed in SLICE-001."]);
});

test("the report once it is in: note, nothing kept or moved, no new problems", () => {
  const done = fixture("project.import");
  const view = doneView(done);
  assert.equal(view.note, done.note);
  assert.deepEqual(view.keptYours, []);
  assert.deepEqual(view.structuralErrors, []);
  assert.deepEqual(view.numbersMoved, []);
  assert.deepEqual(view.markedReady, []);
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

// Unit tests for the Jira screen's arrangement of the engine's answers
// (src/features/jira/model.ts), against the real engine output the fixture transport serves
// (web/fixtures). Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildLedger,
  epicKey,
  exportArgs,
  exportSummary,
  fileContents,
  isHostDownload,
  keysSummary,
  label,
  ledgerFacts,
  namesFrom,
  readmeEssentials,
  rowWords,
  sliceKey,
  wouldRecord,
  jiraOpenPart,
  keysPartSummary,
  exportPartSummary,
  keysBackSummary,
} from "../src/features/jira/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8")).data;
const refusal = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8")).refused;

const status = fixture("status.jira-mocks"); // EPIC-001 with TEAM-2; SLICE-001 with TEAM-12 of its own; SLICE-002 with none
const rich = fixture("status.rich");

/* ── States of the key ledger (status reports each key, as tracking) ──── */

test("empty workspace: no epics, nothing to show", () => {
  const ledger = buildLedger(fixture("status.empty"));
  assert.deepEqual(ledger, []);
  assert.equal(ledgerFacts(ledger).epics, 0);
});

test("an epic with no slices yet is listed with none", () => {
  const ledger = buildLedger(fixture("status.project-and-epic"));
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].slices, []);
});

test("no keys at all: neither the epic nor any slice has one", () => {
  const ledger = buildLedger(rich);
  const facts = ledgerFacts(ledger);
  assert.equal(facts.sliceKeys, 0);
  assert.equal(facts.epicKeys, 0);
  assert.deepEqual(ledger[0].key, { kind: "none" });
  assert.ok(ledger[0].slices.every((s) => s.key.kind === "none" && s.ownKey === null));
});

test("some keys: a slice's own key, and the other inherits the epic's", () => {
  const ledger = buildLedger(status);
  assert.deepEqual(ledger[0].key, { kind: "own", key: "TEAM-2" });
  assert.deepEqual(ledger[0].slices[0].key, { kind: "own", key: "TEAM-12" });
  assert.equal(ledger[0].slices[0].ownKey, "TEAM-12");
  assert.deepEqual(ledger[0].slices[1].key, { kind: "inherited", key: "TEAM-2", from: "EPIC-001" });
  assert.equal(ledger[0].slices[1].ownKey, null);
  assert.deepEqual(ledgerFacts(ledger), { epics: 1, slices: 2, sliceKeys: 1, epicKeys: 1 });
});

test("the epic's key and each slice's own key come from status, read as given", () => {
  assert.deepEqual(epicKey(status.epics[0]), { kind: "own", key: "TEAM-2" });
  assert.deepEqual(epicKey(rich.epics[0]), { kind: "none" });
  assert.deepEqual(sliceKey(status.slices[0], { kind: "own", key: "TEAM-2" }, "EPIC-001"), { kind: "own", key: "TEAM-12" }, "a slice's own key wins");
  assert.deepEqual(sliceKey(status.slices[1], { kind: "none" }, "EPIC-001"), { kind: "none" });
});

test("slices in the product manager's order, each under its epic, with the engine's editable word", () => {
  const ledger = buildLedger(rich);
  assert.deepEqual(
    ledger.map((e) => [e.id, e.slices.map((s) => s.id)]),
    [
      ["EPIC-001", ["SLICE-001", "SLICE-002", "SLICE-003", "SLICE-004", "SLICE-006", "SLICE-007"]],
      ["EPIC-002", ["SLICE-008"]],
    ],
  );
  const reordered = { ...rich, order: [{ ...rich.order[0], slices: [...rich.order[0].slices].reverse() }, rich.order[1]] };
  assert.equal(buildLedger(reordered)[0].slices[0].id, "SLICE-007");
  assert.equal(ledger[0].slices[0].editable, false);
});

test("a slice the order does not name still appears, after the ordered ones", () => {
  const partial = { ...rich, order: [{ ...rich.order[0], slices: rich.order[0].slices.slice(1) }, rich.order[1]] };
  assert.equal(buildLedger(partial)[0].slices.at(-1).id, "SLICE-001");
});

test("a slice in the order but not in this workspace is not offered", () => {
  const withRemote = { ...status, order: [{ ...status.order[0], slices: [...status.order[0].slices, { slice_id: "SLICE-099", title: null, in_workspace: false, issue: 99, state_label: null }] }] };
  assert.deepEqual(buildLedger(withRemote)[0].slices.map((s) => s.id), ["SLICE-001", "SLICE-002"]);
});

/* ── The engine's link answers ────────────────────────────────────────── */

test("epic.link names the epic's key, and the slices already marked ready that keep the old one", () => {
  assert.equal(fixture("epic.link").epic.tracking.jira, "TEAM-1");
  assert.deepEqual(fixture("epic.link").already_ready, []);
  const ready = fixture("epic.link.already-ready");
  assert.equal(ready.epic.tracking.jira, "TEAM-5");
  assert.deepEqual(ready.already_ready, ["SLICE-001"]);
  assert.equal(fixture("epic.link.remove").epic.tracking, undefined);
});

test("a key not in Jira's form is the engine's refusal, shown as written", () => {
  assert.match(refusal("slice.link.refused-form"), /is not a Jira issue key/);
});

/* ── The export ──────────────────────────────────────────────────────── */

test("export arguments: drafts off by default, everything, Cloud", () => {
  assert.deepEqual(exportArgs({ flavour: "cloud", scope: "all", drafts: false }), { flavour: "cloud", state: "ready" });
  assert.deepEqual(exportArgs({ flavour: "data-center", scope: "EPIC-002", drafts: true }), { flavour: "data-center", state: "all", epic: "EPIC-002" });
});

const offered = (data) => ({
  ...data,
  downloads: [
    { name: "mach-jira.csv", url: "/api/downloads/AbC123_-x/mach-jira.csv", bytes: 812 },
    { name: "README.txt", url: "/api/downloads/AbC123_-x/README.txt", bytes: 2048 },
  ],
});

test("nothing to export: the file is empty and every item left out is listed, by name, with the engine's reason", () => {
  const summary = exportSummary(offered(fixture("jira.export")), namesFrom(status));
  assert.equal(summary.empty, true);
  assert.deepEqual(summary.inJira, [{ id: "SLICE-001", name: "Invite a teammate", jira: "TEAM-12" }]);
  assert.deepEqual(
    summary.leftOut.map((i) => [i.id, i.name]),
    [
      ["SLICE-002", "Remove a teammate"],
      ["EPIC-001", "Team membership"],
    ],
  );
  assert.match(summary.leftOut[0].reason, /not marked ready yet/);
  assert.match(summary.note, /Nothing to export/);
});

test("exported: counts in words, the items already in Jira, and the host's two download links", () => {
  const summary = exportSummary(offered(fixture("jira.export.all")), namesFrom(status));
  assert.equal(summary.empty, false);
  assert.equal(summary.flavour, "data-center");
  assert.equal(fileContents(summary.epics, summary.stories), "no epics and 1 story");
  assert.deepEqual(
    summary.inJira.map((i) => [i.id, i.jira]),
    [
      ["SLICE-001", "TEAM-12"],
      ["EPIC-001", "TEAM-2"],
    ],
  );
  assert.deepEqual(
    summary.downloads.map((d) => d.name),
    ["mach-jira.csv", "README.txt"],
  );
});

test("a cut description is listed by name", () => {
  const summary = exportSummary(offered(fixture("jira.export.cut")), namesFrom(status));
  assert.deepEqual(summary.cut, [{ id: "SLICE-002", name: "Remove a teammate" }]);
});

test("only the host's own download links are offered", () => {
  assert.equal(isHostDownload("/api/downloads/AbC123/mach-jira.csv"), true);
  assert.equal(isHostDownload("data:text/plain;charset=utf-8,Development%20fixture"), true);
  for (const url of ["https://jira.example.com/x.csv", "//evil.example/x", "/api/downloads/../ops/x", "javascript:alert(1)", "/api/downloads/a/b/c.csv", "data:text/html,<b>x</b>"]) {
    assert.equal(isHostDownload(url), false, url);
  }
  const summary = exportSummary({ ...fixture("jira.export.all"), downloads: [{ name: "x.csv", url: "https://jira.example.com/x.csv", bytes: 1 }] }, {});
  assert.deepEqual(summary.downloads, []);
});

test("counts in words", () => {
  assert.equal(fileContents(1, 3), "1 epic and 3 stories");
  assert.equal(fileContents(2, 1), "2 epics and 1 story");
  assert.equal(fileContents(0, 0), "no epics and no stories");
});

test("the README's essentials differ per Jira and name the GitHub issue field", () => {
  const cloud = readmeEssentials("cloud");
  const dc = readmeEssentials("data-center");
  assert.match(cloud.screen[0], /Settings, then System, then External System Import/);
  assert.match(dc.screen[0], /cog menu/);
  assert.match(cloud.field, /GitHub issue/);
  assert.equal(cloud.after.length, 3);
  for (const line of [...cloud.screen, ...dc.screen, cloud.field, ...cloud.after]) assert.doesNotMatch(line, /https?:/, "no address outside the app");
});

/* ── The keys back ───────────────────────────────────────────────────── */

test("a dry run: what would be linked, rows not matched and refused by number, and nothing changed", () => {
  const summary = keysSummary(fixture("jira.keys.dry-run"), namesFrom(status));
  assert.equal(summary.dryRun, true);
  assert.equal(summary.rowsRead, 4);
  assert.deepEqual(summary.link, [{ id: "SLICE-002", name: "Remove a teammate", jira: "TEAM-30" }]);
  assert.equal(wouldRecord(summary), true);
  assert.deepEqual(summary.unmatched.map((r) => r.where), ["Row 3"]);
  assert.deepEqual(
    summary.refused.map((r) => [r.where, r.item?.id]),
    [
      ["Row 5", "EPIC-001"],
      ["Row 4", "SLICE-001"],
    ],
  );
  assert.match(summary.note, /^Would link/);
});

test("a refused malformed key is never shown: only the row, the item and the engine's reason", () => {
  const summary = keysSummary(fixture("jira.keys.dry-run"), namesFrom(status));
  const malformed = summary.refused[0];
  assert.deepEqual(Object.keys(malformed).sort(), ["item", "reason", "where"]);
  assert.match(malformed.reason, /not in Jira's form/);
});

test("applied: what was recorded", () => {
  const summary = keysSummary(fixture("jira.keys"), namesFrom(status));
  assert.equal(summary.dryRun, false);
  assert.match(summary.note, /^Linked 1 item/);
});

test("slices to reopen first, and epics with slices already marked ready, are named", () => {
  const summary = keysSummary(fixture("jira.keys.reopen"), namesFrom(status));
  assert.deepEqual(summary.link.map((l) => [l.id, l.jira]), [["EPIC-001", "TEAM-5"]]);
  assert.deepEqual(summary.reopen.map((r) => [r.id, r.name, r.jira]), [["SLICE-001", "Invite a teammate", "TEAM-6"]]);
  assert.doesNotMatch(summary.reopen[0].reason, /jira keys|slice link|--jira/, "the app's wording names no command");
  assert.deepEqual(summary.epicsWithReady, [{ id: "EPIC-001", name: "Team membership", slices: [{ id: "SLICE-001", name: "Invite a teammate" }] }]);
});

test("rows in words", () => {
  assert.equal(rowWords({ row: 3, reason: "" }), "Row 3");
  assert.equal(rowWords({ rows: [4, 7], reason: "" }), "Rows 4 and 7");
  assert.equal(rowWords({ rows: [2, 4, 9], reason: "" }), "Rows 2, 4 and 9");
  assert.equal(rowWords({ id: "SLICE-001", reason: "" }), null);
});

test("an item's label is its ID and its title, or the ID alone", () => {
  assert.equal(label({ id: "SLICE-001", name: "Invite a teammate" }), "SLICE-001 Invite a teammate");
  assert.equal(label({ id: "SLICE-009", name: null }), "SLICE-009");
});

/* ── The page's parts (M16 layout) ───────────────────────────────────── */

test("the part open on arrival: the export until anything has a key, then the keys", () => {
  assert.equal(jiraOpenPart(ledgerFacts(buildLedger(status))), "keys");
  assert.equal(jiraOpenPart({ epics: 1, slices: 2, sliceKeys: 0, epicKeys: 0 }), "export");
  assert.equal(jiraOpenPart({ epics: 1, slices: 2, sliceKeys: 0, epicKeys: 1 }), "keys");
});

test("each part's row says its state in words", () => {
  assert.equal(keysPartSummary(ledgerFacts(buildLedger(status))), "1 epic, 2 slices, 1 slice with a key of its own");
  assert.equal(exportPartSummary(null), "One CSV file and a README for Jira's importer. Not exported on this visit.");
  assert.equal(exportPartSummary(exportSummary(offered(fixture("jira.export")), namesFrom(status))), "Exported: nothing to export");
  assert.equal(exportPartSummary(exportSummary(offered(fixture("jira.export.all")), namesFrom(status))), `Exported: the file holds ${fileContents(fixture("jira.export.all").counts.epics, fixture("jira.export.all").counts.stories)}`);
});

test("bringing the keys back: the row says what a try found and that nothing has changed, then what was recorded", () => {
  const names = namesFrom(status);
  assert.equal(keysBackSummary({ chosen: false, trial: null, applied: null }), "No file chosen yet");
  assert.equal(keysBackSummary({ chosen: true, trial: null, applied: null }), "A file is chosen: try it without changing anything");
  const trial = keysSummary(fixture("jira.keys.dry-run"), names);
  assert.equal(keysBackSummary({ chosen: true, trial, applied: null }), "Tried, nothing changed yet: would link 1 key, 1 not matched, 2 refused");
  const applied = keysSummary(fixture("jira.keys"), names);
  assert.match(keysBackSummary({ chosen: true, trial: null, applied }), /^Recorded: \d+ keys? linked/);
  const reopen = keysSummary(fixture("jira.keys.reopen"), names);
  assert.match(keysBackSummary({ chosen: true, trial: reopen, applied: null }), / to reopen first/);
});

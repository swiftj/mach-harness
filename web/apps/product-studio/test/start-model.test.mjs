// Unit tests for starting a project from nothing (M19): the ways the start screen offers, where a way already started
// stands, and the step a way that needs the project is at (src/features/home/start/model.ts), against the real engine
// answers in an empty project (web/fixtures/start_memory.py). Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { prdNeedsTheProduct, prdStands, requestStep, requestsToStartFrom, startedWays, ways } from "../src/features/home/start/model.ts";
import { applyPlan, applySummary, prdCommand } from "../src/features/prd/model.ts";
import empty from "../../../fixtures/status.start-empty.json" with { type: "json" };
import prdImported from "../../../fixtures/status.start-prd-imported.json" with { type: "json" };
import prdMapped from "../../../fixtures/status.start-prd-mapped.json" with { type: "json" };
import prdSettled from "../../../fixtures/status.start-prd-settled.json" with { type: "json" };
import prdAndIdea from "../../../fixtures/status.start-prd-and-idea.json" with { type: "json" };
import ideaOnly from "../../../fixtures/status.start-idea.json" with { type: "json" };
import made from "../../../fixtures/status.start-made.json" with { type: "json" };
import requestNamed from "../../../fixtures/status.start-request-named.json" with { type: "json" };
import requestEpic from "../../../fixtures/status.start-request-epic.json" with { type: "json" };
import requestsEmpty from "../../../fixtures/status.start-requests.json" with { type: "json" };
import requestList from "../../../fixtures/request.list.start.json" with { type: "json" };
import statusMapped from "../../../fixtures/prd.status.start-mapped.json" with { type: "json" };
import statusSettled from "../../../fixtures/prd.status.start-settled.json" with { type: "json" };
import statusApplied from "../../../fixtures/prd.status.start-applied.json" with { type: "json" };
import refusedNoProject from "../../../fixtures/prd.apply.refused-no-project.json" with { type: "json" };
import projectInit from "../../../fixtures/project.init.start.json" with { type: "json" };

test("the engine needs the project only to make drafts: a PRD is imported, mapped and settled without one", () => {
  for (const run of [prdImported, prdMapped, prdSettled, prdAndIdea]) assert.equal(run.data.project, null);
  assert.equal(statusSettled.data.can_apply, true);
  assert.deepEqual(refusedNoProject.hint, { kind: "define_project", target: null });
  assert.equal(refusedNoProject.refused, "No project yet. Define the project first.");
});

test("the ways are every way to start, each saying what happens and what is needed, in the app's words", () => {
  assert.deepEqual(
    ways.map((w) => w.id),
    ["describe", "prd", "idea", "request", "import"],
  );
  const forbidden = /on-ramp|onramp|\bengine\b|light path|\bkind\b|\bscript\b|architecture|\bsubmit\b/i;
  for (const way of ways) {
    for (const text of [way.title, way.happens, way.needs, way.action]) {
      assert.ok(text.trim(), `${way.id} has every part`);
      assert.doesNotMatch(text, forbidden, `${way.id}: ${text}`);
      // No all-caps word except MACH, PRD and PDF, and no exclamation marks.
      for (const word of text.match(/\b[A-Z]{2,}\b/g) ?? []) assert.ok(["MACH", "PRD", "PDF"].includes(word), `${way.id}: ${word}`);
      assert.doesNotMatch(text, /!/);
    }
    assert.match(way.happens, /\.$/, `${way.id} says what happens in full sentences`);
    // Read after "You need ".
    assert.match(way.needs, /^[a-z]/, `${way.id}'s needs continue "You need "`);
  }
  assert.match(ways.find((w) => w.id === "prd").needs, /Markdown or plain-text file/);
  assert.match(ways.find((w) => w.id === "prd").happens, /MACH reads the document/);
});

test("nothing started: the start screen alone", () => {
  assert.deepEqual(startedWays(empty.data), []);
  assert.deepEqual(startedWays(requestsEmpty.data), []);
});

test("a PRD started says where it stands, from the engine's summary only", () => {
  const [imported] = startedWays(prdImported.data);
  assert.deepEqual({ ...imported, stands: undefined }, { kind: "prd", id: "PRD-01", name: "team-space.md", stands: undefined, to: "/prds/PRD-01", action: "Continue with PRD-01" });
  assert.equal(imported.stands, "Imported. Next, MACH proposes its map of epics and thin slices.");
  const [mapped] = startedWays(prdMapped.data);
  assert.equal(mapped.stands, `Its map is recorded. ${prdMapped.data.prds[0].not_covered.length} sections no slice covers still need your word.`);
  assert.equal(startedWays(prdSettled.data)[0].stands, "Its map is recorded and settled. Next, name the product and make the drafts.");
  assert.match(prdStands({ ...prdSettled.data.prds[0], not_covered: [4] }), /^Its map is recorded\. 1 section no slice covers still needs your word\.$/);
  assert.match(prdStands({ ...prdSettled.data.prds[0], document_matches: false }), /no longer matches/);
});

test("an idea started leads to its next step; a PRD the drafts were made from is no longer a way in progress", () => {
  const rows = startedWays(prdAndIdea.data);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id]),
    [
      ["prd", "PRD-01"],
      ["idea", "IDEA-001"],
    ],
  );
  const idea = startedWays(ideaOnly.data);
  assert.equal(idea.length, 1);
  assert.equal(idea[0].to, "/shape/ideas/IDEA-001/explore");
  assert.equal(idea[0].stands, ideaOnly.data.ideas.ideas[0].next.sentence);
  assert.equal(idea[0].name, "Let members renew a loan themselves");
  // Drafts made: the PRD is no longer in progress (and the project exists, so the home takes over); the idea still is.
  assert.deepEqual(
    startedWays(made.data).map((r) => r.id),
    ["IDEA-001"],
  );
});

test("the PRD's page asks to name the product only when the drafts are all that is left and there is no project", () => {
  assert.equal(prdNeedsTheProduct(statusSettled.data, null), true);
  assert.equal(prdNeedsTheProduct(statusSettled.data, projectInit.data.project), false);
  assert.equal(prdNeedsTheProduct(statusMapped.data, null), false, "sections still to settle come first");
  assert.equal(prdNeedsTheProduct(statusApplied.data, null), false);
  const plan = applyPlan(statusSettled.data.map, () => null);
  assert.equal(applySummary(statusSettled.data, plan, true), "Name the product, then make 1 epic and 2 draft slices");
  assert.equal(applySummary(statusSettled.data, plan, false), "Ready to make 1 epic and 2 draft slices");
  assert.equal(applySummary(statusMapped.data, plan, true), applySummary(statusMapped.data, plan), "what blocks it is said first");
});

test("a request is started in three steps: the product, its epic, then picking it up", () => {
  assert.equal(requestStep(empty.data), "name");
  assert.equal(requestStep(requestNamed.data), "epic");
  assert.equal(requestStep(requestEpic.data), "pick");
  assert.equal(requestStep({ ...requestEpic.data, epics: requestEpic.data.epics.map((e) => ({ ...e, status: "deferred" })) }), "epic", "a deferred epic does not count");
});

test("only requests that count and are not picked up here are offered", () => {
  const items = requestList.data.requests.items;
  assert.equal(requestsToStartFrom(items).length, items.length);
  assert.deepEqual(requestsToStartFrom([{ ...items[0], picked_up_here: true }, { ...items[1], state: "not_accepted" }, { ...items[1], idea_template: true }]), []);
  assert.deepEqual(requestsToStartFrom(null), []);
});

test("naming the product asks for no project ID: MACH makes it from the name", async () => {
  const { readFile } = await import("node:fs/promises");
  const form = await readFile(new URL("../src/features/vision/ProjectForm.tsx", import.meta.url), "utf8");
  assert.ok(!form.includes("Project ID"), "the form has no Project ID field");
  assert.ok(/act\.run\("project\.init", \{ name: /.test(form), "project.init is sent without an id");
});

test("the command that proposes a PRD's map in Claude Code follows the install", () => {
  assert.equal(prdCommand("/mach:studio continue", "PRD-01"), "/mach:studio start from PRD-01");
  assert.equal(prdCommand("/mach-studio continue", "PRD-02"), "/mach-studio start from PRD-02");
  assert.equal(prdCommand("/mach:studio", "PRD-01"), null);
  assert.equal(prdCommand("two words continue", "PRD-01"), null);
  assert.equal(prdCommand(null, "PRD-01"), null);
});

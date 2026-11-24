// Unit tests for Shape's shell (src/features/shape/shell/steps.ts): where each of the engine's next steps for an idea
// leads, the stepper's words, the breadcrumb, and the home's "Next in Shape", against the real fixtures. Also that
// every Shape fixture the app shows carries the app's wording: no terminal command or option (status.suggested_next is
// the terminal skill's own form, which the app never shows, as before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  firstWithANextStep,
  ideaPath,
  nextPathOf,
  shapeBreadcrumb,
  shapeSteps,
  stepCaption,
  stepForNext,
  stepOfPath,
} from "../src/features/shape/shell/steps.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const shapeFixtures = readdirSync(folder).filter((f) => /^(idea|brief|case|verdict|lookback)\.|^(status|refresh)\.ideas/.test(f)).map((f) => f.slice(0, -5));

test("every next step the engine can name for an idea leads to one of the six steps", () => {
  const sources = ["shape.py", "shape_route.py"].map((f) => readFileSync(new URL(`../../../../skills/studio/scripts/${f}`, import.meta.url), "utf8")).join("\n");
  const kinds = [...new Set([...sources.matchAll(/step\("([a-z_]+)"/g)].map((m) => m[1]))].filter((k) => !["labels", "issue", "state", "verdict"].includes(k));
  assert.ok(kinds.includes("look_back") && kinds.includes("record_verdict") && kinds.includes("apply"), kinds.join(","));
  const known = { explore: "explore", write_brief: "explore", check_brief: "brief", record_verdict: "case", publish: "case", renumber: "case", size: "route", map: "route", settle: "route", apply: "route", look_back: "look-back" };
  for (const kind of kinds) {
    if (kind === "none") continue;
    assert.equal(stepForNext(kind, "decided"), known[kind], kind);
  }
  assert.equal(stepForNext("none", "shaped"), "look-back");
  assert.equal(stepForNext("something_new", "new"), "explore", "an unknown kind goes by the stage");
});

test("each idea on the real board opens at the step that holds its next step", () => {
  const board = run("status.ideas").data.ideas;
  const steps = Object.fromEntries(board.ideas.map((row) => [row.idea_id, nextPathOf(row).split("/").pop()]));
  assert.deepEqual(steps, {
    "IDEA-001": "explore", // new: explore it
    "IDEA-002": "brief", // exploring, its brief does not pass
    "IDEA-003": "case", // brief written: record the verdict
    "IDEA-004": "case", // No, never saved: publish
    "IDEA-005": "case",
    "IDEA-006": "route", // a Go never saved: sizing comes next, and saving stays optional
    "IDEA-007": "brief", // a change: its starter brief
    "IDEA-008": "look-back", // shaped: nothing to do until a slice ships
  });
  for (const row of board.ideas) assert.equal(stepOfPath(nextPathOf(row)).ideaId, row.idea_id);
  assert.equal(ideaPath("IDEA-002"), "/shape/ideas/IDEA-002");
});

test("the stepper's words are the engine's facts, and say nothing it did not report", () => {
  const rows = Object.fromEntries(run("status.ideas").data.ideas.ideas.map((row) => [row.idea_id, row]));
  const captions = (row) => Object.fromEntries(shapeSteps.map(({ step }) => [step, stepCaption(step, row, 8)]));
  assert.deepEqual(captions(rows["IDEA-001"]), { ideas: "8 on the board", explore: "New", brief: "Not written yet", case: "Not written yet", route: "Not sized yet", "look-back": null });
  assert.equal(stepCaption("brief", rows["IDEA-002"], 8), "Does not pass yet");
  assert.equal(stepCaption("brief", rows["IDEA-003"], 8), "Passes its check");
  assert.equal(stepCaption("case", rows["IDEA-004"], 8), "No");
  assert.equal(stepCaption("case", rows["IDEA-005"], 8), "Not now");
  assert.equal(stepCaption("route", rows["IDEA-008"], 8), "One slice");
  const stale = run("status.ideas-stale-verdict").data.ideas.ideas[0];
  assert.equal(stepCaption("case", stale, 1), "Verdict no longer holds");
  const lookBack = run("status.ideas-look-back").data.ideas.ideas[0];
  assert.equal(stepCaption("look-back", lookBack, 1), "Ready to look back");
  assert.equal(nextPathOf(lookBack), "/shape/ideas/IDEA-001/look-back");
});

test("the breadcrumb names Shape, the idea and the step; other pages are left alone", () => {
  const status = run("status.ideas").data;
  assert.deepEqual(shapeBreadcrumb("/shape", status), ["Shape"]);
  assert.deepEqual(shapeBreadcrumb("/shape/ideas/IDEA-003/case", status), ["Shape", "Reserve a study room online", "The case"]);
  assert.deepEqual(shapeBreadcrumb("/shape/ideas/IDEA-099/brief", status), ["Shape", "IDEA-099", "The brief"]);
  assert.deepEqual(shapeBreadcrumb("/shape/change", null), ["Shape", "Change what exists"]);
  assert.equal(shapeBreadcrumb("/slices/SLICE-001", status), null);
});

test("the home shows Shape's next step only where the engine's status gives one", () => {
  assert.equal(run("status.rich").data.ideas, undefined, "a project that never opened Shape has no ideas field at all");
  assert.equal(firstWithANextStep(run("status.ideas").data.ideas.ideas).idea_id, "IDEA-001");
  assert.equal(firstWithANextStep(run("status.ideas-shaped").data.ideas.ideas), null, "a shaped idea with nothing shipped waits");
});

test("every Shape fixture is in the app's wording: no terminal command or option", () => {
  assert.ok(shapeFixtures.length > 80, `${shapeFixtures.length} Shape fixtures`);
  const banned = /studio\.py|(^|\s)--[a-z]|\b(idea (add|list|show|stage|lookups|publish|renumber|size|map|settle|map-status|apply|change|chain)|brief (check|show)|case (show|check)|verdict record|lookback record) [A-Z]/;
  const words = (value, key = "") =>
    typeof value === "string"
      ? ["note", "sentence", "why", "next", "refused", "stale_note", "verdict_note", "rule", "basis", "not_determined_note", "brief_note", "why_folder", "why_no_login"].includes(key) ||
        key === "" ? [value] : []
      : Array.isArray(value)
        ? value.flatMap((item) => words(item, key === "errors" || key === "warnings" || key === "blockers" || key === "missing" ? "note" : ""))
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([k, v]) => (k === "fenced" || k === "text" || k === "suggested_next" ? [] : words(v, k)))
          : [];
  for (const name of shapeFixtures) {
    const fixture = run(name);
    for (const text of [...words(fixture.data, "data"), ...(fixture.refused ? [fixture.refused] : [])]) {
      assert.doesNotMatch(text, banned, `${name}: ${text.slice(0, 160)}`);
    }
  }
});

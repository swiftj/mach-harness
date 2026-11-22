// Unit tests for a small change in the app (M18, src/features/small-change/): the start's arguments, the rules a fix may
// name, the label and the line on a slice that became a full slice, on the real fixtures (web/fixtures/small_memory.py);
// that every place a slice is started offers a small change and every listing carries the label; and the wording.
// Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  FIXABLE_RULE,
  MISSING_WORDS,
  NEVER_SAID,
  SMALL_CHANGE_GROWS,
  SMALL_CHANGE_MEANS,
  canWiden,
  changeOptions,
  fullSlice,
  isMadeFullAtReady,
  madeFullAtReady,
  rulesToFix,
  smallArgs,
  smallLabel,
  smallState,
  startOptions,
  widenProblem,
  widenedLine,
} from "../src/features/small-change/model.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the start's arguments are the host's `small` object, and nothing for a full slice", () => {
  assert.deepEqual(smallArgs(fullSlice), {});
  assert.deepEqual(smallArgs({ as: "slice", change: "fix", rule: "SLICE-001/FR-02" }), {}, "a full slice carries no small change, whatever was chosen before");
  assert.deepEqual(smallArgs({ as: "small", change: null, rule: null }), { missing: "change" });
  assert.deepEqual(smallArgs({ as: "small", change: "adjustment", rule: "SLICE-001/FR-02" }), { small: { change: "adjustment" } }, "an adjustment names no rule");
  assert.deepEqual(smallArgs({ as: "small", change: "fix", rule: null }), { missing: "rule" });
  assert.deepEqual(smallArgs({ as: "small", change: "fix", rule: "SLICE-001/AC-01" }), { missing: "rule" });
  assert.deepEqual(smallArgs({ as: "small", change: "fix", rule: "SLICE-001/FR-02" }), { small: { change: "fix", rule: "SLICE-001/FR-02" } });
  for (const good of ["SLICE-001/FR-02", "SLICE-012/INV-04", "SLICE-001/R2"]) assert.ok(FIXABLE_RULE.test(good), good);
  for (const bad of ["SLICE-1/FR-02", "SLICE-001/AC-01", "FR-02", "SLICE-001/FR-02 --id=SLICE-009", ""]) assert.ok(!FIXABLE_RULE.test(bad), bad);
  // The engine's real answers to what the app sends.
  assert.deepEqual(run("slice.new.small").data.slice.small, { change: "adjustment", shipped_rule: null });
  assert.deepEqual(run("slice.new.small-fix").data.slice.small, { change: "fix", shipped_rule: "SLICE-001/FR-02" });
  assert.equal(run("request.pick.small").data.slice.kind, "small");
  assert.match(run("slice.new.refused-small-not-in-force").refused, /is not a shipped rule in force/);
});

test("a fix chooses from the rules shipped in the epic, and the engine starts one with the rule chosen", () => {
  const rules = rulesToFix(run("epic.current.small").data);
  assert.deepEqual(rules.map((r) => r.rule), ["SLICE-001/INV-01", "SLICE-001/FR-01", "SLICE-001/FR-02", "SLICE-001/R1", "SLICE-001/R2"]);
  assert.ok(rules.every((r) => FIXABLE_RULE.test(r.rule)));
  const chosen = rules.find((r) => r.rule === run("slice.new.small-fix").data.slice.small.shipped_rule);
  assert.match(chosen.text, /expire an invitation after 14 days/);
  assert.deepEqual(rulesToFix(run("epic.current.nothing-shipped").data), [], "nothing shipped: nothing to fix");
  assert.deepEqual(rulesToFix(null), []);
});

test("the label: a small change while it is one, nothing for a full slice or once it became one", () => {
  const rows = Object.fromEntries(run("status.small-changes").data.slices.map((r) => [r.title, r]));
  assert.equal(smallState(rows["Clearer expired invitation message"]), "small");
  assert.equal(smallState(rows["Expire invitations after 14 days again"]), "small");
  assert.equal(smallState(rows["Help text on the expired invitation page"]), "full");
  assert.equal(smallState(rows["Shorter reminder wording"]), "full");
  assert.equal(smallState(rows["Invite a teammate"]), null);
  assert.deepEqual(smallLabel(rows["Clearer expired invitation message"]), { word: "Small change", description: SMALL_CHANGE_MEANS });
  assert.equal(smallLabel(rows["Shorter reminder wording"]), null);
  assert.equal(smallLabel(rows["Invite a teammate"]), null);
  // The work order says the same.
  assert.equal(smallState(run("slice.show.small").data.slice), "small");
  assert.equal(smallState(run("slice.show.small-widened").data.slice), "full");
  assert.equal(smallState(run("slice.show.small-ready").data.slice), "small");
  assert.equal(smallState(run("slice.show.ready").data.slice), null, "a slice from before M18 carries no field");
});

test("the line on a slice that became a full slice: the rule's sentence, or the product manager's words, and when", () => {
  const byRule = widenedLine(run("slice.show.small-widened").data.slice.widened);
  assert.equal(byRule.lead, "This began as a small change and is now a full slice.");
  assert.equal(byRule.byRule, true);
  assert.equal(byRule.reason, "This is not a small change: a small change has at most 3 functional requirements, and this one has more.");
  assert.match(byRule.at, /^\d{4}-\d\d-\d\dT/);
  const asked = widenedLine(run("slice.show.small-widened-asked").data.slice.widened);
  assert.equal(asked.byRule, false);
  assert.equal(asked.reason, "It should also change the reminder email, which is a second message.");
  // The check that widened it said so once; the widen act's answer carries the same record.
  assert.equal(run("slice.check.small-widened").data.small_change.widened_now, true);
  assert.deepEqual(run("slice.widen").data.slice.widened, run("slice.widen").data.small_change.widened);
});

test("making it a full slice: offered on an editable small change only, with a reason in the person's words", () => {
  const drafting = run("slice.show.small-drafting").data;
  assert.equal(canWiden(drafting.slice, drafting.editable), true);
  const ready = run("slice.show.small-ready").data;
  assert.equal(canWiden(ready.slice, ready.editable), false, "a slice marked ready is reopened first");
  const widened = run("slice.show.small-widened-asked").data;
  assert.equal(canWiden(widened.slice, widened.editable), false);
  assert.equal(canWiden(run("slice.show.ready").data.slice, true), false);
  assert.ok(widenProblem("   "));
  assert.ok(widenProblem("x".repeat(301)));
  assert.equal(widenProblem("It also changes the reminder email."), null);
  assert.match(run("slice.widen.refused-full").refused, /is not a small change/);
});

test("marking a small change ready can make it a full slice instead: said plainly, neither a success nor a failure", () => {
  const answer = run("slice.ready.small-widened");
  assert.equal(answer.exit_code, 0);
  assert.equal(isMadeFullAtReady(answer.data), true);
  assert.equal(isMadeFullAtReady(run("slice.ready.small").data), false);
  assert.equal(isMadeFullAtReady(run("slice.ready").data), false);
  const said = madeFullAtReady(answer.data);
  assert.match(said.title, /^SLICE-\d{3} was not marked ready$/);
  assert.match(said.lead, /full slice now/);
  assert.match(said.lead, /Nothing was saved/);
  assert.equal(said.sentence, "This is not a small change: a small change is Low or Medium risk, and this one is High.");
  assert.match(said.next, /Carry on the conversation/);
  assert.match(said.next, /mark it ready again/);
  // Nothing was approved: the slice is not approved and is still editable.
  const shown = run("slice.show.small-widened-at-ready").data;
  assert.notEqual(shown.slice.status, "approved_for_engineering");
  assert.equal(shown.editable, true);
  assert.equal(shown.slice.widened.rule, "risk");
  // The dialog narrows the answer before treating it as saved, and the well uses neither the success nor the danger tone.
  const acts = source("features/spec/SliceActs.tsx");
  assert.ok(acts.indexOf("isMadeFullAtReady(result)") < acts.indexOf("rememberReadyAnswer(result)"));
  assert.match(acts, /<MadeFullAtReady answer=\{madeFull\} \/>/);
  assert.match(acts, /Continue the interview/);
  const well = source("features/small-change/MadeFullAtReady.tsx");
  assert.doesNotMatch(well, /tone="(success|danger)"|(text|bg|border)-(success|danger)|CircleCheck|CircleAlert/);
});

test("every place a slice is started offers a small change", () => {
  const dialog = source("features/roadmap/NewSliceDialog.tsx");
  assert.match(dialog, /<StartChoiceFields /);
  assert.match(dialog, /small: args\.small/);
  const pick = source("features/inbox/requests/RequestDialogs.tsx");
  assert.match(pick, /<StartChoiceFields /);
  assert.match(pick, /small: smallStart\.small/);
  // Each "Start a slice" button has a "Start a small change" beside it, opening the same dialog on a small change.
  for (const path of ["features/roadmap/RoadmapScreen.tsx", "features/roadmap/NodeSheet.tsx", "features/home/HomeScreen.tsx", "features/vision/VisionScreen.tsx"]) {
    const text = source(path);
    assert.match(text, /Start a small change/, path);
    assert.match(text, /"small"/, path);
  }
  // Every NewSliceDialog that a screen opens takes the start it was asked for (AppHint's offers the choice inside).
  for (const path of ["features/roadmap/RoadmapScreen.tsx", "features/home/HomeScreen.tsx", "features/vision/VisionScreen.tsx"]) {
    assert.match(source(path), /start=\{newSlice\?\.start\} \/>/, path);
  }
  const fields = source("features/small-change/StartChoiceFields.tsx");
  assert.match(fields, /useOperation\("epic\.current"/, "a fix's rules are read from how the epic works today");
});

test("a small change is labelled wherever a slice is listed or named", () => {
  for (const path of [
    "shared/SliceContextRow.tsx",
    "features/home/HomeScreen.tsx",
    "features/roadmap/NodeSheet.tsx",
    "features/inbox/OpenQuestionsCard.tsx",
    "features/activity/GithubScreen.tsx",
    "features/interview/SliceDocument.tsx",
  ]) {
    assert.match(source(path), /<SmallChangeLabel slice=/, path);
  }
  const label = source("features/small-change/SmallChangeLabel.tsx");
  assert.match(label, /<Feather /, "a glyph, not colour alone");
  assert.match(label, /label\.word/);
  assert.match(source("features/spec/SpecScreen.tsx"), /<SmallChangeNotice show=\{show\}/);
});

test("the wording: small change and full slice; never the light path, the engine, a kind or a script", () => {
  const said = [
    SMALL_CHANGE_MEANS,
    SMALL_CHANGE_GROWS,
    ...Object.values(MISSING_WORDS),
    ...startOptions.flatMap((o) => [o.label, o.description]),
    ...changeOptions.flatMap((o) => [o.label, o.description]),
    widenedLine({ at: "2026-11-22T10:00:00Z", reason: "R.", rule: null }).lead,
    ...Object.values(madeFullAtReady({ slice: { slice_id: "SLICE-001" }, small_change: { widened: null } })).filter(Boolean),
  ];
  const files = readdirSync(new URL("../src/features/small-change/", import.meta.url)).filter((f) => f.endsWith(".tsx"));
  // The words a person reads in the components: sentences in string and template literals and JSX text (they start
  // with a capital and have a space; class names, operation names and code do not).
  let sentences = 0;
  for (const file of files) {
    const text = source(`features/small-change/${file}`);
    for (const line of text.split("\n")) {
      if (/^\s*(import|\/\/|\*|\/\*\*)/.test(line)) continue;
      for (const m of line.matchAll(/"([^"]+)"|`([^`]+)`|>([^<>{}]+)</g)) {
        const words = (m[1] ?? m[2] ?? m[3]).trim();
        if (/^[A-Z][^ ]* /.test(words)) {
          said.push(words);
          sentences++;
        }
      }
    }
  }
  assert.ok(sentences >= 15, `only ${sentences} sentences found in the components`);
  for (const words of said) {
    for (const never of NEVER_SAID) assert.doesNotMatch(words, never, `${words}`);
  }
  assert.ok(said.some((w) => /full slice/.test(w)));
  assert.match(SMALL_CHANGE_MEANS, /fewer questions/);
  assert.match(SMALL_CHANGE_MEANS, /shorter spec/);
  assert.match(SMALL_CHANGE_MEANS, /every check in the Factory/);
  assert.match(SMALL_CHANGE_GROWS, /MACH makes it a full slice/);
  // What the engine writes for the interviewer ("left the light path") is never shown: the page writes its own line.
  assert.doesNotMatch(source("features/small-change/SmallChangeNotice.tsx"), /\.note\b/);
});

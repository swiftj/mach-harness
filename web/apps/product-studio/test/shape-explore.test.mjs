// Unit tests for Shape's Explore screen (src/features/shape/explore/model.ts): where the idea came from, what MACH
// looked up in its three groups, the words of a rule, principle and policy by exact ID, the Shape conversation's open
// questions, the terminal command, and the page's states, against the real fixtures. Also that the screen's files hold
// no raw colour, inline style or markup injection, and that its conversation is the interview's own model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  briefWayOn,
  exploreCommand,
  exploreMode,
  lookupsView,
  openQuestion,
  policyFacts,
  principleStatement,
  ruleEpics,
  ruleWords,
  sourceView,
  unfence,
} from "../src/features/shape/explore/model.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8")).data;
const show = (suffix) => run(`idea.show.${suffix}`);
const clone = (value) => JSON.parse(JSON.stringify(value));

test("only the inside of one whole fence is ever shown", () => {
  const request = show("request").source;
  const text = unfence(request.fenced);
  assert.ok(text.startsWith("Email a reminder two days before a loan is due"));
  assert.ok(!text.includes("<<<"), "no marker line is left");
  assert.equal(unfence(show("fault").source.fenced), "TypeError in fines.py\n\nSeen 14 times this week at self-checkout. Stack: fines.py line 88.");
  assert.equal(unfence("just some text"), null);
  assert.equal(unfence("<<<REQUEST-DATA x>>>\nhello\n<<<END-FAULT-DATA y>>>"), null, "a closing marker of another kind is not a fence");
  assert.equal(unfence(undefined), null);
});

test("where each idea came from: the requester's words, an idea issue's five parts, a fault, a rule, or typed", () => {
  const request = sourceView(show("request").source);
  assert.equal(request.words, "From a request");
  assert.equal(request.whose, "The requester's words");
  assert.equal(request.number, 57);
  assert.equal(request.url, "https://github.com/acme/team-space/issues/57");
  assert.match(request.quote, /Please let them renew online/);
  assert.equal(request.parts, null);

  const issue = sourceView(show("exploring").source);
  assert.equal(issue.kind, "idea");
  assert.deepEqual(
    issue.parts.map((p) => [p.heading, p.text]),
    [
      ["Problem", "Renewals take calls."],
      ["Proposed outcome", "Members renew themselves."],
      ["Affected users and systems", "Members and desk staff."],
      ["Constraints", "Same limits as the desk."],
      ["Open questions", "- Who answers when it is refused?"],
    ],
  );
  assert.equal(issue.quote, null, "the parts stand for the whole text");

  const fault = sourceView(show("fault").source);
  assert.equal(fault.ticket, "AUTO-20261120T101500Z");
  assert.equal(fault.whose, "As the fault was reported");
  assert.equal(fault.url, null);

  const change = sourceView(show("change").source);
  assert.equal(change.rule, "SLICE-001/INV-02");
  assert.equal(change.whose, null, "a change has no outside text");
  assert.equal(change.textMissing, false);

  const typed = sourceView(show("go").source);
  assert.equal(typed.words, "Typed by the product manager");
  assert.equal(typed.whose, null);

  const withheld = clone(show("request").source);
  withheld.text_shown = false;
  withheld.url = "https://example.com/not-github";
  const missing = sourceView(withheld);
  assert.equal(missing.quote, null);
  assert.equal(missing.textMissing, true);
  assert.equal(missing.url, null, "only a GitHub address the engine gave is linked");
});

test("nothing looked up yet is said as such, with the three groups empty", () => {
  const view = lookupsView(show("request").lookups);
  assert.equal(view.state, "none");
  assert.equal(view.filled, 0);
  assert.deepEqual(view.groups.map((g) => g.title), ["What exists today", "What is already wanted", "What stands in the way"]);
});

test("lookups in all three groups, as the engine recorded them", () => {
  const view = lookupsView(show("exploring").lookups);
  assert.equal(view.state, "recorded");
  assert.equal(view.filled, 3);
  assert.equal(view.idsOnly, false);
  const [today, wanted, inTheWay] = view.groups;
  assert.deepEqual(today.entries.map((e) => e.rule.rule), ["SLICE-001/FR-01", "SLICE-001/INV-02"]);
  assert.deepEqual(wanted.entries.map((e) => e.key), ["idea-IDEA-001", "request-57"]);
  assert.deepEqual(inTheWay.entries.map((e) => [e.kind, e.key]), [["principle", "principle-PP-01"], ["policy", "policy-POL-privacy-02"]]);
  assert.equal(inTheWay.entries[1].policy.note, "A renewal notice must not leave the EU region.");
  assert.equal(lookupsView(run("idea.lookups").lookups).filled, 3, "idea.lookups' answer reads the same way");
});

test("lookups in one group (a change) and in two groups", () => {
  const change = lookupsView(show("change").lookups);
  assert.equal(change.filled, 1);
  assert.equal(change.groups[0].entries.length, 19);
  assert.match(change.groups[0].entries[0].rule.note, /^The rule to change/);
  assert.deepEqual(change.groups.slice(1).map((g) => g.entries.length), [0, 0]);

  const two = clone(show("exploring").lookups);
  two.items.principles = [];
  two.items.policies = [];
  const view = lookupsView(two);
  assert.equal(view.filled, 2);
  assert.equal(view.groups[2].entries.length, 0);
});

test("without the app's items the identifiers alone are shown, never guessed notes", () => {
  const bare = clone(show("exploring").lookups);
  delete bare.items;
  const view = lookupsView(bare);
  assert.equal(view.idsOnly, true);
  assert.deepEqual(view.groups[0].entries.map((e) => [e.rule.rule, e.rule.note]), [["SLICE-001/FR-01", undefined], ["SLICE-001/INV-02", undefined]]);
  assert.deepEqual(view.groups[1].entries.map((e) => e.similar), [{ idea: "IDEA-001" }, { request: 57 }]);
});

test("a rule's words come from its epic's current view, by exact rule ID", () => {
  const current = run("epic.current");
  assert.match(ruleWords(current, "SLICE-001/FR-01"), /^The system SHALL send the invitation/);
  assert.equal(ruleWords(current, "SLICE-009/FR-01"), null);
  assert.equal(ruleWords(run("epic.current.nothing-shipped"), "SLICE-001/FR-01"), null);
  assert.equal(ruleWords(null, "SLICE-001/FR-01"), null);
  assert.deepEqual(ruleEpics([{ rule: "a", epic_id: "EPIC-002" }, { rule: "b", epic_id: null }, { rule: "c", epic_id: "EPIC-002" }, { rule: "d", epic_id: "EPIC-001" }]), ["EPIC-002", "EPIC-001"]);
  assert.deepEqual(ruleEpics(show("exploring").lookups.items.shipped_rules), ["EPIC-001"], "the looked-up rules carry their epic: its page is offered");
});

test("a policy statement's text and its pack's owner, and a principle's statement, by exact ID", () => {
  const policies = run("policy.list");
  const statement = policyFacts(policies, "POL-privacy-02");
  assert.equal(statement.pack, "POL-privacy");
  assert.equal(statement.owner, "Data protection officer (@acme/privacy)");
  assert.ok(statement.text);
  assert.equal(policyFacts(policies, "POL-privacy").text, null, "a pack's own ID has no statement text");
  assert.equal(policyFacts(policies, "POL-privacy-0"), null, "never matched by prefix");
  assert.equal(policyFacts(null, "POL-privacy-02"), null);
  assert.match(principleStatement(run("principle.list.published"), "PP-01"), /^A published version/);
  assert.equal(principleStatement(run("principle.list.empty"), "PP-01"), null);
});

test("an open question is read for display; anything else is shown as written", () => {
  assert.deepEqual(openQuestion("❓ **Q4** - **Who it affects**: Who would not want this, and why?"), {
    number: 4,
    title: "Who it affects",
    body: "Who would not want this, and why?",
    preface: null,
  });
  const withFact = openQuestion("Three rules already shipped in Lending.\n\n❓ **Q1** — **Who asks today**: Who asks for this today, and how do they ask?");
  assert.equal(withFact.preface, "Three rules already shipped in Lending.");
  assert.equal(withFact.number, 1);
  assert.equal(openQuestion("I have enough to write the brief."), null);
  assert.equal(openQuestion("❓ **Q1** - **A**: one?\n❓ **Q2** - **B**: two?"), null, "two questions at once is not one question");
});

test("the terminal command is the host's own explore command, with the idea's ID", () => {
  assert.equal(exploreCommand("/mach:studio explore", "IDEA-002"), "/mach:studio explore IDEA-002");
  assert.equal(exploreCommand("/mach-studio explore", "IDEA-002"), "/mach-studio explore IDEA-002");
  assert.equal(exploreCommand(null, "IDEA-002"), null);
  assert.equal(exploreCommand("  ", "IDEA-002"), null);
});

test("each idea on the real board: New offers Start exploring, Shaped offers no conversation, the rest the conversation", () => {
  const rows = run("status.ideas").ideas.ideas;
  const modes = Object.fromEntries(rows.map((row) => [row.idea_id, exploreMode(row)]));
  assert.equal(modes["IDEA-001"], "new");
  assert.equal(modes["IDEA-002"], "open");
  assert.equal(modes["IDEA-003"], "open");
  assert.equal(modes["IDEA-008"], "shaped");
  assert.equal(run("idea.stage").stage, "exploring", "the stage the act sets");
});

test("the way on to the brief appears once a brief exists, with the engine's facts in words", () => {
  assert.equal(briefWayOn(show("request")), null, "no brief yet");
  assert.equal(briefWayOn(show("not-now")), null);
  assert.deepEqual(briefWayOn(show("exploring")), { state: "It does not pass its check yet." });
  assert.deepEqual(briefWayOn(show("brief-written")), { state: "It passes its check." });
  const changed = clone(show("brief-written"));
  changed.brief.changed_since_check = true;
  assert.deepEqual(briefWayOn(changed), { state: "It has changed since it was last checked." });
  const unchecked = clone(show("request"));
  unchecked.brief.exists = true;
  assert.deepEqual(briefWayOn(unchecked), { state: "It has not been checked yet." });
});

test("the screen's files: tokens only, no inline style, no markup injection, the interview's own model", () => {
  const dir = new URL("../src/features/shape/explore/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.includes("ExploreScreen.tsx") && files.includes("model.ts"));
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b|rgb\(|style=\{/, file);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML/, file);
    assert.doesNotMatch(source, /font-serif/, file);
  }
  const hook = readFileSync(new URL("useIdeaConversation.ts", dir), "utf8");
  assert.match(hook, /from "\.\.\/\.\.\/\.\.\/shared\/useConversation"/, "the conversation is the one conversation hook, not a second one");
  assert.match(hook, /client\.ideaConversation/);
  const shared = readFileSync(new URL("../../../shared/useConversation.ts", dir), "utf8");
  assert.match(shared, /from "\.\.\/features\/interview\/model"/, "over the interview's own model");
  const conversation = readFileSync(new URL("Conversation.tsx", dir), "utf8");
  assert.match(conversation, /"idea\.stage", \{ idea_id: row\.idea_id, stage: "exploring" \}/, "Start exploring is its own act");
  assert.doesNotMatch(conversation, /verdict\.record|idea\.size|idea\.publish/, "this screen offers no other act");
});

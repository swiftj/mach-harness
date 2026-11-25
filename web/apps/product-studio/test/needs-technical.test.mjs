// Unit tests for the Technical needs screen (src/features/needs/technical/): the six kinds in their fixed order with
// the engine's questions, each state of the page against the real fixtures (empty, several, a decision behind a need,
// newer needs elsewhere), the arguments each act sends, the refusals shown in the engine's words, the waiting state
// while the conversation writes, the two equal reconcile choices, and that no decision act is offered and the word
// "architecture" is not on the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  addArgs,
  answeredWords,
  asksWho,
  behindFor,
  behindWords,
  countWords,
  designQuestions,
  draftOf,
  emptyFields,
  givenOffered,
  isEmpty,
  isNeedsReconcileHint,
  kindLook,
  kindNames,
  kindOrder,
  kindViews,
  needsCommand,
  oneLine,
  publishLabel,
  publishLook,
  publishOffered,
  publishOutcome,
  publishState,
  refusalPlace,
  retiredNeeds,
  saidOnWords,
  saidWords,
  setArgs,
  unansweredNames,
  unpublishedWords,
} from "../src/features/needs/technical/model.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const run = (name) => fixture(name).data;
const list = (suffix) => run(`need.list.${suffix}`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const dir = new URL("../src/features/needs/technical/", import.meta.url);
const source = (file) => readFileSync(new URL(file, dir), "utf8");
const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
const said = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("the six kinds are in the engine's fixed order, each with the engine's own question", () => {
  const empty = list("empty");
  assert.deepEqual(kindOrder, ["people", "data", "connections", "never", "priority", "given"]);
  assert.deepEqual(
    empty.kinds.map((k) => k.kind),
    kindOrder,
    "the engine's order is the page's",
  );
  const views = kindViews(empty);
  assert.deepEqual(
    views.map((v) => v.kind),
    kindOrder,
  );
  for (const view of views) {
    const engine = empty.kinds.find((k) => k.kind === view.kind).question;
    assert.equal(view.question, engine, `${view.kind}: the engine's wording`);
    assert.equal(view.name, kindNames[view.kind]);
  }
  // Only when the engine leaves a kind out does the design's table speak.
  const missing = clone(empty);
  missing.kinds = missing.kinds.filter((k) => k.kind !== "never");
  assert.equal(kindViews(missing).find((v) => v.kind === "never").question, designQuestions.never);
});

test("empty: every kind not answered yet, an invitation, nothing to publish", () => {
  const empty = list("empty");
  assert.equal(isEmpty(empty), true);
  assert.ok(kindViews(empty).every((v) => v.state === "unanswered" && v.needs.length === 0));
  assert.equal(answeredWords(empty), "0 of 6 kinds answered");
  assert.equal(publishState(empty), "none");
  assert.equal(publishOffered("none"), false);
  assert.match(unpublishedWords("none", empty), /nothing to publish/i);
  assert.equal(run("status.needs-none").needs, undefined, "a project that never opened them has no needs in status");
  assert.equal(fixture("need.publish.refused-none").refused, "There are no technical needs to publish. Add one first.");
  const screen = said(source("TechnicalNeedsScreen.tsx"));
  assert.match(screen, /No technical needs yet/);
  assert.match(screen, /\{empty \?/, "the empty page invites the first answer instead of a publishing state");
});

test("several: needs under their kinds, a given with who and when, nothing to say, not answered, a retired need apart", () => {
  const several = list("several");
  assert.equal(isEmpty(several), false);
  const views = Object.fromEntries(kindViews(several).map((v) => [v.kind, v]));
  assert.deepEqual(views.people.needs.map((n) => n.need_id), ["TN-01"]);
  assert.equal(views.people.state, "answered");
  assert.equal(views.never.state, "nothing-to-say");
  assert.equal(views.priority.state, "unanswered", "TN-05 is retired, so priority is not answered");
  assert.deepEqual(views.priority.needs, []);
  assert.deepEqual(views.given.needs.map((n) => n.need_id), ["TN-03"]);
  assert.equal(saidWords(views.given.needs[0], "en-GB"), "Said by Jo Bloggs, CTO, on 2 Nov 2026.");
  assert.equal(saidWords(views.people.needs[0], "en-GB"), null, "only a given says who said it");
  assert.deepEqual(
    retiredNeeds(several).map((n) => n.need_id),
    ["TN-05"],
  );
  assert.equal(answeredWords(several), "5 of 6 kinds answered");
  assert.equal(countWords(several.active.length, several.retired.length), "4 needs, 1 retired");
  assert.equal(countWords(1, 0), "1 need");
});

test("what is not published, and the publish act's name, in each state from a real run", () => {
  const several = list("several");
  assert.equal(publishState(several), "unpublished");
  assert.equal(publishLabel("unpublished"), "Publish the changes");
  assert.equal(
    unpublishedWords("unpublished", several),
    "You changed the needs since version 1, and the engineer does not have the changes. Publishing gives them all of them: 4 needs, 1 retired.",
  );
  assert.equal(publishState(list("answered-some")), "never-published");
  assert.equal(publishLabel("never-published"), "Publish the needs");
  assert.equal(publishState(list("adr-behind")), "published");
  assert.equal(publishOffered("published"), false);
  assert.equal(publishState(list("newer-elsewhere")), "newer-elsewhere");
  const unfinished = clone(several);
  unfinished.published.unfinished = true;
  assert.equal(publishState(unfinished), "unfinished");
  assert.equal(publishLabel("unfinished"), "Finish publishing");
  assert.deepEqual(unansweredNames(several), ["What wins in a conflict"]);
  for (const look of Object.values(publishLook)) assert.ok(look.word && look.glyph, "a word and a shape, not only a tone");
  for (const look of Object.values(kindLook)) assert.ok(look.word && look.glyph);
  assert.equal(new Set(Object.values(kindLook).map((l) => l.glyph)).size, 3, "each kind state has its own shape");
});

test("a decision written for an older revision is shown under its need, as the engine reports it, read only", () => {
  const behind = list("adr-behind");
  const views = kindViews(behind);
  const people = views.find((v) => v.kind === "people").needs[0];
  assert.equal(people.need_id, "TN-01");
  assert.deepEqual(people.behind, behind.adrs_behind);
  assert.deepEqual(behindFor(behind, "TN-02"), []);
  assert.ok(views.flatMap((v) => v.needs).filter((n) => n.need_id !== "TN-01").every((n) => n.behind.length === 0));
  assert.equal(
    behindWords(behind.adrs_behind[0]),
    "Recorded for revision 1 of this need. It is at revision 2 now; an engineer decides whether the change matters.",
  );
  const list_ = said(source("NeedsList.tsx"));
  assert.match(list_, /Decisions the engineers recorded for an older revision/);
  assert.match(list_, /row\.adr \?\? row\.file/, "the decision is named as the engine names it");
});

test("add sends the kind, statement and why trimmed; a given also sends who and when, no other kind does", () => {
  const draft = { statement: "  About five hundred staff use it.  ", why: " It sets the size. ", said_by: "Jo", said_on: "2026-11-02" };
  assert.deepEqual(addArgs("people", draft), { kind: "people", statement: "About five hundred staff use it.", why: "It sets the size." });
  assert.deepEqual(addArgs("given", draft), { kind: "given", statement: "About five hundred staff use it.", why: "It sets the size.", said_by: "Jo", said_on: "2026-11-02" });
  assert.equal(asksWho("given"), true);
  for (const kind of kindOrder.filter((k) => k !== "given")) assert.equal(asksWho(kind), false, kind);
  // The fixture's given carries exactly those fields.
  const given = run("need.add.given").need;
  assert.equal(given.said_by, "Jo Bloggs, CTO");
  assert.equal(given.said_on, "2026-11-02");
});

test("set sends only what changed, and who and when only for a given", () => {
  const several = list("several");
  const people = several.needs.find((n) => n.need_id === "TN-01");
  assert.equal(setArgs(people, draftOf(people)), null, "nothing changed, nothing sent");
  assert.deepEqual(setArgs(people, { ...draftOf(people), why: "It sets how large it must be, and when." }), { need_id: "TN-01", why: "It sets how large it must be, and when." });
  assert.deepEqual(setArgs(people, { ...draftOf(people), said_by: "Somebody" }), null, "who said it is not sent for a need that is not a given");
  const given = several.needs.find((n) => n.need_id === "TN-03");
  assert.deepEqual(setArgs(given, { ...draftOf(given), said_on: "2026-11-03" }), { need_id: "TN-03", said_on: "2026-11-03" });
});

test("empty fields are asked for before anything is sent; a given needs who and a date; line breaks become spaces", () => {
  const blank = draftOf(null);
  assert.deepEqual(emptyFields("data", blank), ["statement", "why"]);
  assert.deepEqual(emptyFields("given", blank), ["statement", "why", "said_by", "said_on"]);
  assert.deepEqual(emptyFields("given", { statement: "x", why: "y", said_by: "Jo", said_on: "last week" }), ["said_on"]);
  assert.deepEqual(emptyFields("given", { statement: "x", why: "y", said_by: "Jo", said_on: "2026-11-02" }), []);
  assert.equal(oneLine("one\ntwo\r\n  three"), "one two three");
});

test("a refused statement is shown beside it in the engine's words, with recording a given as the other way", () => {
  const refused = fixture("need.add.refused-technology");
  assert.equal(refused.data, null);
  assert.match(refused.refused, /names technology \(database\)/);
  assert.match(refused.refused, /record it as a given, with who said it/);
  assert.equal(refusalPlace({ kind: "data", statement: "x", why: "y" }), "statement");
  assert.equal(refusalPlace({ need_id: "TN-01", why: "y" }), "form");
  assert.equal(givenOffered("add", "data", true), true);
  assert.equal(givenOffered("add", "given", true), false, "a given is already one");
  assert.equal(givenOffered("change", "data", true), false, "a need's kind is not changed");
  assert.equal(givenOffered("add", "data", false), false);
  assert.match(fixture("need.add.refused-given-without-who").refused, /a given says who decided it and when/);
  const form = said(source("NeedForm.tsx"));
  assert.match(form, /atStatement \? refusal\.message/, "the engine's message, as written, beside the statement");
  assert.match(form, /Record it as a given instead/);
  assert.match(form, /setKind\("given"\)/);
  for (const name of ["need.set.refused-retired", "need.none.refused-has-need", "reconcile.needs.refused-nothing-newer"]) {
    assert.ok(fixture(name).refused, name);
  }
});

test("each act calls its one operation with the right arguments", () => {
  const form = source("NeedForm.tsx");
  assert.match(form, /const args = addArgs\(kind, draft\);[\s\S]*act\.run\("need\.add", args\)/);
  assert.match(form, /const args = setArgs\(original, draft\);[\s\S]*act\.run\("need\.set", args\)/);
  const entries = source("NeedsList.tsx");
  assert.match(entries, /act\.run\("need\.retire", \{ need_id: id \}\)/);
  assert.match(entries, /act\.run\("need\.none", \{ kind \}\)/);
  const publish = source("PublishNeeds.tsx");
  assert.match(publish, /client\.op\("need\.publish", \{\}\)/);
  assert.match(publish, /act\.run\("reconcile\.needs", \{ take \}\)/);
  const screen = source("TechnicalNeedsScreen.tsx");
  assert.match(screen, /refresh\.run\(\)/, "checking GitHub is the shared refresh");
  assert.match(screen, /needs_taken/);
  // Every act is confirmed: add and change in their dialog, retire, nothing to say and the choice in ConfirmDialog.
  assert.equal((entries.match(/<ConfirmDialog/g) ?? []).length, 2);
  assert.match(publish, /<ConfirmDialog/);
  // The only operations this folder sends.
  const sent = new Set(files.flatMap((f) => [...source(f).matchAll(/(?:act\.run|client\.op)\("([a-z.]+)"/g)].map((m) => m[1])));
  assert.deepEqual([...sent].sort(), ["need.add", "need.none", "need.publish", "need.retire", "need.set", "reconcile.needs"]);
});

test("publish: where it went and the engine's ways on, in its words; a newer version leads to the choice", () => {
  const github = publishOutcome(run("need.publish"));
  assert.deepEqual(github.github, { issue: 1, url: "https://github.com/acme/team-space/issues/1", approvedBy: "ada-pm" });
  assert.equal(github.folder, "/project/.factory/studio/draft/product/ready/NEEDS");
  assert.deepEqual(github.waysOn, run("need.publish").ways_on, "the ways on are the engine's, unedited");
  assert.equal(github.revision, 1);
  const folderOnly = clone(run("need.publish"));
  folderOnly.saved_to = "folder";
  folderOnly.why_folder = "GitHub is not set up here.";
  const folder = publishOutcome(folderOnly);
  assert.equal(folder.github, null);
  assert.equal(folder.whyFolder, "GitHub is not set up here.");
  // Never blocked: publishing over a newer version goes ahead, replaces it and keeps theirs, saying so first.
  const over = fixture("need.publish.refused-newer-elsewhere");
  assert.equal(over.exit_code, 0);
  assert.match(over.data.note, /^@ben-pm published version \d+ of the technical needs on GitHub/);
  assert.match(over.data.note, /replaces it\. Theirs is kept/);
  assert.equal(isNeedsReconcileHint({ kind: "reconcile", target: "needs" }), true);
  assert.equal(isNeedsReconcileHint({ kind: "reconcile", target: "principles" }), false);
  assert.equal(isNeedsReconcileHint(null), false);
  const publish = said(source("PublishNeeds.tsx"));
  assert.match(publish, /outcome\.waysOn\.map/);
  assert.match(publish, /Choose a version/);
});

test("the reconcile choice is two equal choices, mine or theirs, neither preferred", () => {
  const publish = source("PublishNeeds.tsx");
  const choice = publish.slice(publish.indexOf("export const ReconcileNeedsChoice"));
  const buttons = [...choice.matchAll(/<Button([^\n]*)>\n\s*\{words\.(mine|theirs)\.button\}/g)];
  assert.equal(buttons.length, 2);
  const look = (attributes) => attributes.replace(/"(mine|theirs)"/, "TAKE");
  assert.equal(look(buttons[0][1]), look(buttons[1][1]), "the same look");
  assert.doesNotMatch(buttons[0][1], /variant=/, "neither is primary");
  assert.match(choice, /grid-cols-2/, "side by side, the same width");
  assert.equal(run("reconcile.needs").took, "theirs");
  assert.equal(list("newer-elsewhere").published.newer_elsewhere, true);
});

test("every act waits while the conversation writes, and the page says so", () => {
  const screen = source("TechnicalNeedsScreen.tsx");
  assert.match(screen, /const busy = conversationBusy\(conv\)/);
  assert.match(screen, /The conversation is writing\. Adding, changing, retiring and publishing wait until it has finished\./);
  assert.equal((screen.match(/disabled=\{busy\}/g) ?? []).length, 3, "add, publish and try again");
  const entries = source("NeedsList.tsx");
  assert.equal((entries.match(/disabled=\{(acts\.)?busy\}/g) ?? []).length, 4, "add, change, retire and nothing to say");
  assert.match(source("PublishNeeds.tsx"), /<Button disabled=\{busy\} onClick=\{\(\) => setTake\("mine"\)\}>/);
  const conversation = source("NeedsConversation.tsx");
  assert.match(conversation, /from "\.\.\/\.\.\/shape\/explore\/Conversation"/, "the same busy rule as Shape's conversation");
  // The host's own refusal while a turn runs arrives as `conflict` and is shown in the act's dialog.
  assert.match(source("NeedForm.tsx"), /refusal && !atStatement/);
});

test("the conversation is the needs conversation, with the host's own command when it cannot run here", () => {
  const screen = source("TechnicalNeedsScreen.tsx");
  assert.match(screen, /useNeedsConversation\(\)/);
  assert.match(screen, /conv\.model\.draftChanges/, "a need the conversation records is read again");
  const conversation = source("NeedsConversation.tsx");
  assert.match(conversation, /session\.capabilities\.needs_command/);
  assert.equal(needsCommand("/mach:studio needs"), "/mach:studio needs");
  assert.equal(needsCommand("  "), null);
  assert.equal(needsCommand(undefined), null);
  assert.doesNotMatch(said(conversation), /recommend/i, "no recommended answer is offered");
});

test("no decision act is shown or offered, and the page never says architecture", () => {
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /"adr\.|adr (accept|settle|new|supersede|overview)/i, file);
    assert.doesNotMatch(said(text), /architecture/i, file);
    // The engine's own `note` names the engineer's side in its words, so the page writes its own lead.
    assert.doesNotMatch(said(text), /\b(data|list)\.note\b/, `${file}: need.list's note is not shown`);
  }
  assert.doesNotMatch(list("several").note, /architecture/i, "the engine's note keeps to the product manager's words too");
});

test("the screen's files: tokens only, no inline style, no markup injection, no serif", () => {
  assert.ok(files.includes("TechnicalNeedsScreen.tsx") && files.includes("model.ts"));
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /#[0-9a-fA-F]{6}\b|rgb\(|style=\{/, file);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML/, file);
    assert.doesNotMatch(text, /font-serif|pixi|webgl|https?:\/\/(?!github)/i, file);
  }
});

test("a given's date reads as a date; anything else is shown as written", () => {
  assert.equal(saidOnWords("2026-11-02", "en-GB"), "2 Nov 2026");
  assert.equal(saidOnWords("sometime", "en-GB"), "sometime");
  assert.equal(saidOnWords(undefined), null);
  assert.equal(saidWords({ kind: "given", said_by: "", said_on: "" }), "Said by someone not recorded, date not recorded.");
});

// Unit tests for the case and verdict screen (src/features/shape/case/), against the real engine runs the fixture
// transport answers with (web/fixtures/case.*, verdict.*, idea.show.*, idea.publish.*). The model maps what the engine
// reported; it never chooses, ranks or recommends a verdict, and the screen pre-selects none of the three.
// Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as model from "../src/features/shape/case/model.ts";

const {
  caseCheckState,
  caseSummary,
  openOnArrival,
  publishSummary,
  verdictSummary,
  decisionWord,
  oneLine,
  publishAct,
  publishOutcome,
  publishState,
  questionCounts,
  questionViews,
  reasonLimit,
  recordedWithSentence,
  verdictArgs,
  verdictChoices,
  verdictConsequence,
  verdictFor,
  verdictFormProblem,
  verdictState,
  whatIsSaved,
} = model;

const run = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const data = (name) => run(name).data;
const caseFolder = new URL("../src/features/shape/case/", import.meta.url);
const source = (file) => readFileSync(new URL(file, caseFolder), "utf8");
const allSources = () =>
  readdirSync(caseFolder)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => source(f))
    .join("\n");

test("the three verdicts are in one fixed order, with words of the same weight", () => {
  assert.deepEqual(
    verdictChoices.map((c) => c.decision),
    ["go", "not-now", "no"],
  );
  assert.deepEqual(
    verdictChoices.map((c) => c.word),
    ["Go", "Not now", "No"],
  );
  for (const choice of verdictChoices) {
    assert.deepEqual(Object.keys(choice).sort(), ["decision", "meaning", "word"], "no choice carries an extra mark (default, recommended, primary)");
    assert.ok(choice.meaning.length > 20 && choice.meaning.length < 70, choice.meaning);
    assert.doesNotMatch(choice.meaning, /recommend|suggest|best|should|default/i);
  }
  assert.equal(decisionWord("not-now"), "Not now");
});

test("no verdict choice is pre-selected or marked as recommended on the screen", () => {
  const form = source("VerdictSection.tsx");
  assert.match(form, /useState<VerdictDecision \| null>\(null\)/, "the decision starts as nothing chosen");
  assert.doesNotMatch(form, /defaultChecked|autoFocus|aria-checked="true"/);
  // Every choice comes from one map with one set of classes: none can be larger, coloured or primary.
  assert.equal((form.match(/verdictChoices\.map/g) ?? []).length, 1);
  assert.doesNotMatch(form, /choice\.decision === "go"|decision === "go"/);
  const choiceBlock = form.slice(form.indexOf("<RadioGroup"), form.indexOf("/>", form.indexOf("<RadioGroup")));
  // The shared RadioGroup in its neutral tone: every choice alike, the native radio in ink; no accent colour or tone.
  assert.doesNotMatch(choiceBlock, /tone=|accent|primary|Recommend|danger|success|warning/);
  assert.match(choiceBlock, /chosenWord="Chosen"/, "the chosen one says so in a word");
  const radios = readFileSync(new URL("../../../packages/ui/src/components/radio-group.tsx", import.meta.url), "utf8");
  assert.match(radios, /has-\[:checked\]:border-ink/, "and is shown by a heavier ink outline");
  // The button that opens the confirmation is not the primary button, so no accent sits beside the choices.
  // No variant: the default (secondary) look. `data-part-act` only marks it as the part's act, to bring into view on arrival.
  assert.match(form, /<Button type="submit" data-part-act="">\s*Record the verdict\s*<\/Button>/);
  // Nothing in the screen's own words recommends or ranks a verdict.
  for (const text of allSources().match(/"[^"\n]*"|`[^`\n]*`/g) ?? []) {
    if (/recommend/i.test(text)) assert.match(text, /never recommends/, text);
    assert.doesNotMatch(text, /we suggest|best choice|recommended/i, text);
  }
});

test("the model has no function that takes the brief, the case or a check and returns a decision", () => {
  const exported = Object.keys(model).sort();
  assert.deepEqual(exported, [
    "caseCheckState",
    "caseSummary",
    "decisionWord",
    "oneLine",
    "openOnArrival",
    "publishAct",
    "publishOutcome",
    "publishState",
    "publishSummary",
    "questionCounts",
    "questionViews",
    "reasonLimit",
    "recordedWithSentence",
    "verdictArgs",
    "verdictChoices",
    "verdictConsequence",
    "verdictFor",
    "verdictFormProblem",
    "verdictState",
    "verdictSummary",
    "whatIsSaved",
  ]);
  const shown = data("case.show");
  for (const value of [caseCheckState(shown), questionCounts(shown.model), questionViews(shown.model)]) {
    assert.doesNotMatch(JSON.stringify(value), /"(go|not-now|no)"/);
  }
});

test("a case with two answers and one question left unanswered on purpose", () => {
  const shown = data("case.show");
  assert.equal(shown.model.customer, "You can now renew a loan from your account, at any hour, without calling us. If you cannot renew, the page tells you why.");
  const qs = questionViews(shown.model);
  assert.deepEqual(
    qs.map((q) => [q.id, q.state]),
    [
      ["Q-1", "answered"],
      ["Q-2", "answered"],
      ["Q-3", "left"],
    ],
  );
  assert.equal(qs[0].answer, "Desk staff at the small branches, who use renewal calls to check on older members.");
  assert.equal(qs[2].answer, null);
  assert.equal(qs[2].leftBecause, "the product manager wants the first month's numbers first.");
  assert.equal(questionCounts(shown.model), "2 answered, 1 left unanswered on purpose");
  assert.deepEqual(caseCheckState(shown), { word: "Passes its check", tone: "success", glyph: "check" });
  // case.check gives the same model and result without the text.
  assert.deepEqual(data("case.check").model, shown.model);
  assert.equal("text" in data("case.check"), false);
});

test("every question answered; one left with no reason; one with no answer; a case that does not pass", () => {
  // Every question answered (a real case from the engine).
  const all = data("case.show.all-answered").model;
  assert.ok(questionViews(all).every((q) => q.state === "answered"));
  assert.equal(questionCounts(all), "3 answered");
  assert.equal(data("case.check.all-answered").passes, true);
  // A question with no answer at all: the engine's check fails, and the screen says it has no answer yet.
  const open = data("case.show.unanswered");
  assert.equal(questionViews(open.model).at(-1).state, "open");
  assert.equal(questionCounts(open.model), "2 answered, 1 with no answer yet");
  assert.deepEqual(caseCheckState(data("case.check.unanswered")), { word: "Does not pass its check", tone: "danger", glyph: "alert" });
  // "Not answered." written alone: left on purpose, with no reason (the questions' view of one row).
  const base = data("case.show").model;
  const bare = { ...base, questions: [{ id: "Q-1", question: "Who would not want this?", state: "not_answered", answer: null, line: 9 }] };
  assert.deepEqual(questionViews(bare)[0], { id: "Q-1", question: "Who would not want this?", state: "left", answer: null, leftBecause: null });
});

test("no case yet: the engine's refusal is the words shown", () => {
  const refused = run("case.show.refused-none");
  assert.equal(refused.data, null);
  assert.equal(refused.refused, "IDEA-003 has no case yet.");
  assert.equal(data("idea.show.go").idea.has_case, false, "the board says so first, so no call is made");
});

test("no verdict yet: the form starts empty and says MACH never recommends one", () => {
  const show = data("idea.show.brief-written");
  assert.deepEqual(verdictState(show.verdict), { kind: "none" });
  assert.equal(recordedWithSentence(show.brief.revision, show.brief.changed_since_check), "MACH never recommends a verdict. Yours is recorded with your GitHub name and the brief's revision 1.");
  assert.match(recordedWithSentence(0, false), /there is none yet/);
  assert.match(recordedWithSentence(1, true), /changed since revision 1, so MACH checks it first/);
  assert.match(show.verdict_note, /never recommends a verdict/);
});

test("the act needs a choice and a reason in the product manager's own words, sent on one line", () => {
  assert.deepEqual(verdictFormProblem(null, "Members ask for it."), { field: "choice", message: "Choose Go, Not now or No." });
  assert.equal(verdictFormProblem("no", "   \n ").field, "reason");
  assert.equal(verdictFormProblem("no", "x".repeat(reasonLimit + 1)).field, "reason");
  assert.equal(verdictFormProblem("not-now", "After the summer."), null);
  assert.equal(oneLine("Members ask\nat every desk.  "), "Members ask at every desk.");
  assert.deepEqual(verdictArgs("IDEA-003", "go", " Members ask\r\nfor it. "), { idea_id: "IDEA-003", decision: "go", reason: "Members ask for it." });
});

test("each of the three verdicts as recorded: who, when, the reason, the brief it was for, and what follows", () => {
  const go = data("verdict.record.go").verdict;
  assert.equal(verdictState(go).kind, "holds");
  assert.equal(go.by, "ada-pm");
  assert.equal(verdictFor(go), "For the brief's revision 1");
  assert.equal(verdictConsequence("go").wayOn, "route");

  const notNow = data("verdict.record.not-now").verdict;
  const no = data("verdict.record.no").verdict;
  for (const v of [notNow, no]) {
    assert.equal(verdictState(v).kind, "holds");
    assert.equal(verdictConsequence(v.decision).wayOn, null);
    assert.match(verdictConsequence(v.decision).sentence, /kept with your reason, and the idea stays on the board/);
  }
  const fault = data("idea.show.fault").verdict;
  assert.equal(fault.decision, "no");
  assert.equal(verdictFor(fault), "Given before any brief was written");
  assert.equal(verdictFor(data("idea.show.not-now").verdict), "Given before any brief was written");
});

test("a stale verdict no longer holds and carries the engine's sentence", () => {
  const show = data("idea.show.stale-verdict");
  const state = verdictState(show.verdict);
  assert.equal(state.kind, "stale");
  assert.match(state.verdict.stale_note, /no longer holds/);
  assert.match(whatIsSaved(show).verdict, /no longer holds/);
});

test("a verdict recorded with nobody signed in says why, in the engine's words", () => {
  const recorded = data("verdict.record.no-login");
  assert.equal(recorded.recorded_without_github, true);
  assert.equal(recorded.verdict.by, null);
  assert.equal(recorded.why_no_login, "You are not signed in to GitHub on this computer.");
});

test("the refusals are the engine's words: Go without a passing brief, GitHub unreachable; who recorded the verdict never stops publishing", () => {
  assert.match(run("verdict.record.refused-go-without-brief").refused, /^Go needs a brief that passes its check/);
  assert.match(run("verdict.record.refused-offline").refused, /GitHub could not be reached/);
  const published = run("idea.publish.refused-no-login");
  assert.equal(published.exit_code, 0);
  assert.equal(published.data.verdict_posted, false);
  assert.match(published.data.note, /^The verdict on IDEA-001 was recorded on \S+ while this computer was not signed in to GitHub/);
});

test("where the idea is saved: not yet, on GitHub, in the folder, stopped part way, number taken", () => {
  const notYet = publishState(data("idea.show.brief-written").idea.github);
  assert.deepEqual(notYet, { kind: "not-published" });
  assert.deepEqual(publishAct(notYet, "record_verdict"), { label: "Save to GitHub", again: false });

  const onGithub = publishState(data("idea.show.on-github").idea.github);
  assert.equal(onGithub.kind, "github");
  assert.equal(onGithub.issue, 1);
  assert.equal(onGithub.url, "https://github.com/acme/team-space/issues/1");
  assert.equal(publishAct(onGithub, "size"), null, "nothing to save when the issue shows what is here");
  assert.ok(publishAct({ ...onGithub, upToDate: false }, "publish"));
  assert.ok(publishAct({ ...onGithub, changedOnGithub: true }, "size"));

  // Each from the real engine: a save stopped part way, the folder form, a number another idea holds on GitHub.
  const stopped = publishState(data("idea.show.unfinished").idea.github);
  assert.deepEqual(stopped, { kind: "stopped" });
  assert.equal(publishAct(stopped, "publish").label, "Save again to finish");
  assert.deepEqual(publishState(data("idea.show.folder").idea.github), { kind: "folder" });
  const taken = publishState(data("idea.show.number-taken").idea.github);
  assert.equal(taken.kind, "number-taken");
  assert.deepEqual(taken.others, data("idea.show.number-taken").idea.github.other_issues);
  assert.equal(data("idea.show.number-taken").idea.next.kind, "publish", "the next step is saving it: that gives it the next free number");
  assert.match(data("idea.show.number-taken").idea.next.sentence, /Saving it gives yours the next free number\./);
  const published = data("idea.publish.refused-number-taken");
  assert.deepEqual(published.renumbered, { from: "IDEA-005", to: "IDEA-006" });
  assert.match(published.note, /^IDEA-005 was already used on GitHub by another idea \(#\d+\), so MACH gave yours the next free number: IDEA-005 is now IDEA-006/);
  const changed = publishState(data("idea.show.changed").idea.github);
  assert.equal(changed.changedAfterVerdict, true);
  assert.ok(publishAct(changed, "publish"));
  // A number another idea holds never comes before saving: saving gives the idea the next free number in the same act.
  assert.deepEqual(publishAct(taken, "renumber"), { label: "Save to GitHub", again: false });
  assert.match(run("idea.publish.refused-stopped").refused, /stopped part way/);
  assert.doesNotMatch(source("PublishSection.tsx"), /Give it the next free number|idea\.renumber/);
  assert.deepEqual(data("idea.renumber").renumbered, { from: "IDEA-003", to: "IDEA-004" });
});

test("what a publish did, from its answer: an issue, or the folder and why", () => {
  assert.deepEqual(publishOutcome(data("idea.publish")), {
    where: "github",
    issue: 1,
    url: "https://github.com/acme/team-space/issues/1",
    by: "ada-pm",
    verdictPosted: true,
    revision: 1,
    note: "Saved as issue #1. The brief is its body and the verdict a comment on it. Nothing reaches the builders: the brief is for people.",
    renumbered: null,
  });
  // Another idea held the number: the same act gave this one the next free number, and says so.
  const moved = publishOutcome({ ...data("idea.publish"), renumbered: { from: "IDEA-003", to: "IDEA-004" } });
  assert.deepEqual(moved.renumbered, { from: "IDEA-003", to: "IDEA-004" });
  const folder = publishOutcome(data("idea.publish.folder"));
  assert.equal(folder.where, "folder");
  assert.equal(folder.whyFolder, "You are not signed in to GitHub on this computer.");
  assert.match(folder.folder, /product\/ready\/IDEAS\/IDEA-001$/);
  assert.equal(publishOutcome(data("idea.publish.finished")).issue, 2);
});

test("the confirmation says what is saved where, and never the case", () => {
  const go = whatIsSaved(data("idea.show.go"));
  assert.equal(go.brief, "The brief, revision 1, as the issue's body.");
  assert.equal(go.verdict, "Your verdict, Go, with your reason, as a comment signed with your GitHub name.");
  assert.equal(go.caseNote, "The case is never published. It stays in your workspace.");
  assert.match(whatIsSaved(data("idea.show.brief-written")).verdict, /none is recorded yet/);
  assert.match(whatIsSaved(data("idea.show.not-now")).brief, /there is none yet/);
  const publish = source("PublishSection.tsx");
  assert.match(publish, /An issue is as visible as its repository/);
  assert.match(publish, /folder in your workspace/);
});

test("the screen's words name MACH, never a script, a terminal command or an option", () => {
  for (const text of allSources().match(/"[^"\n]*"|`[^`\n]*`/g) ?? []) {
    if (/^["`](\.|@|lucide|react)/.test(text)) continue;
    assert.doesNotMatch(text, /\bscript\b|\/mach|studio\.py|--[a-z]/i, text);
  }
  // The product manager's text is shown as text: nothing is rendered as markup.
  assert.doesNotMatch(allSources(), /dangerouslySetInnerHTML|RichText|inline\(/);
});

// ---- the page's parts (M16 layout): which opens, and what each closed row says ----

test("the verdict part opens on arrival whatever verdict is recorded; publishing only when saving needs finishing", () => {
  for (const name of ["idea.show.go", "idea.show.not-now", "idea.show.fault", "idea.show.stale-verdict", "idea.show.brief-written", "idea.show.on-github", "idea.show.folder"]) {
    assert.equal(openOnArrival(publishState(data(name).idea.github), "verdict"), "verdict", name);
  }
  assert.equal(openOnArrival(publishState(data("idea.show.unfinished").idea.github), "verdict"), "publish");
  assert.equal(openOnArrival(publishState(data("idea.show.number-taken").idea.github), "verdict"), "publish");
  assert.equal(openOnArrival(publishState(data("idea.show.go").idea.github), "publish"), "publish");
  assert.equal(openOnArrival(publishState(data("idea.show.go").idea.github), "renumber"), "publish");
  // Go, Not now and No open the same part: the page's arrangement never depends on which verdict was given.
  const opened = ["idea.show.go", "idea.show.not-now", "idea.show.fault"].map((n) => openOnArrival(publishState(data(n).idea.github), "none"));
  assert.equal(new Set(opened).size, 1);
});

test("the case part's row says what the case holds, from the engine's counts", () => {
  const shown = data("case.show");
  assert.equal(caseSummary(shown.model), "Told as the customer would hear it, with 3 hard questions: 2 answered, 1 left unanswered on purpose");
  assert.equal(caseSummary(null), "No case yet. It is written in the conversation on the Explore step.");
  assert.match(caseSummary({ ...shown.model, questions: [] }), /No questions are written in the case\.$/);
});

test("the verdict part's row reads alike for Go, Not now and No, and says when a verdict no longer holds", () => {
  const note = data("idea.show.go").verdict_note;
  assert.equal(verdictSummary(verdictState(null), false, note), note, "with no verdict, the engine's own note is the row");
  const go = verdictSummary(verdictState(data("idea.show.go").verdict), false, note);
  const notNow = verdictSummary(verdictState(data("idea.show.not-now").verdict), false, note);
  const no = verdictSummary(verdictState(data("idea.show.fault").verdict), false, note);
  assert.equal(go, "Recorded by ada-pm. Next, size it to find its route.");
  assert.match(no, /^Recorded by ada-pm\. It is kept with your reason/);
  for (const words of [go, notNow, no]) {
    // The decision itself is the row's pill, the same look for all three; the words never praise or rank it.
    assert.doesNotMatch(words, /recommend|best|should/i);
  }
  assert.match(verdictSummary(verdictState(data("idea.show.stale-verdict").verdict), false, note), /^Recorded by ada-pm on an earlier brief, so it no longer holds\.$/);
  assert.match(verdictSummary(verdictState(data("idea.show.go").verdict), true, note), /shaped into work/);
});

test("the publishing part's row says where the idea is saved and what is left to do", () => {
  assert.equal(publishSummary(publishState(data("idea.show.go").idea.github)), "Saved nowhere others can read it yet.");
  assert.match(publishSummary(publishState(data("idea.show.unfinished").idea.github)), /stopped part way/);
  assert.match(publishSummary(publishState(data("idea.show.number-taken").idea.github)), /next free number/);
  assert.match(publishSummary(publishState(data("idea.show.folder").idea.github)), /folder in your workspace/);
  assert.equal(publishSummary(publishState(data("idea.show.on-github").idea.github)), "Issue #1 shows the brief and the verdict as they are here.");
});

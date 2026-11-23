// Unit tests for several product managers sharing one GitHub repository (M20 A3 and A4): what the app says and offers
// for a number taken at the same moment, a number held twice, shared text changed on both sides or taken in, the project
// already on GitHub, and drafts numbered without GitHub (src/shared/team.ts, src/api/nextActions.ts), against the real
// engine answers in web/fixtures/team_memory.py. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  holderWords,
  mineOf,
  numberTakenLine,
  numberTakenWords,
  projectStartNote,
  renumberHint,
  sharedTextAfterReady,
  sharedTextAnchor,
  sharedTextWords,
  splitNumbersNote,
  takenWords,
  teamNotices,
  versionFields,
} from "../src/shared/team.ts";
import { routeFor, routeForHint } from "../src/api/nextActions.ts";

const run = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));

// The person never reads the machinery's words or a field's name.
const FORBIDDEN = /\bengine\b|reconcile|\bhint\b|same_moment|same_id_twice|changed_elsewhere|text_taken|taken_from_github|numbers_from_github|architecture|\bsubmit\b/i;
const plainWords = (text, where) => {
  assert.doesNotMatch(text, FORBIDDEN, `${where}: ${text}`);
  assert.doesNotMatch(text, /!/, `${where}: no exclamation marks`);
};

test("a number taken at the same moment: who holds it, which issue, and one act", () => {
  const refused = run("slice.ready.team-same-moment");
  assert.equal(refused.exit_code, 1);
  assert.deepEqual(refused.hint, { kind: "renumber_slice", target: "SLICE-001" });
  assert.deepEqual(renumberHint(refused.hint), { id: "SLICE-001", kind: "slice" });
  assert.doesNotMatch(refused.refused, /slice renumber/, "the app's refusal names no command");
  assert.match(refused.refused, /ada-pm's issue #3 was made first and keeps the number/);

  const show = run("slice.show.team-same-moment").data;
  assert.deepEqual(show.github.same_moment, { issue: 4, holder: 3, by: "ada-pm", at: show.github.same_moment.at });
  const words = numberTakenWords("SLICE-001", show.github);
  assert.equal(words.title, "Someone else marked SLICE-001 ready at the same moment");
  assert.match(words.body, /^ada-pm's issue #3 was made first and keeps the number\. Your issue #4 was closed and never reached the builders\./);
  assert.match(words.body, /give it a new number, then mark it ready again\.$/);
  plainWords(`${words.title} ${words.body}`, "same moment");

  // The engine's own next step comes first, and leads to the renumber in place.
  const status = run("status.team-same-moment").data;
  const [first] = status.next_actions;
  assert.equal(first.kind, "renumber_slice");
  assert.deepEqual(routeFor(first), { type: "renumber", id: "SLICE-001", label: "Give it a new number" });
  assert.match(numberTakenLine(status.slices[0].github), /at the same moment/);

  // Renumbered, it is ready for approval again under the next free number, and marking it ready saves it.
  assert.deepEqual(run("slice.renumber.team-same-moment").data.renumbered, { from: "SLICE-001", to: "SLICE-002" });
  assert.equal(run("status.team-renumbered").data.next_actions[0].kind, "mark_ready");
  assert.equal(run("slice.ready.team-renumbered").data.saved_to, "github");
});

test("a later issue closed by a refresh has no name for who holds it: the words still read", () => {
  const github = run("slice.show.team-twice-closed").data.github;
  assert.equal(github.same_moment.by, null);
  assert.equal(holderWords(github.same_moment), "Another product manager's");
  assert.match(numberTakenWords("SLICE-001", github).body, /^Another product manager's issue #3 was made first/);
  // A number taken one after the other (no same moment): the plain words.
  assert.deepEqual(numberTakenWords("SLICE-009", { number_taken: true, same_moment: null }), {
    title: "Another slice on GitHub uses SLICE-009",
    body: "Your draft is unchanged: give it a new number, then mark it ready.",
  });
  assert.equal(numberTakenWords("SLICE-009", { number_taken: false, same_moment: null }), null);
});

test("an epic's number taken at the same moment: the epic is renumbered, and the slice marked ready again", () => {
  const refused = run("slice.ready.team-epic-same-moment");
  assert.deepEqual(renumberHint(refused.hint), { id: "EPIC-001", kind: "epic" });
  assert.deepEqual(routeForHint(refused.hint), { type: "renumber", id: "EPIC-001", label: "Give EPIC-001 a new number" });
  assert.deepEqual(run("epic.renumber.team-epic-same-moment").data.renumbered, { from: "EPIC-001", to: "EPIC-002" });
  assert.equal(run("slice.ready.team-epic-renumbered").data.saved_to, "github");
  assert.equal(renumberHint({ kind: "reopen_slice", target: "SLICE-001" }), null);
  assert.equal(renumberHint(null), null);
});

test("a number held twice is a calm notice in the engine's words, for each side", () => {
  for (const [name, yours, says] of [
    ["twice-kept", "kept", /Yours is #3, which keeps the number\./],
    ["twice-closed", "closed", /Yours was made later, so MACH closed it/],
    ["twice-builders", "taken_by_builders", /tell the engineer/],
  ]) {
    const status = run(`status.team-${name}`).data;
    const refresh = run(`refresh.team-${name}`).data;
    assert.equal(refresh.github.same_id_twice[0].yours, yours);
    const notices = teamNotices(status, refresh);
    assert.equal(notices.length, 1, name);
    assert.match(notices[0].text, says);
    // Without this visit's refresh, the status's record of the last one says the same.
    assert.deepEqual(teamNotices(status, null), notices);
  }
  const several = teamNotices(run("status.team-several").data, run("refresh.team-several").data);
  assert.match(several[0].text, /more than one project issue on GitHub \(#1 and #4\)/);
});

test("text MACH took in from someone else is said once, with the issue linked from the engine's address", () => {
  const status = run("status.team-text-taken-refresh").data;
  const refresh = run("refresh.team-text-taken").data;
  assert.deepEqual(refresh.github.text_taken.map((n) => n.target), ["EPIC-001"]);
  const [notice] = teamNotices(status, refresh);
  assert.match(notice.text, /^EPIC-001, “Team membership”, on GitHub holds text someone else wrote\. MACH took it into your workspace/);
  assert.deepEqual(notice.link, { number: 2, url: status.epics[0].url });
  assert.match(notice.link.url, /^https:\/\/github\.com\//, "the address is the engine's, never built here");
  plainWords(notice.text, "text taken");
  assert.match(takenWords({ kind: "project", target: "project", issue: 1 }, status), /^The project's name, vision and outcomes on GitHub/);
});

test("marking ready says what happened to the shared text, and leads to the choice when one waits", () => {
  const taken = sharedTextAfterReady(run("slice.ready.team-text-taken").data.shared_text);
  assert.deepEqual(taken.map((n) => [n.key, n.choose]), [["project-taken", null], ["EPIC-001-taken", null]]);
  assert.match(taken[0].text, /MACH took it into your workspace instead of writing yours over it\./);
  const changed = sharedTextAfterReady(run("slice.ready.team-text-changed").data.shared_text);
  assert.deepEqual(changed.map((n) => n.choose), ["project"]);
  for (const note of [...taken, ...changed]) plainWords(note.text, "after ready");
  assert.deepEqual(sharedTextAfterReady(undefined), []);
});

test("the project changed on both sides: both versions, whole, field by field, and where the choice waits", () => {
  const status = run("status.team-project-changed").data;
  const changed = status.project.changed_elsewhere;
  assert.equal(changed.readable, true);
  assert.deepEqual(versionFields("project", changed.theirs), [
    { label: "Name", value: "Team Space" },
    { label: "Vision", value: "Teams of any size work together." },
    { label: "Intended outcomes", value: ["Teams can work together"] },
  ]);
  assert.deepEqual(versionFields("project", mineOf(status, changed))[1], { label: "Vision", value: "Small teams work together." });
  const words = sharedTextWords(changed);
  assert.equal(words.heading, "Someone else changed the project on GitHub");
  assert.equal(words.mine.button, "Keep mine");
  assert.equal(words.theirs.button, "Take theirs");
  assert.equal(words.mine.done, "Kept your version of the project");
  assert.equal(words.theirs.done, "Took their version of the project");
  for (const text of [words.heading, words.lead, words.mine.title, words.mine.description, words.theirs.title, words.theirs.description]) plainWords(text, "project choice");
  // "Carry on" leads to the choice on Vision, brought into view.
  const [first] = status.next_actions;
  assert.deepEqual([first.kind, first.target], ["reconcile", "project"]);
  assert.deepEqual(routeFor(first), { type: "navigate", to: "/vision", label: "Choose a version of the project", state: { focus: sharedTextAnchor("project") } });
  // The engine's notes once chosen.
  assert.match(run("reconcile.team-project-mine").data.note, /MACH writes it to GitHub the next time you mark a slice ready\./);
  assert.equal(run("reconcile.team-project-theirs").data.note, "Your copy of the project now is the version from GitHub.");
  assert.equal(run("status.team-project-theirs").data.project.changed_elsewhere, null);
});

test("an epic changed on both sides: its title and criteria, and the choice under it", () => {
  const status = run("status.team-epic-changed").data;
  const epic = status.epics.find((e) => e.epic_id === "EPIC-001");
  const changed = epic.changed_elsewhere;
  assert.deepEqual(versionFields("epic", changed.theirs), [
    { label: "Title", value: "Team membership" },
    { label: "Done when", value: ["Only invited people can join", "An invitation can be withdrawn"] },
  ]);
  assert.deepEqual(versionFields("epic", mineOf(status, changed))[1].value, ["Only admins invite"]);
  const words = sharedTextWords(changed);
  assert.equal(words.heading, "Someone else changed EPIC-001 on GitHub");
  assert.match(words.mine.description, /the next time you mark one of its slices ready\.$/);
  assert.deepEqual(routeFor(status.next_actions[0]).state, { focus: "shared-EPIC-001" });
  assert.equal(routeForHint({ kind: "reconcile", target: "SLICE-002" }).to, "/inbox", "a slice's newer version is still chosen in the inbox");
});

test("their version not in MACH's form: it cannot be shown or taken, and the issue is linked", () => {
  const changed = run("status.team-project-unreadable").data.project.changed_elsewhere;
  assert.equal(changed.readable, false);
  assert.equal(changed.theirs, null);
  assert.deepEqual(versionFields("project", changed.theirs), []);
  assert.match(sharedTextWords(changed).lead, /cannot be shown or taken here\. Read it on GitHub\./);
  assert.match(changed.url, /\/issues\/1$/);
  assert.match(run("reconcile.team-project-theirs-refused").refused, /not in the form MACH writes, so it cannot be taken/);
});

test("naming the product: the project already on GitHub is taken and said; GitHub not checked is said too", () => {
  const taken = projectStartNote(run("project.init.team-taken").data);
  assert.equal(taken.kind, "taken");
  assert.equal(taken.issue, 1);
  assert.match(taken.url, /\/issues\/1$/);
  assert.match(taken.note, /MACH took its name, vision and outcomes from there\. Your own words were not used\./);
  const notChecked = projectStartNote(run("project.init.team-not-checked").data);
  assert.equal(notChecked.kind, "not_checked");
  assert.match(notChecked.note, /^MACH could not check GitHub for a project already there\./);
  assert.equal(projectStartNote(run("project.init").data), null, "a project named with nothing on GitHub says nothing more");
  const several = run("project.init.team-several");
  assert.match(several.refused, /more than one project issue on GitHub \(#1 and #4\)\. A repository holds one project, so nothing was defined\./);
  for (const text of [taken.note, notChecked.note, several.refused]) plainWords(text, "project init");
});

test("drafts numbered without GitHub: the sentence stands apart from what was made", () => {
  for (const name of ["prd.apply.team-not-checked", "idea.apply.team-not-checked"]) {
    const data = run(name).data;
    assert.equal(data.numbers_from_github.checked, false);
    const split = splitNumbersNote(data.note, data.numbers_from_github);
    assert.match(split.numbers, /^MACH could not read GitHub before numbering them \(GitHub could not be reached\), so a number may already be in use there; marking a slice ready checks again\.$/);
    assert.match(split.made, /^Made \d epics? and 2 draft slices from /);
    assert.equal(`${split.made} ${split.numbers}`, data.note, "nothing is lost or reworded");
  }
  const checked = run("prd.apply").data;
  assert.deepEqual(splitNumbersNote(checked.note, checked.numbers_from_github), { made: checked.note, numbers: null });
  assert.deepEqual(splitNumbersNote("Made 1 epic.", { checked: true, problem: null }), { made: "Made 1 epic.", numbers: null });
});

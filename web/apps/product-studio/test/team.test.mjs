// Unit tests for several product managers sharing one GitHub repository (M20 A3 and A4): what the app says and offers
// for a number taken at the same moment, a number held twice, shared text changed on both sides or taken in, the project
// already on GitHub, and drafts numbered without GitHub (src/shared/team.ts, src/api/nextActions.ts), against the real
// engine answers in web/fixtures/team_memory.py. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  epicNumberTakenWords,
  extraProjectIssues,
  hintUrls,
  holderWords,
  issueParts,
  mineOf,
  momentUrls,
  projectOnGithubWords,
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

test("a number taken at the same moment: who holds it, which issue, and one act that carries on", () => {
  // Never blocked: marking it ready closes Ben's issue, gives his draft the next free number and marks it ready, in one act.
  const ready = run("slice.ready.team-same-moment");
  assert.equal(ready.exit_code, 0);
  assert.deepEqual(ready.data.renumbered, [{ from: "SLICE-001", to: "SLICE-002" }]);
  assert.equal(ready.data.slice.slice_id, "SLICE-002");
  assert.equal(ready.data.saved_to, "github");
  assert.match(ready.data.note, /^SLICE-001 was marked ready at the same moment by someone else: @ada-pm's issue #3 was made first and keeps the number\./);
  assert.match(ready.data.note, /MACH gave your draft the next free number: SLICE-001 is now SLICE-002\./);
  assert.doesNotMatch(ready.data.note, /slice renumber/, "the app's wording names no command");
  plainWords(ready.data.note.replace(/@ada-pm/g, "ada-pm"), "same moment");

  // Before, the slice is Ben's draft; after, nothing is left for him to do about the number.
  assert.equal(run("slice.show.team-before-same-moment").data.github.same_moment, null);
  const status = run("status.team-same-moment").data;
  assert.ok(!status.next_actions.some((a) => a.kind === "renumber_slice"));
  assert.deepEqual(status.approvals_withdrawn, []);
  assert.equal(run("slice.show.team-same-moment").data.slice.status, "approved_for_engineering");

  // The words for a number found taken at a refresh: the one act is marking it ready.
  const words = numberTakenWords("SLICE-001", { number_taken: true, same_moment: { issue: 4, holder: 3, by: "ada-pm", at: null } });
  assert.equal(words.title, "Someone else marked SLICE-001 ready at the same moment");
  assert.match(words.body, /^ada-pm's issue #3 was made first and keeps the number\. Your issue #4 was closed and never reached the builders\./);
  assert.match(words.body, /mark it ready again, and MACH gives it the next free number\.$/);
  plainWords(`${words.title} ${words.body}`, "same moment");
  assert.match(numberTakenLine({ same_moment: { issue: 4, holder: 3, by: null, at: null } }), /^gets a new number when you mark it ready again: .*at the same moment/);
});

test("a later issue closed by a refresh has no name for who holds it: the words still read", () => {
  const github = run("slice.show.team-twice-closed").data.github;
  assert.equal(github.same_moment.by, null);
  assert.equal(holderWords(github.same_moment), "Another product manager's");
  assert.match(numberTakenWords("SLICE-001", github).body, /^Another product manager's issue #3 was made first/);
  // A number taken one after the other (no same moment): the plain words.
  assert.deepEqual(numberTakenWords("SLICE-009", { number_taken: true, same_moment: null }), {
    title: "Another slice on GitHub uses SLICE-009",
    body: "Your draft is unchanged: marking it ready gives it the next free number.",
  });
  assert.equal(numberTakenWords("SLICE-009", { number_taken: false, same_moment: null }), null);
});

test("an epic's number taken at the same moment: the epic gets the next free number, and the slice is marked ready, in one act", () => {
  const ready = run("slice.ready.team-epic-same-moment");
  assert.equal(ready.exit_code, 0);
  assert.deepEqual(ready.data.renumbered, [{ from: "EPIC-001", to: "EPIC-002" }]);
  assert.equal(ready.data.saved_to, "github");
  assert.match(ready.data.note, /^EPIC-001 was saved at the same moment by someone else, for a different epic: their issue #2 was made first and keeps the number\./);
  assert.match(ready.data.note, /MACH gave your epic the next free number: EPIC-001 is now EPIC-002\./);
  assert.equal(renumberHint({ kind: "renumber_epic", target: "EPIC-001" }).kind, "epic");
  assert.equal(renumberHint({ kind: "reopen_slice", target: "SLICE-001" }), null);
  assert.equal(renumberHint(null), null);
});

test("an epic's number taken at the same moment leaves nothing to do once the act is done; the words still read", () => {
  const before = run("status.team-before-epic-same-moment").data;
  assert.ok(before.epics.every((e) => e.same_moment === null));
  const status = run("status.team-epic-same-moment").data;
  assert.ok(status.epics.every((e) => e.same_moment === null));
  assert.ok(!status.next_actions.some((a) => a.kind === "renumber_epic"));
  assert.deepEqual(status.approvals_withdrawn, []);
  const moment = { issue: 4, holder: 2, by: null, at: null, issue_url: "https://github.com/acme/team-space/issues/4", holder_url: "https://github.com/acme/team-space/issues/2" };
  const words = epicNumberTakenWords("EPIC-001", moment);
  assert.equal(words.title, "Someone else saved a different epic as EPIC-001 at the same moment");
  assert.match(words.body, /^Their issue #2 was made first and keeps the number\. Your issue #4 was closed/);
  assert.match(words.body, /mark its slice ready again, and MACH gives the epic the next free number\.$/);
  assert.deepEqual(
    issueParts(words.body, momentUrls(moment)).filter((part) => typeof part !== "string").map((part) => part.number),
    [2, 4],
  );
  plainWords(`${words.title} ${words.body}`, "epic same moment");
  assert.equal(epicNumberTakenWords("EPIC-001", null), null);
});

test("issue numbers in a sentence are linked only where the engine gave an address", () => {
  assert.deepEqual(issueParts("Held by #3 and #12.", { 3: "https://github.com/a/b/issues/3" }), ["Held by ", { number: 3, url: "https://github.com/a/b/issues/3" }, " and #12."]);
  assert.deepEqual(issueParts("No issues here.", {}), ["No issues here."]);
  assert.deepEqual(issueParts("#3", { 3: null }), ["#3"]);
});

test("a number held twice is a calm notice in the engine's words, for each side", () => {
  for (const [name, yours, says] of [
    ["twice-kept", "kept", /Yours is #3, which keeps the number\./],
    ["twice-closed", "closed", /Yours was made later, so MACH closed it/],
    ["twice-builders", "taken_by_builders", /the builders have already started on it, so MACH left it open/],
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
  assert.deepEqual(
    [...new Set(issueParts(several[0].text, several[0].urls).filter((part) => typeof part !== "string").map((part) => part.number))],
    [1, 4],
    "each project issue is linked",
  );
  const [kept] = teamNotices(run("status.team-twice-kept").data, null);
  assert.deepEqual(Object.keys(kept.urls).sort(), ["3", "4"]);

  // Never blocked: marking ready with several project issues carries on with the one this workspace follows, saying so first.
  const ready = run("slice.ready.team-several");
  assert.equal(ready.exit_code, 0);
  assert.match(ready.data.note, /^This repository has more than one project issue on GitHub \(#1 and #4\)\. A repository holds one project, so MACH used #1/);
  assert.match(ready.data.note, /Closing #4 changes nothing in your work.* MACH can close it for you\./);
  plainWords(ready.data.note, "several, marking ready");
  assert.deepEqual(hintUrls(null), {});
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
  const refused = run("reconcile.team-project-theirs-refused").refused;
  assert.match(refused, /not in the form MACH writes, so MACH cannot copy it into your workspace\. Nothing was changed\./);
  assert.match(refused, /then keep yours: MACH writes it to GitHub the next time you mark a slice ready\.$/);
  assert.doesNotMatch(refused, /ask the person/i);
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
  // Never blocked: with two project issues, naming it takes the oldest MACH can read and says so first.
  const several = run("project.init.team-several");
  assert.equal(several.exit_code, 0);
  assert.equal(several.data.taken_from_github, 1);
  assert.match(several.data.note, /^This repository has more than one project issue on GitHub \(#1 and #4\)\. A repository holds one project, so MACH used #1, the oldest one MACH can read\./);
  for (const text of [taken.note, notChecked.note, several.data.note]) plainWords(text, "project init");
});

test("before the product is named, the project already on GitHub is said from the last reading, before anything is typed", () => {
  assert.equal(run("status.team-start").data.project_on_github, null, "GitHub not read yet: nothing is said, and the form is as before");
  assert.equal(projectOnGithubWords(null), null);
  const found = run("status.team-start-known").data.project_on_github;
  assert.deepEqual({ ...found, read_at: null }, { issue: 1, url: "https://github.com/acme/team-space/issues/1", name: "Team Space", readable: true, read_at: null });
  const words = projectOnGithubWords(found);
  assert.equal(words.title, "This repository already has a project: Team Space");
  assert.match(words.body, /^Its issue on GitHub is #1\. When you name the product, MACH takes its name, vision and outcomes from GitHub, and what you type is not used\./);
  plainWords(`${words.title} ${words.body}`, "project on GitHub");
  const unreadable = projectOnGithubWords({ ...found, name: null, readable: false });
  assert.match(unreadable.body, /not in the form MACH writes, so MACH cannot take its words\. When you name the product, your own words define the project, and the first slice you mark ready writes them to #1\./);
  assert.doesNotMatch(unreadable.body, /ask|before you name/i, "never sent to another person, never a step before naming it");
  plainWords(unreadable.body, "project on GitHub, not in MACH's form");
  // Several project issues: none is the one MACH would take; the start screen names them instead.
  assert.equal(run("status.team-several-start").data.project_on_github, null);
});

test("drafts numbered without GitHub: the sentence stands apart from what was made", () => {
  for (const name of ["prd.apply.team-not-checked", "idea.apply.team-not-checked"]) {
    const data = run(name).data;
    assert.equal(data.numbers_from_github.checked, false);
    const split = splitNumbersNote(data.note, data.numbers_from_github);
    assert.match(split.numbers, /^MACH could not read GitHub before numbering them \(GitHub could not be reached.*\), so a number may already be in use there; marking a slice ready checks again\.$/);
    assert.match(split.made, /^Made \d epics? and 2 draft slices from /);
    assert.equal(`${split.made} ${split.numbers}`, data.note, "nothing is lost or reworded");
  }
  const checked = run("prd.apply").data;
  assert.deepEqual(splitNumbersNote(checked.note, checked.numbers_from_github), { made: checked.note, numbers: null });
  assert.deepEqual(splitNumbersNote("Made 1 epic.", { checked: true, problem: null }), { made: "Made 1 epic.", numbers: null });
});

test("several project issues: a warning, and closing each extra one is offered beside it", () => {
  // The one this project follows stays; else the oldest, which is the one MACH uses.
  assert.deepEqual(extraProjectIssues([4, 1], null), [4]);
  assert.deepEqual(extraProjectIssues([1, 4, 9], 4), [1, 9]);
  assert.deepEqual(extraProjectIssues([1, 4], 7), [4], "a followed issue that is not among them leaves the oldest");
  assert.deepEqual(extraProjectIssues([3], 3), [], "one project issue: nothing to close");
  assert.deepEqual(extraProjectIssues([], null), []);
  // On the project home: the engine's sentence for the project, with the extra issues to close; never for a slice or an epic.
  const status = {
    project: { issue: 1, url: null },
    epics: [],
    same_id_twice: [
      { kind: "project", id: null, kept: null, others: [1, 4], yours: null, note: "This repository has more than one project issue on GitHub (#1 and #4).", urls: {} },
      { kind: "slice", id: "SLICE-002", kept: 3, others: [5], yours: null, note: "SLICE-002 is held twice.", urls: {} },
    ],
  };
  assert.deepEqual(
    teamNotices(status, null).map((n) => n.close),
    [[4], []],
  );
  // After naming the product: the issues the engine says MACH can close, never the one it took.
  assert.deepEqual(projectStartNote({ taken_from_github: 1, url: null, note: "MACH used #1.", extra_issues: [1, 4] }).close, [4]);
  const warned = projectStartNote({ warned: ["This repository already has a project issue on GitHub (#3), but it names a project MACH cannot read."], extra_issues: [3] });
  assert.equal(warned.kind, "warned");
  assert.deepEqual(warned.close, [3]);
  assert.match(warned.note, /^This repository already has a project issue/);
  assert.deepEqual(projectStartNote({ taken_from_github: 1, note: "n" }).close, [], "an engine that names none offers none");
  // The button sits beside the notice wherever it shows: the project home, a refusal's hint, and after naming the product.
  for (const file of ["../src/features/home/HomeScreen.tsx", "../src/shared/AppHint.tsx", "../src/shared/ProjectStartNotice.tsx"]) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), /<CloseProjectIssues numbers=/, file);
  }
  const button = readFileSync(new URL("../src/shared/CloseProjectIssue.tsx", import.meta.url), "utf8");
  assert.match(button, /act\.run\("project\.close-issue", \{ number \}\)/);
  assert.match(button, /<ConfirmDialog/);
});

test("their text not in MACH's form: keeping yours is the act, and no one else is asked", () => {
  const lead = sharedTextWords({ kind: "project", target: "project", readable: false }).lead;
  assert.match(lead, /Keep yours, and MACH writes it over theirs the next time you mark a slice ready; theirs stays in the issue's history on GitHub\.$/);
  assert.doesNotMatch(lead, /ask the person/i);
  plainWords(lead, "shared text not in MACH's form");
});

test("a number someone else holds goes straight to marking ready: no new number first", () => {
  assert.deepEqual(routeFor({ kind: "renumber_slice", target: "SLICE-003", title: "", reason: null }), {
    type: "navigate",
    to: "/slices/SLICE-003",
    label: "Read it and mark it ready",
  });
  const inbox = readFileSync(new URL("../src/features/inbox/InboxScreen.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(inbox, /RenumberDialog/);
  const notice = readFileSync(new URL("../src/shared/NumberTakenNotice.tsx", import.meta.url), "utf8");
  assert.match(notice, /export function NumberTakenNotice[\s\S]*?<Banner tone="info" title=\{words\.title\}>/);
});

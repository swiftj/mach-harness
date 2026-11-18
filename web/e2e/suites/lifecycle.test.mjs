// The acceptance path: a product manager takes a product from nothing to a slice marked ready to
// build and saved as a GitHub issue, through the real app in Chromium, the real host, the real
// engine and the stand-in gh. After each step the engine's own state on disk is read back
// (studio.py run directly) and compared with the screen.
//
//   node --test web/e2e/suites/lifecycle.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildHost } from "../lib/build.mjs";
import { createWorld } from "../lib/world.mjs";
import { startHost } from "../lib/host.mjs";
import { openBrowser, settle, shoot, stepper, watchedPage } from "../lib/app.mjs";

const FOLDER = "lifecycle";
const IDEA = "An admin invites one teammate by email so the team can work together.";
let binary, world, host, browser, session, page, before0, factory0;
const factoryEntries = () => readdirSync(join(world.pm, ".factory"), { recursive: true }).filter((p) => !String(p).startsWith("studio")).map(String).sort();

before(async () => {
  ({ binary } = buildHost());
  world = createWorld({
    claude: "fake",
    turns: [
      { kind: "question", number: 1, title: "Who it is for", body: "Is this slice for a workspace admin who invites one teammate by email?", recommendation: "Yes. The slice is done when the invitation is sent." },
      { kind: "write_spec" },
    ],
  });
  before0 = world.checkout();
  factory0 = factoryEntries();
  host = await startHost(binary, world.pm, world.env);
  browser = await openBrowser();
  session = await watchedPage(browser, host.origin);
  page = session.page;
});

after(async () => {
  await browser?.close();
  await host?.stop();
  world?.cleanup();
});

const main = () => page.getByRole("main");
const dialog = () => page.getByRole("dialog");
const go = async (route) => {
  await page.goto(`${host.origin}/#${route}`);
  await settle(page);
};
const engineStatus = () => world.status();

test("lifecycle: from nothing to a slice ready to build, through the UI only", async (t) => {
  const step = stepper(t, () => page, FOLDER);
  // A check whose failure is a defect to report but does not stop the path.
  const check = (name, fn) => t.test(name, fn);

  await step("01 open the app from the one-time URL", async () => {
    await page.goto(host.url, { waitUntil: "networkidle" });
    assert.ok(!page.url().includes("?t="), `the token stays in the address bar: ${page.url()}`);
    await main().getByRole("heading", { level: 1, name: "Start with what the product is for" }).waitFor();
    const status = engineStatus();
    assert.equal(status.project, null, "the engine has no project yet");
    assert.equal(status.factory_authorized, false);
    await shoot(page, FOLDER, "01-first-run");
  });

  await step("02 set the vision and outcomes", async () => {
    await main().getByRole("link", { name: "Define the project" }).click();
    await main().getByRole("textbox", { name: "Name" }).fill("Team Space");
    await main().getByRole("textbox", { name: "Vision" }).fill("Teams work together without friction.");
    await main().getByRole("textbox", { name: "Outcome 1" }).fill("Teams can work together");
    await main().getByRole("button", { name: "Add an outcome" }).click();
    await main().getByRole("textbox", { name: "Outcome 2" }).fill("Admins stay in control of who has access");
    assert.equal(await main().getByRole("textbox", { name: "Project ID" }).inputValue(), "team-space");
    await main().getByRole("button", { name: "Create the project" }).click();
    await main().getByRole("heading", { level: 1, name: "Vision" }).waitFor();
    await main().getByText("Revision 1").waitFor();
    const { project } = engineStatus();
    assert.deepEqual(
      { id: project.project_id, name: project.name, vision: project.vision, outcomes: project.outcomes, revision: project.revision },
      { id: "team-space", name: "Team Space", vision: "Teams work together without friction.", outcomes: ["Teams can work together", "Admins stay in control of who has access"], revision: 1 },
    );
    assert.equal(await main().getByRole("textbox", { name: "Vision" }).inputValue(), project.vision);
    await shoot(page, FOLDER, "02-vision");
  });

  await step("03 create an epic and approve it", async () => {
    await main().getByRole("button", { name: "Add an epic" }).click();
    await dialog().getByRole("textbox", { name: "Title" }).fill("Team membership");
    await dialog().getByRole("textbox", { name: "Criterion 1" }).fill("Only invited people can join");
    await dialog().getByRole("button", { name: "Add epic" }).click();
    await dialog().waitFor({ state: "detached" });
    let epic = engineStatus().epics[0];
    assert.deepEqual([epic.epic_id, epic.title, epic.status], ["EPIC-001", "Team membership", "proposed"]);
    const card = main().getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Team membership" }) });
    await card.getByText("Proposed").waitFor();
    await card.getByRole("button", { name: "Approve EPIC-001" }).click();
    await shoot(page, FOLDER, "03a-approve-epic-dialog");
    await dialog().getByRole("button", { name: "Approve epic" }).click();
    await dialog().waitFor({ state: "detached" });
    await card.getByText("Approved", { exact: true }).waitFor();
    epic = engineStatus().epics[0];
    assert.equal(epic.status, "approved");
    await shoot(page, FOLDER, "03b-epic-approved");
  });

  await step("04 create a slice", async () => {
    await go("/roadmap");
    await main().getByRole("button", { name: "Start a slice" }).first().click();
    await dialog().getByRole("textbox", { name: "Title" }).fill("Invite a teammate");
    await dialog().getByRole("textbox", { name: /The idea/ }).fill(IDEA);
    await shoot(page, FOLDER, "04a-start-slice-dialog");
    await dialog().getByRole("button", { name: "Start and open the interview" }).click();
    await page.waitForURL(/#\/slices\/SLICE-001\/interview$/);
    await main().getByRole("heading", { level: 1, name: "Interview: Invite a teammate" }).waitFor();
    const [slice] = engineStatus().slices;
    assert.deepEqual([slice.slice_id, slice.title, slice.epic_id], ["SLICE-001", "Invite a teammate", "EPIC-001"]);
    assert.ok(["draft", "interviewing"].includes(slice.status), slice.status);
    await shoot(page, FOLDER, "04b-interview-start");
  });

  await check("04c the new slice's specification page opens before anything is written", async () => {
    await main().getByRole("link", { name: "Specification", exact: true }).click();
    await settle(page);
    const crashed = await page.getByText("Unexpected Application Error!").count();
    if (crashed) await shoot(page, FOLDER, "DEFECT-04c-spec-page-crash");
    const text = crashed ? await page.locator("body").innerText() : "";
    await go("/slices/SLICE-001/interview");
    await main().getByRole("heading", { level: 1, name: "Interview: Invite a teammate" }).waitFor();
    assert.equal(crashed, 0, `the specification page crashed: ${text.split("\n").slice(0, 2).join(" ")}`);
  });

  await step("05 open the interview and receive the first question", async () => {
    await main().getByRole("button", { name: "Start the interview" }).click();
    const card = main().getByRole("region", { name: "Who it is for" });
    await card.waitFor({ timeout: 30000 });
    await card.getByText("Is this slice for a workspace admin who invites one teammate by email?").waitFor();
    await card.getByText("Yes. The slice is done when the invitation is sent.").waitFor();
    // The interviewer picked the slice up through the engine (slice resume), as the real one does.
    assert.equal(engineStatus().slices[0].status, "interviewing");
    const [call] = world.claudeCalls();
    assert.ok(call, "the host started the stand-in claude");
    for (const flag of ["--restricted", "--strict-mcp-config", "--permission-prompts"]) assert.ok(call.argv.includes(flag), `missing ${flag}`);
    assert.equal(call.argv[call.argv.indexOf("--permission-mode") + 1], "default");
    assert.ok(!call.argv.some((a) => /dangerously|bypassPermissions/.test(a)), "no permission-skipping flag");
    const kept = new Set(["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM", "GIT_TERMINAL_PROMPT", "PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING", "LC_CTYPE"]); // the last four are set by the shell or by Python itself
    assert.deepEqual(call.env_names.filter((n) => !kept.has(n)), [], "the interviewer inherits only the documented environment");
    await shoot(page, FOLDER, "05-first-question");
  });

  await check("05b the idea typed when starting the slice reaches the interviewer", () => {
    const [call] = world.claudeCalls();
    assert.ok(call, "no interview call recorded");
    assert.ok(call.argv.some((a) => a.includes(IDEA)), `first message was: ${call.argv[call.argv.length - 1]}`);
  });

  await step("06 answer, reach an approvable specification, see the engine check pass", async () => {
    await main().getByRole("button", { name: "Yes, accept" }).click();
    await main().getByText("ready for you to approve").waitFor({ timeout: 30000 });
    const engineCheck = main().getByRole("region", { name: "Engine check" });
    await engineCheck.getByText("Ready for your approval").waitFor({ timeout: 20000 });
    // The engine's own verdict, read directly.
    const result = world.studio(world.pm, "slice", "check", "SLICE-001", "--ready");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.ready, true);
    const [slice] = engineStatus().slices;
    assert.equal(slice.status, "ready_for_approval");
    assert.equal(slice.open_questions, 0);
    assert.equal(slice.spec, "specs/slices/SLICE-001-invite-teammate.md");
    assert.ok(existsSync(join(world.pm, ".factory/studio/draft/product/intents/SLICE-001.md")));
    await shoot(page, FOLDER, "06-spec-ready");
  });

  let issue = null;
  await step("07 mark the slice ready to build: one issue under its epic, and where it was saved", async () => {
    await main().getByRole("link", { name: "Open the full specification" }).click();
    await main().getByRole("heading", { level: 1, name: "Invite a teammate" }).waitFor();
    await page.getByRole("complementary", { name: "Engine check" }).getByText("Ready for your approval").waitFor();
    await shoot(page, FOLDER, "07a-specification");
    assert.equal(world.issues().length, 0, "nothing is on GitHub before the PM marks the slice ready");
    await main().getByRole("button", { name: "Mark ready to build" }).click();
    const confirm = page.getByRole("dialog", { name: "Mark SLICE-001 ready to build?" });
    await confirm.getByText("saves the slice to the project on GitHub, under the epic “Team membership” (EPIC-001)", { exact: false }).waitFor();
    await confirm.getByText("records that you approved exactly this text", { exact: false }).waitFor();
    await shoot(page, FOLDER, "07b-mark-ready-dialog");
    const marked = page.waitForResponse((r) => r.url().endsWith("/api/ops/slice.ready"));
    await confirm.getByRole("button", { name: "Mark ready to build" }).click();
    const report = (await (await marked).json()).data;
    const done = page.getByRole("dialog", { name: "SLICE-001 is ready to build" });
    await done.waitFor({ timeout: 60000 });
    // The engine's state on disk, and the stand-in GitHub, agree with the screen.
    const [slice] = engineStatus().slices;
    assert.equal(slice.status, "approved_for_engineering");
    assert.equal(slice.github.saved, "github");
    issue = slice.github.issue;
    assert.equal(report.issue, issue);
    const slices = world.issues("mach:slice");
    assert.equal(slices.length, 1, "exactly one slice issue");
    assert.equal(slices[0].number, issue);
    assert.deepEqual(slices[0].labels.map((l) => l.name).sort(), ["mach:ready", "mach:slice"]);
    assert.equal(world.issues("mach:epic").length, 1);
    assert.equal(world.issues("mach:project").length, 1);
    await done.getByText(report.note).waitFor();
    const link = done.getByRole("link", { name: new RegExp(`^#${issue}`) });
    assert.equal(await link.getAttribute("href"), report.url);
    assert.equal(report.url, slice.github.url);
    await shoot(page, FOLDER, "07c-saved-on-github");
    await done.getByRole("button", { name: "Done" }).click();
    await done.waitFor({ state: "detached" });
    await main().getByRole("button", { name: "Reopen SLICE-001" }).waitFor();
    await main().getByText(`#${issue}`).first().waitFor();
    await shoot(page, FOLDER, "07d-slice-ready");
  });

  await step("08 the builders take it; refresh shows it, in the engine's state", async () => {
    world.setStateLabel(issue, "mach:building");
    await go("/github");
    const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/ops/refresh"));
    await main().getByRole("button", { name: "Refresh" }).click();
    await refreshed;
    await settle(page, 600);
    assert.equal(engineStatus().slices[0].github.state_label, "mach:building");
    const row = main().getByRole("row").filter({ hasText: "SLICE-001" });
    await row.getByText("Being built", { exact: true }).waitFor({ timeout: 20000 });
    await row.getByText("Approved", { exact: true }).waitFor();
    await shoot(page, FOLDER, "08a-on-github");
    await go("/");
    const home = main().getByRole("listitem").filter({ hasText: "Invite a teammate" });
    await home.getByText("Being built", { exact: true }).waitFor();
    await home.getByRole("link", { name: new RegExp(`^#${issue}`) }).waitFor();
    await shoot(page, FOLDER, "08b-home-being-built");
  });

  await step("09 reopen it: ready comes off GitHub first, and the engine's note is shown", async () => {
    await go("/slices/SLICE-001");
    await main().getByRole("button", { name: "Reopen SLICE-001" }).click();
    const confirm = page.getByRole("dialog", { name: "Reopen SLICE-001?" });
    await shoot(page, FOLDER, "09a-reopen-dialog");
    const reopened = page.waitForResponse((r) => r.url().endsWith("/api/ops/slice.reopen"));
    await confirm.getByRole("button", { name: "Reopen SLICE-001" }).click();
    const note = (await (await reopened).json()).data.note;
    await confirm.waitFor({ state: "detached" });
    assert.match(note, /builders have already started/);
    await page.getByText(note).first().waitFor();
    const [slice] = engineStatus().slices;
    assert.equal(slice.status, "interviewing");
    assert.ok(!world.issues("mach:slice")[0].labels.some((l) => l.name === "mach:ready"), "mach:ready is off the issue");
    await main().getByRole("button", { name: "Mark ready to build" }).waitFor();
    await shoot(page, FOLDER, "09b-reopened");
  });

  let reconcileExchange = null;
  await step("10 someone else saves a newer version; the PM takes theirs in Decisions", async () => {
    world.newerVersion(issue, "\nChanged by Ben.\n");
    await go("/github");
    await main().getByRole("button", { name: "Refresh" }).click();
    await settle(page, 800);
    assert.equal(engineStatus().slices[0].github.newer_elsewhere, true);
    await go("/inbox");
    const card = main().getByRole("article", { name: /SLICE-001\s*Invite a teammate/ });
    await card.getByText("Newer version saved by someone else", { exact: true }).waitFor({ timeout: 20000 });
    await shoot(page, FOLDER, "10a-decisions-newer-version");
    await card.getByRole("button", { name: "Take their version" }).click();
    const confirm = page.getByRole("dialog", { name: "Take the newer version of SLICE-001?" });
    await shoot(page, FOLDER, "10b-take-theirs-dialog");
    const reconciled = page.waitForResponse((r) => r.url().endsWith("/api/ops/reconcile"));
    await confirm.getByRole("button", { name: "Take their version" }).click();
    const response = await reconciled;
    reconcileExchange = { request: response.request().postDataJSON(), response: await response.json() };
    await confirm.waitFor({ state: "detached" });
    assert.deepEqual(reconcileExchange.request, { slice_id: "SLICE-001", take: "theirs" });
    await settle(page, 800);
    const [slice] = engineStatus().slices;
    assert.equal(slice.github.newer_elsewhere, false);
    assert.equal(slice.status, "ready_for_approval");
    assert.match(world.draftTree()["specs/slices/SLICE-001-invite-teammate.md"], /Changed by Ben\./);
    assert.equal(await main().getByRole("article", { name: /SLICE-001\s*Invite a teammate/ }).count(), 0, "the settled choice is gone from Decisions");
    await shoot(page, FOLDER, "10c-taken");
  });

  await step("11 mark it ready again: the same issue, the next version", async () => {
    await go("/slices/SLICE-001");
    await main().getByRole("button", { name: "Mark ready to build" }).click();
    const confirm = page.getByRole("dialog", { name: "Mark SLICE-001 ready to build?" });
    const marked = page.waitForResponse((r) => r.url().endsWith("/api/ops/slice.ready"));
    await confirm.getByRole("button", { name: "Mark ready to build" }).click();
    const report = (await (await marked).json()).data;
    const done = page.getByRole("dialog", { name: "SLICE-001 is ready to build" });
    await done.waitFor({ timeout: 60000 });
    assert.equal(report.issue, issue);
    assert.equal(report.revision, 2);
    assert.equal(world.issues("mach:slice").length, 1, "still exactly one slice issue");
    assert.equal(engineStatus().slices[0].status, "approved_for_engineering");
    await done.getByRole("button", { name: "Done" }).click();
    await shoot(page, FOLDER, "11-ready-again");
  });

  const QUESTION = "FR-02 holds a seat for a pending invitation, but INV-03 counts only accepted members. Which one wins?";
  await step("11b the builders ask a question: quoted in Decisions; Answer it reopens the slice and its interview starts from it", async () => {
    world.onGithub(`issue = state["issues"][str(args[0])]
body = issue_rules.comment("question", ["SLICE-001@r2"], "0" * 32, question=args[1])["body"]
issue["comments"].append({"login": "erin-eng", "body": body, "created_at": "2026-11-17T12:00:00Z", "updated_at": "2026-11-17T12:00:00Z"})
issue["labels"] = [l for l in issue["labels"] if l["name"] not in issue_rules.SLICE_STATE_LABELS] + [{"name": "mach:question"}]`, issue, QUESTION);
    await go("/github");
    await main().getByRole("button", { name: "Refresh" }).click();
    await settle(page, 800);
    const [before] = engineStatus().slices;
    assert.equal(before.github.question, QUESTION);
    assert.equal(engineStatus().next_actions[0].kind, "answer_question");
    await go("/inbox");
    const card = main().getByRole("article", { name: /SLICE-001/ });
    await card.locator("blockquote").waitFor({ timeout: 20000 });
    assert.equal(await card.locator("blockquote").innerText(), QUESTION);
    await shoot(page, FOLDER, "11b-decisions-builders-question");
    const calls = world.claudeCalls().length;
    await card.getByRole("button", { name: /^Answer it/ }).click();
    await page.getByRole("dialog", { name: "Answer the builders' question on SLICE-001?" }).getByRole("button", { name: "Reopen and answer" }).click();
    await page.waitForURL(/#\/slices\/SLICE-001\/interview$/);
    assert.equal(engineStatus().slices[0].status, "interviewing");
    await main().locator("blockquote").getByText("Which one wins?", { exact: false }).waitFor();
    for (let i = 0; i < 100 && world.claudeCalls().length === calls; i++) await page.waitForTimeout(200);
    const opening = world.claudeCalls()[calls];
    assert.ok(opening, "the interview started");
    const message = opening.argv[opening.argv.length - 1];
    assert.match(message, /The builders have asked a question about this slice/);
    assert.ok(!message.includes("Which one wins"), "the question's text never goes in the opening message");
    await shoot(page, FOLDER, "11c-interview-on-the-question");
  });

  await step("12 nothing leaked, nothing reached the Factory, the checkout is untouched", async () => {
    const problems = await session.problems();
    assert.deepEqual(problems.external, [], "requests to other origins");
    assert.deepEqual(problems.csp, [], "CSP violations");
    assert.ok(!existsSync(join(world.pm, ".factory/local/runner.json")), ".factory/local/runner.json was written");
    // Outside .factory/studio, the Factory's folders are exactly what the scaffold left.
    assert.deepEqual(factoryEntries(), factory0, "something outside .factory/studio changed");
    assert.equal(engineStatus().factory_authorized, false);
    assert.deepEqual(world.checkout(), before0, "the PM's checkout changed");
  });

  await check("12b no API request failed during the lifecycle (engine refusals and joining an open interview aside)", async () => {
    const problems = await session.problems();
    // Joining an interview already open on this host is answered 409 with its ID, by contract ("Answer it" in 11b).
    assert.deepEqual(problems.apiFailures.filter((f) => !f.startsWith("422 ") && f !== "409 POST /api/interview"), []);
  });

  await check("12c no console error during the lifecycle (engine refusals aside)", async () => {
    const problems = await session.problems();
    assert.deepEqual([...new Set(problems.consoleErrors.filter((m) => !/status of (422|409)/.test(m)).map((m) => m.split("\n")[0]))], []);
  });
});

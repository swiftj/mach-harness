// The project home and the interview's layout, in the app built in fixture mode (no host, no
// engine): the home shows the fixture's epics and slices with the engine's states, the row of links
// comes first, the carry-on action is the engine's first next step, every secondary screen is reached
// from the "More" menu and from the row and leads back home, and the interview gives the question the
// larger half with the slice beside it. DOM checks only, plus axe in light and dark.
//
//   node --test --test-reporter=spec web/e2e/suites/home.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AxeBuilder } from "../lib/env.mjs";
import { openBrowser, settle, watchedPage } from "../lib/app.mjs";
import { cleanupFixtures, serveFixtures } from "../lib/fixtures.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Each secondary screen: its name in the menu and the row, where it leads, and the heading it opens on.
const SECONDARY = [
  { label: "Vision and outcomes", hash: "#/vision", heading: "Vision" },
  { label: "Roadmap", hash: "#/roadmap", heading: "Roadmap" },
  { label: "Decisions", hash: "#/inbox", heading: "Decisions" },
  { label: "Send to engineering", hash: "#/waves", heading: "Delivery waves" },
  { label: "Shared project", hash: "#/shared", heading: "Shared project" },
];
let browser, server;

before(async () => {
  server = await serveFixtures();
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await server?.stop();
  cleanupFixtures();
});

async function open(route, query = "") {
  const watched = await watchedPage(browser, server.origin);
  await watched.page.goto(server.at(route, query));
  await settle(watched.page, 600);
  return watched;
}

async function clean(watched) {
  const problems = await watched.problems();
  assert.deepEqual(problems.consoleErrors, [], "console errors");
  assert.deepEqual(problems.external, [], "requests to another origin");
  assert.deepEqual(problems.csp, [], "CSP violations");
}

async function axe(page) {
  const found = [];
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await settle(page, 200);
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const v of result.violations) found.push(`${theme}: ${v.id} ${v.help} at ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  }
  return found;
}

const home = (page) => page.getByRole("heading", { level: 1, name: "Team Space" });

test("the project home: name, vision, the row of links first, carry on, epics with their slices", async () => {
  const watched = await open("/");
  const { page } = watched;
  try {
    await home(page).waitFor();
    const main = page.getByRole("main");
    await main.getByText("Teams work together", { exact: false }).first().waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Main" }).count(), 0, "no navigation rail");

    // The row of links sits directly under the name and vision, before anything else on the page.
    const row = main.getByRole("navigation", { name: "Project" });
    const links = await row.getByRole("link").allInnerTexts();
    assert.deepEqual(links.slice(0, 2), ["Add an epic", "Edit the vision and outcomes"]);
    assert.ok(links.some((l) => /^\d+ requests? from other people$/.test(l)), `a request count among ${links.join(", ")}`);
    for (const { label } of SECONDARY.filter((s) => s.label !== "Vision and outcomes")) assert.ok(links.includes(label), `${label} in the row: ${links.join(", ")}`);
    const order = await main.evaluate((m) => {
      const at = (el) => [...m.querySelectorAll("*")].indexOf(el);
      return {
        row: at(m.querySelector('nav[aria-label="Project"]')),
        carry: at(m.querySelector('[aria-labelledby="carry-on-title"]')),
        epic: at(m.querySelector('[aria-labelledby^="epic-"]')),
      };
    });
    assert.ok(order.row >= 0 && order.row < order.carry && order.carry < order.epic, JSON.stringify(order));

    // Carry on: the engine's first next step (status.wave-approved: send WAVE-001), one primary button.
    const carry = main.getByRole("region", { name: "Send WAVE-001 to engineering" });
    await carry.getByText("It is approved and has not been sent yet.").waitFor();
    assert.equal(await carry.getByRole("button").count(), 1);

    // The epic and its slice, with the engine's state in words.
    const epic = main.getByRole("region", { name: "Team membership" });
    await epic.getByText("EPIC-001").waitFor();
    const slice = epic.getByRole("listitem").filter({ hasText: "Invite a teammate" });
    await slice.getByRole("link", { name: "Invite a teammate" }).waitFor();
    await slice.getByText("Approved", { exact: true }).waitFor();
    assert.equal(await slice.getByRole("link", { name: "Invite a teammate" }).getAttribute("href"), "#/slices/SLICE-001");
    await epic.getByRole("button", { name: "Add a slice to Team membership" }).waitFor();

    // Waves are not on the home page: only the one link leads to them.
    assert.equal(await main.getByText("WAVE-001", { exact: true }).count(), 0, "no wave shown on the home page");

    await carry.getByRole("button").click();
    await page.waitForURL(/#\/waves$/);
    await page.getByRole("heading", { level: 1, name: "Delivery waves" }).waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("the home page has no axe violation in light or dark", async () => {
  const watched = await open("/", "fixture=status.conflicts");
  try {
    await home(watched.page).waitFor();
    assert.deepEqual(await axe(watched.page), []);
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("what needs the PM's answer is one notice that leads to Decisions", async () => {
  const watched = await open("/", "fixture=status.conflicts");
  const { page } = watched;
  try {
    await home(page).waitFor();
    const main = page.getByRole("main");
    const notice = main.getByText(/things? needs? your answer/);
    await notice.waitFor();
    await main.getByText("3 items were changed both in your draft and in the shared project", { exact: false }).waitFor();
    await main.getByText("has 2 open questions", { exact: false }).waitFor();
    // Two slices still in interview, in the engine's own state.
    const epic = main.getByRole("region", { name: "People and access" });
    assert.equal(await epic.getByText("Interviewing", { exact: true }).count(), 2);
    await epic.getByRole("link", { name: /^Continue the interview: Invite a teammate$/ }).waitFor();
    // Carry on is the engine's first step here too: settle what disagrees.
    await main.getByRole("region", { name: "Settle what disagrees with the shared project" }).waitFor();
    await main.getByRole("link", { name: "Answer them" }).click();
    await page.getByRole("heading", { level: 1, name: "Decisions" }).waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("every secondary screen from the More menu, and back home from the breadcrumb", async (t) => {
  const watched = await open("/");
  const { page } = watched;
  try {
    await home(page).waitFor();
    for (const screen of SECONDARY) {
      await t.test(screen.label, async () => {
        await page.getByRole("button", { name: "More" }).click();
        const menu = page.getByRole("navigation", { name: "More" });
        await menu.waitFor();
        await menu.getByRole("link", { name: new RegExp(`^${screen.label}`) }).click();
        await menu.waitFor({ state: "detached" });
        await page.getByRole("heading", { level: 1, name: screen.heading }).waitFor();
        assert.ok(page.url().endsWith(screen.hash), page.url());
        const crumb = page.getByRole("navigation", { name: "Where you are" });
        await crumb.getByText(screen.label, { exact: true }).waitFor();
        await crumb.getByRole("link", { name: "Team Space" }).click();
        await home(page).waitFor();
      });
    }
    await t.test("the menu opens from the keyboard, Escape closes it and focus returns", async () => {
      const more = page.getByRole("button", { name: "More" });
      await more.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("navigation", { name: "More" }).waitFor();
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, "focus moved into the menu");
      await page.keyboard.press("Escape");
      await page.getByRole("navigation", { name: "More" }).waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "More");
    });
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("every secondary screen from the home page's row of links, and back", async (t) => {
  const watched = await open("/");
  const { page } = watched;
  try {
    await home(page).waitFor();
    for (const screen of SECONDARY) {
      await t.test(screen.label, async () => {
        const row = page.getByRole("main").getByRole("navigation", { name: "Project" });
        const name = screen.label === "Vision and outcomes" ? "Edit the vision and outcomes" : screen.label;
        await row.getByRole("link", { name, exact: true }).click();
        await page.getByRole("heading", { level: 1, name: screen.heading }).waitFor();
        await page.getByRole("button", { name: "More" }).click();
        await page.getByRole("navigation", { name: "More" }).getByRole("link", { name: /^Project home/ }).click();
        await home(page).waitFor();
      });
    }
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("the interview: the question takes the larger half, the slice builds up beside it", async () => {
  const watched = await open("/slices/SLICE-002/interview", "speed=fast");
  const { page } = watched;
  try {
    await page.getByRole("heading", { level: 1, name: /^Interview: / }).waitFor();
    const crumb = page.getByRole("navigation", { name: "Where you are" });
    await crumb.getByRole("link", { name: "Team Space" }).waitFor();
    await page.getByRole("button", { name: /^(Start|Continue) the interview$/ }).click();

    const ask = page.getByRole("region", { name: "Interview" });
    const doc = page.getByRole("complementary", { name: "The slice so far" });
    const question = ask.locator('section[aria-labelledby]').first();
    await ask.getByRole("button", { name: "Yes, accept" }).waitFor({ timeout: 20000 });

    // The larger half, on the left; the document on the right.
    const [a, d] = [await ask.boundingBox(), await doc.boundingBox()];
    assert.ok(a && d && a.x < d.x && a.width > d.width, `question ${JSON.stringify(a)} document ${JSON.stringify(d)}`);
    // The question in large type, the recommendation, yes primary, and the free-text answer.
    const sizes = await question.evaluate((s) => {
      const body = s.querySelector(".text-title-2");
      return { question: body ? parseFloat(getComputedStyle(body).fontSize) : 0, page: parseFloat(getComputedStyle(document.body).fontSize) };
    });
    assert.ok(sizes.question >= sizes.page * 1.3, JSON.stringify(sizes));
    await ask.getByText("Recommended", { exact: true }).waitFor();
    assert.match(await ask.getByRole("button", { name: "Yes, accept" }).getAttribute("class"), /bg-accent-fill/);
    await ask.getByRole("textbox", { name: /Or answer in your own words/ }).waitFor();
    await ask.getByText("Question 1", { exact: true }).waitFor();
    // The slice as a readable document, with the engine's check.
    await doc.getByRole("heading", { level: 2 }).waitFor();
    await doc.getByRole("region", { name: "Engine check" }).waitFor();

    // Answering moves on; what was settled is listed under the question.
    await ask.getByRole("button", { name: "Yes, accept" }).click();
    const settled = ask.getByRole("region", { name: "Settled so far" });
    await settled.waitFor({ timeout: 20000 });
    await settled.getByText("Accepted", { exact: true }).waitFor();
    await ask.getByText("Question 2", { exact: true }).waitFor({ timeout: 20000 });
    await page.getByText("The whole conversation").waitFor();
    assert.deepEqual(await axe(page), []);
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("when nothing is open, the interview offers the approval, confirmed in a dialog that says what it means", async () => {
  const watched = await open("/slices/SLICE-001/interview", "show=ready");
  const { page } = watched;
  try {
    const ask = page.getByRole("region", { name: "Interview" });
    await ask.getByRole("heading", { level: 2, name: "Nothing is left open. Read it through, then approve it." }).waitFor();
    await ask.getByText("Nothing goes to engineering until you send it in a delivery wave.", { exact: false }).waitFor();
    await ask.getByRole("link", { name: "Keep it as a draft" }).waitFor();
    const approve = ask.getByRole("button", { name: "Approve SLICE-001" });
    assert.match(await approve.getAttribute("class"), /bg-accent-fill/, "approving is the primary button");
    await approve.click();
    const dialog = page.getByRole("dialog", { name: "Approve SLICE-001?" });
    await dialog.getByText("It freezes the slice until you reopen it.", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await approve.click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve SLICE-001" }).click();
    await home(page).waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("what the latest write added to the slice is marked, in words", async () => {
  const watched = await open("/slices/SLICE-002/interview", "speed=fast");
  const { page } = watched;
  try {
    await page.getByRole("button", { name: /^(Start|Continue) the interview$/ }).click();
    const ask = page.getByRole("region", { name: "Interview" });
    const doc = page.getByRole("complementary", { name: "The slice so far" });
    await doc.getByText("FR-01", { exact: true }).waitFor({ timeout: 20000 });
    await ask.getByRole("button", { name: "Yes, accept" }).waitFor({ timeout: 20000 });
    assert.equal(await doc.getByText("New", { exact: true }).count(), 0, "nothing is marked on the first read");
    // Answer every turn of the scripted interview until it writes the specification up.
    for (let turn = 0; turn < 12 && !(await doc.getByText("INV-01", { exact: true }).count()); turn++) {
      // Act only once the interviewer has finished its turn.
      await page.getByRole("status").filter({ hasText: "Waiting for you" }).waitFor({ timeout: 30000 });
      const accept = ask.getByRole("button", { name: "Yes, accept" });
      if (await accept.count()) await accept.click();
      else {
        await ask.getByRole("textbox", { name: /Your reply|Does this capture the intent/ }).fill("yes");
        await ask.getByRole("button", { name: "Send reply" }).click();
      }
      await page.getByRole("status").filter({ hasText: "Waiting for you" }).waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    }
    const added = doc.getByRole("listitem").filter({ hasText: "INV-01" });
    await added.getByText("New", { exact: true }).waitFor({ timeout: 30000 });
    const kept = doc.getByRole("listitem").filter({ hasText: "FR-01" }).first();
    assert.equal(await kept.getByText("New", { exact: true }).count(), 0, "a statement that was already there is not marked");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

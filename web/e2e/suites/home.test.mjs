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
  { label: "On GitHub", hash: "#/github", heading: "On GitHub" },
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
const SIGN_IN_NOTE = "An issue in a private repository opens only in a browser signed in to GitHub with access to it.";

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
    // "Add an epic" opens a dialog here, so it is a button; the links follow.
    assert.equal(await row.getByRole("button").first().innerText(), "Add an epic");
    const links = await row.getByRole("link").allInnerTexts();
    assert.deepEqual(links.slice(0, 1), ["Edit the vision and outcomes"]);
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

    // Carry on: the engine's first next step (status.rich: answer the builders' question on SLICE-002), one primary button.
    const carry = main.getByRole("region", { name: "Answer the builders' question on SLICE-002" });
    await carry.getByText("The builders need your answer", { exact: false }).waitFor();
    assert.equal(await carry.getByRole("button").count(), 1);

    // The epic and its slices, with the engine's states in words: the draft's, and where it is with the builders.
    const epic = main.getByRole("region", { name: "Team membership" });
    await epic.getByText("EPIC-001").waitFor();
    await epic.getByRole("link", { name: /^#2/ }).waitFor();
    const slice = epic.getByRole("listitem").filter({ hasText: "Invite a teammate" }).first();
    await slice.getByRole("link", { name: "Invite a teammate", exact: true }).waitFor();
    await slice.getByText("Approved", { exact: true }).waitFor();
    await slice.getByText("Being built", { exact: true }).waitFor();
    assert.equal(await slice.getByRole("link", { name: "Invite a teammate", exact: true }).getAttribute("href"), "#/slices/SLICE-001");
    assert.equal(await slice.getByRole("link", { name: /^#3/ }).getAttribute("href"), "https://github.com/acme/team-space/issues/3");
    await epic.getByRole("listitem").filter({ hasText: "Remove a teammate" }).getByText("Question from the builders", { exact: true }).waitFor();
    await epic.getByRole("listitem").filter({ hasText: "Resend an invitation" }).getByText("Shipped", { exact: true }).waitFor();
    await epic.getByRole("button", { name: "Add a slice to Team membership" }).waitFor();
    // The project's issue number, as the engine reports it.
    await main.getByRole("link", { name: /^#1/ }).waitFor();

    // An approved slice is reopened first: the act is confirmed in a dialog.
    await carry.getByRole("button").click();
    await page.getByRole("dialog", { name: "Answer the builders' question on SLICE-002?" }).waitFor();
    await page.keyboard.press("Escape");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("each epic says how many slices are ready or further, and each slice when it got where it is", async () => {
  const watched = await open("/");
  const { page } = watched;
  try {
    await home(page).waitFor();
    const epic = page.getByRole("main").getByRole("region", { name: "Team membership" });
    await epic.getByText("2 of 6 slices ready or further", { exact: false }).waitFor();
    await epic.getByText("Ready or further means marked ready to build, being built, or shipped.", { exact: true }).waitFor();
    // The shipped slice says when, in words, with the exact time for assistive technology and on focus.
    const shipped = epic.getByRole("listitem").filter({ hasText: "Resend an invitation" });
    await shipped.getByText("Shipped", { exact: false }).first().waitFor();
    const time = shipped.locator("time");
    assert.equal(await time.getAttribute("datetime"), "2026-11-17T14:00:20Z");
    assert.match(await time.getAttribute("aria-label"), /2026/);
    // From the keyboard: Tab from the slice's title reaches the time, which shows the exact moment; and on hover.
    await shipped.getByRole("link", { name: "Resend an invitation", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TIME");
    await page.locator("[data-radix-popper-content-wrapper]").getByText(/2026/).first().waitFor();
    await time.hover();
    await page.locator("[data-radix-popper-content-wrapper]").getByText(/2026/).first().waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("the top bar says everything is saved, or what is not, in the engine's words", async () => {
  const saved = await open("/");
  try {
    await home(saved.page).waitFor();
    await saved.page.getByRole("banner").getByText("Everything is saved", { exact: true }).waitFor();
    await clean(saved);
  } finally {
    await saved.context.close();
  }
  const unsaved = await open("/", "fixture=status.offline");
  const { page } = unsaved;
  try {
    await home(page).waitFor();
    const top = page.getByRole("banner");
    await top.getByText("2 things are not saved yet", { exact: true }).waitFor();
    await top.getByRole("button", { name: /Connection/ }).click();
    await page.getByText("Saving SLICE-009 to GitHub stopped part way. Mark it ready again to finish.", { exact: true }).waitFor();
    await page.getByText("The last check of GitHub did not finish: GitHub could not be reached.", { exact: true }).waitFor();
    await clean(unsaved);
  } finally {
    await unsaved.context.close();
  }
});

test("Add an epic opens a dialog on the project home", async () => {
  const watched = await open("/");
  const { page } = watched;
  try {
    await home(page).waitFor();
    await page.getByRole("main").getByRole("navigation", { name: "Project" }).getByRole("button", { name: "Add an epic" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Title" }).waitFor();
    assert.ok(page.url().endsWith("#/"), page.url());
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("the builders' question: quoted on Decisions, and Answer it reopens the slice and opens its interview", async () => {
  const watched = await open("/inbox");
  const { page } = watched;
  try {
    const main = page.getByRole("main");
    await main.getByRole("heading", { level: 1, name: "Decisions" }).waitFor();
    const card = main.getByRole("article", { name: /SLICE-002/ });
    await card.getByRole("heading", { name: "The builders' question" }).waitFor();
    const quote = card.locator("blockquote");
    assert.match(await quote.innerText(), /^FR-02 says a pending invitation holds a seat/);
    assert.deepEqual(await quote.evaluate((el) => [...el.childNodes].map((n) => n.nodeType)), [3], "the question is one text node");
    await card.getByText("Written by the builders on the slice's issue", { exact: false }).waitFor();
    await card.getByRole("button", { name: /^Answer it/ }).click();
    const dialog = page.getByRole("dialog", { name: "Answer the builders' question on SLICE-002?" });
    await dialog.getByText("The interview starts from their question.", { exact: false }).waitFor();
    assert.deepEqual(await axe(page), []);
    await dialog.getByRole("button", { name: "Reopen and answer" }).click();
    await page.waitForURL(/#\/slices\/SLICE-002\/interview$/);
    await page.getByRole("heading", { level: 1, name: /^Interview: / }).waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("a slice the builders asked about shows their question beside its specification", async () => {
  const watched = await open("/slices/SLICE-001", "show=question");
  const { page } = watched;
  try {
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "The builders' question" }).waitFor();
    await main.locator("blockquote").getByText("Which one wins?", { exact: false }).waitFor();
    await main.getByRole("button", { name: /^Answer it/ }).waitFor();
    await main.getByText("Marked ready", { exact: false }).first().waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("each epic lists its slices in the engine's order, and Move up / Move down set it, announcing the engine's note", async () => {
  const watched = await open("/");
  const { page } = watched;
  try {
    await home(page).waitFor();
    const epic = page.getByRole("main").getByRole("region", { name: "Team membership" });
    const titles = await epic.locator("li a[href^='#/slices/SLICE-']").allInnerTexts();
    assert.deepEqual(titles.slice(0, 3), ["Invite a teammate", "Remove a teammate", "Resend an invitation"]);
    assert.equal(await epic.getByRole("button", { name: "Move Invite a teammate up" }).isDisabled(), true, "the first cannot move up");
    const down = epic.getByRole("button", { name: "Move Invite a teammate by email down" });
    assert.equal(await down.isDisabled(), true, "the last cannot move down");
    const up = epic.getByRole("button", { name: "Move Resend an invitation up" });
    await up.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((n) => /The order of EPIC-001 is saved/.test(n.textContent ?? "")));
    assert.equal(await page.getByRole("dialog").count(), 0, "a move is not confirmed");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
  const unfinished = await open("/", "fixture=status.move-unfinished");
  try {
    const epic = unfinished.page.getByRole("main").getByRole("region", { name: "Team membership" });
    await epic.getByText("Your new order is saved here but is not yet in place on GitHub.", { exact: false }).waitFor();
    await epic.getByRole("button", { name: "Finish the move" }).click();
    await unfinished.page.waitForFunction(() => [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((n) => /The order of EPIC-001 is saved/.test(n.textContent ?? "")));
    await clean(unfinished);
  } finally {
    await unfinished.context.close();
  }
});

test("On GitHub: one line says a private repository's issue opens only when signed in, once, not beside each link", async () => {
  const watched = await open("/github", "fixture=status.on-github");
  const { page } = watched;
  try {
    const main = page.getByRole("main");
    const where = main.getByRole("region", { name: "The project and its epics" });
    await where.getByText("Saved in the repository", { exact: false }).waitFor();
    assert.equal(await main.getByText(SIGN_IN_NOTE, { exact: true }).count(), 1, "said once on the screen");
    assert.equal(await where.getByText(SIGN_IN_NOTE, { exact: true }).count(), 1, "under the repository it names");
    assert.ok((await main.getByRole("link", { name: /^#\d+/ }).count()) > 1, "the screen holds several issue links");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("On GitHub: a slice someone else saved offers Open it here, confirmed, then goes to the slice; a refusal keeps the engine's words and its hint", async () => {
  const watched = await open("/github", "fixture=status.elsewhere&refresh=refresh.elsewhere");
  const { page } = watched;
  try {
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Refresh" }).click();
    const others = main.getByRole("region", { name: "Saved by others" });
    await others.getByRole("button", { name: /^Open it here/ }).click();
    const dialog = page.getByRole("dialog", { name: "Open SLICE-001 in your workspace?" });
    await dialog.getByText("Nothing changes on GitHub.", { exact: false }).waitFor();
    assert.deepEqual(await axe(page), []);
    await dialog.getByRole("button", { name: "Open it here" }).click();
    await page.waitForURL(/#\/slices\/SLICE-001$/);
    await page.getByText("is now in your workspace exactly as #3 holds it", { exact: false }).first().waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
  const refused = await open("/github", "fixture=status.elsewhere&refresh=refresh.elsewhere&take=refused");
  try {
    const main = refused.page.getByRole("main");
    await main.getByRole("button", { name: "Refresh" }).click();
    await main.getByRole("region", { name: "Saved by others" }).getByRole("button", { name: /^Open it here/ }).click();
    const dialog = refused.page.getByRole("dialog", { name: "Open SLICE-001 in your workspace?" });
    await dialog.getByRole("button", { name: "Open it here" }).click();
    await dialog.getByText("EPIC-001 here is a different epic. Give your epic a new number first", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Give EPIC-001 a new number" }).waitFor();
  } finally {
    await refused.context.close();
  }
});

test("the home page has no axe violation in light or dark", async () => {
  const watched = await open("/", "fixture=status.states");
  try {
    await home(watched.page).waitFor();
    assert.deepEqual(await axe(watched.page), []);
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("what needs the PM's answer is one notice that leads to Decisions", async () => {
  const watched = await open("/", "fixture=status.states");
  const { page } = watched;
  try {
    await home(page).waitFor();
    const main = page.getByRole("main");
    await main.getByText(/things? needs? your answer/).waitFor();
    await main.getByText("the builders will not take it until you mark it ready again", { exact: false }).waitFor();
    await main.getByText("The builders have a question about", { exact: false }).waitFor();
    // The edited slice says so, in words and a shape.
    const edited = main.getByRole("listitem").filter({ hasText: "Rename a teammate" });
    await edited.getByText("Changed on GitHub after you approved it", { exact: true }).waitFor();
    // Carry on is the engine's first step here too: the builders' question comes first.
    await main.getByRole("region", { name: "Answer the builders' question on SLICE-002" }).waitFor();
    await main.getByRole("link", { name: "Answer them" }).click();
    await page.getByRole("heading", { level: 1, name: "Decisions" }).waitFor();
    const decisions = page.getByRole("main");
    await decisions.getByRole("heading", { level: 2, name: /Changed on GitHub after you approved it/ }).waitFor();
    await decisions.getByRole("heading", { level: 2, name: /Questions from the builders/ }).waitFor();
    assert.deepEqual(await axe(page), []);
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("Decisions: a newer version to choose and a number already taken, each confirmed in a dialog", async () => {
  const watched = await open("/inbox", "fixture=status.number-taken");
  const { page } = watched;
  try {
    const main = page.getByRole("main");
    await main.getByRole("heading", { level: 1, name: "Decisions" }).waitFor();
    const taken = main.getByRole("article", { name: /SLICE-005/ });
    await taken.getByText("Number already taken", { exact: true }).waitFor();
    await taken.getByRole("button", { name: "Give SLICE-005 a new number" }).click();
    const dialog = page.getByRole("dialog", { name: "Give SLICE-005 a new number?" });
    await dialog.getByRole("button", { name: "Give it a new number" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("SLICE-005 is now SLICE-006", { exact: true }).waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
  const newer = await open("/inbox", "fixture=status.newer-elsewhere");
  try {
    const main = newer.page.getByRole("main");
    const card = main.getByRole("article", { name: /SLICE-004/ });
    await card.getByText("Newer version saved by someone else", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Take their version" }).click();
    const dialog = newer.page.getByRole("dialog", { name: "Take the newer version of SLICE-004?" });
    await dialog.getByText("It does not become ready", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Take their version" }).click();
    await dialog.waitFor({ state: "detached" });
    await newer.page.getByText("Your draft now holds the version from GitHub.", { exact: false }).first().waitFor();
    assert.deepEqual(await axe(newer.page), []);
    await clean(newer);
  } finally {
    await newer.context.close();
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
    await doc.getByRole("heading", { level: 2 }).filter({ hasNotText: /^Check$/ }).first().waitFor();
    await doc.getByRole("heading", { name: "Check", exact: true }).waitFor();

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

test("when nothing is open, the interview offers to mark it ready, confirmed in a dialog that says what it does", async () => {
  const watched = await open("/slices/SLICE-001/interview", "show=ready");
  const { page } = watched;
  try {
    const ask = page.getByRole("region", { name: "Interview" });
    await ask.getByRole("heading", { level: 2, name: "Nothing is left open. Read it through, then mark it ready to build." }).waitFor();
    await ask.getByText("tells the builders it is ready", { exact: false }).waitFor();
    await ask.getByRole("link", { name: "Keep it as a draft" }).waitFor();
    const mark = ask.getByRole("button", { name: "Mark ready to build" });
    assert.match(await mark.getAttribute("class"), /bg-accent-fill/, "marking it ready is the primary button");
    await mark.click();
    const dialog = page.getByRole("dialog", { name: "Mark SLICE-001 ready to build?" });
    await dialog.getByText("saves the slice to the project on GitHub, under the epic “Team membership” (EPIC-001)", { exact: false }).waitFor();
    await dialog.getByText("records that you approved exactly this text", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await mark.click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark ready to build" }).click();
    // Where it was saved: the issue the engine returned, as a link.
    const done = page.getByRole("dialog", { name: "SLICE-001 is ready to build" });
    await done.getByText("Saved to GitHub as #3 and marked ready.", { exact: false }).waitFor();
    assert.equal(await done.getByRole("link", { name: /^#3/ }).getAttribute("href"), "https://github.com/acme/team-space/issues/3");
    // One quiet line under the link: a private repository's issue needs a browser signed in to GitHub. Said once.
    assert.equal(await done.getByText(SIGN_IN_NOTE, { exact: true }).count(), 1, "the sign-in note is under the issue link, once");
    assert.deepEqual(await axe(page), []);
    await done.getByRole("button", { name: "Done" }).click();
    await home(page).waitFor();
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("without GitHub, the slice is saved to a folder and the engine's two ways on are shown as written", async () => {
  const watched = await open("/slices/SLICE-001", "show=ready&ready=folder");
  const { page } = watched;
  try {
    await page.getByRole("main").getByRole("button", { name: "Mark ready to build" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark ready to build" }).click();
    const done = page.getByRole("dialog", { name: "SLICE-001 is ready to build" });
    // Saved, where, and the next step (the M16 dialog's three rows); why it went to a folder is the reference, folded.
    await done.getByText("In a folder, not on GitHub", { exact: true }).waitFor();
    await done.getByText("/project/.factory/studio/draft/product/ready/SLICE-001", { exact: true }).waitFor();
    for (const way of ["Add this folder to the project's repository; the builders take it from there.", "Or hand the folder to the engineer, who brings it in with MACH."]) {
      await done.getByText(way, { exact: true }).waitFor();
    }
    const why = done.getByRole("button", { name: "Why it went to a folder" });
    assert.equal(await why.getAttribute("aria-expanded"), "false");
    await why.click();
    await done.getByText("You are not signed in to GitHub on this computer.", { exact: true }).waitFor();
    assert.equal(await done.getByRole("link").count(), 0, "no issue link for a folder");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

/** True when the element is inside the viewport and is what is drawn at its centre: nothing clips or covers it, and no scrolling is needed. */
async function inView(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
}

// "ready": the check passes. "errors": the check lists its problems above the refusal, the longest dialog.
for (const [width, height, show] of [
  [1440, 900, "ready"],
  [1440, 900, "errors"],
  [1100, 800, "ready"],
  [1100, 800, "errors"],
]) {
  test(`at ${width}x${height} (check: ${show}), a refusal and its way on are in view in the mark-ready dialog, and pressing again shows it working, then the new result`, async () => {
    const watched = await open("/slices/SLICE-001", `show=${show}&ready=refused-once`);
    const { page } = watched;
    try {
      await page.setViewportSize({ width, height });
      await settle(page, 200);
      await page.getByRole("main").getByRole("button", { name: "Mark ready to build" }).click();
      const dialog = page.getByRole("dialog", { name: /^Mark SLICE-\d+ ready to build\?$/ });
      const press = dialog.getByRole("button", { name: "Mark ready to build" });
      await press.click();
      // The app's own title, then the engine's reasons alone: no second heading from the engine.
      const refusal = dialog.getByRole("alert");
      const title = refusal.getByText(/^SLICE-\d+ was not marked ready$/);
      await title.waitFor();
      const words = await refusal.innerText();
      assert.match(words, /SLICE-005 is already used on GitHub by another slice \(#77\)\. Give your draft a new number, then mark it ready\./);
      assert.doesNotMatch(words, /cannot be marked ready yet/, "the engine does not repeat a heading under the app's title");
      assert.doesNotMatch(words, /epic/i, "no refusal speaks of an epic");
      const way = refusal.getByRole("button", { name: "Give SLICE-005 a new number" });
      await way.waitFor();
      await settle(page, 300);
      assert.ok(await inView(title), "the refusal's title is in view without scrolling");
      assert.ok(await inView(way), "the refusal's way on is in view without scrolling");
      assert.ok(await inView(press), "Mark ready to build is in view without scrolling");

      // Pressed again: the button shows it is working, the old refusal is gone, then the new result.
      await press.click();
      await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] button[aria-busy="true"]').length === 1, null, { timeout: 1000 });
      assert.equal(await dialog.getByRole("alert").count(), 0, "the earlier refusal is cleared while it works");
      const done = page.getByRole("dialog", { name: /^SLICE-\d+ is ready to build$/ });
      await done.getByText("Saved to GitHub as #3 and marked ready.", { exact: false }).waitFor();
      await clean(watched);
    } finally {
      await watched.context.close();
    }
  });
}

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
    let sawSummaryYes = false;
    // Answer every turn of the scripted interview until it writes the specification up.
    for (let turn = 0; turn < 12 && !(await doc.getByText("INV-01", { exact: true }).count()); turn++) {
      // Act only once the interviewer has finished its turn.
      await page.getByRole("status").filter({ hasText: "Waiting for you" }).waitFor({ timeout: 30000 });
      const accept = ask.getByRole("button", { name: "Yes, accept" });
      // The summary to confirm has the same one-press yes as a question; its text box is for what is missing.
      const writeUp = ask.getByRole("button", { name: "Yes, write it up" });
      if (await accept.count()) await accept.click();
      else if (await writeUp.count()) {
        await ask.getByRole("textbox", { name: "Or say what is missing or needs refining" }).waitFor();
        sawSummaryYes = true;
        await writeUp.click();
      } else {
        await ask.getByRole("textbox", { name: "Your reply" }).fill("yes");
        await ask.getByRole("button", { name: "Send reply" }).click();
      }
      await page.getByRole("status").filter({ hasText: "Waiting for you" }).waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    }
    assert.ok(sawSummaryYes, "the summary to confirm offered a Yes button, and pressing it had the specification written up");
    const added = doc.getByRole("listitem").filter({ hasText: "INV-01" });
    await added.getByText("New", { exact: true }).waitFor({ timeout: 30000 });
    const kept = doc.getByRole("listitem").filter({ hasText: "FR-01" }).first();
    assert.equal(await kept.getByText("New", { exact: true }).count(), 0, "a statement that was already there is not marked");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("the summary to confirm takes focus, says Y writes it up, and Y does so only when it should", async () => {
  const watched = await open("/slices/SLICE-002/interview", "speed=fast");
  const { page } = watched;
  try {
    await page.getByRole("button", { name: /^(Start|Continue) the interview$/ }).click();
    const ask = page.getByRole("region", { name: "Interview" });
    const waiting = page.getByRole("status").filter({ hasText: "Waiting for you" });
    const writeUp = ask.getByRole("button", { name: "Yes, write it up" });
    // Answer each turn of the scripted interview until the summary to confirm arrives.
    for (let turn = 0; turn < 10 && !(await writeUp.count()); turn++) {
      await waiting.waitFor({ timeout: 30000 });
      if (await writeUp.count()) break;
      const accept = ask.getByRole("button", { name: "Yes, accept" });
      if (await accept.count()) await accept.click();
      else {
        await ask.getByRole("textbox", { name: "Your reply" }).fill("yes");
        await ask.getByRole("button", { name: "Send reply" }).click();
      }
      await waiting.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    }
    await writeUp.waitFor({ timeout: 30000 });

    // Focus lands on the summary, a region named for what it is; its hint is read inside it, as a question's is.
    const summary = ask.getByRole("region", { name: "Summary to confirm" });
    await summary.waitFor();
    assert.ok(await summary.evaluate((el) => el === document.activeElement), "the summary has focus when it arrives");
    assert.match(await summary.innerText(), /Y\s*writes it up/, "the hint sits with the button");
    assert.equal(await summary.locator("kbd").innerText(), "Y");

    // Typing in the reply box is typing: Y goes into the text and nothing is sent.
    const box = ask.getByRole("textbox", { name: "Or say what is missing or needs refining" });
    await box.click();
    await page.keyboard.press("y");
    assert.equal(await box.inputValue(), "y");
    await box.fill("");
    // With a modifier held, Y is not the shortcut.
    await summary.focus();
    for (const chord of ["Control+y", "Meta+y", "Alt+y"]) await page.keyboard.press(chord);
    await settle(page, 300);
    assert.equal(await writeUp.count(), 1, "nothing was sent by Y in the text box or with a modifier");
    await waiting.waitFor();

    // Y alone, with the summary focused, confirms it: the interviewer goes on to write it up.
    await summary.focus();
    await page.keyboard.press("y");
    await writeUp.waitFor({ state: "detached", timeout: 5000 });
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

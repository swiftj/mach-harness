// The Requests group of the Decisions inbox (M8 design D8), in the app built in fixture mode: every
// state renders, each offers exactly the buttons it should, a pick-up is read back from the engine's
// list rather than assumed, a refusal is shown in the engine's words, and axe finds nothing.
// Pages are checked by DOM text and attributes only.
//
//   node --test --test-reporter=spec web/e2e/suites/requests.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AxeBuilder } from "../lib/env.mjs";
import { openBrowser, settle, watchedPage } from "../lib/app.mjs";
import { cleanupFixtures, serveFixtures } from "../lib/fixtures.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ACTIONS = ["Pick up", "Pick up as well", "Link a draft slice", "Mark as met"];
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

async function open(scenario, extra) {
  const watched = await watchedPage(browser, server.origin);
  await watched.page.goto(server.url(scenario, extra));
  await watched.page.getByRole("heading", { level: 1, name: "Decisions" }).waitFor();
  await settle(watched.page);
  return watched;
}

const card = (page, n) => page.getByRole("article", { name: `Request #${n}`, exact: true });

async function buttons(page, n) {
  const shown = [];
  for (const name of ACTIONS) if (await card(page, n).getByRole("button", { name, exact: true }).count()) shown.push(name);
  return shown;
}

async function clean(watched) {
  const problems = await watched.problems();
  assert.deepEqual(problems.consoleErrors, [], "console errors");
  assert.deepEqual(problems.external, [], "requests to another origin");
  assert.deepEqual(problems.csp, [], "CSP violations");
}

test("every state of D8 renders with its own buttons", async () => {
  const watched = await open("all");
  const { page } = watched;
  try {
    const section = page.locator("section#requests");
    assert.equal(await section.getByRole("heading", { level: 2 }).innerText(), "Requests (6)");
    assert.equal(await section.getByRole("article").count(), 6);
    assert.match(await section.innerText(), /2 updates to GitHub are waiting and will be sent on the next refresh\./);

    // Accepted, not picked up.
    assert.deepEqual(await buttons(page, 41), ["Pick up", "Link a draft slice"]);
    assert.match(await card(page, 41).innerText(), /Labelled as a request by @riley-lead/);
    const github = card(page, 41).getByRole("link", { name: /^View on GitHub/ });
    assert.equal(await github.getAttribute("href"), "https://github.com/team-space/app/issues/41");
    assert.equal(await github.getAttribute("rel"), "noopener noreferrer");

    // Not accepted: the reason, no Pick up.
    assert.deepEqual(await buttons(page, 42), []);
    assert.match(await card(page, 42).innerText(), /Not accepted as a request/);
    assert.match(await card(page, 42).innerText(), /@casey-guest, who cannot change this repository/);
    assert.equal(await card(page, 42).getByRole("link", { name: /^View on GitHub/ }).count(), 1);

    // Picked up by someone else.
    assert.deepEqual(await buttons(page, 43), ["Pick up as well", "Link a draft slice"]);
    assert.match(await card(page, 43).innerText(), /Picked up by @sam-pm/);

    // Picked up by you, with an approved slice: linked slices and Mark as met.
    assert.deepEqual(await buttons(page, 44), ["Link a draft slice", "Mark as met"]);
    assert.match(await card(page, 44).innerText(), /Picked up by you/);
    assert.equal(await card(page, 44).getByRole("link", { name: /SLICE-001/ }).getAttribute("href"), "#/slices/SLICE-001");

    // Changed since picked up; its slice is not approved, so no Mark as met.
    assert.deepEqual(await buttons(page, 45), ["Link a draft slice"]);
    assert.match(await card(page, 45).innerText(), /This request changed on GitHub after it was picked up\. What was approved is unchanged\./);

    // Handled by engineering's automation: shown, nothing to do, no link.
    assert.deepEqual(await buttons(page, 46), []);
    assert.equal(await card(page, 46).getByRole("link").count(), 0);
    assert.match(await card(page, 46).innerText(), /Handled automatically by engineering/);

    // The group is listed among the kinds of decision.
    assert.equal(await page.getByRole("navigation", { name: "Decisions by kind" }).getByRole("link", { name: /^Requests/ }).count(), 1);
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("offline, not checked yet, empty, and no GitHub remote", async () => {
  for (const [scenario, check] of [
    ["offline", async (page) => {
      const text = await page.locator("section#requests").innerText();
      assert.match(text, /GitHub could not be reached/);
      assert.match(text, /Last checked /);
      assert.equal(await page.locator("section#requests").getByRole("article").count(), 3, "the cached list is still shown");
    }],
    ["never", async (page) => assert.match(await page.locator("section#requests").innerText(), /Not checked with GitHub yet/)],
    ["empty", async (page) => assert.match(await page.locator("section#requests").innerText(), /No open requests\./)],
    ["none", async (page) => {
      assert.equal(await page.locator("section#requests").count(), 0);
      assert.doesNotMatch(await page.locator("main").innerText(), /GitHub|Requests/);
    }],
  ]) {
    const watched = await open(scenario);
    try {
      await check(watched.page);
      await clean(watched);
    } finally {
      await watched.context.close();
    }
  }
});

test("Pick up starts a slice only on the click, and the card is read back from the list", async () => {
  const watched = await open("all");
  const { page } = watched;
  try {
    await card(page, 41).getByRole("button", { name: "Pick up", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Pick up request #41?" });
    await dialog.getByRole("textbox", { name: /Slice title/ }).fill("Export a monthly report");
    await dialog.getByRole("button", { name: "Pick up", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await card(page, 41).getByText("Picked up by you").waitFor();
    assert.deepEqual(await buttons(page, 41), ["Link a draft slice"]);
    assert.equal(await card(page, 41).getByRole("link", { name: /SLICE-005/ }).getAttribute("href"), "#/slices/SLICE-005");
    await clean(watched);
  } finally {
    await watched.context.close();
  }
});

test("a refusal is shown in the engine's own words", async () => {
  const watched = await open("all", "refuse=1");
  const { page } = watched;
  try {
    await card(page, 44).getByRole("button", { name: "Mark as met", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Mark request #44 as met?" });
    await dialog.getByRole("button", { name: "Mark as met", exact: true }).click();
    await dialog.getByText("Request #44 has no approved slice yet.", { exact: false }).waitFor();
    assert.match(
      await dialog.innerText(),
      /Request #44 has no approved slice yet\. A request is marked as met only once at least one slice made from it is approved\./,
    );
    await dialog.getByRole("button", { name: "Not now" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await card(page, 44).count(), 1, "nothing changed: the request is still listed");
  } finally {
    await watched.context.close();
  }
});

test("axe finds nothing on the Inbox with requests, light and dark", async () => {
  for (const colorScheme of ["light", "dark"]) {
    const watched = await watchedPage(browser, server.origin, { colorScheme });
    try {
      await watched.page.goto(server.url("all"));
      await watched.page.locator("section#requests article").first().waitFor();
      await settle(watched.page);
      const result = await new AxeBuilder({ page: watched.page }).withTags(TAGS).analyze();
      assert.deepEqual(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), [], colorScheme);
    } finally {
      await watched.context.close();
    }
  }
});

/* global window, document */
// The Line, the Factory Floor's default workspace, in a real browser on the dev server, over the
// Simulation. The development hook holds the simulation at a chosen moment on its manual clock, so
// every assertion reads a known state. No screenshot or recording is taken: the assertions read the
// page's structure, its words, the address and the requests the page made.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AxeBuilder } from "@axe-core/playwright";
import { consoleErrors, ensureStack, launch, openApp, sceneReady, sleep } from "../scripts/e2e-lib.mjs";

/** LOCAL-032 waits for a person's approval; LOCAL-031 and LOCAL-033 have landed; LOCAL-034 is being built. */
const AT = 2_900_000;
let browser;

before(async () => {
  await ensureStack();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

/** The Simulation on the Line, held at `at` on the manual clock. */
async function openLine(hash = "#line", options = {}) {
  const { page, context } = await openApp(browser, null, `?simulation${hash}`, { waitReady: false, ...options });
  await sceneReady(page);
  await page.waitForFunction(() => Boolean(window.__machSim), undefined, { timeout: 15_000 });
  await page.evaluate((t) => {
    window.__machSim.useManualClock();
    window.__machSim.seek(t);
  }, AT);
  await page.locator("[data-line-row='LOCAL-032'][data-line-state='person']").waitFor({ timeout: 15_000 });
  return { page, context };
}

describe("the Line over the Simulation", () => {
  test("stations as columns and each ticket a row, at its station, in its state, with Needs you on top", async () => {
    const { page, context } = await openLine();
    try {
      assert.equal(await page.locator("[data-workspace-shown='line']").count(), 1, "the Line is the default workspace");
      assert.deepEqual(await page.locator("[data-station-heading]").evaluateAll((els) => els.map((e) => e.getAttribute("data-station-heading"))), ["groom", "plan", "build", "verify", "review", "merge", "cleanup"]);
      const rows = await page.locator("[data-line-row]").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-line-row"), e.getAttribute("data-line-state")])));
      assert.equal(rows["LOCAL-032"], "person");
      assert.equal(rows["LOCAL-034"], "working");
      assert.equal(rows["LOCAL-031"], "landed");
      assert.equal(rows["LOCAL-035"], "held");
      // Each state has its own shape as well as its colour.
      for (const state of ["person", "working", "landed", "held"]) assert.equal(await page.locator(`[data-line-row] [data-marker='${state}'] [data-state-shape='${state}']`).count() >= 1, true, `${state} has its shape`);
      // A row's button is named by ID and state only, never its title.
      assert.equal(await page.locator("[data-line-row='LOCAL-032'] [data-row-button]").getAttribute("aria-label"), "LOCAL-032: Waiting for you, before Merge");
      // Needs you lists the one ticket waiting for a person.
      assert.deepEqual(await page.locator("[data-need]").evaluateAll((els) => els.map((e) => e.getAttribute("data-need"))), ["LOCAL-032"]);
      assert.match(await page.locator("[data-need='LOCAL-032']").innerText(), /Approve or send back/);
      // Work sent back is drawn with its count.
      assert.ok((await page.locator("[data-line-row='LOCAL-032'] [data-sent-back='1']").count()) === 1);
      // Nothing selected: what just happened, newest first.
      assert.ok((await page.locator("[data-feed] li").count()) >= 3);
      // No playback anywhere: no transport, no playhead slider, no Timeline.
      assert.equal(await page.locator("[data-transport], [role='slider'], [data-timeline-workspace]").count(), 0);
      assert.equal(await page.getByRole("button", { name: /^(Play|Pause|Hold this moment)/ }).count(), 0);
      assert.deepEqual(consoleErrors(page).filter((e) => !/status of (401|502)/.test(e)), []);
    } finally {
      await context.close();
    }
  });

  test("a click shows a ticket or a station in the side panel; the selection is in the address; Back returns to the feed", async () => {
    const { page, context } = await openLine();
    try {
      await page.locator("[data-line-row='LOCAL-032']").click({ position: { x: 400, y: 30 } });
      const panel = page.locator("[data-line-panel='ticket'][data-ticket='LOCAL-032']");
      await panel.waitFor({ timeout: 5_000 });
      const text = await panel.innerText();
      assert.match(text, /Why it is here/);
      assert.match(text, /What it needs from you/);
      assert.match(text, /Where the time went/);
      assert.match(text, /Rounds used\s*2 of 3/);
      assert.equal(await panel.locator("[data-command-line] code").innerText(), "/mach decide LOCAL-032");
      await page.waitForFunction(() => decodeURIComponent(window.location.hash).includes("sel=cell:LOCAL-032"), undefined, { timeout: 5_000 });
      await page.locator("[data-station-heading='build']").click();
      const station = page.locator("[data-line-panel='station'][data-station='build']");
      await station.waitFor({ timeout: 5_000 });
      assert.match(await station.innerText(), /models\.build/);
      assert.equal(await page.locator("[data-station-heading='build']").getAttribute("aria-pressed"), "true");
      await page.getByRole("button", { name: "Back to what just happened" }).click();
      await page.locator("[data-line-panel='feed']").waitFor({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  });

  test("keyboard: Space shows a ticket, the arrows move between rows, Enter opens its full record, from which the evidence player opens", async () => {
    const { page, context } = await openLine();
    try {
      const first = page.locator("[data-line-row] [data-row-button]").first();
      await first.focus();
      await page.keyboard.press("ArrowDown");
      const focused = await page.evaluate(() => document.activeElement?.closest("[data-line-row]")?.getAttribute("data-line-row"));
      assert.ok(focused && focused !== (await page.locator("[data-line-row]").first().getAttribute("data-line-row")), "ArrowDown moved to the next row");
      await page.locator("[data-line-row='LOCAL-032'] [data-row-button]").focus();
      await page.keyboard.press("Space");
      await page.locator("[data-line-panel='ticket'][data-ticket='LOCAL-032']").waitFor({ timeout: 5_000 });
      await page.keyboard.press("Enter");
      const record = page.locator("[data-line-record='LOCAL-032']");
      await record.waitFor({ timeout: 5_000 });
      assert.equal(await record.getAttribute("role"), "dialog");
      const stations = await record.locator("[data-record-table] tbody tr td:first-child").allInnerTexts();
      assert.ok(stations.some((s) => /^Verify/.test(s)) && stations.some((s) => /^Review/.test(s)) && stations.some((s) => /again/.test(s)), `the record lists every visit, rework marked: ${stations.join(" | ")}`);
      // Keys belong to the dialog while it is open: 2 does not switch workspaces.
      await page.keyboard.press("2");
      assert.equal(await page.locator("[data-workspace-shown='line']").count(), 1);
      await record.locator("[data-open-evidence]").first().click();
      await page.locator("[data-evidence-player]").waitFor({ timeout: 10_000 });
      assert.equal(await page.locator("[data-line-record]").count(), 0, "the record closes for the player");
      await page.keyboard.press("Escape");
      await page.locator("[data-evidence-player]").waitFor({ state: "detached", timeout: 10_000 });
      // A double-click opens the record too, and Escape closes it.
      await page.locator("[data-line-row='LOCAL-034']").dblclick({ position: { x: 400, y: 30 } });
      await page.locator("[data-line-record='LOCAL-034']").waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.locator("[data-line-record]").waitFor({ state: "detached", timeout: 5_000 });
      assert.deepEqual(consoleErrors(page).filter((e) => !/status of (401|502)/.test(e)), []);
    } finally {
      await context.close();
    }
  });

  test("keys 1, 2 and 3 switch between the Line, the Floor and Analytics, keeping the selection", async () => {
    const { page, context } = await openLine("#line?sel=cell:LOCAL-034");
    try {
      await page.locator("[data-line-panel='ticket'][data-ticket='LOCAL-034']").waitFor({ timeout: 5_000 });
      await page.locator("body").press("2");
      await page.locator("[data-workspace-shown='floor']").waitFor({ timeout: 5_000 });
      assert.match(await page.evaluate(() => window.location.hash), /^#floor\?sel=cell%3ALOCAL-034/);
      assert.equal(await page.locator("[data-view='atlas']").count(), 1, "the Floor shows the Atlas");
      assert.equal(await page.locator("[data-mode-switch]").count(), 0, "and only the Atlas: no drawing to switch to");
      await page.locator("body").press("3");
      await page.locator("[data-workspace-shown='analytics']").waitFor({ timeout: 5_000 });
      await page.locator("body").press("1");
      await page.locator("[data-line-panel='ticket'][data-ticket='LOCAL-034']").waitFor({ timeout: 5_000 });
      // Back returns to the workspace left.
      await page.goBack();
      await page.locator("[data-workspace-shown='analytics']").waitFor({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  });

  test("accessibility: no serious axe violation on the Line; reduced motion stops the working pulse; nothing scrolls the page sideways", async () => {
    const { page, context } = await openLine("#line", { reducedMotion: "reduce", width: 1100, height: 760 });
    try {
      const result = await new AxeBuilder({ page }).include("[data-workspace='line']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      assert.deepEqual(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`), []);
      const pulsing = await page.evaluate(() => document.getAnimations().filter((a) => a.animationName === "mach-line-pulse" && a.playState === "running").length);
      assert.equal(pulsing, 0, "no pulse under reduced motion");
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(wide <= 0, `the page scrolls ${wide} px sideways`);
      await sleep(100);
    } finally {
      await context.close();
    }
  });
});

// Factory Analytics as the Shell mounts it (#analytics, key 4), over the built-in Simulation
// (`?simulation`). Mode `proof`: needs only the dev server. Workspace keys, the address grammar
// (`#analytics?area=&win=&risk=&app=&model=&station=&sel=&cmp=&focus=`), the Rows drill-down into the
// Timeline and the Factory floor, and Back restoring the Analytics view.
/* global document, location */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AREAS,
  SEL,
  analyticsReady,
  consoleErrors,
  ensureStack,
  hashParams,
  launch,
  MODE,
  openShell,
  proseInUrls,
  requestOffenders,
  sideways,
  skip,
  sleep,
  stopOwn,
  workspaceState,
} from "./analytics-lib.mjs";

const run = MODE === "all" || MODE === "proof";
let browser;
const pages = [];

async function open(hash, opts) {
  const o = await openShell(browser, null, hash, opts);
  pages.push(o.page);
  return o;
}

before(async () => {
  if (!run) return;
  await ensureStack();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  stopOwn();
});

const route = (hash) => /^#(\w+)/.exec(hash)?.[1] ?? null;
const pressBody = async (page, key) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(key);
  await sleep(500);
};

describe("Analytics in the Shell (Simulation)", { skip: run ? false : `E2E_AN_MODE=${MODE}` }, () => {
  test("keys 1, 2, 3 and 4 switch workspaces; 4 brings Analytics back with its area and window", async () => {
    const { page, context } = await open("#analytics?area=quality&win=7d&risk=high");
    const s0 = await workspaceState(page);
    assert.equal(s0.sheet, "Quality and remediation");
    assert.ok(s0.simulatedChip, "Analytics over the Simulation is not labelled Simulated");
    const seen = [];
    for (const key of ["1", "2", "3", "4"]) {
      await pressBody(page, key);
      seen.push(`${key}→${route(await page.evaluate(() => location.hash))}`);
    }
    assert.deepEqual(seen, ["1→atlas", "2→blueprint", "3→timeline", "4→analytics"]);
    await analyticsReady(page);
    const s = await workspaceState(page);
    const p = hashParams(s.hash);
    assert.equal(s.sheet, "Quality and remediation", "4 did not return to the same area");
    assert.equal(p.win, "7d", `the window is ${p.win} after the round trip`);
    assert.equal(p.risk, "high", `the risk filter is ${p.risk} after the round trip`);
    assert.equal(await page.getByRole("radio", { name: "Analytics" }).isChecked(), true, "the Workspace switch does not show Analytics");
    await context.close();
  });

  test("deep links round-trip for each area", async () => {
    const problems = [];
    for (const a of AREAS) {
      const want = { area: a.id, win: "14d", risk: "medium", app: "web", model: "sonnet" };
      const hash = `#analytics?${new URLSearchParams(want)}`;
      const { page, context } = await open(hash);
      const s = await workspaceState(page);
      if (s.sheet !== a.label) problems.push(`${a.id}: opened on ${s.sheet}`);
      if ((await page.getByRole("radio", { name: "14 days" }).getAttribute("aria-checked")) !== "true") problems.push(`${a.id}: 14 days not selected`);
      if ((await page.getByRole("combobox", { name: "Risk" }).inputValue()) !== "medium") problems.push(`${a.id}: risk not medium`);
      if ((await page.getByRole("combobox", { name: "App type" }).inputValue()) !== "web") problems.push(`${a.id}: app type not web`);
      const model = page.getByRole("combobox", { name: "Model" });
      if ((await model.count()) && (await model.inputValue()) !== "sonnet") problems.push(`${a.id}: model not sonnet`);
      const written = hashParams(s.hash);
      for (const [k, v] of Object.entries(want)) if (written[k] !== v && !(k === "area" && v === "pulse" && written[k] === undefined)) problems.push(`${a.id}: the written address has ${k}=${written[k]}`);
      const again = await openShell(browser, null, s.hash);
      const s2 = await workspaceState(again.page);
      if (s2.sheet !== s.sheet || s2.hash !== s.hash) problems.push(`${a.id}: reopening ${s.hash} shows ${s2.sheet} at ${s2.hash}`);
      await again.context.close();
      await context.close();
    }
    assert.deepEqual(problems, []);
  });

  test("an invalid value in the address is ignored, never thrown on", async () => {
    const { page, context } = await open("#analytics?area=nowhere&win=forever&risk=extreme&station=%3Cscript%3E");
    const s = await workspaceState(page);
    assert.equal(s.sheet, "Factory Pulse");
    assert.deepEqual(consoleErrors(page).filter((e) => !/\/api\/v1\/session/.test(e)), []);
    await context.close();
  });

  test("Rows → an entity opens the Timeline with it selected and in the window; 1 shows it on the floor; Back restores Analytics", async (t) => {
    const start = "#analytics?area=flow&win=all&risk=medium";
    const { page, context } = await open(start);
    const rows = page.getByRole("button", { name: /^Rows$/ });
    await rows.first().waitFor({ timeout: 10000 }).catch(() => {});
    assert.ok(await rows.count(), `no Rows on Flow; page errors: ${JSON.stringify(consoleErrors(page))}; text: ${(await workspaceState(page)).text.slice(0, 200)}`);
    await rows.first().click();
    const drawer = page.locator(SEL.rowsDrawer);
    await drawer.waitFor({ timeout: 5000 });
    const link = drawer.locator("a[data-ref]").first();
    if (!(await link.count()) && /not in the simulated run/i.test(await drawer.innerText())) {
      await context.close();
      return skip(t, "in the Simulation the rows come from the simulated Analytics data and say they are not in the simulated run, so they offer no link (by design); live mode asserts the drill-down");
    }
    assert.ok(await link.count(), "the rows list no entity");
    const ref = await link.getAttribute("data-ref");
    await link.click();
    const went = await page.waitForFunction(() => location.hash.startsWith("#timeline"), undefined, { timeout: 5000 }).then(() => true, () => false);
    assert.ok(went, `"${await link.getAttribute("aria-label")}" did nothing (the address stayed ${await page.evaluate(() => location.hash)}): ${ref} comes from the simulated Analytics fixture and is not an entity of the simulated run, so the Shell cannot open it [areas, shell]`);
    await page.waitForSelector("[data-timeline-workspace][data-timeline-ready]", { timeout: 30000 });
    const h = hashParams(await page.evaluate(() => location.hash));
    assert.equal(h.sel, ref, "the Timeline's address does not carry the entity");
    const selected = await page.evaluate(() => ({
      inspector: (document.querySelector("[data-inspector]")?.innerText ?? "").slice(0, 400),
      window: document.querySelector("[data-timeline-window]")?.getAttribute("data-timeline-window") ?? null,
      known: document.querySelector("[data-inspector] [data-entity-ref], [data-inspector] h2") !== null,
    }));
    if (!selected.known || /not (found|in this history)|no such/i.test(selected.inspector)) {
      await context.close();
      return skip(t, `the Simulation's scene has no entity ${ref}: the prototype's rows come from the simulated Analytics fixture, not the simulated run (live mode asserts this strictly)`);
    }
    await pressBody(page, "1");
    assert.equal(route(await page.evaluate(() => location.hash)), "atlas");
    assert.equal(hashParams(await page.evaluate(() => location.hash)).sel, ref, "the floor lost the selection");
    for (let i = 0; i < 4 && route(await page.evaluate(() => location.hash)) !== "analytics"; i++) {
      await page.goBack();
      await sleep(500);
    }
    await analyticsReady(page);
    const back = hashParams(await page.evaluate(() => location.hash));
    assert.equal(back.area, "flow", "Back did not restore the area");
    assert.equal(back.risk, "medium", "Back did not restore the filter");
    assert.ok(back.win === "all" || back.win === undefined, `Back restored win=${back.win}`);
    await context.close();
  });

  test("Back from the Timeline restores Analytics' area, window and filters", async () => {
    const { page, context } = await open("#analytics?area=economics&win=7d&model=opus");
    await pressBody(page, "3");
    assert.equal(route(await page.evaluate(() => location.hash)), "timeline");
    await page.goBack();
    await sleep(600);
    // A key switch may replace, not push, the entry: then Back leaves the app's first entry; say which.
    const h = await page.evaluate(() => location.hash);
    assert.equal(route(h), "analytics", `Back from the Timeline went to ${h || page.url()} [shell: hashSync writes the address with history.replaceState only, so a workspace switch leaves no entry to go back to]`);
    await analyticsReady(page);
    const p = hashParams(h);
    assert.deepEqual({ area: p.area, win: p.win, model: p.model }, { area: "economics", win: "7d", model: "opus" });
    assert.equal((await workspaceState(page)).sheet, "Agent and model economics");
    await context.close();
  });

  test("nothing scrolls sideways at 1512x982, 1280x800 and 1100x700 (inspector open)", async () => {
    const problems = [];
    for (const [width, height] of [
      [1512, 982],
      [1280, 800],
      [1100, 700],
    ]) {
      for (const a of AREAS) {
        const { page, context } = await open(`#analytics?area=${a.id}`, { width, height });
        for (const s of await sideways(page)) problems.push(`${width}x${height} ${a.id}: ${s}`);
        await context.close();
      }
    }
    assert.deepEqual(problems, []);
  });

  test("every request is a GET to 127.0.0.1, no prose in any address, no console error", () => {
    const offenders = pages.flatMap((p) => requestOffenders(p).map((r) => `${r.method} ${r.url}`));
    const prose = proseInUrls([...new Set(pages.flatMap((p) => [...p.urls, ...p.requests.map((r) => r.url)]))]);
    // Under ?simulation the app still asks /api/v1/session whether an observer is there; the dev
    // server without one answers 404 (the Timeline's suite sees the same). Nothing else is excused.
    const errors = pages.flatMap((p) => consoleErrors(p)).filter((e) => !/\/api\/v1\/session/.test(e));
    assert.deepEqual(offenders, []);
    assert.deepEqual(prose, []);
    assert.deepEqual([...new Set(errors)], []);
  });
});

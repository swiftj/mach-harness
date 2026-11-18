// M6.6 Phase 2 cross-workspace journeys 3 and 5 (I-16), over a real mach-observer (built from
// this working tree) on the realistic synthetic `medium` project (`mach-synth --analytics --profile
// realistic`, generated into the scratch folder). Mode `live`. Journeys 2 and 6 went with the
// Timeline and the playhead they used. Run on its own:
//   E2E_AN_MODE=live node --test --test-concurrency=1 --test-timeout=1200000 \
//     --test-global-setup=e2e/analytics-global.mjs e2e/journeys-m66.e2e.mjs
/* global document, location */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { analyticsReady, apiGet, apiSession, consoleErrors, ensureStack, hashParams, launch, log, makeProject, MODE, openShell, proseInUrls, skip, sleep, startObserver, stopOwn, waitCaughtUp } from "./analytics-lib.mjs";

const run = MODE === "all" || MODE === "live";
const PORT = Number(process.env.E2E_AN_JOURNEY_PORT ?? 4436);
let browser;
let obs;
let cookie;
const pages = [];

before(async () => {
  if (!run) return;
  await ensureStack({ tools: true });
  const { dir } = makeProject("medium", { reuse: true });
  obs = await startObserver(dir, PORT);
  cookie = await apiSession(obs);
  await waitCaughtUp(obs, cookie);
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await obs?.stop();
  stopOwn();
});

const hashOf = (page) => page.evaluate(() => location.hash);

async function open(hash, opts) {
  const o = await openShell(browser, obs, hash, opts);
  pages.push(o.page);
  return o;
}

/** Visit spans from the observer's own span API (GET), newest pages first. */
async function visits(filter) {
  const out = [];
  for (let offset = 0; offset < 4000 && out.length < 50; offset += 500) {
    const g = await apiGet(obs, cookie, `/api/v1/spans?kinds=visit&limit=500&offset=${offset}`);
    const items = g?.data?.items ?? g?.data?.spans ?? g?.items ?? [];
    out.push(...items.filter(filter));
    if (items.length < 500) break;
  }
  return out;
}

/** A span end's moment in ms (the API serves ISO times). */
const ms = (v) => (typeof v === "number" ? v : Date.parse(v));

/** The Floor with one visit selected, its inspector open. */
async function floorWith(span) {
  const { page, context } = await open(`#floor?sel=${encodeURIComponent(span.entity)}`, { wait: false });
  await page.waitForSelector("[data-inspector]", { timeout: 20000 });
  return { page, context };
}

describe("M6.6 journeys across the workspaces (live observer, realistic medium project)", { skip: run ? false : `E2E_AN_MODE=${MODE}` }, () => {
  test("journey 3: a station visit in the Floor's inspector → 'Open its measured history' → Flow for its station, its week, saying where the visit sits", async (t) => {
    const measured = await visits((s) => s.ids?.station === "verify" && s.end?.at && s.start?.at && s.basis !== "open");
    if (!measured.length) return skip(t, "no closed verify visit in the generated project");
    const span = measured[Math.floor(measured.length / 2)];
    const { page, context } = await floorWith(span);
    const link = page.locator("[data-inspector]").getByRole("button", { name: "Open its measured history" });
    await link.first().waitFor({ timeout: 20000 });
    await link.first().click();
    await page.waitForFunction(() => location.hash.startsWith("#analytics"), undefined, { timeout: 10000 });
    await analyticsReady(page, 60000);
    const h = hashParams(await hashOf(page));
    assert.equal(h.area, "flow");
    assert.equal(h.station, "verify");
    assert.match(h.win ?? "", /^\d+-\d+$/, "the period is the visit's week, a dated window");
    const [from, to] = h.win.split("-").map(Number);
    assert.equal(to - from, 7 * 86_400_000);
    assert.ok(ms(span.end.at) >= from && ms(span.end.at) < to, `the visit's day is not in the period ${from}-${to}: ${JSON.stringify(span).slice(0, 400)}`);
    const cameFrom = page.locator("[data-flow-came-from]");
    await cameFrom.waitFor({ timeout: 20000 });
    const words = await cameFrom.innerText();
    assert.match(words, /measured/, words);
    assert.ok(words.includes(span.ids.ticket_id ?? span.entity.split(/[:/]/)[1]), `the line does not name the visit's ticket: ${words}`);
    if (/Of \d+ measured visits/.test(words)) assert.equal(await page.locator("[data-histogram-mark]").count(), 1, "the histogram does not mark the visit");
    assert.equal(hashParams(await hashOf(page)).sel, span.entity, "Analytics changed the selection");
    await context.close();
  });

  test("journey 5: Back to Analytics restores the sort, the Table toggle and the scroll position, as well as the address's view", async () => {
    const { page, context } = await open("#analytics?area=flow&win=all", { width: 1280, height: 800 });
    const ranking = page.locator("[data-chart='flow-ranking']");
    await ranking.waitFor({ timeout: 30000 });
    await ranking.getByRole("button", { name: /^Median/ }).first().click();
    const sortBefore = await ranking.locator("th[aria-sort]").first().innerText();
    const waits = page.locator("[data-chart='flow-waits']");
    await waits.getByRole("button", { name: "Table" }).click();
    await page.locator("main.an-sheet").evaluate((el) => el.scrollTo({ top: 600 }));
    await sleep(300);
    const scrolled = await page.locator("main.an-sheet").evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("1");
    await page.waitForFunction(() => location.hash.startsWith("#line"), undefined, { timeout: 10000 });
    await page.goBack();
    await page.waitForFunction(() => location.hash.startsWith("#analytics"), undefined, { timeout: 10000 });
    await analyticsReady(page, 60000);
    await page.locator("[data-chart='flow-ranking']").waitFor({ timeout: 30000 });
    await sleep(500);
    assert.equal(await page.locator("[data-chart='flow-ranking'] th[aria-sort]").first().innerText(), sortBefore, "the ranking's sort was not kept");
    assert.equal(await page.locator("[data-chart='flow-waits']").getByRole("button", { name: "Chart" }).count(), 1, "the waits chart is not shown as its table again");
    const after = await page.locator("main.an-sheet").evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert.ok(Math.abs(after.top - scrolled.top) <= 4, `scroll ${JSON.stringify(after)}, was ${JSON.stringify(scrolled)}`);
    const h = hashParams(await hashOf(page));
    assert.equal(h.area, "flow");
    await context.close();
  });

  test("no prose in any address, no console error", () => {
    const prose = proseInUrls([...new Set(pages.flatMap((p) => [...p.urls, ...p.requests.map((r) => r.url)]))]);
    assert.deepEqual(prose, []);
    const errors = pages.flatMap((p) => consoleErrors(p));
    log("console errors", errors.length);
    assert.deepEqual([...new Set(errors)], []);
  });
});

/* global window, requestAnimationFrame */
// Case 16: the Timeline over a long history (the 220,000-event synthetic project, a COPY), served by
// a real mach-observer. Only with E2E_LARGE=1 (copying and indexing it takes minutes). It records
// the actual times against docs/mach-next/M6_3_DESIGN.md section 8 and fails only beyond three times
// the budget (headless, on whatever machine runs it). Actuals: <scratch>/long-history.json.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStack, apiOffenders, apiSession, consoleErrors, copyProject, LARGE, launch, openApp, scratch, sleep, SOURCES, startObserver, waitCaughtUp, WS } from "../scripts/timeline-e2e-lib.mjs";

const PORT = 4244;
/** Design section 8, and the multiple a headless run may take before it fails. */
const BUDGET = { firstPaintMs: 1500, frameMedianMs: 16, frameP95Ms: 33, switchMs: 300 };
const SLACK = 3;
const skip = LARGE ? false : "set E2E_LARGE=1 to run the long-history test (it copies and indexes 220,000 events)";

let browser;
let obs;
let page;
let context;
const actual = {};

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

/** Frame intervals (ms) while `during` runs, from requestAnimationFrame in the page. */
async function frames(during) {
  await page.evaluate(() => {
    const r = (window.__e2eFrames = { on: true, t: [] });
    const tick = (t) => {
      r.t.push(t);
      if (r.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await during();
  const t = await page.evaluate(() => {
    window.__e2eFrames.on = false;
    return window.__e2eFrames.t;
  });
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  return { median: Math.round(pct(gaps, 50) * 10) / 10, p95: Math.round(pct(gaps, 95) * 10) / 10, frames: gaps.length };
}

describe("Timeline over a 220,000-event history (real observer)", { skip }, () => {
  before(async () => {
    await ensureStack();
    const dir = copyProject(SOURCES.large, "long-history");
    obs = await startObserver(dir, PORT, { timeoutMs: 600000 });
    const started = Date.now();
    await waitCaughtUp(obs, await apiSession(obs));
    actual.observerCatchUpMs = Date.now() - started;
    browser = await launch();
  });

  after(async () => {
    writeFileSync(join(scratch, "long-history.json"), JSON.stringify({ budget: BUDGET, slack: SLACK, actual }, null, 2));
    await browser?.close();
    await obs?.stop();
  });

  test("first paint of the Timeline after the scene is ready", async () => {
    ({ page, context } = await openApp(browser, obs, "#atlas", { waitReady: false }));
    await page.waitForSelector("[data-scene-ready]", { timeout: 120000 }).catch(() => {
      throw new Error("no [data-scene-ready] hook (r4-workspace)");
    });
    await sleep(500);
    const t0 = Date.now();
    await page.keyboard.press("3");
    await page.waitForSelector(`${WS}[data-timeline-ready]`, { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r))));
    actual.firstPaintMs = Date.now() - t0;
    assert.ok(actual.firstPaintMs <= BUDGET.firstPaintMs * SLACK, `first paint ${actual.firstPaintMs} ms (budget ${BUDGET.firstPaintMs} ms, failing beyond ×${SLACK})`);
  });

  test("pan and zoom frames", async () => {
    await page.locator(`${WS} [role=application]`).first().focus();
    const zoom = await frames(async () => {
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(i % 2 ? "-" : "+");
        await sleep(150);
      }
    });
    const move = page.locator(`${WS} [role=slider][aria-label='Move window']`).first();
    await move.focus();
    const pan = await frames(async () => {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press(i < 5 ? "ArrowLeft" : "ArrowRight");
        await sleep(100);
      }
    });
    actual.zoom = zoom;
    actual.pan = pan;
    for (const [name, f] of Object.entries({ zoom, pan })) {
      assert.ok(f.median <= BUDGET.frameMedianMs * SLACK, `${name}: median frame ${f.median} ms (budget ${BUDGET.frameMedianMs})`);
      assert.ok(f.p95 <= BUDGET.frameP95Ms * SLACK, `${name}: 95th percentile frame ${f.p95} ms (budget ${BUDGET.frameP95Ms})`);
    }
  });

  test("workspace switch", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await page.locator("body").press("1");
      await page.waitForSelector("[data-stage-active]", { timeout: 10000 });
      await sleep(400);
      const t0 = Date.now();
      await page.locator("body").press("3");
      await page.waitForSelector(`${WS}[data-timeline-ready]`, { timeout: 30000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r))));
      runs.push(Date.now() - t0);
    }
    actual.switchMs = runs;
    const median = pct(runs, 50);
    assert.ok(median <= BUDGET.switchMs * SLACK, `workspace switch median ${median} ms (budget ${BUDGET.switchMs})`);
  });

  test("no API request but GET to 127.0.0.1, and no console errors", async () => {
    assert.deepEqual(apiOffenders(page), []);
    assert.deepEqual(consoleErrors(page), []);
    await context.close();
  });
});

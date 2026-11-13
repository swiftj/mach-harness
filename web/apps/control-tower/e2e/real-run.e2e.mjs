/* global document, location */
// The Timeline and the Factory Floor over a COPY of the real supervised run (one cell, three
// executions, two rejected review rounds), served by a real mach-observer: cross-view navigation and
// deep links (case 14), reduced motion and a keyboard-only investigation (case 17), the M6.2 Factory
// Floor unchanged (case 18), and that looking changes nothing: the observer's health is the same
// after the tab closes and no Factory file in the project copy changed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiGet,
  apiOffenders,
  apiSession,
  changingFrames,
  checksumTree,
  clockMs,
  cols,
  consoleErrors,
  copyProject,
  diffChecksums,
  DEV_ORIGIN,
  expandTable,
  hashParams,
  hooks,
  inspectorText,
  launch,
  openApp,
  readTable,
  runningAnimations,
  sceneReady,
  selectTableRow,
  setTable,
  sleep,
  SOURCES,
  spanRows,
  startObserver,
  timelineReady,
  WS,
  ensureStack,
} from "../scripts/timeline-e2e-lib.mjs";

const PORT = 4242;
const TICKET = "LOCAL-001";
const check = (ok, id, message) => assert.ok(ok, `${message} [${id}]`);

let browser;
let obs;
let dir;
let sums0;
let cookie;
const pages = [];

async function open(hash, opts) {
  const { page, context } = await openApp(browser, obs, hash, opts);
  pages.push(page);
  return { page, context };
}

/** The lifecycle record of the real run, for times the tests compare against. */
const lifecycle = () =>
  readFileSync(join(dir, ".factory", "worktrees", TICKET, "lifecycle.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

/** Health without what moves on its own (clocks, ages, counters of requests and clients). */
function steady(health) {
  const VOLATILE = /(^|_)(at|now|time|ts|age|uptime|lag|ms|seconds|clients?|connections?|subscribers?|requests?|heartbeat|ticks|last.*|since)$|At$|Ms$/i;
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.test(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return strip(health);
}

before(async () => {
  await ensureStack();
  dir = copyProject(SOURCES.realRun, "real-run");
  sums0 = checksumTree(dir);
  obs = await startObserver(dir, PORT);
  browser = await launch();
  cookie = await apiSession(obs);
});

after(async () => {
  await browser?.close();
  await obs?.stop();
});

describe("Timeline and Factory Floor over the real supervised run (real observer)", () => {
  test("(14a) Atlas selection → 3: the Timeline frames and selects it → 1: back on the Atlas, kept", async () => {
    const { page, context } = await open(`#atlas?sel=cell:${TICKET}`, { height: 1100 });
    await sceneReady(page);
    await page.waitForSelector(`[data-inspector="cell:${TICKET}"]`, { timeout: 15000 });
    await page.locator("body").press("3");
    await timelineReady(page);
    await sleep(800);
    const h = await hooks(page);
    assert.match(h.hash, new RegExp(`^#timeline\\?.*sel=cell(:|%3A)${TICKET}`), `the address after 3: ${h.hash}`);
    await setTable(page, true);
    const rows = await readTable(page);
    const cell = spanRows(rows, "cell").find((r) => r.text.includes(TICKET));
    assert.ok(cell, `${TICKET}'s cell span is not in the window after 3`);
    assert.ok(rows.some((r) => r.selected && r.text.includes(TICKET)), `no ${TICKET} row is marked selected in the table`);
    const [from, to] = (h.window ?? "").split("-").map(Number);
    assert.ok(Number.isFinite(from) && Number.isFinite(to), `data-timeline-window is ${h.window} [r4-workspace]`);
    await setTable(page, false);
    await page.keyboard.press("1");
    await page.waitForSelector(`[data-view=atlas]`, { timeout: 10000 });
    await sleep(500);
    assert.match(await page.evaluate(() => location.hash), new RegExp(`^#atlas\\?sel=cell(:|%3A)${TICKET}`), "the selection did not survive the return to the Atlas");
    assert.ok(await page.locator(`[data-inspector="cell:${TICKET}"]`).count(), "the inspector lost the cell on the way back");
    await context.close();
  });

  test("(14b) a gate on the Blueprint → the Timeline at the gate's time", async () => {
    const verdict = lifecycle().find((l) => l.type === "gate.evaluated" && l.data?.gate === "verify.verdict");
    assert.ok(verdict, "the real run has no verify.verdict gate");
    const at = Date.parse(verdict.at);
    const candidates = [`gate:${TICKET}/verify.verdict#${verdict.round ?? 1}`, `gate:${TICKET}/verify.verdict`];
    let page;
    let context;
    let ref = null;
    for (const c of candidates) {
      ({ page, context } = await open(`#blueprint?sel=${encodeURIComponent(c)}`, { height: 1100 }));
      await sceneReady(page, { optional: true });
      await sleep(1500);
      if (await page.locator(`[data-inspector="${c}"]`).count()) {
        ref = c;
        break;
      }
      await context.close();
    }
    assert.ok(ref, `the Blueprint selects none of ${candidates.join(", ")}`);
    const button = page.getByRole("button", { name: "Show in Timeline" });
    if (await button.count()) await button.first().click();
    else await page.locator("body").press("3");
    await timelineReady(page);
    await sleep(1200);
    const h = await hooks(page);
    const [from, to] = (h.window ?? "").split("-").map(Number);
    check(Number.isFinite(from) && from <= at && at <= to, "r4-workspace / design 7", `the Timeline's window ${h.window} does not hold the gate's time ${at}`);
    assert.match(h.hash, /^#timeline\?.*sel=gate/, `the selection was not kept: ${h.hash}`);
    await context.close();
  });

  test("(14c) a deep link round-trips win, group, lens and at", async () => {
    const enter = lifecycle().find((l) => l.type === "station.entered" && l.station === "verify");
    const at = Date.parse(enter.at);
    const win = `${at - 20 * 60_000}-${at + 20 * 60_000}`;
    const hash = `#timeline?sel=cell:${TICKET}&at=${at}&win=${win}&group=execution&lens=retries`;
    const { page, context } = await open(hash, { height: 1100 });
    await sleep(1500);
    const h = await hooks(page);
    check(h.window === win, "r4-workspace", `data-timeline-window is ${h.window}, the link asked for ${win}`);
    check(h.groupingAttr === "execution", "r4-workspace", `data-timeline-grouping is ${h.groupingAttr}`);
    assert.ok(await page.locator("[data-timeline-band=retries]").count(), "the retries lens is not open");
    const p = hashParams(h.hash);
    assert.equal(p.win, win, `the address lost win: ${h.hash}`);
    assert.equal(p.group, "execution", `the address lost group: ${h.hash}`);
    assert.equal(p.lens, "retries", `the address lost lens: ${h.hash}`);
    assert.equal(p.sel, `cell:${TICKET}`, `the address lost sel: ${h.hash}`);
    check(p.at === String(at) || /\D/.test(p.at ?? ""), "design 7", `the address lost at (playhead held): ${h.hash}`);
    // And back: the same address opens the same state.
    const again = await open(h.hash, { height: 1100 });
    await sleep(1200);
    const h2 = await hooks(again.page);
    assert.deepEqual({ ...hashParams(h2.hash) }, { ...p }, "the written address does not reopen the same state");
    await again.context.close();
    await context.close();
  });

  test("(14d) a fresh win= deep link builds the same tree as navigating to that window", async () => {
    const enter = lifecycle().find((l) => l.type === "station.entered" && l.station === "review");
    const at = Date.parse(enter.at);
    const win = `${at - 5 * 60_000}-${at + 5 * 60_000}`;
    const structural = (rows) => rows.filter((r) => /^track:(wave|slice|cell|execution):[^/]+$/.test(r.key ?? "") || /no wave recorded/i.test(r.text)).map((r) => `${r.level} ${r.key} ${/no wave recorded/i.test(r.text) ? "(no wave)" : ""}`);
    const a = await open(`#timeline?table=1`, { height: 1100 });
    await expandTable(a.page, { match: /^track:(wave|slice|cell):[^/]+$/ });
    await a.page.evaluate((w) => (location.hash = `#timeline?table=1&win=${w}`), win);
    await sleep(2000);
    await expandTable(a.page, { match: /^track:(wave|slice|cell):[^/]+$/ });
    const navigated = structural(await readTable(a.page));
    const b = await open(`#timeline?table=1&win=${win}`, { height: 1100 });
    await expandTable(b.page, { match: /^track:(wave|slice|cell):[^/]+$/ });
    const fresh = structural(await readTable(b.page));
    check(JSON.stringify(fresh) === JSON.stringify(navigated), "X4", `the fresh deep link builds a different tree:\nnavigated: ${navigated.join(" | ")}\nfresh:     ${fresh.join(" | ")}`);
    check(!fresh.some((k) => k.includes("(no wave)")), "X4", "the fresh deep link files the slice under “No wave recorded”");
    await a.context.close();
    await b.context.close();
  });

  test("(17a) reduced motion: nothing animates after a zoom, a brush move and a workspace switch", async () => {
    const { page, context } = await open("#timeline", { reducedMotion: "reduce" });
    const steps = [];
    // CSS and Web Animations are looked for at once and again later; the canvases are watched frame by
    // frame for 700 ms: a cut changes them once or twice (the cut, then the window's spans arriving), an
    // eased zoom or a growing span on nearly every frame. A live clock redraws about once a second.
    const settle = async (label) => {
      const frames = await changingFrames(page, 700);
      const running = await runningAnimations(page);
      await sleep(300);
      running.push(...(await runningAnimations(page)));
      steps.push({ label, running, frames, still: frames.changed <= 3 });
    };
    await page.locator(`${WS} [role=application]`).first().focus();
    await page.keyboard.press("+");
    await settle("zoom in (+)");
    const move = page.locator(`${WS} [role=slider][aria-label='Move window']`).first();
    assert.ok(await move.count(), "no 'Move window' slider on the overview");
    const box = await move.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await settle("brush drag");
    await move.focus();
    await page.keyboard.press("ArrowLeft");
    await settle("brush key");
    await page.keyboard.press("1");
    await sleep(150);
    await page.keyboard.press("3");
    // Animations are looked for at once; the canvas is compared once the workspace has laid out again.
    const switching = await runningAnimations(page, "body");
    await timelineReady(page);
    await settle("workspace switch (1, then 3)");
    steps.at(-1).running.push(...switching.filter((a) => !/spinner|loading/i.test(a)));
    const bad = steps.filter((s) => s.running.length || !s.still);
    assert.deepEqual(bad, [], `animation under reduced motion: ${JSON.stringify(bad)}`);
    await context.close();
  });

  test("(17b) one investigation with the keyboard only: open, next failure, inspector, retries lens, back to live", async () => {
    const { page, context } = await open("#atlas", { height: 1000 });
    await sceneReady(page, { optional: true });
    await page.keyboard.press("3");
    await timelineReady(page);
    await sleep(600);
    // From the start of the history (Home), the next failure (n): it is selected and read in the inspector.
    await page.keyboard.press("Home");
    await sleep(400);
    await page.keyboard.press("n");
    await sleep(1500);
    const sel = await page.evaluate(() => document.querySelector("[data-inspector]")?.getAttribute("data-inspector"));
    assert.ok(sel && sel !== "run", `n selected nothing (inspector shows ${sel})`);
    const text = await inspectorText(page);
    assert.match(text.slice(0, 800), /reject|fail/i, `the inspector does not say what failed:\n${text.slice(0, 400)}`);
    // Investigate → "Why did it retry?", by Tab and Enter.
    let found = false;
    for (let i = 0; i < 80 && !found; i++) {
      await page.keyboard.press("Tab");
      found = await page.evaluate(() => document.activeElement?.hasAttribute("data-timeline-investigate") ?? false);
    }
    assert.ok(found, "Investigate is not reachable with Tab");
    await page.keyboard.press("Enter");
    await sleep(300);
    let chose = false;
    for (let i = 0; i < 12 && !chose; i++) {
      const name = await page.evaluate(() => document.activeElement?.innerText ?? "");
      if (/why did it retry|retries/i.test(name)) {
        await page.keyboard.press("Enter");
        chose = true;
      } else await page.keyboard.press(i === 0 ? "ArrowDown" : "Tab");
    }
    assert.ok(chose, "the retries lens is not reachable with the keyboard in the Investigate menu");
    await page.waitForSelector("[data-timeline-band=retries]", { timeout: 10000 });
    // Back to live (l), from wherever the focus is.
    await page.keyboard.press("Escape");
    await page.keyboard.press("l");
    await sleep(800);
    const state = await page.evaluate(() => [...document.querySelectorAll("[data-live-state]")].map((e) => e.getAttribute("data-live-state")));
    assert.ok(state.includes("live") || state.includes("stale"), `after l the live state is ${state.join(",")}`);
    await context.close();
  });

  test("(18) the M6.2 Factory Floor: deep links, keys 1/2/t/Shift+T, the docked timeline's tracks and ruler", async () => {
    const a = await open(`#atlas?sel=cell:${TICKET}`, { height: 1000 });
    await sceneReady(a.page);
    await a.page.waitForSelector(`[data-view=atlas]`, { timeout: 15000 });
    assert.ok(await a.page.locator(`[data-inspector="cell:${TICKET}"]`).count(), "#atlas?sel= did not select the cell");
    await a.context.close();

    const { page, context } = await open(`#blueprint?sel=cell:${TICKET}&theater=1`, { height: 1000 });
    await sceneReady(page);
    await page.waitForSelector(`[data-view=blueprint][data-theater="1"]`, { timeout: 15000 });
    assert.ok(await page.locator(`[data-inspector="cell:${TICKET}"]`).count(), "#blueprint?sel= did not select the cell");
    const frameTheater = () => page.evaluate(() => document.querySelector(".mach-frame")?.hasAttribute("data-theater") ?? false);
    assert.ok(await frameTheater(), "theater=1 did not turn Theater Mode on");
    await page.locator("body").press("t");
    await sleep(300);
    assert.equal(await frameTheater(), false, "t did not leave Theater Mode");
    await page.keyboard.press("1");
    await page.waitForSelector("[data-stage-view=atlas][data-stage-active]", { timeout: 5000 });
    await page.keyboard.press("2");
    await page.waitForSelector("[data-stage-view=blueprint][data-stage-active]", { timeout: 5000 });
    // The docked timeline: its ruler's playhead answers the keyboard, its tracks are drawn.
    const ruler = page.getByRole("slider", { name: /^Playhead over/ });
    assert.ok(await ruler.count(), "the docked timeline's ruler is missing");
    const tracks = page.getByRole("application", { name: /^Execution tracks/ });
    assert.ok(await tracks.count(), "the docked timeline's tracks are missing");
    const size = await tracks.locator("canvas").first().boundingBox();
    assert.ok(size && size.width > 100 && size.height > 10, `the docked tracks' canvas is ${JSON.stringify(size)}`);
    const v0 = await ruler.getAttribute("aria-valuenow");
    await ruler.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await sleep(300);
    assert.notEqual(await ruler.getAttribute("aria-valuenow"), v0, "the ruler's playhead did not move with the arrow keys");
    await page.locator("body").press("Shift+T");
    await sleep(300);
    assert.equal(await ruler.count(), 0, "Shift+T did not collapse the docked timeline");
    await page.locator("body").press("Shift+T");
    await sleep(300);
    assert.ok(await ruler.count(), "Shift+T did not bring the docked timeline back");
    await context.close();
  });

  /** The toolbar row and the transport, measured: nothing clipped, and the pinned control's Follow reachable by a pointer. */
  const chromeFit = (page) =>
    page.evaluate(() => {
      const row = document.querySelector("[data-timeline-toolbar]");
      const stage = document.querySelector("#stage").getBoundingClientRect();
      const speed = document.querySelector("[role=toolbar][aria-label=Transport] fieldset").getBoundingClientRect();
      const pin = document.querySelector("[data-timeline-pinned]");
      const follow = pin ? [...pin.querySelectorAll("span")].find((x) => x.textContent === "Follow") : null;
      const f = follow?.getBoundingClientRect();
      const hit = f ? document.elementFromPoint(f.x + f.width / 2, f.y + f.height / 2) : null;
      return {
        rowOverflow: row.scrollWidth - row.clientWidth,
        speedClipped: speed.right > stage.right + 0.5,
        pinned: Boolean(pin),
        followInRow: Boolean(f) && f.right <= row.getBoundingClientRect().right + 0.5 && f.right <= stage.right + 0.5,
        followHit: Boolean(hit && pin.contains(hit)),
        inspectorOpen: !document.querySelector("aside[aria-label^='Inspector']").inert,
      };
    });

  test("(M6.3 fix 1) the toolbar folds with the pinned control present, the inspector open or closed, at 1512, 1280 and 1100", async () => {
    for (const [width, height] of [[1512, 982], [1280, 800], [1100, 700]]) {
      const { page, context } = await open("#timeline", { width, height });
      await sleep(1200);
      // Narrow the window: it is pinned, and the live edge (the wall clock, far past the recorded run) is ahead of it.
      const narrow = page.getByRole("button", { name: "Narrow the time window" });
      if (await narrow.isVisible()) await narrow.click();
      else {
        await page.locator("[data-timeline-more]").click();
        await page.getByRole("button", { name: "Narrow the window" }).click();
      }
      await sleep(1200);
      for (let pass = 0; pass < 2; pass++) {
        const fit = await chromeFit(page);
        const where = `${width} px, inspector ${fit.inspectorOpen ? "open" : "closed"}`;
        assert.ok(fit.pinned, `${where}: no pinned control after narrowing the window`);
        assert.ok(fit.rowOverflow <= 1, `${where}: the toolbar overflows by ${fit.rowOverflow} px`);
        assert.ok(!fit.speedClipped, `${where}: the transport's speed control is clipped`);
        assert.ok(fit.followInRow && fit.followHit, `${where}: Follow is cut off or covered`);
        // The other inspector state (I).
        await page.locator(`${WS} [role=application]`).focus();
        await page.keyboard.press("i");
        await sleep(900);
      }
      await page.locator("[data-timeline-pinned]").click();
      await sleep(800);
      assert.equal(await page.locator("[data-timeline-pinned]").count(), 0, `${width} px: Follow did not follow the live edge again`);
      await context.close();
    }
  });

  test("(M6.3 fix 3) a wait on a person picked on the tracks: In time first, what it waited on, since and until when, and how it is known", async () => {
    const { page, context } = await open("#timeline?table=1", { height: 1400 });
    await expandTable(page);
    const wait = await selectTableRow(page, (r) => spanRows([r], "person-wait").length === 1 && /\d/.test(cols(r).ended) && !/waiting/i.test(cols(r).duration));
    assert.ok(wait, "no resolved wait on a person in the real run's table");
    await sleep(1500);
    const text = await inspectorText(page);
    assert.doesNotMatch(text, /No further detail/, "the inspector says nothing more is recorded for a wait it holds");
    const inTime = text.indexOf("In time");
    assert.ok(inTime >= 0, `no In time section:\n${text.slice(0, 600)}`);
    assert.ok(inTime < text.indexOf("Facts"), "In time is not shown before the cell's own record");
    const section = text.slice(inTime, inTime + 900);
    assert.match(section, /Waiting for a person/);
    assert.match(section, /Waiting on\s+\S/, "what it waited on (the record's reasons) is not said");
    assert.match(section, /Began\s+\d\d:\d\d:\d\d/);
    assert.match(section, /Ended\s+\d\d:\d\d:\d\d/);
    assert.match(section, /Duration\s+took .*\(measured\)/);
    assert.match(section, /Recorded as\s+(Authority:\s+)?Authoritative/);
    await context.close();
  });

  test("closing the tab leaves the observer's health unchanged; no API request but GET to 127.0.0.1; no console errors", async () => {
    const { page, context } = await open("#timeline", { height: 900 });
    await sleep(1500);
    const h0 = (await apiGet(obs, cookie, "/api/v1/health")).body;
    await page.close();
    await context.close();
    await sleep(1500);
    const h1 = (await apiGet(obs, cookie, "/api/v1/health")).body;
    assert.deepEqual(steady(h1), steady(h0), "the observer's health changed after the tab closed");
    const bad = pages.flatMap(apiOffenders);
    assert.deepEqual(bad, [], `non-GET or non-loopback API requests: ${JSON.stringify(bad.slice(0, 5))}`);
    const errors = pages.flatMap(consoleErrors);
    assert.deepEqual(errors, [], `console errors: ${errors.slice(0, 5).join(" | ")}`);
  });

  test("no Factory file in the project copy changed (checksums before and after, the observer's own folder excluded)", async () => {
    await browser.close();
    browser = null;
    await obs.stop();
    obs = null;
    const changed = diffChecksums(sums0, checksumTree(dir));
    assert.deepEqual(changed, [], `files changed under the project: ${changed.slice(0, 10).join(", ")}`);
  });
});

void [clockMs, cols, DEV_ORIGIN];

/* global document, location */
// What a real, live supervised run showed (M6.3 live pass, L1, L2, L7, L8): a lens chosen while
// following keeps following; a pinned window says the live edge has left it and never claims to
// follow; "Return to live" gives the following window back; a ready slice held for a free place is a
// capacity wait in the "What ran at once?" lens; a human-approval visit is a wait on a person; idle,
// the page asks next to nothing. Over a real mach-observer on a synthetic history appended to
// (mach-synth --append) and on a copy of the real live run's project.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendSynth, consoleErrors, copyProject, ensureStack, hashParams, launch, openApp, sleep, startObserver, synthProject, WS } from "../scripts/timeline-e2e-lib.mjs";

const PORT = 4246;
const LIVE_RUN = process.env.E2E_LIVE_RUN ?? "/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m66-live/P/eng";

let browser;
let obs = null;
const pages = [];

before(async () => {
  await ensureStack();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await obs?.stop();
});

async function open(hash, opts) {
  const { page, context } = await openApp(browser, obs, hash, opts);
  pages.push(page);
  return { page, context };
}

const state = (page) =>
  page.evaluate((ws) => ({
    hash: location.hash,
    window: document.querySelector(ws)?.getAttribute("data-timeline-window"),
    pinned: document.querySelector("[data-timeline-pinned]")?.textContent ?? null,
    follow: document.querySelector("[data-follow-state]")?.getAttribute("data-follow-state") ?? null,
  }), WS);

async function chooseLens(page, name) {
  await page.locator(`${WS} [role=toolbar] button`, { hasText: /Investigate|What ran|Why did|Who decided|What was/ }).first().click();
  await page.locator("button", { hasText: name }).first().click();
  await sleep(1200);
}

describe("following the live edge (L1, L8)", () => {
  let dir;
  before(async () => {
    ({ dir } = synthProject("live-follow", { cells: 12, events: 12000, seed: 7, hours: 6 }));
    obs = await startObserver(dir, PORT);
  });
  after(async () => {
    await obs?.stop();
    obs = null;
  });

  test("L1: a pinned window the live edge leaves says so, never 'Following'; L follows again", async () => {
    const { page, context } = await open("#timeline");
    await page.locator(`${WS} [role=toolbar] button[aria-label='Narrow the time window'], ${WS} [role=toolbar] button[title^='Narrow the time window']`).first().click();
    appendSynth(dir, { rate: 40, duration: "3s" });
    let s = await state(page);
    for (let i = 0; i < 20 && s.pinned === null; i++) {
      await sleep(1000);
      s = await state(page);
    }
    assert.match(s.pinned ?? "", /Window pinned/, "no pinned notice after the live edge left the window");
    assert.notEqual(s.follow, "following", "the transport claims to follow while the window is pinned");
    await page.locator(`${WS} [data-timeline-workspace], ${WS}`).first().focus().catch(() => {});
    await page.keyboard.press("l");
    await sleep(800);
    s = await state(page);
    assert.equal(s.pinned, null);
    assert.equal(hashParams(s.hash).win, undefined, `L did not give the following window back: ${s.hash}`);
    await context.close();
  });

  test("L8: idle, the Timeline asks at most 12 times a minute beyond health and the Factory's status", async () => {
    const { page, context } = await open("#timeline");
    await sleep(3000);
    const since = page.requests.length;
    await sleep(60_000);
    const asked = page.requests.slice(since).filter((r) => {
      const p = new URL(r.url).pathname;
      return p.startsWith("/api/") && p !== "/api/v1/health" && p !== "/api/v1/factory/status" && p !== "/api/v1/events/stream";
    });
    const byPath = {};
    for (const r of asked) byPath[new URL(r.url).pathname] = (byPath[new URL(r.url).pathname] ?? 0) + 1;
    assert.ok(asked.length <= 12, `${asked.length} requests in an idle minute: ${JSON.stringify(byPath)}`);
    await context.close();
  });
});

/**
 * The real live run as it stood mid-build: its project copied, each log cut to the lines it held then
 * (the execution started, its process not yet ended). Its execution is running, so the live edge has
 * something to follow.
 */
function midRun() {
  const dir = copyProject(LIVE_RUN, "live-run-mid");
  const keep = (rel, n) => {
    const f = join(dir, rel);
    writeFileSync(f, readFileSync(f, "utf8").split("\n").filter(Boolean).slice(0, n).join("\n") + "\n");
  };
  keep(".factory/intake/events.jsonl", 14);
  keep(".factory/worktrees/LOCAL-001/lifecycle.jsonl", 12);
  const exec = join(dir, ".factory/local/executions/x35c9f82d04ea");
  keep(".factory/local/executions/x35c9f82d04ea/stream.jsonl", 80);
  rmSync(join(exec, "result.json"), { force: true });
  return dir;
}

describe("a lens chosen while following (L1)", { skip: !existsSync(LIVE_RUN) && "the live run's project is not on this machine" }, () => {
  before(async () => {
    obs = await startObserver(midRun(), PORT + 2);
  });
  after(async () => {
    await obs?.stop();
    obs = null;
  });

  test("L1: a lens chosen at the live edge keeps following at its frame's length; No lens gives the default back", async () => {
    const { page, context } = await open("#timeline");
    await chooseLens(page, "What ran at once?");
    await sleep(1500);
    const a = await state(page);
    const win = hashParams(a.hash).win ?? "";
    assert.match(win, /^live-\d+$/, `the lens pinned the window: ${a.hash}`);
    assert.equal(a.pinned, null);
    const w = a.window.split("-").map(Number);
    // Anchored at the live edge (the wall clock: this run's records are older), at the lens frame's length.
    assert.ok(Math.abs(w[1] - Date.now()) < 5 * 60_000, `the lens window ends at ${new Date(w[1]).toISOString()}, not at the live edge`);
    assert.ok(Math.abs(w[1] - w[0] - Number(win.slice(5))) < 1000, `the window is ${w[1] - w[0]} ms long, not the lens's ${win.slice(5)}`);
    await chooseLens(page, "No lens");
    await sleep(1500);
    assert.equal(hashParams((await state(page)).hash).win, undefined, "No lens did not give the following default back");
    await context.close();
  });
});

describe("the real live run (L2, L7)", { skip: !existsSync(LIVE_RUN) && "the live run's project is not on this machine" }, () => {
  before(async () => {
    obs = await startObserver(copyProject(LIVE_RUN, "live-run"), PORT + 1);
  });
  after(async () => {
    await obs?.stop();
    obs = null;
  });

  test("L2, L7: SLICE-002, held for the only place, is a capacity wait in 'What ran at once?'; no slice named twice", async () => {
    const { page, context } = await open("#timeline?group=execution");
    // Nothing runs in this history any more: the lens frames what it shows (pinned), the live edge long after it.
    await chooseLens(page, "What ran at once?");
    const names = await page.evaluate((ws) => [...document.querySelectorAll(`${ws} [data-timeline-band] [data-fig]`)].map((g) => g.getAttribute("aria-label") ?? ""), WS);
    assert.ok(names.some((n) => /waiting for a free place \(1 of 1 in use\)/.test(n)), `no capacity wait in the lens: ${names.filter((n) => /LOCAL-002|SLICE-002/.test(n)).join(" | ")}`);
    assert.match((await state(page)).pinned ?? "", /Window pinned/);
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, /SLICE-002 SLICE-002/, "an untitled slice named twice");
    await context.close();
  });

  test("no console errors", () => {
    const errors = pages.flatMap(consoleErrors);
    assert.deepEqual(errors, [], errors.slice(0, 5).join(" | "));
  });
});

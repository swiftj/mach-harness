// The Factory Floor live on a project with nothing recorded (a fresh MACH project: `.factory/` with
// an empty ticket queue, inbox, worktrees and archive; no intake ledger, no cell, no supervisor), over
// a real mach-observer. A real user's tab once froze here, looping on a history window that could not
// exist. The page must keep answering while it sits open on the Line, says something useful about the
// empty line, and keeps answering on the Floor and back.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { launch, openApp, scratch, sleep, startObserver } from "../scripts/e2e-lib.mjs";

const PORT = 4243;
/** A page that takes longer than this to run `1` is not answering. */
const ANSWER_MS = 2000;

let browser;
let obs;

function emptyProject() {
  const dir = join(scratch, "projects", "empty-live");
  rmSync(dir, { recursive: true, force: true });
  for (const d of ["tickets", "inbox", "worktrees", "archive"]) {
    mkdirSync(join(dir, ".factory", d), { recursive: true });
    writeFileSync(join(dir, ".factory", d, ".keep"), "");
  }
  writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ tickets: { provider: "local" } }) + "\n");
  writeFileSync(join(dir, "README.md"), "# empty\n");
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

/** How long the page takes to answer, or null when it did not within ANSWER_MS. */
async function answers(page) {
  const t0 = Date.now();
  const ok = await Promise.race([page.evaluate(() => 1).then(() => true), sleep(ANSWER_MS).then(() => false)]);
  return ok ? Date.now() - t0 : null;
}

/** Ask the page every second for `seconds`; fails at the first second it does not answer. */
async function keepsAnswering(page, seconds, what) {
  for (let s = 0; s < seconds; s++) {
    const ms = await answers(page);
    assert.ok(ms !== null, `${what}: the page stopped answering after ${s} s`);
    await sleep(Math.max(0, 1000 - ms));
  }
}

before(async () => {
  obs = await startObserver(emptyProject(), PORT);
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await obs?.stop();
});

describe("Factory Floor live on an empty project (real observer)", () => {
  test("open on the Line for 20 s, then the Floor and back: an empty line says so, and the page answers throughout", async () => {
    const { page, context } = await openApp(browser, obs, "#line", { width: 2000, height: 1125, waitReady: false });
    try {
      await page.waitForSelector("[data-connection='live']", { timeout: 30000 });
      await keepsAnswering(page, 20, "sitting open on the Line");
      const empty = page.locator("[data-line-empty]");
      await empty.waitFor({ timeout: 5000 });
      assert.match(await empty.innerText(), /No tickets on the line yet|Factory/);
      assert.equal(await page.locator("[data-needs-none]").count(), 1, "nothing is waiting for a person");
      assert.equal(await page.locator("[data-feed-empty]").count(), 1, "nothing has happened yet, and the feed says so");
      assert.equal(await page.locator("[data-station-heading]").count(), 7, "every station still has its heading");
      assert.equal(await page.locator("[data-transport], [role='slider']").count(), 0, "no playback control to hold the moment with");
      await page.locator("body").press("2");
      await page.locator("[data-workspace-shown='floor']").waitFor({ timeout: 5000 });
      await keepsAnswering(page, 5, "on the Floor");
      await page.locator("body").press("1");
      await page.locator("[data-workspace-shown='line']").waitFor({ timeout: 5000 });
      await keepsAnswering(page, 5, "back on the Line");
      assert.deepEqual(page.consoleErrors, [], "no console errors");
    } finally {
      await context.close();
    }
  });
});

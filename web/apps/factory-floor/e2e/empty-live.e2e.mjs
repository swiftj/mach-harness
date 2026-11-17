// The Factory Floor live on a project with nothing recorded (a fresh MACH project: `.factory/` with
// an empty ticket queue, inbox, worktrees and archive; no intake ledger, no cell, no supervisor), over
// a real mach-observer. A real user's tab froze here: holding the moment at the live edge looped
// without end asking for a history window that cannot exist. The page must keep answering while it
// sits open, after the hold, and while it plays from the hold.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { launch, openApp, scratch, sleep, startObserver } from "../scripts/timeline-e2e-lib.mjs";

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
  test("open on the Atlas for 20 s, hold the moment, play from it: the page answers throughout", async () => {
    const { page, context } = await openApp(browser, obs, "#atlas", { width: 2000, height: 1125, waitReady: false });
    try {
      await page.waitForSelector("text=Connected: receiving live", { timeout: 30000 });
      await keepsAnswering(page, 20, "sitting open");
      const play = page.locator("[data-transport=play]").first();
      assert.match((await play.getAttribute("aria-label")) ?? "", /^Hold this moment/);
      // A frozen page can stall the click itself: what matters is whether the page answers after it.
      await play.click({ timeout: 5000, noWaitAfter: true }).catch(() => undefined);
      await keepsAnswering(page, 5, "after holding the moment");
      assert.equal(await play.getAttribute("aria-label"), "Play", "held: the button offers play");
      await play.click({ timeout: 5000 });
      await keepsAnswering(page, 5, "playing from the hold");
      assert.deepEqual(page.consoleErrors, [], "no console errors");
    } finally {
      await context.close();
    }
  });
});

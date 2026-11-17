/* global window */
// M6.4: the evidence player over a real mach-observer serving a small synthetic history (mach-synth:
// verification checks with text evidence files). No screenshot or recording is taken: the assertions
// read the dialog's structure, its words, the address and the requests the page made.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiGet, apiSession, consoleErrors, ensureStack, launch, openApp, sceneReady, sleep, startObserver, synthProject } from "../scripts/timeline-e2e-lib.mjs";

const PORT = 4247;
let browser;
let obs;
/** A ticket whose cell has recorded checks: one with a catalogued text file when the history has one. */
let target = null;

before(async () => {
  await ensureStack();
  const made = synthProject("evidence", { cells: 8, events: 4000, seed: 11, hours: 3 });
  catalogueOneCell(made.dir);
  obs = await startObserver(made.dir, PORT);
  browser = await launch();
  const cookie = await apiSession(obs);
  const until = Date.now() + 60_000;
  while (!target?.artifactId && Date.now() < until) {
    const cells = await apiGet(obs, cookie, "/api/v1/cells?limit=200");
    for (const c of cells.body?.data?.items ?? []) {
      const ev = await apiGet(obs, cookie, `/api/v1/cells/${encodeURIComponent(c.ticket_id)}/evidence`);
      const checks = ev.body?.data?.checks ?? [];
      for (const k of checks) {
        if (!(k.evidence ?? []).length) continue;
        const f = k.evidence.find((x) => x.artifact_id && x.content_access === "text");
        // Prefer a check with a catalogued text file; keep the first check with any file otherwise.
        if (f || !target) target = { ticket: c.ticket_id, check: k.target_id, artifactId: f?.artifact_id ?? null, checks: checks.length, catalogued: (ev.body.data.artifacts ?? []).length };
        if (f) break;
      }
      if (target?.artifactId) break;
    }
    if (!target) await sleep(1000);
    else if (!target.artifactId) break;
  }
});

/**
 * mach-synth writes evidence files and their lifecycle checks but no results.json, so the observer's
 * catalog (which lists what verify.py's records name) has no entry for them. For one live cell, write the
 * results.json verify.py would have written for its latest round, in the project copy only, so one text
 * file is catalogued and served.
 */
function catalogueOneCell(dir) {
  const root = join(dir, ".factory", "worktrees");
  for (const ticket of existsSync(root) ? readdirSync(root).sort() : []) {
    const folder = join(root, ticket, "evidence");
    if (!existsSync(folder)) continue;
    const files = readdirSync(folder).filter((f) => /^[A-Z]+-?\d*-r\d+\.txt$/.test(f));
    if (!files.length) continue;
    const round = Math.max(...files.map((f) => Number(f.match(/-r(\d+)\.txt$/)[1])));
    const records = {};
    for (const f of files.filter((x) => x.endsWith(`-r${round}.txt`))) {
      const item = f.replace(/-r\d+\.txt$/, "");
      const sha256 = createHash("sha256").update(readFileSync(join(folder, f))).digest("hex");
      records[item] = { kind: item.startsWith("R") ? "matrix rule" : "scenario", result: "pass", evidence: [{ file: f, sha256 }] };
    }
    writeFileSync(join(folder, "results.json"), `${JSON.stringify({ head: null, review_loop: round, records }, null, 2)}\n`);
    return ticket;
  }
  return null;
}

after(async () => {
  await browser?.close();
  await obs?.stop();
});

test("the player opens from the address over a live observer, lists the checks, and requests content only for a selected, catalogued file", async (t) => {
  if (!target) {
    t.skip("the synthetic history has no recorded check with a file");
    return;
  }
  t.diagnostic(`ticket ${target.ticket}, check ${target.check}, ${target.catalogued} catalogued artifacts, text file ${target.artifactId ?? "none"}`);
  const { page, context } = await openApp(browser, obs, `#atlas?evidence=${target.ticket}&check=${target.check}`, { waitReady: false });
  try {
    await sceneReady(page, { optional: true });
    const dialog = page.locator("[data-evidence-player]");
    await dialog.waitFor({ timeout: 30_000 });
    assert.equal(await dialog.getAttribute("role"), "dialog");
    await page.locator("[data-evidence-check]").first().waitFor({ timeout: 30_000 });
    const listed = await page.locator("[data-evidence-check]").count();
    assert.ok(listed >= 1 && listed <= target.checks, `${listed} checks listed of ${target.checks}`);
    // The check from the address is the one shown, and its files are listed with a state.
    assert.equal(await page.locator(`[data-evidence-check="${target.check}"][aria-pressed="true"]`).count(), 1);
    const files = page.locator("[data-evidence-files] [data-evidence-file]");
    assert.ok((await files.count()) >= 1);
    // Accessible names are IDs, positions and types: never the file's name.
    for (const name of await files.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) {
      assert.match(name, /^(Screenshot|Recording|Text|File) \d+ of \d+, check [A-Za-z0-9_.-]+, /);
      assert.doesNotMatch(name, /\.txt|evidence\//);
    }
    // Every file the player had selected (opening selects the check's first file; a click; a key).
    const selected = new Set();
    const noteSelected = async () => {
      for (const v of await page.locator('[data-evidence-files] [data-evidence-file][aria-pressed="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-evidence-file")))) selected.add(v);
    };
    await noteSelected();
    if (target.artifactId) {
      // A catalogued text file: its words appear as plain text, with a line count.
      await page.locator(`[data-evidence-file="${target.artifactId}"]`).first().click();
      await noteSelected();
      const text = page.locator("[data-evidence-text] pre");
      await text.waitFor({ timeout: 15_000 });
      assert.match(await text.innerText(), /synthetic evidence/);
      assert.equal(await page.locator("[data-evidence-text] pre *").count(), 0, "a text node only: no element was made from the content");
      assert.match(await page.locator("[data-evidence-text]").innerText(), /\d+ lines?/);
    } else {
      // Not catalogued (mach-synth writes no results.json, so the observer's catalog has no entry): said, and not requested.
      await files.first().click();
      await noteSelected();
      const withheld = page.locator("[data-evidence-viewer] [data-evidence-withheld]");
      await withheld.waitFor({ timeout: 15_000 });
      assert.match(await withheld.innerText(), /catalog has no entry for this file/);
      assert.equal(await files.first().getAttribute("data-evidence-state"), "missing");
    }
    // Stepping by key moves to the next check; nothing is loaded ahead.
    await page.locator("[data-evidence-player]").press("]");
    await sleep(800);
    await noteSelected();
    const content = page.requests.filter((r) => /\/api\/v1\/artifacts\/[^/]+\/content/.test(r.url));
    for (const r of content) {
      const m = r.url.match(/\/api\/v1\/artifacts\/(a[0-9a-f]{24})\/content$/);
      assert.ok(m, `by catalog id only: ${r.url}`);
      assert.ok(selected.has(m[1]), `requested only when selected: ${m[1]} not in ${[...selected].join(", ")}`);
    }
    t.diagnostic(`${content.length} content requests (development builds run effects twice), ${new Set(content.map((r) => r.url)).size} distinct, for ${selected.size} selected files`);
    assert.ok(page.requests.every((r) => r.method === "GET" || !r.url.includes("/api/")), "GET only");
    assert.ok(page.requests.every((r) => !/evidence%2F|\/evidence\/[^?]*\.(txt|png|json)/.test(new URL(r.url).pathname + new URL(r.url).search)), "no path in a request");
    // The address carries the ticket and the check only; the title says nothing about a file.
    const hash = await page.evaluate(() => window.location.hash);
    assert.match(hash, new RegExp(`evidence=${target.ticket}`));
    assert.doesNotMatch(decodeURIComponent(hash), /\.txt|\.png|evidence\//);
    assert.doesNotMatch(await page.title(), /\.txt|evidence\//);
    // Escape closes it, and the address drops it.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    await sleep(500);
    assert.doesNotMatch(await page.evaluate(() => window.location.hash), /evidence=/);
    assert.deepEqual(consoleErrors(page), []);
  } finally {
    await context.close();
  }
});

test("the simulation: its checks with sample content the app draws itself, labelled; a recording says there is none; nothing is requested", async () => {
  const { page, context } = await openApp(browser, null, "?simulation#atlas?at=3000000&evidence=LOCAL-031&check=AC-01", { waitReady: false });
  try {
    await sceneReady(page, { optional: true });
    const dialog = page.locator("[data-evidence-player]");
    await dialog.waitFor({ timeout: 30_000 });
    await page.locator("[data-evidence-simulation]").waitFor({ timeout: 15_000 });
    assert.match(await page.locator("[data-evidence-simulation]").innerText(), /Simulation\. .*not a capture/);
    await page.locator("[data-evidence-check]").first().waitFor({ timeout: 15_000 });
    // AC-01's first file is a screenshot: drawn by the app, named by its check.
    const drawing = page.locator("[data-evidence-simulated-image] svg[role='img']");
    await drawing.waitFor({ timeout: 15_000 });
    assert.match(await drawing.getAttribute("aria-label"), /^Simulated screenshot, check AC-01$/);
    // Its second file is the flow's recording: there is none in a simulation.
    await page.locator("[data-evidence-player]").press(".");
    await page.locator("[data-evidence-withheld]").waitFor({ timeout: 10_000 });
    assert.match(await page.locator("[data-evidence-withheld]").innerText(), /There is no recording in a simulation/);
    // (The shell itself asks whether an observer answers at start-up; the player asks for nothing.)
    assert.equal(page.requests.filter((r) => /\/api\/v1\/(artifacts|cells\/[^/]+\/evidence)/.test(r.url)).length, 0, "the simulation's player asks the observer for nothing");
    // The start-up probe of the observer answers 401 without a session: the shell's, not the player's.
    assert.deepEqual(consoleErrors(page).filter((e) => !/status of 401/.test(e)), []);
  } finally {
    await context.close();
  }
});

// Factory Analytics on the areas' development proof page (/src/analytics/dev/proof.html), over the
// seeded simulated fixture. Mode `proof`: needs only the dev server. Asserts on what a person can
// perceive (roles, names, the figures' summaries and tables, readouts, the address), never pixels.
// Where a promised control or hook is not built yet, the test SKIPS and names it.
/* global document */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AREAS,
  WINDOW_GROUP,
  SEL,
  analyticsReady,
  consoleErrors,
  dayOf,
  ensureStack,
  launch,
  MODE,
  openProof,
  proseInUrls,
  readFigures,
  readFigureTables,
  readReadouts,
  requestOffenders,
  sideways,
  skip,
  sleep,
  stopOwn,
  unavailableOffenders,
  workspaceState,
} from "./analytics-lib.mjs";

const run = MODE === "all" || MODE === "proof";
let browser;
const pages = [];

async function open(params, opts) {
  const o = await openProof(browser, params, opts);
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

/** The header's window ("16 Oct – 13 Nov") as UTC day numbers. */
function headerWindow(header, around) {
  const m = /(\d{1,2} [A-Z][a-z]{2}) – (\d{1,2} [A-Z][a-z]{2})/.exec(header);
  if (!m) return null;
  return { from: dayOf(m[1], around), to: dayOf(m[2], around) };
}

describe("Analytics, proof page (simulated fixture)", { skip: run ? false : `E2E_AN_MODE=${MODE}` }, () => {
  test("every area renders, labelled Simulated, each figure named and summarised", async () => {
    const problems = [];
    for (const a of AREAS) {
      const { page, context } = await open({ area: a.id });
      const s = await workspaceState(page);
      if (s.sheet !== a.label) problems.push(`${a.id}: the sheet is ${JSON.stringify(s.sheet)}`);
      if (!s.simulatedChip) problems.push(`${a.id}: no "Simulated" label in the workspace bar (${s.header.slice(0, 120)})`);
      if (s.source !== null && !["simulated", "simulation"].includes(s.source)) problems.push(`${a.id}: data-analytics-source=${s.source} on a fixture`);
      for (const f of await readFigures(page)) {
        if (!f.name) problems.push(`${a.id}: a figure with no accessible name (${f.text.slice(0, 60)})`);
        if (!f.missing && !f.summary) problems.push(`${a.id}: figure "${f.name}" has no summary`);
        if (!f.missing && f.drawn && !f.table) problems.push(`${a.id}: figure "${f.name}" has no table alternative`);
      }
      await context.close();
    }
    assert.deepEqual(problems, []);
  });

  test("a window preset changes every chart of the area to the same window", async () => {
    const problems = [];
    let checked = 0;
    for (const a of ["pulse", "quality", "economics", "reliability"]) {
      const { page, context } = await open({ area: a, window: "28d" });
      const before = await workspaceState(page);
      await page.getByRole("radiogroup", { name: WINDOW_GROUP }).getByRole("radio", { name: "7 days" }).click();
      await analyticsReady(page);
      const s = await workspaceState(page);
      if (s.header === before.header) problems.push(`${a}: the workspace bar did not change with the window`);
      const around = Date.UTC(2026, 10, 13);
      const w = headerWindow(s.header, around);
      if (!w) {
        problems.push(`${a}: the workspace bar states no window: ${s.header.slice(0, 120)}`);
        await context.close();
        continue;
      }
      if (!(w.to - w.from <= 8 * 864e5)) problems.push(`${a}: the stated window spans ${(w.to - w.from) / 864e5} days after "7 days"`);
      if (s.window && before.window && s.window === before.window) problems.push(`${a}: data-analytics-window unchanged (${s.window})`);
      for (const t of await readFigureTables(page)) {
        const days = t.rows.flatMap((r) => r.map((c) => dayOf(c, around))).filter((d) => d !== null);
        if (!days.length) continue;
        checked++;
        const outside = days.filter((d) => d < w.from || d > w.to);
        if (outside.length) problems.push(`${a}: "${t.heading}" lists ${outside.length} days outside the stated window`);
      }
      await context.close();
    }
    assert.ok(checked > 0, "no figure table listed days to compare with the window");
    assert.deepEqual(problems, []);
  });

  test("a brushed range narrows every chart of the area", async (t) => {
    const { page, context } = await open({ area: "pulse", window: "all" });
    const brush = page.locator(SEL.brush).first();
    if (!(await brush.count())) {
      await context.close();
      return skip(t, "no brush in the workspace ([data-analytics-brush]): not built yet (areas)");
    }
    assert.equal(await brush.getByRole("slider").count(), 2, "the brush does not have two slider handles");
    const before = await workspaceState(page);
    const box = await brush.boundingBox();
    // Drag across the columns, from a quarter to three fifths of the chart (the areas' brush applies on release).
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.up();
    await analyticsReady(page);
    await sleep(400);
    const s = await workspaceState(page);
    const chip = page.locator("[data-analytics-chip-window]");
    assert.ok(await chip.count(), "no chosen-window indicator ([data-analytics-chip-window]) after the brush");
    assert.notEqual(s.header, before.header, "the stated window did not follow the brush");
    if (s.window && before.window) assert.notEqual(s.window, before.window, "data-analytics-window did not follow the brush");
    // Undo returns to the period before.
    const undo = chip.getByRole("button");
    if (await undo.count()) {
      await undo.first().click();
      await analyticsReady(page);
      assert.equal((await workspaceState(page)).header, before.header, "Undo did not restore the period");
    }
    await context.close();
  });

  test("filters narrow the figures and can be cleared", async () => {
    const { page, context } = await open({ area: "quality", window: "all" });
    const before = (await readFigures(page)).map((f) => f.summary).join("|");
    const beforeReadouts = JSON.stringify(await readReadouts(page));
    await page.getByRole("combobox", { name: "Risk" }).selectOption("high");
    await analyticsReady(page);
    const after = (await readFigures(page)).map((f) => f.summary).join("|");
    assert.ok(after !== before || JSON.stringify(await readReadouts(page)) !== beforeReadouts, "nothing on Quality changed with Risk = high");
    assert.match(new URL(page.url()).search, /risk=high/, "the address does not carry the filter");
    const clear = page.getByRole("button", { name: /^Clear/ });
    assert.ok(await clear.count(), "no way to clear the applied filter");
    await clear.first().click();
    await analyticsReady(page);
    assert.doesNotMatch(new URL(page.url()).search, /risk=high/, "Clear did not clear the filter");
    await context.close();
  });

  test("cross-filter: a station chosen on the Flow map is pressed, in the address, and shown as a chip that clears it", async (t) => {
    const { page, context } = await open({ area: "flow", window: "all" });
    const mark = page.locator("main[aria-label] figure [role=button][aria-pressed]").first();
    assert.ok(await mark.count(), "no pressable station in the Flow map");
    const name = (await mark.getAttribute("aria-label")) ?? "";
    await mark.focus();
    await page.keyboard.press("Enter");
    await sleep(300);
    assert.equal(await mark.getAttribute("aria-pressed"), "true", "the station did not become pressed");
    assert.match(new URL(page.url()).search, /station=/, "the address does not carry the station");
    const chips = page.locator(SEL.chip);
    if (!(await chips.count())) {
      await context.close();
      return skip(t, "no chip (button[data-analytics-chip]) for the chosen station yet (areas)");
    }
    const station = /station=([^&]+)/.exec(new URL(page.url()).search)[1];
    const chipText = (await chips.first().innerText()) + (await chips.first().getAttribute("aria-label") ?? "");
    assert.ok(new RegExp(station, "i").test(chipText) || chipText.toLowerCase().includes(name.split(/[ .]/)[0].toLowerCase()), `the chip "${chipText}" does not name the station ${station}`);
    await chips.first().click();
    await analyticsReady(page);
    assert.doesNotMatch(new URL(page.url()).search, /station=/, "the chip did not clear the station");
    await context.close();
  });

  test("Rows lists the entities behind a figure, each a reference link to the Timeline", async () => {
    const problems = [];
    let opened = 0;
    for (const a of AREAS) {
      const { page, context } = await open({ area: a.id, window: "all" });
      const rows = page.getByRole("button", { name: /^Rows$/ });
      if (!(await rows.count())) {
        await context.close();
        continue;
      }
      await rows.first().click();
      const drawer = page.locator(SEL.rowsDrawer);
      await drawer.waitFor({ timeout: 5000 });
      opened++;
      const focusInside = await drawer.evaluate((d) => d.contains(document.activeElement));
      if (!focusInside) problems.push(`${a.id}: focus did not move into the rows`);
      const links = await drawer.locator("a[data-ref]").evaluateAll((as) => as.map((x) => ({ ref: x.getAttribute("data-ref"), href: x.getAttribute("href") })));
      if (!links.length && !/None recorded|No rows recorded/.test(await drawer.innerText())) problems.push(`${a.id}: the rows list neither entities nor "none recorded"`);
      for (const l of links) {
        if (!/^[a-z][a-z-]*:\S+$/.test(l.ref ?? "")) problems.push(`${a.id}: a row's reference is not in the entity-ref grammar: ${l.ref}`);
        if (!l.href?.startsWith("#timeline?") || !l.href.includes(`sel=${encodeURIComponent(l.ref)}`)) problems.push(`${a.id}: a row does not open the Timeline with that entity: ${l.href}`);
      }
      await page.keyboard.press("Escape");
      await sleep(200);
      if (await drawer.count()) problems.push(`${a.id}: Escape did not close the rows`);
      await context.close();
    }
    assert.ok(opened >= 3, `only ${opened} areas offered Rows`);
    assert.deepEqual(problems, []);
  });

  test("deep links round-trip for each area", async () => {
    const problems = [];
    for (const a of AREAS) {
      const params = { area: a.id, window: "14d", risk: "medium", app_type: "web" };
      const { page, context } = await open(params);
      const s = await workspaceState(page);
      if (s.sheet !== a.label) problems.push(`${a.id}: opened on ${s.sheet}`);
      if ((await page.getByRole("radio", { name: "14 days" }).getAttribute("aria-checked")) !== "true") problems.push(`${a.id}: 14 days not selected`);
      if ((await page.getByRole("combobox", { name: "Risk" }).inputValue()) !== "medium") problems.push(`${a.id}: risk not medium`);
      if ((await page.getByRole("combobox", { name: "App type" }).inputValue()) !== "web") problems.push(`${a.id}: app type not web`);
      const written = Object.fromEntries(new URL(page.url()).searchParams);
      for (const [k, v] of Object.entries(params)) if (written[k] !== v) problems.push(`${a.id}: the written address has ${k}=${written[k]}`);
      // The written address reopens the same view.
      const again = await openProof(browser, written);
      const s2 = await workspaceState(again.page);
      if (s2.header !== s.header || s2.sheet !== s.sheet) problems.push(`${a.id}: reopening the written address shows another view`);
      await again.context.close();
      await context.close();
    }
    assert.deepEqual(problems, []);
  });

  test("sparse (two runs) and no-lifecycle histories: unavailable figures give a reason, never a number", async () => {
    const problems = [];
    for (const extra of [{ mode: "sparse" }, { mode: "nolog" }, { model: "opus" }, {}]) {
      for (const a of AREAS) {
        const { page, context } = await open({ area: a.id, window: "all", ...extra });
        for (const o of await unavailableOffenders(page)) problems.push(`${JSON.stringify(extra)} ${a.id}: ${o.where}: ${o.why} (${o.text.slice(0, 100)})`);
        await context.close();
      }
    }
    assert.deepEqual(problems, []);
  });

  test("nothing scrolls sideways at 1512x982, 1280x800 and 1100x700", async () => {
    const problems = [];
    for (const [width, height] of [
      [1512, 982],
      [1280, 800],
      [1100, 700],
    ]) {
      for (const a of AREAS) {
        const { page, context } = await open({ area: a.id, window: "all" }, { width, height });
        for (const s of await sideways(page)) problems.push(`${width}x${height} ${a.id}: ${s}`);
        await context.close();
      }
    }
    assert.deepEqual(problems, []);
  });

  test("every request is a GET to 127.0.0.1, no prose in any address, no console error", () => {
    const offenders = pages.flatMap((p) => requestOffenders(p).map((r) => `${r.method} ${r.url}`));
    // The proof page (development only, never built) writes its own drill title into its address when
    // a drawer opens; that parameter is excused here and reported. The Shell's grammar has no such field.
    const prose = proseInUrls([...new Set(pages.flatMap((p) => [...p.urls, ...p.requests.map((r) => r.url)]))], { allow: ["drill_title"] });
    const errors = pages.flatMap((p) => consoleErrors(p));
    assert.deepEqual(offenders, [], "requests not GET to 127.0.0.1");
    assert.deepEqual(prose, [], "prose in an address");
    assert.deepEqual([...new Set(errors)], [], "console errors");
  });
});

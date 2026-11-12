// Accessibility findings for the M6.0 prototype, on the capture build.
//
//   node scripts/audit.mjs        # writes screenshots/_a11y/report.json, the accessibility trees and images
//
// 1. axe (WCAG 2.2 A/AA tags) across the principal states: both views, both themes, 1920 and 1100 wide.
// 2. A keyboard-only walkthrough of every interaction in the brief, each step checked against the store.
// 3. Focus order (Tab stops from the top) and focus visibility of each stop.
// 4. Reduced motion, measured: element positions frame to frame during travel, with and without it.
// 5. Contrast of the factory tokens as rendered (both themes).
// 6. Greyscale renders of the grammar for a colour-independence review (the judgement is in the findings).
// 7. The accessibility tree (ARIA snapshot) of the principal states, and the live-region announcements
//    during one minute of playback (virtual clock, so the announcer's own 4 s spacing is honoured).
// 8. 200% zoom: 1920x1080 and 1280x800 windows at 200% (960x540 and 640x400 CSS px), three states each.
// 2b and 2c (focus return after the help sheet; the hidden, still-mounted view) were added for the
// re-measure after the defect fixes.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { ACTIVE, ACTIVE_ATLAS, app, ensureBuild, frames, log, openApp, ORIGIN, S, sim, sleep, startPreview, waitPrepared } from "./lib.mjs";

const ENTITIES = `${ACTIVE_ATLAS} [data-ref][role="button"]`;
const ARROWS = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
/** Open the timeline from its summary row to every track (the "Tracks" disclosure). */
async function openTracks(page) {
  const b = page.locator("section[aria-label='Execution timeline'] button[aria-expanded]", { hasText: "Tracks" });
  if ((await b.count()) && (await b.first().getAttribute("aria-expanded")) === "false") await b.first().click();
  await sleep(600);
}

/**
 * The Atlas's arrow-key navigation graph: from every entity, each of the four arrows, at a fixed
 * camera. Then a breadth-first search from the entry point (the entity an arrow lands on when the
 * canvas itself has focus) proves which entities can be reached by arrows alone, and gives the
 * shortest key path to each.
 */
async function arrowGraph(page) {
  const cam = await page.evaluate(() => window.__atlasCamera.get());
  const refs = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.getAttribute("data-ref")), ENTITIES);
  const indexOfActive = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].indexOf(document.activeElement), ENTITIES);
  const edges = refs.map(() => ({}));
  for (let i = 0; i < refs.length; i++) {
    for (const k of ARROWS) {
      await page.evaluate(
        ({ sel, i, cam }) => {
          window.__atlasCamera.set(cam);
          [...document.querySelectorAll(sel)][i]?.focus({ preventScroll: true });
        },
        { sel: ENTITIES, i, cam },
      );
      await page.keyboard.press(k);
      edges[i][k] = await indexOfActive();
    }
  }
  // Entry: the canvas focused, then an arrow.
  await page.evaluate(({ sel, cam }) => {
    window.__atlasCamera.set(cam);
    document.querySelector(sel).focus({ preventScroll: true });
  }, { sel: "[data-stage-active] [data-view=atlas]", cam });
  await page.keyboard.press("ArrowRight");
  const entry = await indexOfActive();
  const path = { [entry]: ["ArrowRight (entry)"] };
  const queue = [entry];
  while (queue.length) {
    const i = queue.shift();
    for (const k of ARROWS) {
      const j = edges[i]?.[k];
      if (j >= 0 && !(j in path)) {
        path[j] = [...path[i], k];
        queue.push(j);
      }
    }
  }
  await page.evaluate((c) => window.__atlasCamera.set(c), cam);
  const dupRefs = refs.filter((r, i) => refs.indexOf(r) !== i);
  const deadEnds = refs.filter((_, i) => ARROWS.every((k) => edges[i][k] === i || edges[i][k] < 0));
  return {
    total: refs.length,
    distinctRefs: new Set(refs).size,
    duplicateRefs: [...new Set(dupRefs)],
    entry: refs[entry] ?? null,
    reached: Object.keys(path).length,
    unreached: refs.filter((_, i) => !(i in path)),
    longestPath: Math.max(0, ...Object.values(path).map((p) => p.length)),
    deadEnds,
    refs,
    edges,
    paths: Object.fromEntries(Object.entries(path).map(([i, p]) => [refs[i], p])),
  };
}

const out = join(app, "screenshots", "_a11y");
mkdirSync(out, { recursive: true });
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const report = { generated: new Date().toISOString() };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return {
    state: label,
    violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) })),
    incomplete: result.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
    passes: result.passes.length,
  };
}

const state = (page) => page.evaluate(() => window.__machSim.state());
const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: "body" };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 90),
      ref: el.getAttribute("data-ref") ?? el.closest("[data-ref]")?.getAttribute("data-ref") ?? null,
      region: el.closest("header") ? "top bar" : el.closest("main") ? "stage" : el.closest("aside") ? "inspector" : el.closest("section") ? "timeline" : el.closest("[role=dialog]") ? "dialog" : "page",
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 ? `${cs.outlineWidth} ${cs.outlineStyle}` : null,
      shadow: cs.boxShadow !== "none" ? "box-shadow" : null,
      focusVisible: el.matches(":focus-visible"),
    };
  });

ensureBuild();
const server = await startPreview();
const browser = await chromium.launch();
try {
  // ------------------------------------------------------------ 1. axe
  report.axe = [];
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1920, 1080],
      [1100, 800],
    ]) {
      for (const view of ["atlas", "blueprint"]) {
        for (const [label, t, select] of [
          ["run at 10:40", 640, null],
          ["verification failed, gate selected", 1660, "gate:LOCAL-031/verification#1"],
          ["human gate, gate selected", 2852, "gate:LOCAL-032/human-approval"],
        ]) {
          const { context, page } = await openApp(browser, { theme, view, width, height });
          await sim(page, "seek", S(t));
          if (select) await sim(page, "select", select);
          await sleep(1200);
          report.axe.push({ theme, size: `${width}x${height}`, view, ...(await axe(page, label)) });
          await context.close();
        }
      }
      // The timeline opened to every track (it starts as one summary row), Atlas, 27:40, gate selected.
      {
        const { context, page } = await openApp(browser, { theme, width, height });
        await sim(page, "seek", S(1660));
        await sim(page, "select", "gate:LOCAL-031/verification#1");
        await openTracks(page);
        report.axe.push({ theme, size: `${width}x${height}`, view: "atlas", ...(await axe(page, "timeline tracks open, gate selected")) });
        await context.close();
      }
      // Theater and the help sheet, once per theme and size.
      {
        const { context, page } = await openApp(browser, { theme, width, height });
        await sim(page, "seek", S(1940));
        await sim(page, "setTheater", true);
        await sleep(1000);
        report.axe.push({ theme, size: `${width}x${height}`, view: "atlas", ...(await axe(page, "Theater Mode")) });
        await sim(page, "setTheater", false);
        await page.keyboard.press("?");
        await page.getByRole("dialog").waitFor();
        await sleep(400);
        report.axe.push({ theme, size: `${width}x${height}`, view: "atlas", ...(await axe(page, "help sheet")) });
        await context.close();
      }
    }
  }
  log("axe:", report.axe.reduce((n, r) => n + r.violations.length, 0), "violations in", report.axe.length, "states");

  // ------------------------------------------------------------ 2 and 3. keyboard
  {
    const steps = [];
    /** A fresh page at 10:40 for each group, so one group's state never leaks into the next. */
    const fresh = async (fn) => {
      const { context, page } = await openApp(browser, { theme: "dark" });
      await sim(page, "seek", S(640));
      await frames(page, 2);
      try {
        await fn(page);
      } finally {
        await context.close();
      }
    };
    const stepper = (page) => async (interaction, keys, check) => {
      const before = await state(page);
      for (const k of keys) {
        await page.keyboard.press(k);
        await sleep(120);
      }
      await sleep(700);
      const after = await state(page);
      const focus = await active(page);
      let ok;
      let evidence;
      try {
        [ok, evidence] = await check(before, after, focus);
      } catch (e) {
        ok = false;
        evidence = String(e).slice(0, 160);
      }
      steps.push({ interaction, keys: keys.join(" "), ok, evidence, focusAfter: `${focus.region}: ${focus.role ?? focus.tag} ${focus.ref ?? focus.name}`.slice(0, 120) });
    };
    const camera = (page) => page.evaluate(() => window.__atlasCamera?.get() ?? null);
    const dimmedCount = (page) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} svg g`)].filter((g) => Number(getComputedStyle(g).opacity) < 0.6).length, ACTIVE_ATLAS);
    /**
     * Reach the first entity whose ref starts with `prefix` by arrows alone, along the shortest path
     * the navigation graph found (the canvas has focus, nothing selected). Every key is pressed for
     * real; the walk checks it lands on each step's expected entity.
     */
    const reachBy = async (page, prefix) => {
      const g = await arrowGraph(page);
      const target = Object.keys(g.paths).find((r) => r.startsWith(prefix));
      if (!target) return null;
      await page.locator(`${ACTIVE} [data-view=atlas]`).focus();
      for (const k of g.paths[target]) await page.keyboard.press(k.split(" ")[0]);
      const f = await active(page);
      return f.ref === target ? target : null;
    };

    // Focus order from the top of the page, all the way round, and the visibility of each stop; and
    // whether any stop lies in the hidden view (both views stay mounted). Once per active view.
    for (const view of ["atlas", "blueprint"]) {
      const { context, page } = await openApp(browser, { theme: "dark", view });
      await sim(page, "seek", S(640));
      await waitPrepared(page);
      await sleep(2500);
      const order = [];
      for (let i = 0; i < 160; i++) {
        await page.keyboard.press("Tab");
        const a = await active(page);
        a.inHiddenView = await page.evaluate(() => Boolean(document.activeElement?.closest("[data-stage-view]:not([data-stage-active])")));
        if (i > 2 && order.length && a.tag === order[0].tag && a.name === order[0].name && a.box.join() === order[0].box.join()) break;
        order.push(a);
      }
      report[view === "atlas" ? "focusOrder" : "focusOrderBlueprint"] = order;
      report.hiddenView ??= {};
      report.hiddenView[`tabStopsInHiddenView (${view} active)`] = order.filter((o) => o.inHiddenView).length;
      await context.close();
    }

    // Skip link, canvas, zoom, pan, arrows, selection, agent inspection, focus.
    await fresh(async (page) => {
      const step = stepper(page);
      await step("skip link (first Tab stop), Enter moves to the stage", ["Tab", "Enter"], async (_b, _a, f) => [f.region === "stage", `focus in ${f.region} (${f.role ?? f.tag})`]);
      await step("Tab into the Atlas canvas", ["Tab"], async (_b, _a, f) => [f.region === "stage" && f.role === "application", `${f.role ?? f.tag} ${f.ref ?? ""}`]);
      let cam0 = await camera(page);
      await step("zoom in (+)", ["+"], async () => {
        const c = await camera(page);
        const ok = c.zoom > cam0.zoom;
        cam0 = c;
        return [ok, `zoom ${c.zoom.toFixed(2)}`];
      });
      await step("zoom out (-)", ["-", "-"], async () => {
        const c = await camera(page);
        const ok = c.zoom < cam0.zoom;
        cam0 = c;
        return [ok, `zoom ${c.zoom.toFixed(2)}`];
      });
      await step("pan (Shift+Arrows)", ["Shift+ArrowRight", "Shift+ArrowDown"], async () => {
        const c = await camera(page);
        const dx = Math.round(c.x - cam0.x);
        const dy = Math.round(c.y - cam0.y);
        cam0 = c;
        return [dx !== 0 || dy !== 0, `camera moved ${dx}, ${dy} px`];
      });
      await step("fit (0)", ["0"], async () => [true, `zoom ${(await camera(page)).zoom.toFixed(2)}`]);
      // Spatial arrows: the navigation graph at the fit, at three moments, and a breadth-first search
      // from the entry point (every arrow pressed from every entity).
      report.atlasArrowReach = [];
      for (const t of [640, 2622, 3350]) {
        await sim(page, "seek", S(t));
        await page.evaluate(() => window.__atlasCamera.fit());
        await sleep(900);
        const g = await arrowGraph(page);
        report.atlasArrowReach.push({ t, total: g.total, distinctRefs: g.distinctRefs, duplicateRefs: g.duplicateRefs, entry: g.entry, reached: g.reached, unreached: g.unreached, longestPath: g.longestPath, deadEnds: g.deadEnds, edges: Object.fromEntries(g.refs.map((r, i) => [r, Object.fromEntries(ARROWS.map((k) => [k.replace("Arrow", ""), g.refs[g.edges[i][k]] ?? null]))])) });
        log(`arrows at ${t}s: ${g.reached} of ${g.total} reachable from ${g.entry}; longest path ${g.longestPath}`);
      }
      // And zoomed in to 2.0 on LOCAL-031 at 27:40 (bays off screen are culled from the drawing).
      await sim(page, "seek", S(1660));
      await sim(page, "focus", "cell:LOCAL-031");
      await sleep(900);
      await page.evaluate(() => window.__atlasCamera.zoomTo(2.0));
      await sleep(600);
      {
        const g = await arrowGraph(page);
        report.atlasArrowReachZoomed = { t: 1660, zoom: 2.0, total: g.total, reached: g.reached, unreached: g.unreached, entry: g.entry };
      }
      await sim(page, "seek", S(640));
      await page.evaluate(() => window.__atlasCamera.fit());
      await sleep(700);
      await page.locator(`${ACTIVE} [data-view=atlas]`).focus();
      const agent = await reachBy(page, "agent:");
      await step("select an agent (arrows to it, Enter)", ["Enter"], async (_b, a) => [Boolean(agent) && a.selection === agent, `reached ${agent}, selection ${a.selection}`]);
      await step("agent inspection: the inspector lists its tool calls", [], async () => {
        const text = await page.locator("aside").innerText();
        return [/Tool calls/.test(text), /Tool calls/.test(text) ? "inspector lists tool calls" : "no tool calls listed"];
      });
      await step("focus the selection (F)", ["f"], async (_b, a) => [a.focus === a.selection, `camera focus target ${a.focus}`]);
      await step("Escape clears the selection", ["Escape"], async (_b, a) => [a.selection === null, `selection ${a.selection}`]);
    });

    // Dependency highlighting by keyboard.
    await fresh(async (page) => {
      const step = stepper(page);
      await page.locator(ACTIVE_ATLAS).focus();
      const dep = await reachBy(page, "dependency:");
      const before = await dimmedCount(page);
      await step("dependency highlighting (arrows to a dependency, Enter)", ["Enter"], async (_b, a) => {
        const after = await dimmedCount(page);
        return [Boolean(dep) && a.selection === dep && after > before, `reached ${dep}; dimmed groups ${before} to ${after}`];
      });
    });

    // Playback, views and panels from the canvas (not a button, which owns Space).
    await fresh(async (page) => {
      const step = stepper(page);
      await page.locator(ACTIVE_ATLAS).focus();
      await step("play (Space)", [" "], async (b, a) => [a.playing && !b.playing, `playing ${a.playing}`]);
      await step("pause (Space)", [" "], async (b, a) => [!a.playing && b.playing, `playing ${a.playing}`]);
      await step("next, next, previous event (. . ,)", [".", ".", ","], async (b, a) => [a.cursor === b.cursor + 1, `cursor ${b.cursor} to ${a.cursor}`]);
      await step("forward 10 s (Shift+.)", ["Shift+Period"], async (b, a) => [Math.round((a.playhead - b.playhead) / 1000) === 10, `playhead +${Math.round((a.playhead - b.playhead) / 1000)} s`]);
      await step("back 10 s (Shift+,)", ["Shift+Comma"], async (b, a) => [Math.round((b.playhead - a.playhead) / 1000) === 10, `playhead -${Math.round((b.playhead - a.playhead) / 1000)} s`]);
      await step("next chapter (])", ["]"], async (b, a) => [a.playhead > b.playhead, `playhead ${Math.round(a.playhead / 1000)} s`]);
      await step("previous chapter ([)", ["["], async (b, a) => [a.playhead < b.playhead, `playhead ${Math.round(a.playhead / 1000)} s`]);
      await step("faster (} })", ["}", "}"], async (b, a) => [a.speed > b.speed, `speed ${b.speed} to ${a.speed}`]);
      await step("slower ({)", ["{"], async (b, a) => [a.speed < b.speed, `speed ${b.speed} to ${a.speed}`]);
      await step("start of the run (Home)", ["Home"], async (_b, a) => [a.playhead === 0, `playhead ${a.playhead}`]);
      await step("live edge (End)", ["End"], async (_b, a) => [a.following, `following ${a.following}`]);
      await step("return to live and follow (L)", ["l"], async (_b, a) => [a.following && a.follow, `following ${a.following}, follow ${a.follow}`]);
      await step("camera follow back on (Shift+F)", ["Shift+F"], async (_b, a) => [a.follow, `follow ${a.follow}`]);
      await step("Theater Mode (T)", ["t"], async (_b, a) => [a.theater, `theater ${a.theater}`]);
      await step("leave Theater Mode (Escape, nothing selected)", ["Escape"], async (_b, a) => [!a.theater, `theater ${a.theater}`]);
      await step("hide the inspector (I)", ["i"], async () => [await page.evaluate(() => document.querySelector("aside")?.hasAttribute("inert")), "inspector inert when hidden"]);
      await step("show the inspector (I)", ["i"], async () => [await page.evaluate(() => !document.querySelector("aside")?.hasAttribute("inert")), "inspector back"]);
      await step("collapse the timeline (Shift+T)", ["Shift+T"], async () => {
        const h = await page.evaluate(() => document.querySelector("section[aria-label='Execution timeline']")?.getBoundingClientRect().height);
        return [h < 60, `timeline height ${Math.round(h)} px`];
      });
      await page.keyboard.press("Shift+T");
      await step("help sheet (?)", ["?"], async (_b, _a, f) => [f.region === "dialog", `focus in ${f.region}`]);
      await step("close help (Escape); focus returns", ["Escape"], async (_b, _a, f) => [f.region !== "dialog" && f.tag !== "body", `focus in ${f.region}`]);
    });

    // Scrubbing by keyboard: the playhead strip is a slider.
    await fresh(async (page) => {
      const step = stepper(page);
      await page.locator('[role=slider][aria-label="Playhead over the whole run"]').focus();
      await step("scrub forward on the slider (Right, Right, PageDown)", ["ArrowRight", "ArrowRight", "PageDown"], async (b, a) => [a.playhead > b.playhead, `playhead ${Math.round(b.playhead / 1000)} to ${Math.round(a.playhead / 1000)} s`]);
      await step("scrub back (PageUp, Left)", ["PageUp", "ArrowLeft"], async (b, a) => [a.playhead < b.playhead, `playhead ${Math.round(b.playhead / 1000)} to ${Math.round(a.playhead / 1000)} s`]);
      await step("slider value is announced", [], async () => {
        const v = await page.locator('[role=slider][aria-label="Playhead over the whole run"]').evaluate((e) => `${e.getAttribute("aria-valuenow")} / ${e.getAttribute("aria-valuetext") ?? "no valuetext"}`);
        return [!/^0 \//.test(v), `aria-valuenow ${v}`];
      });
      // The timeline tracks: one tab stop, arrows step between events.
      const tracks = page.locator('[role=application][aria-label^="Execution tracks"]');
      if (await tracks.count()) {
        await tracks.focus();
        await step("timeline tracks: Right steps to the next event", ["ArrowRight"], async (b, a) => [a.cursor > b.cursor, `cursor ${b.cursor} to ${a.cursor}`]);
        await step("timeline tracks: Down chooses a track, Enter selects it", ["ArrowDown", "Enter"], async (_b, a) => [Boolean(a.selection), `selection ${a.selection}`]);
      }
    });

    // The Blueprint: switch with 2, walk the tree, expand and collapse, select, zoom, pan.
    await fresh(async (page) => {
      const step = stepper(page);
      await page.locator(ACTIVE_ATLAS).focus();
      await step("Execution Blueprint (2)", ["2"], async (_b, a, f) => [a.view === "blueprint" && f.region === "stage", `view ${a.view}; focus ${f.role ?? f.tag}`]);
      await sleep(800);
      const expandedCount = () => page.evaluate(() => document.querySelectorAll('[data-stage-view="blueprint"] [role=treeitem][aria-expanded="true"]').length);
      await step("tree navigation (ArrowDown x3)", ["ArrowDown", "ArrowDown", "ArrowDown"], async (_b, _a, f) => [f.role === "treeitem", `${f.role} ${f.name}`]);
      let e0 = await expandedCount();
      let expandedOk = false;
      for (let i = 0; i < 40 && !expandedOk; i++) {
        const collapsed = await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded") === "false");
        if (collapsed) {
          await page.keyboard.press("Alt+ArrowRight");
          await sleep(500);
          expandedOk = (await expandedCount()) > e0;
        } else await page.keyboard.press("ArrowDown");
      }
      steps.push({ interaction: "graph expansion (Alt+Right on a collapsed item)", keys: "ArrowDown… Alt+ArrowRight", ok: expandedOk, evidence: `expanded items ${e0} to ${await expandedCount()}` });
      e0 = await expandedCount();
      await step("collapse (Alt+Left)", ["Alt+ArrowLeft"], async () => [(await expandedCount()) < e0, `expanded ${e0} to ${await expandedCount()}`]);
      await step("select in the Blueprint (Enter)", ["Enter"], async (_b, a) => [Boolean(a.selection), `selection ${a.selection}`]);
      const zoomText = () => page.locator('[data-stage-view="blueprint"] .bp-zoom').innerText().catch(() => "?");
      const z0 = await zoomText();
      await step("Blueprint zoom in (+)", ["+"], async () => [(await zoomText()) !== z0, `${z0} to ${await zoomText()}`]);
      await step("Blueprint pan (Shift+ArrowDown)", ["Shift+ArrowDown"], async () => [true, "no error (pan has no readout)"]);
      await step("back to the Atlas (1)", ["1"], async (_b, a) => [a.view === "atlas", `view ${a.view}`]);
    });
    report.keyboard = steps;

    // Focus-ring images: one per region.
    await fresh(async (page) => {
      for (const [name, locator] of [
        ["skip-link", page.getByRole("link", { name: /Skip/ })],
        ["theater-button", page.getByRole("button", { name: "Theater", exact: true })],
        ["slider", page.locator('[role=slider][aria-label="Playhead over the whole run"]')],
        ["play", page.locator('[data-transport="play"]')],
      ]) {
        if (!(await locator.count())) continue;
        await locator.first().focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await sleep(200);
        const b = await locator.first().boundingBox();
        if (b && b.width > 0 && b.y < 1080) await page.screenshot({ path: join(out, `focus-${name}.png`), clip: { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: Math.min(600, b.width + 48), height: Math.min(1080 - Math.max(0, b.y - 24), b.height + 48) } }).catch(() => {});
      }
      await page.locator(ACTIVE_ATLAS).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await sleep(300);
      await page.screenshot({ path: join(out, "focus-atlas-entity.png") });
    });
  }
  log("keyboard:", report.keyboard.filter((s) => !s.ok).length, "steps failed");

  // ------------------------------------------------------------ 2b. focus return after the help sheet
  // Each opener is marked, "?" opens the sheet, Escape closes it, and focus must be back on the very
  // element (or, if a view re-rendered it away, on that view's canvas).
  {
    report.helpFocusReturn = [];
    const openers = [
      ["Atlas canvas", "atlas", async (p) => p.locator(ACTIVE_ATLAS).focus()],
      ["Atlas entity (arrow)", "atlas", async (p) => (await p.locator(ACTIVE_ATLAS).focus(), p.keyboard.press("ArrowRight"))],
      ["Atlas entity, selected (Enter)", "atlas", async (p) => (await p.locator(ACTIVE_ATLAS).focus(), await p.keyboard.press("ArrowRight"), await p.keyboard.press("ArrowRight"), p.keyboard.press("Enter"))],
      ["Blueprint tree item", "blueprint", async (p) => (await p.locator(`${ACTIVE} [role=treeitem]`).first().focus(), p.keyboard.press("ArrowDown"))],
      ["playhead slider", "atlas", async (p) => p.locator('[role=slider][aria-label="Playhead over the whole run"]').focus()],
      ["timeline tracks", "atlas", async (p) => p.locator('[role=application][aria-label^="Execution tracks"]').focus()],
      ["top-bar inspector button", "atlas", async (p) => p.getByRole("button", { name: /inspector/ }).first().focus()],
      ["help button, by keyboard (Enter)", "atlas", async (p) => p.getByRole("button", { name: /Keyboard|help|shortcuts/i }).first().focus(), "Enter"],
      ["help button, by mouse", "atlas", null, "click"],
    ];
    for (const [label, view, prepare, how = "?"] of openers) {
      const { context, page } = await openApp(browser, { theme: "dark", view });
      await sim(page, "seek", S(640));
      await waitPrepared(page);
      await sleep(1200);
      try {
        if (how === "click") await page.getByRole("button", { name: /Keyboard|help|shortcuts/i }).first().click();
        else {
          await prepare(page);
          await sleep(300);
        }
        const opener = await page.evaluate(() => {
          const el = document.activeElement;
          el?.setAttribute("data-probe-opener", "");
          return { tag: el?.tagName.toLowerCase(), role: el?.getAttribute("role"), ref: el?.getAttribute("data-ref"), name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim().slice(0, 60) };
        });
        if (how === "Enter") await page.keyboard.press("Enter");
        else if (how === "?") await page.keyboard.press("?");
        await page.getByRole("dialog").waitFor({ timeout: 3000 });
        await sleep(400);
        await page.keyboard.press("Escape");
        await sleep(500);
        const after = await page.evaluate(() => {
          const el = document.activeElement;
          return { same: Boolean(el?.hasAttribute("data-probe-opener")), tag: el?.tagName.toLowerCase(), role: el?.getAttribute("role"), ref: el?.getAttribute("data-ref"), focusVisible: el?.matches(":focus-visible") ?? false, name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim().slice(0, 60) };
        });
        report.helpFocusReturn.push({ opener: label, from: opener, to: after, ok: after.same });
      } catch (e) {
        report.helpFocusReturn.push({ opener: label, ok: false, error: String(e).slice(0, 200) });
      }
      await context.close();
    }
    // An opener that is re-rendered away while the sheet is open: an agent focused at 10:40, the
    // playhead moved (hook) to 00:10 while the sheet is open, so the agent no longer exists.
    {
      const { context, page } = await openApp(browser, { theme: "dark" });
      await sim(page, "seek", S(640));
      await sleep(1000);
      await page.locator(ACTIVE_ATLAS).focus();
      const g = await arrowGraph(page);
      const target = Object.keys(g.paths).find((r) => r.startsWith("agent:"));
      await page.locator(ACTIVE_ATLAS).focus();
      for (const k of g.paths[target] ?? []) await page.keyboard.press(k.split(" ")[0]);
      await page.keyboard.press("?");
      await page.getByRole("dialog").waitFor();
      await sim(page, "seek", S(10));
      await sleep(400);
      await page.keyboard.press("Escape");
      await sleep(500);
      const after = await page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), tag: document.activeElement?.tagName.toLowerCase(), inAtlas: Boolean(document.activeElement?.closest("[data-stage-active] [data-view=atlas]")) }));
      report.helpFocusReturn.push({ opener: `agent ${target} re-rendered away while open`, to: after, ok: after.inAtlas });
      await context.close();
    }
    log("help focus return:", report.helpFocusReturn.filter((r) => !r.ok).map((r) => r.opener));
  }

  // ------------------------------------------------------------ 2d. probes for earlier defects D8 and D14
  {
    report.defectProbes = {};
    // D8: an Atlas accessible name after playing to a time, against seeking straight to it.
    const labels = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-stage-active] [data-view=atlas] [data-ref][role=button]")].map((e) => [e.getAttribute("data-ref"), e.getAttribute("aria-label")])));
    const runs = {};
    for (const route of ["seek", "play"]) {
      const { context, page } = await openApp(browser, { theme: "dark" });
      await sim(page, "setFollow", false);
      if (route === "seek") await sim(page, "seek", S(400));
      else {
        await sim(page, "seek", S(390));
        await sim(page, "setSpeed", 1);
        await sim(page, "play");
        await page.evaluate(() => window.__machSim.advance(1000, 250));
        await sim(page, "pause");
      }
      await sleep(500);
      await frames(page, 3);
      runs[route] = await labels(page);
      runs[`${route}-playhead`] = await page.evaluate(() => window.__machSim.state().playhead);
      await context.close();
    }
    const differ = Object.keys(runs.seek).filter((k) => runs.seek[k] !== runs.play[k]).map((k) => ({ ref: k, seek: runs.seek[k], play: runs.play[k] }));
    report.defectProbes.D8_staleNames = { at: "06:40 (seek) vs 06:30 + 10 s of 1x play", playheads: [runs["seek-playhead"], runs["play-playhead"]], entities: Object.keys(runs.seek).length, differing: differ };
    // D14: with the dependency selected, are its prerequisite and its dependent both lit?
    {
      const { context, page } = await openApp(browser, { theme: "dark" });
      await sim(page, "seek", S(2622));
      await sim(page, "select", "dependency:SLICE-024->SLICE-021");
      await sleep(800);
      const op = (ref) => page.evaluate((r) => {
        const el = document.querySelector(`[data-stage-active] [data-view=atlas] [data-ref="${r}"]`);
        if (!el) return null;
        let o = 1;
        for (let n = el; n && n.tagName !== "svg"; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        return Math.round(o * 100) / 100;
      }, ref);
      const refs = await page.evaluate(() => [...document.querySelectorAll("[data-stage-active] [data-view=atlas] [data-ref^='slice:'], [data-stage-active] [data-view=atlas] [data-ref^='dependency:'], [data-stage-active] [data-view=atlas] [data-ref^='cell:']")].map((e) => e.getAttribute("data-ref")));
      const out = {};
      for (const r of [...new Set(refs)]) out[r] = await op(r);
      report.defectProbes.D14_dependencyChain = { selected: "dependency:SLICE-024->SLICE-021", t: "43:42", effectiveOpacity: out };
      await context.close();
    }
    log("defect probes:", JSON.stringify({ D8: report.defectProbes.D8_staleNames.differing.length, D14: report.defectProbes.D14_dependencyChain.effectiveOpacity["slice:SLICE-025"] }));
  }

  // ------------------------------------------------------------ 2c. the hidden view (both stay mounted)
  // Duplicate ids, what a screen reader is given, and whether keys reach the hidden view.
  {
    const h = (report.hiddenView ??= {});
    const dupIds = (page) =>
      page.evaluate(() => {
        const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
        return [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
      });
    const { context, page } = await openApp(browser, { theme: "dark" });
    await sim(page, "seek", S(1660));
    await sim(page, "select", "cell:LOCAL-031");
    await waitPrepared(page);
    await sleep(2500);
    h.duplicateIds = { atlasActive: await dupIds(page) };
    h.layersAtlasActive = await page.evaluate(() => [...document.querySelectorAll("[data-stage-view]")].map((e) => ({ view: e.dataset.stageView, active: e.hasAttribute("data-stage-active"), inert: e.inert, ariaHidden: e.getAttribute("aria-hidden"), visibility: getComputedStyle(e).visibility })));
    const snapA = await page.locator("body").ariaSnapshot();
    h.ariaAtlasActive = { mentionsTree: /- tree\b/.test(snapA), mentionsPlantDrawing: /application "Factory Atlas/.test(snapA), mainLabel: await page.evaluate(() => document.querySelector("main")?.getAttribute("aria-label")) };
    // Keys with focus outside any view while the Atlas is up: must not move the hidden Blueprint.
    const bpZoom = () => page.evaluate(() => document.querySelector('[data-stage-view="blueprint"] [style*="scale("]')?.style.transform ?? null);
    const atZoom = () => page.evaluate(() => window.__atlasCamera.get().zoom);
    await page.getByRole("button", { name: /inspector/ }).first().focus();
    const b0 = await bpZoom();
    const a0 = await atZoom();
    for (const k of ["+", "+", "-", "0", "Shift+ArrowDown"]) await page.keyboard.press(k);
    await sleep(600);
    h.keysOutsideViewsWhileAtlasUp = { blueprintTransformChanged: (await bpZoom()) !== b0, atlasZoomChanged: Math.abs((await atZoom()) - a0) > 1e-3 };
    // Now the Blueprint up, expanded everywhere: ids and the tree.
    await page.keyboard.press("2");
    await sleep(1500);
    for (let i = 0; i < 30; i++) {
      const item = page.locator(`${ACTIVE} [role=treeitem][aria-expanded="false"]`).first();
      if (!(await item.count())) break;
      await item.focus();
      await page.keyboard.press("Alt+ArrowRight");
      await sleep(120);
    }
    h.duplicateIds.blueprintActiveExpanded = await dupIds(page);
    const snapB = await page.locator("body").ariaSnapshot();
    h.ariaBlueprintActive = { mentionsTree: /- tree\b/.test(snapB), mentionsPlantDrawing: /application "Factory Atlas/.test(snapB), mainLabel: await page.evaluate(() => document.querySelector("main")?.getAttribute("aria-label")), treeItemsInActive: await page.locator(`${ACTIVE} [role=treeitem]`).count(), atlasEntityButtonsInHidden: await page.locator('[data-stage-view="atlas"]:not([data-stage-active]) [role=button]').count() };
    await page.getByRole("button", { name: /inspector/ }).first().focus();
    const a1 = await atZoom();
    const b1 = await bpZoom();
    for (const k of ["+", "+", "-"]) await page.keyboard.press(k);
    await sleep(600);
    h.keysOutsideViewsWhileBlueprintUp = { blueprintTransformChanged: (await bpZoom()) !== b1, atlasZoomChanged: Math.abs((await atZoom()) - a1) > 1e-3 };
    // The help sheet open over the Blueprint.
    await page.keyboard.press("?");
    await page.getByRole("dialog").waitFor();
    h.duplicateIds.helpOpen = await dupIds(page);
    await page.keyboard.press("Escape");
    // Can a hidden-view element take focus at all (programmatically)? inert should refuse it.
    h.hiddenElementFocusable = await page.evaluate(() => {
      const el = document.querySelector('[data-stage-view="atlas"]:not([data-stage-active]) [data-view=atlas]');
      el?.focus();
      return document.activeElement === el;
    });
    await context.close();
  }

  // ------------------------------------------------------------ 4. reduced motion, measured
  // Thirty frames of 1x playback (33 ms of wall time each) through five travelling moments, at a fixed
  // camera. A thing that travels moves in many consecutive frames; a thing re-laid out because
  // something appeared jumps once. Counted separately, with every running Web Animation by name.
  report.reducedMotion = {};
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const { context, page } = await openApp(browser, { reducedMotion });
    await sim(page, "setFollow", false);
    const windows = [];
    let maxRunning = 0;
    for (const [label, t] of [
      ["wave arrives (D1)", 31],
      ["review fan-out", 1580.5],
      ["verification fails, return to build (D3)", 1639],
      ["rejection crosses the plant", 1928.3],
      ["merge worker leaves (D2)", 2562.6],
      ["dependency unlocks", 2610.6],
    ]) {
      await sim(page, "seek", S(t - 0.5));
      await sim(page, "setSpeed", 1);
      await sim(page, "play");
      let prev = await positions(page);
      const moves = {};
      const anims = new Set();
      for (let i = 0; i < 30; i++) {
        await page.evaluate(() => window.__machSim.advance(1000 / 30, 1000 / 30));
        await frames(page, 1);
        const next = await positions(page);
        for (const [k, p] of Object.entries(next)) {
          const q = prev[k];
          if (q && (Math.abs(q[0] - p[0]) > 0.5 || Math.abs(q[1] - p[1]) > 0.5)) moves[k] = (moves[k] ?? 0) + 1;
        }
        const running = await page.evaluate(() =>
          document
            .getAnimations()
            .filter((x) => x.playState === "running")
            .map((x) => `${x.constructor.name}:${x.transitionProperty ?? x.animationName ?? "?"} on ${(x.effect?.target?.getAttribute?.("class") ?? x.effect?.target?.tagName ?? "?").toString().slice(0, 50)}`),
        );
        maxRunning = Math.max(maxRunning, running.length);
        for (const a of running) anims.add(a);
        prev = next;
      }
      await sim(page, "pause");
      const travelling = Object.entries(moves).filter(([, n]) => n >= 3);
      windows.push({
        label,
        t,
        elementsTravelling: travelling.length,
        travellers: [...new Set(travelling.map(([k]) => k.split("|")[0]))].slice(0, 10),
        elementsJumpingOnce: Object.values(moves).filter((n) => n < 3).length,
        runningAnimations: [...anims].slice(0, 12),
      });
    }
    // Camera follow during playback: how the camera moves (an ease moves it in many consecutive
    // frames; a jump in one). 20 s of factory time at 16x from 10:00, follow on, 30 frames.
    {
      await sim(page, "seek", S(600));
      await page.evaluate(() => window.__atlasCamera.zoomTo(1.6));
      await sim(page, "followLive");
      await sim(page, "setFollow", true);
      await sim(page, "setSpeed", 16);
      await sim(page, "play");
      const cams = [];
      for (let i = 0; i < 90; i++) {
        await page.evaluate(() => window.__machSim.advance(1000 / 30, 1000 / 30));
        await frames(page, 1);
        cams.push(await page.evaluate(() => window.__atlasCamera.get()));
      }
      await sim(page, "pause");
      await sim(page, "setFollow", false);
      const moved = cams.slice(1).map((c, i) => Math.hypot(c.x - cams[i].x, c.y - cams[i].y) > 0.5 || Math.abs(c.zoom - cams[i].zoom) > 0.001);
      let runs = 0;
      let longest = 0;
      let cur = 0;
      for (const m of moved) {
        if (m) {
          cur++;
          if (cur === 1) runs++;
          longest = Math.max(longest, cur);
        } else cur = 0;
      }
      windows.push({ label: "camera follow, 16x, 90 frames", framesWithCameraMove: moved.filter(Boolean).length, separateMoves: runs, longestRunOfMovingFrames: longest });
    }
    // The mode switch: under reduced motion a cut. Each layer's visibility and opacity, and the
    // animations on the stage layers, in each of the four frames after the key.
    await sim(page, "pause");
    await page.locator(ACTIVE_ATLAS).focus();
    const switchFrames = [];
    for (const key of ["2", "1"]) {
      await page.keyboard.press(key);
      for (let f = 0; f < 4; f++) {
        await frames(page, 1);
        switchFrames.push(
          await page.evaluate((k) => ({
            key: k,
            layers: [...document.querySelectorAll("[data-stage-view]")].map((e) => `${e.dataset.stageView}${e.hasAttribute("data-stage-active") ? "*" : ""} ${getComputedStyle(e).visibility} op ${Number(getComputedStyle(e).opacity).toFixed(2)} tf ${getComputedStyle(e).transform}`),
            stageAnimations: [...document.querySelectorAll("[data-stage-view]")].flatMap((e) => e.getAnimations().map((a) => `${e.dataset.stageView}: ${a.constructor.name} ${a.playState}`)),
          }), key),
        );
      }
      await sleep(900);
    }
    windows.push({ label: "mode switch, four frames after each key", frames: switchFrames });
    windows.push({ label: "most Web Animations running at once over the windows", maxRunning });
    report.reducedMotion[reducedMotion] = windows;
    await context.close();
  }

  // ------------------------------------------------------------ 5. token contrast
  report.contrast = {};
  for (const theme of ["dark", "light"]) {
    const { context, page } = await openApp(browser, { theme });
    report.contrast[theme] = await page.evaluate(() => {
      const root = getComputedStyle(document.querySelector("[data-mach-theme], .mach-frame") ?? document.documentElement);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      const rgb = (name) => {
        const v = root.getPropertyValue(name).trim() || getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (!v) return null;
        g.clearRect(0, 0, 1, 1);
        g.fillStyle = "#000";
        g.fillStyle = v;
        g.fillRect(0, 0, 1, 1);
        const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
        return [r, gg, b];
      };
      const lum = ([r, gg, b]) => [r, gg, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
        return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
      };
      const surfaces = ["--mach-factory-ground", "--mach-factory-plate-top", "--mach-factory-floor", "--mach-factory-machine-top", "--mach-factory-done"];
      const text = ["--mach-ink", "--mach-ink-muted", "--mach-factory-ink"];
      const marks = ["--mach-factory-live", "--mach-factory-pass", "--mach-factory-fail", "--mach-factory-wait", "--mach-factory-human", "--mach-factory-route", "--mach-factory-select", "--mach-factory-ink-soft"];
      const rows = [];
      for (const s of surfaces) {
        const bg = rgb(s);
        if (!bg) continue;
        for (const t of text) {
          const fg = rgb(t);
          if (fg) rows.push({ fg: t, bg: s, ratio: ratio(fg, bg), need: 4.5 });
        }
        for (const m of marks) {
          const fg = rgb(m);
          if (fg) rows.push({ fg: m, bg: s, ratio: ratio(fg, bg), need: 3 });
        }
      }
      for (const m of ["live", "pass", "fail", "wait", "human"]) {
        const fg = rgb(`--mach-factory-${m}`);
        const bg = rgb(`--mach-factory-${m}-soft`);
        if (fg && bg) rows.push({ fg: `--mach-factory-${m}`, bg: `--mach-factory-${m}-soft`, ratio: ratio(fg, bg), need: 3 });
      }
      return { pairs: rows.length, failing: rows.filter((r) => r.ratio < r.need), lowest: [...rows].sort((a, b) => a.ratio / a.need - b.ratio / b.need).slice(0, 6) };
    });
    await context.close();
  }

  // ------------------------------------------------------------ 7. accessibility tree and live regions
  {
    const { context, page } = await openApp(browser, { theme: "dark" });
    await sim(page, "seek", S(1660));
    await sim(page, "select", "gate:LOCAL-031/verification#1");
    await sleep(1200);
    writeFileSync(join(out, "aria-atlas-selected.txt"), await page.locator("body").ariaSnapshot());
    await sim(page, "setMode", "blueprint");
    await sleep(1500);
    writeFileSync(join(out, "aria-blueprint-selected.txt"), await page.locator("body").ariaSnapshot());
    report.landmarks = await page.evaluate(() => [...document.querySelectorAll("header, main, aside, section[aria-label], nav, [role=region], [role=toolbar], [role=tree], [role=application]")].map((e) => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""}: ${e.getAttribute("aria-label") ?? ""}`));
    await context.close();
  }
  {
    // A minute of playback at 1x from 26:40, on the virtual clock (page.clock + the manual sim clock).
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-11-10T14:00:00Z") });
    await page.goto(`${ORIGIN}/?theme=dark#atlas`);
    await page.waitForFunction(() => Boolean(window.__machSim));
    await page.clock.runFor(1000);
    await page.clock.pauseAt(new Date("2026-11-10T14:00:05Z"));
    await page.evaluate(() => {
      window.__said = [];
      const obs = new MutationObserver(() => {
        for (const el of document.querySelectorAll("[aria-live]:not([aria-live=off])")) {
          const text = el.textContent.trim();
          const key = el.getAttribute("data-announcer") ?? el.className;
          const last = window.__said.filter((s) => s.region === key).pop();
          if (text && (!last || last.text !== text)) window.__said.push({ region: key, text, playhead: window.__machSim.state().playhead, wall: performance.now() });
        }
      });
      obs.observe(document.body, { subtree: true, childList: true, characterData: true });
      const s = window.__machSim;
      s.useManualClock();
      s.seek(1600000);
      s.setSpeed(1);
      s.play();
    });
    const t0 = await page.evaluate(() => performance.now());
    for (let i = 0; i < 60 * 30; i++) {
      const ms = Math.round(((i + 1) * 1000) / 30) - Math.round((i * 1000) / 30);
      await page.evaluate((m) => window.__machSim.advance(m, m), ms);
      await page.clock.runFor(ms);
    }
    report.liveRegion = (await page.evaluate(() => window.__said)).map((s) => ({ ...s, wall: Math.round(s.wall) }));
    report.liveRegionWindow = { from: "26:40 factory", wallSeconds: 60, speed: 1, startedAtWall: Math.round(t0) };
    await context.close();
  }

  // ------------------------------------------------------------ 8. 200% zoom (reflow)
  report.zoom200 = [];
  for (const [label, width, height] of [
    ["1920x1080 at 200%", 960, 540],
    ["1280x800 at 200%", 640, 400],
  ]) {
    for (const [stateName, view, select] of [
      ["atlas", "atlas", null],
      ["atlas-selected", "atlas", "gate:LOCAL-031/verification#1"],
      ["blueprint-selected", "blueprint", "gate:LOCAL-031/verification#1"],
    ]) {
      const { context, page } = await openApp(browser, { theme: "dark", width, height, dpr: 2, view });
      await sim(page, "seek", S(1660));
      if (select) await sim(page, "select", select);
      await sleep(1500);
      const file = `zoom200-${width}x${height}-${stateName}.png`;
      await page.screenshot({ path: join(out, file) });
      const check = await page.evaluate(() => {
        const box = (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        };
        const controls = [...document.querySelectorAll("header button, header input, header [role=radio], [data-transport], [role=toolbar] button, section[aria-label='Execution timeline'] button, [role=slider]")].filter((e) => !e.closest("[inert]") && !e.closest("[data-stage-view]:not([data-stage-active])"));
        const offscreen = controls
          .map((e) => [e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 30), e.getBoundingClientRect()])
          .filter(([, r]) => r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.width === 0)
          .map(([n]) => n);
        // Controls covered by something else at their centre (the drawer over the transport, say).
        const covered = controls
          .filter((e) => {
            const r = e.getBoundingClientRect();
            if (!r.width || r.right > innerWidth || r.bottom > innerHeight) return false;
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return hit && hit !== e && !e.contains(hit) && !hit.contains(e);
          })
          .map((e) => e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 30));
        const stamp = [...document.querySelectorAll("[data-simulation-stamp]")].some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight && getComputedStyle(el).visibility !== "hidden";
        });
        return { horizontalScroll: document.documentElement.scrollWidth > innerWidth, verticalScroll: document.documentElement.scrollHeight > innerHeight, controlsOffscreenOrHidden: offscreen, controlsCovered: covered, stampVisible: stamp, stage: box("#stage"), timeline: box("section[aria-label='Execution timeline']"), inspector: box("aside") };
      });
      const a = await axe(page, `200% ${stateName}`);
      report.zoom200.push({ label, state: stateName, file, ...check, axe: a.violations });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}

// ------------------------------------------------------------ 6. greyscale renders (from the capture set)
report.greyscale = [];
for (const name of ["03-three-bays-atlas-dark@2x", "07-verify-fail-return-atlas-light@2x", "08-rejection-crosses-atlas-dark@2x", "12-human-gate-released-atlas-dark@2x", "07-verify-fail-return-blueprint-dark", "10-dependency-unlocks-atlas-light"]) {
  const src = join(app, "screenshots", `${name}.png`);
  const dst = join(out, `grey-${name}.png`);
  try {
    execFileSync(FFMPEG, ["-v", "error", "-y", "-i", src, "-vf", "format=gray", dst]);
    report.greyscale.push(dst);
  } catch {
    report.greyscale.push(`missing: ${src} (run capture.mjs first)`);
  }
}

/** Screen positions of every drawn element in the Atlas, keyed by its entity and its index among its tag. */
async function positions(page) {
  return page.evaluate(() => {
    const out = {};
    for (const ent of document.querySelectorAll("[data-stage-active] [data-view=atlas] [data-ref]")) {
      const ref = ent.getAttribute("data-ref");
      const kids = ent.querySelectorAll("g[transform], g[style*=transform], circle, rect, path, polygon, text, use");
      const counts = {};
      for (const k of kids) {
        if (k.closest("[data-ref]") !== ent) continue;
        const tag = k.tagName;
        counts[tag] = (counts[tag] ?? 0) + 1;
        const r = k.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        out[`${ref}|${tag}#${counts[tag]}|n${kids.length}`] = [r.left, r.top];
      }
    }
    return out;
  });
}

writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      axeViolations: report.axe.flatMap((r) => r.violations.map((v) => `${r.theme} ${r.size} ${r.view} ${r.state}: ${v.id} (${v.nodes})`)),
      keyboardFailed: report.keyboard?.filter((s) => !s.ok),
      atlasArrows: report.atlasArrowReach?.map((r) => `${r.t}s: ${r.reached}/${r.total} (unreached ${r.unreached.join(", ") || "none"})`),
      atlasArrowsZoomed: report.atlasArrowReachZoomed && `${report.atlasArrowReachZoomed.reached}/${report.atlasArrowReachZoomed.total}`,
      helpFocusReturn: report.helpFocusReturn?.map((r) => `${r.ok ? "ok" : "FAIL"} ${r.opener}${r.ok ? "" : ` -> ${JSON.stringify(r.to ?? r.error)}`}`),
      hiddenView: report.hiddenView,
      focusStops: [report.focusOrder?.length, report.focusOrderBlueprint?.length],
      reduced: Object.fromEntries(Object.entries(report.reducedMotion).map(([k, v]) => [k, v.map((w) => (w.frames ? `${w.label}: ${JSON.stringify(w.frames.map((f) => f.layers.join(" | ") + " anims " + f.stageAnimations.length))}` : `${w.label}: ${JSON.stringify({ ...w, label: undefined })}`))])),
      contrastFailing: Object.fromEntries(Object.entries(report.contrast).map(([k, v]) => [k, v.failing])),
      announcements: report.liveRegion?.length,
      zoom200: report.zoom200,
    },
    null,
    2,
  ),
);

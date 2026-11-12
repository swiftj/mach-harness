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
// 8. 200% zoom: 1920x1080 and 1280x800 windows at 200% (960x540 and 640x400 CSS px).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { app, ensureBuild, frames, log, openApp, ORIGIN, S, sim, sleep, startPreview } from "./lib.mjs";

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
    const dimmedCount = (page) => page.evaluate(() => [...document.querySelectorAll("[data-view=atlas] svg g")].filter((g) => Number(getComputedStyle(g).opacity) < 0.6).length);
    const reachBy = async (page, prefix) => {
      for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "ArrowRight"]) {
        for (let i = 0; i < 60; i++) {
          const f = await active(page);
          if (f.ref?.startsWith(prefix)) return f.ref;
          await page.keyboard.press(k);
        }
      }
      return null;
    };

    // Focus order from the top of the page, and the visibility of each stop.
    await fresh(async (page) => {
      const order = [];
      for (let i = 0; i < 45; i++) {
        await page.keyboard.press("Tab");
        order.push(await active(page));
      }
      report.focusOrder = order;
    });

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
      // Walk with arrows and collect every entity reached.
      const reached = new Set();
      for (const [k, n] of [
        ["ArrowRight", 80],
        ["ArrowDown", 50],
        ["ArrowLeft", 80],
        ["ArrowUp", 50],
        ["ArrowRight", 40],
        ["ArrowDown", 30],
      ]) {
        for (let i = 0; i < n; i++) {
          await page.keyboard.press(k);
          const f = await active(page);
          if (f.ref) reached.add(f.ref);
        }
      }
      const allRefs = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-view=atlas] [data-ref][role="button"]')].map((e) => e.getAttribute("data-ref")))]);
      report.atlasArrowReach = { reached: [...reached].sort(), total: allRefs.length, unreached: allRefs.filter((r) => !reached.has(r)).sort() };
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
      await page.locator("[data-view=atlas]").focus();
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
      await page.locator("[data-view=atlas]").focus();
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
      await page.locator("[data-view=atlas]").focus();
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
      await page.locator("[data-view=atlas]").focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await sleep(300);
      await page.screenshot({ path: join(out, "focus-atlas-entity.png") });
    });
  }
  log("keyboard:", report.keyboard.filter((s) => !s.ok).length, "steps failed");

  // ------------------------------------------------------------ 4. reduced motion, measured
  // Thirty frames of 1x playback (33 ms of wall time each) through five travelling moments, at a fixed
  // camera. A thing that travels moves in many consecutive frames; a thing re-laid out because
  // something appeared jumps once. Counted separately, with every running Web Animation by name.
  report.reducedMotion = {};
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const { context, page } = await openApp(browser, { reducedMotion });
    await sim(page, "setFollow", false);
    const windows = [];
    for (const [label, t] of [
      ["dispatch", 31],
      ["verification fails, return to build", 1639],
      ["rejection crosses the plant", 1928.3],
      ["merge travels to the trunk", 2562.6],
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
        for (const a of await page.evaluate(() =>
          document
            .getAnimations()
            .filter((x) => x.playState === "running")
            .map((x) => `${x.constructor.name}:${x.transitionProperty ?? x.animationName ?? "?"} on ${(x.effect?.target?.getAttribute?.("class") ?? x.effect?.target?.tagName ?? "?").toString().slice(0, 50)}`),
        ))
          anims.add(a);
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
    // The mode switch: a cut under reduced motion.
    await page.keyboard.press("2");
    await frames(page, 2);
    const fold = await page.evaluate(() => ({ viewsMounted: document.querySelectorAll("[data-stage-view]").length, animations: document.getAnimations().map((x) => `${x.constructor.name}:${x.transitionProperty ?? x.animationName ?? "keyframes"}`).slice(0, 8) }));
    await page.keyboard.press("1");
    windows.push({ label: "mode switch (2), two frames later", ...fold });
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
    const { context, page } = await openApp(browser, { theme: "dark", width, height, dpr: 2 });
    await sim(page, "seek", S(1660));
    await sim(page, "select", "gate:LOCAL-031/verification#1");
    await sleep(1200);
    const file = `zoom200-${width}x${height}.png`;
    await page.screenshot({ path: join(out, file) });
    const check = await page.evaluate(() => {
      const offscreen = [...document.querySelectorAll("header button, header input, header [role=radio], [data-transport], [role=toolbar] button")]
        .filter((e) => !e.closest("[inert]"))
        .map((e) => [e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 30), e.getBoundingClientRect()])
        .filter(([, r]) => r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.width === 0)
        .map(([n]) => n);
      return { horizontalScroll: document.documentElement.scrollWidth > innerWidth, verticalScroll: document.documentElement.scrollHeight > innerHeight, controlsOffscreenOrHidden: offscreen };
    });
    report.zoom200.push({ label, file, ...check });
    await context.close();
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
    for (const ent of document.querySelectorAll("[data-view=atlas] [data-ref]")) {
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
      atlasUnreached: report.atlasArrowReach?.unreached.length,
      reduced: Object.fromEntries(Object.entries(report.reducedMotion).map(([k, v]) => [k, v.map((w) => `${w.label}: ${w.elementsTravelling ?? ""} travelling, ${w.elementsJumpingOnce ?? ""} jumps, anims ${JSON.stringify(w.runningAnimations ?? w.animations)}`)])),
      contrastFailing: Object.fromEntries(Object.entries(report.contrast).map(([k, v]) => [k, v.failing])),
      announcements: report.liveRegion?.length,
      zoom200: report.zoom200,
    },
    null,
    2,
  ),
);

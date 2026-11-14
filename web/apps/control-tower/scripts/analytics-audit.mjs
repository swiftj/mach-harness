// Accessibility audit of the M6.5 Factory Analytics workspace (docs/mach-next/M6_5_TESTING.md).
//
//   node scripts/analytics-audit.mjs [--mode proof|shell|live] [--project tiny|medium|<dir>] [--out <dir>]
//
//   proof  (default) the areas' proof page on the simulated fixture (/src/analytics/dev/proof.html)
//   shell  the Shell's #analytics over the built-in Simulation
//   live   the Shell's #analytics over mach-observer (go build) on a generated project (default medium)
//
// Uses the dev server on 127.0.0.1:4430 (started, with the relay on 4439, when not answering) and, in
// live mode, an observer on 4434. Stops what it started. Writes only to --out (default
// <os tmpdir>/mach-analytics-audit): the JSON report, accessibility trees and screenshots.
//
// Checks (each pass, fail, or "not run: <why>"):
//  1. axe, WCAG 2.2 A/AA tags, on every area and state: both themes; the default, sparse and
//     no-lifecycle histories (proof); a model filter; every figure as a table; the Rows drawer open.
//  2. Keyboard walk: Tab order (filters > areas > sheet), visible focus at every stop, no trap; one Tab
//     stop per chart with arrow keys moving inside it; the Rows drawer keeps focus inside and gives it
//     back to the Rows button on Escape.
//  3. Target sizes: 24 px, or spaced (WCAG 2.5.8).
//  4. Contrast of chart marks (3:1) and chart text (4.5:1, 3:1 at 18.66 px bold / 24 px) against what
//     is under them, in both themes, from computed styles.
//  5. Colour independence: within each chart, marks of different colours also differ by a non-colour
//     cue (their names' words, shape, dash, pattern or a text label).
//  6. Reduced motion: nothing animates after an area switch, a window change, a hover and the drawer.
//  7. Every chart: an accessible name, a summary, and a data-table alternative.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import {
  AREAS,
  SEL,
  analyticsReady,
  apiSession,
  buildTools,
  chromium,
  ensureStack,
  gotoArea,
  log,
  makeProject,
  OBSERVER_PORTS,
  openProof,
  openShell,
  readFigures,
  runningAnimations,
  sleep,
  startObserver,
  stopOwn,
  waitCaughtUp,
} from "../e2e/analytics-lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MODE = opt("mode", "proof");
const out = opt("out", join(tmpdir(), "mach-analytics-audit"));
mkdirSync(out, { recursive: true });
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ROOT = "[data-analytics-workspace], .an-root";

const checks = [];
function record(id, name, status, details) {
  checks.push({ id, name, status, details });
  log(`${status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "----"} ${id} ${name}${status.startsWith("not run") ? ` (${status})` : ""}`);
}
async function guarded(id, name, fn) {
  try {
    await fn();
  } catch (error) {
    record(id, name, `not run: ${String(error?.message ?? error).split("\n")[0].slice(0, 220)}`, null);
  }
}

// ------------------------------------------------------------ opening a state

let observer = null;
async function setup() {
  await ensureStack({ tools: MODE === "live" });
  if (MODE !== "live") return;
  const p = opt("project", "medium");
  const dir = ["tiny", "medium", "one", "empty", "large"].includes(p) ? makeProject(p, { reuse: true, name: `audit-${p}` }).dir : p;
  observer = await startObserver(dir, OBSERVER_PORTS.audit);
  await waitCaughtUp(observer, await apiSession(observer));
}

/** One state: { area, theme, width, height, reducedMotion, extra } → { context, page }. */
async function openState(browser, { area = "pulse", theme = "dark", width = 1512, height = 982, reducedMotion = "no-preference", extra = {} } = {}) {
  const opts = { width, height, reducedMotion, colorScheme: theme };
  if (MODE === "proof") return openProof(browser, { area, window: "all", ...extra }, opts);
  const q = new URLSearchParams({ area, ...(extra.model ? { model: extra.model } : {}) });
  const { context, page } = await openShell(browser, MODE === "live" ? observer : null, `#analytics?${q}`, opts);
  if (MODE === "live" && /is not connected to this source yet/.test(await page.locator(ROOT).first().innerText())) {
    await context.close();
    throw new Error("the Shell mounts the placeholder for a live source: the live Analytics provider is not wired yet");
  }
  return { context, page };
}

const STATES = MODE === "proof" ? [{}, { mode: "sparse" }, { mode: "nolog" }, { model: "opus" }] : [{}, { model: "opus" }];

async function axe(page) {
  const r = await new AxeBuilder({ page }).include(ROOT).withTags(TAGS).analyze();
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")), summary: v.nodes[0]?.failureSummary?.split("\n").slice(0, 3).join(" ") }));
}

async function allTables(page, on) {
  const want = on ? "Table" : "Chart";
  const buttons = page.locator(`main[aria-label] figure button`, { hasText: new RegExp(`^${want}$`) });
  for (let i = (await buttons.count()) - 1; i >= 0; i--) await buttons.nth(i).click();
  await sleep(150);
}

// ------------------------------------------------------------ 1. axe

async function checkAxe(browser) {
  const states = [];
  for (const theme of ["dark", "light"]) {
    for (const extra of STATES) {
      for (const a of AREAS) {
        const { context, page } = await openState(browser, { area: a.id, theme, extra });
        states.push({ theme, area: a.id, extra, view: "charts", violations: await axe(page) });
        if (theme === "dark" && Object.keys(extra).length === 0) {
          await allTables(page, true);
          states.push({ theme, area: a.id, extra, view: "tables", violations: await axe(page) });
          await allTables(page, false);
          const rows = page.getByRole("button", { name: /^Rows$/ });
          if (await rows.count()) {
            await rows.first().click();
            await page.locator(SEL.rowsDrawer).waitFor({ timeout: 5000 }).catch(() => {});
            states.push({ theme, area: a.id, extra, view: "rows drawer", violations: await axe(page) });
          }
          if (a.id === "pulse") writeFileSync(join(out, `aria-${MODE}-pulse.txt`), await page.locator(ROOT).first().ariaSnapshot());
          await page.screenshot({ path: join(out, `axe-${MODE}-${a.id}-${theme}.png`) });
        }
        await context.close();
      }
    }
  }
  const total = states.reduce((n, s) => n + s.violations.length, 0);
  record("axe", `axe ${TAGS.join(", ")} (${states.length} states)`, total === 0 ? "pass" : "fail", states);
}

// ------------------------------------------------------------ 2. keyboard

const describeActive = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return { region: "body" };
  const r = el.getBoundingClientRect();
  const region = el.closest("aside[data-analytics-rows], aside[aria-label^='Rows']")
    ? "rows"
    : el.closest("[role=group][aria-label='Filters for every area'], [data-analytics-filters]")
      ? "filters"
      : el.closest("nav[aria-label='Analytics areas']")
        ? "areas"
        : el.closest("main[aria-label] figure")
          ? "chart"
          : el.closest("main[aria-label]")
            ? "sheet"
            : el.closest("[data-analytics-workspace], .an-root")
              ? "workspace"
              : el.closest("header, [role=banner]")
                ? "header"
                : el.closest("aside, [data-inspector]")
                  ? "inspector"
                  : "page";
  const fig = el.closest("figure");
  const plot = el.closest("svg, canvas, [data-chart-plot]");
  const ring = (e) => {
    if (!e) return null;
    const cs = getComputedStyle(e);
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) return `outline ${cs.outlineWidth}`;
    if (cs.boxShadow && cs.boxShadow !== "none") return "box-shadow";
    const ringRect = e.querySelector?.(":scope > .an-ring");
    if (ringRect && getComputedStyle(ringRect).opacity !== "0" && getComputedStyle(ringRect).visibility !== "hidden" && getComputedStyle(ringRect).strokeWidth !== "0px") return "ring rect";
    return null;
  };
  window.__figIds ??= new WeakMap();
  window.__figN ??= 0;
  if (fig && !window.__figIds.has(fig)) window.__figIds.set(fig, ++window.__figN);
  return {
    region,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    ring: ring(el) ?? (el.classList.contains("sr-only") || r.width <= 1 ? (ring(el.closest("label")) ?? ring(el.parentElement)) : null),
    figure: fig ? window.__figIds.get(fig) : null,
    inPlot: Boolean(plot && fig),
    again: (window.__seen ??= new WeakSet()).has(el) || (window.__seen.add(el), false),
  };
};

async function checkKeyboard(browser) {
  const details = {};
  for (const area of ["pulse", "flow", "quality"]) {
    const { context, page } = await openState(browser, { area });
    await page.evaluate(() => document.activeElement?.blur());
    const stops = [];
    let wrapped = false;
    for (let i = 0; i < 400; i++) {
      await page.keyboard.press("Tab");
      await sleep(25);
      const a = await page.evaluate(describeActive);
      if (a.region === "body" || a.again) {
        wrapped = true;
        break;
      }
      if (!a.ring && a.box[2] > 0) {
        const vp = page.viewportSize();
        const clip = { x: Math.max(0, a.box[0] - 4), y: Math.max(0, a.box[1] - 4), width: Math.max(1, Math.min(vp.width - Math.max(0, a.box[0] - 4), a.box[2] + 8)), height: Math.max(1, Math.min(vp.height - Math.max(0, a.box[1] - 4), a.box[3] + 8)) };
        const focused = await page.screenshot({ clip }).catch(() => null);
        const h = await page.evaluateHandle(() => document.activeElement);
        await page.evaluate((e) => e.blur(), h);
        const plain = await page.screenshot({ clip }).catch(() => null);
        await page.evaluate((e) => e.focus({ preventScroll: true }), h);
        a.ring = focused && plain && !focused.equals(plain) ? "pixels change on focus" : null;
      }
      stops.push(a);
    }
    const order = [];
    for (const s of stops) if (order[order.length - 1] !== s.region) order.push(s.region);
    const want = ["filters", "areas"];
    const first = (r) => stops.findIndex((s) => s.region === r);
    const sheetFirst = Math.min(...["sheet", "chart"].map(first).filter((i) => i >= 0));
    const inOrder = first("filters") >= 0 && first("areas") > first("filters") && sheetFirst > first("areas");
    // One Tab stop per chart's plot (the Table and Definition buttons are their own controls).
    const plotStops = {};
    for (const s of stops) if (s.inPlot) plotStops[s.figure] = (plotStops[s.figure] ?? 0) + 1;
    const manyStops = Object.entries(plotStops).filter(([, n]) => n > 1).map(([f, n]) => `figure #${f}: ${n} Tab stops in its plot`);
    // Arrow keys inside a chart: from its plot's stop, ArrowRight/ArrowDown move focus within the same chart.
    const arrows = [];
    const plotStop = stops.find((s) => s.inPlot);
    if (plotStop) {
      await page.evaluate(() => document.activeElement?.blur());
      for (let i = 0; i < 400; i++) {
        await page.keyboard.press("Tab");
        const a = await page.evaluate(describeActive);
        if (a.inPlot) break;
      }
      const at0 = await page.evaluate(describeActive);
      for (const key of ["ArrowRight", "ArrowDown"]) {
        await page.keyboard.press(key);
        await sleep(60);
        const at1 = await page.evaluate(describeActive);
        arrows.push({ key, from: at0.name, to: at1.name, moved: at1.name !== at0.name || at1.box.join() !== at0.box.join(), sameChart: at1.figure === at0.figure });
      }
    }
    const arrowsOk = !plotStop || arrows.some((a) => a.moved && a.sameChart);
    details[area] = {
      stops: stops.length,
      wrapped,
      regionOrder: order,
      inOrder,
      expectedFirst: want,
      withoutVisibleFocus: stops.filter((s) => !s.ring).map((s) => `${s.region} ${s.tag}${s.role ? `[${s.role}]` : ""} "${s.name}"`),
      plotStops,
      manyStops,
      arrows: plotStop ? arrows : "not run: no chart plot takes focus in this area",
      ok: wrapped && inOrder && stops.every((s) => s.ring) && manyStops.length === 0 && arrowsOk,
    };
    await context.close();
  }
  // The Rows drawer: focus moves in, Tab stays in, Escape returns focus to the Rows button.
  let drawer = "not run: no Rows button on Flow";
  {
    const { context, page } = await openState(browser, { area: "flow" });
    const rows = page.getByRole("button", { name: /^Rows$/ });
    if (await rows.count()) {
      await rows.first().focus();
      await page.keyboard.press("Enter");
      await page.locator(SEL.rowsDrawer).waitFor({ timeout: 5000 });
      const inside = [];
      inside.push((await page.evaluate(describeActive)).region);
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        inside.push((await page.evaluate(describeActive)).region);
      }
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Shift+Tab");
        inside.push((await page.evaluate(describeActive)).region);
      }
      await page.keyboard.press("Escape");
      await sleep(200);
      const back = await page.evaluate(() => {
        const el = document.activeElement;
        return el === document.body ? "body" : `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
      });
      const escaped = inside.filter((r) => r !== "rows");
      drawer = { focusOnOpen: inside[0], leftTheDrawer: escaped.length, regionsReached: [...new Set(inside)], focusAfterEscape: back, ok: inside[0] === "rows" && escaped.length === 0 && /"Rows"$/.test(back) };
    }
    await context.close();
  }
  const ok = Object.values(details).every((d) => d.ok) && (typeof drawer === "string" || drawer.ok);
  record("keyboard", "Tab order, visible focus, one stop per chart with arrows inside, the drawer keeps and returns focus", ok ? "pass" : "fail", { areas: details, drawer });
}

// ------------------------------------------------------------ 3. targets

const measureTargets = (sel) => {
  const root = document.querySelector(sel);
  const q = "button, a[href], input, select, textarea, summary, [role=button], [role=slider], [role=radio], [role=checkbox], [role=tab], [tabindex='0']";
  const items = [];
  for (const el of root.querySelectorAll(q)) {
    if (el.closest("[inert]") || el.disabled) continue;
    let box = el.getBoundingClientRect();
    if ((box.width <= 1 || box.height <= 1) && el.closest("label")) box = el.closest("label").getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    // An inline link in a sentence is exempt (WCAG 2.5.8 "inline").
    const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement && /\S/.test(el.parentElement.textContent.replace(el.textContent, ""));
    const fig = el.closest("main[aria-label] figure");
    const figs = [...document.querySelectorAll("main[aria-label] figure")];
    // A figure is named by its data-chart id (stable while a live page renders more sections); its position only when it has none.
    // A declared equivalent control (WCAG 2.5.8 "equivalent"): the element or its figure names it.
    const equivalent = el.getAttribute("data-target-equivalent") ?? fig?.getAttribute("data-target-equivalent") ?? null;
    items.push({ el, inline, fig: fig ? (fig.getAttribute("data-chart") ?? `#${figs.indexOf(fig)}`) : null, equivalent, sel: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}`, name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40), box: { x: box.left, y: box.top, w: box.width, h: box.height } });
  }
  const small = [];
  for (const t of items) {
    if (t.box.w >= 24 && t.box.h >= 24) continue;
    if (t.inline) continue;
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    const clash = items.find((o) => o !== t && !o.el.contains(t.el) && !t.el.contains(o.el) && o.box.x < cx + 12 && o.box.x + o.box.w > cx - 12 && o.box.y < cy + 12 && o.box.y + o.box.h > cy - 12);
    small.push({ fig: t.fig, equivalent: t.equivalent, sel: t.sel, name: t.name, size: `${Math.round(t.box.w)}x${Math.round(t.box.h)}`, spaced: !clash, near: clash ? `${clash.sel} "${clash.name}"` : null });
  }
  return { targets: items.length, undersized: small };
};

async function checkTargets(browser) {
  const per = [];
  for (const a of AREAS) {
    const { context, page } = await openState(browser, { area: a.id });
    await analyticsReady(page);
    const r = await page.evaluate(measureTargets, ROOT);
    // WCAG 2.5.8's equivalent exception: a crowded mark whose chart's table view offers the same
    // entities as links or buttons (checked by opening it), or a declared data-target-equivalent.
    const figs = [...new Set(r.undersized.filter((u) => !u.spaced && !u.equivalent && u.fig !== null).map((u) => u.fig))];
    for (const i of figs) {
      const f = i.startsWith("#") ? page.locator("main[aria-label] figure").nth(Number(i.slice(1))) : page.locator(`main[aria-label] figure[data-chart="${i}"]`).first();
      const toggle = f.getByRole("button", { name: /^Table$/ });
      if (!(await toggle.count())) continue;
      await toggle.first().click();
      await sleep(120);
      const controls = await f.locator("table button, table a[href]").count();
      const back = f.getByRole("button", { name: /^Chart$/ });
      if (await back.count()) await back.first().click();
      if (controls > 0) for (const u of r.undersized) if (u.fig === i && !u.equivalent) u.equivalent = `the table view (${controls} controls)`;
    }
    per.push({ area: a.id, ...r });
    await context.close();
  }
  const crowded = per.flatMap((r) => r.undersized.filter((u) => !u.spaced).map((u) => ({ area: r.area, ...u })));
  const failing = crowded.filter((u) => !u.equivalent);
  const equivalent = crowded.filter((u) => u.equivalent);
  record("targets", "Targets at least 24 px, spaced, or with an equivalent control (WCAG 2.5.8)", failing.length === 0 ? "pass" : "fail", {
    failing,
    equivalent: { count: equivalent.length, by: [...new Set(equivalent.map((u) => `${u.area}: ${u.equivalent}`))] },
    spacedButSmall: per.flatMap((r) => r.undersized.filter((u) => u.spaced)).length,
    counted: per.map((r) => `${r.area}: ${r.targets}`),
  });
}

// ------------------------------------------------------------ 4. contrast of chart marks and text

const chartContrast = () => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const g = cv.getContext("2d", { willReadFrequently: true });
  const rgb = (value, under) => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = under ?? "#fff";
    g.fillRect(0, 0, 1, 1);
    g.fillStyle = "#000";
    g.fillStyle = value;
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${gg}, ${b})`;
  };
  const lum = (s) =>
    s
      .match(/\d+/g)
      .slice(0, 3)
      .map(Number)
      .map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
      .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };
  const groundOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") stack.push(bg);
      if (stack.length && !/rgba\(.*, 0?\.\d+\)$/.test(stack[stack.length - 1])) break;
    }
    let c = "#fff";
    for (const bg of stack.reverse()) c = rgb(bg, c);
    return c;
  };
  const rows = [];
  const main = [...document.querySelectorAll("main[aria-label]")].pop();
  for (const fig of main?.querySelectorAll("figure") ?? []) {
    const name = fig.querySelector("h1,h2,h3,h4")?.textContent?.trim() ?? "?";
    const ground = groundOf(fig);
    const seen = new Set();
    // Meaningful marks: shapes under a named mark (role=img or button) or with a data-status; not hit areas or rings.
    for (const el of fig.querySelectorAll("[role=img] rect, [role=img] path, [role=img] circle, [role=button] rect, [role=button] path, [role=button] circle, [data-status], svg [data-mark]")) {
      if (el.matches(".an-hit, .an-ring")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      // WCAG 1.4.11: a shape is perceivable when its fill or its outline contrasts with what is under it.
      const paints = [];
      if (cs.fill && cs.fill !== "none" && !cs.fill.startsWith("url") && Number(cs.fillOpacity) > 0) paints.push(cs.fill);
      if (cs.stroke && cs.stroke !== "none" && !cs.stroke.startsWith("url") && parseFloat(cs.strokeWidth) > 0 && Number(cs.strokeOpacity) > 0) paints.push(cs.stroke);
      if (!paints.length) continue;
      const key = paints.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const best = Math.max(...paints.map((p) => ratio(rgb(p, ground), ground)));
      rows.push({ chart: name, kind: "mark", color: key, ground, ratio: best, need: 3 });
    }
    for (const t of fig.querySelectorAll("svg text")) {
      const cs = getComputedStyle(t);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      const key = `${cs.fill}|${cs.fontSize}|${cs.fontWeight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const px = parseFloat(cs.fontSize);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      rows.push({ chart: name, kind: "text", color: cs.fill, size: cs.fontSize, ground, ratio: ratio(rgb(cs.fill, ground), ground), need: large ? 3 : 4.5 });
    }
  }
  return rows;
};

async function checkContrast(browser) {
  const all = [];
  for (const theme of ["dark", "light"])
    for (const a of AREAS) {
      const { context, page } = await openState(browser, { area: a.id, theme });
      for (const r of await page.evaluate(chartContrast)) all.push({ theme, area: a.id, ...r });
      await context.close();
    }
  const failing = all.filter((r) => r.ratio < r.need);
  record("contrast", `Chart marks 3:1, chart text 4.5:1 against their ground, both themes (${all.length} pairs)`, all.length === 0 ? "not run: no chart marks or text found" : failing.length === 0 ? "pass" : "fail", { failing, counted: all.length });
}

// ------------------------------------------------------------ 5. colour independence

const colourCues = () => {
  const out = [];
  const main = [...document.querySelectorAll("main[aria-label]")].pop();
  for (const fig of main?.querySelectorAll("figure") ?? []) {
    const name = fig.querySelector("h1,h2,h3,h4")?.textContent?.trim() ?? "?";
    const marks = [...fig.querySelectorAll("svg [role=img], svg [role=button], svg [data-status]")];
    const groups = new Map();
    for (const m of marks) {
      const shape = m.matches("rect, path, circle, line, polygon") ? m : m.querySelector("rect:not(.an-hit):not(.an-ring), path, circle, polygon, line");
      if (!shape) continue;
      const cs = getComputedStyle(shape);
      const colour = cs.fill !== "none" && !cs.fill.startsWith("url") ? cs.fill : cs.stroke;
      const cue = [shape.tagName, cs.strokeDasharray !== "none" ? `dash ${cs.strokeDasharray}` : "", cs.fill.startsWith("url") ? "pattern" : "", m.getAttribute("data-status") ?? ""].join("|");
      const words = (m.getAttribute("aria-label") ?? "").toLowerCase().replace(/[\d.,:%$]+/g, " ").replace(/\b(\w{1,3}|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep)\b/g, " ").replace(/\s+/g, " ").trim();
      if (!groups.has(colour)) groups.set(colour, { cues: new Set(), words: new Set(), n: 0 });
      const gr = groups.get(colour);
      gr.cues.add(cue);
      gr.words.add(words);
      gr.n++;
    }
    const cols = [...groups.entries()];
    if (cols.length < 2) continue;
    const legendText = [...fig.querySelectorAll("figcaption, [data-legend], li, span")].map((e) => e.textContent.trim()).filter(Boolean).length;
    for (let i = 0; i < cols.length; i++)
      for (let j = i + 1; j < cols.length; j++) {
        const [ca, a] = cols[i];
        const [cb, b] = cols[j];
        const shapeDiffers = [...a.cues].some((x) => !b.cues.has(x));
        const wordsDiffer = [...a.words].some((x) => !b.words.has(x));
        if (!shapeDiffers && !wordsDiffer) out.push({ chart: name, colours: [ca, cb], marks: [a.n, b.n], note: "the same shape, dash and name words: told apart by colour only", legendItems: legendText });
      }
  }
  return out;
};

async function checkColour(browser) {
  const offenders = [];
  let charts = 0;
  for (const a of AREAS) {
    const { context, page } = await openState(browser, { area: a.id });
    charts += (await readFigures(page)).length;
    for (const o of await page.evaluate(colourCues)) offenders.push({ area: a.id, ...o });
    await context.close();
  }
  record("colour", `Every status distinguishable without colour (${charts} charts)`, offenders.length === 0 ? "pass" : "fail", { offenders });
}

// ------------------------------------------------------------ 6. reduced motion

async function checkMotion(browser) {
  const { context, page } = await openState(browser, { area: "pulse", reducedMotion: "reduce" });
  const steps = [];
  const after = async (step) => {
    await sleep(30);
    const a1 = await runningAnimations(page, ROOT);
    await sleep(300);
    const a2 = await runningAnimations(page, ROOT);
    steps.push({ step, justAfter: a1, later: a2 });
  };
  await gotoArea(page, "flow");
  await after("area switch to Flow");
  await page.getByRole("radio", { name: "7 days" }).click();
  await analyticsReady(page);
  await after("window 7 days");
  const mark = page.locator("main[aria-label] figure svg [role=button], main[aria-label] figure svg [role=img]").first();
  if (await mark.count()) {
    await mark.hover({ force: true });
    await after("hover a mark");
  } else steps.push({ step: "hover a mark", note: "not run: no named mark" });
  const rows = page.getByRole("button", { name: /^Rows$/ });
  if (await rows.count()) {
    await rows.first().click();
    await after("Rows drawer opened");
  }
  await context.close();
  const bad = steps.filter((s) => s.later?.length || s.justAfter?.length);
  record("reduced-motion", "prefers-reduced-motion: nothing animates", bad.length === 0 ? "pass" : "fail", steps);
}

// ------------------------------------------------------------ 7. charts: name, summary, table

async function checkCharts(browser) {
  const per = [];
  for (const extra of STATES)
    for (const a of AREAS) {
      const { context, page } = await openState(browser, { area: a.id, extra });
      for (const f of await readFigures(page)) per.push({ area: a.id, extra, ...f });
      await context.close();
    }
  const drawn = per.filter((f) => !f.missing);
  const failing = drawn.filter((f) => !f.name || !f.summary || (f.drawn && !f.table)).map((f) => ({ area: f.area, extra: f.extra, chart: f.name || f.text.slice(0, 50), name: Boolean(f.name), summary: Boolean(f.summary), table: f.table }));
  record("charts", `Each chart has a name, a summary and a table (${drawn.length} drawn, ${per.length - drawn.length} shown as unavailable)`, failing.length === 0 ? "pass" : "fail", { failing });
}

// ------------------------------------------------------------ run

if (MODE === "live" && argv.includes("--build")) buildTools();
let browser;
try {
  await setup();
  browser = await chromium.launch();
  await guarded("axe", "axe", () => checkAxe(browser));
  await guarded("keyboard", "keyboard walk", () => checkKeyboard(browser));
  await guarded("targets", "target sizes", () => checkTargets(browser));
  await guarded("contrast", "chart contrast", () => checkContrast(browser));
  await guarded("colour", "colour independence", () => checkColour(browser));
  await guarded("reduced-motion", "reduced motion", () => checkMotion(browser));
  await guarded("charts", "chart names, summaries, tables", () => checkCharts(browser));
} catch (error) {
  record("setup", "setup", `not run: ${String(error?.message ?? error).split("\n")[0]}`, null);
} finally {
  await browser?.close();
  await observer?.stop();
  stopOwn();
}

writeFileSync(join(out, `analytics-audit-${MODE}.json`), JSON.stringify({ generated: new Date().toISOString(), mode: MODE, checks }, null, 2));

function brief(c) {
  const d = c.details;
  if (!d) return "";
  switch (c.id) {
    case "axe": {
      const ids = [...new Set(d.flatMap((s) => s.violations.map((x) => `${x.id}(${x.impact})`)))];
      const n = d.reduce((k, s) => k + s.violations.length, 0);
      return n ? `${n} violations in ${d.length} states: ${ids.join(", ")}` : `0 violations in ${d.length} states`;
    }
    case "keyboard":
      return `${Object.entries(d.areas)
        .map(([a, x]) => `${a}: ${x.stops} stops, order ${x.regionOrder.slice(0, 6).join(">")}, ${x.withoutVisibleFocus.length} without focus ring, ${x.manyStops.length} charts with several stops`)
        .join("; ")}; drawer ${typeof d.drawer === "string" ? d.drawer : `in ${d.drawer.focusOnOpen}, left ${d.drawer.leftTheDrawer}x, back to "${d.drawer.focusAfterEscape}"`}`;
    case "targets":
      return `${d.failing.length} undersized and crowded; ${d.equivalent.count} with an equivalent control; ${d.spacedButSmall} small but spaced`;
    case "contrast":
      return `${d.failing.length} of ${d.counted} pairs under their minimum`;
    case "colour":
      return `${d.offenders.length} colour-only distinctions`;
    case "reduced-motion":
      return d.map((s) => `${s.step}: ${s.note ?? `${s.later.length} running`}`).join("; ");
    case "charts":
      return `${d.failing.length} charts missing a name, summary or table`;
    default:
      return "";
  }
}
console.log(`\nAnalytics audit, mode ${MODE}\n\n| Check | Result | Details |\n|---|---|---|`);
for (const c of checks) console.log(`| ${c.id} | ${c.status} | ${brief(c).replace(/\|/g, "/")} |`);
console.log(`\nReport: ${join(out, `analytics-audit-${MODE}.json`)}`);

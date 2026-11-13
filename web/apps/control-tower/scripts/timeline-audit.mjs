// Accessibility audit of the M6.3 Timeline workspace, against the Vite dev server with the simulation.
//
//   node scripts/timeline-audit.mjs [--port 4206] [--out <dir>]
//
// It uses the dev server already answering on the port, or starts one (`vite --port <port> --strictPort`)
// and stops it afterwards. It never builds and never writes into the repository: the report, the
// accessibility trees and the screenshots go to --out (default: <os tmpdir>/mach-timeline-audit).
//
// Checks (each reports pass, fail or "not run: <why>", with details):
//  1. axe (WCAG 2.2 A/AA tags) on the workspace: dark and light; 1512x982, 1280x800 and 200% zoom (756x491
//     CSS px at DPR 2); both groupings; the table off and on; a lens open when lenses exist.
//  2. Keyboard walkthrough: Tab order from the header through the transport, toolbar, overview sliders,
//     tracks and inspector; no trap (Tab comes back round, Shift+Tab goes back); visible focus at every stop.
//  3. Target sizes: every interactive element in the workspace at least 24 px, or spaced (WCAG 2.5.8).
//  4. Contrast of the timeline's drawn marks and text against the ground, from the tokens as rendered.
//  5. Reduced motion: no running animation or transition, and a still canvas, after a zoom, a brush drag
//     and a workspace switch.
//  6. Shortcut collisions: the global map and the Timeline's keys, read from the code, and the grid's and
//     the canvas's own keys measured in the browser (Home and End must not also move the playhead).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { app, log, sleep } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(opt("port", process.env.TL_AUDIT_PORT ?? 4206));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const out = opt("out", process.env.TL_AUDIT_OUT ?? join(tmpdir(), "mach-timeline-audit"));
mkdirSync(out, { recursive: true });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const WORKSPACE = "[data-timeline-workspace]";
const SIZES = [
  { label: "1512x982", width: 1512, height: 982, dpr: 1 },
  { label: "1280x800", width: 1280, height: 800, dpr: 1 },
  { label: "200% (756x491 @2x)", width: 756, height: 491, dpr: 2 },
];

const checks = [];
function record(id, name, status, details) {
  checks.push({ id, name, status, details });
  log(`${status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "----"} ${id} ${name}${status.startsWith("not run") ? ` (${status})` : ""}`);
}
async function guarded(id, name, fn) {
  try {
    await fn();
  } catch (error) {
    record(id, name, `not run: ${String(error?.message ?? error).split("\n")[0].slice(0, 200)}`, null);
  }
}

// ------------------------------------------------------------ the dev server

async function answers() {
  try {
    const r = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function devServer() {
  if (await answers()) {
    log("using the dev server on", ORIGIN);
    return { stop: async () => {} };
  }
  log("starting the dev server on", ORIGIN);
  const child = spawn(join(app, "node_modules", ".bin", "vite"), ["--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: app, stdio: "ignore" });
  for (let i = 0; i < 60 && !(await answers()); i++) await sleep(250);
  if (!(await answers())) throw new Error(`the dev server did not answer on ${ORIGIN}`);
  return {
    stop: async () => {
      child.kill("SIGTERM");
      await sleep(200);
    },
  };
}

// ------------------------------------------------------------ the page

async function openTimeline(browser, { theme = "dark", width = 1512, height = 982, dpr = 1, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/?simulation&theme=${theme}#timeline`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__machSim), undefined, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const s = window.__machSim;
    s.pause();
    s.useManualClock();
    s.seek(Math.round(s.duration * 0.7));
  });
  await page.waitForSelector(WORKSPACE, { timeout: 15000 });
  await page.waitForSelector(`${WORKSPACE} [role=application], ${WORKSPACE} [role=treegrid]`, { timeout: 15000 }).catch(() => {});
  await sleep(900);
  return { context, page, errors };
}

const tableButton = (page) => page.locator(`${WORKSPACE} [role=toolbar] button`, { hasText: "Table" }).or(page.getByRole("button", { name: "Show the window as a table" })).first();

async function setTable(page, on) {
  const b = tableButton(page);
  if (!(await b.count())) throw new Error("no Table button in the toolbar");
  const pressed = (await b.getAttribute("aria-pressed")) === "true";
  if (pressed !== on) await b.click();
  await sleep(500);
  if (on) await page.waitForSelector(`${WORKSPACE} [role=treegrid]`, { timeout: 8000 });
}

async function setGrouping(page, grouping) {
  const radio = page.locator(`${WORKSPACE} input[type=radio][value=${grouping}]`);
  if (!(await radio.count())) throw new Error("no grouping radio");
  if (!(await radio.isChecked())) await radio.check({ force: true });
  await sleep(500);
}

/** Open the first lens, if the Investigate menu offers any. Returns its label, or null. */
async function openLens(page) {
  const trigger = page.locator(`${WORKSPACE} [data-timeline-investigate]`);
  if (!(await trigger.count())) return null;
  await trigger.click();
  await sleep(300);
  const choice = page.locator("[aria-label=Investigate] button[aria-pressed]").first();
  if (!(await choice.count())) {
    await page.keyboard.press("Escape");
    return null;
  }
  const label = (await choice.innerText()).split("\n")[0];
  await choice.click();
  await sleep(700);
  return label;
}

async function axe(page) {
  const result = await new AxeBuilder({ page }).include(WORKSPACE).withTags(TAGS).analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")), summary: v.nodes[0]?.failureSummary?.split("\n").slice(0, 3).join(" ") }));
}

// ------------------------------------------------------------ 1. axe

async function checkAxe(browser) {
  const states = [];
  for (const theme of ["dark", "light"]) {
    for (const size of SIZES) {
      const { context, page, errors } = await openTimeline(browser, { theme, ...size });
      for (const grouping of ["product", "execution"]) {
        await setGrouping(page, grouping);
        for (const table of [false, true]) {
          await setTable(page, table);
          states.push({ theme, size: size.label, grouping, table, violations: await axe(page) });
        }
        await setTable(page, false);
      }
      if (size.label === "1512x982") {
        await setGrouping(page, "product");
        const lens = await openLens(page);
        if (lens) states.push({ theme, size: size.label, grouping: "product", table: false, lens, violations: await axe(page) });
        else states.push({ theme, size: size.label, lens: "not run: no lens offered by the Investigate menu", violations: [] });
        if (theme === "dark") writeFileSync(join(out, "aria-workspace-dark.txt"), await page.locator(WORKSPACE).ariaSnapshot());
      }
      await page.screenshot({ path: join(out, `axe-${theme}-${size.width}x${size.height}.png`) });
      if (errors.length) states.push({ theme, size: size.label, pageErrors: errors.slice(0, 5), violations: [] });
      await context.close();
    }
  }
  const total = states.reduce((n, s) => n + s.violations.length, 0);
  record("axe", `axe ${TAGS.join(", ")} on the workspace (${states.length} states)`, total === 0 ? "pass" : "fail", states);
}

// ------------------------------------------------------------ 2. keyboard walkthrough

const describeActive = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return { region: "body" };
  const r = el.getBoundingClientRect();
  const region = el.closest("header")
    ? "header"
    : el.closest("aside")
      ? "inspector"
      : el.closest("[aria-label=Transport]")
        ? "transport"
        : el.closest("[role=toolbar]")
        ? "toolbar"
        : el.closest("section[aria-label='Whole history']")
          ? "overview"
          : el.closest("section[aria-label='Tracks']")
            ? "tracks"
            : el.closest("section[aria-label='Timeline as a table']")
              ? "table"
              : el.closest("[aria-label=Transport]")
                ? "transport"
                : el.closest("[data-timeline-workspace]")
                  ? "workspace"
                  : "page";
  const visible = (e) => {
    if (!e) return null;
    const cs = getComputedStyle(e);
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) return `outline ${cs.outlineWidth} ${cs.outlineStyle}`;
    if (cs.boxShadow && cs.boxShadow !== "none") return "box-shadow";
    return null;
  };
  // The ring may be drawn by the element, or (for a visually hidden input) by its label or parent.
  const ring = visible(el) ?? (el.classList.contains("sr-only") || r.width <= 1 ? (visible(el.closest("label")) ?? visible(el.parentElement)) : null);
  return {
    region,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    ring,
    focusVisible: el.matches(":focus-visible"),
    // Identity, not position: a stop met again means Tab came back round.
    again: (window.__auditSeen ??= new WeakSet()).has(el) || (window.__auditSeen.add(el), false),
  };
};

async function checkKeyboard(browser) {
  const { context, page } = await openTimeline(browser, { theme: "dark" });
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.click(2, 2);
  await page.evaluate(() => document.activeElement?.blur());
  const stops = [];
  let wrapped = false;
  for (let i = 0; i < 600; i++) {
    await page.keyboard.press("Tab");
    await sleep(40);
    const a = await page.evaluate(describeActive);
    if (a.region === "body") {
      wrapped = true;
      break;
    }
    if (a.again) {
      wrapped = true;
      break;
    }
    // No ring found in styles: compare the pixels around it with and without focus.
    if (!a.ring && a.box[2] > 0) {
      const clip = { x: Math.max(0, a.box[0] - 4), y: Math.max(0, a.box[1] - 4), width: Math.min(1512 - Math.max(0, a.box[0] - 4), a.box[2] + 8), height: Math.min(982 - Math.max(0, a.box[1] - 4), a.box[3] + 8) };
      if (clip.width > 0 && clip.height > 0) {
        const focused = await page.screenshot({ clip }).catch(() => null);
        const handle = await page.evaluateHandle(() => document.activeElement);
        await page.evaluate((e) => e.blur(), handle);
        const plain = await page.screenshot({ clip }).catch(() => null);
        await page.evaluate((e) => e.focus({ preventScroll: true }), handle);
        a.ring = focused && plain && !focused.equals(plain) ? "pixels change on focus" : null;
      }
    }
    stops.push(a);
  }
  // Order of first appearance by region.
  const order = [];
  for (const s of stops) if (order[order.length - 1] !== s.region) order.push(s.region);
  const expected = ["header", "transport", "toolbar", "overview", "tracks", "inspector"];
  const firstAt = Object.fromEntries(expected.map((r) => [r, stops.findIndex((s) => s.region === r)]));
  const present = expected.filter((r) => firstAt[r] >= 0);
  const inOrder = present.every((r, i) => i === 0 || firstAt[r] > firstAt[present[i - 1]]);
  const missing = expected.filter((r) => firstAt[r] < 0);
  const noRing = stops.filter((s) => !s.ring);
  // Shift+Tab and Tab from the tracks canvas leave it (no trap).
  let backOk = null;
  const tracks = page.locator(`${WORKSPACE} [role=application]`).first();
  if (await tracks.count()) {
    const leaves = async (key) => {
      await tracks.focus();
      await page.keyboard.press(key);
      return page.evaluate(() => {
        const el = document.activeElement;
        return { left: el?.getAttribute("role") !== "application", to: `${el?.tagName.toLowerCase()} "${(el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim().slice(0, 40)}"` };
      });
    };
    const back = await leaves("Shift+Tab");
    const fwd = await leaves("Tab");
    backOk = { back: back.to, forward: fwd.to, ok: back.left && fwd.left };
  }
  // Tab stops inside the tracks section (the design asks for one: the canvas).
  const trackStops = stops.filter((s) => s.region === "tracks").length;
  // The table's grid is one tab stop.
  await setTable(page, true);
  const row = page.locator(`${WORKSPACE} [role=treegrid] [role=row][tabindex='0']`);
  let tableStops = null;
  if (await row.count()) {
    await row.first().focus();
    await page.keyboard.press("Tab");
    const after = await page.evaluate(describeActive);
    await row.first().focus();
    await page.keyboard.press("Shift+Tab");
    const before = await page.evaluate(describeActive);
    tableStops = { afterTab: after.region, afterShiftTab: before.region, ok: after.region !== "table" && before.region !== "table" };
    await row.first().focus();
    await page.keyboard.press("ArrowDown");
    const ringed = await page.evaluate(describeActive);
    tableStops.rowRing = ringed.ring;
    const b = ringed.box;
    await page.screenshot({ path: join(out, "focus-table-row.png"), clip: { x: 0, y: Math.max(0, b[1] - 40), width: 1512, height: 120 } }).catch(() => {});
  }
  await context.close();
  // The tracks are one tab stop (the canvas, design section 9), plus the label column's resize separator.
  const ok = wrapped && inOrder && trackStops <= 2 && noRing.length === 0 && (backOk?.ok ?? true) && (tableStops?.ok ?? true) && Boolean(tableStops?.rowRing ?? true);
  record("keyboard", "Tab order, no trap, visible focus at every stop", ok ? "pass" : "fail", {
    stops: stops.length,
    wrapped,
    regionOrder: order,
    tabStopsInTracks: trackStops,
    inOrder,
    missingRegions: missing,
    withoutVisibleFocus: noRing.map((s) => `${s.region} ${s.tag}${s.role ? `[role=${s.role}]` : ""} "${s.name}" at ${s.box.join(",")}`),
    shiftTabFromTracks: backOk,
    table: tableStops,
    sequence: stops.map((s) => `${s.region}: ${s.tag}${s.role ? `[${s.role}]` : ""} "${s.name}" ${s.ring ?? "NO RING"}`),
  });
}

// ------------------------------------------------------------ 3. target sizes

const measureTargets = (sel) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const q = "button, a[href], input, select, textarea, summary, [role=button], [role=slider], [role=radio], [role=checkbox], [role=tab], [role=menuitem], [role=row][tabindex], [role=separator][tabindex], [tabindex='0']";
  const items = [];
  for (const el of root.querySelectorAll(q)) {
    if (el.closest("[inert]") || el.disabled) continue;
    let box = el.getBoundingClientRect();
    // A visually hidden input's target is its label.
    if ((box.width <= 1 || box.height <= 1) && el.closest("label")) box = el.closest("label").getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
    items.push({ el, sel: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${cls ? `.${cls}` : ""}`, name, box: { x: box.left, y: box.top, w: box.width, h: box.height } });
  }
  const small = [];
  for (const t of items) {
    if (t.box.w >= 24 && t.box.h >= 24) continue;
    // The spacing exception: a 24 px square centred on the target touches no other target.
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    const sq = { x: cx - 12, y: cy - 12, w: 24, h: 24 };
    const clash = items.find((o) => o !== t && !o.el.contains(t.el) && !t.el.contains(o.el) && o.box.x < sq.x + sq.w && o.box.x + o.box.w > sq.x && o.box.y < sq.y + sq.h && o.box.y + o.box.h > sq.y);
    small.push({ sel: t.sel, name: t.name, size: `${Math.round(t.box.w)}x${Math.round(t.box.h)}`, at: `${Math.round(t.box.x)},${Math.round(t.box.y)}`, spaced: !clash, near: clash ? `${clash.sel} "${clash.name}"` : null });
  }
  return { targets: items.length, undersized: small };
};

async function checkTargets(browser) {
  const results = [];
  for (const table of [false, true]) {
    const { context, page } = await openTimeline(browser, { theme: "dark" });
    if (table) await setTable(page, true);
    const r = await page.evaluate(measureTargets, WORKSPACE);
    results.push({ table, ...r });
    await context.close();
  }
  const failing = results.flatMap((r) => r.undersized.filter((u) => !u.spaced).map((u) => ({ table: r.table, ...u })));
  record("targets", "Interactive targets at least 24 px (or spaced, WCAG 2.5.8)", failing.length === 0 ? "pass" : "fail", { failing, spacedButSmall: results.flatMap((r) => r.undersized.filter((u) => u.spaced).map((u) => ({ table: r.table, ...u }))), counted: results.map((r) => ({ table: r.table, targets: r.targets })) });
}

// ------------------------------------------------------------ 4. contrast

const contrastOf = (sel) => {
  const el = document.querySelector(sel) ?? document.documentElement;
  const cs = getComputedStyle(el);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const v = (name) => cs.getPropertyValue(name).trim();
  // A colour as drawn over `under` (so tints with alpha are composited as the canvas composites them).
  const rgb = (value, under) => {
    if (!value) return null;
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = under ?? "#000";
    g.fillRect(0, 0, 1, 1);
    g.fillStyle = "#000";
    g.fillStyle = value;
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${gg}, ${b})`;
  };
  const parts = (s) => s.match(/\d+/g).map(Number);
  const lum = (s) => parts(s).map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))).reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };
  const ground = rgb(v("--mach-factory-ground"), "#fff");
  const rows = [];
  const pair = (fgName, bgName, need, what) => {
    const bg = bgName === "--mach-factory-ground" ? ground : rgb(v(bgName), ground);
    const fg = rgb(v(fgName), bg);
    if (!fg || !bg) {
      rows.push({ fg: fgName, bg: bgName, need, what, ratio: null, note: "token not defined" });
      return;
    }
    rows.push({ fg: fgName, bg: bgName, need, what, ratio: ratio(fg, bg) });
  };
  // Meaningful marks the canvas and the overview draw (bars, caps, rails, ticks, diamonds, the playhead).
  for (const m of ["live", "pass", "fail", "wait", "human", "halt", "stale", "select", "ink-soft", "route"]) pair(`--mach-factory-${m}`, "--mach-factory-ground", 3, "mark on the ground");
  for (const m of ["live", "pass", "fail", "wait", "human"]) pair(`--mach-factory-${m}`, `--mach-factory-${m}-soft`, 3, "mark on its own tint");
  pair("--mach-factory-ink-soft", "--mach-factory-plate-top", 3, "neutral mark on a plate");
  // Text drawn on the canvas (labels, durations, ruler).
  for (const t of ["--mach-ink", "--mach-ink-muted", "--mach-ink-subtle", "--mach-factory-ink"]) pair(t, "--mach-factory-ground", 4.5, "text on the ground");
  for (const t of ["--mach-ink", "--mach-ink-muted"]) pair(t, "--mach-factory-plate-top", 4.5, "text on a plate");
  return { ground, rows };
};

async function checkContrast(browser) {
  const per = {};
  for (const theme of ["dark", "light"]) {
    const { context, page } = await openTimeline(browser, { theme });
    per[theme] = await page.evaluate(contrastOf, `${WORKSPACE} [role=application]`);
    await context.close();
  }
  const failing = Object.entries(per).flatMap(([theme, r]) => r.rows.filter((x) => x.ratio !== null && x.ratio < x.need).map((x) => ({ theme, ...x })));
  record("contrast", "Drawn marks 3:1 and text 4.5:1 against the ground, from the tokens", failing.length === 0 ? "pass" : "fail", { failing, all: per });
}

// ------------------------------------------------------------ 5. reduced motion

const runningAnimations = (sel) =>
  document
    .getAnimations()
    .filter((a) => a.playState === "running")
    .filter((a) => {
      const t = a.effect?.target;
      return !sel || !t || t.closest?.(sel) || t === document.documentElement;
    })
    .map((a) => `${a.constructor.name}:${a.transitionProperty ?? a.animationName ?? "?"} on ${(a.effect?.target?.getAttribute?.("class") ?? a.effect?.target?.tagName ?? "?").toString().slice(0, 60)}`);

const canvasPrint = (sel) => [...document.querySelectorAll(`${sel} canvas`)].map((c) => {
  try {
    return c.toDataURL().length + ":" + c.toDataURL().slice(-64);
  } catch {
    return "tainted";
  }
});

async function checkReducedMotion(browser) {
  const { context, page } = await openTimeline(browser, { theme: "dark", reducedMotion: "reduce" });
  const steps = [];
  const after = async (label) => {
    await sleep(20);
    const a1 = await page.evaluate(runningAnimations, WORKSPACE);
    const c1 = await page.evaluate(canvasPrint, WORKSPACE);
    await sleep(250);
    const c2 = await page.evaluate(canvasPrint, WORKSPACE);
    const a2 = await page.evaluate(runningAnimations, WORKSPACE);
    steps.push({ step: label, runningJustAfter: a1, runningLater: a2, canvasStill: JSON.stringify(c1) === JSON.stringify(c2) });
  };
  // A zoom: the toolbar's narrow button, else + on the tracks.
  const zoomIn = page.locator(`${WORKSPACE} [role=toolbar] button[aria-label='Narrow the time window']`).first();
  if (await zoomIn.count()) await zoomIn.click();
  else {
    await page.locator(`${WORKSPACE} [role=application]`).first().focus();
    await page.keyboard.press("+");
  }
  await after("zoom in");
  // A brush drag: from the middle of the window on the overview, 80 px to the left.
  const move = page.locator(`${WORKSPACE} [role=slider][aria-label='Move window']`).first();
  if (await move.count()) {
    const b = await move.boundingBox();
    if (b) {
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 - 40, b.y + b.height / 2, { steps: 4 });
      await page.mouse.move(b.x + b.width / 2 - 80, b.y + b.height / 2, { steps: 4 });
      await page.mouse.up();
      await after("brush drag");
    } else steps.push({ step: "brush drag", note: "not run: the brush has no box" });
  } else steps.push({ step: "brush drag", note: "not run: no 'Move window' slider" });
  // A workspace switch: to the floor and back.
  await page.mouse.click(2, 300);
  await page.keyboard.press("1");
  await sleep(150);
  await page.keyboard.press("3");
  await sleep(150);
  await after("workspace switch (1, then 3)");
  await context.close();
  const bad = steps.filter((s) => s.runningLater?.length || s.canvasStill === false);
  record("reduced-motion", "prefers-reduced-motion: nothing animates after zoom, brush drag and workspace switch", bad.length === 0 ? "pass" : "fail", steps);
}

// ------------------------------------------------------------ 6. shortcut collisions

async function checkShortcuts(browser) {
  const src = (p) => readFileSync(join(app, p), "utf8");
  // The global map, as the code declares it (KEYMAP rows) and as the switch implements it.
  const keyboard = src("src/shell/keyboard.ts");
  const rows = [...keyboard.matchAll(/\{\s*keys:\s*\[([^\]]*)\],\s*action:\s*"([^"]*)",\s*group:\s*"([^"]*)"([^}]*)\}/g)].map((m) => ({
    keys: [...m[1].matchAll(/"([^"]+)"/g)].map((k) => k[1]),
    action: m[2],
    group: m[3],
    view: /view:\s*true/.test(m[4]),
    workspace: m[4].match(/workspace:\s*"(\w+)"/)?.[1] ?? null,
  }));
  const timelineKeys = [...(keyboard.match(/TIMELINE_KEYS[^=]*=\s*\{([^}]*)\}/)?.[1] ?? "").matchAll(/"?([^\s":,]+)"?\s*:\s*"([\w-]+)"/g)].map((m) => m[1]);
  const switchKeys = [...(keyboard.match(/switch \(key\) \{([\s\S]*?)\n {6}\}/)?.[1] ?? "").matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
  const norm = (k) => (k.length === 1 ? k.toLowerCase() : k);
  // Same context: rows the map handles itself (not `view`) in overlapping workspaces.
  const dup = [];
  const global = rows.filter((r) => !r.view);
  for (let i = 0; i < global.length; i++)
    for (let j = i + 1; j < global.length; j++) {
      const a = global[i];
      const b = global[j];
      if (a.workspace && b.workspace && a.workspace !== b.workspace) continue;
      for (const k of a.keys) if (b.keys.map(norm).includes(norm(k)) && !(a.keys.length === 1 && k === "F" && b.keys.includes("Shift+F"))) dup.push(`${k}: "${a.action}" and "${b.action}"`);
    }
  // A Timeline key that the switch also handles is shadowed there while the Timeline is up.
  const shadowed = timelineKeys.filter((k) => switchKeys.map(norm).includes(norm(k)));
  // The Timeline's own widgets: their keys, read from their sources.
  const literalKeys = (text) => [...new Set([...text.matchAll(/(?:e\.key|key)\s*===\s*"([^"]+)"|case "([^"]+)":/g)].map((m) => m[1] ?? m[2]))];
  const widgets = {};
  for (const [name, path] of [
    ["tracks (canvas)", "src/timeline/render/TrackCanvas.tsx"],
    ["tracks (keys module)", "src/timeline/render/keys.ts"],
    ["overview brush", "src/timeline/overview/model.ts"],
    ["table (treegrid)", "src/timeline/a11y/model.ts"],
  ]) {
    try {
      widgets[name] = literalKeys(src(path));
    } catch {
      widgets[name] = "not run: file not present";
    }
  }
  const globalKeys = new Set(global.flatMap((r) => r.keys.map(norm)).concat(timelineKeys.map(norm)));
  const overlaps = Object.fromEntries(Object.entries(widgets).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => globalKeys.has(norm(x))) : v]));

  // In the browser: Home and End in the grid and on the tracks must not also move the playhead.
  const measured = [];
  const { context, page } = await openTimeline(browser, { theme: "dark" });
  const playhead = () => page.evaluate(() => window.__machSim.state().playhead);
  const tracks = page.locator(`${WORKSPACE} [role=application]`).first();
  if (await tracks.count()) {
    await tracks.focus();
    await page.keyboard.press("ArrowDown");
    for (const key of ["Home", "End"]) {
      const p0 = await playhead();
      await page.keyboard.press(key);
      await sleep(120);
      const p1 = await playhead();
      measured.push({ where: "tracks", key, playheadMoved: p0 !== p1, note: p0 !== p1 ? "the global map acted (the canvas does not own this key)" : "owned by the canvas or unbound there" });
    }
  }
  await setTable(page, true);
  const row = page.locator(`${WORKSPACE} [role=treegrid] [role=row][tabindex='0']`).first();
  if (await row.count()) {
    await row.focus();
    for (const key of ["End", "Home"]) {
      const p0 = await playhead();
      const k0 = await page.evaluate(() => document.activeElement?.getAttribute("data-key"));
      await page.keyboard.press(key);
      await sleep(120);
      const p1 = await playhead();
      const k1 = await page.evaluate(() => document.activeElement?.getAttribute("data-key"));
      measured.push({ where: "table", key, playheadMoved: p0 !== p1, rowMoved: k0 !== k1 });
    }
    // Space and "," stay the playback keys in the grid.
    const p0 = await playhead();
    await page.keyboard.press(".");
    await sleep(120);
    measured.push({ where: "table", key: ".", playheadMoved: (await playhead()) !== p0, note: "a playback key: should still step" });
  }
  await context.close();
  const collide = dup.length > 0 || shadowed.length > 0 || measured.some((m) => m.where === "table" && m.key !== "." && (m.playheadMoved || !m.rowMoved));
  record("shortcuts", "No key bound twice in the same context", collide ? "fail" : "pass", {
    globalRows: global.length,
    duplicatesInGlobalMap: dup,
    timelineKeys,
    shadowedByTimelineKeys: shadowed,
    widgetKeys: widgets,
    widgetKeysAlsoGlobal: overlaps,
    homeEndExemption: /role"\) === "slider"/.test(keyboard) ? "keyboard.ts exempts only role=slider from Home/End; widgets that own them must preventDefault (the map skips defaultPrevented events)" : "changed",
    measured,
  });
}

// ------------------------------------------------------------ run

const server = await devServer();
const browser = await chromium.launch();
try {
  await guarded("axe", "axe on the workspace", () => checkAxe(browser));
  await guarded("keyboard", "keyboard walkthrough", () => checkKeyboard(browser));
  await guarded("targets", "target sizes", () => checkTargets(browser));
  await guarded("contrast", "contrast of drawn marks", () => checkContrast(browser));
  await guarded("reduced-motion", "reduced motion", () => checkReducedMotion(browser));
  await guarded("shortcuts", "shortcut collisions", () => checkShortcuts(browser));
} finally {
  await browser.close();
  await server.stop();
}

const report = { generated: new Date().toISOString(), origin: ORIGIN, checks };
writeFileSync(join(out, "timeline-audit.json"), JSON.stringify(report, null, 2));

/** One line of detail per check for the table. */
function brief(c) {
  const d = c.details;
  if (!d) return "";
  switch (c.id) {
    case "axe": {
      const v = d.flatMap((s) => s.violations.map((x) => `${x.id} (${x.nodes}) ${s.theme} ${s.size}${s.grouping ? ` ${s.grouping}` : ""}${s.table ? " table" : ""}${s.lens ? ` lens ${s.lens}` : ""}`));
      const ids = [...new Set(d.flatMap((s) => s.violations.map((x) => x.id)))];
      return v.length ? `${v.length} violations in ${d.length} states: ${ids.join(", ")}` : `0 violations in ${d.length} states`;
    }
    case "keyboard":
      return `${d.stops} stops, order ${d.regionOrder.join(" > ")}; ${d.tabStopsInTracks} stops in the tracks; ${d.withoutVisibleFocus.length} without visible focus; came back round ${d.wrapped}; canvas exits ${d.shiftTabFromTracks?.ok}`;
    case "targets":
      return `${d.failing.length} undersized and crowded; ${d.spacedButSmall.length} small but spaced`;
    case "contrast":
      return `${d.failing.length} pairs under their minimum`;
    case "reduced-motion":
      return d.map((s) => `${s.step}: ${s.note ?? `${s.runningLater.length} running, canvas ${s.canvasStill ? "still" : "moving"}`}`).join("; ");
    case "shortcuts":
      return `${d.duplicatesInGlobalMap.length} duplicates, ${d.shadowedByTimelineKeys.length} shadowed; ${d.measured.map((m) => `${m.where} ${m.key}: playhead ${m.playheadMoved ? "moved" : "kept"}`).join(", ")}`;
    default:
      return "";
  }
}
console.log("\n| Check | Result | Details |\n|---|---|---|");
for (const c of checks) console.log(`| ${c.id} | ${c.status} | ${brief(c).replace(/\|/g, "/")} |`);
console.log(`\nReport: ${join(out, "timeline-audit.json")}`);

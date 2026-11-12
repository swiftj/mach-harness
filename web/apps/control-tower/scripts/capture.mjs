// Screenshots of the principal visual states of the M6.0 Living Factory prototype.
//
//   pnpm --filter @mach/control-tower capture            # build (if stale) and shoot everything
//   node scripts/capture.mjs --only 07                   # just the shots whose name starts with 07
//   node scripts/capture.mjs --rebuild --sheets          # force the build; also write contact sheets
//
// Serves the `vite build --mode capture` bundle with `vite preview` on 127.0.0.1:4186, drives it
// through window.__machSim on the manual clock (nothing moves unless the script moves it), and writes
// screenshots/<NN>-<beat>-<view>-<theme>[@2x].png at 1920x1080, in story order. See
// screenshots/README.md for the list.
//
// Framing: the Atlas owner's beats (factory second, focus target, zoom). `focus` frames a target
// without dimming anything; `select` also opens the inspector on it and dims what is unrelated, so
// the wide hero shots focus and the per-state shots select. Every shot waits for the interface
// transitions (camera 650 ms, mode switch 700 ms) to finish, checked by reading the camera until it
// stops moving.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { app, args, ensureBuild, frames, log, openApp, S, sim, sleep, startPreview } from "./lib.mjs";

const out = join(app, "screenshots");
mkdirSync(out, { recursive: true });
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex > 0 ? process.argv[onlyIndex + 1] : null;
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";

/**
 * The story, in order. Times in factory seconds. `atlas` and `blueprint` say how each view frames the
 * beat: `select` (inspector + dimming), `focus` (camera only), `zoom` (Atlas zoom after the focus),
 * `around` (Atlas: centre the camera on these entities after zooming), `expand` (Blueprint: open these
 * tree items so agents and tool calls show).
 */
const BEATS = [
  { id: "01-opening", t: 0, hero: true, atlas: {}, blueprint: {} },
  {
    id: "02-wave-arrives",
    t: 34,
    atlas: { focus: "wave:WAVE-007", zoom: 1.3, around: ["wave:WAVE-007", "slice:SLICE-021", "slice:SLICE-025", "cell:LOCAL-031"] },
    blueprint: { select: "wave:WAVE-007", bp: { ref: "wave:WAVE-007", k: 0.8 } },
  },
  { id: "03-three-bays", t: 640, hero: true, theater: true, atlas: { focus: "cell:LOCAL-032", zoom: 1.1 }, blueprint: {} },
  {
    id: "04-agent-inspected",
    t: 640,
    atlas: { select: "agent:ag-031-08" },
    blueprint: { select: "agent:ag-031-08", expand: ["agent:ag-031-08"], bp: { ref: "agent:ag-031-08", k: 1.3 } },
  },
  {
    id: "05-review-fan-out",
    t: 1601,
    atlas: { select: "gate:LOCAL-033/review#1" },
    blueprint: { select: "gate:LOCAL-033/review#1", bp: { ref: "gate:LOCAL-033/review#1", k: 1.1 } },
  },
  {
    id: "06-outvoted-blocker",
    t: 1612,
    atlas: { select: "finding:LOCAL-033/r1/product/1" },
    blueprint: { select: "finding:LOCAL-033/r1/product/1" },
  },
  {
    id: "07-verify-fail-return",
    t: 1660,
    hero: true,
    theater: true,
    atlas: { select: "gate:LOCAL-031/verification#1", focus: "cell:LOCAL-031", zoom: 2.0 },
    heroAtlas: { focus: "cell:LOCAL-031", zoom: 2.0 },
    blueprint: { select: "gate:LOCAL-031/verification#1", bp: { ref: "gate:LOCAL-031/verification#1", k: 1.1 } },
  },
  {
    id: "08-rejection-crosses",
    t: 1940,
    hero: true,
    theater: true,
    atlas: { select: "gate:LOCAL-032/review#1", focus: "cell:LOCAL-032", zoom: 0.85, around: ["cell:LOCAL-032", "gate:review"] },
    heroAtlas: { focus: "cell:LOCAL-032", zoom: 0.85, around: ["cell:LOCAL-032", "gate:review"] },
    blueprint: { select: "gate:LOCAL-032/review#1", bp: { ref: "gate:LOCAL-032/review#1", k: 1.0 } },
  },
  {
    id: "09-integration",
    t: 2567,
    atlas: { select: "cell:LOCAL-031", focus: "station:merge", zoom: 1.3, around: ["station:merge"] },
    blueprint: { select: "cell:LOCAL-031", bp: { ref: "cell:LOCAL-031", k: 0.9 } },
  },
  {
    id: "10-dependency-unlocks",
    t: 2622,
    theater: true,
    atlas: { select: "dependency:SLICE-024->SLICE-021", focus: "dependency:SLICE-024->SLICE-021", zoom: 1.0 },
    heroAtlas: { focus: "dependency:SLICE-024->SLICE-021", zoom: 1.0 },
    blueprint: { select: "dependency:SLICE-024->SLICE-021", bp: { ref: "dependency:SLICE-024->SLICE-021", k: 0.9 } },
  },
  {
    id: "11-human-gate-held",
    t: 2852,
    atlas: { select: "gate:LOCAL-032/human-approval", focus: "gate:LOCAL-032/human-approval", zoom: 1.8 },
    blueprint: { select: "gate:LOCAL-032/human-approval", bp: { ref: "gate:LOCAL-032/human-approval", k: 1.1 } },
  },
  {
    id: "12-human-gate-released",
    t: 3125,
    hero: true,
    theater: true,
    atlas: { select: "gate:LOCAL-032/human-approval", focus: "gate:LOCAL-032/human-approval", zoom: 1.8 },
    heroAtlas: { focus: "gate:LOCAL-032/human-approval", zoom: 1.8 },
    blueprint: { select: "gate:LOCAL-032/human-approval", bp: { ref: "gate:LOCAL-032/human-approval", k: 1.1 } },
  },
  { id: "13-end-of-run", t: 3350.2, hero: true, atlas: { focus: "overview" }, blueprint: { focus: "overview" } },
];

const THEMES = ["dark", "light"];
const want = (name) => !only || name.startsWith(only);
const shots = [];

/** Wait until the Atlas camera has stopped moving (or a fixed time for the Blueprint). */
async function settleCamera(page, view) {
  if (view !== "atlas") {
    await sleep(1100);
    await frames(page, 3);
    return;
  }
  await sleep(200);
  let last = "";
  for (let i = 0; i < 40; i++) {
    const now = await page.evaluate(() => JSON.stringify(window.__atlasCamera?.get() ?? null));
    if (now === last) break;
    last = now;
    await sleep(120);
  }
  await frames(page, 3);
}

/** Centre the Atlas camera on the union of these entities' screen boxes. */
async function centreOn(page, refs) {
  await page.evaluate((list) => {
    const stage = document.querySelector("[data-stage-view] [data-view=atlas]") ?? document.getElementById("stage");
    const view = stage.getBoundingClientRect();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const ref of list) {
      for (const el of document.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`)) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        x0 = Math.min(x0, r.left);
        y0 = Math.min(y0, r.top);
        x1 = Math.max(x1, r.right);
        y1 = Math.max(y1, r.bottom);
      }
    }
    if (!Number.isFinite(x0)) return;
    const cam = window.__atlasCamera.get();
    const dx = view.left + view.width / 2 - (x0 + x1) / 2;
    const dy = view.top + view.height / 2 - (y0 + y1) / 2;
    window.__atlasCamera.set({ zoom: cam.zoom, x: cam.x + dx, y: cam.y + dy });
  }, refs);
}

/** Open Blueprint tree items (an agent shows its tool calls) by keyboard, as a person would. */
async function expand(page, refs) {
  for (const ref of refs) {
    const item = page.locator(`[role=treeitem][data-ref="${ref}"]`).first();
    if (!(await item.count())) continue;
    if ((await item.getAttribute("aria-expanded")) === "false") {
      await item.focus();
      await page.keyboard.press("ArrowRight");
      await sleep(500);
    }
  }
}

/**
 * Blueprint framing: zoom to `k` about the entity (Ctrl + wheel zooms to the cursor, as a person
 * would), then pan it to the middle of the stage with a plain wheel.
 */
async function bpFrame(page, { ref, k }) {
  const box = () =>
    page.evaluate((r) => {
      const root = document.querySelector('[data-stage-view="blueprint"]');
      const view = root.getBoundingClientRect();
      const els = [...root.querySelectorAll(`[data-ref="${CSS.escape(r)}"]`)].map((e) => e.getBoundingClientRect()).filter((b) => b.width || b.height);
      const scaled = root.querySelector('[style*="scale("]');
      const scale = Number(/scale\(([\d.]+)\)/.exec(scaled?.style.transform ?? "")?.[1] ?? 1);
      if (!els.length) return { view, scale, x: null, y: null };
      const x0 = Math.min(...els.map((b) => b.left));
      const x1 = Math.max(...els.map((b) => b.right));
      const y0 = Math.min(...els.map((b) => b.top));
      const y1 = Math.max(...els.map((b) => b.bottom));
      return { view: { left: view.left, top: view.top, width: view.width, height: view.height }, scale, x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }, ref);
  let b = await box();
  if (b.x === null) return;
  const cx = Math.min(Math.max(b.x, b.view.left + 20), b.view.left + b.view.width - 20);
  const cy = Math.min(Math.max(b.y, b.view.top + 20), b.view.top + b.view.height - 20);
  await page.mouse.move(cx, cy);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -Math.log(k / b.scale) / Math.log(1.0015));
  await page.keyboard.up("Control");
  await frames(page, 2);
  b = await box();
  if (b.x === null) return;
  await page.mouse.wheel(b.x - (b.view.left + b.view.width / 2), b.y - (b.view.top + b.view.height / 2));
  await frames(page, 2);
  // Park the pointer on the top bar so no hover state shows in the still.
  await page.mouse.move(600, 24);
}

/** Put the app in a beat's state: time, selection, camera. */
async function stage(page, view, t, frame) {
  await sim(page, "seek", S(t));
  if (frame.select) await sim(page, "select", frame.select);
  if (frame.focus) await sim(page, "focus", frame.focus);
  await settleCamera(page, view);
  if (view === "atlas" && frame.zoom) {
    await page.evaluate((z) => window.__atlasCamera.zoomTo(z), frame.zoom);
    if (frame.around) await centreOn(page, frame.around);
    await frames(page, 3);
  }
  if (view === "blueprint" && frame.expand) await expand(page, frame.expand);
  if (view === "blueprint" && frame.bp) await bpFrame(page, frame.bp);
  // Nothing in the app may hold keyboard focus rings in a still (the Blueprint expansion focuses a node).
  await page.evaluate(() => document.activeElement?.blur?.());
  await sleep(300);
  await frames(page, 3);
}

async function shoot(page, name) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  const stamp = await page.evaluate(() => [...document.querySelectorAll("[data-simulation-stamp]")].some((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden"));
  if (!stamp) throw new Error(`${name}: the Simulation label is not visible`);
  shots.push(name);
  log("shot", name);
}

/** One fresh page per shot, so nothing (an expanded lane, a timeline row) carries over from the last. */
async function one(browser, options, name, fn) {
  if (!want(name)) return;
  const { context, page } = await openApp(browser, options);
  try {
    await fn(page);
    await shoot(page, name);
  } finally {
    await context.close();
  }
}

async function storyPass(browser, theme, view, dpr) {
  for (const beat of BEATS.filter((b) => (dpr === 2 ? b.hero && view === "atlas" : true))) {
    const frame = dpr === 2 ? (beat.heroAtlas ?? beat.atlas) : beat[view];
    await one(browser, { theme, view, dpr }, `${beat.id}-${view}-${theme}${dpr === 2 ? "@2x" : ""}`, (page) => stage(page, view, beat.t, frame));
  }
}

async function theaterPass(browser, theme) {
  for (const beat of BEATS.filter((b) => b.theater)) {
    await one(browser, { theme, view: "atlas", dpr: 2 }, `${beat.id}-theater-${theme}@2x`, async (page) => {
      await sim(page, "setTheater", true);
      await sleep(400);
      await stage(page, "atlas", beat.t, beat.heroAtlas ?? { ...beat.atlas, select: undefined });
      // The transport bar shows for 2.5 s after the pointer moves; a still shows Theater at rest.
      await sleep(2800);
    });
  }
}

async function extrasPass(browser, theme) {
  // The mode-switch pair: the same selection, Atlas then Blueprint, switched with the real key "2".
  if (want("20")) {
    const { context, page } = await openApp(browser, { theme, view: "atlas" });
    try {
      await stage(page, "atlas", 1940, { select: "cell:LOCAL-032" });
      await shoot(page, `20-mode-switch-a-atlas-${theme}`);
      await page.keyboard.press("2");
      await settleCamera(page, "blueprint");
      await shoot(page, `20-mode-switch-b-blueprint-${theme}`);
    } finally {
      await context.close();
    }
  }
  // The keyboard help sheet, opened with "?".
  if (want("21")) {
    const { context, page } = await openApp(browser, { theme, view: "atlas" });
    try {
      await stage(page, "atlas", 640, { focus: "overview" });
      await page.keyboard.press("?");
      await page.getByRole("dialog").waitFor();
      await sleep(600);
      await shoot(page, `21-help-sheet-${theme}`);
    } finally {
      await context.close();
    }
  }
  // Reduced motion: mid-way through the return-to-build loop, the same moment with and without.
  if (want("22")) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const { context, page } = await openApp(browser, { theme, view: "atlas", reducedMotion });
      try {
        await stage(page, "atlas", 1646, { focus: "cell:LOCAL-031", zoom: 2.0 });
        await shoot(page, `22-reduced-motion-${reducedMotion === "reduce" ? "b-on" : "a-off"}-atlas-${theme}`);
        if (reducedMotion === "reduce") {
          await sim(page, "setMode", "blueprint");
          await settleCamera(page, "blueprint");
          await shoot(page, `22-reduced-motion-c-on-blueprint-${theme}`);
        }
      } finally {
        await context.close();
      }
    }
  }
  // 1100 wide: the inspector becomes an overlay that opens on a selection.
  if (want("23")) {
    const { context, page } = await openApp(browser, { theme, view: "atlas", width: 1100, height: 800 });
    try {
      for (const [n, beat, frame] of [
        ["a", "01-opening", { focus: "overview" }],
        ["b", "03-three-bays", { focus: "cell:LOCAL-032", zoom: 1.1 }],
        ["c", "07-verify-fail-return", { select: "gate:LOCAL-031/verification#1", focus: "cell:LOCAL-031", zoom: 1.6 }],
        ["d", "11-human-gate-held", { focus: "gate:LOCAL-032/human-approval", zoom: 1.5 }],
      ]) {
        const t = BEATS.find((b) => b.id === beat).t;
        await stage(page, "atlas", t, frame);
        await sleep(400);
        await shoot(page, `23-narrow-1100-${n}-${beat.slice(3)}-atlas-${theme}`);
      }
    } finally {
      await context.close();
    }
  }
}

/** Contact sheets (4 shots per sheet at half size) for reviewing the set at a glance. */
function contactSheets() {
  const dir = join(out, "_sheets");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const files = readdirSync(out).filter((f) => f.endsWith(".png")).sort();
  for (let i = 0; i < files.length; i += 4) {
    const group = files.slice(i, i + 4);
    const inputs = group.flatMap((f) => ["-i", join(out, f)]);
    const scaled = group.map((_, k) => `[${k}:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2[s${k}]`);
    while (scaled.length < 4) scaled.push(`color=c=gray:s=960x540:d=1[s${scaled.length}]`);
    const filter = `${scaled.join(";")};[s0][s1][s2][s3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]`;
    log(`sheet ${String(i / 4 + 1).padStart(2, "0")}:`, group.join("  "));
    execFileSync(FFMPEG, ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", join(dir, `sheet-${String(i / 4 + 1).padStart(2, "0")}.png`)]);
  }
  log("contact sheets in", dir);
}

if (args.has("--sheets-only")) {
  contactSheets();
  process.exit(0);
}
ensureBuild();
const server = await startPreview();
const browser = await chromium.launch();
try {
  for (const theme of THEMES) {
    for (const view of ["atlas", "blueprint"]) await storyPass(browser, theme, view, 1);
    await storyPass(browser, theme, "atlas", 2);
    await theaterPass(browser, theme);
    await extrasPass(browser, theme);
  }
} finally {
  await browser.close();
  server.stop();
}
if (args.has("--sheets") && existsSync(FFMPEG)) contactSheets();
log(`${shots.length} screenshots in ${out}`);

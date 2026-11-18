// Screenshots of the principal visual states of the M6.0 Living Factory prototype.
//
//   pnpm --filter @mach/factory-floor capture            # build (if stale) and shoot everything
//   node scripts/capture.mjs --only 07                   # just the shots whose name starts with 07
//   node scripts/capture.mjs --rebuild --sheets          # force the build; also write contact sheets
//
// Serves the `vite build --mode capture` bundle with `vite preview` on 127.0.0.1:4186, drives it
// through window.__machSim on the manual clock (nothing moves unless the script moves it), and writes
// screenshots/<NN>-<beat>-atlas-<theme>[@2x].png at 1920x1080, in story order. See
// screenshots/README.md for the list.
//
// Framing: the Atlas owner's beats (factory second, focus target, zoom). `focus` frames a target
// without dimming anything; `select` also opens the inspector on it and dims what is unrelated, so
// the wide hero shots focus and the per-state shots select. Every shot waits for the interface
// transitions (camera 650 ms, mode switch 700 ms) to finish, checked by reading the camera until it
// stops moving.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { app, args, ensureBuild, frames, log, openApp, S, sim, sleep, startPreview } from "./lib.mjs";

const out = join(app, "screenshots");
mkdirSync(out, { recursive: true });
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex > 0 ? process.argv[onlyIndex + 1] : null;
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";

/**
 * The story, in order. Times in factory seconds. `atlas` says how the Atlas frames the beat: `select`
 * (inspector + dimming), `focus` (camera only), `zoom` (zoom after the focus), `around` (centre the
 * camera on these entities after zooming).
 */
const BEATS = [
  { id: "01-opening", t: 0, hero: true, atlas: {} },
  {
    id: "02-wave-arrives",
    t: 34,
    atlas: { focus: "wave:WAVE-007", zoom: 1.3, around: ["wave:WAVE-007", "slice:SLICE-021", "slice:SLICE-025", "cell:LOCAL-031"] },
  },
  { id: "03-three-bays", t: 640, hero: true, theater: true, atlas: { focus: "cell:LOCAL-032", zoom: 1.1 } },
  {
    id: "04-agent-inspected",
    t: 640,
    atlas: { select: "agent:ag-031-08" },
  },
  {
    id: "05-review-fan-out",
    t: 1601,
    atlas: { select: "gate:LOCAL-033/review#1" },
  },
  {
    id: "06-outvoted-blocker",
    t: 1612,
    atlas: { select: "finding:LOCAL-033/r1/product/1" },
  },
  {
    id: "07-verify-fail-return",
    t: 1660,
    hero: true,
    theater: true,
    atlas: { select: "gate:LOCAL-031/verification#1", focus: "cell:LOCAL-031", zoom: 2.0 },
    heroAtlas: { focus: "cell:LOCAL-031", zoom: 2.0 },
  },
  {
    id: "08-rejection-crosses",
    t: 1940,
    hero: true,
    theater: true,
    atlas: { select: "gate:LOCAL-032/review#1", focus: "cell:LOCAL-032", zoom: 0.85, around: ["cell:LOCAL-032", "gate:review"] },
    heroAtlas: { focus: "cell:LOCAL-032", zoom: 0.85, around: ["cell:LOCAL-032", "gate:review"] },
  },
  {
    id: "09-integration",
    t: 2567,
    // Centred between the merge machine and the approval yard, so the trunk, the gate and what fed it fill the frame.
    // `nudge` moves the drawing down so the yard and the approval and review regions above it fill the frame
    // (centred on the merge machine alone, the lower half was empty ground past the plant's edge).
    atlas: { select: "cell:LOCAL-031", focus: "station:merge", zoom: 1.15, around: ["station:merge"], nudge: [-120, 230] },
  },
  {
    id: "10-dependency-unlocks",
    t: 2622,
    theater: true,
    atlas: { select: "dependency:SLICE-024->SLICE-021", focus: "dependency:SLICE-024->SLICE-021", zoom: 1.0 },
    heroAtlas: { focus: "dependency:SLICE-024->SLICE-021", zoom: 1.0 },
  },
  {
    id: "11-human-gate-held",
    t: 2852,
    atlas: { select: "gate:LOCAL-032/human-approval", focus: "gate:LOCAL-032/human-approval", zoom: 1.8 },
  },
  {
    id: "12-human-gate-released",
    t: 3125,
    hero: true,
    theater: true,
    atlas: { select: "gate:LOCAL-032/human-approval", focus: "gate:LOCAL-032/human-approval", zoom: 1.8 },
    heroAtlas: { focus: "gate:LOCAL-032/human-approval", zoom: 1.8 },
  },
  { id: "13-end-of-run", t: 3350.2, hero: true, atlas: { focus: "overview" } },
];

const THEMES = ["dark", "light"];
const want = (name) => !only || name.startsWith(only);
const shots = [];

/** Wait until the Atlas camera has stopped moving. */
async function settleCamera(page) {
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
    // Both views stay mounted; only the active one counts (the hidden one still has layout boxes).
    const stage = document.querySelector("[data-stage-active] [data-view=atlas]") ?? document.getElementById("stage");
    const view = stage.getBoundingClientRect();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const ref of list) {
      for (const el of stage.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`)) {
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

/** Put the app in a beat's state: time, selection, camera. */
async function stage(page, t, frame) {
  await sim(page, "seek", S(t));
  if (frame.select) await sim(page, "select", frame.select);
  if (frame.focus) await sim(page, "focus", frame.focus);
  await settleCamera(page);
  if (frame.zoom) {
    await page.evaluate((z) => window.__atlasCamera.zoomTo(z), frame.zoom);
    if (frame.around) await centreOn(page, frame.around);
    if (frame.nudge) await page.evaluate(([dx, dy]) => {
      const c = window.__atlasCamera.get();
      window.__atlasCamera.set({ ...c, x: c.x + dx, y: c.y + dy });
    }, frame.nudge);
    await frames(page, 3);
  }
  // Nothing in the app may hold keyboard focus rings in a still.
  await page.evaluate(() => document.activeElement?.blur?.());
  await sleep(300);
  await frames(page, 3);
}

/**
 * A machine check of each still, for the findings (D6, D7): Atlas callouts (the overlay's text)
 * reaching past the visible stage or under the inspector/timeline, and pairs of visible text boxes in
 * the active view that overlap by more than 30% of the smaller one (a heuristic: rotated floor
 * lettering has a loose box). The selection's screen box is checked against the visible stage.
 */
const layout = {};
async function layoutCheck(page) {
  return page.evaluate(() => {
    const act = document.querySelector("[data-stage-active]");
    if (!act) return null;
    const stage = document.getElementById("stage").getBoundingClientRect();
    const aside = document.querySelector("aside");
    const ab = aside && !aside.hasAttribute("inert") ? aside.getBoundingClientRect() : null;
    const visible = { left: stage.left, top: stage.top, right: ab && ab.left < stage.right && ab.width > 0 && ab.left > stage.left ? Math.min(stage.right, ab.left) : stage.right, bottom: stage.bottom };
    const texts = [...act.querySelectorAll("svg text")]
      .map((t) => ({ t, r: t.getBoundingClientRect() }))
      .filter(({ t, r }) => {
        if (r.width < 2 || r.height < 2 || r.right < visible.left || r.left > visible.right || r.bottom < visible.top || r.top > visible.bottom) return false;
        for (let n = t; n && n !== act; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.35) return false;
        }
        return true;
      });
    const clipped = texts
      .filter(({ t }) => t.closest(".atlas-overlay"))
      .filter(({ r }) => r.left < visible.left - 1 || r.right > visible.right + 1 || r.top < visible.top - 1 || r.bottom > visible.bottom + 1)
      .map(({ t }) => t.textContent.trim().slice(0, 50));
    const overlaps = [];
    for (let i = 0; i < texts.length && overlaps.length < 12; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].r;
        const b = texts[j].r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w <= 0 || h <= 0) continue;
        const small = Math.min(a.width * a.height, b.width * b.height);
        if ((w * h) / small > 0.3 && texts[i].t.textContent.trim() && texts[j].t.textContent.trim()) overlaps.push(`"${texts[i].t.textContent.trim().slice(0, 32)}" x "${texts[j].t.textContent.trim().slice(0, 32)}"`);
      }
    }
    const sel = window.__machSim?.state().selection;
    let selection = null;
    if (sel) {
      const boxes = [...act.querySelectorAll(`[data-ref="${CSS.escape(sel)}"]`)].map((e) => e.getBoundingClientRect()).filter((r) => r.width || r.height);
      if (boxes.length) {
        const x0 = Math.min(...boxes.map((b) => b.left));
        const x1 = Math.max(...boxes.map((b) => b.right));
        const y0 = Math.min(...boxes.map((b) => b.top));
        const y1 = Math.max(...boxes.map((b) => b.bottom));
        const iw = Math.max(0, Math.min(x1, visible.right) - Math.max(x0, visible.left));
        const ih = Math.max(0, Math.min(y1, visible.bottom) - Math.max(y0, visible.top));
        selection = { ref: sel, shareInView: Math.round((100 * iw * ih) / Math.max(1, (x1 - x0) * (y1 - y0))) };
      } else selection = { ref: sel, shareInView: null };
    }
    return { view: "atlas", overlayTextOutsideStage: clipped, textOverlaps: overlaps, selection };
  });
}

async function shoot(page, name) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  const stamp = await page.evaluate(() => [...document.querySelectorAll("[data-simulation-stamp]")].some((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden"));
  if (!stamp) throw new Error(`${name}: the Simulation label is not visible`);
  layout[name] = await layoutCheck(page);
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

async function storyPass(browser, theme, dpr) {
  for (const beat of BEATS.filter((b) => (dpr === 2 ? b.hero : true))) {
    const frame = dpr === 2 ? (beat.heroAtlas ?? beat.atlas) : beat.atlas;
    await one(browser, { theme, dpr }, `${beat.id}-atlas-${theme}${dpr === 2 ? "@2x" : ""}`, (page) => stage(page, beat.t, frame));
  }
}

async function theaterPass(browser, theme) {
  for (const beat of BEATS.filter((b) => b.theater)) {
    await one(browser, { theme, dpr: 2 }, `${beat.id}-theater-${theme}@2x`, async (page) => {
      await sim(page, "setTheater", true);
      await sleep(400);
      await stage(page, beat.t, beat.heroAtlas ?? { ...beat.atlas, select: undefined });
      // The transport bar shows for 2.5 s after the pointer moves; a still shows Theater at rest.
      await sleep(2800);
    });
  }
}

async function extrasPass(browser, theme) {
  // The keyboard help sheet, opened with "?".
  if (want("21")) {
    const { context, page } = await openApp(browser, { theme });
    try {
      await stage(page, 640, { focus: "overview" });
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
      const { context, page } = await openApp(browser, { theme, reducedMotion });
      try {
        await stage(page, 1646, { focus: "cell:LOCAL-031", zoom: 2.0 });
        await shoot(page, `22-reduced-motion-${reducedMotion === "reduce" ? "b-on" : "a-off"}-atlas-${theme}`);
      } finally {
        await context.close();
      }
    }
  }
  // 1100 wide: the inspector becomes an overlay that opens on a selection.
  if (want("23")) {
    const { context, page } = await openApp(browser, { theme, width: 1100, height: 800 });
    try {
      for (const [n, beat, frame] of [
        ["a", "01-opening", { focus: "overview" }],
        ["b", "03-three-bays", { focus: "cell:LOCAL-032", zoom: 1.1 }],
        ["c", "07-verify-fail-return", { select: "gate:LOCAL-031/verification#1", focus: "cell:LOCAL-031", zoom: 1.6 }],
        ["d", "11-human-gate-held", { focus: "gate:LOCAL-032/human-approval", zoom: 1.5 }],
      ]) {
        const t = BEATS.find((b) => b.id === beat).t;
        // One page for the four: clear what the last shot selected, so its drawer does not carry over.
        await sim(page, "select", null);
        await stage(page, t, frame);
        await sleep(400);
        // The drawer covers the right of the stage when something is selected: frame the selection in
        // the part left visible (the app's own framing centres it in the whole stage).
        if (frame.select) {
          await page.evaluate((ref) => {
            const atlas = document.querySelector("[data-stage-active] [data-view=atlas]");
            const stage = atlas.getBoundingClientRect();
            const drawer = document.querySelector("aside").getBoundingClientRect();
            const right = drawer.width && drawer.left < stage.right ? drawer.left : stage.right;
            const boxes = [...atlas.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`)].map((e) => e.getBoundingClientRect()).filter((b) => b.width || b.height);
            if (!boxes.length) return;
            const cx = (Math.min(...boxes.map((b) => b.left)) + Math.max(...boxes.map((b) => b.right))) / 2;
            const cam = window.__atlasCamera.get();
            window.__atlasCamera.set({ ...cam, x: cam.x + (stage.left + right) / 2 - cx });
          }, frame.select);
          await sleep(400);
          await frames(page, 3);
        }
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
    await storyPass(browser, theme, 1);
    await storyPass(browser, theme, 2);
    await theaterPass(browser, theme);
    await extrasPass(browser, theme);
  }
} finally {
  await browser.close();
  server.stop();
}
if (!only) {
  mkdirSync(join(out, "_layout"), { recursive: true });
  writeFileSync(join(out, "_layout", "report.json"), JSON.stringify(layout, null, 2));
}
if (args.has("--sheets") && existsSync(FFMPEG)) contactSheets();
log(`${shots.length} screenshots in ${out}`);

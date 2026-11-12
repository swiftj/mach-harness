// Performance of the M6.0 prototype, measured on the capture build (the production build plus the
// capture hook), in a headed Chromium on this machine's GPU and in headless Chromium for comparison.
//
//   node scripts/measure.mjs                    # both browsers; writes screenshots/_perf/report.json
//   node scripts/measure.mjs --headless-only
//
// The app runs on its real clock here (requestAnimationFrame), not the capture script's manual one.
// Per run: every animation-frame interval (rAF timestamps), long tasks (PerformanceObserver), long
// animation frames (LoAF: script and render time of frames over 50 ms), and Chromium's own counters
// over the run (CDP Performance.getMetrics: ScriptDuration, LayoutDuration, RecalcStyleDuration,
// TaskDuration, JSHeapUsedSize, Nodes), divided by the frames drawn for a per-frame average.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { ACTIVE, app, args, dist, ensureBuild, log, openApp, ORIGIN, S, sim, sleep, startPreview, waitPrepared } from "./lib.mjs";

const out = join(app, "screenshots", "_perf");
mkdirSync(out, { recursive: true });
const RUN_MS = 8000;
const report = {
  generated: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}` },
  browsers: {},
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
function distribution(intervals) {
  const s = [...intervals].sort((a, b) => a - b);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    frames: s.length,
    p50: r1(pct(s, 50)),
    p95: r1(pct(s, 95)),
    p99: r1(pct(s, 99)),
    max: r1(s[s.length - 1] ?? 0),
    over16_7: `${((100 * s.filter((x) => x > 16.7).length) / Math.max(1, s.length)).toFixed(1)}%`,
    over33: `${((100 * s.filter((x) => x > 33.4).length) / Math.max(1, s.length)).toFixed(1)}%`,
  };
}

async function metrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/** Install the in-page frame and long-task recorders (once per page). */
async function instrument(page) {
  await page.evaluate(() => {
    const rec = (window.__perf = { on: false, stamps: [], longtasks: [], loaf: [] });
    const loop = (t) => {
      if (rec.on) rec.stamps.push(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    new PerformanceObserver((l) => {
      if (rec.on) for (const e of l.getEntries()) rec.longtasks.push(e.duration);
    }).observe({ type: "longtask" });
    try {
      new PerformanceObserver((l) => {
        if (!rec.on) return;
        for (const e of l.getEntries()) {
          const script = (e.scripts ?? []).reduce((s, x) => s + x.duration, 0);
          rec.loaf.push({ duration: e.duration, script, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0 });
        }
      }).observe({ type: "long-animation-frame" });
    } catch {
      // LoAF not supported
    }
  });
}

/** Measure while `during` runs (or for RUN_MS): frame intervals, long tasks, counters per frame. */
async function measure(page, cdp, during, ms = RUN_MS) {
  const m0 = await metrics(cdp);
  await page.evaluate(() => {
    Object.assign(window.__perf, { on: true, stamps: [], longtasks: [], loaf: [] });
  });
  const started = Date.now();
  if (during) await during();
  const left = ms - (Date.now() - started);
  if (left > 0) await sleep(left);
  const rec = await page.evaluate(() => {
    window.__perf.on = false;
    return window.__perf;
  });
  const m1 = await metrics(cdp);
  const intervals = rec.stamps.slice(1).map((t, i) => t - rec.stamps[i]);
  const n = Math.max(1, intervals.length);
  const per = (k) => Math.round(((m1[k] - m0[k]) * 1000 * 100) / n) / 100;
  return {
    ...distribution(intervals),
    longTasks: { count: rec.longtasks.length, totalMs: Math.round(rec.longtasks.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...rec.longtasks)) },
    longAnimationFrames: { count: rec.loaf.length, maxScriptMs: Math.round(Math.max(0, ...rec.loaf.map((l) => l.script))), maxRenderMs: Math.round(Math.max(0, ...rec.loaf.map((l) => l.render))) },
    perFrameMs: { script: per("ScriptDuration"), layout: per("LayoutDuration"), style: per("RecalcStyleDuration"), task: per("TaskDuration") },
    heapMB: Math.round((m1.JSHeapUsedSize / 2 ** 20) * 10) / 10,
    nodes: m1.Nodes,
  };
}

/**
 * The Atlas's SVG element and text counts. Both views stay mounted, so the count is of the Atlas
 * itself (whichever layer it is in); the hidden Blueprint's elements are reported separately, since
 * they are in the DOM too (the budget is written for one view).
 */
async function atlasCounts(page) {
  return page.evaluate(() => {
    const atlas = document.querySelector("[data-stage-view=atlas] [data-view=atlas]");
    if (!atlas) return null;
    const bp = document.querySelector("[data-stage-view=blueprint]");
    return {
      lod: atlas.dataset.lod,
      zoom: Math.round((window.__atlasCamera?.get().zoom ?? 0) * 1000) / 1000,
      svgElements: atlas.querySelectorAll("svg *").length,
      textElements: atlas.querySelectorAll("svg text").length,
      atlasActive: Boolean(atlas.closest("[data-stage-active]")),
      hiddenBlueprintSvgElements: bp && !bp.hasAttribute("data-stage-active") ? bp.querySelectorAll("svg *").length : null,
    };
  });
}

async function blueprintExpandAll(page) {
  for (let round = 0; round < 40; round++) {
    const n = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-stage-view="blueprint"] [role=treeitem][aria-expanded="false"]')];
      return items.length;
    });
    if (!n) return;
    const item = page.locator('[data-stage-view="blueprint"] [role=treeitem][aria-expanded="false"]').first();
    await item.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await sleep(120);
  }
}

async function blueprintCollapse(page) {
  for (let round = 0; round < 20; round++) {
    const item = page.locator('[data-stage-view="blueprint"] [role=treeitem][aria-level="2"][aria-expanded="true"]').first();
    if (!(await item.count())) return;
    await item.focus();
    await page.keyboard.press("Alt+ArrowLeft");
    await sleep(150);
  }
}

async function scenarios(browser, label) {
  const result = { scenarios: [], scrub: [], modeSwitch: [], memory: null, load: [], counts: [] };
  const open = async (view = "atlas") => {
    const { context, page } = await openApp(browser, { theme: "dark", view, live: true });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await instrument(page);
    await sim(page, "pause");
    // The other view is prepared while the browser is idle; measure the settled app, as a person who
    // has been looking for a few seconds would use it (an early switch is measured on its own below).
    await waitPrepared(page);
    return { context, page, cdp };
  };
  // GPU of this browser.
  {
    const { context, page } = await open();
    result.gpu = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : "no WebGL", vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null };
    });
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.refresh = await page.evaluate(
      () =>
        new Promise((done) => {
          const t = [];
          const f = (x) => (t.push(x), t.length < 61 ? requestAnimationFrame(f) : done(Math.round((1000 * 60) / (t[60] - t[0]))));
          requestAnimationFrame(f);
        }),
    );
    await context.close();
  }
  for (const config of ["atlas-fit", "atlas-near-following", "blueprint-collapsed", "blueprint-expanded"]) {
    for (const speed of [1, 4, 16]) {
      const view = config.startsWith("atlas") ? "atlas" : "blueprint";
      const { context, page, cdp } = await open(view);
      await sim(page, "seek", S(400));
      await sim(page, "select", "cell:LOCAL-031");
      await sleep(900);
      if (config === "atlas-fit") await page.evaluate(() => window.__atlasCamera.fit());
      if (config === "atlas-near-following") {
        await page.evaluate(() => window.__atlasCamera.zoomTo(2.0));
        await sim(page, "followLive");
        await sim(page, "setFollow", true);
      }
      if (config === "blueprint-collapsed") await blueprintCollapse(page);
      if (config === "blueprint-expanded") await blueprintExpandAll(page);
      await page.mouse.move(900, 20);
      await sleep(600);
      const before = view === "atlas" ? await atlasCounts(page) : null;
      await sim(page, "setSpeed", speed);
      const m = await measure(page, cdp, async () => {
        await sim(page, "play");
        if (config === "blueprint-expanded") {
          // Keep newly started agents expanded too.
          await sleep(3000);
          await blueprintExpandAll(page);
        }
      });
      const s = await page.evaluate(() => window.__machSim.state());
      result.scenarios.push({ config, speed, playheadFrom: 400, playheadTo: Math.round(s.playhead / 1000), ...m, atlasBefore: before, treeItems: view === "blueprint" ? await page.locator(`${ACTIVE} [role=treeitem]`).count() : undefined });
      log(label, config, `${speed}x`, `p95 ${m.p95} ms, max ${m.max} ms, ${m.over16_7} over 16.7`);
      await context.close();
    }
  }
  // Scrubbing quickly across the whole run (a real drag on the playhead strip, about 2 s), both views.
  for (const view of ["atlas", "blueprint"]) {
    const { context, page, cdp } = await open(view);
    await sim(page, "select", "cell:LOCAL-031");
    await sleep(800);
    const bar = await page.locator('[role=slider][aria-label="Playhead over the whole run"]').boundingBox();
    const y = bar.y + bar.height / 2;
    const m = await measure(
      page,
      cdp,
      async () => {
        await page.mouse.move(bar.x + 2, y);
        await page.mouse.down();
        for (let i = 1; i <= 120; i++) {
          await page.mouse.move(bar.x + 2 + ((bar.width - 4) * i) / 120, y);
          await sleep(16);
        }
        for (let i = 119; i >= 0; i--) {
          await page.mouse.move(bar.x + 2 + ((bar.width - 4) * i) / 120, y);
          await sleep(16);
        }
        await page.mouse.up();
      },
      5000,
    );
    result.scrub.push({ view, ...m });
    log(label, "scrub", view, `p95 ${m.p95}, max ${m.max}`);
    await context.close();
  }
  // The mode switch, many times both ways: six round trips at each of three moments, with a selection,
  // each measured over 1.2 s from the key press (the switch is 700 ms). Then a switch pressed 300 ms
  // after load, before the other view has been prepared; and the cut under reduced motion.
  {
    const { context, page, cdp } = await open("atlas");
    for (const [t, sel] of [
      [640, "cell:LOCAL-031"],
      [1660, "gate:LOCAL-031/verification#1"],
      [2852, "gate:LOCAL-032/human-approval"],
    ]) {
      await sim(page, "seek", S(t));
      await sim(page, "select", sel);
      await sleep(1000);
      for (let i = 0; i < 6; i++) {
        for (const key of ["2", "1"]) {
          await page.mouse.move(900, 20);
          const m = await measure(page, cdp, async () => page.keyboard.press(key), 1200);
          const raw = await page.evaluate(() => window.__perf.stamps.slice(1).map((x, i) => x - window.__perf.stamps[i]));
          result.modeSwitch.push({ at: t, n: i + 1, to: key === "2" ? "blueprint" : "atlas", ...m, intervals: raw.map((x) => Math.round(x * 10) / 10) });
          await sleep(400);
        }
      }
    }
    await context.close();
  }
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto(`${ORIGIN}/?theme=dark#atlas`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__machSim));
    await instrument(page);
    const mountedBefore = await page.evaluate(() => document.querySelectorAll("[data-stage-view]").length);
    await sleep(300 - 0);
    const m = await measure(page, cdp, async () => page.keyboard.press("2"), 1500);
    result.modeSwitchEarly ??= [];
    result.modeSwitchEarly.push({ reducedMotion, viewsMountedWhenPressed: mountedBefore, ...m });
    if (reducedMotion === "reduce") {
      // The cut, after preparation, a few times each way.
      await waitPrepared(page);
      await sleep(2500);
      for (let i = 0; i < 4; i++)
        for (const key of ["1", "2"]) {
          const c = await measure(page, cdp, async () => page.keyboard.press(key), 800);
          result.modeSwitchReduced ??= [];
          result.modeSwitchReduced.push({ to: key === "2" ? "blueprint" : "atlas", ...c });
        }
    }
    await context.close();
  }
  // Memory: the whole run at 16x, sampled at the start, the middle and the end (after a GC).
  {
    const { context, page, cdp } = await open("atlas");
    await sim(page, "select", "cell:LOCAL-031");
    await sim(page, "seek", 0);
    const sample = async (at) => {
      await cdp.send("HeapProfiler.collectGarbage");
      const m = await metrics(cdp);
      return { at, playhead: Math.round((await page.evaluate(() => window.__machSim.state().playhead)) / 1000), heapMB: Math.round((m.JSHeapUsedSize / 2 ** 20) * 10) / 10, nodes: m.Nodes, domElements: await page.evaluate(() => document.getElementsByTagName("*").length) };
    };
    const samples = [await sample("start")];
    await sim(page, "setSpeed", 16);
    await sim(page, "play");
    await page.waitForFunction(() => window.__machSim.state().playhead > 1675000, undefined, { timeout: 60000 });
    samples.push(await sample("mid"));
    await page.waitForFunction(() => !window.__machSim.state().playing, undefined, { timeout: 60000 });
    samples.push(await sample("end"));
    await sim(page, "setMode", "blueprint");
    await sleep(1500);
    samples.push(await sample("end, Blueprint"));
    result.memory = samples;
    await context.close();
  }
  // Atlas element counts at a range of zooms at 10:40 (as before), then across the WHOLE run: every
  // minute at far (0.5), the bottom of mid (0.6, the most of the plant drawn at mid detail) and the
  // fit, then every 5 s within a minute either side of each zoom's three highest minutes.
  if (label === "headless" || args.has("--counts-everywhere")) {
    const { context, page } = await open("atlas");
    await sim(page, "setFollow", false);
    await sim(page, "seek", S(640));
    await sleep(800);
    for (const zoom of [0.35, 0.5, 0.6, 0.74, 1.0, 1.4, 2.0]) {
      await page.evaluate((z) => window.__atlasCamera.zoomTo(z), zoom);
      await sleep(500);
      result.counts.push(await atlasCounts(page));
    }
    await page.evaluate(() => window.__atlasCamera.fit());
    await sleep(700);
    const fitZoom = (await atlasCounts(page)).zoom;
    const duration = await page.evaluate(() => window.__machSim.duration);
    const sweep = async (times) => {
      const rows = [];
      for (const t of times) {
        await sim(page, "seek", Math.min(duration, S(t)));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await sleep(60);
        rows.push({ t, ...(await atlasCounts(page)) });
      }
      return rows;
    };
    result.countsRun = {};
    for (const [name, zoom] of [
      ["far 0.5", 0.5],
      ["mid 0.6", 0.6],
      [`fit ${fitZoom}`, null],
    ]) {
      if (zoom) await page.evaluate((z) => window.__atlasCamera.zoomTo(z), zoom);
      else await page.evaluate(() => window.__atlasCamera.fit());
      await sleep(700);
      const minutes = [];
      for (let t = 0; t <= duration / 1000; t += 60) minutes.push(t);
      minutes.push(Math.floor(duration / 1000));
      const coarse = await sweep(minutes);
      const peaks = [...coarse].sort((a, b) => b.svgElements - a.svgElements).slice(0, 3).map((r) => r.t);
      const fine = [];
      for (const p of peaks) for (let t = Math.max(0, p - 60); t <= Math.min(duration / 1000, p + 60); t += 5) if (!minutes.includes(t)) fine.push(t);
      const detail = await sweep([...new Set(fine)].sort((a, b) => a - b));
      const all = [...coarse, ...detail];
      const max = all.reduce((m, r) => (r.svgElements > m.svgElements ? r : m), all[0]);
      const maxText = all.reduce((m, r) => (r.textElements > m.textElements ? r : m), all[0]);
      result.countsRun[name] = {
        lods: [...new Set(all.map((r) => r.lod))],
        samples: all.length,
        maxSvg: { t: max.t, svg: max.svgElements, lod: max.lod },
        maxText: { t: maxText.t, text: maxText.textElements },
        peaks,
        coarse: coarse.map((r) => [r.t, r.svgElements, r.textElements, r.lod]),
        detail: detail.map((r) => [r.t, r.svgElements, r.textElements, r.lod]),
      };
      log(label, "counts over the run", name, JSON.stringify(result.countsRun[name].maxSvg), "text", JSON.stringify(result.countsRun[name].maxText));
    }
    await context.close();
  }
  // Load: five cold loads.
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const mark = () => {
        if (document.querySelector("[data-view=atlas] svg")) requestAnimationFrame(() => (window.__atlasPainted = performance.now()));
        else requestAnimationFrame(mark);
      };
      requestAnimationFrame(mark);
    });
    await page.goto(`${ORIGIN}/?theme=dark#atlas`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__atlasPainted, undefined, { timeout: 20000 });
    result.load.push(
      await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
        const js = performance.getEntriesByType("resource").filter((r) => r.initiatorType === "script" || r.name.endsWith(".js"));
        const lastJs = Math.max(...js.map((r) => r.responseEnd));
        return { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), fcp: fcp && Math.round(fcp), lastScriptFetched: Math.round(lastJs), atlasPainted: Math.round(window.__atlasPainted), atlasAfterScripts: Math.round(window.__atlasPainted - lastJs) };
      }),
    );
    await context.close();
  }
  return result;
}

function bundleSizes(dir) {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const initial = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const files = readdirSync(join(dir, "assets")).filter((f) => /\.(js|css|woff2)$/.test(f));
  const size = (f) => {
    const buf = readFileSync(join(dir, "assets", f));
    return { file: f, kB: Math.round(buf.length / 102.4) / 10, gzipKB: /\.woff2$/.test(f) ? null : Math.round(gzipSync(buf).length / 102.4) / 10 };
  };
  const rows = files.map(size);
  const isInitial = (f) => initial.includes(`assets/${f}`);
  const sum = (list, k) => Math.round(list.reduce((s, r) => s + (r[k] ?? 0), 0) * 10) / 10;
  const initialJs = rows.filter((r) => r.file.endsWith(".js") && isInitial(r.file));
  const initialCss = rows.filter((r) => r.file.endsWith(".css") && isInitial(r.file));
  const lazy = rows.filter((r) => r.file.endsWith(".js") && !isInitial(r.file));
  const fonts = rows.filter((r) => r.file.endsWith(".woff2"));
  return {
    initialJs: { files: initialJs, kB: sum(initialJs, "kB"), gzipKB: sum(initialJs, "gzipKB") },
    initialCss: { files: initialCss, kB: sum(initialCss, "kB"), gzipKB: sum(initialCss, "gzipKB") },
    lazyJs: { count: lazy.length, kB: sum(lazy, "kB"), gzipKB: sum(lazy, "gzipKB"), largest: lazy.sort((a, b) => b.kB - a.kB).slice(0, 4) },
    fonts: { count: fonts.length, kB: sum(fonts, "kB") },
    totalKB: sum(rows, "kB"),
    distKB: Math.round(dirSize(dir) / 102.4) / 10,
  };
}
function dirSize(d) {
  return readdirSync(d).reduce((s, f) => {
    const p = join(d, f);
    const st = statSync(p);
    return s + (st.isDirectory() ? dirSize(p) : f.endsWith(".map") ? 0 : st.size);
  }, 0);
}

ensureBuild();
report.bundle = { capture: bundleSizes(dist) };
// The production build (no capture hook), built into a scratch directory for comparison.
{
  const prodDir = join(os.tmpdir(), "mach-m6-prod-dist");
  const run = spawnSync("pnpm", ["exec", "vite", "build", "--outDir", prodDir, "--emptyOutDir"], { cwd: app, stdio: ["ignore", "ignore", "inherit"] });
  if (run.status === 0) report.bundle.production = bundleSizes(prodDir);
}
const server = await startPreview();
try {
  const modes = [];
  if (!args.has("--headless-only")) modes.push(["headed", { headless: false, args: ["--ignore-gpu-blocklist", "--window-size=1920,1180"] }]);
  modes.push(["headless", { headless: true }]);
  for (const [label, options] of modes) {
    let browser;
    try {
      browser = await chromium.launch(options);
    } catch (e) {
      report.browsers[label] = { error: String(e).slice(0, 400) };
      continue;
    }
    try {
      report.browsers[label] = { launch: options, version: browser.version(), ...(await scenarios(browser, label)) };
    } finally {
      await browser.close();
    }
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  }
} finally {
  server.stop();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
for (const [label, b] of Object.entries(report.browsers)) {
  if (b.error) {
    console.log(label, b.error);
    continue;
  }
  console.log(`\n${label}: ${b.version}, ${b.gpu?.renderer}, refresh ~${b.refresh} Hz`);
  for (const s of b.scenarios) console.log(`  ${s.config.padEnd(22)} ${String(s.speed).padStart(2)}x  p50 ${s.p50}  p95 ${s.p95}  p99 ${s.p99}  max ${s.max}  >16.7 ${s.over16_7}  >33 ${s.over33}  script/frame ${s.perFrameMs.script}  layout ${s.perFrameMs.layout}  style ${s.perFrameMs.style}  long tasks ${s.longTasks.count}`);
  for (const s of b.scrub) console.log(`  scrub ${s.view.padEnd(10)} p95 ${s.p95} max ${s.max} >16.7 ${s.over16_7} script/frame ${s.perFrameMs.script}`);
  for (const s of b.modeSwitch) console.log(`  switch at ${s.at} #${s.n} to ${s.to.padEnd(10)} max ${s.max} p95 ${s.p95} >24: ${s.intervals.filter((x) => x > 24).length}`);
  for (const s of b.modeSwitchEarly ?? []) console.log(`  early switch (${s.reducedMotion}, views mounted ${s.viewsMountedWhenPressed}) max ${s.max} p95 ${s.p95}`);
  for (const s of b.modeSwitchReduced ?? []) console.log(`  reduced cut to ${s.to} max ${s.max}`);
  console.log("  memory", JSON.stringify(b.memory));
  console.log("  load", JSON.stringify(b.load));
}
console.log(JSON.stringify(report.bundle, null, 1).slice(0, 3000));

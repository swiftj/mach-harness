// M6.3 Timeline performance harness (docs/mach-next/M6_3_PERFORMANCE.md; budget: M6_3_DESIGN.md
// section 8). Opens the Timeline workspace (#timeline) on real data and measures:
//
//   load          navigation -> first tracks painted ([data-timeline-ready] on the workspace root, plus a frame)
//   panZoom       frame times while panning (horizontal wheel), zooming (Ctrl+wheel) and dragging the tracks
//   scrub         playhead move -> next frame, while dragging the Timeline's playhead slider
//   expand        a track's expand/collapse button -> second frame after aria-expanded flips
//   heap          JS heap after a forced GC on the Factory Floor alone, then with the Timeline up
//   switch        key 3 (floor -> Timeline, until ready) and key 1 (Timeline -> floor), both ways
//   liveEdge      frames while a second process appends events (mach-synth --append; real observer only)
//
// Modes:
//   node scripts/timeline-measure.mjs --project <generated dir> --observer-bin <mach-observer>
//       starts the observer on the project (catch-up time measured), measures, stops it
//   node scripts/timeline-measure.mjs --observer-url <one-time link> [--project <dir>]
//       an observer already running; --project enables the live-edge step
//   node scripts/timeline-measure.mjs --fixture
//       the capture build with no observer: the simulation's own spans (until the app offers a hook
//       for the 60,000-span fixture, test/fixtures/timeline.mjs)
// Options: --out <dir> (default screenshots/_perf/timeline), --headed, --runs <n> (cold loads, 3),
//   --append-rate <events/s> (200), --append-seconds <s> (15), --synth-bin <path> (else `go run`), --rebuild.
//
// Each step that the UI cannot support yet reports "not measurable yet: <why>"; the run never fails on it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  app,
  distribution,
  ensureBuild,
  heapAfterGc,
  instrument,
  keyToCondition,
  keyToMutation,
  machineFacts,
  NotYet,
  observerGet,
  observerSession,
  parseArgs,
  recordWhile,
  SEL,
  serveApp,
  sleep,
  startAppender,
  startObserver,
  step,
  synthSummary,
  waitCaughtUp,
} from "./timeline-lib.mjs";

const args = parseArgs();
const BUDGET = { loadMs: 1500, frameMedianMs: 16, frameP95Ms: 33, scrubMedianMs: 100, expandMs: 50, heapDeltaMB: 60, switchMs: 300 };
const outDir = resolve(args.out ?? join(app, "screenshots", "_perf", "timeline"));
mkdirSync(outDir, { recursive: true });
const mode = args.fixture ? "fixture" : args["observer-url"] ? "observer-url" : args.project && args["observer-bin"] ? "observer-started" : null;
if (!mode) {
  console.error("usage: --project <dir> --observer-bin <path> | --observer-url <link> [--project <dir>] | --fixture   (see the header of this file)");
  process.exit(2);
}
const project = args.project ? resolve(args.project) : null;
const report = { generated: new Date().toISOString(), mode, budget: BUDGET, machine: machineFacts(), workload: project ? synthSummary(project) : null, observer: null, browser: null, steps: {} };
const cleanups = [];

ensureBuild();
let base;
let session = null;
if (mode === "fixture") {
  const server = await serveApp();
  cleanups.push(server.stop);
  base = server.origin;
} else {
  let link = args["observer-url"];
  if (mode === "observer-started") {
    const ob = await startObserver({ bin: resolve(args["observer-bin"]), project });
    cleanups.push(ob.stop);
    link = ob.link;
    session = await observerSession(link);
    const health = await waitCaughtUp(session);
    report.observer = { catchUpMs: Date.now() - ob.started };
    report.observer.health = healthFacts(health);
  } else {
    session = await observerSession(link);
    report.observer = { health: healthFacts(await observerGet(session, "/api/v1/health")) };
  }
  report.observer.servesApp = session.embedsApp;
  if (session.embedsApp) base = session.origin;
  else {
    // Built without the Control Tower (make host, go build): serve this checkout's capture build and proxy the API.
    const server = await serveApp({ observer: session });
    cleanups.push(server.stop);
    base = server.origin;
  }
}
const search = mode === "fixture" ? "?simulation&theme=dark" : "?theme=dark";

function healthFacts(h) {
  return {
    observer: h.observer,
    events: Number(String(h.index?.head ?? "").split(".").pop()) || null,
    projected: h.projection?.applied ?? null,
    gaps: h.projection?.history?.gaps ?? null,
    completeness: h.projection?.history?.completeness ?? null,
    runtime: h.ingest?.runtime?.state ?? null,
    refused: (h.ingest?.runtime?.versions ?? []).reduce((s, v) => s + (v.records_refused ?? 0), 0),
    late: h.ingest?.late ?? null,
  };
}

const browser = await chromium.launch({ headless: !args.headed, args: args.headed ? ["--ignore-gpu-blocklist"] : [] });
cleanups.unshift(() => browser.close());

async function open(hash = "timeline", { init } = {}) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", bypassCSP: true });
  if (session?.embedsApp) await context.addCookies(session.cookies);
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(`${base}/${search}#${hash}`, { waitUntil: "load" });
  await instrument(page);
  return { context, page, cdp };
}

async function waitReady(page, ms = 60000) {
  try {
    await page.waitForSelector(SEL.ready, { timeout: ms, state: "attached" });
  } catch {
    const has = await page.$(SEL.workspace);
    throw new NotYet(has ? `the Timeline workspace never set data-timeline-ready within ${ms / 1000} s` : "no Timeline workspace ([data-timeline-workspace]) at #timeline");
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function canvasBox(page) {
  const boxes = await page.$$eval(SEL.canvas, (els) => els.map((e) => ({ ...e.getBoundingClientRect().toJSON() })).filter((b) => b.width > 200 && b.height > 100));
  if (!boxes.length) throw new NotYet("no track canvas in the Timeline workspace");
  return boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

try {
  {
    const { context, page } = await open("timeline");
    report.browser = {
      version: browser.version(),
      headless: !args.headed,
      gpu: await page.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : "no WebGL";
      }),
      refreshHz: await page.evaluate(
        () =>
          new Promise((done) => {
            const t = [];
            const f = (x) => (t.push(x), t.length < 61 ? requestAnimationFrame(f) : done(Math.round((1000 * 60) / (t[60] - t[0]))));
            requestAnimationFrame(f);
          }),
      ),
    };
    await context.close();
  }

  await step(report, "load", async () => {
    const runs = [];
    for (let i = 0; i < Number(args.runs ?? 3); i++) {
      const { context, page } = await open("timeline", {
        init: () => {
          const w = window;
          const look = () => {
            if (w.__tlMount === undefined && document.querySelector("[data-workspace]")) w.__tlMount = performance.now();
            if (document.querySelector("[data-timeline-workspace][data-timeline-ready]")) requestAnimationFrame((t) => (w.__tlReady = t));
            else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        },
      });
      try {
        await page.waitForFunction(() => window.__tlReady !== undefined, undefined, { timeout: 60000 });
      } catch {
        await context.close();
        throw new NotYet("[data-timeline-ready] never appeared on the Timeline workspace root");
      }
      runs.push(
        await page.evaluate(() => ({
          navToReadyMs: Math.round(window.__tlReady),
          mountToReadyMs: Math.round(window.__tlReady - (window.__tlMount ?? 0)),
          domContentLoadedMs: Math.round(performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd),
          spans: Number(document.querySelector("[data-timeline-workspace]")?.getAttribute("data-timeline-spans") ?? NaN),
        })),
      );
      await context.close();
    }
    return { runs, navToReadyMs: distribution(runs.map((r) => r.navToReadyMs)), mountToReadyMs: distribution(runs.map((r) => r.mountToReadyMs)) };
  });

  await step(report, "panZoom", async () => {
    const { context, page, cdp } = await open("timeline");
    try {
      await waitReady(page);
      await sleep(1500);
      const box = await canvasBox(page);
      const cx = box.x + box.width / 2;
      const cy = box.y + Math.min(box.height / 2, 300);
      await page.mouse.move(cx, cy);
      const pan = await recordWhile(page, cdp, async () => {
        for (let i = 0; i < 90; i++) {
          await page.mouse.wheel(i < 45 ? 80 : -80, 0);
          await sleep(16);
        }
      });
      const zoom = await recordWhile(page, cdp, async () => {
        await page.keyboard.down("Control");
        for (let i = 0; i < 60; i++) {
          await page.mouse.wheel(0, i < 30 ? -60 : 60);
          await sleep(16);
        }
        await page.keyboard.up("Control");
      });
      const drag = await recordWhile(page, cdp, async () => {
        await page.mouse.move(cx + 200, cy);
        await page.mouse.down();
        for (let i = 0; i <= 60; i++) {
          await page.mouse.move(cx + 200 - (400 * i) / 60, cy);
          await sleep(16);
        }
        await page.mouse.up();
      });
      const rows = await recordWhile(page, cdp, async () => {
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, i < 20 ? 120 : -120);
          await sleep(16);
        }
      });
      return { pan, zoom, drag, rowScroll: rows };
    } finally {
      await context.close();
    }
  });

  await step(report, "scrub", async () => {
    const { context, page, cdp } = await open("timeline");
    try {
      await waitReady(page);
      await sleep(1000);
      const sliders = await page.$$(SEL.playheadAnywhere);
      let target = null;
      for (const el of sliders) {
        const label = (await el.getAttribute("aria-label")) ?? "";
        const b = await el.boundingBox();
        if (/playhead/i.test(label) && b && b.width > 100) target = { b, label };
      }
      if (!target) {
        // No playhead slider: scrub with the playback keys (previous / next event, back / forward 10 s)
        // and time each key to the frame after the workspace changed.
        const times = [];
        for (let i = 0; i < 40; i++) {
          const key = ["Shift+Comma", "Comma", "Shift+Period", "Period"][i % 4];
          const t = await keyToMutation(page, key, SEL.workspace);
          if (t !== null) times.push(t);
          await sleep(60);
        }
        if (times.length < 10) throw new NotYet(`no playhead slider, and the playback keys moved nothing in the Timeline workspace (${times.length} of 40)`);
        return { method: "playback keys , . Shift+, Shift+. -> frame after the workspace changed", answered: `${times.length} of 40`, scrubResponseMs: distribution(times) };
      }
      const { b } = target;
      const y = b.y + b.height / 2;
      const m = await recordWhile(page, cdp, async () => {
        await page.mouse.move(b.x + 4, y);
        await page.mouse.down();
        for (let i = 1; i <= 90; i++) {
          await page.mouse.move(b.x + 4 + ((b.width - 8) * i) / 90, y);
          await sleep(20);
        }
        await page.mouse.up();
      });
      return { method: `drag on the slider "${target.label}"`, ...m, scrubResponseMs: m.inputToFrameMs };
    } finally {
      await context.close();
    }
  });

  await step(report, "expand", async () => {
    const { context, page } = await open("timeline");
    try {
      await waitReady(page);
      await sleep(1000);
      const n = await page.$$eval(SEL.toggle, (els) => els.length);
      if (!n) throw new NotYet("no expand/collapse buttons (button[aria-expanded]) in the Timeline's label column");
      const times = { expand: [], collapse: [] };
      for (let j = 0; j < Math.min(16, n * 2); j++) {
        const i = j >> 1; // each button twice: open then close (or the reverse)
        const t = await page.evaluate(
          ([sel, i]) =>
            new Promise((resolve) => {
              const el = document.querySelectorAll(sel)[i];
              if (!el) return resolve(null);
              const was = el.getAttribute("aria-expanded");
              const t0 = performance.now();
              el.click();
              const wait = () => {
                const now = document.querySelectorAll(sel)[i];
                const flipped = !el.isConnected || el.getAttribute("aria-expanded") !== was || now !== el;
                if (flipped || performance.now() - t0 > 2000) requestAnimationFrame(() => setTimeout(() => resolve({ was, ms: performance.now() - t0 })));
                else requestAnimationFrame(wait);
              };
              wait();
            }),
          [SEL.toggle, i],
        );
        if (t) times[t.was === "true" ? "collapse" : "expand"].push(t.ms);
        await sleep(150);
      }
      return { expandMs: distribution(times.expand), collapseMs: distribution(times.collapse), note: "click -> end of the first frame painted after aria-expanded flips" };
    } finally {
      await context.close();
    }
  });

  await step(report, "heap", async () => {
    const { context, page, cdp } = await open("atlas");
    try {
      await sleep(4000);
      const floor = await heapAfterGc(cdp);
      await page.keyboard.press("3");
      await waitReady(page);
      await sleep(3000);
      const timeline = await heapAfterGc(cdp);
      return { floorAlone: floor, withTimeline: timeline, deltaMB: Math.round((timeline.heapMB - floor.heapMB) * 10) / 10 };
    } finally {
      await context.close();
    }
  });

  await step(report, "switch", async () => {
    const { context, page } = await open("atlas");
    try {
      await sleep(3000);
      const toTimeline = [];
      const toFloor = [];
      const ready = `document.querySelector('${SEL.ready}') !== null`;
      const floor = `document.querySelector('${SEL.workspace}') === null && document.querySelector('${SEL.floor}')?.style.visibility === 'visible'`;
      for (let i = 0; i < 5; i++) {
        await page.mouse.move(960, 20);
        toTimeline.push(await keyToCondition(page, "3", ready).catch((e) => {
          throw new NotYet(`key 3 did not bring up a ready Timeline: ${e.message}`);
        }));
        await sleep(800);
        toFloor.push(await keyToCondition(page, "1", floor));
        await sleep(800);
      }
      return { toTimelineMs: distribution(toTimeline), toFloorMs: distribution(toFloor), note: "key down -> end of the first frame painted after the target workspace is ready" };
    } finally {
      await context.close();
    }
  });

  await step(report, "liveEdge", async () => {
    if (!project || mode === "fixture") throw new NotYet("needs a real observer over a generated project (--project), so events can be appended");
    const seconds = Number(args["append-seconds"] ?? 15);
    const rate = Number(args["append-rate"] ?? 200);
    const { context, page, cdp } = await open("timeline");
    try {
      await waitReady(page);
      await sleep(1500);
      const spansBefore = await page.$eval(SEL.workspace, (e) => Number(e.getAttribute("data-timeline-spans")));
      const appender = startAppender({ project, rate, seconds, synthBin: args["synth-bin"] });
      const quiet = await recordWhile(page, cdp, async () => {}, 3000); // a baseline while nothing arrives yet (go run compiles first)
      let changes = 0;
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        window.__tlChanges = 0;
        new MutationObserver(() => window.__tlChanges++).observe(el, { attributes: true, attributeFilter: ["data-timeline-spans"] });
      }, SEL.workspace);
      const live = await recordWhile(page, cdp, async () => {
        await appender.done;
      });
      changes = await page.evaluate(() => window.__tlChanges);
      const { out } = await appender.done;
      let appended = null;
      try {
        appended = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        appended = { output: out.slice(0, 400) };
      }
      const spansAfter = await page.$eval(SEL.workspace, (e) => Number(e.getAttribute("data-timeline-spans")));
      return { rate, seconds, appended: { events: appended.events, rate: appended.rate_achieved, late: appended.late_lines, arrivalOnly: appended.arrival_only_records }, baseline: quiet, whileAppending: live, spanCountChanges: changes, spansBefore, spansAfter };
    } finally {
      await context.close();
    }
  });
} finally {
  for (const stop of cleanups) await stop();
}

const file = join(outDir, `timeline-perf-${report.generated.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
writeFileSync(join(outDir, "latest.json"), JSON.stringify(report, null, 2));

// The short table: each budget line, what was measured, and whether it is inside the budget.
const s = report.steps;
const val = (st, f) => (st?.status === "measured" ? f(st) : null);
const rows = [
  ["first tracks painted (navigation -> ready, median)", val(s.load, (x) => x.navToReadyMs.median), BUDGET.loadMs, "ms"],
  ["  (app mounted -> ready, median)", val(s.load, (x) => x.mountToReadyMs.median), BUDGET.loadMs, "ms"],
  ["pan frame, median / p95 (work per frame)", val(s.panZoom, (x) => `${x.pan.frameMs.median} / ${x.pan.frameMs.p95} (${x.pan.taskMsPerFrame})`), `${BUDGET.frameMedianMs} / ${BUDGET.frameP95Ms}`, "ms"],
  ["zoom frame, median / p95 (work per frame)", val(s.panZoom, (x) => `${x.zoom.frameMs.median} / ${x.zoom.frameMs.p95} (${x.zoom.taskMsPerFrame})`), `${BUDGET.frameMedianMs} / ${BUDGET.frameP95Ms}`, "ms"],
  ["drag frame, median / p95 (work per frame)", val(s.panZoom, (x) => `${x.drag.frameMs.median} / ${x.drag.frameMs.p95} (${x.drag.taskMsPerFrame})`), `${BUDGET.frameMedianMs} / ${BUDGET.frameP95Ms}`, "ms"],
  ["pan + zoom long tasks", val(s.panZoom, (x) => x.pan.longTasks.count + x.zoom.longTasks.count + x.drag.longTasks.count), 0, ""],
  ["scrub response, median", val(s.scrub, (x) => x.scrubResponseMs.median), BUDGET.scrubMedianMs, "ms"],
  ["expand / collapse, median", val(s.expand, (x) => `${x.expandMs.median} / ${x.collapseMs.median}`), BUDGET.expandMs, "ms"],
  ["heap: Timeline over the floor", val(s.heap, (x) => x.deltaMB), BUDGET.heapDeltaMB, "MB"],
  ["switch floor -> Timeline / back, median", val(s.switch, (x) => `${x.toTimelineMs.median} / ${x.toFloorMs.median}`), BUDGET.switchMs, "ms"],
  ["live edge: frame median / p95 (work) while appending", val(s.liveEdge, (x) => `${x.whileAppending.frameMs.median} / ${x.whileAppending.frameMs.p95} (${x.whileAppending.taskMsPerFrame})`), `${BUDGET.frameMedianMs} / ${BUDGET.frameP95Ms}`, "ms"],
];
console.log(`\nTimeline performance (${mode}${report.observer?.catchUpMs ? `, observer caught up in ${(report.observer.catchUpMs / 1000).toFixed(1)} s` : ""}; ${report.browser?.version}, ${report.browser?.gpu})`);
for (const [name, v, budget, unit] of rows) console.log(`  ${name.padEnd(52)} ${String(v ?? "-").padStart(20)}  budget ${budget} ${unit}`);
for (const [name, st] of Object.entries(s)) if (st.status !== "measured") console.log(`  ${name}: not measurable yet: ${st.why}`);
console.log(`\nwritten ${file}`);

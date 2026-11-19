// The Factory Floor shots. One command: `node capture/floor/shots.mjs [shot ...]` from video/
// (no argument records all six). Each shot is deterministic up to real-time jitter: the app's
// Simulation runs on the browser clock at its own 10x rate (nothing is stepped or injected); a shot
// only chooses where in the run to start (window.__machSim.seek, a capture-build hook).
import { serve, launch, sleep, root, footage, startRecording, wheel } from "./lib.mjs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const FPS = 30;
const LINE = { w: 1440, h: 810, dsf: 4 / 3 };
const open = async (s, hash, { w = 1440, h = 810, dsf = 4 / 3, t, cursor = true, theater = false } = {}) => {
  const { browser, context } = await launch({ width: w, height: h, dsf });
  const page = await context.newPage();
  await page.goto(`${s.origin}/?simulation&theme=dark#${hash}`);
  await page.waitForFunction(() => window.__machSim);
  await page.evaluate(() => document.fonts.ready);
  if (theater) await page.evaluate(() => window.__machSim.setTheater(true));
  if (t != null) await page.evaluate((t) => window.__machSim.seek(t * 1000), t);
  await sleep(600);
  const rec = await startRecording(page, { cursor, fps: FPS });
  return { browser, page, rec };
};
const finish = async (name, rec, browser) => {
  const info = await rec.stop(join(footage, `${name}.mp4`));
  await browser.close();
  console.log(name, info);
};

export const shots = {
  // 1. The Line with the clock running; a ticket opened midway.
  async "floor-line"(s) {
    const { browser, rec } = await open(s, "line", { t: 1440 });
    await rec.begin();
    await sleep(12000);
    await rec.click('[data-line-row="132"] [data-row-button]');
    await sleep(11000);
    await finish("floor-line", rec, browser);
  },

  // 2. A station header opened: its worker, the models recorded there, the typical time.
  async "floor-station"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 2000 });
    await page.locator('[data-line-row="134"] [data-row-button]').click(); // starts on a ticket panel, not the run feed
    await sleep(500);
    await rec.begin();
    await sleep(1500);
    await rec.click('[data-station-heading="build"]', { dx: 0.85, dy: 0.8 });
    await sleep(5500);
    await finish("floor-station", rec, browser);
  },

  // 3. A ticket's full record, scrolled station by station, then the evidence player.
  async "floor-record"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 3000, w: 1280, h: 720, dsf: 1.5 });
    await rec.begin();
    await sleep(800);
    await rec.dblclick('[data-line-row="132"] [data-row-button]');
    await sleep(1000);
    const b = await page.locator("[data-line-record]").boundingBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    await rec.move(cx, cy, 700);
    await wheel(page, cx, cy, 260, 2800);
    await sleep(400);
    await rec.click("[data-line-record] [data-open-evidence] >> nth=1", { ms: 1100 });
    await sleep(1000);
    await rec.click('[data-evidence-check="AC-02"] >> nth=0', { ms: 900 });
    await sleep(900);
    await rec.click("[data-evidence-file] >> nth=0", { ms: 700 });
    await sleep(2200);
    await finish("floor-record", rec, browser);
  },

  // 4. Analytics: scroll Pulse, move to Flow and bottlenecks, hover a chart.
  async "floor-analytics"(s) {
    const { browser, page, rec } = await open(s, "analytics", { w: 1280, h: 720, dsf: 1.5 });
    await rec.begin();
    await sleep(700);
    await rec.move(760, 420, 400);
    await wheel(page, 760, 420, 460, 2600);
    await sleep(300);
    await rec.click("text=Flow and bottlenecks", { ms: 800 });
    await sleep(500);
    await wheel(page, 760, 420, 190, 1600);
    await sleep(200);
    await rec.hover('g.an-mark[aria-label^="Build 27"]', { ms: 900 });
    await sleep(1300);
    await finish("floor-analytics", rec, browser);
  },

  // 5. The Atlas in Theater Mode, several cells working, a slow push-in. No cursor.
  async "floor-atlas"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 1470, cursor: false, theater: true });
    await page.evaluate(() => window.__machSim.setFollow(false));
    await sleep(800);
    await page.evaluate(() => window.__atlasCamera.fit());
    await sleep(1200);
    await rec.begin();
    await sleep(1500);
    await page.evaluate(
      () =>
        new Promise((done) => {
          const cam = window.__atlasCamera, c0 = cam.get(), t0 = performance.now(), D = 17000;
          const vw = innerWidth, vh = innerHeight;
          const W = { x: (vw * 0.5 - c0.x) / c0.zoom, y: (vh * 0.42 - c0.y) / c0.zoom };
          const from = { x: W.x * c0.zoom + c0.x, y: W.y * c0.zoom + c0.y }, to = { x: vw * 0.5, y: vh * 0.5 };
          const z1 = c0.zoom * 1.45;
          const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
          const tick = () => {
            const t = Math.min(1, (performance.now() - t0) / D), k = ease(t);
            const z = c0.zoom + (z1 - c0.zoom) * k;
            const sx = from.x + (to.x - from.x) * k, sy = from.y + (to.y - from.y) * k;
            cam.set({ zoom: z, x: sx - W.x * z, y: sy - W.y * z });
            t < 1 ? requestAnimationFrame(tick) : done();
          };
          requestAnimationFrame(tick);
        }),
    );
    await sleep(1500);
    await finish("floor-atlas", rec, browser);
  },

  // 6. A ticket waiting for a person, picked from the Needs you strip.
  async "floor-needs-you"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 2830 });
    await page.locator('[data-line-row="134"] [data-row-button]').click(); // starts on a ticket panel, not the run feed
    await sleep(500);
    await rec.begin();
    await sleep(2000);
    await rec.click('[data-need="132"]', { ms: 1100 });
    await sleep(4800);
    await finish("floor-needs-you", rec, browser);
  },
};

const want = process.argv.slice(2);
const s = await serve();
try {
  for (const [name, fn] of Object.entries(shots)) if (!want.length || want.includes(name)) await fn(s);
} finally {
  await s.stop();
}

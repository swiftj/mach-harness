// Light-theme Factory Floor shots (second film). Same plumbing as shots.mjs (lib.mjs), light theme via the
// app's own `?theme=light` preference (what the top bar's Light button sets). Output: public/footage/light-*.mp4
// `node capture/floor/shots-light.mjs [name ...]` from video/. Nothing is injected: the Simulation runs on
// the browser clock; a shot only chooses where in the run to start (window.__machSim.seek).
import { serve, sleep, footage, startRecording, wheel, FFMPEG } from "./lib.mjs";
import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { chromium } from "playwright";
import { join } from "node:path";

const FPS = 30;
const open = async (s, hash, { t, cursor = true, theater = false, follow = null, fit = false } = {}) => {
  const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "light", reducedMotion: "no-preference" });
  const page = await context.newPage();
  await page.goto(`${s.origin}/?simulation&theme=light#${hash}`);
  await page.waitForFunction(() => window.__machSim);
  await page.evaluate(() => document.fonts.ready);
  if (theater) await page.evaluate(() => window.__machSim.setTheater(true));
  if (follow != null) await page.evaluate((f) => window.__machSim.setFollow(f), follow);
  await sleep(400);
  if (fit) { await page.evaluate(() => window.__atlasCamera.fit()); await sleep(1200); }
  // The Simulation runs on the browser clock, so seek last: the clip then starts at exactly t.
  if (t != null) await page.evaluate((t) => window.__machSim.seek(t * 1000), t);
  await sleep(fit ? 150 : 600);
  const rec = await startRecording(page, { cursor, fps: FPS });
  return { browser, page, rec };
};
const finish = async (name, rec, browser, page) => {
  // The "Simulation" label must be on screen in every clip.
  const stamp = await page.evaluate(() => [...document.querySelectorAll("[data-simulation-stamp]")].some((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden"));
  if (!stamp) console.warn("WARNING: Simulation label not visible in", name);
  const out = join(footage, `${name}.mp4`);
  const info = await rec.stop(out);
  // lib's concat leaves the last frame's hold counted twice; cut the file to the recorded span.
  const tmp = out + ".trim.mp4";
  execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-i", out, "-t", info.seconds.toFixed(3), "-c", "copy", "-movflags", "+faststart", tmp]);
  renameSync(tmp, out);
  await browser.close();
  console.log(name, info);
};

/** Tween the Atlas camera: zoom multiplied by `mul`, the point under `from` (a data-ref, or null = stage centre) ends at `to` (fractions of the stage). */
const camTween = (page, { mul = 1.3, ref = null, to = [0.5, 0.5], ms = 6000, delay = 0 }) =>
  page.evaluate(
    ({ mul, ref, to, ms, delay }) =>
      new Promise((done) => {
        const cam = window.__atlasCamera, c0 = cam.get();
        const st = document.querySelector("[data-stage-active] [data-view=atlas]").getBoundingClientRect();
        let s0 = { x: st.width / 2, y: st.height / 2 };
        if (ref) {
          const els = [...document.querySelectorAll(`[data-stage-active] [data-ref="${CSS.escape(ref)}"]`)].map((e) => e.getBoundingClientRect()).filter((r) => r.width);
          const x0 = Math.min(...els.map((r) => r.left)), x1 = Math.max(...els.map((r) => r.right)), y0 = Math.min(...els.map((r) => r.top)), y1 = Math.max(...els.map((r) => r.bottom));
          s0 = { x: (x0 + x1) / 2 - st.left, y: (y0 + y1) / 2 - st.top };
        }
        const W = { x: (s0.x - c0.x) / c0.zoom, y: (s0.y - c0.y) / c0.zoom };
        const s1 = { x: st.width * to[0], y: st.height * to[1] };
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        setTimeout(() => {
          const t0 = performance.now();
          const tick = () => {
            const t = Math.min(1, (performance.now() - t0) / ms), k = ease(t);
            const z = c0.zoom * (1 + (mul - 1) * k);
            const sx = s0.x + (s1.x - s0.x) * k, sy = s0.y + (s1.y - s0.y) * k;
            cam.set({ zoom: z, x: sx - W.x * z, y: sy - W.y * z });
            t < 1 ? requestAnimationFrame(tick) : done();
          };
          requestAnimationFrame(tick);
        }, delay);
      }),
    { mul, ref, to, ms, delay },
  );
const bg = (p) => { p.catch((e) => console.error("tween", e.message)); return p; };
const rowOpen = async (page, n) => { await page.locator(`[data-line-row="${n}"] [data-row-button]`).click(); await sleep(500); };

export const shots = {
  // 1. Whole plant, several cells working, slow push-in, Theater Mode, no cursor.
  async "light-atlas-wide"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 1470, cursor: false, theater: true, follow: false, fit: true });
    await rec.begin();
    const tw = bg(camTween(page, { mul: 1.12, to: [0.5, 0.5], ms: 17000 }));
    await sleep(18000);
    await tw;
    await finish("light-atlas-wide", rec, browser, page);
  },

  // 2. The start of the run: slices arrive at intake, cells start. No cursor.
  async "light-atlas-arrive"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 0, cursor: false, theater: true, follow: false, fit: true });
    await rec.begin();
    const tw = bg(camTween(page, { mul: 1.3, ref: "station:intake", to: [0.4, 0.45], ms: 11000 }));
    await sleep(12000);
    await tw;
    await finish("light-atlas-arrive", rec, browser, page);
  },

  // 3. Closer on a working cell, click it, the inspector opens.
  async "light-atlas-cell"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 1180, cursor: true, follow: false, fit: true });
    await rec.begin();
    const tw = bg(camTween(page, { mul: 2.1, ref: "cell:132", to: [0.5, 0.5], ms: 4500 }));
    await sleep(5200);
    await tw;
    await rec.click('[data-stage-active] [data-ref="cell:132"] >> nth=0', { ms: 1000 });
    await sleep(7500);
    await finish("light-atlas-cell", rec, browser, page);
  },

  // 4. Review chamber: select the review gate, votes in the inspector.
  async "light-atlas-review"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 1585, cursor: true, follow: false, fit: true });
    await rec.begin();
    const tw = bg(camTween(page, { mul: 2.0, ref: "gate:133/review#1", to: [0.5, 0.5], ms: 4000 }));
    await sleep(4500);
    await tw;
    await rec.click('[data-stage-active] [data-ref="gate:133/review#1"] >> nth=0', { ms: 900 });
    await sleep(6000);
    await finish("light-atlas-review", rec, browser, page);
  },

  // 5. Verification fails on 131 and the ticket goes back to build.
  async "light-atlas-verify"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 1640, cursor: true, follow: false, fit: true });
    await rec.begin();
    const tw = bg(camTween(page, { mul: 2.0, ref: "cell:131", to: [0.5, 0.5], ms: 3500 }));
    await sleep(4000);
    await tw;
    await rec.click('[data-stage-active] [data-ref="gate:131/verification#1"] >> nth=0', { ms: 900 });
    await sleep(5000);
    await finish("light-atlas-verify", rec, browser, page);
  },

  // 6. Floor to Line through the top bar.
  async "light-switch"(s) {
    const { browser, page, rec } = await open(s, "floor", { t: 1470, cursor: true, follow: false, fit: true });
    await rec.begin();
    await sleep(2300);
    await rec.click("[data-workspace-switch] label:has-text('Line')", { ms: 1100 });
    await sleep(4400);
    await finish("light-switch", rec, browser, page);
  },

  // 7. The Line, clock running; a ticket opened at ~10 s.
  async "light-line"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 1440 });
    await rowOpen(page, 134); // start on a ticket panel: the run feed lists moments past the Simulation's clock
    await rec.begin();
    await sleep(9500);
    await rec.click('[data-line-row="132"] [data-row-button]', { ms: 1100 });
    await sleep(12000);
    await finish("light-line", rec, browser, page);
  },

  // 8. A station header opened.
  async "light-line-review"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 1900 });
    await rowOpen(page, 134);
    await rec.begin();
    await sleep(1500);
    await rec.click('[data-station-heading="review"]', { dx: 0.85, dy: 0.8 });
    await sleep(5500);
    await finish("light-line-review", rec, browser, page);
  },

  // 9. Needs you.
  async "light-needs-you"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 2830 });
    await rowOpen(page, 134);
    await rec.begin();
    await sleep(2000);
    await rec.click('[data-need="132"]', { ms: 1100 });
    await sleep(5000);
    await finish("light-needs-you", rec, browser, page);
  },

  // 10. A ticket's full record, then the evidence player.
  async "light-record"(s) {
    const { browser, page, rec } = await open(s, "line", { t: 3000 });
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
    await finish("light-record", rec, browser, page);
  },
};

const want = process.argv.slice(2);
const s = await serve();
try {
  for (const [name, fn] of Object.entries(shots)) if (!want.length || want.includes(name)) await fn(s);
} finally {
  await s.stop();
}

// Shared plumbing for the Factory Floor captures: static server (127.0.0.1 only) over a scratch
// capture build, a browser context that records video, and helpers. Nothing here touches the app.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..", "..");
export const dist = join(root, "capture", "raw", "floor-dist");
export const footage = join(root, "public", "footage");
export const FFMPEG = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

export function buildApp() {
  const app = resolve(root, "..", "web", "apps", "factory-floor");
  const r = spawnSync("pnpm", ["exec", "vite", "build", "--mode", "capture", "--outDir", dist, "--emptyOutDir"], { cwd: app, stdio: "ignore" });
  if (r.status !== 0) throw new Error("capture build failed");
}

export async function serve() {
  if (!existsSync(join(dist, "index.html"))) buildApp();
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = join(dist, p);
    if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, "index.html");
    res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { origin: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((ok) => server.close(ok)) };
}

export async function launch({ width = 1280, height = 720, dsf = 1.5, videoDir } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dsf, colorScheme: "dark", reducedMotion: "no-preference",
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } } } : {}),
  });
  return { browser, context };
}

// ---------------------------------------------------------------------------------------------
// Recording. testreel's own video capture is locked to CSS pixels (no deviceScaleFactor reaches
// Playwright's recorder, so a 1600x900 page is recorded at 1600x900 and padded), which makes text
// soft when scaled. So the page is rendered at a device scale factor and its CDP screencast is
// taken at the final 1920x1080 device pixels, then encoded to constant-rate H.264.
// ---------------------------------------------------------------------------------------------
import { writeFileSync, rmSync } from "node:fs";

const CURSOR_JS = `(() => {
  if (window.__cur) return;
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;opacity:0;transform:translate(-100px,-100px);transition:opacity .25s';
  c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.5 25 L17 23.5 L13.6 16.2 L20 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const r = document.createElement('div');
  r.style.cssText = 'position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(255,255,255,.85);z-index:2147483646;pointer-events:none;opacity:0';
  document.documentElement.append(r, c);
  window.__cur = {
    move(x, y) { c.style.transform = 'translate(' + (x - 5) + 'px,' + (y - 3) + 'px)'; c.style.opacity = '1'; r.style.left = x + 'px'; r.style.top = y + 'px'; },
    hide() { c.style.opacity = '0'; },
    click() { r.animate([{ opacity: .9, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 450, easing: 'ease-out' }); },
  };
})()`;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Open a recording session on `page`. Returns helpers; call stop() to get the encoded MP4.
 * `cursor:false` never injects the cursor (for clips that must show none).
 */
export async function startRecording(page, { cursor = true, fps = 30 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const dir = join(root, "capture", "raw", `frames-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(dir, `${String(n++).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, ts: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  if (cursor) await page.evaluate(CURSOR_JS);
  let pos = { x: 960 * 0.8, y: 540 * 0.8 };
  const api = {
    page,
    get pos() { return pos; },
    async begin() { await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }); },
    async move(x, y, ms = 900) {
      const from = pos, t0 = Date.now();
      for (;;) {
        const t = Math.min(1, (Date.now() - t0) / ms), k = ease(t);
        const cx = from.x + (x - from.x) * k, cy = from.y + (y - from.y) * k;
        await page.mouse.move(cx, cy);
        if (cursor) await page.evaluate(([a, b]) => window.__cur.move(a, b), [cx, cy]);
        if (t >= 1) break;
        await sleep(8);
      }
      pos = { x, y };
    },
    async at(selector, { dx = 0.5, dy = 0.5, nth = 0 } = {}) {
      const loc = page.locator(selector).nth(nth);
      await loc.scrollIntoViewIfNeeded();
      const b = await loc.boundingBox();
      return { x: b.x + b.width * dx, y: b.y + b.height * dy };
    },
    async hover(selector, o = {}) {
      let p = await api.at(selector, o);
      await api.move(p.x, p.y, o.ms ?? 900);
      // Things on a running Line can shift while the pointer travels: settle on where the target is now.
      p = await api.at(selector, o);
      if (Math.hypot(p.x - pos.x, p.y - pos.y) > 2) await api.move(p.x, p.y, 180);
    },
    async click(selector, o = {}) {
      await api.hover(selector, o);
      await sleep(250);
      if (cursor) await page.evaluate(() => window.__cur.click());
      await page.mouse.down(); await sleep(60); await page.mouse.up();
    },
    async dblclick(selector, o = {}) {
      await api.hover(selector, o);
      await sleep(250);
      if (cursor) await page.evaluate(() => window.__cur.click());
      await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 }); await sleep(70);
      await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    },
    async stop(outFile) {
      await sleep(250);
      const endTs = Date.now() / 1000; // CDP frame timestamps are epoch seconds
      await cdp.send("Page.stopScreencast");
      await sleep(200);
      return encode(frames, outFile, fps, dir, endTs);
    },
  };
  return api;
}

/** Frames carry timestamps; lay them on a constant-rate timeline so stalls are held, not skipped. */
function encode(frames, outFile, fps, dir, endTs) {
  if (frames.length < 2) throw new Error("no frames captured");
  const list = join(dir, "list.txt");
  let txt = "";
  for (let i = 0; i < frames.length; i++) {
    const dur = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].ts - frames[i].ts) : Math.max(0.05, Math.min(5, endTs - frames[i].ts));
    txt += `file '${frames[i].file}'\nduration ${dur.toFixed(5)}\n`;
  }
  txt += `file '${frames.at(-1).file}'\n`;
  writeFileSync(list, txt);
  const span = Math.max(frames.at(-1).ts, endTs) - frames[0].ts;
  mkdirSync(dirname(outFile), { recursive: true });
  const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `fps=${fps},scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p`, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-movflags", "+faststart", outFile]);
  if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr);
  const hz = frames.length / span;
  rmSync(dir, { recursive: true, force: true });
  return { frames: frames.length, seconds: span, hz };
}

/** Smooth wheel scroll of `dy` px over `ms`, with the pointer at (x, y). */
export async function wheel(page, x, y, dy, ms) {
  await page.mouse.move(x, y);
  const t0 = Date.now();
  let done = 0;
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms), k = ease(t);
    const target = dy * k;
    if (target - done) await page.mouse.wheel(0, target - done);
    done = target;
    if (t >= 1) break;
    await sleep(8);
  }
}

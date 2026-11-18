// Shared plumbing for the capture script (capture.mjs) and the browser suites: the capture build, the
// preview server on 127.0.0.1:4186, and opening the app on the manual clock so every frame is a
// function of the simulation's moment.
//
// The capture build is `vite build --mode capture` into dist/capture (git-ignored). It is the
// production build plus window.__machSim (src/sim/README.md section 6); nothing else differs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const app = dirname(dirname(fileURLToPath(import.meta.url)));
export const web = resolve(app, "..", "..");
export const dist = join(app, "dist", "capture");
export const HOST = "127.0.0.1";
export const PORT = 4186;
export const ORIGIN = `http://${HOST}:${PORT}`;

/** The M5 host's policy, verbatim (apps/studio/internal/security/headers.go). */
export const args = new Set(process.argv.slice(2));
export const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

function newest(dir) {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    latest = Math.max(latest, st.isDirectory() ? newest(path) : st.mtimeMs);
  }
  return latest;
}

/**
 * Build the capture bundle unless an up-to-date one exists (newer than every source file of the app
 * and of @mach/ui). `--rebuild` forces it.
 */
export function ensureBuild({ force = args.has("--rebuild") } = {}) {
  const index = join(dist, "index.html");
  if (!force && existsSync(index)) {
    const built = statSync(index).mtimeMs;
    const sources = Math.max(newest(join(app, "src")), newest(join(web, "packages", "ui", "src")), statSync(join(app, "index.html")).mtimeMs);
    if (built > sources) {
      log("capture build is up to date:", dist);
      return;
    }
  }
  log("building: vite build --mode capture");
  const run = spawnSync("pnpm", ["exec", "vite", "build", "--mode", "capture", "--outDir", "dist/capture", "--emptyOutDir"], { cwd: app, stdio: ["ignore", "ignore", "inherit"] });
  if (run.status !== 0) throw new Error("vite build --mode capture failed");
}

async function waitForHttp(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} did not come up`);
}

/** `vite preview` of the capture build on 127.0.0.1:4186. Always call stop(). */
export async function startPreview() {
  const child = spawn("pnpm", ["exec", "vite", "preview", "--mode", "capture", "--outDir", "dist/capture", "--host", HOST, "--port", String(PORT), "--strictPort"], {
    cwd: app,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  process.once("exit", stop);
  try {
    await waitForHttp(`${ORIGIN}/`);
  } catch (error) {
    stop();
    throw new Error(`${error.message}\n${output}`);
  }
  log("vite preview on", ORIGIN, "pid", child.pid);
  return { origin: ORIGIN, stop };
}

/**
 * A browser context and page on the app, on the Floor (the Atlas). The theme is pinned with ?theme=. The sim clock is switched to manual and the simulation set to t=0 unless `live` is set.
 */
export async function openApp(browser, { origin = ORIGIN, theme = "dark", width = 1920, height = 1080, dpr = 1, reducedMotion = "no-preference", live = false, beforeLoad } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme, reducedMotion });
  const page = await context.newPage();
  if (beforeLoad) await beforeLoad(page, context);
  await page.goto(`${origin}/?theme=${theme}#floor`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__machSim), undefined, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  if (!live) {
    await page.evaluate(() => {
      const sim = window.__machSim;
      sim.useManualClock();
      sim.seek(0);
    });
  }
  return { context, page };
}

/** Let React commit and the browser paint twice (real animation frames). */
export async function frames(page, n = 2) {
  await page.evaluate(
    (count) =>
      new Promise((done) => {
        let left = count;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/** Drive the hook: `await sim(page, "seek", 1000)`. */
export function sim(page, method, ...params) {
  return page.evaluate(([m, p]) => window.__machSim[m](...p), [method, params]);
}

export const S = (seconds) => seconds * 1000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plumbing for the Factory Floor's browser end-to-end suites (e2e/*.e2e.mjs, run with node:test).
// Real processes, no mocks: mach-observer built from this working tree, run on a project made in the
// scratch folder (an empty one, or a synthetic history from mach-synth), and the app served by the
// Vite dev server whose `/api` proxy reaches that observer.
//
// Ports: the dev server on E2E_DEV_PORT (4235); a relay on E2E_RELAY_PORT (4249) that the dev
// server's proxy targets and that forwards to whichever observer the running test started (its
// port is written to <scratch>/relay-target), so one dev server serves every test file; observers
// on 4240-4248. Every process started is recorded in <scratch>/pids and killed by the global
// teardown (e2e/global.mjs), even when a test fails.
//
// Nothing here writes into the repository or into a source project: copies and generated projects
// live under E2E_SCRATCH (default <os tmpdir>/mach-floor-e2e). It never runs build.sh or a
// production build.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const app = dirname(dirname(fileURLToPath(import.meta.url)));
export const repo = resolve(app, "..", "..", "..");
export const observerSrc = join(repo, "apps", "observer");
const require = createRequire(join(app, "package.json"));
export const { chromium } = require("playwright");

export const HOST = "127.0.0.1";
export const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 4235);
export const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 4249);
export const OBSERVER_PORTS = [4240, 4241, 4242, 4243, 4244, 4245, 4246, 4247, 4248];
export const DEV_ORIGIN = `http://${HOST}:${DEV_PORT}`;
export const scratch = resolve(process.env.E2E_SCRATCH ?? join(tmpdir(), "mach-floor-e2e"));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...parts) => {
  if (process.env.E2E_QUIET !== "1") console.error(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...parts);
};

mkdirSync(scratch, { recursive: true });
const PIDS = join(scratch, "pids");
const TARGET = join(scratch, "relay-target");

// ------------------------------------------------------------ processes

export function registerPid(pid, label) {
  appendFileSync(PIDS, `${pid} ${label}\n`);
}

/** Kill every process this suite recorded (the global teardown; also safe to call twice). */
export function killRegistered() {
  if (!existsSync(PIDS)) return [];
  const killed = [];
  for (const line of readFileSync(PIDS, "utf8").split("\n")) {
    const [pid, ...label] = line.trim().split(" ");
    if (!pid) continue;
    try {
      process.kill(-Number(pid), "SIGTERM");
      killed.push(`${pid} ${label.join(" ")}`);
    } catch {
      try {
        process.kill(Number(pid), "SIGTERM");
        killed.push(`${pid} ${label.join(" ")}`);
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(PIDS, { force: true });
  return killed;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answers(url, ms = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.status < 500;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ tools: observer and generator

export const bin = { observer: join(scratch, "bin", "mach-observer"), synth: join(scratch, "bin", "mach-synth") };

/**
 * Build mach-observer and mach-synth from the working tree into the scratch folder. If the tree does
 * not compile (others are editing it), fall back to E2E_OBSERVER_FALLBACK when given and say so.
 */
export function buildTools() {
  mkdirSync(dirname(bin.observer), { recursive: true });
  const notes = [];
  for (const [out, pkg] of [
    [bin.observer, "./cmd/mach-observer"],
    [bin.synth, "./internal/testkit/cmd/mach-synth"],
  ]) {
    const r = spawnSync("go", ["build", "-o", out, pkg], { cwd: observerSrc, encoding: "utf8" });
    if (r.status !== 0) {
      const fallback = out === bin.observer ? process.env.E2E_OBSERVER_FALLBACK : null;
      if (fallback && existsSync(fallback)) {
        spawnSync("cp", [fallback, out]);
        notes.push(`observer: the working tree did not compile; using ${fallback}`);
      } else if (!existsSync(out)) throw new Error(`go build ${pkg} failed:\n${r.stderr.slice(0, 2000)}`);
      else notes.push(`${pkg}: the working tree did not compile; using the previous build in ${out}`);
    }
  }
  return notes;
}

// ------------------------------------------------------------ projects

/** A synthetic history (mach-synth), generated fresh; returns { dir, summary }. */
export function synthProject(name, { cells = 12, events = 12000, seed = 7, hours = 6, end } = {}) {
  const dir = join(scratch, "projects", name);
  rmSync(dir, { recursive: true, force: true });
  const args = ["--out", dir, "--cells", String(cells), "--events", String(events), "--seed", String(seed), "--hours", String(hours)];
  if (end) args.push("--end", end);
  const r = spawnSync(bin.synth, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`mach-synth failed: ${r.stderr}`);
  return { dir, summary: JSON.parse(readFileSync(join(dir, "synth-summary.json"), "utf8")) };
}

// ------------------------------------------------------------ the observer

/**
 * Start mach-observer on a project copy and a fixed port, and point the relay at it. Resolves once
 * it has printed its link and written `.factory/local/observer/link`.
 */
export async function startObserver(project, port, { timeoutMs = 60000, memoryEvents } = {}) {
  const linkFile = join(project, ".factory", "local", "observer", "link");
  const before = existsSync(linkFile) ? statSync(linkFile).mtimeMs : 0;
  const args = ["--project", project, "--port", String(port)];
  if (memoryEvents) args.push("--memory-events", String(memoryEvents));
  // Output to a file, not a pipe: the observer outlives nothing it is not meant to, and a closed pipe
  // would end it (SIGPIPE on its request log).
  mkdirSync(join(scratch, "logs"), { recursive: true });
  const logFile = join(scratch, "logs", `observer-${port}-${Date.now()}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn(bin.observer, args, { stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  child.unref();
  registerPid(child.pid, `mach-observer :${port}`);
  const output = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
  const started = Date.now();
  const until = started + timeoutMs;
  while (Date.now() < until) {
    if (/^Open: /m.test(output()) && existsSync(linkFile) && statSync(linkFile).mtimeMs !== before) break;
    if (child.exitCode !== null) throw new Error(`mach-observer exited (${child.exitCode}):\n${output().slice(0, 3000)}`);
    await sleep(100);
  }
  if (!existsSync(linkFile)) throw new Error(`mach-observer wrote no link in ${timeoutMs} ms:\n${output().slice(0, 3000)}`);
  writeFileSync(TARGET, String(port));
  const obs = {
    port,
    pid: child.pid,
    project,
    origin: `http://${HOST}:${port}`,
    output,
    logFile,
    /** The one-time link, read from the project copy immediately before use (each works once). */
    link: () => readFileSync(linkFile, "utf8").trim(),
    stop: () =>
      new Promise((ok) => {
        if (child.exitCode !== null || !alive(child.pid)) return ok(child.exitCode);
        const t = setTimeout(() => {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000);
        child.once("exit", (code) => {
          clearTimeout(t);
          ok(code);
        });
        child.kill("SIGTERM");
      }),
  };
  log("observer", port, "pid", child.pid, "on", project);
  return obs;
}

/** A session cookie from a fresh link, for GETs outside the browser. */
export async function apiSession(obs) {
  const res = await fetch(obs.link(), { redirect: "manual" });
  const set = res.headers.getSetCookie?.() ?? [];
  if (!set.length) throw new Error(`the link set no session cookie (status ${res.status})`);
  return set.map((c) => c.split(";")[0]).join("; ");
}

export async function apiGet(obs, cookie, path) {
  const res = await fetch(`${obs.origin}${path}`, { headers: { cookie } });
  const body = await res.json();
  return { status: res.status, body };
}


// ------------------------------------------------------------ the dev server and its relay

/**
 * The relay: forwards `/api/...` to the observer named in <scratch>/relay-target, with that
 * observer's own Host and Origin (its checks see what a same-origin browser would send). Streams.
 */
export function startRelay(port = RELAY_PORT) {
  const server = createServer((req, res) => {
    const target = Number(existsSync(TARGET) ? readFileSync(TARGET, "utf8").trim() : 0);
    if (!target) {
      res.writeHead(502).end("no observer");
      return;
    }
    const headers = { ...req.headers, host: `${HOST}:${target}` };
    if (headers.origin) headers.origin = `http://${HOST}:${target}`;
    const up = httpRequest({ host: HOST, port: target, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => { if (process.env.E2E_DEBUG) console.error("relay", e);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  return new Promise((ok, fail) => server.once("error", fail).listen(port, HOST, () => ok(server)));
}

/** The relay as its own process (so the global setup can return while it runs). */
export async function spawnRelay() {
  if (await answers(`http://${HOST}:${RELAY_PORT}/`)) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--relay"], { stdio: "ignore", detached: true });
  child.unref();
  registerPid(child.pid, `relay :${RELAY_PORT}`);
  for (let i = 0; i < 50 && !(await answers(`http://${HOST}:${RELAY_PORT}/`)); i++) await sleep(100);
}

/** Vite on DEV_PORT, proxying /api to the relay. Reused if it already answers. */
export async function spawnDevServer() {
  if (await answers(`${DEV_ORIGIN}/`)) {
    log("dev server already answers on", DEV_ORIGIN);
    return;
  }
  const child = spawn(join(app, "node_modules", ".bin", "vite"), ["--port", String(DEV_PORT), "--strictPort", "--host", HOST], {
    cwd: app,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env, MACH_OBSERVER_PORT: String(RELAY_PORT) },
  });
  child.unref();
  registerPid(child.pid, `vite :${DEV_PORT}`);
  for (let i = 0; i < 120 && !(await answers(`${DEV_ORIGIN}/`)); i++) await sleep(250);
  if (!(await answers(`${DEV_ORIGIN}/`))) throw new Error(`the dev server did not answer on ${DEV_ORIGIN}`);
  log("dev server on", DEV_ORIGIN, "pid", child.pid);
}

if (process.argv.includes("--relay")) await startRelay();

// ------------------------------------------------------------ the browser

export async function launch() {
  return chromium.launch({ headless: process.env.E2E_HEADED !== "1" });
}

/**
 * A page on the dev server, with a session on `obs` from its one-time link (opened in this context, so
 * the cookie is the browser's own), a log of every request and every console error.
 */
export async function openApp(browser, obs, hash = "#line", { width = 1512, height = 982, reducedMotion = "no-preference", colorScheme = "dark", waitReady = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, colorScheme });
  const page = await context.newPage();
  page.requests = [];
  page.consoleErrors = [];
  page.on("request", (r) => page.requests.push({ method: r.method(), url: r.url() }));
  page.on("console", (m) => {
    if (m.type() === "error") page.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => page.consoleErrors.push(`pageerror: ${e.message}`));
  if (obs) {
    await page.goto(obs.link(), { waitUntil: "load" });
  }
  await page.goto(`${DEV_ORIGIN}/${hash}`, { waitUntil: "load" });
  if (waitReady) await sceneReady(page);
  return { context, page };
}

/**
 * Wait for a settled scene: `data-scene-ready` (r4-workspace adds it). Fails with a clear message
 * when the hook is not there yet; `optional` turns that into a short wait instead.
 */
export async function sceneReady(page, { timeout = 15000, optional = false } = {}) {
  try {
    await page.waitForSelector("[data-scene-ready]", { timeout, state: "attached" });
    return true;
  } catch {
    if (optional) {
      await sleep(1500);
      return false;
    }
    throw new Error(`no [data-scene-ready] hook in the page within ${timeout} ms`);
  }
}

export const hashParams = (hash) => {
  const q = hash.indexOf("?");
  return Object.fromEntries(new URLSearchParams(q < 0 ? "" : hash.slice(q + 1)));
};

export function apiOffenders(page) {
  return page.requests.filter((r) => {
    const u = new URL(r.url);
    if (!u.pathname.startsWith("/api/")) return false;
    return r.method !== "GET" || u.hostname !== HOST;
  });
}

/** Console errors, minus the browser's own noise for an SSE stream torn down on close. */
export function consoleErrors(page) {
  return page.consoleErrors.filter((t) => !/net::ERR_ABORTED|Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(t));
}

/**
 * The relay and the dev server, if the global setup did not start them (a file run on its own). The
 * files share one dev server and one relay, so they must run one at a time (--test-concurrency=1).
 */
export async function ensureStack() {
  if (!existsSync(bin.observer) || !existsSync(bin.synth)) for (const note of buildTools()) log(note);
  await spawnRelay();
  await spawnDevServer();
}

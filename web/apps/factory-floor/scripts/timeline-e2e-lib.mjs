// Plumbing for the M6.3 Timeline browser end-to-end suite (e2e/*.e2e.mjs, run with node:test). Real
// processes, no mocks: mach-observer built from this working tree, run on a COPY of a project (the
// real supervised run, or a synthetic history from mach-synth), and the app served by the Vite dev
// server whose `/api` proxy reaches that observer. docs/mach-next/M6_3_TESTING.md describes it.
//
// Ports: the dev server on E2E_DEV_PORT (4235); a relay on E2E_RELAY_PORT (4249) that the dev
// server's proxy targets and that forwards to whichever observer the running test started (its
// port is written to <scratch>/relay-target), so one dev server serves every test file; observers
// on 4240-4248. Every process started is recorded in <scratch>/pids and killed by the global
// teardown (e2e/global.mjs), even when a test fails.
//
// Nothing here writes into the repository or into a source project: copies and generated projects
// live under E2E_SCRATCH (default <os tmpdir>/mach-timeline-e2e). It never runs build.sh or a
// production build.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
export const scratch = resolve(process.env.E2E_SCRATCH ?? join(tmpdir(), "mach-timeline-e2e"));
export const LARGE = process.env.E2E_LARGE === "1";

/** The projects the suite copies (never written to). Overridable for another machine. */
export const SOURCES = {
  realRun: process.env.E2E_REAL_RUN ?? "/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m65-run/P/eng",
  large: process.env.E2E_LARGE_PROJECT ?? "/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m63-agents/perf-fixtures/synthetic-220k",
};

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

/** Copy a project into the scratch folder, without the observer's own index (a fresh observer state). */
export function copyProject(src, name) {
  const dest = join(scratch, "projects", name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync("rsync", ["-a", "--exclude", ".factory/local/observer", `${src}/`, `${dest}/`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`copying ${src} failed: ${r.stderr}`);
  return dest;
}

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

/** Extend a generated project's open execution (mach-synth --append), synchronously. */
export function appendSynth(dir, { rate = 50, duration = "2s" } = {}) {
  const r = spawnSync(bin.synth, ["--out", dir, "--append", "--rate", String(rate), "--duration", duration], { encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`mach-synth --append failed: ${r.stderr}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { raw: r.stdout };
  }
}

/** sha256 of every file under `dir`, except paths starting with one of `exclude` (relative). */
export function checksumTree(dir, exclude = [".factory/local/observer"]) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (exclude.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

export function diffChecksums(a, b) {
  const changed = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) changed.push(`${k in a ? (k in b ? "changed" : "removed") : "added"} ${k}`);
  return changed;
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

/** Wait until the observer's health says the projection has caught up with every source. */
export async function waitCaughtUp(obs, cookie, timeoutMs = 600000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      last = (await apiGet(obs, cookie, "/api/v1/health")).body;
      const d = last?.data ?? last;
      const f = d?.freshness ?? {};
      if (f.ingest?.catching_up === false && (f.projection?.lag_events ?? 0) === 0) return d;
    } catch {
      /* not answering yet */
    }
    await sleep(500);
  }
  throw new Error(`observer did not catch up: ${JSON.stringify(last).slice(0, 500)}`);
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

export const WS = "[data-timeline-workspace]";

export async function launch() {
  return chromium.launch({ headless: process.env.E2E_HEADED !== "1" });
}

/**
 * A page on the dev server, with a session on `obs` from its one-time link (opened in this context, so
 * the cookie is the browser's own), a log of every request and every console error.
 */
export async function openApp(browser, obs, hash = "#timeline", { width = 1512, height = 982, reducedMotion = "no-preference", colorScheme = "dark", waitReady = true } = {}) {
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
  if (waitReady && hash.startsWith("#timeline")) await timelineReady(page);
  return { context, page };
}

/** The Timeline is ready (first tracks, the table or a designed empty state on screen). */
export async function timelineReady(page, timeout = 30000) {
  await page.waitForSelector(`${WS}[data-timeline-ready]`, { timeout });
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
    throw new Error(`no [data-scene-ready] hook in the page within ${timeout} ms (waits on r4-workspace)`);
  }
}

/** The workspace's hooks, as the page shows them now. */
export async function hooks(page) {
  return page.evaluate((ws) => {
    const el = document.querySelector(ws);
    const any = (n) => document.querySelector(`[${n}]`)?.getAttribute(n) ?? null;
    return {
      workspace: Boolean(el),
      ready: el?.hasAttribute("data-timeline-ready") ?? false,
      spans: el ? Number(el.getAttribute("data-timeline-spans")) : null,
      window: any("data-timeline-window"),
      grouping: el?.getAttribute("data-timeline-grouping") || document.querySelector(`${ws} input[type=radio]:checked`)?.value || null,
      groupingAttr: any("data-timeline-grouping"),
      sceneReady: document.querySelector("[data-scene-ready]") !== null,
      hash: location.hash,
    };
  }, WS);
}

export const hashParams = (hash) => {
  const q = hash.indexOf("?");
  return Object.fromEntries(new URLSearchParams(q < 0 ? "" : hash.slice(q + 1)));
};

export async function setGrouping(page, grouping) {
  const radio = page.locator(`${WS} input[type=radio][value=${grouping}]`);
  if (!(await radio.count())) throw new Error(`no ${grouping} grouping control`);
  if (!(await radio.isChecked())) await radio.check({ force: true });
  await page.waitForFunction((g) => location.hash.includes(`group=${g}`) || g === "product", grouping, { timeout: 5000 }).catch(() => {});
  await sleep(400);
}

const tableButton = (page) => page.locator(`${WS} [role=toolbar] button`, { hasText: "Table" }).first();

export async function setTable(page, on) {
  const b = tableButton(page);
  if (!(await b.count())) throw new Error("no Table button in the Timeline toolbar");
  if (((await b.getAttribute("aria-pressed")) === "true") !== on) await b.click();
  if (on) await page.waitForSelector(`${WS} [role=treegrid]`, { timeout: 10000 });
  else await page.waitForSelector(`${WS} [role=application]`, { timeout: 10000 });
  await sleep(300);
}

/**
 * The table's rows as the person can read them: { key, level, expanded, selected, cells[] }. The
 * table is virtualised: it is scrolled from top to bottom and every row seen is collected once.
 */
export async function readTable(page) {
  return page.evaluate(async (ws) => {
    const grid = document.querySelector(`${ws} [role=treegrid]`);
    if (!grid) throw new Error("no table (treegrid) in the Timeline");
    const box = grid.closest("[data-timeline-table]") ?? grid.parentElement;
    const seen = new Map();
    const take = () => {
      for (const row of grid.querySelectorAll("[role=row][aria-rowindex]")) {
        const idx = Number(row.getAttribute("aria-rowindex"));
        if (idx === 1 && row.querySelector("[role=columnheader]")) continue;
        const cells = [...row.querySelectorAll("[role=gridcell]")].map((c) => c.innerText.replace(/\s+/g, " ").trim());
        seen.set(idx, {
          index: idx,
          key: row.getAttribute("data-key"),
          level: Number(row.getAttribute("aria-level")),
          expanded: row.hasAttribute("aria-expanded") ? row.getAttribute("aria-expanded") === "true" : null,
          selected: row.getAttribute("aria-selected") === "true",
          label: row.getAttribute("aria-label"),
          cells,
          text: cells.join(" | "),
        });
      }
    };
    const scroller = [grid, box, ...ancestors(grid)].find((e) => e && e.scrollHeight > e.clientHeight + 2) ?? box;
    function* ancestors(e) {
      for (let p = e?.parentElement; p; p = p.parentElement) yield p;
    }
    scroller.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let guard = 0; guard < 400; guard++) {
      take();
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
      scroller.scrollTop += Math.max(100, scroller.clientHeight - 60);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    take();
    scroller.scrollTop = 0;
    return [...seen.values()].sort((a, b) => a.index - b.index);
  }, WS);
}

/** Bring a table row into view (the grid is virtualised) and click it (in the page: rows move while virtualised). */
async function clickTableRow(page, key) {
  return page.evaluate(
    async ({ ws, key }) => {
      const grid = document.querySelector(`${ws} [role=treegrid]`);
      if (!grid) return;
      const find = () => grid.querySelector(`[data-key="${CSS.escape(key)}"]`);
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!find()) {
        grid.scrollTop = 0;
        await frame();
        while (!find() && grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2) {
          grid.scrollTop += Math.max(100, grid.clientHeight - 60);
          await frame();
        }
      }
      find()?.scrollIntoView({ block: "center" });
      await frame();
      const row = find();
      if (!row) return false;
      row.click();
      await frame();
      return true;
    },
    { ws: WS, key },
  );
}

/**
 * Open every track in the table (a click on each closed track row, repeated until nothing closed is
 * left or `maxPasses`), so the table lists every span in the window. `match` limits it to rows whose text matches.
 */
export async function expandTable(page, { maxPasses = 8, match = null } = {}) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const keys = (await readTable(page)).filter((r) => r.expanded === false && (!match || match.test(r.text) || match.test(r.key ?? ""))).map((r) => r.key);
    if (!keys.length) return;
    for (const key of keys) {
      await clickTableRow(page, key);
    }
    await sleep(300);
  }
}

/** The inspector's text (the selection's anatomy and the "In time" section). */
export async function inspectorText(page) {
  return page.evaluate(() => (document.querySelector("[data-inspector]")?.innerText ?? "").replace(/[ \t]+/g, " "));
}

/** Select the first table row `predicate` accepts (a click on a span row selects it). Returns the row or null. */
export async function selectTableRow(page, predicate) {
  const rows = await readTable(page);
  const row = rows.find(predicate);
  if (!row) return null;
  if (!(await clickTableRow(page, row.key))) return null;
  await sleep(600);
  return row;
}

/** Every /api request the page made: GET only, to 127.0.0.1 only. Returns the offenders. */
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

/** Running Web Animations and CSS transitions inside `sel`. */
export async function runningAnimations(page, sel = WS) {
  return page.evaluate(
    (sel) =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .filter((a) => {
          const t = a.effect?.target;
          return !t || t.closest?.(sel) || t === document.documentElement;
        })
        .map((a) => `${a.constructor.name}:${a.transitionProperty ?? a.animationName ?? "?"} on ${(a.effect?.target?.getAttribute?.("class") ?? a.effect?.target?.tagName ?? "?").toString().slice(0, 60)}`),
    sel,
  );
}

/** A print of every canvas in `sel` (to tell a still canvas from a moving one). */
export async function canvasPrint(page, sel = WS) {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} canvas`)].map((c) => {
        try {
          const d = c.toDataURL();
          return `${d.length}:${d.slice(-64)}`;
        } catch {
          return "tainted";
        }
      }),
    sel,
  );
}

/** Make the failure message say which finding it waits on. */
export function waitsOn(id, message) {
  return `${message} [waits on ${id}]`;
}

// ------------------------------------------------------------ reading table rows

/** A row's columns by name (wide layout): track, what, started, ended, duration, outcome, authority. */
export function cols(row) {
  const [track = "", what = "", started = "", ended = "", duration = "", outcome = "", authority = ""] = row.cells;
  return { track, what, started, ended, duration, outcome, authority };
}

/** The rows below `key` (deeper levels, until the next row at its level or above). */
export function subtree(rows, key) {
  const i = rows.findIndex((r) => r.key === key);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < rows.length && rows[j].level > rows[i].level; j++) out.push(rows[j]);
  return out;
}

/** A time of day in a cell ("01:07:21.7 …" or "between A and B"), as ms since midnight UTC; null when open or absent. */
export function clockMs(text) {
  const m = /(\d{2}):(\d{2}):(\d{2})(?:\.(\d))?/.exec(text ?? "");
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4] ?? 0) * 100;
}

/** Span rows of a kind ("visit", "agent", …): keys are `span:<kind>:<entity ref>`. */
export const spanRows = (rows, kind) => rows.filter((r) => r.key?.startsWith(`span:${kind}:`));
export const isOpenRow = (r) => /still open/i.test(cols(r).ended) || /still open/i.test(cols(r).track);

/**
 * How many animation frames, in the next `ms`, drew something new on a canvas in `sel`. An eased
 * zoom or a growing span changes nearly every frame; a cut changes once or twice (the cut, then the
 * window's spans arriving), and a live clock about once a second.
 */
export async function changingFrames(page, ms = 700, sel = WS) {
  return page.evaluate(
    ({ ms, sel }) =>
      new Promise((resolve) => {
        const print = () => [...document.querySelectorAll(`${sel} canvas`)].map((c) => c.toDataURL()).join("|");
        let prev = print();
        let changed = 0;
        let frames = 0;
        const until = performance.now() + ms;
        const tick = () => {
          const now = print();
          frames++;
          if (now !== prev) changed++;
          prev = now;
          if (performance.now() < until) requestAnimationFrame(tick);
          else resolve({ changed, frames });
        };
        requestAnimationFrame(tick);
      }),
    { ms, sel },
  );
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

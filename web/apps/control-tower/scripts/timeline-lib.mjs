// Plumbing for the M6.3 Timeline performance harness (timeline-measure.mjs): a free port, the
// capture build served on it (never 4186, which the M6.0 scripts use), an mach-observer started on a
// generated project or reached through a one-time link, a same-origin proxy when the observer was
// built without the Control Tower, the in-page frame recorder, and steps that report "not measurable
// yet" instead of failing the run. docs/mach-next/M6_3_PERFORMANCE.md describes the method.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as netServer } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import os from "node:os";
import { app, dist, log } from "./lib.mjs";

export { app, dist, ensureBuild, log } from "./lib.mjs";

export const HOST = "127.0.0.1";

/** A free loopback port, never 4186 (the M6.0 capture scripts' fixed port). */
export async function freePort() {
  for (;;) {
    const port = await new Promise((ok, fail) => {
      const s = netServer();
      s.once("error", fail);
      s.listen(0, HOST, () => {
        const p = s.address().port;
        s.close(() => ok(p));
      });
    });
    if (port !== 4186) return port;
  }
}

/** Parse `--name value` and `--flag` arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A measurement that cannot be taken yet (the UI part is not there): reported, never a failure. */
export class NotYet extends Error {}

/** Run one measurement; an exception becomes `{ status: "not measurable yet", why }`. */
export async function step(report, name, fn) {
  const began = Date.now();
  try {
    const value = await fn();
    report.steps[name] = { status: "measured", ...value };
    log("measured", name);
  } catch (error) {
    const why = error instanceof NotYet ? error.message : `${error?.name ?? "Error"}: ${String(error?.message ?? error).split("\n")[0].slice(0, 300)}`;
    report.steps[name] = { status: "not measurable yet", why };
    log("not measurable yet:", name, "-", why);
  }
  report.steps[name].tookMs = Date.now() - began;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/**
 * Serve the capture build on a free port. With `observer` ({ origin, cookie }), every `/api/` request
 * is forwarded to the observer with its session cookie and its own Host (so the observer's
 * loopback and host checks see what they expect), responses streamed as they come (the event
 * stream included). The browser then talks to one origin, as it does when the observer serves the app.
 */
export async function serveApp({ observer = null, port } = {}) {
  port ??= await freePort();
  const root = dist + sep;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (observer && url.pathname.startsWith("/api/")) {
      const target = new URL(observer.origin);
      const headers = { accept: req.headers.accept ?? "*/*", cookie: observer.cookie, host: target.host };
      const up = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("close", () => up.destroy());
      up.end();
      return;
    }
    let file = normalize(join(dist, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  });
  await new Promise((ok, fail) => server.once("error", fail).listen(port, HOST, ok));
  const origin = `http://${HOST}:${port}`;
  log(observer ? "capture build with the observer's API proxied on" : "capture build on", origin);
  return { origin, stop: () => new Promise((ok) => server.close(ok)) };
}

/**
 * Open a session with an observer from its one-time link: follow it without a browser, keep the
 * cookie it sets. Returns { origin, cookie, cookies (for a browser context), embedsApp }.
 */
export async function observerSession(link) {
  const u = new URL(link);
  const origin = u.origin;
  if (u.hostname !== HOST) throw new Error(`not a loopback observer: ${origin}`);
  const res = await fetch(link, { redirect: "manual" });
  const set = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
  if (!set.length) throw new Error(`the link set no session cookie (status ${res.status}); it may have been used already`);
  const pairs = set.map((c) => c.split(";")[0]);
  const cookie = pairs.join("; ");
  const cookies = pairs.map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: HOST, path: "/", httpOnly: true, sameSite: "Strict" };
  });
  const page = await (await fetch(`${origin}/`, { headers: { cookie } })).text();
  const embedsApp = !page.includes("built without the Control Tower app") && page.includes('id="root"');
  return { origin, cookie, cookies, embedsApp };
}

export async function observerGet(session, path) {
  const res = await fetch(`${session.origin}${path}`, { headers: { cookie: session.cookie } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const body = await res.json();
  return body.data ?? body;
}

/**
 * Start mach-observer on a project and wait for its link. The observer reads only; it writes its
 * index under the project's .factory/local/observer/. Always call stop().
 */
export async function startObserver({ bin, project, timeoutMs = 20000 }) {
  const child = spawn(bin, ["--project", project], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const stop = () =>
    new Promise((ok) => {
      if (child.exitCode !== null) return ok(child.exitCode);
      child.once("exit", (code) => ok(code));
      child.kill("SIGTERM");
    });
  process.once("exit", () => child.kill("SIGTERM"));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = output.match(/^Open: (\S+)/m);
    if (m) {
      log("observer", bin, "on", project, "pid", child.pid);
      return { link: m[1], stop, output: () => output, started: Date.now() };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  await stop();
  throw new Error(`mach-observer printed no link:\n${output.slice(0, 2000)}`);
}

/** Wait until the observer has read what was on disk when it started and projected all of it. */
export async function waitCaughtUp(session, timeoutMs = 600000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = await observerGet(session, "/api/v1/health").catch(() => null);
    const head = Number(String(h?.index?.head ?? "").split(".").pop());
    if (h && h.ingest?.catching_up === false && h.projection?.applied >= head) return h;
    if (Date.now() > until) throw new Error("the observer did not catch up in time");
    await sleep(200);
  }
}

/** Run mach-synth --append against a generated project (go run from the observer module, or a built binary). */
export function startAppender({ project, rate, seconds, synthBin }) {
  const observerDir = join(app, "..", "..", "..", "apps", "observer");
  const args = ["--out", project, "--append", "--rate", String(rate), "--duration", `${seconds}s`];
  const child = synthBin ? spawn(synthBin, args, { stdio: ["ignore", "pipe", "pipe"] }) : spawn("go", ["run", "./internal/testkit/cmd/mach-synth", ...args], { cwd: observerDir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((ok) => child.once("exit", (code) => ok({ code, out })));
  return { done, kill: () => child.kill("SIGINT") };
}

/** Facts about this machine and checkout, for the report. */
export function machineFacts() {
  const git = (...a) => spawnSync("git", a, { cwd: app, encoding: "utf8" }).stdout?.trim() || null;
  const cpu = os.cpus();
  return {
    cpu: cpu[0]?.model ?? null,
    cores: cpu.length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    commit: git("rev-parse", "--short", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    power: os.platform() === "darwin" ? (spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? null) : null,
  };
}

/** Read a generated project's summary, if it is one. */
export function synthSummary(project) {
  try {
    const s = JSON.parse(readFileSync(join(project, "synth-summary.json"), "utf8"));
    return { seed: s.seed, cells: s.cells, hours: s.hours, events: s.events, executions: s.executions, agents: s.agents, start: s.start, end: s.end, bytes: s.bytes, spans_expected: s.spans_expected };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- in the page

/** Install the frame recorder, long-task and long-animation-frame observers, and an input-to-frame meter. */
export async function instrument(page) {
  await page.evaluate(() => {
    if (window.__tlPerf) return;
    const rec = (window.__tlPerf = { on: false, stamps: [], longtasks: [], loaf: [], inputs: [], pendingInput: null });
    const loop = (t) => {
      if (rec.on) rec.stamps.push(t);
      if (rec.pendingInput !== null) {
        rec.inputs.push(t - rec.pendingInput);
        rec.pendingInput = null;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const mark = (e) => {
      if (rec.on && rec.pendingInput === null) rec.pendingInput = e.timeStamp;
    };
    for (const type of ["pointermove", "wheel", "keydown", "pointerdown"]) window.addEventListener(type, mark, { capture: true, passive: true });
    try {
      new PerformanceObserver((l) => {
        if (rec.on) for (const e of l.getEntries()) rec.longtasks.push(e.duration);
      }).observe({ type: "longtask" });
    } catch {
      // not supported
    }
    try {
      new PerformanceObserver((l) => {
        if (!rec.on) return;
        for (const e of l.getEntries()) rec.loaf.push({ duration: e.duration, script: (e.scripts ?? []).reduce((s, x) => s + x.duration, 0) });
      }).observe({ type: "long-animation-frame" });
    } catch {
      // not supported
    }
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

export function distribution(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: r1(pct(s, 50)), p95: r1(pct(s, 95)), max: r1(s.at(-1) ?? null) };
}

export async function metrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/** Record frames, long tasks and input-to-frame latency while `during` runs. */
export async function recordWhile(page, cdp, during, minMs = 0) {
  const m0 = await metrics(cdp);
  await page.evaluate(() => Object.assign(window.__tlPerf, { on: true, stamps: [], longtasks: [], loaf: [], inputs: [], pendingInput: null }));
  const began = Date.now();
  await during();
  const left = minMs - (Date.now() - began);
  if (left > 0) await sleep(left);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const rec = await page.evaluate(() => {
    window.__tlPerf.on = false;
    const { stamps, longtasks, loaf, inputs } = window.__tlPerf;
    return { stamps, longtasks, loaf, inputs };
  });
  const m1 = await metrics(cdp);
  const intervals = rec.stamps.slice(1).map((t, i) => t - rec.stamps[i]);
  const frames = Math.max(1, intervals.length);
  return {
    frameMs: distribution(intervals),
    inputToFrameMs: distribution(rec.inputs),
    longTasks: { count: rec.longtasks.length, totalMs: Math.round(rec.longtasks.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...rec.longtasks)) },
    longAnimationFrames: { count: rec.loaf.length, maxScriptMs: Math.round(Math.max(0, ...rec.loaf.map((l) => l.script))) },
    // Main-thread work per frame (script, style, layout, paint, everything a task did), from Chromium's counters.
    taskMsPerFrame: Math.round(((m1.TaskDuration - m0.TaskDuration) * 1000 * 100) / frames) / 100,
    scriptMsPerFrame: Math.round(((m1.ScriptDuration - m0.ScriptDuration) * 1000 * 100) / frames) / 100,
    layoutMsPerFrame: Math.round(((m1.LayoutDuration - m0.LayoutDuration) * 1000 * 100) / frames) / 100,
  };
}

/** JS heap after a forced garbage collection, in MB. */
export async function heapAfterGc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(200);
  await cdp.send("HeapProfiler.collectGarbage");
  const m = await metrics(cdp);
  return { heapMB: Math.round((m.JSHeapUsedSize / 2 ** 20) * 10) / 10, nodes: m.Nodes, listeners: m.JSEventListeners };
}

/** Selectors the harness relies on (see M6_3_PERFORMANCE.md, "What the harness needs from the UI"). */
export const SEL = {
  playheadAnywhere: "[role=slider]",
  workspace: "[data-timeline-workspace]",
  ready: "[data-timeline-workspace][data-timeline-ready]",
  floor: "[data-workspace=floor]",
  canvas: "[data-timeline-workspace] canvas",
  toggle: "[data-timeline-workspace] button[aria-expanded]",
  playhead: "[data-timeline-workspace] [role=slider]",
};

/**
 * Time from a key press to the end of the first frame painted after `condition` (a JavaScript
 * expression) holds (a frame, then a task: the usual "next paint" approximation), in the page's clock: a listener records the key event's own timestamp, so the automation's latency is not
 * counted. The listener is installed (and confirmed) before the key goes down.
 */
export async function keyToCondition(page, key, condition, timeoutMs = 10000) {
  await page.evaluate(() => {
    const k = (window.__tlKey = { t0: null });
    k.listener = (e) => {
      if (k.t0 === null) k.t0 = e.timeStamp;
    };
    window.addEventListener("keydown", k.listener, { capture: true });
  });
  await page.keyboard.press(key);
  return page.evaluate(
    ({ condition, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const k = window.__tlKey;
        const test = new Function(`return (${condition})`);
        const until = performance.now() + timeoutMs;
        const done = (fn) => {
          window.removeEventListener("keydown", k.listener, { capture: true });
          fn();
        };
        const tick = () => {
          if (k.t0 !== null && test()) return requestAnimationFrame(() => setTimeout(() => done(() => resolve(performance.now() - k.t0))));
          if (performance.now() > until) return done(() => reject(new Error(`condition not met in ${timeoutMs} ms: ${condition}`)));
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { condition, timeoutMs },
  );
}

/**
 * Time from a key press to the next frame after anything under `root` changed (an attribute, a
 * style, text or a child): how long the view takes to answer the key. Null when nothing changed.
 */
export async function keyToMutation(page, key, root, timeoutMs = 3000) {
  await page.evaluate((root) => {
    const k = (window.__tlKey = { t0: null, changed: false });
    k.listener = (e) => {
      if (k.t0 === null) k.t0 = e.timeStamp;
    };
    window.addEventListener("keydown", k.listener, { capture: true });
    k.observer = new MutationObserver(() => {
      if (k.t0 !== null) k.changed = true;
    });
    const el = document.querySelector(root);
    if (el) k.observer.observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
  }, root);
  await page.keyboard.press(key);
  return page.evaluate(
    (timeoutMs) =>
      new Promise((resolve) => {
        const k = window.__tlKey;
        const until = performance.now() + timeoutMs;
        const end = (v) => {
          k.observer.disconnect();
          window.removeEventListener("keydown", k.listener, { capture: true });
          resolve(v);
        };
        const tick = () => {
          if (k.changed) return requestAnimationFrame(() => setTimeout(() => end(performance.now() - k.t0)));
          if (performance.now() > until) return end(null);
          requestAnimationFrame(tick);
        };
        tick();
      }),
    timeoutMs,
  );
}

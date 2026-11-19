// Shared set-up for the Product Studio captures: the e2e world (real Go host, real engine, stand-in gh,
// scripted stand-in claude) with a seed of our own, and a recorder that gives crisp 1920x1080 footage.
//
// Nothing under web/e2e is edited; its libraries are imported read-only. Everything runs on 127.0.0.1.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export const videoRoot = resolve(here, "../..");
export const repoRoot = resolve(videoRoot, "..");
const e2eLib = join(repoRoot, "web/e2e/lib");

// Scratch worlds live in the system temp folder (never in the repo).
process.env.E2E_SCRATCH ||= mkdtempSync(join(tmpdir(), "mach-video-"));

const { buildHost } = await import(join(e2eLib, "build.mjs"));
const { createWorld } = await import(join(e2eLib, "world.mjs"));
const { startHost } = await import(join(e2eLib, "host.mjs"));
const { specFor, whyFor } = await import(join(e2eLib, "content.mjs"));

export const INTERVIEW_SLICE = "SLICE-004";

/** The scripted interviewer's turns: three questions, a summary to confirm, then the written spec. */
export const turns = [
  {
    kind: "question",
    number: 1,
    title: "Who it is for",
    body: "Is this slice only for a workspace admin who invites one teammate at a time, by email?",
    recommendation: "Yes. Inviting several people at once can wait for a later slice, so this one stays small.",
  },
  {
    kind: "question",
    number: 2,
    title: "How long an invitation lasts",
    body: "Should an invitation expire if the teammate has not accepted it within seven days?",
    recommendation: "Yes. An expired link cannot leave access lingering, and the admin can send a new one.",
  },
  {
    kind: "question",
    number: 3,
    title: "An address that is already a member",
    body: "If the admin invites someone who already belongs to the workspace, should we send nothing and say so?",
    recommendation: "Yes. Show “already a member” and send no email, so nobody receives a second invitation.",
  },
  {
    kind: "summary",
    text:
      "Here is what I have so far.\n\n" +
      "- **Who:** a workspace admin invites one teammate at a time, by email.\n" +
      "- **Expiry:** an invitation that is not accepted within seven days stops working; the admin can send a new one.\n" +
      "- **Duplicates:** inviting someone who is already a member sends nothing and says so.\n\n" +
      "Does this capture the intent? If so I will write it up as the slice specification.",
  },
  { kind: "write_spec" },
];

/** A project that reads like a real one: three epics, slices in every state. Built through the real engine. */
function seed(world) {
  const pm = world.pm;
  const ok = (...argv) => {
    const r = world.studio(pm, ...argv);
    if (r.code !== 0) throw new Error(`studio ${argv.join(" ")}: ${r.stderr}${r.stdout}`);
    return r.json;
  };
  const write = (rel, text) => {
    const path = join(pm, ".factory/studio/draft", rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const slice = (epic, id, title, state) => {
    ok("slice", "new", "--epic", epic, "--title", title);
    if (state === "draft") return null;
    write(`specs/slices/${id}-${title.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}.md`, specFor(id));
    write(`product/intents/${id}.md`, whyFor(id));
    const { issue } = ok("slice", "ready", id);
    if (state === "building") world.setStateLabel(issue, "mach:building");
    if (state === "shipped") world.setStateLabel(issue, "mach:shipped");
    return issue;
  };
  ok("project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction, and admins stay in control of who has access.", "--outcome", "Teams can start working together in minutes", "--outcome", "Admins always know who has access");
  ok("epic", "add", "--title", "Accounts and sign-in", "--criterion", "People sign in with their work email", "--criterion", "A lost password is never a dead end");
  slice("EPIC-001", "SLICE-001", "Sign in with a work email", "shipped");
  slice("EPIC-001", "SLICE-002", "Reset a forgotten password", "shipped");
  slice("EPIC-001", "SLICE-003", "Ask for a second step at sign-in", "building");
  ok("epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited");
  slice("EPIC-002", INTERVIEW_SLICE, "Invite a teammate", "draft");
  slice("EPIC-002", "SLICE-005", "Remove a teammate", "ready");
  slice("EPIC-002", "SLICE-006", "Change a teammate's role", "ready");
  ok("epic", "add", "--title", "Workspace settings", "--criterion", "Admins can rename and brand the workspace");
  slice("EPIC-003", "SLICE-007", "Rename the workspace", "building");
  slice("EPIC-003", "SLICE-008", "Choose a workspace logo", "draft");
  ok("refresh");
}

/** Builds the host, makes the world, seeds it, starts the host. Returns what a capture needs. */
export async function startStudio() {
  const { binary } = buildHost();
  const world = createWorld({ claude: "fake", turns });
  // Our copy of the stand-in claude: the e2e one plus a "summary" turn (a message that asks to confirm).
  const shebang = readFileSync(join(world.bin, "claude"), "utf8").split("\n")[0];
  const copy = readFileSync(join(here, "fakes/claude.py"), "utf8").replace(/^#!.*\n/, shebang + "\n");
  writeFileSync(join(world.bin, "claude"), copy);
  chmodSync(join(world.bin, "claude"), 0o755);
  seed(world);
  const host = await startHost(binary, world.pm, world.env);
  return {
    world,
    host,
    async stop() {
      await host.stop();
      world.cleanup();
      rmSync(process.env.E2E_SCRATCH, { recursive: true, force: true });
    },
  };
}

/** Crisp text: a 1280x720 layout drawn at 1.5x, recorded as 1920x1080 pixels (CSS zoom; see README notes). */
export const ZOOM = 1.5;
export const VIEWPORT = { width: 1920, height: 1080 };

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------
import { chromium } from "playwright";
import { recordPage } from "testreel";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
export const footageDir = join(videoRoot, "public/footage");
export const rawDir = join(videoRoot, "capture/raw/studio");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The 1.5x browser zoom of a 1920x1080 window, so text is drawn at 1920x1080 pixels. Playwright's video is
 * recorded at CSS-pixel size (a device scale factor does not reach it), so the zoom is CSS `zoom` on the
 * page, plus the few viewport-unit rules of the design system divided by the zoom, so the layout is the
 * one a real 1280x720 window has (the full-height shell, the dialog's offset and height).
 */
export async function applyZoom(page) {
  const z = ZOOM;
  const css = `html{zoom:${z}}
.h-dvh{height:${100 / z}dvh!important}
body{min-height:${100 / z}vh!important}
[class*="top-[12vh]"]{top:${12 / z}vh!important}
[class*="max-h-[76vh]"]{max-height:${76 / z}vh!important}
[class*="w-[calc(100vw-2rem)]"]{width:calc(${100 / z}vw - 2rem)!important}`;
  await page.addInitScript((css) => {
    const add = () => {
      const el = document.createElement("style");
      el.textContent = css;
      document.head.appendChild(el);
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", add) : add();
  }, css);
}

/** One browser, and a logged-in storage state (the host's one-time URL is exchanged once). */
export async function openBrowser(studio) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(studio.host.url);
  await page.getByRole("main").waitFor();
  const state = await ctx.storageState();
  await ctx.close();
  return { browser, state };
}

/** Waits until nothing on screen says it is loading (the e2e settle, plus fonts). */
export async function settle(page, ms = 300) {
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[aria-busy="true"]') &&
        ![...document.querySelectorAll('[role="status"]')].some((n) => /^(Checking|Reading|Loading)/.test((n.textContent ?? "").trim())),
      undefined,
      { timeout: 30000 },
    )
    .catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Smooth, eased scroll of the page to a fraction (0 top, 1 bottom) of its scrollable length, or, given a
 * locator, until that element's top sits `gap` screen pixels below the top of the page area.
 */
export async function glide(page, to, ms, gap = 130) {
  const target = typeof to === "number" ? null : await to.elementHandle();
  await page.evaluate(
    ({ to, ms, target, gap }) =>
      new Promise((done) => {
        const main = document.querySelector("main");
        const el = main && main.scrollHeight > main.clientHeight + 4 ? main : document.scrollingElement;
        const from = el.scrollTop;
        const max = el.scrollHeight - el.clientHeight;
        const goal = target ? Math.min(max, Math.max(0, from + (target.getBoundingClientRect().top - (el === main ? main.getBoundingClientRect().top : 0) - gap) / 1.5)) : max * to;
        const start = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const tick = (now) => {
          const t = Math.min((now - start) / ms, 1);
          el.scrollTop = from + (goal - from) * ease(t);
          t < 1 ? requestAnimationFrame(tick) : done();
        };
        requestAnimationFrame(tick);
      }),
    { to: typeof to === "number" ? to : 0, ms, target, gap },
  );
}

/**
 * Records one clip. `body(rec, page, t)` drives the page through testreel's recorder (animated cursor);
 * `t.mark(label)` notes the time in the final clip. Writes <footageDir>/<name>.mp4 (1920x1080 H.264)
 * and <rawDir>/<name>.marks.json.
 */
export async function clip({ browser, state, studio, name, route, ready, body, compress = [], keepRaw = true }) {
  const out = join(rawDir, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(footageDir, { recursive: true });
  const t0 = Date.now();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "light",
    storageState: state,
    bypassCSP: true, // only so the zoom stylesheet below can be added; nothing else changes
    recordVideo: { dir: out, size: VIEWPORT },
  });
  const page = await ctx.newPage();
  await applyZoom(page);
  await page.goto(`${studio.host.origin}/#${route}`);
  if (ready) await ready(page);
  await settle(page, 600);
  const rec = await recordPage(page, { outputDir: out, name, cursor: { size: 40, style: "default", rippleSize: 70, idleHide: false }, videoStartedAt: t0, outputFormat: "webm", keepIntermediates: false });
  const startAt = (Date.now() - t0) / 1000;
  const marks = [];
  const mp4 = join(footageDir, `${name}.mp4`);
  const t = { mark: (label) => marks.push({ t: +((Date.now() - t0) / 1000 - startAt).toFixed(2), label }), page };
  try {
    await body(rec, page, t);
  } finally {
    const res = await rec.stop();
    const webm = res.video;
    // Waiting for the engine (a real wait on screen, e.g. while GitHub is written to) is played faster so no
    // stretch of the clip is dead: each `compress` entry [fromLabel, toLabel, maxSeconds] shortens that span.
    const at = (label) => marks.find((m) => m.t !== undefined && m.label === label)?.t;
    const spans = compress
      .map(([a, b, max]) => ({ from: at(a), to: at(b), max }))
      .filter((c) => c.from !== undefined && c.to !== undefined && c.to - c.from > c.max)
      .sort((x, y) => x.from - y.from);
    let cursor = 0;
    const pieces = [];
    for (const c of spans) {
      if (c.from > cursor) pieces.push({ a: cursor, b: c.from, f: 1 });
      pieces.push({ a: c.from, b: c.to, f: (c.to - c.from) / c.max });
      cursor = c.to;
    }
    pieces.push({ a: cursor, b: null, f: 1 });
    const graph =
      pieces.map((p, i) => `[0:v]trim=start=${p.a}${p.b === null ? "" : `:end=${p.b}`},setpts=(PTS-STARTPTS)/${p.f}[p${i}]`).join(";") +
      `;${pieces.map((_, i) => `[p${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0,scale=1920:1080:flags=lanczos,fps=30,format=yuv420p[out]`;
    const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-ss", String(startAt), "-i", webm, "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-movflags", "+faststart", "-an", mp4], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    // marks after a shortened span move earlier
    for (const m of marks) {
      let shift = 0;
      for (const c of spans) {
        if (m.t >= c.to) shift += c.to - c.from - c.max;
        else if (m.t > c.from) shift += (m.t - c.from) * (1 - c.max / (c.to - c.from));
      }
      m.t = +(m.t - shift).toFixed(2);
    }
    writeFileSync(join(rawDir, `${name}.marks.json`), JSON.stringify(marks, null, 2));
    if (!keepRaw) rmSync(out, { recursive: true, force: true });
  }
  return { mp4, marks };
}

export function probe(file) {
  const r = spawnSync("/opt/homebrew/bin/ffprobe", ["-v", "error", "-show_entries", "stream=width,height,codec_name,pix_fmt:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  return { duration: +j.format.duration, ...j.streams[0] };
}

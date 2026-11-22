// Shared set-up for the third film's Product Studio "Shape" clips.
//
// World: Product Studio's own fixture mode (`vite --mode fixtures`, sample data from web/fixtures, no host, no
// engine, no claude). The Shape conversation is the app's scripted one. Recording is the same as the first film's
// Studio clips (testreel, animated pointer, 1280x720 layout drawn at 1.5x = 1920x1080, 30 fps, light theme); this
// file's `clip` is studio/lib.mjs's with a full URL (fixture parameters come before the hash) and a data patch.
//
// The fixtures were generated in separate scenarios, so the same idea carries different ids and titles in
// different files. `alignIdea` makes the served fixture JSON of the Shape operations say IDEA-002 and the film's title
// (text substitution on the way into the page; no tracked file is touched). Everything is on 127.0.0.1.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { recordPage } from "testreel";
import { applyZoom, settle, glide, probe, sleep, VIEWPORT, footageDir, rawDir } from "../studio/lib.mjs";

export { glide, probe, sleep, settle, footageDir, rawDir, applyZoom, VIEWPORT };
export const ORIGIN = process.env.SHAPE_ORIGIN ?? "http://127.0.0.1:5290";
export const FFMPEG = "/opt/homebrew/bin/ffmpeg";
export const IDEA = "IDEA-002";
export const TITLE = "Let members renew a loan themselves";

// Titles other scenarios gave the same idea.
const OTHER_TITLES = ["Reserve a study room online", "Renew loans from the catalogue", "Renew loans and pay fines in one place", "Renew one loan from my loans", "Members pay fines online"];
const ALIGN = /\/fixtures\/((idea\.(show|map-status|chain|size|map|settle|apply|publish|lookups|stage)|brief\.(show|check)|case\.(show|check)|verdict\.record|lookback\.record)[\w.-]*)\.json\?import/;
// Which idea of a one-idea status variant is the film's (the renewal idea is IDEA-001 in most, IDEA-002 in -routes).
const ROW_OF = { "status.ideas-routes": "IDEA-002" };
const STATUS = /\/fixtures\/(status\.ideas-[\w-]+)\.json\?import/;
const SLICE = /\/fixtures\/(slice\.show\.(policy-followed|effects|four-mocks|from-idea)|slice\.mock\.list[\w.-]*)\.json\?import/;

/** The film's one slice, and what the other scenarios' invitation slices say, in the film's words. */
export const SLICE_ID = "SLICE-005";
export const SLICE_TITLE = "Renew a loan from my loans";
const SLICE_WORDS = [
  ["Invite a teammate by email", SLICE_TITLE],
  ["Invite a teammate", SLICE_TITLE],
  ["SLICE-002/FR-01", "SLICE-001/FR-01"],
  ["A resent invitation still counts against the seats.", "A renewal notice goes out the same way as any other."],
  ["Admin invites a teammate", "Member renews a loan"],
  ["The invite form", "The Renew button on My loans"],
  ["\"slice_id\":\"SLICE-002\"", "\"slice_id\":\"SLICE-001\""],
];

/** One route for the whole idea: the engine's several-epics capture, told as the epic the film's size step names. */
const asEpic = (text) =>
  text
    .replaceAll('"several-epics"', '"epic"')
    .replaceAll('"several epics"', '"an epic"')
    .replaceAll("The brief's outcomes are in 2 different capabilities, so the route is several epics.", "The brief has 2 outcomes inside one capability, so the route is an epic.")
    .replaceAll('"capabilities":2', '"capabilities":1')
    .replaceAll('["Lending","Member account"]', '["Lending"]');
const retitle = (text) => {
  text = text.replace(/IDEA-00\d/g, IDEA);
  for (const t of OTHER_TITLES) text = text.split(t).join(TITLE);
  return text;
};
const module_ = (route, text) => route.fulfill({ status: 200, contentType: "text/javascript", body: `export default ${text};` });
const raw = (route) => route.request().url().replace("?import", "");
const parsed = async (route, url = raw(route)) => JSON.parse(await (await route.fetch({ url })).text());

/** The top bar reads "Everything is saved": the samples were captured mid-work, and the film's story is not about saving. */
const SAVED = { everything_saved: true, note: "Everything is saved.", not_saved: [] };
const saved = (json) => (json?.data?.saved && (json.data.saved = SAVED), json);

export async function alignIdea(ctx) {
  // Registered first, so the handlers below (registered later) answer for the files they name.
  await ctx.route(/\/fixtures\/status\.[\w.-]+\.json\?import/, async (route) => module_(route, JSON.stringify(saved(await parsed(route)))));
  await ctx.route(ALIGN, async (route) => module_(route, asEpic(retitle(JSON.stringify(await parsed(route))))));
  // The one-idea status variants (the same idea at later stages) are made to be the board's IDEA-002: the default
  // board with its IDEA-002 row replaced by the variant's idea, so every screen's stepper reads that stage.
  await ctx.route(STATUS, async (route) => {
    const base = await parsed(route, route.request().url().replace(/status\.ideas-[\w-]+\.json\?import/, "status.ideas.json"));
    const variant = await parsed(route);
    const name = route.request().url().match(STATUS)[1];
    const row = JSON.parse(asEpic(retitle(JSON.stringify(variant.data.ideas.ideas.find((r) => r.idea_id === (ROW_OF[name] ?? "IDEA-001")) ?? variant.data.ideas.ideas[0]))));
    base.data.ideas.ideas[base.data.ideas.ideas.findIndex((r) => r.idea_id === IDEA)] = row;
    module_(route, JSON.stringify(saved(base)));
  });
  // The board's own sample: the idea is being explored, so the board opens it at Explore (the sample's engine run
  // had already written its brief, and says "Check the brief" next).
  await ctx.route(/\/fixtures\/status\.ideas\.json\?import/, async (route) => {
    const json = await parsed(route);
    const row = json.data.ideas.ideas.find((r) => r.idea_id === IDEA);
    row.next = { kind: "explore", sentence: `Explore ${IDEA}: open questions, one at a time.` };
    module_(route, JSON.stringify(saved(json)));
  });
  // The slice pages' fixtures are for invitation slices; they are made to be the slice the idea was shaped into.
  await ctx.route(SLICE, async (route) => {
    const json = await parsed(route);
    // The sample's pictures are 4x3 and 5x2 pixels; the stand-in picture is the size it is drawn.
    for (const m of json.data?.mocks ?? []) Object.assign(m, { width: 960, height: 600, bytes: 25469, format: "png", file: m.file.replace(/\.jpg$/, ".png") });
    const own = json.data?.slice?.slice_id ?? json.data?.slice_id;
    let text = JSON.stringify(json);
    if (own) text = text.replaceAll(`"${own}"`, `"${SLICE_ID}"`);
    for (const [from, to] of SLICE_WORDS) text = text.split(from).join(to);
    module_(route, text);
  });
  // A design mock's picture is served by the host; fixture mode has none, so a drawn one stands in.
  await ctx.route(/\/api\/slices\/[\w-]+\/mocks\/[0-9a-f]+/, (route) => route.fulfill({ status: 200, contentType: "image/png", path: MOCK_PNG }));
}

export const MOCK_PNG = join(import.meta.dirname, "mock-my-loans.png");

/** Sets the fixture parameters (the query before the hash) without leaving the page, for the next read. */
export const setQuery = (page, query) => page.evaluate((q) => history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`), query);

export async function openBrowser() {
  return { browser: await chromium.launch() };
}

/**
 * Records one clip into <footageDir>/<name>.mp4. `url` is everything after the origin (query before the hash).
 * `body(rec, page, t)` drives the page; `t.mark(label)` notes a time in the finished clip.
 */
export async function clip({ browser, name, url, ready, body, align = true, compress = [] }) {
  const out = join(rawDir, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(footageDir, { recursive: true });
  const t0 = Date.now();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "light",
    bypassCSP: true,
    recordVideo: { dir: out, size: VIEWPORT },
  });
  if (align) await alignIdea(ctx);
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console ${m.text().slice(0, 160)}`));
  await ctx.addInitScript(() => { try { localStorage.setItem("mach.theme", "light"); } catch {} });
  // The "Fixture data" badge says where the sample data comes from; it is not part of the product a viewer would see.
  await ctx.addInitScript(() => {
    const hide = () => { for (const el of document.querySelectorAll("header span, header div")) if (el.childElementCount === 0 && el.textContent.trim() === "Fixture data") el.style.display = "none"; };
    new MutationObserver(hide).observe(document, { childList: true, subtree: true });
  });
  await applyZoom(page);
  await page.goto(`${ORIGIN}/${url}`);
  if (ready) await ready(page);
  await settle(page, 600);
  const rec = await recordPage(page, { outputDir: out, name, cursor: { size: 40, style: "default", rippleSize: 70, idleHide: false }, videoStartedAt: t0, outputFormat: "webm", keepIntermediates: false });
  const startAt = (Date.now() - t0) / 1000;
  const marks = [];
  const mp4 = join(footageDir, `${name}.mp4`);
  const t = { mark: (label) => marks.push({ t: +((Date.now() - t0) / 1000 - startAt).toFixed(2), label }), page };
  const realMarks = marks;
  try {
    await body(rec, page, t);
  } finally {
    const res = await rec.stop();
    const at = (label) => marks.find((m) => m.label === label)?.t;
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
    const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-ss", String(startAt), "-i", res.video, "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-movflags", "+faststart", "-an", mp4], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    if (process.env.SHAPE_DEBUG) console.log("real marks", JSON.stringify(marks), JSON.stringify(spans));
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
  }
  if (problems.length) console.log(`  [${name}] page problems:`, [...new Set(problems)].slice(0, 5));
  return { mp4, marks };
}

export function report(results) {
  for (const r of results) {
    const p = probe(r.mp4);
    console.log(`\n${r.mp4}\n  ${p.width}x${p.height} ${p.codec_name} ${p.pix_fmt} ${p.duration.toFixed(2)} s`);
    for (const m of r.marks) console.log(`  ${m.t.toFixed(1).padStart(5)} s  ${m.label}`);
  }
}

/** Removes the scratch folder studio/lib.mjs makes on import (nothing in it is used here). */
export const cleanup = () => rmSync(process.env.E2E_SCRATCH, { recursive: true, force: true });

/**
 * Smooth, eased scroll of whichever pane holds `locator` (the nearest scrollable ancestor) until the element's top sits
 * `gap` CSS pixels below the pane's top (the page is drawn at 1.5x, so `gap` is in the 1280x720 layout's pixels).
 */
export async function paneGlide(locator, ms, gap = 24) {
  const h = await locator.elementHandle();
  await h.evaluate(
    (el, { ms, gap }) =>
      new Promise((done) => {
        let pane = el.parentElement;
        while (pane && !(pane.scrollHeight > pane.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
        pane ||= document.scrollingElement;
        const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        const top = pane === document.scrollingElement ? 0 : pane.getBoundingClientRect().top;
        const from = pane.scrollTop;
        const goal = Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, from + (el.getBoundingClientRect().top - top) / z - gap));
        const start = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const tick = (now) => {
          const t = Math.min((now - start) / ms, 1);
          pane.scrollTop = from + (goal - from) * ease(t);
          t < 1 ? requestAnimationFrame(tick) : done();
        };
        requestAnimationFrame(tick);
      }),
    { ms, gap },
  );
}

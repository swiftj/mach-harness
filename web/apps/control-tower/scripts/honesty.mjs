// Independent verification of the M6.0 prototype's honesty rules (M6_0_CONTRACT.md section 2).
//
//   node scripts/honesty.mjs            # writes screenshots/_honesty/report.json and the evidence images
//
// (a) No network request at run time: every request during a full playback and the interactions is
//     recorded; only same-origin static assets are allowed.
// (b) The M5 Content-Security-Policy: the capture build is served by this script's own static server
//     (lib.mjs startCspServer) with the M5 host's headers, played through in both views, Theater Mode
//     and both themes; every securitypolicyviolation event and console error is recorded.
// (c) Source scan for Math.random, Date.now, performance.now, new Date, timers and requestAnimationFrame.
// (d) Determinism: ten playhead times rendered twice in fresh pages by three routes (seek directly,
//     play to it on the manual clock, scrub back to it), both views, compared pixel for pixel.
// (e) Every moving thing has an event: 20 frames sampled during playback at a fixed camera, the
//     entities that changed between adjacent frames, and the fixture event behind each change.
// (f) The Simulation label in every captured state (checked here for both views, Theater, the help
//     sheet, both themes and 1100 wide; capture.mjs and record.mjs check every shot and every frame).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium } from "playwright";
import { app, args, ensureBuild, frames, log, openApp, S, sim, sleep, startCspServer } from "./lib.mjs";

const out = join(app, "screenshots", "_honesty");
mkdirSync(out, { recursive: true });
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const CSP_PORT = 4187;
const report = { generated: new Date().toISOString() };

// ---------------------------------------------------------------- (c) source scan (no browser)
function scanSources() {
  const src = join(app, "src");
  const patterns = [
    ["Math.random", /Math\.random\s*\(/],
    ["Date.now", /Date\.now\s*\(/],
    ["new Date", /new Date\s*\(/],
    ["performance.now", /performance\.now\s*\(/],
    ["setTimeout", /setTimeout\s*\(/],
    ["setInterval", /setInterval\s*\(/],
    ["requestAnimationFrame", /requestAnimationFrame\s*\(/],
  ];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name.name)) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
            for (const [label, re] of patterns) if (re.test(code)) hits.push({ file: relative(app, path), line: i + 1, call: label, text: line.trim().slice(0, 140) });
          });
      }
    }
  };
  walk(src);
  return hits;
}

// ---------------------------------------------------------------- helpers
async function watch(page, origin) {
  const requests = [];
  const violations = [];
  const errors = [];
  page.on("request", (r) => requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.exposeFunction("__capCsp", (v) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => window.__capCsp({ directive: e.violatedDirective, blocked: e.blockedURI, source: `${e.sourceFile}:${e.lineNumber}`, sample: e.sample }));
  });
  return {
    summary() {
      const external = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:"));
      const dataUris = requests.filter((r) => r.url.startsWith("data:")).map((r) => `${r.type}: ${r.url.slice(0, 40)}`);
      const nonStatic = requests.filter((r) => r.url.startsWith(origin) && !["document", "script", "stylesheet", "font", "image"].includes(r.type));
      const byType = {};
      for (const r of requests) byType[r.type] = (byType[r.type] ?? 0) + 1;
      return { total: requests.length, byType, external, nonStatic, dataUris: [...new Set(dataUris)], urls: [...new Set(requests.map((r) => r.url.replace(origin, "")))].sort(), violations, errors };
    },
  };
}

/** Play the whole run at 16x on the live clock, poking every interactive surface on the way. */
async function playThrough(page) {
  await page.evaluate(() => {
    const s = window.__machSim;
    s.useLiveClock();
    s.seek(0);
    s.setSpeed(16);
    s.play();
  });
  const views = ["atlas", "blueprint"];
  for (let i = 0; i < 24; i++) {
    await sleep(1000);
    if (i % 4 === 1) await sim(page, "setMode", views[(i >> 2) % 2]);
    if (i === 6) await sim(page, "select", "cell:LOCAL-031");
    if (i === 9) await sim(page, "setTheater", true);
    if (i === 12) await sim(page, "setTheater", false);
    if (i === 14) await page.keyboard.press("?");
    if (i === 15) await page.keyboard.press("Escape");
    if (i === 16) await page.getByRole("radio", { name: "Light theme" }).check({ force: true });
    if (i === 19) await page.getByRole("radio", { name: "Dark theme" }).check({ force: true });
  }
  return page.evaluate(() => window.__machSim.state());
}

/**
 * Switch the light layer on from the help sheet and read its canvas: `.atlas-effects-layer canvas`
 * (the first canvas on the page is the timeline's). Its size is compared with the Atlas stage. WebGL
 * may be missing in headless Chromium (software), in which case the layer must stay off.
 */
async function lightLayerCheck(page) {
  await sim(page, "setMode", "atlas");
  await sleep(900);
  await page.locator("body").click({ position: { x: 900, y: 20 } });
  await page.keyboard.press("?");
  await page.getByRole("dialog").waitFor({ timeout: 5000 }).catch(() => {});
  const lightSwitch = page.getByRole("dialog").getByRole("switch").first();
  if (!(await lightSwitch.count())) return { result: "switch not found" };
  await lightSwitch.click();
  const switchedOn = await lightSwitch.getAttribute("aria-checked");
  await page.keyboard.press("Escape");
  await sim(page, "seek", S(640));
  await sim(page, "play");
  await sleep(3000);
  const read = () =>
    page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      const c = document.querySelector("[data-stage-active] .atlas-effects-layer canvas") ?? document.querySelector(".atlas-effects-layer canvas");
      const stage = document.querySelector("[data-stage-active] .atlas-viewport") ?? document.querySelector("[data-stage-active] [data-view=atlas]");
      const sb = stage?.getBoundingClientRect();
      const cb = c?.getBoundingClientRect();
      return {
        webgl: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "yes") : "no WebGL",
        layerHost: Boolean(document.querySelector(".atlas-effects-layer")),
        canvas: c ? { backing: [c.width, c.height], css: [Math.round(cb.width), Math.round(cb.height)], ariaHidden: c.closest("[aria-hidden=true]") ? "yes" : c.getAttribute("aria-hidden"), pointerEvents: getComputedStyle(c).pointerEvents } : null,
        stage: sb ? [Math.round(sb.width), Math.round(sb.height)] : null,
        timelineCanvasesFirst: document.querySelector("canvas")?.closest("section") ? "the first canvas on the page is the timeline's" : "the first canvas is not the timeline's",
      };
    });
  const first = await read();
  // Resize the window: the canvas must follow the stage.
  await page.setViewportSize({ width: 1600, height: 900 });
  await sleep(1200);
  const resized = await read();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await sleep(600);
  await sim(page, "pause");
  return { switchedOn, first, afterResizeTo1600x900: resized };
}

const rawHash = (png) => execFileSync(FFMPEG, ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
const md5 = (b) => createHash("md5").update(b).digest("hex");

// ---------------------------------------------------------------- run
ensureBuild();
report.c_sourceScan = scanSources();
log("source scan:", report.c_sourceScan.length, "hits");

const server = await startCspServer({ port: CSP_PORT });
const origin = server.origin;
const browser = await chromium.launch();
try {
  // (a) and (b): one play-through under the M5 CSP, recording every request.
  {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    const page = await context.newPage();
    const w = await watch(page, origin);
    await page.goto(`${origin}/?theme=dark#atlas`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__machSim));
    const end = await playThrough(page);
    // The optional WebGL light layer (off by default) is switched on in the help sheet: check it too,
    // under the same policy, recording its requests with the rest.
    const lightLayer = await lightLayerCheck(page);
    report.a_network_b_csp = { origin, csp: "M5 host policy (lib.mjs M5_CSP)", endState: end, lightLayer, ...w.summary() };
    await context.close();
    log("network/CSP:", report.a_network_b_csp.total, "requests,", report.a_network_b_csp.external.length, "external,", report.a_network_b_csp.violations.length, "CSP violations,", report.a_network_b_csp.errors.length, "errors");
  }

  // (d) determinism.
  {
    const times = [0, 34, 640, 1601, 1652, 1940, 2567, 2622, 2852, 3125];
    const results = [];
    const routes = {
      async seek(page, t) {
        await sim(page, "seek", S(t));
      },
      async playTo(page, t) {
        // From 10 factory seconds before, at 1x on the manual clock: 1000 ms of wall time in 250 ms frames.
        const from = Math.max(0, t - 10);
        await sim(page, "seek", S(from));
        await sim(page, "setSpeed", 1);
        await sim(page, "play");
        await page.evaluate((ms) => window.__machSim.advance(ms, 250), (t - from) * 100);
        await sim(page, "pause");
      },
      async scrubBack(page, t) {
        // Past it, then a real drag on the playhead strip back towards it, then the exact time.
        await sim(page, "seek", S(Math.min(3350, t + 300)));
        await frames(page, 2);
        const bar = await page.locator('[role=slider][aria-label="Playhead over the whole run"]').boundingBox();
        const x = (s) => bar.x + (S(s) / 3350200) * bar.width;
        await page.mouse.move(x(Math.min(3350, t + 300)), bar.y + bar.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) await page.mouse.move(x(Math.min(3350, t + 300) - (300 * i) / 12 + 3), bar.y + bar.height / 2);
        await page.mouse.up();
        await page.mouse.move(800, 20);
        await sim(page, "seek", S(t));
      },
    };
    for (const view of ["atlas", "blueprint"]) {
      for (const t of times) {
        const hashes = {};
        let first = null;
        for (const [route, go] of Object.entries(routes)) {
          for (const pass of [1, 2]) {
            const { context, page } = await openApp(browser, { origin, view, theme: "dark" });
            await sim(page, "setFollow", false);
            await go(page, t);
            // The camera is interface state, not factory state: put it at the same framing in every page
            // (the Atlas at its fit, instantly; the Blueprint after its first placement has settled).
            if (view === "atlas") await page.evaluate(() => window.__atlasCamera.fit());
            await sleep(view === "blueprint" ? 1800 : 700);
            await frames(page, 3);
            const stage = join(out, `det-${view}-${String(t).padStart(4, "0")}-${route}-${pass}.png`);
            await page.locator("#stage").screenshot({ path: stage });
            const playhead = (await page.evaluate(() => window.__machSim.state())).playhead;
            const camera = view === "atlas" ? await page.evaluate(() => JSON.stringify(window.__atlasCamera.get())) : await page.evaluate(() => document.querySelector('[data-stage-view="blueprint"] [style*="scale("]')?.style.transform ?? null);
            // The markup of the stage and the inspector: what the app rendered, before rasterization.
            // Both views stay mounted; the hidden one is brought up to date in batches (every 500 ms of
            // wall time), so its markup is interface state. Compare the active view, and record the whole
            // stage separately.
            // React's useId values (`_r_f_`, pattern and marker ids) depend on mount order, which now
            // depends on when the hidden view was prepared (idle time): interface identity, not the
            // scene. They are normalised; the raw markup's hash is kept as `rawDom`.
            const rawDomText = await page.evaluate(() => document.querySelector("#stage [data-stage-active]").outerHTML + (document.querySelector("aside")?.innerText ?? ""));
            // Canonical markup: attributes sorted by name and inline style declarations sorted, so the
            // order React happened to set them in (which differs by route) does not count as a difference.
            const canonical = await page.evaluate(() => {
              const ser = (n) => {
                if (n.nodeType === 3) return n.textContent;
                if (n.nodeType !== 1) return "";
                const attrs = [...n.attributes]
                  .map((a) => [a.name, a.name === "style" ? a.value.split(";").map((x) => x.trim()).filter(Boolean).sort().join("; ") : a.value])
                  .sort((x, y) => (x[0] < y[0] ? -1 : 1))
                  .map(([k, v]) => `${k}="${v}"`)
                  .join(" ");
                return `<${n.tagName.toLowerCase()} ${attrs}>${[...n.childNodes].map(ser).join("")}</${n.tagName.toLowerCase()}>`;
              };
              return ser(document.querySelector("#stage [data-stage-active]")) + (document.querySelector("aside")?.innerText ?? "");
            });
            const dom = canonical.replace(/_r_[a-z0-9]+_/g, "_r_ID_");
            if (pass === 1) writeFileSync(join(out, `det-dom-${view}-${String(t).padStart(4, "0")}-${route}.html`), dom.replace(/></g, ">\n<"));
            const wholeStage = await page.evaluate(() => document.getElementById("stage").outerHTML);
            const raw = rawHash(stage);
            first ??= raw;
            let differing = 0;
            let maxDelta = 0;
            for (let i = 0; i < raw.length; i += 4) {
              const d = Math.max(Math.abs(raw[i] - first[i]), Math.abs(raw[i + 1] - first[i + 1]), Math.abs(raw[i + 2] - first[i + 2]));
              if (d) {
                differing++;
                maxDelta = Math.max(maxDelta, d);
              }
            }
            hashes[`${route}#${pass}`] = { md5: md5(raw), dom: md5(Buffer.from(dom)), rawDom: md5(Buffer.from(rawDomText)), wholeStage: md5(Buffer.from(wholeStage)), playhead, camera, pixelsDifferingFromFirst: differing, share: Number((differing / (raw.length / 4)).toFixed(5)), maxDelta };
            await context.close();
          }
        }
        const distinct = [...new Set(Object.values(hashes).map((h) => h.md5))];
        const doms = [...new Set(Object.values(hashes).map((h) => h.dom))];
        const sameRouteSameRaw = Object.keys(routes).every((r) => hashes[`${r}#1`].rawDom === hashes[`${r}#2`].rawDom);
        const sameRouteSame = Object.keys(routes).every((r) => hashes[`${r}#1`].dom === hashes[`${r}#2`].dom);
        const wholes = [...new Set(Object.values(hashes).map((h) => h.wholeStage))];
        const worst = Math.max(...Object.values(hashes).map((h) => h.share));
        results.push({ view, t, sameRouteTwiceIdentical: sameRouteSame, sameRouteTwiceIdenticalRawIds: sameRouteSameRaw, wholeStageVariants: wholes.length, domIdentical: doms.length === 1, domVariants: doms.length, routesAgree: Object.fromEntries(Object.keys(routes).map((r) => [r, hashes[`${r}#1`].dom === hashes["seek#1"].dom])), pixelIdentical: distinct.length === 1, distinctRasters: distinct.length, worstPixelShare: worst, hashes });
        log(`determinism ${view} ${t}s: markup ${doms.length === 1 ? "identical" : `${doms.length} variants`}; pixels ${distinct.length === 1 ? "identical" : `${distinct.length} rasters, worst ${(worst * 100).toFixed(2)}% of pixels`}`);
      }
    }
    report.d_determinism = results;
  }

  // (e) every moving thing has an event.
  {
    const { context, page } = await openApp(browser, { origin, view: "atlas", theme: "dark" });
    await sim(page, "setFollow", false);
    const samples = [];
    // Twenty frames in four busy windows, 1x, 30 fps on the manual clock, camera fixed at fit.
    for (const start of [645, 1462, 1638, 2608, 3258]) {
      await sim(page, "seek", S(start));
      await sim(page, "setSpeed", 1);
      await sim(page, "play");
      let prev = await snapshotEntities(page);
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.__machSim.advance(1000 / 30, 1000 / 30));
        await frames(page, 1);
        const next = await snapshotEntities(page);
        const changed = Object.keys(next.refs).filter((k) => prev.refs[k] !== next.refs[k]);
        const appeared = changed.filter((k) => !(k in prev.refs));
        const layers = Object.keys(next.layers).filter((k) => prev.layers[k] !== next.layers[k]);
        const loose = Object.keys(next.loose).filter((k) => prev.loose[k] !== next.loose[k]).map((k) => `${k} ${next.looseText[k] ?? ""}`.trim());
        samples.push({ t0: prev.t, t1: next.t, changed, appeared, unrefLayersChanged: layers, unrefElementsChanged: loose.slice(0, 12) });
        prev = next;
      }
      await sim(page, "pause");
    }
    report.e_motionSamples = samples;
    await context.close();
  }

  // (f) the Simulation label in every state.
  {
    const states = [];
    for (const theme of ["dark", "light"]) {
      for (const [name, setup, width, reducedMotion = "no-preference"] of [
        ["atlas", async () => {}, 1920],
        ["blueprint", async (p) => sim(p, "setMode", "blueprint"), 1920],
        ["theater-atlas", async (p) => sim(p, "setTheater", true), 1920],
        ["theater-blueprint", async (p) => (await sim(p, "setMode", "blueprint"), sim(p, "setTheater", true)), 1920],
        ["help", async (p) => p.keyboard.press("?"), 1920],
        ["atlas-1100", async () => {}, 1100],
        ["atlas-selected-1100", async (p) => sim(p, "select", "cell:LOCAL-031"), 1100],
        ["atlas-200%-960x540", async () => {}, 960],
        ["blueprint-200%-960x540-selected", async (p) => (await sim(p, "setMode", "blueprint"), sim(p, "select", "cell:LOCAL-031")), 960],
        ["theater-200%-960x540", async (p) => sim(p, "setTheater", true), 960],
        ["atlas-reduced-motion", async () => {}, 1920, "reduce"],
        ["blueprint-reduced-motion", async (p) => sim(p, "setMode", "blueprint"), 1920, "reduce"],
      ]) {
        const height = width === 1100 ? 800 : width === 960 ? 540 : 1080;
        const { context, page } = await openApp(browser, { origin, theme, width, height, dpr: width === 960 ? 2 : 1, reducedMotion });
        await sim(page, "seek", S(1652));
        await setup(page);
        await sleep(1200);
        const visible = await page.evaluate(() =>
          [...document.querySelectorAll("[data-simulation-stamp]")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && cs.visibility !== "hidden" && Number(cs.opacity) > 0.5 && !el.closest("[inert]");
            })
            .map((el) => el.textContent.trim()),
        );
        const inert = await page.evaluate(() => [...document.querySelectorAll("[data-simulation-stamp]")].map((el) => Boolean(el.closest("[inert]"))));
        states.push({ theme, state: name, size: `${width}x${height}`, reducedMotion, visibleStamps: visible.length, text: visible[0] ?? null, stampsInInertRegions: inert.filter(Boolean).length });
        await context.close();
      }
    }
    report.f_stamp = states;
  }
  // The light layer again in a headed Chromium on the real GPU (headless may have no WebGL), under the
  // same policy, with its requests, CSP violations and errors.
  if (!args.has("--headless-only")) {
    const headed = await chromium.launch({ headless: false, args: ["--ignore-gpu-blocklist", "--window-size=1920,1180"] });
    try {
      const context = await headed.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
      const page = await context.newPage();
      const w = await watch(page, origin);
      await page.goto(`${origin}/?theme=dark#atlas`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__machSim));
      await sim(page, "useLiveClock");
      const lightLayer = await lightLayerCheck(page);
      const sum = w.summary();
      report.lightLayerHeaded = { lightLayer, requests: sum.total, external: sum.external, violations: sum.violations, errors: sum.errors, urls: sum.urls };
      await context.close();
    } finally {
      await headed.close();
    }
  }
} finally {
  await browser.close();
  await server.stop();
}

/** Each Atlas entity's rendered markup, hashed; and the scene layers' markup outside any entity. */
async function snapshotEntities(page) {
  return page.evaluate(() => {
    const h = (s) => {
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0;
      return x.toString(16);
    };
    const refs = {};
    for (const el of document.querySelectorAll("[data-stage-active] [data-view=atlas] [data-ref]")) refs[el.getAttribute("data-ref")] = h(el.outerHTML);
    const layers = {};
    const loose = {};
    const looseText = {};
    document.querySelectorAll("[data-stage-active] [data-view=atlas] svg").forEach((svg, i) => {
      const clone = svg.cloneNode(true);
      clone.querySelectorAll("[data-ref]").forEach((e) => e.remove());
      layers[`svg${i}`] = h(clone.outerHTML);
      // Elements outside every entity, keyed by their place among their siblings and their kind.
      const walk = (el, path) => {
        [...el.children].forEach((c, j) => {
          const key = `svg${i}/${path}${j}:${c.tagName}${c.getAttribute("class") ? "." + c.getAttribute("class").split(" ")[0] : ""}`;
          if (c.children.length && c.tagName !== "text") walk(c, `${path}${j}/`);
          else {
            loose[key] = h(c.outerHTML);
            if (c.tagName === "text" || c.textContent.trim()) looseText[key] = `"${c.textContent.trim().slice(0, 50)}"`;
          }
        });
      };
      walk(clone, "");
    });
    return { t: window.__machSim.state().playhead, refs, layers, loose, looseText };
  });
}

// Trace each change to the fixture (node, with the simulation's own selectors).
{
  const { sim: model } = await import(join(app, "test", "_load.mjs"));
  const { SCENARIO, eventsFor, eventsBetween, refsOfEvent, MOTION } = model;
  /** Fallback: an event in the last 20 s that touches this entity, its cell or its station. */
  const nearby = (ref, t) => {
    const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    const ticket = /LOCAL-\d+/.exec(id)?.[0];
    const station = kind === "station" ? id.split("/").pop() : null;
    const candidates = eventsBetween(SCENARIO, t - 20000, t).reverse();
    return candidates.find((e) => {
      const refs = refsOfEvent(SCENARIO, e.seq) ?? [];
      if (refs.includes(ref)) return true;
      if (station && /^station\./.test(e.type) && (e.data?.station === station || refs.some((r) => r.endsWith(`/${station}`)))) return true;
      return Boolean(ticket && e.ticket_id === ticket && /^(work\.scheduled|cell\.stage_changed|station\.|artifact\.written)/.test(e.type));
    });
  };
  const window = Math.max(MOTION.travel, MOTION.afterglow, MOTION.gate, MOTION.appear);
  const unattributed = [];
  for (const s of report.e_motionSamples) {
    s.traced = s.changed.map((ref) => {
      const recent = eventsFor(SCENARIO, ref, s.t1).filter((e) => e.t > s.t1 - window);
      const now = eventsFor(SCENARIO, ref, s.t1).filter((e) => e.t > s.t0);
      const e = now[now.length - 1] ?? recent[recent.length - 1];
      if (!e) {
        // Elapsed-time readouts change with the playhead itself: attribute them to the open span's start event.
        const all = eventsFor(SCENARIO, ref, s.t1);
        const last = all[all.length - 1];
        if (last) return { ref, by: `${last.type} #${last.seq} at ${(last.t / 1000).toFixed(1)} s (still in effect: elapsed time or a span that is open)` };
        const near = nearby(ref, s.t1);
        if (near) return { ref, by: `${near.type} #${near.seq} at ${(near.t / 1000).toFixed(1)} s (an event of its cell or station; the entity has no events of its own)` };
        unattributed.push({ ref, t0: s.t0, t1: s.t1 });
        return { ref, by: null };
      }
      return { ref, by: `${e.type} #${e.seq} at ${(e.t / 1000).toFixed(1)} s (${((s.t1 - e.t) / 1000).toFixed(1)} s before the frame)` };
    });
    s.eventsInFrame = eventsBetween(SCENARIO, s.t0, s.t1).map((e) => `${e.type} #${e.seq}`);
  }
  report.e_unattributed = unattributed;
}

writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
const det = report.d_determinism ?? [];
console.log(
  JSON.stringify(
    {
      sourceScanHits: report.c_sourceScan.length,
      requests: report.a_network_b_csp?.total,
      external: report.a_network_b_csp?.external.length,
      cspViolations: report.a_network_b_csp?.violations.length,
      errors: report.a_network_b_csp?.errors.length,
      determinismMarkup: `${det.filter((d) => d.domIdentical).length} of ${det.length} identical`,
      determinismPixels: `${det.filter((d) => d.pixelIdentical).length} of ${det.length} identical`,
      motionSamples: report.e_motionSamples?.length,
      unattributed: report.e_unattributed?.length,
      stamp: report.f_stamp?.filter((s) => !s.visibleStamps).map((s) => `${s.theme}/${s.state}`),
      stampStates: report.f_stamp?.length,
      determinismSameRouteTwice: `${det.filter((d) => d.sameRouteTwiceIdentical).length} of ${det.length}`,
      lightHeadless: report.a_network_b_csp?.lightLayer,
      lightHeaded: report.lightLayerHeaded?.lightLayer,
    },
    null,
    2,
  ),
);

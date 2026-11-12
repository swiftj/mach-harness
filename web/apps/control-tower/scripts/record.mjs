// A directed, deterministic screen recording of the M6.0 Living Factory prototype.
//
//   node scripts/record.mjs                 # all three films (main dark, light clip, reduced-motion clip)
//   node scripts/record.mjs --only main     # one of: main, light, reduced
//   node scripts/record.mjs --dry           # walk the script without screenshots: prints the length
//
// How a frame is made (frame-exact, the same every run):
//   1. The simulation advances by exactly one frame of wall time on its manual clock
//      (window.__machSim.advance(ms, ms)), so factory time moves by ms x 10 x speed.
//   2. Interface time advances by the same step: Playwright's page.clock is installed before the app
//      loads, so requestAnimationFrame, performance.now, Date and timers are virtual and run only in
//      page.clock.runFor(ms). That drives the Atlas camera easing, motion/react's frame loop (the
//      Blueprint camera), timers (Theater's 2.5 s transport) and the follow camera's 4 s throttle.
//   3. Web Animations (the mode fold's opacity and transform, which motion/react hands to WAAPI, and
//      every CSS transition: inspector, lane expansion, Theater bar) run on the document timeline,
//      which page.clock does not control. Each frame, every animation in document.getAnimations() is
//      paused and its currentTime set to the virtual time since it first appeared; at its end it is
//      finished, so motion's completion handlers run as they would.
//   4. The page is screenshotted (PNG) and piped to ffmpeg, which encodes H.264 yuv420p at 30 fps.
// A frame is 1000/30 ms, delivered as 33/33/34 ms steps so 30 frames are exactly one second.
//
// Real input where the viewer should see it (clicks, the scrub drag, the pan drag, wheel zoom, keys),
// with a pointer drawn into the page by this script only (#__capture-pointer, aria-hidden, never part
// of the product). Cuts and camera direction go through window.__machSim and window.__atlasCamera.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { app, args, ensureBuild, log, ORIGIN, S, startPreview } from "./lib.mjs";

const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const out = join(app, "recordings");
mkdirSync(out, { recursive: true });
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex > 0 ? process.argv[onlyIndex + 1] : null;
const DRY = args.has("--dry");
const FPS = 30;

/** Frame i lasts round((i+1)*1000/30) - round(i*1000/30) ms: 33, 33, 34, ... */
const frameMs = (i) => Math.round(((i + 1) * 1000) / FPS) - Math.round((i * 1000) / FPS);
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// ---------------------------------------------------------------- in-page helpers (installed once)

function installPageHelpers() {
  // Drive Web Animations from the virtual clock (see the header, step 3).
  const seen = new WeakMap();
  window.__capDriveAnims = (now) => {
    for (const a of document.getAnimations()) {
      let rec = seen.get(a);
      if (!rec) {
        rec = { t0: now };
        seen.set(a, rec);
        // Held by a playback rate of 0 rather than pause(): a paused fold, once cancelled by the app,
        // left its start value applied to the Atlas layer in headless Chromium (a blank stage for the
        // rest of the film), with no animation listed and inline styles overridden.
        try {
          a.playbackRate = 0;
        } catch {
          // an animation that cannot be held is left alone
        }
      }
      const end = a.effect?.getComputedTiming?.().endTime ?? 0;
      const t = now - rec.t0;
      if (Number.isFinite(end) && t >= end) {
        try {
          if (a.playState !== "finished") {
            a.playbackRate = 1;
            a.finish();
          }
        } catch {
          // infinite or already finished
        }
      } else {
        a.currentTime = t;
      }
    }
    // A stage layer at rest (no animation, no inline opacity, visible) must be fully opaque. With the
    // fold's animations held by this driver, after the app cancelled the fold back to the Atlas, the
    // Atlas layer's computed opacity stayed at the fold's start value (0) in headless Chromium, with
    // no animation listed on it and inline styles overridden: a blank stage in every later frame. On
    // the real clock the same path ends at opacity 1, headless and headed (checked), so this is the
    // recorder's held document timeline, not the app. The layer is given an !important inline opacity of 1
    // (which outranks an animation value) until the app animates or styles it again; each repair is
    // counted and reported with the film.
    for (const el of document.querySelectorAll("[data-stage-view]")) {
      const ours = el.hasAttribute("data-cap-opacity");
      if (el.getAnimations().length || (el.style.opacity && !ours)) {
        // The app animates or styles the layer again: our override steps aside.
        if (ours) {
          el.style.removeProperty("opacity");
          el.removeAttribute("data-cap-opacity");
        }
        continue;
      }
      if (ours) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== "hidden" && Number(cs.opacity) < 1) {
        // An !important inline value outranks the stuck animation value in the cascade.
        window.__capLayerRepairs = (window.__capLayerRepairs ?? 0) + 1;
        el.style.setProperty("opacity", "1", "important");
        el.setAttribute("data-cap-opacity", "");
      }
    }
  };
  // The capture pointer: a drawn arrow and a click ring. Not part of the product.
  const pointer = document.createElement("div");
  pointer.id = "__capture-pointer";
  pointer.setAttribute("aria-hidden", "true");
  pointer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;opacity:0";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "64");
  svg.setAttribute("height", "64");
  svg.setAttribute("viewBox", "-32 -32 64 64");
  svg.style.cssText = "position:absolute;left:-32px;top:-32px;overflow:visible";
  const ring = document.createElementNS(ns, "circle");
  ring.setAttribute("r", "14");
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "#ffffff");
  ring.setAttribute("stroke-width", "2.5");
  const ring2 = document.createElementNS(ns, "circle");
  ring2.setAttribute("r", "14");
  ring2.setAttribute("fill", "none");
  ring2.setAttribute("stroke", "#1b1b1b");
  ring2.setAttribute("stroke-width", "1");
  const arrow = document.createElementNS(ns, "path");
  arrow.setAttribute("d", "M0 0 L0 19 L4.6 14.6 L8 22 L11 20.7 L7.7 13.6 L14 13.6 Z");
  arrow.setAttribute("fill", "#ffffff");
  arrow.setAttribute("stroke", "#141414");
  arrow.setAttribute("stroke-width", "1.4");
  arrow.setAttribute("stroke-linejoin", "round");
  svg.append(ring, ring2, arrow);
  pointer.append(svg);
  document.body.append(pointer);
  window.__capPointer = ({ x, y, opacity, ring: r }) => {
    pointer.style.transform = `translate(${x}px, ${y}px)`;
    pointer.style.opacity = String(opacity);
    const k = r > 0 && r < 1 ? r : 0;
    for (const c of [ring, ring2]) {
      c.setAttribute("r", String(8 + 18 * k));
      c.style.opacity = k ? String(1 - k) : "0";
    }
  };
  // A point inside an entity that the entity itself receives (elementFromPoint), for real clicks.
  window.__capPointOf = (selector) => {
    const els = [...document.querySelectorAll(selector)];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const tries = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.35, 0.5], [0.65, 0.5], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]];
      for (const [fx, fy] of tries) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) return { x, y };
      }
      // Thin strokes (a dependency cable): walk the geometry itself.
      for (const g of el.querySelectorAll("path, line, polyline")) {
        if (typeof g.getTotalLength !== "function") continue;
        const len = g.getTotalLength();
        const m = g.getScreenCTM();
        if (!len || !m) continue;
        for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
          const p = g.getPointAtLength(len * f).matrixTransform(m);
          const hit = document.elementFromPoint(p.x, p.y);
          if (hit && (hit === el || el.contains(hit)) && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight) return { x: p.x, y: p.y };
        }
      }
    }
    return null;
  };
  // A point on empty ground in the Atlas (nothing selectable under it), for a pan drag.
  window.__capGround = (x0, y0) => {
    for (let r = 0; r < 400; r += 20) {
      for (let a = 0; a < 8; a++) {
        const x = x0 + r * Math.cos((a * Math.PI) / 4);
        const y = y0 + r * Math.sin((a * Math.PI) / 4);
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest("[data-stage-active] [data-view=atlas]") && !hit.closest("[data-ref]") && !hit.closest("button")) return { x, y };
      }
    }
    return { x: x0, y: y0 };
  };
}

// ---------------------------------------------------------------- the recorder

class Recorder {
  constructor(page, file, { width = 1920, height = 1080 } = {}) {
    this.page = page;
    this.file = file;
    this.frame = 0;
    this.cursor = { x: width * 0.62, y: height * 0.55, opacity: 0, ring: 0 };
    this.ringFrames = 0;
    this.missingStamp = [];
    this.size = { width, height };
    if (!DRY) {
      this.ffmpeg = spawn(FFMPEG, ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", String(FPS), "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
      this.done = new Promise((ok, fail) => this.ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))));
    }
  }

  /** Render one frame: advance both clocks by one frame, drive animations, paint, encode. */
  async tick() {
    const ms = frameMs(this.frame);
    await this.page.evaluate((m) => window.__machSim.advance(m, m), ms);
    await this.page.clock.runFor(ms);
    if (this.ringFrames > 0) {
      this.cursor.ring = 1 - this.ringFrames / 10;
      this.ringFrames--;
    } else this.cursor.ring = 0;
    const ok = await this.page.evaluate((cursor) => {
      window.__capDriveAnims(performance.now());
      window.__capPointer(cursor);
      return [...document.querySelectorAll("[data-simulation-stamp]")].some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0.5;
      });
    }, this.cursor);
    if (!ok) this.missingStamp.push(this.frame);
    if (!DRY) {
      const png = await this.page.screenshot({ type: "png" });
      if (!this.ffmpeg.stdin.write(png)) await new Promise((r) => this.ffmpeg.stdin.once("drain", r));
    }
    this.frame++;
    if (this.frame % 300 === 0) log(`${this.file.split("/").pop()}: ${this.frame} frames (${(this.frame / FPS).toFixed(0)} s)`);
  }

  async hold(seconds) {
    const n = Math.round(seconds * FPS);
    for (let i = 0; i < n; i++) await this.tick();
  }

  /** Run `each(k)` (k from 0 to 1, eased) before each of the frames over `seconds`. */
  async during(seconds, each) {
    const n = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= n; i++) {
      await each(ease(i / n), i / n);
      await this.tick();
    }
  }

  sim(method, ...params) {
    return this.page.evaluate(([m, p]) => window.__machSim[m](...p), [method, params]);
  }

  state() {
    return this.page.evaluate(() => window.__machSim.state());
  }

  /** Play until the playhead reaches factory second `t` (at whatever speed is set). */
  async playTo(t, maxSeconds = 120) {
    for (let i = 0; i < maxSeconds * FPS; i++) {
      const s = await this.state();
      if (s.playhead >= S(t) || !s.playing) return;
      await this.tick();
    }
  }

  // ---- the pointer
  async showPointer(on, seconds = 0.25) {
    const from = this.cursor.opacity;
    const to = on ? 1 : 0;
    await this.during(seconds, (k) => (this.cursor.opacity = from + (to - from) * k));
  }

  async moveTo(x, y, seconds = 0.6) {
    const from = { ...this.cursor };
    await this.during(seconds, async (k) => {
      this.cursor.x = from.x + (x - from.x) * k;
      this.cursor.y = from.y + (y - from.y) * k;
      await this.page.mouse.move(this.cursor.x, this.cursor.y);
    });
  }

  async click() {
    this.ringFrames = 10;
    await this.page.mouse.click(this.cursor.x, this.cursor.y);
  }

  /** Move the pointer to a selector's clickable point and click it for real. */
  async clickOn(selector, seconds = 0.7) {
    const p = await this.page.evaluate((s) => window.__capPointOf(s), selector);
    if (!p) throw new Error(`nothing to click for ${selector}`);
    await this.moveTo(p.x, p.y, seconds);
    await this.hold(0.15);
    await this.click();
  }

  /** Move the pointer to a Playwright locator's centre and click it for real. */
  async clickLocator(locator, seconds = 0.7) {
    const b = await locator.first().boundingBox();
    if (!b) throw new Error(`nothing to click for ${locator}`);
    await this.moveTo(b.x + Math.min(b.width / 2, 60), b.y + b.height / 2, seconds);
    await this.hold(0.15);
    await this.click();
  }

  /** Press a key for real; the transport and the views see an ordinary keydown. */
  async key(k, after = 0.35) {
    await this.page.keyboard.press(k);
    await this.hold(after);
  }

  /** Park the real mouse where it hovers nothing (the top bar's title), pointer hidden. */
  async park() {
    if (this.cursor.opacity > 0) await this.showPointer(false, 0.2);
    this.cursor.x = 820;
    this.cursor.y = 22;
    await this.page.mouse.move(this.cursor.x, this.cursor.y);
  }

  // ---- camera direction (Atlas)
  /** Glide the Atlas camera to the framing `focus` + `zoom` (+ centred on `around`) over `seconds`. */
  async glide({ focus, zoom, around }, seconds = 1.6) {
    const from = await this.page.evaluate(() => window.__atlasCamera.get());
    // Find the target framing: let the app frame it (no frame is rendered meanwhile), read it, put the camera back.
    if (focus) await this.sim("focus", focus);
    await this.page.clock.runFor(800);
    if (zoom) await this.page.evaluate((z) => window.__atlasCamera.zoomTo(z), zoom);
    if (around) await centre(this.page, around);
    const to = await this.page.evaluate(() => window.__atlasCamera.get());
    await this.page.evaluate((c) => window.__atlasCamera.set(c), from);
    const { vw, vh } = await this.page.evaluate(() => {
      const b = (document.querySelector("[data-stage-active] [data-view=atlas]") ?? document.body).getBoundingClientRect();
      return { vw: b.width, vh: b.height };
    });
    await this.during(seconds, (k) =>
      this.page.evaluate(
        ({ from, to, k, vw, vh }) => {
          const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k);
          const c0 = { x: (vw / 2 - from.x) / from.zoom, y: (vh / 2 - from.y) / from.zoom };
          const c1 = { x: (vw / 2 - to.x) / to.zoom, y: (vh / 2 - to.y) / to.zoom };
          const cx = c0.x + (c1.x - c0.x) * k;
          const cy = c0.y + (c1.y - c0.y) * k;
          window.__atlasCamera.set({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom });
        },
        { from, to, k, vw, vh },
      ),
    );
  }

  async finish() {
    if (DRY) return;
    this.ffmpeg.stdin.end();
    await this.done;
  }
}

async function centre(page, refs) {
  await page.evaluate((list) => {
    const view = (document.querySelector("[data-stage-active] [data-view=atlas]") ?? document.getElementById("stage")).getBoundingClientRect();
    // Both views stay mounted; only the active layer's boxes count.
    const boxes = list.flatMap((ref) => [...document.querySelectorAll(`[data-stage-active] [data-ref="${CSS.escape(ref)}"]`)].map((e) => e.getBoundingClientRect())).filter((b) => b.width || b.height);
    if (!boxes.length) return;
    const x = (Math.min(...boxes.map((b) => b.left)) + Math.max(...boxes.map((b) => b.right))) / 2;
    const y = (Math.min(...boxes.map((b) => b.top)) + Math.max(...boxes.map((b) => b.bottom))) / 2;
    const cam = window.__atlasCamera.get();
    window.__atlasCamera.set({ zoom: cam.zoom, x: cam.x + view.left + view.width / 2 - x, y: cam.y + view.top + view.height / 2 - y });
  }, refs);
}

/** Open the app with the virtual clock installed, paused at t=0 on the manual sim clock. */
async function open(browser, { theme = "dark", reducedMotion = "no-preference", width = 1920, height = 1080 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-11-10T14:00:00Z") });
  await page.goto(`${ORIGIN}/?theme=${theme}#atlas`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__machSim), undefined, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(1000);
  await page.clock.pauseAt(new Date("2026-11-10T14:00:05Z"));
  await page.evaluate(installPageHelpers);
  await page.evaluate(() => {
    const s = window.__machSim;
    s.pause();
    s.useManualClock();
    s.seek(0);
    s.advance(0);
  });
  await page.clock.runFor(100);
  return { context, page };
}

// ---------------------------------------------------------------- the films

/**
 * Speed keys: "{" slower, "}" faster, through 0.5, 1, 2, 4, 8, 16. Pressed for real so the transport
 * shows each step.
 */
async function speedTo(r, target) {
  const speeds = [0.5, 1, 2, 4, 8, 16];
  let s = (await r.state()).speed;
  while (s !== target) {
    const up = speeds.indexOf(target) > speeds.indexOf(s);
    await r.key(up ? "}" : "{", 0.2);
    s = (await r.state()).speed;
  }
}

async function opening(r) {
  // The composed empty plant, live, following; then playback starts with the real Play button.
  await r.park();
  await r.hold(5);
  await r.showPointer(true);
  await r.clickOn('[data-transport="play"]', 0.9);
  await r.hold(0.3);
  await r.park();
  await r.playTo(14);
}

async function waveArrives(r) {
  await r.glide({ focus: "wave:WAVE-007", zoom: 1.3, around: ["wave:WAVE-007", "slice:SLICE-021", "slice:SLICE-025", "station:intake"] }, 1.4);
  await r.playTo(22);
  await speedTo(r, 0.5);
  await r.playTo(49);
  await r.hold(0.6);
}

async function construction(r) {
  // Pull back to the floor as the three bays start, and speed up through construction.
  await speedTo(r, 4);
  await r.glide({ focus: "cell:LOCAL-032", zoom: 0.95 }, 2.2);
  await r.playTo(250);
  // Pan and zoom by hand while the factory runs: a drag on empty ground, then the wheel.
  await r.showPointer(true);
  const g = await r.page.evaluate(() => window.__capGround(560, 520));
  await r.moveTo(g.x, g.y, 0.5);
  await r.page.mouse.down();
  await r.during(1.2, async (k) => {
    r.cursor.x = g.x + 160 * k;
    r.cursor.y = g.y + 70 * k;
    await r.page.mouse.move(r.cursor.x, r.cursor.y);
  });
  await r.page.mouse.up();
  await r.during(1.2, () => r.page.mouse.wheel(0, -9));
  await r.park();
  await r.playTo(560);
  // The three bays at work, at 1x, close enough to read.
  await speedTo(r, 1);
  await r.glide({ focus: "cell:LOCAL-032", zoom: 1.1 }, 1.8);
  await r.hold(6);
  // The timeline starts as one summary row; open every track for a look, then fold it again.
  const tracks = r.page.locator("section[aria-label='Execution timeline'] button[aria-expanded]", { hasText: "Tracks" });
  await r.showPointer(true);
  await r.clickLocator(tracks, 0.8);
  await r.park();
  await r.hold(4.5);
  await r.showPointer(true);
  await r.clickLocator(tracks, 0.6);
  await r.park();
  await r.hold(0.8);
  await speedTo(r, 16);
  // Slowing from 16x to 1x one key at a time moves the playhead about 30 s more.
  await r.playTo(1540);
  await speedTo(r, 1);
}

async function wholePlant(r) {
  // Pull right back to the whole plant at far zoom (the far level of detail) while the bays build.
  await r.glide({ focus: "overview", zoom: 0.5 }, 2.0);
  await r.hold(2.4);
}

async function reviewFanOut(r) {
  // LOCAL-033's panel at 1x: three seats fan out, two approve, the product seat's blocker is outvoted.
  await r.glide({ focus: "gate:LOCAL-033/review#1", zoom: 1.5 }, 1.4);
  await r.playTo(1616);
  await r.hold(1.2);
}

async function verificationFails(r) {
  await r.glide({ focus: "cell:LOCAL-031", zoom: 2.0 }, 1.6);
  await r.playTo(1637);
  await speedTo(r, 0.5);
  await r.playTo(1659);
  // The verdict, inspected: a real click on the verification gate.
  await r.showPointer(true);
  await r.clickOn('[data-stage-active] [data-view=atlas] [data-ref="gate:LOCAL-031/verification#1"]', 0.8);
  await r.park();
  await r.hold(2.6);
}

async function inspectAgent(r) {
  // Select the builder the loop brought back, for real; F frames it (the app's own 650 ms focus).
  await r.showPointer(true);
  await r.clickOn('[data-stage-active] [data-view=atlas] [data-ref="agent:ag-031-12"]', 0.8);
  await r.hold(0.6);
  await r.park();
  await r.key("f", 1.2);
  await r.playTo(1702);
}

async function blueprint(r) {
  // The same selection in the Execution Blueprint; open the agent to its tool calls with its chevron.
  await r.key("2", 1.6);
  // The whole sheet at fit draws the simplified marks; then F frames the selection again.
  await r.key("0", 3.4);
  await r.key("f", 1.4);
  await r.showPointer(true);
  const toggle = '[data-stage-view="blueprint"] g[data-ref="agent:ag-031-12"] rect[data-toggle]';
  if (await r.page.locator(toggle).count()) {
    await r.clickOn(toggle, 0.9);
    await r.hold(0.9);
  }
  // Pinch-zoom (Ctrl + wheel) toward the agent's tool calls.
  const row = await r.page.locator('[data-stage-active] [role=treeitem][data-ref="agent:ag-031-12"]').boundingBox();
  const stage = await r.page.locator('[data-stage-view="blueprint"]').boundingBox();
  if (row && stage) await r.moveTo(stage.x + stage.width * 0.45, Math.min(stage.y + stage.height - 40, row.y + 24), 0.7);
  await r.page.keyboard.down("Control");
  await r.during(1.2, () => r.page.mouse.wheel(0, -12));
  await r.page.keyboard.up("Control");
  await r.park();
  await r.hold(1.5);
  await r.playTo(1745);
}

async function reviewAndRejection(r) {
  await r.key("Escape", 0.2);
  await r.key("1", 1.4);
  await r.glide({ focus: "gate:LOCAL-032/review#1", zoom: 1.5 }, 1.2);
  await r.playTo(1766);
  await speedTo(r, 8);
  await r.playTo(1878);
  await speedTo(r, 1);
  await r.glide({ focus: "cell:LOCAL-032", zoom: 0.85, around: ["cell:LOCAL-032", "gate:review"] }, 1.4);
  await r.playTo(1950);
  await r.hold(1.2);
}

async function scrub(r) {
  // Pause with the real button, then drag the playhead back across the rejection and forward again.
  await r.showPointer(true);
  await r.clickOn('[data-transport="play"]', 0.7);
  const bar = await r.page.locator('[role=slider][aria-label="Playhead over the whole run"]').boundingBox();
  const x = (t) => bar.x + (S(t) / runDuration) * bar.width;
  const y = bar.y + bar.height / 2;
  await r.moveTo(x(1950), y, 0.8);
  await r.page.mouse.down();
  for (const [t, sec] of [[1880, 1.4], [1965, 1.6], [1915, 1.0], [1950, 0.8]]) {
    const fromX = r.cursor.x;
    await r.during(sec, async (k) => {
      r.cursor.x = fromX + (x(t) - fromX) * k;
      await r.page.mouse.move(r.cursor.x, y);
    });
  }
  await r.page.mouse.up();
  await r.hold(0.8);
  // Back to live: L jumps to the live edge and turns camera follow on; play resumes at 4x.
  await r.park();
  await r.key("l", 0.6);
  await speedTo(r, 4);
  await r.showPointer(true);
  await r.clickOn('[data-transport="play"]', 0.6);
  await r.park();
  await r.hold(4.5);
}
let runDuration = 3350200;

async function humanGate(r) {
  // A cut to the gate: the run waits for a person. Nothing moves at the gate (stillness).
  await r.sim("pause");
  await r.sim("seek", S(2840));
  await r.glide({ focus: "gate:LOCAL-032/human-approval", zoom: 1.8 }, 0.1);
  await r.hold(0.8);
  await speedTo(r, 1);
  await r.sim("play");
  await r.playTo(2922);
  // The next chapter, by key, is the approval: then play the release at half speed.
  await r.sim("pause");
  await r.sim("seek", S(3108));
  await r.glide({ focus: "gate:LOCAL-032/human-approval", zoom: 1.8 }, 0.1);
  await r.hold(0.5);
  await speedTo(r, 0.5);
  await r.sim("play");
  await r.playTo(3128);
}

async function integration(r) {
  await speedTo(r, 4);
  await r.glide({ focus: "station:merge", zoom: 1.25, around: ["station:merge", "gate:merge-revalidation"] }, 1.6);
  await r.playTo(3240);
  await speedTo(r, 1);
  await r.playTo(3274);
}

async function dependency(r) {
  // Select the dependency cable (highlighting its chain), then the inspector's "Go to when it cleared".
  await r.sim("pause");
  await r.glide({ focus: "dependency:SLICE-024->SLICE-021", zoom: 1.0 }, 1.4);
  await r.showPointer(true);
  await r.clickOn('[data-stage-active] [data-view=atlas] [data-ref="dependency:SLICE-024->SLICE-021"]', 0.9);
  await r.hold(1.2);
  await r.clickLocator(r.page.locator("aside").getByRole("button", { name: "Go to when it cleared" }), 0.9);
  await r.hold(0.4);
  // Replay a few seconds before the unlock so it is seen to happen.
  await r.sim("seek", S(2604));
  await r.park();
  await speedTo(r, 0.5);
  await r.sim("play");
  await r.playTo(2634);
}

async function theater(r) {
  // Theater Mode for the final passage at speed, on the whole plant, to the end of the run.
  await r.key("Escape", 0.3);
  await r.key("t", 0.8);
  await r.sim("focus", "overview");
  await r.hold(1.0);
  await speedTo(r, 4);
  await r.playTo(3360, 60);
  await r.hold(6);
}

const FILMS = {
  main: {
    file: "living-factory-dark-1080p.mp4",
    theme: "dark",
    async run(r) {
      for (const segment of [opening, waveArrives, wholePlant, construction, reviewFanOut, verificationFails, inspectAgent, blueprint, reviewAndRejection, scrub, humanGate, integration, dependency, theater]) {
        const from = r.frame;
        await segment(r);
        log(`  ${segment.name}: ${((r.frame - from) / FPS).toFixed(1)} s (ends at ${(r.frame / FPS).toFixed(1)} s, factory ${((await r.state()).playhead / 1000).toFixed(0)} s)`);
      }
    },
  },
  light: {
    file: "living-factory-light-clip-1080p.mp4",
    theme: "light",
    async run(r) {
      // The verification failure, the agent, the Blueprint and the rejection, in the light theme.
      await r.park();
      await r.sim("seek", S(1618));
      await r.glide({ focus: "cell:LOCAL-031", zoom: 1.2 }, 0.1);
      await r.hold(1.0);
      await r.sim("play");
      await speedTo(r, 2);
      await r.playTo(1630);
      await verificationFails(r);
      await inspectAgent(r);
      await blueprint(r);
      await reviewAndRejection(r);
    },
  },
  reduced: {
    file: "living-factory-reduced-motion-clip-1080p.mp4",
    theme: "dark",
    reducedMotion: "reduce",
    async run(r) {
      // Reduced motion: end states at the event time, cuts instead of camera travel and folds.
      await r.park();
      await r.sim("seek", S(1630));
      await r.sim("focus", "cell:LOCAL-031");
      await r.page.clock.runFor(100);
      await r.page.evaluate(() => window.__atlasCamera.zoomTo(2.0));
      await r.hold(1.0);
      await r.sim("setSpeed", 1);
      await r.sim("play");
      await r.playTo(1662);
      await r.sim("pause");
      // Step event by event with "." (the playhead can still be stepped).
      for (let i = 0; i < 6; i++) await r.key(".", 0.6);
      await r.key("2", 2.5);
      await r.key("1", 2.0);
      await r.sim("seek", S(1925));
      await r.glide({ focus: "cell:LOCAL-032", zoom: 0.85, around: ["cell:LOCAL-032", "gate:review"] }, 0.05);
      await r.sim("play");
      await r.playTo(1952);
      await r.hold(Math.max(0, 20 - r.frame / FPS));
    },
  },
};

async function record(browser, name) {
  const film = FILMS[name];
  const { context, page } = await open(browser, { theme: film.theme, reducedMotion: film.reducedMotion });
  runDuration = await page.evaluate(() => window.__machSim.duration);
  const file = join(out, film.file);
  const r = new Recorder(page, file);
  const started = Date.now();
  try {
    await film.run(r);
    r.layerRepairs = await page.evaluate(() => window.__capLayerRepairs ?? 0);
  } finally {
    await r.finish().catch((e) => log(String(e)));
    await context.close();
  }
  const seconds = r.frame / FPS;
  log(`${name}: stage-layer opacity repairs ${r.layerRepairs}`);
  log(`${name}: ${r.frame} frames, ${seconds.toFixed(1)} s of film, rendered in ${((Date.now() - started) / 60000).toFixed(1)} min${r.missingStamp.length ? `; Simulation label missing in ${r.missingStamp.length} frames` : "; Simulation label visible in every frame"}`);
  return { name, file, frames: r.frame, seconds, missingStamp: r.missingStamp, layerRepairs: r.layerRepairs };
}

function shareable(file) {
  const small = file.replace("-1080p.mp4", "-720p.mp4");
  const run = spawn(FFMPEG, ["-v", "error", "-y", "-i", file, "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", small], { stdio: "inherit" });
  return new Promise((ok) =>
    run.on("close", () => {
      const mb = statSync(small).size / 1e6;
      log(`${small.split("/").pop()}: ${mb.toFixed(1)} MB at crf 20`);
      ok(mb < 25 ? small : shareableAt(file, small));
    }),
  );
}

/** Fallback: a two-pass encode to a bitrate that lands under 24 MB. */
function shareableAt(file, small) {
  const probe = spawn(FFMPEG, ["-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  let text = "";
  probe.stderr.on("data", (d) => (text += d));
  return new Promise((ok) =>
    probe.on("close", () => {
      const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(text) ?? [0, 0, 3, 0];
      const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
      const kbps = Math.floor((24 * 8e3) / seconds);
      const run = spawn(FFMPEG, ["-v", "error", "-y", "-i", file, "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-b:v", `${kbps}k`, "-maxrate", `${kbps * 1.5}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", small], { stdio: "inherit" });
      run.on("close", () => ok(small));
    }),
  );
}

if (!existsSync(FFMPEG) && !DRY) throw new Error(`ffmpeg not found at ${FFMPEG} (set FFMPEG)`);
ensureBuild();
const server = await startPreview();
const browser = await chromium.launch();
const results = [];
try {
  for (const name of Object.keys(FILMS)) {
    if (only && name !== only) continue;
    results.push(await record(browser, name));
  }
} finally {
  await browser.close();
  server.stop();
}
if (!DRY) {
  for (const r of results) if (r.name === "main") await shareable(r.file);
}
console.log(JSON.stringify(results.map(({ name, file, frames, seconds, missingStamp, layerRepairs }) => ({ name, file, frames, seconds, missingStampFrames: missingStamp.length, layerRepairs })), null, 2));

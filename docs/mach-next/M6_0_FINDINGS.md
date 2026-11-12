# MACH Next — M6.0 findings: performance, accessibility and honesty

Capture owner's report for the visual review of the Living Factory prototype (branch `feature/mach-next-m6-living-factory`, HEAD `34e5f39`). Everything here was measured on the **capture build** (`vite build --mode capture`: the production build plus the `window.__machSim` hook; the production build was also built and its bundle is byte-for-byte the same size, see 2.6). The prototype is a simulation; so is everything shown in the screenshots and recordings.

Evidence: `web/apps/control-tower/screenshots/` (README lists every file), `screenshots/_perf/report.json`, `screenshots/_a11y/report.json`, `screenshots/_honesty/report.json`, and `web/apps/control-tower/recordings/`. Scripts: `web/apps/control-tower/scripts/{capture,record,measure,audit,honesty,lib}.mjs`.

## 1. Summary

| Area | Check | Result | Verdict |
|---|---|---|---|
| Performance (spec g) | Scrubbing: 60 fps, scene update ≤ 8 ms per frame | Main thread 1.8–2.2 ms per frame on average (script), p95 frame 16.8 ms; but max 183 ms (Atlas, headed) and 0.4% of frames over 33 ms | **Fail (marginal)**: update cost passes, a few frames drop |
| | SVG elements ≤ 2500 at mid, ≤ 1200 at far | Mid 2340, far **1371**, near 2737 (with 3 to 4 cells, not 12) | Mid **pass**, far **fail** |
| | Upright text elements ≤ 160 | 48 (far) to 115 (near) | **Pass** |
| | Mode switch: no frame over 24 ms | Max 166 ms (first switch to the Blueprint), 33–83 ms after; to the Atlas 12–16% of frames over 33 ms (headed GPU) | **Fail** |
| | First paint of the Atlas ≤ 400 ms after the JS has run | 120–167 ms after the last script arrived (5 cold loads, both browsers) | **Pass** |
| | React commits ≤ 1 per frame; L2 draw calls ≤ 40 | Not measured (no React profiler in a production build); L2 dropped for M6.0 and off by default | Not measured / n.a. |
| | Playback, all views, 1x / 4x / 16x | p95 16.8–17.9 ms everywhere; no long tasks; max 17.6–200 ms; ≤ 0.9% of frames over 33 ms | Smooth at every speed |
| | Memory over the run (after GC) | Heap 9.5 → 13.1 → 14.5 MB; DOM nodes 2,055 → 4,332 → 4,728 (start, middle, end) | Bounded |
| | Bundle | Initial JS 968 kB (298 kB gzip), CSS 75 kB (14 kB), lazy 21 chunks 2.4 MB (716 kB; ELK 1.43 MB of it), fonts 887 kB; 4.3 MB in all | For the review; no budget set |
| Accessibility | axe, WCAG 2.2 A/AA, 32 states (both views, both themes, 1920 and 1100, Theater, help) | 8 violations, all one rule: `target-size` on the timeline's resize handle, at 1100 wide with the inspector overlay open | **1 defect** |
| | Keyboard-only walkthrough, every interaction in the brief | 44 of 44 steps done by keyboard alone; all 59 Atlas entities reachable by arrows | **Pass** |
| | Focus visibility and order | Every Tab stop shows a 2 px ring except two that draw their own (resize handle, slider); order matches spec f.11 | **Pass**, notes |
| | Reduced motion, measured | No WAAPI/keyframe motion; mode switch is a cut; but **three things still travel**: the wave manifest at arrival, agents' posts rising and sinking, and per-frame position changes in the merge worker | **Fail (3 defects)** |
| | Contrast of the factory tokens as rendered | 60 pairs per theme, all pass (lowest: `factory-route` on `machine-top`, 3.16:1 dark) | **Pass** |
| | Colour independence (greyscale) | Every state readable by mark shape, outline and pips | **Pass** (judged by eye) |
| | Screen-reader semantics | Landmarks, names and roles sound; one minute of playback gave 8 polite announcements (listed in 3.7); one accessible name goes stale during playback | **Pass**, 1 defect |
| | 200% zoom | No reflow: horizontal scroll, top bar and controls cut off at 960 x 540 and 640 x 400 CSS px | **Fail** (expected for a desktop tool; recorded) |
| Honesty | (a) No network at run time | 10 requests in a full play-through, all same-origin static assets (1 document, 4 scripts incl. the lazy ELK and effects chunks, 1 stylesheet, 4 fonts) | **Pass** |
| | (b) M5 Content-Security-Policy | Served with the M5 host's exact header; played through both views, Theater, help, both themes, the WebGL layer switched on: 0 violations, 0 console errors | **Pass** |
| | (c) No randomness or wall clock driving factory progress | No `Math.random`, no `Date.now` in `src`; `performance.now` and rAF only in the clock module and interface code | **Pass** |
| | (d) Determinism | Same route twice: markup identical 60 of 60. Across routes: the scene is identical, except one station's accessible name after playback (defect) and focus rings; raster varies by ≤ 0.6% of pixels between pages with identical markup (Chromium) | **Pass**, 1 defect |
| | (e) Every moving thing has an event | 20 adjacent-frame samples: every changed entity traced to a fixture event | **Pass** |
| | (f) "Simulation" visible in every captured state | 94 screenshots, 5,994 film frames, 14 checked states (Theater included) | **Pass** |

Defects: 14, none blocking the review (section 5).

## 2. Performance

### 2.1 What was run

- **Machine**: Apple M3, 8 cores, 16 GB, macOS (Darwin 27.2.0), one built-in display at 60 Hz (measured from rAF).
- **Headed**: Playwright's Chromium 145.0.7632.6, `headless: false`, `--ignore-gpu-blocklist`, window 1920 x 1180, viewport 1920 x 1080 at device scale 1. WebGL renderer reported **"ANGLE Metal Renderer: Apple M3"**: the real GPU.
- **Headless**: the same Chromium, `headless: true` (headless shell). **No WebGL**: software rendering.
- The app ran on its **real clock** (requestAnimationFrame), dark theme, the busy cell LOCAL-031 selected (inspector updating each event), the timeline expanded with LOCAL-031's row open. Each run: 8 s of wall time from factory 06:40 (1x to 08:00, 4x to 12:00, 16x to 28:00).
- **Frame time**: every rAF interval. **Long tasks**: PerformanceObserver `longtask`. **Long animation frames**: LoAF entries (script and render time of frames over 50 ms). **Main thread per frame**: Chromium's own counters (CDP `Performance.getMetrics`: ScriptDuration, LayoutDuration, RecalcStyleDuration, TaskDuration) over the run divided by frames drawn. **Memory**: `JSHeapUsedSize` and `Nodes` after a forced GC.
- The display is 60 Hz, so the floor is 16.7 ms and the vsync jitter puts 23–35% of intervals at 16.8–17.7 ms. The "over 16.7 ms" share therefore measures jitter, not dropped frames; "over 33 ms" counts dropped frames.

### 2.2 Playback (ms per frame interval; main-thread ms per frame)

Headed, GPU:

| View | Speed | p50 | p95 | p99 | max | > 16.7 | > 33 | script | layout | style | long tasks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Atlas at fit (mid, 74%) | 1x | 16.7 | 17.1 | 17.6 | 83.4 | 23.3% | 0.4% | 0.98 | 0.30 | 0.14 | 0 |
| | 4x | 16.7 | 16.8 | 17.7 | 34.1 | 29.4% | 0.4% | 1.16 | 0.29 | 0.14 | 0 |
| | 16x | 16.7 | 16.9 | 33.3 | 200 | 31.4% | 0.4% | 2.19 | 0.44 | 0.24 | 0 |
| Atlas near (200%), following | 1x | 16.7 | 16.8 | 17.5 | 17.6 | 31.9% | 0 | 0.88 | 0.25 | 0.11 | 0 |
| | 4x | 16.7 | 16.8 | 17.6 | 17.7 | 23.6% | 0 | 1.38 | 0.35 | 0.15 | 0 |
| | 16x | 16.7 | 16.9 | 33.4 | 49.9 | 29.1% | 0.9% | 2.40 | 0.49 | 0.26 | 0 |
| Blueprint, lanes collapsed | 1x | 16.7 | 17.0 | 17.5 | 17.7 | 25.3% | 0 | 0.58 | 0.43 | 0.12 | 0 |
| | 4x | 16.7 | 16.8 | 17.6 | 17.7 | 33.0% | 0 | 0.88 | 0.45 | 0.13 | 0 |
| | 16x | 16.7 | 16.8 | 17.5 | 17.7 | 24.6% | 0 | 1.51 | 0.53 | 0.18 | 0 |
| Blueprint, every agent expanded (44–46 tree items) | 1x | 16.7 | 16.8 | 17.6 | 116.6 | 31.6% | 0.2% | 1.12 | 0.56 | 0.15 | 0 |
| | 4x | 16.7 | 16.8 | 17.6 | 33.3 | 29.3% | 0 | 1.95 | 0.61 | 0.20 | 0 |
| | 16x | 16.7 | 16.8 | 17.5 | 33.2 | 29.9% | 0 | 3.00 | 0.71 | 0.24 | 0 |

Headless (software): p95 16.8–17.9 ms, max 17.6–34.8 ms, at most 0.2% over 33 ms, script 0.34–2.54 ms per frame, no long tasks (full table in `_perf/report.json`).

Reading: playback is smooth in every configuration; main-thread cost grows with speed (more events per frame) and peaks at 3 ms per frame (Blueprint expanded, 16x). The isolated maxima in the headed runs (200 ms at Atlas 16x, 116.6 ms at Blueprint expanded 1x, 83 ms at Atlas 1x) had **no** long task and no LoAF over 10 ms of script or render, so they are not the app's main thread; the likeliest cause is the compositor or GPU process of the headed window (not profiled further).

### 2.3 Scrubbing across the whole run

A real pointer drag on the playhead strip, 0:00 to 55:50 and back, 240 moves over about 4 s, cell selected.

| | Frames | p50 | p95 | p99 | max | > 33 | script/frame | task/frame | LoAF worst |
|---|---|---|---|---|---|---|---|---|---|
| Atlas, headed | 494 | 16.7 | 16.8 | 33 | **183.4** | 0.4% | 1.95 | 4.98 | render 33 ms |
| Blueprint, headed | 482 | 16.7 | 16.8 | 17.5 | 49.9 | 0.2% | 2.17 | 4.66 | script 14, render 24; one 50 ms long task |
| Atlas, headless | 490 | 16.7 | 17.8 | 18.6 | 33.3 | 0 | 1.76 | 4.56 | render 26 ms |
| Blueprint, headless | 486 | 16.7 | 17.4 | 18.3 | 50 | 0.2% | 1.91 | 4.32 | script 15, render 25 |

Budget "scene update ≤ 8 ms per frame": **met on average** (all main-thread work 4.3–5.0 ms per frame, script under 2.2 ms). "60 fps": **not met at the extremes**: a few frames take 33–50 ms, from rendering (style, layout and paint of the whole scene when a jump crosses many events: LoAF render 24–33 ms) and, in the Blueprint, one 50 ms task (a lane layout when new lanes appear). The 183 ms Atlas maximum is again outside the main thread.

### 2.4 Mode switch

Four switches, measured over 1.5 s each, at 10:40 with a cell selected.

| | Headed | Headless |
|---|---|---|
| Atlas → Blueprint (first) | max **166.5 ms**; LoAF script **92 ms** (Blueprint mounts, columns and layout computed) | max 33.3 ms |
| Blueprint → Atlas | max 50.8 ms, **15.6%** of frames over 33 ms; script 1.2 ms/frame | max 50 ms |
| Atlas → Blueprint (again) | max 33.4 ms | max 33.3 ms |
| Blueprint → Atlas (again) | max 83.3 ms, **12.1%** over 33 ms | max 34.2 ms |

Budget "no frame over 24 ms": **fail** in both. Causes: (1) the first switch to the Blueprint does 92 ms of script in one frame (mounting the view and computing its layout: `blueprint/columns.ts`, `layout.ts`); (2) the Atlas's unfold (Stage.tsx: `rotateX` 38° with perspective and `scaleY` over the whole stage, 500 ms) is raster- and composite-bound on the GPU: script stays at 1.2 ms per frame while 12–16% of frames take 50 ms, because the 2,300-element SVG is re-rasterised under a 3D transform each frame. Headless (software, no perspective compositing on the GPU) drops far fewer frames.

### 2.5 Load and memory

- Five cold loads per browser: DOMContentLoaded 61–94 ms, the Atlas painted 140–202 ms after navigation and **115–167 ms after the last script arrived** (that includes parsing and running 968 kB of JS): budget 400 ms, **pass**. (First Contentful Paint was not reported by Chromium in these runs.)
- The whole run at 16x, after a forced GC: JS heap 9.5 MB (start) → 13.1 MB (27:58) → 14.5 MB (end) → 21 MB with the Blueprint mounted; DOM nodes 2,055 → 4,332 → 4,728. Growth follows the plant filling with cells, agents and artifacts; nothing grows without bound. Before GC the heap reaches 55–68 MB in the 16x Blueprint runs (garbage from scenes, collected).
- Atlas SVG at 10:40 (three bays): far (50%) 1,371 elements, 48 text; mid (74%, 100%) 2,340, 107; near (200%) 2,737, 114. The budget is for **12 cells**; the scenario never has more than 4, so the 12-cell numbers were **not measured**; extrapolating from 3 bays, mid would exceed 2,500.

### 2.6 Bundle (capture build; the production build is identical in size)

| | Raw | gzip |
|---|---|---|
| Initial JS (`index`, runtime) | 968.2 kB | 298.2 kB |
| Initial CSS | 74.5 kB | 14.1 kB |
| Lazy JS, 21 chunks | 2,406.6 kB | 715.9 kB |
| of which `elk.bundled` (Blueprint layout; loaded at first Blueprint) | 1,429.1 kB | |
| of which `lib` (motion/xyflow) | 666.4 kB | |
| of which PixiJS chunks (light layer, only when switched on) | about 260 kB | |
| Fonts (26 woff2, 4 fetched at run time) | 887.2 kB | |
| Everything (no source maps) | 4,336.5 kB | |

ELK is fetched when the app starts (it is among the 10 requests of a plain play-through), not only when the Blueprint is opened.

## 3. Accessibility

### 3.1 axe

`@axe-core/playwright` 4.14, tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa. 32 states: Atlas and Blueprint × {10:40 nothing selected, 27:40 verdict gate selected, 47:32 human gate selected} × dark and light × 1920 x 1080 and 1100 x 800, plus Theater Mode and the help sheet in each theme and size.

Result: **8 violations, one rule**: `target-size` (serious) on the timeline's resize handle (`button.-top-px`, 6 px tall), in the four 1100-wide states with a selection (where the inspector overlay opens). Every other state is clean.

### 3.2 Keyboard-only walkthrough

Every interaction in the brief was done with the keyboard alone and checked against the store (`_a11y/report.json`, `keyboard`): 44 of 44 steps passed.

| Interaction | Keys | Result |
|---|---|---|
| Skip to the stage | Tab, Enter | Focus in the stage |
| Into the Atlas canvas (one tab stop) | Tab | `role=application` |
| Zoom | + / - / 0 | 0.74 → 0.89 → 0.62 → fit |
| Pan | Shift+Arrows | Camera moves 80 px per press |
| Move between entities | Arrows | **All 59 of 59** Atlas entities reached |
| Selection | Enter on an entity | Selected |
| Agent inspection | Enter on an agent | Inspector lists its tool calls |
| Focus (smooth camera) | F | Camera frames the selection |
| Dependency highlighting | Arrows to a cable, Enter | 3 → 35 dimmed groups |
| Clear | Escape | Selection cleared; with nothing selected, leaves Theater |
| Play / pause | Space (on the canvas) | Toggles |
| Step by event, by 10 s, by chapter | . , / Shift+. Shift+, / ] [ | All work |
| Speed | } { | 1 → 4 → 2 |
| Start / live edge / return to live | Home / End / L | All work; L turns follow on |
| Camera follow | Shift+F | On |
| Theater | T, Escape | On, off |
| Inspector, timeline, help | I, Shift+T, ?, Escape | All work; focus returns from the help sheet |
| Scrubbing | Slider: Arrows, PageUp/PageDown | Playhead moves; `aria-valuetext` "6 minutes 55 seconds, replay" |
| Timeline tracks | Right, Down, Enter | Steps events; selects a track's cell |
| Graph expansion (Blueprint) | 2, Arrows, Alt+Right / Alt+Left | Expanded 6 → 7, collapsed back |
| Blueprint select, zoom, pan | Enter, +, Shift+Arrows | Work |
| Back to the Atlas | 1 | Works |

Nothing in the brief needs a pointer. Not provided by keyboard (by design, spec f.10): Tab between entities (arrows instead) and `*` expand-all.

### 3.3 Focus order and visibility

Tab order from the top (45 stops): skip link → top bar (Theater, inspector, help, theme radios) → Atlas canvas → its zoom buttons → inspector (Go to this moment, cells, waiting slices, actors) → timeline (resize handle, transport, follow, speed, collapse, playhead slider, 14 chapter flags, track rows). This is spec f.11's order except that the **inspector comes before the timeline** (the spec has timeline then inspector), and the mode switch is reached only after the theme radios. Every stop reported `:focus-visible` with a 2 px solid outline, except the resize handle and the slider, which draw their own (`focus-visible:bg-focus`, inset outline); images in `_a11y/focus-*.png`. An Atlas entity with focus gets the drawn ring rectangle (`focus-atlas-entity.png`).

### 3.4 Reduced motion, measured

`prefers-reduced-motion: reduce` emulated; 30 frames of 1x playback (33 ms of wall time each, manual clock) through five travelling moments at a fixed camera. Each drawn element's screen position was read every frame; an element that moves in 3 or more frames is travelling, one that jumps once was re-laid out because something appeared.

| Moment | Travelling elements without reduction | With reduction | What still travels |
|---|---|---|---|
| Dispatch (00:31) | 25 | **25** | the wave manifest group (`wave:WAVE-007`): a `g` and a `path` moving every frame for 3 s of factory time |
| Verification fails (27:19) | 8 | 5 | the LOCAL-033 merge card on the trunk, still settling |
| Rejection crosses (32:08) | 2 | 0 | none |
| Merge to the trunk (42:42) | 8 | **5** | the merge worker `agent:ag-031-22`: its post (`line`) and head move a few px per frame as it leaves (agentLeave) |
| Dependency unlocks (43:30) | 0 | 0 | none |
| Mode switch | fold (WAAPI) | cut: one view mounted two frames later | none |

Under reduction the travelling packets, the retry loop, the rejection and the dependency unlock all show their end states at the event time, and the mode switch is a cut. Three things still move (defects D1 to D3). Also: the design system's reduced-motion rule (`transition-duration: 0.01ms` on `*`) creates a 0.01 ms CSS transition for every changed SVG property (`d`, `transform`, `cx`, `r`, `fill`…), 15–30 at a time; they are invisible but are work (defect D11).

### 3.5 Contrast of the factory tokens

Computed from the rendered custom properties in each theme (canvas readback), ratios per WCAG 2.x: text roles (`ink`, `ink-muted`, `factory-ink`) on ground, plate top, floor, machine top and the finished floor need 4.5:1; marks (`live`, `pass`, `fail`, `wait`, `human`, `route`, `select`, `ink-soft`) need 3:1, also against their own `-soft` tint. **60 pairs per theme, all pass.** Lowest: dark `factory-route` on `machine-top` 3.16, `factory-ink-soft` on `machine-top` 4.12; light `factory-route` on ground 3.27 and on `done` 3.38. axe's text-contrast rule passed in all 32 states.

### 3.6 Colour alone

Greyscale renders of six principal states (`_a11y/grey-*.png`), judged by eye. In grey, every state stays distinguishable: working (ring with spokes, filled head), passed (tick discs), failed (cross disc, heavier outline: the refused Verify machine stands out by its double outline and crosshair-with-cross plaque), waiting (hourglass, dashed), a person (ring with dot, the gatehouse), the retry (dashed arc with counted pips "Round 2 of 3"), the dependency (dashed versus solid, padlock), the selection (corner brackets). Text callouts repeat every failure and hold in words. What leans on colour: in the Blueprint at fit, a span's state on the timeline bars (thin coloured bars, distinguished mostly by hue; the end marks help only when zoomed), and the Atlas floor tint of a finished bay (`done`) versus an active one, which in grey is close; both are also stated in the inspector and the callouts.

### 3.7 Screen-reader semantics (accessibility tree, no screen reader)

ARIA snapshots: `_a11y/aria-atlas-selected.txt`, `aria-blueprint-selected.txt`. Landmarks: `header` (top bar), `main` "Factory Atlas (simulation)" / "Execution Blueprint (simulation)", `aside` "Inspector: gate" (the word follows the selection), `section` "Execution timeline"; toolbars "Atlas camera", "Blueprint camera", "Transport"; the Atlas canvas is a `role=application` with instructions in its name; the Blueprint is a `role=tree` of `treeitem`s with level, set position and `aria-expanded`; the timeline tracks are a `role=application` with instructions; the playhead strip a slider with `aria-valuetext`. Every Atlas entity is a `role=button` with a sentence name that states its state ("Build: Working, for 7 min 01 s"), `aria-pressed` for selection. The "Simulation" stamp has a descriptive title and the page title and h1 say "simulation".

Live regions during one minute of playback at 1x from 26:40 (virtual clock, so the announcer's own 4 s spacing is honoured; `_a11y/report.json`, `liveRegion`):

1. (zoom readout, polite) "Mid · 74%"
2. (transport) "Playing at 1 times, live."
3. "LOCAL-033: review round 1 APPROVED (2 approved, 2 needed); blocker from product outvoted."
4. "Chapter 8: First work lands. LOCAL-033 merged into main as 67dab45."
5. "Chapter 9: R4 fails: back to build. LOCAL-031: verification FAIL_WITH_EVIDENCE (7 passed, 1 failed)."
6. "Execution x60f016d342a9 ended; LOCAL-033 is finished ($7.18). And 2 more."
7. "LOCAL-032: review round 1 of 3, 3 seats, 3 approvals needed. And 1 more."
8. "Chapter 10: A security blocker. LOCAL-032: review round 1 REJECTED (2 approved, 3 needed)."

Rate and wording are good. One problem: an Atlas station's name can be stale during playback (defect D8). The atlas zoom readout is a live region, so every zoom step is announced ("Mid · 74%"); that is chatty during pinch or wheel zoom.

**Not verified without a real screen reader and real users**: how VoiceOver or NVDA actually read the `application` canvas, the SVG buttons and the tree (virtual-cursor behaviour, whether the instructions in the long names are read once or every time); whether polite announcements are spoken over or queued behind navigation; whether the 120-character entity names are tolerable; whether people find arrow navigation across 59 entities usable; switch access and voice control; and whether anyone can follow the factory at all without sight. These need sessions with screen-reader users.

### 3.8 200% zoom

Rendered at 960 x 540 and 640 x 400 CSS px with device scale 2 (a 1920 x 1080 or 1280 x 800 window at 200%). The layout does not reflow: the page scrolls horizontally; at 960 the mode switch is cut off ("Atl…") and the Atlas zoom buttons and the timeline's collapse button are off screen; at 640 the whole right half of the top bar (Theater, inspector, help, theme, mode) and the zoom controls are off screen (`_a11y/zoom200-*.png`). All of it stays reachable by keyboard shortcuts, but not by pointer without scrolling. WCAG 1.4.10 (reflow at 320 CSS px) is not met; the app is a desktop tool, so this is recorded rather than expected.

## 4. Honesty verification

### (a) No network request at run time

A fresh page under the M5 policy, played from 00:00 to the end at 16x with mode switches, a selection, Theater on and off, the help sheet, both themes and the WebGL light layer switched on. **10 requests, all same-origin static assets**: the document, `index` and `rolldown-runtime` scripts, the lazy `elk.bundled` and `effects` chunks, one stylesheet, 4 woff2 fonts. No fetch, XHR, WebSocket, beacon, external origin or `data:` asset.

### (b) The M5 Content-Security-Policy

`scripts/lib.mjs` serves the capture build from its own static server on 127.0.0.1:4187 with the M5 host's header verbatim (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`, from `apps/studio/internal/security/headers.go`). Over the same play-through: **0 `securitypolicyviolation` events, 0 console errors**. The light layer ran under it (PixiJS with `unsafe-eval` shim): a canvas appeared, `aria-hidden`, but sized **1352 x 22 px** (defect D12).

### (c) Source scan (`src/**/*.ts{,x}`, comments excluded)

No `Math.random`. No `Date.now`. `new Date` twice: `shell/chrome.tsx` (formatting the scenario's fixed start date) and `sim/scenario/recorder.ts` (turning fixture `t` into the `at` string); neither reads the clock. `performance.now`, `requestAnimationFrame`, `setTimeout`: `scene/clock.ts` (the browser clock: the allowed place; the store takes time only from its injected `Clock`), and interface code only: the Atlas camera easing and follow throttle (`atlas/camera.ts`, `atlas/index.tsx`), the Blueprint follow throttle and lane-animation timer (`blueprint/index.tsx`), a layout timing measurement (`blueprint/columns.ts`), the announcer's rate limit, Theater's 2.5 s transport timer, focus management (`keyboard.ts`, `Stage.tsx`, `inspector/parts.tsx`), the dev frame meter (`atlas/Meter.tsx`) and the light layer's frame loop (`effects/index.tsx`). None of them computes factory progress; factory motion in the views is computed from the playhead (verified by (d) and (e)).

### (d) Determinism

Ten playhead times (00:00, 00:34, 10:40, 26:41, 27:32, 32:20, 42:47, 43:42, 47:32, 52:05), both views, three routes, each twice in a fresh page: **seek** directly; **play to** it (seek 10 s before, 1x on the manual clock, exactly 1000 ms of wall time in 250 ms frames); **scrub back** to it (seek 5 min later, a real pointer drag on the playhead strip back, then the exact time). 120 renders, the camera pinned (Atlas at fit, the Blueprint at its first placement; recorded and equal), compared as markup (`#stage` plus the inspector's text) and as pixels.

- **Same route twice: markup identical in 60 of 60.**
- **Across routes**: seek and play-to agree in 12 of 20 and seek and scrub-back in 2 of 20. Traced (in the Blueprint at 10:40): the scrub-back difference is keyboard focus (the drag moves focus to the timeline, so the canvas's focus ring is absent: interface state); the play-to difference is real: **after playback an Atlas station's accessible name keeps an older elapsed time** ("Build: Working, for 6 min 46 s" for LOCAL-032 after playing 06:30 → 06:40, where seeking gives the correct 6 min 56 s; build started 03:43.5). The station is not re-rendered while nothing else about it changes (defect D8). The drawn scene was otherwise identical.
- **Pixels**: identical markup rasterises to slightly different pixels in different pages (up to 0.6% of pixels, max channel delta 200 on antialiased edges), also with `--disable-gpu --num-raster-threads=1`; two screenshots of the same page are always identical. This is Chromium's rasterisation, not the app. The determinism claim stands at the markup level; a pixel-exact claim needs a pinned rasteriser.

### (e) Every moving thing has an event

20 adjacent-frame pairs (33 ms of wall time, 0.33 s of factory time at 1x) in five busy windows (10:45, 24:22, 27:18, 43:28, 54:18), camera fixed. Every Atlas entity whose markup changed was traced, with the simulation's own selectors, to a fixture event: by its own events (`eventsFor`), or for a station or slot without events of its own, by its cell's or station's event in the last 20 s. **0 unattributed.** Examples: `gate:LOCAL-031/verification#1` ← `verification.verdict` #1094 (1.0 s before); `agent:ag-033-13` ← `agent.started` #903; `slice:SLICE-024` ← `work.scheduled` #1750; `cell:LOCAL-032` ← `merge.completed` #2082. Changes outside any entity were tool tickers ("41 calls", ticker stems) and route strokes, each in a frame that contains `tool.started` / `tool.finished` or station events; elapsed-time readouts change with the playhead itself and are attributed to the open span's start event. No idle motion was found: in frames with no event in their window, nothing outside elapsed counters changed.

### (f) The Simulation label

Present and visible in all 94 screenshots (the capture script refuses to save one without it), in every one of the 5,994 frames of the three films (checked per frame), and in 14 states checked on purpose: both views, Theater Mode in both views (the top bar is inert there; Theater's own stamp is shown), the help sheet, 1100 wide with and without the overlay inspector, in both themes.

## 5. Defects

| # | Severity | Owner | Defect | Where, reproduction, evidence |
|---|---|---|---|---|
| D1 | Medium | atlas | **Reduced motion: the wave manifest travels at arrival.** With `prefers-reduced-motion`, elements of `wave:WAVE-007` move every frame from 00:30.5 for about 3 s of factory time. | Seek 00:30.5, play 1x on the manual clock, read positions per frame (`audit.mjs` section 4; `_a11y/report.json` `reducedMotion.reduce[0]`). |
| D2 | Medium | atlas | **Reduced motion: agents' posts sink and rise.** `agent:ag-031-22`'s post and head move a few px per frame as it leaves (42:42–42:46); spec e says agentArrive / agentLeave fade under reduction. | Same method at 42:42.1. |
| D3 | Low | atlas | **Reduced motion: the merge card still settles on the trunk** (5 elements moving at 27:19 for LOCAL-033's merge card). | Same method at 27:18.5. |
| D4 | Medium | shell | **Mode switch drops frames**: first switch to the Blueprint 166 ms frame (92 ms script: Blueprint mount and layout); every unfold to the Atlas 12–16% of frames at 50 ms on the GPU (3D `rotateX` fold re-rasterising the whole SVG). Budget: no frame over 24 ms. | `measure.mjs`, `_perf/report.json` `modeSwitch`. Pre-computing the Blueprint layout and folding a cached bitmap (or a 2D cross-fade) would fix both. |
| D5 | Low | atlas | **SVG over budget at far zoom**: 1,371 elements at 50% with three bays (budget 1,200); mid is 2,340 of 2,500 with 3 bays, so 12 cells would exceed it. | `measure.mjs` counts. Far zoom does not cull the bay interiors. |
| D6 | Low | atlas | **Callouts are clipped at the stage's right edge**: "Rejected · security bl…", "Passed panel · needs a person · 3 o…". The placement tries directions but does not keep the label inside the viewport. | `08-rejection-crosses-atlas-dark.png`, `11-human-gate-held-atlas-dark.png`. |
| D7 | Low | atlas | **Text collisions at near zoom**: the review chamber's "NEEDED" register plaque overprints its own lines ("High · 3 of 3 + a person / Medium · 2 of 3"); the selection label "LOCAL-033 · review#1" overlaps the FR-02 flag and an agent's head; "Sonnet · 2 min" is crossed by the agent's post and the gate post. | `05-review-fan-out-atlas-dark.png` (chamber, right of centre). |
| D8 | Low | atlas | **Station accessible names go stale during playback**: the elapsed time in a station's name ("Build: Working, for 6 min 46 s") is not updated while nothing else about the station changes; seeking to the same time gives "6 min 56 s". The scene at t then depends on how t was reached (contract rule 1, in the accessible layer). | Seek 06:30, play to 06:40, read `aria-label` of LOCAL-032's build station; compare with a fresh seek to 06:40. |
| D9 | Low | shell | **`target-size` failure**: the timeline resize handle is 6 px tall (axe serious) in the 1100-wide layout with the inspector overlay. | axe, 4 states per theme at 1100 x 800. |
| D10 | Low | shell | **No reflow at 200% zoom**: horizontal scroll; top-bar controls, zoom buttons and the timeline collapse off screen at 960 x 540 and 640 x 400 CSS px. | `_a11y/zoom200-*.png`. |
| D11 | Low | grammar | **Reduced-motion rule creates hundreds of 0.01 ms transitions** on SVG geometry (`d`, `transform`, `cx`, `r`, `fill`): the `*` rule in `@mach/ui` styles sets `transition-duration` on everything, so every changed property starts a transition. Invisible, but work per frame. | `getAnimations()` under reduction: 15–30 running at once (`_a11y/report.json`). |
| D12 | Low | atlas (effects) | **The optional light layer's canvas is 1352 x 22 px** when switched on (expected the stage size). Off by default and dropped for M6.0. | Help sheet → light layer on, Atlas, 10:40; `_honesty/report.json` `lightLayer`. |
| D13 | Low | blueprint | **The pinned column head is cut by the sheet's zone strip** when the sheet is scrolled: the stage names (VERIFY, VERDICT, REVIEW, CONSENSUS…) lose their top half under the grid letters. | `11-human-gate-held-blueprint-dark.png`, top edge of the sheet. |
| D14 | Low | sim | **Selecting a dependency dims its downstream dependent**: with `dependency:SLICE-024->SLICE-021` selected, `slice:SLICE-025` (which waits for SLICE-024) is at opacity 0.28 while its own cable stays lit; selecting `slice:SLICE-024` lights it. Spec f.4 asks for prerequisites and dependents, transitively. | Seek 43:42, select the dependency, read the slice's opacity (or compare `10-dependency-unlocks-atlas-dark.png`). `relatedRefs` for a dependency ref. |

Also observed, not counted as defects: at 1100 wide, framing a selection centres it in the full stage, so half of it can sit under the overlay inspector (`23-narrow-1100-c-*`); the Atlas zoom readout is an `aria-live` region, so each wheel or pinch step is announced; the inspector comes before the timeline in Tab order (spec f.11 has the reverse); ELK (1.4 MB) loads at start-up rather than on first Blueprint use.

## 6. Not measured or not done

- **12-cell density**: the scenario has at most 4 cells; the spec's budgets are for 12. All counts and frame times here are for this scenario.
- **React commits per frame**: needs a profiling build; not measured. **L2 draw calls**: the layer is dropped for M6.0; not measured.
- **The 1440 x 900 M1 reference** of the budgets: measured at 1920 x 1080 on an M3 instead.
- **A trace-level profile** (DevTools performance trace) of the headed maxima at 83–200 ms: they were attributed only negatively (no long task, no long animation frame), not to a specific process.
- **Real screen readers and real users** (3.7), real 200% browser zoom (emulated by viewport and device scale), Windows high-contrast / forced colours, touch and pinch on a trackpad (the wheel was used), Firefox and Safari.
- **Pixel-exact determinism**: the comparison is exact at the markup level; pixels vary by Chromium's rasterisation between pages (section 4 (d)).
- The CSP check ran against my own static server with the M5 header, not the M5 Go host itself.

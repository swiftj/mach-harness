# MACH Next — M6.0 findings: performance, accessibility and honesty (re-measured)

Independent re-measure of the Living Factory prototype after the defect-fix round (branch `feature/mach-next-m6-living-factory`, HEAD `8a83ab0`; the fixes are `b124554..8a83ab0`). The first report measured `34e5f39`; where both exist, the tables give **before → after**. Everything was measured on the **capture build** (`vite build --mode capture`: the production build plus the `window.__machSim` hook; the production build has the same bundle size). The prototype is a simulation; so is everything in the screenshots and recordings.

Evidence: `web/apps/control-tower/screenshots/` (README lists every file), `screenshots/_perf/report.json`, `_a11y/report.json`, `_honesty/report.json`, `_layout/report.json`, and `web/apps/control-tower/recordings/`. Scripts: `web/apps/control-tower/scripts/{lib,capture,record,measure,audit,honesty}.mjs`.

**What changed in the app that the scripts had to follow.** The stage now keeps both views mounted; the inactive one is `visibility: hidden`, `inert` and `aria-hidden`, but still has layout boxes and DOM, so every selector, box and count is scoped to `[data-stage-active]`. The light layer's canvas is `.atlas-effects-layer canvas` (the first canvas on the page is the timeline's). Atlas arrows are spatial, so reachability is now proved by building the arrow graph (every arrow from every entity) and searching it from the entry point. The timeline starts as a one-row summary, the inspector is narrower (344 / 368 px), the mode switch is a flat 700 ms fold (a cut under reduced motion), and the Blueprint at Fit draws simplified marks.

## 1. Summary

| Area | Check | Before (34e5f39) | After (8a83ab0) | Verdict now |
|---|---|---|---|---|
| Performance | Scrubbing: 60 fps, scene update ≤ 8 ms/frame | script 1.8–2.2 ms/frame; max 183 ms (Atlas, headed); 0.4% of frames > 33 ms | script 1.8–2.3 ms/frame, all main-thread work 4.0–5.3 ms/frame; max **50 ms** (Atlas, headed, one frame), 33 ms elsewhere; ≤ 0.2% > 33 ms | Update cost **pass**; 60 fps **still missed by one or two frames per sweep** |
| | SVG elements ≤ 2500 mid, ≤ 1200 far | at 10:40: far **1371**, mid 2340, near 2737 | at 10:40: far 929, mid 1848, near 2248. **Whole run** (every minute, then every 5 s near peaks): far max **1116** (27:15), mid (fit, 94%) max **2375** (46:45) | **Pass** both (mid with 5% headroom, 4 cells not 12) |
| | Upright text ≤ 160 | 48–115 | whole run: far max 54, mid max 120; near 116 at 10:40 | **Pass** |
| | Mode switch: no frame over 24 ms | max 166 ms; 12–16% of frames > 33 ms going to the Atlas (headed) | 36 switches per browser. Headed: 34 of 36 clean (max 18.8 ms); **2 failed**, both the first switch to the Blueprint after jumping to a new moment (one 466 ms frame; one run of eleven 33 ms frames). Headless (software raster): 32 of 36 switches have frames of 32–50 ms | **Fail, much improved**: steady state passes on the GPU; first switch after a jump and software rendering do not |
| | First paint ≤ 400 ms after the JS | 115–167 ms | 119–145 ms headed, 104–113 ms headless (5 cold loads each) | **Pass** |
| | React commits ≤ 1/frame; L2 draw calls ≤ 40 | not measured | not measured | Not measured |
| | Playback 1x / 4x / 16x, both views | p95 16.8–17.9; max up to 200 ms; ≤ 0.9% > 33 ms | p95 16.9–18.6; max 18.7 ms except Atlas near/following (33–35 ms, ≤ 0.8% > 33 ms); no long tasks | **Smooth**; cost per frame rose (see 2.2) |
| | Memory over the run (after GC) | heap 9.5 → 13.1 → 14.5 MB; nodes 2,055 → 4,332 → 4,728 | heap 9.6 → 23.0 → 27.6 MB; nodes 1,541 → 5,847 → 7,282 (start, mid, end) | Bounded; **about double**, because both views are now always in the DOM |
| | Bundle | initial JS 968 kB (298 gz), total 4.34 MB | initial JS 907 kB (279 gz), CSS 76 kB, lazy 21 chunks 2.41 MB, fonts 887 kB, total 4.28 MB | No budget set |
| Accessibility | axe WCAG 2.2 A/AA | 32 states, 8 violations (`target-size`, timeline resize handle) | 36 states + 6 at 200%: **8 violations + 2 at 200%, one rule**: `target-size` on the **Blueprint minimap's lane buttons** (`.bp-minimap-lane`, 5 nodes) whenever the Blueprint has a selection. The resize handle passes | **1 new defect (N1)**; old one fixed |
| | Keyboard-only walkthrough | 44 of 44 | 44 of 44 | **Pass** |
| | Atlas arrows reach every entity | 59 of 59 (reading-order walk) | spatial graph search: **59/59** at 10:40, **71/71** at 43:42, **69/69** at 55:50, **63/63** zoomed to 200% at 27:40; no dead ends; longest path 10 keys | **Pass** |
| | Focus return after the help sheet | "returns" (not checked to the element) | back on the **same element** for 9 openers (canvas, entity, selected entity, Blueprint tree item, slider, tracks, top-bar button, help button by key and by mouse), and to the Atlas canvas when the opener was re-rendered away | **Pass** |
| | Hidden (mounted) view | n/a | 0 Tab stops in the hidden view (45 and 47 stops round the page); not in the ARIA tree; cannot take focus; 0 duplicate ids (Atlas up, Blueprint fully expanded, help open); window keys reach only the active view | **Pass** |
| | Reduced motion, measured | 3 things still travelled; 15–30 transitions running | **0 travelling elements** in 6 windows (incl. the three earlier failures); **0 Web Animations** running; mode switch is a same-frame cut; follow camera made no eased move in 90 frames | **Pass** |
| | Contrast of factory tokens | 60 pairs/theme pass (lowest 3.16) | same: 60 pairs/theme pass, lowest dark `route` on `machine-top` 3.16, light `route` on ground 3.27 | **Pass** |
| | Greyscale | readable | readable (`_a11y/grey-*.png`, judged by eye) | **Pass** |
| | Screen-reader semantics (no screen reader) | 1 stale name | stale-name probe: 0 of the Atlas's names differ between play-to and seek | **Pass** (tree level only) |
| | 200% zoom (960 x 540 @2) | no reflow, controls cut off | **Reflows**: no horizontal scroll, every control on screen, Simulation stamp visible, axe clean except N1. At 640 x 400 @2 the chapter-step buttons are hidden and the run title shrinks to "I." | **Pass at 960** (the WCAG case for a 1920 screen); 640 partial |
| Honesty | (a) No network at run time | 10 same-origin requests | 10 same-origin requests (document, 4 scripts incl. lazy ELK and effects, 1 CSS, 4 fonts) | **Pass** |
| | (b) M5 CSP | 0 violations; light canvas 1352 x 22 | 0 violations, 0 console errors; light layer on the real GPU: canvas **1552 x 890 = the stage**, follows a resize to 1256 x 710; headless has no WebGL and the layer correctly stays off | **Pass** |
| | (c) No randomness / wall clock driving progress | none | none: no `Math.random`, no `Date.now`; timers and `performance.now` only in the clock and interface code (now also `Stage.tsx`: idle preparation and the fold) | **Pass** |
| | (d) Determinism (markup) | same route 60/60; across routes 12/20 and 2/20 | same route twice **20/20**; **seek = play-to = scrub-back in 20/20** (canonical markup, see 4 (d)) | **Pass** |
| | (e) Every moving thing has an event | 0 unattributed | 20 frame pairs, 0 unattributed | **Pass** |
| | (f) "Simulation" in every state/frame | 94 shots, 5,994 frames, 14 states | 94 shots, every film frame (section 5), 24 states (adds 200%, reduced motion, Theater at 200%) | **Pass** |

Defects: of the 14 earlier ones, **12 fixed, 2 partly fixed (D4 mode switch, D7 text collisions), 0 untouched** (section 6). **4 new** defects, none blocking the review (section 7).

## 2. Performance

### 2.1 What was run

- Apple M3, 8 cores, 16 GB, macOS (Darwin 27.2.0), built-in display at 60 Hz.
- **Headed**: Playwright's Chromium 145.0.7632.6, `headless: false`, `--ignore-gpu-blocklist`, viewport 1920 x 1080 @1. WebGL renderer "ANGLE Metal Renderer: Apple M3" (the real GPU).
- **Headless**: same Chromium, headless shell, **no WebGL** (software raster).
- App on its real clock (rAF), dark theme, LOCAL-031 selected, both views prepared (the hidden one is prepared while idle; each run waits for it). 8 s per playback run from 06:40. Frame intervals from rAF, long tasks, LoAF, and CDP counters per frame, as before. At 60 Hz, "> 16.7 ms" counts vsync jitter; "> 33 ms" counts dropped frames.
- The timeline now starts as a summary row (142 px), so the Atlas stage is larger (1552 x 890 instead of about 1528 x 760) and its fit zoom is 94% (was 74%).

### 2.2 Playback (headed, GPU; ms per frame interval, main-thread ms per frame)

| View | Speed | p95 | max | > 33 | script | layout | style | long tasks | before: max / script |
|---|---|---|---|---|---|---|---|---|---|
| Atlas at fit (94%) | 1x | 18.6 | 18.8 | 0 | 1.53 | 0.27 | 0.14 | 0 | 83.4 / 0.98 |
| | 4x | 18.6 | 18.7 | 0 | 2.35 | 0.30 | 0.14 | 0 | 34.1 / 1.16 |
| | 16x | 18.6 | 18.7 | 0 | 2.98 | 0.40 | 0.22 | 0 | 200 / 2.19 |
| Atlas near (200%), following | 1x | 18.6 | 33.4 | 0.2% | 1.87 | 1.28 | 0.15 | 0 | 17.6 / 0.88 |
| | 4x | 18.6 | 34.9 | 0.4% | 2.95 | 1.35 | 0.16 | 0 | 17.7 / 1.38 |
| | 16x | 18.6 | 35.3 | 0.8% | 3.49 | 1.38 | 0.24 | 0 | 49.9 / 2.40 |
| Blueprint, lanes collapsed | 1x | 18.5 | 18.8 | 0 | 0.80 | 0.49 | 0.15 | 0 | 17.7 / 0.58 |
| | 4x | 18.0 | 18.8 | 0 | 1.08 | 0.53 | 0.17 | 0 | 17.7 / 0.88 |
| | 16x | 17.8 | 18.7 | 0 | 1.72 | 0.55 | 0.21 | 0 | 17.7 / 1.51 |
| Blueprint, every agent expanded | 1x | 17.8 | 18.7 | 0 | 1.08 | 0.49 | 0.14 | 0 | 116.6 / 1.12 |
| | 4x | 17.6 | 18.7 | 0 | 1.82 | 0.55 | 0.18 | 0 | 33.3 / 1.95 |
| | 16x | 17.8 | 18.7 | 0 | 3.29 | 0.87 | 0.28 | 0 | 33.2 / 3.00 |

Headless: p95 16.9–18.0, max 18.5–33.3 ms, no frame over 33.4 ms, script 0.66–3.52 ms per frame, no long tasks.

Reading: the isolated 83–200 ms headed maxima are gone. Script per frame rose by 0.3–1.1 ms in the Atlas (the hidden Blueprint is still updated, in 500 ms batches, and the larger stage draws more), and Atlas near/following now has layout of 1.3 ms per frame (was 0.25–0.5) with up to 0.8% dropped frames at 16x. All well inside the 8 ms budget. The p95 of 18.6 ms in the headed runs (16.8 before) is the display's vsync spread in this session, not app work (every configuration, including the idle-cost Blueprint, shows it).

### 2.3 Scrubbing across the whole run

A real pointer drag on the playhead strip, 0:00 to 55:50 and back, 240 moves over about 4 s, cell selected.

| | Frames | p95 | p99 | max | > 33 | script/frame | task/frame | worst LoAF | before: max |
|---|---|---|---|---|---|---|---|---|---|
| Atlas, headed | 492 | 18.0 | 18.6 | **50.0** | 0.2% | 2.26 | 5.28 | render 33 ms; one long task | 183.4 |
| Blueprint, headed | 485 | 17.9 | 18.6 | 32.6 | 0 | 1.93 | 4.19 | none over 50 ms | 49.9 |
| Atlas, headless | 485 | 17.3 | 18.5 | 33.3 | 0 | 1.97 | 4.56 | render 29 ms | 33.3 |
| Blueprint, headless | 485 | 17.6 | 18.6 | 32.6 | 0 | 1.82 | 3.97 | render 31 ms | 50 |

"Scene update ≤ 8 ms per frame": **met** (all main-thread work 4.0–5.3 ms per frame). "60 fps": **not quite**: one 50 ms frame in the headed Atlas sweep (render-bound, LoAF render 33 ms: a jump that crosses many events restyles and repaints much of the scene) and single 33 ms frames elsewhere.

### 2.4 Mode switch

Six round trips at each of 10:40, 27:40 and 47:32 with a selection (36 switches per browser), each measured over 1.2 s from the key; then a switch 300 ms after a cold load; then the reduced-motion cut, 8 times.

| | Headed (GPU) | Headless (software) |
|---|---|---|
| All 36 switches, every frame (2,518 / 2,434 frames) | p50 16.7, p95 18.1, p99 18.6, max **466.4**; 14 frames > 24 ms, 2 > 33.4 | p50 16.7, p95 18.7, p99 33.4, max 50; 119 frames > 24 ms, 23 > 33.4 |
| To the Blueprint, per-switch worst frame | 16 of 18 at 18.2–18.8; **33.4** (first switch at 47:32: eleven frames at 33 ms, layout 5.5 ms/frame); **466.4** (first switch at 27:40) | 4 of 18 under 24; 14 at 31.6–50 |
| To the Atlas, per-switch worst frame | 18 of 18 at 18.3–18.7 | 18 of 18 at 33.3–34.9 |
| Switch 300 ms after a cold load | max 18.2 (both views were already mounted at 300 ms) | max 18.7 |
| Reduced motion (a cut), 8 switches | max 18.2–18.7 | max 18.4–18.7 |

Budget "no frame over 24 ms": **fail**, but the failure has narrowed from "every switch" to two cases. (1) **The first switch to the Blueprint after the playhead has jumped to a new moment**: the hidden Blueprint is held at its last 500 ms batch, so the switch makes it catch up a large jump in one go (2 of 18 headed switches; the 466 ms frame had no long task and no LoAF over 9 ms of render, so it was not attributed further; layout and style per frame tripled in both). Later switches at the same moment are clean. (2) **Software rendering**: in headless Chromium the compositor-only fold still costs 33 ms frames in most switches. On the real GPU, steady-state switching in both directions passes. (Defect D4: partly fixed.)

### 2.5 Load, memory, element counts

- Five cold loads per browser: the Atlas painted 119–145 ms (headed) and 104–113 ms (headless) after the last script arrived. **Pass.**
- Whole run at 16x, after a forced GC: heap 9.6 → 23.0 → 27.6 MB, DOM nodes 1,541 → 5,847 → 7,282 (start, 28:00, end); switching to the Blueprint at the end adds almost nothing (27.5 MB, 7,301 nodes) because it is already mounted. About twice the earlier figures: the cost of keeping both views mounted. It grows with the plant and stops; nothing grows without bound.
- Atlas SVG elements at 10:40 by zoom: 35–60% (far) 929 / 50 text; 74–140% (mid) 1,848 / 109; 200% (near) 2,248 / 116. The hidden Blueprint adds 845 SVG elements to the DOM (outside the per-view budget, but real).
- **Across the whole run** (every minute, then every 5 s within a minute of the three highest minutes; headless only, the counts are DOM counts): far (50%) max **1,116** at 27:15, text max 54; mid at the fit (94%) max **2,375** at 46:45, text max 120. Mid counts are the same at 74%, 100% and 140% (no culling inside mid), so the fit stands for mid. The budgets are for 12 cells; this scenario never has more than 4, so mid's 5% headroom says nothing about 12 cells.

## 3. Accessibility

### 3.1 axe

`@axe-core/playwright` 4.14, tags wcag2a/aa, wcag21a/aa, wcag22aa. 36 states: both views × {10:40, 27:40 verdict selected, 47:32 human gate selected} × both themes × 1920 x 1080 and 1100 x 800, plus "timeline tracks open, gate selected", Theater and the help sheet per theme and size; and six states at 200% (960 x 540 and 640 x 400 @2, Atlas, Atlas selected, Blueprint selected).

Result: **one rule, `target-size` (serious), on the Blueprint minimap's lane buttons** (`.bp-minimap-lane:nth-child(2..)`, 5 nodes), in every Blueprint state with a selection (8 states + 2 at 200%). It was not reported before; the minimap is part of the Blueprint changes (new defect N1). The timeline resize handle (old D9) passes: it is now a 24 px target.

### 3.2 Keyboard-only walkthrough

44 of 44 steps passed, checked against the store (`_a11y/report.json`, `keyboard`): skip link, canvas, zoom (+ − 0), pan, spatial arrows to an agent and Enter, the inspector's tool calls, F, Escape, a dependency by arrows and Enter (dimmed groups 3 → 24), Space, `. , Shift+. Shift+, ] [ } {`, Home, End, L, Shift+F, T, Escape, I, Shift+T, ?, Escape, slider arrows and PageUp/PageDown (`aria-valuetext` "6 minutes 55 seconds, replay"), tracks Right / Down / Enter, `2`, tree arrows, Alt+Right / Alt+Left, Enter, Blueprint `+` (53% → 63%), Shift+Arrow, `1`.

**Spatial arrows**: the arrow graph (each arrow pressed from each entity at the fit) and a breadth-first search from the entry point: 59/59 at 10:40, 71/71 at 43:42, 69/69 at 55:50, and 63/63 zoomed to 200% at 27:40 (the bays off screen are culled from the drawing there, so they are not in the list: you pan or zoom out to reach them). No entity is a dead end; the longest shortest path is 10 key presses. No entity has more than one hit target (`duplicateRefs` empty).

### 3.3 Focus order, focus return, the hidden view

- Tab all the way round: 45 stops with the Atlas up, 47 with the Blueprint. Order: skip link → top bar (Theater, inspector, help, theme radios) → canvas → zoom buttons → inspector → timeline (resize handle, transport, follow, speed, collapse, playhead slider, 14 chapter flags, "Tracks", the tracks). The inspector still comes before the timeline (spec f.11 has the reverse). Future chapters are named "Chapter 6, not reached yet" (no title), as intended. Every stop shows `:focus-visible`; the canvas, resize handle, slider and tracks draw their own ring.
- **Focus return after the help sheet**: back on the very element for every opener tried (Atlas canvas, an Atlas entity, a selected entity, a Blueprint tree item, the playhead slider, the tracks, a top-bar button, the help button by Enter and by mouse); when the opener (an agent at 10:40) disappeared because the playhead moved to 00:10 while the sheet was open, focus went to the Atlas canvas. (The report's raw `ok: false` for "help button, by mouse" is a probe artefact: the probe marked the dialog's Close button, which had focus after the click; focus did return to the help button.)
- **The hidden view**: 0 Tab stops inside it in either direction; `inert` and `aria-hidden` (programmatic `focus()` on it is refused); the ARIA snapshot has no tree while the Atlas is up and no plant drawing while the Blueprint is up; `main` is named for the active view. 0 duplicate ids with the Atlas up, with the Blueprint fully expanded, and with help open. `+ + − 0 Shift+↓` with focus in the top bar changed neither view while the Atlas was up; with the Blueprint up, `+ + −` from the top bar changed neither either (the Blueprint takes its zoom keys only with focus in it; the help sheet lists them under "Blueprint", so this is consistent).
- When the hidden view is first prepared it is shown for three frames at 1% opacity on top of the active one (so it is rasterised once); it is `inert` throughout. Not visible, and not a defect, but worth knowing.

### 3.4 Reduced motion, measured

`prefers-reduced-motion: reduce`; 30 frames of 1x playback (manual clock) through six moments at a fixed camera; each drawn element's screen position read per frame (3+ moving frames = travelling).

| Moment | Travelling without reduction | With reduction (before → after) |
|---|---|---|
| Wave arrives (00:31, D1) | 20 (the manifest) | 25 → **0** |
| Review fan-out (26:20) | 6 | — → **0** |
| Verification fails (27:19, D3) | 3 | 5 → **0** |
| Rejection crosses (32:08) | 2 | 0 → **0** |
| Merge worker leaves (42:42, D2) | 8 | 5 → **0** |
| Dependency unlocks (43:30) | 0 | 0 → **0** |
| Follow camera, 16x, 90 frames | one eased move over 50 frames | **no** camera move in 90 frames |
| Mode switch | 2-frame 1% pre-paint, then the fold | same-frame cut: incoming view visible at opacity 1, outgoing hidden, 0 animations on the layers |
| Web Animations running at once | up to 5 (button colour transitions) | 15–30 → **0** |

**What still moves under reduction**: things that change state at an event (appear, fill, turn colour) jump once at the event time; elapsed-time readouts and tool tickers count; the playhead and the timeline advance. Nothing travels, loops or eases. D1, D2, D3 and D11 are fixed.

### 3.5 Contrast, colour

Factory tokens as rendered: 60 pairs per theme, all pass; lowest dark `factory-route` on `machine-top` 3.16, light `factory-route` on ground 3.27 (unchanged). Greyscale renders (`_a11y/grey-*.png`, regenerated from this capture set, judged by eye): every state still readable by shape, outline and pips; the Blueprint's thin span bars on the timeline remain the part that leans most on hue.

### 3.6 Screen-reader semantics (accessibility tree only)

Landmarks and roles as before (`_a11y/aria-*.txt`). Live regions over one minute at 1x from 26:40: 8 polite announcements, the same set as before (zoom readout "Mid · 94%", transport, LOCAL-033 approved with an outvoted blocker, chapters 8–10, execution ended, LOCAL-032's review). The Atlas zoom readout is still a live region, so each wheel or pinch step is announced. **Not verified**: VoiceOver/NVDA behaviour, real users, switch access, voice control (as before).

### 3.7 200% zoom

960 x 540 and 640 x 400 CSS px at device scale 2, three states each (`_a11y/zoom200-*.png`).

- **960 x 540** (a 1920 x 1080 screen at 200%): no horizontal or vertical scroll; every control on screen; the timeline starts collapsed to its transport (41 px) on a short window; the inspector is a drawer (392 px) that stops at the timeline, so the transport stays usable; axe clean except N1. The drawer covers the Atlas's zoom buttons and the right of the stage while something is selected (close it with I or Escape). **D10 fixed** for this case.
- **640 x 400** (1280 x 800 at 200%): no scroll, but the chapter-step buttons are hidden, the run title truncates to "I.", and with a selection the drawer covers all but 248 px of the stage (in the Blueprint, only the lane headers show). Usable by keyboard; cramped.

## 4. Honesty verification

### (a) Network
A fresh page under the M5 policy, played 00:00 to the end at 16x with mode switches, a selection, Theater, help, both themes, then the light layer: **10 requests, all same-origin static assets** (`/`, `index`, `rolldown-runtime`, lazy `elk.bundled` and `effects`, one stylesheet, 4 woff2). The headed light-layer page made 25 requests, all same-origin (PixiJS chunks included). No fetch, XHR, WebSocket, beacon, external origin or `data:` asset.

### (b) M5 Content-Security-Policy
Served by `lib.mjs` with the M5 host's header verbatim, on 127.0.0.1:4187: **0 violations, 0 console errors**, headless and headed. Light layer (`.atlas-effects-layer canvas`): on the real GPU it is **1552 x 890, exactly the Atlas stage**, `aria-hidden`, `pointer-events: none`, and after resizing the window it is **1256 x 710, again the stage** (D12 fixed). Headless has no WebGL: the switch turns on but no layer is created, as the spec requires.

### (c) Source scan
No `Math.random`, no `Date.now`. `new Date` only in `shell/chrome.tsx` and `sim/scenario/recorder.ts` (formatting fixture times). `performance.now`, rAF and `setTimeout` in the clock module and interface code; new since the first report: `shell/Stage.tsx` (idle preparation of the hidden view, the 500 ms batching of its updates, the fold's frame waits). None computes factory progress.

### (d) Determinism
Ten playhead times × both views × three routes (seek; play to it on the manual clock; drag the playhead back to it) × twice, 120 renders, camera pinned. Compared as **canonical markup** of the active view plus the inspector text: attributes sorted, inline style declarations sorted, and React `useId` values (`_r_f_` in pattern and marker ids) normalised.

- **Same route twice: 20 of 20 identical. Seek = play-to = scrub-back: 20 of 20.** The play-to stale name of D8 is gone.
- Why canonical: raw markup differed in two harmless ways, both new with the mounted views. (1) `useId` values depend on mount order, which depends on when the hidden view was prepared (idle time): 10 of 20 same-route pairs differed only in these ids. (2) React wrote some attributes and style declarations in a different order depending on the route (e.g. `marker-end` before or after `style`): every remaining difference was of this kind (`_honesty/det-dom-*.html`). Neither is a scene difference.
- Pixels: identical markup still rasterises with small differences between pages (up to 1.95% of pixels in the Atlas, 0.29% in the Blueprint), Chromium's rasterisation as before.

### (e) Every moving thing has an event
20 adjacent-frame pairs in five busy windows: every changed Atlas entity traced to a fixture event; **0 unattributed**.

### (f) The Simulation label
Present and visible in all 94 screenshots (the capture script refuses otherwise), in every frame of the four films (the recorder checks each; section 5), and in 24 states checked on purpose: both views, Theater in both, help, 1100 wide with and without the drawer, 200% (Atlas, Blueprint selected, Theater), reduced motion in both views, both themes.

## 5. Screenshots and recordings

- **Screenshots**: 94, the same set and names as before (`screenshots/README.md`), re-shot on the manual clock. Framing fixed in `capture.mjs` after looking at the output: `09-integration` was half empty ground below the plant's edge (now nudged to show the yard, the approval and review regions and the selected cell); the 1100 set reused one page, so `23-…-d` inherited `c`'s selection and drawer (now cleared per shot), and in `23-…-c` the selected gate sat under the drawer (now framed in the part of the stage the drawer leaves). A machine check of each shot is in `_layout/report.json` (callouts outside the visible stage, overlapping text boxes, how much of the selection is in view); its text-overlap count is a loose heuristic (rotated floor lettering has loose boxes) and was used only to point at shots to look at.
- **Recordings** (frame-exact on the virtual clock, as before; `recordings/README.md`): the main dark 1080p film at **2:49** (5,074 frames; target 2:45–3:15; it was 2:28), a 720p copy of 14.3 MB, the light clip (0:35, 1,060 frames) and the reduced-motion clip (0:20, 600 frames). New beats: the whole plant at far zoom, the timeline's tracks opened and folded, LOCAL-033's review fan-out at 1x, the verdict inspected by a click, and the Blueprint at Fit (its simplified marks) before F frames the selection. The Simulation label was visible in every frame of all three films (the recorder checks each frame).
- **A recorder problem found by looking at the output, and how it was handled.** The first render of the main film had a **blank Atlas from 1:24 to the end** (every frame after the return from the Blueprint, Theater included); the light clip had the same after its return. The DOM was intact; the Atlas layer's computed opacity was stuck at the fold's start value (0) with no animation listed on it, in headless Chromium under the recorder's held animation timeline. The same key and pointer path on the real clock, headless and headed, ends with the Atlas at opacity 1 (checked twice), so this is not counted as an app defect. The recorder now holds animations with a playback rate of 0 instead of `pause()`, and, if a resting visible layer is still below opacity 1, gives it an `!important` opacity of 1 until the app animates it again; it counts these repairs: **2** in the final main film, **3** in the light clip, **0** in the reduced clip (it fired 0 times in one main render and 2 in the next, so the glitch is intermittent). The films were re-rendered and their contact sheets checked: the stage is drawn throughout.

## 6. The 14 earlier defects

| # | Defect | Status | Evidence now |
|---|---|---|---|
| D1 | Reduced motion: wave manifest travels | **Fixed** | 0 travelling elements at 00:31 under reduction (25 before) |
| D2 | Reduced motion: agents' posts sink and rise | **Fixed** | 0 at 42:42 (5 before) |
| D3 | Reduced motion: merge card settles | **Fixed** | 0 at 27:19 (5 before) |
| D4 | Mode switch drops frames | **Partly fixed** | Headed: 34 of 36 switches clean (was none); the first switch to the Blueprint after a jump still drops frames (466 ms once, eleven 33 ms frames once); software rendering drops 33–50 ms frames in most switches (2.4) |
| D5 | SVG over budget at far zoom | **Fixed** | far max 1,116 over the whole run (1,371 at 10:40 before; 929 now) |
| D6 | Callouts clipped at the stage's right edge | **Fixed** (Atlas, full width) | `08-…` and `11-…` callouts inside the stage; a small agent label ("Sonnet · 56 s") still touches the edge in 11 and 12. The narrow drawer and the Blueprint have their own clipping (N3) |
| D7 | Text collisions at near zoom | **Partly fixed** | The chamber plaque is two lines and the agent label has a backing plate (`05-…`); still: the selection label overprints floor lettering ("LOCAL-033 · review#1" over "Consensus"; "LOCAL-032 · human-approval" over "HELD FOR A PERSON") and "Passed panel · needs a person · 3 of 3" sits on a vote pennant (`11-…`). Callouts also collide with each other: at the fit at 27:40 "Blocker outvoted · product seat FR-02" and "Approved · 2 of 3" overprint at the review chamber, and at 220% on LOCAL-031 at 29:30 "Verification failed · R4 / 7 of 8 proven…" overprints the Builder's label (seen in film frames, not in a still) |
| D8 | Station names stale during playback | **Fixed** | 0 of the Atlas's accessible names differ after play-to vs seek; determinism across routes 20/20 |
| D9 | `target-size` on the resize handle | **Fixed** | 24 px target; no longer reported (but see N1) |
| D10 | No reflow at 200% | **Fixed at 960 x 540**; partial at 640 x 400 | 3.7 |
| D11 | Reduced motion creates hundreds of 0.01 ms transitions | **Fixed** | 0 Web Animations running under reduction |
| D12 | Light canvas 1352 x 22 | **Fixed** | 1552 x 890 = the stage, follows a resize (GPU) |
| D13 | Blueprint column head cut by the zone strip | **Fixed** | `11-human-gate-held-blueprint-*`: the stage names show whole when scrolled |
| D14 | Selecting a dependency dims its dependent | **Fixed** | at 43:42 with `dependency:SLICE-024->SLICE-021` selected, SLICE-021, SLICE-024 and SLICE-025 and both of 025's cables are at opacity 1; unrelated SLICE-022/023 at 0.28 |

The earlier "also observed" items: the 1100-wide framing that centres a selection under the drawer **remains** (the app's own focus centres in the whole stage; `23-…-c` is now framed by the script); the zoom readout is still a live region; the inspector still precedes the timeline in Tab order; ELK still loads at start-up (now because the hidden Blueprint is prepared while idle; it is in the 10 requests).
## 7. New defects (found in this pass)

| # | Severity | Owner | Defect | Evidence |
|---|---|---|---|---|
| N1 | Low | blueprint | **`target-size` on the minimap's lane buttons** (`.bp-minimap-lane`, 5 nodes, under 24 px with too little spacing) whenever the Blueprint has a selection (axe serious; 10 states incl. 200%). | `_a11y/report.json` `axe` |
| N2 | Medium | shell / perf | **The first switch to the Blueprint after a playhead jump drops frames** (one 466 ms frame; one run of eleven 33 ms frames), because the hidden view, updated only every 500 ms and held while idle, catches up the whole jump inside the fold. Part of D4's remainder. | `_perf/report.json` `modeSwitch`, entries at 1660 #1 and 2852 #1 |
| N3 | Low | blueprint, atlas | **Clipping by panels**: a Blueprint callout at the left of the drawing is cut by the pinned lane headers ("…: security blocker INV-02 / …resh idempotency key, so …", `11-human-gate-held-blueprint-dark.png`); the Blueprint minimap and its playhead chip sit over the drawing's last column and over the camera toolbar (same image, bottom right); at 1100 wide and at 200% the drawer covers the Atlas zoom buttons and callouts while something is selected. | images named |
| N4 | Low | shell (inspector) | **Wrong or odd inspector wording for a merged cell**: LOCAL-031 at 42:47 says "Merged · Finished at 00:31, as of the playhead" (it merged at 42:42; 00:31 is its dispatch); rounds and Blueprint consensus nodes read "Review approved 3 of 2" / "Consensus 3 of 2" (3 approvals where 2 were needed). | `09-integration-atlas-dark.png`, `11-human-gate-held-blueprint-dark.png` |

Also noted, not counted: memory and DOM roughly doubled because both views stay mounted (2.5); at 640 x 400 @2 the run title truncates to "I."; the 33 ms frames in Atlas near/following playback (≤ 0.8%) are new but small.

## 8. Not measured or not done

- **12-cell density**: the scenario has at most 4 cells; all budgets here are for this scenario.
- **React commits per frame** (needs a profiling build) and **L2 draw calls** (layer off by default): not measured.
- **The 1440 x 900 / M1 reference**: measured at 1920 x 1080 on an M3.
- **A trace-level profile** of the 466 ms mode-switch frame and the 50 ms scrub frame: attributed only by long tasks and LoAF (neither showed it as script), not to a process.
- Element counts over the whole run were taken in headless only (they are DOM counts) and not at near zoom; the hidden Blueprint's 845 elements are reported, not budgeted.
- **The "early switch"** before the hidden view is prepared could not be provoked: both views were already mounted 300 ms after load in both browsers.
- **Real screen readers and real users**, Windows forced colours, touch and trackpad pinch (wheel used), Firefox and Safari: not done.
- **Pixel-exact determinism**: markup only; pixels vary with Chromium's rasteriser.
- The CSP check ran against `lib.mjs`'s static server with the M5 header, not the M5 Go host.
- The 640 x 400 at 200% case was looked at in screenshots, not walked through by keyboard.
- `_layout/report.json` for `09-…` and `23-…` describes the first capture pass; those shots were re-taken with `--only` after the framing fixes (the script writes the layout report only on a full run).

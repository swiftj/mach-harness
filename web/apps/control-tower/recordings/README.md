# M6.0 Living Factory: recordings

Everything in this folder except this README is generated and git-ignored. **Every frame shows a simulation**: the recorder checks that the "Simulation" stamp is visible in each frame it writes and reports any frame without it (none in the current set).

> **The current films are not of the final build.** They were rendered before the change to an all-sans typeface (`19b6e20`), so their titles, region lettering and Blueprint wave and lane titles are still in the former serif, and before the second fix round (`3d6c463` to `575790e`) and the removal of the light layer (`f9fe87e`). They were not re-recorded: the product owner chose to review the app by hand. The shot list below describes what the films show, not the current app in every detail.

## Regenerate

From `web/apps/control-tower`:

```sh
node scripts/record.mjs                 # all three films (about 10 minutes on an Apple-silicon Mac)
node scripts/record.mjs --only main     # main | light | reduced
node scripts/record.mjs --dry           # walk the script without screenshots: prints each segment's length
```

It builds `vite build --mode capture` into `dist/capture` if stale, serves it with `vite preview` on `127.0.0.1:4186`, renders in headless Chromium at 1920 x 1080, pipes PNG frames to `ffmpeg` (default `/opt/homebrew/bin/ffmpeg`, or `FFMPEG=...`), and stops the server.

### How a frame is made (deterministic, frame-exact)

1. The simulation advances by exactly one frame of wall time on its manual clock (`window.__machSim.advance(ms, ms)`; 30 fps as 33/33/34 ms steps, so 30 frames are exactly one second; factory time moves by `ms x 10 x speed`).
2. Interface time advances by the same step. Playwright's `page.clock` is installed before the app loads, so `requestAnimationFrame`, `performance.now`, `Date` and timers are virtual and move only in `page.clock.runFor(ms)`. That drives the Atlas camera easing, `motion/react`'s frame loop (the Blueprint camera), Theater Mode's 2.5 s transport timer and the follow camera's 4 s throttle.
3. Web Animations are not driven by `page.clock`. The mode fold (the stage's own WAAPI animations on the two view layers) and every CSS transition (inspector, lane expansion, Theater bar) are held with a playback rate of 0 when they first appear and their `currentTime` set each frame to the virtual time since then; at their end they are `finish()`ed, so the app's completion handlers run as they would.
   **A recorder repair, counted**: with the fold held this way, after the app cancelled a fold back to the Atlas, the Atlas layer sometimes kept the fold's start opacity (0) in headless Chromium, with no animation listed on it: a blank stage for the rest of the film. The same path on the real clock ends at opacity 1 in headless and headed Chromium (checked), so it is the held timeline, not the app. The recorder then gives a resting, visible stage layer an `!important` opacity of 1 until the app animates or styles that layer again, and reports how many times it did (`stage-layer opacity repairs` in the log): 2 in the current main film, 3 in the light clip, 0 in the reduced-motion clip (it is intermittent: one render of the main film needed none).
4. The frame is screenshotted and encoded.

So the whole film, interface transitions included, is rendered on the virtual clock: no segment was recorded in real time. Clicks, the scrub drag, the pan drag, the wheel zoom and the keys are real Playwright input; the pointer you see is drawn into the page by the recorder (`#__capture-pointer`, `aria-hidden`), not part of the product. Cuts and camera direction (glides between framings) go through `window.__machSim` and the Atlas's capture-only `window.__atlasCamera`.

Encoding: H.264 High, `yuv420p`, 30 fps, 1920 x 1080, `-preset slow -crf 15`; the 720p share copy is Lanczos-scaled, `-crf 20` (a two-pass fallback keeps it under 25 MB).

## Files

| File | Length | What it shows |
|---|---|---|
| `living-factory-dark-1080p.mp4` | 2:49 | The directed film, dark theme (below). |
| `living-factory-dark-720p.mp4` | 2:49 | The same at 1280 x 720, 14.3 MB, for sharing. |
| `living-factory-light-clip-1080p.mp4` | 0:35 | Light theme: the verification failure and its verdict inspected, the agent inspected, the Blueprint at Fit and with the agent opened, the review fan-out and the rejection crossing the plant. |
| `living-factory-reduced-motion-clip-1080p.mp4` | 0:20 | `prefers-reduced-motion: reduce`: the verification failure (end states at the event time, no travel), stepping event by event with ".", the mode switch as a cut, the rejection without travel. |

### The main film, shot by shot (film time; factory time in brackets)

| Film | Shot | Shown |
|---|---|---|
| 0:00 | The composed empty plant, live and following; the Play button is clicked. [00:00 to 00:14] | composition, live state |
| 0:08 | Camera glides to the intake dock; speed drops to 0.5x with "{"; the wave arrives, five slices are cut, three cells dispatched. [00:14 to 00:52] | speed change, the wave |
| 0:14 | Pull right back to the whole plant at far zoom (the far level of detail). [00:52 to 01:14] | far zoom |
| 0:18 | "}" to 4x, pull back over the floor; a pan drag and a wheel zoom by hand; the three bays at 1x, close; the timeline's tracks opened with "Tracks" and folded again; 16x through construction. [01:14 to 26:11] | pan, zoom, speed, timeline tracks |
| 0:53 | LOCAL-033's review panel at 1x: three seats fan out, two approve, the product blocker is outvoted. [26:11 to 27:08] | review fan-out |
| 0:59 | Push in on LOCAL-031 at 2.0; 0.5x through the R4 verdict and the return-to-build loop; the verification gate is clicked and its verdict shows in the inspector. [27:08 to 27:59] | verification failure |
| 1:08 | The returning builder is clicked (inspector with its tool calls); "F" frames it. [27:59 to 28:22] | selection, focus, agent inspection |
| 1:12 | "2": the fold to the Blueprint; "0" shows the whole sheet with its simplified marks; "F" frames the agent again; its chevron is clicked to open its tool calls; Ctrl + wheel zooms in. [28:22 to 29:23] | mode switch, Blueprint at Fit, graph expansion |
| 1:24 | Escape, "1": back to the Atlas; LOCAL-032's three seats fan out; 8x through the votes; the rejection travels back across the plant at 1x. [29:23 to 32:42] | review, rejection |
| 1:36 | Pause with the button; the playhead is dragged back across the rejection and forward again; "L" returns to live with camera follow; play at 4x. [32:42 to 36:02] | scrubbing, replay, live-follow |
| 1:51 | A cut to the human-approval gate: 8 s of stillness while LOCAL-032 waits; then the release at 0.5x. [47:20 to 48:42, 51:48 to 52:08] | the human gate |
| 2:05 | The merge machine: LOCAL-032 revalidated, merged and integrated. [52:08 to 54:34] | integration |
| 2:11 | The dependency cable is clicked; the inspector's "Go to when it cleared" replays the unlock at 0.5x. [43:24 to 43:54] | dependency highlighting |
| 2:23 | Escape, "T": Theater Mode on the whole plant at 4x to the end of the run; held on the finished plant. [43:54 to 55:50] | Theater Mode, the end |

The findings drawn from these are in `docs/mach-next/M6_0_FINDINGS.md`.

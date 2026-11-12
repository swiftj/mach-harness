# M6.0 Living Factory: recordings

Everything in this folder except this README is generated and git-ignored. **Every frame shows a simulation**: the recorder checks that the "Simulation" stamp is visible in each frame it writes and reports any frame without it (none in the current set).

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
3. Web Animations are not driven by `page.clock` (tested: the mode fold stayed at opacity 0). The fold's opacity and transform, which `motion/react` hands to WAAPI, and every CSS transition (inspector, lane expansion, Theater bar) are paused when they first appear and their `currentTime` set each frame to the virtual time since then; at their end they are `finish()`ed, so the app's completion handlers run as they would.
4. The frame is screenshotted and encoded.

So the whole film, interface transitions included, is rendered on the virtual clock: no segment was recorded in real time. Clicks, the scrub drag, the pan drag, the wheel zoom and the keys are real Playwright input; the pointer you see is drawn into the page by the recorder (`#__capture-pointer`, `aria-hidden`), not part of the product. Cuts and camera direction (glides between framings) go through `window.__machSim` and the Atlas's capture-only `window.__atlasCamera`.

Encoding: H.264 High, `yuv420p`, 30 fps, 1920 x 1080, `-preset slow -crf 15`; the 720p share copy is Lanczos-scaled, `-crf 20` (a two-pass fallback keeps it under 25 MB).

## Files

| File | Length | What it shows |
|---|---|---|
| `living-factory-dark-1080p.mp4` | 2:28 | The directed film, dark theme (below). |
| `living-factory-dark-720p.mp4` | 2:28 | The same at 1280 x 720, about 12 MB, for sharing. |
| `living-factory-light-clip-1080p.mp4` | 0:32 | Light theme: the verification failure, the agent inspected, the Blueprint with the agent opened, the review fan-out and the rejection crossing the plant. |
| `living-factory-reduced-motion-clip-1080p.mp4` | 0:20 | `prefers-reduced-motion: reduce`: the verification failure (end states at the event time, no travel), stepping event by event with ".", the mode switch as a cut, the rejection without travel. |

### The main film, shot by shot (film time; factory time in brackets)

| Film | Shot | Shown |
|---|---|---|
| 0:00 | The composed empty plant, live and following; the Play button is clicked. [00:00 to 00:14] | composition, live state |
| 0:07 | Camera glides to the intake dock; speed drops to 0.5x with "{" (the transport shows it); the wave arrives, five slices are cut, three cells dispatched. [00:14 to 00:52] | speed change, the wave |
| 0:13 | Speed up with "}" to 4x, pull back over the floor; a pan drag on empty ground and a wheel zoom by hand; the three bays at 1x, close; then 16x through construction. [00:52 to 27:00] | pan, zoom, speed |
| 0:41 | Push in on LOCAL-031 at 2.0; 0.5x through the R4 verdict and the return-to-build loop. [27:00 to 27:39] | verification failure |
| 0:47 | The returning builder is clicked (selection, inspector with its tool calls); "F" frames it with the app's own 650 ms focus. [27:39 to 28:22] | selection, smooth focus, agent inspection |
| 0:56 | "2": the mode fold to the Blueprint on the same selection; the agent's chevron is clicked to open its tool calls; Ctrl + wheel zooms in. [28:22 to 29:05] | mode switch, graph expansion |
| 1:05 | Escape, "1": back to the Atlas; LOCAL-032's three Opus seats fan out; 8x through the votes; the rejection travels from the chamber back across the plant at 1x. [29:05 to 32:30] | review fan-out, rejection |
| 1:17 | Pause with the button; the playhead is dragged back across the rejection and forward again (replay); "L" returns to live with camera follow; play at 4x while the follow camera reframes. [32:30 to 35:53] | scrubbing, replay, live-follow |
| 1:31 | A cut to the human-approval gate: 8 s of stillness while LOCAL-032 waits; then the release at 0.5x. [47:20 to 48:42, 51:48 to 52:08] | the human gate |
| 1:46 | The merge machine: LOCAL-032 revalidated, merged and integrated. [52:08 to 54:34] | integration |
| 1:52 | The dependency cable is clicked (dependency highlighting); the inspector's "Go to when it cleared" replays the unlock at 0.5x: SLICE-024 eligible and dispatched. [43:24 to 43:54] | dependency highlighting |
| 2:04 | Escape, "T": Theater Mode on the whole plant at 4x to the end of the run; held on the finished plant. [43:54 to 55:50] | Theater Mode, the end |

The findings drawn from these are in `docs/mach-next/M6_0_FINDINGS.md`.

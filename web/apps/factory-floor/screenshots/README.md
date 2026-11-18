# Factory Floor: screenshots of the Atlas

Everything in this folder except this README is generated and git-ignored. `scripts/capture.mjs` writes it. Every image shows the Simulation: the script stops with an error if a shot has no visible Simulation stamp (`[data-simulation-stamp]`).

**Not rerun since the redesign.** The script was changed when the Timeline, playback and the Execution Blueprint were removed, but it has not been run since. Any screenshots in this folder on your machine are older than the current app. The script covers the Floor (the Atlas) only, not the Line or Analytics.

## Run

From `web/apps/factory-floor`:

```sh
pnpm --filter @mach/factory-floor capture      # or: node scripts/capture.mjs
node scripts/capture.mjs --only 07             # only the shots whose name starts with 07
node scripts/capture.mjs --rebuild --sheets    # force the build; also write _sheets/
node scripts/capture.mjs --sheets-only         # only the contact sheets, from the shots already here
```

The script builds the app with `vite build --mode capture` into `dist/capture` when the build is older than the sources (`--rebuild` forces it). It serves the build with `vite preview` on `127.0.0.1:4186` and stops the server when done. The capture build is the production build plus `window.__machSim` (see `src/sim/README.md`, section 6). It needs Playwright's Chromium, and `ffmpeg` (default `/opt/homebrew/bin/ffmpeg`, or `FFMPEG=...`) for the contact sheets only.

Each shot opens a fresh page on `#floor`, holds the Simulation on its manual clock, moves it to the beat's time with `__machSim.seek`, and waits for the Atlas camera to stop. A shot that **focuses** a target only moves the camera. A shot that **selects** also opens the inspector on the entity and dims what is unrelated.

## Files

Names: `NN-beat-atlas-theme[@2x].png`, 1920 x 1080 CSS px (3840 x 2160 for `@2x`). Times are factory time (mm:ss from 14:00 UTC).

| Beat | Time | Atlas framing |
|---|---|---|
| `01-opening` | 00:00 | fit |
| `02-wave-arrives` | 00:34 | focus `wave:WAVE-007`, zoom 1.3 |
| `03-three-bays` | 10:40 | focus `cell:LOCAL-032`, zoom 1.1 |
| `04-agent-inspected` | 10:40 | select `agent:ag-031-08` |
| `05-review-fan-out` | 26:41 | select `gate:LOCAL-033/review#1` |
| `06-outvoted-blocker` | 26:52 | select `finding:LOCAL-033/r1/product/1` |
| `07-verify-fail-return` | 27:40 | select `gate:LOCAL-031/verification#1`; focus `cell:LOCAL-031`, zoom 2.0 |
| `08-rejection-crosses` | 32:20 | select `gate:LOCAL-032/review#1`; focus `cell:LOCAL-032`, zoom 0.85 |
| `09-integration` | 42:47 | select `cell:LOCAL-031`; focus `station:merge`, zoom 1.15, nudged |
| `10-dependency-unlocks` | 43:42 | select and focus `dependency:SLICE-024->SLICE-021`, zoom 1.0 |
| `11-human-gate-held` | 47:32 | select and focus `gate:LOCAL-032/human-approval`, zoom 1.8 |
| `12-human-gate-released` | 52:05 | as above |
| `13-end-of-run` | 55:50 | fit |

Each beat is shot as `-atlas-dark` and `-atlas-light`. Hero shots (`-atlas-dark@2x`, `-atlas-light@2x`) are taken for 01, 03, 07, 08, 12 and 13. Theater Mode shots (`-theater-dark@2x`, `-theater-light@2x`) are taken for 03, 07, 08, 10 and 12.

| Extra | What it shows |
|---|---|
| `21-help-sheet-*` | The keyboard and legend sheet, opened with `?`. |
| `22-reduced-motion-a-off-atlas-*`, `22-reduced-motion-b-on-atlas-*` | 27:26, the return-to-build loop with and without `prefers-reduced-motion`. |
| `23-narrow-1100-{a,b,c,d}-*-atlas-*` | 1100 x 800, where the inspector is a drawer: the opening, three bays, the verification failure, the human gate. |

## Folders

| Folder | Written by | Contents |
|---|---|---|
| `_sheets/` | `capture.mjs --sheets` | Contact sheets, four shots each, in file-name order. |
| `_layout/` | `capture.mjs` (full run only) | `report.json`: per shot, Atlas callouts outside the visible stage, overlapping text boxes (a loose heuristic) and how much of the selection is in view. |

# M6.0 Living Factory: screenshots

Everything in this folder except this README is generated and git-ignored. **Every image shows a simulation**: the "Simulation" stamp is on screen in each one (the capture script refuses to save a shot without it).

> **The current set is not of the final build.** The 94 screenshots were re-taken after the change to an all-sans typeface (`19b6e20`), but before the second fix round's Blueprint, Atlas and shell fixes (`3d6c463` to `575790e`) and before the light layer was removed (`f9fe87e`). So they do not show: the Blueprint station lines no longer overprinting, callouts placed against the visible area, the stacked corner controls and single-control minimap, drawer-aware framing below 1280 px, "N approve · M needed" consensus, the Atlas's single label-placement pass, the corrected inspector times and tallies, or the review plaque's real seat count; and the `21-help-sheet-*` shots still show the light-layer switch, which no longer exists. The reports in `_a11y/`, `_perf/` and `_honesty/` are older than the screenshots (they pre-date the typeface change too). Nothing was re-captured after these changes: the product owner chose to review the app by hand.

## Regenerate

From `web/apps/control-tower`:

```sh
pnpm --filter @mach/control-tower capture      # or: node scripts/capture.mjs
node scripts/capture.mjs --only 07             # only the shots whose name starts with 07
node scripts/capture.mjs --rebuild --sheets    # force the build; also write _sheets/ (4 shots per contact sheet)
node scripts/honesty.mjs                       # _honesty/: network, CSP, source scan, determinism, motion, stamp
node scripts/audit.mjs                         # _a11y/: axe, keyboard, reduced motion, contrast, ARIA, 200% zoom
node scripts/measure.mjs                       # _perf/: frame times, long tasks, memory, load, bundle sizes
```

Each script builds the app with `vite build --mode capture` into `dist/capture` when the build is older than the sources (`--rebuild` forces it), serves it with `vite preview` on `127.0.0.1:4186` (the honesty script uses its own static server on `127.0.0.1:4187` with the M5 Content-Security-Policy), and stops the server when done. The capture build is the production build plus `window.__machSim` (see `src/sim/README.md`, section 6). Playwright's Chromium, no other dependency; `ffmpeg` (default `/opt/homebrew/bin/ffmpeg`, or `FFMPEG=...`) only for the contact sheets and greyscale images.

Both views stay mounted in the app (the inactive one hidden and `inert`); the scripts scope every selector, box and count to the active layer (`[data-stage-active]`).

Shots are taken on the simulation's manual clock (nothing moves unless the script moves it), each in a fresh page, after the camera has stopped moving. Framing follows the Atlas owner's beats (factory second, focus target, zoom). A shot that **focuses** a target dims nothing and leaves the inspector on "the run at the playhead"; a shot that **selects** opens the inspector on the entity and dims what is unrelated (spec f.4). The wide hero shots (`@2x`, device scale factor 2) focus; the per-state shots select.

## Files

Names sort in story order: `NN-beat-view-theme[@2x].png`, 1920 x 1080 CSS px (3840 x 2160 for `@2x`). Times are factory time (mm:ss from 14:00 UTC).

| Beat | Time | Atlas framing | What it shows |
|---|---|---|---|
| `01-opening` | 00:00 | fit, live, following | The composed empty plant before the wave; the Blueprint's empty sheet ("Awaiting a wave"). |
| `02-wave-arrives` | 00:34 | focus `wave:WAVE-007`, zoom 1.3 | The wave on the intake dock, five slices cut, three cells dispatched (LOCAL-031 to 033), SLICE-024 and 025 waiting. Blueprint: wave selected. |
| `03-three-bays` | 10:40 | focus `cell:LOCAL-032`, zoom 1.1 | Three bays building at once, builders at work, task boards, tool tickers. |
| `04-agent-inspected` | 10:40 | select `agent:ag-031-08` | The LOCAL-031 builder in the inspector with its tool calls; Blueprint: the agent's lane opened to its tool calls. |
| `05-review-fan-out` | 26:41 | select `gate:LOCAL-033/review#1` | LOCAL-033's three review seats fanned out, two approvals and the product seat's reject vote in. |
| `06-outvoted-blocker` | 26:52 | select `finding:LOCAL-033/r1/product/1` | Approved 2 of 3; the product seat's FR-02 blocker outvoted, reported and not hidden. |
| `07-verify-fail-return` | 27:40 | select the verdict gate; focus `cell:LOCAL-031`, zoom 2.0 | LOCAL-031's verification refused on R4 and the return-to-build loop drawn (round 2 of 3). |
| `08-rejection-crosses` | 32:20 | select `gate:LOCAL-032/review#1`; zoom 0.85 on bay and chamber | The security blocker's rejection travelling from the review chamber back across the plant to LOCAL-032. |
| `09-integration` | 42:47 | select `cell:LOCAL-031`; `station:merge`, zoom 1.15, nudged so the yard, approval and review regions fill the frame | LOCAL-031 revalidated and merged; the merge commit on the trunk. |
| `10-dependency-unlocks` | 43:42 | select `dependency:SLICE-024->SLICE-021`, zoom 1.0 | Dependency highlighting on: the cable to SLICE-024 satisfied, SLICE-024 eligible and dispatched as LOCAL-034. |
| `11-human-gate-held` | 47:32 | select `gate:LOCAL-032/human-approval`, zoom 1.8 | LOCAL-032 held at the human-approval gate (High risk). |
| `12-human-gate-released` | 52:05 | as above | Daniel Okafor's approval released the gate; LOCAL-032 on its way to merge. |
| `13-end-of-run` | 55:50 | fit | The whole plant at the end: three merged, LOCAL-034 still building, SLICE-025 waiting. |

Variants of each beat: `-atlas-dark`, `-atlas-light`, `-blueprint-dark`, `-blueprint-light` (1x); hero shots `-atlas-dark@2x`, `-atlas-light@2x` for 01, 03, 07, 08, 12 and 13; Theater Mode `-theater-dark@2x`, `-theater-light@2x` for 03, 07, 08, 10 and 12.

| Extra | What it shows |
|---|---|
| `20-mode-switch-a-atlas-*`, `20-mode-switch-b-blueprint-*` | The same selection (`cell:LOCAL-032` at 32:20) before and after the real key "2". |
| `21-help-sheet-*` | The keyboard, legend and display sheet, opened with "?" (still with the removed light-layer switch; see the note above). |
| `22-reduced-motion-a-off-atlas-*`, `22-reduced-motion-b-on-atlas-*`, `22-reduced-motion-c-on-blueprint-*` | 27:26, mid-way through the return-to-build loop: with motion (the loop drawing) and with `prefers-reduced-motion` (end state at the event time; "Motion reduced" in the transport). |
| `23-narrow-1100-{a,b,c,d}-*-atlas-*` | 1100 x 800: the opening, three bays, the verification failure with the inspector as a drawer (the selection framed in the part of the stage the drawer leaves; the app itself centres it in the whole stage, under the drawer), the human gate. Each shot clears the previous one's selection. |

## Folders

| Folder | Written by | Contents |
|---|---|---|
| `_sheets/` | `capture.mjs --sheets` | Contact sheets, four shots each, in file-name order (the script logs which four). |
| `_honesty/` | `honesty.mjs` | `report.json` (the current one still has the light-layer entries the script no longer writes); `det-*.png`, the stage renders compared for determinism; `det-dom-*.html`, the canonical markup of the first pass of each route. |
| `_a11y/` | `audit.mjs` | `report.json` (axe, keyboard, the Atlas arrow graph, focus return after help, the hidden view, reduced motion, contrast, live regions, 200%); `aria-*.txt`; `focus-*.png`; `zoom200-<size>-<state>.png`; `grey-*.png` (regenerated from this capture set). |
| `_perf/` | `measure.mjs` | `report.json` (playback, scrub, 36 mode switches per browser with every frame interval, element counts over the whole run, memory, load, bundle). |
| `_layout/` | `capture.mjs` (full run only) | `report.json`: per shot, Atlas callouts outside the visible stage, overlapping text boxes (a loose heuristic) and how much of the selection is in view. |

The findings drawn from these are in `docs/mach-next/M6_0_FINDINGS.md`.

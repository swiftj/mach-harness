# M6.5 Factory Analytics: the product owner's acceptance captures

Made on 2026-11-14 between 10:24 and 10:58 UTC by agent `capture65`. Nothing in the product was changed to make
them. Files are git-ignored: screenshots in `web/apps/control-tower/screenshots/analytics/final/`, recordings in
`web/apps/control-tower/recordings/analytics/final/`.

## What they were made from

- **Web app**: served live by Vite from the working tree. When capture started that tree was `de1ec9b` plus 42
  uncommitted changes; the lead committed them during the run as `6a5caee` and `e76a0d6` (10:30 UTC). No file under
  `web/apps/control-tower/src` or `web/packages` changed after 10:22 UTC, so the app in every frame is the one
  committed in **`e76a0d6`**.
- **Observer**: `mach-observer` built with plain `go build` at 10:23 UTC from the working tree at `de1ec9b` plus its
  uncommitted changes (never `build.sh`). After that, `cmd/mach-observer/{main.go,memlimit.go,memlimit_test.go}`
  (the adaptive memory limit in `6a5caee`) and `internal/testkit/synth/realistic.go` changed. The memory-limit
  change does not touch any analytics figure. The projects were generated before the `realistic.go` change, so
  a project generated from `e76a0d6` may differ slightly from the one in these frames.
- **Projects**: synthetic only. They were generated into my scratch folder with the commands in
  `M6_5_TESTING.md` (`mach-synth --analytics --profile realistic`): empty (`.factory/config.json` = `{}`), one
  (`--cells 1 --waves 1 --seed 3`), tiny (`--cells 2 --waves 1 --seed 1`), medium (`--cells 60 --waves 8
  --seed 1`: 57 finished tickets, 129 executions, 11,679 events, 2–6 Nov 2026), and large (`--cells 330
  --waves 40 --events 240000 --seed 1`: 327 finished, 712 executions, 5 Oct – 1 Nov 2026). No real run data
  was used.
- **Plumbing**: `e2e/analytics-lib.mjs` (relay, dev server, `startObserver`) with `E2E_AN_SCRATCH` set to my
  scratch folder, the dev server on 4460, the relay on 4479 and observers on 4461–4465. Headless Chromium
  (Playwright). Screenshots are 1512×982 at device scale 2, dark unless named `-light`. A name ending `-full` is
  the whole sheet: the viewport is kept 1512 wide and made as tall as the sheet. The scripts (`caplib.mjs`,
  `cap1`–`cap4.mjs`, `rec.mjs`, `cmp.mjs`, `contact.py`) are in the scratch folder
  `…/scratchpad/m65/agents/capture65/`, not in the repository. Every process was stopped at the end (relay, Vite,
  5 observers; nothing is left listening on 4460–4479).
- **Source label check**: before each screenshot, the script read the Shell's source badge and
  `data-analytics-source`. A frame whose label did not match its source was refused. All 104 frames passed:
  99 Live Factory (`syn-…`), 3 Historical replay (`syn-medium-15-replay-…`) and 2 Simulated (`sim-…`).
  Recordings: each film's last frame was checked the same way, and the extracted frames were checked by eye.
  The badge reads "Live Factory" in every frame.

## Recordings

Real time (Playwright's video, re-encoded to H.264 High, yuv420p, 25 fps, 1512×982, `-crf 18`). The pointer and the
key captions in R4 are drawn by the capture script (`aria-hidden` overlays) and are not part of the product.

| File | Length | Source | What it shows |
|---|---|---|---|
| `R1-investigation-medium.mp4` | 1:21 | Live Factory, medium | Pulse; What stands out; Flow; the slowest station (Build) selected; its rows ("All 78 visits"); the slowest visit opened in the Timeline; Back to Analytics; Quality; the failure kind "matrix rule" picked; the First-pass Rows drawer |
| `R2-compare-large.mp4` | 1:18 | Live Factory, large | Compare by execution configuration (c8472489 121 finished against e967e133 94); the second cohort switched to "Configuration not recorded" (50); the distributions; by time period (before and from 18 Oct); back to risk (Medium 214 against Low 71, unequal samples) |
| `R3-responsiveness-large.mp4` | 1:38 | Live Factory, large | Window presets 7, 14 and 28 days and Whole history; a brush across the delivery columns; Risk = high and App type = web (down to one ticket); every area in turn; Undo the brushed window; filters back to All; Pulse scrolled |
| `R4-keyboard-only-medium.mp4` | 1:15 | Live Factory, medium | From the floor: `4`; Tab to a chart (the belt) and arrows across its marks; Shift+Tab to its Table toggle and Enter (table, then back); Tab to the areas and Enter on Flow; Tab to Rows and Enter (drawer); Escape; `3` Timeline, `1` floor, `4` back to Analytics |

## Contact sheets

Each tile is the first viewport of one capture, labelled with its filename.
`contact-1-areas.png` (38 tiles: items 1–9), `contact-2-navigation-lowdata-missing-extras.png` (26: items 10–12,
replay, Simulation, popover, drawer), `contact-3-light-narrow-performance.png` (18: light theme, 1280×800 and
1100×700, the large-history steps).

## Screenshots

The owner's item number is in each filename (`-01-` to `-15-`; 15 = the extras).

| File | Shows | Source | Address |
|---|---|---|---|
| `sim-15-flow-simulated.png` | Simulation: Flow, labelled Simulated | Simulated | `#analytics?area=flow` |
| `sim-15-pulse-simulated.png` | The built-in Simulation's Analytics, labelled Simulated | Simulated | `#analytics?area=pulse` |
| `syn-empty-11-flow.png` | Low data: flow on the empty project | Live Factory | `#analytics?area=flow` |
| `syn-empty-11-opportunities.png` | Low data: opportunities on the empty project | Live Factory | `#analytics?area=opportunities` |
| `syn-empty-11-pulse.png` | Low data: Factory Pulse on the empty project | Live Factory | `#analytics` |
| `syn-large-01-pulse-dark.png` | Factory Pulse overview, large, whole history, dark | Live Factory | `#analytics` |
| `syn-large-01-pulse-dark-full.png` | Factory Pulse, whole sheet, large, dark (whole sheet: viewport 1512 wide made 1728 tall) | Live Factory | `#analytics` |
| `syn-large-01-pulse-light.png` | Factory Pulse overview, large, whole history, light | Live Factory | `#analytics` |
| `syn-large-01-pulse-light-full.png` | Factory Pulse, whole sheet, large, light (whole sheet: viewport 1512 wide made 1728 tall) | Live Factory | `#analytics` |
| `syn-large-04-parallel.png` | Work in parallel against the recorded limit, large (four weeks, weekends visible) | Live Factory | `#analytics?area=flow` |
| `syn-large-04-waits.png` | Waits by kind and work in parallel against the recorded limit, large | Live Factory | `#analytics?area=flow` |
| `syn-large-08-compare-app.png` | Compare by app type, large | Live Factory | `#analytics?area=compare&cmp=by:app_type~by:app_type` |
| `syn-large-08-compare-config.png` | Compare by execution configuration, large | Live Factory | `#analytics?area=compare&cmp=by:config~by:config` |
| `syn-large-08-compare-config-full.png` | Compare by execution configuration, whole sheet, large (whole sheet: viewport 1512 wide made 1176 tall) | Live Factory | `#analytics?area=compare&cmp=by:config~by:config` |
| `syn-large-08-compare-config-notrecorded.png` | Compare by execution configuration, one side the not-recorded cohort, large | Live Factory | `#analytics?area=compare&cmp=by:config,key:c84724899fcab3cc43b9e2fd9ef4c202a528e9e006ff297e28846415d1dc7937~by:config,key:not-recorded` |
| `syn-large-08-compare-config-notrecorded-full.png` | Compare, not-recorded cohort, whole sheet, large (whole sheet: viewport 1512 wide made 1200 tall) | Live Factory | `#analytics?area=compare&cmp=by:config,key:c84724899fcab3cc43b9e2fd9ef4c202a528e9e006ff297e28846415d1dc7937~by:config,key:not-recorded` |
| `syn-large-08-compare-period.png` | Compare by time period, large | Live Factory | `#analytics?area=compare&cmp=by:period~by:period` |
| `syn-large-08-compare-period-full.png` | Compare by period, whole sheet, large (whole sheet: viewport 1512 wide made 1092 tall) | Live Factory | `#analytics?area=compare&cmp=by:period~by:period` |
| `syn-large-08-compare-risk.png` | Compare by risk tier (default cohorts), large | Live Factory | `#analytics?area=compare` |
| `syn-large-13-perf-0-pulse.png` | Large history: Pulse at first paint (240,000 events) | Live Factory | `#analytics` |
| `syn-large-13-perf-1-flow.png` | Large: after the area switch to Flow | Live Factory | `#analytics?area=flow` |
| `syn-large-13-perf-2-7days.png` | Large: Pulse after the 7 days window | Live Factory | `#analytics?win=7d` |
| `syn-large-13-perf-3-brushed.png` | Large: Pulse after a brush across the delivery columns (the chosen-window indicator) | Live Factory | `#analytics?win=1791849600000-1792540800000` |
| `syn-large-13-perf-4-brushed-high.png` | Large: brushed window and Risk = high | Live Factory | `#analytics?win=1791849600000-1792540800000&risk=high` |
| `syn-medium-01-pulse-dark.png` | Factory Pulse overview, medium, whole history, dark | Live Factory | `#analytics` |
| `syn-medium-01-pulse-dark-full.png` | Factory Pulse, whole sheet, medium, dark (whole sheet: viewport 1512 wide made 1684 tall) | Live Factory | `#analytics` |
| `syn-medium-01-pulse-light.png` | Factory Pulse overview, medium, whole history, light | Live Factory | `#analytics` |
| `syn-medium-01-pulse-light-full.png` | Factory Pulse, whole sheet, medium, light (whole sheet: viewport 1512 wide made 1684 tall) | Live Factory | `#analytics` |
| `syn-medium-02-flow.png` | Flow, medium, no station selected (the diagram, Build shown by default) | Live Factory | `#analytics?area=flow` |
| `syn-medium-02-flow-full.png` | Flow, whole sheet, Verify selected (whole sheet: viewport 1512 wide made 2275 tall) | Live Factory | `#analytics?area=flow&station=verify` |
| `syn-medium-02-flow-ranking-by-median.png` | Flow ranking sorted by Median | Live Factory | `#analytics?area=flow&station=verify` |
| `syn-medium-02-flow-ranking-by-visits.png` | Flow ranking sorted by Visits | Live Factory | `#analytics?area=flow&station=verify` |
| `syn-medium-02-flow-ranking-total.png` | Flow ranking by total measured time (default sort) | Live Factory | `#analytics?area=flow&station=verify` |
| `syn-medium-02-flow-verify-selected.png` | Flow, medium, Verify selected on the diagram | Live Factory | `#analytics?area=flow&station=verify` |
| `syn-medium-03-durations-build.png` | Visit durations and slowest visits for Build | Live Factory | `#analytics?area=flow&station=build` |
| `syn-medium-03-durations-review.png` | Visit durations and slowest visits for Review | Live Factory | `#analytics?area=flow&station=review` |
| `syn-medium-03-durations-review-hover.png` | Review visit durations, hover card on a histogram bucket with exact values | Live Factory | `#analytics?area=flow&station=review` |
| `syn-medium-03-durations-review-table.png` | Review visit durations as a table (the chart's Table view) | Live Factory | `#analytics?area=flow&station=review` |
| `syn-medium-04-parallel.png` | Work in parallel against the recorded limit, medium | Live Factory | `#analytics?area=flow` |
| `syn-medium-04-waits.png` | Waits by kind and work in parallel against the recorded limit, medium | Live Factory | `#analytics?area=flow` |
| `syn-medium-05-quality-dark.png` | Quality and remediation, medium, dark | Live Factory | `#analytics?area=quality` |
| `syn-medium-05-quality-failure-kind.png` | Quality: failure kind 'matrix rule' picked, its tickets listed | Live Factory | `#analytics?area=quality&pick=target_kind:matrix%20rule` |
| `syn-medium-05-quality-full.png` | Quality, whole sheet, failure kind picked (whole sheet: viewport 1512 wide made 1894 tall) | Live Factory | `#analytics?area=quality&pick=target_kind:matrix%20rule` |
| `syn-medium-05-quality-light.png` | Quality and remediation, medium, light | Live Factory | `#analytics?area=quality` |
| `syn-medium-05-quality-light-full.png` | Quality, whole sheet, light (whole sheet: viewport 1512 wide made 1958 tall) | Live Factory | `#analytics?area=quality` |
| `syn-medium-05-quality-scorecard.png` | Quality: observe scorecard with targets | Live Factory | `#analytics?area=quality&pick=target_kind:matrix%20rule` |
| `syn-medium-06-economics-cost-vs-delivery.png` | Economics: cost beside verified delivery (model opus) | Live Factory | `#analytics?area=economics&model=opus` |
| `syn-medium-06-economics-dark.png` | Agent and model economics, medium, all models, dark | Live Factory | `#analytics?area=economics` |
| `syn-medium-06-economics-full.png` | Economics, whole sheet, all models (whole sheet: viewport 1512 wide made 1690 tall) | Live Factory | `#analytics?area=economics` |
| `syn-medium-06-economics-light.png` | Agent and model economics, medium, all models, light | Live Factory | `#analytics?area=economics` |
| `syn-medium-06-economics-light-full.png` | Economics, whole sheet, light (whole sheet: viewport 1512 wide made 1690 tall) | Live Factory | `#analytics?area=economics` |
| `syn-medium-06-economics-opus.png` | Economics with model opus selected | Live Factory | `#analytics?area=economics&model=opus` |
| `syn-medium-06-economics-opus-full.png` | Economics, whole sheet, model opus (whole sheet: viewport 1512 wide made 1470 tall) | Live Factory | `#analytics?area=economics&model=opus` |
| `syn-medium-07-reliability.png` | Reliability and autonomy, medium | Live Factory | `#analytics?area=reliability` |
| `syn-medium-07-reliability-ending-parked.png` | Reliability: the ending 'Parked for a person' picked | Live Factory | `#analytics?area=reliability&pick=outcome:parked` |
| `syn-medium-07-reliability-full.png` | Reliability, whole sheet, ending picked (whole sheet: viewport 1512 wide made 1174 tall) | Live Factory | `#analytics?area=reliability&pick=outcome:parked` |
| `syn-medium-07-reliability-person.png` | Reliability: where a person stepped in | Live Factory | `#analytics?area=reliability&pick=outcome:parked` |
| `syn-medium-08-compare-app.png` | Compare by app type, medium | Live Factory | `#analytics?area=compare&cmp=by:app_type~by:app_type` |
| `syn-medium-08-compare-config.png` | Compare by execution configuration, medium | Live Factory | `#analytics?area=compare&cmp=by:config~by:config` |
| `syn-medium-08-compare-config-full.png` | Compare by execution configuration, whole sheet, medium (whole sheet: viewport 1512 wide made 1176 tall) | Live Factory | `#analytics?area=compare&cmp=by:config~by:config` |
| `syn-medium-08-compare-config-notrecorded.png` | Compare by execution configuration, one side the not-recorded cohort, medium | Live Factory | `#analytics?area=compare&cmp=by:config,key:c84724899fcab3cc43b9e2fd9ef4c202a528e9e006ff297e28846415d1dc7937~by:config,key:not-recorded` |
| `syn-medium-08-compare-config-notrecorded-full.png` | Compare, not-recorded cohort, whole sheet, medium (whole sheet: viewport 1512 wide made 1176 tall) | Live Factory | `#analytics?area=compare&cmp=by:config,key:c84724899fcab3cc43b9e2fd9ef4c202a528e9e006ff297e28846415d1dc7937~by:config,key:not-recorded` |
| `syn-medium-08-compare-period.png` | Compare by time period, medium | Live Factory | `#analytics?area=compare&cmp=by:period~by:period` |
| `syn-medium-08-compare-period-full.png` | Compare by period, whole sheet, medium (whole sheet: viewport 1512 wide made 1092 tall) | Live Factory | `#analytics?area=compare&cmp=by:period~by:period` |
| `syn-medium-08-compare-risk.png` | Compare by risk tier (default cohorts), medium | Live Factory | `#analytics?area=compare` |
| `syn-medium-09-opportunities.png` | Improvement opportunities: the list | Live Factory | `#analytics?area=opportunities` |
| `syn-medium-09-opportunities-full.png` | Improvement opportunities, whole list with the not-evaluated rules (whole sheet: viewport 1512 wide made 1750 tall) | Live Factory | `#analytics?area=opportunities` |
| `syn-medium-09-opportunities-not-evaluated.png` | Improvement opportunities: rules not evaluated, with reasons | Live Factory | `#analytics?area=opportunities` |
| `syn-medium-09-opportunity-figures.png` | An opportunity's 'Open the figures': where it leads | Live Factory | `#analytics?area=quality` |
| `syn-medium-09-opportunity-rows.png` | An opportunity opened: its rows and its stated population (Rows drawer) | Live Factory | `#analytics?area=opportunities&focus=Q2,first_pass:false,insight:scorecard.first-pass` |
| `syn-medium-10-nav-1-slowest-visits.png` | Navigation 1: Flow, Build station, the slowest visits (the first row will be opened) | Live Factory | `#analytics?area=flow` |
| `syn-medium-10-nav-2-timeline.png` | Navigation 2: the Execution Timeline with visit:SYN-042/build#1 selected and its interval in the window | Live Factory | `#timeline?sel=visit%3ASYN-042%2Fbuild%231&win=1793865841541-1793876057856` |
| `syn-medium-10-nav-3-back.png` | Navigation 3: Back returns to Analytics, Flow restored | Live Factory | `#analytics?area=flow&sel=visit%3ASYN-042%2Fbuild%231` |
| `syn-medium-10-nav-4-floor-station.png` | Navigation 4: the floor with the Verify station selected; the inspector offers 'Open its measured history' | Live Factory | `#atlas?sel=station%3Averify` |
| `syn-medium-10-nav-5-flow-from-floor.png` | Navigation 5: 'Open its measured history' lands on Flow with that station selected | Live Factory | `#analytics?area=flow&station=verify&sel=station%3Averify` |
| `syn-medium-12-accepted-not-recorded.png` | Missing telemetry: 'Accepted by product: Not recorded' | Live Factory | `#analytics` |
| `syn-medium-12-coverage.png` | Missing telemetry: data coverage and freshness (cell lifecycle 59 of 61, execution records not read) | Live Factory | `#analytics` |
| `syn-medium-12-unavailable-reason.png` | A metric unavailable with its reason (model filter cannot be honoured) | Live Factory | `#analytics?area=economics&model=opus` |
| `syn-medium-12-usage-missing.png` | Missing telemetry: executions without a recorded cost or usage (the incompleteness notice) | Live Factory | `#analytics?area=economics` |
| `syn-medium-12-usage-missing-rows.png` | Missing telemetry: 'List them' opens the executions without a recorded cost | Live Factory | `#analytics?area=economics&focus=K1` |
| `syn-medium-14-1100x700-compare.png` | Narrow viewport 1100x700: compare | Live Factory | `#analytics?area=compare` |
| `syn-medium-14-1100x700-flow.png` | Narrow viewport 1100x700: flow | Live Factory | `#analytics?area=flow` |
| `syn-medium-14-1100x700-pulse.png` | Narrow viewport 1100x700: pulse | Live Factory | `#analytics` |
| `syn-medium-14-1100x700-quality.png` | Narrow viewport 1100x700: quality | Live Factory | `#analytics?area=quality` |
| `syn-medium-14-1280x800-compare.png` | Narrow viewport 1280x800: compare | Live Factory | `#analytics?area=compare` |
| `syn-medium-14-1280x800-flow.png` | Narrow viewport 1280x800: flow | Live Factory | `#analytics?area=flow` |
| `syn-medium-14-1280x800-pulse.png` | Narrow viewport 1280x800: pulse | Live Factory | `#analytics` |
| `syn-medium-14-1280x800-quality.png` | Narrow viewport 1280x800: quality | Live Factory | `#analytics?area=quality` |
| `syn-medium-15-definition-popover.png` | A definition popover open (Tickets merged, T1) | Live Factory | `#analytics` |
| `syn-medium-15-flow-light.png` | Flow, light theme | Live Factory | `#analytics?area=flow` |
| `syn-medium-15-flow-light-full.png` | Flow, whole sheet, light theme (whole sheet: viewport 1512 wide made 2297 tall) | Live Factory | `#analytics?area=flow` |
| `syn-medium-15-replay-midplayhead.png` | Historical replay of medium with the playhead held mid-history: the as-of caption | Historical replay | `#analytics?at=1793784543737` |
| `syn-medium-15-replay-midplayhead-flow.png` | Historical replay mid-history: Flow | Historical replay | `#analytics?area=flow&at=1793784543737` |
| `syn-medium-15-replay-midplayhead-full.png` | Historical replay mid-history, whole Pulse sheet (whole sheet: viewport 1512 wide made 1708 tall) | Historical replay | `#analytics?at=1793784543737` |
| `syn-medium-15-rows-drawer.png` | The Rows drawer: dispatch-to-merge rows (C3) | Live Factory | `#analytics?area=flow&focus=C3` |
| `syn-one-11-economics.png` | Low data: economics on the one project | Live Factory | `#analytics?area=economics` |
| `syn-one-11-flow.png` | Low data: flow on the one project | Live Factory | `#analytics?area=flow` |
| `syn-one-11-pulse.png` | Low data: Factory Pulse on the one project | Live Factory | `#analytics` |
| `syn-one-11-pulse-full.png` | Low data: Pulse whole sheet, one (whole sheet: viewport 1512 wide made 1378 tall) | Live Factory | `#analytics` |
| `syn-tiny-11-compare.png` | Low data: compare on the tiny project | Live Factory | `#analytics?area=compare` |
| `syn-tiny-11-flow.png` | Low data: flow on the tiny project | Live Factory | `#analytics?area=flow` |
| `syn-tiny-11-pulse.png` | Low data: Factory Pulse on the tiny project | Live Factory | `#analytics` |
| `syn-tiny-11-pulse-full.png` | Low data: Pulse whole sheet, tiny (whole sheet: viewport 1512 wide made 1340 tall) | Live Factory | `#analytics` |
| `syn-tiny-11-quality.png` | Low data: quality on the tiny project | Live Factory | `#analytics?area=quality` |

Item map: 1 `syn-{medium,large}-01-pulse-{dark,light}[-full]`; 2 `syn-medium-02-*`; 3 `syn-medium-03-*`; 4
`syn-{medium,large}-04-*`; 5 `syn-medium-05-*`; 6 `syn-medium-06-*`; 7 `syn-medium-07-*`; 8
`syn-{medium,large}-08-*`; 9 `syn-medium-09-*`; 10 `syn-medium-10-nav-1..5`; 11 `syn-{empty,one,tiny}-11-*`; 12
`syn-medium-12-*`; 13 `syn-large-13-perf-*`; 14 `syn-medium-14-{1280x800,1100x700}-*`; extras
`syn-medium-15-*`, `sim-15-*`. Light theme: Pulse (medium and large), Flow, Quality and Economics.

Gaps in the set:
- Item 10's floor step was opened with the address `#atlas?sel=station:verify`, not by clicking the station on
  the Atlas. Its "Open its measured history" link was clicked.
- Item 12 "cells without a lifecycle log" is shown as the project has it (Pulse "Least complete: cell
  lifecycle, 59 of 61" and the freshness table). No project had a large share of cells without a log, so the
  `data.lifecycle-coverage` rule never fires in these frames.
- `syn-medium-06-economics-cost-vs-delivery` shows the model filter's "not available" state. Medium (5 days, 1 week)
  is too short for the weekly cost-against-delivery chart, which then reads "Too few records". The chart drawn
  with data is only in R3's frames, on large.

## Large-history performance (item 13)

Large project, 240,000 events. Headless Chromium on the shared machine (load average 3–4). Each value is read from
the page's own Performance API: `performance.now()` at the action, the last DOM mutation before 300 ms of quiet
with nothing `data-analytics-pending`, and `performance.getEntriesByType("resource")` for the analytics requests.

| Step | Settled after | Analytics requests | Slowest request | UI budget (M6_5_TESTING) |
|---|---|---|---|---|
| First load (navigation `domContentLoaded`) | 277 ms | | | |
| Area switch Pulse → Flow | 93 ms | 14 | 9 ms | 300 ms, pass |
| Area switch Flow → Quality | 200 ms | 3 | 3 ms | pass |
| Area switch Quality → Pulse (cached) | 107 ms | 0 | | pass |
| Window Whole history → 7 days | 125 ms | 7 | 26 ms | 300 ms, pass |
| Window 7 → 28 days | 175 ms | 7 | 28 ms | pass |
| Window → Whole history (cached) | 167 ms | 0 | | pass |
| Brush across the delivery columns | **264 ms** | 7 | 16 ms | 200 ms, **over** |
| Filter Risk = high | 91 ms | 7 | 9 ms | 300 ms, pass |
| Area switch → Compare | 85 ms | 2 | 3 ms | 500 ms, pass |
| JS heap at the end (`performance.memory`, not after GC) | 167 MB | | | not comparable with the 60 MB delta budget |

The brush ran over its budget once, on a loaded machine. This was one run, not a median. Captures:
`syn-large-13-perf-0..4`; R3 shows the same steps in real time.

## Figures on screen against the API (same cursor)

`cmp.mjs` read every `[data-readout]` (its `data-value`) and the view's `data-analytics-cursor`, then asked
`/api/v1/analytics/metrics?ids=…&at=<cursor>&distribution=1` through the same session (GET, 127.0.0.1).

**Matches (all of them).** On medium, 38 readouts in Pulse, Flow, Quality, Economics and Reliability (cursor
`81aaf6170a459bc8.12744`); on large, the 11 Pulse readouts (cursor `d45be38eac1520d4.246270`). Each matched the
API's value, numerator or percentile. Thirteen of them, with the comparison stated:

| # | Screen (capture) | API at the cursor | Result |
|---|---|---|---|
| 1 | Tickets merged 53 (`syn-medium-01-pulse-dark`) | T1 value 53 | equal |
| 2 | Slices integrated 54 | T2 54 | equal |
| 3 | First pass 78%, n 54 (`syn-medium-05-quality-dark`) | Q2 42/54 = 0.7778 | equal |
| 4 | Judging rounds 1.26, n 54 | Q3 68/54 = 1.2593 | equal |
| 5 | Recorded total $250.88, 120 of 129 (`syn-medium-06-economics-dark`) | K1 numerator 250.8768, 120 counted of 129 | equal |
| 6 | Per ticket $4.18, n 60 | K4 250.8768/60 = 4.1813 | equal |
| 7 | Station visits per ticket 8.19, n 59 (`syn-medium-02-flow`) | C2 483/59 = 8.1864 | equal |
| 8 | Gate refusals 2.5%, n 603 | X2 15/603 = 0.0249 | equal |
| 9 | Review rounds rejected 17%, n 65 | R1 11/65 = 0.1692 | equal |
| 10 | Moved the ticket 99%, n 128 (`syn-medium-07-reliability`) | S3 127/128 | equal |
| 11 | Approval wait median 43 min, n 4 | W3 p50 2,580,318 ms | equal |
| 12 | Large: recorded total $1,405.99, 671 of 712 (`syn-large-01-pulse-dark`) | K1 1405.9917/671 | equal |
| 13 | Large: dispatch to merge median 2 h 52 min, n 312 | C3 p50 10,321,273 ms | equal |

**Where the screen faithfully shows an API value that is misleading, or two figures in one view disagree:**

| # | What is shown | The API | Finding |
|---|---|---|---|
| A | Flow and Pulse: dispatch to merge (C3) **and** eligible to integrated (C4) both "median 2 h 17 min, 90th 4 h 33 min" (`syn-medium-02-flow`) | C3 and C4 `p50` = 8,192,000 ms = 2^13 s exactly, `p90` = 16,384,000 = 2^14 s; the means differ (12,168,812 against 12,195,926) | The medians are the upper edges of power-of-two histogram buckets, shown to the minute as if exact. Two different metrics come out identical. Agents' medians "8 min 32 s" (= 2^9 s) in Economics, twice, are the same artefact |
| B | Large Pulse: "Approval wait median 1 h 26 min, n 42" beside What stands out "Human approval waits … median of measured waits 1 h 10 min, n 42" (`syn-large-01-pulse-dark-full`) | W3 p50 5,160,637 ms (bucket edge) against the insight `flow.wait-p90:human-approval` median 4,188,993 ms (exact), same 42 waits | One view, one population, two medians 16 minutes apart |
| C | Flow "Build median 22 min" against the opportunity "median 21.1 min, 90th 58.4 min" (`syn-medium-09-opportunities-full`) | flow (bucketed) against the insight (exact) | as B |
| D | Quality: "Review blockers by rule: No blocker findings in this window" beside "Review rounds rejected 17%" (`syn-medium-05-quality-full`) | R2 `status: partial`, `sample_count` 0, coverage "no member of the population was observed"; but `/analytics/runs` gives 6 finished tickets with `blockers` > 0 (3, 5, 4, 1, …) | Recorded blockers are read as none. The UI turns an unobserved figure into "No blocker findings", which reads as a zero |
| E | Economics notice: "9 executions of 129 carry no recorded cost … **and 0 executions carry no per-model usage**"; cost distribution: "0 executions with no recorded cost are not placed in any bin" (`syn-medium-06-economics-dark`, `syn-medium-12-usage-missing`) | K1 excludes 9 (7 completed with no cost, 2 with no result); K2 coverage 331 of 331 *model-execution pairs*; `/analytics/runs` lists 7 executions of finished tickets with `usage.recorded: false` (the generator wrote 120 `execution.usage` for 129 executions) | The usage-missing count is taken from a population (pairs of model and execution) that cannot contain a missing execution, so it is always 0. The distribution's "0 … not placed" contradicts the 9 above it |
| F | Economics "Tokens per model, per execution 1.15M, n 331 executions that used the model" (`syn-medium-06-economics-dark`) | K3 379,736,075 / 331 | 331 is model-execution pairs; the project has 129 executions. Wrong unit word |
| G | Historical replay at 4 Nov 09:29: prose "79% of merged tickets passed … 24 tickets"; the Quality card "78% … First pass 21, Remediated 6"; "Escalated 4%, n 25 finished tickets"; side panel "Recorded 28 finished tickets" (`syn-medium-15-replay-midplayhead-full`) | metrics are cut at whole UTC days before the playhead (24 merged); the runs list is cut exactly (27 merged, 28 finished) | One view shows two first-pass rates and three ticket counts. The caption explains the two bases, but no figure says which basis it uses |
| H | Large window "5 Oct – 30 Oct, the complete recorded history" while the freshness table shows the intake log and stream up to 1 Nov 10:08 (`syn-large-01-pulse-dark-full`) | summary end 2026-11-01T10:09Z; effective window to 31 Oct 00:00 | "Complete" leaves out the last day and a half of records |

Not settled: the generator's large project names an `outcome_unknown_execution`, but S2 is 0 of 712 at the head and in
the window. This may be correct by S2's definition (an execution whose process recorded how it stopped is not
unknown). Engine should confirm.

## Privacy and requests

- **Visible text**: each screenshot's `document.body.innerText` was saved (104 files) and scanned for home paths
  (`/Users/`, `/private/`), the account name, e-mail addresses, key prefixes (`sk-ant`), `token=`, `?t=`, and each
  observer's one-time link token. **0 hits.** The only matches for "token" are the metric word (tokens by kind).
  People are not named; tickets are `SYN-…`.
- **Requests** (every request of every capture and recording page, 13,257): **0 not GET**. All went to
  127.0.0.1: 13,191 to the dev server (4460), 66 to the observers (the one-time link navigation and its
  redirect). 2,300 were `/api/v1/…`, of which 780 were `/analytics/…`. Longest URL: 226 characters. **Prose in a
  URL: 2 requests**, both `contributors?…&group=target_kind:matrix rule` (a pick value with a space, from Quality's
  failure kind; known gap in `M6_5_TESTING.md`). No console errors were logged.

## Defects still visible, ranked

Each defect names the capture that shows it. Letters refer to the table above.

### Must fix

1. **Bucket-edge percentiles shown as exact durations** (A, B, C). C3 and C4 come out identical; the same 42
   approval waits have two medians in one view; Flow's median differs from the opportunity's. Show the
   bucket bounds ("between 1 h 8 min and 2 h 17 min") or compute exact percentiles. Use one basis everywhere a
   median is printed. `syn-medium-02-flow`, `syn-large-01-pulse-dark-full`, `syn-medium-09-opportunities-full`,
   `syn-medium-06-economics-full` (agents "8 min 32 s" twice).
2. **Review blockers read as none** (D). R2 observes no member although the run records hold blockers, and the
   UI prints "No blocker findings in this window", which a person reads as zero. The backend count is one fault;
   saying "none" for an unobserved figure is a second, a breach of missing-is-not-zero. `syn-medium-05-quality-full`.
3. **"0 executions carry no per-model usage" is false** (E), and "0 executions with no recorded cost are not
   placed" contradicts the 9 stated above it. This is the missing-usage notice the owner asked for, and it
   reports the wrong number. `syn-medium-06-economics-dark`, `syn-medium-12-usage-missing`.
4. **Timeline landing does not show the visit's row** (item 10). The inspector selects `SYN-042 build #1` and
   the window is its interval (08:11–10:46, 5 Nov), but the tracks stay at the top (WAVE-001, SYN-001…), and
   every visible row is empty in that window. Even after 7 s the selected row is not brought into view.
   `syn-medium-10-nav-2-timeline`, R1 at about 0:38.
5. **Replay: figures in one view disagree** (G). There are two first-pass rates (79% and 78%), and 24 merged
   against 27, and 25 finished against 28, side by side, with no figure saying which basis it uses.
   `syn-medium-15-replay-midplayhead-full`.

### Should fix

6. **"Complete recorded history" stops before the records do** (H): on large the window ends 30 Oct, but the
   sources run to 1 Nov 10:08. `syn-large-01-pulse-dark-full`.
7. **Two first-pass figures on Pulse without a bridge**: the prose says 78% (window, n 54) and What stands
   out says 83.3% (last 20 runs, n 18); on large, 72% against 80.0%. Each is labelled, but they sit in one
   glance and the prose is the bigger type. `syn-medium-01-pulse-dark`, `syn-large-01-pulse-dark`.
8. **Unexplained or garbled text**:
   - Economics under a model filter repeats a broken sentence: "Recorded cost per execution is this metric is
     not recorded by model…" (`syn-medium-06-economics-opus-full`).
   - An unstyled line "Not read for this view: per-execution costs are not listed under a model filter (the
     rows route cannot narrow by model)" sits above the Analytics bar, outside the sheet
     (`syn-medium-12-unavailable-reason`).
   - Grammar: "1 weeks", "across 1 periods" (`syn-medium-06-economics-dark`, `syn-medium-05-quality-full`).
9. **Unit word wrong**: "n 331 executions that used the model" means model-execution pairs (F).
   `syn-medium-06-economics-dark`.
10. **Empty values without a reason**: "Tools refused –" in Reliability, and coverage "–" beside an empty bar
    track in the freshness table, which looks like 0%. `syn-medium-07-reliability-full`,
    `syn-medium-12-coverage`.
11. **Internal identifiers as link text**: the parked-for-a-person list reads
    `SYN-004/required:i:beca3d62:95`, and its rows are cut ("High r…", "09:59 U…").
    `syn-medium-07-reliability-ending-parked`.
12. **Developer words in the UI**: Not evaluated lists raw rule ids (`flow.wait-p90:dependency`) and says "ask a
    bounded window (from_ms and to_ms)". `syn-medium-09-opportunities-not-evaluated`.
13. **Filter not named in the headline**: with Risk = high and a brushed window, Pulse's sentence reads "the
    Factory merged 17 tickets". It does not say these are only high-risk tickets.
    `syn-large-13-perf-4-brushed-high`.
14. **The Rows drawer for an opportunity does not state its population**: it says "3 contributing" but not
    "of 18 merged among the last 20 finished runs". `syn-medium-09-opportunity-rows`.
15. **Compare beeswarm**: the first cohort's dots are cut at the top of the plot and spill into the second
    cohort's row. `syn-large-08-compare-config-notrecorded-full`, R2 at 0:30.
16. **Flow diagram labels collide**: the counts of the top arcs (21, 1, 2) sit on the arc strokes, and at
    1100 px the "2" is half hidden. `syn-medium-02-flow-full`, `syn-medium-14-1100x700-flow`.
17. **Two time formats in one view**: the diagram says "8 min 32 s" and "2 min 41 s", while the ranking says
    "8.5 min" and "2.7 min". Elsewhere "39.3 h of 3.5 d" sits beside "1 d 15 h". `syn-medium-02-flow-full`,
    `syn-medium-09-opportunities-full`.
18. **Economics "Agents by station"**: "unknown" holds 1,373 of about 1,760 agents and is drawn as a
    one-pixel bar. The largest bucket is the one with no station, and the chart gives it no visual weight
    or explanation beside it. `syn-medium-06-economics-full`.
19. **Model filter empties Economics**: with one model picked, five of seven blocks are "Not available with
    these filters". That is honest, but the page loses its purpose; the model control could say beforehand what
    it can narrow. `syn-medium-06-economics-opus-full`.

### Nice to have

20. **Large blank areas**: Quality's "Verification outcomes" is a short notice beside a tall column; Opportunities
    has a gap under the first card; the Waits chart's log axis spends about 40% of its width between 1 s and
    1 min, where medium has no marks. `syn-medium-05-quality-full`, `syn-medium-09-opportunities-full`,
    `syn-medium-04-waits`.
21. **Parallel chart over four weeks**: there is no day or weekend banding, so the weekends asked for in item 4
    are hard to find. `syn-large-04-parallel`.
22. **Opportunities intro said twice** (heading paragraph and the next one). `syn-medium-09-opportunities`.
23. **Mixed precision**: "Escalated 2%" beside "2.5%"; Flow "Gate refusals: none" against "0 of 156".
    `syn-large-08-compare-config-notrecorded`, `syn-medium-03-durations-review`.
24. **Money in prose set in monospace** with wide letter spacing ("$250 . 88"), unlike every other number in the
    sentence. `syn-medium-01-pulse-dark`.
25. **Outside Analytics, seen on the way**: the Shell header truncates the project and wave to "m.." and "WA'" at
    1100 px (`syn-medium-14-1100x700-*`); the Atlas's bottom ruler reads "00:00:00" at every tick, and the station
    inspector says "Not visited … Finished" above a list of 20 visits (`syn-medium-10-nav-4-floor-station`).

## Against the owner's criteria, and against the Atlas and Timeline

- **Hierarchy, density, colour**: good. The sheet reads top-down (question, headline sentence with its basis,
  then sections), and chart density is restrained. Colour stays within the Control Tower's palette: neutral
  marks, green for slices, amber for remediation and missing cost, red for loops back. Light and dark are
  equally finished.
- **Source and coverage**: strong. Every frame carries the source, window and basis. Coverage and "lower
  bound" appear where cost is incomplete, and the Simulation is marked Simulated everywhere.
- **Correctness**: this is where the work falls short. Every readout equals the API, but the API's bucketed
  medians are printed as exact (1), and two medians of the same thing disagree (B, C). One "none" and one "0"
  are false (2, 3). Replay mixes bases in one view (5).
- **Not generic**: mostly. The flow diagram, remediation paths, the ending bars "each over its own base" and the
  cohort beeswarms are specific to MACH. Pulse's four summary cards and the Compare cards are closer to a
  standard dashboard.
- **Against the Atlas and Timeline**: Analytics is a document of prose, cards and small charts. The Atlas and
  Timeline are spatial and temporal instruments with a shared playhead, a selection and an inspector. Their
  vocabulary carries over (refs, Rows, "Open in the Timeline", the source badge), but the handoff is where the
  integration is weakest: the Timeline landing does not show what was opened (4), and Analytics has no visual
  tie to the playhead beyond a caption. Time-based charts (delivery per day, active at once) use a lighter axis
  style than the Timeline's ruler and have no day or weekend banding. Analytics is a careful, honest report beside
  the two instruments. It does not yet feel like a third view of the same object.

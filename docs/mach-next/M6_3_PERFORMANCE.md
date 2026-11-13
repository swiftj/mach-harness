# M6.3 Execution Timeline: performance method and results

Status: measured on commit `ad925b4` (2026-11-13); results in section 5. The budget is
`M6_3_DESIGN.md` section 8. This document says what is measured, on what, how, and where the numbers
go. Nothing here changes what the observer or the Control Tower do.

## 1. Budget (design section 8)

On a 200,000-event, 12-cell history:

| Measure | Budget | How the harness reads it |
|---|---|---|
| First paint of the Timeline | under 1.5 s after the scene is ready | `load`: navigation to the first frame after `[data-timeline-ready]`; also app mounted to ready |
| Pan and zoom frames | under 16 ms at the median, 33 ms at the 95th percentile | `panZoom`: animation-frame intervals while panning, zooming and dragging, with main-thread work per frame and long tasks |
| Scrub response | under 100 ms at the median | `scrub`: playhead move to the end of the next painted frame |
| Expand or collapse | under 50 ms | `expand`: click to the end of the first frame painted after `aria-expanded` flips |
| Browser heap | no more than +60 MB over the Factory Floor alone | `heap`: JS heap after a forced GC, floor alone, then with the Timeline up |
| Workspace switch | under 300 ms | `switch`: key `3` and key `1`, key down to the end of the first frame painted in the target workspace |
| Live edge (not in the budget; recorded) | frames as for pan and zoom | `liveEdge`: frames while a second process appends events to the observed project |

Frame intervals cannot go below one display refresh (16.7 ms at 60 Hz). A median interval of one
refresh means no frame was dropped at the median; the harness reports the main-thread work per frame
(Chromium's `TaskDuration` over the frames drawn) beside it, and that is the number to hold under 16 ms.

## 2. Workload

### 2.1 A generated Factory history on disk (the real observer reads it)

`apps/observer/internal/testkit/cmd/mach-synth` (test tooling, never built into `mach-observer` nor
shipped: `build.sh` and the release workflow build `./cmd/mach-observer` only) writes a project
folder in the formats the observer ingests (`M6_1_EVENT_CONTRACT.md` section 2): the intake log and
ledger, every cell's lifecycle log and files, archives and the run record for cleaned-up cells,
execution records and Claude Code stream lines. It is a pure function of its flags: the same seed
gives byte-identical files. Ids are invented (`SYN-*`, `SLICE-*`, `WAVE-*`, `P-SYNTH`), people appear
only as roles, and no path outside the generated folder is written into it.

The standard workload: `--cells 12 --events 220000 --seed 1 --hours 30`. What it contains:

- 3 waves, 13 slices (one never gets a cell and still waits at the end), dependencies: several
  blocked then resolved, one blocked three times (two new revisions each add a dependency).
- `factory.activated` with `max_parallel: 3`; the supervisor's passes hold work with the fixed
  sentence `all 3 place(s) are in use` (capacity waits, about 15) and release it.
- 12 cells running with real overlap, each through groom, plan, build, verify and review: verification
  failures followed by revise visits; review rounds 1 to 3, a rejection and an escalation; a person's
  approval after a wait, and one wait still open at the end; a cell still revising at the end.
- 28 executions, several per cell, cut across visits so they do not line up with review rounds; 27
  run a Dynamic Workflow with about 36 agents each (lifecycle, queue time, tokens and tool-call counts
  only: count-only), and every execution's main loop makes tool calls that are observable one by one.
- An interrupted execution, a recovery and a resumed visit (`resumed`, `unclosed_visit`); an execution
  whose outcome is unknown; an execution still running at the end (the live edge).
- A late, out-of-order batch in the intake log (three samples queued five minutes late) and in a
  lifecycle log; a stream whose records carry no timestamps (bounded when read afterwards, placed by
  arrival when read live); and one history gap (two intake lines missing: `missing-seq`, deliberate).

The agents' progress records fill the event budget: everything else is fixed by the scenario
(about 3,300 events for 12 cells), the rest is spread over the agents by how long each ran.
`<dir>/synth-summary.json` gives the events by type and source, the spans the model holds by kind,
the deliberate features with their ids, and the time range; `<dir>/synth-state.json` is what
`--append` continues.

Regenerate (generated histories are about 110 MB: keep them out of the repository):

```sh
cd apps/observer
go run ./internal/testkit/cmd/mach-synth --out "$SCRATCH/synthetic-220k" --cells 12 --events 220000 --seed 1 --hours 30
# --end now: end the history at the current minute (not byte-repeatable), for a continuous live edge
```

Extend it live while measuring (the harness does this itself in the `liveEdge` step):

```sh
go run ./internal/testkit/cmd/mach-synth --out "$SCRATCH/synthetic-220k" --append --rate 200 --duration 60s
```

`--append` continues the open execution: workflow agents' progress stamped now, new agents queued and
started every 2 s, a main-loop tool call with no timestamp every second (arrival-placed), a gate on
the open build visit every 3 s, a late batch of two lifecycle lines stamped ten minutes ago every
30 s, and the supervisor's pass every 5 s. It changes the project: measure on a copy.

### 2.2 Contract-shaped data in memory (node tests, the fake observer)

`web/apps/control-tower/test/fixtures/timeline.mjs`: `spansFixture`, `marksFixture`,
`concurrencyFixture`, `densityFixture` and `fakeTimelineData` (a `TimelineData` with binary-searched
window queries, a cap that sets `truncated`, `nextMark`, `subscribe` and an `advance(ms)` control).
Defaults: about 60,000 spans of every kind and every duration basis (measured, bounded, inferred,
open, unknown, and interrupted visits taken up again) and 20,000 marks, made in well under 0.5 s.
`test/timeline-fixtures.test.mjs` holds its shape, determinism, size and speed.

## 3. The harness

`web/apps/control-tower/scripts/timeline-measure.mjs` with `scripts/timeline-lib.mjs` (modelled on
`measure.mjs` and `lib.mjs`): the capture build, served on a free port (never 4186), Playwright's
Chromium, CDP `Performance.getMetrics` and `HeapProfiler.collectGarbage`, an in-page recorder of
animation frames, long tasks, long animation frames and input-to-frame latency.

```sh
cd web/apps/control-tower
# The observer started by the harness on a generated project (cold catch-up measured when the
# project has no .factory/local/observer yet):
node scripts/timeline-measure.mjs --project "$SCRATCH/copy-of-synthetic-220k" --observer-bin "$SCRATCH/mach-observer"
# An observer already running (its one-time link); --project adds the live-edge step:
node scripts/timeline-measure.mjs --observer-url "http://127.0.0.1:PORT/?k=..." [--project <dir>]
# No observer: the capture build on the simulation's spans:
node scripts/timeline-measure.mjs --fixture
# options: --out <dir> --headed --runs <n> --append-rate <n> --append-seconds <s> --synth-bin <path> --rebuild
```

The observer binary: `go build -o "$SCRATCH/mach-observer" ./cmd/mach-observer` in `apps/observer`
(the placeholder page) or `apps/observer/build.sh` (the Control Tower embedded). When the observer
serves the placeholder, the harness serves this checkout's capture build itself and forwards
`/api/` to the observer with the session cookie, so the browser still sees one origin. Each step
that the interface cannot support yet reports `not measurable yet: <why>` and the run goes on.
Output: `<out>/timeline-perf-<time>.json`, `<out>/latest.json` and a short table on stdout.

What the harness needs from the interface (all present at the time of writing):

- `data-timeline-ready` on the workspace root (`[data-timeline-workspace]`) once the first tracks,
  the table or a designed empty state are on screen, and `data-timeline-spans` with the count held;
- one track canvas (the largest `canvas` in the workspace) taking horizontal wheel to pan,
  Ctrl+wheel to zoom and drag;
- `button[aria-expanded]` toggles in the label column;
- keys `3` and `1` for the workspace switch, and the playback keys (`,` `.` `Shift+,` `Shift+.`) for
  scrubbing when no `[role=slider]` labelled "Playhead" is in the page;
- for "after the scene is ready" exactly as the budget words it, a scene-ready marker on the shell
  would let the harness start the clock there; until then it reports navigation to ready and
  app mounted to ready;
- for `--fixture` at the 60,000-span size, a capture-build hook to hand the Timeline a
  `TimelineData` (`fakeTimelineData`); until then fixture mode measures the simulation's spans.

Machine facts recorded with every run: CPU model and cores, memory, OS and architecture, Node,
Chromium version, headless or headed, WebGL renderer, display refresh, power source (macOS), the
checkout's commit, branch and whether it had uncommitted changes; and the workload's summary and the
observer's health (events indexed, gaps, runtime state, records refused, late events, catch-up time).

## 4. Observer facts on the standard workload

Measured while preparing the method (observer built from this branch, placeholder page, Apple
silicon laptop): the observer indexed 220,268 events (220,000 from the sources and 268 of its own
reconstructions) in about 22 s from a cold start, with the deliberate `missing-seq` gap the only gap,
every stream on a proven runtime and no record refused; `/api/v1/spans` held 2,420 spans across all
17 kinds (`capacity-wait` included), answering `limit=1000` in about 4 ms.

## 5. Results (2026-11-13, commit `ad925b4`)

Measured on a clean detached checkout of `ad925b4` (the M6.3 tip at the time; the branch has since
moved). Every figure is from the real `mach-observer` built from that checkout with the Control Tower
embedded (`SKIP_INSTALL=1 OUT=... apps/observer/build.sh`), except the simulation rows (the capture
build). Three runs per workload. "Median" is the median of the three runs' medians; "worst" is the
single worst observation over all three runs. Misses are stated with their margin and not rounded
away.

### 5.1 Machine

| | |
|---|---|
| CPU | Apple M3, 8 cores (4 performance + 4 efficiency); GPU 10 cores (unused, see below) |
| Memory | 16 GB |
| OS | macOS 27.2 (26B123), arm64, on AC power |
| Browser | Playwright 1.58.2, Chromium headless shell 145.0.7632.6, **headless** |
| Rendering | **software**: `WebGL` unavailable in the headless shell (`no WebGL`), so canvas raster and compositing run on the CPU |
| Viewport | 1512 x 982 CSS px at device pixel ratio 2 (the 14-inch laptop's default), dark theme |
| Display refresh | none (headless); `requestAnimationFrame` ran at 54 to 60 Hz |
| Node / Go | v25.8.2 / go1.27.3 |
| Load | a shared machine: other sessions' processes (two other `mach-observer`s among them) kept the load average at 3 to 4 throughout |

**Frame intervals.** A 60 Hz display cannot show a frame interval under 16.7 ms, and the headless
shell paced frames at 54 to 60 Hz, so every frame-interval median below reads 16.7 ms and every
p95 about 18.5 ms: that is the refresh, not the Timeline. The budget's "16 ms median, 33 ms p95" is
therefore judged on **main-thread work per frame** (Chromium's `TaskDuration` over the frames
drawn) and on long tasks; the intervals are given beside it.

### 5.2 Budget on the 220,000-event, 12-cell history

Workload: `mach-synth --cells 12 --events 220000 --seed 1 --hours 30`, regenerated with the
generator at `ad925b4` (the copy prepared earlier was stale: same file count, different bytes). The
observer indexed 220,267 events and serves 2,420 spans; the Timeline holds all 2,420.

| Budget (design section 8) | Measure | Median | Worst | Result |
|---|---|---|---|---|
| First paint under 1.5 s after the scene is ready | `[data-scene-ready]` on the shell to the frame after `[data-timeline-ready]` | 175 ms | 201 ms | **pass** (1,325 ms to spare at the median, 1,299 at worst) |
| (for reference) | navigation to first tracks painted | 920 ms | 1,128 ms | under 1.5 s |
| Pan and zoom frames: 16 ms median | main-thread work per frame, the heaviest gesture (drag-pan in a 10-minute window) | 3.44 ms | 4.04 ms | **pass** (12.0 ms to spare at worst) |
| Pan and zoom frames: 33 ms p95 | frame interval p95 over every gesture; long tasks | 18.5 ms; 0 long tasks | 18.6 ms; 0 long tasks | **pass** (14.4 ms to spare; no task over 50 ms in any gesture) |
| Scrub response under 100 ms median | Alt+click on the temporal overview, 40 steps from the first event to the live edge, paused: pointer down to the end of the frame after the playhead moved | 10.7 ms (p95 24.1) | one step of 1,402.7 ms (run 1); otherwise 26.3 ms | **pass** at the median (89.3 ms to spare); the one 1.4 s step is unexplained (5.4) |
| (also) | playback keys `,` `.` `Shift+,` `Shift+.` (harness `scrub`) | 16.6 ms (p95 57.2) | p95 60.9 ms | pass |
| Expand or collapse under 50 ms | one cell (`SYN-001`, `SYN-003`, `SYN-004`), click on the disclosure to the end of the frame after the row says expanded / collapsed | expand 22.8 ms, collapse 20.5 ms | expand 30.2 ms, **collapse 65.8 ms** | median **pass**; worst collapse **miss by 15.8 ms** |
| (expand all) | every collapsed row in Product grouping, one after another (12 rows) | 22.0 ms per row | **106.4 ms** | median **pass**; worst **miss by 56.4 ms** |
| Heap: no more than +60 MB over the Factory Floor alone | JS heap after a forced GC: floor alone, then with the Timeline up | +6.7 MB (36.2 to 42.9 MB) | +6.8 MB | **pass** (53.2 MB to spare) |
| Workspace switch under 300 ms | key `3` (floor to Timeline, until ready and painted), 5 per run | 154.2 ms | **503.2 ms** | median **pass**; worst **miss by 203.2 ms** (every run's first switch: 503, 455, 476 ms) |
| (back) | key `1` (Timeline to floor) | 32.3 ms | 47.6 ms | pass |

Main-thread work per frame, every gesture (median of runs / worst run; frame interval p95 18.0 to
18.6 ms and no long task in all of them):

| Gesture | Work per frame |
|---|---|
| zoom (harness: Ctrl+wheel in and out from the whole history) | 2.78 / 2.93 ms |
| zoom in from the whole history to 10 minutes, about the densest moment | 3.31 / 3.45 ms |
| zoom out from 10 minutes to the whole history | 0.37 / 0.43 ms |
| pan (horizontal wheel), 2-hour window | 2.66 / 2.88 ms |
| drag-pan, 2-hour window | 3.74 / 3.74 ms |
| pan, 10-minute window | 2.66 / 2.91 ms |
| drag-pan, 10-minute window | 3.44 / 4.04 ms |
| row scroll (vertical wheel) | 2.07 / 2.10 ms |
| pan with every Product row open | 0.68 / 1.04 ms |
| Alt+drag of the playhead over the whole history | 2.25 / 2.35 ms (input to next frame 7.2 ms) |
| harness `pan` and `drag` at the default window | 0.50 / 1.09 ms: **not a pan** (see 5.6) |

### 5.3 Live edge under concurrent execution (not budgeted; recorded)

A second copy of the same history, its own observer, the Timeline following the live edge
(`data-live-state="live"` before each run), while `mach-synth --append --rate 200 --duration 60s`
ran (12,000 events per run at 200 per second achieved: agent progress, 30 new agents, 60 tool calls
placed by arrival, 24 gates, 4 late lines, 12 supervisor passes).

| Measure | Median | Worst |
|---|---|---|
| Frame interval median / p95 | 16.7 / 18.5 ms | 16.7 / 18.5 ms |
| Main-thread work per frame | 3.92 ms | 3.92 ms |
| Long tasks / long animation frames | 0 / 0 | 0 / 0 |
| Requests from the page | 20.3 per second | 20.4 per second |
| (by route, per 60 s) | `/spans` 614, `/marks` 408, `/series` 121, `/concurrency` 60, `/health` 6, `/factory/status` 6 | |
| Append to span shown (30 agent spans per run, start stamped at the write) | 1,065 ms (p95 1,612) | 1,912 ms |
| Observer CPU (`ps`, 1 s samples) | 6.9 % | 21.1 % |

"Span shown" is the first `/spans` response that holds the span, then the next painted frame,
minus the span's start (when `mach-synth` wrote it). The order of a second is the observer's file
polling (150 to 500 ms) plus the Timeline's re-query throttle (`THROTTLE_MS`, 500 ms) plus the
re-read of the live-edge tiles; it is not budgeted.

### 5.4 The observer on this history

`node observer-facts.mjs` (section 6): the observer started on a fresh copy with no index, three
times; the 10-minute window is the densest one (115 spans overlap it: 117 returned; 7 marks; 120
five-second buckets). 200 sequential requests per route, from Node on the same machine.

| Measure | Median | Worst |
|---|---|---|
| Cold catch-up (start to `catching_up: false` and every event projected) | 20.3 s | 20.3 s |
| Warm restart (index on disk) | 4.9 s (one run) | |
| RSS after catch-up | 255 MB | 255 MB (239 to 255) |
| Index on disk | 241 MB (241,012,736 bytes) | 263 MB after three 60 s appends |
| `/spans` (10-minute window) p50 / p95 | 0.62 / 0.80 ms | 0.62 / 1.20 ms (max 4.55) |
| `/marks` p50 / p95 | 0.14 / 0.23 ms | 0.15 / 0.28 ms |
| `/concurrency` (5 s buckets) p50 / p95 | 0.78 / 0.93 ms | 0.78 / 0.96 ms |
| While appending at 200/s, same window: `/spans` / `/marks` / `/concurrency` p50 / p95 | 0.60 / 1.15, 0.12 / 0.17, 0.77 / 1.30 ms | max 20.9, 8.3, 8.1 ms |
| While appending, the last 10 minutes (live edge): `/spans` / `/marks` / `/concurrency` p50 / p95 | 0.20 / 0.25, 0.08 / 0.18, 0.67 / 0.81 ms | max 0.8, 0.9, 7.3 ms |
| Observer CPU while appending (no page open) | 5.6 % | 38.1 % |
| RSS after the append | 171 MB | |

### 5.5 Small history (the real supervised run) and the simulation

The real run: a copy of the second supervised run's engineering project (415 events, 151 spans;
the observer caught up cold in 162 ms at 26 MB RSS with a 0.55 MB index; `/spans` on its densest
10 minutes p50 0.70, p95 1.25 ms). The simulation: `--fixture` (the capture build, `?simulation`);
**the Timeline held 0 spans at every moment measured** (playback at the start of the run), so these
are the empty workspace's floor, not a loaded Timeline.

| Measure | Real run: median / worst | Simulation: median / worst | Budget |
|---|---|---|---|
| Scene ready to first tracks painted | 117 / 202 ms | 66 / 74 ms | pass / pass |
| Navigation to first tracks painted | 369 / 487 ms | 219 / 224 ms | |
| Work per frame, heaviest gesture | 3.01 / 3.79 ms (drag-pan, 2 h) | 2.28 / 2.33 ms | pass / pass |
| Frame interval p95, long tasks | 18.6 ms, 0 | 18.6 ms, 0 | pass / pass |
| Scrub step (Alt+click) | 20.1 / 43.1 ms | 20.9 / 76.3 ms | pass / pass |
| Expand / collapse one cell | 21.5 / 27.6 ms, 19.0 / 43.9 ms | not measurable: no expandable cell row | pass / - |
| Expand all | nothing was collapsed | nothing was collapsed | - |
| Heap over the floor | +4.5 MB | +3.4 MB | pass / pass |
| Switch floor to Timeline | 121.1 / **368.3 ms** | 103.8 / 165.1 ms | median pass, worst **miss by 68.3 ms** / pass |
| Switch back | 39.8 / 46.0 ms | 34.0 / 47.6 ms | pass / pass |

### 5.6 Misses and their causes

Profiled with CDP (`Profiler`, 100 us sampling) on an unminified build of the same commit
(`vite build --minify false`, served on the same origin with `/api/` proxied to the observer) and
with long-animation-frame entries in the production build. Nothing was changed.

1. **Workspace switch, first time: 455 to 503 ms (synthetic), 368 ms (real run).** Only the first
   switch after the page loads misses (later ones: 104 to 181 ms). It is the Timeline's first mount,
   and no frame in it is longer than 30 ms: the time is chained requests and their parsing. Cause:
   on first mount the Timeline requests its three 3-day span tiles and three mark tiles **twice**
   (identical request sets about 40 ms apart), then pages the dense tile (two more `/spans`
   requests), about 3.3 MB of JSON in all, and `data-timeline-ready` waits for both the window and
   the whole-history structure (`Workspace.tsx`, `settled`). The warm switch's own cost (about
   160 to 180 ms of main thread in the profile): the React commit of the workspace (about 100 ms),
   `TrackCanvas.drawMain` re-sizing both DPR-2 canvases on every switch (`setTransform` on a fresh
   backing store, 30 to 40 ms self, in software raster) and `readPalette`'s computed-style reads
   (about 10 ms).
2. **Collapse 65.8 ms and expand-all 106.4 ms at worst** (medians 20 to 23 ms). The slow toggle is
   the first one after the Timeline settles (51 to 56 ms in repeated runs). Its long animation frame
   is 54 ms with 6 ms of script (the click handler, `DIV#root.onclick`), no forced layout and no
   blocking: the rest is style, layout and paint of the label column and both canvases, in software
   rendering. A CPU profile of 12 consecutive expansions shows 4 to 22 ms of script each. The single
   106 ms expansion (run 2) was not reproduced under the profiler and is not attributed further.

### 5.7 What was not measured, or measured differently

- **Headed or GPU-composited runs**: none. All figures are headless with software rendering; a real
  display at 60 or 120 Hz with GPU raster was not measured.
- **The harness's own `expand` step** was not used: its selector (`button[aria-expanded]` in the
  workspace) matches the toolbar's menus (Filters, Investigate, Jump, More), not track rows; the
  label column's row buttons carry no `aria-expanded` (their state is in screen-reader text). The
  `expandCell` and `expandAll*` steps click the disclosure triangle instead.
- **The harness's `pan` and `drag`** run at the default window, which shows the whole history, where
  the window is clamped and does not move (`data-timeline-window` unchanged), so their 0.5 to
  1.1 ms is not panning work. The `panZoomed` step zooms to 2 hours and to 10 minutes about the
  densest moment first and confirms the window moved (46 to 92 distinct windows per gesture).
- **The harness's `liveEdge` step** was replaced by `live` (same frame recorder, plus requests per
  second, append-to-span latency and observer CPU); it appends for 60 s, not 15.
- **"Expand all"** is not a control: there is no expand-all command (`*` and Alt+Right open one
  row). It is measured as every collapsed row opened in turn. In Execution grouping only 2 rows were
  collapsed (everything else opens by default); on the real run and the simulation nothing was.
- **Append to span shown** is approximated by the frame after the `/spans` response that first holds
  the span, not by reading pixels; spans placed by arrival (tool calls, queue waits) are excluded
  because their start is the observer's arrival, not the write.
- **The per-step work of scrubbing** (Chromium `TaskDuration` between pointer down and settle:
  median 6 to 8 ms, p95 53 to 164 ms) has a tail that is not script: a CPU profile of 40 steps holds
  64 ms of script in all. The tail was not attributed further. The one 1,402.7 ms scrub step (run 1
  of the synthetic history) was not reproduced and is not explained.
- **The 60,000-span in-memory fixture** (`fakeTimelineData`): the app still has no hook to load it,
  and the simulation held no spans, so no fixture-scale number exists.
- Observer CPU and RSS were not sampled during the UI steps other than `live`, and the browser's GPU
  process and raster threads were not measured.

## 6. Commands (this measurement)

Scratch: `$S=/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m63-agents/perf-measure`
(temporary). The extended harness `harness/tl-measure.mjs` is a copy of
`scripts/timeline-measure.mjs` that imports this checkout's `timeline-lib.mjs` and Playwright and
adds: 1512 x 982 at DPR 2, fixed ports (4260 to 4269), `--steps`, scene ready to ready in `load`,
and the steps `panZoomed`, `scrubSteps`, `expandCell`, `expandAllProduct`, `expandAllExecution`,
`live`. `harness/observer-facts.mjs` measures the observer; `harness/profile.mjs` takes the CPU
profiles; `harness/summarize.py` makes the tables.

```sh
# in the clean checkout at ad925b4
SKIP_INSTALL=1 OUT=$S/bin/mach-observer apps/observer/build.sh
(cd apps/observer && go build -o $S/bin/mach-synth ./internal/testkit/cmd/mach-synth)
$S/bin/mach-synth --out $S/synth-pristine --cells 12 --events 220000 --seed 1 --hours 30
cp -R $S/synth-pristine $S/synth-a; cp -R $S/synth-pristine $S/synth-b      # UI; live edge
rsync -a --exclude .factory/local/observer <second supervised run>/P/eng/ $S/eng/

# observer facts: three cold starts on fresh copies, then one with an append
node observer-facts.mjs --bin $S/bin/mach-observer --project $S/cold-N --port 4260 --json obs-cold-N.json
node observer-facts.mjs --bin $S/bin/mach-observer --project $S/cold-1 --port 4260 \
     --synth $S/bin/mach-synth --append-seconds 60 --rate 200 --json obs-append-1.json

# UI, three runs each (observer started with --port 4262 / 4265 / 4266)
node tl-measure.mjs --observer-url $S/synth-a/.factory/local/observer/link --runs 3 --focus 1794406000999 \
     --steps load,panZoom,panZoomed,scrub,scrubSteps,expandCell,expandAllProduct,expandAllExecution,heap,switch
node tl-measure.mjs --observer-url $S/eng/.factory/local/observer/link --runs 3 --steps <same>
node tl-measure.mjs --fixture --app-port 4263 --runs 3 --steps <same, without expandAllExecution>
node tl-measure.mjs --observer-url $S/synth-b/.factory/local/observer/link --project $S/synth-b \
     --observer-pid <pid> --synth-bin $S/bin/mach-synth --append-seconds 60 --append-rate 200 --steps live

# profiles (unminified build of the same commit, served on 4264)
pnpm exec vite build --minify false --outDir $S/dist-nomin     # in web/apps/control-tower
node profile.mjs <link file> $S/dist-nomin switch|expand|scrub out.json
```

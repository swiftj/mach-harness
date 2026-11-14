# M6.6 Control Tower: performance and memory

Measured on 2026-11-14 at `4180c16` (clean tree) against a build of `20326ab` (M6.5) on the same history.
Changed as a result: `timeline/tracks/build.ts` (section 4.1) and two tests; the observer is unchanged.

## 1. Procedure

- **History**: `mach-synth --analytics --profile realistic --cells 330 --waves 40 --events 240000 --seed 1`,
  built from this tree (the generator last changed in `d9edd9a`, after both of M6.5's corrections): 239,996
  events, 330 cells; the observer indexes 246,257. Every observer run starts from a fresh copy.
- **Binaries**: `mach-observer` from `go build ./cmd/mach-observer` at `4180c16` and from
  `git archive 20326ab apps/observer` (plain `go build`, no embedded app). The Control Tower of each commit is a
  production `vite build` (the `20326ab` copy installed offline: dependencies are identical), served by a small
  same-origin static server that forwards `/api/` to that commit's observer. Unminified builds of both were used
  only for CPU profiles.
- **Observer** (`obs.mjs`, 5 runs per binary, order alternated): delete the index and start (cold rebuild,
  to caught up); stop and start (restart); each route once cold, then 20 warm requests; 15 s settle, 30 s idle
  (CPU time and RSS from `ps`); 15 s of `mach-synth --append` at 200 events/s (CPU, CPU per event, a query
  every 250 ms) and the time to catch up.
- **UI** (`ui.mjs`, Playwright Chromium headless shell 145.0.7632.6, 1512x982 at DPR 2, dark; 5 runs per
  commit, each over that commit's observer on an indexed copy): workspace switches (key to ready plus a frame),
  Atlas idle, playback at the fastest speed and zoom keys; Blueprint switch, tree keys and zoom; Timeline zoom
  keys, Ctrl+wheel zoom, wheel pan and playback-key scrubbing, each also held half a week before the end
  (`#timeline?at=`); Analytics area switch, window preset, Risk filter, hover to tip, brush (drag release to the
  last DOM change before 150 ms of quiet), also held (`#analytics?...&at=`). "Work per frame" is Chromium's
  `TaskDuration` over the frames drawn; headless frame intervals cannot go below 16.7 ms.
- **Statistics**: every figure is median [min-max] over pooled samples; p90 where n >= 10; n is stated.
- **Scripts and raw data** (scratch, not in the repository):
  `scratchpad/m66/agents/perf/h/` (`lib.mjs`, `obs.mjs`, `ui.mjs`, `probe.mjs`, `scrubprobe.mjs`,
  `summarize.py`), raw JSON in `scratchpad/m66/agents/perf/raw/` (`obs/obs.json`, `ui-head/ui.json`,
  `ui-base/ui.json`, `ui-head-dev/ui.json`), CPU profiles `raw/probe-*.cpuprofile`, `raw/scrub-head.cpuprofile`,
  `raw/scrub-base.cpuprofile`.

## 2. Environment

Apple M3, 8 cores, 16 GB, macOS 27.2, on AC power; Go 1.27.3, Node 25.8.2, Playwright 1.58.2. **The machine was
not quiet**: desktop applications kept the 1-minute load at 3 to 6, and a system-service storm took it to 84
around 18:00 UTC. The harness waited up to 2 minutes for a load under 3 and then ran anyway; load at run start
was 2.9-11.6 (observer runs), 3.5-25.9 (HEAD UI runs) and 2.9-6.4 (`20326ab` UI runs). Treat absolute UI times
as upper bounds; the HEAD/`20326ab` comparison and the profiles are what carry weight.

## 3. Results against budgets and earlier figures

Budgets: Timeline `M6_3_DESIGN.md` section 8; Analytics and observer `M6_5_TESTING.md`; floor views the M6.0
"scene update <= 8 ms per frame" (`M6_0_FINDINGS.md`).

| Measure | HEAD `4180c16` | `20326ab` | Earlier (M6.5 / M6.3) | Budget | HEAD |
|---|---|---|---|---|---|
| Cold rebuild | 26.8 s [24.9-30.7] n=5 | 24.4 s [23.9-29.2] | 32.9 s (M6.5) | 60 s | within |
| Restart from saved projection | 7.1 s [6.7-8.2] n=5 | 6.7 s [6.4-7.4] | 12.5 s (M6.5) | 10 s | within |
| Idle CPU (% of a core) | 2.1 [1.7-31.8] n=5 | 2.1 [1.3-31.2] | 27.7 (M6.5) | 2 % | **over** (see 4.4) |
| Idle RSS | 297 MB [278-353] | 331 MB [280-351] | 317 MB | 450 MB | within |
| CPU while appending 200 events/s | 32.5 % [29.7-95.1] | 35.8 % [27.3-109] | 144 % | 50 % | within (median) |
| CPU per appended event | 1.65 ms [1.51-4.83] | 1.82 ms [1.39-5.54] | 7.3 ms | 1 ms | **over** |
| Ingest achieved | 197 events/s | 197 | | | no budget |
| Catch-up after last append | 8 ms [5-12] | 9 ms [7-11] | 14 ms | 2000 ms | within |
| Warm queries, all routes pooled | 2.8 ms [0.6-60] p90 13.4 n=1900 | 2.9 ms [0.6-151] p90 14.7 | 8.9 ms | 50 ms median | within |
| Slowest first query (`flow`) | 291 ms [220-424] | 346 ms [218-491] | 383 ms | 1000 ms | within |
| Scene ready (navigation) | 1477 ms [1385-1558] | 1400 ms [1321-1552] | | 1500 ms (first paint) | within (median) |
| **Floor -> Timeline, first switch** | before 3040 ms [1837-4383] n=5; **after fix 874 ms [848-1168] n=5** | 3745 ms [1870-4309] | 455-503 ms (M6.3, 12 cells) | 300 ms | **over** (3.5x better) |
| **Floor -> Timeline, later** | before 2032 ms [845-3883] p90 3597 n=25; **after 598 ms [499-806] p90 794 n=25** | 1475 ms [837-3080] | 154 ms (M6.3) | 300 ms | **over** (3.4x better) |
| Analytics -> Timeline | before 1321 ms [754-2017] p90 1456; after 435 ms [366-613] p90 484 | 1374 ms [746-2508] | | 300 ms | **over** |
| Floor -> Analytics, first | 621 ms [598-858] | 589 ms [585-687] | | 300 ms | **over** |
| Floor -> Analytics, later | 246 ms [136-623] p90 348 | 228 ms [176-376] | | 300 ms | within (median) |
| Timeline -> Analytics | 123 ms [94-704] p90 318 | 118 ms [65-333] | | 300 ms | within |
| Any -> floor | 156 ms [73-726] p90 179 n=55 | 153 ms [89-244] | 32 ms (M6.3) | 300 ms | within |
| Atlas playback, work per frame | 5.2 ms [5.0-5.7] | 5.2 ms [5.0-5.3] | 4.0-5.3 (M6.0) | 8 ms | within |
| Atlas playback, frame interval p95 | 18.1 ms [17.6-18.6] | 18.6 ms | | 33 ms | within |
| Atlas idle / zoom keys, work per frame | 0.6 / 2.0 ms | 0.7 / 2.2 ms | | 8 ms | within |
| Blueprint switch from Atlas | 166 ms [132-211] p90 193 n=25 | 163 ms [147-268] | 2.07 s (M6.2, 230k) | 300 ms | within |
| Blueprint tree key to settled view | 53 ms [17-781] p90 720 n=75 | 43 ms [18-859] p90 730 | | no budget | |
| Blueprint tree navigation, work per frame | 20.6 ms [19.0-21.3]; ~31 long tasks | 20.3 ms | | 8 ms | **over** |
| Blueprint zoom keys, work per frame | 45.1 ms [40.4-52.0]; frame p95 68 ms | 42.2 ms | | 8 ms | **over** |
| Timeline zoom keys, work per frame | 16.6 ms [15.7-27.5] | 26.0 ms | 2.8-3.3 ms (M6.3) | 16 ms | **over** (median at limit) |
| Timeline Ctrl+wheel zoom, work per frame | 34.0 ms [21.9-35.1] | 21.6 ms | | 16 ms | **over** |
| Timeline wheel pan, work per frame; longest task | 31.9 ms; 593 ms | 36.6 ms; 569 ms | 2.7 ms; none (M6.3) | 16 ms; 33 ms p95 | **over** |
| **Timeline scrub (playback key to settled)** | before 579 ms [549-719] p90 605 n=60; **after fix 31.8 ms [20.4-229] p90 117 n=60** | 6.5 ms [2.3-139] | 16.6 ms (M6.3) | 100 ms | within (median) |
| Held: Timeline scrub | before 300 ms [286-444] p90 416; **after 29.7 ms [18.4-214] p90 74 n=60** | 4.6 ms [1.7-89] | | 100 ms | within (median) |
| Held: Timeline zoom keys / pan, work per frame | 7.5 / 26.2 ms | 8.2 / 28.3 ms | | 16 ms | within / **over** |
| Analytics area switch | 29.5 ms [0-106] p90 53 n=70 | 30.4 ms | 51.8 ms | 300 ms | within |
| Analytics window preset (run medians) | 30.4 ms [18.7-33.0] | 32.0 ms | 57.5 ms | 300 ms | within |
| Analytics filter (run medians) | 29.3 ms [22.6-30.8] | 32.2 ms | 52.4 ms | 300 ms | within |
| Analytics hover to tip | 16.7 ms [16.6-17.0] | 16.7 ms | 16.7 ms | 50 ms | within |
| **Analytics brush release** | **36.8 ms [23.2-107] p90 69 n=40** | 37.4 ms [23.8-71.5] | 120 ms; 264 ms once (M6.5) | 200 ms | within |
| Held: Analytics brush release / area switch | 43.0 ms [22-63] / 26.9 ms | 49.6 / 26.7 ms | | 200 / 300 ms | within |
| JS heap, switch step (after GC, before -> after 16 switches) | 87.7 -> 105.2 MB (+17.5) every run | 87.5 -> 105.4 MB | +42 MB (M6.5) | +60 MB | within |

Queries per route, cold and warm, HEAD against `20326ab` (`spans`, `marks`, `concurrency`, and the five
analytics routes with and without `as_of_ms`) are in `summarize.py obs` output; every warm median is 0.7 to
13 ms on both, `as_of_ms` changes none by more than its spread, and the only first-query cost over 30 ms is
the first 3-day `spans` tile (179 ms vs 174 ms) and `flow` (above).

## 4. What is over budget, and why

### 4.1 and 4.2: mark-to-track assignment (fixed after the first measurement)

**Before.** Each Timeline playback key was one main-thread task of about 575 ms on HEAD and none on
`20326ab` (`scrubprobe.mjs`, unminified builds, 5 keys: 3.4 s busy against 34 ms), and switching to the
Timeline took 2.0-4.9 s on both builds. CPU profiles (`raw/scrub-*.cpuprofile`, `raw/probe-*.cpuprofile`)
put 3.2 s of the scrub's 3.4 s, and 1.5-1.8 s (`markTrackOf`) plus 0.7-0.8 s (`refsOfNode`) of each
switch, in `TrackCanvas`'s `marksByTrack` memo: `markTrackOf` scanned every track node of the 330-cell tree
for every mark (O(marks x tracks)). The switch cost is pre-existing (M6.3's 154 ms was on 12 cells). The
scrub regression is M6.6's cut at the playhead: `timeline/Workspace.tsx` builds new spans and marks
(`spansAsOf`, `marksAsOf`) on every move of a held playhead, so the tree and `marksByTrack` were rebuilt
per step.

**Fix** (`timeline/tracks/build.ts`): `markTrackOf` is a lookup in a ref -> best-track index built in one
pass over the tree's nodes, once per tree (same rule: rank -1, 0 or 4, then deepest, then id). A playhead
step now costs one pass over the tracks plus one lookup per mark. `Workspace.tsx` is unchanged: the cut
stays exact, and `test/m66-held-at-playhead.test.mjs` passes unchanged. New test
`test/m66-mark-assignment.test.mjs` counts the work: over 12 playhead steps on a 9,161-span, 4,983-mark
model, at most one index build and at most one scan per track (191) per step, against about 950,000 node
visits before.

**After** (5 runs on HEAD, load 4.7-7.2): scrub 31.8 ms median (held 29.7 ms), within the 100 ms budget;
pan work 4.4 ms per frame with no task over 53 ms (was 31.9 ms and 593 ms); zoom keys 2.6 ms and
Ctrl+wheel 5.3 ms per frame (were 16.6 and 34.0). The switch to the Timeline is 3.4x faster but still over
300 ms (874 ms first, 598 ms later); what remains was not profiled.

### 4.3 Blueprint tree navigation and zoom

20-45 ms of work per frame and about 30 long tasks per 15 keys on both builds (not a change in M6.6); not
profiled.

### 4.4 Observer idle CPU and per-event cost

Idle CPU is bimodal on both binaries: run 1 (each binary) idled at 31-32 % of a core, runs 2-5 at 1.3-2.6 %.
The median (2.1 %) is just over the 2 % budget; M6.5's 27.7 % was probably the high mode. The cause of the high
mode was not profiled. CPU per appended event (1.65 ms) is over the 1 ms budget on both; HEAD is not worse
than `20326ab`.

### 4.5 The Analytics brush (M6.5's 264 ms)

Within budget on the production build: 36.8 ms median, p90 69 ms, worst 107 ms over 40 drags (HEAD), the same
on `20326ab`. M6.5's 264 ms was a single capture on a loaded machine with a different settle rule (300 ms of
quiet), and M6.5's harness measured the Vite development server. On the development server (HEAD, 3 runs
of 5, stopped early; load 2.8-4.2) the brush release is 94.8 ms [36.7-147] p90 127 (n=24) and the area switch
46.6 ms [0-210] p90 161 (n=42): within budget, about 2.5x the production build, as React's development build
costs. No change was made; there is nothing over budget to fix.

## 5. Did M6.6's changes cost anything (against `20326ab`, same history)

- **Cut at the playhead**: yes, Timeline scrubbing (4.1), about 90x slower than `20326ab` before the fix;
  after it, 31.8 ms against 6.5 ms. Nothing else measurable.
- **64-tile cap**: no difference in Timeline switch, zoom or pan beyond the spread.
- **Analytics reply key including the cut, free-text containment**: no difference in Analytics timings or
  in any query; heap growth identical.
- **Observer**: rebuild +10 % (26.8 vs 24.4 s) and restart +5 % (7.1 vs 6.7 s), both within budget and close
  to the spread; queries, idle and per-event CPU unchanged.

## 6. Not measured

- The 30-minute browser memory session cycling the workspaces with playback, and three browser clients at
  once on one observer: not run (stopped to limit cost). The harness is written (`h/mem.mjs`) but unrun.
- The unit-suite repetitions under deliberate CPU load and quiet: not run. `test/live-scale.test.mjs`
  asserted wall-clock time (`throughput > 20_000` events/s, `accessUs < 5_000`), which a loaded machine
  breaks. It now asserts work done from `log.stats().reductions`: each of the 200,000 events reduced exactly
  once on ingest, and no random `sceneAt` more than `8 x checkpointEvery` reductions (worst measured 1,023);
  the times remain diagnostics.
  Other wall-clock assertions exist in `reducer.test.mjs`, `live-windows-scale.test.mjs`,
  `timeline-fixtures.test.mjs` and `timeline-overview.test.mjs`; none was run under load.
- Execution Blueprint and Atlas on a GPU or headed display; Timeline playhead dragging (no slider matched the
  harness's selector); expand and collapse; profiles of the observer's idle high mode.

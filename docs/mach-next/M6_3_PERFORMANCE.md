# M6.3 Execution Timeline: performance method and results

Status: method written; results to be filled in once the Timeline is complete. The budget is
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

## 5. Results

To be filled in from `latest.json` when the Timeline is complete. One row per run; headless and
headed runs are separate rows.

| Date | Commit | Machine | Browser | Load (ms) | Pan p50/p95 (work) | Zoom p50/p95 (work) | Scrub p50 | Expand / collapse | Heap delta (MB) | Switch to / back | Live edge p50/p95 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | |

# M6.3 Execution Timeline: browser end-to-end suite

The Timeline's unit and model tests (`web/apps/control-tower/test/timeline-*.test.mjs`) check each part on
fixtures. This suite checks the whole workspace in a real browser, over a real `mach-observer`, on real and
synthetic Factory histories. It asserts on what a person can perceive: roles and accessible names, the
tree-table (the canvas's structured twin, design section 9), the inspector's text, the lenses' text, the
`data-*` hooks and the address. It never compares pixels.

## Running it

```
cd web/apps/control-tower
pnpm run test:e2e:timeline                 # every file, one at a time
E2E_LARGE=1 pnpm run test:e2e:timeline     # also the 220,000-event long-history test (minutes)
node --test --test-concurrency=1 --test-global-setup=e2e/global.mjs e2e/live.e2e.mjs   # one file
```

Needs Go (the observer and the generator are built from the working tree), the app's Playwright Chromium,
and the free loopback ports below. The files must run one at a time: they share one dev server and one
relay.

| Variable | Default | What |
|---|---|---|
| `E2E_SCRATCH` | `<os tmpdir>/mach-timeline-e2e` | binaries, project copies, observer logs, row dumps, `long-history.json` |
| `E2E_LARGE` | unset | `1` runs the long-history test (case 16) |
| `E2E_REAL_RUN` | the lead's supervised run under the session scratchpad | the real project to copy |
| `E2E_LARGE_PROJECT` | `perf-fixtures/synthetic-220k` under the session scratchpad | the long history to copy |
| `E2E_OBSERVER_FALLBACK` | unset | a prebuilt observer to use when the working tree does not compile |
| `E2E_DEV_PORT`, `E2E_RELAY_PORT` | 4235, 4249 | the dev server and the relay |
| `E2E_HEADED` | unset | `1` shows the browser |

## How it is put together

- **Global setup** (`e2e/global.mjs`): kills anything a previous interrupted run left, builds
  `mach-observer` and `mach-synth` into the scratch folder (`go build`; never `build.sh`, never `pnpm
  build`), starts a relay on 4249 and the Vite dev server on 4235 with `MACH_OBSERVER_PORT=4249`.
- **The relay** forwards `/api/...` to whichever observer the running test started (its port is in
  `<scratch>/relay-target`), rewriting Host and Origin to that observer's own, streaming the event stream.
  So the dev server's proxy is unchanged and one dev server serves every file.
- **Observers** run on a project COPY (`rsync` without `.factory/local/observer`, so each starts with a
  fresh index) on fixed ports: 4240 synthetic, 4241 live, 4242 real run, 4244 long history.
- **Sessions are honoured**: every browser context first opens the one-time link read from the copy's
  `.factory/local/observer/link` (immediately before use), then the app on the dev server, which carries
  the session cookie.
- **Teardown**: every process started (relay, Vite, each observer) is recorded by pid in `<scratch>/pids`
  and killed by the global teardown, also when tests fail. Each file also stops its own observer.
- **Helpers** (`scripts/timeline-e2e-lib.mjs`): `readTable` scrolls the virtualised tree-grid top to bottom
  and returns every row (`data-key`, `aria-level`, `aria-expanded`, `aria-selected`, cell texts);
  `expandTable` opens tracks; `changingFrames` counts animation frames that drew something new; checksums
  of a project tree; API offenders (any `/api` request not GET or not to 127.0.0.1); console errors.
- **When a promised behaviour is missing the test fails** with the finding id in brackets (`[T5]`,
  `[X4]`, `[r4-workspace]` for a hook). Nothing is skipped silently; the only skip is the long-history
  test without `E2E_LARGE=1`, and it says so.

## What is fixture and what is real

| | Real | Fixture |
|---|---|---|
| Observer | `mach-observer` built from the working tree, its real projection, routes, session and guard | none |
| App | the working tree through the Vite dev server (no production build) | none |
| Real run | `e2e/real-run.e2e.mjs`: a copy of the lead's supervised run (one cell, three executions, two rejected review rounds) | |
| Synthetic | | `mach-synth --cells 12 --events 12000 --seed 7 --hours 6`: deterministic, entirely synthetic; its `synth-summary.json` names the ticket for each feature (failed verification, interrupted execution, unknown outcome, open person-wait, blocked slices, the deliberate intake gap), so tests find features by name, not position |
| Late events | | two `station.entered`/`exited` lines in the cell lifecycle format, stamped in the past and appended to a copy |
| Live edge | | `mach-synth --append --rate 40 --duration 3s` on a copy |
| Long history | | the 220,000-event `synthetic-220k` project, copied |

## The tests and what each proves

`e2e/synthetic.e2e.mjs` (synthetic history, observer on 4240)

| Test | Case | Proves |
|---|---|---|
| hooks | | `data-timeline-ready`, `-spans`, `-window`, `-grouping`, `data-scene-ready` are present and well formed |
| (1) | 1 | at least two cell spans overlap in the table; the concurrency lens says how many executions ran at once, within the recorded limit |
| (2) | 2 | Execution grouping: execution → workflow → agents lane → agent spans, one level each; execution labels say "ticket · run n of m" |
| (3) | 3 | count-only agents say "n tool calls, not observable one by one"; no tool row under any agents lane |
| (4) | 4 | the first verification failed, a revise visit follows, the second passed, in time order; the retries lens ladder reads pass 1 failed → revise → pass 2 passed |
| (4b) | 4, X3 | selecting the failed verification makes it the inspector's subject (says failed, does not headline a pass) |
| (5) | 5 | a rejected round then an approved one; three seats per round, each with a verdict; the review lens shows both rounds and decisions |
| (6) | 6 | a resolved person-wait ("waited …") and an open one ("waiting …", never "took") |
| (7) | 7 | a slice blocked several times (closed waits, the waits lens counts them and names what was merged before it went on, and says the release event is not recorded); a slice still blocked at the end is shown waiting |
| (8) | 8 | the interrupted execution says so and never "took"; a later execution took the work up; nothing under it still runs; the unknown-outcome execution says "outcome not known", never finished or running, and nothing under it runs |
| (9) | 9 | the jump menu finds the deliberate gap and says so |
| (11) | 11 | no open span "took" a duration; open waves, slices, cells and rounds say open, never running |
| (12) | 12 | bounded ("between") and inferred ("≈", "about … placed by rule") times keep that wording in the duration |
| (15) | 15 | with the playhead in the middle of a cell's run, the inspector does not say merged; the table and tracks say they are as of the live edge, after the playhead |
| API and console | | every `/api` request is GET to 127.0.0.1; no console errors |

`e2e/live.e2e.mjs` (synthetic history changing under the page, observer on 4241)

| Test | Case | Proves |
|---|---|---|
| (10) | 10 | a late, out-of-order visit stamped in the past appears in a past window without a reload (and, on failure, whether the observer serves it, so client and observer are told apart) |
| live edge | | events appended to the open execution reach the tracks while following |
| (13) | 13 | after restarting the observer on the same project and reloading: no duplicated row keys, the same rows and span count as before |

`e2e/real-run.e2e.mjs` (a copy of the real supervised run, observer on 4242)

| Test | Case | Proves |
|---|---|---|
| (14a) | 14 | Atlas selection → `3`: the address keeps `sel`, the table marks the cell selected and its span is in the window → `1`: back on the Atlas with the selection |
| (14b) | 14 | a `verify.verdict` gate selected on the Blueprint → "Show in Timeline": the window holds the gate's time, the selection kept |
| (14c) | 14 | `sel`, `at`, `win`, `group`, `lens` round-trip: hooks match, the lens is open, the written address reopens the same state |
| (14d) | 14, X4 | a fresh `win=` deep link builds the same wave/slice/cell/execution tracks as navigating to that window in the app |
| (17a) | 17 | reduced motion: after a zoom, a brush drag, a brush key and a workspace switch, no CSS or Web Animation runs and the canvases change on at most 3 frames in 700 ms (with motion, a switch changes about 13) |
| (17b) | 17 | keyboard only: `3`, `Home`, `n` (next failure) selects it and the inspector says what failed; Tab to Investigate, Enter, choose "Why did it retry?"; `l` returns to live |
| (18) | 18 | `#atlas?sel=`, `#blueprint?sel=…&theater=1`, `t`, `1`, `2`, the docked timeline's tracks drawn and its ruler's playhead moved by arrows, `Shift+T` collapses and restores it |
| health | 18 | the observer's health (clocks and counters aside) is the same after the tab closes; API and console as above |
| checksums | 18 | after the whole file, no file in the project copy changed (the observer's own folder excluded) |

`e2e/long-history.e2e.mjs` (`E2E_LARGE=1`; 220,000 events, observer on 4244): case 16. Time from `3` to
`data-timeline-ready` (budget 1.5 s), frame intervals while zooming and panning (16 ms median, 33 ms 95th),
workspace switch (300 ms). Actuals go to `<scratch>/long-history.json`; it fails only beyond 3× a budget.

## Not covered

- Pixel geometry (the basis grammar's caps, hatches, brackets): the table carries the same words; the
  canvas is checked by the unit tests in `test/timeline-render.test.mjs`.
- The loading, empty, filtered and disconnected states (X23): they have a proof page
  (`/src/timeline/dev/timeline-states.html`); provoking them against a real observer needs stopping it
  mid-test, which this suite does not do.
- `at=` written by the app: the address carries `at` only while the playhead is held; (14c) accepts an
  event id in its place.

## Result of the run as it stands

Run on 2026-11-13 against the working tree mid-round-4 (`E2E_LARGE=1 pnpm run test:e2e:timeline`, headless
Chromium, Apple silicon): 32 tests, 30 pass, 2 fail, 3 min 40 s. Every process stopped afterwards; nothing
left listening on 4235-4249.

| File | Test | Result | Waits on |
|---|---|---|---|
| synthetic | hooks | pass | |
| synthetic | (1) concurrent cells | pass | |
| synthetic | (2) nested workflow and agents | pass | |
| synthetic | (3) count-only agents | pass | |
| synthetic | (4) failure then remediation, retries ladder | pass | |
| synthetic | (4b) the failed visit is the inspector's subject | pass | |
| synthetic | (5) review rounds, seats, verdicts | pass | |
| synthetic | (6) person-wait resolved and open | pass | |
| synthetic | (7) dependency-blocked | **fail**: SLICE-013 (blocked to the end, never given a cell) is not in the product tree at all; the waits lens shows it | new finding: a slice with no cell |
| synthetic | (8) interrupted, recovered, unknown outcome | **fail**: the interrupted execution reads "took 6 min 48 s, failed" and does not say interrupted; under it the workflow and 5 agents still read "running for 36 h"; under the unknown-outcome execution the workflow and agents read running | design 5 (interrupted never "took"); T1 (the bounded end must bound the visits, workflow and agents under it) |
| synthetic | (9) the gap | pass | |
| synthetic | (11) open spans | pass | |
| synthetic | (12) bounded and inferred wording | pass | |
| synthetic | (15) scrubbed back | pass | |
| synthetic | API GET-only, console | pass | |
| live | (10) late events in a past window | pass (failed once before T5 landed; passes now) | |
| live | live edge advancing | pass | |
| live | (13) restart, no duplicates | pass | |
| live | API GET-only, console | pass | |
| real run | (14a)-(14d) cross-view, deep links, X4 | pass | |
| real run | (17a) reduced motion, (17b) keyboard only | pass | |
| real run | (18) Factory Floor, health unchanged, no file changed | pass | |
| long history | (16) first paint 588 ms (1.5 s); zoom and pan frames 16.7 ms median, 17.2 ms 95th (16 / 33); switch 289, 322, 313 ms (300); observer caught up in 27 s | pass (the switch is just over budget; within 3×) | |

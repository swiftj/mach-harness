# MACH Next M6.5: Factory Analytics — completion report

Branch `feature/mach-next-m6-5-factory-analytics`, cut from `main` at `b37c036` (the M6.3 merge). Pushed; not
merged. M6.6 and the Evidence Theater were not started.

Companion documents: `M6_5_DESIGN.md` (assessment, API contract, provenance, rules), `M6_5_SECURITY.md`,
`M6_5_TESTING.md`, `M6_5_ACCESSIBILITY.md`, `M6_5_PERFORMANCE.md`, `M6_5_CAPTURES.md`.

## 1. Branch and commits

| Commit | What |
|---|---|
| `7a8b48e` | execution provenance recorded when the supervisor starts an execution; a test-only fix for two timing-dependent supervisor tests |
| `23f0aea` | the observer's Analytics read API: the metric engine extended, flow, contributors, runs, insights, the as-of filter, security fixes, synthetic histories, scenario and parity tests |
| `2ed2020` | contributor lists for more figures, exact wait totals, per-source freshness |
| `a1ae5d5` | the Analytics workspace, its data layer, the shell's third workspace, browser tests, audit and measurement scripts |
| `de1ec9b` | `CLAUDE.md` |
| `6a5caee` | the observer's adaptive memory limit, smaller metric cells, the realistic synthetic profile |
| `e76a0d6` | one cursor shared by views, opportunity populations, chart keys, polish, performance, accessibility and testing documents |
| `8cfddaa` | the defects found by the acceptance captures |
| the commit after it | the confirmation round's remaining defects, the peak of executions on recorded ends, this report |

About 50,000 lines added in 218 files against the baseline. Later commits, if any, are listed by `git log`.

## 2. What existed and what is new

**Existed at the baseline.** An incremental metric engine in the observer (47 catalogued metrics, 35 returning a
value), two routes (`/api/v1/analytics/metrics`, `/analytics/runs`) answering at the head only, with one
grouping and a per-day period. No analytics in the Control Tower.

**New.** Time windows, a "last N runs" population, cursors, two-way grouping, day and week trend buckets,
distributions, basis counts and coverage on every metric; flow, bottleneck, contributor and insight routes; an
as-of time filter; execution provenance; the Analytics workspace with seven areas; comparison by risk, app type,
period and execution configuration; drill-down to the rows behind a figure and navigation to and from the floor
and the Timeline.

No second metric engine was created.

## 3. Metric definitions and catalog changes

No catalog ID was renamed or redefined. After M6.5: 34 metrics available, 8 partial with a stated reason (W1,
W2b, Q1, S6, Q4, R2, S4, S5), 3 deferred (T3, C5, R4), 3 not recorded (K5, K6, G4).

Changes of fact in `M6_1_SHARED_CONTRACTS.md`: K6 is marked not recorded (the catalog said available; it was
never computed); section 4.5 names the implemented route and its parameters.

Clarifications recorded in `M6_5_DESIGN.md` 3.1, each fixing a defect the audit or the scenario tests found:

- C2 and K4 count each ticket once within the window (K4 had counted numerator and denominator twice).
- C4 and W2 run from the first time the current slice revision became eligible; a reissue at the same revision
  does not restart it.
- S2 counts executions whose outcome is unknown, not recovery events.
- K1, K2 and K3 coverage counts executions; an execution with no cost or no usage record is excluded with a
  reason.
- T1 and R2 disclose members known only from run records (no merge, or no review finding, in the lifecycle log).
- Durations: statistics cover measured spans; bounded, inferred, open and unknown spans are counted apart.
- Percentiles are exact while the cells read hold every measured value (up to 512 per cell), and otherwise are
  interpolated within a histogram bucket and served with the bucket's bounds.
- Grouping by risk, app type and wave uses the ticket's classification as known at the cursor, so results do not
  depend on the order events arrive.

On screen T2 is labelled "Slices integrated"; its catalog name, "Accepted delivery", is shown in its definition.
Integration is shown apart from product acceptance, which MACH does not record.

## 4. Projection and API

All GET, loopback, behind the session, under `/api/v1/analytics/`: `metrics`, `flow`, `contributors`, `runs`,
`insights`. Common parameters: `at` (a cursor: all charts of one view describe one state of the projection),
`from_ms`/`to_ms` (widened to whole UTC days, the effective window stated), `last_runs`, `as_of_ms`, filters.
An unknown parameter is a 400. Every reply carries the cursor, the projection's versions, the window, the
filters, the history's first event, gaps and per-source freshness. Field-by-field: `M6_5_DESIGN.md` section 3.

`as_of_ms` is a time filter. Flow, contributor lists and runs are cut exactly at the time. Metrics and insights
are kept per UTC day and answer through the last whole day before it; every such figure says so.

Contributor lists carry identifiers, codes and numbers only.

## 5. Incremental aggregation

Metric cells are mergeable (count, sum, min, max, a log histogram, up to 512 measured values, coverage), keyed by
UTC day and by the dimension values an event carries; ticket-scoped facts are keyed by ticket and joined to the
ticket's classification at read time. They are folded as each event is applied, saved with the projection and
rebuilt by replay when the definitions version changes (now 4). A read merges the cells it selects and never
rescans events. A metric keeps at most 20,000 cells; beyond that events go to a per-day overflow cell so totals
stay exact. The flow index is built once per projection position from the spans (about 11 ms on a 220,000-event
history) as per-day cells; waits the projection stops keeping one by one are folded into those cells as they are
dropped. Late events are applied when they arrive; a conflict gap marks its buckets suspect. A test asserts that
200 syncs with no new event do no projection work.

## 6. Experiences implemented

One workspace (`#analytics`, key `4`) with shared window and filters:

- **Factory Pulse**: a written lead, the delivery trend, the ladder from executions completed to "Accepted by
  product: Not recorded", what stands out, four panels (flow, quality, recorded cost, reliability) and data
  coverage and freshness.
- **Flow and bottlenecks**: the Factory Flow drawing of recorded moves between stations with revise loops; a
  station's visits, distribution and slowest visits; the ranking by total measured time; waits by kind; work in
  parallel against the recorded limit.
- **Quality and remediation**: verification outcomes, first pass against remediated, judging rounds, failure
  kinds, blockers by rule, remediation paths, quality beside recorded cost, the observe scorecard with targets.
- **Agent and model economics**: recorded cost and tokens over time, model usage, execution cost distribution,
  cost beside delivery, agent duration, queue and tool-call counts. No cost is attributed to an agent or station.
- **Reliability and autonomy**: how executions ended, kept apart by kind; gates and tools; where a person
  stepped in.
- **Compare**: two cohorts by risk, app type, period or execution configuration, with sample sizes,
  distributions and wording that names no cause.
- **Improvement opportunities**: section 10.

Every figure shows its sample and coverage, opens its definition, and opens the rows behind it. A missing value is
drawn as not recorded or not available with the reason. Below documented minimum samples the areas show "k of n"
and leave out verdicts, percentiles, trends and comparison wording.

## 7. Screenshots and recordings

In the git-ignored `web/apps/control-tower/screenshots/analytics/final/` and
`recordings/analytics/final/`: 104 screenshots (99 a live observer reading synthetic projects, named `syn-`; 3
Historical replay; 2 Simulated), three contact sheets and four recordings, made at `e76a0d6`. `M6_5_CAPTURES.md`
lists each file, the figure-against-API comparisons, the privacy and request checks, and the defects the set
exposed.

The set was made before those defects were fixed, so its frames still show them. It exposed five must-fix
defects (medians shown as histogram bucket edges, review blockers read as none, a false missing-usage notice, a
visit not scrolled into view in the Timeline, two bases side by side in a replay) and fourteen lesser ones. A
confirmation round on `8cfddaa` (36 `confirm-` frames and a re-recorded investigation) found three of the five
fixed, two not, and two new ones (a "7 days" preset showing nine days; executions reading above the recorded
limit). Those were fixed in the last commit and checked by the agent that fixed them, with captures in
`screenshots/analytics/live/`; no further independent capture round was made. The whole set was not retaken.

No capture was made from a real Factory run: every history in this milestone is synthetic or simulated, and is
labelled so.

## 8. Cross-run comparison

By risk, app type, time period, and execution configuration (`config_id`). Executions with no recorded
provenance form their own cohort, and so do runs whose executions recorded more than one configuration; neither
is merged into another. Two cohorts are read at the same cursor. Shares are shown within each cohort with its n;
unequal samples are stated; a comparison below its minimum sample shows the observations without comparison
wording.

Not offered, because no trustworthy metadata exists: comparison by skill or workflow revision on its own (it is
part of `config_id`, not a separate dimension), and by concurrency setting alone.

## 9. Configuration provenance

`skills/run/scripts/provenance.py`, called once from `supervisor.py` `start()` after authorization has passed.
The supervisor change is an import guard, one call and the attachment of the result to the claim record and the
`execution.started` event. The snapshot holds digests, versions and identifiers only: MACH's version and commit,
a SHA-256 per skill, agent and workflow file, the configured model tiers, review thresholds, the concurrency
limit, the policy mode, a digest of the whole configuration file, a digest of the allowed-tool list, the ticket's
risk and app type at start, the source revision, and `config_id`.

A failed or missing capture records `provenance: null` with a reason, and the execution starts exactly as
before; tests hold that the claim record and every other file are byte-identical apart from the added field. An
independent review tried to refute those claims; its five findings were fixed.

Limits: the files are recorded as they were on disk at start, and skills are loaded during the run; `mach.commit`
may be the HEAD of a tree with uncommitted changes (the file digests are the record); executions from before
this change read as not recorded and nothing is attributed to them afterwards; metrics cannot be filtered by
provenance (runs and executions can).

## 10. Improvement Opportunity rules

Deterministic, advisory, read-only; pure functions of metric results. Seventeen rules across flow, quality,
reliability, economics and data quality, each with a stable ID, a threshold and a minimum sample
(`M6_5_DESIGN.md` section 6). A rule that cannot run is listed as not evaluated with the reason. Each finding
carries its condition, measurements, sample and coverage, window, filters, why it may deserve attention, a
possible investigation, and a query for the rows behind it in the finding's own population. All wording comes
from one template file, and a test scans it for causal and gate-weakening words.

The scorecard rules use the observe station's targets and populations exactly. The other thresholds (for
example a station holding 35% of measured station time, a wait whose 90th percentile is 8 hours) are this
milestone's choices and are for the product owner to adjust.

## 11. Cross-view integration

Analytics keeps only its interface state in the scene store; selection, focus and playhead stay the store's. A
row opens its entity in the Timeline with the measured interval as the window and its row scrolled into view, or
on the floor. From a station on the floor, "Open its measured history" opens Flow for that station; from a
refused review or failed verification in the Timeline, "See how often this recurs" opens Quality. Switching
workspace, changing area and drilling down add a history entry, so Back returns to Analytics with its area,
window, filters and open drawer. Atlas, Blueprint and Timeline addresses and keys are unchanged. Playback keys do
nothing in Analytics.

Analytics states what its figures describe: the complete recorded history, a selected window, or through the
playhead in a replay.

Evidence: a row for a verification outcome or reviewer decision opens in the Timeline, whose inspector gives the
existing guarded artifact access. Analytics fetches no artifact content. The Evidence Theater was not built.

## 12. Observe-station parity

`tests/test_mach_analytics_parity.py` runs `observe.py`'s scorecard and the observer on the same data. On the
synthetic projects all six shared metrics (Q3, Q2, R5, R6, G1, G2) agree over every record and with
`last_runs=20`, observe's default population. One documented difference remains: a run record whose ticket ID is
unusable is kept by observe and counted as excluded by the observer.

Window semantics: Analytics defaults to the complete recorded history; observe uses the last 20 finished runs.
Both are offered and each figure states its population.

## 13. Test results

On the final commit, run by the lead on a quiet machine unless stated:

| Suite | Result |
|---|---|
| Python (`make test`) | 630 pass, 1 skipped (run at `23f0aea`; no Python changed afterwards) |
| Go observer (`go vet`, `go test ./...`) | all packages pass, including 30 hand-calculated scenario tests |
| Web lint, typecheck, build | pass |
| Control Tower unit tests | 602 pass |
| Observe parity, Tower guard | 15 pass, 1 skipped |
| Analytics browser suite (run by an agent, before the last fix round) | 29 pass, 2 skipped, 0 failed, of 31; one skip was a test that did not recognise a reworded caption and passes after its update, the other is deliberate |

The scenario suite covers the twenty cases of the brief, six comparison cases and an invariance test (arrival
order, duplicate delivery, a restart mid-ingest). It found seven engine defects, all fixed.

## 14. Accessibility and performance

Accessibility (`M6_5_ACCESSIBILITY.md`): the audit passes in the proof, Shell and live modes (0 axe violations, keyboard
walk, target sizes with table equivalents, contrast, colour independence, reduced motion). Not done: a
screen-reader session, browsers other than Chromium, 400% reflow and text spacing. No conformance is claimed.

Performance (`M6_5_PERFORMANCE.md`), realistic history of about 250,000 events, against the M6.3 observer:
interface and queries are within budget (first render 630 ms; warm queries 8.9 ms median, 25 ms at the 95th
percentile). The observer's idle CPU, per-event CPU and restart time, which had regressed because the heap had
reached a fixed memory limit, are back at the M6.3 level after the limit was made adaptive. The observer holds
more memory than M6.3 (about 280–335 MB against 180–273 MB idle, by run). "All metrics, warm" takes about 9 ms
against 0.6 ms.

## 15. Security and privacy

`M6_5_SECURITY.md`. Fixed: evidence files with credential-shaped names were catalogued and their names served;
files named for credentials were served as text. R1 (a person's name appearing only in prose) remains open by
decision and reaches further than M6.2 recorded: it also applies to fifteen event fields. Those fields are
declared, labelled as unchecked for names, and reach the Analytics UI only through one component that shows them
as plain truncated text and keeps them out of URLs. Redaction of names in free text is not claimed.

The observer remains read-only, loopback-only and GET-only, with no outbound connection.

## 16. Data coverage and telemetry gaps

Not recorded by MACH, and shown as such: product acceptance of a delivered slice; cost per agent, station or
tool; token kinds per agent; usage for hand-driven work; deviation types; the reviewer seat on a rejection; when
a source's records were written, beyond their own timestamps. Lifecycle lines have no identity beyond their line
number, so a repeated gate or build-task line counts twice.

## 17. Remaining limitations

- No real Factory run was used. Everything was checked on synthetic and simulated histories.
- Metrics in a replay lag by up to a day (they run through the last whole UTC day before the playhead).
- Open counts in metrics are not available as of a time.
- Metrics cannot be filtered by model beyond the cost and token metrics, or by provenance.
- The observer's memory limit has a fixed 2 GB ceiling; it does not read physical memory.
- Two wordings were never seen on screen and are covered by unit tests only: a histogram-based percentile shown
  as "about …" with its bounds (no test history was large enough to leave the exact path), and executions "up to
  N" above the peak on recorded ends.
- The brush on the large history measured 264 ms against a 200 ms budget in one run on a loaded machine and was
  not re-measured. The performance figures were taken before two corrections to the synthetic generator.
- The Analytics trend charts keep their own day labels rather than the Timeline's ruler; only the
  work-in-parallel panel uses it.
- One Control Tower unit test failed once under load and passed on every rerun; it was not traced.
- The remaining visual and wording items are listed in `M6_5_CAPTURES.md`.

## 18. M6.6 readiness

Ready to build on: one metric engine with a versioned read API, a scenario suite that fixes its semantics, a
workspace that shares selection, navigation and deep links with the floor and the Timeline, and audit and
measurement scripts that can be re-run.

For M6.6 to take up: a real supervised run through Analytics; the items in section 17; the Timeline's ruler
vocabulary on every Analytics time chart; a screen-reader pass; and the product owner's review of the rule
thresholds.

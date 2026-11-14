# MACH Next M6.5: Factory Analytics — assessment and contract

Status: in progress. Baseline `b37c036` (the M6.3 merge). This file is the working contract between the observer
and the Analytics workspace; it is extended as increments land.

## 1. What existed at the baseline

Baseline suites at `b37c036`: Python 606 pass; Go observer 14 packages pass; web lint, typecheck and build pass;
Control Tower unit tests 489 pass.

**Metric engine.** The observer already has one: `apps/observer/internal/metrics` keeps mergeable aggregate cells
(count, sum, min, max, a 64-bucket log histogram, coverage), folded incrementally by
`internal/project/reduce.go` as each event is applied, saved with the projection and rebuilt by replay when the
definitions or format version change. M6.5 extends this engine. There is no second one.

**Catalog coverage** (`M6_1_SHARED_CONTRACTS.md`, families T C W Q R X S K G, 47 metrics): 35 return a value;
T3, C5 and R4 are deferred; K5 and G4 are not recorded; K6 is marked available in the catalog but not computed;
8 work only in part.

**Read API at the baseline.** `GET /api/v1/analytics/metrics?ids=&group_by=` and `/api/v1/analytics/runs`.
Head only: no time window, no cursor, one `group_by`, the only period is the UTC day of the closing event, and an
unknown parameter is silently accepted. (The catalog's section 4.5 names `/api/v1/metrics`; the implemented route
is `/api/v1/analytics/metrics` and stays.)

**Defects found by the audit, fixed in M6.5.3**

| Metric | Defect |
|---|---|
| K4 | numerator and denominator both counted twice (the ratio happened to be right) |
| X3 by gate, S1 by kind, K3 by token kind | grouped value always null: the denominator is never written into the group |
| C2 by station | returns no groups |
| K6 | catalogued as available, not computed |
| durations (C, W) | only spans with both ends exact are counted; bounded, inferred and open spans are dropped without being counted |
| coverage | tracked for K1 only |
| late events | a conflict gap marks no bucket as suspect (catalog 4.5 asks for it) |

**Parity with the observe station.** The observer's copies of the scorecard metrics did not match
`skills/observe/scripts/observe.py`:

| Difference | observe.py | observer at baseline | M6.5 |
|---|---|---|---|
| population | last 20 runs by `closed_at` | every run recorded | both offered: `last_runs=N` reproduces observe; a time window is the Analytics default. Stated on every figure |
| a run with no `outcome` | neither merged nor abandoned | merged | follows observe |
| rounding | 3 places, Python banker's rounding on ties | half-up | the API serves numerator and denominator and the unrounded value; display rounding follows observe |
| target met | decided on the unrounded value | on the rounded value | follows observe |
| ticket IDs | any non-empty ID | must match the observer's pattern | rejected records are counted in coverage, never silently dropped |
| unknown risk or app type | grouped as unknown | no group | an explicit `unknown` group |

**Cost on a 220,000-event history** (baseline): all 47 metrics warm about 1 ms; restart with a saved projection
6.0 s; cold start with no index 35.6 s and 242 MB.

**What is recorded when an execution starts.** Workflow name, limits, attempt, stage at start, runner ID; later
from the stream, the Claude Code version, main model and permission mode. Not recorded per execution: MACH
version or commit, skill and workflow digests, configured model tiers, review thresholds, policy snapshot, risk
and app type at start. Section 5 adds a provenance snapshot.

**Cost and tokens.** Per execution: the supervisor's recorded cost and the stream's total with a completeness
flag. Per execution and model: cost and four token kinds. Per agent: one token total, a tool-call count, a
duration. Not attributable, and never derived: cost per agent, station or tool; token kinds per agent.

**Frontend.** No charting library; charts are hand-written SVG and canvas. The shell assumed exactly two
workspaces. The client had no analytics methods. The built-in simulation merges three tickets, so Analytics has
its own seeded fixture, labelled Simulated.

**Security.** R1 (a person's name appearing only in prose) is open by decision: such content is labelled
unchecked, not withheld. See `M6_5_SECURITY.md`.

## 2. Rules every figure obeys

1. A catalog ID is never renamed or redefined.
2. Missing is not zero. A rate with an empty denominator has no value (`value: null`, with the reason).
3. `measured`, `bounded`, `inferred`, `open`, `unknown` and `not-recorded` are counted apart. A duration statistic
   is computed over `measured` spans only unless a query asks for another basis by name; the others are reported
   as counts (and bounds, where known) beside it.
4. Every figure carries: sample count, numerator and denominator, unit, window, coverage (eligible, counted, and
   why the rest was not), source records, limitations, and the cursor it was read at.
5. Recorded cost only. No allocation of cost to agents or stations.
6. Unique tickets, slices, waves, station visits, execution attempts, judging rounds and reviewer seats are
   distinct populations; each metric names its own.

## 3. Read API (all GET, loopback, behind the session; `/api/v1/analytics/...`)

Common query parameters:

| Parameter | Meaning |
|---|---|
| `at` | a cursor from a previous analytics response. All charts of one view pass the same cursor so they describe one state of the projection. Omitted: the head. |
| `from_ms`, `to_ms` | time window. Metric cells are kept per UTC day, so a window is widened to whole days; the response states the effective window. |
| `last_runs` | the last N finished runs by `closed_at` (the observe station's population). Exclusive with a time window. |
| `risk`, `app_type`, `model`, `station`, `wave`, `outcome`, `provenance` | filters, where the metric supports the dimension; a filter a metric cannot honour makes that metric `unavailable` with the reason, never silently unfiltered |

An unknown parameter or value is a 400 with the reason.

Every response carries `{ "cursor", "projection": {format, definitions}, "generated_ms", "window": {from_ms,
to_ms, effective_from_ms, effective_to_ms, last_runs}, "filters", "history": {complete, from_ms, gaps} }`.

### 3.1 `metrics`

`?ids=T1,C1&group_by=station,risk&bucket=day|week&distribution=1`, plus the common parameters. Any other parameter,
a repeated one, more than two `group_by` dimensions, the same dimension twice, `bucket` other than `day` or `week`,
or `distribution` other than `0` or `1` is a 400.

**Reply.** The common envelope, plus `metrics`, `definitions_version`, `group_overflow`, `partial`, `suspect_days`
and `rules`.

**Per metric, as served.** The fields served before M6.5 keep their names and meaning; M6.5 adds names beside
them rather than changing a type.

| Field | Meaning |
|---|---|
| `id`, `name`, `kind` (rate, mean, count, duration), `unit`, `numerator`, `denominator` (the catalog's words), `dimensions`, `source`, `authority`, `limitations`, `availability` (M6.1's yes, lifecycle, stream, no), `target` (text such as `< 1.3`), `parity_with` | the catalog entry |
| `family`, `description`, `formula`, `sources`, `population` | added: the family letter, the formula in words, the source list, the population the denominator counts (with `last_runs`: "… among the last N finished runs by closed_at") |
| `status` (`available`, `partial`, `deferred`, `not-recorded`, `unavailable`), `status_reason` | how this observer's value stands against the catalog; `unavailable` when a filter or `last_runs` cannot be honoured |
| `value` | unrounded: num / den, the count, or the mean of measured durations |
| `value_rounded` | observe.py's `round(value, 3)` (Python's correctly rounded decimal, ties to even), for rates and means |
| `numerator_value`, `denominator_value`, `sample_count` | what the value stands on |
| `basis` | one word, as before: `measured`, or `inferred` for reconstructed authority (W2b, R2, G3), `unknown` or `not-recorded` for metrics without a value |
| `basis_counts` | `{measured, bounded, inferred, open, unknown, not_recorded}`. Durations are averaged over measured spans only; the others are counted here and never averaged. `open` is null where it cannot be attributed (under a filter; it is kept by start day only) |
| `bounds` | `{min_ms, max_ms}` over the bounded spans |
| `coverage` | `{eligible, counted, excluded: [{reason, count}]}`, with `covered`, `of`, `share` as before (`covered` = counted, `of` = eligible). Excluded reasons include bounded, unknown and open spans, members with no recorded value, and source records the observer refused (unreadable lines, unusable ticket IDs; not attributable under a filter, which `limitations` then says) |
| `met`, `target_check` | `{value, direction (below, above), met}`, decided on the unrounded value |
| `group_by`, `group_dims`, `groups` | `groups` is null when nothing is grouped, `[]` when grouped and empty. Each group: `key` (the value; two dimensions `a|b`), `keys` ({dimension: value}), and the figure fields (`value`, `numerator`, `denominator`, `value_rounded`, `sample_count`, `basis_counts`, `bounds`, `coverage`, `met`, `distribution`). A member with no value for a dimension is the group `unknown`; cells past the 20,000-per-metric limit are the group `overflow`. At most 2,000 groups are served (`groups_omitted`) |
| `groups_reason` | a group dimension the metric does not record: the metric keeps its value and `groups` is `[]` |
| `buckets` | every day or week (Monday, UTC) of the window, each `{period, from_ms, to_ms, suspect, …figure}`; a period with nothing recorded is null, never 0 |
| `suspect` | the window holds a `history.gap` conflict (the bucket's own `suspect` likewise) |
| `distribution` | durations only: `{p10, p25, p50, p75, p90, min, max, histogram: [{ge_ms, le_ms, count}], percentile_basis: "histogram", percentile_bounds, over: "measured durations only"}`. A percentile is the upper bound of the histogram bucket holding it, clamped to the observed minimum and maximum |

**Days.** Cells are kept per UTC day of the event that closes or counts the member: C1 uses the day of the visit's
`station.exited`, so a visit crossing midnight counts on its exit day. `flow` attributes a visit to the day it
began, so the two can differ at a window's edge. Open members are kept by the day they started.

**Ticket dimensions at the cursor.** Risk, app type and wave are not written into a ticket's cells; a read joins
the ticket's values as the projection knows them at the cursor read. A ticket's figures therefore do not split by
when its classification became known, do not depend on the order events arrived in, and agree with `flow`. An
`at` cursor answers with the values as of that cursor. Run-record metrics (Q2, Q3, R5, R6, G1, G2) use the run
record's own risk and app type, as observe.py does. Cells past the per-metric limit lose their ticket and read as
`unknown`.

**Definition notes.** C1 counts each visit by the visit span's own classification (the same function `flow` and
`contributors` use): measured, bounded or unknown from its recorded entry and exit; inferred when no record ends
it but a later record bounds it (its execution ended, the station was entered again, or only cleanup closed it);
open otherwise. A visit known only by its exit is a visit (C2) of unknown length (C1). A visit whose recorded exit
came after something had already ended it (its execution ended, the station was entered again) was not continuous
work (M6.6): it is bounded (at least to that earlier end, at most to the exit), counted apart, never measured. C4 and W2 measure
eligibility from the first time the slice's current revision became eligible: a reissue of the same revision to
another ticket does not restart it, a new revision does. W1 counts open dependency waits under `open`. S2 counts
executions whose outcome is unknown by the state every view serves (an execution whose process recorded how it
stopped is not unknown, whatever recoveries follow), once per execution. K1's population is every claimed
execution: those with `execution.failed` are excluded as "failed: the Factory's record of a failed execution
carries no cost", those with neither as "no result yet, or outcome unknown", those completed without a cost as such
(M6.6: two truthful reasons; the definition is unchanged). A failed execution's own stream result may carry a cost
(served by `/api/v1/runs` and in K2); it is not part of K1 or K4. T1 counts merges written in lifecycle logs; a ticket its run record says merged with no merge in its
log is in T1's coverage as excluded ("no merge in the lifecycle log"), never in the count. C2's denominator is the distinct tickets that recorded a visit in the window (grouped by
station: the tickets that visited that station). K4's denominator is the distinct tickets with a recorded cost in
the window, and its numerator only the cost recorded in the window. X3 by gate, S1 by kind and K3 by token kind
divide their own numerator by the whole population (every build task, execution claimed, execution that used the
model).

**`partial`, with the reason served:**

| Id | Reason |
|---|---|
| W1 | the denominator is closed waits, not slices |
| W2b | the denominator is closed waits, not tickets |
| Q1 | the denominator is round-1 verification verdicts, not tickets |
| Q4 | a count only: failed verifications and observe's `finding_kind` are not computed |
| R2 | a count only: rounds are not computed |
| S4 | a count of events only: tickets executed and the grouping by reason are not computed |
| S5 | a count only: executions are not computed |
| S6 | the denominator is workflows finished, not started |

T3, C5 and R4 are `deferred`; K5, K6 and G4 are `not-recorded`. K6 is not recorded because the version 3 contract
does not forward the stream result's turns or duration.

**Dimensions not added**, with the reason:

| Dimension | Reason |
|---|---|
| `project` | one observer serves one project |
| `slice` | not kept on metric cells |
| W2 `writer` | not known when a slice is dispatched |
| R1 `seat` | a decision belongs to the round, not one seat's vote |
| G2 deviation type | the observer keeps a count per run |
| S4 reason, Q4 `finding_kind` | not computed |
| `provenance` | not recorded yet (section 5): any metric filtered by it is `unavailable` |
| `wave` | kept only on T1, T2, C3, C4, W1 and W2, where the catalog lists it |

**`last_runs`.** Answered for Q2, Q3, R5, R6, G1 and G2 from the run records with observe.py's population (the last
N by `closed_at`, ties in record order, unreadable times the oldest); every other metric is `unavailable`. Run
records with an unusable ticket ID are refused and counted in coverage, so where observe keeps such a record the
populations differ by it. The sort is to the millisecond, where Python sorts to the microsecond.

**Percentiles.** Every route reads percentiles through one function (`metrics.Percentile`), so the metrics route,
`flow` and the insights cannot disagree for the same population. A cell keeps its measured durations up to 512; while
every cell read holds all of its values the percentile is exact (nearest rank: the value at ceil(q × n);
`percentile_basis: "exact"`). Beyond that it is read from the log histogram, interpolated inside the bucket that holds
the rank and clamped to the observed minimum and maximum, with `percentile_basis: "histogram"` and the bucket's
bounds (`p50_bounds_ms`, `p90_bounds_ms`; `distribution.percentile_bounds`), so a screen says "between X and Y".

**R2 and run-record blockers.** R2 counts blocker findings read from review vote files. Blockers a ticket's run record
counts beyond the findings read for it are in R2's coverage as excluded ("blockers counted in the run record with no
review finding in the lifecycle"), never added; with no finding at all the value is null with its reason. The same
holds for any count metric whose members are known only from exclusions (T1 too).

**Usage coverage (K2, K3).** The coverage counts completed executions (`coverage.unit`): counted are those with a usage
record from the stream, excluded those without. K2's per-pair exclusion (a model's usage with no cost) is reported
beside it in `coverage.other`, in its own unit, and is not part of eligible = counted + excluded.

**A playhead (`as_of_ms`).** Metric cells are per UTC day and cannot be cut inside a day, so with `as_of_ms` every figure
of the reply ends at the midnight at or before it and says so on the figure: `as_of {ms, exact: false,
effective_to_ms, rule}`. `last_runs` with `as_of_ms` is cut at the same midnight. Open members are kept by start day and
cannot be cut there: `basis_counts.open` is null under `as_of_ms`. A route that answers exactly at the playhead says
`exact: true` in its envelope; a view must not put the two side by side unlabelled.

**S2 on generated histories.** S2 counts executions whose state is unknown (D5): an execution whose process recorded how
it stopped is interrupted whatever recovery follows; the supervisor records outcome-unknown only when there is no
process result. The synthetic generator's "outcome unknown" executions also write a process result (`ended:
interrupted`), so S2 is 0 there, correctly; the generator is to stop writing that result.

**Whole recorded history.** With no `from_ms`/`to_ms` every day up to the last event is included; a client that wants
the complete history sends no window (a `to_ms` is exclusive and widened to whole days).

**Limitation: repeated lifecycle lines.** Lifecycle events are identified by line, so a repeated line counts again.
Visit exits, agent finishes and execution ends are counted once per member. A repeated `gate.evaluated` or
`build.task_completed` line still counts twice: there is no cheap content identity to deduplicate it.

### 3.2 `flow`

Stations and the transitions the lifecycle records. Per station: visits, unique tickets, duration distribution by
basis, revise entries, gate refusals and overrides, waits before it by kind, open visits. Per transition: `from,
to, count, tickets` (a count of recorded consecutive visits, not a trajectory). Plus the bottleneck ranking:
`total measured delay`, `visits`, `tickets delayed`, `median`, `p90`, ranked by total measured time with the
volume beside it.

### 3.3 `contributors`

`?metric=C1&group=station:verify&order=impact|recent&limit=` → the entities behind a figure: `[{ref, ticket,
cell, execution, value, unit, basis, at_ms, from_ms, to_ms, risk, app_type}]`, refs in the existing entity-ref
grammar so they open on the floor or in the Timeline. Bounded (`limit` ≤ 500, `truncated`, `total`). No free text.

### 3.4 `runs`

The existing listing, extended: window and filters as above, paging, `provenance` per execution (section 5) and
`usage: {recorded, complete, sources}`.

### 3.5 `insights`

Deterministic rules over the same cells (section 6). Each: `rule, condition, measurements: [{metric, value,
sample_count, coverage}], window, filters, why, investigation, contributors (a `contributors` query), severity:
"attention" | "note"`. A rule that lacks its minimum sample returns nothing.

## 4. Workspace

A third workspace, `analytics` (key `4`, hash `#analytics?area=&win=&risk=&app=&model=&station=&sel=&cmp=`),
beside `floor` and `timeline`. Selection, focus and navigation stay the scene store's; Analytics keeps only its
interface state (`store.analytics`: area, window, filters, comparison) there. Areas: Pulse, Flow, Quality,
Economics, Reliability, Compare, with Improvement Opportunities on Pulse and in its own list.

Analytics states which history it describes: the complete recorded history, a selected window, or the history up
to the playhead when it is held behind the live edge (every query asks `as_of_ms`; nothing later is shown).

Changed in M6.6 (Phase 2):
- **Day cut in words (I-07, I-08).** Metrics and insights count whole UTC days before the playhead. The caption names
  the last whole day counted and the playhead apart ("Counted through the end of 3 Nov (UTC) … The playhead is at
  4 Nov 14:20:05 UTC; the part of 4 Nov before it is not in these figures"), says the flow drawing and the rows run to
  the playhead itself, and each such figure carries "to end of 3 Nov". No formula changed.
- **No widening (I-32).** Against an observer without `as_of_ms`, counted figures (metrics, flow, insights) are not
  available as of the playhead (`AS_OF_UNSUPPORTED`); lists are still cut at the playhead client-side.
- **Source and link (I-02).** The header says the store's `playbackLabel` ("Live Factory (stale)", "Historical
  replay"); a stale, unreachable or session-less observer shows the floor's own stage notice, floating at the foot.
- **Incomplete history (I-03).** `history.partial`, `history.gaps` and `suspect_days` are one line over each area, in
  the Timeline's words ("History is missing here: …"), and a suspect figure says "history incomplete here".
- **Back to live (I-13).** While held at the playhead the header offers "Back to live" (replay: "Go to its last
  event"), and L and End do the same in Analytics. The freshness read time (the observer's clock now) is not shown
  under a playhead (I-39).
- **One cut per view (real-run D1).** A reply's identity includes its "as of" cut (cache key and a check on every
  reply, `sameCut`); a reply of another cut never fills a panel, and Analytics waits for a moment named in the address
  instead of reading the whole history first.
- **No whole day yet (real-run D4).** Held on the history's first UTC day, the window is the playhead's day up to the
  playhead (never inverted) and the caption says "No whole UTC day is complete before the playhead; day-counted figures
  are not available."
- **One time vocabulary (I-09, I-10, I-11).** Durations everywhere use the shell's formatter (`shell/time.ts
  duration`: "48 s", "4 min 12 s", "1 h 3 min", "1 h", "1 d 15 h"); Analytics no longer rounds to whole minutes past
  10 min. Moments read "4 Nov, 09:29:43 UTC". Basis words are the Timeline's: measured, bounded, inferred (placed by
  rule), open, unknown, not recorded. Trend columns take the Timeline ruler's ticks and day labels (`scale.ts`).
  The observer's insight templates use the same duration and moment words, and say "choose a dated window" and "the
  recorded limit on executions at once" instead of `from_ms`/`max_parallel`. Wording only: no threshold, formula or id
  changed.
- **Rules in words (I-17).** "Not evaluated" names each rule by its condition, with its id as quiet mono beside it.
- **From the Timeline (I-12, I-14).** A selected station visit offers "Open its measured history": Flow for its
  station over the seven UTC days ending with the visit's day; Flow reads the store's one selection and says where
  the visit sits among that period's measured visits ("between A and B, as this one was"), marking it on the
  histogram. A failed verification or rejected review offers "Show the floor at this moment": the shared playhead
  moves to the decision, then the floor shows it with the selection kept.
- **Back keeps the view (I-15).** Table/Chart toggles, ranking sorts and each area's scroll offset are remembered in
  memory per scene store (codes only, never the address or browser storage), so Back restores them with what the
  address carries.

## 5. Execution provenance

Captured once, when the supervisor starts an execution, after authorization has passed; additive; no effect on
scheduling, authorization or gates. Digests and versions only: MACH version and commit, a digest per skill,
agent and workflow file used by the line, the configured model tiers, the review thresholds, `factory.max_parallel`,
the policy mode and a digest of the allowed-tool list, the ticket's risk tier and app type at start, the source
revision. Older executions have none and are shown as "not recorded"; nothing is attributed after the fact.

As built:
- **Producer**: `skills/run/scripts/provenance.py`, called once from `supervisor.py` `start()` after `authorize()`
  and `executor.plugin()` and before the command is built. The same object goes on the ledger's execution record
  and on `execution.started.data.provenance`. A failure of any kind is `provenance: null, provenance_reason:
  "capture-failed"`, and the execution starts exactly as before (also when `provenance.py` cannot be imported) (`tests/test_mach_provenance.py` compares every
  file `start()` leaves, with and without it, byte for byte). Cost: about 20 ms uncached on MACH's own plugin.
- **Snapshot** (`schema: 1`), as the files were on disk at start: `mach {version, install, commit}` (`commit` is
  the HEAD of MACH's checkout, which may be dirty; the line digest is the record), `line {digest, count, files}` keyed
  `skill:<name>`, `agent:<name>`, `workflow:<name>`, `plugin:manifest`, `config {recorded, digest, models, review
  {max_loops, security_veto, tiers}, max_parallel}` (`digest` covers the whole config file; the rest as configured,
  unset is null, never a default; a model name that is not an identifier is `sha256:<digest>`), `policy
  {autonomy, max_risk, allow_merge, max_parallel, allowed_tools_digest, allowed_tools_count}`, `ticket {risk,
  app_type}`, `source {commit, slice_revision, slice_digest, spec_sha256}`, and `config_id`, the SHA-256 of the
  canonical JSON of `{line digest, config, policy}`. Equal `config_id` means the same MACH files, configured tiers,
  thresholds and policy; compare it, do not interpret it. `mach.commit`, `ticket` and `source` are facts about the
  run and are not part of it.
- **Observer**: event revision 3 (additive: `execution.started` gains `source_commit`, from the intake log's
  envelope, which older executions have too, `provenance` and `provenance_reason`). Normalised field by field
  (`normalize/provenance.go`), allow-listed and scrubbed like every payload. Each execution in `/api/v1/runs` and
  the projection carries `provenance` (or null), `provenance_recorded`, `provenance_reason` (`not-recorded`,
  `capture-failed`, `not-understood`) and `source_commit` (or null). Contract: `M6_1_EVENT_CONTRACT.md` 10.1.1.

## 6. Improvement Opportunities

Deterministic, advisory, read-only. Rules are listed here as they are implemented, each with its minimum sample.
No rule suggests weakening verification, security review or human approval.

As built (M6.5.5): `GET /api/v1/analytics/insights`, the common parameters only (section 3). Code:
`apps/observer/internal/insight` (rules `rules.go`, every word in `templates.go`, inputs `gather.go`) and
`internal/server/analytics_insights.go`.

- **Pure rules over the engine's figures.** `GatherMetrics` reads metric rows (`metrics.Table.Query`) and
  `GatherFlow` the flow report and the contributor lists (`project.FlowIndex`), all at one cursor; `Evaluate` is a
  pure function of them. No model, no randomness, no record text: wording is fixed templates with numbers, IDs and
  fixed labels filled in. A test scans every template for causal or gate-weakening words. Same input, same bytes.
- **Nothing silent.** A rule below its minimum sample, unable to honour a filter (`model`, `outcome`, `provenance`,
  or a metric's own unsupported dimension), or missing a comparison window returns nothing and appears in
  `not_evaluated: [{rule, subject, reason}]`. An empty project returns no finding and every rule in that list.
- **Populations.** Scorecard rules read observe's population: `last_runs` when asked, the window's finished runs
  when a window is asked, otherwise the last 20 finished runs (observe.py's default), stated in each finding.
  With `last_runs` every other rule is not evaluated. Two-window rules compare the asked bounded window with the
  window of the same length just before it, only when both meet the minimum sample and coverage and neither is
  suspect, and only when the earlier window starts at or after `history.from_ms` (the first event the observer
  holds); an earlier window reaching before it, or a history whose start is not known, is `not_evaluated` with that
  reason. They say "higher in the later window", never a trend.
- **Severity** is `attention` (scorecard targets missed, a later window higher in rejections or failed verifications,
  unknown outcomes) or `note`; findings are ordered attention first, then by the table below, then by subject.

| id | condition | threshold | minimum sample | reads |
|---|---|---|---|---|
| `flow.station-time-share` | a station holds a large share of total measured visit time (total, so volume counts; visits stated) | share >= 35% | 20 measured visits, 2 stations measured, 5 at the station; not with a `station` filter | flow stations (C1) |
| `flow.wait-p90` | a wait kind's p90 of measured waits is long | p90 >= 8 h | 5 measured waits of the kind | flow waits (W1, W2, W2b, W3, S4, slice capacity) |
| `flow.wait-share` | a wait inside dispatch-to-merge (execution capacity, human approval, parked for a person) totals a large share of measured C3 | wait total / C3 total >= 25% | 5 measured waits, 5 measured C3 | flow waits, C3 |
| `quality.remediation-share` | visits in round 2 or later hold a large share of measured station time | >= 25% | 20 measured visits with a round, 5 in round >= 2 | C1 by round |
| `scorecard.first-pass` | Q2 misses observe's target | target_check.met false (> 0.85) | 5 merged tickets | Q2 |
| `scorecard.rounds` | Q3 misses observe's target | met false (< 1.3) | 5 merged tickets with rounds | Q3 |
| `scorecard.escalation` | R5 misses observe's target | met false (< 0.05) | 5 finished tickets | R5 |
| `trend.review-rejections` | R1 higher in the later window | later - earlier >= 10 points | bounded window; 10 decided rounds and coverage >= 90% per window; no suspect window | R1 |
| `trend.verification-failures` | refusals of `verify.verdict` higher in the later window | later - earlier >= 10 points | as above, 10 verdicts | X2 filtered gate=verify.verdict |
| `quality.recurring-failure-kind` | failed checks of one kind recur across tickets (observe's pattern rule) | >= 2 tickets and >= 15% of tickets that visited verify | 5 tickets analyzed | Q4 contributors, flow verify tickets |
| `quality.recurring-gate-refusal` | refusals of one gate recur across tickets | >= 2 tickets and >= 15% of tickets with a lifecycle log | 5 tickets | X2 contributors, flow coverage |
| `quality.recurring-blocker-rule` | blockers citing one rule code recur (no rule, or a rule in prose, `not-a-code`, is not a category) | >= 2 tickets and >= 15% of tickets that visited review | 5 tickets analyzed | R2 contributors, flow review tickets |
| `reliability.capacity-held` | the scheduler recorded work held for a free place (recorded max_parallel in use) on several days; never inferred from activity | >= 3 UTC day buckets in which a recorded capacity wait began, >= 3 waits | a recorded `max_parallel` | waits contributors (capacity, capacity-slice), factory limits |
| `reliability.execution-share` | recoveries, unknown outcomes, failures or interruptions above a share | S1 >= 10%, S2 >= 5% (attention), X1 >= 10%, interrupted/timed-out/could-not-start >= 10% | 10 executions | S1, S2, X1, executions contributors |
| `reliability.execution-later-window` | the same measures higher in the later window | later - earlier >= 5 points | bounded window; 10 executions per window; no suspect window | as above |
| `economics.cost-later-window` | recorded cost higher in the later window while integrated slices are not higher | later >= 1.25 x earlier and T2 later <= earlier | bounded window; 10 executions with cost and K1 coverage >= 80% per window | K1, T2 |
| `data.usage-missing` | subject `cost`: completed executions with no cost recorded by the supervisor (K1's coverage, the population of every recorded-cost figure); subject `stream`: executions with no `execution.usage` record (the population of K2 and K3). Both, because each is the truer population for the figures it feeds | >= 10% each | 10 executions each | K1 coverage, `K1-missing`; `usage-missing` and `executions` contributors |
| `data.lifecycle-coverage` | tickets without a lifecycle log | share with a log < 80% | 5 tickets | flow coverage |

A finding: `{id, rule, subject, severity, title, condition, threshold, measurements: [{metric, label, value, unit,
numerator, denominator, sample_count, coverage: {eligible, counted, share}, window: selection|later|earlier}],
sample: {count, unit, coverage_share, population}, window: {from_ms, to_ms, last_runs, comparison: {from_ms,
to_ms}}, filters, why, investigation: {label, text}, contributors: {metric, group, order, limit, path, relation:
exact|related, note}}`. `contributors.path` is a ready `/api/v1/analytics/contributors` query with the window,
`as_of_ms` and the filters it can apply (scorecard findings link their own population: `last_runs=N` instead of a
window); `relation: related` says the list is the closest the route serves and names it (remediation lists round-2
visits; interrupted executions list every execution with its state). The reply adds `rules` (this table as data),
`notice` and `investigation_label`.

With `as_of_ms` every window ends at the start of the as_of day (per-day cells; `as_of.exact: false`), including
the later window of a two-window rule; the flow and contributor figures are cut exactly; `last_runs` selects from the
runs recorded by as_of; and contributor links carry `as_of_ms`. A test holds that an outcome recorded after as_of
changes no finding and no reason. Links are exact for Q2 (first_pass:false), Q3, R5, R2 by rule, `K1-missing`,
`usage-missing` and `lifecycle-missing`.

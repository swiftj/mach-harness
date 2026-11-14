# M6.6 — Improvement Opportunity rules: review for the product owner

Phase 9 of M6.6. A review of the deterministic rules behind Analytics' Improvement Opportunities, as built at
`4180c16`. Nothing here changes a threshold, formula, metric ID or scorecard definition; the recommendations are
for the product owner to decide.

Code: `apps/observer/internal/insight/` (`insight.go` thresholds and the rule table, `rules.go` the rules,
`gather.go` the inputs, `templates.go` every word). Design: `M6_5_DESIGN.md` section 6. Metric IDs are the
catalog's (`apps/observer/internal/metrics/catalog.go`, `M6_1_SHARED_CONTRACTS.md`).

## How many rules

**18.** Counted three ways, all agreeing: the rule ID constants (`insight.go:25-42`), the `Rules` table
(`insight.go:94-113`) and the evaluation map (`rules.go:47-66`). The design table in `M6_5_DESIGN.md` section 6 also
has 18 rows. "Seventeen" in `M6_5_COMPLETION.md` section 10 and in the M6.6 brief is a miscount; the real run's "18
evaluated" is right. Several rules report per subject (wait kind, execution measure, cost or stream), so a reply can
list more than 18 `not_evaluated` entries (the real run listed 25).

Every threshold below is a constant in `insight.go`; the line given is where it is defined. The three scorecard
targets are the catalog's (`catalog.go:100`, `:102`, `:115`), which are `observe.py`'s.

## Review matrix

Disposition key: **keep**; **keep, note** (keep, with the note stated to the reader or in the docs);
**PO threshold** (the number is this milestone's choice and needs the product owner's decision);
**needs data** (cannot be judged until a Factory has produced enough real history).

| # | Rule ID and purpose | Threshold (as coded) | Minimum sample | Source metrics | Coverage requirement | Possible false positives | Possible false negatives | Disposition |
|---|---|---|---|---|---|---|---|---|
| 1 | `flow.station-time-share`: one station holds a large share of total measured station time | share >= 0.35 (`insight.go:47`) | 20 measured visits over all stations (`:48`), 2 stations measured, 5 measured visits at the station (`:49`) | C1 by station (flow report) | none; only measured visits count, bounded/open visits counted apart | Build does the TDD work and is the longest station by design, so it will usually clear 35% on any healthy belt. A visit spanning a wait for a person is now bounded, not measured (the template says so), which removes the real-run D9 case only if the record shows it was not continuous | Not evaluated with a station filter; a station whose long visits are mostly open or bounded is under-counted; a station slow against its own history but below 35% overall | **PO threshold**: decide whether build is exempt or the share is per-station against a baseline |
| 2 | `flow.wait-p90`: a wait kind's 90th percentile is long | p90 >= 8 h (`:50`) | 5 measured waits of the kind (`:51`) | W1, W2, W2b, W3, S4, slice capacity (flow waits) | none | Human-approval and parked-for-a-person waits cross nights and weekends, so 8 h is reached by an ordinary overnight approval | The longest waits are often still open and are not measured, so the worst tail is missing until it closes | **PO threshold**: one 8 h for every kind is unlikely to suit both queue and human waits |
| 3 | `flow.wait-share`: a wait inside dispatch-to-merge totals a large share of measured C3 | wait total / C3 total >= 0.25 (`:52`) | 5 measured waits of the kind, 5 measured C3 (`:53`) | W2b, W3, S4, C3 | none | The two totals are different populations (waits of tickets not merged in the window are in the numerator); the why says so. The ratio can exceed 100% | Dependency and queue waits are excluded by design; open waits not measured; non-product tickets have no C3 | **keep, note**: the population mismatch is stated on the card; keep it stated |
| 4 | `quality.remediation-share`: visits in round 2 or later hold a large share of measured station time | share >= 0.25 (`:54`) | 20 measured visits with a recorded round (`:55`), 5 in round >= 2 (`:56`) | C1 by round | visits with no recorded round are left out | One large ticket's long revision can carry the share on a small sample | Visits with an unknown round are excluded; tickets escalated in round 3 still count only their measured visits | **keep** |
| 5 | `scorecard.first-pass`: Q2 misses observe's target | Q2 not above 0.85 (catalog `:100`, `target_check.met` false) | 5 merged tickets (`:57`, observe.py MIN_TICKETS) | Q2 | run records only | With a dated window the population is "finished runs closed in the window", not observe's last 20; the finding states its population | Hand-merged work with no run record; fewer than 5 merged tickets | **keep** (observe parity) |
| 6 | `scorecard.rounds`: Q3 misses observe's target | Q3 not below 1.3 (catalog `:102`) | 5 merged tickets with recorded rounds (`:57`) | Q3 | run records only | As 5 | Runs with no recorded rounds are outside the denominator | **keep** (observe parity) |
| 7 | `scorecard.escalation`: R5 misses observe's target | R5 not below 0.05 (catalog `:115`) | 5 finished tickets (`:57`) | R5 | run records only | One escalation in 5 to 19 tickets is already >= 5%; escalation is the line working as designed (the why says so) | Abandoned tickets with no run record | **keep** (observe parity) |
| 8 | `trend.review-rejections`: R1 higher in the later of two equal windows | later - earlier >= 0.10 (`:61`) | dated window; 10 decided rounds per window (`:59`) | R1 | coverage >= 0.90 in each window (`:60`); no suspect window; earlier window inside the recorded history | At 10 rounds a window, one more rejection is the whole 10 points | **Never evaluated in the default view** (the whole history has no comparison window); evaluated only for a dated window | **needs data**; and see section (a) |
| 9 | `trend.verification-failures`: refusals of `verify.verdict` higher in the later window | later - earlier >= 0.10 (`:61`) | as 8, 10 verdicts per window | X2 filtered gate = `verify.verdict` | as 8 | as 8 | as 8 | **needs data** |
| 10 | `quality.recurring-failure-kind`: failed checks of one kind recur across tickets (observe.py pattern rule) | >= 2 tickets (`:62`) and >= 15% of tickets that visited verification (`:63`) | 5 tickets analyzed (`:64`) | Q4 contributors; verify visits (flow) | needs the flow report (not with a `model`, `outcome` or `provenance` filter) | A check kind that every ticket exercises (e.g. a shared fixture) recurs by construction | Check kinds the verifier does not record (real run: "failed checks not observed"); tickets that never reached verification | **keep** (observe parity) |
| 11 | `quality.recurring-gate-refusal`: refusals of one gate recur across tickets | >= 2 tickets and >= 15% of tickets with a lifecycle log (`:62-63`) | 5 tickets (`:64`) | X2 contributors; flow coverage | lifecycle log required | TDD makes `build.green` and `build.red` refuse as normal work (the real retry run: `build.green` x5 on one ticket); with two such tickets the rule fires on the line working as designed. `verify.verdict` refusals overlap rule 10 | Refusals by a command that crashed before its handler are not recorded (X2 limitation) | **PO threshold**: decide whether TDD step gates are in scope |
| 12 | `quality.recurring-blocker-rule`: review blockers citing one rule code recur | >= 2 tickets and >= 15% of tickets that visited review (`:62-63`) | 5 tickets analyzed (`:64`) | R2 contributors; review visits (flow) | blockers with no rule or a rule in prose are not a category (`gather.go:142-150`) | A rule code cited as a habit by one seat | **Cannot fire while the review station records `rules: []`** (real retry run, N7: 4 blockers, all without a code) | **keep, note**: depends on the station recording rule codes |
| 13 | `reliability.capacity-held`: the scheduler recorded work held for a free place on several days | >= 3 day buckets (`:65`) and >= 3 waits (`:66`) | a recorded `max_parallel` limit | W2b; capacity-slice waits; factory limits | supervised mode only (W2b) | A Factory run at a deliberately low limit will hold work whenever more is ready; that is the configuration doing its job | Observe mode records no capacity waits; days are UTC buckets, so one long hold is one day | **keep, note** |
| 14 | `reliability.execution-share`: recoveries, unknown outcomes, failures, interruptions above a share | S1 >= 0.10, S2 >= 0.05 (attention), X1 >= 0.10, interrupted >= 0.10 (`execShareMin`, `insight.go:81`) | 10 executions (`:67`) | S1, S2, X1, executions contributors | none | At 10 executions one failure is 10%; X1 counts a failure the supervisor then retried successfully | Executions with no end recorded are not interrupted; hand-driven work has no execution | **PO threshold**, with **needs data** for S2 |
| 15 | `reliability.execution-later-window`: the same measures higher in the later window | later - earlier >= 0.05 (`:68`) | dated window; 10 executions per window (`:67`) | as 14 | no suspect window | At 10 executions a window, one execution is 10 points, so any single extra failure fires | Never evaluated in the default view (no comparison window) | **needs data** |
| 16 | `economics.cost-later-window`: recorded cost higher in the later window while integrated slices are not | later cost >= 1.25 x earlier (`:71`) and T2 later <= T2 earlier | dated window; 10 executions with a recorded cost per window (`:69`) | K1, T2 | K1 coverage >= 0.80 in each window (`:70`) | Slices differ in size (the why says so) | Since the D8 change K1's coverage counts every claimed execution, and failed executions carry no cost by design, so a window with more than 20% failures is never evaluated. The template still says "covers ... of completed executions" | **keep, note**; the population wording needs the lead's decision (see "Wording defects") |
| 17 | `data.usage-missing`: executions without recorded usage (cost subject: no cost recorded by the supervisor; stream subject: no usage record from the stream) | missing >= 0.10 each (`:72`, `:74`) | 10 executions each (`:73`) | K1 coverage, `K1-missing`; `usage-missing` and `executions` contributors | none | **Cost subject:** K1's eligible count now includes failed executions (`project/reduce.go:740`, `:863`), which never record a cost. Any failure rate of 10% or more fires a data-quality note that says the "completed executions" have no cost. That is a false positive and a wrong noun | Hand-driven work has no execution and is not counted | **keep, note**; fix the population (lead's decision: wording or which executions count) |
| 18 | `data.lifecycle-coverage`: tickets without a lifecycle log | share with a log < 0.80 (`:75`) | 5 tickets (`:76`) | flow coverage | none | Filed tickets that were never dispatched count as tickets without a log (real run D10: LOCAL-002, "cell lifecycle 1 of 2"). A backlog of filed but undispatched tickets fires it | Tickets with no record at all are invisible to every source | **keep, note**; depends on the D10 fix |

## (a) Rules that cannot fire on a small Factory, and what a person sees

On the real run (3 executions, 3 tickets, 1 merged with a run record), 0 findings and every rule not evaluated
(`agents/live/samples-final/0000-1794670458019.json`). The recorded retry run gave the same (`agents/live/retry/api/analytics_insights.json`).

- Every rule needs at least 5 tickets, 5 waits of a kind, 10 executions or 20 measured visits. So nothing fires
  below about 5 finished tickets and 10 executions.
- Rules 8, 9, 15 and 16 need a dated window. **Analytics opens on the whole history, which has no comparison
  window, so these four never run unless a person picks dates**, whatever the Factory's size.
- Rule 13 needs supervised mode and a recorded limit. Rule 12 needs the review station to record rule codes.

What a person sees. On the Opportunities page: the notice, "No rule's condition holds in this window" with "Every rule
has a minimum sample; widen the window or clear a filter to include more", then "Not evaluated", one line per rule
(the condition in words, the ID in small type, the reason). On Pulse: "No rule's condition holds in this window;
most rules need at least 5 records. Findings are fixed rules over recorded values; none is a guess."

Do the reasons read correctly? Checked against the run's figures:

| Reason as served | Correct? |
|---|---|
| station-share "needs at least 20 measured station visits; 18 recorded" | yes (8+5+5 visits) |
| wait-p90 per kind, "needs at least 5 measured waits of this kind; 1 recorded" | yes |
| remediation "needs at least 20 (5 in round 2 or later) measured visits with a recorded round; 10 (0 in round 2 or later) recorded" | correct, but hard to read |
| scorecard "needs a denominator of at least 5 merged tickets; 1 recorded" | correct; "denominator" is a statistician's word to a person |
| two-window rules "needs a comparison window: ask a bounded window (from_ms and to_ms) …" | developer words. **Already changed in the code** (`gather.go:38` now says "choose a dated window (a start and an end) …"). Not seen in a running build |
| recurring rules "needs at least 5 tickets analyzed (the observe station's minimum); 3" | correct; ends on a bare number (every other reason says "N recorded") and does not say which tickets were analyzed (visited verification, visited review, or with a lifecycle log) |
| capacity "no wait for a free place was recorded in this selection" | yes |
| execution-share "needs a denominator of at least 10 claimed executions; 3 recorded" | yes |
| usage-missing cost "needs a denominator of at least 10 completed executions; 3 recorded" | **wrong noun on the retry run**: 1 execution completed and 2 failed; the 3 are claimed executions (rule 17 above) |
| lifecycle "needs a denominator of at least 5 tickets; 3 recorded" | yes, though the 3 included a ticket that was never dispatched (D10) |

Also: `reasonLastRuns` and the comparison reason under `last_runs` (`templates.go:185`, `gather.go:36`) say
"last_runs", a request parameter. The wording test (`wording_test.go:40`) checks only `max_parallel` and `from_ms`.

## (b) No recommendation can weaken a gate

From the code: every finding's words are fixed templates (`templates.go:32-155`) with numbers, IDs and fixed labels
filled in; no record text is placed in one. `TestTemplatesWording` (`insight_test.go:466-508`) fails on any of 43
words or phrases that claim a cause or loosen a gate ("skip", "bypass", "disable", "relax", "waive", "lower the
threshold", "raise the limit", "remove the gate", "auto-approve", "without approval", "should", …) in every title,
condition, why and investigation, every not-evaluated reason, the measure names and the rule conditions. Every
reply carries the notice "none of them is a reason to change verification, security review or a person's approval"
(`templates.go:16`). Twelve investigations end with "Verification, security review and a person's approval stay as
they are whatever this shows." (`templates.go:21`). The four observe-derived ones (first pass, rounds, recurring failure,
recurring blocker) end with "Any change to the Factory's rules goes through the observe station's factory-tuning
ticket and its review." The three remaining ones (cost, usage, lifecycle) do not mention gates at all.

Wording that comes closest, quoted:
- `flow.wait-share` why: "it does not measure how much shorter delivery would have been". With the human-approval
  subject this sits next to "shorter"; it is a denial, and the investigation closes with the gates sentence.
- `reliability.capacity-held` condition: "the Factory's recorded limit of {limit} executions at once". It names a
  limit without suggesting raising it; the investigation looks at which executions held the places.
- `scorecard.escalation` why: "Escalation is the line working as designed".

What the test does not scan: `waitLabels`, the `Threshold` and `Minimum` strings of `Rules`, and the population
strings built in `gather.go`. None of them contains a forbidden word (read by hand). The Simulation's own findings
(`web/apps/control-tower/src/analytics/model/findings.ts`) are separate words, also clean by a by-hand scan
(one says "The approval itself stays required").

## (c) Advisory and read-only

- `insight` imports only `metrics` and `project`: no file, process or network access (`insight.go:12-15`;
  `grep` for `os`, `os/exec`, `net/http` in the package finds none). `Evaluate` is a pure function, tested for the
  same bytes on the same input (`TestDeterministic`).
- The only route is `GET /api/v1/analytics/insights` (`server/analytics_insights.go`); the server refuses every
  method but GET with 405 (`server/server.go:256`).
- A finding's only actions in the Control Tower are "Open the figures" (another Analytics area) and "Rows" (the
  contributor list). Nothing files a ticket, changes a rule or a setting. Rule changes go through
  `observe.py file-ticket` and the review panel, which the observer cannot call (`tests/test_mach_tower.py`).

## (d) Every visible Analytics figure: basis, population, coverage, limitation

Convention, from `kit.tsx`. A `Readout` (`kit.tsx:287-338`) shows the value, `n`, coverage when below 100%, the
basis when not "measured", the whole-day cut and "history incomplete here". Its info button opens the catalog's
definition: counts, over (the population), source and authority, known as, sample, coverage with exclusions,
partial status, window, target, limits. `MiniFig` and `Num` carry the same definition. So for those figures,
limitations are one click away, not on screen. That is the design. Figures in the list below **have no definition
attached** and state one or more of the four nowhere on screen.

| Area | Figure (file:line) | Missing |
|---|---|---|
| Pulse | Quality panel bar, first pass vs remediated, counted from `s.runs` (`Pulse.tsx:342-369`) | basis (run records) and coverage (merged tickets with no run record) not said; no definition |
| Pulse | Reliability panel bar, how claimed executions ended (`Pulse.tsx:444-463`) | no definition; "open" (no end recorded) is drawn, but the base's coverage is not said |
| Pulse | Ladder "Executions completed" (`Pulse.tsx:239`) | has a definition; no `n` or coverage on screen (the other ladder steps are counts, which is fine) |
| Pulse | "Recorded: N finished tickets, N executions" in the lead note (`Pulse.tsx:169-175`) | executions are X1's denominator (claimed), not said |
| Flow | Station detail grid: measured visits, median, mean, 90th, longest, revise entries, visits after the first, open/unknown, gate refusals (`Flow.tsx:240-258`) | no definition or limitation. "Visits after the first" and the diagram's "open" counts come from a contributor page capped at 500 (`wire/load.ts:28`) and are silently low above that |
| Flow | Visit-duration footnote (`Flow.tsx:266`) | **said every percentile was a bucket's upper edge; exact percentiles are not. Fixed** (see below) |
| Flow | Human approval "By risk" line (`Flow.tsx:310`) | medians with no `n` basis or coverage |
| Flow | Agents line in station detail (`Flow.tsx:282-289`) | coverage of agents with a station label not said (Economics' Agents table says it) |
| Quality | First pass or remediated bar, and judging-rounds columns, from `s.runs` (`Quality.tsx:66-91`) | basis (run records) and runs without recorded rounds not said; no definition |
| Quality | Failures by kind (Q4) and blockers by rule (R2) tables (`Quality.tsx:138-157`) | no definition; Q4 is "a count only" (partial) and R2 is reconstructed. The R2 heading says "reconstructed"; Q4's partial status is not on screen |
| Economics | Model usage table and Tokens by kind (`Economics.tsx:134-169`) | K2/K3 coverage not on screen (the warning box above says how many executions carry no usage, which covers it when some do) |
| Economics | Executions by recorded cost (`Economics.tsx:279-292`) | dots from the K1 contributor page (capped at 500), "without one" from K1 coverage: the two counts diverge above 500 executions |
| Economics | "Cost beside verified delivery" foot: "Cost is recorded when an execution is claimed" (`Economics.tsx:269`) | the claim day is the K1 exclusion's day; a cost is recorded at `execution.completed` (`project/reduce.go:820`). Not verified which day the weekly series uses; listed for the lead |
| Reliability | "Finished with a person's approval" (`Reliability.tsx:103-109`) | basis stated ("run records with human_approval"); no definition; fine |
| Compare | Cohort cards (`Compare.tsx:88-104`) and dot strips (`Compare.tsx:133-134`) | basis said in the intro; merged tickets with no recorded rounds are not counted in "Rounds, median" without saying so; dot strips read contributor pages capped at 500, so a ticket beyond the cap is counted "without a recorded value" |
| Opportunities | Insight cards (`Opportunities.tsx:108-193`) | population, sample and coverage below 100% are on the card (`model/insights.ts:74-96`); limitation is the "Why it may matter" text. Complete |

**Fixed:** `Flow.tsx:266` now reads "Percentiles marked “about” are read inside the observer's buckets; the
others are exact, over every measured visit." That matches `percentileText` (`model/format.ts:165-169`).
Test: `web/apps/control-tower/test/m66-policy.test.mjs`. Every other item above is larger than one line, or is
a judgement for the lead.

## (e) Integrated is not accepted

Searched the Analytics UI (`ui/`, `model/`, `data/`) and the insight templates for "accepted", "accept",
"delivered", "delivery", "done", "shipped" (and "value" by hand in the strings that use it as a word).

- Pulse's ladder "From work done to product accepted" (`Pulse.tsx:235-272`) counts executions completed, tickets
  merged and slices integrated separately ("one does not imply the next"). It ends with a hatched step: "Accepted
  by product: Not recorded. No MACH record says a person accepted a delivered slice." It also explains that the
  catalog's name for T2, "Accepted delivery", "counts commits on the integration branch, not a product decision".
- T2 is shown as "Slices integrated" everywhere. Its definition popover still shows the catalog name "Accepted delivery",
  under "Shown here as 'Slices integrated'; the catalog's name and meaning are unchanged". **For the product owner:** the
  catalog name is the one place the word survives. Renaming it is a contract change, not made here.
- `shared.tsx:100` "Delivery: Merges into the default branch and product slices whose commit reached the
  integration branch." Accurate.
- `Economics.tsx:121` section title **"Cost beside verified delivery"**. It shows tickets merged (T1), and "delivery"
  next to "verified" leans towards accepted. Suggest "Cost beside tickets merged". Not changed: a wording choice
  for the lead.
- Insight templates: only "delivery time" (`templates.go:52`), meaning C3, dispatch to merge. No "accepted",
  "shipped", "done" or "delivered".
- Product acceptance is stated as not recorded: Pulse's ladder; `M6_5_COMPLETION.md` section 16.

## Wording defects for the lead (not changed: outside `areas/`, or larger than one line)

1. `data.usage-missing:cost` and `economics.cost-later-window` say "completed executions". K1's coverage counts
   every claimed execution since the D8 change (`project/reduce.go:740`, `:863`). This is a false positive on any
   failure rate of 10% or more (rule 17). The cost-later rule is also not evaluated above a 20% failure rate.
   Decide the population, then the words (`rules.go:612-627`, `:582-606`; `templates.go:137`).
2. "denominator" in `reasonFewDen` (`templates.go:178`); "last_runs" in `reasonLastRuns` (`templates.go:185`) and
   `gather.go:36`; `reasonFewAnalyzed` ends on a bare number (`templates.go:184`).
3. "Seventeen rules" in `M6_5_COMPLETION.md` section 10.

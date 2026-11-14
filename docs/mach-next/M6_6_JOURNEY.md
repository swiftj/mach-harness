# M6.6 live run and engineer journey

Facts from one short real supervised run on the final commit, with the Control Tower recorded over it. Raw data stays in scratch (`scratchpad/m66/agents/final/`: `logs/`, `out/steps.jsonl`, `out/step13-*.json`, `P/eng`); screenshots and recordings stay in the git-ignored `web/apps/control-tower/screenshots/m66/final/` and `recordings/m66/final/`.

## 1. Commit and environment

- Commit `e82fe24` (M6.6 worktree HEAD at the start of this run); MACH source exported with `git archive` into `shared/src`; observer `shared/bin/mach-observer` (final build, Control Tower embedded). Nothing was rebuilt.
- Toolchain as the morning run: Claude Code 2.1.323, Python 3.14, Node 25 with Playwright Chromium (headless, 1512x982 for the journey).
- Throwaway project `agents/final/P/eng` (library `textkit`; one approved wave of three slices, SLICE-003 depends on SLICE-001), created by `setup.py` through Product Studio's real `send`, engineering merge and `bin/mach install --no-studio --no-tower`. Audit: Silver 70, so every ticket stops at a human gate.

## 2. Commands (all through `run.py --project <throwaway>`; times UTC, 14 Nov 2026)

| Time | Command | Result |
|---|---|---|
| 20:30:48 | `audit.py run --json` | Silver 70 |
| 20:30:49 | `run.py product intake`, `product plan` | LOCAL-001..003 filed; two ready, SLICE-003 blocked on SLICE-001 |
| 20:31 | observer started (`mach-observer --project <P/eng>`) | loopback link |
| 20:32:20 | `factory enable --autonomy supervised --max-parallel 2 --max-runs-per-day 2 --budget-per-run 2.5 --budget-per-day 5 --max-attempts 1 --max-minutes 30 --max-risk Medium --include-backlog` | preflight printed code |
| 20:32:25 | same with `--confirm 9adf56` | enabled; no merge, no hooks, no service |
| 20:32:25 | `factory serve --interval 60` (background) | ran until disable |
| 20:38:37 | `review.py approve-human LOCAL-001 --by "The engineer"` (after reading findings.md: three approvals, seven notes, no blocker) | APPROVED |
| 20:38:37 | `merge.py run --by-person LOCAL-001` | MERGED, commit 429c87e |
| 20:38:37 | `cleanup.py run LOCAL-001` | archived, run record written |
| 20:43:38 | `factory disable` | nothing running; `runner.json` enabled false |

No `--dangerously-skip-permissions`, no `--allow-tool`, no `--allow-merge`, no hooks, no timer, no LaunchAgent.

## 3. Cost and durations

| Execution | Ticket | Ran | Seconds | Cost |
|---|---|---|---:|---:|
| x3f5dba49a3e7 | LOCAL-001 | 20:32:26 to 20:36:15 | 229 | $1.1307 |
| xe69ffb464082 | LOCAL-002 | 20:32:26 to 20:35:53 | 207 | $1.0321 |
| Total | | | | $2.1628 |

Two executions, both exit 0, both stopped at the human gate. The Control Tower's Economics showed "$2.16, a lower bound: 2 of 2 (100%) executions with a cost", per ticket $1.08 on 2 tickets: it matches 1.130697 + 1.032128. The limit of 2 runs in 24 hours held SLICE-003 (events seq 33 at 20:39:31: "the limit of 2 executions in 24 hours is reached"); it was never run. LOCAL-002 was left waiting for a person. Wall time of the live part: about 15 minutes.

## 4. The journey, 13 steps

Recorded in three files because the browser was closed on purpose at step 11 and my driver had to be restarted once (see What was not done). Per-step DOM text is in `out/steps.jsonl` and `out/step13-*.json`.

| # | What was done | Proof (DOM text or record) | Verdict |
|---|---|---|---|
| 1 | Opened the one-time link on the real local Factory | Header "MACH Control Tower, Live Factory, Live, eng, real execution of the MACH Factory, live" | PASS |
| 2 | Watched approved work scheduled and two cells made | Floor after enabling: "WAVE-001 3 slices", "SLICE-003 WAITS 001", "2 cells"; API cells LOCAL-001 and LOCAL-002 with stage `planned` then building. A first pass ran before the enable and said "Factory not enabled"; it was rerun at 20:33:56 and the rerun is the evidence. No screenshot holds two cells actively building at once (the cells were mostly in planning at the capture); see Defect 5 | PASS (capture caveat) |
| 3 | Selected LOCAL-001, inspector open | "Cell LOCAL-001 ... Planned ... Progress: 20 tool call(s) so far ... Agent labels: free text, not checked for names" | PASS |
| 4 | From the inspector to the Timeline | Hash `#timeline?sel=cell:LOCAL-001`, `data-timeline-ready`, 43 spans, selection kept | PASS |
| 5 | Investigated a recorded refusal | This run had four `review.submit` refusals (findings-invalid; LOCAL-001 x3, LOCAL-002 x1, each resubmitted). Opened the mark: "Gate review.submit refused (findings-invalid)", inspector "Visit, Review, round 1, in LOCAL-002 ... LOCAL-002: gate review.submit refused" | PASS (no retry cycle occurred; every ticket passed first time) |
| 6 | Inspected a reviewer result | `visit:LOCAL-002/review#1`: "Review approved; waiting for a person's approval ... The station said AWAITING_HUMAN ... review/round-1/decision.json". The page carries labels such as "free text, not checked for names" on cell and slice free text; the review visit's own text had no free-text field to label | PASS |
| 7 | To Factory Analytics | "Factory Analytics, Live Factory" with the seven areas | PASS |
| 8 | Measured performance of the station (Flow) | Flow and bottlenecks opened; station share row "Build 38 percent, Verify 17 percent, Review 44 percent" | PASS |
| 9 | Rows drawer behind a figure, then the Timeline from a row | From a fresh Flow address: drawer "Product tickets, dispatch to merge 1 contributing LOCAL-001 ticket ... 6 min 11 s", link "LOCAL-001, ticket: open in the Timeline", hash `#timeline?sel=cell:LOCAL-001&win=...` | PASS, but see Defect 3 |
| 10 | Back to the floor | hash `#atlas?...` | PASS |
| 11 | Closed the browser 30 s (20:36:00.969 to 20:36:31.114), reopened with the link from `.factory/local/observer/link` | Header again "Live Factory, Live"; floor showed "Last: LOCAL-001 awaiting human" | PASS |
| 12 | Executions continued during the gap, from the project's own records | Lifecycle lines in the gap: LOCAL-001 `review.decided`, `station.exited review`, `station.entered human-approval`, all 20:36:02.078; execution x3f5dba49a3e7 ended 20:36:15 and the supervisor recorded both exits at 20:36:29. LOCAL-002's last line was 20:35:53, before the gap | PASS, thin: the runs were nearly over, so only 3 lines and one cell fall in the gap |
| 13 | Opened as history, held the playhead mid-run (20:35:02, LOCAL-001 verifying) | See 4.1 | PASS with two should-fix points |

### 4.1 Step 13 in detail (replay `?replay` at 20:35:02, and live mode at the same moment)

- Header "HISTORICAL REPLAY ... replayed". Floor inspector: "Cell LOCAL-001 Built ... At station Verify, at work for 6 s ... Rounds Round 1 Verification running 0 of 4"; no approval, merge or review words; floor "Integration yard main 0 merged; Archive 0 archived".
- Timeline: "Replaying, 8 min 40 s before its end"; "From 20:30:45 to 20:35:02 UTC, 24 spans ... Still open: ..."; "after this moment, not shown"; the reveal button reads "Show what happened after this moment" (off).
- Analytics, replay and live mode: "No whole UTC day is complete before the playhead at 14 Nov 20:35:02 UTC; day-counted figures are not available", "0 finished tickets", no dollar figure on Pulse or Economics; live mode says "Live Factory, reviewing an earlier moment" with "Back to live". Tickets merged shown as a count of nothing, no cost. This is the D1 check from the morning: no leak this time, on Pulse and Economics.
- "Go to its last event" (replay's Back to live): Analytics then says "One ticket has finished in this history: LOCAL-001, merged on 14 Nov after 1 judging round, first time ... Tickets merged 1 ticket ... Executions completed 2 executions". Outcome shown.
- The floor in replay has no visible Back to live button; I did not find another control to click there (the End key sent as a synthetic event did nothing). Not demonstrated on the floor.

## 5. Extra assertions

| Assertion | Result |
|---|---|
| Per-ticket cost shows its coverage | PASS: "Per ticket $1.08, n 2 tickets with a recorded cost"; total "2 of 2 (100%) executions with a cost" |
| Held slice reads "held by the supervisor" with its reason | PASS: slice inspector at 20:40: "Eligible, held by the supervisor ... Why the supervisor holds it, in its words: the limit of 2 executions in 24 hours is reached, free text, not checked for names"; slice title "Unique link name" shown (morning's D2, D3, D6 not seen) |
| "Waiting for a person" ends at the recorded approval | PASS: API span `gate-wait:LOCAL-001/approval` 20:36:02.078 to 20:38:37.292, lifecycle `human.approval_recorded` 20:38:37.292 (morning's D5 not seen); the `person-wait` span also ends 20:38:37.292. LOCAL-002's waits stay open |
| Every page request GET to 127.0.0.1 | PASS: journey 1147 requests, screenshot runs 964, all GET, host 127.0.0.1 |
| Console errors | One, `e.getAttribute is not a function`, from my own probe that dispatched a synthetic `End` key event at `document`; none in the screenshot runs. The app should still not throw on a keydown whose target is not an element (should-fix, Defect 4) |

## 6. Non-interference

- Before and after: no `.factory` in `/Users/johnswift/Projects/mach-harness` or `/Users/johnswift/Projects/mach-harness-m66`.
- `runner.json` files under the scratch root: 66 before; after, two additional: this project's (`enabled: false`) and the copy of the earlier recorded retry project (`retry-eng`, copied for the replay shots, `enabled: false`, never run). No other changed.
- `ps`: no observer, supervisor, `claude -p`, driver or recorder of mine left.
- The observer was stopped and restarted once on the finished project for the slice and history checks; the supervisor was disabled before that.

## 7. Defects

| # | Severity | What | Evidence |
|---|---|---|---|
| 1 | should-fix | After cleanup archived LOCAL-001, the badge reads "Live · a source is unavailable: a cell's lifecycle log" on every workspace for the rest of the session. It was absent at 20:36:39 (step 11), before cleanup. The archive still holds that lifecycle, so the "unavailable" claim is probably the archived cell's folder rather than a lost source | header text in `screenshots/m66/final/_shots.jsonl`; `out/steps.jsonl` step 11 header |
| 2 | should-fix | Timeline held at 20:35:02 (replay): the overview text names a later moment and a total: "Whole history from 20 30 and 45 seconds UTC to 20 43 and 40 seconds UTC: 169 events recorded". The tracks end at the playhead; only that sentence (and "In this window: 169 events recorded", which I did not reconcile with the 24 spans) refers to what happened later | `out/step13-timeline.json` |
| 3 | note | Analytics opened from a held Timeline visit keeps the held moment, and then shows no `Rows` buttons (rows are offered once the address carries no moment). Probably by design, but a person following steps 6 to 9 in one sitting meets a drawer that is not there | `out/steps.jsonl` step 9 first try |
| 4 | should-fix | A keydown event whose target is not an element throws `e.getAttribute is not a function` in the page. Real keyboards always target elements, so low impact | `out/console.jsonl` |
| 5 | note | The two cells are in planning and building for 3.8 minutes in all; screenshots taken at the planned stage show "2 cells, 0 working" in the floor's summary line while both executions' agents were working; no capture shows two cells building. Not investigated further | `out/steps.jsonl` steps 2 and 10; `real-floor-live-two-cells-planned-1512x982-dark.png` |
| 6 | note | In replay the floor offers no visible Back to live control (Analytics does: "Go to its last event") | step 13 probe |
| 7 | note | Slice inspector says "Risk: Not recorded" for SLICE-003 although the ticket (LOCAL-003) exists; the risk is recorded after grooming, which never ran | `logs/held-text.txt` |
| 8 | note | Recorded retry project (replay), Economics at the final commit says "2 executions of 3 carry no recorded cost (2 failed: the Factory's record of a failed execution carries no cost)" with total $1.29 lower bound, 1 of 3. The reason is now stated and honest; it is not a total of all three. The morning's D8 asked for the cost of failed executions, which the run result files do carry ($0.2176 and $3.2301); this is the accepted disclosure, not a recount | `logs/retry-text2.txt` |

No must-fix defect was found in this run. Morning's D1 (live Analytics at a past playhead), D2, D3, D5, D6 did not reproduce; the "Why did it retry?" lens now labels each run ("Run 2 of 3 · failed · no visit of its own") and the ruler draws "Factory disabled 05:42–06:31" and "Factory paused from 06:40, no end recorded" (retry project, replay).

## 8. Captures and recordings

Screenshots (`screenshots/m66/final/`; none was viewed, only the DOM text above was read): 36 PNG files named `<source>-<workspace>-<state>-<size>-<theme>.png`.

- real, floor: `real-floor-live-two-cells-planned-1512x982-dark`, `real-floor-live-after-run-1440x900-light` and `-dark`, `real-floor-cell-inspector-live-1440x900-light`, `real-cell-inspector-live-building-1512x982-dark`, `real-floor-factory-disabled-1440x900-light`, `real-floor-held-earlier-moment-1440x900-light`, `real-floor-observer-stopped-disconnected-1440x900-light`, `real-floor-live-1100x700-light`, `real-floor-live-inspector-sheet-320x700-light`.
- real, timeline: `real-timeline-live-1440x900-light`, `real-timeline-live-during-run-1512x982-dark`, `real-timeline-refusal-inspector-1512x982-dark`, `real-timeline-held-reveal-off-1440x900-light`, `real-timeline-held-reveal-on-1440x900-light`, `real-timeline-observer-stopped-disconnected-1440x900-light`, `real-timeline-live-1100x700-light`, `real-timeline-live-inspector-sheet-320x700-light`.
- real, analytics: Pulse, Flow, Quality, Economics, Reliability, Compare, Opportunities `real-analytics-<area>-live-1440x900-light`; Pulse and Flow `-dark`; `real-analytics-pulse-held-earlier-moment-1440x900-light`; `real-analytics-observer-stopped-disconnected-1440x900-light`; `real-analytics-live-1100x700-light`; `real-analytics-live-no-inspector-320x700-light` (Analytics has no inspector sheet).
- replay (recorded retry project, copied): `replay-timeline-why-did-it-retry-lens-1440x900-light`, `replay-timeline-factory-disabled-band-ruler-1440x900-light`, `history-live-mode-analytics-economics-not-in-this-figure-1440x900-light` (this one is the retry project read in live mode, because a replay playhead hides the whole-history cost; the header there says Live Factory).
- simulation: `simulation-floor-1440x900-light`, `simulation-analytics-pulse-1440x900-light` (opened with `?simulation` on the observer's embedded build; header "Simulation").

Recordings (`recordings/m66/final/`): `real-journey-1-steps1-4-and-gap-1512x982-dark.webm` (steps 1 to 4, 5 to 10 first try, the gap), `real-journey-2-second-browser-1512x982-dark.webm` (after the reopen), `real-journey-3-steps5-10-and-history-step13-1512x982-dark.webm` (steps 5, 6, 9, 10 rerun, step 13 and economics).

## 9. What was not done

- Not one continuous recording: the browser was closed on purpose, and my driver was restarted once, so there are three files, and a fourth 0.5 MB aborted one was not kept.
- The first pass of steps 1 to 4 ran just before the Factory was enabled; steps 5, 6 and 9 failed first because I picked the wrong selectors and held moment; they were rerun and the failed first attempts are in `out/steps.jsonl`.
- The live-state captures (two cells working, floor in light and dark with two cells building, the cell inspector during build) are partly missing: the planned-stage capture and the after-run captures stand in. The "live" floor, Timeline and Analytics shots in light theme were taken after the executions ended and while the Factory was being disabled (20:41 to 20:44), so the "live floor" shows LOCAL-002 awaiting a person.
- No retry or remediation happened in the live run; the retry shots come from the recorded project, replayed, and say so in their names.
- No pixel check of any screenshot; the 320 px sheets were not checked by DOM.
- Blueprint, Theater and accessibility were not exercised here.

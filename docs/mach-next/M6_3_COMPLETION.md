# M6.3 Execution Timeline: completion report

Branch `feature/mach-next-m6-3-execution-timeline`, from baseline `5bb379e` (M6.2 on `main`). Not merged.
Companion documents: `M6_3_DESIGN.md` (the contract, as built), `M6_3_TESTING.md`, `M6_3_ACCESSIBILITY.md`,
`M6_3_PERFORMANCE.md`.

## 1. Branch and commits

Twenty-seven commits on the baseline; 173 files, about 39,600 lines added. In order: the design and the shared
TypeScript contract (`9fc1449`, `6311431`); the observer's timeline projections and store work (`b210b16`,
`47dc7cb`); the data providers, track model, canvas, overview, inspector section and workspace (`16b6faf` to
`aa29163`); a second wave for keyboard operation, the lenses, the structured alternative and polish from the first
look at a real run (`df9c8f8` to `51a8222`); the synthetic-history generator and measurement harness (`e85c8df`);
five fix rounds driven by three independent reviews, an end-to-end suite and an independent re-check (`eecd64b` to
`c7ff6e8`); and the fixes from the live supervised run with this report (the tip).

The work was done by a team of Opus 5.5 agents, each owning a disjoint set of files against the shared contract,
with the lead integrating, verifying and committing. Reviewers and re-checkers ran with fresh context and read
only.

## 2. What was built

The Control Tower has a second workspace beside the Factory Floor, opened from the header or with key `3`.

- **Temporal overview.** The whole held history: events recorded per bucket, recorded spans active at once
  (executions, cells in a station, agents) against the recorded parallel limit, landmarks (failures,
  interruptions, waits on a person, gate refusals and overrides, gaps), the brush that chooses the detailed
  window, the playhead and the live edge. Idle stretches compress into axis breaks.
- **Hierarchical tracks.** One canvas, virtualised rows, two groupings of the same spans. Product: wave, slice,
  cell, then rounds, one row per station, waits, review seats. Execution: execution (named "run n of m" for its
  cell), claim, workflow, agents on lanes, tools. Rounds and execution attempts are never nested in one another;
  each appears as a linked ribbon on the other's row.
- **Inspector.** The existing inspector gains an "In time" section in both workspaces: began, ended, duration and
  how it is known, the two bounding events, parent and children, what came before and after on the same track,
  and evidence references by artifact catalog id.
- **Time travel.** The existing transport, plus zoom to selection, fit the recorded activity, show all, filters
  (cells, executions, slices, stations, kinds, needs attention), and jumps to the previous or next failure,
  retry, attempt, gate decision, human intervention or gap.
- **Investigation lenses**, named as questions: Why did it retry? What ran at once? What was it waiting on? Who
  decided what? What was interrupted? Each sets the tracks up for its question and draws a compact figure in a
  band above them; every figure reveals the record it comes from.
- **Structured alternative.** The same tree and window as a virtualised tree-table, by a toolbar toggle.
- **Cross-experience navigation.** Selection, hover, focus and the playhead are the scene store's, so a selection
  made on the Atlas or Blueprint is framed in the Timeline and the reverse. Deep links:
  `#timeline?sel=&at=&win=&group=&lens=&table=`; `#atlas` and `#blueprint` links are unchanged.

## 3. Observer and scene-store integration

Nothing was duplicated: the event reducer, the scene store, the observer's index, the history-window loader and the
playback clock are the M6.2 ones. The Timeline adds a `workspace` field and one object of interface state to the
store, and reads spans through a provider with two implementations (the observer; the simulation's scene).

The observer gained, all GET-only, loopback-only, session-protected and redacted as before:

- `/api/v1/spans`: a time window, exact lookup, `attrs`, `truncated` and `total_uncapped`; replies built from a
  snapshot outside the projection lock.
- `/api/v1/marks` and `/api/v1/concurrency` (new): jump targets, and spans active per bucket by kind with the
  count whose end is inferred, and the recorded limits with what each bounds.
- `/api/v1/history` reaches ranges older than the memory window from disk; `/api/v1/series` answers for one
  ticket or one execution over the whole index.
- Wait history kept (every dependency wait per slice; capacity waits, including those rebuilt from the
  supervisor's scheduling decisions); times on recoveries and gaps; projection format 3, rebuilt in the background
  with health reporting `rebuilding`.

Under load at 250,000 events with 4,000 events a second arriving, four clients get 4,246 requests a second (1,276
before the lock-free change) with `/spans` at 2 ms at the 95th percentile; the projection runs about 8% slower
while serving them.

## 4. Timing and provenance semantics

Every span carries how its duration is known, and the same rule decides the drawing, the tooltip, the inspector
and the table: measured (solid, capped), bounded (bracketed and hatched over the uncertain part), inferred (dashed,
open cap, "≈"), open (to the live edge, no cap, no outcome), unknown (a query mark and a short stub), and "not
recorded" said in words. Authority shows as the left glyph.

Rules that were added because reviews or a real run showed the need:

- A visit whose execution ended without the visit recording an exit ends at that bound as interrupted
  (reconstructed), in the observer and, for an older observer, on the client. A wait on a person is never closed
  this way.
- Nothing stays open under an ended execution. An execution whose process was interrupted says so and never
  "took" or "failed"; one whose outcome is unknown is bounded by its recovery or by the next record that shows the
  line moved on.
- Only executions, workflows, agents, tools, tasks and station visits are ever "at work". An open wave, slice,
  cell or round is "open", with its last activity and what it waits for.
- A row shows its own condition. What happened beneath it is a count ("2 rejections"), never a failure mark on a
  parent that did not fail.
- A late exit is not evidence that work resumed; "taken up again" needs a later record.
- Outcomes are shown only once their event is held. When scrubbed back, the tracks speak as of the live edge and
  say so, the region after the playhead is tinted, and the inspector speaks as of the playhead.
- On a history that is no longer live, an execution with no end reads "no end recorded; the history ends at …".
- Workflow agents show a tool-call count and no ticks. No span, mark or series is invented, interpolated or
  smoothed.

## 5. Screenshots and recordings

Generated files are git-ignored, as for M6.0 and M6.2.

Earlier material, kept: `recordings/timeline/live-supervised-run.mp4` (the live run of section 6, 14 min 47 s, the
build before the live-run fixes) and progress captures in `screenshots/timeline/`.

**The final set**, made on the product owner's request by an automated pass on commit `c2f3b2b` (the tip of this
branch, clean tree): the Control Tower built and embedded by `apps/observer/build.sh` and served by that
`mach-observer` on 127.0.0.1 (ports 4320–4324), each source a copy without its `.factory/local/observer`.
Screenshots 1512×982 at device scale 2, dark unless named light; recordings real time, 1512×982, a drawn pointer,
H.264 MP4. Every frame shows a real source label (Live Factory, or Historical replay for 08); none shows Simulation.

Sources. **REAL-A**: the recorded real supervised run (one cell, three executions, two rejected rounds, a wait on a
person). **REAL-B**: the live supervised run of section 6 (one execution, 17 agents, a three-seat review, the human
gate open, a dependency and a capacity wait). **SYN-S**: `mach-synth --cells 12 --events 12000 --seed 7 --hours 6`.
**SYN-L**: `--cells 12 --events 220000 --seed 1 --hours 30`. **LIVE**: SYN-S regenerated with `--end now` (same
seed and shape; at the fixed end date the appended activity sat 37 h before the live edge and nothing visible
moved), appended with `--append --rate 20`. SYN-*, LIVE and every `syn-` file are a real observer reading invented
records.

`web/apps/control-tower/screenshots/timeline/final/` (37 screenshots, 3 contact sheets):

| File | Shows | Source |
|---|---|---|
| `01-syn-s-temporal-overview.png`, `-light.png` | whole 6 h history, tracks collapsed to cells, idle break | SYN-S |
| `02-real-a-expanded-cell.png`, `-light.png`, `-whole.png` | LOCAL-001 open: rounds, stations, tasks, waits, six seats (10 min and whole) | REAL-A |
| `03a-real-b-parallel-agents-execution.png` | Execution grouping, 17 agents on lanes with tool counts, an agent's inspector | REAL-B |
| `03b-syn-s-what-ran-at-once-lens.png` | "What ran at once?" against the recorded limit 3 | SYN-S |
| `04a-syn-s-verification-failure-two-passes-compared.png` | SYN-002's failed verification and revise on the tracks, two passes compared | SYN-S |
| `04b-real-a-two-rejected-rounds-retry-lens.png` | the retry ladder: rounds 1 and 2 rejected | REAL-A |
| `05-real-a-who-decided-what-seat-inspector.png` | "Who decided what?", R1 security seat in the inspector | REAL-A |
| `06a-real-b-human-approval-gate-in-time.png` | the approval wait selected, inspector "In time" | REAL-B |
| `06b-real-a-wait-on-a-person-selected.png` | the wait on a person clicked (see defect 3) | REAL-A |
| `07a`–`07c-syn-live-*.png` | following at the live edge while appending; a lens while following; a pinned window with "Follow" | LIVE |
| `07d-syn-live-pinned-follow-control-clipped-defect.png` | the pinned control cut off (defect 1) | LIVE |
| `08-real-a-historical-replay-mid-run.png` | Historical replay, playhead 06:35, tint after it, inspector as of it | REAL-A |
| `09a`/`09b-syn-l-whole-history-*.png` | 220,268 events, both groupings, the 41 h idle break | SYN-L |
| `09c`/`09d`/`09e-syn-l-*.png` | densest ten minutes; 30 s; the tree-table | SYN-L |
| `10a`/`10b-real-a-1280x800-*.png`, `10c`–`10e-real-a-1100x700-*.png` | tracks, a lens, the inspector drawer at both sizes | REAL-A |
| `11a-syn-s-timing-grammar-*.png` | measured, bounded, inferred, interrupted and unknown together (no open span there) | SYN-S |
| `11b-syn-s-stale-after-the-playhead-chip-at-live-edge-defect.png` | defect 2 | SYN-S |
| `12a-real-b-…`, `12b-syn-s-what-was-it-waiting-on.png` | the waits lens | REAL-B, SYN-S |
| `13a`/`13b`/`13c-syn-s-*.png` | "What was interrupted?"; the interrupted and recovered runs on the tracks; defect 4 | SYN-S |
| `14a`/`14b`/`14c-real-a-cross-view-*.png` | one selection on the Atlas, the Blueprint and the Timeline | REAL-A |
| `contact-sheet-1-…`, `-2-…`, `-3-…png` | the set on three sheets, the third with a still from each recording (labelled with PIL, not ffmpeg) | |

`web/apps/control-tower/recordings/timeline/final/`: `R1-real-a-investigation.mp4` (71 s: Atlas, `3`, overview,
collapse and expand, three "previous failure" jumps to round 1, zoom to it, the security seat, the inspector,
"Why did it retry?", two passes compared, `1` and `3`); `R2-live-follow-syn-live.mp4` (69 s, LIVE appending:
filter, following, grouping switch, a lens while following, pinned, Follow); `R3-syn-l-large-history.mp4` (84 s:
brush moved and drawn, whole history, wheel zoom to 10 s, pan, widen back to 2 d 20 h, Alt-drag scrub, groupings,
table); `R4-syn-s-keyboard-only.mp4` (64 s, no pointer: Tab to the tracks, arrows, Enter, Alt+arrows, Home, `n`,
`z`, `g`, the table by Shift+Tab and Enter, `l`). No console error in any recording.

Retaken: 06a (the page itself had scrolled), 07c (the first take is 07d), 09c (wrong runs open), 11a (stale
playhead and an old selection), 12b and 13 (filters and stale chip left from earlier steps), R1 twice (the pass
comparison did not engage), R3 twice (the brush began full width; wheel zoom-out did not respond after a ruler pan,
replaced by Widen; not reproduced in isolation).

**Privacy and requests.** The visible text of every screenshot was saved and scanned: no home path, account name,
e-mail address, key, token or one-time link value. 5,622 requests across 15 browser sessions: all GET to
127.0.0.1. The source projects were not written (copies only); every process started was stopped; `git status`
stayed clean.

**Visual defects visible in that set (on `c2f3b2b`)**, ranked. All nineteen were then worked on, after the set
was made: 1–4 in `df5665e`, 5–19 in the commit after it. Each fix has a unit test and an after-shot taken against a
real observer (`fix-0N-…png` and `r6-NN-…png` in the same folder); the ten-item set itself was not retaken, so its
frames still show the defects. After the fixes: 489 unit tests, 41 Timeline end-to-end tests and the six-check
accessibility audit pass. What the fixes did not cover:

- Event sentences under "Why it looks like this" and in landmarks still quote the stations' own words
  (`FAIL_WITH_EVIDENCE`, `APPROVED`); they are shared with the Atlas and Blueprint and were left as they are.
- Raw outcome words in mark labels and hover cards on the tracks were not rechecked.
- In Historical replay the toolbar still says "As of the live edge; playhead at …".
- The toolbars are still one Tab stop per control; the route to the tracks is a "Skip to the tracks" link.
- The "Factory not enabled" notice is now a chip in the top bar; it is announced when focused, not on load.
- A row's span count on a `win=` deep link can differ from the navigated view (tasks are loaded by window).
- Fixes were checked in the dark theme; light was checked only for 7.

The list as found:

Must fix
1. The toolbar overflows instead of folding: the pinned-window control and its **Follow** are cut off or pushed
   under the inspector (`07d`, `10a`, `10c`), and the speed group is clipped at 1280 (`10a`). The same width folds
   correctly in other states (`10e`), so the fit is not recomputed.
2. "After the playhead" stays on screen at the live edge after Return to live or `l` (`11b`; last seconds of R3).
3. Clicking a wait on a person shows "No further detail is recorded for that kind here" and the cell, with no In
   time section (`06b`).
4. A lens's **Frame** changes the window but leaves the tracks scrolled elsewhere: an empty stage (`13c`).

Should fix
5. Agent rows packed into lanes have blank labels in the label column, with tall empty bands (`07a`, `11a`); the
   same agents get named rows in other executions.
6. The waits lens shows dependency waits only; the capacity waits on the tracks are absent (`12a`, `12b`); overprinted
   "SLICE-002 merged" (`12b`).
7. A fresh `win=` deep link drops Groom and Plan rows that the navigated view keeps (`02`-light vs `02`).
8. Narrowing the window while following zooms about the centre, pins, and leaves the live edge hours ahead (R2).
9. Lens bands clip their content: last row cut (`03b`, `12b`, `13a`), right-hand text cut (R1, `13b`), and at
   1100×700 a lens leaves the tracks a third of the height (`10e`).
10. The concurrency lens scales to agents (23) so the limit of 3 and the executions line sit flat at the bottom (`03b`).
11. Table: the Track column truncates "SYN-006 · run…" (the run number is lost), "between … and" wraps (`09e`).
12. The "Factory is not enabled" notice covers part of the Atlas and the Blueprint (`14a`, `14b`).
13. Labels collide: break label under the brush edge ("12 h 3|5 min", `02`, `01`); duration text struck by
    marks (`09b`); "Live edge later" over the execution's verdicts and length (`03a`); "after the playhead" over
    overview landmarks (`04a`).
14. Lens rung clicks seek the playhead (contradicting "selection does not seek"); the inspector then says
    "at work for 0 s" (`04a`).
15. Raw words: `FAIL_WITH_EVIDENCE` in the inspector (R4), "Workflow between 0 ms and …" (`03a`, `09e`), the
    reviewer as a hex id (`05`), "Live edge later" in Historical replay (`08`).
16. 32 Tab stops before the tracks (R4).

Nice to have
17. Default windows on long-open work show the history in the left 5% (`01` before framing; REAL-B's 17 min).
18. Seat order differs between the lens and the tracks (`05`); first seat's label dropped (`06a`).
19. Execution row label "LOCAL-001 from 16:55 · s…" truncated; "Tool calls are c…" (`03a`, `07a`).

Judgement: the typography, the drawing-sheet ground, the state marks and the timing grammar are coherent with the
Atlas and Blueprint, and selection, playhead and `1`/`2`/`3` carry across cleanly (14a–c, R1), so the Timeline reads
as part of the Living Factory rather than a bolted-on monitor. What breaks that impression is chrome under
pressure: the toolbar at narrower widths and with chips, lens bands that clip, stale state labels, and empty
stages after framing.

## 6. Actual execution testing

- **A real supervised run, recorded** (two executions, two rejected review rounds, a wait on a person): used
  throughout development to look at the Timeline through a real observer.
- **A live supervised run with the Timeline open** (13 Nov 2026, a throwaway project, USD 1.19): one execution
  through plan, build, verify and a three-seat review, stopping at the human gate. The Timeline's span count
  matched the observer at every 30-second sample; station rows appeared within 8 to 12 seconds of their records
  (bounded by the 20-second sampling); 17 agents on separate lanes; tool activity as counts only; the human gate
  as waiting; all 3,532 page requests GET to `127.0.0.1`; no console error; projection lag zero. The project's
  files checksum the same before and after closing the browser and stopping the observer. The Factory was disabled
  afterwards and nothing was left running.
- That run exposed eight defects no fixture had: a window that froze behind the live edge after a lens while the
  transport said "Following"; a capacity wait recorded by the Factory but never shown; cost by model shown before
  its event when scrubbed back; and five smaller ones. All were fixed afterwards and are covered by tests that
  replay records progressively. **They have not been re-observed against a second live Factory run.**
- One execution ran, not two, so the live run showed no retry, rejection or second attempt; those are proven on
  the recorded real run and on synthetic histories.

## 7. Test results

Run on the final tree by the lead, in one pass:

| Suite | Result |
|---|---|
| Python (`make test`) | 606 pass |
| Go (`go vet`, `go test ./...`) | all packages pass |
| Go with the race detector (project, server, store, cmd) | pass |
| Web lint, typecheck, build (three apps) | pass |
| Control Tower unit tests | 437 pass (163 at the baseline) |
| Product Studio unit tests | 7 pass |
| Timeline browser end-to-end, real observer, including the 220,000-event case | 37 of 37 |
| Accessibility audit | 6 of 6 checks |

Not re-run for this milestone: Product Studio's browser suites (177 at M6.2), which nothing here touches, and the
M6.0 capture scripts.

The end-to-end suite runs a real observer (built from the tree) over copies of the real run and of synthetic
histories written in the Factory's own file formats, and covers the brief's eighteen cases; see
`M6_3_TESTING.md`.

## 8. Accessibility

`scripts/timeline-audit.mjs`, six checks, all passing: axe with zero violations across 26 states (both groupings,
table on and off, lenses, dark and light, three sizes); a keyboard walk with visible focus at every stop and the
tracks as one stop; target sizes; contrast of drawn marks computed from the tokens (lowest 4.62 against 4.5);
reduced motion (nothing animates after a zoom, a brush move or a workspace switch); no key bound twice. A
keyboard-only investigation is part of the end-to-end suite. Known gaps are listed in `M6_3_ACCESSIBILITY.md`: a
label row cannot be opened from the row itself by a screen reader (the tracks' keys and the table do it), and the
table's column resizer is pointer-only.

## 9. Large-history performance

On a 220,000-event, 12-cell synthetic history through the real observer (headless Chromium, software rendering,
a shared machine; measured one commit before the last fixes):

| Budget | Median | Worst |
|---|---|---|
| Scene ready to first tracks, under 1.5 s | 175 ms | 201 ms |
| Pan and zoom main-thread work per frame, under 16 ms | 3.44 ms | 4.04 ms |
| Scrub response, under 100 ms | 10.7 ms | one step of 1,403 ms |
| Expand or collapse one cell, under 50 ms | 22.8 / 20.5 ms | 65.8 ms |
| Heap over the Factory Floor, at most +60 MB | +6.7 MB | +6.8 MB |
| Floor to Timeline, under 300 ms | 154 ms | 503 ms (first switch) |
| Timeline to Floor | 32 ms | 48 ms |

Every budget is met at the median; three worst cases miss. The first-switch cause (a duplicated first request) and
the likely cause of the slow scrub step (a history-window swap re-querying the Timeline) were fixed afterwards and
are pinned by unit tests, but **have not been re-measured on the 220,000-event history**. Observer: cold catch-up
20.3 s, 255 MB resident, timeline routes about 1 ms at the 95th percentile. Requests from the page fell from
291–371 a minute busy and 76–258 idle to 90–96 and 0–5.

## 10. Known limitations

- Real-time (1×) playback of history is not offered; the speeds are 5× to 160× real time, as in M6.2.
- No critical-path claim is made anywhere; the records do not support one.
- An execution that no later record bounds stays open while the history is live.
- The merge mark records that a merge happened, not who or what authorised it, so the review lens says
  "authorization not recorded" unless the mark's own words say more; a security veto is shown only when a mark
  says so.
- "AWAITING_HUMAN" still appears as the station's raw word in mark labels and track hover cards.
- The loading, empty, filtered and disconnected states were designed and checked on a proof page, not provoked
  against a real observer.
- Performance was measured without a GPU and on a shared machine; no headed measurement was made.
- The supervisor's first "held" sentence in the live run read "0 of 1 in use". That is the Factory's wording and
  was left alone: M6.3 changes no Factory behaviour.
- No published release carries the observer yet (unchanged from M6.2).

## 11. Readiness for M6.4 Evidence Theater

Spans, marks and the inspector expose artifact catalog ids with the events that produced and verified them
(`evidenceRefsOf`, the `EvidenceRef` type, `data-evidence-artifact` on each reference). The observer's restricted
artifact routes are unchanged. Deep links carry a selection and an exact moment by event id, which is what an
Evidence Theater link back into the Timeline needs. The workspace switch in the header is a radio group that a
third workspace joins without touching the Factory Floor's two-view stage.

## 12. Readiness for M6.5 Factory Analytics

The span projection is the one place durations are derived, each with its basis: execution duration, station
visit duration, waits (dependency, capacity, eligible, person, gate), retry and attempt marks, agent concurrency
with the inferred share, and review and verification cycle bounds. `/api/v1/concurrency`, `/api/v1/marks` and the
per-ticket series are served for the whole index. No second metric catalog was created: the observer's existing
`/api/v1/analytics/*` routes remain the catalog, and Analytics can aggregate spans by basis so an inferred duration
is never averaged as if it were measured.

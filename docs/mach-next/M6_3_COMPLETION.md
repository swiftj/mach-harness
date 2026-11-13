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

- `web/apps/control-tower/recordings/timeline/live-supervised-run.mp4`: the Timeline during the live supervised
  run of section 6, 14 min 47 s, six joined segments. It shows the build before the live-run fixes.
- `web/apps/control-tower/screenshots/timeline/`: progress captures on the simulation and on the real runs, and
  three frames from the live run.

The brief's ten-item capture list has not been produced as a set on the final build: the product owner chooses
between reviewing by hand and an automated capture pass, and that choice is open.

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

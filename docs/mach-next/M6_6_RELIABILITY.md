# M6.6 Phase 7: the Control Tower as an optional observer

Status: measured, 13 scenarios. Raw data: `scratchpad/m66/agents/recover/` (`run.mjs`, `lib.mjs`, `res/s<N>.json`, `res/<N>.out`, `w/s<N>/` copies).

## Environment

- Observer: prebuilt `scratchpad/m66/shared/bin/mach-observer`, commit `d99edb4` (Control Tower embedded). Page: headless Chromium through the repo's Playwright, one page per scenario (three in 13), text read from the DOM (`data-connection`, `data-live-state`, `data-new-events`, the connection popover's "events received"), no pixels, no images.
- Projects: copies of the finished real-run project (`agents/live/P/eng`, 471 events, 46 intake lines, two cell logs) and of the retry project (`agents/live/retry/eng`). No MACH script, Factory or supervisor ran.
- "Running Factory" simulation: both the intake log and `LOCAL-003/lifecycle.jsonl` were cut at the same instant (2026-11-14T15:25:00Z) and the remaining 56 genuine recorded lines were appended in recorded-time order by a script. These are replayed real records, not invented ones. Execution streams, `result.json` files and `LOCAL-002` were already complete.
- One scenario per observer, ports 4461-4468, 4472, 4561, 4570 (relay, scenario 2).

## Results

| # | What was done | API said | Page said | Result |
|---|---|---|---|---|
| 1 | Page open, browser closed, 56 records appended over 17 s | head 415 before; 471 after, 471 unique events; checksums of every file outside `.factory/local/observer/` equal the original run; only the two appended files changed | n/a (closed) | PASS |
| 2 | Real gap: a relay between page and observer cut for 180 s (streams reset, connections refused), all records appended in the gap, relay restored, no reload | head 471 | "reconnecting", then "Disconnected, retrying", "As last seen"; after resume "Live", 471 received = head | PASS. An earlier attempt with CDP offline emulation never dropped the open stream and so proved nothing; discarded |
| 3 | Observer killed after a third of the appends, restarted on the same port 6 appends later | 471 events, 471 unique; ledger lines 46 = file; cell lines 35 = file; last seq 46 and 35 = the files | states: live, reconnecting/"as last seen", live; 471 received. Browser session survived the restart | PASS |
| 4 | Retry project copy, as is | `factory.activated/disabled/activated/resumed/paused/disabled` events present; executions after the resume (x2476...) present; a "human" mark spans 05:40 to 06:31 | Timeline says the Factory is disabled ("An engineer disabled the Factory on this machine"); "Factory not enabled" banner | PARTIAL: events and resumed work are shown; the disabled interval is not drawn as an interval (defect 3) |
| 5 | Page held at an earlier moment (Home), 56 records appended, then L | head 415 to 471 | held view: only the "Last confirmed" clock text changed; "56 new events" shown while "Reviewing"; after L: "Live", scene text differs | PASS (an automatic comparison flagged the clock line; the diff file is `w/s5/held-*.txt`) |
| 6 | 20 earlier real lines re-appended (10 intake, 10 cell); one real intake line held back and appended last | intake duplicates dropped (no new event); cell duplicates became 10 new events plus 6 artifact events (head 471 to 487), `duplicates` counter 0; held-back line added no event and was not individually marked late | page "received" 487 | FAIL (defects 1, 2) |
| 7 | Execution x7018 mid-run (stream half, no result); observer stopped; rest of stream, `result.json`, ledger and cell lines written; observer restarted | run state "running" before, "finished" after | "reconnecting" then live, 471 received; Analytics "3 of 3 claimed executions completed" | PASS |
| 8 | A: intake log renamed away 16 s. B: cell log `chmod 000` 16 s. C: cell log `chmod 000` before the observer starts | A: source state "gone", status "ok". B: open handle kept reading, state "idle". C: state "idle", 0 lines, status "degraded". Observer stayed up; all recovered without restart (same process in A and B) | Page says nothing about a gone or unreadable source in A, B or C | PARTIAL: observer survives and recovers; source trouble not shown on the page (defect 4) |
| 9 | 30 of 35 lines deleted from the middle of a cell log before start | `history.gap` event, 1 gap, 30 records | Floor: "partial history"; Timeline: "1 gap in history", "partial history"; Analytics: "Incomplete history ... not received (30 records)" | PASS |
| 10 | Fresh `git init` folder with empty `.factory/`; a folder that is not a MACH project | 0 events, status ok. Non-MACH folder: observer starts, serves an empty project, wrote no file | Each workspace shows its empty state ("Waiting for an approved wave", "No history yet", "No Factory activity recorded yet"); no `role=alert`, no console error | PASS (defect 5, note) |
| 11 | Finished real project as is | `execution` capability false; non-GET returns 405 | "Factory not enabled"; no control named enable, start, resume, dispatch or approve (the matches were status labels such as "Merge machine: succeeded"); 41 requests, all GET | PASS |
| 12 | Every request URL of every scenario (529), plus the observer's sockets | n/a | all GET, all `http://127.0.0.1:<port>`; observer holds only loopback sockets | PASS |
| 13 | Three pages on one observer while 56 records were appended | n/a (harness read no API head; the total is 471 in scenario 1) | all three "Live", all 471 received. Observer RSS 32.0 MB before, 32.1 MB during at 1.2% CPU, 26.1 MB after | PASS |

Throughout: the observer wrote only under `.factory/local/observer/` (scenario 1 checksums). Console errors occurred only as `ERR_CONNECTION_REFUSED` during deliberate outages (scenarios 2, 3, 7).

## Defects

1. **Should-fix. Re-appended cell lifecycle lines are counted again.** Evidence: `res/s6.json`, `w/s6/dups-new-events.json`. The 10 repeated lines (seq 1 to 10) became events `c:LOCAL-003:...:36` to `:45`, marked late, plus 6 artifact events: head 471 to 487. The intake log drops the same kind of repeat. The tail's `duplicates` counter stayed 0. A lifecycle writer never repeats a seq, so this needs a restored or doubled file, but counts do double.
2. **Note. Late-line marking not demonstrated.** In scenario 6 a held-back intake line (`execution.completed`, seq 45) added no event (head unchanged) and no event was individually marked late; the 71 events marked late were the replayed duplicates and observer-made artifacts. Cannot say whether this is correct or a gap in the test; needs a case where the late line is the only source of its event.
3. **Should-fix. A Factory-disabled interval is not an interval.** Evidence: `res/s4.out`. Between the first `factory.disabled` (05:42:04) and `factory.activated`/`resumed` (06:31:02) no span or mark says "disabled"; the page shows only the current state and the person-wait. The events are in `/api/v1/events`.
4. **Should-fix. An unavailable source is not shown on the page.** Evidence: `res/s8.out`. `/api/v1/health` says the intake log is "gone" (status "ok") or, at start, the cell log unreadable (status "degraded", state "idle"). The connection badge stays "Live" and no notice appears, so a person reads a stalled history as a quiet Factory. A `chmod 000` after the file is open is not noticed at all (reads continue on the open handle; arguably correct).
5. **Note. A folder that is not a MACH project is served as an empty project**, with "Live" and no hint it has no `.factory`. Wrote nothing.
6. **Note. Replay skew.** Records from different sources appended out of recorded-time order are marked late in bulk (54 in an early attempt that cut each file at its half). Cutting both at one instant removed it. Real records arrive in time order, so this is a property of the test only.

No must-fix defect found.

## Not tested live, and why

- Supervisor restart (4): no Factory may run. Covered only by the recorded retry project's events.
- Observer memory and CPU under load: one 56-record burst only, three pages; no long run.
- Scenario 13 read no API head (cookie jar not made); the page counts match the known total of 471.
- A browser sleeping or a laptop suspended: the gap in scenario 2 is a relay cut, not a suspended tab.
- Source loss of a stream file or `runs.jsonl`: only the intake log and a cell log were removed.
- Process note: an early `pkill -f` by name may have stopped other agents' observers that used the same shared binary; only my own processes are running now.

## Corrected in M6.6

- **Defect 4 (unavailable source).** The connection badge reads the source states the page already polls every 10 s (`/factory/status` and `/health` `freshness.sources`, GET only, no new store). A source in state `gone`, `unreadable`, `missing` or `error`, or the intake log or run records `ended`, turns the live badge to "Live · a source is unavailable: the intake log" (kinds only: the intake log, the run records, a cell's lifecycle log, an execution stream, an execution record, the archive; never a path), in the warning tone, with a "Sources" row in its popover and one polite announcement; the header carries it on all three workspaces. It clears on the next poll after the source returns. A cell or stream that `ended` is not counted (cleanup and finished executions end legitimately). Code: `shell/notices.ts` (`unavailableSourceWords`, `connectionLook`, `lookKey`), `shell/SourceBadge.tsx`, `shell/Announcer.tsx`. Not re-run live: scenario 8 was not repeated. A `chmod 000` after the file is open is still not noticed (the observer keeps reading the open handle).
- **Defect 3 (Factory disabled interval).** The Timeline's ruler draws each disabled or paused stretch as a band with its words ("Factory disabled 05:42–06:31", "Factory paused from 07:00, no end recorded"), built from the recorded `factory.disabled`, `factory.paused`, `factory.resumed` and `factory.activated` events. A disabled stretch ends only at a recorded `factory.activated`, a paused one at `factory.resumed`; with no recorded end it is open (dashed right edge, "no end recorded"). Held at the playhead, nothing after it is read. Code: `timeline/data/factoryIntervals.ts`, `timeline/render/WindowRuler.tsx`, `timeline/Workspace.tsx`. Not drawn on the overview or the floor's docked timeline. Not re-run against the retry project.
- Unit tests: `web/apps/control-tower/test/m66-a11y-reliability-fixes.test.mjs`. Defects 1, 2, 5 and 6 are unchanged.

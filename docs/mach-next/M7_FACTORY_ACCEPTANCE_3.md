# M7 Factory acceptance, third live run: confirming the N1, N2 and N3 fixes

> **Historical note (November 2026).** This document was written before M11. Delivery waves, epic approval, the product pull request, the Execution Timeline, the Execution Blueprint and playback have been removed since. Where it describes them, [`M11_DESIGN.md`](M11_DESIGN.md) and the root `CLAUDE.md` say what replaced them. It is kept as the record of what was designed and tested at the time.

Status: run complete, Factory disabled, nothing left running. One short live run, 2026-11-15 03:32–04:00 UTC, on
the throwaway "Team Lending Desk" project that the first two runs left (`M7_FACTORY_ACCEPTANCE.md`,
`M7_FACTORY_ACCEPTANCE_2.md`). Each check was run once against the real Factory.

**Headline.** C1, C2, C3 and C4 all **PASS**. A revised slice whose earlier ticket was abandoned was taken in by
itself (N2). A revision of work still in the line was flagged and then settled by `product resolve
--supersede-in-work` with no hand edit (N2). A building cell was re-planned in place and the line planned it again
under the plan check (N1). Executions stayed on their own ticket, the supervisor raised the due observe pass for a
person and started nothing for it, and `run.py` refused other tickets inside an execution (N3). The new slice
(SLICE-008) went through to the human gate and was merged as `07c9970`. Three executions cost **USD 1.93**.

**Three new defects (none blocks these fixes).** P3 (Major): the belt workflow can fail a ticket before it starts,
because it uses a relay agent's text for the agent type and the relay sometimes returns `""` or blank lines instead
of nothing. It failed two of the three executions. P1 and P2 (Major, Product Studio): two PM workspaces could not
revise the slice through Studio's own commands. The revisions were made from a fresh PM workspace instead. One Minor
(P4): the release outcome line does not name a required check that was not run.

## 1. What was run

| | |
|---|---|
| MACH | `git archive` of M7 worktree HEAD **`b73c025b6f274bb6624d6057346d87721dc0c6e7`** (clean tree) into `scratch/src` |
| Upgrade | `bin/mach install --project <eng> --no-studio --no-floor` from the snapshot; committed `5ab20e4` ("upgrade MACH to b73c025") and pushed. PM clones `pma`, `pmb`: `git pull`, then the same install. Each rewrote the tracked manifest, dropping `mach-studio`, as N11 in run 2 did; restored with `git checkout` |
| Project | engineer clone `scratchpad/m7/agents/pm/world/eng`, remote `github.com/swiftj/mach-m7-acceptance`. PM clones `world/pma`, `world/pmb`, and a new `world/pmc` (PM A's identity and HOME, see deviation 1) |
| Identities | engineer: `GIT_CONFIG_GLOBAL=world/home-eng/.gitconfig`. PMs: through the PM agent's `w.py` (separate HOME and Git identity; the token is only in the environment) |
| Observer | built from the snapshot with `go build` only (`apps/observer`, the placeholder UI, **no Factory Floor page**). Used for one API read in C4 |
| Scratch | `scratch` = `/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m7/agents/live3`: `logs/`, `api/`, `tools/`, `PROGRESS.md` |

### Commands (in order; `R` = `run.py --project <eng>`, `S <station>` = that station's script in the clone, `PM A/B/C` = `studio.py` as that PM)

| UTC | Command | Result |
|---|---|---|
| 03:33 | `bin/mach install` ×3 (above) | 10 MACH files updated in eng; pushed `5ab20e4` |
| 03:34 | PM A: `refresh`; `slice new --epic EPIC-001 --title "Search items by name" --depends-on SLICE-001`; spec and why written into the draft (shape of SLICE-001); `slice check SLICE-008 --ready`; `slice approve`; `wave new --slice SLICE-008`; `wave approve WAVE-005`; `send WAVE-005` | ready (two `message-missing` warnings, no errors); r2; WAVE-005; PR #14 |
| 03:34:2x | engineer `gh pr merge 14`, `git pull`; `R product intake`; `R product dispatch SLICE-008` | LOCAL-009 for r2; cell at `spec-ready` |
| 03:34:3x | `S cleanup run LOCAL-009 --abandon "confirmation test"`; `S ticket update LOCAL-009 --state closed --label abandoned` | archived, closed |
| 03:34:3x | PM A (in `pma`): `slice reopen SLICE-008`, edit, `slice approve`, `wave approve`, `send` | send refused: SLICE-008 and WAVE-005 "need reconciling"; `refresh` calls PM A's own merged slice a **collision** (P1) |
| 03:35 | PM B: `refresh`; `reconcile product/acceptance/WAVE-002.json --take theirs`; `slice reopen SLICE-008` | reopen refused: "product/acceptance/WAVE-002.json: unexpected field 'revision'" (P2) |
| 03:35:2x | `git clone` as PM A into `pmc`; PM A (pmc): `refresh`, `slice reopen`, AC-02 "drill" → "ladder", `slice approve`, `wave approve`, `send` | r4; PR #15 |
| 03:35:45 | merge #15, `git pull`; `R product intake` ×2 | **C1** |
| 03:36 | `R product dispatch SLICE-008`; PM A (pmc): `refresh`, reopen, "ladder" → "kettle", approve, wave approve, send; merge #16; `R product intake` | LOCAL-010 at `spec-ready`; r6; PR #16; **C2 first half** |
| 03:36:26 | `R product resolve SLICE-008 --supersede-in-work "confirmation test"`; `R product intake` ×2; `R product plan` | LOCAL-011 for r6; **C2** |
| 03:36:3x | `S cleanup run LOCAL-010 --abandon "confirmation test"`; ticket closed | `observe_due: true` (5 since the last pass) |
| 03:37 | day usage read from the ledger the way `supervisor.allowance` counts it (`logs/32-day-usage.txt`); `S audit run` | 15 executions and USD 24.93 counted in 24 h; Gold 93 |
| 03:37:59–03:38:06 | `R factory enable --autonomy supervised --max-parallel 1 --max-runs-per-day 18 --budget-per-run 2 --budget-per-day 30.93 --max-attempts 1 --max-minutes 20 --max-risk High --include-backlog`; `--confirm 9d470b --accept-execution-risk` | supervised. **Day limits set: 18 = 15 + 3 executions; USD 30.93 = 24.93 + 6** |
| 03:38:20 | `R factory serve --interval 60` (background); a watcher (`tools/watch.py`) to stop the Factory at the first committed build task | observe-due `human.required` (seq 253); x84e33dbfb177 started for LOCAL-011 |
| 03:38:30 | `R factory pause`; C4 refusals with `MACH_EXECUTION_ID=x84e33dbfb177` | **C4** |
| 03:39:21 | x84e33 ends: belt `error` before planning | P3; `human.required` |
| 03:42:45 | `R factory resume --retry LOCAL-011`; `R factory pause` once it started | x9d1e8d60525b; same P3 failure at 03:43:47 |
| 03:46:45–03:47:25 | engineer writes a 3-task plan by hand; `cell.py check-plan LOCAL-011`; `build.py start`; writes the T01 test; `build.py red LOCAL-011 T01` | PLANNED; building; T01 committed `a5ccd8e` (deviation 2); watcher stopped |
| 03:47:49 | `cell.py replan LOCAL-011 --reason "confirmation test"` | **C3** |
| 03:47:56 | `R factory resume --retry LOCAL-011`; `R factory pause` | x0d731e2b5f73: plan (passes `plan.check`), build T01–T05, verify PASS, review R1 3/3 → AWAITING_HUMAN at 03:56:02 |
| 03:52 | observer started (API-only build), `/api/v1/runs` | C4 |
| 03:57 | `R factory disable` | `still_running: []`; serve exited "the Factory was disabled" |
| 03:57 | review findings read (0 blockers, 6 notes); `S review approve-human LOCAL-011 --by "Engineer (M7 simulated)"`; `S merge run --by-person LOCAL-011`; `S cleanup run LOCAL-011`; ticket closed; push; `S audit run` | merged `07c9970`; Gold 93 |
| 03:58–03:59 | `tools/scan.sh` (run 2's wrapper: gitleaks, osv-scanner); `R release qualify WAVE-001 WAVE-002 WAVE-003 WAVE-005`; again after adding the osv run's real exit code and source count to its report | §3 |
| 03:59 | observer stopped; `R factory status` | disabled, no supervisor, no executions, nothing waiting |

### Executions and cost

| Execution | Ticket | Ran (UTC) | Cost USD | What happened |
|---|---|---|---:|---|
| x84e33dbfb177 | LOCAL-011 | 03:38:21–03:39:21 | 0.0957 | belt preflight, then `parallel[0] failed: agent({agentType}): agent type '""' not found` (P3). Parked: "1 execution(s) ended without moving it past 'spec-ready'" |
| x9d1e8d60525b | LOCAL-011 (retry) | 03:42:47–03:43:47 | 0.0392 | the same; the relay returned `agent_type: "\n\n"` (P3) |
| x0d731e2b5f73 | LOCAL-011 (retry after re-plan) | 03:47:57–03:56:02 | 1.7949 | plan (5 tasks, High: one contract), build, verify PASS, review R1 3/3 → AWAITING_HUMAN |
| **Total** | | | **1.9298** | 3 executions, the cap. Inside the USD 6 cap and the USD 2 per-run limit. Costs are each `stream.jsonl` `result` line and equal `/api/v1/runs` |

## 2. Results

| # | Fix | Expected | Observed | Evidence (in `scratch`) | Result |
|---|---|---|---|---|---|
| C1 | N2: a revision after an abandoned ticket | newer revision filed as a new ticket by itself, exactly once; ledger says it follows the abandoned one; nothing waiting for a person | first `intake` after r4 merged: `created` LOCAL-010 (r4); `updated` `{from_revision 2, to_revision 4, effect "new ticket; the earlier ticket was abandoned", follows LOCAL-009}`; `needs_person []`. Second `intake`: nothing created or updated. Ledger SLICE-008: `ticket_id LOCAL-010`, `follows {ticket_id LOCAL-009, revision 2, outcome abandoned, why "its ticket LOCAL-009 was abandoned (cleanup's run record) and is closed"}`, history entry `replaced_by_revision 4`; event `revision.superseded` with the same `why` (seq 241–242). `factory status`: `waiting_for_a_person {}` (LOCAL-003 and LOCAL-006 under `no_longer_waiting`, reissued as LOCAL-006 and LOCAL-007) | `logs/16`, `17`, `18-c1-ledger-slice008.json`, `19-c1-status.txt` | **PASS** |
| C2 | N2: a revision of work still in the line | `intake` flags it for a person and changes nothing; after `resolve`, the newest revision is filed once as a new ticket; the superseded revision never dispatchable (`superseded`, with reason); old cell and ticket untouched | `intake` with LOCAL-010 at `spec-ready`: `needs_person` [SLICE-008 4→6, LOCAL-010, "the definition changed while work was in progress", resolve command named]; nothing created. SHA-256 of every LOCAL-010 cell file, its ticket and branch head identical before and after (the ledger only recorded `product_pending` r6 and the attention). `resolve`: `created` LOCAL-011 (r6), `superseded_in_work {LOCAL-010, r4, why "confirmation test", by "engineer"}`, "The earlier ticket LOCAL-010 and its cell were not changed". `intake` ×2: nothing created. `product plan`: `superseded_revisions` [SLICE-008 r4, LOCAL-010, `state superseded`, `dispatchable false`, "Superseded while in work by engineer: confirmation test. Revision 6 is the slice's work now (ticket LOCAL-011) …"]; LOCAL-011 dispatchable. LOCAL-010 hashes still identical; then abandoned and closed | `logs/22`–`31` | **PASS** |
| C3 | N1: re-plan a building cell | old plan and build records under `plan-history/`; old branch tip under `refs/mach/replan/`; stage `spec-ready`; a lifecycle line; `run.py next` says plan; the line plans it again under the plan check | on the building cell (T01 committed by `build.py`): `REPLANNED`. `plan-history/1/` holds `plan.md`, `build.json`, `replan.json` {reason, `from_stage building`, reset}; `refs/mach/replan/LOCAL-011/1` = `a5ccd8e`; branch reset to `spec_commit` `0c9272f`; `cell.json` `spec-ready`, `replans 1`; lifecycle seq 11 `gate.evaluated` `plan.replan` pass, seq 12 `station.exited` build `replanned`; `next`: `plan`. Resumed: x0d731's plan station wrote a new 5-task plan; lifecycle seq 14 `plan.check` pass, seq 15 planned (High, 1 contract, 5 tasks); built, verified, reviewed. `build-report.json` was not kept because a build that had not finished has none | `logs/53-c3-replan.txt`, `54-c3-after-replan.txt`, `57-c3-replan-planned.txt` | **PASS** (the cell reached `building` through deviation 2) |
| C4 | N3: execution scope | the execution works on its own ticket only: no `/mach:observe`, no other ticket in any `run.py next`, `review-start` or build call; one `human.required` for the due observe pass and nothing started for it; `run.py next <another>` with the execution's ID refused; `/api/v1/runs` one execution for one ticket | three executions' streams: the only top-level tool call is `Workflow mach:belt {tickets: ["LOCAL-011"]}`. Every Bash, Skill and Agent call in the three belt runs (14, 14 and 78): no ticket but LOCAL-011, no observe call. x0d731 called `next`, `status --headless`, `review-start` and `build.py start/next/red/green` for LOCAL-011 only. Each belt's Learn phase: "no observe pass was due" (the scoped board). Supervisor: one `human.required` at 03:38:20 (seq 253): "An observe pass is due (10 finished tickets recorded). The supervisor does not run it …"; not repeated on later passes; no observe pass or tuning ticket filed. With `MACH_EXECUTION_ID`: `next LOCAL-007` refused rc 1, "This Factory execution was started for LOCAL-011 only. LOCAL-007 needs its own dispatch; nothing was done to it."; `next LOCAL-010` and `review-start LOCAL-007` refused the same way; `status` `scoped_to LOCAL-011`, `observe_due false`. `/api/v1/runs`: three runs, each `ticket_id LOCAL-011` (one `running` when read mid-run) | `logs/42`, `45`, `60`–`64`, `api/runs-1.json`, `runs-final.json`; events seq 253 | **PASS** |
| — | Ticket to the human gate | approve, merge by person, clean up | R1 3/3 AWAITING_HUMAN (High: the plan changed `proto/openapi.yaml`); 0 blockers, 6 notes (routing style, test reset in a loop, `parse_qs` without a field cap, 400 behaviour the spec does not describe, build report omits the contract file); approved; merged `07c9970`; archived; closed; Gold | `logs/71`–`73` | done |

## 3. Release qualification (once, plus one check of the scanner rule)

`R release qualify WAVE-001 WAVE-002 WAVE-003 WAVE-005` at `07c9970`:

- **Run 1:** `qualified`, outcome line **"qualified; not assessed: performance (not configured)"**. The line now names
  the check that was not assessed (N5's second half: PASS). But osv-scanner again scanned nothing (`No package
  sources found`, rc 128). Run 2's wrapper (`tools/scan.sh`) writes a report with `findings: []` and no `exit_code`,
  `scanned` or `error`, so MACH could not tell, and counted it as a pass. The N5 rule depends on the report carrying
  those fields. The harness is at fault here, not MACH. The finding: a wrapper that leaves them out still produces a
  false "clean".
- **Run 2** (a deviation: a second run), with the osv report given the run's real `exit_code 128`, `scanned 0`,
  `error`: **`incomplete`**, `incomplete: ["security.scan.osv-scanner"]`. The N5 rule works. But the outcome line
  reads "incomplete; not assessed: performance (not configured)" and does not name the osv check that made it
  incomplete (P4). Product acceptance for WAVE-005: `not_recorded` (no acceptance was asked for).

`logs/81-qualify.txt`, `82-qualify2.txt`, `logs/scans/`.

## 4. New defects

| # | Severity | What | Evidence |
|---|---|---|---|
| P3 | **Major** | **The belt fails a step with no agent type when its relay returns an empty-looking string.** `run.py next` gives `agent_type: null` for `plan`. The belt asks a relay agent (Haiku, structured output, `agent_type: string`) to copy the step, then does `if (step.agent_type) opts.agentType = step.agent_type`. The relay returned `"\"\""` (two quote characters) in x84e33 and `"\n\n"` in x9d1e, both truthy, so `agent()` failed ("agent type '\"\"' not found") and the ticket was parked as an execution that did not move it. x0d731's relay returned `""` and worked. 2 of 3 executions were lost this way. `belt.js` is unchanged by these fixes (only a comment), so this is older and depends on the model. Fix direction: trim and treat blank or quote-only values as absent, or validate against the agent list | `logs/40`; workflow `journal.jsonl` and agent transcripts under the executions' sessions; `belt.js:140` |
| P1 | Major (Product Studio) | **A PM who revises their own just-merged slice before refreshing is told it is a different slice.** `send` records no base for the files it publishes. If the PM reopens and edits the slice after the PR merges and before a `refresh`, the next sync finds no base and a different draft, and reports a **collision** for SLICE-008, its spec and WAVE-005. `reconcile` then refuses ("a different slice … Give your draft a new number"). The only Studio route, `renumber`, would make it a new slice. Refreshing right after the merge avoids it (pmc did) | `logs/13-pma-refresh.json`; `studio.py` `sync` (~259) and `cmd_reconcile` (~1251) |
| P2 | Major (Product Studio) | **`reconcile --take theirs` on an acceptance record writes a field the validator refuses.** In `pmb`, the WAVE-002 acceptance conflict (only `recorded_at` differed) was settled with `--take theirs`; the draft then had `"revision": 0`, which the shared file does not, and every later change was refused: "product/acceptance/WAVE-002.json: unexpected field 'revision'". PM B's workspace is left in that state | `ev/pm-pmb.jsonl`, `logs/15-p2-acceptance-diff.txt` |
| P4 | Minor | The outcome line of an `incomplete` release names optional checks not assessed but not the required check that was not run (`security.scan.osv-scanner`); it is only in `incomplete` | `logs/82-qualify2.txt` |
| P5 | Minor | The observe-due request says "10 finished tickets recorded" while cleanup says "5 tickets have finished since the last one". Both are true; the supervisor counts all finished tickets, which misstates what is due | events seq 253; `logs/30` |
| P6 | Minor | `resolve` records `by: "engineer"`, a role word, where `factory enable` records the Git identity ("Engineer (M7 simulated)") | `logs/25` |
| — | (N11 again) | `mach install --no-studio` rewrote the PM clones' tracked manifest | §1 |

## 5. Deviations

1. **Revisions sent from a fresh PM workspace (`pmc`)**, a new clone with PM A's identity, because P1 left `pma` and
   P2 left `pmb` unable to revise SLICE-008. Product Studio's own commands only. `pma` (SLICE-008 r3 draft, colliding)
   and `pmb` (acceptance draft with `revision`) were left as they are.
2. **The engineer wrote LOCAL-011's first plan by hand and completed T01 with `build.py`** after P3 had failed two
   executions. That plan was 3 tasks with no contract; `check-plan` and `build.py red` accepted it. This was done to
   get a `building` cell with a committed task for C3 without spending the last execution. No state file was edited:
   `plan.md` is a station artifact, and the stage changed only through `check-plan` and `build.py`. The re-plan then
   set that plan aside, and the line's own plan replaced it.
3. A watcher (`tools/watch.py`) was armed to run `factory stop` at the first committed build task. It never fired:
   both executions it watched failed before planning. It was stopped before the hand plan.
4. The Factory was paused right after each execution started, so nothing else could start. With max-parallel 1 and
   one eligible ticket, nothing else would have started anyway.
5. **Release qualification was run twice** (§3). The second run used the osv report with the real exit code and source
   count added (the facts in `logs/scans/osv.log`). That report file is a scanner input, not a MACH state file.
6. The observer was built API-only (`go build`, placeholder page), not with `build.sh` and the Factory Floor. Its
   one-time link went to `logs/observer.out` (loopback, used once). Nothing was checked on a page.
7. The day limits were set from my reading of the ledger with `supervisor.allowance`'s rule (`logs/32`), not from a
   figure `factory status` prints. It prints none: a small gap, noted, not a defect.

## 6. Not shown

- The emergency `factory stop` path was not exercised (the watcher never fired).
- No Factory Floor page was checked; `/api/v1/runs` only.
- osv-scanner had no dependency manifest to read; no dependency scan of substance. `performance_command` not
  configured.
- One run, each check once, a local multi-clone setup on one Mac (not separate machines).

## 7. Final state

- SLICE-008 r6 integrated as `07c9970` (LOCAL-011). LOCAL-009 and LOCAL-010 abandoned and closed, with archives.
- Factory `disabled`; no supervisor, observer, watcher or `claude -p` running; no `.factory` in `mach-harness`,
  `mach-harness-m66` or `mach-harness-m7`.
- An observe pass is still due on the project (6 finished since the last one); not run.
- `.factory/release/` untracked in the engineer clone (D13, as before).

## Corrected after the run

- **P3** (not committed; checked with Node on the extracted function and by text guards, not re-run live). The defect predates M7: the hand-off line is from 0.9.0 (2026-11-09). Now `workflows/belt.js` asks the relay for the step with a stricter JSON Schema: `action` is one of run.py's steps or `ERROR`, and `agent_type` is required and must be `""` or one of the eight shipped agent names (`mach:`/`mach-` × builder, contract-engineer, verifier, reviewer). Each reply then passes through a pure `cleanStep()`. It trims values and treats blank, whitespace-only or quote-only values as absent. An agent type outside the shipped set is dropped with a logged note, and the default worker runs the step. An unreadable reply, `ERROR`, an unknown action, or a work step with no prompt stops that ticket with `outcome: error` and the reason; no agent is started. `tests/test_run.py` `WorkflowScriptTest`.
- **P5** (not committed; stand-in `claude`): the cleanup station's `observe_due()` is now the only source. `run.py`'s board loads it, and the supervisor's request uses its `finished_since_last_pass` and `every`: "An observe pass is due: N tickets have finished since the last one (a pass every M)". `tests/test_mach_factory_supervisor.py` `test_the_supervisor_counts_a_due_pass_as_cleanup_does`.
- **P4** (not committed; unit tests only, not re-run live): `outcome_summary` now names every check that is missing, not run or not configured, required or optional, with its reason, whatever the outcome (e.g. `security.scan (not run: no scanner report for this commit)`). `tests/test_release_qualify.py`.
- **Scan reports without the facts** (not committed; unit tests only): a scanner report counts only with `tool`, `version`, `exit_code`, `scanned` > 0 and `scanned_at`; otherwise `not_run`, "report lacks <field>". Stricter than before for older reports, as `M7_RELEASE_QUALIFICATION.md` now says, with gitleaks and osv-scanner examples. `tests/test_release_qualify.py`.
- **P1** (not committed; unit tests with a local bare remote and the fake `gh`, plus copies of the real `pma` in scratch, not re-run live). The three-way comparison now classifies by lineage: when the draft differs from the shared file and has no base (or an older one), `sync` asks the publication ledger for what this workspace itself sent of that file. If the shared file is exactly that, or the sent commit is an ancestor of the integration branch, the sent version becomes the base and is recorded. The draft is then a later revision of the PM's own artifact: an unpublished edit, merged field by field for JSON, a conflict only where someone else also changed it, never a collision. A different artifact under the same number (no publication of it in the ledger) is still a collision that asks for a renumber. On a copy of `pma` the three collisions are gone. After a fetch they became ordinary conflicts with the later revision from `pmc`, settled with `reconcile`. `tests/test_mach_product_collab.py` `StuckWorkspaceTest` (the run's sequence: send, merge, reopen, edit, approve, send, no refresh).
- **P2** (not committed; same evidence level). `collab.merge_fields` added `revision` to every merged JSON artifact. It now adds one only when either side has it, so an acceptance record never gets one. A change is refused only for problems it introduces itself. A pre-existing invalid file elsewhere is still listed in `status` by file and field, but no longer blocks `slice reopen` or any other edit. Repair: `refresh` or `status` drops a stray `revision` from an acceptance record that otherwise equals the shared one, and reports it once under `repaired`. On a copy of `pmb`, `status` repaired WAVE-002's record and `slice reopen SLICE-008` succeeded. The same reopen, refused before, was reproduced with HEAD's code. `StuckWorkspaceTest`. The Product Studio files and `tests.test_release_qualify`: 129 tests, OK.

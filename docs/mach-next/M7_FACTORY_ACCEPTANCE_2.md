# M7 Factory acceptance, second live run: finishing the wave (Phases 2, 3, 7 and 8)

Status: run complete, Factory disabled, nothing left running. One live run, 2026-11-15 02:24–03:12 UTC, on the
throwaway "Team Lending Desk" project the first run left (`M7_FACTORY_ACCEPTANCE.md`). Every item was run once.
Where a check was done on a copy of the project or of records, it says so.

**Headline.** The whole wave is integrated. SLICE-005 (Borrow), SLICE-006 (Return) and SLICE-003 (Overdue report)
were built, verified and reviewed by the supervised line and merged by the engineer at each human gate, so all five
slices of WAVE-001..003 are on `main`. Release qualification at the release commit `e6cbbb9` is **`qualified`**
(byte-identical on repeat), with the product owner's acceptance of all three waves read from the merged acceptance
records. The integrated service passed every step of an independent `curl` journey. Seven executions cost **USD 7.93
recorded**, plus two killed executions with no recorded cost (bounded by the USD 3 per-run limit; estimated under
USD 2 together).

**One Blocker for MACH's supported paths (N2):** after product revised a slice whose earlier ticket was in the line,
abandoning that ticket did not let the new revision through. Intake reported `needs_person` on every pass and
`--reissue` does not apply to a changed revision. The only way forward was a hand edit of
`.factory/intake/ledger.json`. Three Major defects: N1 (a parked cell cannot be re-planned in place), N3 (the belt
ran an observe pass and a factory-tuning ticket inside an execution dispatched for another ticket), and N4 (an
acceptance sent from a workspace holding a later slice draft published that draft). F1 to F9 pass. F10 is partly met:
the readiness line, the parked reason and released claims are right, but a killed execution reads as "failed".

## 1. What was run

| | |
|---|---|
| MACH | `git archive` of M7 worktree HEAD `62ad896895e561b1120e1a337a5abd539564595d` (clean tree) into `scratch/src` |
| Observer | built once from that snapshot with `apps/observer/build.sh` (`SKIP_INSTALL=1`, node_modules cloned in with `cp -Rc`), Factory Floor embedded, no source maps: `scratch/bin/mach-observer`. Up from 02:25 to 03:09 |
| Project | engineer clone `scratchpad/m7/agents/pm/world/eng`, remote `github.com/swiftj/mach-m7-acceptance`; PM clones `world/pma`, `world/pmb` |
| Identities | engineer: `GIT_CONFIG_GLOBAL=world/home-eng/.gitconfig` ("Engineer (M7 simulated)"); PMs through the PM agent's `w.py` helpers (separate HOME and Git identity, token only in the environment) |
| Toolchain | macOS 27.2 arm64, Python 3.15.2, Go 1.27.3, Node 25.8.2, git 2.52.0, gh 2.86.0, Claude Code 2.1.323, gitleaks 8.30.1, osv-scanner 2.7.0 |
| Scratch | `scratch` = `/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m7/agents/live2`; `logs/`, `api/` (observer replies), `browser/` (page text, DOM `innerText` only), `samples/` (sampler, every 30 s), `ev/` (PM command records), `PROGRESS.md` |

The project had moved since the first run: two merged branches and `docs-rules-test.txt` from another test. `git pull`
brought `main` to `0116a52` before anything else.

### Commands (in order; `R` = `run.py --project <eng>`, `S <station>` = that station's script in the clone)

| UTC | Command | Result |
|---|---|---|
| 02:24:40 | `bin/mach install --project <eng> --no-studio --no-floor` (snapshot) | 21 files updated; intake, tickets, `config.json`, `runner.json` SHA-256 identical before and after; committed `045d1e1`, pushed |
| 02:24:44 | `R factory status` | disabled, `problems`: "Supervised execution needs a person to accept the execution risk … this authorization records no acceptance" (F8, second half) |
| 02:25 | observer started; page text and API before repair | `browser/p1-pre-repair.txt`, `api/*-pre.json` |
| 02:26:38 | `cell.py check-plan LOCAL-003` | refused (F1) |
| 02:26:55 | `S cleanup plan|run LOCAL-003 --abandon "<engineer's reason>"`; `S ticket update LOCAL-003 --state closed --label abandoned` | archived with `branch.bundle`; closed |
| 02:27:02 | `R product intake --reissue SLICE-005` | LOCAL-006 for SLICE-005 r4 |
| 02:27:19 | `S audit run` | Gold 93 at `045d1e1` |
| 02:27:26–37 | `R factory enable --autonomy supervised --max-parallel 2 --max-runs-per-day 12 --budget-per-run 3 --budget-per-day 20 --max-attempts 2 --max-minutes 30 --max-risk High --include-backlog`; `--confirm 2b527e` (refused); `--confirm 2b527e --accept-execution-risk` | F8 |
| 02:27:44 | `R factory serve --interval 60` ("serve-1"); sampler | LOCAL-006 started 02:27:46 (plan) |
| 02:28 | F9 in a copy (`scratch/f9/eng`, no remote) | §2 |
| 02:29:30–51 | PM B: `refresh`, `slice reopen/approve SLICE-006`, `wave approve WAVE-003`, `send WAVE-003` → PR #8; engineer `gh pr merge 8`, `git pull`, `R product intake` | F7; LOCAL-004 r4 → r6, ticket updated |
| 02:30:47 | supervisor: LOCAL-006 `execution.failed`, `not_progressing: workflow-stuck`, `human.required` | F2 (the plan station refused: spec gap, below) |
| 02:31:07–32 | PM B: `refresh`, `slice reopen SLICE-005`, edit of the draft spec (the planner's question answered), `slice check/approve`, `wave approve WAVE-003`, `send WAVE-003` → PR #9; engineer merges, `R product intake` | intake: `needs_person` (definition changed under LOCAL-006) |
| 02:32 | `S cleanup run LOCAL-006 --abandon …`, ticket closed; `R product intake`; `R product intake --reissue SLICE-005` | still `needs_person` both times (N2) |
| 02:32:48–33:16 | `R factory pause`; **hand edit** of `.factory/intake/ledger.json` (SLICE-005 `state: superseded`, history appended; backup `logs/48-ledger-before.json`); `R product intake`; `S audit run`; `R factory resume` | LOCAL-007 for SLICE-005 r6; Gold at `2b96b67` |
| 02:33:28 | `kill -9` the `claude -p` for LOCAL-007 (9 s in) | F3 |
| 02:34:19–42:50 | supervisor: LOCAL-007 attempt 2 | plan (fresh, passes the new check), build T01–T07, verify PASS, review R1 3/3 → AWAITING_HUMAN |
| 02:43:0x | `S review approve-human LOCAL-007 --by …`; `S merge run --by-person LOCAL-007`; `S cleanup run LOCAL-007`; ticket closed; push; audit | merged `642dff8` |
| 02:44:26 | supervisor starts LOCAL-005; LOCAL-004 held: "the limit of 12 executions in 24 hours is reached" | the first run's 9 executions count |
| 02:47:07–25 | `R factory disable` (LOCAL-005 still running); `enable` with `--max-runs-per-day 24 --budget-per-day 28`, others unchanged; `--confirm 7e6fac --accept-execution-risk`; `serve` ("serve-2") | deviation 2; `recovery.started still-running` for LOCAL-005; LOCAL-004 started |
| 02:49:00 | `kill -9` LOCAL-005's `claude -p`; `S cleanup run LOCAL-008 --abandon …`; ticket closed | deviation 3 (N3) |
| 02:49:45 | `R factory resume --retry LOCAL-005` | LOCAL-005 attempt started 02:49:47 |
| 02:54:2x | LOCAL-004: approve-human, merge by person (`5afe9a8`), cleanup, close, push, audit | |
| 02:57:17 | LOCAL-005: approve-human; `merge run --by-person` | refused: conflict in `proto/openapi.yaml` |
| 02:57:5x | engineer merges `main` into `feature/LOCAL-005` in the cell: both contract additions kept, plus one line in `return_item` (`self._due.pop(tag, None)`); 30 tests pass; `5103e16`; `merge run --by-person` | approval void → `built`; the line re-verified and re-reviewed (`round-1.1`) |
| 03:01:4x | LOCAL-005: approve-human, merge (`e6cbbb9`), cleanup, close, push, audit | **WAVE-003 integrated** |
| 03:02–03:06 | `tools/scan.sh`; `R release qualify WAVE-001 WAVE-002 WAVE-003` ×2; acceptance (PM B: WAVE-001, -002, -003; PM A: WAVE-002); PRs #10, #12, #13 merged, #11 closed; `release qualify --commit e6cbbb9 …` ×2 after each merge | §6 |
| 03:06–03:08 | journey, suite, Factory Floor checks | §§7, 8 |
| 03:09:27 | `R factory disable` | serve-2 stopped after 24 passes; observer and sampler stopped |

### Executions, cost and duration (this run)

| Execution | Ticket | Ran (UTC) | s | Cost USD | What happened |
|---|---|---|---:|---:|---|
| xbf56af2afc44 | LOCAL-006 (SLICE-005 r4) | 02:27:46–02:30:05 | 139 | 0.7702 | plan station ran twice and wrote no plan: the spec's FR-01 says "under the loan limit" but its matrix has no loan-limit condition, and the refusal order against SLICE-002's limit was undecided. Belt `stuck` → parked at once (F2) |
| x207c3682ca00 | LOCAL-007 (SLICE-005 r6) | 02:33:18–02:33:28 | 9 | not recorded (killed) | killed by me (F3) |
| x0c9e90926c03 | LOCAL-007 | 02:34:19–02:42:50 | 510 | 2.2055 | plan, build T01–T07, verify PASS, review R1 3/3 → AWAITING_HUMAN |
| xc45a6fc6ee86 | LOCAL-005 (SLICE-003) | 02:44:26–02:49:01 | 274 | not recorded (killed) | left LOCAL-005 at `spec-ready`; ran an observe pass, filed LOCAL-008 (factory-tuning) and groomed and began building it (N3); killed by me |
| x6c9eacbac356 | LOCAL-004 (SLICE-006) | 02:47:26–02:54:20 | 413 | 1.9562 | plan, build T01–T05, verify PASS, review R1 3/3 → AWAITING_HUMAN |
| xb72ab32dc3fa | LOCAL-005 | 02:49:47–02:56:46 | 419 | 1.9056 | plan, build T01–T04, verify PASS, review R1 3/3 → AWAITING_HUMAN |
| x7571345ff6d6 | LOCAL-005 | 02:58:54–03:01:22 | 148 | 1.0878 | after the voided approval: re-verify PASS, review `round-1.1` 3/3 → AWAITING_HUMAN |
| **Total** | | | 1,912 | **7.9253 recorded** | plus the two killed executions. Upper bound USD 13.93 (each at its USD 3 cap); x207 ran 9 s, xc45a's workflow had used about 222k tokens when killed |

Costs are the `result` line of each `stream.jsonl` and equal `/api/v1/runs` exactly; tokens equal the sum of each
stream's `modelUsage` (`logs/99-cost.txt`). The run stayed under the USD 20 cap. Durations: first dispatch 02:27:46 to
last merge 03:01:40 is 34 min; the wave's three slices took 18 min (LOCAL-007), 7 min (LOCAL-004) and 17 min
(LOCAL-005, including the conflict) of line time.

## 2. Fixes observed live (F1–F10)

| # | Fix | Observed | Evidence | Result |
|---|---|---|---|---|
| F1 | plan check refuses a plan whose implementation task cannot go green | `check-plan LOCAL-003` on the first run's plan: "T06 [impl] implements FR-01, FR-02, but every [test] task for them (the last is T04) comes before T05 [impl] … Merge T05 and T06 …", rc 1. The re-plan (LOCAL-007, 7 tasks, tests T01–T06 then one impl T07) passed `plan.check` | `logs/10-f1-check-plan.txt`; LOCAL-007 lifecycle seq 5 | PASS |
| F2 | a build that is not progressing is parked at once | happened by itself on the **plan** station, not a build: LOCAL-006's belt reported `stuck` ("the plan station ran twice without moving the ticket on"). Next pass: `execution.failed` `not_progressing: workflow-stuck`, attempt 1 of 2, then `human.required` "Retrying would repeat it." No second attempt | events seq 141–143 | PASS (seen at plan, not build) |
| F3 | a killed execution is recorded as killed with its exit code | `kill -9` at 02:33:28; wrapper `exit_code -9`; next pass `execution.failed` `how: killed`, `exit_code: -9`, attempt 1; attempt 2 started at once and finished the slice. Same again for xc45a (seq 197) | `logs/50-f3-kill.txt`; events seq 166, 197 | PASS |
| F4 | re-review after a voided approval opens `round-N.k` | LOCAL-005: `round-1/decision.json` kept, `outcome: VOID`, the person's approval kept, `void` {reason "The branch changed after it was approved.", approved `17577c7`, branch `5103e16`, by merge station}; the re-review wrote `round-1.1/` (packet, diff, three votes, findings, decision AWAITING_HUMAN). Both are in the archive. It did not count as round 2 | `logs/63-f4-rounds.txt`; `archive/LOCAL-005.tar.gz` | PASS |
| F5 | `release qualify` accepts a contract shared by several slices | `contract.SLICE-001/002/005/006.proto/openapi.yaml`: pass, "Superseded by SLICE-003's reviewed change (LOCAL-005)"; `contract.SLICE-003…`: pass, "Identical to the latest reviewed change to it in this release". Five slices share the one file; no exception needed | `logs/81-readiness-run1.json` | PASS |
| F6 | acceptance binds to the wave as merged at the release commit | PM B holds WAVE-001 as a **draft at revision 5** (shared revision 4). `acceptance record WAVE-001 …` succeeded with `wave_revision: 4`; sent as PR #10; after merge the snapshot reads WAVE-001 `accepted`, source "product/acceptance/WAVE-001.json on the integration branch" | `logs/90-f6.txt`, `93-readiness-after-accept.json` | PASS |
| F7 | sending a revised wave whose earlier PR is merged opens a new PR | WAVE-003's PRs #3 and #4 were merged: PM B's `send WAVE-003` opened **PR #8**. After #8 merged, the SLICE-005 revision's `send` opened **PR #9** | `logs/41-f7-pmb.txt`, `43-s5-revision.txt` | PASS |
| F8 | supervised enable states the execution risk and needs `--accept-execution-risk`; an old authorization reads as needing acceptance | after the upgrade, status: disabled with the acceptance problem. Preview: `execution_risk` with three statements (any program as this user, gates check only what is merged, no OS sandbox) and `tools_digest`. `--confirm` alone: "refused: Supervised mode starts agents with no operating-system sandbox: add --accept-execution-risk …", rc 1, still disabled. With the flag: enabled, `execution_risk_accepted` recorded | `logs/02-status-after-upgrade.txt`, `20-f8-enable.txt` | PASS |
| F9 | a Git-tracked authorization reads as disabled | **On a copy** (`scratch/f9/eng`, remote removed, no local state copied): `enable --autonomy observe` + confirm → `observe`; `git add -f .factory/local/runner.json` + commit → status `disabled`, "The policy file is tracked by Git, so it came from the repository …"; `tick` → `disabled`. Copy disabled after. The real clone was not touched | `logs/30-f9.txt` | PASS (copy) |
| F10 | Factory Floor: killed and released runs, parked reason, readiness | **Readiness:** `/api/v1/release/readiness` and the Pulse line read "Release WAVE-001-WAVE-002-WAVE-003-e6cbbb9a17cb at e6cbbb9a17cb: qualified; product acceptance: not recorded" while the acceptance PRs were open, then "…: accepted" after they merged and the snapshot was re-run. **Parked reason:** before repair the page showed "LOCAL-003 2 execution(s) ended without moving it past 'building'. · a person". `/runs` carries `not_progressing: workflow-stuck` for xbf56; the page's new "Parked: …" words were not seen, because LOCAL-006 was abandoned within a minute of parking. **Released:** xa1b6c30c0e44 `state: released` in `/runs`, left out of X1 ("a claim released without starting (not an execution)"); its claim span still ends `reason: interrupted`. **Killed:** `/runs` `how: killed`, `exit_code: -9`, but `state: failed`; spans `outcome: failed`; Analytics "Failed or killed 4". No page text says "killed" for x207 or xc45a (N6) | `api/readiness-pr-open.json`, `readiness-final.json`, `browser/p1`, `p3`, `p6`, `p7`, `api/runs-0235.json`, `spans-0242.json` | PARTIAL: readiness, parked reason and released PASS; killed FAIL (Minor N6); the new parked words NOT OBSERVED |

## 3. Results by part

### Part 1: repair the stuck slice

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Existing plan refused | F1 | refused | `logs/10` | PASS |
| Documented route back to `spec-ready` | a route in `skills/intent/SKILL.md` or `cell.py` | none. SKILL.md: a `building` ticket "has left grooming … do not change its spec or plan unless the PM asks to regroom it", with no command for it; `cell.py` stages stop at `planned`; `finalize` and `check-plan` do not reopen a built or building cell | `skills/intent/SKILL.md:42`, `cell.py` | FAIL → defect N1 (Major) |
| Smallest step that keeps every gate | abandon on the engineer's decision; dispatch opens a fresh cell | `cleanup --abandon` (6 commits bundled, uncommitted `lending/desk.py` kept as a patch), ticket closed `abandoned`, `intake --reissue SLICE-005` → LOCAL-006, dispatched by the supervisor at `spec-ready` | `logs/11`–`13` | PASS |
| The line plans it again | a plan by the contract-engineer station under the new check | LOCAL-006's planner **refused to plan** on a real spec gap and asked the product owner which refusal a member at the limit gets for an item that is already lent (recommended: the loan-limit message). The engineer cannot answer that. As PM B (a deviation: the product owner's interview was not run, the answer was written into the draft by hand) the recommended answer went into SLICE-005 r6 as FR-03 and a three-rule matrix (`logs/43-SLICE-005-r4-to-r6.diff`), validated `ready` by Product Studio, approved and sent (PR #9). Getting r6 into the line needed N2's hand edit. Then LOCAL-007's planner wrote a 7-task plan that passed `check-plan` and built cleanly | `logs/43`–`48`; LOCAL-007 `plan.md` | PASS, with N2 and deviation 1 |

### Part 2: activation

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Upgrade keeps state, stays disabled | sums equal, disabled | intake ledger and events, tickets, config, `runner.json`: identical SHA-256; disabled with the acceptance problem | `logs/00-pre-state.txt`, `01-post-state.txt`, `02` | PASS |
| Preflight | all required checks | 15 checks ok, including `claude_ready` ("answered inside the execution boundary … no MCP servers") and `security_review` | `logs/20` | PASS |
| Limits as given | as given; no hooks, timer, service; never merges | as given; `git_hooks: []`, `persistent_service` none, `allow_merge: false`, default tool list; no `--dangerously-skip-permissions`, no `--allow-tool` | `logs/20`, `70` | PASS |
| Limits held work | — | 02:44:26 LOCAL-004 held: "the limit of 12 executions in 24 hours is reached": the first run's 9 executions (22:34–23:06 the day before) count | events seq 185 | the limit works; see deviation 2 |

### Part 3: integrate SLICE-005, -006, -003

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Dependency order | S5, then S6 and S3 | S6 and S3 "wait for SLICE-005 to be integrated" until `642dff8`; dispatched 02:44:26 | events 130, 131, 181–185 | PASS |
| SLICE-005 (LOCAL-007) | human gate, merge, cleanup | R1 findings read (0 blockers, 6 notes); approved; merged `642dff8`; archived; closed | `logs/60` | PASS |
| Two at a time | S6 and S3 together | LOCAL-004 and LOCAL-005 running together 02:49:47–02:54:20 | `api/cells-0248.json`, events | PASS |
| SLICE-006 (LOCAL-004) | same | R1 3/3, findings read (0 blockers, 8 notes); merged `5afe9a8` | `logs/61` | PASS |
| SLICE-003 (LOCAL-005) | same; voided approval re-verified and re-reviewed | merge refused (conflict in `proto/openapi.yaml` with SLICE-006). The engineer merged `main` in the cell, kept both additions, and added one line so a returned item leaves the overdue report: without it the merged code raises `KeyError` in `overdue()` once a returned item's due date passes (checked on a modified copy: `logs/97`). The R1 security seat had predicted this as a non-blocking note. Approval voided; the line re-verified and re-reviewed (`round-1.1`, 3/3); merged `e6cbbb9` | `logs/62`, `63`, `97` | PASS |
| Audit when stale | re-audit when told | the supervisor held both slices "the readiness audit is stale" once (02:43:25); re-audited after every merge | events 180 | PASS |
| One kill on purpose | F3 | as F3 | | PASS |
| Build stops progressing | F2 if it happens | it happened at the plan station (F2) | | PASS |

### Part 4: PM side

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Upgrade PM installs | same snapshot | `git pull` then `bin/mach install --no-studio --no-floor` in `pma` and `pmb`: skills unchanged (already at `045d1e1`); the tracked manifest was rewritten, dropping the `mach-studio` entry (N11); restored with `git checkout` | `logs/40-pm-upgrade.txt` | PASS, with N11 |
| F7 | new PR | PR #8, PR #9 | | PASS |
| F6 | acceptance for the later-draft wave | PR #10, accepted | | PASS |
| Acceptance for the other waves | — | PM B WAVE-003 → PR #12 (merged). PM B WAVE-002 → **PR #11 on `product/WAVE-002`, titled as a wave send, carrying `product/slices/SLICE-002.json` revision 5 with the acceptance** (N4); closed unmerged by the engineer. PM A WAVE-002 → PR #13 on `product/WAVE-002-acceptance`, acceptance file only (merged) | `logs/91`, `92`, `94`; PRs #10–#13 | PASS for #10, #12, #13; N4 |

### Part 5: release qualification

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Qualify WAVE-001..003 at the head `e6cbbb9` | honest outcome | **`qualified`**. 55 checks: 54 `pass`, `performance` `not_configured` ("No performance command is declared; not assessed") | `logs/81-readiness-run1.json` | PASS |
| Deterministic | identical bytes | run 1 and 2 SHA-256 `745b479d…`; after the acceptance merges, two more runs at `--commit e6cbbb9`: `431e72f4…` both | `logs/81`, `93`, `95` | PASS |
| Integration command | configured, passes | `release.integration_command: python3 -m unittest tests.test_server -v` (from the first run): `integration_tests` pass. It runs one test; the other HTTP tests run in `suite` | `logs/98-suite.txt` | PASS (narrow command) |
| Scanner reports | under `.factory/release/scans/` | gitleaks 0 findings → pass. osv-scanner: "No package sources found" (rc 128): the project has no dependency manifest, so its "pass" means **nothing was scanned** | `logs/scans/` | gitleaks PASS; osv not assessed in substance |
| Contract check (F5) | pass without exception | pass | | PASS |
| Exceptions | none unless justified | **none recorded** | | — |
| Product acceptance | `not_recorded` until merged | `not_recorded` with PRs open (`api/readiness-pr-open.json`); after #10 and #12: WAVE-001 and -003 accepted, WAVE-002 not ("The recorded acceptance is for release WAVE-002-e325cb6f23ba"); after #13: all three `accepted`, overall `accepted` | `logs/93`, `95` | PASS |

The integration branch head moved on to `9ad895f` with the acceptance merges (product files only). The release
stays bound to `e6cbbb9`.

### Part 6: the integrated product, independently

Tree: `git archive` of `main` at `9ad895f`. The product has no clock control, so the service was started through a
harness of mine (`jtools/launch.py`) that calls the product's own `lending.server.make_server` with a `LendingDesk`
whose `today()` reads a date from a file. Everything else is the product's code. Port 52911, loopback.
Output: `logs/96-journey.txt`.

| Step | Observed | Result |
|---|---|---|
| Add an item | `POST /items` → 201 `{"name":"Drill","tag":"T-1","status":"available"}` | PASS |
| List | 200 with T-1 | PASS |
| Borrow | `POST /loans` alice T-1 on 2026-11-02 → 201 `held 1, due 2026-11-09`; then L-1, L-2 (held 3); `GET /items` shows them `on_loan` | PASS |
| Fourth concurrent loan refused | L-3 → 409 `LOAN_LIMIT_REACHED`, "You already hold 3 items. Return one to borrow another, or ask the desk keeper.", limit 3, held 3 | PASS |
| Return | `POST /returns` T-1 → 200 `available`, held 2; again → 409 `ITEM_NOT_ON_LOAN` "That item is not on loan." | PASS |
| Borrow again after return | alice L-3 → 201 held 3; bob T-1 → 201 | PASS |
| Overdue report | on 2026-11-02: `{"loans":[]}`; clock to 2026-11-12: `GET /loans/overdue` lists L-1, L-2, L-3 (alice) and T-1 (bob), due 2026-11-09, `days_overdue` 3, held and limit; after returning L-1 it is no longer listed | PASS |
| 200 requests against 1,000 items | 1,004 items: `GET /items` p50 0.5 ms, p95 0.5 ms, max 1.0 ms; `GET /loans/overdue` p95 0.2 ms; 0 over 200 ms (one machine, loopback) | PASS |
| Project suite at `9ad895f` | `unittest discover`: 30 tests OK (17.8 s) | PASS |
| Integration tests (the declared command) | 1 test OK | PASS |

### Part 7: Factory Floor, by API and DOM text

| Item | Observed | Evidence | Result |
|---|---|---|---|
| Parked cell and reason before repair | "A person is needed for LOCAL-003: 2 execution(s) ended without moving it past 'building'."; `/factory/status` `held` with the same reason | `browser/p1-pre-repair.txt`, `api/fstatus-pre.json` | PASS |
| Two active cells | `/cells`: LOCAL-004 and LOCAL-005 both open with one execution each; page "→ LOCAL-004", "→ LOCAL-005", both "· berth" | `api/cells-0248.json`, `browser/p4-two-active.txt` | PASS |
| Blocked vs waiting on a person | before repair: SLICE-006/003 waiting on a dependency, LOCAL-003 "a person". At 02:56: "HELD FOR A PERSON · LOCAL-005", "Passed panel · needs a person · 3 of 3". Also listed as waiting: LOCAL-003 and LOCAL-006 "Its ticket … was abandoned. Reissue it to try again", and the floor shows LOCAL-006 "Spec ready" and LOCAL-008 "Building", though all three were abandoned and archived (N7) | `browser/p1`, `p5-awaiting.txt` | PASS, with N7 |
| Station times, one ticket | LOCAL-004: 8 of 8 visits in `/api/v1/spans` equal the archived `lifecycle.jsonl` entered and exited times to the millisecond | `logs/85-spans-vs-lifecycle-LOCAL-004.txt` | PASS |
| Retry and repeat review reconstructable | LOCAL-005 from spans: killed xc45a (attempt 1) → person wait "needed tools that are not allowed: Bash" ended `factory.resumed` → xb72a → R1 → approval wait → `merge#1` `revalidation-conflict` → person wait → x7571 re-verify, re-review (3 seats) → `merge#2` merged. The void itself is not worded: the wait after the conflict reads "It is approved. This machine does not merge unattended", and only the repeat's three seats are listed, not the first R1's | `logs/88-local005-path.txt` | PASS, void not shown |
| Held at a mid-run moment | `#atlas/#timeline/#analytics?at=02:52:00`: LOCAL-004 "Building", "Working now", last activity 02:51:44 (true), round open 2 min 27 s (true), nothing from 02:52:01 on (build exit, verify, review). Analytics says it counts "through the end of 14 Nov (UTC), the last whole day before the playhead" and shows the first run's figures only, as stated | `browser/p8-held-0252.txt` | PASS |
| Cost and tokens | `/api/v1/runs` cost equals each stream's `total_cost_usd`; tokens equal the streams' `modelUsage` sums; killed executions `usd: null` "no result was read". Analytics "$15.22 recorded, a lower bound" leaves out the failed executions' known cost (xbf56 USD 0.77 and the first run's USD 0.44): D7 is still open | `logs/99-cost.txt`, `api/metrics-final.json` | API PASS; Analytics as known (D7) |
| Readiness line | F10 | | PASS |
| Integrated never shown as accepted until merged | "product acceptance: not recorded" with PRs #10–#12 open; "accepted" only after the merges and the re-run snapshot | `browser/p6-pr-open.txt`, `p7-accepted.txt` | PASS |
| Page closed for a minute mid-run | closed 02:40:08, reopened 02:41:15 (67 s). Meanwhile LOCAL-007's lifecycle went 16 → 21 lines, its stream 230 → 314 kB, `claude -p` still running | `logs/55-page-closed.txt` | PASS |

### Part 8: finish

| Item | Observed | Result |
|---|---|---|
| `factory disable` | 03:09:27; `still_running: []`; serve-2 exited "the Factory was disabled" after 24 passes | PASS |
| Nothing of mine running | no `claude -p`, `factory serve`, `mach-observer`, sampler, journey server | PASS |
| No `.factory` in `mach-harness`, `-m66`, `-m7` | none | PASS |
| Project left in place | engineer clone `enabled: false`; no Git hooks; no LaunchAgent. `.factory/release/` is untracked (D13, still open) | PASS |

## 4. Final state of the wave

| Slice | Ticket | Merged | Release `e6cbbb9` | Product acceptance |
|---|---|---|---|---|
| SLICE-001 List and add items | LOCAL-001 | `dc35b1a` (first run) | pass | WAVE-001 accepted |
| SLICE-002 Loan limit | LOCAL-002 | `fb1ba66` (first run) | pass | WAVE-001 and WAVE-002 accepted |
| SLICE-005 Borrow an item (r6) | LOCAL-007 (LOCAL-003, -006 abandoned) | `642dff8` | pass | WAVE-003 accepted |
| SLICE-006 Return an item (r6) | LOCAL-004 | `5afe9a8` | pass | WAVE-003 accepted |
| SLICE-003 Overdue report (r6) | LOCAL-005 | `e6cbbb9` | pass | WAVE-003 accepted |

All five slices of WAVE-001, -002 and -003 are integrated, qualified and accepted. SLICE-004 ("Reserve an item
ahead") is still being defined in a PM workspace and was never in a wave.

## 5. Defects

Severity as in the brief: **Blocker** stops end-to-end qualification with no workaround; **Major** gives a wrong
result, loses a record, or needs a person's unplanned workaround; **Minor** is wrong or misleading but harmless.

| # | Severity | What | Evidence |
|---|---|---|---|
| N1 | Major | **No route to re-plan a parked cell.** A `building` ticket whose plan is wrong can only be abandoned and reissued (new ticket, new cell, the old branch in a bundle). SKILL.md mentions regrooming "if the PM asks", with no command. It worked here, at the cost of a ticket and a person's unplanned step | §3 part 1; `skills/intent/SKILL.md:42` |
| N2 | **Blocker** (for MACH's own commands) | **A revised definition cannot reach the line once the earlier ticket was in work.** Intake classifies the slice `modified`; for a ticket that is `abandoned` it falls to "work in progress" and reports `needs_person` on every pass (`intake.py` ~735). `--reissue` only applies to an unchanged revision (`known`, ~698), and Product Studio cannot withdraw a slice from an approved wave ("Only a draft wave can be changed"). The only way on was a hand edit of `.factory/intake/ledger.json` (SLICE-005 `state: superseded`), which leaves no ledger event for the observer. Workaround ordering that would have avoided it: abandon and reissue *before* the revision is merged | `logs/44`–`48`; `48-ledger-before.json` |
| N3 | Major | **The belt runs an observe pass and a factory-tuning ticket inside an execution dispatched for another ticket.** LOCAL-005's execution did not plan LOCAL-005 (its first agent was refused a Bash command with a variable). It then ran `/mach:observe --auto` (5 finished tickets), which filed LOCAL-008 (High, SLICE-007), groomed it and began building it. No dispatch authorized LOCAL-008; it spent LOCAL-005's budget; the supervisor then parked LOCAL-005 for "needed tools that are not allowed: Bash". The belt does this by design (`belt.js` "Learn"), but under supervised execution it is work outside the ticket the person's authorization named | `logs/71`; LOCAL-008 archive; events 196–199 |
| N4 | Major | **An acceptance send published a slice draft.** In PM B's workspace (SLICE-002 a draft at r5 from the first run's reopen), `send WAVE-002` after `acceptance record` pushed to `product/WAVE-002`, titled "WAVE-002, 1 slice approved for engineering", with `product/slices/SLICE-002.json` revision 5 next to the acceptance. Merging it would have bumped an integrated slice and opened follow-up work. PM A sent the same acceptance alone (PR #13). PR #11 closed unmerged | PR #11; `logs/91`, `92`, `94` |
| N5 | Minor | `release qualify` reports `qualified` with `performance: not_configured` and an osv-scanner report that scanned nothing (no package sources, rc 128). Both are shown as such per check, but the outcome line does not say a check was not assessed | `logs/81`, `logs/scans/osv.log` |
| N6 | Minor | **A killed execution reads as failed** in spans (`outcome: failed`) and on the page ("Failed or killed"); only `/runs` carries `how: killed`. The fix assumed `execution.completed` with `how: killed`; the supervisor now writes `execution.failed`. A released claim's span ends `reason: interrupted` | `api/runs-0235.json`, `spans-0242.json`, `browser/p3` |
| N7 | Minor | **Abandoned tickets stay "waiting for a person".** `factory status` and `resume` keep LOCAL-003 and LOCAL-006 under `waiting_for_a_person` after both were abandoned and closed; the page repeats it ("Reissue it to try again", even after the reissue) and shows the abandoned cells LOCAL-006 "Spec ready" and LOCAL-008 "Building" | `logs/72`, `A0-final-status.txt`; `browser/p5` |
| N8 | Minor | D7 still open: Analytics cost leaves out `execution.failed` costs; killed executions have no cost at all, so real spend is unknown (here up to USD 6 more) | `logs/99-cost.txt` |
| N9 | Minor | D13 still open: `.factory/release/` is not in the installer's ignored block | `git status` |
| N10 | Minor | The daily execution limit and day budget count the previous day's executions within 24 h; the brief's `--max-runs-per-day 12` held LOCAL-004 after four executions of this run. Working as designed; recorded because it forced deviation 2 | events 185 |
| N11 | Minor | `mach install --no-studio` in a clone whose tracked manifest lists `mach-studio` rewrites the manifest, leaving the clone dirty | `logs/40` |
| N12 | Minor | A cross-slice defect (a returned item would break the overdue report) was predicted by the R1 security seat as a non-blocking note and is caught by no test; only the textual conflict brought a person to the merge. Had the merge been clean, it would have merged | LOCAL-005 `round-1/findings.md` note 3; `logs/97` |

Not defects: the plan station's refusal of SLICE-005 r4 was right (the spec left the refusal order undecided), and the
review panels raised no blockers in this run (every round was 3/3 first time).

## 6. Deviations from the instructions

1. **SLICE-005's spec was revised by hand as PM B**, answering the plan station's question with its own recommended
   answer (loan-limit refusal first: FR-03, matrix R1–R3, AC-03). No interview was run. Validated by Product Studio,
   sent and merged through its normal path.
2. **Limits raised mid-run:** `--max-runs-per-day 12 → 24` and `--budget-per-day 20 → 28` (others unchanged), by
   disable and re-enable with `--accept-execution-risk`, because the first run's executions counted against the day.
   28 − 8.50 (first run) = 19.50 kept this run inside the USD 20 cap.
3. **A second `claude -p` was killed** (xc45a, LOCAL-005) because it was building the tuning ticket (N3); LOCAL-008
   was abandoned and closed as out of scope, then `factory resume --retry LOCAL-005`.
4. **Hand edit of `.factory/intake/ledger.json`** (N2), with the Factory paused; backup kept.
5. **The engineer's merge commit `5103e16` changed one line of code** (`return_item` clears the due date) besides
   resolving the contract conflict. The line re-verified and re-reviewed it.
6. **PR #11 closed** as the engineer (N4); the brief did not foresee it.
7. The observer's one-time link was printed once to my terminal log (`logs/observer.out`, a loopback token, used
   once).
8. The journey started the service through a clock harness (`jtools/launch.py`) because the product has no clock
   input; it calls the product's own server and desk.

## 7. Not done or not shown

- The Factory Floor's new "Parked: …" words for `not_progressing` were not seen on the page (the parked ticket was
  abandoned within a minute); the code is in `/runs`.
- The void of an approval is not worded on the page (known from the first run's notes).
- osv-scanner had nothing to read; no dependency scan of substance. `performance_command` not configured.
- Only one run; nothing repeated for stability. A local multi-clone test on one Mac, not separate machines.
- No screenshot or video was examined; pages were checked by DOM text only.

## Corrected after the run

- **N4** (not committed; unit tests only, not re-run live): an acceptance publication now holds exactly `product/acceptance/<WAVE-ID>.json`, checked before the push against the built commit's diff, on `product/<WAVE-ID>-acceptance` with the title "Product acceptance for <WAVE-ID> at <commit>". The definition and the acceptance are separate publications; `send` reports `published` and `still_unsent`, and `send --acceptance` sends the decision alone. `tests/test_release_qualify.py` (a later slice draft pending: the published branch differs from main by one file).
- **N5** (not committed; unit tests only): a scanner report that records an error, an exit code other than 0 or 1, or zero scanned sources is `not_run`, so the security check is incomplete. `outcome_summary` names optional checks not assessed, e.g. "qualified; not assessed: performance (not configured)". `tests/test_release_qualify.py`.
- **N1** (not committed; unit tests only, not re-run live): `cell.py replan <ticket> --reason "<why>"`, run only when a person explicitly asks (`skills/intent/SKILL.md` step 5), returns a `planned` or `building` cell to `spec-ready`. It keeps `plan.md`, `build.json` and `build-report.json` under `plan-history/<n>/` with a `replan.json`. If the branch has moved, it saves the old tip as `refs/mach/replan/<ticket>/<n>` and then resets the branch to the commit recorded at `spec-ready` (now kept as `spec_commit` in `cell.json`). It writes `gate.evaluated` `plan.replan` (and `station.exited` build `replanned`) to the lifecycle log and adds no judging round. It refuses: a judged cell (build loop above 0, a review round or a verification verdict), task work already on main, uncommitted changes, commits that are not the plan's tasks, contracts or merges of main, other stages, and an empty reason. `run.py next` then says `plan`. `tests/test_cell.py` `ReplanTest`.
- **N3** (not committed; stand-in `claude` and unit tests only, not re-run live): inside a supervised execution (`MACH_EXECUTION_ID`), `run.py` reads the execution's ticket from the intake ledger, where the supervisor recorded it at claim. `next`, `review-start` and `review-tally` for any other ticket are refused. `board` lists only that ticket and reports `observe_due: false`, `factory_tuning_ready: []` and `scoped_to`, so the belt's Learn phase starts neither an observe pass nor a tuning ticket. A cleanup step's prompt tells the worker not to run observe. An execution the ledger does not know may work on nothing. The supervisor itself checks whether a pass is due. No setting authorizes it to run one, so it says `human.required` (no ticket) once for each count of finished tickets and reports `observe_due`; it starts nothing. A person-started belt and `/mach-run` are unchanged. `tests/test_mach_factory_supervisor.py` `ExecutionScopeTest`. The observe skill itself does not check the scope: a worker that ignored the prompt and ran `/mach:observe` directly would still be stopped from building the tuning ticket by `next`, but could file one.
- **N6** (not committed; Go and web unit tests from the run's records, not re-run live): an execution with `how: killed` is `killed` whether the supervisor wrote `execution.completed` (it moved the ticket) or `execution.failed` (it did not). That covers `/runs`, the span's `outcome` and `attrs.state`, the floor ("Killed (exit -9)"), the Timeline's stopped words and the retries lens ("killed (exit -9)"). The span's `attrs.exit_code` carries the code. Analytics keeps counting it with failures under "Failed or killed", and the outcome chart's footnote now says so. A released claim's span now ends with reason `released`, not `interrupted`; the Timeline reads that reason. Against a copy of the run's project, x207c3682ca00 and xc45a6fc6ee86 read `killed`, exit -9. `apps/observer/internal/project/m7_n6n7_test.go`, `web/apps/factory-floor/test/m7-n6-n7.test.mjs`.
- **N7, the page half** (not committed; unit tests only): cleanup's abandon run record marks the cell `abandoned`. A reissue (intake materializing the same slice under another ticket, unless the earlier work was integrated) adds `reissued_as` to the earlier cell. A person gate for an abandoned or reissued ticket is closed `abandoned`, including one asked after the abandonment. The page drops it from the waiting list and the inspector says "Abandoned, reissued as LOCAL-006". Against the run's copy: LOCAL-003 is abandoned and reissued as LOCAL-006, LOCAL-006 as LOCAL-007, and LOCAL-008 is abandoned. The cell plate's stage word, drawn by `@mach/ui`, still shows the last recorded stage; the mast and the inspector say Abandoned. Same tests.
- **N2** (not committed; unit tests only, including one replaying this run's ledger, events, run records and ticket states at the moment of the hand edit with discovery simulated; not re-run live): when a slice's earlier ticket has no live cell, cleanup's run record says `abandoned` and the tracker says `closed`, the next `product intake` takes the newer approved revision in as a new ticket and records that it follows the abandoned one and why (on the recorded state above it files LOCAL-007 for SLICE-005 r6, as the hand edit did). Abandoned but still open: intake asks a person to close the ticket. Work still in the line is flagged as before, and a person settles it with `run.py product resolve <SLICE-ID> --supersede-in-work "<why>"` (only on a person's explicit instruction), which records the in-work revision as superseded with who and why, leaves its cell and ticket untouched, and takes the new revision in; the plan lists it under `superseded_revisions`, never dispatchable. Intention before effect throughout; a test interrupts between filing and recording and reruns: nothing is filed twice. An interrupted `--reissue` could previously adopt the abandoned ticket by its marker; reissues now carry their own marker. See `M3_DESIGN.md` D6, "M7 correction".
- **N7, the status half** (not committed; unit tests only): `factory status` and `resume` list a parked ticket that is abandoned (run record) and closed (tracker) under `no_longer_waiting`, not `waiting_for_a_person`, with "reissued as <ticket>" when the ledger knows the ticket that replaced it (on this run's records: LOCAL-003 as LOCAL-006, LOCAL-006 as LOCAL-007).

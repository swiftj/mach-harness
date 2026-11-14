# M7 Factory acceptance: one supervised run on a real product (Phases 2, 3, 7 and 8)

Status: run complete, Factory disabled, nothing left running. One live run, 2026-11-14 22:31–23:12 UTC, on the
throwaway "Team Lending Desk" project the Product Manager half built (`M7_PM_ACCEPTANCE.md`). Everything below was
run once. Where a check was done on copied records instead of the live line, it says so.

**Headline.** The supervised line built, verified, reviewed and (after a person's approval) integrated two of the
five slices, SLICE-001 and SLICE-002 (WAVE-001), in 9 executions costing **USD 8.50 recorded** (one killed execution
has no recorded cost). Each of those two tickets went through a real rejection and revision. Integrating them hit a
real merge conflict that a person resolved; the line then re-verified and re-reviewed the result. SLICE-005 stopped on
a plan defect after three executions and was parked for a person. SLICE-006 and SLICE-003 depend on SLICE-005, so they
never started. No defect is rated Blocker, because every one had a workaround. Five are Major: D1 to D5.

## 1. What was run

| | |
|---|---|
| MACH | `git archive` of the M7 worktree HEAD `c73c11e537c69f8f9fd528a9c7805a5480645252` (clean tree) into `scratch/src` |
| Observer | built from that snapshot with `apps/observer/build.sh` (`SKIP_INSTALL=1`, node_modules cloned in), Control Tower embedded, no source maps; `scratch/bin/mach-observer` |
| Project | engineer clone `scratchpad/m7/agents/pm/world/eng`, remote `github.com/swiftj/mach-m7-acceptance` (private, throwaway) |
| Engineer identity | `GIT_CONFIG_GLOBAL=world/home-eng/.gitconfig` ("Engineer (M7 simulated)"); real HOME kept so Claude Code is signed in |
| Toolchain | macOS 27.2 arm64, Python 3.15.2, Go 1.27.3, Node 25.8.2, git 2.52.0, gh 2.86.0, Claude Code 2.1.323, gitleaks 8.30.1, osv-scanner 2.7.0 |
| Scratch | `scratch` = `/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m7/agents/live`; logs in `scratch/logs/`, observer samples in `scratch/samples/` (73, every 30 s), page samples in `scratch/browser/`, API snapshots in `scratch/api/` |

The real dependency graph differs from the brief's. The brief said "S3 and S4 depend on S2". In this project
SLICE-001 (LOCAL-001) and SLICE-002 (LOCAL-002) depend on nothing. SLICE-005 "Borrow" (LOCAL-003) depends on both of
them. SLICE-006 "Return" (LOCAL-004) and SLICE-003 "Overdue report" (LOCAL-005) depend on SLICE-005.

Every slice turned out **High** risk at its plan station, because each one changes the existing `proto/openapi.yaml`.
High risk means a unanimous 3-of-3 panel on the contracts tier plus a person's approval.

### Commands (in order; `R` = `run.py --project <eng>`, `S <station>` = that station's script)

| UTC | Command | Result |
|---|---|---|
| 22:31 | `bin/mach install --project <eng> --no-studio --no-tower` (from the snapshot) | 12 files updated, `qualify.py` created; committed `a567ec9` and pushed |
| 22:32:45 | `R factory status` | disabled, no `runner.json` |
| 22:33:06 | `S audit run --json` | Gold 93 |
| 22:33:09 | `R factory enable --autonomy observe` | preflight 11/11 ok, code `e9756e`, **nothing enabled** |
| 22:33:15 | `R factory enable --confirm e9756e` | observe enabled |
| 22:33:27 | `R factory tick` | both ready slices held: "observe mode, which never starts work" |
| 22:33:3x | `R factory disable`; `enable --autonomy supervised --max-parallel 2 --max-runs-per-day 8 --budget-per-run 2.5 --budget-per-day 14 --max-attempts 2 --max-minutes 30 --max-risk Medium --include-backlog`; `--confirm 7150f7` | supervised, merging off, no hooks, no service, no fetch |
| 22:33:4x | commit `factory.max_parallel: 5`; `R factory status` | in force 2 (`project 5, machine_policy 2`) |
| 22:33:5x | commit `review.medium.reviewers: 1`; `S audit run`; `R factory tick` | both held, with the reviewers message (part 1) |
| 22:34:1x | `git revert` both (`efbdf08`), push, `S audit run` | config identical to `a567ec9`; Gold |
| 22:34:28 | `R factory serve --interval 60` (background, "serve-1") | LOCAL-001 and LOCAL-002 started 22:34:29 |
| 22:35–22:36 | PM revision of SLICE-003 (part 5); `gh pr create/merge` #4; `git pull`; `R product intake` | LOCAL-005 r4 → r6 |
| 22:36:51 | `git fetch`; `R product intake`; `S audit run` | nothing created; Gold @77a3f2e |
| 22:37:07 | `kill -9` supervisor; `R factory tick`; `factory serve` ("serve-2") | both found "still running" |
| 22:37:26 | `kill -9` LOCAL-002's `claude -p` | exit -9 after 176 s |
| 22:43:29–39 | `R factory disable`; `enable ... --max-risk High` (otherwise the same limits); `--confirm 049670`; `serve` ("serve-3") | see the deviation note below |
| 22:45:4x | `review.py approve-human LOCAL-001`; `merge.py run --by-person LOCAL-001`; `cleanup.py run LOCAL-001`; ticket closed; push; audit | merged `dc35b1a` |
| 22:51 | LOCAL-002: `approve-human`; `merge.py run --by-person` | refused: conflict with SLICE-001 in `lending/server.py`, `proto/openapi.yaml` |
| 22:51 | engineer merges `main` into `feature/LOCAL-002` in the cell and resolves it (`206cd6d`, 18 tests pass); `merge.py run --by-person` | approval voided, back to `built`; the line re-verified and re-reviewed |
| 22:55:0x | `approve-human`, `merge --by-person` (`fb1ba66`), `cleanup`, close, push, audit | WAVE-001 integrated |
| 22:55–23:00 | `R release qualify WAVE-001` (×2), config commit `e325cb6`, `tools/scan.sh`, `release qualify` (×2), `release except`, `release qualify` (×2), WAVE-002 qualify, PM acceptance and send, PR #5, qualify | part 6 |
| 23:03 | `S audit run` (the supervisor was holding LOCAL-003: "audit is stale") | retries began (part 4) |
| 23:09 | `R factory disable` | serve-3 exited after 27 passes; nothing running |

Deviation: at 22:43 the engineer raised `--max-risk` from Medium to High, with the other limits unchanged. Under
Medium, every ticket here (all High after planning) would have been held for a person, so nothing past the first
two plans could run. High-risk tickets still need the unanimous panel and a person's approval, so no gate was
weakened. `allow_merge` stayed off throughout.

### Executions, cost and duration

| Execution | Ticket | Ran (UTC) | s | Cost USD | Agents | What happened |
|---|---|---|---:|---:|---:|---|
| xcf4d4618db51 | LOCAL-001 | 22:34:29–22:43:08 | 518 | 2.5173 | 28 (3 error) | plan, build, verify PASS, review R1 REJECTED, revise, verify PASS, R2 seated; ended at the per-run budget (2.5173 > 2.5) mid-review |
| xf4a33789d169 | LOCAL-002 | 22:34:29–22:37:26 | 176 | not recorded | 7 | **killed by me** (SIGKILL) during build |
| xba443cccb3c7 | LOCAL-001 | 22:43:45–22:45:09 | 84 | 0.8047 | 11 | review R2: 3/3 approve → AWAITING_HUMAN |
| xda0731d2fff8 | LOCAL-002 | 22:43:45–22:50:21 | 395 | 2.3024 | 25 | build resumed, verify PASS, R1 REJECTED (security blocker, medium impact), revise, verify PASS, R2 AWAITING_HUMAN |
| x6ec20aecad59 | LOCAL-002 | 22:51:50–22:54:54 | 183 | 1.3295 | 13 | re-verify and re-review after the person's conflict fix → AWAITING_HUMAN |
| x69c59a36f2d5 | LOCAL-003 | 22:55:54–23:02:06 | 372 | 1.1097 | 13 | plan, build T01–T04; `build.green` refused ×3 (plan defect); belt "stuck" |
| x4e27653da783 | LOCAL-003 | 23:04:01–23:05:57 | 116 | 0.2441 | n/a | stuck again → `execution.failed` attempt 1 |
| xcd07441a6874 | LOCAL-003 | 23:06:02–23:08:00 | 118 | 0.1945 | n/a | stuck again → attempt 2 → parked for a person |
| xa1b6c30c0e44 | LOCAL-003 | claimed 23:03:00 | — | — | — | held (audit stale) and released, never started |
| **Total** | | | 1,962 | **8.5022** recorded | | plus xf4a33789d169's spend, which is unknown: its own stream shows about 35k opus tokens; its agents' spend is not recorded |

Costs come from the `result` line of each `stream.jsonl`, and are equal to `/api/v1/runs` (`logs/86-cost-tokens.txt`).
Spend stayed under the USD 14 cap. The run stopped at USD 8.50 because SLICE-005 needed a person, not because the
cap was reached.

Test-first evidence. The run records (`archive/runs.jsonl`) give `tests_seen_failing_first: 6` for both LOCAL-001
and LOCAL-002 and `tests_passing_on_first_run: 0`, with the plan's tasks done in order (LOCAL-001: T01–T08 and the revision tasks R1-T01..T03; LOCAL-002: T01–T06 and R1-T01..T03). Verification evidence kind
for both was a "request and response dump" (`consumer-run.log`, `loans-run.log`): 7 and 4 checks passed, 0 unproven
(`logs/82-per-ticket-facts.txt`). Review: LOCAL-001 R1 rejected by architecture and security, R2 3/3. LOCAL-002 R1
rejected by security, R2 3/3, then the R2 re-review 3/3.

## 2. Results by part

### Part 1: activation

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Upgrade over a project with intake state | ledger, events, tickets and config unchanged; still disabled | SHA-256 of `intake/*`, `tickets/*`, `config.json` identical before and after; no `.factory/local/` | `logs/00-pre-upgrade-sums.txt`, `01-post-upgrade-sums.txt`, `01-upgrade.txt` | PASS |
| Disabled after upgrade | disabled | "The Factory is disabled on this machine…" | `logs/10-activation.txt` 22:32:45 | PASS |
| `enable` without `--confirm` | nothing enabled | `enabled: false`, code printed; status still `disabled`, `pending_activation: true`; no `runner.json` | same, 22:33:09 | PASS |
| Preflight | listed checks | 11 checks, all ok (project, intake, repository, checkout, local state private, toolchain, Claude, workflow, resources, ownership, project allows). The `security_review` check is not printed when it passes; it showed up as a refusal in the reviewers test | same | PASS |
| Observe mode | takes in and plans, starts nothing | tick: both ready slices held, "observe mode, which never starts work"; no `executions/` folder; no `claude -p` process | `logs/13-observe-tick.txt` | PASS |
| Supervised with the given limits | limits as given; no hooks, timer or service; merging off | `runner.json` limits as given; `git_hooks: []`; no LaunchAgent; "Never merges"; tool list is the default | `logs/10-activation.txt` | PASS |
| Tracked `factory.max_parallel: 5` | local ceiling holds | `max_parallel_from: project 5, machine_policy 2, in_force 2` | `logs/14-ceiling.txt` | PASS |
| Tracked `review.medium.reviewers: 1` | supervisor refuses with its message | status `restricted_by_project` and tick: both slices held: "review.medium.reviewers is 1: Medium-risk tickets would be reviewed without the security seat. Unattended execution is refused while that is so; a person can still run that ticket by hand (/mach-run)." Nothing started (audit was fresh, so the hold was not the audit) | `logs/14-ceiling.txt` | PASS |
| Both reverted | config as before | `git diff a567ec9 -- .factory/config.json` empty after `efbdf08` | — | PASS |

### Part 2: construction

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Two at a time | S1 and S2 together | both started 22:34:29; again 22:43:45 | events seq 30–33, 59–63 | PASS |
| Dependents wait | S5 until S1 and S2 integrated; S6, S3 until S5 | S5 dispatched 22:55:54, right after S2 merged (`fb1ba66`); S6 and S3 "waits for SLICE-005" to the end | `logs/63-plan-2247.json`, events seq 94–97 | PASS |
| Belt workflow | one `mach:belt` per execution | `workflow: mach:belt` on every run in `/api/v1/runs` | `api/runs-2309.json` | PASS |
| Sampling | plan and API every 30 s | 73 samples 22:34–23:10 | `samples/` | PASS |
| Per-execution record | ticket, cell, workflow, agents, test-first, gates, verdict, review, cost | execution table above | `logs/82`, `86`, `api/agents-*.json` | PASS |
| Gate refusals in `lifecycle.jsonl` | recorded | LOCAL-001: `build.start` audit-stale, `review.submit` findings-invalid ×2. LOCAL-002: `merge.land` revalidation-conflict, `merge.run` approval-void. LOCAL-003: `build.green` suite-red ×7, `build.start` already-started ×4 (over its three executions) | `logs/82`, cell lifecycle | PASS |

### Part 3: human gates and integration

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| LOCAL-001 | read findings, approve, merge by person, clean up | R2 findings read (0 blockers, 5 notes); approved 22:45:4x; merged `dc35b1a`; archived; closed | `logs/60`, `61` | PASS |
| LOCAL-002 | same | approved; **merge refused: conflict with SLICE-001** in `lending/server.py` and `proto/openapi.yaml`. The engineer resolved it in the cell (routes `/items` and `/loans`, both stores; the loans `Error` schema renamed `LoanError`); 18 tests pass. Merge voided the approval; the line re-verified and re-reviewed (3/3); approved; merged `fb1ba66`; archived | `logs/64`, `65`, `scratch/logs/server.py`, `openapi.yaml` | PASS |
| Audit re-run when stale | supervisor says so | held "the readiness audit is stale" twice (LOCAL-001 build.start; LOCAL-003 at 23:03); re-run each time | events seq 106 | PASS |
| LOCAL-003, -004, -005 | integrate if budget allows | LOCAL-003 parked for a person (plan defect, D5). LOCAL-004 and LOCAL-005 never started: they wait on SLICE-005 | events seq 116–118 | NOT DEMONSTRATED: SLICE-005, -006 and -003 not integrated. Reason: SLICE-005 needs a person to fix its plan; the other two depend on it. Not the budget (USD 8.50 of 14 spent) |

### Part 4: remediation

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Natural rejection and revision | line revises by itself | LOCAL-001: R1 REJECTED (2 blockers) → revise → verify PASS → R2 3/3. LOCAL-002: R1 REJECTED (security blocker) → revise → R2 3/3 | `logs/82` | PASS (a real Factory event) |
| Merge revalidation | conflict stops for a person; re-verify and re-review after | as expected; the re-review reused round 2 and overwrote its records (D3) | LOCAL-002 lifecycle seq 49–77 | PASS, with D3 |
| A stuck build | bounded retries, then a person | the first stuck execution counted as completed (it had moved spec-ready → building); then two `execution.failed` (attempts 1, 2); parked "2 execution(s) ended without moving it past 'building'" | `logs/83-local-003.txt` | PASS, with D9 |
| Corrected review gate: **a gate test on copied real records, not a Factory event** | an architecture-seat blocker with `class: security, impact: high` rejects; without the class it is outvoted at Medium | Two copies (`scratch/gatetest/A`, `B`) of the project made right after LOCAL-001's real round 2 (3/3). In each copy: the architecture vote and decision removed, and `packet.approvals_needed` set from 3 to 2 (the Medium threshold, because every real ticket here is High). Then architecture submitted its real round-2 findings plus one blocker ("Catalogue growth is unbounded", `lending/server.py:28`, rule "REVIEW.md Security and performance: No unbounded loops, queries or memory growth"). **A (no class): AWAITING_HUMAN, 2 of 2, blocker outvoted. B (security, high): REJECTED, `security_blockers: 1`**, and `findings.md` marks it "rejects the round whatever the count". The real project was untouched | `gatetest/RESULT.txt`, `gatetest/*/eng/.factory/worktrees/LOCAL-001/review/round-2/decision.json` | PASS |

### Part 5: recovery

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| SIGKILL the supervisor mid-run, restart | claims accounted for; nothing dispatched twice | after the kill both wrappers stayed alive (ppid 1). Restart tick: `recovered: LOCAL-001 "still running", LOCAL-002 "still running"`; `dispatched: []`, `started: []`; `recovery.started kind still-running` ×2 | `logs/40-recovery.txt`, events 42–47 | PASS |
| Kill one `claude -p` | next pass must not blindly repeat it; attempt counting | wrapper wrote `exit_code -9`, 176 s. Next pass recorded `execution.completed` (it had moved spec-ready → building), so the attempt count was cleared, and held it ("risk tier High") rather than repeating. After re-enable, a new execution resumed at **build** (attempt 1); the build visit `build#1` runs on across both executions | `logs/41-kill-exec.txt`, events 48–49, 61 | PASS, with D8 |
| Same wave delivered again | no duplicate | `git fetch` (only new remote branches), `intake`: `unchanged` ×5, still 5 tickets | `logs/31-redeliver.txt` | PASS |
| Product revision during construction | waiting ticket takes it; line unchanged | while LOCAL-002 was building: PM B reopened SLICE-003, revised FR-01 and AC-01 ("days overdue"), approved, sent (D1: sent onto the merged PR #3; PR #4 opened and merged by hand). `intake`: `LOCAL-005 r4 → r6, ticket updated`; LOCAL-001..004 ticket hashes and cells unchanged | `logs/30-*`, `ev/pm-pm*.jsonl` | PASS, with D1 and D12 |
| Missed notification | timer reconciliation | no hooks installed, so the timer is the only path. The supervisor's 60 s pass found each new main commit by itself (`revision.discovered` seq 98, 103) and released LOCAL-003 once SLICE-002 was integrated. The revision itself was taken in by an explicit `intake`. **What was tested is reconciliation on the timer, not a lost hook** | events | PASS (as stated) |

### Part 6: release qualification

| Item | Expected | Observed | Evidence | Result |
|---|---|---|---|---|
| Qualify WAVE-001 at the head (`fb1ba66`) | `incomplete` (no integration command, no scans) | **`blocked`**: `contract.SLICE-001.proto/openapi.yaml` failed, "The integrated file differs from the version review approved for this slice", because SLICE-002 later changed the shared contract (D2). Also `integration_tests not_configured`, `security.scan not_run`, `performance not_configured` | `logs/70-release.txt`, `71-readiness-run1.json` | FAIL against expectation (D2); otherwise honest |
| Deterministic | identical bytes | two runs: SHA-256 `0d3c4c9a…0dc878` both, `cmp` identical. Again at `e325cb6` (`73-readiness-e325-a/b.json`) | `logs/71`, `73` | PASS |
| Integration command and scans | configured and pass | committed `release.integration_command: python3 -m unittest tests.test_server -v` (the module that drives the real server over HTTP) → `e325cb6`. `gitleaks dir` and `osv-scanner scan source -r` on that commit's tree → `.factory/release/scans/`. Integration tests **pass**; gitleaks 0 findings; osv-scanner **found no package sources** (no third-party dependencies) and its report has 0 findings, so the "pass" means nothing was scanned | `logs/scans/*` | PASS (osv: nothing to scan) |
| Outcome at `e325cb6` | — | still `blocked` (D2). A person's exception for that one check (`release except`, reason: the integrated file is byte-identical to the one LOCAL-002's final review approved, `206cd6d`, checked with `git diff`) → **`qualified_with_exceptions`** | `logs/70` | PASS with exception |
| Product acceptance | `not_recorded` before merge, `accepted` after, never inferred | WAVE-001: **cannot be recorded** in either PM workspace (D4). WAVE-002 (SLICE-002 only, integrated): qualified at `e325cb6`; PM A `acceptance record … --decision accepted --by product-owner` and `send` → PR #5. Snapshot with PR #5 open: `not_recorded` (22:59:41). After merge: `accepted`, source "product/acceptance/WAVE-002.json on the integration branch" (22:59:56). Outcome unchanged (`qualified`) | `logs/74`, `75` | PASS for WAVE-002; NOT DEMONSTRATED for WAVE-001 (D4) |

### Part 7: does the integrated product work (independent check)

Run on `git archive main` at `7c51fd6` (S1 + S2) with `scratch/tools/journey.sh`, on 127.0.0.1:52811. Separate from the
Factory's own verification. Output: `logs/80-journey-wave1.txt`.

| Step | Observed | Result |
|---|---|---|
| Add an item | `POST /items` → 201 `{"name":"Drill","tag":"T-1","status":"available"}` | PASS |
| List | 200 with the item | PASS |
| Borrow | `POST /loans` (SLICE-002's endpoint) → 201 held 1, 2, 3 | PASS (S2's loan-limit borrow only) |
| Fourth concurrent loan refused by the shared limit | 409 `LOAN_LIMIT_REACHED`, "You already hold 3 items. Return one to borrow another, or ask the desk keeper.", limit 3, held 3 | PASS |
| Item shows as on loan | still `available` after the loans | NOT INTEGRATED (that is SLICE-005 "Borrow an item") |
| Return | `POST /returns` → 404 | NOT INTEGRATED (SLICE-006) |
| Overdue report | `/overdue`, `/reports/overdue` → 404 | NOT INTEGRATED (SLICE-003) |
| NFR: 200 requests against 1,000 items | 1,004 items: p50 0.4 ms, p95 0.5 ms, max 0.7 ms, 0 over 200 ms (one machine, loopback) | PASS |

### Part 8: Control Tower against the records

| Item | Observed | Evidence | Result |
|---|---|---|---|
| Incoming work | Floor: "3 waves, latest WAVE-003", intake lists SLICE-001→LOCAL-001, SLICE-002→LOCAL-002, SLICE-005 "WAITS · 001, 002", SLICE-006 and SLICE-003 "WAITS · 005". The count reads "6 slices" for 5 slices (D6) | `browser/tower-b1.jsonl` 22:44:18 | PASS, with D6 |
| Two active cells | "LOCAL-001 List and add items, Verified, 3 working; LOCAL-002 Loan limit, Building, 1 working" | same | PASS |
| Blocked vs waiting on a person | 22:51:07: "LOCAL-002 It is approved. This machine does not merge unattended, so a person merges it. · a person", separate from "SLICE-005 … Waiting on a dependency". 23:08:27: "LOCAL-003 2 execution(s) ended without moving it past 'building'. · a person" | `tower-b3.jsonl` | PASS |
| Held reasons | the supervisor's texts shown word for word (above) | same | PASS |
| Station order and times, one ticket | `/api/v1/spans`: LOCAL-002's 15 visit spans match `lifecycle.jsonl` entered and exited to the millisecond, in the same order, including `build#1` across the killed and the resumed execution, and `verify#3`/`review#3` after the conflict | `logs/85-spans-vs-lifecycle-LOCAL-002.txt` | PASS |
| Retries and refusals reconstructable | Floor "REFUSED build.start, review.submit ×2" = LOCAL-001's three lifecycle refusals; `/runs` lists the killed execution (`exit -9`), the two failed attempts and the released claim (shown as `unknown`, D10) | `tower-b1/b3.jsonl`, `api/runs-2309.json` | PASS, with D10 |
| Held at a mid-run moment | after disabling: `#atlas`, `#timeline`, `#analytics` at 22:40:30, live and `?replay`. "LOCAL-001 Verified, Round 1 of 3, Review, at work for 53 s" (true: entered 22:39:37.310, 52.7 s); nothing later (no rejection, which came 22:40:41); Analytics 0 merged, 0 integrated, no cost counted | `hist/hist-results.json` | PASS |
| Cost and tokens equal the records | `/api/v1/runs`: USD 8.502166 and 11,930,600 tokens, exactly the streams' sum, per execution too. **Analytics K1/K4: USD 8.06**, because `execution.failed` carries no cost (D7). The page's Pulse, read once and not refreshed, said "$5.62 … Not current" (it says it is not current) | `logs/86`, `api/metrics-2309.json` | API PASS; Analytics FAIL (D7) |
| Coverage counts | "Claude Code streams 2.1.323 proven (4 executions)"; "Least complete: cell lifecycle, 2 of 3" | page samples | NOT ASSESSED (seen, not checked against records) |
| Integrated, not accepted | API T1 tickets merged 2, T2 accepted delivery (integrated) 2; page "Slices integrated … Accepted by product: Not recorded". It still says "Not recorded" after WAVE-002's acceptance merged (D11) | `api/metrics-2309.json`, `tower-b3.jsonl` 23:06:59 | PASS (never inferred), with D11 |
| Queryable after disable | "Live Factory · Factory not enabled", the history above, `?replay` "HISTORICAL REPLAY" | `hist/` | PASS |
| Page closed mid-run | closed 22:44:31. A reopen at 22:44:56 closed itself at 22:45:06 (a stale stop file of mine), so the page was effectively closed until 22:50:16. Meanwhile LOCAL-001 wrote 3 and LOCAL-002 5 lifecycle lines in the first 25 s, and both executions ran on to their own end | `logs/50-page-closed.txt` | PASS |

### Part 9: finish

| Item | Observed | Result |
|---|---|---|
| `factory disable` | 23:09; serve-3 printed `"stopped": "the Factory was disabled"` after 27 passes | PASS |
| Nothing left running | observer, sampler, tailer, page, journey server stopped; no `claude -p`, `factory serve`, `mach-observer` or `lending.server` process | PASS |
| No `.factory` in the developer checkouts | absent in `mach-harness`, `-m66`, `-m7` | PASS |
| `runner.json` | the engineer clone's: `enabled: false`. Two others under `scratch/m7/agents/dist/up/` (enabled 15:13:42) are copies the distribution agent made of the M6.6 project, not mine; both are `enabled: false` | PASS |
| No hooks or LaunchAgent | `git_hooks: []`, `persistent_service.installed: false`, nothing in `.git/hooks` but samples | PASS |

## 3. Defects

Severity: **Blocker** stops end-to-end qualification with no workaround. **Major** gives a wrong result, loses a
record, or needs a person's unplanned workaround. **Minor** is wrong or misleading but harmless to the result.

| # | Severity | What | Evidence |
|---|---|---|---|
| D1 | Major | **Sending a revised, already-merged wave.** PM A's `send WAVE-003` was refused: "Another product manager already has a WAVE-003 in review", though PR #3 was merged. PM B's `send` pushed a new commit to `product/WAVE-003` and reported "Waiting for review" with the **merged** PR #3, and no pull request was open. The revision would never have reached engineering if no one had opened PR #4 by hand | `scratch/ev/pm-pma.jsonl`, `pm-pmb.jsonl`; PRs #3, #4 |
| D2 | Major | **`release qualify` blocks any wave whose slices share a contract.** Each slice's contract is compared with the version that slice's own review approved, so SLICE-002's later, reviewed change to `proto/openapi.yaml` makes `contract.SLICE-001…` fail and the release `blocked`. Only a person's exception at each commit clears it | `logs/70`, `71`, `73` |
| D3 | Major | **A re-review overwrites the round it repeats.** After merge revalidation voided LOCAL-002's approval, the re-review used `review/round-2/` again. Packet, votes, `findings.md`, `decision.json` and the person's earlier approval were replaced. Only `lifecycle.jsonl` (seq 49–53 and 73–77) keeps the first round 2 | LOCAL-002 archive; lifecycle |
| D4 | Major | **WAVE-001's acceptance cannot be recorded.** Both PM workspaces hold WAVE-001 as a draft at revision 5 (the PM half's D8: SLICE-002 was reopened through another wave). `refresh` does not restore the merged, approved revision 4; `wave approve` makes revision 6; `acceptance record` then refuses: "not the revision that was qualified" | `ev/pm-pma.jsonl`, `pm-pmb.jsonl` |
| D5 | Major | **A plan whose implementation task cannot go green stops the line.** SLICE-005's plan scopes T05 to `lending/desk.py`, but the whole suite cannot pass until T06 changes the server. `cell.py check-plan` accepted it; `build.green` refused 7 times; 3 executions (USD 1.55) were spent before a person was asked. The builder rightly did not override | `logs/83-local-003.txt`; LOCAL-003 lifecycle; stream results |
| D6 | Minor | Control Tower product state after a revision: `/slices` shows SLICE-003 `superseded`, revision 4 (the truth is `blocked` at revision 6, ticket LOCAL-005); `/waves` keeps WAVE-003 at revision 2; the Floor says "6 slices" (wave memberships) for 5 slices | `api/slices-2246.json`, `waves-2246.json` vs `logs/63-plan-2247.json` |
| D7 | Minor | Analytics recorded cost (K1, K4) leaves out failed executions because `execution.failed` carries no `cost_usd`, though the cost is known: USD 8.06 vs 8.50. `/runs` is right | `api/metrics-2309.json`, `logs/86` |
| D8 | Minor | A SIGKILLed execution (exit -9) is recorded `execution.completed`, `how: exited`, cost null, with no exit code in the event, because it moved the ticket. The attempt count is reset | events seq 48 |
| D9 | Minor | A belt run that reports "stuck" is counted completed if the ticket moved at all, so a deterministic plan defect was retried twice more (bounded by `max_attempts`) | events seq 104–117 |
| D10 | Minor | A claim released without starting (xa1b6c30c0e44; ledger `released, not-started`) is shown as `unknown` in `/api/v1/runs` | `api/runs-2309.json` |
| D11 | Minor | The Control Tower does not read M7's acceptance record: after `product/acceptance/WAVE-002.json` merged it still says "Accepted by product: Not recorded. No MACH record says a person accepted…" (safe direction, but wrong) | `tower-b3.jsonl` 23:06:59 |
| D12 | Minor | After intake took SLICE-003 revision 6, LOCAL-005's ticket body still says "revision 4" and the old spec SHA; only its label and activity log say r6 | `.factory/tickets/LOCAL-005.md` |
| D13 | Minor | `.factory/release/` is not in the installer's ignored block, so release records show as untracked in `git status` (the audit was not affected) | `git status` after qualify |

Notes, not defects: the first LOCAL-001 execution overshot its USD 2.50 limit by USD 0.017 (Claude Code checks the
budget after a turn). Risk is only known at the plan station, so `--max-risk Medium` dispatched both tickets and held
them after planning. `enable --confirm` enables exactly the previewed policy and quietly ignores flags given with
it. The M6.6 must-fix D1 (Live Analytics leaking later figures at a past playhead) did not recur at 22:40:30.

## 4. The supported model, stated plainly

One supervisor per project per machine, held by an ownership lease with a heartbeat, enabled only by that
machine's `runner.json`. Nothing coordinates two engineers' machines: two engineers each running a supervisor on
their own clone of the same repository would both dispatch the same work. Product managers and the engineer here
were separate clones on **one** Mac, with separate Git identities and one real GitHub repository. That is a local
multi-clone test, not a test on separate machines.

## 5. Not done

- SLICE-005, -006 and -003 are not integrated. Their human gates, merges, release qualification and the full
  journey (return, overdue) were not exercised. A person has to fix SLICE-005's plan; that was not attempted.
- WAVE-001 product acceptance (D4). Acceptance was shown on WAVE-002 instead.
- Release `performance_command`: not configured; "not assessed".
- osv-scanner had no dependency manifest to read; no dependency scan of substance took place.
- The page was closed about 5½ minutes, not exactly one (see part 8). No screenshot or video was examined as an
  image. Videos from `tower.mjs` are in `scratch/browser/video/`.
- Control Tower coverage counts were seen but not checked against the records. Timeline and Analytics were checked
  through the API and by DOM text at one moment, not exhaustively.
- Only one run. Nothing was repeated to check stability.

## 6. Corrected after the run

Added after the run, against M7 worktree HEAD `1d58d02`. The run above used `c73c11e`. Sections 1 to 5 are left as
they were observed. Each fix below has unit tests and **has not been re-observed in a live run**: no Factory,
supervisor or `claude -p` was started after these commits. "Fixed" here means "the code and its tests say so".

| Defect | Fix | Tests |
|---|---|---|
| D1 sending a revised, already-merged wave | `1d58d02`: `send` reads the latest pull request's real state. Merged or closed: the old request is kept under `earlier_requests` and a new one is opened for the later revision, on top of the old branch if it still exists, else from the integration branch. "Another product manager already has WAVE-NNN in review" is said only for an open request that is not this workspace's. `status` shows the shared revision of a wave next to the draft's. | `tests/test_mach_product_collab.py` `LaterRevisionTest` (fake `gh`) |
| D2 release qualification blocks any wave whose slices share a contract | `1d58d02`: the integrated file must equal the version approved by the latest integrated in-scope review that changed it; earlier slices pass as "superseded by"; a file changed outside review fails; a file matching a reviewed change by a slice outside the release is `missing`. See `M7_RELEASE_QUALIFICATION.md`, "The contract rule". | `tests/test_release_qualify.py` |
| D3 a re-review overwrites the round it repeats | `0fcbb1b`: a re-review after a voided approval opens `round-N.k` and never overwrites a decided round; the voided approval stays on record, marked void with its reason. It does not use up one of the three rounds. Merge and cleanup follow the new folders. | `tests/test_review.py`, `tests/test_merge.py`, `tests/test_cleanup.py` |
| D4 WAVE-001's acceptance cannot be recorded | `1d58d02`: the acceptance record binds to the wave as merged at the release commit (read from Git), not to the workspace's draft, so a later draft revision no longer blocks it. | `tests/test_release_qualify.py` |

Still open after the run, none fixed in M7:

- **D5, the stuck plan.** A plan whose implementation task cannot go green is accepted by `cell.py check-plan`;
  the line then spends executions (USD 1.55 here) before a person is asked.
- **D6** the Control Tower's product state after a revision; **D7** Analytics cost leaves out failed executions
  (USD 8.06 against 8.50), and a killed execution has no recorded cost; **D8** a killed execution is recorded as
  completed; **D9** a "stuck" belt run counts as completed if the ticket moved at all; **D10** a released claim
  shows as `unknown`; **D11** the Control Tower does not read the acceptance record; **D12** a ticket body keeps the
  old revision; **D13** `.factory/release/` is not in the installer's ignored block.
- **The observer does not list a repeated review folder `round-N.k`** (new with `0fcbb1b`; the observer's review
  reader, `apps/observer/internal/ingest/people.go`, reads `review/round-N`). Not checked further.
- Whether D5 should be caught by `check-plan`, and whether D8 and D9 should change how attempts are counted, are
  decisions for the lead.

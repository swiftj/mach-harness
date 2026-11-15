# M7 — Release-readiness inventory (Phase 0)

Version 1. Baseline `106f4d3` (main, M6.6 merged). Newest tag `v0.12.0` (commit `235cb2c`, published
2026-11-12 with `mach-studio-{darwin-amd64,darwin-arm64,linux-amd64,linux-arm64}` and `SHA256SUMS`, no
`mach-observer`; read with `gh release view v0.12.0`). `.claude-plugin/plugin.json` at the baseline still says
`0.12.0`.

Method: for each capability, the code was located and the evidence behind it identified. Milestone labels
were not taken as evidence. No test suite, MACH script, Factory or browser was run for this inventory; the
lead is running the baseline suites separately. "Tests pass" below means the M6.6 regression on the final tree
(`M6_6_ACCEPTANCE.md` section 12: Python 631 run, pass; Go 16 packages pass; Control Tower unit 692/692;
browser suites as listed there), until the lead's baseline run replaces it.

**Classes** (exactly one per row): **Verified** = implemented and independently verified (a real run or a
real external system); **Fixture** = implemented but only fixture-tested; **Limited** = implemented with known
limitations; **Incomplete**; **Not assessed**.

**Real runs referred to:**
- **RR-M5**: real Claude Code 2.1.322 interview-bridge runs, 11 Nov (`M5_INTERVIEW_POC.md`).
- **RR-M62**: three authorized supervised executions, 12–13 Nov, observed live (`M6_2_ACCEPTANCE.md` 2.2):
  review rejected with a security blocker, revise, re-verify, stop at the human gate; one execution stuck at `built`.
- **RR-M65**: High-risk run, 13 Nov, two rejected rounds, three executions of which two failed; replayed in M6.6
  (`M6_6_ACCEPTANCE.md` section 5, "recorded real run replayed").
- **RR-L1 / RR-L2**: M6.6 live runs 1 and 2, 14 Nov (`M6_6_ACCEPTANCE.md` 5–6, `M6_6_JOURNEY.md`): approved wave
  through intake, dependency hold, two cells at once, belt workflow, build/verify/review, human gate,
  `approve-human`, `merge --by-person` (local method), cleanup, daily run limit, disable.

All real runs: one Mac, throwaway projects, a local bare repository as origin, product published by Product
Studio's real `send` through the repository's test helpers (no GitHub, stand-in `gh`), supervised mode, no
automatic merge.

## 1. Inventory

| # | Capability | Class | Evidence | Gap | Severity (RC) — reason |
|---|---|---|---|---|---|
| 1 | Product Studio, terminal (`studio.py`: project, epics, slices, interview, approval, waves) | Fixture | `tests/test_mach_product_studio.py` (50), `test_mach_product_contracts.py` (38); used to author waves for RR-L1/L2 via test helpers | No recorded PM session with a real interview through the terminal skill; no product-acceptance record | Major — core PM workflow never run by a person end to end (Phase 1) |
| 2 | Product Studio, visual (`apps/studio` host + `web/apps/product-studio`) | Fixture | `web/e2e/suites/lifecycle`, `conformance`, `security`, `a11y` (real host, real engine, real Chromium; **stand-in `claude` and `gh`**); Go tests in `apps/studio/internal`; RR-M5 proves the bridge mechanism with real Claude | `interview-real.test.mjs` (real `claude`, opt-in) has no recorded run; no screen-reader pass; host never downloaded from a release and started by a PM | Major — the PM's primary surface has no real-Claude, real-GitHub run |
| 3 | Terminal/visual artifact equivalence | Fixture | `web/e2e/suites/conformance.test.mjs` (24 operations, identical draft trees); `tests/test_mach_product_host.py` | Equivalence is shown for the operation list only, with stand-ins | Minor — mechanism well covered |
| 4 | Git collaboration: `refresh`, `reconcile`, renumber | Fixture | `tests/test_mach_product_collab.py` (local bare repo, stand-in `gh`): field merge, same-field conflict, spec always a conflict, approval withdrawn | Never run across two machines or against a real GitHub remote | Major — multi-PM is a headline claim; all evidence is one machine, local clones |
| 5 | Git collaboration: `send` (one PR per wave, resumable, idempotent) | Fixture | `test_mach_product_collab.py:239-436` (send once, failed push/create resume, commit rules, three PMs); real `send` used to set up RR-L1/L2 (local bare origin) | No PR ever opened on GitHub or GHEC; CODEOWNERS, required checks, SSO, signed commits only simulated (`test_the_repositorys_commit_rules_apply` uses local hooks) | Major — enterprise PR behaviour (Phase 1, scenario 5) unshown |
| 6 | Git collaboration: `feedback` | Fixture | `test_mach_product_collab.py:363` and e2e lifecycle "review states" (stand-in `gh`) | Real review states from GitHub never read | Major (same as 5) |
| 7 | Factory intake (ledger, idempotence, revisions, refusals) | Verified | `tests/test_mach_product_intake.py` (49); RR-L1/L2 took a real merged wave in | Duplicate/revised/withdrawn waves only in fixtures | Minor — real path shown, edge cases fixture-only |
| 8 | Scheduler (dependency-aware, integration on main, `max_parallel`) | Verified | `test_mach_product_intake.py:390-545`; RR-L1 dependency hold then dependent slice ran | Cross-slice integration not judged (see 30) | Minor |
| 9 | Dispatch (explicit, guarded, stops at `spec-ready`) | Verified | `test_mach_product_intake.py:649-830`; RR-L1/L2 | None found | None |
| 10 | Supervisor activation (`enable` + code, preflight, machine-local authorization) | Verified | `tests/test_mach_factory_supervisor.py:220-381`; RR-M62, RR-L1, RR-L2 enabled through code | Preflight re-runs only at enable/confirm/resume, not per pass (`activation.py:149,187,251`) | Minor — see review audit G3 |
| 11 | Supervisor modes (observe, supervised), limits, pause/resume/disable/stop | Limited | Supervisor tests `:389-826`; supervised mode and daily run limit in RR-L2; disable in RR-L1/L2; observe mode no real run found | Observe mode and emergency `stop` not run live; **a hold carries prose only, no reason code** (`supervisor.py:253,406,410`), so the Control Tower cannot tell a person-wait hold | Minor — documented, Factory-side record change |
| 12 | Supervisor recovery (claims, adoption, unknown outcomes, retries, lease) | Fixture | Supervisor tests `:751`, `:827-965`; RR-M65 replayed shows failed executions | **No retry and no supervisor restart observed in a live run** (`M6_6_ACCEPTANCE.md` 5, `M6_6_RELIABILITY.md` "Not tested live") | Major — recoverability guarantee unverified live |
| 13 | Execution boundary (`claude -p`, restricted mode, tool list, budget) | Verified | Supervisor tests `:584`, `:1095-1175`; `tests/test_unattended_commands.py`; RR-M62/L1/L2 ran under it | **Failed executions record no cost** in the Factory's log (cost read from the last `result`, `executor.py:416,441`); recorded cost understated (USD 1.29 shown vs 4.73 spent, RR-M65) | Minor — metric caveat, documented |
| 14 | Station: ticket | Verified | `tests/test_ticket.py` (30); intake files real local tickets in RR-L1/L2 | GitHub/Gitea/Jira/Fossil backends only via fixtures/stand-ins; telemetry ingestion fixture-only | Minor |
| 15 | Station: audit | Verified | `tests/test_audit.py` (24); Silver audit gated RR-L2 | Secret scanning is only checked as *configured*, never run; no dependency-vulnerability scan exists | Major — Phase 4 deterministic scanning absent |
| 16 | Station: intent (headless finalize, plan, contracts) | Verified | `tests/test_cell.py`, `test_validate_slice.py`; plan stage in RR-M62/L1 | None found | None |
| 17 | Station: build (TDD gates) | Verified | `tests/test_build.py` (41); RR-M62 (11 tasks), RR-L1/L2 | None found | None |
| 18 | Station: verify (evidence, hashes, holdouts) | Verified | `tests/test_verify.py` (19); RR-M62 16 checks, PASS twice, one INCOMPLETE refusal | Only `library` app type run for real; web/cli/api/desktop evidence kinds fixture-only | Minor |
| 19 | Station: review (panel, veto, delta rounds, human gate) | Limited | `tests/test_review.py` (37); RR-M62/M65 rejection with security blocker, human gate | **Security finding outvotable when raised by a non-security seat; panel can be reduced by tracked config; no exception record; delta rounds cannot raise new blockers** (`M7_REVIEW_GATE_AUDIT.md`) | **Blocker** — G1 bypasses a required security gate as the brief defines it |
| 20 | Merge policy (`local`, `pr`, auto/manual, merge queue, approval binding) | Limited | `tests/test_merge.py` (13, stand-in `gh` for `pr`); RR-L1/L2 `--by-person` local merge | `pr` method never against GitHub/GHEC; `auto` mode never live; merge-queue revalidation never live | Major — enterprise merge path unshown |
| 21 | Cleanup and run records (`runs.jsonl` v2) | Verified | `tests/test_cleanup.py` (34); RR-L1/L2 cleanup | `--abandon` fixture-only | Minor |
| 22 | Observe (scorecard, patterns, tuning ticket) | Fixture | `tests/test_observe.py` (45), `test_mach_analytics_parity.py` | Never run on real run records (needs 5 finished tickets) | Minor |
| 23 | Lifecycle telemetry (station logs) | Limited | `tests/test_lifecycle.py` (16); real logs in all real runs | **Lifecycle lines have no identity**: a repeated line is counted again (`M6_6_RELIABILITY.md` defect 1); prose blocker rules recorded as `rules: []` (N7) | Minor — needs a restored/doubled file |
| 24 | Control Tower: observer (Go, GET-only, loopback, redaction) | Verified | Go tests (16 packages); `M6_6_PACKAGING.md`; M6.6 section 8 attack review (34,191 fuzzed requests); RR-M62, RR-L1/L2 | **R1 open**: names in free text served (label-and-contain); not in any release | Major — fails if confidentiality required (product owner decision) |
| 25 | Control Tower: Factory floor | Verified | Control Tower unit 692/692; browser journey tests; RR-L1/L2 watched live | Supervisor hold not shown as a person wait (row 11) | Minor |
| 26 | Control Tower: Execution Timeline | Limited | 32 browser tests incl. a recorded real run; RR-L1/L2 | Floor-to-Timeline switch 598–874 ms vs 300 ms budget on 240k events; long-history browser test not run on final build | Minor |
| 27 | Control Tower: Analytics | Limited | 36 browser tests; RR-L1/L2 hand-checked figures; `M6_6_RULES_REVIEW.md` | Four rules cannot fire in default view; cost excludes failed executions; product acceptance not represented | Minor |
| 28 | Control Tower accessibility | Limited | `M6_6_ACCESSIBILITY.md`: axe 0 violations / 22 states | No screen-reader session, no real Safari, no WCAG claim | Minor |
| 29 | Product acceptance record | Incomplete | None. Search of `skills/`, `apps/`, `web/apps/*/src` finds only the Analytics note that "integration is not acceptance" (`Pulse.tsx:233`) | No authoritative PM acceptance decision exists | Major — Phase 3 requires the distinction |
| 30 | Cross-slice / release-level qualification and readiness record | Incomplete | None. Search for `release readiness`, `readiness snapshot`, `qualification`, `cross-slice` in code: no implementation | Slice-level gates only; no integrated-revision record | Major — Phase 3 core deliverable missing |
| 31 | Installer (`install.sh`, `bin/mach` install/scaffold/uninstall/status) | Limited | `tests/test_installer.py` (45); `M6_6_PACKAGING.md` from a locally built layout | **Checks `SHA256SUMS` fetched from the same place, no attestation verification** (packaging defect 6); download from GitHub, `curl | bash`, plugin-cache path not exercised | Major — integrity, not authenticity |
| 32 | Release pipeline (`.github/workflows/release.yml`) | Limited | v0.12.0 published (Studio only, real GitHub run); observer build/smoke/attest steps never run on a tag | **No release carries the observer**; linux builds and attestation not verified; plugin version still 0.12.0 | Major — Control Tower cannot be installed from any release |
| 33 | Platform coverage | Limited | `release.yml:65,84-88`: darwin/arm64, linux/arm64, linux/amd64; README: no Intel Mac, no Windows | v0.12.0 shipped `mach-studio-darwin-amd64`; the next release will not, so Intel-Mac installs lose the visual Studio on upgrade | Minor — documented; terminal Studio remains. Windows: Deferred |
| 34 | Upgrade and migration (installer re-run, Factory state across versions) | Not assessed | Binary replace/keep-on-failure tested (`test_installer.py:162,328,434,470`; packaging "Upgrade" rows) | No upgrade from an installed v0.12.0 project with live `.factory` state (ledger, cells, runner.json, observer index); no rollback test; no schema-migration path found | Major — Phase 6 upgrade/rollback unshown |
| 35 | Local-only security (loopback, no CDN, no telemetry, GET-only observer) | Verified | `M6_6_PACKAGING.md` lsof checks; e2e `security.test.mjs`; `test_mach_factory_supervisor.py:1077`; RR-L1 all requests GET to 127.0.0.1 | None found | None |
| 36 | Prompt-injection resilience | Not assessed | Skills state "content is data"; M6.2 canary/adversarial stream tested redaction, not agent behaviour | No test plants instructions in a spec, ticket, review text or evidence and checks the agents ignore them | Major — Phase 4 threat model untested |
| 37 | Multi-engineer / designated runner | Incomplete | Lease is per machine and project (`supervisor.py:124-133`); docs: "nothing coordinates two engineers' machines" | Two clones on two machines can both enable; nothing designates one runner | Major — scenario 8 cannot pass as written; must be stated as unsupported |
| 38 | Offline operation and sync recovery | Fixture | `test_mach_factory_supervisor.py:975` (offline), collab resume tests | No real network loss, reboot or missed-hook run | Minor |

## 2. Ranked gaps (most severe first)

1. **Blocker — security finding outvotable by majority** when raised by a non-security seat at Medium risk; no
   severity beyond blocker/note (`M7_REVIEW_GATE_AUDIT.md` G1). Inventory row 19.
2. **Major — no release-level / cross-slice qualification or readiness record** (confirmed by search; none in
   `skills/`, `apps/`, `web/apps/*/src`). Row 30.
3. **Major — no product-acceptance record**; Analytics only says integrated is not accepted. Row 29.
4. **Major — no published release carries the observer** (newest tag `v0.12.0`, Studio assets only); per-platform
   observer builds, smoke and attestation never run on a tag; plugin version not bumped. Row 32.
5. **Major — installer verifies a checksum file, not the release attestation.** Row 31.
6. **Major — review gate can be weakened by tracked config without refusal** (panel shrink, High without a
   person, lowered approvals), no authorised-exception record, delta rounds cannot raise new security
   blockers (audit G2, G4, G5). Row 19.
7. **Major — no retry and no supervisor restart observed in a live run**; recovery is fixture-tested only. Row 12.
8. **Major — every real test was on one machine with local clones**; no GitHub/GHEC PR, required checks, SSO,
   signed commits, CODEOWNERS; no second PM or engineer machine; no designated-runner mechanism. Rows 4–6, 20, 37.
9. **Major — R1 open**: names in free text are served by the observer (label-and-contain). Release fails where
   confidentiality of prose is required. Row 24.
10. **Major — upgrade/migration and rollback not assessed** with real Factory state. Row 34.
11. **Major — no prompt-injection tests; no dependency-vulnerability scanning; secret scanning only checked as
    configured.** Rows 15, 36.
12. **Major — the PM journey (terminal and visual) has no real-Claude, real-GitHub, person-driven run.** Rows 1–2.
13. **Minor — supervisor hold has no reason code** (prose `why` only). Row 11.
14. **Minor — lifecycle lines have no identity** (repeats double-counted); prose rules lost. Row 23.
15. **Minor — failed executions record no cost** in the Factory's log. Row 13.
16. **Minor — Control Tower performance over budget** on 240k-event histories; accessibility manual checks
    outstanding. Rows 26, 28.
17. **Minor — Intel-Mac Studio binary dropped after v0.12.0**; `security_veto` not re-checked per pass; tuning
    label clears High-risk human approval. Rows 33, 10; audit G3, G10.
18. **Deferred — Windows packages**; Low-risk tickets have no security seat (by design).

## 3. State at the end of M7

Final state, written against M7 worktree HEAD `14ba169` (21 commits after the first version of this section at
`1d58d02`). Sections 1 and 2 above are left as written at `106f4d3`. "Fixed" means a commit and a test exist.
"Observed live" means a live Factory run, with the real `claude -p`, showed it after the fix: run 2
(`M7_FACTORY_ACCEPTANCE_2.md`) observed fixes up to `62ad896`, run 3 (`M7_FACTORY_ACCEPTANCE_3.md`) up to
`b73c025`. Anything after those has unit tests only. The matrix is `M7_ACCEPTANCE_MATRIX.md` (version 3).

| Rank | Gap (as ranked above) | Final state | What changed, and what is still open |
|---|---|---|---|
| 1 | Security finding outvotable by majority | **Fixed** (`f6097ee`); unit-tested; shown on copied real records, not as a Factory event | A security-class blocker of high or critical impact from any seat rejects the round at every tier; `security_veto: false` does not switch it off. Runs 2 and 3 raised no blockers, so no live round exercised it after the fix. An unclassified blocker from a non-security seat is still outvoted at Medium, by design. |
| 2 | No release-level qualification or readiness record | **Fixed** (`c73c11e`, `1d58d02`, `34a721e`, `1e0a635`); **observed live** for the rule, **not re-observed** for the last two | Run 2: five slices of three waves integrated, `qualified`, 55 checks, byte-identical on repeat; the shared-contract rule (D2) passed with no exception. Run 3: `incomplete` when a scanner report recorded zero sources. A scanner report must now carry the scanner's version, exit code, a non-zero scanned count and its time, and the outcome line names every check not assessed (`34a721e`, `1e0a635`; unit-tested, not re-observed live). No dependency scan of substance was ever possible on the throwaway project; `performance` was not configured. |
| 3 | No product-acceptance record | **Fixed** (`c73c11e`, `1d58d02`, `ff1758a`); **observed live**; the separate-send fix is **not re-observed** | Run 2: acceptance bound to the wave as merged (F6); WAVE-001 to -003 `accepted` only after the records merged; the Control Tower reads the readiness snapshot (a read-only route) and says "not recorded" until then. An acceptance is now sent alone on its own branch, with only its file (`34a721e`, N4; unit-tested, not re-observed live). Terminal only. |
| 4 | No published release carries the observer | **Partly fixed**: `v0.13.0-rc.2` published as a pre-release; the current candidate pending; a full release not published | rc.2: six programs, six SBOMs, a source archive and `SHA256SUMS`, all eight attestations verified by hand (`M7_RELEASE_CANDIDATE.md`). `rc.1` and `rc.3` were never published (a data race and a Linux file-identity defect, `acc950f`; a shell-syntax error on Linux, `14ba169`). `main` still serves the old installer until this branch merges. The version bump and any full release are the product owner's step. |
| 5 | Installer verifies a checksum, not attestation | **Partly fixed** (`c35788a`, `072b56b`, `e3ac0e8`, `14ba169`); verified against real GitHub on rc.2 with a patched copy, **awaiting the current candidate** | The one-line installer installs a release, not `main`, and checks the release's source archive against its checksum and its build attestation before any downloaded code runs; an unverified source is installed only by explicit choice and says so. Real attestations verified (rc.2, 8 of 8). rc.2's shipped installer refused its own version; fixed for the next candidate, not yet checked against GitHub. **Open:** `install.sh` itself is the remaining trust root (T6): nothing checks the script you ran. |
| 6 | Review gate weakened by tracked config; no exception record; delta rounds | **Partly fixed** (`f6097ee`, `0fcbb1b`); D3 **observed live** | G2, G3 for unattended execution, G5, G9's first half. A re-review after a voided approval opens `round-N.k` (run 2 F4 showed `round-1.1`, the earlier decision and the person's approval kept). **Open:** G4, the recorded exception (product owner's decision); interactive `/mach-run` does not check the settings; G6, G8, G10, G11. A repeated review or a voided decision is not shown on the Control Tower page. |
| 7 | No retry or supervisor restart seen live | **Partly shown** (runs 1 and 2) | Live: SIGKILL of the supervisor and restart; a killed execution recorded as `killed` with exit code -9 and retried once (run 2, F3); a build or plan that is not progressing parked at once (F2, seen at the plan station); two failed attempts then a person (run 1). Not shown: reboot, network loss, the Tower displaying a restart. |
| 8 | Everything on one machine | **Open, cannot be fixed here** | Still clones on one Mac and one GitHub account. Rules were enforced by real GitHub.com on a personal account (`M7_GITHUB_RULES.md`), not an Enterprise organisation: no approval under enforced review, no signed commit, no SSO. No second machine; no designated-runner mechanism. |
| 9 | R1: names in free text served | **Open** (product owner's decision) | Unchanged. Matrix row 61 is FAIL. |
| 10 | Upgrade and rollback not assessed | **Partly fixed** | Hand-built v0.12.0 state upgraded and rolled back with no loss; a real v0.12.0 install upgraded to rc.2 with a patched copy of the installer (draft hash unchanged); the live project upgraded from a snapshot in runs 2 and 3 (ledger, events, tickets, config and `runner.json` identical by SHA-256, Factory left disabled). Rolled back only in the hand-built case; no rollback is documented. |
| 11 | No injection tests, no vulnerability scan, secret scan only configured | **Partly fixed** | Adversarial tests with fakes and no model run (`b4bfa2d`); five scanners run once, no confirmed High or Critical (`M7_SECURITY_SCANS.md`); `release qualify` treats a missing or empty report as incomplete (live, run 3). T1, T3, T4, T5 fixed in `d68f83f`; a tracked `runner.json` reads as disabled (F9, live on a copy). Supervised enable now states what an execution can do on this machine and needs `--accept-execution-risk` (`62ad896`, observed live). **Open:** T2 (`Bash(python3 *)`, no operating-system sandbox, accepted and recorded, not removed); no model was run against planted instructions; the audit station only checks that a scanner is configured; nothing scans generated code in the line. |
| 12 | PM journey not run with real Claude and real GitHub | **Partly shown** (`ab2e70a`, `b0d3e88`, `24ed432`, `96971bd`) | Two PMs and an engineer on one Mac, real GitHub (public repository for the rules test), one real interview turn pair (USD 0.23) in the PM run; later runs wrote specs by hand. `feedback` says what a blocked request waits for (a review, a named check, not signed): unit-tested, not re-run on GitHub. A PM's own just-merged slice is no longer a collision, and an acceptance conflict no longer leaves a workspace stuck (`96971bd`; found live in run 3, fixed on copies of the real workspaces, not re-observed). No second computer; the visual app's real-Claude browser suite was not run. |
| 13 | Supervisor hold has no reason code | **Open** | No commit touched it. The Tower shows the hold's prose and separates a wait on a person. |
| 14 | Lifecycle lines have no identity | **Open** | Not changed. The observer now counts a second review decision in a round as a repeat (`3a4bb22`), nothing more. |
| 15 | Failed executions record no cost | **Open** (product owner's decision) | Analytics leaves out failed executions: run 2 showed "USD 15.22 recorded, a lower bound" with known failed costs omitted; killed executions have no cost at all, so real spend is unknown. A killed execution is now recorded as killed with its exit code (`7e23f84`, observed live), not as completed. `/api/v1/runs` carries the cost of an execution that wrote a result. |
| 16 | Tower performance over budget; accessibility manual checks | **Open** | Not changed in M7. |
| 17 | Intel-Mac Studio binary dropped; `security_veto` not re-checked; tuning label | **Partly fixed** | The per-pass check is fixed (`f6097ee`). The Intel Mac drop is documented. The tuning-label approval question (G10) is open. |
| 18 | Windows; no security seat on Low risk | **Deferred** | Unchanged. |

Defects found in the real runs, not in the ranked list above, and where each ended:

| Defect | Final state |
|---|---|
| D5 a plan whose implementation task cannot go green; D8 a killed execution recorded as completed; D9 a stuck belt run counted as completed | **Fixed** (`7e23f84`), **observed live** in run 2 (F1 `check-plan` refused the old plan; F2 a run that made no progress parked at once; F3 a kill recorded as killed with exit code -9) |
| D6 Tower product state after a revision; D10 a released claim shown as `unknown`; D11 acceptance not read by the Tower | **Fixed** (`3a4bb22`, `ff1758a`); D10 and D11 **observed live** in run 2 (the released claim left out of the counts; the readiness line followed the record); D6 unit-tested on the run's records, **not re-observed** |
| N1 no route to re-plan a parked cell; N2 a revised slice cannot reach the line after its ticket was in work; N3 an execution doing work for another ticket | **Fixed** (`b73c025`), **observed live** in run 3 (C3, C1 and C2, C4): `cell.py replan`, intake taking a revision after an abandoned ticket by itself, `run.py product resolve --supersede-in-work`, an execution refused any ticket but its own |
| N4 an acceptance send published a slice draft | **Fixed** (`34a721e`); unit-tested, **not re-observed live** |
| N5, P4 outcome line and empty scanner reports | **Fixed** (`34a721e`, `1e0a635`); unit-tested, **not re-observed live** |
| N6 a killed execution reads as failed; N7 abandoned tickets read as waiting | **Fixed in part** (`1243a95`, `3a4bb22`, `ff1758a`); unit and Go tests on the run's records, **not re-observed on a page**. The cell tile still shows an abandoned cell's last stage word |
| P1, P2 Product Studio workspaces stuck | **Fixed** (`96971bd`); unit-tested and tried on copies, **not re-observed live** |
| P3 the belt fails a step on a blank agent type | **Fixed** (`9b8ad80`); tested with Node on the extracted function, **not re-observed live** |
| P5 observe-due count differs from cleanup's | **Fixed** (`9b8ad80`); a due pass is raised to a person once per count and never started by the supervisor (`b73c025`, observed live in run 3) |
| D7 cost of failed executions; D12 a ticket body keeps the old revision; P6 `resolve` records a role word, not the identity; N11 `install --no-studio` rewrites a tracked manifest; N12 a cross-slice defect caught by no test | **Open** (D7: product owner's decision) |
| D13 `.factory/release/` shows as untracked | **By design**: a readiness snapshot is evidence a team may commit; `M7_RELEASE_QUALIFICATION.md` says so. Not a defect |
| N10 the daily limits count the previous day's executions | **As designed** |

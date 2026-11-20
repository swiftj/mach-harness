# M7 — Threat model: MACH itself, the software it generates, and its local applications

> **Historical note (November 2026).** This document was written before M11. Delivery waves, epic approval, the product pull request, the Execution Timeline, the Execution Blueprint and playback have been removed since. Where it describes them, [`M11_DESIGN.md`](M11_DESIGN.md) and the root `CLAUDE.md` say what replaced them. It is kept as the record of what was designed and tested at the time.

Version 1, M7 worktree on baseline `106f4d3` plus the uncommitted M7 changes as of writing. Phases 4 and 5 of the
M7 brief. Every "stops it today" is read from the code (file:line in this worktree); documents were used only to
find code. "Evidence" names a test that exists and was run, or says **none**. Severity for this release: **Blocker**
stops the release, **Major** breaks a shipped promise or leaves an exploitable path, **Minor** recoverable or narrow,
**Deferred** known and accepted for later. New tests from this work are marked (M7); they were run once, results in
section 6.

## 1. Findings first

| # | Severity | Finding | Fix (described, not made) | Test |
|---|---|---|---|---|
| T1 | **Major** | A `runner.json` that arrives through Git is accepted as a local grant. `policy.read` (`skills/run/scripts/policy.py:136-189`) checks symlinks, group/other write bits, schema, limits, machine name and project folder, but never whether the file is tracked, nor its owner. A commit that force-adds `.factory/local/runner.json` written for the victim's host name and clone path (both guessable in a team) lands with mode 0644 on pull, and Git overwrites an ignored local file on checkout. It can turn `observe` into `supervised`, raise limits within range and add tools (`Bash(curl *)` was accepted in the test). Needs push to the integration branch and a supervisor already running or started later. Breaks the promise "authorization does not travel" (`policy.py:8-13`). | In `policy.read`: refuse when `git ls-files --error-unmatch .factory/local/runner.json` succeeds, and when `st_uid != os.getuid()`. Optionally bind the file to a secret kept outside the repository. | (M7) `test_m7_adversarial_activation.RunnerFileTest.test_a_runner_file_that_arrives_through_git_is_refused` — **expectedFailure, confirmed** **(corrected in `d68f83f`: `policy.read` now refuses a file Git tracks (index or HEAD), a link, a file owned by another user and one writable by others, so it reads as disabled; the (M7) test lost its expected-failure marker. Fixed; unit-tested, not re-observed live.)** |
| T2 | **Major** (accepted design, stated) | The unattended run's consented tools include `Bash(python3 *)` and `Bash(<interpreter> *)` (`policy.py:52-53`, `:132-133`). A `python3 -c` is arbitrary code as the engineer, with `HOME` (SSH keys, Git credential helper, `gh` login file) and the network. `--restricted`, the allow list and the credential-free environment (`executor.py:145-154`) do not bound that. A prompt injection that succeeds can therefore push, exfiltrate or write outside the cell. See section 2.3. | Run the station scripts through a wrapper that the allow list names exactly (`Bash(python3 /abs/skills/*/scripts/*.py *)`), deny `-c`/`-m`; or run executions in an OS sandbox (macOS `sandbox-exec`, Linux bubblewrap) with no network and the cell as the only writable folder. | none (no model run) |
| T3 | Minor | A deeply nested JSON value in any merged product file crashes intake: `json.loads` raises `RecursionError` (not a `ValueError`), uncaught in `intake.Snapshot._json` (`intake.py:116-121`). Every reconcile pass then fails with a traceback until the file is reverted. Nothing runs, nothing is filed. | Catch `RecursionError` there and in Product Studio's JSON readers, or cap size and depth before parsing. | (M7) `test_m7_adversarial_product.HostileProductTest.test_a_json_bomb_in_a_product_file_is_refused_not_a_crash` — **expectedFailure, confirmed** (depth 1,000,000; 100,000 still parses on CPython 3.15) **(corrected in `d68f83f`: `intake.py` refuses a product file over 1 MiB and catches `RecursionError`, so a nested file is invalid, not a crash. Fixed.)** |
| T4 | Minor | `ticket.fill` substitutes fields one after another (`skills/ticket/scripts/ticket.py:175-178`): a title containing `{body}` becomes the body text in a tracker command. Still one argv element, never a shell. Wrong text in a tracker field only. | One-pass `re.sub` over the known field names. | (M7) `test_m7_adversarial_injection.TicketTextIsDataTest.test_a_value_is_not_reinterpreted_as_a_template_field` — **expectedFailure, confirmed** **(corrected in `d68f83f`: `ticket.fill` substitutes in one pass. Fixed.)** |
| T5 | Minor | Product files are read whole with no size cap (`skills/product-studio/scripts/collab.py:70-94`). A 4 MB junk file was handled without a crash; a much larger one costs memory on every pass. | Skip and report blobs above a limit (for example 1 MB) using the size `cat-file` already returns. | (M7) `test_binary_and_oversized_product_files_do_not_break_intake` passes at 4 MB; larger not assessed **(corrected in `d68f83f`: intake refuses a product file over 1 MiB, closing the memory cost named here. Product Studio's own readers were not changed.)** |
| T6 | Major (already open, `M7_DISTRIBUTION.md` defect 2) | `install.sh:14-15,40` installs the scripts from the tip of `main` over TLS with no checksum; binaries are checked against `SHA256SUMS` from the same release and provenance is verified only when `gh` is present (`bin/mach:248-287`, warning otherwise unless `MACH_REQUIRE_PROVENANCE=1`). | As `M7_DISTRIBUTION.md` recommendation 4: fetch from the tag, attest the source archive and `SHA256SUMS`. | `tests/test_installer.py` (simulated `gh`) |
| T7 | Major (open, by product decision) | R1: personal names in free prose are served by the observer, labelled and contained, not withheld (`M6_6_ACCEPTANCE.md` §8). Any confidentiality claim for free text is blocked. | Withhold prose at the observer by default (codes and counts), per §8. | observer suite cited there |

No Blocker was found by this work. T1 and T2 should be decided before the release is called "supervised-ready". (corrected: T1, T3, T4 and T5 were fixed in `d68f83f`; T2, T6 and T7 remain open.)

## 2. MACH itself

### 2.1 Trust boundaries

1. **The person at the terminal** is the only authority: enables the Factory (`factory enable --confirm <code>`,
   `policy.py:276-299`), approves High risk (`review.py approve-human`), merges by person. Trusted.
2. **Product Studio engine** (`skills/product-studio/scripts`, run by the PM's Claude Code or the Studio host) writes
   only `.factory/studio/` and publishes only `product/**` and `specs/slices/**` through a PR. Trusted code; its
   inputs (PM prose, other PMs' files, reviewer comments) are untrusted.
3. **Studio host** (`apps/studio`): loopback HTTP, one session, a fixed operation list, a restricted interview turn.
   The browser is untrusted beyond the session cookie.
4. **Product files in Git**: untrusted data until intake has checked them; even then the prose is untrusted text.
5. **GitHub** (PRs, review comments, issues, releases): untrusted data; reached through `gh` argv only.
6. **Intake** (`skills/run/scripts/intake.py`): reads Git objects at the merged integration commit only, validates,
   files tickets, dispatches only for an engineer or with an authorization callback.
7. **Supervisor and machine-local authorization** (`policy.py`, `activation.py`, `supervisor.py`, `executor.py`):
   the boundary between "a person decided" and "the machine acts". `runner.json` is the trust anchor (see T1).
8. **Each station's script versus the model**: scripts decide gates, order, commits and verdicts; the model writes
   tests, code, evidence and findings. The model is untrusted relative to the script.
9. **The cell**: a Git worktree on `feature/<ticket>`; the generated code and its build/test commands run here with
   the engineer's privileges.
10. **Observer and Factory Floor** (`apps/observer`): read-only, loopback, GET only (`M6_5_SECURITY.md` §8).
11. **Installer and release**: `install.sh`, `bin/mach`, `.github/workflows/release.yml`.

| Boundary | Crosses it | Enforced by | Weakest point |
|---|---|---|---|
| Person → Factory enable | a typed code within its expiry | `policy.take_pending` `policy.py:283-299`; `activation.py` | T1: a file can arrive without the code |
| Product files → intake | merged Git objects only, allowed paths, no symlinks, SHA-256 of approved spec | `collab.py:45-46,70-94`; `intake.py:234-286`, `:1053`, `:1123` | T3, T5 (availability only) |
| Intake → cell | engineer, or supervisor with `authorize(plan) is True` | `intake.py:1007-1017` | none found |
| Supervisor → `claude -p` | fixed prompt with ticket IDs only, restricted mode, explicit tools, budget | `executor.py:92-142` | T2: `Bash(python3 *)` |
| Model → repository | file tools in the project; `.factory/local`, `.claude`, the plugin denied to Edit | `executor.py:112-117` | Write via Python bypasses it (comment at `:113-115` says so) |
| Cell → main | review approval bound to a commit, merge station | `merge.py`, `review.py` (see `M7_REVIEW_GATE_AUDIT.md`) | side effects outside Git are not gated |
| Browser → Studio host | Host, session cookie, Origin, CSRF header, JSON body, fixed ops | `apps/studio/internal/server/server.go:98-147`, `security/session.go:73-126` | none found |
| Browser → observer | same family, GET only | `M6_5_SECURITY.md` §8 | R1 (T7) |
| Release → machine | checksum, optional attestation | `bin/mach:217-287` | T6 |

### 2.2 Threats

| Threat | Attack path | What stops it today | Evidence | Residual | Sev |
|---|---|---|---|---|---|
| Malicious product specification | A PM (or a compromised PM account) writes instruction-like prose in a spec or why; or edits a spec after approval | Spec bound by SHA-256 at approval and re-checked at intake (`intake.py:274`) and at dispatch (`:1053`, `:1123`); validator gates (`:277-283`); ticket body cites the spec by path and hash, never copies prose (`intake.py:604-616`); title prefixed with the slice ID so it is never an option (`:605`); risk floor product cannot lower (`intake.py:1067`) | `tests/test_mach_product_intake.py` `test_spec_changed_after_approval`, `test_product_cannot_lower_the_review_tier`; (M7) `test_an_injection_added_to_the_spec_after_approval_is_refused`, `test_injection_in_a_title_and_an_approved_spec_is_carried_as_data` | An **approved** spec's prose still reaches the build/verify/review agents as text; see 2.3 | Major (T2) |
| Prompt injection through repository content | Code, comments, README, test fixtures in the cell are read by builder/verifier/reviewers | Scripts own the gates (scope, frozen tests, red-before-green, traceability `build.py`; evidence hashing `verify.py`; findings-to-vote `review.py`); fresh-context reviewers; human gate on High | `tests/test_build.py`, `test_verify.py`, `test_review.py` (gate behaviour, not injection) | Within T2's boundary an agent can do anything Python can | Major (T2) |
| Malicious PR descriptions and review comments | Reviewer text returned by `feedback`; PR bodies | `feedback` prints reviewer text as JSON values; every `gh` call is an argv list (no `shell=`), and no git/gh call passes ticket, spec or review text as a positional argument | (M7) `FeedbackIsDataTest`, `CommandConstructionTest` (180 git/gh call sites, 122 non-literal arguments scanned) | The PM's own model reads the feedback text; Studio's interview turn is restricted (below) | Minor |
| Skill and workflow manipulation | A ticket edits `skills/**`, `agents/**`, `workflows/**` in the project, or a `factory-tuning` ticket changes `SKILL.md` | Unattended runs load MACH only from the plugin folder (`executor.py:15`, `:28-29`), Edit to it denied (`:116`); project `.claude/` not loaded in restricted mode and Edit-denied | `tests/test_mach_factory_supervisor.py` (plugin staging) | `factory-tuning` changes `SKILL.md` with no person (`M7_REVIEW_GATE_AUDIT.md` row F); plugin files writable via Python (T2) | Minor (by design) |
| Untrusted tool output | `gh`, tracker CLIs, test output, telemetry payloads | ticket.py normalises and redacts telemetry, treats it as data (`skills/ticket/SKILL.md`); tracker output validated by script | `tests/test_ticket.py` | The model reads raw output | Minor |
| Agent permission escalation | Injected agent asks for a tool outside the list, or edits `runner.json` | `--permission-prompts none` refuses and records it; `--restricted`, `--strict-mcp-config` (`executor.py:120-129`); `command()` refuses `Bash`, `Bash(*)`, `*`, `dangerously` (`:134-136`); `policy.read` refuses the same (`policy.py:179-180`); preflight requires each flag (`executor.py:74-75`) | (M7) `ExecutorBoundaryTest` (5), `RunnerFileTest.test_every_shell_command_is_refused`; `tests/test_unattended_commands.py` | Python in the allow list (T2): a run can write a valid `runner.json` for this machine and folder with wider tools, and the supervisor reads the policy from disk again on its next pass (whether every pass re-reads it was read in `policy.py:219` and not separately tested) | Major (T2) |
| Build-script execution | Generated code's `Makefile`, `package.json` scripts, `conftest.py`, test commands from tracked `.factory/config.json` | Commands are `shlex.split` and run without a shell (`build.py:296`, `verify.py:228`, `merge.py:161`, `audit.py:269`); nothing else | (M7) `test_configured_commands_are_split_never_shelled`, `test_no_shell_anywhere` | The named program runs whatever it likes, with the engineer's privileges, on every build/verify/merge, attended or not | Major (inherent; same remedy as T2: OS sandbox) |
| Credential exposure | Keys in the supervisor's env reach the run; secrets in logs | `executor.environment` passes a fixed list and drops names matching KEY/TOKEN/SECRET/...; proxy with `user:pw@` dropped (`executor.py:145-154`); Studio interview `childEnv` (`engine.go:252`); observer redacts (`M6_5_SECURITY.md`) | (M7) `test_no_credential_reaches_the_run`; Studio `TestLogsHoldNoSecretsOrContents` | Files under `HOME` (`~/.ssh`, `~/.config/gh/hosts.yml`, keychain via `git credential`) are readable by any Python the run starts (T2) | Major (T2) |
| Localhost service misuse | Another local user or a page connects to Studio/observer | Loopback-only bind, port-only API (`server.go:32-37`); one-time link exchanged once (`session.go:73-88`); cookie `HttpOnly`, `SameSite=Strict` | Studio `TestOnlyTheLoopbackInterfaceIsBound`, `TestTheStartTokenIsNeededAndWorksOnce`; (M7) `TestM7TheHostBindsLoopbackOnly` | Another process of the same user can read the printed link from the terminal or `.factory/local/observer/link` | Minor |
| Browser-origin and CSRF attacks | Cross-site POST, DNS rebinding | Exact Host match (`session.go:99-104`), Origin must equal `http://`+Host and CSRF header must match (`:113-126`), JSON content type (`server.go:141-144`), clean paths only (`:154-160`) | Studio `TestTheHostHeaderMustBeExact`, `TestStateChangesNeedOriginCSRFAndJSON`; (M7) `TestM7HostSpoofingIsRefused` (9 Host spellings), `TestM7CrossSiteOriginsAreRefused` (8 origins incl. `null`, the other loopback name), `TestM7NoCSRFTokenWithoutTheSession` | none found | — |
| Filesystem traversal and symlink escapes | `../` in IDs, spec paths, draft routes; symlinks in product files, policy, intake ledger | ID patterns (`apps/studio/internal/engine/args.go:15-24`, `ticket.py:36`, `executor.py:59`); `collab.tracked` + symlink skip (`collab.py:45-46`, `:78`); spec path must be tracked (`intake.py:271`); policy and ledger symlink refusals (`policy.py:145-146`, `intake.py:165-166`); Studio `ResolveDraft` (`security/drafts.go:41`) | `test_unsafe_spec_reference`, `test_symlinked_spec`, Studio `TestSymlinkAttacksOnDraftWrites`; (M7) `test_a_spec_path_outside_specs_slices`, `test_a_symlink_in_product_is_never_followed`, `FilesAtTest`, `test_ticket_ids_with_paths_or_options_are_refused`, `TestM7DraftsOutsideTheWorkspaceAreRefused`, `TestM7ArgumentsCannotBecomeOptionsOrPaths` | none found | — |
| Tampering with Factory activation state | Edit, copy, widen, symlink, chmod `runner.json`; tracked config widening | `policy.read` (`policy.py:136-189`), `effective` narrows only (`:192-222`), review-settings re-check each pass (`:64-80`, `:220`) | (M7) `RunnerFileTest` (11 tests); `tests/test_mach_factory_supervisor.py` | T1 (a tracked `runner.json`); same-user processes can write it (T2) | **Major (T1)** |
| Unauthorized dispatch | Supervisor or another caller dispatches without a person | `_dispatch` refuses a non-engineer without `authorize`, requires `True` (`intake.py:1007-1017`); supervisor's authorization is `may_execute` on the policy read at that moment | `test_only_an_engineer_dispatches_without_authorization`; (M7) `DispatchAuthorizationTest` (code-path check) | Rests on `runner.json` (T1) | Major via T1 |
| Git hook abuse | A tracked `.githooks/`/`.husky/` folder, or a hook planted in `.git/hooks` by an agent, runs on a station's commit | No MACH script sets `core.hooksPath` or installs tracked hooks; only `service.py` writes marked lines into the repo's own hooks folder, on request, and leaves a project that sets `core.hooksPath` alone (`service.py:46-75`) | (M7) `GitHookTest` (3) | Station commits (`build.py`, `merge.py`, Studio `send`) do not pass `--no-verify`, so any hook in `.git/hooks` runs; an agent with Python can plant one (T2). Whether Claude Code's Write tool refuses `.git/` is not assessed | Minor (under T2) |
| Compromised release artifacts | Tampered binary plus forged `SHA256SUMS`; mirror URL | Scheme check (`bin/mach:217-218`); checksum; `gh attestation verify --signer-workflow` when `gh` exists (`:268-287`); actions pinned by commit SHA (`release.yml:28,39,42,49,137`) | `tests/test_installer.py` (simulated) | T6. `M7_SECURITY_SCANS.md` §5 said actions are pinned by tag; that is corrected there (they are pinned by commit) | Major (T6) |
| Supply-chain dependency attacks | Python stations: standard library only; Go: standard library (observer), small set (studio); web: pnpm lockfile, build-time only | Embedded web apps, CSP `default-src 'none'` and `connect-src 'self'` (`apps/studio/internal/security/headers.go:7-9`); OSV/Trivy run (`M7_SECURITY_SCANS.md` §3: no finding) | scans in `M7_SECURITY_SCANS.md` | Generated projects' dependencies are not scanned by the line (section 3) | Minor |

### 2.3 The central residual risk, stated plainly

A station's agent reads untrusted text: the approved spec's prose, the ticket body, the code in the cell, test and
tool output, and in review the diff. An unattended execution (`executor.command`, `executor.py:132-142`) gets exactly
these tools (`policy.py:52-53`, `:132-133`): `Workflow`, `Skill`, `Agent`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
`Bash(python3 *)`, `Bash(<the stations' interpreter path> *)`, `Bash(git status *)`, `Bash(git log *)`,
`Bash(git diff *)`, `Bash(git show *)`, plus any extra tool the person added at activation. No MCP server, no other
plugin, no user settings, hooks or agents (`--restricted`, `--strict-mcp-config`). Anything else is refused without a
prompt and raised to a person.

**What a successful injection could not do through the tools themselves:** run `git push`, `git commit`, `gh`,
`curl` or any other program as a direct Bash command; edit `.factory/local/`, `.claude/` or the MACH plugin with the
file tools; read or write outside the project with the file tools; load a new skill or MCP server.

**What it could do anyway:** `python3 -c "..."` is arbitrary code. From inside it: run `git push` (the engineer's
credential helper or SSH agent socket is reachable through `HOME`; `SSH_AUTH_SOCK` is not passed but the key files
are), call the network, read `~/.config/gh`, write a hook into `.git/hooks`, write a valid `runner.json` (it is re-read
every pass), write outside the cell, or change the plugin files. The executor's comment says so (`executor.py:113-115`).

**What still catches the result in the line** (not the side effects): a task may change only the plan's files and
committed tests are frozen (`build.py`); verify reruns the suite and accepts only evidence captured in this run and
hashed (`verify.py`); review is fresh-context with any-seat high/critical security veto (`review.py`,
`M7_REVIEW_GATE_AUDIT.md` §5); High risk needs a person; the approval is bound to a commit and a later commit voids it
(`merge.py`); by default an execution stops before merge (`CLAUDE.md` M4). None of these sees a push to another
branch, an exfiltration, or a change outside the repository. **Severity Major**; remedy in T2.

### 2.4 Product Studio's interview turn (narrower than the Factory)

`apps/studio/internal/interview/command.go:21-22,54-115`: tools `Read,Glob,Grep,Edit,Write,Bash`; Bash allowed only as
`<python> <studio.py> <listed op> [<this slice>]`, the approve/send/reconcile family denied; Edit only on this slice's
spec and why under the draft folder; the message after `--`; restricted mode and no MCP. An injection in a PM's own
text can at most rewrite that slice's two draft files, which the PM then approves or not. Evidence:
`internal/interview/interview_test.go` (fake claude). Real model behaviour: not assessed.

## 3. The software MACH generates

| Control | What it does | What it does not do | Evidence |
|---|---|---|---|
| Review security seat and veto | Medium/High panels have a `security` seat; since M7 a `class: security` blocker of high/critical impact from **any** seat rejects at every tier and `security_veto: false` cannot switch it off | Severity is the reviewer's claim; nothing reproduces it; Low tickets have one general seat (the class veto still applies to its findings) | `tests/test_review.py` `SecurityFindingTest`; `M7_REVIEW_GATE_AUDIT.md` §5 |
| Supervisor refuses settings that remove the security check | `policy.security_review_problems` (`policy.py:64-80`) re-read each pass | Interactive `/mach` and the belt do not check | `test_review_settings_that_remove_the_security_check_hold_every_pass` |
| Audit's secret-scanning check | 2 of 100 points if a scanner's **name** appears in pre-commit/CI config or `.gitleaks.toml` exists (`skills/audit/scripts/audit.py:361-363`) | Runs no scanner, reads no result | `M7_SECURITY_SCANS.md` §7 |
| Dependency and static scanning in the line | none | No SAST, secret scan or dependency scan of generated code at build, verify or review | — |
| Release qualification security check | `qualify.py` reads scanner reports under `.factory/release/scans/` for the exact commit; missing is `not_run`, which makes the outcome `incomplete`, never `qualified` (`skills/run/scripts/qualify.py:461-464`, `:485-487`); open security review blockers are listed (`:376`) | Only at release time; scanners must be run by someone; no waiver file for scanner findings (corrected: `run.py release except` exists since `c73c11e`, a person's exception for one check at one commit, recorded in `exceptions.jsonl`; it is not a tracked allowlist for scanner findings) | `tests/test_release_qualify.py` |

Residual: generated code can ship with vulnerable dependencies or a committed secret unless a reviewer notices; the
release check catches it only when scanner reports exist. Severity **Major** for any claim that MACH "produces secure
software"; **Minor** for the claim actually made (reviewed, with a release gate that is incomplete without scans).

## 4. Privacy and local applications (Phase 5)

Observer column: from `M6_5_SECURITY.md` §8 and `M6_6_ACCEPTANCE.md` §8 (not redone here). Studio column: code read
here and the tests named.

| Requirement | Product Studio host | Factory Floor observer |
|---|---|---|
| Loopback only | **Met.** `server.go:32-37` binds `tcp4 127.0.0.1`, port only. `TestOnlyTheLoopbackInterfaceIsBound`, (M7) `TestM7TheHostBindsLoopbackOnly` | **Met.** §8 M6.6 |
| No wildcard or LAN listener | **Met.** No flag or env selects an address; (M7) dial to each non-loopback IPv4 refused | **Met.** §8 |
| Session authorization | **Met.** One-time token → `HttpOnly`, `SameSite=Strict` cookie, every API route (`server.go:132-135`). `TestTheStartTokenIsNeededAndWorksOnce` | **Met.** §8 |
| Host and Origin validation | **Met.** `session.go:99-126`. (M7) 9 Host and 8 Origin spellings refused | **Met.** §8 |
| CSRF and DNS rebinding | **Met.** CSRF header token, served only to the session; exact Host. (M7) `TestM7NoCSRFTokenWithoutTheSession` | **Met** (GET only, Host/Origin/Fetch-Site). §8 |
| Safe Markdown and untrusted text | **Met as far as read:** no `innerHTML`/`dangerouslySetInnerHTML` in `web/apps/product-studio/src`; CSP `script-src 'self'`. A rendered-page attack was **not assessed** here | **Met** with labels; R1 open (below) |
| Artifact access control | **Met.** Only this project's draft spec/why by validated slice ID (`security/drafts.go`); `TestDraftWritesAreCheckedAndConfined`, `TestSymlinkAttacksOnDraftWrites`, (M7) `TestM7DraftsOutsideTheWorkspaceAreRefused` | **Met.** Evidence media only with `floor.evidence_media`; §8 |
| No arbitrary file reads | **Met.** No route takes a path; unknown JSON fields refused (`args.go` `Decode`). (M7) `TestM7ArgumentsCannotBecomeOptionsOrPaths` | **Met.** §8 |
| No browser-triggered shell | **Met.** Fixed operation list (`engine/ops.go:400-430`) run as argv to `studio.py`; none starts a station, dispatches or enables. (M7) `TestM7OnlyListedOperationsExist`. The interview turn is a restricted `claude -p` (2.4) | **Met.** Starts no process. §8 |
| No credential exposure | **Met.** Child env filtered (`engine.go:252`); logs hold no token (`TestLogsHoldNoSecretsOrContents`) | **Met.** §8 |
| Browser storage | **Met with a note:** `sessionStorage` holds a pending idea's text and delivery memory (`web/apps/product-studio/src/api/pendingIdea.ts`, `features/waves/delivery/memory.ts`); cleared with the tab. No `localStorage` found | **Met.** No prose in storage. §8 |
| No remote analytics or telemetry | **Met.** CSP `connect-src 'self'` (`headers.go:7-9`) | **Met.** §8 |
| No runtime CDN | **Met.** Embedded assets, `default-src 'none'` | **Met.** §8 |

**R1, actual disposition after M6.6:** still served, labelled and contained. A person's name that appears only in
prose is served in the declared free-text fields and their 42 declared copies, artifact content, file names and the
project folder name (`M6_6_ACCEPTANCE.md` §8). Redaction is not comprehensive and is not claimed. **Any claim of
confidentiality for free text is blocked**; if the release environment requires it, the privacy gate fails. Remediation
options: withhold prose at the observer by default (codes and counts) with an explicit local opt-in to show it; or keep
label-and-contain and scope the release claim to "single engineer's own machine, no screen sharing". Evidence Theater
stays deferred.

## 5. What was not assessed

Real model behaviour under injection (no `claude -p` was run, by rule); whether Claude Code's own Write tool refuses
`.git/`; a rendered-page XSS attempt on Studio; Windows; release artifacts built by CI; the observer (cited, not redone).

## 6. Tests added and run (M7)

| File | Tests | Result |
|---|---|---|
| `tests/test_m7_adversarial_activation.py` | 20 | 19 passed, 1 expected failure (T1) |
| `tests/test_m7_adversarial_injection.py` | 10 | 9 passed, 1 expected failure (T4) |
| `tests/test_m7_adversarial_product.py` | 8 | 7 passed, 1 expected failure (T3) |
| `apps/studio/internal/server/m7_adversarial_test.go` | 7 | 7 passed |

Commands: `python3 -m unittest tests.test_m7_adversarial_activation tests.test_m7_adversarial_injection tests.test_m7_adversarial_product`;
`cd apps/studio && go test ./internal/server/ -run TestM7 -count=1`. Each expected failure was confirmed to fail on
its own assertion, not on set-up. When a defect is fixed, remove its `expectedFailure` marker.

(corrected: the three expected failures (T1, T3, T4) were fixed in `d68f83f` and their markers removed. The table above is the result at the time of writing; the tests were not re-run for this note, and the final regression is row 62 of `M7_ACCEPTANCE_MATRIX.md`.)

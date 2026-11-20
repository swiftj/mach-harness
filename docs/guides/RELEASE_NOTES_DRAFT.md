# MACH release notes: 0.16.0

Status: a full release. MACH is not claimed to be ready for regulated or enterprise production use. This document opens with what changed in 0.16.0, then 0.15.0 and 0.14.0, each with how far it was tested. Everything from "Supported platforms" on was written for 0.13.0 from its test runs (the M7 documents in `docs/mach-next/`); where a later release replaced something it describes, the tables say so, and the 0.13.0 test record was not repeated.

## What changed in 0.16.0

Three milestones in one release. Everything below passed the automated suites (1,754 Python tests, the Go tests for both programs, the web typecheck, lint and unit tests, and the app-versus-terminal conformance suite). **None of it has been run against real GitHub, a real Jira, a real PRD or a real model, and nobody has looked at the new screens.** Read each "how far tested" with that in mind.

| Change | What it is | How far it was tested |
|---|---|---|
| Enterprise Managed User logins | A GitHub login ending in `_shortcode` is accepted everywhere: sign-in, marking a slice ready, the approval and acceptance comments, intake. The rule now lives in one place. `/mach doctor` asks only about github.com's sign-in. | Automated tests with a stand-in. Not tried with a real managed account. |
| Product principles | Rules that hold across every slice, published on the project's issue with the product manager's approval. Every spec answers every principle; reviewers may cite them. | Automated tests only. |
| Effects on shipped behaviour | Every spec says what it does to rules that have shipped: kept, changed, replaced or retired. The build station works on today's main branch; the merge station checks what landed in between and has the change verified and reviewed again when it touches the same ground. | Automated tests only. |
| How an epic works today | `/mach current` and Product Studio compile the rules in force from shipped slices, by script. The Factory keeps one comment on the epic's issue up to date. | Automated tests only. |
| Starting from a PRD | Optional. Import a document, settle a proposed map of epics and slices with every section accounted for, then confirm drafted answers instead of answering each from nothing. | Automated tests only. The instructions have not been tried with a real document and model. |
| Jira | A Jira key on a slice or epic is carried to the pull request title and merge commit. `jira export` writes a CSV to upload; `jira keys` brings the new keys back. MACH never calls Jira. | Automated tests only. **Not imported into a real Jira.** The description format on import is not confirmed by Atlassian's documentation. |
| The change record | Each change lands with `docs/changes/<ticket>.md`: the why, the plan, every check with the hash of its evidence, every reviewer's findings, who approved, every exception. | Automated tests only. |
| Policy packs | Organisation policies as files in the repository, each with an owner. A spec answers each pack that applies; a flagged concern holds the slice until its owner accepts it or the spec changes. | Automated tests only. |
| Design mocks | Up to four pictures per slice, bound to the approval by hash, delivered as committed files. The verifier records a side-by-side result for each. | Automated tests only. |
| `/mach-idea` | A short interview for someone who is not an engineer; files the idea in a fixed template with no label. | Automated tests only. Not tried as a conversation or on claude.ai. |
| Factory evals | Finished tickets kept as cases and, on a person's command with a budget, replayed in throwaway copies to compare the Factory before and after a change to its rules or models. | Automated tests with a stand-in for Claude. **No real model run has been made.** |
| Self-reporting | MACH records its own internal errors on the machine; `/mach report` shows the exact issue text and files it on MACH's repository only on the person's yes. | Automated tests only. Nothing was filed on real GitHub. |
| Verification and review | The verifier re-proves up to two neighbouring shipped scenarios. A reviewer's note is important or a nit, with nits capped per seat; a person may rate a finding. | Automated tests only. |
| Control bands and scan intake | `/mach bands` watches the Factory's own measures for drift. `ingest-scan` turns a security scanner's findings (SARIF or CSV) into tickets, held at Medium risk or above. | Automated tests only. Claude Security's export format is not verified. |
| Product Studio app | Screens for principles, policy packs, effects, how an epic works today, the PRD on-ramp, Jira and design mocks; requests in the idea template shown in five parts. | Automated tests and the conformance suite. **Not looked at.** |
| Factory Floor | The new waiting states, the approved mock beside the captured screen, the Jira key and the change record on a ticket. Two Analytics figures that miscounted the new records are fixed. | Automated tests. **Not looked at.** |

**Still the main thing not proven:** no ticket has yet been built from start to merge through the hand-off that 0.14.0 introduced, and 0.16.0 adds a great deal to that path.

## What changed in 0.15.0

| Change | What it is | How far it was tested |
|---|---|---|
| A recorded exception for a security blocker | `/mach except <ticket> <round>/<seat>/<n> "<why>"`: a person accepts a vetoing security blocker for exactly the commit reviewed, with an optional expiry. A reviewer whose only blockers are all excepted then counts as approving, so it works at every risk tier; a High-risk change still needs a person's approval as well. Refused in any unattended run and for `factory-tuning` tickets. Recorded in the decision, the pull request, the run record and the lifecycle log; a release that includes one is at best "qualified with exceptions". `review.security_exception_by` may list who can grant one. | Automated tests only. No live run. |
| Secrets never enter a branch | The build station scans what it is about to commit and refuses anything shaped like a credential. The builder's override needs a reason, which the reviewers see. | Automated tests only. Shapes not found include Azure, Twilio, SendGrid, npm, PyPI, Datadog and Discord tokens, short or low-entropy passwords, and split or encoded values. |
| Review answers for secrets and dependencies | The review packet lists every secret candidate and every dependency the change adds or bumps. The security reviewer must answer each, on the contracts tier when anything is flagged; a flagged Low-risk change gets three reviewers. A candidate called real must be a high or critical security blocker. `security.scan.enabled: false` switches it off, and unattended work is then refused. | Automated tests only. Dependencies are **not** checked against a vulnerability database: a model's knowledge ends at its training date. A team that wants that runs its own scanner through Claude Code hooks or CI. How well the model judges a dependency was not measured. |
| Diagrams in ADRs and plans | A Mermaid diagram may be drawn where the structure or the sequence is the decision; a script checks its kind, size and that it carries nothing but the picture. Slice specs carry none. | Automated tests. How GitHub draws one MACH wrote was not looked at. |
| Factory Floor fixes | Small text on the Line now passes contrast; the analytics colours are tokens; the sample factory's feed no longer lists events later than its clock. | Automated tests. Not looked at on screen. |
| Product Studio | A note where an issue link is first offered, saying a private repository's issue opens only in a signed-in browser; `Y` confirms the interview's summary; a slice is introduced as a slice of intent. | End-to-end suites with stand-ins. Not heard with a screen reader. |
| Installer | The newest release is found from the release page when GitHub's API does not answer (shipped on `main` before 0.14.0's tag). | Automated tests, and one real install of 0.14.0 on one Mac. |

**Still the main thing not proven:** no ticket has yet been built from start to merge through the hand-off that 0.14.0 introduced.

Notarisation of the macOS programs, and Windows and Intel Mac builds, are not planned.

## What changed in 0.14.0

| Change | What it is | How far it was tested |
|---|---|---|
| Slices as GitHub issues | Product Studio saves a finished slice as an issue under its epic's issue and marks it ready; that issue is the Factory's ticket. The project is one pinned issue. Without `gh`, the same slice is written to a folder. | Automated tests with a stand-in `gh`. **Real** GitHub once, by a person: three issues created, the sub-issue link, pinning and the approval comment as designed. |
| Removed from Product Studio | Delivery waves, `slice approve`, `send`, `feedback`, the product pull request, epic approval. An epic is a container: `open` or `deferred`. | Automated tests. A draft made by 0.13.0 with an epic `proposed` needs `epic set <EPIC-ID> --status open` once. |
| Factory intake from issues | `/mach product` takes in issues marked ready (and committed ready folders), checks who marked them and that the text matches its approval, and reports back on the issue: being built, a question, shipped and closed. | Automated tests. **Real** once: one issue accepted and dispatched. The status writes back to the issue, the builders' question and closing on merge were **not seen live**. |
| `/mach pull` | One command for the engineer: take in what is ready, schedule it, dispatch it, then run it. | Automated tests. **Real** once, as far as dispatch; it then stopped at the technical baseline as designed. A build started by it was **not seen live**. |
| Architecture decisions | MADR files in `docs/adr`. Accepted ones bind planning, building and review. No ticket is planned until the required topics (language, framework, storage, testing, deployment, coding standards) each have an accepted decision on the main branch. `/mach adr baseline` drafts them from the repository and settles open points by interview. `adr.landing` says how they reach main: a pull request (default) or a direct commit. | Automated tests. **Real** once: the baseline stop, six drafts, the interview, acceptance, commit. A plan made under them was **not seen live**. |
| Release qualification per epic | `release qualify --epic`, or a named list of slices; product acceptance is a comment on the epic's issue. | Automated tests only. |
| Factory Floor: the Line | A 2D view, stations as columns and tickets as rows, is the default. The isometric Floor and Analytics remain. The Timeline, the Execution Blueprint and all playback were removed. Epics replace waves. | Automated tests and the built-in sample factory. Not checked against a real run of this release. |
| Product Studio's screens | A project home in place of the navigation rail, a roomier interview with a Yes button on its summary, "Mark ready to build", each slice's place with the builders, the builders' question with "Answer it", slice order, "On GitHub". | End-to-end suites with stand-ins; used by a person on one Mac. |
| Requests, scheduling, decisions | GitHub issues as requests in Product Studio (M8); several tickets scheduled by script, one worker per ticket and the walkthrough of decisions (M9); notifications when a ticket waits (M10); the evidence player; `/mach` as the one command; `doctor` and `explain`. | Automated tests; parts were seen in the live checks recorded in `docs/mach-next/`. |
| Installer | An updated program is moved into place as a new file, so macOS no longer stops it. The newest release is found from the release page when GitHub's API does not answer. | Automated tests. The first was seen fixed on one Mac; the second was run against the real release page, not on the machine that reported it. |
| `make test` | Runs each test class in its own process, one worker per core. | Used for every change since. |

**The main thing not proven:** no ticket has yet been built from start to merge through the new hand-off. Every step has automated tests; a person has seen the steps up to the build.

Rows of the component table below that 0.14.0 replaced: "Product Studio, terminal" and "Product acceptance record" (no waves; acceptance is per epic), "Product intake and scheduling" (issues and ready folders, not merged waves; `product resolve` is gone), and "Factory Floor" (Line, Floor, Analytics). In "Upgrade guidance", the version examples are 0.13.0's. In "Tested scenarios", every row about sending, reviewing or accepting waves describes 0.13.0.

## Supported platforms

Per `.github/workflows/release.yml`, the release builds `mach-studio` and `mach-observer` for:

- macOS on Apple silicon (`darwin/arm64`)
- Linux arm64 (`linux/arm64`)
- Linux amd64 (`linux/amd64`)

Each is smoke-tested on a native runner of its kind (`macos-latest`, `ubuntu-24.04-arm`, `ubuntu-latest`) before anything is published. The workflow has run on a tag: `v0.13.0-rc.2` was published as a pre-release with six programs, six SBOMs, a source archive and `SHA256SUMS`, and every build, smoke and publish job succeeded. Its earlier attempts were never published: `rc.1` failed on a data race in the observer and a Linux file-identity defect (both fixed), and `rc.3` on a shell-syntax error in the installer on Linux (fixed). Only the `darwin/arm64` programs were run by hand from the published files; the Linux builds are verified by the release's own smoke jobs, not by hand.

**Windows and Intel Mac are not built or tested.** The v0.12.0 release still carries a `darwin-amd64` Studio file, but the installer never selects it. On those machines the Python skills and scripts and the terminal version of Product Studio can run, but the visual app and the Factory Floor have no program for them. The Python scripts themselves were run only on macOS.

**The macOS programs are ad hoc signed and not notarised.** Gatekeeper rejects them. A program downloaded through a browser carries macOS's quarantine mark and is blocked on first run until you allow it in System Settings; the installer's own download carries no such mark. The installer's checksum and attestation checks are the protection there, not Gatekeeper. The browser case was not exercised.

## Installation prerequisites

Claude Code, `git`, and `python3` 3.8 or later. The GitHub CLI (`gh`) is needed to send product work and to verify build provenance. Python 3.8 is the stated minimum. Python 3.9.6 and 3.15 were run, nothing older. A missing Git or Python stops the installer with a plain message and, on a Mac, the `xcode-select --install` step.

## Supported features, by component

| Component | Status | What it does |
|---|---|---|
| Stations: ticket, audit, intent, build, verify, review, merge, cleanup, observe | Built, tested | The factory's conveyor belt. Scripts decide gates, order, commits and verdicts. |
| `run` skill and `mach:belt` workflow | Built | Names the next step per ticket; runs several tickets in parallel cells. A supervised execution works on its own ticket only. |
| Product Studio, terminal | Built | Project, epics, slices by interview, approval, delivery waves, refresh, conflicts, send, feedback, product acceptance record. A wave's definition and the acceptance are sent as separate requests. |
| Product Studio, visual app | Built | Same workspace in a browser on `127.0.0.1`. Product acceptance is terminal-only. |
| Product intake and scheduling | Built | Takes merged approved waves in, plans by dependency, dispatches on an engineer's word. A revised slice is taken in after its abandoned ticket by itself; for work still in the line a person decides with `product resolve --supersede-in-work`. |
| Factory supervisor | Built | Off until enabled per machine with a code. Observe and supervised modes. Supervised mode also needs the execution risk accepted with `--accept-execution-risk`. Stops at every human gate. Parks a run that makes no progress at once. |
| Factory Floor | Built | Read-only live view in three workspaces: Atlas, Timeline (Execution Timeline), Analytics. |
| Release qualification (new in M7) | Built | `run.py release`: one commit, four outcomes, a deterministic readiness file, an outcome line naming every check not assessed, scanner reports with a required format. |
| Product acceptance record (new in M7) | Built | `studio.py acceptance record`, bound to the wave as merged at a release and commit. |
| Installer provenance check (new in M7) | Built | The one-line installer installs a release, verifies its source archive and programs against `SHA256SUMS` and, with `gh`, their build attestation, before any downloaded code runs. |
| Security review rule (new in M7) | Built | A high or critical security blocker from any seat rejects the round. |
| `cell.py replan` (new in M7) | Built | Returns a planned or building cell to `spec-ready` to be planned again, on a person's instruction, keeping its history. |

## Upgrade guidance

Based on a hand-built upgrade from v0.12.0 state (`M7_DISTRIBUTION.md`), a real v0.12.0 install upgraded to `v0.13.0-rc.2` and a live project upgraded from snapshots in the live runs:

- **Kept byte-identical:** Studio drafts, the intake ledger and events, cells, the archive and run records, `runner.json`, the observer folder, `.factory/config.json` and a customised `REVIEW.md`.
- **A supervised authorization written before the execution-risk acceptance reads as disabled.** After upgrading, enable again and confirm with `--accept-execution-risk`. Observe-mode authorization is unaffected.
- **Changed:** MACH's own scripts and skills, the managed block in `.gitignore`, the manifest, and the downloaded programs. The Factory Floor program is added.
- **A second upgrade** touched no file but the manifest's timestamp.
- **No migration step** was needed or found. Cross-version compatibility of an observer index could not be shown because v0.12.0 shipped no observer.
- **Rollback is not documented.** In the hand-built test, running the older installer over the newer one restored the older files and removed the observer, and the older scripts read the state without error. Back up `.factory/` first. The installer never touches it.
- **Choosing a version.** The default install is the newest full release, never a candidate. A candidate is installed with `MACH_VERSION=<x.y.z>-rc.N`. The README's one-line command pulls `install.sh` from `main`, which until this branch is merged is the older installer: it installs the `main` branch and checks nothing.
- **`mach install --no-studio` rewrites a tracked manifest** that lists `mach-studio`, leaving the clone dirty; restore it with `git checkout`.
- **Not tested:** the shipped installer for the current candidate against GitHub (rc.2's own installer refused rc.2's version; the full path was verified with a patched scratch copy), an upgrade through a clean second machine, any state written by a future format change, and installs on Linux by hand.

## Known issues (open items)

1. **`install.sh` itself is not verified.** The installer checks the release's archive and programs; nothing checks the script you ran, which is fetched from `main`. Installing a branch or a local copy is possible only by explicit choice and says it was not verified.
2. **A prompt injection that succeeds in an unattended run can run arbitrary code as the engineer** (`Bash(python3 *)` is on the tool list). No operating-system sandbox exists. Enabling supervised mode records that a person accepted this; it removes none of it. Real model behaviour under injection was not tested.
3. **Recorded cost excludes failed executions.** Analytics says "a lower bound": in the real runs it left out USD 0.77 and 0.44 of known failed cost, and killed executions have no recorded cost at all, so real spend can be higher than shown. The per-run and per-day limits count only recorded cost.
4. **Names in free text are shown by the Factory Floor**, labelled, not removed. No confidentiality claim is made.
5. **Nothing distinguishes a product manager's copy from an engineer's.** `factory enable` produces a code there. Which machine may enable is decided only by the person at it.
6. **No notarisation.** The macOS programs are ad hoc signed (see Supported platforms).
7. **The source archive is not byte-reproducible across gzip implementations.** The tar inside is identical; the published checksum is for the published file, so installs are unaffected.
8. **A repeated review round or a voided decision is not shown on the Factory Floor page.** The observer serves them; the page does not word them. An abandoned cell's tile still shows its last stage (its mast and inspector say Abandoned).
9. **A supervisor hold has no reason code**, and repeated lifecycle lines are counted again. A 240,000-event history switches views slower than its budget.
10. **No vulnerability-reporting address yet** (see Security disclosures).
11. **Fixes from the third live run were not re-observed live.** They have unit tests only: the belt's hand-off validation, Product Studio's workspace repair, the scanner-report format and the outcome line, sending an acceptance alone, the Factory Floor's wording for killed and abandoned runs, and the installer's candidate-version and POSIX-shell fixes.
12. **Nothing was tested on a second machine, with two GitHub accounts, with signed commits or with Enterprise single sign-on.** Rules were enforced by real GitHub.com on one personal account; an approved review under enforced rules and a signed commit were not shown.
13. **Nothing designates one runner across machines.** Two engineers' machines can both enable.
14. **No dependency, secret or static scan of generated code in the line.** The audit only checks that a secret scanner is configured. Release qualification reads scanner reports someone else produces; the real runs had no dependency manifest for osv-scanner to read. (Since 0.15.0: the build station refuses a commit whose added lines look like a credential, unless the builder records why it is not one, and review lists every secret candidate and every added or changed dependency for the security seat to answer on the contracts tier's model; a flagged Low-risk change gets the three-seat panel. Nothing is checked against a vulnerability database, and no static analysis is run; see `docs/mach-next/M12_SECURITY_SCAN.md`.)
15. **No exception record for a security blocker.** An unmarked blocker from a non-security seat can still be outvoted at Medium. Low-risk tickets have no security seat. (Since 0.15.0: the first sentence no longer holds. A person's exception to a vetoing security blocker is recorded with `/mach except`, for the commit reviewed only; see `docs/mach-next/M12_SECURITY_EXCEPTION.md`. The rest of this item still stands, except that a Low-risk change the security scan flags is now reviewed with a security seat; see `docs/mach-next/M12_SECURITY_SCAN.md`. An exception also clears a reject vote that rested only on the excepted findings, so it now works at High and Low risk too.)
16. **No real, person-driven run of the Product Studio journey** with a real interview on a second computer and a real enterprise remote. One real interview ran through the app's interface for about USD 0.23; the later runs wrote specs by hand.
17. **The `pr` merge method was never run against GitHub**, and `merge.mode: auto` was never run live. A reboot or network loss during an execution was not tested live.
18. **Cross-slice defects can reach a merge unnoticed.** In the real run a returned item would have broken the overdue report; a reviewer predicted it as a non-blocking note, no test caught it, and only a textual conflict brought a person to the merge.

Smaller open items: reconciling a conflict across a slice's two files is still one file at a time; a stale status suggestion for a wave another manager already sent; a ticket body keeps the old revision after a product revision; `resolve` records a role word, not the engineer's identity; accessibility checks with a screen reader and Safari were not done.

Fixed during M7 and seen working again in a later live run: a plan whose implementation task cannot go green is refused at the plan check; a build or plan that stops making progress is parked at once; a killed execution is recorded as killed with its exit code; a re-review after a voided approval no longer overwrites the round it repeats; release qualification accepts a shared contract changed by a later reviewed slice; the acceptance record binds to the wave as merged; sending a revised wave whose first request merged opens a new request; a revised slice reaches the line after its earlier ticket was abandoned, or after `product resolve --supersede-in-work`; a parked cell can be re-planned with `cell.py replan`; a supervised execution works on its own ticket and a due observe pass is raised to a person.

(Earlier drafts listed threat model T1, a `runner.json` that arrives through Git, and a deeply nested JSON value that crashed intake. Both are fixed, with an oversized product file and a ticket title that pulled in other fields, in `d68f83f`. The open ones in `M7_THREAT_MODEL.md` are T2, T6 and T7.)

## Explicitly deferred

- Evidence Theater (a richer evidence viewer).
- Portfolio management across projects.
- Multi-runner coordination across machines.
- An operating-system sandbox for unattended executions.
- A recorded exception for a security blocker (designed, not built; it needs the product owner's decision). (Since 0.15.0: the product owner said yes and it is built; no longer deferred. See `docs/mach-next/M12_SECURITY_EXCEPTION.md`.)
- Windows and Intel Mac builds.
- Apple notarisation.
- A rollback procedure.
- Default withholding of free text in the Factory Floor.

## Tested scenarios

Each scenario is labelled **real**, **simulated** or **mocked**. Several people, machines and engineer gates were played by agents on one Mac.

| Scenario | How it ran |
|---|---|
| Two product managers and an engineer: define, approve, send, review, merge, refresh, renumber, conflict, intake (five tickets, repeat creates none) | **Real** GitHub repository and pull requests, **simulated** as separate people: three clones on one Mac, one GitHub account. Real approvals were refused by GitHub (own pull request). |
| Network cut, push succeeded but pull request timed out, invalid sign-in | One **simulated** (dead proxy), one **simulated** (wrapper that fails once), one real invalid token. |
| Branch rules on GitHub.com: required pull request, one review, code owners, a required check, signed commits, blocked force pushes, a ruleset refusing a branch | **Real** GitHub.com, one personal account (the repository made public for it; rules removed afterwards). Refusals and the PM's messages as seen. Not an organisation; no approved review, no signed commit. |
| Single sign-on refusal | **Mocked** message. Messages were corrected afterwards and tested with stand-ins only. |
| One real interview turn through the Studio app | **Real** Claude Code, one slice, two turns. |
| Fresh install as a product manager with no Node or Go, checksum refusal, truncated and missing files | **Real** installer, **simulated** release (a local folder, not GitHub). |
| Provenance verification | The published `v0.13.0-rc.2` files: **real** `gh attestation verify`, 8 of 8, by hand. The installer's own path and refusals: **simulated** (a fake `gh`), and **real** on rc.2 only through a **patched copy** of its installer; the shipped installer refused its own version. |
| Release pipeline on a tag, per-platform smoke tests, SBOMs | **Real** workflow run on `v0.13.0-rc.2` (read from its jobs, not run by hand). |
| Upgrade from v0.12.0 and uninstall | **Real** installer on a hand-built state; a real v0.12.0 install upgraded to rc.2 with a patched copy. |
| Supervised runs: intake, dependency hold, two cells at once, build, verify, review rejection with a security blocker, revise, human gate, by-person merge, cleanup, daily run limit, disable | **Real** Claude, throwaway projects, one Mac, local bare origin, supervised mode, no automatic merge. |
| Second and third supervised runs: the whole five-slice wave integrated and qualified; acceptance of three waves; a killed execution retried; a supervisor kill and restart; re-plan, revision after an abandoned ticket and `product resolve`; an execution refused any other ticket | **Real** Claude Code, throwaway project, one Mac, **simulated** engineer and product managers, supervised, no automatic merge (USD 7.93 recorded plus two killed executions without cost; USD 1.93). The integrated service passed an independent `curl` journey. |
| Recorded High-risk run with two rejected rounds and two failed executions | **Real** records, **replayed**, not live. |
| Adversarial tests (activation file, injection text as data, hostile product files, host spoofing) | **Automated tests** with fakes, no model run. Three confirmed defects were fixed afterwards (`d68f83f`) and their known-failure markers removed. |
| Security scanners (gitleaks, Semgrep, OSV, Trivy, Syft) | **Real** tools, one run, on a code snapshot. |
| Release qualification and acceptance record | **Unit and integration tests**, and **real runs** on a throwaway project: `blocked` on a shared contract (corrected), `qualified_with_exceptions` after a recorded exception, then `qualified` for all five slices of three waves, byte-identical on repeat, with all three waves `accepted` after their records merged; `incomplete` when a scanner report recorded zero sources. Not run on a real release. |
| Full regression | **Real**, at an earlier commit (`1d58d02`) only: Python 728 run, Go, web and unit suites pass. Not repeated at the candidate. |
| Accessibility with a screen reader; real GitHub Enterprise; second physical machine; a clean machine; Linux by hand; planted prompt injection against a model | **Not tested.** |

## Security disclosures

Suitable for publication as they stand:

- MACH runs locally. Its services listen on `127.0.0.1` only and need a one-time link. It sends no telemetry.
- An unattended run is limited to an explicit tool list. That list includes running Python, so a successful prompt injection could run arbitrary code as the engineer. There is no sandbox. Enabling supervised mode requires a person to accept this in writing at enable time; it is an acceptance, not a mitigation. Enable supervised mode only on a machine and account you are prepared to expose.
- The installer checks a release's archive and programs against a published checksum from the same release, and verifies build provenance when the GitHub CLI is installed and signed in. A forged checksum beside a tampered file is accepted when provenance is not verified; `MACH_REQUIRE_PROVENANCE=1` refuses instead.
- `install.sh` is itself fetched from the `main` branch and is not checked: it is the remaining trust root.
- The macOS programs are not notarised.
- Personal names in free text are shown in the Factory Floor, labelled and not removed.
- MACH relies on the repository host's rules (branch protection, reviews, signed commits, single sign-on). It does not replace them. They were tested on GitHub.com with one personal account, not against a real organisation.
- Generated code is reviewed by agents. Since 0.15.0 the build station refuses a commit that looks like it holds a credential, and review answers for every secret candidate and new dependency; neither checks a dependency against a vulnerability database, and the secret shapes it knows are a limited list. Do not read a passing review as a security guarantee.
- The scans run on one snapshot found no confirmed High or Critical finding and no real secret. One Moderate advisory in lint tooling, not shipped, awaits a decision.
- Report a vulnerability through the repository's own channel for private reports. **There is no private vulnerability-reporting address yet. The product owner must supply one before publication.** Until then, do not publish this section as it stands.

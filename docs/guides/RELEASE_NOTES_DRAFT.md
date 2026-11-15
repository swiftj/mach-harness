# MACH release notes (draft) `<version>`

Status: release candidate, draft. Everything here is experimental where marked. MACH is not claimed to be ready for regulated or enterprise production use. Facts come from the code at this commit and the M7 documents in `docs/mach-next/`. Anything not shown is marked "not tested". The acceptance matrix (`docs/mach-next/M7_ACCEPTANCE_MATRIX.md`, version 3) lists every scenario with its status.

## Supported platforms

Per `.github/workflows/release.yml`, the release builds `mach-studio` and `mach-observer` for:

- macOS on Apple silicon (`darwin/arm64`)
- Linux arm64 (`linux/arm64`)
- Linux amd64 (`linux/amd64`)

Each is smoke-tested on a native runner of its kind (`macos-latest`, `ubuntu-24.04-arm`, `ubuntu-latest`) before anything is published. The workflow has run on a tag: `v0.13.0-rc.2` was published as a pre-release with six programs, six SBOMs, a source archive and `SHA256SUMS`, and every build, smoke and publish job succeeded. Its earlier attempts were never published: `rc.1` failed on a data race in the observer and a Linux file-identity defect (both fixed), and `rc.3` on a shell-syntax error in the installer on Linux (fixed). Only the `darwin/arm64` programs were run by hand from the published files; the Linux builds are verified by the release's own smoke jobs, not by hand.

**Windows and Intel Mac are not built or tested.** The v0.12.0 release still carries a `darwin-amd64` Studio file, but the installer never selects it. On those machines the Python skills and scripts and the terminal version of Product Studio can run, but the visual app and the Control Tower have no program for them. The Python scripts themselves were run only on macOS.

**The macOS programs are ad hoc signed and not notarised.** Gatekeeper rejects them. A program downloaded through a browser carries macOS's quarantine mark and is blocked on first run until you allow it in System Settings; the installer's own download carries no such mark. The installer's checksum and attestation checks are the protection there, not Gatekeeper. The browser case was not exercised.

## Installation prerequisites

Claude Code, `git`, and `python3` 3.8 or later. The GitHub CLI (`gh`) is needed to send product work and to verify build provenance. Python 3.8 is the stated minimum. Python 3.9.6 and 3.15 were run, nothing older. A missing Git or Python stops the installer with a plain message and, on a Mac, the `xcode-select --install` step.

## Supported features, by component

| Component | Status | What it does |
|---|---|---|
| Stations: ticket, audit, intent, build, verify, review, merge, cleanup, observe | Built, tested | The factory's conveyor belt. Scripts decide gates, order, commits and verdicts. |
| `run` skill and `mach:belt` workflow | Built | Names the next step per ticket; runs several tickets in parallel cells. A supervised execution works on its own ticket only. |
| Product Studio, terminal (experimental) | Built | Project, epics, slices by interview, approval, delivery waves, refresh, conflicts, send, feedback, product acceptance record. A wave's definition and the acceptance are sent as separate requests. |
| Product Studio, visual app (experimental) | Built | Same workspace in a browser on `127.0.0.1`. Product acceptance is terminal-only. |
| Product intake and scheduling (experimental) | Built | Takes merged approved waves in, plans by dependency, dispatches on an engineer's word. A revised slice is taken in after its abandoned ticket by itself; for work still in the line a person decides with `product resolve --supersede-in-work`. |
| Factory supervisor (experimental) | Built | Off until enabled per machine with a code. Observe and supervised modes. Supervised mode also needs the execution risk accepted with `--accept-execution-risk`. Stops at every human gate. Parks a run that makes no progress at once. |
| Control Tower (experimental) | Built | Read-only live view: Factory floor, Execution Timeline, Analytics. |
| Release qualification (new in M7) | Built | `run.py release`: one commit, four outcomes, a deterministic readiness file, an outcome line naming every check not assessed, scanner reports with a required format. |
| Product acceptance record (new in M7) | Built | `studio.py acceptance record`, bound to the wave as merged at a release and commit. |
| Installer provenance check (new in M7) | Built | The one-line installer installs a release, verifies its source archive and programs against `SHA256SUMS` and, with `gh`, their build attestation, before any downloaded code runs. |
| Security review rule (new in M7) | Built | A high or critical security blocker from any seat rejects the round. |
| `cell.py replan` (new in M7) | Built | Returns a planned or building cell to `spec-ready` to be planned again, on a person's instruction, keeping its history. |

## Upgrade guidance

Based on a hand-built upgrade from v0.12.0 state (`M7_DISTRIBUTION.md`), a real v0.12.0 install upgraded to `v0.13.0-rc.2` and a live project upgraded from snapshots in the live runs:

- **Kept byte-identical:** Studio drafts, the intake ledger and events, cells, the archive and run records, `runner.json`, the observer folder, `.factory/config.json` and a customised `REVIEW.md`.
- **A supervised authorization written before the execution-risk acceptance reads as disabled.** After upgrading, enable again and confirm with `--accept-execution-risk`. Observe-mode authorization is unaffected.
- **Changed:** MACH's own scripts and skills, the managed block in `.gitignore`, the manifest, and the downloaded programs. The Control Tower program is added.
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
4. **Names in free text are shown by the Control Tower**, labelled, not removed. No confidentiality claim is made.
5. **Nothing distinguishes a product manager's copy from an engineer's.** `factory enable` produces a code there. Which machine may enable is decided only by the person at it.
6. **No notarisation.** The macOS programs are ad hoc signed (see Supported platforms).
7. **The source archive is not byte-reproducible across gzip implementations.** The tar inside is identical; the published checksum is for the published file, so installs are unaffected.
8. **A repeated review round or a voided decision is not shown on the Control Tower page.** The observer serves them; the page does not word them. An abandoned cell's tile still shows its last stage (its mast and inspector say Abandoned).
9. **A supervisor hold has no reason code**, and repeated lifecycle lines are counted again. A 240,000-event history switches views slower than its budget.
10. **No vulnerability-reporting address yet** (see Security disclosures).
11. **Fixes from the third live run were not re-observed live.** They have unit tests only: the belt's hand-off validation, Product Studio's workspace repair, the scanner-report format and the outcome line, sending an acceptance alone, the Control Tower's wording for killed and abandoned runs, and the installer's candidate-version and POSIX-shell fixes.
12. **Nothing was tested on a second machine, with two GitHub accounts, with signed commits or with Enterprise single sign-on.** Rules were enforced by real GitHub.com on one personal account; an approved review under enforced rules and a signed commit were not shown.
13. **Nothing designates one runner across machines.** Two engineers' machines can both enable.
14. **No dependency, secret or static scan of generated code in the line.** The audit only checks that a secret scanner is configured. Release qualification reads scanner reports someone else produces; the real runs had no dependency manifest for osv-scanner to read.
15. **No exception record for a security blocker.** An unmarked blocker from a non-security seat can still be outvoted at Medium. Low-risk tickets have no security seat.
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
- A recorded exception for a security blocker (designed, not built; it needs the product owner's decision).
- Windows and Intel Mac builds.
- Apple notarisation.
- A rollback procedure.
- Default withholding of free text in the Control Tower.

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
- Personal names in free text are shown in the Control Tower, labelled and not removed.
- MACH relies on the repository host's rules (branch protection, reviews, signed commits, single sign-on). It does not replace them. They were tested on GitHub.com with one personal account, not against a real organisation.
- Generated code is reviewed by agents. MACH does not scan it for vulnerable dependencies or secrets. Do not read a passing review as a security guarantee.
- The scans run on one snapshot found no confirmed High or Critical finding and no real secret. One Moderate advisory in lint tooling, not shipped, awaits a decision.
- Report a vulnerability through the repository's own channel for private reports. **There is no private vulnerability-reporting address yet. The product owner must supply one before publication.** Until then, do not publish this section as it stands.

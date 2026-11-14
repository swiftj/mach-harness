# MACH release notes (draft) `<version>`

Status: release candidate, draft. Everything here is experimental where marked. MACH is not claimed to be ready for regulated or enterprise production use. Facts come from the code at this commit and the M7 documents in `docs/mach-next/`. Anything not shown is marked "not tested".

## Supported platforms

Per `.github/workflows/release.yml`, the release builds `mach-studio` and `mach-observer` for:

- macOS on Apple silicon (`darwin/arm64`)
- Linux arm64 (`linux/arm64`)
- Linux amd64 (`linux/amd64`)

Each is smoke-tested on a native runner of its kind (`macos-latest`, `ubuntu-24.04-arm`, `ubuntu-latest`) before anything is published. That workflow has **not been run on a tag** for these builds. Only `darwin/arm64` was built and run, locally.

**Windows and Intel Mac are not built or tested.** The v0.12.0 release still carries a `darwin-amd64` Studio file, but the installer never selects it. On those machines the Python skills and scripts and the terminal version of Product Studio can run, but the visual app and the Control Tower have no program for them. The Python scripts themselves were run only on macOS.

## Installation prerequisites

Claude Code, `git`, and `python3` 3.8 or later. The GitHub CLI (`gh`) is needed to send product work and to verify build provenance. Python 3.8 is the stated minimum. Python 3.9.6 and 3.15 were run, nothing older. A missing Git or Python stops the installer with a plain message and, on a Mac, the `xcode-select --install` step.

## Supported features, by component

| Component | Status | What it does |
|---|---|---|
| Stations: ticket, audit, intent, build, verify, review, merge, cleanup, observe | Built, tested | The factory's conveyor belt. Scripts decide gates, order, commits and verdicts. |
| `run` skill and `mach:belt` workflow | Built | Names the next step per ticket; runs several tickets in parallel cells. |
| Product Studio, terminal (experimental) | Built | Project, epics, slices by interview, approval, delivery waves, refresh, conflicts, send, feedback, product acceptance record. |
| Product Studio, visual app (experimental) | Built | Same workspace in a browser on `127.0.0.1`. Product acceptance is terminal-only. |
| Product intake and scheduling (experimental) | Built | Takes merged approved waves in, plans by dependency, dispatches on an engineer's word. |
| Factory supervisor (experimental) | Built | Off until enabled per machine with a code. Observe and supervised modes. Stops at every human gate. |
| Control Tower (experimental) | Built | Read-only live view: Factory floor, Execution Timeline, Analytics. |
| Release qualification (new in M7) | Built | `run.py release`: one commit, four outcomes, a deterministic readiness file. |
| Product acceptance record (new in M7) | Built | `studio.py acceptance record`, bound to a release and commit. |
| Installer provenance check (new in M7) | Built | Runs `gh attestation verify` on downloaded programs when `gh` is available. |
| Security review rule (new in M7) | Built | A high or critical security blocker from any seat rejects the round. |

## Upgrade guidance

Based on a hand-built upgrade from v0.12.0 state, run once (`M7_DISTRIBUTION.md`):

- **Kept byte-identical:** Studio drafts, the intake ledger and events, cells, the archive and run records, `runner.json` (still disabled), the observer folder, `.factory/config.json` and a customised `REVIEW.md`.
- **Changed:** MACH's own scripts and skills, the managed block in `.gitignore`, the manifest, and the downloaded programs. The Control Tower program is added.
- **A second upgrade** touched no file.
- **No migration step** was needed or found. Cross-version compatibility of an observer index could not be shown because v0.12.0 shipped no observer.
- **Rollback is not documented.** In the test, running the older installer over the newer one restored the older files and removed the observer, and the older scripts read the state without error. Running the newer installer again restored everything. Back up `.factory/` first. The installer never touches it.
- **The version must be bumped before tagging.** `.claude-plugin/plugin.json` still says 0.12.0. An install from `main` would look for a release that has no `mach-observer`. This is a release step for the product owner.
- **Not tested:** an upgrade from a real v0.12.0 install through a real tagged release, any state written by a future format change, and installs on Linux.

## Known issues (open Major items)

1. **Version not bumped** since v0.12.0 (see above).
2. **`install.sh` fetches the Python source from the tip of `main` with no checksum.** Only the programs are checked.
3. **A prompt injection that succeeds in an unattended run can run arbitrary code as the engineer** (`Bash(python3 *)` is on the tool list). No operating-system sandbox exists. Real model behaviour under injection was not tested.
4. **Names in free text are shown by the Control Tower**, labelled, not removed. No confidentiality claim is made.
5. **Nothing distinguishes a product manager's copy from an engineer's.** `factory enable` produces a code there. Which machine may enable is decided only by the person at it.
6. **Everything real was run on one Mac** with local clones and, for most steps, a local bare repository and a stand-in `gh`. No test on separate machines.
7. **GitHub's enterprise rules were not tested for real** (required reviews, signed commits, single sign-on). The test repository's plan refused them. Their refusals were simulated.
8. **No retry and no supervisor restart was seen in a live run.** Recovery is tested with stand-ins and one replayed real record.
9. **Nothing designates one runner across machines.** Two engineers' machines can both enable.
10. **No dependency, secret or static scan of generated code in the line.** The audit only checks that a secret scanner is configured. Release qualification reads scanner reports someone else produces.
11. **No exception record for a security blocker.** An unmarked blocker from a non-security seat can still be outvoted at Medium. Low-risk tickets have no security seat.
12. **No real, person-driven run of the Product Studio journey** with a real interview, a second computer and a real enterprise remote. One real interview ran through the app's interface for about USD 0.23.
13. **The `pr` merge method was never run against GitHub**, and `merge.mode: auto` and the merge queue were never run live.
14. **The Control Tower is in no published release yet.** Some figures are known gaps: cost leaves out failed executions (a recorded USD 8.06 against 8.50 spent in the real run), repeated lifecycle lines are counted again, a supervisor hold has no reason code, and a 240,000-event history switches views slower than its budget.
15. **A plan whose implementation task cannot go green stops the line.** `check-plan` accepts it, the build then refuses and a person is asked only after further executions (USD 1.55 over three in the real run). It was one of five slices in the real run; two slices integrated, and the three behind it (borrow, return, overdue report) did not.
16. **The Control Tower does not read the product acceptance record**, keeps saying acceptance is not recorded, shows a wrong product state after a revision, and does not list a repeated review folder (`round-N.k`).
17. **A killed execution is recorded as completed, with no cost and no exit code**, and a belt run that reports "stuck" counts as completed if the ticket moved at all.
18. **Fixed after the real run, with unit tests, not seen again in a live run:** a re-review after a voided approval no longer overwrites the round it repeats; release qualification accepts a shared contract changed by a later reviewed slice; the acceptance record binds to the wave as merged; sending a revised wave whose first request merged opens a new request.

Smaller open items: reconciling a conflict across a slice's two files is still one file at a time; a stale status suggestion for a wave another manager already sent; a released claim shows as `unknown` in the Control Tower; a ticket body keeps the old revision after a product revision; `.factory/release/` shows as untracked; accessibility checks with a screen reader and Safari were not done.

(corrected: this list used to include threat model T1, a `runner.json` that arrives through Git, and a deeply nested JSON value that crashed intake. Both are fixed, with an oversized product file and a ticket title that pulled in other fields, in `d68f83f`. Unit-tested, not re-observed live. `M7_THREAT_MODEL.md` now says so. The open ones there are T2, T6 and T7.)

## Explicitly deferred

- Evidence Theater (a richer evidence viewer).
- Portfolio management across projects.
- Multi-runner coordination across machines.
- An operating-system sandbox for unattended executions.
- A recorded exception for a security blocker (designed, not built; it needs the product owner's decision).
- Windows and Intel Mac builds.
- A rollback procedure.
- Default withholding of free text in the Control Tower.

## Tested scenarios

| Scenario | How it ran |
|---|---|
| Two product managers and an engineer: define, approve, send, review, merge, refresh, renumber, conflict, intake (five tickets, repeat creates none) | **Real** GitHub repository and pull requests, **simulated** as separate people: three clones on one Mac, one GitHub account. Real approvals were refused by GitHub (own pull request). |
| Network cut, push succeeded but pull request timed out, invalid sign-in | One **simulated** (dead proxy), one **simulated** (wrapper that fails once), one real invalid token. |
| Protected-branch refusal, single sign-on refusal | **Simulated** with a local hook, and **mocked** message. Messages were corrected afterwards and tested with stand-ins only. |
| One real interview turn through the Studio app | **Real** Claude Code, one slice, two turns. |
| Fresh install as a product manager with no Node or Go, checksum refusal, truncated and missing files | **Real** installer, **simulated** release (a local folder, not GitHub). |
| Provenance verification | **Simulated** (a fake `gh`). Never run against GitHub. |
| Upgrade from v0.12.0 and uninstall | **Real** installer on a hand-built state. |
| Supervised runs: intake, dependency hold, two cells at once, build, verify, review rejection with a security blocker, revise, human gate, by-person merge, cleanup, daily run limit, disable | **Real** Claude, throwaway projects, one Mac, local bare origin, supervised mode, no automatic merge. |
| Recorded High-risk run with two rejected rounds and two failed executions | **Real** records, **replayed**, not live. |
| Adversarial tests (activation file, injection text as data, hostile product files, host spoofing) | **Automated tests** with fakes, no model run. Three confirmed defects were fixed afterwards (`d68f83f`) and their known-failure markers removed. |
| Security scanners (gitleaks, Semgrep, OSV, Trivy, Syft) | **Real** tools, one run, on a code snapshot. |
| Release qualification and acceptance record | **Unit and integration tests**, and one **real run** on a throwaway project's two integrated slices: the first result was `blocked` on a shared contract (corrected afterwards, not re-observed), then `qualified_with_exceptions` after a person's recorded exception, and `qualified` for a one-slice wave. Not run on a real release. |
| One supervised run of a five-slice wave on a real GitHub repository | **Real** Claude Code, throwaway project, one Mac, simulated people, supervised, no automatic merge, USD 8.50 recorded. Two slices built, reviewed (each rejected once and revised), and integrated by a person, including a real merge conflict; the third stopped on a plan defect and the last two never started. |
| Release pipeline on a tag, per-platform smoke tests, attestations | **Not tested.** The workflow's actions are pinned by commit and Go to 1.27.3, but it has never run. |
| Accessibility with a screen reader; Real GitHub Enterprise; second physical machine | **Not tested.** |

## Security disclosures

Suitable for publication as they stand:

- MACH runs locally. Its services listen on `127.0.0.1` only and need a one-time link. It sends no telemetry.
- An unattended run is limited to an explicit tool list. That list includes running Python, so a successful prompt injection could run arbitrary code as the engineer. There is no sandbox. Enable supervised mode only on a machine and account you are prepared to expose.
- The installer checks a download against a published checksum from the same release. It verifies build provenance only when the GitHub CLI is installed and signed in. A forged checksum beside a tampered program is accepted when provenance is not verified.
- `install.sh` downloads its scripts from the `main` branch without a checksum.
- Personal names in free text are shown in the Control Tower, labelled and not removed.
- MACH relies on the repository host's rules (branch protection, reviews, signed commits, single sign-on). It does not replace them, and they were not tested against a real organisation.
- Generated code is reviewed by agents. MACH does not scan it for vulnerable dependencies or secrets. Do not read a passing review as a security guarantee.
- The scans run on one snapshot found no confirmed High or Critical finding and no real secret. One Moderate advisory in lint tooling, not shipped, awaits a decision.
- Report a vulnerability through the repository's own channel for private reports. **There is no private vulnerability-reporting address yet. The product owner must supply one before publication.** Until then, do not publish this section as it stands.

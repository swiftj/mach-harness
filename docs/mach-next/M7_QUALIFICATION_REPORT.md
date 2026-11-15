# MACH Next M7: release qualification report

This report says what was shown about MACH as a whole product, with what kind of evidence, and what was
not shown. It recommends a decision; the product owner makes it. It does not authorize a release.

**Recommendation: CONDITIONAL GO for release-candidate testing by a small group of engineers and product
managers on their own Macs, subject to the product owner's recorded acceptance of the exceptions in
section 20.** It is not a recommendation for general release, and not for any environment that needs
confidentiality of free text or enforced separation between people. Without those acceptances the decision
is INCOMPLETE, not GO.

An earlier version of this report (at `4dc67bd`) recommended INCOMPLETE. Section 20 says what changed.

Companion documents, all in `docs/mach-next/`: `M7_READINESS_INVENTORY.md`, `M7_ACCEPTANCE_MATRIX.md` (v3),
`M7_PM_ACCEPTANCE.md`, `M7_FACTORY_ACCEPTANCE.md`, `_2.md`, `_3.md`, `M7_GITHUB_RULES.md`,
`M7_RELEASE_QUALIFICATION.md`, `M7_PLAN_GATE.md`, `M7_REVIEW_GATE_AUDIT.md`, `M7_THREAT_MODEL.md`,
`M7_SECURITY_SCANS.md`, `M7_DISTRIBUTION.md`, `M7_RELEASE_CANDIDATE.md`; guides in `docs/guides/`.

## 1. Baseline and commits

- M6.6 baseline: `106f4d3` on `main`, verified by commit ancestry (`51b49e5` is an ancestor) and by a full
  regression on `106f4d3` before any change.
- M7 branch: `feature/mach-next-m7-release-qualification`, in its own worktree. `main` was not touched.
- Candidate: `v0.13.0-rc.4` at `21cf88a`. The branch carries documentation commits after it.

Grouped by purpose (`git log 106f4d3..HEAD` has every commit):

| Commits | What |
|---|---|
| `fb6226c`, `4163f45`, `13da6df`, `ab2e70a`, `79fd92d`, `42765f2`, `ef921b9`, `00efd00` | Inventory, matrix, audit; scan, distribution, PM, GitHub-rule and three Factory acceptance reports |
| `f6097ee`, `d68f83f`, `62ad896` | Security: the review gate, the authorization file, the execution-risk acceptance |
| `c73c11e`, `1d58d02`, `34a721e`, `1e0a635` | Release qualification and product acceptance, and their corrections |
| `c35788a`, `072b56b`, `5c72d2f`, `e3ac0e8`, `14ba169` | Installer: attestation, verified source, diagnostics, candidate versions |
| `7e23f84`, `b73c025`, `9b8ad80` | Factory: the plan gate, non-progressing builds, re-plan, execution scope, revised slices, the belt hand-off |
| `b0d3e88`, `24ed432`, `96971bd` | Product Studio: refusal messages, blocked requests, revised waves and slices |
| `0fcbb1b` | Review records are never overwritten |
| `3a4bb22`, `ff1758a`, `1243a95`, `acc950f` | Factory Floor and observer |
| `b4bfa2d`, `f76d7a8`, `67842ad` | Threat model, adversarial tests, guides, matrix v3 |

## 2. Implementation summary

M7 added one capability and corrected defects that qualification exposed. It rebuilt nothing.

- **Release qualification** (`run.py release status|qualify|show|except`): a deterministic readiness snapshot
  for one exact commit of the integration branch, from existing records. A missing check is never a pass; a
  scanner report counts only if it can be checked. Outcomes: qualified, qualified with exceptions, blocked,
  incomplete.
- **Product acceptance**: a tracked record in Product Studio, published on its own, bound to the wave as
  merged at the release commit, never inferred.
- **Corrections**: three Blockers and the Majors listed in sections 7 and 17, found by audit, by three live
  Factory runs, by tests against GitHub and by the release pipeline itself.

## 3. Cross-component architecture changes

None to the architecture. Additions: `.factory/release/<id>/`; `product/acceptance/WAVE-*.json`; a `class`
and `impact` on a review finding; `review/round-N.k/`; `plan-history/` in a cell; `exit_code` and
`not_progressing` on execution events; an acceptance record in the machine-local authorization. No new CLI,
station, agent, service or hosted component. Local-first, loopback-only and disabled-by-default are
unchanged.

## 4. Product Manager to engineer acceptance

**Kind: local simulation with real GitHub.** Two PMs and an engineer were independent clones with separate
home folders and Git identities on one Mac, sharing one GitHub account. Not a test on separate machines.

Shown: a project, two epics and five slices (later six) defined through the terminal engine; drafts saved
and resumed; approval; waves sent as real pull requests; an engineer's comment read back; revised waves;
slice-number collisions renumbered; a conflicting business rule changed only by explicit choice; drafts
kept through every refresh; one real Claude-assisted interview through the visual host; the same operations
through the visual host's API; the terminal-versus-app equivalence suite; intake creating each ticket once;
product acceptance recorded and merged for three waves.

Against real GitHub rules (`M7_GITHUB_RULES.md`, GitHub.com, a personal account): a required pull request, a
required review, code owners, a required check, signed commits and blocked force pushes were all accepted
and enforced; `send` worked under them; a direct push to `main` was refused; a refusal by a repository rule
reached the PM with GitHub's own reason and no "try again".

Not shown: an approving review under enforcement (one account cannot approve its own request); a signed
commit (the token lacks the scope to register a signing key); single sign-on and a GitHub Enterprise
organisation; the visual app's pages (its API was driven); a machine with no developer tools installed.

## 5. Factory execution

**Kind: controlled live Factory execution**, three runs in one throwaway project.

| Run | Executions | Recorded cost | What it showed |
|---|---|---|---|
| 1 | 9 | USD 8.50 | Activation, two cells at once, rejection and revision in review, a merge conflict, recovery from a killed supervisor and a killed execution; two of five slices integrated |
| 2 | 7 + 2 killed | USD 7.93 (at most 13.93) | The remaining three slices; the whole wave integrated, qualified and accepted; nine of ten fixes observed |
| 3 | 3 | USD 1.93 | Four fixes confirmed; a sixth slice built and merged |

Shown across them: observe mode starts no agent; tracked settings cannot raise a local limit, and removing
the security seat stops unattended work; the execution-risk statement and its acceptance; test-first
evidence; verification; three-seat reviews with real rejections, revisions and approvals; a re-review after
a voided approval kept in its own folder; human approval and by-person merge; a plan the new check refuses;
a non-progressing station parked at once; a re-plan that keeps history; a supervised execution confined to
its ticket; a revised slice re-entering the line by itself, and by a recorded command when work was in
progress.

Deviations, all recorded in the run reports: run 1 raised the risk ceiling from Medium to High because every
slice planned as High; **run 2 finished only after a person edited the intake ledger by hand** (the defect
is fixed and was confirmed in run 3); in run 2 the engineer added one line of code while resolving a merge
conflict, so the integrated product contains a line the Factory did not write; run 3 wrote one plan by hand
to set up the re-plan check.

Supported model: one Factory runner per project, per machine. Nothing coordinates two engineers' machines.

## 6. Cross-slice integration and release qualification

At the integrated commit of the whole wave: `qualified` for all three waves, byte-identical on repeat, with
the project's test suite and its declared integration test passing and product acceptance read as accepted
only after its record merged. An independent `curl` journey passed every step: add, list, borrow, the
shared loan limit refusing a fourth loan, return, borrow again, the overdue report, and the response-time
requirement.

Limits: `performance` was not configured, and the dependency scan had nothing to scan (the product has no
package manifest). Run 3 showed that a scan report without its exit code and source count had been read as
a pass; the rule is now strict and unit-tested, and has not been re-observed live. A cross-slice defect (a
returned item breaking the overdue report) was predicted by a reviewer as a non-blocking note, caught by no
test, and reached a person only because the two slices also conflicted textually. **Slice-level
verification does not establish that the integrated capability works**; the release-level check relies on
the integration command a project declares.

## 7. Threat model and findings

| Finding | Severity | State |
|---|---|---|
| A security blocker from a non-security seat could be outvoted | Blocker | Fixed (`f6097ee`); gate tested on copies of real review rounds |
| An authorization file arriving through Git was accepted as a local grant | Blocker | Fixed (`d68f83f`); observed on a copy in run 2 |
| A revised slice could not re-enter the line once its ticket had been dispatched (a hand edit of state was needed) | Blocker | Fixed (`b73c025`); confirmed live in run 3 |
| A supervised execution started work on another ticket | Major | Fixed (`b73c025`); confirmed live |
| Tracked settings could remove the security seat or the High-risk approval unnoticed | Major | Fixed for unattended work; interactive runs still honour the setting |
| A re-review overwrote a decided round, including a person's approval | Major | Fixed (`0fcbb1b`); observed live |
| An unattended execution may run `python3` with the engineer's home folder and network | Major | Open by decision: stated and accepted explicitly at `factory enable`; a sandbox is the next milestone's first requirement |
| The installer trusted an unchecked source and a checksum beside the binary | Major | Fixed (`c35788a`, `072b56b`); `install.sh` itself remains the trust root |
| R1: a person's name in free text is shown, labelled and contained | Major | Open by decision; no confidentiality claim |

Not assessed: how the model behaves under a real injection attempt. The adversarial tests cover the scripts.

## 8. Scanner results and coverage

Run once on `fb6226c`: Gitleaks (19 hits, all deliberate fakes in tests), Semgrep (14, none confirmed),
OSV-Scanner (one Moderate advisory in a lint-only dependency), Trivy (nothing), Syft (SBOMs). No confirmed
High or Critical finding, no real secret. Not rerun on the candidate. MACH's own audit still checks only
that a secret scanner is configured.

## 9. Grim Prompter

Evaluated from its repository page only: an MIT-licensed, prompt-only skill with no releases. Not adopted,
not installed, not run.

## 10. Distribution and platforms

`v0.13.0-rc.4` is published as a pre-release: `mach-studio` and `mach-observer` for macOS Apple Silicon,
Linux AMD64 and Linux ARM64, an SBOM beside each, a source archive and `SHA256SUMS`. The release workflow's
smoke jobs passed on all three platforms. Windows and Intel Mac are not built and not claimed.

Verified on this Mac against real GitHub, with the candidate's own unmodified installer taken from its
verified source archive (`M7_RELEASE_CANDIDATE.md`, section "rc.4"):

| Check | Result |
|---|---|
| `SHA256SUMS` | 7 of 7 files verify |
| Build attestations | all 8 verify (six programs, the source archive, the checksum file), naming `release.yml` at `refs/tags/v0.13.0-rc.4`, commit `21cf88a`; a copy with one byte flipped fails (shown on rc.2) |
| A pinned install of the candidate | installs; the notes say what was checked; the manifest records it; both programs report `0.13.0-rc.4`; the Factory is disabled |
| Provenance required, no GitHub CLI | refused; nothing installed |
| Default install, no version given | resolves `v0.12.0`, the latest full release, and says its source could not be verified |
| Upgrade from `v0.12.0` to the candidate | programs replaced, a draft kept, a second run changes only a timestamp |
| Both programs with no Node or Go on `PATH` | start on `127.0.0.1`, answer, and stop cleanly |

The pipeline found defects no local run had: `rc.1` and `rc.3` were tagged and never published (a data race
in the observer and a Linux file-identity defect; a shell-syntax error on Linux), and `rc.2` was published
with an installer that refused its own version. All are fixed. Not verified: Linux by hand; notarisation
(the macOS programs are ad hoc signed, so a copy downloaded in a browser is blocked at first launch, while
the installer's download runs); the source archive is not byte-reproducible across gzip implementations.

**Until this branch is merged, the README's one-line install serves the old installer from `main`**, with
none of the verification described here.

## 11. Installation, upgrade and rollback

A fresh install with no Node or Go on `PATH` gave a working Product Studio, a disabled Factory and a Factory
Floor that observes without enabling anything. Tampered, truncated and missing assets are refused or
skipped. An upgrade from `v0.12.0` kept drafts, the intake ledger, a cell, the archive, the disabled
authorization, edited settings and a customised `REVIEW.md`; the live runs upgraded a project holding real
state three times. One upgrade effect is deliberate: a machine enabled for supervised mode before M7 reads
as disabled until an engineer accepts the execution risk. Rollback has no documented path; reinstalling the
old version works and re-running the new installer recovers. Python 3.8 is the stated minimum and was not
run (3.9.6 and 3.15 were).

## 12. Failure injection and recovery

Live: supervisor killed and restarted; an execution killed; a wave received twice; product revisions during
construction; rejected reviews followed by revision; a pending human approval; a merge conflict; a plan that
could not build; a non-progressing station; an abandoned ticket. Real GitHub: an invalid token, a refused
push, a refusal by a repository rule. Simulated: network loss during publication, a pull-request creation
that fails after the push. From the release pipeline: a corrupted download, an unavailable asset. From
M6.6: a Factory Floor disconnect and gaps in the event stream. Not exercised: an interrupted intake outside
unit tests, a station writing incomplete evidence, the emergency stop.

No scenario dispatched work without authorization or altered a verification result. Two lost or stranded
state before their fixes: a re-review overwriting a round, and two PM workspaces left unusable by a
reconcile defect; both are fixed, the first observed live, the second by unit tests on copies of the stuck
workspaces.

## 13. Factory Floor accuracy

Against the live runs: station times matched the lifecycle logs to the millisecond; per-run cost and tokens
matched the execution records; blocked and waiting-on-a-person were distinct; nothing later was revealed
when held at an earlier moment; the readiness snapshot's outcome and product acceptance were shown and
never inferred. Open, all Minor: recorded cost leaves out failed executions by the metric's definition; a
repeated review or voided decision is in the observer's data but not on the page; an abandoned cell's tile
shows its last stage. The page-side fixes for killed and abandoned work were not seen in a browser.

## 14. Accessibility and usability

No new accessibility testing in M7; the M6.6 baseline stands and no conformance is claimed. No person other
than the agents used the product, so persona usability rests on scripted journeys. The PM journey needs no
Git command.

## 15. Automated tests

Run by the lead in one pass on `67842ad`, which is the candidate's code (`21cf88a`) plus documentation
and one corrected sentence in a skill:

| Suite | Result |
|---|---|
| Observer: `go vet`, `go test -race` | pass, 16 packages |
| Studio host: `go vet`, `go test -race` | pass, 5 packages |
| Web lint, typecheck, build | pass |
| Factory Floor unit tests | 700 of 700 |
| Product Studio web unit tests | 7 of 7 |
| Python (`make test`) | 782 run, pass, 1 skipped (631 at the baseline; 151 added in M7) |
| Release workflow on GitHub, tag `v0.13.0-rc.4` | build, three smoke jobs (macOS Apple Silicon, Linux AMD64, Linux ARM64) and publish all pass |

The race detector was not used on the Go suites locally before the release workflow exposed a race; it is
used in this run and in the workflow. Not run in M7: the Factory Floor and Product Studio browser suites
(the M6.6 results stand; the M7 changes to the Factory Floor have unit tests only), and the scanners on the
candidate.

## 16. Manual and real-machine acceptance

None was performed. Every result came from one Mac. A checklist for repeating the PM steps on a second
MacBook is in the session's scratch folder (`m7/agents/pm/SECOND_MACHINE_CHECKLIST.md`) and must be copied
somewhere durable before use.

Acceptance matrix v3 (65 rows): 34 pass, 18 partial, 2 fail, 6 not run, 5 not possible here. The two fails
are recorded cost excluding failed executions and names in free text. Of the 17 live-Factory rows, 8 pass,
5 are partial and 4 were not run: a fix with unit tests that was not seen live afterwards is not counted as
a pass there.

## 17. Outstanding issues

| Issue | Severity |
|---|---|
| Unattended executions are not sandboxed by the operating system | Major, accepted explicitly at enable |
| R1: names in free text | Major, open by decision |
| Fixes made after the third live run are unit-tested and not observed live: the belt hand-off, the two Product Studio workspace defects, the strict scanner-report rule | Major |
| Nothing tested on a second machine, with two GitHub accounts, signed commits, or Enterprise single sign-on | Major |
| Slice-level verification missed a cross-slice defect; release qualification depends on the project declaring an integration command | Major |
| The macOS programs are not notarised | Major for distribution outside the installer |
| `install.sh` itself is fetched unchecked, and from `main` until the branch is merged | Major until merged, then a stated trust root |
| Interactive runs still honour a setting that removes the security seat | Minor |
| Recorded cost excludes failed executions; killed executions record no cost | Minor, product owner's decision |
| Factory Floor items in section 13; no private vulnerability-reporting address; three leftover candidate tags and one superseded pre-release | Minor |

No Blocker is open. No Major is waived by this report.

## 18. Deferred

The Evidence Theater; portfolio management; coordination between several runners; an operating-system
sandbox for executions; a recorded exception for a security blocker; Windows and Intel Mac; notarisation; a
visual acceptance screen in Product Studio.

## 19. Release-candidate artifacts

`v0.13.0-rc.4` on `swiftj/mach-harness`, a pre-release, commit `21cf88a`: 14 assets. Sums and attestation
facts are in `M7_RELEASE_CANDIDATE.md`. `v0.12.0` remains the latest full release. Also present and not
removed: tags `v0.13.0-rc.1` and `v0.13.0-rc.3` with no release, and the pre-release `v0.13.0-rc.2`, whose
installer cannot install it.

## 20. Recommendation

**CONDITIONAL GO, for release-candidate testing only.**

What changed since INCOMPLETE: the full lifecycle was shown for the whole capability, not two slices;
enforced repository rules were tested against real GitHub; a release was built, published and verified.
Three Blockers were found and fixed, the third confirmed live.

It is conditional because these remain, and only the product owner can accept them:

1. **No operating-system sandbox** around unattended executions. Accepted per machine at enable; acceptable
   only where the product input is trusted.
2. **R1.** Not for any use that needs free text kept confidential.
3. **Fixes not observed live** (section 17). Acceptable for a candidate whose purpose is to be tested.
4. **One machine, one GitHub account.** The first testers are, in effect, the multi-machine test.
5. **Not notarised.** Install through the installer, not by downloading the programs in a browser.

Before the candidate is offered to anyone: merge this branch, so the one-line install serves the verified
installer; and supply a private address for vulnerability reports. Before a general release: a sandbox, a
second-machine and two-account pass, notarisation, and a live run that re-observes the remaining fixes.

If the product owner does not accept the five items, the decision is INCOMPLETE. This report does not
authorize a release.

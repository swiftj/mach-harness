# MACH Next M7: release qualification report

This report says what was shown about MACH as a whole product, with what kind of evidence, and what was
not shown. It recommends a decision; the product owner makes it.

**Recommendation: INCOMPLETE.** No Blocker is open. Two were found and fixed. But required evidence is
missing: the real end-to-end run integrated two of five slices, nothing ran on a second machine or against
enforced GitHub rules, and no release has been built from this code. Section 20 gives the reasoning and what
would change the recommendation.

Companion documents, all in `docs/mach-next/`: `M7_READINESS_INVENTORY.md`, `M7_ACCEPTANCE_MATRIX.md`,
`M7_PM_ACCEPTANCE.md`, `M7_FACTORY_ACCEPTANCE.md`, `M7_RELEASE_QUALIFICATION.md`, `M7_REVIEW_GATE_AUDIT.md`,
`M7_THREAT_MODEL.md`, `M7_SECURITY_SCANS.md`, `M7_DISTRIBUTION.md`; guides in `docs/guides/`.

## 1. Baseline and commits

- M6.6 baseline: `106f4d3` on `main` (the M6.6 merge; its branch tip `51b49e5` is an ancestor). Verified by
  commit ancestry and by a full regression run on `106f4d3` before any change: observer and Studio host Go
  tests, web lint, typecheck and build, 692 Control Tower and 7 Product Studio unit tests, 631 Python tests.
- M7 branch: `feature/mach-next-m7-release-qualification`, in its own worktree. `main` was not touched.
- Candidate commit: the commit that carries this report, one documentation-and-test commit after `1d58d02`. Version in `plugin.json`: 0.12.0, not bumped (a release step).

| Commit | What |
|---|---|
| `fb6226c` | Readiness inventory, acceptance matrix v1, review-gate audit |
| `4163f45`, `13da6df`, `ab2e70a`, `79fd92d` | Scanner, distribution, PM acceptance and Factory acceptance reports |
| `f6097ee` | Review gate: a security blocker from any seat cannot be outvoted |
| `c35788a` | Installer: attestation check, plain diagnostics, `--version`, pinned workflow, SBOM |
| `c73c11e` | Release qualification and product acceptance |
| `b0d3e88` | Product Studio: a refused publication says why |
| `b4bfa2d` | Threat model and adversarial tests |
| `d68f83f` | Authorization file from Git refused; malformed product files refused |
| `f76d7a8` | Guides and release notes draft |
| `0fcbb1b`, `1d58d02` | Fixes from the real run: review records, revised waves, shared contracts, acceptance |

## 2. Implementation summary

M7 added one capability and corrected defects; it rebuilt nothing.

- **Release qualification** (`run.py release status|qualify|show|except`): a deterministic readiness snapshot
  for one exact commit of the integration branch, built from existing records. A missing check is never a
  pass. Outcomes: qualified, qualified with exceptions, blocked, incomplete.
- **Product acceptance**: a tracked record in Product Studio (`studio.py acceptance record|show`), published
  like any product file, bound to the wave as merged at the release commit, never inferred.
- **Security corrections**: the review gate, the supervisor's preflight, the authorization file, the installer.
- **Product Studio corrections**: publication failure messages, revised waves, malformed files.

## 3. Cross-component architecture changes

None to the architecture. Additions: `.factory/release/<id>/` (readiness snapshot, exceptions, run log);
`product/acceptance/WAVE-*.json`; a `class` and `impact` on a review finding; `review/round-N.k/` for a
re-review after a voided approval. No new CLI, station, agent, service or hosted component. Local-first,
loopback-only and Factory-disabled-by-default are unchanged.

## 4. Product Manager to engineer acceptance

**Kind: local simulation with real GitHub.** Two PMs and an engineer were independent clones with separate
home folders and Git identities on one Mac, all using one GitHub account, against a private repository.
This is not a test on separate machines.

Shown: project, two epics and five slices defined through the terminal engine; a draft saved and resumed;
approval; a wave sent as a real pull request; an engineer's comment read back through `feedback`; a revised
wave sent to the same pull request with no duplicate; slice-number collisions detected and renumbered; a
conflicting loan limit reported and changed only by explicit choice; unpublished drafts kept through every
refresh; one real Claude-assisted interview through the visual host; the same operations through the visual
host's API; the existing terminal-versus-app equivalence suite passing; intake creating five tickets once.

Not shown: any enforced branch rule (GitHub refused every protection rule on a private repository on the
account's plan); an approving review (one account cannot approve its own pull request); single sign-on
(mocked); the visual app's screens (its API was driven, not its pages); a PM on a machine with no developer
tools at all (tools were removed from `PATH`, not from the machine).

## 5. Factory execution

**Kind: controlled live Factory execution**, USD 8.50 over nine executions, in the engineer clone.

Shown: observe mode starts no agent; a tracked `max_parallel` of 5 leaves the local limit at 2; removing the
security seat in tracked settings makes the supervisor refuse unattended work; two cells at once; the belt
workflow; test-first evidence; verification; three-seat reviews; **each integrated ticket rejected in round
one, revised and approved in round two**; a real merge conflict resolved in the cell and then re-verified
and re-reviewed; human approval and by-person merge; cleanup and run records; a killed supervisor finding
its executions on restart and dispatching nothing twice; a killed execution not blindly repeated; a wave
delivered twice creating nothing twice; a product revision arriving mid-build changing only the waiting
ticket.

Not shown: three of five slices were never integrated. One slice's plan had a task that could not pass its
test gate; the plan check accepted it, three executions were spent, and it was parked for a person, which
left its two dependants unstarted. Deviation: the run raised the supervisor's maximum risk from Medium to
High part-way, because every slice was planned as High; High-risk tickets still needed a unanimous panel
and a person.

Supported model, stated plainly: one Factory runner per project, per machine. Nothing coordinates two
engineers' machines, and no claim is made for it.

## 6. Cross-slice integration and release qualification

On the real run's integrated result: two qualify runs at the same commit were byte-identical; with no
integration command and no scanner report the outcome was not a pass; product acceptance read "not
recorded" while its pull request was open and "accepted" after the merge. The first real use also found
that a contract file shared by two slices blocked the release; that rule is corrected and unit-tested, and
**has not been run again on a live result**. The integrated product was checked independently with `curl`:
adding and borrowing work, the shared loan limit refuses a fourth loan, p95 0.5 ms over 200 requests against
1,004 items. Returning an item and the overdue report do not exist, because their slices were not built.

## 7. Threat model and findings

Two models are written: MACH itself, and the software it generates (`M7_THREAT_MODEL.md`).

| Finding | Severity | State |
|---|---|---|
| A security blocker from a non-security seat could be outvoted | Blocker | Fixed (`f6097ee`) |
| An authorization file arriving through Git was accepted as a local grant | Blocker | Fixed (`d68f83f`) |
| Tracked settings could remove the security seat or the High-risk human approval unnoticed | Major | Fixed for unattended work (`f6097ee`) |
| An unattended execution may run `python3` with the engineer's home folder and network, so a successful prompt injection could act outside the repository | Major | Open: a design property; needs an operating-system sandbox |
| The installer trusted a checksum served beside the binary | Major | Reduced: attestation checked when the GitHub CLI is present (`c35788a`); the Python source is still fetched from `main` unchecked |
| R1: a person's name in free text is shown, labelled and contained | Major | Open by decision; no confidentiality claim is made |
| Malformed product files crashed intake; a ticket title could pull in other fields | Minor | Fixed (`d68f83f`) |

Not assessed: how the model behaves under a real injection attempt. The adversarial tests cover the scripts.

## 8. Scanner results and coverage

Run once on `fb6226c`: Gitleaks (19 hits, all deliberate fakes in redaction tests), Semgrep (14 findings,
none confirmed), OSV-Scanner (one Moderate advisory in a lint-only dependency), Trivy (nothing), Syft (SBOMs
for the source and the observer binary). No confirmed High or Critical finding and no real secret. Coverage
gaps: the scans predate the later M7 commits; the release workflow was not linted; MACH's own audit checks
that a secret scanner is configured and never runs one. The release-qualification security check reads
scanner reports and is incomplete without them.

## 9. Grim Prompter

Evaluated from its repository page only: an MIT-licensed, prompt-only skill with no releases. Not adopted:
it adds a prompt, not a tool, over a written threat model. It was not installed or run.

## 10. Distribution and platforms

The release workflow builds macOS Apple Silicon, Linux ARM64 and Linux AMD64. Windows and Intel Mac are not
built and not claimed. **No release has been built from this code**: the newest release, `v0.12.0`, carries
no observer. Read from the workflow and not run: per-platform builds, smoke tests, attestations, the SBOM
step. Only macOS Apple Silicon was exercised, from local builds.

## 11. Installation, upgrade and rollback

**Kind: integration, local stand-in for a release.** A fresh install with no Node or Go on `PATH` gave a
working Product Studio (terminal and visual host), a disabled Factory and a Control Tower that observes
without enabling anything. A flipped byte, a truncated file and a missing asset are refused or skipped. An
upgrade from the `v0.12.0` layout kept drafts, the intake ledger, a cell, the archive, the disabled
authorization, edited settings and a customised `REVIEW.md` byte-identical, and a second upgrade changed
nothing. The real run also upgraded a project holding intake state. Rollback has no documented path;
reinstalling the old version works, and re-running the new installer recovers. Not verified: a real
attestation check, the download from GitHub, Python 3.8 (3.9.6 and 3.15 were run).

## 12. Failure injection and recovery

Shown in a live run: supervisor crash and restart; a killed execution; a wave received twice; a product
revision during construction; a rejected verification or review followed by revision; a pending human
approval; a merge conflict. Shown in simulation: network loss during publication; a push that succeeds
before pull-request creation fails (the retry was against real GitHub); an invalid token; a refused push.
From M6.6: a Control Tower disconnect, gaps in the event stream, a corrupted download, an unavailable
release asset. Not exercised: an interrupted intake, a station writing incomplete evidence, a local
application failing to start (beyond the observer's diagnostics). In no case was work dispatched without
authorization, a PM's draft lost, or a verification result altered. One defect did lose records: a
re-review overwrote the earlier round's votes and a person's approval; fixed in `0fcbb1b`.

## 13. Control Tower accuracy

Against the real run: station times matched the lifecycle log to the millisecond; per-run cost and tokens
matched the execution records; blocked and waiting-on-a-person were distinct; nothing later was revealed
when held at an earlier moment. Open, all Minor: product state lags after a revision; recorded cost leaves
out failed executions (USD 8.06 against 8.50) by the metric's definition; a released claim shows as
unknown; the Control Tower does not read the new acceptance record and says "not recorded"; the observer
does not list a repeated review folder.

## 14. Accessibility and usability

No new accessibility testing in M7. The M6.6 baseline stands: scripted checks pass after fixes, no
screen-reader session was run, and no conformance is claimed. Persona usability was assessed only through
the scripted journeys; no person other than the agents used the product. The PM journey needs no Git
command; one message that told a PM to type a command was reworded.

## 15. Automated tests

Run by the lead on `1d58d02`, the last code commit, in one pass:

| Suite | Result |
|---|---|
| Observer: `go vet`, `go test` | pass, 16 packages |
| Studio host: `go vet`, `go test` | 4 of 5 packages passed; the fifth failed on a boundary guard tripped by a new M7 test file's wording. The test file was reworded (the guard untouched) and all 5 pass in the commit that carries this report |
| Web lint, typecheck, build | pass |
| Control Tower unit tests | 692 of 692 |
| Product Studio web unit tests | 7 of 7 |
| Python (`make test`) | 728 run, pass, 1 skipped (631 at the baseline; 97 added in M7) |

Not run in M7: the Control Tower and Product Studio browser suites (no M7 change touches the web apps; the
M6.6 results stand for the Control Tower), and the scanners on the final commit.

## 16. Manual and real-machine acceptance

None was performed. Every result in this report came from one Mac. A 20-minute checklist for repeating the
PM steps on a second MacBook is in the session's scratch folder (`m7/agents/pm/SECOND_MACHINE_CHECKLIST.md`)
and should be copied somewhere durable before use. The matrix marks the rows that need a second machine, an
organisation with enforced rules, or a tagged release.

Acceptance matrix, version 2 (65 rows): 32 pass, 14 partial, 2 fail, 8 not run, 9 not possible here.
The two failing rows are both known and stated above: recorded cost leaving out failed executions, and
names in free text being served. All six real multi-machine rows are "not possible here". Of the 17
controlled live Factory rows, 8 pass, 5 are partial and 4 were not run, because three slices were never
built. "Pass" on a row that rests on a test means that test passed in a run by its author or in the
regression below.

## 17. Outstanding issues

| Issue | Severity |
|---|---|
| The end-to-end product delivery is incomplete: two of five slices integrated | Major |
| A plan with a task that cannot pass its gate is accepted by the plan check and spends executions before parking | Major |
| No release built from this code; version not bumped; observer absent from the newest release | Major |
| Nothing tested on a second machine, with enforced branch rules, or with separate GitHub accounts | Major |
| Unattended executions are not sandboxed by the operating system | Major |
| R1: names in free text | Major |
| The four fixes from the real run (`0fcbb1b`, `1d58d02`) are unit-tested and not re-observed live | Major |
| The installer fetches MACH's Python source from `main` unchecked | Major |
| A killed execution is recorded as completed with no exit code; a "stuck" belt run counts as completed if the ticket moved | Minor |
| Control Tower items in section 13 | Minor |
| No private vulnerability-reporting address | Minor |
| Nothing distinguishes a PM's clone from an engineer's: `factory enable` works in either, behind the same explicit confirmation | Minor, by design |

No Blocker or Major is waived by this report.

## 18. Deferred

The Evidence Theater; portfolio management; coordination between several runners; an operating-system
sandbox for executions; a recorded exception for a security blocker (designed in the audit, not built);
Windows and Intel Mac; a visual acceptance screen in Product Studio.

## 19. Release-candidate artifacts

None were produced. No tag, release or binary was published. Local builds used in testing are in the
session's scratch folder and are not release artifacts. SBOMs from the scan are in scratch as well.

## 20. Recommendation

**INCOMPLETE.** By the report's own policy: GO needs every mandatory gate satisfied; CONDITIONAL GO needs
exceptions the product owner has approved; NO-GO means a blocking issue remains. No Blocker remains, so this
is not NO-GO. But the evidence the milestone requires is not all there:

1. The complete lifecycle was shown for two slices, not for the whole capability.
2. No test ran on a second machine or against enforced repository rules.
3. No release exists to verify builds, attestations or the installer's download.

What would move this to CONDITIONAL GO for release-candidate testing by a small group on their own Macs:
finish the lending-desk wave after repairing the stuck plan (and so re-observe the four fixes live); tag a
release candidate and check its artifacts; run the second-machine checklist; and the product owner's
recorded acceptance of the open Majors that are design properties (no sandbox, R1).

This report does not authorize a release.

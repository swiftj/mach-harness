# MACH Next M7: release qualification and product acceptance

Status: **built**, on `feature/mach-next-m7-release-qualification`. Closes `M7_READINESS_INVENTORY.md` gaps 2 (no release-level qualification or readiness record) and 3 (no product-acceptance record), minimally.

Every slice is verified and reviewed in its own cell. Until now nothing said whether the slices of a delivery wave work together once integrated, nothing recorded a release-readiness decision, and nothing recorded product's decision on the result. M7 adds one script that measures and decides, one product artifact, and no new station, agent, command-line tool, service or execution authority.

## What it reuses and what it adds

| Need | Reused, never reimplemented | Added |
|------|-----------------------------|-------|
| Product definitions at a commit | intake's `Factory.snapshot` (Git objects only) and `Factory.verify` (Product Studio's structural validator, the intent gates) | |
| Is a slice integrated? | intake's `Factory.work`: its commit is an ancestor of the release commit, checked in Git | the evidence string (`git merge-base --is-ancestor <landed> <release>`) |
| Ticket of a slice revision | the intake ledger (entry and history, matched by the slice digest) | |
| Verification and review verdicts | the cleanup station's run record (v2 `integration`) and archive (`evidence/summary.json`, `review/decision.json`); never an agent's prose | |
| Scenario evidence | the verifier's `checks[AC-NN]` and `evidence_files` hashes, rechecked against the archived files | |
| Test suite | the audit station's `Repo`, `detect_commands` and `execute`, on a clean tree from `git archive <commit>` | |
| Readiness record | | `skills/run/scripts/qualify.py`, reached as `run.py release status\|qualify\|show\|except` |
| Product decision | Product Studio's draft workspace, validator and `send` | `studio.py acceptance record\|show`, `product/acceptance/WAVE-NNN.json` |

## The readiness snapshot

`run.py release qualify <WAVE-ID>... [--release <id>] [--commit <sha>]` evaluates the integration branch at one commit (default: its local head; `--commit` must be on it) and writes `.factory/release/<release-id>/readiness.json`, schema `schemas/release-readiness.v1.schema.json`. Keys are sorted and nothing in it depends on the clock, so identical inputs give identical bytes. The run's time, durations and the commands' output go to `run.json` and `logs/` beside it. A release ID names one commit: reusing it for another commit is refused. `.factory/release/` is deliberately not in the installer's git-ignored block: a readiness snapshot is evidence a team may choose to commit, so it shows as untracked in `git status` until they commit or ignore it.

It records: release and product identity; each wave's revision and SHA-256; for each slice its revision, spec path and SHA, digest, ticket, integration (status, commit, how it was established), verification verdict and review decision (with the archive path they were read from), contracts; every `AC-NN` of every in-scope spec with its evidence or `missing`; the test suite rerun at that commit; integration tests (`release.integration_command`) and performance (`release.performance_command`) if declared; security (open review blockers, scanner reports in `.factory/release/scans/*.json` as `{tool, commit, findings[{id, severity, title}], exit_code?, scanned?, error?}`, only for this commit; a report that records an error, an exit code other than 0 or 1, or zero scanned sources is `not_run`, never a pass); every check with id, status and detail; exceptions applied and not applied; human approvals found in the records (wave approvals, review sign-offs); product acceptance; the outcome.

Checks, each `pass`, `fail`, `missing`, `not_run` or `not_configured`: `product.definitions`, `product.<WAVE>`, and per slice `ticket`, `current` (no newer approved revision on the branch that this release lacks, not withdrawn), `integrated`, `verification` (PASS, for the commit review approved), `review` (APPROVED, with the person's approval when it was required), `scenario.<SLICE>.<AC>`, `contract.<SLICE>.<path>` (see the contract rule below), `dependency.<SLICE>.<DEP>` (integrated at this commit), `blocker.<SLICE>.r<N>.<i>` (an outvoted blocker in the approving round); then `suite`, `integration_tests`, `performance` (optional), `security.scan` or `security.scan.<tool>` (critical or high findings fail).

### The contract rule

Slices may share a contract, and a later slice may change it through its own review. For each contract file named by an in-scope slice's plan: a slice *changed* it if the version its review approved differs from the file at its base (where its branch meets the integration branch just before it landed). The integrated file must equal the version approved by the **latest integrated in-scope review that changed it** (ordered by Git ancestry of the landed commits). Then that slice's check passes, and every earlier slice whose approved version differs passes as "superseded by <slice>'s reviewed change" (`superseded_by` in its contract entry). If no in-scope slice changed it, each slice passes when the file is unchanged since its review. Otherwise: if the file is what a reviewed change by an integrated slice **outside** the release made it, the check is `missing` (incomplete), naming that slice, because the release would ship a contract not reviewed within it; if it matches no reviewed version, it was changed outside review and **fails**. A file absent at the release fails; a review record that cannot be read is `missing`, never a pass.

## Decision rules

1. A failing check, or an open blocker, with no exception: **blocked**.
2. Otherwise a required check that is `missing`, `not_run` or `not_configured`, with no exception: **incomplete**. A missing check is never a pass; a suite that cannot run is `not_run`; no integration command is `not_configured` and incomplete; no scanner report is `not_run`.
3. Otherwise, if any check carries an exception: **qualified_with_exceptions**.
4. Otherwise: **qualified**.

Optional checks that did not run (performance with no command) stay out of the decision but never out of sight: `outcome_summary` says so, for example `qualified; not assessed: performance (not configured)`, in the snapshot and in the command's output.

An exception is recorded only on a person's explicit instruction: `run.py release except --release <id> --check <check-id> --by <role> --reason <text>` appends to `exceptions.jsonl` with the snapshot's exact commit. The role is a role (`release-manager`), never a name. An exception for another commit, an unknown check or a passing check is listed under `exceptions_not_applied` and changes nothing. A new qualify run is needed for an exception to count.

## Product acceptance

`studio.py acceptance record <WAVE-ID> --release <id> --commit <sha> --decision accepted|rejected --by <role> [--readiness <path>] [--note]` writes `product/acceptance/<WAVE-ID>.json` in the draft workspace, bound to the wave **as merged at the release commit** (read from Git; `wave_sha256`, `wave_revision`), not to the workspace's draft, which may have moved on to a later revision, the release ID and commit, and the readiness file's SHA-256 and outcome. Recording is refused if the wave at that commit is missing (refresh first) or not approved. Accepting is also refused unless the readiness snapshot given explicitly is for that release and commit, contains that exact wave revision, and is `qualified` or `qualified_with_exceptions`. Rejecting is always possible. The structural validator checks the file's shape and references; whether it applies to a release is decided by the release check. It is published by the existing `send`, as its own request on `product/<WAVE-ID>-acceptance` when the wave itself was sent earlier; an acceptance publication holds exactly `product/acceptance/<WAVE-ID>.json` (checked before the push, against the commit's diff), titled "Product acceptance for <WAVE-ID> at <commit>". The wave's definition and its acceptance are always separate publications: `send` publishes the definition when it has changes, the decision otherwise or with `--acceptance`, and reports `published` and `still_unsent`.

The snapshot reports `product_acceptance` as `accepted`, `rejected` or `not_recorded`, read only from merged product files (the integration branch's shared product commit, or the release commit) and only when the file names this release, this commit and this wave revision. It is never inferred from a merge or a passing suite, and it does not change the outcome: qualification is engineering's evidence, acceptance is product's decision on it. Because the acceptance merges after the release commit, `release qualify --release <id> --commit <release commit>` picks it up.

## What it deliberately does not do

It never merges, pushes, tags, publishes, deploys, or changes any checkout; starts no station, agent, workflow or background process; reads no machine-local Factory settings; and no station, agent or workflow calls it (`tests/test_release_qualify.py` holds these). It does not decide what to ship, does not run a deployment or an environment, does not measure performance unless the project declares a command, and does not interpret scanner output beyond severity. Product Studio still reads no Factory policy; it reads only the readiness file a person names. 

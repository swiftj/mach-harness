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

`run.py release qualify <WAVE-ID>... [--release <id>] [--commit <sha>]` evaluates the integration branch at one commit (default: its local head; `--commit` must be on it) and writes `.factory/release/<release-id>/readiness.json`, schema `schemas/release-readiness.v1.schema.json`. Keys are sorted and nothing in it depends on the clock, so identical inputs give identical bytes. The run's time, durations and the commands' output go to `run.json` and `logs/` beside it. A release ID names one commit: reusing it for another commit is refused.

It records: release and product identity; each wave's revision and SHA-256; for each slice its revision, spec path and SHA, digest, ticket, integration (status, commit, how it was established), verification verdict and review decision (with the archive path they were read from), contracts; every `AC-NN` of every in-scope spec with its evidence or `missing`; the test suite rerun at that commit; integration tests (`release.integration_command`) and performance (`release.performance_command`) if declared; security (open review blockers, scanner reports in `.factory/release/scans/*.json` as `{tool, commit, findings[{id, severity, title}]}`, only for this commit); every check with id, status and detail; exceptions applied and not applied; human approvals found in the records (wave approvals, review sign-offs); product acceptance; the outcome.

Checks, each `pass`, `fail`, `missing`, `not_run` or `not_configured`: `product.definitions`, `product.<WAVE>`, and per slice `ticket`, `current` (no newer approved revision on the branch that this release lacks, not withdrawn), `integrated`, `verification` (PASS, for the commit review approved), `review` (APPROVED, with the person's approval when it was required), `scenario.<SLICE>.<AC>`, `contract.<SLICE>.<path>` (exists at the release and is byte-identical to the version at the commit review approved), `dependency.<SLICE>.<DEP>` (integrated at this commit), `blocker.<SLICE>.r<N>.<i>` (an outvoted blocker in the approving round); then `suite`, `integration_tests`, `performance` (optional), `security.scan` or `security.scan.<tool>` (critical or high findings fail).

## Decision rules

1. A failing check, or an open blocker, with no exception: **blocked**.
2. Otherwise a required check that is `missing`, `not_run` or `not_configured`, with no exception: **incomplete**. A missing check is never a pass; a suite that cannot run is `not_run`; no integration command is `not_configured` and incomplete; no scanner report is `not_run`.
3. Otherwise, if any check carries an exception: **qualified_with_exceptions**.
4. Otherwise: **qualified**.

An exception is recorded only on a person's explicit instruction: `run.py release except --release <id> --check <check-id> --by <role> --reason <text>` appends to `exceptions.jsonl` with the snapshot's exact commit. The role is a role (`release-manager`), never a name. An exception for another commit, an unknown check or a passing check is listed under `exceptions_not_applied` and changes nothing. A new qualify run is needed for an exception to count.

## Product acceptance

`studio.py acceptance record <WAVE-ID> --release <id> --commit <sha> --decision accepted|rejected --by <role> [--readiness <path>] [--note]` writes `product/acceptance/<WAVE-ID>.json` in the draft workspace, bound to the wave's approved bytes (`wave_sha256`), the release ID and commit, and the readiness file's SHA-256 and outcome. Accepting is refused unless the wave is approved and the readiness snapshot given explicitly is for that release and commit, contains that exact wave revision, and is `qualified` or `qualified_with_exceptions`. Rejecting is always possible. The structural validator checks the file's shape and references; whether it applies to a release is decided by the release check. It is published by the existing `send`, as its own request on `product/<WAVE-ID>-acceptance` when the wave itself was sent earlier.

The snapshot reports `product_acceptance` as `accepted`, `rejected` or `not_recorded`, read only from merged product files (the integration branch's shared product commit, or the release commit) and only when the file names this release, this commit and this wave revision. It is never inferred from a merge or a passing suite, and it does not change the outcome: qualification is engineering's evidence, acceptance is product's decision on it. Because the acceptance merges after the release commit, `release qualify --release <id> --commit <release commit>` picks it up.

## What it deliberately does not do

It never merges, pushes, tags, publishes, deploys, or changes any checkout; starts no station, agent, workflow or background process; reads no machine-local Factory settings; and no station, agent or workflow calls it (`tests/test_release_qualify.py` holds these). It does not decide what to ship, does not run a deployment or an environment, does not measure performance unless the project declares a command, and does not interpret scanner output beyond severity. Product Studio still reads no Factory policy; it reads only the readiness file a person names. Contract drift between two in-scope slices that legitimately evolved one contract shows as a failure; a person records an exception if that is intended.

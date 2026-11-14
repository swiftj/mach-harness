# M7 security scans and SBOM

Scope: Phase 4 ("Deterministic security scanning", "Threat-modeling tools") and Phase 6 (SBOM) of the M7 brief.
Snapshot scanned: `git archive fb6226c` (extracted into scratch). Date of the scans: 2026-11-14.
Raw reports are in scratch (`scratchpad/m7/agents/scan/out/`), not committed.

**Headline: no confirmed High or Critical finding and no real secret.** Every secret hit is a deliberately fake
value in a redaction test. One moderate dependency advisory (dev tooling only) needs a person's decision.

## 1. Tools installed (Homebrew, all five succeeded)

| Tool | Version | Source (`brew info`) |
|---|---|---|
| semgrep | 1.184.0 | homebrew-core `Formula/s/semgrep.rb`, bottle |
| gitleaks | 8.30.1 | homebrew-core `Formula/g/gitleaks.rb`, bottle |
| osv-scanner | 2.7.0 | homebrew-core `Formula/o/osv-scanner.rb`, bottle |
| trivy | 0.76.2 | homebrew-core `Formula/t/trivy.rb`, bottle |
| syft | 1.57.1 | homebrew-core `Formula/s/syft.rb`, bottle |

Data dates: Semgrep rule packs were fetched live on 2026-11-14 from the registry (the registry does not report a pack
version; 386 rules ran). Trivy DB `UpdatedAt` 2026-11-14T19:00Z, `NextUpdate` 2026-11-15, downloaded 2026-11-14T22:06Z.
OSV-Scanner queried the live OSV API on 2026-11-14 (the one advisory returned was last modified 2026-11-04); it
reports no database version. Gitleaks and Syft use built-in rules/catalogers (no database).

Environment note: the first `trivy` run failed to download its DB because `~/.docker/config.json` names a missing
`docker-credential-osxkeychain` helper. Rerun with `DOCKER_CONFIG` pointed at an empty directory (no credentials
involved). A release check must set the same.

## 2. Commands (each run once; `S` = scratch scan dir, run from the extracted snapshot `src/`)

```
gitleaks dir --no-banner --redact -r gl-tree.json -f json $S/src
gitleaks git --no-banner --redact -r gl-history.json -f json /Users/johnswift/Projects/mach-harness-m7
semgrep scan --metrics=off --config p/python --config p/golang --config p/javascript --config p/typescript \
  --config p/security-audit --config p/secrets --json -o semgrep.json --exclude node_modules .
osv-scanner scan source --format json --output osv.json -L web/pnpm-lock.yaml -L apps/observer/go.mod -L apps/studio/go.mod
DOCKER_CONFIG=<empty dir> trivy fs --cache-dir <dir> --scanners vuln,misconfig,secret --format json -o trivy-fs.json .
DOCKER_CONFIG=<empty dir> trivy fs --cache-dir <dir> --scanners vuln,misconfig,secret --format json -o trivy-workflows.json .github/workflows
syft scan dir:. -o spdx-json=sbom.spdx.json -o cyclonedx-json=sbom.cdx.json
syft scan file:scratchpad/m66/shared/bin/mach-observer -o spdx-json=... -o cyclonedx-json=...
```

Gitleaks history covered 192 commits of the M7 worktree's history (it includes the uncommitted-free HEAD; the
M7 worktree has uncommitted edits that the history scan does not see; the tree scan used the snapshot).

## 3. Results

| Tool | Scope | Findings | Triaged outcome |
|---|---|---|---|
| gitleaks (tree) | snapshot | 10 | all false positives (fake values in redaction tests) |
| gitleaks (history) | 192 commits | 9 | same fixtures, earlier line numbers; false positives |
| semgrep | 868 files, 386 rules | 14: 4 ERROR, 10 WARNING | 0 confirmed; 4 FP (filepath-clean), rest low/needs person or FP; 1 partial-parse warning |
| osv-scanner | pnpm-lock (415 pkgs), 2 go.mod | 1 (Moderate, CVSS 6.9) | needs a person (dev-only dependency) |
| trivy fs | snapshot; vuln, misconfig, secret | 0 vuln, 0 misconfig, 0 secret | no findings; see gaps (disagrees with OSV) |
| trivy fs | `.github/workflows` | 0; "config files detected: 0" | not covered: Trivy has no GitHub Actions checks here |
| syft | snapshot | SPDX + CycloneDX, 424 components | produced |
| syft | `mach-observer` binary (m66 build) | SPDX + CycloneDX, 3 components (`stdlib go1.27.3`) | produced; only the standard library, no third-party modules |

`mach-studio` has no built binary in scratch, so no SBOM was made for it (not run, not a pass).

### Secret hits (all fake, none real; values redacted in the reports)
- `apps/observer/internal/ingest/fuzz_test.go:39` curl-auth-header: a fixture transcript line.
- `apps/observer/internal/normalize/provenance_test.go:124` generic-api-key: `TOKEN=abcdef123456` redaction input.
- `apps/observer/internal/ingest/redaction_test.go:37` jwt and `:39` generic-api-key: marker-named JWT (`MARKERsignature0000`).
- `apps/observer/internal/redact/freetext_test.go:97`, `apps/observer/internal/artifact/artifact_test.go:409`: `AKIAABCDEFGHIJKLMNOP`-style fake AWS ids in "must be redacted" lists.
- `apps/observer/internal/redact/redact_test.go:31` private-key (a fake PEM wrapper), `:115-116` `Bearer MARKERtok`.
- `tests/test_stream_fixtures.py:123` `Bearer sk-ant-abcdefghijklmnop` (obviously fake).
Classification: false positive, test fixtures that exist to prove redaction works. Suggest a `.gitleaks.toml` allowlist
by path (`_test.go`, `tests/`) so the scan is quiet and a new hit elsewhere stands out.

### Semgrep (no High/Critical equivalent; the four ERROR rows are false positives)
- `apps/observer/internal/server/server.go:296` and `apps/studio/internal/server/server.go:156`, filepath-clean-misuse (x2 each, ERROR): false positive. `path.Clean` is used as a guard that *rejects* any URL path that is not already clean; no file is opened from it.
- `apps/observer/internal/ingest/ingest.go:1235` decompression bomb (MEDIUM): the tar entry is streamed into a hasher, not held in memory, and only a few named files are buffered, capped at 64 MiB. Local archives written by cleanup. Low; needs a person only if archives may come from elsewhere.
- `.../security/session.go:230` (observer) and `apps/studio/.../session.go:81`: cookie without `Secure` (LOW). The services serve plain HTTP on 127.0.0.1, where a `Secure` cookie would not be sent by some browsers. Needs a person: decide whether to document this as accepted.
- `testkit/synth/append.go:7`, `model.go:21` math/rand: test tooling for synthetic histories, never shipped. False positive.
- `bin/mach:194` dynamic urllib: the code checks the scheme is `https://` or `file://` first (and carries a `noqa`). False positive.
- `skills/run/scripts/executor.py:278,312`, `policy.py:88` insecure file permissions: flagged on `os.chmod`/`os.open` with modes `0o700`/`0o600`, which are the restrictive ones. False positive.
- `skills/ticket/scripts/ticket.py:846` sha1: used for a 16-character dedupe fingerprint, not for security. False positive.
- Partial parse: `web/apps/control-tower/src/analytics/data/index.ts:11` (`type` import syntax unsupported by the parser). That file was only partly analysed.

### OSV
- GHSA-g3hv-75wg-m249 (CVE-2026-118764), `minimatch@10.2.6`, Moderate/6.9, CWE-405 (pattern amplification when `optimizationLevel >= 2`), fixed in 11.0.1. In `web/pnpm-lock.yaml` it comes in through `@typescript-eslint` (lint toolchain), not shipped in the Control Tower bundle. Classification: needs a person (likely accept for dev-only use, or bump when typescript-eslint allows). `minimatch@3.1.5` is not flagged. Both Go modules: no advisories. Disagreement: Trivy (DB of the same day) reported none for the same lockfile, so tools differ in coverage and lag.

## 4. Confirmed findings

None. There is therefore no file:line to fix. Suggested clean-ups (not defects): a gitleaks allowlist for test fixtures; a short written note accepting the non-`Secure` loopback cookie; decide on the minimatch dev dependency.

## 5. Coverage gaps (what no tool looked at)
- GitHub Actions workflows (`release.yml`): Trivy found nothing to check; actions are pinned by major tag (`@v7`, `@v8`), which is mutable; no tool reported it. Not assessed by a tool (zizmor or actionlint would cover it; not installed here).
- Skill, agent and workflow prompts (Markdown instructions to agents): no scanner understands prompt injection or permission escalation; that is the threat-model's job.
- The Python code has only generic rules; MACH-specific logic (gates, lease, authorization) is not covered.
- Syntax-error partial parse of one TypeScript file; `node_modules` excluded and `.semgrepignore` skipped 175 files (tests and similar).
- Container and IaC checks: there are none in the repository (Trivy found no config files).
- Release artifacts: only the m66 observer build was inventoried; the Studio binary and the checksummed release files were not scanned.
- The working-tree changes in the M7 worktree (uncommitted) are not in the snapshot.

## 6. Offline behaviour, pinning, staleness

| Tool | Needs the network for | Pin and cache | Stale or missing means |
|---|---|---|---|
| semgrep | rule packs (`p/...`) from the registry | pin by copying packs to local YAML in a vendored dir (`--config ./rules`), or `--config` a file with a recorded hash; version via brew | rules missing = incomplete |
| gitleaks | nothing | version pinned; optional `.gitleaks.toml` | n/a; binary missing = incomplete |
| osv-scanner | OSV API for advisories (default online); has an offline database mode (`--offline-vulnerabilities`, `--download-offline-databases`) | download the offline DB into a dated cache dir and record the date | DB older than a set age (suggest 7 days) or API unreachable = incomplete |
| trivy | vulnerability DB (OCI, `mirror.gcr.io`) and check bundle | `--cache-dir`, `--skip-db-update`, `--offline-scan`; the cached `metadata.json` `UpdatedAt` is the freshness date | no cache with `--skip-db-update`, or `UpdatedAt` older than the limit = incomplete |
| syft | nothing for a dir or file scan | version pinned | n/a |

Rule: a required scanner that did not run, exited abnormally, produced an unparsable report, or whose data is older than
the configured limit reports `incomplete`. It never reports `pass`. "Zero findings" is a pass only when the scanner ran
over the intended scope with fresh data.

## 7. What MACH uses today (`skills/audit/scripts/audit.py`)

Line 52 lists `SECRET_SCANNERS = ("gitleaks", "detect-secrets", ...)`; lines 361-363 check only that one of those
names appears as text in `.pre-commit-config.yaml`, `.github/workflows/*` or `.gitlab-ci.yml`, or that `.gitleaks.toml`
exists. That earns 2 of 100 points ("Secret scanning configured"). **It is configured-not-run:** the audit never runs a
scanner, reads no result and checks no freshness. This repository has no pre-commit file and its single workflow does not
name a scanner, so this check fails here today. No other scanner (Semgrep, OSV, Trivy, Syft) is referenced. The
build, test and lint commands are the only things the audit really executes.

## 8. Proposed minimal integration

1. A release-qualification step (no new station, no new user-facing command) runs each scanner with pinned
   versions and writes its native report to `.factory/release/scans/<tool>.json` (`gitleaks`, `semgrep`, `osv-scanner`,
   `trivy`, `syft` SBOM files alongside). Each report is accompanied by `<tool>.meta.json` with the tool version, command,
   scope, exit code, data date and start/end time.
2. The release-qualification snapshot reads these files. The security check is `pass` only when every required scanner has
   a report that parses, matches the snapshot commit, is within the freshness limit and has no unwaived High/Critical
   result or secret. Otherwise `incomplete` (missing, stale, crashed) or `fail`.
3. Waivers (for example the test-fixture secret paths) live in a tracked allowlist with reason, owner and expiry, so an
   exception is recorded and traceable, never silent.
4. Required set: gitleaks, semgrep, osv-scanner. Advisory: trivy (adds nothing over OSV here but gives a second opinion), syft (SBOM, required for a release candidate). No hosted service; all runs local.
5. The release workflow attaches the SPDX and CycloneDX SBOMs of each built binary to the release.

## 9. Grim Prompter evaluation

- **What it is:** a set of Markdown prompts and a skill (`skills/threat-model`) that has a coding agent produce an evidence-traced threat model; 36 architecture workflows, 29 method prompts, a quick mode and a six-stage deep mode. Author: a security consultant (Manicode Security). Repositories: `github.com/jmanico/grim-prompter` (original) and a fork-like copy `philmcneely/grim-prompter`.
- **Licence:** MIT.
- **Maturity:** young. 16 commits, no GitHub releases or tags shown, 471 stars, 3 watchers, 38 forks; announced recently and still changing (a privacy-review PR was merged about 2026-11-08). Pinning would mean a commit hash, not a version.
- **How it runs:** locally, as instructions inside the user's own Claude Code; the repo itself has no server, telemetry, script or hook (install is `git clone` and a symlink). It sends nothing of its own, but, like any Claude Code run, the repo content the agent reads goes to the model provider. It cannot run without a model, so "offline" is only as offline as Claude Code is. I did not inspect the skill text beyond the README summary (a web fetch only, not a full source review).
- **Adds over a reviewer-written threat model?** Possibly a checklist of attack classes and a consistent output shape; it adds no deterministic evidence and its findings are model-generated and speculative until verified. MACH already has a security review seat and now a written threat model task.
- **Not installed or run** (it is local and MIT, but I could not establish within the time box, by reading only its README, that nothing leaves the machine beyond the model call, and the brief forbids running agents here).
- **Recommendation: not adopted in M7.** Reasons: immature (no release to pin), duplicates the structured threat model, and would add model cost without deterministic evidence. Revisit after M7 as an optional, pinned-commit, read-only skill whose output is labelled "speculative, unverified" and compared against the reviewer's model.

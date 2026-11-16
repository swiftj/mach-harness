# M7 distribution check: release pipeline, fresh install, integrity, upgrade, rollback, uninstall

Scope: Phase 6 of the M7 brief. It covers what `M6_6_PACKAGING.md` did not (that file validated the Factory Floor's own install path and is not repeated here). Each check was run once. A check run against a stand-in for GitHub is labelled "simulated". Raw output is in `scratchpad/m7/agents/dist/ev/` (paths below are relative to that folder).

## Environment

- macOS (Darwin 27.2, Apple silicon), Python 3.15.2 (Homebrew), Git (Homebrew). The README promises Python 3.8 or later; nothing older than 3.15 was run.
- Snapshot `git archive fb6226c` (`src/`); the old layout is `git archive v0.12.0` (`old/`).
- Programs built once from the snapshot with the repo's own `build.sh` (`SKIP_INSTALL=1`, `node_modules` cloned with `cp -Rc`) into `rel/`: `mach-studio-darwin-arm64`, `mach-observer-darwin-arm64`, plus a `SHA256SUMS` made with `shasum`. A second build gave the same two SHA-256 values (same machine, toolchain and path only).
- Fake release: `MACH_STUDIO_URL=file://.../rel` (the installer accepts `file://`). The installer's HTTPS path was therefore never exercised against GitHub.
- PM environment: throwaway `HOME`, `env -i`, `PATH` = symlinks to git and python3 plus `/usr/bin:/bin`. `command -v node go` found nothing on that PATH.
- No Factory was enabled and no station, supervisor or `claude -p` was run. Every process started (host, observer) was stopped; `pgrep` found none at the end.

## 1. Release pipeline (read, not run)

Platforms in `.github/workflows/release.yml` at the snapshot: `darwin/arm64`, `linux/arm64`, `linux/amd64`, for both `mach-studio` and `mach-observer`. The smoke matrix covers the same three on native runners (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`). The `v0.12.0` tag's workflow also built `darwin/amd64`; the current workflow removed it, and the installer's `STUDIO_BUILDS` and the README agree with the three. The published `v0.12.0` release still carries `mach-studio-darwin-amd64`, but the installer never selects it.

What the published `v0.12.0` release carries (`gh release view`, read-only): `mach-studio-{darwin-arm64,darwin-amd64,linux-arm64,linux-amd64}` and `SHA256SUMS` (5 assets). No `mach-observer-*`. 36 downloads of the darwin-arm64 studio and of the sums file.

| Item | Finding |
|---|---|
| Versions | `plugin.json` is `0.12.0` at the snapshot, the same as the `v0.12.0` tag, although the snapshot holds all of M1 to M6.6 since that tag. The installer reads its version from `plugin.json` and downloads from `releases/download/v<version>`. The binaries have no version flag (`--version` is "flag provided but not defined"). The workflow checks tag against `plugin.json` only. |
| Checksums | The workflow writes `SHA256SUMS` for both programs. The installer fetches it from the same base URL as the binary and compares. |
| Attestation | `actions/attest-build-provenance@v4` runs on the three studio and three observer files. `SHA256SUMS` is not attested. The installer has no attestation code (grep for "attest" in `bin/mach` and `install.sh`: none). |
| Lockfiles | `web/pnpm-lock.yaml` is present and used with `pnpm install --frozen-lockfile`. Both Go modules declare no dependencies, so there is no `go.sum`. |
| Reproducibility flags | `CGO_ENABLED=0`, `-trimpath`, locked web dependencies, source maps stripped from the observer. No `-ldflags`, no pinned Go patch version (`go-version-file` reads `go 1.27`), no `SOURCE_DATE_EPOCH`. Third-party actions are pinned to a major tag, not a commit. |
| Installer source | `install.sh` downloads the Python source from `codeload.github.com/<repo>/tar.gz/refs/heads/main` by default (`MACH_REF`), not from a tag, with no checksum or signature. Only the two binaries are checked. |

Integrity claims in README and installer, and whether the code does them:

| Claim | Code does it? |
|---|---|
| Downloads checked against the release's published SHA-256 (README, installer notes) | Yes (tested below). The check is against a sums file from the same place as the binary. |
| Only `https://` or `file://` is fetched | Yes, `fetch()` refuses other schemes. |
| Size cap on the download (200 MB) | Yes. |
| "Each release's files also carry a build provenance attestation: `gh attestation verify ...`" | The workflow creates it. The installer does not verify it; the README leaves it to the person. |
| "A copy already installed is kept when a newer one cannot be fetched" | Yes, seen in the code path and the `kept` item. |
| "Nothing runs until you ask Product Studio to open the app" | Yes in this run: nothing was listening after install. |
| Notes say "downloaded and checked" | True only for the checksum. A reader may take "checked" to mean provenance. |

## 2. Fresh install as a PM (no Node, no Go)

| Check | Command (short) | Result | Evidence |
|---|---|---|---|
| Install | `install.sh` with `MACH_SOURCE=src`, fake release | Pass. 58 files plus both programs; both notes say "downloaded and checked". | `t2-install.txt` |
| Product Studio from the skill's entry | `python3 .claude/skills/mach-product-studio/scripts/studio.py status` | Pass. JSON, `factory_authorized: false`, next step "Define the project". | `t2-status.txt` |
| Host starts, serves app, no Node | `.factory/bin/mach-studio --project . --engine .../studio.py --no-open` | Pass. Printed one `Open: http://127.0.0.1:<port>/?t=...` link, served the app HTML, session and status op answered. | `studio.log` |
| One product operation through the host | POST `/api/ops/project.init` with session cookie and CSRF header | Pass. Project created; the terminal `studio.py status` then showed `team-space`. | `t2-status.txt` |
| Factory disabled | `ls .factory/local`; `run.py factory status` | Pass. `runner.json` absent; `"factory": "disabled"`. `.factory/local/` holds only the observer's own folder. | `t2-status.txt` |
| Factory Floor observes | `.factory/bin/mach-observer --project .`, open link, `/api/v1/health`, `/api/v1/snapshot` | Pass. Link redeemed, health fresh, snapshot empty and not partial. Factory still disabled afterwards. | `observer.log` |
| Only loopback | `lsof -nP -a -p <pids> -i` | Pass. Two sockets, both `127.0.0.1` LISTEN; no established connection to any host. This is a snapshot, not a capture. | `t2-sockets.txt` |
| Python missing | install with no python3 on PATH | `MACH needs python3 (3.8 or later). Install it and run this again.` Exit 1. Clear in what is missing; says nothing about how to get it. | `t2-missing-tools.txt` |
| Git missing | install with no git on PATH | The install succeeds with no mention of git. `studio.py status` then dies with a Python traceback ending `FileNotFoundError: [Errno 2] No such file or directory: 'git'`. `run.py status` still works. | `t2-missing-tools.txt` |

A mistake in this run: a first "git missing" attempt omitted `MACH_SOURCE`, so it downloaded the main branch and the real `v0.12.0` release from GitHub once. Those results were discarded and the check was redone offline. The one-time observer link was printed to the terminal once (throwaway project, link already used).

## 3. Integrity

| Check | Result | Evidence |
|---|---|---|
| One byte flipped in each binary, original sums | Refused: "does not match the release's published checksum, so it was refused". Nothing written to `.factory/bin`. Install exits 0 (by design: the rest of MACH works). | `t3-integrity.txt` |
| Truncated to half, original sums | Refused with the same message. | same |
| Truncated HTTP body (simulated, a loopback server sent half of a declared length, installer code run with its URL redirected) | Refused: installer raised its own `Fail`, no traceback. Simulated, not HTTPS. | same |
| Missing asset | Studio: "the download did not complete ([Errno 2] No such file or directory: ...)"; the observer in the same release installed. The message exposes a raw OS error and a path, and does not say the file was not in the release. | same |
| Missing `SHA256SUMS` | Both programs skipped, same raw message. | same |
| Executable permissions | `.factory/bin/mach`, `mach-studio`, `mach-observer` are `0755`; skill scripts `0755`. | `t3-integrity.txt` |
| Tampered binary plus a forged matching `SHA256SUMS` in the same place | Accepted: "downloaded and checked". Confirmed. The checksum guards against corruption and a mismatched mirror only; whoever can replace the binary can replace the sums. This is the reason attestation verification matters (section on attestations below). | same |

## 4. Upgrade from v0.12.0 (hand-built state)

Old layout: `old/` installed with its own installer (studio only; a stand-in `SHA256SUMS`, as v0.12.0 had no observer). State created with the old `studio.py` or copied from the M6.6 live-run project (`scratchpad/m66/agents/live/P/eng`): a Studio draft workspace (project, approved epic, `SLICE-001` approved for engineering, `SLICE-002` draft), intake `ledger.json` and `events.jsonl`, cell `LOCAL-002` (with a git worktree for `repo/`), `archive/` with `runs.jsonl` and a tarball, a disabled `runner.json`, an observer index folder, tickets, an edited `.factory/config.json`, a `REVIEW.md` with a local rule appended. Fixture note: the first attempt crashed `run.py status` and `product status` because the cell had no `repo/`; the old scripts crashed the same way on that state, so it was a fixture fault. It was fixed in both copies before the results below.

| Check | Result | Evidence |
|---|---|---|
| Upgrade with the snapshot's installer | 25 updated, 3 created (including `mach-observer`); exit 0. | `t4-upgrade1.txt` |
| Studio drafts, intake ledger and events, cell, archive, `runner.json`, observer folder | Byte-identical (SHA-256 before and after). No migration, no version bump, none needed. | `t4-before.txt`, `t4-after1.txt` |
| Edited `config.json`, customised `REVIEW.md` | Kept byte-identical; the local rule is still there. | same |
| `.gitignore` | Changed: the MACH block gained the `mach-observer` line. Managed block, expected. | `t4-upgrade1.txt` |
| Manifest | Updated (`updated_at`, 58 to 61 files). `version` is still `0.12.0`, the same before and after. | `t4-manifest-old.json` |
| Factory | `runner.json` unchanged (`enabled: false`); `run.py factory status` says disabled. | `t4-readers.txt` |
| New scripts read old state | `run.py status`, `run.py product status`, `studio.py status` (slices `approved_for_engineering` and `draft` as before), `cleanup.py status` (cell listed): all pass; the board output matches the old scripts' on the same state. | `t4-readers.txt` |
| Observer starts on the old index folder | Starts, says "the kept browser sessions belong to another project folder; ignoring them", health fresh, snapshot has the three cells, not partial. Not a true old-observer index: v0.12.0 shipped no observer, so cross-version index compatibility cannot be shown. State files were unchanged afterwards. | `observer-up.log` |
| Second upgrade | Exit 0, no file touched ("Everything" up to date); state hashes identical. Idempotent. | `t4-upgrade2.txt`, `t4-s4.txt` |

## 5. Rollback

There is no documented rollback (README and `bin/mach` do not mention it). Reinstalling the old installer over the new one, as a person would:

- Works: exit 0; 25 files restored to old content; `.factory/bin/mach-observer`, `lifecycle.py` and `provenance.py` removed as "no longer shipped"; studio kept; manifest back to 58 files. The old `run.py status`, `product status`, `factory status`, `cleanup.py status` and `studio.py status` all read the state without error, including a cell that holds the new `lifecycle.jsonl` (`t5-old-readers.txt`).
- Does not work or is not shown: the Factory Floor is gone after rollback (v0.12.0 has none; reinstalling the new version restores it). `__pycache__` folders from the newer scripts stay behind (harmless). State written by the new version with a changed format was not found: no state file in this layer carries a version that the old scripts reject. Not shown: state written by a future format change, because none has happened yet between these two versions.
- Smallest recovery: run the new installer again over the old (tested: 28 files restored, observer back, state unchanged). Back up `.factory/` first if state matters; the installer itself never touches it.

## 6. Uninstall after all that

`python3 .factory/bin/mach uninstall` removed 61 files (the unchanged manifest files, the programs) plus the scripts' `__pycache__` folders, kept `.factory/config.json` and `REVIEW.md` ("you changed it"), kept `.factory/tickets|worktrees|archive` and everything else under `.factory/` (`studio/`, `intake/`, `local/`). The state hashes are identical to before the upgrade. The manifest file stays while kept files remain. Nothing in the manifest remains except the two kept files. Evidence: `t6-uninstall.txt`, `t6-after-all.txt`.

## Defects

Severity as in the brief: Blocker stops a release, Major breaks a shipped promise or leaves a person stuck without a clear message, Minor is cosmetic or recoverable.

1. **Major. Version not bumped since v0.12.0.** `plugin.json` still says 0.12.0, so an install from `main` looks for the `v0.12.0` release, which has no `mach-observer`. A PM gets "The Factory Floor was not installed: MACH 0.12.0's release does not include it" and the studio app is the older build. The tag check in the workflow cannot catch it. Fix before tagging: bump and tag.
2. **Major. Installer verifies a checksum only, from the same place as the file; the Python source has no check at all.** A forged `SHA256SUMS` beside a tampered binary is accepted (confirmed, section 3). `install.sh` also pulls the scripts from the tip of `main`. See the recommendation below.
3. **Major. Missing git ends in a traceback.** The install succeeds without git, and Product Studio then fails with `FileNotFoundError: 'git'`. The README lists git as a prerequisite, but a PM cannot tell from the crash. The installer or `studio.py` should say "Git is needed. Install it, then run this again".
4. **Minor. Missing release assets give a raw OS error.** "the download did not complete ([Errno 2] No such file or directory ...)" for an asset or sums file that is not in the release. It should say the release does not list the file.
5. **Minor. "Downloaded and checked" names no check.** After the change in defect 2 this should say which check passed.
6. **Minor. Binaries have no `--version`.** The installed program's version cannot be compared with `plugin.json` or the tag; the manifest does not record which release a program came from.
7. **Minor. Release build is only partly reproducible.** Same hashes on two local builds, but no pinned Go patch release and the actions are pinned by tag, so a rebuilt release may differ. Not proven either way on CI.
8. **Minor. Uninstall also deletes unlisted `__pycache__` folders** (the manifest lists only the sources). Harmless; the claim "exactly what the manifest lists" is slightly off.

## Not verified here (only a tagged release can show it)

- The three per-platform builds and their native smoke tests (`ubuntu-24.04-arm`, `macos-latest`, `ubuntu-latest`): only `darwin-arm64` was built and run, here.
- That attestations are created and are valid (`actions/attest-build-provenance@v4`), and what subject they carry.
- The HTTPS download from GitHub, redirects and rate limits; the installer on Linux; Python 3.8 to 3.14.
- `gh release create` with `--verify-tag`, and a `v0.13.0` upgrade from a real `v0.12.0` install (here the new release was stood in by a local folder).
- That the CI binaries match mine bit for bit.
- A packet capture of runtime traffic; only a socket snapshot was taken.

## Recommendation: verify attestations in the installer

The installer should verify provenance when it can, and say so honestly when it cannot.

1. Attest `SHA256SUMS` too (add it to `subject-path`), so the one file that vouches for the others is covered.
2. After the checksum passes, if `gh` is on PATH, run `gh attestation verify <file> --repo swiftj/mach-harness` (it needs a recent `gh`, network, and no login for a public repository; add `--signer-workflow` to pin the release workflow). Alternative: `cosign verify-blob-attestation` with the Sigstore bundle published as a release asset, which needs `cosign` and the bundle file.
3. If the verification fails, refuse the program (same path as a checksum mismatch). If neither tool is installed, keep the checksum check, install, and print a visible line such as "Checked against the release's checksum only. Provenance was not verified (install the GitHub CLI to verify it)". Never print "verified", "signed" or "provenance checked" unless the tool ran and passed.
4. Fetch the scripts from the release tag, not `main`, and give the tag a source archive checksum or attestation, so the code that runs the check is itself covered.
5. Add `--version` to both programs and record the program's release in the manifest.

## Corrected in M7

Each change has a test in `tests/test_installer.py` (no network; `gh` is a fake script on `PATH` and the GitHub release is a stand-in for `fetch`, so attestation verification itself is simulated, not exercised against GitHub) or, for `--version`, a Go test in each module.

| Defect | Change | Status |
|---|---|---|
| 1. Version not bumped | Not changed. Bumping `.claude-plugin/plugin.json` and tagging is the product owner's release step. | Open |
| 2. Checksum only, from the same place | After the checksum passes, a program from the project's GitHub release (`MACH_REPO` or `swiftj/mach-harness`, the same source as the release URL) is checked with `gh attestation verify <file> --repo <repo> --signer-workflow <repo>/.github/workflows/release.yml`. Verified: the note names both checks. `gh` absent or not signed in (exit 4): installed, and the note says "checked against the release's checksum; its build provenance was not verified (GitHub CLI not available)". Verification ran and failed: the program is refused, the temporary copy removed, an installed copy kept, the rest of MACH installed. `MACH_REQUIRE_PROVENANCE=1` refuses a program whose provenance cannot be verified. `MACH_STUDIO_URL` / `MACH_FLOOR_URL` (mirror or local folder) mean no attestation and the note says so. The workflow now also attests `SHA256SUMS`. | Fixed for the programs. Not fixed: `install.sh` still fetches the Python source from `main` with no checksum (recommendation 4; corrected in M7 (2), below). A network failure while `gh` runs is read as a failed verification (refused, retry advised). |
| 3. Missing git ends in a traceback | `bin/mach install` and `scaffold` run `git --version` first (so the macOS stub without command line tools counts as missing) and stop, writing nothing, with a plain message naming `xcode-select --install`. `studio.py` turns `FileNotFoundError: 'git'` into the same words and exit 1. `install.sh` now runs Python to check for 3.8 or later and says how to get it. The minimum stays 3.8: every script parses with the 3.8 grammar (`ast.parse(feature_version=(3, 8))`) and a search found no 3.9+ library call; the installer tests were also run on Python 3.9.6 (one existing test fails there only because that interpreter does not write bytecode). Nothing older than 3.9 was run. | Fixed |
| 4. Raw OS error for a missing asset | One line: "release vX does not have the file <name>", or for `SHA256SUMS` "release vX was not found, or it has no checksum file". A network error says to check the connection. | Fixed |
| 5. "Downloaded and checked" names no check | Every note names the check that passed and the one that did not. | Fixed |
| 6. No `--version` | `mach-studio --version` and `mach-observer --version` print the release stamped by `build.sh` (`VERSION`, `-ldflags -X main.version`), `dev` otherwise. The workflow stamps the plugin's version on a tag. The manifest gains `programs`: per program the MACH version, asset, source (release or the override variable, never a local path) and what was checked. | Fixed |
| 7. Partly reproducible release | Every action is pinned to a full commit SHA with its release in a comment (looked up read-only with `gh api`); Go is pinned to 1.27.3 (corrected: this text said 1.27.4; `release.yml` pins `1.27.3`, the release the local builds and tests used; the modules have no `toolchain` line); a pinned `syft` (v1.55.0, via `anchore/sbom-action/download-syft` at a pinned SHA) writes `<program>.spdx.json` for each program, attached beside `SHA256SUMS`. No `SOURCE_DATE_EPOCH`. The workflow was not run. | Fixed in the file, not run |
| 8. Uninstall deletes unlisted `__pycache__` | Uninstall now removes only `__pycache__/<name>.*.pyc` of the scripts it removed, lists each folder in its report, and leaves any other file there. | Fixed |

## Corrected in M7 (2): the installer's own source

Defect 2's open half: `install.sh` downloaded MACH's Python source from the tip of `main` and ran it unchecked, and an install from `main` fetched the programs from whatever release `plugin.json` named.

| Change | Where |
|---|---|
| The release workflow packages the repository at the tag as `mach-<version>-source.tar.gz` (`git archive --prefix=mach-<version>/ HEAD \| gzip -9n`: sorted tree, every entry stamped with the commit's time, no gzip name or time; two local runs gave the same SHA-256), installs it into an empty project as a smoke test, lists it in `SHA256SUMS` and attests it with the programs and `SHA256SUMS`. | `.github/workflows/release.yml` |
| `install.sh` installs a release by default: the newest (`api.github.com/.../releases/latest`) or `MACH_VERSION`. It downloads the archive and `SHA256SUMS` over https only, compares the SHA-256 (`sha256sum` or `shasum`), and with `gh` runs `gh attestation verify <archive> --repo <repo> --signer-workflow <repo>/.github/workflows/release.yml`, all before any downloaded code runs. It also refuses an archive whose `plugin.json` names another version. One `MACH source:` line says what was checked and what was not, in the same words as the program notes. | `install.sh` |
| The check is in `install.sh`, not in the unpacked `bin/mach`: whoever could replace the archive and its `SHA256SUMS` could also replace the `bin/mach` inside it, so the downloaded code cannot vouch for its own archive. The rule, the command, exit status 4 meaning "not signed in" and the words are the same as `bin/mach`'s, and a test holds them equal. | `install.sh`, `tests/test_installer.py` |
| Refusals: checksum mismatch, failed attestation, `MACH_REQUIRE_PROVENANCE=1` without a verification, a missing `SHA256SUMS`, and a release newer than v0.12.0 that does not list or does not have its archive. Each says one line, installs nothing and removes the downloads. Nothing falls back to an unchecked download. | `install.sh` |
| Releases up to v0.12.0 (no archive): the tag's tarball is installed with the line "it was not verified (release vX predates MACH's source archives ...)". `MACH_REF=<branch>` and `MACH_SOURCE=<path>` stay possible by explicit choice and say "not verified". All three are refused under `MACH_REQUIRE_PROVENANCE=1`. Only one of `MACH_SOURCE`, `MACH_REF`, `MACH_VERSION` may be set. | `install.sh` |
| The manifest gains `source`: `from` (release and archive, tag, branch, or "a local copy (MACH_SOURCE)", never a path) and `checked`. `bin/mach` run directly records that it was. A release install's programs come from the same release, because the tag must equal `plugin.json`'s version. | `bin/mach` |

Tests (no network, simulated): a fake `curl` on `PATH` maps every `https://` URL to a folder standing in for GitHub, and `gh` is a fake script or absent. Covered: newest release checked and installed; fake `gh` passing (arguments checked) and failing (refused); `gh` not signed in; tampered archive (refused before `gh` is asked; project and `TMPDIR` empty); `MACH_REQUIRE_PROVENANCE=1` without `gh`; v0.12.0 with the note, and refused when provenance is required; a newer release without its archive (three ways, no fallback); a version mismatch; `MACH_REF=main`; `MACH_SOURCE`; `--no-studio`/`--no-floor`; an upgrade from v0.12.0 to a checked release; `sh -n` and `bash -n`. The suite also passed with macOS's `/bin/bash` 3.2. `shellcheck` is not installed here and was not run.

Still to be shown by a real tagged release (not shown here):

- That the workflow's archive step and the smoke install run on CI, and that `gh release create` attaches `mach-<version>-source.tar.gz`.
- That `actions/attest-build-provenance` attests the archive, and that a real `gh attestation verify` of the downloaded archive passes with `--signer-workflow` (a tag-triggered run's signer is the workflow at `refs/tags/v...`; only a real run shows the flag matches).
- That the archive is the same bytes when rebuilt on CI (shown only locally).
- The real `api.github.com/.../releases/latest` lookup (unauthenticated, rate-limited to 60 requests per hour per address) and the redirect of release downloads to GitHub's storage host under `--proto-redir =https`.
- `install.sh` on Linux with `sha256sum`, and an upgrade from a real v0.12.0 install.
- `install.sh` itself is still fetched from `main` and is the trust root; it is not checked.

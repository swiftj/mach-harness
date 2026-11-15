# M7 release candidate v0.13.0-rc.2: what was actually published

> **Superseded by the "rc.4" section at the end.** The patched-copy results below (7b, the patched part of 8 and 10) were made with a modified `install.sh` and are superseded by rc.4's unmodified installer.

Verified on one Apple Silicon Mac against real GitHub, 2026-11-14, by downloading what the release workflow
published. Raw command output is kept as text in the agent's scratch (`.../m7/agents/release/c*.txt`).

## The release

| | |
| :--- | :--- |
| Release | `v0.13.0-rc.2`, marked pre-release; `v0.12.0` is still the latest full release |
| Commit | `5ab996dd33fa28df1a09cbbcee4c1d7612d1e08f` (annotated tag object `23dd23e5...` points at it) |
| Workflow run | `43678068707`; jobs: build, three smoke jobs (macOS arm64, Linux amd64, Linux arm64), publish: all success |
| Attestation | signer `.github/workflows/release.yml@refs/tags/v0.13.0-rc.2`, ref `refs/tags/v0.13.0-rc.2`, commit `5ab996dd...`, run `43678068707` |

### Assets and SHA-256

Listed in `SHA256SUMS` (7 files; the six SBOMs are not listed in it):

```
25fbe058188f8303c49c4b93c3320bf5c8ce0fda9a5afc9b7ca9b696cd26ccae  mach-studio-darwin-arm64
cfe3458ce1488ece08e8d8b247de3837e5528c8323c69f2caafb80cc9e391f11  mach-studio-linux-amd64
337113fe6a0074f0301ada55c10a54974a16412e644a4c57d85c70a243fc4a5d  mach-studio-linux-arm64
4899abc483e83f1590178868f56e80ee3dab04802c89e851f9890cd59bdde975  mach-observer-darwin-arm64
477680a7fbedeade3a7ed8a5a17754d7b4c31d8794bc4660a37de55ecc077dc5  mach-observer-linux-amd64
b986c625ce30def5e36fdac9f1f5440ba39bbfd6dbeeac562a8f5dccd794ef6d  mach-observer-linux-arm64
0e52c45f6a4c9649d1dc6c90a7ee6eb8fc784faef598c71dffd5e41ceafb7723  mach-0.13.0-rc.2-source.tar.gz
```

Also attached: `SHA256SUMS` (645 bytes) and six `<program>.spdx.json` SBOMs (3.7 to 3.8 KB each).

## Results

| # | Check | Command (abridged) | Result | Verdict |
| :-- | :--- | :--- | :--- | :--- |
| 1 | Release shape | `gh release view v0.13.0-rc.2 --json ...`; `gh api .../git/ref/tags/v0.13.0-rc.2` | Pre-release; 6 programs, 6 SBOMs, source archive, `SHA256SUMS` all present. Tag is annotated and resolves to `5ab996d`. `targetCommitish` reads `main`, not the feature branch (the tag, not that field, is what binds the commit). | PASS |
| 2 | Checksums | `gh release download`; `shasum -a 256 -c SHA256SUMS` | 7 of 7 OK. The SBOMs are not in `SHA256SUMS`, so they have a checksum-free path (see defect 3) | PASS |
| 3 | Attestations | `gh attestation verify <f> --repo swiftj/mach-harness` and with `--signer-workflow swiftj/mach-harness/.github/workflows/release.yml` | 8 of 8 (six programs, archive, `SHA256SUMS`) verify both ways, exit 0. A copy with one byte changed fails: exit 1, "HTTP 404" (no attestation for its digest). | PASS |
| 4 | Versions and Gatekeeper | `--version`; `spctl --assess --type execute`; `codesign -dv`; `xattr` | Both print `0.13.0-rc.2`. `spctl`: rejected (exit 3). `codesign`: ad hoc, linker-signed, `Identifier=a.out`, no team ID. Only xattr is `com.apple.provenance`; no `com.apple.quarantine`. | PASS (versions); see note |
| 5 | SBOMs | python reads each file | All six are SPDX-2.3 (syft 1.55.0), named for their program, 3 packages each: the program's own Go module, `stdlib go1.27.3`, and the file. No third-party Go modules (the programs use the standard library only). | PASS |
| 6 | Source archive | unpack; `git archive ... \| gzip -9n \| shasum` | Contains `bin/mach`, `install.sh`, `skills/`; plugin version `0.13.0-rc.2`. The re-made archive has a different sum (`b2d2518e...`), but the uncompressed tar is byte-identical (`dcb3ddab...` both): only the gzip implementation differs (Apple gzip here, GNU on CI). | PASS (content); not byte-reproducible across gzip builds |
| 7 | Real installer, pinned version | `MACH_VERSION=0.13.0-rc.2 bash install.sh` (the archive's own) | **Refused**: `'0.13.0-rc.2' is not a MACH release version (x.y.z)`. Nothing installed. | **FAIL** (defect 1) |
| 7a | Same, `MACH_SOURCE=<verified archive, unpacked>` | shipped `install.sh` | Installed 0.13.0-rc.2: skills, `mach-studio` and `mach-observer` at the published sums; manifest records "checked against the release's checksum and its build provenance was verified with the GitHub CLI" for each; source recorded "not verified (a local copy...)"; `.factory/local/runner.json` absent. | PASS (programs only) |
| 7b | Same with the version check patched in a scratch copy of `install.sh` (one line: regex allows `-rc.2`). **Not the shipped installer.** | patched copy | Full path works: "MACH source: ... release v0.13.0-rc.2 (...source.tar.gz), checked against the release's checksum and its build provenance was verified with the GitHub CLI"; both programs verified; `runner.json` absent. | PASS for the patched copy only |
| 8 | Provenance required, no `gh` | `MACH_REQUIRE_PROVENANCE=1`, `PATH=/usr/bin:/bin` | Shipped installer with `MACH_VERSION`: refused, but for the version regex, not provenance (so nothing was shown). With `MACH_SOURCE`: refused correctly, nothing installed. Patched copy with `MACH_VERSION`: refused with "its build provenance could not be verified (GitHub CLI not available) ... requires it", nothing installed. | PARTIAL: refusal works; the shipped path to it is blocked by defect 1 |
| 9 | Default resolution | no `MACH_VERSION`, signed in | Resolved `v0.12.0`, not the pre-release. Message: "MACH source: github.com/swiftj/mach-harness tag v0.12.0; it was not verified (release v0.12.0 predates MACH's source archives, so its source has no checksum or attestation)." Studio installed, "downloaded and checked"; no observer (none exists for v0.12.0). | PASS |
| 10 | Upgrade 0.12.0 to rc.2 | patched copy over the check 9 project | `studio.py project init` draft made first; after upgrade both programs print `0.13.0-rc.2` and the draft's hash is unchanged. Second run: "Everything is already up to date"; only `.factory/.mach-manifest.json` differs (its `updated_at` stamp). The shipped installer cannot do this (defect 1). | PASS with the patched copy; **FAIL** as shipped |
| 11 | Programs run | `env -i PATH=/usr/bin:/bin HOME=<throwaway>` | Studio: link answers 303 once, reuse 401, `/api/session` 200 with the cookie, 401 without; bound `127.0.0.1`. Observer: link 303, reuse 401, `/api/v1/session` 200 after the link, 401 without; `/api/v1/release/readiness` 200 with `{"items":[],"latest":null}` (empty, not an error); POST gives 405. SIGTERM: no process left. | PASS (exit codes of the stopped processes not captured) |
| 12 | `main`'s `install.sh` | `curl ... main/install.sh` | `main` still serves the old installer: it downloads the `main` branch (`MACH_REF`, default `main`), never reads releases, verifies nothing, has no `MACH_VERSION`. See below. | NOTE (expected) |
| CI | Linux | `gh run view 43678068707 --json jobs` | Smoke jobs on Linux amd64 and arm64 succeeded. CI evidence, **not run by hand**. | NOT RUN here |

### Gatekeeper, in plain words (check 4)

The binaries are ad hoc signed only and not notarised. `spctl` rejects them. Someone who downloads one in a
browser gets the quarantine attribute and macOS will block it on first run until they override it in
System Settings. The installer's `curl` download (and `gh release download`) leaves no quarantine attribute (only
`com.apple.provenance`), so it runs directly. The integrity checks in the installer (checksum, attestation) are
the protection there, not Gatekeeper. The browser-download behaviour is known macOS behaviour; it was not
exercised here, only the absence of the attribute on installer-style downloads.

### What `main` means for the README one-line install (check 12)

The README's one-line command pulls `install.sh` from `main`. Until the M7 branch is merged, that is the old
installer, which installs whatever is on the `main` branch with no checksum or provenance check, never the
release, and it ignores `MACH_VERSION`. Anyone following the README today does not get the verification the
README describes.

## Defects

1. **Blocker. The shipped installer cannot install any pre-release.** `install.sh` requires `x.y.z`
   (`^[0-9]+\.[0-9]+\.[0-9]+$`), so `MACH_VERSION=0.13.0-rc.2` is refused. The release candidate's own
   documented path (`MACH_VERSION=<x.y.z>`, checks 7, 8 and 10) does not work. Everything else the installer
   does works with a one-line patch (7b, 10). Suggested fix: allow an optional `-<identifier>` suffix, and keep
   the `LAST_WITHOUT_ARCHIVE` comparison (already strips the suffix). Needs a new release candidate.
2. **Minor. The default install chooses the latest full release, so it never reaches a candidate** (correct),
   but the README says "Status: 0.13.0-rc.2" while the only default install gives 0.12.0. A reader should be told
   that a candidate needs `MACH_VERSION`, once defect 1 is fixed.
3. **Minor. The SBOMs are not in `SHA256SUMS` and carry no attestation check in the installer.** They are
   informational (the installer does not use them); worth saying so in the README or adding them to the sums.
4. **Minor. The source archive is not byte-reproducible across gzip implementations.** The tar inside is
   identical. The checksum is for the published file, so the install is unaffected.
5. **Minor. The release's `targetCommitish` is `main`**, not the commit or branch it was built from. The tag
   object and attestations are right; the field is misleading to a reader of the release page.
6. **Minor. `mach-studio` of v0.12.0 has no `--version`**, so a v0.12.0 install cannot be queried this way
   (previous release, not fixable here).

No Major defects were found.

## Not verified

- Linux by hand (CI smoke jobs only).
- Apple notarisation (none; Gatekeeper rejects). A browser download's quarantine prompt was not exercised.
- A second machine, or a machine with no prior GitHub credentials: the attestation checks here used the signed-in
  `gh` of the same Mac. Behaviour with `gh` present but not signed in was not run.
- Whether a stopped program exits with status 0 on SIGTERM (only that no process remained).
- The Windows platform (none is built).
- The shipped installer end to end for the candidate (blocked by defect 1; only a patched scratch copy ran).

Process note: one command in this run briefly created a scratch project folder in the main checkout by a
working-directory mistake; it was removed at once, and `git status` there stayed clean.


## rc.4

Release `v0.13.0-rc.4` (pre-release, 14 assets; `v0.12.0` still the latest full release), run `43679699926`, commit
`21cf88a0f753fb7e918828441b5efaa155b1763c`. Verified on the same Apple Silicon Mac against real GitHub, 2026-11-15,
using only what rc.4 ships, including **its own unmodified `install.sh`** from the verified source archive. No patched copies.

- `v0.13.0-rc.1`: tagged, never published; its build failed on a data race in the observer and a Linux file-identity defect.
- `v0.13.0-rc.3`: tagged, never published; its build failed on a shell-syntax error on Linux in the installer.
- `v0.13.0-rc.2`: published, but its installer refused any pre-release version (defect 1 above). **Its patched-copy results (7b, 8 patched, 10) are superseded by A to D below.**

### SHA256SUMS (rc.4)

```
14b617baccf0a9eec8a5fc131cec7de67fa702a33c5d701418c6550a50fc162f  mach-studio-darwin-arm64
25a4f335b0ebe317926587656999c8055efbf2fa4956ae877286fa0ebfbe1925  mach-studio-linux-amd64
a140930a7809638b6266ca25479df607ef77430e01dbdf6deaa85c78f79fbfaa  mach-studio-linux-arm64
1d2ae3a0f9ab314244d40c370d430cdb6d6f022a93c0b3a13edb06f8261f68ad  mach-observer-darwin-arm64
2108cf3903be890a21402483abe9b7e236acae5e1c290897fdea32d6bea93242  mach-observer-linux-amd64
341eccdd338192d64ce18604229aa8be895c29b77f48b791d6a28c0d83d22d7c  mach-observer-linux-arm64
ee6fae22b75543f8edc69094fd5a9225de51cef6a034a4e05414e5cfd9b4c542  mach-0.13.0-rc.4-source.tar.gz
```

`shasum -a 256 -c SHA256SUMS`: 7 of 7 OK. Attestations: all eight (six programs, source archive, `SHA256SUMS`) verify with
`--repo swiftj/mach-harness --signer-workflow swiftj/mach-harness/.github/workflows/release.yml`. Attested workflow
`release.yml@refs/tags/v0.13.0-rc.4`, ref `refs/tags/v0.13.0-rc.4`, commit `21cf88a0f753fb7e918828441b5efaa155b1763c`.
Tag `v0.13.0-rc.4` is an annotated tag object (`c154675...`).

### A to D (unmodified rc.4 installer)

| | Check | Result | Verdict |
| :-- | :--- | :--- | :--- |
| A | `MACH_VERSION=0.13.0-rc.4`, fresh project, `gh` signed in | Installed. Notes: source "checked against the release's checksum and its build provenance was verified with the GitHub CLI"; same for the Product Studio app and the Factory Floor. Both programs print `0.13.0-rc.4`. Manifest records the check for the source and each program. No `.factory/local`, so no `runner.json` (Factory disabled). | PASS |
| B | `MACH_REQUIRE_PROVENANCE=1`, `PATH=/usr/bin:/bin` (no `gh`) | Refused: "its build provenance could not be verified (GitHub CLI not available) and MACH_REQUIRE_PROVENANCE=1 requires it". Exit 2; project left empty. | PASS |
| C | No `MACH_VERSION`: resolves `v0.12.0`, "it was not verified (release v0.12.0 predates MACH's source archives...)". Draft made with `studio.py project init`. Upgrade with `MACH_VERSION=0.13.0-rc.4` | Both programs replaced (rc.4 sums); draft file hash unchanged. Second run: "Everything is already up to date"; the only file that differs is `.factory/.mach-manifest.json` (its `updated_at`). | PASS |
| D | `env -i PATH=/usr/bin:/bin`, `-project` | Both print `0.13.0-rc.4`. Studio: link 303, `/api/session` 200 with the cookie. Observer: link 303, `/api/v1/session` 200, `/api/v1/release/readiness` returns an empty result, not an error. Both bound to `127.0.0.1`; no process left after SIGTERM. | PASS |

Still not verified: Linux by hand (CI only), notarisation, a second machine, and `gh` present but not signed in.

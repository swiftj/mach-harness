# M6.6 — Local installation and distribution review

Phase 8 of M6.6: the Control Tower as an engineer installs and starts it on a MacBook (darwin/arm64), at
`4180c16`. Read-only review plus a local dry run. No Factory was enabled, no station or MACH script was run, and
nothing was fetched from GitHub.

Read: `install.sh`, `bin/mach` (the `Program` table, `program_item`, `download_program`, uninstall, status),
`.github/workflows/release.yml`, `apps/observer/build.sh`, `apps/observer/smoke.sh`, `apps/observer/README.md`,
`skills/run/SKILL.md` ("The Control Tower"), `tests/test_mach_tower.py`, `tests/test_installer.py`.

## How it was run

Everything was in a scratch folder (`agents/policy/` under the M6.6 scratch root; logs in `logs/`, `diag/`).

1. **Source.** `git archive HEAD` into `src/`; the web workspace's five `node_modules` folders cloned from the
   worktree with `cp -Rc`.
2. **Build, as the release workflow does for this machine.**
   `SKIP_INSTALL=1 CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 OUT=release/mach-observer-darwin-arm64 sh apps/observer/build.sh`
   prints "built … (16668 KiB) with the Control Tower from …/control-tower/dist, no source maps". The binary does
   not contain the placeholder text "built without the Control Tower app" (the workflow's check).
3. **Fake release.** `release/` holds the binary and `SHA256SUMS` (`shasum -a 256`, the same format as `sha256sum`).
   Also `release2/` (a plain `go build`, different bytes, for the upgrade), `badsum/` (the right binary with a zero
   checksum) and `onlystudio/` (a `SHA256SUMS` listing only `mach-studio-*`, like v0.12.0).
4. **Install.** A throwaway project (`git init` with one empty commit), then
   `MACH_TOWER_URL=file://…/release python3 src/bin/mach install --project proj --no-studio`. `--no-studio` because
   the Studio has no local release here, and without it the installer would try GitHub.

## Results

| Check | Command (abridged) | Result |
|---|---|---|
| Binary lands and is checked | install as above | "The Control Tower was downloaded and checked (mach-observer-darwin-arm64, MACH 0.12.0)." `.factory/bin/mach-observer`, mode 755, SHA-256 `3d97126f…` = release. Exit 0 |
| Git-ignored | `git check-ignore -v .factory/bin/mach-observer` | `.gitignore:26:.factory/bin/mach-observer`; `git status --ignored` shows it `!!` |
| `mach status` | `python3 .factory/bin/mach status` | "Files: 60 installed, 0 changed", "mach-observer: installed (.factory/bin/mach-observer)", "mach-studio: not installed". Exit 0 |
| Wrong checksum, fresh project | `MACH_TOWER_URL=file://…/badsum … install` | Install exit 0, skills and scaffold installed, no `mach-observer`. Note: "The Control Tower was not installed: mach-observer-darwin-arm64 does not match the release's published checksum; nothing was installed." (wording: defect 1, fixed) |
| Wrong checksum over an installed copy | same, on the installed project | Copy kept (hash unchanged); "The copy already installed was kept." |
| Unavailable URL | `file://…/does-not-exist`; `https://127.0.0.1:9/none` | Exit 0. "…the download did not complete ([Errno 2] No such file or directory: '…/SHA256SUMS')." and "…([Errno 61] Connection refused)." Each followed by a second line, "Everything else works without it; … Run the installer again to retry." (defect 2) |
| A release without the observer | `file://…/onlystudio` | Exit 0, one line: "…MACH 0.12.0's release does not include it; it is published from a later release. Everything else works without it…" |
| `http://` mirror | `MACH_TOWER_URL=http://127.0.0.1:9/x` | Refused: "refusing to download from http://…: only https:// (or a local file://) is used" |
| Skipping | `--no-tower`; `MACH_TOWER=skip MACH_STUDIO=skip` | "The Control Tower was not installed (skipped)." |
| Upgrade replaces the binary | install again from `release2/`, then from `release/` | "update .factory/bin/mach-observer", hash `3d97…` → `4766…` → `3d97…`, manifest hash follows |
| Upgrade while the observer runs | install from `release2/` with the observer up | The running observer kept serving (the next link answered 303), then stopped cleanly (exit 0). The replaced binary started normally. The file is rewritten in place, not renamed (one trial) |
| Uninstall removes exactly what was installed | `python3 .factory/bin/mach uninstall` (after a `--dry-run`) | `git status` shows exactly the 62 committed install files deleted (59 manifest files, the manifest, `CLAUDE.md`, `.gitignore`), and the ignored binary (the 60th manifest file) is gone. Left: `.factory/local/observer/` (index, port, lock, `session-secret`, `sessions.json`), which ignores itself with its own `.gitignore`. Uninstall does not mention it (defect 3) |
| Skill's start step | `.factory/bin/mach-observer --project "<root>"` | Prints "MACH Control Tower observer for proj (read-only)", "Open: http://127.0.0.1:55148/?t=…", "The link works once. A fresh link for another browser is kept in .factory/local/observer/link. Press Ctrl+C to stop." |
| One-time link | `curl -L -c jar -b jar "$LINK"` | 200 `text/html`, the app's `id="root"`, one module script from `/assets/`. The same link again: 401 |
| Second browser | read `.factory/local/observer/link`, follow with a new jar | 200; the session answers with that jar; the file is replaced once used |
| Loopback only | `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n` | one socket: `TCP 127.0.0.1:55148 (LISTEN)` |
| Workspace identification | `GET /api/v1/session` with the cookie | `project: {folder: "proj"}`, `read_only: true`, `capabilities.execution: false`. Only the folder name, never the path (by design; defect 5) |
| No Node.js needed | started with `env -i PATH=/usr/bin:/bin`; `command -v node` there finds none | page, assets and API served |
| Factory stays disabled | `ls .factory/local`; `GET /api/v1/factory/status` | No `runner.json` before, during or after. `summary.mode: "disabled"`, `enabled: false`, `policy.reason: "missing"`, no supervisor lease. `.factory/local/` holds only `observer/` |
| GET only | `curl -X POST/PUT/DELETE …/api/v1/factory/status` | 405 each |
| Clean shutdown | SIGINT and SIGTERM (wrapper records the exit code) | Exit 0 both; link file removed; process gone; `pgrep -P <pid>` finds no child, before or after |
| Remembered port in use | a listener on the remembered port, then start | "The last port, 55148, is in use: listening on a new one. A page left open must be opened again." Starts on a new port |
| `--port` in use | `--port 55148` held | Exit 1: "mach-observer: could not listen on 127.0.0.1: listen tcp4 127.0.0.1:55148: bind: address already in use" |
| Second observer, same project | start twice | Second exits 1: "mach-observer: another observer is already running for this project"; the first keeps serving |
| Not a MACH project | `--project` on an empty folder; a `git init` folder without `.factory`; no `--project` from an empty folder | Each starts and prints a link ("The link works once. Press Ctrl+C to stop."), writes nothing in the folder. No line says there is no Factory here (defect 4) |
| Folder that does not exist | `--project …/nope` | Exit 1: "…/nope is not a folder" |
| Unreadable `.factory` | `chmod 000 .factory` | Exit 1: "could not make …/.factory/local: mkdir …: permission denied" |
| Unreadable index folder | `chmod 000 .factory/local/observer` | Exit 1: "could not make …/observer/index: mkdir …: permission denied" |
| Linked index folder | `.factory/local/observer` → a link; also `.factory/local` → a link | Exit 1: "…/.factory/local/observer is not a folder (a link is refused)" (and the same for `.factory/local`); nothing written in the link's target |
| `smoke.sh` | `sh apps/observer/smoke.sh release/mach-observer-darwin-arm64` | "smoke: ok (… page and 2 assets under the CSP, no source maps, session, events, history, series, spans, concurrency, marks, snapshot, status, metrics, GET only on http://127.0.0.1:55108)" |
| Installer and guard tests | `python3 -m unittest tests.test_installer` / `tests.test_mach_tower` | 45 OK (with the new test) / 8 OK |

Every process started was stopped; `pgrep -fl "mach-observer|hold.py"` found nothing at the end.

**Product Studio's install path.** `git diff b37c036 HEAD -- bin/mach install.sh skills/product-studio apps/studio
templates` is empty: M6.5 and M6.6 changed none of them. The only change made here is the one-line checksum
message in `bin/mach` (defect 1). It is shared with the Studio, so a Studio checksum failure now says "so it was
refused" too. Behaviour is unchanged.

## Defects

| # | Severity | What | State |
|---|---|---|---|
| 1 | low | The checksum note said "The Control Tower was not installed: … does not match the release's published checksum; nothing was installed." while the rest of MACH had installed. Read on its own, it says the install failed | **Fixed**: "…published checksum, so it was refused." (`bin/mach` `download_program`). Test: `TowerTest.test_a_wrong_checksum_on_update_says_what_was_refused_and_keeps_the_installed_copy` |
| 2 | low | An unavailable URL gives a two-line note ending "Run the installer again to retry", where a one-line note was asked for. The first line also carries the raw OS error (`[Errno 2] No such file or directory: '<full path>/SHA256SUMS'`, `[Errno 61] Connection refused`). The older-release case is one clean line | Listed: message design for the lead |
| 3 | low | `mach uninstall` leaves `.factory/local/observer/` (index, `session-secret`, `sessions.json`, port) and says nothing. It also leaves `.factory/local/runner.json` and `.factory/studio/` when present. They are machine-local, self-ignored and not MACH-installed files, but "Left in place" lists only the data folders | Listed: needs a decision on whether uninstall names machine-local state |
| 4 | low | Started on a folder that is not a MACH project (no `.factory`, or no `.git` either), the observer starts silently and the page shows the labelled Simulation. Nothing on the terminal says "no Factory here". The skill tells the person about the Simulation label, which mitigates it | Listed |
| 5 | info | The session and banner name the project by folder name only (`proj`). Two projects with the same folder name look the same. The full path is withheld on purpose (redaction policy) | Listed, no change proposed |
| 6 | info | Integrity, not authenticity: the installer checks the binary against a `SHA256SUMS` fetched from the same place as the binary. The release workflow attests build provenance (`attest-build-provenance`), but nothing verifies the attestation at install time, so a tampered mirror that also rewrites `SHA256SUMS` is not caught. `MACH_TOWER_URL` and `MACH_STUDIO_URL` are trusted as given | Listed: a design question (for example `gh attestation verify` when `gh` is present) |
| 7 | info | `unreadable .factory` gives "could not make …: permission denied" with no hint of what to fix | Listed |

## What only a real tagged release can prove (not verified here)

- Builds for linux/arm64 and linux/amd64 (only darwin/arm64 was built), and each passing `smoke.sh` on its own
  runner. The macOS runner's result was not reproduced; this machine's build passed.
- The release workflow itself: the tag and version check, `go test -race`, the placeholder check, artifact upload.
- `attest-build-provenance` and that the attestation verifies (`gh attestation verify`).
- `gh release create` publishing `mach-observer-*` beside `mach-studio-*` in one `SHA256SUMS`.
- The installer fetching from `https://github.com/<repo>/releases/download/v<version>` (redirects, size cap, TLS):
  only `file://` and a refused `https://127.0.0.1:9` were exercised.
- `install.sh` through `curl | bash` (only `bin/mach` was run directly).
- Gatekeeper on a binary downloaded by a browser (the installer's `urllib` download carries no quarantine flag; the
  local copy carried only `com.apple.provenance`).
- A plugin install, where the skill's first path `${CLAUDE_SKILL_DIR}/../../apps/observer/bin/mach-observer` is
  looked for in the plugin cache.

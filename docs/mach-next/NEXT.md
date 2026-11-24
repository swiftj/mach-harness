# Where the work stands, and what is next

Written on 2026-11-23, after MACH 0.21.0 was published, and brought up to date the same day when 0.22.0 was published, for whoever picks the work up next: a person, or an AI coding agent starting a new session on another machine. Read this first, then `docs/mach-next/M20_TEAMS_AND_MOVING.md`.

Keep this file current: when a piece below is finished or the plan changes, change it here in the same commit.

## 1. State

- **Released:** 0.22.0, tag `v0.22.0`, on `main`. Nothing is unmerged.
- **What 0.22.0 added:** qualifying a release on any machine, from each slice's committed change record (A6 of the M20 design).
- **What 0.21.0 added:** MACH for a team (Part A of the M20 design, except A6), the basic decisions drafted from an engineer's own documents, a ticket's workspace that holds no `.claude/` files, and a plain message when MACH's files are from different versions. The release notes are `docs/guides/RELEASE_NOTES_DRAFT.md`.
- **Checks at release:** `make check` (2,160 tests, 1 skipped), `go test ./...` in both apps, and the web typecheck, lint, build and unit tests (347 and 396) all passed on the release commit.

## 2. What is next, in order

The owner decided this order on 2026-11-23.

### 2.1 Qualifying a release across machines (A6 in the M20 design)

**Built, and released in 0.22.0 on 2026-11-23.** What it does and its limits are in section A6 of `docs/mach-next/M20_TEAMS_AND_MOVING.md` and the release section of `docs/BLUEPRINT.md`. The owner decided on 2026-11-23 that an evidence file's SHA-256 in the committed change record is enough on a machine that does not hold the file, so no shared place for evidence was built.

The four conditions, as tested: a third clone that built nothing reaches the same outcome, check for check, as the two that built the slices; a record edited, replaced or put back by hand, or a spec changed after it, blocks the slice; `acceptance record` works from the third clone's snapshot and is read back there; `AcrossMachinesTest` errors on 0.21.0's qualification and passes now.

Left open by it:

- **Slices merged before 0.22.0.** The change record is version 2 and the readiness snapshot is schema version 3. Every slice merged before this shows as `missing` when qualified, so an epic part-built on 0.21.0 needs an exception per slice or a rebuild.
- **Never run for real:** only simulated station records in clones on one machine; no real Factory run, no real second machine, no real pull request merged on GitHub (a squashed one is not bound).
- **The product approval in `human_approvals`** comes from this machine's ledger, so that list can differ between machines. Putting who approved the slice into the change record would close it.
- **A newer approved revision not yet built** is known only to a Factory that took it in.

### 2.2 Moving a project to another repository (Part B of the M20 design)

Designed, not built. Build in this order: B1 (issues name their epic and dependencies by MACH's own ID), B3 (MACH recognises a moved project), B2 ("move this project" in Product Studio), B4 (joining a repository that already has a project: one project with more epics, renumbered; the owner decided MACH does not learn several projects per repository).

Facts from the real transfer test are in section 1.2 of the design. One open point must be settled in the code first: whether a slice's approval hashes cover the marker line that holds the epic and dependency numbers.

### 2.3 Smaller things left open

- **Never run for real:** the team rules (a real second person and machine), the workspace change under Claude Code's real sandbox, the documents route in a live session (the mapping step), the app's team screens against the live host.
- **`merge.py plan`** does not show the two new refusals (already shipped; slice number already on main); only `run` does.
- **A long, quiet build** looks stale after `intake.claim_stale_days` (3); there is no heartbeat.
- **An engineer's page in the browser** for architecture decisions: raised, left open by the owner.
- **Parked layout items** in Product Studio and the Factory Floor: the list is in `docs/mach-next/M16_LAYOUT.md`.
- **The Factory Floor's "Factory not enabled" label** confused the owner; "Unattended runs: off" was suggested and not decided.
- **A fourth film** (Jira, bringing in a PRD) is pinned: do not start until the owner says.
- **On GitHub:** the defect report `swiftj/mach-harness#1` is fixed by 0.21.0 and still open; the two private repositories `mach-transfer-test-src` and `mach-transfer-test-dst` are throwaways for the owner to delete.

## 3. Setting up a new machine

Needed to run every check: Git 2.36 or later, Python 3.8 or later, Go, Node with pnpm (`pnpm install --frozen-lockfile` in `web/`), and the GitHub CLI (`gh`) signed in.

```bash
git clone https://github.com/swiftj/mach-harness.git
```

Then, from the clone: `make check`; `go test ./...` in `apps/studio` and in `apps/observer`; in `web/`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --filter @mach/product-studio test` and `pnpm --filter @mach/factory-floor test`.

Two things found on a second machine (2026-11-23, macOS, Homebrew Python 3.15.2), neither yet fixed:

- **The tests need Python 3.11 or later, and not Apple's.** With `/usr/bin/python3` (3.9.6), 7 classes fail: no `tomllib` (three in `test_adr_baseline`), a byte-code cache under `~/Library/Caches` (`test_installer.InstallTest`, `test_mach_factory_supervisor.ServiceTest`), and `capture ... -- <arguments>` refused by its `argparse` (`test_verify.CaptureTest`, `test_unattended_commands.InstructionsTest`). The last is MACH itself, not only its test: `verify.py capture` with arguments after `--` does not parse on 3.9.
- **Run the tests with `PYTHONDONTWRITEBYTECODE=1`.** Without it two classes fail every time: `test_verify.CaptureTest` (finds `__pycache__` in the checkout) and `test_build.StepTest` (the build station's test run reads a stale `.pyc` after a source file is rewritten at the same size in the same second). The second is a weakness in the build station's own test runs, not only in the test. So here: `PYTHONDONTWRITEBYTECODE=1 PATH="/opt/homebrew/bin:$PATH" make check`.
- A full run that crosses midnight UTC fails four classes in `test_security_exception` (the test's "today" is fixed when it starts). Run it again.

An AI agent's saved notes and a person's own Claude Code settings do not travel with the repository. Section 4 holds what those notes said.

## 4. Working agreements with the owner

These were agreed over the project and apply to any session.

**Permission.**
- Commit on a feature branch freely. Merge to `main`, push, tag and release only on the owner's word, each time.
- Never start a Factory, a supervisor or `claude -p` against a real repository. Live runs happen only in throwaway projects, with a spending cap.
- Creating, commenting on or closing anything on GitHub needs the owner's word.

**How to build.**
- Agents for design and code: Opus, medium effort. Checking work (captures, browser suites): a cheaper model, time-boxed.
- Agents working in parallel run only the test classes for their own area. The whole suite (`make test`) is run once, by the lead, on the merged branch; never two full runs at the same time.
- An agent's worktree may start from `main`; its brief says to run `git merge --ff-only <the feature branch>` first.
- Interface work loads the `frontend-design` skill and follows `docs/mach-next/STYLE_GUIDE.md`. Ask before running automated screenshots or recordings: the owner may prefer to look themselves.
- MACH has no users but the owner's own teams yet: rename completely, keep no aliases, and do not argue from risk to existing installs.

**How to write.**
- README, guides, release notes and films say what is new. They do not say how far something was tested or what is not done. Testing records go in `docs/mach-next/` and in what you tell the owner.
- Outward-facing copy says "MACH" does things, never "a script". In the product manager's pages say "Technical needs", never "architecture". A person never reads "light path", "engine" or "kind": say "small change" and "full slice". Do not call the PRD feature an "on-ramp".
- Tell the owner plainly what was not verified.

**Fixed product rules** (they are also in the blueprint).
- No second user-facing MACH command line.
- Unattended execution is off by default on every machine; nothing in a repository can turn it on.
- Every MACH service binds to localhost only. The Factory Floor only reads.
- No weakening of Claude Code's safety controls, and no silent weakening of security review.
- No fabricated Factory events or metrics.

## 5. A release, step by step

1. Set the version in `.claude-plugin/plugin.json`, and in `README.md` (the status line and the install example).
2. Add "What changed in <version>" at the top of `docs/guides/RELEASE_NOTES_DRAFT.md` and change its title.
3. Run every check in section 3 on that commit.
4. On the owner's word: merge to `main` with `--no-ff`, push, tag `v<version>`, push the tag.
5. The `release` workflow builds, smoke-tests three platforms and publishes. Confirm the release is published and marked latest.

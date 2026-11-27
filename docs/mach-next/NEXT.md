# Where the work stands, and what is next

Written on 2026-11-23, after MACH 0.21.0 was published, and brought up to date the same day when 0.22.0 was published, for whoever picks the work up next: a person, or an AI coding agent starting a new session on another machine. Read this first, then `docs/mach-next/M20_TEAMS_AND_MOVING.md`.

Keep this file current: when a piece below is finished or the plan changes, change it here in the same commit.

## 1. State

- **Released:** 0.27.0, tag `v0.27.0`, on `main`, 2026-11-26.
- **On the branch `feature/keep-moving`, built 2026-11-27, not merged to `main`, not released.** The notes are written as 0.28.0; the version is still to be set. It came from the owner's report of a real project: ticket 6 failed its third round and MACH offered only to abandon it.
  - *Carry on.* `skills/intent/scripts/rounds.py` is the one rule for rounds; the allowance (`rounds_base`, `extra_rounds`, `carried_on`) is in the cell's `rounds.json`, written only there under a lock. `build.py carry-on`, `decide do <t> carry-on [--guidance]` (first and recommended wherever offered, `CARRY_ON_FIRST` in `decide.py`), guidance kept as `person-guidance-<n>.md` and fenced as a person's words about the work. A person's send-back in the last round grants the round itself. `run.fresh_rounds` gives a fresh set at a person's start (pull, factory start or resume, `next --by-person`, `schedule --named`, `product dispatch --by-person`), never when `MACH_EXECUTION_ID` is set and never on a dry run or a refused start. Telemetry: the build station's `station.exited` with outcome `carried-on-by-person` or `rounds-reset`.
  - *Abandon and archives.* `cleanup.archive` defaults to `none`; `--abandon` deletes the cell, worktrees, local branch, refs under `refs/mach/` and earlier archives, unless `--keep-archive`.
  - *Pull.* This machine's own `autonomy: observe` is lifted by a person's pull or factory start; the project's ceiling holds and is named.
  - *Commands.* `skills/app/` is gone; `skills/run/scripts/app.py` has a `for-skill` mode that the studio and run skills call from a `!` block with the typed words on standard input (a quoted here-document, so typed text is never run). Bare `/mach-studio` and `/mach floor` open the apps.
  - *The Factory Floor.* `web/apps/factory-floor/src/sim/rounds.ts` reads every round; `src/stopped/StoppedPanel.tsx` is the one panel for a stopped ticket; the observer passes guidance as one argument (`apps/observer/internal/act`); `web/packages/ui/src/lib/datetime.ts` and `<Moment>` format every moment in both apps. `mach-synth --stopped` and `apps/observer/internal/testkit/standin/run.py` let the screens be seen without the stations.
  - *Tried for real:* in a throwaway project installed from the branch, `claude -p "/mach-studio link"` and `claude -p "/mach floor link"` each started the app and gave its link in one turn with no permission prompt, and `/mach status` loaded the run skill as before.
  - *Never run for real:* a real supervisor carrying a ticket on, bare `/mach-studio` and `/mach floor` in a real session (they open a browser), the plugin forms.
  - *Known and left:* a supervised run that removes `MACH_EXECUTION_ID` from its own environment can reset rounds (the same strength as the `--by-person` markers); `review.py` and `build.py` fall back to `cell.json` for the allowance when `rounds.py` cannot be loaded; a carry-on refused because the ticket moved leaves its guidance file in the cell; a locale with a 12-hour clock shows "02:00 PM" in the feed's narrow time column.
- **What 0.27.0 added.** `/mach-app` (`skills/app/`, script `skills/app/scripts/app.py`): one command that opens Product Studio, or the Factory Floor with `floor`, for the release installed in the project. The skill runs the script itself before the model replies (Claude Code's `!` line, `disable-model-invocation`, `allowed-tools` for that one command). The script asks the installer's new `mach programs` command to bring `.factory/bin/` to the installed release (the download and its checks stay in `bin/mach`), reads the running host's release from `host.json` beside its link, stops an older one only when its process is this project's own program, starts the host detached and opens the link. Tests cannot start a host (`MACH_APP_NO_START` is set by `tests/in_parallel.py`).
  - *Tried for real:* in a throwaway project installed from this checkout, `claude -p "/mach-app link"` started Product Studio 0.26.0 and gave its link in one turn, the link answered, and `/mach-app stop` stopped it. Earlier, with locally built hosts: start, reuse, an older host replaced after a checked download, a killed host's lock taken over, the Factory Floor.
  - *Not tried:* the command with nothing after it in a real session (it opens a browser), the plugin form `/mach:app`, `xdg-open` on Linux, an older program replaced by a real download from GitHub.
  - *Also in 0.27.0: joining a project from GitHub.* A workspace with no project takes the whole published project by itself (`skills/studio/scripts/from_github.py` is the one reader, used by export, by `join.py` / `project join` and by refresh; slices are written by `slice take`'s writer). `status` never reads GitHub: it answers the next action `join_project`, the app's home starts the join (`project.join`, in batches, with progress) and the terminal's first step is `refresh`. Each slice keeps one `base` in `.factory/studio/issues.json` (the digests and revision this workspace and GitHub last agreed on), written only by `Handoff.record_version`; "unchanged here" means the files still match it. A workspace from before this gets a base on first use (`join.adopt_bases`).
  - *How joining was checked:* an agent that wrote none of the code ran it on the stand-in four times (a fresh clone compared file by file with the author's workspace; two product managers for four rounds each way; interruptions; a local project never saved; an unfinished import; workspaces written by older code) and its findings were fixed each time; joins and refreshes made no GitHub writes in any run. The trial folders were in the session's scratch folder and are gone.
  - *Never run for real:* real GitHub (speed on a large project: a first join reads 9 + 2N issues and comments for N slices, a refresh 9 + N), the joining screen and the "From GitHub" panel in a browser after the last two rounds of fixes, two browser windows during a join.
  - *Known and left:* Product Studio never fetches, so pictures and nothing else on the main branch arrive only after the person pulls; refresh still reads each held slice's comments every time (skipping by `updated_at` needs the test stand-in to move it); a person's own renumbered draft principles show ready slices as unanswered for them, as for any principle added later; `replaced list` / `restore` have no screen in the app.
  - *To know:* the host now outlives the Claude Code session. A host from before 0.27.0 writes no `host.json`, so it always counts as older and is replaced once.
- **What 0.26.0 added.** The owner's rule (section 4, "Never block a person") built into MACH: the invariant in `docs/BLUEPRINT.md`, the rule at the top of the run, intent and studio skills, and `tests/test_never_blocked.py` and `tests/test_never_blocked_studio.py`, which scan every sentence the stations and apps print.
  - *How a person is told from the Factory:* a take-over happens only with an explicit marker the skill passes when a person named the ticket (`next --by-person`, `schedule --named`, `product dispatch --by-person`, `cell.py claim --by-person`, `merge --by-person`); each is refused when `MACH_EXECUTION_ID` is set. A run that strips that variable and passes the marker is taken for a person, as before this work.
  - *After a take-over:* the displaced holder is in the cell's `displaced.json` and refused at every station; a displaced supervised execution is ended (`taken-over-by-person`, no attempt counted) and the slice's owner becomes the engineer; uncommitted files of a build or revise step are kept under `refs/mach/cell-files/<ticket>/taken-over-<n>`. Nothing is undone afterwards: a commit made outside the stations is said once and recorded as a `commits-outside-stations` deviation for the reviewers. An earlier version that reset the branch was removed because it threw out a person's own commits and the lanes join.
  - *A slice taken over from another Factory* builds on `feature/<issue>-<login>`. A person's merge of a second copy answers `ALREADY_ON_MAIN`, or `RECHECK` (verified and reviewed again, then landed with "Another copy landed first" in the change record).
  - *Product Studio:* kept versions are under `.factory/studio/replaced/`; a slice opened without approval is recorded `not_approved`.
  - *How it was checked:* an agent that wrote none of the code ran the flows on the tests' stand-ins three times (two Factories on one slice, same-machine take-overs by a belt and by a supervised execution, two people alternating, every formerly refused Product Studio act) and its findings were fixed each time. `make check` on Homebrew's Python (3,064 tests, 1 skipped), `make test` on Apple's 3.9 with no `claude` on the PATH, `go test ./...` in both apps, web typecheck, lint, build and unit tests (376 and 483).
  - *Never run for real:* two real machines, a real supervisor ended by a take-over, real GitHub with two pull requests for one issue, anything in the Factory Floor or the Product Studio app looked at on a screen.
  - *Known and left:* the other machine's Factory is not stopped by a take-over and keeps building its copy; a commit made by hand while a station call is running is not warned about; `replaced list` and `restore` have no screen in the app; running a station by hand on a ticket someone holds takes one extra step (`next --by-person --holder new`); two specs that already share a slice number on main are warned about, not separated; some app fixtures keep "refused-..." names but hold successful runs; MACH never posts another person's idea verdict as a comment in their name (the idea is published without it).
- **What 0.25.0 added.** Moving a project as it was (`docs/mach-next/M21_EXPORT_IMPORT.md`, "As built" and "Moving a project as it was"): export reads from GitHub what the workspace lacks and never changes the workspace; `was_ready` and `not_assessed` in the archive's `facts.json`; the importer's "Not assessed" rows vouched by its records, the ships-first rule for effects, renumber-and-carry-on, `project import --ready` and `project imports ready`; "Move this project" in the app (`apps/studio/internal/engine/ops_move.go`, `web/apps/product-studio/src/features/move/`).
  - *How it was checked:* three real end-to-end runs on the tests' stand-in for GitHub by an agent that wrote none of the code (`export-trial`, `export-trial2`, `export-trial3` in the session's scratch folder, not kept): author's machine to an empty repository, to a repository with its own project, and from a second machine via GitHub to both; a joined project moved again; kills at many points; the Factory's intake and dispatch of an imported slice. The last run's verdict was that all three moves work as one step. `make check` on Homebrew's Python (2,960 tests, 1 skipped), `make test` on Apple's 3.9 with no `claude` on the PATH, `go test ./...` in both apps, web typecheck, lint, build and unit tests (371 and 480).
  - *Never run for real:* real GitHub, a real second machine, the Factory building an imported slice, the operating system's file chooser in the app, a joining import or a stopped import looked at in the app, a file near the size limits.
  - *Known and left:* importing a project back into the repository it came from makes copies (there is no identity across a move); Jira links do not travel, and a key read from GitHub may be reported against a slice when it is its epic's; ideas published on GitHub are not rebuilt on a second machine; issue lists other than export's are still cut at 1,000 per label with no warning (`handoff.read`, `shape.py`, the import's count of numbers in use); a principle cannot be renumbered, so nothing was done for that.
- **The release workflow's flaky test, found 2026-11-26:** the 0.24.0 and 0.27.0 build jobs each failed once in `apps/studio/internal/interview` (`TestAnIdeaConversationRunsWithItsOwnRulesAndRecords`, then `TestThePrdConversationRunsWithItsOwnRulesAndRecordsTheMap`) with two `draft_changed` events where one is expected, and passed when run again. The cause was the test's stand-in for Claude Code (`internal/testkit/fakeclaude.go`): it opened the draft file, which emptied it, and then wrote it, so the host could read it empty and then full and report one change as two. The stand-in now writes the file elsewhere and moves it into place. The host is unchanged: a real tool that writes in two steps can still be reported twice, which only refreshes the screen twice.
- **What 0.24.0 added** (the release notes have the list for people):
  - *One pull, and decisions where the person is* (`docs/mach-next/M23_ONE_PULL.md`, the design; the code is right where they differ). `/mach pull` hands the batch to the supervisor with no enabling step; that supervisor is tied to the Claude Code session (`service.find_session_pid`) and stops its runs when it ends; `/mach factory start` runs one in the background; `run.py decide do` records a decision (`skills/run/scripts/act.py`); the Factory Floor's observer runs `run.py` from one package (`apps/observer/internal/act`) to record decisions and stop the Factory.
  - *Building in lanes* (`docs/mach-next/M22_PARALLEL_BUILD.md`), default three.
  - *Export and import of a project* (`docs/mach-next/M21_EXPORT_IMPORT.md`).
  - *Verification without a browser* (`skills/verify/scripts/browser.py`): verify checks whether a browser can start where it captures, and where none can it requires headless evidence instead of screenshots and says so in its results, the review packet, the change record and `/mach explain`; `verify.screen_evidence` is `prefer`, `require` or `never`. The commands it tries and the failure messages it recognises were never run against a real browser or a real sandbox. `/mach doctor` notes it for web projects only.
  - The installer's sandbox and tickets settings, package caches under `.factory/cache/`, the audit that stays good, no archive by default, the stuck-build fixes, and the Factory Floor's finished shelf, record age and lost-ranges list.
- **The owner's decisions of 2026-11-24, which replace two older rules:** nothing stands between a person and the supervisor starting; the Factory Floor may record decisions and stop a Factory; Low and Medium merge on their own; no spending limit unless set; a pull's supervisor stops with Claude Code, and `/mach factory` is the background one.
- **Checks at release:** `make check` on Homebrew's Python (2,890 tests, 1 skipped) and `make test` on Apple's 3.9 with no `claude` on the PATH, `go test ./...` in both apps, web typecheck, lint, build and unit tests (352 and 480).
- **Never run for real, any of it:** no real supervisor, no real `claude -p`, no real Claude Code session ending, no real project behind the Floor's decisions, no real sandbox or package manager, no lanes with real builders, no export between real repositories. First things to try by hand: `/mach pull` in a real project, then quit Claude Code and see the work stop and the next pull carry on; the same from the Desktop app (does MACH find the Claude Code process: `factory status` shows `session_pid`); `/mach factory start`, then Stop from the Floor; an approval made in the Floor.
- **Known and left:**
  - The Floor shows the findings to read before an approval as file paths, not inline.
  - The observer drops every `GIT_*` variable from what it runs, so a merge from the Floor that needs `GIT_SSH_COMMAND` to push may fail.
  - `--via` on `decide do` is a label any caller can give; it is not a check.
  - Pull does not test-run Claude before handing over (`factory start` does). A Claude Code missing a needed flag fails each run and the ticket then waits for a person.
  - `factory stop --execution <id>` still holds that one ticket for a person, since the Factory keeps running.
  - The supervisor does not guard against the session's process number being reused.
  - Export/import: no button or upload in the app; `cell.slice_ids` does not see numbers an unfinished import holds.
  - Agent worktrees under `.claude/worktrees/` and their branches, and the merged branches `feature/project-export-import`, `fix/worktree-config`, `feature/parallel-build`, `integration/next`, are still there to clear away.
- **What 0.23.2 added:** fixes for two faults the owner met in Product Studio's app.
  - *Naming the product* asked for a Project ID, proposed one from the name, and could then refuse its own proposal. The form no longer has the field: MACH makes the ID from the name (`product.project_id_from`), and `project init --id` is optional.
  - *The check of GitHub* was tried once, said only "GitHub could not be reached", was counted as something "not saved", and stayed until a manual refresh. Now a read is tried again (with a budget, so a command stays inside the host's time limit); a failure is named as what it is (no network, GitHub's limit, GitHub not answering, something on the computer blocking the tool, the sign-in, a refusal) with the GitHub tool's own words; it is its own notice (`saved.github_check`, "GitHub not checked" in the top bar) and never counted as unsaved; and the app checks again by itself, backing off from one minute to fifteen.
  - *Not known:* what actually failed on the owner's machine (repository `cof-sandbox/...`, a last good read at 08:01 and failures after it). The old message hid the tool's words. With this change the notice quotes them; a corporate proxy or a Claude Code sandbox around the app's host are the likely causes to check first.
  - The app's fixtures were regenerated from MACH's own output (`web/fixtures/generate.py`), which also brought in keys added since they were last generated.
- **What 0.23.1 added:** Product Studio's command is `/mach-studio` (plugin: `/mach:studio`), renamed from `/mach-product-studio`. The skill's folder is `skills/studio`; the product is still MACH Product Studio, and the web app's folder and package keep their names.
- **What 0.23.0 added:** Decisions in force, a read-only page on the Factory Floor for architecture decisions.
- **What 0.22.1 added:** a sign of life for slow builds, the merge plan's two refusals, the "Unattended runs: off" label, five layout items and four defect fixes (section 2.3).
- **What 0.22.0 added:** qualifying a release on any machine, from each slice's committed change record (A6 of the M20 design).
- **What 0.21.0 added:** MACH for a team (Part A of the M20 design, except A6), the basic decisions drafted from an engineer's own documents, a ticket's workspace that holds no `.claude/` files, and a plain message when MACH's files are from different versions. The release notes are `docs/guides/RELEASE_NOTES_DRAFT.md`.
- **Checks at release:** `make check` (2,174 tests, 1 skipped), `go test ./...` in both apps, and the web typecheck, lint, build and unit tests (352 and 409) all passed on the release commit.

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

Built on 2026-11-23 and released in 0.22.1:

- The four defects section 3 used to list: stations run the project's commands with `PYTHONDONTWRITEBYTECODE=1`; `verify.py capture` takes its driver's arguments after `--` on every Python; the tests no longer depend on the date they started on, on where a Python keeps its byte code, or on `tomllib`.
- `merge.py plan` lists the two refusals (already shipped; slice number already on main).
- A slow build that keeps moving keeps its claim: a sign of life on the slice's issue (`ticket.py slice-alive`, called from intake's recorded plan). It is posted from intake, dispatch, reconcile, `/mach pull` and the supervisor, not from `run.py next` alone or from the read-only `product plan` and `product status`.
- The Factory Floor's chip reads "Unattended runs: off".
- Five of the open layout items in `docs/mach-next/M16_LAYOUT.md` section 6; what is left there is left on purpose, each with its reason.

Still open:

- **Never run for real:** the team rules (a real second person and machine), the workspace change under Claude Code's real sandbox, the documents route in a live session (the mapping step), the app's team screens against the live host, the sign of life against real GitHub. The owner is doing these.
- **Not looked at on a screen:** the layout changes and the new chip were checked by typecheck, lint, build and unit tests only. The screens to look at are listed in what the lead told the owner on 2026-11-23: the Factory Floor's top bar with unattended running off; any long Product Studio pane for the "More below" line; Vision and outcomes; a slice's "From the PRD" page; the "ready to build" dialog; Shape pages opened with `?idea=` or `?map-status=`.
- **Decisions in force** (the engineer's page in the browser for architecture decisions): released in 0.23.0 as a fourth workspace on the Factory Floor (key `4`), read-only. It reads the ADR folder as it is on disk in the main checkout (the observer reads no Git history), shows live tickets only, and says "a person" where a name was recorded. Not looked at on a screen. What it does is in the blueprint's Factory Floor section and the style guide's section 12.3.
- **A fourth film** (Jira, bringing in a PRD) is pinned: the owner said "not yet" again on 2026-11-23.

Done on GitHub: the defect report `swiftj/mach-harness#1` is closed, and the owner deleted the two throwaway transfer-test repositories.

## 3. Setting up a new machine

Needed to run every check: Git 2.36 or later, Python 3.8 or later, Go, Node with pnpm (`pnpm install --frozen-lockfile` in `web/`), and the GitHub CLI (`gh`) signed in.

```bash
git clone https://github.com/swiftj/mach-harness.git
```

Then, from the clone: `make check`; `go test ./...` in `apps/studio` and in `apps/observer`; in `web/`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --filter @mach/product-studio test` and `pnpm --filter @mach/factory-floor test`.

On macOS, `python3` is Apple's 3.9 unless another is first on the PATH. The Python tests pass on both (checked on 3.9.6 and Homebrew's 3.15.2), with no environment variable needed; on a Python before 3.11 three tests that read TOML manifests are skipped, because MACH lists those files without reading them there.

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
- `/mach pull` starts the Factory with no enabling step (the owner, 2026-11-24). A project can forbid it (`factory.supervisor: false`); nothing in a repository can widen what a machine allows. Do not bring back a confirmation, a code or a default spending limit.
- Every MACH service binds to localhost only. The Factory Floor records a person's decisions and stops a Factory, through MACH's own command; it never starts or enables one.
- Never block a person (the owner, 2026-11-25): when another person, Factory or conversation has the work, MACH warns who and since when and then does what was asked. It never refuses for that reason, never makes a take-over a second step, and never sends one person to ask another; overlap is settled at the merge or the pull request. The Factory choosing work by itself still keeps out of others' way.
- Never abandon or start over (the owner, 2026-11-27): a stopped ticket is carried on with a targeted fix on the work already done. MACH never proposes abandoning, building a slice again from the start, or the person fixing a branch by hand; abandoning happens only on the person's own word, and then it deletes rather than archives. A person's start gives every ticket a fresh set of rounds; the Factory's own unattended passes do not. The two apps open with bare `/mach-studio` and `/mach floor`. The apps show dates with times.
- Trust the person: record a choice rather than forbid it, never leave a state with no way forward, never suggest abandoning work for something a setting fixes.
- No weakening of Claude Code's safety controls, and no silent weakening of security review.
- No fabricated Factory events or metrics.

## 5. A release, step by step

1. Set the version in `.claude-plugin/plugin.json`, and in `README.md` (the status line and the install example).
2. Add "What changed in <version>" at the top of `docs/guides/RELEASE_NOTES_DRAFT.md` and change its title.
3. Run every check in section 3 on that commit.
4. On the owner's word: merge to `main` with `--no-ff`, push, tag `v<version>`, push the tag.
5. The `release` workflow builds, smoke-tests three platforms and publishes. Confirm the release is published and marked latest.

# Engineer Guide

For an engineer who installs MACH, takes in approved product work and decides what may run on their machine: Product Studio, intake, the supervisor, the Factory Floor and release qualification. Nothing here claims readiness for regulated or enterprise production use. For the security detail, see `OPERATOR_SECURITY_GUIDE.md`.

In the commands below, `RUN` means `python3 .claude/skills/mach/scripts/run.py --project .` in a script install. With the plugin, ask Claude Code to run the `/mach:run` skill; it uses the same script.

## 1. Installation and repository requirements

You need Claude Code, `git` and `python3` 3.8 or later. Install as a plugin (`/plugin marketplace add swiftj/mach-harness`, `/plugin install mach@mach-harness`, then `/mach:init` in each project) or with `install.sh` (script install, commands such as `/mach`). `--dry-run` shows what would change. Install again to update in place. `python3 .factory/bin/mach uninstall` removes only what the manifest lists, and keeps files you changed and everything under `.factory/` that is state.

A missing Git or Python stops the installer with a message that names `xcode-select --install` on a Mac. Python 3.8 is the stated minimum. Only 3.9.6 and 3.15 were run.

**Which version, and what the installer checks.** The one-line installer installs a release, not the `main` branch: the newest full release, or a specific one with `MACH_VERSION=<x.y.z>` (a release candidate is `MACH_VERSION=<x.y.z>-rc.N`, since a candidate is a pre-release and the default never picks one). It downloads that release's source archive and `SHA256SUMS` over HTTPS, compares the archive's SHA-256 and, if `gh` is installed and signed in, runs `gh attestation verify` on it, all before any downloaded code runs. The two prebuilt programs (`mach-studio`, `mach-observer`) get the same two checks. Anything that fails is refused, nothing is installed and the downloads are removed; there is no fallback to an unchecked source. If `gh` is missing the install goes ahead and the note says provenance was not verified; `MACH_REQUIRE_PROVENANCE=1` refuses instead. Installing a branch (`MACH_REF=<branch>`) or a local copy (`MACH_SOURCE=<path>`) is possible only by that explicit choice and the note says the source was not verified. Releases up to v0.12.0 have no source archive, so they install with a note that the source was not verified. Programs exist for darwin/arm64, linux/arm64 and linux/amd64, none for Intel Macs or Windows. They are ad hoc signed and **not notarised**: a program downloaded through a browser carries macOS's quarantine mark and is blocked on first run until you allow it. The installer's own download leaves no such mark, and its checksum and attestation checks are the protection. What is not checked: `install.sh` itself, which is fetched from `main`. You trust the script you ran. Only the rc.2 candidate was verified against GitHub, through a patched copy of its installer; the current candidate's installer has not yet been checked there.

### The audit and its tiers

Autonomous work needs a repository that builds, tests and lints cleanly. `/mach-audit` scores five areas out of 100 and writes `.factory/audit-report.json`.

| Tier | Score | Effect |
|---|---|---|
| Gold | 90 to 100 | Full autonomy permitted. |
| Silver | 70 to 89 | Building permitted; a person must approve every change before merge. |
| Bronze | under 70 | Autonomous work blocked. Only `repo-hardening` tickets build. |

A build or test suite that fails, is missing or cannot be run is Bronze whatever the score. The report goes stale after `audit.max_age_days` and is bound to a commit. The secret-scanning check only looks for a scanner's name in configuration. It runs no scanner (2 of 100 points).

## 2. Product intake, plan and dispatch

**The one command: `/mach pull`** (`RUN pull [--limit n] [--sequential] [--dry-run]`). It takes in every slice marked ready, picks the next batch with the schedule's rules (dependencies merged first, the product manager's order within an epic, oldest ready first; never more than `factory.max_parallel`, at most `factory.max_parallel_high` High-risk, no two tickets whose plans touch the same file, a ticket another worker holds left to it), dispatches the slices it picked, and prints what starts now, what waits and why, what was not accepted, what waits for you, and the tickets to run. Tickets already in the line count against the limit and are carried on in the same run. The skill then runs them (the belt workflow for several, in the conversation for one) and walks you through what waits for you. `--dry-run` changes nothing. It is refused inside a supervised execution and enables nothing. The `product` commands below remain for looking and for doing one step.

Slices product managers marked ready in Product Studio are taken in through `RUN product ...`. A slice arrives as a GitHub issue (`mach:slice` and `mach:ready`) in the repository the `origin` remote names, or, without GitHub, as a `product/ready/SLICE-NNN/` folder committed on the integration branch, or as a folder handed to you (`product import <folder>`). Nothing runs unless you say so, or a supervisor you enabled on this machine.

- `product status` and `product plan` only read. Status shows each slice marked ready (`new`, `known`, `modified`) and everything `not_accepted` with its reason in plain words. Plan lists every slice as `completed`, `active`, `ready` or `blocked`, with reasons, and the order they go in.
- `product intake` takes each new slice revision in once. `--dry-run` first. A slice from GitHub is its own ticket: the issue number names the ticket, the cell, the branch and the pull request (`/mach 41`). A folder gets one local ticket. Repeating it takes nothing in twice.
- An issue counts only when the last person who added `mach:ready` has the triage, write, maintain or admin role, wrote an unedited approval comment for that revision and those hashes, the body is intact, the epic's issue is Product Studio's, and the spec passes the intent gates. This guards against accidents and edits, not against someone with write access who sets out to forge an approval.
- A slice waits until what it depends on is merged (its commit on the integration branch); then the product manager's order within the epic; then the oldest marked ready. An approved cell is still `active`, and dependents stay blocked.
- `product dispatch <SLICE-ID or issue number>...` or `--ready` opens the cells, commits each spec on its ticket's branch with a header line naming its epic and issue, and stops at `spec-ready`. It starts no agent. Product-sourced work is never reviewed below Medium.
- `product reconcile` is intake plus a recorded plan plus the status writes. It never dispatches.

### What the slice's issue is told

Through `ticket.py slice-status`, from fixed templates with a hidden marker, recorded in the ledger before they are tried and retried on the next pass; they never block the line: `mach:building` when the cell opens; `mach:question` with the contract engineer's question (redacted, bounded, mentioning nobody) when the spec has a defect only the product manager can settle; `mach:shipped`, and the issue closed, once its merge is on the integration branch; a comment when the cell is blocked; and a comment when the slice changed while it was being built. `tickets.github.status_comments: false` stops the comments and keeps the labels. The Factory writes nothing to a request's issue.

### When a slice changes

- Waiting work takes the new revision on the same ticket.
- Work in the line is never changed: it is flagged for you. Let it finish (the new revision follows on the same ticket once it ships), or abandon it with the cleanup station and the next intake takes the new revision.
- A cell stopped for the product manager's answer (`needs: product-answer`) takes the new revision and plans again.
- Shipped work changed comes as a new issue that says `Changes #N, which has shipped.`
- `product intake --reissue <SLICE-ID>` puts abandoned work back in the queue on the same ticket, only when you say so.

**Re-planning a wrong plan.** `cell.py replan <ticket> --reason "<why>"` (the intent station's script), only when you say so, returns a `planned` or `building` cell to `spec-ready` so the line plans it again. Nothing is lost: the old `plan.md`, `build.json` and `build-report.json` go under `plan-history/<n>/`, and if the branch had moved its old tip is kept as `refs/mach/replan/<ticket>/<n>`. It refuses a cell that has been through a judging round, uncommitted changes, task work already on main, and an empty reason. It adds no judging round. `RUN next` then says `plan`.

Open question from testing: nothing distinguishes a product manager's copy from an engineer's. A refused dispatch there was refused only because the copy had no intake ledger. `factory enable` ran its preflight and issued a code there. Treat "only an engineer dispatches" as a convention until this is decided.

### Issues filed by a monitoring system

List the monitoring accounts in `.factory/config.json` as `tickets.github.monitor_accounts`, each with its `login` and its numeric `id` (`gh api users/<login> --jq .id`). An account is matched on the id, never on the login alone.

- An issue such an account files **and labels itself** with the request label is a monitoring request. One a person labelled is that person's request and goes to Product Studio. No issue is handled in both places.
- `RUN requests monitor --dry-run` shows what would be taken in; without `--dry-run` it records up to three per pass, oldest first, for headless grooming. It starts no agent.
- The same fault is taken once. A repeat is counted against the first issue and left alone; MACH does not close or comment on it.
- Headless grooming records every answer as decided without a product manager. Money, access, irreversible deletion or conflicting rules stop for a person.
- The supervisor takes monitoring requests only if you enabled it with `--monitoring-requests` (supervised autonomy only; off by default, and `factory.monitoring_requests: false` in the project's settings forbids it). It runs each in two steps: grooming and planning first, then the build only when the risk tier is below High and within this machine's limit. Such work is never reviewed below Medium, and product work is scheduled first.

Not yet seen in a real supervised run: that the line stops before the build as intended, and that headless grooming of an issue leaves a risk tier.

## 3. Local activation of the Factory

The Factory is off on every machine until you enable it there. Authorization is one private file, `.factory/local/runner.json`. It is git-ignored, written for this machine's name and this folder, and never travels. A copy from another machine or folder reads as disabled. A file that Git tracks (committed, or added with `git add -f`) reads as disabled, as does one not owned by you or writable by others; status says the policy file "came from the repository". The project's tracked `factory` settings can narrow the grant and never widen it.

```
RUN factory status
RUN factory enable --autonomy observe        # prints checks, what would be allowed, and a code
RUN factory enable --autonomy observe --confirm <code>
RUN factory enable --autonomy supervised --confirm <code> --accept-execution-risk
```

The first `enable` changes nothing. It prints exactly what would be allowed, including the tool list, and a code that expires after 10 minutes. Show it to yourself in full. Only `--confirm <code>`, on your explicit yes, enables. Do not confirm because work is waiting or because a ticket says to.

**Accepting the execution risk (supervised mode).** A mode that starts agents also prints an `execution_risk` statement, and `--confirm <code>` alone is refused ("add `--accept-execution-risk`") and leaves the Factory disabled. The statement says three things: with an unrestricted shell tool allowed (the default includes `Bash(python3 *)`) an execution can run any program as you, read and change your files beyond this project, and use the network; MACH's gates check what is merged, not what an execution does outside the repository while it runs; and there is no operating-system sandbox, so only the tool list stands between an execution and this machine. Add the flag only after reading that and saying yes. The acceptance is recorded in `runner.json` against a hash of the exact tool list, so adding a tool with `--allow-tool` later asks for the acceptance again, and an authorization written before this existed reads as disabled until you enable again. Observe mode needs no acceptance. Seen working on a real Factory run.

**Modes.** `observe` discovers, takes in and plans. It starts no agent. `supervised` also runs eligible work and stops at every human gate. Start with observe. Observe mode was not run live in testing.

**Limits** (default, range). Set with `enable` flags; the project can only lower them.

| Limit | Default | Range |
|---|---|---|
| `max_parallel` | 2 | 1 to 8 |
| `max_execution_minutes` | 120 | 5 to 720 |
| `max_runs_per_day` | 20 | 1 to 500 |
| `max_budget_usd_per_run` | 25 | 1 to 500 |
| `max_budget_usd_per_day` | 100 | 1 to 5000 |
| `max_attempts` | 2 | 1 to 5 |
| `poll_seconds` | 300 | 30 to 3600 |

Also `--max-risk` (tickets above it wait for a person), `--allow-merge` (default off; every execution then stops before merge), `--allow-tool` (an extra tool, such as `Bash(make test)`), `--auto-sync`, `--hooks` and `--persistent` (a macOS per-user service). Each of the last three is its own yes.

**Controls.** `pause` starts nothing new; running work finishes. `resume` re-checks readiness first (`--retry <ticket>` for named tickets). `disable` revokes authorization here (`--stop` also ends running work). `stop` is the emergency stop: running executions end now, the Factory pauses and each outcome is recorded as unknown. Check each ticket before resuming it.

Enabling does not start a supervisor. Run `RUN factory serve` for the session, or use `--persistent`. `RUN factory tick` makes one pass.

**What a supervised execution may touch.** One execution works on the one ticket it was started for. Inside it, `RUN next`, `review-start` and `review-tally` for any other ticket are refused ("started for <ticket> only"), `status` lists only that ticket, and the belt starts no observe pass and no `factory-tuning` ticket. When an observe pass is due the supervisor starts nothing for it: it raises one `human.required` per count of finished tickets ("An observe pass is due: N tickets have finished since the last one") and you run the pass yourself. A person-started `/mach` or belt is unchanged. Observed live in a short run.

**A run that makes no progress is parked at once.** If an execution ends with the same refusal twice (a build stopped on the same task) or the belt reports `stuck` for the ticket, the supervisor records `not_progressing`, parks the ticket for a person and does not spend the remaining attempts ("Retrying would repeat it"). A killed execution (a signal, a negative exit code) is recorded as killed with its exit code and counts as a failed attempt; only a clean exit clears the count. The plan gate also refuses, at `cell.py check-plan`, a plan whose later `[impl]` task names a requirement that all of its tests already preceded, which is the plan that cannot go green. Observed live: the plan check refusing a real plan, a stuck belt parked at once (at the plan station, not a build) and a killed execution recorded as killed. The same-refusal build case has tests only. Where a parked ticket's plan is wrong, use `replan` above.

**One runner per project per machine.** An ownership lease with a heartbeat enforces that. Nothing coordinates two engineers' machines. Two clones on two machines can both enable. That is unsupported, and it was not tested on real separate machines.

## 4. Human gates

The scripts decide the order. These stay with a person:

- **High-risk approval.** The panel approves first; only then can `review.py approve-human` record a person's approval, on their explicit word and after seeing the findings. A person cannot approve over a rejection. A Silver tier also needs it.
- **The merge.** By default an unattended run stops before it. `merge.py --by-person` lifts only the merge mode and the per-tier setting. It still needs an approved stage, the commit review approved and any required human approval. A new commit voids the approval.
- **Open questions, escalation after three rounds** (`blocked-requires-sme`), and anything under `needs_person`.

The supervisor never: approves a high-risk change, answers an interview, merges unless you chose `--allow-merge` and the project's merge settings permit it, widens its own tools through its own commands, or retries a lost merge or cleanup. Its tool list has no `git push` or `gh`. Section 8 explains why that is not a hard barrier.

### The security review rule

A reviewer finding may carry `class: security` and an `impact` (critical, high, medium or low); the security seat's findings are security-class without saying so, and an `impact` without the class is refused. A blocker of class security with impact high or critical, from any seat, rejects the round at every risk tier whatever the vote count, and `review.security_veto: false` does not switch it off. In rounds 2 and 3 such a blocker may be raised on any file. There is no exception record: the only ways past it are a fix and a new round, escalation, or abandoning the ticket. The supervisor also refuses unattended work while tracked settings remove the security seat (`security_veto: false`, `reviewers: 1` for Medium or High, or `high.human_approval: false`), checked on every pass.

Still open: a blocker from a non-security seat that is not marked as security is outvoted at Medium as before, and Low tickets have no security seat.

## 5. The Factory Floor

Ask the run skill to "open the Factory Floor". It starts `mach-observer` (from `.factory/bin/` or a checkout's build) and gives you a one-time link to `127.0.0.1`. A second browser takes the link kept in `.factory/local/observer/link`. It is read-only: it enables, starts, pauses, dispatches, approves and merges nothing, takes no lock and runs no MACH script. Stopping it never affects the line.

Three workspaces: the **Atlas** (the Factory Atlas and the Execution Blueprint, keys 1 and 2), the **Timeline** (the Execution Timeline, key 3) and **Analytics** (key 4). It is labelled **Live Factory** when it reads this machine's state, and **Simulation** (invented work) when there is none.

"Held at an earlier moment" means the playhead sits behind the live edge, so Analytics counts only what was recorded up to that moment. Nothing recorded after it is read. `L` or `End` returns to live.

Known limits: a supervisor hold is prose with no reason code, so the Factory Floor cannot show it as a wait on a person. Repeated lifecycle lines are counted again. Analytics cost leaves out failed executions. A 240,000-event history switches between workspaces in 598 to 874 ms against a 300 ms budget. Names in free text are served, labelled (see the operator guide).

What the real supervised runs of M7 (a throwaway project, one Mac) showed and what was done about it. Seen again live after its fix: the plan check refusing a plan that cannot go green, a killed execution recorded as killed, a released claim left out of the execution counts, the release-readiness line following the acceptance record, a re-review after a voided approval kept in its own `round-N.k` folder, and the shared-contract rule in release qualification. Fixed afterwards with unit tests only, not re-observed on a page or in a live run: a killed execution reading "killed (exit code)" on the floor, the Timeline and the retries lens (it read "failed"); a "Parked: ..." reason for a build that stopped making progress; an abandoned ticket dropped from the waiting list ("Abandoned, reissued as ..."); the product state after a revision. Still open: Analytics cost leaves out failed executions, and a killed execution has no recorded cost, so real spend can be higher than shown ("a lower bound"); a repeated review round and a voided approval are **not shown on the Factory Floor page** (the observer serves them, the page does not word them); an abandoned cell's tile still shows its last stage word, though its mast and inspector say Abandoned; a supervisor restart has not been checked on the page.

## 6. Recovering an interrupted run

Every execution is written as `claimed` before any process exists. A restarted supervisor tells these apart:

| Situation | What happens |
|---|---|
| Claimed, never started | The claim is released. Nothing ran. |
| Still running | Adopted. Not started again. |
| Ended while unwatched | Closed from its result file and the cell's records. |
| Outcome unknown | See below. |
| The line says stop, or the ticket is parked | Left for a person. |

For an unknown outcome the cell's stage is compared with the stage at the start. If stations recorded progress, it stands. If nothing moved and the station was **merge or cleanup, the ticket is parked for a person and never retried automatically**. Otherwise it counts as a failed attempt, up to `max_attempts`, and then the ticket is parked. No exactly-once guarantee is made: an interrupted station may repeat work it had not recorded. This was tested with stand-ins and also seen live: a supervisor killed with SIGKILL and restarted adopted both running executions and dispatched nothing twice; a killed execution was retried and finished. **Not seen live:** a machine reboot or loss of the network during an execution.

The line itself is driven by what stations recorded, so running `RUN <ticket>` again resumes where it stopped.

## 7. Release qualification

`RUN release status` lists snapshots. `RUN release qualify --epic <EPIC-ID or issue number> | <SLICE-ID>... [--release <id>] [--commit <sha>]` evaluates an epic, or the slices you name, on the integration branch at one commit and writes `.factory/release/<id>/readiness.json`. It reruns the project's test suite on a clean tree, which runs the repository's own code. `RUN release show <id>` prints the checks.

Four outcomes:

1. **blocked**: a check failed, or a review blocker is open, with no exception.
2. **incomplete**: a required check is missing, not run or not configured, with no exception.
3. **qualified_with_exceptions**: everything else passed, but a person recorded an exception.
4. **qualified**: every check passed.

A missing check is never a pass. No scanner report means `not_run`, which makes the result `incomplete`. An exception is recorded only on a person's explicit word, after they have seen that check: `RUN release except --release <id> --check <check-id> --by <role> --reason "<text>"`. Use a role, never a name. It counts only at the commit it was recorded for; qualify again afterwards. Qualification ships, merges, tags and deploys nothing. Product's acceptance is separate: the product manager records it as a comment on the epic's issue, and the snapshot reports it (`accepted`, `rejected` or `not_recorded`) only from a comment written by the account it names, unedited, with the triage role or above.

Scanners are not run by MACH. Someone runs them and puts their reports under `.factory/release/scans/<name>.json` for the exact commit. A report counts as a scan only if it carries every fact MACH needs to judge it: `tool`, `version`, `commit` (the release commit), `exit_code`, `scanned` (a number greater than zero), `scanned_at` and `findings` (each with `id`, `severity`, `title`; `critical` or `high` fail). One example, a clean gitleaks run:

```json
{"tool": "gitleaks", "version": "8.18.4", "commit": "<40-hex release commit>", "exit_code": 0, "scanned": 214,
 "scanned_at": "2026-11-14T10:00:00Z", "findings": []}
```

A report that lacks a field is `not_run` with "report lacks <field>"; so is one that records an `error`, an exit code other than 0 (clean) or 1 (findings found), or `scanned` of 0. A scanner that found nothing to read (osv-scanner on a project with no dependency manifest exits 128) must be written down as exactly that, not as an empty list of findings, or a false "clean" results. This is stricter than earlier versions: an older report without these fields is now `not_run`.

**The outcome line.** `qualify` prints a one-line outcome that names every check that is missing, not run or not configured, required or optional, with its reason, whatever the outcome, for example `qualified; not assessed: performance (not configured)` or `incomplete; not assessed: security.scan.osv-scanner (not run: report lacks scanned)`. Read it before you read the word qualified. Optional checks (performance with no command) never change the outcome and are never hidden. The record is deterministic: the same inputs give the same bytes. Qualification across five slices of one delivery, including slices that share one contract file, was run live (before M11, as a wave) and gave `qualified`; a sixth slice's scanner report with zero sources gave `incomplete`. The new report format and the outcome-line wording were checked by tests only.

## 8. Security boundaries in brief

- Local services bind `127.0.0.1` only and need a one-time link.
- An unattended run gets an explicit tool list, a spending cap and a time limit, and nothing else.
- That list includes `Bash(python3 *)`. A prompt injection that succeeds could therefore run arbitrary code as you. There is no operating-system sandbox. Read the operator guide before enabling supervised mode on a machine with credentials you care about.
- Build, test and verify commands run the repository's own code with your privileges.
- Credentials: nothing in a key, token or secret-like environment name reaches an unattended run.

See `OPERATOR_SECURITY_GUIDE.md`.

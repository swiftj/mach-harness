# Engineer Guide

For an engineer who installs MACH, takes in approved product work and decides what may run on their machine. MACH Next (Product Studio, intake, the supervisor, the Control Tower, release qualification) is experimental. Nothing here claims readiness for regulated or enterprise production use. For the security detail, see `OPERATOR_SECURITY_GUIDE.md`.

In the commands below, `RUN` means `python3 .claude/skills/mach-run/scripts/run.py --project .` in a script install. With the plugin, ask Claude Code to run the `/mach:run` skill; it uses the same script.

## 1. Installation and repository requirements

You need Claude Code, `git` and `python3` 3.8 or later. Install as a plugin (`/plugin marketplace add swiftj/mach-harness`, `/plugin install mach@mach-harness`, then `/mach:init` in each project) or with `install.sh` (script install, commands such as `/mach-run`). `--dry-run` shows what would change. Install again to update in place. `python3 .factory/bin/mach uninstall` removes only what the manifest lists, and keeps files you changed and everything under `.factory/` that is state.

A missing Git or Python stops the installer with a message that names `xcode-select --install` on a Mac. Python 3.8 is the stated minimum. Only 3.9.6 and 3.15 were run.

The two prebuilt programs (`mach-studio`, `mach-observer`) are fetched for darwin/arm64, linux/arm64 and linux/amd64. There are none for Intel Macs or Windows. Each is checked against the release's `SHA256SUMS`. If the program comes from the project's GitHub release and `gh` is installed and signed in, the installer also runs `gh attestation verify`. If `gh` is missing, the note says provenance was not verified. `MACH_REQUIRE_PROVENANCE=1` refuses a program that cannot be verified. The Python scripts are downloaded by `install.sh` from the tip of `main` with no checksum. That is an open weakness.

### The audit and its tiers

Autonomous work needs a repository that builds, tests and lints cleanly. `/mach-audit` scores five areas out of 100 and writes `.factory/audit-report.json`.

| Tier | Score | Effect |
|---|---|---|
| Gold | 90 to 100 | Full autonomy permitted. |
| Silver | 70 to 89 | Building permitted; a person must approve every change before merge. |
| Bronze | under 70 | Autonomous work blocked. Only `repo-hardening` tickets build. |

A build or test suite that fails, is missing or cannot be run is Bronze whatever the score. The report goes stale after `audit.max_age_days` and is bound to a commit. The secret-scanning check only looks for a scanner's name in configuration. It runs no scanner (2 of 100 points).

## 2. Product intake, plan and dispatch

Approved waves that product managers published and engineering merged are taken in through `RUN product ...`. Nothing runs unless you say so.

- `product status` and `product plan` only read. Status shows waves (`new`, `known`, `modified`, `superseded`, `already_integrated`) and anything refused with reasons. Plan lists every slice as `completed`, `active`, `ready`, `blocked` or `superseded`, with reasons.
- `product intake` files one ticket per new slice revision. `--dry-run` first. It reads Git objects at the merged integration commit only, re-checks each spec against its approved SHA-256, and files nothing twice. Repeating it creates nothing new (seen in a test).
- A slice is `completed` only when its commit is on the integration branch. An approved cell is still `active`, and dependents stay blocked.
- `product dispatch <SLICE-ID>...` or `--ready` opens the cells and stops at `spec-ready`. It starts no agent. Product-sourced work is never reviewed below Medium.
- `product reconcile` is intake plus a recorded plan. It never dispatches.

A changed definition under work in progress, a withdrawn slice, an abandoned ticket or a ticket claiming a merge not on the branch is `needs_person`. MACH reports it and does not choose.

Open question from testing: nothing distinguishes a product manager's copy from an engineer's. A refused dispatch there was refused only because the copy had no intake ledger. `factory enable` ran its preflight and issued a code there. Treat "only an engineer dispatches" as a convention until this is decided.

## 3. Local activation of the Factory

The Factory is off on every machine until you enable it there. Authorization is one private file, `.factory/local/runner.json`. It is git-ignored, written for this machine's name and this folder, and never travels. A copy from another machine or folder reads as disabled. A file that Git tracks is refused at HEAD, as is one not owned by you or writable by others. The project's tracked `factory` settings can narrow the grant and never widen it.

```
RUN factory status
RUN factory enable --autonomy observe        # prints checks, what would be allowed, and a code
RUN factory enable --autonomy observe --confirm <code>
```

The first `enable` changes nothing. It prints exactly what would be allowed, including the tool list, and a code that expires after 10 minutes. Show it to yourself in full. Only `--confirm <code>`, on your explicit yes, enables. Do not confirm because work is waiting or because a ticket says to.

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

**One runner per project per machine.** An ownership lease with a heartbeat enforces that. Nothing coordinates two engineers' machines. Two clones on two machines can both enable. That is unsupported, and it was not tested on real separate machines.

## 4. Human gates

The scripts decide the order. These stay with a person:

- **High-risk approval.** The panel approves first; only then can `review.py approve-human` record a person's approval, on their explicit word and after seeing the findings. A person cannot approve over a rejection. A Silver tier also needs it.
- **The merge.** By default an unattended run stops before it. `merge.py --by-person` lifts only the merge mode and the per-tier setting. It still needs an approved stage, the commit review approved and any required human approval. A new commit voids the approval.
- **Open questions, escalation after three rounds** (`blocked-requires-sme`), and anything under `needs_person`.

The supervisor never: approves a high-risk change, answers an interview, merges unless you chose `--allow-merge` and the project's merge settings permit it, widens its own tools through its own commands, or retries a lost merge or cleanup. Its tool list has no `git push` or `gh`. Section 8 explains why that is not a hard barrier.

### The security review rule

A reviewer finding may carry `class: security` and an `impact`. A blocker of class security with impact high or critical, from any seat, rejects the round at every risk tier whatever the vote count, and `review.security_veto: false` does not switch it off. In rounds 2 and 3 such a blocker may be raised on any file. There is no exception record: the only ways past it are a fix and a new round, escalation, or abandoning the ticket. The supervisor also refuses unattended work while tracked settings remove the security seat (`security_veto: false`, `reviewers: 1` for Medium or High, or `high.human_approval: false`), checked on every pass.

Still open: a blocker from a non-security seat that is not marked as security is outvoted at Medium as before, and Low tickets have no security seat.

## 5. The Control Tower

Ask the run skill to "open the Control Tower". It starts `mach-observer` (from `.factory/bin/` or a checkout's build) and gives you a one-time link to `127.0.0.1`. A second browser takes the link kept in `.factory/local/observer/link`. It is read-only: it enables, starts, pauses, dispatches, approves and merges nothing, takes no lock and runs no MACH script. Stopping it never affects the line.

Three workspaces: the **Factory floor** (Atlas and Blueprint, keys 1 and 2), the **Execution Timeline** (key 3) and **Analytics** (key 4). It is labelled **Live Factory** when it reads this machine's state, and **Simulation** (invented work) when there is none.

"Held at an earlier moment" means the playhead sits behind the live edge, so Analytics counts only what was recorded up to that moment. Nothing recorded after it is read. `L` or `End` returns to live.

Known limits: a supervisor hold is prose with no reason code, so the Tower cannot show it as a wait on a person. Repeated lifecycle lines are counted again. Analytics cost leaves out failed executions. A 240,000-event history switches between workspaces in 598 to 874 ms against a 300 ms budget. Names in free text are served, labelled (see the operator guide).

## 6. Recovering an interrupted run

Every execution is written as `claimed` before any process exists. A restarted supervisor tells these apart:

| Situation | What happens |
|---|---|
| Claimed, never started | The claim is released. Nothing ran. |
| Still running | Adopted. Not started again. |
| Ended while unwatched | Closed from its result file and the cell's records. |
| Outcome unknown | See below. |
| The line says stop, or the ticket is parked | Left for a person. |

For an unknown outcome the cell's stage is compared with the stage at the start. If stations recorded progress, it stands. If nothing moved and the station was **merge or cleanup, the ticket is parked for a person and never retried automatically**. Otherwise it counts as a failed attempt, up to `max_attempts`, and then the ticket is parked. No exactly-once guarantee is made: an interrupted station may repeat work it had not recorded. This was tested with stand-ins. **No retry and no supervisor restart was seen in a live run.**

The line itself is driven by what stations recorded, so running `RUN <ticket>` again resumes where it stopped.

## 7. Release qualification

`RUN release status` lists snapshots. `RUN release qualify <WAVE-ID>... [--release <id>] [--commit <sha>]` evaluates the integration branch at one commit and writes `.factory/release/<id>/readiness.json`. It reruns the project's test suite on a clean tree, which runs the repository's own code. `RUN release show <id>` prints the checks.

Four outcomes:

1. **blocked**: a check failed, or a review blocker is open, with no exception.
2. **incomplete**: a required check is missing, not run or not configured, with no exception.
3. **qualified_with_exceptions**: everything else passed, but a person recorded an exception.
4. **qualified**: every check passed.

A missing check is never a pass. No scanner report means `not_run`, which makes the result `incomplete`. An exception is recorded only on a person's explicit word, after they have seen that check: `RUN release except --release <id> --check <check-id> --by <role> --reason "<text>"`. Use a role, never a name. It counts only at the commit it was recorded for; qualify again afterwards. Qualification ships, merges, tags and deploys nothing. Product's acceptance is separate and is read from merged product files.

Scanners are not run by MACH. Someone runs them and puts their reports under `.factory/release/scans/` for the exact commit.

## 8. Security boundaries in brief

- Local services bind `127.0.0.1` only and need a one-time link.
- An unattended run gets an explicit tool list, a spending cap and a time limit, and nothing else.
- That list includes `Bash(python3 *)`. A prompt injection that succeeds could therefore run arbitrary code as you. There is no operating-system sandbox. Read the operator guide before enabling supervised mode on a machine with credentials you care about.
- Build, test and verify commands run the repository's own code with your privileges.
- Credentials: nothing in a key, token or secret-like environment name reaches an unattended run.

See `OPERATOR_SECURITY_GUIDE.md`.

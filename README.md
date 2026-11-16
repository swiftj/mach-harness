# MACH

MACH (Multi-Agent Construction Harness) is a software factory for Claude Code. A product manager describes what is wanted; the factory turns each piece into a checked specification, builds it test-first in an isolated workspace, proves it works with captured evidence, has it reviewed by a panel of independent agents, and merges it. Every station hands the next one artifacts a script has checked, not a claim that the work is done.

> **Status: 0.13.0.** [`CLAUDE.md`](CLAUDE.md) is the full blueprint.

## Contents

- [Who does what](#who-does-what)
- [Install](#install)
- [The two commands](#the-two-commands)
- [How work flows](#how-work-flows)
- [For product managers](#for-product-managers)
- [For engineers](#for-engineers)
- [When the factory needs you](#when-the-factory-needs-you)
- [Finding out where things stand](#finding-out-where-things-stand)
- [Every command](#every-command)
- [Settings](#settings)
- [Guides](#guides)

## Who does what

| | Does | Never has to |
|---|---|---|
| **Product manager** | Describes the product, answers the interview, approves slices, sends them to engineering | Use Git, read code, or answer a technical question |
| **Engineer** | Installs MACH, takes approved work in, runs the line, approves high-risk changes | Write the spec, the tests or the code by hand |
| **The factory** | Grooms, plans, builds, verifies, reviews, merges, cleans up, and learns from finished tickets | Decide a high-risk change, or start on its own on a machine where nobody enabled it |

Some words used below:

- A **slice** is one thin, complete outcome for one kind of user, small enough to build and check in one go.
- A **delivery wave** is a group of approved slices sent to engineering together.
- A **ticket** is one piece of work in the factory. A **cell** is the ticket's private workspace: its own Git worktree and branch, so nothing touches your main checkout until it is merged.
- A **station** is one step of the line (groom, build, verify, review, merge, clean up), run by its own agent with a fresh context.

## Install

You need Claude Code, `git`, and `python3` 3.8 or later.

**As a plugin, for every project.** In Claude Code:

```
/plugin marketplace add swiftj/mach-harness
/plugin install mach@mach-harness
```

Then run `/mach:init` once in each project. It creates the factory files (`.factory/`, `REVIEW.md`, `AGENTS.md`, make targets, a MACH section in `CLAUDE.md`) and overwrites nothing that exists.

**With one command, for one project.** From the project's root:

```bash
curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash
```

This installs the newest release, after checking it, and prints one `MACH source:` line saying what it verified. Restart Claude Code afterwards. Run it again later to update.

**Then check the setup:**

```
/mach-run doctor
```

It checks Git, Python, Claude Code, your ticket tracker's sign-in and the MACH files, and lists what to do about anything missing. It changes nothing.

Both installs also fetch two small programs for the browser views (Product Studio's app and the Factory Floor), for Apple silicon Macs and Linux. What is downloaded, how it is verified, and the options to skip or pin a version are in [Installing](docs/guides/INSTALLING.md).

## The two commands

Almost everything goes through two commands.

| Command | For | What it is |
|---|---|---|
| `/mach-product-studio` | Product managers | The workspace for the project, its epics, slices and delivery waves |
| `/mach-run` | Engineers | The line: move a ticket, see the board, take in product work, check the setup |

Both take plain words as well as the forms shown in this guide: "open the app", "what is LOCAL-004 waiting for?", "open the Factory Floor".

**Names.** With the one-command install the commands are `/mach-run`, `/mach-product-studio` and so on. With the plugin they are `/mach:run`, `/mach:product-studio`. This guide uses the first form.

## How work flows

A request can start as a GitHub issue labelled `mach:request`; Product Studio shows it, and the product manager takes it from there.

```text
  PRODUCT MANAGER                      ENGINEER                        THE FACTORY
  /mach-product-studio                 /mach-run

  describe the project
  interview, one question
  at a time, per slice
  approve slices
  group them into a wave
  send the wave  ───────────────►  review and merge the
  (one pull request)               product pull request
                                   take the work in  ───────────►  one ticket per slice
                                   dispatch what is ready           groom ► plan ► build ► verify
                                                                    ► review ► merge ► clean up
                                   approve high-risk changes  ◄──  stops wherever a person is needed
  record acceptance  ◄───────────  qualify the release
```

A small team, or one person, can skip the left column: an engineer can groom an idea directly and run it down the line (see [One idea, start to finish](#one-idea-start-to-finish)).

## For product managers

Open Claude Code in the project folder and type:

```
/mach-product-studio
```

With nothing after it, it shows where things stand and suggests the next step. Say "open the app" to work in your browser instead; the app and the conversation share the same drafts.

1. **Describe the project.** A name, a vision, and the outcomes you want for people.
2. **Add an epic**, a larger capability, and approve it.
3. **Start a slice.** Claude interviews you one question at a time. Each question is a yes-or-no proposal with a recommended answer:

   | You say | What happens |
   |---|---|
   | `yes` | The recommendation is accepted. |
   | `14 days, not 7` | Your answer is used. |
   | `I don't know` | It becomes an open question with a note on who can answer it. Nothing is guessed. |
   | `you decide` | The recommendation is used and listed as an assumption for you to review. |
   | `I need to stop` | Your progress is saved. Say "continue SLICE-004" later. |

   You never argue scope or answer in technical terms: the interview cuts the idea down to the smallest complete outcome and reserves IDs for what it defers.
4. **Approve the slice** once the spec passes its checks and no question is open.
5. **Group approved slices into a delivery wave**, approve it, and say "send the wave". Engineering receives one pull request. Sending starts no engineering work.
6. **Read the feedback.** Say "feedback" to see whether engineering accepted the wave or asked for changes.

Everything you write is a private draft on your computer until you send a wave. Full guide: [Product Manager Guide](docs/guides/PRODUCT_MANAGER_GUIDE.md).

### Starting from a GitHub issue

1. Someone files an issue in plain words. A person with write access to the repository labels it `mach:request`.
2. After a refresh it appears under Requests (say "show requests"). A request labelled by anyone else is listed as "not accepted", with the reason.
3. Say "pick up request 42". You choose the epic and a title, and are interviewed as usual. The issue's text is shown to you as what was asked for; it never answers a question for you.
4. The issue gets a `mach:grooming` label and short comments with slice IDs and links as work moves: taken in, sent, merged.
5. When a slice made from it is approved, say "request 42 is met" and the issue closes.

## For engineers

### Before the first ticket

```
/mach-run doctor     is this machine and project set up?
/mach-run audit      is the repository ready for agents?
```

The audit runs your build, tests and linter and gives a tier. **Gold** allows full autonomy. **Silver** builds, with a person approving each change. **Bronze**, which includes any failing build or test suite, blocks autonomous work until the repository is hardened.

### One idea, start to finish

```
/mach-run new "Let workspace admins invite a teammate by email"
```

MACH creates a ticket and a cell and interviews you, the same way as in Product Studio. On your yes it writes the why (`intent.md`), the spec, the boundary contracts and a test-first plan into the cell. Then:

```
/mach-run LOCAL-001
```

This moves the ticket from wherever it is to the next point where a person is needed. A script reads what each station recorded and names the next step; a fresh agent does it; then the script is asked again. You can name a ticket by its number alone: `/mach-run 1`.

An interrupted run loses nothing. Run the same command again and it resumes at the station it had reached.

### Approved product work

When a product manager's wave has been merged:

```
/mach-run product status      what is approved and merged; changes nothing
/mach-run product intake      file one ticket per new slice
/mach-run product plan        what is ready, active, blocked, and why
/mach-run product dispatch SLICE-001
```

Dispatch opens the cell and stops; `/mach-run <ticket>` then runs it. Nothing is dispatched without your command.

### Several tickets at once

Ask Claude Code to "run the mach-belt workflow for LOCAL-002 and LOCAL-003" (`mach:belt` with the plugin). Each ticket is built, verified and reviewed in its own cell, and the run ends with what each one is waiting for.

### Unattended, on a machine you choose

```
/mach-run factory enable
```

The supervisor keeps approved product work moving without you. It is off on every machine until an engineer enables it there, after reading exactly what will be allowed and confirming with a code. `/mach-run factory status`, `pause`, `resume`, `disable` and `stop` complete it. Read [Operator Security Guide](docs/guides/OPERATOR_SECURITY_GUIDE.md) first.

### Watching it

Say "open the Factory Floor" to `/mach-run`. It opens a read-only view in your browser: the Atlas (what is where), the Timeline (what happened, when) and Analytics (how well the factory runs). It cannot start, approve or merge anything.

### Releasing

```
/mach-run release qualify WAVE-001
```

It checks, at one exact commit, that every slice in the wave is merged, verified and reviewed, reruns the tests, and writes a readiness snapshot. It never tags or deploys.

Full guide: [Engineer Guide](docs/guides/ENGINEER_GUIDE.md).

## When the factory needs you

The line stops and says what it is waiting for. These are all the cases.

| It says | What to do |
|---|---|
| The spec has open questions | Finish the interview: `/mach-run <ticket>` continues it |
| Waiting for a person's approval (a high-risk change, or a Silver repository) | Read the findings it shows, then `/mach-run approve <ticket>` |
| Approved, waiting for a person to merge | `/mach-run merge <ticket>` |
| Blocked: escalated after three rounds | `/mach-run explain <ticket>`, then fix it yourself or abandon it: `/mach-run abandon <ticket> "<why>"` |
| The repository is Bronze | `/mach-run audit` lists what to fix |
| The audit is missing or out of date | `/mach-run audit` |

A ticket gets three judging rounds in all, counting failed verifications and rejected reviews. On the third failure it is handed to a person; the factory does not keep trying.

## Finding out where things stand

```
/mach-run board              every open ticket and its next step
/mach-run explain LOCAL-004  why this ticket failed or is waiting
```

Every status opens with three lines:

```text
Where: LOCAL-004: stage built; next: revise. The review rejected this build.
A person must decide: Nothing
Time and cost: 42 min recorded; cost not recorded
```

A cost appears only where one was recorded, which today means work the supervisor ran. It is never estimated.

`explain` names the requirement or scenario that failed, the check or test that showed it, each reviewer's blocker with the rule it cites, and how many of the three rounds are used.

## Every command

`/mach-product-studio` and `/mach-run` are the ones to remember. The station commands at the bottom of the table still work and you can run any of them yourself, but `/mach-run` calls them for you.

| Command | What it does |
|---|---|
| `/mach-product-studio` | Project, epics, slices, waves; requests from GitHub issues; `refresh`, `send`, `feedback`; "open the app" |
| `/mach-run <ticket>` | Move one ticket to the next point a person is needed |
| `/mach-run board` | Every open ticket and its next step |
| `/mach-run explain <ticket>` | Why a ticket failed or is waiting |
| `/mach-run doctor` | Check this machine and project; `--fix` creates missing MACH folders only |
| `/mach-run new "<idea>"` | Start the interview for a new idea |
| `/mach-run approve <ticket>` | Record your approval of a change that needs a person |
| `/mach-run merge <ticket>` | Merge an approved ticket yourself |
| `/mach-run abandon <ticket> "<why>"` | Drop a ticket; its work is archived first |
| `/mach-run audit` | The repository's readiness tier |
| `/mach-run product status\|intake\|plan\|dispatch` | Take approved product work into the factory |
| `/mach-run factory status\|enable\|pause\|resume\|disable\|stop` | The unattended supervisor on this machine |
| `/mach-run release status\|qualify\|show` | Is a wave ready to release, at one commit |
| `/mach-intent <ticket or idea>` | The interview, spec, contracts and plan; `--headless` when no person can answer |
| `/mach-build <ticket>` | Build test-first inside the cell |
| `/mach-verify <ticket>` | Prove the built slice with captured evidence |
| `/mach-review <ticket>` | The review panel; `approve --by <name>` records a person's approval |
| `/mach-merge <ticket>` | Land exactly the approved commit; `--by-person` to merge it yourself |
| `/mach-cleanup <ticket>` | Archive and remove a finished cell; `--abandon "<why>"` to drop one |
| `/mach-observe` | Scorecard of finished tickets and proposed rule changes |
| `/mach-audit` | The repository's readiness tier |
| `/mach-ticket list\|view\|create\|update\|comment\|ingest-telemetry` | The ticket queue, and crash reports turned into tickets |
| `/mach:init` | Plugin only: create the factory files in a project |

Outside Claude Code: `make mach-status` (what is installed and the open cells), `make mach-cells` (the worktrees behind them), `make mach-uninstall`.

What each station checks and refuses is in the [Station Reference](docs/guides/STATION_REFERENCE.md).

## Settings

Settings are in `.factory/config.json`. The ones people change most:

| Setting | Default | Meaning |
|---|---|---|
| `tickets.provider` | `local` | Where tickets live: Markdown files in `.factory/tickets/`, or `github`, `gitea-cli`, `jira`, `fossil` |
| `merge.mode` | `auto` | `auto` lets the line merge approved tickets; `manual` leaves every merge to you |
| `merge.method` | `local` | `local` makes a merge commit; `pr` opens a pull request and merges the approved commit |
| `merge.auto.<tier>` | `true` | Set a risk tier to `false` to keep its merges for a person |
| `review.<tier>` | see file | Reviewers, approvals needed, and whether a person must approve |
| `factory.max_parallel` | `3` | How many tickets may run at once |
| `models.*` | `fable`, `opus`, `sonnet`, `haiku` | The model tier for planning, contracts, building and utility work |
| `tickets.github.request_label` | `mach:request` | The label a person with write access applies to turn an issue into a request |
| `tickets.github.status_comments` | `true` | `false` stops MACH's comments on request issues; its labels are still set |
| `floor.evidence_media` | off | Show evidence screenshots and recordings in the Factory Floor |

A high-risk change always needs a person's approval in review unless you change that setting yourself. `REVIEW.md` and `AGENTS.md` are yours to edit once created.

## Guides

| Guide | For |
|---|---|
| [Product Manager Guide](docs/guides/PRODUCT_MANAGER_GUIDE.md) | Product Studio from first project to recorded acceptance |
| [Engineer Guide](docs/guides/ENGINEER_GUIDE.md) | Intake, the supervisor, human gates, recovery, release qualification |
| [Station Reference](docs/guides/STATION_REFERENCE.md) | What each station does and what its script refuses |
| [Installing](docs/guides/INSTALLING.md) | The browser programs and what the installer verifies |
| [Operator Security Guide](docs/guides/OPERATOR_SECURITY_GUIDE.md) | What an unattended run can reach, and the limits to know |
| [`CLAUDE.md`](CLAUDE.md) | The full blueprint |

## Uninstall

Script install or scaffold, from the project's root:

```bash
python3 .factory/bin/mach uninstall
```

Plugin:

```
/plugin uninstall mach@mach-harness
```

Uninstall removes exactly the files MACH installed and you have not changed (and Python's compiled copies of those scripts, which it lists), and takes its section back out of `CLAUDE.md` and `.gitignore`. A file you edited is kept and reported; `--force` removes it after saving a backup. Your tickets, specs, cells and archives are your project's data and are never touched. An untouched project is left byte-for-byte as it was.

## Developing MACH

```bash
make test        # validator, cell gates, ticket adapter, audit, build, verify, review, merge, cleanup and observe gates, installer round trips
make validate    # plugin and marketplace manifests
```

To try the plugin from a clone without installing it: `claude --plugin-dir /path/to/mach-harness`.

| Path | Purpose |
|------|---------|
| `skills/ticket/` | The ticket skill: `SKILL.md` and `ticket.py` (trackers and telemetry). |
| `skills/audit/` | The audit skill: `SKILL.md` and `audit.py` (scorecard and gate). |
| `skills/build/` | The build skill: `SKILL.md` and `build.py` (start gates, red/green enforcement, build report). |
| `skills/verify/` | The verify skill: `SKILL.md`, `verify.py` (evidence records and verdict) and the per-app-type runner guide. |
| `skills/review/` | The review skill: `SKILL.md`, `review.py` (panel, votes, tally), the reviewer brief and one checklist per seat. |
| `skills/merge/` | The merge skill: `SKILL.md` and `merge.py` (commit-bound approval, revalidation, local or pull-request merge). |
| `skills/cleanup/` | The cleanup skill: `SKILL.md` and `cleanup.py` (archive, teardown, run record). |
| `skills/observe/` | The observe skill: `SKILL.md` and `observe.py` (scorecard, patterns, report check). |
| `skills/run/` | The orchestrator: `SKILL.md` and `run.py` (what happens next to a ticket). |
| `workflows/belt.js` | The Dynamic Workflow that runs several tickets in parallel. |
| `skills/intent/` | The grooming skill: `SKILL.md`, templates, grammar references, `validate_slice.py`, `cell.py`. |
| `skills/init/` | Plugin-only wrapper around `bin/mach scaffold`. |
| `agents/contract-engineer.md` | Stage 2 of grooming, pinned to the `opus` tier. |
| `agents/builder.md` | The build station, pinned to the `sonnet` tier. |
| `agents/verifier.md` | The verify station, pinned to the `sonnet` tier, always a fresh context. |
| `agents/reviewer.md` | One seat on the review panel; the review script sets its model per seat. |
| `apps/studio/`, `apps/observer/` | The Product Studio host and the Factory Floor's read-only observer (Go), each with `build.sh` (embeds its web app) and `smoke.sh`. |
| `bin/mach`, `install.sh` | The installer. |
| `templates/` | What gets scaffolded into a project. |
| `docs/` | The guides (`docs/guides/`), the original design notes for each station, and the prd-slice skill the interview is adapted from. |

When you change the validator, change its references, the fixture in `tests/fixtures/`, and the tests together: a test fails if any rule code the validator can emit is missing from `skills/intent/references/`.

### Releasing

Set the new version in `.claude-plugin/plugin.json`, merge to `main`, then push a tag `v<version>`. The `release` workflow tests, builds the Product Studio host and the Factory Floor's observer for each machine with their web apps embedded, packages the repository at the tag as `mach-<version>-source.tar.gz` (what `install.sh` installs) and installs it into an empty project as a smoke test, writes `SHA256SUMS` for all of them, attests the build provenance of the programs, the source archive and `SHA256SUMS`, writes an SBOM for each program, and publishes the GitHub release the installer downloads from. The tag must match the plugin's version or the workflow stops.

Before publishing, each program is started on a runner of its own kind (`apps/studio/smoke.sh`: open the one-time link, load the app, ask the engine for status; `apps/observer/smoke.sh`: open the link, read the API, check that only GET is answered, stop cleanly). Running the workflow by hand from the Actions tab builds and smoke-tests everything and publishes nothing.

## License

MIT. See [LICENSE](LICENSE).

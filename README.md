# MACH

MACH (Multi-Agent Construction Harness) is a software factory for Claude Code. It moves one ticket at a time through stations (groom, build, verify, review, merge, clean up), each run by its own agent in its own context, inside an isolated git worktree called a cell. Every station hands the next one artifacts a script has checked, not a claim that the work is done.

> **Status: 0.11.1.** Every station is built and tested (ticket, audit, intent, build, verify, review, merge, cleanup, observe), with an orchestrator that moves a ticket from station to station. A new project is set to merge approved tickets itself; set `merge.mode` to `manual` to keep the merge for a person. [`CLAUDE.md`](CLAUDE.md) is the full blueprint.

## Install

You need Claude Code, `git`, and `python3` 3.8 or later.

### As a plugin (every project)

In Claude Code:

```
/plugin marketplace add swiftj/mach-harness
/plugin install mach@mach-harness
```

Then, in each project you want the factory in, run `/mach:init` once. It creates the factory files (`.factory/`, `REVIEW.md`, `AGENTS.md`, make targets, a MACH section in `CLAUDE.md`) and overwrites nothing that exists.

Commands are namespaced: `/mach:run`, `/mach:intent`, `/mach:build`, `/mach:verify`, `/mach:review`, `/mach:merge`, `/mach:cleanup`, `/mach:observe`, `/mach:ticket`, `/mach:audit`, `/mach:init`.

### With one command (one project)

From the project's root:

```bash
curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash
```

This copies the skills into `.claude/skills/` and creates the same factory files. Commands are `/mach-intent` and so on. Restart Claude Code afterwards.

From a local clone, the same thing is:

```bash
python3 /path/to/mach-harness/bin/mach install
```

Add `--dry-run` to see what would change first. Running install again updates MACH in place.

## Quick start

```
/mach-intent Let workspace admins invite a teammate by email
```

(`/mach:intent ...` with the plugin.) MACH creates a ticket and a cell, then interviews you **one question at a time**. Each question is a yes-or-no proposal with a recommended answer:

```markdown
❓ **Q4** - **Full workspace**: When every seat is taken, should the admin be refused with "All seats are in use. Add seats to invite more people." and no invitation sent?

➡️ Yes, reject the invitation with that message and send nothing.
```

| You say | What happens |
|---------|--------------|
| `yes` | The recommendation is accepted. |
| `14 days, not 7` | Your answer is used. |
| `I don't know` | The point becomes an open question with a note on who can answer it. Nothing downstream is guessed. |
| `you decide` | The recommendation is used and listed under Assumptions for you to review. |
| `use your recommendations for the rest` | The interview ends; every remaining choice is listed under Assumptions, except ones too risky to guess. |
| `I need to stop` | Progress is saved. Say `Continue SLICE-004` later. |

You never argue scope: the skill cuts the idea down to the smallest complete outcome for one kind of user and reserves slice IDs for everything it defers. You never answer in technical terms: "store it in Redis" becomes "changes are visible within 60 seconds".

When nothing is left to ask, it shows a three-point summary, and on your yes it produces, in `.factory/worktrees/<ticket>/`:

| Artifact | What it is |
|----------|------------|
| `intent.md` | Why: the problem, who it is for, goal ancestry, risk tier. |
| `spec.md`, `spec.json` | What: invariants (RFC 2119), functional requirements (EARS), a decision matrix covering every combination of conditions, and Given/When/Then scenarios. `spec.json` expands the matrix into concrete test cases. |
| contracts | The boundaries the slice touches (Protocol Buffers, OpenAPI, JSON Schema), written by a separate contract engineer agent that sees only `spec.json`. |
| `plan.md` | How: a test-first task list in which every requirement and scenario is assigned to a task, plus a file touch map. |

The slice spec and contracts are committed on the cell's branch, `feature/<ticket>`, never on your main checkout. The durable copy of each spec lives in `specs/slices/` and merges with the code.

### What is checked by script, not by a model

- The spec's structure, grammar, and traceability; that the decision matrix covers every combination with no two rules in conflict; that every outside dependency has a failure requirement and a scenario (`validate_slice.py`, 47 rule codes).
- That no open question remains before contracts are written (`cell.py finalize`).
- That slice IDs are unique across every ticket being groomed at once.
- That the plan puts tests first, assigns every requirement and scenario, and lists only contracts that exist (`cell.py check-plan`).

### Headless grooming

For tickets no person is available to answer, such as ones generated from crash telemetry:

```bash
claude -p "/mach-intent AUTO-20261109 --headless"
```

Each question is answered from facts in the project or a strict default and recorded as "Decided without a PM". Anything involving money, access, irreversible deletion, or two rules in conflict is never guessed: it becomes an open question, the ticket is labelled `blocked-requires-sme`, and no contracts or plan are written until a person finishes the interview.

## Running the whole line

```
/mach-run LOCAL-001
```

This moves one ticket from wherever it is to the next point where a person is needed. A script reads what each station recorded and names the next step; the session starts the right worker for it (a fresh sub-agent for the build, for verification, and for each review seat), then asks again. It stops and tells you what it is waiting for:

- answers to open questions in the spec;
- your approval of a high-risk change;
- the merge, if your project keeps it for a person (`merge.mode` or `merge.auto` in `.factory/config.json`);
- a person to take over a ticket that failed three rounds.

`/mach-run board` shows every open ticket, its stage and its next step, without starting anything.

To move several tickets at once, unattended and in parallel, run the MACH Dynamic Workflow with their IDs, for example by asking Claude Code to "run the mach-belt workflow for LOCAL-002 and LOCAL-003". The workflow is named `mach-belt` in a project install and `mach:belt` with the plugin. Each ticket is built, verified and reviewed in its own cell; the run ends with a list of what each ticket is waiting for.

The line is driven by what each station recorded, so an interrupted run loses nothing: run it again and it resumes at the station it had reached. When you start the workflow from a non-interactive `claude -p` session, set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, or the session stops background work after ten minutes.

The sections below describe each station; you can also run any of them yourself.

## Building a groomed ticket

```
/mach-build LOCAL-001
```

The builder implements the ticket inside its cell, following `plan.md` one task at a time. It writes the tests and the code; a script runs the tests, decides whether each step counts, and makes every commit. The script refuses:

- starting on a repository the audit has not cleared, or on a ticket that is not fully groomed;
- a task out of order;
- a test that was never seen failing, or code committed while the suite fails;
- a change to a test that is already committed;
- a change to a file the plan did not give the task;
- finishing while any requirement or scenario in the spec is not named by a test.

Each refusal has an override that needs a written reason, and every use is recorded in `build-report.json` for the reviewers. After a failed verification or a rejected review, `/mach-build LOCAL-001 --revise findings.md` starts a revision. A ticket gets three judging rounds in all; on the third failure it is escalated to a person.

To run the builder on the model tier the factory assigns, start it as the `builder` agent (`mach:builder` with the plugin, `mach-builder` in a project install).

## Verifying a built ticket

```
/mach-verify LOCAL-001
```

Run this in a fresh session, or as the `verifier` agent, never in the conversation that built the ticket. The verifier runs the slice the way its user would and saves what it captures in the cell's `evidence/` folder: screenshots and recordings for a web app, a terminal session and exit codes for a command-line tool, request and response dumps for an API, a consumer-side transcript for a library.

It must prove every scenario in the spec with the scenario's own data, and every decision matrix rule with data of its own choosing. A script checks that each claim points at an evidence file captured in this run, refuses the builder's own test log as proof, catches evidence edited after it was recorded, and gives the verdict:

| Verdict | Meaning |
|---------|---------|
| `PASS` | Everything is proven with evidence. The ticket goes to review. |
| `FAIL_WITH_EVIDENCE` | A behavior does not match the spec. The findings go back to the build station, using one of the three review loops. |
| `INCOMPLETE_EVIDENCE` | Something is unproven, or a required kind of evidence is missing. |

To give the verifier an extra check the builder never sees, put a file describing it in `.factory/holdouts/<ticket>/`.

## Reviewing a verified ticket

```
/mach-review LOCAL-001
```

The session you run this in chairs the panel; it does not review. It starts one reviewer per seat, each a fresh sub-agent that has seen nothing of the build or of the other reviewers, and tells them only where to look:

| Risk tier | Panel | Needed to pass |
|-----------|-------|----------------|
| High | Architecture, security, product, on the `opus` tier | All three, then a person's approval |
| Factory tuning | The same three seats, on the `opus` tier | All three; no person, if only rule files change |
| Medium | The same three seats, on the `sonnet` tier | Two of three |
| Low | One general reviewer | That reviewer |

Reviewers do not vote. Each submits findings, and any finding marked `blocker` makes that seat a reject. A blocker must name the requirement or rule it breaks and the file that shows it, so a reviewer cannot block on taste. A script counts the result:

- `APPROVED`: the branch may be merged, by the merge station or by you, depending on your settings.
- `AWAITING_HUMAN`: the panel approved a high-risk change. You are shown the findings; say you approve and it is recorded with your name.
- `REJECTED`: the findings go back to the build station.
- `ESCALATE`: this was the third failed round. The ticket is labelled `blocked-requires-sme` and waits for a person.

When a reviewer's blocker is outvoted on a medium-risk change, the outcome says so.

A ticket that is sent back and revised gets a narrower second review: reviewers see what changed since the last round and check that the earlier blockers are fixed. A blocker on code that did not change and was not blocked before is refused; it can only be a note. Reviewers also report a recurring defect once, as a class listing every place, so one revision can clear it.

## Merging an approved ticket

```
/mach-merge LOCAL-001
```

Review approves one exact commit, and the merge station lands that commit or refuses:

- **Approval is bound to the commit.** If anything was added to the branch after review, the approval is void and the ticket goes back to verification.
- **It is re-tested against today's main.** If main has moved since approval, the branch is brought up to date inside the cell and the test suite runs again before anything lands, so two tickets that each passed alone cannot break main together. A failing suite sends the ticket back to the build station; a conflict stops for a person.
- **Locally or through a pull request.** With `merge.method` set to `local` it makes a merge commit on your main checkout. With `pr` it pushes the branch, opens a pull request summarising the verification and review, and merges it at the approved commit, so your CI, review bots and team see a normal pull request.

Who merges is a setting, by risk tier:

```json
"merge": { "mode": "auto", "method": "local", "auto": { "low": true, "medium": true, "high": true } }
```

`mode: "auto"` lets the line merge approved tickets; `"manual"` leaves every merge to you. Under `auto`, set a tier to `false` to keep that tier for a person. A high-risk ticket only reaches "approved" after a person has signed off in review, so with the defaults a person still decides every high-risk change. You can always merge one yourself: `/mach-merge LOCAL-001 --by-person`.

## After the merge

```
/mach-cleanup LOCAL-001
```

Once the approved branch is merged, by the merge station or by you, cleanup archives the cell's artifacts to `.factory/archive/LOCAL-001.tar.gz`, removes the cell's worktree, folder and local branch, and appends a one-line record of how the ticket went to `.factory/archive/runs.jsonl`. It shows you a plan first, archives before it deletes, and deletes nothing if the archive fails.

- If you squash-merge or rebase, tell it the commit: `/mach-cleanup LOCAL-001 --merged-as <commit>`.
- To drop a ticket that will not be finished: `/mach-cleanup LOCAL-001 --abandon "<why>"`. Uncommitted work and a git bundle of the branch are saved in the archive first.
- `/mach-cleanup orphans` lists cells that look finished or broken.

It never merges, pushes, or deletes anything on a remote.

## Learning from finished tickets

```
/mach-observe
```

Observe closes the loop: the factory tunes its own rules from what its finished tickets show.

1. **Measure.** It reads the run record of every finished ticket and reports a scorecard: average judging rounds per ticket, first-pass rate, escalation rate, and the share of tests seen failing before their code was written.
2. **Find what recurs.** The same review rule broken in several tickets, the same builder deviation, the same kind of verification failure, or a theme that keeps appearing in reviewers' non-blocking notes.
3. **Propose.** For each, the smallest rule that would have prevented it, aimed at `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` or a skill's instructions, citing the tickets that prove it.
4. **File.** With `--auto`, or on your yes, it files one ticket labelled `factory-tuning` carrying every proposal.
5. **Apply through the line.** That ticket is groomed, built, verified and reviewed like any other, so each rule change is a reviewed diff you can revert.

It runs on its own: after every fifth finished ticket (`observe.every` in `.factory/config.json`), cleanup reports that a pass is due, and the line or the workflow starts one and then runs the tuning ticket.

A tuning ticket needs no person. It is decided by a unanimous three-reviewer panel on the strongest model tier, provided it changes only the factory's rule files. Reviewers are told to block any change that removes a rule, weakens a gate, lowers a threshold or raises a limit, and observe will not propose one; those remain your decisions. It proposes nothing until five tickets have finished.

## Is the repository ready?

```
/mach-audit
```

Agents working in a repository with a broken build, failing tests or no linter compound the damage, so MACH measures the repository first. The audit runs your build, tests and linter, scores five areas out of 100, and writes `.factory/audit-report.json`:

| Tier | Score | What it means |
|------|-------|---------------|
| Gold | 90 to 100 | Full autonomy. |
| Silver | 70 to 89 | Agents may build, but a person reviews every change before it merges. |
| Bronze | under 70 | Autonomous work is blocked until the repository is hardened. |

A build or test suite that fails, is missing, or could not be run makes the tier Bronze whatever the score. The scorecard lists each failed check with the points fixing it would add. Commands are detected from your Makefile and package manifests; set `audit.commands.build`, `test` or `lint` in `.factory/config.json` if yours are different. The audit executes your project's own commands, so run it only on code you would build yourself.

## Tickets and telemetry

```
/mach-ticket list
/mach-ticket view LOCAL-001
/mach-ticket update LOCAL-001 --state blocked --label blocked-requires-sme
/mach-ticket ingest-telemetry sentry crash.json
```

Tickets live in `.factory/tickets/` as Markdown files by default. That folder is a local working queue and is git-ignored, because stations update tickets as they work; to share tickets with a team, use a tracker. Set `tickets.provider` in `.factory/config.json` to `github`, `gitea-cli`, `jira` or `fossil` to use a tracker through its command-line tool; if your tool takes different arguments, replace any command under `tickets.commands`. MACH has five ticket states (`open`, `in_progress`, `needs_review`, `blocked`, `closed`); on trackers with only open and closed, the others are kept as `mach:<state>` labels.

`ingest-telemetry` turns a Sentry, PostHog or Datadog payload, a failed CI log, or an application error log into an `AUTO-<timestamp>` ticket with the error, the culprit file and line, and a trimmed trace. Email addresses, tokens and other credentials are redacted from everything it writes except the raw payload, which stays in the git-ignored `.factory/inbox/`. The same fault is not ticketed twice while its ticket is open. Groom the result with `/mach-intent AUTO-... --headless`.

## Day to day

```bash
make mach-status      # what is installed, what you changed, and the open cells
make mach-cells       # the git worktrees behind the cells
```

Settings are in `.factory/config.json`: the ticket provider (local Markdown files in `.factory/tickets/` by default), the model tier for each station, review thresholds, and whether cells commit automatically. `REVIEW.md` and `AGENTS.md` are yours to edit once created.

## Uninstall

Script install or scaffold, from the project's root:

```bash
python3 .factory/bin/mach uninstall
```

Plugin:

```
/plugin uninstall mach@mach-harness
```

Uninstall removes exactly the files MACH installed and you have not changed, and takes its section back out of `CLAUDE.md` and `.gitignore`. A file you edited is kept and reported; `--force` removes it after saving a backup. Your tickets, specs, cells and archives are your project's data and are never touched. An untouched project is left byte-for-byte as it was.

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
| `bin/mach`, `install.sh` | The installer. |
| `templates/` | What gets scaffolded into a project. |
| `docs/` | The original design notes for each station, and the prd-slice skill the interview is adapted from. |

When you change the validator, change its references, the fixture in `tests/fixtures/`, and the tests together: a test fails if any rule code the validator can emit is missing from `skills/intent/references/`.

## License

MIT. See [LICENSE](LICENSE).

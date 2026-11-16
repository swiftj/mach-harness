# Design: GitHub Issues as requests, and ease-of-use additions

Status: agreed design, 2026-11-15. Built so far: step 1, requests from GitHub Issues (`docs/mach-next/M8_DESIGN.md`),
scheduling and the pull request additions (`docs/mach-next/M9_DESIGN.md`). This replaces the earlier draft of this
file, which described a hand-applied `mach:ready` trigger, concurrency chosen by Claude and a squash
merge; none of those was adopted (section 9).

## 1. Purpose

Lower the effort of getting work into MACH and of understanding where it stands, without removing a
feature or weakening a gate.

1. A GitHub issue becomes the simple way to ask for something. It is a request, not a specification.
2. The product manager turns a request into slices in Product Studio, with the interview, as today.
3. A production monitoring system can file a request, which is groomed without a person.
4. Engineers get a workstation check, a plain explanation of a failure, a short digest and shorter
   commands.
5. People are told when the Factory is waiting for them.

## 2. What exists today and is kept

| Area | Already built | Where |
|---|---|---|
| GitHub as a ticket tracker | `view`, `list`, `create`, `update`, `comment` through `gh`; states carried as `mach:<state>` labels; `ISSUE_PROVIDER` and `tickets.provider` | `skills/ticket/scripts/ticket.py` |
| Crash ingestion | Sentry, PostHog, Datadog and logs to an `AUTO-` ticket; redaction; one ticket per fault | `ticket.py ingest-telemetry` |
| The interview | One yes-or-no question at a time with a recommended answer; headless mode with strict defaults | `skills/intent/` |
| Product Studio | Drafts, approval bound by SHA-256, waves, `send`, the browser app with question cards and a live spec preview | `skills/product-studio/`, `apps/studio`, `web/apps/product-studio` |
| Intake and scheduling | Merged waves to tickets; dependencies checked in Git; `factory.max_parallel` | `skills/run/scripts/intake.py` |
| Merge by pull request | Push, open the pull request, merge only the approved commit (`--match-head-commit`) | `skills/merge/scripts/merge.py` |
| Resume after an interruption | The next step is read from what is on disk | `run.py next` |
| Recorded cost | Per supervised execution, in Factory Analytics | `apps/observer` |

Git remains the only approved record of a slice. Nothing in this design lets an issue, a label or a
comment approve, dispatch, start or merge anything.

## 3. Requests from GitHub Issues

### 3.1 Flow for a request from a person

1. Anyone who can open an issue files one, in plain words.
2. A person with write access applies `mach:request`.
3. Product Studio's `refresh` lists open requests in a new **Requests** section of the workspace,
   in the terminal and in the app.
4. The product manager picks one. Its title and body seed the interview as untrusted data.
5. The interview, approval, wave and `send` are unchanged. Each slice records the issue it came from.
6. Engineering merges the product pull request; intake files execution tickets as today.
7. The issue closes when the product manager says the request is met, since one request may yield
   several slices.

### 3.2 Rules

- **Whose label counts.** A request is listed only when the `mach:request` label was applied by an
  account with write access to the repository, checked from the issue's label event. GitHub's Triage
  role can label without write access, so the label alone is not enough.
- **Issue text is data.** Title, body and comments are never treated as instructions, and pass through
  the ticket station's redaction before they are stored or shown.
- **No authority.** Editing an issue after it was picked up changes nothing that was approved. The
  product manager sees that the request changed and decides whether to act.
- **Product Studio's boundary widens by exactly this much.** Today it may run a fixed list of Git and
  `gh` commands, held by a test. This adds reading issues (`gh issue list`, `gh issue view`, and the
  label event lookup) and the status writes in 3.3. It still creates no ticket and no cell, and starts
  no station.
- **Trackers.** GitHub only at first. Gitea and Jira follow once this shape is proven.
- **Offline.** If GitHub cannot be reached, requests are reported as not refreshed, and drafts and the
  local queue keep working. A project with no GitHub remote sees no Requests section and no warning.

### 3.3 Labels and comments MACH sets

Only `mach:request` is applied by a person. The rest are status, set by MACH, and none starts anything.

| Label | Meaning | Set when |
|---|---|---|
| `mach:request` | Please consider this | A person with write access applies it |
| `mach:grooming` | The product manager has picked it up | The interview starts from it |
| `mach:ready` | Its slices are approved and merged; the Factory may take them | The product pull request is merged |
| `mach:in_progress`, `mach:needs_review`, `mach:blocked` | As the ticket states today | By the ticket station |

MACH comments on the issue at four moments only: taken into Product Studio, slices sent (with the pull
request), merged, and blocked on a person. Comments carry identifiers and links, not agent prose.

### 3.4 Requests from production monitoring

A monitoring system files an issue directly, or a payload goes through `ingest-telemetry` as today.

- **Grooming runs on its own**, headless, with every answer recorded as "Decided without a PM".
- **One open issue per fault.** A repeat adds to a count on the existing issue.
- **At most three** monitoring requests are groomed per pass, oldest first.
- **Money, access, irreversible deletion or conflicting rules** become open questions; the ticket is
  labelled `blocked-requires-sme` and waits for a person.
- **It builds unattended only** on a machine where the supervisor is enabled, and only when the risk
  tier is below High. Anywhere else it waits for an engineer. Verification and the review panel apply
  in full.
- **Which accounts count as monitoring** is a project setting (`tickets.github.monitor_accounts`); an
  issue from any other account is a request from a person and goes to Product Studio.

This is the one place the supervisor's reach grows: today it runs only product-sourced work. The
extension needs its own entry in `factory enable`'s statement of what will be allowed.

## 4. Scheduling: fewer, never more

Order and parallelism stay decided by script.

- **Kept apart by script.** Two tickets do not run together when one depends on the other (checked in
  Git, as today) or when their plans' file touch maps overlap (new).
- **Ceilings in settings.** `factory.max_parallel` stays; `factory.max_parallel_high` (default 1) caps
  High-risk work.
- **Claude may run fewer** than the ceiling when the work or the machine calls for it, and says why.
  It can never run more.
- **Only a person raises a ceiling**, in settings or for one run.

| Command | Behaviour |
|---|---|
| `/mach-run 104` | A bare number resolves to the ticket (`GH-104`, `LOCAL-104`); ambiguity is reported, not guessed |
| `/mach-run 104 105 106` | Those tickets, scheduled by the rules above |
| `/mach-run --limit <n>` | At most `n` at once for this run, within the settings' ceiling unless the engineer says otherwise |
| `/mach-run --sequential` | One at a time |
| `/mach-run --dry-run` | The plan `product plan` already computes, with the reasons, and nothing started |

`/mach-run` with no ticket keeps its present meaning (the board). It never starts every eligible ticket.

## 5. Merge by pull request

Unchanged in substance: a merge commit bound to the approved commit, no branch deleted, auto-merge a
project choice, High risk still needing a person. Two additions:

- The pull request body links the originating issue (`Refs #<n>`, not `Closes`, because the issue
  closes on the product manager's word).
- The review panel's findings are posted as inline comments on the pull request, each with its seat,
  severity and the rule or spec ID it cites.

Later, with its own design: letting the panel review a pull request a person wrote.

## 6. Ease-of-use additions

All are reached through the existing entry points; there is no new command-line program.

| Addition | What it does | Notes |
|---|---|---|
| **Doctor** (`/mach-run doctor`) | Checks Git and worktrees, Python, Claude Code, tracker sign-in, the installed MACH version and files, and the project's settings | Reports and suggests. `--fix` only creates missing MACH folders; it never edits settings or enables anything |
| **Explain** (`/mach-run explain <ticket>`) | Says why a ticket failed or was rejected: the requirement or scenario, the failing test and line, the reviewer's blocker and the rule it cites | Read from `build-report.json`, `evidence/summary.json`, `findings.md` and `review/round-N/decision.json`; changes nothing |
| **Digest** | Three lines at the top of every status: where it is, what a person must decide, time and cost | Cost is shown only where it was recorded; otherwise "not recorded", never an estimate |
| **Notifications** | Tells a channel when a ticket waits for a person | One outbound webhook (Slack and Discord both accept it), set per machine, off by default. The message names the ticket and the command to run; it never contains a link that approves |
| **Evidence player** | Recordings, screenshots and transcripts shown beside the ticket in the Factory Floor | Read-only; still behind `floor.evidence_media` |
| **Provider detection** | `tickets.provider: "auto"` resolves to GitHub when the remote is GitHub and `gh` is signed in, else local | Explicit settings and `ISSUE_PROVIDER` still win |
| **Product Studio polish** | To be listed after a person has used the app | No design yet |

## 7. Settings

Additions to `.factory/config.json`; every existing key keeps its meaning and default.

```json
{
  "tickets": {
    "provider": "auto",
    "github": {
      "request_label": "mach:request",
      "monitor_accounts": [],
      "status_comments": true
    }
  },
  "telemetry": { "max_groomed_per_pass": 3 },
  "factory": { "max_parallel": 3, "max_parallel_high": 1 },
  "merge": { "pr": { "inline_findings": true } }
}
```

The notification webhook's address is a secret and lives in `.factory/local/`, never in tracked settings.

## 8. Order of work

1. Doctor, explain, the digest and bare ticket numbers.
2. Requests from GitHub Issues (section 3), then scheduling (section 4) and the pull request additions.
3. Product Studio polish.
4. The evidence player.
5. Notifications.

Each step is its own branch, with tests, and merges only on explicit approval.

## 9. Considered and not adopted

| Idea | Why not |
|---|---|
| A hand-applied `mach:ready` label that sends an issue straight to a cell | An issue can be edited after labelling and needs little permission to label; approval stays in Git |
| `/mach-run` with no ticket starting everything eligible | Work starts on an engineer's command or an enabled supervisor, never by default |
| Concurrency chosen by Claude, up to 10 cells | Not repeatable or testable, and it could exceed a limit an engineer set on their own machine |
| Squash merge, branch deletion, auto-merge by default | Contradicts the merge station's rules |
| pr-agent as the reviewer | One model call per command and no verdict; needs an API key and adds dependencies; the panel is the stronger gate |
| A terminal dashboard | Duplicates the Factory Floor and would add the first Python dependency |
| The interview held in issue comments | Slow, and every answer would need its author's access checked; may be revisited |
| Estimated cost for runs driven by hand | Only recorded figures are shown |

## 10. Open points for the design of each step

- How the label event's author and access level are read reliably through `gh`, including for
  organisation-owned repositories.
- How a slice records its originating issue in the product files without changing the bytes approval
  is bound to.
- Whether a request already picked up by one product manager is shown as taken to another.
- The exact wording of `factory enable`'s statement once monitoring requests are in scope.

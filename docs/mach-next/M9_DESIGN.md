# M9: Scheduling several tickets, and pull request additions

Status: design, 2026-11-16. Implements sections 4 and 5 of
`docs/mach-github-issues-integration-spec.md`. No feature is removed and no gate is weakened.

## 1. Scheduling: fewer, never more

### 1.1 What decides

A new script, `skills/run/scripts/schedule.py`, reached as `run.py schedule`. It reads; it starts
nothing and writes nothing. Its rule is one pure function, `decide(tickets, running, ceiling,
ceiling_high)`, used by three callers: the `schedule` command, the belt workflow (through its relay)
and the supervisor (imported directly).

### 1.2 Facts per ticket

| Fact | Source | Unknown means |
|---|---|---|
| `stage` | the cell's `cell.json` | no cell yet |
| `risk` | `cell.json` | treated as High once the ticket is in the line |
| `files` | the cell's `plan.md` file touch map, parsed by the build station's own `parse_plan` (loaded, never copied) | the ticket runs on its own among tickets in the line |
| `waits_for` | the intake ledger: tickets of slices this ticket's slice depends on that are not integrated (checked in Git, by `Factory.plan`) | no dependency is known |
| `phase` | `prepare` when the stage is none, `interview`, `spec-open` or `spec-ready`; otherwise `line` | |

A ticket in `prepare` has no plan yet. It may start, under the ceiling, only as far as the build
station (`until: "build"`). It then returns to the queue and is scheduled again with its plan known.

### 1.3 Rules, applied in the order the tickets were given

1. A ticket already running is skipped.
2. **Ceiling.** Running plus started never exceeds the ceiling in force.
3. **Dependency.** A ticket waits while any ticket in `waits_for` is not integrated.
4. **High risk.** Among tickets in the line, at most `factory.max_parallel_high` (default 1, never
   above the ceiling) High-risk tickets run at once.
5. **File overlap.** A ticket in the line does not start while a running or just-started ticket in
   the line has a file in common with it. The reason names the other ticket and up to five files.

Every held ticket carries a plain reason and the tickets it waits for (`after`). The same inputs
always give the same answer.

Overlap keeps two tickets from running together; it does not wait for the first to be merged. If the
first stopped for a person, the second starts and the merge station's revalidation brings it up to
date, as today.

### 1.4 Ceilings

| | |
|---|---|
| Settings ceiling | `factory.max_parallel` (unchanged) |
| High-risk ceiling | `factory.max_parallel_high`, default 1 |
| `--limit n` | the smaller of `n` and the settings ceiling |
| `--sequential` | 1 |
| `--limit n --by-person` | `n` for this run, up to a fixed maximum of 8; only on the engineer's explicit word in the conversation; refused inside a supervised execution |

Claude may pass a lower `--limit` and says why. Nothing lets it pass a higher one: without
`--by-person` the script clamps, and reports that it clamped.

### 1.5 Command

`run.py schedule <ticket>... [--running <ticket>...] [--limit n] [--sequential] [--by-person] [--dry-run]`

Bare numbers resolve as for `next`. Output (JSON): `ceiling` (`settings`, `high`, `in_force`,
`raised_by_person`, `clamped_from`), `start` (`ticket_id`, `until`), `held` (`ticket_id`, `why`,
`after`), `running`, `batches` (a simulation of the order, assuming each batch finishes; advisory),
`workflow` and `workflow_args` (what to hand the belt), and `started: false`.

`/mach <a> <b> <c>` shows this schedule, then starts the belt workflow with those tickets.
`/mach --dry-run` with no ticket is `product plan`. `/mach` with no ticket stays the board.

### 1.6 The belt workflow

`workflows/belt.js` takes `{tickets, until, limit, sequential, by_person}` and replaces "all at
once" with a pool: ask `schedule` with what is pending and what is running; start what it names;
when any ticket finishes, ask again. A relay's copy is not trusted: a pure function `cleanSchedule`
keeps only tickets that are pending, drops repeats, and never lets running exceed the ceiling read,
nor a fixed maximum of 8. When nothing is running and nothing may start, the rest are reported as
held with their reasons. A ticket prepared twice without reaching `line` is reported as stuck.
Tuning tickets at the end go through the same pool.

### 1.7 The supervisor

Before it starts an execution (product work and monitoring work), the supervisor applies rules 4
and 5 against its live executions, with the same `decide`. A held ticket is reported with the
reason and tried again on a later pass. Its ceiling stays the smaller of the machine's and the
project's `max_parallel`.

A ticket the supervisor starts before its plan exists has no files to compare yet. Inside a
supervised execution, `run.py schedule` therefore counts the supervisor's other live executions
beside the execution's own ticket: once the plan is written, the belt asks again before build, and
the ticket is held if it shares a file with one of them, exceeds the High-risk ceiling, or one of
them has no plan yet. The execution then ends with the ticket planned, and a later pass starts it
when the rules allow. A supervised run with nothing beside it is unchanged.

## 2. Pull request additions

### 2.1 Reference to the request

The pull request body gains `Refs #<n>` when the cell records a request origin
(`cell.json` `product.origin`, kind `github_issue`) in the same repository, or
`Refs <owner>/<repo>#<n>` otherwise. Never a closing keyword: the issue closes on the product
manager's word. A test holds that no body contains `close`, `fix` or `resolve` before an issue
reference.

### 2.2 The panel's findings on the pull request

When `merge.pr.inline_findings` is not `false`, after the pull request is opened the merge station
posts the approving round's findings once, as one review of type comment:

- A finding with a file and a line inside the pull request's diff becomes an inline comment.
- Any other finding is listed in the review's summary with its file and line.
- Each carries the seat, the severity (and `security` with its impact where marked), the title, the
  detail (bounded) and the rule or spec ID it cites.
- Reviewer text is data: it passes through the ticket station's redaction (`issue_rules`, loaded,
  never copied), mentions are broken so nobody is notified, and it is bounded in length.
- Posting is recorded in `cell.json` so a repeated run never posts twice.
- A failure to post never blocks or delays the merge; it is reported in the station's result. If
  the review cannot be created, one plain comment with the same content is tried, then it gives up.

The merge itself is unchanged: `--match-head-commit`, a merge commit, no branch deleted.

## 3. Settings

```json
{ "factory": { "max_parallel": 3, "max_parallel_high": 1 },
  "merge": { "pr": { "inline_findings": true } } }
```

## 4. Not in this step

Letting the panel review a pull request a person wrote; provider detection (`tickets.provider:
"auto"`); recording the High-risk ceiling in execution provenance.

## 5. One worker per ticket: the claim

Found in the live check: nothing stopped a second worker from planning a cell a first worker was still
planning. Only the supervisor claimed work before starting it.

### 5.1 The claim

A small file in the cell, `.factory/worktrees/<ticket_id>/claim.json`:
`{"step", "stage", "holder", "at", "renewed_at"}`. One shared helper, `skills/intent/scripts/claim.py`
(beside `lifecycle.py`, loaded by the other stations the same way), reads and writes it atomically.

A claim is **fresh** while the cell's stage is still the stage it was made at and it was made or renewed
less than `factory.claim_minutes` ago (default 90). Otherwise it is stale and counts for nothing. It is a
guard against accidents between honest drivers, not a security boundary.

A **holder** is a random token a driver gets once and passes back: `run.py where` prints a new one
(`holder`), and so does the first `run.py next --holder new`.

### 5.2 Who claims, and who is refused

| Caller | Behaviour |
|---|---|
| `run.py next <ticket> --holder H` naming a work step | Claims the step for H, or renews H's claim. If another holder's claim is fresh: the answer is `stop`, `needs: "worker-in-cell"`, with the step, when it was handed out and when the claim lapses. |
| `run.py next <ticket>` with no holder | Never claims. Refused the same way while any claim is fresh. Otherwise answers as today. |
| `run.py next <ticket> --take-over` | Only on a person's explicit word. Replaces a fresh claim, and says whose step it replaced. |
| `cell.py claim <ticket> <step> [--holder H]` | For a station that starts a worker itself, outside `run.py next`: the intent skill claims `plan` before it starts the contract engineer. Refuses on another holder's fresh claim. |
| `run.py schedule ... --holder H` | A pending ticket with another holder's fresh claim is held (`rule: "claimed"`). |
| `run.py status` | Each row shows a fresh claim: the step and since when. It answers "is someone working on this?" |

A stop (`action: stop`) is never claimed. Moving to a new stage makes the old claim stale; nothing needs
releasing. The belt workflow gets one holder for the run from its first relay and passes it on every
`next` and `schedule`. The run skill does the same within a conversation. Recording a claim changes no
station's result; a failure to write one is reported and the step is not handed out.

## 6. The walkthrough of decisions

### 6.1 What it is

When work stops for a person, the run skill walks the person through each waiting ticket, one at a time:
what happened, then a prompt with the options for that situation, the recommended one first. It starts on
its own at the end of `/mach <ticket>` and of `/mach <a> <b> <c>` whenever something waits on a
person. `/mach decide [<ticket>...]` returns to it later. It never runs unattended: not in the belt,
not in a supervised execution, not headless.

### 6.2 A script lists the options

`skills/run/scripts/decide.py`, reached as `run.py decide [<ticket>...] [--json]`. It reads only. For each
ticket waiting on a person it gives:

- `situation`: stage, risk, round, and the facts `explain.py` already gathers (the failing requirement or
  check, each blocker with its rule), bounded, passed on as data.
- `show_first`: files the person must be shown before deciding (the round's `findings.md` before an
  approval).
- `options`: each with `key`, `label` (one to five words), `does` (one sentence), `route` (the existing
  run-skill input that carries it out, such as `approve <ticket>`), `needs_reason`, and `recommended`.
- `recommendation`: `{"basis": "rule", "why": ...}` where a rule decides it, else
  `{"basis": "judgement"}`: the script recommends nothing and Claude may give its own reading, labelled
  as its own.

Only options whose gate exists in a station's script are listed; `decide.py` adds no power. The states it
covers, each read from the stations' own files: waiting for a person's approval; approved with merges
kept for a person; a pull request that cannot land yet; a spec with open questions; a build stopped at a
gate; escalated after three rounds; a Bronze repository; a ticket the supervisor parked; a worker in the
cell (5.2). "Skip for now" is always possible and changes nothing.

### 6.3 Carrying a choice out

The skill routes the choice to the station that owns it, under that station's gates, exactly as if the
person had typed it. A choice that needs a reason is asked for in the person's own words. One new route
is added to the run skill for this: `replan <ticket> "<why>"` (the intent station's `cell.py replan`,
only on a person's word).

## 7. Small fixes from the live check

- `build.py red` refuses a test that leaves out or respells a spec ID of its task, while it can be edited.
- `/mach approve <ticket>` carries the ticket on to the next step.
- The findings review names the commit the panel approved, and says when the branch was brought up to date.
- A file or slice name made of plain words is not masked as a secret.
- Cleanup removes the saved branch tips a re-plan left (`refs/mach/replan/<ticket_id>/*`) after it has
  archived them.
- `board` is renamed `status`.

## 8. A person may send a change back

Until now a person could only approve a change the panel had approved. The walkthrough's inventory showed
there was no gate for "change this first".

- `review.py send-back <ticket> --by NAME --reason TEXT`, reached as `/mach send-back <ticket> "<why>"`.
  Only for a cell awaiting a person, at the commit the panel voted on, on the person's explicit word, with
  the reason in their own words.
- The reason is written to `review/round-N/person-findings.md`, with a pointer to the panel's findings, and
  becomes the findings the builder revises against. No reviewer's vote or finding is changed.
- It counts as a judging round. Before the last round the decision is `REJECTED` and the cell returns to
  `built`; in the last round it is `ESCALATE` and the cell is `blocked`. The decision carries
  `rejected_by: "a person"` and `human_send_back` (who, the reason, when).
- The lifecycle log records `human.approval_recorded` with `decision: "SENT_BACK"` and the visit's exit as
  `sent-back` or `escalated`. The reason is never logged. The Factory Floor reads a send-back as an answer
  that closes the wait, and never as an approval.
- The run record gains `sent_back_by_person` (a count); a send-back is also a review rejection there.
- The walkthrough offers it beside "Approve", and says when it would be the last round.

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

`/mach-run <a> <b> <c>` shows this schedule, then starts the belt workflow with those tickets.
`/mach-run --dry-run` with no ticket is `product plan`. `/mach-run` with no ticket stays the board.

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

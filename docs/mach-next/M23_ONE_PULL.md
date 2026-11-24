# M23 design: one pull, and decisions where the person is

Status: design. Decided by the owner on 2026-11-24; the four decisions are in section 1.

Today there are two ways to move work and they do not meet. `/mach pull` takes ready slices in and runs them inside the conversation, which has to stay open. `/mach factory` runs work without a person, but only after an enabling step with a code and a second acceptance, and it will not touch what `pull` dispatched. A ticket that needs a person is found by running `/mach decide`. The owner's words: "way over the top", "disjointed", and it "cannot be viewed as a heavy onerous and ponderous system".

In short:

- **`/mach pull` is the one command.** It takes in what is ready, hands the batch to the Factory Supervisor, and returns. The supervisor runs in the background, on its own, and keeps running when the Claude Code session ends. No code, no confirmation, no second command.
- **One list, "Needs you".** Everything waiting for a person is one list, read from the Factory's own files, so it is the same after a restart. The terminal walks it (`/mach decide`, and at the end of `/mach pull`); the Factory Floor shows it and lets the person decide there.
- **One command records a decision**, whoever asks: `run.py decide do`. The terminal and the Factory Floor both call it. The supervisor then carries the ticket on by itself.
- **`/mach <ticket>` and `/mach 1 3 6` are unchanged**: a person driving tickets in the conversation.

## 1. What the owner decided

| Question | Answer |
|---|---|
| What stands between a person and the supervisor starting | Nothing at all. |
| May the Factory Floor record decisions | Yes: approve, send back, accept an ADR, take the merge, answer open questions. This computer only, behind its one-time link. The terminal can do the same. |
| Merging | Low and Medium risk merge on their own once review approves. High risk, and anything review required a person for, waits. |
| Spending | No limit unless a project or a person sets one. |

These replace two earlier rules: "unattended execution is off on every machine until enabled there" and "the Factory Floor only reads". Still in force: every service binds to this computer only; nothing weakens Claude Code's own controls; security review is never weakened silently; no second command line; a project can still forbid a supervisor (`factory.supervisor: false`).

## 2. `/mach pull`

`run.py pull` does, in order:

1. **Take in** what is marked ready, as today.
2. **Choose** the batch with the schedule's rules, as today.
3. **Hand over.** Unless one of the reasons in 2.2 applies:
   - If this machine has no Factory authorization, MACH writes one (2.1).
   - The chosen slices are dispatched with the supervisor as owner. Tickets already in the line that `pull` would have carried on, and that no worker holds, are given to the supervisor too.
   - If no supervisor is running for this project, MACH starts one, detached from the session (`factory serve`, its own process group, output in `.factory/local/supervisor.log`). If one is running, it is woken.
4. **Report**: what was taken in, what the Factory started on, what waits and why, and the "Needs you" list. Then the skill walks the person through that list if it is not empty, and ends. The person can close Claude Code.

New report fields: `factory: {"handed_over": bool, "supervisor": "started"|"woken"|"none", "pid", "why_not"}`, `needs_you` (the `decide` list), and `first_time: true` the first time an authorization is written here. `in_words` leads with one line, for example "Two slices are ready. The Factory has started on #41 and #42 and carries on in the background." The first time, one more plain line: "Agents now build here on their own: they run this repository's tests and scripts as you. `/mach stop` stops them."

### 2.1 The authorization MACH writes

`.factory/local/runner.json` stays, stays machine-local and stays private (owned by the user, not tracked, not a symlink, for this machine and this folder). What changes:

- It is written by `pull` (and by `factory enable`, now one step) with: supervised, `allow_merge: true`, `max_risk: High`, the default tool list, `enabled_by: "pull"`.
- The confirmation code, `pending-enable.json`, `--confirm`, `--accept-execution-risk`, and the include/exclude-backlog question are removed. `execution_risk_accepted` is no longer written or required; an older file that has it still reads.
- **Limits.** `max_budget_usd_per_run`, `max_budget_usd_per_day` and `max_runs_per_day` may be absent or null, which means no limit, and are absent by default. With no per-run budget, no `--max-budget-usd` is passed to Claude. `factory.*` in the project's settings, and `/mach factory enable --budget-per-day N` and the like, still set them. `max_execution_minutes` (120), `max_attempts` (2), `poll_seconds` and `max_parallel` keep defaults; `max_parallel` defaults to the project's own ceiling so one number governs.
- A person's `factory disable` writes `enabled: false` and that sticks: `pull` does not turn it back on (2.2).

### 2.2 When pull does not hand over

Pull then runs the batch in the conversation exactly as it does today, and says why in one line with what changes it. Never a dead end.

- `--here` was given.
- The project forbids a supervisor (`factory.supervisor: false`).
- A person disabled the Factory on this machine (`/mach factory enable` turns it back on).
- A check fails: Claude Code is not on the PATH, the belt workflow is not installed, the audit is missing or Bronze, the project's review settings would weaken security review, the checkout is not on the integration branch, another machine's authorization is in the file. The failing check's own sentence is the reason.

### 2.3 Merging

`allow_merge` is on. The project's own settings then decide per tier, as they already do: review sends a High-risk change to a person (`review.high.human_approval`, which the supervisor insists on), and `merge.auto.<tier>` says who merges. With MACH's defaults that is the owner's answer: Low and Medium merge once approved; High waits in "Needs you" for approval, and merges after it. A ticket whose risk is not known is treated as High.

### 2.4 The supervisor's life

- Started by `pull`, by `decide do` when a decision frees work, and by `/mach factory resume`. Never by installing MACH or cloning.
- It ends by itself when a pass finds nothing running, nothing it may start, and nothing dispatchable. Work waiting for a person does not keep it alive; the decision starts it again.
- Running executions already outlive the session. A new supervisor adopts them (`recover`).
- `/mach stop` (= `factory stop`), `/mach pause`, `/mach resume` are short forms. `/mach factory ...` keeps working.

### 2.5 A decision frees a parked ticket

Today a parked ticket needs `factory resume --retry` even after the person has decided. `decide do` removes the ticket's parked entry and attempt count when it records a decision that moves the ticket, then wakes or starts the supervisor.

## 3. "Needs you"

No new store. The list is `run.py decide --json`, computed from each cell's stage and the supervisor's parked entries. That is why it survives a restart of Claude Code, of the supervisor and of the computer.

### 3.1 `run.py decide do`

```
run.py decide do <ticket> <option-key> [--by "<name>"] [--reason "<their words>"]
                 [--adr ADR-NNNN ...] [--test-cmd "<command>"] [--answers-file <path>]
                 [--via terminal|floor] [--json]
```

It reads the same list `decide --json` gives, and refuses (exit 1, `refused: ...`) an option that the list does not offer for that ticket now. So the Floor and the terminal can never record something the script would not have offered, and two people deciding at once cannot both win.

| Option key | What it runs | Then |
|---|---|---|
| `approve` | the review station's human approval | the supervisor merges or stops per the project's settings |
| `send-back` (reason) | the review station's send-back | the supervisor runs the revision |
| `merge` | the merge station, by a person | cleanup follows |
| `accept` (ADR) | the intent station's `adr-accept` | the supervisor builds |
| `exception` (ADR; reason) | the intent station's `adr-exception` | the supervisor plans |
| `replan` (reason) | the intent station's `replan` | the supervisor plans |
| `set-test-command` (command, reason) | the build station's `set-commands` | the supervisor builds |
| `retry`, `run`, `revise` | nothing recorded; the ticket is un-parked | the supervisor runs it |
| `answers` (answers file) | 3.2 | the supervisor grooms again |
| `abandon` (reason) | cleanup's abandon | the ticket leaves the line |

Not carried out by `decide do`, because an agent or a conversation is needed, and answered `{"in_conversation": true, "command": "/mach decide <ticket>"}`: `interview` where 3.2 does not apply, a security exception (`exception` on a review veto: a person reads the finding with the agent), `policy accept`, `take-over`, `audit`, ADR baseline options. The Floor shows these with the command to run.

`--by` defaults to `git config user.name`. Each station records where the decision was made (`--via`): "a person, in the Factory Floor" or "an agent, on the person's instruction in conversation". `decide do` is refused inside a supervised execution, like `decide`.

Result: `{"ticket_id", "option", "done": true, "station": {...the station's own answer...}, "unparked": bool, "supervisor": "started"|"woken"|"none", "now": "<one sentence>"}`.

### 3.2 Answering open questions

A spec saved by grooming without a person lists `## Open questions`. `decide --json` gives them for an `answers` wait as `questions: [{"n", "text", "follow_up"}]`. `decide do <ticket> answers --answers-file f.json` (`[{"n", "answer"}]`, every question answered or marked "leave open") writes `.factory/cells/<ticket>/answers.json` with who and when, and un-parks the ticket. The next headless grooming run is given that file as data, folds each answer into the spec as a person's answer, and finalizes or asks what is still open. A conversation remains the other way to answer (`/mach decide`).

### 3.3 Being told

- `/mach` (status) and `/mach pull` lead with "Needs you: N" when N > 0.
- The Factory Floor shows the count in its top bar on every workspace and raises the list when it grows.
- On a Mac the Notification Center banner is on unless turned off (`/mach notify banner off`, or `factory.notifications: false`). The webhook stays opt-in: its address is a secret a person supplies. A message names the Factory Floor as well as the command.

## 4. The Factory Floor decides

### 4.1 The observer

- One new package, `internal/act`, is the only place that starts a process. It runs exactly `python3 -I -B <run.py> --project <root> decide ...` with a fixed argument vector per route, values as `--name=value`, its own process group, a timeout, capped output, and Git's environment variables dropped: the pattern of Product Studio's engine package, copied as that package's security code was.
- It finds `run.py` beside the binary's MACH checkout or in the project's install, as Product Studio's host finds its engine. If it cannot, the Floor stays as it is today and "Needs you" shows commands to copy.
- Routes:
  - `GET /api/v1/needs` runs `decide --json` (reads only) and returns the list. Cached briefly; re-read when the event stream shows a change.
  - `POST /api/v1/needs/{ticket}/{option}` with a JSON body (`by`, `reason`, `adrs`, `test_cmd`, `answers`) runs `decide do ... --via=floor`.
- Writes need: the session cookie, an `Origin` equal to this host, and a `X-MACH-CSRF` token given by `GET /api/v1/session`. Body must be JSON, capped. One decision at a time per project.
- The session answer says `capabilities.decisions: true|false`. `read_only` is removed.
- It still binds to 127.0.0.1 only, still takes no MACH lock itself, still writes only under `.factory/local/observer/`. It never enables, pauses, dispatches or starts the Factory: those stay in Claude Code.
- A person's name sent with a decision is passed to the station and not echoed; replies stay redacted as today.

### 4.2 The page

- "Needs you" on the Line becomes a list a person can act on. Opening a row shows what happened (the script's `situation`), the findings to read first, and the script's options as buttons, the recommended one first. A reason is asked for where the option needs one, in the person's words. A decision that cannot be undone (approve, merge, abandon) is confirmed in a dialog.
- Open questions are a form: one answer per question, or "leave open".
- Options that need a conversation show the command to copy.
- After a decision the row shows the script's `now` sentence until the event stream catches up.
- The top bar shows "Needs you: N" on every workspace.
- Every "This page only reads" line is replaced.

## 5. What is not in this design

- Starting, pausing or stopping the Factory from the Floor.
- A security exception from the Floor.
- A persistent service by default. A LaunchAgent stays an option (`/mach factory enable --persistent`).
- An operating-system sandbox for executions. The first-time line says so in plain words.

## 6. Building it

Three pieces, separate files:

- **A. Hand-over** (`policy.py`, `activation.py`, `supervisor.py`, `executor.py`, `pull.py`, `service.py`, `notify.py`, the `pull` and `factory` commands in `run.py`, the runner-policy schema, their tests). Gives `activation.carry_on(ctx) -> {"supervisor": "started"|"woken"|"none", "pid", "why_not"}` for B.
- **B. `decide do`** (a new `skills/run/scripts/act.py`, `decide.py`, the `decide` command in `run.py`, the `--via` flag in the review, intent and build stations, the headless grooming reference, their tests).
- **C. The Floor** (`apps/observer/`, `web/apps/factory-floor/`, `tests/test_mach_floor.py`, the Floor sections of the style guide).

Then the run skill, the blueprint, the README and the guides.

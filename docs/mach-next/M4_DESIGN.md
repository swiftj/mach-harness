# MACH Next — M4: the Autonomous Factory Supervisor

Status: **built**, on `feature/mach-next-m4-supervisor`, from M3 commit `6b93828`.

M4 turns M3's intake and scheduler into an opt-in, locally hosted Factory that keeps approved work moving on a machine whose engineer has enabled it. The engineer becomes the Factory's steward: they decide whether it runs, within what limits, and they are asked whenever a person is needed. On every other machine, including a product manager's clone of the same repository, nothing changes.

## 1. Integration assessment: what the Supervisor calls

The Supervisor adds no scheduling, eligibility or station logic. It calls exactly these:

| It needs to | It calls | Owner |
|-------------|----------|-------|
| bring the Factory level with the integration branch | `intake.Factory.reconcile()` (intake, then a recorded plan, under the ledger's lock) | M3 |
| know what is ready, blocked, active or done | the plan `reconcile()` returns: `dispatchable`, `runnable`, `needs_person`, `slices` | M3 |
| put a ready slice into the line | `intake.Factory.dispatch([slice], by="supervisor", authorize=...)` | M3 |
| hold the ledger while it writes | `intake.Factory.lock()`, `ledger()`, `save()`, `emit()` | M3 |
| know a ticket's next station, and whether the line has stopped for a person | `run.next_step(project, ticket, headless=True)` | run.py |
| know whether building is allowed | `run.Project.audit()` | run.py / audit |
| run the stations | the existing `mach:belt` Dynamic Workflow, with `{tickets: [id], until: "merge"}` | belt |

Changes to existing contracts, all additive:

- **Events are version 2.** Every event gains `runner_id`, `execution_id`, `source`, `cause` and `refs`, and twelve supervisor event types are added. Version 1 fields are unchanged.
- **The belt accepts `until`.** `{tickets, until: "merge"}` stops each ticket before that station. A list, or `{tickets}`, behaves as before.
- **Fetched work is visible.** When the local integration branch is simply behind the remote, product definitions are read from the remote branch as fetched. Dispatch still refuses until a person updates the checkout.
- **A dispatched slice records its `owner`** (`engineer` or `supervisor`).
- **A security reviewer's blocker can no longer be outvoted** (section 7).

## 2. Runtime architecture

Four modules in the run skill, behind `run.py factory ...`. No new command-line tool.

| Module | Holds |
|--------|-------|
| `policy.py` | the machine-local policy, its validation, the project's restrictions, the preflight, and the two-step activation |
| `executor.py` | the Claude command, the detached wrapper around one execution, and the reader of its result |
| `supervisor.py` | the ownership lease, one pass (tick), recovery, scheduling within limits, and the serve loop |
| `service.py` | advisory Git hooks and the per-user LaunchAgent |
| `activation.py` | status, enable, pause, resume, disable, stop |

One pass does this, in order:

1. Read the policy from disk. If the Factory is not enabled here, do nothing at all: no intake, no fetch.
2. Confirm this process owns the project (heartbeat on its lease).
3. Fetch, only if the policy allows it. Being offline is a note, not an error.
4. Settle executions left by an earlier pass or an earlier supervisor (section 5).
5. `reconcile()`.
6. In observe mode, or when paused, stop here.
7. For each slice the plan marks dispatchable: M3's `dispatch`, with an authorization that re-reads the policy, the lease and the audit at that moment.
8. For each runnable ticket this supervisor owns: claim durably, check authorization and the ticket's next step once more, then start one execution.

State: the supervisor's claims and executions are kept in M3's ledger under a `supervisor` key, written under M3's lock and reported through M3's event log. There is one record and one order of events. Where a ticket stands is never stored there; it is read from the cell.

## 3. The verified execution mechanism

Verified against Claude Code 2.1.322 before the Supervisor was built.

```
claude -p "Run the workflow named mach-belt with args {"tickets": ["<id>"], "until": "merge"}. Use the Workflow tool. ..."
       --output-format stream-json --verbose
       --permission-mode default
       --allowedTools <the list in the policy>
       --max-budget-usd <limit>
       --session-id <a new UUID>
```

run in the project folder with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so the run waits for the workflow however long it takes.

What the proof established:

| Question | Finding |
|----------|---------|
| Can a non-interactive run launch the existing Dynamic Workflow? | Yes. The belt ran and returned its own structured result. |
| Is a structured status available? | Yes: a final `result` event with `is_error`, `subtype`, `total_cost_usd`, `permission_denials`, and the workflow's JSON as `result`. |
| Is the session identifiable? | Yes. `--session-id` sets it in advance; it is recorded with the claim. |
| How do failure and interruption show? | A spent budget: exit 1, `is_error` true, `subtype` `error_max_budget_usd`. A killed process: no result at all. The wrapper records which. |
| **Does `--allowedTools` bound what a run may do?** | **Not by itself.** This machine's own settings run Claude in `auto` mode, where a tool that is not listed still ran. With `--permission-mode default` an unlisted tool is refused and the refusal is reported. The adapter always passes it. |
| What is the minimum tool list? | `Workflow`, `Skill`, `Agent`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash(python3 *)`, read-only `git status/log/diff/show`, **and the exact interpreter path** (`Bash(/path/to/python3.x *)`). The belt runs the station script with the interpreter path that script reports; without that entry the belt's first step is refused. |

A refused tool is never granted. If the ticket still made progress, the refusals are listed with the execution's result. If it made none, the ticket is parked and a `human.required` event names what was asked for. A refused shell command is recorded as its program and subcommand only, never its arguments, paths or variables.

**Live result (Claude Code 2.1.322, scratch project).** With Supervised Autopilot enabled, one supervisor pass adopted a planned ticket and started one execution. In 432 seconds and $2.82 the belt built, verified and reviewed it, reached `approved`, and stopped before merge. Workers were refused several compound shell commands (`cd ... && ...`, `VAR=... python3 ...`) and carried on without them. The next pass read the cell's record and logged the execution as completed.

Nothing passes `--dangerously-skip-permissions` or any flag that skips permission checks; a test holds that.

**Limits of this mechanism.** The tool list is enforced by Claude Code's permission system as invoked; it is not a sandbox. Rules in the user's own Claude settings that allow more are still in force (section 8).

## 4. Local configuration and lifecycle

### The policy

`.factory/local/runner.json`, schema version 2 (`schemas/runner-policy.schema.json`). Git-ignored, mode 0600.

It reads as **disabled** when it is missing, unreadable, a symlink, writable by other users, the wrong version, malformed, written on another machine, or written for another folder. A fresh clone has no file. Copying an enabled file to another clone does not enable that clone.

Fields: `enabled`, `paused`, `autonomy` (`observe` or `supervised`), `limits` (places, minutes per execution, runs and dollars per day, dollars per run, attempts, poll interval), `max_risk`, `allow_merge`, `allowed_tools`, `excluded_slices`, `auto_sync`, `persistent`, and who enabled it, when, where, with which runner ID.

**The local grant is an upper bound.** `factory` in the project's tracked `.factory/config.json` can turn the supervisor off, cap autonomy at observe, lower any limit, lower the risk ceiling and forbid merging. It cannot enable, raise a limit, add a tool or allow merging. Product files are never read for any of this.

### Commands

| Command | Effect |
|---------|--------|
| `factory status` | Reads only. Never enables, wakes or dispatches. |
| `factory enable ...` | Runs the preflight and prints what would be enabled and a code valid for ten minutes. Enables nothing. |
| `factory enable --confirm <code>` | Checks again, then enables. A code works once. |
| `factory pause` | Nothing new is dispatched or started. Running executions finish their run. |
| `factory resume [--retry <ticket>]` | Readiness is checked again first. Parked tickets stay parked unless named. |
| `factory disable [--stop]` | Revokes automatic execution here; removes hooks and the service. |
| `factory stop` | Emergency stop: ends running executions now and pauses. Outcomes are recorded as unknown. |
| `factory serve`, `factory tick` | The supervisor itself: until disabled, or one pass. |

The preflight requires: a MACH project; M3's intake loading; a resolvable integration branch; the checkout on it; `.factory/local/` ignored by Git; Python and git; Claude Code installed and answering a non-interactive request; the belt installed; a current audit that is not Bronze; the security veto in force; free disk and no more places than processors; no other live supervisor; the project not forbidding it; and macOS for a persistent service.

**Work already here.** If slices were waiting or in the line before activation, supervised autopilot is not offered until the engineer says whether to include them. Included work in the line is handed to the supervisor; excluded work stays the engineer's, and only work that arrives later is automatic.

**Confirmation.** The script cannot tell a person from a model. The two steps, the expiry, and the run skill's rule (show `would_enable`, wait for an explicit yes, never confirm in the same turn) are what make activation a person's act. This is a stated limit, not a guarantee.

### Two ways to run

- **Session-bound.** `factory serve` started for a session, or `factory tick`. Nothing is installed.
- **Persistent.** `--persistent` at activation installs a per-user LaunchAgent (`~/Library/LaunchAgents/com.mach.factory.<hash>.plist`) that runs `factory serve`. It restarts after a crash and stays stopped after a clean exit, which is what disabling causes. It binds no port. `factory disable` removes it.

Neither the installer, a clone, nor `/mach:run` on a ticket installs or enables anything.

### Git hooks and polling

`--hooks` adds a marked block to `post-merge`, `post-checkout` and `post-rewrite`. The block runs `factory wake` in the background, discards its output and cannot fail the Git command. `wake` writes a note if the Factory is enabled and does nothing otherwise. A serving supervisor sees the note and makes a pass early.

Existing hook content is kept and only the marked block is removed again. `core.hooksPath` is never set; a project that sets it is left alone.

Correctness never depends on a hook: the supervisor reconciles when it starts and every `poll_seconds`.

## 5. Recovery and concurrency

**Ownership.** `.factory/local/supervisor.json` names the runner, the process, a per-process instance ID, the last heartbeat and when the lease expires. A second supervisor on the machine is refused while the first is alive and its lease is current. A lease whose process is gone, or which has expired, is taken over, and that is recorded. A supervisor that finds it no longer owns the lease stops, and its authorization answers no.

**This is one runner per project, on one machine.** Two engineers' machines are not coordinated by anything here.

**Claims.** An execution is written to the ledger as `claimed` before any process exists. Then authorization and the ticket's next step are checked again, then the process is started and the record becomes `started`.

**What a restarted supervisor can tell apart:**

| Situation | How it is recognised | What happens |
|-----------|----------------------|--------------|
| not yet dispatched | the plan says ready | dispatched normally |
| claimed, never started | `claimed`, no process ID, no start file | the claim is released; nothing ran, so nothing is uncertain |
| still running | the wrapper's process is alive and its command line carries the execution ID | adopted; not started again |
| ended while nobody watched | a result file exists | closed from the result and the cell's records |
| outcome unknown | started, no result, no process | see below |
| needs a person | the line's next step is a stop, or the ticket is parked | left for a person |

**Unknown outcomes are not rerun blindly.** The cell's stage is compared with the stage at the start:

- If the stations recorded progress, that progress stands and the line continues from it.
- If nothing moved and the station was merge or cleanup, the ticket is parked for a person. It is never retried automatically.
- Otherwise it counts as a failed attempt. Planning, building, verifying and reviewing each record their own progress and are safe to resume, so one more counted attempt is allowed, up to `max_attempts`. Then the ticket is parked.

**No exactly-once claim is made.** Intake and dispatch are idempotent, claims are durable, and an uncertain side effect goes to a person. A station that was interrupted may repeat work it had not recorded.

## 6. Events

`.factory/intake/events.jsonl`, schema version 2 (`schemas/factory-event.schema.json`). In addition to M3's:

`factory.activated`, `factory.disabled`, `factory.paused`, `factory.resumed`, `revision.discovered`, `scheduling.decided`, `work.claimed`, `execution.started`, `station.observed`, `recovery.started`, `execution.completed`, `execution.failed`, and `human.required`.

Each carries stable identifiers (project, wave, slice, ticket, runner, execution), the time, `source` (engineer, intake or supervisor), `cause` where known, and `refs`: the paths where the authoritative state is kept. Events describe changes; they are not the state.

No event contains a prompt, a command line, an environment variable or a credential. A refused shell command is recorded by its program name only. The full stream of an execution stays in `.factory/local/executions/<id>/`, on the machine.

## 7. Security decisions

- **Default deny for tools**, with an explicit list a person consented to (section 3).
- **A security blocker is a veto.** A Medium-risk ticket needs two of three approvals, so the security reviewer could be outvoted. `review.py` now rejects the round when the security seat has a blocker, whatever the count, and records `security_veto`. A project can set `review.security_veto: false`; the preflight then refuses supervised autopilot.
- **No merge by default.** Every execution stops before the merge station unless the engineer chose `--allow-merge`, and the project's own merge settings still apply then.
- **No human gate is passed.** Approval of a high-risk change, a Silver repository's sign-off, open questions and the three-round escalation are all stops in `run.py`; the supervisor starts nothing for a ticket whose next step is a stop.
- **Budgets and time.** Dollars per run are enforced by Claude Code; minutes per execution by the wrapper; runs and dollars per day by the supervisor.
- **A risk ceiling.** Tickets above `max_risk` are parked for a person.

## 8. Limits and unresolved risks

1. **Unattended building runs the repository's own code.** Tests, build scripts and dependencies run as the engineer, on their machine. The controls are consent, an audited repository, merged and approved definitions, and limits. It is not sandboxed.
2. **`Bash(python3 *)` is broad.** The stations are Python scripts, so the interpreter must be allowed, and that also allows `python3 -c`. Narrowing it to the skill's own scripts was not reliable enough to ship.
3. **The user's own Claude settings still apply.** Allow rules there add to the list. `--permission-mode default` removes the permissive mode; it does not remove those rules.
4. **Confirmation is procedural** (section 4).
5. **One runner per project is assumed, not enforced across machines.**
6. **A paused or disabled Factory does not interrupt running work** unless `--stop` or `factory stop` is used. The belt has no checkpoint signal; an execution runs to its next stop.
7. **The LaunchAgent has been tested against a stand-in for `launchctl` only.** It has never been registered with the real one.
8. **Local ticket numbers** can still collide between two engineers who have not fetched each other's branches.

## 9. How to run the live smoke test

Opt-in, in a scratch project with MACH installed and a merged, approved wave. It starts a real agent and spends real money.

```
RUN factory status                                   # disabled
RUN factory enable --autonomy supervised --include-backlog --max-parallel 1 --budget-per-run 15 --max-minutes 60
RUN factory enable --confirm <code>                  # after reading what it printed
RUN factory tick                                     # claims and starts one execution
# wait for .factory/local/executions/<id>/result.json
RUN factory tick                                     # reads where the ticket now stands
RUN factory disable
```

## 10. What M5 and M6 need from here

**M5 (Product Studio web app).** Nothing in M4 changes Product Studio. The web app must call `studio.py`'s operations, as the terminal skill does, so both write identical artifacts. It needs no knowledge of the Factory's policy, and must not be given any: a test holds that Product Studio's scripts never name it.

**M6 (Control Tower).**

- **Feed:** `run.py product events --since N`, version 2. One ordered stream covering intake, scheduling and execution.
- **State:** `run.py factory status` and `run.py product plan` are the read-only snapshots. A dashboard reads these and the paths in `refs`; it never writes.
- **Execution detail:** `.factory/local/executions/<id>/stream.jsonl` holds each run's event stream, including sub-agent activity, for an inspector. It can contain tool inputs and must stay local.
- **Gaps to close first:** events have no `cause` filled in yet beyond the field existing; station transitions are observed once per pass, not as they happen; and there is no local endpoint, so a live view would poll the files or add a loopback-only server with its own origin checks.

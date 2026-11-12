# MACH Next — M6.0 telemetry gaps: what the Living Factory could not show truthfully today

Owner: Telemetry analyst (M6.0). Read-only analysis of `feature/mach-next-m6-living-factory` at baseline `fb86441` (MACH 0.12.0). No code was changed. Everything below was read from the code. Where a statement is an inference, or is taken from a design document rather than code, it says so.

The question answered: *which M4 telemetry gaps would stop the final Control Tower from showing real execution accurately?* The prototype is driven by a fixture. The real product will be driven by what MACH writes to disk. This document compares the two.

---

## 1. Summary: the gaps that matter, in order

1. **Nothing is visible inside an execution.** One M4 execution is a single `claude -p` process that runs the whole belt workflow for one ticket, often through plan, build, verify and review in one go (`supervisor.start` → `executor.command`, `until` is `merge` unless merging is allowed). The Factory records only `work.claimed`, `execution.started` and then `execution.completed`/`execution.failed`. Agents, tool calls, station steps, test runs and votes all happen in between and produce no event. *Without fixing this, the picture shows a cell sitting in one place for 3 to 10 minutes and then jumping to `approved`.* The only record of what happened inside is the raw `stream.jsonl`. The executor keeps it on disk but reads only `session_id`, `permission_denied` and the final `result` (`executor.outcome`).

2. **Station transitions are sampled, not recorded.** The only stage event, `station.observed`, comes from the supervisor's `Supervisor.observe`. It compares the stage in each cell's `cell.json` with the last stage it saw, and it runs only once per supervisor tick (`poll_seconds`, default 300 s, minimum 30, `policy.py`). Stages passed between two ticks are never reported: `built → verified → approved` in one execution shows up as one `built → approved`. A failed verification leaves the stage at `built` (`verify.cmd_finish`: `"verified" if status == "PASS" else "built"`), so **a verification failure and its return to build produce no stage change at all**. The `at` of `station.observed` is when the supervisor looked, not when the stage changed. *Without a fix, the picture would leave out stations, leave out the failure/revise loop, and get its timing wrong by up to a poll interval.*

3. **No stable identity for agents, tool calls, station visits or review seats.** The envelope has IDs for wave, slice, revision, ticket, runner and execution, but none for an agent run, a tool call or a station visit. `cause` is never set by any emitter: there is no `cause=` anywhere in `skills/run/scripts/`. MACH holds no agent ID at all. Claude Code's own IDs (`tool_use_id`, the sub-agent `agent_id`, `parent_tool_use_id`) exist only inside `stream.jsonl`. *Without a fix, the picture cannot reliably say which reviewer wrote which finding, which agent made which tool call, or which event caused which.*

4. **Only supervisor-run work is visible.** Station scripts write files and no events. `events.jsonl` is written only by intake/scheduler code (`intake.Factory.emit`) and the supervisor. Work an engineer drives by hand (`/mach-run`, or a belt they start themselves) gets no `station.observed` unless a supervisor happens to be ticking. Work on any ticket outside the intake ledger is never observed, because `observe()` iterates `plan["slices"]`. That includes hand-made `LOCAL-*` tickets, `AUTO-*` telemetry tickets, and the `factory-tuning` ticket that `belt.js` runs *inside another ticket's execution* without a claim (inference from `belt.js` lines 170–184). *The picture would show some real work and leave out the rest without saying so.*

5. **Cost and duration exist only for a whole execution.** `execution.completed.cost_usd` is the run's `total_cost_usd`. The executor drops `duration_ms`, `num_turns`, `usage` and the per-model `modelUsage` from the same `result` message. No cost, token or duration figure exists per station, per agent or per seat. Station scripts record a few times of their own (build task `at`, test `seconds`, verify `started_at`, review `started_at`/vote `at`/`decided_at`), but not start and end times for a station visit. *Without a fix, cost per agent or per station would be invented.*

6. **Scheduler decisions are partly invisible.** `dependency.blocked` deliberately leaves out capacity waits (`intake.Factory.record` filters `"waiting for a free place"`). Slices that are ready but waiting for a place appear in no event. `scheduling.decided` only fires when the decision differs from the previous one (`Supervisor.decided`), and it lists dispatched slices, started tickets and held items but not the eligible-but-unchosen ones. `dependency.resolved` does not say which integration unblocked the slice (`cause` is null). *The picture can show "blocked" and "ready", but not "waiting for a place", and cannot draw the edge from an integration to the slice it freed.*

7. **Station records are mutable snapshots, not histories.** `cell.json` keeps only the current `stage` and an `updated_at` that is overwritten on every write. Failed build attempts (a `red` refused because the suite passed, a `green` refused because the suite failed) are not persisted, only printed (`BuildError`). Verify's `INCOMPLETE_EVIDENCE` is not persisted. A re-recorded verify check overwrites the earlier one. A merge conflict during revalidation is not persisted (`MergeError`). Cleanup deletes the cell folder, which keeps an archive but leaves every `refs.cell` path dangling. *A replay rebuilt from files after the fact would leave out the retries and refusals that make the factory look like a factory.*

8. **The privacy boundary for an inspector is not defined.** `stream.jsonl` contains tool inputs, absolute paths and whole file contents (M5 POC: `tool_use_result.originalFile` on every Edit). Station files contain model-written prose, test output tails and a person's name (`human_approval.by`, the PM `actor` in `intent.md`). M4 says the stream "must stay local", but nothing defines what an observer may forward to a browser. *Without a defined boundary, the first real inspector either shows secrets or shows nothing.*

---

## 2. What exists today

### 2.1 The event log: `.factory/intake/events.jsonl`

| Property | Fact (code) |
|---|---|
| Writer | Only `intake.Factory.emit` (which queues) and `intake.Factory.save` (which appends). Callers: `intake.py` (intake/scheduler), `supervisor.py`, `activation.py`. No station script writes it. |
| Envelope | `{"schema_version": 2, "seq", "at", "type", "project_id", "source_commit", "wave_id", "slice_id", "revision", "ticket_id", "runner_id", "execution_id", "source", "cause", "refs", "data"}` (`emit`; schema `factory-event.schema.json`, `additionalProperties: false`). |
| `seq` | Taken from `ledger["next_seq"]`, so it increases by one per event across the whole project. All writers hold `Factory.lock` (an exclusive lock file, `.factory/intake/lock`) while they emit and save. One total order. |
| `at` | `intake.now()`: UTC, **whole seconds**, `%Y-%m-%dT%H:%M:%SZ`. Stamped when the event is *queued* (`emit`), not when it is appended. Several events often share one second. |
| `source` | `intake`, `engineer` (activation), or `supervisor` (after `Supervisor.attach`). |
| `cause` | Defined in the schema. **Never set by any caller**, so always `null`. |
| `refs` | Set only on `revision.discovered`, `station.observed`, `execution.started`, `execution.completed`/`failed` and some `human.required`. Holds project-relative paths (`.factory/worktrees/<t>/cell.json`, `.factory/local/executions/<x>/`). |
| Durability | Outbox pattern: the event goes into `ledger["pending_events"]`, the ledger is written atomically (`write_atomic`: tmp + `os.replace`), events with `seq > last seq in file` are appended, and the ledger is written again with an empty queue. Nothing is lost, and no event is duplicated by a re-save. **There is no `fsync`.** Inference: a crash in the middle of a line leaves a partial line. The next append is concatenated onto it, and `events()` skips the unparsable result, so that event is lost to readers. |
| Reading | `run.py product events --since N` → `Factory.events(since)` reads the whole file. `save` also reads the whole file to find the last `seq`, so each save costs O(file size). |
| Retention | Never rotated or truncated. |
| Granularity | Ledger transitions only (intake, scheduler, supervisor). Nothing below an execution. |

#### Event kinds (`intake.EVENT_TYPES`)

| `type` | Emitted by (file:function) | When | `data` fields | Notes on granularity and timing |
|---|---|---|---|---|
| `wave.discovered` | `intake.py:_intake` | First intake of a wave ID | `slices`, `approval` (+ envelope `wave_id`, `revision`) | Once per wave ID. |
| `intake.validated` | `intake.py:_intake` | Each new wave content digest taken in | `digest` | |
| `intake.refused` | `intake.py:_intake` | Verification failed; once per distinct refusal | `problems` | Followed by `human.required`. |
| `slice.materialized` | `intake.py:materialize`, `reissue` | A ticket now exists for a slice revision | `digest`, `adopted`, `dependencies`, (`reissued`) | Carries `ticket_id`. This is the "wave becomes tickets" moment. |
| `slice.integrated` | `intake.py:record` | The plan first sees the slice's commit on the integration branch | `commit` | `at` is when the plan noticed, not when it merged. Merge time is in `cell.json.merged.at` until cleanup, then in the archive. |
| `dependency.resolved` | `intake.py:record` | The slice's plan state becomes `ready` | `depends_on` (IDs only) | No cause; does not say which integration freed it. |
| `dependency.blocked` | `intake.py:record` | The state becomes `blocked`, or its reasons change | `reasons` (English sentences) | **Capacity waits are filtered out.** Reasons are prose, not structured. |
| `work.scheduled` | `intake.py:open_cell` | A cell was opened and finalized to `spec-ready` | `stage`, `risk`, `branch`, `by`, `authorization` | Product-sourced cells start at `spec-ready`. Grooming never runs for wave tickets. |
| `revision.superseded` | `intake.py:_intake` | A slice revision was replaced or withdrawn | `from_revision`, `effect` | |
| `human.required` | intake (`_intake`, `materialize`, `record`), supervisor (`park`, `schedule`) | A person must decide | `reason` (prose) | Covers `awaiting-human`, but only when a plan is recorded (on the next tick or the next intake). |
| `factory.activated` | `activation.py:confirm` | Enabled | `autonomy`, `by`, `limits`, `allow_merge`, `persistent`, `backlog`, `excluded_slices` | |
| `factory.paused` / `resumed` / `disabled` | `activation.py:change` | Engineer commands | `by`, `reason` / `retrying` / `stopped` | |
| `revision.discovered` | `supervisor.py:tick` | The ledger's source commit changed during a tick | `from_commit`, `commit` | |
| `scheduling.decided` | `supervisor.py:decided` | Once per *distinct* decision | `state`, `dispatched[]`, `started[]`, `held[{slice_id|ticket_id, why}]` | Not emitted when the decision repeats. Leaves out ready slices waiting for a place. |
| `work.claimed` | `supervisor.py:start` | Before any process | `stage`, `next`, `attempt` | `execution_id` is set. |
| `execution.started` | `supervisor.py:start` | After `executor.launch` returns | `session_id`, `until`, `workflow`, `limits` | `at` is after the detached wrapper spawned. The real start is `started.json.started_at`. Does not show whether the Workflow tool actually started. |
| `station.observed` | `supervisor.py:observe` | A tick sees a different `cell.json.stage` | `from_stage`, `stage` | **Sampled once per tick.** Intermediate stages are lost. Only for tickets in the intake ledger. |
| `recovery.started` | `supervisor.py:recover`, `serve` | Reconciling earlier executions or a dead supervisor | `kind` (`ended-while-unwatched`, `still-running`, `claim-never-started`, `outcome-unknown`, `took-over-from-dead-supervisor`), `previous_pid`, `previous_heartbeat` | |
| `execution.completed` | `supervisor.py:finish` | The ticket moved, or it stopped with a known outcome | `stage`, `next`, `waiting_for`, `how`, `seen_to_end`, `cost_usd`, `session_id`, `refused_tools` | Emitted at the next tick after the process ended (`recover` → `finish`). `at` can be up to `poll_seconds` late. The true end is `result.json.ended_at`. |
| `execution.failed` | `supervisor.py:finish` | Ended without moving | `stage`, `next`, `how`, `claude_error`, `exit_code`, `attempt`, `session_id` | |

### 2.2 The ledger: `.factory/intake/ledger.json`

Written atomically by `Factory.save` under the lock. It holds current state, not history.

| Section | Relevant fields | Use for the picture |
|---|---|---|
| `waves[id]` | `revision`, `digest`, `slices`, `approval`, `first_seen_commit` | Wave membership |
| `slices[id]` | `ticket_id`, `dependencies`, `state`, `materialized_at`, `dispatched_at`, `integrated{commit, verified_at}`, `built_against`, `last_state`, `last_reasons`, `last_attention`, `owner`, `history[]` | The slice ↔ ticket identity map; dependency edges |
| `supervisor.executions[x]` | `execution_id`, `ticket_id`, `slice_id`, `state` (`claimed|started|finished|unknown|released`), `claimed_at`, `started_at`, `ended_at`, `runner_id`, `instance`, `session_id`, `stage_at_start`, `action_at_start`, `until`, `attempt`, `wrapper_pid`, `how`, `exit_code`, `cost_usd`, `refused_tools`, `stage_at_end`, `next_at_end`, `moved`, `stop_requested_at` | The execution identity map; execution ↔ session ID |
| `supervisor.attempts`, `parked`, `observed`, `told`, `last_decision`, `last_tick` | | |

### 2.3 Per-execution folder: `.factory/local/executions/<execution_id>/` (folder mode 0700)

| File | Writer | Contents | Timing |
|---|---|---|---|
| `spec.json` | `executor.prepare` | `argv` (**full command line, including the allow list**), `cwd`, `timeout_seconds`, `prepared_at` | Before launch |
| `started.json` | `executor.wrapper` | `wrapper_pid`, `child_pid`, `started_at` | When `claude` was spawned |
| `stream.jsonl` | `executor.wrapper` (the child's stdout, raw bytes) | Claude Code `stream-json --verbose` output, **unparsed and complete** | Written live as the run goes; the file grows while it runs |
| `stderr.log` | wrapper | Claude's stderr | Live |
| `wrapper.log` | `executor.launch` | The wrapper's own output | Live |
| `result.json` | `executor.wrapper` | `ended` (`exited|timed-out|interrupted|could-not-start`), `exit_code`, `ended_at`, `seconds` | At the end |

**What `executor.outcome` reads from `stream.jsonl`**: the first `session_id` seen on any line; every `{"type":"system","subtype":"permission_denied"}` (summarized as program plus subcommand by `tool_summary`); and the last `{"type":"result"}`, from which it keeps `is_error`, `subtype`, `total_cost_usd`, `permission_denials` and, from the `result` text, the workflow's per-ticket `{ticket, outcome, stage, waiting_for}` (the belt's `stations[]` list is dropped). **Everything else is kept on disk and ignored**: `system/init` (model, tools, agents), every `assistant` message (`tool_use` blocks with `id`, `name`, `input`), every `user` message (`tool_result`, `tool_use_result`), `system/task_*` sub-agent notifications, and the `result` fields `duration_ms`, `num_turns`, `usage` and `modelUsage`. Nothing is pruned: no code removes execution folders.

### 2.4 Station records (files the stations write; none emit events)

| Record | Writer (file:function) | Fields with timing or identity | Atomic? | Overwritten or appended |
|---|---|---|---|---|
| `cell.json` | `cell.py:write_cell`, `build.py:Cell.save_info`, `verify.py:Cell.save_info`, `review.py:Cell.save_info`, `merge.py:Cell.save_info`; also `intake.py:open_cell` (atomic) | `stage`, `created_at`, `updated_at` (on every write), `risk`, `app_type`, `branch`, `mode`, `product{slice_id, revision, wave_id, digest, source_commit}`, `verification`, `review`, `human_review_required`, `revalidated{head, onto, at, tests}`, `merged{commit, at, method, landed_commit}`, `pull_request` | **No**, except in intake (`path.write_text`) | Overwritten. **No stage history.** |
| `intent.md`, `spec.md`, `spec.json`, `plan.md` | intent skill / `cell.py finalize`, `check-plan`; contract engineer | No timestamps inside; only file mtime | No | Overwritten. `plan.md` boxes are ticked by `build.py:tick_plan`. |
| `build.json` | `build.py:Cell.save` | `started_at`, `updated_at`, `loop`, `suite` (`unknown|red|green`), `baseline`, `baseline_run`, `test_cmd`, `tasks[]` (`id`, `kind`, `text`, `ids`, `files`, `status`, `commit`, `files_changed`, `note`, `at`, `loop`, `first_run` `pass|fail|not-run`, `failure_tail`, `test_run{exit_code, seconds}`), `deviations[]` (`task`, `type`, `detail`, `loop`, `at`), `test_files` | No | Overwritten as a whole; a task's `at` is its *completion*. **Task start and refused attempts are not recorded.** |
| `build-report.json` | `build.py:cmd_finish` (merge rewrites `head`) | `finished_at`, `head`, `review_loop`, `tests{exit_code, seconds, ...}`, `lint`, `tasks[]`, `tests_seen_failing_first`, `deviations`, `files_changed`, `diff` | No | Overwritten each finish |
| `review-findings-<loop>.md` | `build.py:cmd_revise` | Copied findings | No | One per revision |
| `evidence/results.json` | `verify.py:Cell.save` | `started_at`, `started_epoch`, `head`, `review_loop`, `suite{...}`, `contracts{...}`, `records{ID: {kind, result, note, evidence[{file, sha256, bytes}], at}}`, `tools_available` | No | Records keyed by ID. **A re-record overwrites.** |
| `evidence/summary.json` | `verify.py:cmd_finish` | `status` (`PASS|FAIL_WITH_EVIDENCE`), `checks{ID: {kind, result, note, evidence}}`, `failures`, `head`, `review_loop`, `timestamp`, `evidence_files` | No | `INCOMPLETE_EVIDENCE` is **not written** |
| `evidence/findings.md`, `test-suite.log`, `contract-check.log`, evidence files | `verify.py` and the verifier | Logs carry a timestamp in the text | No | An earlier run moves to `evidence/previous-N/` (kept) |
| `review/round-N/packet.json` | `review.py:cmd_start` | `round`, `max_rounds`, `risk`, `approvals_needed`, `human_approval_required`, `human_approval_reasons`, `head`, `started_at`, `panel[{role, focus, model}]`, `delta{since_commit, files_changed, earlier_blocker_files}`, `tuning` | No | Restarting a round **deletes its votes** |
| `review/round-N/votes/<role>.json` | `review.py:cmd_submit` | `reviewer`, `vote`, `summary`, `findings[{severity, rule, file, title, ...}]`, `head`, `at` | No | One per seat; never revised |
| `review/round-N/decision.json` and `review/decision.json` | `review.py:cmd_tally`, `cmd_approve_human`; `merge.py:void_approval`, `send_back` | `outcome`, `round`, `approvals`, `votes`, `blockers`, `security_veto`, `human_approval{by, note, recorded_at, recorded_by}`, `decided_at`, `head`, `rejected_by`, `void_reason` | No | Overwritten. Human approval **replaces** `AWAITING_HUMAN` with `APPROVED` in place. |
| `review/merge-findings.md` | `merge.py:send_back` | | No | |
| `.factory/archive/<t>.tar.gz` | `cleanup.py:write_archive` | The whole cell folder except `repo/` | Written before deletion | Never overwritten |
| `.factory/archive/runs.jsonl` | `cleanup.py:cmd_run` | `record_version`, `ticket_id`, `slice_id`, `product{...}`, `integration{...}`, `outcome`, `rounds`, `verify_failures`, `review_rejections`, `escalated`, `human_approval` (bool), `deviations`, `blockers`, `notes`, `verify_findings`, `tests_seen_failing_first`, `created_at`, `closed_at`, `archive` | Append, no fsync | **No `execution_id`, cost, or durations** |
| `.factory/observations/metrics.json`, `observation-<date>.md`, `last-pass.json` | `observe.py:cmd_collect`, `cmd_report` | Aggregate scorecard; `last-pass.json.at` | No | |
| Git history of `feature/<ticket>` in `repo/` | `build.py:commit`, `merge.py` | One commit per task, `{prefix}({slice}): {task} ... [{ticket}]`; commit time; author is the engineer's Git identity | Git | Append; deleted with the branch at cleanup unless it was merged |

Timestamp formats differ: intake, supervisor and executor write `YYYY-MM-DDTHH:MM:SSZ`, while the station scripts write `isoformat(timespec="seconds")` (`+00:00`). Both are UTC with one-second resolution.

### 2.5 The Dynamic Workflow (`workflows/belt.js`)

The workflow script holds no state of its own on disk. It calls `phase()` (Preflight, Groom, Build, Verify, Review, Wrap up, Learn), `log()` (review tally, per-ticket outcome) and `agent()` with a `label` (for example `"<ticket>: build"` or `"<ticket>: security reviewer"`), a `phase`, a `model` or `agentType`, and for the clerks a `schema`. Every "what next?" goes through a Haiku "clerk" agent that runs `run.py next <t> --headless`. **`run.py next` only reads**, so the belt's step-by-step decisions are persisted nowhere. The return value, `{tickets:[{ticket, outcome, stage, waiting_for, reason, stations[]}], learning, ...}`, ends up in the `result` message. The executor keeps four fields of each ticket and drops `stations`.

Whether `phase()`, `log()`, agent labels and the workflow's sub-agent messages appear in the parent `claude -p` stream cannot be determined from MACH's code (section 7).

### 2.6 Hooks

MACH installs **no Claude Code hooks**. `service.py:install_hooks` adds *Git* hooks (`post-merge`, `post-checkout`, `post-rewrite`) that run `factory wake`. That only touches `.factory/local/wake` to make the supervisor tick early (`supervisor.wake`), and carries no data. Executions run with `--restricted`, which per M4_DESIGN §3.2 does not load the person's hooks ("hooks | `hook_started` / `hook_response` events | none"). The plugin (`.claude-plugin/plugin.json`) declares no hooks, and there is no `hooks/` folder. Whether a plugin's own hooks would load under `--restricted --plugin-dir` was not tested (section 7).

---

## 3. Need versus availability

Legend: **E** = available as an event now. **D** = derivable by watching files the stations already write. **S** = present only in Claude Code's stream (`stream.jsonl`) or transcript. **—** = not available at all. Where a need has several sources, the best is listed first.

| # | The experience must show | Status | Where, and how good |
|---|---|---|---|
| 1 | An approved wave arriving | **E** | `wave.discovered`, `intake.validated`. Timely to the intake run. |
| 2 | The wave becoming tickets | **E** | `slice.materialized` per slice, with `ticket_id` and `dependencies`. |
| 3 | Dependency edges | **E** / D | `slice.materialized.data.dependencies`; `ledger.slices[*].dependencies`. |
| 4 | What is runnable now | D | `run.py product plan` (`dispatchable`, `runnable`), a read-only snapshot. Not an event. |
| 5 | What waits and why | **E** (partial) | `dependency.blocked.reasons` (prose). **Capacity waits are missing** (filtered). Supervisor holds are in `scheduling.decided.held[].why`, but only on a change. |
| 6 | What becomes eligible, and when | **E** (partial) | `dependency.resolved`. `at` is when the plan was recorded, not when the dependency merged. No causal link (`cause` null). |
| 7 | Dispatch | **E** | `work.scheduled` (`by`, `authorization`). |
| 8 | A Dynamic Workflow starting for a ticket | **E** (approximate) / S | `execution.started` (`workflow: "mach:belt"`, `session_id`). Whether the Workflow tool really started is only in the stream: an `assistant` `tool_use` with `name: "Workflow"` (inference from the prompt in `executor.prompt`). Executor: **stored, not parsed**. |
| 9 | The station a cell is in | D / **E** (sampled) | `cell.json.stage`, watched directly (seconds late, but transitions between two reads are lost). `station.observed` (up to `poll_seconds` late, intermediate stages lost). |
| 10 | When a cell entered and left a station | — / D (partial) | No stage history anywhere. Approximations: `build.json.started_at` (build entered), `build-report.json.finished_at` (built), `results.json.started_at`, `summary.json.timestamp`, `packet.json.started_at`, `decision.json.decided_at`, `revalidated.at`, `merged.at`, `runs.jsonl.closed_at`. Planning has no time except file mtimes. |
| 11 | Each agent that runs: role, review seat, model tier | S / D (partial) | Stream: sub-agent start and stop as `system/task_started`, `task_progress`, `task_notification`, and/or messages carrying `parent_tool_use_id`. That is observed for `Agent` in the M5 POC; for the Workflow tool's agents it is unverified (section 7). Seat roles and models: `packet.json.panel[]` (D). Builder and verifier models: `agents/*.md` frontmatter (`builder: sonnet`, `verifier: sonnet`, `reviewer: sonnet` overridden per seat, `contract-engineer: opus`). Not recorded per run. Executor: **drops all of it.** |
| 12 | Agent start and stop times | S | As above. Nothing in MACH's files. |
| 13 | Tool activity: which tool, on what, how long, success or refusal | S (refusals: **E**) | Stream: `assistant.message.content[].tool_use {id, name, input}`, matched to `user.message.content[].tool_result {tool_use_id, is_error}`. Duration = the time between the two lines. The stream has no per-line timestamp as observed in the M5 POC; a tailer must stamp lines as they arrive (inference). Refusals: `system/permission_denied {tool_name, tool_use_id}` (and `agent_id` for sub-agents), plus `execution.completed.refused_tools` (program names only, one per execution). |
| 14 | Artifacts written: file, by whom, when | D (file and when) / S (by whom) | File mtimes in the cell folder and `repo/`; commit time and message per build task (`[ticket]`, task ID). *By whom* is only in the stream (`Write`/`Edit` `tool_use` from an agent, or the station script run through `Bash`). Mtime watching races with the non-atomic writes. |
| 15 | TDD progress per task: red, green, commit | D (good) | `build.json.tasks[]`: `status`, `first_run`, `commit`, `at`, `test_run.seconds`, `loop`; `build.json.suite`. One second resolution; completion time only. **Refused red or green attempts: —** (only in the stream, as the `Bash` `tool_result` text of `build.py`). |
| 16 | Verification as it runs: each scenario and matrix rule, evidence, pass/fail, verdict | D (good) | `results.json.records[ID]` (`kind`, `result`, `evidence[].file/sha256`, `at`). What must be proven (targets) is not persisted: recompute from `spec.json` the way `verify.py:Cell.targets` does, or read it from the stream (`verify.py start` output). Verdict: `summary.json.status`, `timestamp`. `INCOMPLETE_EVIDENCE`: —. |
| 17 | A verification failure and the return to build (revise round) | D | `summary.json.status == FAIL_WITH_EVIDENCE` (the stage stays `built`), then `build.json.loop` incremented with stage `building` and `review-findings-<loop>.md`. **No event**; `station.observed` cannot see the failure. |
| 18 | Reviewer fan-out: each seat starting | S / D | Seat set: `packet.json.panel[]` at `started_at`. Each seat's agent starting: only in the stream (the workflow's `parallel(agent(...))`). |
| 19 | Findings as they are submitted; votes | D (per seat, not per finding) | `votes/<role>.json` with `at`, written once per seat with all its findings. Individual findings are never submitted one at a time. |
| 20 | The consensus decision; delta-review rounds | D | `round-N/decision.json` (`outcome`, `votes`, `blockers`, `security_veto`, `decided_at`). Delta: `packet.json.delta`. Round numbers follow judging rounds (`build-report.review_loop + 1`), so after a verify failure the first review is `round-2`. |
| 21 | Human approval gate: requested, waiting | D / **E** (late) | `decision.json.outcome == AWAITING_HUMAN` with `decided_at`, `human_approval_reasons`; `human.required` at the next recorded plan (reason prose, e.g. "waiting for human-approval"). |
| 22 | Who approved, and when | D | `decision.json.human_approval{by, recorded_at}`. `by` is a typed name, not an authenticated identity. No event; `station.observed` sees `awaiting-human → approved` at the next tick. |
| 23 | Merge revalidation | D (outcome only) | `cell.json.revalidated{head, onto, at, tests}` on success; `review/merge-findings.md` plus `decision.json.rejected_by` on a failing suite. Start: —. Conflict: — (printed only). Approval voided: `decision.json.outcome == VOID`. |
| 24 | Integration | D / **E** | `cell.json.merged{commit, at, method}`; `stage` `pr-open`/`merged`; then `slice.integrated` once the plan sees the commit on the integration branch. |
| 25 | Cleanup and the run record | D | `runs.jsonl` line (`closed_at`, `archive`); the cell folder disappears. No event. |
| 26 | Cost per execution | **E** | `execution.completed.cost_usd`. |
| 27 | Duration per execution | D | `started.json.started_at`, `result.json.ended_at`, `seconds`. Event times are late (see 2.1). |
| 28 | Cost and tokens per agent, station or seat | S (partial) / — | The `result` message's `modelUsage` gives per-model cost for the whole run (M4_DESIGN §3.4). Per-agent: only if sub-agent usage appears in `task_notification` or `result` (section 7). Executor: **dropped**. |
| 29 | A single ordered, replayable timeline | **E** (coarse) / — (fine) | `seq` orders ledger events. There is no shared order across ledger, station files and streams; see section 5.2. |
| 30 | Stable IDs tying an event to wave, slice, ticket, cell, execution, station, agent, tool call | **E** (up to execution) / S (agent, tool) / — (station visit) | See section 5.1. |

---

## 4. Each gap in detail

For every gap: what is missing, why it matters, the smallest faithful fix, cost and risk, and whether the fix touches the Factory's execution path. **M6.0 changes none of this.** These are recommendations for later milestones.

### G1. No visibility inside an execution

- **Missing.** Agents, tool calls, station steps and their timing within one `claude -p`.
- **Why it matters.** This is most of what the Living Factory animates. Without it, every cell sits still for minutes and then teleports.
- **Smallest faithful fix.** An **out-of-process stream tailer** in the observer. It reads `.factory/local/executions/<x>/stream.jsonl` by byte offset while it grows and after it ends, and turns it into derived events (section 6: `agent.started`, `agent.finished`, `tool.called`, `tool.finished`). It stamps each line with the time it was read (ms) and keys everything by `execution_id`, plus Claude's `tool_use_id` / `agent_id` / `parent_tool_use_id`. It needs no change to MACH: the file is already kept complete.
- **Cost and risk.** Moderate. The stream format belongs to Claude Code and can change (`claude_code_version` is in `system/init`; pin a parser per version). Visibility of the belt's sub-agents in the parent stream is unproven (section 7); if they are not there, the fallback is the session transcripts Claude Code writes (inference: under the Claude config folder, keyed by the `--session-id` MACH already sets). Reading the file is safe: the wrapper only appends. Live timing requires polling; after-the-fact timing is only as good as the arrival stamps, because stream lines carry no time of their own (inference from the M5 POC sample, which shows none).
- **Execution path.** None, if it stays a reader. Later and optionally: `executor.outcome` could keep `duration_ms`, `num_turns` and `modelUsage` (see G5). That changes bookkeeping only, not behaviour.

### G2. Station transitions sampled, not recorded

- **Missing.** Stage entry and exit with times; stages passed between ticks; the verify-fail loop, which never changes the stage.
- **Why it matters.** The route through stations, gate closures and the "back to build" animation are the core story.
- **Smallest faithful fix (recommended).** Each station script appends one line per transition and gate result to a **cell-local append-only log**, `.factory/worktrees/<t>/events.jsonl`, through one shared helper (fsync, `O_APPEND`, one write per line, its own per-cell `seq`). Kinds: `station.entered`, `station.exited`, `gate.decided` (section 6). The log travels into the archive at cleanup, because the archive keeps everything except `repo/`. It must **not** go through the intake ledger: stations would then take the intake lock, which is held during `reconcile` (including a possible `git fetch`). That couples the line to the Factory and can stall a station.
- **Cheaper interim fix (no MACH change).** A file watcher on `cell.json` (stage), `build.json`, `results.json`, `summary.json`, `round-N/*`. It catches most transitions within a second, but can miss two writes made close together (e.g. `verify finish` followed at once by `review start`) and must retry partial reads, because every station write is non-atomic `write_text`.
- **Cost and risk.** Small: one helper and roughly a dozen call sites. Risk: a write failure must never fail a station, so the helper swallows its own errors.
- **Execution path.** Yes, it touches station scripts (a later milestone). The watcher alternative touches nothing.

### G3. No identity below the execution

- **Missing.** IDs for agent runs, tool calls, station visits and review seats; causal links.
- **Why it matters.** The inspector must answer "who did this, in which visit, because of what". Parallel cells must not be confused.
- **Smallest faithful fix.**
  - Station visit: `visit_id = <ticket>/<stage>/<n>`, where `n` counts entries per cell (written by the G2 helper). For build and verify, the existing `loop` / `review_loop` already numbers rounds.
  - Review seat: `<ticket>/review/round-<N>/<role>`; it is already unique by construction (`votes/<role>.json`, one vote per seat per round).
  - Agent run: Claude's own sub-agent ID (`agent_id` on `permission_denied`, per M4/M5; to be confirmed for `task_*` messages) or the `tool_use_id` of the spawning `Agent`/`Workflow` call. Namespace it with `execution_id` (`x…/toolu_…`).
  - Tool call: `execution_id/tool_use_id`.
  - Causality: actually populate `cause` (for example `dependency.resolved.cause` = the `seq` of the `slice.integrated` that freed it; `execution.*` → the `work.claimed` seq).
- **Cost and risk.** Low for `cause` (all in `intake.py` and `supervisor.py`). For agents and tools it depends on the stream fields (section 7).
- **Execution path.** `cause` is emitted by the scheduler and supervisor: a bookkeeping change, not a behavioural one.

### G4. Only supervisor-run, ledger-tracked work is visible

- **Missing.** Engineer-driven runs; tickets outside the ledger (`LOCAL-*`, `AUTO-*`, `factory-tuning`); the observe pass and tuning ticket the belt runs inside an unrelated execution.
- **Why it matters.** The picture would quietly leave out real work, and attribute a tuning ticket's cost and time to the ticket whose execution it ran in.
- **Smallest faithful fix.** G2's cell-local log covers every cell whoever drives it. The observer discovers cells by listing `.factory/worktrees/*/cell.json` (as `run.py:cmd_board` does) and archives, not by reading the ledger. For the belt's extra work: `executor.outcome` already parses the workflow result; keeping its full `tickets[]` (including `stations`) would at least record that a second ticket ran in the execution.
- **Cost and risk.** Low once G2 exists.
- **Execution path.** G2 (stations) plus a parsing change in `executor.outcome`.

### G5. Cost and duration only per execution

- **Missing.** Duration and cost per station, agent and seat; tokens.
- **Why it matters.** The brief asks for cost and duration per execution, which exists. Per-agent figures shown without data would be fabricated.
- **Smallest faithful fix.** (a) Keep `duration_ms`, `num_turns` and `modelUsage` from the `result` message in `executor.outcome` and add them to `execution.completed.data` (proposed field names `duration_ms`, `turns`, `model_usage{model: {cost_usd, input_tokens, output_tokens}}`). (b) Per-agent cost only if sub-agent completion messages carry usage (section 7). Otherwise the UI shows cost per execution and per model, and labels anything finer as unavailable. (c) Station durations come from G2.
- **Execution path.** (a) is a bookkeeping change in `supervisor.finish` / `executor.outcome`.

### G6. Scheduler decisions partly invisible

- **Missing.** Ready-but-waiting-for-a-place; the full picture of each decision; causal unblocking.
- **Smallest faithful fix.** Stop filtering capacity waits, or add a kind `slice.queued {position, active, max_parallel}` emitted by `intake.Factory.record` when a ready slice is not dispatchable. Give `dependency.resolved` a `cause` (G3) and `data.unblocked_by: [slice_id]`. Optionally emit `scheduling.decided` on every tick that has any decision, with a `repeat: true` flag, so a replay can show the factory "thinking".
- **Cost and risk.** Low. Risk: more events per tick; keep the "once per distinct change" rule and add only the queued state.
- **Execution path.** Scheduler bookkeeping only; no change to what is dispatched.

### G7. Snapshots, not histories

- **Missing.** Refused red/green attempts, re-recorded verify checks, `INCOMPLETE_EVIDENCE`, merge conflicts, the restart of a review round (votes deleted).
- **Why it matters.** Retries and refusals are honest signals of the line at work; the brief asks for "retries".
- **Smallest faithful fix.** The G2 helper writes `gate.decided` with `verdict: refused` at each `BuildError`, `VerifyError` and `MergeError` raise site that represents a gate, not a usage error. Interim, without MACH changes: the stream holds each station script's printed refusal as the `tool_result` of the `Bash` call.
- **Execution path.** Station scripts (later).

### G8. No redaction boundary

- See section 5.7. **Fix:** a written allow list of fields the observer may forward (section 6 marks each proposed field as safe or local-only), enforced in the observer, never in the browser.

---

## 5. Cross-cutting problems

### 5.1 Identity

| Entity | Stable ID today | Where | Problem |
|---|---|---|---|
| Wave | `wave_id` (+ `revision`, `digest`) | ledger, events | Fine. |
| Slice | `slice_id` (+ `revision`, `digest`) | ledger, events, `cell.json.product` | Fine. A slice can have several tickets over time (`history`, `reissue`). |
| Ticket | `ticket_id` | everywhere | Local IDs can collide between machines (M4 §8.13). |
| Cell | none of its own; `ticket_id` is the key (`.factory/worktrees/<t>`) | | A reissued ticket gets a new ID, so in practice it is unique; a cell recreated after cleanup reuses the path. Use `ticket_id + created_at`. |
| Execution | `execution_id` (`x` + 12 hex) and `session_id` (UUID) | ledger, events, folder | Fine. Hand-run belts have neither. |
| Station visit | **none** | | Proposed `ticket/stage/n` (G3). |
| Build round | `build.json.loop`, `build-report.review_loop` | | Fine. |
| Review round | `round-N` folder, `packet.round` | | Numbered by judging round, not review count (first review can be `round-2`). Restarting a round reuses N and deletes its votes. |
| Review seat | `round-N` + `role` | `packet.panel`, `votes/<role>.json` | Fine. |
| Agent run | **none in MACH** | stream only (`agent_id`, `tool_use_id`) | Section 7. |
| Tool call | **none in MACH** | stream (`tool_use_id`) | Unique within a session; namespace with `execution_id`. |
| Artifact | path + sha256 (evidence only), commit SHA (build tasks) | | Other artifacts have no content hash or version. |

**Correlating parallel cells.** Ledger events always carry `ticket_id` and `execution_id`. Station files are under their ticket's folder. Stream lines belong to one execution and therefore one ticket. The exception is the belt's tuning or observe work inside another ticket's execution (G4). The correlation join is execution → ticket (ledger), then ticket → slice → wave (ledger, `cell.json.product`).

### 5.2 Ordering and clocks

- The ledger's `seq` is a true total order **for ledger events only**.
- Station files, stream lines and ledger events share no counter. The only common axis is wall-clock UTC at **one-second** resolution (stream lines have none). Several processes write concurrently: the supervisor, the detached wrapper, the `claude` child, station scripts, and up to `max_parallel` cells.
- Event `at` is often **not** when the fact happened: `station.observed` and `slice.integrated` are stamped at observation; `execution.completed` is stamped at the next tick after the end; `emit` stamps at queue time.
- **Recommendation.** The observer builds its timeline from **fact time, where a record has one** (`cell.json` field times, `build.json.tasks[].at`, `result.json.ended_at`, the arrival stamp of stream lines), and keeps the ledger `seq` as a tie-breaker and as the order for ledger facts. Each timeline item carries both `occurred_at` (best known fact time, with a precision flag: `exact`, `second`, `observed`, `inferred`) and `observed_at`. New emitters (section 6) should write milliseconds (`at_ms`) and use one machine clock; all writers are on one machine (M4 §5), so skew is not a concern. Monotonic clocks are not comparable across processes, so wall clock is used.

### 5.3 The granularity gap

`supervisor.tick` sees an execution as one opaque span. Inside it (M4 §3.4 live runs: 136–432 s) the belt makes up to 16 steps (`MAX_STEPS`). Each step is a clerk agent (Haiku) followed by a worker agent, plus three parallel reviewer seats and a tally clerk per review. Run.py's step decisions are not persisted. A faithful view of one execution needs G1 (stream) for agents and tools and G2 (station logs) for stations and gates. Neither alone is enough: the stream says *who did what*, the station logs say *what the line accepted*. Recorded gate results must outrank inferred agent activity, as ARCHITECTURE.md item 8 already says.

### 5.4 Sub-agents inside the Dynamic Workflow

From outside, MACH knows: the execution, its session, its end, its cost, the refusals, and the workflow's final JSON (four fields per ticket). M4_DESIGN states that `stream.jsonl` "holds each run's event stream, including sub-agent activity" (§10) and that workflow agents' refusals carried "the worker's `agent_id`" (§3.4). How completely the Workflow tool's `agent()` calls, their labels, `phase()` and `log()` appear in the parent stream is **not shown by any code or test in this repository** (section 7). Nesting is real: the `plan` step's agent runs the intent skill, which starts the `contract-engineer` agent, so agents can sit three deep (execution → workflow agent → sub-agent).

### 5.5 Restart, recovery and replay

- Ledger events can be replayed from `seq` 1. They are durable by the outbox, apart from the partial-line risk in 2.1 (no fsync).
- Execution folders keep everything, including the full stream, so agent and tool activity **can be rebuilt after the fact** if the stream is complete (section 7). Wall times inside it cannot, unless a tailer stamped lines live.
- Station history **cannot** be rebuilt: `cell.json` has no stage history and the station files overwrite. After cleanup the cell folder is gone, `refs.cell` dangles, and the archive tarball holds only the final snapshots plus `evidence/previous-N/`.
- Recovery itself is visible (`recovery.started` with `kind`). A run whose outcome is unknown has no result and an incomplete stream.
- The proposed cell-local log (G2) makes station history replayable and archives with the cell.

### 5.6 Retention and size

Nothing is pruned: `events.jsonl` (never rotated; every `save` re-reads it in full), `.factory/local/executions/*` (stream files can be large, because every Edit carries the whole original file), `runs.jsonl`, archives. The observer needs its own index (for example a byte offset per execution stream and the last `seq`) and must never rewrite or rotate MACH's files. A retention policy, and moving `save`'s last-seq read off a full scan, are for a later milestone.

### 5.7 Privacy and redaction

Never shown or forwarded beyond the local observer process:

- Tool inputs and outputs from the stream: `Bash` commands with arguments, `Edit` `old_string`/`new_string`, `tool_use_result.originalFile`, `Read` results, absolute paths. MACH's own rule (`executor.tool_summary`, M4 §6) is to record program and subcommand only.
- `spec.json` in each execution folder: the full `argv`, including the allow list and paths.
- Anything matching the credential pattern in `executor.CREDENTIAL_NAME_RE`; environment values; `credential_expires_at`, rate-limit details and `post_turn_summary.needs_action` (M5 POC §6).
- Test output: `failure_tail`, `output_tail`, `test-suite.log`, which can contain secrets or personal data from fixtures.
- People's names (`human_approval.by`, the PM `actor` written into `intent.md`, `factory.activated.by`). Show a role ("a person approved") unless the viewer is that machine's engineer.
- Ticket bodies and telemetry payloads: already redacted by the ticket station, but still data, never instructions.

Safe to show: IDs, stage names, gate verdicts, counts, durations, costs, tool *names*, relative artifact paths inside the cell, spec IDs (`FR-01`, `AC-02`, `R3`), evidence file names and hashes, finding titles with their rule IDs (they are model-written; show as text, never render as HTML).

### 5.8 The cost of observing

- Read without the intake lock. `ledger.json` is replaced atomically, and `events.jsonl` is append-only (read by offset; tolerate a partial last line).
- Station files are written non-atomically. A reader can see an empty or truncated JSON, so it retries on a parse error and never acts on a partial read.
- Never run `run.py product plan` or `next` at high frequency from the observer: `plan` calls Git for every slice (`Factory.work`), and `next` calls `git rev-parse`. Poll the files instead.
- Tailing streams must not hold file locks or change mtimes. Nothing the observer does may write under `.factory/` (ARCHITECTURE.md ADR-011: no operational dependency on the UI).

---

## 6. Proposed minimal event model for M6 (a proposal)

*Proposal only. Nothing here exists, and M6.0 implements none of it.*

### 6.1 Envelope

Keep version 2's fields and meaning. The schema has `additionalProperties: false`, so additions need **`schema_version: 3`**. Additions, all nullable:

| Field | Meaning |
|---|---|
| `at_ms` | Integer Unix milliseconds when the fact occurred (keep `at` for compatibility). |
| `observed` | `true` when the writer saw the fact after it happened (sampling), `false` when the writer is the actor. |
| `visit_id` | `<ticket>/<stage>/<n>` |
| `agent_run_id` | `<execution_id>/<agent_id or spawning tool_use_id>` |
| `tool_call_id` | `<execution_id>/<tool_use_id>` |
| `parent_id` | The enclosing span (`agent_run_id` of the spawner, or `visit_id`). |

Actually populate `cause`.

Two streams, one envelope:

- **Ledger stream** (`.factory/intake/events.jsonl`, existing writer, global `seq`): intake, scheduler, supervisor.
- **Cell stream** (`.factory/worktrees/<t>/events.jsonl`, new, `source: "station"`, per-cell `seq`): written by station scripts through one helper; archived with the cell.
- **Derived** (`source: "observer"`, never written into `.factory/`): made by the observer from `stream.jsonl`.

The observer merges the three by `at_ms`, then source rank (ledger, station, observer), then `seq`.

### 6.2 New kinds

| Kind | Source / emitted where | Required `data` | Show/local |
|---|---|---|---|
| `slice.queued` | ledger, `intake.Factory.record` | `position`, `active`, `max_parallel` | show |
| `station.entered` | cell, the station that sets the stage (`cell.py`, `build.py`, `verify.py`, `review.py`, `merge.py`) | `stage`, `from_stage`, `visit_id`, `round` | show |
| `station.exited` | cell, same sites | `stage`, `to_stage`, `visit_id`, `outcome` | show |
| `gate.decided` | cell: `audit` (build start), `red`, `green`, `done`, `finish` (build), `verify.finish`, `review.tally`, `merge.revalidate`, `merge.void` | `gate`, `verdict` (`passed|refused|failed`), `subject` (task or check ID), `reason_code`, `seconds` | show (no output text) |
| `build.task.completed` | cell, `build.py:complete` and `cmd_red --written-early` | `task_id`, `kind`, `first_run`, `commit`, `test_seconds`, `loop` | show |
| `verify.check.recorded` | cell, `verify.py:cmd_record` | `target_id`, `kind`, `result`, `evidence[{file, sha256}]`, `rerecorded` | show (no note text) |
| `review.round.started` | cell, `review.py:cmd_start` | `round`, `panel[{role, model}]`, `approvals_needed`, `human_approval_required`, `delta` (bool) | show |
| `review.vote.submitted` | cell, `review.py:cmd_submit` | `round`, `role`, `vote`, `blockers`, `notes`, `rules[]` | show |
| `review.decided` | cell, `review.py:cmd_tally` | `round`, `outcome`, `approvals`, `security_veto` | show |
| `approval.recorded` | cell, `review.py:cmd_approve_human` | `round`, `by_role` (not a name by default) | show |
| `merge.landed` | cell, `merge.py:cmd_run` | `method`, `merge_commit`, `revalidated` (bool) | show |
| `cell.cleaned` | ledger or cell, `cleanup.py:cmd_run` (before deleting, so it lands in the archive) | `outcome`, `rounds`, `archive` | show |
| `execution.completed` (extended) | ledger, `supervisor.finish` | adds `duration_ms`, `turns`, `model_usage`, `workflow_tickets[]` (with `stations`) | show |
| `agent.started` / `agent.finished` | observer, from `stream.jsonl` | `agent_run_id`, `parent_id`, `label`, `agent_type`, `model`, `phase`; on finish `status`, `duration_ms`, `cost_usd` if present | show |
| `tool.called` / `tool.finished` | observer, from `stream.jsonl` | `tool_call_id`, `agent_run_id`, `tool` (name), `target_class` (`cell-file|station-script|git|test|other`), on finish `ok|error|refused`, `duration_ms` | show; the raw input stays local |

That is 15 kinds, of which 4 are observer-derived and need no MACH change. It is enough to drive every item in the section 3 matrix truthfully, except per-agent cost, which depends on section 7.

---

## 7. What could not be determined from the code, and how to find out

1. **Whether the Workflow tool's sub-agents (belt `agent()` calls) appear in the parent `claude -p` stream, and in what shape** (`system/task_started|task_progress|task_notification`, messages with `parent_tool_use_id`, or nothing), and whether `phase()`, `log()` and `label` appear. M4_DESIGN §10 asserts "including sub-agent activity". The only code that parses sub-agent traffic (`docs/mach-next/poc/interview/bridge.py`) skips it. *How:* run one belt execution in a scratch project (M4 §9) and inspect `stream.jsonl`: `grep -c parent_tool_use_id`, list the distinct `type`/`subtype` pairs, and look for agent labels.
2. **Whether sub-agent transcripts exist on disk** for a `--session-id` run under `--restricted` (inference: under the Claude config folder's `projects/<encoded cwd>/`). *How:* the same run; list the folder for the session ID.
3. **Per-agent cost and token usage**: whether `task_notification` or `result.modelUsage` break usage down by agent rather than by model. *How:* the same stream.
4. **Whether stream lines carry any timestamp.** None appear in the M5 POC samples. *How:* inspect a stream. If there is none, live tailing is the only source of tool and agent timing.
5. **Whether partial messages (`stream_event`) appear without `--include-partial-messages`.** The executor does not pass it. Inference: they do not. *How:* inspect a stream.
6. **Whether a plugin's own Claude Code hooks (`hooks/hooks.json` in the plugin) load under `--restricted --plugin-dir`.** If they do, a `PostToolUse`/`SubagentStop` hook could write telemetry without parsing the stream. That would be in the execution path, and the hook would need tool permissions of its own. *How:* a probe like `policy.probe_claude` with a test plugin carrying a hook; check `system/hook_*` lines.
7. **How often belt executions actually include the observe pass and tuning ticket** (G4). Inferred from `belt.js` and not seen in a live run. *How:* the workflow's `result.learning` field in real streams.
8. **Real stream sizes and execution counts per day**, for retention. *How:* measure the M4 live smoke test's execution folder.

---

## 8. Reconciliation with the simulation's event catalog

This section was first written before the simulation existed, as notes for its owner. It now records how the catalog that was built (`web/apps/control-tower/src/sim/catalog.ts`, `EVENT_CATALOG`; summarised in `src/sim/README.md` section 7) stands against this document. Checked against the code on `feature/mach-next-m6-living-factory`.

- **Envelope.** The fixture uses the real factory-event v2 envelope field for field (`schema_version`, `seq`, `at`, `type`, `project_id`, `source_commit`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `runner_id`, `execution_id`, `source`, `cause`, `refs`, `data`), plus one simulation field, `t` (milliseconds from the scenario start, because `at` has whole seconds only). `M6_0_CONTRACT.md` section 4 now uses the schema's names too, so the earlier mismatch (`event_version`, `kind`) is gone.
- **Classes.** 51 kinds: 22 `exists`, 25 `derivable`, 4 `missing`. Of the fixture's 2,126 events, 75 are `exists`, 1,940 `derivable` and 111 `missing`.
- **`exists`** is used only for the 22 kinds of `intake.EVENT_TYPES`, with the `data` fields of section 2.1. The real kinds carry `cause: null`, as MACH writes them; only simulation kinds set `cause`. `station.observed` is described as sampled once per tick (stages between ticks are lost, and a failed verification is no stage change).
- **`derivable`** covers what this document lists: TDD task progress (`task.red`, `task.green`, `task.done` from `build.json`), test results, `build.revised`, verification (`results.json`, `summary.json`), review rounds, findings, votes and decisions (`review/round-N/`), the human approval (`decision.json`), merge revalidation and landing (`cell.json`), cleanup (`runs.jsonl`), the cell's stage (`cell.json`, `station.observed` being its sampled real form), the readiness and plan gates, artifacts (file times and commits), and the workflow's start and end (`stream.jsonl`). Where the derivable source lacks a field the picture shows, the entry lists it in `missingFields` (for example per-agent cost and duration, failing and passing test counts, the time of each finding, and a "no revalidation needed" record).
- **`missing`**: `station.entered` and `station.left` (no stage history or visit record; G2), `workflow.phase` (belt.js `phase()` is not persisted), and `task.started` (`build.py next` records nothing). The other facts this document names as missing have no kind of their own in the fixture, because the scenario does not show them: refused build attempts, merge conflicts, and ready slices waiting for a place. Per-agent cost is a `missingFields` entry on `agent.finished`.
- **Agents and tool calls** (`agent.*`, `tool.*`: 1,565 of the fixture's events) are `derivable` from `stream.jsonl`, conditional on the open question in section 7, item 1; the catalog says so in each entry. They are not `exists`. A review seat's start is an `agent.started` with `seat` set, under the same condition; the round itself (`review.started`) is derivable from `packet.json`.
- **Grooming for wave tickets** does not happen: dispatch opens each cell at `spec-ready`, and every wave ticket's first station in the fixture is `plan` (`contract-engineer`).
- **Round numbering**: the first review after a failed verification is round 2 (LOCAL-031 in the fixture: verification round 1 fails, review round 2 approves).

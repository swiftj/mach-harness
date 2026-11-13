# MACH Next — M6.1 assessment: from a simulated Control Tower to production observability

Status: final assessment for M6.1 (live observability) and M6.2, on `feature/mach-next-m6-1-live-observability` at `cac989e` (the merged M6.0 prototype), revised after the stream proof (`M6_1_STREAM_COMPATIBILITY.md`) and the lead's decisions (contract section 16). Read-only: no code was changed. Companion documents: `M6_1_EVENT_CONTRACT.md` (the v3 event contract and migration) and `M6_1_SHARED_CONTRACTS.md` (Execution Timeline, Evidence Theater, Factory Analytics).

Every statement below was read from the code unless it says otherwise. Assumptions are marked **[A*n*]**. Statements about Claude's execution stream come from the proof (Claude Code 2.1.322, six real runs including a whole belt execution).

---

## 1. Summary

1. **The Control Tower's front end is real; its data is not.** M6.0 built a working renderer (Atlas, Blueprint, timeline, inspector, one store, a pure reducer) over a deterministic fixture. At the baseline there is no observer, no host, no API and no path from any file under `.factory/` to the browser (one is being written now: item 3).
2. **What MACH records today is enough for the Factory-level story** (waves, slices, dependencies, dispatch, executions, cost per execution) through the v2 event log, and enough for a coarse cell story through station state files. It is not enough for station timing, retries, or anything inside an execution.
3. **Work in flight on this branch changes the picture** (uncommitted, read as it stood): the cell-local lifecycle log (`skills/intent/scripts/lifecycle.py`, called from every station script) covers stations, gates including refusals, build tasks, verification checks, review rounds, approval, merge and cleanup, with millisecond times; the executor now passes `MACH_EXECUTION_ID` to the run; an observer (`apps/observer`) is being written; and the stream proof has settled what can be seen inside a belt execution: each workflow agent (identity, label, phase, model, state, start and duration, tool-call count, last tool name, one token total), never its individual tool calls.
4. **Of the fixture's 2,126 events**, under the v3 contract: 75 exist today; 235 will come from lifecycle telemetry; 182 are reconstructed from files the stations already write (findings and artifacts); 194 will come from the execution stream (workflow start and end, agents starting and finishing); 1,440 will not exist as events: 1,380 per-call tool events of workflow agents (shown as a count instead), 34 phase moments, 26 task starts (section 6).
5. **M6.1 does not need to change the v2 log or any of its readers.** No production reader validates `schema_version` per event (contract section 13), so the v2 file must simply never receive anything else.

---

## 2. What works in production today

| Capability | Where | State | Notes |
|---|---|---|---|
| Factory event log, v2 | `.factory/intake/events.jsonl`; `intake.Factory.emit`, `save`; schema `schemas/factory-event.schema.json` | works, tested | 22 kinds; global `seq` under the intake lock; outbox through the ledger; whole-second `at`; `cause` never filled; no fsync (a crash mid-line can lose one event to readers) |
| Event feed for tools | `run.py product events --since N` (`Factory.events`) | works | Reads the whole file per call; no long-poll or push |
| Intake ledger | `.factory/intake/ledger.json` | works | Current state: slice to ticket, execution to session, dependency edges, `supervisor.executions[x]` with claim, start and end times |
| Supervisor | `supervisor.py` (`tick`, `observe`, `start`, `recover`, `finish`, `serve`) | works (one live end-to-end pass recorded in M4 3.4) | Samples cell stages once per tick (`poll_seconds`, default 300 s) |
| Execution records | `.factory/local/executions/<x>/`: `spec.json`, `started.json`, `stream.jsonl`, `stderr.log`, `wrapper.log`, `result.json` (`executor.prepare`, `wrapper`) | works | The stream is kept whole and unparsed except by `executor.outcome` (session id, refusals, the final result) |
| Station records | `cell.json`, `build.json`, `build-report.json`, `evidence/results.json`, `summary.json`, `review/round-N/*`, `decision.json` | works | Mutable snapshots, not histories; non-atomic writes (M6.0 gaps 2.4) |
| Run record | `.factory/archive/runs.jsonl` (`cleanup.cmd_run`), archives `<t>.tar.gz` | works | One line per finished ticket; no execution id, cost or durations |
| Observe scorecard | `skills/observe/scripts/observe.py` (`scorecard`, `breakdown`, `group_findings`, `TARGETS`) | works | Average rounds, first-pass rate, escalation, abandonment, tests seen failing first, deviations per ticket; by risk and app type |
| Loopback host and its security layer | `apps/studio` (Go): `internal/security`, `internal/server` envelope, SSE with replay for the interview (`internal/interview/history.go`) | works, tested | Product Studio's host. Reusable plumbing for a Control Tower host; must not gain Factory routes (M5 section 8) |
| Design system and factory grammar | `web/packages/ui` (`@mach/ui`, `@mach/ui/factory`) | works | Tokens, both themes, primitives taking props only |
| Control Tower renderer | `web/apps/control-tower` | works against the fixture | Pure reducer, structurally shared scenes, one store, two views, canvas timeline; 70 tests |

---

## 3. What is fixture-only in M6.0

| Area | In M6.0 | For production |
|---|---|---|
| The data source | `sim/scenario` builds 2,126 events at module load | An observer and a stream (contract sections 2, 14) |
| 29 simulation kinds | Defined in `sim/events.ts` `SIM_KINDS`, catalogued in `sim/catalog.ts` | Replaced by lifecycle, stream and observer kinds (contract section 11; section 6 below) |
| `t` | Milliseconds from scenario start; engine throws if out of order (`engine.ts indexFixture`) | `time.order_ms` and the `order` key; late inserts recompute from a checkpoint |
| Entity refs per event | Derived in the browser (`engine.ts refsOf`) | `entities` computed by the observer |
| Agent and tool ids | `ag-031-07`, `tc-031-0042`, parsed by `atlas/locate.ts` to find the ticket | Opaque `<execution_id>/<claude id>`; the parse must go |
| Agent roles, tiers, effort, labels, phases | Written by the scenario | Label, phase, model and agent type from the stream's snapshots; role, station and seat read from the label; tier and effort are not recorded anywhere |
| Tool calls of workflow agents (690 started, 690 finished) | Drawn one by one (Atlas tickers, Blueprint `ToolTrace`, timeline marks) | Not observable: a count and the last tool's name per agent (contract 8.1) |
| Task start, test counts, per-finding times, artifact versions, per-agent cost | Invented by the scenario (`missingFields` in the catalog says so) | Not recorded; shown as unknown or not at all |
| Causes on simulation kinds | Set by `recorder.ts` from the storyboard | Only recorded or identity causes (contract section 7) |
| Whole-run layout (`plantLayout`, `legsOf`, `usedColumns`, `plannedHeight`, `timelineModel`) | Computed from the complete fixture | Incremental (M6.0 architecture 7.2) |
| The future | `seek` past `liveAt` moves `liveAt` forward | `liveAt` = the observer's watermark; `seek` clamps |
| Actors | `supervisor` and `scheduler` from the v2 `source` | Plus `engineer`, `person`; station scripts as `origin.writer: station` |
| Telemetry badge | `exists` / `derivable` / `missing` per kind | `authority` and `time.precision` per event |

---

## 4. Missing production telemetry, after the work in flight

Gap numbers are M6.0's (`M6_0_TELEMETRY_GAPS.md` section 1).

| Gap | With the lifecycle log | With the stream, as proven | What remains |
|---|---|---|---|
| G1 Nothing visible inside an execution | stations and gates inside the execution, with ms times | **largely closed for agents**: workflow start and end (`completed`/`killed`), each agent's identity, label, phase, model, start, duration, tool-call count, last tool name, token total, refusals | **Not observable**: a workflow agent's individual tool calls, `log()` lines, phase changes as moments, per-agent cost. Per-agent transcripts exist on disk but are internal and not used (contract D17) |
| G2 Stations sampled, not recorded | **closed**: `station.entered`/`exited`, `gate.evaluated`, with ms times, including the verify-fail loop | | Cells opened before the log exists have no station history (`history.began`) |
| G3 No identity below the execution | **visits and rounds closed** (`visit`, `round`); execution id on every station record run by the Factory (`MACH_EXECUTION_ID`) | **agents closed** (`agentId`, stable per execution); tool-call ids only for the main loop | v2 `cause` stays unfilled in M6.1 (lead's decision 5); an agent is tied to its ticket, station and seat only by its label |
| G4 Only supervisor-run work visible | **closed for stations**: every cell writes its own log, whoever drives it | | The belt's tuning ticket inside another ticket's execution: its cell log carries the execution id it ran in; its agents in the other ticket's stream are attributed only through `workflow.finished.tickets[]` |
| G5 Cost and duration only per execution | station durations closed | per-model cost and tokens per execution; per agent: duration and one token total | Per-agent and per-station **cost** do not exist and are never estimated; per-agent tokens have no input/output split. A budget stop can under-report spend in flight (proof 3.5, one observation) |
| G6 Scheduler decisions partly invisible | unchanged | unchanged | Execution-capacity waits are reconstructed from the supervisor's recorded `held[]` sentence (`capacity.wait_changed`); a slice waiting for a free cell is filtered out of v2 and stays `unknown` (lead's decision 6) |
| G7 Snapshots, not histories | **closed for gates**: every station's error handler records `gate.evaluated` with `outcome: refuse` and the error code; overrides are `outcome: override` | | Re-recorded verify checks keep both (`rerecorded`); a restarted review round is `restarted: true`. Lost lifecycle writes leave no sequence gap (contract 6.5) |
| G8 No redaction boundary | **closed by design**: contract section 9 | | Must be held by a conformance test |

New gaps found in this assessment:

- **N1. Execution span truth.** v2 `execution.completed` is stamped at the next tick after the end; the true end is only in `result.json`. The contract adds `execution.process_started`/`ended` from the execution records.
- **N2. A cell's completion record disappears with the cell folder** unless it is outside the folder. Only `runs.jsonl` survives; the contract reads it as a source (`run.recorded`).
- **N3. Risk: no production reader validates `schema_version` per event** (contract section 13). `intake.Factory.events` returns any JSON line with a larger `seq`, and `Factory.save` trusts any line's `seq`. Nothing writes anything but v2 there today; if anything ever did (a v3 line, a hand edit), every v2 reader would accept it silently. Mitigation proposed: a source-scan test that only `intake.Factory` writes the file. (Lead's decision 10.)
- **N4. Some stream times exist only while an observer is watching.** Records without their own time (heartbeats, `task_started`, `task_notification`, `permission_denied`, `result`) are stamped on arrival when tailed live (median lag 39 ms); read after the fact they are `bounded`. There is no timing sidecar in M6.1 (lead's decision 7). Agent start and finish times are not affected: snapshots carry them.
- **N6. A budget stop mid-workflow looks like success** (`subtype: success`, exit 0). Only `task_updated.status: killed`, the agents' `error` state and `stderr.log` say otherwise. The contract never reads `success` as completion (D14).
- **N7. The stream carries private material in places a casual parser would forward**: the whole workflow script in `task_started.prompt`, absolute paths in several records, full refused commands in `result.permission_denials`. All are on the never-forward list (contract 9.1).
- **N5. A lifecycle write that fails leaves no trace.** The helper never raises and takes its next `seq` from the file, so a lost record is invisible in the sequence. Only a comparison with the station's own files can reveal it (contract 6.5, `state-mismatch`).

---

## 5. Integration points M6.1 will touch

"Read" means the observer reads it and nothing changes. "Change" means an edit in M6.1, with who owns it.

### 5.1 M3/M4 (`skills/run/scripts/`)

| File | Function or name | M6.1 | Why |
|---|---|---|---|
| `intake.py` | `EVENT_TYPES`, `EVENT_VERSION`, `Factory.emit`, `Factory.save` | read only; **must not change** | v2 frozen (contract D2) |
| `intake.py` | `Factory.events`, `Factory.ledger` | read (the observer reads the files directly, without the lock, by offset) | the CLI feed stays for tools |
| `intake.py` | `Factory.record` | read only; `cause` stays unfilled (lead's decision 5) | |
| `supervisor.py` | `Supervisor.observe` | read only | `station.observed` stays for v2 readers; the view prefers lifecycle events |
| `supervisor.py` | `Supervisor.start`, `finish`, `recover`, `schedule` (its `held` sentence) | read only | execution identity and outcome; capacity waits |
| `executor.py` | `folder`, `outcome`, `tool_summary`, `CREDENTIAL_NAME_RE` | read; the observer re-implements `tool_summary`'s rule in Go, with a parity test | refusals summarised the same way |
| `executor.py` | `wrapper`, `EXECUTION_ENV` | **changed in flight**: the wrapper sets `MACH_EXECUTION_ID` in the run's environment | lifecycle `execution_id` |
| `executor.py` | `wrapper` | no change in M6.1 (no timing sidecar, lead's decision 7) | |
| `run.py` | `product events` (`cmd` for `product`), `cmd_board` | read; `cmd_board`'s cell discovery is mirrored | |
| station scripts (`audit.py`, `cell.py`, `build.py`, `verify.py`, `review.py`, `merge.py`, `cleanup.py`) | each script's `telemetry()` wrapper around `lifecycle.record`; `cleanup.py` uses `lifecycle.closing` | **changed in flight, by the lifecycle owner** | the contract's section 10.2 maps every call site's `data` |
| `cleanup.py` | `write_archive`, `cmd_run` | read (archives and `runs.jsonl`) | `lifecycle.jsonl` is in the archive automatically (everything but `repo/`) |
| `skills/observe/scripts/observe.py` | `scorecard`, `breakdown`, `group_findings`, `finding_kind`, `TARGETS` | read; Analytics reuses the definitions with a parity test (shared contracts section 4) | one definition of first pass, rounds, escalation |

### 5.2 M5 (`apps/studio`, `web/packages/ui`)

| File | M6.1 | Why |
|---|---|---|
| `apps/studio/internal/security` | reuse (import or extract to a shared package) | token, cookie, Host/Origin, CSP |
| `apps/studio/internal/server` | reuse the envelope; **no Factory route is added to the studio host** (M5 section 8) | the Control Tower is a separate surface |
| `apps/studio/internal/interview/history.go` | pattern only (SSE replay, symlink-safe append) | precedent for the event stream |
| `apps/studio/cmd/mach-studio/boundary_test.go` | pattern for a Control Tower host boundary test (no `run.py` write operation, no station, no `factory` command) | read-only observer |
| `web/packages/ui/src/api` | extend: a typed client for the observer's `/api/v1/*` and the v3 types | shared plumbing (M5 section 8) |
| `.github/workflows/release.yml`, `bin/mach` | change in M6.2 if the observer ships as its own binary | distribution as for `mach-studio` |

The observer itself is `apps/observer` (Go, in flight: `internal/tail`, `normalize`, `redact`, `event`, `server`, `security`), with its index in `.factory/local/observer/`. Contract section 17 lists the changes it must make; the lead decided the contract wins.

### 5.3 M6.0 (`web/apps/control-tower/src`)

| File | Function | M6.1 |
|---|---|---|
| `sim/events.ts` | `FactoryEvent`, `SimEvent`, `REAL_KINDS`, `SIM_KINDS`, `EventDataMap` | add v3 types beside v2; v2 stays for the fixture |
| `sim/catalog.ts` | `EVENT_CATALOG` | kept for the simulation; production uses `authority` per event |
| `sim/engine.ts` | `indexFixture` (throws on out-of-order), `refsOf`, `sceneAt`, `cursorAt` | sorted insert by `order`, checkpoints instead of every scene (architecture 6.3), `refsOf` replaced by `entities`, re-key from `seq` to `id` |
| `sim/reducer.ts` | `reduce` cases | v3 kinds per contract 12.2 |
| `sim/model.ts` | `ENTITY_KINDS`, `ref`, `EntityRef`, `gateId`, `CellState`, `AgentState` | add `project`, `visit`, `seat`; agent tier and effort become optional |
| `sim/selectors.ts` | `eventBySeq`, `refsOfEvent`, `eventsFor`, `relatedRefs`, `agentTimingAt`, `toolCallTimingAt`, `visitTimingAt`, `cellTimelines`, `moments` | id keys; timing reads `time.precision`; `relatedRefs` gains visit and seat |
| `sim/actors.ts` | `actorOfEvent` | reads `origin.writer` |
| `scene/store.ts` | `liveAt`, `seek`, `seekToSeq`, `onFrame` | `liveAt` from the watermark; `seek` clamps; `seekToSeq` → seek to an event id |
| `scene/clock.ts` | `browserClock` | real time for live; `PLAYBACK_BASE_RATE` for replay only |
| `atlas/locate.ts` | the agent and tool branch (`` `LOCAL-${id.slice(3, 6)}` ``) | read the ticket from the scene |
| `atlas/Bay.tsx` (tool ticker), `blueprint/ticks.tsx` (`ToolTrace`, `ToolTick`), `shell/timeline/draw.ts` (tool marks), `shell/inspector/anatomies.tsx` (tool call anatomy) | per-call drawing | for workflow agents: a tool-call count and the last tool's name, updated per snapshot (contract 8.1); per-call drawing stays for main-loop calls only |
| `shell/inspector/parts.tsx` | the telemetry badge | authority and time precision |
| `test/no-early-outcomes.test.mjs`, `reducer.test.mjs` | | run against v3 events through the same engine |

An adapter (fixture v2 + `t` → v3) keeps the simulation running on the production engine, so the 70 tests and the no-early-outcomes guarantee carry over.

---

## 6. The 51 simulation kinds, one by one

Categories (the brief's):

- **Exists today**: MACH writes this event now.
- **Lifecycle**: will come from the cell lifecycle log being implemented now (authoritative).
- **Reconstructed**: will come from the observer reading files stations already write (not in the brief's list; needed for honesty: these are neither recorded as events nor in the stream).
- **Stream**: will come from the Claude execution stream, as the proof showed it (observed).
- **Will not exist**: no source is planned, or the proof showed the fact is not in the stream.

| # | M6.0 kind | Fixture events | Category | v3 kind | Notes |
|---|---|---|---|---|---|
| 1 | `wave.discovered` | 1 | exists today | same | |
| 2 | `intake.validated` | 1 | exists today | same | |
| 3 | `intake.refused` | 0 | exists today | same | |
| 4 | `slice.materialized` | 5 | exists today | same | |
| 5 | `slice.integrated` | 3 | exists today | same | stamped when noticed |
| 6 | `dependency.resolved` | 4 | exists today | same | `cause` null today |
| 7 | `dependency.blocked` | 6 | exists today | same | capacity waits filtered out |
| 8 | `work.scheduled` | 4 | exists today | same | |
| 9 | `revision.superseded` | 0 | exists today | same | |
| 10 | `human.required` | 1 | exists today | same | |
| 11 | `factory.activated` | 1 | exists today | same | `by` becomes `by_role` |
| 12 | `factory.disabled` | 0 | exists today | same | |
| 13 | `factory.paused` | 0 | exists today | same | |
| 14 | `factory.resumed` | 0 | exists today | same | |
| 15 | `revision.discovered` | 1 | exists today | same | |
| 16 | `scheduling.decided` | 6 | exists today | same | once per distinct decision |
| 17 | `work.claimed` | 5 | exists today | same | |
| 18 | `execution.started` | 5 | exists today | same | true start is `execution.process_started` |
| 19 | `station.observed` | 28 | exists today | same, `authority: observed` | sampled; superseded for display by lifecycle |
| 20 | `recovery.started` | 0 | exists today | same | |
| 21 | `execution.completed` | 4 | exists today | same | true end is `execution.process_ended` |
| 22 | `execution.failed` | 0 | exists today | same | |
| 23 | `workflow.started` | 5 | stream | `workflow.started` | `system/task_started` (`task_type: local_workflow`) |
| 24 | `workflow.phase` | 34 | **will not exist** (as moments) | `workflow.phases_declared` once, and each agent's `phase` | the stream lists the declared phases and each agent's phase; `phase()` calls are not moments in it |
| 25 | `workflow.finished` | 4 | stream, **proven** (the final `result`, M4 3.4) | `workflow.finished` | `stations[]` kept, which `executor.outcome` drops |
| 26 | `station.entered` | 26 | lifecycle | `station.entered` | |
| 27 | `station.left` | 25 | lifecycle | `station.exited` | |
| 28 | `cell.stage_changed` | 31 | lifecycle | folded into `station.*` `data.stage` | needs `stage` in the lifecycle `data` (contract 10.2) |
| 29 | `agent.started` | 93 | stream | `agent.queued`, `agent.started` | from `workflow_progress[]` snapshots: `agentId`, label, phase, model, `startedAt`; station and seat from the label |
| 30 | `agent.finished` | 92 | stream | `agent.finished` | duration, tokens (one total), tool-call count; no cost, ever |
| 31 | `tool.started` | 690 | **will not exist** for workflow agents (all 690 are) | none; `agent.progressed.tool_calls` counts them | `tool.called` exists for main-loop and Agent-tool calls only; the belt's main loop makes one call (`Workflow`) |
| 32 | `tool.finished` | 690 | **will not exist** for workflow agents | none | as row 31 |
| 33 | `artifact.written` | 171 | reconstructed (from files named by lifecycle events, and fixed cell files) | `artifact.recorded` | versions become content hashes; the writing agent is never known for workflow work |
| 34 | `gate.checked` | 8 | lifecycle | `gate.evaluated` | audit score: contract open question 1 |
| 35 | `task.started` | 26 | **will not exist** | none | `build.py next` records nothing; a `Bash` call running it might be visible in the stream, but a script's printout is not a record |
| 36 | `task.red` | 13 | lifecycle | `build.task_completed` (`step: red`) | failing-test count will not exist |
| 37 | `task.green` | 12 | lifecycle | `build.task_completed` (`step: green`) | passing-test count will not exist |
| 38 | `task.done` | 1 | lifecycle | `build.task_completed` (`step: done`) | |
| 39 | `test.result` | 42 | lifecycle, partial | `build.task_completed.first_run`, `suite` | the lifecycle records the suite's state, not exit codes or seconds (those stay in `build.json`, reconstructable); pass/fail/skip counts will not exist |
| 40 | `build.revised` | 2 | lifecycle | `station.entered` (`action: revise`) | |
| 41 | `verification.started` | 5 | lifecycle, with a reconstructed target list | `station.entered` (`station: verify`), `verify.targets_listed` | targets recomputed from `spec.json` (lead's decision 3) |
| 42 | `evidence.captured` | 35 | lifecycle | `verify.check_recorded` | |
| 43 | `verification.verdict` | 5 | lifecycle | `gate.evaluated` (`gate: verification`) | `INCOMPLETE_EVIDENCE` becomes recordable |
| 44 | `review.started` | 4 | lifecycle | `review.round_started` | |
| 45 | `review.finding` | 11 | reconstructed | `review.finding` | from the vote file; per-finding time will not exist |
| 46 | `review.vote` | 12 | lifecycle | `review.verdict_submitted` | |
| 47 | `review.decided` | 4 | lifecycle | `review.decided` | |
| 48 | `human.approval_recorded` | 1 | lifecycle | `human.approval_recorded` | the name is not forwarded |
| 49 | `merge.revalidated` | 3 | lifecycle | `merge.completed.revalidated`; a refused `merge.land` gate when it fails | no separate record; "not needed" is `revalidated: false` |
| 50 | `merge.completed` | 3 | lifecycle | `merge.completed` | |
| 51 | `cleanup.completed` | 3 | lifecycle | `cleanup.completed`, and `run.recorded` | written only into the archived copy of the log (`lifecycle.closing`), since the folder is deleted; `runs.jsonl` is the record if archiving fails |

**Totals by kind** (51): exists today 22 (rows 1–22); lifecycle 19 (rows 26–28, 34, 36–44, 46–51); reconstructed 2 (rows 33, 45); stream 4 (rows 23, 25, 29, 30); will not exist 4 (rows 24, 31, 32, 35).

**Totals by fixture event** (2,126): exists today 75; lifecycle 235; reconstructed 182; stream 194 (5 + 4 + 93 + 92); will not exist 1,440 (34 phase moments, 1,380 workflow-agent tool calls, 26 task starts).

What this means for the picture: a real run shows every station, gate, task completion, verification check, vote and decision with real times (lifecycle), the Factory story (v2), and inside each execution the agents at work: who, for which ticket and seat, in which phase, since when, how many tool calls so far and the last tool's name, and their tokens. It does not show individual tool calls of workflow agents: the M6.0 tickers and per-call ticks (1,380 of the fixture's events) have no source and become counts (contract section 8.1, "Honest degraded states").

---

## 7. Assumptions

- **[A1]** The lifecycle helper and its call sites are read as they stood, uncommitted, when this was written. They may still change; contract section 10.2 is the mapping to re-check.
- **[A2]** The stream's shape is proven for Claude Code 2.1.322 and the current `belt.js` labels only (contract A3, A9).
- **[A3]** The fixture's kind and event counts were taken by running the simulation (`SCENARIO.events`, 51 kinds, 2,126 events), and match `M6_0_ARCHITECTURE.md` 6.5.

## 8. Open questions for the lead

The contract's open questions were decided by the lead (contract section 16). Remaining here:

1. **The observer as its own binary.** `apps/observer` is a separate Go program with a copy of M5's security layer. Confirm it ships as its own release artifact (as `mach-studio` does), and whether `internal/security` should be one shared package rather than two copies.
2. **Backfill.** Should the observer reconstruct point facts for cells and archives that predate the lifecycle log (contract 10.6), or start history at the first lifecycle log and mark earlier work `history.began`?
3. **The simulation's future.** Keep the fixture as a demo and test source through the adapter (recommended), with its per-call tool events flagged as not observable, or retire it once real data flows?
4. **Per-agent transcripts** (`~/.claude/projects/.../subagents/workflows/`) would give per-call detail and per-agent cost by pricing. Excluded from M6.1 (contract D17). Should a later milestone evaluate them as an opt-in, local-only source, or close that door?

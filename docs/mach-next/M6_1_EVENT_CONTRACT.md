# MACH Next — M6.1 event contract: one history from five sources

Status: final design for M6.1/M6.2, on `feature/mach-next-m6-1-live-observability` at `cac989e`, revised after the stream proof (`M6_1_STREAM_COMPATIBILITY.md`, Claude Code 2.1.322, six real runs including a whole belt execution) and the lead's decisions on the open questions (section 16 records them). Nothing here is implemented. Schema: `schemas/factory-event.v3.schema.json`. Inputs read while writing, all uncommitted work in progress on this branch: the lifecycle helper (`skills/intent/scripts/lifecycle.py`, `schemas/cell-lifecycle.schema.json`), the executor's `MACH_EXECUTION_ID`, and the observer (`apps/observer`); section 17 lists the changes the observer must make (the contract wins). Companion documents: `M6_1_ASSESSMENT.md` (what exists, what is missing, per kind), `M6_1_SHARED_CONTRACTS.md` (Execution Timeline, Evidence Theater, Factory Analytics).

Assumptions are marked **[A*n*]** and collected in section 15. Everything about Claude's execution stream is now taken from the proof, for Claude Code 2.1.322; another version is parsed only for what the parser knows (section 10.5).

---

## 1. Decisions

| # | Decision | Why, in one line |
|---|---|---|
| D1 | **Version 3 is a normalised view, produced by the observer. Nothing writes v3 to disk under `.factory/`.** The sources stay exactly as they are. | Every source already has an owner and a reader; a second on-disk format would be a second source of truth (M3 D10), and v2's readers would gain nothing. |
| D2 | **The v2 log (`.factory/intake/events.jsonl`) is frozen for M6.1, and no v2 writer changes**: no new envelope fields, no new kinds, no new `data` fields, and `cause` stays unfilled (lead's decision 5). | The product owner asked for compatible evolution, not silent additions. v2's `data` is schema-free (`"type": "object"`), so additions would pass the schema but still change what readers see. |
| D3 | **Five sources, not three**: the intake log, each cell's `lifecycle.jsonl`, each execution's `started.json`/`result.json`, `.factory/archive/runs.jsonl`, and each execution's `stream.jsonl`. | The true execution span is only in `started.json`/`result.json` (v2's `execution.completed` is stamped up to a poll late). A cell's completion survives deletion only in `runs.jsonl` (section 10.4). |
| D4 | **Event ids are deterministic**: `<stream letter>:<partition>:<seq>[.<part>]`, where the partition includes a *generation* token (hash of the source file's first line). Re-indexing gives the same ids. | Cursors, links from Analytics and Evidence Theater, and URLs must survive an observer rebuild. The generation token also separates two incarnations of the same ticket's cell, which the lifecycle record shape does not. |
| D5 | **Two orders.** `order` is a deterministic total history order computed from the event's own content. `pos` is the delivery position, assigned once and persisted. The cursor is `<epoch>.<pos>`. | History order must not depend on when the observer happened to read a file; delivery must be resumable. |
| D6 | **Time is two fields plus quality**: `occurred_at` (when the fact happened, best known) with `precision` and bounds, and `observed_at` (when the observer read it). `order_ms` places the event and is never earlier than the previous event of the same source. | Whole-second v2 times, millisecond lifecycle times and unstamped stream lines must share one axis without pretending to a precision they lack. |
| D7 | **Authority is per event**: `authoritative`, `observed`, `reconstructed`. Time quality is a separate axis. | A stream line read an hour later is still *observed* (it is the runtime's own record); only its time is poor. |
| D8 | **`cause` only when recorded or by shared identity**, never by adjacency. Fields filled by inference are listed in `inferred`, with the rule. | The product owner's rule; and so a renderer never has to guess what is trustworthy. |
| D9 | **Entity references keep the M6.0 `kind:id` grammar exactly** and add four kinds (`project`, `workflow`, `visit`, `seat`), plus two `actor` values. The observer computes `entities` for every event; the client engine stops deriving refs (`engine.ts refsOf`). | Atlas, Blueprint, inspector and the URL parse these strings today (section 5.3). |
| D10 | **The browser receives only an allow-listed payload per kind.** Raw tool inputs and outputs, file contents, command lines, environment, absolute paths, transcripts, test output and people's names never leave the observer. | M6.0 gap G8; M4 section 6; M5's rule that the raw stream never leaves the host. |
| D11 | **The observer's index lives in `.factory/local/observer/`** (machine-local, git-ignored, private mode), is read by nothing in MACH, and can be deleted and rebuilt at any time. | ADR-011 forbids an operational dependency on the UI, not a private folder. `.factory/local/` is already machine-local, and M4 already denies a run's file tools there, so agents cannot edit the index. This supersedes M6.0 gaps 5.8's "writes nothing under `.factory/`", and matches the observer being built (`apps/observer`, `IndexDir`). |
| D12 | **Consumers are tolerant within version 3; producers are strict.** The schema is strict for conformance tests. Clients ignore unknown kinds and fields; a breaking change is version 4, served beside 3 for one release. | Additive evolution without silent breakage on either side. |
| D13 | **Dynamic Workflow agents are observed through `task_progress` snapshots, not messages.** `agent.queued`, `agent.started`, `agent.progressed`, `agent.finished` carry the real `agentId`, label, phase, model, tool-call **count**, last tool **name** and one token total. Per-call kinds (`tool.called`, `tool.returned`) exist only for the main loop and for Agent-tool sub-agents. | The proof: workflow agents produce no `assistant`/`user` records and `parent_tool_use_id` is never set for them; their calls are visible only as counts. |
| D14 | **A workflow is "completed" only when `task_updated.patch.status` says `completed`.** `result.subtype: success` and exit 0 are never read as completion. | A budget crossed mid-workflow reports `success`, exit 0, with the workflow `killed`. |
| D15 | **People's names never reach the browser in M6.1.** A human gate shows "a person" (`by_role`). `GET /api/v1/session` carries `display_policy.people: "role"`, the only value in M6.1, reserved for a locally configured policy later. | Lead's decision 4. |
| D16 | **Waiting for capacity is derived only from a recorded scheduler decision** (`scheduling.decided.held[]` with the supervisor's fixed sentence), as a reconstructed `capacity.wait_changed` naming its rule; otherwise it is `unknown`. Never inferred from silence. | Lead's decision 6; the cell-capacity wait of a slice is filtered out of v2 and stays unknown. |
| D17 | **Claude Code's per-agent transcripts on disk (`~/.claude/projects/.../subagents/workflows/`) are not a source.** They are undocumented and internal. A later, opt-in, local-only source at most. | Lead's instruction; the contract must not depend on an internal format. |

---

## 2. The sources

| Stream (`origin.stream`) | File(s) | Writer | Per-source sequence | Authority | Time on disk |
|---|---|---|---|---|---|
| `intake-log` | `.factory/intake/events.jsonl` | `intake.Factory.emit`/`save` (intake, supervisor, activation) | v2 `seq`, global, +1 per event | authoritative, except `station.observed` (observed) | `at`, whole seconds, stamped when queued |
| `cell-lifecycle` | `.factory/worktrees/<t>/lifecycle.jsonl`, and the same member in `.factory/archive/<t>.tar.gz` (a superset: cleanup adds its own records only to the archived copy) | station scripts, through `skills/intent/scripts/lifecycle.py` (being built now) | the physical line number in the file; the record's own `seq` is a check and may be `null` | authoritative | `at`, milliseconds |
| `execution-record` | `.factory/local/executions/<x>/started.json`, `result.json` | `executor.wrapper` | 1 (started), 2 (result) | authoritative (write-once at the moment) | `started_at`, `ended_at`, whole seconds |
| `run-record` | `.factory/archive/runs.jsonl` | `cleanup.cmd_run` | line number | authoritative | `closed_at`, whole seconds |
| `execution-stream` | `.factory/local/executions/<x>/stream.jsonl` | Claude Code (`stream-json --verbose`), through the wrapper's stdout, written live (arrival lag median 39 ms) | line number | observed | `assistant`/`user` `timestamp` (ms); workflow agent snapshots `queuedAt`, `startedAt`, `durationMs` (Unix ms); `task_updated.patch.end_time`; **every other record has no time** |
| `observer` | none | the observer | none (`null`) | reconstructed | as the basis records give it |

Read but not turned into events: `.factory/intake/ledger.json` (identity map: slice to ticket, execution to session; dependency edges), each `cell.json` (cell discovery and `history.began` snapshots), `review/round-N/votes/<role>.json` (finding titles), `evidence/results.json` (hash checks), `.factory/audit-report.json`.

**Discovery.** The observer lists `.factory/worktrees/*/` (as `run.py cmd_board` does), `.factory/archive/*.tar.gz` and `.factory/local/executions/*/`. It never discovers work through the ledger alone, so hand-driven tickets, `AUTO-*` tickets and the belt's tuning ticket are seen (gap G4).

---

## 3. Why a view and not a new on-disk format

Considered: (a) every writer writes v3 into one new log; (b) writers keep their formats and an observer normalises; (c) the observer normalises and also writes its v3 output under `.factory/`.

(b) is chosen, with the observer's own index kept outside `.factory/` (D11).

- (a) would force station scripts to take the intake lock (held during `reconcile`, which can include `git fetch`), coupling the line to the Factory; M6.0 gaps G2 rejected exactly that. It would also make the stream, which belongs to Claude Code, a MACH-written format.
- (c) would create a second persisted history that some later tool would start reading as truth. A view can always be rebuilt from the sources; the sources are the truth.
- The cost of (b): normalisation rules live in one place (the observer) and must be versioned (`origin.source_version`, and the observer's own version in `provenance.rule`). That is the right place for them: renderers never reconcile.

---

## 4. The envelope

Every event the observer serves has exactly these fields. `null` means *not applicable*; a field that applies but is not known is `null` **and** named in `unknown`.

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | `3` | |
| `schema_revision` | integer | Additive revision within 3 (starts at 0). |
| `id` | string | Deterministic event id (section 5.1). |
| `type` | string | The kind (section 11). Kept as `type`, as in v2 and M6.0. |
| `pos` | integer | Delivery position in this index epoch. The cursor. |
| `origin` | object | `stream`, `key` (partition), `seq`, `part`, `writer` (`intake`, `engineer`, `supervisor`, `station`, `executor`, `cleanup`, `claude`, `observer`), `script` (e.g. `build.py`), `source_version` (`2`, `1`, `claude-code 2.1.322`, `observer 0.1.0`). |
| `authority` | enum | `authoritative`, `observed`, `reconstructed` (section 7). |
| `time` | object | `occurred_at`, `precision` (`ms`, `s`, `arrival`, `bounded`, `unknown`), `not_before`, `not_after`, `observed_at`, `order_ms` (section 6). |
| `order` | string | Deterministic total order key (section 6.3). |
| `ids` | object | `project_id`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `cell_instance`, `execution_id`, `runner_id`, `visit_id`, `station`, `round`, `attempt`, `seat`, `agent_id`, `parent_agent_id`, `tool_call_id`. All present, all nullable. |
| `entities` | string[] | Every entity this event touches, as `kind:id` refs (section 5.2). |
| `parent` | ref or null | The enclosing span's entity, when recorded. |
| `cause` | object or null | `{event_id, basis: "recorded" \| "identity"}`. |
| `artifacts` | object[] | `{ref, sha256, commit}` for artifacts this event produced or names. Full records are `artifact.recorded` events and the artifact catalog (shared contracts, section 3). |
| `unknown` | string[] | Fields that apply but are not known. |
| `inferred` | object | `{field: rule}` for fields the observer filled by inference: `time-window`, `single-candidate`, `label`, `path`. `cause` is never listed here because it is never inferred. |
| `provenance` | object or null | Required for `reconstructed`: `basis` (event ids), `rule`, `files` (cell-relative names read). |
| `late` | boolean | Delivered after events that sort after it (section 6.5). |
| `withheld` | integer | How many source fields the allow-list or redaction dropped, so the inspector can say "n details are kept on this machine". |
| `data` | object | The kind's browser-safe payload (section 11; schema `$defs`). |

Two `ids` names are deliberately different from their sources:

- `round` is the **judging round** (1 to 3), as the lifecycle log records it (null outside build, verify, review and human-approval). `attempt` is used **only** for execution attempts (how many executions have tried the ticket at its current step: v2 `work.claimed`, `execution.failed`). A workflow agent's own retry number from the snapshot is `data.agent_try`, neither of the two.
- `cell_instance` is the generation of the ticket's cell (section 5.1). It is null for events that do not come from a cell.

---

## 5. Identity

### 5.1 Event ids

| Stream | Partition key (`origin.key`) | Event id | Notes |
|---|---|---|---|
| intake-log | `i:<gen>` | `i:<gen>:<seq>` | `gen` = first 8 hex of SHA-256 of the file's first line. If the ledger is lost and `next_seq` restarts at 1, the new log's first line differs, so ids do not collide. |
| cell-lifecycle | `c:<ticket>:<gen>` | `c:<ticket>:<gen>:<line>` | `gen` as above, of this cell's `lifecycle.jsonl`. `<line>` is the 1-based physical line, counting a torn line the helper left behind, because the helper orders by file offset and writes `seq: null` when it cannot take its lock within 0.2 s. The live file and its archived copy share their first line and their common prefix, so they give the same ids and de-duplicate; the archive's extra lines (cleanup's records) get the next numbers. |
| execution-record | `x:<execution_id>` | `x:<execution_id>:started`, `x:<execution_id>:ended` | Execution ids are random (`x` + 12 hex). |
| run-record | `r:<gen>` | `r:<gen>:<line>` | `runs.jsonl` is append-only. |
| execution-stream | `s:<execution_id>` | `s:<execution_id>:<line>[.<part>]` | `part` numbers the events one line yields: a snapshot that shows two agents changing gives `.0`, `.1`, in the agents' `index` order; an assistant message with several `tool_use` blocks, in block order. |
| observer | `o` | `o:<rule>:<basis id>[:<n>]` | e.g. `o:finding:c:LOCAL-031:3f2a9c1e:40:2`, `o:gap:c:LOCAL-031:3f2a9c1e:12-14`, `o:close:agent:x1a2…/a0123456789abcdef`. Deterministic because the basis is. |

`cell_instance` = the `gen` of the cell's lifecycle file. For a cell with no lifecycle file (opened before lifecycle logging shipped), `cell_instance` = first 8 hex of SHA-256 of `cell.json`'s `created_at`, and the event's `unknown` lists nothing for it (the value is defined), but its `provenance.rule` says `cell-created-at` **[A1]**.

Components are percent-encoded outside `[A-Za-z0-9._-]`, so a ticket id can never inject `:`, `/`, `#`, `~` or `->` into an id or a ref.

### 5.2 Entity references

The M6.0 grammar (`sim/model.ts`, `ref.*`) is kept character for character. Views parse these strings today: `parseStation` in `shell/inspector/entity.ts`, `findFinding`, the gate and dependency branches of `atlas/locate.ts`, `relatedRefs`/`entityAt` in `sim/selectors.ts`. Production ids must fit the same grammar.

| Kind | Format | Example | Source of the id | New? |
|---|---|---|---|---|
| `project` | `project:<project_id>` | `project:team-space` | ledger `project_id` | new |
| `wave` | `wave:<wave_id>` | `wave:WAVE-007` | v2 | |
| `slice` | `slice:<slice_id>` | `slice:SLICE-021` | v2 | |
| `cell` | `cell:<ticket>` (`cell:<ticket>~<k>` for the k-th incarnation, k ≥ 2) | `cell:LOCAL-031` | v2 `ticket_id`; lifecycle | suffix new |
| `station` | `station:<ticket>/<station>` (a station as one cell visits it) or `station:<station>` | `station:LOCAL-031/build` | lifecycle `station` | |
| `visit` | `visit:<ticket>/<station>#<n>` | `visit:LOCAL-031/build#2` | lifecycle `visit` | new |
| `execution` | `execution:<execution_id>` | `execution:x1a2b3c4d5e6f` | v2 | |
| `workflow` | `workflow:<execution_id>/<task_id>` | `workflow:x1a2b3c4d5e6f/task0001` | stream `system/task_started` (`task_type: local_workflow`) | new |
| `agent` | `agent:<execution_id>/<agentId>` for a workflow agent (`a` + 16 hex, present once it has started; a queued agent is known only by its `index` and gets its ref at `agent.started`), `agent:<execution_id>/<agent_id>` for an Agent-tool sub-agent, `agent:<execution_id>/main` for the main loop | `agent:x1a2b3c4d5e6f/a0123456789abcdef` | stream (proven) | id shape new |
| `tool` | `tool:<execution_id>/<tool_use_id>`, **main loop and Agent-tool sub-agents only**; a refused workflow-agent call has a `tool_use_id` that never appears elsewhere and gets no `tool:` ref | `tool:x1a2b3c4d5e6f/toolu_01CD` | stream | id shape new |
| `artifact` | `artifact:<ticket>:<cell-relative path>`; a version: `…@<sha256 first 12>`; a commit: `artifact:<ticket>:commit/<sha 12>` | `artifact:LOCAL-031:evidence/AC-01.png@9f2c0a1b3d4e` | lifecycle, cell files, Git | version suffix new |
| `gate` | `gate:<ticket>/<gate>` or `gate:<ticket>/<gate>#<round>` | `gate:LOCAL-031/review#2` | lifecycle `gate.evaluated`, `review.*` | |
| `dependency` | `dependency:<waiting slice>-><prerequisite>` | `dependency:SLICE-024->SLICE-021` | v2 `slice.materialized.dependencies` | |
| `finding` | `finding:<ticket>/r<round>/<seat>/<n>` | `finding:LOCAL-032/r1/security/1` | vote files | |
| `seat` | `seat:<ticket>/review#<round>/<seat>` | `seat:LOCAL-031/review#2/security` | lifecycle `review.round_started.panel` | new |
| `actor` | `actor:supervisor`, `actor:scheduler`, `actor:engineer`, `actor:person` | | v2 `source`, lifecycle `human.approval_recorded` | two values new |

Rules:

- **Agent and tool ids are opaque.** No view may parse them. `atlas/locate.ts` currently recovers a ticket from a simulated agent id (`` `LOCAL-${id.slice(3, 6)}` ``); that line must instead read the agent's ticket from the scene. This is the only M6.0 view code that parses an id that changes shape.
- **`station:` stays the aggregate of a cell's visits** to a station, as M6.0 uses it. `visit:` names one visit. A seat exists from the round's start, whether or not its agent is ever observed; that is why `seat:` is separate from `agent:`.
- **Why `cell:<ticket>` and not the instance in every ref**: a cell is re-created after cleanup only rarely, and every M6.0 view keys cells by ticket. The first incarnation keeps the bare form; later ones take `~<k>`, numbered by their lifecycle file's first `at` **[A2]**.
- Analytics and Evidence Theater link to the same refs; across projects they are qualified by `project_id` (shared contracts, section 4.6).

### 5.3 Parent and child

`parent` names the enclosing span **when a record says so**:

| Child | Parent | Recorded by |
|---|---|---|
| `tool:` call | its `agent:` | stream: `main` for the main loop; `parent_tool_use_id` / `agent_id` for Agent-tool sub-agents. Workflow agents' calls are not in the stream |
| `agent:` (workflow agent) | its `workflow:` | stream: the snapshot belongs to the Workflow call's `task_id` (containment, recorded) |
| `workflow:` | `agent:<x>/main` | stream: `task_started.tool_use_id` is the main loop's `Workflow` call |
| `agent:` (Agent-tool sub-agent) | its spawning `agent:` | stream: `parent_tool_use_id` |
| `visit:` | its `execution:` | lifecycle `execution_id` (when the station runs inside a supervised execution) |
| `seat:` | `gate:<t>/review#<r>` | lifecycle `review.round_started` |
| `execution:` | `cell:` | v2 `ticket_id` |

Workflow agents have no children: they had no Agent tool in the proof (`spawnDepth: 1` for all 29 belt agents). An agent is **not** made the child of a visit by time overlap. Worker labels are written by `belt.js` (`"<ticket>: build"`, `"<ticket>: verify"`, `"<ticket>: security reviewer"`), so the observer sets `ids.ticket_id`, `ids.station` and `ids.seat` from them and lists each in `inferred` with rule `label` **[A3]**. It does **not** set `visit_id`: which visit a worker served is the lifecycle log's business. Clerk agents (`"what next?"`, all in phase `Preflight`) get no station. `phase` is what the script passed, not the station.

---

## 6. Time and order

### 6.1 Occurred and observed

| Source | `occurred_at` | `precision` | Bounds |
|---|---|---|---|
| intake-log | `at` + 999 ms | `s` | `[at, at + 999 ms]` |
| cell-lifecycle | `at` | `ms` | none |
| execution-record | `started_at` / `ended_at` + 999 ms | `s` | one second |
| run-record | `closed_at` + 999 ms | `s` | one second |
| execution-stream, a record with its own time (`assistant`/`user` `timestamp`; an agent's `queuedAt`, `startedAt`, `startedAt + durationMs`; `task_updated.patch.end_time`) | that time | `ms` | none |
| execution-stream, a record without its own time (heartbeats, `task_started`, `task_notification`, `permission_denied`, `init`, `result`), read live | the poll that read the line | `arrival` | `[previous poll, this poll]` |
| execution-stream, a record without its own time, read after the fact | null | `bounded` | between the nearest earlier and later records of the same file that carry their own time; `[process start, process end]` from `execution-record` when there are none; `unknown` if neither exists |
| observer | as its basis | as its basis | as its basis |

No timing sidecar is written by the executor in M6.1 (lead's decision 7): a stream read after the fact keeps only the times it carries itself. One irregularity is kept as it is: the first turn's `result` is written at the end of the file, next to the second, so its line position is not its moment; it carries no time and is placed by its line.

Why `+ 999 ms` for whole-second records: an intake or supervisor event records a decision made from what was already on disk, so placing it at the end of its second never puts it before a millisecond-stamped fact it may have read. The true bounds are still given.

`observed_at` is when the observer first read the record, in milliseconds. For backfilled history it is the backfill time, which is why nothing measures durations from `observed_at` except arrival-stamped stream events, where it is the best measurement there is.

Known lateness of v2 times (M6.0 gaps 2.1), kept as facts, not corrected: `station.observed` and `slice.integrated` are stamped when the supervisor or plan noticed; `execution.completed` up to `poll_seconds` after the process ended. The true process end is the `execution.process_ended` event (`execution-record`); the Timeline uses that for the span (shared contracts, section 2).

### 6.2 `order_ms`

`order_ms = max(occurred_ms, order_ms of the previous event of the same source partition)`, where `occurred_ms` is `occurred_at`, or `not_before` when `occurred_at` is null. So each source's own order (its `seq`) is never contradicted by clock adjustments, and unstamped stream lines stack, in line order, at the earliest moment they can have happened. `order_ms` can therefore be later than `occurred_at` (a snapshot that reports an agent's `startedAt` arrives after the agent started); spans and durations always use `occurred_at`, never `order_ms`. A client draws events with `precision: unknown` or `bounded` as a sequence, not at a point (shared contracts, section 2.4).

### 6.3 The history order key

```
order = <order_ms, 15 digits> ~ <source rank> ~ <origin.key> ~ <seq, 12 digits> ~ <part, 4 digits>
source rank: intake-log 1, cell-lifecycle 2, execution-record 3, run-record 4, execution-stream 5, observer 6
```

Lexicographic order of `order` is the history order. It is computed only from the event and its predecessors in the same partition, so **rebuilding the index from the same files gives the same order**. Ties across sources in the same millisecond are broken by rank, which carries no meaning: equal times are not evidence of causality, and nothing may read them as such. Observer events take their basis event's `order_ms` and `seq`, rank 6, key `o`, and their own index `n` as `part`, so a reconstructed finding sorts just after the vote it was read from, and the key stays deterministic. (When an observer event has several basis events, the latest in `order` is the basis for ordering.)

### 6.4 Delivery position, epoch and cursor

- The observer assigns `pos` = 1, 2, 3… as it commits events to its index, in commit order, and persists it with the event. Re-reading a source never re-assigns `pos` to an id it already has.
- The index has an **epoch**, a random id made when the index is created. A cursor is `<epoch>.<pos>`.
- **Restart**: the observer reopens its index, keeps its epoch and `pos` values, and resumes each source from its saved offset (byte offset and line number, plus the file's identity: device, inode, size, and the generation hash). Every cursor issued before the restart stays valid.
- **Index lost or deliberately rebuilt**: a new epoch. A client presenting an old epoch gets `reset` (section 14) and reloads; because ids and `order` are deterministic, the reloaded history is the same, except for stream arrival times (D11 index loss loses them; they become `bounded`) **[A4]**.

### 6.5 Settling, late arrivals, duplicates, conflicts

- **Settle window.** The observer holds each event for `W` = 1.5 s after reading it before committing, and commits held events in `order`. One second covers v2's whole-second times; the extra half covers a station script's write landing just after a poll. Within `W`, everything is delivered in history order.
- **Late.** An event whose `order` sorts before the last committed `order` is still committed (append-only `pos`) with `late: true`. The client engine inserts it by `order` and recomputes from its nearest checkpoint (M6.0 architecture 7.2 already plans this). Typical causes: a lifecycle file discovered after its cell started; an archive read after the cell folder was gone; backfill.
- **Duplicate.** Same id, same content hash: dropped. This is how the archive copy of `lifecycle.jsonl`, a re-read after restart, and a v2 line rewritten identically are absorbed.
- **Conflict.** Same id, different content: the first is kept; the observer emits `history.gap` with `reason: conflict` and the range. This would mean a source rewrote history, which none is allowed to do.
- **Gaps.** A missing `seq` (v2 is +1 per event; in a lifecycle log, a jump between two non-null `seq` values), an unparsable line (v2's partial-line risk, M6.0 gaps 2.1; a torn lifecycle line), a file that shrank or whose first line changed (`truncated`, `rewritten`): `history.gap` with the range. Nothing is invented to fill it.
- **Lost lifecycle writes leave no gap.** The helper swallows its own failures and takes the next `seq` from the file, so a record that was never written is invisible in the sequence. The observer therefore compares, when a cell's log has been quiet for `W` and its `cell.json` is newer, the stage the log implies with `cell.json`'s stage; a difference is `history.gap` with `reason: state-mismatch` ("records are probably missing here"). It never fabricates the missing records.

### 6.6 The live edge

The observer publishes a **watermark**: the `order_ms` up to which it asserts history is complete, apart from late arrivals. It is `min(now − W, oldest unread data among live sources)`. The client's `liveAt` (M6.0 `scene/store.ts`) becomes this watermark, set by the stream, never advanced by the frame loop; `seek` beyond it clamps.

---

## 7. Authority, provenance and causality

| Authority | Meaning | Who |
|---|---|---|
| `authoritative` | A MACH script recorded the fact as it decided it, in a write-once or append-only record. | intake-log (except `station.observed`), cell-lifecycle, execution-record, run-record |
| `observed` | Seen in a runtime record that MACH did not decide: Claude's stream; and the supervisor's sampling of `cell.json` (`station.observed`). | execution-stream; `station.observed` |
| `reconstructed` | Derived afterwards by the observer from state files, archives or other events. Carries `provenance`. | observer |

Two clarifications. A lifecycle record read from an archive is still `authoritative`: the record was written by the deciding script at the time, and copying the file does not change who wrote it. And the lifecycle helper itself calls its log "observational" because the station's own files remain the state of record; in this contract that is expressed by precedence, not by authority: where a lifecycle record and a station file disagree, the file is the state and the disagreement is a `history.gap` (`state-mismatch`).

Display rule (from M6.0 gaps 5.3 and ARCHITECTURE item 8): **recorded gate results outrank inferred agent activity.** Where an observed or reconstructed event disagrees with an authoritative one about the same entity (for example a reconstructed task completion from `build.json` versus a lifecycle `build.task_completed`), the observer keeps the authoritative one and does not emit the other; it never asks a renderer to choose.

**Causality.** `cause` is set only when:

| `basis` | Case |
|---|---|
| `recorded` | A writer wrote the link. v2 `cause` (a seq) maps to `i:<gen>:<seq>`. Lifecycle records do not carry one in v1 **[A5]**. |
| `identity` | Two records share an identifier that one created for the other: `tool.returned` ← `tool.called` (same `tool_use_id`, main loop and Agent-tool sub-agents); `agent.started`, `agent.progressed`, `agent.finished` ← `agent.queued` (same workflow and `index`); `workflow.finished` ← `workflow.started` (same `task_id`); `execution.started` ← `work.claimed` (same `execution_id`, and the supervisor writes the claim before the start); `station.exited` ← `station.entered` (same `visit`); `review.decided` ← `review.round_started` (same ticket and round). |

Not causes, ever: "this event came right after that one", "this agent ran while that visit was open", "this slice became ready in the same second that slice integrated". The M6.0 picture's unlock edge (an integration freeing a slice) would need v2 `dependency.resolved.cause`, which stays unfilled in M6.1 (D2): the edge is drawn as "became ready" without a source.

---

## 8. Unknown, unobserved, stale, interrupted, partial

| Condition | Representation |
|---|---|
| A field applies but is not known | `null` and named in `unknown` (e.g. `ids.execution_id` for a lifecycle event written outside a supervised run; `agent.started.data.agent_type` for a clerk, which has none). |
| A field filled by inference | named in `inferred` with its rule. |
| Time not known | `time.precision: unknown` or `bounded`, with bounds. |
| Something never observed (no source exists) | No event. The catalog (section 11) and the Analytics metric catalog say which facts have no source, so the UI can say "not recorded" instead of drawing nothing. |
| A source is stale (an execution's process is alive but its stream has not grown in `T`; a lifecycle file of a cell in an active stage unchanged for `T`) | Not an event (it depends on wall time and would not rebuild deterministically). Reported in the transport's `sources` status (section 14), with `state: stale`. |
| An execution interrupted, or ended with spans open | `execution.process_ended` (`ended: interrupted`, `timed-out`) or, with no result, v2 `recovery.started` (`outcome-unknown`). A killed workflow reports its agents itself (`state: error`, observed as `agent.finished` with `status: error`). An agent or main-loop tool call still open with no closing record is closed by an observer event of the same kind (`agent.finished`, `tool.returned`) with `status: unknown`, `authority: reconstructed`, `precision: bounded` (`not_after` = the process end or the recovery time), id `o:close:<ref>`. A visit still open when its execution ended is **not** closed: the lifecycle log is the only authority on visits, and the cell may be resumed. |
| History begins part-way (a cell with no lifecycle log; an archive without one; the observer added to a project with work in flight) | `history.began` for the entity, `authority: reconstructed`, with a snapshot (stage, round, station) read from `cell.json` or the archive, and a `reason`. Before it, the entity has no history and the UI says so. |
| A range of a source is missing or corrupt | `history.gap` (section 6.5). |
| A workflow agent's individual tool calls | Not observable (D13). No event, ever; `agent.progressed.data.tool_calls` is the count. |

### 8.1 Honest degraded states

What the Control Tower may draw for a **running Dynamic Workflow agent**, and only from these events:

| May draw | From |
|---|---|
| That it is queued, running, done, failed, or ended unknown | `agent.queued`, `agent.started`, `agent.finished` (`status`) |
| Its label, phase, model and agent type | `agent.queued`, `agent.started` |
| Elapsed time since `startedAt` (a clock, not a fraction); its final duration | `agent.started.occurred_at`; `agent.finished.data.duration_ms` |
| Its tool-call count and the name of the last tool seen, updated when a snapshot arrives (every few seconds, and at every start and finish) | `agent.progressed` |
| Its token total (one number; no input/output split, no cost) | `agent.progressed`, `agent.finished` |
| Its refused calls, by tool name | `tool.refused` with `ids.agent_id` |
| Which ticket, station and seat it works for, marked as read from its label | `ids` with `inferred: label` |

What it **must not** draw:

- individual tool activity of a workflow agent: no tick per call, no tool-call bar, no "now running `Bash`" beyond the last tool name a snapshot reported, no per-call duration;
- artifacts being written by an agent: an artifact appears when an authoritative event names it (shared contracts, section 3), never as an agent's live output;
- a progress fraction or percentage for an agent, a visit or a workflow; the only fraction is verification's checks recorded of targets listed, which are both recorded;
- a per-agent cost, or a per-agent token split, estimated or otherwise;
- a phase as a moment ("the belt entered Review at …"): only the declared phase list and each agent's phase exist;
- workflow `log()` lines: they are not in the stream;
- "completed" for a workflow whose `workflow.finished.status` is not `completed`.

A heartbeat (a `task_progress` without a snapshot) is not turned into an event: it names the agent only by label and does not say which tool, so it would invite exactly the drawing forbidden above. The observer uses heartbeats only to say a source is live (section 14, `sources`).

---

## 9. What the browser may receive

The observer is the only reader of raw sources. It forwards only the per-kind allow-list in the schema's `$defs`; there is no pass-through of `data`.

### 9.1 Never leaves the observer

| From | Never forwarded |
|---|---|
| stream.jsonl | Tool `input` and results (`tool_result` content, `tool_use_result`, including `originalFile`), `Bash` command text and arguments, `Edit` strings, absolute paths (`cwd`, `transcriptDir`, `scriptPath`, `output_file`), `task_started.prompt` (the whole workflow script), `promptPreview`, `resultPreview`, `lastToolSummary` (a prefix of the command or path), `summary`, heartbeat `description`, agents' `error` text, `permission_denials[].tool_input` (full refused commands), `permission_denied.message`/`decision_reason`, assistant text and thinking, `post_turn_summary`, `rate_limit_event`/`rate_limit_info`, `credential_expires_at`, `apiKeySource`, MCP and skill lists beyond names, the workflow's `learning` text, session and run ids |
| execution folder | `spec.json` (the whole argv, the allow list, paths), `stderr.log` (read by the observer only for the budget line, section 10.5), `wrapper.log`, process ids |
| v2 events | `session_id`, `previous_pid`, `previous_heartbeat`, `refs` (project-relative paths; the browser cannot use them), people's names in `by` and `approval.actor` (replaced by `by_role`) |
| station files | `failure_tail`, `output_tail`, `test-suite.log`, `contract-check.log`, `findings.md` body, vote `summary`, deviation `detail`, `human_approval.by` and `note`, `intent.md` actor |
| everything | environment values; anything whose name matches `executor.CREDENTIAL_NAME_RE`; any path outside the project (reported as `target_class: outside-project`) |

### 9.2 Allowed, with limits

IDs, stages, actions, gate verdicts and reason codes, counts, durations, recorded costs and token counts, tool *names*, MACH script names with their subcommand (`build.py green`, from an allow-list of MACH's own scripts), project-relative and cell-relative paths (except names matching the credential pattern or `.env*`, which become `target_class` only), spec IDs, evidence file names and hashes, commit SHAs and branch names, MACH-written prose (`dependency.blocked.reasons`, `human.required.reason`, `held[].why`, `intake.refused.problems`; length-capped), and finding titles with their rule IDs (model-written; capped at 200 characters; always shown as text, never as HTML, and marked as model-written prose in Evidence Theater).

### 9.3 Where it is enforced

In the observer's normaliser, per kind, by construction: each kind's output struct has only the allowed fields. A conformance test feeds the observer every fixture in `tests/fixtures/execution-streams/` and a stream with planted secrets (an `.env` read, a `Bash` command with a token, an `Edit` of a credential file) and asserts none of the planted strings appears in any served byte (the same technique as `test_mach_factory_supervisor.py` line 542, which asserts `SECRET123` never reaches the v2 log).

---

## 10. Normalisation per source

### 10.1 intake-log (v2) to v3

Field mapping: `seq` → `origin.seq` and the id; `at` → `time` (section 6.1); `type` → `type` unchanged; `project_id`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `runner_id`, `execution_id` → `ids.*`; `source` → `origin.writer`; `cause` → `cause` (`basis: recorded`); `refs` → server-only, replaced by `entities`; `data` → the kind's allow-list. `source_commit` → server-only (kept on the index; exposed only through `revision.discovered`). Kinds are not renamed.

### 10.2 cell-lifecycle (v1 raw) to v3

Raw (`schemas/cell-lifecycle.schema.json`, written by `skills/intent/scripts/lifecycle.py`; both are uncommitted work in progress on this branch, read as they stood when this was written): `{"v":1, "seq", "at", "ticket_id", "type", "station", "visit":"<station>#<n>", "round", "execution_id", "data"}`. The lead has told the lifecycle author to call the judging round `round` on disk (decision 2); a file written before that change calls it `attempt`, and the normaliser accepts either, never both.

| Raw | v3 |
|---|---|
| physical line, file generation | `origin.seq`, `origin.key = c:<ticket>:<gen>`, `id` |
| `seq` | checked only (gaps between non-null values); not part of the id |
| `at` | `time.occurred_at`, `precision: ms` |
| `type` | `type` unchanged |
| `station` | `ids.station` |
| `visit` | `ids.visit_id = <ticket>/<visit>` |
| `round` (or `attempt` in older files) | `ids.round` |
| `execution_id` (from `MACH_EXECUTION_ID`, which `executor.wrapper` now sets) | `ids.execution_id`; when null, listed in `unknown` |
| `data` | the kind's allow-list, below |
| — | `ids.slice_id`, `wave_id`, `revision`, `project_id` from `cell.json.product` and the ledger (identity, not inference) |
| — | `origin.script` from the station (`audit` → `audit.py`, `groom`/`plan` → `cell.py`, …) |

Data mapping, raw → v3 (anything the raw record lacks is null and listed in `unknown`; nothing is invented):

| Type | Raw `data` (as the call sites write it) | v3 `data` |
|---|---|---|
| `station.entered` | `stage`, plus per station: `mode`, `resumed`, `isolation` (groom); `tasks`, `synced_with_main`, `revision`, `findings_copied` (build); `head`, `items`, `suite_passed`, `contracts_valid`, `previous_evidence` (verify); `head`, `round` (review); `method`, `behind_main` (merge); `unclosed_visit` when re-entered without an exit | `station`, `stage`, `action` (`revise` when `revision` is present, else the station's own action: identity, not inference), `resumed`, `unclosed_visit`, `head`, `counts` (the integer and boolean facts only) |
| `station.exited` | `outcome` (the station's own word: `built`, `PASS`, `APPROVED`, `merged`, `pr-open`, `escalated`, `spec-open`, a merge error code, an audit tier…), `stage`, counts; `closed_by: "cleanup"` when cleanup closed a visit left open | `station`, `outcome` (verbatim, ≤ 40 characters), `stage`, `duration_ms` (computed from the matching entry), `closed_by`, `head`, `counts` |
| `gate.evaluated` | `gate` (namespaced: `audit.readiness`, `groom.finalize`, `plan.check`, `build.start`, `build.<command>`, `build.finish`, `round-limit`, `verify.start`, `verify.finish`, `verify.verdict`, `verify.<command>`, `review.start`, `review.<command>`, `merge.run`, `merge.land`, `cleanup.run`), `outcome` (`pass`, `refuse`, `override`), `reason_code`, `overridden_by_reason`, and `task`, `item`, `seat`, `audit_tier`, counts | `gate`, `verdict` (`passed`, `refused`, `overridden`), `reason_code`, `subject` (from `task`, `item` or `seat`), `status` (`verify.verdict`'s `reason_code` `PASS`/`FAIL_WITH_EVIDENCE`; `INCOMPLETE_EVIDENCE` for `verify.finish` refused with `incomplete-evidence`), `audit_tier`, `counts` |
| `build.task_completed` | `task`, `kind`, `step`, `first_run`, `suite`, `commit` | `task_id`, `kind`, `step`, `first_run`, `suite`, `commit` |
| `verify.check_recorded` | `item`, `kind`, `result`, `evidence[{path, sha256}]` | `target_id`, `target_kind`, `result`, `evidence[{file, sha256, bytes}]` (`bytes` from the file when the observer hashes it), `rerecorded` (an earlier record of the same item in the same visit: identity) |
| `review.round_started` | `round`, `max_rounds`, `risk`, `tuning`, `seats[]`, `models{seat: model}`, `approvals_needed`, `human_approval_required`, `delta` | `risk`, `max_rounds`, `tuning`, `approvals_needed`, `human_approval_required`, `panel[{seat, model}]`, `delta`, `restarted` (a second start of the same round) |
| `review.verdict_submitted` | `round`, `seat`, `vote`, `blockers`, `notes`, `rules[]` (spec and matrix IDs only) | `seat`, `vote`, `blockers`, `notes`, `rules`, `model` (from the round's panel: identity) |
| `review.decided` | `round`, `decision`, `approvals`, `needed`, `votes{}`, `blockers`, `security_veto`, `human_approval_required` | `outcome`, `approvals`, `approvals_needed`, `votes`, `blockers`, `security_veto`, `human_approval_required` |
| `human.approval_recorded` | `round`, `decision`, `note_given` | `by_role: "person"`, `note_given` |
| `merge.completed` | `method`, `approved_commit`, `landed_commit`, `merge_commit`, `revalidated`, `pull_request` | the same |
| `cleanup.completed` | `outcome`, `archive`, `bundle`, `uncommitted_saved` (in the archived copy of the log only) | the same |

`review.round_started.panel` also yields one `seat:` entity per seat, so seats exist in the picture even when no reviewer agent is observed. The approving commit (`head`) of a review is on the round's `station.entered`, not on its verdicts or decision.

Not in the lifecycle log, by design of the helper: test exit codes and seconds (they stay in `build.json tasks[].test_run`), verification targets beyond their count (`items`; the list is reconstructed by the observer, section 10.6), finding text, approver names, a separate merge-revalidation record (revalidation shows as `merge.completed.revalidated` or a refused `merge.land` gate with its error code).

### 10.3 execution-record

`started.json` → `execution.process_started` (`occurred_at` = `started_at`); `result.json` → `execution.process_ended` (`ended`, `exit_code`, `seconds`). `ids.ticket_id` comes from the ledger's `supervisor.executions[x]` (identity). Execution folders without a ledger record (none expected today) get `ticket_id` null and `unknown: ["ticket_id"]`.

### 10.4 run-record

Each `runs.jsonl` line → `run.recorded` with the counts the observe station reads (shared contracts, section 4). It is the cell's authoritative completion record and the only one that survives deletion of the cell folder, because cleanup appends it after the archive is written and the folder removed.

### 10.5 execution-stream

From the proof (`M6_1_STREAM_COMPATIBILITY.md` sections 3 and 4; fixtures in `tests/fixtures/execution-streams/`). A belt execution's stream is: the main loop's `Workflow` `tool_use` → `system/task_started` (`task_type: local_workflow`) → the `tool_result` (`async_launched`) → many `system/task_progress` (snapshots with `workflow_progress[]`, and heartbeats without) → `system/task_updated` (`patch.status`, `patch.end_time`) → `system/task_notification` → a second `init` → **two `result` records**, the first written last.

| v3 kind | From | Rule |
|---|---|---|
| `session.initialized` | the first `system/init` | version, model, permission mode, tool and agent names |
| `workflow.started` | `system/task_started` with `task_type: local_workflow` | `workflow:` ref from `task_id`; parent = the `Workflow` call; ticket ids from the call's arguments, extracted as ids only |
| `workflow.phases_declared` | the first snapshot's `workflow_phase[]` | the declared list (`index`, `title`); not "phase entered" |
| `agent.queued` | the first snapshot holding a new `index` | `index`, `label`, `phaseTitle`, `phaseIndex`, requested model alias; `occurred_at` = `queuedAt` |
| `agent.started` | the first snapshot where that `index` has `agentId` and `startedAt` | `ids.agent_id = <x>/<agentId>`; full model id, `agentType` (absent for clerks), `attempt` → `data.agent_try`; `occurred_at` = `startedAt`; `ids.ticket_id`, `station`, `seat` from the label (`inferred: label`) |
| `agent.progressed` | a later snapshot in which that agent's `toolCalls`, `tokens` or `lastToolName` changed | cumulative `tool_calls`, `tokens`, `last_tool` (a tool name; for workflow tasks the heartbeat field `last_tool_name` holds the label and is never used); `occurred_at` = the agent's `lastProgressAt` |
| `agent.finished` | the snapshot where `state` becomes `done` or `error` | `status`, `duration_ms` = `durationMs`, final `tokens`, `tool_calls`; `occurred_at` = `startedAt + durationMs` |
| `tool.called` / `tool.returned` | `tool_use` / `tool_result` pairs of the **main loop** and of **Agent-tool sub-agents** (`parent_tool_use_id`, `agent_id`) | correlated by `toolu_` id; `occurred_at` = the record's `timestamp`. In a belt execution the main loop makes one call: `Workflow` |
| `tool.refused` | `system/permission_denied` | `tool` name, `summary` as `executor.tool_summary` computes it (from `result_index: 0.permission_denials[].tool_input`, server-side, never forwarded); `ids.agent_id` from `agent_id` when present; `ids.tool_call_id` stays null for a workflow agent's refusal (its call never appears) and the raw id is withheld |
| `workflow.finished` | `system/task_updated` (`patch.status`, `patch.end_time`), joined with `task_notification` (`status`, `usage`) and the workflow JSON of `result_index: 1` | `status` is `task_updated.patch.status` only (D14); `workflow_json` says whether `result_index: 1` held the workflow's JSON; `tickets[]` (with `stations[]`) from that JSON; `stop_reason: budget` when a result has `subtype: error_max_budget_usd`, or when `stderr.log` holds Claude Code's "Budget limit reached" line (`inferred: {"data.stop_reason": "stderr-line"}`); `unknown` for any other `killed` |
| `execution.usage` | the last `result` | `total_cost_usd`, `subtype`, `is_error`, `terminal_reason`, `budget_exhausted` (= `subtype == error_max_budget_usd`), per-model `cost_usd` and token kinds from `modelUsage`. `result.duration_ms` and `num_turns` describe the last turn only and are not forwarded |

Not turned into events: heartbeats (section 8.1), `background_tasks_changed`, `rate_limit_event`, assistant text, the second `init`, `subagent_stats` (it counts Agent-tool sub-agents only and reads 0 for a workflow).

Snapshots restate every agent, so the normaliser **diffs** each snapshot against the last one it saw for that workflow (by `index`) and emits only changes; re-reading the same file gives the same diffs, so ids stay deterministic.

The parser is pinned to `claude_code_version` 2.1.322 (from `system/init`). For another version it emits only `session.initialized`, `tool.refused` and `execution.usage`, plus `history.gap` with `reason: unknown-type` counting what it skipped, and the transport's `capabilities.stream_observations` says why; it never guesses a format.

### 10.6 Observer reconstruction

| Kind | From | When |
|---|---|---|
| `review.finding` | `review/round-N/votes/<seat>.json`, one per finding | after the `review.verdict_submitted` that names the file; `order` = the verdict's plus rank 6; per-finding time is the vote's time (findings are not submitted one at a time) |
| `artifact.recorded` | the artifact named by an authoritative event (evidence files from `verify.check_recorded`; commits from `build.task_completed`; votes; decisions; the merge commit) and the cell's fixed artifacts (`intent.md`, `spec.md`, `spec.json`, `plan.md`, `build-report.json`) at the visit that produced them | hash computed or rechecked by the observer; `integrity` says whether it matches the recorded hash |
| lifecycle point kinds (`build.task_completed`, `verify.check_recorded`, `review.verdict_submitted`, `review.decided`, `human.approval_recorded`, `merge.completed`) | the same station files, **only for cells with no lifecycle log** | each from a record that carries its own time (`build.json tasks[].at`, `results.json records[].at`, `votes/*.json at`, `decision.json decided_at`, `cell.json merged.at`); `precision: s`; `station.entered`/`exited` are **never** reconstructed (there is no record of them) |
| `verify.targets_listed` | the cell's `spec.json`, recomputed as `verify.py Cell.targets` does (scenarios and matrix rules; holdouts from `.factory/holdouts/<ticket>/` by id only) | at each verify `station.entered`; lead's decision 3 |
| `capacity.wait_changed` | a v2 `scheduling.decided` whose `held[]` has a `ticket_id` with the supervisor's fixed sentence `all <n> place(s) are in use` (`supervisor.py schedule`) → `waiting`; the next `scheduling.decided` that no longer holds it for that reason → `released` | `inferred: {"data.state": "held-sentence"}`; scope `execution` (places for executions). A slice waiting for a free cell is filtered out of v2 and stays `unknown`; silence is never read as waiting (D16) |
| `agent.finished`, `tool.returned` with `status: unknown` | an execution that ended with them open | section 8 |
| `history.began`, `history.gap` | sections 6.5 and 8 | |

---

## 11. The kind catalog

`Req. ids` are the `ids` fields that must be non-null (the schema enforces them). `Replaces` names the M6.0 simulation kind this one takes over. Payloads list browser-safe `data` fields; the schema's `$defs` is exact.

### 11.1 From the intake log (22 kinds, all exist today, names and meanings unchanged)

| Kind | Authority | Req. ids | `data` (browser-safe) | Replaces |
|---|---|---|---|---|
| `wave.discovered` | authoritative | `wave_id` | `slices`, `approval{approved_at, by_role}` | same |
| `intake.validated` | authoritative | | `digest` | same |
| `intake.refused` | authoritative | | `problems[]` | same |
| `slice.materialized` | authoritative | `slice_id`, `ticket_id` | `digest`, `adopted`, `dependencies[]`, `reissued` | same |
| `slice.integrated` | authoritative | `slice_id` | `commit` | same |
| `dependency.resolved` | authoritative | `slice_id` | `depends_on[]` | same |
| `dependency.blocked` | authoritative | `slice_id` | `reasons[]` | same |
| `work.scheduled` | authoritative | `slice_id`, `ticket_id` | `stage`, `risk`, `branch`, `by_role`, `authorization` | same |
| `revision.superseded` | authoritative | `slice_id` | `from_revision`, `effect` | same |
| `human.required` | authoritative | | `reason` | same |
| `factory.activated` | authoritative | | `autonomy`, `by_role`, `limits`, `allow_merge`, `persistent`, `backlog`, `excluded_slices` | same |
| `factory.disabled` / `paused` / `resumed` | authoritative | | `by_role`; `stopped` / `reason` / `retrying[]` | same |
| `revision.discovered` | authoritative | | `from_commit`, `commit` | same |
| `scheduling.decided` | authoritative | | `state`, `dispatched[]`, `started[]`, `held[{slice_id, ticket_id, why}]` | same |
| `work.claimed` | authoritative | `ticket_id`, `execution_id` | `stage`, `next`, `attempt` | same |
| `execution.started` | authoritative | `ticket_id`, `execution_id` | `until`, `workflow`, `limits{minutes, budget_usd}` | same |
| `station.observed` | **observed** (sampled) | `ticket_id` | `from_stage`, `stage` | same; for display, superseded by `station.*` where a lifecycle log exists |
| `recovery.started` | authoritative | | `kind` | same |
| `execution.completed` | authoritative | `ticket_id`, `execution_id` | `stage`, `next`, `waiting_for`, `how`, `seen_to_end`, `cost_usd`, `refused_tools[]` | same |
| `execution.failed` | authoritative | `ticket_id`, `execution_id` | `stage`, `next`, `how`, `claude_error`, `exit_code`, `attempt` | same |

### 11.2 From cell lifecycle logs (11 kinds, being implemented now)

All authoritative; req. ids `ticket_id`, `cell_instance`, `visit_id`, `station` (plus `seat` for verdicts). `ids.round` is set for build, verify, review and human-approval, null elsewhere.

| Kind | `data` | Replaces (M6.0) |
|---|---|---|
| `station.entered` | `station`, `stage`, `action`, `resumed`, `unclosed_visit`, `head`, `counts` | `station.entered`; with `action: revise`, also `build.revised`; with `station: verify`, `verification.started` (with `verify.targets_listed`) |
| `station.exited` | `station`, `outcome`, `stage`, `duration_ms` (observer-computed from the matching entry, same clock), `closed_by`, `head`, `counts` | `station.left`; its `stage` replaces `cell.stage_changed` |
| `gate.evaluated` | `gate`, `verdict`, `reason_code`, `subject`, `status`, `audit_tier`, `counts` | `gate.checked` (`audit.readiness`, `plan.check`); `verification.verdict` (`verify.verdict`); refused red/green attempts (`build.red`, `build.green`), which M6.0 could not show; `merge.revalidated` only as a refused `merge.land` (pass shows in `merge.completed.revalidated`) |
| `build.task_completed` | `task_id`, `kind`, `step`, `first_run`, `suite`, `commit` | `task.red`, `task.green`, `task.done`; `test.result` only as `first_run` and `suite` |
| `verify.check_recorded` | `target_id`, `target_kind`, `result`, `evidence[{file, sha256, bytes}]`, `rerecorded` | `evidence.captured` |
| `review.round_started` | `risk`, `max_rounds`, `tuning`, `approvals_needed`, `human_approval_required`, `panel[{seat, model}]`, `delta`, `restarted` | `review.started` |
| `review.verdict_submitted` | `seat`, `vote`, `blockers`, `notes`, `rules[]`, `model` | `review.vote` |
| `review.decided` | `outcome`, `approvals`, `approvals_needed`, `votes{seat: vote}`, `blockers`, `security_veto`, `human_approval_required` | `review.decided` (outvoted blockers: a seat that voted `REJECT` in an `APPROVED` round) |
| `human.approval_recorded` | `by_role`, `note_given` | `human.approval_recorded` (the name is dropped) |
| `merge.completed` | `method`, `merge_commit`, `approved_commit`, `landed_commit`, `revalidated`, `pull_request` | `merge.completed`; `merge.revalidated` (passed) |
| `cleanup.completed` | `outcome`, `archive`, `bundle`, `uncommitted_saved` | `cleanup.completed` |

### 11.3 From execution records and the run record (3 kinds, exist today as files)

| Kind | Authority | Req. ids | `data` | Replaces |
|---|---|---|---|---|
| `execution.process_started` | authoritative | `execution_id` | none (the time is the fact) | nothing (M6.0 used `execution.started`'s time) |
| `execution.process_ended` | authoritative | `execution_id` | `ended`, `exit_code`, `seconds` | nothing |
| `run.recorded` | authoritative | `ticket_id` | `record_version`, `outcome`, `rounds`, `first_pass`, `verify_failures`, `review_rejections`, `escalated`, `human_approval`, `deviations` (count), `blockers` (count), `tests_seen_failing_first`, `tests_passing_on_first_run`, `risk`, `app_type`, `merge_method`, `merge_commit` | nothing (feeds Analytics) |

### 11.4 From execution streams (12 kinds; observed; proven for Claude Code 2.1.322)

| Kind | Req. ids | `data` | Replaces |
|---|---|---|---|
| `session.initialized` | `execution_id` | `claude_code_version`, `model`, `permission_mode`, `tools[]`, `agents[]` | nothing |
| `workflow.started` | `execution_id` | `workflow`, `tickets[]`, `until` | `workflow.started` |
| `workflow.phases_declared` | `execution_id` | `phases[{index, title}]` | `workflow.phase` (as a declared list, not as moments) |
| `workflow.finished` | `execution_id` | `status`, `notification_status`, `total_tokens`, `tool_uses`, `duration_ms`, `stop_reason`, `workflow_json`, `tickets[{ticket, outcome, stage, waiting_for, stations[]}]` | `workflow.finished` |
| `agent.queued` | `execution_id` | `index`, `label`, `phase`, `phase_index`, `model` (the alias asked for) | nothing |
| `agent.started` | `execution_id`, `agent_id` | `index`, `label`, `phase`, `phase_index`, `agent_type`, `model`, `agent_try` | `agent.started` |
| `agent.progressed` | `execution_id`, `agent_id` | `tool_calls`, `tokens`, `last_tool` | the 690 `tool.started` of the fixture, as a count |
| `agent.finished` | `execution_id`, `agent_id` | `status`, `duration_ms`, `tokens`, `tool_calls` | `agent.finished` |
| `tool.called` | `execution_id`, `agent_id`, `tool_call_id` | `tool`, `target_class`, `script`, `path_rel` | `tool.started`, **for the main loop and Agent-tool sub-agents only** |
| `tool.returned` | `execution_id`, `agent_id`, `tool_call_id` | `status`, `duration_ms` | `tool.finished`, same limit |
| `tool.refused` | `execution_id` | `tool`, `summary` | nothing (M6.0 showed refusals only in `execution.completed.refused_tools`) |
| `execution.usage` | `execution_id` | `total_cost_usd`, `subtype`, `is_error`, `terminal_reason`, `budget_exhausted`, `models{<model>: {cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens}}` | nothing |

`agent_id` for main-loop calls is `<execution_id>/main`. `ids.ticket_id` for stream events is the execution's ticket (ledger), except for workflow agents, whose label names their ticket (`inferred: label`): that is how the belt's tuning ticket, run inside another ticket's execution (M6.0 gap G4), is attributed to its own cell.

### 11.5 From the observer (6 kinds; reconstructed)

| Kind | Req. ids | `data` | Replaces |
|---|---|---|---|
| `review.finding` | `ticket_id`, `round`, `seat` | `seat`, `n`, `severity`, `rule`, `file_rel`, `title` | `review.finding` |
| `artifact.recorded` | `ticket_id` | `kind`, `path_rel`, `sha256`, `bytes`, `media_type`, `commit`, `nature`, `integrity` | `artifact.written` |
| `verify.targets_listed` | `ticket_id`, `visit_id` | `targets[{id, kind}]`, `source: "spec.json"` | the targets of `verification.started` |
| `capacity.wait_changed` | `ticket_id` | `state`, `scope`, `limit` | nothing (M6.0 had no capacity wait) |
| `history.began` | | `reason`, `snapshot{stage, round, station, state}` | nothing |
| `history.gap` | | `source_key`, `from_seq`, `to_seq`, `reason`, `count` | nothing |

Total: 54 kinds (22 + 11 + 3 + 12 + 6). M6.0 kinds with **no** v3 kind: `task.started` (no source: `build.py next` records nothing; shared contracts 2.3 says how the Timeline shows a task without a start), `workflow.phase` as a moment (only the declared list and each agent's phase exist), `tool.started`/`tool.finished` for workflow agents (not observable; a count instead), `cell.stage_changed` and `build.revised` and `verification.started` (folded into `station.*` data), `test.result` (folded into `build.task_completed`, without exit codes, seconds or counts), `merge.revalidated` (folded into `merge.completed` and the `merge.land` gate).

---

## 12. Migration from the M6.0 simulation

### 12.1 Envelope

| M6.0 field (v2 + `t`) | v3 | Note |
|---|---|---|
| `schema_version: 2` | `schema_version: 3`, `schema_revision` | |
| `seq` (one global counter in the fixture) | `id` (string), `origin.seq` (per source), `pos` (delivery) | `eventBySeq`, `indexBySeq`, `seekToSeq`, chapters' `seq` and `cause` re-key to `id` |
| `at` (whole seconds) | `time.occurred_at` + `precision` + bounds; `time.observed_at` | |
| `t` (ms since scenario start) | `time.order_ms` (Unix ms) | The client keeps `t` as an internal number: `t = order_ms`, or `order_ms − origin` for display. `indexFixture`'s "events in `t` order or throw" becomes "sorted by `order`; late inserts recompute from a checkpoint". |
| `type` | `type` | kinds renamed per 12.2 |
| `project_id`, `source_commit`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `runner_id`, `execution_id` | `ids.*` (`source_commit` server-only) | |
| — | `ids.cell_instance`, `visit_id`, `station`, `round`, `attempt`, `seat`, `agent_id`, `parent_agent_id`, `tool_call_id` | in M6.0 these were in `data` (`agent_id`, `call_id`, `station`, `round`, `seat`) |
| `source` (`intake`, `engineer`, `supervisor`) | `origin.writer`, plus `origin.stream` | `actors.ts` (`actorOfEvent`) reads `origin.writer` |
| `cause` (a seq; set only on simulation kinds) | `cause {event_id, basis}` | most simulation causes have no production equivalent (section 7) |
| `refs` (paths) | dropped from the browser; `entities[]` added | `engine.ts refsOf` is deleted; the index uses `entities` |
| `data` | `data` (allow-listed) | field changes per 12.2 |
| — | `authority`, `unknown`, `inferred`, `provenance`, `late`, `parent`, `artifacts` | the inspector's telemetry badge (`exists`/`derivable`/`missing`) becomes `authority` + `precision` |

### 12.2 Kinds

| M6.0 kind (fixture count) | v3 kind | `data` changes |
|---|---|---|
| 22 real kinds (75) | unchanged | `by` → `by_role`; `session_id`, `previous_*` dropped |
| `workflow.started` (5) | `workflow.started` | `args`, `phases`, `session_id` dropped; the phase list moves to `workflow.phases_declared` |
| `workflow.phase` (34) | none as moments; `workflow.phases_declared` once, and each agent's `phase` | not observable as a moment |
| `workflow.finished` (4) | `workflow.finished` | `status` from `task_updated`; `stations[]`, token and tool totals added; `learning` dropped |
| `station.entered` (26) | `station.entered` | `round` → `ids.round`; `reason`, `agent_type`, `model` dropped (not recorded by stations); `resumed`, `unclosed_visit`, `head`, `counts` added |
| `station.left` (25) | `station.exited` | `action`, `note` dropped; `duration_ms` added |
| `cell.stage_changed` (31) | `station.entered.data.stage`, `station.exited.data.stage` | the reducer sets the stage from these |
| `agent.started` (93) | `agent.started` (preceded by `agent.queued`) | `agent_id`, `seat`, `station` → `ids` (`station`, `seat` from the label); `parent_agent_id` dropped (workflow agents have no parent agent; their parent is the `workflow:`); `tier`, `effort` dropped (not recorded); `index`, `agent_try` added |
| `agent.finished` (92) | `agent.finished` | `outcome` → `status` (adds `unknown`); `summary` dropped (model text); `tokens`, `tool_calls`, `duration_ms` added; no cost |
| `tool.started` (690) | **not observable** for workflow agents (all 690 in the fixture); `agent.progressed.tool_calls` counts them | `tool.called` remains for the main loop and Agent-tool sub-agents |
| `tool.finished` (690) | **not observable** for workflow agents | `tool.returned` remains for the main loop and Agent-tool sub-agents |
| `artifact.written` (171) | `artifact.recorded` | `writer` is always unknown for workflow agents' work (their `Write` calls are not in the stream); `version` → `@sha` ref; `summary` dropped; `nature`, `integrity` added |
| `gate.checked` (8) | `gate.evaluated` (`audit.readiness`, `plan.check`) | `passed` → `verdict`; `tier` → `audit_tier` (on `build.start`); `score` dropped (open question 1) |
| `task.started` (26) | none | |
| `task.red` (13), `task.green` (12), `task.done` (1) | `build.task_completed` | `step`; `failing`/`passed` counts dropped (never recorded) |
| `test.result` (42) | `build.task_completed.first_run` and `suite` | exit codes, seconds and counts dropped (seconds stay in `build.json`) |
| `build.revised` (2) | `station.entered` with `action: revise` | `findings`, `rounds_left` derived by the client from `round` |
| `verification.started` (5) | `station.entered` (`station: verify`) and `verify.targets_listed` (reconstructed from `spec.json`) | |
| `evidence.captured` (35) | `verify.check_recorded` | `note` dropped; `evidence[]` gains `sha256` |
| `verification.verdict` (5) | `gate.evaluated` (`verify.verdict`), plus `station.exited` (verify) for `checks_passed`/`checks_failed` in `counts` | |
| `review.started` (4) | `review.round_started` | `diff_stat`, delta file lists, `human_approval_reasons` dropped; `delta` is a flag; `head` is on the visit's `station.entered` |
| `review.finding` (11) | `review.finding` (reconstructed) | id `finding:` unchanged |
| `review.vote` (12) | `review.verdict_submitted` | `head` dropped (on the visit) |
| `review.decided` (4) | `review.decided` | `findings` text and `overruled_blockers_from` dropped (the second follows from `votes` and `outcome`) |
| `human.approval_recorded` (1) | `human.approval_recorded` | `by`, `note` dropped; `note_given` added |
| `merge.revalidated` (3) | `merge.completed.revalidated`; a refused `merge.land` gate when revalidation fails | no separate record; "not needed" is `revalidated: false` |
| `merge.completed` (3), `cleanup.completed` (3) | same | |

### 12.3 Where the client changes

`sim/events.ts` (a `FactoryEventV3` type; keep v2 types for the fixture), `sim/catalog.ts` (telemetry class → authority and status; kept for the simulation), `sim/engine.ts` (`indexFixture` ordering, `refsOf` removed, re-key by id, checkpoints), `sim/reducer.ts` (cases per 12.2), `sim/model.ts` (`ENTITY_KINDS` gains `project`, `visit`, `seat`; `ref.visit`, `ref.seat`), `sim/selectors.ts` (`eventBySeq`, `refsOfEvent`, timing helpers read `time.precision`), `scene/store.ts` (`liveAt` from the watermark; `seek` clamps), `atlas/locate.ts` (the agent-id parse). The views' per-call drawing of workflow agents goes: the Atlas's tool ticker and the Blueprint's `ToolTrace` ticks (`blueprint/ticks.tsx`) and the timeline's tool marks become a count and a last-tool label per agent (section 8.1); they stay for main-loop calls. The simulation fixture stays v2 + `t` and keeps working; a small adapter turns it into v3 so one engine serves both (assessment, section 5).

---

## 13. What a v2 reader sees

**Nothing changes on disk for it.** No byte is added to `.factory/intake/events.jsonl` by M6.1; `intake.EVENT_TYPES` and `intake.EVENT_VERSION` stay as they are; `docs/mach-next/schemas/factory-event.schema.json` is not edited (the v3 schema is a new file).

Every reader of the v2 log or its schema, found by searching the repository for `events.jsonl`, `events_path`, `.events(`, `schema_version`, `EVENT_TYPES` and `EVENT_VERSION` (Python, Go, TypeScript, JavaScript, shell, `bin/mach`):

| Reader | What it reads | How it checks the version | Affected by M6.1? |
|---|---|---|---|
| `intake.Factory.save` (`skills/run/scripts/intake.py`) | every line, for the largest `seq` | does not check; skips unparsable lines | no |
| `intake.Factory.events(since)` | every line with `seq > since` | does not check; returns each dict as written | no |
| `run.py` `product events --since N` | `Factory.events` | reports `schema_version: intake.EVENT_VERSION` (2) once at the top; no per-event check | no |
| `intake.Factory.reconcile` (`last_event`) | the ledger's `next_seq`, not the file | n/a | no |
| `supervisor.py`, `executor.py`, `activation.py`, `policy.py`, `service.py`, `workflows/belt.js`, `bin/mach`, `apps/studio` (Go), Product Studio (web) | do not read the log | n/a | no |
| `tests/test_mach_product_intake.py` (`EVENT_KEYS`, `events()` helper, lines 885–909) | the log through `product events`, and the v2 schema file | asserts `schema_version == 2` per event, `type in EVENT_TYPES`, the schema's `const` and enum | no |
| `tests/test_mach_factory_supervisor.py` (lines 1060–1081, 542) | the log and the v2 schema file | asserts the envelope keys, `schema_version == 2`, the schema's `const: 2` and enum | no |
| `tests/test_mach_product_contracts.py` `test_schema_files_parse` | every file in `schemas/` | asserts each parses and declares draft 2020-12 | the new v3 file is checked too; it passes (run on this branch) |
| `web/apps/control-tower/test/purity.test.mjs`, `scenario.test.mjs` | `intake.py` source (`EVENT_TYPES`) and the fixture | `REAL_KINDS == EVENT_TYPES`; fixture `schema_version == 2` | no |

Consequence worth stating: **no production reader validates `schema_version` per event.** That is why the v2 log must never receive a v3 line: `Factory.events` would pass it through silently, and `save` would trust its `seq`. A test for M6.1 should assert that nothing but `intake.Factory` writes the file (a source scan, like `boundary_test.go`).

---

## 14. Version negotiation and transport

Served by the observer (`apps/observer`), loopback only, with M5's security layer as `apps/observer/internal/security` carries it (`127.0.0.1`, one-time token to an `HttpOnly`, `SameSite=Strict` cookie, `Host` and `Origin` checks, the M5 CSP), and M5's envelope (`{ok, data}` / `{ok: false, error{kind, message}}`). Routes are the observer design's `/api/v1/...` (`M6_1_OBSERVER_DESIGN.md` section 12); this section fixes what they must carry.

- **Discovery.** `GET /api/v1/session` carries `versions.event = {schema: 3, revision: <n>, kinds: [...]}`, `display_policy = {people: "role"}` (D15; the only value in M6.1), and `capabilities.stream_observations = {ok, claude_code_version, reason}` (false for a Claude Code version the parser does not know, with the reason).
- **Request.** A client names the schema it reads: `X-MACH-Event-Schema: 3` on fetches, `?schema=3` on `/api/v1/stream` (an `EventSource` cannot set headers). An unsupported major version gets `error.kind: "invalid"` with the supported list. The host never down-converts to v2 for a browser; v2 remains the CLI's (`run.py product events`).
- **History.** `GET /api/v1/events?after=<epoch>.<pos>&limit=<n>` returns events in `pos` order with `{generation, next, head, floor, more}` (the observer's `generation` is this contract's epoch) and the watermark. `GET /api/v1/history?from_order=&to_order=&entities=` returns a window in `order` order, for replay and the Timeline. `GET /api/v1/snapshot?at=<cursor>` is the projection snapshot (shared contracts 2.7).
- **Live.** `GET /api/v1/stream` (server-sent events): `hello` first; one message per event with `id: <epoch>.<pos>`, written in chunks of up to 256 while catching up, so the browser applies a batch per animation frame (M6.0 architecture 7.2); `heartbeat` carrying `head` and the watermark; `reset` (unknown or old epoch: reload); `gap` (the cursor fell below the floor). `Last-Event-ID` resumes. Each source's state (`live`, `idle`, `stale`, `ended`, `unreadable`) is served by `/api/v1/health` and `/api/v1/factory/status`, not as events (section 8).
- **Within version 3**, a revision may add kinds, add optional `data` fields, or add `ids` keys (as nullable). Clients ignore what they do not know; an unknown kind is kept in the index, shown in the inspector as "an event this version does not understand", and not reduced. Removing or renaming anything, or changing a meaning, is version 4, served beside 3 for one MACH release.

---

## 15. Assumptions

- **[A1]** A cell without a lifecycle log can be identified by its `cell.json created_at`. True for cells opened by `cell.py` and `intake.open_cell` (both write it); unverified for hand-made cells.
- **[A2]** A ticket's cell is re-created after cleanup rarely enough that a `~k` suffix on the second and later incarnations is acceptable to the views.
- **[A3]** Worker labels keep `belt.js`'s form (`"<ticket>: <worker>"`, `"<ticket>: <seat> reviewer"`), as the proof saw them. If `belt.js` changes its labels, the label-derived `ids` become `unknown`, not wrong: the normaliser matches the known forms exactly and nothing else.
- **[A4]** Losing the observer index is rare and acceptable: ids and order rebuild identically; only arrival times of stream records without their own time degrade to bounded.
- **[A5]** Lifecycle v1 records carry no `cause`.
- **[A6]** All writers run on one machine with one wall clock (M4 section 5); no cross-machine skew handling is designed.
- **[A7]** One observer serves one project folder. Multi-project views qualify ids with `project_id`.
- **[A8]** The settle window of 1.5 s is a starting value, to be measured against real lifecycle and stream write patterns (the proof measured stream arrival at median 39 ms, p95 65 ms).
- **[A9]** The stream mapping is proven for Claude Code 2.1.322 only. A record meaning the same thing in another version is not assumed (one field already means two things by task type: `last_tool_name` is a label for workflows and a tool for Agent sub-agents).

## 16. Decisions taken, and what is still open

The lead's decisions on the earlier open questions, all reflected above:

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Contract or observer skeleton | The contract wins | section 17 |
| 2 | Lifecycle `attempt` | Renamed `round` on disk; v3 `round` = judging round, `attempt` = execution attempt only | 4, 10.2 |
| 3 | Verification targets | Recomputed by the observer from `spec.json` (reconstructed) | `verify.targets_listed`, 10.6 |
| 4 | People's names | Never sent in M6.1; "a person"; `display_policy` reserved | D15, 14 |
| 5 | Filling v2 `cause` | Out of scope; no v2 writer changes | D2, 7 |
| 6 | Capacity waits | From the recorded scheduler decision only, rule named; else `unknown` | D16, `capacity.wait_changed` |
| 7 | Stream timing sidecar | None; live arrival stamps; after the fact, `bounded` from the record times the stream carries | 6.1 |
| 8 | Five sources | Accepted | D3 |
| 9 | Lifecycle authority | Authoritative; station files win; disagreement surfaced as `history.gap` | 7, 6.5 |
| 10 | No per-event `schema_version` check in v2 readers | Recorded as a risk | assessment, section 4 |

Still open:

1. **Audit score.** `build.start` carries `audit_tier`; the score is only in `.factory/audit-report.json`. Wanted in `gate.evaluated`? (Not blocking.)
2. **Session ids** are kept server-only. Does the inspector need them (for example to offer `claude --resume`)? (Not blocking.)
3. **Holdout targets.** `verify.targets_listed` lists holdout checks by id from `.factory/holdouts/<ticket>/`. Holdouts are meant to stay unseen by the builder; the Control Tower is not the builder, but confirm that showing their ids (never their content) is acceptable.
4. **Budget stop attribution** reads `stderr.log` for Claude Code's "Budget limit reached" line. That is a second, unstructured source for one field; acceptable, or should `stop_reason` stay `unknown` whenever no result says `error_max_budget_usd`?
5. **Spend that may be missing** when a budget stop kills agents in flight (the proof saw fewer cache-write tokens reported than the agents' transcripts held, once). Analytics shows recorded cost; should it also flag executions that ended `killed` as "cost may be under-reported"?

## 17. Changes the observer must make (`apps/observer`, uncommitted)

The lead decided the contract wins over the observer skeleton. Read at the time of writing, the observer must change as follows (file references are to `apps/observer/internal/`):

| # | Where | Today | Change to |
|---|---|---|---|
| 1 | `event/event.go` `Authoritative`/`Observed`/`Reconstructed` | `observed` = "the observer saw something by looking (a file vanished, a sequence gap)"; `reconstructed` = "an execution stream read back, an archive member" | `authoritative` for intake log, lifecycle (live **and** archived), execution records, run record; `observed` for every stream event and v2 `station.observed`; `reconstructed` only for observer-derived events, with `provenance`. Gaps and vanished files are `history.gap` events, not an authority |
| 2 | `event.ID` | `e` + 24 hex of SHA-256(key, epoch, offset, kind) | the readable ids of section 5.1 (`i:`, `c:`, `x:`, `r:`, `s:`, `o:`), line-based; keep the byte offset internally for resuming |
| 3 | `event.Source` | `kind` ∈ `ledger`, `cell`, `execution`, `observer`; `key`, `epoch`, `seq`, `offset` on the wire | `origin {stream, key, seq, part, writer, script, source_version}` with the six streams of section 2; `offset` off the wire |
| 4 | `event.Event` time fields | `occurred_at`, `occurred_precision` ∈ `ms`, `second`, `observed`, `unknown`; `live` | `time {occurred_at, precision ∈ ms, s, arrival, bounded, unknown, not_before, not_after, observed_at, order_ms}`; drop `live` from the wire (it depends on when the observer ran, so it does not rebuild deterministically) |
| 5 | `event.Event` | no history order | add `order` (section 6.3), the 1.5 s settle window and `late` (6.5); keep `Cursor` (`generation.position` = `epoch.pos`) |
| 6 | `event.Subject` | `project_id … runner_id, station, visit, attempt, actor` | `ids` with every key of section 4, all present and nullable: `cell_instance`, `visit_id` as `<ticket>/<visit>`, `round` (from lifecycle `round`, or `attempt` in older files), `attempt` (v2 only), `seat`, `agent_id`, `parent_agent_id`, `tool_call_id`; `actor` moves to `origin.writer` |
| 7 | `event.Event` | — | add `schema_version`, `schema_revision`, `entities`, `parent`, `cause`, `artifacts`, `unknown`, `inferred`, `provenance` (keep `withheld`, adopted by the contract) |
| 8 | `normalize/ledger.go` `ledgerData` | per-kind projections; `claude_error_present`; unknown types become `LedgerUnknownType` events | the schema's `$defs` allow-lists exactly: `by` → `by_role`, `claude_error` as its subtype token, `session_id` withheld; a v2 line of unknown type becomes `history.gap` with `reason: unknown-type` |
| 9 | `normalize/lifecycle.go` | `Subject.Attempt` from the record | line-based ids and `cell_instance` (5.1); `round`; the data mapping of 10.2 (`verdict`, `subject`, `status`, `counts`, `task_id`, `target_id`, `panel`, …); the `state-mismatch` check (6.5) |
| 10 | `normalize/stream.go` | no handlers registered (deny all), every observation stamped `observed` precision | register handlers for exactly the records of 10.5; diff `workflow_progress[]` snapshots by `index`; use the records' own times (`timestamp`, `startedAt`, `durationMs`, `end_time`) as `ms`; never read `last_tool_name` of a workflow task as a tool, nor `result.subtype` as workflow completion; heartbeats produce no event |
| 11 | sources | ledger, cells, executions | add `started.json`/`result.json` (`execution.process_*`) and `.factory/archive/runs.jsonl` (`run.recorded`) |
| 12 | observer-derived events | `observer.reconciled` (observed) in the design (`M6_1_OBSERVER_DESIGN.md` section 10) | `history.gap` with `reason: state-mismatch` (`reconstructed`); plus `review.finding`, `artifact.recorded`, `verify.targets_listed`, `capacity.wait_changed`, `history.began`, and the `o:close:` closings of section 8 |
| 13 | `server` `/api/v1/session` | `versions {observer, api, event}`, `capabilities {execution, artifacts, snapshot}` | add `versions.event = {schema: 3, revision, kinds}`, `display_policy`, `capabilities.stream_observations` (section 14); accept `X-MACH-Event-Schema` / `?schema=3` |
| 14 | `server` stream | `hello`, per-event messages, `heartbeat {head, at}`, `gap`, `reset` | as is, plus the watermark on `heartbeat` (6.6) |
| 15 | design routes `/runs/{x}/agents`, `/tools` | per-agent `cost_usd`; a tool list for every agent | no per-agent cost (tokens only); `/tools` lists main-loop and Agent-tool calls only; workflow agents' calls appear as `tool_calls` counts |
| 16 | `redact` and the stream never-forward list | — | section 9.1's list, including `task_started.prompt`, `promptPreview`, `resultPreview`, `lastToolSummary`, `permission_denials[].tool_input`, and every absolute path field the proof found |

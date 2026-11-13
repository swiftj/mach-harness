# MACH Next — M6.1: what a real execution stream contains (stream compatibility, version 1)

Gate: the first technical gate of M6.1. Question: when the Factory runs a MACH Dynamic Workflow, what does the
`stream.jsonl` it records actually contain, and what can a live observer rely on? Everything here was **observed** in
real runs unless it says *inference* or *docs*. One machine, one runtime version, six runs: treat every "observed" as
"observed once on this version", not as a guarantee.

| | |
|---|---|
| Document version | 1 |
| Claude Code | **2.1.322** (`system/init.claude_code_version`) |
| Date | 2026-11-12 |
| Machine | macOS (Darwin 27.2.0), Apple silicon; the person's own Claude Code login (`apiKeySource: "none"`) |
| Main-loop model | the person's default, `claude-opus-5-5` (the executor passes no `--model`); workflow agents chose their own |
| MACH | worktree `feature/mach-next-m6-1-live-observability` at `cac989e`, script-installed into a scratch project (`bin/mach install --no-studio`) |
| Total spend | **$2.30** reported by `total_cost_usd` across the six runs (table in section 1) |
| Raw streams | kept only in the scratch area; never in Git. Sanitized fixtures: `tests/fixtures/execution-streams/` |

---

## 1. What was run

A throwaway Git repository (one `app/` package, one passing `unittest`), MACH installed by script, one local ticket
`LOCAL-001` prepared to `planned` the way `tests/test_build.py` does (`cell.py open`, the fixture spec
`SLICE-001-invite-teammate.md`, `finalize`, the five-task plan, `check-plan`), and a real `audit.py run` (Silver).

Every run was launched **through MACH's own code**: `executor.plugin()` generated the plugin at
`.factory/local/claude-plugin/`, `executor.command()` built the argv (runs 1, 2, 4, 5, 6; runs 3 used
`executor.boundary_flags()` with its own prompt), `executor.prepare()` wrote `spec.json`, and `executor.launch()`
started the detached wrapper (`run.py factory exec <id>`), which wrote `stream.jsonl`, `stderr.log`, `started.json`
and `result.json` exactly as for a supervisor execution. Only the ledger claim and the `execution.*` events were
skipped (no `factory enable`, no product wave). The tool list was `policy.default_tools()`. An observer read
`stream.jsonl` by byte offset every 50 ms and stamped each complete line on arrival.

The command line (paths shortened; `<plugin>` = `<project>/.factory/local/claude-plugin`):

```
claude -p 'Run the workflow named mach:belt with args {"tickets": ["LOCAL-001"], "until": "merge"}. Use the Workflow tool. When it has finished, reply with only the JSON it returned. If you are refused, say so and stop.'
  --output-format stream-json --verbose
  --restricted --strict-mcp-config --plugin-dir <plugin>
  --permission-mode default --permission-prompts none
  --tools Workflow,Skill,Agent,Read,Write,Edit,Glob,Grep,Bash
  --disallowedTools Edit(/<plugin>/**) Edit(/<project>/.factory/local/**) Edit(/<project>/.claude/**)
  --max-budget-usd 8.0 --session-id <new uuid>
  --allowedTools Workflow Skill Agent Read Write Edit Glob Grep 'Bash(python3 *)' 'Bash(git status *)' 'Bash(git log *)' 'Bash(git diff *)' 'Bash(git show *)' 'Bash(<python3.14> *)'
```

Environment: `executor.environment()` (no key or token), as the wrapper always does.

| # | Execution | Workflow / prompt | Budget | Exit | Seconds | Result | `total_cost_usd` |
|---|---|---|---|---|---|---|---|
| 1 | `x…01` | `mach:probe`: 3 parallel labelled, phased Haiku agents (Glob/Grep/Read/Bash), then 1 with a schema | 2.00 | 0 | 13 | `success` | 0.172 |
| 2 | `x…02` | **`mach:belt` `{tickets:[LOCAL-001], until:"merge"}`** from `planned` | 8.00 | 0 | 454 | `success`; ticket built, verified, reviewed (rejected), revised, verified, reviewed (approved), stopped at `awaiting-human` (Silver tier) | 1.820 |
| 3 | `x…03` | contrast: plain prompt, two **Agent** tool sub-agents in parallel, `--model haiku` | 0.60 | 0 | 8 | `success` | 0.008 |
| 4 | `x…04` | `mach:probe` with `Workflow` removed from the tool list | 0.50 | 0 | 7 | `success` (no workflow ran) | 0.078 |
| 5 | `x…05` | `mach:probe`, budget below the first turn | 0.03 | **1** | 2 | `error_max_budget_usd` | 0.055 |
| 6 | `x…06` | `mach:probe-spend` (same probe, Opus agents), budget crossed mid-workflow | 0.15 | 0 | 7 | `success` (workflow killed) | 0.166 |

`mach:probe` and `mach:probe-spend` were scratch workflows placed in the scratch project's `.claude/workflows/`, so the
generated plugin carried them like the belt. All processes ended; none was left running.

---

## 2. Answers

Legend: **Observed** = seen in the parent `stream.jsonl`. **Partly** = seen, with a stated limit. **Not observed** =
looked for and absent. "Docs" = the official Claude Code / Agent SDK pages, used only as a secondary source.

| Question | Answer | Where |
|---|---|---|
| Workflow lifecycle events | **Observed.** `assistant` `tool_use name:"Workflow"` → `system/background_tasks_changed` → `system/task_started` (`task_type:"local_workflow"`, `workflow_name`) → `user` `tool_result` (`tool_use_result.status:"async_launched"`) → many `system/task_progress` → `system/task_updated` (`patch.status`, `patch.end_time`) → `system/task_notification` (`status`, `usage`) → `background_tasks_changed` (empty) → second `system/init` → `assistant` text → **two `result` records** | 3.1 |
| Are workflow sub-agents observable in the parent stream? | **Partly.** Not as messages: no `assistant`/`user` record of any workflow agent, `parent_tool_use_id` never non-null (0 of 327 records in the belt run). They are visible as **snapshots** in `task_progress.workflow_progress[]` (one entry per agent, cumulative) and as a per-tool-call heartbeat (`task_progress` without the array). Their individual tool calls are not in the stream. | 3.2 |
| Stable agent identity | **Observed.** `workflow_progress[].agentId` (`a` + 16 hex), present once the agent has started (absent while queued); the same ID is the sub-agent's transcript file name and appears on its `permission_denied`. `index` is stable within one workflow run and present from queueing. | 3.2 |
| Parent-child relationships | **Partly.** Agent → workflow: by containment (the snapshot belongs to `task_id`/`tool_use_id` of the Workflow call). Workflow → main loop: `tool_use_id`. Agent → agent: **none**; workflow agents had no Agent tool (run 1: "no Agent tool is available"; the sub-agent's request listed `Bash, Edit, Glob, Grep, Read, Skill, Write`), so depth is 1 (`meta.json` `spawnDepth: 1` for all 29 belt agents). | 3.2 |
| Labels and phases | **Observed.** `label`, `phaseIndex`, `phaseTitle` per agent; `workflow_phase` entries with `index`, `title` (all phases of `meta.phases`, listed from the first snapshot, not as `phase()` is called). `task_progress.description` = `"<phaseTitle>: <label>"`. **`log()` is not in the stream** (it is in the workflow's run record on disk, 3.6). | 3.2 |
| Tool invocation ↔ result correlation | **Observed for the main loop only**: `tool_use.id` = `tool_result.tool_use_id` (`toolu_…`). For workflow agents: **not observed** (no tool_use/tool_result); only `toolCalls` (count), `lastToolName`, `lastToolSummary` in snapshots, and `permission_denied.tool_use_id` + `agent_id` for refused calls. Agent-tool sub-agents (run 3) are fully correlated. | 3.3 |
| Timestamps | **Partly.** `assistant`/`user` records carry `timestamp` (ISO 8601, ms). `system` records carry none, except: `workflow_progress[]` `queuedAt`, `startedAt`, `lastProgressAt` (Unix ms) and `durationMs`; `task_updated.patch.end_time` (Unix ms); `usage.duration_ms` (since the workflow started). `result` has durations, no wall time. Every other record must be stamped on arrival. | 3.4 |
| Token usage and cost | **Per execution: observed** (`result.total_cost_usd`, `usage`). **Per model: observed** (`result.modelUsage[model].costUSD` and token kinds; workflow agents included: the belt run lists Opus $0.093, Haiku $0.024, Sonnet $1.703). **Per agent: tokens only** (`workflow_progress[].tokens`, one total, no input/output split, no cost); the per-agent tokens sum exactly to the workflow's `total_tokens` (486,158 = 486,158). Per-agent cost: **not observed** (derivable only by pricing the on-disk transcript, 3.6). | 3.5 |
| Parallel agents distinguishable | **Observed.** Snapshots key each agent by `agentId` and `index`; heartbeats name the agent by `description` (label). The three reviewer seats interleaved record by record (architecture, product, architecture, security, …) and stayed distinguishable because their labels differ. Two concurrent agents with the same label would be distinguishable in snapshots, **not** in heartbeats. | 3.2 |
| Partial lines | **Not observed.** 0 partial reads in 395 lines polled every 50 ms; every read ended on a newline. A reader must still tolerate one (inference: nothing guarantees whole-line writes). | 3.7 |
| Flush latency | **Observed: written as it happens.** Line arrival minus the line's own time: median 39 ms, p95 65 ms, max 77 ms over 72 timed belt lines (polling floor 50 ms). Lines spread over 292 distinct reads in 454 s. **Exception:** the first turn's `result` is held back and written at the very end, next to the second. | 3.7 |
| Ordering | **Partly.** Lines are in emission order. Cumulative counters (`usage.tool_uses`, `total_tokens`) never decreased. `result` records are **not** in turn order of emission (see above). | 3.7 |
| Final result record | **Observed: two of them** in every successful workflow run. `result_index: 0` (first turn; its `result` text is the "running in the background" sentence; carries **all** `permission_denials`) and `result_index: 1` (`origin.kind:"task-notification"`; carries the workflow JSON as `result`; `permission_denials: []`). Both carry the same cumulative `total_cost_usd` and `modelUsage`. | 3.8 |
| Error / budget / refusal | **Observed.** Refusal: `system/permission_denied` with `agent_id` + `tool_use_id` (20 in the belt run), all repeated in `result_index:0.permission_denials`. Budget below the first turn: `error_max_budget_usd`, `terminal_reason:"budget_exhausted"`, `errors:[…]`, workflow `killed`, exit 1. **Budget crossed mid-workflow: workflow `killed`, agents `state:"error"`, but the only result is `success` and exit 0**; the budget message is only on stderr. Missing Workflow tool: no refusal at all, `success`. | 3.9 |

---

## 3. Detail, with sanitized record shapes

Shapes below come from the sanitized fixtures: keys and types are real; values are placeholders (`string`,
`number`), fakes (`toolu_FAKE…`, `task0001`) or kept enumerations. Every shape was seen in run 2 unless named.

### 3.1 Workflow lifecycle

```jsonc
// 1  the main loop calls the Workflow tool
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_FAKE000001","role":"assistant",
  "content":[{"type":"tool_use","id":"toolu_FAKE000001","name":"Workflow","input":{"name":string,"args":{…}},"caller":{…}}],
  "usage":{…}},"parent_tool_use_id":null,"session_id":uuid,"uuid":uuid,"timestamp":"…Z","request_id":"req_FAKE…",
  "wire_tool_inputs":{"toolu_FAKE000001":{"name":string,"args":string}}}
// 2  {"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id","run_id","task_type":"local_workflow","description"}],…}
// 3
{"type":"system","subtype":"task_started","task_id":"task0001","run_id":"run0001","tool_use_id":"toolu_FAKE000001",
 "description":string,"task_type":"local_workflow","workflow_name":"belt","prompt":string /* the whole script source */,"uuid":uuid,"session_id":uuid}
// 4  the Workflow call returns at once: the workflow runs in the background
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_FAKE000001","content":string,"is_error":bool}]},
 "timestamp":"…Z","tool_use_result":{"status":"async_launched","taskId":"task0001","taskType":"local_workflow","workflowName":"belt",
 "runId":"wf_00000001","summary":string,"transcriptDir":string /* absolute path */,"scriptPath":string},"tool_result_meta":[…]}
// 5  task_progress, many (3.2)
// 6
{"type":"system","subtype":"task_updated","task_id":"task0001","run_id":"run0001","patch":{"status":"completed","end_time":number}}
// 7
{"type":"system","subtype":"task_notification","task_id":"task0001","run_id":"run0001","tool_use_id":"toolu_FAKE000001",
 "status":"completed","output_file":string,"summary":string,"usage":{"total_tokens":number,"tool_uses":number,"duration_ms":number}}
// 8  background_tasks_changed with "tasks": []
// 9  a second {"type":"system","subtype":"init",…}: the main loop's second turn, started by the notification
// 10 assistant text (the workflow's JSON), then result_index 0, then result_index 1 (3.8)
```

Identities: `task_id` (9 lower-case characters, e.g. `w0b7uvroa`) is the background task; `run_id` (`<x>-<y>`) is the
task's run; `tool_use_result.runId` (`wf_…`) is the **workflow run** and names its folder on disk (3.6). They are
different values. Each record also has its own `uuid`, and `session_id` equals the `--session-id` passed.

What a normalizer may rely on (this version): a workflow **started** when `task_started` with
`task_type:"local_workflow"` arrives (or `tool_use_result.status:"async_launched"`); it **ended** at
`task_updated.patch.end_time`, with `patch.status` `completed` or `killed`, and `task_notification.status`
`completed` or `stopped`. The second `init` is not a new session (same `session_id`).

### 3.2 Workflow agents: snapshots and heartbeats

Two kinds of `task_progress` share the Workflow call's `task_id`/`tool_use_id`:

```jsonc
// heartbeat (226 of 293 in the belt run): no agent ID, no tool name
{"type":"system","subtype":"task_progress","task_id":"task0001","run_id":"run0001","tool_use_id":"toolu_FAKE000001",
 "description":"Review: TICKET-1: security reviewer",            // "<phaseTitle>: <label>" of the agent that just moved
 "usage":{"total_tokens":number,"tool_uses":number,"duration_ms":number},  // the WHOLE workflow, cumulative
 "last_tool_name":"TICKET-1: security reviewer",                  // the label again, NOT a tool name
 "summary":string,"uuid":uuid,"session_id":uuid}

// snapshot (67 of 293): the same, plus the state of every phase and agent so far
"workflow_progress":[
  {"type":"workflow_phase","index":1,"title":"Preflight"}, … (all seven belt phases, from the first snapshot),
  {"type":"workflow_agent","index":15,"label":"TICKET-1: security reviewer","phaseIndex":5,"phaseTitle":"Review",
   "agentId":"a000…05","agentType":"mach:reviewer","model":"claude-sonnet-5-5","state":"done",
   "queuedAt":number,"startedAt":number,"lastProgressAt":number,"durationMs":number,"attempt":1,
   "tokens":number,"toolCalls":number,"lastToolName":"Bash","lastToolSummary":string,
   "promptPreview":string,"resultPreview":string,"promptFramed":true}]
```

- `state` seen: `start`, `progress`, `done`; and `error` (run 6, with `error: "Stopped because the workflow was stopped"` and `endedWithRun`). No other value was seen.
- Before an agent starts: no `agentId`, no `startedAt`, and `model` is the alias asked for (`haiku`); after, the full model ID.
- `agentType` is present only when the workflow passed one (`mach:builder`, `mach:verifier`, `mach:reviewer`); clerks have none.
- Snapshot timing: one is written when an agent starts and when it finishes (finish reported 3–61 ms after `startedAt + durationMs`, two at ~1.1 s), and otherwise every few seconds (median gap 6 s, longest 21.5 s). Heartbeats: median gap 1.2 s, longest 12 s.
- A heartbeat's `usage.tool_uses` rose by 1 in 160 of 245 cases, by 0 in 83 (a token update) and by 2 in 2. So **a heartbeat is roughly one tool call by the named agent, but not exactly**, and it never says which tool.
- `index` order is queue order. In the belt the clerks (`what next?`) all have `phaseTitle: "Preflight"`, whatever station they serve: the phase is what the script passed, not the station.
- The run counted 29 agents, the belt's `stations` list read `build, build, build, verify, review, revise, verify, review`: the builder needed three agents to finish five tasks.

What a normalizer may rely on: `agentId` as the agent's identity for one execution; `index` as its order;
`label`/`phaseTitle` as given by the script; `state` transitions from successive snapshots; `startedAt` and
`startedAt + durationMs` as fact times; `tokens`, `toolCalls` as cumulative per agent. It must **diff snapshots**
(each one restates everything) and must not read `last_tool_name` as a tool.

### 3.3 Tool calls

- **Main loop:** `assistant.message.content[].tool_use {id, name, input}` ↔ `user.message.content[].tool_result {tool_use_id, is_error}`; the `user` record also has `tool_use_result` (structured) and `tool_result_meta[].permission_decision`. Exact correlation by `toolu_` ID. In the belt run the main loop made exactly one tool call (Workflow).
- **Workflow agents:** no tool_use or tool_result in the stream. Available: `toolCalls` (count), `lastToolName` (e.g. `Bash`, `Read`, `Write`, `Grep`, `StructuredOutput`), `lastToolSummary` (a ~60-character prefix of the command or path: **private**), the heartbeat, and refusals:

```jsonc
{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_FAKE000002","agent_id":"a000…05",
 "decision_reason_type":"asyncAgent","decision_reason":string,"message":string,"uuid":uuid,"session_id":uuid}
```

  The `tool_use_id` of a refusal refers to a call that never appears in the stream, so it cannot be joined to a `tool_use`; it joins to the agent by `agent_id` = `agentId`. Every refusal is repeated, with its `tool_input` (**private**: full command), in `result_index:0.permission_denials`.
- **Agent-tool sub-agents** (run 3, for contrast; the belt does not use them): fully streamed, as the docs describe. `task_started` has `task_type:"local_agent"`, `subagent_type`, `spawn_depth`, and its `task_id` **equals** the sub-agent's `agent_id`; each sub-agent message carries `parent_tool_use_id` (the Agent call) and `agent_id`; its `tool_use`/`tool_result` pairs correlate by ID; `task_progress.last_tool_name` there **is** a tool name. So the same record type means different things for `local_agent` and `local_workflow` tasks.

### 3.4 Time

| Record | Own time |
|---|---|
| `assistant`, `user` | `timestamp`, ISO 8601 with ms (docs: when generation finished, for `assistant`) |
| `system/task_progress` snapshot | `queuedAt`, `startedAt`, `lastProgressAt` (Unix ms), `durationMs` per agent |
| `system/task_progress` heartbeat, `task_started`, `task_notification`, `permission_denied`, `background_tasks_changed`, `init`, `rate_limit_event` | **none** (only `usage.duration_ms`, relative to the workflow's start, on progress and notification) |
| `system/task_updated` | `patch.end_time` (Unix ms) |
| `result` | `duration_ms`, `duration_api_ms`, `ttft_ms` and others; no wall time |

The run's own records: `started.json.started_at` and `result.json.ended_at` (the wrapper, whole seconds).

A normalizer may rely on the snapshot and `end_time` times as **fact times** (same machine clock), and must stamp
everything else on arrival (`observed_at`); 3.7 shows arrival is within ~0.1 s of the fact when tailed live. A stream
read after the fact has wall times only for the records in the first three rows.

### 3.5 Usage and cost

- Per execution: `result.total_cost_usd` (cumulative; identical on both results), `result.usage` (the main loop's turn only), `num_turns`, `duration_ms` (that turn only: 3,258 ms and 2,181 ms in the belt run, not the 454 s it took).
- Per model: `result.modelUsage[<model>]` `{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, cacheCreationEphemeral5mInputTokens, cacheCreationEphemeral1hInputTokens, thinkingTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, canonicalModel, provider, costBasis}`; and `model_usage_since_last_result` (same shape, since the previous result). Workflow agents are included.
- Per workflow: `task_notification.usage` and the last heartbeat (`total_tokens`, `tool_uses`, `duration_ms`).
- Per agent: `workflow_progress[].tokens` (one number) and `toolCalls`. No cost, no token kinds. The agent's model is known (`model`), so a cost could be **estimated**, never read.
- `result.subagent_stats` counts **Agent-tool** sub-agents only: `spawned: 0` in the belt run, which had 29 workflow agents. Do not use it for workflows.
- Run 6: when the budget stopped the workflow, `modelUsage` held fewer cache-write tokens (16,873) than the killed agents' own transcripts (22,383): the spend of requests in flight when agents are killed may be missing from the reported total (one observation).

### 3.6 Other sources on disk for the same session

All written by Claude Code itself, outside the project, for the `--session-id` the executor sets. `<enc>` is the
working folder with every non-alphanumeric character replaced by `-`.

| Path | Contents | Status |
|---|---|---|
| `~/.claude/projects/<enc>/<session>.jsonl` | the main loop's transcript (`user`, `assistant`, `attachment`, `queue-operation`, `cost-state`, `api-request*`, …), with `accountUuid` and `organizationUuid` | **Path documented** (docs: sessions); **format documented as internal and subject to change** |
| `~/.claude/projects/<enc>/<session>/subagents/workflows/<wf_runId>/agent-<agentId>.jsonl` | each workflow agent's full transcript: every `tool_use`/`tool_result` with `toolu_` IDs, a `timestamp` on each message, per-message `usage` and `model`, `isSidechain: true`, `agentId` | **Undocumented**; the richest source; internal |
| `…/agent-<agentId>.meta.json` | `{agentType, isBuiltIn, description /* label */, workflowPhase, spawnDepth, requestShape, requestNonInteractive, model, pickedEffortModel}` | Undocumented, internal |
| `…/<wf_runId>/journal.jsonl` | `launched`, then `started {key, agentId, label, phase}` and `result {key, agentId, result /* full text */, toolsUsed}` per agent (the Workflow tool's resume journal) | Mentioned to authors in the Workflow tool's own instructions ("inspect journal.jsonl"); not a documented interface |
| `~/.claude/projects/<enc>/<session>/workflows/<wf_runId>.json` | the run record: `status`, `startTime`, `durationMs`, `agentCount`, `totalTokens`, `totalToolCalls`, `phases`, `workflowProgress`, **`logs` (the `log()` lines)**, `result`, `args`, `script` | Undocumented, internal |
| `~/.claude/projects/<enc>/<session>/workflows/scripts/<name>-<wf_runId>.js` | a copy of the script | Undocumented |
| `$TMPDIR/claude-<uid>/<enc>/<session>/tasks/<task_id>.output` | the task's output (`task_notification.output_file`): summary, `agentCount`, `logs`, `result` | Undocumented; under the temporary folder |

The workflow run folder is announced in the stream (`tool_use_result.transcriptDir`, `scriptPath`), so a reader need
not guess it. Size: the six runs left 8.4 MB under `~/.claude/projects/<enc>/` against 1.4 MB of `stream.jsonl`.
These files hold full prompts, file contents, commands and account IDs: they are local-only, like the stream.
**Inference:** because they are internal, depending on them needs a version pin and a parser that fails closed.

### 3.7 Delivery: flushing, partial lines, ordering

Measured by the 50 ms byte-offset tailer (arrival minus the record's own time, where it has one):

| Run | Lines | Partial reads | Distinct reads | Max lines per read | Lag median / p95 / max (ms) |
|---|---|---|---|---|---|
| 1 probe | 31 | 0 | 19 | 5 | 37 / 59 / 71 |
| 2 belt | 327 | 0 | 292 | 5 | 39 / 65 / 77 |
| 3 contrast | 23 | 0 | 10 | 4 | 40 / 50 / 53 |

Lag includes up to 50 ms of polling, so the writer flushes within tens of milliseconds. The file grows during the
run; it is not written at the end. Docs say only that `stream-json` is for real-time streaming and that a slow
consumer can make Claude Code wait up to 30 s; the wrapper writes to a file, so that does not apply here.

The two `result` records arrive together at the end (run 1: same read; run 2: records 326 and 327, after the second
turn's text). Inference: the first turn's result is withheld while a background task runs.

### 3.8 The final result records

```jsonc
// result_index 0: the first turn
{"type":"result","subtype":"success","is_error":false,"result_index":0,"result":string /* "running in the background" */,
 "total_cost_usd":number,"usage":{…},"modelUsage":{"claude-opus-5-5":{…},"claude-haiku-5-5":{…},"claude-sonnet-5-5":{…}},
 "model_usage_since_last_result":{…},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_FAKE…","tool_input":{"command":string}}],
 "num_turns":number,"duration_ms":number,"duration_api_ms":number,"ttft_ms":number,"terminal_reason":"completed","stop_reason":"end_turn",
 "subagent_stats":{…},"safety_stops":number,"api_error_status":null,"queued_turn_count":number,"credential_expires_at":"…Z",…}
// result_index 1: the turn started by the task notification
{"type":"result","subtype":"success","result_index":1,"origin":{"kind":"task-notification","producer":"session-task","runId":"run0001"},
 "result":string /* the workflow's JSON */,"permission_denials":[],"total_cost_usd":number /* same */, …}
```

`executor.outcome()` (unchanged) handled the real belt stream correctly: it takes the last result's JSON and
accumulates refusals from every result and `permission_denied` line. `credential_expires_at` and the
`rate_limit_event` record (`rate_limit_info` with utilisation and reset times) are account data: local-only.

### 3.9 Failures

| Case | What the stream shows | Exit |
|---|---|---|
| A worker's command refused (belt: 20 times, all `Bash`) | `system/permission_denied {tool_name, tool_use_id, agent_id, decision_reason_type:"asyncAgent"}` live; repeated in `result_index:0.permission_denials` with the full input | 0 |
| Budget smaller than the first turn (run 5) | Workflow launched, then at once `task_updated.patch.status:"killed"`, `task_notification.status:"stopped"`, one `result` `{subtype:"error_max_budget_usd", is_error:true, terminal_reason:"budget_exhausted", errors:["Reached maximum budget ($0.03)"]}`, no `result` text. Spent $0.055 of $0.03. stderr: `Budget limit reached ($0.05 of $0.03); stopping background agents.` | **1** |
| Budget crossed by the agents mid-workflow (run 6) | Agents `state:"error"`, `error:"Stopped because the workflow was stopped"`; `task_updated` `killed`; `task_notification` `stopped`; **one** `result`, `success`, `is_error:false`, `terminal_reason:"completed"`, its text "still running in the background". Spent $0.166 of $0.15. stderr only: `Budget limit reached ($0.17 of $0.15); stopping background agents.` | **0** |
| No Workflow tool (run 4) | No refusal: the tool does not exist. The model loaded the `mach:probe` skill instead, then said it could not run it. No `task_*` record. `success`. | 0 |
| A killed process | Not tested again here; M4 §3.4: no `result` at all. | — |

So `is_error`/`subtype` alone do not say whether the workflow ran or finished. The reliable signals are the
`task_updated.patch.status` (`completed` vs `killed`) and the presence of a workflow JSON in `result_index: 1`.

---

## 4. Proposed mapping: stream record → normalized observation

For the event-contract author. "Confidence" is about this runtime version: **High** = observed directly and
unambiguous; **Medium** = observed, but derived (diffing, inference from counts) or seen in one run only;
**Low** = estimate. IDs are namespaced by `execution_id` as M6.0 §6.1 proposes.

| Normalized observation | From | Fields | Confidence |
|---|---|---|---|
| `execution.stream_opened` | first `system/init` | `session_id`, `claude_code_version`, `model`, `tools[]`, `permissionMode`, `agents[]`, `skills[]` (names only) | High |
| `workflow.started` | `system/task_started` with `task_type:"local_workflow"` | `workflow_run = task_id`, `workflow_name`, `spawned_by = tool_use_id`; `wf_runId` from the `user` `tool_use_result.runId`; `observed_at` (no own time) | High |
| `workflow.phases_declared` | first snapshot's `workflow_phase[]` | `index`, `title` | High (declared list, not "phase entered") |
| `agent.queued` | first snapshot containing a new `index` | `index`, `label`, `phaseTitle`, requested `model` alias, `queuedAt` | High |
| `agent.started` | snapshot where the `index` first has `agentId`/`startedAt` | `agent_run_id = execution/agentId`, `parent_id = workflow_run`, `label`, `phase`, `agent_type`, `model`, `occurred_at = startedAt`, `attempt` | High |
| `agent.progress` | heartbeat `task_progress` (no array) | the agent **by label** (`description` after `"<phase>: "`), workflow totals | Medium (label, not ID; ambiguous if two live agents share a label) |
| `tool.called` (workflow agent) | heartbeat whose `usage.tool_uses` rose | count `+n`, agent by label; **no tool name, no ID, no target** | Low–Medium (≈1 per call; 83 of 245 heartbeats were not tool calls) |
| `tool.last_seen` (workflow agent) | snapshot `lastToolName` change | tool **name** only, at snapshot cadence (calls between snapshots are lost) | Medium |
| `tool.refused` | `system/permission_denied` | `tool_name`, `tool_call_id = tool_use_id`, `agent_run_id = agent_id`, `observed_at` | High |
| `agent.finished` | snapshot where `state` becomes `done` or `error` | `status` (`ok`/`error`), `occurred_at = startedAt + durationMs`, `duration_ms`, `tokens`, `tool_calls`, `error` text kept local | High (done), Medium (error: one run) |
| `agent.usage` | the agent's final snapshot | `tokens` (total only), `model` → an **estimated** cost flagged as such | High for tokens; Low for any cost |
| `workflow.finished` | `system/task_updated` (`patch.status`, `patch.end_time`) + `task_notification` (`status`, `usage`) | `status` `completed`/`killed`, `occurred_at = end_time`, `total_tokens`, `tool_uses`, `duration_ms` | High |
| `tool.called` / `tool.finished` (main loop, and Agent-tool sub-agents) | `tool_use` / `tool_result` | `tool_call_id`, `name`, `is_error`, `occurred_at = timestamp`; for sub-agents `agent_run_id = agent_id`, `parent = parent_tool_use_id` | High (not used by the belt today) |
| `execution.result` | the **last** `result` (and every `result` for refusals) | `subtype`, `is_error`, `terminal_reason`, `total_cost_usd`, `modelUsage{model: costUSD, tokens}`, workflow JSON from `result_index:1` | High |
| `execution.budget_stopped` | `task_updated.patch.status:"killed"` **and** no workflow JSON, or `subtype:"error_max_budget_usd"`; corroborate with `stderr.log` "Budget limit reached" | — | Medium (two runs; the mid-workflow case reports `success`) |
| `workflow.log` (`log()` lines) | **not in the stream**; only in `<wf_runId>.json` `logs[]` and the task output file | — | Not available from the stream |

Never forward: `prompt` (script source), `promptPreview`, `resultPreview`, `lastToolSummary`, `summary`,
`tool_input`, `tool_use_result`, `transcriptDir`/`scriptPath`/`output_file`/`cwd` (absolute paths), assistant text
and thinking, `rate_limit_info`, `credential_expires_at`. Safe: IDs, enumerations, labels and phase titles (MACH's own
vocabulary, which contains ticket IDs), counts, tokens, costs, durations, tool names.

---

## 5. Not observable from the stream (this version)

1. A workflow agent's individual tool calls: no `tool_use`/`tool_result`, no tool-call ID, no input, no per-call result or duration. (Only on disk, in `agent-<agentId>.jsonl`.)
2. Which tool a heartbeat stands for; the tool of a call made between two snapshots.
3. Per-agent cost, and per-agent token kinds (input, output, cache). Per-agent tokens are one total.
4. `log()` messages from the workflow script.
5. `phase()` calls as moments: only the declared phase list and each agent's phase.
6. Agent → agent nesting inside a workflow (workflow agents had no Agent tool here, so none exists to observe).
7. Wall-clock time of heartbeats, `task_started`, `task_notification`, `permission_denied` and `init`.
8. The station a ticket is in. Labels say which **worker** runs (`LOCAL-001: build`, `… verify`, `… security reviewer`); whether the station accepted the work is only in the cell's files (M6.0 G2). Clerk labels (`what next?`) all sit in phase `Preflight`.
9. The reason a mid-workflow budget stop happened, inside the stream (only stderr says so).
10. Agent-tool `subagent_stats` for workflows (it counts 0).

**The honest degraded picture**, if a viewer uses only the stream: "execution running; workflow `belt` started at T;
agents so far: *label, phase, model, state, start, duration, tokens, tool-call count, last tool name*, refreshed every
few seconds and on every start and finish; refusals by agent; the workflow ended `completed`/`killed` at T; cost per
model for the whole execution". It cannot show what each tool call did, how long it took, or what any agent cost.

---

## 6. Things that surprised

1. **Workflow agents are not streamed as messages.** The M5 POC and the docs describe sub-agent messages with `parent_tool_use_id`; that holds for the Agent tool (run 3), not for Dynamic Workflow agents. M4 §10's "including sub-agent activity" is true only as summarised snapshots.
2. **Two `result` records, and the first is written last.** A reader that stops at the first `result` sees "running in the background" and no workflow JSON. A reader that takes only the last misses the refusals in `permission_denials` (they are all on `result_index: 0`). `executor.outcome()` happens to do both right.
3. **A budget stop mid-workflow looks like success:** `subtype: "success"`, exit 0, a killed workflow, no JSON. Only `task_updated.status: "killed"`, the agents' `state: "error"`, and stderr say otherwise. Reported spend overshot the limit by 10% (run 6) and 83% (run 5).
4. **`last_tool_name` holds the agent label** for workflow tasks but a real tool name for Agent tasks: one field, two meanings depending on `task_type`.
5. **No Agent tool inside workflow agents.** If a belt worker (for example the plan step running the intent skill) expects to start `mach:contract-engineer`, it cannot here. Not exercised by this run (the ticket started at `planned`); worth checking against the plan station.
6. **The Workflow tool missing is not a refusal**: the main loop fell back to loading the workflow's skill and reported failure in prose; `success`, no `permission_denials`.
7. **`task_started.prompt` carries the whole workflow script source**, and the `tool_use_result` and `task_notification` carry absolute paths into `~/.claude/projects` and `$TMPDIR`.
8. `executor.tool_summary` recorded one refusal as `Bash: build.py";` (a quoted, chained command's word): the summary is lossy on quoted commands.
9. `ls -la` ran without a matching allow rule (run 1); `git -C <path> status --short` was refused although `Bash(git status *)` is allowed (the `-C` comes first). Read-only commands appear to be allowed by Claude Code itself (inference).
10. Every run, including the probes, writes its full transcripts (8.4 MB here) under `~/.claude/projects/` regardless of `--restricted`; nothing in MACH prunes or mentions them.

---

## 7. What could not be determined

- Whether any of this holds on another Claude Code version: one version (2.1.322), one machine, one day. The shapes in section 3 are what a parser should check, record by record (section 8; this document first said "pin to `claude_code_version`", which the M6.2 acceptance showed to be wrong).
- Whether `workflow_progress` snapshots are emitted on a timer or on events: the cadence (start, finish, then every few seconds) is inferred from timing.
- Whether `state` has values other than `start`, `progress`, `done`, `error`; whether `attempt` > 1 appears on a retried agent (never seen).
- Several tickets in one belt (`parallel(runTicket)`): not run. Distinguishing parallel tickets relies on the ticket ID in labels; inferred from the three parallel reviewer seats, not observed for two tickets.
- A failed (not budget-stopped) workflow agent, a workflow script error, a killed `claude` process, an API error or rate-limit stop: not provoked.
- Whether the budget is checked continuously or between agent requests (the overshoot suggests between requests; inference).
- Whether a plugin's own hooks would load under `--restricted --plugin-dir` (M6.0 §7 item 6): not tested.
- The M3/M4 path end to end (`factory enable`, `tick`, a product wave): not run; the executor and wrapper were the real ones, the supervisor and ledger were not.
- `stream_event` partial messages: none appeared (no `--include-partial-messages`), consistent with M6.0's inference.
- A new record type, `system/thinking_tokens`, appeared only in run 4 (main loop thinking); its meaning was not examined.

---

## 8. 2.1.323, and acceptance by shape instead of a version pin (M6.2)

**Observed.** The M6.2 end-to-end acceptance (`M6_2_ACCEPTANCE.md`, defect D1) ran three real executions on the same
machine the same day; Claude Code had auto-updated to **2.1.323** (`system/init.claude_code_version`). The observer was
pinned to 2.1.322 exactly, so it read only `session.initialized`, `tool.refused` and `execution.usage` and reported
17 `history.gap reason: unknown-type`: no workflow, agent or tool events for a live run. The format was compatible: a
copy of the same streams with only the `init` version rewritten parsed whole (13 agents in the first execution, 25 in
the second, every figure matching). Read through the shape checks below, **none** of the 925 records of the three 2.1.323
streams was refused (runs A and B, copies in the scratch area). 2.1.323 adds fields the
parser does not read (`result.origin`, `model_usage_since_last_result`, `usage.iterations`, more `modelUsage` keys)
and one record type, `system/thinking_tokens` (5 records; also seen once in 2.1.322 run 4), which is not read.

**Fixture.** `tests/fixtures/execution-streams/belt-plan-build-verify-2.1.323.jsonl`: records 1–45, 140–160 and 195–209
of the acceptance run's first execution (`plan` from `spec-ready`, a 10-task build, two verifications), 83 records,
made with `sanitize.py --keep 1-45,140-160,195-209`. The raw stream stayed in the scratch area.

**Policy now (the observer, `internal/normalize/streamshape.go`).**

1. Each record is accepted or refused **on its own shape**. For every classification the parser reads, a shape lists
   the type of each field it reads and of the objects on the way to them (`system/task_progress`:
   `task_id` string, `workflow_progress` a list of objects, each with `type` string, `index` number, `agentId`
   string, `startedAt`/`queuedAt`/`durationMs`/`lastProgressAt` numbers, `toolCalls`/`tokens` numbers,
   `lastToolName` string, …; a message's content blocks by their `type`; each `modelUsage` entry's numbers). A field
   may be absent or null unless it is required (`task_id`, a `tool_use`'s `id` and `name`, a `tool_result`'s
   `tool_use_id`, a message's `message` object); when present it must have its type. Fields the parser does not read
   are not looked at, so a runtime that adds fields stays compatible.
2. A record whose shape does not match is **refused whole**: nothing of it is read, it is counted per classification,
   and the first refusal of each classification is a `history.gap` with `reason: unexpected-shape`
   (`class: unknown-type`, `history_lost: false`: received, not interpreted). A record type the parser does not know
   is `reason: unknown-type`, as before.
3. Deny by default per record type and per field is unchanged.
4. The runtime version is recorded per stream, not used as a gate: `proven` (a version the fixtures come from: 2.1.322,
   2.1.323), `compatible-unproven` (another version, every record so far matched), `incompatible` (records were refused
   for their shape: counted; the records that matched are still read), `unknown` (no `init` yet). It is on every stream
   event as `origin.runtime_state`, on each stream source in `/health` and `/factory/status`
   (`freshness.sources[].runtime: {name, version, state, proven_versions, records_accepted, records_refused,
   refused_by_class, reason}`), summed in `health.ingest.runtime`, and in `/session`
   `capabilities.stream_observations` (`policy: "structural"`). A view can say "observed on an unproven runtime
   version" instead of showing nothing.

**Held by tests** (`apps/observer`): every record of every fixture matches the shapes
(`normalize.TestEveryFixtureRecordHasAKnownShape`, 291 records); the 2.1.323 fixture is read whole and `proven`
(`ingest.TestRealStream2_1_323IsReadWhole`); a made-up 9.9.9 with the known shapes is accepted and flagged
`compatible-unproven` on the source and every event (`TestUnprovenVersionWithKnownShapesIsAccepted`); 9.9.10 whose
`task_progress` agents carry `startedAt` as a string has each such record refused and counted, no agent event
forwarded, one `unexpected-shape` gap, the rest read, the source `incompatible` (`TestChangedShapeIsRefusedPerRecord`).
On a copy of the acceptance run A the observer now yields 405 events (was 222), 38 agents (13 + 25), one
`unknown-type` gap (`system/thinking_tokens`), the runtime `proven`, history `complete`.

**To prove a new version:** run a belt on it, sanitize an excerpt with `sanitize.py`, add it to the fixtures and the
version to `normalize.ProvenVersions` and `feed.ProvenStreamVersions` (a test holds them equal).

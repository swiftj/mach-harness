# MACH Next — M6.1 shared data contracts: Execution Timeline, Evidence Theater, Factory Analytics

Status: final design, on `feature/mach-next-m6-1-live-observability` at `cac989e`, revised after the stream proof (`M6_1_STREAM_COMPATIBILITY.md`) and the lead's decisions (event contract section 16). Nothing here is implemented in M6.1; the three experiences are later work. They are designed now so the event contract (`M6_1_EVENT_CONTRACT.md`) carries what they need and the observer's index can be built once.

Assumptions are marked **[A*n*]**. What the execution stream can supply is taken from the proof (Claude Code 2.1.322): workflow agents are visible as snapshots (identity, label, phase, model, state, start, duration, tool-call count, last tool name, one token total), never as individual tool calls.

---

## 1. Common ground

- **One input.** All three read the observer's v3 history (`M6_1_EVENT_CONTRACT.md`) and projections the observer computes from it. None reads `.factory/` directly, and none reconciles sources: identity, ordering, authority precedence and redaction are already done.
- **One vocabulary for how well a number is known**, used everywhere a duration, time or amount appears:

| Basis | Meaning | Example |
|---|---|---|
| `measured` | Both ends are recorded facts with `ms` or `s` precision from the same clock | a visit from `station.entered` to `station.exited` |
| `bounded` | At least one end is known only within bounds; the value is given as `[min, max]` | a tool call read after the fact, bounded by the execution's process span |
| `inferred` | An end was filled by a stated rule, never by guesswork about the model | a build task's start taken as the previous task's completion |
| `open` | Started, not ended (yet) | a visit in progress |
| `unknown` | Applies, but nothing records it | the ticket an Agent-tool call worked for, when nothing names it |
| `not-recorded` | No source exists in MACH or Claude Code's stream for this fact | test counts per run; per-agent cost; a workflow agent's individual tool calls |

A view may show `inferred` and `bounded` values only with their basis visible (a word, a hatch, an interval). It shows `unknown` and `not-recorded` as such, never as zero and never as blank space that reads as "nothing happened".

- **One set of refs**: the `kind:id` refs of the event contract (section 5.2). Every span, artifact and metric row links to them.

---

## 2. Execution Timeline

### 2.1 The span

The observer projects events into spans. A span is a derived record; it is rebuilt from events and never stored as truth.

| Field | Meaning |
|---|---|
| `span_id` | `<span kind>:<entity ref>`, e.g. `visit:visit:LOCAL-031/build#2`. Deterministic. |
| `kind` | section 2.2 |
| `entity` | the ref the span belongs to |
| `parent` | the enclosing span, only when recorded (event contract 5.3) |
| `ids` | the v3 `ids` of the opening event (ticket, cell instance, execution, visit, round, attempt, seat, agent, tool call) |
| `start` | `{event_id, at, precision, not_before, not_after, basis, rule}`; `basis`: `recorded` or `inferred` (with the `rule`) |
| `end` | `{event_id, at, precision, not_before, not_after, basis, rule, reason}` or null; `basis`: `recorded`, or `inferred` with its `rule` (2.3); `reason`: `completed`, `failed`, `refused`, `interrupted`, `superseded`, `unknown` |
| `duration` | `{ms, min_ms, max_ms, basis}`; `basis` (the reply's `basis_vocabulary`): `measured`, `bounded`, `inferred`, `open`, `unknown`; `ms` is null unless `basis` is `measured` or `inferred`, and is null for a span whose end was inferred (2.3: it never "took" a duration, only `max_ms`) |
| `outcome` | the closing event's outcome (`station.exited.outcome`, `review.decided.outcome`, …), null while open |
| `lane` | concurrency lane (2.4) |
| `authority` | the weakest authority of its two ends; `reconstructed` when an end is inferred |
| `attrs` | facts other routes already serve (label, model, tool-call count, round, attempt, state, cost, vote, reasons, depends_on); for a visit whose exit was recorded after it had been closed by inference, `interrupted_at` (ms) and `interrupted_reason`. A key is left out when nothing recorded it |

**No early outcomes.** A span read at time `t` has `end: null` and no outcome if its end sorts after `t`. This is the M6.0 guarantee (`test/no-early-outcomes.test.mjs`) and the production selectors must pass the same test.

### 2.2 Span kinds

| Kind | Opens | Closes | Notes |
|---|---|---|---|
| `wave` | `wave.discovered` | last slice's `slice.integrated` (`completed`) or `revision.superseded` of all slices | a wave is never "finished" before its last slice integrates |
| `slice-wait` | `dependency.blocked` | `dependency.resolved` | dependency wait (2.5) |
| `capacity-wait` | `capacity.wait_changed` `waiting` (reconstructed from the supervisor's "all N place(s) are in use" hold) | `capacity.wait_changed` `released` | execution-capacity wait, per ticket; id `capacity-wait:cell:<ticket>@<opening event id>`, `ids: {ticket_id}`; never from silence |
| `slice-eligible` | `dependency.resolved` (or `slice.materialized` with no dependencies) | `work.scheduled` | queue wait; capacity is not separable (2.5) |
| `cell` | `work.scheduled`, or the first lifecycle event, or `history.began` | `merge.completed` / `cleanup.completed` / `run.recorded` | |
| `round` | first `station.entered` with a new `ids.round` | the verdict that ends it: `gate.evaluated` (verification failed) or `review.decided` | judging rounds 1–3; round numbering follows MACH (first review after a failed verification is round 2) |
| `visit` | `station.entered` | `station.exited` with the same `visit_id`; with no exit, inferred (2.3) at its execution's end or the next entry of the same station | **measured**; the backbone of the Timeline |
| `gate-wait` | `review.decided` `AWAITING_HUMAN` | `human.approval_recorded` | human wait |
| `seat` | `review.round_started` (one per panel seat) | `review.verdict_submitted` for that seat | measured from lifecycle alone, whatever the stream shows |
| `claim` | `work.claimed` | `execution.process_started` | the supervisor's start latency |
| `execution` | `execution.process_started` | `execution.process_ended` | measured, seconds. Fallback when the records are missing: `execution.started` to `execution.completed`/`failed`, basis `bounded` (those are stamped late) |
| `workflow` | `workflow.started` | `workflow.finished` (`completed` or `killed`; never inferred from `result.subtype`) | start is an arrival stamp; end is `task_updated.end_time` (ms) |
| `agent-queue` | `agent.queued` | `agent.started` | measured (`queuedAt` → `startedAt`, ms): how long a workflow agent waited for the workflow to start it |
| `agent` | `agent.started` | `agent.finished` | **measured** (`startedAt` → `startedAt + durationMs`, ms, from the snapshots). Contents: a tool-call count and token total that step at each snapshot, never per-call marks |
| `tool` | `tool.called` | `tool.returned` / `tool.refused` | **main loop and Agent-tool sub-agents only** (in a belt execution: the one `Workflow` call); measured from the records' `timestamp` |
| `task` | see 2.3 | `build.task_completed` | start is inferred |

### 2.3 Measured and inferred durations

- **Visits, seats, rounds, gate waits, cells**: measured from lifecycle and v2 events. Mixed precision (`ms` lifecycle against `s` v2) gives a measured value rounded to the coarser precision, with `min_ms`/`max_ms`.
- **Executions**: measured from `started.json`/`result.json` (seconds). The v2 event times are kept as the supervisor's view and are not used for the span.
- **Build tasks**: only completion is recorded (`build.json tasks[].at`, now `build.task_completed`). The Timeline draws a task from the previous `build.task_completed` in the same visit (or the visit's start) to its own completion, with `basis: inferred`, rule `previous-completion`. It never invents a "task started" moment, and the inspector says "between … and …".
- **Agents**: measured, in ms, from the snapshot times (`startedAt`, `durationMs`), whether the stream was tailed live or read afterwards. Each agent's tool-call count and tokens are a step series at snapshot cadence (median 6 s apart, and at every start and finish); the Timeline draws them as steps, never as interpolated progress.
- **Main-loop tool calls**: measured from `assistant`/`user` `timestamp`s. A workflow agent's tool calls have no span at all.
- **Workflow start** has no time of its own (`task_started`): `arrival` when tailed live, `bounded` when read afterwards; the workflow's end has its own (`task_updated.end_time`).
- **Visits that recorded no exit**: the lifecycle log stays the only authority on visits and no exit is invented in the projection's state, but a span is not left running past what bounds it. The span ends at the first, after the entry, of the visit's execution's end (`execution.completed`, `execution.failed` or `execution.process_ended`: `end.basis: inferred`, `rule: execution-ended`, `reason: interrupted`) and the next `station.entered` of the same station (which names it as `unclosed_visit`: `rule: unclosed-visit`, `reason: superseded`). No outcome; `duration {ms: null, min_ms: null, max_ms: <to the bound>, basis: inferred}`; authority `reconstructed`; `/concurrency` counts it active only until the bound and `/marks` has an `interruption` mark (`reconstructed`) there. A wait on a person (the `human-approval` station, `gate-wait`, `person-wait`) is not an execution's work and is never closed this way. When the exit arrives later and is stamped after the bound, the recorded exit wins and the span carries `attrs.interrupted_at` and `attrs.interrupted_reason`. These are the Control Tower scene's rules (`reduce-v3.ts` `closeVisits`, its visits' `interrupted`), so the Factory Floor and the Timeline agree.
- **Visits closed only by cleanup** (`station.exited` with `closed_by: cleanup`, written at cleanup time): the exit is not the end of the work. The span ends at the bound above when there is one, else at the cleanup with `end.basis: inferred`, `rule: closed-by-cleanup`, `reason: unknown`; no outcome, `max_ms` only, `reconstructed`.
- **Executions whose outcome is unknown** (a `recovery.started` of kind `outcome-unknown`) with no recorded end: the span ends no later than that recovery, as a bound (`end.at: null`, `precision: bounded`, `not_after`: the recovery; `basis: inferred`, `rule: execution-outcome-unknown`, `reason: unknown`), no outcome, `reconstructed`; its visits and its open workflows, agents and tools end at the same bound. Nothing is "running" after it.
- `/concurrency` gives per bucket and kind `inferred_max`, the most spans active at once whose end is inferred, so a view draws recorded and inferred activity apart.
- **Idle time inside an execution** (between a visit's exit and the next visit's entry in the same execution) is a derived gap, labelled "between stations", basis `measured` if both ends are lifecycle events. It is not attributed to a clerk agent unless the stream shows one.

### 2.4 Concurrency

- **Lanes.** The observer assigns each span a lane within its parent: the lowest lane free at the span's start, ties broken by `order`. Deterministic, so a rebuild draws the same picture. A span with `bounded`/`unknown` precision is laid out in sequence after its predecessors in the same lane, not at a point.
- **Counts series.** For each minute bucket: cells active (open `cell` spans with an open visit), visits per station, executions running, workflow agents running (measured from snapshots), tool calls per agent (a count at snapshot cadence; there is no "in flight" for workflow agents). Computed incrementally (section 4.5); the Timeline's factory track and the Atlas's density read the series, not the spans.
- **`max_parallel`** from `factory.activated.limits` is drawn as the capacity line. Executions above it cannot occur; cells above it can (hand-driven work).

### 2.5 Waits

| Wait | Span | Basis | Limitation |
|---|---|---|---|
| Dependency | `slice-wait` | measured (`s`) | `dependency.blocked.reasons` is prose; the blocking slices are in `dependency.resolved.depends_on` and the ledger's edges |
| Queue (eligible, not yet dispatched) | `slice-eligible` | measured (`s`) | **capacity waits and "waiting for an engineer to dispatch" are not separable**: capacity waits are filtered out of v2 (M6.0 gap G6). Shown as one "eligible, not dispatched" wait |
| Supervisor start | `claim` | measured (`s`) | |
| Human approval | `gate-wait` | measured | |
| Person to merge (merge not allowed unattended) | from `review.decided APPROVED` to `merge.completed` when a `human.required` for merging exists | measured | the human.required is stamped at the next recorded plan |
| Execution retry | from `execution.failed` to the next `work.claimed` for the ticket | measured (`s`) | |

### 2.6 Attempts

Two separate counters, never merged (event contract section 4):

- `round` (judging round, 1–3): each `round` span holds the visits of that round. A revision is a new round's `build` visit (`action: revise`).
- `attempt` (execution attempt): each `execution` span carries the supervisor's attempt number. One round can span several executions (an execution that ended without moving the ticket, then another), and one execution can span several rounds (build, verify fail, revise, verify, review in one belt run).

### 2.7 Replay snapshots

The client's reducer stays the one authority on scene state (M6.0 contract rule 1). For long histories the client cannot replay from the first event on every load, so:

- **Checkpoints, client-side.** The engine keeps a scene every N events (start: 500) and the latest scene, as M6.0 architecture 6.3 proposes; a seek reduces forward from the nearest checkpoint; a late insert invalidates checkpoints after its `order`.
- **Windowed loading.** The client loads a history window (`GET /api/v1/history?from_order=&to_order=`) plus a **projection snapshot** at the window's start: the observer's own per-entity state (cells: stage, station, round, open visit; slices: scheduler state; executions: state; gates: state), keyed by `order`. The snapshot is a v3 data shape (`snapshot.v1`: `{order, entities: {ref: {kind, state fields}}}`), produced by the observer's projection, which already exists for Analytics (4.5).
- **Parity.** A conformance test applies the TypeScript reducer to the events before a snapshot's `order` and compares the fields the snapshot carries. Two implementations of the same projection is a cost; the test is what keeps it honest (open question 2).

### 2.8 What the Timeline asks the observer for

`GET /api/v1/spans?entity=<ref>&kinds=&ticket=&execution=&wave=&span=&from_ms=&to_ms=` → spans as in 2.1, those overlapping the window, at most 5,000 (`truncated`) (built); `GET /api/v1/history?from_order=&to_order=&entities=` → the events of a window in history order, from memory or the index's segments on disk; a page reads at most 10,000 lines from disk and then stops with `capped: true` and `more: true` (built); `GET /api/v1/series?from_ms=&to_ms=&bucket_ms=&ticket=|execution=` → event counts per bucket by kind and authority, whole minutes for the whole index (also per ticket or per execution) (built; the counts series of 2.6 stays **deferred**: a client computes it from `/spans`); `GET /api/v1/concurrency?from_ms=&to_ms=&bucket_ms=&kinds=` → per bucket and span kind the most and mean active, with the recorded Factory limits, each with `applies_to` (the span kinds it bounds: `max_parallel` → `["execution", "cell"]`, others `null`) (built); `GET /api/v1/marks` → instants to jump to, paged with `offset` (`more`, `next_offset`) in a stable order; `retry` is a revise visit and `attempt` a cell's execution after its first (built). All are derived from the projection (format 3: wait history, capacity waits, recovery and gap times, limit history), built from a snapshot outside the projection's lock and shared by concurrent requests, GET only, behind the session.

---

## 3. Evidence Theater

### 3.1 The artifact record

The catalog is the observer's projection of `artifact.recorded` events (event contract 10.6), one record per artifact version.

| Field | Meaning |
|---|---|
| `ref` | `artifact:<ticket>:<cell-relative path>@<sha256 first 12>`; commits: `artifact:<ticket>:commit/<sha 12>` |
| `logical` | the same without the version (`artifact:<ticket>:<path>`), which M6.0 views use |
| `kind` | the M6.0 `ARTIFACT_KINDS` (`intent`, `spec`, `contract`, `plan`, `commit`, `build-report`, `evidence`, `verification-results`, `verification-summary`, `vote`, `review-findings`, `merge-commit`, `archive`, …) |
| `nature` | `evidence`, `record`, `code`, `prose` (3.2) |
| `path_rel` | cell-relative (`evidence/AC-01.png`) or repository-relative for contracts and code; never absolute |
| `sha256`, `bytes`, `media_type` | computed by the observer from the file (or the Git object) |
| `integrity` | `match` (the observer's hash equals the hash a MACH record holds), `mismatch`, `missing` (the file is gone), `unchecked` (no MACH record holds a hash for it) |
| `commit` | the exact commit the artifact speaks about: evidence → `results.json head` of its verification round; vote → its `head`; decision → its `head`; build report → its `head`; a build task's commit → itself; merge → the merge commit |
| `links` | `{project_id, wave_id, slice_id, revision, ticket_id, cell_instance, visit_id, round, station, execution_id}` |
| `produced_by` | `{event_id, authority}`: the authoritative event that names it (a `verify.check_recorded`, a `build.task_completed`, a `review.verdict_submitted`), or the visit at whose exit the observer first saw it |
| `writer` | Always `unknown` for work done by workflow agents: their `Write`/`Edit` calls are not in the stream. Only a main-loop or Agent-tool call can be named. The producing station and visit (`produced_by`) are recorded; the agent is not |
| `supersedes` | the previous version's `ref` for the same logical artifact, if any |
| `content_access` | `none`, `metadata`, `media` (3.5) |

### 3.2 Verified evidence versus explanation

Evidence Theater must never let a reader take a model's explanation for proof. Four natures:

| Nature | What qualifies | Shown as |
|---|---|---|
| `evidence` | A file listed in `evidence/results.json` `records[ID].evidence[]` with a `sha256`, captured in the verification round named, with `integrity: match`. Only these are **verified evidence**. | the proof of a scenario, matrix rule or holdout, with its result and the commit it was captured against |
| `record` | A JSON record written by a MACH script (`results.json`, `summary.json`, `packet.json`, `votes/*.json` fields other than prose, `decision.json`, `build-report.json`, `cell.json`) | facts, with their writer |
| `code` | Commits on `feature/<ticket>` and the merge commit; contract files | diffs by reference (the Theater links to the commit; it does not render code it was not asked to) |
| `prose` | Model-written text: `intent.md`, `spec.md`, `plan.md` (reviewed by gates, still prose), `findings.md`, finding titles, vote summaries, the belt's `learning` | always labelled "written by an agent"; never styled as a verdict; never rendered as HTML |

`evidence` with `integrity: mismatch` or `missing` is shown as **not verified**, with the reason, and its check's result is shown as recorded but flagged. A verification verdict (`gate.evaluated`, gate `verification`) is linked to the checks it rests on (`verify.check_recorded` of the same round), and each check to its evidence: claim (spec ID) → check → evidence files → verdict, all at one commit.

### 3.3 Links

Every artifact links to: project, wave, slice and revision (from the cell's product block), ticket and cell instance, station visit, judging round, execution (when the producing event recorded it), and the exact commit. A reader can go from a slice in Product Studio terms to the screenshot that proved its scenario `AC-02` in round 2 at commit `9f2c0a1`, and back.

### 3.4 Hashes and provenance

- The observer hashes every catalogued file once per version (by size and mtime change), off the ingestion path.
- For evidence, the hash is compared with the one `verify.py record` wrote; MACH's hash is the authority, the observer's is the check.
- Commits are identified by SHA; their content is not hashed again.
- After cleanup, artifacts are read from the archive (`<t>.tar.gz` holds the cell folder without `repo/`); code after cleanup is reachable only if merged (the branch is deleted).

### 3.5 What the browser may see of an artifact

Decided in the M6.1 hardening (open question 4), as the observer serves it (`apps/observer/README.md`, "Artifact content"):

| `content_access` | Applies to | Browser receives |
|---|---|---|
| `text` (default for text) | text files of the catalog: evidence named in `results.json` (terminal transcripts, `curl` dumps, `exit-codes.json`), `results.json`, `summary.json`, `findings.md`, `decision.json` | the text, by catalog id through `GET /api/v1/artifacts/<id>/content`, after an integrity check, never by path: always `text/plain; charset=utf-8`, cut to 256 KiB, scrubbed by the same text scrubber as every event field (credentials, long opaque and long hex runs, e-mail addresses, absolute paths, control and bidirectional characters), with the count in `X-MACH-Redacted`; in a JSON record the hex values of the known hash keys (`sha256`, `head`, `since_commit`, `commit`) are kept |
| `media` | evidence images and video (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/webm`, `video/mp4`) **when the project opts in** with `.factory/config.json` `{"tower": {"evidence_media": true}}` | the bytes, by catalog id, after an integrity check, with `Content-Type` from the observer's own sniffing, `Content-Security-Policy: sandbox`, range requests for video |
| `media-disabled` | the same images and video without the opt-in (the default) | metadata only; the content route answers 403 `media-disabled` |
| `none` | anything whose sniffed type is not served (HTML, SVG, binaries), and everything outside the catalog's roots (`repo/`, `.factory/local/`, execution streams, `packet.json`, `diff.patch`, `test-suite.log`, `contract-check.log`) | nothing beyond metadata (outside the roots: not even that); a person opens it locally |

Text is served by default because the scrubber can read it: what it cannot recognise as a secret is shown, which is why the rules are shared with the event path and held by the adversarial corpus test. Images and video cannot be scrubbed, so they wait for a project's explicit opt-in.

---|---|---|
| `metadata` (default) | everything | the record in 3.1, without content |
| `media` | `evidence` files of media type `image/png`, `image/jpeg`, `image/gif`, `video/webm`, `video/mp4` | the bytes, by `ref` through `GET /api/v1/artifacts/<ref>/content` (the observer design's artifact route), after an integrity check, never by path, with `Content-Type` from the observer's own sniffing and `Content-Security-Policy: sandbox` |
| `none` | text evidence (terminal transcripts, `curl` dumps, `exit-codes.json`), logs, `.env`-like names, anything outside the cell or repository | nothing beyond metadata; a person opens it locally |

Text evidence is withheld by default because it is captured from a running application and can hold tokens or personal test data; redacting it reliably is not designed here (open question 4). Screenshots can hold the same, but they are what the verifier chose to show and what a reviewer already reads; that trade-off is the lead's to confirm (open question 4).

---

## 4. Factory Analytics

### 4.1 Rules

1. **Recorded values only.** Cost and tokens come from what Claude Code reported and MACH or the stream recorded. No price table is applied, no tokens are estimated from text, no cost is apportioned to agents, stations or tickets by time share.
2. **Every metric states its denominator**, its source events and their authority, and its limitations. A metric with an empty denominator is `null`, not 0.
3. **One definition per concept.** Where the observe station already defines a metric, Analytics uses the same definition on the same records (4.4).
4. **Coverage is part of the answer.** Each metric row carries `coverage`: the share of the denominator for which the source existed (for example, tickets with a lifecycle log), so a 100% first-pass rate over 2 of 40 tickets cannot pass for a fact about 40.

### 4.2 Metric catalog

Dimensions: `project`, `wave`, `slice`, `ticket`, `risk`, `app_type`, `station`, `round`, `seat`, `model`, `writer` (supervisor or hand-driven: whether an `execution_id` is recorded), `period` (day, week). "Avail." is M6.1 availability: **yes**, **lifecycle** (needs the lifecycle log), **stream** (from the execution stream, as proven), **no**.

| Id | Metric | Numerator | Denominator | Dimensions | Source (authority) | Limitations | Avail. |
|---|---|---|---|---|---|---|---|
| T1 | Tickets merged | `merge.completed` count | per period | project, wave, risk, app_type, writer | lifecycle (auth.) | merged ≠ accepted (T2) | lifecycle |
| T2 | Accepted delivery | `slice.integrated` count (the slice's commit is on the integration branch) | per period | project, wave, risk | v2 (auth.) | stamped when the plan noticed; non-product tickets have no slice | yes |
| T3 | Waves delivered | waves whose every current slice revision is integrated | per period | project | v2 | a superseded revision restarts it | yes |
| C1 | Station cycle time | sum of `visit` durations | visits | station, round, risk, app_type | lifecycle (measured) | cells without a log excluded (coverage) | lifecycle |
| C2 | Station visits per ticket | visits | tickets with a log | station | lifecycle | | lifecycle |
| C3 | End-to-end cycle time, dispatch to merge | `work.scheduled` → `merge.completed` | merged product tickets | wave, risk, app_type | v2 + lifecycle (measured, `s`) | product tickets only | lifecycle |
| C4 | End-to-end, eligible to integrated | `dependency.resolved` → `slice.integrated` | integrated slices | wave, risk | v2 | includes queue wait | yes |
| C5 | Wave lead time | `wave.discovered` → last `slice.integrated` | delivered waves | project | v2 | | yes |
| W1 | Dependency wait | `slice-wait` durations | slices ever blocked | wave | v2 | | yes |
| W2 | Queue wait (eligible, not dispatched) | `slice-eligible` durations | dispatched slices | wave, writer | v2 | a slice waiting for a free cell is not recorded, so cell-capacity and engineer waits are not separable (G6) | yes |
| W2b | Execution-capacity wait | `capacity.wait_changed` `waiting` → `released` durations | tickets ever held for capacity | | reconstructed from `scheduling.decided.held[]` (rule `held-sentence`) | supervised mode only; `scheduling.decided` is emitted only on change, so the release is when the next distinct decision no longer holds it; never inferred from silence | yes |
| W3 | Human approval wait | `gate-wait` durations | rounds `AWAITING_HUMAN` | risk | lifecycle | | lifecycle |
| W4 | Supervisor start latency | `claim` durations | executions started | | v2 + execution records | | yes |
| W5 | Observation lag | `execution.process_ended` → `execution.completed` | completed executions | | execution records + v2 | measures the supervisor's poll, not work | yes |
| Q1 | First-pass verification | tickets whose round-1 `verify.verdict` gate has `status: PASS` | tickets with a round-1 verification | risk, app_type | lifecycle | | lifecycle |
| Q2 | First-pass rate (observe) | merged tickets with `first_pass` | merged tickets | risk, app_type | `run.recorded` (auth.) | **same as `observe.scorecard first_pass_rate`** | yes |
| Q3 | Average judging rounds (observe) | sum of `rounds` | merged tickets | risk, app_type | `run.recorded` | **same as `average_rounds`**; target < 1.3 | yes |
| Q4 | Verification failures by kind | failed checks by `target_kind` | failed verifications | app_type | lifecycle; `run.recorded.verify_failures` | observe's `finding_kind` grouping reused | lifecycle |
| R1 | Review rejection rate | `review.decided` `REJECTED` or `ESCALATE` | decided rounds | risk, round, seat | lifecycle; `run.recorded.review_rejections` | | lifecycle |
| R2 | Blockers by rule | blocker findings grouped by `rule` | rounds | seat, risk | reconstructed findings; `run.recorded.blockers` | observe's patterns (`group_findings`) reused | yes |
| R3 | Security veto rate | `review.decided.security_veto` | decided rounds with a security seat | risk | lifecycle | | lifecycle |
| R4 | Remediation time | rejection or failed verification → the next round's verification `PASS` | remediated rounds | risk | lifecycle | | lifecycle |
| R5 | Escalation rate (observe) | tickets `escalated` | finished tickets | risk | `run.recorded` | **same as `escalation_rate`** | yes |
| R6 | Abandonment rate (observe) | `outcome == abandoned` | finished tickets | | `run.recorded` | **same as `abandonment_rate`** | yes |
| X1 | Execution retries | `execution.failed` | executions | ticket, stage | v2 | | yes |
| X2 | Gate refusals | `gate.evaluated` with `verdict: refused` | gate evaluations | gate, station, `reason_code` | lifecycle | a refused command that never reached its station's error handler (a crash) is not recorded | lifecycle |
| X3 | Overrides | `gate.evaluated` with `verdict: overridden` | build tasks completed | gate, `reason_code` | lifecycle | the override's reason text stays in `build-report.json` | lifecycle |
| S1 | Recovery events | `recovery.started` by `kind` | supervisor ticks with executions | kind | v2 | ticks are not events; the denominator is executions | yes |
| S2 | Outcome-unknown rate | executions closed `unknown` | executions | | v2 | | yes |
| S3 | Executions that moved the ticket | `execution.completed` | `execution.completed` + `execution.failed` | stage | v2 | | yes |
| S4 | Tickets parked for a person | supervisor `human.required` | tickets executed | reason (prose, grouped by the supervisor's fixed sentences) | v2 | | yes |
| S5 | Refused tools | `tool.refused` / `execution.completed.refused_tools` | executions | tool | stream (proven) / v2 | program names only | yes |
| K1 | Recorded cost per execution | `execution.completed.cost_usd` | executions | ticket, stage | v2 (Claude-reported, recorded by MACH) | null when the run had no result | yes |
| K2 | Recorded cost per model | `execution.usage.models[m].cost_usd` | executions | model | stream (proven) | per execution, not per agent | yes |
| K3 | Tokens per model | `execution.usage.models[m]` input, output, cache read, cache creation | executions | model | stream (proven) | as K2 | yes |
| K4 | Recorded cost per ticket | sum of K1 over the ticket's executions | tickets | risk, app_type | v2 | **excludes hand-driven work** (no execution); **includes** any other ticket's work run inside its execution (the belt's tuning ticket, G4) and says so | yes |
| K5 | Cost per station or per agent | — | — | | — | **not available**: the stream gives no per-agent cost, and no price table is applied to tokens | no |
| K7 | Tokens per agent | `agent.finished.tokens` | agents | label-derived station and seat, model, phase | stream (observed) | one total per agent: no input/output/cache split; labels give station and seat (`inferred: label`) | stream |
| K8 | Agent time | `agent` span durations | agents | label-derived station and seat, model | stream (measured) | clerks (`what next?`) carry no station | stream |
| K9 | Agent queue time | `agent-queue` span durations | agents | phase | stream (measured) | | stream |
| K10 | Tool calls per agent | `agent.finished.tool_calls` | agents | label-derived station, model | stream | a count only; which tools, and how long each took, are not recorded | stream |
| S6 | Workflows killed | `workflow.finished` with `status: killed` | workflows started | `stop_reason` | stream | `stop_reason: budget` read from a result subtype or `stderr.log` (rule named); a killed run's reported cost may be low (proof 3.5) | stream |
| K6 | Turns and duration per execution | `execution.usage.turns`, `duration_ms` | executions | | stream (proven) | | yes |
| G1 | Tests seen failing first (observe) | `tests_seen_failing_first` | that plus `tests_passing_on_first_run` | risk | `run.recorded` | **same as `tests_failing_first_share`**; target > 0.9 | yes |
| G2 | Deviations per ticket (observe) | deviations | finished tickets | type | `run.recorded` | **same as `deviations_per_ticket`** | yes |
| G3 | Evidence integrity | evidence with `integrity: match` | catalogued evidence | app_type | observer (reconstructed) | | yes |
| G4 | Post-merge faults | `AUTO-*` tickets whose culprit file was changed by a merged ticket | merged tickets | | — | **not available**: no recorded link from a telemetry ticket to the change that caused it | no |

### 4.3 Never shown

Per-agent or per-station cost (never recorded; never estimated from tokens); per-agent token kinds; per-call tool counts by tool name or per-call durations for workflow agents; test pass/fail counts; "time to start a task"; tier or effort per agent (not recorded); a workflow counted as completed from `result.subtype: success`; anything from Claude Code's per-agent transcripts on disk (excluded, event contract D17).

### 4.4 Parity with the observe station

Q2, Q3, R5, R6, G1 and G2 are computed by Analytics from `run.recorded` events with the observe station's formulas (`observe.py scorecard`, `rate`, `measure`, `TARGETS`), and broken down the same way (`breakdown` by `risk` and `app_type`). A parity test runs both over the same `runs.jsonl` and asserts equal values. Analytics differs from observe only in time windows (observe takes the last `depth` runs by `closed_at`; Analytics takes a period) and in dimensions; it does not redefine first pass, rounds, escalation or abandonment. R2 and Q4 reuse observe's grouping (`group_findings`, `finding_kind`), so a pattern the observe station proposes a rule for is the same pattern Analytics shows.

### 4.5 Incremental aggregation

Analytics must not rescan raw events on each load.

- **Projection.** The observer folds each committed event into a per-entity state table (cells, visits, rounds, executions, slices, waves, seats) as it ingests. Spans close when their closing event arrives.
- **Aggregates.** When a span closes or a countable event arrives, the observer updates aggregate cells keyed by `(metric, dimension values, period bucket)`. Each cell holds mergeable values only: count, sum, min, max, and a fixed log-scale histogram for durations (for example 64 buckets from 1 s to 30 days), from which p50 and p90 are read. Mergeable values make late events cheap: a late event is applied as a delta to its own bucket, with no recomputation of others.
- **Late and corrected inputs.** The aggregate store records the last `pos` applied. An event marked `late` is applied normally (it is a delta). A `history.gap` with `reason: conflict` marks affected buckets `suspect` until the next rebuild.
- **Rebuild.** Aggregates carry `definitions_version`. Changing a metric's definition, or a new epoch, rebuilds them by replaying the index once, in `order`. The rebuild is the same fold, so its result equals the incremental one (a test replays a history both ways and compares).
- **Reads.** `GET /api/v1/metrics?ids=&group_by=&period=&from=&to=` reads aggregate cells only. Percentiles across buckets merge histograms. Each row returns `value`, `numerator`, `denominator`, `coverage`, `basis` and `limitations` (the catalog's text).
- **Storage** **[A1]**: standard library only, as the M5 host: an append-only segment file for the index, and the projection and aggregates as compacted JSON snapshots written every N events and at shutdown, each with the `pos` it covers; on start, load the snapshot and replay the index tail. Sized for thousands of tickets per project; a database is not needed at that scale (open question 5).

### 4.6 Across projects

One observer serves one project (event contract A7). A portfolio view sums aggregate cells from several observers, keyed by `project_id`; rates are recomputed from summed numerators and denominators, never averaged.

---

## 5. Assumptions

- **[A1]** The observer is Go with the standard library only, as the M5 host. If a dependency such as SQLite is allowed, 4.5's storage changes; the contract does not.
- **[A2]** Evidence files stay in `evidence/` with the hashes `verify.py` wrote, and earlier runs stay in `evidence/previous-N/` (M6.0 gaps 2.4).
- **[A3]** `runs.jsonl` remains the authoritative per-ticket outcome record, with `record_version` 2 or later fields as listed in `cleanup.py` (`rounds`, `first_pass`, `verify_failures`, `review_rejections`, `escalated`, `human_approval`, `deviations`, `blockers`, `tests_seen_failing_first`, `tests_passing_on_first_run`, `risk`, `app_type`, `integration`).
- **[A4]** One machine, one clock (event contract A6); durations mixing sources are therefore comparable.

## 6. Open questions for the lead

1. **Task spans with an inferred start**: draw them (with the basis shown), or show only task completion marks? The inferred form reads better; the marks are stricter.
2. **Two implementations of the projection** (Go for snapshots and Analytics, TypeScript for the client's scene) held by a parity test, or one: the observer serves scenes and the client only renders? The second removes the reducer from the browser and changes M6.0's architecture; the first keeps it and costs a test.
3. **Coverage threshold**: should Analytics refuse to show a rate whose coverage is below some share (for example 50%), as the observe station refuses reports on fewer than five tickets?
4. **Evidence content in the browser**: media by default and text never (3.5)? Or nothing but metadata until a redaction design exists for both?
5. **Storage engine** for the index and aggregates: standard library files (4.5) or an embedded database?
6. **Cost per ticket** (K4) includes other tickets' work run inside its execution (the belt's tuning ticket). The stream can now attribute that work's **agents and tokens** to its own ticket by label, but not its cost. Show K4 with the caveat, or also show the tokens attributable to other tickets beside it?
7. **Killed executions' cost.** When a budget stop kills agents in flight, the reported spend may be low (one observation in the proof). Flag those executions' K1 as "may be under-reported"?

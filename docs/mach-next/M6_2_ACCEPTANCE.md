# MACH Next — M6.1/M6.2 end-to-end acceptance: a real, authorized Factory run watched live by the Control Tower

Independent check, 2026-11-12, on `feature/mach-next-m6-1-live-observability` at `f14448e` (clean). Nothing in the
repository or this worktree was run as a Factory, changed or committed; this file is the only addition (uncommitted).
Everything below was observed in this session. Scratch area (raw data, scripts, the few screenshots):
`/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m62-e2e/`
(called `<scratch>` below).

## 0. Verdict

| # | Point | Result |
|---|---|---|
| 1 | Authorized Factory run producing observable events | **Pass**, with the stream largely unreadable (D1) |
| 2 | Real station transitions reaching the browser | **Pass** (20 of 20, live over SSE) |
| 3 | Real verification result | **Pass** |
| 4 | Reviewer outcome / controlled human gate | **Pass** (REJECTED, then AWAITING_HUMAN on a High-risk ticket) |
| 5 | Correct live rendering, both views, inspector, honesty | **Partly**: many facts match the API; nine rendering defects (D3–D11, D13, D14, D23) |
| 6 | Reconnection: browser reopen, observer kill/restart, stale → disconnected → recovered | **Pass** |
| 7 | Historical replay | **Pass** on the real history; **partly** at scale (D17) |
| 8 | Provenance and artifact links | **Partly**: hashes, scrubbing, path refusal and "Go to event" pass; no visit links (D12) |
| 9 | No change to Factory behaviour without the observer | **Pass** (deterministic belt byte-identical after normalisation; real model runs diverged for model reasons only) |
| 10 | No unnecessary disclosure | **Fail**: 0 leaks in the real run and in an adversarial stream, but **one leak** in the deterministic run: a person's name served by `artifacts/{id}/content` (D2). By the product owner's rule this is a blocker. |

Total real spend: **$8.79** reported by `total_cost_usd` (three executions), plus two `factory enable` preflight probes
whose cost is not recorded anywhere (the M4 doc puts such a probe at cents).

## 1. Defects (severity, owner, evidence)

Severity: Blocker (fails an acceptance rule), High, Medium, Low.

| ID | Sev | Owner | Defect | Evidence |
|---|---|---|---|---|
| D2 | **Blocker** | observer | `GET /api/v1/artifacts/{id}/content` serves `review/round-N/decision.json` with `"human_approval": {"by": "<person's name>", "recorded_by": ...}`. The README's "never forwards a person's name" and the shell's "people by role only" are broken by the content route (events and DOM are clean). | Deterministic run SA, artifact `a8af1e0f6142462da2dfc3fb3` (`review/round-3/decision.json`): 200, `X-MACH-Redacted: 1`, body contains the approver's name. The real run never reached an approval, so it was not exercised there. `<scratch>/logs/leak-SA.json` |
| D1 | High | observer | The stream parser is pinned to Claude Code **2.1.322 exactly**. This machine's Claude Code auto-updated to **2.1.323** the same day, so the real run produced **no** `workflow.*`, `agent.*`, `tool.called/returned` events: only `session.initialized`, `tool.refused`, `execution.usage` and 17 `history.gap reason: unknown-type`. Fail-closed as designed (contract 10.5), but an exact pin on a daily-updating runtime means the live agent picture is missing in practice. | `session.capabilities.stream_observations = {claude_code_version: "2.1.323", ok: false}`. A copy of the same real streams with only the `init` version rewritten (`<scratch>/SHIM`) parses completely: 13 agents in the first execution, every figure matching (section 5.4). So the 2.1.323 format was compatible. |
| D3 | Medium | atlas | Plan drawn **Passed / "Plan station: succeeded"** while the cell was at `spec-ready` and the plan visit had not begun (lifecycle held only the three groom records). | ARIA dump at 22:46 UTC, `<scratch>/shots/explore1.aria.yml`: `img "Plan: Passed"`, `button "Plan station, LOCAL-001: succeeded"`; `lifecycle.jsonl` lines 1–3 only. |
| D4 | Medium | sim-scene / shell | A superseded visit that never exited is shown **"Working … at work for 11 min 49 s"** after its execution ended (verify#2; also verify#1, verify#4). The next entry records `unclosed_visit`; the view ignores it. | Inspector of `visit:LOCAL-001/verify#2` (`<scratch>/logs/inspect-A.txt`): "Working", "Left: still open", "Duration: at work for 11 min 49 s"; API visit has no exit; execution `x13e7…` ended 22:53:10. |
| D5 | Medium | sim-scene | In live ingestion the cell is **not linked to its slice**: cell inspector "Slice" is empty, the slice's Related button reads "LOCAL-001 LOCAL-001", the timeline has a separate `SLICE-001` track stuck at "Dispatched". The same files read as backfill (SHIM) link correctly ("Slice: SLICE-001"). The API has `slice_id: SLICE-001`. Order/source-dependent scene. | `inspect-A.txt` vs `inspect-SHIM-cell.json`; `timeline-A.json` vs `timeline-SHIM.json`. |
| D6 | Medium | shell / sim-scene | **Overridden gates shown as "Passed"**: cell inspector lists "Red before green Passed"; the lifecycle has `gate.evaluated red-before-green outcome: override, reason_code: test-passed-first-run` (and `frozen-tests override test-amended`, not listed at all). Overrides are exactly what reviewers must see. | `inspect-A.txt` Gates list; API `cells/LOCAL-001.gates` verdict `overridden`. |
| D7 | Medium | shell | With stream observations unavailable the execution inspector says **"Agents 0"** and the cell "0 working, 0 so far", as if no agent ran (13 + 25 did). Should say "not observed (Claude Code version not supported)". | `inspect-A.txt` execution `x466e1b0a645d`. |
| D8 | Medium | shell | Header: **"Partial · 6 ranges of history could not be received"** for `unknown-type` gaps; the lines were received, not parsed. Misleading in exactly the D1 situation. | `explore1.aria.yml`. |
| D17 | Medium | shell / live source | Large history (230,853 events): **61 s** from page load to first render (connection "live"), JS heap **872 MB** after load; replay scrub median **688 ms**, p95 1.2 s, max 1.7 s; connection facts say "Received 181,203 events, 24,524 late" while the observer's head is 230,853 and it marked none late (all backfill). The 49,650 difference is unexplained. | `<scratch>/logs/bigopen.json` |
| D18 | Medium | observer | Peak RSS **1.6 GB** while backfilling the 230k history (19.7 s catch-up), index **300 MB** on disk for 105 MB of source; RSS falls to 27 MB afterwards. | `ps` samples during catch-up |
| D21 | Medium | stations (run/supervisor) | The **per-day budget does not cap the per-run budget**: day limit $5.50, first run spent $1.68, the second run was started with `--max-budget-usd 5.0` (possible total $6.68). `supervisor.py:342–346` checks only `spent >= limit` before starting; `:446` always passes the full per-run limit. | `A/eng/.factory/local/executions/x466e1b0a645d/spec.json` |
| D22 | High (Factory, not observer) | stations (verify, review skills) | Under the restricted boundary the **verifier's commands are refused** (heredocs, `cd … && git`, redirects): run A1 and run B each ended "stuck at built, verify ran twice without moving" after `INCOMPLETE_EVIDENCE`; `review.submit` was refused twice in both runs. M4 known issue 9, still live. | A1/B `result_index 1` JSON; lifecycle `verify.finish refuse incomplete-evidence`, `review.submit refuse refused` |
| D9 | Low–Med | blueprint | Blueprint labels are in **local time with no zone** (tree items "at 17:45:29", execution span "17:45:29 → 17:53:10", Revisions "18:02:11", title block "Live 17:51:44.7") while transport, inspector and Atlas say UTC (22:45:29). | `explore2.aria.yml`, `g12-blueprint.png` |
| D10 | Low–Med | atlas | Atlas names the round-2 consensus gate "open, AWAITING_HUMAN"; the inspector and the cell's gate list say "Passed / Finished at 23:03:20". | `inspect-A.txt` |
| D11 | Low | observer / sim-scene | "App type: Not recorded" though the plan exit records `app_type: library` (and `cell.json` has it); API `cells/LOCAL-001.app_type` is `""`. | `apiA-cell.json`, lifecycle seq 6 |
| D12 | Low | observer | Evidence catalog: **`visit` is null on all 13 entries**; `round` null on every `results.json`. Ticket, round (summary, logs, review files), commit and targets are linked. | section 8 table |
| D13 | Low | shell | Three counts called "artifacts" for one cell: inspector 31 (distinct refs), snapshot `artifacts.recorded` 45 (events), catalog 13 (servable). No label says which. | section 7 |
| D14 | Low | shell | Human-approval gate and visit say "Working / at work for 1 min 37 s" for a wait on a person; the gate's Evidence says "0 events" while its Record names source `c:…:78`. | `inspect-A.txt` |
| D15 | Low | sim-scene | A cell is invented from agent labels alone: in the 12-cell fixture a stream whose labels name `LOCAL-001` (no `cell.json`, no lifecycle) produced a cell "LOCAL-001 Grooming" with a passed first column in Blueprint. | `g12-atlas.png`, `g12-blueprint.png` |
| D16 | Low | observer | `factory.activated`, the first line of an intake log created **after** the observer started, carries `provenance.rule: backfill`; the README says such a file is live from its first line. | `eventsA.json` pos 1 |
| D19 | Low | shell | axe `target-size` (serious): a 13.6×16 px target in the Simulation timeline at 1512×982 (1 node; not at 1440 or 1728; none in live or replay). | `a11y-A.json` |
| D20 | Low | shell | Transport says "31 new events" when scrubbed back with an idle Factory: it counts events after the playhead, not new arrivals. | `goto-A.json` |
| D23 | Low | shell | Workflow inspector's Record region shows the execution's record (`i:df29bf72:12`, Authoritative) instead of the workflow's own (observed, `s:…:200.0`). | `inspect-SHIM.json` |
| D24 | Low | shell | Visit "Why it looks like this" cites a reconstructed `artifact.recorded` instead of the authoritative `station.exited` at the same millisecond. | `inspect-A.txt` verify#5 |
| D25 | Low | observer | Served `decision.json` shows `"findings": ".[redacted].md"`: a relative name over-scrubbed. | `leak-SA.json` |

## 2. What was run

### 2.1 Paths

1. **The full supervised path, real, twice** (A observed, B unobserved), from one base:
   - `<scratch>/base` built by the repository's own helpers (`tests/test_mach_product_intake.py` `Base.setUp` + `first()`): a bare origin, a product manager's clone running the real `studio.py` (project, epic, SLICE-001 approved, WAVE-001 approved and **sent** as `product/WAVE-001`), and an engineer's clone that **merged** it and pushed. The intent says **Risk: High**.
   - In the engineer's clone: an `app/` package, `tests/test_base.py` (passes), canaries (section 10), `bin/mach install --no-studio --no-tower` from this worktree, a real `audit.py run` (**Silver**).
   - Copied to `A` and `B` (`cp -a`, remotes re-pointed to each copy's own origin). `apps/observer/bin/mach-observer` (built by `SKIP_INSTALL=1 apps/observer/build.sh`, Control Tower embedded) copied to each `.factory/bin/mach-observer`.
   - In each: `run.py factory enable --autonomy supervised --include-backlog --max-parallel 1 --budget-per-run 5 --budget-per-day 5.5 --max-runs-per-day 2 --max-attempts 1 --max-minutes 40 --max-risk High`, then `--confirm <code>` (authorization machine-local to each scratch folder).
   - `run.py factory tick` in A and B at the same moment: M3 intake and dispatch (`work.scheduled`), the supervisor's claim, and one execution each through MACH's executor and detached wrapper (`--restricted --strict-mcp-config --permission-mode default --permission-prompts none`, the policy's explicit tool list, `--max-budget-usd 5.0`; never `--dangerously-skip-permissions`).
   - A second `tick` on A recovered the first execution and, within the authorization, **started a second execution** (attempt 1 at step `verify`). B was `factory pause`d before its second tick so it would start nothing more. Both were paused, ticked once more to record completion, then `factory disable`d.
2. **A deterministic belt through the real station scripts, no model** (`<scratch>/tools/scripted_belt.py`, the `test_lifecycle` WholeBelt flow made persistent): groom, plan, audit, build (5 tasks), a failed verification, revise, verify, review rejected, revise, verify, review awaiting a person, approval, merge, cleanup. Run once with the observer and a browser attached (`SA`), once with neither (`SB`).
3. **Fixtures, no Claude spend**: 12 live cells in 3 waves plus a dense stream (`G12`), a 210k-line generated history (`H200`), and a copy of run A with the stream's `init` version rewritten to 2.1.322 plus an injected adversarial stream (`SHIM`).

### 2.2 The three real executions

| Execution | Project | Asked | Budget | Exit | Seconds | Outcome | `total_cost_usd` | Per model |
|---|---|---|---|---|---|---|---|---|
| `x13e7bccffc37` | A (observed) | plan (from `spec-ready`) | 5.0 | 0 | 460 | plan, build (10 tasks), verify INCOMPLETE twice → belt "stuck at built" | 1.685 | Opus 0.90, Sonnet 0.77, Haiku 0.01 |
| `x466e1b0a645d` | A (observed) | verify | 5.0 | 0 | 506 | verify PASS, review REJECTED (security blocker), revise, verify PASS, review AWAITING_HUMAN → **stopped at `awaiting-human`** | 3.361 | Opus 2.52, Sonnet 0.82, Haiku 0.02 |
| `x6a94ee3686fe` | B (no observer) | plan | 5.0 | 0 | 752 | plan, build (11 tasks), verify PASS, review REJECTED, revise, verify refused twice → "stuck at built" | 3.746 | — |

Claude Code 2.1.323 (`system/init`). Every process started was stopped: observers (A, its restart, SA, SHIM, G12 twice, H200), browser monitors, tailer, samplers. No LaunchAgent, hook or timer; `~/.claude` settings untouched. Claude Code itself wrote its usual transcripts under `~/.claude/projects/` for the three sessions (unavoidable, as the stream proof noted).

## 3. Point 1 — observable events from an authorized run

`GET /api/v1/events` on A, paged to the end: **222 events**.

| Source | Authority | Count |
|---|---|---|
| cell-lifecycle | authoritative | 78 (= 78 lines of `lifecycle.jsonl`) |
| intake-log | authoritative | 20 |
| intake-log | observed (`station.observed`) | 2 |
| execution-record | authoritative | 4 (`process_started` ×2, `process_ended` ×2) |
| execution-stream | observed | 33 (`tool.refused` 29, `session.initialized` 2, `execution.usage` 2) |
| observer | reconstructed | 85 (`artifact.recorded` 45, `review.finding` 18, `history.gap` 17, `verify.targets_listed` 5) |

Kinds: `artifact.recorded` 45, `tool.refused` 29, `gate.evaluated` 19, `review.finding` 18, `history.gap` 17, `verify.check_recorded` 16, `build.task_completed` 13, `station.entered` 12, `station.exited` 8, `review.verdict_submitted` 6, `verify.targets_listed` 5, `scheduling.decided` 3, two each of `session.initialized`, `work.claimed`, `execution.started`, `execution.process_started`, `execution.usage`, `execution.process_ended`, `recovery.started`, `execution.completed`, `station.observed`, `review.round_started`, `review.decided`, and one each of `factory.activated`, `wave.discovered`, `intake.validated`, `slice.materialized`, `dependency.resolved`, `revision.discovered`, `work.scheduled`, `factory.paused`, `human.required`. `execution_id` set on 202 events (63 + 139), null on 20 (intake, groom). 19 `late` (17 gaps, 2 bounded usage), 8 backfill (section 6), `withheld` 267 fields in total.

**Missing because of D1:** `workflow.started/phases_declared/finished`, `agent.queued/started/progressed/finished`, `tool.called/returned`. In SHIM (same streams, version rewritten) the same execution yields them: 411 events, 13 agents for `x13e7…`, 25 for `x466…`.

## 4. Point 2 — station transitions in the browser

All **20 of 20** `station.entered`/`station.exited` events arrived through the page's EventSource (probe wrapped around `EventSource`, `<scratch>/logs/m1.probe.jsonl`, `m2.probe.jsonl`), each with its visit id: `groom#1`, `plan#1`, `build#1`, `verify#1..#5`, `review#1`, `build#2`, `review#2`, `human-approval#1` (e.g. `c:LOCAL-001:b2dcbc17:69` = `station.exited LOCAL-001/verify#5`, cursor `a51062426143469d.190`). 208 of 222 events came by stream; the other 14 by `/events` paging after the reopen and the observer restart. No id was delivered twice.

## 5. Points 3, 4, 5 — verification, review, rendering

### 5.1 Verification (point 3)

16 `verify.check_recorded`: 8 in `verify#3` (round 1) and 8 in `verify#5` (round 2), items AC-01, AC-02, AC-03, R1–R5, all `pass`, evidence `evidence/consumer-run.log` with sha256. Verdicts: `gate.evaluated verify.verdict pass (PASS)` and `station.exited verify PASS` twice; one `verify.finish refuse incomplete-evidence` (verify#2, execution 1). Inspector: "Verification passed 8 of 8" per round, matching the API (`checks` 16, 8 per visit). Visit verify#5: entered 23:01:07, left 23:02:09, "62 s, measured" = API 62,412 ms; outcome PASS.

### 5.2 Review and the human gate (point 4)

- `review#1` (round 1, High, 3 Opus seats, 3 approvals needed): architecture APPROVE, product APPROVE, security REJECT (1 blocker) → `REJECTED`, 2 of 3. Inspector gate: "Refused", "REJECTED: 2 approved, 3 needed", votes per seat with model, 11 findings listed by title and severity. API identical.
- `review#2` (round 2, delta): 3 APPROVE → `AWAITING_HUMAN`, `station.entered human-approval#1`, supervisor `human.required "waiting for human-approval"`; the belt's own result: `"outcome":"stopped","stage":"awaiting-human","waiting_for":"human-approval"`. Atlas: `Human approval gate, LOCAL-001: waiting for a person`; inspector "A person must approve before merge", no name anywhere.
- Deterministic run SA adds an approval, a merge and cleanup (`human.approval_recorded`, `merge.completed`, `cleanup.completed`, `run.recorded`); the cell shows "Merged … at 22:57:16" and "Review approved 3 of 3".

### 5.3 What the active view, timeline and inspector show vs the API (point 5)

Checked with `[data-stage-active]` scoping, accessible names and the inspector's ARIA tree (`<scratch>/tools/inspect.mjs`), both views, for the cell, a visit, gates, a seat, both executions, the human gate; agents and the workflow in SHIM.

| Entity | Shown | API | Match |
|---|---|---|---|
| Cell LOCAL-001 | Awaiting a person, round 2 of 3, risk High, suite green, at station Human approval | stage awaiting-human, round 2, risk High | yes |
| | Slice: (empty) | `slice_id` SLICE-001 | **no** (D5) |
| | App type: Not recorded | `""`; lifecycle has `library` | **no** (D11) |
| | Gates: "Red before green Passed" | `overridden` | **no** (D6) |
| | Stage history: 10 rows, times | lifecycle stage changes | yes |
| Visit verify#5 | PASS, 23:01:07–23:02:09, 62 s measured, round 2 | 1794524467314–1794524529726, 62,412 ms, round 2 | yes |
| Visit verify#2 | Working, still open, at work 11 min 49 s | no exit; superseded by verify#3 | **no** (D4) |
| Gate review#1 | Refused, 2 approved / 3 needed, decided 22:58:19 | REJECTED, 2, 3 | yes |
| Gate review#2 | Inspector "Passed"; Atlas "open, AWAITING_HUMAN" | AWAITING_HUMAN | views disagree (D10) |
| Seat security r1 | REJECT, Opus, 5 findings, voted 22:58:11 | REJECT, opus, blockers 1, notes 4 | yes |
| Execution x466… | completed; process 22:55:06–23:03:33 exited 0; $3.36 (recorded); Opus $2.52, Sonnet $0.82, Haiku $0.02 "recorded; never per agent" | `result.json` 506 s, exit 0; stream `total_cost_usd` 3.3611, `modelUsage` same | yes |
| | Agents "0" | not observable (D1) | **misleading** (D7) |
| Execution x13e7… | $1.68, process 22:45:29–22:53:10, outcome built, next verify | same | yes |
| Agent (SHIM) `LOCAL-001: build` | Finished; Sonnet; mach:builder; started 22:48:25; took 2 min 44 s (measured); 59,861 tokens; **45 tool calls, last tool Bash**; refused Bash ×2; "Individual tool calls are not observable for workflow agents"; Effort, Tier "Not recorded"; ticket/station "read from its label" | `tool_calls` 45, `last_tool` Bash, `tokens` 59861, `run.ms` 163,769, `refused` 2, inferred `label` | yes |
| | Blueprint span: "45 calls · last Bash · calls not observable for workflow agents"; tree item "45 tool calls counted, last tool Bash … Individual calls are not observable". A search of the timeline for tick elements found none, but that selector was guessed, so this one is checked by the accessible names, not proved | | yes (count only) |
| Workflow (SHIM) | belt, completed 22:53:01, declared phases (7), "a phase list is declared, not entered", 13 agents | `workflow.finished` completed | yes; Record region wrong (D23) |

Honest states seen: "Not recorded" for title, app type, effort, tier, observer lag; cost only per execution and per model; people by role ("approved by a person", supervisor, engineer); source badge "Live Factory" in every live state and "Historical replay" / "Simulation" when chosen; page title "Live Factory: eng · MACH Control Tower", "Historical replay: eng · …", "Simulation (not real execution) · …"; `data-simulation-stamp` count 0 in live and replay. Timeline (live A): tracks "Factory", "LOCAL-001: Awaiting a person", "SLICE-001: Dispatched" (the separate slice track is D5).

### 5.4 Latency, observer load (measured during the real run)

- **Append → browser paint** (20 ms independent tailer's first sight of the line → second animation frame after the SSE message), n = 123: **median 1,673 ms, p95 2,333 ms, max 2,534 ms**. Lifecycle lines measured from their own `at`: median 1,671, p95 2,087. Dominated by the observer's 1.5 s settle window (contract 6.5), as designed.
- **Observer, real run** (1 s `ps` samples, 1,054): CPU mean 0.2 %, p95 0.7 %, max 1.5 %; RSS 9.5–24.4 MB; 2.9 s CPU time over 18 min.
- **Observer, dense 12-cell fixture**: CPU max 5.7 %, mean 1.0 %; RSS ≤ 28 MB.
- **Wall time with and without the observer**: deterministic belt 30.4 s (SA, excluding a deliberate 6 s wait after starting the observer) vs 30.3 s (SB). The real runs diverged after verification for model reasons, so only stations are comparable: build#1 150 s (A) vs 120 s (B), first passing verify 63 s vs 58 s, review#1 90 s vs 114 s: model noise in both directions.

## 6. Point 6 — reconnection

- **Browser closed and reopened** (same cookie jar, `storageState`), mid-run, at `#blueprint?sel=cell%3ALOCAL-001`: title "Live Factory: eng", connection "Live", selection restored from the address, history to the live edge, 0 duplicate ids in the stream afterwards.
- **Observer frozen, killed and restarted mid-run** (`SIGSTOP` 50 s, then `SIGKILL`, then the same command 29 s later), with a page attached. Badge sequence recorded every 500 ms (`<scratch>/logs/m2.badge.jsonl`):

  | At | State | Label |
  |---|---|---|
  | before | live | "Connection: Live" |
  | stop + 30.7 s | stale | "Stale since 22:49:21" (the last confirmed moment) |
  | kill + 0.5 s | reconnecting | "Reconnecting" |
  | kill + 15.1 s | disconnected | "Disconnected, retrying" |
  | restart + 3.3 s | live | "Live" (a second EventSource) |

  Same port (57192), same session (requests 200 with the old cookie; no new link needed), the stream resumed after cursor `.37` with no repeated id; the 7 `build.task_completed` lines written while the observer was down arrived as backfill. The Factory was unaffected: build#1 continued and finished (lifecycle seq 13–20 written during the outage).

## 7. Point 7 — historical replay

On A (`<scratch>/tools/replay.mjs`): source menu → "Historical replay" in 79 ms; title and badge change; Home → 22:45:22.9 (`factory.activated`); 7 landmarks to the end.

| Cursor (landmark event) | UI (cell inspector) | `/api/v1/snapshot?at=` | Match |
|---|---|---|---|
| `.16` `execution.started` 22:45:29 | Spec ready, round "1 of 3", 3 artifacts | stage spec-ready, round null, artifacts recorded 3 (`reconstructed: true`) | stage and artifacts yes; round shown where the API has none |
| `.77` `execution.completed` 22:55:05 | Built, 1 of 3, 15 | built, 1, 15 | yes |
| `.209` `review.decided` 23:03:20 | Awaiting a person, 2 of 3, 31 | verified, 2, recorded 44 | stage differs only because the UI seeks to a millisecond and the `station.exited` at the same millisecond is included (pos 210); artifact count is a different definition (D13) |

Ingest while replaying: in a live store scrubbed back three landmarks on G12 while 2 new cells were appended: the playhead held at 23:02:32, "Received" went 1,145 → 1,236, the slider's maximum advanced, the drawn scene stayed at 13 cells; "Return to live" put the playhead at the live edge with 15 cells. Atlas → Blueprint 25 ms after a seek (small history), 2.07 s (230k history).

## 8. Point 8 — provenance and artifacts

Catalog for LOCAL-001 (13 entries; `artifacts?ticket=LOCAL-001`): every `sha256` equals the file on disk (13/13); `evidence/consumer-run.log` `integrity: match`, `verified_evidence: true`, 8 targets, round 2, commit `70c370b2b753`; previous-3's log round 1, commit `e1fa05019e3f`; review files round 1/2; **`visit` null on all 13** (D12). Content: text served as `text/plain`, `X-MACH-Redacted` counts, the 10 evidence/review files that contain this machine's home path on disk are served with 0 occurrences of it. Path-shaped requests (`..%2f`, `../`, `.env`, encoded `.factory/local`, `//etc/passwd`, `cells/..%2f..`): all **400**. "Go to event" from the visit's Record moved the playhead to 23:02:09.7 = `station.exited` 23:02:09.726; from the third evidence item to `gate.evaluated` (…:68) and marked it "Latest event behind what you see".

## 9. Point 9 — the observer changes nothing

- **Deterministic belt, SA (observer + browser) vs SB (none):** 61 steps each; exit code, normalised stdout, stderr and cell stage after every step **identical** (0 mismatches); the archived `lifecycle.jsonl` **identical** record for record (90 records: type, station, visit, round, execution id, data; commits normalised); `.factory/` file sets identical after normalisation (the only extra path is `.factory/local/observer/`).
- **Real runs A (observed) vs B (not):** same `.factory` layout (only `local/observer/` extra in A), lifecycle `seq` 1..n in both, the same record kinds, the same gate kinds and refusal codes, the same intake event sequence up to the point where A's second tick started another execution and B's was paused by me. Outcomes diverged because the verifier chose different commands (both were refused at times, D22); file names in `repo/` and `evidence/` differ as written by the models. Nothing points at the observer: it holds no lock and is read-only (README), and the deterministic comparison shows no effect.

## 10. Point 10 — disclosure

Canaries planted before the run: an environment variable on the supervisor tick (`MACHCANARY_ENV_…`), a `.env` with a fake token, `app/settings.py` with a fake `sk-ant-api03-…` key and an absolute path `/opt/machcanary-…/…pem`, a command in the README. Where they ended up: **none reached a file the observer reads** (the executor drops the variable: not in `PASSED_ENV`; workflow agents' tool calls are not in the stream; the others stayed in `repo/`). The sensitive data that did reach observer sources: this machine's user name and home path in **130 stream lines** and **10 evidence/review files**; two people's names in the intake log; session ids. So a second, adversarial stream was injected into the SHIM copy (a `Bash` tool_use with all canaries, its tool_result and `tool_use_result`, a `permission_denied` message, `permission_denials[].tool_input`, `result` text, `stderr.log`).

Searched: 39 needles (5 canaries, home, user name, project path, `/private/tmp`, `/Users/`, `/opt/`, `/var/folders`, the prompt, the belt script, argv flags, the allow-rule, the test command, `.claude/projects`, `transcriptDir`, `promptPreview`, `lastToolSummary`, `tool_input`, `credential_expires_at`, `rate_limit_info`, people's names and e-mails, session and workflow-run ids, cookie values) in every byte of: all `/api/v1` routes (events and history paged to the end, snapshot at head and 4 cursors, project, waves, slices, cells, every visit, evidence, runs, agents, tools, spans, artifacts and every artifact's content, analytics metrics and runs, a 4 s stream from the floor) and the observer's index files on disk; plus the rendered DOM (text and every attribute) in both views for 13 selections.

| Run | Routes | Bytes | Hits |
|---|---|---|---|
| A (real) | 70 | 1,850,399 | **0** sensitive (7 × the suite command `"[path] -m unittest discover -s tests"` inside served `results.json`/`summary.json`, the path scrubbed) |
| SHIM (real + adversarial stream) | 73 | 3,125,719 | **0** sensitive; the injected stream yields `tool.called {tool: Bash, target_class: other}`, `tool.refused {tool: Bash}` only |
| SA (deterministic) | 66 | 1,411,677 | **1 leak**: the approver's name in `review/round-3/decision.json` content (D2). Also served by design: verifier notes and finding prose in `results.json`/`findings.md` |
| DOM A / SHIM | 26 / 14 views | 7.4 MB / 5.4 MB | 0 / 0 |

## 11. Fixture-driven checks

| Check | Result |
|---|---|
| 12 concurrent cells, 3 waves, live, 495 lifecycle records over 75 s, plus a real 2.1.322 belt stream replayed into 3 executions at 50 lines/s each | Atlas peak per active view: 13 cells, 13 slices, 44 stations, 7 gates, 9 agents, 2 actors, ≤ 2,359 nodes; Blueprint: 12 wave refs, 39 cell refs, ≤ 1,216 nodes. Frame p95 ≤ 18.7 ms in both; Atlas 2 frames over 50 ms (max 68.6), Blueprint 0. Heap ≤ 22 MB. 1,145 events, 3 late. D15 seen here. |
| Large history | 210k generated lines → 230,853 events; observer catch-up 19.7 s, peak RSS 1.6 GB, index 300 MB (D18). Browser: 61 s to first render, heap 872 MB; live scrub (keyboard) median 150 ms, p95 334 ms; drag median 267 ms, p95 350 ms; to Blueprint 2.07 s, to Atlas 0.98 s; replay switch 3.3 s; replay scrub median 688 ms, p95 1,204 ms (D17) |
| Reduced motion | No CSS or Web Animations running in any state with or without `prefers-reduced-motion`; the Atlas's script-driven motion was **not measured** |
| Viewports 1440×900, 1512×982, 1728×1117 | No horizontal or vertical page overflow, no header or transport control outside the viewport, in live Atlas, live Blueprint, replay and Simulation (both views) |
| axe (WCAG 2.0/2.1/2.2 A and AA) | 0 violations in live Atlas, live Blueprint and replay at all three sizes; Simulation: 1 `target-size` at 1512 only (D19) |

## 12. Telemetry gaps seen in this real run

1. Workflow, agent and main-loop tool events: none (D1). With them (SHIM): agents with label, phase, model, state, times, tokens, tool-call count, last tool.
2. The verifier's and reviewers' refused commands: only `tool.refused {tool: Bash}`; why a station was stuck ("verify ran twice without moving") exists only in the stream's result text and `execution.completed.data.next`, which the views do not explain.
3. Visits that never exited (verify#1, #2, #4): no closing record by design; the scene does not use `unclosed_visit` (D4).
4. `execution_id` null on the groom visit and on intake events (dispatch opens the cell outside an execution).
5. Cell title (in `cell.json`) and app type (in the plan exit) not shown; agent effort and tier never recorded.
6. Evidence ↔ visit link missing in the catalog (D12).
7. No supervisor lease in `tick` mode: "No supervisor lease: no Factory Supervisor is running here" while executions were running.
8. Workflow `log()` lines, phase moments, per-agent cost, per-call tool activity: absent, as the contract says.

## 13. What could not be done

- Product Studio was driven through its script (`studio.py` via the repository's test helpers), not its visual app; the merge was done with `git`, as the helpers do.
- The real run stopped at the human gate (by design); approval, merge, cleanup and `run.recorded` were exercised only by the deterministic belt.
- Live agent rendering on the real run (D1); shown only after the fact on SHIM.
- Script-driven motion under reduced motion; `/api/v1/series` (not built).
- A strict wall-time comparison of the two real runs (they diverged).
- The cost of the two `factory enable` preflight probes is not recorded by MACH.

## 14. Files

Scripts: `<scratch>/tools/` (`setup_base.py`, `monitor.mjs`, `tailer.py`, `latency.py`, `leakscan.py`, `domscan.mjs`, `inspect.mjs`, `replay.mjs`, `gotoevent.mjs`, `liveback.mjs`, `timeline.mjs`, `scripted_belt.py`, `compare.py`, `gen_factory.py`, `g12.mjs`, `bigopen.mjs`, `a11y.mjs`). Results: `<scratch>/logs/`. Screenshots (taken only to judge a rendering): `<scratch>/shots/explore1.png`, `explore2.png`, `g12-atlas.png`, `g12-blueprint.png`, `timeline-A.png`, `timeline-SHIM.png`, and five `a11y-*-1440.png`. No capture or record script of the repository was run.

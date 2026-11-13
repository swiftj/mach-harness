# MACH Next — M6.1 station telemetry: the cell lifecycle log

Closes M6.0 gap G2 ("station transitions sampled, not recorded"), the station-visit part of G3 (identity) and the refused-gate part of G7. Read with `M6_0_TELEMETRY_GAPS.md` sections 4–5 and the record schema `schemas/cell-lifecycle.schema.json`.

## 1. What it is

Each station script appends one line to `.factory/worktrees/<ticket_id>/lifecycle.jsonl` (beside `cell.json`, never inside `repo/`) when it has decided something and recorded it in its own files. One shared helper writes every line: `skills/intent/scripts/lifecycle.py`, function `record(cell_dir, type, station, data, *, judging_round="auto", once=False)`.

The log is **authoritative for what it records, and observational in effect**: it never changes a station's result. The station files (`cell.json`, `build.json`, `build-report.json`, `evidence/`, `review/`) stay the source of truth. On any disagreement the station files win.

```json
{"v":1,"seq":31,"at":"2026-11-12T20:45:02.908Z","ticket_id":"LOCAL-001","type":"station.exited","station":"verify",
 "visit":"verify#1","round":1,"execution_id":null,"data":{"outcome":"FAIL_WITH_EVIDENCE","stage":"built","checks_passed":7,"checks_failed":1}}
```

| Field | Meaning |
|---|---|
| `v` | 1 |
| `seq` | Per file, from 1, increasing in file order. Allocated under a lock. `null` when the lock was not free within 0.2 s (section 4). |
| `at` | UTC, milliseconds, `Z`, taken when the line is written, just after the station's own write. |
| `ticket_id` | The cell folder's name. |
| `type` | `station.entered`, `station.exited`, `gate.evaluated`, `build.task_completed`, `verify.check_recorded`, `review.round_started`, `review.verdict_submitted`, `review.decided`, `human.approval_recorded`, `merge.completed`, `cleanup.completed`. |
| `station` | `groom`, `plan`, `audit`, `build`, `verify`, `review`, `human-approval`, `merge`, `cleanup`. |
| `visit` | `<station>#<n>`. `n` counts `station.entered` records for that station in this file. An `exited` record belongs to the latest visit. Any other record belongs to the open visit. When no visit is open, it belongs to the next one: a gate refused at the door is grouped with the visit it would have opened. |
| `round` | The judging round, 1..3, read from `build.json` (`loop + 1`; 1 before the build starts), for `build`, `verify`, `review` and `human-approval`. `null` elsewhere. Execution attempts are not recorded here: Factory events v2 use `attempt` for them. |
| `execution_id` | `MACH_EXECUTION_ID` from the environment if it matches `x` + 12 hex digits, else `null`. |
| `data` | Per type, below. Safe to show in a browser. |

### 1.1 Data per type

| Type | `data` |
|---|---|
| `station.entered` | `stage`, plus station facts (`tasks`, `revision`, `head` short commit, `items`, `round`, `previous_evidence`, `mode`). If the station's previous visit never exited, the helper adds `unclosed_visit: "<station>#<n>"`. It never invents the missing exit. |
| `station.exited` | `outcome` (`spec-ready`, `spec-open`, `planned`, `gold`/`silver`/`bronze`, `built`, `escalated`, `PASS`, `FAIL_WITH_EVIDENCE`, `APPROVED`, `AWAITING_HUMAN`, `REJECTED`, `ESCALATE`, `approved`, `merged`, `pr-open`, a merge refusal code, `abandoned`, `closed`), `stage`, counts. |
| `gate.evaluated` | `gate`, `outcome` (`pass` / `refuse` / `override`), `reason_code`, `overridden_by_reason`, plus `task`, `item` or `seat` where they apply. An override's reason text stays in `build.json`. |
| `build.task_completed` | `task`, `kind`, `step` (`red`/`green`/`done`, as `build.py` recorded it), `first_run` (`fail`/`pass`/`not-run`/null), `suite`, `commit` (12 hex). |
| `verify.check_recorded` | `item` (AC-NN, RN, H-…), `kind`, `result`, `evidence: [{path: "evidence/…", sha256}]`. |
| `review.round_started` | `round`, `max_rounds`, `risk`, `tuning`, `seats`, `models` per seat, `approvals_needed`, `human_approval_required`, `delta`. |
| `review.verdict_submitted` | `round`, `seat`, `vote`, `blockers`, `notes`, `rules`. Only the spec and matrix IDs found in the blockers' rule fields are kept. No finding text. |
| `review.decided` | `round`, `decision`, `approvals`, `needed`, `votes` per seat, `blockers`, `security_veto`, `human_approval_required`. |
| `human.approval_recorded` | `round`, `decision`, `note_given`. The approver's name is not recorded. |
| `merge.completed` | `method`, `approved_commit`, `landed_commit`, `merge_commit` (short), `revalidated`, `pull_request` (number or null). |
| `cleanup.completed` | `outcome` (`merged`/`abandoned`), `archive` (`.factory/archive/<id>.tar.gz`), `bundle`, `uncommitted_saved`. |

`lifecycle.safe()` enforces the boundary for every record. It keeps plain values only, with lower-snake keys, strings of at most 120 characters and no newline, and lists and objects at most 3 levels deep. A string that looks like an absolute path (`/`, `\`, `~`, `C:\`) is replaced with null. The tests check the whole history for absolute paths, the test folder's path, reviewer and verifier prose, the approver's name and forbidden keys (`command`, `prompt`, `note`, `detail`, `summary`, `title`, `by`, `env`, `output`, `findings` and others).

## 2. Design

- **One helper, every station.** `lifecycle.py` lives with the intent station, as `cell.py` and `validate_slice.py` do. The installer copies every skill folder (`bin/mach`), so the helper is present in plugin installs, script installs (`.claude/skills/mach-intent/scripts/`) and the Factory's generated plugin. Each other station loads it with a guarded import (`sys.path.append` of `../intent/scripts`, or `../mach-intent/scripts` in a script install). If the import fails, `lifecycle` is `None`, the station's `telemetry()` wrapper does nothing, and the station behaves exactly as before.
- **`record()` never raises.** Every exception, including one raised while building `data`, is swallowed. A process writes at most one line to stderr (`mach lifecycle: not recorded (<ExceptionType>)`). Call sites pass `data` as a lambda, so a payload built from station state is evaluated inside the guard. The helper never creates a cell. It writes only when `<cell>/cell.json` exists, the folder name is a valid ticket ID, the path has no `..`, its parent is `worktrees`, and the folder is not a symlink. The file is opened with `O_NOFOLLOW`.
- **After the station's write, never before.** Every call site comes after the station's own `write_text`, `save()` or `save_info()`. So the log can lack a fact the station recorded, but can never claim one the station did not record.
- **One line, one write.** The helper opens the file with `O_WRONLY|O_APPEND|O_CREAT`, takes `flock(LOCK_EX|LOCK_NB)`, polling for up to 0.2 s, and reads the file to find the last `seq` and the visits. It then makes one `os.write` of the whole line, calls `fsync`, and closes the file, which releases the lock. It makes no retries and holds no lock across station work.
- **Torn lines.** If the file does not end in `\n` (a writer was killed mid-line), the next record starts with `\n`. The torn fragment stays as an unreadable line, which readers skip (`lifecycle.parse`).
- **Execution identity.** `executor.wrapper` adds `MACH_EXECUTION_ID=<execution_id>` (`executor.EXECUTION_ENV`) to the run's minimal environment. This was checked, not assumed, with `claude` 2.1.322 using the executor's flags (`--restricted --strict-mcp-config --permission-mode default --permission-prompts none`, minimal environment). `printenv MACH_EXECUTION_ID` run by the Bash tool printed the ID. Run by a sub-agent's Bash tool (a stream line with `parent_tool_use_id` set), it printed the ID too. Belt workflow agents run in the same process. That they inherit it as well is an inference: they were not probed.

## 3. Call sites

| File: function | Trigger (after which write) | Records |
|---|---|---|
| `intent/cell.py: cmd_open` | new cell, after `write_cell` | `station.entered groom` |
| `intent/cell.py: cmd_open` | existing cell in `interview`/`spec-open` (resume) | `station.entered groom`, `once` (none if a groom visit is open) |
| `intent/cell.py: cmd_finalize` | errors (nothing written) | `gate.evaluated groom.finalize refuse spec-invalid` |
| `intent/cell.py: cmd_finalize` | open questions, after `write_cell` | `gate.evaluated … refuse open-questions`, `station.exited groom spec-open` |
| `intent/cell.py: cmd_finalize` | ready, after `spec.json` and `write_cell` | `gate.evaluated … pass`, `station.exited groom spec-ready` |
| `intent/cell.py: cmd_check_plan` | stage `spec-ready`/`planned`, before checking | `station.entered plan`, `once` |
| `intent/cell.py: cmd_check_plan` | problems / after `write_cell` | `gate.evaluated plan.check refuse plan-invalid` / `pass` + `station.exited plan planned` |
| `intent/cell.py: main` | `CellError` in `finalize` / `check-plan` | `gate.evaluated groom.finalize` / `plan.check refuse` |
| `audit/audit.py: report_to_cells` (from `cmd_run`) | after `audit-report.json`, for each cell in stage `planned` | `station.entered audit`, `gate.evaluated audit.readiness pass/refuse <tier>`, `station.exited audit <tier>` |
| `build/build.py: cmd_start` | after `build.json` and `cell.json` | `gate.evaluated build.start pass`, overrides (`no-baseline`), `station.entered build` |
| `build/build.py: complete` / `cmd_red --written-early` / `cmd_green --already-done` | after `build.json` (commit made, or none for the two flags) | overrides for that task (`Cell.report_overrides`; `--already-done` is `gate.evaluated changed-no-files override impl-already-done`), `build.task_completed` |
| `build/build.py: cmd_finish` | problems, after `build.json` | `gate.evaluated build.finish refuse not-finished` |
| `build/build.py: cmd_finish` | after `build-report.json`, `build.json`, `cell.json` | `gate.evaluated build.finish pass`, `station.exited build built` |
| `build/build.py: cmd_revise` | round limit, after `cell.json` (blocked) | `gate.evaluated round-limit refuse`, `station.entered build`, `station.exited build escalated` |
| `build/build.py: cmd_revise` | after `build.json`, `cell.json` | `station.entered build` (new visit, next round) |
| `build/build.py: main` | `BuildError` in an acting command (not `next`/`status`) | `gate.evaluated build.<command> refuse <code>`; every `BuildError` names its own code (such as `changed-no-files`, `already-started`, `task-already-done`, `wrong-step`, `already-done-not-covered`), never the generic `refused` |
| `verify/verify.py: cmd_start` | after `results.json` | `gate.evaluated verify.start pass`, `station.entered verify` |
| `verify/verify.py: cmd_record` | after `results.json` | `verify.check_recorded` |
| `verify/verify.py: cmd_finish` | incomplete (nothing written) | `gate.evaluated verify.finish refuse incomplete-evidence` |
| `verify/verify.py: cmd_finish` | after `summary.json`, `cell.json` | `gate.evaluated verify.verdict pass/refuse`, `station.exited verify PASS/FAIL_WITH_EVIDENCE` |
| `verify/verify.py: main` | `VerifyError` (not `status`) | `gate.evaluated verify.<command> refuse <code>` |
| `review/review.py: cmd_start` | after `packet.json` | `gate.evaluated review.start pass`, `station.entered review`, `review.round_started` |
| `review/review.py: cmd_submit` | after `votes/<seat>.json` | `review.verdict_submitted` |
| `review/review.py: cmd_tally` | after both `decision.json` files and `cell.json` | `review.decided`, `station.exited review <outcome>`, and on `AWAITING_HUMAN` `station.entered human-approval` |
| `review/review.py: cmd_approve_human` | after `decision.json`, `cell.json` | `human.approval_recorded`, `station.exited human-approval approved` |
| `review/review.py: main` | `ReviewError` (not `status`) | `gate.evaluated review.<command> refuse <code>` (station `human-approval` for `approve-human`) |
| `merge/merge.py: cmd_run` | survey allowed | `gate.evaluated merge.run pass`, `station.entered merge` |
| `merge/merge.py: cmd_run` | `MergeError` after entry (`revalidation-conflict`, `sent-back`, `merge-failed`, push or PR failure) | `gate.evaluated merge.land refuse <code>`, `station.exited merge <code>` |
| `merge/merge.py: land` | merged, after `cell.json` | `merge.completed`, `station.exited merge merged` |
| `merge/merge.py: land` | PR left open | `station.exited merge pr-open` |
| `merge/merge.py: main` | refusal before entry (`approval-void` after `void_approval` wrote, `merge-refused`) | `gate.evaluated merge.run refuse <code>` |
| `cleanup/cleanup.py: cmd_run` | gates passed, before archiving | builds the archived log (section 5) |
| `cleanup/cleanup.py: main` | `CleanupError` in `run` | `gate.evaluated cleanup.run refuse cleanup-refused/archive-failed/refused` (in the live cell, if it still exists) |
| `run/executor.py: wrapper` | before starting `claude -p` | sets `MACH_EXECUTION_ID` (not a record) |

`run.py` records nothing. Every belt step has a station script of its own, and `run.py review-start`/`review-tally` call `review.py`, which records.

## 4. Guarantees and non-guarantees

**Guaranteed**

- A telemetry failure changes no exit code, no stdout and no station file. Tested with a directory in place of the log, a full disk (`_write_all` raising `ENOSPC`) and a read-only cell folder. The first two run a whole build, verify and review flow and compare every step's exit code and normalised output with a run where telemetry works.
- Every line is one whole JSON object, or a torn fragment left by a killed writer. The next record always starts on a new line.
- With the lock taken, `seq` is unique and increasing in file order across processes. Tested with two processes appending 150 records each.
- Nothing in the log claims a fact the station files do not hold.

**Not guaranteed (what can be missing, and when)**

- **A lost write leaves no gap in `seq`.** If a record is not written (telemetry failure, or the process dies between the station's write and the log's), the next record takes the next number. Readers must not treat seq continuity as proof of completeness. To check completeness, they compare against `cell.json` and the station files, which win. Tested: a build killed after `cell.json` says `built` has no `station.exited build`, and the next record is the following `verify#1` entry.
- **`seq` may be `null`** when the lock was not free within 0.2 s, or when `fcntl` is not available. Readers order records by line position, never by `seq`.
- `at` is the time of the log write, a few milliseconds after the station's write. It is wall clock, so records from different cells are ordered only approximately.
- A restarted station (`verify start` or `review start` run again before its exit) opens a new visit with `unclosed_visit` set. The earlier visit gets no exit record.
- A gate refused when no visit is open belongs to the next visit number, which may never be entered (for example `build#3` for a refusal after the cell is built).
- The plan visit opens at the first `check-plan`, not when the contract engineer starts writing. The groom visit opens at `cell.py open`. A `finalize` without a preceding `open` exits the latest groom visit again.
- The audit is repository-wide. It is recorded only in cells in stage `planned` when `audit.py run` writes the report. `audit.py gate` records nothing. The per-ticket audit check is part of `build.start`'s gate (`audit-missing`, `audit-stale`, `audit-bronze`).
- Most refusal reason codes are set at the main gates. Other refusals carry `refused`, or a coarse code (`merge-refused`, `cleanup-refused`). The station's message is not copied.
- **Cleanup.** The cell folder is deleted, so cleanup's own records (`gate.evaluated`, `station.entered`, `cleanup.completed`, `station.exited`) are written only into the **archived copy** of the log. Any visit still open is exited first, with outcome `abandoned` (for `--abandon`) or `closed`. `lifecycle.closing()` builds these bytes; the live file is never changed. If archiving fails, nothing claims cleanup completed, and the refusal goes into the live log. If archiving succeeds but removing the worktree or folder then fails, the archive says `cleanup.completed` while the cell remains. A later run makes `<id>-2.tar.gz` with a second cleanup visit. `runs.jsonl` carries the rest of the run's facts, as before. A cell with no `lifecycle.jsonl` (made before M6.1 or by hand) is archived exactly as before, with no log added.
- `execution_id` is null for work a person drives, for a belt started by hand, and, if it were ever started outside the executor, for a Workflow agent. The ID in a record shows only that the process carried the variable.

## 5. Replay

Live: read `lifecycle.jsonl` with `lifecycle.read(cell_dir)`, which returns the records in file order and skips malformed lines. After cleanup: `tar -xzf .factory/archive/<id>.tar.gz <id>/lifecycle.jsonl`. The archived file starts with the exact bytes of the live file, followed by cleanup's records (tested). The archive keeps it with the rest of the cell, and `runs.jsonl` still holds one line per finished ticket.

## 6. What a station does that is not recorded

- `cell.py`: `next-id`, `validate` (including its write of `spec_path`), `status`, `ticket-new`, `ticket-note`, every git commit of the spec and contracts, `ensure_ignored`, a mode change on reopen.
- `audit.py`: every check and score detail, `--fix` writing `.gitignore`, `gate`.
- `build.py`: `next` and `status`, `add-task` (the task appears in `build.task_completed` when done), every test and lint run and its output, the baseline run, `ensure_isolated` creating a worktree late, `sync_with_main` (only `synced_with_main: true|false` on entry), commit messages and changed file lists, styling findings, `tick_plan`, override reasons.
- `verify.py`: `status`, the suite rerun and contract check output (only `suite_passed` and `contracts_valid` on entry), moving earlier evidence to `previous-N` (only its name on entry), notes, evidence sizes, holdout file contents, the incomplete list (only counts and unproven IDs).
- `review.py`: `status`, the packet's paths, diffs and `delta.patch`, finding titles, details, files and lines, non-ID rule text, `findings.md`, stale votes deleted when a round restarts (visible only as `unclosed_visit`), the approver's name and note.
- `merge.py`: `plan` and `status`, survey details, revalidation's merge of main and its suite output, `merge-findings.md`, pushes, PR creation and its URL, `gh` and `git fetch` calls, `void_approval`'s file changes (only the refusal code `approval-void`).
- `cleanup.py`: `plan`, `orphans`, `status`, archive members, bundle and patch contents, worktree, folder and branch removal (after the archive is written), the run record.
- `run.py`, `supervisor.py`, `intake.py`: nothing new. Their events stay in `.factory/intake/events.jsonl`.

## 7. Files

- `skills/intent/scripts/lifecycle.py`: the helper (`record`, `closing`, `read`, `parse`, `safe`, `short`, `rule_ids`).
- Station call sites: `skills/intent/scripts/cell.py`, `skills/audit/scripts/audit.py`, `skills/build/scripts/build.py`, `skills/verify/scripts/verify.py`, `skills/review/scripts/review.py`, `skills/merge/scripts/merge.py`, `skills/cleanup/scripts/cleanup.py`. Each station's error class gained an optional `code`. Its message, its exit code and every gate decision are unchanged.
- `skills/run/scripts/executor.py`: `EXECUTION_ENV`, set in `wrapper`.
- `docs/mach-next/schemas/cell-lifecycle.schema.json`.
- Tests: `tests/test_lifecycle.py` (new). Existing tests changed: `tests/test_cleanup.py` (`test_cell_without_a_worktree` now expects the archived lifecycle log its earlier refusal produced), `tests/test_installer.py` (expects `lifecycle.py`), `tests/test_mach_factory_supervisor.py` (allows `MACH_EXECUTION_ID` in the run's environment and checks it equals the execution's ID).

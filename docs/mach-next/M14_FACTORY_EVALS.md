# M14 part B: Factory evals (as built)

Design: `docs/mach-next/M14_DESIGN.md`, part B. Code: `skills/observe/scripts/evals.py`, reached as `run.py eval ...` and routed by
the run skill as `/mach eval ...`. Tests: `tests/test_factory_evals.py`.

**No real model run was made.** Every test replaces Claude Code with a stand-in program on the PATH, as the supervisor's
tests do. No real `claude`, Factory, supervisor or model execution was started while building or testing this. What a first
real run should check is at the end.

## What was built

| Command | What it does |
|---|---|
| `eval collect [--ticket T]...` | One case per merged ticket in `.factory/archive/runs.jsonl` that has none yet, read from its archive. |
| `eval add --from-ticket T --reason WHY [--must-pass]` | An escaped defect: the ticket's case (made if missing), kind `escaped-defect`, the reason kept as a holdout check. |
| `eval add --spec FILE --base COMMIT --reason WHY [--intent FILE] [--title T] [--must-pass]` | A case written by hand. |
| `eval add --case C --must-pass \| --no-must-pass` | A person's mark on an existing case. |
| `eval status [--ticket T]` | Cases, collectable tickets, the configuration's digest, the last run, what changed since it, whether a planned run waits. |
| `eval run --plan --budget USD [--cases C...] [--limit n] [--ticket T] [--max-minutes M]` | What would run, the ceiling, the boundary and the execution risk; a confirmation code. Spends nothing. |
| `eval run --confirm CODE --accept-execution-risk [--keep]` | Runs exactly the plan the code names. |
| `eval compare RUN RUN` | Deterministic comparison, also written to `.factory/evals/runs/compare-<a>-<b>.json`. |
| `eval show CASE\|RUN\|compare-A-B` | One record. |

### The case format (schema 1)

`.factory/evals/cases/<case-id>/` holds `case.json` and the case's text files:

- `spec.md`: the archived cell's `spec.md`, redacted. `spec.json`: the archived `spec.json` (the spec as data, every matrix rule
  expanded), each string redacted. `intent.md`: the archived intent, redacted and bounded. `holdout.md` for an escaped defect.
- `case.json`:

```json
{"schema": 1, "case_id": "LOCAL-004", "kind": "archive | escaped-defect | by-hand",
 "source": {"ticket_id", "archive", "archive_sha256", "slice_id"},
 "title", "risk", "app_type",
 "base_commit": "<sha> or null", "base_commit_from": "<how it was found, in words>",
 "spec": {"file": "spec.md", "name": "SLICE-004-name.md", "sha256", "data": "spec.json or null"},
 "intent": "intent.md or null", "holdout": "holdout.md or null",
 "recorded": {"outcome", "verdict", "rounds", "first_pass", "verify_failures", "review_rejections",
              "deviations": [{"type", "task"}], "tests": {"files", "names"}},
 "must_pass": false, "reason": "<a person's words, redacted> or null",
 "redaction": {"rules", "changed_something"}, "collected_at"}
```

A value that was not recorded is `null`, never zero. Deviations keep their type and task only, never the builder's prose.
Test names come from `build.json` (each task's `tests_first_run`), test files from `build-report.json`.

**What is read from an archive.** Only `cell.json`, `spec.md`, `spec.json`, `intent.md`, `build.json`, `build-report.json` and
`evidence/summary.json`, each at most 2 MB, read straight from the tar file with `extractfile` (nothing is extracted to disk).
Evidence media, `branch.bundle`, `replans.bundle`, `uncommitted.patch` and `untracked/` are never opened. A spec over 256 KB is
not kept.

**Redaction.** The ticket station's shared `issue_rules.redact` (loaded from its folder, never copied), as Product Studio's
requests and telemetry use it. `redaction.changed_something` says whether it changed anything; the spec's SHA-256 in the case
is of the redacted text that will be replayed.

**The base commit.** With a merge commit (two parents): the merge-base of the cell's `spec_commit` and the merge's first parent,
which is where the branch left the default branch even when main moved on before the merge. Otherwise (squash, rebase or
fast-forward): the spec commit's parent. Anything else is `null`, and the case is listed as not runnable. Choice: the
fallback is right for a spec committed once at the start of the branch, which is how the intent station works; for a
squashed ticket whose spec was finalized twice it starts from the earlier spec commit, still on the branch (a known
limit, said here rather than guessed around). The nearest existing data was
`cell.json` (`spec_commit`) and the run record's `integration`; neither stored the fork point, so nothing was added to
the cleanup or intent stations.

**Shareable or ignored.** Cases are shareable (`.factory/evals/cases/` is not git-ignored): a suite is only useful if the team
keeps one, a person marks `must_pass` as a team decision, and a case holds nothing that the merged spec in `specs/slices/` did
not already put in the repository, redacted. Runs, comparisons and the pending plan (`.factory/evals/runs/`) are git-ignored:
they are one machine's results, with times and costs. Writing a case changes the main checkout's working tree, like an ADR
draft; the person commits it.

### Status

The **configuration under test** is the rule files (`CLAUDE.md`, `REVIEW.md`, `AGENTS.md`), MACH's line (each skill, agent and
workflow, by `provenance.line`, M6.5) and the model tiers in `.factory/config.json` (as `provenance.config` records them). Its
`digest` is SHA-256 of the canonical JSON of {rule digests, line digest, model tiers}. For a script install the line is
measured on the plugin `executor.project_files` builds from `.claude/`; for a plugin install, on the plugin folder.
It comes from the main checkout's working tree (uncommitted edits count), or with `--ticket T` from that cell's branch head;
a file the branch does not track (often `.factory/config.json`, which a test project ignores) comes from the working tree,
and is listed under `source.from_checkout`.

`status` compares it with the last ended run's configuration: `changed_since_last_run` lists rule files, skills, agents,
workflows and model tiers whose digests differ; `evaluated` is true only when the digests are equal.

### A run

`--plan` refuses without `--budget`, refuses when the budget gives less than 1 US dollar per case, orders `must_pass` cases
first then by case ID, takes `--limit` from that order, and writes `.factory/evals/runs/pending.json` (code, expiry in 10
minutes, the plan). The plan shows `will_run`, `not_runnable`, `per_case_usd` (the budget divided equally, at most 500, the
supervisor's own per-execution maximum), `ceiling_usd`, `time_ceiling_minutes`, `boundary`, `confinement` and
`execution_risk` (from `policy.execution_risk`, the same statement `factory enable` shows).

`--confirm CODE --accept-execution-risk`: the code is checked and used once; the configuration is measured again and must
have the plan's digest; the tool list must still be the plan's; Claude Code's `--help` must offer every flag the boundary
needs (`policy.missing_flags`); one run at a time per project (`.factory/evals/runs/.running`). Then each case in turn:

1. **Clone.** `tempfile.mkdtemp(prefix="mach-eval-")`, refused if it is inside the project or the project inside it. `git init`,
   one `git fetch` from the project's path of `refs/heads/*` and `refs/remotes/*` into private refs (no remote is ever
   configured), then `git config protocol.allow never`, a checkout of the base commit on a branch named like the project's
   current one, the private refs deleted, and a check that `git remote` is empty. A local identity (`MACH eval`) and
   `commit.gpgsign false` are set in the clone only.
2. **Overlay.** The configuration under test is written over the base commit: the rule files (one absent from the
   configuration is removed), MACH's files under `.claude/` for a script install, and `.factory/config.json` with the eval's
   fixed settings on top (`eval_settings`): tickets on the local Markdown queue (any tracker commands and GitHub section
   dropped), `merge.mode: manual` with every tier off, `factory.supervisor`, `notifications` and `monitoring_requests` false,
   `records.publish_command` removed. Model tiers, review, build and audit settings are untouched. What is not ignored by the
   clone's `.gitignore` is committed as one commit, "MACH eval: the configuration under test".
3. **Seed.** Through the stations' own scripts, with the eval's environment minus `MACH_EXECUTION_ID`: `ticket.py --provider
   local create` (label `eval-replay`), the escaped defect's `holdout.md` copied to `.factory/holdouts/<ticket>/escaped-defect.md`
   (the verifier carries it out; the builder never sees it), `cell.py open --headless`, the spec into the cell's
   `specs/slices/`, the intent into `intent.md`, then `cell.py finalize`. A spec today's gates refuse is recorded as the
   case's outcome (`not_run` with the gate's words, `planned: false`), and no execution starts.
4. **Scope.** The clone's own `.factory/intake/ledger.json` records the execution ID and its one ticket, exactly as the
   supervisor records an execution, so inside the replay `run.py` scopes itself to that ticket: no other ticket, `status`
   reports no observe pass and no tuning ticket, and every person-only command (including `eval`) is refused.
5. **Execute.** `executor.plugin(clone, run_script)`, `executor.command(...)` with the belt workflow, the one ticket and
   `until: "review"`, `policy.default_tools()`, the case's spending limit (the share, cut to what the budget has left) and a new
   session ID; `executor.prepare`, then `executor.wrapper` run in the eval's own process (signal handlers saved and restored),
   then `executor.outcome`. A command containing `dangerously`, `bypassPermissions` or `acceptEdits` is refused before it starts.
6. **Read.** From the clone's cell: `planned` (a `plan.md` and a stage at or past `planned`), `built` (`build-report.json`
   status BUILT), `verdict` (`evidence/summary.json`), `rounds` (`review_loop` + 1), `deviations` (count and types), `stage`;
   from the execution: `how` it ended, `seconds`, the recorded `cost_usd` and any refused tools. The provenance snapshot
   (`provenance.capture`, M6.5) of the first executed case is the run's.
7. **Remove.** The clone's folder is removed (only a folder named `mach-eval-*` under the system's temporary folder), unless
   `--keep`, which lists it.

`run.json` is written after each case. A case's recorded cost counts against the budget; an unrecorded cost counts as its
whole limit; when less than 1 US dollar is left, the remaining cases are recorded `not_run: "the run's budget was spent"`.

### Compare

`comparison(before, after)` is a pure function: the same two runs give the same JSON. Per case one outcome word
(`outcome_of`): `passed` only for a recorded `PASS` verdict; otherwise `verification failed`, `evidence incomplete`,
`built, not verified`, `planned, not built`, `not planned`, `not run`, or `not recorded`. It reports both runs' totals
(passed, of, rate, recorded cost and the cases without one, recorded time and the cases without one), `changed_outcome`,
`now_passing`, `no_longer_passing`, `must_pass_not_passing` (as marked when the later run was made), cases only in one run,
and both configuration digests with what differs.

### The tuning ticket's review packet

`review.py start`, for a ticket labelled `factory-tuning` only, adds `packet["evals"] = eval_comparison(...)`, which loads
`evals.py` from the observe skill's folder and calls `packet_entry(project, ticket, head)`. It finds the ended runs whose
configuration came from that ticket's branch at exactly the commit under review, then the latest comparison whose later run is
one of them. It returns `{"evaluated": true, ...}` with the comparison's totals, changed outcomes, cases no longer passing and
`must_pass` cases not passing (each bounded to 50), or `{"evaluated": false, "note": "not evaluated", "why": ...}`. It never
raises: unreadable records read as "not evaluated". No threshold is enforced; the reviewer brief's tuning section says it is
evidence to weigh, and that "not evaluated" is not a blocker by itself.

## Choices and departures

- **Executor reused, not a separate runner.** Reading `executor.py` showed that `command`, `boundary_flags`, `environment`,
  `plugin`, `prepare`, `wrapper` and `outcome` take everything as arguments and never read `.factory/local/runner.json`; only
  the supervisor joins them to the machine's policy. So the eval calls them directly with its own settings: the default tool
  list (`policy.default_tools()`, never a machine's extra tools), the boundary flags unchanged, a per-case spending limit and a
  per-case time limit inside the supervisor's own bounds. This is at least as strict as a supervised execution, which may have
  extra tools a person added. No bypass flag exists anywhere in the path.
- **A confirmation code anyway.** Because a replay starts model executions with no operating-system sandbox, `--plan` gives a
  code and `--confirm CODE --accept-execution-risk` runs, in the style of `factory enable`. The design's `--plan` is the first
  step; `eval run` without `--plan` or `--confirm` is refused with the way to begin.
- **Synchronous.** `--confirm` runs the cases one after another in the person's command (the run skill runs it in the
  background). Nothing outlives the command except, if the eval process itself is killed with SIGKILL, a Claude Code child
  until its own time limit; SIGTERM and SIGINT end it through the executor's wrapper.
- **One execution per case**, the belt stopped before review, as the design says (planning through verification).
- **`--ticket`** names the change under test for a factory-tuning ticket, and is what makes the packet's "exactly that change"
  exact: the run's `configuration.source` records the ticket and the branch head.
- **No new settings.** Nothing was added to `templates/config.json`: budgets and limits are given per run by a person, and the
  bounds are the supervisor's.
- **Plugin installs.** The skills, agents and workflow under test are those of the installed plugin; the rule files and model
  tiers come from the configuration's source. A tuning change to a plugin's own skill files is therefore evaluated by running
  the plugin from that checkout, as MACH's own development does.

## How a run is confined (safety analysis)

| Risk | What stops it |
|---|---|
| Started by the line | Only `run.py eval` reaches it; no station, agent, workflow, hook, timer or the supervisor names it (`NothingElseStartsItTest`). `collect`, `add` and `run` refuse whenever `MACH_EXECUTION_ID` is set, so a supervised execution or a replay cannot start one. |
| Started without consent | `--plan` spends nothing; `--confirm` needs the code (single use, 10 minutes), `--accept-execution-risk`, and the same configuration digest and tool list as the plan. |
| Widened by the machine's grant | `runner.json` is never read (`policy.read` is never called; a test fails if it is); the tool list is `policy.default_tools()`. Nothing is enabled. |
| Permissions bypassed | The executor's own command: `--restricted`, `--strict-mcp-config`, `--permission-mode default`, `--permission-prompts none`, `--tools` limited to the list; a bypass word in the command refuses the case. |
| Runs on the real checkout | Every case is a new folder under the system's temporary folder, checked to be outside the project; the stations are given `--project <clone>`; the execution's working folder is the clone. The test checks the project's status, HEAD, refs and remotes are unchanged. |
| Pushes or fetches | No remote is configured; `protocol.allow never` after the one fetch (the test's stand-in tries `git push` to the project and fails). |
| Touches GitHub | Tickets on the local queue, tracker commands dropped from the clone's settings, no remote; `gh` is not in the tool list. Residual: `Bash(python3 *)` can run any program as the user, including `gh` with the person's own login; this is the same no-sandbox risk `factory enable` states, and the plan shows it word for word. |
| Reviews or merges | The belt is told `until: "review"`; the clone's merge mode is manual; nothing here calls the review or merge station. |
| Spends past the budget | A spending limit per execution; recorded cost (or the whole limit when unrecorded) counted against the budget; one run at a time. |
| Leaves files behind | The clone is removed after each case unless `--keep`; only `mach-eval-*` folders under the temporary folder are ever removed. |
| Leaks text | Cases are redacted with the shared rules, keep no evidence media and no builder or reviewer prose; runs keep identifiers, numbers and outcome words only (no stream). |

Residual risk, stated plainly: a replay is an unattended model execution on this machine with the person's own Claude Code
login and home folder, as a supervised execution is. The tool list, not an operating-system sandbox, is what bounds it.

## Shared-file blocks (exact)

- `skills/run/scripts/run.py`: three lines in the module docstring (`run.py eval collect|add|status|run|compare|show` and two
  lines under it); one block `# ---- M14 Factory evals ... ----` to `# ---- end of M14 Factory evals ----` before
  `cmd_requests`, holding `cmd_eval` and `eval_parser`; and one line `eval_parser(sub)  # M14 Factory evals` after the release
  parsers in `build_parser`.
- `skills/review/scripts/review.py`: in `cmd_start`, two lines after `cell.packet["tuning"] = tuning`
  (`if tuning: cell.packet["evals"] = eval_comparison(...)`); one function `eval_comparison` before `adr_refusals`.
- `skills/review/references/reviewer-brief.md`: one bullet at the end of "Tuning tickets" about the packet's `evals`.
- `skills/run/SKILL.md`: one sentence at the end of `description`; `eval [...]` in `argument-hint` before `factory`; a section
  "### Factory evals" before "### The Factory on this machine".
- `templates/gitignore-block`: two lines after `.factory/intake/` (a comment and `.factory/evals/runs/`).
- `CLAUDE.md`: one line in the project tree (`evals/`), one bullet under the observe station, one sentence on the Factory
  tuning threshold, and a section "### Factory evals (`/mach eval`)" before the merge station.
- `observe.py`, `templates/config.json`, `web/` and `apps/` are not changed.

## Not built

- No threshold or gate on a tuning ticket (the design says so for this milestone).
- No scheduled or automatic run, and no run on another machine's or a cloud sandbox.
- No parallel cases: one at a time keeps the budget and the clean-up simple.
- No copy of the replay's stream or evidence: a run keeps facts only. `--keep` is the way to look at a replay.
- A case is not refreshed when its archive changes; collect skips a ticket that already has a case.
- The Factory Floor does not show eval runs.

## How far it is tested

`tests/test_factory_evals.py` (unittest, a stand-in `claude`): collect (merged only, redaction, no media, the base commit
for a merge commit and for a squash, the recorded outcome, idempotent), escaped defects and the holdout, cases by hand,
`must_pass` marks, refusals inside an execution, status digests and what changed (a rule file and a model tier) and the
line digest's agreement with `provenance.line`, the plan (budget, per-case floor, boundary, spends nothing, checkout
untouched), the confirmation (risk, code, used once, configuration changed, an old Claude Code), a confined run (where it
ran, no remote, a push that fails, no credential in the environment, the exact boundary flags and tools, the spending
limit, `until: review`, the clone removed, the checkout untouched, the machine's authorization not read), the overlay on the
base commit and the clone's settings (with `--keep`), a spec today's gate refuses, the budget stopping a run, an unrecorded
cost, one run at a time, compare (deterministic, missing values, `must_pass`), and the packet entry for exactly that change.
Existing suites for run, review, observe and the unattended commands pass unchanged.

**Not verified:** any real Claude Code, model or belt workflow. A first real run should be made in a throwaway project, not a
team's repository, with a small budget (one or two cases), and should check:

1. `eval run --plan` shows the tool list and risk as expected, and the code works once.
2. The replay's Claude Code starts in the clone (its working folder under the temporary folder), loads only MACH's plugin, and
   refuses tools outside the list (look for refused tools in `run.json`).
3. The belt stops before review: the clone's cell ends at `verified` or earlier, never `approved` or `merged`.
4. `run.py next` inside the replay is scoped to the one ticket (the belt's Learn phase reports no observe pass).
5. The audit runs in the clone, and the ADR baseline gate behaves at the base commit as it did then.
6. The recorded cost matches what the account shows, and the spending limit holds.
7. The clone is removed, nothing was pushed, and the project's checkout and GitHub are untouched.
8. `eval compare` of two runs under the same configuration, to see how much outcomes vary from run to run before trusting a
   difference.

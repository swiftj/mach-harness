# M22 design: building one plan in lanes

Status: built. The body below is the design as written; several decisions changed afterwards. What MACH does now is in "As built" at the end, which wins where the two differ.

The build station works through a plan's tasks one after another (`build.py` `take`, `skills/build/scripts/build.py:666-678`: "Tasks are done in plan order"). The owner's slices have close to 30 tasks, and a build is slow. They want the station to work on several tasks at once. They have heard, and set aside, thinner slices and faster test runs. This document designs that fan-out.

In short:

- A script splits the plan into **lanes**: chains of tasks that share no file and no requirement, and do not depend on each other. Each lane runs in its own Git worktree, on its own branch, with its own builder and its own state file, under the same gates as today.
- The **driver** fans out: the belt workflow (and with it the unattended supervisor) and the run skill in a conversation, told what to start by a script, the way they already seat a review panel. Not the builder.
- When every lane is done, the station **joins** them: it lands their commits on the ticket's branch one per task, in plan order, runs the whole suite on the result, and records everything for the reviewers. Nothing about verification or review changes.
- It is off by default (`build.max_lanes: 1`). At 1, the station behaves byte for byte as it does today.
- The honest expectation: **plans written today are almost all one lane**, so the feature gains nothing until the contract engineer plans for independence. Where a slice really has separate parts, the worked examples give a 30-task build between 1.1 and 2.2 times faster, the low end when the test suite already keeps every core busy. Section 11.2 has the arithmetic.
- The first thing to build is the measurement (section 12): a read-only lane calculator run over the owner's past plans and build reports. It costs little, risks nothing, and says whether the rest is worth building.

All line numbers are as of branch `feature/parallel-build` at `9f2c4dc`.

## 1. How a build works today

What the design has to keep, read from the code.

- **One checkout, one state file.** A cell's work happens in `.factory/worktrees/<ticket>/repo` (`build.py:213-214`); its state is one file, `build.json`, rewritten whole on every save (`build.py:209, 224-226`). `tick_plan` rewrites `plan.md` on every completed task (`build.py:303-309`).
- **Order.** `take` refuses any task but the first one not done (`build.py:673-675`) and the wrong step for its kind (`build.py:676-677`).
- **The plan's grammar.** A task is `- [ ] T02 [impl] <what> — `file`, `file` (FR-01, ...)`; kinds are `test`, `impl`, `contract`, `refactor`, `docs` (`build.py:56, 64`). A task's files are the backticked paths after its last em dash plus every touch-map row that names it (`build.py:264-268, 296-299`). The plan has no way to say that one task depends on another, other than order. There is one parser: `cell.py` and `schedule.py` load `build.py`'s `parse_plan` rather than copy it (`skills/intent/scripts/cell.py:1390-1404`, `skills/run/scripts/schedule.py:198-228`).
- **Red.** A `[test]` task must be seen failing. Where a single test file can be run on its own (checked once at the start, `build.py:442-480`), only the new tests run, each alone where the runner allows (`build.py:549-564, 995-1019`); otherwise the whole suite runs, and a failure whose output never names the new test is refused (`build.py:1041-1053`). A test that passes first time needs `--covered` (`build.py:1004-1010, 1032-1040`).
- **Green.** An `[impl]` task runs the whole suite, which must pass (`build.py:1122-1134`). `[contract]`, `[refactor]` and `[docs]` keep a green suite green (`build.py:1137-1151`).
- **Frozen tests and scope.** A non-test task may not change a committed test without `--amend-test`; no task may change files the plan did not give it without `--allow-extra`; neither may touch `.claude/`, `.mcp.json` or an ADR, with no override (`build.py:587-620`). The test files counted as committed are `state["test_files"]` (`build.py:601, 1055`).
- **Secrets.** Before each commit the added lines are scanned (`build.py:644-663`).
- **Overrides** are `deviations` in `build.json` (`build.py:241-242`) and reach the build report (`build.py:1331`), review (`skills/review/scripts/review.py:570-578`), the verify run (`skills/verify/scripts/verify.py:402`), the change record (`skills/merge/scripts/change_record.py:611-623`) and `/mach explain`.
- **Commits.** One commit per task, made by the station (`build.py:578-584, 685`). The builder never commits, merges or resets (`skills/build/SKILL.md:18`, `agents/builder.md:14`).
- **Main is merged in only at `start` and `revise`** (`build.py:750-811`), "so never inside a red-to-green pair".
- **What later stations trust.** Verify and review refuse unless `build-report.json`'s `head` is the branch's tip (`verify.py:350-353`, `review.py:399`). Review diffs from the branch's merge base with main (`review.py:411-414`). `own_changes` decides what the ticket changed: if any merge commit is on the first-parent line since the baseline, it assumes main was merged in and counts only first-parent, non-merge commits (`build.py:1186-1196`). The finish skips its suite run when the last task's whole-suite run was on the commit that is now the tip (`build.py:1258-1272`).
- **Timing.** The report's `timing` lists each task's test time and the clock since the previous task, in plan order (`build.py:1232-1255`).
- **Who starts the builder.** `run.py next` names `build` for a planned or building cell (`skills/run/scripts/run.py:475-490`). The belt workflow starts the agent it names (`workflows/belt.js:248-251`); the run skill does the same in a conversation (`skills/run/SKILL.md:95`). The belt already starts several agents for one ticket at once, for the review seats (`belt.js:201-210`); the run skill does the same (`skills/run/SKILL.md:97`).
- **Unattended.** The supervisor starts one `claude -p` per ticket that runs the belt (`docs/BLUEPRINT.md:426`), with a fixed tool list: `Workflow`, `Skill`, `Agent`, the file tools, `Bash(python3 *)` and four read-only `git` forms (`skills/run/scripts/policy.py:53-54`). A builder needs only `python3 build.py ...` (`SKILL.md:28`).
- **One worker per ticket.** `run.py next --holder H` writes `claim.json` (`run.py:919-955`). A claim is fresh only while the cell is at the stage it was made at (`skills/intent/scripts/claim.py:132-143`). A claim made for `build` at `planned` goes stale when `start` moves the cell to `building` (`build.py:904`), so today the claim guards handing the step out, not the whole build.

## 2. The guarantees, and what happens to each

| Guarantee | Kept or replaced | How |
|---|---|---|
| A test is written first and seen failing for the right reason before its code exists | Kept, with one stated change | The same `red` gate runs in the lane's checkout. "Before its code exists" now means: on the fork point plus this lane's earlier tasks. Tasks that name the same `FR` or `AC` are always in one lane (4.1), so no other lane is planned to write the code a lane's test proves. The report says which tree each red was seen on. |
| A committed test is never changed to fit the code | Kept | In a lane, the gate as today, with the tests committed before the fork counted as frozen. Across lanes, the join sets aside any lane whose commits touch another lane's test file, with no override (7.4, 8.2). |
| Each task changes only the files the plan gives it | Kept, made stricter | The scope gate as today. New: `--allow-extra` in a lane may not name a file the plan gives another lane (no override), and the join refuses two lanes that changed the same file. |
| The suite passes after each `[impl]` task | Replaced by something as strong for what is shipped | Each `[impl]` passes the whole suite of its lane's checkout, and the joined result must pass the whole suite before anything after it. What is not tested: the intermediate commits on the branch after landing (task 7 of lane 1 on top of task 6 of lane 2) were never run as such. The tip is. The report says so. |
| Every override is recorded with its reason | Kept | Lane deviations are copied into `build.json` at the join, with the lane named. What the station itself does (a lane set aside, lanes that fail together) is recorded as deviations too, so every reader shows it unchanged. |
| No secret is committed | Kept | Every lane commit is scanned before it is made, as today. Landing copies those commits; the join checks each landed commit's patch ID equals its lane commit's, so no unscanned line can enter. The fix task after a failed join is scanned like any task. |
| The builder never certifies its own work | Kept | The join is a station script, run by a clerk. A lane builder reports "lane built" and stops. `finish` is unchanged. |
| A build that dies can be picked up again | Kept | Each lane's state and worktree stay on disk; opening lanes and joining are idempotent; the join works in its own worktree and moves the ticket's branch only at the end, in one step. |
| One worker per ticket; no two agents in one checkout | Kept, made stronger | The driver holds the ticket's claim for the new step `build-lanes`. Each lane records the holder that started it and a time on every station call, and is not handed to another holder while that is fresh. Commands in the cell's own checkout refuse while lanes are open; commands in a lane refuse after the join. |

## 3. Words

- **Lane**: an ordered chain of plan tasks that the station builds in its own worktree, by its own builder. `L1`, `L2`, ... numbered by the plan position of each lane's first task.
- **Before the lanes**, **after the lanes**: tasks done in the cell's own checkout by one builder, before the fan-out and after the join.
- **Fork point**: the cell's commit when the lanes are opened. Every lane starts there.
- **Join**: landing every lane's commits on the ticket's branch and running the whole suite on the result.
- **Set aside**: a lane whose commits are not landed; its tasks are done again after the join, in the cell, one at a time.

## 4. What may run together

### 4.1 The rule, decided by a script

A new module, `skills/build/scripts/lanes.py`, reads the plan and the tasks `parse_plan` returns. Within the lanes part of the plan (4.2), two tasks are in the same lane when any of these holds:

1. **They share a file**: any file in either task's `files` (the task line and the touch map, `build.py:296-299`).
2. **A test and its code**: one is `[test]`, the other `[impl]`, and they name a common `FR` or `AC` ID. Invariants are not counted, for the reason `unreachable_green` gives (`cell.py:1209-1210`): an `[impl]` task names an invariant it keeps, not only one it establishes.
3. **A stated dependency**: one names the other with `after` (4.2).
4. **A task names no file.** It cannot be placed, so the whole lanes part becomes one lane, and the check says which task caused it.

The lanes are the connected groups this makes; inside a lane, tasks keep plan order. No agent decides any of it. An agent states the plan (the contract engineer already does); the script derives the lanes; the builder cannot change them.

A false claim of independence costs time, never trust. A lane whose code needs another lane's file cannot go green without changing it, and the scope gate refuses that; a lane that overrides its way into another lane's file is refused or set aside at the join; two lanes that only fail together fail the joined suite. Section 6 covers each.

### 4.2 Two additions to the plan's grammar

Both optional. A plan without them is read exactly as today.

```
## Tasks

Test command: `python3 -m unittest`

### Before the lanes
- [ ] T01 [test] Invitation model — `tests/test_invitation_model.py` (INV-01)
- [ ] T02 [impl] Invitation model — `app/models/invitation.py` (INV-01)

### Lanes
- [ ] T03 [test] Rules for who may invite, 16 cases — `tests/test_invite_rules.py` (FR-01, FR-02, FR-03)
- [ ] T04 [impl] Who may invite — `app/invite/rules.py` (FR-01, FR-02, FR-03)
- [ ] T05 [test] The invitation e-mail — `tests/test_invite_mail.py` (FR-05, AC-02)
- [ ] T06 [impl] The invitation e-mail — `app/invite/mail.py`, `templates/invite.txt` (FR-05, AC-02, after T02)

### After the lanes
- [ ] T07 [test] Invite route — `tests/test_invite_route.py` (AC-01, AC-03)
- [ ] T08 [impl] Invite route — `app/routes.py` (AC-01, AC-03)
```

- **Sub-headings** `### Before the lanes`, `### Lanes`, `### After the lanes`, in that order, each at most once, inside `## Tasks`. Neither `parse_plan` (`build.py:277`) nor `cell.py`'s `markdown_sections` (`cell.py:993`) treats `###` as a section, so both read such a plan as today. With no sub-headings, the whole list is the lanes part, and before and after are empty.
- **`after Tnn`** inside the task's trailing brackets, beside its IDs. It says the task needs that task's work in a way the files do not show (an import of a module another task creates is the usual case). `after` naming a task in the lanes part joins the two into one lane; naming a task before the lanes is allowed and changes nothing (that work is in the fork point); naming a later task, a task after the lanes, or an unknown task is a plan error. `parse_plan` is not changed: `ID_RE` (`build.py:57`) and `task_line_files` (`build.py:264-268`) ignore `after T06`. One small change follows: the commit summary strips the trailing ID list with a pattern that would no longer match (`build.py:682`); it is widened to allow `after`, which leaves every existing plan's messages as they are.

### 4.3 Files many tasks touch

A shared test file, a routes table, a registry, a migration list, a lock file: rule 1 puts every task that touches one into one lane. There is no exception in this design. Git can merge two additions to one routes table, but no script can say the merged file is right, and the scope and frozen-test gates are defined per file. So shared files go in a part of the plan that runs once: the model, the registry entry, the migration and the shared test helpers before the lanes; the route that exposes several behaviours, and its scenario tests, after them. Section 16, point 3, asks the owner to confirm.

### 4.4 What `check-plan` verifies

`cell.py check-plan` (`cell.py:1247-1355`) gains, through `lanes.problems(text, tasks, touch)`:

- the sub-headings are known, in order and not repeated;
- every `after` names an earlier task that exists and is not after the lanes;
- **before the lanes ends green**: every `FR` and `AC` a `[test]` task before the lanes names is named by an `[impl]` task before the lanes. Otherwise the fork point is red and no lane could go green;
- `unreachable_green` (`cell.py:1203-1237`) is also applied to each lane's own sequence. It holds for the whole plan already; the check guards a later change to the lane rule.

It never refuses a plan for being one lane. When `build.max_lanes` is above 1, its `PLANNED` output adds `lanes`: how many, their tasks, and for each join the first reason (`T04 and T06 share app/invite/mail.py`), so the contract engineer sees what the plan allows. At 1 the output is as today.

### 4.5 What the contract engineer is told

Added to `skills/intent/references/contracts-and-plan.md` (after line 88) and the plan template's comment (`skills/intent/assets/plan-template.md:24-29`), in plain words:

- Where the slice has separate parts, plan them so they can be built at the same time: each behaviour's tests in its own test file, its code in its own module where the project's structure has a place for it.
- Put what several parts need (a model, a registry or route entry, a migration, generated contract code, shared test helpers) under `### Before the lanes`, and the wiring that brings parts together, with its scenario tests, under `### After the lanes`.
- Write `after Tnn` wherever a task needs another task's work that its files do not show.
- Never split work, add files or move tests to make a plan look parallel. A slice with one behaviour is one lane, and that is right.

The existing rules that make plans one chain stay: the one table-driven test for the decision matrix (`contracts-and-plan.md:84`) joins every `[impl]` task that names one of its FRs into its lane, and "one behaviour that needs several files is one `[impl]` task" (`contracts-and-plan.md:88`). They are right for test-first building, and they are the main reason to expect little independence (4.6).

### 4.6 How much independence real plans have

I could not measure it. The repository holds no real plan of 30 tasks. The plans it does hold are test fixtures of four or five tasks: `tests/test_build.py:74-78` and `tests/test_cell.py:70-73`. In the first, T02 and T04 share `app/invite.py`, T01 shares FR-01 and FR-02 with T02, T03 shares FR-06 and FR-08 with T04: one lane, plus the `[docs]` task T05 alone. That is the shape the brief asks for: one matrix test, one service, scenarios through one route.

My estimate for plans written under today's brief: most are one lane; a few have a second, small lane (a document, a separate command line). After the brief changes, a slice that spans layers with separate code (a web form, an API handler, a background job, an export) might give two to four lanes of uneven length; a slice that changes one service gives one lane, however many tasks it has. Section 12 replaces this guess with numbers from the owner's own plans before anything else is built.

## 5. Where each lane works

- **Place**: `.factory/worktrees/<ticket>/lanes/<L>/repo`, beside the cell's own `repo`. Lane state: `.factory/worktrees/<ticket>/lanes/<L>/lane.json`. The join's worktree: `.factory/worktrees/<ticket>/lanes/join/repo`.
- **Branches**: `mach-lane/<ticket>/<L>` and `mach-lane/<ticket>/join`, made from the fork point. Not under `feature/`: a ref `feature/<ticket>` already exists, so `feature/<ticket>/L1` cannot, and `feature/<ticket>-L1` could be another ticket's name.
- **The sparse rule**: made by `workspace.create` (`skills/intent/scripts/workspace.py:118-149`), so a lane never holds `.claude/` or `.mcp.json`. `create` can today only detach at the main checkout's HEAD or use a branch's own tip (`workspace.py:129-134`); it gains a `start` commit parameter for a new branch made at the fork point.
- **Writing only inside the cell**: a lane's folder is inside the cell's folder and inside the project, where restricted mode keeps the file tools (`skills/run/scripts/executor.py:12-13`). The skill's rule 1 (`SKILL.md:18`) changes from "under the `workdir` that `BUILD start` prints" to "under the `workdir` that `BUILD start` or `BUILD next` prints". Making a worktree writes Git's records under the repository's `.git/worktrees/`. `cell.py open` and `build.py`'s `ensure_isolated` (`build.py:704-729`) already do this from a `python3` command, so a lane is made the same way. I could not test whether Claude Code's sandbox, when a person switches it on, lets a `python3` subprocess do this; lanes are no worse than opening a cell.
- **Cost of making one**: a worktree shares the repository's objects, so its cost is one working tree's files on disk and the time to write them (`git worktree add --no-checkout`, `sparse-checkout set`, `reset --hard`). For most repositories that is seconds. Measured and reported (8.1). Not counted: whatever the test command needs that Git does not hold (installed packages, a virtual environment, `node_modules`). MACH installs nothing in a cell today; whatever makes the suite run in the cell's own worktree has to happen again in each lane, and that can be the larger cost.
- **Cleanup**: after a join the lane and join worktrees are removed and their branches deleted. The landed commits carry the work; the report keeps each lane commit's SHA and patch ID. `cleanup run` must also remove them for a ticket abandoned with lanes open: today it removes only `repo` (`skills/cleanup/scripts/cleanup.py:721-729`) and then deletes the folder, which would leave Git's records of the lane worktrees and their branches behind; and its archive takes every file in the cell except `repo` (`cleanup.py:164-174`), so it would pack every lane's working tree.

## 6. Who fans out

### 6.1 What each candidate can do

- **The builder agent.** Whether a Claude Code sub-agent can start sub-agents cannot be read from this repository, and MACH should not depend on it. The builder's own rules allow it only `build.py` commands (`SKILL.md:28`, `agents/builder.md:12`), and a builder that starts builders would be the one to judge when its lanes are done. Rejected.
- **The belt workflow.** It starts agents with `agent()` and several at once with `parallel()`, as it does for review seats (`belt.js:205-206`). It holds no knowledge of the order and asks scripts through a clerk (`belt.js:16-19, 190-199`). It can start one builder per lane without new powers.
- **The run skill in a conversation.** It starts sub-agents and already starts every review seat at once (`SKILL.md:97`).
- **The supervisor.** It starts one `claude -p` per ticket that runs the belt (`BLUEPRINT.md:426`), and knows nothing of stations. The tools that execution has (`policy.py:53-54`) already cover a lane builder (`Agent`, `Bash(python3 *)`) and the clerk. Starting one execution per lane instead would multiply executions, budgets and claims for no gain.
- **`run.py`.** A script; it starts no agent.

### 6.2 Chosen: the driver, told by a script

The same pattern as the review panel: a script says what to start, the driver starts it all at once, a script tallies.

1. `run.py next` at `planned` names `build`, as today. The builder runs `BUILD start`. When lanes apply (7.1), `start` records the lane plan in `build.json` and says so. The builder does the tasks before the lanes as today. When `BUILD next` reaches the lanes part it answers `{"status": "LANES", "next": "Stop here and report. The line starts one builder per lane."}` and the builder stops.
2. `run.py next` at `building` with lanes ready or open names a new step, **`build-lanes`**, with no prompt (like `review`).
3. The driver runs `RUN lanes-start <ticket>`. It calls `build.py lanes-open <ticket> --holder <H> --grant <n>`, which makes any missing worktrees and prints the lanes to start now, each with `agent_type` builder, its model and its prompt (`Build lane L2 of MACH ticket <ticket>. ...`).
4. The driver starts all of them at once and waits for all. If more lanes remain than were granted, it asks again (step 3) until none is left.
5. The driver runs `RUN lanes-join <ticket>`, which calls `build.py join <ticket>`.
6. `run.py next` names `build` again (resume): one builder does the tasks after the lanes, any fix task the join added (8.3), and `finish`.

In the belt this is one function beside `review()` (`belt.js:201`), `buildLanes(ticket)`, called when the step is `build-lanes`; the batches loop inside it, so the guard against a station repeating without moving the ticket (`belt.js:235-241`) sees one step. `build-lanes` joins the fixed action lists (`belt.js:39, 60`), the phase map (`belt.js:36`) and the claimable steps (`claim.py:33`). In the run skill it is one row in the step table (`SKILL.md:93-97`). The supervisor needs no change.

All three drivers get it at once, since they follow the same script answers. The belt is where it is first tested end to end, because its functions are pure and tested on their own (`belt.js:51, 74`), and the supervisor runs it.

### 6.3 One worker per ticket, and one builder per checkout

- The driver claims `build-lanes` with its holder, as any step (`run.py:919-955`). The claim's stage is `building`, and the cell stays `building` throughout, so the claim stays fresh while the driver renews it.
- Each lane's `lane.json` records the holder that opened it and `last_step_at`, written by every `build.py` call in that lane. `lanes-open` hands a lane to the holder that opened it, or to anyone when its `last_step_at` is older than `factory.claim_minutes`. A person can take it over (`--take-over`, as `run.py next`). So a second driver, or a retry while an old builder still runs, cannot put two builders in one lane.
- `run.py next` also reads the lanes: a cell with a live lane answers `stop` with `needs: worker-in-cell` to any other holder, whatever `claim.json` says. This closes, for lanes, the gap noted in section 1 (a claim made at `planned` goes stale at `building`).
- In the cell's own checkout, `red`, `green`, `done` and `next` refuse while lanes are open (`lanes-open`); in a lane they refuse once it is joined (`lane-joined`).

## 7. The gates in a lane

### 7.1 When lanes open, and when not

`start` plans lanes only when all hold: `build.max_lanes` is above 1; the computed lanes part has two lanes or more; the ticket is not a hardening ticket and started from a passing suite (not `--no-baseline`, `build.py:868-881`); this is not a revision. Otherwise it writes nothing about lanes, and everything is as today.

`lanes-open` grants `min(build.max_lanes, lanes left, free places)` (7.5). If the grant is below 2 the first time, the station records `lanes.state: "sequential"` with the reason, and the cell's builder carries on through the plan in order as today. It also refuses to open lanes unless the cell's suite is green and its checkout clean.

### 7.2 Commands

- `BUILD next <ticket> --lane <L>`: the lane's next task, as `next` today, with the lane's `workdir`. When the lane is done: `{"status": "LANE_DONE", "next": "Report and stop. The line joins the lanes."}`.
- `BUILD red|green|done <ticket> <task>`: unchanged. The station knows each task's lane from `build.json` and works in that lane's worktree and state. A builder cannot work a task in the wrong lane.
- In code, a `Lane` is the `Cell` with three things changed: `work` is the lane's `repo`, the state is `lane.json`, and saving writes only `lane.json`. `take` uses the lane's next task. `tick_plan` is not called; the join ticks the plan once. `save_info` is never called in a lane (its callers are `ensure_isolated`, the merge from main, `start`, `finish` and `revise`: `build.py:729, 770, 790, 809, 906, 1346, 1380, 1417`).

### 7.3 Which tests run

The same as today, in the lane's checkout: for `red`, the new tests alone where the cell's start trusted that (`test_file_cmd` and `test_one` are copied from `build.json` into `lane.json`), else the whole suite; for `green`, the whole suite of the lane's checkout; for `done`, the whole suite when it was green. The whole suite, not the lane's own files: the lane's checkout is the fork point plus the lane's work, so this proves the lane breaks nothing that was there. What it cannot prove, the join does.

### 7.4 Seen failing first, and frozen tests

- A lane's `test_files` starts as the cell's at the fork point and grows with the lane's own tests. The frozen-test gate in a lane therefore covers everything committed before the fork and everything the lane committed.
- A lane cannot see another lane's new tests, because they are not in its checkout. Two rules make up for that:
  - In a lane, `--allow-extra` and `--amend-test` may not name a file the lane plan gives another lane, with no override (`lane-scope`).
  - At the join, any lane commit that touches another lane's test file, or any file another lane changed, sets that lane aside (8.2).
- Each task's record gains `lane`, `lane_commit` and `ran_on` (the commit its test run saw). The report says, for each red, the lane and the commit it was seen failing on.

### 7.5 Where state lives, and the limit on builders

- `build.json` holds the lane plan and each lane's status (`planned`, `open`, `done`, `joined`, `set-aside`). Only `lanes-open` and `join` write it, under a lock file in `lanes/`, the way `lifecycle.py` takes an advisory lock (`skills/intent/scripts/lifecycle.py:17-18`). No lane writes `build.json`, `cell.json` or `plan.md`. Two lanes never share a state file.
- Lifecycle records from lanes go to the cell's one `lifecycle.jsonl`, which already takes concurrent appends safely (`lifecycle.py:17-18, 251-262`).
- **Free places**: `factory.max_builders` (default: `factory.max_parallel`, 3 in the template) caps builders on the machine across tickets. `lanes-open` counts this cell's place as one, and subtracts the other cells that are `building` with a fresh claim or a live lane, and their other live lanes. So with three tickets building, no ticket gets lanes unless a person raises `factory.max_builders`; with one ticket building, it gets up to three. Lanes use free places; turning lanes on alone never puts more builders on the machine than `factory.max_parallel` tickets would.

## 8. Bringing lanes together

### 8.1 When, and in what order

All at the end, once every lane is `done`. Landing each lane as it finishes gains nothing (later lanes still work from the fork point), runs the joined suite once per lane instead of once, and lands work on a tip that is still moving.

`build.py join <ticket>`:

1. **Check, change nothing.** For each lane, the files its commits changed (`git diff-tree`). If two lanes changed one file, or a lane changed another lane's test file, the later lane in plan order is set aside (8.2). Patch IDs of all lane commits are recorded.
2. **Land, in its own worktree.** Make `lanes/join/repo` on `mach-lane/<ticket>/join` at the fork point. Cherry-pick every landed task's lane commit there, one per task, in **plan order** across lanes. Lanes change disjoint files, so each applies cleanly in any order; a cherry-pick that does not apply anyway stops the join for a person, changing nothing on the ticket's branch. Each landed commit's patch ID must equal its lane commit's.
3. **Run the whole suite** on the landed tip, in the join worktree.
4. **Move the ticket's branch** in one step: `git merge --ff-only` of the join branch in the cell's own checkout. Nothing on the ticket's branch moved before this.
5. **Record**: each task's `commit` becomes its landed commit (the lane commit stays as `lane_commit`); lane deviations are copied into `build.json` with `lane`; `plan.md` is ticked; lanes are `joined`; worktrees and lane branches are removed (5).

The commits afterwards look like a sequential build's: one per task, in plan order, with the same messages (`build.py:685`), and no merge commit. That matters twice: review and the change record read the history task by task as today, and `own_changes` (`build.py:1186-1196`) would read any merge commit as main having been merged in, and then count only the first-parent commits, losing every lane's files. Cherry-picks without `-x`: a "cherry picked from" line would name a commit that no longer exists; the mapping is in the report.

### 8.2 A conflict: the plan's independence was false

Two lanes changing one file is only possible through `--allow-extra` on a file the plan gives neither lane (one given to another lane is refused, 7.4; and a task with no files, which the scope gate leaves unchecked, `build.py:610-611`, makes the whole lanes part one lane, 4.1). Either way the plan's claim was false for those lanes. The later lane in plan order is **set aside**: its commits are not landed, its tasks are marked pending again, and they are done after the join in the cell, one at a time, in plan order, where every gate sees the landed work (the other lane's test files are then committed and frozen). Recorded as a deviation `lane-set-aside`, naming the file and both lanes. Its lane commits are not kept beyond the join; the report names them.

Setting aside throws away work, and is meant to be rare. It never lands work whose gates did not see the files it shared.

### 8.3 The joined suite fails though every lane passed

The lanes do not work together: two registrations under one name, a shared global, a fixture that only one lane expected. The ticket's branch is still moved to the landed tip: each landed commit passed its gates, and the failure is in their combination, which is work still to do on that tip, exactly as a red suite after a `[test]` task is today. The join then:

- adds one task, `J-T01 [impl] Make the lanes pass together`, after the last lanes task and before the tasks after the lanes, whose files are every non-test file the landed lanes changed;
- sets `suite: red` and records a deviation `lanes-interaction` with the failing tests, the lane that wrote each failing test's file, and the output tail;
- prints `INTERACTION` with that.

`run.py next` then names `build`, and the builder does `J-T01` with `green`: the whole suite must pass, committed tests are frozen (every test is now committed), and it may change only those files. If it needs another file, that is `--allow-extra` with a reason, as today. Three honest attempts, then stop and report (`SKILL.md:89`). It uses no review round. Reviewers see it in the deviations, the change record and the commit.

Not done: finding which pair of lanes interacts by landing subsets. It would cost one suite run per subset; the failing test's file already names one lane.

### 8.4 What the finish does afterwards

`finish` is unchanged, with one fix: `reusable_suite_run` (`build.py:1258-1272`) may reuse a run only if its `ran_on` is the current tip. Without that, after a join the last task in plan order has a whole-suite run from its lane and a `commit` that is now the tip, and the finish would reuse a run of a different tree. The join's own suite run is recorded with `ran_on`, so a finish straight after a passing join reuses that run, which is honest.

## 9. When things go wrong

- **A lane builder dies or times out.** Its `lane.json` and worktree stay, with any half-written file. The driver's next `lanes-start` returns that lane (same holder), and the new builder resumes from `BUILD next --lane`, as a resumed build does today (`SKILL.md:115`).
- **A lane is refused by a gate.** As today: the builder fixes the cause or stops and reports. A stopped lane stays `open`; the other lanes finish; there is no join until it is done. In the belt the next `lanes-start` restarts it; a second stop makes the ticket `stuck` (`belt.js:239-240`), for a person, with the builder's report.
- **A lane cannot finish at all** (a spec or plan defect). The ticket stops, as a sequential build would. Not in this design: landing what the other lanes finished and carrying on without the stopped one (section 16, point 4).
- **`add-task` in a lane.** Refused. `add-task` is only for revision rounds (`build.py:1157`), which never fan out.
- **A revision round.** Never fans out. Revisions add a task per finding (`SKILL.md:110`), are few, often cross what were lanes, and are reviewed as a delta (`BLUEPRINT.md:532`). They run in the cell as today; the lanes are gone by then.
- **Resuming a half-finished parallel build.** `run.py next` reads `build.json`'s lane status: lanes open or ready gives `build-lanes`; `lanes-open` remakes any missing worktree (refusing a folder that exists but is not the registered worktree on the expected branch, for a person) and returns the lanes not done; a join that stopped part way starts again from the fork point in a fresh join worktree, because it changed nothing on the ticket's branch until its last step.
- **The engineer interrupts** `/mach` in a conversation. The lane builders may be stopped with it. Everything is on disk; `/mach <ticket>` carries on from the routing sheet.
- **Main moves meanwhile.** Nothing changes: main is merged only at `start` and `revise` (`build.py:750-758`), and the fork point comes after `start`.

## 10. Limits and settings

- **`build.max_lanes`**: how many lanes one ticket may run at once. Whole number, at least 1; anything else reads as 1. **Default 1: off.** Off by default because: it changes what "seen failing" was seen against (2); it adds a failure mode (8.3) and a cost (below); and today's plans are one lane, so turning it on everywhere buys nothing until plans change. A project turns it on in `.factory/config.json`.
- **`factory.max_builders`**: builders on the machine across tickets (7.5). Default `factory.max_parallel`.
- **With several tickets**: the schedule (`schedule.py`) still decides which tickets run (`BLUEPRINT.md:381`); lanes only use places it leaves free.
- **The supervisor**: a lane build runs inside the ticket's one execution, under its spending limit (`max_budget_usd_per_run`, default 25, `policy.py:46`) and time limit. More lanes spend that budget faster in wall time.
- **Cost in tokens, plainly.** Each lane builder reads the ground again: the plan, the spec, contracts, ADRs and the code next to its files (`SKILL.md:49-51`). With L lanes, about L−1 extra readings of that, plus two small clerk calls, plus a fix task when the lanes do not pass together. Against that, each builder's conversation is shorter, so later tasks re-read less. The net is not known. MACH records cost only for supervised executions (`BLUEPRINT.md:391`), as a total for the execution; that total is the measure, and nothing per lane is estimated.

## 11. What it will not do, and what to expect

### 11.1 Stays sequential

- A plan whose lanes part is one lane (most plans today), or a lanes part made one lane by a task with no files.
- The tasks before and after the lanes, and any task set aside or added by the join.
- Revision rounds, hardening tickets, a start without a passing suite.
- A machine with no free place for a second builder.
- Within a lane, everything is in plan order, test before code, as today.

### 11.2 The arithmetic

For a plan of N tasks, with t = a task's average time (the builder's writing, m, plus its gate's test run, s), G = one reading of the ground, W = making the lane worktrees, J = landing (seconds), S = one whole-suite run at the join, and c = how much slower a test run gets when lanes run their tests at once (1 when the suite uses one core, up to the number of lanes when one suite already uses every core):

- sequential: `G + N·t`
- in lanes: `G + before·t + W + G + longest_lane·(m + c·s) + J + S + after·t`

The second G is the lane builders reading the ground, at the same time. c applies only while other lanes are running: once the short lanes are done, the long one runs alone at c = 1. The finish reuses the join's suite run when no task follows (8.4).

Example: 30 tasks, t = 6 minutes (m = 4, s = 2), G = 5, W = 1, S = 3. Sequential: 185 minutes.

| Plan shape | c = 1 | c = number of lanes |
|---|---|---|
| One lane (today's typical plan) | 185 min, no gain | 185 min, no gain |
| 4 before, two lanes of 12, 2 after | 122 min, 1.5× | 146 min, 1.3× |
| 2 before, four lanes of 6, 4 after | 86 min, 2.2× | 122 min, 1.5× |
| 2 before, lanes of 16, 4 and 4, 4 after | 146 min, 1.3× | 162 min, 1.1× |
| Best case: 15 independent test-and-code pairs, 4 lanes | 62 min, 3× | 106 min, 1.7× |

What decides it, in order: whether the plan has lanes at all; how even they are (the longest lane is the floor); and how much of a task's time is the test run on this machine. The owner's own build reports already say the last one: `timing.test_seconds_total` against `timing.elapsed_seconds` (`build.py:1246-1247`). If tests are most of a build's time and the suite already keeps every core busy, lanes mostly wait for each other's tests, and the gain is small whatever the plan.

A failed join adds at least one task's time and a whole-suite run.

## 12. A cheaper first step

**Measure before building the rest.** Piece A (section 14) alone: `lanes.py`, the lane calculator, read-only, with a command that reads the owner's past builds. Cleanup's archives keep each cell's files except the worktree (`cleanup.py:164-174`), so `plan.md` and `build-report.json` are there. For each past build it prints: tasks, the lanes the plan would make and why tasks were joined, the measured elapsed and test time, and the time the formula above predicts with c = 1 and c = lanes, labelled as a prediction. Then the contract engineer is given the new guidance (piece B) on a few new slices, and the calculator is run on those plans.

It changes nothing at run time and risks nothing. If the owner's plans, re-planned, still come out as one lane, or the reports show test time dominating, the runtime pieces are not worth building, and the owner learns it in days instead of after the whole feature. I recommend building A and B first and deciding on C to F from their numbers.

Other simpler variants, and why not:

- **Writing all the `[test]` tasks at once, then the code in order.** Every red test then sits in the suite while the first `[impl]` must pass the whole suite (`build.py:1128-1131`); no `[impl]` could go green. It also breaks "one task, one task's worth" (`SKILL.md:20`).
- **One builder, with the gate's test run in the background while it writes the next task.** A refused `green` would leave the next task's edits in the same checkout, and the gates judge a task by the files changed since its last commit (`build.py:567-575`).
- **Lanes merged as they finish.** No faster than at the end (8.1), and more joined-suite runs.

The design above already takes the simpler choices where they cost little: one join at the end, no partial join, no fan-out in revisions, no exception for shared files, no change to the Factory Floor.

## 13. What is reported

### 13.1 The build report

Only when lanes ran; otherwise `build-report.json` is as today.

- Each task: `lane`, `lane_commit`, `commit` (landed), `ran_on` for its test run.
- `lanes`: the setting, the grant, the fork point, the plan (before, lanes with tasks and files, after, and why tasks were joined), and per lane: branch, status, started and finished (first and last `build.py` call in the lane), elapsed, test seconds, worktree seconds.
- `lanes.join`: when, the plan order landed, each landed commit with its lane commit and patch ID, lanes set aside with the file and reason, the joined suite run, and the interaction if any.
- `timing.lanes`: wall time of the lanes part (fork to last lane done), the sum of the lanes' elapsed times, their ratio, and the fixed costs (worktrees, landing, joined suite), each measured. A note in the report says the summed time is not what a sequential build would have taken, which was not run (it would have read the ground once, and run its tests alone). The speed-up is the measured ratio for the lanes part and the measured elapsed of the build; nothing is claimed beyond that.
- `timing.steps` (`build.py:1236-1241`) measures "since the previous step" within each lane's own chain, not across lanes, where it would be meaningless.

### 13.2 The Factory Floor

The build station emits lifecycle records only: `station.entered`, `station.exited`, `gate.evaluated`, `build.task_completed` (`docs/mach-next/M6_1_STATION_TELEMETRY.md:22, 36`). With lanes, all are real and none is invented:

- `build.task_completed` when a lane task's commit is made, with an added `lane` field and the lane commit, which is what was committed at that moment. The observer maps this event's fields by name (`M6_1_EVENT_CONTRACT.md:364`); I did not check whether it drops an unknown field or keeps it. The lane commit no longer exists after the join, so the observer's check of a commit named by this event (`M6_1_EVENT_CONTRACT.md:414`) cannot find it; that is the observer's piece to handle.
- `gate.evaluated` with the gates `build.lanes-open` and `build.join` (pass, refuse, and the reason codes `lane-set-aside`, `lanes-interaction`). Gate names are already open-ended.
- No Floor screen changes in this design. The Line shows the ticket at Build, as now.

### 13.3 The change record

`build_section` (`change_record.py:611-623`) adds one line when lanes ran: how many lanes, that they were joined at which commit, whether the whole suite passed on the joined result, and any lane set aside. Its list headed "Overrides the builder recorded" also shows `lane-set-aside` and `lanes-interaction`, which the station recorded, so it words those two as the station's. The facts section for release qualification is unchanged.

## 14. Build plan

Six pieces. A and B can start at once; C's two parts start once A's interface is written down (below); D, E and F against C's command output. Only the piece named owns a file; no other piece edits it.

### A. The lane calculator and the measurement

- New: `skills/build/scripts/lanes.py`; `tests/test_lanes.py`.
- Touches: nothing. Standard library only. It takes `parse_plan`'s output; it does not import `build.py`, and its CLI loads `parse_plan` by path as `schedule.py` does (`schedule.py:198-212`).
- Interface:
  - `PHASES = ("before", "lanes", "after")`; `HEADINGS = {"before": "Before the lanes", "lanes": "Lanes", "after": "After the lanes"}`.
  - `annotate(text: str, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]`: each task with `phase` and `after: List[str]`.
  - `plan(text: str, tasks: List[Dict[str, Any]], touch: Dict[str, List[str]]) -> Dict[str, Any]`: `{"before": [ids], "lanes": [{"lane": "L1", "tasks": [ids], "files": [...]}], "after": [ids], "joined_because": [{"tasks": [a, b], "why": str}], "single_reason": Optional[str]}`.
  - `problems(text: str, tasks, touch) -> List[str]`: the checks of 4.4, as sentences for `check-plan`.
  - `predict(lane_plan: Dict[str, Any], report: Dict[str, Any]) -> Dict[str, Any]`: the formula of 11.2 from a build report's measured steps; labelled a prediction.
  - CLI: `python3 lanes.py show <plan.md>`; `python3 lanes.py measure <cell folder or archive .tar.gz>...` (reads `plan.md` and `build-report.json`; prints per build: tasks, lanes, why joined, elapsed, test share, predictions).
- Tests: the rules of 4.1 one by one; `after` forms and errors; headings; the fixture plans of `tests/test_build.py:74-78` and `tests/test_cell.py:70-73` give one lane plus T05; a plan with no headings and no shared files gives one lane per test-and-code pair; a task with no files gives one lane and says why; `measure` on a hand-made archive.

### B. The plan stage

- Touches (only B): `skills/intent/scripts/cell.py` (`cmd_check_plan` calls `lanes.problems`; adds `lanes` to `PLANNED` when `build.max_lanes` > 1; loads `lanes.py` by path as it loads `build.py`, `cell.py:1390-1401`); `skills/intent/assets/plan-template.md`; `skills/intent/references/contracts-and-plan.md`; `agents/contract-engineer.md` (one sentence pointing at the brief's section).
- New: `tests/test_cell_lanes.py` (not `tests/test_cell.py`, which no piece edits).
- Interface used: A's `problems` and `plan`.
- Tests: each new refusal; a plan without the additions is accepted with output equal to today's at `max_lanes` 1; the `lanes` output at 2.

### C1. Lanes in the build station

- Touches (only C1): `skills/build/scripts/build.py`; `skills/intent/scripts/workspace.py` (`create(project, repo, branch, start=None)`); `skills/build/SKILL.md` (rule 1's wording, a section "Building one lane", the `LANES` and `LANE_DONE` answers); `agents/builder.md` (a lane builder stops at `LANE_DONE` and never joins).
- Interface (commands, all JSON on stdout as today):
  - `start`: adds `"lanes": {"count", "lanes": [...]}` only when lanes apply.
  - `next <ticket> [--lane L]`: adds `LANES`, `LANE_DONE`; refuses `lanes-open` in the cell while lanes are open.
  - `lanes <ticket>`: read-only; the lane plan and each lane's status.
  - `lanes-open <ticket> --holder H [--grant N] [--take-over]`: `{"status": "OPEN" | "SEQUENTIAL" | "NONE_LEFT", "lanes": [{"lane", "tasks", "workdir", "agent_type", "prompt"}], "why": str}`.
  - `join <ticket>`: `{"status": "JOINED" | "INTERACTION" | "REFUSED", "landed": n, "set_aside": [...], "suite": {...}, "next": str}`; calls C2.
  - In Python: `class Lane(Cell)` with `work`, `state_path`, `save`; `lane_of(cell, task_id) -> Optional[str]`; `reusable_suite_run` requires `ran_on == HEAD`; `timing` per chain; the report fields of 13.1; lifecycle data of 13.2.
- Tests (new `tests/test_build_lanes.py`): scenarios 1 to 9 and 12 to 13 of section 15. The byte-for-byte test (scenario 12) is written and passing **before** any other change to `build.py`.

### C2. Landing

- New: `skills/build/scripts/landing.py`; `tests/test_landing.py`.
- Touches: nothing. Takes paths and commit lists; runs Git; knows nothing of tasks beyond what it is given.
- Interface:
  - `overlaps(repo: Path, fork: str, lanes: Dict[str, List[str]], test_files: Dict[str, List[str]]) -> List[Dict[str, Any]]`: `{lane, other, file, why: "same-file" | "frozen-test"}`, read-only.
  - `land(project: Path, join_repo: Path, branch: str, fork: str, commits_in_order: List[str]) -> Dict[str, Any]`: makes the join worktree (through `workspace.create`), cherry-picks, returns `{"landed": [{"lane_commit", "commit", "patch_id"}], "tip": str}` or raises `LandingError` naming the commit that did not apply, having removed what it made.
  - `fast_forward(cell_repo: Path, tip: str) -> None`.
  - `remove(project: Path, folders: List[Path], branches: List[str]) -> List[str]`: what could not be removed.
- Tests: scenarios 2, 4, 5 and 13 of section 15 at this level, with real Git repositories made in a temporary folder.

### D. Routing and the drivers

- Touches (only D): `skills/run/scripts/run.py` (`next_step` names `build-lanes`; `cmd_lanes_start`, `cmd_lanes_join` beside `cmd_review_start`, `run.py:1158`; the free-place count of 7.5; a live lane answers `worker-in-cell`); `skills/intent/scripts/claim.py` (`STEPS` gains `build-lanes`); `workflows/belt.js` (`ACTIONS`, the action list in `cleanStep`, `PHASE`, `buildLanes`, and a pure `cleanLanes(answer, most)` between `// BEGIN` and `// END` markers like `cleanStep`); `skills/run/SKILL.md` (the step table row); `tests/test_run.py` (the new pure function, evaluated as `cleanStep` is).
- New: `tests/test_run_lanes.py`.
- Interface: `run.py lanes-start <ticket> --holder H` prints C1's `lanes-open` answer with the grant filled in; `run.py lanes-join <ticket>` prints C1's `join` answer.
- Tests: scenarios 10 and 11 of section 15; `cleanLanes` refuses an unknown agent type, an empty prompt, and more lanes than `most`.

### E. The readers

- Touches (only E): `skills/merge/scripts/change_record.py` (13.3); `skills/cleanup/scripts/cleanup.py` (remove lane and join worktrees and `mach-lane/<ticket>/*` branches; leave `lanes/*/repo` out of the archive); `skills/run/scripts/explain.py` (say a lane was set aside or lanes failed together, from the deviations).
- Tests: a change record and an explanation from a report with lanes, and from one without (unchanged); cleanup of a cell abandoned with lanes open leaves no worktree record, branch or lane tree in the archive.

### F. Documents and telemetry

- Touches (only F): `docs/BLUEPRINT.md` (section 4's build station, the orchestration section, `build.max_lanes` and `factory.max_builders`); `docs/mach-next/M6_1_STATION_TELEMETRY.md` (the `lane` field, the two gate names); `docs/mach-next/NEXT.md`. Observer handling of `lane` (in `apps/observer`) is F's if the owner wants it shown; not needed for the rest.
- `templates/config.json` is not changed: the defaults hold without a key.

### Shared files

- `build.py`: C1 only. `parse_plan` is not changed by anyone, so `cell.py` and `schedule.py` read plans exactly as today.
- `workspace.py`, `SKILL.md` (build), `agents/builder.md`: C1. `cell.py`, the plan template, the brief: B. `run.py`, `claim.py`, `belt.js`, the run skill: D. `change_record.py`, `cleanup.py`, `explain.py`: E.
- Not edited by anyone: `review.py`, `verify.py`, `merge.py`, `schedule.py`, `supervisor.py`, `executor.py`, `policy.py`, `lifecycle.py`, `tests/test_build.py`, `tests/test_cell.py`.

## 15. Tests

Each scenario runs real Git in a temporary project, with a small Python project and its test suite, as `tests/test_build.py` does.

1. **Two lanes, clean.** A plan with two independent pairs and one pair after; two lanes open; each red and green in its own worktree; the join lands four commits in plan order with the same messages; the whole suite passes; one more pair is built after; finish reuses nothing it should not. History: one commit per task, no merge commit; `own_changes` lists every file.
2. **Two lanes that secretly share a file.** Both lanes change `app/util.py`, which the plan gives neither: each is refused (`scope`). With `--allow-extra` in both: the join sets the later lane aside (`same-file`), lands the earlier, and the set-aside tasks are then built in the cell, where the first lane's work is committed.
3. **`--allow-extra` naming another lane's file.** Refused with `lane-scope`, no override.
4. **A lane edits a test another lane froze.** A test file the plan gives lane 1 cannot be touched by lane 2 at all (scenario 3). The case left: lane 1 commits an extra test file, `tests/test_helpers_extra.py`, with `--allow-extra`, and lane 2 writes a file of the same name with `--allow-extra`. Each lane's gates pass; the join sets lane 2 aside (`frozen-test`), and when its tasks are redone in the cell the frozen-test gate refuses the change without `--amend-test`.
5. **A conflict that should not happen.** A lane commit made by hand that does not apply: the join stops, `REFUSED`, the ticket's branch unchanged, the join worktree removed.
6. **A lane whose code only passes with another lane's change.** Lane 2's code imports a module lane 1 creates. Lane 2's `green` cannot pass without changing lane 1's file, and the scope gate refuses it; with `after T02` in the plan, the two are one lane and it builds.
7. **A failure only on the joined result.** Two lanes each pass; together a test fails (both register one name). `INTERACTION`; `J-T01` added; suite red; `J-T01` may not change a test; a fix in code passes; the deviation is in the report, the review packet's builder notes and the change record.
8. **A builder killed mid-lane.** Lane 1 stops after T03 with T05's test half written. `lanes-start` with the same holder returns lane 1; `next --lane L1` names T05; `red` takes the file. Another holder is refused while `last_step_at` is fresh, and allowed after `factory.claim_minutes`.
9. **The join interrupted** after landing two of four commits: the ticket's branch has not moved; `join` again starts over and lands all four.
10. **Two drivers.** Driver A holds `build-lanes`; driver B's `run.py next` answers `worker-in-cell` while any lane is live, even after A's `claim.json` would have gone stale.
11. **The grant.** With `factory.max_builders` 3 and two other tickets building, `lanes-open` answers `SEQUENTIAL` and the build goes on in order in the cell; with none, it opens up to `build.max_lanes`; with five lanes and a grant of two, three batches, one `build-lanes` step in the belt.
12. **The setting at 1 is today's station, byte for byte.** Before C1 changes anything, a scripted build of the fixture plan (start, every task, finish, a revise and a revision task) is recorded: every command's output, `build.json`, `build-report.json`, `plan.md`, the commit messages and trees. After the change, with `build.max_lanes` absent, at 1, and at 3 with a one-lane plan, the same script gives identical results apart from times and commit IDs. The whole of `tests/test_build.py` passes unchanged.
13. **Secrets across the join.** A lane commit's patch ID differs from its landed commit (a commit edited by hand in the join worktree): refused.
14. **A plan with the new grammar** is read by `schedule.py` and `cell.py` exactly as before for files and IDs (their own tests unchanged).

## 16. Open points for the owner

1. **Default off.** Recommendation: `build.max_lanes: 1` everywhere; you turn it on for your project. On by default would cost tokens on every multi-lane plan for every user, and changes what "seen failing" was seen against.
2. **The plan's two additions** (`###` parts and `after`). Recommendation: both. Without parts, shared wiring forces one lane; without `after`, a hidden import costs a stuck lane. The cost is a longer brief for the contract engineer.
3. **No exception for shared files** (routes, registries, lock files, migration lists). Recommendation: none in v1; plan them before or after the lanes. An "append-only" file merged by Git would land code no gate saw as a whole.
4. **A lane that cannot finish.** Recommendation: the ticket stops for a person, as a sequential build does. Later, if wanted: land what the other lanes finished and do the stopped lane's tasks in the cell.
5. **A lane that broke independence is set aside and its tasks redone in order**, throwing its work away, without asking a person. Recommendation: yes; it is mechanical, recorded and rare. The alternative is a stop for a person every time.
6. **A failed join adds a fix task the station writes** (`J-T01`), with tests frozen, and uses no review round. Recommendation: yes. The alternative is a stop for a person.
7. **Checking that each lane's tests fail on the other lanes' code** (one extra run per lane at the join). Recommendation: not in v1. Joining tasks that share an `FR` or `AC` covers the case that matters; the report states exactly what each red was seen on.
8. **`factory.max_builders`**, defaulting to `factory.max_parallel`. Recommendation: yes, so turning lanes on never adds load by itself; you raise it on a machine with room.
9. **Revisions never fan out.** Recommendation: yes.
10. **Build pieces A and B first, and decide on the rest from their numbers.** Recommendation: yes (section 12).

## 17. What makes this harder than it looks

- **Today's plans are one chain**, and the brief's own good rules make them so (`contracts-and-plan.md:83-84, 88`). Until plans change, the feature does nothing.
- **The test run may be the real bottleneck.** Lanes run their suites at the same time on one machine; if a suite already keeps every core busy, they wait on each other (11.2). Suites that use fixed ports, a shared database or fixed temporary paths will also fail when run at once; `factory.max_parallel` already runs several tickets' suites at once, but lanes make it more likely.
- **Several things assume one chain in one checkout**, each a trap if missed: `build.json` and `plan.md` are rewritten whole (`build.py:224-226, 303-309`); `own_changes` reads any merge commit as main's (`build.py:1186-1196`), which is why the join lands by cherry-pick; `reusable_suite_run` would reuse a run of another tree (`build.py:1258-1272`); `timing` measures across the plan's order (`build.py:1236-1241`).
- **One worker per ticket guards less than its name says.** A claim made at `planned` is stale once the build starts (`claim.py:132-143`, `build.py:904`). Lanes need liveness of their own (6.3), and the same gap stays open for a sequential build.
- **Worktrees have hidden costs**: whatever the suite needs that Git does not hold must be made again per lane, and cleanup today would archive lane trees and leave their Git records and branches (`cleanup.py:164-174, 721-729`).
- **The belt's repeat guard** (`belt.js:235-241`) would call a second batch of lanes stuck unless the batches loop inside one step.
- **The plan's grammar has one parser shared by three stations** (`cell.py:1390-1404`, `schedule.py:198-228`); this design leaves `parse_plan` alone and reads the additions in `lanes.py`, at the price of a second reader of the Tasks section.
- **Not determined from the code**: whether a Claude Code sub-agent can start sub-agents (not relied on); how many agents the belt's `parallel()` runs at once and what the account's rate limits allow; whether Claude Code's sandbox, when switched on, lets a `python3` subprocess add worktrees (opening a cell already does); whether the observer drops an unknown event field; and how much independence the owner's real plans have.

## As built

What MACH does now. Where this section and the body above differ, this section is right; the build skill (`skills/build/SKILL.md`) and the blueprint's build station (`docs/BLUEPRINT.md`, section 4) say the same.

### What differs from the design, and why

- **On by default.** `build.max_lanes` defaults to 3, not 1 (design 10 and 16, point 1). 1 builds one task at a time. The owner chose this because the next decision already keeps every existing plan as it was: lanes apply only to a plan written for them.
- **Only a plan written for lanes is built in lanes.** The design read a plan with no sub-headings as all lanes part (4.2), so unrelated tasks of an old plan could have run at once. As built, a plan is built in lanes only when its author used a part heading (`### Before the lanes`, `### Lanes`, `### After the lanes`) or an `after Tnn` mark (`lanes.uses_additions`). A plan written the old way is built one task at a time, exactly as before, whatever the setting: its author never claimed that its parts are independent. `cell.py check-plan` applies the new checks, and adds `lanes` to `PLANNED`, only for such a plan.
- **A lane that cannot finish is handed back, never a stop** (design 9 and 16, point 4). `build.py hand-back <ticket> --lane <L> --reason "<why>"`, run by the lane's builder or by the line, gives the lane's unfinished tasks to the cell: its finished tasks still land at the join, and the rest are built in the cell, one at a time, after it, where every landed file is in reach. The belt hands a lane back by itself when its builder comes back twice with nothing more done. One lane never stops the ticket. Recorded as `lane-handed-back` (and `lane-handed-back-joined` at the join).
- **A lane that proves not independent is set aside automatically** (8.2 and 16, point 5, as recommended), and its tasks are built one at a time in the cell after the join. **A failure that appears only when lanes are joined gets one recorded fix task**, `J-T01` (8.3 and 16, point 6, as recommended); if a handed-back task already made the suite pass, `J-T01` is completed with `--already-done`. **Revision rounds never fan out** (16, point 9).
- **No state without a way forward.** The owner's rule for the whole product: MACH is flexible and trusts the builder and the user; it never leaves a state with no way forward, and never suggests abandoning or deleting work for something that can be put right. In that spirit:
  - **The test command can be given or changed at any time, and the builder may choose it**: `build.py set-commands <ticket> --test-cmd "<command>" [--lint-cmd "<command>"] --reason "<why>"`, in a first build or a revision round, before, during or after the lanes, and on a ticket whose tasks are finished but not yet verified. Nothing done is undone. Each change is a deviation with the old and the new command, the reason and when, shown to the reviewers, in `explain` and in the change record. While lanes are open only `build.json` is written, under the lanes' lock, and each lane takes the command at its next step.
  - **The start refuses, with the cell still planned, when no test command is known.** It records nothing and names both ways on (pass `--test-cmd`, or set `build.commands.test`). A start never accepts a build it could not carry on.
  - **A red suite when the lanes would open** makes the build go on one task at a time in the cell (`lanes.state: sequential`, with the reason) instead of stopping for a person.
  - **A lane's stray uncommitted files at the join** are set aside by the station itself, kept, with how to bring them back, and the join goes on.
  - **A re-plan** (`cell.py replan`) keeps the slice's latest spec on the branch, moves the old `plan.md`, `build.json` and `build-report.json` to `plan-history/<n>/`, keeps the old tip, with any uncommitted files committed on top of it, as `refs/mach/replan/<ticket>/<n>`, and lists any commit it did not recognise with the `git cherry-pick` that brings it back and the uncommitted files with the `git checkout` that brings them back.
  - **A spec corrected after building started** sets the old plan and build aside the same way, at `cell.py finalize`, with no separate instruction, and the contract engineer plans again.
- **At least one builder per ticket with open lanes.** A ticket whose lanes are open always keeps at least one builder, however many places other tickets use, so open lanes are never left with nobody to finish them.
- **Scheduling and supervision.** The schedule treats a ticket with a live lane as held, and the supervisor counts tasks completed during an execution as progress, so a build whose lanes are moving is not parked as not progressing.
- **The Factory Floor shows lanes** (13.2 said no screen would change): on the Line and in a ticket's side panel (below). **The join's start is recorded**, so the Floor can say that the lanes are being joined while it runs.
- **The joined suite failing still moves the branch** (8.3), as designed: `landing.join_lanes` takes `move_on_red`, and the build station passes it.
- **A lane whose branch is gone is made again from its commits.** `lanes-open` puts a lane's branch back at its last recorded commit; only when the commits themselves are gone does the lane start again from the fork point, and it says so (`restarted`).
- **A set-aside lane's commits are not kept on a branch.** As designed (8.2), the join removes a set-aside lane's worktree and branch; the deviation names its lane commits. A landed lane's worktree or branch that still holds anything that has not landed is not removed, and is listed.

### The commands as built

Build station (`skills/build/scripts/build.py`):

- `start <ticket> [--test-cmd C] [--lint-cmd C]`: as before; refuses `no-test-command` when none is known. Adds `lanes` (count, each lane's tasks, before, after) only when lanes apply.
- `next <ticket>`: answers `LANES` when the next task is a lane's; refuses `lanes-open` while lanes are open. `next <ticket> --lane L --holder H`: the lane's next task and its `workdir`, or `LANE_DONE`.
- `red|green|done <ticket> <task> [--holder H]`: unchanged; a lane's task is worked in its lane's worktree and `lane.json`.
- `lanes <ticket>`: reads only; the lane plan, each lane's status, whether it is live, and the next command.
- `lanes-open <ticket> --holder H [--grant N] [--take-over]`: `OPEN` (lanes with `agent_type`, `model`, `prompt`, `workdir`, `branch`), `SEQUENTIAL` or `NONE_LEFT`; a refusal (`lane-held`, `no-free-place`, `lanes-not-ready`, `lane-folder-unknown` and others) names the way on.
- `hand-back <ticket> --lane L --reason "<why>" [--holder H]`: `HANDED_BACK`.
- `join <ticket>`: `JOINED`, `INTERACTION`, or `REFUSED` (nothing landed, the branch where it was, every lane kept; run it again and it starts over from the fork point).
- `set-commands <ticket> --test-cmd C [--lint-cmd C] --reason "<why>"`: `COMMANDS_SET` or `UNCHANGED`.
- `status <ticket>`: adds `lanes` for a build that has them.

Run skill (`skills/run/scripts/run.py`): `next` names the step `build-lanes`; `lanes-start <ticket> --holder H|new [--take-over]` claims the step, fills in the grant from the free places and runs `lanes-open`, answering `OPEN`, `SEQUENTIAL`, `NONE_LEFT`, `WAIT` or `REFUSED` with the driver's next command in `then`; `lanes-join <ticket> [--holder H]`; `lanes-hand-back <ticket> --lane L --reason "<why>" [--holder H]`. The belt (`workflows/belt.js`) runs `buildLanes` for the step, with `cleanLanes` checking the relay's copy and at most 8 lanes started at once; the run skill does the same in a conversation (its **Building in lanes**).

The calculator (`skills/build/scripts/lanes.py`): `show <plan.md> [--json]`; `measure --project <folder> [<ticket>...] [--json] [--worktree-seconds N] [--landing-seconds N]`, or `measure <cell folder or archive .tar.gz>...`. It reads only. `measure` reads each ticket's live cell or, failing that, its newest archive, in memory and never extracted. It applies the lane rule to every plan, with or without the headings, so for a plan written the old way it says what the plan's shape would have allowed, not what MACH does with that plan today.

### Settings

| Setting | Default | What it does |
|---|---|---|
| `build.max_lanes` | 3 | How many lanes one ticket may run at once. 1 builds one task at a time. Anything but a whole number of at least 1 reads as 3. |
| `factory.max_builders` | `factory.max_parallel` (3 when that is not set) | Builders on this machine across tickets. Lanes take only the places other building tickets leave free; a ticket with open lanes always keeps one. |

`factory.claim_minutes` (default 90) also decides when a lane whose builder has gone quiet may be handed to another holder. `templates/config.json` names neither new setting: the defaults hold without a key.

### What the Factory Floor shows

`GET /api/v1/cells/{ticket}` gains `lanes` for a build in lanes (`M6_1_EVENT_CONTRACT.md` section 10.8). On the Line, from the Build column on, a ticket built in lanes has a strip under its row: one chip per lane (its current task and how many of its tasks are done, waiting for a free place, done, landed, or set aside), the marker at Build saying how many lanes there are, and the moment of the join: every lane done and the join next, "The lanes are being joined" while it runs, a join that stopped and landed nothing with every lane's work kept, joined with the whole suite passing, a lane set aside, or a failure only when joined and the fix task. The ticket's side panel adds a Lanes part: its tasks grouped before the lanes, by lane and after the lanes, each with its time, and the lanes' wall time against their summed time. A ticket without lanes, or whose lanes were never opened, is shown as before.

### Known limits

- **It only helps plans written for it.** A plan without a part heading or an `after` mark is built one task at a time. How much faster a build in lanes is depends on how many independent parts the slice has, how even the lanes are, and how much of a task's time is its test run; where the test suite already keeps every core busy, lanes mostly wait for each other's tests.
- **A lane's task time includes idle time.** A lane's time runs from its first to its last call to the station, and each task's time is the clock since the previous step, so a builder that waits, or a driver slow to start the next batch, is counted.
- **Token use rises by default.** Each lane's builder reads the plan, the spec, the contracts, the ADRs and the code next to its files again: with L lanes, about L−1 extra readings, plus the clerk calls and any fix task. MACH records cost only for supervised executions, as one total per execution; nothing per lane is recorded or estimated. A project that wants the old cost sets `build.max_lanes` to 1.
- **Nothing has been run with real agents.** Lanes, hand-backs, set-asides, joins and the fix task have been run only with scripted builders in tests.
- **The measuring tool's numbers are estimates.** `lanes.py measure` works out what a past build would have taken in lanes from its recorded steps; the time to make worktrees and to land is assumed (30 seconds each unless given), the time to read the ground is inferred from the first task, and every figure is labelled as an estimate.
- **What a test suite needs that Git does not hold** (installed packages, a virtual environment, `node_modules`) is not made in a lane's worktree by MACH.
- **Suites that use a fixed port, a shared database or a fixed temporary path** can fail when lanes run their tests at the same time.

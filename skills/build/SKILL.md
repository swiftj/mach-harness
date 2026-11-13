---
name: build
description: Builds one groomed MACH ticket inside its isolated cell using strict test-driven development, following the cell's plan.md task by task. Writes each failing test before the code that satisfies it, with scripted gates that refuse out-of-order work, edited tests and changes outside the plan. Use when asked to build, implement or construct a ticket or slice that has been groomed, to continue a build, or to revise one after a rejected review.
argument-hint: "[ticket ID] [--revise findings-file]"
compatibility: "python3 >= 3.8, git"
---

# MACH Build: Test-Driven Construction

Input: $ARGUMENTS

You are the factory's builder: a software engineer who implements one ticket inside its cell, test first, exactly as planned. You do not decide what to build; `spec.json` did. You do not decide the order; `plan.md` did. You do not judge your own work; the verify and review stations do. Your craft is in writing a test that truly proves the requirement, and the smallest clean code that satisfies it.

`BUILD` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/build.py"`. It is the gatekeeper: it runs the tests, decides whether a step counts, and makes every commit. A step it refuses did not happen.

## Rules

1. **Work only in the cell.** Every file you create or change is under the `workdir` that `BUILD start` prints (`.factory/worktrees/<ticket>/repo/`). Never edit the main checkout, and never run git commands that commit, stage, reset, stash, rebase or switch branches: `BUILD` makes the commits.
2. **Test first, and see it fail.** For a `[test]` task, write only the test. `BUILD red` must see the suite fail because of it before you write the code. Never write implementation and its test in the same step.
3. **One task, one task's worth.** Write only what the current task names: its test, its scenario, its cases. Do not write later tasks' tests early, even when they belong in the same file and you can see them coming. A task that does the next task's work leaves that task with nothing to commit, and the line stops.
4. **Make the code fit the tests, never the reverse.** Once a test is committed it is frozen. If it fails, the code is wrong. Do not edit, skip, weaken or delete it, and do not write code that detects the test and special-cases it.
5. **The spec is the truth.** Assert the exact messages, outcomes and side effects in `spec.json`, character for character. If the spec seems wrong, contradicts itself, or cannot be built, stop and report a **spec defect**; do not patch it, and do not build your own interpretation.
6. **The plan is the scope.** Do the task as written, in order, touching only the files the plan gives it. No extra features, no drive-by refactors, no new dependency the plan did not name. If the plan cannot be followed, stop and report a **plan defect**.
7. **Never bypass a gate.** If `BUILD` refuses a step, fix the cause. The override flags (`--allow-extra`, `--amend-test`, `--covered`, `--written-early`, `--unrelated-failure`, `--already-done`) are for the rare case where the refusal is wrong for this task; each needs a true, specific reason, and every use is reported to the reviewers. Never use one to get past a failure you do not understand.
8. **No self-certification.** You never describe the ticket as done, working or verified. You report that it is built and what `BUILD finish` recorded.
9. **One plain command per call.** The Factory runs this station unattended with a short list of allowed commands, and anything else is refused, not asked about. Every shell command you run is one `BUILD` command, written out in full with the script's absolute path; `BUILD` runs the tests and makes the commits, so you need no other. To see the cell's history, use `BUILD next` and the cell's files, not `git` in another folder. Never chain commands (`&&`, `;`, `|`, a second line), never redirect (`>`, `<`, `2>&1`, a heredoc), never `cd`, and never set shell variables or define functions. Read files with the Read tool, find them with Glob and Grep, and create or change them with Write and Edit. If a command is refused, do not try another shape of it: report what was refused.

## Steps

### 1. Start

Run `BUILD start <ticket>`. It checks, and refuses with a reason if any fails:

- the readiness audit allows building (a Bronze repository only builds tickets labelled `repo-hardening`);
- the ticket is groomed: the cell's stage is `planned` and the spec has not changed since;
- the cell is isolated on its own branch and has no stray changes;
- the tests pass in the cell before you touch anything.

If it says no test command is known, find the one the plan's Tasks section or the project documents and pass it with `--test-cmd`. Do not invent one. If the tests fail at the start only because the project has no test suite yet, and the audit gate is switched off or this is a hardening ticket, add `--no-baseline "<why>"`; it is recorded for the reviewers. If it says building has already started, the build is being resumed: go to step 3 and continue from `BUILD next`. If it refuses for any other reason, report the reason and stop: do not work around it.

If the input has `--revise`, see Revision rounds instead.

### 2. Learn the ground, once

Before the first task, read in the cell: `plan.md` in full, including Engineering decisions; the contract files it lists; the project's `CLAUDE.md`; and the existing code and tests next to the files you will touch, so your code matches their layering, naming, error handling and test style. Do not read the whole repository.

For anything a user sees (a web, desktop or mobile slice), also find the design system before writing any interface: the component folder (such as `src/components/ui`), the design tokens (theme file, CSS variables, Tailwind config), and how existing screens use them. Then:

- reuse an existing component before creating one;
- use tokens for every color, space and size; no hard-coded colors, no inline styles;
- use semantic elements, label every control, keep everything reachable by keyboard, and respect the project's dark mode if it has one.

`BUILD finish` lists hard-coded styling it finds for the reviewers.

### 3. Work the tasks

Repeat until `BUILD next <ticket>` says all tasks are done:

1. Run `BUILD next <ticket>`. It prints the task, the files it may change, and the exact spec text it must satisfy. Work from that, not from memory.
2. Do the task, then complete it with the command it names:

| Task | You write | Complete with | The gate requires |
|------|-----------|---------------|-------------------|
| `[test]` | Only the test | `BUILD red <ticket> <task>` | The suite fails. |
| `[impl]` | The smallest code that passes | `BUILD green <ticket> <task>` | The whole suite passes; no committed test changed. |
| `[contract]`, `[refactor]`, `[docs]` | What the task says | `BUILD done <ticket> <task>` | A green suite stays green. |

**Writing a test.**
- Name the spec ID each test proves (`FR-04`, `INV-01`, `AC-03`) in its name, docstring or a comment; `BUILD finish` checks every ID is named.
- For the decision matrix, write one table-driven test that reads the cases from `decision_matrix.cases` in the cell's `spec.json` content: copy the cases into the test as data, one row per case, keeping each case ID (`R2-3`). Assert the expected outcome with its exact message, and the side effects, including that a refusal changes nothing.
- For a scenario, follow its Given, When, Then steps with the scenario's own data. Simulate outside services, including the failure the scenario describes. Control the clock; never sleep.
- Check that the test fails for the right reason: the behavior is missing, not a typo, a broken test command, or an error before your test is reached. `BUILD red` refuses a failure whose output never mentions your test file. If the test command itself is wrong, stop and report a plan defect at this first task; do not carry on with a suite that cannot run.

**If a `[test]` task has nothing left to write** because an earlier task already committed its test, do not pad the file or touch the build state. Check that the committed test really covers what this task names, then complete it with `BUILD red <ticket> <task> --written-early "<which task committed it>"`.

**If an `[impl]` task has nothing left to change** because an earlier task in this plan already implemented it, `BUILD green` refuses with "changed no files". Do not add a needless edit to get past it. First confirm that the committed tests really prove what this task names: run `BUILD next <ticket>` and check that each spec ID it lists is named by a committed test. Then complete it with `BUILD green <ticket> <task> --already-done "<which earlier task implemented it, and how>"`. `BUILD` accepts it only when the task changed no files, committed tests name every spec ID the plan gives the task, and the whole suite passes; it makes no commit and reports the deviation to the reviewers. Never use it to skip work you have not done or to get past any other refusal. If it refuses, report the refusal; do not reshape the command or change files to make it pass.

**If `red` says the test passes already,** look first for a test that asserts nothing or never runs. Only when an earlier task's code truly satisfies it, rerun with `--covered "<task> already implements <what>"`.

**Writing code.** The smallest change that makes the failing tests pass, in the project's existing structure: logic in the service layer, not in handlers or views. No unused helpers, parameters or imports; no commented-out code; no file that grows past what one person can review.

**If `green` fails,** read the failure and fix the code. If after three honest attempts the suite still fails, stop and report where you are stuck; do not loosen a test.

### 4. Finish

Run `BUILD finish <ticket>`. It reruns the suite and the linter, and checks that every task is done, nothing is uncommitted, and every spec ID is named by a test. Fix what it reports and rerun. Fix lint findings in the code; do not disable rules.

On `BUILT` it writes `build-report.json` in the cell. Report, briefly and without claiming the work is correct:

- that the ticket is built, on which branch, with the diff size;
- how many tests were seen failing first, and any that passed on their first run;
- every deviation the gates recorded, with its reason;
- whether a person must review it;
- that it now goes to the verify station.

Record the same on the ticket with the ticket skill if it is installed, setting its state to `needs_review`.

## Revision rounds

When review or verification sends a built ticket back, run `BUILD revise <ticket> --findings <file>`. It counts the failed round. A ticket gets three rounds of verification and review in all: two revisions, and the third failure is escalated.

- `REVISING`: read the findings. For each one, add a task with `BUILD add-task <ticket> --kind <kind> --text "<what to fix> (<spec IDs>)" --file <path>`. A finding about wrong behavior gets a `[test]` task that reproduces it first, then an `[impl]` task. Then work the tasks as in step 3 and finish again. Address every finding; do not argue with one in code.
- `ESCALATE`: this was the third failed round. Do not build. Label the ticket `blocked-requires-sme`, set its state to `blocked`, and report to a person with the findings that remain.

## Stopping early

Stop and report, rather than improvise, when: a gate refuses to start; you find a spec or plan defect; a tool the tests need is missing; or the suite will not go green after three attempts. Say which task you were on and what you observed. The cell keeps its state, so the build resumes from `BUILD next`.

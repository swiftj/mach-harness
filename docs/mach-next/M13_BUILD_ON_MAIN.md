# M13 part B, layer 3: build on today's main (as built)

Design: `docs/mach-next/M13_DESIGN.md`, part B, "Layer 3". Built 2026-11-20. Layers 1, 2 and 4 are not part of this.

## What was built

The build station brings the ticket's branch up to date with the main checkout's committed HEAD at two moments only: `build.py start` and `build.py revise`. Code: `bring_up_to_date` in `skills/build/scripts/build.py`.

| Case | What happens |
|---|---|
| Already up to date (main's HEAD is an ancestor of the branch) | Nothing. No commit, nothing recorded. |
| Clean merge | One merge commit on `feature/<ticket>`, made by the station (`git merge --no-ff`): `Merge <main> into <branch> before building [<ticket>]` at start, `... before revision <n> [<ticket>]` at revise, in the style of the merge station's `Merge <main> into <branch> before landing [<ticket>]`. Recorded in `build.json` and, at finish, in `build-report.json` under `main_merges`. |
| Conflict | The merge is aborted; the branch, the tree, the stage and the round count are exactly as before. The step is refused with the merge station's words: "`<main>` has moved on ..., and bringing the branch up to date conflicts in `<files>`. A person must merge `<main>` into `<branch>` in `<folder>` and resolve it". The conflict is recorded in `cell.json` as `main_conflict` for the routing sheet. |
| Merge would change the slice spec | Aborted before committing; nothing changed; refused with `spec-changed` (regroom). |

The record of a merge (`main_merges[]`): `when` (`start` or `revise`), `loop`, `by` (`build station`, or `a person` when a person resolved a conflict), `main`, `main_commit`, `branch_commit` (the branch before the merge), `merge_commit`, `behind` (how many commits of main the branch did not have), `at`, and at revise `tests_after` (the suite's result on the merged code).

### Tests after the merge

- **At start**, the existing gate "the tests pass before anything is touched" runs on the merged result. If it fails after a merge, the refusal (`baseline-red-after-main`) says that main was merged in, that nothing has been built for the ticket yet so its own work is not the cause, and, when the audit tier is Gold or Silver (so main's own tests passed at that commit), that the failure comes from what the branch held from grooming (spec and contracts) with main's newer code. The merge stays on the branch and stays recorded: `build.json` is written as soon as the merge is made, and a later start carries forward every earlier start merge still on the branch.
- **At revise**, the whole suite is run after a merge. A revision cannot be refused for it (the ticket must be revised anyway), so a failure sets the suite to red and the output says in plain words that the suite passed when the ticket was last built and fails now that main is merged in; the revision must make it pass again. The `green` and `finish` gates then hold the builder to that as usual.

### The routing sheet

No existing stop fitted: `merge` is the approved branch waiting for a person to merge, and `person-to-take-over` means escalation. One stop was added: `needs: "main-conflict"` from `run.py next`, with `files` and `folder`.

- It stops while the stage is `planned` or `built`, the cell has `main_conflict`, the branch is still the commit it was at the conflict, and main's HEAD is still the commit that conflicted.
- When main moves on, the stop lifts and the builder tries again (a newer main may merge cleanly; if not, a new record is made).
- When a person commits the merge in the cell: at `planned`, the routing sheet says `build`; at `built` after a revise conflict, it says `revise` with the findings path recorded at the conflict (without this, the moved branch head would no longer match the rejected decision's head and the routing sheet would wrongly say `verify`). The next start or revise records the person's merge (`by: "a person"`) and removes `main_conflict`.
- `decide.py` walks it as state `main-conflict`: the conflicting files and the folder, then "Resolve it, then carry on" (run it again), "Plan it again" where `replan` is accepted, and "Abandon the ticket". Nothing is recommended by rule. `NEEDS_TEXT` gives the notification's fixed sentence.

## Each choice

1. **Only at start and revise.** `next`, `red`, `green`, `done`, `add-task` and `finish` never merge, and `start` on a build already under way refuses as before. At start no task is done; at revise every task of the build is done (revise starts only from a built cell). So a merge can never fall inside a red-to-green pair, and a test's "seen failing" record is never taken on different code from its implementation.
2. **The merge commit is not a task.** It is made by the station, not by `complete`, so it is not judged by scope, frozen tests or the secrets scan. Every task gate compares with HEAD, which after the merge already holds main's work: files and tests main brought are not "changed" by the next task, other tickets' test files are never added to this ticket's frozen `test_files`, and a credential-shaped line from main is never this ticket's added line. A test file from main that this ticket's revision must change still counts as a committed test only if this ticket's own `[test]` task committed it.
3. **The last whole-suite run stands only on the tip.** The existing shortcut (finish reuses the last task's passing whole-suite run when its commit is the branch tip) needed no change: after a revise merge the tip is the merge commit, so the suite runs again.
4. **The build report shows only the ticket's own changes.** With no merge since the build started, `files_changed`, `diff` and the styling findings are `baseline..HEAD` as before. Once main has been merged in after the baseline (at revise, or by a person), they are the files the branch's own first-parent, non-merge commits touched, compared with the branch's merge base with main (`compared_with`). The start merge happens before the baseline is recorded, so it never needed this.
5. **The spec check is made before the merge is committed** (`--no-commit`), so a merge that would change the spec leaves nothing behind. The plan lives in the cell folder, outside the branch, and is unaffected.
6. **ADRs.** The cell's `adrs` record (what the plan was made under, with digests and kept copies) is never touched. An ADR changed on main reaches the branch with the merge and binds tickets planned afterwards, as before; it is not this ticket's change (the task gate's ADR-folder check and review's ADR refusal look at the ticket's own changes only).
7. **A project with no git history** has no `repo/`, and `start` already refuses until the first commit; the worktree made then starts at main's HEAD, so it is up to date and nothing is merged. Without a worktree the station never merges.
8. **Uncommitted changes** refuse a merge (the tree must be clean, as at start). A merge that fails without a conflict (for example an untracked file in the way) is aborted and refused with git's own message (`main-merge-failed`).
9. **The escalating revise does not merge**: the round-limit check comes first.
10. **The setting.** `build.update_from_main` in `.factory/config.json`, default `true` (added to `templates/config.json`). `false` switches it off at start and revise; the report records `main_merges.enabled: false`, and a start whose tests fail no longer claims the branch is up to date with main.
11. **Telemetry.** `station.entered` keeps its boolean `synced_with_main` at start and now also carries it at revise. No new event.

## What review and merge need from other parts

- **Review's whole-ticket diff is already right.** `review.py start` diffs from `merge-base(HEAD, main)`, which after a station merge is the merged main commit, so main's work is not shown as the ticket's.
- **Review's delta diff is not.** For a later round it diffs `earlier round's head..head`. After a revise merge, that range includes every main commit merged in, so `delta.patch` and `delta.files_changed` would show other tickets' changes as this ticket's, and `submit` would accept a blocker on those files as "changed in this round". What review needs, without any change here: when `build-report.json` `main_merges.merges` holds an entry whose `branch_commit` is the earlier round's `head` (equivalently, whose `merge_commit` descends from it and is an ancestor of the new head), use that entry's `merge_commit` as `since_commit`, and compute `delta.patch` and `delta.files_changed` from `merge_commit..head`. That range is exactly the revision's own work. If several entries match, take the last. An entry with `by: "a person"` carries the commit the revision started from as `merge_commit`, so the same rule holds. The test `ReviseTest.test_a_clean_merge_at_revise_is_recorded_and_kept_out_of_the_tickets_changes` shows both ranges. `review.py` was not edited.
- **The approved-commit binding is unaffected.** A revise merge happens before verification and review of the new round, so the approved commit already contains it. The merge station's revalidation still merges main again only if main moved after approval, and finds nothing to do otherwise.
- **Layer 4 (at the merge)** is not built here.

## Changes outside `skills/build/`

- `skills/run/scripts/run.py`: the `main-conflict` stop and the person-resolved `revise` in `next_step`; one `NEEDS_TEXT` line; the module docstring.
- `skills/run/scripts/decide.py`: the `main-conflict` state (classify, summary, options, one data field).
- `skills/run/SKILL.md`: one row in the table of stops.
- `templates/config.json`: `build.update_from_main: true`.
- `tests/test_mach_notify.py`: the list of waits that send a notification gains `main-conflict`, so the expected list and the last message changed.
- `tests/test_build.py`: the existing conflict test asserts the new words.
- `CLAUDE.md`, `agents/builder.md`, `skills/build/SKILL.md`: short notes.

## How far tested

`tests/test_build_on_main.py` (16 tests) runs the real `build.py`, `run.py next` and `decide.py` on temporary git repositories:

- start: up to date records nothing; a clean merge is one commit with both parents and is recorded in `build.json` and the report, and main's files are not in `files_changed`; a conflict changes nothing, records `main_conflict`, makes `run.py next` stop with `main-conflict` and `decide.py` offer its options, and after a person's merge the build starts and records it; the stop lifts when main moves on; a suite that fails only after the merge names the cause, keeps the merge recorded, and a later start carries it; the setting switches it off; the plan's ADR record is unchanged and main's ADR edit is not the ticket's; a credential-shaped line from main does not trip the secrets gate;
- a resumed build: no merge between start and finish, `start` refuses, and the last whole-suite run still stands;
- revise: a clean merge is recorded with the tests after it, main's changed test and files are not judged as a task's change, the report keeps them out and `compared_with` is main's commit, and the delta ranges review would need are shown; finish right after a merge reruns the suite; up to date records nothing and the shortcut stands; a suite that fails after the merge is said and must be fixed (main's test is not frozen for this ticket); a conflict changes nothing, uses no round and copies no findings, the routing sheet stops, and after a person's merge it says `revise` with the findings and the revision records it; the escalating round does not merge;
- a project groomed before it had history: the worktree starts up to date, and a later revise whose merge would change the spec is refused with nothing changed.

Not tested: a main checkout whose HEAD is on a branch other than the default (the station merges whatever that HEAD is, as the merge station does); git hooks that refuse the merge commit (aborted and refused, not exercised); the Factory Floor's display of the new stop (it shows the stop's reason as for any other).

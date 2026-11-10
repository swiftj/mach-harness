---
name: cleanup
description: Cleans up after a finished MACH ticket. Archives the cell's artifacts (intent, spec, plan, build report, review votes, evidence) to .factory/archive/, removes the cell's git worktree, folder and local feature branch, and appends a run record that the observe station learns from. Use after a ticket's branch has been merged, when asked to clean up, tear down, close out or archive a ticket or cell, to abandon a ticket that will not be finished, or to list leftover and broken cells.
argument-hint: "[ticket ID] [--merged-as <commit>] [--abandon \"<why>\"] | orphans [--prune] | status"
compatibility: "python3 >= 3.8, git"
---

# MACH Cleanup: Archive and Tear Down

Input: $ARGUMENTS

You are the factory's janitor. A merged ticket leaves behind a worktree, a branch and a folder of artifacts. Your job is to keep the artifacts, remove the rest, and leave a record of how the run went. This is the one station that deletes things, so it deletes only what a script has checked is safe to delete.

`CLEANUP` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/cleanup.py"`. Run it from the project's main checkout, never from inside a cell. It decides whether a cell may be removed, archives it, checks the archive, and only then removes anything.

## Rules

1. **Plan first, and show it.** Always run `CLEANUP plan` before `CLEANUP run`, and tell the user what will be archived and what will be removed before you remove it.
2. **This station does not merge.** If the script says the branch is not merged, report that and stop. Do not merge, rebase, push or cherry-pick to make the gate pass, and do not edit `cell.json` to change the stage.
3. **Never abandon on your own.** `--abandon` removes unmerged work from the repository, keeping only an archived copy. Pass it only when the user, or the station that called you, explicitly asked to abandon that ticket, and use their reason, not one you wrote. A refusal is never a reason to try `--abandon`.
4. **Never guess a commit.** `--merged-as <commit>` says the ticket's work landed on the default branch as that commit, through a squash or rebase merge. Use it only when the user gave you the commit, or you read it from the tracker's merged pull request for this ticket. Do not pick one from `git log` because its message looks right.
5. **Delete nothing by hand.** No `rm`, no `git worktree remove`, no `git branch -d` or `-D` of your own, and never anything on a remote. If the script will not remove something, report why.
6. **Leave the main checkout alone.** Do not format, fix or commit code there. Cleanup changes no source file.

## Steps

### 1. Plan

Run `CLEANUP plan <ticket>`, adding `--abandon "<why>"` only under rule 3 and `--merged-as <commit>` only under rule 4. It changes nothing and prints:

- `allowed`, and `refusals` when it is not;
- `stage`, `branch`, `default_branch`, `merged`, and `merged_as` when you gave a commit and it was accepted;
- `uncommitted`: files in the cell's worktree that are not committed;
- `would`: the archive it would write and its members, the worktree and folder it would remove, the branch command it would run.

If `allowed` is false, report each refusal as it is and stop. What they mean:

| Refusal | What to tell the user |
|---------|-----------------------|
| The branch is not merged | Merge the approved branch, then run cleanup again. If it was merged as a squash or a rebase, git cannot see that: ask for the commit it landed as, or read it from the merged pull request, and plan again with `--merged-as <commit>`. |
| `--merged-as` is not a commit, not on the default branch, or not newer than where the branch started | The commit is wrong, or the default branch has not been fetched. Report it; do not try other commits. |
| Merged, but review has not approved it | Someone merged early. The review station must finish; abandoning is not the fix. |
| Uncommitted changes | Someone must commit or discard them in the cell. |
| The cell folder or `repo/` is a symbolic link, or the branch is not `feature/<ticket>` | The cell is not what it claims to be. A person should look at it. |

If it is allowed, show the user the `would` section in a few lines.

### 2. Run

Run `CLEANUP run <ticket>` with the same arguments you planned with. In order, it:

1. writes `.factory/archive/<ticket>.tar.gz` with everything in the cell folder except the worktree `repo/`, and never overwrites an earlier archive (a second one is `<ticket>-2.tar.gz`);
2. checks the archive is complete; if it is not, it stops and deletes nothing;
3. removes the worktree, then the cell folder `.factory/worktrees/<ticket>/`;
4. deletes the local branch with `git branch -d`, which git itself refuses if the branch is not merged;
5. appends one line to `.factory/archive/runs.jsonl`: outcome, review rounds, verification failures, reviewer blockers, builder deviations.

With `--merged-as`, the outcome is `merged` and the branch is deleted with `-D`, because a squashed or rebased branch is never an ancestor of the default branch. The stage must still be `approved`.

With `--abandon`, the work is saved into the archive before anything is removed: the branch's commits that are not on the default branch as a git bundle (`branch.bundle`, checked with `git bundle verify`), uncommitted changes as `uncommitted.patch`, and untracked files under `untracked/`. Then the branch is deleted with `-D` and the record's outcome is `abandoned` with the reason. If the bundle cannot be written, nothing is deleted. The output's `restore` line says how to get the branch back: extract `branch.bundle` from the archive and run `git fetch <bundle> feature/<ticket>:feature/<ticket>`. Pass that on to the user.

Files that test runs leave behind (`__pycache__`, `.pytest_cache`, `node_modules`, coverage data and the like) do not count as uncommitted work and are not archived.

If `branch_deleted` is false, pass on `branch_note`: git kept the branch, usually because the merge is on the remote and the main checkout has not pulled it yet.

A cell that never had a worktree (`isolation: none`) is archived and its folder removed; nothing else is touched.

### 3. Close the ticket

Only after `run` succeeds, update the ticket with the ticket skill: state `closed`; for an abandoned ticket, also the label `abandoned` and a comment with the reason. The script does not do this.

### 4. Report

Briefly: the outcome, where the archive is, what was removed, whether the branch was deleted, for an abandoned ticket how to restore it, and that the ticket was closed. Mention that archives and `runs.jsonl` are local: `.factory/archive/` is git-ignored, so they are not shared or backed up by pushing.

## Leftovers

`CLEANUP status` lists every cell with its stage and whether its branch is merged.

`CLEANUP orphans` lists, and never removes, cells that look finished or broken: a branch already merged into the default branch, a cell folder with no `cell.json`, a cell whose worktree `repo/` is missing, and worktrees under `.factory/worktrees/` that git still records though their folder is gone. Use it when asked what can be cleaned up, or after a run that was interrupted. For each merged and approved cell, offer to run the steps above; for anything else, say what is wrong and let a person decide. `CLEANUP orphans --prune` also runs `git worktree prune`, which drops git's stale records and touches no files.

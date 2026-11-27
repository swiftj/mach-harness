---
name: cleanup
description: Cleans up after a finished MACH ticket. Removes the cell's git worktree, folder and local feature branch, keeps the cell's archive (intent, spec, plan, build report, review votes, evidence) in .factory/archive/ only when cleanup.archive or the person asks for it (by default no archive is kept), deletes an abandoned ticket's work for good unless the person asks to keep it, and appends a run record that the observe station learns from. Use after a ticket's branch has been merged, when asked to clean up, tear down, close out or archive a ticket or cell, to abandon a ticket that will not be finished, to clear what cleanup kept (forget), or to list leftover and broken cells.
argument-hint: "[ticket ID] [--merged-as <commit>] [--abandon \"<why>\"] [--keep-archive | --no-archive] | forget (<ticket> | --older-than <days>) [--confirm] | orphans [--prune] | status"
compatibility: "python3 >= 3.8, git"
---

# MACH Cleanup: Archive and Tear Down

Input: $ARGUMENTS

You are the factory's janitor. A merged ticket leaves behind a worktree, a branch and a folder of artifacts. Your job is to remove them, keeping what the project wants kept, and leave a record of how the run went. This is the one station that deletes things, so it deletes only what a script has checked is safe to delete.

`CLEANUP` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/cleanup.py"`. Run it from the project's main checkout, never from inside a cell. It decides whether a cell may be removed and what is kept, archives it when an archive is kept and checks the archive, keeps in Git what only the checkouts hold when none is, and only then removes anything.

## Rules

1. **Plan first, and show it.** Always run `CLEANUP plan` before `CLEANUP run`, and tell the user what will be archived and what will be removed before you remove it.
2. **This station does not merge.** If the script says the branch is not merged, report that and stop. Do not merge, rebase, push or cherry-pick to make the gate pass, and do not edit `cell.json` to change the stage.
3. **Never abandon on your own.** `--abandon` deletes the ticket's work from this machine for good: its cell, worktrees, local branch and every ref MACH kept for it under `refs/mach/`, with nothing archived. Only `--keep-archive`, on the person's own word, keeps it (in the archive). Pass `--abandon` only when the person explicitly asked to abandon that ticket, and use their reason, not one you wrote. Never suggest it: a ticket that stopped is carried on with a fix (`/mach decide <ticket>`). A refusal is never a reason to try `--abandon`.
4. **Never guess a commit.** `--merged-as <commit>` says the ticket's work landed on the default branch as that commit, through a squash or rebase merge. Use it only when the user gave you the commit, or you read it from the tracker's merged pull request for this ticket. Do not pick one from `git log` because its message looks right.
5. **Delete nothing by hand.** No `rm`, no `git worktree remove`, no `git branch -d` or `-D` of your own, and never anything on a remote. If the script will not remove something, report why.
6. **Leave the main checkout alone.** Do not format, fix or commit code there. Cleanup changes no source file.
7. **What is kept is the project's setting or a person's word.** Pass `--keep-archive` or `--no-archive` only when the user asked for that ticket's archive to be kept or not; never to get around a refusal. `forget ... --confirm` deletes what cleanup kept: run it only when the user asked to clear it, after showing them the list `forget` printed without `--confirm`.
8. **One plain command per call.** The Factory runs this station unattended with a short list of allowed commands, and anything else is refused, not asked about. Every shell command you run is one `CLEANUP` command, written out in full with the script's absolute path. Never chain commands (`&&`, `;`, `|`, a second line), never redirect (`>`, `<`, `2>&1`, a heredoc), never `cd`, and never set shell variables or define functions. Read files with the Read tool, find them with Glob and Grep, and create or change them with Write and Edit. If a command is refused, do not try another shape of it: report what was refused.

## Steps

### 1. Plan

Run `CLEANUP plan <ticket>`, adding `--abandon "<why>"` only under rule 3 and `--merged-as <commit>` only under rule 4. It changes nothing and prints:

- `allowed`, and `refusals` when it is not;
- `stage`, `branch`, `default_branch`, `merged`, and `merged_as` when you gave a commit and it was accepted;
- `uncommitted`: files in the cell's worktree that are not committed;
- `would`: the archive it would write and its members (`archive` is null when none is made), the worktree and folder it would remove, the branch command it would run;
- `raised_to_person`: each way a person decided something on this ticket, with where it is recorded; `archive_decision`: whether the archive is kept, the setting, whether the setting or a flag decided, and why; `keep_in_git`: what stays in Git when no archive is kept; `archive_then`: what happens to an archive made only for the publish command.

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

1. when the archive is kept, or a publish command is set: writes `.factory/archive/<ticket>.tar.gz` with everything in the cell folder except the worktree `repo/`, and never overwrites an earlier archive (a second one is `<ticket>-2.tar.gz`), then checks it is complete; if it is not, it stops and deletes nothing;
2. when no archive is kept: keeps in Git what only the checkouts hold (an abandoned ticket's uncommitted files, a lane's uncommitted files and unjoined commits) under `refs/mach/`; if that fails it stops and deletes nothing;
3. if `records.publish_command` is set in `.factory/config.json`, runs it once with the archive's path (no shell; `{archive}` and `{ticket}` are filled in, and without `{archive}` the path is the last argument). Its result is reported as `published` and kept in the run record; a failure never stops cleanup. When the archive is not kept here, the local file is removed after the command succeeds and kept when it fails;
4. removes the worktree, then the cell folder `.factory/worktrees/<ticket>/`;
5. deletes the local branch with `git branch -d`, which git itself refuses if the branch is not merged;
6. appends one line to `.factory/archive/runs.jsonl`, whatever the setting: outcome, review rounds, verification failures, reviewer blockers, builder deviations, `raised_to_person`, `archive_kept` (whether the archive was kept and why; `archive` is null when it was not), `kept_in_git` when something was kept in Git, and for a merged ticket the merge station's change record (`change_record`: its path, SHA-256 and commit), and the slice's Jira key (`jira`) when it has one.

With `--merged-as`, the outcome is `merged` and the branch is deleted with `-D`, because a squashed or rebased branch is never an ancestor of the default branch. The stage must still be `approved`.

With `--abandon` the plan's `in_words` says plainly that the work is deleted for good and how many unmerged commits and uncommitted files go: say it to the person before `run`. Remote branches and GitHub are never touched. With `--abandon --keep-archive`, the work is saved into the archive before anything is removed: the branch's commits that are not on the default branch as a git bundle (`branch.bundle`, checked with `git bundle verify`), uncommitted changes as `uncommitted.patch`, and untracked files under `untracked/`. Then the branch is deleted with `-D` and the record's outcome is `abandoned` with the reason. If the bundle cannot be written, nothing is deleted. The output's `restore` line says how to get the branch back: extract `branch.bundle` from the archive and run `git fetch <bundle> feature/<ticket>:feature/<ticket>`. Pass that on to the user. With `--abandon` and no `--keep-archive`, nothing is kept: the branch is deleted with `-D`, the refs MACH kept for the ticket are deleted, and `restore` is empty.

### What is kept

`cleanup.archive` in `.factory/config.json`, for a merged ticket: `"none"` (the default) keeps no archive; `"raised"` keeps the archive only for a ticket raised to a person, by rule from what the cell and the line record: a person's approval given or required, a person's send-back, a security or ADR exception, an escalated or blocked ticket or one that needed a person, a person's merge, take-over or re-plan; `"all"` keeps every one. An abandoned ticket is archived only with `--keep-archive`, whatever the setting. Anything else reads as the default, and the result says so in `setting_note`.

With no archive, nothing a person might want back is lost: every ref MACH kept for the ticket stays under `refs/mach/`, lane and join worktrees and `mach-lane/<ticket>/*` branches are still removed, and the result's `kept_in_git` lists every branch and ref kept, with what it holds and the exact `show`, `bring_back` (and `files_back` for files) and `delete` commands. Pass these on to the user. The evidence files are not kept; the change record names each with its SHA-256.

An archive already in `.factory/archive/` is never deleted by `run`. When there are some and the setting is not `"all"`, the first cleanup's result has `archives_from_before`, said once per project: pass it on.

### Forget

`CLEANUP forget <ticket>` lists what is kept for a finished ticket: its refs under `refs/mach/`, a branch an older cleanup kept for an abandoned ticket (only while it is where cleanup left it) and the archives its run records name. `CLEANUP forget --older-than <days>` lists the same for every ticket finished at least that many days ago. Without `--confirm` nothing is deleted; with it, exactly what was listed is deleted (rule 7). A ticket with a cell is refused or skipped, and `runs.jsonl` is never touched.

Files that test runs leave behind (`__pycache__`, `.pytest_cache`, `node_modules`, coverage data and the like) do not count as uncommitted work and are not archived.

If `branch_deleted` is false, pass on `branch_note`: git kept the branch, usually because the merge is on the remote and the main checkout has not pulled it yet.

A cell that never had a worktree (`isolation: none`) is archived and its folder removed; nothing else is touched.

### 3. Close the ticket

If `observe_due` is true, enough tickets have finished for the factory to learn from them. After closing the ticket, run the observe skill with `--auto` if you are running unattended or as part of the line; otherwise tell the user it is due.

Only after `run` succeeds, update the ticket with the ticket skill: state `closed`; for an abandoned ticket, also the label `abandoned` and a comment with the reason. The script does not do this. A slice handed over by Product Studio as a GitHub issue (`cell.json` `product.issue`) is different: do not close it, label it or comment on it. The Factory closes it itself, with `mach:shipped`, once its merge is on the integration branch; abandoned work stays open so the product manager's slice can be built again.

### 4. Report

Briefly: the outcome, whether the archive was kept and why (`archive_kept.reason`), what was removed, whether the branch was deleted, what is kept in Git and the commands from `kept_in_git`, for an abandoned ticket that its work was deleted (or, with `--keep-archive`, how to restore it), whether the publish command ran and how it went, `archives_from_before` when present, and that the ticket was closed. Mention that archives and `runs.jsonl` are local: `.factory/archive/` is git-ignored, so they are not shared or backed up by pushing. What is shared is the change record the merge station landed with the code (`docs/changes/<ticket>.md`), which names each evidence file with its SHA-256.

## Leftovers

`CLEANUP status` lists every cell with its stage and whether its branch is merged.

`CLEANUP orphans` lists, and never removes, cells that look finished or broken: a branch already merged into the default branch, a cell folder with no `cell.json`, a cell whose worktree `repo/` is missing, and worktrees under `.factory/worktrees/` that git still records though their folder is gone. Use it when asked what can be cleaned up, or after a run that was interrupted. For each merged and approved cell, offer to run the steps above; for anything else, say what is wrong and let a person decide. `CLEANUP orphans --prune` also runs `git worktree prune`, which drops git's stale records and touches no files.

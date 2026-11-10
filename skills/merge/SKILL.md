---
name: merge
description: Lands an approved MACH ticket. Checks that the branch is still the exact commit the review approved, brings it up to date with the main branch and reruns the tests if main has moved, then merges it, locally or through a pull request, according to the project's merge settings. Use after review approves a ticket, when asked to merge, land or ship an approved ticket, or to open its pull request.
argument-hint: "[ticket ID] [--by-person]"
compatibility: "python3 >= 3.8, git; gh for pull requests"
---

# MACH Merge: Land What Was Approved

Input: $ARGUMENTS

You are the factory's merge clerk. Review approved one specific commit. Your job is to make sure that commit, and nothing else, reaches the main branch, and that it still works on top of whatever has landed since. A script does the checking and the merging; you run it and report.

`MERGE` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/merge.py"`. Run it from the project's main checkout.

## Rules

1. **Never merge by hand.** No `git merge`, `git push`, `git rebase` or `gh pr merge` of your own. The script does each of these, in the right order and only after its checks.
2. **Never work around a refusal.** If the script refuses, the reason is the result. Do not edit `cell.json`, re-approve, resolve conflicts, or change settings to get past it.
3. **`--by-person` is a person's decision.** Pass it only when the user, in this conversation, has told you to merge this ticket themselves. It overrides the project's "a person merges" settings, never the approval checks.
4. **You do not judge the change.** Verification and review already did. You do not add opinions about whether it should land.

## Steps

1. Run `MERGE plan <ticket>` (add `--by-person` under Rule 3). It changes nothing and prints whether the merge is `allowed`, the `refusals` if not, and what it `would` do. If it is not allowed, report each refusal and stop. What they mean:

| Refusal | What happens next |
|---------|-------------------|
| Merging is manual, or this risk tier is merged by a person | A person merges, or tells you to with `--by-person`. |
| The approval was for a different commit | Something was added after review. Running `MERGE run` voids the approval and returns the ticket to verification; say so. |
| No approval, or a person's approval is missing | The review station has not finished. |
| The main checkout is on another branch, or has uncommitted changes | A person tidies the main checkout first. |

2. Run `MERGE run <ticket>` with the same arguments. In order, it:
   - confirms the branch is the approved commit;
   - if the main branch has moved since approval, merges main into the ticket's branch inside the cell and reruns the test suite on the result. A conflict stops for a person. A failing suite sends the ticket back to the build station with the failure as findings, and nothing is merged;
   - lands it: with `merge.method` `local`, a merge commit on the main checkout; with `pr`, it pushes the branch, opens a pull request describing the verification and review, and merges it at the approved commit.

3. Report the result as it is:
   - `MERGED`: the merge commit, and whether the branch had to be brought up to date first. The ticket is ready for cleanup.
   - `PR_OPEN` (exit code 3): the pull request's address, and why it is not merged yet, such as checks still running or branch protection. Run the skill again later; do not retry in a loop.
   - A refusal: the reason, and what the script did (voided the approval, or sent the ticket back with findings).

Record the outcome on the ticket with the ticket skill if it is installed.

## Settings

In `.factory/config.json` under `merge`: `mode` (`auto`: the line merges approved tickets itself; `manual`: a person does), `method` (`local` or `pr`), and `auto` (per risk tier, whether the line may merge without a person, such as `{"high": false}`).

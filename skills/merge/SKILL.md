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
5. **One plain command per call.** The Factory runs this station unattended with a short list of allowed commands, and anything else is refused, not asked about. Every shell command you run is one `MERGE` command, written out in full with the script's absolute path. Never chain commands (`&&`, `;`, `|`, a second line), never redirect (`>`, `<`, `2>&1`, a heredoc), never `cd`, and never set shell variables or define functions. Read files with the Read tool, find them with Glob and Grep, and create or change them with Write and Edit. If a command is refused, do not try another shape of it: report what was refused.

## Steps

1. Run `MERGE plan <ticket>` (add `--by-person` under Rule 3). It changes nothing and prints whether the merge is `allowed`, the `refusals` if not, and what it `would` do. If it is not allowed, report each refusal and stop. What they mean:

| Refusal | What happens next |
|---------|-------------------|
| Merging is manual, or this risk tier is merged by a person | A person merges, or tells you to with `--by-person`. |
| The approval was for a different commit | Something was added after review. Running `MERGE run` voids the approval and returns the ticket to verification; say so. |
| No approval, or a person's approval is missing | The review station has not finished. |
| The main checkout is on another branch, or has uncommitted changes | A person tidies the main checkout first. |
| `records.dir` is not a folder inside the repository, or overlaps the ADR folder | A person fixes the setting in `.factory/config.json`. |
| `tickets.jira.browse_url` is not a plain https address ending in `/` | A person fixes or removes the setting in `.factory/config.json`. |
| With `merge.method` `local`, the shared main (`origin/<branch>`) has commits this checkout's main does not have | A person pulls main into the main checkout, then the merge is run again. |

2. Run `MERGE run <ticket>` with the same arguments. In order, it:
   - when the repository has an `origin` remote, fetches the integration branch from it. If origin cannot be reached, nothing is merged and the refusal says so; report it and stop. With `pr`, from here on "main" means `origin/<branch>`, what is really on the shared main now (`compared_with` in the result). With `local`, main is the main checkout, but only when it already holds everything on `origin/<branch>`; otherwise nothing is merged and a person pulls first. With no remote, main is the main checkout as before;
   - checks that main does not already hold this slice: for a slice from Product Studio, this revision shipped from another Factory (refused, "SLICE-NNN was already shipped from another Factory ... Nothing was pushed or merged."; a pull request of this copy's own stays open, with a note to close it on GitHub); for any ticket, a spec this branch adds whose slice number main already holds under another file name (refused: two engineers took one number). Nothing is merged, pushed, opened or closed; report the sentence as it is, with the cleanup or renumber it names, and stop;
   - confirms the branch is the approved commit;
   - if the main branch has moved since approval, merges main into the ticket's branch inside the cell and reruns the test suite on the result. A conflict stops for a person. A failing suite sends the ticket back to the build station with the failure as findings, and nothing is merged. When the merge is clean and the suite passes, it also looks at what landed in between: if a landed commit changed a file this ticket also changed, or a landed slice's `Effects on shipped behaviour` changes, replaces or retires a shipped rule this ticket's spec lists (or one of a slice it depends on), the approval does not carry over. Nothing is merged, main stays merged into the branch, and the ticket goes back to be verified and reviewed on that result, with the reasons in `review/merge-recheck.md`; that uses no judging round unless the new verification fails. `merge.revalidate_overlap` `false` turns this check off;
   - writes the change record, `docs/changes/<ticket>.md` (`records.dir`), on the ticket's branch and commits it alone, so it lands with the change. It is text only: the why, the slice, the plan's tasks and the ADRs in force, every verification run with the SHA-256 of each evidence file, every review round with its votes, findings, a person's approval or send-back, security exceptions and the scan's answers, the builder's overrides, and the commits. It ends with a section for MACH, the facts release qualification reads on any machine: never edit a record after it lands, or its slice no longer qualifies. Free text is redacted, cut when long, and links nothing; anything still shaped like a secret refuses the record and nothing is merged. The approval still holds: the script accepts its own commit only when it adds exactly that file on top of the approved (or brought-up-to-date) commit. A pull request still open from an earlier run already has its record and gets no second one. With `records.enabled` `false` nothing is written;
   - lands it: with `merge.method` `local`, a merge commit on the main checkout, never pushed (with a remote, the result's `note` says main must be pushed for others to get it; report it); with `pr`, it pushes the branch, opens a pull request describing the verification and review and linking the change record, reads origin's main once more, and merges it at the approved commit with its record. If origin's main moved after the re-test, it merges nothing yet, says "moved again; re-validating" (`main_moved_again` in the result), re-tests on the new main and tries again, at most twice; a third move stops with the pull request left open. If GitHub merged onto a main that moved in the last instant anyway, the result has a `warning` saying so; report it word for word.

   A slice with a Jira key (from Product Studio, checked again at every step) has it at the start of the pull request's title (`KEY-123 <title>`) or of the local merge commit's message, and in the change record's header; with `tickets.jira.browse_url` set (an https address ending in `/`, such as `https://example.atlassian.net/browse/`), the pull request and the change record link it. Nothing calls Jira.

   Two things the pull request method adds:
   - If the slice came as a GitHub issue, the pull request's description says `Refs #<number>` for that issue (or `Refs owner/name#<number>` for an issue in another repository). It never says "closes" or "fixes": the Factory closes the slice's issue itself once it sees the merge on the integration branch.
   - Once the pull request is open, the script posts the findings of the review round that approved it, once, as one review comment. A finding on a line the pull request changes (or shows as context) is attached to that line; any other finding is listed in the review's summary. Reviewer text is masked for likely secrets, mentions are broken so nobody is notified, and long text is cut. If the review cannot be created, one plain comment is tried instead. A failure to post never stops or delays the merge; the result's `findings_posted` says what happened. Set `merge.pr.inline_findings` to `false` to turn this off.

3. Report the result as it is:
   - `MERGED`: the merge commit, whether the branch had to be brought up to date first, and the change record's path (`change_record`). The ticket is ready for cleanup.
   - `PR_OPEN` (exit code 3): the pull request's address, and why it is not merged yet, such as checks still running or branch protection. Run the skill again later; do not retry in a loop.
   - A refusal: the reason, and what the script did (voided the approval, or sent the ticket back with findings).

Record the outcome on the ticket with the ticket skill if it is installed.

## Settings

In `.factory/config.json` under `merge`: `mode` (`auto`: the line merges approved tickets itself; `manual`: a person does), `method` (`local` or `pr`), `auto` (per risk tier, whether the line may merge without a person, such as `{"high": false}`), `pr.inline_findings` (whether the pull request method posts the review findings on the pull request; on unless set to `false`), and `revalidate_overlap` (whether what landed on main since approval is checked against this ticket; on unless set to `false`).

Under `records`: `enabled` (the change record; on unless set to `false`) and `dir` (where it is written, `docs/changes` by default; never inside the ADR folder). `records.publish_command` is the cleanup station's, not this one's.

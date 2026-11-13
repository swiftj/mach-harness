---
name: audit
description: Audits whether a repository is ready for autonomous agents before the MACH factory builds in it. Scores build, tests, linting, contracts and git hygiene out of 100, assigns a Gold, Silver or Bronze readiness tier, and gates the pipeline. Use when the user asks whether a repo is ready for agents or for MACH, wants a readiness or health scorecard, a pre-flight check, or to harden a repository; and before the first build in a project.
argument-hint: "[--strict] [--fix] [--json]"
compatibility: "python3 >= 3.8"
---

# MACH Audit: Repository Readiness Scorecard

Input: $ARGUMENTS

You are the factory's pre-flight inspector. Agents working in a repository with a broken build, failing tests or no linter cannot tell their own damage from damage that was already there, and they compound it. Your job is to measure the repository honestly and say whether autonomous work may start.

A script does the measuring and the scoring. `AUDIT` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/audit.py"`. Run it from the project's main checkout, never from inside a cell.

## Rules

1. **The script's score is the score.** Never adjust it, round it up, or describe a tier the report does not state. You explain the result; you do not grade.
2. **Never make the audit pass by weakening the project.** Do not skip, delete or loosen tests, disable lint rules, or edit code so a check goes green. Fixing the repository is separate work that goes through a ticket.
3. **It runs the project's code.** The audit executes the project's own build, test and lint commands. If the repository is not one the user would build themselves, say so and stop.
4. **Do not guess commands.** Only pass a command you found written down in the repository.
5. **One plain command per call.** The Factory runs this station unattended with a short list of allowed commands, and anything else is refused, not asked about. Every shell command you run is one `AUDIT` command, written out in full with the script's absolute path; its exit status is in what it prints, so nothing needs to be added to the command (no `; echo $?`). A command you pass with `--test-cmd` and the like is a quoted argument, not a second command. Never chain commands (`&&`, `;`, `|`, a second line), never redirect (`>`, `<`, `2>&1`, a heredoc), never `cd`, and never set shell variables or define functions. Read files with the Read tool, find them with Glob and Grep, and create or change them with Write and Edit. If a command is refused, do not try another shape of it: report what was refused.

## Steps

1. Run `AUDIT run`, adding `--strict` or `--fix` only if the input has them. `--fix` only creates a missing `.gitignore`. The script prints the scorecard and writes `.factory/audit-report.json`. Exit code `0` is Gold or Silver; `1` is Bronze, or not Gold under `--strict`; `2` is an error to report as it is.

2. **If a build, test or lint command shows "No command found"**, the script could not detect it. Look for the real one where the project documents it: the README, the contributing guide, CI workflow files, package scripts. If you find it, rerun with `--build-cmd "<command>"`, `--test-cmd "<command>"` or `--lint-cmd "<command>"`, and tell the user they can save it under `audit.commands` in `.factory/config.json` so the next audit finds it. If the repository documents none, leave the check failed: a project with no documented way to run its tests is not ready.

3. **If a check is marked `??`**, it could not be verified here, usually because a tool is not installed. It scores zero, and an unverified build or test run is also a blocker. Say which checks these are and what would verify them, such as installing the tool and running the audit again; do not describe them as defects in the repository.

4. Report to the user, briefly:
   - the score, the tier, and what the tier means (below);
   - any blocker, first and plainly;
   - each pillar's score in one line;
   - the three most valuable improvements from the report's recommendations, with the points each would add;
   - where the report file is.

5. Act on the tier:

   | Tier | Score | What happens |
   |------|-------|--------------|
   | **Gold** | 90 to 100 | Full autonomy. Tickets go straight through grooming and building, and merge once review passes. |
   | **Silver** | 70 to 89 | Autonomous building is allowed, but a person must review every change before it merges. Say so. |
   | **Bronze** | under 70, or any blocker | Autonomous work is blocked until the repository is hardened. |

   A build or test suite that fails, is missing, or could not be run here is a **blocker**: the tier is Bronze whatever the score. Readiness is never granted on tests nobody ran.

6. **On Bronze, propose hardening; do not start it.** List the failed checks, most points first, as the work that would lift the tier. If the user asks you to file it, or the input has `--fix`, file one ticket titled "Harden repository for autonomous work" with the label `repo-hardening`, listing each failed check and its fix as an acceptance criterion. Use the ticket skill if it is installed. Hardening tickets are the one kind of work allowed in a Bronze repository, and a person reviews each before it merges.

## For other stations

`AUDIT gate` reads the last report and prints whether work may proceed, with exit code `0` (allowed) or `1`. It refuses when there is no report, when the report is for a different commit than the main checkout or older than `audit.max_age_days` (7 by default), or when the tier is Bronze. On Silver it sets `human_review_required`. A station that gets a refusal for a stale or missing report runs the audit again; it never proceeds on an old result.

## Settings

In `.factory/config.json` under `audit`: `gold` and `silver` (the tier thresholds, 90 and 70), `commands.build`, `commands.test`, `commands.lint`, `timeouts` (seconds, per command; tests are limited to 300), and `max_age_days`.

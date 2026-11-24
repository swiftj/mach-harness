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
   - each line under `notes`, in plain words. A note changes neither the score nor the tier and is never a blocker. When a required topic has no accepted architecture decision (ADR) on the main branch, the note names the topics; say what that means: "The project's basic technical decisions (here: the database and how it is deployed) are not written down yet, so no ticket will be planned or built until they are. `/mach adr baseline` drafts them from the repository for an engineer to correct, accept and commit." The note is not part of the score: the hold is at planning, not here. When ADR files cannot be read, say that planning waits until an engineer fixes them by pull request;
   - where the report file is.

5. Act on the tier:

   | Tier | Score | What happens |
   |------|-------|--------------|
   | **Gold** | 90 to 100 | Full autonomy. Tickets go straight through grooming and building, and merge once review passes. |
   | **Silver** | 70 to 89 | Autonomous building is allowed, but a person must review every change before it merges. Say so. |
   | **Bronze** | under 70, or any blocker | Autonomous work is blocked until the repository is hardened. |

   A build or test suite that fails, is missing, or could not be run here is a **blocker**: the tier is Bronze whatever the score. Readiness is never granted on tests nobody ran.

   **Say what the result means, not the medal.** A person does not know what Gold, Silver or Bronze mean, or what the score ranges are. Lead with the plain meaning; give the tier's name and the score once, in brackets, only as the factory's own label for it:

   | Result | Say |
   |---|---|
   | Gold | "This repository is ready. The factory can build here and merge its own work once review passes. (Readiness: Gold, 93 of 100.)" |
   | Silver | "This repository is mostly ready. The factory can build here, but a person must approve every change before it merges. (Readiness: Silver, 78 of 100.)" Then the one or two things that would make it fully ready. |
   | Bronze | "This repository is not ready yet, so the factory will not build here. What needs fixing first: …" and list the failed checks in plain words, most important first. (Readiness: Bronze, 61 of 100.) |
   | The build or the tests fail, are missing or could not be run | "The factory will not build here until the project's own build and tests run cleanly: …" whatever the score. |

   Never give only a tier and a number. Never say a repository "scored" or "came back" a tier.

6. **On Bronze, propose hardening; do not start it.** List the failed checks, most points first, as the work that would lift the tier. If the user asks you to file it, or the input has `--fix`, file one ticket titled "Harden repository for autonomous work" with the label `repo-hardening`, listing each failed check and its fix as an acceptance criterion. Use the ticket skill if it is installed: it files the ticket where `tickets.provider` says (on GitHub, an issue whose number is the ticket), or on this computer with the reason when the tracker cannot take it; pass its note on. Hardening tickets are the one kind of work allowed in a Bronze repository, and a person reviews each before it merges.

## For other stations

`AUDIT gate` reads the last report and prints whether work may proceed, with exit code `0` (allowed) or `1`. It refuses when there is no report, when the report is for a different commit than the main checkout or older than `audit.max_age_days` (7 by default), or when the tier is Bronze. On Silver it sets `human_review_required`. A station that gets a refusal for a stale or missing report runs the audit again; it never proceeds on an old result.

## Settings

In `.factory/config.json` under `audit`: `gold` and `silver` (the tier thresholds, 90 and 70), `commands.build`, `commands.test`, `commands.lint`, `timeouts` (seconds, per command; tests are limited to 300), and `max_age_days`.

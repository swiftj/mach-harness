# M14: Lessons from the AI-native SDLC playbook

Design, 2026-11-20. Status: proposed. Each part says what was built in its own as-built document.

Anthropic's "AI-native SDLC playbook" (August 2026) describes the same artifact chain MACH runs. Four of its practices are missing from MACH, and a fifth need came from a product manager's bug report. The playbook's sandbox, managed settings and hooks are deliberately not part of this milestone (the product owner's decision).

| Part | What is added | Mostly in |
|---|---|---|
| A | Policy packs: organisation policies with named owners, applied while the spec is written, with flagged concerns | Product Studio, intent |
| B | Factory evals: past tickets replayed when the Factory's own rules or models change | observe, run |
| C | Design mocks: an approved picture bound to an interface slice, and the built screen shown beside it | Product Studio, verify |
| D | Intent from anyone: a small interview skill that files an idea as a request | new skill, Product Studio requests |
| E | Self-reporting: MACH files its own defects as GitHub issues, only on a person's yes | run |

## What does not change

- Specs stay the authority. Text from outside is data: it proposes, a person confirms.
- Product Studio never pushes, opens a pull request or starts a station. No new user-facing program.
- Nothing is sent anywhere without a person's explicit yes after seeing exactly what would be sent.
- No gate is weakened. Nothing here starts an unattended run on its own.
- Python standard library only.

## A. Policy packs

Product principles (M13) are the product's own rules. A policy is the organisation's: brand, security, privacy, compliance, accessibility, UX. The playbook's point is that policy is applied while the spec is written, and a spec that cannot satisfy it says so to a named owner, before engineering sees it.

- **Shape.** A pack is a folder in the repository, `policies/<pack>/policy.md` (`policies.dir` moves it), changed by pull request like an ADR: a header (`id: POL-<pack>`, `title`, `owner` as a role or team and a GitHub login or team where there is one, `status: active|retired`, `applies-to` in the ADR grammar) and numbered statements `POL-<pack>-NN`, each one RFC 2119 sentence. One shared reader, `skills/intent/scripts/policies.py`, finds, parses and selects them, reading committed state as `adr.py` does. A malformed pack is a problem with its reason, never silently skipped.
- **In the interview.** The interviewer reads the packs that apply before the first question, follows them in recommended answers, and makes any conflict the next question. A statement the slice cannot satisfy, or two statements that contradict each other for this slice, becomes a **flagged concern**.
- **In the spec.** A section `## Policies` lists each applicable pack with its commit digest and either "followed" or its concerns. A concern names the statement, says in one sentence why it cannot be met, names the owner, and carries a resolution: `open`, `accepted by <owner> on <date>: <their words>`, or `spec changed`. The validator is given the packs as an input (as it is given principles) and refuses a spec that leaves an applicable pack unanswered, misquotes a statement or cites one that does not exist.
- **The gate.** `slice ready` and `cell.py finalize` refuse while any concern is `open`. Recording an owner's acceptance is `policy accept <SLICE-ID> <POL-id> --by --reason`, on a person's explicit word, never recommended by rule, refused inside a supervised execution. Headless grooming records a concern as an open question, which blocks.
- **Downstream.** The section is part of the spec, so it reaches `spec.json`, the plan, the builder and reviewers. Each review seat checks the diff against the packs in its area (security seat: packs whose `applies-to` names `topic:security` or `topic:privacy`; product seat: brand, UX, accessibility). A blocker may cite a `POL-` statement only if the spec lists its pack. An accepted concern is shown as the owner's decision and is not the reviewer's to reopen.
- **Timing.** As with ADRs: a pack changed later binds slices marked ready afterwards; earlier work is flagged, never restarted.
- **Never.** The observe station and `factory-tuning` tickets do not change a pack.

## B. Factory evals

Today a change to a skill, a rule file or a model tier is judged by a review panel reading the diff. Nobody checks whether the Factory still does past work as well. The playbook's answer: keep real past tasks as a suite and rerun it when the agent's configuration changes.

- **A case** is built from a finished ticket's archive: the spec as data, the commit the work started from, and what happened (verdict, judging rounds, deviations, the tests' names). `eval collect` writes cases into `.factory/evals/cases/<case-id>/` from `.factory/archive/`, only for merged tickets, redacted, and never copies evidence media. A person may add a case by hand and may mark one `must_pass`. An escaped defect becomes a case with `eval add --from-ticket <id> --reason`.
- **A run** replays cases from planning through verification (not review, not merge) in throwaway clones outside the project, through the supervisor's existing executor so the same restricted permissions, tool list and spending limit apply. `eval run [--cases ...] [--limit n] --budget <amount>` only on a person's explicit command in conversation, refused inside a supervised execution, never scheduled by MACH. It records per case: planned or not, built or not, verification verdict, rounds, deviations, time and recorded cost; and for the run, the provenance snapshot (M6.5) of the configuration it ran under.
- **Compare.** `eval compare <run> <run>` is deterministic: pass rate, which cases changed outcome, cost and time, with the two configurations' digests. A missing value is never a pass.
- **Where it bites.** `eval status` says whether the rule files, skills, agents or model tiers changed since the last run (by digest). A `factory-tuning` ticket's review packet carries the latest comparison when one exists for exactly that change, and says "not evaluated" when none does. The panel decides as today; no threshold is enforced in this milestone.
- **Never** runs on the project's real checkout, touches real GitHub, merges or pushes. The dry-run mode (`--plan`) lists what would run and its ceiling, and spends nothing.

## C. Design mocks

- **Attach.** `slice mock add <SLICE-ID> <image file> [--note]` (PNG or JPEG, size-bounded, checked by content not extension) copies the picture into the draft workspace and records its SHA-256, size and dimensions in the work order. `slice mock remove`, `slice mock list`. Up to four per slice, each tied to a scenario (`--for AC-NN`) or to the slice as a whole.
- **Approve.** The mock's hashes join what the product manager approves at `slice ready` (in the approval, like the Jira key, so the why and spec hashes still identify the text). On GitHub the picture travels as a committed file in the ready folder form, or, for issues, is referenced by hash and delivered through the ready folder alongside; the design must not depend on uploading binary files to an issue through an API that does not exist. Intake verifies each file against its hash and keeps it in `.factory/intake/received/`, then in the cell under `mocks/`.
- **Verify.** For a `web`, `desktop` or `mobile` slice with mocks, the verifier must capture the built screen for each mock's scenario and record a side-by-side result: `matches`, `differs` with the differences listed in plain words, or `cannot compare` with the reason. `verify.py` requires one such record per mock; a `differs` is a finding the product seat judges, and is a failed check only when the spec says the mock is binding (`mock: binding` on the scenario). The Factory Floor's evidence player already shows images; the mock is catalogued as evidence so it appears beside the capture.
- **Never** generated by MACH, and never treated as a requirement on its own: the scenarios stay the authority.

## D. Intent from anyone

- A skill, `skills/idea/` (`/mach-idea`, `/mach:idea`), written so it also works when uploaded to claude.ai or Cowork with a GitHub connector: it interviews a person who is not an engineer, in their own words, one question at a time, and writes the result in one fixed template (problem, proposed outcome, who and what is affected, constraints, open questions, in the playbook's shape).
- It files the result as a GitHub issue using that template and a hidden marker, with **no label**: the person, or someone with the right, adds `mach:request` as today, so the M8 acceptance rule (a person with write access labelled it) is untouched. In Claude Code it can use `gh` on the person's yes after showing the text; elsewhere it gives the text to paste or files through the connector.
- Product Studio's `request show` recognises the template and presents the five parts separately, still fenced as data, still never answering an interview question. `request pick` carries the template's open questions into the interview as questions to ask first.

## E. Self-reporting

- **Catch.** One shared helper, `skills/intent/scripts/faults.py`, wraps each MACH script's `main()`. An internal error (an uncaught exception, never a refusal by a gate and never a wrong-usage exit) is recorded in `.factory/local/faults/<id>.json`: MACH's version, the script and command name (never its arguments' values), the exception type, a redacted and bounded traceback with paths reduced to paths inside MACH, the platform and Python version. Recording never changes the script's exit code or output, and a failure to record is silent.
- **Offer.** `/mach`, `/mach status` and `/mach doctor` say, in one line, when unreported faults exist. Nothing is sent.
- **Report.** `/mach report [<fault-id>]` (`run.py report`): builds the issue text from the fault record and `doctor`'s findings, redacts it with the shared rules and the secret shapes, shows the person the exact title and body, and files it only on their yes, as an issue on MACH's own repository (`report.repository`, default `swiftj/mach-harness`) with `gh`. Before filing it looks for an open issue with the same fingerprint (a hash of the script, exception type and the innermost MACH frame) and offers to add a comment instead. `--print` gives the text for a person to file by hand where `gh` cannot reach that repository. A report with no fault (`/mach report "<what went wrong>"`) carries the person's words and `doctor`'s findings.
- **Never** automatic, never inside a supervised execution, never includes repository names, ticket text, spec text, file contents or environment values. `report.enabled: false` in the tracked settings removes the offer and the command.

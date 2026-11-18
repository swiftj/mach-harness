# M11: Architecture decisions (ADRs), as built

What was built for section 7 of `M11_DESIGN.md`. The rest of M11 (issues, waves) is not part of this step. MACH's own
`docs/mach-next/ADRS.md` is a different thing and is untouched.

## The file

A project's ADRs are MADR files, `docs/adr/NNNN-title.md` (`adr.dir` in `.factory/config.json` moves the folder;
the scaffolded settings say `docs/adr`). People change them by ordinary pull requests.

```markdown
---
status: accepted
date: 2026-11-17
applies-to:
  - path:services/billing/**
  - app:api
  - topic:database
---

# Use PostgreSQL for every service's own data

## Context and Problem Statement
...
## Decision Outcome
...
```

- `status`: `proposed`, `accepted`, `deprecated`, `rejected` or `superseded by ADR-NNNN` (a Markdown link to the
  ADR is read too). Only `accepted` binds.
- `applies-to` (MACH's one field): `path:<glob>` (relative to the repository root; `*`, `**` and `?`; a folder name
  covers what is in it), `app:<app_type>`, `topic:<word>` or `all`. Missing means `all`.
- The title is the first `# ` heading. Any other MADR field is kept as it is.
- The parser is standard-library only and strict: a header it cannot read, an unknown status, a bad `applies-to`
  item, a missing title, a bad file name (any `.md` whose name starts with a digit), two files with one number, or a
  supersession pointing nowhere is a problem with its reason. An ADR with a problem never binds, and the problem is
  reported (`/mach adr list`, the routing sheet, the audit note); it is never silently skipped.

## What was built

- **One shared helper**, `skills/intent/scripts/adr.py`, loaded by the intent, build, review, audit and run scripts
  the way `lifecycle.py` and `claim.py` are. It reads the main checkout's committed ADRs (its working tree when it
  has no commits) plus, for a cell, the ADR files the ticket's branch added; a branch that changes or deletes an
  existing ADR is a problem.
- **Intent station** (`cell.py`):
  - `adrs <ticket> [--app-type T] [--topic W]... [--path P]...` reads only: an index, the bounded text of the
    accepted ADRs that apply (fenced as data), the ticket's proposals, exceptions and problems.
  - `adr-draft <ticket> --title T [--applies-to A]...` writes a `proposed` ADR with a free number on the ticket's
    branch (numbers are counted across main, its working tree and every cell).
  - `adr-conflict <ticket> --adr ADR-NNNN --reason R` records that the plan cannot follow an accepted ADR.
  - `adr-exception <ticket> --adr ADR-NNNN --by NAME --reason R` and `adr-accept <ticket> --adr ADR-NNNN... --by NAME
    [--note N]` are a person's acts, refused inside a supervised execution (`MACH_EXECUTION_ID` set).
  - `replan` also clears a conflict once the ADR is superseded or changed on the main branch, and refuses while it
    is unchanged.
  - `check-plan` requires a new plan header line, `- **ADRs:** ADR-0003, ADR-0012` or `None.`, and refuses a plan
    that names an ADR that does not exist or is not accepted, a plan whose files fall under an accepted ADR's
    `path:` globs without naming it (or a recorded exception), a plan task that changes an ADR file, a proposal the
    plan does not list or that still holds a template comment, a ticket's own ADR written as `accepted`, a recorded
    conflict, and (for `factory-tuning`) any proposal. On `PLANNED` it records `adrs` in `cell.json` (the main commit,
    each ADR planned under with its SHA-256, the ones named and applied, the plan's files, the proposals), keeps a
    copy of each text in the cell's `adrs/`, and commits proposals with the contracts.
- **Routing sheet** (`run.py next`): `spec-ready` stops with `needs: "adr-decision"` on a recorded conflict and
  `"adr-fix"` when an ADR on main cannot be read; `planned` and High risk stops with `"adr-acceptance"` while a
  proposal waits. `decide` offers: an exception (needs a reason), re-planning (only once the ADR changed), accepting
  (with the proposal shown first), checking again, abandoning. None is recommended by rule.
- **Build**: `start` refuses a High-risk ticket with an unaccepted proposal, lists the ADRs in force with their kept
  copies and exceptions; every step refuses a change to the ADR folder, with no override (`--allow-extra` included),
  and `add-task` refuses an ADR file; `build-report.json` has `adrs` (in force, exceptions, proposals, acceptances).
- **Review**: `start` refuses a change that edits or removes an existing ADR and a tuning change touching the ADR
  folder; the packet has `adrs` (apply, in force, exceptions, proposals, changed since planning). `submit` accepts a
  blocker citing `ADR-NNNN` only for an ADR in force for the ticket, and says why otherwise (unknown, not accepted,
  accepted after planning).
- **Timing**: `next`, `status` and `explain` flag ADRs accepted, changed or withdrawn on main after planning
  (`adrs` in the digest and the status row, `adrs.changed_since_plan` in explain). Nothing is restarted or blocked.
- **Run skill**: `run.py adr list` (reads only) and `run.py adr new --title --context --decision [--option]...
  [--consequence]... [--applies-to]...` (writes one `proposed` file in the main checkout's working tree, commits
  nothing; refused in a supervised execution). `/mach adr new "<decision>"` is the skill's one-question-at-a-time
  interview in front of it; `/mach adr except` and `/mach adr accept` route to the intent station.
- **Audit**: a note (`notes` in the report) when no accepted ADR exists, or ADR files cannot be read; no score
  change, never a blocker.
- **Never**: observe's instructions forbid proposing anything about an ADR; the reviewer brief makes a tuning rule
  that would let the factory change one a blocker.

## Limits

- Topics are matched as whole words (and hyphen-joined pairs) of the spec's title, requirements and scenarios, the
  plan's engineering decisions, and any `--topic` the contract engineer passes. Only `path:` globs are enforced by
  `check-plan`; `app:`, `topic:` and `all` ADRs are given to the planner, builder and reviewers to follow.
- An exception counts for its ADR's ID for that ticket; it is recorded before planning (stage `spec-ready`).
- A proposal is accepted on the ticket's branch only at `planned`, before the build; accepting an ADR on main is
  the engineer's own pull request.
- The lifecycle log records the ADR acts as `gate.evaluated` on the plan station (`plan.adr`, with
  `adr-conflict`, `adr-exception`, `adr-accepted`, `adr-changed`). Reviewers' ADR citations are kept in their votes;
  the Factory Floor's rule IDs (spec and matrix IDs) are unchanged.
- No upgrade path for cells planned before this: MACH has no users yet.

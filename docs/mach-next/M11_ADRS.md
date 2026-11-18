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
- **Audit**: a note (`notes` in the report) naming the required topics with no accepted ADR, or when ADR files
  cannot be read; no score change, never a blocker.
- **Never**: observe's instructions forbid proposing anything about an ADR; the reviewer brief makes a tuning rule
  that would let the factory change one a blocker.

## The required baseline (decided 2026-11-18)

No ticket is planned or built until the project's basic technical decisions are written down.

- **Required topics**: `adr.required_topics` in `.factory/config.json` (the scaffolded settings list the six
  defaults). Default `language` (language and runtime), `framework` (framework and application type), `storage`
  (data storage), `testing` (testing approach), `deployment` (deployment environment), `coding-standards`. Each
  default has one fixed line, kept in `adr.py` (`REQUIRED_TOPICS`), which the scripts and the skill show. A team
  extends the list by adding names. An empty list is the project's explicit choice to require nothing, and the only
  "off". A setting that is not a list requires the defaults; a name that is not a topic word stays required (no ADR
  can cover it) and is reported.
- **Covered**: an ADR that is `accepted`, has no problem and is committed on the main branch (the main checkout's
  HEAD; in a project with no commit yet its working tree, as for every ADR rule) and names `topic:<name>` in
  `applies-to`. One ADR may cover several topics. An ADR deciding a topic does not apply covers it. `all` covers no
  topic; a proposed, malformed or uncommitted ADR covers nothing (`adr.coverage`, `adr.baseline_stop`).
- **The stop**: `run.py next` at `spec-ready` answers `stop` with `needs: "adr-baseline"`, `missing_topics` and
  `command`, after the `adr-fix` stop (a malformed ADR is reported first). `cell.py claim <ticket> plan` and
  `cell.py check-plan` refuse with the same reason, so no driver goes round it: the intent skill's own stage 2
  after grooming stops at its claim. Text: `NEEDS_TEXT["adr-baseline"]` (the digest and notifications), the status
  digest's `adr_baseline`, explain's `adrs.baseline_missing`, decide's state `adr-baseline` with three options (draft
  the baseline, write one decision, check again), none recommended. The supervisor treats it like any stop for a
  person.
- **Not held**: grooming (a spec has no technology in it), cells already `planned` or further (never sent back),
  `factory-tuning` tickets (they change only rule files). **Held**: `repo-hardening` tickets, because hardening
  chooses exactly what the baseline decides (the test runner, the linter, the build), and the baseline can be drafted
  whatever the readiness tier.
- **For these topics the softer rule cannot arise**: planning starts only once they are covered, so the contract
  engineer follows them; a slice that needs something else for one is an `adr-conflict`, never a proposal. The
  `proposed` ADR on the ticket's branch stays for every other choice.
- **`run.py adr baseline`** (`skills/run/scripts/baseline.py`): reads the main checkout's committed files only (`git
  ls-tree`, `cat-file`, `show`; never the working tree, never a file over 100 KB, at most 20,000 files, vendored and
  build folders skipped). Evidence per topic, at most 20 items, each a file, what was found and an excerpt of at most
  160 characters redacted with the ticket station's `issue_rules.redact`:
  - `language`: languages by file count, runtime version files (`.python-version`, `.nvmrc`, `.tool-versions`, ...),
    manifests with the lines that pin a runtime (`requires-python`, `engines`, `go`, `rust-version`, ...),
    lockfiles, the stacks the last audit detected;
  - `framework`: frameworks named in dependencies (package.json, requirements, pyproject, Cargo, go.mod, Gemfile,
    composer.json), framework files (`manage.py`, `next.config.js`, ...), declared command-line programs;
  - `storage`: database drivers and ORMs in dependencies, migration and schema folders, storage configuration
    (`schema.prisma`, `alembic.ini`, ...), SQL files, data services in compose files;
  - `testing`: test tools in dependencies, runner configuration, `[tool.pytest]`-style sections, package test
    scripts, test files by folder, the audit's test command;
  - `deployment`: Dockerfiles, compose files, Kubernetes, Helm and Terraform, serverless and platform files (Fly,
    Vercel, Netlify, Render, ...), CI workflows;
  - `coding-standards`: linters, formatters and type checkers in dependencies and their configuration, `tsconfig`
    strictness, pre-commit, `.editorconfig`, package lint scripts, the audit's lint command.
  A topic the project added gets no evidence: the skill asks the engineer.
- **The record**: `.factory/adr-baseline.json`, git-ignored (added to the installed `.gitignore` block). It is a
  working record on one machine, like the audit report: it names drafts that exist only in that working tree, and
  writing a tracked file would leave the main checkout modified. The ADRs drafted from it are what the team shares.
  Per topic: `evidence`, its `digest`, the `commit` it was read at, `gathered_at`, and `adr` (ID, file, when). A later
  run reads the repository again only for an uncovered topic with no record, or whose drafted ADR was deleted; a
  recorded topic is shown from the record (`reused_from_record`, `read_at_an_earlier_commit`). A topic with any ADR
  naming it in the folder, proposed or uncommitted, is listed under `waiting` and never drafted again.
- **Drafting**: `run.py adr new --baseline <topic> ... [--open-point P]...` refuses a topic that is not required,
  already covered, already has an ADR, or has no record; it adds `topic:<topic>` to `applies-to`, lists the recorded
  evidence and the open points under MADR's `## More Information`, writes the file as `proposed` in the main
  checkout's working tree and records it. The skill states the decision as what the repository already does and
  marks anything not evidenced as an open point; with no evidence it asks one question at a time.
- **`run.py adr accept ADR-NNNN... --by NAME`**: on an engineer's explicit word, sets `status: accepted` in those files
  in the main checkout's working tree, and adds `decision-makers: NAME` when the header has none. All or nothing:
  it refuses an unknown ID, a file it cannot read, one not `proposed`, one with a template comment, and one still
  listing open points. Commits nothing; the decisions bind once committed on the main branch. Refused inside a
  supervised execution. Editing the file by hand is equally valid.
- **`adr list`** adds `required_topics`: each topic, the ADRs covering it, ADRs naming it that do not bind yet, and
  what is missing. **Audit**: the note names the missing topics (still a note). **Doctor**: `adr.baseline`, a
  warning while a topic is missing.

## The baseline interview (2026-11-18)

The first live run drafted six ADRs and stopped at a table of open points for the engineer to edit by hand. The
owner's decision: the gaps are closed by the same interview the slice uses.

- **`run.py adr settle <ADR-NNNN> --point <n> --answer "<text>" [--decision "<text>"] [--not-decided]`** records one
  answer against one open point of a `proposed` ADR in the main checkout's working tree: the point leaves the list
  under `## More Information`, and `point: answer` joins `## Decision Outcome` under "Settled with the engineer:"
  (or under "Not decided here", with `--not-decided`). `--decision` replaces the decision's own text. The evidence
  list is kept; the section goes when nothing is left in it. Refused for an ADR that is not `proposed`, a point that
  does not exist, and inside a supervised execution. Commits nothing. Proposals on a ticket's branch are not in scope.
- **`adr list` and `adr baseline`** report each proposed ADR's remaining open points, numbered; `adr baseline` also
  gives `open_points_left`, `ready_to_accept` and `tickets_waiting`, so a later session resumes where the last stopped.
- **`adr accept`** refuses while a point is open, and refuses a decision that is empty apart from points left
  undecided: a required topic is never covered by an empty decision.
- **The skill** (`skills/run/SKILL.md`, "Drafting the baseline") looks each fact up before asking, turns a conflict in
  the evidence into the question, asks once to accept when nothing is open, and offers the pull request.

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

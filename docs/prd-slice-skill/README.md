# prd-slice

`prd-slice` is an agent skill for Claude Code and Codex. It interviews a product manager (PM) in plain English and turns a feature idea into an implementation-ready specification for one thin vertical slice. Engineers and coding agents can build and test the slice from that spec without guessing.

This guide covers what the skill does, how the interview works, what the spec contains, how to check a spec yourself, and how to install, update, and remove the skill.

## Contents

- [What it does](#what-it-does)
- [When to use it](#when-to-use-it)
- [Prerequisites and permissions](#prerequisites-and-permissions)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Inputs and outputs](#inputs-and-outputs)
- [Common workflows](#common-workflows)
- [The validator](#the-validator)
- [Troubleshooting](#troubleshooting)
- [Uninstallation](#uninstallation)
- [Limitations and security considerations](#limitations-and-security-considerations)
- [For contributors](#for-contributors)

## What it does

A **vertical slice** is the smallest piece of a feature that delivers one complete, testable result for one type of user. "An admin invites one teammate by email" is a slice. "Team management" is not; it is many slices.

The skill does three things:

1. **It decides the slice.** You describe a feature in your own words. The skill picks the smallest complete outcome for one user and moves everything else, such as bulk uploads or admin consoles, into later slices with reserved IDs. You never have to argue scope.
2. **It interviews you until nothing is missing.** It asks numbered questions in rounds, each with a recommended answer, so you can reply "yes" or correct only what is wrong. It covers who can act, the hard limits, every rejection and its exact message, what changes on success, and what happens when an outside service fails. It looks up facts in your project instead of asking you for them.
3. **It writes and checks the spec.** It writes one Markdown file to `specs/slices/` and runs a bundled checker, `scripts/validate_slice.py`, to confirm the file is complete, consistent, and testable before handing it over.

The spec stays at the business level. It says what the user sees and what changes, in your words. It does not choose HTTP status codes, error codes, data schemas, or technologies; engineering decides those.

### Terms used in this guide

| Term | Meaning |
|------|---------|
| **RFC 2119 keywords** | Uppercase words such as MUST and MUST NOT that mark a rule as absolute. The spec uses them for business rules that can never be broken, such as a seat limit. |
| **EARS** | Easy Approach to Requirements Syntax: five labeled sentence templates, such as "When ..., the system SHALL ...", that make each behavior unambiguous. |
| **Decision matrix** | A table that maps every combination of conditions to one expected outcome and its side effects. Each row becomes one case of a table-driven test. |
| **Given/When/Then scenario** | An end-to-end example: the starting state, one action, and the observable result. |
| **Round** | One message of numbered questions from the skill, which you answer in one reply. |
| **Open question** | Something nobody could answer yet, recorded in the spec with who can answer it. |
| **Assumption** | A decision you handed to the skill ("you decide"), or a fact it found in your project, recorded so you can review it. |
| **Accepted default** | A common industry default the skill proposed and you accepted, such as "reset links expire after 30 minutes". Recorded so engineers can tell a default from a hard business rule. |

## When to use it

Use it when you want to:

- define a new feature or user story for engineering;
- cut a large feature down to its first shippable slice;
- find the missing edge cases, limits, and error messages before work starts;
- prepare a spec that a team of coding agents can build and verify, for example in a Claude Dynamic Workflow;
- continue a slice spec you started earlier.

Do not use it for:

- technical design or architecture decisions; the skill turns implementation details into behavior and leaves the "how" to engineering;
- a whole product roadmap or several personas at once; run the skill once per slice;
- bug reports or small copy changes.

## Prerequisites and permissions

- **An agent:** Claude Code or Codex.
- **Python:** Python 3.8 or later, available as `python3`, for the validator. No other packages are needed. Without Python the interview still works, but the spec cannot be validated, and the skill says so instead of calling it validated.
- **A project folder:** start the agent in the project the slice belongs to. The skill reads that folder for facts and writes the spec into `specs/slices/` inside it, creating the folder if needed.
- **Permissions the agent will ask for:**
  - read files in your project, to look up facts;
  - create and edit files in `specs/slices/`;
  - run `python3` with the bundled validator.

The skill never needs network access, credentials, or changes outside your project.

## Installation

Install with the repository installer. From the root of this repository, run:

```bash
python3 scripts/install.py
```

It asks what to do, which skills, which agent, and whether to install for you in every project or into one project folder. It then shows exactly what will change and asks before changing anything.

To install without prompts, for example in managed setups:

```bash
python3 scripts/install.py install --skill prd-slice --agent all --yes
```

To install into one project only:

```bash
python3 scripts/install.py install --skill prd-slice --agent claude --scope project --project /path/to/your-project --yes
```

Add `--dry-run` to any install command to see the plan without changing anything.

The skill is installed into these folders:

| Agent | For you, in every project (the default) | For one project |
|-------|------------------------------------------|-----------------|
| Claude Code | `~/.claude/skills/prd-slice/`, or `$CLAUDE_CONFIG_DIR/skills/prd-slice/` if that is set | `<project>/.claude/skills/prd-slice/` |
| Codex | `~/.codex/skills/prd-slice/`, or `$CODEX_HOME/skills/prd-slice/` if that is set | `<project>/.codex/skills/prd-slice/` |

To check that it is installed and current:

```bash
python3 scripts/install.py status --agent all
```

Restart your agent after installing so it picks up the new skill.

**Updating.** Pull the latest changes to this repository and run the same install command again. The installer updates only the files it installed, keeps any files you added, and stops instead of overwriting a file you changed. See the repository [README](../../README.md) for every installer option, including `--force` and backups.

## Quick start

1. Open your project in Claude Code or Codex.
2. Start the skill with your idea:
   - In Claude Code, type `/prd-slice Let workspace admins invite a teammate by email`.
   - In either agent, write "Use prd-slice to spec out letting workspace admins invite a teammate by email."
   - The skill also starts on its own when you ask for something it handles, such as "write product requirements for team invitations".
3. The skill tells you what it is leaving for later slices, then asks its first round. A round looks like this:

   ```markdown
   ❓ **Q1** - **Who invites**: Is this slice for a workspace admin inviting one teammate by email from the Members page?

   ➡️ Yes. Bulk invitations from a CSV file belong to a later slice.

   ---

   ❓ **Q2** - **Full workspace**: When every seat is taken, should the admin be refused with "All seats are in use. Add seats to invite more people." and no invitation sent?

   ➡️ Yes, reject the invitation with that message and send nothing.

   ---

   ❓ **Q3** - **Invitation expiry**: Should an invitation link stop working 7 days after it is sent?

   ➡️ Yes. Common default: invitation links expire after 7 days.
   ```

4. Answer the round in one reply:
   - `yes` accepts every recommendation;
   - `Q3: 14 days, not 7. Yes to the rest.` changes one answer;
   - `Q2: I don't know` or `Q3: you decide` are always fine.
5. Repeat for each round. Most slices take three or four rounds.
6. The skill shows a three-point summary. Reply `yes` if it matches what you meant, or correct it.
7. The skill writes `specs/slices/SLICE-001-invite-teammate.md`, validates it, and gives you a short handoff.

A complete example of the output is in [`tests/fixtures/SLICE-001-invite-teammate.md`](tests/fixtures/SLICE-001-invite-teammate.md).

## How it works

### The five phases

| Phase | What the skill does | What you do |
|-------|---------------------|-------------|
| 1. Boundary and persona | Looks up existing specs and project facts. Names the one actor, the trigger, and the outcome, and lists what it is deferring to later slices. | Answer the first round, which settles who does what and why. |
| 2. Probing | Asks rounds of questions until every part of the slice is settled. | Answer each round. |
| 3. Sanity check | Asks a final round for any missing message, definition, or number. Then shows a three-point summary, the defaults you accepted, and its assumptions. | Confirm the summary, or correct it. |
| 4. Write-up and validation | Writes the spec, runs the validator, fixes what it can, and checks whether the spec is ready for engineering. | Nothing, unless a fix needs a business decision. |
| 5. Handoff | Reports the file, the validation result, and anything left for you to review. | Review the assumptions, accepted defaults, and open questions. |

### Deciding the slice

The skill, not you, decides where the slice ends. A slice must deliver exactly one complete, verifiable business outcome for one actor, small enough for a team of agents to build and verify in one go.

- Admin consoles, secondary flows, bulk actions, and multi-role workflows go to later slices. The skill says so in plain words, such as "That belongs in a subsequent slice", and never asks you to decide scope.
- Follow-ups the outcome depends on stay in, such as automatically resuming a paused subscription.
- Optional follow-ups that happen later, such as reminder emails or digests, go to later slices unless your answers show the outcome fails without them.
- Immediate confirmations of the action, such as a "Your password was changed" email, stay in; they are side effects of the action.
- If you ask to bring a deferred item back, the skill applies the same tests. Explain why the outcome fails without it if you think it belongs.

Each deferred feature reserves its own future slice ID in the spec, such as `(Deferred to SLICE-002)`, so the next session knows what is planned.

### The design tree and the frontier

The skill maps the slice as a **design tree**: each decision leads to the decisions that depend on it. The root is the actor, the trigger, and the outcome. Before the interview ends, it visits every branch:

- **Preconditions and state:** what must exist first, who is allowed to act, whether suspended or unverified users can act, and what condition words such as "valid" or "active" mean.
- **Invariants and limits:** the boundaries that can never be breached, such as seat counts, amounts, character limits, and expiry times, plus their edge cases: exactly at the limit, month ends, time zones, and the same thing submitted twice.
- **Failure states and recovery:** every rejection and its exact message, which message wins when several apply, and what happens when an outside service fails.
- **Side effects:** what a successful action changes or sends right away, including anything the user can see that a test will check.
- **Dependencies and permissions:** which outside services the action calls that could fail, what happens when each fails, and what role the actor needs.


The **frontier** is every unsettled decision whose prerequisites are settled. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round. A question that depends on an answer you have not given yet waits for a later round, so the skill never asks you to guess.

There is no limit on questions but only ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering. If the questions are still growing after the tenth round, the skill trims the slice instead of asking more.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a later round, not this one.

Finding facts is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The decisions are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.


### How questions are written

Every question follows the same format:

```markdown
❓ **Q4** - **<short title>**: <the question>

➡️ <the recommended answer>
```

- **Numbered across rounds.** If round 1 ends at Q9, round 2 starts at Q10, so "Q12: no" is never ambiguous.
- **"Yes" accepts.** Each question is a yes-or-no proposal that contains the recommendation, such as "Should ...?" or "Is ...?". The skill does not ask open "what" or "how" questions.
- **One decision each.** Each answer settles one thing.
- **Messages included.** A question that proposes turning the user away also proposes the exact words they see, so the rule and its message settle together.
- **Grounded recommendations.** Each recommendation comes from what you said or a fact the skill found. When there is neither, it proposes a common default and labels it, such as "Common default: reset links expire after 30 minutes."
- **Nothing twice.** Settled points, and facts the skill found, appear in a short recap at the top of the next round instead of being asked again.
- **Conflicts raised early.** If two of your rules conflict, such as a privacy rule and a message that reveals an account exists, the next round asks which wins.
- **Plain business language.** No engineering terms in questions or recommendations.

### Answering

| You say | What the skill does |
|---------|---------------------|
| `yes` | Accepts every recommendation in the round. |
| `Q3: 10 minutes, not 30. Yes to the rest.` | Uses your answer for Q3 and the recommendations for the rest. |
| `I don't know` or `I'm not sure` | Stops asking about that point and the questions that depend on it. Records it under Open questions with a note naming who could answer it, such as "Follow up: Finance team." |
| `you decide` or `no preference` | Uses its recommendation and records it, with the reason, under Assumptions for you to review. |
| A technical instruction, such as "store it in Redis" | Translates it into the behavior behind it, such as "changes are visible within 60 seconds". This happens even if you repeat the instruction. |
| A new feature idea | Defers it to a later slice with a reserved ID. |
| `I need to stop` | Saves what is settled and lists the rest as open questions. See [Stop and come back later](#stop-and-come-back-later). |

### Facts the skill looks up

The skill never asks you for a fact it can find. Facts include:

- existing specs in `specs/slices/`, for reserved slice IDs and related slices;
- product documents in the project, such as approved support messages;
- current behavior in the code, such as existing limits and expiry times.

How it looks things up:

- **Read-only and inside the project.** It reads product files only: never credentials, interview notes or transcripts, or the spec it is writing.
- **In parallel when possible.** If the agent can start sub-agents, as in Claude Dynamic Workflows, each lookup goes to its own sub-agent with one bounded question. The sub-agent answers in plain language, quoting the lines it used and naming the file, and the skill rereads those lines to confirm them. Sub-agents never write files or talk to you.
- **On its own otherwise.** If sub-agents are not available, or the agent runs one in the background, the skill does the lookup itself.
- **Before the round, never instead of it.** Lookups finish before the round is sent, so you never get a message that only says the agent is still looking.
- **Translated.** Findings reach you in business terms. "`RESET_TTL_MINUTES = 30`" becomes "reset links expire after 30 minutes".
- **Recorded.** Each fact the spec relies on is listed under Assumptions with its source file.

When a lookup cannot settle a point, the skill asks you:

- if nothing is found, it asks in the next round;
- if a fact is ambiguous, such as a limit with no unit, it asks you to confirm its reading;
- if the code shows another team owns an undecided rule, it records an open question for that team instead of asking you to decide.

### Business language only

The spec describes what the user sees and what changes. When you or the code mention technical details, the skill writes the guarantee behind them:

| You say | The spec says |
|---------|---------------|
| "Return a 409 with `MEMBER_EXISTS`" | If the email address already belongs to an active member, the system rejects the invitation and displays "This person is already a member." |
| "Store reset tokens in Redis with a 30 minute TTL" | A reset link MUST stop working 30 minutes after it is created. |
| "Cache the seat count" | The seat count shown MUST NOT be more than 60 seconds out of date. |
| "Run a cron job" | Expired invitations MUST release their seats within 1 hour of expiry. |

### The summary before writing

When every branch is settled, the skill first checks for gaps: a rejection without its exact message, a condition word without a definition, or a limit without its number. It asks any it finds in one final round. Then it shows:

1. **Core action and scope boundary:** what the slice does, and what was deferred.
2. **Hard business invariants:** the rules that can never be broken.
3. **Error cases and rejection paths:** every rejection with its exact message in quotes.

After the bullets come the defaults you accepted and its assumptions, so you can recheck them. It then asks: *"Does this capture the intent, or did I miss an edge case before I write up the specification?"*

- It writes the spec only after an explicit yes.
- If you correct or add something, it updates its plan and asks another round if needed.
- Once you confirm, it asks nothing new. Anything it notices later becomes an open question instead.

### Writing and validating the spec

After your confirmation, the skill:

1. reads the template and the three reference files in `references/`;
2. chooses the slice ID (see [Slice IDs](#slice-ids));
3. writes the spec to `specs/slices/SLICE-NNN-short-name.md`, and does not overwrite a spec that existed before the session unless you confirm;
4. runs the validator from your project root;
5. fixes every error the validator reports, and resolves or explains every warning;
6. runs the validator again with `--ready`, to see whether the spec is ready for engineering.

While fixing errors, it never changes the behavior you asked for just to satisfy a check. If a fix needs a business decision, it asks you. It stops and shows you the remaining errors if a rerun does not reduce the number of errors, or after 5 validator runs in total.

### The handoff

The skill finishes with a plain-English summary:

- the spec path and the validation result: passed, failed with remaining errors, or not run;
- whether the spec is ready for engineering, or how many open questions remain;
- the slice outcome in one sentence;
- the number of invariants, functional requirements, decision matrix rules, and scenarios;
- the assumptions and accepted defaults, for you to review;
- the deferred slices with their reserved IDs;
- each open question with its follow-up note, and how to continue, such as "Continue SLICE-004."

## Inputs and outputs

### Input

- A feature idea or user story, in your own words.
- Your answers to each round.
- Optionally, an existing spec to continue, such as "Continue SLICE-004."

The skill also reads your project, as described in [Facts the skill looks up](#facts-the-skill-looks-up).

### Output

- One Markdown file, `specs/slices/SLICE-NNN-short-name.md`, following [`assets/slice-template.md`](assets/slice-template.md).
- The handoff message in the conversation.

Nothing else in your project is changed.

### What the spec contains

Every spec has these sections, in this order:

| Section | What it holds |
|---------|---------------|
| Title | `# SLICE-NNN: Outcome-focused title`, with the same ID as the file name. |
| Summary | Three lines: the single **Actor**, the **Trigger** that starts the slice, and the verifiable **Outcome**. |
| Scope | **In scope**: what this slice delivers. **Out of scope**: each deferred feature with its reserved ID, such as `(Deferred to SLICE-002)`, or `None.` |
| Preconditions | What must already be true before the trigger, including data the slice only reads. |
| Invariants | Business boundaries that can never be breached, one per line, such as `- **INV-01:** An invitation link MUST expire 7 days after it is sent.` |
| Functional requirements | One EARS statement per behavior, such as `- **FR-03:** [Unwanted behavior] If the email address is not valid, then the system SHALL reject the invitation and display "Enter a valid email address."` |
| Acceptance criteria | A **Decision matrix** covering every combination of conditions, and **Scenarios** in Given/When/Then form. |
| Dependencies and permissions | **External dependencies**: services the action calls that can fail, each ending with the requirement that covers its failure, such as `(failure: FR-06)`. **Required permissions**: the role the actor needs, or `None.` with a reason. |
| Assumptions | Decisions you handed to the skill, with reasons, and facts found in the project, with their source files. |
| Accepted defaults | Each common default you accepted, with the requirement IDs it produced, such as `- Invitation links expire 7 days after they are sent (INV-03).` |
| Open questions | Each unanswered question with a follow-up note, such as `- What is the refund limit for annual plans? Follow up: Finance team.`, or `None.` |

### Requirement formats

**Invariants** use RFC 2119 keywords in uppercase: `<Subject> MUST <boundary>.` or `<Subject> MUST NOT <boundary>.` Recommendations such as SHOULD or MAY are never used, because a test cannot pass or fail a recommendation.

**Functional requirements** each start with one of five EARS labels and use exactly that form, with one SHALL:

| Label | Use it for | Form |
|-------|------------|------|
| `[Ubiquitous]` | Behavior that is always true | `The <system> SHALL <response>.` |
| `[Event-driven]` | A response to a trigger | `When <trigger>, the <system> SHALL <response>.` |
| `[State-driven]` | Behavior that holds while a state lasts | `While <state>, the <system> SHALL <response>.` |
| `[Unwanted behavior]` | Rejections, errors, and outside failures | `If <condition>, then the <system> SHALL <response>.` |
| `[Optional feature]` | Behavior that exists only when a feature is on | `Where <feature is included>, the <system> SHALL <response>.` |

Exact user-facing messages appear in double quotes. Variable parts of a message go in angle brackets inside the quotes, such as `"Your next pause is available on <date>."`

### The decision matrix

The matrix is one table with the columns `Rule`, one column per condition, `Expected outcome`, `Side effects`, and `Covers`:

```markdown
| Rule | Admin active | Email valid | Already member or invited | Seat available | Expected outcome | Side effects | Covers |
|------|--------------|-------------|---------------------------|----------------|------------------|--------------|--------|
| R1   | No           | -           | -                         | -              | Rejected with "Your account is suspended. Contact your workspace owner." | None | FR-07 |
| R2   | Yes          | No          | -                         | -              | Rejected with "Enter a valid email address." | None | FR-03, INV-04 |
| R3   | Yes          | Yes         | Yes                       | -              | Rejected with "This person is already a member or has a pending invitation." | None | FR-05, INV-02 |
| R4   | Yes          | Yes         | No                        | No             | Rejected with "All seats are in use. Add seats to invite more people." | None | FR-04, INV-01 |
| R5   | Yes          | Yes         | No                        | Yes            | Invitation sent | One seat reserved; invitation email sent to the invitee | FR-01, FR-02 |
```

- **Cells.** `Yes` and `No` for yes-or-no conditions. `-` means the condition does not matter for that rule. `None` in Side effects means nothing changes.
- **Conditions with more than two values.** The header lists every value, such as `Amount (Under $75 / $75 to $5,000 / Over $5,000)`, and cells use only those values.
- **Shorthand.** A cell can list values with `or`, such as `Under $75 or $75 to $5,000`, or exclude them with `not`, such as `not Over $5,000`. A cell that exactly matches a declared value always means that value, so values such as `Suspended or closed` still work.
- **Rejection order.** When several rejections could apply at once, the rules are written so only the one you chose matches. In the example, an invalid email is always reported before a full workspace.
- **Impossible cases.** A combination that cannot happen gets a rule whose outcome starts with `Not possible:` and the reason, but only after you confirm it cannot happen.
- **Several steps.** A slice that needs more than one action, such as requesting a reset link and then setting a new password, adds a `Step` column, such as `Step (Request link / Set password)`.
- **Covers** lists the requirements each rule verifies.

The validator checks that every combination of values matches a rule, and that no two overlapping rules disagree. Each row becomes one case of a table-driven test.

### Scenarios

Scenarios cover what a table cannot: the main success path, each outside failure, and anything time-based such as expiry. Each has one action:

```markdown
#### AC-03: Email service failure releases the reserved seat

- **Covers:** FR-06, FR-08
- **Given** the workspace "Acme Design" has 5 purchased seats and 4 members
- **And** the email service is not responding
- **When** the admin invites "sam@example.com"
- **Then** after 60 seconds the system displays "We couldn't send the invitation. Try again in a few minutes."
- **And** the Members page shows 4 of 5 seats in use
```

Every invariant and functional requirement is covered by at least one matrix rule or scenario, so every requirement has a test.

### Slice IDs

The skill chooses IDs from the files already in `specs/slices/`:

- If an earlier spec deferred this feature, the slice reuses the ID that spec reserved.
- Otherwise it takes the next number after the highest `SLICE-NNN` in the folder, counting both file names and `Deferred to` pointers.
- Each new deferred feature reserves the next unused number. If an earlier spec already reserved an ID for the same feature, the pointer reuses it.

For example, if `SLICE-001-employee-profile.md` defers expense submission to `SLICE-004` and manager approval to `SLICE-005`, a spec for expense submission becomes `SLICE-004`. Its own deferred items point to `SLICE-005` for manager approval and `SLICE-006` onward for anything new.

## Common workflows

### Write a new slice

Follow the [Quick start](#quick-start).

### Stop and come back later

Tell the skill you need to stop. It:

1. shows what it will save, with every point that is still open, and asks you to confirm;
2. writes the spec with everything settled so far, and lists each unanswered point under Open questions with a follow-up note;
3. validates the spec;
4. tells you the spec is saved but not ready for engineering, and how to continue.

Where a rule is settled but its message or its place in the rejection order is not, the saved spec gives it a generic outcome, such as "Pause refused; subscription unchanged", and lists the missing pieces as open questions. It never narrows a rule to make an open question go away.

### Continue a saved spec

Say "Continue SLICE-004" in the project that holds the spec. The skill:

- treats everything outside Open questions as settled, because you confirmed it before it was saved;
- asks about any rejection in the saved spec that still has no exact message;
- rechecks the facts under Assumptions, because the project may have changed, and tells you about any change;
- asks the open questions in rounds, numbering this session's questions from Q1;
- keeps the existing requirement and rule IDs and numbers new ones after the highest;
- updates the same file in place.

### Revise an existing slice

Ask the agent to update the spec with prd-slice, such as "Use prd-slice to update specs/slices/SLICE-001-invite-teammate.md so invitations expire after 14 days." It edits the file and validates it again.

### Check a spec yourself

Run the validator from your project root, pointing at the installed skill folder. For a Claude Code install for every project:

```bash
python3 ~/.claude/skills/prd-slice/scripts/validate_slice.py specs/slices/SLICE-001-invite-teammate.md
```

For Codex, use `~/.codex/skills/prd-slice/`. For a one-project install, use `.claude/skills/prd-slice/` or `.codex/skills/prd-slice/` inside the project. Expected output for a valid spec:

```text
PASSED: 0 error(s), 0 warning(s)
```

### Check that a spec is ready for engineering

A spec with open questions can still pass validation, so you can save partial work. Add `--ready` to fail while any open question remains:

```bash
python3 ~/.claude/skills/prd-slice/scripts/validate_slice.py --ready specs/slices/SLICE-001-invite-teammate.md
```

Expected output for a spec that is ready:

```text
READY: 0 error(s), 0 warning(s)
```

An automated workflow can use this to refuse to build from an unfinished spec.

### Hand a spec to an automated workflow

Add `--export` to get the spec as JSON, with every decision matrix rule expanded into concrete test cases. Combine it with `--ready` to export only finished specs:

```bash
python3 ~/.claude/skills/prd-slice/scripts/validate_slice.py --ready --export specs/slices/SLICE-001-invite-teammate.md > slice.json
```

If the spec has errors, nothing is written to `slice.json`, the findings appear on screen, and the exit code is `1`. See [Export format](#export-format) for what the JSON contains.

### Use it with several agents

The interview itself runs in one agent, because each round depends on your previous answers. The skill uses parallel agents where the work is independent:

- **Lookups.** Where sub-agents are available, each fact lookup runs in its own read-only sub-agent, all at once, before the round. Where they are not, as with single-agent hosts, the skill does the lookups itself one at a time. The interview works the same either way.
- **Building the slice.** The exported JSON is designed for a team of agents. For example, one agent designs the interface, a second writes tests from the matrix cases and scenarios, and a third writes the implementation without seeing the tests. Then the tests run against the implementation. The `Covers` IDs tie each failing test back to a requirement. [`evals/build_from_spec.py`](evals/build_from_spec.py) runs exactly this workflow, and [`evals/README.md`](evals/README.md) explains it.

## The validator

`scripts/validate_slice.py` checks a spec's structure, grammar, matrix, and traceability. It uses only Python's standard library, makes no network calls, and writes nothing.

### Options

```text
python3 validate_slice.py [--ready] [--export] <spec.md>
```

| Option | Effect |
|--------|--------|
| (none) | Checks the spec and prints each finding, then `PASSED` or `FAILED`. Open questions are warnings. |
| `--ready` | Open questions become errors. Prints `READY` when the spec is ready for engineering. |
| `--export` | Prints the spec as JSON on standard output, and the findings on standard error. Prints no JSON while the spec has errors. |

Run it from your project root. It also reads the other `SLICE-*.md` files in the same folder, to catch duplicate and already-reserved slice IDs.

### Output

Each finding names the file, the line, the severity, what is wrong, and a rule code in brackets:

```text
specs/slices/SLICE-001-invite-teammate.md:44: error: FR-08 is labeled [State-driven] but is written in the Event-driven form. Fix the label or the sentence. [ears-label]
specs/slices/SLICE-001-invite-teammate.md:50: error: No rule covers: Admin active=Yes, Email valid=Yes, Already member or invited=No, Seat available=Yes. Add rules, using '-' for conditions that do not matter, or a 'Not possible:' rule if the PM confirms a case cannot happen. [matrix-incomplete]
FAILED: 2 error(s), 0 warning(s)
```

**Errors** make the spec invalid. **Warnings** point at something worth a second look, such as vague wording, and do not fail the run.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | No errors. Warnings may remain. |
| `1` | Errors were found, or, with `--ready`, open questions remain. |
| `2` | The file could not be read, or the arguments were not valid. |

### Rule codes

Every rule code is explained in detail in [`references/spec-structure.md`](references/spec-structure.md), [`references/ears-syntax.md`](references/ears-syntax.md), and [`references/acceptance-matrices.md`](references/acceptance-matrices.md).

**File, title, and slice IDs**

| Code | Severity | What it means |
|------|----------|---------------|
| `filename` | Error | The file name is not `SLICE-NNN-short-name.md` in lowercase kebab-case. |
| `title` | Error | The file does not have exactly one `# SLICE-NNN: Title` heading with the same ID as the file name. |
| `duplicate-slice-id` | Error | Another spec in the folder uses the same slice ID. |
| `reserved-id` | Warning | Another spec reserved this ID for a feature that looks different from this one. Confirm they are the same feature. |
| `deferred-pointer` | Error or warning | An out-of-scope item lacks `(Deferred to SLICE-NNN)`, or points at this slice's own ID (errors). Pointing at an ID that already has a spec is a warning. |

**Sections and content**

| Code | Severity | What it means |
|------|----------|---------------|
| `missing-section` | Error | A required section is missing. |
| `duplicate-section` | Error | A required section appears more than once. |
| `section-order` | Error | The sections are not in the template's order. |
| `extra-section` | Warning | A section the template does not have, which downstream agents may ignore. |
| `summary-format` | Error | The Summary is not exactly the Actor, Trigger, and Outcome lines, each with a value. |
| `single-actor` | Warning | The actor looks like more than one persona, such as "admins and owners". |
| `empty-section` | Error | A section that needs content is empty. Write `- None.` where the template allows it. |
| `template-residue` | Error | A template comment, `<!-- ... -->`, is still in the file. |
| `placeholder` | Error | A `<placeholder>`, `TBD`, `TODO`, or `FIXME` is left outside Open questions. |
| `unparsed-line` | Error | A line in Invariants or Functional requirements is not a requirement line. |
| `duplicate-id` | Error | A requirement, rule, or scenario ID is used twice. |
| `defaults-format` | Error | An accepted default does not end with the requirement IDs it produced, or names an ID that does not exist. |
| `open-question-format` | Error | An open question has no `Follow up:` note. |
| `open-questions` | Warning, or error with `--ready` | The spec still has open questions. |

**Requirements**

| Code | Severity | What it means |
|------|----------|---------------|
| `inv-keyword` | Error | An invariant has no MUST, MUST NOT, SHALL, SHALL NOT, or REQUIRED, or uses SHOULD, MAY, RECOMMENDED, or OPTIONAL. |
| `rfc2119-case` | Error or warning | A keyword is lowercase. A lowercase "shall" in a functional requirement is an error; other lowercase keywords, such as "must" or "should", are warnings. |
| `fr-keyword` | Error | A functional requirement uses MUST, SHOULD, MAY, REQUIRED, RECOMMENDED, or OPTIONAL. Hard limits belong in Invariants. |
| `ears-label` | Error | A functional requirement has no EARS label, an unknown one, or one that does not match the sentence. |
| `ears-pattern` | Error | The sentence does not follow its EARS form, such as a missing comma or `, then the`. |
| `ears-atomic` | Error | A requirement has more or fewer than one SHALL. |
| `ears-coverage` | Warning | No `[Unwanted behavior]` requirement, so the slice has no rejection or failure path. |
| `implementation-detail` | Warning | Technical detail, such as a status code, error code, API, database, or cache. |
| `vague-term` | Warning | Wording a test cannot check, such as "fast", "user-friendly", or "as needed". |

**Decision matrix**

| Code | Severity | What it means |
|------|----------|---------------|
| `matrix-missing` | Error | There is no table under Decision matrix. |
| `matrix-format` | Error | The columns are wrong or in the wrong order, there is more than one table, or a row has the wrong number of cells. |
| `matrix-rule-id` | Error | A rule ID is not `R1`, `R2`, and so on. |
| `matrix-empty-cell` | Error | A cell is empty. Use `-` or `None`. |
| `matrix-value` | Error | A cell uses a value the header does not declare, or a `not` that excludes every value. |
| `matrix-partitions` | Warning | A column has values other than Yes and No but does not declare them in its header. |
| `matrix-incomplete` | Error | Some combination of conditions matches no rule. The message lists the missing cases. |
| `matrix-size` | Warning | More than 4,096 combinations, so completeness was not checked. The slice is probably too large. |
| `matrix-conflict` | Error | Two overlapping rules give different outcomes or side effects. |
| `matrix-redundant` | Warning | Two overlapping rules give the same result. Merge them. |
| `message-missing` | Warning | A rule that turns the action away does not quote the message the user sees, or say `No message shown`. |

**Scenarios, traceability, and dependencies**

| Code | Severity | What it means |
|------|----------|---------------|
| `scenario-missing` | Error | There are no scenarios. |
| `scenario-format` | Error | A scenario heading is not `#### AC-NN: Title`, or a line does not start with Given, When, Then, And, or But. |
| `scenario-steps` | Error | The steps are out of order, or there is not exactly one When and at least one Then. |
| `trace-format` | Error | A Covers line or cell is missing or malformed. |
| `trace-uncovered` | Error | An invariant or functional requirement is not covered by any rule or scenario. |
| `trace-undefined` | Error | A Covers entry names an ID that is not defined. |
| `dependencies-format` | Error | The External dependencies or Required permissions line is missing or empty. |
| `dependency-failure` | Error | A dependency has no `(failure: FR-NN)`, or names a requirement that is not an `[Unwanted behavior]` requirement covered by a scenario. |

### Export format

`--export` prints one JSON object with these keys:

| Key | Contents |
|-----|----------|
| `slice_id`, `title` | Such as `"SLICE-001"` and the title text. |
| `summary` | `actor`, `trigger`, and `outcome`. |
| `in_scope`, `preconditions`, `assumptions` | Lists of strings. |
| `out_of_scope` | Each item's `feature` and its reserved `deferred_to` ID. |
| `invariants` | Each invariant's `id` and `text`. |
| `functional_requirements` | Each requirement's `id`, EARS `pattern`, such as `"event-driven"`, and `text`. |
| `decision_matrix` | `conditions` (each `name` and its `values`), `rules` (as written), `complete` (whether every combination is covered), and `cases`. |
| `scenarios` | Each scenario's `id`, `title`, `covers`, and `steps`, where each step has a `keyword`, such as `"Given"`, and `text`. |
| `external_dependencies` | Each dependency's `name` and its `failure_requirements`. |
| `required_permissions` | A string. |
| `accepted_defaults` | Each `default` and the `requirements` it produced. |
| `open_questions` | Each `question` and its `follow_up`. |

`decision_matrix.cases` expands every rule into one case per concrete combination of values, ready for a table-driven test:

```json
{
  "id": "R1-1",
  "rule": "R1",
  "conditions": {"Admin active": "No", "Email valid": "Yes", "Already member or invited": "Yes", "Seat available": "Yes"},
  "expected_outcome": "Rejected with \"Your account is suspended. Contact your workspace owner.\"",
  "side_effects": "None",
  "covers": ["FR-07"]
}
```

The invite-teammate example expands its 5 rules into 16 cases.

## Troubleshooting

| Problem | What to do |
|---------|------------|
| The skill does not start | Name it directly ("Use prd-slice ..."). Run `python3 scripts/install.py status` from this repository to confirm it is installed for your agent, then restart the agent. |
| A round has many questions | Reply `yes` to accept every recommendation, answer only the ones you disagree with, or say "I don't know". If you are out of time, say you need to stop; your progress is saved in the spec. |
| The skill asks about something you already told it | Answer with the question number and "already answered", plus the answer, such as "Q12: already answered, 30 minutes." |
| The skill says it is still looking things up and asks nothing | This should not happen; the skill finishes its lookups before each round. Reply "continue" to prompt it to send the round. |
| A feature you wanted is listed as deferred | The skill decides the slice boundary. Say why the outcome fails without that feature, and it will reconsider using the same tests. Otherwise the feature has its own reserved slice ID. |
| Your technical instruction is not in the spec | By design. The spec states the behavior behind it, such as a time limit, and leaves the technology to engineering. |
| The spec got an unexpected slice ID | An earlier spec probably reserved that ID for this feature, or reserved the IDs below it. See [Slice IDs](#slice-ids). |
| The skill will not overwrite an existing spec | It asks before replacing a spec that existed before the session. Confirm, or ask it to continue the existing spec instead. |
| The handoff says validation was not run | Either `python3` is missing, or the agent was not allowed to run commands. Install Python 3.8 or later, or run the validator yourself (see [Check a spec yourself](#check-a-spec-yourself)). |
| The skill stops before validation passes | A rerun stopped reducing the error count, or it reached 5 validator runs. It shows the remaining errors. Answer its questions or fix the listed lines, then ask it to validate again. |
| `python3: command not found` | Install Python 3.8 or later, or ask your administrator. |
| `cannot read file` (exit code `2`) | Check the spec path, and run the command from your project root. |
| `--ready` fails with `[open-questions]` | The spec still has open questions. Find the answers, then say "Continue SLICE-NNN" to finish the interview. |
| Any other rule code | See [Rule codes](#rule-codes) for what it means, and the reference files for the full rules. |

## Uninstallation

From the root of this repository, run:

```bash
python3 scripts/install.py uninstall --skill prd-slice --agent all --yes
```

The installer removes only the files it installed. Files you added to the skill folder stay. If you changed an installed file, it stops and tells you; `--force` backs the folder up first, then removes it.

Specs already written to `specs/slices/` belong to your project and are never touched.

## Limitations and security considerations

- **The validator checks form, not judgment.** It confirms structure, grammar, completeness, and traceability. It cannot tell whether the rules are right for your business; your review of the summary before the spec is written is what catches that.
- **Completeness depends on the conditions written down.** The validator checks every combination of the conditions in the matrix. It cannot detect a condition nobody thought of; the interview is what surfaces those.
- **Specs are in English.**
- **One slice at a time.** Large features take several sessions, one per slice. The reserved IDs keep them connected.
- **The agent's model matters.** The skill's instructions are the same everywhere, but the quality of questions depends on the model running them.
- **Lookups are read-only and stay in your project.** The skill never reads credentials, and translates anything found in code into business terms before you see it.
- **The validator is local.** It reads the file you pass it and the other `SLICE-*.md` files in the same folder. It makes no network calls and writes nothing.
- **Keep sensitive data out of specs.** Do not put customer data, credentials, or production details in a spec. Use synthetic examples such as `example.com` addresses.

## For contributors

### Files in this skill

| Path | Purpose | Installed |
|------|---------|-----------|
| `SKILL.md` | The instructions the agent follows. | Yes |
| `README.md` | This guide. | Yes |
| `assets/slice-template.md` | The spec layout the skill fills in. | Yes |
| `references/spec-structure.md` | Whole-file rules: sections, IDs, and readiness. | Yes |
| `references/ears-syntax.md` | Requirement grammar, RFC 2119 keywords, and business-level wording. | Yes |
| `references/acceptance-matrices.md` | Decision matrix, scenario, traceability, and dependency rules. | Yes |
| `scripts/validate_slice.py` | The validator. | Yes |
| `tests/` | Unit tests and the example spec. | Yes |
| `evals/` | Model-driven regression runs and the build-from-spec check. | No |

### Tests

From the root of this repository:

```bash
python3 -m unittest discover -s product/prd-slice/tests
python3 scripts/install.py check --run-tests
```

The first runs this skill's tests. The second validates every skill in the repository and runs all their tests.

### Changing the validator

The validator and its documentation are a matched set. When you change a check, update the template, the rule codes in `references/`, the example spec in `tests/fixtures/`, and the tests together. The example spec must stay free of findings, and a test fails if any rule code the validator can emit is missing from `references/`.

### Changing the skill's behavior

When you change `SKILL.md`, the template, or a reference file, run the regression evals and compare the results with the saved baseline. They use Claude Code and cost real tokens. [`evals/README.md`](evals/README.md) explains how they work, what they check, and how to save a baseline.

Change `SKILL.md` only for a problem that shows up in at least 2 of 3 runs and leaves the PM stuck or the spec wrong, and fix it with a general rule. Every added rule makes the interview longer and the instructions easier to miss, so prefer removing or merging rules to adding them. Real PM sessions outweigh simulated ones.


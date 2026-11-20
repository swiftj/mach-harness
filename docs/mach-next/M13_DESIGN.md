# M13: Product memory

Design, 2026-11-20. Status: proposed. Nothing here is built until its part says so in an as-built document.

Six questions from product managers in enterprise teams showed five gaps and one thing MACH already leaves to the team's own CI. This milestone closes the gaps with one idea: **a slice's spec says how it relates to what is already true**, and scripts hold it to that. Three things are "already true" for a new slice: the product's principles, the behaviour that has shipped, and the document the slice came from.

| Part | Gap | What is added |
|---|---|---|
| A | No home for product rules that span slices | Product principles, answered by every spec |
| B | Two slices that each pass can break each other | Effects on shipped behaviour, and building on today's main |
| C | Nobody can see how an area works today | A current-behaviour view per epic, compiled from shipped specs |
| D | Every slice is interviewed from nothing | PRD on-ramp: the document proposes, the product manager confirms |
| E | No link to Jira for product work | A Jira key carried from slice to pull request |
| F | The record of why and who approved stays on one machine | A change record merged with the code (decision open) |

Order of building: A, B, C, D, E, then F once decided. A, B and C share the spec template, the validator and the interview method, so they are built one after another on one branch.

## What does not change

- The slice specs stay the authority. Everything compiled from them says so and names the slices it came from.
- Text from outside (a PRD, an issue, a principle read back from GitHub) is data. It proposes; a person confirms.
- Product Studio still never pushes, opens a pull request or starts a station. The Factory still never edits product text.
- No new user-facing program. New commands sit under `/mach-product-studio` and `/mach`.
- No gate is weakened. Every new check has an override only where a person gives a reason in their own words, and it is recorded.

## A. Product principles

A principle is one sentence that must hold in every slice, for example "A published version is never edited in place."

**Shape.** `PP-NN`, a title, one RFC 2119 statement, a short reason, a status (`active` or `retired`) and a revision. No technology in the statement: a technical rule is an ADR.

**Home.** They belong to the project. Product Studio keeps them in the draft workspace (`product/principles.json`) and saves them on the project's GitHub issue in a fixed section of its body, with an approval comment that carries the SHA-256 of the principles and the product manager's login, the same way a slice is approved. Without GitHub they travel as `product/ready/PRINCIPLES/principles.json`, committed by the product manager.

**Commands** (each on the product manager's word): `principle add`, `principle set`, `principle retire`, `principle list`, `principle publish`.

**Every spec answers every principle.** The slice template gains a section, `Principles`, with one row per active principle: its ID and revision, its statement quoted, and one of:

- `applies`: names the invariant, requirement or scenario in this slice that upholds it;
- `does not apply`: one sentence saying why;
- `exception`: the product manager's reason, in their words. Never recommended by rule.

`validate_slice.py` refuses a spec that leaves an active principle unanswered, quotes one wrongly, or names an ID in `applies` that the spec does not contain. A project with no principles has no section and nothing changes.

**The interview.** Before the first question the interviewer reads the principles. Where a principle plainly applies, the recommended answer follows it. Where an answer would break one, that conflict is the next question. In headless mode a conflict is an open question, which blocks.

**Downstream, with no new plumbing.** The section is part of the spec, so it reaches `spec.json`, the plan, the builder and the reviewers as the spec does. The product seat's checklist gains one line: check the diff against the principles the spec says apply. A blocker may cite `PP-NN` only if the spec lists it. An `exception` row is shown to reviewers as the product manager's decision and is not theirs to reopen.

**Timing.** A principle added or changed later binds slices marked ready afterwards. `refresh` flags a draft or ready slice answered under an older revision; work in the line is flagged in `status` and `explain` and never restarted. Same rule as ADRs.

**Engineer's tickets.** `/mach new` reads the published principles through the ticket station (or the ready folder), verified by the approval's hash. If none can be read, the spec has no section and the interview says so once.

## B. Slices that break each other

**What exists today.** The merge station merges main into the ticket's branch and reruns the whole test suite before landing. Release qualification reruns the suite at one commit and runs the project's integration command if one is declared. Both catch only what a test covers. The defect seen in the live run (a returned item would have broken the overdue report) was covered by no test, because neither spec said anything about the other. That is the gap: the interaction was never specified.

**Layer 1: the spec says what it does to shipped behaviour.** The template gains a section, `Effects on shipped behaviour`. During the interview a sub-agent looks up the shipped rules that mention the things this slice changes (part C supplies them, across every epic). Each rule found becomes one yes-or-no question and then one row:

- `kept`: the shipped rule still holds, and a scenario in this slice proves it with this slice's new data (for the example: "Given an item returned yesterday, when the overdue report runs, then the item is not listed");
- `changed` or `replaced`: names the requirement in this slice that takes its place;
- `retired`: the product manager's reason.

A row names the shipped rule as `SLICE-NNN/FR-NN`. The validator refuses a row whose rule does not exist in a shipped spec, a `kept` row with no scenario, and a `changed` row with no replacement. "None" is a valid section and must be written, so that silence is never read as "no effects".

**Grammar (fixed, so the validator and part C read the same thing).** The section is headed `## Effects on shipped behaviour` and holds either the single line `None.` or one table:

```
| Shipped rule | Effect | In this slice | Note |
|---|---|---|---|
| SLICE-003/FR-02 | kept | AC-04 | A returned item is not overdue. |
| SLICE-003/R3 | replaced | FR-05 | |
| SLICE-002/INV-01 | retired | | The product manager's reason. |
```

`Shipped rule` is `SLICE-NNN/` followed by an `INV-NN`, `FR-NN` or `RN` of that slice. `Effect` is `kept`, `changed`, `replaced` or `retired`. `In this slice` is an `AC-NN` for `kept`, an `INV-NN`, `FR-NN` or `RN` for `changed` and `replaced`, and empty for `retired`, which needs a `Note`. One shared parser, `skills/intent/scripts/effects.py`, reads it; nothing else parses the section.

**Layer 2: nothing new.** A `kept` row's scenario is an ordinary `AC-NN`. The existing gates already require a failing test for it, evidence from the verifier with data the builder never saw, and the product seat's check.

**Layer 3: build on today's main.** Today a cell's branch can be days behind main until the merge. Instead, the build station brings the branch up to date with main when it starts and when a revision starts (a clean merge continues; a conflict stops for a person, as at merge). The builder, the verifier and the reviewers then all work on the code that is really there.

**Layer 4: at the merge.** When main moved after verification, the merge station already reruns the suite. It will also look at what landed: if a slice that landed in between changed a file this ticket changed, or changed, replaced or retired a shipped rule this ticket's spec lists, the approval does not carry over. The cell returns to be verified and reviewed on the merged result, as it already does when the branch is not the approved commit. A pass uses no judging round.

**Not attempted.** MACH does not claim to find an interaction nobody specified and no file overlap points to. The project's integration command and the team's CI remain the last net.

## C. How an area works today

**The view is compiled, not written.** `run.py current [--epic <id>] [--all]` reads the slice specs on the integration branch and prints, per epic, every invariant, requirement and decision rule that is in force: all shipped rules, minus those a later slice `replaced` or `retired`, with `changed` rules shown in their new form. Each line names the slice it came from. Because part B makes every slice declare its effects, this is a script and not a summary: no model writes it.

Slices shipped before part B carry no declaration. Their rules are listed under "not yet reconciled" until a later slice names them.

**Where people read it.**

- Engineers and agents: `/mach current <epic>`. The interview and the contract engineer use it as a fact lookup.
- Product managers: Product Studio's `epic current <EPIC-ID>`, and one comment on the epic's issue that the Factory replaces each time a slice of that epic ships (fixed template, hidden marker, the commit it describes, bounded to GitHub's limit with a note when cut).

It is never committed, so it cannot go stale or conflict.

## D. PRD on-ramp

Optional. A product manager who has an approved PRD starts from it; one who does not works as today.

1. **Import.** `prd import <file>` (Markdown or plain text) copies the document into the draft workspace as `PRD-NN` with its SHA-256. It is data from then on: bounded where shown, never followed.
2. **Map.** The planning-tier model proposes epics and a list of thin slices, each with a one-line scope, its dependencies and the PRD lines it rests on. `prd map` records it only if every slice cites lines that exist, and reports every PRD section no slice cites as "not covered". The product manager settles each: a slice, out of scope, or later. Slice IDs come from the shared allocator.
3. **Confirm instead of interview.** `slice new --from-prd` opens the interview with its answers drafted from the cited lines, each shown with its citation. The product manager accepts them as a group, naming the ones to discuss; those, and everything the PRD does not settle, are asked one at a time as today. A contradiction inside the PRD is always a question.
4. **Same gates.** Principles, effects on shipped behaviour, the validator and `slice ready` apply unchanged. The why records the PRD's ID, hash and the lines used. The PRD's text is never sent to GitHub.

## E. Jira

One way, identifiers only, no Jira credentials and no call to Jira.

- `slice link <SLICE-ID> --jira KEY-123` and `epic link <EPIC-ID> --jira KEY-1`, on the product manager's word. The key must match Jira's form.
- The slice's issue shows `Jira: KEY-123` in its fixed template and marker. Intake carries it to the ledger and the cell.
- The merge station puts the key at the start of the pull request's title and in the merge commit's message, which is what Jira's GitHub integration reads to link the work and move the Jira issue. The run record keeps it.
- `tickets.jira.browse_url`, if set, turns the key into a link on the pull request.

Using Jira as the Factory's own ticket queue (`tickets.provider: jira`) is separate and unchanged.

## F. The shared record (decision open)

**Asked: stop git-ignoring `.factory/archive/` so it sits with the code.** Not as it is, for four reasons:

1. **Size.** Each archive is a compressed file holding screenshots, video and a Git bundle of the branch. Binary files in Git are kept for ever and the bundle repeats history already there.
2. **Secrets and personal data.** Evidence holds request and response dumps, database state and terminal transcripts, none redacted. An abandoned ticket's archive holds uncommitted and untracked files. Committing publishes them to everyone with the repository.
3. **Who commits it.** The archive is made after the merge. Committing it means a commit to main per ticket outside review (branch protection refuses it), or a second pull request per ticket. Each one also makes the audit report stale.
4. **Conflicts.** `runs.jsonl` is one file every engineer appends to.

**Decided 2026-11-20: a change record that is merged with the code.** The merge station writes `docs/changes/<ticket>.md` on the ticket's branch as its last act before landing, so it arrives in the same pull request or merge commit as the change. Text only, redacted by the shared rules:

- the why (`intent.md`) and the slice, revision and epic;
- the plan's task list and the ADRs and principles in force;
- the verification verdict: every scenario and rule, pass or fail, with the name and SHA-256 of each evidence file;
- every review round: each seat's vote and findings, who approved as a person and when, every exception with its reason;
- the builder's recorded overrides, and the commits approved and landed.

The evidence files themselves stay in the local archive, which can now be checked against the hashes in the record. A team that must keep them sets `records.publish_command`, run by cleanup with the archive's path, to send it to the company's own store.

The approval stays bound to the reviewed commit: the station accepts its own record commit only if it adds exactly that one file.

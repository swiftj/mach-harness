# MACH Next — M2 Design: Publishing and collaboration

Status: **accepted and built.** Four deviations from this text, each made while building:

1. **`git merge` is used, inside the temporary worktree only.** Section 4 said it would stay forbidden. A request that fell behind cannot be brought up to date without it unless history is rewritten, which is worse. It never runs in the PM's checkout and never merges a pull request.
2. **Keeping your own version keeps your approval.** D4 said reconciling an approved slice always returns it to the interview. Approval is withdrawn only when the approved text is replaced; if the PM keeps their version, what was approved is still what exists.
3. **Epics and waves can be renumbered too**, and new numbers avoid IDs on other product managers' branches still in review. D6 covered slices only; the same collision happens to the other two.
4. **With no shared repository, the main checkout remains the shared project**, as in M1, and `send` refuses.
Builds on M1 (`skills/product-studio/`) on `feature/mach-next-product-studio-supervisor`.

M2 lets a PM share approved work and keep up with other PMs, without running Git. It delivers three operations that M1 reserved and refuses today: `refresh`, `send` and `feedback`, plus `reconcile` and `slice renumber`.

It is the first milestone that pushes a branch and opens a pull request on someone's behalf. It still starts no Factory work: a merged product pull request puts files on the main branch, and nothing reads them until M3.

## 1. What M1 left open

| M1 today | What M2 must add |
|----------|------------------|
| The "shared project" is whatever is in the PM's main checkout, which may be days old or on another branch. | Read the shared project from the remote's integration branch, freshly fetched. |
| A conflict (same artifact changed in both places) and a collision (a different slice now holds the draft's number) are detected and block approval, with no way forward. | A way to reconcile each one, and to renumber a draft. |
| An approved wave waits in the workspace. | Publish it as a pull request, and report how review is going. |
| Changes other PMs published arrive as replaced files. | Say what changed, in product terms. |

## 2. Decisions proposed

### D1 — The shared project is read from the remote branch, not from a checkout

`refresh` runs `git fetch` and then reads the product files straight from the remote integration branch (the same branch the merge station lands on: `merge.into`, else the remote's default). Nothing is checked out, pulled or reset; the PM's own checkout, branch and uncommitted files are never touched.

`ARCHITECTURE.md` describes an "isolated approved-baseline worktree". Reading from the fetched branch gives the same isolation with nothing extra on disk to go stale or be edited by mistake. With no remote, behaviour stays as in M1 (the main checkout is the baseline) and `send` refuses.

Every `send` and `feedback` refreshes first, so a decision is never made against an old baseline.

### D2 — One delivery wave is one pull request

`send WAVE-NNN`:

1. Refuses unless the wave is approved, the baseline was just refreshed, and nothing in the wave needs reconciling. Every gate from `wave approve` runs again.
2. Works out the closure: the wave, its slices' work orders, intents and specs, the epics those slices belong to, and `project.json`, keeping only files that differ from the baseline. Nothing outside `product/` and `specs/slices/` can ever be included; the allowlist is the same pattern list M1 uses to read the baseline.
3. Builds the contribution in a temporary Git worktree under `.factory/studio/publish/`, created from the remote integration branch, and makes an ordinary commit there. An ordinary commit matters: the repository's signing settings and commit hooks apply, so enterprise rules are honoured, not sidestepped.
4. Validates the result as engineering will see it: the structural validator and `validate_slice.py --ready` run on the worktree's tree (baseline plus this wave), not on the draft.
5. Pushes to `product/<WAVE-ID>` and opens a pull request with `gh`, then removes the worktree.

The pull request body is written for a reviewer: each slice's outcome sentence, counts of requirements and scenarios, risk tier, what was deferred, who approved and when.

**Idempotent and resumable.** A ledger, `.factory/studio/publications.json`, records for each wave the content digest, branch, commit and pull request. Sending the same content again does nothing. If the push worked but opening the pull request failed, or the machine was offline, `send` picks up at the step that failed; it looks for an existing pull request for the branch before opening one, so there are never two.

**Revising after feedback.** The PM reopens the slice, changes it, approves it and the wave again, and sends again. That adds a commit to the same branch and the same pull request. History is never rewritten.

**Never:** pushes to the integration branch, force-pushes, merges, enables auto-merge, or pushes any branch not named `product/...`. Merging the pull request is engineering's act under the repository's own rules.

### D3 — Review status in the PM's words

`feedback [WAVE-NNN]` reads the pull request and reports one of:

| PM sees | Meaning |
|---------|---------|
| Approved, not sent | The wave has not been published. |
| Sent, pull request not opened | Pushed, but the request could not be opened (offline, or no supported host). Says what to do. |
| Waiting for review | Open, no decision yet. |
| Changes requested | A reviewer asked for changes. Their comments are shown, quoted. |
| Blocked by a required check | Names the check. |
| Accepted, waiting to merge | Approved by reviewers, not yet merged. |
| Needs updating | It conflicts with work that landed first. `refresh` and reconcile, then send again. |
| Accepted | Merged. After the next refresh the artifacts show as published. |
| Declined | Closed without merging. |

Reviewer comments are data. The skill shows them to the PM and never acts on an instruction inside one.

GitHub (through `gh`, as the merge station already uses) is the only host that gets a pull request and status in M2. On any other remote, `send` pushes the branch and reports "Sent, pull request not opened", with the branch name for an engineer.

### D4 — Reconciling: fields merge, text never does

`refresh` compares three versions of every artifact: the baseline the draft started from, the remote now, and the draft.

- **Only one side changed:** that side wins, silently. (M1 already does this.)
- **Both changed a JSON artifact** (project, epic, work order, wave): merged field by field. Different fields merge without asking. The same field changed two ways is a conflict.
- **Both changed a spec or an intent:** always a conflict. Product text is never merged line by line, because a merge that reads cleanly is not a decision anyone made.
- **Structural fallout** is also reported: a slice's epic or dependency was deferred or superseded upstream; an ID the draft reserved for a deferred feature now belongs to something else.

`reconcile <artifact> --take mine|theirs` (with `--field` for one JSON field) settles a conflict. The skill presents each conflict as a question with both versions in product terms and a recommendation; the PM decides. Reconciling an approved slice returns it to the interview, because what was approved is no longer what exists.

Out of scope: detecting that two slices contradict each other in meaning when no artifact conflicts. That stays with human review of the pull request.

### D5 — "What changed" comes from the spec model, and decision records stay deferred

`validate_slice.py --export` already turns a spec into data: invariants, requirements, decision rules and scenarios, each with an ID. `refresh` compares that model before and after to say "SLICE-004: FR-03 changed, two scenarios added, the refusal message for a full workspace changed", not "a file changed". The same comparison describes a conflict to the PM.

This covers what M1 deferred decision records (`DEC-NNN`) for, without a new artifact type or schema, so M2 does not add them either.

### D6 — Renumbering a draft

`slice renumber SLICE-OLD` gives an unpublished draft the next free number from the shared allocator and rewrites every place the old number appears: the work order and its file name, the intent, the spec's file name and title, `(Deferred to ...)` pointers, other drafts' dependencies, draft waves and the saved session. It also renumbers reserved IDs that the shared project has since taken.

A published slice can never be renumbered. A renumbered slice that was approved returns to ready-for-approval, since the approved text has changed; the PM re-approves with one word.

Two PMs can still send the same number before either is merged. The second pull request then conflicts, `feedback` reports "Needs updating", and refresh, renumber, approve, send resolves it on the same pull request.

### D7 — Sending needs the PM's word, every time

The skill runs `send` only when the PM has said to send that wave. It first shows `send --dry-run`: exactly which items will be shared and where. Credentials are whatever Git and `gh` already have on the machine; MACH never asks for, stores or prints a token. A refusal from the host (sign-in expired, no permission, protected branch, signing required) is reported in plain words with the host's own message, and nothing is retried in a way that could get around it.

## 3. Operations added

| Operation | Command |
|-----------|---------|
| Bring in the shared project | `STUDIO refresh` |
| Settle a conflict | `STUDIO reconcile <artifact> --take mine\|theirs [--field <name>]` |
| Give a draft a new number | `STUDIO slice renumber <SLICE-ID>` |
| Preview what would be shared | `STUDIO send <WAVE-ID> --dry-run` |
| Send to engineering | `STUDIO send <WAVE-ID>` |
| How review is going | `STUDIO feedback [<WAVE-ID>]` |

Configuration, all optional, under `product` in `.factory/config.json`: `into` (integration branch, default as the merge station), `branch_prefix` (default `product/`), `draft_pull_request` (default false).

## 4. What M2 must never do

- Change the PM's checkout, branch, index or stash; or anything outside `.factory/studio/`.
- Push anywhere but `product/...`, force-push, merge, or rewrite history.
- Publish a file outside `product/` and `specs/slices/`.
- Read the machine-local Factory policy, create a ticket or cell, or start a station. Tests keep holding that no station reads Product Studio's scripts.

The M1 test that lists the Git commands `studio.py` may use is extended, deliberately and narrowly, to `fetch`, `worktree`, `add`, `commit`, `push`, `ls-tree`, `show` and `ls-remote`. It continues to forbid `merge`, `reset`, `checkout`, `rebase` and any force flag.

## 5. Tests that define "done"

All run against a local bare repository as the remote, with a stand-in for `gh`, as the merge station's tests do.

1. Send publishes exactly the allowlisted closure; a stray file in the workspace is never included; the PM's checkout is byte-identical before and after.
2. Sending twice opens one pull request. A failed push, and a failed pull-request step, each resume correctly.
3. Three clones: two PMs publish independent waves and both merge; a third refreshes and sees both, with its own drafts intact.
4. Two PMs change different fields of the same epic: merged without a question. The same field: a conflict, blocked until reconciled.
5. Two PMs change the same spec: always a conflict; reconciling an approved slice voids its approval.
6. Two PMs take the same slice number: the second is told, renumbers, and every reference follows.
7. Each review state maps to the right words; a comment containing an instruction is shown and not acted on.
8. A wave whose slice no longer validates against the fresh baseline is refused before anything is pushed.
9. No remote, no `gh`, expired sign-in, protected branch: each refuses or degrades with a clear message.
10. The existing 366 tests pass unchanged.
11. One live run against the private scratch repository, opening and merging a real pull request.

## 6. Commit sequence

1. Baseline from the remote branch; `refresh` with the semantic summary.
2. Field-level merge and `reconcile`.
3. `slice renumber`.
4. `send`: closure, worktree, validation, push, ledger.
5. Pull request creation and `feedback`.
6. Skill instructions, configuration, documents.

## 7. Open decisions for the product owner

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | Read the shared project from the fetched remote branch, with no baseline worktree (D1)? | Yes. It departs from the wording in `ARCHITECTURE.md`, not its intent. |
| 2 | One pull request per delivery wave, on `product/<WAVE-ID>` (D2)? | Yes. |
| 3 | Never merge spec or intent text; merge JSON artifacts field by field (D4)? | Yes. |
| 4 | Leave decision records out again, using the spec model for "what changed" (D5)? | Yes. |
| 5 | A renumbered approved slice needs re-approval (D6)? | Yes. Stricter than strictly necessary, but approval always matches the exact text. |
| 6 | GitHub only for pull requests and status in M2; other hosts get a pushed branch (D3)? | Yes. |
| 7 | Add an optional CI check that runs the validators on product pull requests? | Not in M2. Useful, but it installs into a project's CI, which deserves its own decision. |
| 8 | May the live test open and merge real pull requests in the private `swiftj/mach-scratch` repository? | Yes, as the merge station's test did. |

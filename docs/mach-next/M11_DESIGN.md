# M11 design: slices as GitHub issues, no delivery waves, and architecture decisions

Status: agreed by the owner, 2026-11-17. Nothing here is built. Section 10 records the four points
that were open and how each was decided.

## 1. What was decided

1. Product Studio is about product intent: a **project** has **epics**, an epic has **slices**.
   Delivery waves are removed.
2. A finalized slice is stored as a **GitHub issue**, which is also how it reaches the Factory.
   Product Studio creates the issue and manages every label and approval; a product manager never
   opens GitHub. Drafts stay local.
3. Approval records a hash of the slice. An edit to the issue afterwards voids its readiness until
   the product manager approves again.
4. There is no engineering review of a slice before it is built. The contract engineer is the review.
5. The Factory takes in ready issues on its own, on a machine whose engineer has enabled it, within
   the concurrency limits. It stays off on every machine until enabled there, and no issue, label or
   file can enable it.
6. The Factory's output is still a pull request per ticket. CI/CD after that is out of scope.
7. `gh` is assumed on the product manager's machine. Without it, Product Studio writes the same
   finalized slices to a folder.
8. Engineers record technology decisions as ADRs in MADR format, in Git. They bind the Factory.

### What this replaces

| Earlier decision | Where | Now |
|---|---|---|
| Approved work is delivered through delivery waves | `ADRS.md` ADR-005 | Removed. A slice is ready on its own. |
| A wave is published as one pull request and merged by engineering | M2, `studio.py send` | Removed. The issue is the handoff. |
| "Git remains the only approved record of a slice"; no label may make work eligible | `docs/mach-github-issues-integration-spec.md` section 2 and 9 | Reversed for slices: a ready label, applied through Product Studio and checked as in section 4, makes a slice eligible for intake. |
| A merged wave makes work eligible for intake, not authorized | `ADRS.md` ADR-014 | Kept in spirit: a ready issue makes work eligible; machine enablement, preflight and every station gate still apply. |

Kept unchanged: the interview, the spec validator, slice approval bound by SHA-256, the request
issues of M8 (`mach:request`), the scheduler's limits, every station and its gates, machine-local
authorization.

## 2. The product model in GitHub

| Thing | In GitHub | Labels |
|---|---|---|
| Project (vision, outcomes) | One pinned issue | `mach:project` |
| Epic | One issue; its slices are its sub-issues, in the product manager's order | `mach:epic` |
| Slice | One issue, a sub-issue of its epic | `mach:slice`, plus one state label |

Slice state labels, all written by MACH and never by hand: `mach:ready` (approved, waiting for the
Factory), `mach:building` (the Factory has taken it), `mach:question` (the builders need the product
manager's answer), `mach:shipped` (merged; the issue is closed). A slice with none of these is not
visible to the Factory.

Request issues keep `mach:request`. Their status labels from M8 (`mach:grooming`, `mach:ready`)
are dropped, because `mach:ready` now means a slice is ready; a request's progress is told by
comments from the fixed templates and by links to the slices it produced.

Where sub-issues are not available on a repository, the epic lists its slices as a task list and each
slice carries `mach:epic-<number>`. Product Studio picks the form once per repository and records it.

### The slice issue

The title is the slice's name. The body is written from a fixed template and is replaced whole on
each approval:

```
<!-- mach:slice id=SLICE-007 revision=2 epic=#41 depends=#38,#40
     spec-sha256=<hex> why-sha256=<hex> -->
## Why
<the approved why>
## Specification
<the approved slice spec, unchanged>
```

A body over GitHub's size limit is refused at approval with the reason: a slice that large is not
thin. Issue text is never executed or treated as instructions by any station; the spec in it is
validated exactly as a spec file is today.

## 3. Product Studio

- **`slice ready`** replaces `slice approve`, `wave approve` and `send`. It runs the approval gates
  (the spec passes `validate_slice.py --ready`, no open questions, a complete why, its epic and its
  dependencies exist; the epic is never approved, see section 11), then: creates or updates the issue, posts an approval comment from a fixed template that
  carries the two hashes, the revision and the approver, and only then adds `mach:ready`. A ledger
  records each step before it is tried, so an interrupted run never duplicates an issue.
- **`slice reopen`** removes `mach:ready` first, then lets the draft be edited. If the Factory has
  already taken the slice, today's revision rules apply: work in the line is never changed, and it is
  flagged for a person.
- **`refresh`** reads the project, epics and slices from issues. The three-way merge of product files
  across product managers goes away with the files; what remains is one rule: a slice issue whose
  current revision is newer than the local draft's base is shown as changed by someone else, and the
  product manager chooses mine or theirs before approving.
- **Removed:** wave commands and screens, `send`, `feedback`, the `product/...` branches and pull
  requests, and wave acceptance (see section 6).
- **Never, as today:** touches the checkout, starts a station, reads the machine-local Factory
  policy. On GitHub it creates and edits only issues carrying its own labels and comments from fixed
  templates.

### Without `gh`

`slice ready` writes the same content to `product/ready/SLICE-NNN/` in the draft workspace
(`spec.md`, `why.md`, and `slice.json` with the hashes, epic and dependencies) and says where it is.
Two ways on from there:

- The product manager commits that folder to the repository. The Factory picks it up from the
  integration branch, read from Git objects as intake does today.
- The folder is handed over some other way. The engineer runs `/mach product import <folder>`,
  which verifies the hashes and files the ticket.

## 4. What the Factory accepts

A slice issue is taken in only when all of these hold, read from the repository the `origin` remote
names and nowhere else:

1. It carries `mach:slice` and `mach:ready`, and is open.
2. The last time `mach:ready` was added, it was by an account whose role on the repository is
   triage, write, maintain or admin.
3. The approval comment was written by that same account and has not been edited.
4. The body's marker matches the comment, and the hashes of the why and the spec in the body match
   the hashes in the comment.
5. The spec passes the intent station's gates, as a spec does today.

Anything that fails is listed as "not accepted" with its reason and is never built. The limit of this
check is stated plainly: anyone with write access who sets out to forge an approval can. It guards
against accidents and edits, not against a determined insider; the owner accepted that.

## 5. Intake, scheduling and status

- **The slice issue is the execution ticket.** There is one issue per slice from idea to merge. The
  cell, the branch and the pull request are named for it, and the pull request says `Refs #n`.
- **Where the spec lives.** At dispatch the spec is copied from the issue into the cell and committed
  to `specs/slices/` on the ticket's branch, so it merges with the code as today. The why becomes
  `intent.md`. The repository no longer holds project, epic or work-order files.
- **Automatic.** Each supervisor pass on an enabled machine lists ready issues, verifies them, and
  schedules them. `/mach product intake` remains for a machine that is not enabled. Pause, resume,
  stop, `factory.max_parallel`, `factory.max_parallel_high` and the file-overlap rule are unchanged.
- **Order.** A slice waits until every slice it depends on is merged (checked in Git, as now); then
  the product manager's order within the epic; then oldest ready first.
- **Status back to the issue.** `mach:building` when the cell opens; `mach:question` with the
  contract engineer's question (redacted and bounded, as reviewer text is today) when the spec has a
  defect; `mach:shipped` and close when the pull request merges. Each write is recorded before it is
  tried, retried on the next pass, and never blocks the line.
- **A question from the builders.** The product manager answers it in Product Studio and marks the
  slice ready again. That is a new revision; the cell sees the changed spec and plans again without a
  separate instruction, which is already built.

## 6. Releases and acceptance

`/mach release qualify` takes an epic or a named list of slices in place of waves. Product
acceptance is recorded per epic, as a comment from a fixed template on the epic's issue, bound to the
release's commit as it is bound to a wave's bytes today.

## 7. Architecture decisions (ADRs)

- **Where:** `docs/adr/NNNN-title.md` (`adr.dir` in `.factory/config.json` to change it), in MADR
  format, changed only through ordinary pull requests by people. MACH's own design decisions in
  `docs/mach-next/ADRS.md` are a different thing and are untouched.
- **Header:** MADR's `status` (`proposed`, `accepted`, `superseded by ADR-NNNN`, `deprecated`),
  plus one MACH field, `applies-to`: paths, app types or topics. Only `accepted` ADRs bind.
- **Plan:** the contract engineer is given the accepted ADRs that apply and the plan names each ADR
  it relied on. `cell.py check-plan` refuses a plan that names an ADR that does not exist or is not
  accepted.
- **Build:** the builder is given the same ADRs. It has no override for them.
- **Review:** the architecture seat checks the diff against them; a violation is a blocker that cites
  the ADR's ID, like any rule.
- **A plan that cannot comply** stops for an engineer, who supersedes the ADR or records an
  exception with a reason, which is shown to the reviewers.
- **No ADR covers a needed choice** (a new library, a new language): the contract engineer writes a
  `proposed` ADR on the ticket's branch. Low and Medium risk work continues and the proposal is
  reviewed with the change; High risk work waits for an engineer to accept it.
- **Timing:** a newly accepted ADR applies to tickets planned afterwards. Work already planned is
  flagged for the engineer and never restarted.
- **Commands:** `/mach adr new "<decision>"` (a short interview that writes the file as
  `proposed`; accepting it is the engineer's edit and pull request) and `/mach adr list`.
- **Readiness check:** a project with no accepted ADR about its stack gets a note, not a lower score.
- **Never:** the Factory, the observe station and tuning tickets do not accept, change or supersede
  an ADR.

## 8. Order of building

1. ADRs (section 7). Independent of everything else.
2. Product Studio engine: remove waves; `slice ready` and `reopen` against issues; `refresh` from
   issues; the no-`gh` folder.
3. Factory: acceptance checks, intake from issues, status writes, automatic intake in the supervisor.
4. Releases and acceptance per epic.
5. Product Studio screens for the above (the home and interview screens are being rebuilt now on the
   current engine).

Each step ends with the full test suite and a live check in a throwaway project.

## 9. Later: existing projects

Backlog, not designed here: read an existing repository (code, configuration, deployment files,
dependency versions) and recover slice specs and `proposed` ADRs from it, for a person to correct and
accept, so MACH can work on existing and legacy projects.

## 10. Decided on 2026-11-17

1. **The slice's issue is the Factory's ticket.** One issue per slice from idea to merge; the Factory
   files no separate ticket, and a person names it by its number (`/mach 41`). A slice changed after
   it shipped gets a new issue linked to the closed one, since shipped work keeps its history.
2. **Project and epic definitions live only in issues.** The repository holds no project, epic or
   work-order files. Each spec merged to `specs/slices/` carries its epic's name and its issue number
   in its header, so the repository still says where a slice belongs.
3. **A slice's issue closes when its pull request merges.** MACH closes it after the merge is seen on
   the integration branch; the pull request itself still says `Refs`, never a closing keyword. An epic
   closes on the product manager's word.
4. **Slice IDs stay `SLICE-NNN`**, allocated when a draft is created, checked against every slice
   issue at approval, and renumbered then on a clash. The ID is shown beside the issue number.

## 11. Decided on 2026-11-18

1. **Epics are not approved.** An epic is a container for slices: a title, its "Done when" criteria
   and its slices. A slice is what is approved, when the product manager marks it ready. The gate
   "its epic is approved" is gone from `slice ready`, and so are `epic approve`, the `approve_epic`
   next action and hint, the host's `epic.approve` operation and every screen and word for it. The
   engine as first built for this milestone required an approved epic; this corrects it.
2. **An epic's state is `open` or `deferred`** ("set aside"), set with `epic set --status`. A new epic,
   and one `slice take` creates from its issue, is `open`. `proposed`, `approved`, `completed` and
   `superseded` are removed: nothing but a bare flag ever set the last two. Nothing on the Factory
   side read an epic's state (intake, release qualification, `slice_acceptance`, `epic-check` and the
   epic's issue template carry none), so nothing there changed. Old drafts are not migrated.

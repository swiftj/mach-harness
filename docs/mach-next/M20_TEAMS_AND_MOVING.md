# M20 design: teams, and moving a project

Status: a proposal. Nothing here is built. It rests on two investigations run against MACH 0.20.0 on 2026-11-23:

- a real GitHub issue transfer between two private throwaway repositories, with a real MACH project in the first;
- an audit of what happens when several product managers and several engineers use MACH at once on one repository, with 15 reproduction tests (9 of them show a defect and are marked as expected failures).

## 1. What we found

### 1.1 Teams

MACH works today for several product managers who take turns and one engineer's Factory. It does not yet work for several engineers building at once.

| # | What goes wrong | Told to anyone? | Evidence |
|---|---|---|---|
| T1 | Two Factories (or two supervisors) take the same slice and both build it. Only the order of labels stops it; the window is seconds, and stays open while a status write waits in its retry queue. | No | reproduced |
| T2 | A pull request is merged onto a shared main that moved since it was tested. The merge station compares with the local checkout, never with `origin/main`. | No | reproduced |
| T3 | A slice is reopened and marked ready while one Factory builds it; any other Factory takes the new revision as new work. | No | reproduced |
| T4 | Two engineers grooming their own tickets take the same slice number. Both specs land on main under different file names; Git sees no conflict and the compiled view of shipped rules quietly reads one. | No | reproduced |
| T5 | A second product manager marking a slice ready rewrites the shared project issue (vision, outcomes) and the epic issue (criteria) from their own workspace. Last writer wins. | No | reproduced |
| T6 | Two product managers mark a slice ready at the same moment with the same number: two issues hold one slice ID. The Factory refuses the second later, on an engineer's screen. | Late | reproduced |
| T7 | Two people create the project at the same time: two project issues. | Late | reproduced |
| T8 | A slice whose dependency was built on another machine stays "blocked" with a false reason. | Yes, wrongly | reproduced |
| T9 | Two engineers take the same ADR number. Both ADRs stop binding and every plan is refused until one is renumbered. | Yes, loudly | reproduced |
| T10 | An epic whose slices were built on different machines cannot be qualified for release anywhere: each machine holds only its own run records. | Yes | code reading |
| T11 | Without GitHub (ready folders), two product managers' different epics under one `EPIC-001` are taken in with no warning. | No | reproduced |

What already holds: the same next slice number taken one after the other is refused at "mark ready" and renumbered with every reference; the same slice edited on two computers is reported with a choice of yours or theirs; principles and technical needs published by two people are refused and reconciled; a request picked up twice is reported.

### 1.2 Moving a project to another repository

GitHub's transfer keeps each issue's text and each approval comment exactly (body, author and times). MACH still cannot use a moved slice:

| Thing | After a transfer |
|---|---|
| Issue numbers | All change. Each slice issue's hidden marker names its epic and its dependencies by the old numbers, which now point at other issues or none. |
| Labels | Dropped when the destination has no label of that name, and with them the record of who added `mach:ready`. Kept, with history, when the labels exist beforehand. |
| Epic and sub-issue links | Survive only when transfers are spaced 15 to 20 seconds apart. Back to back, some are lost. |
| The project issue | Loses its pin; MACH no longer finds it and makes a second one on the next publish. |
| Product Studio's records | Wiped when the repository changes, so it treats its own moved slices as someone else's and offers to renumber them. |
| The Factory's ledger | Keeps the old ticket numbers as ready. In the new repository those numbers are other issues. |
| With the project still pointing at the old repository | Refresh says everything is saved and every slice is ready. Nothing is flagged. The "issue has moved" message is never reached. |

A few ordinary commands after a transfer left the destination with two project issues, two epics and two copies of one slice.

### 1.3 The cause the two share

MACH identifies things in two ways that do not travel:

- **numbers counted on one computer** (`SLICE-011`, `EPIC-002`, `PP-03`, ADR numbers): two people count separately;
- **GitHub issue numbers in one repository** (`#6` as the ticket, the epic link, the dependency link): they change on any move.

And it has **no claim that two machines both respect**: every claim and lease is a local file.

The design below fixes the claim first, then makes references travel by MACH's own ID, then builds the move on top.

## 2. Part A: safe for a team

Ordered by harm. Sizes: S is a day or two, M about a week, L more.

### A1. One Factory builds a slice (T1, T3). M

- **Claim on GitHub at dispatch.** Just before a cell is opened, the Factory reads the issue again, posts a claim comment in a fixed template carrying a random value of its own, reads the comments again, and goes on only if its claim is the earliest for that revision. The loser opens nothing, withdraws its comment and reports "another Factory took SLICE-011 (claimed by @x at 14:02)".
- **`mach:building` is respected.** Intake does not accept an issue that carries `mach:building` unless this Factory's own ledger holds that slice. That closes T3.
- **A status write that failed blocks dispatch** of that slice until it is sent, so the claim is never only local.
- Supervisors use the same claim. Several engineers' Factories on one repository, attended or unattended, are the normal team case: each builds only what it claimed.

This is a comment and two reads per dispatch. GitHub offers no atomic test-and-set on an issue, so the earliest-claim rule is the strongest available without a server of our own.

### A2. Merge against the shared main (T2). S to M

- The merge station fetches and re-validates against `origin/<main>`, not the local checkout: the overlap check and the test run happen against what is really there.
- `merge.method: "local"` is refused when the repository has a remote that others push to, or it pushes and re-checks; today it leaves the problem to a person.
- The doctor warns when the GitHub branch is not protected with "require branches to be up to date" and required checks.

### A3. Numbers that cannot be taken twice (T4, T6, T9, T11). M

Drafts stay private until marked ready; that rule does not change. So numbers are checked where they become shared:

- **At "mark ready"**: after creating the issue, read the list again. If another open issue holds the ID, the later one is told at once and offered the renumber that already exists.
- **Engineers' own tickets**: the allocator also reads the slice issues on GitHub and the specs on `origin/main`. The merge station refuses a spec whose slice ID is already on main under another file name.
- **A PRD's drafts**: refresh before allocating, and renumber a whole batch in one step when numbers were taken meanwhile.
- **ADR numbers**: the next number also counts `origin/main` and open pull-request branches.
- **Ready folders**: intake refuses one epic ID with two titles.

**Built (Product Studio's part).** After `slice ready` makes a slice's issue, a step of its own reads the slice issues again, before the approval comment and `mach:ready`. If an earlier open issue holds the same ID, GitHub's first one keeps it. The later one is closed with a fixed comment and loses MACH's labels, so neither Product Studio nor the Factory reads it again (closing was chosen over taking off `mach:ready`: an open issue still holding the ID would stay a duplicate in every later read, and could be taken as a dependency's issue). The product manager is refused in plain words (who holds the number, which issue), the slice goes back to waiting for approval, and the renumber is offered. A new epic issue gets the same look-again (another title: closed, renumber the epic; the same title: the earlier issue is used). A refresh on either computer reports an ID held twice; the computer whose slice issue came second closes it then, unless the builders took it. `prd apply` and `idea apply` read GitHub's numbers before numbering. Engineers' own tickets, ADR numbers and ready folders are not part of this.

### A4. Shared text is never silently replaced (T5, T7). M

- The project issue and each epic issue get what slices already have: a recorded base revision, "someone else changed it" at refresh, and a choice of yours or theirs. Marking a slice ready never rewrites a project or epic body this workspace did not last save.
- One project per repository is enforced: `project init` adopts the project issue that exists; when several exist, MACH refuses and names them.

**Built.** The workspace keeps the SHA-256 of the project's own text (title, vision, outcomes) and of each epic's (title, criteria) as it last wrote or read them. `slice ready`, and publishing the principles or needs, rewrite that text only while GitHub still holds it. A workspace that never saw it, or has nothing of its own unwritten, takes GitHub's; when both changed, nothing is written, refresh and status say someone else changed the project (or the epic), and `reconcile project|EPIC-NNN --take mine|theirs` settles it. `project init` takes an open project issue already there; with several open, `project init`, `slice ready` and publishing refuse and name them. A project issue made at the same moment as an earlier one is closed and the earlier one used. The Factory side is unchanged: with several project issues, grooming still carries on with no principles (`cell.py` treats `principles-check`'s "several" like "none").

### A5. A dependency built elsewhere (T8). S

For a dependency this Factory did not build, the plan reads the merged spec on main, as it already does for a slice it never took in.

### A6. Qualifying a release across machines (T10). L

Run records and archives are published to a shared place (the hook `records.publish_command` exists), and qualification reads them. This is the largest item and can follow the others.

### What a team should agree today, before any of this is built

- One Factory pulls and dispatches: one engineer's machine or one supervisor. Never two supervisors on one repository.
- Merge by pull request, with GitHub set to require an up-to-date branch and passing checks.
- One product manager creates the project and each epic; the others refresh before adding slices.
- Refresh before starting a slice and before marking one ready.
- Tell the engineer before reopening a slice that is being built.
- Engineers let Product Studio allocate slice numbers, or announce a number before grooming.
- Qualify an epic on the machine that built all of its slices.

## 3. Part B: moving a project

### B1. References by MACH's own ID. M

Each issue's hidden marker names its epic and dependencies by ID (`epic=EPIC-002 depends=SLICE-009`) as well as by number. MACH resolves by ID within the repository and treats the number as a shortcut it re-checks. A moved issue is then still a correct issue. This also removes the wrong-dependency risk found in T6.

Open point: whether the approval's hashes cover the marker line. If they do, rewriting a marker needs a new approval; if not, MACH can correct numbers in place. To be checked in the code before B2 is fixed in detail.

### B2. "Move this project", in Product Studio. L

On the product manager's word, with the destination named:

1. **Check first, change nothing.** Everything refreshed; no slice being built (or each one named and acknowledged); the person can write to both repositories; MACH's labels are created in the destination.
2. **Move in a safe order**, spaced so links survive: project issue, epics, slices, ideas, requests. MACH uses GitHub's own transfer, so every approval comment arrives as it was written, by the person who wrote it, at the time they wrote it.
3. **Put right what a transfer breaks**: pin the project issue; restore epic links and order; correct the numbers in each marker; check every approval still verifies.
4. **Record the move**: a map of old number to new number, kept in the workspace and written as one comment on the project issue. Product Studio's records are re-pointed, not wiped.
5. **Stop half-way safely.** Each step is recorded before it is tried, as publishing already is; running the command again finishes the move and repeats nothing.

Afterwards the old repository holds nothing of MACH's, and the old addresses redirect.

### B3. The Factory after a move. M

- Refresh and intake recognise a moved issue (GitHub answers with a redirect) and say so: "This project's issues moved to owner/new. Point this checkout at it."
- With the map, the ledger's entries are re-keyed to the new numbers. Open cells and branches named after old ticket numbers are finished or abandoned first; the move refuses while a slice is being built unless told otherwise.

### B4. Merging two projects into one repository. L

Both projects count from one, so the incoming one is renumbered on the way in:

- every incoming epic, slice, principle, need and idea takes the next free number in the destination, in order;
- every reference moves with it: markers, dependencies, the specs and "why" files, shipped rule IDs (`SLICE-011/FR-02`), ready folders, mock paths;
- files already in Git (shipped specs, ADRs) are renumbered in one pull request that MACH prepares and a person merges;
- the map of old to new IDs is kept, so an old ID can always be looked up.

One decision is needed: one repository still means one project. Two products in one repository would either become one project with more epics, or MACH would have to learn several projects per repository, which is a larger change again. This design assumes the first.

### B5. A path that needs no GitHub transfer

`project export` writes the whole project to a folder that names no repository; `project import` brings it into another. It covers moves across organisations and to trackers other than GitHub. Approvals cannot be carried this way as if given there: each slice is offered to its product manager to mark ready again. Worth building only if B2 proves too narrow.

## 4. Order of work

| Step | Contents | Size |
|---|---|---|
| 1 | A1 claim, A2 merge against shared main, A5 dependency elsewhere, ADR and post-ready number checks from A3 | M |
| 2 | Rest of A3, and A4 shared text | M |
| 3 | B1 references by ID, B3 recognising a move | M |
| 4 | B2 move this project | L |
| 5 | B4 merging two projects | L |
| 6 | A6 qualifying across machines | L |

Step 1 removes the three ways work is duplicated or merged untested without anyone being told. The nine failing reproduction tests become the acceptance tests: each must pass when its item is done.

## 5. Not in this design

- An engineer's page in the browser for architecture decisions. Raised and left open.
- Converting existing ADRs from another format, and bringing in several design documents or PDFs at once.
- Windows and Intel Mac builds.

## 6. Decided by the owner (2026-11-23)

1. Step 1 is built first, ahead of moving a project.
2. One repository holds one project. A move is a team leaving an old repository for a new one. When the destination already holds a project, the incoming epics and slices join it as more epics, renumbered; MACH does not learn several projects in one repository.
3. Several engineers each running `/mach pull`, or their own supervisor, on their own machines against one repository is the normal team case and must be safe. The claim in A1 is what makes it so: every Factory builds only what it claimed.

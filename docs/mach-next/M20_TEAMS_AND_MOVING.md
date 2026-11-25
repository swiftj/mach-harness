# M20 design: teams, and moving a project

Status: Part A is built. Part B (moving a project) is a proposal; nothing of it is built. Also built alongside: a ticket's workspace that holds no `.claude/` files, and the basic decisions drafted from an engineer's own documents (both in `docs/BLUEPRINT.md`). It rests on two investigations run against MACH 0.20.0 on 2026-11-23:

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

### A1. Factories keep out of each other's way (T1, T3). M

- **Claim on GitHub at dispatch.** Just before a cell is opened, the Factory reads the issue again, posts a claim comment in a fixed template carrying a random value of its own, reads the comments again, and goes on only if its claim is the earliest for that revision. The loser opens nothing, withdraws its comment and reports "another Factory took SLICE-011 (claimed by @x at 14:02)".
- **`mach:building` is respected.** Intake does not accept an issue that carries `mach:building` unless this Factory's own ledger holds that slice. That closes T3.
- **A status write that failed blocks dispatch** of that slice until it is sent, so the claim is never only local.
- Supervisors use the same claim. Several engineers' Factories on one repository, attended or unattended, are the normal team case: each builds only what it claimed.

This is a comment and two reads per dispatch. GitHub offers no atomic test-and-set on an issue, so the earliest-claim rule is the strongest available without a server of our own.

### A2. Merge against the shared main (T2). S to M

- The merge station fetches and re-validates against `origin/<main>`, not the local checkout: the overlap check and the test run happen against what is really there.
- `merge.method: "local"` is refused when the repository has a remote that others push to, or it pushes and re-checks; today it leaves the problem to a person.
- The doctor warns when the GitHub branch is not protected with "require branches to be up to date" and required checks.

**Built (2026-11-23).** With an `origin` remote, `merge.py run` fetches `origin/<into>` (only that branch; no checkout changes); unreachable or missing means nothing is merged (`remote-unreachable`, `no-shared-main`), no fallback. With `pr`, every check before landing (revalidation merge, conflict, test run, landed-overlap) is made against `origin/<into>`. With `local` (the default), the checks are made against the local main as before, unpushed commits included, but only when it already holds `origin/<into>`; otherwise nothing is merged and the refusal says how many commits to pull. A local merge is never pushed and the result's `note` says so. `plan` reads origin as last fetched. With no remote, `HEAD` as before. Moved base: the station's existing policy (merge main into the branch inside the cell, rerun, overlap check) is reused unchanged. For `pr`, origin's branch is read again with `git ls-remote` immediately before `gh pr merge --match-head-commit`; moved means "moved again; re-validating", at most two re-validations per run, then `main-moving` with the pull request left open. A GitHub refusal with a moved base is treated the same. After merging, the merge commit's first parent is compared with the commit tested on; a difference is reported (`untested_base`, `warning`), since it cannot be undone. `local` is not refused for having a remote (it is the default, and a person alone with a GitHub remote must keep working), and it never pushes: pushing would bypass the platform's protection and checks. The doctor's `merge.protection` check reads the branch's rulesets, then its classic protection; its `merge.method` check warns when the method is `local` and GitHub shows more than one collaborator who can push (whether others push cannot be seen from Git), `not_checked` when that cannot be read. Both are read-only. The team-audit reproduction `test_shared_main_moving_is_revalidated` now passes. Left open: GitHub has no compare-and-swap on the base, so without its "up to date" rule a merge in the instant after the last read can still land untested (now reported). The build station's "build on main" still compares with the local main.

### A3. Numbers that cannot be taken twice (T4, T6, T9, T11). M

Drafts stay private until marked ready; that rule does not change. So numbers are checked where they become shared:

- **At "mark ready"**: after creating the issue, read the list again. If another open issue holds the ID, the later one is told at once and offered the renumber that already exists.
- **Engineers' own tickets**: the allocator also reads the slice issues on GitHub and the specs on `origin/main`. The merge station refuses a spec whose slice ID is already on main under another file name.
- **A PRD's drafts**: refresh before allocating, and renumber a whole batch in one step when numbers were taken meanwhile.
- **ADR numbers**: the next number also counts `origin/main` and open pull-request branches.
- **Ready folders**: intake refuses one epic ID with two titles.

**Built (Product Studio's part).** After `slice ready` makes a slice's issue, a step of its own reads the slice issues again, before the approval comment and `mach:ready`. If an earlier open issue holds the same ID, GitHub's first one keeps it. The later one is closed with a fixed comment and loses MACH's labels, so neither Product Studio nor the Factory reads it again (closing was chosen over taking off `mach:ready`: an open issue still holding the ID would stay a duplicate in every later read, and could be taken as a dependency's issue). The product manager is refused in plain words (who holds the number, which issue), the slice goes back to waiting for approval, and the renumber is offered. A new epic issue gets the same look-again (another title: closed, renumber the epic; the same title: the earlier issue is used). A refresh on either computer reports an ID held twice; the computer whose slice issue came second closes it then, unless the builders took it. `prd apply` and `idea apply` read GitHub's numbers before numbering. Engineers' own tickets, ADR numbers and ready folders are not part of this.

**Built (the Factory's part, 2026-11-23).** *Engineers' own tickets*: `cell.py next-id` also counts the specs on `origin/<main>` as last fetched (it fetches nothing) and, when the ticket provider is GitHub, every slice issue's ID, open or closed, through a new read-only `ticket.py slice-ids`; when GitHub cannot be read, `not_counted` says so in one sentence. Product Studio's allocator (`cell.slice_ids`) is unchanged. Two engineers numbering in the same minute still take one number; the merge station then refuses (`slice-id-taken`) a spec its branch adds whose slice ID is already on the local main or `origin/<main>` under another file name, unless it is the same slice by `cell.py handed_over` (the 0.20.0 rule). *The shared main takes a slice once*: `merge.py run` loads `intake.py` from the run skill by path (one definition of `already_landed` and `landed_message`) and asks it after its fetch, and again after each re-fetch when main moved, before it merges, pushes, opens or merges anything. A cell with `product` whose revision is on main and not its own (no `merged` record, its branch commit not on that branch, with `pr` its own pull request not merged) is refused (`landed-elsewhere`) with intake's sentence and "Nothing was pushed or merged."; an open pull request of its own is left open with a note; the cell stays for cleanup. *ADR numbers*: `adr.next_number` also counts the ADR files on every `origin/*` branch and fetched `refs/pull/*` ref, as last fetched; `adr new` and `cell.py adr-draft` fetch nothing, so it is as fresh as the engineer's last fetch. Every remote branch is counted, not only those with an open pull request: refs alone cannot tell, and an extra number skipped costs nothing. Two ADRs on main with one number: the problem on each names the other file, the later one (by the commit that added it) and the exact command; `run.py adr renumber <file>` renames it to the next free number and changes its own mentions, references to it by file name in the other ADRs and the overview, and the overview's row and marker entry; a bare ID that both ADRs had is listed for the engineer to check, not guessed. It never commits. *Ready folders*: intake refuses a folder whose epic ID a slice taken in before it in the same pass uses with another title, naming both. Earlier ledger entries are not compared, so renaming an epic over time is not refused. Tests: `tests/test_team_ids.py` (both former expected failures now pass, restated as the fix), `tests/test_team_merge.py::ShippedOnceTest`, `tests/test_mach_product_principles.py`.

### A4. Shared text is never silently replaced (T5, T7). M

- The project issue and each epic issue get what slices already have: a recorded base revision, "someone else changed it" at refresh, and a choice of yours or theirs. Marking a slice ready never rewrites a project or epic body this workspace did not last save.
- One project per repository is enforced: `project init` adopts the project issue that exists; when several exist, MACH refuses and names them.

**Built.** The workspace keeps the SHA-256 of the project's own text (title, vision, outcomes) and of each epic's (title, criteria) as it last wrote or read them. `slice ready`, and publishing the principles or needs, rewrite that text only while GitHub still holds it. A workspace that never saw it, or has nothing of its own unwritten, takes GitHub's; when both changed, nothing is written, refresh and status say someone else changed the project (or the epic), and `reconcile project|EPIC-NNN --take mine|theirs` settles it. `project init` takes an open project issue already there; with several open, `project init`, `slice ready` and publishing refuse and name them. A project issue made at the same moment as an earlier one is closed and the earlier one used. *Later (joining the project)*: a second product manager no longer starts the project with `project init` and opens other people's slices with `slice take`. A workspace with no project takes the whole published project from GitHub by itself at its first refresh (the app does it before showing anything), and every refresh after that brings in what others published and newer versions of slices held unchanged, through one reader of the project as GitHub holds it (`from_github.read`, shared with `project export`) and `slice take`'s own writer (`join.join`, `project join`). `project init` in a repository that has a project does the same act and uses none of the words given; with several open project issues it uses the one the workspace follows, else the oldest, and says so. `slice take` stays for opening one slice by hand. The Factory does the same (built): `principles-check` lists the open project issues in `project_issues`; `cell.py principles` refuses with one sentence naming them and saying a person closes the one that should not be there, records it in the cell, and `validate` and `finalize` refuse until it is run again. No project issue at all is unchanged: no principles.

### A5. A dependency built elsewhere (T8). S

For a dependency this Factory did not build, the plan reads the merged spec on main, as it already does for a slice it never took in.

### A6. Qualifying a release across machines (T10). L

Run records and archives are published to a shared place (the hook `records.publish_command` exists), and qualification reads them. This is the largest item and can follow the others.

**Built, another way, on the owner's decision of 2026-11-23.** No shared place was needed. The owner decided that an evidence file's SHA-256 in the committed change record is enough for a scenario to pass on a machine that does not hold the file. So:

- The merge station's change record is version 2: it ends with `## For MACH`, a fenced JSON document of facts (`change_record.facts`, read back by `read_facts`). It adds what the prose could not give reliably: the approved spec's SHA-256, the contracts the plan named, whether review required a person's approval, the slices depended on, and the verdicts, scenario-to-evidence map, exceptions and final-round blockers as data.
- Qualification (`qualify.py`) reads every slice from that block at the release commit, on every machine, and no longer from the intake ledger, `runs.jsonl` or the archive. The archive is used only to hash an evidence file this machine holds.
- A record is bound to the commit that added it (`bind`): the last commit to touch the file must be the record commit (`change_record.holds`), brought in by a merge, with the spec on its branch and at the release commit matching the SHA-256 it names.
- The snapshot is schema version 3 (`schemas/release-readiness.v3.schema.json`): each slice names its `change_record`; sources are the record's path, never a local archive path; an evidence entry is the file and its recorded SHA-256.
- A version 1 record is passed over, so a slice merged before this shows as `missing`.

Limits, as built: the binding does not catch a record forged on a ticket's branch by someone who can merge. `human_approvals` still lists a slice's product approval from this machine's ledger only, so that list (not the outcome or any check) can differ between machines. A newer approved revision not yet built is known only to a Factory that took it in. A pull request that a person squashed leaves no record commit, so its record is not bound and the slice is blocked.

Tests: `tests/test_release_qualify.py` (`AcrossMachinesTest`: one epic, two slices built in two clones, qualified and accepted from a third; `RecordTest`: an edited record, one put back by hand, a spec changed afterwards, a differing evidence file), `tests/test_change_record.py` (the facts through a real merge, and text from the cell that tries to forge them).

### What a team should still agree

Written before Part A was built. With it built, the first, third, fourth and sixth points below are now MACH's own rules; the rest still hold.

#### As written before the build

- MACH no longer holds one person's work for another's: anyone may take over, open, mark ready or publish what someone else has, with a warning first, and the merge settles the rest (the rule is stated in `docs/BLUEPRINT.md`, under the invariants and Product Studio's "Several product managers", and in `skills/studio/SKILL.md`, "Never blocked").
- One Factory pulls and dispatches: one engineer's machine or one supervisor. Never two supervisors on one repository.
- Merge by pull request, with GitHub set to require an up-to-date branch and passing checks.
- One product manager creates the project and each epic; the others refresh before adding slices.
- Refresh before starting a slice and before marking one ready.
- Tell the engineer before reopening a slice that is being built.
- Engineers let Product Studio allocate slice numbers, or announce a number before grooming.
- Qualify an epic on the machine that built all of its slices. (No longer needed: A6 is built.)

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

**Built in M21**, as one ZIP archive rather than a folder, through `/mach-studio` only: design and as-built notes in `M21_EXPORT_IMPORT.md`.

## 4. Order of work

| Step | Contents | Size |
|---|---|---|
| 1 | A1 claim, A2 merge against shared main, A5 dependency elsewhere, ADR and post-ready number checks from A3 | M |
| 2 | Rest of A3, and A4 shared text | M |
| 3 | B1 references by ID, B3 recognising a move | M |
| 4 | B2 move this project | L |
| 5 | B4 merging two projects | L |
| 6 | A6 qualifying across machines (built) | M |

**A1. Built, after two decisions by the owner on 2026-11-23.** First: no slice is assigned in advance; every Factory must be able to build anything. Second: two Factories should not build the same slice at the same time, because that ends in a duplicate pull request. The first build (a claim that refused dispatch, with a release only by hand) was replaced on the first decision by a model with no claim at all, and that in turn was replaced on the second by what is built: `ticket.py slice-claim` (rules in `issue_rules`: `claim_token`, `claim_comment`, `claims`, `claim_holder`) is called by `intake.py` `_dispatch` for every slice from an issue not yet in the line, so an engineer's dispatch, `/mach pull` and the supervisor all go through it. A Factory is its random value in `.factory/local/factory.json`; a claim carries a token derived from it and the slice ID. The earliest live counting claim per revision holds, by comment ID; a claim counts only as the exact template, unedited, by a person with triage or above. A slice held elsewhere is taken in and skipped by the plan ("being built by @x since …"), so pull and the supervisor take the next; a Factory that loses a race withdraws its own claim and pull dispatches the next slice in its place. Released by its own Factory (abandoned work withdraws its claim), by going stale (no activity for `intake.claim_stale_days`, default 3; a slow build keeps its claim with a sign of life: while a Factory holds and builds a slice and its work has really moved, by a commit on the ticket's branch in its cell or a new cell stage, a recorded plan has `ticket.py slice-alive` post a fixed-template comment carrying the claim's token and when the work last moved, at most once every half of the spell and at least a day; it counts as the claim's activity at that time only as the exact unedited template by the claim's account with its token, and work that has not moved posts nothing), or by an engineer's explicit `product dispatch <slice> --take-over`, never unattended. Backstop: `intake.already_landed`, used by `run.py next`, stops a copy whose revision already landed; the merge station checks the same (built, see A3's Factory note). Differs from the text above: a failed status write does not block dispatch; the claim comment is the claim. Tests: `tests/test_team_factory.py`.

**A5. Built.** The plan treats a slice this Factory took in, and is not building, as completed when its approved spec, for that revision (SHA-256 without the header), is on the integration branch; a slice whose revision is on the integration branch counts as merged for its dependents. Nothing is written to the issue from this machine.


Step 1 removes the three ways work is duplicated or merged untested without anyone being told. The nine failing reproduction tests become the acceptance tests: each must pass when its item is done.

## 5. Not in this design

- An engineer's page in the browser for architecture decisions. Raised here and since built on the Factory Floor: the Decisions workspace (key `4`, `#decisions`), described in `docs/BLUEPRINT.md` under "The Factory Floor".
- Converting existing ADRs from another format, and bringing in several design documents or PDFs at once.
- Windows and Intel Mac builds.

## 6. Decided by the owner (2026-11-23)

1. Step 1 is built first, ahead of moving a project.
2. One repository holds one project. A move is a team leaving an old repository for a new one. When the destination already holds a project, the incoming epics and slices join it as more epics, renumbered; MACH does not learn several projects in one repository.
3. Several engineers each running `/mach pull`, or their own supervisor, on their own machines against one repository is the normal team case and must be safe. The claim in A1 is what makes it so: every Factory builds only what it claimed.
4. No slice is assigned to a particular engineer's Factory in advance; every Factory must be able to build anything.
5. Two Factories should not build the same slice at the same time, which would end in duplicate pull requests. A Factory takes a slice nobody is building; another skips it and takes the next; an engineer can take one over on their word. The shared main takes a slice revision once, as a backstop.

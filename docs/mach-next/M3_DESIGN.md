# MACH Next — M3: Factory product intake and dependency-aware scheduling

Status: **built**, on `feature/mach-next-m3-intake-scheduler`, from M2 commit `b52c716`.

M3 is the first milestone where the Factory reads product work. An engineer can take a merged, approved delivery wave into their local Factory, see a dependency-aware plan, and explicitly dispatch ready slices into the existing line. Nothing runs by itself: the supervisor and local activation are M4.

## 1. What the engineer does

Everything is under the existing run skill (`/mach:run product ...`), backed by `run.py product ...`. No new command-line tool, no new orchestrator.

| Command | What it does | Changes anything? |
|---------|--------------|-------------------|
| `product status` | Approved waves and slices on the integration branch, against the ledger. | No |
| `product intake [--dry-run] [--fetch]` | Verifies the source and files one ticket per new slice revision. | Tickets and the ledger |
| `product plan` | Every slice's state and the reasons. | No |
| `product dispatch <SLICE-ID>... \| --ready [--limit N]` | Opens the cell for each chosen ready slice, up to `spec-ready`. | Cells; starts no agent |
| `product events [--since N]` | The ledger's transitions, in order. | No |

After a dispatch the tickets go through the line like any other: `run.py next` names the contracts-and-plan stage first, then audit, build, verification, review and merge, with every gate in place. Several tickets run in parallel with the existing `mach:belt` workflow.

## 2. Decisions

### D1 — Code lives in the run skill and reuses, never copies

`skills/run/scripts/intake.py` holds intake and the scheduler. It reuses:

- Product Studio's structural validator (`product.validate_workspace`) and its read-from-Git helper (`collab.files_at`);
- the intent station's spec validator (`validate_slice.analyze`, ready mode), its intent check (`cell.check_intent`) and the cell commands `cell.py open` and `cell.py finalize`;
- the ticket station's `ticket.py create`, `list` and `update`;
- `run.py`'s own `next_step` to describe a cell in the line.

A test pins exactly which Product Studio functions intake may call, and that it never imports `studio.py`.

### D2 — Two commits: where definitions are read, and where integration is checked

A project that merges locally has a `main` ahead of the remote. Requiring them to match would break MACH's default configuration, so:

- **Product definitions** are read from the newest commit the local integration branch shares with the remote branch. A definition is therefore only ever taken from a merged revision. Local, unshared commits that touch product files are ignored and reported.
- **Integration** ("is this dependency done?") is checked against the local integration branch, where this Factory's merges land.

With no remote, the local branch is both. Intake never fetches unless `--fetch` is given, and never changes a checkout.

### D3 — Verification before anything is created

The tracked product files at the source commit are written to a temporary folder and judged by the same validators Product Studio used: structure, references, SHA-256 binding of each work order to its spec, dependency cycles, wave consistency. Each slice's spec must then pass `validate_slice.py` in ready mode and its why must pass the intent check. A tree that does not validate is refused whole; a wave with a failing slice is refused. Symlinks in the product tree are not followed.

### D4 — Intake files tickets; dispatch opens cells

Intake creates one execution ticket per slice revision and nothing else. A cell (a worktree and a branch) is opened only at dispatch, from the integration branch as it is at that moment, so blocked work never sits on a stale base.

Tickets are filed through the ticket station with the project's configured provider, labelled `product-studio`, `slice-<ID>-r<revision>` and `wave-<ID>`. With an external tracker, intake files tickets there; the skill says so first.

### D5 — The ledger, and restart safety

`.factory/intake/ledger.json` (git-ignored) maps each slice revision to its ticket. Each approved wave's content is recorded under a key of project, wave and content digest, so it is taken in once.

- Before a ticket is filed, the ledger records that one is wanted. If a run stops between filing and recording, the next run finds the ticket by its marker label and adopts it.
- If the tracker cannot be searched by label, intake stops for a person and accepts `--adopt SLICE-ID=TICKET-ID`.
- Dispatch is resumable the same way: a cell left at `interview` by an interrupted run is finished, never opened twice.

The ledger stores what was decided, never what is happening. Whether a slice is active or integrated is read from the cells and from Git every time.

### D6 — What "modified" means depends on where the work is

| The slice's work is | A new revision arrives |
|---------------------|------------------------|
| waiting (ticket only) | The same ticket takes the new revision. |
| in the line | Nothing is changed underneath it. The slice is flagged for a person, once. |
| integrated | A follow-up ticket is filed; the earlier revision and ticket move to history. Slices built against the old revision are marked stale. |

A slice whose wave is withdrawn is superseded: a waiting ticket is closed; work in the line is flagged for a person.

### D7 — The scheduler

For every slice in the ledger the plan gives one state and its reasons:

- **completed**: its commit is on the integration branch. This is checked in Git from the merge station's record, or from a cleaned-up ticket's archive. A build that finished, a passed review, even an approved cell, are all still **active**.
- **active**: it has a cell in the line. Flagged `needs_person` when the line has stopped for a person or the definition changed.
- **ready**: its ticket exists and everything it depends on is completed.
- **blocked**: with every reason: a dependency not yet integrated, a dependency that is not approved work here, a dependency cycle, a definition that changed since intake, an abandoned ticket, or a claimed merge that is not on the branch.
- **superseded**.

Ready slices are ordered by dependency depth, then by number. The first `factory.max_parallel` minus the active count are `dispatchable`; the rest wait for a place. The plan is deterministic and reading it changes nothing.

### D8 — Dispatch prepares and stops

`dispatch` accepts only slices the plan marks dispatchable (or already dispatched). For each it opens the cell, writes `intent.md` from the approved why with the ticket added, runs `cell.py finalize`, and records provenance in `cell.json`. The cell stops at `spec-ready`. It starts no agent and no workflow; the skill asks the engineer before running anything.

It refuses if the main checkout is not at the integration branch's local head, or if the spec there is not the approved text. It never changes the checkout to make that true.

### D9 — Product cannot raise its own authority

- The risk tier in the why is a proposal. `cell.py check-plan` already lets engineering raise it and never lower it. Intake adds a floor: product-sourced work is never reviewed below Medium.
- Product text reaches tickets and cells as data, and the run skill is told to treat it so.
- Nothing in a product file can choose a model, skip a station, or change a threshold; none of those are read from product files.

### D10 — Events for M4 and M6

Every ledger transition appends one line to `.factory/intake/events.jsonl`: `wave.discovered`, `intake.validated`, `intake.refused`, `slice.materialized`, `slice.integrated`, `dependency.resolved`, `dependency.blocked`, `work.scheduled`, `revision.superseded`, `human.required`. Each has a schema version and a sequence number.

Events are queued inside the ledger and written to the log by the same save, so a crash loses none and repeats none. The log can be replayed, but it is derived from the ledger and is not a second source of truth. Schemas: `schemas/factory-event.schema.json` and `schemas/intake-ledger.schema.json`.

## 3. M2 contract inconsistencies found

1. **The approver's name carried an address.** M2 recorded `approval.actor` as `Name <email>`. Reused in a cell's `intent.md`, the angle brackets were read by the intent gate as an unfilled placeholder, and the address was published in product files and pull request bodies. **Fixed:** an approver is a name. Product Studio records the Git user name only and refuses an address; intake still strips one from waves approved earlier.
2. **A slice's why has no ticket.** By design in M1. Intake adds the `Ticket` and `Mode` lines the intent gate requires.
3. **A run record had no commit.** `runs.jsonl` said a ticket was merged but not which commit landed. **Fixed:** see section 6.
4. **Three ways to find the integration branch.** `run.py`, `merge.py` and `collab.py` each work it out. Intake follows `merge.into`, then the remote's default. They agree in practice; they should share one function.
5. **A wave can be `superseded` in the schema, but Product Studio has no command that sets it.** Intake handles it; M2 cannot yet produce it.
6. **A slice may appear in more than one approved wave.** Nothing forbids it. Intake delivers it in the lowest-numbered wave.
7. **`ARCHITECTURE.md` places live events in `.factory/observations/`.** That folder belongs to the observe station. Events are in `.factory/intake/`.

None required changing M2's artifacts.

## 4. What M3 does not do

- No background execution, hooks, LaunchAgents or polling; no session is started by a merge or a refresh.
- It never reads `.factory/local/runner.json`.
- It never merges, pushes or changes the main checkout.
- It does not decide what to do about stale or withdrawn work in the line: it flags it for a person.

## 5. What M4 builds on

Each of these was a gap when M3 was first finished. All are now built and tested.

- **One reconcile step.** `Factory.reconcile()` (`run.py product reconcile [--fetch]`) is intake followed by a recorded plan, under one lock. It is idempotent, reports the last event's sequence number, and never dispatches. The supervisor calls exactly this on start-up, on a hook's wake-up and on a timer.
- **One guarded way into the line.** `Factory.dispatch(..., by=, authorize=)` is the only place work enters the line. An engineer's explicit command needs nothing more. Any other caller must pass `authorize`, a function that is shown the plan and returns `(True, reason)`; without it, or on anything but `True`, nothing is dispatched. The supervisor's policy check (enabled, not paused, its mode, its preflight) is that function. The `work.scheduled` event records `by` and the `authorization` given.
- **One writer at a time.** Intake, reconcile and dispatch hold `.factory/intake/lock`, a file created exclusively that names its holder. A second process is refused with who holds it. A lock is taken over only when its holder is provably gone (same machine, no such process) or it is older than 15 minutes. Reading (status, plan, events, a dry run) never needs it.
- **What to run.** The plan lists `runnable`: dispatched slices the line can move right now, with each ticket and its next station. A driver starts the belt with those tickets. A slice counts against `factory.max_parallel` from dispatch until it is integrated or abandoned.
- **The event log as the feed.** `product events --since N` is one ordered stream for the supervisor and Control Tower; `human.required` is the escalation signal.

What M4 itself still has to build: the machine-local policy and `/mach:run factory enable|disable|status|pause|resume`, the preflight, starting and supervising the belt, and advisory hooks.

## 6. Two fixes made for M4

### The run record says what landed

`runs.jsonl` is now `record_version` 2. Every record gains three fields, and no existing field changed, so the observe station reads it as before:

- `integration`: for a merged ticket, the branch, the branch it landed in, the method (`local`, `pr`, `manual`, or `squash-or-rebase`), the commit review approved, the commit that landed, the merge commit, the pull request, and when. `null` for an abandoned ticket: nothing landed, so nothing is claimed.
- `product`: for a ticket that came from Product Studio, its slice, revision, wave, digest and source commit.
- `record_version`.

This follows the usual shape of build provenance: a record names exactly which commits it is about, and a reader verifies them. The cleanup station checked each commit against the default branch before writing the record; the scheduler still checks it in Git before calling a slice completed, and falls back to the cell's archive for records written before this version.

### Ticket numbers never reuse a branch name

Local ticket numbers were counted from records that exist only on the machine that made them. A fresh clone therefore started again at `LOCAL-001` while `feature/LOCAL-001` was still on the remote. Both places that allocate a number (`ticket.py` and `cell.py ticket-new`) now also count `feature/<ticket>` branches in the clone and on any remote as last fetched.

Two engineers who have not fetched each other's branches can still pick the same number. A tracker shared by the team (GitHub, Jira) does not have this problem; the local queue is a single-engineer default.

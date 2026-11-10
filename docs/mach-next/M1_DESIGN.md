# MACH Next — M1 Design: Product Studio domain and `/mach:product-studio`

Status: **proposed, for review. No M1 code exists yet.**
Based on MACH 0.11.1 and the M0 foundation on `feature/mach-next-product-studio-supervisor`.

M1 delivers the terminal Product Studio: a PM defines a project and epics, interviews a slice, resumes drafts, passes the existing slice validator, and approves a slice and a delivery wave. It publishes nothing (M2), dispatches nothing (M3, M4) and has no web app (M5).

## 1. What the repository does today, and where M1 collides with it

| Today | Consequence for M1 |
|-------|--------------------|
| `/mach:intent` interviews inside a cell: `cell.py open` makes a ticket branch and worktree first. | A PM must interview with no ticket, cell or worktree. The interview has to run somewhere else. |
| `cell.py next-id` allocates `SLICE-NNN` from `specs/slices/` on the main checkout and in every open cell. | Product Studio would mint IDs from `product/slices/`. Two allocators will collide. |
| `validate_slice.py` is the only judge of a spec; `cell.py finalize` adds the `intent.md` check and exports `spec.json`. | Studio approval must call the same code, never a second implementation. |
| `intent.md` belongs to a ticket: `finalize` requires its `Ticket`, `Slice`, `Mode` and `Status` header lines. | The "why" a PM gives has no ticket yet. It needs a home that intake (M3) can turn into `intent.md`. |
| Build, verify, review and merge refuse a main checkout with uncommitted or untracked files. | Drafts must not sit in the tracked tree, or an engineer who is also the PM (ADR-003) blocks their own line. |
| The script installer copies `skills/`, `agents/` and `workflows/` only. | A top-level `mach_product/` never reaches an installed project. |
| Skills are self-contained folders; one script already finds another skill's script (`observe.py` → `sibling("ticket")`). | Product Studio can import the intent skill's validator the same way, in both install layouts. |

## 2. Decisions proposed

### D1 — One slice ID allocator

`cell.py`'s `registries()` and `scan_ids()` stay the single implementation. They are extended, additively, to also count as used:

- every `product/slices/SLICE-NNN.json` on the main checkout;
- every slice in the Studio draft workspace (D2), JSON or spec.

Product Studio allocates by calling that same function. The change can only make more numbers "used", so no existing ticket can receive an ID it would not have received before.

Two PMs on two laptops can still pick the same number before either publishes; no local scan can prevent that. M1 detects it (a baseline slice with the draft's number that the draft did not start from) and refuses approval with a clear message. The deterministic `renumber` operation, which rewrites the file name, the title, and every `(Deferred to SLICE-NNN)` pointer, belongs to M2's refresh. The ID format is not changed: `validate_slice.py` requires `SLICE-` and digits, and that rule stays.

### D2 — Drafts live in a workspace outside the tracked tree

```text
.factory/studio/                      # git-ignored, machine-local
  draft/
    product/project.json
    product/epics/EPIC-NNN.json
    product/slices/SLICE-NNN.json
    product/intents/SLICE-NNN.md      # see D4
    product/delivery-waves/WAVE-NNN.json
    specs/slices/SLICE-NNN-name.md
  session.json                        # which slice is being interviewed, for resume
```

The draft tree mirrors the repository layout exactly, so M2 publishes by copying allowlisted paths into a contribution branch, and the M0 validator runs on the draft tree unchanged (`--project .factory/studio/draft`). The main checkout stays clean, so nothing in M1 can trip an existing gate. `.factory/studio/` is added to the installer's ignore block, with `.git/info/exclude` as the fallback `cell.py` already uses for worktrees.

A draft starts as a copy of the artifact on the main checkout, recording the revision it started from. Approved artifacts on the main checkout are never edited in place.

### D3 — The interview is shared, not copied

- The interview method (design tree, one yes-or-no question at a time with a recommended answer, phases 1 to 4, pausing and continuing) moves out of `skills/intent/SKILL.md` into `skills/intent/references/interview-method.md`, as a pure move. Both skills load it. `/mach:intent` keeps everything about tickets, cells, headless mode and stage 2.
- The spec template, EARS grammar, matrix and structure references stay in `skills/intent/` and are read from there.
- `/mach:product-studio` never runs stage 2. Contracts and `plan.md` remain engineering work inside a cell, on the contracts tier.
- Headless grooming stays with `/mach:intent --headless` for `AUTO-` tickets. Product Studio is always a conversation with a person.

Risk: moving text out of the intent skill could change how it behaves. Mitigation: the move is its own commit, and one headless `/mach:intent` run on the existing fixture is compared before and after.

### D4 — The slice's "why" is a tracked artifact

Each slice gets `product/intents/SLICE-NNN.md`: the existing intent template without the `Ticket` and `Mode` lines. It holds the problem, who it is for, success, goal ancestry (project outcome, epic), constraints and the risk tier. At intake (M3) the supervisor adds the ticket line and writes it as the cell's `intent.md`, after which `cell.py finalize` checks it exactly as it does today.

This adds one folder to the tracked layout in `ARCHITECTURE.md`. It does not change the four JSON schemas.

### D5 — Approval calls the existing gates

`slice approve` succeeds only when all of these hold, in this order:

1. `validate_slice.analyze(..., ready=True)` reports zero errors, with every registry from D1 passed in. This is the same call `cell.py finalize` makes.
2. The intent file passes the existing section and risk checks (`check_intent`, minus the ticket header).
3. The slice's epic exists and is `approved`; every dependency exists.
4. The M0 structural validator passes on the draft tree.

It then writes `status: approved_for_engineering`, `open_questions: []`, `spec_path`, `spec_sha256`, and increments `revision`. Any later edit to the spec breaks the hash; `slice reopen` is the only way back to `interviewing`, and it increments the revision and invalidates any approved wave that lists the slice.

`wave approve` requires every listed slice to be approved with a matching hash, then records `approval: {actor, approved_at}`. The actor is the Git identity configured in the clone.

Approval in M1 is still product approval only. The M0 guarantee is kept and tested: nothing reads it to start work.

### D6 — Where the code lives

```text
skills/product-studio/
  SKILL.md
  scripts/studio.py        # every Product Studio operation
  scripts/product.py       # the M0 structural validator, moved from mach_product/validate.py
```

`mach_product/` at the repository root is removed, so both install methods ship one copy. `python3 -m mach_product.validate` becomes `python3 skills/product-studio/scripts/product.py`; the M0 documents and tests are updated in the same commit. No new user-facing CLI: `studio.py` is called by the skill, as every station script is.

### D7 — Decisions as records: deferred, with one exception

`ARCHITECTURE.md` puts `product/decisions/DEC-NNN.json` in phase 2; `DELIVERY_PLAN.md` lists decision editing under M1. Proposed: M1 does not add a decision schema. The answers a PM gives are already durable in the spec (its Assumptions section and requirement text), which is how `/mach:intent` resumes today. The exception is the session file in D2, which records the interview's frontier so a draft resumes at the next question. Addressable decisions are designed with M2, where conflict detection needs them.

## 3. Operations

`STUDIO` is `python3 "${CLAUDE_SKILL_DIR}/scripts/studio.py"`. Every command prints JSON, refuses with `refused: ...` on stderr and exit code 1, and writes canonical JSON (sorted keys, two-space indent, trailing newline) so the terminal and the M5 web app produce identical bytes.

| Operation | Command | Notes |
|-----------|---------|-------|
| Where things are | `STUDIO where`, `STUDIO status` | Draft workspace, intent skill location, every artifact with its state. |
| Project | `project init`, `project set` | Vision and outcomes; revision increments on change. |
| Epic | `epic add`, `epic set`, `epic approve` | |
| Start a slice | `slice new --epic EPIC-NNN --title "..."` | Allocates the ID through D1. Status `draft`. |
| Continue interview | `slice resume [SLICE-NNN]` | Returns the draft paths and the saved frontier. Status `interviewing`. |
| Check a draft | `slice check SLICE-NNN [--ready]` | Runs the existing validator; copies its open questions into the work order. |
| Approve slice | `slice approve SLICE-NNN` | The gates in D5. |
| Reopen | `slice reopen SLICE-NNN` | New revision; invalidates waves that list it. |
| Wave | `wave new`, `wave add`, `wave remove`, `wave approve` | |
| Validate everything | `validate` | The structural validator over the draft tree. |
| Reserved for M2 | `refresh`, `send`, `feedback` | Named now so the API is stable. In M1 each refuses with "not available yet". |

`/mach:product-studio` with no argument shows `status` and offers the next sensible step, so a PM never needs to remember an ID.

## 4. What M1 must never do

- Create a ticket, cell, worktree or branch; commit, push or open a pull request.
- Read or write `.factory/local/runner.json`, or call `run.py`, the belt workflow or any station.
- Write outside `.factory/studio/`.
- Need anything beyond `python3` and `git`.

The M0 isolation tests are extended to enforce each line, with `skills/product-studio/` as the only place allowed to name the product code.

## 5. Tests that define "done"

1. A project, an epic and a slice are created, interviewed and approved using only `studio.py`; the result passes `validate_slice.py --ready` and the structural validator.
2. `slice approve` refuses for: an open question, a spec the validator rejects, a missing or incomplete intent file, an unapproved epic, a colliding slice ID.
3. Editing an approved spec fails validation; `reopen` restores a consistent state and invalidates the wave.
4. `cell.py next-id` skips IDs held by product work orders and Studio drafts; Studio skips IDs held by open cells and reserved pointers. One function, tested from both sides.
5. A draft resumes after the session ends, at the saved question.
6. The main checkout is byte-identical before and after a full Studio session, and `run.py next` and `board` are unchanged.
7. The same operations run twice produce byte-identical artifacts.
8. All existing suites pass unchanged; the installer ships `product-studio` in both layouts.
9. One live run of `/mach:product-studio` and one headless `/mach:intent` on the fixture.

## 6. Commit sequence

1. Move the interview method into a reference file; intent skill otherwise unchanged.
2. Move `mach_product` into `skills/product-studio/scripts/`; update M0 documents and tests.
3. Extend the ID allocator to product work orders and drafts.
4. `studio.py`: workspace, project and epic operations.
5. `studio.py`: slice operations and the approval gates.
6. `studio.py`: delivery waves.
7. `SKILL.md`, installer entry, `CLAUDE.md` and `README.md`.

## 7. Open decisions for the product owner

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | Add `product/intents/SLICE-NNN.md` to the tracked layout (D4)? | Yes. Without it the PM's "why" is lost between approval and intake. |
| 2 | Move the interview method out of the intent skill's `SKILL.md` (D3)? | Yes. The alternative is two copies that drift. |
| 3 | Remove the root `mach_product/` package in favour of the skill folder (D6)? | Yes. It changes the M0 verification command. |
| 4 | Leave decision records (`DEC-NNN`) to M2 (D7)? | Yes. It resolves the conflict between the two M0 documents in favour of `ARCHITECTURE.md`. |
| 5 | Keep drafts under `.factory/studio/` (D2) instead of a separate Git worktree? | Yes for M1. M2 may move the approved baseline into a worktree without changing the draft layout. |

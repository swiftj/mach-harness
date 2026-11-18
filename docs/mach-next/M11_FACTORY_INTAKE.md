# M11 step 3 and 4, as built: the Factory takes slices in from issues and ready folders

This note covers sections 4, 5 and 6 of `M11_DESIGN.md` with the decisions in its section 10. It
lists what was built, what was removed, what was decided where the design left a choice, the
GitHub shapes relied on, and the limits. Product Studio's side is in `M11_STUDIO_ISSUES.md`.

## Commands

| Command | What it does |
|---|---|
| `run.py product status` | Reads only: the slices marked ready (issues and committed folders) against the ledger, `not_accepted` with each reason, `withdrawn`, and a plan summary. |
| `run.py product intake [--dry-run] [--fetch] [--reissue SLICE-ID]...` | Takes each new slice revision in, once. An issue is its own ticket; a folder gets a local ticket. `--reissue` puts abandoned work back in the queue on the same ticket, on an engineer's word. |
| `run.py product import <folder>` | A ready folder handed over outside Git, on an engineer's explicit command: verified and taken in with a local ticket. Refused inside a supervised execution. |
| `run.py product plan` | Reads only: every slice `completed`, `active`, `ready` or `blocked`, with reasons, and `order`. |
| `run.py product dispatch <SLICE-ID or issue number>... \| --ready [--limit n]` | Opens each cell, commits the spec with its header on the ticket's branch, writes `intent.md`, passes `cell.py finalize`, stops at `spec-ready`. |
| `run.py product reconcile [--fetch]` | Intake, the recorded plan and the status writes in one locked step. Never dispatches. What each supervisor pass calls. |
| `run.py product events [--since N]` | The event log (schema version 3). |
| `run.py release qualify --epic <EPIC-ID or issue number> \| <SLICE-ID>... [--release id] [--commit sha]` | Release qualification by epic or by named slices; snapshot schema version 2. |
| `ticket.py slice-list`, `slice-check <n>`, `epic-check <n> [--release R --commit C]` | Read only, always `gh`, the `origin` repository only. |
| `ticket.py slice-status <n> --repository OWNER/REPO --moment building\|question\|shipped\|blocked\|changed --ref SLICE-NNN@rN... --nonce HEX [--question-file F]` | One status write on a slice's own issue. |
| `cell.py spec-question <ticket> --question "<text>"` | The contract engineer's way to stop a product-sourced cell for the product manager. |
| `studio.py acceptance record <EPIC-ID> --release R --commit C --readiness FILE --decision accepted\|rejected` | Product's decision, a fixed-template comment on the epic's issue. |

`run.py next` gains two stops: `needs: dispatch` (a ticket taken in from Product Studio, not yet
dispatched: never groomed) and `needs: product-answer` (a cell waiting for the product manager's
answer). The walkthrough (`decide.py`) offers waiting or abandoning for the second.

## Removed

- Tests: `tests/test_mach_product_collab.py`, `tests/test_mach_intake_requests.py`; the wave parts of
  `test_mach_requests.py`, `test_mach_product_contracts.py`, `test_mach_product_studio.py`,
  `test_mach_product_isolation.py`, `test_m7_adversarial_product.py`; the M7 N2 ledger replay test.
  The intake, supervisor and release tests were rewritten on issue and folder fixtures.
- `docs/mach-next/schemas/delivery-wave.schema.json` and the example project's wave.
- Product Studio: `slice approve`, `wave new|add|remove|approve|renumber`, `send` (and `--acceptance`),
  `feedback`, `acceptance show`, the per-wave acceptance file, the three-way sync of product files
  (`Studio.sync`, bases, `publications.json`, `needs_reconciling`, a per-item `source`, refresh's
  `arrived`/`updated`/`merged`, reconciling a path or a `--field`), the hint kinds `approve_wave`,
  `renumber_wave`, `name_approver`; in `collab.py` everything but the gh helpers and the request reads
  and writes (`Shared`, `files_at`, `tracked`, `merge_fields`, `build_commit`, pull requests, review
  state); in `product.py` the wave and acceptance shapes; in `requests_in.py` the label writes and
  `queue_sent`.
- `issue_rules.py`: `STATUS_LABELS`, `GROOMING`, `labellers`, the `sent` and `merged` moments.
- `ticket.py`: `request-status` and `REQUEST_MOMENTS`.
- `intake.py`: `Snapshot` (product files at a commit), the `request_status` outbox, `product resolve`,
  `intake --adopt`, tickets per revision, `superseded_revisions`.

## Decisions where the design left a choice

1. **Ledger keys.** `intakes` is keyed `github:OWNER/REPO#N@rR`, `folder:SLICE-NNN@rR` or
   `import:SLICE-NNN@rR`, recorded (state `taking`) before anything is done; `slices` stays keyed by
   slice ID, one live entry per slice with its earlier lives in `history`. Ledger version 2; an older
   ledger reads as empty (no migration).
2. **One ticket per slice life.** A GitHub slice's ticket is its issue number, whatever
   `tickets.provider` says; a folder's is one local ticket. A reissue, or a new revision after the
   work was abandoned, uses the same ticket again (`earlier_runs` says which run records belong to an
   earlier life). Shipped work changed is a new issue and so a new ticket.
3. **Work in progress and a new revision.** Never changed. Let it finish (the new revision follows on
   the same ticket after it ships) or abandon it with the cleanup station (the next intake takes it).
   `product resolve` was removed: with the issue as the ticket, its cell name is taken until the old
   work leaves the line.
4. **The builders' question.** `cell.py spec-question` records it in `cell.json`; `run.py next` stops
   with `product-answer`; intake posts it; a new revision of the same issue reaching a cell at
   `spec-ready` with a question is written into the cell and finalized, and `cell.py finalize` drops
   the question when the spec changed.
5. **Spec header.** One line after the title, `> Epic: <name> (EPIC-NNN, issue #N). Slice issue: #N.`
   (`Slice issue: none.` and no epic issue for a folder). The epic name is reduced to letters, digits
   and plain punctuation. The file is `specs/slices/SLICE-NNN-<first eight words of the title>.md`, or
   the name an earlier revision already has in the checkout.
6. **Order.** Ready slices are taken oldest marked ready first (the label event's time; for folders,
   the time taken in); the places one epic's slices hold in that order are refilled with them in the
   product manager's order (sub-issue position, task-list position, else slice ID).
7. **Taken back.** A slice no longer marked ready (or whose folder is gone) blocks only waiting work.
   When GitHub cannot be read, what was known is kept and a note says so.
8. **Checking less.** A ready issue's decision is cached until its `updated_at` changes.
9. **Roles.** Triage, write, maintain and admin count by `role_name`; a custom role counts when its base
   `permission` is write or admin.
10. **The epic** must be an issue Product Studio wrote (label and marker), or the slice is not accepted.
11. **Dependencies.** By issue number for issues, slice ID for folders. One this Factory never took in
    counts as merged when a spec on the integration branch carries it in its header (or, for a slice
    ID, its file is there).
12. **Status writes** go only to slices that came as issues. The request's issue is told nothing by the
    Factory: the slice issue carries no request, and Product Studio already links the two.
13. **Dispatch** no longer needs the spec on the main checkout: it comes from the verified copy in
    `.factory/intake/received/`, checked against its SHA-256 again before use.
14. **Events v3** drop `project_id` and `wave_id` and add `epic_id` and `issue`; no new event types;
    `wave.discovered` is gone.
15. **Acceptance.** Read per epic; the latest comment that counts decides; the readiness SHA-256 in it is
    reported, not enforced (the snapshot changes once acceptance is recorded). A release of named slices
    records no acceptance.

## GitHub shapes relied on

| Shape | Confirmed? |
|---|---|
| Issue events: `event`, `label.name`, `actor` (`login`, `id`, `type`), `created_at`, `performed_via_github_app` | Confirmed (docs.github.com, issue events) |
| Collaborator permission: `permission` maps maintain to write and triage to read; `role_name` is the role, including custom roles | Confirmed |
| Issue comments: `user` (`login`, `id`, `type`), `created_at`, `updated_at`, `body`, `performed_via_github_app` | Fields confirmed; that `updated_at` changes on an edit, and only then, is **not stated** |
| Sub-issues list returns issues with `number` and `id` | Confirmed; that it is in the parent's manual order is **not stated** |
| `gh issue list --label` repeated means all labels | **Not stated**, so only `mach:ready` is listed and `mach:slice` is checked in code |
| `gh issue list --json updatedAt` | Confirmed |
| `gh api --paginate --jq` applies per page | **Not stated**; every filter emits one object per line, which works either way |
| `gh issue close --repo`, `gh issue edit --add-label --remove-label --repo` | Confirmed |

## Observer and Factory Floor

The observer reads intake events of version 2 and 3. A version 3 line has no `wave_id` or
`project_id`, so a wave and a project stay absent: the wave dimension, T3 "Waves delivered" and C5
"Wave lead time" get no new data. Ledger slices carry no `wave_id`, so cells have no wave either.
Nothing is invented. Run records' `product` block now carries `epic_id`, `source` and `issue`; the
observer ignores the first two. The analytics fixture `tests/fixtures/analytics/medium/runs.jsonl`
and its golden copy were rewritten to the new block; `mach-synth` still writes `wave_id` in the run
records it generates (test tooling, left so the browser suite's histories stay byte-identical).

## Limits

- Anyone with write access who sets out to forge an approval can; the check guards against accidents
  and edits.
- At most 200 ready issues are read per pass; the report says so when the limit is reached.
- The builders' question is bounded to 4,000 characters, redacted and mention-free.
- `tests/test_mach_product_host.py` (`HostConformanceTest`) needs the Product Studio host from the
  app branch (op `slice.ready`, no `slice.approve`); it fails on this branch alone.
- The visual app's host does not yet offer the new `acceptance record` form.
- Everything here was tested against a stand-in for `gh`, never against real GitHub.

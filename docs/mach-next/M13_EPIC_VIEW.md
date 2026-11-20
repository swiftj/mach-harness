# M13 part C as built: where product managers read how an epic works today

Built 2026-11-20 against `M13_DESIGN.md` part C ("Where people read it"), on top of the compiler described in `M13_CURRENT_VIEW.md`. Two readers were added: Product Studio's `epic current <EPIC-ID>`, and one comment on each epic's issue that the Factory replaces each time a slice of that epic ships.

## What was built

| File | What changed |
|---|---|
| `skills/product-studio/scripts/studio.py` | `epic current <EPIC-ID or issue number> [--json]`: `current_compiler()` and `cmd_epic_current()`, and its parser entry. |
| `skills/product-studio/SKILL.md` | "How an epic works today": show what the script returns, add nothing. |
| `skills/run/scripts/current.py` | `integration(root, config)`: the integration branch and its local head, by intake's own `Factory.integration`. |
| `skills/run/scripts/intake.py` | When a slice ships, queue the epic-view write in the status outbox; send it through the ticket station. |
| `skills/ticket/scripts/issue_rules.py` | The comment's fixed template, its marker and its size limit. |
| `skills/ticket/scripts/ticket.py` | `epic-view`: create or replace the one comment on the epic's issue. |
| `docs/mach-next/schemas/intake-ledger.schema.json` | The outbox's `epic-view` moment and its `epic_id`. |
| `tests/test_epic_view.py` (new), `tests/test_mach_product_issues.py`, `tests/test_mach_product_isolation.py`, `tests/test_current.py` | Tests; the stand-in `gh` gained comment IDs and editing a comment. |
| `CLAUDE.md` | Product Studio and "Status back to the issue". |

## Product Studio: `epic current`

```
studio.py epic current <EPIC-ID or issue number> [--json]
```

- Loads the run skill's `current.py` by path (`mach/scripts/` in a project install, `run/scripts/` as a plugin); if it is not there, it refuses in plain words.
- Names the integration branch as intake does (`factory.integration_branch`, `merge.into`, the remote's default, then `main` or `master`) through `current.integration`, which calls intake's `Factory.integration` with only the root, Git and the configured branch: no ledger, no Factory object, nothing written. It describes the local branch's head.
- Calls `current.report(..., epic=...)` and prints `current.human`, or with `--json` the epic's full view (`epic`), `epic_id`, `branch`, `commit`, the compiler's `notes`, `factory_authorized: false`, and `note`: "This shows what is merged on this machine's copy of the integration branch (`main` at `<commit>`), which may be behind GitHub. The slices are the authority."
- An epic no shipped spec names gives `epic: null` and the compiler's note; a name that is neither `EPIC-NNN` nor a number is refused.
- Git words used, through `current.py` and the borrowed intake function: `rev-parse`, `merge-base`, `ls-tree`, `cat-file`, `symbolic-ref`, `show-ref`, `diff`, `rev-list`. No fetch, no push, no `gh`.

## The Factory's comment on the epic's issue

**When.** Intake's `record` marks a slice integrated and queues the `shipped` status write. Beside it, `queue_epic_views` queues one outbox write (`moment: "epic-view"`, `issue`: the epic's issue, `epic_id`, `refs`: the slice and revision, `slice_id`) for:

- the slice's own epic, when its issue is known; and
- every other epic with an issue whose rules this slice changed, replaced or retired: read from `compile_view` at the commit the slice landed on, as the rules whose `superseded_by` names this slice.

Nothing is queued when `tickets.github.status_comments` is `false`, when the slice did not come from an issue (a ready folder or an import), or for an epic with no issue. The key is a digest of the moment, repository, epic issue and slice reference, so a repeated pass queues nothing twice.

**Sending.** `send_status` hands an `epic-view` write to `send_epic_view`, which compiles the epic at the integration branch's head at that moment (so a write that waited shows the latest, and two waiting writes for one epic write the same text once), bounded to `issue_rules.epic_view_limit()`, and calls `ticket.py epic-view`. The outcome is handled exactly as for `slice-status`: done, already done, refused, pending (retried next pass) or given up. A view that cannot be compiled is pending with kind `no_view`. Nothing waits on it and no step fails because of it.

**The write** (`ticket.py epic-view N --repository R --epic-id EPIC-NNN --commit C --view-file F`):

1. `status_comments: false`: writes nothing, answers done with `comment: "off"`.
2. Only the `origin` remote's repository; the issue must still live there.
3. The issue must be an epic Product Studio wrote, with this epic's ID: `read_epic`, the same check intake makes on a slice's epic. Otherwise nothing is written (`refused`, not retried).
4. The account gh is signed in as (`gh api user`).
5. The issue's comments with their IDs (`gh api --paginate repos/R/issues/N/comments`).
6. The Factory's own comment is the first one whose author is that account and whose body opens with the epic-view marker for this epic. If its marker equals the new one (same epic, commit and SHA-256), nothing is written (`already_done`). If it differs, it is edited in place (`gh api --method PATCH repos/R/issues/comments/ID --input <file>`). If there is none, one is created (`gh issue comment N --body-file <file>`). No other comment is read for anything else, edited or removed.

**The template** (`issue_rules.epic_view_comment`):

```
<!-- mach:epic-view v1 epic=EPIC-001 commit=<40 hex> sha256=<SHA-256 of everything below this line> -->
## How this epic works today

Compiled by the MACH Factory from the slices of this epic that have shipped. The slices are the authority; this comment is replaced each time a slice of this epic ships.

<current.epic_markdown(view, commit, limit)>
```

The view is cleaned again (`clean_text`), every `<` escaped, and every mention and issue reference broken (`MENTION_RE`, `REFERENCE_RE`), so it can open no hidden comment, notify nobody, link no issue and close nothing; `epic_markdown` had already made each spec text inert with `issue_rules.quiet`. The whole comment is at most 65,536 characters: the compiler is asked for `ISSUE_BODY_LIMIT - 1024`, and the template cuts at a line with "This view was cut to fit in one comment. Run `/mach current EPIC-NNN` for all of it." if it is still too long.

## Choices

- **Found by marker and author, not by a nonce.** The status comments' markers carry the ledger's nonce. Here the marker names the epic and the comment is recognised only when the Factory's own account wrote it, so a comment anyone else writes with the same marker is never touched, and two Factories signed in as one account share one comment. Two Factories under different accounts each keep their own; nothing coordinates two engineers' machines, as elsewhere.
- **Compiled when sent, not when queued.** The queue records the intention; the text is compiled at the head of the integration branch when the write is tried, so a retried write never posts an out-of-date view.
- **"Unchanged" is the marker.** It carries the SHA-256 of the text, so an identical view is recognised without comparing bodies GitHub may have normalised.
- **Cross-epic effects use the compiler's own data** (`rules[].superseded_by`), not a second reading of the effects section.
- **A slice from a ready folder writes nothing**, even where GitHub is reachable: its epic has no issue known to the Factory.
- **`/mach current`** already shows the epic's issue number (`EPIC-001 Lending (issue #12)`) wherever a spec header gives one, so nothing was added there.

## Departures

- The design names "one comment that the Factory replaces"; it is edited in place (the same comment ID), so its link and position stay, and GitHub shows it as edited.
- A Factory under a different account from the one that wrote the comment creates its own comment; it never edits another account's.

## Exact blocks in shared files

- `skills/run/scripts/intake.py`
  - one constant after `STATUS_GIVE_UP_KINDS`: `EPIC_VIEW_MOMENT = "epic-view"`;
  - in `record`, one line after `self.queue_status(ledger, entry, "shipped", refs)`: `self.queue_epic_views(ledger, entry, refs)`;
  - in `send_status`, the `slice-status` call is wrapped in `if write.get("moment") == EPIC_VIEW_MOMENT: done = self.send_epic_view(write) else: <the existing lines, indented once>`;
  - one block before `status_summary`, headed `# ---- M13 part C: the epic's current view ...`: `current()`, `queue_epic_views()`, `send_epic_view()`.
- `skills/ticket/scripts/ticket.py`
  - two lines in the module docstring naming `epic-view`;
  - one block after `cmd_slice_status`, headed `# M13 part C: the one comment on an epic's issue ...`: `EPIC_VIEW_COMMENTS_JQ`, `EPIC_VIEW_COMMENT_PATH`, `EPIC_VIEW_FILE_LIMIT`, `cmd_epic_view()`;
  - in `build_parser`, the `epic-view` parser after `slice-status`.
- `skills/ticket/scripts/issue_rules.py`: one block at the end of the file, headed `# ---- the epic's current view (M13 part C) ----`.
- `skills/product-studio/scripts/studio.py`: one block after `cmd_epic_set` (`current_compiler()`, `cmd_epic_current()`), and the `epic current` parser before `epic renumber`.
- `skills/run/scripts/current.py`: `integration()` after `contains()`, the `SimpleNamespace` import, one docstring line.
- `run.py`: not changed.

## Not built

- The visual Product Studio app shows neither `epic current` nor the comment; no screen, host route or app operation was added (`web/` and `apps/` untouched).
- The comment is not written for a slice from a ready folder, nor when the Factory runs without GitHub.
- No comment is removed when an epic stops having shipped slices (a slice cannot be un-shipped by the Factory).
- The Factory Floor and the observer know nothing of the new outbox moment; they do not read the outbox.

## How far it is tested

`tests/test_epic_view.py` (15 tests), over the intake tests' repositories and stand-in `gh`: the first ship creates the comment by the Factory's account at the branch head; the second ship edits the same comment (one `PATCH` to its ID, no second comment); a repeated pass and `reconcile` write nothing, and a write whose answer was lost is found by its marker (`already_done`); a failed write is pending with its kind, the slice still ships, and the next pass writes it; comments off queues nothing and `epic-view` itself writes nothing; a slice in one epic replacing a rule of another refreshes both comments; an epic issue no longer Product Studio's gets nothing (given up, `refused`); a slice from a ready folder writes no view and reads no comments; another account's comment carrying the same marker is left alone; the template's cut, its note, its intact marker and its inert text; `epic-check` reads an acceptance beside the view and takes the view for none; Studio's `refresh` answers the same with or without the comment, and Studio rewriting the epic's body leaves it alone; `epic current` reports the local branch head, says it may be behind GitHub, calls no `gh` and changes nothing in the checkout; an epic with nothing shipped and a bad name; the exact `gh` calls of `epic-view`; and that `epic current` uses only the compiler. `tests/test_mach_product_isolation.py` gained a test that Studio reaches the run skill only for `current.py` and that the Git it then uses only reads. `tests/test_current.py`'s list of files that name the command now includes `studio.py` and `intake.py`.

Not tested: real GitHub (the `PATCH` with `--input` and the paginated comments with their IDs were checked against GitHub's documented REST shapes, not a live call), and the Markdown as GitHub draws it.

# M15 loose ends, as built

Four small gaps left by M13 and M14, closed without a redesign. Each section says what was built, each choice, and what is left.

## 1. The stop that waits for a policy owner

`cell.py finalize` records `cell.json` `policy_concerns_open` when an open policy concern is the only thing holding the spec at `spec-open`; `run.py next` then answers `stop` with `needs: "policy-owner"`, in interactive and headless mode alike (built in the M14 merge, untested until now).

- **Tests** (`tests/test_mach_loose_ends.py`, `PolicyOwnerStopTest`), all through the real `cell.py finalize` and `run.py next`: a concern alone stops both modes with the fixed `NEEDS_TEXT` line; a concern beside an ordinary open question takes the ordinary route (`groom` interactive, `answers` headless); the owner's acceptance lifts the hold and the next finalize makes the spec ready; a spec changed to meet the statement (`spec changed.`) lifts it; with two concerns, accepting one still waits.
- **The hold now follows the acceptance.** `cell.py policy-accept` sets `policy_concerns_open` to the concerns still open, and removes it with the last one, so `next` routes back to grooming (the spec is finalized again) instead of still saying it waits for the owner. A cell that also has an ordinary open question never had the field, and nothing changes for it.
- **The walkthrough** (`decide.py`, state `policy-owner`): the open concerns from the cell's own `spec.md` (pack, statement, owner, why: listed in `DATA_FIELDS`, bounded by `explain.clean`), `show_first` the spec, and the options the scripts accept: "Record the owner's acceptance" (route `policy accept <ticket> <POL-id> "<their words>"`, the statement named when there is one, `needs_reason`), "Change the spec" (the intent skill's interview) and abandon. Neither is recommended (`recommendation.basis` is `judgement`). For a Product Studio slice, which `cell.py policy-accept` refuses, the options are to wait for the product manager's new revision, or abandon.
- **`explain`** gains `policies`: `open_concerns` (pack, statement ID, statement, owner, why, from `spec.md`) and `acceptances` (from `cell.json` `policy_acceptances`: who, how the name was checked, their words). The plain text prints one `[policy]` line each.
- `NEEDS_TEXT["policy-owner"]` and the notification wording were already in place and pinned by `tests/test_mach_notify.py`; they are unchanged.

## 2. Who accepted a policy concern

The smallest sound check, made without GitHub:

- **The owner grammar** gains a list of logins: `owner: Data protection officer (@dana, @lee)`. One team (`@acme/privacy`) is still allowed; a team beside logins parses, but counts as a team.
- **`policies.owner_check(owner, by, allowed)`**: where the concern's owner names only GitHub logins, `--by` must be one of them, compared case-insensitively, with or without `@`; else it may be in the project's list. A name neither holds is refused with the logins named. An owner that is only a role, or names a team, cannot be checked: who belongs to a team is GitHub's to say, and MACH does not ask.
- **`policies.accept_by`** in `.factory/config.json` (new; `templates/config.json` ships `[]`): an extra list of logins or names who may record an acceptance on any pack, in the style of `review.security_exception_by`. It was needed because the common case, a pack owned by a team, could otherwise never be checked. A malformed setting refuses the acceptance until it is fixed.
- **The record**: the resolution line now reads `accepted by <name> (<check>) on <date>: "<their words>"`, where `<check>` is `checked against the pack's owner`, `checked against the project's list` or `not checked against the owner`. `policy accept` refuses a name with brackets, so only it writes the words. Because review's packet copies the concern's `by` from `spec.json`, reviewers read the check beside the name without any change to review; `spec.json` also carries `owner_check`. `cell.json` `policy_acceptances` records `owner_check`; both `cell.py policy-accept` and Studio's `policy accept` print it with `owner_check_note`: this guards against accident, not forgery.
- The owner named in a concern must already equal the pack's owner exactly (M14's `policy-owner` check), so the logins are read from the concern's own line: no Git read, and the same rule in the cell and in Studio.

## 3. Work answered under older rules

`cell.py rules_changed(project, cell, cache)` gives at most one fixed line each, in this order, and nothing else:

- **Product principles** (`principles_changed`): for principles read from the folder form, the record at the main checkout's HEAD (`product/ready/PRINCIPLES/principles.json`, one local Git read) compared by SHA-256; for principles read from GitHub, the newest copy any cell on this machine fetched (`cell.json` `principles`, by `read_at`), named with its date and ticket. GitHub is never asked from `status`, `next` or `explain`; a test patches `subprocess.run` to prove it.
- **Policy packs**: `policies_changed`, M14's `drift_text`.
- **Shipped rules**: `shipped_changed`, M13's `shipped_moved` as one line (a row of the spec's effects names a rule no longer in force).

`run.py status` puts the lines on each ticket's row (`rules_changed`) and one summary sentence in its digest; the `next` digest carries them; `explain` (JSON, in the digest) prints each as `[older rules]`. One `cache` per `status` call reads the packs, the shipped rules and the principles folder once for every ticket. A check that fails says so in its line. Nothing is restarted, blocked or routed differently, as with ADR timing; a test holds the route unchanged. `cell.py status <ticket>` also gains `principles_changed`.

Product Studio's `status` gains per slice `policies_changed` (only for a spec with a Policies section, so a project whose specs answer no pack makes no extra Git read). `refresh` does not.

## 4. Dead or contradictory, found while doing the above (listed, not changed)

1. `M14_POLICY_PACKS.md`, "The gate": "In headless mode `run.py next` already stops a `spec-open` cell for a person", and "Not built": "A cell held at `spec-open` by a concern is shown by `next` as open questions". Both were overtaken by the M14 merge (`policy-owner`, both modes).
2. `M14_POLICY_PACKS.md` decision 4 ("the person recorded by `policy accept --by` is free text, not checked") and its "Not built" lines on `next`, `status`, `explain`, `decide` and Studio `status`: superseded here.
3. `M13_PRINCIPLES.md` "Not built" says the Factory's `status` and `explain` cannot flag older principles without reading GitHub on every call; `M13_EFFECTS.md` "Not built" says the same for `shipped_moved`. Both are now flagged (principles from the copy last fetched).
4. `shipped.moved()` (and so `cell.py status`'s `shipped_moved.note`) says "The spec must be settled again before it is planned", while `M13_EFFECTS.md` and Product Studio say it changes nothing and reopens nothing; no gate enforces it. The Factory's new line says "goes on as it was answered".
5. `M14_DESIGN.md` gives the resolution as `accepted by <owner> on <date>: <their words>` (unquoted, and "owner"); as built it is quoted, the name is whoever was given, and since M15 it carries the check in brackets.
6. The merge station's change record (`skills/merge/scripts/change_record.py`) has no section for policy packs or product principles: an owner's acceptance, and how the name was checked, reach the merged history only through the slice spec merged beside it. Not changed here (the merge station is outside this work).

## Not done

- The change record section above (item 4.6).
- Studio `refresh` and the visual app do not show `policies_changed`; the observer and Factory Floor do not show `rules_changed`.
- No check of an owner that is a GitHub team (it would need GitHub).

## Tests

`tests/test_mach_loose_ends.py` (new): the policy-owner stop (both modes, the mixed case, lifting by acceptance and by a changed spec, partial acceptance, the walkthrough for a ticket and for a Product Studio slice, `explain`); the owner check (grammar, rules, the list, refusals, the bracket record, `spec.json`); older rules (nothing said when nothing changed, three fixed lines with the route unchanged in `next`, `status` and `explain`, principles from GitHub against the newest copy here with GitHub never asked, a failed check said); Studio (`policy accept` with the project's list, `status` flagging an older pack); and this note. `tests/test_mach_policy_packs.py` was extended deliberately where it pinned the old resolution line, the export and the settings template.

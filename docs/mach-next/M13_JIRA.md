# M13 part E: the Jira key (as built)

Design: `docs/mach-next/M13_DESIGN.md`, part E. Built 2026-11-20. One way, identifiers only: MACH never calls Jira, holds no Jira credentials and reads nothing from Jira. Using Jira as the Factory's ticket queue (`tickets.provider: jira`) is separate and unchanged.

## What was built

| Where | What |
|-------|------|
| Product Studio | `slice link <SLICE-ID> --jira KEY-123` and `epic link <EPIC-ID> --jira KEY-1` (`--no-jira` removes it), on the product manager's word. Stored as `tracking: {"jira": "KEY-123"}` in the work order or the epic. |
| The slice's issue | The marker carries ` jira=KEY-123`, one visible line `Jira: KEY-123` sits before `## Why`, and the approval comment carries the key among its fields (and one line `- Jira: \`KEY-123\``). The key is the slice's own, else its epic's. |
| The ready folder | `slice.json` gains `"jira": "KEY-123"`, only when there is a key. |
| Intake | Checks the key again, refuses a malformed one or one that is not the approved one in plain words, and carries it to the ledger (`slices.<id>.jira`, null when none) and the cell (`cell.json` `product.jira`). |
| Merge station | The key at the start of the pull request's title (`KEY-123 LOCAL-001: <title>`) and of the local merge commit's message (`KEY-123 Merge LOCAL-001: <title>`), which is what Jira's GitHub integration reads; one line `**Jira:**` in the pull request body; `- Jira:` in the change record's Ticket section. `tickets.jira.browse_url` makes the last two a link. The result of `run` and `plan` say `jira`. |
| Cleanup | The run record keeps `jira`, an optional field present only when the slice had a key (`record_version` stays 2). |

## The form of a key

`issue_rules.JIRA_KEY_RE`, `[A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,8}`, through `issue_rules.is_jira_key`, which also bounds it at 42 characters (the longest the form allows). Every place that takes or uses a key calls it: Studio when it is linked and again at `slice ready`, `slice_marker` and `approval_comment` (which refuse to write anything else), `parse_slice_body` (an unreadable key is reported, never returned), intake (the issue's marker, a folder's `slice.json`, and again when it writes the cell), the merge station, the change record and cleanup. `product.py` (the structural validator, which loads nothing) checks `tracking` with the same pattern, written out once there and marked as following `issue_rules`. Nowhere is a key that fails the check used: the merge station, the record and cleanup treat it as no key.

## Each choice

1. **The key joins the approval comment's fields, not the hashed content.** The why and spec hashes identify the text the builders build: intake's ledger, the cell's spec check, release qualification and the change record all match the spec by its SHA-256. Hashing the key into the why or the spec would make a new Jira key look like a new specification and would put a line into `intent.md` or the spec that the product manager did not write. As an approved field it is bound just as firmly: intake accepts a slice only when an unedited approval comment by the account that marked it ready names this revision, these hashes and this key (`slice_acceptance`). A body whose key differs from the approved one is refused ("its Jira key is not the one that was approved"); a visible line that does not say the marker's key, or a line with no key in the marker, makes the body "changed after it was approved". The same comparison is made by Studio's refresh (`matches_approval`, so a key edited on GitHub shows as `changed_on_github`) and by `slice take` (`slice_take_check`).
2. **A slice with no key renders exactly as before**: no marker field, no line, no approval line, and `approvals()` returns the same dict as before (a `jira` entry only when there is one). Every existing body, comment and test stands.
3. **A changed key is a new revision.** Studio decides a revision's number by whether the text changed; the key is now part of that comparison (`handoff.prepare`, `write_folder`). So a key changed after the slice was marked ready needs the slice reopened (`slice link` on a ready slice refuses, like any change) and marked ready again, and intake takes it as a new revision, under the existing rules for revisions.
4. **The epic's key is the default, read at `slice ready`.** A slice's own key wins. `epic link` lists the slices of the epic already marked ready that would carry the new key (`already_ready`); they carry it only once each is reopened and marked ready again. The epic's issue does not show the key.
5. **A malformed key in an issue is refused in plain words, never as "not written by Product Studio".** The marker's pattern accepts any token after ` jira=` so that `parse_slice_body` can say it is malformed (`jira_invalid`) instead of not recognising the marker; `slice_acceptance` then refuses with "the Jira key in its body is not in Jira's form (such as ABC-123)". An oversized key is refused the same way. The value is never returned, logged or stored.
6. **`tickets.jira.browse_url`** must be an https address with a host, optional port and plain path segments, ending in `/`, with no user name, password, query or fragment, at most 200 characters (`BROWSE_URL_RE` in `merge.py`). The link is `browse_url + key`. A value set but not of that form refuses the merge, as an unusable `records.dir` does, rather than linking somewhere unexpected; `plan` shows the refusal. Unset, the key is plain text. Nothing fetches the address.
7. **`slice take`** of another product manager's slice keeps the key it was approved with (`tracking` in the new draft, `jira` in the hand-off record), so marking it ready again does not drop it.
8. **The pull request's own merge commit** (method `pr`) is made by GitHub from the pull request's title, which starts with the key; the station adds nothing there.

## Shared-file blocks

- **`skills/ticket/scripts/issue_rules.py`**: `SLICE_MARKER_RE` gains the optional group `(?: jira=(\S+))?`; `APPROVAL_RE` gains `(?: jira=(KEY pattern))?`; new `JIRA_KEY_RE`, `JIRA_KEY_LIMIT`, `JIRA_LINE` and `is_jira_key` right after `APPROVAL_RE`; `slice_marker(..., jira=None)`; `slice_issue_body(..., follows=None, jira=None)` adds the line after the follows line; `parse_slice_body` returns `jira` and `jira_invalid` and checks the line; `approval_comment(..., jira=None)`; `approvals()` adds `jira` only when present; `SLICE_NOT_ACCEPTED` gains `bad_jira` and `jira_changed`; `slice_acceptance` copies `jira` into the marker, refuses `jira_invalid`, and matches the key through a local `approving(item, same_key)`; `slice_take_check` copies `jira` into the marker and matches it.
- **`skills/product-studio/scripts/studio.py`**: after `cmd_epic_set`, the block `jira_key`, `with_tracking`, `effective_jira`, `cmd_slice_link`, `cmd_epic_link`; in `cmd_slice_ready` one line `jira = effective_jira(data, epic)` and `jira` passed to the length check, `write_folder` and `prepare`; in `cmd_slice_take` one line `with_tracking(work, marker.get("jira"))`; in `build_parser` the `epic link` and `slice link` parsers and `link` in the slice metavar.
- **`skills/product-studio/scripts/handoff.py`**: `prepare(..., jira=None)` (the `same` comparison, the reused-revision test, the body, `same_run`, `run["jira"]`); `run()` (the body, the wanted approval, the approval comment, `entry["jira"]`); `write_folder(..., jira=None)` (`same`, `slice.json` `jira` when set, `entry["jira"]`); `describe` (`matches` compares the key); `record_taken` (`jira=marker.get("jira")`).
- **`skills/product-studio/scripts/product.py`**: `OPTIONAL` gains `"tracking"` for slices and epics, `JIRA_RE`, and one check in `_shape`.
- **`skills/run/scripts/intake.py`**: in the issue reader, a refusal when the marker's key fails the check and `"jira"` in the row; in `read_folder`, a refusal for a bad key, `set(record) - {"jira"} != FOLDER_KEYS`, and `"jira"` in the row; `"jira"` in `definition()`; in `provenance()` `found["jira"]`, checked again. (Part B's commit added `found["depends_on"]` in the same place.)
- **Schemas**: `slice.schema.json` and `epic.schema.json` gain `tracking`; `intake-ledger.schema.json` gains the optional `jira` property of a slice entry.
- **`ticket.py`, `issues.py`, `run.py`**: not changed. `ticket.py slice-check` passes on what `slice_acceptance` decides.

## Not built

- **The visual app** (`apps/studio`, `web/`) neither shows nor sets the key; its host runs a fixed list of operations, which does not include `slice link` or `epic link`. The app's slice screen shows the work order as before.
- `status` and `refresh` do not list the key per slice (`slice show` shows the work order, which holds it), and do not flag ready slices whose epic's key changed since; `epic link` says so once, at the moment it is set.
- The epic's issue, the project issue, status comments on the slice's issue, the Factory Floor and `/mach explain` do not show the key.
- Release qualification does not name it.
- A request (`mach:request`) carries no key.

## How far tested

`tests/test_jira.py` (26 tests):

- the rules: the form (good and bad keys, including lowercase, a leading zero, too long, Markdown and spaces); a slice with no key renders exactly as before and its approval reads as before; the marker, the line and the approval with a key; the line must say the marker's key; a line with no marker key is a changed body; writing a bad key is refused;
- intake on the stand-in GitHub: the key reaches the ledger and the cell; no key is null; a malformed and an oversized key are refused in plain words and never stored; a key changed in marker and line is "not the one that was approved", in the line only "changed after it was approved"; a key added under an approval without one is refused; a folder carries a key and a bad one is refused; a hand-edited ledger key never reaches the cell; Studio's own `slice link` and `slice ready` end to end through intake to `cell.json`;
- Studio: `slice link` checks the form, stores and removes `tracking`, the workspace still validates, and nothing calls GitHub; the issue and the approval carry the epic's key by default; a ready slice must be reopened to change its key, and marking it ready again is revision 2 on the same issue; no key leaves the issue as before; `epic link` names slices already ready; the folder carries the key and removing it is revision 2; `slice take` keeps it;
- merge: the local merge commit's message and the change record; the pull request's title, the body's link and the record's link with `browse_url`, and the exact gh calls unchanged; no key changes nothing; a key in the cell that fails the check reaches neither the commit nor the record; seven unusable `browse_url` values each refuse the merge with nothing changed; cleanup's run record keeps a good key and drops a bad or missing one;
- no network: no network library is imported by any file that carries the key, and no Git or gh call names Jira or the browse address.

`tests/test_mach_product_isolation.py` was extended (not loosened): the link commands and their helpers reach neither GitHub nor Git. Its exact lists of Studio's and the hand-off's Git and gh calls pass unchanged, so the key added no call. Not tried against GitHub or Jira themselves.

# M13 Part F: the change record (as built)

The product owner's decision: instead of committing `.factory/archive/`, the merge station writes a text record of how
each change was made, `docs/changes/<ticket>.md`, on the ticket's branch as its last act before landing. It arrives in
the same merge commit or pull request as the change, so the history of the code carries the history of the decisions
behind it. The evidence files stay in the local archive; the record names each one with its SHA-256, so the archive can
be checked against it. A team that must keep the evidence elsewhere sets a publish command that cleanup runs.

## What was built

| Where | What |
|-------|------|
| `skills/merge/scripts/change_record.py` | New. Settings, the record's path, its text (`render`), the secret check (`mask`), and `holds`, the one rule for the record commit. Standard library only; it runs no process except through the `git` function a caller hands in. |
| `skills/merge/scripts/merge.py` | `write_record` between revalidation and landing; the approval check accepts the record commit; the pull request body links the record; the findings review says when the pull request is at the approved commit plus its record; `status` shows `change_record`. |
| `skills/run/scripts/run.py` | `next` treats the record commit as the approved commit in its two comparisons (expired exception, approved stage), through `change_record.holds`. |
| `skills/run/scripts/explain.py` | For a finished ticket, the run record's facts carry the record's path. |
| `skills/cleanup/scripts/cleanup.py` | The run record gains `change_record` (path, SHA-256, commit); `records.publish_command` runs after the archive is written and checked, its outcome in `records_publish`. |
| `templates/config.json` | `records: {"enabled": true, "dir": "docs/changes"}`. |
| `tests/test_change_record.py` | New, 23 tests. `tests/test_merge.py` and `tests/test_lifecycle.py`: assertions updated, since the branch that lands is now the approved commit plus its record. |

## The record

One Markdown file. Sections, in this order:

1. **Ticket**: ticket, title, slice and revision, epic, the slice's issue (repository and number, written as "issue
   number 42", never `#42`), spec path, risk tier, app type.
2. **Why**: `intent.md`, quoted, cut at 4,000 characters.
3. **Plan**: the task list from `plan.md` (ID, kind, text, done), the ADRs in force when it was planned (ID, title,
   digest from `cell.json` `adrs.planned_under`), ADRs the ticket proposed, and every ADR exception (ADR, digest, who,
   when, reason).
4. **Verification**: every run, earlier failed runs (`evidence/previous-N/`) first. Per run: verdict, review loop,
   commit, the verifier's own timestamp, whether the rerun suite passed; every check (scenario `AC-NN`, matrix rule `RN`,
   holdout) in natural order, pass or fail, a failure's note, and each evidence file with its SHA-256 from
   `summary.json`; unproven items; the verifier's failures; evidence files no check cites (the suite and contract logs).
5. **Review**: every round folder (`round-1`, `round-2`, `round-2.1`) in order: outcome, risk, approvals, the reviewed
   commit, when decided, a voided approval; each seat's vote; every finding (seat, severity, security class and impact,
   title, detail, rule, file and line); a person's approval (who, when, note) or send-back (who, when, reason); every
   security exception (finding, who, when, the commit, expiry, renewal, reason) and the approvals before and after; the
   security scan's answers (kind, place and answer for each secret candidate, never a preview; each dependency and its
   answer), or that the scan was off.
6. **Build**: the last revision, tests seen failing first, and every override the builder recorded (`build-report.json`
   `deviations`: task, type, reason).
7. **Commits**: approved, revalidated (and the main commit it was brought onto), and the commit the record was added on
   top of. The record cannot name the commit that adds it, nor a merge commit made after it; it says so, and Git's
   history and `runs.jsonl` name them.

## Choices

- **Settings.** `records.enabled` (default true; only `false` turns it off) and `records.dir` (default `docs/changes`).
  When off, nothing is written, `change_record` is absent from `cell.json`, and the pull request body says nothing of
  it. A `records.dir` that is not a plain folder inside the repository (absolute, `..`, `.factory`, `.git`, `.claude`,
  odd characters, more than seven levels), or that overlaps the ADR folder either way, refuses the merge with a plain
  sentence rather than writing somewhere unexpected. Settings for records that are off are not checked.
- **Path.** `<dir>/<ticket>.md`. If that file already exists at the base commit (an earlier life of the same ticket ID
  that landed), `<ticket>-2.md` and so on: the earlier record is never replaced. A path this station recorded for this
  cell before is reused, and replaced.
- **Deterministic.** Seats, rounds, checks, ADRs and files are sorted (checks and IDs in natural order, so `AC-02`
  precedes `AC-10`); the only times are those the stations recorded. The same files and commits give the same bytes
  (tested by rendering twice with `cell.json`'s own timestamp changed).
- **Bounded.** Intent 4,000 characters; finding detail and reasons 600; titles 200; notes 300; one-line fields 120. At
  most 200 tasks, 300 checks per run, 300 other evidence files, 100 findings per round, 100 exceptions, scan items and
  overrides. A cut text ends with "(cut)", the intent with a sentence saying the full text is in the archive; a cut list
  says how many more the archive holds.
- **Redaction and inertness.** Every piece of free text goes through `issue_rules.bound_text` (cleaned of control and
  invisible characters, redacted, bounded), loaded the way `merge.py` already loads it and never copied. Then it is made
  inert as `merge.py`'s `inert()` does for the pull request: a zero-width space after `#`, `GH-`, `/issues/`, `/pull/`,
  `/discussions/` before a digit and after `@`, so nothing mentions anyone, links an issue or closes one. Two more breaks
  because the record is a file GitHub renders: `<` before a letter, `!`, `/` or `?` becomes `&lt;` (no HTML, no hidden
  comment), and `](` gets a zero-width space (no Markdown link or image that fetches). Backticks in free text become
  apostrophes, so no text can open a code span. Commit hashes, digests and SHA-256 values are checked against a hex
  pattern and written as they are; they never pass through redaction, which would mask them as long tokens.
- **No secret value.** After rendering, every line is read with the security scan's own shapes
  (`scan.secrets_in_line`, the intent station's helper, loaded as the build station loads it). Each value found is
  replaced with `[masked]`, and the text is read again; anything still found refuses the record, and nothing is merged
  (`record-refused`). If `issue_rules.py` or `scan.py` cannot be loaded, the record is refused the same way.
- **When.** After revalidation (which may send the ticket back, before any record exists) and before landing, for both
  methods. For `local` the record is in the merge commit; for `pr` it is on the pushed branch, and the platform is told
  to merge only that tip (`--match-head-commit`).
- **Once, covering every round.** The record is written at landing from everything the cell holds, so every
  verification run and review round is in it. A pull request left open (`pr-open`) already has its record on the branch;
  later runs see the commit in the branch's history and do not write another.
- **The commit.** `git add` and `git commit -m "Change record for <ticket>" -- <path>`: only that path. Hooks are not
  skipped (MACH never bypasses a project's hooks; a guard test holds every script to that), so the result is checked with
  `holds` before the station goes on: if a hook added or changed anything else, the station stops and the next run voids
  the approval. When the same text is already on the
  branch, nothing is committed.
- **The pull request.** The body gains one line: `Change record: [docs/changes/<ticket>.md](https://github.com/<owner>/<name>/blob/<commit>/<path>)`,
  pinned to the commit that added it, when the origin remote names a GitHub repository; otherwise the path alone. The
  findings review says "the approved commit with its change record added" when that is what the pull request shows.
- **Cleanup.** The run record gains `change_record: {path, sha256, commit}`, only for a merged ticket that has one
  (an optional field, like `security_exceptions`; `record_version` stays 2). `records.publish_command` is a list of
  strings, as `tickets.commands` are: run once without a shell, in the project folder, with no input and a 300-second
  limit, after the archive is written and checked and before anything is removed. `{archive}` is the archive's absolute
  path and `{ticket}` the ticket ID; with no `{archive}` the path is added as the last argument. The outcome
  (`ran`, `ok`, `exit_code`, and the last line of its output, redacted and at most 200 characters) is printed as
  `published` and kept in the run record as `records_publish`, present only when a command is set. A missing tool, a
  malformed setting, a failure or a timeout is recorded, and cleanup goes on.
- **`/mach explain`.** Cheap, so done: for a finished ticket, `run_record.change_record` is the record's path.
- **Release qualification.** Not changed: it never needed the path, and its schema is fixed. Its comparisons were
  checked (below) and are unaffected.

## Every comparison of the branch with the approved commit

| Where | Comparison | What was done |
|-------|-----------|---------------|
| `merge.py` `survey` (also the re-entry at `pr-open`) | branch tip is the approved commit, or the revalidated one | Also accepted: the record commit, by `change_record.holds`: `cell.json` names it, its only parent is the approved or revalidated commit, and `git diff-tree` shows exactly one path, the record's, added or changed. Checked in Git each time. Any other commit, a record commit that changes another file, one on another base, or one `cell.json` does not name: the approval is void. Tested. |
| `merge.py` `land_by_pr` | `gh pr merge --match-head-commit <tip>` | The tip is now the record commit; that is what was pushed. Tested. |
| `merge.py` `findings_review` | approved commit against the pull request's head | Wording only: "with its change record added". Tested. |
| `run.py` `next`, `awaiting-human`/`approved` | expired exception stops only while the tip is the approved or revalidated commit | Also when it is the record commit (`record_commit`, loading `change_record.py` from the merge skill). |
| `run.py` `next`, `approved` | tip differs from the approved and revalidated commit: "the merge station will void the approval" | Not said for the record commit; the ticket goes to merge as approved. Tested (a cell left at `approved` with its record on the branch, as a failed local merge leaves it). |
| `cleanup.py` `survey` | the branch is an ancestor of the default branch | Unchanged: the record commit is part of the branch that landed. The run record's `integration.approved_commit` stays the reviewed commit and `landed_commit` is the record commit. Tested. |
| `qualify.py` | verification's commit against the approved commit; each contract at the approved commit against the release; `merge-base(approved, landed^1)` | Unchanged and unaffected: the record commit touches no contract and the approved commit is still the reviewed one. Tested with a landed record commit and a contract: qualified, the contract passes. |
| `intake.py` | merge, landed or approved commit on the integration branch | Unchanged: each is on it. |
| `review.py` `approve-human`, `send-back` | tip is the reviewed commit, at `awaiting-human` | No change needed: no record exists before a person approves. |
| `review.py` `except` (renewing an expired exception) | tip is the reviewed or revalidated commit, at `approved` or `awaiting-human` | **Not changed** (outside this part's files). See "Not built". |
| `review.py` `start`, `verify.py` | the build's and the verification's commit against the tip | No change: they compare a rebuilt branch, after any record commit. |

## Gates that must not trip

- **The build station's scope gate** looks only at a task's uncommitted files, so a record committed earlier never
  counts against a task.
- **Review's refusal of ADR-folder edits** cannot see the record: `records.dir` may not overlap the ADR folder.
- **The `factory-tuning` rule** ("its diff touches only rule files and its own spec and tests") is judged at review,
  before any record exists. A tuning ticket gets a record like any other.
- One path reaches review with a record on the branch: a pull request left open, the main branch moves, and the
  revalidation on the next run fails, so the ticket is sent back with its record commit. The next landing replaces that
  record (the same path, a change of exactly that file). In that review the record is in the diff: for a tuning ticket
  that asks for a person's approval (stricter, never weaker); the ADR refusal still cannot trip.

## Not built

- **`review.py except` renewing an expired exception** compares the tip with the reviewed and revalidated commits. A cell
  left at `approved` with its record on the branch (a local merge or a push that failed after the record commit) would
  be refused there ("The branch is no longer the commit the panel reviewed"). At `pr-open` renewal is refused already, by
  stage, as before. Suggested change in `review.py` (`except_state`, the `APPROVED`/`AWAITING_HUMAN` branch): also accept
  a tip for which `change_record.holds(git, cell.work, cell.info.get("change_record"), head, [decision["head"], revalidated])`
  is true, loading `change_record.py` from the merge skill as `run.py` does. The same, optionally, for the tuning
  check's `files_changed` (leave out the cell's recorded record path) to remove the stricter outcome in the rare
  sent-back path above.
- Release qualification does not name the record; its readiness schema is unchanged.
- The record is not signed; it is as trustworthy as the branch it is on. Its hashes let a reader check an archive, not
  prove one was never replaced.
- Redaction is best effort, as everywhere in MACH: common shapes are masked, but nothing can recognise every secret or
  every personal detail. Names of people who approved or excepted are recorded, as they are in the archive.

## How far tested

`tests/test_change_record.py` (unittest, real Git, the fake `gh` from `test_merge.py`): the record's content for a
ticket with a failed verification run, a rejected round, a person's approval, a security exception and the scan's
answers; the same text twice; cutting; redaction and inertness (a token, a JWT the shared redaction leaves and the scan
masks, an email address, a mention, HTML, an image link, closing keywords); a value the masking cannot remove refuses
the record and nothing lands; missing helpers refuse; the approval surviving the record commit across runs of a pull
request, and voided by another commit, by a record commit that changes another file, by one on another base and by one
`cell.json` does not name; `run.py next` on a cell left at `approved` with its record; the pull request's link; records
off; another folder; unusable and overlapping folders; an earlier record for the same ticket ID kept; the run record's
field, checked against the file on the main branch and the archive's evidence hashes; the publish command succeeding,
failing (redacted, cleanup goes on), absent, missing and malformed; `/mach explain`; release qualification over a landed
record commit. The whole suite passes (`make test`). Not tried against GitHub itself or a real pull request.

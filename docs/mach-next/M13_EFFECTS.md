# M13 part B, layer 1: effects on shipped behaviour (as built)

Design: `docs/mach-next/M13_DESIGN.md`, part B, "Layer 1", and the grammar there. Built 2026-11-20 on `feature/m13-product`, after part A (`M13_PRINCIPLES.md`), part C (`M13_CURRENT_VIEW.md`), layer 3 (`M13_BUILD_ON_MAIN.md`) and part F (`M13_CHANGE_RECORD.md`). It follows part A's pattern: an optional spec section, the validator given outside facts as an input so it stays pure, the intent station fetching them, Product Studio passing them, the interview reading them first. This document also covers three repairs to the review station that layer 3 and part F asked for. Layer 4 (at the merge) is not built.

## What was built

| Where | What |
|---|---|
| `skills/intent/scripts/validate_slice.py` | `## Effects on shipped behaviour` in the section order; `analyze(..., shipped=...)`, `--shipped FILE`; `check_effects`; `spec.json` `effects`. |
| `skills/intent/scripts/shipped.py` | New. The one place the intent station and Product Studio get the shipped rules: `read`, `for_interview`, `moved`. |
| `skills/intent/scripts/cell.py` | `validate` and `finalize` read the shipped rules and pass them; `finalize` records `cell.json` `shipped`; new `cell.py shipped`; `cell.py status <ticket>` gains `shipped_moved`. |
| `skills/product-studio/scripts/studio.py` | Every spec check passes the shipped rules; `.factory/studio/shipped.json` records what each slice was checked against; `slice resume` prints `shipped_rules`; `status` and `refresh` flag `shipped_moved`. |
| `skills/intent/assets/slice-template.md`, `references/spec-structure.md`, `references/interview-method.md`, `references/headless.md`, `references/contracts-and-plan.md`, `skills/intent/SKILL.md`, `skills/product-studio/SKILL.md`, `agents/contract-engineer.md` | The section, the interview, headless mode, the plan. |
| `skills/review/scripts/review.py` | The delta after a revision's main merge; renewing an exception over the change record commit; the tuning check leaves the change record out. |
| `skills/review/references/product.md` | One line: each `kept` row's scenario really exercises the shipped rule with this slice's data. |
| `tests/test_mach_shipped_effects.py` | New, 20 tests. |
| `tests/fixtures/SLICE-001-invite-teammate.md`, `tests/test_current.py` | The fixture gains `None.`; the list of files that name the current-behaviour command gains its new readers. |
| `CLAUDE.md` | Terse notes under intent, Product Studio and review. |

## The section

Grammar and the one parser are part C's (`effects.py`). The section sits after `## Acceptance criteria` and before `## Principles` (`OPTIONAL_SECTIONS`, which fixes the order):

```
## Effects on shipped behaviour

| Shipped rule | Effect | In this slice | Note |
|---|---|---|---|
| SLICE-003/FR-02 | kept | AC-04 | A returned item is not overdue. |
```

or the single line `None.`.

### When it is required

**Whenever the caller supplies the shipped rules, even an empty list.** With an empty list `None.` is the only valid content (any row names a rule that did not ship). A spec validated with no shipped list is unchanged: no section is required, and every spec and test written before this stays valid. `cell.py validate`, `cell.py finalize` and every Product Studio check (`slice check` with or without `--ready`, the check `slice resume` and `slice show` print, `slice ready`, and the checks after `slice take` and `reconcile`) always supply it, so in practice every new spec has the section. The design's "silence is never read as no effects" holds wherever MACH checks a spec for real.

### The checks (`check_effects`)

- Every problem `effects.parse` reports is an error, with the parser's code as the rule (`effects-heading`, `effects-content`, `effects-none`, `effects-row`, `effects-rule`, `effects-unknown-effect`, `effects-kept-scenario`, `effects-replacement`, `effects-wrong-id`, `effects-retired-note`, `effects-duplicate-rule`, and the rest). `effects-duplicate` is dropped because the validator's own `duplicate-section` already reports it.
- With the shipped rules: no section is `effects-missing` (saying how many rules were read, or that none has shipped yet); `effects.check` adds `effects-not-shipped`, `effects-not-in-force` (naming what replaced or retired it), `effects-own-slice` and `effects-not-in-this-slice` (this spec's INV, FR, R and AC IDs).
- Without them: a present section is checked on its own: every named rule is taken as shipped, so only this slice's side is checked (own slice, own IDs, the grammar).
- A misspelt heading (`behavior`) is `effects-heading` and is not the section, so with a shipped list it is also `effects-missing`.
- `spec.json` gains `effects` (`shipped_rule`, `slice_id`, `rule_id`, `effect`, `in_slice`, `note`) only when the spec has the section; `[]` for `None.`.
- `--shipped FILE` takes `run.py current --json`'s whole output or its `rules` list (or a list of rule strings). An unreadable file exits 2, as `--principles` does.

## Fetching the shipped rules: `shipped.py`

One helper beside `cell.py`, imported by `cell.py` and by Product Studio (Studio adds the intent scripts folder to its path, as it already does for `cell.py` and the validator). It loads the run skill's `current.py` by path (`mach/` or `run/`, whichever way MACH is installed), and through it intake, and copies neither:

- The integration branch is intake's `Factory.integration()` (configured branch, `merge.into`, the remote's default, then `main` or `master`), constructed with the project's settings; the commit is the local branch's head, as `run.py current` uses.
- The rules are `current.compile_view(current.read_specs(root, commit))["rules"]`, exactly `run.py current --json`'s `rules`; the rules in force with their text come from the same view.
- It never raises. No Git, no integration branch, no specs, or a helper that cannot load: an empty list and a note saying why. Git commands are local reads only (`rev-parse` here; `symbolic-ref`, `show-ref`, `merge-base`, `diff --quiet`, `rev-list` in intake's `integration`; `ls-tree`, `cat-file` in `current.py`). Nothing is fetched or written; no `gh`.

`for_interview` gives the rules in force (in force and not yet reconciled, each with its kind, epic and status), at most 300, each line cleaned by the ticket station's `clean_text`, between `<<<SHIPPED-RULES-DATA commit=... sha256=...>>>` and `<<<END-SHIPPED-RULES-DATA ...>>>`, with a note that the text is data.

## The intent station

- `cell.py shipped` (no ticket; reads only) prints the fenced list for the interview's lookup.
- `cell.py validate` and `finalize` read the rules afresh each time, pass them, and print one line, `shipped rules: N at <commit> on '<branch>'.` (or `(none could be read).` with the notes).
- `finalize` records `cell.json` `shipped`: `{commit, branch, rules, checked_at}`, on both outcomes (ready, and saved with open questions).
- `cell.py status <ticket>` adds `shipped_moved` when the spec copy declares rows, the integration commit has moved since `shipped.commit`, and the same pure check now finds a row naming a rule that is no longer in force or no longer shipped. It changes nothing. A spec with no rows causes no Git read.

## Product Studio

- `Studio.shipped()` reads the rules once per command through `shipped.py`, from the product manager's own checkout. The tests pin that `studio.py` still runs no Git itself and imports no `subprocess`; the existing isolation tests pass unchanged.
- `slice check` (with a spec) and the approval (`slice ready`) record `{commit, rules}` for the slice in `.factory/studio/shipped.json` (`{schema_version: 1, slices: {SLICE-NNN: ...}}`), Studio's own git-ignored record beside `issues.json` and `session.json`.
- `check` results carry `shipped` (`commit`, `branch`, `rules`, `notes`), so a report saying "no Git" or "no specs" reaches the product manager.
- `slice resume` prints `shipped_rules` (the fenced list, with `count`, `commit`, `notes`, and `cut` when bounded).
- `status` (per slice `shipped_moved`) and `refresh` (`shipped_moved`, by slice) flag a draft or ready slice whose row now names a rule no longer in force. Nothing is reopened. A superseded slice is not checked.

## The interview

- `interview-method.md` gains "Effects on shipped behaviour": once scope is carved, a sub-agent is given the fenced list and the things the slice changes and finds the rules that mention them across every epic; each found rule is one yes-or-no question with a recommendation and then one row; `kept` gets a scenario proving it with this slice's new data; `changed` and `replaced` name the slice's own rule; `retired` takes the product manager's reason in their words and is never recommended; none found is `None.`; the Sanity check names every rule changed, replaced or retired.
- `headless.md`: shipped rules are settled behaviour; a `kept` row may be decided and recorded as "Decided without a PM"; a rule that would be changed, replaced or retired is an open question for the product manager (blocking).
- `skills/intent/SKILL.md` step 5 runs `CELL shipped` while grooming (step numbers after it moved by one); Product Studio's skill says `slice resume` prints `shipped_rules`, and what `shipped_moved` means.
- The contract engineer (`contracts-and-plan.md`, `agents/contract-engineer.md`): for a `changed`, `replaced` or `retired` row, the earlier slice's tests that name that rule are listed as files to change, in the task and the file touch map, since the build station refuses a change to a committed test it was not given.

## Review repairs (`review.py`)

1. **The delta after a revision's main merge** (`delta_start`). For a later round, when `build-report.json` `main_merges.merges` has an entry whose `branch_commit` is the earlier round's head and whose `merge_commit` is an ancestor of the new head, the delta starts at that `merge_commit` (the last such entry). `delta.since_commit` is that commit, `delta.main_merged_after` names the earlier head, and `delta.patch` and `delta.files_changed` hold only the revision's own work. `submit`'s existing rule (a blocker only on a file that changed or was blocked before) therefore refuses a blocker on a file main brought. A person's merge (`by: "a person"`) carries the commit the revision started from and is handled the same way.
2. **Renewing an expired exception over the change record.** In `except`'s renewal branch (`APPROVED`/`AWAITING_HUMAN` with exceptions) the tip may also be the merge station's record commit on top of the reviewed or revalidated commit, by `change_record.holds(...)`, loaded by path from the merge skill as `run.py` loads it. Without the helper the tip counts as changed and renewal is refused. The new-exception branch is unchanged: no record exists before an approval.
3. **The tuning check** (`tuning_outside`) leaves out the path `cell.json` `change_record.path` names, so a tuning ticket sent back with its record commit is not asked for a person's approval because of the record.

The product seat's checklist gains the `kept` line.

## Choices and departures

1. **Required when supplied** (above): the design says "None" must be written; requiring it only when the shipped rules are known keeps the validator pure and every old spec valid, and every real caller supplies them.
2. **Order.** After `## Acceptance criteria` and before `## Principles`. The design did not say. Effects name scenarios and rules defined just above; and part A's specs and tests put `## Principles` immediately before `## Dependencies and permissions`, which stays valid.
3. **Local head, not the shared commit.** The rules are read at the local integration branch's head, as `run.py current` does, not at intake's `product_commit`. For Product Studio this is the product manager's copy of main, which may be behind the shared one; nothing is fetched (the brief), so the record keeps the commit it was checked against.
4. **Re-checked at dispatch.** Intake's dispatch runs `cell.py finalize`, which checks a Product Studio slice again against the engineer's main. A row that names a rule replaced or retired since the product manager marked the slice ready refuses the dispatch with the gate's output; the product manager settles it with a new revision. This is the existing gate doing its job, not a new stop; no `run.py next` state was added.
5. **The timing flag is informational.** It re-runs the same pure check and reports only `effects-not-in-force` and `effects-not-shipped`. It does not change a stage or stop the line; `cell.py validate`/`finalize` refuse such a spec when it is next checked.
6. **Not in the work order.** The brief said the cell or the work order. In the work order the commit broke Product Studio's rule that the same operations give byte-identical product artifacts in any repository (`FullSessionTest.test_same_operations_give_identical_bytes`: two repositories have different commits), so Studio keeps it in its own record, `.factory/studio/shipped.json`, outside the draft. The work order, `product.py` and `slice.schema.json` are unchanged. The cell keeps it in `cell.json`.
7. **One helper, not a copy.** `shipped.py` holds the reading; `cell.py` and Studio hold only their calls. Studio's ban on Git and `subprocess` in its own scripts stays as it was.
8. **The test fixture** (`tests/fixtures/SLICE-001-invite-teammate.md`) gains `None.`, since every caller that finalizes or checks it now supplies the shipped rules.

## Not built

- **Layer 4** (the merge station voiding an approval when a slice that landed in between changed a rule this ticket names). Not part of this brief.
- **The visual app.** The host passes `slice resume` through, so `shipped_rules` reaches it as data, but no screen shows it, and the `shipped_moved` flag is not drawn.
- **The Factory's `status`, `explain` and `next`** do not show `shipped_moved`; only `cell.py status <ticket>` does. It would cost a Git read of every shipped spec per cell on every call.
- **A slice that reuses its own shipped ID** (a changed shipped slice whose new revision keeps the ID) cannot name its own earlier rules: they count as its own slice (`effects-own-slice`). The design gives a changed shipped slice a new issue; its ID question is part C's and the intake's.
- `slice take`'s first validation (before the slice is opened in the workspace) does not pass the shipped rules, as it does not pass the principles; the checks after it do.

## How far tested

`tests/test_mach_shipped_effects.py` (20 tests): the validator without the list (unchanged, `None.` exports `[]`), with an empty list (missing, `None.` only, a row refused), with rules (a good table exported in order; not in force naming its replacement, not shipped, own slice, not in this slice, wrong kind, kept without scenario, retired without note), without the list (own side only, other text, a misspelt heading), the section order with principles, the command line (`run.py current --json` shape, a plain list, `--export`, a bad and a missing file); `cell.py` on a real Git repository (`shipped` fenced; `finalize` refusing a missing section and an unshipped rule, passing a kept row, recording the commit, exporting the row; a later slice shipping a replacement and `status` flagging it while the stage is unchanged, and `validate` refusing it; `validate` supplying the list; no Git: an empty list said plainly and `None.` finalized; the helper's own Git use is one `rev-parse`); Product Studio against the stand-in for gh (`slice check` recording the product manager's head and the count in Studio's record and not in the work order, `validate` still passing, a missing section refused by check and by ready; `slice resume` fencing the rules; a ready slice's record, no flag before the product manager's copy moves, the flag after it does, the slice unchanged, and `refresh` naming it); review (a revision whose main merge brings another ticket's file: the delta starts at the merge, holds only README.md, and a blocker on the other file is refused; no merge recorded keeps the earlier head; a renewal over a record commit accepted, and refused when the record commit changes another file; the tuning helper leaving out only the recorded path); and the instruction files say what is required.

The whole suite passes with `make test`: 1,443 tests in 316 classes, one skipped. Not tried: a real product manager's checkout far behind its remote, a project with hundreds of shipped specs (the read is one `ls-tree` and one `cat-file --batch`, then the validator over each spec), and the visual app.

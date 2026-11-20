# M13 part C as built: the current-behaviour view, and the one parser of effects

Built 2026-11-20 against `M13_DESIGN.md` parts B (the grammar of `## Effects on shipped behaviour`) and C. This document says what exists, the functions other scripts call, each choice made, and what is left for others.

## What was built

| File | What it is |
|---|---|
| `skills/intent/scripts/effects.py` | The one parser of `## Effects on shipped behaviour`, and its check against a set of shipped rules. Pure. |
| `skills/run/scripts/current.py` | The compiler: reads the slice specs at one commit and lists, per epic, every rule in force. |
| `skills/run/scripts/run.py` | The `current` command's wiring only (`cmd_current`, its parser, and `current` added beside `where` to the commands that need no `.factory/`). |
| `skills/run/SKILL.md`, `CLAUDE.md` | `/mach current <epic>`: the skill prints what the script returns and adds nothing. |
| `tests/test_effects.py`, `tests/test_current.py` | 16 and 13 tests. |

Not built here (for the engineers named in the plan): the validator's use of the parser, the slice template and interview changes, Studio's `epic current`, and the comment on the epic's issue.

## The command

```
run.py current [--epic <EPIC-ID or issue number>] [--all] [--json] [--at <commit>]
```

- No option: one line per epic (slices, rules in force, not yet reconciled, slices not applied, conflicts).
- `--epic EPIC-001`, `--epic 12` or `--epic '#12'` (the epic's issue number), `--epic "No epic"`: that epic in full. An epic no shipped spec names gives an empty answer with a note, not a refusal.
- `--all`: every epic in full.
- `--at <commit>`: any commit; the answer says whether it is on the integration branch (`on_integration_branch`). Without it, the integration branch's head as intake names it (`intake.Factory.integration()`: `factory.integration_branch`, `merge.into`, the remote's default, then `main` or `master`). With neither a branch nor `--at`, it refuses and says to name a commit.
- `--json`: the same data. `rules` is always every shipped rule, whatever is selected; `commit` is the commit described.

It reads Git objects only (`ls-tree`, one `cat-file --batch`, `rev-parse`, `merge-base`). It writes nothing, fetches nothing, reads nothing under `.factory/` (it works with no `.factory/` folder at all and no cells), and the output has no clock in it, so the same commit gives the same bytes.

## Function shapes

### `effects.py` (load by path: `skills/intent/scripts/effects.py`, or `mach-intent/scripts/` in a project install)

```python
parse(text) -> {
  "present": bool,          # the spec has the section (a spec from before M13 has none)
  "none": bool,             # the section is the single line "None." (and no table)
  "line": int | None,       # the heading's line
  "rows": [{"line", "shipped_rule", "slice_id", "rule_id", "effect", "in_slice", "note"}],  # in_slice None for retired
  "problems": [{"line": int, "code": str, "message": str}],
}
check(parsed, shipped, slice_id=None, own_ids=None) -> [problem, ...]
describe(problem) -> "line N: message"
```

`parse` is total: any text (or a non-string) gives that shape; it never raises, prints, or reads anything. Only well-formed rows are listed; a duplicate shipped rule is reported and both rows stay listed. **A section with any problem must not be applied.**

Problem codes, each with a plain sentence: `effects-heading` (a near miss such as `behavior`, or the wrong heading level: the section is then not present), `effects-duplicate` (the section twice), `effects-empty`, `effects-content` (a line that is neither `None.` nor the table, a heading or code block inside), `effects-none` (`None` without the full stop, or written twice), `effects-none-and-table`, `effects-tables` (more than one table), `effects-header`, `effects-separator`, `effects-no-rows`, `effects-row` (not four cells), `effects-rule` (not `SLICE-NNN/INV-NN|FR-NN|RN`), `effects-unknown-effect` (anything but lowercase `kept`, `changed`, `replaced`, `retired`), `effects-kept-scenario`, `effects-replacement`, `effects-wrong-id` (an `AC-NN` where a rule belongs, a rule where a scenario belongs, or anything in a retired row), `effects-retired-note`, `effects-duplicate-rule`. From `check`: `effects-not-shipped`, `effects-not-in-force`, `effects-own-slice`, `effects-not-in-this-slice`. HTML comments in the section are skipped (template hints are the validator's to report).

`check` takes the shipped rules as a mapping (`rule -> info`), a list of rule strings, or a list of dicts with `"rule"`, so `run.py current --json`'s `rules` can be passed as it is. An entry with `"in_force": false` is reported as no longer in force, naming what took its place from `superseded_by` (`{"effect", "by", "slice_id"}`). `slice_id` refuses rows that name this slice's own rules; `own_ids` (this spec's INV, FR, R and AC IDs) refuses an `In this slice` ID the spec does not hold.

For the validator, the expected call is:

```python
parsed = effects.parse(text)
problems = parsed["problems"] + effects.check(parsed, shipped_rules, slice_id=slice_id, own_ids=ids_in_this_spec)
```

where `shipped_rules` comes from `run.py current --json` (`rules`) or from `current.compile_view(current.read_specs(root, commit)[0])["rules"]`.

### `current.py` (beside `run.py`; load by path)

```python
read_specs(root, commit) -> ({slice_id: {"path", "text", "epic_id", "epic_title", "epic_issue", "issue"}}, notes)
compile_view(specs) -> {"epics": [epic view], "rules": [rule], "conflicts": [str], "notes": []}     # pure
report(root, commit, *, branch=None, epic=None, everything=False, on_branch=True) -> the command's answer
resolve_commit(root, given) -> full commit;  contains(root, commit, tip) -> bool
epic_markdown(epic_view, commit, limit=65536) -> str                                              # pure
human(report) -> str
CurrentError  # a problem the caller can fix
```

An **epic view**: `epic_id` (None for "No epic"), `title`, `issue`, `slices` (`slice_id`, `title`, `issue`, `path`, `effects`: `declared`, `none`, `missing` or `problems`, `notes`), `in_force`, `not_yet_reconciled` (rule entries), `no_longer_in_force` (`superseded_by`: `{"effect", "by", "slice_id", "epic_id", "note"}`; `now`: the rules in force its place passed to, following the chain, empty when it ended retired), `not_applied` (`slice_id`, `problems`), `conflicts`.

A **rule entry**: `rule` (`SLICE-NNN/ID`), `slice_id`, `id`, `kind` (`invariant`, `requirement`, `decision rule`), `text` (bounded to 400 characters, control characters removed), `epic_id`, `confirmed_by` (`slice_id`, `scenario`, `note`), `takes_the_place_of` (`effect`, `rule`, `epic_id`, `note`), `lineage` (every older form, nearest first, only when longer than the direct list).

A **rule** in `rules`: `rule`, `slice_id`, `id`, `kind`, `epic_id`, `in_force`, `reconciled`, `superseded_by`.

`epic_markdown` is for the comment on the epic's issue that someone else writes: a heading, the commit, the sections, each spec text passed through the ticket station's `issue_rules.quiet` (cleaned, redacted, bounded, mentions and issue references broken) and with Markdown and HTML escaped. At most `limit` characters; when the view does not fit, whole lines are dropped from the end and the note "This view was cut to fit. Run `/mach current EPIC-NNN` for all of it." is added. It adds no hidden marker: a caller that adds one passes a `limit` that leaves room for it (and a limit below about 400 can cut the note itself).

## Choices

- **What "shipped" means.** A spec under `specs/slices/` at the commit. A slice's spec is merged with its code, so a spec on the integration branch has shipped. Files are named `SLICE-NNN-name.md` (the validator's `FILENAME_RE`); other `.md` files, a second file for one slice ID, and a file over intake's `MAX_TEXT_BYTES` are left out with a note.
- **"Later" is slice ID order.** Landing order was considered and not used: it needs a walk of history and is unreliable (squash and rebase merges, specs added in bulk, a spec rewritten after it landed). The rows already carry the direction that matters, since a slice can only name a rule that shipped before it was written. ID order decides only when two slices act on the same rule, and every such case is listed under "Conflicts" in each epic involved, never hidden. A replaced rule replaced again by another slice is still superseded; both successors are listed, and a `kept` row on a rule already superseded is listed as a conflict and not shown as a confirmation.
- **Reused by loading, never copied**: intake's `without_header` and `MAX_TEXT_BYTES`, intake's `Factory.integration()` (through `run.py`'s existing `factory()`), the validator's `analyze` and `FILENAME_RE` for invariants, requirements, decision matrix rules and scenarios, `explain.clean` for bounding, and `issue_rules.quiet` for GitHub text. The only Git listing is a few lines of `ls-tree` and `cat-file --batch`, as `qualify.py`'s `specs_at` does; that method drops the epic's name, so it could not be reused as it is.
- **A decision rule's text** is its conditions (those that are not "any value") and expected outcome, with side effects when there are any: `Admin active Yes, Seat available No: Rejected with "..."`.
- **Not yet reconciled** is per rule: a rule of a slice with no section moves to "In force" as soon as a later slice names it (`kept`), or to "No longer in force" (`changed`, `replaced`, `retired`).
- **A slice whose section has problems** keeps its own rules in force (they shipped) but none of its rows is applied; it is listed under "Effects not applied" with every problem and its line. Its problems include rows naming a rule that is in no shipped spec. Checking during the compile is against every rule at the commit, not against rules in force, because a slice was written before the later slices that may since have replaced what it names.
- **Cross-epic**: a rule's epic is its slice's epic. When a slice in one epic replaces a rule in another, the old rule's epic lists it under "No longer in force" naming the replacement and its epic, and the new rule's epic shows it with what it took the place of and that epic.
- **No `.factory/` needed.** `run.py` checks for `.factory/` before every command but `where` and `doctor`; `current` was added beside `where`, since it reads Git objects only.
- **Spec text is data**: shown bounded in quotes, never followed; the skill prints the script's answer and adds nothing.

## Left for others

- The validator calls `effects.parse` and `effects.check` (with this spec's own IDs and the shipped rules), and refuses a spec whose section has problems or is missing once part B's template requires it.
- Studio's `epic current <EPIC-ID>` and the Factory's comment on the epic's issue call `current.report(...)` and `current.epic_markdown(...)` with the marker's length taken off the limit.
- The interview and the contract engineer's fact lookup use `run.py current --epic <epic> --json` as the skill text says; their instruction files are not changed here.
- Part B layer 4 (the merge station checks whether a slice that landed in between changed a rule this ticket's spec lists) can use the same `rules` list.

## How far it is tested

`tests/test_effects.py`: the design's example table; `None.`; an absent section; every problem code above with its line; an escaped bar in a note; fences and comments; totality over odd input; `check` with every shape of shipped rules, not found (no such slice, no such rule), no longer in force (replaced and retired), own slice, an ID not in this spec; and that the module reads no file and prints nothing.

`tests/test_current.py`, over throwaway Git repositories with headed specs: kept, changed, replaced and retired together; a cross-epic replacement seen from both epics; a chain (a rule replaced, then its replacement changed) with `now` and `lineage`; a slice with no section (not yet reconciled, and moved once named); a broken section (listed, never applied); "No epic"; an epic by issue number; a conflict listed in every epic involved; `--at` an earlier commit, a short commit, a commit off the branch and a commit that does not exist; an unknown epic and a repository with no specs; determinism of the JSON and both text forms; bounded and inert spec text; the bounded Markdown at several limits with its note; the pure compiler without Git; no `.factory/` created and the working tree unchanged; and that nothing but `run.py` and the run skill names the command.

Not tested: a real project's specs at scale (one `cat-file --batch` call keeps it to a handful of Git processes), and the Markdown as GitHub draws it.

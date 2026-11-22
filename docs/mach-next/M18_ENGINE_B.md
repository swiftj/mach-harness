# M18, the Factory side of a small change, as built

Built 2026-11-22 against `M18_DESIGN.md` parts C (an engineer's ticket) and D (what the Factory sees), on top of `M18_ENGINE_A.md`. Shape's fourth route, the app, telemetry, Factory Analytics and the change record are not built here.

## What was built

| File | What |
|---|---|
| `skills/ticket/scripts/issue_rules.py` | The small-change record as identifiers: `is_small_record`, `small_suffix`, `small_from`, `small_line`; the marker and the approval comment carry it (`SLICE_MARKER_RE`, `APPROVAL_RE`, `slice_marker`, `slice_issue_body`, `approval_comment`, `approvals`, `parse_slice_body`); `slice_acceptance` and `slice_take_check` compare it; the refusal `small_changed`. |
| `skills/product-studio/scripts/handoff.py` | `prepare`, `run` and `write_folder` take `small`; it joins every "same revision?" comparison beside the Jira key and the mocks; `describe` compares it with the approval; `withdraw(read_question=True)` reads the builders' question. |
| `skills/product-studio/scripts/small_change.py` | `handoff_record(data)` (the work order to the record), `widened_by_question` (reopen). |
| `skills/product-studio/scripts/studio.py` | `slice ready` passes the record on, and no longer marks ready a slice it has just widened; `slice reopen` widens with the Factory's sentence. |
| `skills/intent/scripts/small.py` | `sentence_in(text)` and `rule_in(text)`: which rule's fixed sentence a text quotes. Nothing else changed. |
| `skills/run/scripts/intake.py` | The record from the issue (checked again) or `slice.json` (optional key `small`), in the row, the ledger entry and the revision's digest; `cell_kind` writes it into `cell.json` before `cell.py finalize`; `small_rules` loads `small.py` by path. |
| `skills/intent/scripts/cell.py` | `import small` (beside it, as `adr`, `shipped`, `policies` and `scan` are); `open --small` and the label; `kind`, `small`, `widened` in `cell.json`; the judge at `validate`, `finalize` and `check-plan`; `widen`; `kind`/`widened` in `spec.json`. |
| `skills/intent/SKILL.md`, `references/small-change.md`, `references/contracts-and-plan.md`, `skills/run/SKILL.md`, `skills/product-studio/SKILL.md` | When to read `small-change.md`, the station's commands, `WIDENED` and `STOPPED`, `--small` from the run skill, `slice ready` and `slice reopen`. |
| `docs/mach-next/schemas/intake-ledger.schema.json` | The ledger entry's `small`. |
| `docs/BLUEPRINT.md` | `/mach-intent` (a small change in the cell), Product Studio (handoff, ready, reopen), product intake. |
| `tests/test_small_change_factory.py` | New, 24 tests. `tests/test_small_change.py`: `slice ready` changed, two tests added to it, two assertions on the folder. |

## Kind and the hash: outside, approved beside it

The kind is **outside** the hashed text. The spec's and the why's SHA-256 are the text's alone, exactly as before, for every slice. The kind is carried as identifiers beside them, as the Jira key and the mocks' digest are: in the marker, in the approval comment (so a marker edited after approval is refused, `small_changed`), and in the ready folder's `slice.json`. Like the mocks' digest, it is part of the Factory's revision digest (`intake.digest_of(..., small=small_suffix(record))`), so a revision that differs only in having left the light path is a new revision and reaches the cell; without that, a PM who reopened a small slice for the Factory's question and changed no word would be "known" and never taken. Why outside: the kind is work-order metadata (who started it how, whether it left the path), not product text; putting it in the why would make the model write it and Studio check it, and every widening would change an approved text. A slice that is not small adds nothing anywhere: the marker, the approval, `slice.json`, the digest, `cell.json` and `spec.json` are byte for byte what they were (tested).

The record, everywhere it travels between Studio and the Factory:

```json
{"kind": "small", "change": "fix" | "adjustment", "shipped_rule": "SLICE-003/FR-02" | null,
 "widened": null | {"rule": "<small.py rule code>" | null, "at": "2026-11-22T10:00:00Z"}}
```

In the marker and the approval: ` kind=small change=fix rule=SLICE-003/FR-02 widened=high-risk-file@2026-11-22T10:00:00Z` (`widened=asked@...` on the PM's word; `rule=` only for a fix; `widened=` only once widened), after the Jira key and the mocks. The approval adds one visible line, `- Small change: a fix to SLICE-003/FR-02, which left the light path`. The PM's own words for widening (`slice widen --why`) never leave Studio: only that it was on their word.

## Where kind and widened live at each hop

| Hop | Where | Form |
|---|---|---|
| Studio work order | `product/slices/SLICE-NNN.json` | `kind`, `small: {change, shipped_rule}`, `widened: {at, reason, rule}` (Engine A) |
| Studio handoff ledger | `.factory/studio/issues.json` `slices.<id>.small` and `run.small` | the record, only once a slice has been small |
| GitHub issue | the body's marker | `kind=small change=... [rule=...] [widened=...@...]` |
| GitHub approval | the approval comment's marker and one visible line | the same identifiers |
| Ready folder | `product/ready/SLICE-NNN/slice.json` `small` | the record |
| Intake ledger | `.factory/intake/ledger.json` `slices.<id>.small` | the record; also inside `digest` |
| Cell | `.factory/worktrees/<ticket>/cell.json` | see below |
| Spec export | `.factory/worktrees/<ticket>/spec.json` | `kind`, `widened` |

`cell.json`, only for a small change:

```json
"kind": "small",
"small": {"from": "engineer" | "label" | "product-studio", "change": "...", "shipped_rule": "..."},
"widened": {"at": "...", "reason": "<the rule's fixed sentence, or the person's words>", "rule": "<code>" | null,
            "by": "validate" | "finalize" | "check-plan" | "interview" | "engineer" | "product-studio"}
```

`change` and `shipped_rule` are there only for `from: product-studio`. For a Studio slice, `widened.reason` is rebuilt in the Factory from the rule code (`small.sentence` with the Factory's limits) or, on the PM's word, the fixed line "The product manager took this change off the light path in Product Studio." A Studio slice the Factory finds not small is not widened in its cell: it carries `spec_question` with `small_change: <rule code>` until the PM's widened revision arrives (then `widened.by` is `product-studio`).

## For the third engineer (telemetry, Analytics, the change record)

Read the kind from:

- `cell.json` `kind == "small"`; on the light path when there is no `widened`; `widened.rule`, `widened.by`, `widened.at`; `small.from` (who started it: `engineer`, `label`, `product-studio`); `spec_question.small_change` (a Studio slice stopped by a rule: the code).
- `spec.json` `kind` and `widened` (written at `finalize`, kept by `check-plan`'s rewrite). Both absent for every other ticket.
- The intake ledger entry's `small` (the record), and the issue marker or `slice.json` upstream.

No event carries the kind yet. The places a groom exit happens: `cell.py finalize` (`station.exited` groom, both the `spec-open` and `spec-ready` branches) and the widenings (`widen`, `validate`, `finalize`, `check-plan`), each of which writes `widened` with `by`. One event is emitted that existed before: a Studio slice stopped at `check-plan` records `gate.evaluated` `plan.spec` `spec-question`, exactly as `cell.py spec-question` does, so the line reads it as the same stop.

## Each numbered item

1. **The handoff.** As above. Intake re-checks the issue's record (`is_small_record`; a bad one is "Not accepted: its body was changed after it was approved") and the folder's (its own reason). `settle_pending`, `apply_answer` and waiting work drop the old record before taking the new revision's, as with the mocks.
2. **The intent station.** `validate` and `finalize` judge a cell on the light path with `small.judge`: the spec's model and text, `risks` = intent.md's tier, `scan.risk_floor` of the ticket's labels and the cell's `risk_floor.to`; `epics` and `depends_on` from `cell.product` when there is one; `shipped_slices` from the shipped rules on the integration branch; the limits from `intent.small_change`. Not small: `widened` with the rule's sentence (`by: validate | finalize`), and a `small change:` line. Never a refusal; the spec is never touched. `finalize` writes `kind` and `widened` into `spec.json`.
3. **An engineer's ticket.** `cell.py open <ticket> --small` (the engineer's word) or the ticket's `small-change` label (from the inbox record or the local ticket, as `ticket_labels` reads them), while the stage is `interview` or `spec-open`. Refused with `--headless` or for an `AUTO-` ticket, before anything is made; the label is ignored for them. A ticket past grooming is not taken as small (`small_note`). `open` and `status` print `small_change` (method path, limits, each rule's sentence, note). `cell.py widen <ticket> --by-rule <rule> | --why "<words>"` leaves the light path while the spec is written. The run skill adds ` --small` to the intent skill's input when the person said so; `run.py` is unchanged.
4. **After the plan.** On a valid plan only, `check-plan` runs `small.judge_plan(project, plan_files(text), <the plan's contracts already on the main checkout>, <the proposed ADRs' files>)`, loading `scans.py` by path through `small.scan_rules`. An engineer's own ticket: `widened` (`by: check-plan`), the plan moved to `plan-history/<n>/` with a `replan.json`, `spec.json` removed, stage `spec-open` (the stage a saved spec resumes from: `run.py` sends it back to the interview with a person, or stops headless with `needs: answers`), `WIDENED`. A Studio slice: the plan kept the same way, `spec_question` `{text, at, revision, small_change}` with the text `"<rule's sentence> SLICE-NNN was started in Product Studio as a small change, so it had the short interview. The product manager reopens it in Product Studio, where it comes back as a full slice with this reason, finishes its interview in full and marks it ready again."`, stage `spec-ready`, `STOPPED`; `run.py` says `needs: product-answer` and intake puts it on the issue as the builders' question. `slice reopen` of a slice still on the light path reads that question (`withdraw(read_question=True)`, then `builders_question`), and `small.sentence_in` finds the rule and its sentence; the slice comes back widened with `reason` = the Factory's sentence as quoted and `rule` = its code (`small_change.widened_now` in the result). Marked ready again, it is a new revision carrying `widened=<rule>@...`; intake applies it as the answer, `finalize` drops a `small_change` question once the cell is off the light path, and the cell plans again, judged no more.
5. **`slice ready` in Studio.** When `slice ready` itself widens a slice, it returns `{"ready": false, "widened": true, "small_change": {..., "widened_now": true}, "note": "<sentence> It was not marked ready: ..."}` with exit 0, writes nothing to GitHub or the folder and does not approve it; the next `slice ready` marks it ready as the full slice. A refused `slice ready` (other problems) is refused as before, keeping the widening. A slice widened earlier is marked ready as before.
6. **Tests.** See below.
7. **Documents.** `docs/BLUEPRINT.md` and this note.

## Deviations from the design, and choices

- **A Studio slice the Factory finds not small at `finalize` stops too**, with the same question, not only after the plan. The Factory cannot widen the PM's slice, and letting it go on would build a change that is not small on a short interview. This only happens when the Factory's view differs from Studio's (another machine's limits, a dependency, a risk floor), since Studio already judged the same text.
- **`finalize` that widens an engineer's ticket does not make it ready in that act** (it saves at `spec-open`, `WIDENED`), for the reason item 5 gives for `slice ready`: otherwise a change that is not small reaches the plan on a short interview. `validate` widens and changes nothing else.
- **A plan that raises the tier to High** is not small (the `risk` rule), beside the design's three plan rules: Part A says risk is Low or Medium, and the plan is the last word on the tier.
- **`cell.py widen`** is a new subcommand of the station's own script, the counterpart of `slice widen`: the short interview needs a way to leave the light path on an answer (`--by-rule`) or on the person's word (`--why`). It is not a new program.
- **`cell.py open --small`** for the engineer's word, rather than anything in `run.py`; the run skill passes `--small` to the intent skill in words. `run.py` is unchanged.
- **The PM's words for widening stay in Studio.** The handoff carries identifiers only; the cell's `widened.reason` is the rule's sentence or a fixed line.
- **`slice take` (another PM opens the issue) and `reconcile --take theirs`** do not restore the kind: a taken small slice opens as a full slice, which is the safe direction; marking it ready again writes no record, so it is a new revision.
- **A folder-saved slice** cannot carry the Factory's question back to Studio; the PM uses `slice widen --by-rule <rule>` with the rule the engineer passes on (written in `small-change.md` and the Studio skill).
- **Contract files written for a plan that was set aside** stay uncommitted in the cell's worktree, as they do when the contract engineer stops for a spec defect; the next plan writes them again.

## How far it is tested

`tests/test_small_change_factory.py`, 24 tests in 5 classes:

- `HandoffRulesTest`: the record round trips through the marker and the approval for a fix, an adjustment and both kinds of widening, with the text's hashes unchanged; a slice that is not small writes and reads exactly as before (body, approval, `approvals`, digest); seven malformed records refused, and an edited marker not intact; an approval of another kind (none, or widened) refused as `small_changed`; `sentence_in` for every rule with other limits.
- `EngineerStartTest`: `open --small`, the label, headless and `AUTO-` refused before anything is made, the label ignored headless, a ticket past grooming not taken, and a ticket that is not small exactly as before (no field in `cell.json` or `spec.json`, not judged however big).
- `EngineerJudgeTest`: a small spec stays small and is exported with its kind; `validate` widens (never refused, spec untouched) and then judges no more; `finalize` that widens saves at `spec-open` (exit 1 without `--allow-open`), and the next finalize is ready with `kind` and `widened` in `spec.json`; the cell's risk floor counts; `widen --by-rule` and `--why` and their refusals.
- `AfterThePlanTest`: a plan that keeps it small (`PLANNED`, kind kept in `spec.json`); an engineer's ticket with a file in a high-risk area goes back to `spec-open` with its plan in `plan-history/`, `run.py next` sends it to the interview (and stops headless with `needs: answers`), and after finalize it is planned, judged no more; a plan raised to High; a Studio slice stops with the question and `needs: product-answer`.
- `IntakeTest` (the stand-in for gh, two clones): the round trip Studio `slice new --small` → `slice ready` → issue marker and approval → intake (ledger `small`, digest) → dispatch (`cell.json`, `spec.json`) → `check-plan` `STOPPED` → intake posts the question → Studio `slice reopen` comes back widened with the Factory's sentence → `slice ready` revision 2 → intake applies it → the cell is widened `by: product-studio`, the question settled, planned again. Widened on the PM's word reaches the cell. A ready folder carries the kind; one with a malformed record is not accepted. A slice that is not small is handed over exactly as before (issue body, ledger, digest, `cell.json`, `spec.json`).

`tests/test_small_change.py`: `slice ready` that widens is not marked ready, the next one marks it ready; a slice widened earlier is marked ready as before; the ready folder's `slice.json` carries the record for a small slice and no `small` key otherwise.

`make check` on 2026-11-22: 1964 tests in 454 classes passed (one skipped, as before), and the manifests validated (passed, with the existing missing-icon warning). Every existing test passes unchanged except `test_small_change.StudioCheckTest.test_ready_widens_and_is_never_refused_for_size`, replaced as item 5 asks. Not tested: a real interview run by a model against `small-change.md` in the cell; the app (its host has no operation for `slice widen` and does not yet show `ready: false` from `slice ready`).

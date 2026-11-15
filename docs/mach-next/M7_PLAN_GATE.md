# M7: the plan gate for an implementation task that can never go green (D5), and what the supervisor does about a run that cannot progress (D8, D9)

## The cause (D5, from the real cell)

SLICE-005's plan (ticket LOCAL-003) put four `[test]` tasks first, T01 to T04, all in `tests/test_borrow_item.py`. All four are HTTP integration tests that check the server's 201 body (`due`) and its new 409 `ITEM_ALREADY_LENT` body, for FR-01, FR-02, INV-01, AC-01 and AC-02. All four were committed red. T05 `[impl]` was scoped to `lending/desk.py` alone. The build station refused `build.green` for T05 seven times with `suite-red`. The four committed tests need the response changes, and only the later T06 `[impl]` (`lending/server.py`, `proto/openapi.yaml`, the same IDs) makes them. T05's own change, `borrow` returning `(held, due)`, also breaks the server's existing caller until T06. No `[test]` task stood between T05 and T06. `cell.py check-plan` accepted the plan. Three executions were spent before a person was asked.

## The rule (`cell.py check-plan`, `unreachable_green`)

The build station completes an `[impl]` task only when the whole suite passes. So once an `[impl]` task I is done, every test written before I passes. Suppose a later `[impl]` task J names a requirement or scenario (FR, AC) whose `[test]` tasks all come before I. Then the plan contradicts itself: either I can never go green, or J claims work that is already done. The check refuses that plan. The refusal names J, the IDs, the last test task and I, and it says how to fix the plan: merge I and J into one `[impl]` task, move the tests that need J after I, or stop naming them on J.

Invariants (INV) do not count, because an `[impl]` task names the invariants it keeps, not only the ones it establishes. The check reads only the plan's own data (each task's kind and the IDs it names), so the plan format gains no field. The build gate is unchanged: the whole suite must pass after every `[impl]` task. The contract engineer's brief (`skills/intent/references/contracts-and-plan.md`), the plan template and the intent skill now state the rule.

## Checked against real plans

There were 134 `plan.md` paths in scratch: live cells, `.factory/archive` tarballs (untarred), and the M6.6 and M7 projects. They hold 26 distinct texts. **25 accepted, 1 refused.** The refused one is SLICE-005, and it is refused at T06 against T05. Every plan that built to completion was accepted. A variant of the rule that also counted INV IDs would have wrongly refused tune-demo LOCAL-007, which built 9/9: its last `[impl]` task names invariants that it keeps.

## What it cannot catch

- **A later task names no IDs.** The plan check does not require every task to name IDs, so if the second `[impl]` task names none, nothing links it to the earlier tests.
- **IDs are wrong.** The check trusts the plan's IDs. A plan that names an FR on the wrong task, or leaves one off, is judged as written.
- **Tests and implementation tasks are interleaved.** If a test written between I and J names a requirement that I also needs, the check does not see it. It sees only the newest test for each ID.
- **Hidden file needs.** A single `[impl]` task can still fail because its tests need a file outside its scope that no task names, or because the change breaks an existing caller. The plan's data does not say which files a test needs.

## Supervisor (D8, D9)

- **D9:** In two cases the execution is recorded as `execution.failed` with `not_progressing` and the ticket is parked for a person at once, without spending the remaining attempts:
  - `workflow-stuck`: the belt workflow's own result says `stuck` for the ticket, even if the ticket moved first.
  - `same-refusal`: the cell is in `building`, and the next pending task in `build.json` plus the last build-gate refusal this execution recorded in `lifecycle.jsonl` equal the previous execution's.
- **D8:** An `execution.completed` event now carries `exit_code`. A Claude Code process ended by a signal (a negative exit code) is recorded as `how: killed`. Only a clean exit, `how: exited` with `exit_code` 0, clears the attempt count.

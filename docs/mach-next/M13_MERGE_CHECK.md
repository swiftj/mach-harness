# M13 part B, layer 4: the check at the merge (as built)

Design: `docs/mach-next/M13_DESIGN.md`, part B, "Layer 4". Built 2026-11-20. Layers 1 to 3 are described in their own documents (`M13_BUILD_ON_MAIN.md` for layer 3).

## What was built

In `skills/merge/scripts/merge.py`, the merge station's revalidation (`revalidate`) gained one step, `check_landed`. It runs only when main has moved since the commit that was verified and reviewed, the merge of main into the ticket's branch was clean, and the test suite passes on the result: the three things the station already did. It then looks at what landed in between and decides whether the approval carries over.

**What landed in between** is the commits on main that are not in the branch's history before the merge (`git rev-list <branch before>..<main>`), and the files they changed: `git diff --name-only --no-renames <merge-base(branch before, main)> <main>`. The net change is used, so a file changed and changed back counts as nothing.

**This ticket's own files** are its diff from its merge base with main, as review's whole-ticket diff computes it: `git diff --name-only --no-renames <merge-base(approved, main)> <approved>`. After the build station has merged main in (layer 3), that merge base is the latest main the branch holds, so main's work is not counted as the ticket's.

The approval does **not** carry over when either holds:

- **(a) a file both changed.** A file in the ticket's own files that a landed commit also changed. Left out: anything under the change record folder (`records.dir`), every slice spec under `specs/slices/` other than this ticket's own (`cell.json` `spec_path`), and the byproducts the station already ignores (`BYPRODUCT_RE`: caches, compiled files, coverage).
- **(b) a shipped rule this ticket relies on.** A slice spec that landed (`specs/slices/SLICE-NNN-*.md`, added or changed, read at main's head with `git show`) whose `Effects on shipped behaviour` has a `changed`, `replaced` or `retired` row for a shipped rule that either this ticket's own spec lists in its effects section (any effect) or that belongs to a slice this ticket's slice depends on. Both specs are read with `skills/intent/scripts/effects.py`, loaded by path; nothing else parses the section.

When either holds, nothing lands. The station:

1. keeps the merge of main on the branch (it is the result to be verified and reviewed);
2. writes `review/merge-recheck.md` in the cell: how many commits landed and, in plain words, each reason: "SLICE-004 landed on main (specs/slices/SLICE-004-late-returns.md): it replaced SLICE-003/FR-02, and this ticket's spec lists it." or "Work that landed on main since approval changed files this ticket also changed: README.md.";
3. voids the approval through the same `void_approval` the station uses when the branch is not the approved commit (stage `built`, review `VOID`, verification cleared, `build-report.json` `head` set to the merged commit, the approving round's own `decision.json` kept and marked void). The void record gains `findings_path`, `landed_files`, `landed_slices` and `main_commit`, and its reason says that work that landed touches the same ground;
4. refuses with `landed-overlap`, saying the reasons and that no judging round is used unless verification fails.

`run.py next` then says `verify`, as it already does after a void.

## Each choice

1. **Only after a clean merge and a passing suite.** A conflict still stops for a person and a failing suite still sends the ticket back as findings; this check adds a third outcome, never replaces one.
2. **The branch before the merge, not the approved commit, bounds "what landed".** On the first landing they are the same (or the approved commit plus its change record). When a pull request is left open and main moves again, the branch already holds the main it was revalidated onto; those commits were checked then, so only the newer ones are looked at. The ticket's own files are always taken from the approved commit, so a change record commit on the branch is never part of them.
3. **Dependencies.** The cell did not record what its slice depends on. Intake now records it at dispatch as `cell.json` `product.depends_on`: slice IDs, dependencies named by issue resolved to their slice through the ledger, ones this Factory never took in left out. A ticket that did not come through intake (`/mach new`, telemetry) has none, so only its own effects rows count.
4. **The spec text, not `spec.json`.** The ticket's own effects rows are read from the cell's `spec.md` (the validated copy), or from the spec on the approved commit if the copy is missing. `spec.json` does not carry effects rows today; reading the spec's text with the one parser stays right whether or not it later does.
5. **Unreadable means "not known", which does not let the approval through.** A landed spec whose effects section has a problem, an effects parser that cannot be loaded while specs landed, or Git unable to list the files, are each a reason the approval does not carry over, said in plain words. Problems in the ticket's own effects section are said too (its well-formed rows are still used). A spec with no section at all (shipped before part B) states no effect and triggers nothing by itself. At most 200 landed specs are read; more is said as a problem.
6. **Lock files are counted.** The station's existing byproduct rule does not include lock files, and a lock file both sides changed means the ticket's dependencies moved under it, which is ground worth looking at again. Nothing was added to the byproduct rule.
7. **The setting.** `merge.revalidate_overlap`, default `true` (added to `templates/config.json`); only `false` turns it off. Off, the station behaves exactly as before, records nothing for the check, and `plan` does not list it under `would`.

## How it meets the rest of the line

- **The three-round limit.** Rounds are counted by `build-report.json` `review_loop`, which only `build.py revise` raises. A void raises nothing. The re-verification that passes leads to `review.py start`, which opens a repeat folder of the same judging round (`round-N.1`, `review.py open_round`), so a pass uses no round. A re-verification that fails is `FAIL_WITH_EVIDENCE` and starts a revision, which uses a round like any failed verification: the merged result really does not work. Tested end to end (verify, review, merge) with `review_loop` staying 0 and the repeat round `round-1.1`.
- **A recorded security exception** stays on the voided round's own `decision.json` as today; it is bound to the commit that was reviewed, so the re-review on the merged result decides afresh and a person records a new exception if the veto stands again.
- **The change record** is written only at landing (`write_record` runs after `revalidate`), so none exists on this path. The one exception is the one the change record already describes: a pull request left open with its record commit, main moves, and this check (or the suite) sends the ticket back; the next landing replaces that record (the same path).
- **The lifecycle log.** One `gate.evaluated` record per check, through the shared helper, written after the station's own files (the void, the findings file), as every station records, and never affecting the result: gate `merge.landed_overlap`, outcome `pass` or `refuse`, reason code `landed-overlap`, and counts (landed commits, overlapping files, problems) plus the landed slice IDs. With the setting off, or main not moved, there is no check and no record. The refusal itself is recorded by the station's existing `merge.land` gate record with the code `landed-overlap`.

## Shared files changed

- `skills/run/scripts/intake.py`, in `provenance()` (the dict intake writes as `cell.json` `product`), three lines before `return found`:

```python
        # M13 (merge check): the slices this one depends on, as slice IDs, for the merge station's look at what landed.
        slices = self.ledger().get("slices") or {}
        found["depends_on"] = sorted({dep.get("slice_id") or self.resolve_dep(dep, slices)[1] for dep in entry.get("depends") or []} - {None})
```

- `templates/config.json`: `"revalidate_overlap": true` in `merge`.
- `CLAUDE.md` (merge station, Revalidation) and `skills/merge/SKILL.md` (step 2 and Settings): short notes.

## Not built

- **Review's packet does not carry the reasons.** The repeat round's reviewers are not shown `merge-recheck.md`; `review.py` was not mine to change. Suggested: when the latest `decision.json` has `void.findings_path`, `review.py start` lists it in the packet as context (not as findings to answer).
- **Review's delta diff after a void.** As `M13_BUILD_ON_MAIN.md` says for a revise merge, a repeat round's delta from the earlier round's head includes main's commits merged in. The same suggested fix applies: when `cell.json` holds a void whose `branch_commit` descends from the earlier head through a station merge, diff from that merge commit.
- `/mach explain` and `decide.py` do not name `merge-recheck.md`; a void reads as "built; not yet verified" as before.
- MACH still does not find an interaction nobody specified and no file overlap points to (design, "Not attempted").

## How far tested

`tests/test_merge_overlap.py` (10 tests), real Git and the real stations:

- trigger (a): main lands the same edit to a file the ticket changed; the merge is clean, the suite passes, the approval is void, nothing lands, the merge stays on the branch on top of the approved commit, the findings file names the file, `run.py next` says `verify`, one lifecycle record `refuse`;
- trigger (b) by the ticket's own effects row (a landed slice `replaced` the rule it lists as `kept`), and by dependency (a landed slice `retired` a rule of the slice it depends on); another slice's spec is not counted as a file overlap;
- neither: an unrelated file, a landed slice that keeps the listed rule and changes an unrelated one, a landed slice with `None.`, another ticket's change record and a byproduct all land; the ticket merges; one lifecycle record `pass`;
- main not moved: no check, no record; the setting off: the same overlapping edit merges and nothing is recorded; the template has the setting on;
- the effects parser missing while a spec landed: the approval does not carry over;
- no round: approve through the real review panel, the check voids, re-verify passes, `review.py start` opens `round-1.1` in round 1, `review_loop` stays 0, the repeat approves and the merge lands;
- intake: dispatch records `product.depends_on` (`[]`, then the dependency named by issue resolved to `SLICE-001`).

Not tested: a pull request left open across a void (the path is the existing one, with the existing record behaviour), a landed spec that changes this ticket's own spec file, and real GitHub.

<!--
MACH plan template (mach-intent, stage 2). plan.md is the "how" for one ticket.
Keep every heading below. Replace every <placeholder> and delete every comment,
including this one; 'cell.py check-plan' rejects leftovers.
Save as plan.md in the cell folder (the "plan_path" that 'cell.py open' prints).
Paths are relative to the cell's working folder ("workdir").
-->

# Plan: <SLICE-NNN: slice title>

- **App type:** <web | cli | api | grpc | rest | desktop | mobile | library>
- **Risk tier:** <High | Medium | Low>
- **Contracts:** <comma-separated contract file paths, or "None." with a reason>
- **ADRs:** <comma-separated IDs of every architecture decision the plan relies on or proposes, such as ADR-0003, ADR-0012; or "None.">

## Contracts

<!-- One bullet per contract file: what boundary it defines, whether it is new or changed, and the
     requirement IDs it carries. Changing an existing contract makes the risk tier High. -->
- `<path>`: <new | changed>. <Boundary it defines> (<FR-NN, INV-NN>)

## Tasks

<!-- An ordered checklist. Each task has an ID, a kind in brackets ([test], [impl], [contract],
     [refactor] or [docs]), the files it touches, and the spec IDs it satisfies. Tests come first:
     every [impl] task is preceded by the [test] task that fails without it. Every FR, INV and AC in
     the spec appears in at least one task. The suite must pass after each [impl] task with only the
     files of the [impl] tasks so far: put every file one behaviour needs in one [impl] task, and name
     on it only the FR and AC IDs it makes pass.
     Optional, only where the slice really has separate parts (the brief's "Parts that can be built at
     the same time"): give each behaviour its own test file and module; split the list with the
     sub-headings "### Before the lanes" (what several parts need), "### Lanes" and "### After the
     lanes" (the wiring that joins them), in that order; and write "after T03" beside a task's IDs when
     it needs that earlier task's work in a way its files do not show. Never split work only to make
     the plan look parallel. Without them the plan is one sequence, as before. -->
- [ ] T01 [test] <What the failing test proves> — `<test file>` (<FR-NN, INV-NN, AC-NN>)
- [ ] T02 [impl] <The smallest change that makes T01 pass> — `<file>` (<FR-NN>)

## File touch map

<!-- Every file the plan creates or changes, once, so parallel cells can see collisions. -->
| File | Change | Tasks |
|------|--------|-------|
| `<path>` | <create or modify> | <T01, T02> |

## Engineering decisions

<!-- Technical choices made while planning that the spec left to engineering, each with its reason,
     so reviewers can challenge them. A choice an accepted ADR already makes is not repeated here: name
     the ADR under 'ADRs'. A new library, language or framework no ADR covers gets a proposed ADR
     (cell.py adr-draft), listed under 'ADRs'. Use "- None." if there were none. -->
- <Decision, and why>

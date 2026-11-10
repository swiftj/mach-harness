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

## Contracts

<!-- One bullet per contract file: what boundary it defines, whether it is new or changed, and the
     requirement IDs it carries. Changing an existing contract makes the risk tier High. -->
- `<path>`: <new | changed>. <Boundary it defines> (<FR-NN, INV-NN>)

## Tasks

<!-- An ordered checklist. Each task has an ID, a kind in brackets ([test], [impl], [contract],
     [refactor] or [docs]), the files it touches, and the spec IDs it satisfies. Tests come first:
     every [impl] task is preceded by the [test] task that fails without it. Every FR, INV and AC in
     the spec appears in at least one task. -->
- [ ] T01 [test] <What the failing test proves> — `<test file>` (<FR-NN, INV-NN, AC-NN>)
- [ ] T02 [impl] <The smallest change that makes T01 pass> — `<file>` (<FR-NN>)

## File touch map

<!-- Every file the plan creates or changes, once, so parallel cells can see collisions. -->
| File | Change | Tasks |
|------|--------|-------|
| `<path>` | <create or modify> | <T01, T02> |

## Engineering decisions

<!-- Technical choices made while planning that the spec left to engineering, each with its reason,
     so reviewers can challenge them. Use "- None." if there were none. -->
- <Decision, and why>

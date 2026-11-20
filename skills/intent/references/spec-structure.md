# Spec structure rules

Read this file in Phase 4 of the interview, together with `assets/slice-template.md`. It lists the whole-file checks that `scripts/validate_slice.py` runs. Rule codes in brackets match the validator's output. Requirement grammar is in `ears-syntax.md`; the decision matrix, scenarios, and dependencies are in `acceptance-matrices.md`.

## File name and slice ID

- The file name is `SLICE-NNN-short-name.md`: `SLICE-`, three or more digits, a lowercase kebab-case name, and `.md` [filename].
- The file has exactly one H1, `# SLICE-NNN: Title`, using the same ID as the file name [title].
- No other spec in the same folder uses the same slice ID [duplicate-slice-id]. `cell.py validate` also passes every other open cell and the main checkout as `--registry` folders, so two tickets groomed at the same time cannot take the same ID.
- The validator also reads the Out of scope pointers in the other `SLICE-*.md` files next to the spec, so it knows which IDs are already reserved. If another spec reserved this slice's ID for a feature that shares no significant word with this spec's title, it warns, so you can confirm this spec is that feature [reserved-id].

## Sections

These H2 sections are required, each exactly once, in this order [missing-section] [duplicate-section] [section-order]:

1. `## Summary`
2. `## Scope`, containing `### In scope` and then `### Out of scope`
3. `## Preconditions`
4. `## Invariants`
5. `## Functional requirements`
6. `## Acceptance criteria`, containing `### Decision matrix` and then `### Scenarios`
7. `## Dependencies and permissions`
8. `## Assumptions`
9. `## Accepted defaults`
10. `## Open questions`

One optional section sits between `## Acceptance criteria` and `## Dependencies and permissions`: `## Principles`, present only when the project has product principles (below).

Any other H2 section is a warning, because downstream agents may ignore it [extra-section].

## Principles

A product principle is one sentence, `PP-NN`, that must hold in every slice; the product manager keeps them in Product Studio. When the project has any, the spec answers every active one, one line each, in this form:

- `- **PP-01** (revision 2): "A published version MUST NOT be edited in place." **Applies:** INV-02, AC-03.`
- `- **PP-02** (revision 1): "<statement>" **Does not apply:** This slice only reads versions.`
- `- **PP-03** (revision 1): "<statement>" **Exception:** <the product manager's reason, in their words>.`

The validator is given the principles as a file (`--principles`, which `cell.py` and Product Studio pass for you) and refuses a spec that leaves an active principle unanswered [principle-unanswered], quotes its statement other than exactly [principle-quote], names a revision that is not its current one [principle-revision], or answers a principle that does not exist [principle-unknown]. A row for a retired principle is a warning [principle-retired]. Without the principles file, each row is still checked on its own. `Applies` names at least one INV-NN, FR-NN or AC-NN that this spec defines [principle-applies]; `Does not apply` and `Exception` need a reason [principle-reason]; a line in any other form is an error [principle-format]. A project with no principles has no section, and nothing else changes. An exception is the product manager's decision: never recommend one.

## Section content

- **Summary** has exactly three lines, `- **Actor:** ...`, `- **Trigger:** ...`, and `- **Outcome:** ...`, each with a value [summary-format]. The actor is one persona. "and", "or", "/", "&", or a comma in the actor produces a warning; text in parentheses, such as "(age 18+)", is ignored [single-actor].
- **In scope**, **Out of scope**, and **Preconditions** each have at least one bullet [empty-section].
- **Out of scope** items name the deferred feature and end with `(Deferred to SLICE-NNN)`, optionally followed by a period. The ID is reserved for the future slice and is never this slice's own ID; if nothing was deferred, the section is `- None.` [deferred-pointer]. Pointing at an ID that already has a spec in the folder is a warning, because deferred items normally reserve a new ID [deferred-pointer]. Pointing at an ID another spec reserved for a feature that shares no significant word with this item is also a warning, because the two may be different future slices [reserved-id].
- **Invariants** and **Functional requirements** each have at least one requirement line [empty-section].
- **Decision matrix** contains a table [matrix-missing], and **Scenarios** contains at least one scenario [scenario-missing].
- **Assumptions** holds only two kinds of entry, so the PM can review everything they did not decide themselves. The first is decisions the PM explicitly handed to the agent ("you decide"), each with its reason. The second is facts found in the project that the spec relies on, each with its source file. Every other decision is put to the PM during the interview, and the absence of a fact is not an assumption. Write `- None.` if there are neither [empty-section].
- **Accepted defaults** lists each common default the PM accepted, such as a link lifetime the agent recommended, so engineers can tell a default from a hard business rule. Each entry ends with the requirement IDs it produced, such as `- Reset links expire 30 minutes after they are sent (INV-02).`, and those IDs must exist [defaults-format]. Write `- None.` if the PM accepted no defaults [empty-section].
- **Open questions** has at least one bullet; write `- None.` when nothing is open [empty-section]. Each open question ends with a follow-up note naming who or what can answer it, such as `- What is the refund limit for annual plans? Follow up: Finance team.` [open-question-format]. Any open question produces a warning so the handoff lists it [open-questions]. Open questions come from "I don't know" answers and from branches left unvisited when the PM paused.

## Ready for engineering

A spec with open questions can still pass validation, so a PM can save partial work and come back to it. To confirm a spec is ready for engineering, run the validator with `--ready`. Open questions then become errors, and the run fails until every question is answered [open-questions]. A spec that is ready prints `READY` instead of `PASSED`.

For downstream workflows, `--export` prints the validated spec as JSON instead of the usual report, with every decision matrix rule expanded into concrete test cases. It prints nothing on standard output while the spec has errors, and the findings go to standard error.

## Leftover template text

- Delete every `<!-- ... -->` comment [template-residue].
- Replace every `<placeholder>` [placeholder]. Angle brackets inside double-quoted messages are message variables, not placeholders. Inline code and `<https://...>` links are not flagged either.
- Resolve every `TBD`, `TODO`, and `FIXME` [placeholder]. They are allowed only under `## Open questions`.

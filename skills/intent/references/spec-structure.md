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

Two more sections sit between `## Acceptance criteria` and `## Dependencies and permissions`, in this order: `## Effects on shipped behaviour`, required whenever the spec is checked against the shipped rules, which `cell.py validate`, `cell.py finalize` and Product Studio always do (below), and `## Principles`, present only when the project has product principles (below). `## Policies` follows them, present only when a policy pack applies (below).

Any other H2 section is a warning, because downstream agents may ignore it [extra-section].

## Principles

A product principle is one sentence, `PP-NN`, that must hold in every slice; the product manager keeps them in Product Studio. When the project has any, the spec answers every active one, one line each, in this form:

- `- **PP-01** (revision 2): "A published version MUST NOT be edited in place." **Applies:** INV-02, AC-03.`
- `- **PP-02** (revision 1): "<statement>" **Does not apply:** This slice only reads versions.`
- `- **PP-03** (revision 1): "<statement>" **Exception:** <the product manager's reason, in their words>.`

The validator is given the principles as a file (`--principles`, which `cell.py` and Product Studio pass for you) and refuses a spec that leaves an active principle unanswered [principle-unanswered], quotes its statement other than exactly [principle-quote], names a revision that is not its current one [principle-revision], or answers a principle that does not exist [principle-unknown]. A row for a retired principle is a warning [principle-retired]. Without the principles file, each row is still checked on its own. `Applies` names at least one INV-NN, FR-NN or AC-NN that this spec defines [principle-applies]; `Does not apply` and `Exception` need a reason [principle-reason]; a line in any other form is an error [principle-format]. A project with no principles has no section, and nothing else changes. An exception is the product manager's decision: never recommend one.

## Policies

A policy pack is the organisation's: `policies/<pack>/policy.md` in the repository, with an owner and numbered statements `POL-<pack>-NN`, changed by pull request. A pack applies when its applies-to is `all`, or names a topic (`topic:<word>`) the spec talks about. The spec answers each one that applies, in this form:

- `- **POL-security** (sha256 1a2b3c4d5e6f): Followed.`
- `- **POL-privacy** (sha256 9f8e7d6c5b4a): Concerns.`, then one indented line per concern:
  `  - **POL-privacy-03**: "<the statement, exactly>" **Cannot be met:** <one sentence>. **Owner:** <the pack's owner, exactly>. **Resolution:** open.`

The digest is the first 12 characters of the pack's SHA-256, as `CELL policies` prints it. A resolution is `open`, `spec changed` (the spec now meets it), or `accepted by <who> on <YYYY-MM-DD>: "<their words>"`, which only `policy accept` writes, on a person's explicit word. The validator is given the packs (`--policies`, which `cell.py` and Product Studio pass for you) and refuses a spec that leaves a pack that applies unanswered [policy-unanswered], names a pack or statement that does not exist [policy-unknown], quotes a statement other than exactly [policy-quote], names the owner otherwise [policy-owner], names an older digest [policy-digest], or cannot be checked because a pack cannot be read [policy-problem]. A retired pack's line is a warning [policy-retired]. Each line is also checked on its own [policy-format] [policy-reason] [policy-resolution]. An open concern is a warning while drafting and an error once the spec is ready [policy-concern-open]: `slice ready` and `cell.py finalize` refuse it. The rows reach `spec.json` as `policies`. A project with no pack that applies has no section, and nothing else changes.

## Effects on shipped behaviour

What this slice does to behaviour that has already shipped: the rules (invariants, requirements and decision rules) of the slice specs on the integration branch. The section holds either the single line `None.` or one table:

```
| Shipped rule | Effect | In this slice | Note |
|---|---|---|---|
| SLICE-003/FR-02 | kept | AC-04 | A returned item is not overdue. |
| SLICE-003/R3 | replaced | FR-05 | |
| SLICE-002/INV-01 | retired | | The product manager's reason, in their words. |
```

- `Shipped rule` is `SLICE-NNN/` followed by an `INV-NN`, `FR-NN` or `RN` of a shipped slice, never this slice's own [effects-rule] [effects-own-slice].
- `Effect` is `kept`, `changed`, `replaced` or `retired` [effects-unknown-effect].
- `kept`: the rule still holds, and `In this slice` names the scenario (`AC-NN`) that proves it with this slice's new data [effects-kept-scenario].
- `changed` and `replaced`: `In this slice` names the invariant, requirement or decision rule of this slice that takes its place [effects-replacement].
- `retired`: `In this slice` is empty and `Note` holds the product manager's reason [effects-retired-note].
- The ID in `In this slice` is of the right kind [effects-wrong-id] and defined in this spec [effects-not-in-this-slice]. Each shipped rule is named once [effects-duplicate-rule].

`cell.py` and Product Studio read the shipped rules from the integration branch (as `run.py current --json` lists them) and give them to the validator (`--shipped`). Then the section is required [effects-missing], and each row must name a rule that shipped [effects-not-shipped] and is still in force [effects-not-in-force]; with no rule shipped yet, `None.` is the only valid content. Write `None.` when the slice changes no shipped behaviour: silence is never read as no effects. Any other text in the section, a misspelt heading (`behavior`), an empty section or a malformed table is an error (the codes start with `effects-`). Without the shipped rules a spec with no section stays valid, and a present section is checked on its own. The rows reach `spec.json` as `effects`.

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

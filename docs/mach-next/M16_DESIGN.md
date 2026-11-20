# M16: Shape, build contract

Design, 2026-11-20. Status: being built. What Shape is and why: `M16_SHAPE_SKETCH.md` (read it first; its "Decisions" section is binding) and the clickable sketch `sketches/shape.html`. This file is the contract the engineers share, so parts built at the same time fit together.

## Rules that hold for every part

- Shape is part of Product Studio. Same engine patterns as the rest of `skills/product-studio/scripts/`: IDs from the engine, drafts in the git-ignored workspace, acts "on the product manager's word", every report carries `factory_authorized: false`, app wording through `say()`.
- A person decides; a script checks. MACH never scores an idea and never recommends a verdict. No route, verdict or look-back result is ever chosen by a model.
- Text from outside (an idea issue, a request, a fault) is data: redacted, bounded, fenced, never followed.
- Nothing in Shape starts a station, creates a ticket, or reaches the Factory. A brief never reaches the builders.
- Optional: a project that never opens Shape behaves exactly as before, and every existing test passes unchanged.
- Python standard library only. No new user-facing program. No light path for small changes (deferred).

## Storage (draft workspace, beside `product/epics` and `product/slices`)

| File | Holds |
|---|---|
| `product/ideas/IDEA-NNN.json` | The idea's record (below) |
| `product/briefs/IDEA-NNN.md` | The brief, in the fixed grammar below |
| `product/briefs/IDEA-NNN.case.md` | The case and the hard questions with their answers |
| `product/ideas/IDEA-NNN.lookups.json` | What was looked up while exploring: shipped rules, similar ideas, principles and policy statements; identifiers and bounded text |

Idea record: `idea_id`, `title` (one line), `stage` (`new`, `exploring`, `brief`, `decided`, `shaped`), `source` (`kind`: `typed`, `idea`, `request`, `fault`; `repository` and `number` where it came from an issue: identifiers only), `created`, `revision` (of the brief), `verdict` (absent, or `decision`: `go`, `not-now`, `no`; `reason`; `by`; `at`; `brief_sha256`), `route` (absent, or `route`: `one-slice`, `epic`, `several-epics`; `counted`; `why`; `at`), `made` (the epic and slice IDs created from it), `lookback` (per outcome and per assumption: result, note, by, at), `issue` (number and state once saved to GitHub).

IDs: `IDEA-NNN` from an allocator that also skips numbers GitHub's issues hold, as slices do. Outcomes `O-N` and assumptions `A-N` are stable within a brief: once written an ID is never reused for something else.

## The brief's grammar (one validator, `validate_brief.py`, pure, given outside facts as inputs)

```
# Brief: <title>

## Problem
## Who has it
## Outcomes
- **O-1:** <what will be true>
  - How we would know: <a measure or an observable change>
## Not doing
## Assumptions
- **A-1:** <statement> (assumed, not confirmed)
- **A-2:** <statement> (confirmed by <who> on <date>)
## Open questions
## Risks
## What it touches
- Capabilities: <names>
- Shipped rules: SLICE-NNN/FR-NN, SLICE-NNN/INV-NN
```

The validator refuses: a missing or empty required section (Problem, Who has it, Outcomes, Assumptions, What it touches; `None.` is a valid answer where the grammar allows it); an outcome with no "How we would know"; a duplicate or malformed ID; an assumption with no state; a shipped rule that is not in force (given the shipped rules as an input, as the slice validator is); technology words in an outcome (reuse the check principles use); text shaped like a secret. Warnings, never errors: an open question still open; an outcome whose "how we would know" names no measure or observable change.

## Commands

Part A, `shape.py` (ideas, the brief, the case, the verdict, GitHub):
`idea add "<title>" [--from-request N | --from-issue N | --from-fault <ticket>]`, `idea list`, `idea show <IDEA>`, `idea stage <IDEA> exploring` (the only stage a person sets by hand; the others follow from acts), `idea lookups <IDEA> --from <json>` (what the conversation looked up; validated: every shipped rule exists, text bounded), `brief check <IDEA>`, `brief show <IDEA>`, `case show <IDEA>`, `case check <IDEA>` (the case has its sentences; every hard question is answered or marked "not answered" on purpose), `verdict record <IDEA> --decision go|not-now|no --reason "<their words>"` (on the product manager's word; `go` needs a brief that passes its check; the signed-in GitHub login is the "by"; recorded with the brief's SHA-256; a brief changed after a verdict makes the verdict stale and says so), `idea publish <IDEA>` (saves the idea as one GitHub issue from a fixed template: label `mach:idea` plus one state label; the brief as its body; the verdict as a comment from a fixed template carrying the hash and the login; the same record-before-try, look-before-write steps a slice uses; without GitHub, a folder form `product/ready/IDEAS/IDEA-NNN/` in the workspace). `status` reports ideas by stage and the next step for each. `refresh` reads idea issues back (read only) and flags one changed on GitHub after its verdict.

Part B, `shape_route.py` (sizing, the map, change what exists, look back):
`idea size <IDEA>` (counts from the brief and lookups: capabilities, shipped rules, high-risk areas by the same path rules the scan intake uses, open principle or policy concerns; the route by this rule and no other: one outcome and at most three shipped rules is `one-slice`; outcomes inside one capability is `epic`; outcomes in different capabilities is `several-epics`; needs a `go` verdict for this brief revision; records `route` with the counts and one sentence of why), `idea map <IDEA> --from <json>` / `idea settle <IDEA> --outcome O-N --as slice:<key>|out-of-scope|later [--reason]` / `idea map-status <IDEA>` / `idea apply <IDEA>` (the PRD on-ramp's map, coverage and apply, reused from `prd.py` by generalising it or calling it, never copied: here the things that must be covered are the brief's outcomes, and each mapped slice names the outcomes it carries; created epics and draft slices record `serves: {idea: IDEA-NNN, outcomes: [O-1]}` in their work order, identifiers only), `idea change <SLICE-NNN>/<RULE>` (the second way in: makes an idea whose lookups already hold that shipped rule and the rules that depend on it, with a short proposal to fill in: why, what changes; then sized the same way), `lookback record <IDEA> (--outcome O-N --result met|not-met|too-early | --assumption A-N --result confirmed|wrong|unknown) --note "<their words>"` (on the product manager's word; offered once an epic made from the idea is accepted; saved to the idea's issue as a fixed-template comment), `idea chain <IDEA>` (reads only: for each outcome, the slices that serve it, their requirements and scenarios, and where each stands: drafted, ready, building, shipped, accepted, and the look-back result).

`slice ready` and the slice validator: a slice whose work order has `serves` shows the outcome IDs in the spec's header line the Factory already writes, and nothing else changes for the Factory.

## The conversation (instructions for the model, a new reference file)

`skills/product-studio/references/shape.md`: how to explore an idea (open questions, one at a time, in the person's words; look facts up with sub-agents and record them with `idea lookups`, never ask them), how to write the brief in the grammar (never invent an outcome or a measure; an unknown is an open question; anything the person did not confirm is an assumption marked as such), how to write the case as the customer would hear it and find the hardest questions (who would not want this; what it costs if an assumption is wrong; the smallest version worth shipping; what would make us stop), and the rules: never recommend a verdict, never size or route by judgement (the script does), propose a map only after `idea size`.

## The app

After the engine: host operations for every command above, typed client, fixtures from the real engine for every state in the sketch, routes and empty pages; then the six screens of the sketch, one engineer each, built with the frontend-design skill and the style guide. The sketch is the visual brief; where the engine as built differs from the sketch, the engine wins and the screen says what is true.

# M15: neighbouring flows at verification, and review noise (as built)

Two small practices taken from an AI-native development playbook: the verifier exercises "the changed behavior and the two nearest neighboring flows", and review separates important findings from nits, caps the nits, and lets people rate findings. Both are built on what MACH already had: the shipped rules of M13, the verify station's records, and the review station's findings.

## 1. Neighbouring shipped scenarios at verification

### What was built

- `skills/verify/scripts/neighbours.py`, beside `verify.py`. A pure `choose()` and a `find()` that reads the shipped specs.
- `verify.py start` asks it for up to `verify.neighbours` scenarios (new setting in `templates/config.json`, default 2, `0` switches it off, anything else unusable reads as 2 with a note). Each chosen scenario becomes a required item `NEIGHBOUR-N`, of kind `neighbour`, in `prove`, with the slice, the scenario ID, its title, its Given/When/Then steps quoted from the shipped spec and the reason it was chosen. It is recorded with `record` like any scenario: evidence captured in this run, hashed, never the builder's test log.
- The choice (which, why, the integration commit, the epic, what was left out and why) is kept in `results.json` (`neighbours`) and in `summary.json` (`neighbours`, with each check's result, and `neighbour_failures`).
- A neighbour that fails is a failed check worded on its own: `NEIGHBOUR-2: a shipped scenario of SLICE-002 (AC-01) no longer holds: <note>`. The verdict is `FAIL_WITH_EVIDENCE` and the ticket goes back to the build station like any failed verification (one judging round). `findings.md` gains a section, "A shipped scenario no longer holds", that says plainly: either the change broke shipped behaviour (the builder fixes the code, never the shipped scenario, its tests or the spec), or the spec should have declared an effect on that rule, which is the product manager's decision.
- The review packet gains `neighbours` (only when there were some), marked `for_seat: product` (or the one general seat of a Low panel): each check, why it was chosen, its result and the commit. The product checklist and the reviewer brief say how to read it.
- The change record (merge station) lists them under the verification run: "Shipped scenarios of neighbouring slices proven again, read at commit ...", one line each with the reason and the result.

### The rule (deterministic, never the model's)

At the integration branch's local head (the commit `run.py current` reads), among shipped slice specs:

1. A slice one of whose rules this spec `changed`, `replaced` or `retired` in `## Effects on shipped behaviour` is left out whole: its old scenarios may rightly fail.
2. A scenario that covers a rule this spec lists as `kept` is skipped: this slice's own scenario already proves it. Other scenarios of that slice stay candidates. (The brief read "scenarios of slices whose rules this spec lists as kept ... skip them"; skipping per scenario rather than per slice was chosen because only the kept rule is proven by this slice, and the rest of that slice is the nearest neighbour there is.)
3. A scenario that covers a rule no longer in force (a later shipped slice replaced or retired it) is skipped.
4. Order: the slices this slice depends on (`cell.json` `product.depends_on`, from intake; in any epic, since a dependency is named explicitly), latest slice ID first; then the other shipped slices of the same epic, most recently shipped first. "Recent" is slice ID order, the same order the current-behaviour view uses for "later" (`current.order`), because landing order would need a walk of history and is unreliable after squash merges.
5. Round robin: one scenario per slice in that order before a second from any; within a slice, AC order. Stop at the limit.

The epic is the product hand-over's (`cell.json` `product.epic_id`), else the header line of the cell's spec. Decision rules (`RN`) are not re-proven: they carry no example data in a shipped spec, and the brief asked for scenarios.

### When there are none

No epic, nothing eligible, no integration branch or Git, `verify.neighbours` 0, or the helpers missing or failing (`shipped.py` and `current.py` are loaded by path and only read): nothing is chosen, `start` says why once in `neighbours_note`, and nothing else changes (`prove`, `results.json` and `summary.json` are exactly as before).

### How it is surfaced to the product manager

No new station or stop. A failing neighbour goes to the build station as findings. If the builder judges the spec should have declared the effect, it makes no change for it and says so; a person sends the ticket back to planning with the existing `/mach replan <ticket> "<why>"`, where the contract engineer puts the question to the product manager with the existing `cell.py spec-question`, and the ticket waits at `product-answer` for a new revision. Unanswered, the three-round limit escalates the ticket to a person as usual. `cell.py spec-question` accepts only a `spec-ready` cell, which is why the replan comes first; the intent and run skills were not changed.

## 2. Review noise

### What was built

- A note may carry `"weight": "important"` or `"nit"`. A note without a weight reads as important, so every note recorded before M15 keeps its meaning; it is stored without the field, exactly as before. A blocker takes no weight; a security-class finding (with `class` or `impact`) is never a nit.
- `review.nit_cap` (new setting, default 5; a whole number of 0 or more, anything else reads as 5). `submit` keeps a seat's first N nits in the order it listed them and drops the rest, recording `nits_dropped` and `nit_cap` in the vote file (only when something was dropped). A blocker or an important note is never dropped. The packet carries `nit_cap`; the brief tells each seat to list nits most useful first.
- A dependency the security seat answers `concern` now needs a blocker or an important note naming it, not a nit (a nit could be dropped). This only tightens the existing rule.
- `findings.md` lists blockers, then "Notes: do not block" (important and unweighted), then "Nits: do not block" with "N more nits from the <seat> seat not listed". The pull request review (merge station) orders blockers, important notes, then nits, labels a weighted note (`· note · nit`), and says how many nits were not kept. The change record labels the same way and lists the count per seat.
- `review.py rate <ticket> --finding <round>/<seat>/<n> --useful|--not-useful [--by <name or role>]`: on a person's explicit word, refused inside a supervised execution. It writes the round's `ratings.json` beside the votes (who, when, the finding's seat, severity, weight and rule); the vote file is never rewritten. Rating the same finding again by the same person replaces their rating. The review skill says when to run it.
- Cleanup's run record (one compact block in `cleanup.py`): each note carries its `weight` when it had one; `finding_ratings` (round, finding, rating, seat, severity, weight, rule; never who rated) and `nits_dropped` appear only when present, so other records keep their shape. The observe station is unchanged and can use them later.
- `templates/REVIEW.md` gains "What Important means here" and "Do not report" (generated files; anything the project's CI already enforces; unrequested style preferences; problems that predate the ticket), with the cap stated.

### What does not change

No vote, threshold, veto or round rule reads a note or its weight. A vote is still REJECT exactly when there is a blocker. Tested by tallying five panels (all approve; one and two rejecting seats; a security-seat veto; a high-impact security blocker from another seat) with and without eight nits and an important note per seat, and comparing every field of the decision that the count, the veto, the exception rule and the outcome depend on.

## Not built

- Neighbours for a ticket with no epic, decision rules of neighbouring slices, and neighbours across epics other than a named dependency.
- A new stop for "the spec should have declared this effect": the existing replan and spec-question carry it.
- Any use of ratings by the observe station (it is unchanged), and any change to how reviewers are briefed from past ratings.
- No change to `skills/run/`, `skills/intent/`, `skills/observe/` or the apps.

## Tests

- `tests/test_verify_neighbours.py` (15): the pure rule (order, round robin, determinism, the three exclusions, no epic, a limit of 0, the setting); `start` with shipped specs committed on the integration branch (the chosen items, their steps from the shipped spec, the commit); finish refusing an unproven neighbour; a failing neighbour's wording, `findings.md` section and stage; a spec that changes a shipped rule; no epic, nothing eligible, the setting at 0, no integration branch, and the helper missing, each leaving `prove` and `results.json` as before; the review packet's `neighbours` for the product seat and its absence otherwise; the change record's lines.
- `tests/test_review_noise.py` (10): weight validation, an unweighted note stored as before, the default cap and the seat's order, the cap as a setting (2 and 0) never dropping a blocker or an important note, an unusable setting, `findings.md`, the tally identical with and without nits across five panels, rating (kept beside the round, the vote file byte for byte unchanged, replace by the same person, refusals, refused unattended), cleanup's run record, and the pull request text and change record.
- The existing suites pass unchanged (`make test`).

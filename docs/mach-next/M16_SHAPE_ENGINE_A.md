# M16 part A, as built: Shape's engine (ideas, the brief, the case, the verdict, GitHub)

Built 2026-11-20 against `M16_DESIGN.md` part A, under the decisions in `M16_SHAPE_SKETCH.md`. Product Studio's terminal engine only: no host operation, no screen, and not the conversation's instructions (`references/shape.md`, written by another engineer at the same time). Part B (`shape_route.py`: sizing and routing, the map and apply, change what exists, look back, the chain) is not built; this note gives it the functions it needs.

## What was built

| File | What |
|---|---|
| `skills/product-studio/scripts/shape.py` | New. The engine: the record's shape check, the `Ideas` storage class, the brief's check and revisions, the verdict and whether it holds, sources and lookups, publishing and reading back from GitHub, the board, the command handlers, three hooks and `add_commands`. |
| `skills/product-studio/scripts/validate_brief.py` | New. The pure validator of the brief's grammar and the case's. Also a script: `validate_brief.py brief <file> [--shipped <json>] [--removed O-2,A-1]`, `validate_brief.py case <file> [--brief <file>]`. |
| `skills/ticket/scripts/issue_rules.py` | One block at the end, `# ---- Shape: an idea as an issue (M16 part A) ----`: the labels, the body template and its strict parser, the verdict comment and its parser, the one state label. |
| `skills/product-studio/scripts/issues.py` | One call, `set_idea_state` (add one idea state label, remove only the other idea state labels), and `IDEA_STATES`. |
| `skills/product-studio/scripts/studio.py` | Wiring only (below). |
| `skills/run/scripts/intake.py` | Two lines: `product/ready/IDEAS/` is skipped before anything in it is read, as `PRINCIPLES` is. |
| `tests/test_mach_shape_brief.py`, `tests/test_mach_shape.py` | New: 22 and 20 tests. |
| `tests/test_mach_product_isolation.py`, `tests/test_mach_product_studio.py`, `tests/test_logins.py` | Extended (below; `test_logins` now also holds that `shape.py` keeps no copy of the login rule). |

### Lines added to `studio.py`

```python
import shape  # noqa: E402                                                                      # with the other imports
        **shape.status_field(sys.modules[__name__], studio),  # M16 A: ideas by stage             # describe(), after prd's
    waiting += shape.not_saved(sys.modules[__name__], studio)  # M16 A                           # saved_state()
        **shape.refresh_field(sys.modules[__name__], studio),  # M16 A                            # cmd_refresh()
    shape.add_commands(sub, sys.modules[__name__])  # M16 A                                       # end of build_parser
```

and `idea,brief,case,verdict` in the top-level `metavar`. Each hook gives nothing at all when the workspace has no idea, so a project that never opens Shape reports, refreshes and calls GitHub exactly as before.

## Storage

In the draft workspace (git-ignored), beside `product/epics` and `product/slices`:

| File | Holds |
|---|---|
| `product/ideas/IDEA-NNN.json` | The record. |
| `product/ideas/IDEA-NNN.lookups.json` | What was looked up: identifiers, and each note bounded and redacted. |
| `product/briefs/IDEA-NNN.md` | The brief, written by the conversation in its grammar. |
| `product/briefs/IDEA-NNN.case.md` | The case. |
| `product/ready/IDEAS/IDEA-NNN/` | Without GitHub: `idea.json` and `brief.md`. |

Outside the draft, machine-local like `issues.json`: `.factory/studio/ideas.json`, Studio's record of what reached GitHub (`repository`; per idea `saved`, `number`, `published` {revision, brief_sha256, label, verdict, at}, and `run` with its steps while a save is under way; `seen` from the last read: each idea issue's marker, state and idea labels, and whether the verdict comment was found).

`product.py`'s structural check reads only the project, epics and slices, so none of this affects `studio.py validate`.

### The record

```json
{"schema_version": 1, "idea_id": "IDEA-019", "title": "Let members renew a loan themselves", "stage": "decided",
 "source": {"kind": "request", "repository": "acme/library", "number": 57},
 "created": "2026-11-20T10:00:00Z", "revision": 3,
 "brief": {"sha256": "<hex>", "passes": true, "checked_at": "2026-11-20T11:00:00Z", "ids": {"O-1": "present", "O-2": "present", "A-3": "removed"}},
 "verdict": {"decision": "go", "reason": "Members ask for it at every desk.", "by": "ada-pm", "at": "...", "brief_sha256": "<hex>", "revision": 3},
 "route": null, "made": null, "lookback": null, "issue": {"number": 812, "state": "open"}}
```

- `source.kind` is `typed`, `idea` (an idea-template request), `request` or `fault` (`ticket`: `AUTO-...`). Identifiers only, never issue text.
- `revision` counts the distinct brief texts a check has seen, from 0 (no brief yet).
- `brief` is Part A's own (the contract did not name it): the last checked text's SHA-256, whether it passed, and the O-N and A-N IDs ever written, each `present` or `removed`.
- `route`, `made` and `lookback` are Part B's. Part A never writes them and checks only their shape: `route` {route: one-slice|epic|several-epics, counted: {...}, why, at, revision?}; `made` {epics: [EPIC-NNN], slices: [SLICE-NNN]}; `lookback` {outcomes: {O-N: {result: met|not-met|too-early, note, by, at, comment?}}, assumptions: {A-N: {result: confirmed|wrong|unknown, ...}}}. Any other field is refused; Part B adds a field by adding it to `RECORD_KEYS` and `record_problems`.

## The brief's grammar, as checked

The contract's grammar, made exact:

- The first non-blank line is `# Brief: <title>`. The sections are `## ` headings, exactly these names, in this order: Problem, Who has it, Outcomes, Not doing, Assumptions, Open questions, Risks, What it touches. Any other heading, a repeated section, text outside a section, or a section out of order is an error.
- Required: Problem, Who has it, Outcomes, Assumptions, What it touches. Not doing, Open questions and Risks may be left out. `None.` answers Not doing, Assumptions, Open questions and Risks, and the shipped-rules line; never Problem, Who has it or Outcomes.
- Outcomes: `- **O-N:** <text>` then `  - How we would know: <text>`. Assumptions: `- **A-N:** <text> (assumed, not confirmed)` or `(confirmed by <who> on YYYY-MM-DD)`. IDs are `O-1`, `A-12` (no leading zero).
- What it touches: `- Capabilities: Lending (EPIC-001), Member account` (at least one name, each optionally with its epic) and `- Shipped rules: SLICE-NNN/FR-NN, SLICE-NNN/INV-NN, SLICE-NNN/RN` or `None.`.

Errors: `brief-title`, `brief-heading`, `brief-duplicate-section`, `brief-section-order`, `brief-stray-text`, `brief-missing-section`, `brief-empty-section`, `brief-outcome-line`, `brief-outcome-how` (none, empty, or a stand-in such as "not written yet" or "TBD"), `brief-malformed-id`, `brief-duplicate-id`, `brief-id-reused`, `brief-assumption-line`, `brief-assumption-state`, `brief-capability`, `brief-touches-line`, `brief-rule-not-shipped`, `brief-rule-not-in-force`, `brief-technology` (in an outcome), `brief-placeholder` (a template's `<...>` left in), `brief-secret` (kinds only, never the value), `brief-line-length`.

Warnings, never errors: `brief-open-question` (each one still open), `brief-how-vague` (no number and none of a fixed list of measure or change words), `brief-technology` (outside an outcome), `brief-hidden-assumption` (guess words such as "probably" or "we assume" in the prose, or an assumption's own words stated in it), `brief-id-order`, `brief-duplicate-rule`.

The technology words are `validate_slice.implementation_words`, the check principles use. The secret shapes are `scan.secrets_in_text`. Both are loaded from the intent skill, never copied. The shipped rules are an input (Studio passes its own read of the integration branch, `studio.shipped()["rules"]`), as the slice validator's are.

## The case's grammar

```
# Case: <title>
## As the customer would hear it
<one to six sentences>
## Hard questions
- **Q-1:** <question>
  - Answer: <the product manager's answer>
- **Q-2:** <question>
  - Not answered: <why>        (or "  - Not answered.")
```

Errors: `case-title`, `case-heading`, `case-missing-section`, `case-sentences` (none, `None.`, or more than six), `case-empty-section`, `case-question-line`, `case-answer-line` (two answers), `case-unanswered` (no answer line, or an empty Answer), `case-malformed-id`, `case-duplicate-id`, `case-secret`, `case-placeholder`. Warnings: `case-unknown-id` (names an O-N or A-N the brief does not hold), `case-technology`, `case-id-order`.

## Commands

| Command | What it does |
|---|---|
| `idea add "<title>" [--from-request N \| --from-issue N \| --from-fault AUTO-...]` | The next free `IDEA-NNN`, stage `new`. A request or idea-template issue must be in the request cache and count (accepted, not the Factory's); `--from-issue` also needs the idea template. A request already started as an idea is refused. A fault is named by its ticket's ID only. Nothing is written to the request's issue. |
| `idea list` | The board: every idea with its stage, verdict, GitHub state and next step; `by_stage` and `counts`. |
| `idea show <IDEA>` | The record, the source's text fenced as data (`<<<REQUEST-DATA ...>>>`, the five parts of an idea-template issue, or `<<<FAULT-DATA ...>>>` from `.factory/inbox/<ticket>.json` when this computer has it), the lookups fenced (`<<<SHAPE-LOOKUPS-DATA ...>>>`), the brief's and case's checks, and the verdict. Changes nothing. |
| `idea stage <IDEA> exploring` | Only from `new`. |
| `idea lookups <IDEA> --from <json>` | Replaces the lookups. `{"shipped_rules": [{"rule", "note"}], "similar": [{"idea": "IDEA-NNN"} or {"request": N}, "note"], "principles": [{"id": "PP-NN", "note"}], "policies": [{"id": "POL-pack" or "POL-pack-NN", "note"}]}`. Every rule must be on the integration branch (its `in_force` and epic are recorded), every idea here, every request in the cache, every principle and policy in the project's. Notes are cut to 300 characters on one line and redacted. All or nothing. |
| `brief check <IDEA>` | Checks the brief. A text not seen before is the next revision. The stage follows (below). |
| `brief show <IDEA>` | The text, its model, its check, and the verdict as it stands. Changes nothing. |
| `case show <IDEA>`, `case check <IDEA>` | The case and its check (check leaves the text out). Change nothing. |
| `verdict record <IDEA> --decision go\|not-now\|no --reason "..."` | Checks the brief first. `go` needs a brief that passes; `not-now` and `no` need none. The reason is one line of at most 500 characters, holding no secret and no `<!--`. `by` is the signed-in GitHub login (through Studio's channel: GitHub or the folder, a passing failure refuses). Replaces an earlier verdict; refused once the idea is shaped. |
| `idea publish <IDEA>` | Saves to GitHub or the folder (below). |
| `idea renumber <IDEA>` | An idea never saved takes the next free number; its brief, case and lookups move with it. |
| `status` | `ideas`: the board and a note, only when there are ideas. `saved.not_saved` gains `idea_unfinished` and `idea_changed`. |
| `refresh` | `ideas`: the idea issues read back (read only), and `changed_on_github` for any changed after it was saved, with `after_verdict`. Only when there are ideas here or one was ever saved. |

### Stages

`new` (added) → `exploring` (by hand) → `brief` (a check passes) → `decided` (a verdict is recorded) → `shaped` (Part B). A check that fails moves `brief` back to `exploring`. A check of a brief changed after its verdict moves `decided` back to `brief` (or `exploring` if it fails): the verdict no longer holds. `shaped` never moves back here.

### The verdict

Saved with the brief's SHA-256 and revision. It holds while the brief's text is exactly that one (both absent counts, for a `not-now` or `no` given before any brief was written). `verdict_view` says `holds`/`stale` and why; status, `idea show`, `brief check` and the board all carry it. The engine never chooses, scores or recommends one; the test suite looks for the word in every report.

## GitHub

`idea publish` uses Studio's channel (`Handoff.channel()`): GitHub when gh is installed, signed in and `origin` is on GitHub, else the folder, decided before anything is written; a passing failure refuses. The brief must pass its check first.

On GitHub, one issue per idea, titled `IDEA-NNN: <title>`, labelled `mach:idea` and exactly one state label: `mach:idea-new`, `-exploring`, `-brief`, `-go`, `-not-now`, `-no` or `-shaped` (`issue_rules.shape_state_label`: shaped; else the verdict while it holds; else brief; else where it stands). The body is `issue_rules.shape_issue_body`: a hidden marker (`<!-- mach:shape idea=IDEA-NNN revision=N brief-sha256=<hex|none> [from=request:#N|idea:#N|fault:AUTO-...] -->`), one fixed sentence, then the brief exactly (or a fixed line when there is none). The verdict, when it holds for the brief being saved, is one comment from `issue_rules.shape_verdict_comment`: the login, the idea, the revision, the decision, the reason (cleaned, redacted, bounded, mentions and issue references broken, no marker can survive), the SHA-256, and `<!-- mach:idea-verdict id= revision= decision= by= brief-sha256= -->`.

Steps, each recorded in `ideas.json` before it is tried and looking before it writes: `labels` (create `mach:idea` and the state label if missing), `issue` (create; or view, refuse if it no longer carries `mach:idea`, rewrite only if title or body differ), `state` (add the label, remove only the other idea state labels), `verdict` (post unless the signed-in account already left this exact verdict). An answer lost after a create is recovered from the list by the marker (same idea, revision and brief) while the run's `issue` step is `trying`. Another issue holding this idea's ID refuses before anything is written, and `idea renumber` settles it. A verdict recorded by another account, or recorded without a sign-in, is refused before anything is written: the verdict is recorded again by the person deciding. A changed brief replaces the body and the label; the earlier verdict comment stays, for the earlier brief.

Without GitHub: `product/ready/IDEAS/IDEA-NNN/idea.json` (identifiers, title, revision, the brief's SHA-256, the state label, the verdict while it holds) and `brief.md`. A slice already on GitHub never falls back to the folder, and the same holds for an idea.

`refresh` lists `mach:idea` issues (read only), records every marker it finds (so the allocator skips their numbers), reads the comments of each idea whose verdict was saved, and flags an issue whose body was edited (not intact) or holds another brief than the one saved: `changed_after_verdict` when a verdict was published. It notes a closed issue in the record's `issue.state`. Publishing again puts the saved brief back.

The case is never published: it is the product manager's working, in the workspace only.

## Nothing reaches the Factory

- Idea issues carry only `mach:idea` labels: intake reads `mach:ready` and `mach:slice`, never these.
- `intake.py` skips `product/ready/IDEAS/` before reading anything in it, so a committed folder is neither taken in nor listed as not accepted.
- `shape.py` never calls `start_slice`, `add_epic`, the ticket station or a cell; `factory_authorized` is false in every report.
- `tests/test_mach_shape.py` `FactoryTest` publishes an idea and commits its folder, runs the Factory's intake, and finds no idea text, ID or label anywhere under the engineer's `.factory/`.

## For Part B (`shape_route.py`)

Import `shape` (it is beside `studio.py`; `studio` is passed in as `host`, never imported). Everything below takes the `Ideas` object, `shape.Ideas(host, studio)`.

```python
class Ideas:
    ids() -> List[str]                         # sorted IDEA-NNN
    exists(idea_id) -> bool
    load(idea_id) -> Dict                      # refuses (ShapeError) a missing or malformed record
    save(record) -> None                       # refuses a record that fails record_problems
    all() -> Dict[str, Dict]                   # every readable record
    held(idea_id) -> context manager           # one writer per record; wrap load-change-save in it
    next_id() -> str
    brief_text(idea_id) / case_text(idea_id) -> Optional[str]
    lookups(idea_id) -> Optional[Dict]         # {shipped_rules: [{rule, in_force, epic_id, note}], similar, principles, policies, recorded_at, shipped_commit}
    save_lookups(idea_id, data) -> None
    brief_path / case_path / lookups_path(idea_id) -> Path
    load_ledger() -> Dict                      # what reached GitHub: {"ideas": {IDEA: {saved, number, published, run}}, "seen": {...}}

new_record(ideas, title, source, idea_id=None) -> Dict      # `idea change`: a new idea, saved; source e.g. {"kind": "typed"}
check_lookups(ideas, raw) -> (Dict, List[str])               # validate lookups before save_lookups (prefill for `idea change`)
brief_check(ideas, record) -> {exists, sha256, passes, errors, warnings, findings, model}   # records nothing
record_check(ideas, record, check) -> bool                   # revision, ids and stage from a check; save the record if True
brief_model(ideas, idea_id) -> Optional[Dict]                # model + sha256, passes, revision, revision_current
    # model: {title, problem, who_has_it, outcomes: [{id, text, how_we_would_know, line}], not_doing,
    #         assumptions: [{id, text, state: assumed|confirmed, confirmed_by, confirmed_on, line}],
    #         open_questions: [str], risks, touches: {capabilities: [{name, epic_id}], shipped_rules: [SLICE-NNN/FR-NN]}, sections}
verdict_holds(record, brief_sha256) -> bool
verdict_for(ideas, idea_id) -> {decision, holds, stale, revision, brief_sha256, by, at, reason, ...}
require_go(ideas, idea_id) -> record                         # refuses unless Go holds for the brief now and it still passes
current_brief_sha(ideas, idea_id) -> Optional[str]
github_view(ideas, ledger, record) -> {saved, issue, url, state, up_to_date, changed_on_github, ...}
comment_once(ideas, idea_id, name, text, already) -> {posted, issue?, why?}
    # the look-back comment: posts `text` once on the idea's issue; `already(bodies)` gets the signed-in account's
    # comment bodies and says whether it is there. {posted: False, why: not_on_github|github_not_here|already_there}
record_problems(record, rules) -> List[str]                  # rules = host.ticket_rules(); RECORD_KEYS, ROUTES, OUTCOME_RESULTS, ASSUMPTION_RESULTS, STAGES
ShapeError(message, app=None)                                # the handlers turn it into Studio's refusal
add_commands(sub, host) -> {"idea": <the idea subparsers>, "run": <handler wrapper>}
```

Wiring Part B: in `build_parser`, `shape_route.add_commands(sub, shape.add_commands(sub, sys.modules[__name__]), sys.modules[__name__])`, adding `size`, `map`, `settle`, `map-status`, `apply`, `change` and `chain` to the returned `idea` group (wrap handlers with the returned `run`) and its own top-level `lookback`. To mark an idea shaped: under `ideas.held(idea_id)`, `load`, set `stage = "shaped"` and `made`, `save`. The next `idea publish` moves the issue's label to `mach:idea-shaped`. Part B's look-back template belongs in the same `issue_rules.py` block.

## Choices where the contract was silent, and departures

1. **`idea renumber`** is a command the contract does not list. Without it, an idea whose number another product manager's idea already holds on GitHub (the allocator only knows GitHub's numbers from the last read) could never be published.
2. **The revision** counts distinct brief texts seen by a check (`brief check`, and the checks `verdict record` and `idea publish` run first), from 0. The brief is a file the conversation edits freely, so there is no other moment a revision is made.
3. **IDs are recorded only from a passing brief.** A broken edit (an Outcomes section that does not parse) never marks every outcome removed. An ID present in one passing revision and absent from a later one is `removed` for good.
4. **The record gains `brief`** (last checked SHA-256, passes, the ID registry), beyond the contract's fields.
5. **The stage moves back**: a failing check takes `brief` back to `exploring`, and a stale verdict takes `decided` back to `brief`. The contract's stages follow from acts; this keeps the board true.
6. **`go` needs a passing brief; `not-now` and `no` need none**, so an idea can be said no to as soon as it arrives ("nothing is lost by saying no"). The case's check is not required for any verdict: the contract requires only the brief.
7. **A verdict recorded without GitHub** (folder form, gh not signed in) has `by: null`. It is saved to the folder as it is, but publishing it to GitHub is refused until the person records it again signed in, so no comment ever names someone who did not record it.
8. **Recording a verdict needs GitHub reachable when gh is set up**, because the login is read then; a passing failure refuses, as `slice ready` does.
9. **A verdict can be replaced**, and the earlier comment stays on GitHub; once shaped, the verdict stays.
10. **The state labels name the verdict** (`mach:idea-go`, `-not-now`, `-no`) instead of one `decided` label, and a stale verdict shows `mach:idea-brief`: the label says what holds for the brief on the issue.
11. **The idea's issue is new**, even when it came from a request or an idea-template issue: Studio never edits or labels an issue without MACH's own labels, and adds none to a request's. The marker carries the origin's number; the body names nothing, so the request is not notified.
12. **The case is not published**, to GitHub or the folder; the contract names the brief and the verdict only.
13. **The folder** holds `idea.json` and `brief.md`, written in place (no temporary folder: Shape's scripts use no `shutil`).
14. **`issues.set_idea_state`** is the one new GitHub call: it removes labels, so `test_the_hand_off_uses_only_the_gh_calls_it_is_meant_to` was changed to allow it and to hold that it refuses any name outside `IDEA_STATES` first.
15. **`intake.py` was touched** (two lines) so a committed `product/ready/IDEAS/` is never read or listed by the Factory.
16. **Refresh reads idea issues only when this workspace has ideas or saved one**, so a refresh without Shape makes exactly the calls it made before.
17. **Fault text** is shown from `.factory/inbox/<ticket>.json` when this computer has it (the engineer's machine); the record holds the ID only.
18. **No new `next_actions` kind**, as with the PRD on-ramp: each idea's `next` carries a `kind` and a sentence.

## Not built

- Part B: `idea size`, the map and apply, `idea change`, `lookback record`, `idea chain`, and the `serves` header line on `slice ready`.
- The conversation's instructions (`references/shape.md`) and the SKILL.md pointer: another engineer's.
- The visual app: no host operation and no screen.
- No JSON schema file for the idea record under `docs/mach-next/schemas/`.
- No reconcile for an idea someone else published a newer version of: two product managers shaping the same idea is not handled beyond `number_taken` and `changed_on_github`.

## How far it is tested

- `tests/test_mach_shape_brief.py` (22): every validator rule above, one at a time on an otherwise passing fixture brief and case; `None.` and absent optional sections; the script reading only; the issue body round trip, CRLF and a dropped newline, edits caught, other bodies refused, the builder's refusals; the verdict comment's hash and login and a reason that tries to forge a marker or mention someone; the one state label; `issues.IDEA_STATES` equal to the shared labels.
- `tests/test_mach_shape.py` (20), through `studio.main` in temporary Git projects with the stand-in for gh from `test_mach_product_issues`: add, list, show, stage and their refusals; status without ideas unchanged; from a request (identifiers only, text fenced and redacted), from an idea-template issue (its five parts), refusals (not the template, not accepted, unknown, twice), no GitHub call; from a fault, with and without the inbox record, fence marks neutralised; lookups refused for each kind of unknown ID and recorded all or nothing; revisions, a failing check, an ID removed and refused when it comes back; the verdict without a brief, going stale when the brief changes, the stage following, refusals of reasons; `route`, `made` and `lookback` left untouched and checked for shape; the case; publishing (one issue, its labels, body and verdict comment, the checkout untouched, only the expected writes, a second publish writing nothing); a changed brief replacing body and label but not the comment; an answer lost on create and on the comment, and a failure before the comment, finished with one issue and one comment; GitHub unreachable writing nothing and never falling back to the folder; the folder form and a login-less verdict refused on GitHub later; an issue without its label left alone; another product manager's same number refused and renumbered; refresh making no idea call without ideas, flagging a body edited after its verdict, a removed verdict comment and a closed issue, and without GitHub; app wording of refusals and status sentences; and the Factory's intake taking nothing from an idea issue or a committed `product/ready/IDEAS/`.
- `tests/test_mach_product_isolation.py`: `shape.py` and `validate_brief.py` held to `studio.py`'s import and Git rules; `shape.py` reaching GitHub only through exactly ten `issues.py` calls and Studio's channel, its publish writing only the fixed body and verdict templates, its refresh only reading, and naming none of the Factory's labels; the validator pure; neither ever authorizing.
- `tests/test_mach_product_studio.py` `AppWordingTest`: `shape.py` and `validate_brief.py` added whole to the modules whose every readable string either names no command or is the terminal's half of `say()`, with Shape's commands added to the pattern.
- Not tried: the conversation with a real model, real GitHub, and the visual app.

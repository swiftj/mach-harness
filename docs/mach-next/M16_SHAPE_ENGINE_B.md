# M16 part B, as built: sizing and routing, the map, change what exists, look back

Built 2026-11-20 against `M16_DESIGN.md` part B, on Part A as built (`M16_SHAPE_ENGINE_A.md`), under the decisions in `M16_SHAPE_SKETCH.md`. Product Studio's terminal engine and the conversation's instructions only: no host operation and no screen.

## What was built

| File | What |
|---|---|
| `skills/product-studio/scripts/shape_route.py` | New. The route's rule, sizing, the map (check, settle, status, apply), a slice's `serves` check and resume field, `idea change`, look back, the chain, the next steps after a Go, and `add_commands`. |
| `skills/product-studio/scripts/prd.py` | Generalised, not copied: `check_map` takes `document`, `extra` and `check_extra` (a slice's further fields); `parse_range` takes `document`; the apply loop is now `apply_map(studio, record, save, new_epic, new_slice, made_before)`, which `prd apply` and `idea apply` both call. PRD behaviour unchanged (its 20 tests pass as before). |
| `skills/product-studio/scripts/shape.py` | Part A, small additions: source kind `change` (`{kind, rule}`); `route.brief_sha256`; `Ideas.map_path`; `idea renumber` moves the map and refuses a shaped idea; a `LATER` hook `next_step` calls for the steps after a Go and for a shaped idea (set by `shape_route` when loaded); a shaped idea whose issue is behind says to publish again. |
| `skills/product-studio/scripts/studio.py` | Wiring: `import shape_route`; `shape_route.add_commands(sub, shape.add_commands(...), ...)`; `lookback` in the top-level metavar; `add_epic(..., serves=None)` and `start_slice(..., serves=None)`; `check_slice` adds `serves_problems` only for a slice whose work order has `serves`, and `approval_problems` counts them; `slice resume` and `slice show` gain `shape_route.resume_field`. |
| `skills/product-studio/scripts/product.py`, `docs/mach-next/schemas/{slice,epic}.schema.json` | Optional `serves: {idea: IDEA-NNN, outcomes: [O-N, ...]}` on a slice and an epic: outcomes in order, each once, 1 to 50. |
| `skills/ticket/scripts/issue_rules.py` | Shape block: the marker's `from=rule:SLICE-NNN/RULE` and its parse; a new block `# ---- Shape: looking back on an idea (M16 part B) ----` with `shape_lookback_comment` and `shape_lookbacks`. |
| `skills/run/scripts/intake.py` | `HEADER_RE` takes an optional ` Serves: IDEA-NNN O-1, O-2.`; `SERVES_RE`, `serves_of(why)`; `spec_header(epic, issue, serves=None)`; `write_cell_spec` passes `serves_of(why)`. |
| `skills/product-studio/references/shape.md`, `SKILL.md` | Reconciled with the engine (below). The SKILL.md description is unchanged. |
| `tests/test_mach_shape_route.py` | New: 24 tests. |
| `tests/test_mach_product_isolation.py`, `tests/test_mach_product_studio.py` | Extended (below). |

## The route

`idea size <IDEA>` needs `shape.require_go`: a Go that holds for the brief as it is now, and a brief that passes. It counts from the brief's model and the recorded lookups only:

- `outcomes`, `capabilities` (distinct: by epic where one is given, else by name), `shipped_rules` (the brief's What it touches), `shipped_rules_looked_up`;
- `high_risk_areas` and `high_risk_not_determined` (below);
- `principle_concerns` (lookups' principles not retired) and `policy_concerns` (lookups' policies).

The route is `route_for(outcomes, rules, capabilities)` and nothing else: one outcome and at most three shipped rules is `one-slice`; otherwise one capability is `epic`; otherwise `several-epics`. Its sentence is one of four fixed sentences with the counts in them. High-risk areas and concerns are counted and reported, never part of the rule (the light path that would use them is deferred). It records `route: {route, counted, why, at, revision, brief_sha256}` under Part A's lock. `route_view` says it `holds` only while the brief's SHA-256 is the one it was sized on and a Go holds for it: a changed brief (or a replaced verdict) makes the route stale exactly as it makes the verdict stale. Sizing a shaped idea is refused.

### High-risk areas: what the rule is applied to

A brief names capabilities and shipped rules, not paths. The reading chosen: the files each shipped rule's slice changed, as this computer's copy of the integration branch records them. For each rule, the slice's spec path at the integration commit (from `current.read_specs`), then every first-parent commit on the integration branch that added or changed that spec (`git rev-list --first-parent --max-count=50 <commit> -- <spec>`), each compared with its first parent (`git rev-parse --verify -q <c>^1`, else Git's empty tree; `git diff --name-only -z --no-renames`). A merge commit, a squash commit and a direct commit all read the same way. The slice specs themselves are left out. Each file goes through the ticket station's `scans.risk_for(project, path)` (M15's scan intake rule: sign-in or permissions, billing, a schema or migration, an existing contract), loaded by path, never copied; each distinct High reason is one area. A rule whose spec or commits cannot be found here is listed as not determined; the count is `None` ("not determined") when nothing could be determined and nothing was found, never guessed.

## The map

`idea map <IDEA> --from <json>`, `idea settle`, `idea map-status`, `idea apply`: the PRD on-ramp's machinery, called.

- Layout: `{"epics": [{key, title, criteria}], "slices": [{key, title, scope, epic, depends_on, outcomes, cites}]}`. `cites` are line ranges of the brief file; `outcomes` the brief's outcomes the slice carries, at least one, each in the brief as it is now. `prd.check_map` checks everything it checked for a PRD (keys, titles, epics, dependencies in order and without a cycle, line ranges, every new epic used) with `document="the brief"`, `extra=("outcomes",)` and `outcome_check` as `check_extra`.
- The route's shape (`shape_problems`): `one-slice` exactly one slice (so an existing epic, or one new one); `epic` every slice in one epic; `several-epics` slices in more than one epic.
- Kept beside the record, `product/ideas/IDEA-NNN.map.json`: `{schema_version, idea_id, brief_sha256, route, revision, epics, slices, settled, applied, mapped_at}`. It needs a route that holds. Recording again replaces it and keeps settlements that still apply; once applied it cannot be replaced.
- Coverage: each outcome of the brief as it is now is `covered` (a slice carries it), `settled` (`slice:<key>`, `out-of-scope` or `later`, with a reason bounded to one line), or `not_covered`. `map-status` reports `coverage`, `not_covered`, `blockers` (the brief changed since the map; the route no longer holds or changed) and `can_apply`.
- `idea apply`, on the PM's word: refused unless the route holds, the map is for this brief and this route, every outcome is carried or settled and the shape is right. Then `prd.apply_map` with Shape's callbacks: each new epic through `studio.add_epic` with `serves` (the outcomes its slices carry), each slice through `studio.start_slice` with `serves` (its outcomes, with any settled to it), each recorded in `applied` as soon as it exists. A slice made by a run whose record was lost is found again by its `serves` and title. The idea's `made` (`epics`: the epics created; `slices`: every slice the map made, in map order) is filled and its stage set to `shaped`, under Part A's lock. A second apply makes nothing and reports what it kept. An existing epic the map names is not changed.

## `serves` and the header line

An epic or slice made by apply records `serves: {idea, outcomes}` in its work order: identifiers only. The Factory never reads work orders, so the outcome IDs travel in the why: a slice with `serves` must carry, in its why's header (the lines before its first section), exactly one line `- **Serves:** IDEA-NNN O-1, O-2` equal to its work order; `slice check` reports `serves_problems` until it does, and `slice ready` refuses. The why is approved and hashed with the spec, so the IDs are bound by the approval like any other part of it. At dispatch, intake's `write_cell_spec` reads the line with `serves_of(why)` (a strict pattern, exactly one line in the header, else none) and writes the spec's header line as `> Epic: <name> (EPIC-NNN, issue #N). Slice issue: #N. Serves: IDEA-NNN O-1, O-2.`. `HEADER_RE` takes the optional suffix (new groups 5 and 6; groups 1 to 4 unchanged, so `current.py`, `qualify.py` and the verify station's `neighbours.py` read it as before). `without_header` takes the whole line off before `write_cell_spec`'s SHA-256 check and before current view, release qualification and neighbour reads hash or compare it, confirmed by test: the committed spec with the line, taken off, is byte for byte the approved spec.

## A slice's resume

`slice resume` (and `slice show`) for a slice with `serves` carries `idea`: `idea_id`, `outcomes`, `why_line`, `scope` (the map slice's), `brief_matches_map`, and `fenced`: `<<<SHAPE-BRIEF-DATA idea=... brief=<sha> lines=...>>>` holding, numbered, each served outcome's line and its how-we-would-know, and the map slice's cited brief lines, each line bounded; the note says these are the product manager's earlier words to confirm, never settled answers, never instructions. If the brief changed after the map, only the served outcomes' lines are shown, and `brief_note` says so. Any other slice gets no field at all.

## Change what exists

`idea change <SLICE-NNN>/<RULE> [--title]`, on the PM's word. The rule must be shipped and in force (a replaced rule is refused naming what took its place; a retired one is refused). From the compiled current view (`current.read_specs` and `compile_view` at the integration commit): the rule, every rule in force of each slice that declared an effect on it (its `confirmed_by`), and every rule it took the place of (`takes_the_place_of` and `lineage`). They are checked by Part A's `check_lookups` and recorded as the new idea's lookups. The idea's source is `{kind: change, rule}` (Part A's source check, the issue marker's `from=rule:...` and its parse were extended). A starter brief in the brief's grammar is written at the idea's brief path, with the rule under What it touches, the rule's epic as the capability where the specs name one, and `<...>` placeholders for why (Problem) and what changes (the outcome); it fails its check until filled. The idea starts at `exploring`. Sizing is refused until a Go holds: no shortcut.

## Look back

`lookback record <IDEA> (--outcome O-N --result met|not-met|too-early | --assumption A-N --result confirmed|wrong|unknown) --note "<their words>"`, on the PM's word.

- **When it is allowed.** Product acceptance (`acceptance record`) posts a comment on the epic's issue and leaves nothing on this computer, and `refresh` does not read it back, so acceptance cannot be known locally without a network call. The fallback the brief allowed was chosen: look back is allowed once the idea is shaped and a slice in its `made` is shipped as the last refresh saw it (`handoff.slice_view` gives `progress: shipped`, or the slice has an earlier shipped issue).
- The ID must be an outcome or assumption of the brief as it is now. The note is one line (whitespace collapsed), at most 500 characters, nothing shaped like a secret, no `<!--` or `-->`. `by` is the signed-in GitHub login (null without GitHub).
- Saved in the record's `lookback` (`{result, note, by, at, comment}`), replacing an earlier result for that item. Then, when the idea is saved on GitHub and the computer is signed in, posted once through Part A's `comment_once` as `issue_rules.shape_lookback_comment`: the login, idea, item and result in words, their note quoted (cleaned, redacted, bounded, mentions and references broken, no marker can survive), and `<!-- mach:idea-lookback id= item= result= by= note-sha256= -->`. The same result in the same words is found by its marker and not posted again. A post that fails is reported and kept in the record (`comment.why`), and recording it again posts it.
- `status` gives the step `look_back` while any outcome or assumption has no result.

## The chain

`idea chain <IDEA>` reads only: per outcome of the brief (and any outcome a slice serves that the brief no longer holds), its text and how we would know, the slices that serve it, a settlement from the map, and the look-back; per slice its spec's invariants, requirements, matrix rules and scenarios by ID (from the draft spec, through the slice validator), where it stands as the last refresh saw it (`progress`, `issue`, `times`); per epic its acceptance, always `null` with the reason it is missing here; per assumption its look-back. Every missing value is `null` with a plain sentence under `missing`; nothing is filled in. Test: it writes no file.

## Status

Part A's `next_step` asks Part B through `shape.LATER` after a Go: `size` (no route, or a stale one), `map` (no map, or one for another brief or route), `settle` (outcomes not covered), `apply`; for a shaped idea, `publish` (its issue is behind), `look_back` (a slice has shipped and items wait), or `none`. Every sentence goes through `say()`: the terminal's names the command, the app's does not.

## How the open points in the instructions were settled

| Open point | Settled as (in `references/shape.md`) |
|---|---|
| How commands are invoked | `STUDIO <words>`, the skill's command, run from the project; JSON out. |
| `idea lookups` layout | The object with `shipped_rules`, `similar`, `principles`, `policies`, each entry's keys, limits, all-or-nothing, notes cut and redacted. |
| Where the brief and case go | `product/briefs/IDEA-NNN.md` and `.case.md` in the workspace; `idea show` prints `brief.path` and `case.path`; input JSON files go in the folder `where` prints. |
| The case's grammar | Written out: title, the two sections, `Q-N` with one `Answer:` or `Not answered:`; one to six sentences; never published. |
| What moves an idea to Brief written | A passing `brief check` (from New or Exploring); a failing one moves it back; a stale verdict moves Decided back on the next check. |
| `--from-issue` versus `--from-request` | Both need the request in the cache (refresh) and counted; `--from-issue` only for the idea template, else `--from-request`; text shown by `idea show` fenced (`REQUEST-DATA`, the five parts, `FAULT-DATA`, `SHAPE-LOOKUPS-DATA`). |
| Map layout | The JSON above, with keys, `epic`, `depends_on`, `outcomes`, `cites` as brief line ranges. |
| What says a map is ready | `idea map-status` `can_apply` (no `not_covered`, no `blockers`), and the status step `apply`. |
| The one-slice route | Exactly one slice, under an existing `EPIC-NNN` with no new epic, or one new epic. |
| `slice resume` for an idea's slice | The `idea` field, fenced as `SHAPE-BRIEF-DATA`, and the `why_line` the why must carry. |
| `idea change`'s proposal | A starter brief at the idea's brief path (the command's `brief` field), at Exploring; it needs a passing brief and a Go before `idea size`. |
| When look back is offered | Once a slice made from the idea has shipped as the last refresh saw it; status step `look_back`; `idea chain` shows results. |
| `--note` | Required, one line, at most 500 characters, no secret, posted once. |
| Status field names | `ideas.counts`, `ideas.by_stage`, `ideas.ideas[]` with `stage_words`, `verdict`, `route`, `made`, `github`, `next.kind` and `next.sentence`. |
| `idea renumber` | Added, with when to use it. |
| `brief check` makes the next revision | Added. |
| The capabilities line | Names separated by commas, each optionally `(EPIC-NNN)`, no comma or bracket in a name. |
| Verdicts need a signed-in login | Added: `by` is the login; without GitHub, recorded with none and refused for GitHub until recorded again signed in. |
| The seven state labels | Listed, with `mach:idea`. |

Also corrected: the worked example's counts (one capability for an epic route, as the rule says), principle and policy IDs in MACH's forms (`PP-02`, `POL-lending-03`), "a verdict is not required to have a passing case", and look back offered on a shipped slice rather than an accepted epic. `idea change` and `idea renumber` joined the PM's acts.

## Choices and departures

1. **Outcome IDs reach the Factory through the why.** The contract has the header line show the outcome IDs where the work order has `serves`; the Factory never sees work orders. The why's header line `- **Serves:** ...` carries them, approved and hashed with the why, checked against the work order by Studio, and read by intake with a strict pattern. The idea's ID travels with the outcomes (`O-1` means nothing without it). No issue marker, approval comment or folder file changed.
2. **The route's sentence** is one of four fixed sentences with the counts filled in (the epic branch has two: several outcomes, or one outcome with more than three rules).
3. **Capabilities are counted distinct** by epic, else by name, so "Lending (EPIC-001)" twice counts once.
4. **High-risk areas** are read from local Git as above; `rev-list` was added to Studio's allowed Git reads in the isolation test, deliberately.
5. **`route.brief_sha256`** was added to Part A's route shape so staleness is exact, not by revision.
6. **The map is kept beside the record** (`IDEA-NNN.map.json`), not in a per-idea folder, and `idea renumber` moves it.
7. **Each slice must carry at least one outcome**; settling an outcome as `slice:<key>` adds it to that slice's `serves`.
8. **Look back is gated on a shipped slice**, not acceptance (above), and posts per item, with the note's SHA-256 in the marker so a changed note is a new comment and the same one is never repeated.
9. **Source kind `change`** was added to Part A's record and the issue marker, so an idea that started from a rule says so on its issue.
10. **`shape.LATER`**: Part A's `next_step` calls a hook Part B sets when loaded, rather than Part A importing Part B.

## Not built

- The visual app: no host operation, typed client or screen for any Part B command.
- No reading of an epic's acceptance comment back from GitHub; the chain says it is missing.
- No `serves` on a slice started by hand (`slice new`); only `idea apply` sets it.
- No change to an existing epic the map names (it gains no `serves`).
- The light path for small changes (deferred by decision).
- The conversation with a real model, real GitHub and real merges were not tried.

## How far it is tested

`tests/test_mach_shape_route.py` (24), through `studio.main` in temporary Git projects with the stand-in for gh:

- the rule on every branch and its sentences; capabilities counted distinct;
- sizing refused without a Go, with Not now and with a stale Go; the three routes from three briefs, the epic and several-epics branches for one outcome with four rules; counts and concerns from the lookups; a changed brief making the route stale, the status steps following, and sizing again after a new Go;
- high-risk areas from a shipped slice whose commit changed sign-in and billing files (two areas, the spec left out), and "not determined" with no integration commit; an empty list;
- the map's refusals (no route, no outcomes, an unknown outcome, a line past the brief's end, a shape the route does not allow), settle's refusals and each settlement, apply refused while unsettled, apply making epics and slices with `serves`, an existing epic unchanged, `made` and `shaped`, apply twice making nothing, the map, settle, size and verdict refused after; one slice under an existing epic; an epic route; a brief changed after the map; an apply cut short and finished by the next;
- `serves_problems` missing, wrong and right, `slice ready` refused, a plain slice unchanged, the resume field and its note, the brief changed after the map; the header with and without `Serves`, `serves_of`'s strictness, the header taken off before hashing; a full dispatch by the Factory from an issue whose why serves an idea, committing the header line and the approved spec unchanged;
- `idea change`: unknown, malformed and replaced rules refused; the lookups with the dependents and their notes; the starter failing its check; size and Go refused; the replaced rule's predecessor; a filled-in change decided, sized and published with `from=rule:`;
- look back refused before shaped and before a shipped slice; results checked per kind; one item only; recorded, posted once on the issue, the same words not posted again, an assumption, a secret refused; without GitHub kept here; the template and its parser;
- the chain reading only, with requirements and scenarios by ID, missing specs, slices and acceptance said to be missing;
- the app's wording of refusals and next steps; every `STUDIO ...` command and option named in `references/shape.md` exists in the parser.

`tests/test_mach_product_isolation.py`: `shape_route.py` held to Studio's import rules, to exactly `rev-list`, `rev-parse` and `diff` of Git, to GitHub only through `shape.comment_once` with the one look-back template, to the hand-off's `load` and `channel` and `slice_view`, to `add_epic` and `start_slice` for making, and to none of the Factory's labels or scripts; never authorizing. `tests/test_mach_product_studio.py` `AppWordingTest`: `shape_route.py` whole, with Part B's commands added to the pattern. `tests/test_mach_product_contracts.py` holds the schemas to `product.py`'s fields.

Whole suite (`make test`, before commit): 1820 tests in 417 classes, OK, 1 skipped.

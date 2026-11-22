# M18, as built: a small change in the app

Built 2026-11-22 against `M18_DESIGN.md` part C's last bullet and decision 4 (no new screen), on the engine in `M18_ENGINE_A.md`. Shape's fourth route, the intent station and the Factory Floor are not touched here.

## 1. Host operations (`apps/studio/internal/engine/ops_small.go`)

Each is one engine command, after `studio.py --project <root> --app`, options in `--name=value` form.

| Operation | Arguments (JSON) | Engine command | Kind |
|---|---|---|---|
| `slice.new` | as before, plus optional `small: {change: "fix", rule}` or `small: {change: "adjustment"}` | `slice new --epic= --title= [--depends-on= ...] [--id=] [--small --change=fix --rule=SLICE-NNN/FR-NN \| --small --change=adjustment]` | changes the draft |
| `request.pick` | as before, plus the same optional `small` | `request pick <n> --epic= --title= [--also] [--small --change= [--rule=]]` | may fetch, as before |
| `slice.widen` | `{slice_id, why}`; `why` at most 300 characters, not blank | `slice widen <SLICE> --why=<the PM's words>` | on the PM's word; on this computer only |

- A fix's `rule` must match the engine's pattern (`SLICE-NNN/` and `INV-NN`, `FR-NN` or `RN`; the host's `ShippedRulePattern`, the one `idea.change` already uses); an adjustment with a `rule`, a fix without one, any other `change`, any other field inside `small`, and `small` that is not an object are refused before the engine runs. Whether the rule is in force is the engine's check (`slice.new.refused-small-not-in-force`).
- A full slice's vector is exactly as before (tested).
- `slice widen --by-rule` is not an operation: no person's button names a rule. Only the conversation runs it (below).
- The kind and widening pass through `status`, `slice.resume`, `slice.check`, `slice.show` and `slice.ready` untouched: the host forwards the engine's JSON, so nothing in those operations changed.
- `apps/studio/README.md` has a "A small change (M18)" section. The e2e conformance suite's allowlist names `slice.widen`.

## 2. The conversation (`apps/studio/internal/interview/command.go`)

The slice interview, for a slice whose work order in the draft workspace says `kind: "small"` when the turn starts (read with `Lstat`, a regular file at most 1 MiB, never through a link), may also run `slice widen <its own ID> --by-rule <rule>` and `--by-rule=<rule>`, in every spelling of the script and interpreter, for exactly the thirteen rules `small-change.md` names (`small_change.rules`: `small.SPEC_RULES` and `questions`). Never a wildcard, never a plan rule (`contract`, `high-risk-file`, `adr`), never another slice. `slice widen <its ID> --why ...` and `--why=...` are denied again. A full slice's interview, the Shape conversation and the needs conversation get no widen rule. Everything else the short interview runs (`slice resume`, `slice check`, editing its spec and why) the slice interview already had; `slice new` and `request pick` stay the app's buttons (the app starts the slice before the conversation does). The host note says how a small change is widened and that the PM's own reason is their button. The activity line for it is "made this small change a full slice".

## 3. Typed client (`web/packages/ui/src/api/small.ts`, exported from `@mach/ui/api`)

`SmallStart`, `SmallOnWorkOrder`, `SmallWidened`, `SmallVerdict`, `StatusSmall`, `SliceSmallChange`, `SmallChangeResume`, `SliceWiden`, `smallChanges`. In `types.ts`: `WorkOrder.kind|small|widened`, `StatusSliceRow.kind|small`, `SliceCheck.small_change`, `SliceResume.small_change`, `SliceReady*.small_change` (all optional: a slice started any other way has none), `slice.new` and `request.pick` take `small?`, `slice.widen` in `Operations` and in `personalActs`.

## 4. Fixtures (`web/fixtures/small_memory.py`)

Run by `generate.py`, or alone with `python3 web/fixtures/generate.py --only small` (which now writes only that milestone's files, for `needs` too). The real engine with `--app`, in the engine tests' repositories and stand-in for gh: one slice committed to main with its effects declared, so its rules are in force; the spec and why are the engine test's own (`tests/test_small_change.py`). Paths under this checkout are written as `/mach`. 26 files.

| State | Fixtures | Fixture-mode parameter |
|---|---|---|
| A small change being drafted (an adjustment, nothing written) | `slice.new.small`, `slice.resume.small`, `slice.show.small-drafting`, `status.small-drafting` | `?fixture=status.small-drafting`, `?show=small-drafting`, `?resume=small` |
| The adjustment written and still small | `slice.check.small`, `slice.show.small` | `?show=small` |
| A fix naming a shipped rule (`SLICE-001/FR-02`) | `slice.new.small-fix`, `slice.resume.small-fix`, `slice.check.small-fix`, `slice.show.small-fix`, `epic.current.small` (the rules a fix chooses from) | `?show=small-fix`, `?resume=small-fix`, `?epic=small`; `slice.new` with a fix |
| A fix naming a rule not in force | `slice.new.refused-small-not-in-force` | `?small-start=refused-not-in-force` |
| Widened by a rule (four requirements; the check widened it) | `slice.check.small-widened` (`widened_now`), `slice.show.small-widened`, `slice.resume.small-widened` | `?show=small-widened`, `?resume=small-widened` |
| Widened on the PM's word | `slice.widen`, `slice.show.small-widened-asked`, `slice.widen.refused-already`, `slice.widen.refused-full` | `?show=small-widened-asked`, `?widen=refused-already\|refused-full` |
| Every state in one list (with a full slice) | `status.small-changes` | `?fixture=status.small-changes` |
| Marked ready as a small change | `slice.ready.small`, `slice.show.small-ready`, `status.small-ready` | `?ready=small`, `?show=small-ready`, `?fixture=status.small-ready` |
| Marking ready made it a full slice instead (`ready: false, widened: true`, High risk) | `slice.ready.small-widened`, `slice.show.small-widened-at-ready` | `?ready=small-widened`, `?show=small-widened-at-ready` |
| A request picked up as a small change | `request.pick.small` | the request cards in fixture mode answer `request.pick` with `small` from it |

`src/dev/smallFixtures.ts` imports each through the compile-time shape check; `src/dev/smallTransport.ts` answers them (its header lists the parameters). `slice.new` without `small` now answers the engine's `slice.new` fixture in fixture mode (it had no answer before).

Example: `http://127.0.0.1:5173/?fixture=status.small-changes&show=small-fix&epic=small#/slices/SLICE-003`.

## 5. The app (`web/apps/product-studio/src/features/small-change/`)

- **Starting one.** `NewSliceDialog` and the request's pick-up dialog both carry `StartChoiceFields`: "What are you starting?" (A new slice, A small change), then "Is it a fix or an adjustment?", then for a fix "The rule that is not holding", a list of the rules shipped in the chosen epic (`epic.current`: in force, then shipped before effects were recorded; scenarios left out), with each rule's words. Changing the epic clears the rule. The two sentences: "A small change asks fewer questions and writes a shorter spec. Nothing is checked less: it goes through every check in the Factory, as any slice does." and "If it turns out to be more than a small change, MACH makes it a full slice and keeps every answer." Where a slice is started, "Start a small change" sits beside "Start a slice" and opens the same dialog on a small change: the roadmap's context row, an epic's sheet on the roadmap, each epic on the home, each epic in Vision. The engine's own hint to start a slice (`AppHint`) opens the dialog, which offers the choice inside. Picking up a request (and picking it up as well) offers it inside the dialog.
- **The label.** `SmallChangeLabel`: an outline badge with the feather glyph and the word "Small change" (style guide 7.6, a fact about how the slice started; never colour alone), its title the first sentence above. On every slice page's context row (`SliceContextRow`: the specification, effects, principles and policies, design mocks, from the PRD), the interview's document, the home's slice rows, the roadmap's epic and slice sheets, the decisions page's open questions, the GitHub page. Shown while the slice is a small change; a widened slice is a full slice and carries none.
- **On the slice's page** (`SmallChangeNotice`, in the specification's notices): while it is a small change, a banner saying so ("A small change: it fixes SLICE-001/FR-02", or "an adjustment"), the two sentences, and the act "Make it a full slice" (secondary, as Reopen is) while the slice can be edited. Its dialog: "Make SLICE-NNN a full slice?", what it means and does not do, "Why it is more than a small change" (required, at most 300 characters), "Keep it a small change" and "Make it a full slice"; the engine's refusal stays in the dialog in its words; a toast "Made SLICE-NNN a full slice". Once widened: "This began as a small change and is now a full slice.", then "MACH checked it." and the rule's sentence, or "You said why:" and the PM's words quoted, then when ("Changed 3 minutes ago", the exact moment as its title) and that the interview carries on in full with every answer kept.
- **Marked ready, made a full slice instead** (`M18_ENGINE_B.md` item 5). `slice.ready` may answer `{ready: false, widened: true, small_change: {widened_now: true, ...}}` with exit 0; the host passes it through as any answer (`SliceReadyWidened`, and `slice.ready`'s result is `SliceReadyAnswer`). The mark-ready dialog then says "SLICE-NNN was not marked ready", that MACH checked it as it was marked ready and it is a full slice now, with nothing saved or sent to the builders; a neutral well ("It is a full slice now" and the rule's sentence) and two rows (Saved: nothing; Your next step: carry on the conversation, then mark it ready again); "Close" and "Continue the interview". Neither the success nor the danger tone.
- **Wording.** "small change" and "full slice"; no text the app writes says "light path", "engine", "kind" or "script" (tested over every sentence in the feature's components). The engine's `small_change.note` ("left the light path", written for the interviewer) is never shown.

## 6. Sentences reworded under `skills/` (M18 follow-up)

Only the words a person reads; no behaviour, field, rule code or fixed rule sentence changed.

| Where | Before | After |
|---|---|---|
| `small_change.py` `view` (the `small_change.note` of check, show, ready, widen) | "This slice left the light path: {reason} It is a full slice now: the interview carries on in full, with every answer kept." | "This small change is a full slice now: {reason} The interview carries on in full, with every answer kept." |
| `small_change.py` `cmd_widen`, the refusal of a second widening | "{SLICE} already left the light path ({at}): {reason}" | "{SLICE} is already a full slice ({at}): {reason}" |
| `small_change.py` `resume_field` note (for the interviewer) | "... it leaves the light path: never trim the change to keep it small." | "... it becomes a full slice: never trim the change to keep it small." |
| `small_change.py`, `slice widen`'s help | "take a small change off the light path, so it carries on as a full slice" | "make a small change a full slice, so its interview carries on in full" |
| `studio.py` `slice reopen` note, a small change the builders stopped | "The builders said: {reason} So it left the light path: it is a full slice now, and the interview carries on in full, ..." | "The builders said: {reason} So it is a full slice now, and the interview carries on in full, ..." |

Pinned by `tests/test_small_change.py` (two assertions), `tests/test_mach_product_host.py` and `ops_small_test.go`, updated. `skills/intent/scripts/small.py` says "light path" only in a comment. Not changed, outside this exception: `skills/ticket/scripts/issue_rules.py` writes "Small change: {what}, which left the light path" into a slice's GitHub issue body, which a product manager can read on GitHub; `skills/run/scripts/intake.py` and `skills/intent/scripts/cell.py` say it on the Factory's and an engineer's side.

## 7. Deviations

- **No label on a widened slice.** "A 'Small change' label wherever a slice is listed" is read as: while it is one. Once widened it is a full slice, and only its own page says it began as a small change.
- **The rule list is the chosen epic's.** A fix chooses from the rules shipped in the epic the slice is started in (what "How this epic works today" reads); the engine accepts any rule in force on main. A fix to another epic's rule is started in that epic.
- **The PRD on-ramp's apply and Shape's apply** make slices too, but from a map, not with a title the PM types; they are not places where a person starts one slice, and Shape is another engineer's. Neither offers a small change.
- **"one kind of user"** is the app's existing definition of a slice elsewhere; the new choice says "one type of user" so this feature's own words never say "kind".

## 8. How far it was tested

- **Go** (`go test ./...` in `apps/studio`): `ops_small_test.go`: eight argument vectors (run in `TestEveryOperationsArgumentVector`), 21 refusals before the engine, `slice.widen`'s kind, and against the real engine a refused fix, an adjustment started, reported in `status` and `slice resume`, a full slice with no field, `slice.widen` refused for a full slice, done on the PM's word, refused a second time. `TestAllowlistIsExactlyTheContract` names `slice.widen`. `interview/small_test.go`: the widen rules are exactly 13 rules × 2 spellings × every script spelling and interpreter for a small change's own ID, no wildcard, no `--why`, no plan rule; `--why` denied; none for a full slice, an unreadable or misnamed kind, a missing work order, a work order behind a link, the Shape and needs conversations; the activity line.
- **Python**: `tests/test_mach_product_host.py` gains `test_the_m18_small_change_operations_write_the_same_bytes_as_the_terminal` (a refused fix, a fix and an adjustment started, a check widening one, refusals of `slice.widen`, widening on the PM's word: byte-identical workspaces through the host and through `studio.py`).
- **Web**: `test/small-change.test.mjs` (8 tests) on the real fixtures: the start's arguments, the rules a fix may name, the label's states, the widened line both ways, when the act is offered, every start place offers a small change, every listing carries the label, the wording. The fixture shape checks compile (`smallFixtures.ts`).
- **Results, 2026-11-22**: `go test ./...` in `apps/studio`: all five packages ok (96 top-level tests, none failed). `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean. `pnpm --filter @mach/product-studio test`: 321 passed, 0 failed. `python3 tests/in_parallel.py product_host`: 6 tests in 1 class, OK. The other classes `tests/affected.py` names for these changes (`affected`, `loose_ends`): 32 tests in 7 classes, OK.
- **Follow-up results, 2026-11-22** (after merging the Factory side and Shape's route; with marking ready that makes a full slice, and the reworded sentences): `go test ./...` all packages ok, with `TestMarkingASmallChangeReadyCanMakeItAFullSliceInstead` against the real engine. `pnpm typecheck`, `pnpm lint`, `pnpm build` clean; `pnpm --filter @mach/product-studio test` 323 passed, 0 failed (`small-change.test.mjs` now 9). `python3 tests/in_parallel.py small_change product_host`: 78 tests in 19 classes, OK. Every class `tests/affected.py` names for the changed files: 1029 tests in 245 classes, OK.
- **Looked at, not captured**: the fixture dev server, read through the page's text and accessibility tree (no screenshot): the start dialog on the roadmap (the choice, a fix's rule list, the refusals for a missing title and rule), the pick-up dialog with a small change (it fits a 1024 × 768 window; the page does not scroll), a small change's page and its dialog (an empty reason refused, then done), and a widened slice's line.
- **Not verified**: the e2e lifecycle, conformance and accessibility suites were not run; no screenshot or capture was taken; no real Claude Code turn ran a small change's interview (the stand-in tests prove its rules, not a model's use of them); the light and dark themes and narrow windows were not checked by eye.

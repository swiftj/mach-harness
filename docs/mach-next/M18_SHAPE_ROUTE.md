# M18 part C (Shape), as built: the fourth route, a small change

Built 2026-11-22 against `M18_DESIGN.md` part C, Shape bullet. It builds on parts A and B (`M18_ENGINE_A.md`): `small.py`'s settings and `small_change.start_fields`, loaded, never copied.

## What was built

| File | What |
|---|---|
| `skills/product-studio/scripts/shape_route.py` | `route_for` names `small-change` first, with one fixed sentence; `idea size` passes it the high-risk count and the limit from the settings and reports `settings_notes` when a value could not be used; `route_rule` gives the whole rule; the map of a small change holds one slice; `idea apply --change fix\|adjustment` (`small_fields`) makes its slice of kind small; the next step for a small change says the kind is needed. |
| `skills/product-studio/scripts/shape.py` | `ROUTES` holds `small-change`, so a recorded small-change route passes the record's check. |
| `skills/product-studio/references/shape.md`, `SKILL.md` | The fourth route in the table, its map, and the kind asked before apply; rule 8 says the light path is the script's. |
| `apps/studio/internal/engine/ops_shape.go` | `idea.apply` takes an optional `change` (`fix` or `adjustment`, anything else refused), sent as `--change=`. |
| `web/packages/ui/src/api/` | `ShapeRoute` gains `small-change`; `idea.apply` takes `change`; `ShapeApplied.small_change`. |
| `web/apps/product-studio/src/features/shape/` | The route is named "A small change" (route list, stepper words); "Four routes, one rule"; the high-risk note says it rules out only a small change; the apply dialog asks "This small change is" (A fix / An adjustment) and sends it, only for this route and only while the slice is still to be made (`needsSmallKind`, `applyArgs`, tested). Nothing else on the screen changed. |
| `web/fixtures/` | `shape_small_change` in `product_memory.py`, run alone by `python3 web/fixtures/generate.py --only small-change`: `idea.size.small-change`, `idea.show.small-change`, `idea.map-status.small-change`, `idea.apply.refused-small-kind`, `idea.apply.small-change`. No other fixture was regenerated or changed. The fixture transport serves them for `?idea=small-change` and `?size=small-change`. |
| `tests/test_shape_small_change.py` | New, 12 tests. |

## The rule

In this order, first match:

| Route | The rule |
|---|---|
| `small-change` | outcomes = 1, capabilities = 1, shipped rules ≤ limit, high-risk areas = 0 |
| `one-slice` | outcomes = 1, shipped rules ≤ 3 |
| `epic` | capabilities ≤ 1 |
| `several-epics` | otherwise |

- The limit is `intent.small_change.changed_shipped_rules` (0 or 1, default 1), read through `small.settings` by way of `small_change.limits`. With 0 the route needs no shipped rule.
- "Nothing in a high-risk area" is the existing count (`high_risk`, the scan's `risk_for` on the files the rules' slices changed). A count that could not be determined (`None`) is never read as none, so such a brief is not a small change. A brief that touches no shipped rule has 0 by definition.
- "One capability" is exactly one, counted as before (`capability_count`). A brief that passes its check names at least one.
- The sentence: "The brief has one outcome in one capability, N shipped rule(s), at most L, and nothing in a high-risk area, so the route is a small change." With the limit 0: "..., no shipped rule, and nothing ...". The other three sentences are unchanged.
- `route_for(outcomes, rules, capabilities)` with no high-risk count is what it was before M18, so it never returns `small-change`. That follows from the rule that an undetermined count is not none, so it is not a compatibility default.

## Fix or adjustment

The data cannot settle it. A brief from "change what exists" or a fault, touching exactly one rule, is the natural fix candidate. But changing a default is an adjustment that also touches one rule, so nothing recorded tells the two apart. The kind is therefore the product manager's word, asked at `idea apply` as `slice new` asks it (`--change fix|adjustment`), and is never read from the idea's source:

- Without `--change` on a small-change route, apply is refused before anything is made. `--change` on any other route is refused too.
- A fix's rule is not a separate argument. It is the one shipped rule the brief touches, and `start_fields` checks that it is still in force. A brief that touches none cannot be a fix: apply is refused and says to name the rule in the brief or make it an adjustment.
- The fields come from `small_change.start_fields`, the same code `slice new --small` uses, and are passed to `start_slice(..., small=...)`. The draft slice is `kind: small` with `small: {change, shipped_rule}` and its `serves`, exactly as a slice started by hand.
- Run again once the slice is made, apply makes nothing and asks for no kind.

## Deviations

- `idea apply` gained `--change`, and the host's `idea.apply` gained `change`. The brief asked for no more than the route's name in the app. But without the kind the app could not apply a small-change route at all, so the dialog got one choice field, built with the app's existing `Field` and `Select` as the settle dialog uses them.
- No `--rule` on `idea apply`. The brief already names the rule (see above).
- The route also leaves `ROUTES` in `shape.py`, the record's own check, changed.

## Existing tests whose expectation changed

| Test | Why |
|---|---|
| `test_mach_shape.BriefAndVerdictTest.test_a_shaped_idea_keeps_its_verdict` | It asserted the record check's sentence "route.route is one-slice, epic or several-epics". The sentence now names `small-change`. |
| `test_mach_shape_route.ChangeTest.test_a_filled_in_change_is_decided_and_sized_like_any_idea_and_published_with_its_rule` | Its brief has one outcome, one capability, one rule and no high-risk file, so it now routes as a small change. |
| `test_mach_product_host.HostConformanceTest.test_the_m16_shape_operations_write_the_same_bytes_as_the_terminal` | Its brief has one outcome, one capability and no rule, so it now routes as a small change. Its apply now goes through the host and the terminal with `change` / `--change adjustment`, and the host's refusal without it is checked. |
| `web/apps/product-studio/test/shape-route-model.test.mjs` "there are exactly three routes ... no light path" | There are now four routes. The test is renamed and checks the new name. The route-sized test covers `small-change` too. |

The first two would have kept passing unchanged, and wrongly so. `IssuesBase` in `tests/test_mach_product_issues.py` defines `fail(key, ...)`, a helper that sets up a stand-in GitHub failure. It overrides `unittest.TestCase.fail`, and `assertIn`, `assertTrue`, `assertIsNone` and `assertEqual` on strings, lists and dicts all report a failure through `fail`. So in every test built on `IssuesBase`, those assertions pass silently once the stand-in's state exists. (`assertEqual` on numbers raises directly and is unaffected.)

To find what this change really broke, test_mach_shape, test_mach_shape_route and test_mach_shape_brief were run before and after it with `fail` restored. These two tests are the only difference. The helper itself is not fixed here: it is shared, and its callers are in about ten test files. `test_shape_small_change.SmallRouteTest` restores unittest's `fail` for its own class, so its assertions are real.

## How far it is tested

- `tests/test_shape_small_change.py`, 12 tests:
  - The rule on each side of every count: a second outcome, a second capability, no capability, a second rule, one high-risk area, high risk not determined.
  - The limit: 0 and 1, both through `route_for` and end to end with `.factory/config.json`, including an out-of-range value read as the default, with its note.
  - The other three routes keep their exact sentences, from the counts and from real briefs.
  - The high-risk exclusion through a shipped slice that changed a sign-in file.
  - The one-slice map shape.
  - Apply refused without the kind, with nothing made. An adjustment and a fix each make a draft slice of kind small with `serves`, and the fix carries the brief's rule. A fix refused when the brief touches no rule. Applying again makes nothing and asks nothing. `--change` refused on the one-slice route, whose slice stays a full slice.
- The four existing tests above. Go: `IdeaApplyArgs` argv cases and refusals. Web: `needsSmallKind` and `applyArgs` against the real fixtures.
- Not tested:
  - A fix whose rule was replaced after sizing. Replacing the rule makes the brief fail its check first, so that refusal is `start_fields`' own and is tested in `test_small_change.py`.
  - The app's dialog in a browser (no captures taken).
  - The Shape conversation, which cannot apply anyway.

Results on 2026-11-22:

- `make check`: 1951 tests in 451 classes passed, one skipped as before. The manifests validated, passing with the existing warnings (no plugin icon, no author, CLAUDE.md at the plugin root).
- `go test ./...` in `apps/studio` passed.
- From `web/`:
  - `pnpm typecheck` and `pnpm lint` passed clean.
  - `pnpm build` built.
  - `pnpm --filter @mach/product-studio test`: 314 of 314 passed.

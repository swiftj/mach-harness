# M16, as built: the app foundation for Shape

Shape's engine (`shape.py`, `shape_route.py`, `validate_brief.py`; `M16_SHAPE_ENGINE_A.md`, `M16_SHAPE_ENGINE_B.md`) had no way into the visual app. This step lays what six screen engineers would otherwise collide on: the host operations, the Shape conversation in the app, the typed client, the fixtures, and the shell with empty pages. It follows `M15_STUDIO_FOUNDATION.md` exactly. No screen content was built.

## 1. Host operations

Twenty rows in the host's fixed list (`apps/studio/internal/engine/ops_shape.go`), each a typed argument struct that becomes one fixed argument vector after `studio.py --project <root> --app`. Options are `--name=value`; unknown fields, wrong types and trailing data are refused before the engine runs; identifiers are checked against the engine's own patterns (`IDEA-NNN`, `O-N`, `A-N`, `SLICE-NNN/FR-NN|INV-NN|RN`, `AUTO-...`). An idea's title is the engine's one positional value, so it always follows `--` (a title that starts with a hyphen stays a title; tested).

| Operation | Arguments (JSON) | Engine command | Kind |
|---|---|---|---|
| `idea.add` | `{title, from_request?: n \| from_issue?: n \| from_fault?: "AUTO-..."}`, at most one source; title one line, at most 120 | `idea add [--from-...=] -- <title>` | writes the workspace |
| `idea.list` | `{}` | `idea list` | read-only |
| `idea.show` | `{idea_id}` | `idea show IDEA` | read-only |
| `idea.stage` | `{idea_id, stage: "exploring"}` | `idea stage IDEA exploring` | the one stage set by hand |
| `idea.lookups` | `{idea_id, lookups: {...}}`, a JSON object of at most 256 KiB | `idea lookups IDEA --from=<staged lookups.json>` | writes the workspace |
| `idea.renumber` | `{idea_id}` | `idea renumber IDEA` | on the PM's word |
| `idea.publish` | `{idea_id}` | `idea publish IDEA` | on the PM's word; may reach GitHub |
| `idea.size` | `{idea_id}` | `idea size IDEA` | records the route (local Git only) |
| `idea.map` | `{idea_id, map: {...}}`, a JSON object of at most 256 KiB | `idea map IDEA --from=<staged map.json>` | writes the workspace |
| `idea.settle` | `{idea_id, outcome: "O-2", as: "slice", slice: "S2", reason?}` or `{idea_id, outcome, as: "out-of-scope"\|"later", reason?}`; reason one line, at most 300 | `idea settle IDEA --outcome= --as=slice:S2\|out-of-scope\|later [--reason=]` | on the PM's word |
| `idea.map-status` | `{idea_id}` | `idea map-status IDEA` | read-only |
| `idea.apply` | `{idea_id}` | `idea apply IDEA` | on the PM's word |
| `idea.change` | `{rule: "SLICE-007/INV-01", title?}` | `idea change <rule> [--title=]` | on the PM's word |
| `idea.chain` | `{idea_id}` | `idea chain IDEA` | read-only |
| `brief.check` | `{idea_id}` | `brief check IDEA` | records the revision and stage |
| `brief.show` | `{idea_id}` | `brief show IDEA` | read-only |
| `case.show`, `case.check` | `{idea_id}` | `case show\|check IDEA` | read-only |
| `verdict.record` | `{idea_id, decision: "go"\|"not-now"\|"no", reason}`; reason one line, at most 500 | `verdict record IDEA --decision= --reason=` | on the PM's word; reads the signed-in login |
| `lookback.record` | `{idea_id, outcome: "O-1", result: "met"\|"not-met"\|"too-early", note}` or `{idea_id, assumption: "A-1", result: "confirmed"\|"wrong"\|"unknown", note}`, exactly one item; note one line, at most 500 | `lookback record IDEA --outcome=\|--assumption= --result= --note=` | on the PM's word; may post to GitHub |

`status`, `refresh`, `slice.show` and `slice.resume` needed no new operation; their new fields are typed (section 3).

**Lookups and the map** travel inside the JSON body, as M15's PRD map does, and are staged by the same path (`engine.Do`, `security.StageUpload`): written exclusively under `.factory/studio/uploads/<random>/` for the one call and removed afterwards. Their limit is the engine's own (`shape.MAX_INPUT_BYTES`, 256 KiB); the body limit is that plus 64 KiB.

**An act waits while the conversation writes.** While the Shape conversation's turn is running for an idea, every Shape operation that changes that idea (stage, lookups, renumber, publish, size, map, settle, apply, brief check, verdict, look back) is refused with `conflict` ("The conversation is writing this idea's brief or case right now..."), as a draft write waits for a slice's interview (`engine.WritesIdea`, checked in `server.operation`). Reads and acts on other ideas go on.

`apps/studio/README.md` lists the operations under "Shape (M16)".

## 2. Writing the brief and the case in the app: the choice

**Chosen: a second, equally narrow mode of the guided interview, for one idea.** The slice interview's mechanism (one `claude -p` per reply, `--restricted`, `--permission-prompts none`, exact-prefix allow rules, absolute `Edit(//...)` rules, deny rules as a second layer, the minimal environment) is keyed by its subject. The subject may now be an `IDEA-NNN`; the two patterns never overlap. Everything else about the process is unchanged and shared.

The Shape conversation for `IDEA-007` may (`interview.Paths.ideaPermissionArgs`):

- read: `Read`, `Glob`, `Grep`; `where`, `status`, `validate`, `refresh`, `idea list`, `request list`, `principle list`, `policy list`, `epic current *`; and for its own idea only `idea show`, `brief show`, `brief check`, `case show`, `case check`;
- record what it looked up: `idea lookups IDEA-007 --from <one fixed file>` and nothing else of `idea lookups` (both `--from x` and `--from=x`, the path quoted and not);
- edit exactly three files: `product/briefs/IDEA-007.md`, `product/briefs/IDEA-007.case.md`, and that one input file, `.factory/studio/interviews/inputs/IDEA-007.lookups.json`. The input file is outside the draft workspace, so it can never stand in for the engine's own lookups (which `idea lookups` checks, all or nothing).

Denied again, in every spelling: every `slice` command, `idea add|stage|renumber|publish|size|map|settle|map-status|apply|change|chain`, `verdict`, `lookback`, the acts of principles, policies, Jira, the PRD on-ramp and requests, project and epic changes, and the names the app never offers. The slice interview, for its part, now also denies every Shape command (`idea`, `brief`, `case`, `verdict`, `lookback`).

Its note (`IdeaHostNote`) names the input file and says the stage, verdict, sizing, map, settlements, drafts, a change, publishing and look back are the PM's buttons, and never to recommend a verdict. Its first message is `/mach:product-studio explore IDEA-NNN.` and one fixed sentence; nothing the person typed is added. Starting it is refused before Claude Code runs for an idea the engine does not know and for one shaped into work (its brief stays as it was when its slices were made). Its session, lock and history are `IDEA-NNN.json`, `.lock` and `.events.jsonl` beside the slices'. Routes: `POST /api/interview {idea_id}`, `GET /api/interview?idea_id=`, `GET /api/interview/history?idea_id=`; `draft_changed` names `idea_id` and `brief`, `case`, `lookups` or `idea`.

Why this and not the plain-text editor: every rule is as exact as the slice's (exact idea, exact files, no wildcard path), the conversation is what the sketch's Explore step is, and the boundary is held by the same tests. The plain-text editor path was not built.

**Tested** (`apps/studio/internal/interview/idea_test.go`, `internal/server/shape_test.go`): every allow rule of the idea mode matches one exact pattern, with exactly three edit rules and the counts per spelling; no rule names a slice, another idea, a wildcard file or any PM act; every act has a deny rule and no deny rule covers an allowed read; the slice interview allows nothing of Shape and denies all of it; a real turn through the stand-in for Claude Code runs with the idea's rules, note and opening, records `idea_id` and no `slice_id`, reports `draft_changed` for the brief, describes a refused verdict; over HTTP, an unknown idea and a shaped idea are refused with Claude never started, malformed and mixed IDs are `invalid`, and Shape acts on that idea wait while a turn runs.

**What follows from the boundary, for the screen engineers:**

- The conversation cannot set the stage: the Explore screen calls `idea.stage` (exploring) itself when a new idea is explored.
- The conversation cannot record a map. In the terminal the model writes the map and runs `idea map`; in the app, `idea.map` exists on the host for whatever produces the map, as `prd.draft` did in M15. Letting the conversation record a map would widen its allow list by one exact rule (`idea map IDEA --from <a second input file>`); that is a decision, not made here.

## 3. Typed client, and two engine fields

`web/packages/ui/src/api/shape.ts` (exported from `@mach/ui/api`): every Shape result and input type, from the real fixtures. `types.ts`: the twenty operations in `Operations`; `readOnlyOperations` gains the seven reads; `personalActs` gains `verdict.record`, `idea.publish`, `idea.renumber`, `idea.settle`, `idea.apply`, `idea.change`, `lookback.record` (each confirmed in a dialog); `uploadLimits.shapeJson` (256 KiB); `Status.ideas` (`StatusIdeas`: the board, by stage, counts, each row's `next {kind, sentence}`; absent without ideas); `Refresh.ideas`; `SavedReport` kinds `idea_unfinished`, `idea_changed`; `Epic.serves`, `WorkOrder.serves`, `SliceResume.idea`, `SliceShow.idea`, `SliceCheck.serves_problems`; the interview types accept `idea_id`. `SliceIds.reserved_without_spec` was wrong (the engine also gives `{id, feature, reserved_by}`) and is fixed. `MachClient.ideaConversation` is the Shape conversation's client (`createIdeaConversationClient`: `current`, `history`, `start` by idea; `subscribe`, `reply`, `interrupt`, `stop` by interview ID).

Two engine fields were added because a screen needs them and the engine did not give them (`skills/` changed only here):

- `validate_brief.analyze_case`: the case model gains `customer`, the "As the customer would hear it" words on one line (the Case screen shows them; before, only their count). Tested in `test_mach_shape_brief.py`.
- `shape.lookups_view`: in `--app` mode only, `items` gives each recorded lookup in its group (`shipped_rules: {rule, in_force, epic_id, note}`, `similar`, `principles`, `policies`), as checked, bounded and redacted when recorded. The terminal keeps them fenced only, so the conversation reads them as data. Tested in `test_mach_shape.py`. A shipped rule's own words are not in the lookups: Explore reads them with `epic.current` for the rule's epic.

## 4. Fixtures

`web/fixtures/product_memory.py` gains eight `shape_*` scenarios, run by `generate.py`, in the engine tests' own repositories (`test_mach_shape`, `test_mach_shape_route`) with the stand-in for gh: 94 files. One case is not made by the real thing: "not determined" high-risk areas need a computer that cannot say which files a shipped slice changed, so Git's answer is withheld for that one size (`shape_route.changed_files`, as the engine's own test does). `src/dev/shapeFixtures.ts` imports each through the compile-time shape check; `src/dev/shapeTransport.ts` answers them in fixture mode (`vite --mode fixtures`), with its parameters in its header. The older fixtures were not regenerated (a full run changes only times and paths in them).

| Case | Fixtures | Parameter |
|---|---|---|
| No ideas yet | `idea.list.empty`; every existing `status.*` (no `ideas` field) | default status; `?ideas=empty` |
| Every stage, every source and a change | `idea.list.board`, `status.ideas`: New from a request (#57), Exploring from an idea-template issue (#58), Brief written typed, Decided No from a fault, Not now typed, Go typed, Exploring from a change to `SLICE-001/INV-02`, Shaped; `idea.show.request`, `.exploring`, `.brief-written`, `.fault`, `.not-now`, `.go`, `.change`, `.shaped-one-slice` | `?fixture=status.ideas`; `idea.show` follows the idea's ID, or `?idea=<suffix>` |
| Adding one | `idea.add`, `.from-request`, `.from-issue`, `.from-fault`, `.refused-twice`, `.refused-not-template`; `idea.stage` | by the source sent; `?add=refused-twice\|refused-not-template` |
| A No kept with its reason | `verdict.record.no`, `idea.show.fault` | `?idea=fault` |
| Lookups in all three groups | `idea.lookups`, `idea.show.exploring` (`lookups.items`) | `?idea=exploring` |
| A brief that passes; one with a finding (an outcome with no way to know) and warnings | `brief.show.passes`, `brief.check.passes`; `brief.show.finding`, `brief.check.finding`; the change's starter brief `brief.*.change-starter`; none yet `brief.show.refused-none` | by idea; `?brief=passes\|finding\|stale-verdict\|change-starter\|none` |
| A case with one question not answered on purpose | `case.show`, `case.check`; no case yet `case.show.refused-none` | default for IDEA-003; `?case=none` |
| No verdict, Go, Not now, No, stale | `idea.show.brief-written`; `verdict.record.go`, `.not-now`, `.no`; `brief.show.stale-verdict`, `brief.check.stale-verdict`, `idea.show.stale-verdict`, `status.ideas-stale-verdict` | by the decision sent; `?brief=stale-verdict`, `?idea=stale-verdict` |
| A verdict refused because nobody is signed in | `verdict.record.no-login` (recorded with no login), then `idea.publish.refused-no-login`; also `verdict.record.refused-offline`, `.refused-go-without-brief` | `?verdict=no-login\|refused-offline\|refused-go-without-brief`, `?publish-idea=refused-no-login` |
| Size: each route, "not determined", a stale route | `idea.size.one-slice` (none found), `.epic` (`high_risk_areas: null`, not determined), `.several-epics` (sign-in and billing), `.refused-no-go`; `idea.show.stale-route`, `idea.map.refused-stale`, `status.ideas-routes` | `?size=...`, `?idea=stale-route`, `?map=refused-stale` |
| The map: an outcome no slice carries, settled, applied, applied twice | `idea.map.uncovered`, `idea.map-status.uncovered`, `status.ideas-settle`, `idea.apply.refused-unsettled`, `idea.settle.refused-carried`, `idea.settle` (to a slice), `idea.settle.out-of-scope`, `idea.map-status.settled`, `status.ideas-apply`, `idea.apply`, `idea.apply.again`, `idea.map-status.applied`, `idea.show.mapped`, `idea.show.shaped` | `?map-status=uncovered\|settled\|applied`, `?apply=again\|refused-unsettled`, `?settle=refused-carried` |
| Change what exists | `idea.change`, `idea.change.refused-replaced`, `idea.show.change`, `brief.*.change-starter` | `?change=refused-replaced` |
| A slice made from an idea | `slice.show.from-idea`, `slice.resume.from-idea` (`idea`, `serves`, `serves_problems`) | `?show=from-idea`, `?resume=from-idea` |
| Look back not yet allowed, allowed, recorded | `lookback.record.refused-not-shipped`, `status.ideas-shaped`; `status.ideas-look-back`, `idea.show.look-back`; `lookback.record` (posted), `.again` (already there), `.assumption`, `.too-early`, `.refused-secret`, `.folder` (kept here only), `idea.show.looked-back` | `?fixture=status.ideas-look-back`, `?lookback=...` |
| The chain with missing values | `idea.chain` (one slice without a spec, acceptance not kept here), `idea.chain.looked-back` | `?chain=looked-back` |
| Published to GitHub, to the folder, stopped part way, changed on GitHub after its verdict | `idea.publish`, `.again`, `.shaped`, `idea.show.on-github`, `refresh.ideas`; `idea.publish.folder`, `status.ideas-folder`; `idea.publish.refused-stopped`, `status.ideas-unfinished`, `idea.publish.finished`; `refresh.ideas-changed`, `status.ideas-changed`, `idea.list.changed`; `idea.publish.refused-number-taken`, `idea.renumber`; `refresh.ideas-none-saved` | `?publish-idea=...`, `?refresh=refresh.ideas-changed`, `?fixture=status.ideas-changed\|-unfinished\|-folder` |

The Shape conversation does not run in fixture mode: `GET /api/interview?idea_id=` answers there is none and starting one answers "unavailable" in words. `?refuse=<operation>` gives the engine's real refusal for any Shape operation.

## 5. The shell

The app's information architecture is unchanged. Added:

- **"Shape"** as a destination, first after the project home in the "More" menu (where the sketch puts it) and so also in the home's row of links: `/shape`, the ideas board. That link is the one quiet way in; a project with no ideas sees nothing else of Shape.
- **One idea's pages**: `/shape/ideas/:ideaId/explore`, `/brief`, `/case`, `/route`, `/look-back`; `/shape/ideas/:ideaId` opens the step that holds the engine's next step; `/shape/change?rule=...` for change what exists.
- **The stepper** (`shell/ShapeStepper.tsx`, style guide 7.10): the six steps as links, the page you are on marked as the current step, the step holding the engine's next step named "Next" in words with the steps before it done, and under each a few words from the idea's row (`shell/steps.ts`: "Passes its check", "Verdict no longer holds", "One slice", "Ready to look back"...). The next step is the engine's (`next.kind`); `stepForNext` only maps it to a page: `explore`/`write_brief` to Explore, `check_brief` to The brief, `record_verdict`/`publish`/`renumber` to The case, `size`/`map`/`settle`/`apply` to Size and route, `look_back` (and `none` once shaped) to Look back.
- **`shell/IdeaStepFrame.tsx`**: every idea page's frame: the idea's ID and title, the step's name as the h1, the lead, the stepper, then the page (a render function given the idea's row). Loading, an error and an idea the board does not hold are handled in the frame.
- **Breadcrumbs**: Project / Shape / the idea's title / the step (`shapeBreadcrumb`).
- **The home**: "Next in Shape", one quiet line with the first idea's next sentence and a link, only when `status.ideas` holds an idea with something to do (`shell/ShapeCarryOn.tsx`). The project's own next step stays the home's main one.

## 6. Who owns what

Paths under `web/apps/product-studio/src/features/shape/`. Each engineer owns one folder (edit freely; add any file there).

| Engineer | Folder | Starts from | Data |
|---|---|---|---|
| 1. The ideas board | `ideas/` | `IdeasBoardScreen.tsx` | `useIdeaBoard()` (status `ideas`), `idea.list`, `idea.add`, `idea.stage`, `request.list` |
| 2. Explore, and what MACH looked up | `explore/` | `ExploreScreen.tsx` | `client.ideaConversation`, `idea.show` (`source`, `lookups.items`), `idea.stage`, `epic.current` for a rule's words |
| 3. The brief with its check panel | `brief/` | `BriefScreen.tsx` | `brief.show`, `brief.check` |
| 4. The case and the verdict | `case/` | `CaseScreen.tsx` | `case.show`, `case.check`, `idea.show` (`verdict`, `verdict_note`), `verdict.record`, `idea.publish`, `idea.renumber` |
| 5. Size and route, the map, apply, change what exists | `route/` | `RouteScreen.tsx`, `ChangeScreen.tsx` | `idea.size`, `idea.show` (`route`), `idea.map`, `idea.map-status`, `idea.settle`, `idea.apply`, `idea.change`; also the one "Change this" entry on `features/epic-today/EpicTodayScreen.tsx` leading to `/shape/change?rule=...` |
| 6. Look back and the chain | `lookback/` | `LookBackScreen.tsx` | `lookback.record`, `idea.chain`, `idea.show` (`lookback`) |

**Shell (nobody else edits):** `features/shape/index.tsx`, everything in `features/shape/shell/` (`steps.ts`, `useIdea.ts`, `ShapeStepper.tsx`, `IdeaStepFrame.tsx`, `IdeaRedirect.tsx`, `ShapeCarryOn.tsx`), `router.tsx`, `Layout.tsx`, `features/registry.ts`, `features/types.ts`, `features/home/**`, `shared/**`, `api/**`, `dev/**` (with `shapeFixtures.ts`, `shapeTransport.ts`), `web/packages/ui/**`, `web/fixtures/**`, `apps/studio/**`, `test/shape-steps.test.mjs`.

A screen engineer who needs something shared builds it in their own folder and names it for promotion (`M5_CONTRACT.md` 8.3). A new fixture is made by adding to `product_memory.py`, never by hand. Every person's act (the `personalActs` above) is confirmed in a dialog; nothing recommends a verdict, scores an idea or derives a route.

## 7. Tests

- **Go** (`apps/studio`): the allowlist and its kinds (`ops_test.go`; Shape's reads read-only and local, publish, verdict and look back reaching GitHub, the rest local; only lookups and the map carry a body larger than 64 KiB; every vector starts with an engine command); an argument-vector case for all twenty operations, including a title that looks like an option; the refusals before the engine (`ops_shape_test.go`: IDs, one-line and length bounds, exactly-one choices, the result per kind, a JSON object within 256 KiB, unknown fields such as `by`, `path`, `text`); `WritesIdea` for every act and none for reads; the interview's idea mode and the slice interview's Shape denials (`interview/idea_test.go`); the Shape conversation over HTTP and the acts held while it writes (`server/shape_test.go`). 80 top-level tests, all pass; `go vet` clean.
- **Python**: `tests/test_mach_product_host.py` gains `test_the_m16_shape_operations_write_the_same_bytes_as_the_terminal`: every Shape operation through the host (lookups and the map as JSON) and through `studio.py`, with the brief and case written as the conversation writes them, leaves byte-identical files in Product Studio's workspace, the same refusals, nothing staged left, and a clean checkout. `test_mach_shape.py` and `test_mach_shape_brief.py` cover the two engine fields.
- **Web**: the fixture shape checks compile (`shapeFixtures.ts`, 94 files); `test/shape-steps.test.mjs` (every next kind the engine can name has a step; the board's ideas open where they should; the stepper's words; the breadcrumb; the home's line only with ideas; every Shape fixture in the app's wording); the e2e conformance suite's allowlist names the twenty operations.

## 8. Not done, or for the screen engineers to know

- The conversation cannot record a map (section 2); `idea.map` waits for a producer or a decision.
- The Shape conversation is not tried with a real Claude Code here; the stand-in proves its arguments, rules and events.
- Fixture mode has no scripted Shape conversation; Explore's engineer may add one in `explore/` (as `features/interview/dev/` does for slices).
- The lookups give a shipped rule's ID, epic and note, not its words; Explore reads `epic.current` for them.
- The engine's `status.next_actions` has no Shape kind; the home's "Next in Shape" reads each idea's `next`.
- The e2e lifecycle and accessibility suites were not run (they take screenshots), and no screenshot was taken.

## 9. The clean-up pass after the screens

After the six screen engineers, one pass did what each reported it needed from outside its folder, as section 7 of `M15_STUDIO_FOUNDATION.md` did for M15.

**Engine** (`skills/product-studio/`; app wording through `say()`, `AppWordingTest` covering `idea faults`):

- The board: each row's `verdict` carries its `reason`, bounded to one line of at most 500 characters. The ideas board no longer reads `idea.show` per decided card.
- `brief check` gives a `note` in the engine's words: "This is revision N: the brief's text changed since revision N-1 was checked", "This is revision 1: the first text of the brief MACH has checked", or "Nothing changed since revision N was checked". The brief screen's "Check again" banner uses it.
- `idea show` gains `acts` (read only): `verdict`, `go`, `size` and `look_back`, each `{allowed, why}`, `why` being the very sentence the act would be refused with (shared functions `shaped_refusal`, `go_refusal`, `size_refusal`, `lookback_refusal`, so the two can never differ). The case screen says Go's need beside the three equal choices and refuses it in the form before the dialog, and says why a shaped idea's verdict stays; Size and route offers sizing only when `acts.size` allows it and says why not in the engine's words (no hard-coded sentence); Look back opens only when `acts.look_back` allows it (no inference from the next step). The Go refusal's "Nothing was recorded." is added only when the act is refused.
- Lookups: each policy carries its pack's `owner`. A shipped rule's `epic_id` comes from the compiled current view, which knows an epic only from the spec's header line (the line the Factory writes at dispatch); the app's lookup items fill a missing epic or owner at show time, without changing the record. The fixtures' shipped specs now carry their header, so the "How this epic works today" links appear.
- `idea size` keeps the details behind each count on the recorded route (`route.details`: `touches`, `high_risk` {areas with files, not_determined, count}, `concerns`): identifiers and the scan rule's reasons only, so the host and the terminal still write identical records. Size and route shows them after a reload.
- `idea faults` (new, read only): the open self-healing fault tickets in `.factory/inbox/AUTO-*.json` (the same records `idea show` fences a fault's text from), newest first, at most 100, each `{ticket, summary (one line, at most 160 characters, redacted), occurrences, last_seen, idea_id}`, the idea already started from it named. Host operation `idea.faults`; offered in the board's "Add an idea" dialog as "A fault from production", without the ones already started from.
- `idea settle` as out of scope or later needs the product manager's reason and is refused without one; as part of a slice it stays optional. The settle dialog requires it the same way, and `references/shape.md` says so.
- User-facing notes say MACH does things ("MACH counted and named the route").

**Host** (`apps/studio`): `idea.faults` (read only, local; twenty-one operations); `GET /api/session` adds `capabilities.explore_command` (`/mach:product-studio explore` or `/mach-product-studio explore`, from the same install as `continue_command`), which "Continue in Claude Code" on Explore uses instead of deriving it.

**Types, shared pieces and shell** (`web/`):

- `@mach/ui/api`: `IdeaShow.acts` (`IdeaActs`, `IdeaAct`), `IdeaFaults`, `FaultTicket`, `LookupPolicy.owner`, `RecordedRoute.details` (`RouteDetails`), `IdeaChain.brief` nullable, `ShapeMapStatus.route` nullable and its `coverage`, `not_covered` and `blockers` absent without a map, the board row's `reason`, `idea.settle`'s reason required for out of scope and later, `Session.capabilities.explore_command`.
- Promoted, one implementation each, the copies deleted: `ConfirmDialog` takes `focusAfter` and `width` (the case screen's `ActDialog` and the look-back's own dialog are gone); `RadioGroup` in `@mach/ui` (the verdict, look-back and Jira choices; the verdict's and the look-back's equal weight kept as built); `DiagnosticList` colours itself by its strongest finding (the brief's own list is gone; warning-only lists elsewhere now read as warnings); `shared/QuotedLines.tsx` and `shared/lineRanges.ts` (the PRD on-ramp's and the map's quotations and range helpers); `shared/useRequestList.ts` (Inbox, home, board); `shared/unfence.ts` (Explore and requests); `shared/useConversation.ts`, the one conversation hook, with `useInterview` and `useIdeaConversation` as bindings to their clients (both screens' tests pass unchanged in behaviour). The pure shared helpers are imported with their `.ts` extension so the unit tests load them (`allowImportingTsExtensions` in the app's `tsconfig.json`).
- Epics made from an idea link to "How <epic> works today" (`/epics/:epicId/today`); its empty state says plainly that no slice of the epic has been merged yet, so it has no rules in force.

**Fixtures** (`web/fixtures/product_memory.py`, from the real engine; 135 Shape files, parameters in `src/dev/shapeTransport.ts`):

| Case | Fixtures | Parameter |
|---|---|---|
| A scripted Shape conversation: state changes, lookups, streamed text, open questions without a recommended answer, `draft_changed` for lookups, the brief and the idea, a refused verdict, a turn ending in its spending limit, the end | `features/shape/explore/dev/scriptedConversation.ts`, loaded only under `vite --mode fixtures` | `?speed=fast`, `?conversation=conflict\|unavailable` |
| The faults on this computer; none | `idea.faults`, `idea.faults.empty` | `?faults=empty` |
| A brief with warnings only; checked again unchanged | `brief.check.warnings`, `brief.show.warnings`, `brief.check.unchanged` | `?brief=warnings` |
| Lookups whose rules carry their epic, a policy with its owner | `idea.show.exploring`, `idea.lookups` (the board's specs now carry their header) | `?idea=exploring` |
| Number taken on GitHub; a stopped save; the folder form; changed on GitHub | `idea.show.number-taken`, `status.ideas-number-taken`; `idea.show.unfinished`; `idea.show.folder`; `idea.show.changed` | `?idea=...`, `?fixture=status.ideas-number-taken` |
| An unreadable idea file | `idea.list.unreadable`, `status.ideas-unreadable`, `idea.show.refused-unreadable` | `?ideas=unreadable`, `?idea=refused-unreadable` |
| A decided idea with a long reason | `verdict.record.long-reason`, `idea.show.long-reason`, `idea.list.long-reason`, `status.ideas-long-reason` | `?ideas=long-reason`, `?idea=long-reason` |
| Every question answered; a question with no answer | `case.show.all-answered`, `case.check.all-answered`; `case.show.unanswered`, `case.check.unanswered` | `?case=all-answered\|unanswered` |
| A map with route blockers | `idea.map-status.blockers`, `idea.show.blockers` | `?idea=blockers` |
| A Go, sized, no map yet | `idea.show.sized`, `idea.map-status.sized` | `?idea=sized` |
| `idea.show` and `idea.map-status` in pairs, from the same run | `idea.map-status.<suffix>` for every board idea, `stale-route`, `mapped`, `shaped`, `look-back`, `looked-back`; `idea.show.uncovered`, `.settled`, `.applied` | `?idea=` or `?map-status=` picks both |

The screens' unit tests that built these by altering a fixture now read the real ones (warnings only, every question answered, no answer, stopped, folder, number taken, the board's reason, the look-back gate, the route gate). A test holds that every paired fixture's route reads as stale only with the engine's note.

**The sketch** (`docs/mach-next/sketches/shape.html`): three routes (the light path is deferred) and an idea touching one capability routed as one epic.

**Tests:** `tests/test_mach_shape_cleanup.py` (11: the board's reason, the revision note, the acts and their sentences, owners and epics, the route's details, the faults listing, the settle reason); the host-versus-terminal test also runs `idea faults`; Go: the allowlist, the argument vector and an unknown field for `idea.faults`, `ExploreCommandOf`, and the session's `explore_command`; web: new model tests for faults, the long reason, the paired fixtures, the settle reason, the acts.

**Left:**

- The `origin` repository's visibility is not reported, so the publish dialogs still say "an issue is as visible as its repository". No call the engine makes returns it: `collab.request_repository` asks `gh repo view` for `nameWithOwner` only, and widening it was out of scope (no new or changed network call).
- A shipped rule whose spec has no header line still has no epic: the compiled current view knows epics only from that line.
- `idea add --from-fault` still accepts a fault ticket that is closed or already started from; only the board's dialog leaves those out.
- The Shape conversation is not allowed `idea faults` (it adds no idea); nothing else of its boundary changed.
- The e2e lifecycle and accessibility suites were not run (they take screenshots), and no screenshot was taken.

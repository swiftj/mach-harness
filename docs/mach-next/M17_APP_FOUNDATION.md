# M17, as built: the app foundation for Technical needs

M17's engine (`needs.py`, `design.py`; `M17_DESIGN.md` parts A and B) had no way into the visual app. This step lays what the two screen engineers would otherwise collide on: the host operations, the needs conversation in the app, the typed client, the fixtures and the routes with placeholder pages. It follows `M16_SHAPE_APP_FOUNDATION.md`. No screen content was built.

## 1. Host operations

Twelve rows in the host's fixed list (`apps/studio/internal/engine/ops_needs.go`), each a typed argument struct that becomes one fixed argument vector after `studio.py --project <root> --app`. Options are `--name=value`, so a statement that looks like an option stays words (tested). Unknown fields, wrong types and trailing data are refused before the engine runs; identifiers are checked against the engine's own patterns (`TN-NN`, `DES-NN`); bounds are the engine's (`issue_rules.NEED_LIMITS`, `SAID_BY_LIMIT`, `SAID_ON_RE`; `design.REASON_CHARS`, `BY_CHARS`, `MAX_CONFLICTS`).

| Operation | Arguments (JSON) | Engine command | Kind |
|---|---|---|---|
| `need.list` | `{}` | `need list` | read-only |
| `need.add` | `{kind, statement, why}`, or for a `given` also `{said_by, said_on}` (both required, and only for a given); statement one line, at most 400; why at most 300; said_by at most 100; said_on a date | `need add --kind= --statement= --why= [--said-by= --said-on=]` | on the PM's word |
| `need.set` | `{need_id, statement?, why?, said_by?, said_on?}`, at least one | `need set TN [--statement= --why= --said-by= --said-on=]` | on the PM's word |
| `need.retire` | `{need_id}` | `need retire TN` | on the PM's word |
| `need.none` | `{kind}` | `need none --kind=` | on the PM's word |
| `need.publish` | `{}` | `need publish` | on the PM's word; may reach GitHub |
| `reconcile.needs` | `{take: "mine"\|"theirs"}` | `reconcile needs --take=` | on the PM's word; reads GitHub's version |
| `design.list` | `{}` | `design list` | read-only |
| `design.import` | `{file: {name, content_base64}}` | `design import <staged copy>` | on the PM's word |
| `design.show` | `{design_id, lines?}` (a line or a range such as `40-80`) | `design show DES [--lines=]` | read-only |
| `design.settle` | `{design_id, conflict: 1..40, as: "stands"\|"design-is-wrong"\|"ask-engineer", reason, by?}`; reason one line, at most 300; by at most 80 | `design settle DES --conflict= --as= --reason= [--by=]` | on the PM's word |
| `design.publish` | `{design_id}` | `design publish DES` | on the PM's word; writes the folder only |

**How the file arrives.** As the PRD on-ramp's import and the mock upload do: the browser reads the file (`uploadFile(file, uploadLimits.design, "design.import")`) and sends it base64 inside the JSON body, so it passes the same session, Origin, CSRF and Content-Type checks as every request. The host checks only the name (`.md`, `.markdown`, `.txt`, `.text`) and the size (512 KiB, `prd.MAX_BYTES`, the engine's own limit, since `design.py` shares `prd.Imported`), stages it under `.factory/studio/uploads/<random>/` for the one call and removes it afterwards. The engine bounds and checks the content. No path ever comes from the request.

**`design map` is not an operation.** No person's button records a map: the needs conversation does (section 2). `TestAllowlistIsExactlyTheContract` holds that `design.map` is unreachable.

**An act waits while the conversation writes.** While the needs conversation's turn is running, every operation that changes the needs or a design (`need.add|set|retire|none|publish`, `reconcile.needs`, `design.import|settle|publish`) is refused with `conflict` ("The conversation is writing the technical needs right now. Wait for its reply, or interrupt it."): `engine.WritesNeeds`, checked in `server.operation` beside Shape's `WritesIdea`. Reads go on.

`apps/studio/README.md` lists the operations under "Technical needs (M17)".

## 2. The needs conversation

A third, equally narrow mode of the guided interview, for the product as a whole. Its subject is `needs` (`interview.NeedsSubject`), which never overlaps a slice's or an idea's ID. Everything else about the process is the slice interview's and the Shape conversation's, shared.

It may (`interview.Paths.needsPermissionArgs`):

- read: `Read`, `Glob`, `Grep`; `where`, `status`, `validate`, `refresh`, `need list`, `design list`, `principle list`, `policy list`;
- record with the PM's words: `need add …`, `need set …`, `need none …`; read a design: `design show …`;
- record a design's map: `design map <DES> --from <one fixed file>`, both `--from x` and `--from=x`, the path quoted and not, for each design in the workspace **by its exact ID** when the turn starts (`product/designs/DES-NN/` folders, not links); no design, no map rule;
- edit exactly one file: `.factory/studio/interviews/inputs/needs.design-map.json`, outside the draft workspace. `product/needs.json` is written only by the engine.

Denied again, in every spelling: `need retire`, `need publish`, `reconcile`, `design import|settle|publish`, every slice, Shape (`idea`, `brief`, `case`, `verdict`, `lookback`), project and epic command, the acts of principles and policies, Jira, the PRD on-ramp and requests, and the names the app never offers. The slice interview and the Shape conversation now deny every `need` and `design` command.

Its note (`NeedsHostNote`) names the input file, says retiring, publishing, choosing a version, bringing in, settling and publishing are the PM's buttons, and never to offer a technology, settle a conflict or accept or recommend an ADR. Its first message is `/mach:product-studio needs.` and one fixed sentence; nothing the person typed is added (the skill's routing now sends "needs" to **Technical needs**). Starting it is refused before Claude Code runs when the project does not exist, or when the needs file is not in the engine's form (`need list` refuses). Its session, lock and history are `needs.json`, `needs.lock` and `needs.events.jsonl` in the interviews folder. Routes: `POST /api/interview {needs: true}`, `GET /api/interview?needs=true`, `GET /api/interview/history?needs=true`; its events and answers say `needs: true` (never `slice_id` or `idea_id`); `draft_changed` names `needs` (product/needs.json) or `design` (a design's map). `GET /api/session` reports `capabilities.needs_command` (`/mach:product-studio needs` or `/mach-product-studio needs`, from the same install as `continue_command`).

**Tested** (`internal/interview/needs_test.go`, `internal/server/needs_test.go`): every allow rule matches one exact pattern, with one edit rule and the counts per spelling; `design map` only for real designs, by ID, never a wildcard; none for a link or a misnamed folder; none without a design; no rule names a slice, an idea or the needs file; every act has a deny rule and no deny rule covers an allowed read; the slice interview and the Shape conversation deny `need` and `design`; a real turn through the stand-in for Claude Code runs with the needs rules, note and opening, records `needs: true` only, reports `draft_changed` for `needs`, and describes a refused publish; over HTTP, a missing project is refused with Claude never started, malformed and mixed subjects are `invalid`, a second start is `conflict`, and every needs and design act waits while a turn runs.

## 3. Typed client

`web/packages/ui/src/api/needs.ts` (exported from `@mach/ui/api`): every needs and design result type, from the real fixtures (`TechnicalNeed`, `NeedKindRow`, `NeedsBlock`, `NeedList`, `NeedChanged`, `NeedNothingToSay`, `NeedsPublishResult`, `ReconcileNeeds`, `AdrBehind`, `DesignSummary`, `DesignShow`, `DesignMap`, `DesignTopic`, `DesignConflict`, `DesignImport`, `DesignSettled`, `DesignPublished`, `DesignMapRecorded`, and `needKinds` in the engine's order). `types.ts`: the twelve operations in `Operations` (`need.add`'s arguments say a given needs `said_by` and `said_on`); `readOnlyOperations` gains `need.list`, `design.list`, `design.show`; `personalActs` gains every act (each confirmed in a dialog); `uploadLimits.design`; `Status.needs` (absent for a project that never opened them) and `Status.designs` (absent without a design); `Refresh.needs_taken`, `RefreshGithub.needs`; `SavedReport` kinds `needs_unpublished`, `needs_unfinished`; `Session.capabilities.needs_command`; the interview types accept `needs: true`. `MachClient.needsConversation` is the needs conversation's client (`createNeedsConversationClient`: `current`, `history`, `start`, then `subscribe`, `reply`, `interrupt`, `stop` by interview ID).

No engine field was added: the screens' needs were all in the engine's output.

## 4. Fixtures

`web/fixtures/needs_memory.py`, run by `generate.py` (or `python3 web/fixtures/generate.py --only needs`, which writes only these and leaves the others as they are), in the engine tests' own repositories with the stand-in for gh: 48 files. Nothing is hand-written: the ADR behind a need is a real ADR committed with `serves: TN-01@1` after the need's second revision; the design's map is recorded with `design map --from`, as the conversation records it (the design is the engine tests' own `DESIGN_TEXT`, with an instruction inside it that is shown fenced, as data). `src/dev/needsFixtures.ts` imports each through the compile-time shape check; `src/dev/needsTransport.ts` answers them in fixture mode (`vite --mode fixtures`), with its parameters in its header.

| Case | Fixtures | Parameter |
|---|---|---|
| No needs yet | `need.list.empty` (every kind unanswered), `status.needs-none` (no `needs` field), `need.publish.refused-none` | `?needs=empty`, `?fixture=status.needs-none` |
| Several kinds, a given, one kind "nothing to say", a retired need, published once and changed since | `need.list.several` (default), `status.needs-unpublished` (`saved.not_saved` `needs_unpublished`); on the way `need.list.answered-some`, `need.list.published` | `?needs=several\|answered-some\|published`, `?fixture=status.needs-unpublished` |
| Everything published, one ADR behind a need | `need.list.adr-behind` (`adrs_behind: [{adr: ADR-0001, need_id: TN-01, served_revision: 1, revision_now: 2}]`, nothing unanswered), `status.needs-adr-behind`, `need.publish.again` | `?needs=adr-behind`, `?fixture=status.needs-adr-behind` |
| A given | `need.add.given` (said by "Jo Bloggs, CTO", on 2026-11-02), and in `need.list.several` and `.adr-behind` | `?need-add=given` or a `given` sent |
| The acts and their refusals | `need.add`, `.data`, `.refused-technology`, `.refused-given-without-who`; `need.set` (a new revision), `.why`, `.refused-retired`; `need.retire`; `need.none`, `.refused-has-need`; `need.publish` (GitHub and the folder) | `?need-add=`, `?need-set=`, `?need-none=`, `?publish-needs=` |
| Another product manager's newer needs | `refresh.needs-newer-elsewhere`, `need.list.newer-elsewhere`, `status.needs-newer-elsewhere`, `need.publish.refused-newer-elsewhere`, `reconcile.needs` (theirs), `reconcile.needs.refused-nothing-newer` | `?needs=newer-elsewhere`, `?refresh=refresh.needs-newer-elsewhere`, `?reconcile-needs=` |
| No design | `design.list.empty` | `?designs=empty` |
| Imported, not mapped | `design.import`, `design.import.again`, `design.list.imported`, `design.show.unmapped`, `design.show.lines` (`--lines 5-9`), `design.publish.refused-no-map` | `?designs=imported`, `?design=unmapped\|lines`, `?import-design=again` |
| Mapped, one conflict unsettled (line 22 against TN-01) | `design.map`, `design.show.mapped`, `design.list.mapped` (default), `status.designs-unsettled`, `design.publish.refused-unsettled`, `design.settle.refused-no-conflict` | `?designs=mapped`, `?publish-design=refused-unsettled` |
| Settled and published | `design.settle` (design-is-wrong, with the reason), `design.show.settled`, `design.publish`, `design.publish.again` (nothing changed), `design.show.published`, `design.list.published`, `status.designs-published` | `?designs=published`, `?design=settled\|published`, `?publish-design=again` |

`?refuse=<operation>` gives the engine's real refusal for the acts. The needs conversation in fixture mode is scripted: `features/needs/shell/dev/scriptedNeedsConversation.ts`, loaded only under `vite --mode fixtures` by `useNeedsConversation` (the production build was checked not to contain it). It reads the needs, asks the engine's own questions one at a time with no recommended answer, records a need (`draft_changed: needs`), asks who decided a named technology, describes a refused publish, records a design's map (`draft_changed: design`) and names the conflict that waits, ends one turn at its spending limit, then ends. `?speed=fast`; `?conversation=conflict|unavailable|refused`.

## 5. Routes and pages

- **"Technical needs"** is a destination at order 21, between "Vision and outcomes" (20) and "Product principles" (22), so it sits beside Vision in the "More" menu and the home's row of links: `/needs`.
- **"A design you already have"**: `/needs/design` (the designs brought in) and `/needs/design/:designId` (one design). Reached from Technical needs by a link.
- **Breadcrumbs**: Project / Technical needs / A design you already have / `DES-01 architecture.md` (`needsBreadcrumb`, in `Layout.tsx` beside Shape's).
- Each page is a placeholder in `ScreenFrame` that loads its data through the client and shows loading, error (with "Try again") and empty states from the shared components (`LoadingState`, `ErrorState`, `EmptyState`, `NotBuiltYet`); an ID that is not `DES-NN` is never sent. The lead is the engine's `note`, the next step the engine's `next`. No page shows or offers an ADR act, and none says "architecture" (tested).

## 6. Who owns what

Paths under `web/apps/product-studio/src/features/needs/`.

| Engineer | Folder | Starts from | Data |
|---|---|---|---|
| 1. Technical needs | `technical/` | `TechnicalNeedsScreen.tsx` | `useNeedList()` (`need.list`: `needs`, `kinds` with each question, `unanswered`, `nothing_to_say`, `published`, `unpublished_changes`, `adrs_behind`, `next`, `note`); `useNeedsStatus()` (`status.needs`, the home's view); `useNeedsConversation()` (the conversation beside the list; `session.capabilities.needs_command` for "Continue in Claude Code"); acts `need.add`, `need.set`, `need.retire`, `need.none`, `need.publish`, `reconcile.needs`; `refresh` for `needs_taken` |
| 2. A design you already have | `design/` | `DesignListScreen.tsx`, `DesignScreen.tsx` | `useDesignList()` (`design.list`); `useDesignShow(id, lines?)` (`design.show`: `design`, `sections`, `fenced` text as data, `topics_to_map` with what each means, `map` with `topics`, `other`, `conflicts` and their `settled_means`, `unsettled`, `published`); acts `design.import` (`uploadFile(file, uploadLimits.design, "design.import")`), `design.settle` (three equal choices, the PM's reason), `design.publish` (`ways_on`: what to commit); `useNeedList()` for what a conflict names (a TN) |

**Shell (nobody else edits):** `features/needs/index.tsx`, everything in `features/needs/shell/` (`paths.ts`, `useNeeds.ts`, `useNeedsConversation.ts`, `LoadStates.tsx`, `dev/scriptedNeedsConversation.ts`), `router.tsx`, `Layout.tsx`, `features/registry.ts`, `shared/**`, `api/**`, `dev/**` (with `needsFixtures.ts`, `needsTransport.ts`), `web/packages/ui/**`, `web/fixtures/**`, `apps/studio/**`, `test/needs-shell.test.mjs`. A new fixture is made by adding to `needs_memory.py` and regenerating, never by hand; `needsFixtures.ts` gets its row. The fenced design text is shown as plain text (`shared/unfence.ts`, `shared/QuotedLines.tsx` and `shared/lineRanges.ts` already serve the PRD's), never followed.

## 7. Tests

- **Go** (`apps/studio`): the allowlist with the twelve and `design.map` unreachable, their kinds (reads read-only and local; publishing the needs and choosing a version reach GitHub; every other act stays here; only `design.import` carries a file), the argument vector for each (`ops_needs_test.go`'s cases run in `TestEveryOperationsArgumentVector`), the refusals before the engine (`TestNeedsOpsTheHostRejects`), `WritesNeeds` for every act and none for reads, Shape or other operations; the needs mode (`interview/needs_test.go`, 6 tests); over HTTP (`server/needs_test.go`, 2 tests) and the session's `needs_command`.
- **Python**: `tests/test_mach_product_host.py` gains `test_the_m17_needs_and_design_operations_write_the_same_bytes_as_the_terminal`: every needs and design operation through the host (the design as an upload) and through `studio.py`, the map recorded by `studio.py` in both, leaves byte-identical files in Product Studio's workspace (the map's record of the published design.json's hash is masked: it hashes the moment a conflict was settled), the same refusals, nothing staged left, and a clean checkout.
- **Web**: the fixture shape checks compile (`needsFixtures.ts`, 48 files); `test/needs-shell.test.mjs` (the paths and breadcrumb; the destination beside Vision and the three routes; every state the screens start from, in the real fixtures; every needs and design fixture in the app's wording; no ADR act and no "architecture" in the pages); the e2e conformance suite's allowlist names the twelve operations.

## 8. Not done, or for the screen engineers to know

- The screens themselves (placeholders only).
- `skills/product-studio/SKILL.md` still says the needs and design commands are terminal only and the app does not show them yet; that becomes untrue with the screens, and is for whoever builds them to change. The skill's routing gained one line, so `/mach:product-studio needs` reaches **Technical needs**.
- After a map, `references/design.md` says the conversation may propose needs the document states; in the app it records them with `need add` like any other, with the PM's words.
- The needs conversation is not tried with a real Claude Code here; the stand-in proves its arguments, rules and events.
- A design brought in while a turn is running gets its `design map` rule from the next turn, since the rules are built when a turn starts.
- The e2e lifecycle and accessibility suites were not run (they take screenshots), and no screenshot was taken.

## 9. Technical needs screen

Built in `web/apps/product-studio/src/features/needs/technical/` on the shell above; the placeholder is gone.

- **Layout.** A work screen (M16 layout) with the guided question screen's two columns (style guide 8.10, `WorkPanes split="conversation"`): the needs conversation on the left, its heading and acts (Interrupt, Save and pause, Stop) kept at the pane's top; the needs it records beside it, on `surface`. The context row holds the page's acts: "Add a need" and the publish act ("Publish the needs", "Publish the changes" or "Finish publishing", the one primary). The page's lead is behind "About this page" and is the page's own sentence, not `need.list`'s `note`, which names the engineer's side in words this page does not use.
- **The needs pane**, top to bottom: the waiting notice while the conversation writes; a failed publish, GitHub out of reach, needs taken from GitHub (`refresh.needs_taken`) and the check's warnings, each a banner; the reconcile choice when someone else published newer needs (or a publish was refused for it), two equal buttons, "Keep mine" and "Take their version", each confirmed; "With the engineer" (the publishing state as word, shape and tone, what is not published in a sentence, and the facts of the last publish behind a fold) or, with nothing said yet, the invitation; the engine's `next`; the six kinds in the engine's order, each with its name, its state (Answered, Nothing to say, Not answered yet), the engine's question and its active needs; retired needs behind a fold; a link to "A design you already have".
- **A need** shows its ID and revision, the statement, why, and for a given who said it and when. Its acts are "Change TN-NN" (a dialog; a given also asks who and when, nothing else does) and "Retire TN-NN" (confirmed, danger). An unanswered kind offers "Add a need" and "Nothing to say" (confirmed). A refused statement is shown under the statement in the engine's words, with "Record it as a given instead", which keeps the words and asks who and when.
- **Decisions.** Under a need, read only, each decision the engine lists in `adrs_behind` for it, by its number (or file), "Written for revision N", and that an engineer decides whether the change matters. `need.list` reports only the decisions behind a need, not every decision that serves one, so a need with none behind shows none. No decision act exists on the page.
- **Publishing.** The dialog says what is published (the counts, the kinds with nothing to say, the kinds not answered yet) and both places it can go. After it, where it went (the project's issue, and always the folder) and the engine's `ways_on` stay on the page under "With the engineer" as well as in the dialog.
- **Waiting.** While a turn runs (`conversationBusy`, the same rule as Shape's conversation) every act is disabled and the pane says why; a `conflict` from the host is shown in the act's dialog in its words.
- **Conversation.** The needs conversation (`useNeedsConversation`), drawn as Shape's Explore draws its own (its transcript, `ReplyField` and pane-end behaviour are reused, exported from `features/shape/explore/Conversation.tsx`), with the needs' words: an open question with "Nothing to say" and "I don't know", never a recommended answer. When Claude Code cannot run here it shows `capabilities.needs_command` to run in Claude Code. A need it records (`draft_changed`) is read again.
- **Tests**: `test/needs-technical.test.mjs` (17), on the real fixtures: each state, the arguments of each act and the operations the folder sends, the refusals in the engine's words, the waiting state, the two equal choices, no decision act and no "architecture".

**Wording.** The engine's `ways_on` and `need.list`'s `note` say "the engineers read the needs from there when they record their decisions"; neither uses the word "architecture", so the page can show them as written.

## 10. A design you already have: screens

Built on section 6's row 2, in `web/apps/product-studio/src/features/needs/design/`, with the frontend-design skill and the style guide; the PRD on-ramp's pages are its model.

- **The list** (`/needs/design`, `DesignListScreen.tsx`): one pane, as the PRD list. "Bring in a design" takes one file through `uploadFile(file, uploadLimits.design, "design.import")`; the host's size and name checks are said before the pick, and the engine's refusals are shown in its words ("Not brought in"). Each design shows its file name, ID, "Markdown, 5 sections, 22 lines", one line on what it decides, and where it stands as a pill: Not read yet, N conflicts waiting, Ready to publish, Published, Changed since published, Copy changed. The empty state says what bringing one in does and does not do.
- **One design** (`/needs/design/:designId`, `DesignScreen.tsx`): two panes (M16). The wide pane is the path as three numbered parts, one open: **What it decides** (the required topics in the engine's `topics_to_map` order, each Decided, Partly decided with what it leaves out, or Silent, the summary, what the topic covers, and the cited lines behind a fold; then the decisions outside those topics), **Settle the conflicts** (`ConflictsSection.tsx`) and **Publish** (`PublishSection.tsx`). The narrow pane keeps where it stands, its counts and the whole document numbered as data (from the fence only, `designLines`).
- **Not read yet**: the page has no conversation of its own. It sends the product manager to the needs conversation on Technical needs (a link) and shows `capabilities.needs_command` for Claude Code, then lists the topics it will be read for. One conversation reads the needs and the designs, so a second one here would only compete for the same lock.
- **A conflict**: the cited lines beside the technical need, principle or policy statement it contradicts (read from `need.list`, `principle.list` or `policy.list`, only for the kinds named), MACH's note, and three equal choices in the engine's order, none chosen and none marked, each needing the reason (one line, at most 300). The words follow the engine's own meanings (`design.py` `SETTLE_WORDS`): "The design stands" (the engineer weighs it against the other), "The design is wrong" (on this point), "Ask the engineer" (the engineer decides). The confirmation is secondary, as on the verdict. A settled conflict shows the word, the engine's meaning, the reason quoted, who and when, and can be settled differently.
- **Publishing**: disabled while a conflict waits, with the engine's own sentence beside it (its refusal without "Nothing was published:", tested against the refusal); refusals (the copy changed, the topics changed since the map) in the engine's words; the result shows the engine's note, its `ways_on`, the folder and its files.
- **While the conversation writes**: `useNeedsWriting` watches the needs conversation through the shell's `useNeedsConversation` (it never starts or answers it). While a turn runs, a notice says the acts wait and every act's button is disabled; when the turn ends the page reads the design again, as the turn may have recorded a map. A `conflict` answer from the host is still shown in its words.
- **Fixtures added** (from the real engine, `needs_memory.py`'s `design_states`): `design.settle.stands`, `design.settle.ask-engineer`, `design.show.changed-since-published`, `design.list.changed-since-published`, `design.publish.refused-topics-changed`, `design.import.refused-binary`, `design.list.changed-copy`, `design.show.refused-changed-copy`, `design.publish.refused-changed-copy`; their rows in `dev/needsFixtures.ts`; in `dev/needsTransport.ts`, `?designs=changed-since-published|changed-copy`, `?design=changed-since-published|refused-changed-copy`, `?import-design=refused-binary`, `?publish-design=refused-topics-changed|refused-changed-copy`, `?refuse=design.import`, and `design.settle` answering by the way sent.
- **Tests**: `test/needs-design-model.test.mjs` (13): every stage from the real fixtures, the fence, the topics in order, the three choices equal and none chosen, a reason required, each act's operation and arguments, publishing disabled with the engine's sentence, the refusals shown, the waiting state, no act on an engineer's decision and no "architecture" in the pages.
- **Not checked by eye**: no screenshot was taken; fitting the window at 1440 by 900 and 1024 by 768 follows the shared pieces but was not measured. The engine's `ways_on` sentence and a brought-in file's own name can contain the word "architecture"; they are shown as the engine and the person wrote them.

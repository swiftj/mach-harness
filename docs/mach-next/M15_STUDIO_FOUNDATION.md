# M15, as built: the foundation for the new Product Studio screens

M13 and M14 gave Product Studio's engine (`skills/product-studio/scripts/studio.py`) principles, policy packs, effects on shipped behaviour, how an epic works today, the PRD on-ramp, Jira keys and the export, design mocks and requests in the idea template. The visual app could reach none of it: its host (`apps/studio`) runs a fixed list of engine operations. This step lays what the three screen engineers would otherwise collide on: the host operations, the upload and download paths, the typed client, the fixtures, and the routes with empty pages. No screen content was built. `skills/` was not changed.

## 1. Host operations

Each is one row in the host's fixed list (`apps/studio/internal/engine/ops_product.go`), a typed argument struct that becomes one fixed argument vector after `studio.py --project <root> --app`. Options are always `--name=value`, so no value can be read as another option; unknown fields, wrong types and trailing data are refused before the engine runs (`engine.Decode`); identifiers are checked against the engine's own patterns.

| Operation | Arguments (JSON) | Engine command | Kind |
|---|---|---|---|
| `principle.list` | `{}` | `principle list` | reads (prepares the workspace) |
| `principle.add` | `{title, statement, reason}`, each one line | `principle add --title= --statement= --reason=` | on the PM's word |
| `principle.set` | `{principle_id: "PP-01", title?, statement?, reason?}`, at least one | `principle set PP-01 [...]` | on the PM's word |
| `principle.retire` | `{principle_id}` | `principle retire PP-01` | on the PM's word |
| `principle.publish` | `{}` | `principle publish` | on the PM's word; may reach GitHub |
| `reconcile.principles` | `{take: "mine"\|"theirs"}` | `reconcile principles --take=` | on the PM's word; reads GitHub's record |
| `policy.list` | `{}` | `policy list` | read-only |
| `policy.accept` | `{slice_id, policy_id: "POL-<pack>-NN", by, reason}` | `policy accept SLICE POL --by= --reason=` | on the owner's word |
| `epic.current` | exactly one of `{epic_id}` or `{issue}` | `epic current <EPIC\|n> --json` | read-only, local Git only |
| `epic.link` | `{epic_id, jira: "KEY-1"}` or `{epic_id, remove: true}` | `epic link EPIC --jira=\|--no-jira` | on the PM's word |
| `slice.link` | `{slice_id, jira}` or `{slice_id, remove: true}` | `slice link SLICE --jira=\|--no-jira` | on the PM's word |
| `jira.export` | `{epic?, state?: "ready"\|"all", flavour?: "cloud"\|"data-center"}` | `jira export [...]`, never `--out` | on the PM's word; writes files offered for download |
| `jira.keys` | `{file: Upload, dry_run?}` | `jira keys <staged .csv> [--dry-run]` | on the PM's word |
| `prd.import` | `{file: Upload}` | `prd import <staged .md\|.markdown\|.txt\|.text>` | writes the workspace |
| `prd.list` | `{}` | `prd list` | read-only |
| `prd.show` | `{prd_id: "PRD-01", lines?: "40-80"}` | `prd show PRD [--lines=]` | read-only |
| `prd.map` | `{prd_id, map: {...}}` (JSON, at most 1 MiB) | `prd map PRD --from=<staged map.json>` | writes the workspace |
| `prd.settle` | `{prd_id, section, as: "slice", slice: "M2", reason?}` or `{prd_id, section, as: "out-of-scope"\|"later", reason?}` | `prd settle PRD --section=N --as=slice:M2\|out-of-scope\|later [--reason=]` | the PM's word |
| `prd.status` | `{prd_id}` | `prd status PRD` | read-only |
| `prd.apply` | `{prd_id}` | `prd apply PRD` | on the PM's word |
| `prd.draft` | `{slice_id, answers: {...}}` (JSON, at most 1 MiB) | `prd draft SLICE --from=<staged answers.json>` | writes the workspace |
| `prd.confirm` | `{slice_id, accept?: "all"\|[n...], discuss?: [n...]}`, at least one | `prd confirm SLICE [--accept=] [--discuss=]` | on the PM's word |
| `slice.mock.add` | `{slice_id, file: Upload, for?: "AC-01", binding?, note?}`; `binding` needs `for` | `slice mock add SLICE <staged picture> [--for=] [--binding] [--note=]` | on the PM's word |
| `slice.mock.remove` | `{slice_id, mock: "<8 to 64 hex>"}` | `slice mock remove SLICE <hex>` | on the PM's word |
| `slice.mock.list` | `{slice_id}` | `slice mock list SLICE` | read-only |

`request.show`, `slice.resume`, `slice.show`, `slice.check`, `status` and `refresh` needed no new operation; their new fields are typed (section 3).

Not on the list, deliberately: `acceptance record` (still terminal only), `jira export --out` (the host never names a folder), `request pick --id`.

**The guided interview** cannot call any of these. Its deny list (`apps/studio/internal/interview/command.go`, `deniedOps`) gained `principle`, `policy`, `epic link`, `slice link`, `epic current`, `jira`, `prd` and `slice mock`, in every spelling the existing rules cover; its allow list is unchanged, so none of them was ever allowed; and the host's note to the interviewer names them as the product manager's buttons. Tested in `interview_test.go`.

## 2. Uploads and downloads

**Upload.** A file the person chooses travels inside the operation's JSON body as `{"name": "...", "content_base64": "..."}`. It therefore passes every check every request passes: the session cookie, an exact `Host`, `Origin`, the `X-MACH-CSRF` token and `Content-Type: application/json`. The host never parses a multipart body. Then:

1. The body is bounded per operation (`Operation.MaxBody`): the base64 of the file's limit plus 64 KiB. Other operations keep 64 KiB. Larger is `413`, whole.
2. The host checks only the name and the size: the extension against the operation's list, the decoded size against its limit (PRD 512 KiB, picture 5 MiB, Jira CSV 8 MiB, the engine's own limits; a map or drafted answers 1 MiB of JSON, which must be an object or a list). It never reads, parses or interprets the content: the engine judges that (a text file named `.png` is the engine's refusal, in its words).
3. The name is reduced to a plain base name: any folder part dropped, characters other than letters, digits, dot, space, underscore and hyphen replaced by a hyphen, no leading dot, hyphen or underscore, at most 100 characters, the extension lower-cased. The engine records a PRD's name, so a plain name arrives as given.
4. Under the project lock, the file is written to `.factory/studio/uploads/<random>/<name>` (inside Product Studio's own git-ignored folder, beside the draft workspace, never inside it): every folder checked with `Lstat` (no symbolic link, nothing that is not a folder), the file created exclusively and without following links. The engine is given that one path. The random folder is removed afterwards whatever the engine answered, and the uploads folder too when empty; anything a stopped host left there is removed at the next start (`security.ClearUploads`). Code: `apps/studio/internal/security/uploads.go`, `internal/engine/upload.go`, `engine.Do`.

In the app: `uploadFile(file, uploadLimits.prd | .mock | .jiraKeys, operation)` from `@mach/ui/api` checks the same extension and size first and builds the object.

**Download.** `jira.export` is the only operation that writes files the person must then get. After a successful export the host reads the two files the engine names (`mach-jira.csv`, `README.txt`), accepting them only at `.factory/studio/jira/<cloud|data-center>[-EPIC-NNN][-all]/<file>` with no symbolic link on the way and a regular file at most 16 MiB, keeps their bytes in memory under one random token, and adds `downloads: [{name, url, bytes}]` to the answer. `GET /api/downloads/<token>/<name>` serves exactly those bytes as an attachment (`text/csv` or `text/plain`, `Content-Disposition: attachment`, `no-store`, `nosniff`). A later change on disk is not served; a new export replaces the set and the old token stops working; nothing else can be named. It needs the session like every API route, and a failure is the envelope. Code: `apps/studio/internal/server/downloads.go`.

**Limits.** Files are held whole in memory while they are checked (the largest body is about 11 MiB). Downloads last for the host's life only. The pictures attached as design mocks are not served back to the browser (no screen needs them yet; `slice.mock.list` gives their facts).

## 3. Typed client and fixtures

`web/packages/ui/src/api/types.ts`: every new operation in the `Operations` table with its argument and result types; the five request operations promoted there from the Inbox (`features/inbox/requests/api.ts` now re-exports them); new fields on existing results: `Status.principles` and `prds`, `StatusSliceRow.principles` and `shipped_moved`, `Refresh.shipped_moved`, `principles_taken` and `github.principles`, `SliceCheck.prd_problems` and `shipped`, `SliceResume.principles`, `policies`, `shipped_rules`, `prd` and `request` (with `questions_to_ask_first`), `SpecModel.effects`, `principles` and `policies`, `WorkOrder.tracking`, `mocks`, `source` and `origin`, `Epic.tracking`, `SliceReadyOnGithub.mocks`, `RequestShown.idea`. `readOnlyOperations` and `personalActs` cover the new operations (every act the engine does "on the word" is a personal act, confirmed in a dialog). `SliceCheck.title` and `risk` became optional (the engine leaves both out without a spec) and `WhySection.fields` values may be undefined. `web/packages/ui/src/api/upload.ts`: `uploadFile`, `toBase64`, `sizeWords`, and `uploadLimits`.

Fixtures: `web/fixtures/product_memory.py`, called by `generate.py`, drives the real engine with `--app` in the engine tests' own repositories and stand-ins for gh, and saves 80 new files (all fixtures were regenerated; the older ones gained the M13 and M14 fields the engine now reports). `web/apps/product-studio/src/dev/productMemoryFixtures.ts` imports each through a compile-time shape check against the types; `src/dev/memoryTransport.ts` answers every new operation in fixture mode (`vite --mode fixtures`), with the parameters its header lists.

| Awkward case | Fixtures |
|---|---|
| An open flagged concern | `slice.show.open-concern`, `slice.check.open-concern`, `slice.ready.refused-open-concern` (`?show=open-concern`, `?ready=refused-open-concern`) |
| The owner's acceptance | `policy.accept`, `slice.show.concern-accepted`, `policy.accept.refused` |
| A principle answered under an older revision; unpublished changes | `status.principles`, `principle.list.unpublished` (`?fixture=status.principles`) |
| Newer principles published by someone else | `refresh.principles-newer-elsewhere`, `principle.list.newer-elsewhere`, `principle.publish.refused-newer-elsewhere`, `reconcile.principles` |
| A kept, a replaced and a retired shipped rule | `epic.current`, `epic.current.after-retire`; nothing shipped: `epic.current.nothing-shipped` |
| A draft whose kept rule was then retired | `status.shipped-moved`, `refresh.shipped-moved`; no effects section: `slice.check.effects-missing` |
| An uncovered PRD section | `prd.status.uncovered`, `prd.apply.refused-unsettled`, `prd.status.one-left`, `prd.settle`, `prd.settle.out-of-scope` |
| Drafted answers waiting; a contradiction | `prd.draft`, `slice.check.prd-pending`, `prd.confirm`, `prd.confirm.refused-contradiction` |
| A slice waiting for its mocks to be committed | `slice.ready.with-mocks` (`?ready=with-mocks`) |
| A row in a Jira keys file that names nothing, a malformed key, a key already set | `jira.keys`, `jira.keys.dry-run` |
| A request in the idea template | `request.show.idea`, `request.pick.idea`, `slice.resume.idea-request`; in the Inbox's fixture list as request #48 |

## 4. The shell and who owns what

The app's information architecture is unchanged: the project home leads everywhere, the top bar's "More" menu lists the secondary screens, and the breadcrumb says where you are. Added:

- Four "More" destinations (also in the home's row of links): Product principles (`/principles`), Policy packs (`/policies`), Start from a PRD (`/prds`), Jira (`/jira`).
- A slice's own pages, shown as a row of tab links under the slice's header on its specification and on each page (`shared/SliceSections.tsx`): Specification, Effects on shipped behaviour (`/slices/:id/effects`), Principles and policies (`/slices/:id/policies`), Design mocks (`/slices/:id/mocks`), and From the PRD (`/slices/:id/prd`, only for a slice made from one).
- On each epic of the project home, a link "How <epic> works today" (`/epics/:id/today`).
- `/prds/:prdId` for one PRD.
- `shared/ScreenFrame.tsx`: `ScreenFrame` (page width, the one h1, the lead sentence), `SliceScreenFrame` (the slice's title, its tabs, the page) and `NotBuiltYet` (what each empty page says until it is built).

Every new page renders its frame and a plain empty state. **Ownership** (paths under `web/apps/product-studio/src/`):

| Engineer | Owns (edit freely) | Data |
|---|---|---|
| 1. Principles, policy packs, flagged concerns | `features/principles/PrinciplesScreen.tsx`, `features/policies/PoliciesScreen.tsx`, `features/policies/SlicePoliciesScreen.tsx`, and any new file under `features/principles/` or `features/policies/` | `principle.*`, `reconcile.principles`, `policy.*`, `slice.show` model `principles`/`policies`, `status.principles`, `slices[].principles` |
| 2. Effects, how an epic works today, the PRD on-ramp | `features/effects/SliceEffectsScreen.tsx`, `features/epic-today/EpicTodayScreen.tsx`, `features/prd/PrdListScreen.tsx`, `features/prd/PrdScreen.tsx`, `features/prd/SlicePrdScreen.tsx`, and any new file under those three folders | `slice.show` model `effects`, `check.shipped`, `slice.resume` `shipped_rules`/`prd`, `slices[].shipped_moved`, `epic.current`, `prd.*` |
| 3. Jira, design mocks, requests in the idea template | `features/jira/JiraScreen.tsx`, `features/mocks/SliceMocksScreen.tsx`, any new file under `features/jira/` or `features/mocks/`, and `features/inbox/requests/**` (RequestCard and RequestDialogs show the idea's parts and the questions to ask first) | `epic.link`, `slice.link`, `jira.*` (with `downloads`), `slice.mock.*`, `slice.ready` `mocks`, `request.show` `idea`, `request.pick`/`slice.resume` `request.questions_to_ask_first` |
| Shell (nobody else) | `router.tsx`, `Layout.tsx`, `features/registry.ts`, `features/types.ts`, every `features/<name>/index.tsx`, `shared/ScreenFrame.tsx`, `shared/SliceSections.tsx`, `api/**`, `dev/**`, `web/packages/ui/**`, `web/fixtures/**`, `apps/studio/**` | |

A screen engineer who needs something shared builds it in their own folder and names it for promotion, as in M5 (`M5_CONTRACT.md` 8.3). A new fixture is made by adding to `web/fixtures/product_memory.py`, never by hand.

## 5. Tests

- Go (`apps/studio`): the allowlist and its kinds (`ops_test.go`, which also requires every vector to start with one of the engine's own commands and never carry `--out`, `--project` or `--app`); an argument-vector case for every new operation; the refusals before the engine (bad identifiers and keys, one-line fields, exactly-one choices, extensions, sizes, base64, unknown fields such as `out` or `path`) (`ops_product_test.go`); plain staged names; the real engine through staging, with nothing left behind after success or a refusal, and a symbolic link where the staging folder goes refused; the server's download route (exactly the export's bytes, a later change on disk not served, no session, another host name, another method, other names and tokens, a new export replacing the set) and upload bounds, origin and CSRF (`internal/server/m15_test.go`); the interview's deny list; the boundary scan, unchanged.
- Python (`tests/test_mach_product_host.py`): every new operation through the host, with files as base64, and the same operations through `studio.py` leave byte-identical files in Product Studio's workspace; the export is downloaded exactly as written; nothing staged is left; the checkout is clean.
- Web: the fixture shape checks compile; the e2e conformance suite's allowlist names the new operations.

## 6. Not done, or for the screen engineers to know

- **Drafted PRD answers in the app.** In the terminal the model writes the drafted answers and runs `prd draft`. In the app the interviewer may edit only the slice's spec and why, and `prd` is denied to it, so it cannot record them; `prd.draft` exists on the host for whatever produces them. Letting the interviewer record drafted answers would need its allow list widened for `prd draft <own slice> --from=<a file it may write>`; that is a decision, not done here.
- **Terminal words in some refusals.** In `--app` mode the engine still names commands in a few refusals and notes (`policy accept` in the open-concern finding, `reconcile principles --take mine|theirs`, `principle publish`, `slice link ... --jira`). That is the engine's wording (`skills/`, not changed here); the screens show refusals as written.
- **`shipped_rules` is fenced text only.** The structured rules are in `epic.current`; per slice there is no structured list of the shipped rules in force.
- **Design mock pictures are not served** to the browser; showing them would need a read route confined to `product/mocks/SLICE-NNN/<sha256>.<ext>`. (Done in the clean-up pass, section 7.)
- The e2e lifecycle and accessibility suites were not run (they save screenshots); see the report for what was.

## 7. The clean-up pass after the screens

After the six screen engineers, one pass did what each reported it needed from outside its folder.

**Engine** (`skills/product-studio/`, `skills/intent/`; terminal output keeps its meaning):

- `policy list`: each pack's `statements` is now the list `[{id, text}]`, each text bounded to `policies.STATEMENT_LIMIT` (400 characters, the same bound the interview's fenced text uses), in place of a count.
- `status`: each epic row and each slice row carries `tracking: {jira: KEY}` with the item's own key, and nothing when it has none, so the Jira page reads every key from `status` and makes no per-slice read.
- `status.saved.not_saved` lists unpublished product principles (`principles_unpublished`), or `principles_unfinished` when publishing stopped part way, so the top bar never says "Everything is saved" while principles wait.
- The spec model's `effects` rows carry `line`, the row's line in the spec (also in `spec.json`).
- `slice show` carries the same `prd` field as `slice resume`, read only; "From the PRD" uses it, so opening that tab no longer makes the slice the current one.
- App wording: every M13 and M14 refusal and note that named a terminal command says the page or button in `--app` mode (`say()`; `PrdError` and `HandoffError` gained an `app` wording; the shared validator's and `policies.accept`'s words are reworded by `studio.APP_FINDING_WORDS` for the app only, since the Factory keeps them). `AppWordingTest` gained a check over every string the new commands can show (`prd.py`, `mocks.py`, `jira_export.py` whole, and the `principle`, `policy`, `slice link`, `epic link`, `epic current` and principles-publishing code in `studio.py` and `handoff.py`): any command, option or script name outside the terminal half of `say()` fails it. README.txt for Jira is the one exception: a file for whoever imports, written the same both ways so the host and the terminal leave identical files.
- Tests: `tests/test_mach_studio_m15_engine.py`, and the two new `AppWordingTest` cases.

**Host** (`apps/studio`): `GET /api/slices/<SLICE-NNN>/mocks/<sha256>` serves a draft's own design mock (`internal/server/mocks.go`), behind the session, exact Host and origin checks every route has: the ID checked against the engine's pattern and the hash as exactly 64 lower-case hex (else 400); only `.factory/studio/draft/product/mocks/<SLICE>/<sha256>.png|.jpg`, every folder checked with `Lstat` through `security.ResolveDraft`, opened with `O_NOFOLLOW`, a regular file of at most 5 MiB, the bytes hashed again and refused unless equal to the hash; the type from the leading bytes (PNG or JPEG, anything else refused); `nosniff`, `no-store`, `inline`. Every refusal is the envelope with 404 and no detail of which check failed. Tests in `internal/server/mocks_test.go`. The Design mocks tab shows each picture (opening it full size), with alternative text built from what it is for (its scenario and title, binding or not, the product manager's note), and its record beside it; when the host cannot show it (changed, missing, or fixture mode), the frame says so in words.

**Types, routing and shell** (`web/`):

- `@mach/ui/api` types: `PrinciplesPublishResult` folder `why_folder`; `OwnerCheck`, `PolicyAccept.owner_check` and `owner_check_note`, `PolicyConcern.owner_check`; `StatusSliceRow.policies_changed` and `tracking`; `StatusEpicRow.tracking`; `PolicyPack.statements` as the list; `PolicyList.problems` as sentences; `EffectRow.line`; `EpicView.not_applied` and `conflicts` typed; `SliceShow.prd`; the two new `not_saved` kinds. Each screen's local stand-in and defensive narrowing went: the policies model's five stand-in types and its problem-object reader, the principles model's `why_folder` cast, the epic view's `notApplied`/`conflicts` readers, the effects model's scan of the spec text for row lines (`effectRowLines`), and the Jira page's per-slice `slice.show` reads, learned-key store and "not read yet" states (`features/jira/data.ts` removed).
- `routeForHint`: `{kind: "reconcile", target: "principles"}` goes to `/principles`; every hint kind the engine names has a route (`test/next-actions.test.mjs`).
- `@mach/ui/sections` (`packages/ui/src/spec/sections.ts`, pure): the section map now places "Effects on shipped behaviour", "Principles" and "Policies", and rule codes with no section (`effects-*`, `principle-*`, `policy-*`) by `specSectionOf`. The effects and policies screens use it instead of filtering themselves. The specification page lists those findings under their own headings with a link to the slice's page for them, and its "On this page" list names them when they have findings. `@mach/ui/ids` exposes `artifactKind` the same way, so the routing can be unit-tested.
- `MarkReadyDialog` remembers the ready answer (`rememberReadyAnswer`) and shows `MocksToCommitPanel` in its saved state when the answer has mocks; the reopen dialog forgets it. Both moved to `shared/` (`shared/MocksToCommit.tsx`, `shared/mocksDelivery.ts`).
- The top bar's saved state follows from `status.saved` (item above); no app code was needed beyond the engine.

**Fixtures** (`web/fixtures/product_memory.py`, from the real engine; each reachable by a parameter listed in `src/dev/memoryTransport.ts`): principles published, published to the folder, stopped part way, changed on GitHub, never published, a publish to the folder, a publish refused offline, keep mine (`?principles=`, `?publish=`, the reconcile choice sent); no packs, a malformed pack and a folder without `policy.md`, slices under an older pack, a followed pack, a concern met by changing the spec, principle rows that do not apply and an exception, an owner checked and refused by login (`?policies=`, `?accept=`, `?show=`; the existing accept fixtures now carry the owner check); a spec with no effects section, a section with problems, an epic with `not_applied` and a conflict, specs whose rules cannot be read (`?show=`, `?epic=`); four drafted PRD answers in `slice.show` and `slice.resume` (`?show=prd-drafted`, `?resume=prd-drafted`); `epic.link` with slices already ready (`?link=already-ready`) and a removal, `jira.keys` with slices to reopen and epics with ready slices (`?keys=reopen`), an export with a cut description (`?export=cut`); a work order with four mocks and a list with a problem (`?show=four-mocks`, `?mocks=problem`). The unit tests that built these cases by changing a fixture now read the real ones.

**Left:**

- The Design mocks preview is not shown in fixture mode (the browser fetches the picture from the host, which fixture mode does not run); the frame says the picture is not shown.
- `slice resume` still sets the current slice; the interview needs that. Only the PRD tab moved to `slice show`.
- The validator's own findings are reworded for the app by a table of exact phrases in `studio.py`; a new command named in a shared finding needs a row there (the test checks each row's phrase still exists in the shared checks, and the static check covers Studio's own strings, not the validator's).
- The e2e lifecycle and accessibility suites were not run (they take screenshots).

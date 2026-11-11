# MACH Next — M5 working contract

The shared agreement for everyone building M5 (the visual Product Studio). Read this before writing anything. It fixes the boundaries so parallel work fits together.

Baseline: M4 commit `b2a98c8`, branch `feature/mach-next-m5-product-studio`.

## 1. The one rule

**The Python product engine is the only place product rules live.** `skills/product-studio/scripts/studio.py` (with `collab.py` and `product.py`) decides every ID, state transition, validation, approval, reconciliation, publication and the bytes of every artifact.

The Go host passes typed requests to it. The React app shows what it returns. Neither re-implements a rule. If the app needs something the engine does not report, add a read-only operation to the engine, with a test; do not compute it in Go or TypeScript.

The terminal skill `/mach:product-studio` and the web app must produce byte-identical artifacts for the same operations.

## 2. Layout

```
apps/studio/                  Go module: the local host
  cmd/mach-studio/            main: flags, start, open the browser
  internal/server/            HTTP routing, middleware
  internal/security/          session, Origin/Host, CSRF, path safety
  internal/engine/            the allowlisted dispatcher to studio.py
  internal/interview/         the Claude Code bridge (after the proof of concept)
  internal/webui/             embeds the built React app (dist/)
web/                          pnpm workspace
  packages/ui/                @mach/ui: tokens, themes, primitives, shell, graph, API-client conventions (shared with Control Tower)
  apps/product-studio/        the React application
  apps/showcase/              the component showcase, with realistic data
  fixtures/                   real engine output (generate.py); never hand-edited
docs/mach-next/               this file, DESIGN_SYSTEM.md, M5_INTERVIEW_POC.md, M5_DESIGN.md
```

No Electron, no Go/WASM, no single-file HTML, no CDN: every asset is bundled and served from the Go binary. No second user-facing command: the host is started by the product-studio skill.

## 3. The engine's operations

`studio.py --project <root> <command...>` prints JSON on stdout and exits 0. A refusal exits 1 with `refused: <message>` on stderr. `web/fixtures/*.json` holds the real output of each, as `{exit_code, data, refused}`.

| Operation | Command | Changes state |
|-----------|---------|---------------|
| `where` | `where` | no |
| `status` | `status` | no (brings in fetched work) |
| `validate` | `validate` | no |
| `refresh` | `refresh` | fetches; never touches the checkout |
| `project.init` | `project init --id --name --vision --outcome...` | yes |
| `project.set` | `project set [--name] [--vision] [--outcome...] [--status]` | yes |
| `epic.add` | `epic add --title --criterion...` | yes |
| `epic.set` | `epic set <id> [--title] [--criterion...] [--status]` | yes |
| `epic.approve` | `epic approve <id>` | yes, **approval** |
| `epic.renumber` | `epic renumber <id>` | yes |
| `slice.new` | `slice new --epic --title [--depends-on...] [--id]` | yes |
| `slice.set` | `slice set <id> [--title] [--epic] [--depends-on...]` | yes |
| `slice.resume` | `slice resume [<id>]` | yes (marks interviewing) |
| `slice.pause` | `slice pause <id> --note` | yes |
| `slice.check` | `slice check <id> [--ready]` | bookkeeping only; exit 1 when there are errors, **with JSON on stdout** |
| `slice.approve` | `slice approve <id>` | yes, **approval** |
| `slice.reopen` | `slice reopen <id>` | yes |
| `slice.renumber` | `slice renumber <id>` | yes |
| `wave.new` | `wave new --slice...` | yes |
| `wave.add` / `wave.remove` | `wave add\|remove <id> <slice>...` | yes |
| `wave.approve` | `wave approve <id> [--actor]` | yes, **approval** |
| `wave.renumber` | `wave renumber <id>` | yes |
| `reconcile` | `reconcile <artifact> --take mine\|theirs [--field]` | yes, **a person's choice** |
| `send.preview` | `send <wave> --dry-run` | no |
| `send` | `send <wave>` | **publishes** |
| `feedback` | `feedback [<wave>]` | fetches |

To be added to the engine for the web app, read-only, each with a test:

- `slice.show` — `slice show <id>`: the work order, the spec as the validator's exported model, the spec's markdown, the why split into its sections, and the current check. One call for the Specification Workspace.
- `overview` — only if `status` proves insufficient for the home screen. Prefer `status`.

Known wart to fix in the engine: an offline `refresh` reports the last line of Git's message as `problem` ("and the repository exists."). It should say plainly that the shared repository could not be reached.

## 4. The HTTP API

Loopback only. JSON. Every response is one envelope:

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "kind": "refused" | "invalid" | "unauthorized" | "conflict" | "unavailable" | "internal", "message": "..." } }
```

`refused` is the engine saying no (its message is written for a person and is shown as is). `invalid` is a request the host rejected before the engine saw it. `conflict` is a second request for something already in progress.

| Method and path | Does |
|-----------------|------|
| `GET /api/session` | Who and where: project name and folder name, the CSRF token, capabilities (`interview: true\|false` and why not), versions. |
| `POST /api/ops/<operation>` | One engine operation from section 3. Body: a typed JSON object of that operation's arguments. Returns the engine's JSON as `data`. For `slice.check`, an exit code of 1 with JSON is still `ok: true` (the check ran; its result says what is wrong). |
| `GET /api/drafts/spec/<slice-id>` / `PUT` | Read or replace a draft spec's markdown. A write is confined to the draft workspace, refused for an approved slice, and followed by `slice.check`, whose result is returned. |
| `GET /api/drafts/intent/<slice-id>` / `PUT` | The same for a slice's why. |
| `POST /api/interview` | Start or resume the interview for a slice: `{slice_id}` → `{interview_id}`. `conflict` if that slice already has one running. |
| `GET /api/interview/<id>/events` | Server-sent events: the interviewer's stream (section 6). |
| `POST /api/interview/<id>/reply` | The PM's answer: `{text}`. |
| `POST /api/interview/<id>/stop` | End it. The draft and the saved note remain. |

Argument objects use the engine's own names in snake case (`{"epic": "EPIC-001", "title": "...", "depends_on": []}`). The host turns each into a fixed argument vector from a table; it never builds a command line from text and never invokes a shell.

Mutating operations for the same project are serialised by the host, so two requests cannot interleave engine writes.

## 5. Security requirements for the host

- Bind `127.0.0.1` (and `::1` if asked) on an ephemeral port. Never `0.0.0.0`.
- Start-up prints and opens `http://127.0.0.1:<port>/?t=<one-time token>`. The token is exchanged once for an `HttpOnly`, `SameSite=Strict` session cookie; the token then stops working.
- Every request: `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding protection). Every state-changing request: `Origin` must match, and `X-MACH-CSRF` must carry the session's token.
- No endpoint takes a filesystem path. Artifacts are addressed by ID, validated against the engine's own ID patterns before use.
- Draft writes: resolve inside `.factory/studio/draft/`, refuse symlinks anywhere on the path, refuse `..`.
- Engine calls: fixed interpreter and script paths resolved at start-up, an operation allowlist, a time limit, bounded output.
- **Nothing in this host can reach the Factory.** No operation, route or code path runs `run.py`, `factory ...`, `product dispatch`, the belt, or any station. Product Studio and Factory authority stay separate; a test asserts it.
- Logs and error bodies never contain tokens, cookies or file contents.
- All assets embedded; no request to any other origin at run time. A `Content-Security-Policy` that says so.

## 6. Interview events (provisional until the proof of concept reports)

The host bridges one Claude Code session per interview and re-emits a small, stable set of events so the UI never parses Claude's own format:

| Event | Data |
|-------|------|
| `state` | `starting`, `thinking`, `waiting_for_reply`, `working`, `ended`, `failed` |
| `text` | a chunk of the interviewer's message (streamed) |
| `question` | once a message is complete and is a question: `{number, title, body, recommendation}` parsed from the interview format (`❓ **Q1** - **Title**: ...` / `➡️ ...`) |
| `activity` | a plain description of something the interviewer did (`checked the draft`, `wrote the spec`), never raw tool input |
| `draft_changed` | the spec or the why was written; the UI reloads `slice.show` |
| `ended` | `{reason}` |
| `error` | `{message}` |

The interviewer follows the existing `/mach:product-studio` skill. It may read, write inside the draft workspace, and run the engine's non-approving operations. It may **not** approve, send, reconcile, or touch anything of the Factory's: those are a person's acts, done through the app's own buttons.

## 7. Working rules for the team

- **Stay in your directories.** Each brief names them. If you need a change elsewhere, say so in your report; do not make it.
- **Do not commit, push, or switch branches.** The lead commits each piece after review.
- **Do not weaken a test or a gate** to get something through. Report it.
- **Do not start, enable or install anything of the Factory's**, a LaunchAgent, or a Git hook.
- **No invented data in the product path.** Fixtures come from `web/fixtures/generate.py`; the showcase may compose them.
- **Report honestly:** what was built, what was run and its real output, what was not done or not verified.

## 8. Amendments after the first wave

These replace anything above that they contradict. They record what was built and what the interview proof found (`M5_INTERVIEW_POC.md`).

### 8.1 The API as built (`apps/studio/README.md` is the reference)

- `GET /api/session` → `{project: {folder, path, name|null, project_id|null}, csrf_token, capabilities: {interview, interview_reason}, versions: {host, api, engine_install}, engine_problem}`.
- Operation arguments use the engine's own names. The ones that are not obvious: `{identifier}` for the three renumber operations; `{wave_id, slice_ids: []}` for `wave.add` and `wave.remove`; `{slice: []}` for `wave.new`; `{outcome: []}` and `{criterion: []}` for lists; an empty `depends_on` clears it.
- `validate` and `slice.check` return `ok: true` with their report even when the report says something is wrong.
- `PUT /api/drafts/spec/<slice>` takes `{markdown, name?}` (`name`, such as `invite-teammate`, only for a slice's first spec) and returns `{slice_id, kind, path, check}`. `PUT /api/drafts/intent/<slice>` takes `{markdown}`.
- Every engine call for a project is serialised. A request that waits more than 30 seconds gets `conflict`.
- HTTP status follows the envelope's kind, but clients read the envelope.
- The Content-Security-Policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'`. The production build must work under it unchanged: no inline `<script>` or `<style>`, no `style="..."` attributes in served HTML, and **no asset inlined as a `data:` URI except images** (Vite inlines small fonts by default; that must be switched off).

### 8.2 The interview

One Claude Code session per slice, resumed across interviews and host restarts; one `claude -p` process per reply.

Events (server-sent, replacing section 6's table):

| Event | Data |
|-------|------|
| `state` | `starting`, `thinking`, `working`, `waiting_for_reply`, `ended`, `failed` |
| `text` | `{message_id, delta}` — streamed; may belong to a message that is never final |
| `message` | `{message_id, text, kind}` — once, at the end of a turn, for the reply the PM answers. `kind`: `question`, `confirmation`, `other` |
| `question` | `{message_id, number, title, body, recommendation, preface}` — sent with `message` when it parses as exactly one question. `number` is not unique across sessions; key by `message_id` |
| `activity` | `{kind, text}` — after a tool ran. `kind`: `lookup`, `check`, `save`, `write`, `refused`, `other`. Plain words, never tool input |
| `draft_changed` | `{slice_id, what: []}` — `spec`, `why`, `work_order`; detected by the host |
| `turn` | `{outcome, seconds, cost_usd, session_cost_usd, refused}` — closes every turn |
| `ended` | `{reason}` — `stopped`, `failed`, `host_shutdown` |
| `error` | `{kind, message}` |

Only a parsed `question` gets Yes/No actions. Any other final message is shown as text with a free reply.

Routes: `POST /api/interview {slice_id, idea?}` (the app calls `slice.new` first for a new idea; `conflict` while the slice's lock is held; `refused` for an approved slice), `GET /api/interview/<id>/events`, `POST .../reply {text}`, `POST .../interrupt` (stop this turn, keep the interview), `POST .../stop` (end it; the draft, the saved note and the session remain).

The interviewer may run only `where`, `status`, `validate`, `refresh`, and on its own slice `slice resume`, `slice check`, `slice pause`, `slice set`; it may edit only its own slice's spec and why. Creating slices and epics, and every approval, send and reconcile, are the app's own operations, done by the PM.

The interviewer process, always: `--restricted --strict-mcp-config --permission-mode default --permission-prompts none --tools Read,Glob,Grep,Edit,Write,Bash`, allow rules generated from the interpreter and script paths resolved at start-up (absolute `Edit(//...)` rules; quoted and unquoted spellings of the script path), the skill loaded through a stable one-skill plugin at `.factory/studio/interviews/plugin/`, a minimal environment (never the host's own), the project's real path as working folder, and a spending cap and time limit per turn. A test asserts the exact argument vector. The raw stream never leaves the host.

`capabilities.interview` is false, with the reason, when `claude` is missing, older than 2.1.322, lacks `--restricted` or `--permission-prompts`, or is not signed in. The app then offers "Continue in Claude Code" with the exact command, and says plainly that the interview happens there.

Local interview state lives in `.factory/studio/interviews/` (`<SLICE>.json`, `<SLICE>.lock`, `plugin/`).

### 8.3 Who owns which files in the second wave

The app is split by feature. Each folder under `web/apps/product-studio/src/features/<name>/` exports `feature: Feature` (routes, and a navigation entry if it has one) from `index.tsx`, and is listed in `features/registry.ts`.

| Owner | Files |
|-------|-------|
| shell | `web/packages/ui/**`, and in the app: `Layout.tsx`, `router.tsx`, `main.tsx`, `api/**`, `features/registry.ts`, `features/types.ts`, `features/workspace`, `features/vision`, `features/roadmap` |
| interview | `features/interview`, `features/spec` |
| delivery | `features/inbox`, `features/waves`, `features/activity` |
| host | `apps/studio/**`, `skills/product-studio/scripts/**`, `tests/test_mach_product_studio.py`, `tests/test_mach_product_host.py`, `web/fixtures/**` |

A feature owner who needs something shared (a component, a client method, a type) builds it inside their own feature folder and names it in their report for promotion. Nobody edits another owner's files.

Routes: `/` workspace, `/vision`, `/roadmap`, `/slices/:sliceId` specification, `/slices/:sliceId/interview`, `/inbox` decisions, `/waves` (with the send flow beneath it), `/shared` collaboration and refresh.

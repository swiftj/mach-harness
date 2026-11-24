# mach-studio: the local host for the visual Product Studio

A small Go program that serves the Product Studio web app on the loopback interface. It passes the
app's requests to the Product Studio engine, `skills/studio/scripts/studio.py`, and runs
the guided interview through the person's own Claude Code. The engine decides every product rule;
the host checks the shape and safety of a request, runs one allowlisted engine operation, and
returns what the engine said. The working contract is `docs/mach-next/M5_CONTRACT.md` (section 8
records what was built); this file is the reference for the API as built.

Standard library only. Go 1.27.

```
cmd/mach-studio/     flags, start-up, opening the browser, shutdown
internal/engine/     the operation allowlist: typed arguments -> fixed argument vector -> envelope
internal/security/   start token and session, Host/Origin/CSRF checks, headers, safe local paths
internal/server/     the HTTP routes
internal/interview/  the Claude Code interview bridge: process, permissions, lock, events
internal/webui/      the built web app, embedded (dist/)
internal/testkit/    temporary projects and a stand-in claude for the tests
```

## Build and run

```
cd apps/studio
make build        # builds the web app, embeds it, writes bin/mach-studio, restores the placeholder
make host         # the binary alone, with the placeholder page (no Node needed)
make test         # go vet and go test
bin/mach-studio                 # the project is the nearest folder above the current one with .git (or MACH's folder)
bin/mach-studio --project ~/work/team-space --no-open
```

`make build` runs `build.sh`, which:

1. installs the web workspace's locked dependencies (`pnpm install --frozen-lockfile`; set
   `SKIP_INSTALL=1` to skip when `node_modules` is current),
2. builds the app (`pnpm --filter @mach/product-studio build` → `web/apps/product-studio/dist`),
3. refuses a build that cannot run under the host's Content-Security-Policy (a font or script
   inlined as a `data:` URI, an inline `<script>` or a `style="..."` in `index.html`),
4. copies that `dist/` over `internal/webui/dist/` and runs `go build -trimpath -o bin/mach-studio`,
5. puts the committed placeholder `internal/webui/dist/index.html` back, so the working tree is
   unchanged. `OUT=<path>` writes the binary elsewhere.

| Flag | Meaning |
|------|---------|
| `--project <dir>` | The project. Default: the current folder, resolved the way the engine resolves it. |
| `--no-open` | Print the address; do not open a browser. |
| `--port <n>` | Loopback port. Default `0`: a free one. |
| `--budget-per-turn <usd>` | Spending cap for each interview turn (`--max-budget-usd`). Default `2`. |
| `--turn-timeout <d>` | Time limit for each interview turn. Default `10m`. |
| `--model <name>` | The interviewer's model. Default: the person's Claude Code default. |
| `--claude <path>` | The `claude` command. Default: `claude` on `PATH`. For tests. |
| `--python <path>` | The interpreter. Default: `python3` on `PATH`. For tests. |
| `--engine <path>` | `studio.py`. Default: found as below. For tests. |

Start-up prints `Open: http://127.0.0.1:<port>/?t=<token>` and opens it (not with `--no-open`,
which is how the studio skill starts it). The link works once. In a project that has a
`.factory/` folder the host also keeps the next unused link in `.factory/local/studio/link` (mode
0600, in a folder private to the user with its own `.gitignore`; a symbolic link in place of either
folder is refused), writes it at start, replaces it each time a link is used, and removes it on exit.
Every link leads into the same single session: a later link lets one more browser in, it never makes
a second session. A spent link opened in a browser without the session says to ask Claude for a new one.

One host per project: the host holds an exclusive lock on `.factory/local/studio/lock` while it runs,
and a second start for the same project stops at once with `another Product Studio is already
running for this project` (exit status 1), before it clears or serves anything. The lock ends with
the process, so after a crash the next start takes it and replaces the stale link file. A project
with no `.factory/` keeps no file and holds no lock.

Ctrl+C stops every running interview turn (its process group), ends each interview with
`ended {reason: host_shutdown}`, then stops the server.

## How the engine is found

Resolved once, at start-up, to absolute paths that are then fixed for the life of the process:

1. `--engine`, if given.
2. Next to the binary: its folder and each folder above it (up to eight levels), first
   `skills/studio/scripts/studio.py` (the plugin, or this repository), then
   `.claude/skills/mach-studio/scripts/studio.py` (a script install into a project).
3. The project: `<project>/.claude/skills/mach-studio/scripts/studio.py`.

The binary is checked before the project so the host and the engine come from the same install.
The interpreter is `--python`, else `python3` on `PATH`, made absolute (not resolved through
symlinks, so a virtual environment keeps working). The engine runs as
`<python> -I -B <studio.py> --project <root> <fixed arguments>`, in the project folder, with a time
limit (60 s; 180 s for operations that may reach the shared repository or GitHub), bounded output (8 MiB stdout, 64 KiB stderr),
and in its own process group so a time limit stops the Git processes it started too.

## The API

Every response is `{ok: true, data}` or `{ok: false, error: {kind, message, hint?}}`. `hint` comes
only with some `refused` errors: the engine's structured suggestion `{kind, target}` for the app
action that would resolve it (`reopen_slice`, `renumber_slice`, `mark_ready`, …;
`studio.NEXT_ACTION_KINDS` and `HINT_KINDS`; `several_projects` is not an act and also carries
`issues`, each project issue with its address). The host passes a hint of at most 512 bytes as it is. The host runs the engine with `--app`, so refusals
and reports carry no terminal commands or Git words; decisions and artifacts are the terminal's. Clients read the
envelope; the HTTP status only follows it (refused 422, invalid 400 or 404/413/415, unauthorized
401 without a session and 403 for Host/Origin/CSRF, conflict 409, unavailable 503, internal 500).

Under `/api/` every response is the envelope, with no redirect: a path that is not clean (`..`,
`//`, an encoded `/`, a trailing `/`) is `invalid` (400); a route's wrong method is `invalid` (405,
with `Allow`); an unknown route is `invalid` (404). A method no route takes also closes the
connection after the answer, so an unframed body can never be read as the next request.

Every request: `Host` exactly `127.0.0.1:<port>` or `localhost:<port>`. Every `/api` request: the
session cookie (`mach_studio_session`, from the start link). Every request that is not GET or HEAD
also needs `Origin: http://<Host>`, `X-MACH-CSRF: <csrf_token>` and `Content-Type:
application/json`. A GET never needs Origin or the CSRF token.

| Route | Body | `data` |
|-------|------|--------|
| `GET /?t=<token>` | | sets the cookie, redirects to `/` (303); a used or wrong token is 401 |
| `GET /api/session` | | `{project: {folder, path, name, project_id}, csrf_token, capabilities: {interview, interview_reason, continue_command, explore_command, needs_command}, versions: {host, api, engine_install}, engine_problem}` |
| `POST /api/ops/<operation>` | that operation's arguments (contract 8.1) | the engine's JSON |
| `GET /api/drafts/spec/<SLICE>` | | `{slice_id, kind, exists, markdown, path, spec_name_pattern, editable, edit_refusal}` |
| `PUT /api/drafts/spec/<SLICE>` | `{markdown, name?}` | `{slice_id, kind, path, check}`; `conflict` while an interview turn is running for the slice |
| `GET /api/drafts/intent/<SLICE>` | | `{slice_id, kind, exists, markdown, path, editable, edit_refusal}` |
| `PUT /api/drafts/intent/<SLICE>` | `{markdown}` | `{slice_id, kind, path, check}` |
| `GET /api/slices/<SLICE>/mocks/<sha256>` | | the draft's own design mock with that SHA-256, inline (`image/png` or `image/jpeg` from its bytes, `nosniff`, `no-store`); `400` for a malformed ID or hash, `404` for anything not exactly that file |
| `POST /api/interview` | `{slice_id, idea?}`, or (M16) `{idea_id}` for the Shape conversation on one idea, or (M17) `{needs: true}` for the needs conversation | `{interview_id, slice_id, resumed}`; `refused` for an approved or unknown slice; `conflict` while the slice's lock is held. Held by this host: message "SLICE-001's interview is already open here." and `hint: {kind: "open_interview", target: <interview_id>}`, so the app attaches to that interview. Held by another host or a terminal: "SLICE-001 already has an interview running (process N, since T).", no hint |
| `GET /api/interview?slice_id=<SLICE>` (or `?idea_id=<IDEA>`, or `?needs=true`) | | `{interview: null}` or `{interview: {interview_id, slice_id, live, state, turn_running, locked_elsewhere, last_message: {message_id, text, kind, question}, turns, session_cost_usd}}`; `interview_id` is null and `state` is `saved` when only a saved session exists |
| `GET /api/interview/history?slice_id=<SLICE>` (or `?idea_id=<IDEA>`, or `?needs=true`) | | `{slice_id, events: [{at, interview_id, event, data}], truncated}`: every saved event for the slice, across interviews and restarts, oldest first |
| `GET /api/interview/<id>/events` | | server-sent events, below |
| `POST /api/interview/<id>/reply` | `{text}` (up to 8000 characters) | `{sent: true}`; `conflict` while a turn is running or after the interview ended |
| `POST /api/interview/<id>/interrupt` | `{}` | `{interrupted: true}` once the turn has stopped; `conflict` when no turn is running |
| `POST /api/interview/<id>/stop` | `{}` | `{stopped: true}`; the draft, the saved note and the Claude session remain |

`continue_command` is `/mach:studio continue` (plugin) or `/mach-studio continue`
(project install); the app adds the slice ID. `explore_command` (M16) is the same install's
`/mach:studio explore` or `/mach-studio explore`; the app adds the idea's ID.
`needs_command` (M17) is the same install's `/mach:studio needs` or `/mach-studio needs`.

Requests from GitHub issues (M8, `docs/mach-next/M8_DESIGN.md` D8) are five more operations, each
one engine command; `number` is a JSON whole number from 1 to 999,999,999 (a string, a fraction, zero
or a negative number is `invalid`), and no other field is accepted:

| Operation | Arguments | Engine command | Kind |
|-----------|-----------|----------------|------|
| `request.list` | `{}` | `request list` | read-only, never calls GitHub |
| `request.show` | `{number}` | `request show <n>` | read-only |
| `request.pick` | `{number, epic, title, also?}` | `request pick <n> --epic=E --title=T [--also]` | may fetch |
| `request.link` | `{number, slice_id}` | `request link <n> <SLICE>` | changes the draft only |
| `request.met` | `{number}` | `request met <n>` | may fetch (closes the issue) |

`refresh` returns the `requests` block as well. The interviewer's allowed operations are unchanged.

Slices are saved as GitHub issues (M11, `docs/mach-next/M11_STUDIO_ISSUES.md`); there are no
delivery waves. These operations may reach GitHub:

| Operation | Arguments | Engine command | Kind |
|-----------|-----------|----------------|------|
| `slice.ready` | `{slice_id}` | `slice ready <SLICE>` | the approval: saves the slice as an issue under its epic, or to the ready folder |
| `slice.reopen` | `{slice_id}` | `slice reopen <SLICE>` | takes the slice back from GitHub first |
| `reconcile` | `{slice_id, take}` | `reconcile <SLICE> --take=mine\|theirs` | for a slice someone else saved a newer version of |
| `slice.move` | `{slice_id}` and exactly one of `before`, `after` (slice IDs), `first`, `last` (`true`) | `slice move <SLICE> --before=<SLICE>\|--after=<SLICE>\|--first\|--last` | the product manager's order within the epic; GitHub's order is put in place where the epic's slices are there |
| `slice.take` | exactly one of `{issue}` (a whole number) or `{slice_id}` | `slice take <n\|SLICE>` | opens a slice another product manager saved on GitHub as a draft here |

### What M13 and M14 added (M15)

`docs/mach-next/M15_STUDIO_FOUNDATION.md` is the full reference: each operation's arguments, the
engine command, and the limits. In short:

| Operations | Engine commands |
|------------|-----------------|
| `principle.list`, `principle.add`, `principle.set`, `principle.retire`, `principle.publish`, `reconcile.principles` | `principle list\|add\|set\|retire\|publish`, `reconcile principles --take=` |
| `policy.list`, `policy.accept` | `policy list`, `policy accept <SLICE> <POL-x-NN> --by= --reason=` |
| `epic.current` | `epic current <EPIC\|n> --json` (reads only) |
| `epic.link`, `slice.link` | `epic link\|slice link <ID> --jira=KEY-1\|--no-jira` |
| `jira.export`, `jira.keys` | `jira export [--epic=] [--state=] [--flavour=]` (never `--out`), `jira keys <staged csv> [--dry-run]` |
| `prd.import`, `prd.list`, `prd.show`, `prd.map`, `prd.settle`, `prd.status`, `prd.apply`, `prd.draft`, `prd.confirm` | `prd ...`; a document, a map or drafted answers are staged files |
| `slice.mock.add`, `slice.mock.remove`, `slice.mock.list` | `slice mock add <SLICE> <staged picture> [--for=] [--binding] [--note=]`, `remove`, `list` |

**Files from the person** travel inside the operation's JSON body as `{"name", "content_base64"}`,
so they pass every check a request passes (session, Host, Origin, CSRF, `application/json`); the
host never parses a multipart body. The host checks only the name's extension and the size (a PRD
512 KiB, a picture 5 MiB, a Jira CSV 8 MiB; a map or drafted answers 1 MiB of JSON), never the
content. Each file is written, created exclusively and without following links, to a fresh random
folder under `.factory/studio/uploads/` for the one engine call, under the project lock, and that
folder is removed afterwards whatever the engine answered; anything left by a host that stopped is
removed at the next start. The engine is given only that path; no path ever comes from the request.

**Downloads**: `jira.export`'s answer gains `downloads: [{name, url, bytes}]`, added by the host.
`GET /api/downloads/<token>/<name>` serves exactly the files that export wrote (`mach-jira.csv`,
`README.txt`), as their bytes when the export finished, as an attachment; the token is random, and
a new export replaces the set. A failure is the envelope, as on every route.

### Shape (M16)

`docs/mach-next/M16_SHAPE_APP_FOUNDATION.md` is the full reference. Twenty-one operations, each one
engine command: `idea.add`, `idea.list`, `idea.faults` (read only: the open fault tickets on this
computer an idea may start from), `idea.show`, `idea.stage`, `idea.lookups`, `idea.renumber`,
`idea.publish`, `idea.size`, `idea.map`, `idea.settle`, `idea.map-status`, `idea.apply`,
`idea.change`, `idea.chain`, `brief.check`, `brief.show`, `case.show`, `case.check`,
`verdict.record`, `lookback.record`. An idea's title is the engine's one positional value and
always follows `--`. Lookups and a map travel as JSON in the body (at most 256 KiB, the engine's
own limit) and are staged like any other file. While the Shape conversation's turn is running for an
idea, every Shape operation that changes that idea is a `conflict`.

### Technical needs (M17)

`docs/mach-next/M17_APP_FOUNDATION.md` is the full reference. Twelve operations, each one engine
command (`internal/engine/ops_needs.go`): `need.list`, `need.add`, `need.set`, `need.retire`,
`need.none`, `need.publish` (may reach GitHub), `reconcile.needs` (may reach GitHub),
`design.list`, `design.import` (one Markdown or plain-text file as an upload in the body, the PRD
on-ramp's limits), `design.show`, `design.settle`, `design.publish`. `design map` is not an
operation: the needs conversation records a design's map. While the needs conversation's turn is
running, every operation that changes the needs or a design is a `conflict`.

### A small change (M18)

`docs/mach-next/M18_APP.md` is the full reference (`internal/engine/ops_small.go`). `slice.new` and
`request.pick` take an optional `small: {change: "fix"|"adjustment", rule?}`, which becomes
`--small --change=<change> [--rule=<SLICE-NNN/FR-NN>]`: a fix names exactly one shipped rule (the
engine's pattern), an adjustment names none. `slice.widen` `{slice_id, why}` is `slice widen <SLICE>
--why=<the product manager's words>` (at most 300 characters), on this computer only. The slice
interview for a slice started as a small change may also run `slice widen <its ID> --by-rule <rule>`
for exactly the thirteen rules the short interview names; `--why` is denied to it.

`acceptance record` stays a terminal command; it is not on the allowlist, and neither is any name of
the removed `slice approve`, waves, `send` or `feedback`. No operation's argument vector can start
with one (`internal/engine/ops_test.go`).

### Interview events

Each event is `id: <seq>`, `event: <name>`, `data: <JSON>`. `seq` rises through an interview. On
connect the host replays the current turn's events so far and the last final message (`message`
and `question`), after `Last-Event-ID` when the browser sends it, so a reload never loses the
question on screen. A `: ping` comment comes every 15 s. The stream closes after the final
`state: ended`. A subscriber that falls more than 512 events behind is dropped and reconnects.

| Event | Data |
|-------|------|
| `state` | `{state}`: `starting` (with `slice_id` or, for an idea, `idea_id`, and `resumed`), `thinking`, `working`, `waiting_for_reply`, `ended` |
| `text` | `{message_id, delta}`; may belong to a message that is never final |
| `message` | `{message_id, text, kind}` (`question`, `confirmation`, `other`), once per turn |
| `question` | `{message_id, number, title, body, recommendation, preface}`, with `message` when it parses as exactly one question |
| `activity` | `{kind, text}` after a tool ran: `lookup`, `check`, `save`, `write`, `refused`, `other` |
| `draft_changed` | `{slice_id, what}`: `spec`, `why`, `work_order`; for an idea `{idea_id, what}`: `brief`, `case`, `lookups`, `idea`; for the needs conversation `{needs: true, what}`: `needs`, `design`; found by hashing the draft workspace |
| `turn` | `{outcome, seconds, cost_usd, session_cost_usd, refused}` closes every turn |
| `reply` | `{text}`: the product manager's reply, first in the turn it starts |
| `ended` | `{reason}`: `stopped`, `host_shutdown` |
| `error` | `{kind, message}`: `no_result`, `timed_out`, `error_max_budget_usd`, `error_during_execution` |

History: every event except `text` and the `thinking`/`working` states is appended to
`.factory/studio/interviews/<SLICE>.events.jsonl` (never Claude Code's own stream). Past 1 MiB the
oldest half is dropped and `truncated` becomes true.

Resuming: `POST /api/interview` for a slice with a saved session replays the saved last message
and waits for the reply, without running a turn; the reply resumes the same Claude session.

## The interview process

One Claude Code session per slice, one `claude -p` process per reply (`--resume` after the first).
The exact vector (`internal/interview/command.go`, asserted by a test):

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --restricted --plugin-dir <project>/.factory/studio/interviews/plugin
  --add-dir <studio skill> --add-dir <intent skill>        (only when outside the project)
  --strict-mcp-config --permission-mode default --permission-prompts none
  --tools Read,Glob,Grep,Edit,Write,Bash
  --allowedTools <generated> --disallowedTools <generated>
  --max-budget-usd <per turn> --append-system-prompt <host note> [--model <m>]
  (--session-id <uuid> | --resume <uuid>) -- <message>
```

- Allowed: `Read`, `Glob`, `Grep`; `where`, `status`, `validate`, `refresh`, and on the interview's
  own slice `slice resume|check|pause|set`, each spelled with `python3` and the absolute
  interpreter, and the script through the plugin link and its real path, quoted and unquoted;
  `Edit(//…)` for that slice's spec and why only. Denied again: `slice ready`,
  reconcile, renumber, reopen, `slice move`, `slice take`, project, slice new and epic add/set, and
  names the app never offers (`slice approve`, `wave`, `send`, `feedback`, `acceptance`), and since
  M15 `principle`, `policy`, `epic link`, `slice link`, `epic current`, `jira`, `prd` and `slice mock`.
- Since M16 the slice interview also denies every Shape command (`idea`, `brief`, `case`,
  `verdict`, `lookback`).
- **The Shape conversation (M16)** is the same process for one idea, with its own rules and note
  (`ideaPermissionArgs`, `IdeaHostNote`). Allowed: `Read`, `Glob`, `Grep`; `where`, `status`,
  `validate`, `refresh`, `idea list`, `request list`, `principle list`, `policy list`,
  `epic current …`; on its own idea `idea show`, `brief show|check`, `case show|check`; and
  `idea lookups <IDEA> --from <its one input file>` in each spelling; `Edit(//…)` for exactly that
  idea's brief, its case, and `.factory/studio/interviews/inputs/<IDEA>.lookups.json` (outside the
  draft workspace, so it can never stand in for the engine's own lookups). Denied again: every
  slice command, the stage, verdict, size, map, settle, map-status, apply, change, chain, publish,
  renumber, add and look back, every act of principles, policies, Jira, the PRD on-ramp and
  requests, and the names the app never offers. Its first message is
  `/mach:studio explore <IDEA>.` and a fixed sentence; nothing the person typed is added.
  A shaped idea is refused before Claude Code starts. Its session, lock and history are
  `<IDEA>.json`, `<IDEA>.lock` and `<IDEA>.events.jsonl` beside the slices'.
- Since M17 the slice interview and the Shape conversation also deny every `need` and `design`
  command.
- **The needs conversation (M17)** is the same process for the product as a whole, with its own
  rules and note (`needsPermissionArgs`, `NeedsHostNote`). Allowed: `Read`, `Glob`, `Grep`;
  `where`, `status`, `validate`, `refresh`, `need list`, `design list`, `principle list`,
  `policy list`; `need add …`, `need set …`, `need none …`, `design show …`; and, for each design in
  the workspace when the turn starts, `design map <DES> --from <its one input file>` in each
  spelling; `Edit(//…)` for exactly `.factory/studio/interviews/inputs/needs.design-map.json`.
  `product/needs.json` is written only by the engine. Denied again: `need retire|publish`,
  `reconcile`, `design import|settle|publish`, every slice, Shape, project and epic command, the
  acts of principles, policies, Jira, the PRD on-ramp and requests, and the names the app never
  offers. Its first message is `/mach:studio needs.` and a fixed sentence. It is refused
  before Claude Code starts when the project does not exist. Its session, lock and history are
  `needs.json`, `needs.lock` and `needs.events.jsonl`.
- The environment is `HOME USER LOGNAME PATH LANG LC_ALL TMPDIR SHELL TERM` and
  `GIT_TERMINAL_PROMPT=0`; nothing else of the host's, so no API key or token passes.
- The working folder is the project's real path. Stderr and the raw stream are never logged or sent.
- Local state: `.factory/studio/interviews/<SLICE>.json` (session ID, turns, cost, last message),
  `<SLICE>.lock` (flock for the whole interview, the same lock the terminal prototype takes), and
  `plugin/` (a one-skill plugin whose skill is a link to the installed studio skill).
- `--add-dir`: with `--restricted` the file tools reach only the working folders. In a plugin
  install the interview method, templates and spec rules (`studio.py where`) live outside the
  project, so the two skill folders are added, read-only in effect (no rule allows editing or
  running anything there). Found in the live check: without it the interviewer could not read the
  interview method and lost the question format.
- Capability: `claude` on `PATH`, `--version` at least 2.1.322, `--help` listing `--restricted`
  and `--permission-prompts`, and `claude auth status --json` reporting `loggedIn` (only that
  field is read). None of these spends anything; the answer is cached for five minutes.

## The web app

`internal/webui/dist/` is embedded with `//go:embed`. The committed `index.html` there is a
placeholder; `make build` swaps the real build in for the duration of `go build` only. The build
must reference only its own files (no CDN, no external font), and must work under the host's
Content-Security-Policy: `script-src 'self'`, `style-src 'self'` and `font-src 'self'`, so no
inline `<script>` or `<style>` blocks, no `style="..."` attributes in the HTML (styles set from
JavaScript through the DOM are fine), and no font or script inlined as a `data:` URI. Any path
without a file extension that is not a file in `dist/` is served `index.html` (client-side
routing); a missing file with an extension is a 404. Files under `assets/` are cached as
immutable, so they must be content-hashed (Vite does this by default).

## Tests

```
cd apps/studio && go vet ./... && go test ./...
python3 -m unittest tests.test_mach_product_host     # from the repository root: builds the binary, drives it over HTTP
```

The Go tests run the real `studio.py` in temporary Git projects (they need `python3` and `git`;
they skip without them), and a stand-in `claude` (`internal/testkit/fakeclaude.go`) that plays
recorded stream-json turns. `tests/test_mach_product_host.py` checks that the host and the
terminal leave byte-identical files for the same operations.

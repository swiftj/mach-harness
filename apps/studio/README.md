# mach-studio: the local host for the visual Product Studio

A small Go program that serves the Product Studio web app on the loopback interface. It passes the
app's requests to the Product Studio engine, `skills/product-studio/scripts/studio.py`, and runs
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

Start-up prints `Open: http://127.0.0.1:<port>/?t=<token>` and opens it. The link works once.
Ctrl+C stops every running interview turn (its process group), ends each interview with
`ended {reason: host_shutdown}`, then stops the server.

## How the engine is found

Resolved once, at start-up, to absolute paths that are then fixed for the life of the process:

1. `--engine`, if given.
2. Next to the binary: its folder and each folder above it (up to eight levels), first
   `skills/product-studio/scripts/studio.py` (the plugin, or this repository), then
   `.claude/skills/mach-product-studio/scripts/studio.py` (a script install into a project).
3. The project: `<project>/.claude/skills/mach-product-studio/scripts/studio.py`.

The binary is checked before the project so the host and the engine come from the same install.
The interpreter is `--python`, else `python3` on `PATH`, made absolute (not resolved through
symlinks, so a virtual environment keeps working). The engine runs as
`<python> -I -B <studio.py> --project <root> <fixed arguments>`, in the project folder, with a time
limit (60 s; 180 s for operations that may fetch), bounded output (8 MiB stdout, 64 KiB stderr),
and in its own process group so a time limit stops the Git processes it started too.

## The API

Every response is `{ok: true, data}` or `{ok: false, error: {kind, message, hint?}}`. `hint` comes
only with some `refused` errors: the engine's structured suggestion `{kind, target}` for the app
action that would resolve it (`approve_epic`, `reopen_slice`, `renumber_slice`, `edit_epic`, …;
`studio.NEXT_ACTION_KINDS` and `HINT_KINDS`). The host runs the engine with `--app`, so refusals
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
| `GET /api/session` | | `{project: {folder, path, name, project_id}, csrf_token, capabilities: {interview, interview_reason, continue_command}, versions: {host, api, engine_install}, engine_problem}` |
| `POST /api/ops/<operation>` | that operation's arguments (contract 8.1) | the engine's JSON |
| `GET /api/drafts/spec/<SLICE>` | | `{slice_id, kind, exists, markdown, path, spec_name_pattern, editable, edit_refusal}` |
| `PUT /api/drafts/spec/<SLICE>` | `{markdown, name?}` | `{slice_id, kind, path, check}`; `conflict` while an interview turn is running for the slice |
| `GET /api/drafts/intent/<SLICE>` | | `{slice_id, kind, exists, markdown, path, editable, edit_refusal}` |
| `PUT /api/drafts/intent/<SLICE>` | `{markdown}` | `{slice_id, kind, path, check}` |
| `POST /api/interview` | `{slice_id, idea?}` | `{interview_id, slice_id, resumed}`; `refused` for an approved or unknown slice; `conflict` while the slice's lock is held. Held by this host: message "SLICE-001's interview is already open here." and `hint: {kind: "open_interview", target: <interview_id>}`, so the app attaches to that interview. Held by another host or a terminal: "SLICE-001 already has an interview running (process N, since T).", no hint |
| `GET /api/interview?slice_id=<SLICE>` | | `{interview: null}` or `{interview: {interview_id, slice_id, live, state, turn_running, locked_elsewhere, last_message: {message_id, text, kind, question}, turns, session_cost_usd}}`; `interview_id` is null and `state` is `saved` when only a saved session exists |
| `GET /api/interview/history?slice_id=<SLICE>` | | `{slice_id, events: [{at, interview_id, event, data}], truncated}`: every saved event for the slice, across interviews and restarts, oldest first |
| `GET /api/interview/<id>/events` | | server-sent events, below |
| `POST /api/interview/<id>/reply` | `{text}` (up to 8000 characters) | `{sent: true}`; `conflict` while a turn is running or after the interview ended |
| `POST /api/interview/<id>/interrupt` | `{}` | `{interrupted: true}` once the turn has stopped; `conflict` when no turn is running |
| `POST /api/interview/<id>/stop` | `{}` | `{stopped: true}`; the draft, the saved note and the Claude session remain |

`continue_command` is `/mach:product-studio continue` (plugin) or `/mach-product-studio continue`
(project install); the app adds the slice ID.

### Interview events

Each event is `id: <seq>`, `event: <name>`, `data: <JSON>`. `seq` rises through an interview. On
connect the host replays the current turn's events so far and the last final message (`message`
and `question`), after `Last-Event-ID` when the browser sends it, so a reload never loses the
question on screen. A `: ping` comment comes every 15 s. The stream closes after the final
`state: ended`. A subscriber that falls more than 512 events behind is dropped and reconnects.

| Event | Data |
|-------|------|
| `state` | `{state}`: `starting` (with `slice_id`, `resumed`), `thinking`, `working`, `waiting_for_reply`, `ended` |
| `text` | `{message_id, delta}`; may belong to a message that is never final |
| `message` | `{message_id, text, kind}` (`question`, `confirmation`, `other`), once per turn |
| `question` | `{message_id, number, title, body, recommendation, preface}`, with `message` when it parses as exactly one question |
| `activity` | `{kind, text}` after a tool ran: `lookup`, `check`, `save`, `write`, `refused`, `other` |
| `draft_changed` | `{slice_id, what}`: `spec`, `why`, `work_order`, found by hashing the draft workspace |
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
  --add-dir <product-studio skill> --add-dir <intent skill>        (only when outside the project)
  --strict-mcp-config --permission-mode default --permission-prompts none
  --tools Read,Glob,Grep,Edit,Write,Bash
  --allowedTools <generated> --disallowedTools <generated>
  --max-budget-usd <per turn> --append-system-prompt <host note> [--model <m>]
  (--session-id <uuid> | --resume <uuid>) -- <message>
```

- Allowed: `Read`, `Glob`, `Grep`; `where`, `status`, `validate`, `refresh`, and on the interview's
  own slice `slice resume|check|pause|set`, each spelled with `python3` and the absolute
  interpreter, and the script through the plugin link and its real path, quoted and unquoted;
  `Edit(//…)` for that slice's spec and why only. Denied again: every approval, wave, send,
  reconcile, renumber, reopen, project, feedback, slice new and epic add/set.
- The environment is `HOME USER LOGNAME PATH LANG LC_ALL TMPDIR SHELL TERM` and
  `GIT_TERMINAL_PROMPT=0`; nothing else of the host's, so no API key or token passes.
- The working folder is the project's real path. Stderr and the raw stream are never logged or sent.
- Local state: `.factory/studio/interviews/<SLICE>.json` (session ID, turns, cost, last message),
  `<SLICE>.lock` (flock for the whole interview, the same lock the terminal prototype takes), and
  `plugin/` (a one-skill plugin whose skill is a link to the installed product-studio skill).
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

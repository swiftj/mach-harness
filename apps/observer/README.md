# mach-observer

The read-only local observer behind the MACH Control Tower (MACH Next M6.1/M6.2, experimental). It
follows the Factory's own files, keeps a redacted index under `.factory/local/observer/`, projects
it into the Factory's state, and serves a versioned GET-only API, a server-sent event stream and the
embedded Control Tower on `127.0.0.1`. Design: `docs/mach-next/M6_1_OBSERVER_DESIGN.md`; events:
`docs/mach-next/M6_1_EVENT_CONTRACT.md`; Timeline, Evidence and Analytics data:
`docs/mach-next/M6_1_SHARED_CONTRACTS.md`.

    make test        # go vet + go test -race
    make host        # bin/mach-observer with a placeholder page
    make build       # bin/mach-observer with the Control Tower embedded (build.sh)
    make smoke       # start it on a throwaway project and check it (smoke.sh)
    bin/mach-observer --project <path>   # prints a one-time link; started by a skill, not a MACH command

Standard library only. It writes nothing outside its own folder, takes no MACH lock, runs no MACH
command, starts no process and connects to nothing.

## Layout

| Package | Side | Does |
|---|---|---|
| `internal/tail`, `normalize`, `redact`, `event`, `store`, `ingest`, `factory`, `lock` | ingest | read MACH's files, normalise to version 3, keep the index |
| `internal/feed` | serving | the narrow `Log` interface the serving side reads, the v3 decoder, cursors, filters |
| `internal/project` | serving | the projection (state at a cursor), checkpoints, snapshots, spans, views |
| `internal/metrics` | serving | the analytics catalog and mergeable aggregates |
| `internal/artifact` | serving | the evidence catalog and the guarded content reader |
| `internal/server`, `security`, `webui` | serving | HTTP, sessions, headers, the embedded app |
| `cmd/mach-observer/adapt.go` | both | the one file where the serving side meets the store, ingest loop and factory reader |

## Opening it in more than one browser

The printed link works once and becomes a session cookie for that browser (every tab shares it).
Each time a link is used the observer mints the next one at once and writes it to
`.factory/local/observer/link` (mode `0600`, in a `0700` folder; removed when the observer stops).
The skill that started the observer prints that file for a second browser. There is never more than
one unused link; up to 16 browser sessions are held (the oldest is dropped beyond that). No write
endpoint, control socket or process is involved, and reading the file needs the same access as
reading the printed link. A project with no `.factory/` has no such file: restart for a new link.

## API (`/api/v1`)

Every route is GET only (anything else: 405 with `Allow: GET`), needs the session cookie (401),
`Host` `127.0.0.1:<port>` or `localhost:<port>` (403), no foreign `Origin` or `Sec-Fetch-Site`
(403), and a plain path (no `..`, `//`, `%2f`, `%2e`, `%5c`, `%00`: 400). Every reply is
`{"ok":true,"data":…}` or `{"ok":false,"error":{"kind","message",…}}` with `Cache-Control: no-store`
and the M5 CSP. The event schema is chosen with `?schema=3` or `X-MACH-Event-Schema: 3`; absent
means 3; any other value is 400 `invalid` with `supported: [3]`. Cursors are `<generation>.<pos>`.

| Route | Purpose | Limits and notes |
|---|---|---|
| `session` | versions (event schema 3, revision, the 54 kinds), generation, `display_policy {people: "role"}`, capabilities (`execution: false`, snapshot, artifacts, analytics, `evidence_media`, `stream_observations`), every limit below, session count, where the next link is kept | |
| `health` | `ok`/`degraded`, observer time, index head and floor, projection (position, lag, partial), ingest ticks and errors, freshness (per-source state, last read, lag), streams | degraded when ingest errs, has not ticked for 5 s, or the projection errs |
| `factory/status` | the Factory's files: policy summary (never `enabled_by`, machine, tools, paths), lease, counts; `summary {enabled, paused, mode, autonomy}`; `supervisor.heartbeat_fresh`; the mode the intake log recorded; freshness | files read at most once a second |
| `events` | v3 events after a cursor | `after`, `limit` 1–1000 (200), filters `ticket`, `execution`, `station`, `type` (prefix), `entity` (ref), `authority`; at most 10,000 events examined per request (`scanned`, then page on from `next`); 409 `cursor_reset`, 410 `cursor_expired`, 400 |
| `stream` | live SSE: `hello`, one message per event (`id:` = cursor), `heartbeat {head, scanned, watermark_ms}`, `gap`, `reset` | `Last-Event-ID` or `after`, else head; same filters; batches of 256; 16 streams (503 + `Retry-After`); 10 s write deadline, then dropped; heartbeat 15 s; `retry: 2000` |
| `snapshot` | the projected state at a cursor (`at`, default the projection's position) and that cursor; stream from it with `Last-Event-ID` for no gap and no repeat | `reconstructed: true` for an earlier cursor (rebuilt from the nearest checkpoint); 410 when it can no longer be rebuilt; 409 ahead or another generation |
| `project` | slice counts by scheduler state, active cells, running executions, open human gates, integration commit, recorded Factory mode, history gaps | |
| `waves`, `waves/{wave}` | delivery waves; detail with each slice's state and wait | |
| `slices`, `slices/{slice}` | scheduler state (`completed`, `active`, `ready`, `blocked`, `superseded`), dependencies, recorded reasons, `waiting {kind: dependency \| capacity \| person \| unknown, basis, reasons, since}`, state history, earlier revisions | `wave`, `state`, `limit`, `offset`; capacity only from `capacity.wait_changed` or the scheduler's fixed sentence; never from silence |
| `cells`, `cells/{ticket}` | cells; detail: visits (with gates, tasks, checks, measured duration), rounds, gates, build tasks, verification checks and targets, review rounds with panel, verdicts and decision, findings (prose), human approvals (role only), merge, cleanup, human gates, wait | `stage`, `archived`, `limit`, `offset`; gates capped at 1,000 per cell (`gates_dropped`) |
| `cells/{ticket}/visits/{visit}` | one visit and its events (visit as `build%232`) | up to 1,000 events still held |
| `cells/{ticket}/evidence` | the cell's catalogued artifacts and its recorded checks, each evidence file linked to its catalog id and integrity | |
| `runs`, `runs/{execution}` | executions: state (`claimed`, `running`, `ended`, `finished`, `failed`, `interrupted`, `timed-out`, `could-not-start`, `unknown`), true process times (`time_basis: process`) or the supervisor's (`bounded`), cost with its source (stream usage, else MACH's record; null with a reason), tokens and cost per model, `cost_may_be_under_reported` with reasons, refused tools, recovery; detail adds workflows, usage, session | `state=active\|finished\|unknown`, `ticket`, `limit` (200, max 1000), `offset` |
| `runs/{execution}/agents` | workflow agents and Agent-tool sub-agents: label, phase, model, state, queue wait, run time, token total, tool-call count, last tool, refusals | never a cost, never per-call records |
| `runs/{execution}/tools` | main-loop and Agent-tool sub-agent tool calls, with spans; refusals | workflow agents' calls are a count only |
| `spans` | the Execution Timeline's spans (shared contracts 2): wave, slice-wait, slice-eligible, cell, round, visit, task (start inferred: `previous-completion`), seat, gate-wait, person-wait, claim, execution, workflow, agent-queue, agent, tool; each with start/end event, precision, `duration {ms, min_ms, max_ms, basis: measured \| bounded \| inferred \| open \| unknown}`, outcome, lane, authority | `ticket`, `execution`, `wave`, `entity`, `kinds`, `limit`, `offset`; at most 5,000 spans |
| `artifacts`, `artifacts/{id}` | the evidence catalog, metadata only: id, ref, path, kind, nature (`evidence`, `record`, `prose`), media type (sniffed), bytes, sha256, recorded sha256, integrity, `verified_evidence`, targets, round, commit, visit, provenance, `content_access` | `ticket`, `kind`, `nature`, `limit`, `offset`; refreshed at most every 2 s |
| `artifacts/{id}/content` | the bytes, by catalog id only | see below |
| `analytics/metrics` | every metric of the shared catalog: value, numerator, denominator, coverage, basis, source, authority, limitations, availability, target and `met` for the observe station's metrics; unavailable values null with a reason | `ids`, `group_by` (`day`, `risk`, `app_type`, `station`, `round`, `seat`, `model`, `phase`, `wave`, `stage`, `gate`, `reason_code`, `kind`, `tool`, `rule`, `target_kind`, `stop_reason`, `writer`, `ticket`, `token_kind`); 2,000 groups per metric |
| `analytics/runs` | `run.recorded` rows (the observe station's input) | `limit`, `offset` |

### Artifact content

- **Roots:** a cell's `evidence/` (and `evidence/previous-N/`): `results.json`, `summary.json`,
  `findings.md`, and the evidence files `results.json` names; `review/round-N/findings.md` and
  `decision.json`; the same members of `.factory/archive/<ticket>.tar.gz` once the cell folder is
  gone. Never `repo/`, `.factory/local/`, an execution stream, `packet.json`, `diff.patch`,
  `test-suite.log` or `contract-check.log`.
- **By id:** the client sends a catalog id (`a` + 24 hex, specific to this project, path and
  content); no route takes a path. Unknown ids are 404.
- **Guards:** every path is resolved under an `os.Root` at the project folder; no component may be a
  link; the file must be regular with one link (no hard links); opened `O_NOFOLLOW|O_NONBLOCK`; the
  path is re-checked after the open and must still name the opened file; the bytes served are the
  bytes hashed, and must equal the catalog's sha256 (409 `changed` otherwise).
- **Types, by sniffing:** text (served as `text/plain; charset=utf-8`, scrubbed of credentials and
  absolute paths, `X-MACH-Redacted: <n>`, cut to 256 KiB with `X-MACH-Truncated`), PNG, JPEG, GIF,
  WebP, WebM, MP4. The extension's class must match the contents (415 otherwise); HTML, SVG and
  binaries are refused. Caps: text 16 MiB read, images 16 MiB, video 64 MiB (413).
- **Images and video only when the project opts in:** `.factory/config.json`
  `{"tower": {"evidence_media": true}}` (tracked; read only; off by default, 403 `media-disabled`).
- **Headers:** `Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self';
  sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
  `Content-Disposition: inline` (`?download=1` for `attachment`), `X-MACH-Evidence-Match: match`,
  range requests for media. At most 4 content reads at once (503).

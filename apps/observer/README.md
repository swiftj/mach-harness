# mach-observer

The read-only local observer behind the MACH Control Tower (MACH Next M6.1/M6.2, experimental). It
follows the Factory's own files, keeps a redacted index under `.factory/local/observer/`, projects
it into the Factory's state, and serves a versioned GET-only API, a server-sent event stream and the
embedded Control Tower on `127.0.0.1`. Design: `docs/mach-next/M6_1_OBSERVER_DESIGN.md`; events:
`docs/mach-next/M6_1_EVENT_CONTRACT.md`; Timeline, Evidence and Analytics data:
`docs/mach-next/M6_1_SHARED_CONTRACTS.md`.

    make test        # go vet + go test -race (about 1.5 min; `go test ./...` without -race about 20 s)
    make host        # bin/mach-observer with a placeholder page
    make build       # bin/mach-observer with the Control Tower embedded (build.sh)
    make smoke       # start it on a throwaway project and check it (smoke.sh)
    bin/mach-observer --project <path>   # prints a one-time link; started by a skill, not a MACH command

Standard library only. It writes nothing outside its own folder, takes no MACH lock, runs no MACH
command, starts no process and connects to nothing: see [What it never does](#what-it-never-does).

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

## Restarts: the same page keeps working

An open Control Tower page survives a restart of the observer (`kill`, a crash, a new session)
without any write endpoint:

- **Same origin.** The observer remembers the port it bound in `.factory/local/observer/port` and
  binds it again when it is free. When it is not, it takes a new one and says so on stdout (`The
  last port, N, is in use ...`); a page left open must then be opened again from a new link.
  `--port` overrides both.
- **Same session.** A browser's cookie stays valid for 12 hours from the moment its link was used
  (`SessionLifetime`), across restarts. The observer keeps only a keyed hash of each session token
  (HMAC-SHA256), never the token, in `sessions.json`, with its expiry; at most 16, expired ones
  removed. The key is derived from a random per-project secret (`session-secret`) and the project's
  absolute folder, so the records of another project, or of this folder copied elsewhere, match
  nothing. All three files are mode `0600` in the `0700` folder; if the secret or the sessions file
  could be read or changed by another user (or is a link), both are discarded and made again,
  every browser needs a new link, and stderr says so. The cookie itself is unchanged: host-only,
  `HttpOnly`, `SameSite=Strict`.
- **Same history.** The index keeps its generation and positions across a restart, so a stream
  reconnecting with `Last-Event-ID` resumes at the next position, with nothing repeated or missed;
  what was written while the observer was down is read on start as backfill.

A project with no `.factory/` keeps nothing: sessions and the port last one run.

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
| `health` | `ok`/`degraded`, observer time, index head and floor, projection (position, lag, partial), ingest (ticks, errors, `catching_up`, `late` and `backfill` counts), freshness (below), streams, sessions | degraded while the last tick erred, ingest has not ticked for 5 s, or the projection errs |
| `factory/status` | the Factory's files and how fresh they are; the exact shape is [below](#factorystatus) | files read at most once a second |
| `events` | v3 events after a cursor, in delivery order (`pos`) | `after`, `limit` 1–1000 (200), filters `ticket`, `execution`, `station`, `type` (prefix), `entity` (ref), `authority`; at most 10,000 events examined per request (`scanned`, then page on from `next`); 409 `cursor_reset`, 410 `cursor_expired`, 400 |
| `history` | a window of history in ORDER (the `order` key), for replay and the Timeline (contract 14): late events appear where they belong; `{events, from_order, to_order, next_from_order, more, complete, head, floor, watermark_ms, catching_up}` | `from_order`/`to_order` (an order key or its first 15 digits; `[from, to)`) or `from_ms`/`to_ms`; `entities` (up to 32 refs, comma-separated), `ticket`, `execution`, `type` (prefix); `limit` 1–5000 (1000); page on with `from_order=next_from_order` (a page never splits events sharing an order key); reads the memory window: `complete: false` when events of the window may have been evicted |
| `stream` | live SSE: `hello`, one message per event (`id:` = cursor), `heartbeat {head, scanned, watermark_ms}`, `gap`, `reset` | `Last-Event-ID` or `after`, else head; same filters; batches of 256; 16 streams (503 + `Retry-After`); 10 s write deadline, then dropped; heartbeat 15 s; `retry: 2000` |
| `snapshot` | the projected state at a cursor (`at`, default the projection's position) and that cursor; stream from it with `Last-Event-ID` for no gap and no repeat | `reconstructed: true` for an earlier cursor (rebuilt from the nearest checkpoint); 410 when it can no longer be rebuilt; 409 ahead or another generation |
| `project` | slice counts by scheduler state, active cells, running executions, open human gates, integration commit, recorded Factory mode, history gaps | |
| `waves`, `waves/{wave}` | delivery waves; detail with each slice's state and wait | |
| `slices`, `slices/{slice}` | scheduler state (`completed`, `active`, `ready`, `blocked`, `superseded`), dependencies, recorded reasons, `waiting {kind: dependency \| capacity \| person \| unknown, basis, reasons, since}`, state history, earlier revisions | `wave`, `state`, `limit`, `offset`; capacity only from `capacity.wait_changed` or the scheduler's fixed sentence; never from silence |
| `cells`, `cells/{ticket}` | cells; detail: visits (with gates, tasks, checks, measured duration), rounds, gates, build tasks, verification checks and targets, review rounds with panel, verdicts and decision, findings (prose), human approvals (role only), merge, cleanup, human gates, wait | `stage`, `archived`, `limit`, `offset`; gates capped at 1,000 per cell (`gates_dropped`) |
| `cells/{ticket}/visits/{visit}` | one visit and its events (visit as `build%232`) | up to 1,000 events still held |
| `cells/{ticket}/evidence` | the cell's catalogued artifacts and its recorded checks, each evidence file linked to its catalog id and integrity | |
| `runs`, `runs/{execution}` | executions: state (`claimed`, `running`, `ended`, `finished`, `failed`, `interrupted`, `timed-out`, `could-not-start`, `unknown`), true process times (`time_basis: process`) or the supervisor's (`bounded`), cost with its source (stream usage, else MACH's record; null with a reason), tokens and cost per model, `cost_may_be_under_reported` with reasons (from the stream's own `execution.usage.cost_complete` when there is one; the process ending interrupted, timed out or unknown also counts), refused tools, recovery; detail adds workflows, usage, session | `state=active\|finished\|unknown`, `ticket`, `limit` (200, max 1000), `offset` |
| `runs/{execution}/agents` | workflow agents and Agent-tool sub-agents: label, phase, model, state, queue wait, run time, token total, tool-call count, last tool, refusals | never a cost, never per-call records |
| `runs/{execution}/tools` | main-loop and Agent-tool sub-agent tool calls, with spans; refusals | workflow agents' calls are a count only |
| `spans` | the Execution Timeline's spans (shared contracts 2): wave, slice-wait, slice-eligible, cell, round, visit, task (start inferred: `previous-completion`), seat, gate-wait, person-wait, claim, execution, workflow, agent-queue, agent, tool; each with start/end event, precision, `duration {ms, min_ms, max_ms, basis: measured \| bounded \| inferred \| open \| unknown}`, outcome, lane, authority | `ticket`, `execution`, `wave`, `entity`, `kinds`, `limit`, `offset`; at most 5,000 spans |
| `artifacts`, `artifacts/{id}` | the evidence catalog, metadata only: id, ref, path, kind, nature (`evidence`, `record`, `prose`), media type (sniffed), bytes, sha256, recorded sha256, integrity, `verified_evidence`, targets, round, commit, visit, provenance, `content_access` | `ticket`, `kind`, `nature`, `limit`, `offset`; refreshed at most every 2 s |
| `artifacts/{id}/content` | the bytes, by catalog id only | see below |
| `analytics/metrics` | every metric of the shared catalog: value, numerator, denominator, coverage, basis, source, authority, limitations, availability, target and `met` for the observe station's metrics; unavailable values null with a reason | `ids`, `group_by` (`day`, `risk`, `app_type`, `station`, `round`, `seat`, `model`, `phase`, `wave`, `stage`, `gate`, `reason_code`, `kind`, `tool`, `rule`, `target_kind`, `stop_reason`, `writer`, `ticket`, `token_kind`); 2,000 groups per metric |
| `analytics/runs` | `run.recorded` rows (the observe station's input) | `limit`, `offset` |

Deferred: `GET /api/v1/series` (shared contracts 2.8, the Timeline's per-minute counts). The
counts can be computed by a client from `/spans` and `/history` today; the route waits for the
Timeline to say which series it needs.

### Freshness (`health.freshness` and `factory/status.freshness`)

`{observer_time, head, floor, ingest: {last_tick_at, last_tick_age_ms, stale, stale_after_ms,
watermark_ms, catching_up}, projection: {cursor, lag_events, partial}, sources: [...]}`. One entry
per tailed source (intake log, each cell's lifecycle log, each execution stream, `runs.jsonl`):
`{key, path, state (live | idle | stale | ended | gone | blocked | unreadable | unknown), offset,
size, lag_bytes (size − offset), last_read_at, last_read_age_ms, lines, refused, duplicates,
oversized, resets}`. `size` is the file's size at its last read; `size`, `lag_bytes` and
`last_read_at` are null for a source that is missing or refused, or not read yet. A busy tick
(more than 20,000 events waiting) leaves some sources for the next one, so a source's
`last_read_at` can be older than the last tick.

### Late and backfill

`late: true` means an event was read live and delivered after the observer had already delivered
an event that sorts after it in history order. History that was on disk before the observer
started (or before an index rebuild), and anything derived from it, is **backfill**: delivered in
read order while `catching_up` is true, never late, with `provenance: {basis: [], rule:
"backfill", files: []}` (or its own provenance if it is reconstructed). A file that appears while
the observer runs is live from its first line. `health.ingest.late` and `.backfill` count both.

### `factory/status`

Exact shape (values from a supervised project whose supervisor's lease has expired):

```json
{"ok": true, "data": {
  "factory_present": true,
  "summary": {"enabled": true, "paused": false, "mode": "supervised", "autonomy": "supervised", "policy_usable": true,
              "note": "a reading of the machine-local policy; run.py decides whether execution is authorized"},
  "supervisor": {"lease_present": true, "heartbeat_fresh": false, "heartbeat_age_seconds": 44256.14, "lease_expired": true},
  "recorded_mode": {"state": "unknown", "scheduler_state": "", "autonomy": "", "since": null, "last_decision": null, "limits": null,
                    "allow_merge": null, "persistent": null, "paused_reason": "", "dispatched": [], "started": [], "held": []},
  "read_at": "2026-11-12T22:17:26.140372Z",
  "report": {
    "project": {"folder": "p"},
    "factory_present": true,
    "policy": {"present": true, "usable": true, "enabled": true, "paused": false, "autonomy": "supervised", "allow_merge": false,
               "persistent": false, "enabled_at": "2026-11-12T09:00:00Z", "effective": "supervised",
               "note": "A summary read from the file. Whether execution is authorized is decided by MACH's run skill, not by the observer."},
    "lease": {"present": true, "runner_id": "R-1", "started_at": "2026-11-12T09:00:00Z", "heartbeat_at": "2026-11-12T09:59:50Z",
              "expires_at": "2026-11-12T10:01:00Z", "heartbeat_age_seconds": 44256.14, "expired": true, "same_host": false, "live": false},
    "counts": {"cells": 0, "cells_with_lifecycle": 0, "executions": 0, "archives": 0, "runs_log": false, "ledger": false, "events_log_bytes": 293},
    "read_at": "2026-11-12T22:17:26Z"},
  "freshness": {
    "observer_time": "2026-11-12T22:17:26.140372Z", "head": "75d7cc649aa0a9d4.1", "floor": "75d7cc649aa0a9d4.0",
    "ingest": {"last_tick_at": "2026-11-12T22:17:25.951Z", "last_tick_age_ms": 189, "stale": false, "stale_after_ms": 5000,
               "watermark_ms": 1794521844451, "catching_up": false},
    "projection": {"cursor": "75d7cc649aa0a9d4.1", "lag_events": 0, "partial": ""},
    "sources": [
      {"key": "ledger", "path": ".factory/intake/events.jsonl", "state": "live", "offset": 293, "size": 293, "lag_bytes": 0,
       "last_read_at": "2026-11-12T22:17:25.951Z", "last_read_age_ms": 189, "lines": 1, "refused": 0, "duplicates": 0, "oversized": 0, "resets": 0},
      {"key": "runs", "path": ".factory/archive/runs.jsonl", "state": "idle", "offset": 0, "size": null, "lag_bytes": null,
       "last_read_at": null, "last_read_age_ms": null, "lines": 0, "refused": 0, "duplicates": 0, "oversized": 0, "resets": 0}]}}}
```

The lease is under `report.lease` (and its age also as `supervisor.heartbeat_age_seconds`); there
is no top-level `lease`. `report.policy` omits `reason` when the policy is usable and never carries
`enabled_by`, the machine, tools or paths; `report.lease` never carries the host or PID. A project
with no `.factory/` answers `factory_present: false` and the same keys.

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
- **Types, by sniffing:** text (served by default as `text/plain; charset=utf-8`, cut to 256 KiB with
  `X-MACH-Truncated`), PNG, JPEG, GIF, WebP, WebM, MP4.
- **Text is scrubbed** by the one text scrubber the event path uses (`redact.ScrubDocument`, the same
  patterns as every event field): credential-shaped text, long opaque or long hex runs, e-mail
  addresses, absolute and home paths (the project root becomes relative), control and
  bidirectional characters; `X-MACH-Redacted: <n>` counts the replacements. In a served JSON record
  the hex values under the keys the catalog knows to hold hashes (`sha256`, `head`, `since_commit`,
  `commit`) are kept; any other long hex run is scrubbed, because a hex key looks exactly like a
  digest. The adversarial redaction test (`TestRedactionCoverage`) reads its corpus back through
  this path with zero leaks. The extension's class must match the contents (415 otherwise); HTML, SVG and
  binaries are refused. Caps: text 16 MiB read, images 16 MiB, video 64 MiB (413).
- **Images and video only when the project opts in:** `.factory/config.json`
  `{"tower": {"evidence_media": true}}` (tracked; read only; off by default, 403 `media-disabled`).
- **Headers:** `Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self';
  sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
  `Content-Disposition: inline` (`?download=1` for `attachment`), `X-MACH-Evidence-Match: match`,
  range requests for media. At most 4 content reads at once (503).

## What it never does

Each line is held by the tests named after it (`cmd/mach-observer` unless another package is given).

| Never | Proved by |
|---|---|
| Writes outside `.factory/local/observer/`, or anything at all in a project that had no `.factory/` when it started | `TestReadOnlyOverAFactoryTree` (every path's type, mode, size, mtime and contents hashed before and after a full run, every endpoint, a stream and a restart), `TestNoFactoryMeansNoWrites`, `TestNoGitRepositoryAndAFactoryThatAppearsLater`, `TestKilledMidReadLeavesTheFactoryAlone`, and `TestSourceBoundary` (file-system writes only in `internal/store`, `internal/lock`, `internal/project/persist.go` and `main.go`; the files that open MACH's read read-only) |
| Starts or signals a process | `TestSourceBoundary`: no `os/exec`, `plugin`, `unsafe`; no `os.StartProcess`, `os.FindProcess`, `syscall.Exec`/`ForkExec`; `syscall.Kill` only as `kill(pid, 0)` (a liveness check that delivers nothing) |
| Connects out | `TestSourceBoundary`: no `net.Dial*`, `net.Dialer`, resolver lookups, `tls.Dial`, `http.Client`, `http.Get`/`Post`/`Head`, `http.NewRequest`, default client or transport; `security.TestListenRefusesEverythingButLoopback` (it listens on `127.0.0.1` only, refusing every other address including the machine's real interfaces) |
| Takes or holds a lock on a MACH file, or holds one open between polls | `TestNoLockOnMACHFiles` (while it runs, every MACH file, `.factory/intake/lock` included, can be locked exclusively by someone else; its own lock file, the control, cannot), `TestNothingHeldOpenBetweenPolls` (its open files sampled every 20 ms: no MACH file stays open), `TestSourceBoundary` (`syscall.Flock` only in `internal/lock`) |
| Has a route that changes anything | `server.TestEveryOtherMethodIsRefused` (every method but GET on every route: 405 `Allow: GET`), every route registered as `GET /api/v1/...`; `TestReadOnlyOverAFactoryTree` reads every route and finds nothing changed |
| Offers a Factory capability | `server.TestSessionOffersNoFactoryCapability` (`read_only: true`, `capabilities.execution: false`, no capability that starts, stops, approves or changes work), plus the lines above: with no process, no write outside its folder and no non-GET route there is nothing to act with; `runner.json` and `supervisor.json` are read and summarised, never written (`TestReadOnlyOverAFactoryTree`) |
| Forwards a secret, a path outside the project, a tool's input or output, or a person's name | `ingest.TestRedactionCoverage` (an adversarial corpus planted in every source and in served evidence: zero leaks in stored events, the index on disk and served content), `ingest.Fuzz*` (any line: no panic, schema-valid output, no planted secret, the next line still read) |

## Tests

    go vet ./...
    go test ./...          # about 20 s
    go test -race ./...    # about 1.5 min; time limits scale by testkit.RaceFactor under -race
    go test ./internal/ingest -run '^$' -fuzz FuzzLifecycleLine -fuzztime 20s   # also FuzzIntakeLine, FuzzStreamRecord

`TestLargeVolume` ingests about 260,000 events normally and a tenth of that under `-short` or
`-race`.

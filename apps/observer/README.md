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
| `session` | versions (event schema 3, revision 2, the 54 kinds), generation, `display_policy {people: "role"}`, capabilities (`execution: false`, snapshot, artifacts, analytics, `evidence_media`, `stream_observations {policy: "structural", state, proven_versions, versions[{version, state, executions, records_refused}], ok, claude_code_version, reason}`), every limit below, session count, where the next link is kept | `state`: `proven`, `compatible-unproven`, `incompatible` or `unknown`, the worst over every stream ([Stream records](#stream-records-by-shape)) |
| `health` | `ok`/`degraded`, observer time, index head and floor, projection (position, lag, partial, `history` completeness by gap class), ingest (ticks, errors, `catching_up`, `late` and `backfill` counts, `runtime` (the streams' runtime summary), `delivery {settle_max_ms, adaptive, hold_ms_p50, hold_ms_p95, last_hold_ms, samples, released_by_bound}`), freshness (below), streams, sessions | degraded while the last tick erred, ingest has not ticked for 5 s, or the projection errs |
| `factory/status` | the Factory's files and how fresh they are; the exact shape is [below](#factorystatus) | files read at most once a second |
| `events` | v3 events after a cursor, in delivery order (`pos`) | `after`, `limit` 1–1000 (200), filters `ticket`, `execution`, `station`, `type` (prefix), `entity` (ref), `authority`; at most 10,000 events examined per request (`scanned`, then page on from `next`); 409 `cursor_reset`, 410 `cursor_expired`, 400 |
| `history` | a window of history in ORDER (the `order` key), for replay and the Timeline (contract 14): late events appear where they belong; `{events, from_order, to_order, next_from_order, more, complete, head, floor, watermark_ms, catching_up}` | `from_order`/`to_order` (an order key or its first 15 digits; `[from, to)`) or `from_ms`/`to_ms`; `entities` (up to 32 refs, comma-separated), `ticket`, `execution`, `type` (prefix); `limit` 1–5000 (1000); page on with `from_order=next_from_order` (a page never splits events sharing an order key); reads the memory window through its order index (a window costs its own size); `complete: false` when events of the window may have been evicted |
| `series` | event counts per time bucket, by kind and authority, placed by `order_ms`, for drawing a long timeline without fetching every event: `{from_ms, to_ms, bucket_ms, buckets[{from_ms, count, kinds, authorities}], total, kinds, authorities, complete, source, head, floor, watermark_ms}`; empty buckets left out | `from_ms`, `to_ms` (default: everything counted), `bucket_ms` (a whole number of seconds; default the smallest clock step, 1 s to 1 day, that keeps the range within 500 buckets; at most 2,000 buckets, 400 beyond), `ticket`, `execution`. Whole-minute buckets with no filter come from counts kept per minute for everything indexed (`source: "minutes"`, rebuilt from the segments on a restart); finer buckets or a filter are counted from the memory window (`source: "memory-window"`, `complete: false` when it no longer holds the whole range) |
| `stream` | live SSE: `hello`, one message per event (`id:` = cursor), `heartbeat {head, scanned, watermark_ms}`, `gap`, `reset` | `Last-Event-ID` or `after`, else head; same filters; batches of 256; 16 streams (503 + `Retry-After`); 10 s write deadline, then dropped; heartbeat 15 s; `retry: 2000` |
| `snapshot` | the projected state at a cursor (`at`, default the projection's position) and that cursor; stream from it with `Last-Event-ID` for no gap and no repeat; `state.history` says how complete history is (below) | at the head: built from the live projection and kept until it moves (230,853 events: 0.6 s the first time, then the kept bytes); `reconstructed: true` for an earlier cursor (rebuilt from the nearest checkpoint); 410 when it can no longer be rebuilt; 409 ahead or another generation |
| `project` | slice counts by scheduler state, active cells, running executions, open human gates, integration commit, recorded Factory mode, history gaps | |
| `waves`, `waves/{wave}` | delivery waves; detail with each slice's state and wait | |
| `slices`, `slices/{slice}` | scheduler state (`completed`, `active`, `ready`, `blocked`, `superseded`), dependencies, recorded reasons, `waiting {kind: dependency \| capacity \| person \| unknown, basis, reasons, since}`, state history, earlier revisions | `wave`, `state`, `limit`, `offset`; capacity only from `capacity.wait_changed` or the scheduler's fixed sentence; never from silence |
| `cells`, `cells/{ticket}` | cells; `app_type` and `risk` (`null` while unknown, never `""`; the same in `plan`), `plan {app_type, risk, contracts, tasks, recorded_by}` (the plan station's exit); detail adds visits (with gates, tasks, checks, measured duration), rounds, gates, build tasks, verification checks and targets, review rounds with panel, verdicts and decision, findings (prose), human approvals (role only), merge, cleanup, human gates, wait | `stage`, `archived`, `limit`, `offset`; gates capped at 1,000 per cell (`gates_dropped`) |
| `cells/{ticket}/visits/{visit}` | one visit and its events (visit as `build%232`) | up to 1,000 events still held |
| `cells/{ticket}/evidence` | the cell's catalogued artifacts and its recorded checks, each evidence file linked to its catalog id and integrity | |
| `runs`, `runs/{execution}` | executions: state (`claimed`, `running`, `ended`, `finished`, `failed`, `interrupted`, `timed-out`, `could-not-start`, `unknown`), true process times (`time_basis: process`) or the supervisor's (`bounded`), cost with its source (stream usage, else MACH's record; null with a reason), tokens and cost per model, `cost_may_be_under_reported` with reasons (from the stream's own `execution.usage.cost_complete` when there is one; the process ending interrupted, timed out or unknown also counts), refused tools, recovery; detail adds workflows, usage, session | `state=active\|finished\|unknown`, `ticket`, `limit` (200, max 1000), `offset` |
| `runs/{execution}/agents` | workflow agents and Agent-tool sub-agents: label, phase, model, state, queue wait, run time, token total, tool-call count, last tool, refusals | never a cost, never per-call records |
| `runs/{execution}/tools` | main-loop and Agent-tool sub-agent tool calls, with spans; refusals | workflow agents' calls are a count only |
| `spans` | the Execution Timeline's spans (shared contracts 2): wave, slice-wait, slice-eligible, cell, round, visit, task (start inferred: `previous-completion`), seat, gate-wait, person-wait, claim, execution, workflow, agent-queue, agent, tool; each with start/end event, precision, `duration {ms, min_ms, max_ms, basis: measured \| bounded \| inferred \| open \| unknown}`, outcome, lane, authority | `ticket`, `execution`, `wave`, `entity`, `kinds`, `limit`, `offset`; at most 5,000 spans |
| `artifacts`, `artifacts/{id}` | the evidence catalog, metadata only: id, ref, path, kind, nature (`evidence`, `record`, `prose`), media type (sniffed), bytes, sha256, recorded sha256, integrity, `verified_evidence`, targets, round (and `round_basis`), commit, `visit_id` and `visit {visit_id, basis, rule}`, provenance, `content_access` | `ticket`, `kind`, `nature`, `limit`, `offset`; refreshed at most every 2 s. `visit.basis`: `recorded` when a verification check names the file with its hash (`rule: check-hash`); `reconstructed` when joined by its verification folder (`folder`), by round and file time (`round-and-time`) or by round only (`round`) |
| `artifacts/{id}/content` | the bytes, by catalog id only | see below |
| `analytics/metrics` | every metric of the shared catalog: value, numerator, denominator, coverage, basis, source, authority, limitations, availability, target and `met` for the observe station's metrics; unavailable values null with a reason | `ids`, `group_by` (`day`, `risk`, `app_type`, `station`, `round`, `seat`, `model`, `phase`, `wave`, `stage`, `gate`, `reason_code`, `kind`, `tool`, `rule`, `target_kind`, `stop_reason`, `writer`, `ticket`, `token_kind`); 2,000 groups per metric |
| `analytics/runs` | `run.recorded` rows (the observe station's input) | `limit`, `offset` |

### History completeness (`snapshot` `state.history`, `project` `history`, `health` `projection.history`)

`{completeness: "complete" | "partial", lost: {<class>: n}, not_interpreted: {"unknown-type": n}, classes, gaps (by
reason), partial (the projection's own reason, when history before a position is no longer held), not_v3}`. Each
`history.gap` has a precise `reason`, a `class` and `history_lost` (contract 6.5): `not-received` (bytes missing:
`missing-seq`, `truncated`, `rewritten`), `unparsable-line`, `unknown-type` (received and well formed, not interpreted:
`unknown-type`, `unexpected-shape`), `state-mismatch`, `evicted`, `source-unreadable`, `conflict`. Only the classes that
lose history make it partial; `unknown-type` and `conflict` never do.

### Freshness (`health.freshness` and `factory/status.freshness`)

`{observer_time, head, floor, ingest: {last_tick_at, last_tick_age_ms, stale, stale_after_ms,
watermark_ms, catching_up}, projection: {cursor, lag_events, partial}, sources: [...]}`. One entry
per tailed source (intake log, each cell's lifecycle log, each execution stream, `runs.jsonl`):
`{key, path, state (live | idle | stale | ended | gone | blocked | unreadable | unknown), offset,
size, lag_bytes (size − offset), last_read_at, last_read_age_ms, lines, refused, duplicates,
oversized, resets}`. `size` is the file's size at its last read; `size`, `lag_bytes` and
`last_read_at` are null for a source that is missing or refused, or not read yet. A busy tick
(more than 20,000 events waiting) leaves some sources for the next one, so a source's
`last_read_at` can be older than the last tick; so can a cold source's (polled every 2 s, [Latency](#latency)).

### Late and backfill

`late: true` means an event was read live and delivered after the observer had already delivered
an event that sorts after it in history order. Events are held only as long as needed (the
**adaptive settle**, contract 6.5): an event is committed as soon as every tailed source that has a
file has been read through past its time (less 10 ms); the 1.5 s window bounds the hold when a source
is behind (a backlog over a tick's 5,000-event budget) or cannot be read. A cold source ([Latency](#latency)) holds
nothing back, so its first line after a quiet spell can be committed after a hot source's later event and be marked late.
History that was on disk before the observer
started (or before an index rebuild), and anything derived from it, is **backfill**: delivered in
read order while `catching_up` is true, never late, with `provenance: {basis: [], rule:
"backfill", files: []}` (or its own provenance if it is reconstructed). A file that appears while
the observer runs is live from its first line, also when it was absent at the first poll (D16).
`health.ingest.late` and `.backfill` count both.

### Latency

Append to SSE receipt, measured by appending lifecycle lines and reading `/stream` (the M6.2 acceptance measured
append to paint at median 1,673 ms, p95 2,333 ms, nearly all of it the fixed 1.5 s window):

| Load (default poll rates: 150 ms while anything changes, doubling to 500 ms) | Median | p95 | Before (fixed 1.5 s) |
|---|---|---|---|
| busy: 4 cells, a line every 0.3–1.1 s each, 40 s (two runs) | 123–132 ms | 301–357 ms | 1,666 / 1,749 ms |
| a quiet Factory waking up: one line every 3 s (14 lines per run) | 136–297 ms | 484–511 ms | 2,090 / 2,503 ms |

**Polling tiers (R3 of the M6.2 re-check).** A source is **hot** while it is new, while its execution is running (and
so is that execution's cell), and for 2 minutes after this observer last saw it change (a live line, a rewrite, a new
`cell.json`; when the catch-up ends, a file written in the last 2 minutes counts); a hot source is polled every tick
(150 ms while anything changes, doubling to 500 ms). Every other source is **cold**: polled once every 2 s, spread over
the ticks, one `lstat` of its log (a cold cell's `cell.json` every fourth cold poll), and it does not hold back the
adaptive settle. The folders that hold sources (`worktrees/`, `local/executions/`, `archive/`) are listed again only
when their own time changes (and at least every 10 s); an idle tick allocates nothing per source. Cost and price, on
the same machine:

| Measure | Before | Now |
|---|---|---|
| busy: 4 cells, a line every 0.3–1.1 s each, 40 s | 127 ms / 297 ms (median / p95) | 128 ms / 302 ms |
| one line every 3 s on one cell | 271 ms / 444 ms | 319 ms / 498 ms |
| a hot cell (a line every 0.7 s) while 12 quiet cells wake | 193 ms / 433 ms | 227 ms / 477 ms |
| **the first line on a cell quiet for 2 minutes or more** | 290 ms / 510 ms, never late | **905 ms / 1,960 ms; 9 of 12 marked `late`** |
| idle CPU, 1,263 cells and 230,853 events, no client (steady, 60 s, `ps` CPU time) | 25–36 % of a core | **0.95–1.27 %** |

So a cell that wakes after a quiet spell can have its first line arrive up to 2 s after it was written and be marked
`late: true` (an event of a hot source sorting after it was committed first); every following line is hot. A 1 s cold
interval gave 1.48 % idle and 778 / 1,225 ms for that first line. `heartbeat.at_ms` and `watermark_ms` on the stream,
and `health.ingest.delivery`, show the live edge and the holds.

### Memory and the index

Reading a 230,853-event history (100 MB of sources, 1,261 cells) from a clean copy, measured with `/usr/bin/time -l`
(maximum resident set size) and catch-up as the first `health` with `catching_up: false`, lag 0 and the head unchanged
for 2 s: **catch-up 16.5–18.7 s, peak RSS 260–281 MiB** (before this round, on the same machine: 29.6–36.4 s and
300–331 MiB; the M6.2 re-check measured 35.2 s and 257 MiB), index on disk 233 MiB. The catch-up had slowed because the
live heap sat at the soft memory limit, so the collector ran hundreds of times a second (and, after catch-up, three times
per idle tick: R3). Now the store keeps the served envelope of only the newest 16,384 events of its 50,000-event memory
window; the older ones keep their index fields and where their line is in a segment, and are read back (one positioned
read, then expanded) when asked for, byte for byte what was served when they were new. That took 98 MB of a 176 MB live
heap down to about 30 MB. Also bounded by: a tick reads at most 5,000 events (and the next follows at once while a
backlog remains); projection checkpoints share every cell, slice, execution and wave that did not change (32 kept); the
saved projection is written at most every 15 s; the segments hold each event in a compact form (the envelope without
nulls, empties and zeros; `data` exact), expanded when read; the Go runtime has a soft memory limit of 208 MB
(`GOMEMLIMIT` overrides).

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
- **MACH's JSON records are redacted by kind** (`redact.ScrubRecord`): `decision.json`, votes, `results.json`,
  `summary.json`, `build-report.json`, `cell.json`, run records. Every person-bearing field (`by`, `recorded_by`,
  `approved_by`, `enabled_by`, `author`, `committer`, names and e-mails, a vote's `reviewer` unless it is a seat, and
  every person field of a `human_approval` or `approval` object) becomes `"a person"`, unless it holds a role MACH
  wrote (R2): a role word, or a phrase whose first word after "a", "an" or "the" is a role (`agent`, `line`,
  `supervisor`, `engineer`, `reviewer`, `person`, ...) with no capitalised word after it and no known name in it, such
  as review.py's `"recorded_by": "an agent, on the person's instruction in conversation"`, which is kept so an agent's
  act is not credited to a person. Role phrases are never learned as names. Known keys are scrubbed as
  text; an unknown key keeps its value only if the scrubber would leave it untouched (else `"[withheld]"`); key order
  is kept; `X-MACH-Redacted` counts all of it. A record that is not JSON, and any other file, is scrubbed as text.
- **Text is scrubbed** by the one text scrubber the event path uses (`redact.ScrubDocument`, the same
  patterns as every event field), which also keeps the relative names of the catalog's artifacts (D25:
  `review/round-3/findings.md` is no longer taken for an opaque token): credential-shaped text, long opaque or long hex runs, e-mail
  addresses, absolute and home paths (the project root becomes relative), control and
  bidirectional characters; `X-MACH-Redacted: <n>` counts the replacements. In a served JSON record
  the hex values under the keys the catalog knows to hold hashes (`sha256`, `head`, `since_commit`,
  `commit`) are kept; any other long hex run is scrubbed, because a hex key looks exactly like a
  digest. The adversarial redaction test (`TestRedactionCoverage`) reads its corpus back through
  this path with zero leaks. The extension's class must match the contents (415 otherwise); HTML, SVG and
  binaries are refused. Caps: text 16 MiB read, images 16 MiB, video 64 MiB (413).
- **Free text is labelled, not withheld (R1, the product owner's decision).** A served text that holds prose the
  observer cannot check for names that no record gives says so. On the catalog entry (`artifacts`, `artifacts/{id}`,
  `cells/{ticket}/evidence`): `"free_text": true` and `"free_text_note": "free text, not checked for names"` (else
  `false` and `null`; always `false` for media and for content that is not served). On the content reply: the header
  `X-MACH-Free-Text: unchecked-for-names` (absent otherwise), next to `X-MACH-Redacted`. Free text: any text that is not
  a MACH record of a known kind (`findings.md`, transcripts, logs, unknown JSON), and a record any of whose values is
  a string of more than one word outside its person fields and `command` (a verifier's `note`, a finding's `title` and
  `detail`, an approval note). A record of identifiers, numbers, times, hashes and paths only is not labelled.
- **Images and video only when the project opts in:** `.factory/config.json`
  `{"tower": {"evidence_media": true}}` (tracked; read only; off by default, 403 `media-disabled`).
- **Headers:** `Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self';
  sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
  `Content-Disposition: inline` (`?download=1` for `attachment`), `X-MACH-Evidence-Match: match`,
  range requests for media. At most 4 content reads at once (503).

## People

People's names are never sent to the browser in this milestone. Besides the per-field rules above, the observer keeps
a per-project deny-list of the names and e-mail addresses MACH's own files give for people: approvals in review
decisions, the intake log's `by` and `approval.actor`, `runner.json`'s `enabled_by`, the person fields of a cell's
records, and the project's git identities (`[user]` in `.git/config`, the name and e-mail of each entry of
`.git/logs/HEAD` and of each worktree's reflog, read as files; git is never run). Role words MACH writes (`engineer`,
`supervisor`, seat names, and role phrases such as "an agent, on the person's instruction in conversation") are never
taken for names. Every name is replaced by `"a person"`, case-insensitively and as a whole word, in every event string
before it is stored, in every served document, and, as the last filter, in every API reply body.

What is guaranteed and what is not (a known limit, decided by the product owner: label, do not withhold):

- **Guaranteed:** a name or e-mail address that MACH's records or the project's git identities give is never served,
  in any event, document or reply, once the observer has read that record (the deny-list only grows; it is read before
  a cell's new lines are normalised). E-mail addresses are scrubbed wherever they appear, known or not.
- **Not guaranteed:** a name that appears **only in free text** (a reviewer's finding, a verifier's note, a transcript)
  and in no record or identity is not recognised and is served as written. Every artifact whose text can hold such
  prose is labelled (`free_text`, `X-MACH-Free-Text`, [Artifact content](#artifact-content)), so the Control Tower can
  say so. Once a record names that person, later replies scrub it, but what was already served is not recalled, and the
  stored index may hold it until a rebuild.

## Stream records by shape

The execution-stream parser is not pinned to a Claude Code version (M6.2 D1). Each record is accepted or refused on
its own shape (the type of every field the parser reads); a refused record yields a `history.gap` with
`reason: unexpected-shape` and nothing else. Each stream's runtime is `proven` (2.1.322 and 2.1.323, the fixtures'
versions), `compatible-unproven`, `incompatible` (records refused: counted) or `unknown`, on each stream event
(`origin.runtime_state`), each stream source's `runtime` in freshness, `health.ingest.runtime` and
`session.capabilities.stream_observations`. Details: `docs/mach-next/M6_1_STREAM_COMPATIBILITY.md` section 8.

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
| Forwards a secret, a path outside the project, a tool's input or output, or a person's name | `ingest.TestRedactionCoverage` (an adversarial corpus planted in every source and in served evidence: zero leaks in stored events, the index on disk and served content), `TestPeopleNeverReachTheBrowser` (14 names and e-mails planted in a decision's approval, findings, results, a vote, a build report, the intake log, `runner.json`, `.git/config`, a reflog and a run record: zero in events, history, snapshot, cells, runs, series, the artifact catalog and every served content, the stream, and the index on disk), `redact.TestScrubRecordByKind`, `ingest.Fuzz*` (any line: no panic, schema-valid output, no planted secret, the next line still read) |

## Tests

    go vet ./...
    go test ./...          # about 20 s
    go test -race ./...    # about 1.5 min; time limits scale by testkit.RaceFactor under -race
    go test ./internal/ingest -run '^$' -fuzz FuzzLifecycleLine -fuzztime 20s   # also FuzzIntakeLine, FuzzStreamRecord

`TestLargeVolume` ingests about 260,000 events normally and a tenth of that under `-short` or
`-race`.

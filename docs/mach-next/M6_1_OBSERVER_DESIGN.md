# MACH Next — M6.1/M6.2 design: the read-only Factory observer

Status: design, with a working skeleton in `apps/observer` (binary `mach-observer`) on `feature/mach-next-m6-1-live-observability`, baseline `cac989e`. Experimental, like the rest of MACH Next.

**After the M6.1 hardening** the observer is built well past the skeleton this note describes: the full version 3 envelope, five sources, segments and retention, snapshots, spans, the artifact route, analytics, and restart recovery. `apps/observer/README.md` is the reference for the API as served and for what the observer never does (with the tests that prove each line); where this note and the README differ, the README describes the code. The decisions this note records in the hardening: the Timeline's spans route is `GET /api/v1/spans` (section 12); text evidence is served by default, scrubbed, by catalog id, and images and video only with the project's `tower.evidence_media` opt-in (section 13); an unrecognised stream or ledger record becomes `history.gap` with `reason: unknown-type` (section 5.2); a cell with no lifecycle log gets `history.began` only and is labelled reconstructed; `tool.refused` carries the tool name only; a second browser reads the next link from `.factory/local/observer/link`, with at most 16 browser sessions (section 14); sessions and the port survive a restart (sections 14, 15); `late` never marks backfill (section 9).

The M6.0 Control Tower draws a simulation (`M6_0_ARCHITECTURE.md`). Section 7.2 of that note replaces the fixture and the clock with "a read-only observer's output: a merged, ordered stream". This note designs that observer: a local service that reads MACH's own files, never changes them, keeps a redacted index of what it saw, and serves snapshots, history and a live stream to the browser.

Three things this design depends on were written in parallel. Each place that depends on them is marked **DEPENDS ON** here and in the code. The event contract and the lifecycle schema landed in the worktree before this wave ended; the skeleton was aligned to them where a difference would lose or mislabel data, and the rest is listed in section 6.1 and for the lead (section 20).

| Dependency | Owner | State at the end of this wave |
|---|---|---|
| `M6_1_EVENT_CONTRACT.md` and `schemas/factory-event.v3.schema.json`, the version 3 view | m61-contract | Written. The skeleton follows its event IDs, authority meanings, `round`, `history.gap` and cursor form; it does not yet emit the full v3 envelope (section 6.1). The contract wins where they differ. |
| `schemas/cell-lifecycle.schema.json` and `skills/intent/scripts/lifecycle.py` | m61-lifecycle | Written. `{"v":1,"seq"(nullable),"at"(ms),"ticket_id","type"(11 kinds),"station","visit","round","execution_id","data"}`. The skeleton has a per-kind allowlist for all 11 kinds and a test over a log written by the real helper. |
| `stream.jsonl` record format | m61-stream-proof | `M6_1_STREAM_COMPATIBILITY.md` and fixtures exist; the skeleton registers no stream handler yet, so every record is unrecognised (section 5.2). |

---

## 1. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | **A separate binary, `mach-observer`, in its own Go module `apps/observer`**, not a mode of `mach-studio` | Product Studio's host runs `studio.py` operations that write, and an interview bridge that starts `claude`. A mode of that binary would carry both into the observer's address space, so "read-only" would be a promise about routing, not a property of the program. A separate binary has no route, no engine and no process launcher to reach. M5_DESIGN §8 asks for exactly this: "a separate surface with its own operation list". |
| D2 | **Standard library only; no dependency added** | Same rule as M5's host. Every need here (tailing, an append-only index, HTTP, SSE, JSON, hashing, `flock`) is in the standard library. A dependency would be the first in a binary that reads private execution data, and would need supply-chain review per release. |
| D3 | **Polling, not kqueue/inotify** | Adaptive interval: 150 ms while sources change, doubling to 1 s when idle. Idle cost is one `lstat` per source and one `readdir` of `.factory/worktrees` per second. `syscall.Kqueue` and `syscall.InotifyInit1` are in the standard library, so notification is possible without a dependency, but it needs two implementations, per-directory watch management for appearing cells, and a polling fallback anyway (watch overflow, network file systems). Worst-case latency is 1 s, typical under 200 ms while a run is active, which the Control Tower's own 500 ms view batching (`shell/Stage.tsx`) already absorbs. The poller sits behind one call (`Observer.Tick`), so a notifier can wake it early later without changing anything else. |
| D4 | **Index: an append-only event log plus in-memory windows, rebuilt on start**, not SQLite or bbolt | Section 7. The index holds already-redacted events; its queries are "after cursor N", "by ticket", "by execution", "by type", "time range", all served from memory over a bounded window plus sequential reads of older segments. SQLite (`modernc.org/sqlite`, pure Go) would add roughly a million lines of transpiled C; bbolt is small but adds a dependency whose only advantage here is B-tree range scans. Revisit if analytics (M6.3) needs ad-hoc aggregation over months of history. |
| D5 | **Redaction runs before indexing.** The index holds only what the browser may see | A projection that holds secrets is a second copy of them on disk, with its own retention and permission problems. Redacting first means deleting or leaking the index leaks nothing beyond the API. The cost: a tightened rule needs a rebuild, which `redaction_version` in `meta.json` triggers automatically (section 7.4). |
| D6 | **Deny by default at every source.** Every normalizer is an allowlist table; unknown record types keep their identities and lose their data; the stream path admits no free text at all | Section 5. |
| D7 | **Cursor order is acceptance order; display order is computed** | The merged cursor is the position the observer gave an event when it accepted it. It never changes within a generation, so reconnection and paging are exact. Time order (occurred time, then source rank, then sequence) is a view the timeline and snapshot endpoints compute (section 9). Late events never invalidate a cursor. |
| D8 | **The stream has no per-client queue.** Each client pulls from the store after its cursor | Section 11. Ingest only closes a channel when it appends; it cannot block on a client. A slow client falls behind in the store, and is told when it falls past the floor. A stalled socket hits a per-write deadline and is dropped. |
| D9 | **GET only, everywhere.** Any other method is refused before routing with 405 and `Connection: close` | There is nothing to attach a write to. No CSRF token is needed because nothing changes state; `Origin` and `Sec-Fetch-Site` are checked on every API request anyway (section 14). |
| D10 | **The observer starts no process and makes no outbound connection** | It prints its one-time link; the skill (or the person) opens it. M5's host starts `open`/`xdg-open`; the observer does not, so `os/exec` is absent from the binary, which a test holds (section 18). |
| D11 | **It writes only under `.factory/local/observer/`**, and only when `.factory/` exists | A project with no Factory is observed from memory; the observer never creates a Factory. A `.gitignore` of `*` inside its folder keeps it out of `git status` even where `.factory/local/` is not ignored (an older install), so it cannot dirty the tree the audit's hygiene pillar checks. |

---

## 2. Shape

```
  .factory/intake/events.jsonl ─┐   (v2 ledger events, global seq)
  .factory/worktrees/*/lifecycle.jsonl ─┤   (cell lifecycle, per-cell seq)       read-only, no locks,
  .factory/local/executions/*/stream.jsonl ─┤   (Claude stream; DEPENDS ON format)  O_NOFOLLOW|O_NONBLOCK
  .factory/archive/*.tar.gz, runs.jsonl ─┘   (later: archived cells, run records)
                    │  tailers (offset + inode + first-line epoch), one goroutine
                    ▼
            normalizers (allowlist per source and type)  ──►  redaction (ids, words, scrubbed prose)
                    │  normalized v3 events, deterministic IDs
                    ▼
            store: events.log (fsync) ─► checkpoints.json (atomic)  ─►  in-memory window, Changed()
                    │                                                    (projections: section 10)
                    ▼
   mach-observer HTTP on 127.0.0.1:<port>   GET only, session cookie, Host/Origin/Sec-Fetch-Site, CSP
     /api/v1/...  JSON envelope (as M5)     /api/v1/stream  SSE, pull-based, Last-Event-ID
                    ▼
            Control Tower (web/apps/control-tower), embedded in the binary
```

---

## 3. Separate binary, port, start and shipping

**Binary.** `apps/observer` is a new module `mach/observer`, binary `mach-observer`. Security code is copied from `apps/studio/internal/security` with attribution in a comment, not extracted, so Product Studio is not touched in this wave. Extracting a shared `apps/internal/localhost` package is a later refactor with both hosts' tests as the guard.

**Port.** A free loopback port chosen by the kernel (`--port` exists for the skill and tests). The listener accepts only the literal `127.0.0.1`; names (including `localhost`, which a hosts file can redirect), wildcards, `::1`, `127.0.0.2` and every other interface are refused before binding. The command line has no address flag.

**Start.** By a skill, as Product Studio's host is: a `/mach-run factory` or Control Tower skill step "open the Control Tower" locates `.factory/bin/mach-observer` (or a local build), runs `mach-observer --project <root>` in the background for the session, reads the `Open:` line and opens it. No new user-facing MACH command. Flags: `--project`, `--port`, `--memory-events`. The process ends with the session (Ctrl+C / SIGTERM): it closes every stream and stops ingest. One observer per project per machine: a `flock` on `.factory/local/observer/lock` (the observer's own file; it never touches `.factory/intake/lock`).

**Shipping (not changed in this wave).** The plan mirrors M5_DESIGN §7.1: the `release` workflow gains a matrix entry per platform building `mach-observer-<os>-<arch>` with the Control Tower's build embedded (a `build.sh` like M5's that checks the build runs under the CSP), a `smoke.sh` that starts it on a throwaway project and fetches `/api/v1/health` through the cookie, `SHA256SUMS` and an attestation. `bin/mach install` fetches it to `.factory/bin/mach-observer` next to `mach-studio`, checksum-checked, and a failed download never fails the install.

---

## 4. Tailing

### 4.1 Identity and position

Each source file has a checkpoint: project-relative path, device and inode, byte offset (always just after a newline), physical line count, **generation** (`epoch` in the code: the first 8 hex of SHA-256 of the file's first line, the contract's `<gen>`), the highest source sequence and line accepted, and counters (lines, refused, duplicates, oversized, resets). The lifecycle helper never extends a torn line (it starts its next record on a new line), so a torn line becomes one unreadable physical line that is counted and refused. Checkpoints are persisted after the events read up to them (section 7.2).

| What happened | How it is recognised | What the tailer does |
|---|---|---|
| Growth | size > offset | Reads at most 4 MiB from the offset; returns complete lines only. |
| Torn last line | bytes after the last newline | Holds them back; the offset stays at the line's start. When the newline arrives the whole line is read. |
| Over-long line (> 1 MiB) | no newline within 1 MiB | Counted as oversized and skipped to the next newline; never buffered whole. |
| Truncation, same history | size < offset, first line unchanged | Reads again from 0 and drops what it already has: by `seq` for the intake log, by physical line for a lifecycle log. Emits `history.gap` (`reason: truncated`). |
| Replaced, same history | new inode, first line unchanged, not shorter | An atomic rewrite that kept history: continues at the offset. Source state only. |
| Recreated, other contents | first line differs | New generation: offset, line count and last sequence back to 0. Event IDs include the generation, so a recreated file whose numbering starts again never collides with the old one. Emits `history.gap` (`reason: rewritten`). |
| Disappeared | `lstat` fails, or the cell folder is gone | Source state (`gone`, persisted), reported by `/factory/status`; not a history event. |
| Link or special file | `lstat` is not a regular file, or `open(O_NOFOLLOW)` fails with `ELOOP` | Refused and never opened; source state (`blocked`). `O_NONBLOCK` stops a FIFO swapped in after the check from blocking the loop. |

Live versus backfill: lines already on disk when a tailer first looks (at the observer's start, or after an index rebuild) are backfill, because their observation time says nothing about when the fact happened; a file that appears while the observer runs is live from its first line. Backfill is never `late` (section 9).

### 4.2 Discovery

Every tick, one `readdir` of `.factory/worktrees`: each entry that is a real folder (not a link) with a valid ticket ID gets a lifecycle tailer. `.factory` and `.factory/worktrees` are `lstat`-checked each tick; a linked cell folder is never followed. A lifecycle line whose `ticket_id` is not its folder's is refused (`wrong-ticket`): one cell cannot speak for another.

### 4.3 Archival of a cell

Cleanup archives the cell folder (including `lifecycle.jsonl`, to which cleanup adds its own records only in the archived copy) to `.factory/archive/<t>.tar.gz` and then deletes it. Lines appended between the observer's last poll and the deletion are therefore only in the archive. **Not built yet:** when a cell's source goes, the observer will open the archive (gzip + tar from the standard library, member size cap, member name must be exactly `lifecycle.jsonl` at the archive's cell root, no links), resume from the checkpoint's offset inside the member, and emit the remaining lines. They stay `authoritative` (contract section 7: copying a file does not change who wrote it), and because the live file and the archived copy share their first line and prefix, they have the same IDs and the overlap is dropped as duplicates. A ticket recreated after cleanup reuses the folder; its new file is a new generation.

### 4.4 Source 3: execution streams (DEPENDS ON the stream proof)

Plan, not built: one tailer per `.factory/local/executions/<id>/stream.jsonl`, polled while `result.json` is absent and read once to the end afterwards. Read caps matter here: a stream line can carry a whole file (every `Edit` does), so the 1 MiB line cap and 4 MiB per-poll cap apply, and the per-execution `Stream` normalizer counts what it skips. Execution folders are `0700`; the observer runs as the same user, so it can read them, and must not widen anything it learns from them (section 5).

---

## 5. Normalization and redaction

### 5.1 Where it runs

In the ingest goroutine, between the tailer and the store. Nothing un-normalized is ever stored, logged or served. The log line for an HTTP request carries method, path, status and duration, never the query (the start token travels there), headers or a body.

### 5.2 Rules

- **Envelope fields** become typed identities: `project_id`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `execution_id`, `runner_id`, `station`, `visit`, `round` (the judging round; the supervisor's execution `attempt` stays in `data`), `actor`. Each passes `redact.ID` (`^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$`, no `..`, and refused if it matches a credential pattern, so `sk-ant-…` cannot pass as an ID) or `redact.Token` (a lower-case word). A value that fails is dropped, not repaired.
- **Data** passes a per-type table of `field → kind`: identifier, identifier list, word, word list, commit, digest, number, integer, boolean, relative path, count (a list reduced to its length), present (reduced to a boolean), numbers (an object of numbers), and **text**. Fields not in the table are dropped and counted in `withheld`.
- **Text** is kept only where MACH writes prose meant for people (`dependency.blocked.reasons`, `human.required.reason`, `factory.paused.reason`, `scheduling.decided.held[].why`). It is scrubbed: the project root becomes `<project>` or a relative path; other absolute and home paths become `[path]`; private keys, `sk-`/`ghp_`/`xox`/`AKIA`/`AIza` tokens, `Bearer`/`Basic` values, `NAME_WITH_KEY|TOKEN|SECRET|PASSWORD…=value`, and opaque strings of 40+ characters become `[redacted]`; control and bidirectional-override characters are removed; the result is cut to 280 characters. The browser shows it as text, never as markup.
- **Never kept from the ledger:** `by` (a person's name; shown as the actor's role), `session_id` (it can resume a Claude session), `previous_pid`, `claude_error` (reduced to `claude_error_present`), `refs` (paths; the observer's own artifact catalog replaces them), `problems` (reduced to a count), `approval` (reduced to `approved`).
- **Lifecycle data:** a table per kind for all 11 kinds of `schemas/cell-lifecycle.schema.json`, from the contract's section 10.2 (raw names; renaming to v3 names comes with the full envelope). Station outcomes, decisions, votes and tiers are kept as short labels (an identifier of at most 40 characters: `PASS`, `APPROVED`, `Gold`). `station.entered`, `station.exited` and `gate.evaluated` also keep their other integer and boolean facts under `data.counts`, as the contract allows; no other unknown key passes. `overridden_by_reason` is reduced to `override_reason_given`. Evidence is `{file, sha256}` with a relative path. No note, failure tail, test output, finding text or name. An unknown lifecycle kind keeps its identities and loses its data. `TestLifecycleHelperOutputIsAccepted` runs a log written by the real helper (one record of every kind) through the normalizer and requires every line accepted with nothing withheld.
- **Stream:** records are classified by `type`/`subtype`; only a classification with a registered handler is read. An unrecognised record yields no content: it becomes `history.gap` with `reason: unknown-type` (once per classification and stream, with its line) and a counter in the source's state. A handler's output is filtered again: keys must be words, values must be numbers, booleans, identifiers or words. Free text, objects and lists are dropped whatever the handler returned. So a tool's input, a file's contents, a command line, a transcript or an environment value cannot reach the index even through a faulty handler. A test feeds a deliberately careless handler and checks.
- **Unknown ledger types** (a newer writer) become `history.gap` with `reason: unknown-type`, no data. There is no `ledger.unrecognised` or `stream.unrecognised` kind.
- **Lifecycle `seq` may be `null`** (the helper writes without it when it cannot take its lock within 0.2 s). Such a record is accepted; its position is its physical line. Sequence gaps are checked only between two numbered lifecycle records.

### 5.3 Versioning

`redact.Version` changes whenever a rule or allowlist changes. The index records the version it was built under; a mismatch at start discards the index and rebuilds from the sources under a new generation, so a tightened rule applies to history.

---

## 6. The normalized event (version 3)

The contract (`M6_1_EVENT_CONTRACT.md`, `schemas/factory-event.v3.schema.json`) defines the envelope. What the skeleton emits today:

```json
{
  "v": 3,
  "id": "c:T-7:9a0c41d2:12",              // contract 5.1: i:<gen>:<seq> | c:<ticket>:<gen>:<line> | s:<x>:<line>.<part> | o:gap:...
  "cursor": "6b1f0e9a2c4d8e10.1042",     // <index epoch>.<pos>, assigned by the observer
  "type": "station.entered",
  "authority": "authoritative",          // authoritative | observed | reconstructed (contract section 7)
  "source": {"kind": "cell", "key": "c:T-7:9a0c41d2", "epoch": "9a0c41d2", "seq": 12, "line": 12, "offset": 2048},
  "subject": {"project_id": "P-1", "wave_id": "WAVE-001", "slice_id": "SLICE-003", "revision": 2,
              "ticket_id": "T-7", "execution_id": "x0123456789ab", "station": "build",
              "visit": "build#2", "round": 1, "actor": "station"},
  "occurred_at": "2026-11-12T10:00:01.250Z",
  "occurred_precision": "ms",            // ms | second | observed | unknown
  "observed_at": "2026-11-12T10:00:01.391Z",
  "live": true,                          // false: read during backfill
  "data": {"stage": "building"},
  "withheld": 0                          // source fields dropped by the allowlist
}
```

- **Authority** (contract section 7). `authoritative`: a MACH script recorded the fact as it decided it (intake log except `station.observed`, lifecycle, also when read from an archive). `observed`: a runtime record MACH did not decide (the stream; the supervisor's `station.observed` sampling). `reconstructed`: derived by the observer (`history.gap`). Recorded gate results outrank inferred activity.
- **Deterministic, readable ID** (contract 5.1): intake `i:<gen>:<seq>`, lifecycle `c:<ticket>:<gen>:<physical line>`, stream `s:<execution>:<line>.<part>`, gaps `o:gap:<partition>:<detail>`; components percent-encoded outside `[A-Za-z0-9._-]`. The same line read twice (after a restart, a crash, a truncate-and-rewrite, a rebuild, or from a cell's archived copy) has the same ID.
- **Observer events:** only `history.gap` (`source_key`, `from_seq`, `to_seq`, `count`, `reason`: `sequence`, `truncated`, `rewritten`). A vanished, linked or replaced file is source state, not history.

### 6.1 Where the skeleton still differs from the contract

| Contract | Skeleton today | Plan |
|---|---|---|
| Envelope fields `schema_revision`, `pos`, `origin{stream, key, seq, part, writer, script, source_version}`, `time{occurred_at, precision, not_before, not_after, observed_at, order_ms}`, `order`, `ids` (all keys, nullable), `entities`, `parent`, `cause`, `artifacts`, `unknown`, `inferred`, `provenance`, `late` | `v`, `cursor`, `source`, `subject`, flat time fields, `live`, `withheld` | Move the store's event to the contract's envelope in one change, with the schema as a conformance test. The normalizers already have every input those fields need. |
| Precision `ms`, `s`, `arrival`, `bounded`, `unknown`; whole-second times at `+999 ms` with bounds | `ms`, `second`, `arrival`, `unknown`; whole seconds at `.000` | With the envelope change. |
| `order` key; a 1.5 s settle window committing in `order`; `late`; a watermark | Commits in read order; no settle window | A settle buffer in ingest before `Append`. It changes nothing downstream: the cursor stays acceptance order (D7). |
| Content hash per ID; same ID with other content is `history.gap` (`reason: conflict`); `state-mismatch` gaps against `cell.json` | Same ID is dropped silently as a duplicate | With reconciliation (section 10). |
| `execution-record` and `run-record` sources | Not tailed | Next sources after the stream; both are small and write-once or append-only. |
| Routes `/api/factory/events`, `/api/factory/history`, `/api/factory/stream` with `event: batch` (≤ 200 events, ≤ every 100 ms), `event: sources`, `X-MACH-Event-Schema` | `/api/v1/events`, `/api/v1/stream`, one SSE message per event, batched per write | Open question 2. Batching several events per message fits section 11 and should be adopted. |

---

## 7. The index

### 7.1 Options weighed

| Option | For | Against |
|---|---|---|
| **Append-only log + in-memory windows (chosen)** | No dependency. Matches the data: append-only, read mostly by "after cursor". Rebuilds from the sources by design. Simple crash story (7.2). | Secondary lookups beyond the memory window need sequential segment reads or sparse indexes we write ourselves. Aggregation over long history is ours to code. |
| SQLite via `modernc.org/sqlite` | Real queries, indexes, transactions; good for analytics. | About a million lines of transpiled C in a binary that reads private data; larger binary; WAL files beside the index; CGO-free but slower. |
| bbolt | Small, mature, ordered key ranges. | A dependency for B-tree range scans we can do with a sorted slice; single writer lock; file grows and does not shrink. |

Revisit at M6.3 (analytics) with measured history sizes (`M6_0_TELEMETRY_GAPS.md` §7 item 8 is still open). The store sits behind a small interface (`Append`, `After`, `Bounds`, `Changed`, `Checkpoints`), so the backing can change without touching ingest or HTTP.

### 7.2 Layout and durability

`.factory/local/observer/` (mode `0700`; files `0600`): `.gitignore` (`*`), `lock`, and `index/` with:

| File | Contents | Written |
|---|---|---|
| `meta.json` | `format`, `generation` (16 hex), `created_at`, `redaction_version`, `event_version` | At creation, atomically |
| `events.log` | One normalized event per line, in position order | Appended, then `fsync`, per tick batch |
| `checkpoints.json` | Each source's checkpoint | After `events.log` is synced: temp file, `fsync`, rename |

Because the log is synced before the checkpoints move, a crash leaves the checkpoints behind the log, never ahead. On restart the lines in between are read again and dropped by ID (a test simulates exactly this). If the append fails, every tailer is put back to its previous checkpoint and the tick is retried. A torn last line of `events.log` is cut at open; an unreadable line elsewhere, positions out of order, or missing checkpoints with a non-empty log start a new generation.

### 7.3 Rebuild

Deleting `.factory/local/observer/` loses nothing: the next start creates a new generation and reads every source from offset 0. Old cursors are answered with `cursor_reset` (section 8). The rebuild removes only the three named index files, never a path derived from input.

### 7.4 Retention and size

- **Memory window:** the most recent `--memory-events` events (default 50,000) are in memory with an ID map for deduplication; the floor rises as older ones are evicted.
- **Disk (next step):** `events.log` becomes numbered segments (`segment-000001.log`, 64 MiB), each with a sparse position→offset index every 1,024 events and per-segment ticket/execution sets, so "after cursor N" below the memory window is one seek. A size budget (default 512 MiB) drops whole oldest segments; the floor is then the first retained position. Today the skeleton keeps one log and serves cursors only within the memory window.
- **Expected volume (estimate, to be measured):** ledger events are tens per ticket; lifecycle events are tens to low hundreds per ticket; stream-derived observations could be thousands per execution. At ~500 bytes each, 1,000 tickets is on the order of 100 MB with stream observations, a few MB without.

### 7.5 Secondary indexes (for the endpoints in section 12)

Maintained in the ingest goroutine as events are appended, over the memory window and rebuilt from segments at start: positions by ticket, by execution, by wave and slice, and by type prefix; and the projections of section 10.

---

## 8. Cursors

- **Form:** `<generation>.<position>`, e.g. `6b1f0e9a2c4d8e10.1042`. Position 0 means "before everything". SSE event IDs are cursors.
- **Durable across restarts:** positions and the generation are persisted with the events; a restarted observer continues at `head + 1` in the same generation, so a client's cursor stays valid.
- **Floor and head:** a cursor `c` is servable when `floor ≤ c ≤ head`, where `floor` is one before the oldest event still held. A client at the floor has missed nothing still held.
- **What the server says:**

| Cursor | REST (`/events`) | SSE (`/stream`) |
|---|---|---|
| valid | 200, events after it | `hello`, then events |
| another generation | 409 `cursor_reset` (`reason: generation`) + `{generation, floor, head}` | `event: reset`, stream ends |
| ahead of head (a cursor from a lost index with a higher count) | 409 `cursor_reset` (`reason: ahead`) | `event: reset`, stream ends |
| older than the floor | 410 `cursor_expired` (`reason: expired`) | `event: gap`, stream ends |
| unparsable | 400 `invalid` | 400 `invalid` |

  In every case the client's recovery is the same: fetch a snapshot (section 10), which carries a fresh cursor, and resume from it. SSE ends the stream after `gap`/`reset` and the client must close its `EventSource` (otherwise it would reconnect with the same `Last-Event-ID`).
- **Source gaps** are a different thing: a source sequence that never arrived (MACH's own torn-line failure loses the torn event and the one appended onto it, `M6_0_TELEMETRY_GAPS.md` §2.1). They appear in the stream as `history.gap` events (`reason: sequence`, `authority: reconstructed`), so the browser can show "2 intake events could not be read".

---

## 9. Ordering, lateness, duplicates

- **Cursor order** is acceptance order. Within one tick: the ledger first, then cells by ticket, then executions; within a source, file order.
- **Display order** (timeline, snapshots) is `occurred_at`, then source rank (ledger, cell, execution, observer), then source sequence or offset, then cursor. MACH's stamps are UTC with one-second resolution (ledger, stations) or milliseconds (lifecycle, if the contract adopts `at` with ms); `occurred_precision` says which.
- **Late versus backfill (built).** `late: true` only for an event read live that sorts before something already delivered. History read while catching up (from before the observer started, or after an index rebuild) is backfill: never late, `provenance.rule: "backfill"`, and `/health` says `catching_up` until every source is read past what it held at start (contract 6.5).
- **Late events.** A ledger event can be stamped long after the fact (`execution.completed` at the next tick; `station.observed` when sampled). It still gets the next cursor. Projections apply events in cursor order but keep, per entity, the latest `occurred_at`; a late event with an older `occurred_at` updates history without regressing "current" state where a newer authoritative fact exists (for example, a later `station.entered` from the lifecycle outranks an earlier-stamped `station.observed` sample).
- **Out of order within a source** cannot happen in an append-only file except through a rewrite; it is handled by epoch and sequence (section 4.1).
- **Duplicates** are dropped twice: by position in ingest (`seq ≤ last_seq` for the intake log, physical line `≤ last_line` for a lifecycle log), and by deterministic ID in the store (covering the crash window and the archived copy of a lifecycle log). Both are counted and reported in health.

---

## 10. Snapshots

**Consistency rule:** a snapshot is the projection state *at* a cursor N, and the stream from N continues it with nothing missed and nothing repeated.

**How (next step, not built):** projections (Factory status, waves and slices, cells and their current visit, executions, open human gates) are reducers applied in the ingest goroutine, inside the same store lock that makes an append visible. A snapshot request takes the read lock, copies the projection (structurally shared, so the copy is cheap) and the head position together. Response: `{cursor, generation, state}`. The client then streams with `Last-Event-ID: cursor`.

**Reconstruction at an arbitrary cursor** (`/api/v1/snapshot?at=<cursor>`, for scrubbing history): checkpoints of the projection every 5,000 positions, kept in memory for the window and in `index/snapshots/` beyond it; reconstruction loads the nearest checkpoint at or before the cursor and applies events up to it. Results are `authority: reconstructed`.

**Reconciliation:** projections are built from events, which can miss what MACH never emitted (a cell stage changed without a lifecycle line, e.g. a hand-run belt before lifecycle logs exist). Every 30 s, and on demand, the observer reads each active cell's `cell.json` (non-atomic: retried on a parse error, never acted on when partial) and the ledger's `slices`/`supervisor.executions`; where the files disagree with the projection, it emits `observer.reconciled` (`authority: observed`, the fields that differ) and the projection takes the file's value. It never runs `run.py` to do this.

---

## 11. Server-sent events

| Property | Design (built) |
|---|---|
| Route | `GET /api/v1/stream`, same origin, cookie-authenticated (an `EventSource` cannot set headers, so the cookie is the credential). |
| Start position | `Last-Event-ID` header, else `?after=`, else the head (live only). A client wanting history pages `/events` first, or takes a snapshot, then streams from that cursor. |
| Fan-out | Pull-based. Each client: take `Changed()`, read up to 256 events after its cursor from the store, write them as one chunk with a write deadline, flush; when caught up, wait on `Changed()`, the heartbeat, its request context, or shutdown. |
| Per-client memory | One batch. The store is the queue. |
| Backpressure | Never reaches the tailers: `Append` closes a channel and returns. A test appends 30,000 events while one client never reads; ingest finishes in well under its 3 s bound and a second client receives all of them in order. |
| Slow client | Falls behind in the store. If its cursor drops below the floor while it is catching up, it gets `event: gap` and the stream ends. A socket that stops draining makes a write exceed its deadline (10 s, configurable) and the stream is dropped. |
| Heartbeat | `event: heartbeat` `{head, at}` every 15 s when idle (no `id:`, so `Last-Event-ID` is not moved). Lets the browser show "live" vs "connection lost" honestly, and lets it see head move. |
| Events | `hello` `{generation, cursor, head, floor, heartbeat_ms}` first; unnamed message events `id: <cursor>`, `data: <event>`; `heartbeat`; `gap`; `reset`. `retry: 2000`. |
| Limits | At most 16 concurrent streams (503 + `Retry-After` beyond); every tab of the one session counts. No `WriteTimeout`/`ReadTimeout` on the server (either ends a long stream); `ReadHeaderTimeout` 10 s, 32 KiB headers. |
| Coalescing | Batches of up to 256 events per write while catching up; the browser appends a batch per animation frame (M6.0 §7.2). |

---

## 12. API (`/api/v1`)

Every response is M5's envelope: `{"ok": true, "data": …}` or `{"ok": false, "error": {"kind", "message", "cursor"?}}`. Kinds: `invalid` 400, `unauthorized` 401/403, `not_found` 404, `cursor_reset` 409, `cursor_expired` 410, `unavailable` 503, `internal` 500. Lists page by cursor: `?after=<cursor>&limit=<1..1000>` → `{items|events, next, head, floor, more}`. Times are UTC RFC 3339. Every identifier has passed `redact.ID`. **Built** marks what the skeleton serves today.

| Route | Purpose | Response `data` (abridged) |
|---|---|---|
| `GET /session` **built** | What this observer is | `{project:{folder}, versions:{observer, api, event}, generation, read_only:true, capabilities:{execution:false, artifacts, snapshot}}` |
| `GET /health` **built** | Liveness and lag | `{status: ok|degraded, observer, api, uptime_seconds, index:{generation, head, floor, in_memory, persisted, rebuilt, duplicates_dropped}, ingest:{ticks, last_tick_at, last_tick_ms, interval_ms, errors, last_error}, streams:{active, max}}` |
| `GET /factory/status` **built** | Factory status and health, read from files at most once a second | `{project:{folder, path}, factory_present, policy:{present, usable, reason, enabled, paused, autonomy, allow_merge, max_risk, persistent, enabled_at, runner_id, effective, note}, lease:{present, runner_id, started_at, heartbeat_at, heartbeat_age_seconds, expires_at, expired, same_host, process_alive, live}, counts:{cells, cells_with_lifecycle, executions, archives, runs_log, ledger, events_log_bytes}, read_at, index, sources:[{key, path, offset, last_seq, lines, refused, duplicates, oversized, resets, gone, blocked}]}`. Never `enabled_by`, `machine`, `allowed_tools`, `claude`, `project_root`, the lease's host or PID. |
| `GET /events` **built** | Normalized event history | `?after&limit&ticket&type` (type is a prefix) → `{generation, events:[event], next, head, floor, more}` |
| `GET /stream` **built** | Live SSE (section 11) | |
| `GET /snapshot` | Consistent state at the head, or `?at=<cursor>` | `{cursor, generation, reconstructed:bool, state:{factory, project, waves, slices, cells, executions, gates}}` |
| `GET /project` | Project execution state | `{project_id, integration:{commit_seen}, counts_by_state:{ready, active, blocked, completed, superseded}, active_cells, human_gates_open, cursor}` |
| `GET /waves`, `/waves/{wave}` | Delivery waves | `[{wave_id, revision, slices:[id], approved, first_seen_at, state_counts}]`; detail adds `slices:[{slice_id, revision, ticket_id, state, dependencies, last_reasons (scrubbed), materialized_at, dispatched_at, integrated_at}]` |
| `GET /slices/{slice}` | One slice across revisions | `{slice_id, revisions:[{revision, ticket_id, state, history:[{state, at}]}]}` |
| `GET /runs` | Active and historical executions | `?state=active|finished|unknown&ticket&after&limit` → `[{execution_id, ticket_id, slice_id, state, claimed_at, started_at, ended_at, duration_ms, how, exit_code, cost_usd, attempt, moved, stage_at_start, stage_at_end, refused_tools}]` |
| `GET /runs/{execution}` | One execution | the above + `{observations:{agents, tools, unrecognised_records}, timeline_cursor}` |
| `GET /cells`, `/cells/{ticket}` | Cells and station history | `[{ticket_id, slice_id, stage, risk, app_type, created_at, updated_at, current_visit, rounds}]`; detail adds `visits:[{visit, station, round, entered_at, exited_at, outcome, gates:[{gate, verdict, subject, seconds}]}]` and `archived:bool` |
| `GET /cells/{ticket}/visits/{visit}` | One station visit | `{visit, station, events:[event]}` |
| `GET /runs/{execution}/agents`, `/tools` | Agent and tool observations (DEPENDS ON the stream proof) | `[{agent_run_id, parent_id, label (identifier only), agent_type, model, started_at, finished_at, status, duration_ms, cost_usd}]`, `[{tool_call_id, agent_run_id, tool, category, outcome, duration_ms}]`. Never inputs or outputs. |
| `GET /spans` **built** | Execution Timeline spans (shared contracts 2) | `?ticket|execution|wave|entity&kinds&limit&offset` → `{items:[span], basis_vocabulary}` |
| `GET /history` **built** | A window of history in order (contract 14) | `?from_order&to_order` (or `from_ms&to_ms`) `&entities&ticket&execution&type&limit` → `{events, next_from_order, more, complete, watermark_ms}` |
| `GET /cells/{ticket}/evidence` | Evidence metadata (catalog) | `{status, head, review_loop, checks:[{id, kind, result, evidence:[{artifact_id, file, sha256, bytes, media_type, viewable}]}], previous:[n]}` from `evidence/summary.json` and `results.json`; notes omitted |
| `GET /artifacts/{ticket}/{artifact_id}` | Permitted artifact bytes (section 13) | the file, or 404/415/413 |
| `GET /analytics/runs` | Historical analytics source data | `?after&limit` → `[{ticket_id, slice_id, outcome, rounds, verify_failures, review_rejections, escalated, human_approval, deviations_count, blockers:[{rule}], tests_seen_failing_first, created_at, closed_at, integration:{method, approved_commit, landed_commit}}]` from `archive/runs.jsonl` (notes and findings text omitted) |
| `GET /analytics/metrics` | The observe station's scorecard | `.factory/observations/metrics.json`, numbers only |

---

## 13. The artifact API

Built (`internal/artifact`, `GET /api/v1/artifacts`, `/artifacts/{id}`, `/artifacts/{id}/content`); `apps/observer/README.md` describes it as served. Decided since this draft: text is served inline by default (scrubbed by the event path's own scrubber, `text/plain`, 256 KiB), images and video only with the project's `tower.evidence_media` opt-in, and the id is a catalog id specific to the project, path and content. The first draft follows.

- **No path from the request.** `{artifact_id}` is an opaque ID the observer assigned while building the evidence catalog (`GET /cells/{t}/evidence`): `sha256(ticket, root, relative path)`. The handler looks the ID up; an unknown ID is 404. There is no directory listing anywhere.
- **Roots allowlist:** `.factory/worktrees/<t>/evidence/` (and `evidence/previous-N/`) and `.factory/worktrees/<t>/review/round-N/` (`findings.md`, `decision.json`); for archived cells, the same paths as members of `.factory/archive/<t>.tar.gz`. Not `repo/`, not `build.json` (failure tails), not `test-suite.log` or `contract-check.log` (test output, `M6_0_TELEMETRY_GAPS.md` §5.7), not anything under `.factory/local/`.
- **Path checks:** catalog entries come only from files named in `summary.json`/`results.json` evidence lists (relative, validated by `redact.RelPath`) plus fixed review names. At read: every component from the project root is `lstat`-ed (no links, folders are folders), the file is opened `O_NOFOLLOW|O_NONBLOCK`, `fstat` must be a regular file with the same device and inode as the `lstat`, and the realpath must be under the root. Archive members: name must match exactly, type must be regular, no `..`, size from the header.
- **Limits and types:** at most 16 MiB (video 64 MiB), and an allowlist: `png`, `jpeg`, `webp`, `gif` (served inline with a fixed `Content-Type`); `webm`, `mp4` (inline, range requests); `txt`, `md`, `json` (served as `text/plain; charset=utf-8` after the text scrubber of section 5.2, cut to 256 KiB, never as HTML or JSON for the browser to interpret); everything else 415. SVG and HTML are refused (both can script). The served bytes' SHA-256 is compared with the catalog's and reported in `X-MACH-Evidence-Match`.
- **Headers:** `Content-Disposition: inline; filename="<basename>"` for images and video, `attachment` for text; `Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; sandbox`; `X-Content-Type-Options: nosniff`; `Cross-Origin-Resource-Policy: same-origin`; `Cache-Control: no-store`.
- **Images can carry secrets** (a screenshot of a terminal). The catalog marks every artifact `viewable: true` only for evidence kinds the verifier captured as product output (screenshots of the app, recordings); terminal transcripts are text and pass the scrubber. Whether screenshots should be opt-in per project is an open question (section 20).

---

## 14. Authentication and request checks

As M5 (`apps/studio/internal/security`, `server.go`), narrowed to GET:

1. Security headers on every response, including errors: the M5 CSP (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; …; frame-ancestors 'none'`, with `form-action 'none'` since there are no forms), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP and CORP `same-origin`, a restrictive `Permissions-Policy`.
2. Method: GET only; anything else 405 with `Allow: GET` and `Connection: close`.
3. `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
4. Page routes: `/?t=<token>` exchanges the one-time start token for an `HttpOnly`, `SameSite=Strict` cookie named `mach_observer_session` (distinct from Studio's), then redirects to drop the token from the address bar. The token works once.
5. API routes: `Cache-Control: no-store`; `Origin`, when present, must be `http://<Host>`; `Sec-Fetch-Site`, when present, must be `same-origin` or `none`; the session cookie must match (constant-time); the path must be clean (no `..`, `//`, `%2f`).

**Multiple clients (built).** Every tab and window of the browser that opened a link shares its session, and each tab's stream is a client. After each use of a link the observer mints the next one and writes it to `.factory/local/observer/link` (`0600`, removed when the observer stops), which the starting skill prints for a second browser; there is never more than one unused link, and at most 16 browser sessions are held (the oldest is dropped beyond that).

**Restarts (built).** A page left open survives a restart: the observer binds the port it remembers in `.factory/local/observer/port` again when it is free (else a new one, said on stdout), and a session lasts 12 hours from its link's use across restarts. Only an HMAC-SHA256 of each session token is kept (`sessions.json`, with its expiry, at most 16), under a key derived from a random per-project secret (`session-secret`) and the project's absolute folder; all `0600` in the `0700` folder. A secret or session file that is a link or readable by others is discarded and remade (every browser needs a new link; stderr says so). The cookie is unchanged: host-only, `HttpOnly`, `SameSite=Strict`. The index keeps its generation and positions, so a stream resumes from `Last-Event-ID`.

Superseded text of the first draft: a second browser needed a new link, which then means restarting the observer (open question 4).

---

## 15. Threat model

| Threat | Mitigation |
|---|---|
| **Another local user** connects to the port | Session cookie from a one-time token printed only to the starting session; constant-time compare. The index folder and files are `0700`/`0600`. Not a defence against root or the same user. |
| **Another origin in the person's browser** (a web page fetching `127.0.0.1:<port>`) | `SameSite=Strict` cookie is not sent cross-site; `Origin` and `Sec-Fetch-Site` refusals; no CORS headers, so responses are unreadable; GET only, so nothing to forge. |
| **DNS rebinding** | Exact `Host` check. |
| **Clickjacking / framing** | `frame-ancestors 'none'`, `X-Frame-Options: DENY`. |
| **A malicious repository** (the project being observed is hostile: crafted `.factory/` files, links to `~/.ssh`, FIFOs, huge files) | Every path is `lstat`-ed and opened `O_NOFOLLOW|O_NONBLOCK`; links and special files are refused; linked cell folders are not followed; line, read and small-file caps (1 MiB, 4 MiB, 64 KiB); a lifecycle line must name its own folder's ticket. Residual: a folder swapped for a link between `lstat` and `open` of a file inside it; the lines read would still have to parse as a valid lifecycle line for that ticket and pass the allowlist. |
| **A malicious stream or log line** (prompt-injected content, markup, escape sequences, huge JSON, secrets) | Allowlist projection; identifiers by strict pattern; prose scrubbed and cut; stream records yield no text at all; the browser renders text, never HTML (`M6_0_ARCHITECTURE.md` §7.4); line size cap; JSON decoding into fixed structs. Content is data, never instructions: the observer acts on nothing it reads. |
| **Path traversal** via the API | No route takes a path. Artifact access is by catalog ID (section 13). Unclean API paths are refused. |
| **Resource exhaustion** | 16 streams; 256-event batches; write deadlines; bounded memory window; 1,000-item page limit and a 10,000-event scan cap per request; status cached for 1 s; header size and time limits; polling cost bounded per tick. Disk: index size budget (7.4, next step). |
| **The observer as an escalation path** into execution | No route writes; no `os/exec`; no network egress; no engine; the policy is read, never written; a source-boundary test fails the build if any of this changes (section 18). |
| **Index tampering** (another process edits `events.log`) | Same user only (`0600`). A corrupt index is rebuilt from MACH's files; the index is never authoritative. |
| **Kept sessions read by another local user** | `sessions.json`, `session-secret` and `port` are `0600` in a `0700` folder; another user cannot read them. Were they read anyway, they hold no token: only HMAC-SHA256 hashes, which cannot be turned back into a cookie. A file made readable by others is not trusted: both files are discarded and remade at start. Not a defence against root or the same user, who can read the browser's cookie store directly. |
| **Kept sessions copied to another project, or the folder copied** | The hash key is derived from the secret **and** the project's absolute folder, and the file names its project; records from another folder match nothing and are ignored (stderr says so). |
| **A stolen session cookie** | No worse than before the sessions were kept: the cookie was already the credential for as long as the observer ran. It now also works after a restart, for at most 12 hours from its link's use; a session is never extended by use. Ending every session early: stop the observer and delete `.factory/local/observer/session-secret`. The cookie is host-only, `HttpOnly` and `SameSite=Strict`, so a page cannot read it or send it cross-site. |
| **A person's name served to the browser** (people are shown by role, D2/D10) | Person fields of every record by role, except a role phrase MACH itself wrote (R2: "an agent, on the person's instruction in conversation" is kept, so an agent's act is not credited to a person); a per-project deny-list of every name and e-mail MACH's records and the project's git identities give, applied to every stored event, served document and reply; e-mail addresses scrubbed wherever they appear. **Known limit, decided by the product owner (R1): label, do not withhold.** Guaranteed: a name known from a record or a git identity is never served once that record has been read. Not guaranteed: a name that appears only in free text (a finding, a verifier's note, a transcript) and in no record is served as written. Every artifact whose text can hold such prose is labelled: catalog entry `free_text: true`, `free_text_note: "free text, not checked for names"`; content header `X-MACH-Free-Text: unchecked-for-names`. What was served before a record named the person is not recalled. |
| **Another process takes the remembered port** | The observer binds a new port and says so on stdout; it never connects to whatever holds the old one. Browsers do not separate cookies by port, so a page left open on the old origin would send its cookie to that process; but that is already true of any page on `127.0.0.1` the browser opens, today as before, and the cookie is `SameSite=Strict` and `HttpOnly`. What changes is only that a cookie captured that way also works on the restarted observer, for the rest of its 12 hours. Accepted; deleting `session-secret` ends every session. |

---

## 16. What the observer never does

- Write anywhere but `.factory/local/observer/`, or anything at all when `.factory/` is missing. It never changes a MACH file's contents, mode or times (reading can update access time on file systems that track it; MACH does not use access time).
- Take, wait for or test a MACH lock (`.factory/intake/lock`, the supervisor's lease), or write `runner.json` or `supervisor.json`.
- Run `run.py` or any MACH script, Git, `gh` or `claude`; start any process; open a browser.
- Connect to anything; listen on anything but `127.0.0.1`.
- Forward a raw record, a tool input or output, file contents, an environment value, a credential, an absolute path outside the project, or a private transcript.
- Decide anything about the Factory: it reports the policy file's reading with a note that MACH decides.

---

## 17. Failure behaviour

**The Factory does not depend on the observer.** Nothing in MACH reads the observer's files or port. The observer holds no MACH lock and no MACH file open between polls (each poll opens, reads and closes), so a stopped, crashed or hung observer cannot block a writer, and `kill -9` at any point leaves MACH's files exactly as MACH wrote them.

**How it is proved:**

- Built: `TestReadOnlyOverAFactoryTree` runs the real binary entry point over a fixture tree with every file type (ledger with a torn last line, cells, evidence, execution stream, archive, observations, policy, lease, MACH's lock file), backdates every timestamp, drives ingest, every endpoint and a stream, restarts the observer, and compares a hash of every path's type, mode, size, mtime and contents outside `.factory/local/observer/`. `TestNoFactoryMeansNoWrites` does the same for a project with no Factory and allows no change at all. `TestSourceBoundary` parses every non-test source file and fails on `os/exec`, `plugin`, `unsafe`, `net.Dial*`, `syscall.Exec`, or any file-system write call outside the store, the lock and start-up.
- Next: run the M3/M4 Python suites (`intake`, `supervisor`, `executor`) with an observer attached to their temporary projects and require identical results; a stress test that has `intake.Factory.save` append to `events.jsonl` under `Factory.lock` while the observer polls at 10 ms and checks MACH's write latency is unchanged; `lsof` on the observer during a run shows no MACH file held.

**The observer's own failures:** an index write failure leaves the tailers at their old positions and is retried each tick (health turns `degraded`, `last_error` names the step, never content). A corrupt index is rebuilt. A missing source is normal (nothing yet). A crash loses nothing (section 7.2).

---

## 18. The skeleton (`apps/observer`)

| Package | Built |
|---|---|
| `cmd/mach-observer` | Flags `--project`, `--port`, `--memory-events`; finds the project; makes `.factory/local/observer/` (`0700`, `.gitignore`) only when `.factory/` exists; one-observer lock; prints the one-time link; clean shutdown on SIGINT/SIGTERM. |
| `internal/security` | Loopback-only `Listen` (refuses everything but `127.0.0.1`), one-time token → cookie, `Host`, `Origin`/`Sec-Fetch-Site`, headers and CSP. Copied from M5 with attribution. |
| `internal/server` | GET-only router; `/api/v1/session`, `/health`, `/factory/status`, `/events`, `/stream`; M5 envelope; cursor errors. |
| `internal/tail` | The tailer of section 4.1. |
| `internal/normalize` | Ledger v2 and lifecycle v1 normalizers with allowlists; the stream normalizer contract (deny by default, output filtered again) with no handlers registered. |
| `internal/redact` | Identifier, word, commit, digest, path, number checks and the text scrubber. |
| `internal/store` | `events.log` + `checkpoints.json` + `meta.json`, generations, memory window, dedupe by ID, `Changed()`. |
| `internal/ingest` | The polling loop, cell discovery, sequence duplicate and gap handling, observer events, rollback on a failed append. |
| `internal/factory` | Read-only Factory status: policy summary, lease, counts. |
| `internal/webui` | Serves an embedded placeholder page; the Control Tower build is copied in by a build script later. |

**Not built yet:** snapshots and projections (section 10), reconciliation, every route in section 12 not marked built, the artifact API, archive catch-up (4.3), execution stream tailing and any stream handler (4.4), on-disk segments and the size budget (7.4), the build/smoke scripts and release entries, the skill step that starts it, and the Control Tower's switch from the fixture to this API.

**Tests (52, all passing under `go vet` and `go test -race`):** security (non-loopback binds including the machine's real interfaces, start token once, forged cookie, Host, Origin and Sec-Fetch-Site, every non-GET method on every kind of route, unclean paths, security headers on every response); tailing (append, torn line then completion, backfill vs live, truncation, replacement with the same and with other history, gone and back, link refused, over-long line, resume from checkpoint); store (dedupe, eviction and expiry, reopen keeps generation and positions, torn index tail cut, changed rules rebuild under a new generation, wake-up); ingest (ledger and cells merge, new cell appears, restart resumes without duplicates, crash between log and checkpoints repeats nothing, truncated-and-rewritten ledger deduplicated, sequence gap reported, lifecycle `seq: null` and repeated lines after a truncation, foreign-ticket line refused, cell gone as source state, linked cell folder ignored); normalization (allowlists drop names and unknown fields, prose scrubbed of secrets, paths and bidi characters, unknown type keeps no data, refusals, contract IDs, lifecycle per-kind allowlist and `data.counts`, null `seq`, evidence paths, a log written by the real lifecycle helper accepted with nothing withheld, stream deny-by-default, a careless stream handler filtered); HTTP (status and policy summary without private fields, shared-permission policy reads as unusable, paging, filters and every cursor error, SSE live and reconnection with `Last-Event-ID` with no gap or repeat, heartbeat, gap and reset, stream limit, a slow client neither blocking ingest nor a fast client and being dropped); and the read-only and source-boundary proofs of section 17.

---

## 19. Dependencies added

None. `go.mod` has no `require`; there is no `go.sum`.

---

## 20. Open questions for the lead

1. **One binary or a shared host later?** This wave copies M5's security code. Should the two hosts share an extracted package (and a common release pipeline), or stay separate binaries forever, with the duplication held by tests?
2. **Route names.** The product owner asked for versioned `/api/v1/...` endpoints; the contract (section 14) names `/api/factory/events|history|stream` with an `X-MACH-Event-Schema` header. Recommendation: `/api/v1/` versions the HTTP surface and `schema=3` the events, both; one of the two documents should change to match.
3. **Envelope extensions.** When the store moves to the full v3 envelope (section 6.1), should `cursor`-in-event, `live` and `source.line` stay as extensions within revision 0, or go?
4. **Second browser.** Decided: the next link is kept in `.factory/local/observer/link` (no control channel); at most 16 sessions; sessions survive restarts (section 14). The first draft's question follows. A one-time link per run means one browser session. Should the skill be able to ask a running observer for a fresh link (which needs a local control channel, for example a `0600` Unix socket under the observer's folder), or is "restart to get a link" acceptable?
5. **Who starts it.** Which skill owns "open the Control Tower": `/mach-run factory`, a new `/mach-control-tower`, or Product Studio's skill? And should it start with the session only, never as a service (M5 §5 rule)?
6. **Retention defaults.** 50,000 events in memory and (planned) 512 MiB on disk are guesses until a real run is measured (`M6_0_TELEMETRY_GAPS.md` §7 item 8).
7. **Screenshots as evidence.** Decided: images and video only when the project opts in (`.factory/config.json` `{"tower": {"evidence_media": true}}`); text evidence is served by default, scrubbed (shared contracts 3.5). The first draft's question: images can show secrets the scrubber cannot see. Serve evidence images by default, or only when the project opts in?
8. **People's names.** The design shows roles, never names. M6_0 §5.7 allows names for "that machine's engineer"; is that wanted at all in the Control Tower?
9. **Execution streams on disk.** The observer will read `stream.jsonl`, which holds everything. Should MACH (not the observer) prune or encrypt execution folders, since the observer's redaction does nothing for the raw files themselves?

---

## 21. After the M6.2 acceptance (built)

What the real end-to-end run (`M6_2_ACCEPTANCE.md`) changed in the observer. Where this section and an earlier one
differ, this one describes what is built.

- **People by role, everywhere (D2).** A served JSON record of a known kind goes through structured redaction
  (`redact.ScrubRecord`: decision, vote, results, summary, build report, cell, run record): person-bearing keys become
  `"a person"` unless they hold a role phrase MACH wrote (R2, `redact.RolePhrase`), unknown keys are kept only when their value passes the scrubber, key order is kept; any other text goes
  through the text scrubber. A per-project deny-list (`redact.People`) holds the names and e-mails MACH's own files
  give for people (approvals, the intake log's `by` and `actor`, `runner.json` `enabled_by`, cell records' person
  fields, the `[user]` of `.git/config` and the identities in `.git/logs/HEAD` and each worktree's reflog, read as
  files, never through git); every event string, every served document and every API reply body is filtered with it.
  The catalog's relative names are kept by the scrubber (D25).
- **Stream records by shape (D1).** Section 4.4's version pin is gone: `M6_1_STREAM_COMPATIBILITY.md` section 8.
- **Gap classes.** `history.gap` gains `class` and `history_lost`; only history-losing classes make history partial
  (contract 6.5).
- **Adaptive settle (section 9).** An event is committed once every hot tailed source with a file has been read through
  past its time; the 1.5 s window is only the bound for a source that is behind or unreadable. An idle poll is one
  `lstat` per source (no open); the idle poll interval is at most 500 ms.
- **Polling tiers (R3 of the re-check).** Idle, a 1,263-cell history cost a third of a core: polling every source
  twice a second allocated about 3 MB/s while the live heap sat at the soft memory limit, so the collector ran on every
  tick. Now a source is hot (polled every tick) while new, while its execution runs (its cell too) and for 2 minutes
  after it last changed (at the end of the catch-up, a file written in the last 2 minutes counts); other sources are
  cold: one `lstat` every 2 s, spread over the ticks, not holding the settle. Source folders are listed again only when
  their time changes (at least every 10 s); an idle tick makes no allocation per source (health rows are kept as
  values and turned into the reply on request). Idle CPU on that history: 25–36 % → 0.95–1.27 % of a core. Price: the first
  line of a cell quiet for 2 minutes or more arrives up to 2 s after it was written (median 0.9 s, p95 2.0 s) and is
  often marked `late`; hot sources are unchanged (median 128 ms, p95 302 ms on the busy load).
- **Memory (D18).** Reading the 230,853-event history of the acceptance (93 MB of sources) peaked at 1.6 GB: projection
  checkpoints were full copies of a 20 MB state (64 of them), a tick read up to 20,000 events, the store kept every
  event of its memory window decoded, and the window's evicted slots kept their bytes. Now: a checkpoint is the state's
  top level plus one encoded blob per cell, slice, execution and wave, re-encoded only when an event touched it and
  shared by every checkpoint in which it did not change (32 checkpoints); a tick reads at most 5,000 events and the
  next tick follows at once while a backlog remains; the store keeps an event's index fields (`event.Head`) and its
  encoded bytes only; evicted slots are cleared; the saved projection is written at most every 15 s; and the Go
  runtime is given a soft memory limit of 208 MB (`GOMEMLIMIT` overrides). Peak RSS 283–295 MB, catch-up 26–27 s at
  load average 10 (was 1.6 GB, 16–20 s). The re-check measured 35.2 s: the live heap sat at the memory limit and the
  collector ran hundreds of times a second. Now the store keeps the served envelope of only the newest 16,384 events
  of its window (store `HotRaw`); older ones keep their index fields and the segment, offset and length of their line,
  and are read back and expanded when asked for, byte for byte what was served when new (98 MB of a 176 MB live heap
  became about 30 MB). Measured with `/usr/bin/time -l` on a clean copy: catch-up 16.5–18.7 s, peak RSS 260–281 MiB
  (before, same machine and method: 29.6–36.4 s, 300–331 MiB).
- **Index format 3 (section 7.2).** Segments hold each event in a compact form (the envelope without its nulls, empty
  lists and objects, `false` and zeros; `data`, `cause` and `provenance` exact), expanded to the full envelope when
  read: 213 MB of segments for that history instead of 281 MB. A format change rebuilds the index.
- **History in order (section 12).** The store keeps an order index of its memory window (appended, or inserted where a
  late event belongs), so a `/history` window costs its size plus a binary search, not a scan and sort of the window.
- **Series.** `GET /api/v1/series`: counts per bucket by kind and authority, kept per minute for everything the index
  has held (rebuilt from the segments on a restart), finer buckets from the memory window.
- **Snapshot at the head** is built from the live projection under its lock and kept until the projection moves (no
  copy of the state): about 0.6 s for that history the first time, then the encoded bytes.
- **Plan facts and evidence visits (D11, D12).** The plan's exit carries `app_type` and `risk` (revision 2); the cell
  shows them with the contract and task counts. Each catalogued artifact is linked to a visit: `recorded` when a
  verification check names it with its hash, otherwise `reconstructed` by its folder, round and file time.
- **Unknown is null.** A cell's `risk` and `app_type`, in the cell list and detail as in its `plan`, are `null` while
  unknown (they were `""` outside `plan`). The snapshot's `state` still omits them while empty.
- **Free text labelled (R1).** Section 15, "A person's name served to the browser"; README, Artifact content.
- **A file created while the observer watches is live from its first line (D16)**, also when it did not exist at the
  first poll.

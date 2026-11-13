# MACH Next — M6.1/M6.2 completion report: production observability and the live Factory floor

13 November 2026. Branch `feature/mach-next-m6-1-live-observability`, 21 commits on top of `cac989e` (M6.0 merged).
This report follows the twelve items the milestone brief asks for. Where a figure was measured by one agent and not
re-measured independently, it says so.

## 1. Branch and commits

| Commit | What |
|---|---|
| `f9c61cc` | Stream compatibility proof and sanitized fixtures from real runs |
| `d1b2d2b` | Assessment, version 3 event contract, shared contracts for Timeline, Evidence and Analytics |
| `6f4ebcc` | Observer skeleton: loopback, session, tailers, durable cursors, live stream |
| `10b2ec5` | Cell-local lifecycle log written by every station |
| `3eb5a30` | One scene engine for live, replay and simulation |
| `a9b2d12` | Observer ingest from five sources, redaction, snapshots, read API, restricted evidence, embedded app |
| `db4fee4`, `2235150`, `bd7a403` | Blueprint, shell and Atlas draw live, replay and simulation from the log |
| `718a030` | Observer hardening: sessions and port survive a restart, history windows, fuzz and never-does tests |
| `3256751` | Release, installer and run-skill step for the observer |
| `f14448e` | Scene-model gaps; client reads the observer's real shapes |
| `7297bb2` | Acceptance: a real supervised run observed live, with defects |
| `8df9aaf`, `0cf50ec`, `a9efcba`, `81dc7cb` | First fix round: views, observer, client |
| `a0ecc85` | Factory: daily budget caps each run; unattended stations use one plain command per call |
| `b7ede38` | Independent acceptance re-check |
| `7353ffb`, `c9188ee` | Second fix round: observer idle cost and free-text label; Control Tower re-check defects |

Nothing is pushed. No tag or release was made.

## 2. Integration points with M4, M5 and M6.0

**M3/M4 (read, never changed in meaning).**
- `.factory/intake/events.jsonl` (strict schema 2) and `.factory/intake/ledger.json`: read by the observer. Nothing new
  is written there, so every existing reader is unaffected.
- `.factory/local/executions/<id>/{started.json,result.json,stream.jsonl}`: read by the observer. The executor's wrapper
  now exports `MACH_EXECUTION_ID` so a station's lifecycle record can name its execution.
- `.factory/archive/runs.jsonl` and each archive: read for finished tickets.
- `skills/run/scripts/supervisor.py`, `executor.py` (changed in `a0ecc85` at the product owner's request, outside the
  observability scope): a run's budget is the per-run limit or what the day has left. The tool allow list in
  `policy.py` is unchanged.

**Stations (one additive write).** Every station script appends to `.factory/worktrees/<ticket>/lifecycle.jsonl` through
`skills/intent/scripts/lifecycle.py`. `record()` never raises: a telemetry failure cannot change a gate or a verdict.
No station file or gate was replaced. `verify.py` gained `capture` and `record --from`, and `review.py submit` finds its
findings file, so unattended verification and review need no shell composition.

**M5 (pattern reused, privileges not shared).** The observer is a separate program, `apps/observer` (`mach-observer`),
not an extension of the Studio host. It reuses M5's security shape (loopback bind, one-time link, session cookie,
Host and Origin checks, strict Content-Security-Policy, no external assets) and its packaging (prebuilt per platform,
checksum-checked by the installer into `.factory/bin/`, started from the run skill). It has no `os/exec`, answers GET
only, and cannot run a `studio.py` operation, enable the Factory or start a station.

**M6.0 (kept).** The Atlas, the Blueprint, the factory grammar and the simulation are the M6.0 components. The reducer
now reads version 3 events natively (`sim/reduce-v3.ts`); `src/live/**` is the production event adapter. Three sources
are labelled persistently: Live Factory, Historical Replay, Simulation. The simulation keeps M6.0's motion rule. Two
visible changes to it were accepted by the product owner or are structural only: the wait under the human gate reads
"waiting", not "running"; the ruler's ticks are one path. `@mach/ui` gained two additive tokens (`factory-halt`,
`factory-stale`).

## 3. Stream compatibility proof

Document: `M6_1_STREAM_COMPATIBILITY.md`. Fixtures: `tests/fixtures/execution-streams/` (sanitized; safety tests in
`tests/test_stream_fixtures.py`). Proven on Claude Code 2.1.322 and 2.1.323 from real runs.

- Dynamic Workflow agents are **not** streamed as messages. They are visible only in `system/task_progress` snapshots:
  agent id, label, phase, a tool-call count, the last tool's name, one token total, start and progress times.
- **Not observable** for workflow agents: individual tool calls, their inputs and results, per-agent cost.
- Cost is per execution and per model only. A run stopped by its budget mid-workflow reports success with the workflow
  killed; the observer flags its cost as incomplete.
- The observer accepts each record by its shape, not by version. A stream's runtime is `proven`,
  `compatible-unproven`, `incompatible` or `unknown`, and the page says which. A refused record becomes a gap and
  nothing else.
- Undocumented transcript files under `~/.claude` are not read.

## 4. Event contract and migration

Documents: `M6_1_EVENT_CONTRACT.md`, `schemas/factory-event.v3.schema.json` (schema revision 2).

Version 3 is a **view** the observer produces from five sources (intake log, cell lifecycle logs, execution records, run
records and archives, Claude streams). Nothing version 3 is written to the logs M3 and M4 read, so there is no migration
for them and no flag day. Each event has a deterministic id, a history order and a delivery position, an authority
(`authoritative`, `observed`, `reconstructed`), a time quality, and entity references. Causality is carried only where a
record states it. A `history.gap` carries a reason, a class and whether history was lost; a reason the table does not
know counts as lost. People appear by role only.

## 5. Observer architecture and local API

Documents: `M6_1_OBSERVER_DESIGN.md`, `apps/observer/README.md`.

Go, standard library only. Read-only tailers, a normalizer, a redactor, an index under `.factory/local/observer/`, a
projection with checkpoints, and a server. It takes no Factory lock and runs no MACH command. Sources are polled in two
tiers: hot every tick, cold every two seconds.

API under `/api/v1`, GET only, behind the session: `session`, `health`, `factory/status`, `events`, `stream` (SSE with
`Last-Event-ID`, heartbeat, gap and reset), `snapshot`, `history`, `series`, `project`, `waves`, `slices`, `cells`,
`runs`, `runs/{x}/agents|tools`, `spans`, `artifacts`, `artifacts/{id}/content`, `cells/{t}/evidence`,
`analytics/metrics`, `analytics/runs`. Evidence content goes through a separate route with path validation and
redaction; media is off unless `tower.evidence_media` is set in `.factory/config.json`.

## 6. Remaining telemetry gaps

- Per-call tool events, per-agent cost and per-agent token breakdown for workflow agents: the runtime does not expose
  them. Shown as "count only", never invented.
- Cells created before the lifecycle log existed have no backfill; their history is reconstructed and labelled so.
- Stream lines carry no timestamps; they are stamped at read time (`arrival` quality).
- Why `review.py submit` was refused in the real runs is not in the stream. Refusals now carry reason codes.
- A human approval records who approved; the observer serves "a person" by design.

## 7. Screenshots and screen recording of real execution

**Not captured.** The product owner asked to choose, before any capture run, between reviewing by hand and automated
captures. That choice is still open. The acceptance run kept a handful of defect screenshots in its scratch area; they
are not a deliverable. To look by hand: build with `apps/observer/build.sh`, run `apps/observer/bin/mach-observer
--project <a project with .factory>` and open the printed link.

## 8. Test results

| Suite | Result |
|---|---|
| Python (`make test`) | 590 pass |
| Go (`go vet`, `go test ./...`, `go test -race ./...`) | all packages pass |
| Observer build with the app embedded, `smoke.sh` | pass (CSP, no source maps, session, GET only) |
| Web lint, typecheck, build (three apps) | pass |
| Control Tower unit tests | 158 pass |
| Product Studio unit tests | 7 pass |
| Product Studio browser suites (lifecycle, conformance, security, accessibility) | 177 pass |
| Security: never-does tests (no exec, no write route, no non-loopback bind), fuzz on the parsers | pass |

**Acceptance (ten points).** First run, real and authorized, $8.79: points 1–4, 6, 9 passed; 5, 7, 8 partly; 10 failed.
Independent re-check on the recorded data after the first fix round: 1–4, 6, 8, 9, 10 pass; 5 and 7 partly. The second
fix round addressed every defect the re-check left open (section 10 lists what was not re-verified independently).
Full detail: `M6_2_ACCEPTANCE.md`.

**Performance** (230,853 events, 1,261 cells unless stated):

| Measure | First run | Now | Measured by |
|---|---|---|---|
| Event appended to painted | median 1.7 s | median 0.3 s, p95 0.6 s | re-check (replayed real run) |
| Page load to live | 61 s | about 3 s | fix agent (11 s at the re-check) |
| Replay scrub | 688 ms | about 60 ms | re-check |
| Browser heap, peak while loading | about 870 MB | 340 MB | fix agent |
| Observer peak memory | 1.6 GB | 260–281 MB | fix agent (257 MB at the re-check) |
| Observer catch-up | 19.7 s | 16.5–18.7 s | fix agent |
| Observer idle CPU, no client | 0.2 % then 33 % | about 1 % | fix agent |
| Reconnect after the observer is killed | recovered in 3.3 s | live 6.5 s after restart | re-check |
| Atlas elements at mid zoom, twelve cells | 2,564 | 2,401 (budget 2,500) | fix agent |

## 9. Privacy and redaction coverage

- Disclosure search at the re-check: needles for credentials, environment values, absolute paths, prompts, commands,
  session ids and every person named in records or git identities, on three projects, over every API reply, the live
  stream, every artifact's content, the index on disk and the page's text. **0 hits.**
- An end-to-end Go test plants 14 names and e-mails across the sources and requires 0 in every reply and in the index.
- Raw tool inputs, file-edit contents, environment variables and prompts are never forwarded; paths are served
  relative to the project.
- **Known limit, accepted by the product owner:** a name that appears only in free text (a finding, a verifier's note)
  and that no record or git identity names is served in that document. Such documents carry
  `free_text: true` and the header `X-MACH-Free-Text: unchecked-for-names`, and the Control Tower labels them
  "Free text, not checked for names". Screenshots are not checked for names; media is off by default.
- Sessions last 12 hours and are stored as an HMAC. A loopback cookie remains reachable by other local processes of the
  same user; that residual risk is the same as M5's.

## 10. Risks and remaining limitations

1. **The Factory fixes are proven by tests only.** That Claude Code's restricted mode accepts the new command forms, and
   that models follow the one-command rule, needs a real supervised run.
2. **The second fix round was not re-checked independently.** Its tests pass and its figures are the fix agents'.
3. A cell quiet for two minutes or more is polled every two seconds; its first new line takes about 0.9 s median, up to
   2 s, and is often marked late.
4. A history window shows only cells that had events in it; other bays stay in place, empty.
5. About 180 MB of browser heap stays live on the large history, mostly the mounted tree of both views.
6. Unattended verification of web, CLI, API and desktop slices still needs tools outside the allow list; those runs stop
   for a person.
7. Linux observer binaries and release attestation are provable only by a real tagged release.
8. One observer per project per machine; nothing coordinates two machines.
9. The simulation is not re-expressed as version 3 events; it draws facts no version 3 kind carries.

## 11. Readiness for M6.3 Execution Timeline

Ready to start. Available now: ordered, deduplicated history with cursors and gap marks; `/history` windows that cost
their own size; `/series` for density at any zoom; `/spans` for visits, executions and waits; authority and time quality
on every event; stable entity references that the inspector already resolves. The timeline must show workflow agents as
spans with a tool count, not as tool-by-tool rows, because the runtime does not expose more.

## 12. Data contracts for M6.4 and M6.5

Document: `M6_1_SHARED_CONTRACTS.md`.

- **Evidence Theater (M6.4):** the artifact catalog (id, kind, ticket, round, commit, hash, size, visit link with its
  basis, `free_text`), the restricted content route with redaction headers, and `cells/{t}/evidence`. Media needs the
  project's opt-in.
- **Factory Analytics (M6.5):** `analytics/metrics` and `analytics/runs` over run records and events, each figure with
  its source and completeness. Cost is per execution and per model, with `cost_complete`; token counts per agent are a
  single total; anything unavailable is reported as unavailable, never estimated.

## 13. Final regression

Run on `c9188ee`, the last code commit: Python 590 pass; Go vet, tests and race run pass; observer build and smoke test
pass; web lint, typecheck and three builds pass; Control Tower 158 and Product Studio 7 unit tests pass; Product Studio
browser suites 177 pass.

## 14. After the merge: two real supervised runs (13 November 2026)

Run in a throwaway project, $4.73 of a $6 day limit in total, to prove the Factory fixes of section 2. Nothing was
approved on a person's behalf; the Factory was disabled afterwards.

| Run | Executions | Cost | Where it stopped |
|---|---|---|---|
| 1, on `2b18b8d` | 2 | $1.50 | Build, task 4: an implementation task whose code an earlier task had written. `build.py green` had no override, so the ticket parked. |
| 2, on `3cc372f` | 1 | $3.23 | Build finished, verification passed twice, review rejected rounds 1 and 2 on a real gap in the slice's spec; parked for a person. |

**Proven live**
- **Refused commands (D22):** no permission denial in run 2 across 31 agents and 66 shell calls, none of them a heredoc,
  `cd &&`, redirect, pipe or variable. The verifier used `verify.py capture` and `record --from` and reached PASS. All
  six review submissions were eventually accepted; three first attempts were refused with `findings-invalid` (a cited
  line past the end of a file) and corrected.
- **Build override:** the builder used `green --already-done`; it is in `build-report.json` as an `impl-already-done`
  deviation and in the lifecycle log as an override, and the build went on to finish.
- **Reporting:** `factory status` shows the parallel limit in force and the slice waiting for a place; build refusals
  carry specific codes.
- **Observer:** both runs read as `proven` on Claude Code 2.1.323 with no gaps; agents, cost, plan facts and every gate,
  including the new override and each refusal, were served correctly.

**Proven by calculation on the real ledger, not by spend**
- **Daily budget (D21):** each execution was given $3.50, correctly uncut. After run 2 the next run would have been
  given $1.26. The cut and the under-one-dollar stop never had to happen.

**Fixed after these runs** (`fix/factory-build-already-done`): the build override, specific build refusal codes, the
plan's file list reading only path-shaped tokens, the supervisor's capacity reporting, the observer's run summary showing
refusals as soon as the stream does, and the lifecycle log's `security_veto` now matching `decision.json`.

**Found and left for a decision**
- The line has no stop of its own for "the spec needs regrooming": after two rejections on a spec gap `run.py next`
  still answers "build", and only the supervisor's attempt limit parked the ticket.
- The plan agent's `git -C <repo> ls-files` is refused. Allowing it would widen the allow list.
- `run.py product plan` (the engineer's command) shows the project's parallel setting, not the machine policy's.
- The ticket never reached the human-approval gate, so that stop was not exercised in these runs.

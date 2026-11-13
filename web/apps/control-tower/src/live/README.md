# Control Tower, M6.2: live execution through the one scene model

Status: the engine, the store and the observer client are built and tested, and the views (Atlas,
Blueprint, shell) draw all three sources. Section 8 lists the follow-ups the view owners reported
after connecting them, section 9 the fixes for the M6.2 acceptance run, and section 10 what changed
when the observer gained its M6.2 fields (commit 0cf50ec). Where an earlier section and a later one
differ, the later one describes what is built. Nothing here writes anything anywhere: the client
reads the observer's `/api/v1`.

Read with: `docs/mach-next/M6_1_EVENT_CONTRACT.md` (the v3 envelope, sections 6 to 8, 11, 12, 14),
`docs/mach-next/M6_1_OBSERVER_DESIGN.md` (sections 8 to 12), `docs/mach-next/M6_0_ARCHITECTURE.md`
(sections 2, 3.5, 6.3, 7.2), `src/sim/README.md`.

## 1. The decision: one reducer that takes v3 natively

**Chosen: the reducer takes version 3 events natively**, beside the simulation's v2-plus-`t`
events, and both build the one `Scene` type. `reduce(scene, event, definitions)` (`sim/reducer.ts`)
dispatches on `schema_version`; the v3 cases are in `sim/reduce-v3.ts` and are reached only through
`reduce`. Every source then goes through the same scene log (`sim/log.ts`), the same selectors and
the same store.

**Rejected: translating v3 into the simulation's vocabulary.** It would have been less code but it
cannot be honest:

- The simulation's vocabulary has no way to say "count known, calls unknown". A Dynamic Workflow
  agent's activity is a tool-call *count* and a last tool *name* (contract D13, 8.1); translating it
  into `tool.started`/`tool.finished` would invent the per-call ticks the contract forbids, and
  dropping it would lose the count.
- Many v3 facts have no M6.0 kind at all: `agent.queued`, `execution.process_*`, `run.recorded`,
  `tool.refused`, `execution.usage`, `capacity.wait_changed`, `history.began`, `history.gap`,
  refused gate evaluations, `visit_id`, `cell_instance`.
- Authority, time precision, `unknown` and `inferred` are per event in v3. A translated event would
  have to carry them in a side channel to reach the scene; reducing v3 directly puts them on the
  entity it sets (`EntityMeta`).
- Several M6.0 kinds fold into one v3 kind (`cell.stage_changed`, `build.revised`,
  `verification.started` into `station.*`; `test.result` into `build.task_completed`): a translation
  would have to split one event into several synthetic ones, each needing an id, an order and a
  provenance of its own.

**What remains of "the simulation as v3".** The simulation is *not* re-expressed as v3 events (also
not in the follow-up pass, section 8 item 16, which lists what blocks it). It enters the same engine through the same log, with ids `sim:<seq>`, an order key of the same
shape (`<t>~0~sim~<seq>~0000`), authority `simulated` on every entity and provenance `simulation` on
every scene, so it can never be mistaken for real execution. Re-expressing it as v3 would change what
it shows: 1,380 of its 2,126 events are per-call `tool.*` for workflow agents, which v3 makes a count,
and the M6.0 views still draw those ticks. What remains, for the wave that moves the views onto counts:

1. Rewrite `sim/scenario` (`belt.ts`, `story.ts`, `recorder.ts`) to emit v3 envelopes: `agent.queued`
   / `started` / `progressed` / `finished` instead of `tool.*` for workflow agents (keeping per-call
   `tool.called`/`tool.returned` only for the main loop); `station.exited` with `stage` instead of
   `station.left` + `cell.stage_changed`; `build.task_completed` instead of `task.*` and `test.result`;
   `gate.evaluated` instead of `gate.checked` and `verification.verdict`; `review.round_started` /
   `verdict_submitted`; `artifact.recorded` (reconstructed, no writer) instead of `artifact.written`.
2. Give each envelope `authority` from the catalog's telemetry class mapped onto what the observer
   would say, and keep a top-level marker that the whole history is simulated (provenance stays
   `simulation`; v3 has no `simulated` authority, the client's `simulated` stays).
3. Delete the simulation branch of `reduce` (`reduceSim`) and `sim/sim-refs.ts`, and retire
   `events.ts`'s v2 kinds, the fixture-only selector overloads and `MachSimHook`'s fixture fields.
4. Re-baseline `test/scenario.test.mjs`, `test/reducer.test.mjs` and `test/no-early-outcomes.test.mjs`
   against the v3 scenario (several of their counts are per-call).

## 2. From "every scene up front" to an incremental log

`sim/log.ts`, `createSceneLog`. One per source; the fixture's is built by `indexFixture`.

| Concern | How |
|---|---|
| Order | Entries sorted by the contract's `order` (6.3); `t` is `order_ms` (live, replay) or scenario ms (simulation) |
| Duplicates | Same id, same content (ignoring `pos`, `late`, `observed_at`): dropped, counted. Same id, different content: a conflict, counted, the first kept (contract 6.5). A re-delivery leaves the head scene the same object, so nothing re-renders and no transition replays |
| Appends | An event sorting after everything held is reduced onto the head scene |
| Checkpoints | The scene after every 128th event (16 for a fixture); beyond 8,192 events behind the head only every 1,024th (`denseWindow`, `thinFactor`). Any other scene is reduced forward from the nearest checkpoint or cached scene |
| Late events | Inserted in order; every checkpoint and cached scene after the insertion point is dropped; scenes are re-derived from the checkpoint at or before it. Cost: (events after that checkpoint) reductions, reported per ingest (`rederived`) |
| Identity | After a re-derivation the new head is interned against the old (`reuse`): every entity whose content did not change keeps its object. A pure duplicate changes nothing. The same moment gives the same object while it is cached (LRU of 256 scenes; for a fixture, every scene asked for) |
| Memory | `retain` (live default 50,000): older events are compacted into the floor checkpoint. The head is unchanged by compaction; replay cannot go below the floor; an event older than the floor is refused (`belowFloor`) |
| Speed | Within one ingest batch the reducer runs *transient*: a record it created in this run is updated in place instead of copied again (`beginTransient`/`endTransient` in `reducer.ts`). Every scene the log keeps or hands out is sealed first, so no scene anyone holds ever changes. Without it, a long history paid one copy of the `cells`/`gates` records per event (18,000 events/s); with it, 96,000 |

Measured (Node 25, Apple silicon, `test/live-scale.test.mjs`, run on this branch):

| Measure | Value |
|---|---|
| 200,000-event history (636 cells, 12 lanes, every agent snapshot), batches of 256 | 2.1 s, about 96,000 events/s |
| Heap held by the log for those 200,000 events | +129 MB (254 checkpoints) |
| Same history, `retain: 50,000` | 52,544 events held, +62 MB |
| One late event 300 behind the head | 320 reductions, 30 to 60 ms |
| Random `sceneAt` over the whole 200,000 (scrubbing) | 0.5 to 2.3 ms per call (varies run to run) |
| Twelve concurrent cells (3,792 events) | 19 to 53 ms to reduce |
| Simulation fixture (2,126 events) | indexed in 8 to 13 ms; `sceneAt` 0.4 to 0.6 µs per call once cached |

## 3. The three sources, in the store

`scene/store.ts`. `state.source` is fixed for the store's life; every scene carries
`scene.provenance` (`{source, label, origin}`), so a view cannot label a scene by the store alone and
get it wrong.

| | `simulation` | `live` | `replay` |
|---|---|---|---|
| Events from | the M6.0 fixture | the observer's stream (`live/source.ts`), after a bounded start (section 10) | the observer's `/history`, one window at a time on demand (`createReplay`, `live/windows.ts`); `loadHistory` only for an observer without `/history` |
| `liveAt` | moved by the frame loop; seeking past it moves it (the future is recorded) | what the stream confirmed (newest event or the heartbeat's watermark), carried forward by the browser's clock only while the connection is `live` and at most 20 s past the last confirmation; frozen when stale | the last event |
| `seek` past the edge | allowed | clamped | clamped |
| `extent` | `whole-run` (duration) | `so-far` (floor to edge, events held) | `so-far` |
| Chapters | the storyboard's | none (future knowledge) | none |
| `connection` | null | `ConnectionStatus` | null |
| `factoryStatus` | null | `/factory/status`, read by the source | `/factory/status`, read by the app |
| `timeScaleOf(state)` | base rate x speed | 1 while following; base rate x speed when scrubbed back | base rate x speed |
| `fixture` | the fixture | `NO_FIXTURE` (compatibility only) | `NO_FIXTURE` |

Replay inside a live store is a client-side playhead: `seek` back sets `following: false`; ingest
continues and `liveAt` moves; the scene at the replayed moment stays the same object. `followLive`
re-attaches; a replay that plays up to the edge re-attaches by itself. Nothing in the client can
pause the Factory.

`ConnectionStatus` (`scene/connection.ts`): `state` (`connecting`, `live`, `reconnecting`, `stale`,
`disconnected` after `DISCONNECTED_AFTER` failed attempts while still retrying, `no-session` on 401), `confirmedAt`, `staleSince` (the last confirmed moment, factory time), `attempts`,
the durable `cursor` and `generation`, `watermark`, `sourceLagMs` (observer-reported: heartbeat time
minus watermark), `supervisor` (lease present, heartbeat age, live, from `/factory/status`), `reason`,
and counters (`received`, `duplicates`, `late`, `gaps`, `resets`, `refused`).

## 4. The observer client and the live source

`live/observer.ts`: `session`, `events(after, limit)`, `history(window)`, `snapshot(at?)`,
`factoryStatus`, `series`, `health`, `cell(ticket)`, `artifacts(query)`, `summaries()`, behind an
injected `fetch`, M5's envelope, `X-MACH-Event-Schema: 3`. The snapshot's state (the observer's
projection: maps by id, human gates) and `/factory/status` (`summary`, `factory_present`,
`supervisor`, `freshness`) are read in the shapes `apps/observer/README.md` documents
(`readSnapshotState`, `readFactoryStatus`). The live source and the history windows no longer call
`snapshot` (section 10); it stays in the client for callers that want one state at one cursor.
`live/source.ts`, `createLiveSource`:

1. `GET /session`; if a held cursor names another epoch, treat it as a reset.
2. History from the cursor (`/events?after=`), each page applied to the log. With no held cursor and
   a long history, the bounded start of section 10 first.
3. `GET /stream?schema=3&after=<cursor>`; messages queued and applied once per animation frame;
   heartbeats (`{head, scanned, at, at_ms, watermark_ms}`) move the edge to `watermark_ms` (or `at`
   minus the 1.5 s settle window when a heartbeat carries none: an older observer).
4. A dropped stream: `reconnecting`, back-off 1 s doubling to 30 s, resume from the cursor; after
   `DISCONNECTED_AFTER` (4) failures in a row, `disconnected`, still retrying. The observer keeps its
   sessions, index and port across a restart, so when it answers again the source resumes from its
   cursor. A 401 is `no-session`, not retried.
5. `gap`: a `client.history_missing` marker enters the log at the last confirmed moment (the scene
   reads `partial` from there), then the bounded start again (section 10): the summaries and the
   newest window from the observer's floor; never `/snapshot`.
6. `reset`: history again from the new epoch (the bounded start when it is long); ids and order are
   deterministic, so everything already held de-duplicates and the scene does not change.
7. Silence for 2.5 heartbeats: `stale`; any message: `live`.

Selection, hover, view, Theater, camera follow, focus requests and a replay's playhead live in the
store and are not touched by any of this.

The two client kinds (`client.history_missing`, `client.snapshot_applied`, ids `k:`) are the client's
own markers; they never come from or go to the observer.

## 5. What changed in the scene model

| Where | Field | New or changed | Meaning |
|---|---|---|---|
| `Scene` | `provenance` | new | `{source: live / replay / simulation, label, origin}` |
| `Scene` | `completeness` | new | `complete`, `partial` (gaps, late beginnings) or `reconstructed` (snapshot), `since`, `gaps[]`, `began{ref}` |
| `Scene` | `lastEventId` | new | id of the last applied event |
| `Scene` | `lastSeq` | changed | live: the event's `pos`; link by id |
| `Scene` | `strayAgents` | new | agents whose ticket is not known: never placed by guessing |
| `Scene` | `at` | changed | live: `order_ms` (Unix ms) |
| every entity | `meta: EntityMeta` | new | `authority` (authoritative, observed, reconstructed, simulated), `eventId`, `fields` (per-field authority), `unknown` (placeholders), `inferred` (field to rule), `start`/`end` time quality (measured, inferred, simulated, unknown) |
| `FactoryState` | `paused` | new | |
| `CellState` | `cellInstance`, `gateLog`, `capacityWait`, `runRecord`, `historyBegan` | new | lifecycle gate evaluations including refusals; recorded capacity wait; cleanup's run record; partial history |
| `StationVisit` | `visitId`, `outcomeWord`, `durationMs`, `meta` | new | the lifecycle visit; the station's own word; measured duration |
| `AgentState` | `lifecycle` | new | queued, running, done, error, `unknown` (closed by the observer); `status` is its legacy projection |
| `AgentState` | `observation` | new | `per-call` or `count-only` |
| `AgentState` | `toolCallCount`, `lastTool`, `tokens`, `durationMs`, `refused`, `workflowId`, `index`, `modelName` | new | count-only facts; no per-agent cost exists |
| `AgentState` | `toolCalls` | changed | empty and meaningless for count-only agents |
| `ToolCallState` | `result`, `toolName`, `meta` | new | `unknown` result; the recorded tool name |
| `ExecutionState` | `processStartedAt`, `processEndedAt`, `ended`, `exitCode`, `recovery`, `workflowId`, `workflowStatus`, `stopReason`, `phases`, `queued`, `usage`, `claudeCodeVersion`, `refused`, `capacityWait` | new | |
| `ReviewRoundState` | `isDelta` | new | the lifecycle records only the flag |
| `ArtifactState` | `record` | new | nature, integrity, bytes, media type, commit (observer) |
| `GateState` | `reasonCode` | new | |
| `Moment` | `id` | new | link moments by event id |
| `AgentTimeline` | `observation`, `toolCallCount`, `lastTool` | new | |
| model | `LIVE_ENTITY_KINDS`, `LiveRef`, `AnyEntityRef`, `ref.visit/seat/workflow/project` | new | kept out of `EntityKind` until the views' exhaustive switches handle them |

New selectors (`sim/selectors.ts`): `logOf`, `sceneAtIn`, `extentOf` (`whole-run` or `so-far`),
`entryById`, `refsOfEntry` (event to entities), `eventIdsFor` (entity to events),
`toolActivity` (`calls` or `count`), `activityOf` (the nine states), `authorityOf`, `isKnown`,
`queuedAgents`, `liveEntityAt` (visit, seat, workflow). Every M6.0 selector that took a fixture also
takes a log (`eventsInWindow`, `eventsFor`, `latestEventFor`, `changesBetween`, `nextEventTime`,
`cellTimelines`, `agentTimeline`, `moments`, `chapters`, `chapterAt`); with a log they return
`LogEntry` (id, order, `t`, event, refs, actor, authority, precision, late).

Placeholders: where the scene's type requires a value that is not recorded (a live cell's `title`,
`risk` before `work.scheduled`, `appType`; an agent's `effort`, `tier`, and `model` when the name is
none of the four tiers; a task's `startedAt`), the scene holds a placeholder and lists the field in
`meta.unknown`. Views must check `isKnown` before drawing those fields.

## 6. What the views must change in the next wave

Atlas (`src/atlas`):

1. `locate.ts` line 79: delete the `` `LOCAL-${id.slice(3, 6)}` `` fallback; read the agent's ticket
   from `findAgent(scene, id).ticketId` (the only id parse left in the app).
2. Read scenes and events from `state.log` (`log.sceneAt`, `eventsInWindow(log, ...)` returning
   `LogEntry`, `entry.t`, `entry.event.type`) instead of `state.fixture`/`sceneAt(fixture, ...)`;
   `derive.ts` `animating()` and `legsOf` likewise.
3. `layout.ts` `plantLayout`: stop laying out from `fixture.definitions.slices` and `finalScene`;
   reserve bays per wave as waves arrive (`scene.waves`), change only when a wave arrives (contract:
   no layout needing the end of the run). `legsOf` per event as it arrives, not per fixture.
4. `Bay.tsx` tool ticker and agent figures: for `toolActivity(agent).kind === "count"` draw the count
   and `lastTool` only, no ticks, no "now running"; per-call ticks stay for `calls`. Agent state from
   `agent.lifecycle` (`queued` and `unknown` need a look); `runState(agent.status)` stays only for the
   simulation.
5. Draw placeholders as "not recorded" where `isKnown(meta, field)` is false (cell title, risk,
   app type; agent model when `meta.unknown` has `model`).
6. Cells and agents get the nine `activityOf` states, with `{ stale: isStale(connection) }`; a stale
   connection must never show work as executing.
7. `Stations.tsx`: verification dial only from recorded checks (`verify.targets_listed` gives the
   denominator, reconstructed).

Blueprint (`src/blueprint`):

1. `columns.ts`: columns from the static belt order (spec c.2), not `usedColumns(fixture)`;
   `plannedHeight` from waves so far, growing as they arrive.
2. `ticks.tsx` `ToolTrace` and `rows.tsx` agent lanes: count-only agents draw a count and last tool
   on their span, never ticks; `tree.ts` tool items only for per-call agents.
3. `index.tsx`/`Lane.tsx`: read `state.log`; lanes per wave as waves arrive; time axis
   (`axis.ts`) from measured `visit.durationMs`/`enteredAt`, marking `meta.start/end === "inferred"`
   spans as placed, not measured.
4. `TitleBlock.tsx` and the sheet: the scene's `provenance.label`, and its completeness
   (partial since, reconstructed) next to it.

Shell (`src/shell`):

1. Mode label (`chrome.tsx`, `Theater.tsx`): `playbackLabel(state)` and `scene.provenance.label`;
   the Simulation stamp only when `source === "simulation"`; a connection badge from
   `state.connection` (connecting, live, reconnecting, stale since `staleSince`, disconnected), the
   observer lag and the supervisor heartbeat age.
2. Timeline (`timeline/model.ts`, `Tracks.tsx`, `Ruler.tsx`, `Transport.tsx`, `draw.ts`): built
   incrementally from `cellTimelines(log, liveAt)` and `moments(log, ...)` re-read when
   `state.logVersion` changes, never from `fixture.duration`; the ruler's extent is
   `state.extent` (`so-far`), with the region beyond `liveAt` absent rather than hatched; no chapter
   flags for live and replay; tool marks only for per-call agents; gaps from `scene.completeness.gaps`
   drawn on the ruler. `End` jumps to the live edge; "Return to live" calls `followLive`.
3. Inspector (`inspector/*`): the telemetry badge (`EVENT_CATALOG` exists/derivable/missing) becomes
   `authority` + time `precision` from the `LogEntry` (simulation keeps the catalog class);
   `entity.ts` names from the scene, not `SCENARIO`; "Go to event" by id (`seekToEvent`); per-field
   "not recorded" from `meta.unknown`, "read from its label" from `meta.inferred`; `RunNow.tsx`
   from `activityOf`; a section for `liveEntityAt` kinds (visit, seat, workflow) once `EntityKind`
   includes them (then move `LIVE_ENTITY_KINDS` into `ENTITY_KINDS` and extend the switches in
   `entity.ts`, `Inspector.tsx`, `vocab.ts`).
4. `Announcer.tsx`: moments from `moments(log, "major", playhead)` as they arrive; one announcement
   for a connection change (live, stale, reconnecting).
5. `keyboard.ts`, `Shell.tsx`: chapter keys do nothing live; `#…?sel=` keeps working (refs are the
   same strings).
6. `App.tsx`/`main.tsx` (and `scene/react.ts` `getSceneStore`): choose the source from the page
   (`?source=live|replay`, or the host's session), create the store with `createLiveFactory` and
   start the source; `window.__machSim` stays simulation-only.

## 7. Not done (first wave; see section 8 for what the follow-up pass changed)

- The views are not adapted (section 6); the app runs in simulation mode only, as before. Not
  checked in a browser in this wave: typecheck, lint, tests and the production build pass.
- The simulation is not re-expressed as v3 (section 1, items 1 to 4).
- Never run against the real observer in this wave (the M6.2 acceptance did: section 9). The client
  is tested against an in-memory fake (`test/fixtures/observer.mjs`) and, for the M6.2 fields, against
  replies in the Go code's own shapes (`test/m62-observer-followups.test.mjs`).
- (Superseded: `/snapshot`, the heartbeat's `watermark_ms` and `/history` windows are built by the
  observer and read by the client; sections 8, 9 and 10.)
- `Date.parse` and `toISOString` are the only date functions used; a client and observer on
  different clocks are not handled (contract A6).
- `activityOf` maps an approved, unmerged cell to `unknown` (merge policy is not in the events);
  a queued workflow agent maps to `waiting-resources` with the reason "queued in its workflow".
- A capacity wait attaches to the cell and execution named by its `ids`; a slice waiting for a free
  cell stays `unknown` (D16).

## 8. Follow-ups after the views were connected (M6.2, second pass)

| # | What | Where |
|---|---|---|
| 1 | A visit belongs to the judging round it starts (the lifecycle log's meaning). The simulation's revise visit is converted where it enters the scene (`reducer.ts`, `station.entered`). Blueprint's `visitRound` is now the scene's round. | `sim/reducer.ts`, `blueprint/flow.ts` |
| 2 | A repeated `wave.discovered` merges into the wave's slices (union, order of first sight) and keeps its first moment. `bayOrder(log)` is an assignment table per log: new bays ordered by the `order` of their first event, then appended; an index never changes (an older wave arriving late goes last). The Atlas lays out from it. | `sim/reduce-v3.ts`, `sim/selectors.ts`, `atlas/layout.ts`, `atlas/index.tsx` |
| 3 | An approved (or `pr-open`) cell not merged yet: `activityOf` says `completed` with `awaiting {step: "merge", label, by, basis}`; `by` is `person` only where an event says so (the execution stopped at that stage waiting for one; a refused merge), else null (not recorded). | `sim/selectors.ts` |
| 4 | `VerificationState.listed {eventId, authority, count, late}` when `verify.targets_listed` (or the simulation's `verification.started`) was received; "expected" = pending checks of a listed round only. | `sim/model.ts`, `blueprint/rows.tsx`, `blueprint/CellFlow.tsx` |
| 5 | Review rounds (`eventId`, `late`, `decidedEventId`, `decidedLate`), seats (`votedEventId`, `votedLate`), human approvals (`eventId`, `late`), gate evaluations (`eventId`, `late`) and every `EntityMeta` (`late`). Scene `late` is the observer's own flag (part of the record); lateness to this browser stays on the log entry (`isLateEntry`), so delivery order never changes a scene. | `sim/*` |
| 6 | A slice's risk follows the cell's recorded risk (`work.scheduled`, `review.round_started`). The human-approval visit's action is `stop` (run.py's answer at awaiting-human; `meta.inferred.action`). `cellHome(scene, ticket)`: a cell with no slice stands under its ticket, wave not recorded. | `sim/reduce-v3.ts`, `sim/selectors.ts` |
| 7 | `scene.capacityWaits` holds recorded waits whether or not the cell exists (`capacityWaits`, `capacityWaitOf`); gate evaluations name the gate state they set (`gateId`, null when none), `gateRefusals(scene, ticket?)` lists refusals no gate state stands for. | `sim/*` |
| 8 | `project`, `workflow`, `visit`, `seat` are `EntityKind`s; `entityAt` resolves them by identity; `stableEntityAt` keeps the object while it does not change (for React selectors). Inspector sections for the four. | `sim/model.ts`, `sim/selectors.ts`, `shell/inspector/*`, `shell/vocab.ts`, `atlas/locate.ts` |
| 9 | `timeScaleOf(state)`: 1 at the live edge, `PLAYBACK_BASE_RATE x speed` otherwise (simulation, replay, a live store scrubbed back). Atlas (`setMotionSource`) and Blueprint (`eventProgress`) read it. | `scene/store.ts`, `atlas/derive.ts`, `atlas/index.tsx`, `blueprint/motion.ts` |
| 10 | `createLogFold` (`sim/fold.ts`): incremental per-log lists (appends read only what is new; a late insert rebuilds once; compaction trims). `moments(log)` uses it; the shell's history index is built from it (its private machinery is gone); the Atlas's `legsOf` reads its intake, dispatch and merge events from one too (`legEvents` in `atlas/derive.ts`), and keeps the legs per log version and layout. | `sim/fold.ts`, `sim/selectors.ts`, `shell/history.ts`, `atlas/derive.ts` |
| 11 | `/factory/status` in the documented shape, in the store (`state.factoryStatus`, `setFactoryStatus`); the shell's own reader (`shell/source/status.ts`) is removed. | `live/observer.ts`, `scene/store.ts`, `App.tsx`, `shell/SourceBadge.tsx` |
| 12 | `disconnected` after `DISCONNECTED_AFTER` failures (still retrying), resume from the cursor when the observer answers again; `no-session` on 401. The shell's attempt-count workaround and reason regex are gone. | `live/source.ts`, `scene/connection.ts`, `shell/SourceBadge.tsx` |
| 13 | Replay reads `/history` windows in order (`fromMs`/`toMs`, a `before-window` gap marker when the window starts part-way or `complete: false`), falling back to paged `/events`; windows load on demand while scrubbing (section 9, D17). After a gap the source no longer takes a snapshot at the floor: section 10. | `live/source.ts`, `live/observer.ts`, `live/windows.ts` |
| 14 | `execution.usage.cost_complete` and `cost_incomplete_reasons` (revision 1) on `ExecutionState.usage`; `costCompletenessOf`; the shell's stand-in (budget stop or killed workflow read as under-reported) is gone. | `sim/*`, `shell/inspector/anatomies.tsx` |
| 15 | A live store's follow loop runs only while it has a subscriber; a store made and dropped unwatched (StrictMode) asks for no frames. | `scene/store.ts` |
| 16 | Not done. See below. | |

**16, the simulation as v3: what blocks it.** Re-expressing the scenario as v3 events would change what
the simulation draws, because the views draw simulation facts no v3 kind carries: `task.started`
(active tasks with their text, files and requirement ids), `test.result` (`testsRun`, `lastTest`
with passed, failed, seconds), `verification.started.required_evidence` and target titles,
`review.started.human_approval_reasons` and the delta's files, agents' `effort`, `tier` and
`summary`, an artifact's writing agent and tool call (`artifact.written.writer`; v3 never records
it), and `workflow.phase` as a moment (`cell.workflowPhase`; v3 has only the declared list). As v3
these become "not recorded" placeholders and the Atlas, Blueprint and inspector draw them so. The
shell's simulation timeline (`timeline/model.ts`, `timelineModel()`) and history index read the
fixture's v2 events directly, and `test/scenario.test.mjs`, `reducer.test.mjs` and
`no-early-outcomes.test.mjs` count per-call and v2 kinds. The per-call tool events themselves are not
the blocker (they can be `tool.called`/`tool.returned` with the agent as parent).

Item 1 changes the Atlas's simulation markup in one way (compared at seven playheads against the tree
before this pass): after a revision, a revised cell's build machine and its hit target are labelled
"round 2 of 3", as they already were while the revision ran and as they are live. No drawn shape or
position differs; the other four playheads are byte-identical.

## 9. M6.2 acceptance fixes (the real end-to-end run, `docs/mach-next/M6_2_ACCEPTANCE.md`)

Tests: `test/m62-acceptance.test.mjs` (each reproduces its defect against the previous tree first),
`test/live-windows-scale.test.mjs` (D17, measured).

| Defect | What the scene, client or shell does now |
|---|---|
| D5 | A record naming both a ticket and a slice links them whichever was seen first (`linkSlice`); a cell opened without a slice takes the slice a `slice.materialized` already linked to its ticket. Ids read from a label never link. Property-tested over shuffled delivery. |
| D4, D14 | `StationVisit.unclosed {reason: superseded \| execution-ended, at, eventId}`: the next entry's `unclosed_visit`, or the end of the execution that entered it (`execution.process_ended`, `execution.completed`, `.failed`), closes a visit that never exited: `leftAt` the bound, outcome `stopped`, no word of the station's, end inferred, authority reconstructed. A human-approval visit is a wait on a person and is never closed by its execution. `visitStatusOf` gives working / waiting for a person / ended / ended without an exit record. An exit record arriving after all wins. |
| D6 | `GateState.state` `overridden` (with `reasonCode`), from any `gate.evaluated` verdict `overridden` (`red-before-green`, `build.red/green`, `merge.land`, audit, plan, verify); a later task completion never turns it back into a pass. `gateOverrides(scene, ticket?)` lists every override, including those no gate state stands for (`frozen-tests`). |
| D7 | `ExecutionState.observation {records, structural, runtime, version}` from its stream records and their `origin.runtime_state`; `streamObservationOf(scene, x, sourceRuntime?)`: observed, unproven, partial (section 10) or not observed with the reason (no stream, every record refused, records received and not interpreted). The runtime per source is read from `/factory/status` and `/health` `freshness.sources[].runtime` (`stream/<execution>`). |
| D8 | `history.gap` `class` and `history_lost` (observer M6.2; read from the reason otherwise). Only lost history makes a scene partial; `completeness.notInterpreted` counts unknown-type records by source, said "received, not interpreted". |
| D15 | Stream records (`agent.started`, `tool.called`) never open a cell; such agents stay in `strayAgents` with their execution and are adopted when the ticket's cell is recorded. |
| D13 | `CellState.artifactRecords` beside `artifacts`: "Artifacts referenced" (distinct) and "Artifact records" (received). |
| D23, D24 | A workflow's meta is its own (`ExecutionState.workflowMeta`). `whyEntry`/`whyOf` prefer authoritative > observed > reconstructed at the same moment; `entriesBehind` adds the event the entity's own record names. |
| D20 | `state.arrived` / `arrivedAtLeave`: "N new events" counts arrivals since the playhead left the live edge. |
| D17 | Below. |

**D17, long histories.** Live: when the observer's head is beyond `liveWindow` (20,000) events, the
source starts from the newest 20,000 events; the stream resumes from the cursor as before. (This
pass read `/snapshot?at=<head - 20,000>` to seed the window and each history window read its own
snapshot; section 10 replaces both, since the observer's snapshot is its whole projected state.) `ConnectionStatus` gains `total` (the
observer's head position), `held`, `late` (the observer's own flag), `reordered` (placed before what
was held; a delivery fact) and `deliveryLagMs` (`/health` `ingest.delivery.last_hold_ms`); the
popover says "held of total". Replay and scrubbing back past the live window read windows on demand
(`live/windows.ts`, `createWindowedHistory`): the span is cut once into equal windows of about 5,000
events (from `/series`, else the first event and a coarse `/history` sampling), each window is its
events in order (and, before section 10, the snapshot before its first event), four are kept. The store
(`options.windows`) shows the window holding the playhead (`state.log`), says `windowLoading` while
one is fetched, and returns to its own log at the live edge; selection, view and camera are kept.
The ruler draws the whole history's density from `state.series`. A moment maps to one window, so the
same history gives the same scene there however it was reached (tested).

Measured (Node, the in-memory observer indexed like the real one, 230,853 generated events; no HTTP,
no React, so the browser's figures will be higher): live first scene 94 ms (the previous tree on the
same history: 2.6 s, every event paged and reduced), heap +15 MB (previous +42 MB), held 20,000 of
230,853; scrub within the held window median 0.2 ms; past it, fetching a window, median 15 ms;
replay first scene 47 ms, heap +6 MB, scrub median 0.1 ms, 16 ms with a fetch. (The in-memory
observer's snapshot is tiny; the real one's is not: section 10.)

Not done in this pass: the received counter does not count events refused below a live log's floor.
(Bays across history windows: fixed in section 10.)

## 10. After the observer's M6.2 update (commit 0cf50ec)

Field names read from the Go code (`internal/server/routes.go`, `internal/project/views.go`,
`internal/event/event.go`, `internal/ingest/ingest.go`, `internal/artifact/catalog.go`), not from
the documents:

| Where | Field | Read into |
|---|---|---|
| `history.gap` data | `class`, `history_lost` (`event.GapClass`: `not-received`, `unparsable-line`, `unknown-type`, `state-mismatch`, `evicted`, `source-unreadable`, `conflict`) | `HistoryGapState.class`, `.lost`. Without them the reason is classed as the observer does (`no-timestamps` and unknown reasons are `unknown-type`, not lost) |
| `/snapshot` `state.history`, `/project` `history`, `/health` `projection.history` | `{completeness, lost, not_interpreted, classes, gaps, partial, not_v3}` (`project.HistoryFacts`) | `readObserverHistory` → `ObserverHistory`; `Completeness.observer` (from what seeded the scene), `FactoryStatus.history` (from `/health`) |
| events from a stream | `origin.runtime_state` | `ExecutionState.observation.runtime` |
| `/health` `ingest.runtime`, `/session` `capabilities.stream_observations` | `{policy, state, proven_versions, versions[{version, state, executions, records_refused}]}` (+ `ok`, `claude_code_version`, `reason` in the session) | `RuntimeSummary` (`FactoryStatus.runtime`, `ObserverSession.streamObservations`) |
| `/health`, `/factory/status` `freshness.sources[].runtime` | `{name, version, state, proven_versions, records_accepted, records_refused, refused_by_class, reason}` (`ingest.RuntimeStat`) | `SourceRuntimeStatus` |
| `station.exited` of the plan (revision 2) | `app_type`, `risk`, `counts.contracts`, `counts.tasks` | `CellState.plan`, `appType`, `risk` |
| `/cells`, `/cells/{t}` | `app_type`, `risk`, `plan {app_type, risk, contracts, tasks, recorded_by}` | `ObserverCell.plan`; seeded `CellState.plan` |
| `/artifacts` items | `visit {visit_id, basis: recorded \| reconstructed, rule}`, `round_basis` | `ArtifactEntry.visit`, `.roundBasis` (types only, for M6.4) |

What changed:

- **History completeness by class.** Only lost history makes a scene partial; `unknown-type` is said
  "received, not interpreted" and `conflict` "a conflicting copy, the first kept". The header badge,
  the Blueprint title block (`2 gaps (not received, before the loaded window)`) and the event's own
  description (`describeEntry`) say the class; the observer's own losses (from `history.lost`) are
  added to the badge's explanation. `GAP_CLASS_WORDS` moved to `sim/provenance.ts`.
- **Runtime states.** `streamObservationOf` has four states: `observed` (proven, or an observer that
  does not judge), `unproven` (`compatible-unproven`, or `unknown`: the stream has not stated its
  version yet), `partial` (`incompatible`: some records refused; what matched is shown, which the
  old reading hid as "not observed"), `not-observed`. Each carries `runtime` and `recordsRefused`.
  Agent counts say "agent activity from an unproven Claude Code version (2.1.324)" or "… some of its
  records were refused, so some may be missing"; the inspector's Record block has a "Runtime" row for
  executions, workflows, agents and tool calls; agents say how they were read ("Read as"); the
  connection facts list every stream's runtime (`/health` `ingest.runtime`).
- **Plan facts.** The cell inspector shows "Plan: app type library, High risk, 2 contracts, 7 tasks
  (recorded at the plan's exit)", or not recorded; the app type falls back to the plan's word when it
  is not one the scene knows.
- **A bounded start, never the whole state (D17).** Before: the live source read
  `/snapshot?at=<head - 20,000>` (the observer's whole projected state: every cell's detail, every
  execution's agents and tools; about 35 MB of JSON at 230,853 events), each history window read
  `/snapshot?at=` again, and a gap read `/snapshot` at the floor or the head. After: no `/snapshot`
  anywhere in the live source or the windows. A long history starts from the observer's summaries
  (`/waves`, `/slices`, `/cells`, `/runs` paged by 1,000, `/project`: bounded by how many there are,
  never by events) and its newest `liveWindow` events (`/events?after=`), then the stream. Only what no
  event of the window touches is seeded from the summaries (its state at the summaries' cursor holds
  through the window, so it may stand at the window's start), as a reconstructed
  `client.snapshot_applied` after a `client.history_missing` ("before the loaded window"). History
  windows are their own events with that marker. The timeline's density is `/series` as before. A
  gap or a reset runs the same bounded start again. Short histories (head within `liveWindow`, floor
  0) are read whole, as before. `loadHistory` (an observer with no `/history`) still pages the
  retained history: an older-observer fallback.
- **Idle between executions (task 3).** `activityOf` on a live cell is `executing` only while the
  execution doing the work has not ended (no `execution.completed`/`failed`, no
  `execution.process_ended`); a station visit left open by an ended execution is not work going on.
  A cell whose last execution has ended and none runs is said from that execution's record
  (`Activity.between`): "Idle between executions: the last one ended at built. The next step recorded
  is verify. No execution is running; nothing recorded says when the next starts." (`unknown`), or
  `waiting-person` when it stopped waiting for one; "Idle: its process ended and the supervisor has not
  recorded the outcome yet" before the supervisor records it. A claimed execution whose process has
  not started is still `executing` ("Claimed by the supervisor"). The cell inspector shows the reason
  ("Now"). The simulation keeps M6.0's reading.
- **Bays across history windows (task 4).** `SceneLogOptions.lineage`: the live log and the windows
  read behind it (and a replay's windows) share one object, and `bayOrder` keeps one assignment table
  per lineage, so a ticket keeps its bay whichever window holds the playhead; a window that has not
  seen a later ticket draws the bays already given (empty), never moves them, and never takes back a
  ticket another window learned. Selection lives in the store and is kept.
- **Atlas element budget (task 5)**, in `atlas/Bay.tsx` (`SummaryBay`), `Plant.tsx` (`Ruler`),
  `Stations.tsx`: the dense plant's mid-zoom peak on the `twelve` fixture from about 2,600 to 2,401
  (budget 2,500): summary bays lose their attribute-less wrapper groups, the main-line ruler's ticks
  are one path, a wave's stack draws at most five sheets (the count is lettered), the merge berths and
  run-record shelf slots of a dense plant are one dashed path each, and a departed slice's holding pad
  in a dense plant at mid zoom is its outline. The simulation's Atlas markup at five playheads and two
  zooms is the same but for the ruler's ticks folded into one path.

Tests: `test/m62-observer-followups.test.mjs` (each defect reproduced against the previous tree
first); `live-source`, `m62-followups`, `m62-acceptance` and `live-windows-scale` re-baselined where
they asserted a snapshot.

## 11. Re-check after the fix rounds (`docs/mach-next/M6_2_ACCEPTANCE.md`, top section)

Tests: `test/m62-recheck-fixes.test.mjs` (each fails against the tree before this pass).

| Item | What the scene, client or views do now |
|---|---|
| D6 | `cellGateList(scene, ticket)` (`sim/gates.ts`): every gate the history evaluated for the cell, once: its gate states and every lifecycle evaluation no gate state stands for (each override, refusal and pass: `frozen-tests`, `build.start`, `verify.start`...), oldest first, each a link to its ref. The cell inspector's Gates list is this list. |
| R5 | Each `GateEvaluation` keeps the ref the observer names it by (`gate:<cell>/<gate>[#<round>]`). `gateOfRef` (used by `entityAt`, `relatedRefs` and the inspector's `selectEntity`) resolves an observer ref to the gate state the evaluation set, or whose kind it is (`plan.check` to `plan-check`, `verify.verdict#1` to `verification#1`, `red-before-green#2` to `red-before-green`), else to a `recorded` gate built from its evaluations (`GateState.gate: "recorded"`, never in `scene.gates`). |
| D10 | The gate's state in words is one function, `gateStateWords` (moved to `sim/gates.ts`; the shell re-exports it, the Atlas's `gateWord` is it in lower case). The review chamber's gate (`atlas/consensus.ts`, `chamberGate`) names and selects one real gate: the sitting round's, else the latest review gate ("no panel sitting. Last review: LOCAL-001 round 2, passed; the panel approved; a person must approve next..."); the glyph's own name (its arm's position, "Open") is hidden from assistive technology. |
| R4 | `visitLeftWords` (`shell/inspector/words.ts`): plain text with the time formatted, never an element interpolated into a string. |
| R6 | `executionStatusOf(x)`: "Ended, outcome not recorded yet" once its process ended (`processEndedAt` or `ended`) and the supervisor has not recorded it. `Activity.label` carries the same for views (`activityLabel`): the execution's "Ended, outcome not recorded yet", the cell's "Idle, outcome not recorded yet" or "Idle between executions"; the Atlas mast and cell labels, the Blueprint's lanes, rows and tree, and the inspector use it. |
| R7 | The store takes a `wallClock` (the browser passes `Date.now`): while connecting or live, the live edge is now from the first frame, corrected by the observer's clock (`observeClock`, from each heartbeat's `at_ms` and a session `now_ms`/`now` when the observer gives one); frozen when stale or lost, as before. Without a wall clock (tests) the old extrapolation stands. Following the edge with nothing moving, the loop asks for no frames: one wait (`Clock.later`) to the next whole second for the clock label, frames only for `LIVE_MOTION_MS` (2.5 s) after an arrival, every frame while playing. `timeCodeText` (`shell/time.ts`) shows "--:--:--, No events yet" before any moment, never 1 January 1970; stale and confirmed times are guarded the same way (`isMoment`). |
| R1 label | Catalog entries carry `freeText` and `freeTextNote` (`free_text`, `free_text_note`); `readContentLabels` reads `X-MACH-Free-Text` and `X-MACH-Redacted`; `client.artifactContent(id)` returns both. The inspector reads the catalog once per ticket (`shell/inspector/catalog.ts`) and labels every artifact row and the artifact's facts "Free text, not checked for names" (`FREE_TEXT_LABEL`). |

**D17, memory on a 230,853-event history** (the H200 copy, built observer, headless Chromium, 1512x982;
`performance.memory` sampled every 100 ms, and `Runtime.getHeapUsage` after two forced GCs):

| Measure | Before | After |
|---|---|---|
| Peak JS heap used while loading (total reserved) | 827 to 856 MB (880 to 919) | **340 MB (398)** |
| Used 4 s after load, no forced GC | 799 to 845 MB | 229 to 232 MB |
| Live after a forced GC (Atlas / Blueprint) | 185 / 183 MB | 179 / 179 MB |
| Allocated during load and 4 s after (sampling profile, garbage included) | 6.9 GB | 0.9 GB |
| Page load to live | 10.4 to 11.6 s | 2.8 to 3.0 s |
| Idle live page: frames per second, DOM mutations per second | every frame; 36 mutations/s (headless, throttled) | 0.2; 13 |

Where it went, and what changed: (1) `activityOf` scanned every gate for every cell
(`Object.values(scene.gates).find(...)`), and the Atlas's `latestGate` and the Blueprint's
`revisionsOf` did the same per bay or cell, on every store change, and the live loop changed the
store every frame: 5.1 GB of the 6.9 GB was that scan. Now the human gate is looked up by id,
gates are indexed per ticket once per `scene.gates` object (`gatesOfTicket`, `latestGateOf`),
`activityOf` is answered once per scene, and the idle loop no longer changes the store 60 times a
second. (2) On a plant of 1,261 bays every spur and exit track ran the plant's depth with a chevron
every 48 units: about 680,000 chevron paths drawn on the first (mid-zoom) frame and dropped at the
far fit. A plant of more than `DENSE_TRACKS` (48) bays draws its bay tracks without chevrons (the
arrowed tracks keep theirs; the simulation and the twelve-cell fixture are unchanged), and tracks
and Blueprint flow routes are drawn again only when their points change (`Track`, `FlowPath`).
What remains live (about 180 MB) is mostly React's fibers for both views (153,000 DOM nodes: the
hidden view stays mounted for fast switching) and the scene log (about 25 MB); the suspected
per-checkpoint copies and summary seeds are small (ingest 12 MB, the bounded start 12 MB).
Culling the Blueprint's off-screen lanes would be the next step.

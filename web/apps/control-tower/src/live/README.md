# Control Tower, M6.2: live execution through the one scene model

Status: the engine, the store and the observer client are built and tested, and the views (Atlas,
Blueprint, shell) draw all three sources. Section 8 lists the follow-ups the view owners reported
after connecting them, and what was done about each. Nothing here writes anything anywhere: the
client reads the observer's `/api/v1`.

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
| Events from | the M6.0 fixture | the observer's stream (`live/source.ts`) | the observer's history, loaded once (`loadHistory`) |
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
`factoryStatus`, behind an injected `fetch`, M5's envelope, `X-MACH-Event-Schema: 3`. The snapshot's
state (the observer's projection: maps by id, human gates) and `/factory/status` (`summary`,
`factory_present`, `supervisor`, `freshness`) are read in the shapes `apps/observer/README.md`
documents (`readSnapshotState`, `readFactoryStatus`). `live/source.ts`, `createLiveSource`:

1. `GET /session`; if a held cursor names another epoch, treat it as a reset.
2. History in pages from the cursor (`/events?after=`), each page applied to the log.
3. `GET /stream?schema=3&after=<cursor>`; messages queued and applied once per animation frame;
   heartbeats move the edge to the watermark (or `at` minus the 1.5 s settle window when the
   heartbeat carries none, as the observer's does today).
4. A dropped stream: `reconnecting`, back-off 1 s doubling to 30 s, resume from the cursor; after
   `DISCONNECTED_AFTER` (4) failures in a row, `disconnected`, still retrying. The observer keeps its
   sessions, index and port across a restart, so when it answers again the source resumes from its
   cursor. A 401 is `no-session`, not retried.
5. `gap`: a `client.history_missing` marker enters the log at the last confirmed moment (the scene
   reads `partial` from there), then `/snapshot?at=<the gap's floor>` (the state at that cursor; the
   observer's current state if it can no longer rebuild that one), a `client.snapshot_applied` marker
   seeds what it says (`reconstructed`), then history from the snapshot's cursor.
6. `reset`: history again from the new epoch's start; ids and order are deterministic, so everything
   already held de-duplicates and the scene does not change.
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
- Never run against the real observer: the client is built from the documented API and tested
  against an in-memory fake (`test/fixtures/observer.mjs`). `/api/v1/snapshot` is designed but not
  built by the observer; its state is read tolerantly. The heartbeat's watermark field is not yet
  sent by the observer (`{head, at}` today); the client falls back to `at` minus the settle window.
- `/api/v1/history?from_order=` (windowed replay) is not used: replay loads the retained history.
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
| 10 | `createLogFold` (`sim/fold.ts`): incremental per-log lists (appends read only what is new; a late insert rebuilds once; compaction trims). `moments(log)` uses it; the shell's history index is built from it (its private machinery is gone). The Atlas's `legsOf` still scans the log per version (view code, not changed). | `sim/fold.ts`, `sim/selectors.ts`, `shell/history.ts` |
| 11 | `/factory/status` in the documented shape, in the store (`state.factoryStatus`, `setFactoryStatus`); the shell's own reader (`shell/source/status.ts`) is removed. | `live/observer.ts`, `scene/store.ts`, `App.tsx`, `shell/SourceBadge.tsx` |
| 12 | `disconnected` after `DISCONNECTED_AFTER` failures (still retrying), resume from the cursor when the observer answers again; `no-session` on 401. The shell's attempt-count workaround and reason regex are gone. | `live/source.ts`, `scene/connection.ts`, `shell/SourceBadge.tsx` |
| 13 | Snapshot at the gap's floor cursor; replay reads `/history` windows in order (`fromMs`/`toMs`, a `before-window` gap marker when the window starts part-way or `complete: false`), falling back to paged `/events`. Not done: loading further windows on demand while scrubbing a long replay (replay still loads the history it is given in one go). | `live/source.ts`, `live/observer.ts` |
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

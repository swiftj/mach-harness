/**
 * The one store: the playback clock, selection, focus target, hover highlight, view mode and
 * Theater Mode, for all three sources of a scene. Every view subscribes to it (see react.ts); none
 * keeps time or selection of its own.
 *
 * It holds no factory state of its own. What the factory looks like at the playhead is
 * `state.log.sceneAt(playhead)`: the scene log (src/sim/log.ts) of the store's source.
 *
 * Sources (`state.source`, fixed for the store's life, stamped on every scene as `scene.provenance`):
 * - `simulation`: the M6.0 fixture. Its future is recorded: `liveAt` is moved by the frame loop,
 *   seeking past it moves it forward, the run has a duration and chapters. Unchanged from M6.0.
 * - `live`: the observer's stream. `liveAt` is the live edge. With a wall clock (`wallClock`, the
 *   browser's; corrected by the observer's own clock when it says one, `observeClock`) the edge is
 *   now from the first frame while the connection is connecting or live, and never before what the
 *   stream confirmed (R7). Without one (tests), it is set by what the stream confirmed (`setLiveEdge`)
 *   and carried forward by the store's clock at most LIVE_EXTRAPOLATION_MS past the last
 *   confirmation. Either way it never moves on its own when the connection is stale or lost. While
 *   nothing moves, the follow loop asks for no frames: it wakes once a second for the clock label
 *   (and at once when an event arrives); it runs every frame only while a motion is in progress. Seeking clamps to it: nobody can seek into execution not yet observed.
 *   Replay is a client-side playhead over received events: ingest continues while the playhead is
 *   elsewhere; `followLive` re-attaches to the edge, and a replay that reaches the edge re-attaches.
 * - `replay`: a history loaded from the observer, not connected. Its edge is its last event.
 */
import type { Chapter, EntityRef, Fixture } from "../sim/model";
import type { Extent } from "../sim/selectors";
import { chapters as chaptersOf, eventBySeq, extentOf, nextEventTime, previousEventTime, relatedRefs } from "../sim/selectors";
import { fixtureLog } from "../sim/engine";
import type { SceneLog } from "../sim/log";
import type { SceneSource } from "../sim/provenance";
import type { Clock, SwitchableClock } from "./clock";
import type { ConnectionStatus, FactoryStatus } from "./connection";
import { INITIAL_CONNECTION } from "./connection";
import { INITIAL_TIMELINE_VIEW, type TimelineViewState } from "../timeline/contract";
import { storeView } from "./view";

/** Factory milliseconds per wall millisecond at 1x: the 55-minute run plays in about 5.5 minutes. Simulation and replay playback only; live time runs at 1. */
export const PLAYBACK_BASE_RATE = 10;
export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type PlaybackSpeed = (typeof SPEEDS)[number];
export type ViewMode = "atlas" | "blueprint";
/**
 * The experience on screen (M6.3 design section 7): the Factory Floor (whose view is `view`) or the
 * Execution Timeline. A separate field, so `ViewMode` and everything that assumes two views stay as
 * they are, and the floor's view is remembered while the Timeline is up.
 */
export type Workspace = "floor" | "timeline";
export const WORKSPACES: readonly Workspace[] = ["floor", "timeline"];
/** How far the live edge may run ahead of the last thing the stream confirmed (a heartbeat comes every 15 s). */
export const LIVE_EXTRAPOLATION_MS = 20_000;
/**
 * How long after an event's time its motion can still be in progress at the live edge (time scale
 * 1): the longest event window the views animate (the Atlas's `slice.materialized`, 1,900 ms) with
 * margin. Past it, the follow loop stops asking for frames until the next event or clock tick.
 */
export const LIVE_MOTION_MS = 2_500;

/**
 * Compatibility only: the `fixture` a live or replay store reports, so the M6.0 views (which still
 * read `state.fixture`) compile and draw nothing from it. Views move to `state.log` in the next wave.
 */
export const NO_FIXTURE: Fixture = Object.freeze({
  id: "no-fixture",
  title: "No fixture (live or replay)",
  startAt: "1970-01-01T00:00:00Z",
  duration: 0,
  events: [],
  definitions: { project: { id: "", name: "", integrationBranch: "" }, waves: {}, slices: {} },
  chapters: [],
});

/** A request for the camera, honoured by both views. `nonce` changes on every request, so asking twice re-frames. */
export interface FocusRequest {
  readonly target: EntityRef | "overview";
  readonly reason: "select" | "chapter" | "follow" | "api";
  readonly nonce: number;
}

/**
 * A long history read in windows (D17): the store shows the window that holds the playhead when its
 * own log does not reach it (a replay, a live store scrubbed back past what it holds). Implemented by
 * src/live/windows.ts over `/api/v1/history` and `/snapshot?at=`.
 */
export interface HistoryWindow {
  readonly log: SceneLog;
  /** The window covers from <= t < to (`to` Infinity for the last). */
  readonly from: number;
  readonly to: number;
}
export interface HistoryWindows {
  /** The earliest time of the history (null: not known yet). */
  start(): number | null;
  /** The window holding t, when it is loaded now. */
  peek(t: number): HistoryWindow | null;
  /** Load the window holding t (fetching it), and keep it among the recent ones. */
  load(t: number): Promise<HistoryWindow>;
}

/** Counts per time bucket for the whole history (`/api/v1/series`), so the timeline can draw what is not held. */
export interface SeriesState {
  readonly bucketMs: number;
  readonly buckets: readonly { readonly fromMs: number; readonly count: number; readonly atLeast?: boolean }[];
  readonly total: number | null;
  readonly coarse: boolean;
}

/** A chosen time interval and the cells with a span overlapping it. */
export interface HighlightInterval {
  readonly from: number;
  readonly to: number;
  readonly refs: readonly EntityRef[];
}

export interface SceneStoreState {
  /** Where the scenes come from. Persistent: a store never changes source. */
  readonly source: SceneSource;
  /** The scene log every view reads scenes from (`log.sceneAt(playhead)`): the store's own, or the history window holding the playhead. */
  readonly log: SceneLog;
  /** Bumped whenever the shown log's events change or another log is shown, for change detection. */
  readonly logVersion: number;
  /** Live: events received into the store's own log since it opened (only arrivals count). */
  readonly arrived: number;
  /** Live: `arrived` when the playhead left the live edge; null while following. "N new events" is the difference (D20). */
  readonly arrivedAtLeave: number | null;
  /** A history window is being fetched for the playhead (D17). */
  readonly windowLoading: boolean;
  /** Counts per time bucket over the whole history, when the observer serves them. */
  readonly series: SeriesState | null;
  /** How far the history reaches: the whole run (simulation) or so far (live, replay). */
  readonly extent: Extent;
  /** Live only: the connection, its staleness, lag and the supervisor's heartbeat. Null for simulation and replay. */
  readonly connection: ConnectionStatus | null;
  /**
   * Live and replay: the Factory's state on this machine as the observer last read it
   * (`/api/v1/factory/status`): whether there is Factory state at all, enabled, paused, the
   * supervisor's heartbeat, per-source lag. Null until read, and always for the simulation.
   */
  readonly factoryStatus: FactoryStatus | null;
  /** Simulation: the fixture. Live and replay: NO_FIXTURE (compatibility; read `log`). */
  readonly fixture: Fixture;
  /** Factory time shown. Simulation: ms from the scenario start; live and replay: Unix ms (`order_ms`). */
  readonly playhead: number;
  /** The live edge. Simulation: the simulated now. Live: what has been observed (see the header). Replay: the last event. */
  readonly liveAt: number;
  /** Live-follow: the playhead is pinned to liveAt. Off while replaying an earlier moment. */
  readonly following: boolean;
  readonly playing: boolean;
  readonly speed: PlaybackSpeed;
  /** Events applied at the playhead (log.cursorAt(playhead)), for cheap change detection. */
  readonly cursor: number;
  readonly selection: EntityRef | null;
  /**
   * What was picked when it is more precise than the selection: a Timeline span whose own entity the
   * store cannot select (a visit, a round, a build task in the simulation) selects its nearest
   * selectable ancestor, and the span's entity is kept here so the Timeline can keep it marked.
   * Null otherwise; cleared by any other selection.
   */
  readonly selectionDetail: string | null;
  readonly focus: FocusRequest | null;
  readonly hovered: EntityRef | null;
  /**
   * What to highlight: the hovered (or else the selected) entity's dependency set or relations; with
   * neither, the cells active in the Timeline's chosen interval (`interval`), when one is set.
   */
  readonly highlighted: readonly EntityRef[];
  /**
   * A time interval the person chose in the Timeline and the cells active in it, so the floor can
   * show them (M6.3 design section 7). Not a second selection: it only feeds `highlighted`, and only
   * while nothing is hovered or selected. Set and cleared by the Timeline workspace.
   */
  readonly interval: HighlightInterval | null;
  readonly view: ViewMode;
  /** Factory Floor or Timeline. The floor's `view` is kept while the Timeline is up. */
  readonly workspace: Workspace;
  /**
   * The Timeline's interface state (window, grouping, expansion, filters, table), kept here so it
   * survives a workspace switch. Interface state only: nothing in it changes what another view shows.
   */
  readonly timeline: TimelineViewState;
  /** Theater Mode: the Factory Floor only; always off while the Timeline is up. */
  readonly theater: boolean;
  readonly reducedMotion: boolean;
  /**
   * Camera follow, one flag for both views and the Shell. On by default. Off as soon as the person
   * pans or zooms (the view calls setFollow(false)) or asks the camera to frame something
   * (focusOn with any reason but "follow"); back on with followLive() or setFollow(true). The camera
   * follows only while this is on and the playhead is live: see cameraFollows(). Theater Mode
   * does not change it.
   */
  readonly follow: boolean;
}

/**
 * How fast played-back history moves against real time, as the person is told it. Real history
 * (a replay, or live history being reviewed) moves at PLAYBACK_BASE_RATE x speed, so its speeds are
 * named for what they are: 5x, 10x ... 160x real time. The simulation's speeds stay relative to its
 * own scenario (0.5x to 16x), which has no real time to compare with.
 */
export function playbackFactorOf(source: SceneSource, speed: PlaybackSpeed): number {
  return source === "simulation" ? speed : speed * PLAYBACK_BASE_RATE;
}

/** The factor as written on a control: "½×" for the simulation's half speed, otherwise "N×". */
export function playbackFactorLabel(source: SceneSource, speed: PlaybackSpeed): string {
  const factor = playbackFactorOf(source, speed);
  return `${factor === 0.5 ? "½" : factor}×`;
}

/** The factor as spoken: "20 times real time" for real history, "2 times" for the simulation; a half is "half speed" (X22), never "0.5 times". */
export function playbackFactorWords(source: SceneSource, speed: PlaybackSpeed): string {
  const factor = playbackFactorOf(source, speed);
  if (factor === 0.5) return source === "simulation" ? "half speed" : "half real time";
  return source === "simulation" ? `${factor} times` : `${factor} times real time`;
}

/**
 * The one time scale for motion, in factory ms per wall ms, for every view and every source:
 * - live, at the edge (following): 1, real time;
 * - anything played back (the simulation, a historical replay, and a live store scrubbed back or
 *   replaying an earlier moment): the playback rate the person chose, PLAYBACK_BASE_RATE x speed.
 * A motion written as `d` wall ms lasts `d x timeScaleOf(state)` factory ms, so on screen it lasts
 * `d` at every speed and in every source. Views read it from here, never from the source alone.
 */
export function timeScaleOf(state: Pick<SceneStoreState, "source" | "following" | "speed">): number {
  if (state.source === "live" && state.following) return 1;
  // The simulation keeps M6.0's rule (a motion takes the same share of the run at any speed), so the
  // approved prototype looks as it did; real history scales with the chosen speed so motions stay legible.
  return state.source === "simulation" ? PLAYBACK_BASE_RATE : PLAYBACK_BASE_RATE * state.speed;
}

/** Whether the camera should follow the live action now: follow is on and the playhead is live. */
export function cameraFollows(state: Pick<SceneStoreState, "follow" | "following">): boolean {
  return state.follow && state.following;
}

/** The words for where the playhead is: "Simulation", "Live", "Live, reviewing an earlier moment", "Historical replay". */
export function playbackLabel(state: Pick<SceneStoreState, "source" | "following" | "connection">): string {
  if (state.source === "simulation") return "Simulation";
  if (state.source === "replay") return "Historical replay";
  const conn = state.connection;
  const edge = conn && conn.state !== "live" ? ` (${conn.state})` : "";
  return state.following ? `Live${edge}` : `Live, reviewing an earlier moment${edge}`;
}

export interface SceneStore {
  getState(): SceneStoreState;
  subscribe(listener: () => void): () => void;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Seek to `t`. Live and replay: clamped to [extent start, live edge]. */
  seek(t: number): void;
  /** Simulation only (events are linked by id elsewhere). */
  seekToSeq(seq: number): void;
  /** Seek to an event by id (any source). */
  seekToEvent(id: string): void;
  /** Simulation only: chapters are storyboard knowledge. A no-op for live and replay. */
  seekToChapter(id: string): void;
  /** One event forward or back (all events sharing a time move together); pauses playback. */
  stepNext(): void;
  stepPrevious(): void;
  setSpeed(speed: PlaybackSpeed): void;
  /** Jump to the live edge and stay pinned to it. */
  followLive(): void;
  select(entity: EntityRef | null, options?: { focus?: boolean; detail?: string | null }): void;
  focusOn(target: EntityRef | "overview", reason?: FocusRequest["reason"]): void;
  hover(entity: EntityRef | null): void;
  /** The Timeline's chosen interval and the cells active in it, or null. Feeds `highlighted` only while nothing is hovered or selected. */
  setHighlightInterval(interval: HighlightInterval | null): void;
  setView(view: ViewMode): void;
  /** Switch the experience. Selection, hover, playhead, playback and `view` are kept; Theater Mode ends on leaving the floor. */
  setWorkspace(workspace: Workspace): void;
  /** Merge a change into the Timeline's interface state. No change, no new state. */
  setTimelineView(patch: Partial<TimelineViewState>): void;
  /** Theater Mode on or off. Asking for it while the Timeline is up does nothing: it belongs to the floor. */
  setTheater(on: boolean): void;
  setReducedMotion(on: boolean): void;
  /** Camera follow on or off. A view calls setFollow(false) when the person pans or zooms. */
  setFollow(on: boolean): void;
  // ---- live: written by the live source only
  /** The log changed (events ingested). Recomputes cursor, extent and highlight; keeps selection, view, camera and playhead. */
  logChanged(): void;
  /** The stream confirmed history up to factory time `t` (an event or a heartbeat). Moves the live edge, never backwards. */
  setLiveEdge(t: number): void;
  /**
   * The observer's own clock read `observerNowMs` (Unix ms) just now (a heartbeat's `at_ms`, or the
   * session's time when it gives one): the live edge then runs on the browser's wall clock corrected
   * by the difference. Ignored without a wall clock.
   */
  observeClock(observerNowMs: number): void;
  setConnection(status: ConnectionStatus): void;
  /** The Factory's state on this machine, as the observer last read it (live and replay). */
  setFactoryStatus(status: FactoryStatus | null): void;
  /** Counts per time bucket over the whole history. */
  setSeries(series: SeriesState | null): void;
  dispose(): void;
}

interface CommonOptions {
  clock: Clock;
  reducedMotion?: boolean;
  speed?: PlaybackSpeed;
  view?: ViewMode;
  workspace?: Workspace;
  /** Start at this factory time (default: the start for the simulation, the live edge otherwise). */
  at?: number;
  autoplay?: boolean;
  /** Factory ms per wall ms at 1x for simulation and replay playback (default PLAYBACK_BASE_RATE). */
  rate?: number;
  /**
   * Live only: the wall clock (Unix ms; the browser passes Date.now). The live edge is then now from
   * the first frame, not the last event's time carried forward (R7).
   */
  wallClock?: () => number;
}
export interface SimulationStoreOptions extends CommonOptions {
  fixture: Fixture;
}
export interface LogStoreOptions extends CommonOptions {
  source: "live" | "replay";
  log: SceneLog;
  /** A long history held in windows: shown when the playhead is outside `log` (D17). */
  windows?: HistoryWindows;
}
export type SceneStoreOptions = SimulationStoreOptions | LogStoreOptions;

export function createSceneStore(options: SceneStoreOptions): SceneStore {
  const { clock } = options;
  const isSim = "fixture" in options;
  const source: SceneSource = isSim ? "simulation" : options.source;
  const fixture = isSim ? options.fixture : NO_FIXTURE;
  /** The store's own log (live: the stream's; replay: the window at its end). */
  const log = isSim ? fixtureLog(options.fixture) : options.log;
  const windows = isSim ? undefined : options.windows;
  /** The log shown now: `log`, or the history window holding the playhead. */
  let shown: HistoryWindow | null = null;
  let version = 0;
  const rate = options.rate ?? PLAYBACK_BASE_RATE;
  const duration = fixture.duration;

  // Live: what the stream last confirmed, and when (wall time) it did.
  let confirmed = log.headTime() ?? 0;
  let confirmedWall = clock.now();
  // Live with a wall clock: now, corrected by the observer's clock when it said one.
  const wallClock = !isSim && options.source === "live" ? options.wallClock : undefined;
  let clockOffset = 0;
  const wallNow = (): number | null => (wallClock ? wallClock() + clockOffset : null);
  // Until when (factory ms; at the live edge, wall ms) a motion may be in progress: frames are asked for until then.
  let motionUntil = Number.NEGATIVE_INFINITY;

  const ownFloor = (): number => (isSim ? 0 : (log.floorTime() ?? confirmed));
  const floorT = (): number => {
    const own = ownFloor();
    const start = windows?.start() ?? null;
    return start === null ? own : Math.min(own, start);
  };
  const currentLog = (): SceneLog => shown?.log ?? log;
  const extentNow = (liveAt: number) => {
    const own = extentOf(isSim ? fixture : log, isSim ? undefined : liveAt);
    if (!windows) return own;
    return { ...own, start: floorT(), end: Math.max(own.end, liveAt) };
  };
  const edgeOf = (): number => (isSim ? duration : source === "replay" ? (log.headTime() ?? 0) : Math.max(confirmed, log.headTime() ?? confirmed));
  const clamp = (t: number, edge: number): number => Math.min(edge, Math.max(floorT(), t));
  // A live store with a wall clock starts at now (its connection starts as "connecting"), never at the last event's time.
  const startEdge = Math.max(edgeOf(), wallNow() ?? Number.NEGATIVE_INFINITY);
  const start = isSim ? Math.min(duration, Math.max(0, options.at ?? 0)) : clamp(options.at ?? startEdge, startEdge);

  let state: SceneStoreState = {
    source,
    log,
    logVersion: 0,
    arrived: isSim ? 0 : log.size(),
    arrivedAtLeave: null,
    windowLoading: false,
    series: null,
    extent: isSim ? extentOf(fixture) : extentNow(startEdge),
    connection: source === "live" ? INITIAL_CONNECTION : null,
    factoryStatus: null,
    fixture,
    playhead: start,
    liveAt: isSim ? start : startEdge,
    following: isSim ? true : start >= startEdge,
    playing: false,
    speed: options.speed ?? 1,
    cursor: log.cursorAt(start),
    selection: null,
    selectionDetail: null,
    focus: null,
    hovered: null,
    highlighted: [],
    interval: null,
    view: options.view ?? "atlas",
    workspace: options.workspace ?? "floor",
    timeline: INITIAL_TIMELINE_VIEW,
    theater: false,
    reducedMotion: options.reducedMotion ?? false,
    follow: true,
  };
  const listeners = new Set<() => void>();
  let ownVersion = log.version();
  let frame: number | null = null;
  /** A wait (no frames) while nothing moves at the live edge. */
  let wait: number | null = null;
  let lastFrameAt = 0;
  let nonce = 0;

  const highlightFor = (s: SceneStoreState): readonly EntityRef[] => {
    const subject = s.hovered ?? s.selection;
    if (subject) {
      const related = relatedRefs(s.log.sceneAt(s.playhead), subject);
      // The precise thing picked (a span selected through its ancestor) stays marked while nothing is hovered.
      const detail = s.hovered === null && s.selectionDetail !== null && s.selectionDetail !== s.selection ? (s.selectionDetail as EntityRef) : null;
      return detail && !related.includes(detail) ? [...related, detail] : related;
    }
    return s.interval ? s.interval.refs : [];
  };

  const set = (patch: Partial<SceneStoreState>): void => {
    let next: SceneStoreState = { ...state, ...patch };
    // Leaving the live edge marks what has arrived so far: "N new events" counts arrivals after it (D20).
    if (next.following !== state.following) next = { ...next, arrivedAtLeave: next.following || isSim ? null : next.arrived };
    if (!isSim && windows) next = route(next);
    if (patch.playhead !== undefined || patch.logVersion !== undefined || next.log !== state.log) next = { ...next, cursor: next.log.cursorAt(next.playhead) };
    const subjectChanged = next.hovered !== state.hovered || next.selection !== state.selection || next.selectionDetail !== state.selectionDetail || next.interval !== state.interval;
    if (subjectChanged || next.cursor !== state.cursor || next.logVersion !== state.logVersion) {
      const highlighted = highlightFor(next);
      const same = highlighted.length === state.highlighted.length && highlighted.every((r, i) => r === state.highlighted[i]);
      next = { ...next, highlighted: same ? state.highlighted : highlighted };
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /**
   * Which log holds the playhead: the store's own when it reaches it, else a loaded history window,
   * else the store's own (clamped) while the window is fetched. Never changes the playhead.
   */
  let wanted: number | null = null;
  const covers = (w: HistoryWindow, t: number): boolean => t >= w.from && t < w.to;
  const route = (next: SceneStoreState): SceneStoreState => {
    if (!windows) return next;
    const t = next.playhead;
    const ownStart = log.floorTime();
    const own = next.following || (ownStart !== null && t >= ownStart && source === "live") || (source === "replay" && ownStart !== null && t >= ownStart);
    let target: HistoryWindow | null = null;
    let loading = false;
    if (!own) {
      target = shown && covers(shown, t) ? shown : windows.peek(t);
      if (!target) {
        loading = true;
        if (wanted === null || !shown || !covers(shown, t)) requestWindow(t);
      }
    }
    if (!loading) wanted = null;
    // While a window loads, keep showing what was shown (it is labelled loading), never a wrong moment as settled.
    const nextShown = loading ? shown : target;
    if (nextShown !== shown) {
      shown = nextShown;
      version += 1;
    }
    const nextLog = currentLog();
    return { ...next, log: nextLog, logVersion: nextLog === next.log ? next.logVersion : version, windowLoading: loading };
  };
  const requestWindow = (t: number): void => {
    wanted = t;
    void windows?.load(t).then(
      (w) => {
        if (wanted === null || !covers(w, state.playhead)) return;
        wanted = null;
        set({});
      },
      () => {
        if (wanted === t) wanted = null;
        set({ windowLoading: false });
      },
    );
  };

  /**
   * Live: the edge now. With a wall clock: now (corrected), while the connection is connecting or
   * live. Without one: carried by the store's clock past the last confirmation, only while live.
   * Frozen otherwise (stale, reconnecting, disconnected, no session).
   */
  const liveEdgeNow = (now: number): number => {
    const head = log.headTime() ?? confirmed;
    const base = Math.max(confirmed, head);
    const conn = state.connection?.state;
    const wall = wallNow();
    if (wall !== null) return conn === "live" || conn === "connecting" ? Math.max(state.liveAt, base, wall) : Math.max(state.liveAt, base);
    if (conn !== "live") return Math.max(state.liveAt, base);
    return Math.max(state.liveAt, base, confirmed + Math.min(LIVE_EXTRAPOLATION_MS, Math.max(0, now - confirmedWall)));
  };

  // Playback runs while playing. A live store following the edge runs only while someone watches it
  // (a subscriber): a store made and dropped unwatched (React's development double render) holds no
  // frame loop, so none leaks.
  const loopWanted = (): boolean => state.playing || (source === "live" && state.following && listeners.size > 0);

  /**
   * The next wake-up of a live store following the edge: a frame while a motion is in progress (or
   * on a clock without waits); otherwise one wait until the clock label's next whole second (R7).
   */
  const scheduleIdle = (): void => {
    if (frame !== null || wait !== null) return;
    const edge = state.liveAt;
    if (edge < motionUntil || !clock.later) {
      frame = clock.request(onFrame);
      return;
    }
    // Just past the next whole second of the edge, so the label's second changes when it is shown.
    const delay = 1000 - (((edge % 1000) + 1000) % 1000) + 4;
    wait = clock.later((now) => {
      wait = null;
      onFrame(now);
    }, delay);
  };

  const onFrame = (now: number): void => {
    frame = null;
    if (!loopWanted()) return;
    const dt = Math.max(0, Math.min(250, now - lastFrameAt)); // a background tab must not leap
    lastFrameAt = now;
    if (isSim) {
      const advance = dt * rate * state.speed;
      const liveAt = Math.min(duration, Math.max(0, state.liveAt + advance));
      const playhead = state.following ? liveAt : Math.min(duration, Math.max(0, state.playhead + advance));
      const ended = state.following ? liveAt >= duration : playhead >= duration;
      set({ liveAt: Math.max(liveAt, playhead), playhead, playing: !ended, following: state.following || playhead >= liveAt });
      if (!ended) frame = clock.request(onFrame);
      return;
    }
    const liveAt = source === "live" ? liveEdgeNow(now) : edgeOf();
    if (state.following) {
      if (liveAt !== state.playhead || liveAt !== state.liveAt) set({ liveAt, playhead: liveAt });
    } else if (state.playing) {
      const playhead = Math.min(liveAt, state.playhead + dt * rate * state.speed);
      const reached = playhead >= liveAt;
      // A replay that reaches the edge re-attaches (live) or stops (replay: there is nothing after it).
      set({ liveAt, playhead, following: reached && source === "live", playing: !(reached && source === "replay") && state.playing });
    } else if (liveAt !== state.liveAt) set({ liveAt });
    if (!loopWanted()) return;
    // Playback moves every frame; following the live edge with nothing moving waits instead (R7).
    if (state.playing) frame = clock.request(onFrame);
    else scheduleIdle();
  };

  const startLoop = (): void => {
    if (frame !== null) return;
    if (wait !== null) {
      // Something to show now (playback, an arrival, a seek): wake at the next frame, not the next second.
      clock.cancelLater?.(wait);
      wait = null;
    }
    lastFrameAt = clock.now();
    frame = clock.request(onFrame);
  };
  const stopLoop = (): void => {
    if (frame !== null) clock.cancel(frame);
    frame = null;
    if (wait !== null) clock.cancelLater?.(wait);
    wait = null;
  };

  const seek = (t: number): void => {
    if (isSim) {
      const playhead = Math.min(duration, Math.max(0, t));
      const liveAt = Math.max(state.liveAt, playhead);
      set({ playhead, liveAt, following: playhead >= liveAt });
      return;
    }
    // Live and replay: never past the edge. There is no recorded future to seek into.
    const playhead = clamp(t, state.liveAt);
    set({ playhead, following: source === "live" && playhead >= state.liveAt });
    if (loopWanted()) startLoop();
  };

  const store: SceneStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (loopWanted()) startLoop();
      return () => {
        listeners.delete(listener);
        if (!loopWanted()) stopLoop();
      };
    },
    play() {
      if (state.playing) return;
      // Simulation at the end: play starts the replay again from the beginning.
      if (isSim && state.playhead >= duration) set({ playhead: 0, following: false });
      // Replay at its last event: start again from its first.
      if (source === "replay" && state.playhead >= state.liveAt) set({ playhead: floorT(), following: false });
      set({ playing: true });
      startLoop();
    },
    pause() {
      if (isSim || !(source === "live" && state.following)) stopLoop();
      if (state.playing) set({ playing: false });
    },
    toggle() {
      if (state.playing) store.pause();
      else store.play();
    },
    seek,
    seekToSeq(seq) {
      if (!isSim) return;
      const event = eventBySeq(fixture, seq);
      if (event) seek(event.t);
    },
    seekToEvent(id) {
      const entry = state.log.entry(id) ?? log.entry(id);
      if (entry) seek(entry.t);
    },
    seekToChapter(id) {
      const chapter: Chapter | undefined = chaptersOf(isSim ? fixture : log).find((c) => c.id === id);
      if (!chapter) return;
      seek(chapter.t);
      if (chapter.focus) store.focusOn(chapter.focus, "chapter");
    },
    stepNext() {
      store.pause();
      const t = nextEventTime(state.log, state.playhead) ?? (shown && shown.to !== Infinity ? nextEventTime(log, shown.to - 1) ?? shown.to : null);
      if (t !== null && (isSim || t <= state.liveAt)) seek(t);
    },
    stepPrevious() {
      store.pause();
      const t = previousEventTime(state.log, state.playhead) ?? (shown ? shown.from - 1 : windows && state.playhead > floorT() ? (log.floorTime() ?? state.playhead) - 1 : null);
      seek(t ?? floorT());
    },
    setSpeed(speed) {
      if (SPEEDS.includes(speed)) set({ speed });
    },
    followLive() {
      set({ following: true, playhead: state.liveAt, follow: true });
      if (loopWanted()) startLoop();
    },
    select(entity, opts) {
      set({ selection: entity, selectionDetail: entity && opts?.detail && opts.detail !== entity ? opts.detail : null });
      if (entity && opts?.focus !== false) store.focusOn(entity, "select");
    },
    focusOn(target, reason = "api") {
      nonce += 1;
      // Framing something the person asked for takes the camera off the live action.
      set({ focus: { target, reason, nonce }, ...(reason === "follow" ? {} : { follow: false }) });
    },
    hover(entity) {
      if (entity !== state.hovered) set({ hovered: entity });
    },
    setHighlightInterval(interval) {
      const cur = state.interval;
      if (interval === cur) return;
      const same =
        interval !== null &&
        cur !== null &&
        interval.from === cur.from &&
        interval.to === cur.to &&
        interval.refs.length === cur.refs.length &&
        interval.refs.every((r, i) => r === cur.refs[i]);
      if (!same) set({ interval });
    },
    setView(view) {
      if (view !== state.view) set({ view });
    },
    setWorkspace(workspace) {
      if (workspace === state.workspace || !WORKSPACES.includes(workspace)) return;
      set({ workspace, ...(workspace !== "floor" && state.theater ? { theater: false } : {}) });
    },
    setTimelineView(patch) {
      const current = state.timeline;
      const changed = (Object.keys(patch) as Array<keyof TimelineViewState>).some((k) => patch[k] !== undefined && patch[k] !== current[k]);
      if (!changed) return;
      const next: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
      set({ timeline: next as unknown as TimelineViewState });
    },
    setTheater(on) {
      if (on && state.workspace !== "floor") return;
      if (on !== state.theater) set({ theater: on });
    },
    setReducedMotion(on) {
      if (on !== state.reducedMotion) set({ reducedMotion: on });
    },
    setFollow(on) {
      if (on !== state.follow) set({ follow: on });
    },
    logChanged() {
      if (isSim) return;
      const arrived = log.size();
      if (arrived === state.arrived && log.version() === ownVersion) return;
      ownVersion = log.version();
      const head = log.headTime();
      if (head !== null && head > confirmed) {
        confirmed = head;
        confirmedWall = clock.now();
      }
      // An arrival may start a motion: frames until its window has passed, then waits again (R7).
      if (head !== null) motionUntil = Math.max(motionUntil, head + LIVE_MOTION_MS);
      const liveAt = Math.max(state.liveAt, edgeOf());
      // Selection, hover, view, camera intent and a replay's playhead are kept; a following playhead stays at the edge.
      const playhead = state.following ? liveAt : clamp(state.playhead, liveAt);
      // The shown log changed only when it is the store's own; a history window does not change with arrivals.
      if (!shown) version += 1;
      set({ logVersion: shown ? state.logVersion : version, arrived, liveAt, playhead, extent: extentNow(liveAt) });
      if (source === "live" && loopWanted() && liveAt < motionUntil) startLoop();
    },
    setLiveEdge(t) {
      if (source !== "live" || !(t > confirmed)) return;
      confirmed = t;
      confirmedWall = clock.now();
      const liveAt = Math.max(state.liveAt, t);
      set({ liveAt, playhead: state.following ? liveAt : state.playhead, extent: extentNow(liveAt) });
    },
    observeClock(observerNowMs) {
      if (!wallClock || !Number.isFinite(observerNowMs)) return;
      const offset = observerNowMs - wallClock();
      // Small differences are the request's own latency, not a clock difference.
      if (Math.abs(offset - clockOffset) > 250) clockOffset = offset;
    },
    setConnection(status) {
      if (source !== "live" || status === state.connection) return;
      // Back to live: carry the edge from now, not from when the stream went quiet.
      if (status.state === "live" && state.connection?.state !== "live") confirmedWall = clock.now() - Math.max(0, state.liveAt - confirmed);
      set({ connection: status });
      if (loopWanted()) startLoop();
    },
    setFactoryStatus(status) {
      if (source === "simulation" || status === state.factoryStatus) return;
      set({ factoryStatus: status });
    },
    setSeries(series) {
      if (source === "simulation" || series === state.series) return;
      set({ series });
    },
    dispose() {
      stopLoop();
      listeners.clear();
    },
  };
  if (windows) set({});
  if (options.autoplay) store.play();
  return store;
}

// ---------------------------------------------------------------- workspaces

/**
 * "Show in Timeline" (M6.3 design section 7), for the inspector's anatomies, the Atlas, the
 * Blueprint and key `3`: select `ref` when one is given (without moving the floor's camera), leave
 * Theater Mode, switch to the Timeline, and ask for the selection to be framed (the Timeline reveals
 * the store's focus request: it expands the selection's tracks, scrolls to them and pans to its span).
 * The playhead, playback and the floor's view are untouched.
 */
export function showInTimeline(store: SceneStore, ref?: EntityRef | null): void {
  if (ref && ref !== store.getState().selection) store.select(ref, { focus: false });
  store.setWorkspace("timeline");
  const selection = store.getState().selection;
  if (selection) store.focusOn(selection, "api");
}

/** "Show on the floor": back to the Factory Floor (keeping its view), framing the selection through the existing focusOn. */
export function showOnFloor(store: SceneStore, view?: ViewMode): void {
  if (view) store.setView(view);
  store.setWorkspace("floor");
  const selection = store.getState().selection;
  if (selection) store.focusOn(selection, "api");
}

/** A view of the store that can be held still: what a hidden workspace reads. */
export interface HeldStore extends SceneStore {
  /** Held: getState() keeps returning the state as of the moment it was held, and no listener is told of changes. Released: brought up to date at once, then follows every change. */
  hold(held: boolean): void;
  held(): boolean;
}

/**
 * The store as the Factory Floor sees it (a StoreView, view.ts). While held, a subtree reading it
 * renders nothing new and runs no effect a change would start (no camera framing, no drawing, no
 * catching up), so a hidden floor costs nothing while the Timeline is up, and is exactly where it was
 * when it returns.
 *
 * It holds itself (A3) in its own change handler whenever the store's workspace is not "floor", before
 * any listener is told: the change that switched workspaces (and a `focusOn` issued with it, as
 * "Show in Timeline" does) never reaches the hidden floor, whose views therefore never animate while
 * hidden. It is released, and caught up at once, by the change that brings the floor back, whichever
 * way it comes (the switch, a key, the address).
 */
export function heldStore(store: SceneStore): HeldStore {
  // Held by request (hold(true)), or by the store's workspace not being the floor's: either holds it.
  let asked = false;
  const away = (s: SceneStoreState) => s.workspace !== "floor";
  const view = storeView(store, {
    snapshotOnHide: true,
    decide: (s) => (asked || away(s) ? "hide" : "show"),
  });
  if (away(store.getState())) view.setShown(false);
  return {
    ...view,
    hold(held) {
      asked = held;
      view.setShown(!(held || away(store.getState())));
    },
    held: () => !view.shown(),
  };
}

// ---------------------------------------------------------------- the development and capture hook

/**
 * What window.__machSim offers. Version 1 members (seeking and reading) are unchanged; the rest
 * were added for the capture script to drive the app deterministically.
 */
export interface MachSimHook {
  readonly version: 1;
  readonly fixtureId: string;
  readonly duration: number;
  readonly eventCount: number;
  readonly chapters: ReadonlyArray<{ id: string; title: string; t: number; seq: number }>;
  seek(t: number): void;
  seekToSeq(seq: number): void;
  seekToChapter(id: string): void;
  step(count?: number): void;
  play(): void;
  pause(): void;
  setSpeed(speed: PlaybackSpeed): void;
  state(): MachSimHookState;
  // ---- driving the app (added in pass 2)
  select(entity: EntityRef | null): void;
  focus(target: EntityRef | "overview"): void;
  setMode(view: ViewMode): void;
  setTheater(on: boolean): void;
  setFollow(on: boolean): void;
  followLive(): void;
  /** The clock: "live" (browser frames), "manual" (only advance() moves time), or "fixed" (cannot be switched). */
  clockMode(): "live" | "manual" | "fixed";
  /** Switch to the manual clock: playback then moves only through advance(). */
  useManualClock(): void;
  /** Back to browser frames. */
  useLiveClock(): void;
  /**
   * Manual clock: move wall time on by exactly `ms`, in frames of at most `frameMs` (default 250).
   * While playing, factory time moves by ms x PLAYBACK_BASE_RATE x speed.
   */
  advance(ms: number, frameMs?: number): void;
}

export interface MachSimHookState {
  playhead: number;
  liveAt: number;
  following: boolean;
  playing: boolean;
  speed: number;
  cursor: number;
  view: ViewMode;
  theater: boolean;
  selection: EntityRef | null;
  follow: boolean;
  focus: EntityRef | "overview" | null;
  reducedMotion: boolean;
  clock: "live" | "manual" | "fixed";
}

/** Whether this build exposes window.__machSim: Vite development, or a build made with `--mode capture`. */
export function shouldExposeHook(): boolean {
  const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
  return Boolean(env && (env.DEV || env.MODE === "capture"));
}

/**
 * Install window.__machSim on `target`. Pass the store's clock when it is a SwitchableClock to get
 * the manual clock controls; without one, they report the clock as "fixed" and refuse.
 */
export function installMachSimHook(store: SceneStore, target: object = globalThis, clock?: SwitchableClock): () => void {
  // The hook describes a recorded fixture (duration, chapters, event count): simulation only.
  if (store.getState().source !== "simulation") throw new Error("window.__machSim drives the simulation only.");
  const fixture = store.getState().fixture;
  const needClock = (): SwitchableClock => {
    if (!clock) throw new Error("This store's clock cannot be switched to manual.");
    return clock;
  };
  const hook: MachSimHook = {
    version: 1,
    fixtureId: fixture.id,
    duration: fixture.duration,
    eventCount: fixture.events.length,
    chapters: fixture.chapters.map((c) => ({ id: c.id, title: c.title, t: c.t, seq: c.seq })),
    seek: (t) => store.seek(t),
    seekToSeq: (seq) => store.seekToSeq(seq),
    seekToChapter: (id) => store.seekToChapter(id),
    step(count = 1) {
      for (let i = 0; i < Math.abs(count); i++) (count < 0 ? store.stepPrevious : store.stepNext)();
    },
    play: () => store.play(),
    pause: () => store.pause(),
    setSpeed: (speed) => store.setSpeed(speed),
    state() {
      const s = store.getState();
      return {
        playhead: s.playhead,
        liveAt: s.liveAt,
        following: s.following,
        playing: s.playing,
        speed: s.speed,
        cursor: s.cursor,
        view: s.view,
        theater: s.theater,
        selection: s.selection,
        follow: s.follow,
        focus: s.focus?.target ?? null,
        reducedMotion: s.reducedMotion,
        clock: clock ? clock.mode : "fixed",
      };
    },
    select: (entity) => store.select(entity),
    focus: (target) => store.focusOn(target, "api"),
    setMode: (view) => store.setView(view),
    setTheater: (on) => store.setTheater(on),
    setFollow: (on) => store.setFollow(on),
    followLive: () => store.followLive(),
    clockMode: () => (clock ? clock.mode : "fixed"),
    useManualClock: () => needClock().manual(),
    useLiveClock: () => needClock().live(),
    advance: (ms, frameMs) => needClock().advance(ms, frameMs),
  };
  Object.defineProperty(target, "__machSim", { value: hook, configurable: true, enumerable: false, writable: false });
  return () => {
    delete (target as { __machSim?: unknown }).__machSim;
  };
}

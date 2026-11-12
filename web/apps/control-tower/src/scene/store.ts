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
 * - `live`: the observer's stream. `liveAt` is the live edge, set by what the stream confirmed
 *   (`setLiveEdge`) and carried forward by the browser's clock only while the connection is live and
 *   at most LIVE_EXTRAPOLATION_MS past the last confirmation; it never moves on its own when the
 *   connection is stale. Seeking clamps to it: nobody can seek into execution not yet observed.
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
import type { ConnectionStatus } from "./connection";
import { INITIAL_CONNECTION } from "./connection";

/** Factory milliseconds per wall millisecond at 1x: the 55-minute run plays in about 5.5 minutes. Simulation and replay playback only; live time runs at 1. */
export const PLAYBACK_BASE_RATE = 10;
export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type PlaybackSpeed = (typeof SPEEDS)[number];
export type ViewMode = "atlas" | "blueprint";
/** How far the live edge may run ahead of the last thing the stream confirmed (a heartbeat comes every 15 s). */
export const LIVE_EXTRAPOLATION_MS = 20_000;

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

export interface SceneStoreState {
  /** Where the scenes come from. Persistent: a store never changes source. */
  readonly source: SceneSource;
  /** The scene log every view reads scenes from (`log.sceneAt(playhead)`). */
  readonly log: SceneLog;
  /** Bumped when the log's events change (live ingest), for change detection. */
  readonly logVersion: number;
  /** How far the history reaches: the whole run (simulation) or so far (live, replay). */
  readonly extent: Extent;
  /** Live only: the connection, its staleness, lag and the supervisor's heartbeat. Null for simulation and replay. */
  readonly connection: ConnectionStatus | null;
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
  readonly focus: FocusRequest | null;
  readonly hovered: EntityRef | null;
  /** What to highlight with the hovered (or else the selected) entity: its dependency set or relations. */
  readonly highlighted: readonly EntityRef[];
  readonly view: ViewMode;
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
  select(entity: EntityRef | null, options?: { focus?: boolean }): void;
  focusOn(target: EntityRef | "overview", reason?: FocusRequest["reason"]): void;
  hover(entity: EntityRef | null): void;
  setView(view: ViewMode): void;
  setTheater(on: boolean): void;
  setReducedMotion(on: boolean): void;
  /** Camera follow on or off. A view calls setFollow(false) when the person pans or zooms. */
  setFollow(on: boolean): void;
  // ---- live: written by the live source only
  /** The log changed (events ingested). Recomputes cursor, extent and highlight; keeps selection, view, camera and playhead. */
  logChanged(): void;
  /** The stream confirmed history up to factory time `t` (an event or a heartbeat). Moves the live edge, never backwards. */
  setLiveEdge(t: number): void;
  setConnection(status: ConnectionStatus): void;
  dispose(): void;
}

interface CommonOptions {
  clock: Clock;
  reducedMotion?: boolean;
  speed?: PlaybackSpeed;
  view?: ViewMode;
  /** Start at this factory time (default: the start for the simulation, the live edge otherwise). */
  at?: number;
  autoplay?: boolean;
  /** Factory ms per wall ms at 1x for simulation and replay playback (default PLAYBACK_BASE_RATE). */
  rate?: number;
}
export interface SimulationStoreOptions extends CommonOptions {
  fixture: Fixture;
}
export interface LogStoreOptions extends CommonOptions {
  source: "live" | "replay";
  log: SceneLog;
}
export type SceneStoreOptions = SimulationStoreOptions | LogStoreOptions;

export function createSceneStore(options: SceneStoreOptions): SceneStore {
  const { clock } = options;
  const isSim = "fixture" in options;
  const source: SceneSource = isSim ? "simulation" : options.source;
  const fixture = isSim ? options.fixture : NO_FIXTURE;
  const log = isSim ? fixtureLog(options.fixture) : options.log;
  const rate = options.rate ?? PLAYBACK_BASE_RATE;
  const duration = fixture.duration;

  // Live: what the stream last confirmed, and when (wall time) it did.
  let confirmed = log.headTime() ?? 0;
  let confirmedWall = clock.now();

  const floorT = (): number => (isSim ? 0 : (log.floorTime() ?? confirmed));
  const edgeOf = (): number => (isSim ? duration : source === "replay" ? (log.headTime() ?? 0) : Math.max(confirmed, log.headTime() ?? confirmed));
  const clamp = (t: number, edge: number): number => Math.min(edge, Math.max(floorT(), t));
  const startEdge = edgeOf();
  const start = isSim ? Math.min(duration, Math.max(0, options.at ?? 0)) : clamp(options.at ?? startEdge, startEdge);

  let state: SceneStoreState = {
    source,
    log,
    logVersion: log.version(),
    extent: extentOf(isSim ? fixture : log, isSim ? undefined : startEdge),
    connection: source === "live" ? INITIAL_CONNECTION : null,
    fixture,
    playhead: start,
    liveAt: isSim ? start : startEdge,
    following: isSim ? true : start >= startEdge,
    playing: false,
    speed: options.speed ?? 1,
    cursor: log.cursorAt(start),
    selection: null,
    focus: null,
    hovered: null,
    highlighted: [],
    view: options.view ?? "atlas",
    theater: false,
    reducedMotion: options.reducedMotion ?? false,
    follow: true,
  };
  const listeners = new Set<() => void>();
  let frame: number | null = null;
  let lastFrameAt = 0;
  let nonce = 0;

  const highlightFor = (s: SceneStoreState): readonly EntityRef[] => {
    const subject = s.hovered ?? s.selection;
    return subject ? relatedRefs(log.sceneAt(s.playhead), subject) : [];
  };

  const set = (patch: Partial<SceneStoreState>): void => {
    let next: SceneStoreState = { ...state, ...patch };
    if (patch.playhead !== undefined || patch.logVersion !== undefined) next = { ...next, cursor: log.cursorAt(next.playhead) };
    const subjectChanged = next.hovered !== state.hovered || next.selection !== state.selection;
    if (subjectChanged || next.cursor !== state.cursor || next.logVersion !== state.logVersion) {
      const highlighted = highlightFor(next);
      const same = highlighted.length === state.highlighted.length && highlighted.every((r, i) => r === state.highlighted[i]);
      next = { ...next, highlighted: same ? state.highlighted : highlighted };
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** Live: the edge now, carried by the browser's clock only while the connection is live. */
  const liveEdgeNow = (now: number): number => {
    const head = log.headTime() ?? confirmed;
    const base = Math.max(confirmed, head);
    if (state.connection?.state !== "live") return Math.max(state.liveAt, base);
    return Math.max(state.liveAt, base, confirmed + Math.min(LIVE_EXTRAPOLATION_MS, Math.max(0, now - confirmedWall)));
  };

  const loopWanted = (): boolean => state.playing || (source === "live" && state.following);

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
    if (loopWanted()) frame = clock.request(onFrame);
  };

  const startLoop = (): void => {
    if (frame !== null) return;
    lastFrameAt = clock.now();
    frame = clock.request(onFrame);
  };
  const stopLoop = (): void => {
    if (frame !== null) clock.cancel(frame);
    frame = null;
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
      return () => listeners.delete(listener);
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
      const entry = log.entry(id);
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
      const t = nextEventTime(log, state.playhead);
      if (t !== null && (isSim || t <= state.liveAt)) seek(t);
    },
    stepPrevious() {
      store.pause();
      const t = previousEventTime(log, state.playhead);
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
      set({ selection: entity });
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
    setView(view) {
      if (view !== state.view) set({ view });
    },
    setTheater(on) {
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
      const version = log.version();
      if (version === state.logVersion) return;
      const head = log.headTime();
      if (head !== null && head > confirmed) {
        confirmed = head;
        confirmedWall = clock.now();
      }
      const liveAt = Math.max(state.liveAt, edgeOf());
      // Selection, hover, view, camera intent and a replay's playhead are kept; a following playhead stays at the edge.
      const playhead = state.following ? liveAt : clamp(state.playhead, liveAt);
      set({ logVersion: version, liveAt, playhead, extent: extentOf(log, liveAt) });
    },
    setLiveEdge(t) {
      if (source !== "live" || !(t > confirmed)) return;
      confirmed = t;
      confirmedWall = clock.now();
      const liveAt = Math.max(state.liveAt, t);
      set({ liveAt, playhead: state.following ? liveAt : state.playhead, extent: extentOf(log, liveAt) });
    },
    setConnection(status) {
      if (source !== "live" || status === state.connection) return;
      // Back to live: carry the edge from now, not from when the stream went quiet.
      if (status.state === "live" && state.connection?.state !== "live") confirmedWall = clock.now() - Math.max(0, state.liveAt - confirmed);
      set({ connection: status });
      if (loopWanted()) startLoop();
    },
    dispose() {
      stopLoop();
      listeners.clear();
    },
  };
  if (options.autoplay) store.play();
  else if (source === "live" && state.following) startLoop();
  return store;
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

/**
 * The one store: the playback clock, selection, focus target, hover highlight, view mode and
 * Theater Mode. Every view subscribes to it (see react.ts); none keeps time or selection of its own.
 *
 * It holds no factory state. What the factory looks like at the playhead is sceneAt(fixture,
 * playhead), computed by whoever needs it.
 */
import type { Chapter, EntityRef, Fixture } from "../sim/model";
import { cursorAt } from "../sim/engine";
import { eventBySeq, nextEventTime, previousEventTime, relatedRefs } from "../sim/selectors";
import { sceneAt } from "../sim/engine";
import type { Clock, SwitchableClock } from "./clock";

/** Factory milliseconds per wall millisecond at 1x: the 55-minute run plays in about 5.5 minutes. */
export const PLAYBACK_BASE_RATE = 10;
export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type PlaybackSpeed = (typeof SPEEDS)[number];
export type ViewMode = "atlas" | "blueprint";

/** A request for the camera, honoured by both views. `nonce` changes on every request, so asking twice re-frames. */
export interface FocusRequest {
  readonly target: EntityRef | "overview";
  readonly reason: "select" | "chapter" | "follow" | "api";
  readonly nonce: number;
}

export interface SceneStoreState {
  readonly fixture: Fixture;
  /** Factory time shown, in ms from the scenario start. */
  readonly playhead: number;
  /** The simulated "now": how far the factory has run. The playhead never trails it while following. */
  readonly liveAt: number;
  /** Live-follow: the playhead is pinned to liveAt. Off while replaying an earlier moment. */
  readonly following: boolean;
  readonly playing: boolean;
  readonly speed: PlaybackSpeed;
  /** Events applied at the playhead (sceneAt(...).cursor), for cheap change detection. */
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

export interface SceneStore {
  getState(): SceneStoreState;
  subscribe(listener: () => void): () => void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  seekToSeq(seq: number): void;
  seekToChapter(id: string): void;
  /** One event forward or back (all events sharing a time move together); pauses playback. */
  stepNext(): void;
  stepPrevious(): void;
  setSpeed(speed: PlaybackSpeed): void;
  /** Jump to the simulated now and stay pinned to it. */
  followLive(): void;
  select(entity: EntityRef | null, options?: { focus?: boolean }): void;
  focusOn(target: EntityRef | "overview", reason?: FocusRequest["reason"]): void;
  hover(entity: EntityRef | null): void;
  setView(view: ViewMode): void;
  setTheater(on: boolean): void;
  setReducedMotion(on: boolean): void;
  /** Camera follow on or off. A view calls setFollow(false) when the person pans or zooms. */
  setFollow(on: boolean): void;
  dispose(): void;
}

export interface SceneStoreOptions {
  fixture: Fixture;
  clock: Clock;
  reducedMotion?: boolean;
  speed?: PlaybackSpeed;
  view?: ViewMode;
  /** Start at this factory time (default 0). */
  at?: number;
  autoplay?: boolean;
  /** Factory ms per wall ms at 1x (default PLAYBACK_BASE_RATE). */
  rate?: number;
}

export function createSceneStore(options: SceneStoreOptions): SceneStore {
  const { fixture, clock } = options;
  const rate = options.rate ?? PLAYBACK_BASE_RATE;
  const duration = fixture.duration;
  const clamp = (t: number): number => Math.min(duration, Math.max(0, t));
  const start = clamp(options.at ?? 0);
  let state: SceneStoreState = {
    fixture,
    playhead: start,
    liveAt: start,
    following: true,
    playing: false,
    speed: options.speed ?? 1,
    cursor: cursorAt(fixture, start),
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
    return subject ? relatedRefs(sceneAt(fixture, s.playhead), subject) : [];
  };

  const set = (patch: Partial<SceneStoreState>): void => {
    let next: SceneStoreState = { ...state, ...patch };
    if (patch.playhead !== undefined) next = { ...next, cursor: cursorAt(fixture, next.playhead) };
    const subjectChanged = next.hovered !== state.hovered || next.selection !== state.selection;
    if (subjectChanged || next.cursor !== state.cursor) {
      const highlighted = highlightFor(next);
      const same = highlighted.length === state.highlighted.length && highlighted.every((r, i) => r === state.highlighted[i]);
      next = { ...next, highlighted: same ? state.highlighted : highlighted };
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const onFrame = (now: number): void => {
    frame = null;
    if (!state.playing) return;
    const dt = Math.max(0, Math.min(250, now - lastFrameAt)); // a background tab must not leap
    lastFrameAt = now;
    const advance = dt * rate * state.speed;
    const liveAt = clamp(state.liveAt + advance);
    const playhead = state.following ? liveAt : clamp(state.playhead + advance);
    const ended = state.following ? liveAt >= duration : playhead >= duration;
    set({ liveAt: Math.max(liveAt, playhead), playhead, playing: !ended, following: state.following || playhead >= liveAt });
    if (!ended) frame = clock.request(onFrame);
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
    const playhead = clamp(t);
    const liveAt = Math.max(state.liveAt, playhead);
    set({ playhead, liveAt, following: playhead >= liveAt });
  };

  const store: SceneStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play() {
      if (state.playing) return;
      // At the end, play starts the replay again from the beginning.
      if (state.playhead >= duration) set({ playhead: 0, following: false });
      set({ playing: true });
      startLoop();
    },
    pause() {
      stopLoop();
      if (state.playing) set({ playing: false });
    },
    toggle() {
      if (state.playing) store.pause();
      else store.play();
    },
    seek,
    seekToSeq(seq) {
      const event = eventBySeq(fixture, seq);
      if (event) seek(event.t);
    },
    seekToChapter(id) {
      const chapter: Chapter | undefined = fixture.chapters.find((c) => c.id === id);
      if (!chapter) return;
      seek(chapter.t);
      if (chapter.focus) store.focusOn(chapter.focus, "chapter");
    },
    stepNext() {
      store.pause();
      const t = nextEventTime(fixture, state.playhead);
      if (t !== null) seek(t);
    },
    stepPrevious() {
      store.pause();
      const t = previousEventTime(fixture, state.playhead);
      seek(t ?? 0);
    },
    setSpeed(speed) {
      if (SPEEDS.includes(speed)) set({ speed });
    },
    followLive() {
      set({ following: true, playhead: state.liveAt, follow: true });
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
    dispose() {
      stopLoop();
      listeners.clear();
    },
  };
  if (options.autoplay) store.play();
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

/**
 * The one store: what the Factory looks like now, the selection, focus target, hover highlight, the
 * workspace on screen and Theater Mode, for both sources of a scene. Every view subscribes to it (see
 * react.ts); none keeps time or selection of its own.
 *
 * It holds no factory state of its own. What the factory looks like is `state.log.sceneAt(state.now)`:
 * the scene log (src/sim/log.ts) of the store's source, at the latest moment the store has reached.
 * The Factory Floor shows only the present: there is no playhead, no pause and no going back.
 *
 * Sources (`state.source`, fixed for the store's life, stamped on every scene as `scene.provenance`):
 * - `simulation`: the M6.0 fixture, run forward on its own at PLAYBACK_BASE_RATE (55 minutes of
 *   scenario in about 5.5) while someone watches it, and held at its last moment when it ends.
 * - `live`: the observer's stream. `now` is the live edge. With a wall clock (`wallClock`, the
 *   browser's; corrected by the observer's own clock when it says one, `observeClock`) it is the wall
 *   clock while the connection is connecting or live, and never before what the stream confirmed (R7).
 *   Without one (tests), it is set by what the stream confirmed (`setLiveEdge`) and carried forward by
 *   the store's clock at most LIVE_EXTRAPOLATION_MS past the last confirmation. Either way it never
 *   moves on its own when the connection is stale or lost. While nothing moves, the loop asks for no
 *   frames: it wakes once a second for the clock label (and at once when an event arrives); it runs
 *   every frame only while a motion is in progress.
 */
import type { EntityRef, Fixture } from "../sim/model";
import type { Extent } from "../sim/selectors";
import { extentOf, relatedRefs } from "../sim/selectors";
import { fixtureLog } from "../sim/engine";
import type { SceneLog } from "../sim/log";
import type { SceneSource } from "../sim/provenance";
import type { Clock, SwitchableClock } from "./clock";
import type { ConnectionStatus, FactoryStatus } from "./connection";
import { INITIAL_CONNECTION } from "./connection";
import { applyAnalyticsPatch, INITIAL_ANALYTICS_VIEW, NO_ANALYTICS_FILTERS, type AnalyticsArea, type AnalyticsFilters, type AnalyticsFocus, type AnalyticsPick, type AnalyticsViewPatch, type AnalyticsViewState, type AnalyticsWindow } from "./analytics";
import { storeView } from "./view";
import { EVIDENCE_CHECK, EVIDENCE_TICKET } from "../evidence/ids";

/** Scenario milliseconds per wall millisecond: the simulation's 55-minute run plays in about 5.5 minutes. */
export const PLAYBACK_BASE_RATE = 10;
/**
 * The workspace on screen: the Line (the default: stations as columns, tickets as rows), the Floor
 * (the isometric Factory Atlas), or Factory Analytics.
 */
export type Workspace = "line" | "floor" | "analytics";
export const WORKSPACES: readonly Workspace[] = ["line", "floor", "analytics"];
/** How far the live edge may run ahead of the last thing the stream confirmed (a heartbeat comes every 15 s). */
export const LIVE_EXTRAPOLATION_MS = 20_000;
/**
 * How long after an event's time its motion can still be in progress at the live edge (time scale
 * 1): the longest event window the views animate (the Atlas's `slice.materialized`, 1,900 ms) with
 * margin. Past it, the loop stops asking for frames until the next event or clock tick.
 */
export const LIVE_MOTION_MS = 2_500;

/**
 * Compatibility only: the `fixture` a live store reports, so views that still read `state.fixture`
 * compile and draw nothing from it.
 */
export const NO_FIXTURE: Fixture = Object.freeze({
  id: "no-fixture",
  title: "No fixture (live)",
  startAt: "1970-01-01T00:00:00Z",
  duration: 0,
  events: [],
  definitions: { project: { id: "", name: "", integrationBranch: "" }, epics: {}, slices: {} },
  chapters: [],
});

/**
 * The evidence player (M6.4), open over the workspace for one ticket. The address carries only the
 * ticket and the check (both identifiers); `start` says which file to begin at and is kept in memory
 * only, never written to the address, storage or a title (a scene artifact id holds its path).
 */
export interface EvidenceOpen {
  readonly ticket: string;
  readonly check: string | null;
  readonly start: { readonly artifactId?: string | null; readonly sceneArtifactId?: string | null; readonly path?: string | null } | null;
}

/** A request for the camera, honoured by the Floor's Atlas. `nonce` changes on every request, so asking twice re-frames. */
export interface FocusRequest {
  readonly target: EntityRef | "overview";
  readonly reason: "select" | "follow" | "api";
  readonly nonce: number;
}

export interface SceneStoreState {
  /** Where the scenes come from. Persistent: a store never changes source. */
  readonly source: SceneSource;
  /** The scene log every view reads scenes from (`log.sceneAt(now)`). */
  readonly log: SceneLog;
  /** Bumped whenever the log's events change, for change detection. */
  readonly logVersion: number;
  /** How far the history reaches: the whole run (simulation) or so far (live). */
  readonly extent: Extent;
  /** Live only: the connection, its staleness, lag and the supervisor's heartbeat. Null for the simulation. */
  readonly connection: ConnectionStatus | null;
  /**
   * Live: the Factory's state on this machine as the observer last read it (`/api/v1/factory/status`):
   * whether there is Factory state at all, enabled, paused, the supervisor's heartbeat, per-source lag.
   * Null until read, and always for the simulation.
   */
  readonly factoryStatus: FactoryStatus | null;
  /** Simulation: the fixture. Live: NO_FIXTURE (compatibility; read `log`). */
  readonly fixture: Fixture;
  /** The moment shown: the simulation's scenario ms, or the live edge in Unix ms. Only ever moves forward. */
  readonly now: number;
  /** Events applied at `now` (log.cursorAt(now)), for cheap change detection. */
  readonly cursor: number;
  readonly selection: EntityRef | null;
  readonly focus: FocusRequest | null;
  readonly hovered: EntityRef | null;
  /** What to highlight: the hovered (or else the selected) entity's dependency set or relations. */
  readonly highlighted: readonly EntityRef[];
  /** Line, Floor or Analytics. */
  readonly workspace: Workspace;
  /**
   * Factory Analytics' interface state (area, period, shared filters, comparison, the metric whose rows
   * are open), kept here so it survives a workspace switch. Interface state only.
   */
  readonly analytics: AnalyticsViewState;
  /** Theater Mode: the Floor only; always off while another workspace is up. */
  readonly theater: boolean;
  /** The evidence player, when open (M6.4): one ticket, and the check it shows. Interface state only. */
  readonly evidence: EvidenceOpen | null;
  readonly reducedMotion: boolean;
  /**
   * Camera follow, for the Floor's Atlas. On by default. Off as soon as the person pans or zooms (the
   * view calls setFollow(false)) or asks the camera to frame something (focusOn with any reason but
   * "follow"); back on with setFollow(true).
   */
  readonly follow: boolean;
}

/**
 * The one time scale for motion, in factory ms per wall ms: 1 for the live Factory (real time), the
 * simulation's own rate for the simulation. A motion written as `d` wall ms lasts `d x timeScaleOf`
 * factory ms, so on screen it lasts `d` in either source.
 */
export function timeScaleOf(state: Pick<SceneStoreState, "source">): number {
  return state.source === "simulation" ? PLAYBACK_BASE_RATE : 1;
}

/** The connection states in the words the top bar's connection badge uses (shell/notices.ts `connectionLook`), lower case. */
const CONNECTION_WORDS: Readonly<Record<string, string>> = { connecting: "connecting", stale: "stale", reconnecting: "reconnecting", disconnected: "disconnected", "no-session": "no session" };

/**
 * The source in the words the top bar uses: "Simulation" or "Live Factory"; a live link that is not
 * live says so in brackets ("Live Factory (stale)", "(no session)").
 */
export function sourceLabel(state: Pick<SceneStoreState, "source" | "connection">): string {
  if (state.source === "simulation") return "Simulation";
  const conn = state.connection;
  return `Live Factory${conn && conn.state !== "live" ? ` (${CONNECTION_WORDS[conn.state] ?? conn.state})` : ""}`;
}

export interface SceneStore {
  getState(): SceneStoreState;
  subscribe(listener: () => void): () => void;
  select(entity: EntityRef | null, options?: { focus?: boolean }): void;
  focusOn(target: EntityRef | "overview", reason?: FocusRequest["reason"]): void;
  hover(entity: EntityRef | null): void;
  /** Switch the workspace. Selection and hover are kept; Theater Mode ends on leaving the Floor. */
  setWorkspace(workspace: Workspace): void;
  /** Merge a change into Analytics' interface state (analytics.ts `applyAnalyticsPatch`: invalid members ignored). No change, no new state. */
  setAnalyticsView(patch: AnalyticsViewPatch): void;
  /** Theater Mode on or off. Asking for it while another workspace is up does nothing: it belongs to the Floor. */
  setTheater(on: boolean): void;
  /** Open the evidence player for a ticket (M6.4), at a check and, in memory only, a file. An id that is not an identifier is refused. */
  openEvidence(ticket: string, options?: { readonly check?: string | null; readonly start?: EvidenceOpen["start"] }): void;
  /** The check the open player shows (written to the address); nothing when the player is closed or the id is not an identifier. */
  setEvidenceCheck(check: string | null): void;
  closeEvidence(): void;
  setReducedMotion(on: boolean): void;
  /** Camera follow on or off. A view calls setFollow(false) when the person pans or zooms. */
  setFollow(on: boolean): void;
  // ---- live: written by the live source only
  /** The log changed (events ingested). Recomputes cursor, extent and highlight; keeps selection, view and camera. */
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
  /** The Factory's state on this machine, as the observer last read it. */
  setFactoryStatus(status: FactoryStatus | null): void;
  dispose(): void;
}

interface CommonOptions {
  clock: Clock;
  reducedMotion?: boolean;
  workspace?: Workspace;
  /** Live only: the wall clock (Unix ms; the browser passes Date.now). The live edge is then now from the first frame (R7). */
  wallClock?: () => number;
}
export interface SimulationStoreOptions extends CommonOptions {
  fixture: Fixture;
  /** Where the simulation starts (scenario ms; default its beginning). Tests and the capture hook use it. */
  at?: number;
  /** Scenario ms per wall ms (default PLAYBACK_BASE_RATE). */
  rate?: number;
}
export interface LogStoreOptions extends CommonOptions {
  source: "live";
  log: SceneLog;
}
export type SceneStoreOptions = SimulationStoreOptions | LogStoreOptions;

export function createSceneStore(options: SceneStoreOptions): SceneStore {
  const { clock } = options;
  const isSim = "fixture" in options;
  const source: SceneSource = isSim ? "simulation" : "live";
  const fixture = isSim ? options.fixture : NO_FIXTURE;
  const log = isSim ? fixtureLog(options.fixture) : options.log;
  const rate = isSim ? (options.rate ?? PLAYBACK_BASE_RATE) : 1;
  const duration = fixture.duration;
  let version = 0;

  // Live: what the stream last confirmed, and when (wall time) it did.
  let confirmed = log.headTime() ?? 0;
  let confirmedWall = clock.now();
  // Live with a wall clock: now, corrected by the observer's clock when it said one.
  const wallClock = isSim ? undefined : options.wallClock;
  let clockOffset = 0;
  const wallNow = (): number | null => (wallClock ? wallClock() + clockOffset : null);
  // Until when (live edge ms) a motion may be in progress: frames are asked for until then.
  let motionUntil = Number.NEGATIVE_INFINITY;

  /**
   * Live with nothing received yet: where the history the page can show begins, fixed once known (when
   * the page opened, with a wall clock; else the first confirmed edge). Never the last confirmation:
   * that would move the extent's start at every heartbeat.
   */
  let emptyFloor: number | null = null;
  const extentNow = (now: number): Extent => {
    if (isSim) return extentOf(fixture);
    const own = extentOf(log, now);
    return log.floorTime() === null ? { ...own, start: emptyFloor ?? confirmed } : own;
  };
  const edgeOf = (): number => Math.max(confirmed, log.headTime() ?? confirmed);
  const startNow = isSim ? Math.min(duration, Math.max(0, options.at ?? 0)) : Math.max(edgeOf(), wallNow() ?? Number.NEGATIVE_INFINITY);
  if (!isSim && wallClock) emptyFloor = startNow;

  let state: SceneStoreState = {
    source,
    log,
    logVersion: 0,
    extent: extentNow(startNow),
    connection: isSim ? null : INITIAL_CONNECTION,
    factoryStatus: null,
    fixture,
    now: startNow,
    cursor: log.cursorAt(startNow),
    selection: null,
    focus: null,
    hovered: null,
    highlighted: [],
    workspace: options.workspace ?? "line",
    analytics: INITIAL_ANALYTICS_VIEW,
    theater: false,
    evidence: null,
    reducedMotion: options.reducedMotion ?? false,
    follow: true,
  };
  const listeners = new Set<() => void>();
  let frame: number | null = null;
  /** A wait (no frames) while nothing moves at the live edge. */
  let wait: number | null = null;
  let lastFrameAt = 0;
  let nonce = 0;

  const highlightFor = (s: SceneStoreState): readonly EntityRef[] => {
    const subject = s.hovered ?? s.selection;
    return subject ? relatedRefs(s.log.sceneAt(s.now), subject) : [];
  };

  const set = (patch: Partial<SceneStoreState>): void => {
    let next: SceneStoreState = { ...state, ...patch };
    if (patch.now !== undefined || patch.logVersion !== undefined) next = { ...next, cursor: next.log.cursorAt(next.now) };
    const subjectChanged = next.hovered !== state.hovered || next.selection !== state.selection;
    if (subjectChanged || next.cursor !== state.cursor || next.logVersion !== state.logVersion) {
      const highlighted = highlightFor(next);
      const same = highlighted.length === state.highlighted.length && highlighted.every((r, i) => r === state.highlighted[i]);
      next = { ...next, highlighted: same ? state.highlighted : highlighted };
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /**
   * Live: the edge now. With a wall clock: now (corrected), while the connection is connecting or
   * live. Without one: carried by the store's clock past the last confirmation, only while live.
   * Frozen otherwise (stale, reconnecting, disconnected, no session).
   */
  const liveEdgeNow = (wall: number): number => {
    const base = edgeOf();
    const conn = state.connection?.state;
    const w = wallNow();
    if (w !== null) return conn === "live" || conn === "connecting" ? Math.max(state.now, base, w) : Math.max(state.now, base);
    if (conn !== "live") return Math.max(state.now, base);
    return Math.max(state.now, base, confirmed + Math.min(LIVE_EXTRAPOLATION_MS, Math.max(0, wall - confirmedWall)));
  };

  // The loop runs only while someone watches (a subscriber), and for the simulation only until its end:
  // a store made and dropped unwatched (React's development double render) holds no frame loop.
  const loopWanted = (): boolean => listeners.size > 0 && (!isSim || state.now < duration);

  /**
   * The next wake-up: every frame for the simulation and while a live motion is in progress (or on a
   * clock without waits); otherwise one wait until the clock label's next whole second (R7).
   */
  const schedule = (): void => {
    if (frame !== null || wait !== null) return;
    const edge = state.now;
    if (isSim || edge < motionUntil || !clock.later) {
      frame = clock.request(onFrame);
      return;
    }
    // Just past the next whole second of the edge, so the label's second changes when it is shown.
    const delay = 1000 - (((edge % 1000) + 1000) % 1000) + 4;
    wait = clock.later((wall) => {
      wait = null;
      onFrame(wall);
    }, delay);
  };

  const onFrame = (wall: number): void => {
    frame = null;
    if (!loopWanted()) return;
    const dt = Math.max(0, Math.min(250, wall - lastFrameAt)); // a background tab must not leap
    lastFrameAt = wall;
    const now = isSim ? Math.min(duration, state.now + dt * rate) : liveEdgeNow(wall);
    if (now !== state.now) set(isSim ? { now } : { now, extent: extentNow(now) });
    if (loopWanted()) schedule();
  };

  const startLoop = (): void => {
    if (frame !== null) return;
    if (wait !== null) {
      // Something to show now (an arrival, a change of connection): wake at the next frame, not the next second.
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
    setWorkspace(workspace) {
      if (workspace === state.workspace || !WORKSPACES.includes(workspace)) return;
      set({ workspace, ...(workspace !== "floor" && state.theater ? { theater: false } : {}) });
    },
    setAnalyticsView(patch) {
      const next = applyAnalyticsPatch(state.analytics, patch);
      if (next !== state.analytics) set({ analytics: next });
    },
    setTheater(on) {
      if (on && state.workspace !== "floor") return;
      if (on !== state.theater) set({ theater: on });
    },
    openEvidence(ticket, opts = {}) {
      if (!EVIDENCE_TICKET.test(ticket)) return;
      const check = opts.check && EVIDENCE_CHECK.test(opts.check) ? opts.check : null;
      set({ evidence: { ticket, check, start: opts.start ?? null } });
    },
    setEvidenceCheck(check) {
      const cur = state.evidence;
      if (!cur) return;
      const next = check && EVIDENCE_CHECK.test(check) ? check : null;
      if (next !== cur.check) set({ evidence: { ...cur, check: next } });
    },
    closeEvidence() {
      if (state.evidence) set({ evidence: null });
    },
    setReducedMotion(on) {
      if (on !== state.reducedMotion) set({ reducedMotion: on });
    },
    setFollow(on) {
      if (on !== state.follow) set({ follow: on });
    },
    logChanged() {
      if (isSim) return;
      const head = log.headTime();
      if (head !== null && head > confirmed) {
        confirmed = head;
        confirmedWall = clock.now();
      }
      // An arrival may start a motion: frames until its window has passed, then waits again (R7).
      if (head !== null) motionUntil = Math.max(motionUntil, head + LIVE_MOTION_MS);
      const now = Math.max(state.now, edgeOf());
      version += 1;
      set({ logVersion: version, now, extent: extentNow(now) });
      if (loopWanted() && now < motionUntil) startLoop();
    },
    setLiveEdge(t) {
      if (isSim || !(t > confirmed)) return;
      confirmed = t;
      emptyFloor ??= t;
      confirmedWall = clock.now();
      const now = Math.max(state.now, t);
      set({ now, extent: extentNow(now) });
    },
    observeClock(observerNowMs) {
      if (!wallClock || !Number.isFinite(observerNowMs)) return;
      const offset = observerNowMs - wallClock();
      // Small differences are the request's own latency, not a clock difference.
      if (Math.abs(offset - clockOffset) > 250) clockOffset = offset;
    },
    setConnection(status) {
      if (isSim || status === state.connection) return;
      // Back to live: carry the edge from now, not from when the stream went quiet.
      if (status.state === "live" && state.connection?.state !== "live") confirmedWall = clock.now() - Math.max(0, state.now - confirmed);
      set({ connection: status });
      if (loopWanted()) startLoop();
    },
    setFactoryStatus(status) {
      if (isSim || status === state.factoryStatus) return;
      set({ factoryStatus: status });
    },
    dispose() {
      stopLoop();
      listeners.clear();
    },
  };
  if (isSim)
    simulationMoments.set(store, (t) => {
      const now = Math.min(duration, Math.max(0, t));
      if (now === state.now) return;
      set({ now });
      if (loopWanted()) startLoop();
    });
  return store;
}

/**
 * The simulation's moment, settable by the development and capture hook only (installMachSimHook):
 * no part of the interface can move it.
 */
const simulationMoments = new WeakMap<SceneStore, (t: number) => void>();

// ---------------------------------------------------------------- workspaces

/** "Show on the Line": select `ref` when one is given and switch to the Line, where its row is marked. */
export function showOnLine(store: SceneStore, ref?: EntityRef | null): void {
  if (ref && ref !== store.getState().selection) store.select(ref, { focus: false });
  store.setWorkspace("line");
}

/**
 * "Show on the Floor": to the Floor, framing the selection through the existing focusOn. With `ref`,
 * that entity is selected first (an Analytics row opening its entity on the Floor).
 */
export function showOnFloor(store: SceneStore, options?: { readonly ref?: EntityRef | null }): void {
  const ref = options?.ref;
  if (ref && ref !== store.getState().selection) store.select(ref, { focus: false });
  store.setWorkspace("floor");
  const selection = store.getState().selection;
  if (selection) store.focusOn(selection, "api");
}

/** Where "Show in Analytics" lands. Omitted members: `filters` keeps the current filters, `focus` closes the rows panel, `pick` clears the cross-filter, `window` keeps the period. */
export interface AnalyticsTarget {
  readonly area: AnalyticsArea;
  /** Replaces every shared filter: members left out are cleared, so the area shows exactly what the link said. */
  readonly filters?: Partial<AnalyticsFilters>;
  readonly focus?: AnalyticsFocus | null;
  /** A cross-filter inside the area; left out: none. */
  readonly pick?: AnalyticsPick | null;
  readonly window?: AnalyticsWindow;
}

/**
 * "Show in Analytics" (M6.5 design section 4), for key `3`, the workspace switch and the inspector's
 * links: set Analytics' interface state when a target is given, leave Theater Mode, and switch to
 * Analytics. Selection, hover and the camera's focus are untouched: Analytics reads the selection.
 */
export function showInAnalytics(store: SceneStore, target?: AnalyticsTarget | null): void {
  if (target) {
    store.setAnalyticsView({
      area: target.area,
      ...(target.filters ? { filters: { ...NO_ANALYTICS_FILTERS, ...target.filters } } : {}),
      focus: target.focus ?? null,
      pick: target.pick ?? null,
      ...(target.window !== undefined ? { window: target.window } : {}),
    });
  }
  store.setWorkspace("analytics");
}

/** A view of the store that can be held still: what a hidden workspace reads. */
export interface HeldStore extends SceneStore {
  /** Held: getState() keeps returning the state as of the moment it was held, and no listener is told of changes. Released: brought up to date at once, then follows every change. */
  hold(held: boolean): void;
  held(): boolean;
}

/**
 * The store as the Floor sees it (a StoreView, view.ts). While held, a subtree reading it renders
 * nothing new and runs no effect a change would start (no camera framing, no drawing, no catching up),
 * so a hidden Floor costs nothing while the Line or Analytics is up, and is exactly where it was when
 * it returns.
 *
 * It holds itself (A3) in its own change handler whenever the store's workspace is not "floor", before
 * any listener is told: the change that switched workspaces never reaches the hidden Floor, whose
 * views therefore never animate while hidden. It is released, and caught up at once, by the change
 * that brings the Floor back, whichever way it comes (the switch, a key, the address).
 */
export function heldStore(store: SceneStore): HeldStore {
  // Held by request (hold(true)), or by the store's workspace not being the Floor: either holds it.
  let asked = false;
  const away = (s: SceneStoreState) => s.workspace !== "floor";
  const view = storeView(store, { decide: (s) => (asked || away(s) ? "hide" : "show") });
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
 * What window.__machSim offers, in development and capture builds only (never in a production
 * build): the simulation's moment and clock, for the capture script to take the same picture every
 * run. It is not a playback control: nothing in the interface can move the simulation's moment.
 */
export interface MachSimHook {
  readonly version: 2;
  readonly fixtureId: string;
  readonly duration: number;
  readonly eventCount: number;
  /** Move the simulation to scenario time `t`, either way (it runs on from there). The interface has no such control. */
  seek(t: number): void;
  state(): MachSimHookState;
  select(entity: EntityRef | null): void;
  focus(target: EntityRef | "overview"): void;
  setWorkspace(workspace: Workspace): void;
  setTheater(on: boolean): void;
  setFollow(on: boolean): void;
  /** The clock: "live" (browser frames), "manual" (only advance() moves time), or "fixed" (cannot be switched). */
  clockMode(): "live" | "manual" | "fixed";
  /** Switch to the manual clock: the simulation then moves only through advance(). */
  useManualClock(): void;
  /** Back to browser frames. */
  useLiveClock(): void;
  /** Manual clock: move wall time on by exactly `ms`, in frames of at most `frameMs` (default 250). */
  advance(ms: number, frameMs?: number): void;
}

export interface MachSimHookState {
  now: number;
  cursor: number;
  workspace: Workspace;
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
  const moment = simulationMoments.get(store);
  if (!moment) throw new Error("window.__machSim drives the simulation only.");
  const fixture = store.getState().fixture;
  const needClock = (): SwitchableClock => {
    if (!clock) throw new Error("This store's clock cannot be switched to manual.");
    return clock;
  };
  const hook: MachSimHook = {
    version: 2,
    fixtureId: fixture.id,
    duration: fixture.duration,
    eventCount: fixture.events.length,
    seek: moment,
    state() {
      const s = store.getState();
      return {
        now: s.now,
        cursor: s.cursor,
        workspace: s.workspace,
        theater: s.theater,
        selection: s.selection,
        follow: s.follow,
        focus: s.focus?.target ?? null,
        reducedMotion: s.reducedMotion,
        clock: clock ? clock.mode : "fixed",
      };
    },
    select: (entity) => store.select(entity),
    focus: (t) => store.focusOn(t, "api"),
    setWorkspace: (w) => store.setWorkspace(w),
    setTheater: (on) => store.setTheater(on),
    setFollow: (on) => store.setFollow(on),
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

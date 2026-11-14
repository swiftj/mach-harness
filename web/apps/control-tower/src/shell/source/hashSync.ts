/**
 * The store and the address's hash, both ways (grammar: ./hash.ts). No React and no window: the
 * shell passes a host (the browser's), tests pass a fake.
 *
 * Reading: the route, the selection, Theater Mode, the Timeline's window and grouping apply at once.
 * `at` waits until the source holds enough history to honour it (live and replay load
 * asynchronously): an event id until the shown log knows it, a time until it lies within what is held.
 * It is dropped, never applied late, once the person interacts first (a key, a click, a wheel), so the
 * playhead never jumps after they have started looking.
 *
 * An event id the history held does not reach (a replay, or live history read in windows) is looked
 * up through `locate` (the Timeline's marks and spans, which carry the event ids that bound them):
 * found, it becomes that time and is honoured as one, which loads the history window holding it; not
 * found, it is dropped and the person is told (`onLost`). An `at` is never dropped silently: dropped
 * because the person acted first, they are told that too.
 *
 * Writing (never on every frame): a new history entry (`pushHash`) when the workspace changes, or the
 * Analytics area does, so the browser's Back returns to the view left (an Analytics drill-down into the
 * Timeline or the floor, Back, and the area, period, filters, pick and open drawer are as they were);
 * otherwise the entry is replaced (filters, period, selection, playhead, Atlas and Blueprint). The
 * route and selection are written at once; `at` only
 * while the playhead is held still (paused off the live edge) and has stayed put for SETTLE_MS; the
 * Timeline's `win` once the window has stayed put for SETTLE_MS. An `at` not yet honoured is kept in
 * the address until it is.
 */
import { showOnFloor, type SceneStore, type SceneStoreState } from "../../scene/store";
import { formatHash, parseHash, type HashAt, type HashState } from "./hash";

export const SETTLE_MS = 400;

export interface HashHost {
  getHash(): string;
  replaceHash(hash: string): void;
  /** A new history entry (a workspace or Analytics area change). Absent: replaced like any other write. */
  pushHash?(hash: string): void;
  onHashChange(listener: () => void): () => void;
  /** The person's own first input (pointer down, key down, wheel). */
  onInteraction(listener: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Apply everything in the hash that needs no history (route, selection, Theater Mode, Timeline window, grouping, lens and table, Analytics' view). */
export function applyHash(store: SceneStore, h: HashState): void {
  if (h.route === "atlas" || h.route === "blueprint") {
    // Back from the Timeline through the address: as the switch does (showOnFloor), the floor frames the selection.
    if (store.getState().workspace !== "floor") showOnFloor(store, h.route);
    else store.setView(h.route);
  } else if (h.route === "timeline") {
    store.setWorkspace("timeline");
  } else if (h.route === "analytics") {
    // The address describes the whole view: every member is set (defaults included), so it lands exactly as written.
    if (h.analytics) store.setAnalyticsView(h.analytics);
    store.setWorkspace("analytics");
  }
  if (h.sel) store.select(h.sel);
  if (h.theater) store.setTheater(true);
  if (h.route === "timeline") {
    if (h.group) store.setTimelineView({ grouping: h.group });
    if (h.win) store.setTimelineView({ window: h.win });
    store.setTimelineView({ lens: h.lens, table: h.table });
  }
}

/** Seek to `at` if the source can honour it now. True when done (or it never can be: a malformed value). */
export function honourAt(store: SceneStore, at: HashAt): boolean {
  const s = store.getState();
  if (at.kind === "event") {
    if (!s.log.entry(at.id)) return false;
    store.seekToEvent(at.id);
    return true;
  }
  if (!Number.isFinite(at.ms)) return true;
  if (s.source === "simulation") {
    store.seek(at.ms);
    return true;
  }
  // Live and replay: something has been received, and the time lies within what is held.
  if (s.log.headTime() === null) return false;
  if (at.ms < s.extent.start || at.ms > s.liveAt) return false;
  store.seek(at.ms);
  return true;
}

/** Whether the playhead is held still in a way worth putting in the address. */
export function playheadHeld(s: Pick<SceneStoreState, "source" | "playing" | "following" | "playhead">): boolean {
  if (s.playing) return false;
  if (s.source === "simulation") return s.playhead > 0;
  return !s.following;
}

/** The event exactly at the playhead (stable across a rebuilt index), else the time. */
export function atOf(s: Pick<SceneStoreState, "log" | "playhead">): HashAt {
  const times = s.log.times();
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((times[mid] as number) <= s.playhead) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  const entry = i >= 0 && times[i] === s.playhead ? s.log.entries()[i] : undefined;
  return entry ? { kind: "event", id: entry.id } : { kind: "ms", ms: Math.round(s.playhead) };
}

const sameAt = (a: HashAt | null, b: HashAt | null): boolean =>
  a === b || (a !== null && b !== null && (a.kind === "ms" ? b.kind === "ms" && a.ms === b.ms : b.kind === "event" && a.id === b.id));
const winKey = (w: { from: number; to: number } | null): string => (w ? `${Math.round(w.from)}-${Math.round(w.to)}` : "");

/** Why an `at` from the address was not applied. */
export type LostReason = "not-found" | "interrupted";

export interface HashSyncOptions {
  /** The time of an event the history held does not reach, or null when nothing recorded names it. */
  locate?(eventId: string): Promise<number | null>;
  /** An `at` was dropped without being applied. */
  onLost?(at: HashAt, why: LostReason): void;
}

export interface HashSync {
  /** The `at` still waiting to be honoured, if any. */
  pending(): HashAt | null;
  dispose(): void;
}

/**
 * Start syncing. The route, selection and the rest are assumed applied already (applyHash, before the
 * first render); this takes the hash's `at` as pending and keeps the address written.
 */
export function createHashSync(store: SceneStore, host: HashHost, settleMs = SETTLE_MS, options: HashSyncOptions = {}): HashSync {
  let pending: HashAt | null = parseHash(host.getHash()).at;
  /** The `at` already looked up (once each). */
  let asked: HashAt | null = null;
  let disposed = false;
  let last = host.getHash();
  let settledAt: HashAt | null = null;
  let settledWin = store.getState().timeline.window;
  let atTimer: unknown = null;
  let winTimer: unknown = null;
  let wantAt: HashAt | null = null;
  let wantWin = settledWin;
  /** The workspace (and Analytics area) of the entry written last: a change pushes a new entry. */
  const placeOf = (s: SceneStoreState) => (s.workspace === "analytics" ? `analytics|${s.analytics.area}` : s.workspace);
  let place = placeOf(store.getState());

  const write = () => {
    const s = store.getState();
    const next = formatHash({
      route: s.workspace === "floor" ? s.view : s.workspace,
      sel: s.selection,
      at: pending ?? settledAt,
      win: settledWin,
      group: s.timeline.grouping,
      lens: s.timeline.lens,
      table: s.timeline.table,
      analytics: s.analytics,
    });
    if (next === last) return;
    last = next;
    const now = placeOf(s);
    if (now !== place && host.pushHash) host.pushHash(next);
    else host.replaceHash(next);
    place = now;
  };

  const tryPending = () => {
    const at = pending;
    if (!at) return;
    // Cleared first: the seek notifies the store's listeners (this one among them) synchronously.
    pending = null;
    if (!honourAt(store, at)) {
      pending = at;
      if (at.kind === "event") locateLater(at);
      return;
    }
    // Honoured: it is the playhead now, already settled.
    settledAt = wantAt = playheadHeld(store.getState()) ? atOf(store.getState()) : null;
  };

  const lose = (at: HashAt, why: LostReason) => {
    if (pending === at) pending = null;
    options.onLost?.(at, why);
  };

  /** An event id the shown history does not hold: the simulation holds all of its own; otherwise look it up once the history is ready. */
  const locateLater = (at: HashAt & { kind: "event" }) => {
    const s = store.getState();
    if (s.source === "simulation") {
      lose(at, "not-found");
      return;
    }
    if (!options.locate || asked === at) return;
    const ready = s.source === "replay" ? s.log.headTime() !== null : s.connection?.state === "live";
    if (!ready) return;
    asked = at;
    options.locate(at.id).then(
      (t) => {
        if (disposed || pending !== at) return;
        if (t === null || !Number.isFinite(t)) {
          lose(at, "not-found");
          return;
        }
        // Found by time: honoured as that time (which loads the window holding it).
        pending = { kind: "ms", ms: Math.round(t) };
        tryPending();
        write();
      },
      () => {
        if (!disposed && pending === at) lose(at, "not-found");
      },
    );
  };

  const onChange = () => {
    tryPending();
    const s = store.getState();
    const atNow = pending ? null : playheadHeld(s) ? atOf(s) : null;
    if (atNow === null) {
      if (atTimer !== null) host.clearTimeout(atTimer);
      atTimer = null;
      wantAt = null;
      settledAt = null;
    } else if (!sameAt(atNow, wantAt)) {
      wantAt = atNow;
      if (atTimer !== null) host.clearTimeout(atTimer);
      atTimer = host.setTimeout(() => {
        atTimer = null;
        settledAt = wantAt;
        write();
      }, settleMs);
    }
    const win = s.timeline.window;
    if (winKey(win) !== winKey(wantWin)) {
      wantWin = win;
      if (winTimer !== null) host.clearTimeout(winTimer);
      if (win === null) {
        winTimer = null;
        settledWin = null;
      } else {
        winTimer = host.setTimeout(() => {
          winTimer = null;
          settledWin = wantWin;
          write();
        }, settleMs);
      }
    }
    write();
  };

  const offHash = host.onHashChange(() => {
    const h = parseHash(host.getHash());
    last = host.getHash();
    applyHash(store, h);
    place = placeOf(store.getState());
    pending = h.at;
    asked = null;
    settledWin = wantWin = store.getState().timeline.window;
    tryPending();
  });
  const offInteraction = host.onInteraction(() => {
    if (!pending) return;
    // The person acted first: the address's moment is no longer theirs to be moved to. Said, never silent.
    const dropped = pending;
    pending = null;
    options.onLost?.(dropped, "interrupted");
    onChange();
  });
  const offStore = store.subscribe(onChange);
  tryPending();

  return {
    pending: () => pending,
    dispose() {
      disposed = true;
      offHash();
      offInteraction();
      offStore();
      if (atTimer !== null) host.clearTimeout(atTimer);
      if (winTimer !== null) host.clearTimeout(winTimer);
    },
  };
}

/** The browser as a host. */
export function browserHashHost(): HashHost {
  return {
    getHash: () => window.location.hash,
    replaceHash(hash) {
      if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    },
    pushHash(hash) {
      if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    },
    onHashChange(listener) {
      window.addEventListener("hashchange", listener);
      return () => window.removeEventListener("hashchange", listener);
    },
    onInteraction(listener) {
      const events = ["pointerdown", "keydown", "wheel"] as const;
      for (const e of events) window.addEventListener(e, listener, { capture: true, passive: true });
      return () => {
        for (const e of events) window.removeEventListener(e, listener, { capture: true });
      };
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

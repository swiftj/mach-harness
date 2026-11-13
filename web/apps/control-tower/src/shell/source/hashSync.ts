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
 * Writing (history.replaceState, never on every frame): the route and selection at once; `at` only
 * while the playhead is held still (paused off the live edge) and has stayed put for SETTLE_MS; the
 * Timeline's `win` once the window has stayed put for SETTLE_MS. An `at` not yet honoured is kept in
 * the address until it is.
 */
import type { SceneStore, SceneStoreState } from "../../scene/store";
import { formatHash, parseHash, type HashAt, type HashState } from "./hash";

export const SETTLE_MS = 400;

export interface HashHost {
  getHash(): string;
  replaceHash(hash: string): void;
  onHashChange(listener: () => void): () => void;
  /** The person's own first input (pointer down, key down, wheel). */
  onInteraction(listener: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Apply everything in the hash that needs no history (route, selection, Theater Mode, Timeline window and grouping). */
export function applyHash(store: SceneStore, h: HashState): void {
  if (h.route === "atlas" || h.route === "blueprint") {
    store.setView(h.route);
    store.setWorkspace("floor");
  } else if (h.route === "timeline") {
    store.setWorkspace("timeline");
  }
  if (h.sel) store.select(h.sel);
  if (h.theater) store.setTheater(true);
  if (h.route === "timeline") {
    if (h.group) store.setTimelineView({ grouping: h.group });
    if (h.win) store.setTimelineView({ window: h.win });
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

export interface HashSync {
  /** The `at` still waiting to be honoured, if any. */
  pending(): HashAt | null;
  dispose(): void;
}

/**
 * Start syncing. The route, selection and the rest are assumed applied already (applyHash, before the
 * first render); this takes the hash's `at` as pending and keeps the address written.
 */
export function createHashSync(store: SceneStore, host: HashHost, settleMs = SETTLE_MS): HashSync {
  let pending: HashAt | null = parseHash(host.getHash()).at;
  let last = host.getHash();
  let settledAt: HashAt | null = null;
  let settledWin = store.getState().timeline.window;
  let atTimer: unknown = null;
  let winTimer: unknown = null;
  let wantAt: HashAt | null = null;
  let wantWin = settledWin;

  const write = () => {
    const s = store.getState();
    const next = formatHash({
      route: s.workspace === "timeline" ? "timeline" : s.view,
      sel: s.selection,
      at: pending ?? settledAt,
      win: settledWin,
      group: s.timeline.grouping,
    });
    if (next === last) return;
    last = next;
    host.replaceHash(next);
  };

  const tryPending = () => {
    const at = pending;
    if (!at) return;
    // Cleared first: the seek notifies the store's listeners (this one among them) synchronously.
    pending = null;
    if (!honourAt(store, at)) {
      pending = at;
      return;
    }
    // Honoured: it is the playhead now, already settled.
    settledAt = wantAt = playheadHeld(store.getState()) ? atOf(store.getState()) : null;
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
    pending = h.at;
    settledWin = wantWin = store.getState().timeline.window;
    tryPending();
  });
  const offInteraction = host.onInteraction(() => {
    if (!pending) return;
    // The person acted first: the address's moment is no longer theirs to be moved to.
    pending = null;
    onChange();
  });
  const offStore = store.subscribe(onChange);
  tryPending();

  return {
    pending: () => pending,
    dispose() {
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

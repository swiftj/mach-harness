/**
 * The store and the address's hash, both ways (grammar: ./hash.ts). No React and no window: the
 * shell passes a host (the browser's), tests pass a fake.
 *
 * Reading: the route, the selection, Theater Mode, Analytics' view and the evidence player apply at
 * once, at start-up (applyHash, before the first render) and whenever the hash changes (Back).
 *
 * Writing (never on every frame): a new history entry (`pushHash`) when the workspace changes, or the
 * Analytics area does, so the browser's Back returns to the view left (an Analytics drill-down onto
 * the Line or the Floor, Back, and the area, period, filters, pick and open drawer are as they were);
 * otherwise the entry is replaced (filters, period, selection).
 */
import { showOnFloor, type SceneStore, type SceneStoreState } from "../../scene/store";
import { formatHash, parseHash, type HashState } from "./hash";

export interface HashHost {
  getHash(): string;
  replaceHash(hash: string): void;
  /** A new history entry (a workspace or Analytics area change). Absent: replaced like any other write. */
  pushHash?(hash: string): void;
  onHashChange(listener: () => void): () => void;
}

/** Apply everything in the hash: route, selection, Theater Mode, Analytics' view, the evidence player. */
export function applyHash(store: SceneStore, h: HashState): void {
  const floor = h.route === "floor";
  if (floor) {
    // Back to the Floor through the address: as the switch does (showOnFloor), the Floor frames the selection.
    if (store.getState().workspace !== "floor") showOnFloor(store);
  } else if (h.route === "line") {
    store.setWorkspace("line");
  } else if (h.route === "analytics") {
    // The address describes the whole view: every member is set (defaults included), so it lands exactly as written.
    if (h.analytics) store.setAnalyticsView(h.analytics);
    store.setWorkspace("analytics");
  } else if (h.route === "decisions") {
    // The address describes the whole view: no `adr` is the list.
    store.setDecision(h.decision);
    store.setWorkspace("decisions");
  }
  if (h.sel) store.select(h.sel, { focus: floor });
  if (h.theater) store.setTheater(true);
  // M6.4: the evidence player, by ticket and check only; an address without it closes it (Back).
  const ev = store.getState().evidence;
  if (h.evidence) {
    if (!ev || ev.ticket !== h.evidence.ticket) store.openEvidence(h.evidence.ticket, { check: h.evidence.check });
    else store.setEvidenceCheck(h.evidence.check);
  } else if (ev) store.closeEvidence();
}

export interface HashSync {
  dispose(): void;
}

/** Start keeping the address written. The address is assumed applied already (applyHash, before the first render). */
export function createHashSync(store: SceneStore, host: HashHost): HashSync {
  let last = host.getHash();
  /** The workspace (and Analytics area, or the decision open) of the entry written last: a change pushes a new entry. */
  const placeOf = (s: SceneStoreState) =>
    s.workspace === "analytics" ? `analytics|${s.analytics.area}` : s.workspace === "decisions" ? `decisions|${s.decision ?? ""}` : s.workspace;
  let place = placeOf(store.getState());

  const write = () => {
    const s = store.getState();
    const next = formatHash({
      route: s.workspace,
      sel: s.selection,
      analytics: s.analytics,
      evidence: s.evidence ? { ticket: s.evidence.ticket, check: s.evidence.check } : null,
      decision: s.decision,
    });
    if (next === last) return;
    last = next;
    const now = placeOf(s);
    if (now !== place && host.pushHash) host.pushHash(next);
    else host.replaceHash(next);
    place = now;
  };

  const offHash = host.onHashChange(() => {
    last = host.getHash();
    applyHash(store, parseHash(last));
    place = placeOf(store.getState());
  });
  const offStore = store.subscribe(write);
  write();

  return {
    dispose() {
      offHash();
      offStore();
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
  };
}

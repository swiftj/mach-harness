// M6.6 Phase 2 (I-02, I-03, I-13, I-38, I-39, I-07/I-08/I-31/I-32): Analytics says the same source and
// link state as the other workspaces, shows incomplete history where the figures are, has a way back
// to live (button, L, End), and never lets a figure counted to a whole UTC day read as the playhead's
// moment. The completeness badge and the freshness read time speak as of the playhead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, scene as S } from "./_load.mjs";

const { manualClock } = await import("../src/scene/clock.ts");
const { shellKeyHandler, KEYMAP, activeIn } = await import("../src/shell/keyboard.ts");
const { analyticsAsOf } = await import("../src/shell/analyticsAsOf.ts");
const H = await import("../src/analytics/wire/history.ts");
const Q = await import("../src/analytics/wire/query.ts");
const L = await import("../src/analytics/wire/load.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const D = 86_400_000;
const nov = (d, h = 0, m = 0, s = 0) => Date.UTC(2026, 10, d, h, m, s);

function press(store, key, extra = {}) {
  const commands = { toggleInspector() {}, toggleTimeline() {}, openHelp() {}, openSource() {}, modalOpen: () => false };
  const e = { key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, target: null, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  shellKeyHandler(store, commands)(e);
  return e;
}

// ---------------------------------------------------------------- I-02 source and link state

test("I-02: Analytics' source line is the store's playbackLabel, with the link's state in the badge's words", () => {
  const at = { playhead: 9e12, liveAt: 9e12 };
  const label = (source, following, connection) => analyticsAsOf({ source, following, connection, ...at, ...(following ? {} : { playhead: 1 }) }).sourceLabel;
  assert.equal(label("live", true, { state: "live" }), "Live Factory");
  assert.equal(label("live", true, { state: "stale" }), "Live Factory (stale)");
  assert.equal(label("live", true, { state: "reconnecting" }), "Live Factory (reconnecting)");
  assert.equal(label("live", true, { state: "disconnected" }), "Live Factory (disconnected)");
  assert.equal(label("live", true, { state: "no-session" }), "Live Factory (no session)");
  assert.equal(label("live", false, { state: "live" }), "Live Factory, reviewing an earlier moment");
  assert.equal(label("replay", false, null), "Historical replay");
  assert.equal(label("simulation", true, null), "Simulation");
  const ws = src("analytics/Workspace.tsx");
  assert.match(ws, /const sourceLabel = area === "simulation" \? sourceWords\(area\) : asOf\.sourceLabel/, "the header reads the store's label; Simulated stays the fixture's");
  assert.match(ws, /<StageNotice at="bottom" \/>/, "the floor's notice component, not a second one");
  const badge = src("shell/SourceBadge.tsx");
  assert.match(badge, /export function StageNotice\(\{ at = "top" \}/);
  assert.match(badge, /role="status" data-stage-notice/, "polite, as on the floor");
  assert.match(badge, /pointer-events-none absolute inset-x-0 z-20/, "floating: nothing moves when it appears");
});

// ---------------------------------------------------------------- I-03 incomplete history

test("I-03: incomplete history is said in the Timeline's words for a gap, with suspect days, and nothing after the playhead", () => {
  assert.equal(H.historyWords({ partial: null, gaps: [], suspect_days: [] }), null, "complete: nothing said");
  const h = { partial: "evicted", gaps: [{ class: "not-received", at_ms: nov(3, 9, 29, 13), count: 4 }, { class: "conflict", at_ms: nov(2, 8), count: 1 }, { class: "evicted", at_ms: nov(6, 1), count: 2 }], suspect_days: ["2026-11-03", "2026-11-06"] };
  const w = H.historyWords(h);
  assert.equal(w.title, "Incomplete history.");
  assert.match(w.body, /^History is missing here: /);
  assert.match(w.body, /not received \(4 records\) at 3 Nov 09:29:13 UTC/);
  assert.match(w.body, /History was repaired or kept apart: a conflicting copy, the first kept \(1 record\)/);
  assert.match(w.body, /Figures for 3 Nov, 6 Nov \(UTC\) may count less than happened/);
  assert.match(w.body, /Nothing is filled in/);
  const held = H.historyWords({ ...h, as_of_ms: nov(4, 12) });
  assert.doesNotMatch(held.body, /6 Nov/, "a gap and a day after the playhead are not named");
  assert.deepEqual(held.days, [nov(3)]);
  assert.match(H.historyWords({ partial: "evicted", gaps: [], suspect_days: [] }).body, /The observer's history is partial \(no longer held by the observer\)/);
  // Where the figures are: one line over the area, and a mark beside a suspect figure.
  const kit = src("analytics/ui/kit.tsx");
  assert.match(kit, /snapshot\?\.history \? <HistoryLine history=\{snapshot\.history\} \/> : null/);
  assert.match(kit, /row\.suspect && h\.text !== null && !missing \? \([\s\S]*history incomplete here/);
  assert.match(src("analytics/wire/load.ts"), /history: SnapshotHistory = \{ partial: t\.history\.partial, gaps: t\.history\.gaps, suspect_days: t\.suspect_days, as_of_ms: session\.asOfMs \}/);
});

// ---------------------------------------------------------------- I-07/I-08/I-31 time semantics

test("I-07/I-08: a day cut names its last whole day and the playhead apart, and which parts run to the playhead", () => {
  const words = Q.asOfWords({ area: "replay", asOfMs: nov(4, 14, 20, 5), window: "all", metricsExact: false, widened: false, cut: false, dayCut: nov(4) }, Q.momentWords);
  assert.equal(words, "Counted through the end of 3 Nov (UTC), the last whole day before the playhead. The playhead is at 4 Nov 14:20:05 UTC; the part of 4 Nov before it is not in these figures. The flow drawing and the rows behind a figure run to the playhead itself");
  assert.equal(Q.dayCutTag(nov(4)), "to end of 3 Nov", "each figure carries its own last day");
  assert.match(src("analytics/ui/kit.tsx"), /dayCutTag\(row\.as_of\.effective_to_ms\)/);
  assert.match(src("analytics/ui/kit.tsx"), /The end of \{lastWholeDay\(row\.as_of\.effective_to_ms\)\} \(UTC\)/, "the definition says the last day, not a midnight");
  assert.match(Q.asOfWords({ area: "simulation", asOfMs: null, window: "all", metricsExact: null, widened: false, cut: false }, Q.momentWords), /the playhead does not apply to it/, "I-31");
});

// ---------------------------------------------------------------- I-39 read time

test("I-39: under a playhead the observer's read time (its clock now) is not shown, and the note says why", () => {
  const rows = [{ source: "intake log", last_read_ms: nov(9), note: "2 files followed" }, { source: "run records", last_read_ms: null }];
  assert.equal(L.asOfFreshness(rows, null), rows, "live at the edge: unchanged");
  const held = L.asOfFreshness(rows, nov(4));
  assert.equal(held[0].last_read_ms, null);
  assert.equal(held[0].note, `2 files followed; ${L.READ_NOW_NOTE}`);
  assert.equal(held[1], rows[1]);
});

// ---------------------------------------------------------------- I-13 back to live

test("I-13: in Analytics, L and End go back to live only while it shows an earlier moment; the button calls the same follow-live", () => {
  const store = S.createSceneStore({ fixture: sim.SCENARIO, clock: manualClock() });
  store.followLive();
  store.setWorkspace("analytics");
  // At the live edge: the keys stay with the content (End scrolls the sheet).
  assert.equal(press(store, "End").prevented, false);
  assert.equal(press(store, "l").prevented, false);
  // The simulation reveals what the playhead passes: run to 400 s, then look back to 100 s.
  for (const key of ["L", "End"]) {
    store.seek(400_000);
    store.seek(100_000);
    assert.equal(store.getState().following, false);
    assert.ok(store.getState().liveAt >= 400_000);
    assert.ok(press(store, key).prevented, key);
    assert.equal(store.getState().playhead, store.getState().liveAt, `${key}: back at the live edge`);
  }
  store.seek(400_000);
  store.seek(100_000);
  assert.equal(press(store, " ").prevented, false, "the other playback keys still do nothing in Analytics");
  // Listed in the help for Analytics, and colliding with nothing there.
  const b = KEYMAP.find((k) => k.group === "Analytics");
  assert.deepEqual(b.keys, ["L", "End"]);
  assert.ok(activeIn(b, "analytics") && !activeIn(b, "floor"));
  const ui = src("analytics/ui/Workspace.tsx");
  assert.match(ui, /aria-keyshortcuts="L End" data-analytics-back-to-live/);
  assert.match(src("analytics/Workspace.tsx"), /const backToLive = asOfMs !== null \? \{ label: sceneSource === "replay" \? "Go to its last event" : "Back to live", run: \(\) => store\.followLive\(\) \}/);
});

// ---------------------------------------------------------------- I-38 completeness at the playhead

test("I-38: the completeness badge reads the scene at the playhead, as the Atlas title does", async () => {
  const badge = src("shell/SourceBadge.tsx");
  assert.match(badge, /const c = s\.log\.sceneAt\(s\.playhead\)\.completeness;/);
  assert.doesNotMatch(badge, /s\.log\.head\(\)\.completeness/);
});

// ---------------------------------------------------------------- I-32 no widening

test("I-32: the snapshot refuses counted figures rather than widening past the playhead (see analytics-data for the session)", () => {
  const snap = src("analytics/data/snapshot.ts");
  assert.match(snap, /const COUNTED: ReadonlySet<AnalyticsRoute> = new Set<AnalyticsRoute>\(\["metrics", "flow", "insights"\]\)/);
  assert.match(snap, /if \(COUNTED\.has\(route\)\) return \{ status: "unsupported", reason: AS_OF_UNSUPPORTED \}/);
  void D;
});

// ---------------------------------------------------------------- D1 (real run): a reply of another cut never fills a panel

const SNAP = await import("../src/analytics/data/snapshot.ts");
const VIEWS = await import("../src/analytics/wire/views.ts");

/**
 * An observer whose replies are released by hand: each request waits until `release(i)`. Replies say
 * what they were asked for: through the whole history (completed 3) or as of the playhead (completed 0).
 */
function gatedProvider() {
  const pending = [];
  const answer = (route) => (query, options) =>
    new Promise((ok, fail) => {
      const asOf = options?.asOfMs ?? null;
      const value = { cursor: options?.at ?? "c.471", as_of: asOf !== null ? { ms: asOf, exact: route !== "metrics", effective_to_ms: asOf, rule: null } : null, window: { effective_to_ms: null }, metrics: [{ id: "K1", value: asOf !== null ? 0 : 3 }], items: [], after_as_of: 0 };
      pending.push({ route, asOf, go: () => ok({ status: "ok", value }) });
      options?.signal?.addEventListener("abort", () => fail(options.signal.reason));
    });
  return {
    pending,
    data: { source: "observer", metrics: answer("metrics"), flow: answer("flow"), contributors: answer("contributors"), runs: answer("runs"), executions: answer("executions"), insights: answer("insights") },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

for (const order of ["uncut first", "cut first"]) {
  test(`D1: two views at one cursor, one uncut and one held at the playhead, replies interleaved (${order}): each reads only its own cut`, async () => {
    const p = gatedProvider();
    const cache = SNAP.createSnapshotCache();
    const PLAYHEAD = 1_794_669_360_000;
    // Both pinned at the same cursor, as the workspace's shared cursor makes them.
    const uncut = SNAP.beginSnapshot(p.data, { asOfMs: null, at: "c.471", cache });
    const held = SNAP.beginSnapshot(p.data, { asOfMs: PLAYHEAD, at: "c.471", cache });
    const a = uncut.metrics({ distribution: true });
    const b = held.metrics({ distribution: true });
    await flush();
    assert.equal(p.pending.length, 2, "both asked: the cut is part of the query's identity, never served from the other's cache");
    const order_ = order === "uncut first" ? [0, 1] : [1, 0];
    for (const i of order_) {
      p.pending[i].go();
      await flush();
    }
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.value.asOf, null);
    assert.equal(ra.value.metrics[0].value, 3);
    assert.equal(rb.value.asOf.ms, PLAYHEAD);
    assert.equal(rb.value.metrics[0].value, 0, "the held view shows what was true at the playhead");
    // A later view held at the playhead is answered from the cache with the held reply, never the uncut one.
    const again = await SNAP.beginSnapshot(p.data, { asOfMs: PLAYHEAD, at: "c.471", cache }).metrics({ distribution: true });
    assert.equal(again.value.metrics[0].value, 0);
    assert.equal(p.pending.length, 2, "cached by its cut");
  });
}

test("D1: a reply of another cut is refused, and the area restarts rather than showing it", async () => {
  const PLAYHEAD = 1_794_669_360_000;
  assert.equal(SNAP.sameCut({ status: "ok", value: { asOf: null } }, PLAYHEAD), false);
  assert.equal(SNAP.sameCut({ status: "ok", value: { asOf: { ms: PLAYHEAD } } }, PLAYHEAD), true);
  assert.equal(SNAP.sameCut({ status: "ok", value: { asOf: { ms: PLAYHEAD } } }, null), false);
  assert.equal(SNAP.sameCut({ status: "cursor-gone", reason: "-" }, PLAYHEAD), true);
  // loadArea: totals of another cut (a session that lies about its cut) restart the view.
  const lying = { asOfMs: PLAYHEAD, cursor: "c.1", metrics: async () => ({ status: "ok", value: { cursor: "c.1", asOf: null, metrics: [], history: { sources: [], gaps: [], partial: null }, window: {}, suspect_days: [] } }) };
  const r = await L.loadArea({ session: lying, data: { source: "observer" }, source: "live", plan: Q.planFor("pulse", null), fromMs: null, toMs: null, filters: {}, model: null, contractFilters: {}, endMs: null });
  assert.equal(r.restart, true);
  assert.equal(r.data.state, "error");
  // The workspace's two views share one cursor object, and each view's session is begun with its own cut.
  assert.match(src("analytics/wire/views.ts"), /beginSnapshot\(this\.data, \{ asOfMs: this\.asOfMs, at: cursor \}\)/);
  void VIEWS;
});

test("D1 (as on the real run): the uncut view answers and is cached first; the held view at the same cursor still asks with its cut", async () => {
  const p = gatedProvider();
  const cache = SNAP.createSnapshotCache();
  const PLAYHEAD = 1_794_669_360_000;
  const a = SNAP.beginSnapshot(p.data, { asOfMs: null, at: "c.471", cache }).metrics({ distribution: true });
  await flush();
  p.pending[0].go();
  assert.equal((await a).value.metrics[0].value, 3);
  const b = SNAP.beginSnapshot(p.data, { asOfMs: PLAYHEAD, at: "c.471", cache }).metrics({ distribution: true });
  await flush();
  assert.equal(p.pending.length, 2, "the whole-history reply in the cache is not this view's");
  assert.equal(p.pending[1].asOf, PLAYHEAD);
  p.pending[1].go();
  assert.equal((await b).value.metrics[0].value, 0);
});

test("D1: while the address names a moment the live history cannot honour yet, Analytics knows it is pending and does not read the whole history first", async () => {
  const { createHashSync, addressMomentPending } = await import("../src/shell/source/hashSync.ts");
  const listeners = new Set();
  let state = { source: "live", log: { entry: () => undefined, headTime: () => null, times: () => [], entries: () => [] }, extent: { start: 0, end: 0 }, liveAt: 0, playhead: 0, following: true, playing: false, view: "atlas", workspace: "analytics", selection: null, timeline: { window: null, grouping: "product", expanded: [], filters: {}, table: false }, analytics: { area: "pulse", window: "all", filters: {}, pick: null, station: null, focus: null, compare: null } };
  const store = {
    getState: () => state,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    seek(t) {
      state = { ...state, playhead: t, following: false };
      for (const l of [...listeners]) l();
    },
    arrive(t) {
      state = { ...state, extent: { start: 1000, end: t }, liveAt: t, playhead: t, log: { ...state.log, headTime: () => t } };
      for (const l of [...listeners]) l();
    },
  };
  const host = { hash: "#analytics?at=5000", getHash: () => host.hash, replaceHash: (h) => (host.hash = h), onHashChange: () => () => {}, onInteraction: () => () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  assert.equal(addressMomentPending(store), null, "no sync yet: the caller reads the address itself");
  const sync = createHashSync(store, host);
  assert.equal(addressMomentPending(store), true, "the history does not reach 5000 yet");
  store.arrive(9000);
  assert.equal(store.getState().playhead, 5000, "honoured once held");
  assert.equal(addressMomentPending(store), false);
  sync.dispose();
  assert.equal(addressMomentPending(store), null);
  assert.match(src("analytics/Workspace.tsx"), /if \(momentPending && asOfMs === null\) return;/);
  assert.match(src("analytics/Workspace.tsx"), /addressMomentPending\(store\) \?\? \(typeof window !== "undefined" && parseHash\(window\.location\.hash\)\.at !== null\)/);
});

// ---------------------------------------------------------------- D7: an address moment outside the history

function heldHistory(source = "replay") {
  const listeners = new Set();
  let state = { source, connection: source === "live" ? { state: "live" } : null, log: { entry: () => undefined, headTime: () => 9000, times: () => [], entries: () => [] }, extent: { start: 1000, end: 9000 }, liveAt: 9000, playhead: 1000, following: false, playing: false, view: "atlas", workspace: "timeline", selection: null, timeline: { window: null, grouping: "product", expanded: [], filters: {}, table: false }, analytics: { area: "pulse", window: "all", filters: {}, pick: null, station: null, focus: null, compare: null } };
  const set = (p) => {
    state = { ...state, ...p };
    for (const l of [...listeners]) l();
  };
  return { getState: () => state, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)), seek: (t) => set({ playhead: t, following: false }), followLive: () => set({ playhead: state.liveAt, following: true }) };
}
const hostOf = (hash) => {
  const host = { hash, getHash: () => host.hash, replaceHash: (h) => (host.hash = h), onHashChange: () => () => {}, onInteraction: () => () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  return host;
};

for (const [route, label] of [["timeline", "Timeline"], ["analytics", "Analytics"]]) {
  test(`D7 (${label}): a link's moment after the history ends goes to its last event; before it begins, to its first; each said`, async () => {
    const { createHashSync, clampAt } = await import("../src/shell/source/hashSync.ts");
    const lost = [];
    const after = heldHistory();
    createHashSync(after, hostOf(`#${route}?at=50000`), 0, { onLost: (at, why) => lost.push(why) }).dispose();
    assert.equal(after.getState().playhead, 9000, "the last event, not the start");
    const before = heldHistory();
    createHashSync(before, hostOf(`#${route}?at=10`), 0, { onLost: (at, why) => lost.push(why) }).dispose();
    assert.equal(before.getState().playhead, 1000, "the first event");
    assert.deepEqual(lost, ["after-end", "before-start"]);
    const inside = heldHistory();
    createHashSync(inside, hostOf(`#${route}?at=5000`), 0, { onLost: (at, why) => lost.push(why) }).dispose();
    assert.equal(inside.getState().playhead, 5000, "inside: as asked, nothing said");
    assert.equal(lost.length, 2);
    // Live: past the live edge goes to the live edge; before what is held, it waits (older history may be read).
    assert.deepEqual(clampAt(heldHistory("live").getState(), { kind: "ms", ms: 50000 }), { t: 9000, why: "after-end" });
    assert.equal(clampAt(heldHistory("live").getState(), { kind: "ms", ms: 10 }), null);
    assert.equal(clampAt({ ...heldHistory().getState(), log: { headTime: () => null } }, { kind: "ms", ms: 50000 }), null, "nothing held yet: wait");
    const shell = src("shell/Shell.tsx");
    assert.match(shell, /The link's moment is after this history ends; showing its last event\./);
    assert.match(shell, /The link's moment is before this history begins; showing its first event\./);
  });
}

test("D4: every area says no whole UTC day precedes the playhead, apart from nothing recorded", () => {
  assert.match(src("analytics/ui/kit.tsx"), /snapshot\?\.no_whole_day \? \([\s\S]*No whole UTC day before the playhead\.[\s\S]*that is not the same as nothing recorded/);
});

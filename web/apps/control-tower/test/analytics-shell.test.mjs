// M6.5.6 shell groundwork: Analytics as a third workspace. The store's interface slice, the address's
// grammar for all three workspaces (property-style round trips), the keyboard map in three contexts,
// switching that never moves the selection or the playhead, the held floor, and the navigation helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { createSceneStore, heldStore, showInAnalytics, showInTimeline, showOnFloor, WORKSPACES } = await import("../src/scene/store.ts");
const A = await import("../src/scene/analytics.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { parseHash, formatHash } = await import("../src/shell/source/hash.ts");
const { applyHash, createHashSync } = await import("../src/shell/source/hashSync.ts");
const { KEYMAP, TIMELINE_KEYS, activeIn, shellKeyHandler } = await import("../src/shell/keyboard.ts");
const { analyticsAsOf } = await import("../src/shell/analyticsAsOf.ts");
const { SCENARIO } = sim;

const make = (extra = {}) => createSceneStore({ fixture: SCENARIO, clock: manualClock(), ...extra });

/** A deterministic generator (mulberry32), so a failure names its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const maybe = (r, list, p = 0.5) => (r() < p ? pick(r, list) : null);

function randomWindow(r) {
  if (r() < 0.6) return pick(r, A.ANALYTICS_WINDOW_PRESETS);
  const from = Math.floor(r() * 2e12);
  return { from, to: from + 1 + Math.floor(r() * 1e9) };
}
function randomCohort(r) {
  const c = {};
  if (r() < 0.5) c.risk = pick(r, A.ANALYTICS_RISKS);
  if (r() < 0.4) c.appType = pick(r, A.ANALYTICS_APP_TYPES);
  if (r() < 0.3) c.model = pick(r, A.ANALYTICS_MODELS);
  if (r() < 0.3) c.station = pick(r, A.ANALYTICS_STATIONS);
  if (r() < 0.3) c.window = randomWindow(r);
  return c;
}
const METRICS = ["T1", "C1", "W2b", "K10", "Q4", "R1"];
const VALUES = ["build", "high", "browser", "a:b", "x_y-1", "é"];
function randomView(r) {
  return {
    area: pick(r, A.ANALYTICS_AREAS),
    window: randomWindow(r),
    filters: { risk: maybe(r, A.ANALYTICS_RISKS), appType: maybe(r, A.ANALYTICS_APP_TYPES), model: maybe(r, A.ANALYTICS_MODELS), station: maybe(r, A.ANALYTICS_STATIONS) },
    compare: r() < 0.4 ? { a: randomCohort(r), b: randomCohort(r) } : null,
    focus: r() < 0.5 ? { metric: pick(r, METRICS), group: r() < 0.5 ? { dim: pick(r, ["station", "risk", "target_kind"]), value: pick(r, VALUES) } : null } : null,
    pick: r() < 0.3 ? { dim: pick(r, ["outcome", "rule", "target_kind"]), value: pick(r, VALUES) } : null,
  };
}
const SELS = [null, "cell:LOCAL-031", "station:LOCAL-031/build", "gate:LOCAL-031/review#2", "execution:x/1 2"];
const ATS = [null, { kind: "ms", ms: 300000 }, { kind: "event", id: "sim:12" }];

// ---------------------------------------------------------------- the store's slice

test("workspaces: three, the floor by default; 'analytics' is accepted, anything else ignored", () => {
  assert.deepEqual([...WORKSPACES], ["floor", "timeline", "analytics"]);
  const store = make();
  assert.equal(store.getState().workspace, "floor");
  assert.deepEqual(store.getState().analytics, A.INITIAL_ANALYTICS_VIEW);
  store.setWorkspace("analytics");
  assert.equal(store.getState().workspace, "analytics");
  const same = store.getState();
  store.setWorkspace("evidence");
  store.setWorkspace("analytics");
  assert.equal(store.getState(), same);
});

test("setAnalyticsView: merges filters key by key, ignores invalid members one by one, no change is no new state", () => {
  const store = make();
  let n = 0;
  store.subscribe(() => n++);
  store.setAnalyticsView({ area: "flow", filters: { station: "build" } });
  let a = store.getState().analytics;
  assert.equal(a.area, "flow");
  assert.equal(a.filters.station, "build");
  assert.equal(n, 1);
  store.setAnalyticsView({ filters: { risk: "high" } });
  a = store.getState().analytics;
  assert.deepEqual(a.filters, { risk: "high", appType: null, model: null, station: "build" }, "merged");
  const before = store.getState();
  store.setAnalyticsView({ area: "nonsense", window: "3y", filters: { risk: "extreme", station: "build" }, focus: { metric: "drop table" }, pick: { dim: "Bad Dim", value: "x" } });
  assert.equal(store.getState(), before, "all invalid or unchanged: nothing happens");
  store.setAnalyticsView({ area: "quality", window: { from: 5, to: 4 } });
  assert.equal(store.getState().analytics.area, "quality", "the valid member applies");
  assert.equal(store.getState().analytics.window, "all", "the malformed window is ignored");
  store.setAnalyticsView({ filters: { station: null } });
  assert.equal(store.getState().analytics.filters.station, null, "null clears a filter");
});

test("switching workspaces never changes selection, hover, playhead, playback, speed or the floor's view", () => {
  const r = rng(11);
  const store = make();
  store.select("cell:LOCAL-031");
  store.seek(400_000);
  store.setSpeed(4);
  store.setView("blueprint");
  for (let i = 0; i < 60; i++) {
    const before = store.getState();
    const w = pick(r, ["floor", "timeline", "analytics"]);
    const how = pick(r, ["set", "helper"]);
    if (how === "set") store.setWorkspace(w);
    else if (w === "analytics") showInAnalytics(store);
    else if (w === "timeline") showInTimeline(store);
    else showOnFloor(store);
    const s = store.getState();
    assert.equal(s.workspace, w);
    for (const k of ["selection", "hovered", "playhead", "playing", "speed", "view", "following"]) assert.equal(s[k], before[k], `${k} after switching to ${w} (${how})`);
  }
});

test("Theater Mode is the floor's: it ends on leaving for Analytics and cannot start there", () => {
  const store = make();
  store.setTheater(true);
  showInAnalytics(store);
  assert.equal(store.getState().theater, false);
  store.setTheater(true);
  assert.equal(store.getState().theater, false);
});

test("the floor is held (inert to changes) while Analytics is up, and catches up once on return", () => {
  const store = make();
  const held = heldStore(store);
  let told = 0;
  held.subscribe(() => told++);
  showInAnalytics(store, { area: "flow" });
  assert.equal(held.held(), true);
  const frozen = held.getState();
  assert.equal(frozen.workspace, "floor", "the hidden floor never saw the switch");
  // The target is set while the floor is still up (one notification, interface state only); nothing after.
  told = 0;
  store.select("cell:LOCAL-032");
  store.seek(500_000);
  store.setAnalyticsView({ area: "quality" });
  assert.equal(told, 0, "nothing reached the hidden floor");
  assert.equal(held.getState(), frozen);
  showOnFloor(store);
  assert.equal(held.held(), false);
  assert.equal(held.getState().selection, "cell:LOCAL-032");
  assert.equal(told, 2, "caught up with one notification, then the framing request showOnFloor makes");
});

// ---------------------------------------------------------------- navigation helpers

test("showInAnalytics: sets the target (filters replaced, focus and pick reset) and switches; selection stays", () => {
  const store = make();
  store.select("station:LOCAL-031/build");
  store.setAnalyticsView({ filters: { risk: "high" }, focus: { metric: "K1", group: null }, compare: { a: { risk: "high" }, b: {} } });
  showInAnalytics(store, { area: "flow", filters: { station: "build" } });
  const s = store.getState();
  assert.equal(s.workspace, "analytics");
  assert.equal(s.selection, "station:LOCAL-031/build");
  assert.deepEqual(s.analytics.filters, { risk: null, appType: null, model: null, station: "build" }, "the link shows exactly what it says");
  assert.equal(s.analytics.focus, null);
  assert.ok(s.analytics.compare, "a comparison is kept");
  showInAnalytics(store, { area: "quality", filters: { station: "review" }, focus: { metric: "R1", group: null } });
  assert.deepEqual(store.getState().analytics.focus, { metric: "R1", group: null });
  const before = store.getState().analytics;
  showInAnalytics(store);
  assert.equal(store.getState().analytics, before, "no target: only the switch");
});

test("from Analytics: showInTimeline with a window focuses the interval; showOnFloor with a ref selects it", () => {
  const store = make();
  showInAnalytics(store, { area: "flow" });
  showInTimeline(store, "cell:LOCAL-033", { window: { from: 100_000, to: 200_000 } });
  let s = store.getState();
  assert.equal(s.workspace, "timeline");
  assert.equal(s.selection, "cell:LOCAL-033");
  assert.deepEqual(s.timeline.window, { from: 100_000, to: 200_000 });
  assert.equal(s.focus.target, "cell:LOCAL-033", "the Timeline is asked to reveal it");
  showInAnalytics(store);
  showInTimeline(store, null, { window: { from: 5, to: 5 } });
  assert.deepEqual(store.getState().timeline.window, { from: 100_000, to: 200_000 }, "an empty interval is ignored");
  showInAnalytics(store);
  showOnFloor(store, "blueprint", { ref: "cell:LOCAL-031" });
  s = store.getState();
  assert.equal(s.workspace, "floor");
  assert.equal(s.view, "blueprint");
  assert.equal(s.selection, "cell:LOCAL-031");
  assert.equal(s.focus.target, "cell:LOCAL-031");
});

test("analyticsStationOf: the floor's station kinds map to Analytics' stations; intake and observe have none", () => {
  assert.equal(A.analyticsStationOf("human-approval"), "human");
  assert.equal(A.analyticsStationOf("build"), "build");
  assert.equal(A.analyticsStationOf("intake"), null);
  assert.equal(A.analyticsStationOf("observe"), null);
});

// ---------------------------------------------------------------- the address

test("hash: every Analytics view round-trips exactly, with any selection and moment (500 random views)", () => {
  const r = rng(6505);
  for (let i = 0; i < 500; i++) {
    const view = randomView(r);
    const sel = pick(r, SELS);
    const at = pick(r, ATS);
    const hash = formatHash({ route: "analytics", sel, at, win: null, group: "product", analytics: view });
    const h = parseHash(hash);
    assert.equal(h.route, "analytics", hash);
    assert.equal(h.sel, sel, hash);
    assert.deepEqual(h.at, at, hash);
    assert.ok(A.sameAnalyticsView(h.analytics, view), `${hash}\n${JSON.stringify(view)}\n${JSON.stringify(h.analytics)}`);
    assert.equal(h.win, null, "the Timeline's parameters are not read for Analytics");
    assert.equal(h.theater, false);
    assert.equal(formatHash({ route: "analytics", sel, at, win: null, group: "product", analytics: h.analytics }), hash, "canonical");
  }
});

test("hash: #atlas, #blueprint and #timeline round-trip exactly as before (property-style)", () => {
  const r = rng(63);
  for (let i = 0; i < 300; i++) {
    const route = pick(r, ["atlas", "blueprint", "timeline"]);
    const sel = pick(r, SELS);
    const at = pick(r, ATS);
    const timeline = route === "timeline";
    const win = timeline ? pick(r, [null, { from: 70000, to: 370000 }, { from: -Infinity, to: Infinity }, { from: -60000, to: Infinity }]) : null;
    const group = timeline ? pick(r, ["product", "execution"]) : "product";
    const lens = timeline ? pick(r, [null, "retries", "waits"]) : null;
    const table = timeline ? r() < 0.5 : false;
    const hash = formatHash({ route, sel, at, win, group, lens, table, analytics: randomView(r) });
    assert.ok(!/area=|risk=|cmp=|focus=|pick=/.test(hash), `no Analytics parameter outside Analytics: ${hash}`);
    const h = parseHash(hash);
    assert.equal(h.route, route);
    assert.equal(h.analytics, null);
    assert.equal(formatHash({ route, sel: h.sel, at: h.at, win: h.win, group: h.group ?? "product", lens: h.lens, table: h.table }), hash);
  }
  // Known old addresses, byte for byte.
  for (const old of ["#atlas", "#blueprint?sel=cell%3ALOCAL-031", "#timeline?sel=cell%3ALOCAL-031&at=300000&win=70000-370000&group=execution&lens=retries&table=1", "#timeline?win=all", "#timeline?win=live-60000"]) {
    const h = parseHash(old);
    assert.equal(formatHash({ route: h.route, sel: h.sel, at: h.at, win: h.win, group: h.group ?? "product", lens: h.lens, table: h.table }), old);
  }
  assert.equal(parseHash("#atlas?theater=1").theater, true, "Theater from the address still applies on the floor");
});

test("hash: unknown or malformed Analytics values are dropped alone, never thrown on", () => {
  const h = parseHash("#analytics?area=nowhere&win=3y&risk=extreme&app=web&model=gpt&station=build&cmp=risk:high,app:nope,zzz~*~x&focus=lowercase&pick=nodim&sel=bad&utm=1");
  assert.equal(h.route, "analytics");
  assert.deepEqual(h.analytics, { ...A.INITIAL_ANALYTICS_VIEW, filters: { risk: null, appType: "web", model: null, station: "build" } });
  assert.equal(h.sel, null);
  const c = parseHash("#analytics?cmp=risk:high,app:nope,zzz~*").analytics.compare;
  assert.deepEqual(c, { a: { risk: "high" }, b: {} }, "an unknown cohort member is dropped alone");
  assert.equal(parseHash("#analytics?focus=C1,station").analytics.focus, null);
  assert.deepEqual(parseHash("#analytics?focus=C1,station:build").analytics.focus, { metric: "C1", group: { dim: "station", value: "build" } });
  assert.equal(parseHash("#analytics?win=200-100").analytics.window, "all");
  const r = rng(99);
  const alphabet = "#?&=:,~*%-_abcdefghiklmnoprstuwxyz0123456789ÿ \u0000";
  for (let i = 0; i < 2000; i++) {
    let s = "#analytics?";
    const n = Math.floor(r() * 60);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(r() * alphabet.length)];
    const parsed = parseHash(s);
    assert.ok(parsed.analytics, s);
    const store = make();
    applyHash(store, parsed);
    assert.equal(store.getState().workspace, "analytics");
  }
});

test("hashSync: an Analytics view is written as #analytics (never as #atlas), and an address lands exactly", () => {
  const store = make();
  const host = { hash: "#atlas", getHash: () => host.hash, replaceHash: (h) => (host.hash = h), onHashChange: (l) => ((host.change = l), () => {}), onInteraction: () => () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  const sync = createHashSync(store, host);
  store.select("cell:LOCAL-031");
  showInAnalytics(store, { area: "flow", filters: { station: "build" } });
  assert.equal(host.hash, "#analytics?area=flow&station=build&sel=cell%3ALOCAL-031");
  store.setAnalyticsView({ focus: { metric: "C1", group: { dim: "station", value: "build" } } });
  assert.equal(host.hash, "#analytics?area=flow&station=build&sel=cell%3ALOCAL-031&focus=C1,station:build");
  showOnFloor(store);
  assert.equal(host.hash, "#atlas?sel=cell%3ALOCAL-031");
  // Back to an Analytics address (the browser's Back): the whole view as written.
  host.hash = "#analytics?area=quality&win=7d&risk=high&cmp=risk:high~risk:low";
  host.change();
  const s = store.getState();
  assert.equal(s.workspace, "analytics");
  assert.equal(s.selection, "cell:LOCAL-031", "an address without sel keeps the selection");
  assert.equal(s.analytics.area, "quality");
  assert.equal(s.analytics.window, "7d");
  assert.deepEqual(s.analytics.filters, { risk: "high", appType: null, model: null, station: null }, "station from before is not kept: the address is the whole view");
  assert.equal(s.analytics.focus, null);
  assert.deepEqual(s.analytics.compare, { a: { risk: "high" }, b: { risk: "low" } });
  sync.dispose();
});

// ---------------------------------------------------------------- keys

test("key map: no key bound twice in any of the three workspaces; 4 opens Analytics from anywhere", () => {
  const global = KEYMAP.filter((k) => !k.view);
  for (const ctx of ["floor", "timeline", "analytics"]) {
    const seen = new Map();
    for (const b of global) {
      if (!activeIn(b, ctx)) continue;
      for (const key of b.keys) {
        const k = /^[A-Z]$/.test(key) && !["T", "F"].includes(key) ? key.toLowerCase() : key;
        assert.ok(!seen.has(k) || seen.get(k) === b.action, `${ctx}: ${key} is both "${seen.get(k)}" and "${b.action}"`);
        seen.set(k, b.action);
      }
    }
    for (const k of ["1", "2", "3", "4"]) assert.ok(seen.has(k), `${ctx}: ${k}`);
    if (ctx !== "timeline") for (const k of Object.keys(TIMELINE_KEYS)) assert.ok(!seen.has(k), `${ctx}: ${k} is the Timeline's`);
  }
  assert.ok(KEYMAP.some((b) => b.keys.includes("4")), "4 is listed in the help");
});

function press(store, key, extra = {}) {
  const calls = [];
  const commands = { toggleInspector: () => calls.push("inspector"), toggleTimeline: () => calls.push("timeline"), openHelp: () => calls.push("help"), openSource: () => calls.push("source"), modalOpen: () => false };
  const e = { key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, target: null, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  shellKeyHandler(store, commands)(e);
  return { e, calls };
}

test("keys: 1 2 3 4 switch from every workspace keeping selection and playhead", () => {
  const store = make();
  store.select("cell:LOCAL-031");
  store.seek(300_000);
  const route = [["4", "analytics"], ["3", "timeline"], ["4", "analytics"], ["2", "floor"], ["4", "analytics"], ["1", "floor"], ["3", "timeline"], ["1", "floor"]];
  for (const [key, w] of route) {
    const { e } = press(store, key);
    const s = store.getState();
    assert.equal(s.workspace, w, key);
    assert.ok(e.prevented);
    assert.equal(s.selection, "cell:LOCAL-031");
    assert.equal(s.playhead, 300_000);
  }
  press(store, "4");
  press(store, "2");
  assert.equal(store.getState().view, "blueprint", "2 from Analytics lands on the Blueprint");
});

test("keys in Analytics: playback keys, F and T do nothing (no transport there); I, ?, S and Escape still work", () => {
  const store = make();
  store.select("cell:LOCAL-031");
  store.seek(300_000);
  showInAnalytics(store);
  const before = store.getState();
  for (const key of [" ", ",", ".", "[", "]", "{", "}", "Home", "End", "l", "L", "f", "F", "t", "T"]) {
    const { e } = press(store, key);
    assert.equal(e.prevented, false, `${JSON.stringify(key)} is not handled in Analytics`);
  }
  const s = store.getState();
  for (const k of ["playhead", "playing", "speed", "following", "theater", "follow", "focus"]) assert.equal(s[k], before[k], k);
  assert.deepEqual(press(store, "i").calls, ["inspector"]);
  assert.deepEqual(press(store, "?").calls, ["help"]);
  assert.deepEqual(press(store, "s").calls, ["source"]);
  press(store, "Escape");
  assert.equal(store.getState().selection, null);
  // And the same keys still play on the floor.
  showOnFloor(store);
  assert.ok(press(store, " ").e.prevented);
  assert.equal(store.getState().playing, true);
});

// ---------------------------------------------------------------- as of

test("analyticsAsOf: the whole history at the edge; through the playhead when it is held behind; the source said", () => {
  const clock = (t) => `T${t}`;
  const edge = analyticsAsOf({ source: "live", following: true, playhead: 9e12, liveAt: 9e12, connection: { state: "live" } }, clock);
  assert.equal(edge.through, "edge");
  assert.equal(edge.toMs, null);
  assert.equal(edge.sourceLabel, "Live");
  const behind = analyticsAsOf({ source: "replay", following: false, playhead: 1_700_000_123_456, liveAt: 1_700_000_900_000, connection: null }, clock);
  assert.equal(behind.through, "playhead");
  assert.equal(behind.toMs, 1_700_000_123_000);
  assert.equal(behind.sourceLabel, "Historical replay");
  assert.match(behind.caption, /Through the playhead at T1700000123000/);
  const sim = analyticsAsOf({ source: "simulation", following: true, playhead: 10, liveAt: 10, connection: null }, clock);
  assert.equal(sim.sourceLabel, "Simulation");
  assert.match(sim.caption, /simulated/i);
});

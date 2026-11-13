// M6.3 shell: the address's hash (grammar, old URLs, `at` that waits for history), workspace
// switching, the keyboard map, and the controls' pure framing helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim } from "./_load.mjs";

const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { parseHash, formatHash, parseAt, parseWin } = await import("../src/shell/source/hash.ts");
const { applyHash, createHashSync, honourAt, atOf } = await import("../src/shell/source/hashSync.ts");
const { KEYMAP, TIMELINE_KEYS } = await import("../src/shell/keyboard.ts");
const frame = await import("../src/timeline/controls/frame.ts");
const { MIN_WINDOW_MS } = await import("../src/timeline/contract.ts");
const { SCENARIO } = sim;

const make = (extra = {}) => createSceneStore({ fixture: SCENARIO, clock: manualClock(), ...extra });

/** A fake browser: the hash, its writes, timers run by hand, and the person's first input. */
function fakeHost(hash) {
  const timers = new Map();
  let next = 1;
  const host = {
    hash,
    writes: [],
    hashListeners: new Set(),
    inputListeners: new Set(),
    getHash: () => host.hash,
    replaceHash(h) {
      if (h === host.hash) return;
      host.hash = h;
      host.writes.push(h);
    },
    onHashChange(l) {
      host.hashListeners.add(l);
      return () => host.hashListeners.delete(l);
    },
    onInteraction(l) {
      host.inputListeners.add(l);
      return () => host.inputListeners.delete(l);
    },
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    flush() {
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.fn();
      }
    },
    navigate(h) {
      host.hash = h;
      for (const l of [...host.hashListeners]) l();
    },
    interact() {
      for (const l of [...host.inputListeners]) l();
    },
    pendingTimers: () => timers.size,
  };
  return host;
}

// ---------------------------------------------------------------- grammar

test("hash grammar: every part of the Timeline form parses", () => {
  const h = parseHash("#timeline?sel=cell%3ALOCAL-031&at=sim%3A12&win=60000-900000&group=execution");
  assert.equal(h.route, "timeline");
  assert.equal(h.sel, "cell:LOCAL-031");
  assert.deepEqual(h.at, { kind: "event", id: "sim:12" });
  assert.deepEqual(h.win, { from: 60000, to: 900000 });
  assert.equal(h.group, "execution");
  assert.equal(h.theater, false);
  assert.deepEqual(parseHash("#timeline?at=1731500000123").at, { kind: "ms", ms: 1731500000123 });
});

test("hash grammar: parse and format round-trip", () => {
  const cases = [
    { route: "timeline", sel: "station:LOCAL-031/build", at: { kind: "event", id: "cell-lifecycle/LOCAL-031:17" }, win: { from: 5, to: 600005 }, group: "execution" },
    { route: "timeline", sel: null, at: { kind: "ms", ms: 1731500000123 }, win: null, group: "product" },
    { route: "atlas", sel: "cell:LOCAL-031", at: null, win: null, group: "product" },
    { route: "blueprint", sel: "seat:LOCAL-031/review#2/security", at: { kind: "ms", ms: 0 }, win: null, group: "product" },
  ];
  for (const c of cases) {
    const text = formatHash(c);
    const back = parseHash(text);
    assert.equal(back.route, c.route, text);
    assert.equal(back.sel, c.sel, text);
    assert.deepEqual(back.at, c.at, text);
    assert.deepEqual(back.win, c.route === "timeline" ? c.win : null, text);
    assert.equal(back.group ?? "product", c.group, text);
    assert.equal(formatHash({ ...c, group: back.group ?? "product", win: back.win }), text, "stable");
  }
  // The default grouping is not written; win and group are the Timeline's only.
  assert.equal(formatHash({ route: "timeline", sel: null, at: null, win: null, group: "product" }), "#timeline");
  assert.equal(formatHash({ route: "atlas", sel: null, at: null, win: { from: 1, to: 2 }, group: "execution" }), "#atlas");
});

test("hash grammar: malformed and unknown parts are dropped one by one, never thrown", () => {
  const bad = [
    "",
    "#",
    "#?",
    "#nowhere?sel=cell:LOCAL-031",
    "#timeline?sel=%E0%A4%A&at=%&win=9-3&group=gantt&zzz=1",
    "#timeline?win=-5-10&at=12.5",
    "#timeline?at=" + "x".repeat(600),
    "#timeline?at=a%20b&sel=not-a-ref",
    "#timeline?=&&&sel",
    "#atlas?win=1-2&group=execution",
  ];
  for (const text of bad) assert.doesNotThrow(() => parseHash(text), text);
  const h = parseHash("#timeline?sel=%E0%A4%A&at=%&win=9-3&group=gantt&zzz=1");
  assert.equal(h.route, "timeline");
  assert.deepEqual([h.sel, h.at, h.win, h.group], [null, null, null, null]);
  assert.equal(parseHash("#nowhere?sel=cell:LOCAL-031").route, null);
  assert.equal(parseHash("#nowhere?sel=cell:LOCAL-031").sel, "cell:LOCAL-031", "a selection still applies");
  assert.equal(parseHash("#atlas?win=1-2&group=execution").win, null);
  assert.equal(parseAt("12.5")?.kind, "event", "not a whole number of ms: taken as an id, which simply never matches");
  assert.equal(parseAt("a b"), null);
  assert.equal(parseWin("10-10"), null);
  assert.equal(parseWin("99999999999999999-99999999999999999"), null);
  // The first of a repeated parameter wins.
  assert.equal(parseHash("#atlas?sel=cell:A&sel=cell:B").sel, "cell:A");
});

// ---------------------------------------------------------------- old URLs keep working

test("old URL: #atlas?sel=cell:LOCAL-031 selects on the Atlas, on the floor", () => {
  const store = make();
  store.setView("blueprint");
  store.setWorkspace("timeline");
  applyHash(store, parseHash("#atlas?sel=cell:LOCAL-031"));
  const s = store.getState();
  assert.equal(s.view, "atlas");
  assert.equal(s.workspace, "floor");
  assert.equal(s.selection, "cell:LOCAL-031");
  assert.equal(s.focus?.target, "cell:LOCAL-031", "as before: the view frames the selection");
  assert.equal(s.theater, false);
  assert.equal(formatHash({ route: s.view, sel: s.selection, at: null, win: null, group: "product" }), "#atlas?sel=cell%3ALOCAL-031", "written as before M6.3");
});

test("old URL: #blueprint?sel=…&theater=1 opens the Blueprint in Theater Mode; theater is ignored for the Timeline", () => {
  const store = make();
  applyHash(store, parseHash("#blueprint?sel=station%3ALOCAL-031%2Fbuild&theater=1"));
  let s = store.getState();
  assert.equal(s.view, "blueprint");
  assert.equal(s.selection, "station:LOCAL-031/build");
  assert.equal(s.theater, true);
  const other = make();
  applyHash(other, parseHash("#timeline?theater=1"));
  s = other.getState();
  assert.equal(s.workspace, "timeline");
  assert.equal(s.theater, false);
});

test("#timeline applies workspace, selection, grouping and window, and keeps the floor's view", () => {
  const store = make();
  store.setView("blueprint");
  applyHash(store, parseHash("#timeline?sel=cell:LOCAL-032&win=60000-600000&group=execution"));
  const s = store.getState();
  assert.equal(s.workspace, "timeline");
  assert.equal(s.view, "blueprint");
  assert.equal(s.selection, "cell:LOCAL-032");
  assert.equal(s.timeline.grouping, "execution");
  assert.deepEqual(s.timeline.window, { from: 60000, to: 600000 });
});

// ---------------------------------------------------------------- `at`, and writing the address

test("at (simulation): a time seeks at once; an event id seeks through seekToEvent", () => {
  const store = make();
  const host = fakeHost("#atlas?at=600000");
  applyHash(store, parseHash(host.hash));
  const sync = createHashSync(store, host);
  assert.equal(store.getState().playhead, 600000);
  assert.equal(sync.pending(), null);
  sync.dispose();
  const entry = store.getState().log.entries()[40];
  const other = make();
  const host2 = fakeHost(`#blueprint?at=${encodeURIComponent(entry.id)}`);
  const sync2 = createHashSync(other, host2);
  assert.equal(other.getState().playhead, entry.t);
  sync2.dispose();
});

/** A stand-in for a live store whose history arrives later (only what the hash sync reads). */
function lateStore() {
  const listeners = new Set();
  const entries = new Map();
  let state = {
    source: "live",
    log: { entry: (id) => entries.get(id), headTime: () => (entries.size ? 5_000_000 : null), times: () => [], entries: () => [] },
    extent: { start: 4_000_000, end: 5_000_000 },
    liveAt: 5_000_000,
    playhead: 5_000_000,
    following: true,
    playing: false,
    view: "atlas",
    workspace: "timeline",
    selection: null,
    timeline: { window: null, grouping: "product", expanded: [], filters: {}, table: false },
  };
  const seeks = [];
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  return {
    seeks,
    arrive(id, t) {
      entries.set(id, { id, t });
      set({});
    },
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    seek(t) {
      seeks.push(t);
      set({ playhead: t, following: false });
    },
    seekToEvent(id) {
      const e = entries.get(id);
      if (e) this.seek(e.t);
    },
  };
}

test("at (live): waits until history holds the event, then seeks once", () => {
  const store = lateStore();
  const host = fakeHost("#timeline?at=cell-lifecycle%2FLOCAL-031%3A7");
  const sync = createHashSync(store, host);
  assert.deepEqual(store.seeks, []);
  assert.deepEqual(sync.pending(), { kind: "event", id: "cell-lifecycle/LOCAL-031:7" });
  store.arrive("other:1", 4_100_000);
  assert.deepEqual(store.seeks, []);
  store.arrive("cell-lifecycle/LOCAL-031:7", 4_200_000);
  assert.deepEqual(store.seeks, [4_200_000]);
  assert.equal(sync.pending(), null);
  store.arrive("later:1", 4_900_000);
  assert.deepEqual(store.seeks, [4_200_000], "honoured once");
  sync.dispose();
});

test("at (live): never moves the playhead after the person's own first input", () => {
  const store = lateStore();
  const host = fakeHost("#timeline?at=cell-lifecycle%2FLOCAL-031%3A7");
  const sync = createHashSync(store, host);
  host.interact();
  assert.equal(sync.pending(), null);
  store.arrive("cell-lifecycle/LOCAL-031:7", 4_200_000);
  assert.deepEqual(store.seeks, []);
  sync.dispose();
});

test("at (live, ms): honoured only within what is held", () => {
  const store = lateStore();
  assert.equal(honourAt(store, { kind: "ms", ms: 4_500_000 }), false, "nothing received yet");
  store.arrive("x:1", 4_100_000);
  assert.equal(honourAt(store, { kind: "ms", ms: 3_000_000 }), false, "before the history held");
  assert.equal(honourAt(store, { kind: "ms", ms: 9_000_000 }), false, "after the live edge");
  assert.equal(honourAt(store, { kind: "ms", ms: 4_500_000 }), true);
  assert.deepEqual(store.seeks, [4_500_000]);
});

test("writing: at only once the playhead is held still and settles; win after the window settles; never per frame", () => {
  const clock = manualClock();
  const store = createSceneStore({ fixture: SCENARIO, clock });
  const host = fakeHost("#atlas");
  const sync = createHashSync(store, host);
  store.select("cell:LOCAL-031");
  assert.equal(host.hash, "#atlas?sel=cell%3ALOCAL-031");
  store.play();
  clock.frames(1, 0);
  const writes = host.writes.length;
  clock.frames(30, 16);
  assert.equal(host.writes.length, writes, "playing writes nothing");
  store.pause();
  store.seek(600_000);
  assert.ok(!host.hash.includes("at="), "not before it settles");
  host.flush();
  assert.equal(host.hash, "#atlas?sel=cell%3ALOCAL-031&at=600000");
  // On an event exactly: its id, stable across a rebuilt index.
  const entry = store.getState().log.entries()[25];
  store.seek(entry.t);
  host.flush();
  assert.deepEqual(atOf(store.getState()), { kind: "event", id: atOf(store.getState()).id });
  assert.ok(host.hash.includes(`at=${encodeURIComponent(atOf(store.getState()).id)}`), host.hash);
  // The Timeline: route, window (settled), grouping.
  store.setWorkspace("timeline");
  store.setTimelineView({ window: { from: 60_000, to: 360_000 }, grouping: "execution" });
  assert.ok(!host.hash.includes("win="));
  store.setTimelineView({ window: { from: 70_000, to: 370_000 } });
  host.flush();
  assert.ok(host.hash.startsWith("#timeline?sel=cell%3ALOCAL-031&at="), host.hash);
  assert.ok(host.hash.endsWith("&win=70000-370000&group=execution"), host.hash);
  // Playing again drops at at once.
  store.play();
  assert.ok(!host.hash.includes("at="), host.hash);
  store.pause();
  sync.dispose();
});

test("a hash change applies again; unknown parameters do not disturb anything", () => {
  const store = make();
  const host = fakeHost("#atlas");
  const sync = createHashSync(store, host);
  host.navigate("#timeline?sel=cell:LOCAL-033&utm=x&at=300000");
  const s = store.getState();
  assert.equal(s.workspace, "timeline");
  assert.equal(s.selection, "cell:LOCAL-033");
  assert.equal(s.playhead, 300000);
  sync.dispose();
});

// ---------------------------------------------------------------- the keyboard map

test("key map: the workspace keys and the Timeline's keys collide with nothing", () => {
  const global = KEYMAP.filter((k) => !k.view);
  const label = (k) => (k.length === 1 ? k.toLowerCase() : k.toLowerCase());
  const byContext = { floor: new Map(), timeline: new Map() };
  for (const b of global) {
    for (const ctx of ["floor", "timeline"]) {
      if (b.workspace && b.workspace !== ctx) continue;
      for (const key of b.keys) {
        // Letters are listed in capitals and handled in both cases, except T (t: Theater, Shift+T: timeline) and F.
        const k = /^[A-Z]$/.test(key) && !["T", "F"].includes(key) ? key.toLowerCase() : key;
        const seen = byContext[ctx].get(k);
        assert.ok(!seen || seen === b.action, `${ctx}: ${key} is both "${seen}" and "${b.action}"`);
        byContext[ctx].set(k, b.action);
      }
    }
  }
  for (const key of Object.keys(TIMELINE_KEYS)) {
    const owners = global.filter((b) => b.workspace !== "timeline" && b.keys.some((k) => label(k) === key));
    assert.deepEqual(owners.map((b) => b.action), [], `${key} is free outside the Timeline`);
  }
  assert.ok(byContext.floor.has("3") && byContext.timeline.has("3"), "3 opens the Timeline from anywhere");
  assert.ok(KEYMAP.some((b) => b.keys.includes("T") && /floor only/i.test(b.action)), "the help sheet says what t does in the Timeline");
  for (const key of Object.keys(TIMELINE_KEYS)) assert.ok(KEYMAP.some((b) => b.workspace === "timeline" && b.keys.map((k) => k.toLowerCase()).includes(key)), `${key} is listed in the help`);
});

// ---------------------------------------------------------------- framing helpers

test("framing: clamp, frame, pan; refs from spans", () => {
  const whole = { from: 0, to: 3_600_000 };
  assert.deepEqual(frame.clampWindow({ from: -10, to: 4_000_000 }, whole), frame.ALL_WINDOW, "all of it: the whole history, following again");
  assert.ok(frame.isAll(frame.clampWindow({ from: Number.NaN, to: 5 }, whole)), "not a window: all of it");
  assert.deepEqual(frame.clampWindow({ from: 100, to: 200 }, whole), { from: 0, to: MIN_WINDOW_MS }, "never narrower than the minimum, kept within the history");
  assert.deepEqual(frame.clampWindow({ from: 3_590_000, to: 3_700_000 }, whole), { from: 3_490_000, to: 3_600_000 });
  assert.deepEqual(frame.frameExtent({ from: 100_000, to: 200_000 }), { from: 90_000, to: 210_000 });
  const w = { from: 0, to: 60_000 };
  assert.equal(frame.panToInclude(w, { from: 30_000, to: 90_000 }), w, "already in view: unchanged");
  assert.deepEqual(frame.panToInclude(w, { from: 600_000, to: 600_000 }), { from: 570_000, to: 630_000 });
  const span = (id, entity, parent) => ({ id, kind: id.slice(0, id.indexOf(":")), entity, parent, start: { at: 0, notBefore: null, notAfter: null }, end: null });
  const agent = span("agent:agent:x/7", "agent:x/7", "workflow:workflow:x/w");
  const wf = span("workflow:workflow:x/w", "workflow:x/w", "execution:execution:x");
  const byId = new Map([[wf.id, wf]]);
  assert.equal(frame.refForSpan(agent, byId, (r) => r === "agent:x/7"), "agent:x/7");
  assert.equal(frame.refForSpan(agent, byId, (r) => r === "execution:x"), "execution:x", "up through a loaded parent and one known only by id");
  assert.equal(frame.refForSpan(agent, byId, () => false), null);
  assert.equal(frame.spanIdForRef("cell:LOCAL-031"), "cell:cell:LOCAL-031");
  assert.equal(frame.spanIdForRef("finding:x"), null);
  assert.deepEqual(frame.toggled(["a", "b"], "a"), ["b"]);
  assert.deepEqual(frame.toggled(["b"], "a"), ["b", "a"]);
});

// ---------------------------------------------------------------- wave 2: the default window

const { locateEvent } = await import("../src/shell/source/locate.ts");
const { showOnFloor, showInTimeline } = await import("../src/scene/store.ts");

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 12, 5, 29);
/** A span with recorded ends (end null: open). */
const sp = (id, from, to, ids = {}, kind = "visit") => ({
  id,
  kind,
  entity: id.slice(id.indexOf(":") + 1),
  parent: null,
  ids,
  start: { eventId: `${id}/start`, at: from, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null },
  end: to === null ? null : { eventId: `${id}/end`, at: to, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "completed" },
  duration: { ms: to === null ? null : to - from, minMs: null, maxMs: null, basis: to === null ? "open" : "measured" },
  outcome: null,
  authority: "observed",
  attrs: {},
});

test("default window: frames the recorded activity, not the wall clock (the real run: 73 min of work, viewed 7 h later)", () => {
  const whole = { from: T0, to: T0 + 8 * H + 13 * 60_000 };
  const lastEnd = T0 + 73 * 60_000;
  const density = { from: whole.from, to: whole.to, bucketMs: 60_000, buckets: [{ from: T0, count: 5 }, { from: lastEnd - 60_000, count: 2 }], complete: true };
  const spans = [sp("cell:cell:LOCAL-1", T0 + 10_000, lastEnd - 30_000)];
  const w = frame.activityWindow({ whole, dataFrom: T0, density, spans, lastMark: null, followingLive: false });
  const len = lastEnd - T0;
  assert.equal(w.from, T0, "never before the history: the pad stops at its start");
  assert.equal(w.to, lastEnd + len * frame.ACTIVITY_PAD, "the last bucket's end, padded 2%");
  // A later mark extends it; its `until` counts.
  const mark = { id: "m", kind: "human", at: lastEnd + 10 * 60_000, until: lastEnd + 20 * 60_000, eventId: null, entity: null, label: "", verdict: null, authority: "observed" };
  const w2 = frame.activityWindow({ whole, dataFrom: T0, density, spans, lastMark: mark, followingLive: false });
  assert.ok(Math.abs(w2.to - (lastEnd + 20 * 60_000) * 1 - (lastEnd + 20 * 60_000 - T0) * frame.ACTIVITY_PAD) < 1, String(w2.to - lastEnd));
  // Something open, live and following: it follows the live edge.
  const open = [...spans, sp("visit:visit:LOCAL-1/build#2", lastEnd - 5_000, null)];
  assert.equal(frame.activityWindow({ whole, dataFrom: T0, density, spans: open, lastMark: null, followingLive: true }).to, whole.to);
  // The same open span, reviewed (not following): the recorded activity still.
  assert.ok(frame.activityWindow({ whole, dataFrom: T0, density, spans: open, lastMark: null, followingLive: false }).to < whole.to);
  // Nothing recorded: the whole history.
  assert.deepEqual(frame.activityWindow({ whole, dataFrom: null, density: null, spans: [], lastMark: null, followingLive: false }), whole);
  // Without data.extent(), the first bucket or span starts it.
  const w3 = frame.activityWindow({ whole, dataFrom: null, density: { ...density, buckets: [{ from: T0 + H, count: 1 }] }, spans: [], lastMark: null, followingLive: false });
  assert.ok(w3.from < T0 + H && w3.from > T0 + H - 60_000, "padded before the first bucket");
  // Never narrower than the minimum.
  const tiny = frame.activityWindow({ whole, dataFrom: null, density: null, spans: [sp("x:x", T0 + H, T0 + H + 100)], lastMark: null, followingLive: false });
  assert.ok(tiny.to - tiny.from >= MIN_WINDOW_MS);
});

test("default window: null frames the activity, ALL the whole history, a chosen window itself", () => {
  const whole = { from: 0, to: 100 };
  const fallback = { from: 10, to: 20 };
  assert.deepEqual(frame.resolveWindow(null, whole, fallback), fallback);
  assert.deepEqual(frame.resolveWindow(frame.ALL_WINDOW, whole, fallback), whole);
  assert.deepEqual(frame.resolveWindow({ from: 30, to: 40 }, whole, fallback), { from: 30, to: 40 });
  assert.equal(frame.isAll(null), false);
  assert.equal(frame.windowLengthWords(73 * 60_000), "1 h 13 min");
  assert.equal(frame.windowLengthWords(45_000), "45 s");
  assert.equal(frame.windowLengthWords(12 * 60_000), "12 min");
  assert.equal(frame.windowLengthWords(5 * 60_000 + 30_000), "5 min 30 s");
  assert.equal(frame.windowLengthWords(52 * H), "2 d 4 h");
});

// ---------------------------------------------------------------- filters and chips

test("filters: every value in the window stays on offer while a filter is on; one chip per choice", () => {
  const spans = [
    sp("visit:a", 0, 10, { ticket_id: "LOCAL-1", execution_id: "x1", slice_id: "SLICE-1", station: "build" }),
    sp("seat:b", 0, 10, { ticket_id: "LOCAL-2", slice_id: "SLICE-2" }, "seat"),
  ];
  const filters = { tickets: ["LOCAL-1"], executions: [], slices: [], stations: [], kinds: ["agent"], attentionOnly: true };
  const o = frame.filterOptionsOfSpans(spans, filters);
  assert.deepEqual(o.tickets, ["LOCAL-1", "LOCAL-2"]);
  assert.deepEqual(o.executions, ["x1"]);
  assert.deepEqual(o.stations, ["build", "review"], "a seat belongs to review");
  assert.deepEqual(o.kinds, ["agent", "seat", "visit"], "a chosen kind with nothing in the window is still offered, to be undone");
  const chips = frame.filterChips(filters, (k) => `K ${k}`);
  assert.deepEqual(chips.map((c) => c.label), ["Needs attention", "LOCAL-1", "K agent"]);
  assert.deepEqual(chips[1].without, { tickets: [] });
  assert.deepEqual(chips[0].without, { attentionOnly: false });
});

// ---------------------------------------------------------------- the interval on the floor

test("interval: the cells active in a chosen window are highlighted on the floor, only while nothing is hovered or selected", () => {
  const spans = [
    sp("visit:a", 100_000, 200_000, { ticket_id: "LOCAL-031" }),
    sp("cell:cell:LOCAL-032", 150_000, 400_000, {}, "cell"),
    sp("visit:c", 500_000, 600_000, { ticket_id: "LOCAL-033" }),
    sp("visit:d", 120_000, 130_000, { ticket_id: "LOCAL-031" }),
  ];
  const refs = frame.cellsInInterval(spans, { from: 150_000, to: 300_000 });
  assert.deepEqual(refs, ["cell:LOCAL-031", "cell:LOCAL-032"]);
  const store = make();
  store.seek(1_200_000);
  assert.deepEqual(store.getState().highlighted, []);
  store.setHighlightInterval({ from: 150_000, to: 300_000, refs });
  assert.deepEqual(store.getState().highlighted, refs);
  const before = store.getState();
  store.setHighlightInterval({ from: 150_000, to: 300_000, refs: [...refs] });
  assert.equal(store.getState(), before, "the same interval again changes nothing");
  store.select("cell:LOCAL-033", { focus: false });
  assert.ok(!store.getState().highlighted.includes("cell:LOCAL-032"), "a selection's relations win: not a second selection model");
  store.select(null);
  assert.deepEqual(store.getState().highlighted, refs, "back to the interval");
  store.hover("cell:LOCAL-033");
  assert.ok(!store.getState().highlighted.includes("cell:LOCAL-032"));
  store.hover(null);
  store.setHighlightInterval(null);
  assert.deepEqual(store.getState().highlighted, []);
  assert.equal(store.getState().interval, null);
});

// ---------------------------------------------------------------- lenses

test("lens: choosing one applies its preset (seeing the window as drawn) and sets the lens", () => {
  const seen = [];
  const lens = {
    id: "retries",
    label: "Retries",
    about: "Rounds and attempts that ran again, from the review and execution records.",
    preset(tree, view) {
      seen.push(view.window);
      return { grouping: "execution", filters: { ...view.filters, attentionOnly: true } };
    },
  };
  const view = { window: { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY }, grouping: "product", expanded: [], filters: { tickets: [], executions: [], slices: [], stations: [], kinds: [], attentionOnly: false }, table: false, lens: null };
  const patch = frame.applyLens(lens, { roots: [], byId: new Map() }, view, { from: 1, to: 2 });
  assert.equal(patch.lens, "retries");
  assert.equal(patch.grouping, "execution");
  assert.equal(patch.filters.attentionOnly, true);
  assert.deepEqual(seen[0], { from: 1, to: 2 }, "never the stored 'all' sentinel");
  frame.applyLens(lens, { roots: [], byId: new Map() }, { ...view, window: null }, { from: 1, to: 2 });
  assert.equal(seen[1], null, "no window chosen stays unchosen");
  // Applied through the store, the lens and its preset land together; clearing returns to no lens.
  const store = make();
  store.setTimelineView(patch);
  assert.equal(store.getState().timeline.lens, "retries");
  assert.equal(store.getState().timeline.grouping, "execution");
  store.setTimelineView({ lens: null });
  assert.equal(store.getState().timeline.lens, null);
});

// ---------------------------------------------------------------- the address: lens, table, all

test("hash grammar: lens, table and win=all (Timeline only), round-trip, and applied", () => {
  const h = parseHash("#timeline?sel=cell%3ALOCAL-031&win=all&lens=waits&table=1");
  assert.equal(h.lens, "waits");
  assert.equal(h.table, true);
  assert.ok(frame.isAll(h.win));
  assert.equal(parseHash("#timeline?lens=everything").lens, null, "an unknown lens is dropped");
  assert.equal(parseHash("#timeline?table=yes").table, false);
  assert.equal(parseHash("#atlas?lens=waits&table=1").lens, null);
  assert.equal(parseHash("#atlas?lens=waits&table=1").table, false);
  const text = formatHash({ route: "timeline", sel: "cell:LOCAL-031", at: null, win: frame.ALL_WINDOW, group: "execution", lens: "review", table: true });
  assert.equal(text, "#timeline?sel=cell%3ALOCAL-031&win=all&group=execution&lens=review&table=1");
  const back = parseHash(text);
  assert.deepEqual([back.lens, back.table, frame.isAll(back.win), back.group], ["review", true, true, "execution"]);
  assert.equal(formatHash({ route: "atlas", sel: null, at: null, win: null, group: "product", lens: "review", table: true }), "#atlas");
  const store = make();
  applyHash(store, h);
  assert.equal(store.getState().timeline.lens, "waits");
  assert.equal(store.getState().timeline.table, true);
  assert.ok(frame.isAll(store.getState().timeline.window));
  // Written back from the store.
  const host = fakeHost("#timeline");
  const sync = createHashSync(store, host);
  store.select("cell:LOCAL-031", { focus: false });
  assert.ok(host.hash.includes("lens=waits") && host.hash.includes("table=1"), host.hash);
  store.setTimelineView({ lens: null, table: false });
  assert.ok(!host.hash.includes("lens=") && !host.hash.includes("table="), host.hash);
  sync.dispose();
});

// ---------------------------------------------------------------- an `at` outside what is held

/** lateStore, connected and caught up, with a history window loader stand-in: seeking a time "loads" the events near it. */
function windowedStore(events) {
  const store = lateStore();
  const base = store.getState();
  store.arrive("held:1", 4_900_000);
  const s = store.getState();
  Object.assign(s, { connection: { state: "live" } });
  const seek = store.seek.bind(store);
  store.seek = (t) => {
    for (const [id, at] of events) if (Math.abs(at - t) < 60_000) store.arrive(id, at);
    seek(t);
  };
  void base;
  return store;
}

test("at (event outside what is held): looked up, then honoured as its time; not found, the person is told", async () => {
  const store = windowedStore([["review-log/LOCAL-031:3", 4_300_000]]);
  const host = fakeHost("#timeline?at=review-log%2FLOCAL-031%3A3");
  const lost = [];
  const asked = [];
  const sync = createHashSync(store, host, undefined, {
    locate: async (id) => {
      asked.push(id);
      return 4_300_000;
    },
    onLost: (at, why) => lost.push([at, why]),
  });
  store.arrive("held:2", 4_950_000); // any change tries again; it is asked once
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked, ["review-log/LOCAL-031:3"]);
  assert.deepEqual(store.seeks.at(-1), 4_300_000);
  assert.equal(sync.pending(), null);
  assert.deepEqual(lost, []);
  sync.dispose();

  const store2 = windowedStore([]);
  const lost2 = [];
  const sync2 = createHashSync(store2, fakeHost("#timeline?at=nowhere%3A1"), undefined, { locate: async () => null, onLost: (at, why) => lost2.push([at.id, why]) });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(lost2, [["nowhere:1", "not-found"]]);
  assert.equal(sync2.pending(), null);
  assert.deepEqual(store2.seeks, [], "the playhead is left where it was");
  sync2.dispose();
});

test("at: never dropped silently: an unknown simulation event, and one the person moved past first, are both said", () => {
  const lost = [];
  const sync = createHashSync(make(), fakeHost("#atlas?at=sim%3Anope"), undefined, { onLost: (at, why) => lost.push([at.id, why]) });
  assert.deepEqual(lost, [["sim:nope", "not-found"]]);
  sync.dispose();
  const store = lateStore();
  const host = fakeHost("#timeline?at=cell-lifecycle%2FLOCAL-031%3A7");
  const lost2 = [];
  const sync2 = createHashSync(store, host, undefined, { onLost: (at, why) => lost2.push(why) });
  host.interact();
  assert.deepEqual(lost2, ["interrupted"]);
  sync2.dispose();
});

test("locate: an event id is found through the marks, then the ends of spans; null when nothing names it", async () => {
  const marks = [{ id: "m1", kind: "gate", at: 700, until: null, eventId: "gate:9", entity: null, label: "", verdict: null, authority: "observed" }];
  const spans = [sp("visit:v", 100, 300)];
  const data = { marks: async () => marks, spans: async () => ({ spans, truncated: false, total: 1, version: "1" }) };
  const whole = { from: 0, to: 1000 };
  assert.equal(await locateEvent(data, whole, "gate:9"), 700);
  assert.equal(await locateEvent(data, whole, "visit:v/start"), 100);
  assert.equal(await locateEvent(data, whole, "visit:v/end"), 300);
  assert.equal(await locateEvent(data, whole, "other:1"), null);
});

// ---------------------------------------------------------------- across the experiences

test("cross-experience: 3 frames the selection in the Timeline; 1 and 2 return to the floor keeping selection and playhead, and frame it there", () => {
  const store = make();
  store.seek(900_000);
  store.select("cell:LOCAL-031");
  showInTimeline(store);
  let s = store.getState();
  assert.equal(s.workspace, "timeline");
  assert.equal(s.focus?.target, "cell:LOCAL-031", "the Timeline reveals the focus request");
  const nonce = s.focus.nonce;
  showOnFloor(store, "blueprint");
  s = store.getState();
  assert.equal(s.workspace, "floor");
  assert.equal(s.view, "blueprint");
  assert.equal(s.selection, "cell:LOCAL-031");
  assert.equal(s.playhead, 900_000);
  assert.ok(s.focus.nonce > nonce && s.focus.target === "cell:LOCAL-031", "the floor frames it with the existing focusOn");
});

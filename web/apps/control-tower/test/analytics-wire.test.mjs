// M6.5.4/M6.5.6: the production Analytics workspace's wiring (src/analytics/wire). The store's state
// and the workspace's view both ways (and through the address), the period and "as of" rules as the
// workspace applies them, the source label rule, drill-down queries, one cursor per view through the
// loader, and the history entries that make Back return to Analytics.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const V = await import("../src/analytics/wire/view.ts");
const Q = await import("../src/analytics/wire/query.ts");
const L = await import("../src/analytics/wire/load.ts");
const A = await import("../src/scene/analytics.ts");
const { parseHash, formatHash } = await import("../src/shell/source/hash.ts");
const { createHashSync } = await import("../src/shell/source/hashSync.ts");
const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const { simulatedAnalytics } = await import("../src/analytics/data/simulation.ts");
const { beginSnapshot } = await import("../src/analytics/data/snapshot.ts");
const { FIXTURE_END } = await import("../src/analytics/fixtures/index.ts");
const { sim } = await import("./_load.mjs");

const D = 86_400_000;

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

// ------------------------------------------------------------------------------------ store <-> view

test("store state and workspace view round-trip (property-style, 300 seeds)", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const by = pick(r, ["risk", "app_type", "period", "config", null]);
    const key = (b) => (b === "risk" ? pick(r, ["High", "Low", "Medium", "unknown"]) : b === "app_type" ? pick(r, ["cli", "web", "unknown"]) : b === "period" ? pick(r, ["earlier", "later"]) : pick(r, ["0123abcd" + "e".repeat(56), "not-recorded", "mixed"]));
    const ui = {
      area: pick(r, A.ANALYTICS_AREAS),
      window: pick(r, ["7d", "14d", "28d", "all", { from: 1_700_000_000_000, to: 1_700_000_000_000 + Math.floor(r() * 30) * D + D }]),
      risk: pick(r, [null, "low", "medium", "high"]),
      appType: pick(r, [null, "cli", "web", "api"]),
      model: pick(r, [null, "sonnet", "opus"]),
      station: pick(r, [null, "build", "verify"]),
      pick: pick(r, [null, { dim: "outcome", value: "failed" }, { dim: "rule", value: "R-7" }]),
      compare: by ? { by, a: pick(r, [null, key(by)]), b: key(by) } : null,
      rows: pick(r, [null, { key: "C1|station=build", title: "Build visits, slowest first", unit: "ms" }, { key: "K1", title: "Executions by recorded cost", unit: "usd" }]),
    };
    const memo = new Map();
    const state = A.applyAnalyticsPatch(A.INITIAL_ANALYTICS_VIEW, V.fromUiPatch(ui, memo));
    const rows = V.rowsOfFocus(state.focus, memo, undefined);
    const back = V.toUiView(state, rows);
    assert.deepEqual(back, ui, `seed ${seed}`);
    // ...and through the address: the same state, so the same view (the drawer's words come from the memo).
    const h = parseHash(formatHash({ route: "analytics", sel: null, at: null, win: null, group: "product", lens: null, table: false, analytics: state }));
    assert.ok(A.sameAnalyticsView(h.analytics, state), `seed ${seed}: address ${formatHash({ route: "analytics", sel: null, at: null, win: null, group: "product", lens: null, table: false, analytics: state })}`);
    assert.deepEqual(V.toUiView(h.analytics, V.rowsOfFocus(h.analytics.focus, memo, undefined)), ui, `seed ${seed} via address`);
  }
});

test("compare: risk and app type as plain filter members; any other cohort as by/key; never prose", () => {
  assert.deepEqual(V.fromUiCompare({ by: "risk", a: "High", b: "Low" }), { a: { risk: "high" }, b: { risk: "low" } });
  assert.deepEqual(V.fromUiCompare({ by: "risk", a: "unknown", b: "Low" }), { a: { by: "risk", key: "unknown" }, b: { risk: "low" } });
  assert.deepEqual(V.fromUiCompare({ by: "config", a: "not-recorded", b: null }), { a: { by: "config", key: "not-recorded" }, b: { by: "config" } });
  // A key with spaces is not a code: the side is kept as "not chosen", never written to the address.
  assert.deepEqual(V.fromUiCompare({ by: "period", a: "the earlier half", b: "later" }), { a: { by: "period" }, b: { by: "period", key: "later" } });
  assert.deepEqual(V.toUiCompare({ a: { risk: "high" }, b: { risk: "medium" } }), { by: "risk", a: "High", b: "Medium" });
  assert.equal(parseHash("#analytics?cmp=by:config,key:has%20space~by:config").analytics.compare.a.key, undefined);
});

test("rows keys: the store holds a metric and one group; more groups stay out of the address", () => {
  assert.deepEqual(V.focusOfRowsKey("C1|station=build"), { metric: "C1", group: { dim: "station", value: "build" } });
  assert.deepEqual(V.focusOfRowsKey("K1"), { metric: "K1", group: null });
  assert.equal(V.focusOfRowsKey("R2|rule=x|risk=High"), null);
  assert.deepEqual(V.parseRowsKey("R2|rule=x|risk=High"), { metric: "R2", group: { rule: "x", risk: "High" } });
  assert.equal(V.parseRowsKey("not a key"), null);
  assert.deepEqual(V.parseRowsKey("Q4|target_kind=matrix rule"), { metric: "Q4", group: { target_kind: "matrix rule" } });
  assert.equal(V.parseRowsKey("C1|station=two  spaces"), null);
  // A drawer restored from the address alone: words from the catalog row.
  assert.deepEqual(V.rowsOfFocus({ metric: "C1", group: { dim: "station", value: "build" } }, new Map(), { name: "Station cycle time", kind: "duration", unit: "ms" }), { key: "C1|station=build", title: "Station cycle time: station build", unit: "ms" });
  assert.equal(V.rowsUnitOf({ kind: "mean", unit: "USD" }), "usd");
});

// ------------------------------------------------------------------------------------ source

test("label rule: simulated figures never under a real source, an observer's never under Simulated", () => {
  assert.deepEqual(Q.sourceCheck("simulation", "simulation"), { ok: true, area: "simulation" });
  assert.deepEqual(Q.sourceCheck("live", "observer"), { ok: true, area: "live" });
  assert.deepEqual(Q.sourceCheck("replay", "observer"), { ok: true, area: "replay" });
  assert.equal(Q.sourceCheck("live", "simulation").ok, false);
  assert.equal(Q.sourceCheck("replay", "simulation").ok, false);
  assert.equal(Q.sourceCheck("simulation", "observer").ok, false);
  assert.equal(Q.sourceCheck("live", null).ok, false);
  assert.equal(Q.providerFor("live", false), null, "no observer: nothing, never the fixture");
  assert.equal(Q.providerFor("simulation", true), "simulation");
  assert.equal(Q.sourceWords("live"), "Live Factory");
  assert.equal(Q.sourceWords("replay"), "Historical replay");
  assert.match(Q.sourceWords("simulation"), /^Simulated/);
  for (const s of ["live", "replay"]) assert.doesNotMatch(Q.sourceWords(s), /simulat/i);
});

test("the loader labels a snapshot by its source", async () => {
  const data = simulatedAnalytics();
  const r = await L.loadArea({ session: beginSnapshot(data), data, source: "simulation", plan: Q.planFor("pulse", null), fromMs: null, toMs: null, filters: {}, model: null, contractFilters: { window: "all", risk: null, app_type: null, model: null }, endMs: FIXTURE_END });
  assert.equal(r.data.state, "ready");
  assert.equal(r.data.value.source, "simulated");
  assert.ok(r.cursor?.startsWith("simulation."));
});

// ------------------------------------------------------------------------------------ period and as of

test("periods: presets end with the newest record's day (or the playhead's); intervals are cut at the playhead", () => {
  const newest = Date.UTC(2026, 10, 12, 6);
  const base = { provider: "observer", asOfMs: null, newestMs: newest, fixtureEnd: FIXTURE_END };
  assert.deepEqual(Q.windowQuery("7d", base), { ok: true, fromMs: Date.UTC(2026, 10, 6), toMs: null, cut: false });
  assert.deepEqual(Q.windowQuery("all", base), { ok: true, fromMs: null, toMs: null, cut: false });
  assert.deepEqual(Q.windowQuery("7d", { ...base, newestMs: null }), { ok: true, fromMs: null, toMs: null, cut: false });
  const playhead = Date.UTC(2026, 9, 31, 2, 26, 40);
  assert.deepEqual(Q.windowQuery("14d", { ...base, asOfMs: playhead }), { ok: true, fromMs: Date.UTC(2026, 9, 18), toMs: null, cut: false });
  const iv = { from: Date.UTC(2026, 9, 25), to: Date.UTC(2026, 10, 5) };
  assert.deepEqual(Q.windowQuery(iv, base), { ok: true, fromMs: iv.from, toMs: iv.to, cut: false });
  assert.deepEqual(Q.windowQuery(iv, { ...base, asOfMs: playhead }), { ok: true, fromMs: iv.from, toMs: playhead, cut: true });
  assert.equal(Q.windowQuery({ from: playhead + D, to: playhead + 2 * D }, { ...base, asOfMs: playhead }).ok, false);
  // The simulation's fixture has its own fixed end.
  assert.deepEqual(Q.windowQuery("28d", { ...base, provider: "simulation" }), { ok: true, fromMs: FIXTURE_END - 28 * D, toMs: null, cut: false });
  // The view key ignores the area and the model (Economics' model is part of its queries, not of the view).
  const f = { risk: "high", appType: null, model: "sonnet", station: null };
  assert.equal(Q.viewKey("observer", Q.windowQuery("7d", base), f, null), Q.viewKey("observer", Q.windowQuery("7d", base), { ...f, model: null }, null));
  assert.notEqual(Q.viewKey("observer", Q.windowQuery("7d", base), f, null), Q.viewKey("observer", Q.windowQuery("7d", base), f, playhead));
});

test("as-of caption in words: complete history, a selected window, through the playhead (exact lists, whole days for metrics)", () => {
  const clock = () => "31 Oct, 02:26 UTC";
  assert.equal(Q.asOfWords({ area: "live", asOfMs: null, window: "all", metricsExact: null, widened: false, cut: false }, clock), "The complete recorded history");
  assert.equal(Q.asOfWords({ area: "live", asOfMs: null, window: "7d", metricsExact: null, widened: false, cut: false }, clock), "A selected window of the recorded history");
  const through = Q.asOfWords({ area: "replay", asOfMs: 1, window: "all", metricsExact: false, widened: false, cut: false }, clock);
  assert.match(through, /^Through the playhead at 31 Oct, 02:26 UTC/);
  assert.match(through, /lists and flow are exact, metrics count whole UTC days before the playhead/);
  assert.match(Q.asOfWords({ area: "replay", asOfMs: 1, window: "all", metricsExact: false, widened: true, cut: true }, clock), /outcomes later that day may be included.*cut at the playhead/);
  assert.match(Q.asOfWords({ area: "simulation", asOfMs: null, window: "all", metricsExact: null, widened: false, cut: false }, clock), /simulated/);
});

// ------------------------------------------------------------------------------------ queries

test("filters are codes; the model only for Economics", () => {
  const f = { risk: "high", appType: "cli", model: "opus", station: "build" };
  assert.deepEqual(Q.filtersQuery(f, false), { risk: "High", app_type: "cli" });
  assert.deepEqual(Q.filtersQuery(f, true), { risk: "High", app_type: "cli", model: "opus" });
  assert.equal(Q.planFor("economics", null).model, true);
  for (const a of A.ANALYTICS_AREAS) if (a !== "economics") assert.equal(Q.planFor(a, null).model, false, a);
  // Cross-filters read their own rows; a pick the area does not read adds nothing.
  assert.deepEqual(Q.planFor("reliability", { dim: "outcome", value: "failed" }).contributors, [{ metric: "X1" }]);
  assert.deepEqual(Q.planFor("reliability", { dim: "outcome", value: "completed" }).contributors, []);
  assert.ok(Q.planFor("quality", { dim: "rule", value: "R-7" }).contributors.some((c) => c.metric === "R2" && c.dim === "rule" && c.value === "R-7"));
  assert.ok(Q.concurrencyBucket(0, 30 * D) >= (30 * D) / 160);
  assert.equal(Q.listsRowsOf("observer", "T1"), false);
  assert.equal(Q.listsRowsOf("observer", "C3"), true);
  assert.equal(Q.listsGroupOf("observer", { target_kind: "matrix rule" }), true);
  assert.equal(Q.listsGroupOf("observer", { rule: "a,b" }), false);
  assert.equal(Q.listsRowsOf("observer", "C1"), true);
  assert.equal(Q.listsRowsOf("simulation", "C3"), true);
});

/** A provider that answers from a script and records every call (route, query, cursor). */
function fakeData(answer) {
  const calls = [];
  const route = (name) => async (query, options = {}) => {
    calls.push({ name, query, at: options.at ?? null, asOfMs: options.asOfMs ?? null });
    return answer(name, query, options);
  };
  return {
    calls,
    data: {
      source: "observer",
      displayPolicy: async () => ({}),
      metrics: route("metrics"),
      flow: route("flow"),
      contributors: route("contributors"),
      runs: route("runs"),
      executions: route("executions"),
      insights: route("insights"),
      concurrency: route("concurrency"),
      freshness: route("freshness"),
    },
  };
}
const env = (cursor) => ({ source: "observer", cursor, projection: { format: 1, definitions: 2 }, generated_ms: 5 * D, window: { from_ms: null, to_ms: null, effective_from_ms: null, effective_to_ms: null, last_runs: null }, filters: {}, history: { complete: true, complete_window: true, from_ms: D, from_precision: null, partial: null, gaps: [] }, as_of: null, rules: [] });
const input = (data, extra = {}) => ({ session: beginSnapshot(data), data, source: "live", plan: Q.planFor("flow", null), fromMs: null, toMs: null, filters: { risk: "High" }, model: null, contractFilters: { window: "all", risk: "high", app_type: null, model: null }, endMs: 6 * D, ...extra });

test("one cursor per view: the totals pin it, every other query of the area reads at it, refused contributors are not asked", async () => {
  const { data, calls } = fakeData((name) => {
    if (name === "metrics") return { status: "ok", value: { ...env("g.40"), metrics: [], definitions_version: 2, group_overflow: 0, suspect_days: [] } };
    if (name === "flow") return { status: "ok", value: { ...env("g.40"), stations: [], transitions: [], waits: [], bottlenecks: [], coverage: { tickets: 0, tickets_with_lifecycle: 0, visits: 0, visits_measured: 0 }, unit: "ms", wait_kinds: [], missing: [] } };
    if (name === "runs") return { status: "ok", value: { ...env("g.40"), of: "runs", items: [], total: 0, offset: 0, more: false, excluded: [], after_as_of: 0 } };
    if (name === "contributors") return { status: "ok", value: { ...env("g.40"), metric: "W1", figure: null, group: {}, items: [], total: 0, truncated: false, by_basis: {}, order: "impact", limit: 500, after_as_of: 0 } };
    return { status: "unsupported", reason: "not in this fake" };
  });
  const r = await L.loadArea(input(data));
  assert.equal(r.data.state, "ready");
  assert.equal(r.cursor, "g.40");
  const pinned = calls.filter((c) => !["concurrency", "freshness"].includes(c.name));
  assert.equal(pinned[0].at, null, "the first query reads the head");
  for (const c of pinned.slice(1)) assert.equal(c.at, "g.40", `${c.name} read at another cursor`);
  for (const c of pinned) assert.deepEqual(c.query.filters, { risk: "High" }, `${c.name} lost the filter`);
  assert.ok(!calls.some((c) => c.name === "contributors" && !Q.OBSERVER_CONTRIBUTORS.has(c.query.metric)));
});

test("the area's state from the observer's answer: no analytics, refused, cursor gone, failure", async () => {
  const run = async (answer) => L.loadArea(input(fakeData(answer).data));
  const none = await run(() => ({ status: "no-analytics", reason: "404" }));
  assert.equal(none.data.state, "unavailable");
  assert.equal(none.data.reason, L.NO_ANALYTICS_REASON);
  const bad = await run(() => ({ status: "invalid", reason: "risk must be one of High, Medium, Low." }));
  assert.deepEqual(bad.data, { state: "error", status: 400, reason: "risk must be one of High, Medium, Low." });
  const gone = await run(() => ({ status: "cursor-gone", reason: "expired" }));
  assert.equal(gone.restart, true, "a cursor that can no longer be read begins again at the head");
  const err = Object.assign(new Error("connection refused"), { status: 0 });
  const fail = await run(() => {
    throw err;
  });
  assert.deepEqual(fail.data, { state: "error", status: null, reason: "connection refused" });
});

test("as of the playhead: every query of the view carries it", async () => {
  const { data, calls } = fakeData((name) => (name === "metrics" ? { status: "ok", value: { ...env("g.9"), metrics: [], definitions_version: 2, group_overflow: 0, suspect_days: [] } } : { status: "unsupported", reason: "-" }));
  await L.loadArea(input(data, { session: beginSnapshot(data, { asOfMs: 3 * D }), plan: Q.planFor("quality", null) }));
  for (const c of calls) assert.equal(c.asOfMs, 3 * D, c.name);
});

// ------------------------------------------------------------------------------------ back navigation

function host(initial) {
  const h = { hash: initial, pushes: [], replaces: [], change: null };
  return Object.assign(h, {
    getHash: () => h.hash,
    replaceHash: (x) => {
      h.replaces.push(x);
      h.hash = x;
    },
    pushHash: (x) => {
      h.pushes.push(x);
      h.hash = x;
    },
    onHashChange: (l) => ((h.change = l), () => {}),
    onInteraction: () => () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
}

test("Back returns to Analytics: a workspace or area change is a new history entry; filters and the drawer replace", () => {
  const store = createSceneStore({ fixture: sim.SCENARIO, clock: manualClock() });
  store.setAnalyticsView({ area: "flow", window: "28d", filters: { risk: "medium" }, focus: { metric: "C1", group: { dim: "station", value: "build" } }, pick: { dim: "station", value: "build" } });
  store.setWorkspace("analytics");
  const h = host(formatHash({ route: "analytics", sel: null, at: null, win: null, group: "product", lens: null, table: false, analytics: store.getState().analytics }));
  const sync = createHashSync(store, h, 0);
  store.setAnalyticsView({ filters: { appType: "cli" } });
  assert.equal(h.pushes.length, 0, "a filter replaces the entry");
  const analyticsEntry = h.hash;
  store.setWorkspace("timeline");
  assert.equal(h.pushes.length, 1, "leaving Analytics pushes an entry");
  assert.match(h.hash, /^#timeline/);
  // The browser's Back: the earlier entry's address, then its hashchange.
  h.hash = analyticsEntry;
  h.change();
  const s = store.getState();
  assert.equal(s.workspace, "analytics");
  assert.equal(s.analytics.area, "flow");
  assert.equal(s.analytics.window, "28d");
  assert.equal(s.analytics.filters.appType, "cli");
  assert.deepEqual(s.analytics.focus, { metric: "C1", group: { dim: "station", value: "build" } });
  assert.deepEqual(s.analytics.pick, { dim: "station", value: "build" });
  assert.equal(h.pushes.length, 1, "Back itself writes no new entry");
  store.setAnalyticsView({ area: "quality" });
  assert.equal(h.pushes.length, 2, "an area change is an entry");
  store.setView("blueprint");
  sync.dispose();
});

// ------------------------------------------------------------------------------------ opportunities

const I = await import("../src/analytics/model/insights.ts");

test("an opportunity says its population beside its figure, shows each figure once, and its rows use that population", () => {
  const scorecard = { window: { from_ms: null, to_ms: null, last_runs: null, comparison: null }, sample: { count: 16, unit: "merged tickets", coverage_share: 1, population: "the last 20 finished runs by closed_at (20 held), the observe station's default population" }, contributors: { metric: "R1", group: {}, order: "recent", limit: 100, path: "/api/v1/analytics/contributors?metric=R1&limit=100&order=recent", relation: "related", note: null } };
  assert.equal(I.populationWords(scorecard), "over the last 20 finished runs, the observe station's window");
  assert.deepEqual(I.insightPopulation(scorecard), { lastRuns: 20, fromMs: null, toMs: null });
  assert.equal(I.sampleWords(scorecard), "n 16 merged tickets");
  // The contributors path wins when it carries the population.
  assert.deepEqual(I.insightPopulation({ ...scorecard, contributors: { ...scorecard.contributors, path: "/api/v1/analytics/contributors?metric=R1&last_runs=30" } }).lastRuns, 30);
  const windowed = { window: { from_ms: Date.UTC(2026, 9, 1), to_ms: Date.UTC(2026, 9, 15), last_runs: null, comparison: { from_ms: Date.UTC(2026, 8, 17), to_ms: Date.UTC(2026, 9, 1) } }, sample: { count: 84, unit: "measured visits", coverage_share: 0.977, population: "visits" }, contributors: null };
  assert.equal(I.populationWords(windowed), "from 1 Oct to 14 Oct, against 17 Sept to 30 Sept");
  assert.equal(I.sampleWords(windowed), "n 84 measured visits, coverage 98%");
  assert.equal(I.capitalFirst("build holds 42.8% of the measured station time"), "Build holds 42.8% of the measured station time");
  assert.equal(I.repeatsTitle({ value: 0.5625 }, "First-pass rate 56.2%, below the observe station's target"), true);
  assert.equal(I.repeatsTitle({ value: 1.4375 }, "Average judging rounds 1.438, above the observe station's target"), true);
  assert.equal(I.repeatsTitle({ value: 405_420_000 }, "Execution-capacity waits have a 90th percentile of 4.7 d"), true);
  assert.equal(I.repeatsTitle({ value: 90 }, "Execution-capacity waits have a 90th percentile of 4.7 d"), false);
  assert.equal(I.repeatsTitle({ value: 86 }, "build holds 42.8% of the measured station time"), false);
});

// ------------------------------------------------------------------------------------ views under churn

const W = await import("../src/analytics/wire/views.ts");

test("window and filter churn with a slow provider: every query of every view carries the views' cursor, and every view still standing settles", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed);
    const calls = [];
    const delay = () => new Promise((ok) => setTimeout(ok, Math.floor(r() * 8)));
    const reply = (name) => {
      if (name === "metrics") return { status: "ok", value: { ...env("c.1"), metrics: [], definitions_version: 2, group_overflow: 0, suspect_days: [] } };
      if (name === "runs") return { status: "ok", value: { ...env("c.1"), of: "runs", items: [], total: 0, offset: 0, more: false, excluded: [], after_as_of: 0 } };
      if (name === "contributors") return { status: "ok", value: { ...env("c.1"), metric: "K4", figure: null, group: {}, items: [], total: 0, truncated: false, by_basis: {}, order: "impact", limit: 500, after_as_of: 0 } };
      return { status: "unsupported", reason: "-" };
    };
    const route = (name) => async (query, options = {}) => {
      calls.push({ name, at: options.at ?? null });
      await delay();
      if (options.signal?.aborted) throw new DOMException("gone", "AbortError");
      return reply(name);
    };
    const data = { source: "observer", displayPolicy: async () => ({}), metrics: route("metrics"), flow: route("flow"), contributors: route("contributors"), runs: route("runs"), executions: route("executions"), insights: route("insights"), concurrency: route("concurrency"), freshness: route("freshness") };
    const shared = new W.SharedCursor();
    let prev = null;
    const standing = [];
    for (let i = 0; i < 12; i++) {
      // A new period or filter: the previous view is left (React's cleanup), sometimes before its first query answered.
      if (prev && r() < 0.8) prev.abort();
      const v = new W.ViewSession(data, null, shared);
      const p = W.loadView(v, shared, { data, source: "live", plan: Q.planFor(pick(r, ["quality", "pulse", "economics"]), null), fromMs: pick(r, [null, 7 * D]), toMs: null, filters: {}, model: null, contractFilters: { window: "all", risk: null, app_type: null, model: null }, endMs: 9 * D }).then(
        (x) => x,
        (e) => (e?.name === "AbortError" ? "aborted" : Promise.reject(e)),
      );
      standing.push({ v, p });
      prev = v;
      if (r() < 0.5) await delay();
    }
    const last = await standing.at(-1).p;
    assert.equal(last.data.state, "ready", `seed ${seed}: the view on screen settles`);
    await Promise.all(standing.map((s) => s.p));
    const pinned = calls.filter((c) => !["concurrency", "freshness"].includes(c.name));
    assert.equal(pinned.filter((c) => c.at === null).length, 1, `seed ${seed}: only the very first query asks the head (${pinned.filter((c) => c.at === null).length})`);
    for (const c of pinned.slice(1)) assert.equal(c.at, "c.1", `seed ${seed}: ${c.name}`);
  }
});

test("an opportunity's drawer is named in the address by its id, so a link or Back reopens the same rows over the same population", () => {
  for (const id of ["scorecard.first-pass", "flow.wait-p90:capacity", "quality.recurring-failure-kind:matrix rule", "quality.recurring-gate-refusal:build.green"]) {
    const memo = new Map();
    const req = { key: "R2|rule=x|risk=High", title: "Rule x recurs", unit: "count", population: { lastRuns: 20, fromMs: null, toMs: null }, insight: id };
    const state = A.applyAnalyticsPatch(A.INITIAL_ANALYTICS_VIEW, V.fromUiPatch({ area: "opportunities", rows: req }, memo));
    assert.equal(state.focus.insight, id);
    assert.deepEqual(state.focus.group, { dim: "rule", value: "x" }, "the first group stays as a hint");
    const hash = formatHash({ route: "analytics", sel: null, at: null, win: null, group: "product", lens: null, table: false, analytics: state });
    const back = parseHash(hash).analytics;
    assert.ok(A.sameAnalyticsView(back, state), `${id}: ${hash}`);
    assert.equal(back.focus.insight, id);
  }
  // A focus with no opportunity stays as it was; a malformed id is dropped with the focus.
  assert.equal(parseHash("#analytics?focus=K1").analytics.focus.insight, undefined);
  assert.equal(parseHash("#analytics?focus=K1,insight:%01bad").analytics.focus, null);
  // The rows key and population come from the opportunity itself.
  const f = { contributors: { metric: "R2", group: { rule: "x", risk: "High" }, order: "impact", limit: 100, path: "/api/v1/analytics/contributors?metric=R2&last_runs=20", relation: "exact", note: null }, window: { from_ms: null, to_ms: null, last_runs: null, comparison: null }, sample: null };
  assert.equal(I.insightRowsKey(f), "R2|rule=x|risk=High");
  assert.deepEqual(I.insightPopulation(f), { lastRuns: 20, fromMs: null, toMs: null });
});

// M6.5.4 groundwork: the Analytics data layer (src/analytics/data). Replies recorded from a real
// observer over the synthetic `medium` project (test/fixtures/analytics/, synthetic data): parsing,
// null handling, containment of prose, the one-cursor-per-view rule, the simulated provider's
// determinism, and the number words' edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const D = await import("../src/analytics/data/index.ts");
const { createObserverClient, analyticsParams } = await import("../src/live/observer.ts");
const { FIXTURE_END } = await import("../src/analytics/fixtures/index.ts");

const EXPECTED = JSON.parse(readFileSync(new URL("./fixtures/analytics/expected-medium.json", import.meta.url), "utf8"));
const rec = (name) => JSON.parse(readFileSync(new URL(`./fixtures/analytics/${name}.json`, import.meta.url), "utf8"));
const R = {
  metrics: rec("metrics"),
  last: rec("metrics-last-runs"),
  phase: rec("metrics-phase"),
  head: rec("metrics-head"),
  insights: rec("insights"),
  insightsWindow: rec("insights-window"),
  concurrency: rec("concurrency"),
  status: rec("factory-status"),
  asof: rec("asof"),
  asofFlow: rec("asof-flow"),
  asofMetrics: rec("asof-metrics"),
  sourcesHead: rec("sources-head"),
  sourcesAsOf: rec("sources-asof"),
  engine: rec("metrics-engine"),
  flow: rec("flow"),
  contributors: rec("contributors"),
  runs: rec("runs"),
  executions: rec("executions"),
  session: rec("session"),
  insights404: rec("insights-404"),
  bad: rec("bad-parameter"),
};

/** An observer client over a fake fetch: `route(path)` → [status, body]. Every requested path is kept. */
function fakeClient(route) {
  const paths = [];
  const fetch = async (url) => {
    paths.push(url);
    const [status, body] = route(url.replace(/^\/api\/v1/, ""));
    return { status, json: async () => body };
  };
  return { client: createObserverClient({ fetch }), paths };
}
const byRoute = (url) => {
  if (url.startsWith("/session")) return [200, R.session.body];
  if (url.startsWith("/analytics/metrics")) return [url.includes("as_of_ms") ? 400 : 200, (url.includes("as_of_ms") ? R.asof : url.includes("phase") ? R.phase : url.includes("last_runs") ? R.last : url.includes("ids=T1%2CQ2%2CK1") ? R.head : R.metrics).body];
  if (url.startsWith("/analytics/flow")) return [200, R.flow.body];
  if (url.startsWith("/analytics/contributors")) return [200, R.contributors.body];
  if (url.startsWith("/analytics/runs")) return [200, (url.includes("of=executions") ? R.executions : R.runs).body];
  if (url.startsWith("/analytics/insights")) return [200, (url.includes("from_ms") ? R.insightsWindow : R.insights).body];
  if (url.startsWith("/concurrency")) return [200, R.concurrency.body];
  if (url.startsWith("/factory/status")) return [200, R.status.body];
  return [404, { ok: false, error: { kind: "not_found", message: "There is no such route." } }];
};

// ------------------------------------------------------------------------------------- client

test("the client builds each analytics route's query from identifiers and numbers only", async () => {
  const { client, paths } = fakeClient(byRoute);
  await client.analyticsMetrics({ at: "e.5", fromMs: 1000.4, toMs: 2000.2, filters: { risk: "High", station: "verify" }, ids: ["T1", "Q2"], groupBy: ["risk", "app_type"], bucket: "week", distribution: true });
  await client.analyticsFlow({ lastRuns: 20 });
  await client.analyticsContributors({ metric: "C1", group: { station: "verify", round: "1" }, order: "recent", limit: 5 });
  await client.analyticsRuns({ of: "executions", limit: 3, offset: 6 });
  await client.analyticsInsights({ asOfMs: 5000.7 });
  await client.analyticsFlow({ at: "e.5", asOfMs: 5000 });
  assert.deepEqual(paths, [
    "/api/v1/analytics/metrics?at=e.5&from_ms=1000&to_ms=2001&risk=High&station=verify&ids=T1%2CQ2&group_by=risk%2Capp_type&bucket=week&distribution=1",
    "/api/v1/analytics/flow?last_runs=20",
    "/api/v1/analytics/contributors?metric=C1&group=station%3Averify%2Cround%3A1&order=recent&limit=5",
    "/api/v1/analytics/runs?of=executions&limit=3&offset=6",
    "/api/v1/analytics/insights?as_of_ms=5000",
    "/api/v1/analytics/flow?at=e.5&as_of_ms=5000",
  ]);
  assert.equal(analyticsParams({ filters: { risk: "", model: undefined } }).toString(), "", "empty filters are not sent");
});

test("a 404 means this observer has no analytics; a 400 surfaces its reason; 409 and 410 mean the view's cursor is gone", async () => {
  const { client } = fakeClient((url) => (url.includes("bogus") ? [400, R.bad.body] : url.startsWith("/analytics/flow") ? [410, { ok: false, error: { kind: "cursor_expired", message: "gone" } }] : url.startsWith("/analytics/insights") ? [404, R.insights404.body] : byRoute(url)));
  const data = D.observerAnalytics(client);
  assert.deepEqual(await data.insights({}), { status: "no-analytics", reason: "This observer does not serve Improvement Opportunities." });
  const bad = await data.metrics({ filters: { model: "bogus" } });
  assert.equal(bad.status, "invalid");
  assert.equal(bad.reason, 'Unknown parameter "bogus".');
  assert.equal((await data.flow({})).status, "cursor-gone");
  // An older client without the methods: no analytics, nothing requested.
  const older = D.observerAnalytics({ ...client, analyticsMetrics: undefined });
  assert.equal((await older.metrics({})).status, "no-analytics");
});

// ------------------------------------------------------------------------------------ parsing

test("metrics: every recorded row parses, the envelope is complete, and absent numbers stay null", async () => {
  const { client } = fakeClient(byRoute);
  const r = await D.observerAnalytics(client).metrics({ ids: ["T1"] });
  assert.equal(r.status, "ok");
  const m = r.value;
  assert.equal(m.source, "observer");
  assert.equal(m.cursor, R.metrics.body.data.cursor);
  assert.equal(m.metrics.length, R.metrics.body.data.metrics.length);
  assert.equal(m.history.complete, false);
  assert.equal(m.history.gaps[0].class, "not-received");
  assert.equal(m.window.effective_from_ms, null);
  assert.ok(m.rules.length >= 1, "rules as a list even when served as one string");
  const t1 = m.metrics.find((x) => x.id === "T1");
  assert.equal(t1.denominator, null, "a count has no denominator: null, not 0");
  assert.equal(t1.numerator_words, "merge.completed");
  assert.equal(t1.status, "available");
  assert.equal(t1.basis_counts.open, null, "open not attributable: null");
  assert.ok(t1.groups.length > 0 && t1.groups.every((g) => g.keys.risk.kind === "code" && !g.prose));
  assert.ok(t1.buckets.length > 0 && t1.buckets.every((b) => b.to_ms > b.from_ms));
  for (const row of m.metrics) {
    if (row.value === null) assert.ok(row.null_reason || row.status !== "available", `${row.id}: a null value says why`);
  }
});

test("the scorecard rows keep the observer's rounding: observe's half-to-even reproduces value_rounded", async () => {
  const { client } = fakeClient(byRoute);
  const r = await D.observerAnalytics(client).metrics({ ids: ["Q2", "Q3", "R5", "G1", "R6", "G2"], lastRuns: 20 });
  assert.equal(r.status, "ok");
  assert.equal(r.value.window.last_runs, 20);
  for (const row of r.value.metrics) {
    assert.ok(row.value !== null, row.id);
    assert.equal(D.roundObserve(row.value), row.value_rounded, row.id);
  }
  const q2 = r.value.metrics.find((x) => x.id === "Q2");
  assert.equal(q2.value, 0.5625);
  assert.equal(q2.value_rounded, 0.562, "half to even, as Python rounds");
  assert.deepEqual(q2.target_check, { value: 0.85, direction: "above", met: false });
});

test("unknown statuses, bases and kinds become unknown, never a guess; malformed numbers are null", () => {
  const row = D.readMetrics({ cursor: "e.1", metrics: [{ id: "Z9", status: "brand-new", basis: "estimated", kind: "ratio", availability: "maybe", value: "3", numerator_value: NaN, coverage: {} }] }, "observer").metrics[0];
  assert.equal(row.status, "unknown");
  assert.equal(row.basis, "unknown");
  assert.equal(row.kind, "unknown");
  assert.equal(row.availability, "unknown");
  assert.equal(row.value, null);
  assert.equal(row.numerator, null);
  assert.deepEqual(row.coverage, { eligible: null, counted: null, share: null, reason: null, excluded: [], unit: null, other: [] });
  assert.equal(row.groups, null, "not grouped: null");
  assert.throws(() => D.readMetrics({ metrics: [] }, "observer"), D.AnalyticsProtocolError, "no cursor: not an analytics reply");
});

test("group_by=phase values are contained: UncheckedText, never a string, never in a URL or JSON", async () => {
  const { client } = fakeClient(byRoute);
  const data = D.observerAnalytics(client);
  const policy = await data.displayPolicy();
  assert.equal(policy.declared, true);
  assert.equal(policy.checkedForNames, false);
  assert.equal(policy.note, "free text, not checked for names");
  assert.ok(policy.fields.some((f) => f.path === "data.phase" && f.max === 60));
  const r = await data.metrics({ ids: ["K7"], groupBy: ["phase"] });
  const groups = r.value.metrics[0].groups;
  assert.ok(groups.length > 0);
  for (const g of groups) {
    assert.equal(g.prose, true);
    assert.equal(g.keys.phase.kind, "unchecked");
    const t = g.keys.phase.text;
    assert.equal(typeof t, "object");
    assert.ok(D.isUnchecked(t));
    assert.equal(String(t), "[free text]");
    assert.equal(`${t}`, "[free text]");
    assert.equal(new URLSearchParams({ phase: t }).toString(), "phase=%5Bfree+text%5D");
    assert.ok(!JSON.stringify(g).includes(D.uncheckedView(t).full), "JSON never carries the words");
    assert.match(g.id, /^group#\d+$/, "the group's id is not its prose");
    assert.equal(t.max, 60);
  }
  const long = D.unchecked("x".repeat(300), "review.finding data.title", 200);
  const v = D.uncheckedView(long);
  assert.equal(v.truncated, true);
  assert.equal(Array.from(v.shown).length, 200);
  assert.equal(v.full.length, 300);
  assert.equal(D.unchecked("   ", "f"), null);
  // An observer that declares nothing: fail closed.
  assert.equal(D.readDisplayPolicy(null).declared, false);
  assert.equal(D.readDisplayPolicy({ people: "role" }).checkedForNames, false);
});

test("flow, contributors, runs and executions parse with their counts and bases kept apart", async () => {
  const { client } = fakeClient(byRoute);
  const data = D.observerAnalytics(client);
  const flow = (await data.flow({})).value;
  assert.equal(flow.stations.length, R.flow.body.data.stations.length);
  assert.deepEqual(flow.missing, []);
  const groom = flow.stations.find((s) => s.station === "groom");
  assert.equal(groom.duration.measured.percentile_basis, "exact");
  assert.equal(groom.duration.bounded.total_min_ms, null);
  const wait = flow.waits.find((w) => w.kind === "dependency");
  assert.equal(wait.duration.basis.open, 1);
  assert.ok(flow.bottlenecks.every((b) => b.kind === "station" || b.kind === "wait"));
  assert.ok(flow.transitions.every((t) => typeof t.terminal === "boolean"));

  const c = (await data.contributors({ metric: "C1", group: { station: "verify" }, limit: 5 })).value;
  assert.equal(c.items.length, 5);
  assert.equal(c.total, 84);
  assert.equal(c.truncated, true);
  assert.equal(c.items[0].cell, "cell:SYN-052");
  assert.match(c.items[0].ref, /^visit:/);
  assert.equal(c.items[0].basis, "measured");

  const runs = (await data.runs({ limit: 3 })).value;
  assert.equal(runs.of, "runs");
  assert.equal(runs.total, 57);
  const run = runs.items[0];
  assert.equal(run.closed_at.at_ms, 1792769820999);
  assert.equal(run.closed_at.precision, "s");
  const x = run.executions[0];
  assert.equal(x.provenance_recorded, false);
  assert.equal(x.provenance_reason, "not-recorded");
  assert.equal(x.config_id, null);
  assert.equal(x.usage.cost_usd, 4.7979);
  assert.equal(x.usage.complete, true);

  const ex = (await data.executions({ limit: 3 })).value;
  assert.equal(ex.of, "executions");
  assert.ok(ex.items.every((i) => typeof i.execution_id === "string"));
  // An execution with nothing recorded keeps null, not 0.
  const bare = D.readRuns({ cursor: "e.1", of: "executions", items: [{ execution_id: "x1", usage: {} }] }, "observer").items[0];
  assert.equal(bare.usage.cost_usd, null);
  assert.equal(bare.usage.tokens_total, null);
  assert.equal(bare.usage.complete, null);
  assert.equal(bare.provenance_reason, "unknown");
});

// ------------------------------------------------------------------------------------ snapshot

/** A provider whose replies carry the cursor it is asked at, or `head` when none. */
function countingProvider(head = "g.10", asOf = "none") {
  const calls = [];
  let current = head;
  const answer = (route) => async (query, options) => {
    calls.push({ route, at: options?.at ?? null, asOfMs: options?.asOfMs ?? null, query });
    if (options?.asOfMs != null && asOf === "refused") return { status: "invalid", reason: 'Unknown parameter "as_of_ms".' };
    const cursor = options?.at ?? current; // the head when asked
    await new Promise((r) => setTimeout(r, 5));
    if (options?.signal?.aborted) throw options.signal.reason;
    const items = route === "runs" ? [{ ticket_id: "A", closed_at: { at_ms: 100 }, executions: [] }, { ticket_id: "B", closed_at: { at_ms: 300 }, executions: [] }, { ticket_id: "C", closed_at: null, executions: [] }] : [];
    const exactRoute = route !== "metrics" && route !== "insights";
    const env = { cursor, as_of: options?.asOfMs != null && asOf === "served" ? { ms: options.asOfMs, exact: exactRoute, effective_to_ms: exactRoute ? options.asOfMs : 0, rule: exactRoute ? "nothing later" : "whole UTC days before the playhead; the day of the playhead is not included" } : null, window: { effective_to_ms: query.toMs === undefined || query.toMs === null ? null : Math.ceil(query.toMs / 1000) * 1000 } };
    if (route === "runs") return { status: "ok", value: { ...env, of: "runs", items, after_as_of: 0 } };
    return { status: "ok", value: { ...env, metrics: [] } };
  };
  return {
    calls,
    moveHead: (c) => (current = c),
    data: { source: "observer", displayPolicy: async () => D.UNDECLARED_POLICY, metrics: answer("metrics"), flow: answer("flow"), contributors: answer("contributors"), runs: answer("runs"), executions: answer("executions"), insights: answer("insights") },
  };
}

test("one cursor per view: the first reply's cursor is passed as at to every other query, even those asked at once", async () => {
  const p = countingProvider("g.10");
  const s = D.beginSnapshot(p.data, { cache: D.createSnapshotCache() });
  assert.equal(s.cursor, null);
  const first = s.metrics({ ids: ["T1"] });
  p.moveHead("g.11"); // the head moves while the view loads
  const rest = [s.metrics({ ids: ["Q2"] }), s.flow({}), s.runs({})];
  await Promise.all([first, ...rest]);
  assert.equal(s.cursor, "g.10");
  assert.deepEqual(p.calls.map((c) => c.at), [null, "g.10", "g.10", "g.10"]);
  assert.equal(s.broken, false);
  // Cached by (cursor, query): asking again reads nothing.
  await s.metrics({ ids: ["Q2"] });
  assert.equal(p.calls.length, 4);
  // A new snapshot (refresh) goes to the head again.
  const s2 = D.beginSnapshot(p.data, { cache: D.createSnapshotCache() });
  await s2.metrics({ ids: ["T1"] });
  assert.equal(s2.cursor, "g.11");
});

test("a reply at another cursor is never mixed into the view; a failed first query lets the next go first", async () => {
  const p = countingProvider("g.10");
  const odd = { ...p.data, flow: async () => ({ status: "ok", value: { cursor: "g.99", window: {} } }) };
  const s = D.beginSnapshot(odd, { cache: D.createSnapshotCache() });
  await s.metrics({});
  const r = await s.flow({});
  assert.equal(r.status, "cursor-gone");
  assert.equal(s.broken, true);

  const failing = { ...p.data, metrics: async () => ({ status: "invalid", reason: "no" }) };
  const s2 = D.beginSnapshot(failing, { cache: D.createSnapshotCache() });
  const [a, b] = await Promise.all([s2.metrics({}), s2.flow({})]);
  assert.equal(a.status, "invalid");
  assert.equal(b.status, "ok");
  assert.equal(s2.cursor, "g.10");
});

test("abort cancels the view's requests and refuses later ones", async () => {
  const p = countingProvider();
  const s = D.beginSnapshot(p.data, { cache: D.createSnapshotCache() });
  const pending = s.metrics({});
  s.abort();
  await assert.rejects(pending, (e) => e.name === "AbortError");
  await assert.rejects(s.flow({}), (e) => e.name === "AbortError");
});

test("as of a playhead: every query asks as_of_ms beside the view's cursor; exact where the observer says so, its rule where not", async () => {
  const p = countingProvider("g.10", "served");
  const s = D.beginSnapshot(p.data, { asOfMs: 200, cache: D.createSnapshotCache() });
  const m = await s.metrics({ toMs: 5000 });
  assert.equal(p.calls[0].asOfMs, 200);
  assert.equal(p.calls[0].query.toMs, 5000, "the window is not cut by the client");
  assert.deepEqual(m.value.asOf, { ms: 200, exact: false, rule: "whole UTC days before the playhead; the day of the playhead is not included", effectiveToMs: 0, widened: false });
  const f = await s.flow({});
  assert.equal(p.calls[1].at, "g.10");
  assert.equal(p.calls[1].asOfMs, 200, "as_of_ms combines with at");
  assert.deepEqual(f.value.asOf, { ms: 200, exact: true, rule: null, effectiveToMs: 200, widened: false });
  const runs = await s.runs({});
  assert.deepEqual(runs.value.items.map((r) => r.ticket_id), ["A"], "lists are still cut at the playhead");
  assert.equal(runs.value.after_as_of, 2, "after the playhead, or with no recorded time");
});

test("recorded as_of replies: flow exact, metrics by whole UTC days with the observer's rule", async () => {
  const route = (url) => (url.startsWith("/analytics/flow") ? [200, R.asofFlow.body] : url.startsWith("/analytics/metrics") ? [200, R.asofMetrics.body] : byRoute(url));
  const { client, paths } = fakeClient(route);
  const data = D.observerAnalytics(client);
  const s = D.beginSnapshot(data, { asOfMs: 1794456000000, cache: D.createSnapshotCache() });
  const flow = await s.flow({});
  assert.equal(flow.status, "ok");
  assert.equal(flow.value.asOf.exact, true);
  assert.equal(flow.value.as_of.effective_to_ms, 1794456000000);
  assert.equal(flow.value.history.from_precision, "minute");
  assert.ok(flow.value.history.from_ms > 0, "history.from_ms is filled");
  const m = await s.metrics({ ids: ["T1"] });
  assert.equal(m.status, "ok", m.reason);
  assert.equal(m.value.asOf.exact, false);
  assert.match(m.value.asOf.rule, /whole UTC days/);
  assert.equal(m.value.asOf.effectiveToMs, 1794441600000, "the playhead's UTC midnight");
  assert.ok(paths.filter((u) => u.includes("/analytics/")).every((u) => u.includes("as_of_ms=1794456000000")));
});

test("as of a playhead on an observer without as_of_ms: one 400, then to_ms is the playhead and a widened day is said", async () => {
  const p = countingProvider("g.10", "refused");
  const s = D.beginSnapshot(p.data, { asOfMs: 200, cache: D.createSnapshotCache() });
  const m = await s.metrics({ toMs: 5000 });
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0].asOfMs, 200);
  assert.equal(p.calls[1].asOfMs, null);
  assert.equal(p.calls[1].query.toMs, 200, "the earlier end wins");
  assert.equal(m.value.asOf.exact, false);
  assert.equal(m.value.asOf.widened, true, "the observer counted to the end of the day");
  // The provider is remembered: a later view does not ask as_of_ms again.
  const s2 = D.beginSnapshot(p.data, { asOfMs: 200, cache: D.createSnapshotCache() });
  await s2.metrics({});
  assert.equal(p.calls[2].asOfMs, null);
  assert.deepEqual(D.asOfQuery({ lastRuns: 20 }, 200), { lastRuns: 20 }, "last_runs keeps its population");
});

test("the real observer before as_of_ms answers 400 naming it (recorded), which is what the fallback keys on", async () => {
  const { client } = fakeClient(byRoute);
  const r = await D.observerAnalytics(client).metrics({ ids: ["T1"] }, { asOfMs: 1793232000000 });
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /as_of_ms/);
});

test("shouldRefresh: only when the live edge passed the view, and not faster than the live cadence", () => {
  assert.equal(D.shouldRefresh("g.10", "g.12", 5000), true);
  assert.equal(D.shouldRefresh("g.10", "g.12", 100), false);
  assert.equal(D.shouldRefresh("g.10", "g.10", 5000), false);
  assert.equal(D.shouldRefresh("g.10", "h.3", 5000), true, "a new generation");
  assert.equal(D.shouldRefresh(null, "g.3", 5000), false);
  assert.equal(D.SNAPSHOT_REFRESH_MS, 2000);
});

// ---------------------------------------------------------------------------------- simulation

test("the simulated provider is deterministic, labelled simulation, and says what it cannot answer", async () => {
  const a = D.simulatedAnalytics(6502);
  const b = D.simulatedAnalytics(6502);
  assert.equal(a.source, "simulation");
  const q = { ids: ["C1", "Q2", "T1"], groupBy: ["risk"], fromMs: FIXTURE_END - 28 * 86_400_000 };
  const ra = await a.metrics(q);
  const rb = await b.metrics(q);
  assert.equal(ra.status, "ok");
  assert.equal(JSON.stringify(ra), JSON.stringify(rb));
  assert.notEqual(JSON.stringify(ra), JSON.stringify(await D.simulatedAnalytics(7).metrics(q)));
  assert.equal(ra.value.source, "simulation");
  assert.ok(ra.value.rules.includes(D.SIMULATION_RULE));
  const q2 = ra.value.metrics.find((r) => r.id === "Q2");
  assert.ok(q2.groups.every((g) => ["High", "Medium", "Low"].includes(g.keys.risk.text)), "risk as the observer serves it");
  // Same typed shape as the observer's: the same keys on a row.
  const { client } = fakeClient(byRoute);
  const live = (await D.observerAnalytics(client).metrics({})).value.metrics[0];
  assert.deepEqual(Object.keys(ra.value.metrics[0]).sort(), Object.keys(live).sort());

  for (const [why, call] of [
    ["last_runs", () => a.metrics({ lastRuns: 20 })],
    ["a window it does not hold", () => a.metrics({ fromMs: FIXTURE_END - 3 * 86_400_000 })],
    ["an earlier end", () => a.metrics({ toMs: FIXTURE_END - 1 })],
    ["a station filter", () => a.flow({ filters: { station: "verify" } })],
    ["executions", () => a.executions({})],
  ]) assert.equal((await call()).status, "unsupported", why);

  const flow = (await a.flow({})).value;
  assert.deepEqual(flow.missing, ["stations", "waits", "bottlenecks", "coverage"], "missing, not empty");
  assert.ok(flow.transitions.length > 0);
  const runs = (await a.runs({ limit: 5 })).value;
  assert.equal(runs.items.length, 5);
  assert.ok(runs.items[0].closed_at.at_ms > 0);
  const c = (await a.contributors({ metric: "C1", group: { station: "verify" }, limit: 3 })).value;
  assert.equal(c.items.length, 3);
  assert.ok(c.items.every((i) => i.cell === null || i.cell.startsWith("cell:")));
  // The snapshot rule holds for the simulation too.
  const s = D.beginSnapshot(a, { cache: D.createSnapshotCache() });
  await s.metrics({ ids: ["T1"] });
  assert.equal((await s.runs({})).status, "ok");
});

// ------------------------------------------------------------------------------------ adapter

test("the contract adapter: rows, runs and per-run configs; prose groups left out and said", async () => {
  const { client } = fakeClient(byRoute);
  const data = D.observerAnalytics(client);
  const k7 = (await data.metrics({ groupBy: ["phase"] })).value.metrics[0];
  const row = D.toContractRow(k7);
  assert.deepEqual(row.groups, []);
  assert.match(row.groups_reason, /free text/);
  const runs = (await data.runs({})).value.items;
  const configs = D.configsOf(runs);
  assert.deepEqual(configs[runs[0].ticket_id], [null, null], "no provenance recorded: null per execution");
  const snap = D.toContractSnapshot({
    source: "live", filters: { window: "all", risk: null, app_type: null, model: null }, window: { from_ms: 0, to_ms: 1 }, generated_ms: 1,
    totals: (await data.metrics({})).value.metrics, runs, definitions_version: 2, partial: false, group_overflow: 0,
  });
  assert.equal(snap.runs[0].closed_at.ms, runs[0].closed_at.at_ms);
  assert.ok(snap.totals.T1);
  assert.equal(snap.concurrency, null);
});

// ------------------------------------------------------------------------- insights and sources

test("insights: the recorded reply parses whole: findings, measurements, sample, comparison window, contributors query, rules not evaluated", async () => {
  const { client } = fakeClient(byRoute);
  const data = D.observerAnalytics(client);
  const r = (await data.insights({})).value;
  const raw = R.insights.body.data;
  assert.equal(r.insights.length, raw.insights.length);
  assert.equal(r.not_evaluated.length, raw.not_evaluated.length);
  assert.equal(r.insight_rules.length, raw.rules.length);
  assert.deepEqual(r.rules, [], "the rule catalog is insight_rules, not the envelope's rules");
  assert.match(r.notice, /advisory and read-only/);
  assert.match(r.investigation_label, /not a conclusion/);
  const fp = r.insights.find((i) => i.rule === "scorecard.first-pass");
  assert.equal(fp.severity, "attention");
  assert.equal(fp.measurements[0].metric, "Q2");
  assert.equal(fp.measurements[0].numerator, 9);
  assert.equal(fp.measurements[0].denominator, 16);
  assert.equal(fp.measurements[0].window, "selection");
  assert.equal(fp.sample.count, 16);
  assert.equal(fp.contributors.metric, "verification_failures");
  assert.equal(fp.contributors.relation, "related");
  assert.match(fp.contributors.path, /^\/api\/v1\/analytics\/contributors\?/);
  assert.ok(fp.investigation.text.length > 0);
  for (const i of r.insights) assert.ok(i.severity === "attention" || i.severity === "note", i.id);

  const w = (await data.insights({ fromMs: 1793232000000, toMs: 1794528000000 })).value;
  const trend = w.insights.find((i) => i.window.comparison);
  assert.deepEqual(trend.window.comparison, { from_ms: 1791936000000, to_ms: 1793232000000 });
  assert.ok(w.insights.some((i) => i.subject === "build"));
});

test("the simulated provider answers insights from the prototype's findings in the same shape, labelled simulation", async () => {
  const sim = D.simulatedAnalytics(6502);
  const r = await sim.insights({});
  assert.equal(r.status, "ok");
  assert.equal(r.value.source, "simulation");
  assert.ok(r.value.insights.length > 0);
  assert.match(r.value.notice, /^Simulated/);
  const { client } = fakeClient(byRoute);
  const live = (await D.observerAnalytics(client).insights({})).value;
  assert.deepEqual(Object.keys(r.value).sort(), Object.keys(live).sort());
  assert.deepEqual(Object.keys(r.value.insights[0]).sort(), Object.keys(live.insights[0]).sort());
  for (const i of r.value.insights) {
    assert.equal(i.severity, "unknown", "the prototype states no severity: not guessed");
    for (const m of i.measurements) assert.equal(m.value, null, "words, not numbers: in display");
  }
  assert.equal(JSON.stringify(r), JSON.stringify(await D.simulatedAnalytics(6502).insights({})), "deterministic");
});

test("concurrency and freshness from the observer's own routes; the contract adapter fills its concurrency and freshness", async () => {
  const { client } = fakeClient(byRoute);
  const data = D.observerAnalytics(client);
  const q = { fromMs: 1792648800000, toMs: 1794463200000, bucketMs: 86_400_000 };
  const c = (await data.concurrency(q)).value;
  assert.equal(c.bucket_ms, 86_400_000);
  const ex = c.lines.find((l) => l.kind === "execution");
  assert.equal(ex.max.length, Math.ceil((c.to_ms - c.from_ms) / c.bucket_ms));
  assert.ok(ex.max.every((x) => x === null || x <= 4), "never above the recorded max_parallel of 4");
  const mp = c.limits.find((l) => l.name === "max_parallel");
  assert.deepEqual(mp.applies_to, ["execution", "cell"]);
  assert.equal(c.limits.find((l) => l.name === "budget_usd").applies_to, null);

  const f = (await data.freshness()).value;
  const by = Object.fromEntries(f.sources.map((s) => [s.source, s]));
  assert.equal(by["intake log"].files, 1);
  assert.equal(by["run records"].files, 1);
  assert.equal(by["cell lifecycle"].files, 3);
  assert.equal(by["execution stream"].files, 2);
  assert.ok(by["intake log"].last_read_ms > 0);
  assert.equal(by["execution records"].files, null);
  assert.match(by["execution records"].reason, /intake log/);

  const flow = (await data.flow({})).value;
  const snap = D.toContractSnapshot({
    source: "live", filters: { window: "all", risk: null, app_type: null, model: null }, window: { from_ms: q.fromMs, to_ms: q.toMs }, generated_ms: 1,
    totals: [], definitions_version: 2, partial: false, group_overflow: 0, concurrency: c, freshness: f, flowCoverage: flow.coverage,
  });
  assert.deepEqual(snap.concurrency.limits.map((l) => l.value), [4]);
  assert.ok(snap.concurrency.lines.some((l) => l.kind === "execution"));
  const life = snap.freshness.find((x) => x.source === "cell lifecycle");
  assert.equal(life.coverage.of, flow.coverage.tickets);
  assert.equal(life.last_event_ms, null, "a read time is not an event time");
  // The read time has its own field (shown as "Last read"), never the event time.
  assert.equal(typeof life.last_read_ms, "number");
  assert.match(life.note, /files? followed/);
  // The simulation: concurrency from its fixture, no freshness (it reads no files).
  const sim = D.simulatedAnalytics(6502);
  assert.equal((await sim.concurrency(q)).status, "ok");
  assert.equal((await sim.freshness()).status, "unsupported");
});

test("history.sources: the four classes with their newest applied event and count; hour precision as of a playhead; reasons kept", () => {
  const head = D.readFlow(R.sourcesHead.body.data, "observer").history.sources;
  assert.deepEqual(head.map((x) => x.source), ["intake", "lifecycle", "stream", "runs"]);
  const runs = head.find((x) => x.source === "runs");
  assert.equal(runs.events, EXPECTED.tickets.finished, "one run record per finished ticket");
  assert.ok(head.every((x) => x.last_event_ms > 0));
  assert.ok(head.every((x) => x.last_read_ms > 0 && x.reason.length === 0), "every class was read: a read time, no reason");
  // A class the observer did not read keeps null with its reason.
  const unread = D.readEnvelope({ cursor: "e.1", history: { sources: [{ source: "runs", last_event_ms: null, events: null, last_read_ms: null, reason: ["no-events", "not-read"] }] } }, "observer").history.sources[0];
  assert.deepEqual([unread.last_read_ms, unread.events, unread.reason], [null, null, ["no-events", "not-read"]]);
  const asOf = D.readFlow(R.sourcesAsOf.body.data, "observer");
  assert.equal(asOf.as_of.exact, true);
  for (const x of asOf.history.sources) {
    assert.ok(x.last_event_ms <= asOf.as_of.ms, `${x.source}: nothing after the playhead`);
    assert.ok(x.events <= head.find((y) => y.source === x.source).events);
  }
  assert.equal(asOf.history.sources.find((x) => x.source === "intake").precision, "hour");
  // The contract's freshness takes the last event and count from history where served.
  const f = { source: "observer", read_at_ms: null, watermark_ms: null, sources: [{ source: "run records", files: 1, last_read_ms: null, lag_bytes: 0, states: {}, reason: null }] };
  const out = D.toContractFreshness(f, null, head);
  assert.equal(out[0].last_event_ms, runs.last_event_ms);
  assert.equal(out[0].events, 57);
  // Without the status reply: the four history classes alone, with their read times.
  const alone = D.freshnessFor(null, D.readFlow(R.sourcesHead.body.data, "observer").history, null);
  assert.deepEqual(alone.map((x) => x.source), ["intake log", "cell lifecycle", "execution stream", "run records"]);
  assert.equal(alone[3].last_read_ms, runs.last_read_ms);
  assert.equal(alone[3].last_event_ms, runs.last_event_ms);
  const none = D.freshnessFor(null, { sources: [{ source: "runs", last_event_ms: null, events: null, last_read_ms: null, precision: null, reason: ["not-read"] }] }, null);
  assert.equal(none[0].last_read_ms, null);
  assert.match(none[0].note, /did not say when it last read/);
  assert.equal(D.freshnessFor(f, D.readFlow(R.sourcesHead.body.data, "observer").history, null)[0].events, 57);
});

test("the engine's percentile basis and bounds, per-row as_of and coverage units are read and carried to the contract", () => {
  const m = D.readMetrics(R.engine.body.data, "observer");
  const c1 = m.metrics.find((r) => r.id === "C1");
  assert.equal(c1.percentile_basis, "exact");
  assert.equal(c1.p50_bounds_ms, null, "exact percentiles have no bucket bounds");
  assert.ok(c1.groups.every((g) => g.percentile_basis === "exact"));
  assert.equal(c1.as_of.exact, false);
  assert.equal(c1.as_of.effective_to_ms, 1793232000000);
  assert.match(c1.as_of.rule, /midnight/);
  const k2 = m.metrics.find((r) => r.id === "K2");
  assert.equal(k2.coverage.unit, "completed executions");
  assert.deepEqual(k2.coverage.other, []);
  assert.equal(m.metrics.find((r) => r.id === "Q2").percentile_basis, null, "a rate has no percentiles: null, not guessed");
  const row = D.toContractRow(c1);
  assert.equal(row.percentile_basis, "exact");
  assert.deepEqual(row.as_of, { effective_to_ms: 1793232000000, exact: false });
  assert.equal(D.toContractRow(k2).coverage.unit, "completed executions");
  // Histogram percentiles with bounds, exclusions in another unit, an exact distribution: synthetic, as the medium project has none.
  const syn = D.readMetricRow({
    id: "K9", kind: "duration", value: 5, percentile_basis: "histogram", p50_bounds_ms: [1000, 1260], p90_bounds_ms: [4000, 5039], p50_ms: 1260,
    coverage: { eligible: 3, counted: 2, excluded: [{ reason: "x", count: 1 }], other: [{ reason: "the model's usage carries no cost", count: 4, unit: "execution-model pairs" }] },
    distribution: { p50: 1, histogram: [], percentile_basis: "exact" },
  });
  assert.deepEqual(syn.p50_bounds_ms, [1000, 1260]);
  assert.deepEqual(syn.coverage.other, [{ reason: "the model's usage carries no cost", count: 4, unit: "execution-model pairs" }]);
  const out = D.toContractRow(syn);
  assert.deepEqual(out.p90_bounds_ms, [4000, 5039]);
  assert.equal(out.coverage.other[0].unit, "execution-model pairs");
  assert.equal(out.distribution.percentile_basis, "exact", "exact distributions are kept");
  assert.equal(D.readMetricRow({ id: "Z", percentile_basis: "guessed", coverage: {} }).percentile_basis, null);
});

test("recorded figures equal the generator's ground truth (expected.json): tickets merged, first pass, recorded cost", async () => {
  const { client } = fakeClient(byRoute);
  const m = (await D.observerAnalytics(client).metrics({ ids: ["T1", "Q2", "K1"] })).value;
  assert.equal(m.cursor, R.head.body.data.cursor);
  const row = (id) => m.metrics.find((r) => r.id === id);
  // T1 counts merge.completed in the lifecycle logs: one merged ticket's log lost its merge (visits_in_logs).
  assert.equal(row("T1").value, EXPECTED.visits_in_logs.merge);
  assert.equal(EXPECTED.tickets.merged - row("T1").value, 1);
  assert.equal(row("Q2").numerator, EXPECTED.tickets.first_pass);
  assert.equal(row("Q2").denominator, EXPECTED.tickets.merged);
  assert.equal(row("K1").numerator, EXPECTED.cost.recorded_cost_usd);
  assert.equal(row("K1").denominator, EXPECTED.cost.executions_with_recorded_cost);
  assert.equal(row("K1").coverage.eligible - row("K1").coverage.counted, EXPECTED.cost.executions_completed_without_cost);
});

// -------------------------------------------------------------------------------------- format

test("number words: empty denominators, one sample, huge values, nonzero cost never $0.00", () => {
  assert.equal(D.percentOf(3, 0), null);
  assert.equal(D.percentOf(null, 4), null);
  assert.equal(D.percentOf(0, 4), "0%");
  assert.equal(D.percentOf(1, 1), "100%");
  assert.equal(D.percentOf(1, 30), "3.3%");
  assert.equal(D.percentOf(80, 88), "91%");
  assert.equal(D.sampleWords(1, "merged tickets"), "n 1 merged ticket");
  assert.equal(D.sampleWords(45, "merged tickets"), "n 45 merged tickets");
  assert.equal(D.sampleWords(null, "visits"), "n –");
  assert.equal(D.coverageWords(80, 88), "coverage 80 of 88 (91%)");
  assert.equal(D.coverageWords(0, 0), "coverage 0 of 0");
  assert.equal(D.coverageWords(null, 3), null);
  assert.equal(D.recordedUsd(null), null);
  assert.equal(D.recordedUsd(0).text, "$0.00");
  assert.equal(D.recordedUsd(0.004).text, "< $0.01");
  assert.equal(D.recordedUsd(0.004).exact, "$0.004");
  assert.equal(D.recordedUsd(4.7979).text, "$4.80");
  assert.equal(D.recordedUsd(1234567.891).text, "$1,234,567.89");
  assert.equal(D.tokenWords(812).text, "812");
  assert.equal(D.tokenWords(34_200).text, "34.2k");
  assert.equal(D.tokenWords(3_522_336).text, "3.52M");
  assert.equal(D.tokenWords(3_522_336).exact, "3,522,336 tokens");
  assert.equal(D.tokenWords(999_999).text, "1M");
  assert.equal(D.tokenWords(2.41e12).text, "2410B");
  assert.equal(D.tokenWords(undefined), null);
  assert.equal(D.durationWords(null), "–");
  assert.equal(D.durationWords(450), "450 ms");
  assert.equal(D.durationWords(252_000), "4 min 12 s");
  assert.equal(D.durationWords(3_780_000), "1 h 3 min");
  assert.equal(D.durationWords(15_183_503_000), "175 d 17 h");
  assert.equal(D.countWords(1234567), "1,234,567");
  assert.equal(D.countWords(Number.MAX_SAFE_INTEGER), "9,007,199,254,740,991");
  // observe.py's round(x, 3): half to even on the exact binary value (checked against python3).
  for (const [x, want] of [[0.5625, 0.562], [1.4375, 1.438], [0.0625, 0.062], [0.8125, 0.812], [0.0005, 0.001], [2.675, 2.675], [1 / 3, 0.333], [0.9565217391304348, 0.957], [-0.0625, -0.062], [0, 0]]) {
    assert.equal(D.roundObserve(x), want, String(x));
  }
  assert.equal(D.roundObserve(null), null);
  assert.equal(D.roundObserve(NaN), null);
});

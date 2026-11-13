// M6.3 temporal overview: the pure parts (src/timeline/overview/model.ts): bucket-to-pixel
// aggregation, the log scale, the activity steps, landmark aggregation per pixel column, the brush
// arithmetic (clamping, minimum width, keyboard steps, wheel zoom) and tick selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const m = await import("../src/timeline/overview/model.ts");
const { MIN_WINDOW_MS } = await import("../src/timeline/contract.ts");

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const EXT = { from: T0, to: T0 + 6 * HOUR };
const mark = (id, kind, at, extra = {}) => ({ id, kind, at, until: null, eventId: null, entity: null, label: id, verdict: null, authority: "observed", ...extra });

test("x and t are inverse over the extent", () => {
  assert.equal(m.xOf(EXT.from, EXT, 1000), 0);
  assert.equal(m.xOf(EXT.to, EXT, 1000), 1000);
  assert.equal(m.tOf(500, EXT, 1000), EXT.from + 3 * HOUR);
});

test("log scale: zero is nothing, anything is at least 1 px, the peak fills the height", () => {
  assert.equal(m.logHeight(0, 100, 50), 0);
  assert.equal(m.logHeight(1, 100_000, 50) >= 1, true);
  assert.equal(m.logHeight(100, 100, 50), 50);
  assert.ok(m.logHeight(10, 100, 50) > 25, "log, not linear: a tenth of the peak is over half the height");
  assert.equal(m.logHeight(5, 0, 50), 0);
});

test("density: one value per column, the largest bucket touching it, never a sum", () => {
  // 6 hours, 1-minute buckets, 120 px: three buckets per column.
  const buckets = [
    { from: T0, count: 5 },
    { from: T0 + MIN, count: 9 },
    { from: T0 + 2 * MIN, count: 2 },
    { from: T0 + 3 * HOUR, count: 40 },
  ];
  const d = m.densityColumns({ from: EXT.from, to: EXT.to, bucketMs: MIN, buckets, complete: true }, EXT, 120);
  assert.equal(d.values.length, 120);
  assert.equal(d.values[0], 9);
  assert.equal(d.values[60], 40);
  assert.equal(d.values[30], 0);
  assert.equal(d.peak, 40);
  assert.equal(d.total, 56);
  // Wide buckets fill every column they cover.
  const wide = m.densityColumns({ from: EXT.from, to: EXT.to, bucketMs: HOUR, buckets: [{ from: T0 + HOUR, count: 7 }], complete: true }, EXT, 600);
  for (let x = 100; x < 200; x++) assert.equal(wide.values[x], 7, `column ${x}`);
  assert.equal(wide.values[99], 0);
  assert.equal(wide.values[200], 0);
});

test("density: a quarter of a million buckets aggregate in one pass", () => {
  const buckets = Array.from({ length: 250_000 }, (_, i) => ({ from: T0 + i * 1000, count: (i % 97) + 1 }));
  const ext = { from: T0, to: T0 + 250_000 * 1000 };
  const start = performance.now();
  const d = m.densityColumns({ from: ext.from, to: ext.to, bucketMs: 1000, buckets, complete: true }, ext, 1500);
  assert.ok(performance.now() - start < 200);
  assert.equal(d.peak, 97);
});

test("activity: stepped runs of equal value; missing buckets count as none", () => {
  const series = {
    from: EXT.from,
    to: EXT.to,
    bucketMs: HOUR,
    buckets: [
      { from: T0, active: { execution: { max: 2, mean: 1 } } },
      { from: T0 + HOUR, active: { execution: { max: 2, mean: 2 } } },
      { from: T0 + 2 * HOUR, active: {} },
      { from: T0 + 4 * HOUR, active: { execution: { max: 3, mean: 3 } } },
    ],
    limits: [],
    complete: true,
  };
  const { steps, peak } = m.concurrencySteps(series, "execution", EXT, 600);
  assert.equal(peak, 3);
  assert.deepEqual(
    steps.map((s) => [Math.round(s.x0), Math.round(s.x1), s.value]),
    [
      [0, 200, 2],
      [200, 400, 0],
      [400, 500, 3],
    ],
  );
  assert.equal(m.concurrencyUnavailable({ ...series, buckets: [], complete: false }), true);
  assert.equal(m.concurrencyUnavailable({ ...series, buckets: [], complete: true }), false);
  assert.equal(m.concurrencyUnavailable(null), true);
});

test("marks: one glyph per family per pixel column with a count; passed gates are not drawn", () => {
  const marks = [
    ...[0, 2, 5, 9].map((s, i) => mark(`f${i}`, "failure", T0 + HOUR + s * 1000)),
    mark("g1", "gate", T0 + HOUR, { verdict: "overridden" }),
    mark("g2", "gate", T0 + HOUR + 1000, { verdict: "refused" }),
    mark("g3", "gate", T0 + 2 * HOUR, { verdict: "passed" }),
    mark("r", "recovery", T0 + 3 * HOUR),
    mark("i", "interruption", T0 + 3 * HOUR),
    mark("w", "wave", T0 + 3 * HOUR),
  ];
  const { points } = m.aggregateMarks(marks, EXT, 600, EXT.to);
  const by = (f) => points.filter((p) => p.family === f);
  assert.equal(by("failure").length, 1);
  assert.equal(by("failure")[0].count, 4);
  assert.equal(by("failure")[0].first.id, "f0");
  assert.equal(by("gate").length, 1);
  assert.equal(by("gate")[0].count, 2);
  assert.equal(by("gate")[0].refused, true);
  assert.equal(by("halt")[0].count, 2);
  assert.equal(points.length, 3);
});

test("marks: person waits and gaps become bars, merged where they touch; an open wait runs to the live edge", () => {
  const marks = [
    mark("h1", "human", T0 + HOUR, { until: T0 + 2 * HOUR, verdict: "approved" }),
    mark("h2", "human", T0 + 2 * HOUR, { until: T0 + 2 * HOUR + MIN, verdict: "approved" }),
    mark("h3", "human", T0 + 5 * HOUR, { verdict: "required" }),
    mark("h4", "human", T0 + 4 * HOUR, { verdict: "approved" }),
    mark("gap", "gap", T0 + 3 * HOUR, { until: T0 + 3 * HOUR + 10 * MIN }),
  ];
  const { points, bars } = m.aggregateMarks(marks, EXT, 600, T0 + 5.5 * HOUR);
  const human = bars.filter((b) => b.family === "human");
  assert.equal(human.length, 2);
  assert.equal(human[0].count, 2);
  assert.equal(Math.round(human[0].x0), 100);
  assert.equal(Math.round(human[1].x1), 550);
  assert.equal(human[1].open, true);
  assert.equal(bars.filter((b) => b.family === "gap").length, 1);
  // An instant person mark (no interval) stays a glyph.
  assert.deepEqual(points.map((p) => p.family), ["human"]);
});

test("marks: tens of thousands aggregate in linear time", () => {
  const marks = Array.from({ length: 60_000 }, (_, i) => mark(`f${i}`, "failure", T0 + ((i * 7919) % (6 * HOUR))));
  const start = performance.now();
  const { points } = m.aggregateMarks(marks, EXT, 1500, EXT.to);
  assert.ok(performance.now() - start < 200);
  assert.ok(points.length <= 1500);
  assert.equal(points.reduce((n, p) => n + p.count, 0), 60_000);
});

test("brush: clamped to the extent, never narrower than the minimum", () => {
  assert.deepEqual(m.clampWindow({ from: T0 - HOUR, to: T0 + HOUR }, EXT), { from: T0, to: T0 + 2 * HOUR });
  assert.deepEqual(m.clampWindow({ from: EXT.to - HOUR, to: EXT.to + HOUR }, EXT), { from: EXT.to - 2 * HOUR, to: EXT.to });
  assert.deepEqual(m.clampWindow({ from: T0 + HOUR, to: T0 + HOUR + 1000 }, EXT), { from: T0 + HOUR, to: T0 + HOUR + MIN_WINDOW_MS });
  assert.deepEqual(m.clampWindow({ from: T0 - 99 * HOUR, to: T0 + 99 * HOUR }, EXT), EXT);
  // An extent shorter than the minimum: the window is the extent.
  const tiny = { from: T0, to: T0 + 4000 };
  assert.deepEqual(m.clampWindow({ from: T0 + 1000, to: T0 + 2000 }, tiny), tiny);
});

test("brush: move keeps the length and stops at the ends", () => {
  const w = { from: T0 + HOUR, to: T0 + 2 * HOUR };
  assert.deepEqual(m.moveWindow(w, 30 * MIN, EXT), { from: T0 + 90 * MIN, to: T0 + 150 * MIN });
  assert.deepEqual(m.moveWindow(w, -10 * HOUR, EXT), { from: T0, to: T0 + HOUR });
  assert.deepEqual(m.moveWindow(w, 10 * HOUR, EXT), { from: EXT.to - HOUR, to: EXT.to });
});

test("brush: resizing an edge keeps the other and the minimum width", () => {
  const w = { from: T0 + HOUR, to: T0 + 2 * HOUR };
  assert.deepEqual(m.resizeWindow(w, "start", T0 + 30 * MIN, EXT), { from: T0 + 30 * MIN, to: T0 + 2 * HOUR });
  assert.deepEqual(m.resizeWindow(w, "start", T0 + 3 * HOUR, EXT), { from: T0 + 2 * HOUR - MIN_WINDOW_MS, to: T0 + 2 * HOUR });
  assert.deepEqual(m.resizeWindow(w, "end", T0 - HOUR, EXT), { from: T0 + HOUR, to: T0 + HOUR + MIN_WINDOW_MS });
  assert.deepEqual(m.resizeWindow(w, "end", EXT.to + HOUR, EXT), { from: T0 + HOUR, to: EXT.to });
  assert.deepEqual(m.resizeWindow(w, "start", T0 - HOUR, EXT), { from: T0, to: T0 + 2 * HOUR });
});

test("brush: drawn either way; too narrow grows about its middle", () => {
  assert.deepEqual(m.windowBetween(T0 + 2 * HOUR, T0 + HOUR, EXT), { from: T0 + HOUR, to: T0 + 2 * HOUR });
  const mid = T0 + 3 * HOUR;
  assert.deepEqual(m.windowBetween(mid, mid + 2000, EXT), { from: mid + 1000 - MIN_WINDOW_MS / 2, to: mid + 1000 + MIN_WINDOW_MS / 2 });
  assert.deepEqual(m.windowBetween(EXT.to, EXT.to - 1000, EXT), { from: EXT.to - MIN_WINDOW_MS, to: EXT.to });
});

test("brush: wheel zoom keeps the anchor in place and respects the limits", () => {
  const w = { from: T0 + HOUR, to: T0 + 3 * HOUR };
  const anchor = T0 + 1.5 * HOUR;
  const z = m.zoomWindow(w, anchor, 0.5, EXT);
  assert.equal(z.to - z.from, HOUR);
  assert.equal((anchor - z.from) / (z.to - z.from), 0.25);
  assert.deepEqual(m.zoomWindow(w, anchor, 100, EXT), EXT);
  const tight = m.zoomWindow(w, anchor, 1e-9, EXT);
  assert.equal(tight.to - tight.from, MIN_WINDOW_MS);
  assert.ok(m.isWhole(m.zoomWindow(w, anchor, 100, EXT), EXT));
  assert.ok(!m.isWhole(w, EXT));
});

test("brush: centring keeps the length", () => {
  const w = { from: T0, to: T0 + HOUR };
  assert.deepEqual(m.centreWindow(w, T0 + 3 * HOUR, EXT), { from: T0 + 2.5 * HOUR, to: T0 + 3.5 * HOUR });
  assert.deepEqual(m.centreWindow(w, EXT.to, EXT), { from: EXT.to - HOUR, to: EXT.to });
});

test("keyboard: 1% and 10% steps, one window by page, Home and End", () => {
  const w = { from: T0 + HOUR, to: T0 + 2 * HOUR };
  const pct = 0.01 * 6 * HOUR;
  assert.deepEqual(m.keyStep("start", "ArrowLeft", false, w, EXT), { from: T0 + HOUR - pct, to: T0 + 2 * HOUR });
  assert.deepEqual(m.keyStep("start", "ArrowRight", true, w, EXT), { from: T0 + HOUR + 10 * pct, to: T0 + 2 * HOUR });
  assert.deepEqual(m.keyStep("end", "ArrowUp", false, w, EXT), { from: T0 + HOUR, to: T0 + 2 * HOUR + pct });
  assert.deepEqual(m.keyStep("end", "ArrowDown", true, w, EXT), { from: T0 + HOUR, to: T0 + 2 * HOUR - 10 * pct });
  assert.deepEqual(m.keyStep("start", "Home", false, w, EXT), { from: T0, to: T0 + 2 * HOUR });
  assert.deepEqual(m.keyStep("start", "End", false, w, EXT), { from: T0 + 2 * HOUR - MIN_WINDOW_MS, to: T0 + 2 * HOUR });
  assert.deepEqual(m.keyStep("end", "End", false, w, EXT), { from: T0 + HOUR, to: EXT.to });
  assert.deepEqual(m.keyStep("move", "ArrowRight", false, w, EXT), { from: T0 + HOUR + pct, to: T0 + 2 * HOUR + pct });
  assert.deepEqual(m.keyStep("move", "PageUp", false, w, EXT), { from: T0 + 2 * HOUR, to: T0 + 3 * HOUR });
  assert.deepEqual(m.keyStep("move", "PageDown", false, w, EXT), { from: T0, to: T0 + HOUR });
  assert.deepEqual(m.keyStep("move", "Home", false, w, EXT), { from: T0, to: T0 + HOUR });
  assert.deepEqual(m.keyStep("move", "End", false, w, EXT), { from: EXT.to - HOUR, to: EXT.to });
  assert.equal(m.keyStep("move", "Enter", false, w, EXT), null);
  // Steps never cross the other edge's minimum distance.
  const narrow = { from: T0 + HOUR, to: T0 + HOUR + MIN_WINDOW_MS };
  assert.deepEqual(m.keyStep("start", "ArrowRight", true, narrow, EXT), narrow);
});

test("ticks: adaptive steps aligned to UTC, the first carries the date, midnight is its date", () => {
  const six = m.chooseTicks(EXT, 1300, true);
  assert.equal(six.step, 30 * MIN);
  assert.equal(six.ticks[0].label, "12 Nov 08:00");
  assert.equal(six.ticks[1].label, "08:30");
  for (const t of six.ticks) assert.equal(t.t % six.step, 0);
  const narrow = m.chooseTicks(EXT, 600, true);
  assert.equal(narrow.step, HOUR);
  const days = m.chooseTicks({ from: T0, to: T0 + 3 * 24 * HOUR }, 1300, true);
  assert.equal(days.step, 6 * HOUR);
  assert.ok(days.ticks.some((t) => t.label === "13 Nov" && t.major));
  const week = m.chooseTicks({ from: T0, to: T0 + 30 * 24 * HOUR }, 800, true);
  assert.ok(week.step >= 24 * HOUR);
  assert.match(week.ticks[0].label, /^\d+ [A-Z][a-z]{2}$/);
  const secs = m.chooseTicks({ from: T0, to: T0 + 40_000 }, 1000, true);
  assert.equal(secs.ticks[1].label, "08:00:05");
  // Spacing never under the minimum.
  for (const r of [six, narrow, days, week, secs]) for (let i = 1; i < r.ticks.length; i++) assert.ok(r.ticks[i].x - r.ticks[i - 1].x >= 84 - 1e-6);
  // Scenario time: from zero, mm:ss.
  const sim = m.chooseTicks({ from: 0, to: 3_350_000 }, 1000, false);
  assert.equal(sim.ticks[0].label, "00:00");
  assert.equal(sim.ticks[1].label, "05:00");
  assert.deepEqual(m.chooseTicks({ from: 5, to: 5 }, 100, true).ticks, []);
});

test("words: window lengths and counts", () => {
  assert.equal(m.windowWords(45_000), "45 seconds");
  assert.equal(m.windowWords(60_000), "1 minute");
  assert.equal(m.windowWords(12 * MIN + 5000), "12 minutes 5 seconds");
  assert.equal(m.windowWords(2 * HOUR + 15 * MIN), "2 hours 15 minutes");
  assert.equal(m.windowWords(27 * HOUR), "1 day 3 hours");
  assert.equal(m.countText(1234567), "1,234,567");
  assert.equal(m.countText(12), "12");
});

// ---------------------------------------------------------------- wave 2: findings 1, 3 and 5; waits; hover

test("density legend: the peak is '<n> in a <bucket length>', for every bucket size from 1 s to 1 day", () => {
  const S = 1000;
  const cases = [
    [S, "a second"],
    [2 * S, "2 s"],
    [5 * S, "5 s"],
    [10 * S, "10 s"],
    [15 * S, "15 s"],
    [30 * S, "30 s"],
    [37 * S, "37 s"],
    [MIN, "a minute"],
    [72 * S, "1 min 12 s"],
    [2 * MIN, "2 min"],
    [5 * MIN, "5 min"],
    [10 * MIN, "10 min"],
    [15 * MIN, "15 min"],
    [30 * MIN, "30 min"],
    [HOUR, "an hour"],
    [2 * HOUR, "2 h"],
    [90 * MIN, "1 h 30 min"],
    [3 * HOUR, "3 h"],
    [6 * HOUR, "6 h"],
    [12 * HOUR, "12 h"],
    [24 * HOUR, "a day"],
  ];
  for (const [ms, words] of cases) {
    assert.equal(m.bucketWords(ms), words, `${ms} ms`);
    const text = m.peakWords(37, ms);
    assert.equal(text, `37 in ${words}`);
    assert.doesNotMatch(text, /37 per 37|per/);
  }
  assert.equal(m.peakWords(37, MIN), "37 in a minute");
  assert.equal(m.peakWords(3452, 5 * MIN), "3,452 in 5 min");
  assert.equal(m.bucketWords(2 * 24 * HOUR), "2 days");
});

test("limits: only one bounding something counted in the activity band is drawn", () => {
  const lim = (name, extra = {}) => ({ name, value: 3, from: T0, to: null, ...extra });
  // Absent applies-to (an older observer): only max_parallel.
  assert.equal(m.limitBoundsPlot(lim("max_parallel")), true);
  assert.equal(m.limitBoundsPlot(lim("poll_seconds")), false);
  assert.equal(m.limitBoundsPlot(lim("max_execution_minutes")), false);
  assert.equal(m.limitBoundsPlot(lim("max_runs_per_day")), false);
  // Present: by the kind it names.
  assert.equal(m.limitBoundsPlot(lim("max_parallel", { appliesTo: "execution" })), true);
  assert.equal(m.limitBoundsPlot(lim("agents_cap", { appliesTo: "agent" })), true);
  assert.equal(m.limitBoundsPlot(lim("max_parallel", { appliesTo: null })), false);
  assert.equal(m.limitBoundsPlot(lim("tools", { appliesTo: "tool" })), false);
  assert.equal(m.limitBoundsPlot(lim("poll_seconds", { appliesTo: null })), false);
  // The observer's own spelling is read too.
  assert.equal(m.limitBoundsPlot(lim("x", { applies_to: "visit" })), true);
});

test("limits: a limit that changed is drawn per interval at its own level; one in force stops at the last activity", () => {
  const limits = [
    { name: "poll_seconds", value: 300, from: T0, to: null },
    { name: "max_parallel", value: 4, from: T0 + 3 * HOUR, to: null, appliesTo: "execution" },
    { name: "max_parallel", value: 2, from: T0, to: T0 + 3 * HOUR, appliesTo: "execution" },
  ];
  const segs = m.limitSegments(limits, EXT, 600, T0 + 4 * HOUR);
  assert.deepEqual(
    segs.map((s) => [s.label, s.value, Math.round(s.x0), Math.round(s.x1), s.first]),
    [
      ["max parallel", 2, 0, 300, true],
      ["max parallel", 4, 300, 400, false],
    ],
  );
});

test("limit labels: once each, at the left, never overlapping each other or blocked space; dropped when there is no room", () => {
  const measure = (t) => t.length * 6;
  const yOf = (v) => 74 - v * 10;
  const bounds = { top: 21, bottom: 74, width: 600 };
  const seg = (name, value, x0, x1, first = true) => ({ name, label: m.limitName(name), value, kind: "execution", x0, x1, first });
  // Two limits at the same level: the second shifts right past the first.
  const two = m.placeLimitLabels([seg("max_parallel", 3, 0, 600), seg("agent_cap", 3, 0, 600)], yOf, measure, bounds);
  assert.equal(two.placed.length, 2);
  assert.equal(two.dropped.length, 0);
  const [a, b] = two.placed;
  assert.ok(a.box.x + a.box.w <= b.box.x || b.box.x + b.box.w <= a.box.x || a.box.y + a.box.h <= b.box.y || b.box.y + b.box.h <= a.box.y, "no overlap");
  assert.equal(a.x, 6, "at the left");
  // A later level of the same limit carries its value alone.
  const changed = m.placeLimitLabels([seg("max_parallel", 2, 0, 300), seg("max_parallel", 4, 300, 600, false)], yOf, measure, bounds);
  assert.deepEqual(changed.placed.map((p) => p.text), ["max parallel 2", "4"]);
  // No room in a short interval, or everything blocked: the name is dropped, its values kept for the legend.
  const tight = m.placeLimitLabels([seg("max_parallel", 2, 0, 40), seg("max_parallel", 4, 40, 600, false)], yOf, measure, bounds);
  assert.equal(tight.placed.length, 0);
  assert.deepEqual(tight.dropped, [{ name: "max_parallel", label: "max parallel", kind: "execution", values: [2, 4] }]);
  const blocked = m.placeLimitLabels([seg("max_parallel", 3, 0, 600)], yOf, measure, bounds, [{ x: 0, y: 0, w: 600, h: 80 }]);
  assert.equal(blocked.placed.length, 0);
  assert.equal(blocked.dropped.length, 1);
  // Never outside the plot's top and bottom.
  const high = m.placeLimitLabels([seg("max_parallel", 5.2, 0, 600)], yOf, measure, bounds);
  for (const p of high.placed) assert.ok(p.box.y >= bounds.top && p.y + 2 <= bounds.bottom);
});

test("idle tail: the last record is found from density and marks, and only a real tail is named", () => {
  const density = { from: EXT.from, to: EXT.to, bucketMs: MIN, buckets: [{ from: T0, count: 4 }, { from: T0 + HOUR + 12 * MIN, count: 37 }], complete: true };
  const liveAt = EXT.to;
  const last = m.lastRecorded(density, [], liveAt);
  assert.deepEqual(last, { at: T0 + HOUR + 12 * MIN, until: T0 + HOUR + 13 * MIN });
  // A later mark is exact.
  const exact = m.lastRecorded(density, [mark("f", "failure", T0 + 2 * HOUR)], liveAt);
  assert.deepEqual(exact, { at: T0 + 2 * HOUR, until: T0 + 2 * HOUR });
  // A mark inside the last bucket narrows its start.
  const inside = m.lastRecorded(density, [mark("f", "failure", T0 + HOUR + 12 * MIN + 30_000)], liveAt);
  assert.deepEqual(inside, { at: T0 + HOUR + 12 * MIN + 30_000, until: T0 + HOUR + 13 * MIN });
  assert.equal(m.lastRecorded(null, [], liveAt), null);
  const tail = m.idleTail(last, liveAt, EXT, 600);
  assert.ok(tail);
  assert.equal(tail.idleMs, liveAt - last.until);
  assert.equal(Math.round(tail.liveX), 600);
  // Activity to the edge: no tail.
  assert.equal(m.idleTail({ at: liveAt - MIN, until: liveAt }, liveAt, EXT, 600), null);
  const clock = (t) => new Date(t).toISOString().slice(11, 16);
  assert.equal(m.lastRecordedWords({ at: T0, until: T0 }, clock), "last recorded 08:00");
  assert.equal(m.lastRecordedWords(last, clock), "last recorded 09:12–09:13");
  // After the last span ends, the activity series draws nothing.
  assert.deepEqual(m.trimTrailingZero([{ x0: 0, x1: 10, value: 1 }, { x0: 10, x1: 20, value: 0 }, { x0: 20, x1: 30, value: 0 }]), [{ x0: 0, x1: 10, value: 1 }]);
});

test("person waits: who is waited for, by role, and for how long", () => {
  const open = mark("h", "human", T0, { verdict: "required", label: "A person is needed to approve LOCAL-042" });
  assert.equal(m.waitWords(open, T0 + 7 * HOUR + MIN), "waiting for a person for 7 h 1 min");
  const ended = mark("h2", "human", T0, { verdict: "approved", until: T0 + 51 * MIN, label: "A person approved LOCAL-033" });
  assert.equal(m.waitWords(ended, T0 + 9 * HOUR), "waited 51 min for a person");
  assert.equal(m.roleOf(mark("e", "human", T0, { label: "Waiting for an engineer to merge" })), "an engineer");
  // An open wait runs to the live edge as an open bar (no end mark); an ended one is closed.
  const { bars } = m.aggregateMarks([{ ...open, at: T0 + 4.5 * HOUR }, { ...ended, at: T0 + 3 * HOUR, until: T0 + 4 * HOUR }], EXT, 600, T0 + 5 * HOUR);
  const byOpen = Object.fromEntries(bars.map((b) => [b.first.id, b]));
  assert.equal(byOpen.h.open, true);
  assert.equal(Math.round(byOpen.h.x1), 500);
  assert.equal(byOpen.h2.open, false);
});

test("hover and keyboard: a column's time, events, spans by kind and landmarks; a window's totals", () => {
  const density = { from: EXT.from, to: EXT.to, bucketMs: MIN, buckets: [{ from: T0 + HOUR, count: 37 }, { from: T0 + 2 * HOUR, count: 5 }], complete: true };
  const concurrency = { from: EXT.from, to: EXT.to, bucketMs: MIN, buckets: [{ from: T0 + HOUR, active: { execution: { max: 2, mean: 1 }, agent: { max: 1, mean: 1 } } }], limits: [], complete: true };
  const marks = [...[0, 1, 2].map((i) => mark(`f${i}`, "failure", T0 + HOUR + i * 1000)), mark("g", "gate", T0 + HOUR, { verdict: "refused" })];
  const agg = m.aggregateMarks(marks, EXT, 360, EXT.to);
  const clock = (t) => new Date(t).toISOString().slice(11, 19);
  const col = m.describeColumn({ x: 60.2, extent: EXT, width: 360, liveAt: EXT.to, density, concurrency, points: agg.points, bars: agg.bars, clock });
  assert.equal(col.title, "09:00:12");
  assert.deepEqual(col.lines, ["37 events recorded in the minute from 09:00:00", "Most at once: 2 executions running, 1 agent", "3 failures, 1 gate refusal or override"]);
  const quiet = m.describeColumn({ x: 300, extent: EXT, width: 360, liveAt: EXT.to, density, concurrency, points: [], bars: [], clock });
  assert.deepEqual(quiet.lines, ["No events recorded in this minute", "No recorded spans active"]);
  const after = m.describeColumn({ x: 300, extent: EXT, width: 360, liveAt: T0 + HOUR, density, concurrency, points: [], bars: [], clock });
  assert.match(after.lines[0], /after the live edge/);
  const text = m.describeWindow({ from: T0 + 30 * MIN, to: T0 + 90 * MIN }, density, concurrency, marks);
  assert.equal(text, "In this window: 37 events recorded; at most 2 executions running, 1 agent at once; 3 failures, 1 gate refusal or override.");
});

test("scale: 20,000 marks and a 30-hour series aggregate well inside a frame", () => {
  const ext = { from: T0, to: T0 + 30 * HOUR };
  const marks = Array.from({ length: 20_000 }, (_, i) => mark(`x${i}`, i % 4 === 0 ? "failure" : i % 4 === 1 ? "gate" : i % 4 === 2 ? "interruption" : "human", T0 + ((i * 104_729) % (30 * HOUR)), i % 4 === 1 ? { verdict: "refused" } : i % 4 === 3 ? { until: T0 + ((i * 104_729) % (30 * HOUR)) + 5 * MIN, verdict: "approved" } : {}));
  const buckets = Array.from({ length: 1500 }, (_, i) => ({ from: T0 + i * 72_000, count: 50 + (i % 300) }));
  const density = { from: ext.from, to: ext.to, bucketMs: 72_000, buckets, complete: true };
  // Warm up, then time.
  m.aggregateMarks(marks, ext, 1300, ext.to);
  // The best of five, so a busy machine does not fail the test; the browser measurement is in the proof page.
  let ms = Infinity;
  for (let r = 0; r < 5; r++) {
    const start = performance.now();
    m.densityColumns(density, ext, 1300);
    m.aggregateMarks(marks, ext, 1300, ext.to);
    m.lastRecorded(density, marks, ext.to);
    ms = Math.min(ms, performance.now() - start);
  }
  assert.ok(ms < 8, `${ms.toFixed(2)} ms`);
});

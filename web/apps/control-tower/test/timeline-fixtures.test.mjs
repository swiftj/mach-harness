// M6.3: the Timeline's scale fixtures (test/fixtures/timeline.mjs) are contract-shaped, repeatable,
// big enough for the performance budget and quick to make; the fake TimelineData answers windows,
// caps, marks and subscriptions as the contract says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import "./_load.mjs";
import { concurrencyFixture, densityFixture, fakeTimelineData, marksFixture, spansFixture } from "./fixtures/timeline.mjs";

const contract = await import("../src/timeline/contract.ts");

const KINDS = ["wave", "slice-wait", "slice-eligible", "capacity-wait", "cell", "round", "visit", "task", "seat", "gate-wait", "person-wait", "claim", "execution", "workflow", "agent-queue", "agent", "tool"];
const BASES = ["measured", "bounded", "inferred", "open", "unknown"];

function checkEnd(e, where) {
  if (e === null) return;
  for (const k of ["eventId", "at", "precision", "notBefore", "notAfter", "basis", "rule", "reason"]) assert.ok(k in e, `${where}: ${k}`);
  assert.ok(e.basis === "recorded" || e.basis === "inferred", where);
  assert.ok(e.at !== null || e.notBefore !== null || e.precision === "unknown", `${where}: no time and no bounds`);
}

test("spans: contract shape, every kind and basis, at the target size and speed", () => {
  // The best of three, so a busy machine does not fail the test.
  let fx, marks, ms = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    fx = spansFixture({});
    marks = marksFixture(fx);
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.ok(fx.spans.length >= 55000 && fx.spans.length <= 70000, `${fx.spans.length} spans`);
  assert.ok(marks.length >= 20000, `${marks.length} marks`);
  assert.ok(ms < 500, `generated in ${ms.toFixed(0)} ms`);
  const kinds = new Set();
  const bases = new Set();
  const ids = new Set();
  for (const s of fx.spans) {
    assert.equal(s.id, `${s.kind}:${s.entity}`);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    kinds.add(s.kind);
    bases.add(s.duration.basis);
    checkEnd(s.start, s.id);
    checkEnd(s.end, s.id);
    assert.ok(s.start !== null || s.end !== null, s.id);
    if (s.end === null) assert.equal(s.outcome, null, `${s.id}: an open span has no outcome`);
    if (s.duration.basis === "open") assert.equal(s.end, null);
    if (s.duration.basis === "measured") assert.ok(s.duration.ms >= 0, s.id);
    if (s.duration.basis === "bounded") assert.ok(s.duration.minMs !== null || s.end?.notBefore !== null, s.id);
    const x = contract.extentOf(s);
    assert.ok(x !== null && x.from <= x.to, s.id);
  }
  assert.deepEqual([...kinds].sort(), [...KINDS].sort());
  assert.deepEqual([...bases].sort(), [...BASES].sort());
  assert.ok(fx.spans.some((s) => s.attrs.interruptedAt && s.end.reason === "interrupted"), "an interrupted visit");
  assert.ok(fx.spans.some((s) => s.kind === "agent" && s.attrs.toolsCountOnly), "count-only agents");
  assert.ok(fx.spans.some((s) => s.kind === "tool" && s.parent?.endsWith("/main")), "main-loop tools");
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i - 1].at <= marks[i].at);
  assert.ok(new Set(marks.map((m) => m.kind)).size >= 9);
});

test("spans and marks are a function of the seed", () => {
  const a = spansFixture({ cells: 4, executionsPerCell: 2, agentsPerExecution: 10, toolsPerAgent: 4, seed: 5 });
  const b = spansFixture({ cells: 4, executionsPerCell: 2, agentsPerExecution: 10, toolsPerAgent: 4, seed: 5 });
  const c = spansFixture({ cells: 4, executionsPerCell: 2, agentsPerExecution: 10, toolsPerAgent: 4, seed: 6 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  assert.equal(JSON.stringify(marksFixture(a, { count: 500 })), JSON.stringify(marksFixture(b, { count: 500 })));
});

test("fake TimelineData: windowed overlap matches a full scan, caps flag truncation, marks and nextMark", async () => {
  const data = fakeTimelineData({ cap: 2000 });
  const { spans } = data.fixture;
  const ext = data.extent();
  const span = ext.to - ext.from;
  for (const [f, t] of [[0.1, 0.12], [0.5, 0.501], [0.9, 1], [0, 1]]) {
    const window = { from: ext.from + f * span, to: ext.from + t * span };
    const page = await data.spans({ window, kinds: ["visit", "execution", "agent", "person-wait", "slice-wait"] });
    const want = spans.filter((s) => ["visit", "execution", "agent", "person-wait", "slice-wait"].includes(s.kind) && contract.overlaps(s, window));
    assert.equal(page.total, want.length, `window ${f}-${t}`);
    assert.equal(page.truncated, want.length > 2000);
    assert.equal(page.spans.length, Math.min(2000, want.length));
  }
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) await data.spans({ window: { from: ext.from + (i / 200) * span, to: ext.from + (i / 200) * span + span / 50 } });
  assert.ok(performance.now() - t0 < 1000, "200 window queries in under a second");
  const one = spans.find((s) => s.kind === "workflow");
  assert.equal(await data.span(one.id), one);
  const mid = ext.from + span / 2;
  const next = await data.nextMark(mid, 1, ["failure"]);
  const prev = await data.nextMark(mid, -1, ["failure"]);
  assert.ok(next.at > mid && next.kind === "failure");
  assert.ok(prev.at < mid && prev.kind === "failure");
  const inWindow = await data.marks({ from: mid, to: mid + span / 10 }, ["gate"]);
  assert.ok(inWindow.length > 0 && inWindow.every((m) => m.kind === "gate" && m.at >= mid && m.at <= mid + span / 10));
  const c = await data.concurrency({ from: ext.from, to: ext.to }, 120);
  assert.equal(c.buckets.length, 120);
  assert.ok(c.buckets.some((b) => (b.active.agent?.max ?? 0) > 0));
  assert.equal(c.limits[0].value, 3);
  const d = await data.density({ from: ext.from, to: ext.to }, 300);
  assert.ok(d.buckets.length > 0 && d.buckets.every((b) => b.count > 0));
  let heard = 0;
  const off = data.subscribe(() => heard++);
  data.advance(60000);
  off();
  data.advance(60000);
  assert.equal(heard, 1);
  assert.equal(data.extent().to, ext.to + 120000);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(data.spans({ window: ext }, ac.signal), { name: "AbortError" });
});

test("concurrency and density helpers on a small set", () => {
  const fx = spansFixture({ cells: 4, executionsPerCell: 2, agentsPerExecution: 6, toolsPerAgent: 2 });
  const w = fx.extent;
  const c = concurrencyFixture(fx.spans, w, 10);
  assert.equal(c.bucketMs * 10 >= w.to - w.from, true);
  const d = densityFixture(fx.spans, w, 50, { ticket: fx.tickets[0] });
  assert.ok(d.buckets.length > 0);
});

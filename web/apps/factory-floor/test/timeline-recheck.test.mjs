// M6.3 recheck R1: a behind past tile whose notice fell while an earlier one was pending is still told about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { live } from "./_load.mjs";
import { fakeObserver } from "./fixtures/observer.mjs";
const { createObserverTimelineData } = await import("../src/timeline/data/observer.ts");
const { createObserverClient } = live;
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
function wire(kind, entity, start, end) {
  return { span_id: `${kind}:${entity}`, kind, entity, parent: null, ids: {}, start: { event_id: `s-${entity}`, at: iso(T0 + start), precision: "ms", basis: "recorded" },
    end: { event_id: `e-${entity}`, at: iso(T0 + end), precision: "ms", basis: "recorded", reason: "completed" }, duration: { ms: end - start, min_ms: null, max_ms: null, basis: "measured" }, outcome: null, lane: 0, authority: "authoritative" };
}
function clock() {
  let now = T0; let id = 1; const q = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) { const h = id++; q.set(h, { fn, at: now + ms }); return h; },
    clearTimeout(h) { q.delete(h); },
    advance(ms) { const end = now + ms; for (;;) { let best = null; for (const [h, t] of q) if (t.at <= end && (!best || t.at < best[1].at)) best = [h, t]; if (!best) break; q.delete(best[0]); now = best[1].at; best[1].fn(); } now = end; },
    get pending() { return q.size; },
  };
}
function store0() {
  let state = { source: "live", logVersion: 0, arrived: 0, liveAt: T0 + 600 * MIN, extent: { kind: "so-far", start: T0, end: T0 + 600 * MIN, events: 10, belowFloor: 0 }, series: null };
  const ls = new Set();
  return { getState: () => state, subscribe(l) { ls.add(l); return () => ls.delete(l); }, set(p) { state = { ...state, ...p }; for (const l of [...ls]) l(); } };
}

test("R1: a late event reaching a past tile fetched shortly before it is told about", async () => {
  const t = clock();
  const store = store0();
  const server = fakeObserver({});
  server.spans = [wire("cell", "cell:a", 0, MIN), wire("cell", "cell:c", 200 * MIN, 201 * MIN)];
  const provider = createObserverTimelineData(createObserverClient({ fetch: server.fetch }), store, { timers: t, now: () => t.now });
  let told = 0;
  provider.subscribe(() => (told += 1));
  const A = { from: T0, to: T0 + 10 * MIN };
  const C = { from: T0 + 200 * MIN, to: T0 + 210 * MIN };
  await provider.spans({ window: A });
  t.advance(100);
  server.commit([{ id: "e1", type: "x", time: { order_ms: T0 } }]);
  store.set({ logVersion: 1, arrived: 1 }); // A behind, notice due in ~1900 ms
  t.advance(1800);
  await provider.spans({ window: C }); // C read at t=1900
  t.advance(50);
  // A late event lands in C's window.
  server.spans = [...server.spans, wire("visit", "visit:late", 202 * MIN, 203 * MIN)];
  server.commit([{ id: "e2", type: "x", time: { order_ms: T0 + 202 * MIN } }]);
  store.set({ logVersion: 2, arrived: 2 });
  const toldAfterE2 = told;
  t.advance(10_000); // run every timer for 10 s; nothing else arrives
  const toldLater = told - toldAfterE2;
  // Each notice makes the UI re-query; simulate re-query only at notices: query C right after the A notice (at ~2000).
  // If only the A notice (at t=2000, C not due yet) happened, C is never told again.
  const page = await provider.spans({ window: C });
  assert.ok(page.spans.some((x) => x.id === "visit:visit:late"), "the late span is read once C is due");
  assert.ok(toldLater >= 2, `expected a notice when C is due as well; got ${toldLater}`);
});

test("R6: a tile whose pages answered from different projection positions is read again", async () => {
  const t = clock();
  const store = store0();
  let reads = 0;
  const cursorOf = (pos) => `6b1f0e9a2c4d8e10:${pos}`;
  const client = {
    async spans({ offset = 0 }) {
      reads += 1;
      // A first read pages across a write (positions 10 then 11); later reads are consistent.
      const pos = reads === 2 ? 11 : reads <= 2 ? 10 : 11;
      const items = offset === 0 ? [wire("cell", "cell:a", 0, MIN)] : [wire("cell", "cell:b", 2 * MIN, 3 * MIN)];
      return { items, more: offset === 0, truncated: false, total: 2, totalUncapped: 2, cursor: cursorOf(pos) };
    },
  };
  const provider = createObserverTimelineData(client, store, { timers: t, now: () => t.now, pageLimit: 1 });
  let told = 0;
  provider.subscribe(() => (told += 1));
  const A = { from: T0, to: T0 + 5 * MIN };
  await provider.spans({ window: A });
  assert.equal(reads, 2);
  t.advance(10_000);
  assert.ok(told >= 1, "told to read again");
  await provider.spans({ window: A });
  assert.equal(reads, 4, "the tile was read again");
  t.advance(10_000);
  const before = reads;
  await provider.spans({ window: A });
  assert.equal(reads, before, "a consistent read is kept");
});

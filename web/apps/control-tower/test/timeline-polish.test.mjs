// M6.3 polish: an execution, workflow, agent or visit still open at the end of a history that is no
// longer live (a replay; a Factory recorded as disabled with no supervisor lease) is "no end recorded;
// the history ends at …" with the ring-query, never "at work". Presentation only: nothing is closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { live } from "./_load.mjs";
import { fakeObserver, fakeTimers, settle } from "./fixtures/observer.mjs";

const contract = await import("../src/timeline/contract.ts");
const derive = await import("../src/timeline/data/derive.ts");
const words = await import("../src/timeline/render/words.ts");
const lod = await import("../src/timeline/render/lod.ts");
const draw = await import("../src/timeline/render/draw.ts");
const frame = await import("../src/timeline/controls/frame.ts");
const inspector = await import("../src/timeline/inspector/model.ts");
const { createObserverTimelineData } = await import("../src/timeline/data/observer.ts");
const { at, span } = await import("../src/timeline/dev/fixture.ts");

const T0 = Date.UTC(2026, 10, 13, 5, 29, 0);
const M = 60_000;
const END = T0 + 73 * M;
const LATER = END + 7 * 60 * M;

const open = (id, kind, extra = {}) => span(id, kind, at(T0 + M), null, extra);

test("endsWithHistory tags open work only, keeps identity, closes nothing; null leaves the history live", () => {
  const exec = open("x", "execution");
  const visit = open("v", "visit", { ids: { station: "build" } });
  const person = open("h", "visit", { ids: { station: "human-approval" } });
  const cell = open("c", "cell");
  const ended = span("e", "agent", at(T0), at(T0 + M));
  const spans = [exec, visit, person, cell, ended];
  assert.equal(derive.endsWithHistory(spans, null), spans, "live: unchanged");
  const tagged = derive.endsWithHistory(spans, END);
  assert.deepEqual(tagged.map((s) => s.attrs.historyEndsAt), [END, END, undefined, undefined, undefined]);
  assert.ok(tagged.every((s) => s.end === null || s === ended), "nothing is closed");
  assert.equal(derive.endsWithHistory(spans, END)[0], tagged[0], "one tagged object per span and end");
});

test("the words, the bar, the row and the default window: no end recorded, never at work", () => {
  const [x] = derive.endsWithHistory([open("x", "execution")], END);
  assert.equal(contract.noEndRecorded(x, LATER), true);
  assert.match(words.durationWords(x, LATER), /^no end recorded; the history ends at 06:42:00/);
  assert.doesNotMatch(words.describeSpan(x, LATER), /at work|running/);
  assert.equal(contract.attentionOf(x, LATER), "unknown");
  const t = lod.spanTimes(x, LATER);
  assert.equal(t.open, false);
  assert.equal(t.noEnd, true);
  assert.equal(t.to, END, "drawn to the history's end, not to the wall clock");
  assert.equal(draw.shortDuration(x, t.from, t.to, t.open), "no end recorded");
  assert.equal(frame.isRunning(x), false, "the default window does not run to the wall clock for it");
  assert.match(inspector.durationSentence(x, LATER).text, /^No end recorded; the history ends at/);
  assert.equal(inspector.durationSentence(x, LATER).live, null);
  // Seen before the history's end (a replay's playhead): at work as of then, as a live view said.
  assert.match(words.durationWords(x, T0 + 10 * M), /^at work for/);
  // A live, enabled Factory: untagged, at work.
  assert.match(words.durationWords(open("y", "execution"), LATER), /^at work for/);
});

function fakeStore(initial) {
  let state = { source: "live", logVersion: 0, liveAt: LATER, extent: { kind: "so-far", start: T0, end: LATER, events: 10, belowFloor: 0 }, series: null, factoryStatus: null, log: { headTime: () => END }, ...initial };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();
const wireExec = { span_id: "execution:execution:x1", kind: "execution", entity: "execution:x1", parent: null, ids: { execution_id: "x1", ticket_id: "T-1" }, start: { event_id: "e1", at: iso(T0 + M), precision: "ms", basis: "recorded" }, end: null, duration: { ms: null, min_ms: null, max_ms: null, basis: "open" }, outcome: null, lane: 0, authority: "authoritative", attrs: { state: "running" } };

async function answer(storePatch) {
  const server = fakeObserver({});
  server.spans = [wireExec];
  const client = live.createObserverClient({ fetch: server.fetch });
  const timers = fakeTimers();
  const store = fakeStore(storePatch);
  const data = createObserverTimelineData(client, store, { timers });
  const page = data.spans({ window: { from: T0, to: LATER } });
  await settle();
  return (await page).spans.find((s) => s.kind === "execution");
}

const status = (recordedState, leasePresent) => ({ recordedState, supervisor: { leasePresent, heartbeatFresh: null, heartbeatAgeSeconds: null, leaseExpired: null } });

test("the provider tags only a replay, or a Factory recorded disabled with no lease; the observer's span stays open", async () => {
  assert.equal((await answer({ source: "replay" })).attrs.historyEndsAt, END);
  assert.equal((await answer({ factoryStatus: status("disabled", false) })).attrs.historyEndsAt, END);
  assert.equal((await answer({ factoryStatus: status("disabled", true) })).attrs.historyEndsAt, undefined, "a lease is held: live");
  assert.equal((await answer({ factoryStatus: status("supervised", false) })).attrs.historyEndsAt, undefined, "enabled: at work");
  assert.equal((await answer({})).attrs.historyEndsAt, undefined, "status not read: live");
  assert.equal((await answer({ source: "replay" })).end, null);
});

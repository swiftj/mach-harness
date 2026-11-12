// M6.2: the live source against an in-memory observer: history pages, the stream, reconnection from
// the durable cursor, gap (history missing: partial, snapshot reload) and reset (index rebuilt), stale
// detection, no seek past the live edge, replay while ingest continues, and the person's selection,
// mode, camera intent and playhead surviving all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { live } from "./_load.mjs";
import { beltRun, finalize } from "./fixtures/v3.mjs";
import { fakeObserver, fakeTimers, settle } from "./fixtures/observer.mjs";

const { manualClock } = await import("../src/scene/clock.ts");
const { createObserverClient, createLiveFactory } = live;

const RUN = finalize(beltRun().events);
/** An event as committed by the observer: it assigns the position. */
const unpos = (e) => {
  const copy = { ...e };
  delete copy.pos;
  return copy;
};
const SPLIT = Math.floor(RUN.length * 0.6);

async function setup({ snapshot = false, history = RUN.slice(0, SPLIT), pageLimit = 50 } = {}) {
  const server = fakeObserver({ snapshot });
  server.commit(history.map(unpos));
  const clock = manualClock(0);
  const timers = fakeTimers();
  const client = createObserverClient({ fetch: server.fetch });
  const { store, source, log } = createLiveFactory({ client, openStream: server.openStream, clock, timers, pageLimit, staleAfterMs: 30_000 });
  await source.start();
  await settle();
  clock.frames(1, 16);
  return { server, clock, timers, store, source, log };
}
const push = (server, events) => server.commit(events.map(unpos));

test("connects: history in pages, then the stream from the cursor; events apply once per frame", async () => {
  const { server, clock, store, source, log } = await setup();
  assert.equal(log.size(), SPLIT);
  assert.ok(server.requests.filter((r) => r.includes("/events")).length >= Math.ceil(SPLIT / 50), "paged");
  assert.equal(server.live().length, 1);
  assert.equal(server.live()[0].after, `${server.generation}.${SPLIT}`, "the stream starts after the last applied cursor");
  assert.equal(store.getState().connection.state, "live");
  assert.equal(store.getState().source, "live");
  assert.equal(store.getState().log.head().provenance.source, "live");
  push(server, RUN.slice(SPLIT, SPLIT + 20));
  assert.equal(log.size(), SPLIT, "not applied before the frame");
  clock.frames(1, 16);
  assert.equal(log.size(), SPLIT + 20, "one batch on the next frame");
  assert.equal(source.status().cursor, `${server.generation}.${SPLIT + 20}`);
  assert.equal(store.getState().following, true);
  assert.ok(store.getState().liveAt >= RUN[SPLIT + 19].time.order_ms);
  assert.equal(store.getState().extent.kind, "so-far");
  source.stop();
});

test("reconnects from the durable cursor after a drop, without re-applying anything", async () => {
  const { server, clock, timers, store, source, log } = await setup();
  server.drop();
  assert.equal(store.getState().connection.state, "reconnecting");
  push(server, RUN.slice(SPLIT, SPLIT + 30)); // committed while the browser was away
  timers.runTimeouts();
  await settle();
  clock.frames(1, 16);
  assert.equal(log.size(), SPLIT + 30);
  assert.equal(log.stats().duplicates, 0, "the cursor resumed exactly");
  const after = server.live().at(-1).after;
  assert.equal(after, `${server.generation}.${SPLIT + 30}`);
  assert.equal(store.getState().connection.state, "live");
  source.stop();
});

test("gap: history missing is marked partial, a snapshot is reloaded; selection, mode, camera and replay playhead survive", async () => {
  const { server, clock, store, source, log } = await setup({ snapshot: true });
  store.select("cell:LOCAL-031");
  store.setView("blueprint");
  store.setFollow(false);
  const replayAt = RUN[100].time.order_ms;
  store.seek(replayAt);
  const focus = store.getState().focus;
  // The browser falls behind (its stream delivers nothing for a while): the observer moves on and forgets.
  const stream = server.live()[0];
  stream.closed = true;
  const later = server.commit(RUN.slice(SPLIT, SPLIT + 40).map(unpos));
  stream.closed = false;
  server.expire(later.at(-1).pos - 10);
  server.snapshotState = { cells: [{ ticket_id: "LOCAL-031", stage: "verified", rounds: 2 }] };
  server.sendGap();
  await settle();
  clock.frames(1, 16);
  const s = store.getState();
  assert.equal(s.selection, "cell:LOCAL-031");
  assert.equal(s.view, "blueprint");
  assert.equal(s.follow, false);
  assert.equal(s.focus, focus);
  assert.equal(s.playhead, replayAt, "the replay's playhead is kept");
  assert.equal(s.following, false);
  const head = log.head();
  assert.equal(head.completeness.state, "reconstructed", "seeded from a snapshot after missing history");
  assert.ok(head.completeness.gaps.some((g) => g.reason === "cursor-expired"));
  assert.equal(s.connection.gaps, 1);
  assert.equal(s.connection.state, "live");
  assert.equal(log.sceneAt(replayAt).completeness.state, "complete", "before the gap, history was complete");
  source.stop();
});

test("reset: the index was rebuilt; history reloads from the new epoch and de-duplicates; nothing the person set is lost", async () => {
  const { server, clock, store, source, log } = await setup();
  store.select("agent:" + RUN.find((e) => e.type === "agent.started").ids.agent_id);
  const before = log.head();
  server.rebuild("aaaabbbbccccdddd");
  await settle();
  clock.frames(1, 16);
  assert.equal(store.getState().connection.resets, 1);
  assert.equal(store.getState().connection.generation, "aaaabbbbccccdddd");
  assert.equal(log.size(), SPLIT);
  assert.ok(log.stats().duplicates >= SPLIT, "everything re-delivered was dropped");
  assert.equal(log.head(), before, "no change, no transition");
  assert.match(store.getState().selection, /^agent:/);
  push(server, RUN.slice(SPLIT, SPLIT + 5));
  clock.frames(1, 16);
  assert.equal(log.size(), SPLIT + 5);
  source.stop();
});

test("stale: silence beyond the bound is shown, with the last confirmed moment; the edge stops moving; any message is live again", async () => {
  const { server, clock, timers, store, source } = await setup();
  const confirmed = store.getState().connection.confirmedAt;
  clock.frames(10, 1000);
  timers.tick();
  assert.equal(store.getState().connection.state, "live");
  clock.frames(30, 1000);
  timers.tick();
  const s = store.getState();
  assert.equal(s.connection.state, "stale");
  assert.equal(s.connection.staleSince, confirmed);
  const edge = s.liveAt;
  clock.frames(30, 1000);
  assert.equal(store.getState().liveAt, edge, "a stale connection does not carry the edge forward");
  server.heartbeat(RUN[SPLIT].time.order_ms + 60_000);
  assert.equal(store.getState().connection.state, "live");
  assert.equal(store.getState().connection.sourceLagMs, 1500, "lag: heartbeat time minus the observer's settled watermark");
  source.stop();
  assert.equal(store.getState().connection.state, "disconnected");
});

test("no seek past the live edge; stepping forward stops at it", async () => {
  const { store, source } = await setup();
  const edge = store.getState().liveAt;
  store.seek(edge + 3_600_000);
  assert.equal(store.getState().playhead, edge);
  store.stepNext();
  assert.ok(store.getState().playhead <= store.getState().liveAt);
  store.seek(0);
  assert.equal(store.getState().playhead, RUN[0].time.order_ms, "and not below the first event received");
  source.stop();
});

test("replay while ingest continues: the playhead stays, the edge moves, return to live re-attaches", async () => {
  const { server, clock, store, source, log } = await setup();
  const at = RUN[120].time.order_ms;
  store.seek(at);
  const scene = log.sceneAt(at);
  push(server, RUN.slice(SPLIT, SPLIT + 50));
  clock.frames(1, 16);
  const s = store.getState();
  assert.equal(s.following, false);
  assert.equal(s.playhead, at);
  assert.ok(s.liveAt >= RUN[SPLIT + 49].time.order_ms, "ingest went on");
  assert.equal(log.sceneAt(at), scene, "the replayed moment is the same object");
  store.play();
  clock.frames(5, 100);
  assert.ok(store.getState().playhead > at, "replay plays");
  store.followLive();
  assert.equal(store.getState().following, true);
  assert.equal(store.getState().playhead, store.getState().liveAt);
  source.stop();
});

test("selection survives ordinary updates; the supervisor's heartbeat freshness is read", async () => {
  const { server, clock, store, source, timers } = await setup();
  store.select("cell:LOCAL-031");
  store.hover("slice:SLICE-021");
  push(server, RUN.slice(SPLIT));
  clock.frames(2, 16);
  assert.equal(store.getState().selection, "cell:LOCAL-031");
  assert.ok(store.getState().highlighted.includes("cell:LOCAL-031"));
  server.status = { ...server.status, supervisor: { lease_present: true, heartbeat_fresh: false, heartbeat_age_seconds: 95, lease_expired: false } };
  timers.tick();
  await settle();
  assert.deepEqual(store.getState().connection.supervisor, { heartbeatAgeSeconds: 95, live: false, present: true, readAt: Date.parse("2026-11-12T09:00:00Z") });
  source.stop();
});

test("an observer that answers 401 puts the connection in the no-session state, not retried", async () => {
  const server = fakeObserver();
  const clock = manualClock(0);
  const timers = fakeTimers();
  const fetch = async (url) => (url.includes("/session") ? { status: 401, json: async () => ({ ok: false, error: { kind: "unauthorized", message: "no session" } }) } : server.fetch(url));
  const { store, source } = createLiveFactory({ client: createObserverClient({ fetch }), openStream: server.openStream, clock, timers });
  await source.start();
  await settle();
  assert.equal(store.getState().connection.state, "no-session");
  assert.equal(timers.pendingTimeouts, 0, "a session cannot come back by retrying");
  source.stop();
});

test("Historical Replay: a loaded history is labelled replay, its edge is its last event", async () => {
  const server = fakeObserver();
  server.commit(RUN.map(unpos));
  const log = await live.loadHistory(createObserverClient({ fetch: server.fetch }), { pageLimit: 100 });
  const { createSceneStore } = await import("../src/scene/store.ts");
  const store = createSceneStore({ source: "replay", log, clock: manualClock(0) });
  assert.equal(log.head().provenance.source, "replay");
  assert.equal(store.getState().connection, null);
  assert.equal(store.getState().liveAt, RUN.at(-1).time.order_ms);
  store.seek(RUN.at(-1).time.order_ms + 10_000);
  assert.equal(store.getState().playhead, RUN.at(-1).time.order_ms);
});

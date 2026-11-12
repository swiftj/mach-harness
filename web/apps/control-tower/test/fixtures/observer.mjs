// An in-memory observer for the live source's tests: the documented /api/v1 routes (session, events
// after a cursor, snapshot, factory status) behind an injected fetch, and a server-sent event stream
// behind an injected EventSource factory (hello, events with id = cursor, heartbeat, gap, reset).
// Built from M6_1_OBSERVER_DESIGN.md sections 8, 11 and 12 and the contract's section 14. It never
// starts the Go binary.

export function fakeObserver({ generation = "6b1f0e9a2c4d8e10", snapshot = false, heartbeatMs = 15000 } = {}) {
  const server = {
    generation,
    events: [], // in pos order
    floor: 0, // positions <= floor are no longer held
    snapshotCapability: snapshot,
    snapshotState: { cells: [], slices: [], executions: [], gates: [], waves: [] },
    lease: { present: true, heartbeat_age_seconds: 4, live: true },
    streams: [],
    requests: [],
    down: false,
  };
  const head = () => (server.events.length ? server.events.at(-1).pos : 0);
  const cur = (pos) => `${server.generation}.${pos}`;
  const ok = (data) => ({ status: 200, json: async () => ({ ok: true, data }) });
  const fail = (status, kind, extra = {}) => ({ status, json: async () => ({ ok: false, error: { kind, message: kind, ...extra } }) });

  server.fetch = async (url) => {
    server.requests.push(url);
    if (server.down) throw new Error("connection refused");
    const u = new URL(url, "http://127.0.0.1");
    const path = u.pathname.replace(/^\/api\/v1/, "");
    if (path === "/session") return ok({ project: { folder: "team-space" }, generation: server.generation, versions: { event: { schema: 3, revision: 0, kinds: [] } }, read_only: true, capabilities: { snapshot: server.snapshotCapability, stream_observations: { ok: true, reason: null } }, display_policy: { people: "role" } });
    if (path === "/events") {
      const after = u.searchParams.get("after") ?? `${server.generation}.0`;
      const limit = Number(u.searchParams.get("limit") ?? 1000);
      const [gen, posText] = [after.slice(0, after.lastIndexOf(".")), after.slice(after.lastIndexOf(".") + 1)];
      const pos = Number(posText);
      if (gen !== server.generation) return fail(409, "cursor_reset", { reason: "generation", generation: server.generation, floor: cur(server.floor), head: cur(head()) });
      if (pos < server.floor) return fail(410, "cursor_expired", { reason: "expired", floor: cur(server.floor), head: cur(head()) });
      const page = server.events.filter((e) => e.pos > pos).slice(0, limit);
      const next = page.length ? cur(page.at(-1).pos) : after;
      return ok({ generation: server.generation, events: page, next, head: cur(head()), floor: cur(server.floor), more: page.length > 0 && page.at(-1).pos < head() });
    }
    if (path === "/snapshot") return server.snapshotCapability ? ok({ cursor: cur(head()), generation: server.generation, reconstructed: false, state: server.snapshotState }) : fail(404, "not_found");
    if (path === "/factory/status") return ok({ lease: server.lease, read_at: "2026-11-12T09:00:00Z" });
    return fail(404, "not_found");
  };

  server.openStream = (url) => {
    const u = new URL(url, "http://127.0.0.1");
    const listeners = {};
    const es = {
      url,
      after: u.searchParams.get("after"),
      closed: false,
      onmessage: null,
      onerror: null,
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      close() {
        es.closed = true;
      },
      emit(type, data, id) {
        if (es.closed) return;
        if (type === "message") es.onmessage?.({ data: JSON.stringify(data), lastEventId: id ?? "" });
        else for (const fn of listeners[type] ?? []) fn({ data: JSON.stringify(data) });
      },
    };
    server.streams.push(es);
    // As the observer: hello first, then whatever is after the cursor, or gap / reset.
    queueMicrotask(() => {
      const after = es.after ?? cur(head());
      const gen = after.slice(0, after.lastIndexOf("."));
      const pos = Number(after.slice(after.lastIndexOf(".") + 1));
      if (gen !== server.generation) return es.emit("reset", { reason: "generation", generation: server.generation });
      if (pos < server.floor) return es.emit("gap", { reason: "expired", floor: cur(server.floor) });
      es.emit("hello", { generation: server.generation, cursor: after, head: cur(head()), floor: cur(server.floor), heartbeat_ms: heartbeatMs });
      for (const e of server.events.filter((x) => x.pos > pos)) es.emit("message", e, cur(e.pos));
    });
    return es;
  };

  server.live = () => server.streams.filter((s) => !s.closed);
  /** Commit events (positions continue from the head) and send them on every open stream. */
  server.commit = (events) => {
    let pos = head();
    const committed = events.map((e) => ({ ...e, pos: ++pos }));
    server.events.push(...committed);
    for (const es of server.live()) for (const e of committed) es.emit("message", e, cur(e.pos));
    return committed;
  };
  server.heartbeat = (at, watermark) => {
    for (const es of server.live()) es.emit("heartbeat", { head: cur(head()), at: new Date(at).toISOString(), ...(watermark === undefined ? {} : { watermark_ms: watermark }) });
  };
  /** Forget everything up to `pos`, as the memory window moving on. */
  server.expire = (pos) => {
    server.floor = pos;
  };
  server.sendGap = () => {
    for (const es of server.live()) es.emit("gap", { reason: "expired", floor: cur(server.floor) });
  };
  /** Rebuild the index: a new epoch, the same events (ids and order are deterministic), new positions. */
  server.rebuild = (newGeneration) => {
    server.generation = newGeneration;
    server.events = server.events.map((e, i) => ({ ...e, pos: i + 1 }));
    server.floor = 0;
    for (const es of server.live()) es.emit("reset", { reason: "generation", generation: newGeneration });
  };
  server.drop = () => {
    for (const es of server.live()) {
      es.closed = true;
      es.onerror?.({});
    }
  };
  return server;
}

/** Timers a test runs by hand. */
export function fakeTimers() {
  let next = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn, ms) {
      const h = next++;
      timeouts.set(h, { fn, ms });
      return h;
    },
    clearTimeout(h) {
      timeouts.delete(h);
    },
    setInterval(fn, ms) {
      const h = next++;
      intervals.set(h, { fn, ms });
      return h;
    },
    clearInterval(h) {
      intervals.delete(h);
    },
    runTimeouts() {
      const due = [...timeouts.values()];
      timeouts.clear();
      for (const t of due) t.fn();
      return due.length;
    },
    tick() {
      for (const t of [...intervals.values()]) t.fn();
    },
    get pendingTimeouts() {
      return timeouts.size;
    },
  };
}

/** Let promise chains and queued microtasks run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A small seeded generator (mulberry32), for shuffles and opaque ids. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

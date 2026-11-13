// An in-memory observer for the live source's tests: the documented /api/v1 routes (session, events
// after a cursor, history in order, snapshot at a cursor, factory status, in the shapes
// apps/observer/README.md documents) behind an injected fetch, and a server-sent event stream
// behind an injected EventSource factory (hello, events with id = cursor, heartbeat, gap, reset).
// Built from M6_1_OBSERVER_DESIGN.md sections 8, 11 and 12 and the contract's section 14. It never
// starts the Go binary.

export function fakeObserver({ generation = "6b1f0e9a2c4d8e10", snapshot = false, heartbeatMs = 15000, history = true, series = false, summaries = true } = {}) {
  const server = {
    generation,
    events: [], // in pos order
    floor: 0, // positions <= floor are no longer held
    snapshotCapability: snapshot,
    snapshotState: { cells: [], slices: [], executions: [], gates: [], waves: [] },
    /** `/factory/status`'s documented parts (apps/observer/README.md). */
    status: {
      factory_present: true,
      summary: { enabled: true, paused: false, mode: "supervised", autonomy: "supervised", policy_usable: true },
      supervisor: { lease_present: true, heartbeat_fresh: true, heartbeat_age_seconds: 4, lease_expired: false },
      freshness: { ingest: { stale: false, watermark_ms: null, catching_up: false }, sources: [{ key: "i:0badc0de", state: "live", lag_bytes: 0, last_read_age_ms: 120 }] },
    },
    historyRoute: history,
    seriesRoute: series,
    /** `/waves`, `/slices`, `/cells`, `/runs`, `/project`, `/cells/{t}`, `/artifacts` (observer M6.2 summaries). */
    summaryRoutes: summaries,
    summaries: { waves: [], slices: [], cells: [], runs: [], artifacts: [], history: { completeness: "complete", lost: {}, not_interpreted: {}, classes: {}, gaps: {}, partial: "", not_v3: 0 } },
    /** `/health` `ingest.runtime`. */
    runtime: null,
    /** The events in history order, kept like the observer's index (rebuilt only when events change). */
    inOrder: null,
    /** Cursors snapshots were asked at (null: the default). */
    snapshotsAt: [],
    streams: [],
    requests: [],
    down: false,
    // ---- M6.3 (Execution Timeline): /spans windowed, /marks, /concurrency, /series by kind.
    /** Spans in the observer's wire shape (span_id, kind, start/end with RFC 3339 `at`, attrs...). */
    spans: [],
    /** "m63": windowed with `truncated`/`total_uncapped`; "m61": today's route (no window, silent cap); false: 404. */
    spansRoute: "m63",
    /** The observer's cap on spans per reply (MaxSpans). */
    spanCap: 5000,
    /** Marks in the wire shape (mark_id, kind, at, until, event_id, entity, label, verdict, authority); null: no route (404). */
    marks: null,
    /** `/concurrency`: a function (from, to, bucket) => reply data, or null for no route (404). */
    concurrency: null,
    /** While true, every reply waits for `release()` (to test superseded and aborted requests). */
    hold: false,
    held: [],
    /** Requests whose caller aborted them before the reply. */
    aborted: [],
  };
  server.release = () => {
    const due = server.held.splice(0);
    for (const go of due) go();
    return due.length;
  };
  const head = () => (server.events.length ? server.events.at(-1).pos : 0);
  const sorted = () => (server.inOrder ??= [...server.events].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)));
  /** First index in history order whose order key is >= key. */
  const lowerOrder = (list, key) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].order < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const cur = (pos) => `${server.generation}.${pos}`;
  const ok = (data) => ({ status: 200, json: async () => ({ ok: true, data }) });
  const fail = (status, kind, extra = {}) => ({ status, json: async () => ({ ok: false, error: { kind, message: kind, ...extra } }) });

  server.fetch = async (url, init = {}) => {
    server.requests.push(url);
    if (server.down) throw new Error("connection refused");
    const signal = init.signal;
    const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    if (server.hold) {
      await new Promise((resolve, reject) => {
        server.held.push(resolve);
        signal?.addEventListener("abort", () => {
          server.aborted.push(url);
          reject(abortError());
        }, { once: true });
      });
    }
    if (signal?.aborted) {
      if (!server.aborted.includes(url)) server.aborted.push(url);
      throw abortError();
    }
    return route(url);
  };
  const route = (url) => {
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
      // Positions are contiguous from the first held event: index by position, as the observer's index does.
      const firstPos = server.events.length ? server.events[0].pos : 1;
      const page = server.events.slice(Math.max(0, pos + 1 - firstPos), Math.max(0, pos + 1 - firstPos) + limit);
      const next = page.length ? cur(page.at(-1).pos) : after;
      return ok({ generation: server.generation, events: page, next, head: cur(head()), floor: cur(server.floor), more: page.length > 0 && page.at(-1).pos < head() });
    }
    if (path === "/history") {
      if (!server.historyRoute) return fail(404, "not_found");
      const from = u.searchParams.get("from_order") ?? (u.searchParams.get("from_ms") ? String(Number(u.searchParams.get("from_ms"))).padStart(15, "0") : null);
      const to = u.searchParams.get("to_order") ?? (u.searchParams.get("to_ms") ? String(Number(u.searchParams.get("to_ms"))).padStart(15, "0") : null);
      const limit = Number(u.searchParams.get("limit") ?? 1000);
      const inOrder = sorted();
      const start = from === null ? 0 : lowerOrder(inOrder, from);
      const end = to === null ? inOrder.length : lowerOrder(inOrder, to);
      const page = inOrder.slice(start, Math.min(end, start + limit));
      const more = end - start > limit;
      return ok({ generation: server.generation, schema: 3, events: page, from_order: from, to_order: to, next_from_order: more ? inOrder[start + limit].order : null, more, complete: server.floor === 0, head: cur(head()), floor: cur(server.floor), watermark_ms: null });
    }
    if (path === "/snapshot") {
      if (!server.snapshotCapability) return fail(404, "not_found");
      const at = u.searchParams.get("at");
      server.snapshotsAt.push(at);
      if (at) {
        const pos = Number(at.slice(at.lastIndexOf(".") + 1));
        if (pos < server.floor) return fail(410, "cursor_expired", { reason: "expired", floor: cur(server.floor), head: cur(head()) });
        return ok({ cursor: at, generation: server.generation, pos, reconstructed: pos < head(), authority: pos < head() ? "reconstructed" : "projection", state: server.snapshotState });
      }
      return ok({ cursor: cur(head()), generation: server.generation, pos: head(), reconstructed: false, authority: "projection", state: server.snapshotState });
    }
    if (path === "/series") {
      // As documented (observer M6.2): counts per bucket by order_ms, sparse, over the held history.
      if (!server.seriesRoute) return fail(404, "not_found");
      const inOrder = sorted();
      const fromMs = u.searchParams.get("from_ms") ? Number(u.searchParams.get("from_ms")) : (inOrder[0]?.time.order_ms ?? 0);
      const toMs = u.searchParams.get("to_ms") ? Number(u.searchParams.get("to_ms")) : (inOrder.at(-1)?.time.order_ms ?? 0) + 1;
      const bucketMs = Number(u.searchParams.get("bucket_ms") ?? Math.max(1000, Math.ceil((toMs - fromMs) / 500)));
      const counts = new Map();
      let total = 0;
      const kindsParam = u.searchParams.get("kinds");
      const kinds = kindsParam ? new Set(kindsParam.split(",")) : null;
      const ticket = u.searchParams.get("ticket");
      const execution = u.searchParams.get("execution");
      for (const e of inOrder) {
        const t = e.time.order_ms;
        if (t < fromMs || t >= toMs) continue;
        if (kinds && !kinds.has(e.type)) continue;
        if (ticket && e.ids?.ticket_id !== ticket) continue;
        if (execution && e.ids?.execution_id !== execution) continue;
        const k = fromMs + Math.floor((t - fromMs) / bucketMs) * bucketMs;
        counts.set(k, (counts.get(k) ?? 0) + 1);
        total += 1;
      }
      return ok({ from_ms: fromMs, to_ms: toMs, bucket_ms: bucketMs, buckets: [...counts].map(([from_ms, count]) => ({ from_ms, count, kinds: {}, authorities: {} })), total, kinds: {}, authorities: {}, head: cur(head()), watermark_ms: null, complete: server.floor === 0, ...(kinds ? { kinds_applied: [...kinds] } : {}) });
    }
    if (path === "/spans") return spansReply(u);
    if (path === "/marks") return marksReply(u);
    if (path === "/concurrency") {
      if (!server.concurrency) return fail(404, "not_found");
      const n = (k) => Number(u.searchParams.get(k));
      return ok({ ...server.concurrency(n("from_ms"), n("to_ms"), n("bucket_ms")), cursor: cur(head()) });
    }
    if (path === "/factory/status") return ok({ ...server.status, report: {}, recorded_mode: null, read_at: "2026-11-12T09:00:00Z" });
    // The summaries (observer M6.2 shapes): lists paged with limit/offset and the projection's cursor.
    if (server.summaryRoutes) {
      const page = (items) => {
        const limit = Number(u.searchParams.get("limit") ?? 200);
        const offset = Number(u.searchParams.get("offset") ?? 0);
        const slice = items.slice(offset, offset + limit);
        return ok({ items: slice, total: items.length, offset, more: offset + slice.length < items.length, cursor: cur(head()) });
      };
      if (path === "/waves") return ok({ items: server.summaries.waves, cursor: cur(head()) });
      if (path === "/slices") return page(server.summaries.slices);
      if (path === "/cells") return page(server.summaries.cells);
      if (path === "/runs") return page(server.summaries.runs);
      if (path === "/project") return ok({ history: server.summaries.history, cursor: cur(head()) });
      if (path.startsWith("/cells/")) {
        const c = server.summaries.cells.find((x) => x.ticket_id === decodeURIComponent(path.slice(7)));
        return c ? ok({ ...c, cursor: cur(head()) }) : fail(404, "not_found");
      }
      if (path === "/artifacts") return page(server.summaries.artifacts ?? []);
    }
    if (path === "/health") return ok({ status: "ok", index: { head: cur(head()), floor: cur(server.floor) }, projection: { history: server.summaries.history }, ingest: { runtime: server.runtime, delivery: { last_hold_ms: 120, hold_ms_p95: 300 } }, freshness: server.status.freshness });
    return fail(404, "not_found");
  };

  /** Earliest and latest a wire span can touch (ms), for the window filter. */
  const wireMs = (v) => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : null);
  const wireExtent = (sp) => {
    const s = sp.start;
    const e = sp.end;
    const from = s ? (wireMs(s.not_before) ?? wireMs(s.at)) : e ? (wireMs(e.not_before) ?? wireMs(e.at)) : null;
    const to = e ? (wireMs(e.not_after) ?? wireMs(e.at) ?? from) : Infinity;
    return from === null ? null : { from, to };
  };
  const spansReply = (u) => {
    if (!server.spansRoute) return fail(404, "not_found");
    const q = (k) => u.searchParams.get(k);
    const limit = Math.min(1000, Number(q("limit") ?? 200));
    const offset = Number(q("offset") ?? 0);
    const kinds = q("kinds") ? new Set(q("kinds").split(",")) : null;
    let all = server.spans.filter((sp) => (!kinds || kinds.has(sp.kind)) && (!q("ticket") || sp.ids?.ticket_id === q("ticket")) && (!q("execution") || sp.ids?.execution_id === q("execution")) && (!q("wave") || sp.ids?.wave_id === q("wave")));
    if (server.spansRoute === "m61") {
      all = all.slice(0, server.spanCap);
      return ok({ items: all.slice(offset, offset + limit), total: all.length, offset, more: offset + limit < all.length, cursor: cur(head()), basis_vocabulary: [] });
    }
    if (q("span")) {
      const one = server.spans.filter((sp) => sp.span_id === q("span"));
      return one.length ? ok({ items: one, total: 1, offset: 0, more: false, cursor: cur(head()), truncated: false, total_uncapped: 1 }) : fail(404, "not_found");
    }
    const from = q("from_ms") === null ? -Infinity : Number(q("from_ms"));
    const to = q("to_ms") === null ? Infinity : Number(q("to_ms"));
    all = all.filter((sp) => {
      const x = wireExtent(sp);
      return x !== null && x.from <= to && x.to >= from;
    });
    all.sort((a, b) => wireExtent(a).from - wireExtent(b).from);
    const uncapped = all.length;
    all = all.slice(0, server.spanCap);
    return ok({ items: all.slice(offset, offset + limit), total: all.length, offset, more: offset + limit < all.length, cursor: cur(head()), truncated: uncapped > all.length, total_uncapped: uncapped, basis_vocabulary: [] });
  };
  const marksReply = (u) => {
    if (!server.marks) return fail(404, "not_found");
    const q = (k) => u.searchParams.get(k);
    const kinds = q("kinds") ? new Set(q("kinds").split(",")) : null;
    let list = server.marks.filter((m) => !kinds || kinds.has(m.kind)).map((m) => ({ m, at: wireMs(m.at), until: wireMs(m.until) }));
    list.sort((a, b) => a.at - b.at);
    if (q("after_ms") !== null) list = list.filter((x) => x.at > Number(q("after_ms")));
    else if (q("before_ms") !== null) list = list.filter((x) => x.at < Number(q("before_ms"))).reverse();
    else {
      const from = q("from_ms") === null ? -Infinity : Number(q("from_ms"));
      const to = q("to_ms") === null ? Infinity : Number(q("to_ms"));
      list = list.filter((x) => x.at <= to && (x.until ?? x.at) >= from);
    }
    const limit = Number(q("limit") ?? 1000);
    return ok({ items: list.slice(0, limit).map((x) => x.m), truncated: list.length > limit, cursor: cur(head()) });
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
    for (const e of committed) server.events.push(e);
    server.inOrder = null;
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
    server.inOrder = null;
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

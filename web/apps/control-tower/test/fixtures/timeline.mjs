// Seeded, contract-shaped Timeline data at scale (src/timeline/contract.ts), for node tests, the
// fake observer and the performance harness. No disk, no clock: every value is a function of the
// options. Ids are invented (SYN-*, SLICE-*, WAVE-*), people appear only as roles.
//
//   spansFixture({ cells, agentsPerExecution, executionsPerCell, seed, hours, toolsPerAgent, start })
//     -> { spans: TimelineSpan[], liveAt, extent: { from, to }, tickets, executions }
//   marksFixture(spansOrFixture, { count, seed })          -> TimelineMark[] (sorted by `at`)
//   concurrencyFixture(spans, window, buckets, limits?)    -> ConcurrencySeries
//   densityFixture(spans, window, buckets, filter?)        -> DensitySeries
//   fakeTimelineData(opts)                                 -> TimelineData (+ test controls)
//
// The defaults give about 60,000 spans (every kind, every duration basis, interrupted and resumed
// visits) and 20,000 marks; generating both takes well under half a second.

const MIN = 60_000;
const HOUR = 3_600_000;
export const DEFAULT_START = Date.UTC(2026, 10, 11, 0, 0, 0);

/** mulberry32: a small, fast, seeded generator. */
export function rng(seed) {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo, hi) => lo + next() * (hi - lo),
    int: (n) => Math.floor(next() * n),
    hex: (n) => {
      let s = "";
      for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(next() * 16)];
      return s;
    },
  };
}

const pad = (n, w = 3) => String(n).padStart(w, "0");

function end(at, { eventId = null, precision = "ms", basis = "recorded", rule = null, reason = null, notBefore = null, notAfter = null } = {}) {
  return { eventId, at, precision, notBefore, notAfter, basis, rule, reason };
}

function duration(start, finish, basis) {
  if (basis === "open" || basis === "unknown") return { ms: null, minMs: null, maxMs: null, basis };
  const s = start ? start.at ?? start.notBefore : null;
  const lo = finish?.notBefore ?? finish?.at;
  const hi = finish?.notAfter ?? finish?.at;
  if (s === null || lo === null) return { ms: null, minMs: null, maxMs: null, basis };
  if (basis === "bounded") return { ms: null, minMs: Math.max(0, lo - s), maxMs: Math.max(0, hi - s), basis };
  return { ms: Math.max(0, (finish.at ?? hi) - s), minMs: null, maxMs: null, basis };
}

/** The earliest and latest a span can touch (contract.ts extentOf, repeated so this file needs no TypeScript). */
export function extentOf(span) {
  const s = span.start;
  const e = span.end;
  const from = s ? (s.notBefore ?? s.at) : e ? (e.notBefore ?? e.at) : null;
  if (from === null) return null;
  const to = e ? (e.notAfter ?? e.at ?? from) : Number.POSITIVE_INFINITY;
  return { from, to: Math.max(from, to) };
}

/**
 * The span set. Per cell: its waits (dependency, eligible, capacity, person), the cell, rounds,
 * station visits (an interrupted visit and its resumption in some cells), tasks (starts inferred or
 * unknown), review seats and gate waits; per execution (cut across visits, never aligned with
 * rounds): claim, execution, workflow (end bounded), agents with queue waits, half of them
 * count-only and half with individually observable tool calls, and main-loop tools.
 */
export function spansFixture({ cells = 12, agentsPerExecution = 48, executionsPerCell = 4, seed = 1, hours = 30, toolsPerAgent = 48, start = DEFAULT_START } = {}) {
  const r = rng(seed);
  const spans = [];
  let ev = 0;
  const eid = () => `e:${(++ev).toString(36)}`;
  const liveAt = start + hours * HOUR;
  const span = (kind, entity, parent, ids, s, e, basis, outcome, attrs = {}, authority = "authoritative") => {
    const sp = { id: `${kind}:${entity}`, kind, entity, parent, ids, start: s, end: e, duration: duration(s, e, basis), outcome, authority, attrs };
    spans.push(sp);
    return sp;
  };
  const rec = (at, more) => end(Math.round(at), { eventId: eid(), ...more });
  const waves = [0, 1, 2].map((i) => ({ id: `WAVE-${pad(i + 1)}`, at: start + i * hours * 0.22 * HOUR }));
  const tickets = [];
  const executions = [];
  const waveOf = (c) => waves[Math.min(2, Math.floor((c * 3) / cells))];
  const lastCellOpen = cells - 1;
  for (let c = 0; c < cells; c++) {
    const ticket = `SYN-${pad(c + 1)}`;
    const slice = `SLICE-${pad(c + 1)}`;
    const wave = waveOf(c);
    tickets.push(ticket);
    const ids = { ticket_id: ticket, slice_id: slice, wave_id: wave.id };
    const cellRef = `cell:${ticket}`;
    // Waits before the cell: a dependency wait for some, eligibility, a capacity wait for some.
    let t = wave.at + r.between(1, 30) * MIN;
    if (c % 3 === 1) {
      const until = t + r.between(20, 120) * MIN;
      span("slice-wait", `slice:${slice}/wait#1`, `slice:${slice}`, ids, rec(t, { precision: "s" }), rec(until, { precision: "s", reason: "completed" }), "measured", "resolved", { reasons: [`SLICE-${pad(c)} is not integrated yet`], dependsOn: [`SLICE-${pad(c)}`] });
      t = until;
    }
    const eligible = t + r.between(1, 5) * MIN;
    span("slice-eligible", `slice:${slice}/eligible`, `slice:${slice}`, ids, rec(t, { precision: "s" }), rec(eligible, { precision: "s", reason: "completed" }), "measured", "scheduled");
    t = eligible;
    if (c % 2 === 0) {
      const until = t + r.between(5, 60) * MIN;
      span("capacity-wait", `capacity:${ticket}#1`, cellRef, ids, rec(t, { precision: "s", basis: "inferred", rule: "held-sentence" }), rec(until, { precision: "s", basis: "inferred", rule: "held-sentence", reason: "completed" }), "inferred", "released", { reasons: ["all 3 place(s) are in use"] });
      t = until;
    }
    const cellStart = t;
    // Visits in sequence; rounds advance on revise.
    const plan = ["plan", "build", "verify", "review", "build", "verify", "review", "merge"];
    const visits = [];
    let round = 1;
    const counters = {};
    let vt = cellStart + r.between(0.5, 3) * MIN;
    const budget = (hours * HOUR * 0.55) / plan.length;
    for (let i = 0; i < plan.length; i++) {
      const station = plan[i];
      if (i === 4) round++;
      counters[station] = (counters[station] ?? 0) + 1;
      const d = r.between(0.4, 1) * budget;
      visits.push({ station, n: counters[station], round, from: vt, to: vt + d });
      vt += d + r.between(0.2, 4) * MIN;
    }
    const cellEnd = visits.at(-1).to;
    const open = c === lastCellOpen || cellEnd > liveAt;
    // Rounds.
    for (const rn of [1, 2]) {
      const vs = visits.filter((v) => v.round === rn && v.station !== "plan" && v.station !== "merge");
      const re = vs.at(-1).to;
      const isOpen = re > liveAt;
      span("round", `gate:${ticket}/round#${rn}`, cellRef, { ...ids, round: String(rn) }, rec(vs[0].from), isOpen ? null : rec(re, { reason: rn === 1 ? "failed" : "completed" }), isOpen ? "open" : "measured", isOpen ? null : rn === 1 ? "rejected" : "approved", { round: rn });
    }
    span("cell", cellRef, null, ids, rec(cellStart, { precision: "s" }), open ? null : rec(cellEnd, { reason: "completed" }), open ? "open" : "measured", open ? null : "merged", { state: open ? "building" : "merged" });
    // Station visits, with an interrupted visit and its resumption in every fourth cell.
    for (const v of visits) {
      if (v.from > liveAt) continue;
      const entity = `visit:${ticket}/${v.station}#${v.n}`;
      const vids = { ...ids, station: v.station, visit_id: `${ticket}/${v.station}#${v.n}`, round: String(v.round) };
      if (c % 4 === 2 && v.station === "build" && v.n === 1) {
        const cut = v.from + (v.to - v.from) * 0.4;
        span("visit", entity, cellRef, vids, rec(v.from), rec(cut, { reason: "interrupted", precision: "s" }), "measured", null, { action: "build", round: v.round, interruptedAt: Math.round(cut) });
        const resumed = cut + r.between(5, 20) * MIN;
        counters.build++;
        span("visit", `visit:${ticket}/build#${counters.build}`, cellRef, { ...vids, visit_id: `${ticket}/build#${counters.build}` }, rec(resumed), rec(v.to, { reason: "completed" }), "measured", "built", { action: "build", round: v.round });
        continue;
      }
      const isOpen = v.to > liveAt;
      const verdict = v.station === "verify" ? (v.round === 1 ? "FAIL_WITH_EVIDENCE" : "PASS") : v.station === "review" ? (v.round === 1 ? "REJECTED" : "APPROVED") : v.station === "build" ? "built" : v.station === "merge" ? "merged" : "planned";
      const reason = verdict === "FAIL_WITH_EVIDENCE" || verdict === "REJECTED" ? "failed" : "completed";
      span("visit", entity, cellRef, vids, rec(v.from), isOpen ? null : rec(v.to, { reason }), isOpen ? "open" : "measured", isOpen ? null : verdict, { action: v.n > 1 && v.station === "build" ? "revise" : v.station, round: v.round });
      // Tasks of a build: start inferred from the previous task's end; the first one's start unknown.
      if (v.station === "build") {
        const n = 6;
        let prev = null;
        for (let k = 0; k < n; k++) {
          const te = v.from + ((k + 1) / (n + 1)) * (v.to - v.from);
          if (te > liveAt) break;
          const taskEnt = `${entity}/task:T${k + 1}#${k % 2 ? "green" : "red"}`;
          if (prev === null) span("task", taskEnt, entity, vids, null, rec(te, { reason: "completed" }), "unknown", k % 2 ? "green" : "red");
          else span("task", taskEnt, entity, vids, end(Math.round(prev), { basis: "inferred", rule: "previous-task-end" }), rec(te, { reason: "completed" }), "inferred", k % 2 ? "green" : "red");
          prev = te;
        }
      }
      // Review seats, the human gate on high-risk cells.
      if (v.station === "review" && !isOpen) {
        for (const seat of ["architecture", "security", "product"]) {
          const se = v.from + r.between(0.4, 0.95) * (v.to - v.from);
          const vote = v.round === 1 && seat !== "product" ? "REJECT" : "APPROVE";
          span("seat", `seat:${ticket}/review#${v.n}/${seat}`, `gate:${ticket}/review#${v.n}`, { ...vids, seat }, rec(v.from), rec(se, { reason: vote === "REJECT" ? "failed" : "completed" }), "measured", vote, { vote, model: "claude-sonnet-5-5" });
        }
        if (c % 5 === 3 && v.round === 2) {
          const waitEnd = v.to + r.between(30, 120) * MIN;
          const pOpen = waitEnd > liveAt || c === cells - 2;
          span("person-wait", `gate:${ticket}/human-approval`, cellRef, ids, rec(v.to), pOpen ? null : rec(waitEnd, { precision: "s", reason: "completed" }), pOpen ? "open" : "measured", pOpen ? null : "approved");
          span("gate-wait", `gate:${ticket}/review#${v.n}`, cellRef, ids, rec(v.from), rec(v.to, { reason: "completed" }), "measured", "AWAITING_HUMAN");
        }
      }
    }
    // Executions: cut across the visits at points that ignore rounds.
    const first = visits[0].from;
    const last = Math.min(cellEnd, liveAt);
    const cuts = [first];
    for (let k = 1; k < executionsPerCell; k++) cuts.push(first + ((last - first) * k) / executionsPerCell + r.between(-0.05, 0.05) * (last - first) / executionsPerCell);
    cuts.push(open ? null : cellEnd);
    for (let k = 0; k < executionsPerCell; k++) {
      const x = `x${r.hex(12)}`;
      executions.push(x);
      const xs = cuts[k] + (k ? r.between(0.5, 4) * MIN : 0);
      if (xs > liveAt) continue;
      const lastX = k === executionsPerCell - 1;
      const xe = lastX ? cuts[k + 1] : cuts[k + 1] - r.between(0.2, 2) * MIN;
      const xOpen = xe === null || xe > liveAt;
      const interrupted = !xOpen && c % 4 === 2 && k === 0;
      const unknown = !xOpen && c % 6 === 5 && k === executionsPerCell - 2;
      const xids = { ...ids, execution_id: x, attempt: String(k + 1) };
      span("claim", `claim:${x}`, cellRef, xids, rec(xs - 3000, { precision: "s" }), rec(xs, { precision: "s", reason: "completed" }), "measured", "claimed", { attempt: k + 1 });
      const xEnd = xOpen ? null : unknown ? end(null, { precision: "unknown", reason: "unknown", notBefore: Math.round(xe), notAfter: Math.round(xe + 20 * MIN), eventId: eid() }) : rec(xe, { precision: "s", reason: interrupted ? "interrupted" : "completed" });
      span("execution", `execution:${x}`, cellRef, xids, rec(xs, { precision: "s" }), xEnd, xOpen ? "open" : unknown ? "bounded" : "measured", xOpen || unknown ? null : interrupted ? "interrupted" : "completed", { attempt: k + 1, state: xOpen ? "running" : unknown ? "outcome-unknown" : interrupted ? "failed" : "completed", costUsd: Math.round(r.between(1, 9) * 100) / 100 });
      const ws = xs + 8000;
      const wEnd = xOpen || interrupted || unknown ? null : end(null, { eventId: eid(), precision: "bounded", notBefore: Math.round(xe - 20000), notAfter: Math.round(xe - 2000), reason: "completed" });
      const wf = `workflow:${x}/task${pad(k + 1, 4)}`;
      span("workflow", wf, `execution:${x}`, xids, rec(ws, { precision: "arrival" }, "observed"), wEnd, wEnd ? "bounded" : xOpen ? "open" : "unknown", wEnd ? "completed" : null, {}, "observed");
      // Main-loop tools, one by one.
      for (let m = 0; m < 3; m++) {
        const ts = xs + 1000 + m * 2500;
        span("tool", `tool:${x}/toolu_SYN${pad(m, 6)}`, `agent:${x}/main`, xids, rec(ts), rec(ts + r.between(300, 2200), { reason: "completed" }), "measured", "ok", { label: m === 2 ? "Workflow" : "Bash" }, "observed");
      }
      // Agents.
      const xEndT = xOpen ? liveAt : xe;
      for (let a = 0; a < agentsPerExecution; a++) {
        const aid = `${x}/a${r.hex(16)}`;
        const as = ws + r.between(0, 0.95) * (xEndT - ws);
        const queued = as - (a % 4 === 0 ? r.between(2000, 90000) : 15);
        const ae = Math.min(as + r.between(0.5, 25) * MIN, xEndT - 500);
        const aOpen = xOpen && as + 25 * MIN > liveAt && a % 7 === 0;
        const aUnknown = (interrupted || unknown) && ae > xEndT - 30 * MIN;
        const countOnly = a % 2 === 0;
        const label = a % 5 === 0 ? `${ticket}: build` : a % 5 === 1 ? `${ticket}: verify` : a % 5 === 2 ? `${ticket}: security reviewer` : a % 5 === 3 ? `${ticket}: what next?` : "collect the evidence";
        const aids = { ...xids, agent_id: aid };
        span("agent-queue", `agent:${aid}/queue`, `agent:${aid}`, aids, rec(queued, {}), rec(as, { reason: "completed" }), "measured", null, { label }, "observed");
        const aEnd = aOpen ? null : aUnknown ? end(null, { eventId: eid(), precision: "bounded", notBefore: Math.round(Math.min(ae, xEndT)), notAfter: Math.round(xEndT), basis: "inferred", rule: "open-at-process-end", reason: "unknown" }) : rec(ae, { reason: a % 23 === 0 ? "failed" : "completed" });
        const basis = aOpen ? "open" : aUnknown ? "bounded" : "measured";
        const calls = Math.round(r.between(2, 120));
        span("agent", `agent:${aid}`, wf, aids, rec(as), aEnd, basis, aOpen || aUnknown ? null : a % 23 === 0 ? "error" : "done", {
          label, model: a % 3 ? "claude-sonnet-5-5" : "claude-haiku-5-5", agentType: a % 5 < 2 ? "mach-builder" : undefined, toolCalls: calls,
          toolsCountOnly: countOnly, lastTool: "Bash", tokens: Math.round(r.between(8000, 400000)),
        }, "observed");
        if (!countOnly && !aOpen) {
          const stop = aUnknown ? xEndT : ae;
          for (let k = 0; k < toolsPerAgent; k++) {
            const ts = as + ((k + 0.5) / toolsPerAgent) * (stop - as);
            const tOpen = aUnknown && k === toolsPerAgent - 1;
            span("tool", `tool:${aid}/t${k}`, `agent:${aid}`, aids, rec(ts), tOpen ? end(null, { eventId: eid(), precision: "bounded", notBefore: Math.round(ts), notAfter: Math.round(stop), basis: "inferred", rule: "open-at-process-end", reason: "unknown" }) : rec(ts + r.between(50, ((stop - as) / toolsPerAgent) * 0.9), { reason: "completed" }), tOpen ? "bounded" : "measured", tOpen ? null : "ok", { label: ["Bash", "Read", "Edit", "Grep"][k % 4] }, "observed");
          }
        }
      }
    }
  }
  for (const w of waves) {
    const inWave = spans.filter((s) => s.kind === "cell" && s.ids.wave_id === w.id);
    const wEnd = inWave.some((s) => s.end === null) ? null : Math.max(...inWave.map((s) => s.end.at));
    span("wave", `wave:${w.id}`, null, { wave_id: w.id }, end(w.at, { eventId: eid(), precision: "s" }), wEnd === null ? null : end(wEnd, { eventId: eid(), precision: "s", reason: "completed" }), wEnd === null ? "open" : "measured", null);
  }
  // A slice still waiting at the live edge.
  span("slice-wait", `slice:SLICE-${pad(cells + 1)}/wait#1`, `slice:SLICE-${pad(cells + 1)}`, { slice_id: `SLICE-${pad(cells + 1)}`, wave_id: waves[2].id }, end(waves[2].at + 60000, { eventId: eid(), precision: "s" }), null, "open", null, { reasons: ["SLICE-006 is not integrated yet"], dependsOn: ["SLICE-006"] });
  let from = Infinity;
  for (const s of spans) {
    const x = extentOf(s);
    if (x && x.from < from) from = x.from;
  }
  return { spans, liveAt, extent: { from, to: liveAt }, tickets, executions, waves: waves.map((w) => w.id) };
}

const MARK_KINDS = ["failure", "retry", "gate", "review", "human", "recovery", "interruption", "gap", "wave", "merge"];

/** Marks: the moments the spans imply (failures, reviews, people, recoveries, interruptions, merges, waves, a gap) plus gate evaluations up to `count`. */
export function marksFixture(input, { count = 20000, seed = 2 } = {}) {
  const fx = Array.isArray(input) ? { spans: input, liveAt: Math.max(...input.map((s) => s.end?.at ?? 0)) } : input;
  const r = rng(seed);
  const marks = [];
  let n = 0;
  const mark = (kind, at, entity, label, verdict = null, until = null, authority = "authoritative") => {
    marks.push({ id: `mark:${kind}:${(++n).toString(36)}`, kind, at: Math.round(at), until: until === null ? null : Math.round(until), eventId: `e:m${n.toString(36)}`, entity, label, verdict, authority });
  };
  const visits = [];
  for (const s of fx.spans) {
    const at = s.end?.at;
    switch (s.kind) {
      case "visit":
        visits.push(s);
        if (s.end?.reason === "failed") mark("failure", at, s.entity, `Verification failed on ${s.ids.ticket_id}.`);
        if (s.end?.reason === "interrupted") mark("interruption", at, s.entity, `A visit of ${s.ids.ticket_id} was stopped and taken up again later.`);
        if (s.attrs.action === "revise") mark("retry", s.start.at, s.entity, `${s.ids.ticket_id} is revised in round ${s.attrs.round}.`);
        if (s.ids.station === "merge" && at) mark("merge", at, s.entity, `${s.ids.ticket_id} was merged.`);
        break;
      case "seat":
        mark("review", at, s.entity, `The ${s.ids.seat} seat voted ${s.attrs.vote === "REJECT" ? "to reject" : "to approve"}.`, s.attrs.vote === "REJECT" ? "rejected" : "approved");
        break;
      case "person-wait":
        mark("human", s.start.at, s.entity, "A person's approval is required.", "required", s.end?.at ?? null);
        if (s.end) mark("human", s.end.at, s.entity, "A person approved.", "approved");
        break;
      case "execution":
        if (s.end?.reason === "interrupted" || s.end?.reason === "unknown") mark("recovery", (s.end.at ?? s.end.notBefore) + 40000, s.entity, "The supervisor started a recovery.");
        break;
      case "wave":
        mark("wave", s.start.at, s.entity, `${s.ids.wave_id} was approved and taken in.`);
        break;
    }
  }
  const lo = Math.min(...fx.spans.map((s) => s.start?.at ?? Infinity));
  mark("gap", lo + (fx.liveAt - lo) * 0.45, null, "Two intake records are missing from the history.", null, lo + (fx.liveAt - lo) * 0.45 + 1000, "reconstructed");
  const builds = visits.filter((v) => v.ids.station === "build" && v.start);
  while (marks.length < count && builds.length) {
    const v = builds[r.int(builds.length)];
    const to = v.end?.at ?? fx.liveAt;
    const verdict = r.next() < 0.7 ? "passed" : r.next() < 0.9 ? "refused" : "overridden";
    mark("gate", v.start.at + r.next() * (to - v.start.at), v.entity, `A build gate was ${verdict} for ${v.ids.ticket_id}.`, verdict);
  }
  marks.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  return marks;
}

/** Spans of each kind active per bucket (max and mean), with the recorded limit. */
export function concurrencyFixture(spans, window, buckets, limits = [{ name: "max_parallel", value: 3, from: window.from, to: null }]) {
  const bucketMs = Math.max(1, Math.ceil((window.to - window.from) / buckets));
  const kinds = new Map();
  for (const s of spans) {
    const x = extentOf(s);
    if (!x || x.to < window.from || x.from > window.to) continue;
    let arr = kinds.get(s.kind);
    if (!arr) kinds.set(s.kind, (arr = { max: new Float64Array(buckets), sum: new Float64Array(buckets) }));
    const a = Math.max(0, Math.floor((x.from - window.from) / bucketMs));
    const b = Math.min(buckets - 1, Math.floor((Math.min(x.to, window.to) - window.from) / bucketMs));
    for (let i = a; i <= b; i++) {
      const bf = window.from + i * bucketMs;
      const cover = (Math.min(x.to, bf + bucketMs) - Math.max(x.from, bf)) / bucketMs;
      arr.sum[i] += Math.max(0, cover);
      arr.max[i] += 1; // the most at once is bounded by those touching the bucket
    }
  }
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const active = {};
    for (const [kind, arr] of kinds) if (arr.max[i] > 0) active[kind] = { max: arr.max[i], mean: Math.round(arr.sum[i] * 100) / 100 };
    out.push({ from: window.from + i * bucketMs, active });
  }
  return { from: window.from, to: window.to, bucketMs, buckets: out, limits, complete: true };
}

/** Events recorded per bucket, derived from the spans (each end is an event; agents report progress). Sparse. */
export function densityFixture(spans, window, buckets, filter = {}) {
  const bucketMs = Math.max(1, Math.ceil((window.to - window.from) / buckets));
  const counts = new Map();
  const bump = (t, n = 1) => {
    if (t === null || t < window.from || t > window.to) return;
    const i = Math.floor((t - window.from) / bucketMs);
    counts.set(i, (counts.get(i) ?? 0) + n);
  };
  for (const s of spans) {
    if (filter.ticket && s.ids.ticket_id !== filter.ticket) continue;
    if (filter.execution && s.ids.execution_id !== filter.execution) continue;
    bump(s.start?.at ?? null);
    bump(s.end?.at ?? null);
    if (s.kind === "agent" && s.start && s.end?.at) {
      const n = Math.min(40, Math.round((s.end.at - s.start.at) / 20000));
      for (let k = 1; k <= n; k++) bump(s.start.at + (k / (n + 1)) * (s.end.at - s.start.at));
    }
  }
  const list = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([i, count]) => ({ from: window.from + i * bucketMs, count }));
  return { from: window.from, to: window.to, bucketMs, buckets: list, complete: true };
}

const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

/**
 * A TimelineData over the fixtures: window overlap queries by binary search (spans sorted by start,
 * with a running maximum of ends so long spans are found), a cap that sets `truncated`, nextMark by
 * binary search. Extra test controls: `advance(ms)` moves the live edge and notifies subscribers;
 * `calls` counts queries; `fixture` is the generated data.
 */
export function fakeTimelineData({ source = "replay", cap = 5000, delayMs = 0, marks: markCount = 20000, ...opts } = {}) {
  const fixture = spansFixture(opts);
  const marks = marksFixture(fixture, { count: markCount, seed: (opts.seed ?? 1) + 1 });
  const all = fixture.spans;
  const ext = all.map(extentOf);
  const order = all.map((_, i) => i).filter((i) => ext[i] !== null).sort((a, b) => ext[a].from - ext[b].from);
  const froms = Float64Array.from(order, (i) => ext[i].from);
  const maxTo = new Float64Array(order.length);
  let m = -Infinity;
  order.forEach((i, k) => {
    m = Math.max(m, ext[i].to);
    maxTo[k] = m;
  });
  const byId = new Map(all.map((s) => [s.id, s]));
  const markAt = Float64Array.from(marks, (x) => x.at);
  const listeners = new Set();
  let liveAt = fixture.liveAt;
  let version = 1;
  const calls = { spans: 0, span: 0, marks: 0, nextMark: 0, density: 0, concurrency: 0 };
  const lower = (arr, v) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upper = (arr, v) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const settle = async (signal, value) => {
    if (signal?.aborted) throw abortError();
    if (delayMs) await new Promise((ok) => setTimeout(ok, delayMs));
    if (signal?.aborted) throw abortError();
    return value;
  };
  const overlapping = (window) => {
    const first = lower(maxTo, window.from);
    const last = upper(froms, window.to);
    const out = [];
    for (let k = first; k < last; k++) {
      const i = order[k];
      if (ext[i].to >= window.from) out.push(all[i]);
    }
    return out;
  };
  const data = {
    source,
    fixture,
    marksList: marks,
    calls,
    extent: () => ({ from: fixture.extent.from, to: liveAt }),
    async spans(query, signal) {
      calls.spans++;
      const kinds = query.kinds?.length ? new Set(query.kinds) : null;
      const hits = overlapping(query.window).filter(
        (s) => (!kinds || kinds.has(s.kind)) && (!query.ticket || s.ids.ticket_id === query.ticket) && (!query.execution || s.ids.execution_id === query.execution) && (!query.wave || s.ids.wave_id === query.wave),
      );
      return settle(signal, { spans: hits.length > cap ? hits.slice(0, cap) : hits, truncated: hits.length > cap, total: hits.length, version: `fixture.${version}` });
    },
    async span(id, signal) {
      calls.span++;
      return settle(signal, byId.get(id) ?? null);
    },
    async marks(window, kinds, signal) {
      calls.marks++;
      const set = kinds?.length ? new Set(kinds) : null;
      const out = [];
      for (let k = lower(markAt, window.from); k < marks.length && marks[k].at <= window.to; k++) if (!set || set.has(marks[k].kind)) out.push(marks[k]);
      return settle(signal, out);
    },
    async nextMark(t, direction, kinds, signal) {
      calls.nextMark++;
      const set = new Set(kinds?.length ? kinds : MARK_KINDS);
      let found = null;
      if (direction === 1) {
        for (let k = upper(markAt, t); k < marks.length; k++) if (set.has(marks[k].kind)) {
          found = marks[k];
          break;
        }
      } else {
        for (let k = lower(markAt, t) - 1; k >= 0; k--) if (set.has(marks[k].kind)) {
          found = marks[k];
          break;
        }
      }
      return settle(signal, found);
    },
    async density(window, buckets, filter, signal) {
      calls.density++;
      return settle(signal, densityFixture(overlapping(window), window, buckets, filter ?? {}));
    },
    async concurrency(window, buckets, signal) {
      calls.concurrency++;
      return settle(signal, concurrencyFixture(overlapping(window), window, buckets));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Test control: move the live edge and tell subscribers to re-query. */
    advance(ms) {
      liveAt += ms;
      version++;
      for (const l of [...listeners]) l();
    },
    liveAt: () => liveAt,
  };
  return data;
}

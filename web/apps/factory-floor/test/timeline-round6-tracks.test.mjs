// Round 6 (the `tracks` agent): the lesser visual defects of docs/mach-next/M6_3_COMPLETION.md section 5
// that live in src/timeline/{tracks,render,overview,controls,data}: lanes (5), a deep link's rows (7),
// zoom while following (8), labels over data (13), the default window on long-open work (17), cut
// execution and note words (19), "between 0 ms and" and "Live edge later" in a replay (15), and the
// first review seat's dropped label (18).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";
import { span, at } from "./fixtures/spans.mjs";

const lanes = await import("../src/timeline/tracks/lanes.ts");
const { buildTrackTree, layoutRows } = await import("../src/timeline/tracks/index.ts");
const contract = await import("../src/timeline/contract.ts");
const words = await import("../src/timeline/render/words.ts");
const draw = await import("../src/timeline/render/draw.ts");
const scale = await import("../src/timeline/render/scale.ts");
const overviewModel = await import("../src/timeline/overview/model.ts");
const overviewDraw = await import("../src/timeline/overview/draw.ts");
const frame = await import("../src/timeline/controls/frame.ts");
const fx = await import("../src/timeline/dev/fixture.ts");
const { NO_FILTERS, STRUCTURAL_KINDS, MIN_WINDOW_MS } = contract;

const M = 60_000;
const H = 60 * M;

// ---------------------------------------------------------------- 5. lanes: no empty bands, words on every lane

const agent = (x, n, from, to) =>
  span({ kind: "agent", entity: `agent:${x}/${n}`, parent: `workflow:${x}/belt`, ids: { execution_id: x, ticket_id: "T1", agent_id: `${x}/${n}`, workflow_id: `${x}/belt` }, start: from, end: to, attrs: { label: `job ${n}` } });

test("defect 5: a unit not started by liveAt opens no lane (it is not drawn yet); packing is prefix-stable", () => {
  // Three overlapping agents started, three more after the live edge (fetched ahead of the scene).
  const started = [agent("x", 1, at(0), at(10)), agent("x", 2, at(1), at(10)), agent("x", 3, at(2), at(10))];
  const later = [agent("x", 4, at(20), at(30)), agent("x", 5, at(21), at(30)), agent("x", 6, at(22), at(30))];
  const all = [...started, ...later];
  assert.equal(lanes.packLanes(all).length, 3, "without a live edge every unit is placed");
  const live = lanes.packLanes(all, at(15));
  assert.equal(live.length, 3, "units after the live edge open no lane of their own");
  assert.equal(live.reduce((n, l) => n + l.spans.length, 0), 6, "nothing is lost: they wait on lane 0");
  // Overlapping ones after the edge, more than the lanes: still no new lane (they would be empty bands).
  const burst = [...started, ...Array.from({ length: 9 }, (_, i) => agent("x", 10 + i, at(12), at(40)))];
  assert.equal(lanes.packLanes(burst, at(11)).length, 3);
  // Prefix-stable: the lanes of what started by an earlier edge are the same at a later one.
  const early = lanes.packLanes(burst, at(11)).map((l) => l.spans.filter((s) => s.start.at <= at(11)).map((s) => s.id));
  const late = lanes.packLanes(burst, at(50)).map((l) => l.spans.filter((s) => s.start.at <= at(11)).map((s) => s.id));
  assert.deepEqual(late.slice(0, early.length), early);
  assert.equal(lanes.startedBy(burst, at(11)), 3);
});

test("defect 5: a tree built at a live edge packs again when more has started, and not otherwise", () => {
  const exec = span({ kind: "execution", entity: "execution:x", ids: { execution_id: "x", ticket_id: "T1" }, start: at(0), end: null });
  const wf = span({ kind: "workflow", entity: "workflow:x/belt", parent: "execution:x", ids: { execution_id: "x", ticket_id: "T1", workflow_id: "x/belt" }, start: at(0), end: null });
  // 30 agents (more than are drawn one node each): 15 overlapping by minute 20, 15 starting at 30.
  const many = Array.from({ length: 30 }, (_, i) => agent("x", i, at(i < 15 ? 1 : 30), at(i < 15 ? 25 : 50)));
  const spans = [exec, wf, ...many];
  const t1 = buildTrackTree(spans, "execution", NO_FILTERS, at(20));
  const group = [...t1.byId.values()].find((n) => n.kind === "agents");
  assert.ok(group, "30 agents are drawn as lanes on one Agents row");
  assert.equal(group.lanes.length, 15, "fifteen agents overlap by the live edge: fifteen lanes, not thirty");
  const t2 = buildTrackTree(spans, "execution", NO_FILTERS, at(21), t1);
  assert.equal([...t2.byId.values()].find((n) => n.kind === "agents").lanes, group.lanes, "nothing more started: the same lanes");
  const t3 = buildTrackTree(spans, "execution", NO_FILTERS, at(40), t2);
  assert.equal([...t3.byId.values()].find((n) => n.kind === "agents").lanes.length, 15, "the later fifteen reuse the freed lanes");
});

test("defect 5: every lane after the first says what it holds", () => {
  const a = [agent("x", 1, at(0), at(10)), agent("x", 2, at(1), at(10)), span({ kind: "agent-queue", entity: "agent:x/2", ids: {}, start: at(0.5), end: at(1) })];
  const node = { kind: "agents", lanes: [{ spans: [a[0]] }, { spans: [a[2], a[1]] }] };
  assert.equal(lanes.laneWords(node, 1), "lane 2 · 1 agent", "an agent and its queue are one agent");
  const task = (n) => span({ kind: "task", entity: `task:T1/build#1/${n}`, ids: {}, start: at(n), end: at(n + 1) });
  assert.equal(lanes.laneWords({ kind: "station", lanes: [{ spans: [] }, { spans: [task(1), task(2)] }] }, 1), "lane 2 · 2 tasks");
  assert.equal(lanes.laneWords({ kind: "station", lanes: [{ spans: [] }, { spans: [task(1), a[0]] }] }, 1), "lane 2", "mixed kinds: only the lane");
  const wait = (kind, n) => span({ kind, entity: `${kind}:T1/${n}`, ids: {}, start: at(n), end: null });
  assert.equal(lanes.laneWords({ kind: "waits", lanes: [{ spans: [] }, { spans: [wait("gate-wait", 1), wait("person-wait", 2)] }] }, 1), "lane 2 · 2 waits", "every kind of wait is a wait");
});

// ---------------------------------------------------------------- 7. a deep link builds the same rows

test("defect 7: visits and seats are structural, so a window that misses Groom and Plan still has their rows", () => {
  assert.ok(STRUCTURAL_KINDS.includes("visit") && STRUCTURAL_KINDS.includes("seat"));
  for (const bulk of ["task", "agent", "agent-queue", "tool"]) assert.ok(!STRUCTURAL_KINDS.includes(bulk), `${bulk} stays windowed`);
  const ids = (station, n) => ({ ticket_id: "T1", slice_id: "S1", visit_id: `T1/${station}#${n}`, station });
  const v = (station, from, to) => span({ kind: "visit", entity: `visit:T1/${station}#1`, ids: ids(station, 1), start: at(from), end: at(to) });
  const cell = span({ kind: "cell", entity: "cell:T1", ids: { ticket_id: "T1", slice_id: "S1" }, start: at(0), end: null });
  const all = [cell, v("groom", 0, 2), v("plan", 2, 5), v("build", 60, 70)];
  const task = span({ kind: "task", entity: "task:T1/build#1/t1", parent: "visit:T1/build#1", ids: { ...ids("build", 1), task_id: "t1" }, start: at(61), end: at(62) });
  // Navigated (everything loaded) and deep-linked (structure + a window at 60–70 min) give the same rows.
  const structure = all.filter((s) => STRUCTURAL_KINDS.includes(s.kind));
  const window = [all[3], task];
  const rowsOf = (spans) => [...buildTrackTree(spans, "product", NO_FILTERS, at(100)).byId.keys()].sort();
  assert.deepEqual(rowsOf([...structure, ...window]), rowsOf([...all, task]));
  assert.ok(rowsOf([...structure, ...window]).includes("station:T1/groom"));
});

// ---------------------------------------------------------------- 8. zoom while following

test("defect 8: a zoom while following anchors on the live edge and keeps following; otherwise it is left alone", () => {
  const whole = { from: 0, to: 10 * H };
  const drawn = { from: 4 * H, to: 10 * H };
  const narrowed = frame.followingZoom(drawn, 3 * H, whole, true);
  assert.ok(frame.isFollow(narrowed), "still following");
  assert.equal(frame.followLength(narrowed), 3 * H);
  assert.deepEqual(frame.resolveWindow(narrowed, whole, drawn), { from: 7 * H, to: 10 * H }, "anchored on the live edge");
  assert.equal(frame.followingZoom(drawn, 3 * H, whole, false), null, "not following: the zoom stays where asked");
  assert.equal(frame.followingZoom({ from: 2 * H, to: 6 * H }, H, whole, true), null, "a window away from the edge is not anchored");
  assert.equal(frame.followingZoom(drawn, 6 * H, whole, true), null, "the same length is a pan, not a zoom");
  assert.equal(frame.followingZoom(drawn, 20 * H, whole, true), frame.ALL_WINDOW, "wider than the history: all of it");
  assert.equal(frame.followLength(frame.followingZoom(drawn, 1, whole, true)), MIN_WINDOW_MS);
});

// ---------------------------------------------------------------- 13. labels over data

/** A recording 2D context, as in timeline-render.test.mjs. */
function recorder() {
  const calls = [];
  const state = { font: "10px sans", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "alphabetic", lineCap: "butt", lineDashOffset: 0 };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return (text) => ({ width: text.length * (/mono/.test(t.font) ? 7 : 5) });
      return (...args) => calls.push({ op: k, args, fill: t.fillStyle });
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx, calls };
}
const PALETTE = new Proxy({ sans: "sans", mono: "mono" }, { get: (t, k) => (k in t ? t[k] : String(k)) });
const T0 = Date.UTC(2026, 10, 12, 23, 18, 0);
const trackNode = (o) => ({ id: "n", kind: "station", ref: null, label: "n", detail: null, depth: 1, parentId: null, children: [], lanes: [], ribbons: [], spanCount: 1, attention: "none", note: null, ...o });
const draws = (rows, extra = {}) => {
  const { ctx, calls } = recorder();
  draw.drawTracks({ ctx, width: 600, height: 200, scrollTop: 0, rows, window: { from: T0, to: T0 + 10 * M }, liveAt: T0 + 20 * M, palette: PALETTE, marks: new Map(), selection: null, highlighted: new Set(), grid: [], dateLines: [], ...extra });
  return calls;
};

test("defect 13: a bar's label and duration are painted after the row's marks, each on a knock-out of the ground", () => {
  const v = fx.span("v13", "visit", fx.at(T0 + M), fx.at(T0 + 7 * M), { attrs: { action: "verify" } });
  const n = trackNode({ lanes: [{ spans: [v] }] });
  const mark = { id: "m", kind: "failure", at: T0 + 4 * M, until: null, eventId: null, entity: null, label: "failed", verdict: null, authority: "observed" };
  const calls = draws([{ node: n, lane: 0, y: 0, height: 26, expanded: false, hasChildren: false }], { marks: new Map([["n", [mark]]]) });
  const texts = calls.map((c, i) => [c, i]).filter(([c]) => c.op === "fillText");
  const label = texts.find(([c]) => c.args[0] === "Verify");
  const dur = texts.find(([c]) => /min/.test(c.args[0]));
  assert.ok(label && dur);
  const lastNonText = Math.max(...calls.map((c, i) => [c, i]).filter(([c]) => c.op === "fill" || c.op === "stroke").map(([, i]) => i));
  assert.ok(label[1] > lastNonText && dur[1] > lastNonText, "no mark or cap is drawn over the words");
  for (const [, i] of [label, dur]) {
    const before = calls[i - 1];
    assert.ok(calls.slice(Math.max(0, i - 4), i).some((c) => c.op === "fillRect" && c.fill === "ground"), `a ground knock-out under ${calls[i].args[0]} (${before.op})`);
  }
});

test("defect 13: the edge-later words are on the ruler and true to the source", () => {
  assert.equal(scale.edgeLaterWords("live"), "live edge later →");
  assert.equal(scale.edgeLaterWords("replay"), "recording ends later →", "a replay has no live edge");
  assert.ok(!/live/i.test(scale.edgeLaterWords("simulation")));
});

test("defect 13: the overview's 'after the playhead' never covers a landmark glyph", () => {
  // Band from 100 to 400; glyphs at 110 and 150: the words go after 150.
  const left = overviewModel.afterLabelLeft(100, 400, [{ x: 110 }, { x: 150 }, { x: 390 }], 92);
  assert.equal(left, 150 + 6 - 100);
  assert.equal(overviewModel.afterLabelLeft(100, 400, [], 92), 6, "nothing in the way: just after the playhead");
  assert.equal(overviewModel.afterLabelLeft(100, 200, [{ x: 130 }, { x: 170 }], 92), null, "no free stretch: not drawn");
  assert.equal(overviewModel.afterLabelLeft(100, 400, [{ x: 20 }, { x: 450 }], 92), 6, "glyphs outside the band do not count");
});

test("defect 13: a break's length is never under the brush's edge handle", () => {
  const b = { x0: 1250, x1: 1420 };
  const tw = 60;
  const centred = overviewDraw.breakLabelX(b, tw, 1500, []);
  assert.equal(centred, (b.x0 + b.x1) / 2 - tw / 2);
  // The brush's right edge runs through the middle of the break, where the label sat ("12 h 3|5 min").
  const edge = 1335;
  const x = overviewDraw.breakLabelX(b, tw, 1500, [edge]);
  assert.ok(edge < x - 3 || edge > x + tw + 3, `label ${x}…${x + tw} clear of the edge at ${edge}`);
  // Still within or beside its break.
  assert.ok(x >= b.x0 - 6 - tw && x <= b.x1 + 6);
  // A narrow break whose "before" place is under the brush's edge (real-a: "14 h 41 mi|"): clear of it.
  const narrow = { x0: 1110, x1: 1130 };
  const nx = overviewDraw.breakLabelX(narrow, tw, 1260, [0, 1105]);
  assert.ok(nx > 1000, "near its break, not beside the brush's far edge");
  assert.ok(nx + tw <= 1260 - 30, "never under the live edge's now");
  // Real-a: the brush's edge just before a narrow break near the live edge: left of the edge, not under "now".
  const ra = overviewDraw.breakLabelX({ x0: 1100, x1: 1125 }, tw, 1160, [0, 1090]);
  assert.ok(ra + tw < 1090 - 3 && ra > 900, String(ra));
  assert.ok(1105 < nx - 3 || 1105 > nx + tw + 3, `label ${nx}…${nx + tw} clear of the edge at 1105`);
    // A narrow break at the live edge still ends before the break when nothing is in the way (X20).
  assert.equal(overviewDraw.breakLabelX({ x0: 1470, x1: 1490 }, tw, 1500, []), 1470 - 6 - tw);
});

test("defect 13: the idle tail's 'last recorded' words move clear of the brush's edge", () => {
  assert.equal(overviewDraw.clearOf(100, 80, [], 0, 400), 100, "nothing in the way: where it was");
  const x = overviewDraw.clearOf(100, 80, [130], 0, 400);
  assert.ok(130 < x - 6 || 130 > x + 80 + 6, String(x));
  assert.equal(overviewDraw.clearOf(100, 80, [130], 0, 150), 130 - 6 - 1 - 80, "no room after it: before it");
});

// ---------------------------------------------------------------- 15. words

test("defect 15: a bound of nothing is not information: 'up to', never 'between 0 ms and'", () => {
  const bounded = { ...fx.span("b", "workflow", fx.at(T0), fx.at(null, { notBefore: T0, notAfter: T0 + 4 * M + 7_000 })), duration: { ms: null, minMs: 0, maxMs: 4 * M + 7_000, basis: "bounded" } };
  assert.equal(words.durationWords(bounded, T0 + 10 * M), "up to 4 min 7 s");
  assert.equal(draw.shortDuration(bounded, T0, T0 + 4 * M + 7_000, false), "≤ 4 min 7 s");
  const real = { ...bounded, duration: { ms: null, minMs: 4 * M + 10_000, maxMs: 4 * M + 14_000, basis: "bounded" } };
  assert.equal(words.durationWords(real, T0 + 10 * M), "between 4 min 10 s and 4 min 14 s", "a real lower bound is kept");
  assert.equal(draw.shortDuration(real, T0, T0 + 4 * M + 14_000, false), "4 min 10 s – 4 min 14 s");
});

// ---------------------------------------------------------------- 17. the default window on long-open work

test("defect 17: open work silent for far longer than it was recorded is framed on what was recorded", () => {
  const T = Date.UTC(2026, 10, 12, 0, 0);
  const lastEvent = T + 6 * H;
  const whole = { from: T, to: lastEvent + 39 * H };
  const density = { from: whole.from, to: whole.to, bucketMs: M, buckets: [{ from: T, count: 3 }, { from: lastEvent - M, count: 2 }], complete: true };
  const open = [span({ kind: "execution", entity: "execution:x12", ids: { execution_id: "x12" }, start: lastEvent - 30 * M, end: null })];
  const w = frame.activityWindow({ whole, dataFrom: T, density, spans: open, lastMark: null, followingLive: true });
  assert.ok(w.to < lastEvent + H, `ends near the last record, not 39 h later (${(w.to - T) / H} h)`);
  assert.ok((lastEvent - T) / (w.to - w.from) > 0.9, "the recorded activity fills the stage");
  // A live run whose records are minutes old still follows the edge.
  const fresh = { from: T, to: lastEvent + 10 * M };
  assert.equal(frame.activityWindow({ whole: fresh, dataFrom: T, density, spans: open, lastMark: null, followingLive: true }).to, fresh.to);
  assert.equal(frame.silentTail(T, T + 5 * M, T + 25 * M), false, "a short run's half-hour pause is not silence");
  assert.equal(frame.silentTail(T, T + 5 * M, T + 60 * M), true);
});

// ---------------------------------------------------------------- 19. cut words

test("defect 19: execution details keep what tells them apart; the title says the attempt in full", () => {
  const exec = (x, attempt, from) => span({ kind: "execution", entity: `execution:${x}`, ids: { execution_id: x, ticket_id: "T1", attempt: String(attempt) }, start: from, end: from + 10 * M, attrs: { attempt } });
  const tree = buildTrackTree([exec("a", 1, at(0)), exec("b", 2, at(30))], "execution", NO_FILTERS, at(100));
  const a = tree.byId.get("execution:a");
  const b = tree.byId.get("execution:b");
  assert.match(a.detail, /^from \d\d:\d\d$/, "a first attempt is not repeated (it was cut to 's…')");
  assert.match(b.detail, /^from \d\d:\d\d · attempt 2$/);
  assert.match(words.executionTitle(a), /supervisor attempt 1$/);
  assert.match(words.executionTitle(b), /^T1 · run 2\/2 — from \d\d:\d\d · attempt 2; supervisor attempt 2$/);
  assert.equal(words.shortNote("Tool calls are counted, not observable one by one"), "calls counted");
  assert.equal(words.shortNote("2 tool calls, counted, not observable one by one"), "2 calls, counted");
  assert.equal(words.shortNote("1 tool call, counted, not observable one by one"), "1 call, counted");
  assert.equal(words.shortNote("anything else"), "anything else");
});

// ---------------------------------------------------------------- 18. the first review seat's label

test("defect 18: a thin row's label too long for its bar goes after the bar, not nowhere", () => {
  // A seat 40 px long (labelled, too short for "Architecture"), with the row free after it.
  const seat = fx.span("seat:T1/review#1/architecture", "seat", fx.at(T0 + M), fx.at(T0 + M + 40_000), { outcome: "approve", attrs: { label: "architecture" } });
  const n = trackNode({ kind: "seat", lanes: [{ spans: [seat] }] });
  const calls = draws([{ node: n, lane: 0, y: 0, height: 18, expanded: false, hasChildren: false }]);
  const texts = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  assert.ok(texts.some((t) => /^Arch/.test(t)), `the seat is named: ${JSON.stringify(texts)}`);
  const rows = layoutRows({ roots: [], byId: new Map() }, new Set());
  assert.equal(rows.rows.length, 0);
});

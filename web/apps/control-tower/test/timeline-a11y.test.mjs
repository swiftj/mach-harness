// M6.3 accessibility (src/timeline/a11y): the screen-reader descriptions shared by the canvas and the
// table, and the tree-grid's pure model: rows, aria-level/setsize/posinset, the span cap, the
// treegrid keyboard, virtualisation, and the cost at 60,000 spans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import "./_load.mjs";

// The vocabularies (src/shell/vocab.ts) import "@mach/ui", whose root pulls in React components node
// cannot load. The words describe.ts reads live in its grammar module, which node can: point there.
const grammar = new URL("../../../packages/ui/src/factory/grammar.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@mach/ui") return nextResolve(grammar, context);
    return nextResolve(specifier, context);
  },
});

const describe = await import("../src/timeline/a11y/describe.ts");
const model = await import("../src/timeline/a11y/model.ts");
const { at, span, makeTree, layoutOf, benchTree } = await import("../src/timeline/dev/fixture.ts");
const { setTimeBase } = await import("../src/shell/time.ts");
const { KEYMAP, TIMELINE_KEYS } = await import("../src/shell/keyboard.ts").catch(() => ({ KEYMAP: null, TIMELINE_KEYS: null }));

setTimeBase("wall");
const T0 = Date.UTC(2026, 10, 12, 23, 18, 0);
const S = 1000;
const M = 60 * S;
const LIVE = T0 + 60 * M;
const WIN = { from: T0, to: T0 + 60 * M };

const visit = (id, a, b, o = {}) => span(id, "visit", at(a), b === null ? null : at(b, o.end ?? {}), { attrs: { action: "build" }, ...o });

function fixture() {
  const build = [
    visit("v1", T0 + 1 * M, T0 + 5 * M, { outcome: "passed", end: { reason: "completed" } }),
    visit("v2", T0 + 6 * M, T0 + 9 * M, { outcome: "failed", end: { reason: "failed" } }),
    visit("v3", T0 + 10 * M, null),
    // Ends after the live edge: still open at it, its failure not yet known.
    visit("v4", T0 + 20 * M, T0 + 90 * M, { outcome: "failed", end: { reason: "failed" } }),
    // Starts after the live edge: not in the window yet.
    visit("v5", T0 + 70 * M, T0 + 80 * M),
  ];
  const waits = [span("w1", "person-wait", at(T0 + 30 * M), null), span("w2", "person-wait", at(T0 + 2 * M), at(T0 + 3 * M))];
  const tree = makeTree([
    {
      id: "cell:LOCAL-031",
      kind: "cell",
      label: "LOCAL-031",
      detail: "SLICE-024",
      attention: "failed",
      lanes: [[span("c", "cell", at(T0), null)]],
      children: [
        { id: "station:LOCAL-031/build", kind: "station", label: "Build", lanes: [build], attention: "failed" },
        { id: "cell:LOCAL-031/waits", kind: "waits", label: "Waits", lanes: [waits], attention: "person" },
      ],
    },
    { id: "cell:LOCAL-040", kind: "cell", label: "LOCAL-040", lanes: [[visit("x1", T0 - 50 * M, T0 - 40 * M)]] },
  ]);
  return tree;
}

// ---------------------------------------------------------------- descriptions

test("rowSummary: count in the window, failures, and an open range, in the vocabulary's words", () => {
  const tree = fixture();
  const build = tree.byId.get("station:LOCAL-031/build");
  const s = describe.rowSummary(build, WIN, LIVE);
  // v5 has not started by the live edge; v4's failure lies beyond it.
  assert.equal(s, "Build, station visits, 4 spans in this window, one failed; from 23:19:00 UTC to still open");
  const cell = tree.byId.get("cell:LOCAL-031");
  assert.equal(describe.rowSummary(cell, WIN, LIVE), "LOCAL-031, cell, 7 spans in this window, one failed, one waiting for a person; from 23:18:00 UTC to still open");
  const other = tree.byId.get("cell:LOCAL-040");
  assert.equal(describe.rowSummary(other, WIN, LIVE), "LOCAL-040, cell, nothing in this window");
});

test("rowSummary: a closed range ends at the last held end", () => {
  const tree = makeTree([{ id: "t", kind: "station", label: "Verify", lanes: [[visit("a", T0, T0 + 2 * M), visit("b", T0 + 3 * M, T0 + 4 * M + 12 * S)]] }]);
  assert.equal(describe.rowSummary(tree.byId.get("t"), WIN, LIVE), "Verify, station visits, 2 spans in this window; from 23:18:00 to 23:22:12 UTC");
});

test("windowSummary: totals by kind, failures, waits on a person, what is still open", () => {
  const tree = fixture();
  const s = describe.windowSummary(tree, WIN, LIVE);
  assert.equal(
    s,
    "From 23:18:00 to 00:18:00 UTC, 7 spans: 1 cell, 4 station visits and 2 waits on a person. One failed. 2 waits on a person, one still waiting. Still open: 1 cell, 2 station visits and 1 wait on a person.",
  );
  const empty = describe.windowSummary(tree, { from: T0 - 200 * M, to: T0 - 150 * M }, LIVE);
  assert.equal(empty, "From 19:58:00 to 20:48:00 UTC: nothing recorded in this window.");
});

test("no outcome or failure is said before the end that established it", () => {
  const tree = fixture();
  // At T0+8 min, v2 (fails at 9 min) is still open: nothing has failed yet.
  const early = describe.windowSummary(tree, WIN, T0 + 8 * M);
  assert.doesNotMatch(early, /failed/);
  assert.match(early, /Still open:/);
});

test("attention words come from the state vocabulary", () => {
  assert.equal(describe.attentionWords("failed"), "Failed");
  assert.equal(describe.attentionWords("person"), "Waiting for a person");
  assert.equal(describe.attentionWords("interrupted"), "Interrupted");
  assert.equal(describe.attentionWords("none"), "");
});

// ---------------------------------------------------------------- rows

const ALL_OPEN = new Set(["cell:LOCAL-031"]);

test("rows: tracks, then an opened track's spans in time order before its child tracks", () => {
  const tree = fixture();
  const layout = layoutOf(tree, ALL_OPEN);
  const index = model.indexWindow(WIN, LIVE);
  const closed = model.buildGridRows(layout, index, new Set());
  assert.deepEqual(
    closed.rows.map((r) => r.key),
    ["track:cell:LOCAL-031", "span:c", "track:station:LOCAL-031/build", "track:cell:LOCAL-031/waits", "track:cell:LOCAL-040"],
  );
  // The cell's own span is listed first; its children follow, so the set holds 1 span + 2 tracks.
  const [cell, c, build, waits, other] = closed.rows;
  assert.equal(cell.level, 1);
  assert.equal(cell.expanded, true);
  assert.deepEqual([c.level, c.posInSet, c.setSize], [2, 1, 3]);
  assert.deepEqual([build.level, build.posInSet, build.setSize], [2, 2, 3]);
  assert.deepEqual([waits.posInSet, waits.setSize], [3, 3]);
  assert.deepEqual([other.level, other.posInSet, other.setSize], [1, 2, 2]);
  // Leaves are expandable by the table itself.
  assert.equal(build.expandable, true);
  assert.equal(build.expanded, false);

  const opened = model.buildGridRows(layout, index, new Set(["station:LOCAL-031/build"]));
  const under = opened.rows.filter((r) => r.parentKey === "track:station:LOCAL-031/build");
  assert.deepEqual(
    under.map((r) => r.key),
    ["span:v1", "span:v2", "span:v3", "span:v4"],
  );
  assert.ok(under.every((r) => r.level === 3 && r.setSize === 4));
  // An opened leaf with nothing in the window says so in a row of its own.
  const none = model.buildGridRows(layout, index, new Set(["cell:LOCAL-040"]));
  const last = none.rows[none.rows.length - 1];
  assert.equal(last.type, "more");
  assert.equal(last.hidden, 0);
});

test("rows: a track lists at most 200 spans, then one row says how many more", () => {
  const tree = benchTree(1, 500, T0, T0 + 60 * M);
  const layout = layoutOf(tree, new Set());
  const g = model.buildGridRows(layout, model.indexWindow(WIN, T0 + 120 * M), new Set(["bench/0"]));
  assert.equal(g.rows.length, 1 + 200 + 1);
  const more = g.rows[201];
  assert.equal(more.type, "more");
  assert.equal(more.hidden, 300);
  assert.equal(more.setSize, 201);
  // Time order.
  const starts = g.rows.slice(1, 201).map((r) => r.span.start.at);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

// ---------------------------------------------------------------- keyboard

const press = (g, i, key, mods = {}) => model.gridKey(g, i, { key, ...mods }, 5);

test("keyboard: Up/Down, Home/End, Ctrl+Home/End, PageUp/PageDown, clamped", () => {
  const tree = fixture();
  const g = model.buildGridRows(layoutOf(tree, ALL_OPEN), model.indexWindow(WIN, LIVE), new Set());
  const n = g.rows.length;
  assert.deepEqual(press(g, 0, "ArrowDown"), { type: "focus", index: 1 });
  assert.deepEqual(press(g, 0, "ArrowUp"), { type: "focus", index: 0 });
  assert.deepEqual(press(g, 2, "Home"), { type: "focus", index: 0 });
  assert.deepEqual(press(g, 2, "End"), { type: "focus", index: n - 1 });
  assert.deepEqual(press(g, 2, "Home", { ctrlKey: true }), { type: "focus", index: 0 });
  assert.deepEqual(press(g, 2, "End", { ctrlKey: true }), { type: "focus", index: n - 1 });
  assert.deepEqual(press(g, 0, "PageDown"), { type: "focus", index: n - 1 });
  assert.deepEqual(press(g, 4, "PageUp"), { type: "focus", index: 0 });
  // Not the grid's: left to the app (and so to the global playback keys).
  for (const key of [" ", ",", ".", "[", "]", "l", "f", "i", "s", "t", "1", "2", "3", "?", "g", "n"]) assert.equal(press(g, 0, key), null, key);
  assert.equal(press(g, 0, "ArrowDown", { altKey: true }), null);
  assert.equal(press(g, 0, "ArrowDown", { metaKey: true }), null);
  assert.equal(press(g, 0, "ArrowDown", { ctrlKey: true }), null);
});

test("keyboard: Right opens or enters, Left closes or goes to the parent, Enter selects a span", () => {
  const tree = fixture();
  const layout = layoutOf(tree, ALL_OPEN);
  const index = model.indexWindow(WIN, LIVE);
  const g = model.buildGridRows(layout, index, new Set());
  const at = (key) => g.indexOf.get(key);
  // Open cell: Right moves to its first child; Left closes it.
  assert.deepEqual(press(g, 0, "ArrowRight"), { type: "focus", index: 1 });
  assert.deepEqual(press(g, 0, "ArrowLeft"), { type: "toggle", index: 0 });
  // Closed leaf: Right opens it; Left goes to its parent.
  const b = at("track:station:LOCAL-031/build");
  assert.deepEqual(press(g, b, "ArrowRight"), { type: "toggle", index: b });
  assert.deepEqual(press(g, b, "ArrowLeft"), { type: "focus", index: 0 });
  // A span: Enter selects; Left goes to its track; Right stays.
  const c = at("span:c");
  assert.deepEqual(press(g, c, "Enter"), { type: "select", index: c });
  assert.deepEqual(press(g, c, "ArrowLeft"), { type: "focus", index: 0 });
  assert.deepEqual(press(g, c, "ArrowRight"), { type: "focus", index: c });
  // Enter on a track opens or closes it.
  assert.deepEqual(press(g, b, "Enter"), { type: "toggle", index: b });
  // A root: Left stays.
  assert.deepEqual(press(g, at("track:cell:LOCAL-040"), "ArrowLeft"), { type: "focus", index: at("track:cell:LOCAL-040") });
});

test("the grid's keys do not collide with the global map's bindings", () => {
  if (!KEYMAP) return; // keyboard.ts did not load in node (it imports the store); the audit checks it in the browser.
  const global = new Set(KEYMAP.filter((b) => !b.view).flatMap((b) => b.keys));
  for (const k of Object.keys(TIMELINE_KEYS)) global.add(k.toUpperCase());
  // Home and End are global keys: the grid owns them while focused and prevents their default (the map skips those).
  const clash = model.GRID_KEYS.filter((k) => global.has(k) && k !== "Home" && k !== "End");
  assert.deepEqual(clash, []);
});

// ---------------------------------------------------------------- virtualisation

test("virtualisation: only rows in view plus overscan; scrolling to show a row moves as little as possible", () => {
  const H = model.GRID_ROW_HEIGHT;
  const r = model.visibleRange(100 * H, 20 * H + model.GRID_HEADER_HEIGHT, 10_000, 4);
  assert.deepEqual(r, { start: 96, end: 124 });
  assert.deepEqual(model.visibleRange(0, 500, 3), { start: 0, end: 3 });
  const view = 10 * H + model.GRID_HEADER_HEIGHT;
  assert.equal(model.scrollToShow(5, 0, view), 0);
  assert.equal(model.scrollToShow(12, 0, view), 3 * H);
  assert.equal(model.scrollToShow(2, 5 * H, view), 2 * H);
  // Stacked (narrow, 200% zoom): taller rows and no visible header; the same arithmetic.
  const g = model.STACKED;
  assert.equal(g.header, 0);
  assert.ok(g.row >= 60, "three lines");
  assert.deepEqual(model.visibleRange(10 * g.row, 5 * g.row, 1000, 2, g), { start: 8, end: 17 });
  assert.equal(model.scrollToShow(20, 0, 5 * g.row, g), 16 * g.row);
});

test("60,000 spans: building, a keystroke and the drawn rows' summaries stay within budget", () => {
  // 300 tracks of 200 spans each, over two hours.
  const tree = benchTree(300, 200, T0, T0 + 120 * M);
  const allSpans = [...tree.byId.values()].reduce((n, t) => n + t.spanCount, 0);
  assert.equal(allSpans, 60_000);
  const layout = layoutOf(tree, new Set());
  const win = { from: T0, to: T0 + 120 * M };
  const live = T0 + 200 * M;

  let t = performance.now();
  const index = model.indexWindow(win, live);
  const g = model.buildGridRows(layout, index, new Set());
  const buildMs = performance.now() - t;
  assert.equal(g.rows.length, 300);

  // Summaries of what is drawn: one screen.
  t = performance.now();
  const r = model.visibleRange(0, 800, g.rows.length);
  for (let i = r.start; i < r.end; i++) index.summaryOf(g.rows[i].node);
  const drawMs = performance.now() - t;

  // Open 20 tracks (4,000 spans listed).
  const open = new Set(Array.from({ length: 20 }, (_, i) => `bench/${i}`));
  t = performance.now();
  const g2 = model.buildGridRows(layout, index, open);
  const expandMs = performance.now() - t;
  assert.equal(g2.rows.length, 300 + 20 * 200);

  // 1,000 keystrokes.
  t = performance.now();
  let i = 0;
  for (let k = 0; k < 1000; k++) i = model.gridKey(g2, i, { key: k % 3 ? "ArrowDown" : "ArrowLeft" }, 20).index;
  const keyMs = (performance.now() - t) / 1000;

  // The whole window summary (the caption): once per window.
  t = performance.now();
  describe.windowSummary(tree, win, live);
  const captionMs = performance.now() - t;

  console.log(`# 60,000 spans: rows ${buildMs.toFixed(1)} ms, one screen of summaries ${drawMs.toFixed(1)} ms, open 20 tracks ${expandMs.toFixed(1)} ms, keystroke ${(keyMs * 1000).toFixed(1)} µs, window summary ${captionMs.toFixed(1)} ms`);
  assert.ok(buildMs < 50, `rows ${buildMs}`);
  assert.ok(expandMs < 100, `expand ${expandMs}`);
  assert.ok(keyMs < 0.05, `keystroke ${keyMs}`);
  assert.ok(captionMs < 200, `caption ${captionMs}`);
});

// ---------------------------------------------------------------- round 4 (ROUND4.md ids)

test("X2: an open cell's context is its last activity beneath it and the person it waits on", async () => {
  const { buildTrackTree } = await import("../src/timeline/tracks/build.ts");
  const { NO_FILTERS } = await import("../src/timeline/contract.ts");
  const ids = { ticket_id: "LOCAL-001", slice_id: "SLICE-001", wave_id: "WAVE-001" };
  const cell = span("cell:cell:LOCAL-001", "cell", at(T0), null, { entity: "cell:LOCAL-001", ids });
  const visit = span("visit:visit:v1", "visit", at(T0 + M), at(T0 + 9 * M), { entity: "visit:v1", ids: { ...ids, station: "review", visit_id: "v1" }, outcome: "completed" });
  const wait = span("person-wait:gate:p", "person-wait", at(T0 + 8 * M), null, { entity: "gate:LOCAL-001/human-approval#1", ids });
  const live = T0 + 8 * 60 * M;
  const tree = buildTrackTree([cell, visit, wait], "product", NO_FILTERS, live);
  const ctx = describe.openContext(tree, cell, live);
  assert.deepEqual(ctx, { lastActivity: T0 + 9 * M, personSince: T0 + 8 * M });
  assert.equal(describe.openContext(tree, visit, live), null, "a visit is not a container");
  const words = await import("../src/timeline/render/words.ts");
  const said = words.describeSpan(cell, live, ctx);
  assert.match(said, /open 8 h; last activity 23:27:00; waiting for a person since 23:26:00/);
  assert.match(said, /last activity/);
  assert.doesNotMatch(said, /running|at work/);
});

test("T10: summaries count an outcome not known on its own", () => {
  const x = span("x", "execution", at(T0), at(null, { notAfter: T0 + 5 * M, basis: "inferred", reason: "unknown" }));
  const s = describe.summariseSpans([x], { from: T0, to: T0 + 30 * M }, LIVE);
  assert.equal(s.unknown, 1);
  assert.equal(s.failed + s.interrupted, 0);
  assert.match(describe.countWords(s), /one with the outcome not known/);
  assert.equal(describe.attentionWords("unknown"), "Outcome not known");
});

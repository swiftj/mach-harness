// Round 6, the lens defects (docs/mach-next/M6_3_COMPLETION.md section 5): 6 capacity waits in the
// waits lens and one leader per dependency per row; 9 labels kept inside the drawing, the scroll cue and
// the band's height cap; 10 each concurrency line on its own scale with the limit on the line it counts;
// 14 selecting a lens figure does not seek, Enter again or a double-click does; 18 seats in the tracks' order.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const M = await import("../src/timeline/investigate/model.ts");
const G = await import("../src/timeline/investigate/gesture.ts");

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 5, 0, 0);
const t = (m) => T0 + m * MIN;
const LIVE = t(200);

const end = (at) => ({ eventId: at === null ? null : `e-${at}`, at, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "completed" });
function span({ id, kind, entity, parent = null, ids = {}, start, finish = null, outcome = null, attrs = {} }) {
  return {
    id: id ?? `${kind}:${entity}`,
    kind,
    entity,
    parent,
    ids,
    start: end(start),
    end: finish === null ? null : end(finish),
    duration: { ms: finish === null ? null : finish - start, minMs: null, maxMs: null, basis: finish === null ? "open" : "measured" },
    outcome,
    authority: "authoritative",
    attrs,
  };
}

test("defect 6: the waits lens holds capacity waits beside dependency waits, on the slice's row", () => {
  const dep = span({ id: "slice-wait:slice:S-8", kind: "slice-wait", entity: "slice:S-8", ids: { slice_id: "S-8" }, start: t(1), finish: t(10), attrs: { dependsOn: ["S-2", "S-2"] } });
  // A capacity wait that records only its cell: placed on the cell's slice from another span.
  const cap = span({ id: "capacity-wait:cell:T-8@e1", kind: "capacity-wait", entity: "cell:T-8", parent: "cell:T-8", ids: { ticket_id: "T-8" }, start: t(12), finish: t(20), attrs: { limit: 1 } });
  const visit = span({ kind: "visit", entity: "visit:T-8/build#1", ids: { ticket_id: "T-8", slice_id: "S-8" }, start: t(21), finish: t(25) });
  const items = M.waitItems([dep, cap, visit], [], LIVE);
  assert.deepEqual(items.map((i) => [i.kind, i.slice]), [["dependency", "S-8"], ["capacity", "S-8"]]);
  assert.equal(items[1].ticket, "T-8");
  assert.deepEqual(items[1].dependencies, [], "a wait for a place names no dependency");
  assert.deepEqual(items[0].dependencies.map((d) => d.slice), ["S-2"], "a dependency named twice is one dependency");
});

test("defect 6: a dependency named by two waits of a row is one leader, not two overprinted", () => {
  const w = (n, from, to) => span({ id: `slice-wait:slice:S-8#${n}`, kind: "slice-wait", entity: "slice:S-8", ids: { slice_id: "S-8" }, start: from, finish: to, attrs: { dependsOn: ["S-2"] } });
  const merged = span({ kind: "cell", entity: "cell:T-2", ids: { ticket_id: "T-2", slice_id: "S-2" }, start: t(0), finish: t(30), outcome: "merged" });
  const items = M.waitItems([w(1, t(1), t(29)), w(2, t(29), t(31)), merged], [], LIVE);
  assert.equal(items.length, 2);
  const leaders = M.rowLeaders(items);
  assert.equal(leaders.length, 1);
  assert.equal(leaders[0].slice, "S-2");
  assert.equal(leaders[0].instant.at, t(30));
  assert.equal(leaders[0].waits.length, 2);
});

test("defect 9: a label beside a point stays inside the drawing", () => {
  assert.deepEqual(M.placeLabel(100, "abc", 10, 0, 500), { x: 105, anchor: "start" });
  const near = M.placeLabel(480, "taken up again by a later run", 10, 0, 500);
  assert.equal(near.anchor, "end");
  assert.ok(near.x <= 480);
  assert.equal(M.placeLabel(50, "x".repeat(40), 10, 40, 100), null, "fits on neither side: left to the hover card");
});

test("defect 9: the scroll cue and the band's height cap", () => {
  assert.deepEqual(M.overflowCue(0, 190, 400), { above: false, below: true });
  assert.deepEqual(M.overflowCue(210, 190, 400), { above: true, below: false });
  assert.deepEqual(M.overflowCue(0, 190, 190), { above: false, below: false });
  assert.equal(M.bandMaxHeight(760), 220, "a tall screen keeps the 220 px cap");
  const small = M.bandMaxHeight(500);
  assert.ok(small < 220 && small >= 120, "at 1100x700 the band takes at most about 30 % of the room below it");
  assert.ok(500 - small >= 2 * small, "the tracks keep at least twice the band's height");
  assert.equal(M.bandMaxHeight(200), 120, "never below the floor");
  assert.equal(M.bandMaxHeight(Number.NaN), 220);
});

test("defect 10: each concurrency line on its own scale; the limit on the line it counts", () => {
  const series = {
    from: t(0), to: t(30), bucketMs: 10 * MIN, complete: true,
    limits: [{ name: "max_parallel", value: 3, from: t(0), to: null, appliesTo: ["execution", "cell"] }],
    buckets: [
      { from: t(0), active: { execution: { max: 3, mean: 2 }, visit: { max: 5, mean: 3 }, agent: { max: 23, mean: 10 } } },
      { from: t(10), active: { execution: { max: 1, mean: 1 }, agent: { max: 4, mean: 2 } } },
    ],
  };
  const v = M.concurrencyView(series, [], { from: t(0), to: t(30) }, LIVE);
  const by = Object.fromEntries(v.lines.map((l) => [l.kind, l]));
  assert.deepEqual(v.limits[0].lines, ["execution"], "a limit on executions and cells is drawn on the executions line only");
  assert.ok(by.execution.scaleMax >= 3 && by.execution.scaleMax <= 5, `executions read against their limit 3, not 23 (got ${by.execution.scaleMax})`);
  assert.ok(by.agent.scaleMax > 23, "agents have their own scale");
  assert.ok(by.visit.scaleMax > 5 && by.visit.scaleMax < by.agent.scaleMax);
  assert.deepEqual(M.limitLinesOf(["agent"]), ["agent"]);
  assert.deepEqual(M.limitLinesOf(["cell"]), [], "cells are not cells in a station");
  assert.deepEqual(M.limitLinesOf(undefined), ["execution"], "not recorded: executions, as before");
});

test("defect 14: a lens figure selects on click or first Enter; Enter again or a double-click goes to it", () => {
  let selection = null;
  const g = G.lensGesture(() => selection);
  // Click: select only, also a later single click.
  assert.equal(g.decide("fig:a", "click"), false);
  selection = "visit:T/build#1";
  g.settle();
  assert.equal(g.decide("fig:a", "click"), false, "a second single click only keeps the selection");
  g.settle();
  assert.equal(g.decide("fig:a", "double-click"), true, "the second click of a double-click seeks");
  // Enter, Enter.
  assert.equal(g.decide("fig:b", "key"), false);
  g.settle();
  assert.equal(g.decide("fig:b", "key"), true);
  // Enter on one figure then Enter on another: select the other.
  assert.equal(g.decide("fig:c", "key"), false);
  g.settle();
  assert.equal(g.decide("fig:d", "key"), false);
  g.settle();
  // The selection moved elsewhere (the tracks) in between: select again, do not seek.
  selection = "cell:OTHER";
  assert.equal(g.decide("fig:d", "key"), false);
});

test("defect 18: review seats in the tracks' row order, with no seat order of the lens's own", () => {
  const seat = (name) => span({ kind: "seat", entity: `seat:T-4/review#1/${name}`, parent: "gate:T-4/review#1", ids: { ticket_id: "T-4", seat: name }, start: t(0), finish: t(5), outcome: "APPROVE", attrs: { round: 1, vote: "APPROVE" } });
  const spans = [seat("security"), seat("product"), seat("architecture")];
  const order = new Map(["seat:T-4/review#1/architecture", "seat:T-4/review#1/product", "seat:T-4/review#1/security"].map((id, i) => [id, i + 10]));
  const [cell] = M.reviewCells(spans, [], LIVE, order);
  assert.deepEqual(cell.rounds[0].seats.map((s) => s.seat), ["architecture", "product", "security"]);
  // Reversed tree order: the lens follows it.
  const rev = new Map([...order].map(([k, v]) => [k, -v]));
  assert.deepEqual(M.reviewCells(spans, [], LIVE, rev)[0].rounds[0].seats.map((s) => s.seat), ["security", "product", "architecture"]);
  // No row for them: by ref, the tracks' own tie rule.
  assert.deepEqual(M.reviewCells(spans, [], LIVE)[0].rounds[0].seats.map((s) => s.seat), ["architecture", "product", "security"]);
});

test("defect 6: leader labels that would overprint each other are joined, never struck over", () => {
  const ls = M.leaderLabels([{ x: 100, text: "SLICE-007 merged" }, { x: 102, text: "SLICE-002 merged" }, { x: 400, text: "SLICE-005 merged" }], 0, 600);
  assert.equal(ls.length, 2);
  assert.equal(ls[0].text, "SLICE-007, SLICE-002 merged");
  assert.equal(ls[1].text, "SLICE-005 merged");
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i].x > ls[i - 1].x + M.textWidth(ls[i - 1].text.length, 9.5));
});

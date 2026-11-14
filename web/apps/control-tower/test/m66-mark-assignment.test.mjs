// M6.6 performance: a mark's track is a lookup in an index built once per track tree, so a playhead
// step costs at most one pass over the tree's tracks, never marks x tracks. Work is counted, not timed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import "./_load.mjs";
import { spansFixture, marksFixture } from "./fixtures/timeline.mjs";

const grammar = new URL("../../../packages/ui/src/factory/grammar.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@mach/ui") return nextResolve(grammar, context);
    return nextResolve(specifier, context);
  },
});

const { buildTrackTree, markTrackOf, markAssignment } = await import("../src/timeline/tracks/build.ts");
const { spansAsOf, marksAsOf } = await import("../src/timeline/data/derive.ts");
const { NO_FILTERS } = await import("../src/timeline/contract.ts");

const FX = spansFixture({ cells: 12, agentsPerExecution: 24, toolsPerAgent: 12 });
const SPANS = FX.spans;
const MARKS = marksFixture(FX, { count: 5000 });
const T0 = FX.extent.from;
const T1 = FX.extent.to;

test("a playhead step assigns marks to tracks with at most one pass over the tracks", (t) => {
  let previous;
  let steps = 0;
  for (let i = 1; i <= 12; i++) {
    const at = T0 + ((T1 - T0) * (i + 20)) / 40;
    const spans = spansAsOf(SPANS, at);
    const marks = marksAsOf(MARKS, at);
    const tree = buildTrackTree(spans, "product", NO_FILTERS, at, previous);
    previous = tree;
    const before = { ...markAssignment };
    let placed = 0;
    for (const m of marks) if (m.entity && markTrackOf(tree, m.entity) !== null) placed++;
    // Asking again is free: the index is kept with the tree.
    for (const m of marks.slice(0, 100)) if (m.entity) markTrackOf(tree, m.entity);
    const builds = markAssignment.indexBuilds - before.indexBuilds;
    const scanned = markAssignment.nodesScanned - before.nodesScanned;
    assert.ok(builds <= 1, `index builds in one step: ${builds}`);
    assert.ok(scanned <= tree.byId.size, `nodes scanned for ${marks.length} marks over ${tree.byId.size} tracks: ${scanned}`);
    assert.ok(marks.length > 500 && tree.byId.size > 100 && placed > 100, `a large model: ${marks.length} marks, ${tree.byId.size} tracks, ${placed} placed`);
    if (i === 12) t.diagnostic(`${spans.length} spans, ${marks.length} marks, ${tree.byId.size} tracks, ${placed} placed; ${scanned} nodes scanned`);
    steps++;
  }
  assert.equal(steps, 12);
});

test("the index places a mark on the most specific track about it (the track is it before a span about it)", () => {
  const tree = buildTrackTree(SPANS, "product", NO_FILTERS, T1);
  for (const node of [...tree.byId.values()].slice(0, 200)) {
    if (!node.id.includes(":")) continue;
    const id = markTrackOf(tree, node.id);
    if (id === null) continue;
    const at = tree.byId.get(id);
    // Rank -1 (the track is the ref) wins over any span or ribbon about it.
    if (tree.byId.has(node.id)) assert.equal(id, node.id);
    assert.ok(at, `${node.id} placed on a track that exists`);
  }
});

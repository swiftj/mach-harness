// M18: a small change on the Factory Floor and in Factory Analytics. The groom station's exit says when
// a ticket is a small change (event revision 8); the Line says so beside the ticket's facts, and the
// Flow area's Groom station sets time at Groom for small changes beside full slices, a small change
// that became a full slice counted as full with a note of how many did. Too few visits: words, no figure.
// A ticket that is not small shows nothing new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sim, live } from "./_load.mjs";
import { ev, finalize } from "./fixtures/v3.mjs";

const L = await import("../src/line/model.ts");
const G = await import("../src/analytics/model/groomSplit.ts");
const Q = await import("../src/analytics/wire/query.ts");
const A = await import("../src/analytics/data/adapt.ts");
const P = await import("../src/analytics/data/parse.ts");
const { groupedPairKey } = await import("../src/analytics/contract.ts");
const { simulatedAnalytics } = await import("../src/analytics/data/simulation.ts");
const { createSceneLog, provenance } = sim;

const T0 = Date.UTC(2026, 10, 22, 9, 0, 0);

function groomed(exits, ticket = "T-18") {
  const out = [];
  let seq = 0;
  let t = T0;
  exits.forEach((extra, i) => {
    const ids = { ticket_id: ticket, slice_id: "SLICE-018", cell_instance: "3f2a9c1e", visit_id: `${ticket}/groom#${i + 1}`, station: "groom", round: 1 };
    const line = (type, data) => {
      out.push(ev(type, { stream: "cell-lifecycle", key: `c:${ticket}:3f2a9c1e`, seq: ++seq, t, ids, entities: [`cell:${ticket}`], data }));
      t += 1000;
    };
    line("station.entered", { station: "groom", stage: "interview", action: "groom", resumed: false, unclosed_visit: null, head: null, counts: {} });
    line("station.exited", { station: "groom", outcome: "spec-ready", stage: "spec-ready", duration_ms: 1000, closed_by: null, head: null, counts: {}, ...extra });
  });
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  log.ingest(finalize(out));
  return L.lineModel(log.head(), T0 + 3_600_000).rows.find((r) => r.ticketId === ticket);
}

test("the Line says a small change beside the ticket, and that it became a full slice", () => {
  const small = groomed([{ kind: "small", widened: false, widened_rule: null }]);
  assert.deepEqual(small.smallChange, { widened: false, rule: null });
  assert.equal(L.smallChangeWords(small.smallChange), "a small change");
  const widened = groomed([{ kind: "small", widened: false, widened_rule: null }, { kind: "small", widened: true, widened_rule: "high-risk-file" }]);
  assert.deepEqual(widened.smallChange, { widened: true, rule: "high-risk-file" });
  assert.equal(L.smallChangeWords(widened.smallChange), "began as a small change, now a full slice");
});

test("a ticket that is not small shows nothing new", () => {
  const row = groomed([{}]);
  assert.equal("smallChange" in row, false);
});

const group = (key, denominator, extra = {}) => ({ key, keys: {}, value: denominator ? 1000 : null, numerator: denominator * 1000, denominator, sample_count: denominator, basis_counts: null, coverage: { eligible: denominator, counted: denominator, share: 1, excluded: [] }, p50_ms: 1000, ...extra });
const row = (groups) => ({ id: "C1", groups, coverage: {}, basis: "measured" });

test("time at Groom: compared only when each side has enough measured visits", () => {
  const widened = row([group("groom|yes", 2), group("groom|no", 9)]);
  const enough = G.groomSplit(row([group("groom|small", 5), group("groom|full", 6), group("build|small", 40)]), widened);
  assert.equal(enough.state, "compare");
  assert.equal(enough.small.denominator, 5);
  assert.equal(enough.full.denominator, 6);
  assert.equal(enough.widened, 2);
  assert.equal(G.widenedWords(enough.widened), "2 tickets counted here as full slices began as small changes and became full slices.");
  assert.equal(G.widenedWords(1), "1 ticket counted here as a full slice began as a small change and became a full slice.");
  assert.equal(G.widenedWords(0), null);

  const few = G.groomSplit(row([group("groom|small", 2), group("groom|full", 30)]), widened);
  assert.equal(few.state, "too-few");
  assert.equal(G.tooFewWords(few), "Too few to compare yet: 2 measured visits of small changes and 30 measured visits of full slices in this window. Times are set side by side once each has at least 5.");
  const none = G.groomSplit(row([group("groom|full", 30)]), undefined);
  assert.equal(none.state, "too-few");
  assert.equal(none.small, 0);
  assert.equal(none.widened, null, "not served: no note, never a zero");
});

test("a source that does not tell them apart says so in words", () => {
  const split = G.groomSplit({ id: "C1", groups_reason: "The simulation groups by one dimension at a time." }, undefined);
  assert.deepEqual(split, { state: "not-told-apart", reason: "The simulation groups by one dimension at a time." });
  assert.equal(G.groomSplit(undefined, undefined).state, "not-told-apart");
});

test("the Flow area asks for C1 by station and change, and C2 by station and widened; the snapshot keys them", async () => {
  const plan = Q.planFor("flow", null);
  assert.deepEqual(plan.groups.filter((g) => g.by).map((g) => [g.ids, g.by]), [[["C1"], ["station", "change"]], [["C2"], ["station", "widened"]]]);
  // As the observer serves it (apps/observer m18_metrics_test.go): two group dimensions, keys "groom|small".
  const wire = P.readMetricRow({ id: "C1", name: "Station cycle time", kind: "duration", group_dims: ["station", "change"], coverage: { eligible: 1, counted: 1, excluded: [] },
    groups: [{ key: "groom|small", keys: { station: "groom", change: "small" }, value: 4000, numerator: 4000, denominator: 1, sample_count: 1, coverage: { eligible: 1, counted: 1, excluded: [] } }] });
  const snap = A.toContractSnapshot({
    source: "live", filters: { window: "all", risk: null, app_type: null, model: null }, window: { from_ms: 0, to_ms: 1 }, generated_ms: 1, totals: [],
    grouped: [wire], definitions_version: 5, partial: false, group_overflow: 0,
  });
  const c1 = snap.grouped[groupedPairKey("C1", "station", "change")];
  assert.ok(c1, Object.keys(snap.grouped).join(", "));
  assert.equal(G.groomSplit(c1, undefined).small, 1);
  // The simulation's fixture groups by one dimension: the area says so rather than inventing a split.
  const reply = await simulatedAnalytics().metrics({ ids: ["C1"], groupBy: ["station", "change"] });
  assert.equal(reply.status, "ok");
  assert.match(reply.value.metrics[0].groups_reason ?? "", /one dimension/);
});

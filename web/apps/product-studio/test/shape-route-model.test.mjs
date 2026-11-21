// Unit tests for Size and route, and Change what exists (src/features/shape/route/model.ts), against the real engine
// answers the fixture transport serves (web/fixtures). Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  ROUTES,
  applyBlocked,
  applyOutcome,
  applyPlan,
  applyWhat,
  briefLines,
  changeArgs,
  connections,
  countedRows,
  coverageProgress,
  coverageWords,
  epicOfRule,
  findRule,
  gateWords,
  highRiskWords,
  journeyStep,
  outcomeText,
  parseRule,
  quote,
  routeName,
  routeState,
  REASON_NEEDED,
  settleArgs,
  sizeGate,
} from "../src/features/shape/route/model.ts";

const folder = new URL("../../../fixtures/", import.meta.url);
const run = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8"));
const data = (name) => run(name).data;

/* ── The gate ─────────────────────────────────────────────────────────── */

test("sizing is offered only while a Go holds for the brief as it is now", () => {
  const gate = (name) => sizeGate(data(name).verdict, data(name).acts.size);
  assert.deepEqual(gate("idea.show.go"), { kind: "go" });
  assert.equal(gate("idea.show.brief-written").kind, "no-go");
  assert.equal(gate("idea.show.brief-written").decision, null);
  assert.equal(gate("idea.show.not-now").decision, "not-now");
  assert.equal(gate("idea.show.fault").decision, "no");
  const stale = gate("idea.show.stale-route");
  assert.equal(stale.kind, "stale");
  assert.match(stale.note, /The brief changed after this verdict was recorded/);
  // Without the engine's answer nothing is offered: a holding Go alone does not open sizing.
  assert.equal(sizeGate(data("idea.show.go").verdict, null).kind, "no-go");
});

test("what is needed is said in the engine's words: its refusal, and its note on a verdict that no longer holds", () => {
  const refusal = run("idea.size.refused-no-go").refused;
  const fault = data("idea.show.fault");
  assert.deepEqual(gateWords(sizeGate(fault.verdict, fault.acts.size)), [refusal]);
  const staleShow = data("idea.show.stale-route");
  const stale = gateWords(sizeGate(staleShow.verdict, staleShow.acts.size));
  assert.equal(stale.length, 1);
  assert.ok(stale[0].includes(staleShow.verdict.stale_note), "the engine's sentence carries its note on the verdict");
  assert.ok(run("idea.map.refused-stale").refused.includes("no longer holds"));
  assert.deepEqual(gateWords({ kind: "go" }), []);
});

/* ── The route ────────────────────────────────────────────────────────── */

test("not sized, holds, stale: the engine's record and its view of whether it holds", () => {
  assert.deepEqual(routeState(data("idea.show.go").route, null), { kind: "not-sized" });
  const status = data("idea.map-status.uncovered");
  const shaped = data("idea.show.shaped");
  const holds = routeState(shaped.route, status.route);
  assert.equal(holds.kind, "holds");
  assert.equal(holds.route, "several-epics");
  assert.equal(holds.why, "The brief's outcomes are in 2 different capabilities, so the route is several epics.");
  const staleView = { ...status.route, holds: false, stale: true, stale_note: "The brief or the verdict changed after this route was found, so it no longer holds." };
  const stale = routeState(shaped.route, staleView);
  assert.equal(stale.kind, "stale");
  assert.equal(stale.note, staleView.stale_note);
  // A recorded route the engine's view has not confirmed for this brief is not shown as holding.
  assert.equal(routeState(data("idea.show.stale-route").route, null).kind, "stale");
});

test("a route sized on this page holds, with the engine's sentence and counts", () => {
  for (const name of ["one-slice", "epic", "several-epics"]) {
    const sized = data(`idea.size.${name}`);
    const state = routeState(null, null, sized);
    assert.equal(state.kind, "holds");
    assert.equal(state.route, name);
    assert.equal(state.why, sized.why);
    assert.equal(routeName(name), ROUTES.find((r) => r.route === name).name);
  }
});

test("there are exactly three routes, the engine's, and no light path", () => {
  assert.deepEqual(
    ROUTES.map((r) => r.route),
    ["one-slice", "epic", "several-epics"],
  );
  const engine = readFileSync(new URL("../../../../skills/product-studio/scripts/shape_route.py", import.meta.url), "utf8");
  for (const r of ROUTES) assert.ok(engine.includes(`"${r.route}"`), r.route);
});

/* ── What MACH counted ────────────────────────────────────────────────── */

test("high-risk areas not determined are said so, never as zero", () => {
  const epic = data("idea.size.epic").counted;
  assert.equal(epic.high_risk_areas, null);
  const words = highRiskWords(epic);
  assert.equal(words.value, "Not determined");
  assert.match(words.note, /SLICE-001\/FR-01 and SLICE-001\/INV-02/);
  const row = countedRows(epic).find((r) => r.label === "High-risk areas");
  assert.equal(row.value, "Not determined");
  assert.notEqual(row.value, "0");
  assert.equal(highRiskWords(data("idea.size.one-slice").counted).value, "None found");
  assert.equal(highRiskWords(data("idea.size.several-epics").counted).value, "2");
  assert.equal(highRiskWords({ high_risk_areas: 1, high_risk_not_determined: ["SLICE-003/FR-01"] }).note, "Not determined for SLICE-003/FR-01.");
});

test("every count is the engine's number, in the rule's order, then what it counts beside the rule", () => {
  const rows = countedRows(data("idea.size.several-epics").counted);
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ["Outcomes", "2"],
      ["Capabilities", "2"],
      ["Shipped rules touched", "2"],
      ["High-risk areas", "2"],
      ["Principle concerns", "0"],
      ["Policy concerns", "0"],
    ],
  );
  const lookedUp = countedRows({ ...data("idea.size.one-slice").counted, shipped_rules_looked_up: 3 }).find((r) => r.label === "Shipped rules touched");
  assert.equal(lookedUp.note, "3 more looked up while exploring.");
});

/* ── Where the product manager is ─────────────────────────────────────── */

test("the steps: size, map, settle, make the drafts, done", () => {
  const holds = { kind: "holds", route: "epic", why: "", at: "", counted: null };
  assert.equal(journeyStep({ kind: "not-sized" }, null), 0);
  assert.equal(journeyStep({ ...holds, kind: "stale", note: null }, data("idea.map-status.uncovered")), 0);
  assert.equal(journeyStep(holds, { map: null }), 1);
  assert.equal(journeyStep(holds, data("idea.map-status.uncovered")), 2);
  assert.equal(journeyStep(holds, data("idea.map-status.settled")), 3);
  assert.equal(journeyStep(holds, data("idea.map-status.applied")), 4);
});

/* ── Coverage and settling ────────────────────────────────────────────── */

test("coverage: settled of total, counting only outcomes no slice carries", () => {
  const uncovered = data("idea.map-status.uncovered");
  assert.deepEqual(coverageProgress(uncovered.coverage), { total: 1, settled: 0, left: [uncovered.coverage[1]] });
  assert.deepEqual(coverageProgress(data("idea.map-status.settled").coverage), { total: 1, settled: 1, left: [] });
  assert.deepEqual(coverageProgress(undefined), { total: 0, settled: 0, left: [] });
  const slices = uncovered.map.slices;
  assert.equal(coverageWords(uncovered.coverage[0], slices), "Carried by S1, “Renew a loan from my loans” and S2, “Renew from the catalogue”");
  assert.equal(coverageWords(uncovered.coverage[1], slices), "No slice carries it");
  assert.equal(coverageWords(data("idea.settle").coverage[1], slices), "Settled: part of S2, “Renew from the catalogue”");
  assert.equal(coverageWords(data("idea.settle.out-of-scope").coverage.find((r) => r.state === "settled"), slices), "Settled: out of scope");
  assert.equal(coverageWords({ outcome: "O-3", carried_by: [], state: "settled", settled: { as: "later", at: "" } }, slices), "Settled: later");
});

test("settling sends exactly what the host accepts, and says what is still needed", () => {
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "", slice: "", reason: "" }), { missing: "Choose what this outcome is: part of a slice, out of scope, or later." });
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "slice", slice: "", reason: "" }), { missing: "Choose the slice that carries this outcome." });
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "slice", slice: "S2", reason: "  The catalogue\n says why. " }), {
    args: { idea_id: "IDEA-001", outcome: "O-2", as: "slice", slice: "S2", reason: "The catalogue says why." },
  });
  // Out of scope and later need the product manager's reason; the engine refuses them without one.
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "later", slice: "S2", reason: "  " }), { missing: REASON_NEEDED });
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "out-of-scope", slice: "", reason: "" }), { missing: REASON_NEEDED });
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "later", slice: "S2", reason: "After the summer." }), {
    args: { idea_id: "IDEA-001", outcome: "O-2", as: "later", reason: "After the summer." },
  });
  assert.deepEqual(settleArgs("IDEA-001", "O-2", { choice: "slice", slice: "S2", reason: "" }), { args: { idea_id: "IDEA-001", outcome: "O-2", as: "slice", slice: "S2" } });
});

/* ── Making the drafts ────────────────────────────────────────────────── */

test("the confirmation lists exactly what will be made, by name and in order", () => {
  const map = data("idea.map-status.uncovered").map;
  const plan = applyPlan(map, (id) => (id === "EPIC-001" ? "Team membership" : null));
  assert.deepEqual(plan, {
    epics: [{ key: "E1", title: "Renew loans yourself" }],
    slices: [
      { key: "S1", title: "Renew a loan from my loans", epic: "Renew loans yourself" },
      { key: "S2", title: "Renew from the catalogue", epic: "Team membership" },
    ],
  });
  assert.equal(applyWhat(plan), "1 epic and 2 draft slices");
  assert.equal(applyWhat({ epics: [], slices: [plan.slices[0]] }), "1 draft slice");
});

test("nothing is made while an outcome is unsettled or the engine names a blocker", () => {
  const uncovered = data("idea.map-status.uncovered");
  assert.deepEqual(applyBlocked(uncovered), ["Settle O-2 first. Nothing is made while any outcome is unsettled."]);
  assert.deepEqual(applyBlocked(data("idea.map-status.settled")), []);
  assert.deepEqual(applyBlocked(data("idea.map-status.applied")), []);
  const blocked = { ...uncovered, not_covered: [], blockers: ["The brief changed after this map was recorded. Record the map again."] };
  assert.deepEqual(applyBlocked(blocked), ["The brief changed after this map was recorded. Record the map again."]);
  assert.match(run("idea.apply.refused-unsettled").refused, /O-2/);
});

test("made, then made again: the second makes nothing and says what already exists", () => {
  const first = applyOutcome(data("idea.apply"));
  assert.deepEqual(first, { made: ["EPIC-002", "SLICE-005", "SLICE-006"], kept: [], missing: [], nothingNew: false });
  const again = applyOutcome(data("idea.apply.again"));
  assert.deepEqual(again, { made: [], kept: ["EPIC-002", "SLICE-005", "SLICE-006"], missing: [], nothingNew: true });
  assert.match(data("idea.apply.again").note, /Nothing new/);
});

/* ── The brief's lines, as data ───────────────────────────────────────── */

test("a slice's brief lines are quoted from the brief as written, by number, as plain text", () => {
  const brief = data("brief.show.passes");
  const lines = briefLines(brief.text);
  const [q] = quote(lines, "9-10");
  assert.deepEqual(q.range, [9, 10]);
  assert.equal(q.lines[0].text, brief.text.split("\n")[8]);
  assert.equal(q.unread, 0);
  assert.equal(quote(lines, "999-1000")[0].unread, 2);
  assert.deepEqual(quote(lines, "x"), []);
  assert.equal(briefLines(null), null);
  assert.equal(outcomeText(brief, "O-1"), "Members renew without calling the library.");
  assert.equal(outcomeText(brief, "O-9"), null);
  assert.equal(outcomeText(null, "O-1"), null);
});

/* ── Change what exists ───────────────────────────────────────────────── */

test("a rule is named as the host accepts it, or not at all", () => {
  assert.deepEqual(parseRule("SLICE-001/INV-02"), { rule: "SLICE-001/INV-02", sliceId: "SLICE-001", id: "INV-02" });
  assert.deepEqual(parseRule("SLICE-012/R3"), { rule: "SLICE-012/R3", sliceId: "SLICE-012", id: "R3" });
  for (const bad of [null, "", "SLICE-1/FR-01", "SLICE-001/AC-01", "SLICE-001", "slice-001/fr-01", "SLICE-001/FR-01; rm"]) assert.equal(parseRule(bad), null, String(bad));
});

test("the rule with connected rules, without, no longer in force, and unknown", () => {
  const epic = data("epic.current").epic;
  const withLinks = findRule(epic, "SLICE-001/FR-01");
  assert.equal(withLinks.standing, "in-force");
  const linked = connections(withLinks.rule);
  assert.ok(linked.length >= 1);
  assert.equal(linked[0].kind, "confirmed");
  assert.match(linked[0].words, /declared it kept, in its example AC-/);

  const alone = findRule(epic, "SLICE-002/FR-01");
  assert.deepEqual(connections(alone.rule), []);

  const tookPlace = connections(findRule(epic, "SLICE-003/FR-01").rule);
  assert.equal(tookPlace[0].kind, "took-the-place-of");

  assert.equal(findRule(epic, "SLICE-001/FR-02").standing, "no-longer");
  assert.equal(findRule(epic, "SLICE-099/FR-01"), null);
  assert.equal(findRule(null, "SLICE-001/FR-01"), null);
  assert.match(run("idea.change.refused-replaced").refused, /no longer in force/);
});

test("the epic comes from the address, else from the status", () => {
  assert.equal(epicOfRule("EPIC-004", "SLICE-001", []), "EPIC-004");
  assert.equal(epicOfRule("not-an-epic", "SLICE-001", [{ slice_id: "SLICE-001", epic_id: "EPIC-002" }]), "EPIC-002");
  assert.equal(epicOfRule(null, "SLICE-001", undefined), null);
});

test("starting a change sends the rule, and a title only when one was typed, on one line", () => {
  assert.deepEqual(changeArgs("SLICE-001/INV-02", "  "), { rule: "SLICE-001/INV-02" });
  assert.deepEqual(changeArgs("SLICE-001/INV-02", " Allow a third\nrenewal "), { rule: "SLICE-001/INV-02", title: "Allow a third renewal" });
  assert.equal(changeArgs("SLICE-001/INV-02", "x".repeat(200)).title.length, 120);
  assert.equal(data("idea.change").stage, "exploring");
});

/* ── Wording ──────────────────────────────────────────────────────────── */

test("the screens say MACH does things, never a script, and offer no way to choose a route", () => {
  const dir = new URL("../src/features/shape/route/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const text = readFileSync(new URL(file, dir), "utf8");
    const strings = [...text.matchAll(/"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3]).join("\n");
    assert.doesNotMatch(strings, /\ba script\b/i, file);
    assert.doesNotMatch(strings, /choose (the|a) route|pick (the|a) route/i, file);
    assert.doesNotMatch(strings, /\bSubmit\b|\bOK\b/, file);
  }
});

test("in fixture mode idea.show and idea.map-status answer for the same idea, so a route never reads stale without its note", () => {
  const pairs = readdirSync(folder).filter((f) => f.startsWith("idea.map-status.")).map((f) => f.slice("idea.map-status.".length, -".json".length));
  for (const name of pairs) {
    const show = run(`idea.show.${name}`);
    if (!show.data) continue;
    const status = data(`idea.map-status.${name}`);
    assert.equal(status.idea_id, show.data.idea.idea_id, name);
    const state = routeState(show.data.route, status.route);
    if (state.kind === "stale") assert.ok(state.note, `${name}: a stale route carries the engine's note`);
  }
  const blockers = data("idea.map-status.blockers");
  assert.equal(blockers.blockers.length, 2);
  assert.equal(blockers.can_apply, false);
  const sized = data("idea.show.sized");
  assert.equal(routeState(sized.route, data("idea.map-status.sized").route).kind, "holds");
  assert.equal(data("idea.map-status.sized").map, null);
  assert.deepEqual(sized.route.details.touches.shipped_rules, ["SLICE-002/FR-01", "SLICE-001/FR-01"]);
});

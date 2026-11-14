// M6.6 Phase 2 items owned by "words": one duration and moment vocabulary (I-09, I-10, I-11), the
// Timeline -> Analytics and Timeline -> floor journeys (I-12, I-14), Back restoring Analytics' view
// ephemera (I-15), plain words for developer words (I-17), the Factory-level station (I-22) and the
// artifact section's wording (I-45).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim } from "./_load.mjs";

const time = await import("../src/shell/time.ts");
const Fmt = await import("../src/analytics/model/format.ts");
const DataFmt = await import("../src/analytics/data/format.ts");
const charts = await import("../src/analytics/model/charts.ts");
const place = await import("../src/analytics/model/visitPlace.ts");
const words = await import("../src/shell/inspector/words.ts");
const timing = await import("../src/shell/inspector/timing.ts");
const analytics = await import("../src/scene/analytics.ts");
const model = await import("../src/timeline/inspector/model.ts");
const { createSceneStore, showOnFloorAt } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");
const remember = await import("../src/analytics/ui/remember.ts");

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const DAY = 86_400_000;

// ---------------------------------------------------------------- I-09, I-10: one vocabulary

test("I-09: one duration vocabulary: the shell's, Analytics' and the data layer's words are the same", () => {
  const cases = [
    [48_000, "48 s"],
    [4 * 60_000 + 12_000, "4 min 12 s"],
    [26 * 60_000 + 20_000, "26 min 20 s"],
    [3_600_000 + 3 * 60_000, "1 h 3 min"],
    [3_600_000, "1 h"],
    [8 * 3_600_000, "8 h"],
    [39 * 3_600_000, "1 d 15 h"],
    [2 * DAY, "2 d"],
  ];
  for (const [ms, want] of cases) {
    assert.equal(time.duration(ms), want, `shell ${ms}`);
    assert.equal(Fmt.durationText(ms), want, `analytics ${ms}`);
    assert.equal(DataFmt.durationWords(ms), want, `data ${ms}`);
  }
  assert.equal(Fmt.durationText(340), "340 ms");
  assert.equal(Fmt.durationText(null), "–");
  // Never "1 h 0 min".
  for (let h = 1; h < 72; h++) assert.doesNotMatch(Fmt.durationText(h * 3_600_000), / 0 (min|h)$/);
});

test("I-09: a moment reads as the Timeline's ruler and inspector say it: day, then HH:MM:SS UTC", () => {
  const t = Date.UTC(2026, 10, 4, 9, 29, 43);
  assert.equal(Fmt.clockText(t), "4 Nov, 09:29:43 UTC");
  assert.equal(Fmt.clockText(t), `${Fmt.dayText(t)}, ${time.utcClock(t)} UTC`);
});

test("I-10: basis words are the Timeline's: measured, bounded, inferred, open, unknown, not recorded", () => {
  assert.deepEqual({ ...Fmt.BASIS_WORDS }, { measured: "measured", open: "open", inferred: "inferred (placed by rule)", bounded: "bounded", unknown: "unknown", "not-recorded": "not recorded" });
  for (const w of Object.values(Fmt.BASIS_WORDS)) assert.doesNotMatch(w, /still open|reconstructed/);
});

test("I-11: trend columns take the Timeline ruler's ticks and day words, at UTC midnights, never crowded", () => {
  const from = Date.UTC(2026, 10, 1);
  const days = Array.from({ length: 14 }, (_, i) => ({ from: from + i * DAY, to: from + (i + 1) * DAY }));
  const ticks = charts.rulerTicks(days, 700);
  assert.ok(ticks.length >= 4);
  assert.equal(ticks[0].label, "1 Nov");
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 56);
  for (const t of ticks) assert.match(t.label, /^\d{1,2} [A-Z][a-z]{2}$/);
  // Unequal columns (a short first week): a tick sits inside the column that holds its day.
  const weeks = [{ from: from + 4 * DAY, to: from + 7 * DAY }, { from: from + 7 * DAY, to: from + 14 * DAY }];
  const w = charts.rulerTicks(weeks, 400, 0);
  assert.ok(w.some((t) => t.label === "8 Nov" && t.x === 200));
  assert.equal(charts.rulerTicks([{ from: 1, to: 2 }], 400), null, "one column: its own label stands");
  assert.equal(charts.rulerTicks([{}, {}], 400), null, "columns without periods: their own labels stand");
  // The columns use it.
  assert.match(src("analytics/ui/charts/index.tsx"), /const ruler = rulerTicks\(points, plotW\)/);
});

// ---------------------------------------------------------------- I-12: a visit -> its measured history

test("I-12: the visit's period is the seven whole UTC days ending with the day it ended (or began, while open)", () => {
  const ended = Date.UTC(2026, 10, 4, 9, 29);
  assert.deepEqual(analytics.visitAnalyticsWindow({ enteredAt: ended - 60_000, leftAt: ended }), { from: Date.UTC(2026, 9, 29), to: Date.UTC(2026, 10, 5) });
  const open = analytics.visitAnalyticsWindow({ enteredAt: ended, leftAt: null });
  assert.equal(open.to - open.from, 7 * DAY);
  assert.ok(analytics.isAnalyticsWindow(open), "a window the store accepts");
});

test("I-12: where a visit sits among the measured visits, in the bounded grammar of a bucket", () => {
  const bins = [
    { fromMs: 1000, toMs: 2000, count: 3 },
    { fromMs: 2000, toMs: 4000, count: 5 },
    { fromMs: 4000, toMs: 8000, count: 2 },
  ];
  const p = place.visitPlace(bins, 2500);
  assert.deepEqual({ ...p }, { shorter: 3, longer: 2, same: 5, total: 10, bin: { fromMs: 2000, toMs: 4000 } });
  assert.equal(place.visitPlaceWords(p, 2500, time.duration), "3 s, measured. Of 10 measured visits in this period, 3 were shorter and 2 longer; 5 were between 2 s and 4 s, as this one was.");
  assert.match(place.visitPlaceWords(place.visitPlace([], 2500), 2500, time.duration), /No measured visit/);
});

test("I-12: the visit inspector offers it; Flow reads the one selection (no second store) and marks the visit", () => {
  const anat = src("shell/inspector/anatomies.tsx");
  const visit = anat.slice(anat.indexOf("export function VisitAnatomy"), anat.indexOf("function ReviewerWords"));
  assert.match(visit, /<VisitHistoryLink visit=\{visit\} \/>/);
  assert.match(src("shell/inspector/parts.tsx"), /window: visitAnalyticsWindow\(visit\)[\s\S]*Open its measured history/);
  const flow = src("analytics/ui/areas/Flow.tsx");
  assert.match(flow, /s\.selection/);
  assert.match(flow, /pickedVisitOf/);
  assert.match(flow, /mark=\{from && from\.ms !== null/);
  assert.doesNotMatch(flow, /createContext|setSelection|useState<.*Visit/, "no second selection store");
});

// ---------------------------------------------------------------- I-14: the floor at the failure's moment

test("I-14: a failed verification or rejected review is decided at its recorded end; nothing else offers it", () => {
  const span = (kind, outcome, end, ids = {}) => ({ id: "s", kind, entity: "visit:T/verify#1", ids, attrs: {}, start: { at: 0 }, end: end === null ? null : { at: end, precision: "ms" }, outcome, authority: "authoritative" });
  assert.equal(model.failedJudgementAt(span("visit", "FAIL_WITH_EVIDENCE", 500, { station: "verify" }), 1000), 500);
  assert.equal(model.failedJudgementAt(span("visit", "REJECTED", 500, { station: "review" }), 1000), 500);
  assert.equal(model.failedJudgementAt(span("round", "REJECTED", 500), 1000), 500);
  assert.equal(model.failedJudgementAt(span("visit", "PASS", 500, { station: "verify" }), 1000), null, "passed");
  assert.equal(model.failedJudgementAt(span("visit", "FAIL_WITH_EVIDENCE", 500, { station: "build" }), 1000), null, "not a judgement");
  assert.equal(model.failedJudgementAt(span("visit", "FAIL_WITH_EVIDENCE", 1500, { station: "verify" }), 1000), null, "decided after the playhead: not known yet");
});

test("I-14: 'Show the floor at this moment' moves the one playhead, keeps the selection, shows the floor; 'Show on the floor' stays", () => {
  const store = createSceneStore({ fixture: sim.SCENARIO, clock: manualClock() });
  store.setWorkspace("timeline");
  store.select("cell:TKT-101", { focus: false });
  const t = Math.round(sim.SCENARIO.events.at(-1).t / 2);
  showOnFloorAt(store, t);
  const s = store.getState();
  assert.equal(s.workspace, "floor");
  assert.equal(s.selection, "cell:TKT-101");
  assert.ok(Math.abs(s.playhead - t) < 1, `playhead ${s.playhead} at ${t}`);
  const section = src("timeline/inspector/InTimeSection.tsx");
  assert.match(section, /Show the floor at this moment/);
  assert.match(section, /"Show on the floor"/);
  assert.match(section, /showOnFloorAt\(store, at\)/);
});

// ---------------------------------------------------------------- I-15: Back restores the view ephemera

test("I-15: view ephemera are remembered per store, codes only, bounded, never in the address", () => {
  const a = {};
  const b = {};
  remember.remember(a, "sort:Total measured time by station", { key: "p50", dir: "asc" });
  remember.remember(a, "scroll:flow", 640);
  assert.deepEqual(remember.recall(a, "sort:Total measured time by station"), { key: "p50", dir: "asc" });
  assert.equal(remember.recall(a, "scroll:flow"), 640);
  assert.equal(remember.recall(b, "scroll:flow"), undefined, "another store (another source) starts clean");
  for (let i = 0; i < remember.REMEMBER_MAX + 10; i++) remember.remember(a, `table:c${i}`, true);
  assert.equal(remember.recall(a, "sort:Total measured time by station"), undefined, "the oldest is forgotten first");
  const mod = src("analytics/ui/remember.ts");
  assert.doesNotMatch(mod, /localStorage|sessionStorage|location|history\./);
  assert.match(src("analytics/ui/charts/index.tsx"), /useRemembered\(`sort:\$\{caption\}`, initial\)/);
  assert.match(src("analytics/ui/kit.tsx"), /useRemembered\(`table:\$\{chart\}`, false\)/);
  assert.match(src("analytics/ui/Workspace.tsx"), /useRememberedScroll\(sheet, view\.area/);
});

// ---------------------------------------------------------------- I-17: no developer words

test("I-17: no request parameter or configuration key is said on screen; a rule is named in words with its id beside", () => {
  const flow = src("analytics/ui/areas/Flow.tsx");
  assert.doesNotMatch(flow.replace(/\/\/.*$/gm, ""), /max_parallel[^"]*"\s*\}?\s*$|recorded max_parallel/m);
  const opp = src("analytics/ui/areas/Opportunities.tsx");
  assert.match(opp, /ruleWords\(r\.insight_rules, n\.rule\)/);
  for (const f of ["../../../apps/observer/internal/insight/rules.go", "../../../apps/observer/internal/insight/gather.go", "../../../apps/observer/internal/insight/templates.go"]) {
    const go = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const strings = [...go.matchAll(/"([^"\n]*\s[^"\n]*)"/g)].map((m) => m[1]);
    for (const s of strings) assert.doesNotMatch(s, /from_ms|to_ms|max_parallel/, `${f}: ${s}`);
  }
});

// ---------------------------------------------------------------- I-22: the Factory-level station

test("I-22: the Factory-level station never says 'Not visited' when a cell has been there", () => {
  const v = (station, enteredAt, leftAt) => ({ station, enteredAt, leftAt });
  const cells = {
    A: { station: null, visits: [v("verify", 10, 20), v("review", 30, 40), v("verify", 50, 60)] },
    B: { station: "verify", visits: [v("verify", 70, null)] },
  };
  assert.equal(words.stationAcrossWords(cells, "verify").word, "At work in 1 cell now");
  assert.equal(words.stationAcrossWords({ A: cells.A }, "verify").word, "Visited 2 times across 1 cell");
  assert.equal(words.stationAcrossWords(cells, "merge").word, "Not visited");
  const across = words.stationAcrossWords({ A: cells.A }, "verify");
  assert.deepEqual(timing.stationAcrossTiming(across.working, across.last), { phase: "finished", since: 60, sinceWord: "Latest visit ended at" });
  const busy = words.stationAcrossWords(cells, "verify");
  assert.deepEqual(timing.stationAcrossTiming(busy.working, busy.last), { phase: "running", since: 70, sinceWord: "Latest visit began at" });
});

// ---------------------------------------------------------------- I-45: the artifact section's wording

test("I-45: the artifact section says it shows recorded facts and that opening content waits for the Evidence Theater", () => {
  const anat = src("shell/inspector/anatomies.tsx");
  assert.match(anat, /export const ARTIFACT_CONTENT_NOTE = "These are the artifact's recorded facts\. Its content is not opened here: opening it waits for the Evidence Theater, a later milestone\."/);
  const artifact = anat.slice(anat.indexOf("export function ArtifactAnatomy"), anat.indexOf("export function GateAnatomy"));
  assert.match(artifact, /\{ARTIFACT_CONTENT_NOTE\}/);
  assert.doesNotMatch(artifact, /artifactContent/, "no content is read");
  assert.match(src("timeline/inspector/InTimeSection.tsx"), /Recorded facts only; opening an artifact's content waits for the Evidence Theater\./);
});

test("I-03 (for states): a trend column whose period holds a suspect day is marked; a later day under a playhead is not named", () => {
  const from = Date.UTC(2026, 10, 1);
  const days = Array.from({ length: 4 }, (_, i) => ({ from: from + i * DAY, to: from + (i + 1) * DAY }));
  assert.deepEqual(charts.suspectColumns(days, ["2026-11-02", "2026-11-04"]), [false, true, false, true]);
  assert.deepEqual(charts.suspectColumns(days, ["2026-11-02", "2026-11-04"], from + 2 * DAY), [false, true, false, false]);
  assert.deepEqual(charts.suspectColumns([{ from, to: from + 7 * DAY }], ["2026-11-05"]), [true], "a week holding the day");
  assert.deepEqual(charts.suspectColumns([{}], ["2026-11-02"]), [false]);
  assert.match(src("analytics/ui/charts/index.tsx"), /HISTORY_SUSPECT_WORDS/);
});

// ---------------------------------------------------------------- D8: recorded cost and what it leaves out

test("D8: cost exclusions are said in the observer's words; a failed execution's own cost is beside the figure, never in it", async () => {
  const C = await import("../src/analytics/model/costCoverage.ts");
  const excluded = [
    { reason: "failed: the Factory's record of a failed execution carries no cost", count: 2 },
    { reason: "no result yet, or outcome unknown", count: 1 },
  ];
  const without = { covered: 9, of: 12, share: 0.75, excluded };
  assert.equal(C.costExclusionWords(without), "2 failed: the Factory's record of a failed execution carries no cost; 1 no result yet, or outcome unknown");
  assert.equal(C.failedResultCost(without), null, "no extra field: nothing beside the figure");
  const withOther = { ...without, other: [{ reason: "cost recorded by failed executions in their own results", count: 3.45, unit: "USD" }] };
  const f = C.failedResultCost(withOther);
  assert.deepEqual(f, { usd: 3.45, executions: 2 });
  assert.equal(C.failedResultCostWords(f), "Not in this figure: $3.45 recorded by 2 failed executions in their own results.");
  // A non-dollar `other` (K2's execution-model pairs) is not a cost.
  assert.equal(C.failedResultCost({ excluded, other: [{ reason: "the model's usage carries no cost", count: 4, unit: "execution-model pairs" }] }), null);
  assert.equal(C.costExclusionWords({ covered: 5, of: 5, excluded: [] }), null);
  assert.match(C.costExclusionWords({ covered: 3, of: 5 }), /^2 executions without a recorded cost; the reply does not say why$/);
  const eco = src("analytics/ui/areas/Economics.tsx");
  assert.doesNotMatch(eco, /a run without a result reports none/);
  assert.match(eco, /data-cost-coverage/);
  assert.match(eco, /per ticket covers \$\{coverageText\(t\.K4\.coverage\)\}/);
  // Never added into the figures.
  assert.doesNotMatch(eco, /failedCost\.usd\s*\+|\+\s*failedCost/);
});

test("Pulse under a playhead with no whole day: no bare dash, the step's own null reason, no '– recorded'", () => {
  const pulse = src("analytics/ui/areas/Pulse.tsx");
  assert.doesNotMatch(pulse, /dayText\(s\.runs\[0\]\.closed_at\.ms\) : "–"/);
  assert.match(pulse, /st\.row\?\.null_reason \?/);
  assert.match(pulse, /t\.K1\?\.numerator_value === null \|\| t\.K1\?\.numerator_value === undefined \? \(t\.K1\?\.null_reason/);
});

test("D8: the failed executions' own cost comes from the view's executions list: none, two with costs, a truncated list", async () => {
  const C = await import("../src/analytics/model/costCoverage.ts");
  const x = (state, cost, started = 100) => ({ state, started_ms: started, usage: { cost_usd: cost } });
  assert.equal(C.failedCostOf([x("completed", 1.2), x("completed", 0.4)], false), null, "no failed execution: no line");
  assert.equal(C.failedCostOf([x("failed", null)], false), null, "a failed execution without a recorded cost: no line");
  const two = C.failedCostOf([x("failed", 1.2), x("completed", 9), x("failed", 2.25)], false);
  assert.deepEqual(two, { kind: "sum", usd: 3.45, executions: 2 });
  assert.equal(C.failedCostWords(two), "Not in this figure: $3.45 recorded by 2 failed executions in their own results.");
  const cut = C.failedCostOf([x("failed", 1.2), x("failed", 2.25)], true);
  assert.deepEqual(cut, { kind: "some" });
  assert.match(C.failedCostWords(cut), /^Not in this figure: some failed executions recorded a cost in their own results/);
  assert.doesNotMatch(C.failedCostWords(cut), /\$\d/);
  assert.deepEqual(C.failedCostOf([x("failed", 1, 50), x("failed", 2, 500)], false, 100), { kind: "sum", usd: 1, executions: 1 }, "under a day cut, as the figure");
  const ws = src("analytics/Workspace.tsx");
  assert.match(ws, /session\s*\.get\(\)\s*\.then\(\(x\) => x\.executions\(/, "read at the view's cursor");
  assert.doesNotMatch(src("analytics/ui/areas/Economics.tsx"), /\+\s*(?:listed|carried|failed)/);
});

test("I-12: Flow says the visit it was opened from even when the view counts no measured visits, and why", () => {
  const flow = src("analytics/ui/areas/Flow.tsx");
  assert.match(flow, /\{cameFrom \? <CameFrom visit=\{cameFrom\} group=\{groupOf\(c1, cameFrom\.station\)\} why=/);
  assert.match(flow, /This view counts no measured \$\{STATION_WORDS\[visit\.station\]\.toLowerCase\(\)\} visits to compare it with/);
});

test("D4: with no whole UTC day before the playhead, no area shows 'Nothing has been recorded yet'", () => {
  for (const a of ["Compare", "Economics", "Flow", "Reliability", "Pulse", "Quality"]) {
    assert.match(src(`analytics/ui/areas/${a}.tsx`), /density === "empty" && !s\.no_whole_day/, a);
  }
});

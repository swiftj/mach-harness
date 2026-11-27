// M6.6 Phase 2 (I-02, I-03, I-31): Analytics says the same source and link state as the other
// workspaces, shows incomplete history where the figures are, and labels the simulated history so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";
import { said } from "./_moments.mjs";

const { sourceLabel } = await import("../src/scene/store.ts");
const H = await import("../src/analytics/wire/history.ts");
const Q = await import("../src/analytics/wire/query.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const nov = (d, h = 0, m = 0, s = 0) => Date.UTC(2026, 10, d, h, m, s);

// ---------------------------------------------------------------- I-02 source and link state

test("I-02: Analytics' source line is the store's sourceLabel, with the link's state in the badge's words", () => {
  const label = (source, connection) => sourceLabel({ source, connection });
  assert.equal(label("live", { state: "live" }), "Live Factory");
  assert.equal(label("live", { state: "stale" }), "Live Factory (stale)");
  assert.equal(label("live", { state: "reconnecting" }), "Live Factory (reconnecting)");
  assert.equal(label("live", { state: "disconnected" }), "Live Factory (disconnected)");
  assert.equal(label("live", { state: "no-session" }), "Live Factory (no session)");
  assert.equal(label("simulation", null), "Simulation");
  const ws = src("analytics/Workspace.tsx");
  assert.match(ws, /const liveLabel = useSceneStore\(sourceLabelOf\)/);
  assert.match(ws, /const sourceLabel = area === "simulation" \? sourceWords\(area\) : liveLabel/, "the header reads the store's label; Simulated stays the fixture's");
  assert.match(ws, /<StageNotice at="bottom" \/>/, "the floor's notice component, not a second one");
});

// ---------------------------------------------------------------- I-03 incomplete history

test("I-03: incomplete history is said in the words for a gap, with suspect days", () => {
  assert.equal(H.historyWords({ partial: null, gaps: [], suspect_days: [] }), null, "complete: nothing said");
  const h = { partial: "evicted", gaps: [{ class: "not-received", at_ms: nov(3, 9, 29, 13), count: 4 }, { class: "conflict", at_ms: nov(2, 8), count: 1 }, { class: "evicted", at_ms: nov(6, 1), count: 2 }], suspect_days: ["2026-11-03", "2026-11-06"] };
  const w = H.historyWords(h);
  assert.equal(w.title, "Incomplete history.");
  assert.match(w.body, /^History is missing here: /);
  assert.ok(w.body.includes(`not received (4 records) at ${said(nov(3, 9, 29, 13))}`), "the moment, as the person's zone says it");
  assert.match(w.body, /History was repaired or kept apart: a conflicting copy, the first kept \(1 record\)/);
  assert.match(w.body, /Figures for 3 Nov, 6 Nov \(UTC\) may count less than happened/);
  assert.match(w.body, /Nothing is filled in/);
  assert.deepEqual(w.days, [nov(3), nov(6)]);
  assert.match(H.historyWords({ partial: "evicted", gaps: [], suspect_days: [] }).body, /The observer's history is partial \(no longer held by the observer\)/);
  // Where the figures are: one line over the area, and a mark beside a suspect figure.
  const kit = src("analytics/ui/kit.tsx");
  assert.match(kit, /snapshot\?\.history \? <HistoryLine history=\{snapshot\.history\} \/> : null/);
  assert.match(kit, /row\.suspect && h\.text !== null && !missing \? \([\s\S]*history incomplete here/);
  assert.match(src("analytics/wire/load.ts"), /history: SnapshotHistory = \{ partial: t\.history\.partial, gaps: t\.history\.gaps, suspect_days: t\.suspect_days \}/);
});

// ---------------------------------------------------------------- I-31 the simulated history

test("I-31: the simulated history's caption says it is simulated and may run past the moment the Atlas shows", () => {
  assert.match(Q.asOfWords({ area: "simulation", window: "all" }), /^The whole simulated history; these figures may run past the moment the Atlas shows$/);
  assert.equal(Q.asOfWords({ area: "simulation", window: "7d" }), "A selected window of the simulated history");
  assert.equal(Q.asOfWords({ area: "live", window: "all" }), "The complete recorded history");
});

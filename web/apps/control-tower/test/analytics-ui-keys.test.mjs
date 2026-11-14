// M6.5 Factory Analytics: a key pressed on a chart mark stays in the chart (src/analytics/ui/keys.ts).
// Space on a mark without an action used to reach the Control Tower's play/pause key.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { chartKey, CHART_KEYS } = await import("../src/analytics/ui/keys.ts");

test("Space and Enter on a mark without an action are stopped at the chart and do nothing", () => {
  for (const key of [" ", "Enter", "Spacebar"]) assert.deepEqual(chartKey(key, false), { stop: true, prevent: true, activate: false }, key);
});

test("Space and Enter on a mark with an action run it, and are stopped at the chart", () => {
  for (const key of [" ", "Enter"]) assert.deepEqual(chartKey(key, true), { stop: true, prevent: true, activate: true }, key);
});

test("the arrows, Home, End, Page keys and Escape never leak to the shell", () => {
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Escape"]) {
    const o = chartKey(key, false);
    assert.equal(o.stop, true, key);
    assert.equal(o.activate, false, key);
  }
});

test("other keys and chords pass through untouched", () => {
  for (const key of ["Tab", "a", "?", "1", "F6"]) assert.deepEqual(chartKey(key, true), { stop: false, prevent: false, activate: false }, key);
  assert.equal(chartKey(" ", true, { meta: true }).stop, false);
  assert.equal(chartKey("ArrowLeft", false, { alt: true }).stop, false);
  assert.ok(!CHART_KEYS.has("Tab"));
});

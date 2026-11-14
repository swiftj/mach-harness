// M6.5 Factory Analytics accessibility (src/analytics/ui/charts/a11y.ts and the chart kit): words a
// screen reader reads well, the token-kind ramp's contrast in both themes (WCAG 1.4.11, numerically),
// the stylesheet carrying exactly the validated ramp, and the keyboard model between marks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const A = await import("../src/analytics/ui/charts/a11y.ts");
const Se = await import("../src/analytics/model/series.ts");
const css = readFileSync(new URL("../src/analytics/ui/analytics.css", import.meta.url), "utf8");
const kit = readFileSync(new URL("../src/analytics/ui/kit.tsx", import.meta.url), "utf8");
const charts = readFileSync(new URL("../src/analytics/ui/charts/index.tsx", import.meta.url), "utf8");

test("contrast arithmetic matches WCAG's reference values", () => {
  assert.equal(Math.round(A.contrast("#000000", "#FFFFFF") * 100) / 100, 21);
  assert.equal(A.contrast("#777777", "#777777"), 1);
  // #767676 on white is the classic 4.54:1.
  assert.equal(Math.round(A.contrast("#767676", "#FFFFFF") * 100) / 100, 4.54);
});

// The grounds charts are drawn on, from the design tokens, and the ramp from the stylesheet.
const tokens = readFileSync(new URL("../../../packages/ui/src/styles/tokens.css", import.meta.url), "utf8");
const hexOf = (block, name) => (block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) ?? [])[1];
const blockAt = (text, sel) => text.slice(text.indexOf(sel), text.indexOf("}", text.indexOf(sel)));
const GROUNDS = {
  light: [hexOf(tokens, "mach-canvas"), hexOf(tokens, "mach-surface")],
  dark: [hexOf(blockAt(tokens, ':root[data-theme="dark"]'), "mach-canvas"), hexOf(blockAt(tokens, ':root[data-theme="dark"]'), "mach-surface")],
};
const ramp = (block) => [1, 2, 3, 4].map((i) => hexOf(block, `an-seq-${i}`));
const RAMP = { light: ramp(blockAt(css, ".an-root {")), dark: ramp(blockAt(css, ':root[data-theme="dark"] .an-root')) };

test("the grounds and the ramp are read from the tokens and the stylesheet", () => {
  for (const t of ["light", "dark"]) {
    assert.equal(GROUNDS[t].filter(Boolean).length, 2, `${t} grounds`);
    assert.equal(RAMP[t].filter(Boolean).length, 4, `${t} ramp`);
  }
  assert.notDeepEqual(GROUNDS.light, GROUNDS.dark);
});

test("every token-kind step reaches 3:1 against both grounds in its theme (WCAG 1.4.11)", () => {
  for (const t of ["light", "dark"])
    for (const g of GROUNDS[t])
      for (const c of RAMP[t]) assert.ok(A.contrast(c, g) >= 3, `${t} ${c} on ${g}: ${A.contrast(c, g).toFixed(2)}`);
});

test("the ramp stays monotonic in lightness: light theme darkens along the kinds, dark theme lightens", () => {
  const L = (t) => RAMP[t].map(A.luminance);
  for (let i = 1; i < 4; i++) {
    assert.ok(L("light")[i] < L("light")[i - 1]);
    assert.ok(L("dark")[i] > L("dark")[i - 1]);
  }
});

test("a dark system preference without a chosen theme gets the dark ramp too", () => {
  const sys = blockAt(css, '@media (prefers-color-scheme: dark)');
  assert.ok(sys.length > 0, "the stylesheet has a prefers-color-scheme: dark block");
  const after = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  assert.deepEqual(ramp(blockAt(after, ":root:not([data-theme=\"light\"]) .an-root")), RAMP.dark);
});

test("spoken: durations, shares, magnitudes and missing values read as words", () => {
  assert.equal(A.spoken("median 1 h 48 min"), "median 1 hour 48 minutes");
  assert.equal(A.spoken("2 d 1 h"), "2 days 1 hour");
  assert.equal(A.spoken("1 min 5 s, 300 ms"), "1 minute 5 seconds, 300 milliseconds");
  assert.equal(A.spoken("share 67%"), "share 67 percent");
  assert.equal(A.spoken("8.55 M tokens, 34.2 k"), "8.55 million tokens, 34.2 thousand");
  assert.equal(A.spoken("cost < $0.01"), "cost less than $0.01");
  assert.equal(A.spoken("median –"), "median no value");
  // Words that merely contain the letters are untouched; ranges keep their dash.
  assert.equal(A.spoken("Groom 2 Oct – 9 Oct"), "Groom 2 Oct – 9 Oct");
  assert.equal(A.spoken("Week to 9 Oct. passed 10"), "Week to 9 Oct. passed 10");
});

test("spokenShare: percent with its count, and no number over nothing", () => {
  assert.equal(A.spokenShare(53, 79), "67 percent, 53 of 79");
  assert.equal(A.spokenShare(0, 0), "no share: nothing to divide by");
});

test("marks: arrows move, Home and End jump, other keys are left alone (Escape leaves the chart)", () => {
  assert.equal(Se.nextMark(3, "ArrowRight", 10), 4);
  assert.equal(Se.nextMark(0, "ArrowLeft", 10), 0);
  assert.equal(Se.nextMark(4, "Home", 10), 0);
  assert.equal(Se.nextMark(4, "End", 10), 9);
  assert.equal(Se.nextMark(4, "Escape", 10), null);
  assert.equal(Se.nextMark(4, "Tab", 10), null);
});

test("kit: marks speak through spoken(), keep visible text out of their names' way, and Escape leaves", () => {
  assert.match(kit, /aria-label=\{spoken\(label\)\}/);
  assert.match(kit, /e\.key === "Escape"/);
  // No aria-pressed on a row or a mark that is not a button.
  assert.doesNotMatch(kit + charts, /<tr[^>]*aria-pressed/);
  // A scrolling table region can take focus.
  assert.match(kit, /role="region"[^>]*tabIndex=\{0\}/);
});

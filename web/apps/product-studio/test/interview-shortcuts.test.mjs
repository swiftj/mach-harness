// Unit tests for the one rule the question card and the summary to confirm share for their one-key
// shortcuts (src/features/interview/shortcuts.ts). Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutKey } from "../src/features/interview/shortcuts.ts";

/** A key press as React hands it over, on a target inside (or outside) a text box. */
function press(key, { inText = false, ...modifiers } = {}) {
  const target = { closest: (selector) => (inText && selector === "textarea, input" ? {} : null) };
  return { key, target, metaKey: false, ctrlKey: false, altKey: false, ...modifiers };
}

test("a plain letter is the shortcut, whatever its case", () => {
  assert.equal(shortcutKey(press("y")), "y");
  assert.equal(shortcutKey(press("Y")), "y");
  assert.equal(shortcutKey(press("n")), "n");
});

test("typing in a text box or any input is never a shortcut", () => {
  assert.equal(shortcutKey(press("y", { inText: true })), null);
});

test("with a modifier held it is not a shortcut", () => {
  assert.equal(shortcutKey(press("y", { metaKey: true })), null);
  assert.equal(shortcutKey(press("y", { ctrlKey: true })), null);
  assert.equal(shortcutKey(press("y", { altKey: true })), null);
});

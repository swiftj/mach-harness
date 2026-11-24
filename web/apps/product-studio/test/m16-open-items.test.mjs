// The open items of the M16 layout that were closed afterwards (docs/mach-next/M16_LAYOUT.md, 2.3, 2.7 and 6). Reads
// the sources; how the screens look is checked by a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
/** The source between the first `from` and the next `to` after it. */
const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.ok(a >= 0, `missing: ${from}`);
  const b = text.indexOf(to, a + from.length);
  return text.slice(a, b < 0 ? undefined : b);
};

test("a pane's \"More below\" mark has its own line under the scrolling box, so it covers no line of the pane", () => {
  const screen = src("shared/layout/WorkScreen.tsx");
  const pane = between(screen, "export function WorkPane(", "\nfunction MoreBelow(");
  // The mark follows the scrolling box (</Tag>), inside the pane's frame, not inside the box.
  assert.match(pane, /<\/Tag>\s*\{scrolls \? <MoreBelow /);
  const mark = between(screen, "function MoreBelow(", "\n}\n");
  assert.doesNotMatch(mark, /sticky|absolute|h-0/, "the mark does not hang over the pane's content");
  assert.match(mark, /aria-hidden="true"/);
  assert.match(mark, /More below/);
});

test("Vision and outcomes keeps Save changes in the context row, tied to its form", () => {
  const page = src("features/vision/VisionScreen.tsx");
  const acts = between(page, "<ContextActs>", "</ContextActs>");
  assert.match(acts, /type="submit" form="vision-section-vision"/);
  assert.match(acts, /Save changes/);
  assert.match(acts, /Discard changes/);
  assert.match(page, /<form id="vision-section-vision"/);
});

test("on a slice's From the PRD page, the hint names the act in the context row by its own words", () => {
  const page = src("features/prd/SlicePrdScreen.tsx");
  assert.doesNotMatch(page, /These are accepted as a group, with the button at the top of the page/);
  assert.match(page, /actLabel=\{confirmLabel\(acceptN, discussN\)\}/);
  assert.match(page, /accepted together with “\{actLabel\}”/);
});

test("the ready to build dialog has a short description of its own and keeps MACH's note in its body", () => {
  const acts = src("features/spec/SliceActs.tsx");
  const done = between(acts, "title={`${id} is ready to build`}", "</DialogContent>");
  assert.doesNotMatch(done, /description=\{saved\.note\}/);
  assert.match(done, /description=\{saved\.saved_to === "github" \?/);
  assert.match(done, /\{saved\.note\}/);
});

test("in fixture mode the board's row for the idea in view comes from the same run as the page", () => {
  const shape = src("dev/shapeTransport.ts");
  assert.match(shape, /export function alignIdeaBoard/);
  assert.match(shape, /case "idea\.list": \{[\s\S]*alignIdeaBoard\(json\.data\)/);
  assert.match(src("dev/fixtureTransport.ts"), /op === "status" \? alignStatusIdeas\(/);
});

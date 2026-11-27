// The Line's small secondary words (station subtitles, the words under a ticket's marker, a row's epic
// and "title not recorded") are text, so they must reach 4.5:1 on the grounds they sit on, in both
// themes. `factory-ink-soft` is a stroke role (registered at 3:1) and measures 4.42:1 as text on a plate
// top in light theme, so the Line sets that text in `ink-muted`; glyph strokes keep `factory-ink-soft`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import "./_load.mjs";

const { themes, contrastPairs } = await import("../../../packages/ui/src/tokens/tokens.ts");
const { contrast } = await import("../src/analytics/ui/charts/a11y.ts");

const lineDir = new URL("../src/line/", import.meta.url);
const sources = readdirSync(lineDir)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ file: f, text: readFileSync(new URL(f, lineDir), "utf8") }));
const board = readFileSync(new URL("../src/line/Board.tsx", import.meta.url), "utf8");

/** The grounds the Line's text is drawn on: the board's ground, a station's plate, a selected row. */
const GROUNDS = ["factory-ground", "factory-plate-top", "surface"];

test("factory-ink-soft is not a text colour: it fails 4.5:1 on a plate top in light theme", () => {
  const r = contrast(themes.light["factory-ink-soft"], themes.light["factory-plate-top"]);
  assert.ok(r < 4.5, `measured ${r.toFixed(2)}`);
});

test("ink-muted passes as text on every ground the Line draws text on, in both themes", () => {
  for (const theme of ["light", "dark"])
    for (const bg of GROUNDS) {
      const r = contrast(themes[theme]["ink-muted"], themes[theme][bg]);
      assert.ok(r >= 4.5, `${theme}: ink-muted on ${bg} is ${r.toFixed(2)}`);
    }
});

test("each of those text pairs is registered with the token script at 4.5:1 (so `pnpm contrast` checks it)", () => {
  for (const bg of GROUNDS) assert.ok(contrastPairs.some((p) => p.fg === "ink-muted" && p.bg === bg && p.min === 4.5), `ink-muted on ${bg}`);
});

test("the Line sets no text in factory-ink-soft", () => {
  for (const { file, text } of sources) assert.ok(!/\btext-factory-ink-soft\b/.test(text), `${file} sets text in factory-ink-soft`);
});

test("the station subtitles and the words under a marker are ink-muted", () => {
  assert.match(board, /className="w-full truncate text-caption text-ink-muted">\{models \?\? station\.worker\}/);
  assert.match(board, /className="w-full truncate text-caption text-ink-muted">\{stat\?\.typicalMs/);
  assert.match(board, /text-\[12px\] text-ink-muted" data-under=\{row\.state\}>\s*\{under\}/);
});

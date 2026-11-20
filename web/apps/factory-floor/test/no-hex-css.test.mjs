// No hex colours in the app's stylesheets, the same rule the workspace's lint applies to script literals
// (eslint.config.js, "no-restricted-syntax": "Use a design token ..."). ESLint does not read CSS, so this
// test is that rule for every .css file under src/: colours come from the design tokens (--mach-*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));

/** Every .css file under a folder, recursively. */
function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(path);
    return e.isFile() && e.name.endsWith(".css") ? [path] : [];
  });
}

/** The hex colours in a stylesheet's declarations (comments ignored), with their line numbers. */
function hexColours(css) {
  const found = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const declaration = /[-\w]+\s*:\s*([^;{}]+)/g;
  for (let m; (m = declaration.exec(text)); ) {
    const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
    for (let h; (h = hex.exec(m[1])); ) {
      const line = text.slice(0, m.index + m[0].indexOf(m[1]) + h.index).split("\n").length;
      found.push({ hex: h[0], line });
    }
  }
  return found;
}

test("the check finds hex colours in declarations, and only there", () => {
  assert.deepEqual(hexColours(".a {\n  color: #5a86b6;\n  --x: #fff;\n}").map((f) => f.hex), ["#5a86b6", "#fff"]);
  assert.deepEqual(hexColours(".a { border: 1px solid #12345678; }").map((f) => f.hex), ["#12345678"]);
  assert.deepEqual(hexColours("/* was #5a86b6 */ .a { color: var(--mach-ink); }"), [], "comments are ignored");
  assert.deepEqual(hexColours(".a { color: var(--mach-ink); background: color-mix(in srgb, var(--x) 50%, transparent); }"), []);
});

test("no stylesheet in the app holds a hex colour: use a design token (var(--mach-…))", () => {
  const files = cssFiles(src);
  assert.ok(files.length > 0, "the app has stylesheets to check");
  const problems = files.flatMap((file) => hexColours(readFileSync(file, "utf8")).map((f) => `${file.slice(src.length)}:${f.line} ${f.hex}`));
  assert.deepEqual(problems, []);
});

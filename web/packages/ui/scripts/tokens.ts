// Generates src/styles/tokens.css from src/tokens/tokens.ts and checks WCAG contrast.
//
//   node scripts/tokens.ts --write    regenerate the CSS
//   node scripts/tokens.ts --check    fail if the CSS is stale or any contrast pair fails (CI, typecheck)
//   node scripts/tokens.ts --report   print the contrast table as Markdown (for DESIGN_SYSTEM.md)
//
// Runs on Node >= 22.18 with built-in type stripping; no build step.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  contrastPairs,
  elevation,
  fonts,
  layout,
  motion,
  radius,
  roleNames,
  themes,
  typeScale,
  type Theme,
  type ThemeName,
} from "../src/tokens/tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "../src/styles/tokens.css");

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function roleBlock(theme: Theme, indent: string): string {
  return roleNames.map((role) => `${indent}--mach-${role}: ${theme[role]};`).join("\n");
}

function shadowBlock(name: ThemeName, indent: string): string {
  return Object.entries(elevation[name])
    .map(([level, value]) => `${indent}--mach-shadow-${level}: ${value};`)
    .join("\n");
}

function render(): string {
  const scale = Object.entries(typeScale)
    .map(
      ([step, t]) =>
        `  --mach-text-${step}: ${t.size};\n  --mach-text-${step}--line: ${t.line};\n  --mach-text-${step}--weight: ${t.weight};\n  --mach-text-${step}--tracking: ${t.tracking};`,
    )
    .join("\n");
  const radii = Object.entries(radius)
    .map(([name, value]) => `  --mach-radius-${name}: ${value};`)
    .join("\n");
  const durations = Object.entries(motion.duration)
    .map(([name, value]) => `  --mach-duration-${name}: ${value}ms;`)
    .join("\n");
  const easings = Object.entries(motion.easing)
    .map(([name, v]) => `  --mach-ease-${name}: cubic-bezier(${v.join(", ")});`)
    .join("\n");

  return `/* GENERATED from src/tokens/tokens.ts by scripts/tokens.ts. Do not edit by hand. */

:root {
  color-scheme: light;
${roleBlock(themes.light, "  ")}
${shadowBlock("light", "  ")}

  --mach-font-sans: ${fonts.sans};
  --mach-font-mono: ${fonts.mono};
  --mach-font-display: var(--mach-font-sans);
  --mach-density: 1;

${scale}

${radii}

${durations}
${easings}

  --mach-rail-expanded: ${layout.railExpanded}px;
  --mach-rail-collapsed: ${layout.railCollapsed}px;
  --mach-top-bar: ${layout.topBar}px;
  --mach-reading-measure: ${layout.readingMeasure};
  --mach-content-max: ${layout.contentMax}px;
  --mach-control-sm: ${layout.control.sm}px;
  --mach-control-md: ${layout.control.md}px;
  --mach-control-lg: ${layout.control.lg}px;
}

/* Dark before JavaScript has run, when the system asks for it and nothing chose light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${roleBlock(themes.dark, "    ")}
${shadowBlock("dark", "    ")}
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
${roleBlock(themes.dark, "  ")}
${shadowBlock("dark", "  ")}
}

/* Control Tower: same roles and faces, denser controls. */
:root[data-product="control-tower"] {
  --mach-density: 0.875;
}

/* Reduced motion: every duration collapses. Components also check the media query in JavaScript. */
@media (prefers-reduced-motion: reduce) {
  :root {
${Object.keys(motion.duration)
  .map((name) => `    --mach-duration-${name}: 0ms;`)
  .join("\n")}
  }
}
`;
}

type Row = { theme: ThemeName; fg: string; bg: string; fgHex: string; bgHex: string; ratio: number; min: number; use: string };

function rows(): Row[] {
  const out: Row[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const pair of contrastPairs) {
      const fgHex = themes[theme][pair.fg];
      const bgHex = themes[theme][pair.bg];
      out.push({ theme, fg: pair.fg, bg: pair.bg, fgHex, bgHex, ratio: contrast(fgHex, bgHex), min: pair.min, use: pair.use });
    }
  }
  return out;
}

const mode = process.argv[2] ?? "--check";
const css = render();

if (mode === "--write") {
  writeFileSync(cssPath, css);
  console.log(`wrote ${cssPath}`);
}

const failures = rows().filter((r) => r.ratio < r.min);

if (mode === "--report") {
  console.log("| Theme | Foreground | Background | Ratio | Needs | Used for |");
  console.log("|-------|------------|------------|-------|-------|----------|");
  for (const r of rows()) {
    console.log(
      `| ${r.theme} | \`${r.fg}\` ${r.fgHex} | \`${r.bg}\` ${r.bgHex} | ${r.ratio.toFixed(2)} | ${r.min} | ${r.use} |`,
    );
  }
}

if (mode === "--check") {
  let current = "";
  try {
    current = readFileSync(cssPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== css) {
    console.error("tokens.css is stale: run `node packages/ui/scripts/tokens.ts --write`.");
    process.exit(1);
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`contrast ${f.theme}: ${f.fg} on ${f.bg} is ${f.ratio.toFixed(2)}, needs ${f.min}`);
  }
  process.exit(1);
}
if (mode === "--check") console.log(`tokens.css is current; ${rows().length} contrast pairs pass WCAG AA.`);
